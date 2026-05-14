#!/usr/bin/env node

const { execSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

// --- CONFIGURATION ---
const PAN_FORWARD = 648000;
const PAN_BACKWARD = 0;
const V4L2_TIMEOUT_MS = 3000;
const CLICK_DEBOUNCE_MS = 150;
const MOUSE_SCAN_DIRS = ["/dev/input/by-id", "/dev/input/by-path"];

// Linux input_event struct (24 bytes on 64-bit):
//   tv_sec  (8 bytes, u64)
//   tv_usec (8 bytes, u64)
//   type    (2 bytes, u16)
//   code    (2 bytes, u16)
//   value   (4 bytes, s32)
const INPUT_EVENT_SIZE = 24;
const EV_KEY = 1;
const BTN_LEFT = 272;
const BTN_RIGHT = 273;
const KEY_DOWN = 1;

// --- STATE ---
let cameraDevice = null;
let mouseStream = null;
let lastClickTime = { left: 0, right: 0 };
let dirWatchers = [];
const activeChildren = new Set();
let gimbalBusy = false;

// --- CAMERA DETECTION ---

function detectCamera() {
  let listOutput;
  try {
    listOutput = execSync("v4l2-ctl --list-devices", {
      timeout: V4L2_TIMEOUT_MS,
      stdio: "pipe",
    }).toString();
  } catch (err) {
    console.error("Failed to list v4l2 devices:", err.message);
    process.exit(1);
  }

  const blocks = listOutput.split(/\n\s*\n/).filter(Boolean);
  let devicePath = null;

  for (const block of blocks) {
    const lines = block.trim().split("\n");
    if (/OsmoPocket3|DJIPocket3/i.test(lines[0])) {
      const videoLine = lines.find((l) => /\/dev\/video/.test(l));
      if (videoLine) {
        devicePath = videoLine.trim();
        break;
      }
    }
  }

  if (!devicePath) {
    console.error("DJI Pocket 3 not found. Is it connected via USB?");
    process.exit(1);
  }

  let ctrlOutput;
  try {
    ctrlOutput = execSync(`v4l2-ctl -d ${devicePath} --list-ctrls`, {
      timeout: V4L2_TIMEOUT_MS,
      stdio: "pipe",
    }).toString();
  } catch (err) {
    console.error(`Failed to read controls for ${devicePath}:`, err.message);
    process.exit(1);
  }

  if (
    !ctrlOutput.includes("pan_absolute") ||
    !ctrlOutput.includes("tilt_absolute")
  ) {
    console.error(
      `${devicePath} does not expose pan_absolute / tilt_absolute controls.`,
    );
    process.exit(1);
  }

  console.log(`Camera detected: ${devicePath}`);
  return devicePath;
}

// --- GIMBAL CONTROL ---

function spawnV4l2(args, captureStdout = false) {
  return new Promise((resolve, reject) => {
    const child = spawn("v4l2-ctl", ["-d", cameraDevice, ...args], {
      stdio: ["ignore", captureStdout ? "pipe" : "ignore", "ignore"],
    });
    activeChildren.add(child);
    let out = "";
    if (captureStdout) child.stdout.on("data", (d) => (out += d));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("timed out"));
    }, V4L2_TIMEOUT_MS);
    child.on("close", (code) => {
      activeChildren.delete(child);
      clearTimeout(timer);
      code === 0 ? resolve(out) : reject(new Error(`exit ${code}`));
    });
    child.on("error", (err) => {
      activeChildren.delete(child);
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function readPan() {
  const out = await spawnV4l2(["-C", "pan_absolute"], true);
  const match = out.match(/pan_absolute:\s*(-?\d+)/);
  if (!match) throw new Error("could not parse pan_absolute");
  return parseInt(match[1], 10);
}

function closestPreset(pan) {
  const distForward = Math.abs(pan - PAN_FORWARD);
  const distBackward = Math.abs(pan - PAN_BACKWARD);
  return distForward <= distBackward ? PAN_FORWARD : PAN_BACKWARD;
}

// --- CLICK HANDLERS ---

async function onLeftClick() {
  const now = Date.now();
  if (now - lastClickTime.left < CLICK_DEBOUNCE_MS) return;
  if (gimbalBusy) return;
  lastClickTime.left = now;
  gimbalBusy = true;
  try {
    const pan = await readPan();
    const current = closestPreset(pan);
    const target = current === PAN_FORWARD ? PAN_BACKWARD : PAN_FORWARD;
    await spawnV4l2([`--set-ctrl=pan_absolute=${target}`]);
  } catch (err) {
    console.error(`Left click failed: ${err.message}`);
  }
  gimbalBusy = false;
}

async function onRightClick() {
  const now = Date.now();
  if (now - lastClickTime.right < CLICK_DEBOUNCE_MS) return;
  if (gimbalBusy) return;
  lastClickTime.right = now;
  gimbalBusy = true;
  try {
    const pan = await readPan();
    const target = closestPreset(pan);
    await spawnV4l2([`--set-ctrl=pan_absolute=${target}`]);
  } catch (err) {
    console.error(`Right click failed: ${err.message}`);
  }
  gimbalBusy = false;
}

// --- RAW EVDEV READER ---

function parseEvents(buf) {
  for (
    let offset = 0;
    offset + INPUT_EVENT_SIZE <= buf.length;
    offset += INPUT_EVENT_SIZE
  ) {
    const type = buf.readUInt16LE(offset + 16);
    const code = buf.readUInt16LE(offset + 18);
    const value = buf.readInt32LE(offset + 20);

    if (type === EV_KEY && value === KEY_DOWN) {
      if (code === BTN_LEFT) onLeftClick();
      else if (code === BTN_RIGHT) onRightClick();
    }
  }
}

// --- MOUSE DETECTION & HOT-PLUG ---

function findMouseDevice() {
  if (process.env.MOUSE_DEV) {
    console.log(`Using MOUSE_DEV override: ${process.env.MOUSE_DEV}`);
    return process.env.MOUSE_DEV;
  }

  for (const dir of MOUSE_SCAN_DIRS) {
    if (!fs.existsSync(dir)) continue;
    try {
      const mice = fs
        .readdirSync(dir)
        .filter((e) => e.endsWith("-event-mouse"))
        .map((e) => path.join(dir, e));
      if (mice.length > 0) {
        if (mice.length > 1)
          console.log(`Multiple mice found: ${mice.join(", ")} — using first.`);
        return mice[0];
      }
    } catch (_) {}
  }

  return null;
}

function disconnectMouse() {
  if (mouseStream) {
    mouseStream.destroy();
    mouseStream = null;
  }
}

function connectMouse() {
  disconnectMouse();

  const devPath = findMouseDevice();
  if (!devPath) {
    console.log("No mouse found. Waiting for one to be plugged in...");
    return;
  }

  console.log(`Mouse connected: ${devPath}`);

  let buf = Buffer.alloc(0);

  try {
    mouseStream = fs.createReadStream(devPath);

    mouseStream.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const complete =
        Math.floor(buf.length / INPUT_EVENT_SIZE) * INPUT_EVENT_SIZE;
      if (complete > 0) {
        parseEvents(buf.subarray(0, complete));
        buf = buf.subarray(complete);
      }
    });

    mouseStream.on("error", (err) => {
      if (err.code === "EACCES") {
        console.error(
          "Permission denied opening mouse. Add yourself to the 'input' group:\n  sudo usermod -a -G input $USER\nthen log out and back in.",
        );
      } else {
        console.error("Mouse error:", err.message);
      }
      mouseStream = null;
    });

    mouseStream.on("close", () => {
      console.log("Mouse disconnected.");
      mouseStream = null;
    });
  } catch (err) {
    console.error("Failed to open mouse device:", err.message);
    mouseStream = null;
  }
}

function watchForMouse() {
  let reconnectTimer = null;

  for (const dir of MOUSE_SCAN_DIRS) {
    if (!fs.existsSync(dir)) continue;
    try {
      const watcher = fs.watch(dir, (eventType) => {
        if (eventType === "rename" && !mouseStream) {
          clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(connectMouse, 500);
        }
      });
      watcher.on("error", () => {});
      dirWatchers.push(watcher);
    } catch (_) {}
  }
}

// --- SIGNAL HANDLING & DURABILITY ---

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err.message);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
  process.exit(1);
});

function cleanup() {
  for (const child of activeChildren) {
    try { child.kill("SIGKILL"); } catch (_) {}
  }
  disconnectMouse();
  for (const w of dirWatchers) {
    try {
      w.close();
    } catch (_) {}
  }
  process.exit(0);
}

process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);

// --- MAIN ---

cameraDevice = detectCamera();

console.log("--- Camera Controls ---");
console.log("Left click  : toggle FORWARD / BACKWARD");
console.log("Right click : re-center current mode");

connectMouse();
watchForMouse();
