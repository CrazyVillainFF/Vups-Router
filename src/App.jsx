import React, { useEffect, useState } from "react";
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { Button, Container, TextField, Typography, Alert, CircularProgress, IconButton, InputAdornment } from "@mui/material";
import ChatPage from "./ChatPage.jsx";
import SettingsPage from "./SettingsPage.jsx";
import SiteHeader from "./components/SiteHeader.jsx";
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
import ShieldRoundedIcon from "@mui/icons-material/ShieldRounded";
import SpeedRoundedIcon from "@mui/icons-material/SpeedRounded";
import ChatBubbleOutlineRoundedIcon from "@mui/icons-material/ChatBubbleOutlineRounded";
import ForumRoundedIcon from "@mui/icons-material/ForumRounded";
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
    <div className="visual-label label-top"><span className="status-dot"/> FREE MODEL OPTIONS</div>
    <div className="visual-label label-bottom"><span className="label-icon"><SpeedRoundedIcon fontSize="small"/></span><span><b>Free to explore.</b><small>Limits may apply.</small></span></div>
    <div className="visual-coordinate">WEB / API<br/>LOCAL / OPEN</div>
  </div>;
}

const features = [
  { icon: <RouteRoundedIcon />, number: "01", title: "Gemini in AI Studio", text: "Try eligible Gemini Flash models through Google AI Studio’s free tier. Model access and request limits vary by plan.", url: "https://aistudio.google.com/", ariaLabel: "Explore Google AI Studio free models" },
  { icon: <SpeedRoundedIcon />, number: "02", title: "OpenRouter free models", text: "Browse a rotating catalog of $0 models, including free Nemotron options. Availability and rate limits can change.", url: "https://openrouter.ai/collections/free-models/", ariaLabel: "Browse free models on OpenRouter" },
  { icon: <ShieldRoundedIcon />, number: "03", title: "Run models locally", text: "Download open-weight model families such as Gemma, Qwen, and Llama through Ollama. Local use has no hosted API charge, but your hardware does the work.", url: "https://ollama.com/library", ariaLabel: "Browse local models in Ollama library" }
];

