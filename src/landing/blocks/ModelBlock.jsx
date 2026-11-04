import React, { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { faceTextures } from "../../home/blocksMaterials.js";
import { BLOCK_BEVEL, BLOCK_SIDE } from "./blockStageLayout.js";

// One block: a matte graphite cube with a real model name baked into it. The
// name is drawn once to a canvas and used twice — as the ink on the front face
// and as a height map that cuts the same letters into the clay — so the
// engraving is lit by the key light instead of floating as a decal.

// The shared cube carries the bevel as a ratio of its own side, so scaling an
// instance keeps the corner radius proportional at every tier.
const BEVEL_RATIO = BLOCK_BEVEL / BLOCK_SIDE;
// The stage asks for matte graphite: roughness 0.85, effectively no metal.
const ROUGHNESS = 0.85;

export function stageGeometry() {
  return {
    box: new RoundedBoxGeometry(BLOCK_SIDE, BLOCK_SIDE, BLOCK_SIDE, 4, BLOCK_SIDE * BEVEL_RATIO),
    plate: new THREE.PlaneGeometry(BLOCK_SIDE * 0.76, BLOCK_SIDE * 0.76)
  };
}

function damp(current, target, delta, rate) {
  return current + (target - current) * (1 - Math.exp(-delta * rate));
}

function easeOutQuint(value) {
  const clamped = Math.min(1, Math.max(0, value));
  return 1 - Math.pow(1 - clamped, 5);
}

export default function ModelBlock({ name, routed, index, home, geometry, palette, revealRef, progressRef, motion }) {
  const group = useRef(null);
  const faces = useMemo(() => faceTextures(name, "dark"), [name]);

  const bodyMaterial = useMemo(() => {
    const material = new THREE.MeshStandardMaterial({
      color: routed ? palette.accent : index % 2 ? palette.clayAlt : palette.clay,
      roughness: ROUGHNESS,
      metalness: 0.015,
      bumpMap: faces.relief,
      bumpScale: -BLOCK_SIDE * 0.035
    });
    return material;
  }, [routed, index, palette, faces]);

  const inkMaterial = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        map: faces.ink,
        transparent: true,
        opacity: routed ? 1 : 0.86,
        roughness: 0.9,
        metalness: 0,
        depthWrite: false
      }),
    [faces, routed]
  );

  useEffect(
    () => () => {
      bodyMaterial.dispose();
      inkMaterial.dispose();
    },
    [bodyMaterial, inkMaterial]
  );

  const targetScale = home.scale;

  useFrame((state, delta) => {
    const node = group.current;
    if (!node) return;
    const clamped = Math.min(1, Math.max(0, delta));
    // Deterministic entrance: each block rises into the cluster on the same
    // 700ms / 60ms grid the headline uses, with nothing random about the order.
    const start = revealRef.current;
    const reveal = !motion || !start ? 1 : easeOutQuint((performance.now() - start - index * 60) / 700);
    const leaving = progressRef.current;
    const idle = motion && reveal >= 1 ? Math.sin(state.clock.elapsedTime * 0.5 + index * 1.6) * 0.01 : 0;
    const rate = reveal < 1 ? 7 : 3.4;

    node.position.x = damp(node.position.x, home.x + (1 - reveal) * 0.35 - leaving * home.x * 0.25, clamped, rate);
    node.position.y = damp(node.position.y, home.y + (1 - reveal) * 0.9 + idle + leaving * 0.6, clamped, rate);
    node.position.z = damp(node.position.z, home.z - (1 - reveal) * 0.5 - leaving * 0.45, clamped, rate);
    node.scale.setScalar(damp(node.scale.x, targetScale * (0.82 + reveal * 0.18), clamped, 6));
    node.rotation.y = damp(node.rotation.y, home.rotY, clamped, 4);
    node.rotation.z = damp(node.rotation.z, home.rotZ, clamped, 4);
  });

  return (
    <group ref={group} position={[home.x, home.y + 0.9, home.z - 0.5]} scale={targetScale * 0.82}>
      <mesh geometry={geometry.box} material={bodyMaterial} />
      <mesh
        geometry={geometry.plate}
        material={inkMaterial}
        position={[0, 0, BLOCK_SIDE / 2 + 0.006]}
      />
    </group>
  );
}
