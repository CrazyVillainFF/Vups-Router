import React, { useEffect, useState } from "react";
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { Button, TextField, Alert, CircularProgress, IconButton, InputAdornment } from "@mui/material";
import ChatPage from "./ChatPage.jsx";
import SettingsPage from "./SettingsPage.jsx";
import VupsLogo from "./components/VupsLogo.jsx";
import PageMeta from "./components/PageMeta.jsx";
import { PrivacyPolicy, TermsOfService, CookiePolicy } from "./legal/LegalPages.jsx";
import { ForgotPasswordPage } from "./auth/PasswordRecovery.jsx";
import { AuthProvider, useAuth } from "./context/AuthContext.jsx";
import ArrowOutwardRoundedIcon from "@mui/icons-material/ArrowOutwardRounded";
import { AboutPage, FeaturesPage, NotFoundPage } from "./pages/InfoPages.jsx";
import LandingPage from "./pages/LandingPage.jsx";
import DownloadPage from "./pages/DownloadPage.jsx";
import VisibilityRoundedIcon from "@mui/icons-material/VisibilityRounded";
import VisibilityOffRoundedIcon from "@mui/icons-material/VisibilityOffRounded";
import { getApiErrorMessage } from "./services/api.js";
import { NATIVE_SHELLS, detectNativeShell, isTauriRuntime } from "./native/shell.js";
import { openAuthPage } from "./native/authLinks.js";
import ProtectedAppLayout from "./desktop/ProtectedAppLayout.jsx";
import {
  AccountPage,
  AppSettingsPage,
  AutomationsPage,
  HelpPage
} from "./desktop/DesktopPages.jsx";
import PluginsPage from "./plugins/PluginsPage.jsx";
import {
  authFormError,
  buildAuthPayload,
  confirmPasswordError,
  initialPasswordVisibility,
  togglePasswordVisibility,
  validateAuthField
} from "./auth/authForm.js";

const MotionLabPage = React.lazy(() => import("./pages/MotionLab.jsx"));

function PasswordToggle({ visible, fieldLabel, onToggle }) {
  return <InputAdornment position="end">
    <IconButton
      type="button"
      edge="end"
      aria-label={visible ? `Hide ${fieldLabel}` : `Show ${fieldLabel}`}
      aria-pressed={visible}
      onClick={onToggle}
      sx={{
        color: "#9aa8bd",
        "&:hover": { color: "#6c9bff" },
        "&.Mui-focusVisible": { outline: "2px solid #6c9bff", outlineOffset: "2px" }
      }}
    >
      {visible ? <VisibilityOffRoundedIcon /> : <VisibilityRoundedIcon />}
    </IconButton>
  </InputAdornment>;
}

