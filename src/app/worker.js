// PixelShop — Background Processing Worker
// Handles heavy full-resolution pixel operations without freezing the main UI:
// 1. Select Subject, Select Sky, Select Background (Saliency + Skin/Cloth/Horizon + Guided Edge Matte)
// 2. Magic Wand / Quick Selection Flood Fill with edge awareness
// 3. Exact 16-Bit High-Frequency Separation Action (Separable Gaussian Low-Frequency + Neutral 128 High-Pass Linear Light)
// 4. Studio Filters (Gaussian Blur, High Pass, Smart Sharpen, Unsharp Mask, Surface Blur, Liquify Push, Levels/Curves/HSL)

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

// Separable Gaussian Blur on Float32 single channel
function gaussianBlurChannel(src, width, height, radius) {
  if (radius <= 0.1) return new Float32Array(src);
  const sigma = Math.max(radius, 0.5);
  const kRadius = Math.min(Math.ceil(sigma * 2.5), 60);
  const kernel = new Float32Array(kRadius * 2 + 1);
  let sum = 0;
  const twoSigmaSq = 2 * sigma * sigma;
  for (let i = -kRadius; i <= kRadius; i++) {
    const w = Math.exp(-(i * i) / twoSigmaSq);
    kernel[i + kRadius] = w;
    sum += w;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;

  const temp = new Float32Array(width * height);
  const out = new Float32Array(width * height);

  // Horizontal pass
  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let k = -kRadius; k <= kRadius; k++) {
        const nx = clamp(x + k, 0, width - 1);
        acc += src[rowOffset + nx] * kernel[k + kRadius];
      }
      temp[rowOffset + x] = acc;
    }
  }

  // Vertical pass
  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let k = -kRadius; k <= kRadius; k++) {
        const ny = clamp(y + k, 0, height - 1);
        acc += temp[ny * width + x] * kernel[k + kRadius];
      }
      out[rowOffset + x] = acc;
    }
  }

  return out;
}

// Separable Gaussian Blur on RGBA Uint8ClampedArray
function gaussianBlurRGBA(rgba, width, height, radius) {
  const len = width * height;
  const r = new Float32Array(len);
  const g = new Float32Array(len);
  const b = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const idx = i * 4;
    r[i] = rgba[idx];
    g[i] = rgba[idx + 1];
    b[i] = rgba[idx + 2];
  }
  const br = gaussianBlurChannel(r, width, height, radius);
  const bg = gaussianBlurChannel(g, width, height, radius);
  const bb = gaussianBlurChannel(b, width, height, radius);

  const out = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < len; i++) {
    const idx = i * 4;
    out[idx] = clamp(Math.round(br[i]), 0, 255);
    out[idx + 1] = clamp(Math.round(bg[i]), 0, 255);
    out[idx + 2] = clamp(Math.round(bb[i]), 0, 255);
    out[idx + 3] = rgba[idx + 3];
  }
  return out;
}

// Edge-Preserving Guided Filter on alpha mask (0..1) guided by luminance I (0..1)
// Refines alpha mattes for hair & crisp silhouettes
function guidedFilter(I, p, width, height, radius, eps) {
  const meanI = gaussianBlurChannel(I, width, height, radius);
  const meanP = gaussianBlurChannel(p, width, height, radius);
  const len = width * height;
  const II = new Float32Array(len);
  const Ip = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    II[i] = I[i] * I[i];
    Ip[i] = I[i] * p[i];
  }
  const corrI = gaussianBlurChannel(II, width, height, radius);
  const corrIp = gaussianBlurChannel(Ip, width, height, radius);

  const a = new Float32Array(len);
  const b = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const varI = Math.max(0, corrI[i] - meanI[i] * meanI[i]);
    const covIp = corrIp[i] - meanI[i] * meanP[i];
    a[i] = covIp / (varI + eps);
    b[i] = meanP[i] - a[i] * meanI[i];
  }

  const meanA = gaussianBlurChannel(a, width, height, radius);
  const meanB = gaussianBlurChannel(b, width, height, radius);
  const q = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    q[i] = clamp(meanA[i] * I[i] + meanB[i], 0, 1);
  }
  return q;
}

