# bela-ptz

DJI Osmo Pocket 3 PTZ control via USB mouse. Runs as a systemd service on the belabox.

## Controls

| Click        | Action                                |
|--------------|---------------------------------------|
| Middle click | Toggle camera between FORWARD / BACKWARD (180°) |
| Right click  | Re-center current mode (pan target + tilt 0) |

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

## Stop / disable

```bash
sudo systemctl stop bela-ptz      # stop the running service
sudo systemctl disable bela-ptz   # don't start on boot
```
