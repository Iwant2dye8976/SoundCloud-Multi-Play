'use strict';

// Minimal zero-dependency QR Code generator (Byte mode, ECC Level L, Versions 1-5)
(() => {
  const VERSION_SPECS = [
    null,
    { size: 21, dataCodewords: 19, ecCodewords: 7, align: [] },
    { size: 25, dataCodewords: 34, ecCodewords: 10, align: [6, 18] },
    { size: 29, dataCodewords: 55, ecCodewords: 15, align: [6, 22] },
    { size: 33, dataCodewords: 80, ecCodewords: 20, align: [6, 26] },
    { size: 37, dataCodewords: 108, ecCodewords: 26, align: [6, 30] }
  ];

  const GF_EXP = new Uint8Array(512);
  const GF_LOG = new Uint8Array(256);
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) {
    GF_EXP[i] = GF_EXP[i - 255];
  }

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return GF_EXP[GF_LOG[a] + GF_LOG[b]];
  }

  function rsGeneratorPoly(degree) {
    let poly = [1];
    for (let i = 0; i < degree; i++) {
      const next = new Array(poly.length + 1).fill(0);
      const factor = GF_EXP[i];
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= gfMul(poly[j], factor);
      }
      poly = next;
    }
    return poly;
  }

  function rsEncode(data, ecCount) {
    const gen = rsGeneratorPoly(ecCount);
    const buf = new Array(data.length + ecCount).fill(0);
    for (let i = 0; i < data.length; i++) buf[i] = data[i];
    for (let i = 0; i < data.length; i++) {
      const coef = buf[i];
      if (coef === 0) continue;
      for (let j = 0; j < gen.length; j++) {
        buf[i + j] ^= gfMul(gen[j], coef);
      }
    }
    return buf.slice(data.length);
  }

  function pickVersion(byteLen) {
    for (let v = 1; v < VERSION_SPECS.length; v++) {
      if (byteLen <= VERSION_SPECS[v].dataCodewords - 2) return v;
    }
    throw new Error('QR payload too long');
  }

  function encodeDataBytes(bytes, dataCodewords) {
    const bits = [];
    const pushBits = (val, len) => {
      for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
    };

    pushBits(0b0100, 4); // Byte mode
    pushBits(bytes.length, 8);
    for (const b of bytes) pushBits(b, 8);

    const maxBits = dataCodewords * 8;
    const termLen = Math.min(4, maxBits - bits.length);
    for (let i = 0; i < termLen; i++) bits.push(0);
    while (bits.length % 8 !== 0) bits.push(0);

    const codewords = [];
    for (let i = 0; i < bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
      codewords.push(byte);
    }

    const pads = [0xec, 0x11];
    let padIdx = 0;
    while (codewords.length < dataCodewords) {
      codewords.push(pads[padIdx % 2]);
      padIdx++;
    }
    return codewords;
  }

  function formatBits(mask) {
    const data = (0b01 << 3) | mask; // ECC L = 01
    let d = data << 10;
    for (let i = 4; i >= 0; i--) {
      if (d & (1 << (i + 10))) d ^= 0x537 << i;
    }
    return ((data << 10) | d) ^ 0x5412;
  }

  function buildBaseMatrix(version) {
    const { size, align } = VERSION_SPECS[version];
    const modules = Array.from({ length: size }, () => new Uint8Array(size));
    const isFunc = Array.from({ length: size }, () => new Uint8Array(size));

    const setFunc = (r, c, val) => {
      if (r >= 0 && r < size && c >= 0 && c < size) {
        modules[r][c] = val ? 1 : 0;
        isFunc[r][c] = 1;
      }
    };

    const drawFinder = (top, left) => {
      for (let r = -1; r <= 7; r++) {
        for (let c = -1; c <= 7; c++) {
          const rr = top + r;
          const cc = left + c;
          if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
          const onEdge = r === 0 || r === 6 || c === 0 || c === 6;
          const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
          const inside = r >= 0 && r <= 6 && c >= 0 && c <= 6;
          setFunc(rr, cc, inside && (onEdge || inCore));
        }
      }
    };

    drawFinder(0, 0);
    drawFinder(0, size - 7);
    drawFinder(size - 7, 0);

    for (const r of align) {
      for (const c of align) {
        if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) {
          continue;
        }
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
            setFunc(r + dr, c + dc, dark);
          }
        }
      }
    }

    for (let i = 8; i < size - 8; i++) {
      setFunc(6, i, i % 2 === 0);
      setFunc(i, 6, i % 2 === 0);
    }

    setFunc(size - 8, 8, 1);

    // Reserve format areas
    for (let i = 0; i < 9; i++) {
      if (i !== 6) {
        isFunc[8][i] = 1;
        isFunc[i][8] = 1;
      }
    }
    for (let i = 0; i < 8; i++) {
      isFunc[8][size - 1 - i] = 1;
      if (i < 7) isFunc[size - 1 - i][8] = 1;
    }

    return { size, modules, isFunc };
  }

  function placeData(modules, isFunc, codewords) {
    const size = modules.length;
    let bitIdx = 0;
    const totalBits = codewords.length * 8;
    let upward = true;

    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let i = 0; i < size; i++) {
        const r = upward ? size - 1 - i : i;
        for (let j = 0; j < 2; j++) {
          const c = right - j;
          if (isFunc[r][c]) continue;
          let bit = 0;
          if (bitIdx < totalBits) {
            bit = (codewords[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1;
            bitIdx++;
          }
          modules[r][c] = bit;
        }
      }
      upward = !upward;
    }
  }

  function applyFormat(modules, mask) {
    const size = modules.length;
    const bits = formatBits(mask);
    for (let i = 0; i < 15; i++) {
      const bit = (bits >> i) & 1;
      if (i < 6) modules[i][8] = bit;
      else if (i < 8) modules[i + 1][8] = bit;
      else modules[size - 15 + i][8] = bit;

      if (i < 8) modules[8][size - 1 - i] = bit;
      else if (i < 9) modules[8][15 - i] = bit;
      else modules[8][14 - i] = bit;
    }
  }

  function shouldMask(mask, r, c) {
    switch (mask) {
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
  }

  function penaltyScore(modules) {
    const size = modules.length;
    let penalty = 0;

    for (let r = 0; r < size; r++) {
      let runColor = modules[r][0];
      let runLen = 1;
      for (let c = 1; c < size; c++) {
        if (modules[r][c] === runColor) {
          runLen++;
        } else {
          if (runLen >= 5) penalty += 3 + (runLen - 5);
          runColor = modules[r][c];
          runLen = 1;
        }
      }
      if (runLen >= 5) penalty += 3 + (runLen - 5);
    }

    for (let c = 0; c < size; c++) {
      let runColor = modules[0][c];
      let runLen = 1;
      for (let r = 1; r < size; r++) {
        if (modules[r][c] === runColor) {
          runLen++;
        } else {
          if (runLen >= 5) penalty += 3 + (runLen - 5);
          runColor = modules[r][c];
          runLen = 1;
        }
      }
      if (runLen >= 5) penalty += 3 + (runLen - 5);
    }

    for (let r = 0; r < size - 1; r++) {
      for (let c = 0; c < size - 1; c++) {
        const v = modules[r][c];
        if (v === modules[r][c + 1] && v === modules[r + 1][c] && v === modules[r + 1][c + 1]) {
          penalty += 3;
        }
      }
    }

    return penalty;
  }

  function createQrMatrix(text) {
    const bytes = new TextEncoder().encode(String(text));
    const version = pickVersion(bytes.length);
    const spec = VERSION_SPECS[version];
    const data = encodeDataBytes(bytes, spec.dataCodewords);
    const ec = rsEncode(data, spec.ecCodewords);
    const allCodewords = data.concat(ec);

    const base = buildBaseMatrix(version);
    placeData(base.modules, base.isFunc, allCodewords);

    let bestMask = 0;
    let bestScore = Infinity;
    let bestMatrix = null;

    for (let mask = 0; mask < 8; mask++) {
      const candidate = base.modules.map((row) => Uint8Array.from(row));
      for (let r = 0; r < base.size; r++) {
        for (let c = 0; c < base.size; c++) {
          if (!base.isFunc[r][c] && shouldMask(mask, r, c)) {
            candidate[r][c] ^= 1;
          }
        }
      }
      applyFormat(candidate, mask);
      const score = penaltyScore(candidate);
      if (score < bestScore) {
        bestScore = score;
        bestMask = mask;
        bestMatrix = candidate;
      }
    }

    return bestMatrix;
  }

  function renderQrSvg(svgEl, text) {
    if (!svgEl || typeof document?.createElementNS !== 'function') return;
    const matrix = createQrMatrix(text);
    const size = matrix.length;
    const quiet = 2;
    const full = size + quiet * 2;
    let d = '';
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (matrix[r][c]) {
          d += `M${c + quiet},${r + quiet}h1v1h-1z`;
        }
      }
    }

    const ns = 'http://www.w3.org/2000/svg';
    svgEl.setAttribute('viewBox', `0 0 ${full} ${full}`);
    const bg = document.createElementNS(ns, 'rect');
    bg.setAttribute('width', String(full));
    bg.setAttribute('height', String(full));
    bg.setAttribute('fill', '#ffffff');

    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', '#0e0e10');

    svgEl.replaceChildren(bg, path);
  }

  globalThis.scQr = {
    createQrMatrix,
    renderQrSvg
  };
})();
