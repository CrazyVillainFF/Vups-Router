import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Alert, Button, CircularProgress, IconButton, InputAdornment, TextField } from "@mui/material";
import ArrowOutwardRoundedIcon from "@mui/icons-material/ArrowOutwardRounded";
import CodeSlots from "../components/reactbits/CodeSlots.jsx";
import VupsLogo from "../components/VupsLogo.jsx";
import { getApiErrorMessage, requestPasswordReset, resetPassword, verifyResetCode } from "../services/api.js";
import {
  RECOVERY_CODE_TTL_MS,
  clearRecoveryContext,
  confirmPasswordHint,
  loadRecoveryContext,
  newPasswordHint,
  saveRecoveryContext,
  toggleVisibility,
  updatePasswordDisabled
} from "./recoveryForm.js";

function RecoveryLayout({ kicker, heading, intro, children }) {
  return <div className="auth-layout"><div className="auth-art-panel"><Link to="/" className="brand auth-brand"><span className="brand-mark"><VupsLogo /></span><span>vups<span className="brand-light">router</span></span></Link><div className="auth-art-copy"><div className="eyebrow"><span className="eyebrow-line" /> FREE AI, MADE CLEAR</div><h1>Find your next<br /><span>AI model.</span></h1><p>Compare free access options and open models.</p><div className="auth-art-lines"><span /><span /><span /><span /><span /></div></div><div className="auth-art-foot"><span>FREE AI / CLEAR CHOICES</span><span>VUPSROUTER / 2026</span></div></div>
    <div className="auth-form-panel"><Link to="/" className="back-home">← Back to home</Link><div className="auth-form-wrap"><div className="auth-form-heading"><span className="auth-kicker">{kicker}</span><h2>{heading}</h2><p>{intro}</p></div>
      {children}
    </div><div className="auth-side-note">OPEN MODELS <span>•</span> CHECK THE LIMITS</div></div></div>;
}

function EyeIcon() {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z" /><circle cx="12" cy="12" r="3" /></svg>;
}