function AuthPage({ mode }) {
  const isSignup = mode === "signup";
  const navigate = useNavigate();
  const location = useLocation();
  const redirectTo = location.state?.from || "/chat";
  const returnSearch = redirectTo.includes("?") ? redirectTo.slice(redirectTo.indexOf("?") + 1) : "";
  const nativeShell =
    detectNativeShell(returnSearch || undefined) ||
    (isTauriRuntime() ? NATIVE_SHELLS.windows : null);
  const { signUp, signIn, status } = useAuth();
  const [form, setForm] = useState({ name: "", email: "", password: "", confirmPassword: "" });
  const [visibility, setVisibility] = useState(initialPasswordVisibility);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [externalError, setExternalError] = useState("");
  const [externalBusy, setExternalBusy] = useState("");
  const [touched, setTouched] = useState({});

  useEffect(() => {
    setMessage("");
    setError("");
    setExternalError("");
    setExternalBusy("");
    setTouched({});
    setForm({ name: "", email: "", password: "", confirmPassword: "" });
    setVisibility(initialPasswordVisibility());
  }, [mode]);

  if (status === "authenticated") return <Navigate to={redirectTo} replace />;

  function fieldError(key) {
    if (key === "confirmPassword") {
      if (!touched.confirmPassword && form.confirmPassword.length === 0) return "";
      return confirmPasswordError(form.password, form.confirmPassword);
    }
    return touched[key] ? validateAuthField(key, form[key]) : "";
  }
  const markTouched = (key) => () => setTouched((current) => ({ ...current, [key]: true }));

  const update = (key) => (event) => setForm(current => ({ ...current, [key]: event.target.value }));

  async function handleSubmit(event) {
    event.preventDefault();
    if (busy) return;
    setError(""); setMessage("");
    setTouched({ name: true, email: true, password: true, confirmPassword: true });
    const firstError = authFormError(mode, form);
    if (firstError) { setError(firstError); return; }
    const payload = buildAuthPayload(mode, form);
    setBusy(true);
    try {
      if (isSignup) {
        await signUp(payload);
        setMessage("Account created. You're ready to get moving.");
      } else {
        await signIn(payload);
        setMessage("Signed in successfully. Welcome back.");
      }
      navigate(redirectTo, { replace: true });
    } catch (err) {
      setError(getApiErrorMessage(err));
    } finally { setBusy(false); }
  }

  async function openExternalAuth(kind) {
    if (externalBusy) return;
    setExternalError("");
    setExternalBusy(kind);
    try {
      await openAuthPage(kind);
    } catch (err) {
      setExternalError(err?.message || "Could not open the VupsRouter website.");
    } finally {
      setExternalBusy("");
    }
  }

    return <div className={`auth-layout${nativeShell ? " auth-layout--native" : ""}`}><div className="auth-art-panel"><Link to="/" className="brand auth-brand"><span className="brand-mark"><VupsLogo /></span><span>vups<span className="brand-light">router</span></span></Link><div className="auth-art-copy"><div className="eyebrow"><span className="eyebrow-line"/> FREE AI, MADE CLEAR</div><h1>Find your next<br/><span>AI model.</span></h1><p>Compare free access options and open models.</p><div className="auth-logo" aria-hidden="true"><VupsLogo className="auth-logo-image" sizes="220px" /></div><div className="auth-art-lines"><span/><span/><span/><span/><span/></div></div><div className="auth-art-foot"><span>FREE AI / CLEAR CHOICES</span><span>VUPSROUTER / 2026</span></div></div>
    <div className="auth-form-panel"><Link to="/" className="back-home">{"\u2190"} Back to home</Link><div className="auth-form-wrap"><div className="auth-form-heading"><span className="auth-kicker">{isSignup ? "JOIN VUPSROUTER" : "GOOD TO HAVE YOU BACK"}</span><h2>{isSignup ? "Create your account" : "Welcome back"}</h2><p>{isSignup ? "Create an account to use your VupsRouter account features." : "Sign in to your VupsRouter account."}</p></div>
      {error && <Alert severity="error" sx={{mb:2}}>{error}</Alert>}{message && <Alert severity="success" sx={{mb:2}}>{message}</Alert>}
      <form className="auth-form" onSubmit={handleSubmit}>
        {isSignup && <TextField label="Your name" value={form.name} onChange={update("name")} onBlur={markTouched("name")} error={Boolean(fieldError("name"))} helperText={fieldError("name")} autoComplete="name" autoFocus inputProps={{minLength:2,maxLength:80}} required />}
        <TextField label="Email address" type="email" value={form.email} onChange={update("email")} onBlur={markTouched("email")} error={Boolean(fieldError("email"))} helperText={fieldError("email")} autoComplete="email" autoFocus={!isSignup} required />
        <TextField
          label="Password"
          name="password"
          type={visibility.password ? "text" : "password"}
          value={form.password}
          onChange={update("password")}
          onBlur={markTouched("password")}
          error={Boolean(fieldError("password"))}
          helperText={fieldError("password") || "At least 8 characters"}
          autoComplete={isSignup ? "new-password" : "current-password"}
          inputProps={{ minLength: 8 }}
          InputProps={{
            endAdornment: <PasswordToggle
              visible={visibility.password}
              fieldLabel="password"
              onToggle={() => setVisibility(current => togglePasswordVisibility(current, "password"))}
            />
          }}
          sx={{ "& .MuiOutlinedInput-input": { pr: 0.5 } }}
          required
        />
        {isSignup && <TextField
          label="Confirm password"
          name="confirmPassword"
          type={visibility.confirmPassword ? "text" : "password"}
          value={form.confirmPassword}
          onChange={update("confirmPassword")}
          onBlur={markTouched("confirmPassword")}
          error={Boolean(fieldError("confirmPassword"))}
          helperText={fieldError("confirmPassword") || "Re-enter your password"}
          autoComplete="new-password"
          inputProps={{ minLength: 8 }}
          InputProps={{
            endAdornment: <PasswordToggle
              visible={visibility.confirmPassword}
              fieldLabel="confirm password"
              onToggle={() => setVisibility(current => togglePasswordVisibility(current, "confirmPassword"))}
            />
          }}
          sx={{ "& .MuiOutlinedInput-input": { pr: 0.5 } }}
          required
        />}
        {!isSignup && <div className="auth-forgot"><Link to="/forgot-password">Forgot password?</Link></div>}
        <Button type="submit" variant="contained" fullWidth disabled={busy} endIcon={busy ? <CircularProgress size={17} color="inherit"/> : <ArrowOutwardRoundedIcon />}>{busy ? "Please wait..." : isSignup ? "Create account" : "Sign in"}</Button>
      </form>
      {nativeShell ? (
        <div className="auth-external">
          <div className="auth-external__divider"><span>or</span></div>
          <div className="auth-external__actions">
            <Button
              type="button"
              variant="outlined"
              fullWidth
              disabled={busy || Boolean(externalBusy)}
              endIcon={<ArrowOutwardRoundedIcon />}
              onClick={() => openExternalAuth("signin")}
            >
              {externalBusy === "signin" ? "Opening browser..." : "Sign in in browser"}
            </Button>
            <Button
              type="button"
              variant="outlined"
              fullWidth
              disabled={busy || Boolean(externalBusy)}
              endIcon={<ArrowOutwardRoundedIcon />}
              onClick={() => openExternalAuth("signup")}
            >
              {externalBusy === "signup" ? "Opening browser..." : "Sign up in browser"}
            </Button>
          </div>
          {externalError ? <Alert severity="error" sx={{mt:1.5}}>{externalError}</Alert> : null}
          <p className="auth-external__note">Opens the VupsRouter website in your browser. Browser sign-in does not automatically sign in this desktop app.</p>
        </div>
      ) : null}
      <div className="auth-switch">{isSignup ? "Already have an account?" : "New to VupsRouter?"} <Link to={isSignup ? "/signin" : "/signup"}>{isSignup ? "Sign in" : "Create an account"}</Link></div>
      <p className="auth-terms">By continuing, you agree to our <Link to="/terms">Terms of Service</Link> and <Link to="/privacy-policy">Privacy Policy</Link>.</p>
    </div><div className="auth-side-note">OPEN MODELS <span>{"\u00b7"}</span> CHECK THE LIMITS</div></div></div>;
}

