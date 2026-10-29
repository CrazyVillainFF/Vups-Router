import React from "react";
import { Link } from "react-router-dom";
import SiteHeader from "../components/SiteHeader.jsx";
import ExternalAnchor from "../components/ExternalLink.jsx";
import SiteFooter from "../components/SiteFooter.jsx";
import PageMeta from "../components/PageMeta.jsx";
import { LEGAL, LEGAL_PLACEHOLDER_MARKER } from "./config.js";
import "./legal.css";

const contactLink = <ExternalAnchor href={`mailto:${LEGAL.contactEmail}`}>{LEGAL.contactEmail}</ExternalAnchor>;

function isUnconfigured() {
  return (
    LEGAL.legalEntity.includes(LEGAL_PLACEHOLDER_MARKER) ||
    LEGAL.jurisdiction.includes(LEGAL_PLACEHOLDER_MARKER) ||
    LEGAL.retention.includes(LEGAL_PLACEHOLDER_MARKER) ||
    LEGAL.contactEmail.endsWith(".example")
  );
}

function OperatorNotice() {
  if (!isUnconfigured()) return null;
  return <p className="legal-placeholder-note">
    <strong>Operator configuration notice.</strong> Some operator details on this page are placeholders
    because they have not been configured yet (look for “{LEGAL_PLACEHOLDER_MARKER}”). The site operator can
    set them with the <code>VITE_LEGAL_ENTITY</code>, <code>VITE_LEGAL_JURISDICTION</code>,{" "}
    <code>VITE_LEGAL_CONTACT_EMAIL</code>, and <code>VITE_LEGAL_RETENTION_DESCRIPTION</code> environment
    variables and redeploying. Nothing here should be relied on as the final legal text until then.
  </p>;
}

function LegalShell({ title, highlight, eyebrow, description, toc, children }) {
  return <>
    <PageMeta title={`${title} — ${LEGAL.operatorName}`} description={description} />
    <SiteHeader />
    <main className="legal-page">
      <header className="legal-head section-pad">
        <span className="legal-kicker"><span className="eyebrow-line" /> {eyebrow}</span>
        <h1 className="legal-title">{title} <span>{highlight}</span></h1>
        <p className="legal-updated">Effective {LEGAL.effectiveDate} · Applies to {LEGAL.siteUrl}</p>
        <OperatorNotice />
        <nav className="legal-toc" aria-label="On this page">
          {toc.map(([href, label]) => <a key={href} href={href}>{label}</a>)}
        </nav>
      </header>
      <div className="legal-body section-pad">{children}</div>
    </main>
    <SiteFooter />
  </>;
}

