// SVG templates: import, placeholder discovery ({{name}}) and filling.

const FIELD_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;
const SVG_NS = 'http://www.w3.org/2000/svg';

function parse(svgText) {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const svg = doc.documentElement;
  if (doc.querySelector('parsererror') || svg.localName !== 'svg') throw new Error('Not a valid SVG file');
  return svg;
}

/** Remove scripts, event handlers and external references. */
function sanitize(svg) {
  svg.querySelectorAll('script, foreignObject').forEach((el) => el.remove());
  for (const el of [svg, ...svg.querySelectorAll('*')]) {
    for (const attr of [...el.attributes]) {
      if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
      if (/href$/i.test(attr.name) && /^\s*javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
    }
  }
}

function intrinsicSize(svg) {
  const vb = svg.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
  if (vb?.length === 4 && vb[2] > 0 && vb[3] > 0) return { width: vb[2], height: vb[3] };
  const w = parseFloat(svg.getAttribute('width'));
  const h = parseFloat(svg.getAttribute('height'));
  if (w > 0 && h > 0) return { width: w, height: h };
  throw new Error('SVG has no size. Export a frame from Figma.');
}

/** Clean an SVG string and read its size and {{fields}}. */
export function importSvg(svgText) {
  const svg = parse(svgText);
  sanitize(svg);
  if (!svg.getAttribute('xmlns')) svg.setAttribute('xmlns', SVG_NS);
  const size = intrinsicSize(svg);
  if (!svg.hasAttribute('viewBox')) svg.setAttribute('viewBox', `0 0 ${size.width} ${size.height}`);
  const svgOut = new XMLSerializer().serializeToString(svg);
  return { svg: svgOut, ...size, fields: findFields(svg), fonts: findFonts(svg) };
}

/** Wrap a PNG/JPEG file in an SVG so it can be used as a template. */
export async function importImage(file) {
  const dataUrl = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error('Could not read image'));
    i.src = dataUrl;
  });
  const { naturalWidth: w, naturalHeight: h } = img;
  return importSvg(
    `<svg xmlns="${SVG_NS}" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><image href="${dataUrl}" width="${w}" height="${h}"/></svg>`,
  );
}

export function findFields(svgOrText) {
  const svg = typeof svgOrText === 'string' ? parse(svgOrText) : svgOrText;
  const names = [];
  for (const text of svg.querySelectorAll('text')) {
    for (const m of text.textContent.matchAll(FIELD_RE)) {
      if (!names.includes(m[1])) names.push(m[1]);
    }
  }
  return names;
}

function findFonts(svg) {
  const fonts = new Set();
  for (const el of svg.querySelectorAll('text, tspan, [font-family], [style*="font-family"]')) {
    const family = el.getAttribute('font-family') || /font-family:\s*([^;]+)/.exec(el.getAttribute('style') || '')?.[1];
    if (!family) continue;
    const first = family.split(',')[0].trim().replace(/^['"]|['"]$/g, '');
    if (first) fonts.add(first);
  }
  return [...fonts];
}

const GENERIC_FONTS = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui']);

/** Fonts used by the template that are not installed (SVG images can only use installed fonts). */
export function missingFonts(fonts) {
  const ctx = document.createElement('canvas').getContext('2d');
  const sample = 'mmmmmmmmmmlli1WQ@#';
  const width = (font) => { ctx.font = `40px ${font}`; return ctx.measureText(sample).width; };
  return fonts.filter((f) => {
    if (GENERIC_FONTS.has(f.toLowerCase())) return false;
    return ['monospace', 'serif', 'sans-serif'].every((base) => width(`"${f}", ${base}`) === width(base));
  });
}

export function autoValue(name, now = new Date()) {
  const key = name.toLowerCase();
  if (key === 'date' || key === 'today') return now.toLocaleDateString();
  if (key === 'time') return now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (key === 'datetime') return `${now.toLocaleDateString()} ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  return null;
}

function leafTextNodes(text) {
  const tspans = [...text.querySelectorAll('tspan')].filter((t) => !t.querySelector('tspan'));
  return tspans.length ? tspans : [text];
}

/**
 * Replace {{fields}} with values. Text exported from Figma is positioned by
 * its left edge, so the x position is recalculated to keep each field
 * anchored at its left, center or right. Text that would run off the label
 * is shrunk to fit. That needs real text measurements, so the SVG is briefly
 * attached to `host` (an off-screen element).
 */
export function fillTemplate(svgText, values = {}, align = {}, host) {
  const svg = document.importNode(parse(svgText), true);
  host.replaceChildren(svg);
  try {
    const vb = svg.viewBox.baseVal;
    const margin = vb.width * 0.06;
    const minX = vb.x + margin;
    const maxX = vb.x + vb.width - margin;
    for (const text of svg.querySelectorAll('text')) {
      if (!FIELD_RE.test(text.textContent)) continue;
      FIELD_RE.lastIndex = 0;
      for (const node of leafTextNodes(text)) {
        const original = node.textContent;
        const names = [...original.matchAll(FIELD_RE)].map((m) => m[1]);
        if (!names.length) continue;
        const mode = align[names[0]] || 'left';
        const xAttr = node.getAttribute('x');
        const positioned = xAttr !== null && /^\s*-?[\d.]+\s*$/.test(xAttr);
        const before = node.getComputedTextLength();
        node.textContent = original.replace(FIELD_RE, (_, name) => {
          const v = values[name];
          return v === undefined || v === '' ? (autoValue(name) ?? '') : v;
        });
        if (!positioned || text.hasAttribute('transform')) continue;

        const x = parseFloat(xAttr);
        const anchor = mode === 'center' ? x + before / 2 : mode === 'right' ? x + before : x;
        let width = node.getComputedTextLength();
        if (width > maxX - minX) {
          const size = parseFloat(getComputedStyle(node).fontSize);
          node.style.fontSize = `${(size * (maxX - minX)) / width}px`;
          width = node.getComputedTextLength();
        }
        let newX = mode === 'center' ? anchor - width / 2 : mode === 'right' ? anchor - width : anchor;
        newX = Math.min(Math.max(newX, minX), Math.max(minX, maxX - width));
        node.setAttribute('x', String(newX));
      }
    }
    return new XMLSerializer().serializeToString(svg);
  } finally {
    host.replaceChildren();
  }
}
