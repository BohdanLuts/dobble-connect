export const DEBUG = false;

const CONFIG = Object.freeze({
  ANALYSIS_LONG_EDGE: 640,
  SYMBOL_SIZE: 40,
  ROTATIONS: 12,
  MIN_COMPONENT_AREA: 10,
  MIN_SYMBOL_BOX_AREA_RATIO: 0.00018,
  MAX_SYMBOL_BOX_AREA_RATIO: 0.026,
  MAX_SYMBOL_DIMENSION_RATIO: 0.22,
  MIN_PAIR_DISTANCE_RATIO: 0.16,
  MATCH_SCORE_MIN: 0.73,
  MATCH_MARGIN_MIN: 0.045,
  MAX_MATCHES: 6
});

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export class VisionEngine {
  constructor(config = {}) {
    this.config = { ...CONFIG, ...config };
    this.canvas = document.createElement("canvas");
    this.ctx = this.canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  }

  analyze(video, viewportWidth, viewportHeight) {
    const startedAt = performance.now();
    const frame = this.capture(video, viewportWidth, viewportHeight);
    if (!frame) return null;

    const segmentation = segmentScene(frame.imageData, this.config);
    const comparison = compareSceneSymbols(segmentation.symbols, frame.width, frame.height, this.config);
    const matches = comparison.accepted.map(({ a, b, score, margin }) => ({
      score,
      margin,
      aIndex: a,
      bIndex: b,
      aQuad: boxQuad(segmentation.symbols[a].box),
      bQuad: boxQuad(segmentation.symbols[b].box)
    }));

    return {
      frame: {
        width: frame.width,
        height: frame.height,
        videoWidth: frame.videoWidth,
        videoHeight: frame.videoHeight,
        sourceRect: frame.sourceRect
      },
      cards: [],
      candidates: [],
      matches,
      state: matches.length ? "match" : "searching",
      debug: {
        processingMs: performance.now() - startedAt,
        candidateCount: segmentation.symbols.length,
        cardCount: 0,
        symbolCounts: [segmentation.symbols.length],
        bestScore: comparison.bestScore,
        secondScore: comparison.secondScore,
        margin: comparison.bestMargin
      }
    };
  }

  capture(video, viewportWidth, viewportHeight) {
    const videoWidth = video.videoWidth;
    const videoHeight = video.videoHeight;
    if (!videoWidth || !videoHeight || !viewportWidth || !viewportHeight) return null;

    const videoAspect = videoWidth / videoHeight;
    const viewportAspect = viewportWidth / viewportHeight;
    let sourceX = 0, sourceY = 0, sourceWidth = videoWidth, sourceHeight = videoHeight;
    if (viewportAspect > videoAspect) {
      sourceHeight = videoWidth / viewportAspect;
      sourceY = (videoHeight - sourceHeight) / 2;
    } else {
      sourceWidth = videoHeight * viewportAspect;
      sourceX = (videoWidth - sourceWidth) / 2;
    }

    let width, height;
    if (viewportWidth >= viewportHeight) {
      width = this.config.ANALYSIS_LONG_EDGE;
      height = Math.max(1, Math.round(width / viewportAspect));
    } else {
      height = this.config.ANALYSIS_LONG_EDGE;
      width = Math.max(1, Math.round(height * viewportAspect));
    }
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.ctx.drawImage(video, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, width, height);
    return {
      width, height, videoWidth, videoHeight,
      sourceRect: { x: sourceX, y: sourceY, width: sourceWidth, height: sourceHeight },
      imageData: this.ctx.getImageData(0, 0, width, height)
    };
  }
}

function segmentScene(imageData, config) {
  const { width, height, data } = imageData;
  const mask = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    const r = data[p], g = data[p + 1], b = data[p + 2];
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const saturation = max ? (max - min) / max : 0;
    const value = max / 255;
    // Dobble artwork is either colourful or dark ink. This intentionally ignores
    // card shape and most neutral white/grey backgrounds.
    if ((saturation > 0.20 && value > 0.16) || value < 0.32) mask[i] = 1;
  }

  const components = findComponents(mask, width, height, config.MIN_COMPONENT_AREA)
    .filter(c => {
      const boxAreaRatio = c.width * c.height / (width * height);
      return boxAreaRatio >= config.MIN_SYMBOL_BOX_AREA_RATIO * 0.16 &&
        boxAreaRatio <= config.MAX_SYMBOL_BOX_AREA_RATIO &&
        c.width < width * config.MAX_SYMBOL_DIMENSION_RATIO &&
        c.height < height * config.MAX_SYMBOL_DIMENSION_RATIO;
    });

  const groups = groupComponents(components, width, height);
  const symbols = groups
    .filter(g => {
      const ratio = g.box.width * g.box.height / (width * height);
      return ratio >= config.MIN_SYMBOL_BOX_AREA_RATIO &&
        ratio <= config.MAX_SYMBOL_BOX_AREA_RATIO &&
        g.box.width >= 7 && g.box.height >= 7 &&
        g.box.width < width * config.MAX_SYMBOL_DIMENSION_RATIO &&
        g.box.height < height * config.MAX_SYMBOL_DIMENSION_RATIO;
    })
    .map(g => buildDescriptor(imageData, mask, g.box, config));

  return { symbols };
}

