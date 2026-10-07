export const DEBUG = false;

// All real-world tuning knobs live here. Values are deliberately conservative:
// a missed detection is preferable to a wrong red box.
export const VISION_CONFIG = Object.freeze({
  ANALYSIS_LONG_EDGE: 720,
  DETECTION_LONG_EDGE: 360,
  CARD_NORMAL_SIZE: 288,
  SYMBOL_NORMAL_SIZE: 48,
  ROTATION_STEPS: 12,
  MIN_CARD_FRAME_AREA: 0.018,
  MAX_CARD_FRAME_AREA: 0.46,
  MAX_CARD_OVERLAP: 0.2,
  MIN_CARD_ASPECT: 0.52,
  MAX_CARD_ASPECT: 1.92,
  CARD_BORDER_MARGIN: 0.055,
  MIN_SYMBOLS: 7,
  MAX_SYMBOLS: 14,
  EXPECTED_SYMBOLS: 10,
  MIN_COMPONENT_AREA: 7,
  MAX_SYMBOL_AREA: 0.095,
  MATCH_SCORE_MIN: 0.72,
  MATCH_MARGIN_MIN: 0.075,
  MAX_ACCEPTED_MATCHES: 3
});

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const sq = (value) => value * value;

export class VisionEngine {
  constructor(config = {}) {
    this.config = { ...VISION_CONFIG, ...config };
    this.analysisCanvas = document.createElement("canvas");
    this.analysisContext = this.analysisCanvas.getContext("2d", {
      alpha: false,
      willReadFrequently: true
    });
    this.detectionCanvas = document.createElement("canvas");
    this.detectionContext = this.detectionCanvas.getContext("2d", {
      alpha: false,
      willReadFrequently: true
    });
  }

  analyze(video, viewportWidth, viewportHeight) {
    const startedAt = performance.now();
    const frame = this.captureVisibleFrame(video, viewportWidth, viewportHeight);
    if (!frame) return null;

    const detection = this.detectCards(frame);
    if (detection.cards.length !== 2) {
      return this.makeResult(frame, detection, [], [], startedAt, "cards");
    }

    const cards = detection.cards
      .sort((a, b) => (a.center.x + a.center.y * 0.12) - (b.center.x + b.center.y * 0.12))
      .map((candidate) => this.analyzeCard(frame, candidate));

    if (cards.some((card) => !card.plausible)) {
      return this.makeResult(frame, detection, cards, [], startedAt, "symbols");
    }

    const comparison = this.compareCards(cards[0], cards[1]);
    const matches = comparison.accepted.map((match) => ({
      score: match.score,
      margin: match.margin,
      aIndex: match.a,
      bIndex: match.b,
      aQuad: this.symbolQuadInFrame(cards[0], cards[0].symbols[match.a].box),
      bQuad: this.symbolQuadInFrame(cards[1], cards[1].symbols[match.b].box)
    }));

    return this.makeResult(frame, detection, cards, matches, startedAt, matches.length ? "match" : "uncertain", comparison);
  }

  captureVisibleFrame(video, viewportWidth, viewportHeight) {
    const videoWidth = video.videoWidth;
    const videoHeight = video.videoHeight;
    if (!videoWidth || !videoHeight || !viewportWidth || !viewportHeight) return null;

    const videoAspect = videoWidth / videoHeight;
    const viewportAspect = viewportWidth / viewportHeight;
    let sourceX = 0;
    let sourceY = 0;
    let sourceWidth = videoWidth;
    let sourceHeight = videoHeight;

    // Match object-fit: cover exactly, so vision sees precisely what the user sees.
    if (viewportAspect > videoAspect) {
      sourceHeight = videoWidth / viewportAspect;
      sourceY = (videoHeight - sourceHeight) * 0.5;
    } else {
      sourceWidth = videoHeight * viewportAspect;
      sourceX = (videoWidth - sourceWidth) * 0.5;
    }

    let width;
    let height;
    if (viewportWidth >= viewportHeight) {
      width = this.config.ANALYSIS_LONG_EDGE;
      height = Math.max(1, Math.round(width / viewportAspect));
    } else {
      height = this.config.ANALYSIS_LONG_EDGE;
      width = Math.max(1, Math.round(height * viewportAspect));
    }

    if (this.analysisCanvas.width !== width || this.analysisCanvas.height !== height) {
      this.analysisCanvas.width = width;
      this.analysisCanvas.height = height;
    }
    this.analysisContext.drawImage(
      video,
      sourceX, sourceY, sourceWidth, sourceHeight,
      0, 0, width, height
    );

    return {
      width,
      height,
      videoWidth,
      videoHeight,
      sourceRect: { x: sourceX, y: sourceY, width: sourceWidth, height: sourceHeight },
      imageData: this.analysisContext.getImageData(0, 0, width, height)
    };
  }

