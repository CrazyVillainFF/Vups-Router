import React from "react";
import { LockKeyhole, Search, SendHorizontal, Sparkles } from "lucide-react";

function BrowserChrome({ label = "vupsrouter / home" }) {
  return (
    <div className="dl-shot__chrome" aria-hidden="true">
      <span className="dl-shot__dots"><i /><i /><i /></span>
      <span className="dl-shot__url">{label}</span>
      <span className="dl-shot__secure"><LockKeyhole size={10} /> https</span>
    </div>
  );
}

function HomeShot({ image, alt }) {
  return (
    <div className="dl-shot dl-shot--browser">
      <BrowserChrome />
      <img src={image} alt={alt} loading="lazy" />
    </div>
  );
}

function ChatMock() {
  return (
    <div className="dl-mock dl-mock--chat" role="img" aria-label="Conceptual preview of the VupsRouter chat workspace">
      <aside className="dl-mock__rail">
        <div className="dl-mock__brand"><span>v</span> vupsrouter</div>
        <div className="dl-mock__new">+ New chat</div>
        <span className="dl-mock__label">TODAY</span>
        {["Landing page polish", "Router diagnostics", "Project handoff"].map((thread, index) => (
          <div className={index === 0 ? "dl-mock__thread dl-mock__thread--on" : "dl-mock__thread"} key={thread}>
            {thread}
          </div>
        ))}
      </aside>
      <div className="dl-mock__workspace">
        <div className="dl-mock__head">
          <span>Landing page polish</span>
          <b><Sparkles size={10} /> Vups v3 Galax</b>
        </div>
        <div className="dl-mock__messages">
          <div className="dl-mock__msg dl-mock__msg--user">Make the hero feel more editorial, but keep the dark navy system.</div>
          <div className="dl-mock__msg dl-mock__msg--ai">
            <span className="dl-mock__avatar">V</span>
            <div>
              <p>I&apos;ll tighten the headline scale, add a ruled grid, and keep the blue accent to one focal word.</p>
              <div className="dl-mock__progress"><i /> Generating response <span>2.1s</span></div>
            </div>
          </div>
        </div>
        <div className="dl-mock__composer">
          <span>Ask VupsRouter anything...</span>
          <b><SendHorizontal size={13} /></b>
        </div>
      </div>
    </div>
  );
}

function RoutingMock() {
  return (
    <div className="dl-mock dl-mock--routing" role="img" aria-label="Conceptual preview of the VupsRouter model chooser">
      <div className="dl-mock__panel-head">
        <span>Choose a model</span>
        <span className="dl-mock__search"><Search size={11} /> Search</span>
      </div>
      <span className="dl-mock__label">YOUR KEYS</span>
      {[
        ["OpenRouter", "openai/gpt-5.2", "Saved model"],
        ["DeepSeek", "deepseek-chat", "Saved model"]
      ].map(([provider, model, badge]) => (
        <div className="dl-mock__model" key={model}>
          <span className="dl-mock__provider">{provider.slice(0, 2)}</span>
          <div><b>{model}</b><small>{provider}</small></div>
          <em>{badge}</em>
        </div>
      ))}
      <span className="dl-mock__label">FREE MODELS</span>
      {[
        ["Vups v3 Galax", "Built-in model"],
        ["gemini-3.8-flash", "Free · Google"],
        ["llama-4-maverick", "Free · OpenRouter"]
      ].map(([model, provider], index) => (
        <div className={index === 0 ? "dl-mock__model dl-mock__model--active" : "dl-mock__model"} key={model}>
          <span className="dl-mock__provider">{index === 0 ? "V" : model.slice(0, 2).toUpperCase()}</span>
          <div><b>{model}</b><small>{provider}</small></div>
          {index === 0 ? <em>Active</em> : <span className="dl-mock__check">✓</span>}
        </div>
      ))}
    </div>
  );
}

function ThreadsMock() {
  return (
    <div className="dl-mock dl-mock--threads" role="img" aria-label="Conceptual preview of saved VupsRouter conversations">
      <div className="dl-mock__panel-head">
        <span>Conversations</span>
        <span className="dl-mock__count">8 saved</span>
      </div>
      <div className="dl-mock__searchline"><Search size={11} /> Search saved threads</div>
      {[
        ["Landing page polish", "Today · 14 messages", true],
        ["Router diagnostics", "Yesterday · 9 messages", false],
        ["Artifact continuation", "Oct 24 · 22 messages", false],
        ["Android release notes", "Oct 21 · 6 messages", false]
      ].map(([title, meta, active]) => (
        <div className={active ? "dl-mock__saved dl-mock__saved--active" : "dl-mock__saved"} key={title}>
          <span className="dl-mock__saved-icon">#</span>
          <div><b>{title}</b><small>{meta}</small></div>
          <span className="dl-mock__more">···</span>
        </div>
      ))}
      <p className="dl-mock__footnote">Your previous conversations stay accessible when you start a new chat.</p>
    </div>
  );
}

export default function PreviewVisual({ id, image, alt, enlarged = false }) {
  if (id === "home") return <HomeShot image={image} alt={alt} />;
  if (id === "desktop") {
    return (
      <div className="dl-device dl-device--desktop">
        <div className="dl-device__bar">
          <span className="dl-shot__dots"><i /><i /><i /></span>
          <b>VupsRouter</b>
          <span className="dl-device__window-actions">— □ ×</span>
        </div>
        <div className="dl-device__screen">
          <HomeShot image={image} alt={alt} />
        </div>
        <span className="dl-device__truth">Mockup · packaged build not published</span>
      </div>
    );
  }
  if (id === "android") {
    return (
      <div className="dl-device dl-device--phone">
        <div className="dl-device__phone-screen">
          <span className="dl-device__notch" aria-hidden="true" />
          <img src={image} alt={alt} loading="lazy" />
        </div>
        <span className="dl-device__truth">Mockup · responsive web UI</span>
      </div>
    );
  }
  if (id === "routing") return <RoutingMock />;
  if (id === "threads") return <ThreadsMock />;
  if (enlarged) return <ChatMock />;
  return <ChatMock />;
}
