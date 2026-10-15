// Phomemo M110 protocol. Based on vivier/phomemo-tools (CUPS filter) and
// transcriptionstream/phomymo. Verified over USB on an M110 (firmware 2.2.2).

export const DOTS_PER_MM = 8; // 203 dpi
export const HEAD_DOTS = 384; // 48 mm print head
export const HEAD_BYTES = HEAD_DOTS / 8;

export const MEDIA_TYPES = {
  gaps: { code: 10, label: 'Labels with gaps' },
  continuous: { code: 11, label: 'Continuous roll' },
  marks: { code: 38, label: 'Labels with black marks' },
};

const cmd = {
  speed: (n) => [0x1b, 0x4e, 0x0d, n],
  density: (n) => [0x1b, 0x4e, 0x04, n],
  media: (n) => [0x1f, 0x11, n],
  raster: (widthBytes, lines) => [0x1d, 0x76, 0x30, 0x00, widthBytes & 0xff, widthBytes >> 8, lines & 0xff, lines >> 8],
  footer: [0x1f, 0xf0, 0x05, 0x00, 0x1f, 0xf0, 0x03, 0x00],
};

export const QUERIES = {
  battery: [0x1f, 0x11, 0x08],
  paper: [0x1f, 0x11, 0x11],
  firmware: [0x1f, 0x11, 0x07],
};

/** Build the byte stream for one label. */
export function buildJob({ bits, widthBytes, lines }, { density = 10, media = 'gaps' } = {}) {
  const head = [
    ...cmd.speed(5),
    ...cmd.density(Math.max(1, Math.min(15, density))),
    ...cmd.media(MEDIA_TYPES[media]?.code ?? 10),
    ...cmd.raster(widthBytes, lines),
  ];
  const job = new Uint8Array(head.length + bits.length + cmd.footer.length);
  job.set(head, 0);
  job.set(bits, head.length);
  job.set(cmd.footer, head.length + bits.length);
  return job;
}

/**
 * Parse status notifications. Responses look like 0x1A <type> <value...>.
 * Returns a partial status object.
 */
export function parseStatus(bytes) {
  const status = {};
  let i = 0;
  while (i < bytes.length) {
    if (bytes[i] !== 0x1a || i + 2 >= bytes.length) { i++; continue; }
    const type = bytes[i + 1];
    const v = bytes[i + 2];
    switch (type) {
      case 0x04: status.battery = v <= 100 ? v : null; break;
      case 0x05: status.cover = v === 0x98 ? 'open' : 'closed'; break;
      case 0x06: status.paper = v === 0x88 ? 'out' : 'ok'; break;
      case 0x07: {
        // Firmware: variable length, runs to the end of this message.
        const end = bytes.indexOf(0x1a, i + 2);
        status.firmware = Array.from(bytes.slice(i + 2, end === -1 ? bytes.length : end)).join('.');
        i = end === -1 ? bytes.length : end;
        continue;
      }
      default: break;
    }
    i += 3;
  }
  return status;
}
