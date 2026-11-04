import React, { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { ContactShadows, Environment, Lightformer } from "@react-three/drei";
import * as THREE from "three";
import { paletteFor, token } from "../../tokens.js";
import VupsMark from "./VupsMark3D.jsx";
import ProviderConstellation from "./ProviderConstellation.jsx";
import MetallicLogoOverlay from "./MetallicLogoOverlay.jsx";
import { plateFrontZ } from "./markBuild.js";
import { MARK_SIZE } from "./markGeometry.js";
import { poseAt } from "./stagePose.js";
import { CAMERA_FOV, FLOOR_Y } from "./stageConstants.js";

/* One canvas for the whole dimensional act.

   Mounting a Canvas per section is how a landing page ends up with four WebGL
   contexts, three of them rendering off-screen. This is a single persistent
   scene whose camera, mark transform and cable reveal are all driven by one
   scroll value, so the page owns one renderer, one loop and one set of
   resources to dispose.

   The tier arrives as a prop: `useDimensionTier` decides it in the main chunk,
   before this module — and with it three.js — is worth downloading. */

/* The ReactBits Metallic Paint logo is a DOM surface, so the scene has to tell it
   where the brand plate ended up on screen. Three numbers answer that: the
   projected centre of the plate face, and the projected positions of its right and
   top edge midpoints. The plate square and the logo artwork share the same box, so
   the plate's projected width divided by the host's width is the component's own
   `scale`. */
const PLATE_HALF = MARK_SIZE / 2;
const PLATE_FACE_Z = plateFrontZ(1);
/** The host is a fixed square, sized against the stage so the metal stays as
    sharp as the canvas it sits on. 0.8 leaves room for the largest pose. */
const HOST_RATIO = 0.8;
const HOST_MIN = 320;
const HOST_MAX = 900;
const SCALE_MIN = 0.05;
const SCALE_MAX = 0.95;

function StageScene({ pose, theme, tier, markRef, onLost, metal }) {
  const palette = useMemo(() => paletteFor(theme), [theme]);
  const { camera, gl } = useThree();
  const look = useMemo(() => new THREE.Vector3(0, 0, 0), []);
  const goal = useMemo(() => new THREE.Vector3(0, 0.3, 6.15), []);
  const aim = useMemo(() => new THREE.Vector3(), []);
  const faceCentre = useMemo(() => new THREE.Vector3(), []);
  const faceRight = useMemo(() => new THREE.Vector3(), []);
  const faceTop = useMemo(() => new THREE.Vector3(), []);
  const pointer = useRef({ x: 0, y: 0 });
  const hostSize = useRef(0);

  // A lost context is a browser event, not a React error: the page keeps its
  // text and hands the composition back to the DOM.
  useEffect(() => {
    const canvas = gl?.domElement;
    if (!canvas || !onLost) return undefined;
    const lost = event => {
      event.preventDefault();
      onLost();
    };
    canvas.addEventListener("webglcontextlost", lost);
    return () => canvas.removeEventListener("webglcontextlost", lost);
  }, [gl, onLost]);

  useEffect(() => {
    const onMove = event => {
      pointer.current.x = (event.clientX / window.innerWidth) * 2 - 1;
      pointer.current.y = (event.clientY / window.innerHeight) * 2 - 1;
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, []);

  useFrame(state => {
    const next = poseAt(pose?.current?.progress ?? 0);
    /* The camera chases the pose instead of snapping to it, which is what makes
       a scrubbed scroll read as a move rather than as a jump between scenes. */
    goal.set(
      next.camera.x + pointer.current.x * 0.32,
      next.camera.y - pointer.current.y * 0.2,
      next.camera.z
    );
    camera.position.lerp(goal, 0.1);
    aim.set(next.target.x, next.target.y, next.target.z);
    look.lerp(aim, 0.1);
    camera.lookAt(look);

    if (markRef.current) {
      markRef.current.position.set(next.mark.x, next.mark.y, next.mark.z);
      markRef.current.rotation.y = next.mark.spin;
      markRef.current.scale.setScalar(next.mark.scale);
    }
    if (pose) pose.current.value = next;
    if (metal?.active) placeMetalLogo(state.size);
  });

  /* Written straight to the element: a scroll-driven position that went through
     React state would re-render the canvas tree 60 times a second, and
     MetallicPaint rebuilds its drawing buffer whenever its box changes, so the
     host only ever translates and never resizes mid-scrub. */
  function placeMetalLogo(size) {
    const plate = metal.plate?.current;
    const host = metal.host?.current;
    const api = metal.api?.current;
    if (!plate || !host || !api) return;

    const wanted = Math.min(HOST_MAX, Math.max(HOST_MIN, Math.round(size.height * HOST_RATIO)));
    if (hostSize.current !== wanted) {
      hostSize.current = wanted;
      host.style.width = `${wanted}px`;
      host.style.height = `${wanted}px`;
    }

    /* Both matrices are refreshed here rather than left to the render pass:
       the camera was moved above, and the plate's own entrance scale is written
       by a GSAP tween that does not run in this callback's order. */
    camera.updateMatrixWorld();
    plate.updateWorldMatrix(true, false);
    const s = plate.scale;
    const faceZ = PLATE_FACE_Z * s.z;
    faceCentre.set(0, 0, faceZ).applyMatrix4(plate.matrixWorld).project(camera);
    if (faceCentre.z <= -1 || faceCentre.z >= 1) return;
    faceRight.set(PLATE_HALF * s.x, 0, faceZ).applyMatrix4(plate.matrixWorld).project(camera);
    faceTop.set(0, PLATE_HALF * s.y, faceZ).applyMatrix4(plate.matrixWorld).project(camera);

    const centreX = (faceCentre.x * 0.5 + 0.5) * size.width;
    const centreY = (0.5 - faceCentre.y * 0.5) * size.height;
    const across = Math.abs((faceRight.x * 0.5 + 0.5) * size.width - centreX) * 2;
    const down = Math.abs((0.5 - faceTop.y * 0.5) * size.height - centreY) * 2;
    const fit = Math.min(across, down);
    if (!Number.isFinite(fit) || fit <= 0) return;

    host.style.transform = `translate3d(${(centreX - wanted / 2).toFixed(2)}px, ${(
      centreY - wanted / 2
    ).toFixed(2)}px, 0)`;
    api.setScale?.(Math.min(SCALE_MAX, Math.max(SCALE_MIN, fit / wanted)));
  }

  return (
    <>
      <ambientLight intensity={0.6} color={token("fill", palette)} />
      <directionalLight position={[3.4, 4.4, 5.2]} intensity={1.45} color={token("key", palette)} />
      <directionalLight position={[-4.2, 0.6, -3.6]} intensity={0.45} color={token("accent", palette)} />
      {/* A studio the scene builds for itself: emissive planes baked into an
          environment map, so the metal has something to reflect without a
          single network request. */}
      <Environment resolution={128} frames={1}>
        <Lightformer intensity={1.15} position={[0, 3, 3]} scale={[6, 2.4, 1]} color={token("key", palette)} />
        <Lightformer intensity={0.55} position={[-4, 1, -2]} scale={[3, 3, 1]} color={token("fill", palette)} />
        <Lightformer form="ring" intensity={0.45} position={[3, -1, -3]} scale={2.4} color={token("accent", palette)} />
      </Environment>

      <group ref={markRef}>
        <VupsMark
          palette={palette}
          motion={tier.motion}
          glyph={!metal?.active}
          tile={!metal?.active}
          plateRef={metal?.plate}
        />
        {tier.limitPerGroup > 0 ? (
          <ProviderConstellation
            pose={pose}
            theme={theme}
            motion={tier.motion}
            parallax={tier.motion}
            limitPerGroup={tier.limitPerGroup}
          />
        ) : null}
      </group>

      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, FLOOR_Y, 0]}>
        <circleGeometry args={[9, 56]} />
        <meshStandardMaterial color={token("floor", palette)} roughness={0.98} metalness={0} />
      </mesh>

      {tier.shadows ? (
        <ContactShadows
          position={[0, FLOOR_Y + 0.005, 0]}
          scale={9}
          resolution={512}
          blur={2.6}
          opacity={0.55}
          color={token("shadow", palette)}
        />
      ) : null}
    </>
  );
}

export default function DimensionStage({ pose, theme = "dark", tier, onLost }) {
  const markRef = useRef(null);
  const wrap = useRef(null);
  const plateRef = useRef(null);
  const hostRef = useRef(null);
  const metalApi = useRef(null);
  const [metalActive, setMetalActive] = useState(false);
  const [visible, setVisible] = useState(true);

  const metal = useMemo(
    () => ({ active: metalActive, plate: plateRef, host: hostRef, api: metalApi }),
    [metalActive]
  );

  // Rendering a scene nobody can see is the most expensive mistake a 3D landing
  // page makes, so the loop stops when the stage leaves the viewport.
  useEffect(() => {
    const node = wrap.current;
    if (!node || typeof IntersectionObserver === "undefined") return undefined;
    const observer = new IntersectionObserver(
      entries => setVisible(entries[0]?.isIntersecting ?? true),
      { rootMargin: "180px 0px" }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  if (!tier?.webgl) return null;

  return (
    <div className="vd-stage" ref={wrap} aria-hidden="true">
      <Canvas
        dpr={[1, tier.dpr]}
        camera={{ fov: CAMERA_FOV, position: [0, 0.3, 6.15], near: 0.1, far: 40 }}
        frameloop={visible ? "always" : "never"}
        gl={{
          alpha: true,
          antialias: true,
          powerPreference: "high-performance",
          preserveDrawingBuffer: false
        }}
        onCreated={({ gl }) => {
          gl.setClearAlpha(0);
          gl.toneMapping = THREE.ACESFilmicToneMapping;
          gl.toneMappingExposure = 1.05;
        }}
      >
        <Suspense fallback={null}>
          <StageScene
            pose={pose}
            theme={theme}
            tier={tier}
            markRef={markRef}
            onLost={onLost}
            metal={metal}
          />
        </Suspense>
      </Canvas>
      <MetallicLogoOverlay
        motion={tier.motion}
        hostRef={hostRef}
        apiRef={metalApi}
        onActive={setMetalActive}
      />
    </div>
  );
}
