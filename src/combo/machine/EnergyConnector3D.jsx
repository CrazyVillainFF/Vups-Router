import { currentTheme, token } from "../../tokens.js";
import React, { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { DEPTH, PX_TO_WORLD, cableReveal, cableWidth, nodeEntrance, nodeModel, startupPhase, toWorldSize, wireAnchorsFor, wireStretch } from "../comboScene.js";
import { additive } from "./apexMaterials.js";

// The cable palette. Each value answers one reported fact, and the difference
// between them has to survive a dark stage at one or two pixels wide, which the
// previous near-black token("surface") did not.
//
// Resolved per theme rather than at module load: a frame loop that read a
// constant frozen at import time would keep painting the previous palette after
// the user switched, and this object is touched every frame.
let wireCache = { theme: null, colors: null };
function wirePalette() {
  const theme = currentTheme();
  if (!wireCache.colors || wireCache.theme !== theme) {
    wireCache = {
      theme,
      colors: {
        idle: token("border-strong"),
        linked: token("muted"),
        live: token("accent"),
        blocked: token("error")
      }
    };
  }
  return wireCache.colors;
}

// Quadratic bezier sampled straight into a preallocated buffer: the curve is
// rebuilt every frame while dragging without ever allocating.
function sampleCurve(entry, layout, segments, out) {
  const { start, end } = wireAnchorsFor(entry, layout);
  const cx = entry.wire.x;
  const cy = entry.wire.y;
  const scale = PX_TO_WORLD;
  const ox = layout.center.x;
  const oy = layout.center.y;
  for (let i = 0; i <= segments; i += 1) {
    // t runs core -> provider in curve parameter space; energy reads the
    // buffer backwards, which is the provider -> core receive direction.
    const t = i / segments;
    const mt = 1 - t;
    const px = mt * mt * start.x + 2 * mt * t * cx + t * t * end.x;
    const py = mt * mt * start.y + 2 * mt * t * cy + t * t * end.y;
    out[i * 2] = (px - ox) * scale;
    out[i * 2 + 1] = -(py - oy) * scale;
  }
  return out;
}

function ribbonGeometry(segments) {
  const geometry = new THREE.BufferGeometry();
  const count = (segments + 1) * 2;
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  const index = new Uint16Array(segments * 6);
  for (let i = 0; i < segments; i += 1) {
    const a = i * 2;
    index.set([a, a + 1, a + 2, a + 2, a + 1, a + 3], i * 6);
  }
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 100);
  return geometry;
}

function paintRibbon(geometry, curve, segments, width, z, reveal) {
  const attribute = geometry.getAttribute("position");
  const last = segments;
  // The connection phase mills each cable outward from the core, so everything
  // past the leading sample is pinned onto that point: the tail collapses to
  // zero area instead of showing stale coordinates.
  const leading = Math.max(1, Math.round(last * Math.min(1, Math.max(0, reveal))));
  for (let i = 0; i <= last; i += 1) {
    const at = Math.min(i, leading) * 2;
    const x = curve[at];
    const y = curve[at + 1];
    const previous = Math.max(0, Math.min(i, leading) - 1) * 2;
    const next = Math.min(last, Math.min(i, leading) + 1) * 2;
    let tx = curve[next] - curve[previous];
    let ty = curve[next + 1] - curve[previous + 1];
    const length = Math.hypot(tx, ty) || 1;
    tx /= length;
    ty /= length;
    // A cable is a conduit: it keeps an almost constant width along the span and
    // swells slightly where it enters each housing. The old profile did the
    // opposite - it pinched at both ends, which read as a thread cut short
    // rather than as a wire soldered to two parts.
    const edge = Math.sin((Math.min(i, leading) / last) * Math.PI);
    const half = width * (1.06 - 0.2 * edge) * 0.5;
    attribute.setXYZ(i * 2, x - ty * half, y + tx * half, z);
    attribute.setXYZ(i * 2 + 1, x + ty * half, y - tx * half, z);
  }
  attribute.needsUpdate = true;
}

