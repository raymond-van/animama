import * as THREE from "three";

import type { Avatar } from "@/lib/avatar";
import { installAvatarShaderRendering } from "@/lib/avatar/toon-shader/applyAvatarShader";
import {
  DEFAULT_SCENE_LIGHTS,
  buildSceneCameraPreset,
  type SceneCameraPreset,
} from "@/ui/main/canvas/sceneCameraPresets";

/*
 * Stage and effect parsing shared by the review renderer (`render.ts`), the
 * frame-cost benchmark (`../effect-bench/bench.ts`), the headed preview
 * (`../animation-preview/preview.ts`) and the Action reel recorder
 * (`../animation-reel/reel.ts`).
 */

export {
  effectSourceEntry as effectEntry,
  type EffectSource,
} from "@/lib/avatar/vfx/effectSource";

/** Tone mapping and colour output of the chat canvas (React Three Fiber defaults in `Scene.tsx`). */
export function applyChatColorPipeline(renderer: THREE.WebGLRenderer): void {
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

/** Where a camera stands, the point it looks at and its vertical field of view. */
export type Framing = {
  position: THREE.Vector3;
  target: THREE.Vector3;
  fov: number;
};

/** The chat's Portrait camera preset for `avatar` in its current pose. */
export function chatPortraitFraming(avatar: Avatar): Framing {
  return chatCameraFraming(avatar, "portrait");
}

/** A chat camera preset for `avatar` in its current pose. */
export function chatCameraFraming(
  avatar: Avatar,
  preset: SceneCameraPreset,
): Framing {
  const { position, orbitTarget, fov } = buildSceneCameraPreset(preset, {
    avatar,
  }).settings;
  return {
    position: new THREE.Vector3(position.x, position.y, position.z),
    target: new THREE.Vector3(orbitTarget.x, orbitTarget.y, orbitTarget.z),
    fov,
  };
}

/** Add the chat canvas's default scene lights to `scene`. */
export function addChatLights(scene: THREE.Scene): void {
  scene.add(
    new THREE.AmbientLight(0xffffff, DEFAULT_SCENE_LIGHTS.ambientIntensity),
  );
  for (const light of DEFAULT_SCENE_LIGHTS.directional) {
    const directional = new THREE.DirectionalLight(0xffffff, light.intensity);
    directional.position.set(...light.position);
    scene.add(directional);
  }
}

/**
 * A renderer, scene and camera configured like the chat canvas (`Scene.tsx`):
 * antialiasing, ACES Filmic, sRGB output, the default scene lights, a
 * transparent clear and no stencil buffer. `pixelRatio` 1 keeps review sheets
 * at their tile size; the benchmark uses the chat's DPR.
 */
export function createStage(
  width: number,
  height: number,
  options: {
    pixelRatio?: number;
    preserveDrawingBuffer?: boolean;
    powerPreference?: WebGLPowerPreference;
  } = {},
) {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    stencil: false,
    preserveDrawingBuffer: options.preserveDrawingBuffer ?? true,
    ...(options.powerPreference
      ? { powerPreference: options.powerPreference }
      : {}),
  });
  renderer.setPixelRatio(options.pixelRatio ?? 1);
  renderer.setSize(width, height);
  applyChatColorPipeline(renderer);
  renderer.setClearColor(0x000000, 0);
  // Extra passes for an `--avatar-shader` override. The Avatar load awaits the
  // same shader module, so they are installed before the first frame.
  void installAvatarShaderRendering(renderer);
  const scene = new THREE.Scene();
  addChatLights(scene);
  const camera = new THREE.PerspectiveCamera(35, width / height, 0.01, 20);
  return { renderer, scene, camera };
}
