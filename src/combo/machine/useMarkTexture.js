import { useEffect, useState } from "react";
import { acquireMarkTexture } from "../comboTextures.js";

// The provider mark is resolved outside the frame loop: a texture arrives once
// and the mesh then keeps it. Nothing is drawn here - comboTextures rasterises
// the same authentic artwork the 2D layer already uses.
export default function useMarkTexture(art) {
  const [texture, setTexture] = useState(null);
  useEffect(() => {
    let active = true;
    if (!art) return undefined;
    acquireMarkTexture(art).then(value => {
      if (active && value) setTexture(value);
    });
    return () => {
      active = false;
    };
  }, [art?.type, art?.src, art?.wordmark, art?.color, art?.name]);
  return texture;
}
