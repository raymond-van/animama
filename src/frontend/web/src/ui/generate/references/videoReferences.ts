import { MAX_USER_IMAGE_UPLOAD_SIZE_BYTES } from "@/lib/user-files/uploads";
import { createStripCanvas, openVideoFrameSource } from "./videoFrameSource";

/**
 * A short video as a reference for the content assistant (spec R8.3): the
 * page decodes it locally, samples a few frames evenly spaced in time and
 * draws them left to right into one strip image. Only that strip is
 * uploaded, as any reference image is; the video never leaves the machine.
 *
 * The decoding sits behind a frame source and a canvas factory, so the
 * sampling and the layout are tested without decoding a video.
 */

/**
 * Whether the Generate page offers a video as a reference. The owner has not
 * decided to ship it, so it is off; a development build turns it on by
 * starting with `VITE_ENABLE_GENERATE_VIDEO_REFERENCES=true`. A built app
 * never offers it, whatever its environment says.
 */
export const GENERATE_VIDEO_REFERENCES_ENABLED =
  import.meta.env.DEV &&
  import.meta.env.VITE_ENABLE_GENERATE_VIDEO_REFERENCES === "true";

/** The longest video taken, in seconds. */
export const MAX_VIDEO_REFERENCE_SECONDS = 20;
/** The most frames sampled from one video. */
export const MAX_VIDEO_REFERENCE_FRAMES = 8;
/** The strip's longest edge, in pixels. */
export const MAX_VIDEO_STRIP_EDGE_PX = 2000;
/** Frames closer together than this show nearly the same picture. */
const MIN_VIDEO_FRAME_SPACING_SECONDS = 0.25;
const VIDEO_STRIP_JPEG_QUALITY = 0.85;

/** Why a video cannot be used as a reference. */
export type VideoReferenceRefusal =
  /** Longer than `MAX_VIDEO_REFERENCE_SECONDS`. */
  | "too_long"
  /** This browser cannot decode it, or it has no length or picture. */
  | "unreadable";

/** A video refused as a reference; the page words it from `reason`. */
export class VideoReferenceError extends Error {
  readonly reason: VideoReferenceRefusal;

  constructor(reason: VideoReferenceRefusal, options?: ErrorOptions) {
    super(`Video reference refused: ${reason}`, options);
    this.name = "VideoReferenceError";
    this.reason = reason;
  }
}

/** A decoded video, as far as sampling needs it. */
export type VideoFrameSource<Frame> = {
  /** Its length in seconds. */
  duration: number;
  /** Its picture's size in pixels. */
  width: number;
  height: number;
  /** The picture at `time` seconds, ready to draw. */
  frameAt: (time: number) => Promise<Frame>;
  /** Release the video. */
  close: () => void;
};

/** A drawing surface the size of the strip. */
export type StripCanvas<Frame> = {
  draw: (
    frame: Frame,
    x: number,
    y: number,
    width: number,
    height: number,
  ) => void;
  /** The surface as a JPEG at `quality` (0 to 1). */
  toJpeg: (quality: number) => Promise<Blob>;
};

export type StripCanvasFactory<Frame> = (
  width: number,
  height: number,
) => StripCanvas<Frame>;

/**
 * The times to sample a video of `duration` seconds at: the middle of each
 * of up to `max` equal spans, so the frames are evenly spaced and none sits
 * at the very end, which a decoder may not reach. A short video gives fewer
 * frames than `max`, one for each quarter second, and at least one. A
 * duration that is no finite length gives none.
 */
export function sampleTimes(
  duration: number,
  max: number = MAX_VIDEO_REFERENCE_FRAMES,
): number[] {
  if (!Number.isFinite(duration) || duration < 0 || max < 1) return [];
  const count = Math.max(
    1,
    Math.min(
      Math.floor(max),
      Math.floor(duration / MIN_VIDEO_FRAME_SPACING_SECONDS),
    ),
  );
  return Array.from(
    { length: count },
    (_, index) => ((index + 0.5) * duration) / count,
  );
}

/** Where each frame goes in the strip, and the strip's own size. */
export type VideoStripLayout = {
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
  /** Each frame's top-left corner, in sampling order, left to right. */
  tiles: { x: number; y: number }[];
};

/**
 * One row of `count` frames, left to right, each scaled down (never up) so
 * neither edge of the strip passes `maxEdge` pixels. `null` for frames
 * without a size, or for none.
 */
