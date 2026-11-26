import type { ItemRevisionRef } from "@animama/runtime-contracts/api-types";
import { useThree } from "@react-three/fiber";
import { useCallback, type RefObject } from "react";
import { PerspectiveCamera } from "three";

import type { Avatar } from "@/lib/avatar";
import { useSaveAvatarPortrait } from "@/query/mutations/useSaveAvatarPortrait";
import { useCreationPortraitCapture } from "@/ui/create-anima/createAnimaPortrait";

/**
 * Capture a new portrait for the Dock's Avatar when its preview target asks
 * for one (`portraitRetake`, set by the Library for a Local Avatar whose
 * portrait shows another revision). It follows the Create Anima stage's
 * rules: only the exact revision on screen, only at rest, once per revision
 * per page session, and it never blocks or reports into the Dock.
 */
export function useDockPortraitRetake({
  avatarRef,
  ready,
  shown,
  retake,
}: {
  avatarRef: RefObject<Avatar | null>;
  /** The model has loaded and the preview is showing it at rest. */
  ready: boolean;
  /** The Avatar item and revision the Dock has loaded. */
  shown: ItemRevisionRef | null;
  retake: ItemRevisionRef | null;
}): void {
  const { gl, scene } = useThree();
  const save = useSaveAvatarPortrait();
  const capture = useCallback(
    async (signal: AbortSignal) => {
      const avatar = avatarRef.current;
      if (!avatar) throw new Error("The Avatar left the preview.");
      const { captureAvatarPortrait } = await import("@/lib/avatar/portrait");
      // A front camera, so the owner's orbit does not turn the portrait.
      return captureAvatarPortrait({
        avatar,
        renderer: gl,
        scene,
        camera: new PerspectiveCamera(),
        signal,
      });
    },
    [avatarRef, gl, scene],
  );
  useCreationPortraitCapture({
    ready,
    source: shown,
    target: retake,
    capture,
    save,
  });
}
