#!/usr/bin/env node

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// --- CONFIGURATION ---
const PAN_FORWARD = 648000;
const PAN_BACKWARD = 0;
const TILT_CENTER = 0;
const V4L2_TIMEOUT_MS = 3000;
const GIMBAL_COOLDOWN_MS = 5000;
const CLICK_DEBOUNCE_MS = 150;
const MOUSE_SCAN_DIRS = ['/dev/input/by-id', '/dev/input/by-path'];

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
let isForward = true;
let cameraDevice = null;
let mouseStream = null;
let lastClickTime = { left: 0, right: 0 };
let dirWatchers = [];
let activeGimbalChild = null;

// --- CAMERA DETECTION ---

function detectCamera() {
  let listOutput;
  try {
    listOutput = execSync('v4l2-ctl --list-devices', {
      timeout: V4L2_TIMEOUT_MS,
      stdio: 'pipe',
    }).toString();
  } catch (err) {
    console.error('Failed to list v4l2 devices:', err.message);
    process.exit(1);
  }

  const blocks = listOutput.split(/\n\s*\n/).filter(Boolean);
  let devicePath = null;

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (/OsmoPocket3|DJIPocket3/i.test(lines[0])) {
      const videoLine = lines.find(l => /\/dev\/video/.test(l));
      if (videoLine) {
        devicePath = videoLine.trim();
        break;
      }
    }
  }

  if (!devicePath) {
    console.error('DJI Pocket 3 not found. Is it connected via USB?');
    process.exit(1);
  }

  let ctrlOutput;
  try {
    ctrlOutput = execSync(`v4l2-ctl -d ${devicePath} --list-ctrls`, {
      timeout: V4L2_TIMEOUT_MS,
      stdio: 'pipe',
    }).toString();
  } catch (err) {
    console.error(`Failed to read controls for ${devicePath}:`, err.message);
    process.exit(1);
  }

  if (!ctrlOutput.includes('pan_absolute') || !ctrlOutput.includes('tilt_absolute')) {
    console.error(`${devicePath} does not expose pan_absolute / tilt_absolute controls.`);
    process.exit(1);
  }

  console.log(`Camera detected: ${devicePath}`);
  return devicePath;
}

// --- GIMBAL CONTROL ---

function targetPan() {
  return isForward ? PAN_FORWARD : PAN_BACKWARD;
}

function spawnV4l2(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('v4l2-ctl', ['-d', cameraDevice, ...args], { stdio: 'pipe' });
    const timer = setTimeout(() => { child.kill(); reject(new Error('timed out')); }, V4L2_TIMEOUT_MS);
    child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`exit ${code}`)); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

async function moveGimbal(pan) {
  if (activeGimbalChild) {
    console.log('Gimbal busy, ignoring click.');
    return;
  }

  // Use a sentinel so concurrent clicks are blocked during the whole sequence.
  activeGimbalChild = {};

  console.log(`[GIMBAL] tilt → 0 then pan → ${pan}`);
  try {
    await spawnV4l2([`--set-ctrl=tilt_absolute=${TILT_CENTER}`]);
    console.log(`[GIMBAL] tilt done`);
    await spawnV4l2([`--set-ctrl=pan_absolute=${pan}`]);
    console.log(`[GIMBAL] pan done`);
  } catch (err) {
    console.error(`[GIMBAL] failed: ${err.message}`);
  }

  console.log(`[GIMBAL] cooling down ${GIMBAL_COOLDOWN_MS}ms`);
  setTimeout(() => {
    activeGimbalChild = null;
    console.log('[GIMBAL] cooldown done, ready');
  }, GIMBAL_COOLDOWN_MS);
}

// --- CLICK HANDLERS ---

function logCurrentPan(prefix) {
  const child = spawn('v4l2-ctl', ['-d', cameraDevice, '-C', 'pan_absolute,tilt_absolute'], { stdio: 'pipe' });
  let out = '', err = '';
  child.stdout.on('data', d => out += d);
  child.stderr.on('data', d => err += d);
  child.on('close', (code) => {
    if (code === 0) console.log(`${prefix} hw=${out.trim()}`);
    else console.log(`${prefix} hw=read_failed(${err.trim() || 'exit ' + code})`);
  });
}

