import { useEffect } from "react";

function setMeta(attr, key, content) {
  if (!content) return;
  let tag = document.head.querySelector(`meta[${attr}="${key}"]`);
  if (!tag) {
    tag = document.createElement("meta");
    tag.setAttribute(attr, key);
    document.head.appendChild(tag);
  }
  tag.setAttribute("content", content);
}

export default function PageMeta({ title, description, noIndex = false }) {
  useEffect(() => {
    if (title) document.title = title;
    setMeta("name", "description", description);
    setMeta("property", "og:title", title);
    setMeta("property", "og:description", description);
    setMeta("name", "twitter:title", title);
    setMeta("name", "twitter:description", description);
    if (noIndex) {
      setMeta("name", "robots", "noindex, nofollow");
    } else {
      const robots = document.head.querySelector('meta[name="robots"]');
      if (robots) robots.remove();
    }
  }, [title, description, noIndex]);
  return null;
}
