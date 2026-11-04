import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@mui/material";
import {
  ArrowRight,
  BookOpen,
  Check,
  Code2,
  Download,
  Eye,
  Images,
  KeyRound,
  Keyboard,
  Layers,
  Lock,
  MessagesSquare,
  Route,
  ShieldCheck,
  Smartphone,
  Sparkles,
  TriangleAlert,
  Waypoints,
  Zap
} from "lucide-react";

import SiteHeader from "../components/SiteHeader.jsx";
import LandingFooter from "../components/LandingFooter.jsx";
import PageMeta from "../components/PageMeta.jsx";
import VupsLogo from "../components/VupsLogo.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { useHomeTheme } from "../home/useHomeTheme.js";
import { PROVIDERS } from "../providers/registry.js";
import { useDimensionTier } from "../landing/dimension/useDimensionTier.js";
import { constellationDisclaimer, constellationFacts } from "../landing/dimension/constellationData.js";
import { markFacts } from "../landing/dimension/markGeometry.js";
import { STAGE_ASPECT } from "../landing/dimension/stageConstants.js";
import StageBoundary from "../landing/dimension/StageBoundary.jsx";
import MetalLogoSurface from "../landing/dimension/MetalLogoSurface.jsx";
import { scrollHomeSection, useHomeMotion } from "../landing/motion/useHomeMotion.js";

/* The canvas is the most expensive thing on this page, so it is its own chunk and
   is only requested once the tier has said the machine can hold it. */
const DimensionStage = lazy(() => import("../landing/dimension/DimensionStage.jsx"));

import "../styles/tailwind-landing.css";
import "./landing/home.css";
import "./landing/dimension.css";

/* ------------------------------------------------------------------ */
/* Verified product data — every figure is counted from the app itself */
/* ------------------------------------------------------------------ */

const CHAT_MODES = [
  { key: "general", name: "General", description: "Everyday answers, research, and coding help" },
  { key: "motion", name: "Motion Design", description: "Animation engineering, GSAP, and visual implementation" }
];

const VUPS_EFFORTS = ["Precise", "Balanced", "Creative"];

const PROVIDER_COUNT = PROVIDERS.length;

/* The registry's own protocol ids. Only families with a working server-side
   adapter count as implemented, so an entry marked "other" cannot inflate it. */
const IMPLEMENTED_PROTOCOLS = ["openai", "anthropic", "azure", "watsonx", "qoder"];
const PROTOCOL_NAMES = {
  openai: "OpenAI-compatible",
  anthropic: "Anthropic Messages",
  azure: "Azure OpenAI",
  watsonx: "IBM watsonx",
  qoder: "Qoder Cloud Agents"
};

const ledger = constellationFacts();
const CATEGORY_COUNT = ledger.groups.length;
const IMPLEMENTED_NAMES = ledger.protocols
  .filter(id => IMPLEMENTED_PROTOCOLS.includes(id))
  .map(id => PROTOCOL_NAMES[id] || id);
const PROTOCOL_FAMILIES = IMPLEMENTED_NAMES.length;

/* The registry's category names are written for a heading, not for a count line,
   so each id gets a short form here. An id the registry adds later falls back to
   its own label rather than disappearing from the tally. */
const CATEGORY_SHORT = {
  aggregator: "aggregators",
  direct: "direct providers",
  local: "local gateways",
  custom: "custom endpoints"
};

const specs = [
  {
    label: "Built-in model",
    value: "Vups v3 Galax",
    note: `${CHAT_MODES.map(mode => mode.name).join(" and ")} modes · ${VUPS_EFFORTS.join(", ")} reasoning`
  },
  {
    label: "Provider registry",
    value: `${PROVIDER_COUNT} entries`,
    note: ledger.groups
      .map(group => `${group.count} ${CATEGORY_SHORT[group.id] || group.label}`)
      .join(" · ")
  },
  {
    label: "Protocol families",
    value: `${PROTOCOL_FAMILIES} families`,
    note: IMPLEMENTED_NAMES.join(", ")
  },
  {
    label: "Account setup",
    value: "Email + password",
    note: "No invite code, no card · no key needed for the built-in model"
  },
  {
    label: "Model routing",
    value: "The route stays visible",
    note: "The built-in model, then every configuration you saved, each with its own models and key"
  },
  {
    label: "Workspace & features",
    value: "Threads that stay",
    note: "Saved per account, stoppable mid-stream, reopened or deleted from the sidebar"
  }
];

