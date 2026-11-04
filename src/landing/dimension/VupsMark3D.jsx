import React, { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { gsap } from "gsap";
import { useGSAP } from "@gsap/react";
import * as THREE from "three";
import { MARK_SIZE, PLATE_CORNER, PLATE_DEPTH, stemInlay } from "./markGeometry.js";
import {
  branchSolids,
  inlayTransform,
  plinthGeometry,
  plateGeometry,
  ringTransforms,
  seamGeometry
} from "./markBuild.js";
import {
  inlayMaterial,
  plateEdgeMaterial,
  plateMaterial,
  plinthMaterial,
  reliefMaterial,
  seamMaterial
} from "./dimensionMaterials.js";
import { D, EASE, STAGGER } from "../motion/motionTokens.js";

/* The Vups identity as a solid object.

   It is the shipped logo, extruded: the rounded plate keeps its orange face,
   the branch network and the four rings keep their coordinates and their
   charcoal ink, and the artwork's translucent centre stem becomes a shallow
   inlay. The only invention is the charcoal plinth the plate is mounted into,
   which is what gives the mark a place to sit in a lit room. No sphere stands
   in for the brand, and nothing here is a CSS transform pretending to be depth.

   `tile` and `glyph` let the stage hand the logo over to the ReactBits Metallic
   Paint surface: with both off, no solid is built and only the plate's group
   remains, so the chrome mark keeps the position and scale the plate would have
   had while the dark stage shows through behind it.
*/

gsap.registerPlugin(useGSAP);

export default function VupsMark({
  scale = 1,
  motion = true,
  paused = false,
  palette,
  position = [0, 0, 0],
  rotation = [0, 0, 0],
  glyph = true,
  tile = true,
  plateRef = null,
  onAssembled
} = {}) {
  const root = useRef(null);
  const plate = useRef(null);
  const plinth = useRef(null);
  const seam = useRef(null);
  const inlay = useRef(null);
  const branches = useRef([]);
  const rings = useRef([]);

  /* Only the solids that are actually drawn get built: when the metallic surface
     carries the logo the stage asks for neither the plate nor the ink, and an
     unused extrusion would still cost a buffer and a shader program. */
  const geometry = useMemo(
    () => ({
      plate: tile ? plateGeometry(scale) : null,
      plinth: tile ? plinthGeometry(scale) : null,
      seam: tile ? seamGeometry(scale * 0.98) : null,
      branches: glyph ? branchSolids(scale) : [],
      rings: glyph ? ringTransforms(scale) : [],
      inlay: glyph ? inlayTransform(scale) : null
    }),
    [scale, tile, glyph]
  );

  const materials = useMemo(
    () => ({
      plate: tile ? plateMaterial(palette) : null,
      plateEdge: tile ? plateEdgeMaterial(palette) : null,
      plinth: tile ? plinthMaterial(palette) : null,
      relief: glyph ? reliefMaterial(palette) : null,
      seam: tile ? seamMaterial(palette) : null,
      inlay: glyph ? inlayMaterial(palette, stemInlay().opacity) : null
    }),
    [palette, tile, glyph]
  );

  useEffect(
    () => () => {
      geometry.plate?.dispose();
      geometry.plinth?.dispose();
      geometry.seam?.dispose();
      for (const branch of geometry.branches) branch.geometry.dispose();
      materials.plate?.dispose();
      materials.plateEdge?.dispose();
      materials.plinth?.dispose();
      materials.relief?.dispose();
      materials.seam?.dispose();
      materials.inlay?.dispose();
    },
    [geometry, materials]
  );

  useGSAP(
    () => {
      const bodies = branches.current.filter(Boolean).map(node => node.scale);
      const ringsLive = rings.current.filter(Boolean).map(node => node.scale);
      const plateScale = plate.current?.scale;
      const plateShift = plate.current?.position;
      const plinthScale = plinth.current?.scale;
      const plinthShift = plinth.current?.position;
      const inlayScale = inlay.current?.scale;

      if (!motion) {
        // Reduced motion is not a broken animation: the mark simply arrives
        // assembled, and the copy beside it is already readable.
        for (const vector of [plateScale, plinthScale, inlayScale, ...bodies, ...ringsLive]) {
          if (vector) gsap.set(vector, { x: 1, y: 1, z: 1 });
        }
        if (plateShift) gsap.set(plateShift, { z: 0 });
        if (plinthShift) gsap.set(plinthShift, { y: 0 });
        if (materials.seam) gsap.set(materials.seam, { emissiveIntensity: 0.55 });
        onAssembled?.();
        return;
      }

      const tl = gsap.timeline({
        defaults: { duration: D.stage, ease: EASE },
        onComplete: () => onAssembled?.()
      });

      // GSAP's `scale` shorthand belongs to the DOM plugin. A three.js object
      // is tweened through its own Vector3, so every term here names the
      // concrete object being written rather than a CSS alias.
      if (tile) {
        tl.fromTo(plinthScale, { x: 0.72, y: 0.72, z: 0.72 }, { x: 1, y: 1, z: 1 }, 0)
          .fromTo(plinthShift, { y: -0.42 }, { y: 0 }, 0);
      }

      /* The plate group is tweened even when its solids are not mounted: it is
         the anchor the metallic surface is measured against, so the chrome mark
         arrives on the same curve the extruded logo would have. */
      tl.fromTo(plateScale, { x: 0.86, y: 0.86, z: 0.86 }, { x: 1, y: 1, z: 1 }, 0.16)
        .fromTo(plateShift, { z: -0.55 }, { z: 0 }, 0.16);

      /* A target list of nothing makes GSAP warn on every entrance, so the terms
         for solids the stage did not mount are left out entirely. */
      if (glyph) {
        tl.fromTo(
          bodies,
          { x: 0.001, y: 0.001, z: 0.001 },
          { x: 1, y: 1, z: 1, duration: 0.5, stagger: STAGGER.node },
          0.34
        )
          .fromTo(
            ringsLive,
            { x: 0.001, y: 0.001, z: 0.001 },
            { x: 1, y: 1, z: 1, duration: 0.52, stagger: STAGGER.node },
            0.52
          )
          .fromTo(inlayScale, { y: 0.001 }, { y: 1, duration: 0.46 }, 0.7);
      }

      if (tile) {
        tl.fromTo(
          materials.seam,
          { emissiveIntensity: 0 },
          { emissiveIntensity: 0.55, duration: 0.6, ease: "power2.out" },
          0.86
        );
      }

      return () => tl.kill();
    },
    { scope: root, dependencies: [motion, scale, glyph, tile] }
  );

  // The idle term is a breath, not a spin: the mark stays legible as the logo.
  useFrame(state => {
    if (paused || !root.current) return;
    if (!motion) return;
    const t = state.clock.elapsedTime;
    root.current.rotation.y = rotation[1] + Math.sin(t * 0.34) * 0.075;
    root.current.rotation.x = rotation[0] + Math.sin(t * 0.27 + 1.1) * 0.028;
    root.current.position.y = position[1] + Math.sin(t * 0.5) * 0.022;
  });

  return (
    <group ref={root} position={position} rotation={rotation}>
      {tile ? (
        <mesh ref={plinth} geometry={geometry.plinth} material={materials.plinth} position={[0, 0, -PLATE_DEPTH * scale * 0.9]} />
      ) : null}
      <group
        ref={node => {
          plate.current = node;
          if (plateRef) plateRef.current = node;
        }}
      >
        {/* ExtrudeGeometry groups the caps and the walls separately, so the face
            can carry the logo's own colour while the walls stay lit. */}
        {tile ? (
          <mesh geometry={geometry.plate} material={[materials.plate, materials.plateEdge]} />
        ) : null}
        {glyph
          ? geometry.branches.map((branch, index) => (
              <mesh
                key={branch.id}
                ref={node => {
                  branches.current[index] = node;
                }}
                geometry={branch.geometry}
                material={materials.relief}
                position={branch.position}
                rotation={branch.rotation}
              />
            ))
          : null}
        {glyph
          ? geometry.rings.map((ring, index) => (
              <mesh
                key={ring.id}
                ref={node => {
                  rings.current[index] = node;
                }}
                position={ring.position}
                material={materials.relief}
              >
                <torusGeometry args={[ring.radius, ring.tube, 14, 40]} />
              </mesh>
            ))
          : null}
        {glyph ? (
          <mesh ref={inlay} position={geometry.inlay.position} material={materials.inlay}>
            <boxGeometry args={[geometry.inlay.width, geometry.inlay.height, geometry.inlay.depth]} />
          </mesh>
        ) : null}
      </group>
      {tile ? (
        <mesh
          ref={seam}
          geometry={geometry.seam}
          material={materials.seam}
          position={[0, 0, -PLATE_DEPTH * scale * 0.42]}
        />
      ) : null}
    </group>
  );
}

export const MARK_METRICS = {
  size: MARK_SIZE,
  corner: PLATE_CORNER,
  depth: PLATE_DEPTH
};