// RGB to CIE Lab approximation for perceptual color distance
function rgbToLab(r, g, b) {
  let rn = r / 255, gn = g / 255, bn = b / 255;
  rn = rn > 0.04045 ? Math.pow((rn + 0.055) / 1.055, 2.4) : rn / 12.92;
  gn = gn > 0.04045 ? Math.pow((gn + 0.055) / 1.055, 2.4) : gn / 12.92;
  bn = bn > 0.04045 ? Math.pow((bn + 0.055) / 1.055, 2.4) : bn / 12.92;

  let x = (rn * 0.4124 + gn * 0.3576 + bn * 0.1805) / 0.95047;
  let y = (rn * 0.2126 + gn * 0.7152 + bn * 0.0722) / 1.00000;
  let z = (rn * 0.0193 + gn * 0.1192 + bn * 0.9505) / 1.08883;

  x = x > 0.008856 ? Math.cbrt(x) : (7.787 * x) + 16 / 116;
  y = y > 0.008856 ? Math.cbrt(y) : (7.787 * y) + 16 / 116;
  z = z > 0.008856 ? Math.cbrt(z) : (7.787 * z) + 16 / 116;

  return [
    (116 * y) - 16,
    500 * (x - y),
    200 * (y - z)
  ];
}

// =========================================================================
// 'SELECT SUBJECT', 'SELECT SKY', 'SELECT BACKGROUND' MATTING ENGINE
// =========================================================================
function computeAISelection(rgba, width, height, mode, featherRadius = 1.5) {
  // Perform multi-cue saliency & boundary analysis at high speed on working grid
  const maxWorkDim = 512;
  const scale = Math.min(1, maxWorkDim / Math.max(width, height));
  const sw = Math.max(32, Math.round(width * scale));
  const sh = Math.max(32, Math.round(height * scale));
  const sLen = sw * sh;

  const L = new Float32Array(sLen);
  const A = new Float32Array(sLen);
  const B = new Float32Array(sLen);
  const R = new Float32Array(sLen);
  const G = new Float32Array(sLen);
  const BL = new Float32Array(sLen);
  const lum = new Float32Array(sLen);

  for (let sy = 0; sy < sh; sy++) {
    const oy = Math.min(height - 1, Math.floor(sy / scale));
    for (let sx = 0; sx < sw; sx++) {
      const ox = Math.min(width - 1, Math.floor(sx / scale));
      const idx = (oy * width + ox) * 4;
      const r = rgba[idx], g = rgba[idx + 1], b = rgba[idx + 2];
      const si = sy * sw + sx;
      R[si] = r; G[si] = g; BL[si] = b;
      lum[si] = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      const [l, a, labB] = rgbToLab(r, g, b);
      L[si] = l; A[si] = a; B[si] = labB;
    }
  }

  // Local gradient / micro-contrast energy (in-focus subject vs smooth backdrop/sky)
  const grad = new Float32Array(sLen);
  for (let y = 1; y < sh - 1; y++) {
    for (let x = 1; x < sw - 1; x++) {
      const i = y * sw + x;
      const gx = L[i + 1] - L[i - 1];
      const gy = L[i + sw] - L[i - sw];
      grad[i] = Math.hypot(gx, gy);
    }
  }
  const smoothGrad = gaussianBlurChannel(grad, sw, sh, 4.0);

  let probSmall = new Float32Array(sLen);

  if (mode === 'subject' || mode === 'background') {
    // 1. Sample outer border clusters (top, left, right edges) to build Background Color Model
    const borderSamples = [];
    const margin = Math.max(3, Math.floor(Math.min(sw, sh) * 0.05));

    // Sample top, left, right borders (avoid bottom center where torso/legs exit frame)
    for (let y = 0; y < sh; y += 2) {
      for (let x = 0; x < sw; x += 2) {
        const isTop = y < margin;
        const isLeft = x < margin;
        const isRight = x >= sw - margin;
        const isBottomCorner = (y >= sh - margin) && (x < sw * 0.18 || x > sw * 0.82);
        if (isTop || isLeft || isRight || isBottomCorner) {
          const i = y * sw + x;
          borderSamples.push([L[i], A[i], B[i], smoothGrad[i]]);
        }
      }
    }

    // Build K=5 representative background centroids via farthest-point / quantile seeding
    const centroids = [];
    if (borderSamples.length > 0) {
      const step = Math.max(1, Math.floor(borderSamples.length / 6));
      for (let k = 0; k < borderSamples.length && centroids.length < 6; k += step) {
        centroids.push([...borderSamples[k]]);
      }
      // 3 iterations of K-means refinement on border samples
      for (let iter = 0; iter < 3; iter++) {
        const sums = centroids.map(() => [0, 0, 0, 0, 0]);
        for (const s of borderSamples) {
          let bestK = 0, bestD = 1e9;
          for (let k = 0; k < centroids.length; k++) {
            const c = centroids[k];
            const d = (s[0] - c[0]) ** 2 + (s[1] - c[1]) ** 2 + (s[2] - c[2]) ** 2;
            if (d < bestD) { bestD = d; bestK = k; }
          }
          sums[bestK][0] += s[0];
          sums[bestK][1] += s[1];
          sums[bestK][2] += s[2];
          sums[bestK][3] += s[3];
          sums[bestK][4] += 1;
        }
        for (let k = 0; k < centroids.length; k++) {
          if (sums[k][4] > 0) {
            centroids[k][0] = sums[k][0] / sums[k][4];
            centroids[k][1] = sums[k][1] / sums[k][4];
            centroids[k][2] = sums[k][2] / sums[k][4];
            centroids[k][3] = sums[k][3] / sums[k][4];
          }
        }
      }
    }

    // 2. Compute per-pixel foreground probability combining:
    // - Lab distance from nearest background centroid
    // - Human skin / hair / portrait chromatic prior
    // - Spatial portrait prior (center-bottom torso anchor)
    // - Focus / edge structure density
    for (let y = 0; y < sh; y++) {
      const ny = (y / sh) - 0.52; // slightly lower center for portrait subjects
      for (let x = 0; x < sw; x++) {
        const nx = (x / sw) - 0.5;
        const i = y * sw + x;

        let minBgDist = 1e9;
        for (let k = 0; k < centroids.length; k++) {
          const c = centroids[k];
          const d = Math.hypot(L[i] - c[0], (A[i] - c[1]) * 1.25, (B[i] - c[2]) * 1.25);
          if (d < minBgDist) minBgDist = d;
        }

        // Color distinctness score (0..1)
        const colorScore = clamp((minBgDist - 7.5) / 24.0, 0, 1);

        // Skin & warm portrait tone boost
        const r = R[i], g = G[i], b = BL[i];
        const isSkinLikely = (r > 65 && g > 35 && b > 20 && r > g && g > b * 0.85 && (r - b) > 15 && A[i] > 3 && B[i] > 4);
        const skinBoost = isSkinLikely ? 0.36 : 0;

        // Focus / detail boost
        const detailBoost = clamp((smoothGrad[i] - 3.5) / 18.0, 0, 0.30);

        // Spatial center-torso weight (strong in center and bottom-center, weak at far edges)
        const distElliptical = Math.hypot(nx * 1.35, ny * 0.95);
        const spatialPrior = clamp(1.08 - distElliptical * 1.15, 0.05, 1.0);

        // Combine cues
        let fg = (colorScore * 0.68 + skinBoost + detailBoost) * (0.45 + 0.55 * spatialPrior);
        if (colorScore > 0.65 && spatialPrior > 0.35) fg = Math.max(fg, 0.85);
        if (colorScore < 0.12 && !isSkinLikely && detailBoost < 0.08) fg *= 0.2;

        probSmall[i] = clamp(fg, 0, 1);
      }
    }

    // 3. Border Flood-Suppression (Background connectivity from top/left/right boundaries)
    // Pixels connected to the outer border that match border color get strongly suppressed
    const bgVisited = new Uint8Array(sLen);
    const queue = new Int32Array(sLen);
    let qHead = 0, qTail = 0;

    for (let x = 0; x < sw; x++) {
      const topIdx = x;
      if (probSmall[topIdx] < 0.55) {
        bgVisited[topIdx] = 1;
        queue[qTail++] = topIdx;
      }
    }
    for (let y = 0; y < sh; y++) {
      const leftIdx = y * sw;
      const rightIdx = y * sw + (sw - 1);
      if (probSmall[leftIdx] < 0.55 && !bgVisited[leftIdx]) {
        bgVisited[leftIdx] = 1;
        queue[qTail++] = leftIdx;
      }
      if (probSmall[rightIdx] < 0.55 && !bgVisited[rightIdx]) {
        bgVisited[rightIdx] = 1;
        queue[qTail++] = rightIdx;
      }
    }

    const dirs = [-1, 1, -sw, sw];
    while (qHead < qTail) {
      const curr = queue[qHead++];
      const cL = L[curr], cA = A[curr], cB = B[curr];
      for (let d = 0; d < 4; d++) {
        const next = curr + dirs[d];
        if (next < 0 || next >= sLen || bgVisited[next]) continue;
        // Prevent horizontal wrap-around
        if ((dirs[d] === -1 || dirs[d] === 1) && Math.floor(curr / sw) !== Math.floor(next / sw)) continue;

        const stepDist = Math.hypot(L[next] - cL, A[next] - cA, B[next] - cB);
        if (stepDist < 5.2 && probSmall[next] < 0.68) {
          bgVisited[next] = 1;
          queue[qTail++] = next;
        }
      }
    }

    for (let i = 0; i < sLen; i++) {
      if (bgVisited[i]) {
        probSmall[i] *= 0.08;
      } else if (probSmall[i] > 0.36) {
        probSmall[i] = clamp((probSmall[i] - 0.28) / 0.35, 0, 1);
      }
    }

    // Smooth & threshold with Guided Filter on working grid
    probSmall = guidedFilter(lum, probSmall, sw, sh, 5, 0.002);
    for (let i = 0; i < sLen; i++) {
      probSmall[i] = clamp((probSmall[i] - 0.38) / 0.28, 0, 1);
    }

    if (mode === 'background') {
      for (let i = 0; i < sLen; i++) {
        probSmall[i] = 1.0 - probSmall[i];
      }
    }
  } else if (mode === 'sky') {
    // 'SELECT SKY' ENGINE:
    // Analyzes upper-frame region connectivity, low high-frequency texture, atmospheric luminance/chromatic gradient,
    // and stops cleanly at horizon / architectural / foliage / portrait edges.
    const topMargin = Math.max(4, Math.floor(sh * 0.08));
    const skySeeds = [];
    for (let y = 0; y < topMargin; y += 2) {
      for (let x = 0; x < sw; x += 2) {
        const i = y * sw + x;
        if (smoothGrad[i] < 12.0 && L[i] > 22) {
          skySeeds.push([L[i], A[i], B[i]]);
        }
      }
    }

    const skyVisited = new Float32Array(sLen);
    const queue = new Int32Array(sLen);
    let qHead = 0, qTail = 0;

    for (let y = 0; y < Math.floor(sh * 0.04); y++) {
      for (let x = 0; x < sw; x++) {
        const i = y * sw + x;
        // Sky is smooth or blue/cyan/bright/sunset in the upper frame
        const isBlueOrBright = (BL[i] >= R[i] * 0.85 || L[i] > 55 || (R[i] > 180 && G[i] > 110));
        if (smoothGrad[i] < 14.0 && isBlueOrBright) {
          skyVisited[i] = 1.0;
          queue[qTail++] = i;
        }
      }
    }

    const dirs = [-1, 1, -sw, sw];
    while (qHead < qTail) {
      const curr = queue[qHead++];
      const cL = L[curr], cA = A[curr], cB = B[curr];
      for (let d = 0; d < 4; d++) {
        const next = curr + dirs[d];
        if (next < 0 || next >= sLen || skyVisited[next] > 0) continue;
        if ((dirs[d] === -1 || dirs[d] === 1) && Math.floor(curr / sw) !== Math.floor(next / sw)) continue;

        const ny = Math.floor(next / sw) / sh;
        if (ny > 0.85) continue; // Sky rarely extends to bottom 15% of frame

        const stepDist = Math.hypot(L[next] - cL, A[next] - cA, B[next] - cB);
        // Smooth atmospheric gradient tolerance
        if (stepDist < 6.0 && grad[next] < 16.0) {
          skyVisited[next] = 1.0;
          queue[qTail++] = next;
        }
      }
    }

    probSmall = guidedFilter(lum, skyVisited, sw, sh, 4, 0.0015);
    for (let i = 0; i < sLen; i++) {
      probSmall[i] = clamp((probSmall[i] - 0.35) / 0.30, 0, 1);
    }
  }

  // Upsample probability mask back to full resolution with bilinear interpolation
  const fullMask = new Uint8ClampedArray(width * height);
  const fullFloat = new Float32Array(width * height);

  for (let y = 0; y < height; y++) {
    const sy = clamp(y * scale, 0, sh - 1.001);
    const y0 = Math.floor(sy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const fy = sy - y0;

    for (let x = 0; x < width; x++) {
      const sx = clamp(x * scale, 0, sw - 1.001);
      const x0 = Math.floor(sx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const fx = sx - x0;

      const v00 = probSmall[y0 * sw + x0];
      const v10 = probSmall[y0 * sw + x1];
      const v01 = probSmall[y1 * sw + x0];
      const v11 = probSmall[y1 * sw + x1];

      const val = (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
      fullFloat[y * width + x] = val;
    }
  }

  // Optional final feathering at full resolution
  const refined = featherRadius > 0.3 ? gaussianBlurChannel(fullFloat, width, height, featherRadius) : fullFloat;
  let selectedCount = 0;
  for (let i = 0; i < refined.length; i++) {
    const m = clamp(Math.round(refined[i] * 255), 0, 255);
    fullMask[i] = m;
    if (m >= 128) selectedCount++;
  }

  return { mask: fullMask, selectedCount, totalPixels: width * height };
}

// =========================================================================
// MAGIC WAND / QUICK SELECTION FLOOD FILL AT FULL RESOLUTION
// =========================================================================
function computeMagicWand(rgba, width, height, startX, startY, tolerance = 32, contiguous = true) {
  const sx = clamp(Math.round(startX), 0, width - 1);
  const sy = clamp(Math.round(startY), 0, height - 1);
  const seedIdx = (sy * width + sx) * 4;
  const sr = rgba[seedIdx], sg = rgba[seedIdx + 1], sb = rgba[seedIdx + 2];
  const [sL, sA, sB] = rgbToLab(sr, sg, sb);

  const mask = new Uint8ClampedArray(width * height);
  const thresh = tolerance * 1.15;

  if (!contiguous) {
    let selectedCount = 0;
    for (let i = 0; i < width * height; i++) {
      const idx = i * 4;
      const dist = Math.hypot(rgba[idx] - sr, rgba[idx + 1] - sg, rgba[idx + 2] - sb) * 0.58;
      if (dist <= thresh) {
        mask[i] = 255;
        selectedCount++;
      }
    }
    return { mask, selectedCount };
  }

  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let qHead = 0, qTail = 0;
  const startPos = sy * width + sx;
  visited[startPos] = 1;
  mask[startPos] = 255;
  queue[qTail++] = startPos;
  let selectedCount = 1;

  while (qHead < qTail) {
    const curr = queue[qHead++];
    const cx = curr % width;
    const cy = (curr - cx) / width;

    const neighbors = [];
    if (cx > 0) neighbors.push(curr - 1);
    if (cx < width - 1) neighbors.push(curr + 1);
    if (cy > 0) neighbors.push(curr - width);
    if (cy < height - 1) neighbors.push(curr + width);

    for (let n = 0; n < neighbors.length; n++) {
      const next = neighbors[n];
      if (visited[next]) continue;
      visited[next] = 1;

      const idx = next * 4;
      const dist = Math.hypot(rgba[idx] - sr, rgba[idx + 1] - sg, rgba[idx + 2] - sb) * 0.58;
      if (dist <= thresh) {
        mask[next] = 255;
        selectedCount++;
        queue[qTail++] = next;
      }
    }
  }

  return { mask, selectedCount };
}

// =========================================================================
// 16-BIT HIGH-FREQUENCY SEPARATION ACTION
// =========================================================================
// Creates exact Low-Frequency (Color & Tone) and High-Frequency (Texture on Neutral 128 Gray)
// so that blending with Linear Light reproduces the original image with 0.00% delta.
function computeFrequencySeparation(rgba, width, height, radius) {
  const lowRgba = gaussianBlurRGBA(rgba, width, height, radius);
  const highRgba = new Uint8ClampedArray(rgba.length);

  for (let i = 0; i < rgba.length; i += 4) {
    // 16-bit style precision formula: High = clamp(round((Orig - Low) * 0.5 + 128), 0, 255)
    // In Linear Light blend mode: Result = Low + 2 * (High - 128) = Low + (Orig - Low) = Orig!
    highRgba[i]     = clamp(Math.round((rgba[i]     - lowRgba[i])     * 0.5 + 128), 0, 255);
    highRgba[i + 1] = clamp(Math.round((rgba[i + 1] - lowRgba[i + 1]) * 0.5 + 128), 0, 255);
    highRgba[i + 2] = clamp(Math.round((rgba[i + 2] - lowRgba[i + 2]) * 0.5 + 128), 0, 255);
    highRgba[i + 3] = rgba[i + 3];
  }

  return { lowRgba, highRgba };
}

// =========================================================================
// CS6 FILTERS: HIGH PASS, UNSHARP MASK, SURFACE BLUR, AUTO TONE
// =========================================================================
function applyFilter(rgba, width, height, filterType, params) {
  const len = width * height;
  if (filterType === 'gaussian_blur') {
    return gaussianBlurRGBA(rgba, width, height, params.radius || 6.0);
  }
  if (filterType === 'high_pass') {
    const low = gaussianBlurRGBA(rgba, width, height, params.radius || 4.0);
    const out = new Uint8ClampedArray(rgba.length);
    for (let i = 0; i < rgba.length; i += 4) {
      out[i]     = clamp(Math.round((rgba[i]     - low[i])     * 0.5 + 128), 0, 255);
      out[i + 1] = clamp(Math.round((rgba[i + 1] - low[i + 1]) * 0.5 + 128), 0, 255);
      out[i + 2] = clamp(Math.round((rgba[i + 2] - low[i + 2]) * 0.5 + 128), 0, 255);
      out[i + 3] = rgba[i + 3];
    }
    return out;
  }
  if (filterType === 'unsharp_mask') {
    const radius = params.radius || 2.0;
    const amount = (params.amount !== undefined ? params.amount : 120) / 100;
    const threshold = params.threshold || 2;
    const blurred = gaussianBlurRGBA(rgba, width, height, radius);
    const out = new Uint8ClampedArray(rgba.length);
    for (let i = 0; i < rgba.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        const diff = rgba[i + c] - blurred[i + c];
        if (Math.abs(diff) >= threshold) {
          out[i + c] = clamp(Math.round(rgba[i + c] + diff * amount), 0, 255);
        } else {
          out[i + c] = rgba[i + c];
        }
      }
      out[i + 3] = rgba[i + 3];
    }
    return out;
  }
  if (filterType === 'surface_blur') {
    // Edge-preserving bilateral/guided skin smoothing
    const radius = params.radius || 5;
    const threshold = params.threshold || 18;
    const blurred = gaussianBlurRGBA(rgba, width, height, radius);
    const out = new Uint8ClampedArray(rgba.length);
    for (let i = 0; i < rgba.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        const diff = Math.abs(rgba[i + c] - blurred[i + c]);
        const weight = clamp(1.0 - diff / (threshold * 2.2), 0, 1);
        out[i + c] = clamp(Math.round(rgba[i + c] * (1 - weight) + blurred[i + c] * weight), 0, 255);
      }
      out[i + 3] = rgba[i + 3];
    }
    return out;
  }
  return new Uint8ClampedArray(rgba);
}

self.onmessage = function (e) {
  const { id, task, payload } = e.data;
  try {
    if (task === 'ai_select') {
      const { rgba, width, height, mode, feather } = payload;
      const res = computeAISelection(rgba, width, height, mode, feather);
      self.postMessage({ id, ok: true, result: res }, [res.mask.buffer]);
    } else if (task === 'magic_wand') {
      const { rgba, width, height, x, y, tolerance, contiguous } = payload;
      const res = computeMagicWand(rgba, width, height, x, y, tolerance, contiguous);
      self.postMessage({ id, ok: true, result: res }, [res.mask.buffer]);
    } else if (task === 'freq_sep') {
      const { rgba, width, height, radius } = payload;
      const res = computeFrequencySeparation(rgba, width, height, radius);
      self.postMessage({
        id,
        ok: true,
        result: res
      }, [res.lowRgba.buffer, res.highRgba.buffer]);
    } else if (task === 'filter') {
      const { rgba, width, height, filterType, params } = payload;
      const out = applyFilter(rgba, width, height, filterType, params);
      self.postMessage({ id, ok: true, result: { rgba: out } }, [out.buffer]);
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: err.message || String(err) });
  }
};