/* The four states the real composer passes through, described rather than
   pretended: no invented reply, no simulated timing. */
const realStates = [
  "The model, the prompt mode and the reasoning level sit in one row and stay visible while the reply streams.",
  "Built-in model first, then every configuration you saved, each listed with its own models.",
  "Replies stream, so a turn can be stopped — and what already arrived is kept in the thread.",
  "Files named inside fenced blocks are collected into a downloadable project ZIP."
];

const NAV_SECTIONS = [
  { id: "overview", label: "What it is" },
  { id: "showcase", label: "The interface" },
  { id: "models", label: "Model choice" },
  { id: "problems", label: "What it fixes" },
  { id: "features", label: "Capabilities" },
  { id: "flow", label: "The journey" },
  { id: "experience", label: "In use" },
  { id: "privacy", label: "Privacy" },
  { id: "faq", label: "Questions" },
  { id: "start", label: "Start" }
];

const problems = [
  {
    before: "A key per tool",
    beforeNote: "Every assistant you try wants its own key, its own base URL and its own model ID typed by hand.",
    now: "One saved configuration",
    nowNote: "Save a provider once in Settings. Its endpoint, key and model list stay together and the composer lists them."
  },
  {
    before: "You cannot tell what answered",
    beforeNote: "Switched models are invisible, so a bad answer has no address to report.",
    now: "The route stays on screen",
    nowNote: "Model, mode and reasoning level remain visible in the composer while the reply streams and after it lands."
  },
  {
    before: "Failures arrive as silence",
    beforeNote: "A dropped request that looks like an empty answer is the worst possible failure mode.",
    now: "Failures are named",
    nowNote: "The chat distinguishes a missing key, an unavailable model, a provider outage and a quota limit — and keeps the error visible."
  },
  {
    before: "Long threads hit a wall",
    beforeNote: "Context ceilings usually surface as a truncated reply with no explanation.",
    now: "A wall you can walk around",
    nowNote: "At the ceiling the chat names the blocked part and offers to continue in a new conversation with a written handoff summary."
  },
  {
    before: "Output is trapped in markdown",
    beforeNote: "A generated project you have to copy out of a code block, file by file, is a project you will not run.",
    now: "Answers leave as code",
    nowNote: "Files named inside fenced blocks are collected into a downloadable project ZIP."
  }
];

/* Six cells, six different compositions — no repeated card. */
const capabilityCells = [
  {
    id: "galax",
    size: "hero",
    icon: <Sparkles size={15} />,
    title: "Vups v3 Galax is already in the chat",
    body: "Open a conversation without adding a key. General handles everyday work, research and coding help; Motion Design handles frontend, CSS, GSAP and animation engineering.",
    list: [
      `${CHAT_MODES.length} prompt modes: ${CHAT_MODES.map(mode => mode.name).join(" and ")}`,
      `${VUPS_EFFORTS.length} reasoning levels: ${VUPS_EFFORTS.join(", ")}`,
      "Both selectors stay visible while the reply streams"
    ],
    to: "/features#vups",
    linkText: "What the modes change"
  },
  {
    id: "routing",
    size: "tall",
    icon: <Route size={15} />,
    title: "Your models, kept separate",
    body: "Save a provider and it keeps its own endpoint, key and model list. A request bound to one configuration cannot silently borrow another provider's key.",
    list: [
      `${PROVIDER_COUNT} providers across ${CATEGORY_COUNT} categories`,
      `${PROTOCOL_FAMILIES} protocol families implemented`,
      "A mismatched model is rejected, not re-routed in the dark"
    ],
    to: "/features#models",
    linkText: "How key isolation works"
  },
  {
    id: "workspace",
    size: "sm",
    icon: <MessagesSquare size={15} />,
    title: "The thread keeps the work",
    body: "Replies stream and can be stopped mid-generation. Conversations save per account, reopen later, or delete from the sidebar.",
    to: "/features#workspace"
  },
  {
    id: "vision",
    size: "sm",
    icon: <Images size={15} />,
    title: "Image input when the model supports it",
    body: "Attach PNG, JPEG, WebP or GIF. A model without vision returns a clear error instead of silently dropping the file.",
    to: "/features#workspace"
  },
  {
    id: "limits",
    size: "wide",
    icon: <ShieldCheck size={15} />,
    title: "Limits are shown, not hidden",
    body: "Shared free models are checked against server status, and errors distinguish a missing key, an unavailable model, an outage and a quota limit.",
    to: "/features#controls"
  },
  {
    id: "deliver",
    size: "tall",
    icon: <Download size={15} />,
    title: "Answers you can take away",
    body: "When a reply names code files inside fenced blocks, VupsRouter packages them into a downloadable project ZIP — so a generated page can be run locally instead of copied out of markdown.",
    list: ["Named files, not clipboard arithmetic", "The thread keeps the conversation around them"],
    to: "/features#workspace",
    linkText: "See the workspace"
  }
];

