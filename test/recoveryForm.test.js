import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PASSWORD_MIN_LENGTH,
  RECOVERY_CODE_TTL_MS,
  RECOVERY_STORAGE_KEY,
  clearRecoveryContext,
  confirmPasswordHint,
  loadRecoveryContext,
  newPasswordHint,
  saveRecoveryContext,
  toggleVisibility,
  updatePasswordDisabled
} from "../src/auth/recoveryForm.js";

function createStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: key => { map.delete(key); },
    size: () => map.size
  };
}

test("updatePasswordDisabled only blocks on busy, length, or mismatch", () => {
  assert.equal(PASSWORD_MIN_LENGTH, 8);
  assert.equal(updatePasswordDisabled({ busy: false, newPassword: "long-enough-1", confirmPassword: "long-enough-1" }), false);
  assert.equal(updatePasswordDisabled({ busy: true, newPassword: "long-enough-1", confirmPassword: "long-enough-1" }), true);
  assert.equal(updatePasswordDisabled({ busy: false, newPassword: "short", confirmPassword: "short" }), true);
  assert.equal(updatePasswordDisabled({ busy: false, newPassword: "long-enough-1", confirmPassword: "long-enough-2" }), true);
  assert.equal(updatePasswordDisabled({ busy: false, newPassword: "", confirmPassword: "" }), true);
  assert.equal(updatePasswordDisabled({ busy: false, newPassword: undefined, confirmPassword: undefined }), true);
});

test("passwords are compared exactly and never trimmed or transformed", () => {
  assert.equal(updatePasswordDisabled({ busy: false, newPassword: " password ", confirmPassword: "password" }), true);
  assert.equal(updatePasswordDisabled({ busy: false, newPassword: " password ", confirmPassword: " password " }), false);
  assert.equal(updatePasswordDisabled({ busy: false, newPassword: "pässwörd-123", confirmPassword: "pässwörd-123" }), false);
});

test("hints explain the length rule and mismatches without leaking into empty fields", () => {
  assert.equal(newPasswordHint(""), "");
  assert.equal(newPasswordHint("abc"), "At least 8 characters");
  assert.equal(newPasswordHint("abcdefgh"), "");
  assert.equal(confirmPasswordHint("abcdefgh", ""), "");
  assert.equal(confirmPasswordHint("abcdefgh", "abcdefgi"), "Passwords do not match");
  assert.equal(confirmPasswordHint("abcdefgh", "abcdefgh"), "");
});

test("eye toggles are independent per field", () => {
  const initial = { new: false, confirm: false };
  const afterNew = toggleVisibility(initial, "new");
  assert.deepEqual(afterNew, { new: true, confirm: false });
  const afterBoth = toggleVisibility(afterNew, "confirm");
  assert.deepEqual(afterBoth, { new: true, confirm: true });
  assert.deepEqual(toggleVisibility(afterBoth, "new"), { new: false, confirm: true });
  assert.deepEqual(initial, { new: false, confirm: false });
});

test("recovery context round-trips through storage", () => {
  const storage = createStorage();
  const context = { email: "alex@example.com", code: "012345", step: "password", sentAt: 1000, expiresAt: 1000 + RECOVERY_CODE_TTL_MS };
  assert.equal(saveRecoveryContext(storage, context), true);
  assert.deepEqual(loadRecoveryContext(storage, 2000), context);
});

test("expired recovery context is rejected and cleared", () => {
  const storage = createStorage();
  saveRecoveryContext(storage, { email: "alex@example.com", code: "012345", step: "code", sentAt: 1000, expiresAt: 2000 });
  assert.equal(loadRecoveryContext(storage, 2001), null);
  assert.equal(storage.getItem(RECOVERY_STORAGE_KEY), null);
});

test("malformed or unsafe recovery context is ignored and cleared", () => {
  for (const raw of ["not json", JSON.stringify({ email: "alex@example.com" }), JSON.stringify({ email: "", step: "code", expiresAt: 9999999999999 }), JSON.stringify({ email: "a@b.co", step: "email", expiresAt: 9999999999999 })]) {
    const storage = createStorage({ [RECOVERY_STORAGE_KEY]: raw });
    assert.equal(loadRecoveryContext(storage, 1000), null, `raw=${raw}`);
    assert.equal(storage.getItem(RECOVERY_STORAGE_KEY), null);
  }
  const longCode = createStorage({ [RECOVERY_STORAGE_KEY]: JSON.stringify({ email: "alex@example.com", code: "123456789", step: "code", sentAt: 1000, expiresAt: 9999999999999 }) });
  assert.equal(loadRecoveryContext(longCode, 2000).code, "123456");
});

test("clearRecoveryContext removes the stored entry, and missing storage never throws", () => {
  const storage = createStorage();
  saveRecoveryContext(storage, { email: "alex@example.com", code: "", step: "code", sentAt: 0, expiresAt: 1 });
  assert.equal(clearRecoveryContext(storage), true);
  assert.equal(storage.getItem(RECOVERY_STORAGE_KEY), null);

  assert.equal(saveRecoveryContext(null, { email: "a@b.co" }), false);
  assert.equal(clearRecoveryContext(null), false);
  assert.equal(loadRecoveryContext(null), null);
});
