'use strict';

// Zero-dependency QR Code image decoder (Byte mode, ECC Level L, Versions 1-5)
(() => {
  const SIZES = [21, 25, 29, 33, 37];
  const SPECS = {
    21: { data: 19, ec: 7, align: null },
    25: { data: 34, ec: 10, align: 18 },
    29: { data: 55, ec: 15, align: 22 },
    33: { data: 80, ec: 20, align: 26 },
    37: { data: 108, ec: 26, align: 30 }
  };

  const GF_EXP = new Uint8Array(512);
  const GF_LOG = new Uint8Array(256);
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];

  function gfMul(a, b) {
    return a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]];
  }

  function gfDiv(a, b) {
    if (a === 0) return 0;
    return GF_EXP[(GF_LOG[a] - GF_LOG[b] + 255) % 255];
  }

  function rsDecode(codewords, ecCount) {
    const syndromes = new Array(ecCount).fill(0);
    let hasError = false;
    for (let i = 0; i < ecCount; i++) {
      let s = 0;
      const root = GF_EXP[i];
      for (let j = 0; j < codewords.length; j++) {
        s = gfMul(s, root) ^ codewords[j];
      }
      syndromes[i] = s;
      if (s !== 0) hasError = true;
    }
    if (!hasError) return codewords;

    // Berlekamp-Massey for error locator polynomial
    let C = [1];
    let B = [1];
    let L = 0;
    let m = 1;
    let b = 1;
    for (let n = 0; n < ecCount; n++) {
      let d = syndromes[n];
      for (let i = 1; i <= L; i++) {
        d ^= gfMul(C[i], syndromes[n - i]);
      }
      if (d === 0) {
        m++;
      } else {
        const T = C.slice();
        const coef = gfDiv(d, b);
        while (C.length < B.length + m) C.push(0);
        for (let i = 0; i < B.length; i++) {
          C[i + m] ^= gfMul(coef, B[i]);
        }
        if (2 * L <= n) {
          L = n + 1 - L;
          B = T;
          b = d;
          m = 1;
        } else {
          m++;
        }
      }
    }

    if (L > Math.floor(ecCount / 2)) return null;

    // Chien search
    const errLocs = [];
    for (let i = 0; i < codewords.length; i++) {
      const invX = GF_EXP[(255 - i) % 255];
      let val = 0;
      let pow = 1;
      for (let j = 0; j < C.length; j++) {
        val ^= gfMul(C[j], pow);
        pow = gfMul(pow, invX);
      }
      if (val === 0) errLocs.push(i);
    }
    if (errLocs.length !== L) return null;

    // Forney algorithm
    const omega = new Array(ecCount).fill(0);
    for (let i = 0; i < ecCount; i++) {
      for (let j = 0; j < C.length && j <= i; j++) {
        omega[i] ^= gfMul(syndromes[i - j], C[j]);
      }
    }

    const out = codewords.slice();
    for (const pos of errLocs) {
      const invX = GF_EXP[(255 - pos) % 255];
      let num = 0;
      let pow = 1;
      for (let i = 0; i < L; i++) {
        num ^= gfMul(omega[i], pow);
        pow = gfMul(pow, invX);
      }
      let den = 0;
      pow = 1;
      for (let i = 1; i < C.length; i += 2) {
        den ^= gfMul(C[i], pow);
        pow = gfMul(pow, gfMul(invX, invX));
      }
      if (den === 0) return null;
      const errMag = gfDiv(num, den);
      out[codewords.length - 1 - pos] ^= errMag;
    }
    return out;
  }

  function toBinary(rgba, width, height) {
    const gray = new Uint8Array(width * height);
    for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
      gray[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
    }

    const integral = new Int32Array((width + 1) * (height + 1));
    const stride = width + 1;
    for (let y = 0; y < height; y++) {
      let rowSum = 0;
      for (let x = 0; x < width; x++) {
        rowSum += gray[y * width + x];
        integral[(y + 1) * stride + (x + 1)] = integral[y * stride + (x + 1)] + rowSum;
      }
    }

    const radius = Math.max(8, Math.floor(Math.min(width, height) / 20));
    const bin = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      const y1 = Math.max(0, y - radius);
      const y2 = Math.min(height - 1, y + radius);
      for (let x = 0; x < width; x++) {
        const x1 = Math.max(0, x - radius);
        const x2 = Math.min(width - 1, x + radius);
        const area = (x2 - x1 + 1) * (y2 - y1 + 1);
        const sum =
          integral[(y2 + 1) * stride + (x2 + 1)] -
          integral[y1 * stride + (x2 + 1)] -
          integral[(y2 + 1) * stride + x1] +
          integral[y1 * stride + x1];
        bin[y * width + x] = gray[y * width + x] * area < sum * 0.91 ? 1 : 0;
      }
    }
    return bin;
  }

  function checkRatio(counts) {
    const total = counts[0] + counts[1] + counts[2] + counts[3] + counts[4];
    if (total < 7) return false;
    const mod = total / 7;
    const maxVar = mod * 0.55;
    return (
      Math.abs(counts[0] - mod) < maxVar &&
      Math.abs(counts[1] - mod) < maxVar &&
      Math.abs(counts[2] - 3 * mod) < 3 * maxVar &&
      Math.abs(counts[3] - mod) < maxVar &&
      Math.abs(counts[4] - mod) < maxVar
    );
  }

  function crossCheckVertical(bin, width, height, cx, cy, expectedTotal) {
    const counts = [0, 0, 0, 0, 0];
    let y = cy;
    while (y >= 0 && bin[y * width + cx]) { counts[2]++; y--; }
    if (y < 0) return null;
    while (y >= 0 && !bin[y * width + cx]) { counts[1]++; y--; }
    if (y < 0) return null;
    while (y >= 0 && bin[y * width + cx]) { counts[0]++; y--; }
    y = cy + 1;
    while (y < height && bin[y * width + cx]) { counts[2]++; y++; }
    if (y >= height) return null;
    while (y < height && !bin[y * width + cx]) { counts[3]++; y++; }
    if (y >= height) return null;
    while (y < height && bin[y * width + cx]) { counts[4]++; y++; }

    if (!checkRatio(counts)) return null;
    const total = counts[0] + counts[1] + counts[2] + counts[3] + counts[4];
    if (Math.abs(total - expectedTotal) > expectedTotal * 0.45) return null;
    return y - counts[4] - counts[3] - counts[2] / 2;
  }

  function findFinderCenters(bin, width, height) {
    const centers = [];
    const step = Math.max(1, Math.floor(height / 300));
    for (let y = 0; y < height; y += step) {
      const counts = [0, 0, 0, 0, 0];
      let state = 0;
      for (let x = 0; x < width; x++) {
        const dark = bin[y * width + x] === 1;
        if (dark) {
          if (state === 1 || state === 3) state++;
          counts[state]++;
        } else {
          if (state === 0 || state === 2) {
            state++;
            counts[state]++;
          } else if (state === 4) {
            if (checkRatio(counts)) {
              const total = counts[0] + counts[1] + counts[2] + counts[3] + counts[4];
              const cx = Math.round(x - counts[4] - counts[3] - counts[2] / 2);
              const cy = crossCheckVertical(bin, width, height, cx, y, total);
              if (cy !== null) {
                const mod = total / 7;
                let merged = false;
                for (const c of centers) {
                  if (Math.hypot(c.x - cx, c.y - cy) < mod * 2.5) {
                    const n = c.count + 1;
                    c.x = (c.x * c.count + cx) / n;
                    c.y = (c.y * c.count + cy) / n;
                    c.mod = (c.mod * c.count + mod) / n;
                    c.count = n;
                    merged = true;
                    break;
                  }
                }
                if (!merged) centers.push({ x: cx, y: cy, mod, count: 1 });
              }
            }
            counts[0] = counts[2];
            counts[1] = counts[3];
            counts[2] = counts[4];
            counts[3] = 1;
            counts[4] = 0;
            state = 3;
          } else {
            counts[state]++;
          }
        }
      }
    }
    centers.sort((a, b) => b.count - a.count);
    return centers;
  }

  function orderThreeFinders(pts) {
    let best = null;
    let bestScore = Infinity;
    const limit = Math.min(pts.length, 6);
    for (let i = 0; i < limit; i++) {
      for (let j = i + 1; j < limit; j++) {
        for (let k = j + 1; k < limit; k++) {
          const trio = [pts[i], pts[j], pts[k]];
          const d01 = Math.hypot(trio[0].x - trio[1].x, trio[0].y - trio[1].y);
          const d12 = Math.hypot(trio[1].x - trio[2].x, trio[1].y - trio[2].y);
          const d02 = Math.hypot(trio[0].x - trio[2].x, trio[0].y - trio[2].y);
          const pairs = [
            { tl: trio[0], a: trio[1], b: trio[2], da: d01, db: d02, hyp: d12 },
            { tl: trio[1], a: trio[0], b: trio[2], da: d01, db: d12, hyp: d02 },
            { tl: trio[2], a: trio[0], b: trio[1], da: d02, db: d12, hyp: d01 }
          ];
          for (const p of pairs) {
            if (p.da < 10 || p.db < 10) continue;
            const ratioDiff = Math.abs(p.da - p.db) / Math.max(p.da, p.db);
            const expectedHyp = Math.hypot(p.da, p.db);
            const hypDiff = Math.abs(p.hyp - expectedHyp) / expectedHyp;
            const score = ratioDiff + hypDiff;
            if (score < bestScore && ratioDiff < 0.25 && hypDiff < 0.25) {
              bestScore = score;
              const cross = (p.a.x - p.tl.x) * (p.b.y - p.tl.y) - (p.a.y - p.tl.y) * (p.b.x - p.tl.x);
              best = cross > 0 ? { tl: p.tl, tr: p.a, bl: p.b } : { tl: p.tl, tr: p.b, bl: p.a };
            }
          }
        }
      }
    }
    return best;
  }

  function formatBits(mask) {
    const data = (0b01 << 3) | mask;
    let d = data << 10;
    for (let i = 4; i >= 0; i--) {
      if (d & (1 << (i + 10))) d ^= 0x537 << i;
    }
    return ((data << 10) | d) ^ 0x5412;
  }

  function decodeMatrix(matrix) {
    const size = matrix.length;
    const spec = SPECS[size];
    if (!spec) return null;

    let fmt = 0;
    for (let i = 0; i < 15; i++) {
      const r = i < 6 ? i : i < 8 ? i + 1 : size - 15 + i;
      fmt |= (matrix[r][8] & 1) << i;
    }

    let bestMask = 0;
    let bestDist = 16;
    for (let m = 0; m < 8; m++) {
      let diff = fmt ^ formatBits(m);
      let dist = 0;
      while (diff) { dist += diff & 1; diff >>= 1; }
      if (dist < bestDist) { bestDist = dist; bestMask = m; }
    }
    if (bestDist > 3) return null;

    const isFunc = Array.from({ length: size }, () => new Uint8Array(size));
    const markRect = (r1, c1, r2, c2) => {
      for (let r = Math.max(0, r1); r <= Math.min(size - 1, r2); r++) {
        for (let c = Math.max(0, c1); c <= Math.min(size - 1, c2); c++) isFunc[r][c] = 1;
      }
    };
    markRect(0, 0, 8, 8);
    markRect(0, size - 8, 8, size - 1);
    markRect(size - 8, 0, size - 1, 8);
    for (let i = 8; i < size - 8; i++) { isFunc[6][i] = 1; isFunc[i][6] = 1; }
    if (spec.align) markRect(spec.align - 2, spec.align - 2, spec.align + 2, spec.align + 2);

    const shouldMask = (r, c) => {
      switch (bestMask) {
        case 0: return (r + c) % 2 === 0;
        case 1: return r % 2 === 0;
        case 2: return c % 3 === 0;
        case 3: return (r + c) % 3 === 0;
        case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
        case 5: return ((r * c) % 2 + (r * c) % 3) === 0;
        case 6: return (((r * c) % 2 + (r * c) % 3) % 2) === 0;
        case 7: return (((r + c) % 2 + (r * c) % 3) % 2) === 0;
        default: return false;
      }
    };

    const totalCodewords = spec.data + spec.ec;
    const codewords = [];
    let curByte = 0;
    let bitCount = 0;
    let upward = true;

    for (let right = size - 1; right >= 1 && codewords.length < totalCodewords; right -= 2) {
      if (right === 6) right = 5;
      for (let i = 0; i < size && codewords.length < totalCodewords; i++) {
        const r = upward ? size - 1 - i : i;
        for (let j = 0; j < 2 && codewords.length < totalCodewords; j++) {
          const c = right - j;
          if (isFunc[r][c]) continue;
          const bit = (matrix[r][c] ^ (shouldMask(r, c) ? 1 : 0)) & 1;
          curByte = (curByte << 1) | bit;
          bitCount++;
          if (bitCount === 8) {
            codewords.push(curByte);
            curByte = 0;
            bitCount = 0;
          }
        }
      }
      upward = !upward;
    }

    if (codewords.length < totalCodewords) return null;
    const corrected = rsDecode(codewords, spec.ec);
    if (!corrected) return null;

    // Parse Byte mode (0100)
    const bits = [];
    for (let i = 0; i < spec.data; i++) {
      for (let b = 7; b >= 0; b--) bits.push((corrected[i] >> b) & 1);
    }
    const readBits = (offset, len) => {
      let v = 0;
      for (let i = 0; i < len; i++) v = (v << 1) | (bits[offset + i] || 0);
      return v;
    };

    const mode = readBits(0, 4);
    if (mode !== 0b0100) return null;
    const charLen = readBits(4, 8);
    if (12 + charLen * 8 > bits.length) return null;
    const bytes = new Uint8Array(charLen);
    for (let i = 0; i < charLen; i++) bytes[i] = readBits(12 + i * 8, 8);
    return new TextDecoder().decode(bytes);
  }

  function decodeQrFromImageData(rgba, width, height) {
    if (!rgba || width < 21 || height < 21) return null;
    const bin = toBinary(rgba, width, height);
    const centers = findFinderCenters(bin, width, height);
    if (centers.length < 3) return null;

    const finders = orderThreeFinders(centers);
    if (!finders) return null;

    const { tl, tr, bl } = finders;
    const avgMod = (tl.mod + tr.mod + bl.mod) / 3;
    const dist = Math.hypot(tr.x - tl.x, tr.y - tl.y);
    const estSize = Math.round(dist / avgMod) + 7;

    let size = SIZES[0];
    let minDiff = Infinity;
    for (const s of SIZES) {
      const d = Math.abs(s - estSize);
      if (d < minDiff) { minDiff = d; size = s; }
    }

    // Affine mapping from (u, v) module centers to (x, y) image coordinates
    const span = size - 7;
    const ux = (tr.x - tl.x) / span;
    const uy = (tr.y - tl.y) / span;
    const vx = (bl.x - tl.x) / span;
    const vy = (bl.y - tl.y) / span;
    const ox = tl.x - 3.5 * ux - 3.5 * vx;
    const oy = tl.y - 3.5 * uy - 3.5 * vy;

    const matrix = Array.from({ length: size }, () => new Uint8Array(size));
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const px = Math.round(ox + (c + 0.5) * ux + (r + 0.5) * vx);
        const py = Math.round(oy + (c + 0.5) * uy + (r + 0.5) * vy);
        if (px >= 0 && px < width && py >= 0 && py < height) {
          matrix[r][c] = bin[py * width + px];
        }
      }
    }

    return decodeMatrix(matrix);
  }

  globalThis.scQrDecode = {
    decodeQrFromImageData
  };
})();