function onLeftClick() {
  const now = Date.now();
  console.log(`[LEFT]  isForward=${isForward} busy=${!!activeGimbalChild} debounce=${now - lastClickTime.left < CLICK_DEBOUNCE_MS}`);
  logCurrentPan('[LEFT] ');
  if (now - lastClickTime.left < CLICK_DEBOUNCE_MS) return;
  if (activeGimbalChild) return;
  lastClickTime.left = now;
  isForward = !isForward;
  console.log(`[LEFT]  flipped → isForward=${isForward} target_pan=${targetPan()}`);
  moveGimbal(targetPan());
}

function onRightClick() {
  const now = Date.now();
  console.log(`[RIGHT] isForward=${isForward} busy=${!!activeGimbalChild} debounce=${now - lastClickTime.right < CLICK_DEBOUNCE_MS}`);
  logCurrentPan('[RIGHT]');
  if (now - lastClickTime.right < CLICK_DEBOUNCE_MS) return;
  if (activeGimbalChild) return;
  lastClickTime.right = now;
  console.log(`[RIGHT] centering → isForward=${isForward} target_pan=${targetPan()}`);
  moveGimbal(targetPan());
}

// --- RAW EVDEV READER ---

function parseEvents(buf) {
  for (let offset = 0; offset + INPUT_EVENT_SIZE <= buf.length; offset += INPUT_EVENT_SIZE) {
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
      const mice = fs.readdirSync(dir)
        .filter(e => e.endsWith('-event-mouse'))
        .map(e => path.join(dir, e));
      if (mice.length > 0) {
        if (mice.length > 1) console.log(`Multiple mice found: ${mice.join(', ')} — using first.`);
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
    console.log('No mouse found. Waiting for one to be plugged in...');
    return;
  }

  console.log(`Mouse connected: ${devPath}`);

  let buf = Buffer.alloc(0);

  try {
    mouseStream = fs.createReadStream(devPath);

    mouseStream.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const complete = Math.floor(buf.length / INPUT_EVENT_SIZE) * INPUT_EVENT_SIZE;
      if (complete > 0) {
        parseEvents(buf.subarray(0, complete));
        buf = buf.subarray(complete);
      }
    });

    mouseStream.on('error', (err) => {
      if (err.code === 'EACCES') {
        console.error("Permission denied opening mouse. Add yourself to the 'input' group:\n  sudo usermod -a -G input $USER\nthen log out and back in.");
      } else {
        console.error('Mouse error:', err.message);
      }
      mouseStream = null;
    });

    mouseStream.on('close', () => {
      console.log('Mouse disconnected.');
      mouseStream = null;
    });
  } catch (err) {
    console.error('Failed to open mouse device:', err.message);
    mouseStream = null;
  }
}

function watchForMouse() {
  let reconnectTimer = null;

  for (const dir of MOUSE_SCAN_DIRS) {
    if (!fs.existsSync(dir)) continue;
    try {
      const watcher = fs.watch(dir, (eventType) => {
        if (eventType === 'rename' && !mouseStream) {
          clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(connectMouse, 500);
        }
      });
      watcher.on('error', () => {});
      dirWatchers.push(watcher);
    } catch (_) {}
  }
}

// --- SIGNAL HANDLING & DURABILITY ---

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  process.exit(1);
});

function cleanup() {
  if (activeGimbalChild) {
    activeGimbalChild.kill();
    activeGimbalChild = null;
  }
  disconnectMouse();
  for (const w of dirWatchers) {
    try { w.close(); } catch (_) {}
  }
  process.exit(0);
}

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

// --- MAIN ---

cameraDevice = detectCamera();

console.log('--- Camera Controls ---');
console.log('Left click  : toggle FORWARD / BACKWARD');
console.log('Right click : re-center current mode');

connectMouse();
watchForMouse();
