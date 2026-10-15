import { buildJob, parseStatus, QUERIES } from './m110.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Holds the active transport, tracks printer status and sends print jobs. */
export class Printer extends EventTarget {
  transport = null;
  status = {};

  get connected() { return !!this.transport?.open; }

  async attach(transport) {
    await this.detach();
    this.transport = transport;
    this.status = {};
    transport.onData = (bytes) => {
      Object.assign(this.status, parseStatus(bytes));
      this.dispatchEvent(new Event('change'));
    };
    transport.onClose = () => {
      if (this.transport === transport) this.transport = null;
      this.status = {};
      this.dispatchEvent(new Event('change'));
    };
    this.dispatchEvent(new Event('change'));
    await this.refreshStatus();
  }

  async detach() {
    const t = this.transport;
    this.transport = null;
    if (t) await t.close();
    this.status = {};
    this.dispatchEvent(new Event('change'));
  }

  async refreshStatus() {
    if (!this.connected) return;
    for (const q of Object.values(QUERIES)) {
      await this.transport.write(new Uint8Array(q));
      await sleep(60);
    }
  }

  async send(bytes, onProgress) {
    const { chunkSize, chunkDelay } = this.transport;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      await this.transport.write(bytes.subarray(i, i + chunkSize));
      if (chunkDelay) await sleep(chunkDelay);
      onProgress?.(Math.min(1, (i + chunkSize) / bytes.length));
    }
  }

  async print(raster, { density, media, copies = 1, onProgress } = {}) {
    if (!this.connected) throw new Error('Printer is not connected');
    const job = buildJob(raster, { density, media });
    for (let c = 0; c < copies; c++) {
      await this.send(job, (p) => onProgress?.((c + p) / copies, c + 1));
      await sleep(400);
    }
    this.refreshStatus().catch(() => {});
  }
}
