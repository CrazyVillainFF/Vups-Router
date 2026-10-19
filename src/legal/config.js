// Configurable legal/operator details for the legal pages.
//
// These values describe the operator behind VupsRouter and are intentionally
// configurable so the policies stay accurate for whichever jurisdiction and
// entity the site is run from. Override them with Vite environment variables
// in Vercel -> Project -> Settings -> Environment Variables (they are baked
// into the bundle at build time), then redeploy.
//
// IMPORTANT: the defaults below are clearly marked placeholders. Replace them
// with the real details before relying on these pages publicly. Never invent
// an address, entity, or contact email in this file.

const env = import.meta.env || {};

function value(envValue, placeholder) {
  const trimmed = typeof envValue === "string" ? envValue.trim() : "";
  return trimmed || placeholder;
}

export const LEGAL_PLACEHOLDER_MARKER = "not yet configured";

export const LEGAL = {
  // Product name shown throughout the policies.
  operatorName: value(env.VITE_LEGAL_OPERATOR_NAME, "VupsRouter"),

  // Registered company / sole trader / other legal entity operating the site.
  // Set VITE_LEGAL_ENTITY (e.g. "Example Labs Ltd.") for accurate policies.
  legalEntity: value(
    env.VITE_LEGAL_ENTITY,
    `the operator of VupsRouter (legal entity ${LEGAL_PLACEHOLDER_MARKER} — set VITE_LEGAL_ENTITY)`
  ),

  // Where the operator is established; used for governing law and processing notices.
  jurisdiction: value(
    env.VITE_LEGAL_JURISDICTION,
    `to be confirmed (${LEGAL_PLACEHOLDER_MARKER} — set VITE_LEGAL_JURISDICTION)`
  ),

  // Contact for privacy, legal, and takedown requests.
  contactEmail: value(env.VITE_LEGAL_CONTACT_EMAIL, "legal@vupsrouter.example"),

  // Date the current version of the policies took effect (ISO date).
  effectiveDate: value(env.VITE_LEGAL_EFFECTIVE_DATE, "2026-10-19"),

  // Minimum age for using the service; keep in sync with your jurisdiction's rules.
  minimumAge: value(env.VITE_LEGAL_MINIMUM_AGE, "16"),

  // Short description of retention, used verbatim in the privacy policy.
  // Defaults describe the app's actual behavior; add explicit periods here once
  // they are decided (e.g. "account data is deleted within 30 days of request").
  retention:
    value(env.VITE_LEGAL_RETENTION_DESCRIPTION, null) ||
    "Conversations and provider settings stay in your account until you delete them. " +
    "Account records remain until the operator deletes the account on request. " +
    "Server logs are retained according to the hosting providers' own defaults. " +
    `Explicit numeric retention periods are ${LEGAL_PLACEHOLDER_MARKER} (set VITE_LEGAL_RETENTION_DESCRIPTION).`,

  // Public site URL, used for canonical and contact links.
  siteUrl: value(env.VITE_LEGAL_SITE_URL, "https://vups-router-three.vercel.app")
};

export function legalContactLine() {
  return `email ${LEGAL.contactEmail}`;
}
