// Extracts the signing certificate identity from the two tools that can read an
// APK signature: the SDK's `apksigner` and the JDK's `keytool`.
//
// The pre-publish gate refuses to publish unless it can name the certificate
// that signed the APK, and that decision used to rest on one hard-coded match
// against `apksigner verify --print-certs` text. That text is human-readable
// output from a binary the runner chooses at build time, so a signer label
// change or a stream change reads as "no certificate" and fails a correctly
// signed build. Both readers here return the same shape, which lets the gate
// cross-check them instead of trusting one formatter.
const SIGNER_DN_LINE = /^(?<label>.*?)certificate\s+DN\s*:\s*(?<value>\S[^\r\n]*)/i;
const SIGNER_SHA256_LINE = /^(?<label>.*?)certificate\s+SHA-256\s+digest\s*:\s*(?<value>[0-9a-fA-F:]{64,95})\s*$/i;
const SIGNER_COUNT_LINE = /^Number of signers\s*:\s*(?<value>\d+)/im;
// `keytool -printcert -jarfile` prints one block per signer: `Owner:` is the
// subject and the fingerprints are colon-separated hex under
// `Certificate fingerprints:`.
const KEYTOOL_OWNER_LINE = /^Owner\s*:\s*(?<value>\S[^\r\n]*)/im;
const KEYTOOL_SHA256_LINE = /\bSHA-?256\s*:\s*(?<value>[0-9a-fA-F:]{64,95})\s*$/im;

const hex = value => String(value || "").replace(/:/g, "").toLowerCase();

function scan(text, linePattern) {
  const matches = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const found = linePattern.exec(line);
    if (!found) continue;
    const value = (found.groups.value ?? "").trim();
    if (value) matches.push(value);
  }
  return matches;
}

function labelOf(text) {
  const first = /^(?<label>[^\r\n]*?)certificate\s+DN/im.exec(String(text || ""));
  return first?.groups.label?.trim() || "";
}

export function readApksignerCertificate(text) {
  const body = String(text || "");
  const subjects = scan(body, SIGNER_DN_LINE);
  const digests = scan(body, SIGNER_SHA256_LINE).map(hex).filter(value => /^[0-9a-f]{64}$/.test(value));
  const signerCount = Number(SIGNER_COUNT_LINE.exec(body)?.groups.value ?? NaN);
  return {
    reader: "apksigner",
    // The first signer is the one that must match a previously published APK,
    // so only it is compared against the pinned identity.
    subject: subjects[0] ?? "",
    sha256: digests[0] ?? "",
    certificateCount: subjects.length,
    signerCount: Number.isNaN(signerCount) ? null : signerCount,
    label: labelOf(body)
  };
}

export function readKeytoolCertificate(text) {
  const body = String(text || "");
  const subjects = scan(body, KEYTOOL_OWNER_LINE);
  const digests = scan(body, KEYTOOL_SHA256_LINE).map(hex).filter(value => /^[0-9a-f]{64}$/.test(value));
  return {
    reader: "keytool",
    subject: subjects[0] ?? "",
    sha256: digests[0] ?? "",
    certificateCount: subjects.length,
    signerCount: null,
    label: subjects.length ? "Owner" : ""
  };
}

// AGP signs debug builds with a keystore whose subject is fixed, and the
// `androiddebugkey` alias is the other half of the same convention. A release
// certificate must never look like either, which is what the gate uses this for
// in both directions. The subject is matched as a whole RDN value, so a
// certificate that merely starts with "Android Debug ..." is not debug.
export function looksLikeDebugCertificate(subject) {
  return /androiddebugkey|CN\s*=\s*Android Debug\s*(?:,|$)/i.test(String(subject || ""));
}
