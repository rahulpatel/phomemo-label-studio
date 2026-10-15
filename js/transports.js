// USB (WebUSB) and Bluetooth LE (Web Bluetooth) transports.
// Both expose: kind, name, write(bytes), close(), onData, onClose, chunkSize, chunkDelay.

const USB_FILTERS = [
  { vendorId: 0x0483, productId: 0x5740 }, // M110 (Jieli, STMicro VID)
  { vendorId: 0x0483 },
];

const BLE_SERVICE = 0xff00;
const BLE_WRITE = 0xff02;
const BLE_NOTIFY = 0xff03;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class UsbTransport {
  kind = 'usb';
  chunkSize = 4096;
  chunkDelay = 0;
  onData = null;
  onClose = null;

  static get supported() { return 'usb' in navigator; }

  static async request() {
    const device = await navigator.usb.requestDevice({ filters: USB_FILTERS });
    return UsbTransport.open(device);
  }

  /** Reopen a printer the user already granted access to, without a prompt. */
  static async reconnect() {
    if (!UsbTransport.supported) return null;
    const devices = await navigator.usb.getDevices();
    const device = devices.find((d) => d.vendorId === 0x0483);
    return device ? UsbTransport.open(device) : null;
  }

  static async open(device) {
    const t = new UsbTransport();
    t.device = device;
    await device.open();
    if (device.configuration === null) await device.selectConfiguration(1);
    const iface =
      device.configuration.interfaces.find((i) => i.alternates.some((a) => a.interfaceClass === 7)) ??
      device.configuration.interfaces[0];
    try {
      await device.claimInterface(iface.interfaceNumber);
    } catch (e) {
      await device.close().catch(() => {});
      throw new Error('The printer is busy. Close Labelife or other printing apps and try again.');
    }
    const endpoints = iface.alternates[0].endpoints;
    t.iface = iface.interfaceNumber;
    t.outEp = endpoints.find((e) => e.direction === 'out')?.endpointNumber;
    t.inEp = endpoints.find((e) => e.direction === 'in')?.endpointNumber;
    if (!t.outEp) throw new Error('Printer has no output endpoint');
    t.open = true;
    t.readLoop();
    return t;
  }

  get name() { return this.device?.productName && this.device.productName !== 'USB Composite Device' ? this.device.productName : 'Phomemo M110'; }

  async readLoop() {
    if (!this.inEp) return;
    while (this.open) {
      try {
        const r = await this.device.transferIn(this.inEp, 64);
        if (r.data?.byteLength) this.onData?.(new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength));
        if (r.status === 'stall') await this.device.clearHalt('in', this.inEp);
      } catch {
        break;
      }
    }
  }

  async write(bytes) {
    await this.device.transferOut(this.outEp, bytes);
  }

  async close() {
    if (!this.open) return;
    this.open = false;
    try { await this.device.releaseInterface(this.iface); } catch {}
    try { await this.device.close(); } catch {}
    this.onClose?.();
  }
}

export class BleTransport {
  kind = 'bluetooth';
  chunkSize = 128;
  chunkDelay = 20;
  onData = null;
  onClose = null;

  static get supported() { return 'bluetooth' in navigator; }

  static async request({ showAll = false } = {}) {
    const device = await navigator.bluetooth.requestDevice(
      showAll
        ? { acceptAllDevices: true, optionalServices: [BLE_SERVICE] }
        : {
            filters: [
              { namePrefix: 'M110' }, { namePrefix: 'M120' }, { namePrefix: 'Q' },
              { namePrefix: 'Phomemo' }, { services: [BLE_SERVICE] },
            ],
            optionalServices: [BLE_SERVICE],
          },
    );
    const t = new BleTransport();
    t.device = device;
    device.addEventListener('gattserverdisconnected', () => {
      if (t.open) { t.open = false; t.onClose?.(); }
    });
    let lastError;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await t.connectGatt();
        return t;
      } catch (e) {
        lastError = e;
        await sleep(300 * 2 ** attempt);
      }
    }
    throw lastError;
  }

  async connectGatt() {
    const server = await this.device.gatt.connect();
    await sleep(100);
    const service = await server.getPrimaryService(BLE_SERVICE);
    this.writeChar = await service.getCharacteristic(BLE_WRITE);
    this.withResponse = !this.writeChar.properties.writeWithoutResponse;
    try {
      const notify = await service.getCharacteristic(BLE_NOTIFY);
      await notify.startNotifications();
      notify.addEventListener('characteristicvaluechanged', (e) => {
        const v = e.target.value;
        this.onData?.(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
      });
    } catch {
      // Status notifications are optional.
    }
    this.open = true;
  }

  get name() { return this.device?.name || 'Phomemo M110'; }

  async write(bytes) {
    const buf = bytes.slice().buffer;
    if (this.withResponse) return this.writeChar.writeValue(buf);
    try {
      await this.writeChar.writeValueWithoutResponse(buf);
    } catch {
      this.withResponse = true;
      await this.writeChar.writeValue(buf);
    }
  }

  async close() {
    if (!this.open) return;
    this.open = false;
    try { this.device.gatt.disconnect(); } catch {}
    this.onClose?.();
  }
}
