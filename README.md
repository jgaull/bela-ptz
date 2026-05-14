# camera-controls

DJI Osmo Pocket 3 PTZ control via USB mouse. Runs as a systemd service on the belabox.

## Controls

| Click       | Action                                |
|-------------|---------------------------------------|
| Left click  | Toggle camera between FORWARD / BACKWARD (180°) |
| Right click | Re-center current mode (pan target + tilt 0) |

Override mouse device: `MOUSE_DEV=/dev/input/eventX node serve.js`

## Install

```bash
npm install
sudo node install.js
```

## Logs

```bash
journalctl -u camera-controls -f
```
