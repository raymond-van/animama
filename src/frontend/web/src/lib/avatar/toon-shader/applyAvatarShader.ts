import type { WebGLRenderer } from "three";
import type { VRM } from "@pixiv/three-vrm";

import { getActiveAvatarShader } from "./avatarShader";

/*
 * `import.meta.env.DEV` keeps lilToon out of production bundles: the dynamic
 * imports below are dead code there, so Rollup emits no lilToon chunk.
 */

/** Apply the active shader's material changes to a freshly loaded VRM. */
export async function applyAvatarShader(vrm: VRM): Promise<void> {
  if (import.meta.env.DEV && getActiveAvatarShader() === "liltoon") {
    const { convertVrmToLilToon } = await import("./lilToon");
    convertVrmToLilToon(vrm);
  }
}

/**
 * Install the active shader's renderer passes (lilToon outlines). Returns a
 * release function; a no-op for MToon.
 */
export async function installAvatarShaderRendering(
  renderer: WebGLRenderer,
): Promise<() => void> {
  if (import.meta.env.DEV && getActiveAvatarShader() === "liltoon") {
    const { enableLilToonRendering } = await import("./lilToon");
    return enableLilToonRendering(renderer);
  }
  return () => {};
}
