# bela-ptz

https://github.com/user-attachments/assets/50b1da64-a49d-40b6-a282-bc67b819a204

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
journalctl -u bela-ptz -f
```

