/**
 * Cloth fragment shader — blaze-orange silk with a procedural ripstop grid.
 * The grid is the brand texture: the fabric woven to arrest a tear. Fresnel
 * rim lifts toward silk-white; after the pull a faint phosphor graze reads
 * as the altimeter's "safe" light catching the canopy.
 */

export const clothFrag = /* glsl */ `
uniform vec3 uColorSilk;
uniform vec3 uColorHandle;
uniform vec3 uColorPhosphor;
uniform float uGridScale;
uniform float uOpacity;

varying vec3 vNormal;
varying vec3 vViewDir;
varying vec2 vUv;
varying float vMorph;

// Anti-aliased grid line mask at a given scale.
float grid(vec2 st, float scale, float width) {
  vec2 g = abs(fract(st * scale) - 0.5);
  vec2 fw = fwidth(st * scale);
  vec2 lines = 1.0 - smoothstep(vec2(0.0), fw * width, g);
  return max(lines.x, lines.y);
}

void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(vViewDir);
  float facing = abs(dot(n, v));
  float fresnel = pow(1.0 - facing, 2.5);

  // Deep-shadow orange body, lit by facing angle.
  vec3 shadow = uColorHandle * 0.16;
  vec3 body = mix(shadow, uColorHandle, 0.35 + 0.65 * facing);

  // Ripstop: fine weave + coarse reinforcement boxes, low contrast.
  float fine = grid(vUv, uGridScale, 1.1);
  float coarse = grid(vUv, uGridScale / 8.0, 1.6);
  body *= 1.0 - fine * 0.10;
  body = mix(body, body + uColorSilk * 0.06, coarse);

  // Silk rim; under canopy, a phosphor graze joins it.
  body += uColorSilk * fresnel * 0.38;
  body += uColorPhosphor * fresnel * vMorph * 0.22;

  gl_FragColor = vec4(body, uOpacity);
}
`;
