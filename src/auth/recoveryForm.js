export const RECOVERY_STORAGE_KEY = "vups-recovery-context";
export const PASSWORD_MIN_LENGTH = 8;
export const RECOVERY_CODE_TTL_MS = 10 * 60 * 1000;

export function updatePasswordDisabled({ busy, newPassword, confirmPassword }) {
  const value = typeof newPassword === "string" ? newPassword : "";
  const confirmation = typeof confirmPassword === "string" ? confirmPassword : "";
  return Boolean(busy) || value.length < PASSWORD_MIN_LENGTH || value !== confirmation;
}

export function newPasswordHint(newPassword) {
  const value = typeof newPassword === "string" ? newPassword : "";
  return value.length > 0 && value.length < PASSWORD_MIN_LENGTH ? "At least 8 characters" : "";
}

export function confirmPasswordHint(newPassword, confirmPassword) {
  const confirmation = typeof confirmPassword === "string" ? confirmPassword : "";
  if (confirmation.length === 0) return "";
  return newPassword !== confirmPassword ? "Passwords do not match" : "";
}

export function toggleVisibility(state, field) {
  return { ...state, [field]: !state[field] };
}

export function saveRecoveryContext(storage, context) {
  try {
    storage.setItem(RECOVERY_STORAGE_KEY, JSON.stringify(context));
    return true;
  } catch {
    return false;
  }
}

export function clearRecoveryContext(storage) {
  try {
    storage.removeItem(RECOVERY_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

export function loadRecoveryContext(storage, now = Date.now()) {
  let raw = null;
  try {
    raw = storage.getItem(RECOVERY_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }

  const email = typeof parsed?.email === "string" ? parsed.email : "";
  const code = typeof parsed?.code === "string" ? parsed.code.slice(0, 6) : "";
  const step = parsed?.step === "code" || parsed?.step === "password" ? parsed.step : null;
  const sentAt = Number(parsed?.sentAt);
  const expiresAt = Number(parsed?.expiresAt);
  const valid = email && step && Number.isFinite(expiresAt) && expiresAt > now;

  if (!valid) {
    clearRecoveryContext(storage);
    return null;
  }
  return { email, code, step, sentAt: Number.isFinite(sentAt) ? sentAt : 0, expiresAt };
}
