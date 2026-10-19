import assert from "node:assert/strict";
import { test } from "node:test";
import {
  authFormError,
  buildAuthPayload,
  confirmPasswordError,
  initialPasswordVisibility,
  togglePasswordVisibility,
  validateAuthField
} from "../src/auth/authForm.js";

test("sign-in password visibility is concealed by default and toggles without touching values", () => {
  const initial = initialPasswordVisibility();
  assert.deepEqual(initial, { password: false, confirmPassword: false });
  const revealed = togglePasswordVisibility(initial, "password");
  assert.deepEqual(revealed, { password: true, confirmPassword: false });
  const concealed = togglePasswordVisibility(revealed, "password");
  assert.deepEqual(concealed, { password: false, confirmPassword: false });
  assert.deepEqual(initial, { password: false, confirmPassword: false }, "the previous state must not be mutated");
});

test("sign-up password and confirm-password toggles are independent", () => {
  let state = initialPasswordVisibility();
  state = togglePasswordVisibility(state, "password");
  assert.deepEqual(state, { password: true, confirmPassword: false });
  state = togglePasswordVisibility(state, "confirmPassword");
  assert.deepEqual(state, { password: true, confirmPassword: true });
  state = togglePasswordVisibility(state, "confirmPassword");
  assert.deepEqual(state, { password: true, confirmPassword: false });
  state = togglePasswordVisibility(state, "password");
  assert.deepEqual(state, { password: false, confirmPassword: false });
});

test("matching passwords allow registration and empty confirmations block it", () => {
  const form = { name: "Alex", email: "alex@example.com", password: "correct-horse", confirmPassword: "correct-horse" };
  assert.equal(authFormError("signup", form), "");
  assert.equal(authFormError("signup", { ...form, confirmPassword: "" }), "Confirm your password.");
  assert.equal(confirmPasswordError("correct-horse", ""), "Confirm your password.");
});

test("mismatched passwords prevent registration until both fields match again", () => {
  const form = { name: "Alex", email: "alex@example.com", password: "correct-horse", confirmPassword: "correct-horsf" };
  assert.equal(authFormError("signup", form), "Passwords do not match.");
  assert.equal(confirmPasswordError(form.password, form.confirmPassword), "Passwords do not match.");
  assert.equal(confirmPasswordError(form.password, form.password), "");
});

test("existing name, email, and password rules are preserved", () => {
  const valid = { name: "Alex", email: "alex@example.com", password: "correct-horse", confirmPassword: "correct-horse" };
  assert.match(authFormError("signup", { ...valid, name: "A" }), /at least 2 characters/);
  assert.match(authFormError("signup", { ...valid, email: "not-an-email" }), /valid email/);
  assert.match(authFormError("signup", { ...valid, password: "short", confirmPassword: "short" }), /at least 8 characters/);
  assert.equal(validateAuthField("password", "12345678"), "");
  assert.equal(authFormError("signin", { email: "alex@example.com", password: "correct-horse" }), "");
});

test("registration payload sends only the password, never confirm-password", () => {
  const payload = buildAuthPayload("signup", {
    name: "  Alex  ",
    email: "  alex@example.com  ",
    password: "  correct horse  ",
    confirmPassword: "  correct horse  "
  });
  assert.deepEqual(payload, {
    name: "Alex",
    email: "alex@example.com",
    password: "  correct horse  "
  });
  assert.equal("confirmPassword" in payload, false);
  assert.equal("confirm" in payload, false);
});

test("sign-in payload keeps its existing shape and exact password", () => {
  const payload = buildAuthPayload("signin", {
    name: "Ignored",
    email: " alex@example.com ",
    password: " correct-horse ",
    confirmPassword: "different"
  });
  assert.deepEqual(payload, { email: "alex@example.com", password: " correct-horse " });
  assert.equal("confirmPassword" in payload, false);
  assert.equal("name" in payload, false);
});
