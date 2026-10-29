import React from "react";

import { detectLinkRuntime, openExternalUrl, reportLinkError } from "../native/externalLinks.js";

export default function ExternalLink({
  href,
  children,
  onClick,
  onOpen,
  allowMailto = true,
  runtime,
  open = openExternalUrl,
  ...rest
}) {
  async function handleClick(event) {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0) return;
    const activeRuntime = runtime ?? detectLinkRuntime();
    // A normal browser already opens target="_blank" correctly; intercepting
    // it would only break middle-click, copy-link, and keyboard behavior.
    if (activeRuntime === "web") return;
    event.preventDefault();
    try {
      const opened = await open(href, { allowMailto, runtime: activeRuntime });
      onOpen?.(opened);
    } catch (error) {
      reportLinkError(error?.message || "The link could not be opened.", href);
    }
  }

  return (
    <a href={href} target="_blank" rel="noopener noreferrer" onClick={handleClick} {...rest}>
      {children}
    </a>
  );
}
