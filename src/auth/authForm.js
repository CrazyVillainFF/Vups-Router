import { PASSWORD_MIN_LENGTH } from "./recoveryForm.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function initialPasswordVisibility() {
  return { password: false, confirmPassword: false };
}

export function togglePasswordVisibility(state, field) {
  if (field !== "password" && field !== "confirmPassword") return state;
  return { ...state, [field]: !state[field] };
}

export function validateAuthField(key, value) {
  const text = typeof value === "string" ? value : "";
  if (key === "name") return text.trim().length < 2 ? "Enter your name (at least 2 characters)." : "";
  if (key === "email") return EMAIL_PATTERN.test(text.trim()) ? "" : "Enter a valid email address.";
  if (key === "password") return text.length < PASSWORD_MIN_LENGTH ? "Use a password with at least 8 characters." : "";
  return "";
}

export function confirmPasswordError(password, confirmation) {
  const value = typeof confirmation === "string" ? confirmation : "";
  if (value.length === 0) return "Confirm your password.";
  return (typeof password === "string" ? password : "") !== value ? "Passwords do not match." : "";
}

export function authFormError(mode, form) {
  const values = form ?? {};
  if (mode === "signup") {
    const nameError = validateAuthField("name", values.name);
    if (nameError) return nameError;
  }
  const emailError = validateAuthField("email", values.email);
  if (emailError) return emailError;
  const passwordError = validateAuthField("password", values.password);
  if (passwordError) return passwordError;
  if (mode === "signup") return confirmPasswordError(values.password, values.confirmPassword);
  return "";
}

export function buildAuthPayload(mode, form) {
  const values = form ?? {};
  const payload = {
    email: typeof values.email === "string" ? values.email.trim() : "",
    password: typeof values.password === "string" ? values.password : ""
  };
  if (mode === "signup") {
    return {
      name: typeof values.name === "string" ? values.name.trim() : "",
      ...payload
    };
  }
  return payload;
}