function findComponents(mask, width, height, minArea) {
  const seen = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  const out = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let head = 0, tail = 0, area = 0;
    let minX = width, minY = height, maxX = 0, maxY = 0;
    queue[tail++] = start; seen[start] = 1;
    while (head < tail) {
      const idx = queue[head++], x = idx % width, y = (idx / width) | 0;
      area++; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      if (x > 0) push(idx - 1);
      if (x + 1 < width) push(idx + 1);
      if (y > 0) push(idx - width);
      if (y + 1 < height) push(idx + width);
    }
    if (area >= minArea) out.push({ area, minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 });
    function push(n) { if (mask[n] && !seen[n]) { seen[n] = 1; queue[tail++] = n; } }
  }
  return out;
}

function groupComponents(components, width, height) {
  const parent = components.map((_, i) => i);
  const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
  const baseGap = Math.max(4, Math.min(width, height) * 0.012);

  for (let a = 0; a < components.length; a++) {
    for (let b = a + 1; b < components.length; b++) {
      const A = components[a], B = components[b];
      const gapX = Math.max(0, Math.max(A.minX, B.minX) - Math.min(A.maxX, B.maxX) - 1);
      const gapY = Math.max(0, Math.max(A.minY, B.minY) - Math.min(A.maxY, B.maxY) - 1);
      const gap = Math.hypot(gapX, gapY);
      const combinedW = Math.max(A.maxX, B.maxX) - Math.min(A.minX, B.minX) + 1;
      const combinedH = Math.max(A.maxY, B.maxY) - Math.min(A.minY, B.minY) + 1;
      const adaptiveGap = baseGap + Math.min(5, Math.sqrt(Math.min(A.area, B.area)) * 0.22);
      if (gap <= adaptiveGap && combinedW < width * 0.16 && combinedH < height * 0.16) union(a, b);
    }
  }

  const map = new Map();
  components.forEach((c, i) => {
    const root = find(i);
    const g = map.get(root) || { area: 0, minX: width, minY: height, maxX: 0, maxY: 0 };
    g.area += c.area; g.minX = Math.min(g.minX, c.minX); g.minY = Math.min(g.minY, c.minY); g.maxX = Math.max(g.maxX, c.maxX); g.maxY = Math.max(g.maxY, c.maxY);
    map.set(root, g);
  });
  return [...map.values()].map(g => ({ ...g, box: { x: g.minX, y: g.minY, width: g.maxX - g.minX + 1, height: g.maxY - g.minY + 1 } }));
}

function buildDescriptor(imageData, foreground, box, config) {
  const { width, height, data } = imageData;
  let sx = 0, sy = 0, count = 0;
  for (let y = box.y; y < box.y + box.height; y++) for (let x = box.x; x < box.x + box.width; x++) {
    if (!foreground[y * width + x]) continue;
    sx += x; sy += y; count++;
  }
  const cx = count ? sx / count : box.x + box.width / 2;
  const cy = count ? sy / count : box.y + box.height / 2;
  let radius = 1;
  for (let y = box.y; y < box.y + box.height; y++) for (let x = box.x; x < box.x + box.width; x++) {
    if (foreground[y * width + x]) radius = Math.max(radius, Math.hypot(x - cx, y - cy));
  }

  const n = config.SYMBOL_SIZE, scale = radius / (n * 0.39);
  const mask = new Uint8Array(n * n), color = new Uint8Array(n * n * 3), lum = new Uint8Array(n * n);
  const hist = new Float32Array(12);
  let fg = 0;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const px = Math.round(cx + (x - (n - 1) / 2) * scale), py = Math.round(cy + (y - (n - 1) / 2) * scale);
    if (px < 0 || py < 0 || px >= width || py >= height) continue;
    const si = py * width + px;
    if (!foreground[si]) continue;
    const ti = y * n + x, p = si * 4, r = data[p], g = data[p + 1], b = data[p + 2], total = r + g + b + 1;
    mask[ti] = 1; color[ti * 3] = r * 255 / total; color[ti * 3 + 1] = g * 255 / total; color[ti * 3 + 2] = b * 255 / total;
    lum[ti] = r * .299 + g * .587 + b * .114;
    const hsv = rgbToHsv(r, g, b); hist[Math.min(11, Math.floor(hsv.h * 12))] += Math.max(.15, hsv.s); fg++;
  }
  const ht = hist.reduce((s, v) => s + v, 0) || 1;
  for (let i = 0; i < hist.length; i++) hist[i] /= ht;
  const rotations = [];
  for (let i = 0; i < config.ROTATIONS; i++) rotations.push(rotate(mask, color, lum, n, i * Math.PI * 2 / config.ROTATIONS));
  return { box, mask, color, luminance: lum, histogram: hist, foregroundCount: fg, rotations };
}

