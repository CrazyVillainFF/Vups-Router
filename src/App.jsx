import React, { useEffect, useState } from "react";
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { Button, Container, TextField, Typography, Alert, CircularProgress, IconButton, InputAdornment } from "@mui/material";
import ChatPage from "./ChatPage.jsx";
import SettingsPage from "./SettingsPage.jsx";
import SiteHeader from "./components/SiteHeader.jsx";
import VupsLogo from "./components/VupsLogo.jsx";
import SiteFooter from "./components/SiteFooter.jsx";
import PageMeta from "./components/PageMeta.jsx";
import RequireAuth from "./components/RequireAuth.jsx";
import { PrivacyPolicy, TermsOfService, CookiePolicy } from "./legal/LegalPages.jsx";
import { ForgotPasswordPage } from "./auth/PasswordRecovery.jsx";
import { AuthProvider, useAuth } from "./context/AuthContext.jsx";
import ArrowOutwardRoundedIcon from "@mui/icons-material/ArrowOutwardRounded";
import NorthEastRoundedIcon from "@mui/icons-material/NorthEastRounded";
import RouteRoundedIcon from "@mui/icons-material/RouteRounded";
import AutoAwesomeRoundedIcon from "@mui/icons-material/AutoAwesomeRounded";
import CodeRoundedIcon from "@mui/icons-material/CodeRounded";
import SpeedRoundedIcon from "@mui/icons-material/SpeedRounded";
import ChatBubbleOutlineRoundedIcon from "@mui/icons-material/ChatBubbleOutlineRounded";
import TuneRoundedIcon from "@mui/icons-material/TuneRounded";
import { AboutPage, FeaturesPage, NotFoundPage } from "./pages/InfoPages.jsx";
import VisibilityRoundedIcon from "@mui/icons-material/VisibilityRounded";
import VisibilityOffRoundedIcon from "@mui/icons-material/VisibilityOffRounded";
import { getApiErrorMessage } from "./services/api.js";
import {
  authFormError,
  buildAuthPayload,
  confirmPasswordError,
  initialPasswordVisibility,
  togglePasswordVisibility,
  validateAuthField
} from "./auth/authForm.js";

function useReveal() {
  useEffect(() => {
    const nodes = document.querySelectorAll(".reveal:not(.is-visible)");
    if (!("IntersectionObserver" in window)) {
      nodes.forEach(node => node.classList.add("is-visible"));
      return;
    }
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.14, rootMargin: "0px 0px -36px 0px" });
    nodes.forEach(node => observer.observe(node));
    return () => observer.disconnect();
  });
}

function HeroVisual() {
  return <div className="route-visual" aria-label="Abstract animated model network visualization">
    <div className="visual-orbit orbit-one" /><div className="visual-orbit orbit-two" /><div className="visual-orbit orbit-three" />
    <div className="visual-grid" />
    <svg className="route-svg" viewBox="0 0 520 420" role="img" aria-label="A glowing path connecting model options">
      <defs><linearGradient id="routeGradient" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stopColor="#d4ff3f"/><stop offset="100%" stopColor="#7e9b31"/></linearGradient></defs>
      <path className="route-path-shadow" d="M96 302 C132 300 137 226 202 228 S267 306 320 236 S372 119 431 105"/>
      <path className="route-path" d="M96 302 C132 300 137 226 202 228 S267 306 320 236 S372 119 431 105"/>
      {[["96","302"],["202","228"],["320","236"],["431","105"]].map(([cx,cy],i)=><g key={cx} className={`route-node node-${i}`}><circle cx={cx} cy={cy} r={i===3?13:8}/><circle cx={cx} cy={cy} r={i===3?25:18} className="node-ring"/></g>)}
    </svg>
    <div className="visual-label label-top"><span className="status-dot"/> VUPS V3 GALAX</div>
    <div className="visual-label label-bottom"><span className="label-icon"><SpeedRoundedIcon fontSize="small"/></span><span><b>One chat. Many routes.</b><small>Start free. Bring your own key.</small></span></div>
    <div className="visual-coordinate">GENERAL / MOTION<br/>YOUR KEYS / FREE MODELS</div>
  </div>;
}

const features = [
  { icon: <RouteRoundedIcon />, number: "01", title: "Vups v3 Galax, built in", text: "Start a real conversation without an API key. Use General for everyday work or Motion Design for frontend, CSS, and animation engineering.", to: "/features#vups", ariaLabel: "Learn about Vups v3 Galax" },
  { icon: <TuneRoundedIcon />, number: "02", title: "Your models, one chat", text: "Bring OpenAI-compatible, Anthropic, Gemini, Azure, and other provider keys. VupsRouter keeps each configuration separate and encrypted.", to: "/features#models", ariaLabel: "Learn about model routing" },
  { icon: <CodeRoundedIcon />, number: "03", title: "Answers you can keep", text: "Replies stream in, conversations are saved, images can be attached when the model supports vision, and generated project files can be downloaded as a ZIP.", to: "/features#workspace", ariaLabel: "Learn about the chat workspace" }
];

