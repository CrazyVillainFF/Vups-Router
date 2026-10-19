import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Alert, Button, CircularProgress, TextField } from "@mui/material";
import ArrowOutwardRoundedIcon from "@mui/icons-material/ArrowOutwardRounded";
import RouteRoundedIcon from "@mui/icons-material/RouteRounded";
import { getApiErrorMessage, requestPasswordReset, resetPassword } from "../services/api.js";

function RecoveryLayout({ kicker, heading, intro, children }) {
  return <div className="auth-layout"><div className="auth-art-panel"><Link to="/" className="brand auth-brand"><span className="brand-mark"><RouteRoundedIcon /></span><span>vups<span className="brand-light">router</span></span></Link><div className="auth-art-copy"><div className="eyebrow"><span className="eyebrow-line" /> FREE AI, MADE CLEAR</div><h1>Find your next<br /><span>AI model.</span></h1><p>Compare free access options and open models.</p><div className="auth-art-lines"><span /><span /><span /><span /><span /></div></div><div className="auth-art-foot"><span>FREE AI / CLEAR CHOICES</span><span>VUPSROUTER / 2026</span></div></div>
    <div className="auth-form-panel"><Link to="/" className="back-home">← Back to home</Link><div className="auth-form-wrap"><div className="auth-form-heading"><span className="auth-kicker">{kicker}</span><h2>{heading}</h2><p>{intro}</p></div>
      {children}
    </div><div className="auth-side-note">OPEN MODELS <span>•</span> CHECK THE LIMITS</div></div></div>;
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function handleSubmit(event) {
    event.preventDefault();
    if (busy) return;
    setError("");
    setMessage("");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError("Enter a valid email address.");
      return;
    }
    setBusy(true);
    try {
      const data = await requestPasswordReset(email.trim());
      setMessage(data?.message || "If that email exists, we sent a reset link.");
    } catch (err) {
      setError(getApiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return <RecoveryLayout
    kicker="PASSWORD RECOVERY"
    heading="Forgot your password?"
    intro="Enter the email you signed up with and we will send you a reset link."
  >
    {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
    {message && <Alert severity="success" sx={{ mb: 2 }}>
      {message} The link expires in 30 minutes and can be used once.
    </Alert>}
    <form className="auth-form" onSubmit={handleSubmit}>
      <TextField
        label="Email address"
        type="email"
        value={email}
        onChange={event => setEmail(event.target.value)}
        autoComplete="email"
        autoFocus
        required
      />
      <Button type="submit" variant="contained" fullWidth disabled={busy} endIcon={busy ? <CircularProgress size={17} color="inherit" /> : <ArrowOutwardRoundedIcon />}>
        {busy ? "Sending…" : "Send reset link"}
      </Button>
    </form>
    <div className="auth-switch">Remembered it? <Link to="/signin">Back to sign in</Link></div>
    <p className="auth-terms">For your security, we respond the same way whether or not an account exists for that email.</p>
  </RecoveryLayout>;
}

export function ResetPasswordPage() {
  const location = useLocation();
  const [token, setToken] = useState("");
  const [form, setForm] = useState({ newPassword: "", confirmPassword: "" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const value = new URLSearchParams(location.search).get("token") || "";
    setToken(value);
    if (value) window.history.replaceState(null, "", "/reset-password");
  }, [location.search]);

  async function handleSubmit(event) {
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
      const data = await resetPassword({ token, ...form });
      setMessage(data?.message || "Your password has been reset.");
      setForm({ newPassword: "", confirmPassword: "" });
    } catch (err) {
      setError(getApiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return <RecoveryLayout
    kicker="CHOOSE A NEW PASSWORD"
    heading="Reset your password"
    intro="Pick a new password for your VupsRouter account."
  >
    {!token && <Alert severity="error" sx={{ mb: 2 }}>
      This reset link is missing its token. Request a new link from the <Link to="/forgot-password">forgot password</Link> page.
    </Alert>}
    {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
    {message && <Alert severity="success" sx={{ mb: 2 }}>{message}</Alert>}
    {message
      ? <div className="auth-switch"><Link to="/signin">Go to sign in</Link></div>
      : <form className="auth-form" onSubmit={handleSubmit}>
        <TextField
          label="New password"
          type="password"
          value={form.newPassword}
          onChange={event => setForm(current => ({ ...current, newPassword: event.target.value }))}
          autoComplete="new-password"
          autoFocus
          helperText="At least 8 characters"
          inputProps={{ minLength: 8 }}
          required
        />
        <TextField
          label="Confirm new password"
          type="password"
          value={form.confirmPassword}
          onChange={event => setForm(current => ({ ...current, confirmPassword: event.target.value }))}
          autoComplete="new-password"
          inputProps={{ minLength: 8 }}
          required
        />
        <Button type="submit" variant="contained" fullWidth disabled={busy || !token} endIcon={busy ? <CircularProgress size={17} color="inherit" /> : <ArrowOutwardRoundedIcon />}>
          {busy ? "Resetting…" : "Reset password"}
        </Button>
      </form>}
    <div className="auth-switch">Need a fresh link? <Link to="/forgot-password">Request another</Link></div>
    <p className="auth-terms">Reset links expire after 30 minutes, can be used once, and signing in elsewhere will require your new password.</p>
  </RecoveryLayout>;
}
