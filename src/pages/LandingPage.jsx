import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@mui/material";
import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Boxes,
  Check,
  ChevronDown,
  Code2,
  Download,
  Eye,
  FileArchive,
  Images,
  KeyRound,
  Keyboard,
  Layers,
  Lock,
  MessageSquare,
  MessagesSquare,
  Palette,
  PenLine,
  Play,
  Route,
  Settings2,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Terminal,
  TriangleAlert,
  Waypoints,
  Zap
} from "lucide-react";

import SiteHeader from "../components/SiteHeader.jsx";
import LandingFooter from "../components/LandingFooter.jsx";
import PageMeta from "../components/PageMeta.jsx";
import RollingTube3D from "../components/landing/RollingTube3D.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { PROVIDERS, PROVIDER_CATEGORIES, providersByCategory } from "../providers/registry.js";

import {
  Reveal,
  StaggerGroup,
  StaggerItem,
  HoverSurface,
  TiltCard,
  TiltItem,
  motion,
  AnimatePresence,
  useReducedMotion
} from "../components/motion/primitives.jsx";

// React Bits (vendored: src/components/reactbits)
import DecryptedText from "../components/reactbits/DecryptedText/DecryptedText.jsx";
import FadeContent from "../components/reactbits/FadeContent/FadeContent.jsx";
import SplitText from "../components/reactbits/SplitText/SplitText.jsx";
import BlurText from "../components/reactbits/BlurText/BlurText.jsx";
import ScrollFloat from "../components/reactbits/ScrollFloat/ScrollFloat.jsx";
import GradientText from "../components/reactbits/GradientText/GradientText.jsx";
import RbShinyText from "../components/reactbits/ShinyText/ShinyText.jsx";
import AnimatedContent from "../components/reactbits/AnimatedContent/AnimatedContent.jsx";
import SpotlightCard from "../components/reactbits/SpotlightCard/SpotlightCard.jsx";
import Magnet from "../components/reactbits/Magnet/Magnet.jsx";
import GlareHover from "../components/reactbits/GlareHover/GlareHover.jsx";
import StarBorder from "../components/reactbits/StarBorder/StarBorder.jsx";

// Lightswind UI (vendored: src/components/lightswind)
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "../components/lightswind/accordion";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/lightswind/tabs";
import { Separator } from "../components/lightswind/separator";
import { Badge } from "../components/lightswind/badge";
import { Progress } from "../components/lightswind/progress";
import { Skeleton } from "../components/lightswind/skeleton";
import { DotPattern } from "../components/lightswind/dot-pattern";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../components/lightswind/hover-card";
import { BorderBeam } from "../components/lightswind/border-beam";
import LwCountUp from "../components/lightswind/count-up";
import ScrollReveal from "../components/lightswind/scroll-reveal";

import "../styles/tailwind-landing.css";
import "./landing/home.css";

/* ------------------------------------------------------------------ */
/* Verified product data — every figure is counted from the app itself */
/* ------------------------------------------------------------------ */

const CHAT_MODES = [
  { key: "general", name: "General", description: "Everyday answers, research, and coding help" },
  { key: "motion", name: "Motion Design", description: "Animation engineering, GSAP, and visual implementation" }
];

const VUPS_EFFORTS = ["Precise", "Balanced", "Creative"];

const PROVIDER_COUNT = PROVIDERS.length;
const CATEGORY_COUNT = PROVIDER_CATEGORIES.length;
const PROTOCOL_FAMILIES = [...new Set(PROVIDERS.map(p => p.compatibility))].length;

const providerCategories = PROVIDER_CATEGORIES.map(category => ({
  id: category.id,
  label: category.label,
  hint: category.hint || "",
  list: providersByCategory(category.id)
}));

const ribbonNames = PROVIDERS.map(p => p.name);

const NAV_SECTIONS = [
  { id: "overview", label: "What it is" },
  { id: "problems", label: "What it fixes" },
  { id: "showcase", label: "The interface" },
  { id: "features", label: "Capabilities" },
  { id: "models", label: "Model choice" },
  { id: "use-cases", label: "Use cases" },
  { id: "flow", label: "The journey" },
  { id: "craft", label: "Usability" },
  { id: "privacy", label: "Privacy" },
  { id: "get-started", label: "Getting in" },
  { id: "faq", label: "Questions" },
  { id: "start", label: "Start" }
];

/* ------------------------------------------------------------------ */
/* Hooks                                                              */
/* ------------------------------------------------------------------ */

function useScrollProgress() {
  const [value, setValue] = useState(0);

  useEffect(() => {
    let frame = 0;
    function measure() {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const doc = document.documentElement;
        const span = doc.scrollHeight - window.innerHeight;
        setValue(span > 0 ? Math.min(100, Math.max(0, (window.scrollY / span) * 100)) : 0);
      });
    }
    measure();
    window.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  }, []);

  return value;
}

function useActiveSection(ids) {
  const [active, setActive] = useState("");
  const key = ids.join("|");

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return undefined;
    const nodes = key.split("|").map(id => document.getElementById(id)).filter(Boolean);
    if (!nodes.length) return undefined;
    const observer = new IntersectionObserver(
      entries => {
        const visible = entries
          .filter(entry => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible) setActive(visible.target.id);
      },
      { rootMargin: "-100px 0px -55% 0px", threshold: [0, 0.2, 0.55] }
    );
    nodes.forEach(node => observer.observe(node));
    return () => observer.disconnect();
  }, [key]);

  return active;
}

function scrollToId(id) {
  const target = document.getElementById(id);
  if (!target) return false;
  target.scrollIntoView({ behavior: "smooth", block: "start" });
  return true;
}

/* ------------------------------------------------------------------ */
/* Shared pieces                                                      */
/* ------------------------------------------------------------------ */

function Ruler({ value }) {
  return (
    <Progress
      value={value}
      max={100}
      color="primary"
      size="sm"
      className="vr-ruler"
      indicatorClassName="vr-ruler__bar"
      aria-label="Page scroll progress"
    />
  );
}

function Rail({ active }) {
  return (
    <nav className="vr-rail" aria-label="Page sections">
      <div className="vr-rail__inner">
        <span className="vr-rail__label">CONTENTS</span>
        {NAV_SECTIONS.map((section, index) => (
          <a
            key={section.id}
            href={`#${section.id}`}
            className={active === section.id ? "vr-rail__link vr-rail__link--on" : "vr-rail__link"}
            aria-current={active === section.id ? "true" : undefined}
            onClick={event => {
              event.preventDefault();
              scrollToId(section.id);
            }}
          >
            <i aria-hidden="true" />
            <span>{String(index + 1).padStart(2, "0")}</span>
            <span>{section.label}</span>
          </a>
        ))}
      </div>
    </nav>
  );
}

