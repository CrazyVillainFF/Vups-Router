import React from "react";
import { Link } from "react-router-dom";
import { Button } from "@mui/material";
import ArrowOutwardRoundedIcon from "@mui/icons-material/ArrowOutwardRounded";
import AutoAwesomeRoundedIcon from "@mui/icons-material/AutoAwesomeRounded";
import ChatBubbleOutlineRoundedIcon from "@mui/icons-material/ChatBubbleOutlineRounded";
import CodeRoundedIcon from "@mui/icons-material/CodeRounded";
import DownloadRoundedIcon from "@mui/icons-material/DownloadRounded";
import LockRoundedIcon from "@mui/icons-material/LockRounded";
import RouteRoundedIcon from "@mui/icons-material/RouteRounded";
import TuneRoundedIcon from "@mui/icons-material/TuneRounded";
import SiteHeader from "../components/SiteHeader.jsx";
import SiteFooter from "../components/SiteFooter.jsx";
import PageMeta from "../components/PageMeta.jsx";

const featureGroups = [
  {
    id: "vups",
    icon: <AutoAwesomeRoundedIcon />,
    number: "01",
    title: "Vups v3 Galax",
    summary: "A first-party model built for code, design, and difficult problems.",
    points: [
      "Start chatting without adding an API key.",
      "Use General for everyday work or Motion Design for frontend, CSS, GSAP, and animation engineering.",
      "Vups v3 Galax receives a server-controlled system prompt; the browser cannot replace it.",
      "Image input depends on the underlying model configured by the operator. Unsupported images return a clear error."
    ]
  },
  {
    id: "models",
    icon: <TuneRoundedIcon />,
    number: "02",
    title: "Model routing without key mixing",
    summary: "Add one provider or several, then choose the exact route in the composer.",
    points: [
      "Connect OpenAI-compatible, Anthropic Messages, Azure OpenAI, Google Gemini, IBM watsonx, and other supported protocols.",
      "Keys are encrypted server-side with AES-256-GCM and shown only in masked form.",
      "Every saved configuration keeps its own ID, endpoint, key, and model list.",
      "A request is tied to the selected configuration. The backend rejects a model or provider that belongs to a different saved key."
    ]
  },
  {
    id: "workspace",
    icon: <CodeRoundedIcon />,
    number: "03",
    title: "A chat workspace that keeps the work",
    summary: "Streaming replies, saved conversations, image attachments, and project downloads.",
    points: [
      "Replies stream into the conversation and can be stopped while they are generating.",
      "Conversations are saved per account and can be reopened or deleted from the sidebar.",
      "Attach PNG, JPEG, WebP, or GIF images when the selected model supports vision.",
      "If a reply names code files inside fenced blocks, VupsRouter can build a downloadable ZIP of the project."
    ]
  },
  {
    id: "controls",
    icon: <LockRoundedIcon />,
    number: "04",
    title: "Limits are visible",
    summary: "The interface shows unavailable models instead of pretending every route works.",
    points: [
      "Shared free models are checked against server status and can disappear or become rate-limited.",
      "Authentication uses an HTTP-only session cookie; provider keys never enter the browser bundle.",
      "Requests pass through per-user quotas and rate limits before reaching an upstream provider.",
      "Errors distinguish a missing key, an unavailable model, a provider outage, and a quota limit."
    ]
  }
];

const workflow = [
  { number: "01", title: "Create an account", text: "Sign up with your email. A session cookie keeps you signed in; no access token is stored in the browser." },
  { number: "02", title: "Open the chat", text: "Vups v3 Galax is available immediately. Choose General or Motion Design and send your first prompt." },
  { number: "03", title: "Add a route when needed", text: "Save a provider key in API settings, test the connection, then pick one of its models in the composer." }
];

