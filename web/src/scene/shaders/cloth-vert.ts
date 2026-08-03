/**
 * Cloth vertex shader. Two analytic rest shapes as functions of uv —
 * a taut streamer (freefall) and a hemisphere canopy (after the pull) —
 * blended per-vertex so the apex morphs first and the skirt blooms last.
 * Everything is analytic in uv, which is what lets us recompute honest
 * normals by finite differences after displacement.
 */

import { noiseGlsl } from "./noise.js";

export const clothVert = /* glsl */ `
uniform float uTime;
uniform float uMorph;
uniform float uTurbulence;
uniform float uArrest;

varying vec3 vNormal;
varying vec3 vViewDir;
varying vec2 vUv;
varying float vMorph;

${noiseGlsl}

// Freefall rest shape: a narrow ribbon trailing upward, tapered at the top.
vec3 basePlane(vec2 st) {
  float taper = mix(1.0, 0.55, st.y);
  float x = (st.x - 0.5) * 0.42 * taper;
  float y = (st.y - 0.5) * 2.3;
  return vec3(x, y, 0.0);
}

// Canopy rest shape: hemisphere opening downward, apex up. st.y=1 is apex.
vec3 baseCanopy(vec2 st) {
  float theta = st.x * 6.28318530718;
  float phi = (1.0 - st.y) * 1.35 + 0.06; // apex hole tiny, skirt flares wide
  float r = 1.05;
  return vec3(
    r * sin(phi) * cos(theta),
    r * cos(phi) + 0.15,
    r * sin(phi) * sin(theta)
  );
}

// Per-vertex morph: the apex (st.y=1) leads, the skirt follows.
float localMorph(vec2 st) {
  float fromApex = 1.0 - st.y;
  return smoothstep(0.0, 1.0, clamp(uMorph * 1.6 - fromApex * 0.6, 0.0, 1.0));
}

vec3 displaced(vec2 st) {
  float m = localMorph(st);
  vec3 pos = mix(basePlane(st), baseCanopy(st), m);

  // Freefall flutter: curl noise, fast when scrolling fast, calm under canopy.
  float flow = uTime * (0.55 + uTurbulence * 1.6);
  vec3 n = curlNoise(pos * 2.1 + vec3(0.0, flow, 0.0));
  float amp = (0.05 + 0.24 * uTurbulence) * (1.0 - 0.85 * m);

  // The arrest: one violent damped kick through the whole fabric.
  amp += uArrest * 0.32 * sin(st.y * 9.0 - uTime * 22.0);

  return pos + n * amp;
}

void main() {
  vUv = uv;
  vMorph = localMorph(uv);

  vec3 pos = displaced(uv);

  // Honest normals: finite differences in uv-space over the displaced surface.
  const float e = 0.012;
  vec3 tangentU = displaced(uv + vec2(e, 0.0)) - displaced(uv - vec2(e, 0.0));
  vec3 tangentV = displaced(uv + vec2(0.0, e)) - displaced(uv - vec2(0.0, e));
  vNormal = normalize(normalMatrix * normalize(cross(tangentU, tangentV)));

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  vViewDir = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`;