export function stripLayout(
  frameWidth: number,
  frameHeight: number,
  count: number,
  maxEdge: number = MAX_VIDEO_STRIP_EDGE_PX,
): VideoStripLayout | null {
  if (
    !(frameWidth > 0) ||
    !(frameHeight > 0) ||
    !Number.isInteger(count) ||
    count < 1 ||
    !Number.isFinite(frameWidth) ||
    !Number.isFinite(frameHeight)
  )
    return null;
  // The widest a frame may be: its own width, its share of the row, and the
  // width at which its height reaches the bound.
  const tileWidth = Math.max(
    1,
    Math.floor(
      Math.min(
        frameWidth,
        maxEdge / count,
        (frameWidth * maxEdge) / frameHeight,
      ),
    ),
  );
  const tileHeight = Math.max(
    1,
    Math.min(maxEdge, Math.floor((tileWidth * frameHeight) / frameWidth)),
  );
  return {
    width: tileWidth * count,
    height: tileHeight,
    tileWidth,
    tileHeight,
    tiles: Array.from({ length: count }, (_, index) => ({
      x: index * tileWidth,
      y: 0,
    })),
  };
}

/**
 * Sample a video's frames into one JPEG strip. Refuses a video longer than
 * twenty seconds before reading a frame, and one that cannot be read. At
 * most 2,000 pixels on its long edge, the strip stays far below the upload's
 * image limit; one that did not would be refused here, not by the upload.
 */
export async function sampleVideoStrip<Frame>(
  source: Pick<
    VideoFrameSource<Frame>,
    "duration" | "width" | "height" | "frameAt"
  >,
  createCanvas: StripCanvasFactory<Frame>,
): Promise<{ blob: Blob; frames: number; width: number; height: number }> {
  // A recording without a known length reports none it can be sampled by.
  if (!Number.isFinite(source.duration))
    throw new VideoReferenceError("unreadable");
  if (source.duration > MAX_VIDEO_REFERENCE_SECONDS)
    throw new VideoReferenceError("too_long");
  const times = sampleTimes(source.duration);
  const layout = stripLayout(source.width, source.height, times.length);
  if (!layout) throw new VideoReferenceError("unreadable");
  try {
    const canvas = createCanvas(layout.width, layout.height);
    for (const [index, time] of times.entries()) {
      const { x, y } = layout.tiles[index]!;
      canvas.draw(
        await source.frameAt(time),
        x,
        y,
        layout.tileWidth,
        layout.tileHeight,
      );
    }
    const blob = await canvas.toJpeg(VIDEO_STRIP_JPEG_QUALITY);
    if (blob.size > MAX_USER_IMAGE_UPLOAD_SIZE_BYTES)
      throw new VideoReferenceError("unreadable");
    return {
      blob,
      frames: times.length,
      width: layout.width,
      height: layout.height,
    };
  } catch (error) {
    throw error instanceof VideoReferenceError
      ? error
      : new VideoReferenceError("unreadable", { cause: error });
  }
}

/** A video file's name as its strip's: `wave.mp4` gives `wave-frames.jpg`. */
function stripFileName(videoName: string): string {
  return `${videoName.replace(/\.[^./\\]+$/, "") || "video"}-frames.jpg`;
}

/**
 * The strip image of a local video file, ready to attach as a reference
 * image. Rejects with a `VideoReferenceError` for a video that is too long
 * or cannot be read. `open` and `createCanvas` are the browser's decoder and
 * canvas unless a test supplies its own.
 */
export async function videoReferenceStrip<Frame = CanvasImageSource>(
  video: File,
  open: (
    video: File,
  ) => Promise<VideoFrameSource<Frame>> = openVideoFrameSource as never,
  createCanvas: StripCanvasFactory<Frame> = createStripCanvas as never,
): Promise<File> {
  let source: VideoFrameSource<Frame>;
  try {
    source = await open(video);
  } catch (error) {
    throw error instanceof VideoReferenceError
      ? error
      : new VideoReferenceError("unreadable", { cause: error });
  }
  try {
    const { blob } = await sampleVideoStrip(source, createCanvas);
    return new File([blob], stripFileName(video.name), {
      type: "image/jpeg",
    });
  } finally {
    source.close();
  }
}
