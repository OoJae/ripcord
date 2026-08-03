/**
 * The cloth: one subdivided plane, one ShaderMaterial. Geometry density obeys
 * the perf budget (128×128 desktop, 96 mobile); both rest shapes live in the
 * vertex shader, so the geometry itself is just a uv lattice.
 */

import { Color, DoubleSide, Mesh, PlaneGeometry, ShaderMaterial } from "three";
import { clothFrag } from "./shaders/cloth-frag.js";
import { clothVert } from "./shaders/cloth-vert.js";

export interface Cloth {
  mesh: Mesh;
  uniforms: {
    uTime: { value: number };
    uMorph: { value: number };
    uTurbulence: { value: number };
    uArrest: { value: number };
    uOpacity: { value: number };
    uGridScale: { value: number };
    uColorSilk: { value: Color };
    uColorHandle: { value: Color };
    uColorPhosphor: { value: Color };
  };
}

export function createCloth(): Cloth {
  const segments = window.innerWidth < 768 ? 96 : 128;
  const geometry = new PlaneGeometry(1, 1, segments, segments);

  const uniforms: Cloth["uniforms"] = {
    uTime: { value: 0 },
    uMorph: { value: 0 },
    uTurbulence: { value: 0 },
    uArrest: { value: 0 },
    uOpacity: { value: 1 },
    uGridScale: { value: 42 },
    uColorSilk: { value: new Color("#edeae3") },
    uColorHandle: { value: new Color("#ff4f00") },
    uColorPhosphor: { value: new Color("#7cf5c4") },
  };

  const material = new ShaderMaterial({
    vertexShader: clothVert,
    fragmentShader: clothFrag,
    uniforms,
    side: DoubleSide,
    transparent: true,
  });

  const mesh = new Mesh(geometry, material);
  return { mesh, uniforms };
}