// One component owns every cable so a single frame loop updates all ribbons and
// all pulses; ten active providers still cost a handful of draw calls.
export default function EnergyConnector3D({ layout, nodes, entriesRef, statesRef, quality, startupRef }) {
  const curveRef = useRef(new Float32Array((quality.segments + 1) * 2));
  const timeRef = useRef(0);
  const dummyRef = useRef(new THREE.Object3D());
  const pulseRef = useRef(null);
  const capacity = Math.max(1, nodes.length * quality.pulses);

  const built = useMemo(() => nodes.map(() => ({
    body: ribbonGeometry(quality.segments),
    stream: ribbonGeometry(quality.segments)
  })), [nodes, quality.segments]);

  const materials = useMemo(() => nodes.map(() => ({
    // Ribbons are rebuilt in place every frame and carry no normals, so the
    // cable body is unlit; the additive stream layering on top is the shading cue.
    // toneMapped:false keeps the chosen conduit colour off the filmic curve,
    // which was grading a two-pixel line straight back into the background.
    body: new THREE.MeshBasicMaterial({ color: wirePalette().idle, toneMapped: false }),
    stream: additive(token("accent"), 0)
  })), [nodes]);

  const pulseMaterial = useMemo(() => additive(token("accent"), 0.9), []);
  const pulseGeometry = useMemo(() => new THREE.SphereGeometry(1, 8, 8), []);

  useEffect(() => () => {
    for (const cable of built) {
      cable.body.dispose();
      cable.stream.dispose();
    }
    for (const cable of materials) {
      cable.body.dispose();
      cable.stream.dispose();
    }
    pulseGeometry.dispose();
    pulseMaterial.dispose();
  }, [built, materials, pulseGeometry, pulseMaterial]);

  useFrame((state, delta) => {
    const curve = curveRef.current;
    const dummy = dummyRef.current;
    timeRef.current += Math.min(0.05, delta);
    const time = timeRef.current;
    const discovery = startupPhase(startupRef.current, "discovery");
    const connection = cableReveal(startupPhase(startupRef.current, "connection"));
    const wire = wirePalette();
    let slot = 0;
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      const entry = entriesRef.current.get(node.key);
      const cable = built[i];
      const cableMaterial = materials[i];
      if (!entry || !cable || !cableMaterial) continue;
      const visual = statesRef.current.get(node.key) || nodeModel({});
      // A cable follows the node it belongs to, so the two sweeps have to share
      // the same clock: no wire may reach toward a housing that has not arrived.
      const arrival = nodeEntrance(discovery, i, nodes.length);
      const reveal = Math.min(connection, Math.max(0, arrival));
      sampleCurve(entry, layout, quality.segments, curve);
      const joined = reveal >= 0.999;
      const transmitting = visual.stream && joined;
      const baseWidth = cableWidth(layout.nodeRadius, wireStretch(entry, layout));
      const width = baseWidth * (visual.blocked ? 0.76 : 1);
      paintRibbon(cable.body, curve, quality.segments, width, 0, reveal);
      paintRibbon(cable.stream, curve, quality.segments, width * 0.56, toWorldSize(DEPTH.cable), reveal);
      // Three reported facts, three looks: answering right now, verified
      // available but quiet, and proved not working. A cable that has not
      // finished its own entrance never takes the lit colour, so no wire can
      // claim a connection the machine has not made yet.
      cableMaterial.body.color.set(
        transmitting
          ? wire.live
          : visual.blocked
            ? wire.blocked
            : visual.linked && joined
              ? wire.linked
              : wire.idle
      );
      cableMaterial.stream.opacity = transmitting ? 0.46 + visual.emissive * 0.26 : visual.linked && joined ? 0.11 : 0;

      for (let pulse = 0; pulse < quality.pulses; pulse += 1) {
        if (slot >= capacity) break;
        if (!visual.stream || !joined) {
          dummy.position.set(0, 0, -9999);
          dummy.scale.setScalar(0.0001);
        } else {
          const phase = (time / (1.9 + (i % 4) * 0.28) + pulse / quality.pulses + (i % 7) * 0.13) % 1;
          // Walking the buffer from the provider end toward the core.
          const sample = Math.round(phase * quality.segments);
          const x = curve[(quality.segments - sample) * 2];
          const y = curve[(quality.segments - sample) * 2 + 1];
          dummy.position.set(x, y, toWorldSize(DEPTH.cable));
          const head = 0.6 + Math.sin(phase * Math.PI) * 0.45;
          dummy.scale.setScalar(toWorldSize(layout.nodeRadius) * 0.085 * head * (0.75 + visual.emissive * 0.4));
        }
        dummy.updateMatrix();
        pulseRef.current?.setMatrixAt(slot, dummy.matrix);
        slot += 1;
      }
    }
    const mesh = pulseRef.current;
    if (!mesh) return;
    for (; slot < capacity; slot += 1) {
      dummy.position.set(0, 0, -9999);
      dummy.scale.setScalar(0.0001);
      dummy.updateMatrix();
      mesh.setMatrixAt(slot, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  });

  return (
    <group>
      {nodes.map((node, index) => (
        <group key={node.key}>
          <mesh geometry={built[index].body} material={materials[index].body} frustumCulled={false} />
          <mesh geometry={built[index].stream} material={materials[index].stream} frustumCulled={false} />
        </group>
      ))}
      <instancedMesh ref={pulseRef} args={[pulseGeometry, pulseMaterial, capacity]} frustumCulled={false} />
    </group>
  );
}