function SectionHead({ num, title, accent, note, tag, split }) {
  return (
    <Reveal as="header" className={split ? "vr-head vr-head--split" : "vr-head"}>
      <div>
        <div className="vr-head__meta">
          <span className="vr-mono vr-head__num">{num}</span>
          <motion.span
            className="vr-head__rule"
            initial={{ scaleX: 0 }}
            whileInView={{ scaleX: 1 }}
            viewport={{ once: true, amount: 0.4 }}
            transition={{ duration: 0.7, ease: [0.22, 0.61, 0.36, 1] }}
            aria-hidden="true"
          />
          {tag ? <span className="vr-mono vr-head__tag">{tag}</span> : null}
        </div>
        <h2 className="vr-head__title">
          {title}
          {accent ? <em> {accent}</em> : null}
        </h2>
      </div>
      {note ? <p className="vr-head__note">{note}</p> : null}
    </Reveal>
  );
}

function Chip({ children, tone }) {
  return <span className={tone ? `vr-chip vr-chip--${tone}` : "vr-chip"}>{children}</span>;
}

/* ------------------------------------------------------------------ */
/* 01 — hero                                                          */
/* ------------------------------------------------------------------ */

const specs = [
  { label: "Built-in model", value: "Vups v3 Galax", note: `${CHAT_MODES.length} prompt modes · ${VUPS_EFFORTS.length} reasoning levels` },
  { label: "Provider registry", value: `${PROVIDER_COUNT} entries`, note: `${CATEGORY_COUNT} categories, counted from the app` },
  { label: "Protocol families", value: `${PROTOCOL_FAMILIES}`, note: "OpenAI-compatible, Anthropic, Azure, watsonx" },
  { label: "Account setup", value: "Email + password", note: "No key required for the built-in model" }
];

function Hero() {
  const navigate = useNavigate();
  const { status } = useAuth();
  const signedIn = status === "authenticated";

  return (
    <section id="top" className="vr-hero">
      <span className="vr-hero__sweep" aria-hidden="true" />
      <span className="vr-hero__rules" aria-hidden="true" />

      <div className="vr-wrap">
        <div className="vr-hero__inner">
          <div>
            <DecryptedText
              text="AI CHAT · MODEL ROUTING · SAVED THREADS"
              animateOn="view"
              effect="scramble"
              speed={26}
              maxIterations={9}
              revealDirection="start"
              parentClassName="vr-mono vr-hero__eyebrow"
              className="vr-hero__char"
              encryptedClassName="vr-hero__char vr-hero__char--locked"
              scrambleColor="#3f6fe8"
            />

            <FadeContent blur duration={0.7} threshold={0.2} className="vr-hero__title">
              <h1 className="vr-h1">
                <span className="vr-h1__light">Every model you trust,</span>
                <span className="vr-h1__heavy">
                  in one <span className="vr-h1__accent">thread.</span>
                </span>
              </h1>
            </FadeContent>

            <Reveal as="p" delay={0.12} className="vr-hero__lead">
              VupsRouter is a signed-in AI chat workspace. Vups v3 Galax is already inside it, your own provider
              configurations sit beside it, and the model answering each reply stays visible while it writes.
            </Reveal>

            <Reveal delay={0.2} className="vr-hero__actions">
              <StarBorder
                as="button"
                type="button"
                color="#bcd4ff"
                trailColor="rgba(108,155,255,.2)"
                backgroundColor="#13203a"
                textColor="#eaf1ff"
                borderColor="rgba(148,163,184,.26)"
                duration={5}
                thickness={1}
                radius={999}
                trailLength={0.34}
                stars={2}
                glow={0.8}
                sparkle
                hover="brighten"
                className="vr-star-cta"
                onClick={() => navigate(signedIn ? "/chat" : "/signup", { state: signedIn ? undefined : { from: "/chat" } })}
              >
                {signedIn ? "Open the chat" : "Start free chat"} <ArrowRight size={17} />
              </StarBorder>
              <a
                className="vr-hero__link"
                href="#showcase"
                onClick={event => {
                  event.preventDefault();
                  scrollToId("showcase");
                }}
              >
                See the interface <ArrowUpRight size={15} />
              </a>
            </Reveal>
          </div>

          <div style={{ display: "grid", gap: 0 }}>
            <Reveal as="dl" delay={0.16} className="vr-specs">
              {specs.map(spec => (
                <div className="vr-spec" key={spec.label}>
                  <dt>{spec.label}</dt>
                  <dd>
                    {spec.value}
                    <small>{spec.note}</small>
                  </dd>
                </div>
              ))}
            </Reveal>

            <RollingTube3D text={`${PROVIDER_COUNT} PROVIDERS`} />
          </div>
        </div>

        <ConsoleStrip />
      </div>
    </section>
  );
}

function ConsoleStrip() {
  return (
    <Reveal delay={0.1} className="vr-console">
      <DotPattern className="vr-console__dots" width={18} height={18} cx={2} cy={2} cr={1} />
      <div className="vr-console__slab">
        <div className="vr-console__bar">
          <span className="vr-console__lamp" aria-hidden="true"><b /><b /><b /></span>
          <span className="vr-console__tab">chat / new conversation</span>
          <Chip tone="on"><Sparkles size={12} /> Vups v3 Galax</Chip>
          <span className="vr-console__note">illustrated — not a live request</span>
        </div>

        <div className="vr-console__body">
          <div className="vr-thread">
            <div className="vr-turn vr-turn--you">
              <span className="vr-turn__who">You</span>
              <p className="vr-turn__text">
                Refactor this component so the list virtualises past 200 rows, and keep the reduced-motion branch intact.
              </p>
            </div>
            <div className="vr-turn">
              <span className="vr-turn__who">Vups</span>
              <div className="vr-turn__text">
                <span className="vr-turn__bar vr-turn__bar--w1" aria-hidden="true" />
                <span className="vr-turn__bar vr-turn__bar--w2" aria-hidden="true" style={{ marginTop: 8, display: "block" }} />
              </div>
            </div>
          </div>

          <div className="vr-compose">
            <span className="vr-compose__input">
              <MessageSquare size={15} />
              Ask for the smallest change that fixes it
              <span className="vr-caret" aria-hidden="true" />
            </span>
            <Chip>General</Chip>
            <Chip>Balanced</Chip>
            <Chip tone="dashed"><Images size={12} /> Attach</Chip>
            <span className="vr-compose__send">Send <ArrowRight size={13} /></span>
          </div>
        </div>
      </div>
    </Reveal>
  );
}

