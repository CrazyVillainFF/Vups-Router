import React from "react";
import { artworkStyle, providerArtwork } from "./comboArtwork.js";
import "./combo.css";

export default function ModelArtwork({ model, artwork, size = "md", className = "" }) {
  const art = artwork || providerArtwork(model || {});
  return (
    <span
      className={`combo-art combo-art--${size}${className ? ` ${className}` : ""}`}
      data-kind={art.type}
      /* The runtime colour guard has to be able to honour the same narrow
         exception the static census does: this box paints another company's
         identity, and only this box. qa/guard-render.mjs reads the attribute. */
      data-brand="third-party identity"
      style={artworkStyle(art)}
      aria-hidden="true"
    >
      {art.type === "logo" ? <span className="combo-art__mask" /> : null}
      {art.type === "image" ? (
        <img className="combo-art__image" src={art.src} alt="" loading="lazy" decoding="async" draggable="false" />
      ) : null}
      {art.type === "wordmark" ? <span className="combo-art__wordmark">{art.wordmark}</span> : null}
    </span>
  );
}