  detectCards(frame) {
    const frameAspect = frame.width / frame.height;
    let width;
    let height;
    if (frame.width >= frame.height) {
      width = this.config.DETECTION_LONG_EDGE;
      height = Math.max(1, Math.round(width / frameAspect));
    } else {
      height = this.config.DETECTION_LONG_EDGE;
      width = Math.max(1, Math.round(height * frameAspect));
    }

    if (this.detectionCanvas.width !== width || this.detectionCanvas.height !== height) {
      this.detectionCanvas.width = width;
      this.detectionCanvas.height = height;
    }
    this.detectionContext.drawImage(this.analysisCanvas, 0, 0, width, height);
    const pixels = this.detectionContext.getImageData(0, 0, width, height);
    let mask = makeWhiteMask(pixels.data, width, height);
    mask = closeMask(mask, width, height);
    const components = findComponents(mask, width, height, Math.max(30, width * height * 0.001));
    const frameArea = width * height;
    const candidates = [];

    for (const component of components) {
      const areaRatio = component.area / frameArea;
      if (areaRatio < this.config.MIN_CARD_FRAME_AREA || areaRatio > this.config.MAX_CARD_FRAME_AREA) continue;
      if (component.width < width * 0.09 || component.height < height * 0.09) continue;
      const hull = convexHull(component.boundary);
      if (hull.length < 4) continue;
      const rectangle = minimumAreaRectangle(hull);
      if (!rectangle) continue;
      const rawAspect = rectangle.width / Math.max(1, rectangle.height);
      if (rawAspect < this.config.MIN_CARD_ASPECT || rawAspect > this.config.MAX_CARD_ASPECT) continue;
      const aspect = Math.max(rawAspect, 1 / rawAspect);
      const rectangularFill = component.area / Math.max(1, rectangle.area);
      if (rectangularFill < 0.38 || rectangularFill > 1.08) continue;

      const compactness = clamp(rectangularFill, 0, 1);
      const squareScore = 1 - clamp((aspect - 1) / 0.92, 0, 1);
      const sizeScore = clamp(areaRatio / 0.11, 0, 1);
      const score = compactness * 0.46 + squareScore * 0.34 + sizeScore * 0.2;
      const scaleX = frame.width / width;
      const scaleY = frame.height / height;
      const quad = rectangle.corners.map((point) => ({ x: point.x * scaleX, y: point.y * scaleY }));
      const box = quadBounds(quad);
      candidates.push({
        score,
        quad,
        box,
        center: { x: box.x + box.width / 2, y: box.y + box.height / 2 },
        areaRatio
      });
    }

    candidates.sort((a, b) => b.score - a.score);
    const cards = [];
    for (const candidate of candidates) {
      if (cards.every((card) => boxIoU(card.box, candidate.box) < this.config.MAX_CARD_OVERLAP)) {
        cards.push(candidate);
        if (cards.length === 2) break;
      }
    }
    return { cards, candidates };
  }

  analyzeCard(frame, candidate) {
    const size = this.config.CARD_NORMAL_SIZE;
    const transform = squareToQuad(candidate.quad);
    if (!transform) return { ...candidate, plausible: false, symbols: [], transform };
    const normalized = warpPerspective(frame.imageData, transform, size);
    const segmentation = segmentSymbols(normalized, size, this.config);
    return {
      ...candidate,
      transform,
      normalized,
      symbols: segmentation.symbols,
      symbolCount: segmentation.symbols.length,
      segmentationQuality: segmentation.quality,
      plausible: segmentation.plausible
    };
  }

