import { DOTS_PER_MM, HEAD_DOTS, HEAD_BYTES } from './m110.js';

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not render this template'));
    img.src = url;
  });
}

/** Draw an SVG string into a white canvas of the given size, scaled to fit and centered. */
async function svgToCanvas(svgText, width, height) {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const svg = doc.documentElement;
  if (!svg.hasAttribute('viewBox')) {
    const w = parseFloat(svg.getAttribute('width')) || width;
    const h = parseFloat(svg.getAttribute('height')) || height;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  }
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' }));
  try {
    const img = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Render a template onto a canvas the size of the label (1 px = 1 printer dot). */
export async function renderLabel(svgText, { width, height }, rotation = 0) {
  const w = Math.round(width * DOTS_PER_MM);
  const h = Math.round(height * DOTS_PER_MM);
  const sideways = rotation === 90 || rotation === 270;
  const content = await svgToCanvas(svgText, sideways ? h : w, sideways ? w : h);
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d');
  ctx.translate(w / 2, h / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.drawImage(content, -content.width / 2, -content.height / 2);
  return out;
}

function luminance(canvas) {
  const { width, height } = canvas;
  const px = canvas.getContext('2d').getImageData(0, 0, width, height).data;
  const lum = new Float32Array(width * height);
  for (let i = 0; i < lum.length; i++) {
    lum[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
  }
  return lum;
}

/** Photos and gradients look better dithered; text and line art look better thresholded. */
function looksLikePhoto(lum) {
  let mid = 0;
  let inked = 0;
  for (const v of lum) {
    if (v < 235) inked++;
    if (v > 50 && v < 205) mid++;
  }
  return inked > 0 && mid / inked > 0.35;
}

function threshold(lum, t) {
  const out = new Uint8Array(lum.length);
  for (let i = 0; i < lum.length; i++) out[i] = lum[i] < t ? 1 : 0;
  return out;
}

function diffuse(lum, w, h, t, kernel, divisor) {
  const buf = Float32Array.from(lum, (v) => v + (128 - t));
  const out = new Uint8Array(lum.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const black = buf[i] < 128;
      out[i] = black ? 1 : 0;
      const err = buf[i] - (black ? 0 : 255);
      for (const [dx, dy, k] of kernel) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && nx < w && ny < h) buf[ny * w + nx] += (err * k) / divisor;
      }
    }
  }
  return out;
}

const FLOYD = [[1, 0, 7], [-1, 1, 3], [0, 1, 5], [1, 1, 1]];
const ATKINSON = [[1, 0, 1], [2, 0, 1], [-1, 1, 1], [0, 1, 1], [1, 1, 1], [0, 2, 1]];

/** Where the label sits on the print head: label column x prints at head column x + start. */
export function headPlacement(labelDots, offsetX = 0) {
  return Math.floor((HEAD_DOTS - labelDots) / 2) + Math.round(offsetX);
}

/**
 * Convert a label canvas to 1-bit printer data.
 * Returns { mono, bits, widthBytes, lines, headStart, offsetY, mode } where mono is
 * the 1-bit image in label coordinates (1 = black) for previews.
 */
export function toRaster(canvas, { mode = 'auto', threshold: t = 128, offsetX = 0, offsetY = 0 } = {}) {
  const { width: w, height: h } = canvas;
  const lum = luminance(canvas);
  const used = mode === 'auto' ? (looksLikePhoto(lum) ? 'atkinson' : 'threshold') : mode;
  const mono =
    used === 'floyd' ? diffuse(lum, w, h, t, FLOYD, 16)
    : used === 'atkinson' ? diffuse(lum, w, h, t, ATKINSON, 8)
    : threshold(lum, t);

  const headStart = headPlacement(w, offsetX);
  const dy = Math.round(offsetY);
  const bits = new Uint8Array(HEAD_BYTES * h);
  for (let y = 0; y < h; y++) {
    const sy = y - dy;
    if (sy < 0 || sy >= h) continue;
    for (let x = 0; x < HEAD_DOTS; x++) {
      const sx = x - headStart;
      if (sx < 0 || sx >= w || !mono[sy * w + sx]) continue;
      bits[y * HEAD_BYTES + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return { mono, bits, widthBytes: HEAD_BYTES, lines: h, headStart, offsetY: dy, mode: used };
}
