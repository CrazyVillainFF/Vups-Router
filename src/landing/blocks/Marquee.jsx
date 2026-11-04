import React from "react";

// The provider band, still one real list of real names. The moving track is
// aria-hidden and the sentence underneath carries the same facts as text, so
// the band says nothing the DOM cannot already say. Reduced motion stops the
// track and turns the row into a normal scrollable strip.

export default function Marquee({ items, label, note }) {
  const doubled = [...items, ...items];
  return (
    <section className="vr-marquee" aria-label={label}>
      <div className="vr-marquee__row" aria-hidden="true">
        <span className="vr-marquee__track">
          {doubled.map((name, index) => (
            <span className="vr-marquee__item" key={`${name}-${index}`}>
              {name}
            </span>
          ))}
        </span>
      </div>
      <p className="vr-sr">{note}</p>
    </section>
  );
}
