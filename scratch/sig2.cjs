const fs = require("fs");
const crypto = require("crypto");

const b = fs.readFileSync(process.argv[2]);
const eocd = b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
const cd = b.readUInt32LE(eocd + 16);
const magicAt = cd - 16;
const size = Number(b.readBigUInt64LE(magicAt - 8));
const regionStart = magicAt - 8 - size;

console.log("centralDir", cd, "magic", magicAt, "sizeField", size, "regionStart", regionStart);

const ids = {
  v2: [0x1a, 0x87, 0x09, 0x71],
  v3: [0xc0, 0x68, 0x53, 0xf0],
  v31: [0xd4, 0x4f, 0x5f, 0x1b],
  ROID: [0x52, 0x49, 0x4f, 0x52],
  proof: [0x4e, 0x44, 0x46, 0x21]
};
for (const [k, bytes] of Object.entries(ids)) {
  console.log("  id", k, "->", b.indexOf(Buffer.from(bytes), regionStart, magicAt));
}
console.log("region head hex:", b.subarray(regionStart, regionStart + 40).toString("hex"));

const certs = [];
for (let i = regionStart; i < magicAt; i++) {
  if (b[i] === 0x30 && b[i + 1] === 0x82) {
    const len = 2 + b.readUInt16BE(i + 2) + 2;
    if (i + len <= magicAt) {
      try {
        const x = new crypto.X509Certificate(b.subarray(i, i + len));
        certs.push({
          at: i,
          len,
          subject: x.subject.replace(/\r?\n/g, " / "),
          issuer: x.issuer.replace(/\r?\n/g, " / "),
          from: x.validFrom,
          to: x.validTo,
          alg: x.sigAlg
        });
      } catch (e) { /* not a DER certificate */ }
    }
  }
}
const seen = new Set();
const uniq = [];
for (const c of certs) {
  const k = c.subject + c.to;
  if (!seen.has(k)) { seen.add(k); uniq.push(c); }
}
console.log("certificates:", uniq.length);
uniq.forEach(c => console.log(JSON.stringify(c)));
