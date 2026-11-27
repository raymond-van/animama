import { useThree } from "@react-three/fiber";
import { useEffect } from "react";

import { registerPreviewSheetRenderer } from "./previewSheetRenderer";

/**
 * Lends the preview canvas's renderer to the draft worker for review sheets.
 * Mount it inside the preview's canvas: while it is mounted the worker can
 * draw sheets, and when the canvas unmounts no further sheet is drawn.
 */
export function GenerationPreviewRendererBridge() {
  const renderer = useThree((state) => state.gl);
  useEffect(() => registerPreviewSheetRenderer(renderer), [renderer]);
  return null;
}