const flowSteps = [
  {
    no: "01",
    title: "Open a conversation",
    body: "Sign in and the composer is ready. Vups v3 Galax is selected, General mode at Balanced, with an empty thread waiting.",
    tags: ["No key to paste", "HTTP-only session"]
  },
  {
    no: "02",
    title: "Choose what answers",
    body: "Keep the built-in model or switch to a configuration you saved. The row always shows which one is selected, and the mode and reasoning level sit beside it.",
    tags: [`${PROVIDER_COUNT} providers`, `${CHAT_MODES.length} modes · ${VUPS_EFFORTS.length} levels`]
  },
  {
    no: "03",
    title: "Read it, stop it, take it away",
    body: "The reply streams so you can interrupt it, partial output is kept, files can leave as a ZIP, and a thread that reaches the ceiling continues into a new conversation with a handoff summary.",
    tags: ["Streaming", "Project ZIP", "Handoff"]
  }
];

const stages = [
  { no: "01", title: "Compose", body: "Message, model, mode and reasoning level in one row. Nothing is chosen for you behind it." },
  { no: "02", title: "Select", body: "The built-in model, then every saved configuration you own — each with its own models." },
  { no: "03", title: "Stream", body: "Text arrives as it is generated, and the stop control works the whole time." },
  { no: "04", title: "Interrupt", body: "Stopping keeps what already landed in the thread instead of discarding the turn." },
  { no: "05", title: "Deliver", body: "Named files become a project ZIP; a ceiling hands off to a new conversation." }
];

const craftChecks = [
  { icon: <Keyboard size={15} />, title: "Keyboard first", body: "Every control on this page and in the chat is reachable by keyboard, with a visible focus ring.", term: "tab" },
  { icon: <Smartphone size={15} />, title: "Checked from 320px up", body: "Layouts are measured at 320, 375, 390, 768, 1024 and 1440 — the composer and the long model names all have to fit.", term: "320px" },
  { icon: <TriangleAlert size={15} />, title: "Errors stay on screen", body: "A failed request keeps its message visible and names what failed. Duplicate alerts do not stack on a successful reply.", term: "named" },
  { icon: <Zap size={15} />, title: "Reduced motion is honoured", body: "With prefers-reduced-motion the 3D stage is never mounted, the scroll tweens are never armed, and no copy waits on an animation.", term: "off" },
  { icon: <Eye size={15} />, title: "State is never colour alone", body: "The selected route shows its name, not a dot. Stopping a reply labels the partial output in words.", term: "labelled" },
  { icon: <Lock size={15} />, title: "No secrets in the bundle", body: "Provider keys are entered and stored server-side. This page ships no key, endpoint or internal diagnostic.", term: "server-side" }
];

const promises = [
  { icon: <Lock size={14} />, title: "Keys are encrypted before storage", body: "A saved provider key is encrypted with AES-256-GCM on the server and returned to the interface only in masked form." },
  { icon: <ShieldCheck size={14} />, title: "One configuration, one key", body: "Each saved configuration is looked up under your account alone, and a model belonging to a different configuration is rejected." },
  { icon: <KeyRound size={14} />, title: "The session is an HTTP-only cookie", body: "Signing in sets a cookie the page scripts cannot read. Ordinary use never stores an access token in the browser." },
  { icon: <Images size={14} />, title: "Attachments are read by their bytes", body: "An uploaded image is identified from its actual contents, not the type label the browser reports, before anything reaches a model." },
  { icon: <Waypoints size={14} />, title: "Quota is checked before upstream", body: "Per-user quotas and rate limits run at the VupsRouter backend before a request reaches any provider." }
];