export function FeaturesPage() {
  return <>
    <PageMeta title="Features — VupsRouter AI" description="Explore VupsRout AI: Vups v3 Galax, encrypted provider routing, saved conversations, image input, and project downloads." />
    <SiteHeader />
    <main id="main-content" className="info-page">
      <section className="info-hero section-pad">
        <span className="info-kicker">VUPSROUT AI / FEATURES</span>
        <h1>One chat interface.<br/><span>Real routes underneath.</span></h1>
        <p>VupsRouter is a working AI chat, not a directory of links. Here is what is built, how model selection behaves, and where the limits are.</p>
        <div className="info-actions">
          <Button component={Link} to="/chat" variant="contained" endIcon={<ArrowOutwardRoundedIcon />}>Open AI Chat</Button>
          <Button component={Link} to="/about" variant="outlined">Why VupsRouter</Button>
        </div>
      </section>

      <section className="info-section section-pad" aria-labelledby="feature-list-title">
        <div className="info-section-head">
          <span className="info-kicker">THE PRODUCT</span>
          <h2 id="feature-list-title">What you can use today.</h2>
        </div>
        <div className="info-card-grid">
          {featureGroups.map(group => (
            <article className="info-card" id={group.id} key={group.id}>
              <div className="info-card-top">
                <span className="info-card-icon">{group.icon}</span>
                <span className="info-card-number">{group.number}</span>
              </div>
              <h3>{group.title}</h3>
              <p>{group.summary}</p>
              <ul>
                {group.points.map(point => <li key={point}>{point}</li>)}
              </ul>
            </article>
          ))}
        </div>
      </section>

      <section className="info-section info-section--band section-pad" aria-labelledby="workflow-title">
        <div className="info-section-head">
          <span className="info-kicker">START HERE</span>
          <h2 id="workflow-title">Three steps to your first answer.</h2>
        </div>
        <ol className="workflow-grid">
          {workflow.map(step => (
            <li key={step.number}>
              <span className="workflow-number">{step.number}</span>
              <h3>{step.title}</h3>
              <p>{step.text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="info-cta section-pad">
        <div>
          <span className="info-kicker">READY TO TRY IT</span>
          <h2>Vups v3 Galax is already in the chat.</h2>
          <p>Create an account and start with the built-in model. Connect your own provider later.</p>
        </div>
        <Button component={Link} to="/signup" state={{ from: "/chat" }} variant="contained" endIcon={<ArrowOutwardRoundedIcon />}>Create an account</Button>
      </section>
    </main>
    <SiteFooter />
  </>;
}

export function AboutPage() {
  return <>
    <PageMeta title="About — VupsRouter" description="VupsRouter is the home of VupsRout AI and Vups v3 Galax, built to make AI model routing explicit and honest." />
    <SiteHeader />
    <main id="main-content" className="info-page">
      <section className="info-hero info-hero--about section-pad">
        <span className="info-kicker">ABOUT VUPSROUTER</span>
        <h1>A smaller, clearer<br/><span>route to AI.</span></h1>
        <p>VupsRouter is the home of VupsRout AI and its first-party model, Vups v3 Galax. It gives you one place to chat, keep your work, and choose which model handles a request.</p>
      </section>

      <section className="about-layout section-pad">
        <div className="about-lead">
          <span className="info-kicker">WHY IT EXISTS</span>
          <h2>Choosing a model should not require guessing.</h2>
        </div>
        <div className="about-copy">
          <p>AI access is fragmented across dashboards, keys, endpoints, quotas, and changing free tiers. A chat can look simple while the routing underneath is opaque. VupsRouter makes that route explicit: you can see the active model, choose a saved provider, and get an error that explains what failed.</p>
          <p>Vups v3 Galax is the default because it is ours. It is tuned for building: full-stack code, responsive interfaces, CSS, motion design, and step-by-step debugging. If another model fits your task better, connect it with your own key instead of being locked to one provider.</p>
        </div>
      </section>

      <section className="about-principles section-pad">
        <div className="about-principles-head">
          <span className="info-kicker">WHAT WE OPTIMIZE FOR</span>
          <h2>Useful over impressive.</h2>
        </div>
        <div className="principle-grid">
          <article>
            <ChatBubbleOutlineRoundedIcon />
            <h3>One continuous workspace</h3>
            <p>Chat, model choice, history, images, and generated files belong together. The conversation is the workspace, not a disposable demo.</p>
          </article>
          <article>
            <RouteRoundedIcon />
            <h3>Explicit routing</h3>
            <p>The selected model is visible. Saved configurations stay separate. The server refuses to silently borrow a key from another provider.</p>
          </article>
          <article>
            <DownloadRoundedIcon />
            <h3>Output you can take with you</h3>
            <p>Code should leave the chat in a usable form. Named files can be packaged as a ZIP instead of being trapped in a markdown reply.</p>
          </article>
          <article>
            <LockRoundedIcon />
            <h3>Secrets stay server-side</h3>
            <p>Provider keys are encrypted before storage and masked in the interface. The browser uses the VupsRouter API, never an upstream key.</p>
          </article>
        </div>
      </section>

      <section className="about-honesty section-pad">
        <div>
          <span className="info-kicker">WHAT WE DO NOT CLAIM</span>
          <h2>Honest limits.</h2>
        </div>
        <ul>
          <li>No model is guaranteed to be available forever. Free tiers, upstream endpoints, and rate limits change.</li>
          <li>AI output can be wrong. Review generated code and factual claims before relying on them.</li>
          <li>VupsRouter is not a proxy for unlimited free access. Quotas and per-user limits still apply.</li>
          <li>Image input only works when the selected model and server configuration support vision.</li>
        </ul>
      </section>

      <section className="info-cta section-pad">
        <div>
          <span className="info-kicker">BUILT BY VUPS</span>
          <h2>See the product for yourself.</h2>
          <p>Start with Vups v3 Galax, or inspect the routes and controls first.</p>
        </div>
        <div className="info-actions">
          <Button component={Link} to="/chat" variant="contained" endIcon={<ArrowOutwardRoundedIcon />}>Open AI Chat</Button>
          <Button component={Link} to="/features" variant="outlined">View features</Button>
        </div>
      </section>
    </main>
    <SiteFooter />
  </>;
}

export function NotFoundPage() {
  return <>
    <PageMeta title="Page not found — VupsRouter" noIndex />
    <SiteHeader />
    <main id="main-content" className="not-found-page section-pad">
      <span className="not-found-code">404</span>
      <span className="info-kicker">NO ROUTE AT THIS ADDRESS</span>
      <h1>That page is not part of the route map.</h1>
      <p>The address may have changed, or the link may be incomplete. Your conversations and saved settings are unaffected.</p>
      <div className="not-found-actions">
        <Button component={Link} to="/" variant="contained" endIcon={<ArrowOutwardRoundedIcon />}>Return home</Button>
        <Button component={Link} to="/chat" variant="outlined">Open AI Chat</Button>
        <Link className="text-link" to="/features">Browse features <ArrowOutwardRoundedIcon fontSize="small" /></Link>
      </div>
    </main>
    <SiteFooter />
  </>;
}