function Ribbon() {
  const doubled = [...ribbonNames, ...ribbonNames];
  return (
    <section className="vr-ribbon" aria-label="Providers available in the registry">
      <div className="vr-ribbon__row" aria-hidden="true">
        {doubled.map((name, index) => (
          <span className="vr-ribbon__item" key={`${name}-${index}`}>{name}</span>
        ))}
      </div>
      <p className="vr-sr">
        The registry ships {PROVIDER_COUNT} providers across {CATEGORY_COUNT} categories.
      </p>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* 02 — overview                                                      */
/* ------------------------------------------------------------------ */

const overviewCells = [
  { num: PROVIDER_COUNT, label: "providers in the registry", duration: 1.5 },
  { num: CATEGORY_COUNT, label: "provider categories", duration: 1.2 },
  { num: PROTOCOL_FAMILIES, label: "protocol families spoken", duration: 1.2 },
  { num: CHAT_MODES.length, label: "prompt modes on the built-in model", duration: 1 }
];

const overviewTrio = [
  {
    kicker: "Who it is for",
    title: "People who use a chat as working software",
    body: "Writing code, reading a paper, drafting a document — the thread is the workspace, so it has to keep the model, the files and the history in one place."
  },
  {
    kicker: "What you get immediately",
    title: "A model that is already there",
    body: "Vups v3 Galax answers as soon as the account exists. No provider key, no base URL, no configuration step between signing up and the first reply."
  },
  {
    kicker: "What you add later",
    title: "Your own routes, kept separate",
    body: "Each saved provider keeps its own endpoint, key and model list. The composer then offers the built-in model and yours side by side, visibly."
  }
];

function OverviewSection() {
  return (
    <section id="overview" className="vr-band vr-band--rule">
      <div className="vr-wrap">
        <SectionHead
          num="02"
          tag="WHAT THIS IS"
          title="One interface for the model you borrow"
          accent="and the models you own."
          split
          note="VupsRouter is a chat product with a first-party model inside it and your own provider configurations beside it. This page describes behaviour that exists in the running app today."
        />

        <BlurText
          text="A chat that hides which model answered is a chat you cannot debug. VupsRouter keeps the selected model, the prompt mode and the reasoning level in the composer row — during the reply and after it lands — and never lets one saved configuration borrow another one's key."
          animateBy="words"
          direction="top"
          delay={26}
          stepDuration={0.3}
          blur={8}
          distance={22}
          color="#cfd9e8"
          className="vr-lead"
        />

        <Reveal as="p" delay={0.06} className="vr-lead">
          <strong>The rest of this page is the inventory.</strong> Every count is read from the provider registry and
          every state shown in the preview is a state the real chat has. Where the product has no answer yet, this page
          says so instead of inventing one.
        </Reveal>

        <StaggerGroup as="div" className="vr-ledger" stagger={0.08} trigger="view">
          {overviewCells.map(cell => (
            <TiltItem as="div" key={cell.label} max={4} className="vr-ledger__cell vr-lift">
              <LwCountUp
                value={cell.num}
                duration={cell.duration}
                animationStyle="gentle"
                className="vr-ledger__num"
              />
              <span className="vr-ledger__label">{cell.label}</span>
            </TiltItem>
          ))}
        </StaggerGroup>

        <StaggerGroup as="div" className="vr-trio" stagger={0.09} trigger="view">
          {overviewTrio.map(item => (
            <TiltItem as="div" key={item.title} className="vr-trio__item vr-lift">
              <span className="vr-trio__kicker">{item.kicker}</span>
              <h3>{item.title}</h3>
              <p>{item.body}</p>
            </TiltItem>
          ))}
        </StaggerGroup>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* 03 — problems                                                      */
/* ------------------------------------------------------------------ */

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

function ProblemsSection() {
  return (
    <section id="problems" className="vr-band vr-band--slab">
      <div className="vr-wrap">
        <SectionHead
          num="03"
          tag="WHAT IT FIXES"
          title="Five everyday failures,"
          accent="each with a visible answer."
          split
          note="These are the problems the product was shaped around. Each behaviour in the right-hand column is reachable in the running app — none of them are roadmap items."
        />

        <div className="vr-qa">
          <div className="vr-qa__head" aria-hidden="true">
            <span>№</span>
            <span>Without it</span>
            <span>In VupsRouter</span>
          </div>

          <StaggerGroup as="ul" className="vr-qa__rows" stagger={0.06} delay={0} trigger="view" amount={0.1}>
            {problems.map((row, index) => (
              <StaggerItem as="li" className="vr-qa__row vr-qa__row--live" key={row.before}>
                <span className="vr-qa__no">{String(index + 1).padStart(2, "0")}</span>
                <div className="vr-qa__cell vr-qa__cell--before">
                  <h3>{row.before}</h3>
                  <p>{row.beforeNote}</p>
                </div>
                <div className="vr-qa__cell vr-qa__cell--now">
                  <h3>{row.now}</h3>
                  <p>{row.nowNote}</p>
                </div>
              </StaggerItem>
            ))}
          </StaggerGroup>
        </div>
      </div>
      <span className="vr-band__edge" aria-hidden="true" />
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* 04 — showcase                                                      */
/* ------------------------------------------------------------------ */

const STAGES = [
  {
    value: "compose",
    label: "Compose",
    title: "Before you send",
    desc: "The composer carries the message, the selected model, the prompt mode and the reasoning level in one row. Nothing is chosen for you behind it.",
    canvas: (
      <div className="vr-compose" style={{ border: "none", padding: 0, background: "none" }}>
        <span className="vr-compose__input">
          <Terminal size={15} />
          Make the sidebar collapse under 720px without breaking the scroll position
          <span className="vr-caret" aria-hidden="true" />
        </span>
        <Chip tone="on"><Sparkles size={12} /> Vups v3 Galax</Chip>
        <Chip>Motion Design</Chip>
        <Chip>Precise</Chip>
      </div>
    )
  },
  {
    value: "select",
    label: "Select",
    title: "Choosing the route",
    desc: "Built-in model first, then every saved configuration you own — each listed with its own models. Switching never pulls a key from a different provider.",
    canvas: (
      <div className="vr-picklist">
        <span className="vr-pick vr-pick--on"><b>Vups v3 Galax</b><span>built-in · selected</span></span>
        {providerCategories.map(cat => (
          <span className="vr-pick" key={cat.id}>
            <b>{cat.label} · {cat.list[0]?.name || "—"}</b>
            <span>{cat.list.length} in registry</span>
          </span>
        ))}
      </div>
    )
  },
  {
    value: "stream",
    label: "Stream",
    title: "While the reply arrives",
    desc: "Text streams in, the thinking line runs on a real elapsed timer, and the stop control works the whole time.",
    canvas: (
      <div className="vr-stage__stream">
        <p className="vr-stage__think">planning · 2.4s elapsed</p>
        <Skeleton className="vr-turn__bar vr-turn__bar--w1" />
        <Skeleton className="vr-turn__bar" />
        <Skeleton className="vr-turn__bar vr-turn__bar--w2" />
        <Progress value={62} max={100} color="primary" size="sm" aria-label="Illustration: reply generation at 62 percent" />
      </div>
    )
  },
  {
    value: "interrupt",
    label: "Interrupt",
    title: "When you stop it",
    desc: "Stopping keeps what already arrived. The partial reply is saved into the thread instead of vanishing, and the error path stays visible if the turn failed.",
    canvas: (
      <div className="vr-stage__canvas" style={{ border: "none", padding: 0, background: "none" }}>
        <p className="vr-stage__desc" style={{ color: "#cfd9e8" }}>
          Here is the smallest change that fixes it — move the breakpoint into the shell wrapper and drop the
          position: fixed rule…
        </p>
        <span className="vr-stage__halt">Stopped by you · partial saved</span>
      </div>
    )
  },
  {
    value: "deliver",
    label: "Deliver",
    title: "Taking the answer away",
    desc: "Files named inside fenced blocks are collected into a project ZIP. Long threads that reach the ceiling hand off to a new conversation with a written summary.",
    canvas: (
      <div className="vr-stage__files">
        <span className="vr-file"><Boxes size={13} /> index.html</span>
        <span className="vr-file"><Code2 size={13} /> shell.css</span>
        <span className="vr-file"><FileArchive size={13} /> project.zip</span>
      </div>
    )
  }
];

function ShowcaseSection() {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const reduce = useReducedMotion();
  const timers = useRef([]);

  const clearTimers = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };

  useEffect(() => clearTimers, []);

  function play() {
    if (playing) return;
    clearTimers();
    setPlaying(true);
    setIndex(0);
    const step = reduce ? 520 : 1250;
    STAGES.forEach((_, stage) => {
      if (stage === 0) return;
      timers.current.push(setTimeout(() => setIndex(stage), step * stage));
    });
    timers.current.push(setTimeout(() => setPlaying(false), step * STAGES.length + 240));
  }

  return (
    <section id="showcase" className="vr-band vr-band--rule">
      <div className="vr-wrap">
        <SectionHead
          num="04"
          tag="THE INTERFACE"
          title="The states you actually meet,"
          accent="played in order."
          split
          note="Press play and this frame walks the five states the real chat passes through. It is an illustration of product behaviour — nothing here sends a request, and no reply is invented."
        />

        <div className="vr-show">
          <Reveal className="vr-frame">
            {!reduce && (
              <BorderBeam
                size={190}
                duration={11}
                colorFrom="#3f6fe8"
                colorTo="#9dc0ff"
                borderThickness={1}
                glowIntensity={1.4}
                pauseOnHover
                className="vr-frame__beam"
              />
            )}
            <div className="vr-frame__bar">
              <span className="vr-console__lamp" aria-hidden="true"><b /><b /><b /></span>
              <span className="vr-frame__label">vupsrouter / chat</span>
              <span className="vr-frame__live"><i aria-hidden="true" />illustrated preview</span>
            </div>

            <Tabs value={STAGES[index].value} onValueChange={value => {
              clearTimers();
              setPlaying(false);
              setIndex(Math.max(0, STAGES.findIndex(stage => stage.value === value)));
            }} className="vr-frame__body">
              <TabsList className="vr-stage__row" aria-label="Product states">
                {STAGES.map(stage => (
                  <TabsTrigger key={stage.value} value={stage.value}>{stage.label}</TabsTrigger>
                ))}
              </TabsList>

              {STAGES.map(stage => (
                <TabsContent key={stage.value} value={stage.value}>
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.div
                      key={stage.value}
                      className="vr-stage"
                      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 12 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8 }}
                      transition={{ duration: reduce ? 0.12 : 0.3, ease: [0.22, 0.61, 0.36, 1] }}
                    >
                      <h3 className="vr-stage__title">{stage.title}</h3>
                      <p className="vr-stage__desc">{stage.desc}</p>
                      <div className="vr-stage__canvas">{stage.canvas}</div>
                    </motion.div>
                  </AnimatePresence>
                </TabsContent>
              ))}
            </Tabs>

            <div className="vr-frame__foot">
              <button type="button" className="vr-run" onClick={play} disabled={playing}>
                <Play size={13} /> {playing ? "Playing the sequence" : "Play the sequence"}
              </button>
              <p>State {index + 1} of {STAGES.length} · tab through them manually any time.</p>
            </div>
          </Reveal>

          <div className="vr-show__aside">
            <GlareHover
              className="vr-aside__card"
              width="100%"
              height="auto"
              background="var(--vr-flat)"
              borderRadius={12}
              borderColor="var(--vr-line)"
              glareColor="#9dc0ff"
              glareOpacity={0.2}
              glareSize={34}
              softness={0.8}
              variant="sheen"
              mode="hover"
              style={{ display: "block", textAlign: "left" }}
            >
              <h3>What is real in this frame</h3>
              <ul className="vr-aside__list">
                <li><Check size={14} /> The composer row, the mode and reasoning selectors.</li>
                <li><Check size={14} /> Streaming, with a stop control that keeps the partial reply.</li>
                <li><Check size={14} /> Named-file output collected into a project ZIP.</li>
                <li><Check size={14} /> Context ceiling reported and continued in a new thread.</li>
              </ul>
            </GlareHover>

            <Reveal delay={0.08} className="vr-aside__card vr-lift">
              <h3>What is not shown</h3>
              <p>
                How a request is matched to a model once it reaches the backend is the product's own implementation.
                This page stays with what you can see and control.
              </p>
            </Reveal>

            <HoverCard openDelay={140}>
              <HoverCardTrigger asChild>
                <a className="vr-hero__link" href="#models" onClick={event => { event.preventDefault(); scrollToId("models"); }}>
                  <Waypoints size={15} /> How model choice works <ArrowRight size={15} />
                </a>
              </HoverCardTrigger>
              <HoverCardContent className="vr-aside__card">
                <h3>{PROVIDER_COUNT} providers, {CATEGORY_COUNT} categories</h3>
                <p>Aggregators, direct providers, local gateways and custom compatible endpoints — each keeping its own key.</p>
              </HoverCardContent>
            </HoverCard>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* 05 — features (bento)                                              */
/* ------------------------------------------------------------------ */

const featureCells = [
  {
    id: "galax",
    size: "hero",
    icon: <Sparkles />,
    title: "Vups v3 Galax is already in the chat",
    text: "Open a conversation without adding a key. General handles everyday work, research and coding help; Motion Design handles frontend, CSS, GSAP and animation engineering.",
    list: [
      `${CHAT_MODES.length} prompt modes: ${CHAT_MODES.map(m => m.name).join(" and ")}`,
      `${VUPS_EFFORTS.length} reasoning levels: ${VUPS_EFFORTS.join(", ")}`,
      "Both selectors stay visible while the reply streams"
    ],
    to: "/features#vups",
    linkText: "What the modes change"
  },
  {
    id: "routing",
    size: "tall",
    icon: <Route />,
    title: "Your models, kept separate",
    text: "Save a provider and it keeps its own endpoint, key and model list. A request bound to one configuration cannot silently borrow another provider's key.",
    list: [
      `${PROVIDER_COUNT} providers across ${CATEGORY_COUNT} categories in the registry`,
      `${PROTOCOL_FAMILIES} protocol families implemented`,
      "A mismatched model is rejected, not re-routed in the dark"
    ],
    to: "/features#models",
    linkText: "How key isolation works"
  },
  {
    id: "workspace",
    size: "sm",
    icon: <MessagesSquare />,
    title: "The thread keeps the work",
    text: "Replies stream and can be stopped mid-generation. Conversations save per account, reopen later, or delete from the sidebar.",
    to: "/features#workspace"
  },
  {
    id: "vision",
    size: "sm",
    icon: <Images />,
    title: "Image input when the model supports it",
    text: "Attach PNG, JPEG, WebP or GIF. A model without vision returns a clear error instead of silently dropping the file.",
    to: "/features#workspace"
  },
  {
    id: "limits",
    size: "sm",
    icon: <ShieldCheck />,
    title: "Limits are shown, not hidden",
    text: "Shared free models are checked against server status, and errors distinguish a missing key, an unavailable model, an outage and a quota limit.",
    to: "/features#controls"
  }
];

function FeaturesSection() {
  return (
    <section id="features" className="vr-band vr-band--bottom">
      <div className="vr-wrap">
        <ScrollReveal
          containerClassName="vr-head"
          textClassName="vr-head__title"
          enableBlur
          baseOpacity={0.24}
          blurStrength={5}
          staggerDelay={0.028}
          size="lg"
          align="left"
          variant="default"
        >
          Built already, not on a roadmap.
        </ScrollReveal>

        <Reveal className="vr-head__meta" delay={0.05}>
          <span className="vr-mono vr-head__num">05</span>
          <span className="vr-head__rule" />
          <span className="vr-mono vr-head__tag">CAPABILITIES</span>
        </Reveal>

        <Reveal className="vr-head__note" delay={0.08}>
          Five things you can click today. Each panel links to the part of the features page that documents it — no
          roadmap items, no invented comparisons.
        </Reveal>

        <StaggerGroup as="div" className="vr-bento" stagger={0.06} delay={0.04} trigger="view" amount={0.12}>
          {featureCells.map(cell => (
            <TiltItem
              as="div"
              key={cell.id}
              className={`vr-cell vr-lift vr-cell--${cell.size === "hero" || cell.size === "tall" ? cell.size : cell.size === "sm" ? "sm" : "wide"}`}
            >
              <span className="vr-cell__icon">{cell.icon}</span>
              {cell.size === "hero" ? (
                <SplitText
                  tag="h3"
                  text={cell.title}
                  splitType="words"
                  delay={16}
                  duration={0.6}
                  textAlign="left"
                  color="#e9eef7"
                />
              ) : (
                <h3>{cell.title}</h3>
              )}
              <p>{cell.text}</p>
              {cell.list ? (
                <ul className="vr-cell__list">
                  {cell.list.map(line => (
                    <li key={line}><Check size={14} /> {line}</li>
                  ))}
                </ul>
              ) : null}
              <div className="vr-cell__foot">
                <Link className="vr-cell__link" to={cell.to}>
                  {cell.linkText || "Read the detail"} <ArrowRight size={14} />
                </Link>
              </div>
            </TiltItem>
          ))}

          <StaggerItem as="div" className="vr-cell vr-cell--wide">
            <SpotlightCard
              className="vr-spot"
              spotlightColor="rgba(108,155,255,.32)"
              intensity={0.2}
              spotlightSize={240}
              style={{ width: "100%", display: "block" }}
            >
              <div className="vr-cell" style={{ border: "none", background: "transparent", borderRadius: 0 }}>
                <span className="vr-cell__icon"><Download /></span>
                <h3>Answers you can take away</h3>
                <p>
                  When a reply names code files inside fenced blocks, VupsRouter packages them into a downloadable
                  project ZIP — so a generated page can be run locally instead of copied out of markdown.
                </p>
                <div className="vr-cell__foot">
                  <Link className="vr-cell__link" to="/features#workspace">
                    See the workspace <ArrowRight size={14} />
                  </Link>
                </div>
              </div>
            </SpotlightCard>
          </StaggerItem>
        </StaggerGroup>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* 06 — model choice                                                  */
/* ------------------------------------------------------------------ */

function ModelsSection() {
  return (
    <section id="models" className="vr-band vr-band--slab">
      <div className="vr-wrap">
        <SectionHead
          num="06"
          tag="MODEL CHOICE"
          title="Pick the route in the composer,"
          accent="not in a config file."
          split
          note={`The registry ships ${PROVIDER_COUNT} provider entries grouped into ${CATEGORY_COUNT} categories. A category describes where the models come from — it does not change how a key is stored or which key a request may use.`}
        />

        <div className="vr-models">
          <Reveal className="vr-cats">
            {providerCategories.map(cat => (
              <div className="vr-cat vr-lift" key={cat.id}>
                <span className="vr-cat__icon">
                  {cat.id === "local" ? <Terminal size={15} /> : cat.id === "custom" ? <Settings2 size={15} /> : cat.id === "aggregator" ? <Layers size={15} /> : <Boxes size={15} />}
                </span>
                <div>
                  <h3>{cat.label}</h3>
                  <p>{cat.hint || `Endpoints, keys and model lists stay together inside one saved configuration.`}</p>
                </div>
                <span className="vr-mono vr-cat__n">{cat.list.length}</span>
              </div>
            ))}

            <RollingTube3D text={`${PROTOCOL_FAMILIES} PROTOCOL FAMILIES`} fontSize="clamp(11px, 1.05vw, 13px)" marginTop="8px" />
          </Reveal>

          <div className="vr-models__panel">
            <AnimatedContent distance={24} duration={0.55} blur={2} className="vr-panel vr-lift">
              <h3>What the selector offers you</h3>
              <p>
                The built-in model first, then every configuration you have saved, each listed with its own models.
                Long model names are guarded so the row never breaks on a phone.
              </p>
              <div className="vr-providers">
                {ribbonNames.slice(0, 12).map(name => <Chip key={name}>{name}</Chip>)}
                <Chip tone="on">+{Math.max(0, PROVIDER_COUNT - 12)} more</Chip>
              </div>
            </AnimatedContent>

            <HoverSurface className="vr-panel vr-lift" lift={3} shine>
              <h3>Switching is not borrowing</h3>
              <p>
                Selecting a model from one provider never sends your request with another provider's key. If a model
                does not belong to the saved configuration the chat says so and shows the failure instead of
                re-routing quietly.
              </p>
              <div className="vr-cell__foot">
                <Link className="vr-cell__link" to="/settings">
                  Provider settings <ArrowRight size={14} />
                </Link>
              </div>
            </HoverSurface>

            <TiltCard className="vr-panel vr-lift" max={4}>
              <h3>What this page will not tell you</h3>
              <p>
                How a request is matched once it reaches the backend is proprietary implementation. The product's
                promise is the visible part: the route you chose is the route you see.
              </p>
            </TiltCard>
          </div>
        </div>
      </div>
      <span className="vr-band__edge" aria-hidden="true" />
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* 07 — use cases                                                     */
/* ------------------------------------------------------------------ */

const useCases = [
  {
    id: "code",
    icon: <Code2 size={15} />,
    title: "Coding and debugging",
    short: "Paste the trace, keep the fix",
    situation: "A stack trace, a file that behaves differently from the spec, a refactor you can describe but not start.",
    workflow: "Paste the error and the file. Ask for the smallest change that fixes it, at Precise.",
    payoff: "Named files come back as a project ZIP you can unzip and run."
  },
  {
    id: "research",
    icon: <BookOpen size={15} />,
    title: "Reading long material",
    short: "Pages in, decisions out",
    situation: "A 40-page PDF, a policy document, a thread you arrived at late.",
    workflow: "Attach the images of the pages when the selected model supports vision, then ask for the parts that change your decision.",
    payoff: "One thread keeps the questions and the answers together for the rest of the week."
  },
  {
    id: "writing",
    icon: <PenLine size={15} />,
    title: "Drafting and editing",
    short: "Shorten first, restyle second",
    situation: "A release note, an email that has to land, a spec that keeps growing.",
    workflow: "Ask for a shorter version with the same facts, then ask for the tone change separately.",
    payoff: "Replies stream, so you read along and stop the generation when it has said enough."
  },
  {
    id: "learning",
    icon: <Layers size={15} />,
    title: "Learning a new surface",
    short: "Questions that accumulate",
    situation: "An unfamiliar CLI, a protocol you have only read about, a library you keep misusing.",
    workflow: "Keep the thread, switch the composer to your own provider when you want a specific model.",
    payoff: "The same workspace carries the questions from beginner to working knowledge."
  }
];

function CaseRow({ item, open, onToggle }) {
  const reduce = useReducedMotion();

  return (
    <div className="vr-case">
      <button
        type="button"
        className="vr-case__btn"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className="vr-case__ico">{item.icon}</span>
        <span>
          <h3>{item.title}</h3>
          <small>{item.short}</small>
        </span>
        <span className="vr-case__mark">{open ? "CLOSE" : "OPEN"} <ChevronDown size={13} style={{ display: "inline", transform: open && !reduce ? "rotate(180deg)" : "none", transition: "transform .24s ease" }} /></span>
      </button>

      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            className="vr-case__body"
            initial={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
            animate={reduce ? { opacity: 1 } : { height: "auto", opacity: 1 }}
            exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ duration: reduce ? 0.14 : 0.32, ease: [0.22, 0.61, 0.36, 1] }}
          >
            <div className="vr-case__grid">
              <div><h4>The situation</h4><p>{item.situation}</p></div>
              <div><h4>How you use it</h4><p>{item.workflow}</p></div>
              <div><h4>What it changes</h4><p>{item.payoff}</p></div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function UseCasesSection() {
  const [open, setOpen] = useState(useCases[0].id);

  return (
    <section id="use-cases" className="vr-band vr-band--rule">
      <div className="vr-wrap">
        <SectionHead
          num="07"
          tag="USE CASES"
          title="Four workflows that fit inside"
          accent="one chat."
          split
          note="The product is one composer, two modes and your own routes. These are ordinary ways people use it — not separate features, and not claims about who else uses it."
        />

        <Reveal className="vr-cases__feature">
          <SpotlightCard
            className="vr-feature"
            spotlightColor="rgba(108,155,255,.3)"
            intensity={0.2}
            spotlightSize={280}
            style={{ display: "block" }}
          >
            <div className="vr-feature__in">
              <div>
                <Badge variant="unstyled" className="vr-chip vr-chip--on">
                  <Palette size={12} /> Motion Design mode
                </Badge>
                <h3>Frontend work has its own mode.</h3>
                <p>
                  The same first-party model, retuned for interface engineering: layout, CSS, GSAP, cleanup, and code
                  that honours <code>prefers-reduced-motion</code> instead of fighting it.
                </p>
              </div>
              <div>
                <ul className="vr-feature__list">
                  <li><span className="vr-tick" aria-hidden="true" /> Animation and transition implementation</li>
                  <li><span className="vr-tick" aria-hidden="true" /> Component and layout review</li>
                  <li><span className="vr-tick" aria-hidden="true" /> Accessible, reduced-motion-safe output</li>
                </ul>
                <div className="vr-cell__foot">
                  <Link className="vr-cell__link" to="/features#vups">
                    What the modes change <ArrowRight size={14} />
                  </Link>
                </div>
              </div>
            </div>
          </SpotlightCard>
        </Reveal>

        <StaggerGroup as="div" className="vr-cases" stagger={0.07} delay={0.04} trigger="view" amount={0.12}>
          {useCases.map(item => (
            <StaggerItem as="div" key={item.id}>
              <CaseRow
                item={item}
                open={open === item.id}
                onToggle={() => setOpen(current => (current === item.id ? "" : item.id))}
              />
            </StaggerItem>
          ))}
        </StaggerGroup>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* 08 — workflow                                                      */
/* ------------------------------------------------------------------ */

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

function FlowSection() {
  return (
    <section id="flow" className="vr-band vr-band--bottom">
      <div className="vr-wrap">
        <SectionHead
          num="08"
          tag="THE JOURNEY"
          title="Three moves, start to"
          accent="finished thread."
          split
          note="This is the user-visible path — what you click and what you see. What happens between the send button and the reply is the product's own implementation, and this page leaves it there."
        />

        <div className="vr-flow">
          <motion.span
            className="vr-flow__line"
            initial={{ scaleX: 0 }}
            whileInView={{ scaleX: 1 }}
            viewport={{ once: true, amount: 0.4 }}
            transition={{ duration: 0.9, ease: [0.22, 0.61, 0.36, 1] }}
            aria-hidden="true"
          />
          <StaggerGroup as="div" className="vr-flow__steps" stagger={0.12} trigger="view" amount={0.25}>
            {flowSteps.map(step => (
              <TiltItem as="div" key={step.no} max={4} className="vr-step vr-lift">
                <span className="vr-step__no vr-mono">{step.no}</span>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
                <div className="vr-step__tag">
                  {step.tags.map(tag => <Chip key={tag}>{tag}</Chip>)}
                </div>
              </TiltItem>
            ))}
          </StaggerGroup>
        </div>

        <Reveal as="p" delay={0.1} className="vr-flow__note">
          <strong>Nothing here is a scoring engine you have to trust.</strong> You choose the route in the composer;
          the app keeps that choice visible and refuses to spend a key you saved somewhere else.
        </Reveal>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* 09 — usability                                                     */
/* ------------------------------------------------------------------ */

const checks = [
  { icon: <Keyboard size={15} />, title: "Keyboard first", body: "Every control on this page and in the chat is reachable by keyboard, with a visible focus ring. Tabs follow the arrow-key pattern.", term: "tab" },
  { icon: <Smartphone size={15} />, title: "Checked from 320px up", body: "Layouts are measured at 320, 375, 390, 768, 1024 and 1440 — the composer, the long model names and this preview all have to fit.", term: "320px" },
  { icon: <TriangleAlert size={15} />, title: "Errors stay on screen", body: "A failed request keeps its message visible and names what failed. Duplicate alerts do not stack on top of a successful reply.", term: "named" },
  { icon: <Zap size={15} />, title: "Reduced motion is honoured", body: "With prefers-reduced-motion the sweep, the ribbon, the card tilt, the glare and the stage transitions stop. Nothing is delayed behind an animation.", term: "off" },
  { icon: <Eye size={15} />, title: "State is never colour alone", body: "The selected route shows its name, not a dot. Stopping a reply labels the partial output in words.", term: "labelled" },
  { icon: <Lock size={15} />, title: "No secrets in the bundle", body: "Provider keys are entered and stored server-side. This page ships no key, endpoint or internal diagnostic.", term: "server-side" }
];

function CraftSection() {
  return (
    <section id="craft" className="vr-band vr-band--slab">
      <div className="vr-wrap">
        <SectionHead
          num="09"
          tag="USABILITY"
          title="The details that decide"
          accent="whether you keep using it."
          split
          note="Usability is not a feature block — it is whether the interface tells you the truth fast enough. These are the checks the product is held to."
        />

        <div className="vr-craft">
          <Reveal className="vr-craft__side">
            <p>
              A model router earns trust by being legible while it works: the selected model visible during the stream,
              an interrupt that keeps its output, a failure that names itself, and a long thread that explains its own
              ceiling instead of truncating.
            </p>
            <RbShinyText
              text="NO INVENTED BENCHMARKS · NO FAKE LOGOS · NO COUNTED-US LINES"
              speed={2.6}
              baseColor="#5c6b82"
              shineColor="#8fb2ff"
              shineWidth={30}
              className="vr-mono"
            />
          </Reveal>

          <StaggerGroup as="div" className="vr-checks" stagger={0.05} delay={0.03} trigger="view" amount={0.12}>
            {checks.map(check => (
              <StaggerItem as="div" key={check.title} className="vr-check">
                <span className="vr-check__ico">{check.icon}</span>
                <div>
                  <h3>{check.title}</h3>
                  <p>{check.body}</p>
                </div>
              </StaggerItem>
            ))}
          </StaggerGroup>
        </div>
      </div>
      <span className="vr-band__edge" aria-hidden="true" />
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* 10 — privacy                                                       */
/* ------------------------------------------------------------------ */

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

function PrivacySection() {
  return (
    <section id="privacy" className="vr-band vr-band--rule">
      <div className="vr-wrap">
        <SectionHead
          num="10"
          tag="PRIVACY AND LIMITS"
          title="What can be promised honestly,"
          accent="and what will not be claimed."
          split
          note="Every line on the left is traceable to code that runs today. Nothing here promises zero retention, anonymity or compliance that the product does not implement."
        />

        <div className="vr-priv">
          <div className="vr-priv__col">
            <span className="vr-priv__kicker"><Check size={13} /> Verified in the product</span>
            <StaggerGroup as="ul" className="vr-priv__list" stagger={0.05} delay={0.02} trigger="view" amount={0.15}>
              {promises.map(item => (
                <StaggerItem as="li" key={item.title}>
                  <span className="vr-priv__ico">{item.icon}</span>
                  <div>
                    <h3>{item.title}</h3>
                    <p>{item.body}</p>
                  </div>
                </StaggerItem>
              ))}
            </StaggerGroup>
          </div>

          <Reveal className="vr-priv__col vr-priv__col--limits" delay={0.06}>
            <span className="vr-priv__kicker vr-priv__kicker--warn"><TriangleAlert size={13} /> What we do not promise</span>
            <ul className="vr-priv__list vr-priv__bare">
              {limits.map(line => (
                <li key={line.slice(0, 24)}><p>{line}</p></li>
              ))}
            </ul>
          </Reveal>
        </div>

        <Reveal delay={0.08} className="vr-docs">
          <span>Policy documents</span>
          <Button variant="outlined" component={Link} to="/privacy-policy">Privacy policy</Button>
          <Button variant="outlined" component={Link} to="/terms">Terms of service</Button>
          <Button variant="outlined" component={Link} to="/cookie-policy">Cookie policy</Button>
        </Reveal>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* 11 — getting started                                               */
/* ------------------------------------------------------------------ */

const needs = [
  { tag: "What you need", title: "An email, a name, a password", body: "The signup form asks for those three and nothing else. There is no waitlist, no invite code and no card.", ok: true },
  { tag: "What you do not need", title: "A provider key", body: "The built-in model works from the first message. Keys are only for the models you add yourself.", ok: false },
  { tag: "What happens immediately", title: "The chat opens", body: "The session is set by the signup response itself, so there is no verification email to wait for.", ok: true },
  { tag: "Where keys go later", title: "Settings → Provider settings", body: "Custom Models takes a base URL and a key, and offers a connection test and a model test before you rely on it.", ok: true }
];

function StartSection() {
  const navigate = useNavigate();
  const { status } = useAuth();
  const signedIn = status === "authenticated";

  return (
    <section id="get-started" className="vr-band vr-band--slab">
      <div className="vr-wrap">
        <SectionHead
          num="11"
          tag="GETTING IN"
          title="Two doors, and one of them"
          accent="needs no setup."
          split
          note="This is the real onboarding path in the running app: sign up, land in the chat, add a provider only if and when you want one."
        />

        <div className="vr-start">
          <div className="vr-start__copy">
            <Reveal className="vr-hero__actions" delay={0.02}>
              <Button
                variant="contained"
                endIcon={<ArrowRight size={17} />}
                onClick={() => navigate(signedIn ? "/chat" : "/signup", { state: signedIn ? undefined : { from: "/chat" } })}
              >
                {signedIn ? "Back to the chat" : "Create an account"}
              </Button>
              <Button variant="outlined" component={Link} to="/signin">
                I already have one
              </Button>
            </Reveal>

            <Reveal as="p" delay={0.08} className="vr-lead">
              <strong>First message worth sending:</strong> paste the thing you are actually stuck on — the trace, the
              paragraph, the spec — and ask for the smallest change that fixes it. Then stop the reply the moment it has
              said enough. That is the whole product in one turn.
            </Reveal>

            <Reveal delay={0.12} className="vr-docs">
              <span>Read first</span>
              <Button variant="text" component={Link} to="/features">Feature list</Button>
              <Button variant="text" component={Link} to="/about">Why VupsRouter exists</Button>
            </Reveal>
          </div>

          <StaggerGroup as="div" className="vr-needs" stagger={0.07} delay={0.04} trigger="view" amount={0.2}>
            {needs.map(item => (
              <StaggerItem as="div" key={item.title} className="vr-needs__cell">
                <span className={item.ok ? "vr-needs__tag" : "vr-needs__tag vr-needs__tag--no"}>{item.tag}</span>
                <h3>{item.title}</h3>
                <p>{item.body}</p>
              </StaggerItem>
            ))}
          </StaggerGroup>
        </div>
      </div>
      <span className="vr-band__edge" aria-hidden="true" />
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* 12 — FAQ                                                           */
/* ------------------------------------------------------------------ */

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
    a: `No. Vups v3 Galax runs on the VupsRouter backend and is available as soon as your account exists. Shared free models are rate-limited, so limits apply and availability can change.`
  },
  {
    q: "Which providers can I connect with my own key?",
    a: `The registry ships ${PROVIDER_COUNT} entries across ${CATEGORY_COUNT} categories — aggregators, direct model providers, local gateways such as Ollama, vLLM, LocalAI and LM Studio, and custom compatible endpoints. They speak ${PROTOCOL_FAMILIES} protocol families: OpenAI-compatible, Anthropic Messages, Azure OpenAI and IBM watsonx.`
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

function FaqSection() {
  return (
    <section id="faq" className="vr-band vr-band--bottom">
      <div className="vr-wrap">
        <SectionHead
          num="12"
          tag="QUESTIONS"
          title="Asked straight,"
          accent="answered straight."
          split
          note="Where the product has no answer, the answer says so. Nothing below invents pricing, retention periods, model availability or commitments that are not configured."
        />

        <Reveal className="vr-faq">
          <Accordion type="single" collapsible defaultValue="item-0">
            {faq.map((item, index) => (
              <AccordionItem key={item.q} value={`item-${index}`} className="vr-faq__sep">
                <AccordionTrigger className="vr-faq__trigger">
                  <span className="vr-mono vr-faq__num">{String(index + 1).padStart(2, "0")}</span>
                  <span>{item.q}</span>
                </AccordionTrigger>
                <AccordionContent className="vr-faq__content">{item.a}</AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </Reveal>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* 13 — closing CTA                                                   */
/* ------------------------------------------------------------------ */

function ClosingSection() {
  const navigate = useNavigate();
  const { status } = useAuth();
  const reduce = useReducedMotion();
  const signedIn = status === "authenticated";

  return (
    <section id="start" className="vr-band">
      <div className="vr-wrap">
        <Reveal className="vr-close">
          <div>
            <span className="vr-mono vr-close__kicker">READY WHEN YOU ARE</span>
            <ScrollFloat textClassName="vr-close__float" stagger={0.028} distance={44} stretch={1} animationDuration={0.6}>
              Stop explaining <em>your setup to yourself.</em>
            </ScrollFloat>
            <p>
              Vups v3 Galax is already in the composer. Connect your own provider later — the conversation, the files
              and the route you chose all stay where you left them.
            </p>
          </div>

          <div className="vr-close__actions">
            <div className="vr-close__row">
              <Magnet disabled={reduce} padding={60} magnetStrength={3}>
                <StarBorder
                  as="button"
                  type="button"
                  color="#bcd4ff"
                  trailColor="rgba(108,155,255,.2)"
                  backgroundColor="#13203a"
                  textColor="#eaf1ff"
                  borderColor="rgba(148,163,184,.26)"
                  duration={5}
                  thickness={1}
                  radius={999}
                  trailLength={0.34}
                  stars={2}
                  glow={0.8}
                  sparkle
                  hover="brighten"
                  className="vr-star-cta"
                  onClick={() => navigate(signedIn ? "/chat" : "/signup", { state: signedIn ? undefined : { from: "/chat" } })}
                >
                  {signedIn ? "Open the chat" : "Start free chat"} <ArrowRight size={17} />
                </StarBorder>
              </Magnet>
              <Button variant="outlined" component={Link} to="/features">
                <GradientText
                  colors={["#6c9bff", "#dbe6ff", "#6c9bff"]}
                  animationSpeed={7}
                  yoyo
                  className="vr-mono"
                >
                  Explore the build
                </GradientText>
              </Button>
            </div>

            <div className="vr-close__links">
              <Link to="/about">Why it exists</Link>
              <Link to="/settings">Provider settings</Link>
              <Link to="/privacy-policy">Privacy policy</Link>
              <Link to="/terms">Terms</Link>
            </div>

            <RollingTube3D text="VUPS V3 GALAX" fontSize="clamp(11px, 1.05vw, 13px)" marginTop="2px" />
          </div>
        </Reveal>

        <Separator className="vr-faq__sep" />
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */

export default function LandingPage() {
  const progress = useScrollProgress();
  const active = useActiveSection(useMemo(() => NAV_SECTIONS.map(s => s.id), []));

  return (
    <>
      <PageMeta
        title="VupsRouter — AI chat and model routing"
        description="Chat with Vups v3 Galax, keep your conversations, and route requests through your own AI provider keys."
      />
      <div className="landing vr">
        <SiteHeader />
        <Ruler value={progress} />
        <Rail active={active} />

        <main id="main-content" className="vr-main">
          <Hero />
          <Ribbon />
          <OverviewSection />
          <ProblemsSection />
          <ShowcaseSection />
          <FeaturesSection />
          <ModelsSection />
          <UseCasesSection />
          <FlowSection />
          <CraftSection />
          <PrivacySection />
          <StartSection />
          <FaqSection />
          <ClosingSection />
        </main>

        <LandingFooter />
      </div>
    </>
  );
}