const limits = [
  "Shared free models can be rate-limited or withdrawn at any time. An unavailable model is shown as unavailable.",
  "Per-user quotas and request limits apply, so throughput is not unlimited.",
  "Generated code and factual claims can be wrong. Review them before relying on either.",
  "Deleting a conversation or a saved configuration is immediate and yours to do from the app.",
  "Closing a whole account is handled by contacting the operator — the published policy states no fixed retention period, because one is not configured."
];

const needs = [
  { tag: "What you need", title: "An email, a name, a password", body: "The signup form asks for those three and nothing else. There is no waitlist, no invite code and no card.", ok: true },
  { tag: "What you do not need", title: "A provider key", body: "The built-in model works from the first message. Keys are only for the models you add yourself.", ok: false },
  { tag: "What happens immediately", title: "The chat opens", body: "The session is set by the signup response itself, so there is no verification email to wait for.", ok: true },
  { tag: "Where keys go later", title: "Settings → Provider settings", body: "Custom Models takes a base URL and a key, and offers a connection test and a model test before you rely on it.", ok: true }
];

const faq = [
  {
    q: "What is VupsRouter, in one line?",
    a: "A signed-in AI chat workspace that ships with its own model, keeps your saved provider configurations separate from it, and shows which route answered every reply."
  },
  {
    q: "Who is it for?",
    a: "People who use a chat as working software — coding, research, drafting, learning — and who want the thread, the model and the output in one place instead of four browser tabs."
  },
  {
    q: "Do I need an API key to start chatting?",
    a: "No. Vups v3 Galax runs on the VupsRouter backend and is available as soon as your account exists. Shared free models are rate-limited, so limits apply and availability can change."
  },
  {
    q: "Which providers can I connect with my own key?",
    a: `The registry ships ${PROVIDER_COUNT} entries across ${CATEGORY_COUNT} categories — aggregators, direct model providers, local gateways such as Ollama, vLLM, LocalAI and LM Studio, and custom compatible endpoints. They speak ${PROTOCOL_FAMILIES} protocol families: ${IMPLEMENTED_NAMES.join(", ")}.`
  },
  {
    q: "How does model selection work?",
    a: "The composer lists the built-in model and every configuration you saved, each with its own models. The selected route stays visible while the reply streams. Selecting one provider's model never spends another provider's key — a mismatch is rejected and reported."
  },
  {
    q: "Is an account required?",
    a: "Yes. Conversations, saved configurations and quotas are all per-account, which is what lets a thread be reopened later and deleted by you from the sidebar."
  },
  {
    q: "What does it cost?",
    a: "There is no paid plan configured to describe, so this page makes no pricing claim. The built-in model is shared and rate-limited; requests through your own provider are billed by that provider, not by VupsRouter."
  },
  {
    q: "Where is my API key stored?",
    a: "Encrypted server-side with AES-256-GCM and returned to the interface only in masked form. Each saved configuration keeps its own ID, endpoint, key and model list."
  },
  {
    q: "What happens when a request fails?",
    a: "The chat distinguishes a missing key, an unavailable model, a provider outage and a quota limit, and keeps the message visible instead of showing an empty answer. If a turn fails after partial output, what already arrived is kept."
  },
  {
    q: "Can I download what the model produced?",
    a: "Yes. If a reply names code files inside fenced blocks, VupsRouter can build a downloadable project ZIP from them."
  },
  {
    q: "What happens when a conversation gets too long?",
    a: "The context-limit failure is classified, the blocked part is explained, and you are offered a new conversation carrying a written handoff summary."
  },
  {
    q: "Where do I get help?",
    a: "The policy pages carry the operator's legal contact; a support ticket system is not configured yet. The features and about pages document what is built and where the limits are."
  }
];

/* ------------------------------------------------------------------ */
/* Hooks                                                              */
/* ------------------------------------------------------------------ */

function useActiveSection(ids) {
  const [active, setActive] = useState(ids[0]);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return undefined;
    const nodes = ids.map(id => document.getElementById(id)).filter(Boolean);
    if (!nodes.length) return undefined;
    const observer = new IntersectionObserver(
      entries => {
        const seen = entries.filter(entry => entry.isIntersecting);
        if (seen.length) setActive(seen[0].target.id);
      },
      { rootMargin: "-90px 0px -55% 0px", threshold: [0, 0.2, 0.6] }
    );
    for (const node of nodes) observer.observe(node);
    return () => observer.disconnect();
  }, [ids]);

  return active;
}

/* ------------------------------------------------------------------ */
/* Atoms                                                              */
/* ------------------------------------------------------------------ */