function EyeOffIcon() {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" /><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" /><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" /></svg>;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SENT_MESSAGE = "If that email exists, we sent a 6-digit code.";
const STEP_COPY = {
  email: {
    kicker: "PASSWORD RECOVERY",
    heading: "Forgot password?",
    intro: "Enter the email you signed up with and we will send you a 6-digit code."
  },
  code: {
    kicker: "CHECK YOUR INBOX",
    heading: "Enter your code",
    intro: "Type the six-digit code from the email. It expires in 10 minutes."
  },
  password: {
    kicker: "ALMOST DONE",
    heading: "Set a new password",
    intro: "Choose a strong password you have not used here before."
  }
};

export function ForgotPasswordPage() {
  const navigate = useNavigate();
  const storage = typeof window !== "undefined" ? window.sessionStorage : null;
  const [step, setStep] = useState("email");
  const [emailInput, setEmailInput] = useState("");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [slotStatus, setSlotStatus] = useState("idle");
  const [form, setForm] = useState({ newPassword: "", confirmPassword: "" });
  const [visibility, setVisibility] = useState({ new: false, confirm: false });
  const [sendInfo, setSendInfo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const verifyTimer = useRef(null);
  const redirectTimer = useRef(null);
  const sentAtRef = useRef(0);

  useEffect(() => {
    const stored = loadRecoveryContext(storage);
    if (!stored) return;
    sentAtRef.current = stored.sentAt;
    setEmail(stored.email);
    setEmailInput(stored.email);
    setCode(stored.code);
    setStep(stored.step);
  }, [storage]);

  useEffect(() => () => {
    clearTimeout(verifyTimer.current);
    clearTimeout(redirectTimer.current);
  }, []);

  function rememberRecovery(targetEmail, nextStep, nextCode) {
    saveRecoveryContext(storage, {
      email: targetEmail,
      code: nextCode,
      step: nextStep,
      sentAt: sentAtRef.current,
      expiresAt: sentAtRef.current + RECOVERY_CODE_TTL_MS
    });
  }

  function eyeAdornment(field) {
    const visible = visibility[field];
    return <InputAdornment position="end">
      <IconButton
        type="button"
        edge="end"
        aria-label={visible ? "Hide password" : "Show password"}
        onClick={() => setVisibility(current => toggleVisibility(current, field))}
        sx={{ color: "#9aa39a", "&:hover": { color: "#d4ff3f" } }}
      >
        {visible ? <EyeOffIcon /> : <EyeIcon />}
      </IconButton>
    </InputAdornment>;
  }

  async function handleSendCode(event) {
    event?.preventDefault?.();
    if (busy) return;
    const normalized = emailInput.trim().toLowerCase();
    setError("");
    setMessage("");
    if (!EMAIL_PATTERN.test(normalized)) {
      setError("Enter a valid email address.");
      return;
    }
    setBusy(true);
    try {
      const data = await requestPasswordReset(normalized);
      sentAtRef.current = Date.now();
      setEmail(normalized);
      setCode("");
      setSlotStatus("idle");
      setStep("code");
      setMessage(data?.message || SENT_MESSAGE);
      setSendInfo({ remaining: data?.remaining, limit: data?.limit });
      rememberRecovery(normalized, "code", "");
    } catch (err) {
      setError(getApiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleVerify(submitted) {
    const value = String(submitted ?? code);
    if (busy || value.length !== 6) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const data = await verifyResetCode({ email, code: value });
      setSlotStatus("success");
      setMessage(data?.message || "Code verified successfully.");
      rememberRecovery(email, "password", value);
      verifyTimer.current = setTimeout(() => {
        setSlotStatus("idle");
        setMessage("");
        setStep("password");
      }, 650);
    } catch (err) {
      setSlotStatus("error");
      setCode("");
      setError(getApiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleResend() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const data = await requestPasswordReset(email);
      sentAtRef.current = Date.now();
      setCode("");
      setSlotStatus("idle");
      setMessage(data?.message || SENT_MESSAGE);
      setSendInfo({ remaining: data?.remaining, limit: data?.limit });
      rememberRecovery(email, "code", "");
    } catch (err) {
      setError(getApiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleReset(event) {
    event.preventDefault();
    if (busy) return;
    setError("");
    setMessage("");
    if (form.newPassword.length < 8) {
      setError("Use a password with at least 8 characters.");
      return;
    }
    if (form.newPassword !== form.confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      const data = await resetPassword({ email, code, newPassword: form.newPassword });
      setForm({ newPassword: "", confirmPassword: "" });
      setVisibility({ new: false, confirm: false });
      setCode("");
      setSlotStatus("idle");
      setSendInfo(null);
      clearRecoveryContext(storage);
      setMessage(data?.message || "Password updated. Redirecting to sign in…");
      redirectTimer.current = setTimeout(() => navigate("/signin", { replace: true }), 1500);
    } catch (err) {
      setError(getApiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const copy = STEP_COPY[step];

  return <RecoveryLayout kicker={copy.kicker} heading={copy.heading} intro={copy.intro}>
    {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
    {message && <Alert severity="success" sx={{ mb: 2 }}>
      {message}{step === "code" ? " The code is valid for 10 minutes." : ""}
    </Alert>}

    {step === "email" && <form className="auth-form" onSubmit={handleSendCode}>
      <TextField
        label="Email address"
        type="email"
        value={emailInput}
        onChange={event => setEmailInput(event.target.value)}
        autoComplete="email"
        autoFocus
        required
      />
      <Button type="submit" variant="contained" fullWidth disabled={busy} endIcon={busy ? <CircularProgress size={17} color="inherit" /> : <ArrowOutwardRoundedIcon />}>
        {busy ? "Sending…" : "Send code"}
      </Button>
    </form>}

    {step === "code" && <>
      <p className="recovery-target">Enter the 6-digit code sent to <b>{email}</b></p>
      {typeof sendInfo?.remaining === "number" && <p className="recovery-limit">You can request {sendInfo.remaining} more code{sendInfo.remaining === 1 ? "" : "s"} for this email in the next 24 hours.</p>}
      <div className="recovery-code-area">
        <CodeSlots
          length={6}
          value={code}
          status={slotStatus}
          onChange={next => {
            setCode(next);
            if (slotStatus === "error") setSlotStatus("idle");
          }}
          onComplete={handleVerify}
          disabled={busy || slotStatus === "success"}
          autoFocus
          accentColor="#d4ff3f"
          inkColor="#d4ff3f"
          slotColor="#171b1c"
          digitColor="#11140a"
          dangerColor="#ff6b6b"
          slotSize={42}
          gap={8}
          radius={12}
          ariaLabel="Six-digit password reset code"
        />
      </div>
      <div className="recovery-actions">
        <Button
          type="button"
          variant="contained"
          fullWidth
          disabled={busy || slotStatus !== "idle" || code.length !== 6}
          onClick={() => handleVerify()}
          endIcon={busy ? <CircularProgress size={17} color="inherit" /> : <ArrowOutwardRoundedIcon />}
        >
          {busy ? "Verifying…" : "Verify code"}
        </Button>
        <Button type="button" variant="text" fullWidth disabled={busy} onClick={handleResend}>
          Resend code
        </Button>
      </div>
      <div className="auth-switch">Wrong email? <button type="button" className="auth-text-btn" onClick={() => { setStep("email"); setError(""); setMessage(""); setCode(""); setSlotStatus("idle"); setSendInfo(null); clearRecoveryContext(storage); }}>Use a different one</button></div>
    </>}

    {step === "password" && <form className="auth-form" onSubmit={handleReset}>
      <TextField
        label="New password"
        type={visibility.new ? "text" : "password"}
        value={form.newPassword}
        onChange={event => setForm(current => ({ ...current, newPassword: event.target.value }))}
        autoComplete="new-password"
        autoFocus
        helperText={newPasswordHint(form.newPassword) || "At least 8 characters"}
        inputProps={{ minLength: 8 }}
        InputProps={{ endAdornment: eyeAdornment("new") }}
        sx={{ "& .MuiOutlinedInput-input": { pr: 0.5 } }}
        required
      />
      <TextField
        label="Confirm new password"
        type={visibility.confirm ? "text" : "password"}
        value={form.confirmPassword}
        onChange={event => setForm(current => ({ ...current, confirmPassword: event.target.value }))}
        autoComplete="new-password"
        helperText={confirmPasswordHint(form.newPassword, form.confirmPassword)}
        inputProps={{ minLength: 8 }}
        InputProps={{ endAdornment: eyeAdornment("confirm") }}
        sx={{ "& .MuiOutlinedInput-input": { pr: 0.5 } }}
        required
      />
      <Button type="submit" variant="contained" fullWidth disabled={updatePasswordDisabled({ busy, newPassword: form.newPassword, confirmPassword: form.confirmPassword })} endIcon={busy ? <CircularProgress size={17} color="inherit" /> : <ArrowOutwardRoundedIcon />}>
        {busy ? "Updating…" : "Update password"}
      </Button>
    </form>}

    <div className="auth-switch">Remembered it? <Link to="/signin">Back to sign in</Link></div>
    <p className="auth-terms">For your security, we respond the same way whether or not an account exists for that email. Codes expire after 10 minutes and work once.</p>
  </RecoveryLayout>;
}
