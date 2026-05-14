#!/usr/bin/env node
// Throwaway spike: can we talk UVC to the DJI Pocket 3 while libuvch264src is streaming?
//
// Usage:
//   cd bela-ptz && npm install usb
//   sudo node probe-uvc.js          (run while NO stream is active — baseline)
//   sudo node probe-uvc.js          (run while stream IS active — the real test)
//
// Expected baseline (no stream): prints "pan=N tilt=N".
// Real test (streaming): either prints values (concurrent UVC works) or fails
// with LIBUSB_ERROR_BUSY on claim (means libuvch264src holds the VideoControl
// interface; concurrent PTZ via libusb is impossible without changing belacoder).

const usb = require("usb");

const DJI_VENDOR_ID = 0x2ca3;

// UVC class constants
const UVC_CC_VIDEO = 0x0e;
const UVC_SC_VIDEOCONTROL = 0x01;
const UVC_VC_INPUT_TERMINAL = 0x02;
const UVC_ITT_CAMERA = 0x0201;
const UVC_CT_PAN_TILT_ABSOLUTE_CONTROL = 0x0d;
const UVC_GET_CUR = 0x81;

function findDJI() {
  const devices = usb.getDeviceList();
  for (const d of devices) {
    if (d.deviceDescriptor.idVendor === DJI_VENDOR_ID) return d;
  }
  return null;
}

// Parse the active config descriptor's "extra" bytes to find the VideoControl
// interface number and the Camera Terminal unit ID.
function findVcAndCt(device) {
  for (const iface of device.interfaces) {
    const d = iface.descriptor;
    if (
      d.bInterfaceClass === UVC_CC_VIDEO &&
      d.bInterfaceSubClass === UVC_SC_VIDEOCONTROL
    ) {
      const extra = d.extra; // class-specific VC descriptors live here
      let i = 0;
      let ctUnitId = null;
      while (i < extra.length) {
        const len = extra[i];
        const type = extra[i + 1];
        const subtype = extra[i + 2];
        // Class-specific interface descriptor type = 0x24
        if (type === 0x24 && subtype === UVC_VC_INPUT_TERMINAL) {
          const terminalId = extra[i + 3];
          const terminalType = extra[i + 4] | (extra[i + 5] << 8);
          if (terminalType === UVC_ITT_CAMERA) {
            ctUnitId = terminalId;
            break;
          }
        }
        if (len === 0) break;
        i += len;
      }
      return { ifaceNum: d.bInterfaceNumber, ctUnitId, iface };
    }
  }
  return null;
}

function getPanTilt(device, ifaceNum, ctUnitId) {
  return new Promise((resolve, reject) => {
    device.controlTransfer(
      0xa1, // bmRequestType: device-to-host, class, interface
      UVC_GET_CUR,
      UVC_CT_PAN_TILT_ABSOLUTE_CONTROL << 8,
      (ctUnitId << 8) | ifaceNum,
      8,
      (err, data) => {
        if (err) return reject(err);
        const pan = data.readInt32LE(0);
        const tilt = data.readInt32LE(4);
        resolve({ pan, tilt });
      },
    );
  });
}

(async () => {
  const device = findDJI();
  if (!device) {
    console.error(`No DJI device (vendor 0x${DJI_VENDOR_ID.toString(16)}) found.`);
    process.exit(1);
  }
  console.log(
    `Found DJI device: bus=${device.busNumber} addr=${device.deviceAddress} ` +
      `vid=0x${device.deviceDescriptor.idVendor.toString(16)} ` +
      `pid=0x${device.deviceDescriptor.idProduct.toString(16)}`,
  );

  try {
    device.open();
  } catch (err) {
    console.error("device.open() failed:", err.message);
    process.exit(1);
  }

  const info = findVcAndCt(device);
  if (!info || info.ctUnitId == null) {
    console.error("Could not find VideoControl interface + Camera Terminal.");
    process.exit(1);
  }
  console.log(`VideoControl iface=${info.ifaceNum} CT unit id=${info.ctUnitId}`);

  // Detach kernel driver if present (likely no-op if libuvch264src already has it).
  try {
    if (info.iface.isKernelDriverActive()) {
      console.log("Kernel driver attached — detaching.");
      info.iface.detachKernelDriver();
    }
  } catch (err) {
    console.log("isKernelDriverActive/detachKernelDriver threw:", err.message);
  }

  try {
    info.iface.claim();
    console.log("Claimed VideoControl interface. Concurrent access looks possible.");
  } catch (err) {
    console.error("claim() failed:", err.message);
    console.error(
      "If this happened while streaming, libuvch264src is holding the VC interface; concurrent libusb PTZ is not possible.",
    );
    try { device.close(); } catch (_) {}
    process.exit(2);
  }

  try {
    const { pan, tilt } = await getPanTilt(device, info.ifaceNum, info.ctUnitId);
    console.log(`GET_CUR PAN_TILT_ABSOLUTE: pan=${pan} tilt=${tilt}`);
  } catch (err) {
    console.error("GET_CUR control transfer failed:", err.message);
  }

  try { info.iface.release(true, () => {}); } catch (_) {}
  try { device.close(); } catch (_) {}
})();