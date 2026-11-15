// Draws the bubble icon (coral circle with two eyes) into assets/icon.png. No dependencies.
const fs = require("fs"), zlib = require("zlib"), path = require("path");
const S = 256, px = Buffer.alloc(S * S * 4);
const inRect = (x, y, cx, cy, w, h, r) => {
  const dx = Math.max(Math.abs(x - cx) - (w / 2 - r), 0), dy = Math.max(Math.abs(y - cy) - (h / 2 - r), 0);
  return dx * dx + dy * dy <= r * r;
};
for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
  const i = (y * S + x) * 4, d = Math.hypot(x - 128 + 0.5, y - 128 + 0.5);
  if (d > 124) continue;
  const t = Math.min(1, Math.hypot(x - 90, y - 80) / 200);
  let [r, g, b] = [240 - 55 * t, 162 - 70 * t, 131 - 69 * t];
  if (inRect(x, y, 100, 128, 26, 46, 13) || inRect(x, y, 156, 128, 26, 46, 13)) [r, g, b] = [255, 255, 255];
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = d > 123 ? 128 : 255;
}
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const v of b) c = crcT[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
fs.writeFileSync(path.join(__dirname, "..", "assets", "icon.png"), png);
console.log("wrote assets/icon.png", png.length, "bytes");