function Home() {
  useReveal();
  return <><PageMeta title="VupsRouter — AI chat and model routing" description="Chat with Vups v3 Galax, keep your conversations, and route requests through your own AI provider keys." /><SiteHeader /><main id="main-content" className="page-shell">
    <section className="hero section-pad">
      <div className="hero-copy">
        <div className="eyebrow reveal"><span className="eyebrow-line"/> VUPSROUTER AI</div>
        <Typography component="h1" className="hero-title reveal delay-1">One chat.<br/><span>More ways to build.</span></Typography>
        <p className="hero-description reveal delay-2">VupsRout AI starts with Vups v3 Galax, a first-party model for code, design, and complex problems. Add your own provider keys when you want another route.</p>
        <div className="hero-actions reveal delay-3"><Button component={Link} to="/chat" variant="contained" endIcon={<ArrowOutwardRoundedIcon />}>Chat with Vups v3 Galax</Button><Link className="text-link" to="/features">See what’s inside <NorthEastRoundedIcon fontSize="small"/></Link></div>
        <div className="hero-note reveal delay-3"><span className="avatar-stack"><i>V</i><i>3</i><i>G</i></span><span>No API key required to start. Free limits apply.</span></div>
      </div>
      <div className="hero-art reveal delay-2"><HeroVisual /></div>
      <div className="hero-index"><span>BUILT-IN MODEL</span><span>GENERAL + MOTION DESIGN</span></div>
    </section>
    <section className="ticker" aria-label="Product capabilities"><div className="ticker-track">{Array.from({length:2},(_,i)=><div className="ticker-set" key={i}><span>VUPS V3 GALAX</span><b>✳</b><span>GENERAL + MOTION</span><b>✳</b><span>SAVED CONVERSATIONS</span><b>✳</b><span>IMAGE INPUT</span><b>✳</b><span>PROJECT DOWNLOADS</span><b>✳</b></div>)}</div></section>
    <section id="features" className="features-section section-pad">
      <div className="section-heading reveal"><div><div className="eyebrow"><span className="eyebrow-line"/> THE WORKING PRODUCT</div><h2>Start with Galax.<br/><span>Route it your way.</span></h2></div><p>Real chat, real model choices, and real controls — not a catalogue of promises.</p></div>
      <div className="feature-grid">{features.map((feature,i)=><Link className={`feature-card reveal delay-${i+1}`} to={feature.to} key={feature.number} aria-label={feature.ariaLabel}><div className="feature-top"><span className="feature-icon">{feature.icon}</span><span className="feature-number">{feature.number}</span></div><h3>{feature.title}</h3><p>{feature.text}</p><span className="feature-arrow" aria-hidden="true"><NorthEastRoundedIcon /></span></Link>)}</div>
    </section>
    <section id="ai-chat" className="chat-hub section-pad">
      <div className="chat-hub-copy reveal"><div className="eyebrow"><span className="eyebrow-line"/> VUPSROUT AI</div><h2>One chat.<br/><span>Built for work.</span></h2><p>Ask for code, a landing page, a debugging plan, or a complete project. Switch modes, choose a model, and keep the thread when you come back.</p><div className="chat-hub-actions"><Button component={Link} to="/chat" variant="contained" startIcon={<ChatBubbleOutlineRoundedIcon />}>Open AI Chat</Button><Button component={Link} to="/signup" variant="outlined">Create an account</Button></div></div>
      <div className="a2a-card reveal delay-1"><div className="a2a-top"><span className="a2a-icon"><CodeRoundedIcon /></span><span className="a2a-badge">Real project files</span></div><h3>From answer to download</h3><p>When a reply includes named code files, VupsRouter can package them into a ZIP so you can inspect and run the project locally.</p><Link className="text-link" to="/features#workspace">See the workspace <NorthEastRoundedIcon fontSize="small"/></Link></div>
    </section>
    <section id="how-it-works" className="manifesto section-pad">
      <div className="manifesto-art reveal"><div className="manifesto-ring ring-a"/><div className="manifesto-ring ring-b"/><div className="manifesto-core"><AutoAwesomeRoundedIcon /></div><span className="manifesto-tag tag-a">VUPS V3 GALAX</span><span className="manifesto-tag tag-b">YOUR KEYS</span><span className="manifesto-tag tag-c">SAVED THREADS</span></div>
      <div className="manifesto-copy reveal delay-1"><div className="eyebrow"><span className="eyebrow-line"/> HOW VUPSROUTER WORKS</div><h2>Start free.<br/>Choose your <span>route.</span></h2><p>Vups v3 Galax works immediately. Add encrypted provider keys when you need a different model, then pick it in the composer. Requests go through the VupsRouter backend proxy, and switching models never silently reuses another provider’s key.</p><Button component={Link} to="/features" variant="outlined" endIcon={<ArrowOutwardRoundedIcon />}>Explore the features</Button></div>
    </section>
    <section className="closing-cta section-pad reveal"><div className="cta-glow"/><div className="eyebrow"><span className="eyebrow-line"/> READY WHEN YOU ARE</div><h2>One chat.<br/><span>Your next build.</span></h2><p>Start with the built-in model, or connect your own provider. You can change routes later without losing the conversation.</p><Button component={Link} to="/signup" state={{ from: "/chat" }} variant="contained" endIcon={<ArrowOutwardRoundedIcon />}>Create an account</Button><div className="cta-stamp">START<br/>FREE<br/>CHAT</div></section>
  </main><SiteFooter /></>;
}

