/* Minimal QR encoder: byte mode, error-correction level L, versions 1-15, mask 0. No dependencies.
   window.QR.encode(text) -> boolean matrix (or null if too long); window.QR.toCanvas(matrix, moduleSize) -> <canvas>. */
window.QR = (() => {
  const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (() => { let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; })();
  const gmul = (a, b) => (a && b) ? EXP[LOG[a] + LOG[b]] : 0;
  const EC_PER_BLOCK = [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22];
  const BLOCKS = [null, [[1,19]], [[1,34]], [[1,55]], [[1,80]], [[1,108]], [[2,68]], [[2,78]], [[2,97]], [[2,116]], [[2,68],[2,69]], [[4,81]], [[2,92],[2,93]], [[4,107]], [[3,115],[1,116]], [[5,87],[1,88]]];
  const ALIGN = [null, [], [6,18], [6,22], [6,26], [6,30], [6,34], [6,22,38], [6,24,42], [6,26,46], [6,28,50], [6,30,54], [6,32,58], [6,34,62], [6,26,46,66], [6,26,48,70]];
  const totalData = v => BLOCKS[v].reduce((s, [n, d]) => s + n * d, 0);
  const capacity = v => totalData(v) - (v >= 10 ? 3 : 2);
  function bch(data, poly, degree) { let d = data << degree; const top = x => { let n = 0; while (x) { n++; x >>= 1; } return n; }; const pd = top(poly); while (top(d) >= pd) d ^= poly << (top(d) - pd); return d; }
  function rsEC(data, ecLen) {
    let gen = [1];
    for (let i = 0; i < ecLen; i++) { const next = new Array(gen.length + 1).fill(0); for (let j = 0; j < gen.length; j++) { next[j] ^= gen[j]; next[j + 1] ^= gmul(gen[j], EXP[i]); } gen = next; }
    const rem = new Uint8Array(ecLen);
    for (const b of data) { const f = b ^ rem[0]; rem.copyWithin(0, 1); rem[ecLen - 1] = 0; if (f) for (let j = 0; j < ecLen; j++) rem[j] ^= gmul(gen[j + 1], f); }
    return rem;
  }
  function encode(text) {
    const bytes = new TextEncoder().encode(text);
    let v = 0; for (let i = 1; i <= 15; i++) if (bytes.length <= capacity(i)) { v = i; break; }
    if (!v) return null;
    const td = totalData(v), buf = new Uint8Array(td); let bitPos = 0;
    const put = (val, len) => { for (let i = len - 1; i >= 0; i--) { if ((val >> i) & 1) buf[bitPos >> 3] |= 0x80 >> (bitPos & 7); bitPos++; } };
    put(0b0100, 4); put(bytes.length, v >= 10 ? 16 : 8); for (const b of bytes) put(b, 8);
    bitPos = Math.min(bitPos + 4, td * 8); bitPos = (bitPos + 7) & ~7;
    let pad = true; while (bitPos < td * 8) { put(pad ? 0xEC : 0x11, 8); pad = !pad; }
    const ecLen = EC_PER_BLOCK[v], dataBlocks = [], ecBlocks = []; let off = 0;
    for (const [count, dlen] of BLOCKS[v]) for (let i = 0; i < count; i++) { const db = buf.slice(off, off + dlen); off += dlen; dataBlocks.push(db); ecBlocks.push(rsEC(db, ecLen)); }
    const maxD = Math.max(...dataBlocks.map(b => b.length)), out = [];
    for (let i = 0; i < maxD; i++) for (const b of dataBlocks) if (i < b.length) out.push(b[i]);
    for (let i = 0; i < ecLen; i++) for (const b of ecBlocks) out.push(b[i]);
    const size = 17 + 4 * v, m = Array.from({ length: size }, () => new Array(size).fill(null));
    const probe = (r0, c0) => { for (let r = -1; r <= 7; r++) { if (r0 + r < 0 || r0 + r >= size) continue; for (let c = -1; c <= 7; c++) { if (c0 + c < 0 || c0 + c >= size) continue; m[r0 + r][c0 + c] = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6)) || (r >= 2 && r <= 4 && c >= 2 && c <= 4); } } };
    probe(0, 0); probe(size - 7, 0); probe(0, size - 7);
    for (const r0 of ALIGN[v]) for (const c0 of ALIGN[v]) { if (m[r0][c0] !== null) continue; for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++) m[r0 + r][c0 + c] = Math.abs(r) === 2 || Math.abs(c) === 2 || (r === 0 && c === 0); }
    for (let i = 8; i < size - 8; i++) { if (m[i][6] === null) m[i][6] = i % 2 === 0; if (m[6][i] === null) m[6][i] = i % 2 === 0; }
    const fmt = ((8 << 10) | bch(8, 0b10100110111, 10)) ^ 0b101010000010010;
    for (let i = 0; i < 15; i++) { const mod = ((fmt >> i) & 1) === 1; if (i < 6) m[i][8] = mod; else if (i < 8) m[i + 1][8] = mod; else m[size - 15 + i][8] = mod; if (i < 8) m[8][size - i - 1] = mod; else if (i < 9) m[8][15 - i] = mod; else m[8][14 - i] = mod; }
    m[size - 8][8] = true;
    if (v >= 7) { const vi = (v << 12) | bch(v, 0b1111100100101, 12); for (let i = 0; i < 18; i++) { const mod = ((vi >> i) & 1) === 1; m[Math.floor(i / 3)][i % 3 + size - 11] = mod; m[i % 3 + size - 11][Math.floor(i / 3)] = mod; } }
    let inc = -1, row = size - 1, bitIndex = 7, byteIndex = 0;
    for (let col = size - 1; col > 0; col -= 2) { if (col === 6) col--; for (;;) { for (let c = 0; c < 2; c++) { if (m[row][col - c] === null) { let dark = false; if (byteIndex < out.length) dark = ((out[byteIndex] >>> bitIndex) & 1) === 1; if ((row + col - c) % 2 === 0) dark = !dark; m[row][col - c] = dark; if (--bitIndex === -1) { byteIndex++; bitIndex = 7; } } } row += inc; if (row < 0 || row >= size) { row -= inc; inc = -inc; break; } } }
    return m;
  }
  function toCanvas(matrix, moduleSize, quiet = 4) {
    const n = matrix.length, cv = document.createElement('canvas'); cv.width = cv.height = (n + quiet * 2) * moduleSize;
    const ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height); ctx.fillStyle = '#000';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (matrix[r][c]) ctx.fillRect((c + quiet) * moduleSize, (r + quiet) * moduleSize, moduleSize, moduleSize);
    return cv;
  }
  return { encode, toCanvas };
})();
