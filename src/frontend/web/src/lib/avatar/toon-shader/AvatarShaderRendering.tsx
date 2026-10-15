import { useEffect } from "react";
import { useThree } from "@react-three/fiber";

import { installAvatarShaderRendering } from "./applyAvatarShader";
import { useAvatarShaderStore } from "./avatarShader";

/** Mount inside a Canvas whose Avatar should draw the active shader's extra passes. */
export function AvatarShaderRendering() {
  const gl = useThree((state) => state.gl);
  const shader = useAvatarShaderStore((state) => state.shader);

  useEffect(() => {
    if (shader !== "liltoon") return;
    let release: (() => void) | null = null;
    let cancelled = false;
    void installAvatarShaderRendering(gl).then((next) => {
      if (cancelled) next();
      else release = next;
    });
    return () => {
      cancelled = true;
      release?.();
    };
  }, [gl, shader]);

  return null;
}