export function PrivacyPolicy() {
  return <LegalShell
    title="Privacy Policy"
    highlight="for free AI access."
    eyebrow="PRIVACY / YOUR DATA"
    question="Privacy Policy"
    description={`How ${LEGAL.operatorName} handles personal data: accounts, chat content, encrypted API keys, hosting logs, and your privacy rights.`}
    toc={[
      ["#who-we-are", "Who we are"],
      ["#what-we-collect", "What we collect"],
      ["#how-we-use", "How we use it"],
      ["#sharing", "Sharing"],
      ["#retention", "Retention"],
      ["#your-rights", "Your rights"],
      ["#security", "Security"],
      ["#children", "Children"],
      ["#changes", "Changes"],
      ["#contact", "Contact"]
    ]}
  >
    <section id="who-we-are">
      <h2>1. Who we are</h2>
      <p>
        {LEGAL.operatorName} is a web application that helps you explore and use free AI models. The service is
        operated by {LEGAL.legalEntity}, established in {LEGAL.jurisdiction}. This policy explains what personal
        data is processed when you visit or use the site, why it is processed, and the choices you have.
      </p>
    </section>

    <section id="what-we-collect">
      <h2>2. What we collect</h2>
      <h3>Information you provide directly</h3>
      <ul>
        <li><strong>Account details.</strong> When you create an account we store your name and email address. Passwords are stored only as a salted bcrypt hash — we never store or can read your plain password.</li>
        <li><strong>AI provider credentials (optional).</strong> If you add your own AI provider API key in API Settings, it is encrypted at rest with AES-256-GCM before being stored, is never returned to your browser in full, and is used only to send AI requests that you initiate. You can delete it at any time from API Settings.</li>
        <li><strong>Content you submit.</strong> Prompts, conversations, and generated replies are stored in your account so you can revisit them. You can delete conversations from the app.</li>
        <li><strong>Communications.</strong> If you email us, we process your message and contact details to respond.</li>
      </ul>
      <h3>Information collected automatically</h3>
      <ul>
        <li><strong>Hosting and security logs.</strong> Our hosting providers (Vercel for the frontend and Render for the backend) record standard technical data such as IP address, browser user-agent, request paths, and timestamps when your browser communicates with the service. This is used for delivering the site, security, abuse prevention, and diagnosing failures.</li>
        <li><strong>Rate-limit counters.</strong> Authentication and chat endpoints count requests per IP address and per account in short time windows to prevent abuse and keep the service available.</li>
        <li><strong>Local storage.</strong> The shipped client does not store session tokens or personal data in <code>localStorage</code> or <code>sessionStorage</code>; sessions use an HTTP-only cookie instead (see the <Link to="/cookie-policy">Cookie Policy</Link>).</li>
      </ul>
      <p>
        We do <strong>not</strong> run advertising networks, analytics or tracking scripts, social media pixels,
        or cross-site trackers, and we do not build advertising profiles.
      </p>
    </section>

    <section id="how-we-use">
      <h2>3. How we use information and on what basis</h2>
      <p>We process personal data only to operate the service:</p>
      <ul>
        <li><strong>Provide the service (contract).</strong> Creating and securing accounts, storing conversations, proxying the AI requests you initiate, and enforcing quotas and rate limits.</li>
        <li><strong>Security and operations (legitimate interests).</strong> Detecting abuse, preventing fraud, keeping the service reliable, debugging errors, and protecting the service and its users.</li>
        <li><strong>Legal compliance.</strong> Responding to valid legal requests and meeting record-keeping obligations where they apply.</li>
        <li><strong>Consent, where required.</strong> If a jurisdiction requires consent for a specific processing activity, we will ask for it before that activity starts.</li>
      </ul>
      <p>
        Where the GDPR or similar laws use the terms “controller” and “processor”, the operator described in
        section 1 is the controller for account data, and AI providers act as independent controllers or
        processors of requests actually sent to them under their own terms.
      </p>
    </section>

    <section id="sharing">
      <h2>4. Sharing and service providers</h2>
      <p>We do not sell personal data. Data is shared only with the providers that make the service work:</p>
      <table className="legal-meta-table">
        <thead><tr><th>Provider</th><th>Role</th><th>Data involved</th></tr></thead>
        <tbody>
          <tr><td>Vercel</td><td>Frontend hosting &amp; content delivery</td><td>IP address, request metadata in access logs</td></tr>
          <tr><td>Render</td><td>Backend hosting</td><td>IP address, request metadata in access logs</td></tr>
          <tr><td>MongoDB Atlas</td><td>Database hosting</td><td>Account records, encrypted provider keys, conversations</td></tr>
          <tr><td>OpenRouter and the underlying model providers</td><td>AI inference</td><td>Prompts and replies sent through the shared models or your own connected key</td></tr>
          <tr><td>Google Fonts</td><td>Font delivery</td><td>IP address and browser headers when fonts are fetched</td></tr>
        </tbody>
      </table>
      <p>
        Each provider processes data under its own terms and privacy documentation. When you connect your own AI
        provider key, your prompts are sent to that provider (and the model provider it routes to) under your
        agreement with them. We may also disclose data when legally required or to protect the rights and safety
        of the service, our users, or the public.
      </p>
      <p>
        <strong>Google Gemini free-tier notice.</strong> If you connect a Google AI Studio key and use a model
        covered by Google&apos;s unpaid quota, Google may use your prompts and responses to improve its products,
        and human reviewers may access that content. Do not submit sensitive or confidential data on the free
        tier. Google intends the free tier for professional or business use by users aged 18 or older; it is not
        available in the EEA, Switzerland, or the UK, where a paid Google Cloud project is required. Paid-tier
        data handling is governed by Google&apos;s own terms.
      </p>
    </section>

    <section id="retention">
      <h2>5. Retention and deletion</h2>
      <p>{LEGAL.retention}</p>
      <p>
        You can delete individual conversations in the app and remove stored provider keys from API Settings at
        any time. To delete your whole account, contact {contactLink}. Deletion requests may require us to
        verify that you control the account.
      </p>
    </section>

    <section id="your-rights">
      <h2>6. Your rights</h2>
      <p>
        Depending on where you live, you may have some or all of the following rights: access to your personal
        data; correction of inaccurate data; deletion; restriction of or objection to processing; data
        portability; and withdrawal of consent where processing is based on consent. You also have the right to
        lodge a complaint with your local data-protection authority.
      </p>
      <p>
        To exercise any right, email {contactLink}. We will respond within the time required by applicable law.
        If you are in a region whose law is not reflected above, we will still handle reasonable requests in
        good faith. We do not discriminate against users who exercise privacy rights.
      </p>
    </section>

    <section id="security">
      <h2>7. Security</h2>
      <p>
        Passwords are hashed with bcrypt; provider API keys are encrypted at rest with AES-256-GCM; sessions use
        HTTP-only cookies over HTTPS; access to production systems is limited to the operator. No method of
        transmission or storage is perfectly secure, and we cannot promise absolute security — if you believe
        you have found a vulnerability, please contact {contactLink}.
      </p>
    </section>

    <section id="children">
      <h2>8. Children</h2>
      <p>
        The service is not directed to children under {LEGAL.minimumAge}, and we do not knowingly collect their
        personal data. If you believe a child has created an account, contact {contactLink} and we will delete
        it.
      </p>
    </section>

    <section id="changes">
      <h2>9. Changes to this policy</h2>
      <p>
        We may update this policy as the service evolves. Material changes will be reflected by a new effective
        date at the top of this page, and where required we will notify account holders by email. Continued use
        after an update means you accept the revised policy.
      </p>
    </section>

    <section id="contact">
      <h2>10. Contact</h2>
      <p>
        Privacy questions and requests: {contactLink}. Operator: {LEGAL.legalEntity} · {LEGAL.jurisdiction}.
      </p>
    </section>
  </LegalShell>;
}

