import React, { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { ContactShadows, Edges, Html, PerformanceMonitor, RoundedBox } from "@react-three/drei";
import * as THREE from "three";
import {
  CAMERA_FOV,
  FLOOR_Y,
  blockPosition,
  blockSide,
  cameraDistance,
  pixelsToWorld,
  pointerParallax
} from "./blocksLayout.js";
import { faceTextures, studioCanvas } from "./blocksMaterials.js";

// Presentation only. Nothing here reads a provider, sends a request or decides
// which model answers: it draws the blocks the DOM layer hands it and reports
// back nothing but pixels. Selection, sending and permission checks stay in
// ChatPage where they already live.

const HANDOFF_MS = 400;
const SELECT_MS = 250;
const SELECT_FORWARD = 0.6;
const SELECT_LIFT_PX = 8;
const LINE_POINTS = 26;

function easeOut(value) {
  const clamped = Math.max(0, Math.min(1, value));
  return 1 - Math.pow(1 - clamped, 3);
}

function Studio({ theme }) {
  const gl = useThree(state => state.gl);
  const scene = useThree(state => state.scene);

  useEffect(() => {
    const source = new THREE.CanvasTexture(studioCanvas(theme));
    source.mapping = THREE.EquirectangularReflectionMapping;
    source.colorSpace = THREE.SRGBColorSpace;
    const pmrem = new THREE.PMREMGenerator(gl);
    let target = null;
    try {
      target = pmrem.fromEquirectangular(source);
      scene.environment = target.texture;
    } catch {
      scene.environment = null;
    }
    source.dispose();
    pmrem.dispose();
    return () => {
      scene.environment = null;
      if (target) target.dispose();
    };
  }, [gl, scene, theme]);

  return null;
}

function Rig({ pointerRef, motion, distance }) {
  const camera = useThree(state => state.camera);
  const shifted = useRef({ x: 0, y: 0 });

  useEffect(() => {
    camera.fov = CAMERA_FOV;
    camera.near = 0.5;
    camera.far = 40;
    camera.updateProjectionMatrix();
  }, [camera]);

  useFrame((_, delta) => {
    const next = pointerParallax(pointerRef.current, { motion });
    const k = 1 - Math.exp(-delta * 4.5);
    shifted.current.x += (next.x - shifted.current.x) * k;
    shifted.current.y += (next.y - shifted.current.y) * k;
    // The fixed down-tilt is what puts the floor in frame; parallax slides the
    // rig within that plane instead of re-aiming it, so the shelf never tips.
    camera.position.set(shifted.current.x, 0.62 + shifted.current.y, distance);
    camera.lookAt(0, FLOOR_Y + 0.42, 0);
  });

  return null;
}

function HandoffLine({ handoffRef, palette }) {
  const { camera, size } = useThree();
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(LINE_POINTS * 3), 3));
    g.setDrawRange(0, 0);
    return g;
  }, []);
  const material = useMemo(
    () => new THREE.LineBasicMaterial({ color: palette.accent, transparent: true, opacity: 0.8 }),
    [palette.accent]
  );
  const object = useMemo(() => new THREE.Line(geometry, material), [geometry, material]);
  const cursor = useMemo(() => new THREE.Vector3(), []);
  const bow = useMemo(() => new THREE.Vector3(), []);

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material]
  );

  useFrame(() => {
    const active = handoffRef.current;
    const block = active?.block;
    const anchor = active?.anchor;
    if (!block || !anchor || !size.width || !size.height) {
      geometry.setDrawRange(0, 0);
      return;
    }
    cursor
      .set(
        (anchor.x / size.width) * 2 - 1,
        -((anchor.y / size.height) * 2 - 1),
        0.3
      )
      .unproject(camera);
    const side = blockSide(block.slot, active.sizeScale);
    const [ex, ey, ez] = blockPosition(block.slot, { side });
    bow.set((cursor.x + ex) / 2, Math.max(cursor.y, ey) + 0.42, (cursor.z + ez) / 2 + 0.28);
    const positions = geometry.attributes.position.array;
    for (let i = 0; i < LINE_POINTS; i += 1) {
      const t = i / (LINE_POINTS - 1);
      const a = 1 - t;
      positions[i * 3] = a * a * cursor.x + 2 * a * t * bow.x + t * t * ex;
      positions[i * 3 + 1] = a * a * cursor.y + 2 * a * t * bow.y + t * t * ey;
      positions[i * 3 + 2] = a * a * cursor.z + 2 * a * t * bow.z + t * t * ez;
    }
    geometry.attributes.position.needsUpdate = true;
    const progress = easeOut((performance.now() - active.t0) / HANDOFF_MS);
    geometry.setDrawRange(0, Math.max(2, Math.round(progress * LINE_POINTS)));
  });

  return <primitive object={object} />;
}

