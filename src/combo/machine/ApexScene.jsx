import { token, mix } from "../../tokens.js";
import React, { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { PerformanceMonitor } from "@react-three/drei";
import * as THREE from "three";
import {
  CAMERA_FOV,
  cameraDistance,
  cameraOffset,
  coreModel,
  nodeModel,
  parallaxOffset,
  qualityTier,
  startupPhase
} from "../comboScene.js";
import ApexCore3D from "./ApexCore3D.jsx";
import EnergyConnector3D from "./EnergyConnector3D.jsx";
import ProviderNode3D from "./ProviderNode3D.jsx";
import { environmentCanvas } from "./apexMaterials.js";

// The WebGL layer is a pure renderer. Layout, spring physics, pointer input,
// keyboard control and accessibility stay with the DOM shell in ComboPowerCore,
// so the 3D machine and the 2D fallback can never disagree about where a
// provider is or whether it is actually working.

function Studio({ core, startupRef }) {
  const gl = useThree(state => state.gl);
  const scene = useThree(state => state.scene);

  useEffect(() => {
    const source = new THREE.CanvasTexture(environmentCanvas());
    source.mapping = THREE.EquirectangularReflectionMapping;
    source.colorSpace = THREE.SRGBColorSpace;
    const pmrem = new THREE.PMREMGenerator(gl);
    let target = null;
    try {
      target = pmrem.fromEquirectangular(source);
      scene.environment = target.texture;
    } catch {
      // PMREM needs a working float target; without it the core keeps its
      // emissive lighting instead of turning into a black silhouette.
      scene.environment = null;
    }
    source.dispose();
    pmrem.dispose();
    return () => {
      scene.environment = null;
      scene.environmentIntensity = 1;
      if (target) target.dispose();
    };
  }, [gl, scene]);

  useFrame(() => {
    // Idle stays dim; energy from a real run lifts the whole studio. The
    // environment phase is the first thing the startup timeline opens.
    const room = startupPhase(startupRef.current, "environment");
    scene.environmentIntensity = (0.62 + core.energy * 0.4) * (0.12 + room * 0.88);
  });
  return null;
}

function Rig({ layout, pointerRef, parallaxRef }) {
  const { camera, size } = useThree();
  useFrame(() => {
    const height = size.height || layout.height || 1;
    const width = size.width || layout.width || 1;
    const shift = cameraOffset(layout, { width, height });
    camera.position.set(shift.x, shift.y, cameraDistance(height));
    // No lookAt and no rotation: the node plane keeps one exact linear
    // world-to-screen rule, so the DOM hit targets stay under the meshes.
    camera.rotation.set(0, 0, 0);
    const next = parallaxOffset(pointerRef.current, { width, height });
    parallaxRef.current.x += (next.x - parallaxRef.current.x) * 0.08;
    parallaxRef.current.y += (next.y - parallaxRef.current.y) * 0.08;
  });
  return null;
}

export default function ApexScene({
  layout,
  entriesRef,
  statusById,
  liveById,
  interactionRef,
  pointerRef,
  coreState,
  startupRef,
  selectedId,
  quality,
  visible = true,
  awake = true,
  onContextLost
}) {
  const statesRef = useRef(new Map());
  const parallaxRef = useRef({ x: 0, y: 0 });
  const settledRef = useRef(1);
  const activeStartupRef = startupRef || settledRef;
  const ownPointerRef = useRef({ x: layout.width / 2, y: layout.height / 2 });
  const activePointerRef = pointerRef || ownPointerRef;
  const measuredTier = useMemo(
    () => qualityTier({ width: layout.width, height: layout.height }),
    [layout.width, layout.height]
  );
  const tier = quality || measuredTier;
  const nodes = layout.nodes;
  const core = coreState || coreModel({
    connected: false,
    runActive: false,
    liveWorking: 0,
    intensity: 0
  });

  // Adaptive resolution: PerformanceMonitor samples real frame rate over
  // consecutive windows and only steps the pixel ratio down after sustained
  // pressure, so a slow GPU keeps a smooth machine instead of a pretty stutter.
  const [dprCap, setDprCap] = useState(tier.dpr);
  useEffect(() => {
    setDprCap(current => (current > tier.dpr ? tier.dpr : current));
  }, [tier.dpr]);

  useEffect(() => {
    for (const node of nodes) {
      statesRef.current.set(node.key, nodeModel({
        status: statusById.get(node.key),
        live: liveById.get(node.key)
      }));
    }
  }, [nodes, statusById, liveById]);

  if (!layout.width || !layout.height) return null;

  return (
    <Canvas
      className="combo-machine"
      // The canvas only draws: input, focus and the elastic physics stay on the
      // DOM nodes, so it must never swallow a pointer event.
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}
      // Measure the layout box, not the painted box. The startup animates a
      // transform on an ancestor, and a transform never changes offsetWidth, so
      // a bounding-rect measurement keeps the size captured mid-scale forever
      // and the whole 3D layer lands off the DOM nodes it has to cover.
      resize={{ offsetSize: true }}
      // Demand rendering while the machine is settled: an idle scene with no
      // pointer, no drag and no run reporting has nothing new to draw, so the
      // frame loop stops instead of repainting the same metal sixty times a
      // second. Any of those events wakes it through the DOM shell.
      frameloop={visible && awake ? "always" : "demand"}
      dpr={[1, dprCap]}
      gl={{ antialias: dprCap >= 1.5, alpha: true, powerPreference: "high-performance" }}
      camera={{ fov: CAMERA_FOV, position: [0, 0, cameraDistance(layout.height)], near: 0.4, far: 90 }}
      onCreated={({ gl }) => {
        gl.domElement.addEventListener("webglcontextlost", event => {
          event.preventDefault();
          onContextLost?.(event);
        }, false);
      }}
    >
      <PerformanceMonitor
        flipflops={3}
        onIncline={() => setDprCap(current => Math.min(tier.dpr, current + 0.25))}
        onDecline={() => setDprCap(current => Math.max(1, Math.min(current, tier.dpr) - 0.5))}
        onFallback={() => setDprCap(1)}
      />
      <Rig layout={layout} pointerRef={activePointerRef} parallaxRef={parallaxRef} />
      <Studio core={core} startupRef={activeStartupRef} />
      {/* One key light from above left, a cool fill and a violet rim: enough to
          model the metal without the blown-out front-facing bloom. */}
      <ambientLight intensity={0.34} />
      <directionalLight position={[-3, 5, 7]} intensity={1.55} color={token("text")} />
      <directionalLight position={[6, -4, 2]} intensity={0.45} color={token("accent")} />
      {/* The point light is the core's own emission. It has to fall off before it
          reaches the harness, or every node inherits a blue cast, and it has to
          stay close to the plate or it grades the whole recess into a cone. */}
      <pointLight position={[0, 0, 3]} decay={2} intensity={1.2 + core.energy * 5} distance={9} color={token("accent")} />
      <ApexCore3D layout={layout} core={core} startupRef={activeStartupRef} parallaxRef={parallaxRef} />
      <EnergyConnector3D
        layout={layout}
        nodes={nodes}
        entriesRef={entriesRef}
        statesRef={statesRef}
        quality={tier}
        startupRef={activeStartupRef}
      />
      {nodes.map((node, index) => (
        <ProviderNode3D
          key={node.key}
          node={node}
          index={index}
          total={nodes.length}
          selected={Boolean(selectedId) && node.key === selectedId}
          layout={layout}
          entriesRef={entriesRef}
          statesRef={statesRef}
          interactionRef={interactionRef}
          startupRef={activeStartupRef}
        />
      ))}
    </Canvas>
  );
}
