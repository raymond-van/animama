import * as THREE from "three";

import { installLilToonRenderingWhenLoaded } from "@/lib/avatar/liltoon/lilToon";
import {
  drawReviewSheet,
  type ReviewSheetTile,
  type ReviewSheetTilePainter,
} from "@/lib/avatar/motion-authoring/reviewSheet";

/**
 * Review-sheet renderer for generated Gestures (driven by
 * `scripts/animation-render.mjs`). The sheet itself is drawn by
 * `drawReviewSheet` in app source, which the app shares; this page supplies
 * the Avatars to draw and a renderer of its own for the tiles. Both clip
 * schemas are supported.
 */

type RenderRequest = {
  clip: unknown;
  avatars: { id: string; url: string }[];
  times: number[];
  tile: ReviewSheetTile;
  /** Which of the Avatar's own sides the ¾ and side views look from. */
  side: "left" | "right";
  /** `body` (whole Avatar and face) or `hands` (close-ups of the `side` hand). */
  view?: "body" | "hands";
};

/** Draws each tile on a renderer of the tile's own size and copies its canvas. */
function ownRendererPainter(tile: ReviewSheetTile): {
  paintTile: ReviewSheetTilePainter;
  dispose: () => void;
} {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    preserveDrawingBuffer: true,
  });
  renderer.setSize(tile.width, tile.height);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // lilToon's outline and extra passes, as the app canvases install them.
  const releaseLilToon = installLilToonRenderingWhenLoaded(renderer);
  return {
    paintTile(scene, camera, context, x, y) {
      renderer.render(scene, camera);
      context.drawImage(renderer.domElement, x, y);
    },
    dispose() {
      releaseLilToon();
      renderer.dispose();
      // The page may render again; do not wait for the context to be collected.
      renderer.forceContextLoss();
    },
  };
}

/** Render one sheet with every requested Avatar side by side, as a PNG. */
export async function renderGestureSheet(
  request: RenderRequest,
): Promise<{ dataUrl: string; missingPoseRefs: string[] }> {
  const painter = ownRendererPainter(request.tile);
  try {
    const { canvas, missingPoseRefs } = await drawReviewSheet({
      clip: request.clip,
      avatars: request.avatars.map(({ id, url }) => ({
        label: id.replace("AvatarSample_", ""),
        file: url,
      })),
      times: request.times,
      tile: request.tile,
      side: request.side,
      view: request.view,
      paintTile: painter.paintTile,
    });
    return { dataUrl: canvas.toDataURL("image/png"), missingPoseRefs };
  } finally {
    painter.dispose();
  }
}

declare global {
  interface Window {
    renderGestureSheet: typeof renderGestureSheet;
    gestureRendererReady: boolean;
  }
}

window.renderGestureSheet = renderGestureSheet;
window.gestureRendererReady = true;
