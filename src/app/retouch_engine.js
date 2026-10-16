// PixelShop — Studio Retouch, Selection & Layer Engine
// Designed by Dave Groennesby — https://collabs-photography.com/software

(function () {
  'use strict';

  const displayCanvas = document.getElementById('displayCanvas');
  const displayCtx = displayCanvas.getContext('2d', { willReadFrequently: true });
  const overlayCanvas = document.getElementById('overlayCanvas');
  const overlayCtx = overlayCanvas.getContext('2d');
  const histogramCanvas = document.getElementById('histogramCanvas');
  const histCtx = histogramCanvas.getContext('2d');
  const canvasStage = document.getElementById('canvasStage');
  const viewport = document.getElementById('viewport');
  const brushCursor = document.getElementById('brushCursor');
  const statusToast = document.getElementById('statusToast');

  // Background Web Worker for non-blocking Precision Matting & 16-Bit High-Frequency Separation
  let worker = null;
  let workerReqId = 1;
  const pendingWorkerTasks = new Map();

  function initWorker() {
    try {
      worker = new Worker('worker.js');
      worker.onmessage = (e) => {
        const { id, ok, result, error } = e.data;
        const handler = pendingWorkerTasks.get(id);
        if (handler) {
          pendingWorkerTasks.delete(id);
          if (ok) handler.resolve(result);
          else handler.reject(new Error(error));
        }
      };
    } catch (err) {
      console.error('Worker fallback active:', err);
    }
  }
  initWorker();

  function runWorkerTask(task, payload, transferList = []) {
    return new Promise((resolve, reject) => {
      if (!worker) {
        reject(new Error('Background worker unavailable'));
        return;
      }
      const id = workerReqId++;
      pendingWorkerTasks.set(id, { resolve, reject });
      worker.postMessage({ id, task, payload }, transferList);
    });
  }

  // Document & Layer State
  const state = {
    docTitle: 'Farida studio-11.jpg',
    width: 1200,
    height: 800,
    zoom: 1.0,
    panX: 0,
    panY: 0,
    activeTool: 'heal',
    brushSize: 48,
    brushHardness: 0.25,
    brushStrength: 0.65,
    wandTolerance: 32,
    fgColor: '#FFE400',
    bgColor: '#000000',
    layers: [],
    activeLayerIndex: 0,
    originalBasePixels: null,
    compareHoldOriginal: false,

    // Selection Mask (Uint8ClampedArray width*height, 0..255)
    selectionMask: null,
    hasSelection: false,
    showYellowMatteOverlay: false,
    marchingAntsOffset: 0,

    // Clone Stamp source anchor
    cloneSource: null,
    cloneOffset: null,

    // Interactive Mouse State
    isPointerDown: false,
    isSpacePanning: false,
    lastDocPt: null,
    lastClientPt: null,
    marqueeStart: null,
    lassoPoints: [],
    cropRect: null,

    // History Stack (up to 18 full layer-stack snapshots)
    history: [],
    historyIndex: -1
  };

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  function showToast(msg, duration = 2200) {
    statusToast.textContent = msg;
    statusToast.style.display = 'block';
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => {
      statusToast.style.display = 'none';
    }, duration);
  }

  function createLayer(name, width, height, pixels = null, blendMode = 'normal', opacity = 1.0) {
    const data = pixels ? new Uint8ClampedArray(pixels) : new Uint8ClampedArray(width * height * 4);
    return {
      id: 'layer_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      name,
      visible: true,
      blendMode,
      opacity,
      pixels: data,
      mask: null, // Optional Uint8ClampedArray(width*height) layer mask
      adjustments: {
        exposure: 0,
        contrast: 0,
        highlights: 0,
        shadows: 0,
        temp: 0,
        saturation: 0
      }
    };
  }

  // Push current state to History Panel
  function pushHistory(actionLabel) {
    const clonedLayers = state.layers.map((l) => ({
      id: l.id,
      name: l.name,
      visible: l.visible,
      blendMode: l.blendMode,
      opacity: l.opacity,
      pixels: new Uint8ClampedArray(l.pixels),
      mask: l.mask ? new Uint8ClampedArray(l.mask) : null,
      adjustments: { ...l.adjustments }
    }));

    // Trim future redo steps
    if (state.historyIndex < state.history.length - 1) {
      state.history = state.history.slice(0, state.historyIndex + 1);
    }

    state.history.push({
      label: actionLabel,
      layers: clonedLayers,
      activeLayerIndex: state.activeLayerIndex,
      selectionMask: state.selectionMask ? new Uint8ClampedArray(state.selectionMask) : null,
      hasSelection: state.hasSelection,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    });

    if (state.history.length > 16) {
      state.history.shift();
    }
    state.historyIndex = state.history.length - 1;
    renderHistoryPanel();
  }

  function restoreHistoryStep(index) {
    if (index < 0 || index >= state.history.length) return;
    state.historyIndex = index;
    const snap = state.history[index];
    state.layers = snap.layers.map((l) => ({
      ...l,
      pixels: new Uint8ClampedArray(l.pixels),
      mask: l.mask ? new Uint8ClampedArray(l.mask) : null,
      adjustments: { ...l.adjustments }
    }));
    state.activeLayerIndex = clamp(snap.activeLayerIndex, 0, state.layers.length - 1);
    state.selectionMask = snap.selectionMask ? new Uint8ClampedArray(snap.selectionMask) : null;
    state.hasSelection = snap.hasSelection;

    syncUIWithActiveLayer();
    compositeLayers();
    renderLayersPanel();
    renderHistoryPanel();
    updateStatusBar();
  }

  // Evaluate per-layer non-destructive adjustments on a pixel
  function applyLayerAdjustmentsToPixel(r, g, b, adj) {
    if (
      adj.exposure === 0 &&
      adj.contrast === 0 &&
      adj.highlights === 0 &&
      adj.shadows === 0 &&
      adj.temp === 0 &&
      adj.saturation === 0
    ) {
      return [r, g, b];
    }

    // 1. Exposure
    const expGain = Math.pow(2, adj.exposure / 55);
    r *= expGain;
    g *= expGain;
    b *= expGain;

    // 2. Shadows & Highlights
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    if (adj.shadows !== 0) {
      const sWeight = Math.pow(1.0 - clamp(lum, 0, 1), 1.6);
      const delta = adj.shadows * 1.15 * sWeight;
      r += delta; g += delta; b += delta;
    }
    if (adj.highlights !== 0) {
      const hWeight = Math.pow(clamp(lum, 0, 1), 1.6);
      const delta = adj.highlights * 1.15 * hWeight;
      r += delta; g += delta; b += delta;
    }

    // 3. Contrast
    if (adj.contrast !== 0) {
      const factor = (259 * (adj.contrast * 1.4 + 255)) / (255 * (259 - adj.contrast * 1.4));
      r = factor * (r - 128) + 128;
      g = factor * (g - 128) + 128;
      b = factor * (b - 128) + 128;
    }

    // 4. Color Temperature (Warm Golden vs Cool Blue)
    if (adj.temp !== 0) {
      r += adj.temp * 0.65;
      g += adj.temp * 0.12;
      b -= adj.temp * 0.65;
    }

    // 5. Vibrance / Saturation
    if (adj.saturation !== 0) {
      const gray = 0.299 * r + 0.587 * g + 0.114 * b;
      const satFactor = 1.0 + adj.saturation / 85;
      r = gray + (r - gray) * satFactor;
      g = gray + (g - gray) * satFactor;
      b = gray + (b - gray) * satFactor;
    }

    return [
      clamp(Math.round(r), 0, 255),
      clamp(Math.round(g), 0, 255),
      clamp(Math.round(b), 0, 255)
    ];
  }

  // Blend single channel value (base B, active A, both 0..255)
  // Includes exact Linear Light math for 16-Bit High-Frequency Separation:
  // Linear Light: B + 2 * (A - 128)
  function blendChannel(B, A, mode) {
    switch (mode) {
      case 'linearLight':
        return clamp(B + 2 * (A - 128), 0, 255);
      case 'multiply':
        return (B * A) / 255;
      case 'screen':
        return 255 - ((255 - B) * (255 - A)) / 255;
      case 'overlay':
        return B < 128 ? (2 * B * A) / 255 : 255 - (2 * (255 - B) * (255 - A)) / 255;
      case 'softLight': {
        const b = B / 255, a = A / 255;
        const res = a < 0.5
          ? b - (1 - 2 * a) * b * (1 - b)
          : b + (2 * a - 1) * ((b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b)) - b);
        return clamp(Math.round(res * 255), 0, 255);
      }
      default:
        return A;
    }
  }

  // Composite all visible layers onto displayCanvas
  function compositeLayers() {
    const w = state.width;
    const h = state.height;
    const outImg = displayCtx.createImageData(w, h);
    const out = outImg.data;

    if (state.compareHoldOriginal && state.originalBasePixels) {
      out.set(state.originalBasePixels);
      displayCtx.putImageData(outImg, 0, 0);
      updateHistogram(out);
      return;
    }

    const total = w * h;
    for (let li = 0; li < state.layers.length; li++) {
      const layer = state.layers[li];
      if (!layer.visible || layer.opacity <= 0.001) continue;

      const src = layer.pixels;
      const mask = layer.mask;
      const mode = layer.blendMode;
      const layerOpac = layer.opacity;
      const adj = layer.adjustments;
      const hasAdj =
        adj.exposure !== 0 ||
        adj.contrast !== 0 ||
        adj.highlights !== 0 ||
        adj.shadows !== 0 ||
        adj.temp !== 0 ||
        adj.saturation !== 0;

      for (let i = 0; i < total; i++) {
        const idx = i * 4;
        let sa = (src[idx + 3] / 255) * layerOpac;
        if (mask) {
          sa *= mask[i] / 255;
        }
        if (sa <= 0.001) continue;

        let sr = src[idx];
        let sg = src[idx + 1];
        let sb = src[idx + 2];

        if (hasAdj) {
          [sr, sg, sb] = applyLayerAdjustmentsToPixel(sr, sg, sb, adj);
        }

        const dr = out[idx];
        const dg = out[idx + 1];
        const db = out[idx + 2];
        const da = out[idx + 3] / 255;

        if (da <= 0.001) {
          out[idx] = sr;
          out[idx + 1] = sg;
          out[idx + 2] = sb;
          out[idx + 3] = Math.round(sa * 255);
        } else {
          let br = sr, bg = sg, bb = sb;
          if (mode !== 'normal') {
            br = blendChannel(dr, sr, mode);
            bg = blendChannel(dg, sg, mode);
            bb = blendChannel(db, sb, mode);
          }
          const invSa = 1.0 - sa;
          out[idx]     = clamp(Math.round(br * sa + dr * invSa), 0, 255);
          out[idx + 1] = clamp(Math.round(bg * sa + dg * invSa), 0, 255);
          out[idx + 2] = clamp(Math.round(bb * sa + db * invSa), 0, 255);
          out[idx + 3] = clamp(Math.round((sa + da * invSa) * 255), 0, 255);
        }
      }
    }

    displayCtx.putImageData(outImg, 0, 0);
    updateHistogram(out);
    drawOverlayCanvas();
  }

  // Render RGB + Luminance Histogram with #FFE400 highlight curve
  function updateHistogram(rgba) {
    const rBins = new Uint32Array(256);
    const gBins = new Uint32Array(256);
    const bBins = new Uint32Array(256);
    const lBins = new Uint32Array(256);

    const step = Math.max(4, Math.floor(rgba.length / (4 * 12000)) * 4);
    for (let i = 0; i < rgba.length; i += step) {
      if (rgba[i + 3] < 16) continue;
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      const l = clamp(Math.round(0.299 * r + 0.587 * g + 0.114 * b), 0, 255);
      rBins[r]++;
      gBins[g]++;
      bBins[b]++;
      lBins[l]++;
    }

    let maxCount = 1;
    for (let i = 2; i < 254; i++) {
      if (lBins[i] > maxCount) maxCount = lBins[i];
    }

    const cw = histogramCanvas.width;
    const ch = histogramCanvas.height;
    histCtx.clearRect(0, 0, cw, ch);

    // Subtle grid lines
    histCtx.strokeStyle = '#1B1B22';
    histCtx.lineWidth = 1;
    for (let g = 1; g <= 3; g++) {
      const gx = (cw / 4) * g;
      histCtx.beginPath();
      histCtx.moveTo(gx, 0);
      histCtx.lineTo(gx, ch);
      histCtx.stroke();
    }

    const drawChannelCurve = (bins, strokeColor, fillColor) => {
      histCtx.beginPath();
      histCtx.moveTo(0, ch);
      for (let i = 0; i < 256; i++) {
        const x = (i / 255) * cw;
        const hRatio = Math.min(1, bins[i] / maxCount);
        const y = ch - hRatio * (ch - 6);
        histCtx.lineTo(x, y);
      }
      histCtx.lineTo(cw, ch);
      histCtx.closePath();
      histCtx.fillStyle = fillColor;
      histCtx.fill();
      histCtx.strokeStyle = strokeColor;
      histCtx.lineWidth = 1.2;
      histCtx.stroke();
    };

    drawChannelCurve(rBins, 'rgba(255,90,90,0.65)', 'rgba(255,90,90,0.12)');
    drawChannelCurve(gBins, 'rgba(90,235,130,0.65)', 'rgba(90,235,130,0.12)');
    drawChannelCurve(bBins, 'rgba(90,165,255,0.65)', 'rgba(90,165,255,0.12)');
    drawChannelCurve(lBins, '#FFE400', 'rgba(255, 228, 0, 0.22)');
  }

  // Draw Selection Marching Ants (#FFE400 + Black) & Interactive Marquee/Lasso/Crop Overlays
  function drawOverlayCanvas() {
    const w = state.width;
    const h = state.height;
    overlayCtx.clearRect(0, 0, w, h);

    // 1. Optional Yellow Selection Matte Rubylith Preview (Quick Mask 'Q')
    if (state.hasSelection && state.selectionMask && state.showYellowMatteOverlay) {
      const maskImg = overlayCtx.createImageData(w, h);
      const md = maskImg.data;
      const sm = state.selectionMask;
      for (let i = 0; i < sm.length; i++) {
        const unselected = 255 - sm[i];
        if (unselected > 10) {
          const idx = i * 4;
          md[idx] = 255;
          md[idx + 1] = 228;
          md[idx + 2] = 0;
          md[idx + 3] = Math.round(unselected * 0.42);
        }
      }
      overlayCtx.putImageData(maskImg, 0, 0);
    }

    // 2. Selection Boundary Contour in #FFE400 Marching Ants
    if (state.hasSelection && state.selectionMask) {
      const sm = state.selectionMask;
      overlayCtx.fillStyle = '#FFE400';
      const phase = Math.floor(state.marchingAntsOffset) % 8;
      const step = w > 1600 ? 2 : 1;

      for (let y = 1; y < h - 1; y += step) {
        const row = y * w;
        for (let x = 1; x < w - 1; x += step) {
          const idx = row + x;
          const inside = sm[idx] >= 128;
          if (!inside) continue;
          if (
            sm[idx - 1] < 128 ||
            sm[idx + 1] < 128 ||
            sm[idx - w] < 128 ||
            sm[idx + w] < 128
          ) {
            if (((x + y + phase) % 8) < 5) {
              overlayCtx.fillStyle = '#FFE400';
            } else {
              overlayCtx.fillStyle = '#000000';
            }
            overlayCtx.fillRect(x, y, step + 0.6, step + 0.6);
          }
        }
      }
    }

    // 3. Active Marquee / Crop Drag Box
    if (state.marqueeStart && state.lastDocPt && (state.activeTool === 'marquee' || state.activeTool === 'crop')) {
      const x0 = Math.min(state.marqueeStart.x, state.lastDocPt.x);
      const y0 = Math.min(state.marqueeStart.y, state.lastDocPt.y);
      const bw = Math.abs(state.lastDocPt.x - state.marqueeStart.x);
      const bh = Math.abs(state.lastDocPt.y - state.marqueeStart.y);

      overlayCtx.save();
      overlayCtx.strokeStyle = '#FFE400';
      overlayCtx.lineWidth = 1.5 / state.zoom;
      overlayCtx.setLineDash([6 / state.zoom, 4 / state.zoom]);
      overlayCtx.strokeRect(x0, y0, bw, bh);
      overlayCtx.restore();
    }

    // 4. Active Freehand Lasso Path
    if (state.lassoPoints.length > 1 && state.activeTool === 'lasso') {
      overlayCtx.save();
      overlayCtx.strokeStyle = '#FFE400';
      overlayCtx.lineWidth = 1.8 / state.zoom;
      overlayCtx.beginPath();
      overlayCtx.moveTo(state.lassoPoints[0].x, state.lassoPoints[0].y);
      for (let i = 1; i < state.lassoPoints.length; i++) {
        overlayCtx.lineTo(state.lassoPoints[i].x, state.lassoPoints[i].y);
      }
      overlayCtx.stroke();
      overlayCtx.restore();
    }

    // 5. Clone Source Crosshair Indicator
    if (state.cloneSource && state.activeTool === 'clone') {
      overlayCtx.save();
      overlayCtx.strokeStyle = '#FFE400';
      overlayCtx.lineWidth = 1.5 / state.zoom;
      const cx = state.cloneSource.x;
      const cy = state.cloneSource.y;
      const r = 8 / state.zoom;
      overlayCtx.beginPath();
      overlayCtx.arc(cx, cy, r, 0, Math.PI * 2);
      overlayCtx.moveTo(cx - r * 1.4, cy);
      overlayCtx.lineTo(cx + r * 1.4, cy);
      overlayCtx.moveTo(cx, cy - r * 1.4);
      overlayCtx.lineTo(cx, cy + r * 1.4);
      overlayCtx.stroke();
      overlayCtx.restore();
    }
  }

  // Animate Marching Ants smoothly when a selection is active
  setInterval(() => {
    if (state.hasSelection) {
      state.marchingAntsOffset = (state.marchingAntsOffset + 1) % 16;
      drawOverlayCanvas();
    }
  }, 140);

  // Load Image into Document
  function loadImageFromUrl(url, titleName) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      // Cap working resolution to 1600px max dimension for instant 60fps real-time retouching
      const maxDim = 1600;
      let w = img.naturalWidth || img.width;
      let h = img.naturalHeight || img.height;
      if (Math.max(w, h) > maxDim) {
        const s = maxDim / Math.max(w, h);
        w = Math.round(w * s);
        h = Math.round(h * s);
      }

      state.width = w;
      state.height = h;
      state.docTitle = titleName;

      displayCanvas.width = w;
      displayCanvas.height = h;
      overlayCanvas.width = w;
      overlayCanvas.height = h;

      displayCtx.clearRect(0, 0, w, h);
      displayCtx.drawImage(img, 0, 0, w, h);
      const basePixels = displayCtx.getImageData(0, 0, w, h).data;

      state.originalBasePixels = new Uint8ClampedArray(basePixels);
      state.layers = [createLayer('Background', w, h, basePixels, 'normal', 1.0)];
      state.activeLayerIndex = 0;
      state.selectionMask = null;
      state.hasSelection = false;
      state.history = [];
      state.historyIndex = -1;

      fitCanvasToViewport();
      pushHistory('Open Document: ' + titleName);
      syncUIWithActiveLayer();
      compositeLayers();
      renderLayersPanel();
      updateStatusBar();
      showToast(`Loaded ${titleName} (${w}×${h}px)`);
    };
    img.onerror = () => {
      createProceduralPortraitFallback();
    };
    img.src = url;
  }

  function createProceduralPortraitFallback() {
    const w = 1200, h = 800;
    state.width = w;
    state.height = h;
    displayCanvas.width = w;
    displayCanvas.height = h;
    overlayCanvas.width = w;
    overlayCanvas.height = h;

    const grad = displayCtx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#446A92');
    grad.addColorStop(0.45, '#7294B5');
    grad.addColorStop(0.46, '#23252C');
    grad.addColorStop(1, '#14151A');
    displayCtx.fillStyle = grad;
    displayCtx.fillRect(0, 0, w, h);

    // Warm studio subject silhouette
    displayCtx.fillStyle = '#D89E7E';
    displayCtx.beginPath();
    displayCtx.arc(w * 0.5, h * 0.42, 145, 0, Math.PI * 2);
    displayCtx.fill();

    const basePixels = displayCtx.getImageData(0, 0, w, h).data;
    state.originalBasePixels = new Uint8ClampedArray(basePixels);
    state.layers = [createLayer('Background', w, h, basePixels, 'normal', 1.0)];
    state.activeLayerIndex = 0;
    fitCanvasToViewport();
    pushHistory('New Studio Canvas');
    compositeLayers();
    renderLayersPanel();
    updateStatusBar();
  }

  function fitCanvasToViewport() {
    const rect = viewport.getBoundingClientRect();
    const pad = 48;
    const scaleX = (rect.width - pad) / state.width;
    const scaleY = (rect.height - pad) / state.height;
    state.zoom = clamp(Math.min(scaleX, scaleY), 0.15, 3.0);
    state.panX = 0;
    state.panY = 0;
    applyViewportTransform();
  }

  function applyViewportTransform() {
    canvasStage.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
    updateStatusBar();
  }

  function clientToDocCoords(clientX, clientY) {
    const rect = displayCanvas.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * state.width;
    const y = ((clientY - rect.top) / rect.height) * state.height;
    return { x, y };
  }

  // Check if pixel (x,y) is allowed by current selection & layer mask (returns 0..1 weight)
  function getSelectionWeight(x, y) {
    if (!state.hasSelection || !state.selectionMask) return 1.0;
    const ix = clamp(Math.round(x), 0, state.width - 1);
    const iy = clamp(Math.round(y), 0, state.height - 1);
    return state.selectionMask[iy * state.width + ix] / 255;
  }

  // =========================================================================
  // BRUSH & RETOUCHING DAB ENGINE (HEAL, FREQ SMOOTH, CLONE, BRUSH, ERASER, DODGE, BURN, LIQUIFY)
  // =========================================================================
  function applyToolDab(docX, docY, prevDocPt) {
    const layer = state.layers[state.activeLayerIndex];
    if (!layer || !layer.visible) return;

    const w = state.width;
    const h = state.height;
    const pixels = layer.pixels;
    const radius = Math.max(2, state.brushSize * 0.5);
    const rSq = radius * radius;
    const hardness = state.brushHardness;
    const strength = state.brushStrength;

    const minX = clamp(Math.floor(docX - radius), 0, w - 1);
    const maxX = clamp(Math.ceil(docX + radius), 0, w - 1);
    const minY = clamp(Math.floor(docY - radius), 0, h - 1);
    const maxY = clamp(Math.ceil(docY + radius), 0, h - 1);

    const tool = state.activeTool;

    // Precompute neighborhood statistics for Spot Healing & Low-Frequency Skin Smoothing
    let ringMeanR = 128, ringMeanG = 128, ringMeanB = 128;
    if (tool === 'heal' || tool === 'freqsmooth') {
      let sumR = 0, sumG = 0, sumB = 0, count = 0;
      const sampleStep = Math.max(1, Math.floor(radius / 5));
      for (let sy = minY; sy <= maxY; sy += sampleStep) {
        for (let sx = minX; sx <= maxX; sx += sampleStep) {
          const dx = sx - docX;
          const dy = sy - docY;
          const d2 = dx * dx + dy * dy;
          // Sample outer ring for Spot Healing, or full disk for Low-Freq Tone Mixer
          if ((tool === 'heal' && d2 >= rSq * 0.42 && d2 <= rSq) || (tool === 'freqsmooth' && d2 <= rSq)) {
            const idx = (sy * w + sx) * 4;
            sumR += pixels[idx];
            sumG += pixels[idx + 1];
            sumB += pixels[idx + 2];
            count++;
          }
        }
      }
      if (count > 0) {
        ringMeanR = sumR / count;
        ringMeanG = sumG / count;
        ringMeanB = sumB / count;
      }
    }

    // Parse Foreground hex color for standard Paint Brush
    let fgR = 255, fgG = 228, fgB = 0;
    if (tool === 'brush') {
      const hex = state.fgColor.replace('#', '');
      fgR = parseInt(hex.substring(0, 2), 16) || 255;
      fgG = parseInt(hex.substring(2, 4), 16) || 228;
      fgB = parseInt(hex.substring(4, 6), 16) || 0;
    }

    // Liquify Push vector
    let liqDx = 0, liqDy = 0;
    let srcSnapshot = null;
    if (tool === 'liquify' && prevDocPt) {
      liqDx = docX - prevDocPt.x;
      liqDy = docY - prevDocPt.y;
      if (Math.hypot(liqDx, liqDy) < 0.2) return;
      srcSnapshot = new Uint8ClampedArray(pixels);
    }

    for (let y = minY; y <= maxY; y++) {
      const dy = y - docY;
      for (let x = minX; x <= maxX; x++) {
        const dx = x - docX;
        const d2 = dx * dx + dy * dy;
        if (d2 > rSq) continue;

        const selWeight = getSelectionWeight(x, y);
        if (selWeight <= 0.005) continue;

        const distRatio = Math.sqrt(d2) / radius;
        const falloff = distRatio <= hardness
          ? 1.0
          : Math.pow(1.0 - (distRatio - hardness) / Math.max(0.05, 1.0 - hardness), 1.6);

        const alpha = falloff * strength * selWeight;
        if (alpha <= 0.002) continue;

        const idx = (y * w + x) * 4;

        if (tool === 'heal') {
          // Spot Healing: If on High-Frequency Linear Light layer, heal towards neutral 128 gray with micro-grain preservation!
          if (layer.blendMode === 'linearLight') {
            const grain = ((x * 73 + y * 151) % 5) - 2;
            const target = 128 + grain * 0.4;
            pixels[idx]     = clamp(Math.round(pixels[idx]     * (1 - alpha * 0.65) + target * (alpha * 0.65)), 0, 255);
            pixels[idx + 1] = clamp(Math.round(pixels[idx + 1] * (1 - alpha * 0.65) + target * (alpha * 0.65)), 0, 255);
            pixels[idx + 2] = clamp(Math.round(pixels[idx + 2] * (1 - alpha * 0.65) + target * (alpha * 0.65)), 0, 255);
          } else {
            // Normal layer healing: blend surrounding skin ring + preserve local micro-texture
            const blend = alpha * 0.55;
            pixels[idx]     = clamp(Math.round(pixels[idx]     * (1 - blend) + ringMeanR * blend), 0, 255);
            pixels[idx + 1] = clamp(Math.round(pixels[idx + 1] * (1 - blend) + ringMeanG * blend), 0, 255);
            pixels[idx + 2] = clamp(Math.round(pixels[idx + 2] * (1 - blend) + ringMeanB * blend), 0, 255);
          }
        } else if (tool === 'freqsmooth') {
          // Low-Frequency Skin Tone Mixer: Smooths color blotches smoothly
          const blend = alpha * 0.45;
          pixels[idx]     = clamp(Math.round(pixels[idx]     * (1 - blend) + ringMeanR * blend), 0, 255);
          pixels[idx + 1] = clamp(Math.round(pixels[idx + 1] * (1 - blend) + ringMeanG * blend), 0, 255);
          pixels[idx + 2] = clamp(Math.round(pixels[idx + 2] * (1 - blend) + ringMeanB * blend), 0, 255);
        } else if (tool === 'clone') {
          if (!state.cloneOffset) {
            state.cloneSource = { x: clamp(docX - 40, 0, w - 1), y: clamp(docY, 0, h - 1) };
            state.cloneOffset = { dx: state.cloneSource.x - docX, dy: state.cloneSource.y - docY };
          }
          const sx = clamp(Math.round(x + state.cloneOffset.dx), 0, w - 1);
          const sy = clamp(Math.round(y + state.cloneOffset.dy), 0, h - 1);
          const sIdx = (sy * w + sx) * 4;
          const blend = alpha * 0.7;
          pixels[idx]     = clamp(Math.round(pixels[idx]     * (1 - blend) + pixels[sIdx]     * blend), 0, 255);
          pixels[idx + 1] = clamp(Math.round(pixels[idx + 1] * (1 - blend) + pixels[sIdx + 1] * blend), 0, 255);
          pixels[idx + 2] = clamp(Math.round(pixels[idx + 2] * (1 - blend) + pixels[sIdx + 2] * blend), 0, 255);
        } else if (tool === 'brush') {
          const blend = alpha * 0.75;
          pixels[idx]     = clamp(Math.round(pixels[idx]     * (1 - blend) + fgR * blend), 0, 255);
          pixels[idx + 1] = clamp(Math.round(pixels[idx + 1] * (1 - blend) + fgG * blend), 0, 255);
          pixels[idx + 2] = clamp(Math.round(pixels[idx + 2] * (1 - blend) + fgB * blend), 0, 255);
          pixels[idx + 3] = clamp(Math.round(pixels[idx + 3] + (255 - pixels[idx + 3]) * blend), 0, 255);
        } else if (tool === 'eraser') {
          if (layer.mask) {
            const mIdx = y * w + x;
            layer.mask[mIdx] = clamp(Math.round(layer.mask[mIdx] * (1 - alpha * 0.8)), 0, 255);
          } else {
            pixels[idx + 3] = clamp(Math.round(pixels[idx + 3] * (1 - alpha * 0.8)), 0, 255);
          }
        } else if (tool === 'dodge') {
          const lift = 1.0 + alpha * 0.16;
          pixels[idx]     = clamp(Math.round(pixels[idx]     * lift + 3 * alpha), 0, 255);
          pixels[idx + 1] = clamp(Math.round(pixels[idx + 1] * lift + 3 * alpha), 0, 255);
          pixels[idx + 2] = clamp(Math.round(pixels[idx + 2] * lift + 3 * alpha), 0, 255);
        } else if (tool === 'burn') {
          const darken = 1.0 - alpha * 0.16;
          pixels[idx]     = clamp(Math.round(pixels[idx]     * darken), 0, 255);
          pixels[idx + 1] = clamp(Math.round(pixels[idx + 1] * darken), 0, 255);
          pixels[idx + 2] = clamp(Math.round(pixels[idx + 2] * darken), 0, 255);
        } else if (tool === 'liquify' && srcSnapshot) {
          const sx = clamp(Math.round(x - liqDx * falloff * strength * 0.85), 0, w - 1);
          const sy = clamp(Math.round(y - liqDy * falloff * strength * 0.85), 0, h - 1);
          const sIdx = (sy * w + sx) * 4;
          pixels[idx]     = srcSnapshot[sIdx];
          pixels[idx + 1] = srcSnapshot[sIdx + 1];
          pixels[idx + 2] = srcSnapshot[sIdx + 2];
        }
      }
    }
  }

  // =========================================================================
  // SELECT SUBJECT, SELECT SKY, SELECT BACKGROUND COMMANDS
  // =========================================================================
  async function runAISelection(mode) {
    const layer = state.layers[state.activeLayerIndex] || state.layers[0];
    if (!layer) return;

    const labelMap = {
      subject: 'Select Subject',
      sky: 'Select Sky',
      background: 'Select Background'
    };
    showToast(`Running ${labelMap[mode]}...`, 4000);

    try {
      const copyRgba = new Uint8ClampedArray(layer.pixels);
      const res = await runWorkerTask(
        'ai_select',
        {
          rgba: copyRgba,
          width: state.width,
          height: state.height,
          mode,
          feather: 1.5
        },
        [copyRgba.buffer]
      );

      state.selectionMask = res.mask;
      state.hasSelection = res.selectedCount > 0;
      const pct = ((res.selectedCount / res.totalPixels) * 100).toFixed(1);

      pushHistory(`${labelMap[mode]} (${pct}%)`);
      drawOverlayCanvas();
      updateStatusBar();
      showToast(`${labelMap[mode]} Complete — ${pct}% matte selected`);
    } catch (err) {
      showToast(`Selection error: ${err.message}`);
    }
  }

  // =========================================================================
  // 16-BIT HIGH-FREQUENCY SEPARATION ACTION (EXACT LINEAR LIGHT PIPELINE)
  // =========================================================================
  async function runHighFrequencySeparation(radius = 9.0) {
    const baseLayer = state.layers[state.activeLayerIndex] || state.layers[0];
    if (!baseLayer) return;

    showToast(`Running 16-Bit High-Frequency Separation (Radius ${radius}px)...`, 5000);

    try {
      const srcCopy = new Uint8ClampedArray(baseLayer.pixels);
      const res = await runWorkerTask(
        'freq_sep',
        {
          rgba: srcCopy,
          width: state.width,
          height: state.height,
          radius
        },
        [srcCopy.buffer]
      );

      const lowLayer = createLayer(
        `Low Frequency (Color & Tone ${radius}px)`,
        state.width,
        state.height,
        res.lowRgba,
        'normal',
        1.0
      );

      const highLayer = createLayer(
        `High Frequency (Texture & Pores 16-Bit)`,
        state.width,
        state.height,
        res.highRgba,
        'linearLight',
        1.0
      );

      // Insert Low + High Frequency layers directly above active layer
      const insertPos = state.activeLayerIndex + 1;
      state.layers.splice(insertPos, 0, lowLayer, highLayer);
      state.activeLayerIndex = insertPos + 1; // Select High Frequency layer for immediate blemish healing

      // Switch to Spot Healing tool automatically
      setActiveTool('heal');

      pushHistory(`HF Separation Action (${radius}px)`);
      syncUIWithActiveLayer();
      compositeLayers();
      renderLayersPanel();
      updateStatusBar();
      showToast('16-Bit High-Frequency Separation Ready — Active: High Texture Layer');
    } catch (err) {
      showToast(`HF Separation Error: ${err.message}`);
    }
  }

  // Apply Selection as Non-Destructive Layer Mask
  function applySelectionAsLayerMask() {
    if (!state.hasSelection || !state.selectionMask) {
      showToast('Make a selection first (e.g. Select Subject / Sky / BG)');
      return;
    }
    const layer = state.layers[state.activeLayerIndex];
    if (!layer) return;

    // If only 1 background layer exists, duplicate it automatically so transparency shows cleanly
    if (state.layers.length === 1 && state.activeLayerIndex === 0) {
      const extracted = createLayer(
        layer.name + ' (Masked Cutout)',
        state.width,
        state.height,
        layer.pixels,
        'normal',
        1.0
      );
      extracted.mask = new Uint8ClampedArray(state.selectionMask);
      layer.visible = false; // Hide original background so cutout checkerboard is visible
      state.layers.push(extracted);
      state.activeLayerIndex = state.layers.length - 1;
    } else {
      layer.mask = new Uint8ClampedArray(state.selectionMask);
    }

    state.hasSelection = false;
    state.selectionMask = null;

    pushHistory('Apply Selection as Layer Mask');
    compositeLayers();
    renderLayersPanel();
    updateStatusBar();
    showToast('Applied Selection as Non-Destructive Layer Mask');
  }

  // Extract Subject directly to a new cutout layer in 1 click
  async function extractSubjectToNewLayer() {
    if (!state.hasSelection || !state.selectionMask) {
      await runAISelection('subject');
    }
    if (!state.hasSelection || !state.selectionMask) return;

    const srcLayer = state.layers[state.activeLayerIndex] || state.layers[0];
    const cutoutPixels = new Uint8ClampedArray(srcLayer.pixels);
    const sm = state.selectionMask;
    for (let i = 0; i < sm.length; i++) {
      const idx = i * 4;
      cutoutPixels[idx + 3] = Math.round((cutoutPixels[idx + 3] * sm[i]) / 255);
    }

    const newLayer = createLayer(
      'Subject Cutout Layer',
      state.width,
      state.height,
      cutoutPixels,
      'normal',
      1.0
    );
    state.layers.splice(state.activeLayerIndex + 1, 0, newLayer);
    state.activeLayerIndex += 1;
    state.hasSelection = false;
    state.selectionMask = null;

    pushHistory('Extract Subject to Layer');
    compositeLayers();
    renderLayersPanel();
    updateStatusBar();
    showToast('Subject Extracted to New Cutout Layer');
  }

  // Run Worker Filter on Active Layer (respecting selection mask if active)
  async function runFilterOnActiveLayer(filterType, params, label) {
    const layer = state.layers[state.activeLayerIndex];
    if (!layer) return;

    showToast(`Applying ${label}...`, 3000);
    const srcCopy = new Uint8ClampedArray(layer.pixels);
    const res = await runWorkerTask(
      'filter',
      {
        rgba: srcCopy,
        width: state.width,
        height: state.height,
        filterType,
        params
      },
      [srcCopy.buffer]
    );

    const filtered = res.rgba;
    if (state.hasSelection && state.selectionMask) {
      const sm = state.selectionMask;
      for (let i = 0; i < sm.length; i++) {
        const w = sm[i] / 255;
        if (w <= 0) continue;
        const idx = i * 4;
        layer.pixels[idx]     = Math.round(layer.pixels[idx]     * (1 - w) + filtered[idx]     * w);
        layer.pixels[idx + 1] = Math.round(layer.pixels[idx + 1] * (1 - w) + filtered[idx + 1] * w);
        layer.pixels[idx + 2] = Math.round(layer.pixels[idx + 2] * (1 - w) + filtered[idx + 2] * w);
      }
    } else {
      layer.pixels.set(filtered);
    }

    pushHistory(label);
    compositeLayers();
    renderLayersPanel();
    showToast(`${label} Applied`);
  }

  // UI Synchronization Helpers
  function renderLayersPanel() {
    const list = document.getElementById('layersList');
    const countLabel = document.getElementById('layerCountLabel');
    list.innerHTML = '';
    countLabel.textContent = `${state.layers.length} Layer${state.layers.length > 1 ? 's' : ''}`;

    // Render top-to-bottom (highest layer index at top of stack)
    for (let i = state.layers.length - 1; i >= 0; i--) {
      const layer = state.layers[i];
      const item = document.createElement('div');
      item.className = 'layer-item' + (i === state.activeLayerIndex ? ' active' : '');

      const vis = document.createElement('div');
      vis.className = 'layer-vis';
      vis.textContent = layer.visible ? '👁' : '·';
      vis.title = 'Toggle Layer Visibility';
      vis.onclick = (e) => {
        e.stopPropagation();
        layer.visible = !layer.visible;
        compositeLayers();
        renderLayersPanel();
      };

      const info = document.createElement('div');
      info.className = 'layer-info';
      const nameEl = document.createElement('div');
      nameEl.className = 'layer-name';
      nameEl.textContent = layer.name;
      const metaEl = document.createElement('div');
      metaEl.className = 'layer-meta';
      const modeLabel = layer.blendMode === 'linearLight' ? 'Linear Light (16-Bit HF)' : layer.blendMode;
      metaEl.textContent = `${modeLabel} • ${Math.round(layer.opacity * 100)}%${layer.mask ? ' • [Masked]' : ''}`;

      info.appendChild(nameEl);
      info.appendChild(metaEl);

      item.appendChild(vis);
      item.appendChild(info);

      item.onclick = () => {
        state.activeLayerIndex = i;
        syncUIWithActiveLayer();
        renderLayersPanel();
        updateStatusBar();
      };

      list.appendChild(item);
    }
  }

  function renderHistoryPanel() {
    const list = document.getElementById('historyList');
    const stepLabel = document.getElementById('historyStepLabel');
    list.innerHTML = '';
    stepLabel.textContent = `${state.historyIndex + 1} / ${state.history.length}`;

    state.history.forEach((entry, idx) => {
      const row = document.createElement('div');
      row.className = 'history-entry' + (idx === state.historyIndex ? ' current' : '');
      row.innerHTML = `<span>${idx + 1}. ${entry.label}</span><span>${entry.time}</span>`;
      row.onclick = () => restoreHistoryStep(idx);
      list.appendChild(row);
    });
    list.scrollTop = list.scrollHeight;
  }

  function syncUIWithActiveLayer() {
    const layer = state.layers[state.activeLayerIndex];
    if (!layer) return;

    document.getElementById('layerBlendMode').value = layer.blendMode;
    const opacPct = Math.round(layer.opacity * 100);
    document.getElementById('layerOpacity').value = opacPct;
    document.getElementById('layerOpacityVal').textContent = opacPct + '%';

    const adj = layer.adjustments;
    const fields = [
      ['adjExposure', 'valExposure', adj.exposure],
      ['adjContrast', 'valContrast', adj.contrast],
      ['adjHighlights', 'valHighlights', adj.highlights],
      ['adjShadows', 'valShadows', adj.shadows],
      ['adjTemp', 'valTemp', adj.temp],
      ['adjSaturation', 'valSaturation', adj.saturation]
    ];
    for (const [sliderId, valId, v] of fields) {
      document.getElementById(sliderId).value = v;
      document.getElementById(valId).textContent = v;
    }
  }

  function updateStatusBar() {
    const zoomPct = Math.round(state.zoom * 100) + '%';
    document.getElementById('statusZoom').textContent = zoomPct;
    document.getElementById('docTitle').textContent = state.docTitle;
    document.getElementById('docDimensions').textContent = `RGB/16-Bit HF • ${zoomPct}`;
    document.getElementById('statusRes').textContent = `${state.width} × ${state.height} px`;

    const activeLayer = state.layers[state.activeLayerIndex];
    document.getElementById('statusActiveLayer').textContent = activeLayer ? activeLayer.name : 'None';

    if (state.hasSelection && state.selectionMask) {
      let count = 0;
      for (let i = 0; i < state.selectionMask.length; i++) {
        if (state.selectionMask[i] >= 128) count++;
      }
      const pct = ((count / state.selectionMask.length) * 100).toFixed(1);
      document.getElementById('statusSelection').textContent = `Active (${pct}%)`;
    } else {
      document.getElementById('statusSelection').textContent = 'None';
    }
  }

  const toolNames = {
    move: 'Move & Pan Tool (V)',
    marquee: 'Rectangular Marquee (M)',
    lasso: 'Freehand Lasso Select (L)',
    wand: 'Quick Selection / Magic Wand (W)',
    crop: 'Crop Tool (C)',
    heal: 'Spot Healing Brush (J)',
    freqsmooth: 'Low-Freq Skin Mixer (F)',
    clone: 'Clone Stamp Tool (S)',
    brush: 'Paint Brush Tool (B)',
    eraser: 'Eraser Tool (E)',
    dodge: 'Dodge Highlights (O)',
    burn: 'Burn Shadows (D)',
    liquify: 'Liquify Sculpt Push (P)',
    eyedropper: 'Eyedropper Sampler (I)',
    hand: 'Hand Pan Tool (H)',
    zoom: 'Zoom Tool (Z)'
  };

  function setActiveTool(toolId) {
    state.activeTool = toolId;
    document.querySelectorAll('.tool-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tool === toolId);
    });
    document.getElementById('activeToolLabel').textContent = toolNames[toolId] || toolId;
    document.getElementById('wandToleranceGroup').style.display = toolId === 'wand' ? 'flex' : 'none';
  }

  // Export Document as JPEG or Transparent PNG
  function exportDocument(format = 'jpeg') {
    const link = document.createElement('a');
    const baseName = state.docTitle.replace(/\.[^.]+$/, '');
    if (format === 'png') {
      link.download = `${baseName}_PixelShop_Cutout.png`;
      link.href = displayCanvas.toDataURL('image/png');
    } else {
      link.download = `${baseName}_PixelShop_Edited.jpg`;
      link.href = displayCanvas.toDataURL('image/jpeg', 0.96);
    }
    link.click();
    showToast(`Exported ${link.download}`);
  }

  // =========================================================================
  // EVENT LISTENERS: MENUS, TOOLBAR, CANVAS INTERACTION, SHORTCUTS
  // =========================================================================

  // Top Menu Bar Open/Close
  document.querySelectorAll('.menu-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasOpen = item.classList.contains('open');
      document.querySelectorAll('.menu-item').forEach((m) => m.classList.remove('open'));
      if (!wasOpen) item.classList.add('open');
    });
    item.addEventListener('mouseenter', () => {
      const anyOpen = document.querySelector('.menu-item.open');
      if (anyOpen && anyOpen !== item) {
        document.querySelectorAll('.menu-item').forEach((m) => m.classList.remove('open'));
        item.classList.add('open');
      }
    });
  });

  window.addEventListener('click', () => {
    document.querySelectorAll('.menu-item').forEach((m) => m.classList.remove('open'));
  });

  // Menu Actions Dispatcher
  document.querySelectorAll('.dropdown-entry').forEach((entry) => {
    entry.addEventListener('click', async (e) => {
      e.stopPropagation();
      document.querySelectorAll('.menu-item').forEach((m) => m.classList.remove('open'));
      const act = entry.dataset.action;

      switch (act) {
        case 'file-new':
          createProceduralPortraitFallback();
          break;
        case 'file-open':
          document.getElementById('fileInput').click();
          break;
        case 'sample-1':
          loadImageFromUrl('samples/Farida studio-11.jpg', 'Farida studio-11.jpg');
          break;
        case 'sample-2':
          loadImageFromUrl('samples/Farida studio-4.jpg', 'Farida studio-4.jpg');
          break;
        case 'sample-3':
          loadImageFromUrl('samples/Farida studio-9.jpg', 'Farida studio-9.jpg');
          break;
        case 'file-export-jpg':
          exportDocument('jpeg');
          break;
        case 'file-export-png':
          exportDocument('png');
          break;
        case 'edit-undo':
          if (state.historyIndex > 0) restoreHistoryStep(state.historyIndex - 1);
          break;
        case 'edit-redo':
          if (state.historyIndex < state.history.length - 1) restoreHistoryStep(state.historyIndex + 1);
          break;
        case 'edit-fill-fg': {
          const layer = state.layers[state.activeLayerIndex];
          if (!layer) break;
          const hex = state.fgColor.replace('#', '');
          const fr = parseInt(hex.substring(0, 2), 16) || 255;
          const fg = parseInt(hex.substring(2, 4), 16) || 228;
          const fb = parseInt(hex.substring(4, 6), 16) || 0;
          for (let i = 0; i < state.width * state.height; i++) {
            const w = state.hasSelection && state.selectionMask ? state.selectionMask[i] / 255 : 1.0;
            if (w <= 0) continue;
            const idx = i * 4;
            layer.pixels[idx]     = Math.round(layer.pixels[idx]     * (1 - w) + fr * w);
            layer.pixels[idx + 1] = Math.round(layer.pixels[idx + 1] * (1 - w) + fg * w);
            layer.pixels[idx + 2] = Math.round(layer.pixels[idx + 2] * (1 - w) + fb * w);
            layer.pixels[idx + 3] = Math.max(layer.pixels[idx + 3], Math.round(w * 255));
          }
          pushHistory('Fill Foreground Color');
          compositeLayers();
          break;
        }
        case 'edit-clear-sel': {
          const layer = state.layers[state.activeLayerIndex];
          if (!layer || !state.hasSelection || !state.selectionMask) break;
          for (let i = 0; i < state.selectionMask.length; i++) {
            const w = state.selectionMask[i] / 255;
            if (w > 0) {
              layer.pixels[i * 4 + 3] = Math.round(layer.pixels[i * 4 + 3] * (1 - w));
            }
          }
          pushHistory('Clear Selection Pixels');
          compositeLayers();
          break;
        }
        case 'img-autotone': {
          const layer = state.layers[state.activeLayerIndex];
          if (!layer) break;
          layer.adjustments.exposure = 8;
          layer.adjustments.contrast = 16;
          layer.adjustments.highlights = -14;
          layer.adjustments.shadows = 18;
          layer.adjustments.saturation = 10;
          syncUIWithActiveLayer();
          pushHistory('Auto Tone & Contrast');
          compositeLayers();
          showToast('Auto Tone & Studio Contrast Applied');
          break;
        }
        case 'img-reset-adj':
          resetActiveLayerAdjustments();
          break;
        case 'img-flip-h':
          flipDocument(true);
          break;
        case 'img-flip-v':
          flipDocument(false);
          break;
        case 'img-flatten': {
          compositeLayers();
          const flatData = displayCtx.getImageData(0, 0, state.width, state.height).data;
          state.layers = [createLayer('Flattened Image', state.width, state.height, flatData, 'normal', 1.0)];
          state.activeLayerIndex = 0;
          pushHistory('Flatten Image');
          renderLayersPanel();
          updateStatusBar();
          showToast('All Layers Flattened');
          break;
        }
        case 'layer-dup':
          duplicateActiveLayer();
          break;
        case 'layer-new':
          addNewEmptyLayer();
          break;
        case 'layer-mask-from-sel':
          applySelectionAsLayerMask();
          break;
        case 'layer-extract-subject':
          await extractSubjectToNewLayer();
          break;
        case 'layer-freq-sep':
          document.getElementById('freqSepModal').classList.add('open');
          break;
        case 'layer-delete':
          deleteActiveLayer();
          break;
        case 'ai-select-subject':
          await runAISelection('subject');
          break;
        case 'ai-select-sky':
          await runAISelection('sky');
          break;
        case 'ai-select-bg':
          await runAISelection('background');
          break;
        case 'sel-all':
          state.selectionMask = new Uint8ClampedArray(state.width * state.height).fill(255);
          state.hasSelection = true;
          drawOverlayCanvas();
          updateStatusBar();
          showToast('Selected All');
          break;
        case 'sel-deselect':
          state.selectionMask = null;
          state.hasSelection = false;
          drawOverlayCanvas();
          updateStatusBar();
          showToast('Deselected');
          break;
        case 'sel-invert':
          invertSelection();
          break;
        case 'sel-feather':
          featherSelection();
          break;
        case 'filter-surface-blur':
          await runFilterOnActiveLayer('surface_blur', { radius: 6, threshold: 20 }, 'Surface Blur');
          break;
        case 'filter-high-pass':
          await runFilterOnActiveLayer('high_pass', { radius: 4.5 }, 'High Pass (4.5px)');
          break;
        case 'filter-gaussian-4':
          await runFilterOnActiveLayer('gaussian_blur', { radius: 4.0 }, 'Gaussian Blur (4px)');
          break;
        case 'filter-gaussian-10':
          await runFilterOnActiveLayer('gaussian_blur', { radius: 10.0 }, 'Gaussian Blur (10px)');
          break;
        case 'filter-gaussian-22':
          await runFilterOnActiveLayer('gaussian_blur', { radius: 22.0 }, 'Gaussian Blur (22px)');
          break;
        case 'filter-unsharp':
          await runFilterOnActiveLayer('unsharp_mask', { radius: 2.0, amount: 120, threshold: 2 }, 'Unsharp Mask');
          break;
        case 'filter-smart-sharpen':
          await runFilterOnActiveLayer('unsharp_mask', { radius: 1.2, amount: 165, threshold: 1 }, 'Smart Sharpen');
          break;
        case 'filter-bw-highcontrast': {
          const layer = state.layers[state.activeLayerIndex];
          if (layer) {
            layer.adjustments.saturation = -100;
            layer.adjustments.contrast = 32;
            layer.adjustments.highlights = 10;
            syncUIWithActiveLayer();
            pushHistory('High-Contrast Studio B&W');
            compositeLayers();
          }
          break;
        }
        case 'filter-golden-hour': {
          const layer = state.layers[state.activeLayerIndex];
          if (layer) {
            layer.adjustments.temp = 34;
            layer.adjustments.exposure = 6;
            layer.adjustments.saturation = 18;
            syncUIWithActiveLayer();
            pushHistory('Golden Hour Grade');
            compositeLayers();
          }
          break;
        }
        case 'filter-cinema-teal': {
          const layer = state.layers[state.activeLayerIndex];
          if (layer) {
            layer.adjustments.temp = -18;
            layer.adjustments.contrast = 22;
            layer.adjustments.shadows = -12;
            syncUIWithActiveLayer();
            pushHistory('Cinematic Grade');
            compositeLayers();
          }
          break;
        }
        case 'filter-vignette':
          applyOpticalVignette();
          break;
        case 'view-fit':
          fitCanvasToViewport();
          break;
        case 'view-100':
          state.zoom = 1.0;
          state.panX = 0;
          state.panY = 0;
          applyViewportTransform();
          break;
        case 'view-zoom-in':
          state.zoom = clamp(state.zoom * 1.25, 0.15, 5.0);
          applyViewportTransform();
          break;
        case 'view-zoom-out':
          state.zoom = clamp(state.zoom / 1.25, 0.15, 5.0);
          applyViewportTransform();
          break;
        case 'view-toggle-mask-overlay':
          state.showYellowMatteOverlay = !state.showYellowMatteOverlay;
          drawOverlayCanvas();
          showToast(state.showYellowMatteOverlay ? 'Yellow Matte Overlay ON (Q)' : 'Yellow Matte Overlay OFF');
          break;
      }
    });
  });

  function invertSelection() {
    if (!state.hasSelection || !state.selectionMask) {
      showToast('No active selection to invert');
      return;
    }
    for (let i = 0; i < state.selectionMask.length; i++) {
      state.selectionMask[i] = 255 - state.selectionMask[i];
    }
    pushHistory('Invert Selection');
    drawOverlayCanvas();
    updateStatusBar();
    showToast('Selection Inverted');
  }

  function featherSelection() {
    if (!state.hasSelection || !state.selectionMask) {
      showToast('No active selection to feather');
      return;
    }
    const w = state.width, h = state.height;
    const src = new Uint8ClampedArray(state.selectionMask);
    for (let y = 2; y < h - 2; y++) {
      for (let x = 2; x < w - 2; x++) {
        let sum = 0;
        for (let ky = -2; ky <= 2; ky++) {
          for (let kx = -2; kx <= 2; kx++) {
            sum += src[(y + ky) * w + (x + kx)];
          }
        }
        state.selectionMask[y * w + x] = Math.round(sum / 25);
      }
    }
    pushHistory('Feather Selection Edge');
    drawOverlayCanvas();
    showToast('Selection Edge Feathered');
  }

  function flipDocument(horizontal = true) {
    const w = state.width, h = state.height;
    state.layers.forEach((layer) => {
      const copy = new Uint8ClampedArray(layer.pixels);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const sx = horizontal ? (w - 1 - x) : x;
          const sy = horizontal ? y : (h - 1 - y);
          const dstIdx = (y * w + x) * 4;
          const srcIdx = (sy * w + sx) * 4;
          layer.pixels[dstIdx]     = copy[srcIdx];
          layer.pixels[dstIdx + 1] = copy[srcIdx + 1];
          layer.pixels[dstIdx + 2] = copy[srcIdx + 2];
          layer.pixels[dstIdx + 3] = copy[srcIdx + 3];
        }
      }
    });
    pushHistory(horizontal ? 'Flip Horizontal' : 'Flip Vertical');
    compositeLayers();
  }

  function applyOpticalVignette() {
    const layer = state.layers[state.activeLayerIndex];
    if (!layer) return;
    const w = state.width, h = state.height;
    const cx = w * 0.5, cy = h * 0.5;
    const maxDist = Math.hypot(cx, cy);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const d = Math.hypot(x - cx, y - cy) / maxDist;
        const factor = clamp(1.0 - Math.pow(d, 2.2) * 0.55, 0.2, 1.0);
        const idx = (y * w + x) * 4;
        layer.pixels[idx]     = Math.round(layer.pixels[idx]     * factor);
        layer.pixels[idx + 1] = Math.round(layer.pixels[idx + 1] * factor);
        layer.pixels[idx + 2] = Math.round(layer.pixels[idx + 2] * factor);
      }
    }
    pushHistory('Optical Lens Vignette');
    compositeLayers();
  }

  function duplicateActiveLayer() {
    const src = state.layers[state.activeLayerIndex];
    if (!src) return;
    const dup = createLayer(
      src.name + ' Copy',
      state.width,
      state.height,
      src.pixels,
      src.blendMode,
      src.opacity
    );
    if (src.mask) dup.mask = new Uint8ClampedArray(src.mask);
    dup.adjustments = { ...src.adjustments };
    state.layers.splice(state.activeLayerIndex + 1, 0, dup);
    state.activeLayerIndex += 1;
    pushHistory('Duplicate Layer');
    syncUIWithActiveLayer();
    compositeLayers();
    renderLayersPanel();
    updateStatusBar();
  }

  function addNewEmptyLayer() {
    const nl = createLayer(`Layer ${state.layers.length + 1}`, state.width, state.height, null, 'normal', 1.0);
    state.layers.splice(state.activeLayerIndex + 1, 0, nl);
    state.activeLayerIndex += 1;
    pushHistory('New Layer');
    syncUIWithActiveLayer();
    compositeLayers();
    renderLayersPanel();
    updateStatusBar();
  }

  function deleteActiveLayer() {
    if (state.layers.length <= 1) {
      showToast('Cannot delete the last remaining layer');
      return;
    }
    state.layers.splice(state.activeLayerIndex, 1);
    state.activeLayerIndex = clamp(state.activeLayerIndex, 0, state.layers.length - 1);
    pushHistory('Delete Layer');
    syncUIWithActiveLayer();
    compositeLayers();
    renderLayersPanel();
    updateStatusBar();
  }

  function resetActiveLayerAdjustments() {
    const layer = state.layers[state.activeLayerIndex];
    if (!layer) return;
    layer.adjustments = { exposure: 0, contrast: 0, highlights: 0, shadows: 0, temp: 0, saturation: 0 };
    syncUIWithActiveLayer();
    pushHistory('Reset Adjustments');
    compositeLayers();
  }

  // Tool Buttons Click
  document.querySelectorAll('.tool-btn').forEach((btn) => {
    btn.addEventListener('click', () => setActiveTool(btn.dataset.tool));
  });

  // Top Options Bar Controls
  document.getElementById('optBrushSize').addEventListener('input', (e) => {
    state.brushSize = Number(e.target.value);
    document.getElementById('optBrushSizeVal').textContent = state.brushSize + ' px';
  });
  document.getElementById('optBrushHardness').addEventListener('input', (e) => {
    state.brushHardness = Number(e.target.value) / 100;
    document.getElementById('optBrushHardnessVal').textContent = e.target.value + '%';
  });
  document.getElementById('optBrushStrength').addEventListener('input', (e) => {
    state.brushStrength = Number(e.target.value) / 100;
    document.getElementById('optBrushStrengthVal').textContent = e.target.value + '%';
  });
  document.getElementById('optWandTolerance').addEventListener('input', (e) => {
    state.wandTolerance = Number(e.target.value);
    document.getElementById('optWandToleranceVal').textContent = state.wandTolerance;
  });

  // Top & Panel AI Selection + HF Separation Buttons
  document.getElementById('btnTopSelectSubject').onclick = () => runAISelection('subject');
  document.getElementById('btnTopSelectSky').onclick = () => runAISelection('sky');
  document.getElementById('btnTopSelectBg').onclick = () => runAISelection('background');
  document.getElementById('btnTopMaskSelection').onclick = () => applySelectionAsLayerMask();
  document.getElementById('btnTopFreqSep').onclick = () => {
    document.getElementById('freqSepModal').classList.add('open');
  };

  document.getElementById('btnPanelSubject').onclick = () => runAISelection('subject');
  document.getElementById('btnPanelSky').onclick = () => runAISelection('sky');
  document.getElementById('btnPanelBg').onclick = () => runAISelection('background');
  document.getElementById('btnPanelInvertSel').onclick = () => invertSelection();
  document.getElementById('btnPanelFeatherSel').onclick = () => featherSelection();
  document.getElementById('btnPanelExtractLayer').onclick = () => extractSubjectToNewLayer();
  document.getElementById('btnPanelFreqSep').onclick = () => {
    document.getElementById('freqSepModal').classList.add('open');
  };

  // High-Frequency Separation Modal Controls
  const freqModal = document.getElementById('freqSepModal');
  const freqRadiusInput = document.getElementById('freqSepRadiusInput');
  freqRadiusInput.addEventListener('input', (e) => {
    document.getElementById('freqSepRadiusVal').textContent = Number(e.target.value).toFixed(1) + ' px';
  });
  document.getElementById('closeFreqSepModal').onclick = () => freqModal.classList.remove('open');
  document.getElementById('cancelFreqSepBtn').onclick = () => freqModal.classList.remove('open');
  document.getElementById('confirmFreqSepBtn').onclick = async () => {
    freqModal.classList.remove('open');
    await runHighFrequencySeparation(Number(freqRadiusInput.value));
  };

  // Adjustments Sliders
  const adjMapping = [
    ['adjExposure', 'valExposure', 'exposure'],
    ['adjContrast', 'valContrast', 'contrast'],
    ['adjHighlights', 'valHighlights', 'highlights'],
    ['adjShadows', 'valShadows', 'shadows'],
    ['adjTemp', 'valTemp', 'temp'],
    ['adjSaturation', 'valSaturation', 'saturation']
  ];
  adjMapping.forEach(([sliderId, valId, key]) => {
    const el = document.getElementById(sliderId);
    el.addEventListener('input', () => {
      const layer = state.layers[state.activeLayerIndex];
      if (!layer) return;
      layer.adjustments[key] = Number(el.value);
      document.getElementById(valId).textContent = el.value;
      compositeLayers();
    });
    el.addEventListener('change', () => {
      pushHistory(`Adjust ${key}`);
    });
  });

  document.getElementById('btnResetAdj').onclick = () => resetActiveLayerAdjustments();

  // Layer Blend Mode & Opacity Controls
  document.getElementById('layerBlendMode').addEventListener('change', (e) => {
    const layer = state.layers[state.activeLayerIndex];
    if (!layer) return;
    layer.blendMode = e.target.value;
    pushHistory(`Blend Mode: ${e.target.value}`);
    compositeLayers();
    renderLayersPanel();
  });

  document.getElementById('layerOpacity').addEventListener('input', (e) => {
    const layer = state.layers[state.activeLayerIndex];
    if (!layer) return;
    layer.opacity = Number(e.target.value) / 100;
    document.getElementById('layerOpacityVal').textContent = e.target.value + '%';
    compositeLayers();
    renderLayersPanel();
  });

  document.getElementById('btnAddLayer').onclick = () => addNewEmptyLayer();
  document.getElementById('btnDupLayer').onclick = () => duplicateActiveLayer();
  document.getElementById('btnMaskLayer').onclick = () => applySelectionAsLayerMask();
  document.getElementById('btnDelLayer').onclick = () => deleteActiveLayer();

  // Foreground Swatch Picker
  const fgPicker = document.getElementById('fgColorPicker');
  const swatchFg = document.getElementById('swatchFg');
  swatchFg.onclick = () => fgPicker.click();
  fgPicker.addEventListener('input', (e) => {
    state.fgColor = e.target.value;
    swatchFg.style.background = state.fgColor;
  });

  // Top Right Quick Buttons
  document.getElementById('btnQuickOpen').onclick = () => document.getElementById('fileInput').click();
  let sampleCycle = 0;
  const sampleFiles = [
    ['samples/Farida studio-11.jpg', 'Farida studio-11.jpg'],
    ['samples/Farida studio-4.jpg', 'Farida studio-4.jpg'],
    ['samples/Farida studio-9.jpg', 'Farida studio-9.jpg']
  ];
  document.getElementById('btnSamplePortrait').onclick = () => {
    sampleCycle = (sampleCycle + 1) % sampleFiles.length;
    const [url, name] = sampleFiles[sampleCycle];
    loadImageFromUrl(url, name);
  };

  const btnCompare = document.getElementById('btnCompareHold');
  btnCompare.addEventListener('mousedown', () => {
    state.compareHoldOriginal = true;
    compositeLayers();
  });
  window.addEventListener('mouseup', () => {
    if (state.compareHoldOriginal) {
      state.compareHoldOriginal = false;
      compositeLayers();
    }
  });

  // Local File Upload Input + Drag & Drop
  document.getElementById('fileInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => loadImageFromUrl(ev.target.result, file.name);
    reader.readAsDataURL(file);
  });

  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = (ev) => loadImageFromUrl(ev.target.result, file.name);
      reader.readAsDataURL(file);
    }
  });

  // =========================================================================
  // VIEWPORT POINTER INTERACTION (RETOUCHING, SELECTION, PAN, ZOOM)
  // =========================================================================
  viewport.addEventListener('mousemove', (e) => {
    const pt = clientToDocCoords(e.clientX, e.clientY);

    // Update RGB readout in Histogram Header
    const ix = clamp(Math.floor(pt.x), 0, state.width - 1);
    const iy = clamp(Math.floor(pt.y), 0, state.height - 1);
    const layer = state.layers[state.activeLayerIndex];
    if (layer) {
      const idx = (iy * state.width + ix) * 4;
      document.getElementById('cursorRGBInfo').textContent =
        `R:${layer.pixels[idx]} G:${layer.pixels[idx + 1]} B:${layer.pixels[idx + 2]}`;
    }

    // Update Floating Brush Circle
    const brushTools = ['heal', 'freqsmooth', 'clone', 'brush', 'eraser', 'dodge', 'burn', 'liquify'];
    if (brushTools.includes(state.activeTool) && !state.isSpacePanning) {
      brushCursor.style.display = 'block';
      const screenDiameter = Math.max(6, state.brushSize * state.zoom);
      brushCursor.style.width = screenDiameter + 'px';
      brushCursor.style.height = screenDiameter + 'px';
      brushCursor.style.left = e.clientX + 'px';
      brushCursor.style.top = e.clientY + 'px';
    } else {
      brushCursor.style.display = 'none';
    }

    if (!state.isPointerDown) return;

    // Pan mode
    if (state.isSpacePanning || state.activeTool === 'hand' || state.activeTool === 'move') {
      state.panX += e.clientX - state.lastClientPt.x;
      state.panY += e.clientY - state.lastClientPt.y;
      state.lastClientPt = { x: e.clientX, y: e.clientY };
      applyViewportTransform();
      return;
    }

    if (state.activeTool === 'marquee' || state.activeTool === 'crop') {
      state.lastDocPt = pt;
      drawOverlayCanvas();
      return;
    }

    if (state.activeTool === 'lasso') {
      state.lassoPoints.push(pt);
      state.lastDocPt = pt;
      drawOverlayCanvas();
      return;
    }

    if (brushTools.includes(state.activeTool)) {
      // Interpolate dabs along stroke for silky-smooth retouching
      const prev = state.lastDocPt || pt;
      const dist = Math.hypot(pt.x - prev.x, pt.y - prev.y);
      const stepSize = Math.max(1.5, state.brushSize * 0.18);
      const steps = Math.max(1, Math.ceil(dist / stepSize));
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const ixPt = prev.x + (pt.x - prev.x) * t;
        const iyPt = prev.y + (pt.y - prev.y) * t;
        applyToolDab(ixPt, iyPt, prev);
      }
      state.lastDocPt = pt;
      compositeLayers();
    }
  });

  viewport.addEventListener('mousedown', async (e) => {
    if (e.button !== 0) return;
    const pt = clientToDocCoords(e.clientX, e.clientY);
    state.isPointerDown = true;
    state.lastDocPt = pt;
    state.lastClientPt = { x: e.clientX, y: e.clientY };

    if (state.isSpacePanning || state.activeTool === 'hand' || state.activeTool === 'move') {
      return;
    }

    if (state.activeTool === 'zoom') {
      state.zoom = e.altKey ? clamp(state.zoom / 1.25, 0.15, 5.0) : clamp(state.zoom * 1.25, 0.15, 5.0);
      applyViewportTransform();
      state.isPointerDown = false;
      return;
    }

    if (state.activeTool === 'eyedropper') {
      const layer = state.layers[state.activeLayerIndex];
      if (layer) {
        const ix = clamp(Math.floor(pt.x), 0, state.width - 1);
        const iy = clamp(Math.floor(pt.y), 0, state.height - 1);
        const idx = (iy * state.width + ix) * 4;
        const hex = '#' + [layer.pixels[idx], layer.pixels[idx + 1], layer.pixels[idx + 2]]
          .map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
        state.fgColor = hex;
        swatchFg.style.background = hex;
        fgPicker.value = hex;
        showToast(`Sampled Color: ${hex}`);
      }
      state.isPointerDown = false;
      return;
    }

    if (state.activeTool === 'wand') {
      state.isPointerDown = false;
      const layer = state.layers[state.activeLayerIndex];
      if (!layer) return;
      const copyRgba = new Uint8ClampedArray(layer.pixels);
      const res = await runWorkerTask(
        'magic_wand',
        {
          rgba: copyRgba,
          width: state.width,
          height: state.height,
          x: pt.x,
          y: pt.y,
          tolerance: state.wandTolerance,
          contiguous: !e.altKey
        },
        [copyRgba.buffer]
      );
      state.selectionMask = res.mask;
      state.hasSelection = res.selectedCount > 0;
      pushHistory('Quick Selection / Magic Wand');
      drawOverlayCanvas();
      updateStatusBar();
      return;
    }

    if (state.activeTool === 'marquee' || state.activeTool === 'crop') {
      state.marqueeStart = pt;
      return;
    }

    if (state.activeTool === 'lasso') {
      state.lassoPoints = [pt];
      return;
    }

    if (state.activeTool === 'clone' && e.altKey) {
      state.cloneSource = { x: pt.x, y: pt.y };
      state.cloneOffset = null;
      drawOverlayCanvas();
      showToast(`Clone Source Set (${Math.round(pt.x)}, ${Math.round(pt.y)})`);
      state.isPointerDown = false;
      return;
    }

    if (state.activeTool === 'clone' && state.cloneSource) {
      state.cloneOffset = {
        dx: state.cloneSource.x - pt.x,
        dy: state.cloneSource.y - pt.y
      };
    }

    const brushTools = ['heal', 'freqsmooth', 'clone', 'brush', 'eraser', 'dodge', 'burn', 'liquify'];
    if (brushTools.includes(state.activeTool)) {
      applyToolDab(pt.x, pt.y, pt);
      compositeLayers();
    }
  });

  window.addEventListener('mouseup', () => {
    if (!state.isPointerDown) return;
    state.isPointerDown = false;

    if (state.activeTool === 'marquee' && state.marqueeStart && state.lastDocPt) {
      const x0 = clamp(Math.round(Math.min(state.marqueeStart.x, state.lastDocPt.x)), 0, state.width - 1);
      const x1 = clamp(Math.round(Math.max(state.marqueeStart.x, state.lastDocPt.x)), 0, state.width - 1);
      const y0 = clamp(Math.round(Math.min(state.marqueeStart.y, state.lastDocPt.y)), 0, state.height - 1);
      const y1 = clamp(Math.round(Math.max(state.marqueeStart.y, state.lastDocPt.y)), 0, state.height - 1);
      state.marqueeStart = null;

      if (x1 - x0 > 3 && y1 - y0 > 3) {
        const mask = new Uint8ClampedArray(state.width * state.height);
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            mask[y * state.width + x] = 255;
          }
        }
        state.selectionMask = mask;
        state.hasSelection = true;
        pushHistory('Rectangular Marquee Selection');
      } else {
        state.selectionMask = null;
        state.hasSelection = false;
      }
      drawOverlayCanvas();
      updateStatusBar();
      return;
    }

    if (state.activeTool === 'crop' && state.marqueeStart && state.lastDocPt) {
      const x0 = clamp(Math.round(Math.min(state.marqueeStart.x, state.lastDocPt.x)), 0, state.width - 1);
      const x1 = clamp(Math.round(Math.max(state.marqueeStart.x, state.lastDocPt.x)), 0, state.width - 1);
      const y0 = clamp(Math.round(Math.min(state.marqueeStart.y, state.lastDocPt.y)), 0, state.height - 1);
      const y1 = clamp(Math.round(Math.max(state.marqueeStart.y, state.lastDocPt.y)), 0, state.height - 1);
      state.marqueeStart = null;
      const cw = x1 - x0;
      const ch = y1 - y0;
      if (cw > 24 && ch > 24) {
        state.layers.forEach((layer) => {
          const newPix = new Uint8ClampedArray(cw * ch * 4);
          for (let y = 0; y < ch; y++) {
            for (let x = 0; x < cw; x++) {
              const sIdx = ((y0 + y) * state.width + (x0 + x)) * 4;
              const dIdx = (y * cw + x) * 4;
              newPix[dIdx]     = layer.pixels[sIdx];
              newPix[dIdx + 1] = layer.pixels[sIdx + 1];
              newPix[dIdx + 2] = layer.pixels[sIdx + 2];
              newPix[dIdx + 3] = layer.pixels[sIdx + 3];
            }
          }
          layer.pixels = newPix;
          layer.mask = null;
        });
        state.width = cw;
        state.height = ch;
        displayCanvas.width = cw;
        displayCanvas.height = ch;
        overlayCanvas.width = cw;
        overlayCanvas.height = ch;
        state.selectionMask = null;
        state.hasSelection = false;
        fitCanvasToViewport();
        pushHistory(`Crop Canvas (${cw}×${ch})`);
        compositeLayers();
      }
      drawOverlayCanvas();
      return;
    }

    if (state.activeTool === 'lasso' && state.lassoPoints.length > 2) {
      const tempC = document.createElement('canvas');
      tempC.width = state.width;
      tempC.height = state.height;
      const tCtx = tempC.getContext('2d');
      tCtx.fillStyle = '#FFFFFF';
      tCtx.beginPath();
      tCtx.moveTo(state.lassoPoints[0].x, state.lassoPoints[0].y);
      for (let i = 1; i < state.lassoPoints.length; i++) {
        tCtx.lineTo(state.lassoPoints[i].x, state.lassoPoints[i].y);
      }
      tCtx.closePath();
      tCtx.fill();
      const d = tCtx.getImageData(0, 0, state.width, state.height).data;
      const mask = new Uint8ClampedArray(state.width * state.height);
      for (let i = 0; i < mask.length; i++) mask[i] = d[i * 4];
      state.selectionMask = mask;
      state.hasSelection = true;
      state.lassoPoints = [];
      pushHistory('Lasso Selection');
      drawOverlayCanvas();
      updateStatusBar();
      return;
    }

    const brushTools = ['heal', 'freqsmooth', 'clone', 'brush', 'eraser', 'dodge', 'burn', 'liquify'];
    if (brushTools.includes(state.activeTool)) {
      pushHistory(toolNames[state.activeTool] || 'Brush Stroke');
    }
  });

  // Mouse Wheel Zoom
  viewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    state.zoom = clamp(state.zoom * factor, 0.15, 5.0);
    applyViewportTransform();
  }, { passive: false });

  // Keyboard Shortcuts
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

    if (e.code === 'Space') {
      state.isSpacePanning = true;
      viewport.style.cursor = 'grab';
      return;
    }

    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    if (ctrl && key === 'z') {
      e.preventDefault();
      if (state.historyIndex > 0) restoreHistoryStep(state.historyIndex - 1);
      return;
    }
    if (ctrl && key === 'y') {
      e.preventDefault();
      if (state.historyIndex < state.history.length - 1) restoreHistoryStep(state.historyIndex + 1);
      return;
    }
    if (ctrl && key === 'd') {
      e.preventDefault();
      state.selectionMask = null;
      state.hasSelection = false;
      drawOverlayCanvas();
      updateStatusBar();
      showToast('Deselected');
      return;
    }
    if (ctrl && key === 'j') {
      e.preventDefault();
      duplicateActiveLayer();
      return;
    }
    if (e.altKey && key === 's') {
      e.preventDefault();
      runAISelection('subject');
      return;
    }
    if (e.altKey && key === 'k') {
      e.preventDefault();
      runAISelection('sky');
      return;
    }
    if (e.altKey && key === 'b') {
      e.preventDefault();
      runAISelection('background');
      return;
    }

    // Bracket keys [ and ] for brush size
    if (e.key === '[') {
      state.brushSize = clamp(state.brushSize - 6, 3, 260);
      document.getElementById('optBrushSize').value = state.brushSize;
      document.getElementById('optBrushSizeVal').textContent = state.brushSize + ' px';
      return;
    }
    if (e.key === ']') {
      state.brushSize = clamp(state.brushSize + 6, 3, 260);
      document.getElementById('optBrushSize').value = state.brushSize;
      document.getElementById('optBrushSizeVal').textContent = state.brushSize + ' px';
      return;
    }

    const keyToolMap = {
      v: 'move',
      m: 'marquee',
      l: 'lasso',
      w: 'wand',
      c: 'crop',
      j: 'heal',
      f: 'freqsmooth',
      s: 'clone',
      b: 'brush',
      e: 'eraser',
      o: 'dodge',
      d: 'burn',
      p: 'liquify',
      i: 'eyedropper',
      h: 'hand',
      z: 'zoom'
    };
    if (!ctrl && !e.altKey && keyToolMap[key]) {
      setActiveTool(keyToolMap[key]);
    } else if (!ctrl && !e.altKey && key === 'q') {
      state.showYellowMatteOverlay = !state.showYellowMatteOverlay;
      drawOverlayCanvas();
      showToast(state.showYellowMatteOverlay ? 'Yellow Matte Overlay ON (Q)' : 'Yellow Matte Overlay OFF');
    }
  });

  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
      state.isSpacePanning = false;
      viewport.style.cursor = 'default';
    }
  });

  // Initialize Default Studio Sample Portrait on Startup
  loadImageFromUrl('samples/Farida studio-11.jpg', 'Farida studio-11.jpg');

  // Drive In-App Splash Screen Loading Bar (if not already shown by native Electron splash window)
  const splashOverlay = document.getElementById('inAppSplashOverlay');
  if (splashOverlay) {
    if (window.location.search.includes('nosplash=1')) {
      splashOverlay.style.display = 'none';
    } else {
      const bootSteps = [
        { pct: 10, stage: 'Core Engine',      item: 'Loading 16-Bit RGB/LAB Color Management...' },
        { pct: 24, stage: 'Layer Compositor', item: 'Initializing Non-Destructive Layer & Linear Light Stack...' },
        { pct: 40, stage: 'Matting Engine',   item: 'Loading Select Subject Silhouette & Hair Edge Filter...' },
        { pct: 55, stage: 'Sky & Horizon',    item: 'Loading Select Sky & Atmospheric Gradient Analyzer...' },
        { pct: 70, stage: 'Background Matte', item: 'Binding Select Background Inverse Boundary Solver...' },
        { pct: 84, stage: 'Studio Actions',   item: 'Compiling 16-Bit High-Frequency Separation Pipeline...' },
        { pct: 95, stage: 'Retouch Brushes',  item: 'Calibrating Spot Healing, Clone Stamp & Liquify Kernel...' },
        { pct: 100, stage: 'Ready',           item: 'Opening PixelShop Studio Workspace...' }
      ];
      let bIdx = 0;
      const stEl = document.getElementById('inAppSplashStage');
      const pctEl = document.getElementById('inAppSplashPct');
      const barEl = document.getElementById('inAppSplashBar');
      const btmEl = document.getElementById('inAppSplashBottomBar');
      const itmEl = document.getElementById('inAppSplashItem');

      const stepSplash = () => {
        if (bIdx >= bootSteps.length) {
          splashOverlay.style.opacity = '0';
          setTimeout(() => { splashOverlay.style.display = 'none'; }, 450);
          return;
        }
        const s = bootSteps[bIdx++];
        if (stEl) stEl.textContent = s.stage;
        if (pctEl) pctEl.textContent = s.pct + '%';
        if (barEl) barEl.style.width = s.pct + '%';
        if (btmEl) btmEl.style.width = s.pct + '%';
        if (itmEl) itmEl.textContent = s.item;
        setTimeout(stepSplash, 320);
      };
      setTimeout(stepSplash, 60);
    }
  }
})();
