import { token, mix } from "../../tokens.js";
import React, { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { LOGO_SRC } from "../../components/VupsLogo.jsx";
import { DEPTH, entranceScale, parallaxLean, startupPhase, toWorldSize } from "../comboScene.js";
import { additive, metal } from "./apexMaterials.js";
import useMarkTexture from "./useMarkTexture.js";

// The central orchestrator body: a machined housing, a recessed dark well, one
// precision channel, a bezel and the real VupsRouter artwork on the axis. Nothing
// here decides state - `core` is the pure model built from what the orchestrator
// actually reported, and `startupRef` is the single driver the entrance timeline
// writes. Both are read inside the frame loop so no React rerender is involved.
export default function ApexCore3D({ layout, core, startupRef, parallaxRef }) {
  const groupRef = useRef(null);
  const timeRef = useRef(0);
  const wellRef = useRef(null);
  const grooveRef = useRef(null);
  const bezelRef = useRef(null);
  const energyRef = useRef(null);
  const pulseRef = useRef(null);
  const logoRef = useRef(null);
  const logoTexture = useMarkTexture(useMemo(() => ({ type: "image", src: LOGO_SRC, color: token("accent") }), []));

  const materials = useMemo(() => ({
    // Graphite body with a dim structural emissive: enough to read as a material
    // at idle, not enough to read as activity.
    housing: metal(token("bg"), 0.46, 0.68, { emissive: token("surface"), emissiveIntensity: 1 }),
    // Brushed, not mirror-polished: a 0.2 roughness bezel throws a hard specular
    // band across the whole housing and reads as plastic chrome.
    bezel: metal(token("surface-2"), 0.34, 0.86, { emissive: token("accent"), emissiveIntensity: 0.08 }),
    groove: metal(token("surface"), 0.32, 0.78),
    well: new THREE.MeshPhysicalMaterial({
      color: token("bg"),
      roughness: 0.44,
      metalness: 0.3,
      clearcoat: 0.3,
      clearcoatRoughness: 0.34
    }),
    energy: additive(token("accent"), 0),
    pulse: additive(token("accent"), 0),
    logo: new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, toneMapped: false })
  }), []);

  useEffect(() => {
    if (!logoTexture) return;
    materials.logo.map = logoTexture;
    materials.logo.needsUpdate = true;
  }, [logoTexture, materials]);

  useEffect(() => () => {
    for (const material of Object.values(materials)) material.dispose();
  }, [materials]);

  const size = toWorldSize(layout.centerSize);

  useFrame((state, delta) => {
    const step = Math.min(0.05, delta);
    timeRef.current += step;
    const time = timeRef.current;
    const assembly = startupPhase(startupRef.current, "assembly");
    const ignition = startupPhase(startupRef.current, "initialize");
    const activation = startupPhase(startupRef.current, "activation");
    // One machined channel, not an orbit: it only turns when the orchestrator
    // says the machine is engaged. During assembly it spins into place.
    if (grooveRef.current) {
      grooveRef.current.rotation.z += step * core.ringSpeed * 0.45;
      grooveRef.current.position.z = toWorldSize(DEPTH.groove) * assembly;
    }
    if (wellRef.current) wellRef.current.position.z = toWorldSize(DEPTH.well) * assembly;
    if (bezelRef.current) bezelRef.current.position.z = toWorldSize(DEPTH.rim) * assembly;
    // Lit by state, never by a timer: an idle core keeps a dim structural glow
    // so it reads as a machine, and everything that means "working" is 0. The
    // ignition gate only dims that structural light during startup; it can never
    // invent brightness once the sequence is done.
    materials.bezel.emissiveIntensity = (0.04 + core.glow * 0.14) * (0.2 + ignition * 0.8);
    materials.housing.emissiveIntensity = (0.22 + core.energy * 0.26) * (0.35 + ignition * 0.65);
    if (energyRef.current) {
      // A single power-on beat, gone when the window closes: real activation,
      // not a permanent idle shimmer.
      const beat = Math.sin(activation * Math.PI);
      energyRef.current.material.opacity = core.energy * (0.1 + core.receive * 0.16) + beat * 0.22;
      energyRef.current.scale.setScalar(core.ringSpread * (0.86 + assembly * 0.14));
      energyRef.current.position.z = toWorldSize(DEPTH.energy) * assembly;
    }
    if (pulseRef.current) {
      // The receive pulse is gated on core.receive, which is only non-zero while
      // a chat run is actually reporting, so an idle machine never flashes.
      const breathe = 0.5 + Math.sin(time * 1.5) * 0.5;
      pulseRef.current.material.opacity = core.receive * (0.04 + breathe * 0.1);
      pulseRef.current.scale.setScalar(1 + core.receive * (0.015 + breathe * 0.04));
      pulseRef.current.position.z = toWorldSize(DEPTH.rim + 0.4) * assembly;
    }
    if (logoRef.current) {
      // Keep the plane transparent until the real logo bitmap is on it, so an
      // unfinished texture can never show as a coloured square.
      logoRef.current.material.opacity = logoTexture ? ignition : 0;
      logoRef.current.scale.setScalar(1 + core.receive * 0.03);
      logoRef.current.position.z = toWorldSize(DEPTH.logo) * assembly;
    }
    if (groupRef.current) {
      // The core carries the dimensional tilt and the pointer lean, both as
      // rotations about its own centre. Position is never written: the cable
      // anchors come from layout.center, and the camera is unrotated, so any
      // translation here would slide the painted housing off the ends of the
      // cables that plug into it.
      const lean = parallaxLean(parallaxRef.current, "core");
      groupRef.current.rotation.x = Math.sin(time * 0.3) * 0.035 + lean.x;
      groupRef.current.rotation.y = Math.cos(time * 0.24) * 0.05 + lean.y;
      groupRef.current.scale.setScalar(Math.max(0.0001, entranceScale(assembly)));
    }
  });

  return (
    <group ref={groupRef} scale={0.0001}>
      <mesh material={materials.housing} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[size * 0.47, size * 0.5, toWorldSize(DEPTH.housing), 72, 1]} />
      </mesh>
      <mesh ref={wellRef} material={materials.well} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[size * 0.372, size * 0.372, size * 0.016, 64]} />
      </mesh>
      <mesh ref={grooveRef} material={materials.groove}>
        <torusGeometry args={[size * 0.418, size * 0.0075, 8, 96]} />
      </mesh>
      <mesh ref={bezelRef} material={materials.bezel}>
        <torusGeometry args={[size * 0.487, size * 0.022, 18, 96]} />
      </mesh>
      <mesh ref={energyRef} material={materials.energy}>
        {/* A halo at the edge of the recess, not a filled disc: the logo needs
            dark metal behind it or the core reads as one flat blue button. Kept
            narrow for the same reason - a wide band is what turns the face into
            a speaker cone. */}
        <ringGeometry args={[size * 0.288, size * 0.352, 56]} />
      </mesh>
      <mesh ref={pulseRef} material={materials.pulse}>
        <ringGeometry args={[size * 0.458, size * 0.482, 64]} />
      </mesh>
      <mesh ref={logoRef} material={materials.logo}>
        {/* A circle, not a plane: the 2D layer clips the same bitmap with
            border-radius 50%, and a square plane shows the icon's tile corners. */}
        <circleGeometry args={[size * 0.17, 48]} />
      </mesh>
    </group>
  );
}
