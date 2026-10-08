import { DEBUG, VisionEngine, geometry } from "./vision.js";

const APP_CONFIG = Object.freeze({
  ANALYSIS_INTERVAL_MS: 240,
  MATCH_CONFIRMATIONS: 2,
  MATCH_HOLD_MS: 700,
  TRACK_DISTANCE_RATIO: 0.085,
  BOX_SMOOTHING: 0.56,
  CARD_REPLACEMENT_HISTOGRAM_SIMILARITY: 0.58,
  CAMERA_START_TIMEOUT_MS: 10000
});

const video = document.querySelector("#camera");
const overlay = document.querySelector("#overlay");
const overlayContext = overlay.getContext("2d");
const status = document.querySelector("#status");
const retryButton = document.querySelector("#retry");
const errorPanel = document.querySelector("#error");
const errorMessage = document.querySelector("#error-message");

const vision = new VisionEngine();
const tracker = new MatchTracker(APP_CONFIG);
let stream = null;
let analysisTimer = 0;
let processing = false;
let cameraState = "idle";
let lastResult = null;
let lastAnalysisStarted = 0;
let analysesInWindow = 0;
let analysisRate = 0;

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timer));
}

async function requestCamera() {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: "environment" } }
    });
  } catch (error) {
    if (!["OverconstrainedError", "NotFoundError", "TypeError"].includes(error?.name)) throw error;
    return navigator.mediaDevices.getUserMedia({ audio: false, video: true });
  }
}

async function waitForVideoReady() {
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0 && video.videoHeight > 0) return;
  await new Promise((resolve, reject) => {
    const started = performance.now();
    const check = () => {
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0 && video.videoHeight > 0) return resolve();
      if (performance.now() - started >= APP_CONFIG.CAMERA_START_TIMEOUT_MS) return reject(new Error("Camera stream did not become ready in time."));
      window.setTimeout(check, 80);
    };
    check();
  });
}

async function startCamera() {
  if (cameraState === "starting" || cameraState === "running") return;
  clearError();
  retryButton.hidden = true;
  cameraState = "starting";
  setStatus("Requesting camera…", "starting");

  if (!window.isSecureContext) {
    cameraState = "error";
    showError("Camera requires a secure HTTPS connection.", true);
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    cameraState = "error";
    showError("This browser does not provide camera access. Open this HTTPS site in Safari.", true);
    return;
  }

  try {
    stopCamera(false);
    setStatus("Waiting for permission…", "starting");
    stream = await withTimeout(requestCamera(), APP_CONFIG.CAMERA_START_TIMEOUT_MS, "Camera permission request timed out.");
    if (!stream?.getVideoTracks().length) throw new Error("No video track was returned.");

    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.srcObject = stream;
    setStatus("Starting video…", "starting");
    await withTimeout(video.play(), APP_CONFIG.CAMERA_START_TIMEOUT_MS, "Video playback did not start in time.");
    await waitForVideoReady();

    await tuneCamera(stream.getVideoTracks()[0]);
    resizeOverlay();
    tracker.clear();
    cameraState = "running";
    setStatus("Searching…", "searching");
    scheduleAnalysis(80);
  } catch (error) {
    cameraState = "error";
    const name = error?.name || "CameraError";
    let message;
    if (name === "NotAllowedError" || name === "SecurityError") {
      message = "Camera access was denied. Allow Camera for this website in Safari, then tap Start camera again.";
    } else if (name === "NotFoundError") {
      message = "No camera was found on this device.";
    } else if (name === "NotReadableError" || name === "AbortError") {
      message = "The camera is busy or unavailable. Close other camera apps and try again.";
    } else {
      message = `${error?.message || "The camera could not be started."} (${name})`;
    }
    showError(message, true);
  }
}

function stopCamera(resetState = true) {
  window.clearTimeout(analysisTimer);
  analysisTimer = 0;
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
    stream = null;
  }
  video.pause();
  video.srcObject = null;
  if (resetState) cameraState = "idle";
}

async function tuneCamera(track) {
  try {
    const capabilities = track.getCapabilities?.();
    if (capabilities?.focusMode?.includes("continuous")) {
      await track.applyConstraints({ advanced: [{ focusMode: "continuous" }] });
    }
  } catch {
    // Optional enhancement; unsupported on some iOS versions.
  }
}