  compareCards(cardA, cardB) {
    const pairs = [];
    const rowBest = new Array(cardA.symbols.length).fill(-Infinity);
    const columnBest = new Array(cardB.symbols.length).fill(-Infinity);

    for (let a = 0; a < cardA.symbols.length; a += 1) {
      for (let b = 0; b < cardB.symbols.length; b += 1) {
        const score = compareSymbols(cardA.symbols[a], cardB.symbols[b]);
        pairs.push({ a, b, score });
        rowBest[a] = Math.max(rowBest[a], score);
        columnBest[b] = Math.max(columnBest[b], score);
      }
    }

    pairs.sort((left, right) => right.score - left.score);
    for (const pair of pairs) {
      let alternative = -Infinity;
      for (const other of pairs) {
        if (other === pair) continue;
        if (other.a === pair.a || other.b === pair.b) alternative = Math.max(alternative, other.score);
      }
      pair.margin = pair.score - alternative;
      pair.mutualBest = pair.score === rowBest[pair.a] && pair.score === columnBest[pair.b];
    }

    const accepted = [];
    const usedA = new Set();
    const usedB = new Set();
    for (const pair of pairs) {
      if (pair.score < this.config.MATCH_SCORE_MIN || pair.margin < this.config.MATCH_MARGIN_MIN || !pair.mutualBest) continue;
      if (usedA.has(pair.a) || usedB.has(pair.b)) continue;
      accepted.push(pair);
      usedA.add(pair.a);
      usedB.add(pair.b);
      if (accepted.length >= this.config.MAX_ACCEPTED_MATCHES) break;
    }

    return {
      accepted,
      bestScore: pairs[0]?.score ?? 0,
      secondScore: pairs[1]?.score ?? 0,
      bestMargin: pairs[0]?.margin ?? 0
    };
  }

  symbolQuadInFrame(card, box) {
    const size = this.config.CARD_NORMAL_SIZE;
    const padding = Math.max(3, Math.min(box.width, box.height) * 0.12);
    const left = clamp(box.x - padding, 0, size);
    const top = clamp(box.y - padding, 0, size);
    const right = clamp(box.x + box.width + padding, 0, size);
    const bottom = clamp(box.y + box.height + padding, 0, size);
    return [
      projectPoint(card.transform, left / size, top / size),
      projectPoint(card.transform, right / size, top / size),
      projectPoint(card.transform, right / size, bottom / size),
      projectPoint(card.transform, left / size, bottom / size)
    ];
  }

  makeResult(frame, detection, cards, matches, startedAt, state, comparison = {}) {
    return {
      frame: {
        width: frame.width,
        height: frame.height,
        videoWidth: frame.videoWidth,
        videoHeight: frame.videoHeight,
        sourceRect: frame.sourceRect
      },
      cards,
      candidates: detection.candidates,
      matches,
      state,
      debug: {
        processingMs: performance.now() - startedAt,
        candidateCount: detection.candidates.length,
        cardCount: detection.cards.length,
        symbolCounts: cards.map((card) => card.symbolCount || 0),
        bestScore: comparison.bestScore || 0,
        secondScore: comparison.secondScore || 0,
        margin: comparison.bestMargin || 0
      }
    };
  }
}

function makeWhiteMask(data, width, height) {
  const mask = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < mask.length; i += 1, p += 4) {
    const r = data[p];
    const g = data[p + 1];
    const b = data[p + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const chroma = max - min;
    // Allows shaded white card interiors while rejecting colorful borders.
    mask[i] = max > 138 && min > 104 && chroma < 66 ? 1 : 0;
  }
  return mask;
}

function closeMask(mask, width, height) {
  const dilated = new Uint8Array(mask.length);
  const closed = new Uint8Array(mask.length);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      let value = 0;
      for (let yy = -1; yy <= 1 && !value; yy += 1) {
        for (let xx = -1; xx <= 1; xx += 1) {
          if (mask[index + yy * width + xx]) { value = 1; break; }
        }
      }
      dilated[index] = value;
    }
  }
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      let value = 1;
      for (let yy = -1; yy <= 1 && value; yy += 1) {
        for (let xx = -1; xx <= 1; xx += 1) {
          if (!dilated[index + yy * width + xx]) { value = 0; break; }
        }
      }
      closed[index] = value;
    }
  }
  return closed;
}

