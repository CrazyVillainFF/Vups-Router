import React, { Suspense, useEffect, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { disposeFaces } from "../../home/blocksMaterials.js";
import { CAMERA_FOV, MAX_DPR } from "./blockStageLayout.js";
import { useBlockStageScroll } from "./useBlockStageScroll.js";
import { usePageVisible, useStageTier } from "./useStageTier.js";
import BlockStageScene from "./BlockStageScene.jsx";

// One canvas for the whole film. It is fixed to the viewport, it never takes a
// pointer, and it survives every section — the page mounts exactly one WebGL
// context, not one per animated block.

const INITIAL_POSE = { x: 0, y: 0 };

export default function BlockStage({ onReady }) {
  const { tier } = useStageTier();
  const visible = usePageVisible();
  const { poseRef, section } = useBlockStageScroll({ enabled: tier.webgl });
  const pointerRef = useRef(INITIAL_POSE);
  const [live, setLive] = useState(false);

  useEffect(() => {
    if (!tier.motion) return undefined;
    const track = event => {
      pointerRef.current = {
        x: (event.clientX / Math.max(1, window.innerWidth)) * 2 - 1,
        y: (event.clientY / Math.max(1, window.innerHeight)) * 2 - 1
      };
    };
    window.addEventListener("pointermove", track, { passive: true });
    return () => {
      window.removeEventListener("pointermove", track);
    };
  }, [tier.motion]);

  // The label canvases are shared with the app's own block layer, so they are
  // only released when this page really goes away.
  useEffect(() => () => disposeFaces(), []);

  const running = tier.webgl && visible && tier.motion;

  return (
    <div
      className="vr-stage"
      aria-hidden="true"
      data-stage-section={section}
      data-stage-live={live ? "on" : "off"}
    >
      <Canvas
        resize={{ offsetSize: true }}
        frameloop={running ? "always" : "demand"}
        dpr={[1, Math.min(MAX_DPR, tier.dpr)]}
        gl={{ antialias: tier.dpr < 1.5, alpha: true, powerPreference: "high-performance" }}
        camera={{ fov: CAMERA_FOV, position: [0, 0.55, 7.4], near: 0.5, far: 42 }}
        onCreated={({ gl }) => {
          gl.domElement.addEventListener(
            "webglcontextlost",
            event => {
              event.preventDefault();
              setLive(false);
            },
            false
          );
          // Two frames in: the cluster has been drawn once, so the poster
          // underneath can hand over without a visible gap.
          requestAnimationFrame(() => requestAnimationFrame(() => {
            setLive(true);
            onReady?.();
          }));
        }}
      >
        <Suspense fallback={null}>
          <BlockStageScene tier={tier} visible={visible} poseRef={poseRef} pointerRef={pointerRef} />
        </Suspense>
      </Canvas>
    </div>
  );
}
