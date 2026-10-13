import { lazy, Suspense, useEffect } from "react";

import { useAnimaAnimationDebugStore } from "@/stores/anima-animation-debug-store";
import { useLipSyncDebugStore } from "@/stores/lipsync-debug-store";
import { isAnimaDebugSectionAvailable } from "./animaDebugPanelConfig";

const AnimaDebugPanel = lazy(() =>
  import("./AnimaDebugPanel").then((module) => ({
    default: module.AnimaDebugPanel,
  })),
);

/** Keep the inspector and its dependencies unloaded until its panel opens. */
export default function SceneDebugPanel() {
  const isOpen = useAnimaAnimationDebugStore((state) => state.isOpen);

  // The panel closes on any outside click, such as typing a message, so the
  // Lip-sync view captures each realtime reply while the panel is enabled and
  // shows the latest one when it opens.
  useEffect(() => {
    if (!isAnimaDebugSectionAvailable("lipSync")) return;
    const { startCapture, stopCapture } = useLipSyncDebugStore.getState();
    startCapture();
    return stopCapture;
  }, []);

  return isOpen ? (
    <Suspense fallback={null}>
      <AnimaDebugPanel />
    </Suspense>
  ) : null;
}