function findComponents(mask, width, height, minimumArea = 1) {
  const visited = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  const components = [];
  const neighborX = [-1, 1, 0, 0];
  const neighborY = [0, 0, -1, 1];

  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;
    let area = 0;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    const boundary = [];

    while (head < tail) {
      const index = queue[head++];
      const x = index % width;
      const y = (index / width) | 0;
      area += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      let isBoundary = false;

      for (let n = 0; n < 4; n += 1) {
        const nx = x + neighborX[n];
        const ny = y + neighborY[n];
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) { isBoundary = true; continue; }
        const next = ny * width + nx;
        if (!mask[next]) { isBoundary = true; continue; }
        if (!visited[next]) {
          visited[next] = 1;
          queue[tail++] = next;
        }
      }
      if (isBoundary) boundary.push({ x, y });
    }

    if (area >= minimumArea) {
      components.push({ area, minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1, boundary });
    }
  }
  return components;
}

function convexHull(points) {
  if (points.length <= 3) return points.slice();
  const sorted = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (origin, a, b) => (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x);
  const lower = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper = [];
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const point = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop();
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function minimumAreaRectangle(hull) {
  if (hull.length < 3) return null;
  const sampleStep = Math.max(1, Math.floor(hull.length / 96));
  let best = null;
  for (let i = 0; i < hull.length; i += sampleStep) {
    const next = hull[(i + 1) % hull.length];
    const edge = { x: next.x - hull[i].x, y: next.y - hull[i].y };
    const length = Math.hypot(edge.x, edge.y);
    if (length < 1) continue;
    const axisX = { x: edge.x / length, y: edge.y / length };
    const axisY = { x: -axisX.y, y: axisX.x };
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const point of hull) {
      const px = point.x * axisX.x + point.y * axisX.y;
      const py = point.x * axisY.x + point.y * axisY.y;
      minX = Math.min(minX, px); maxX = Math.max(maxX, px);
      minY = Math.min(minY, py); maxY = Math.max(maxY, py);
    }
    const area = (maxX - minX) * (maxY - minY);
    if (!best || area < best.area) best = { area, minX, maxX, minY, maxY, axisX, axisY };
  }
  if (!best) return null;
  const fromAxes = (x, y) => ({ x: best.axisX.x * x + best.axisY.x * y, y: best.axisX.y * x + best.axisY.y * y });
  const rectangleCorners = [
    fromAxes(best.minX, best.minY),
    fromAxes(best.maxX, best.minY),
    fromAxes(best.maxX, best.maxY),
    fromAxes(best.minX, best.maxY)
  ];
  // The minimum-area rectangle supplies stable corner directions. Snapping those
  // directions to the convex hull recovers a trapezoid under camera perspective.
  const used = new Set();
  const corners = rectangleCorners.map((corner) => {
    let bestIndex = -1;
    let bestDistance = Infinity;
    for (let i = 0; i < hull.length; i += 1) {
      if (used.has(i)) continue;
      const distance = sq(hull[i].x - corner.x) + sq(hull[i].y - corner.y);
      if (distance < bestDistance) { bestDistance = distance; bestIndex = i; }
    }
    used.add(bestIndex);
    return hull[bestIndex];
  });
  return { corners: orderQuad(corners), width: best.maxX - best.minX, height: best.maxY - best.minY, area: best.area };
}

function orderQuad(points) {
  const center = points.reduce((acc, point) => ({ x: acc.x + point.x / points.length, y: acc.y + point.y / points.length }), { x: 0, y: 0 });
  const ordered = points.slice().sort((a, b) => Math.atan2(a.y - center.y, a.x - center.x) - Math.atan2(b.y - center.y, b.x - center.x));
  let first = 0;
  for (let i = 1; i < ordered.length; i += 1) if (ordered[i].x + ordered[i].y < ordered[first].x + ordered[first].y) first = i;
  return ordered.slice(first).concat(ordered.slice(0, first));
}