function scheduleAnalysis(delay = APP_CONFIG.ANALYSIS_INTERVAL_MS) {
  window.clearTimeout(analysisTimer);
  if (!stream || cameraState !== "running" || document.hidden) return;
  analysisTimer = window.setTimeout(runAnalysis, delay);
}

function runAnalysis() {
  if (processing || !stream || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight) {
    scheduleAnalysis(80);
    return;
  }
  processing = true;
  const startedAt = performance.now();
  try {
    const result = vision.analyze(video, overlay.clientWidth, overlay.clientHeight);
    if (result) {
      lastResult = result;
      tracker.update(result, performance.now());
      updateStatus(result);
      drawOverlay();
      updateAnalysisRate();
    }
  } catch (error) {
    if (DEBUG) console.error("Vision analysis failed", error);
    setStatus("Analyzing…", "analyzing");
  } finally {
    processing = false;
    const elapsed = performance.now() - startedAt;
    scheduleAnalysis(Math.max(16, APP_CONFIG.ANALYSIS_INTERVAL_MS - elapsed));
  }
}

function updateAnalysisRate() {
  const now = performance.now();
  if (!lastAnalysisStarted) lastAnalysisStarted = now;
  analysesInWindow += 1;
  const elapsed = now - lastAnalysisStarted;
  if (elapsed >= 1500) {
    analysisRate = analysesInWindow * 1000 / elapsed;
    analysesInWindow = 0;
    lastAnalysisStarted = now;
  }
}

function updateStatus(result) {
  if (tracker.visible(performance.now()).length) setStatus("Match", "match");
  else if (result.cards.length < 2) setStatus("Searching…", "searching");
  else setStatus("Analyzing…", "analyzing");
}

function setStatus(text, state) {
  if (status.textContent !== text) status.textContent = text;
  status.dataset.state = state;
}

function resizeOverlay() {
  const width = overlay.clientWidth;
  const height = overlay.clientHeight;
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 3);
  const targetWidth = Math.round(width * pixelRatio);
  const targetHeight = Math.round(height * pixelRatio);
  const resized = overlay.width !== targetWidth || overlay.height !== targetHeight;
  if (resized) {
    overlay.width = targetWidth;
    overlay.height = targetHeight;
  }
  overlayContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  if (resized) tracker.clear();
  drawOverlay();
}

function drawOverlay() {
  const width = overlay.clientWidth;
  const height = overlay.clientHeight;
  overlayContext.clearRect(0, 0, width, height);
  if (!lastResult) return;
  for (const match of tracker.visible(performance.now())) {
    drawMatchQuad(match.aQuad, match.frame);
    drawMatchQuad(match.bQuad, match.frame);
  }
  if (DEBUG) drawDebug(lastResult);
}

function drawMatchQuad(quad, frame) {
  const points = quad.map((point) => analysisPointToDisplay(point, frame));
  overlayContext.lineJoin = "round";
  overlayContext.lineCap = "round";
  overlayContext.beginPath();
  overlayContext.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i += 1) overlayContext.lineTo(points[i].x, points[i].y);
  overlayContext.closePath();
  overlayContext.strokeStyle = "rgba(0, 0, 0, .82)";
  overlayContext.lineWidth = 10;
  overlayContext.stroke();
  overlayContext.strokeStyle = "#ff182b";
  overlayContext.lineWidth = 6;
  overlayContext.stroke();
}

function analysisPointToDisplay(point, frame) {
  const videoX = frame.sourceRect.x + point.x * frame.sourceRect.width / frame.width;
  const videoY = frame.sourceRect.y + point.y * frame.sourceRect.height / frame.height;
  const cssWidth = overlay.clientWidth;
  const cssHeight = overlay.clientHeight;
  const coverScale = Math.max(cssWidth / frame.videoWidth, cssHeight / frame.videoHeight);
  const offsetX = (cssWidth - frame.videoWidth * coverScale) * 0.5;
  const offsetY = (cssHeight - frame.videoHeight * coverScale) * 0.5;
  return { x: offsetX + videoX * coverScale, y: offsetY + videoY * coverScale };
}

