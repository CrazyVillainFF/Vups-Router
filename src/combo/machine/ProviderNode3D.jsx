import { token } from "../../tokens.js";
import React, { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { DEPTH, entranceScale, nodeEntrance, nodeModel, startupPhase, toWorld, toWorldSize } from "../comboScene.js";
import { additive, metal } from "./apexMaterials.js";
import useMarkTexture from "./useMarkTexture.js";

// One provider housing. The position comes from the DOM elastic layer through
// `entriesRef`, the state comes from what the run actually reported through
// `statesRef`, and the arrival sweep comes from the shared startup driver - this
// component decides nothing on its own and owns no animation of its own.
function NodeUnit({ node, index, total, layout, entriesRef, statesRef, interactionRef, startupRef, selected, texture }) {
  const groupRef = useRef(null);
  const materials = useMemo(() => ({
    // Brushed, not mirrored. A low-roughness metal on a small housing throws the
    // studio's one bright stop across a third of the ring as a hard blue crescent,
    // which is what made an idle node read as a glowing blob instead of a part.
    housing: metal(token("bg"), 0.5, 0.6),
    face: metal(token("bg"), 0.56, 0.3),
    rim: metal(token("surface-2"), 0.42, 0.74, { emissive: token("accent"), emissiveIntensity: 0.08 }),
    // A basic material with no map yet renders as a solid white plate, so the
    // mark stays invisible until its texture has actually been rasterised.
    mark: new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, toneMapped: false }),
    // The live ring is the only emissive element on a node, and it is driven
    // purely by what the run reported for this provider.
    live: additive(token("accent"), 0),
    // The selection ring is the one thing only the user decides: which provider
    // the library is currently showing. It never means "working".
    select: additive(token("accent"), 0)
  }), []);

  useEffect(() => {
    if (!texture) return;
    materials.mark.map = texture;
    materials.mark.opacity = 1;
    materials.mark.needsUpdate = true;
  }, [texture, materials]);

  useEffect(() => () => {
    for (const material of Object.values(materials)) material.dispose();
  }, [materials]);

  const radius = toWorldSize(layout.nodeRadius);

  useFrame(() => {
    const group = groupRef.current;
    const entry = entriesRef.current.get(node.key);
    if (!group || !entry) return;
    const world = toWorld(entry.node.x, entry.node.y, layout);
    group.position.set(world.x, world.y, 0);
    const arrival = nodeEntrance(
      startupPhase(startupRef.current, "discovery"),
      index,
      total
    );
    // Nodes rise the last fraction of a housing height into the plane instead of
    // popping in flat, which is what gives the sweep depth.
    group.position.z = world.z + (1 - arrival) * -radius * 0.6;
    const visual = statesRef.current.get(node.key) || nodeModel({});
    const interactive = interactionRef.current.hovered === node.key || interactionRef.current.focused === node.key;
    group.scale.setScalar(Math.max(
      0.0001,
      entranceScale(arrival) * visual.scale * (interactive ? 1.05 : 1) * (selected ? 1.06 : 1)
    ));
    materials.rim.emissiveIntensity = (0.03 + visual.rim * 0.13) * arrival;
    materials.housing.emissive.set(token("accent"));
    materials.housing.emissiveIntensity = visual.emissive * 0.2 * arrival;
    materials.live.opacity = visual.halo * 0.42 * arrival;
    materials.select.opacity = (selected ? 0.5 : 0) * arrival;
    if (texture) materials.mark.opacity = arrival;
  });

  return (
    <group ref={groupRef} scale={0.0001}>
      <mesh material={materials.housing} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[radius * 0.96, radius, toWorldSize(DEPTH.node), 44, 1]} />
      </mesh>
      <mesh material={materials.face} rotation={[Math.PI / 2, 0, 0]} position={[0, 0, toWorldSize(DEPTH.nodeFace)]}>
        <cylinderGeometry args={[radius * 0.84, radius * 0.84, radius * 0.02, 44]} />
      </mesh>
      <mesh material={materials.mark} position={[0, 0, toWorldSize(DEPTH.nodeMark)]}>
        <planeGeometry args={[radius * 1.46, radius * 1.46]} />
      </mesh>
      <mesh material={materials.rim} position={[0, 0, toWorldSize(DEPTH.nodeRim)]}>
        <torusGeometry args={[radius * 0.97, radius * 0.05, 12, 52]} />
      </mesh>
      <mesh material={materials.live} position={[0, 0, toWorldSize(DEPTH.nodeRim + 0.4)]}>
        <ringGeometry args={[radius * 1.02, radius * 1.11, 44]} />
      </mesh>
      <mesh material={materials.select} position={[0, 0, toWorldSize(DEPTH.nodeRim + 0.7)]}>
        <ringGeometry args={[radius * 1.15, radius * 1.21, 44]} />
      </mesh>
    </group>
  );
}

// The provider mark is a texture, so it is resolved in React state one level
// above the frame loop and then handed down.
export default function ProviderNode3D({ node, index, total, selected, layout, entriesRef, statesRef, interactionRef, startupRef }) {
  const texture = useMarkTexture(node.provider.artwork);
  return (
    <NodeUnit
      node={node}
      index={index}
      total={total}
      selected={selected}
      layout={layout}
      entriesRef={entriesRef}
      statesRef={statesRef}
      interactionRef={interactionRef}
      startupRef={startupRef}
      texture={texture}
    />
  );
}