function squareToQuad(quad) {
  const [p0, p1, p2, p3] = orderQuad(quad);
  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const sx = p0.x - p1.x + p2.x - p3.x;
  const sy = p0.y - p1.y + p2.y - p3.y;
  const denominator = dx1 * dy2 - dx2 * dy1;
  let g = 0;
  let h = 0;
  if (Math.abs(denominator) > 1e-7) {
    g = (sx * dy2 - dx2 * sy) / denominator;
    h = (dx1 * sy - sx * dy1) / denominator;
  }
  return {
    a: p1.x - p0.x + g * p1.x,
    b: p3.x - p0.x + h * p3.x,
    c: p0.x,
    d: p1.y - p0.y + g * p1.y,
    e: p3.y - p0.y + h * p3.y,
    f: p0.y,
    g,
    h
  };
}

function projectPoint(transform, u, v) {
  const denominator = transform.g * u + transform.h * v + 1;
  return {
    x: (transform.a * u + transform.b * v + transform.c) / denominator,
    y: (transform.d * u + transform.e * v + transform.f) / denominator
  };
}

function warpPerspective(imageData, transform, size) {
  const source = imageData.data;
  const sourceWidth = imageData.width;
  const sourceHeight = imageData.height;
  const output = new ImageData(size, size);
  const target = output.data;
  for (let y = 0; y < size; y += 1) {
    const v = y / (size - 1);
    for (let x = 0; x < size; x += 1) {
      const u = x / (size - 1);
      const point = projectPoint(transform, u, v);
      const sx = clamp(Math.round(point.x), 0, sourceWidth - 1);
      const sy = clamp(Math.round(point.y), 0, sourceHeight - 1);
      const sourceIndex = (sy * sourceWidth + sx) * 4;
      const targetIndex = (y * size + x) * 4;
      target[targetIndex] = source[sourceIndex];
      target[targetIndex + 1] = source[sourceIndex + 1];
      target[targetIndex + 2] = source[sourceIndex + 2];
      target[targetIndex + 3] = 255;
    }
  }
  return output;
}

function segmentSymbols(imageData, size, config) {
  const pixels = imageData.data;
  const mask = new Uint8Array(size * size);
  const margin = Math.round(size * config.CARD_BORDER_MARGIN);
  for (let y = margin; y < size - margin; y += 1) {
    for (let x = margin; x < size - margin; x += 1) {
      const index = y * size + x;
      const p = index * 4;
      const r = pixels[p];
      const g = pixels[p + 1];
      const b = pixels[p + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const saturation = max ? (max - min) / max : 0;
      const value = max / 255;
      // Color or genuinely dark ink is foreground. Neutral mid-tone shadows are ignored.
      if ((saturation > 0.16 && value > 0.2) || value < 0.58) mask[index] = 1;
    }
  }

  const components = findComponents(mask, size, size, config.MIN_COMPONENT_AREA)
    .filter((component) => component.area < size * size * 0.055 && component.width < size * 0.36 && component.height < size * 0.36);
  const groups = groupComponents(components, size);
  const maxArea = size * size * config.MAX_SYMBOL_AREA;
  const boxes = groups
    .filter((group) => group.area >= config.MIN_COMPONENT_AREA * 1.5 && group.box.width >= 5 && group.box.height >= 5 && group.box.width * group.box.height < maxArea)
    .map((group) => group.box)
    .sort((a, b) => (a.y + a.height * 0.5) - (b.y + b.height * 0.5) || a.x - b.x);
  const symbols = boxes.map((box) => buildSymbolDescriptor(imageData, mask, size, box, config));
  const countDifference = Math.abs(symbols.length - config.EXPECTED_SYMBOLS);
  const quality = clamp(1 - countDifference / 7, 0, 1);
  const plausible = symbols.length >= config.MIN_SYMBOLS && symbols.length <= config.MAX_SYMBOLS && quality >= 0.42;
  return { symbols, plausible, quality };
}

function groupComponents(components, cardSize) {
  const parent = components.map((_, index) => index);
  const find = (value) => {
    let root = value;
    while (parent[root] !== root) root = parent[root];
    while (parent[value] !== value) { const next = parent[value]; parent[value] = root; value = next; }
    return root;
  };
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent[rb] = ra; };

  for (let a = 0; a < components.length; a += 1) {
    for (let b = a + 1; b < components.length; b += 1) {
      const left = components[a];
      const right = components[b];
      const gapX = Math.max(0, Math.max(left.minX, right.minX) - Math.min(left.maxX, right.maxX) - 1);
      const gapY = Math.max(0, Math.max(left.minY, right.minY) - Math.min(left.maxY, right.maxY) - 1);
      const gap = Math.hypot(gapX, gapY);
      const smallerArea = Math.min(left.area, right.area);
      let allowedGap = 3 + Math.min(cardSize * 0.032, Math.sqrt(smallerArea) * 0.72);
      // Small detached strokes and dots usually belong to the nearest illustration.
      if (smallerArea < cardSize * cardSize * 0.00065) allowedGap = Math.max(allowedGap, cardSize * 0.035);
      const combinedWidth = Math.max(left.maxX, right.maxX) - Math.min(left.minX, right.minX) + 1;
      const combinedHeight = Math.max(left.maxY, right.maxY) - Math.min(left.minY, right.minY) + 1;
      if (gap <= allowedGap && combinedWidth < cardSize * 0.34 && combinedHeight < cardSize * 0.34) union(a, b);
    }
  }

  const grouped = new Map();
  for (let i = 0; i < components.length; i += 1) {
    const root = find(i);
    const component = components[i];
    const group = grouped.get(root) || { area: 0, minX: cardSize, minY: cardSize, maxX: 0, maxY: 0 };
    group.area += component.area;
    group.minX = Math.min(group.minX, component.minX);
    group.minY = Math.min(group.minY, component.minY);
    group.maxX = Math.max(group.maxX, component.maxX);
    group.maxY = Math.max(group.maxY, component.maxY);
    grouped.set(root, group);
  }

  return [...grouped.values()].map((group) => ({
    ...group,
    box: { x: group.minX, y: group.minY, width: group.maxX - group.minX + 1, height: group.maxY - group.minY + 1 }
  }));
}