function drawDebug(result) {
  const drawPolygon = (quad, color, width = 2) => {
    const points = quad.map((point) => analysisPointToDisplay(point, result.frame));
    overlayContext.beginPath();
    overlayContext.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) overlayContext.lineTo(points[i].x, points[i].y);
    overlayContext.closePath();
    overlayContext.strokeStyle = color;
    overlayContext.lineWidth = width;
    overlayContext.stroke();
  };
  for (const candidate of result.candidates) drawPolygon(candidate.quad, "rgba(255, 210, 0, .55)", 1);
  for (const card of result.cards) {
    drawPolygon(card.quad, "#21e6ff", 2);
    if (!card.transform) continue;
    for (const symbol of card.symbols || []) {
      const box = symbol.box;
      const size = vision.config.CARD_NORMAL_SIZE;
      drawPolygon([
        geometry.projectPoint(card.transform, box.x / size, box.y / size),
        geometry.projectPoint(card.transform, (box.x + box.width) / size, box.y / size),
        geometry.projectPoint(card.transform, (box.x + box.width) / size, (box.y + box.height) / size),
        geometry.projectPoint(card.transform, box.x / size, (box.y + box.height) / size)
      ], "rgba(45, 255, 105, .72)", 1);
    }
  }
  const debug = result.debug;
  const lines = [
    `${debug.processingMs.toFixed(0)} ms · ${analysisRate.toFixed(1)} Hz`,
    `candidates ${debug.candidateCount} · cards ${debug.cardCount}`,
    `symbols ${debug.symbolCounts.join(" / ") || "—"}`,
    `best ${debug.bestScore.toFixed(3)} · second ${debug.secondScore.toFixed(3)} · margin ${debug.margin.toFixed(3)}`
  ];
  overlayContext.font = "12px ui-monospace, monospace";
  overlayContext.textBaseline = "top";
  const panelWidth = Math.max(...lines.map((line) => overlayContext.measureText(line).width)) + 16;
  overlayContext.fillStyle = "rgba(0, 0, 0, .72)";
  overlayContext.fillRect(8, overlay.clientHeight - 76, panelWidth, 68);
  overlayContext.fillStyle = "#fff";
  lines.forEach((line, index) => overlayContext.fillText(line, 16, overlay.clientHeight - 70 + index * 15));
}

function showError(message, retryable) {
  stopCamera(false);
  status.hidden = true;
  errorMessage.textContent = message;
  errorPanel.hidden = false;
  retryButton.hidden = !retryable;
}

function clearError() {
  status.hidden = false;
  errorPanel.hidden = true;
  errorMessage.textContent = "";
}

class MatchTracker {
  constructor(config) { this.config = config; this.tracks = []; this.previousCards = null; }
  clear() { this.tracks = []; this.previousCards = null; }
  update(result, now) {
    const reliableCards = result.cards.length === 2 && result.cards.every((card) => card.plausible);
    if (reliableCards && this.previousCards && cardsWereReplaced(this.previousCards, result.cards, result.frame)) this.tracks = [];
    if (reliableCards) this.previousCards = result.cards.map(cardSnapshot);
    const unmatchedTracks = new Set(this.tracks);
    for (const match of result.matches) {
      let closest = null;
      let closestDistance = Infinity;
      for (const track of unmatchedTracks) {
        const distance = matchDistance(track, match, result.frame);
        if (distance < closestDistance) { closest = track; closestDistance = distance; }
      }
      if (closest && closestDistance <= this.config.TRACK_DISTANCE_RATIO) {
        const direct = quadCenterDistance(closest.aQuad, match.aQuad) + quadCenterDistance(closest.bQuad, match.bQuad);
        const swapped = quadCenterDistance(closest.aQuad, match.bQuad) + quadCenterDistance(closest.bQuad, match.aQuad);
        const alignedA = swapped < direct ? match.bQuad : match.aQuad;
        const alignedB = swapped < direct ? match.aQuad : match.bQuad;
        closest.aQuad = smoothQuad(closest.aQuad, alignedA, this.config.BOX_SMOOTHING);
        closest.bQuad = smoothQuad(closest.bQuad, alignedB, this.config.BOX_SMOOTHING);
        closest.frame = result.frame;
        closest.score = match.score;
        closest.hits += 1;
        closest.lastSeen = now;
        if (closest.hits >= this.config.MATCH_CONFIRMATIONS) closest.confirmed = true;
        unmatchedTracks.delete(closest);
      } else {
        this.tracks.push({ aQuad: match.aQuad, bQuad: match.bQuad, frame: result.frame, score: match.score, hits: 1, confirmed: this.config.MATCH_CONFIRMATIONS <= 1, lastSeen: now });
      }
    }
    for (const track of unmatchedTracks) if (!track.confirmed) track.hits = Math.max(0, track.hits - 1);
    this.tracks = this.tracks.filter((track) => now - track.lastSeen <= this.config.MATCH_HOLD_MS && (track.confirmed || track.hits > 0));
  }
  visible(now) { return this.tracks.filter((track) => track.confirmed && now - track.lastSeen <= this.config.MATCH_HOLD_MS); }
}

