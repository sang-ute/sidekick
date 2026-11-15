// Draws the app icon (blue mascot face with a sparkle) into assets/icon.png. No dependencies.
const fs = require("fs"), zlib = require("zlib"), path = require("path");
const S = 256, px = Buffer.alloc(S * S * 4);
const inRect = (x, y, cx, cy, w, h, r) => {
  const dx = Math.max(Math.abs(x - cx) - (w / 2 - r), 0), dy = Math.max(Math.abs(y - cy) - (h / 2 - r), 0);
  return dx * dx + dy * dy <= r * r;
};
const inEllipse = (x, y, cx, cy, rx, ry) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
// 4-point sparkle (astroid): |dx|^0.5 + |dy|^0.5 <= r^0.5
const inSparkle = (x, y, cx, cy, r) => Math.sqrt(Math.abs(x - cx)) + Math.sqrt(Math.abs(y - cy)) <= Math.sqrt(r);
const mix = (a, b, t) => a.map((v, k) => v + (b[k] - v) * t);
const TOP = [143, 208, 255], BOTTOM = [47, 127, 216]; // #8fd0ff → #2f7fd8
for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
  const i = (y * S + x) * 4, d = Math.hypot(x - 128 + 0.5, y - 128 + 0.5);
  if (d > 124) continue;
  const t = Math.min(1, Math.hypot(x - 80, y - 70) / 210);
  let [r, g, b] = mix(TOP, BOTTOM, t);
  if (inEllipse(x, y, 128, 206, 56, 22)) [r, g, b] = mix([r, g, b], [255, 255, 255], 0.16); // belly
  const sm = Math.hypot(x - 128, y - 150);
  if (y > 156 && sm >= 15 && sm <= 20.5) [r, g, b] = [20, 36, 58]; // smile
  if (inEllipse(x, y, 74, 160, 15, 9) || inEllipse(x, y, 182, 160, 15, 9)) [r, g, b] = mix([r, g, b], [255, 159, 180], 0.55); // cheeks
  if (inRect(x, y, 100, 128, 28, 44, 14) || inRect(x, y, 156, 128, 28, 44, 14)) [r, g, b] = [20, 36, 58]; // eyes
  if (inEllipse(x, y, 106, 118, 6, 6) || inEllipse(x, y, 162, 118, 6, 6)) [r, g, b] = [255, 255, 255]; // eye shine
  if (inSparkle(x, y, 190, 58, 30)) [r, g, b] = mix([255, 255, 255], [207, 232, 255], Math.min(1, Math.hypot(x - 190, y - 58) / 30));
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
