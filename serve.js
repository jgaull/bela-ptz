#!/usr/bin/env node

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const InputEvent = require("input-event");

// --- CONFIGURATION ---
const PAN_FORWARD = 0;
const PAN_BACKWARD = 648000;
const TILT_CENTER = 0;
const V4L2_TIMEOUT_MS = 3000;
const CLICK_DEBOUNCE_MS = 1000;
const MOUSE_SCAN_DIRS = ["/dev/input/by-id", "/dev/input/by-path"];

// --- STATE ---
let isForward = true;
let cameraDevice = null;
let mouseInput = null;
let mouseMouse = null;
let lastClickTime = { left: 0, right: 0 };
let dirWatchers = [];

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

  // Split into blocks separated by blank lines
  const blocks = listOutput.split(/\n\s*\n/).filter(Boolean);
  let devicePath = null;

  for (const block of blocks) {
    const lines = block.trim().split("\n");
    const header = lines[0];
    if (/OsmoPocket3|DJIPocket3/i.test(header)) {
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

  // Validate it supports pan/tilt
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

function targetPan() {
  return isForward ? PAN_FORWARD : PAN_BACKWARD;
}

function moveGimbal(pan) {
  try {
    execSync(
      `v4l2-ctl -d ${cameraDevice} --set-ctrl=pan_absolute=${pan},tilt_absolute=${TILT_CENTER}`,
      { timeout: V4L2_TIMEOUT_MS, stdio: "pipe" },
    );
    console.log(`Gimbal: ${isForward ? "FORWARD" : "BACKWARD"} (pan=${pan})`);
  } catch (err) {
    console.error("Gimbal move failed:", err.message);
  }
}

// --- CLICK HANDLERS ---

function onLeftClick() {
  const now = Date.now();
  if (now - lastClickTime.left < CLICK_DEBOUNCE_MS) return;
  lastClickTime.left = now;

  isForward = !isForward;
  console.log(`Toggle → ${isForward ? "FORWARD" : "BACKWARD"}`);
  moveGimbal(targetPan());
}

function onRightClick() {
  const now = Date.now();
  if (now - lastClickTime.right < CLICK_DEBOUNCE_MS) return;
  lastClickTime.right = now;

  console.log(`Center → ${isForward ? "FORWARD" : "BACKWARD"}`);
  moveGimbal(targetPan());
}

// --- MOUSE DETECTION & HOT-PLUG ---

function findMouseDevices() {
  const env = process.env.MOUSE_DEV;
  if (env) {
    console.log(`Using MOUSE_DEV override: ${env}`);
    return [env];
  }

  for (const dir of MOUSE_SCAN_DIRS) {
    if (!fs.existsSync(dir)) continue;
    try {
      const entries = fs.readdirSync(dir);
      const mice = entries
        .filter((e) => e.endsWith("-event-mouse"))
        .map((e) => path.join(dir, e));
      if (mice.length > 0) {
        if (mice.length > 1) {
          console.log(`Multiple mice found: ${mice.join(", ")} — using first.`);
        }
        return mice;
      }
    } catch (_) {}
  }

  return [];
}

function disconnectMouse() {
  if (mouseInput) {
    try {
      mouseInput.destroy();
    } catch (_) {}
    mouseInput = null;
    mouseMouse = null;
  }
}

function connectMouse() {
  disconnectMouse();

  const devices = findMouseDevices();
  if (devices.length === 0) {
    console.log("No mouse found. Waiting for one to be plugged in...");
    return;
  }

  const devPath = devices[0];
  console.log(`Mouse connected: ${devPath}`);

  try {
    mouseInput = new InputEvent(devPath);
    mouseMouse = new InputEvent.Mouse(mouseInput);

    mouseMouse.on("leftclick", onLeftClick);
    mouseMouse.on("rightclick", onRightClick);

    mouseInput.on("error", (err) => {
      console.error("Mouse error:", err.message);
      mouseInput = null;
      mouseMouse = null;
    });

    mouseInput.on("close", () => {
      console.log("Mouse disconnected.");
      mouseInput = null;
      mouseMouse = null;
    });
  } catch (err) {
    console.error("Failed to open mouse device:", err.message);
    mouseInput = null;
    mouseMouse = null;
  }
}

function watchForMouse() {
  for (const dir of MOUSE_SCAN_DIRS) {
    if (!fs.existsSync(dir)) continue;
    try {
      const watcher = fs.watch(dir, (eventType) => {
        if (eventType === "rename" && !mouseInput) {
          // Small delay to let the kernel finish creating the symlink
          setTimeout(connectMouse, 500);
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