function matchDistance(track, match, frame) {
  const diagonal = Math.hypot(frame.width, frame.height);
  const direct = quadCenterDistance(track.aQuad, match.aQuad) + quadCenterDistance(track.bQuad, match.bQuad);
  const swapped = quadCenterDistance(track.aQuad, match.bQuad) + quadCenterDistance(track.bQuad, match.aQuad);
  return Math.min(direct, swapped) / (2 * diagonal);
}
function quadCenterDistance(a, b) {
  const center = (quad) => quad.reduce((sum, point) => ({ x: sum.x + point.x / 4, y: sum.y + point.y / 4 }), { x: 0, y: 0 });
  const ca = center(a); const cb = center(b);
  return Math.hypot(ca.x - cb.x, ca.y - cb.y);
}
function smoothQuad(previous, current, currentWeight) {
  return previous.map((point, index) => ({ x: point.x * (1 - currentWeight) + current[index].x * currentWeight, y: point.y * (1 - currentWeight) + current[index].y * currentWeight }));
}
function cardSnapshot(card) {
  const histogram = new Float32Array(12);
  for (const symbol of card.symbols || []) for (let i = 0; i < histogram.length; i += 1) histogram[i] += symbol.histogram[i];
  const total = histogram.reduce((sum, value) => sum + value, 0) || 1;
  for (let i = 0; i < histogram.length; i += 1) histogram[i] /= total;
  return { box: card.box, histogram };
}
function cardsWereReplaced(previous, currentCards, frame) {
  const current = currentCards.map(cardSnapshot);
  const diagonal = Math.hypot(frame.width, frame.height);
  const directPosition = boxCenterDistance(previous[0].box, current[0].box) + boxCenterDistance(previous[1].box, current[1].box);
  const swappedPosition = boxCenterDistance(previous[0].box, current[1].box) + boxCenterDistance(previous[1].box, current[0].box);
  const swapped = swappedPosition < directPosition;
  const aligned = swapped ? [current[1], current[0]] : current;
  const positionChange = Math.min(directPosition, swappedPosition) / (2 * diagonal);
  if (positionChange > 0.2) return true;
  const similarityA = histogramIntersection(previous[0].histogram, aligned[0].histogram);
  const similarityB = histogramIntersection(previous[1].histogram, aligned[1].histogram);
  return similarityA < APP_CONFIG.CARD_REPLACEMENT_HISTOGRAM_SIMILARITY && similarityB < APP_CONFIG.CARD_REPLACEMENT_HISTOGRAM_SIMILARITY;
}
function histogramIntersection(a, b) {
  let similarity = 0;
  for (let i = 0; i < a.length; i += 1) similarity += Math.min(a[i], b[i]);
  return similarity;
}
function boxCenterDistance(a, b) {
  return Math.hypot((a.x + a.width / 2) - (b.x + b.width / 2), (a.y + a.height / 2) - (b.y + b.height / 2));
}

retryButton.addEventListener("click", startCamera);
window.addEventListener("resize", resizeOverlay, { passive: true });
window.addEventListener("orientationchange", () => window.setTimeout(resizeOverlay, 180), { passive: true });
document.addEventListener("visibilitychange", () => {
  if (document.hidden) window.clearTimeout(analysisTimer);
  else if (stream && cameraState === "running") { resizeOverlay(); scheduleAnalysis(100); }
});
window.addEventListener("pagehide", () => stopCamera());
window.addEventListener("pageshow", (event) => {
  if (event.persisted && !stream) {
    cameraState = "idle";
    retryButton.hidden = false;
    setStatus("Ready", "idle");
  }
});
window.addEventListener("error", (event) => { if (DEBUG) console.error("App error", event.error || event.message); });
window.addEventListener("unhandledrejection", (event) => { if (DEBUG) console.error("Unhandled rejection", event.reason); });

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" }).then((registration) => registration.update()).catch(() => {}));
}

resizeOverlay();
setStatus("Tap Start camera", "idle");
retryButton.hidden = false;

if (DEBUG) window.__DOBBLE_DEBUG__ = { vision, tracker, geometry };
