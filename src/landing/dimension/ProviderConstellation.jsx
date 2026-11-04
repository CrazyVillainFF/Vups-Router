import React, { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { paletteFor } from "../../tokens.js";
import { constellationNodes } from "./constellationData.js";
import { junctionWorld } from "./markBuild.js";
import { PLATE_DEPTH } from "./markGeometry.js";
import { cableDraw } from "./stagePose.js";
import {
  cableMaterial,
  disposeMaterials,
  nodeMaterial,
  portMaterial,
  pulseMaterial
} from "./dimensionMaterials.js";

/* The provider network as geometry.

   Every housing in the ring is one entry from the shipped registry, placed on
   the arc its category owns, and every cable is a real tube running from the
   mark's own junction point to that housing. The cables are drawn by scroll —
   `setDrawRange` over the tube's own index buffer — so the network is built in
   front of the reader rather than faded in.

   The network carries no text at any viewport. A ring of 37 names printed at
   7° apart is unreadable anyway, and the DOM roster beside this scene already
   lists every one of them.

   There is no traffic to show. A bead travels a cable to render the word
   "routing" and nothing else, and the copy beside this scene says so in those
   terms. */

const TUBE_SEGMENTS = 44;
const TUBE_RADIAL = 6;
const TUBE_RADIUS = 0.008;
const HOUSING_SIZE = [0.3, 0.3, 0.09];
const BEAD_COUNT = 9;

/* Cables leave from behind the plinth, not from the relief on the plate face.
   Anchored in front, every run to a near-side housing crossed the orange face
   and the mark stopped reading as the logo. */
const CABLE_EXIT_Z = -PLATE_DEPTH * 2.4;

function cableCurve(anchor, node) {
  const exit = new THREE.Vector3(anchor.x, anchor.y, CABLE_EXIT_Z);
  const radial = new THREE.Vector2(node.x, node.y);
  if (radial.lengthSq() > 0) radial.normalize();
  const mid = new THREE.Vector3(
    (exit.x + node.x) / 2 + radial.x * 0.34,
    (exit.y + node.y) / 2 + radial.y * 0.34,
    Math.min(exit.z, node.z) - 0.5
  );
  return new THREE.CatmullRomCurve3(
    [exit, mid, node.clone()],
    false,
    "catmullrom",
    0.32
  );
}

export default function ProviderConstellation({
  pose,
  theme = "dark",
  motion = true,
  parallax = true,
  limitPerGroup = Infinity
}) {
  const beads = useRef(null);
  const housings = useRef([]);
  const ports = useRef([]);

  const nodes = useMemo(() => constellationNodes({ limitPerGroup }), [limitPerGroup]);

  const palette = paletteFor(theme);

  const built = useMemo(() => {
    const anchor = junctionWorld(1);
    const housing = new RoundedBoxGeometry(
      HOUSING_SIZE[0],
      HOUSING_SIZE[1],
      HOUSING_SIZE[2],
      2,
      0.035
    );
    const port = new THREE.BoxGeometry(HOUSING_SIZE[0] * 0.6, 0.02, 0.014);
    const bead = new THREE.SphereGeometry(1, 10, 10);
    const cables = nodes.map((node, index) => {
      const position = new THREE.Vector3(node.slot.x, node.slot.y, node.slot.z);
      /* The port sits on the face of its housing, which is turned toward the
         mark, so the offset is rotated by the same angle as the plate. */
      const normal = new THREE.Vector3(0, 0, HOUSING_SIZE[2] / 2 + 0.008).applyAxisAngle(
        new THREE.Vector3(0, 1, 0),
        -node.slot.angle
      );
      const curve = cableCurve(anchor, position);
      const geometry = new THREE.TubeGeometry(
        curve,
        TUBE_SEGMENTS,
        TUBE_RADIUS,
        TUBE_RADIAL,
        false
      );
      return {
        id: node.id,
        index,
        curve,
        geometry,
        position,
        portPosition: position.clone().add(normal),
        count: geometry.index.count,
        rotation: [0, -node.slot.angle, 0]
      };
    });
    return { anchor, housing, port, bead, cables, draw: new Float32Array(nodes.length) };
  }, [nodes]);

  const materials = useMemo(
    () => ({
      node: nodeMaterial(palette),
      cable: cableMaterial(palette),
      port: portMaterial(palette),
      pulse: pulseMaterial(palette)
    }),
    [palette]
  );

  useEffect(
    () => () => {
      built.housing.dispose();
      built.port.dispose();
      built.bead.dispose();
      for (const cable of built.cables) cable.geometry.dispose();
      disposeMaterials(Object.values(materials));
    },
    [built, materials]
  );

  const scratch = useMemo(
    () => ({ matrix: new THREE.Object3D(), point: new THREE.Vector3() }),
    []
  );

  useFrame(state => {
    /* The stage writes the current pose onto the same ref it is handed, so the
       reveal always comes from the scroll position. Before that first write the
       network is un-drawn: a default of 1 would paint the whole bundle behind
       the hero mark on frame one. */
    const reveal = pose?.current?.value?.reveal ?? 0;

    for (let index = 0; index < built.cables.length; index += 1) {
      const cable = built.cables[index];
      const target = cableDraw(reveal, index, built.cables.length);
      /* Slight smoothing keeps the draw reading as paint rather than as a
         readout of the scrollbar, and costs one float per cable. */
      built.draw[index] += (target - built.draw[index]) * 0.16;
      cable.geometry.setDrawRange(0, Math.floor(cable.count * built.draw[index]));
      /* A housing and its port belong to a cable. Left at full size they would
         stand in the hero as a scatter of orange slivers before the network has
         been asked for, so they arrive on the same value that draws the tube. */
      const lift = Math.min(1, built.draw[index] * 1.4);
      const housing = housings.current[index];
      if (housing) housing.scale.setScalar(Math.max(0.0001, lift));
      const port = ports.current[index];
      if (port) port.scale.setScalar(Math.max(0.0001, lift));
    }

    if (beads.current && motion) {
      const time = state.clock.elapsedTime;
      for (let index = 0; index < BEAD_COUNT; index += 1) {
        const cable =
          built.cables[Math.min(built.cables.length - 1, Math.floor((index / BEAD_COUNT) * built.cables.length))];
        if (!cable) continue;
        const phase = (time * 0.15 + index * 0.137) % 1;
        cable.curve.getPoint(phase, scratch.point);
        scratch.matrix.position.copy(scratch.point);
        /* The bead only exists on a cable that has already been drawn past, so
           it never appears ahead of the line it is travelling along. */
        scratch.matrix.scale.setScalar(built.draw[cable.index] > phase ? 0.03 : 0.0001);
        scratch.matrix.updateMatrix();
        beads.current.setMatrixAt(index, scratch.matrix.matrix);
      }
      beads.current.instanceMatrix.needsUpdate = true;
    }
  });

  return (
    <group>
      {built.cables.map((cable, index) => (
        <group key={cable.id}>
          <mesh geometry={cable.geometry} material={materials.cable} frustumCulled={false} />
          <mesh
            ref={node => {
              housings.current[index] = node;
            }}
            geometry={built.housing}
            material={materials.node}
            position={cable.position}
            rotation={cable.rotation}
          />
          <mesh
            ref={node => {
              ports.current[index] = node;
            }}
            geometry={built.port}
            material={materials.port}
            position={cable.portPosition}
            rotation={cable.rotation}
          />
        </group>
      ))}
      <instancedMesh
        ref={beads}
        args={[built.bead, materials.pulse, BEAD_COUNT]}
        frustumCulled={false}
      />
    </group>
  );
}
