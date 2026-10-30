// Regression tests for the certificate extraction that gates every Android
// publish. The gate's two signature-identity checks failed in CI on an APK that
// apksigner verified successfully, which is only possible if the identity was
// lost while parsing the tools' text — so the parsing rules are pinned here,
// including the output shapes the SDK and the JDK actually emit.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import path from "node:path";
import { looksLikeDebugCertificate, readApksignerCertificate, readKeytoolCertificate } from "../scripts/android-signature-reader.mjs";

// Captured from `apksigner verify --verbose --print-certs` on Build Tools
// 35.0.1 and 36.0.0 against the real debug APK.
const APKSIGNER_DEBUG_OUTPUT = [
  "Verifies",
  "Verified using v1 scheme (JAR signing): true",
  "Verified using v2 scheme (APK Signature Scheme v2): true",
  "Verified using v3 scheme (APK Signature Scheme v3): false",
  "Verified for SourceStamp: false",
  "Number of signers: 1",
  "Signer #1 certificate DN: C=US, O=Android, CN=Android Debug",
  "Signer #1 certificate SHA-256 digest: 2ecdb04bc852492e3d21f72937a5ce68354a4bfde9fb29b9a2ff49f632f0546f",
  "Signer #1 certificate SHA-1 digest: a2fd9fedbff3e8a3dbbb7b6325d74c7911b267d0",
  "Signer #1 key algorithm: RSA",
  "WARNING: META-INF/services/java.security.Provider not protected by signature."
].join("\n");

const KEYTOOL_DEBUG_OUTPUT = [
  "Signer #1:",
  "Certificate #1:",
  "Owner: C=US, O=Android, CN=Android Debug",
  "Issuer: C=US, O=Android, CN=Android Debug",
  "Serial number: 1",
  "Certificate fingerprints:",
  "\t SHA1: A2:FD:9F:ED:BF:F3:E8:A3:DB:BB:7B:63:25:D7:4C:79:11:B2:67:D0",
  "\t SHA256: 2E:CD:B0:4B:C8:52:49:2E:3D:21:F7:29:37:A5:CE:68:35:4A:4B:FD:E9:FB:29:B9:A2:FF:49:F6:32:F0:54:6F",
  "Signature algorithm name: SHA256withRSA"
].join("\n");

test("apksigner output yields the subject and the lower-case hex fingerprint", () => {
  const cert = readApksignerCertificate(APKSIGNER_DEBUG_OUTPUT);
  assert.equal(cert.subject, "C=US, O=Android, CN=Android Debug");
  assert.equal(cert.sha256, "2ecdb04bc852492e3d21f72937a5ce68354a4bfde9fb29b9a2ff49f632f0546f");
  assert.equal(cert.certificateCount, 1);
  assert.equal(cert.signerCount, 1);
  assert.equal(cert.reader, "apksigner");
});

test("the certificate block is found whichever stream it was printed on", () => {
  // The gate hands the reader stdout and stderr merged; a block that only ever
  // appeared on stderr must still yield the identity.
  const cert = readApksignerCertificate(`\n${APKSIGNER_DEBUG_OUTPUT}`);
  assert.equal(cert.subject, "C=US, O=Android, CN=Android Debug");
  assert.equal(cert.sha256, "2ecdb04bc852492e3d21f72937a5ce68354a4bfde9fb29b9a2ff49f632f0546f");
});

const ROTATION_SHA256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

test("v3 rotation and source-stamp signer labels are parsed, not skipped", () => {
  const cert = readApksignerCertificate(
    [
      "Number of signers: 1",
      "Signer (minSdkVersion=30, maxSdkVersion=0) certificate DN: CN=VupsRouter, OU=Releases, O=VupsRouter, C=US",
      `Signer (minSdkVersion=30, maxSdkVersion=0) certificate SHA-256 digest: ${ROTATION_SHA256}`
    ].join("\n")
  );
  assert.equal(cert.subject, "CN=VupsRouter, OU=Releases, O=VupsRouter, C=US");
  assert.equal(cert.sha256, ROTATION_SHA256);
});

test("colon-separated fingerprints are normalised before comparison", () => {
  const cert = readKeytoolCertificate(KEYTOOL_DEBUG_OUTPUT);
  assert.equal(cert.subject, "C=US, O=Android, CN=Android Debug");
  assert.equal(cert.sha256, "2ecdb04bc852492e3d21f72937a5ce68354a4bfde9fb29b9a2ff49f632f0546f");
  assert.equal(cert.certificateCount, 1);
  assert.equal(
    cert.sha256,
    readApksignerCertificate(APKSIGNER_DEBUG_OUTPUT).sha256,
    "the SDK and the JDK must agree on the same APK"
  );
});

test("a certificate chain is reported as unreadable-by-count so it cannot be compared as one signer", () => {
  const chain = readKeytoolCertificate(`${KEYTOOL_DEBUG_OUTPUT}\n\nSigner #2:\nCertificate #1:\nOwner: CN=Intermediate, O=CA, C=US`);
  assert.equal(chain.certificateCount, 2);
});

test("output without a certificate yields no identity instead of a guess", () => {
  for (const empty of ["", "Verifies", "DOES NOT VERIFY", "Signer #1 certificate DN: ", "Number of signers: 0"]) {
    const cert = readApksignerCertificate(empty);
    assert.equal(cert.subject, "", `nothing readable may become a subject (input: ${JSON.stringify(empty)})`);
    assert.equal(cert.sha256, "");
    assert.equal(looksLikeDebugCertificate(cert.subject), false, "a missing certificate must never read as debug-signed");
  }
  assert.equal(readKeytoolCertificate("keytool error: java.lang.Exception: Not a valid jar file").subject, "");
});

test("debug signing is recognised in either subject order and release signing is not", () => {
  assert.equal(looksLikeDebugCertificate("C=US, O=Android, CN=Android Debug"), true);
  assert.equal(looksLikeDebugCertificate("CN=Android Debug, O=Android, C=US"), true);
  assert.equal(looksLikeDebugCertificate("CN=Android Debug,OU=Android,C=US"), true);
  assert.equal(looksLikeDebugCertificate("androiddebugkey"), true);
  assert.equal(looksLikeDebugCertificate("CN=VupsRouter, OU=Releases, O=VupsRouter, C=US"), false);
  assert.equal(looksLikeDebugCertificate("CN=Android Debug Services, O=Example, C=US"), false);
});

test("the gate parses merged output and keeps both readers required to agree", () => {
  const gate = readFileSync(path.join(import.meta.dirname, "..", "scripts", "verify-android-artifact.mjs"), "utf8");
  assert.match(gate, /readApksignerCertificate\(signature\.all\)/, "certificate text must include stderr");
  assert.doesNotMatch(gate, /readApksignerCertificate\(signature\.stdout\)/);
  assert.match(gate, /readKeytoolCertificate\(crossCheck\.all\)/);
  assert.match(gate, /the SDK and the JDK read the same signing certificate/, "the two readers must be cross-checked");
  assert.match(gate, /looksLikeDebugCertificate\(signer\)/, "debug identity must come from the certificate subject");
  assert.match(gate, /check\(Boolean\(signer\), "the signer certificate subject is readable"/);
  assert.match(gate, /check\(\s*expectDebugKey \? isDebugKey : !isDebugKey,/s);
});