function buildSymbolDescriptor(imageData, foregroundMask, cardSize, box, config) {
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  for (let y = box.y; y < box.y + box.height; y += 1) {
    for (let x = box.x; x < box.x + box.width; x += 1) {
      if (!foregroundMask[y * cardSize + x]) continue;
      sumX += x;
      sumY += y;
      count += 1;
    }
  }
  const centerX = count ? sumX / count : box.x + box.width / 2;
  const centerY = count ? sumY / count : box.y + box.height / 2;
  let radius = 1;
  for (let y = box.y; y < box.y + box.height; y += 1) {
    for (let x = box.x; x < box.x + box.width; x += 1) {
      if (foregroundMask[y * cardSize + x]) radius = Math.max(radius, Math.hypot(x - centerX, y - centerY));
    }
  }

  const normalSize = config.SYMBOL_NORMAL_SIZE;
  const scale = radius / (normalSize * 0.39);
  const mask = new Uint8Array(normalSize * normalSize);
  const color = new Uint8Array(normalSize * normalSize * 3);
  const luminance = new Uint8Array(normalSize * normalSize);
  const histogram = new Float32Array(12);
  let foregroundCount = 0;

  for (let y = 0; y < normalSize; y += 1) {
    for (let x = 0; x < normalSize; x += 1) {
      const sourceX = Math.round(centerX + (x - (normalSize - 1) / 2) * scale);
      const sourceY = Math.round(centerY + (y - (normalSize - 1) / 2) * scale);
      if (sourceX < 0 || sourceY < 0 || sourceX >= cardSize || sourceY >= cardSize) continue;
      const sourceIndex = sourceY * cardSize + sourceX;
      if (!foregroundMask[sourceIndex]) continue;
      const targetIndex = y * normalSize + x;
      const pixelIndex = sourceIndex * 4;
      const r = imageData.data[pixelIndex];
      const g = imageData.data[pixelIndex + 1];
      const b = imageData.data[pixelIndex + 2];
      const total = r + g + b + 1;
      mask[targetIndex] = 1;
      color[targetIndex * 3] = Math.round(r * 255 / total);
      color[targetIndex * 3 + 1] = Math.round(g * 255 / total);
      color[targetIndex * 3 + 2] = Math.round(b * 255 / total);
      luminance[targetIndex] = Math.round((r * 0.299 + g * 0.587 + b * 0.114));
      const hsv = rgbToHsv(r, g, b);
      histogram[Math.min(11, Math.floor(hsv.h * 12))] += Math.max(0.15, hsv.s);
      foregroundCount += 1;
    }
  }
  const histogramTotal = histogram.reduce((sum, value) => sum + value, 0) || 1;
  for (let i = 0; i < histogram.length; i += 1) histogram[i] /= histogramTotal;

  const rotations = [];
  for (let step = 0; step < config.ROTATION_STEPS; step += 1) {
    rotations.push(rotateDescriptor(mask, color, luminance, normalSize, step * Math.PI * 2 / config.ROTATION_STEPS));
  }
  return { box, mask, color, luminance, histogram, foregroundCount, rotations };
}