export function TermsOfService() {
  return <LegalShell
    title="Terms of Service"
    highlight="fair and clear."
    eyebrow="TERMS / GROUND RULES"
    description={`The terms that govern your use of ${LEGAL.operatorName}: acceptable use, accounts, AI output, liability, and governing law.`}
    toc={[
      ["#acceptance", "Acceptance"],
      ["#service", "The service"],
      ["#accounts", "Accounts"],
      ["#acceptable-use", "Acceptable use"],
      ["#content", "Content & output"],
      ["#third-parties", "Third parties"],
      ["#availability", "Availability"],
      ["#liability", "Liability"],
      ["#termination", "Termination"],
      ["#law", "Governing law"],
      ["#changes", "Changes"],
      ["#contact", "Contact"]
    ]}
  >
    <section id="acceptance">
      <h2>1. Acceptance and eligibility</h2>
      <p>
        By accessing {LEGAL.operatorName} or creating an account, you agree to these terms. If you do not agree,
        do not use the service. You must be at least {LEGAL.minimumAge} years old and legally able to enter into
        this agreement. If you use the service for an organization, you confirm you may bind that organization.
      </p>
    </section>

    <section id="service">
      <h2>2. The service</h2>
      <p>
        {LEGAL.operatorName} helps you explore free AI model access options and chat with AI models, including
        shared free models and models connected through your own AI provider key. Model catalogs, free tiers,
        quotas, and rate limits are set by third parties and can change or end at any time. The service is
        provided by {LEGAL.legalEntity}, {LEGAL.jurisdiction}.
      </p>
    </section>

    <section id="accounts">
      <h2>3. Accounts</h2>
      <ul>
        <li>Provide accurate account information and keep your password confidential.</li>
        <li>You are responsible for activity under your account, including prompts sent with your stored provider key.</li>
        <li>One person, one account; do not share accounts or pool credentials to bypass limits.</li>
        <li>Notify us at {contactLink} if you believe your account has been compromised.</li>
      </ul>
    </section>

    <section id="acceptable-use">
      <h2>4. Acceptable use</h2>
      <p>You agree not to:</p>
      <ul>
        <li>use the service for anything illegal, infringing, or harmful, or to generate content that violates the terms of the underlying AI providers;</li>
        <li>attempt to bypass rate limits, quotas, authentication, or other technical protections;</li>
        <li>resell or redistribute shared-model access, or automate the shared models beyond incidental personal use;</li>
        <li>interfere with, overload, probe, or disrupt the service or other users’ use of it;</li>
        <li>upload malware or attempt to gain unauthorized access to the service, its infrastructure, or data belonging to others;</li>
        <li>scrape or harvest data from the service in bulk, or use it to build a competing dataset without permission.</li>
      </ul>
      <p>We may remove content and suspend or terminate access that violates these rules.</p>
    </section>

    <section id="content">
      <h2>5. Your content, AI output, and responsibility</h2>
      <ul>
        <li>You keep your rights to the prompts and content you submit. You grant the operator a limited license to store, transmit, and process that content solely to operate the service.</li>
        <li>You are responsible for having the necessary rights to the content you submit and for the provider keys you choose to store.</li>
        <li>AI output can be inaccurate, incomplete, or biased and is not professional advice. Verify anything important before relying on it, especially for legal, medical, financial, or security decisions.</li>
        <li>Do not submit highly sensitive personal data about yourself or others (for example health or financial records) unless you accept the risks of third-party processing described in the <Link to="/privacy-policy">Privacy Policy</Link>.</li>
      </ul>
    </section>

    <section id="third-parties">
      <h2>6. Third-party links and services</h2>
      <p>
        The service links to third-party sites and routes requests to third-party AI providers such as
        OpenRouter and the model providers behind shared or connected models. Their terms, privacy policies,
        availability, and output policies apply to those services. We are not responsible for third-party
        services, external links, or content shown from them.
      </p>
    </section>

    <section id="availability">
      <h2>7. Availability and changes</h2>
      <p>
        We may change, suspend, or discontinue features at any time, and the service is provided “as is” and
        “as available”. Free models and third-party APIs may be unavailable, throttled, or removed without
        notice, and we do not guarantee uptime, response quality, or that any specific model will remain
        available.
      </p>
    </section>

    <section id="liability">
      <h2>8. Warranties and liability</h2>
      <p>
        To the maximum extent permitted by applicable law, the service is provided without warranties of any
        kind, express or implied, including merchantability, fitness for a particular purpose, and
        non-infringement. To the same extent, the operator is not liable for indirect, incidental, special,
        consequential, or punitive damages, or for lost data, profits, or goodwill arising from your use of the
        service.
      </p>
      <p>
        Where liability cannot be excluded, the operator’s total liability is limited to the greater of (a) the
        amounts you paid for the service in the 12 months before the claim (currently the service is free, so
        this amount is zero) and (b) the minimum required by law. Nothing in these terms limits rights you have
        under mandatory consumer law in your country of residence.
      </p>
    </section>

    <section id="termination">
      <h2>9. Suspension and termination</h2>
      <p>
        You may stop using the service at any time and request account deletion via {contactLink}. We may
        suspend or terminate access if these terms are violated, if required by law, or if continuing to
        provide the service becomes impractical; where reasonable we will tell you why.
      </p>
    </section>

    <section id="law">
      <h2>10. Governing law and disputes</h2>
      <p>
        These terms are governed by the laws of {LEGAL.jurisdiction}, without regard to conflict-of-law rules.
        Courts located there have jurisdiction over disputes, without limiting any mandatory rights you have
        where you live. Before starting formal proceedings, please contact {contactLink} so we can try to
        resolve the issue informally.
      </p>
    </section>

    <section id="changes">
      <h2>11. Changes to these terms</h2>
      <p>
        We may update these terms; the effective date above will change when we do. Material changes will be
        communicated to account holders where required. Continued use after changes take effect constitutes
        acceptance.
      </p>
    </section>

    <section id="contact">
      <h2>12. Contact and effective date</h2>
      <p>Questions about these terms: {contactLink}. Effective date: {LEGAL.effectiveDate}.</p>
    </section>
  </LegalShell>;
}