function Block({
  block,
  index,
  motion,
  hovered,
  selected,
  handoffRef,
  palette,
  sizeScale,
  distance,
  heightPx,
  fontEpoch
}) {
  const group = useRef(null);
  const body = useRef(null);
  const side = blockSide(block.slot, sizeScale);
  const home = useMemo(() => blockPosition(block.slot, { side }), [block.slot, side]);
  const faces = useMemo(
    // eslint-disable-next-line react-hooks/exhaustive-deps
    () => faceTextures(block.face, palette.theme),
    [block.face, palette.theme, fontEpoch]
  );
  const clay = useMemo(
    () => new THREE.Color(index % 2 ? palette.clayAlt : palette.clay),
    [index, palette.clay, palette.clayAlt]
  );
  const accent = useMemo(() => new THREE.Color(palette.accent), [palette.accent]);
  const lift = pixelsToWorld(SELECT_LIFT_PX, distance, heightPx);
  // Tween state lives in a ref so a selection change never re-renders the scene,
  // and each new transition starts from wherever the block currently is: rapid
  // switching interrupts cleanly instead of leaving a block half-raised.
  const tween = useRef({ from: selected ? 1 : 0, to: selected ? 1 : 0, start: 0 });

  useEffect(() => {
    const current = tween.current;
    const target = selected ? 1 : 0;
    if (current.to === target) return;
    const elapsed = motion ? performance.now() - current.start : 0;
    const progress = motion ? Math.min(1, elapsed / SELECT_MS) : 1;
    const value = current.from + (current.to - current.from) * easeOut(progress);
    current.from = value;
    current.to = target;
    current.start = performance.now();
  }, [selected, motion]);

  useFrame((state, delta) => {
    const node = group.current;
    if (!node) return;
    const active = handoffRef.current;
    const isRouting = Boolean(active && active.block?.key === block.key);
    const progress = isRouting ? easeOut((performance.now() - active.t0) / HANDOFF_MS) : 0;
    const tw = tween.current;
    const span = motion ? Math.min(1, (performance.now() - tw.start) / SELECT_MS) : 1;
    tw.value = tw.from + (tw.to - tw.from) * easeOut(span);
    const sel = tw.value;
    const idle = motion ? Math.sin(state.clock.elapsedTime * 0.55 + index * 1.7) * 0.012 : 0;
    const rise = (hovered ? 0.062 : 0) + sel * lift + progress * 0.05;
    const dim = active && !isRouting ? 0.62 : 1;
    const k = 1 - Math.exp(-delta * 11);

    node.position.x += (home[0] - node.position.x) * k;
    node.position.y += (home[1] + idle + rise - node.position.y) * k;
    node.position.z += (home[2] + progress * 0.62 + sel * SELECT_FORWARD - node.position.z) * k;
    const target = (isRouting ? 1 + progress * 0.12 : 1) * dim;
    node.scale.setScalar(node.scale.x + (target - node.scale.x) * k);
    node.rotation.y += (block.slot.rotY - node.rotation.y) * k;
    node.rotation.z += (block.slot.rotZ - node.rotation.z) * k;
    if (body.current) body.current.color.copy(clay).lerp(accent, sel);
  });

  return (
    <group ref={group} position={home}>
      <RoundedBox args={[side, side, side]} radius={side * 0.15} smoothness={4}>
        <meshStandardMaterial
          ref={body}
          color={clay}
          roughness={0.9}
          metalness={0}
          envMapIntensity={0.35}
          bumpMap={faces.relief}
          bumpScale={-side * 0.03}
        />
        {selected ? (
          <Edges
            scale={1.02}
            threshold={14}
            color={palette.accent}
            lineWidth={1.5}
            transparent
            opacity={0.95}
          />
        ) : null}
      </RoundedBox>
      <mesh position={[0, 0, side / 2 + 0.004]}>
        <planeGeometry args={[side * 0.8, side * 0.8]} />
        <meshStandardMaterial
          map={faces.ink}
          transparent
          opacity={selected ? 0.96 : 0.7}
          roughness={0.9}
          metalness={0}
          depthWrite={false}
        />
      </mesh>
      {hovered ? (
        <Html
          transform
          center
          distanceFactor={2.4}
          position={[0, side * 0.92, side * 0.5]}
          pointerEvents="none"
          zIndexRange={[20, 0]}
          className="vr-block-label"
        >
          <span className="vr-block-label__name">{block.face}</span>
          <span className="vr-block-label__model">{block.model}</span>
          {block.provider ? <span className="vr-block-label__via">{block.provider}</span> : null}
        </Html>
      ) : null}
    </group>
  );
}