function rotateDescriptor(mask, color, luminance, size, angle) {
  if (angle === 0) return { mask, color, luminance, count: mask.reduce((sum, value) => sum + value, 0) };
  const rotatedMask = new Uint8Array(mask.length);
  const rotatedColor = new Uint8Array(color.length);
  const rotatedLuminance = new Uint8Array(luminance.length);
  const center = (size - 1) / 2;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  let count = 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x - center;
      const dy = y - center;
      const sourceX = Math.round(center + dx * cos + dy * sin);
      const sourceY = Math.round(center - dx * sin + dy * cos);
      if (sourceX < 0 || sourceY < 0 || sourceX >= size || sourceY >= size) continue;
      const sourceIndex = sourceY * size + sourceX;
      if (!mask[sourceIndex]) continue;
      const targetIndex = y * size + x;
      rotatedMask[targetIndex] = 1;
      rotatedColor[targetIndex * 3] = color[sourceIndex * 3];
      rotatedColor[targetIndex * 3 + 1] = color[sourceIndex * 3 + 1];
      rotatedColor[targetIndex * 3 + 2] = color[sourceIndex * 3 + 2];
      rotatedLuminance[targetIndex] = luminance[sourceIndex];
      count += 1;
    }
  }
  return { mask: rotatedMask, color: rotatedColor, luminance: rotatedLuminance, count };
}

function compareSymbols(a, b) {
  let histogramIntersection = 0;
  for (let i = 0; i < a.histogram.length; i += 1) histogramIntersection += Math.min(a.histogram[i], b.histogram[i]);
  let best = 0;
  for (const rotated of b.rotations) {
    let intersection = 0;
    let colorDifference = 0;
    let luminanceDifference = 0;
    for (let i = 0; i < a.mask.length; i += 1) {
      if (!a.mask[i] || !rotated.mask[i]) continue;
      intersection += 1;
      const colorIndex = i * 3;
      colorDifference += Math.abs(a.color[colorIndex] - rotated.color[colorIndex]);
      colorDifference += Math.abs(a.color[colorIndex + 1] - rotated.color[colorIndex + 1]);
      colorDifference += Math.abs(a.color[colorIndex + 2] - rotated.color[colorIndex + 2]);
      luminanceDifference += Math.abs(a.luminance[i] - rotated.luminance[i]);
    }
    if (!intersection) continue;
    const dice = 2 * intersection / Math.max(1, a.foregroundCount + rotated.count);
    const colorSimilarity = clamp(1 - colorDifference / (intersection * 265), 0, 1);
    const luminanceSimilarity = clamp(1 - luminanceDifference / (intersection * 150), 0, 1);
    const coverage = intersection / Math.max(1, Math.min(a.foregroundCount, rotated.count));
    const score = dice * 0.44 + colorSimilarity * 0.29 + luminanceSimilarity * 0.08 + histogramIntersection * 0.11 + coverage * 0.08;
    best = Math.max(best, score);
  }
  return best;
}

function rgbToHsv(r, g, b) {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  let h = 0;
  if (delta) {
    if (max === red) h = ((green - blue) / delta) % 6;
    else if (max === green) h = (blue - red) / delta + 2;
    else h = (red - green) / delta + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  return { h, s: max ? delta / max : 0, v: max };
}

function quadBounds(quad) {
  const xs = quad.map((point) => point.x);
  const ys = quad.map((point) => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function boxIoU(a, b) {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  return intersection / Math.max(1, a.width * a.height + b.width * b.height - intersection);
}

export const geometry = { projectPoint, quadBounds, boxIoU };
