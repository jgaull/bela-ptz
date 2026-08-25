#!/usr/bin/env node

const { execSync, spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const path = require("path");

// --- CONFIGURATION ---
const PAN_FORWARD = 648000;
const PAN_BACKWARD = 0;
const TILT_CENTER = 0;
const V4L2_TIMEOUT_MS = 3000;
const CLICK_DEBOUNCE_MS = 150;
const MOUSE_SCAN_DIRS = ["/dev/input/by-id", "/dev/input/by-path"];

// gstlibuvch264src's control socket. Only exists while belacoder is running
// a uvc pipeline (it owns the camera's USB control interface for the life
// of the stream) - so this is preferred while streaming, with the v4l2
// path below kept as a fallback for when the camera is idle and the
// kernel's uvcvideo driver owns it instead.
const PTZ_SOCKET_PATH = "/tmp/belabox_ptz.sock";
const PTZ_SOCKET_TIMEOUT_MS = 1000;

// Linux input_event struct (24 bytes on 64-bit):
//   tv_sec  (8 bytes, u64)
//   tv_usec (8 bytes, u64)
//   type    (2 bytes, u16)
//   code    (2 bytes, u16)
//   value   (4 bytes, s32)
const INPUT_EVENT_SIZE = 24;
const EV_KEY = 1;
const BTN_RIGHT = 273;
const BTN_MIDDLE = 274;
const KEY_DOWN = 1;

// --- STATE ---
let cameraDevice = null;
let mouseStream = null;
let lastClickTime = { middle: 0, right: 0 };
let dirWatchers = [];
const activeChildren = new Set();
let gimbalBusy = false;

// --- CAMERA DETECTION (v4l2 fallback path, used when idle / not streaming) ---
//
// Non-fatal: while a uvc pipeline is streaming, the kernel doesn't own the
// camera and none of this will resolve - that's expected, and control still
// works via the PTZ_SOCKET_PATH socket in that case. This only matters for
// controlling the camera while it's idle.

function detectCamera() {
  let listOutput;
  try {
    listOutput = execSync("v4l2-ctl --list-devices", {
      timeout: V4L2_TIMEOUT_MS,
      stdio: "pipe",
    }).toString();
  } catch (err) {
    console.log(`v4l2 device list unavailable (${err.message}); PTZ over v4l2 disabled until the camera is idle and kernel-bound.`);
    return null;
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
    console.log("DJI Pocket 3 not v4l2-visible (expected while streaming a uvc pipeline).");
    return null;
  }

  let ctrlOutput;
  try {
    ctrlOutput = execSync(`v4l2-ctl -d ${devicePath} --list-ctrls`, {
      timeout: V4L2_TIMEOUT_MS,
      stdio: "pipe",
    }).toString();
  } catch (err) {
    console.log(`Failed to read controls for ${devicePath}: ${err.message}`);
    return null;
  }

  if (
    !ctrlOutput.includes("pan_absolute") ||
    !ctrlOutput.includes("tilt_absolute")
  ) {
    console.log(`${devicePath} does not expose pan_absolute / tilt_absolute controls.`);
    return null;
  }

  console.log(`Camera detected via v4l2: ${devicePath}`);
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

async function readPanTiltViaV4l2() {
  const panOut = await spawnV4l2(["-C", "pan_absolute"], true);
  const panMatch = panOut.match(/pan_absolute:\s*(-?\d+)/);
  if (!panMatch) throw new Error("could not parse pan_absolute");

  const tiltOut = await spawnV4l2(["-C", "tilt_absolute"], true);
  const tiltMatch = tiltOut.match(/tilt_absolute:\s*(-?\d+)/);
  if (!tiltMatch) throw new Error("could not parse tilt_absolute");

  return { pan: parseInt(panMatch[1], 10), tilt: parseInt(tiltMatch[1], 10) };
}

async function setPanTiltViaV4l2(pan, tilt) {
  await spawnV4l2([`--set-ctrl=pan_absolute=${pan},tilt_absolute=${tilt}`]);
}

// --- PTZ CONTROL SOCKET (preferred; only live while belacoder is streaming) ---

function socketRequest(command) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(PTZ_SOCKET_PATH);
    let data = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("PTZ socket request timed out"));
    }, PTZ_SOCKET_TIMEOUT_MS);

    socket.on("connect", () => socket.write(command + "\n"));
    socket.on("data", (chunk) => (data += chunk));
    socket.on("end", () => {
      clearTimeout(timer);
      const line = data.trim();
      if (line.startsWith("OK")) resolve(line.slice(2).trim());
      else reject(new Error(line || "empty PTZ socket response"));
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function readPanTiltViaSocket() {
  const reply = await socketRequest("GET");
  const match = reply.match(/(-?\d+)\s+(-?\d+)/);
  if (!match) throw new Error(`could not parse PTZ socket GET response: ${reply}`);
  return { pan: parseInt(match[1], 10), tilt: parseInt(match[2], 10) };
}

async function setPanTiltViaSocket(pan, tilt) {
  await socketRequest(`SET ${pan} ${tilt}`);
}

// --- UNIFIED PAN/TILT ACCESS: socket first (streaming), v4l2 fallback (idle) ---

async function readPanTilt() {
  try {
    return await readPanTiltViaSocket();
  } catch (socketErr) {
    if (!cameraDevice) cameraDevice = detectCamera();
    if (!cameraDevice) {
      throw new Error(`camera unavailable (PTZ socket: ${socketErr.message})`);
    }
    return readPanTiltViaV4l2();
  }
}

async function setPanTilt(pan, tilt) {
  try {
    await setPanTiltViaSocket(pan, tilt);
  } catch (socketErr) {
    if (!cameraDevice) cameraDevice = detectCamera();
    if (!cameraDevice) {
      throw new Error(`camera unavailable (PTZ socket: ${socketErr.message})`);
    }
    await setPanTiltViaV4l2(pan, tilt);
  }
}

function closestPreset(pan) {
  const distForward = Math.abs(pan - PAN_FORWARD);
  const distBackward = Math.abs(pan - PAN_BACKWARD);
  return distForward <= distBackward ? PAN_FORWARD : PAN_BACKWARD;
}

// --- CLICK HANDLERS ---

async function onMiddleClick() {
  const now = Date.now();
  if (now - lastClickTime.middle < CLICK_DEBOUNCE_MS) return;
  if (gimbalBusy) return;
  lastClickTime.middle = now;
  gimbalBusy = true;
  try {
    const { pan, tilt } = await readPanTilt();
    const current = closestPreset(pan);
    const target = current === PAN_FORWARD ? PAN_BACKWARD : PAN_FORWARD;
    await setPanTilt(target, tilt);
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
    const { pan } = await readPanTilt();
    const target = closestPreset(pan);
    await setPanTilt(target, TILT_CENTER);
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
      if (code === BTN_MIDDLE) onMiddleClick();
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

function cleanup(signal) {
  console.log(`[cleanup] received ${signal}`);
  for (const child of activeChildren) {
    try { child.kill("SIGKILL"); } catch (_) {}
  }
  process.kill(process.pid, "SIGKILL");
}

process.on("SIGTERM", () => cleanup("SIGTERM"));
process.on("SIGINT",  () => cleanup("SIGINT"));

// --- MAIN ---

cameraDevice = detectCamera();

console.log("--- Camera Controls ---");
console.log("Middle click: toggle FORWARD / BACKWARD");
console.log("Right click : re-center current mode");

connectMouse();
watchForMouse();