function PasswordToggle({ visible, fieldLabel, onToggle }) {
  return <InputAdornment position="end">
    <IconButton
      type="button"
      edge="end"
      aria-label={visible ? `Hide ${fieldLabel}` : `Show ${fieldLabel}`}
      aria-pressed={visible}
      onClick={onToggle}
      sx={{
        color: "#9aa39a",
        "&:hover": { color: "#d4ff3f" },
        "&.Mui-focusVisible": { outline: "2px solid #d4ff3f", outlineOffset: "2px" }
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
  const { signUp, signIn, status } = useAuth();
  const [form, setForm] = useState({ name: "", email: "", password: "", confirmPassword: "" });
  const [visibility, setVisibility] = useState(initialPasswordVisibility);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [touched, setTouched] = useState({});
  const redirectTo = location.state?.from || "/chat";

  useEffect(() => {
    setMessage("");
    setError("");
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
    return <div className="auth-layout"><div className="auth-art-panel"><Link to="/" className="brand auth-brand"><span className="brand-mark"><VupsLogo /></span><span>vups<span className="brand-light">router</span></span></Link><div className="auth-art-copy"><div className="eyebrow"><span className="eyebrow-line"/> FREE AI, MADE CLEAR</div><h1>Find your next<br/><span>AI model.</span></h1><p>Compare free access options and open models.</p><div className="auth-logo" aria-hidden="true"><VupsLogo className="auth-logo-image" /></div><div className="auth-art-lines"><span/><span/><span/><span/><span/></div></div><div className="auth-art-foot"><span>FREE AI / CLEAR CHOICES</span><span>VUPSROUTER / 2026</span></div></div>
    <div className="auth-form-panel"><Link to="/" className="back-home">← Back to home</Link><div className="auth-form-wrap"><div className="auth-form-heading"><span className="auth-kicker">{isSignup ? "JOIN VUPSROUTER" : "GOOD TO HAVE YOU BACK"}</span><h2>{isSignup ? "Create your account" : "Welcome back"}</h2><p>{isSignup ? "Create an account to use your VupsRouter account features." : "Sign in to your VupsRouter account."}</p></div>
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
        <Button type="submit" variant="contained" fullWidth disabled={busy} endIcon={busy ? <CircularProgress size={17} color="inherit"/> : <ArrowOutwardRoundedIcon />}>{busy ? "Please wait…" : isSignup ? "Create account" : "Sign in"}</Button>
      </form>
      <div className="auth-switch">{isSignup ? "Already have an account?" : "New to VupsRouter?"} <Link to={isSignup ? "/signin" : "/signup"}>{isSignup ? "Sign in" : "Create an account"}</Link></div>
      <p className="auth-terms">By continuing, you agree to our <Link to="/terms">Terms of Service</Link> and <Link to="/privacy-policy">Privacy Policy</Link>.</p>
    </div><div className="auth-side-note">OPEN MODELS <span>•</span> CHECK THE LIMITS</div></div></div>;
}

function ScrollToTop() {
  const location = useLocation();
  useEffect(() => { window.scrollTo({ top: 0, behavior: "smooth" }); }, [location.pathname]);
  return null;
}

export default function App() {
  return <AuthProvider><ScrollToTop /><Routes>
    <Route path="/" element={<Home />} />
    <Route path="/features" element={<FeaturesPage />} />
    <Route path="/about" element={<AboutPage />} />
    <Route path="/signup" element={<><PageMeta title="Create your account — VupsRouter" description="Create a VupsRouter account to chat with Vups v3 Galax and connect your own AI providers." noIndex /><AuthPage mode="signup" /></>} />
    <Route path="/signin" element={<><PageMeta title="Sign in — VupsRouter" description="Sign in to your VupsRouter account." noIndex /><AuthPage mode="signin" /></>} />
    <Route path="/forgot-password" element={<><PageMeta title="Forgot password — VupsRouter" noIndex /><ForgotPasswordPage /></>} />
    <Route path="/reset-password" element={<Navigate to="/forgot-password" replace />} />
    <Route path="/settings" element={<><PageMeta title="API Settings — VupsRouter" noIndex /><RequireAuth><SettingsPage /></RequireAuth></>} />
    <Route path="/chat" element={<><PageMeta title="Chat — VupsRouter" description="Chat with Vups v3 Galax or route requests through your own AI provider." noIndex /><RequireAuth><ChatPage /></RequireAuth></>} />
    <Route path="/privacy-policy" element={<PrivacyPolicy />} />
    <Route path="/terms" element={<TermsOfService />} />
    <Route path="/cookie-policy" element={<CookiePolicy />} />
    <Route path="*" element={<><PageMeta title="Page not found — VupsRouter" noIndex /><NotFoundPage /></>} />
  </Routes></AuthProvider>;
}
