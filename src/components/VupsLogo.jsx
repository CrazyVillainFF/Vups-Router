import React from "react";

// Exported so the WebGL core textures the same asset the DOM logo element uses.
export const LOGO_SRC = "/vups-logo.png";
const LOGO_SRC_SET = "/vups-logo-192.png 192w, /vups-logo.png 512w";

export default function VupsLogo({
  className = "",
  alt = "",
  sizes = "64px",
  loading = "eager",
  decoding = "async"
}) {
  return (
    <img
      src={LOGO_SRC}
      srcSet={LOGO_SRC_SET}
      sizes={sizes}
      alt={alt}
      className={className || undefined}
      draggable="false"
      loading={loading}
      decoding={decoding}
      width="512"
      height="512"
    />
  );
}
