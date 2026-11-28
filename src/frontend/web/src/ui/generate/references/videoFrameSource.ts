import type { StripCanvas, VideoFrameSource } from "./videoReferences";

/**
 * The browser's side of a video reference: a `<video>` element that decodes
 * the person's local file, and the canvas its frames are drawn into. The
 * file is read through an object URL and is never uploaded.
 */

/** How long one step of decoding may take before the video counts as unreadable. */
const DECODE_STEP_TIMEOUT_MS = 10_000;

/** Run `start`, then wait for `event` on the video; an error or a timeout rejects. */
function waitForVideo(
  video: HTMLVideoElement,
  event: "loadeddata" | "seeked",
  start: () => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const settle = (finish: () => void) => {
      clearTimeout(timer);
      video.removeEventListener(event, done);
      video.removeEventListener("error", failed);
      finish();
    };
    const done = () => settle(resolve);
    const failed = () => settle(() => reject(new Error("video_decode_failed")));
    const timer = setTimeout(
      () => settle(() => reject(new Error("video_decode_timeout"))),
      DECODE_STEP_TIMEOUT_MS,
    );
    video.addEventListener(event, done);
    video.addEventListener("error", failed);
    start();
  });
}

/**
 * Open a local video file for sampling: resolves once its first picture is
 * decoded, so its length and size are known. Rejects when the browser cannot
 * decode it.
 */
export async function openVideoFrameSource(
  file: Blob,
): Promise<VideoFrameSource<CanvasImageSource>> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  const url = URL.createObjectURL(file);
  const close = () => {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  };
  try {
    await waitForVideo(video, "loadeddata", () => {
      video.src = url;
    });
  } catch (error) {
    close();
    throw error;
  }
  return {
    duration: video.duration,
    width: video.videoWidth,
    height: video.videoHeight,
    frameAt: async (time) => {
      await waitForVideo(video, "seeked", () => {
        video.currentTime = time;
      });
      return video;
    },
    close,
  };
}

/** A canvas of the strip's size that encodes itself as a JPEG. */
export function createStripCanvas(
  width: number,
  height: number,
): StripCanvas<CanvasImageSource> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas_unavailable");
  return {
    draw: (frame, x, y, tileWidth, tileHeight) =>
      context.drawImage(frame, x, y, tileWidth, tileHeight),
    toJpeg: (quality) =>
      new Promise((resolve, reject) =>
        canvas.toBlob(
          (blob) =>
            blob ? resolve(blob) : reject(new Error("canvas_encode_failed")),
          "image/jpeg",
          quality,
        ),
      ),
  };
}
