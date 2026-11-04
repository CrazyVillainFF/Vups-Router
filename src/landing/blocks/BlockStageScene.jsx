import React, { useEffect, useMemo, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { ContactShadows } from "@react-three/drei";
import * as THREE from "three";
import ModelBlock, { stageGeometry } from "./ModelBlock.jsx";
import { studioCanvas } from "../../home/blocksMaterials.js";
import {
  CAMERA_FOV,
  CAMERA_Y,
  CAMERA_Z,
  FLOOR_Y,
  LOOK_Y,
  heroLayout,
  parallaxPose
} from "./blockStageLayout.js";
import { ROUTED_BLOCK, STAGE_PALETTE, stageBlocks } from "./blockStageData.js";

// Presentation only. The scene draws the seven names the shipped catalog and
// provider registry actually contain; it reads no provider, sends no request
// and decides no routing. Every figure the blocks carry is a name, never a
// speed, price or benchmark, because the product publishes none of those.

function Studio() {
  const gl = useThree(state => state.gl);
  const scene = useThree(state => state.scene);

  useEffect(() => {
    const source = new THREE.CanvasTexture(studioCanvas("dark"));
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
  }, [gl, scene]);

  return null;
}

function Rig({ pointerRef, poseRef, motion }) {
  const camera = useThree(state => state.camera);
  const eye = useRef(new THREE.Vector3(0, CAMERA_Y, CAMERA_Z));
  const aim = useRef(new THREE.Vector3(0, LOOK_Y, 0));

  useEffect(() => {
    camera.fov = CAMERA_FOV;
    camera.near = 0.5;
    camera.far = 42;
    camera.updateProjectionMatrix();
  }, [camera]);

  useFrame((_, delta) => {
    const pose = poseRef.current;
    const wanted = pose?.camera || { x: 0, y: CAMERA_Y, z: CAMERA_Z, lookY: LOOK_Y };
    const parallax = parallaxPose(pointerRef.current, { motion });
    const k = 1 - Math.exp(-Math.min(1, Math.max(0, delta)) * 3.2);
    eye.current.x += (wanted.x + parallax.x - eye.current.x) * k;
    eye.current.y += (wanted.y + parallax.y - eye.current.y) * k;
    eye.current.z += (wanted.z - eye.current.z) * k;
    aim.current.y += ((wanted.lookY ?? LOOK_Y) - aim.current.y) * k;
    camera.position.copy(eye.current);
    camera.lookAt(aim.current);
  });

  return null;
}

export default function BlockStageScene({ tier, visible, poseRef, pointerRef }) {
  const size = useThree(state => state.size);
  const aspect = Math.max(0.5, size.width / Math.max(1, size.height));
  const homes = useMemo(() => heroLayout(aspect), [aspect]);
  const geometry = useMemo(() => stageGeometry(), []);
  const revealRef = useRef(performance.now());
  const progressRef = useRef(0);
  // Contact shadows are baked, never a real-time map. The bake is keyed once
  // more after the entrance settles so the shadows match the finished cluster.
  const [bake, setBake] = useState(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setBake(value => value + 1), 1200);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => () => {
    geometry.box.dispose();
    geometry.plate.dispose();
  }, [geometry]);

  useFrame(() => {
    const pose = poseRef.current;
    // Stage 1 only directs the hero: the cluster lifts and tightens as the
    // headline scrolls away. Each later section gets its own composition.
    progressRef.current = pose?.section === "top" ? pose.progress : 0;
  });

  return (
    <>
      <Rig pointerRef={pointerRef} poseRef={poseRef} motion={tier.motion && visible} />
      <Studio />
      {/* One key from the upper left, one rim from behind the cluster. The
          image-based studio environment supplies the ambient term, so no extra
          fill light is needed to keep the graphite off pure black. */}
      <directionalLight position={[-3.4, 5.6, 3.4]} intensity={1.35} color={STAGE_PALETTE.key} />
      <directionalLight position={[4.4, 2.2, -3.6]} intensity={0.9} color={STAGE_PALETTE.fill} />
      <mesh rotation-x={-Math.PI / 2} position={[0, FLOOR_Y, 0]}>
        <planeGeometry args={[30, 30]} />
        <meshStandardMaterial color={STAGE_PALETTE.floor} roughness={0.96} metalness={0} />
      </mesh>
      {tier.shadows ? (
        <ContactShadows
          key={bake}
          position={[0, FLOOR_Y + 0.002, 0]}
          scale={10}
          blur={2.4}
          opacity={0.62}
          far={2.6}
          resolution={512}
          frames={1}
          color={STAGE_PALETTE.shadow}
        />
      ) : null}
      {stageBlocks.map((block, index) => (
        <ModelBlock
          key={block.name}
          name={block.name}
          routed={block.name === ROUTED_BLOCK}
          index={index}
          home={homes[index]}
          geometry={geometry}
          palette={STAGE_PALETTE}
          revealRef={revealRef}
          progressRef={progressRef}
          motion={tier.motion && visible}
        />
      ))}
    </>
  );
}
