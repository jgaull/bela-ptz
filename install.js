#!/usr/bin/env node

// install.js — One-time setup for bela-ptz.
// Must be run with: sudo node install.js
//
// Writes /etc/systemd/system/bela-ptz.service and enables it.

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SERVICE_NAME = 'bela-ptz';
const SERVICE_FILE = `/etc/systemd/system/${SERVICE_NAME}.service`;
const SERVE_JS = path.join(__dirname, 'serve.js');

function main() {
  if (process.getuid() !== 0) {
    console.error('Error: This script must be run with sudo.');
    console.error('Usage: sudo node install.js');
    process.exit(1);
  }

  // Resolve the node binary that will run the service
  let nodeBin;
  try {
    nodeBin = execSync('which node', { stdio: 'pipe' }).toString().trim();
  } catch (_) {
    nodeBin = '/usr/bin/node';
  }

  const unit = `[Unit]
Description=Camera Controls (DJI Pocket 3 PTZ via USB mouse)
After=multi-user.target

[Service]
Type=simple
ExecStart=${nodeBin} ${SERVE_JS}
Restart=always
RestartSec=2
User=root
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
`;

  // Write to a temp file and validate before committing
  const tmpFile = path.join(os.tmpdir(), `${SERVICE_NAME}.service`);
  fs.writeFileSync(tmpFile, unit, { mode: 0o644 });

  try {
    execSync(`systemd-analyze verify ${tmpFile}`, { stdio: 'pipe', timeout: 5000 });
  } catch (err) {
    fs.unlinkSync(tmpFile);
    const msg = err.stderr ? err.stderr.toString().trim() : err.message;
    console.error('Error: systemd unit validation failed:', msg);
    process.exit(1);
  }

  fs.renameSync(tmpFile, SERVICE_FILE);
  fs.chmodSync(SERVICE_FILE, 0o644);

  execSync('systemctl daemon-reload', { stdio: 'inherit' });
  execSync(`systemctl enable --now ${SERVICE_NAME}`, { stdio: 'inherit' });

  // Add the invoking user to the video and input groups so manual runs
  // (npm start) work without sudo after a re-login.
  const invoker = process.env.SUDO_USER;
  if (invoker) {
    for (const group of ['video', 'input']) {
      try {
        execSync(`usermod -a -G ${group} ${invoker}`, { stdio: 'pipe' });
        console.log(`Added ${invoker} to group: ${group}`);
      } catch (err) {
        console.warn(`Warning: could not add ${invoker} to ${group} group:`, err.message);
      }
    }
    console.log(`\nNote: log out and back in (or run 'newgrp video') for group changes to take effect.`);
  }

  console.log(`\nService installed at ${SERVICE_FILE}`);
  console.log(`Status:  systemctl status ${SERVICE_NAME}`);
  console.log(`Logs:    journalctl -u ${SERVICE_NAME} -f`);
}

main();