function rotate(mask, color, lum, size, angle) {
  if (!angle) return { mask, color, luminance: lum, count: mask.reduce((s, v) => s + v, 0) };
  const m = new Uint8Array(mask.length), c = new Uint8Array(color.length), l = new Uint8Array(lum.length);
  const center = (size - 1) / 2, co = Math.cos(angle), si = Math.sin(angle); let count = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = x - center, dy = y - center;
    const xx = Math.round(center + dx * co + dy * si), yy = Math.round(center - dx * si + dy * co);
    if (xx < 0 || yy < 0 || xx >= size || yy >= size) continue;
    const src = yy * size + xx; if (!mask[src]) continue;
    const dst = y * size + x; m[dst] = 1; l[dst] = lum[src]; c[dst * 3] = color[src * 3]; c[dst * 3 + 1] = color[src * 3 + 1]; c[dst * 3 + 2] = color[src * 3 + 2]; count++;
  }
  return { mask: m, color: c, luminance: l, count };
}

function compareSceneSymbols(symbols, width, height, config) {
  const diagonal = Math.hypot(width, height), pairs = [];
  const bestFor = new Array(symbols.length).fill(-Infinity);
  for (let a = 0; a < symbols.length; a++) for (let b = a + 1; b < symbols.length; b++) {
    const ca = boxCenter(symbols[a].box), cb = boxCenter(symbols[b].box);
    if (Math.hypot(ca.x - cb.x, ca.y - cb.y) / diagonal < config.MIN_PAIR_DISTANCE_RATIO) continue;
    const score = compareSymbols(symbols[a], symbols[b]);
    pairs.push({ a, b, score }); bestFor[a] = Math.max(bestFor[a], score); bestFor[b] = Math.max(bestFor[b], score);
  }
  pairs.sort((a, b) => b.score - a.score);
  for (const p of pairs) {
    let alt = -Infinity;
    for (const q of pairs) if (q !== p && (q.a === p.a || q.b === p.a || q.a === p.b || q.b === p.b)) alt = Math.max(alt, q.score);
    p.margin = p.score - (Number.isFinite(alt) ? alt : 0);
    p.mutualBest = p.score >= bestFor[p.a] - 1e-6 && p.score >= bestFor[p.b] - 1e-6;
  }
  const accepted = [], used = new Set();
  for (const p of pairs) {
    if (p.score < config.MATCH_SCORE_MIN || p.margin < config.MATCH_MARGIN_MIN || !p.mutualBest || used.has(p.a) || used.has(p.b)) continue;
    accepted.push(p); used.add(p.a); used.add(p.b); if (accepted.length >= config.MAX_MATCHES) break;
  }
  return { accepted, bestScore: pairs[0]?.score || 0, secondScore: pairs[1]?.score || 0, bestMargin: pairs[0]?.margin || 0 };
}

function compareSymbols(a, b) {
  let hist = 0; for (let i = 0; i < a.histogram.length; i++) hist += Math.min(a.histogram[i], b.histogram[i]);
  let best = 0;
  for (const r of b.rotations) {
    let inter = 0, cd = 0, ld = 0;
    for (let i = 0; i < a.mask.length; i++) {
      if (!a.mask[i] || !r.mask[i]) continue;
      inter++; const k = i * 3;
      cd += Math.abs(a.color[k] - r.color[k]) + Math.abs(a.color[k + 1] - r.color[k + 1]) + Math.abs(a.color[k + 2] - r.color[k + 2]);
      ld += Math.abs(a.luminance[i] - r.luminance[i]);
    }
    if (!inter) continue;
    const dice = 2 * inter / Math.max(1, a.foregroundCount + r.count);
    const color = clamp(1 - cd / (inter * 265), 0, 1);
    const luminance = clamp(1 - ld / (inter * 150), 0, 1);
    const coverage = inter / Math.max(1, Math.min(a.foregroundCount, r.count));
    best = Math.max(best, dice * .46 + color * .27 + luminance * .07 + hist * .12 + coverage * .08);
  }
  return best;
}

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255; const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min; let h = 0;
  if (d) { if (max === r) h = ((g - b) / d) % 6; else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h /= 6; if (h < 0) h += 1; }
  return { h, s: max ? d / max : 0, v: max };
}

function boxCenter(b) { return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; }
function boxQuad(b) {
  const p = Math.max(4, Math.min(b.width, b.height) * .16), x1 = b.x - p, y1 = b.y - p, x2 = b.x + b.width + p, y2 = b.y + b.height + p;
  return [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }];
}
function quadBounds(quad) {
  const xs = quad.map(p => p.x), ys = quad.map(p => p.y); const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}
function boxIoU(a, b) {
  const l = Math.max(a.x, b.x), t = Math.max(a.y, b.y), r = Math.min(a.x + a.width, b.x + b.width), bot = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, r - l) * Math.max(0, bot - t); return inter / Math.max(1, a.width * a.height + b.width * b.height - inter);
}
function projectPoint(transform, u, v) {
  const d = transform?.g * u + transform?.h * v + 1 || 1;
  return { x: ((transform?.a || 0) * u + (transform?.b || 0) * v + (transform?.c || 0)) / d, y: ((transform?.d || 0) * u + (transform?.e || 0) * v + (transform?.f || 0)) / d };
}

export const geometry = { projectPoint, quadBounds, boxIoU };