function Home() {
  useReveal();
  return <><PageMeta title="VupsRouter — Free AI Models" description="Compare free AI models for chat, coding, and reasoning. Start with free tiers or run open-weight models locally." /><SiteHeader /><main className="page-shell">
    <section className="hero section-pad">
      <div className="hero-copy">
        <div className="eyebrow reveal"><span className="eyebrow-line"/> YOUR GUIDE TO FREE AI</div>
        <Typography component="h1" className="hero-title reveal delay-1">Explore free AI.<br/><span>Find your model.</span></Typography>
        <p className="hero-description reveal delay-2">Compare free AI models for chat, coding, reasoning, and local use. Start with free tiers or run open-weight models on your own hardware.</p>
        <div className="hero-actions reveal delay-3"><Button component={Link} to="/signup" variant="contained" endIcon={<ArrowOutwardRoundedIcon />}>Start your journey</Button><a className="text-link" href="#how-it-works">Compare access options <NorthEastRoundedIcon fontSize="small"/></a></div>
        <div className="hero-note reveal delay-3"><span className="avatar-stack"><i>V</i><i>+</i><i>R</i></span><span>Useful models. Clear access options.</span></div>
      </div>
      <div className="hero-art reveal delay-2"><HeroVisual /></div>
      <div className="hero-index"><span>FREE AI GUIDE</span><span>COMPARE BEFORE YOU CHOOSE</span></div>
    </section>
    <section className="ticker" aria-label="Product values"><div className="ticker-track">{Array.from({length:2},(_,i)=><div className="ticker-set" key={i}><span>FREE TIERS</span><b>✳</b><span>OPEN MODELS</span><b>✳</b><span>TRY SOMETHING NEW</span><b>✳</b><span>KNOW THE LIMITS</span><b>✳</b></div>)}</div></section>
    <section id="features" className="features-section section-pad">
      <div className="section-heading reveal"><div><div className="eyebrow"><span className="eyebrow-line"/> START WITHOUT THE SPEND</div><h2>Free to try.<br/><span>Built for different tasks.</span></h2></div><p>Find a free starting point for your next AI task.</p></div>
      <div className="feature-grid">{features.map((feature,i)=><article className={`feature-card reveal delay-${i+1}`} key={feature.number}><div className="feature-top"><span className="feature-icon">{feature.icon}</span><span className="feature-number">{feature.number}</span></div><h3>{feature.title}</h3><p>{feature.text}</p><a className="feature-arrow" href={feature.url} target="_blank" rel="noreferrer" aria-label={feature.ariaLabel}><NorthEastRoundedIcon /></a></article>)}</div>
    </section>
    <section id="ai-chat" className="chat-hub section-pad">
      <div className="chat-hub-copy reveal"><div className="eyebrow"><span className="eyebrow-line"/> TALK TO AI</div><h2>AI Chat</h2><p>Chat with AI models, explore free options, and discover new ways to use AI.</p><div className="chat-hub-actions"><Button component={Link} to="/chat" variant="contained" startIcon={<ChatBubbleOutlineRoundedIcon />}>Go to Chat</Button></div></div>
      <div className="a2a-card reveal delay-1"><div className="a2a-top"><span className="a2a-icon"><ForumRoundedIcon /></span><span className="a2a-badge">Coming soon</span></div><h3>Try AI-to-AI Chats</h3><p>Two models, one conversation. This experience isn’t live yet — meanwhile, open AI Chat and use the /compare command to compare free models side by side.</p><Link className="text-link" to="/chat">Open AI Chat <NorthEastRoundedIcon fontSize="small"/></Link></div>
    </section>
    <section id="how-it-works" className="manifesto section-pad">
      <div className="manifesto-art reveal"><div className="manifesto-ring ring-a"/><div className="manifesto-ring ring-b"/><div className="manifesto-core"><AutoAwesomeRoundedIcon /></div><span className="manifesto-tag tag-a">FREE TIERS</span><span className="manifesto-tag tag-b">OPEN WEIGHTS</span><span className="manifesto-tag tag-c">MODEL CHOICE</span></div>
      <div className="manifesto-copy reveal delay-1"><div className="eyebrow"><span className="eyebrow-line"/> CHOOSING A MODEL</div><h2>Choose how to run<br/>your <span>AI model.</span></h2><p>Choose a hosted free tier for convenience, a model directory for variety, or a local model for more control. “Free” can still mean quotas, changing availability, hardware costs, or provider-specific data terms.</p><Button component={Link} to="/signup" variant="outlined" endIcon={<ArrowOutwardRoundedIcon />}>Create your account</Button></div>
    </section>
    <section className="closing-cta section-pad reveal"><div className="cta-glow"/><div className="eyebrow"><span className="eyebrow-line"/> YOUR NEXT MODEL STARTS HERE</div><h2>Ready to try<br/><span>AI for free?</span></h2><p>Start with a free tier or run an open model locally. Check each provider’s current terms before using it for sensitive work.</p><Button component={Link} to="/signup" variant="contained" endIcon={<ArrowOutwardRoundedIcon />}>Create your account</Button><div className="cta-stamp">FREE<br/>AI<br/>OPTIONS</div></section>
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
  const redirectTo = location.state?.from || "/settings";

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
  return <div className="auth-layout"><div className="auth-art-panel"><Link to="/" className="brand auth-brand"><span className="brand-mark"><RouteRoundedIcon /></span><span>vups<span className="brand-light">router</span></span></Link><div className="auth-art-copy"><div className="eyebrow"><span className="eyebrow-line"/> FREE AI, MADE CLEAR</div><h1>Find your next<br/><span>AI model.</span></h1><p>Compare free access options and open models.</p><div className="auth-art-lines"><span/><span/><span/><span/><span/></div></div><div className="auth-art-foot"><span>FREE AI / CLEAR CHOICES</span><span>VUPSROUTER / 2026</span></div></div>
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
    <Route path="/signup" element={<><PageMeta title="Create your account — VupsRouter" description="Create a free VupsRouter account to compare and chat with free AI models." noIndex /><AuthPage mode="signup" /></>} />
    <Route path="/signin" element={<><PageMeta title="Sign in — VupsRouter" description="Sign in to your VupsRouter account." noIndex /><AuthPage mode="signin" /></>} />
    <Route path="/forgot-password" element={<><PageMeta title="Forgot password — VupsRouter" noIndex /><ForgotPasswordPage /></>} />
    <Route path="/reset-password" element={<Navigate to="/forgot-password" replace />} />
    <Route path="/settings" element={<><PageMeta title="API Settings — VupsRouter" noIndex /><RequireAuth><SettingsPage /></RequireAuth></>} />
    <Route path="/chat" element={<><PageMeta title="Chat — VupsRouter" description="Chat with free AI models through VupsRouter." /><RequireAuth><ChatPage /></RequireAuth></>} />
    <Route path="/privacy-policy" element={<PrivacyPolicy />} />
    <Route path="/terms" element={<TermsOfService />} />
    <Route path="/cookie-policy" element={<CookiePolicy />} />
    <Route path="*" element={<><PageMeta title="Page not found — VupsRouter" noIndex /><div className="not-found"><SiteHeader/><h1>That route went nowhere.</h1><Link to="/">Return home</Link></div></>} />
  </Routes></AuthProvider>;
}