function SceneContents({
  blocks,
  palette,
  tier,
  visible,
  hoveredKey,
  pointerRef,
  handoffRef,
  handoffToken,
  fontEpoch,
  rendering
}) {
  const size = useThree(state => state.size);
  const invalidate = useThree(state => state.invalidate);
  const distance = useMemo(
    () => cameraDistance(size.width / (size.height || 1)),
    [size.width, size.height]
  );
  const sizeScale = useMemo(
    () => Math.max(0.62, Math.min(1.1, (size.height || 600) / 560)) * tier.sizeScale,
    [size.height, tier.sizeScale]
  );

  // Demand mode still has to answer a hover, a new catalog or a theme change.
  useEffect(() => {
    invalidate();
  }, [blocks, hoveredKey, palette, distance, handoffToken, invalidate]);

  return (
    <>
      <Rig pointerRef={pointerRef} motion={tier.motion && visible} distance={distance} />
      <Studio theme={palette.theme} />
      <ambientLight intensity={palette.theme === "light" ? 0.85 : 0.5} />
      <directionalLight position={[-3.2, 5.4, 3.6]} intensity={1.05} color={palette.key} />
      {/* Grazes the back-left top edge so graphite reads against the background
          without a glow: matte roughness, no specular bloom. */}
      <directionalLight position={[-4.6, 2.8, -3.8]} intensity={1.2} color={palette.key} />
      <directionalLight position={[4.2, 1.4, 2.2]} intensity={0.3} color={palette.fill} />
      <mesh rotation-x={-Math.PI / 2} position={[0, FLOOR_Y, 0]}>
        <planeGeometry args={[26, 26]} />
        <meshStandardMaterial color={palette.floor} roughness={0.97} metalness={0} />
      </mesh>
      {tier.shadows ? (
        <ContactShadows
          position={[0, FLOOR_Y + 0.002, 0]}
          scale={9}
          blur={2.6}
          opacity={palette.theme === "light" ? 0.32 : 0.58}
          far={2.4}
          resolution={512}
          frames={rendering ? Infinity : 1}
          color={palette.shadow}
        />
      ) : null}
      {blocks.map((block, index) => (
        <Block
          key={block.key}
          block={block}
          index={index}
          motion={tier.motion && visible}
          hovered={block.key === hoveredKey}
          selected={Boolean(block.active)}
          handoffRef={handoffRef}
          palette={palette}
          sizeScale={sizeScale}
          distance={distance}
          heightPx={size.height}
          fontEpoch={fontEpoch}
        />
      ))}
      <HandoffLine handoffRef={handoffRef} palette={palette} />
    </>
  );
}

export default function ModelBlockScene({
  blocks,
  palette,
  tier,
  visible = true,
  rendering: renderingProp = false,
  hoveredKey = "",
  fontEpoch = 0,
  pointerRef,
  handoffRef,
  handoffToken = 0,
  onContextLost
}) {
  const [dprCap, setDprCap] = useState(tier.dpr);
  const running = renderingProp || (tier.motion && visible);

  return (
    <Canvas
      resize={{ offsetSize: true }}
      frameloop={running ? "always" : "demand"}
      dpr={[1, dprCap]}
      gl={{ antialias: tier.dpr >= 1.4, alpha: true, powerPreference: "high-performance" }}
      camera={{ fov: CAMERA_FOV, position: [0, 0.62, 7] }}
      onCreated={({ gl }) => {
        gl.domElement.addEventListener(
          "webglcontextlost",
          event => {
            event.preventDefault();
            onContextLost?.(event);
          },
          false
        );
      }}
    >
      <PerformanceMonitor
        flipflops={3}
        onIncline={() => setDprCap(current => Math.min(tier.dpr, current + 0.25))}
        onDecline={() => setDprCap(current => Math.max(1, Math.min(current, tier.dpr) - 0.5))}
        onFallback={() => setDprCap(1)}
      />
      <SceneContents
        blocks={blocks}
        palette={palette}
        tier={tier}
        visible={visible}
        rendering={running}
        handoffToken={handoffToken}
        hoveredKey={hoveredKey}
        fontEpoch={fontEpoch}
        pointerRef={pointerRef}
        handoffRef={handoffRef}
      />
    </Canvas>
  );
}