export function CookiePolicy() {
  return <LegalShell
    title="Cookie Policy"
    highlight="no tracking, one session cookie."
    eyebrow="COOKIES / LOCAL STORAGE"
    description={`What cookies and similar technologies ${LEGAL.operatorName} uses, and what it does not use.`}
    toc={[
      ["#what-are-cookies", "What cookies are"],
      ["#cookies-we-use", "Cookies we use"],
      ["#local-storage", "Local storage"],
      ["#third-parties", "Third-party requests"],
      ["#managing", "Managing cookies"],
      ["#changes", "Changes"],
      ["#contact", "Contact"]
    ]}
  >
    <section id="what-are-cookies">
      <h2>1. What cookies are</h2>
      <p>
        Cookies are small text files a website asks your browser to store. They let a site remember state
        between requests — for example, that you are signed in. Similar technologies include local storage and
        session storage, which keep data in your browser.
      </p>
    </section>

    <section id="cookies-we-use">
      <h2>2. Cookies we use</h2>
      <p>We set exactly one cookie:</p>
      <table className="legal-meta-table">
        <thead><tr><th>Name</th><th>Purpose</th><th>Type / attributes</th></tr></thead>
        <tbody>
          <tr>
            <td><code>vr_session</code></td>
            <td>Keeps you signed in by carrying your session token to the backend after you sign in. It is created when you sign in and cleared when you sign out.</td>
            <td>Essential, first-party, HTTP-only, Secure, SameSite=Lax, with a seven-day expiry. It is not readable by client-side scripts and is sent only over HTTPS.</td>
          </tr>
        </tbody>
      </table>
      <p>
        We do <strong>not</strong> use analytics cookies, advertising cookies, cross-site trackers, heat-mapping
        or A/B-testing cookies, or any third-party marketing technologies. Because the site sets no non-essential
        cookies, you will not see a cookie consent banner.
      </p>
    </section>

    <section id="local-storage">
      <h2>3. Local storage and session storage</h2>
      <p>
        The shipped client does not persist your session token or personal data in <code>localStorage</code> or{" "}
        <code>sessionStorage</code>. Sessions are carried by the HTTP-only cookie described above, which means
        scripts running in the page (including any injected by a third party) cannot read it.
      </p>
    </section>

    <section id="third-parties">
      <h2>4. Third-party requests</h2>
      <p>
        When you load the site, your browser fetches fonts from Google Fonts. That request transmits your IP
        address and browser headers to Google’s font service, which is described in Google’s own privacy
        documentation; the service is designed to serve fonts without cookies. No other third-party scripts,
        embeds, or pixels are loaded by the site. Prompts you send are transmitted to AI providers only as
        described in the <Link to="/privacy-policy">Privacy Policy</Link>.
      </p>
    </section>

    <section id="managing">
      <h2>5. Managing cookies</h2>
      <p>
        You can block or delete cookies in your browser settings. Blocking <code>vr_session</code> means you
        cannot sign in or use account features, including chat and API Settings, because the backend cannot
        recognize your session. “Do Not Track” signals have no effect here because the site does not track you
        across sites.
      </p>
    </section>

    <section id="changes">
      <h2>6. Changes</h2>
      <p>
        If our cookie usage changes — for example if an analytics provider is ever added — this page and, where
        required, a consent mechanism will be updated first, with a new effective date.
      </p>
    </section>

    <section id="contact">
      <h2>7. Contact</h2>
      <p>Cookie questions: {contactLink}. Effective date: {LEGAL.effectiveDate}.</p>
    </section>
  </LegalShell>;
}
