import test from "node:test";
import assert from "node:assert/strict";
import {
  ACCOUNT_PROFILE_KEY,
  LOCAL_PROFILE_KEY,
  LOCAL_PROFILE_NAME,
  createProfileStore,
  normalizeProfile,
  profileToUser
} from "../src/auth/localProfile.js";

function memoryStorage() {
  const values = new Map();
  return {
    values,
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  };
}

function storeWith(storage = memoryStorage(), createId) {
  let tick = 0;
  return createProfileStore(storage, {
    now: () => `2026-11-16T00:00:0${tick++}Z`,
    ...(createId ? { createId } : {})
  });
}

test("an account receipt keeps only the identity the backend confirmed", () => {
  const storage = memoryStorage();
  const store = storeWith(storage);
  const profile = store.saveAccountProfile({
    id: "user-1",
    name: "  Vishnu  ",
    email: "  PERSON@Example.COM ",
    password: "must-not-be-stored",
    token: "must-not-be-stored",
    providerApiKey: "must-not-be-stored"
  });

  assert.deepEqual(profile, {
    id: "user-1",
    kind: "account",
    name: "Vishnu",
    email: "person@example.com",
    savedAt: "2026-11-16T00:00:00Z"
  });
  const raw = storage.getItem(ACCOUNT_PROFILE_KEY);
  assert.equal(raw.includes("must-not-be-stored"), false);
  assert.equal(raw.includes("password"), false);
  assert.equal(store.readAccountProfile().id, "user-1");
});

test("a profile without an id is not an identity", () => {
  const store = storeWith();
  assert.equal(store.saveAccountProfile({ name: "No id" }), null);
  assert.equal(store.readAccountProfile(), null);
});

test("the local profile is created once and reused on this device", () => {
  const store = storeWith();
  const first = store.ensureLocalProfile();
  const second = store.ensureLocalProfile();
  assert.equal(first.kind, "local");
  assert.equal(first.name, LOCAL_PROFILE_NAME);
  assert.equal(first.email, "");
  assert.equal(first.id, second.id);
  assert.match(first.id, /^local-/);
});

test("local ids differ between device profiles", () => {
  const first = storeWith().ensureLocalProfile();
  const second = storeWith().ensureLocalProfile();
  assert.notEqual(first.id, second.id);
});

test("signing out clears the account receipt but keeps the device profile", () => {
  const storage = memoryStorage();
  const store = storeWith(storage);
  store.saveAccountProfile({ id: "user-1", name: "Vishnu", email: "v@example.com" });
  const local = store.ensureLocalProfile();

  store.clearAccountProfile();

  assert.equal(store.readAccountProfile(), null);
  assert.equal(store.readLocalProfile().id, local.id);
  assert.equal(storage.getItem(ACCOUNT_PROFILE_KEY), null);
});

test("a local receipt is never mistaken for a verified account", () => {
  const store = storeWith();
  const local = store.ensureLocalProfile();
  assert.equal(store.readAccountProfile(), null);
  assert.equal(profileToUser(local).local, true);
  assert.equal(profileToUser({ id: "user-1", kind: "account", email: "x@y.z" }).local, false);
});

test("normalization bounds what is shown and rejects non-objects", () => {
  const longName = "x".repeat(200);
  const longEmail = `${"x".repeat(300)}@example.com`;
  const profile = normalizeProfile({
    id: "user-1",
    kind: "account",
    name: longName,
    email: longEmail,
    savedAt: "now"
  });
  assert.equal(profile.name.length, 80);
  assert.equal(profile.email.length, 254);
  assert.equal(normalizeProfile(null), null);
  assert.equal(normalizeProfile("user-1"), null);
  assert.equal(normalizeProfile({ id: "   " }), null);
});

test("storage refusal still yields a usable in-memory identity", () => {
  const refusing = {
    getItem: () => null,
    setItem: () => {
      throw new Error("quota");
    },
    removeItem: () => {}
  };
  const store = createProfileStore(refusing, { createId: () => "local-fixed" });
  const profile = store.ensureLocalProfile();
  assert.equal(profile.id, "local-fixed");
  assert.equal(profileToUser(profile).local, true);
});

test("the local profile storage key is separate from the account key", () => {
  const storage = memoryStorage();
  const store = storeWith(storage);
  store.saveAccountProfile({ id: "user-1", name: "Account" });
  store.ensureLocalProfile();
  assert.ok(storage.values.has(ACCOUNT_PROFILE_KEY));
  assert.ok(storage.values.has(LOCAL_PROFILE_KEY));
  assert.notEqual(ACCOUNT_PROFILE_KEY, LOCAL_PROFILE_KEY);
});
