const fs = require("fs");
const crypto = require("crypto");

const b = fs.readFileSync(process.argv[2]);
const eocd = b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
const cd = b.readUInt32LE(eocd + 16);
const count = b.readUInt16LE(eocd + 10);

const entries = [];
let p = cd;
for (let i = 0; i < count; i++) {
  const method = b.readUInt16LE(p + 10);
  const cs = b.readUInt32LE(p + 20);
  const us = b.readUInt32LE(p + 24);
  const nl = b.readUInt16LE(p + 28);
  const el = b.readUInt16LE(p + 30);
  const cl = b.readUInt16LE(p + 32);
  const name = b.toString("utf8", p + 46, p + 46 + nl);
  const lho = b.readUInt32LE(p + 42);
  const lnl = b.readUInt16LE(lho + 26);
  const lel = b.readUInt16LE(lho + 28);
  const start = lho + 30 + lnl + lel;
  entries.push({ name, method, cs, us, start });
  p += 46 + nl + el + cl;
}

const byName = new Map(entries.map(e => [e.name, e]));
function bytes(name) {
  const e = byName.get(name);
  if (!e) return null;
  const raw = b.subarray(e.start, e.start + (e.method === 8 ? e.cs : e.us));
  return e.method === 8 ? crypto.decompressSync ? raw : require("zlib").inflateRawSync(raw) : raw;
}

const manifest = bytes("META-INF/MANIFEST.MF").toString("utf8");
const sf = bytes("META-INF/CERT.SF").toString("utf8");

function parseDigests(text) {
  const out = new Map();
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (line === "") { current = null; continue; }
    const m = /^(Name):\s*(.*)$/.exec(line);
    if (m) { current = m[2]; out.set(current, {}); continue; }
    const d = /^(SHA-256-Digest|Digest-Manifest|SHA-256-Digest-Manifest):\s*(.*)$/.exec(line);
    if (d && current !== null) out.get(current)[d[1]] = d[2];
    else if (d && current === null) out.set("__main__", { ...(out.get("__main__") || {}), [d[1]]: d[2] });
  }
  return out;
}

const mf = parseDigests(manifest);
const sfSections = parseDigests(sf);
const b64 = buf => crypto.createHash("sha256").update(buf).digest("base64");

let checked = 0, mismatch = [];
for (const [name, rec] of mf) {
  if (name === "__main__") continue;
  if (!byName.has(name)) { mismatch.push({ name, problem: "listed in MANIFEST.MF but absent from zip" }); continue; }
  const data = bytes(name);
  if (data === null) continue;
  if (name.startsWith("META-INF/")) continue;
  checked++;
  const got = b64(data);
  if (rec["SHA-256-Digest"] && got !== rec["SHA-256-Digest"]) {
    mismatch.push({ name, problem: "digest differs from MANIFEST.MF", expected: rec["SHA-256-Digest"], actual: got });
  }
  const sfRec = sfSections.get(name);
  if (sfRec && sfRec["SHA-256-Digest"] && rec["SHA-256-Digest"] && sfRec["SHA-256-Digest"] !== rec["SHA-256-Digest"]) {
    mismatch.push({ name, problem: "CERT.SF disagrees with MANIFEST.MF" });
  }
}

const mainSf = sfSections.get("__main__") || {};
const mfBuf = bytes("META-INF/MANIFEST.MF");
console.log("files verified against v1 digests:", checked);
console.log("manifest digest in CERT.SF:", mainSf["SHA-256-Digest-Manifest"] || mainSf["Digest-Manifest"] || "(none captured by parser)");
console.log("recomputed SHA-256 of MANIFEST.MF:", b64(mfBuf));
console.log("mismatches:", mismatch.length);
mismatch.slice(0, 12).forEach(m => console.log("  ", JSON.stringify(m)));
console.log("signed-file block present:", /BEGIN PKCS7/.test(sf));
console.log("creation date in MANIFEST.MF:", (/^\s*Created-By:.*$/m.exec(manifest) || ["(none)"])[0], "|", (/^\s*Built-By:.*$/m.exec(manifest) || ["(none)"])[0]);
