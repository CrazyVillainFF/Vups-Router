import React from "react";

export default function VupsLogo({ className = "", alt = "" }) {
  return (
    <img
      src="/vups-logo.png"
      alt={alt}
      className={className || undefined}
      draggable="false"
    />
  );
}