function ScrollToTop() {
  const location = useLocation();
  useEffect(() => {
    if (location.hash) {
      const id = decodeURIComponent(location.hash.slice(1));
      const frame = requestAnimationFrame(() => {
        const target = document.getElementById(id);
        if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
        else window.scrollTo({ top: 0, behavior: "smooth" });
      });
      return () => cancelAnimationFrame(frame);
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [location.pathname, location.hash, location.key]);
  return null;
}

export default function App() {
  return <AuthProvider><ScrollToTop /><Routes>
    <Route path="/" element={<LandingPage />} />
    <Route path="/features" element={<FeaturesPage />} />
    <Route path="/about" element={<AboutPage />} />
    <Route path="/download" element={<DownloadPage />} />
    <Route
      path="/motion"
      element={
        <React.Suspense
          fallback={
            <div
              role="status"
              aria-label="Loading motion lab"
              style={{ minHeight: "60svh", display: "grid", placeItems: "center" }}
            >
              <CircularProgress size={28} />
            </div>
          }
        >
          <MotionLabPage />
        </React.Suspense>
      }
    />
    <Route path="/signup" element={<><PageMeta title="Create your account — VupsRouter" description="Create a VupsRouter account to chat with Vups v3 Galax and connect your own AI providers." noIndex /><AuthPage mode="signup" /></>} />
    <Route path="/signin" element={<><PageMeta title="Sign in — VupsRouter" description="Sign in to your VupsRouter account." noIndex /><AuthPage mode="signin" /></>} />
    <Route path="/forgot-password" element={<><PageMeta title="Forgot password — VupsRouter" noIndex /><ForgotPasswordPage /></>} />
    <Route path="/reset-password" element={<Navigate to="/forgot-password" replace />} />
    <Route element={<ProtectedAppLayout />}>
      <Route path="/chat" element={<><PageMeta title="Chat — VupsRouter" description="Chat with Vups v3 Galax or route requests through your own AI provider." noIndex /><ChatPage /></>} />
      <Route path="/settings" element={<><PageMeta title="API Settings — VupsRouter" noIndex /><SettingsPage embedded /></>} />
      <Route path="/app-settings" element={<><PageMeta title="Application Settings — VupsRouter" noIndex /><AppSettingsPage /></>} />
      <Route path="/automations" element={<><PageMeta title="Automations — VupsRouter" noIndex /><AutomationsPage /></>} />
      <Route path="/plugins" element={<><PageMeta title="Plugins — VupsRouter" noIndex /><PluginsPage /></>} />
      <Route path="/extensions" element={<Navigate to="/plugins" replace />} />
      <Route path="/help" element={<><PageMeta title="Help — VupsRouter" noIndex /><HelpPage /></>} />
      <Route path="/account" element={<><PageMeta title="Account — VupsRouter" noIndex /><AccountPage /></>} />
    </Route>
    <Route path="/privacy-policy" element={<PrivacyPolicy />} />
    <Route path="/terms" element={<TermsOfService />} />
    <Route path="/cookie-policy" element={<CookiePolicy />} />
    <Route path="*" element={<><PageMeta title="Page not found — VupsRouter" noIndex /><NotFoundPage /></>} />
  </Routes></AuthProvider>;
}