function Chip({ children, tone = "flat", icon = null }) {
  return <span className={`vd-chip vd-chip--${tone}`}>{icon}{children}</span>;
}

function Head({ num, tag, title, accent, note }) {
  return (
    <header className="vd-head">
      <div className="vd-head__meta">
        <span className="vd-head__num">{num}</span>
        <span className="vd-rule" data-rule aria-hidden="true" />
        <span className="vd-head__tag">{tag}</span>
      </div>
      <h2 className="vd-head__title">
        {title}
        {accent ? <em> {accent}</em> : null}
      </h2>
      {note ? <p className="vd-head__note">{note}</p> : null}
    </header>
  );
}

function Rail({ active, reduceMotion }) {
  return (
    <nav className="vd-rail" aria-label="Page sections">
      <span className="vd-progress" aria-hidden="true">
        <i data-progress />
      </span>
      <ul className="vd-rail__list">
        {NAV_SECTIONS.map(section => (
          <li key={section.id}>
            <a
              className={`vd-rail__link${active === section.id ? " is-on" : ""}`}
              href={`#${section.id}`}
              aria-current={active === section.id ? "true" : undefined}
              onClick={event => {
                event.preventDefault();
                scrollHomeSection(section.id, { reduceMotion });
              }}
            >
              {section.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/* The composition used when the three.js scene is not mounted — a narrow window,
   a coarse pointer, reduced motion, or no GL context at all.
   The ReactBits Metallic Paint logo is one WebGL2 quad with no scene in it, so it
   runs here too whenever the browser can compile it: losing the scene is not
   losing the logo. The flat SVG mark is what a machine without that context (or
   without the logo file) gets, and only a verified failure is spoken about. */
function StagePoster({ theme, motion }) {
  const facts = useMemo(() => markFacts(), []);
  const [paint, setPaint] = useState("pending");
  return (
    <div className="vd-poster" aria-hidden="true" style={{ aspectRatio: String(STAGE_ASPECT) }}>
      <MetalLogoSurface motion={motion} onState={setPaint}>
        <VupsLogo className="vd-poster__mark" sizes="340px" alt="" />
      </MetalLogoSurface>
      <p className="vd-poster__caption">
        {facts.plate} · {facts.branches.length} branches · {facts.nodes.length} ring nodes · source {facts.source}
      </p>
      <ul className="vd-poster__list">
        {ledger.groups.map(group => (
          <li key={group.id}>
            {group.label} <b>{group.count}</b>
          </li>
        ))}
      </ul>
      {paint === "no-webgl2" ? (
        <span className={`vd-poster__state vd-poster__state--${theme}`}>
          flat composition — this browser has no WebGL2 context
        </span>
      ) : null}
    </div>
  );
}

/* Which pose the canvas is holding, read out from the scroll position — not from
   anything the renderer reports back. */
function Hud() {
  const phases = [
    { id: "hero", label: "The mark" },
    { id: "product", label: "The interface" },
    { id: "network", label: "The network" }
  ];
  return (
    <div className="vd-hud" aria-hidden="true">
      {phases.map(phase => (
        <span className="vd-hud__item" data-phase-id={phase.id} key={phase.id}>
          <i />
          {phase.label}
        </span>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The dimensional act: one sticky stage, three poses                 */
/* ------------------------------------------------------------------ */

function Act({ pose, theme, tier, motion, webgl, onLost, signedIn, onPrimary }) {
  const poster = <StagePoster theme={theme} motion={motion} />;
  return (
    <section className="vd-act" data-stage-act data-phase="hero">
      <div className="vd-act__stage">
        {webgl ? (
          <StageBoundary fallback={poster} onFail={onLost}>
            <Suspense fallback={poster}>
              <DimensionStage pose={pose} theme={theme} tier={tier} onLost={onLost} />
            </Suspense>
          </StageBoundary>
        ) : (
          poster
        )}
        <Hud />
      </div>

      <div className="vd-act__flow">
        <section className="vd-panel vd-panel--hero" id="overview">
          <div className="vd-wrap">
            <div className="vd-hero">
              <p className="vd-eyebrow" data-hero-eyebrow>
                Vups / Computational Dimension
              </p>
              <p className="vd-eyebrow vd-eyebrow--sub" data-hero-eyebrow>
                AI chat · model routing · saved threads
              </p>
              <h1 className="vd-h1" data-hero-title>
                Every model you trust, in one thread.
              </h1>
              <p className="vd-lead" data-hero-lead>
                A chat workspace that ships with its own model, keeps the provider configurations you saved in
                separate compartments, and leaves the route you chose on screen after the reply lands.
              </p>
              <div className="vd-actions" data-hero-actions>
                <Button
                  variant="contained"
                  size="large"
                  endIcon={<ArrowRight size={17} />}
                  className="vd-btn"
                  onClick={onPrimary}
                >
                  {signedIn ? "Back to the chat" : "Create an account"}
                </Button>
                <Link className="vd-link vd-link--major" to="/download">
                  Download <ArrowRight size={15} />
                </Link>
              </div>
              <dl className="vd-facts" data-hero-facts>
                {specs.map(spec => (
                  <div className="vd-facts__item" key={spec.label}>
                    <dt>{spec.label}</dt>
                    <dd>{spec.value}</dd>
                    <span className="vd-facts__note">{spec.note}</span>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        </section>

        <section className="vd-panel vd-panel--product" id="showcase">
          <div className="vd-wrap">
            <div className="vd-product">
              <Head
                num="02"
                tag="THE INTERFACE"
                title="The states you actually meet,"
                accent="described, not staged."
                note="Nothing in this frame sends a request. It is a drawing of the composer row and the four states the real chat passes through — no reply is invented and no output is simulated."
              />

              <div className="vd-specimen" data-rise>
                <div className="vd-specimen__bar">
                  <span className="vd-specimen__name">vupsrouter / chat</span>
                  <span className="vd-specimen__tag">illustrated — not a live request</span>
                </div>
                <div className="vd-specimen__body">
                  <p className="vd-specimen__input">
                    Make the sidebar collapse under 720px without losing the scroll position
                  </p>
                  <div className="vd-specimen__chips">
                    <Chip tone="on" icon={<Sparkles size={12} />}>Vups v3 Galax</Chip>
                    <Chip>Motion Design</Chip>
                    <Chip>Precise</Chip>
                    <Chip icon={<Images size={12} />}>Attach</Chip>
                  </div>
                </div>
              </div>

              <ul className="vd-ticks" data-rise-group>
                {realStates.map(line => (
                  <li key={line}>
                    <Check size={14} /> {line}
                  </li>
                ))}
              </ul>

              <Link className="vd-link" to="/features#workspace">
                What the workspace keeps <ArrowRight size={15} />
              </Link>
            </div>
          </div>
        </section>

        <section className="vd-panel vd-panel--network" id="models">
          <div className="vd-wrap">
            <div className="vd-network">
              <Head
                num="03"
                tag="MODEL CHOICE"
                title="The route you pick is the route you see."
                note={constellationDisclaimer()}
              />

              <p className="vd-names">{PROVIDERS.map(provider => provider.name).join(" · ")}</p>

              <div className="vd-network__foot">
                <Link className="vd-link" to="/features#models">
                  How key isolation works <ArrowRight size={15} />
                </Link>
                <Link className="vd-link" to="/settings">
                  Provider settings <ArrowRight size={15} />
                </Link>
              </div>
            </div>
          </div>
        </section>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Editorial bands                                                    */
/* ------------------------------------------------------------------ */

function ProblemsBand() {
  return (
    <section className="vd-band vd-band--slab" id="problems">
      <div className="vd-wrap">
        <Head
          num="04"
          tag="WHAT IT FIXES"
          title="Five everyday failures,"
          accent="each with a visible answer."
          note="Each behaviour on the right is reachable in the running app. None of them are roadmap items."
        />

        <div className="vd-qa">
          <div className="vd-qa__head" aria-hidden="true">
            <span>№</span>
            <span>Without it</span>
            <span>In VupsRouter</span>
          </div>
          <ul className="vd-qa__rows" data-rise-group>
            {problems.map((row, index) => (
              <li className="vd-qa__row" key={row.before}>
                <span className="vd-qa__no">{String(index + 1).padStart(2, "0")}</span>
                <div className="vd-qa__cell vd-qa__cell--before">
                  <h3>{row.before}</h3>
                  <p>{row.beforeNote}</p>
                </div>
                <div className="vd-qa__cell vd-qa__cell--now">
                  <h3>{row.now}</h3>
                  <p>{row.nowNote}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

function CapabilitiesBand() {
  return (
    <section className="vd-band" id="features">
      <div className="vd-wrap">
        <Head
          num="05"
          tag="CAPABILITIES"
          title="Built already,"
          accent="not on a roadmap."
          note="Six things you can click today. Each panel links to the part of the features page that documents it — no invented comparisons and no competitor claims."
        />

        <div className="vd-bento" data-rise-group>
          {capabilityCells.map(cell => (
            <article className={`vd-cell vd-cell--${cell.size}`} key={cell.id}>
              <span className="vd-cell__icon">{cell.icon}</span>
              <h3>{cell.title}</h3>
              <p>{cell.body}</p>
              {cell.list ? (
                <ul className="vd-cell__list">
                  {cell.list.map(line => (
                    <li key={line}>
                      <Check size={14} /> {line}
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="vd-cell__foot">
                <Link className="vd-cell__link" to={cell.to}>
                  {cell.linkText || "Read the detail"} <ArrowRight size={14} />
                </Link>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function ProcessBand() {
  return (
    <section className="vd-band vd-band--rule" id="flow">
      <div className="vd-wrap">
        <Head
          num="06"
          tag="THE JOURNEY"
          title="Three moves, start to"
          accent="finished thread."
          note="This is the user-visible path — what you click and what you see. What happens between the send button and the reply is the product's own implementation, and this page leaves it there."
        />

        <div className="vd-process" data-process>
          <span className="vd-process__rail" data-process-rail aria-hidden="true" />
          <ol className="vd-process__steps" data-rise-group>
            {flowSteps.map(step => (
              <li className="vd-step" key={step.no}>
                <span className="vd-step__no">{step.no}</span>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
                <div className="vd-step__tags">
                  {step.tags.map(tag => (
                    <Chip key={tag}>{tag}</Chip>
                  ))}
                </div>
              </li>
            ))}
          </ol>
        </div>

        <p className="vd-quote" data-drift>
          <strong>Nothing here is a scoring engine you have to trust.</strong> You choose the route in the composer;
          the app keeps that choice visible and refuses to spend a key you saved somewhere else.
        </p>
      </div>
    </section>
  );
}

function ExperienceBand() {
  return (
    <section className="vd-band" id="experience">
      <div className="vd-wrap">
        <Head
          num="07"
          tag="IN USE"
          title="One conversation,"
          accent="five states."
          note="The sequence a real turn moves through. Described rather than demonstrated, because a landing page cannot honestly replay a provider."
        />

        <div className="vd-split">
          <ol className="vd-states" data-rise-group>
            {stages.map(stage => (
              <li className="vd-state" key={stage.no}>
                <span className="vd-state__no">{stage.no}</span>
                <div>
                  <h3>{stage.title}</h3>
                  <p>{stage.body}</p>
                </div>
              </li>
            ))}
          </ol>

          <dl className="vd-craft" data-rise-group>
            {craftChecks.map(check => (
              <div className="vd-craft__item" key={check.title}>
                <dt>
                  {check.icon} {check.title}
                  <span className="vd-craft__term">{check.term}</span>
                </dt>
                <dd>{check.body}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </section>
  );
}

function PrivacyBand() {
  return (
    <section className="vd-band vd-band--slab" id="privacy">
      <div className="vd-wrap">
        <Head
          num="08"
          tag="PRIVACY & LIMITS"
          title="What is protected,"
          accent="and what is not promised."
          note="The left column is behaviour the app implements. The right column is where it stops. There is no paid plan configured to describe, so this page makes no pricing claim."
        />

        <div className="vd-split">
          <ul className="vd-promises" data-rise-group>
            {promises.map(item => (
              <li className="vd-promise" key={item.title}>
                <span className="vd-promise__icon">{item.icon}</span>
                <div>
                  <h3>{item.title}</h3>
                  <p>{item.body}</p>
                </div>
              </li>
            ))}
          </ul>

          <ol className="vd-limits" data-rise-group>
            {limits.map((line, index) => (
              <li className="vd-limit" key={line}>
                <span className="vd-limit__no">{String(index + 1).padStart(2, "0")}</span>
                <p>{line}</p>
              </li>
            ))}
          </ol>
        </div>

        <div className="vd-band__actions" data-rise>
          <Button variant="outlined" component={Link} to="/privacy" className="vd-btn vd-btn--ghost">
            Privacy policy
          </Button>
          <Button variant="outlined" component={Link} to="/terms" className="vd-btn vd-btn--ghost">
            Terms
          </Button>
          <Button variant="outlined" component={Link} to="/about" className="vd-btn vd-btn--ghost">
            About the operator
          </Button>
        </div>
      </div>
    </section>
  );
}

function FaqBand() {
  return (
    <section className="vd-band vd-band--rule" id="faq">
      <div className="vd-wrap">
        <Head
          num="09"
          tag="QUESTIONS"
          title="Twelve answers,"
          accent="no sales deck."
          note="These are native details elements — they open with a keyboard, work with scripts disabled, and hold the same text either way."
        />

        <div className="vd-faq">
          {faq.map((item, index) => (
            <details className="vd-faq__item" key={item.q} open={index === 0}>
              <summary className="vd-faq__q">
                <span className="vd-faq__no">{String(index + 1).padStart(2, "0")}</span>
                {item.q}
              </summary>
              <p className="vd-faq__a">{item.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

function StartBand({ signedIn, onPrimary }) {
  return (
    <section className="vd-band vd-band--start" id="start">
      <div className="vd-wrap">
        <div className="vd-start">
          <div className="vd-start__copy">
            <p className="vd-eyebrow" data-hero-eyebrow>
              Getting in
            </p>
            <h2 className="vd-h2" data-hero-title>
              An account, then a conversation.
            </h2>
            <p className="vd-lead" data-hero-lead>
              Signup asks for an email, a name and a password. The built-in model answers from the first message, so a
              provider key is something you add when you want a specific route — not a ticket to get in.
            </p>
            <div className="vd-actions" data-hero-actions>
              <Button
                variant="contained"
                size="large"
                endIcon={<ArrowRight size={17} />}
                className="vd-btn"
                onClick={onPrimary}
              >
                {signedIn ? "Back to the chat" : "Create an account"}
              </Button>
              <Button variant="outlined" component={Link} to="/signin" className="vd-btn vd-btn--ghost">
                I already have one
              </Button>
            </div>
            <div className="vd-start__links">
              <Link className="vd-link" to="/features">
                <BookOpen size={15} /> Features <ArrowRight size={14} />
              </Link>
              <Link className="vd-link" to="/about">
                <Layers size={15} /> About <ArrowRight size={14} />
              </Link>
              <Link className="vd-link" to="/download">
                <Download size={15} /> Desktop app <ArrowRight size={14} />
              </Link>
            </div>
          </div>

          <ul className="vd-needs" data-rise-group>
            {needs.map(item => (
              <li className="vd-need" key={item.title}>
                <span className="vd-need__tag">{item.tag}</span>
                <h3>
                  {item.ok ? <Check size={14} /> : <KeyRound size={14} />} {item.title}
                </h3>
                <p>{item.body}</p>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                               */
/* ------------------------------------------------------------------ */

export default function LandingPage() {
  const scope = useRef(null);
  const pose = useRef({ progress: 0, value: null });
  const navigate = useNavigate();
  const { status } = useAuth();
  const signedIn = status === "authenticated";
  const { theme } = useHomeTheme();
  const { tier, reducedMotion } = useDimensionTier();
  const [glLost, setGlLost] = useState(false);

  const webgl = Boolean(tier?.webgl) && !glLost;
  useHomeMotion({ scopeRef: scope, poseRef: pose, animate: !reducedMotion });

  const sectionIds = useMemo(() => NAV_SECTIONS.map(section => section.id), []);
  const active = useActiveSection(sectionIds);

  const goPrimary = () =>
    navigate(signedIn ? "/chat" : "/signup", { state: signedIn ? undefined : { from: "/chat" } });

  return (
    <>
      <PageMeta
        title="VupsRouter — AI chat and model routing"
        description="Chat with Vups v3 Galax, keep your conversations, and route requests through your own AI provider keys."
      />
      <div className="landing vr vd" ref={scope}>
        <SiteHeader />
        <Rail active={active} reduceMotion={reducedMotion} />
        <main id="main-content" className="vd-main">
          <Act
            pose={pose}
            theme={theme}
            tier={tier}
            motion={!reducedMotion}
            webgl={webgl}
            onLost={() => setGlLost(true)}
            signedIn={signedIn}
            onPrimary={goPrimary}
          />
          <ProblemsBand />
          <CapabilitiesBand />
          <ProcessBand />
          <ExperienceBand />
          <PrivacyBand />
          <FaqBand />
          <StartBand signedIn={signedIn} onPrimary={goPrimary} />
        </main>
        <LandingFooter />
      </div>
    </>
  );
}
