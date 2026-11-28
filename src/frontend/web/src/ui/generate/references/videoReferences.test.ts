import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GENERATE_VIDEO_REFERENCES_ENABLED,
  MAX_VIDEO_REFERENCE_FRAMES,
  MAX_VIDEO_REFERENCE_SECONDS,
  MAX_VIDEO_STRIP_EDGE_PX,
  VideoReferenceError,
  sampleTimes,
  sampleVideoStrip,
  stripLayout,
  videoReferenceStrip,
  type StripCanvas,
  type VideoFrameSource,
} from "./videoReferences";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("the video references switch", () => {
  it("is off unless a development build turns it on", async () => {
    expect(GENERATE_VIDEO_REFERENCES_ENABLED).toBe(false);
    const read = async (flag: string | undefined, dev = true) => {
      vi.resetModules();
      vi.unstubAllEnvs();
      vi.stubEnv("DEV", dev);
      if (flag !== undefined)
        vi.stubEnv("VITE_ENABLE_GENERATE_VIDEO_REFERENCES", flag);
      return (await import("./videoReferences"))
        .GENERATE_VIDEO_REFERENCES_ENABLED;
    };
    expect(await read("true")).toBe(true);
    for (const flag of [undefined, "", "false", "1", "TRUE"])
      expect(await read(flag)).toBe(false);
    // A built app never offers it, whatever its environment says.
    expect(await read("true", false)).toBe(false);
  });
});

describe("sampleTimes", () => {
  const rounded = (times: number[]) =>
    times.map((time) => Math.round(time * 1000) / 1000);

  it("spaces a long video's frames evenly, never more than eight", () => {
    expect(rounded(sampleTimes(16))).toEqual([1, 3, 5, 7, 9, 11, 13, 15]);
    expect(sampleTimes(MAX_VIDEO_REFERENCE_SECONDS)).toHaveLength(
      MAX_VIDEO_REFERENCE_FRAMES,
    );
    expect(sampleTimes(600)).toHaveLength(8);
    // Every time lies inside the video, and the frames are in order.
    const times = sampleTimes(20);
    expect(times[0]).toBeGreaterThan(0);
    expect(times.at(-1)).toBeLessThan(20);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("takes fewer frames from a short video than it could tell apart", () => {
    expect(rounded(sampleTimes(1))).toEqual([0.125, 0.375, 0.625, 0.875]);
    expect(rounded(sampleTimes(0.6))).toEqual([0.15, 0.45]);
    expect(rounded(sampleTimes(0.1))).toEqual([0.05]);
  });

  it("takes the one frame of a video without length", () => {
    expect(sampleTimes(0)).toEqual([0]);
  });

  it("takes as many frames as asked, and none of a length it cannot read", () => {
    expect(rounded(sampleTimes(10, 2))).toEqual([2.5, 7.5]);
    expect(sampleTimes(10, 0)).toEqual([]);
    for (const duration of [Number.NaN, Infinity, -1])
      expect(sampleTimes(duration)).toEqual([]);
  });
});

describe("stripLayout", () => {
  it("lays the frames left to right in one row, at their own size when it fits", () => {
    expect(stripLayout(200, 100, 4)).toEqual({
      width: 800,
      height: 100,
      tileWidth: 200,
      tileHeight: 100,
      tiles: [
        { x: 0, y: 0 },
        { x: 200, y: 0 },
        { x: 400, y: 0 },
        { x: 600, y: 0 },
      ],
    });
  });

  it("scales the frames down so the strip's long edge stays within bounds", () => {
    const landscape = stripLayout(1920, 1080, 8)!;
    expect(landscape.tileWidth).toBe(250);
    expect(landscape.tileHeight).toBe(140);
    expect(landscape.width).toBe(MAX_VIDEO_STRIP_EDGE_PX);
    expect(landscape.tiles.map(({ x }) => x)).toEqual([
      0, 250, 500, 750, 1000, 1250, 1500, 1750,
    ]);

    // A tall frame is bounded by its height.
    const portrait = stripLayout(1080, 4320, 1)!;
    expect(portrait).toMatchObject({ width: 500, height: 2000 });

    for (const [width, height, count] of [
      [3840, 2160, 8],
      [1080, 1920, 8],
      [7, 9000, 3],
      [9000, 7, 8],
      [1, 1, 1],
    ] as const) {
      const layout = stripLayout(width, height, count)!;
      expect(layout.width).toBeLessThanOrEqual(MAX_VIDEO_STRIP_EDGE_PX);
      expect(layout.height).toBeLessThanOrEqual(MAX_VIDEO_STRIP_EDGE_PX);
      expect(layout.tileWidth).toBeGreaterThanOrEqual(1);
      expect(layout.tileHeight).toBeGreaterThanOrEqual(1);
      expect(layout.width).toBe(layout.tileWidth * count);
      expect(layout.tiles).toHaveLength(count);
    }
  });

  it("has no layout for frames without a size, or for none", () => {
    expect(stripLayout(0, 100, 4)).toBeNull();
    expect(stripLayout(100, Number.NaN, 4)).toBeNull();
    expect(stripLayout(100, 100, 0)).toBeNull();
  });
});

/** A video that hands out its frames' times instead of pictures. */
function fakeVideo(
  overrides: Partial<VideoFrameSource<string>> = {},
): VideoFrameSource<string> & { asked: number[]; closed: number } {
  const source = {
    duration: 4,
    width: 400,
    height: 300,
    asked: [] as number[],
    closed: 0,
    frameAt: async (time: number) => {
      source.asked.push(time);
      return `frame@${time}`;
    },
    close: () => {
      source.closed += 1;
    },
    ...overrides,
  };
  return source;
}

/** A canvas that records what was drawn where. */
function fakeCanvas(bytes = 1024) {
  const made: {
    width: number;
    height: number;
    drawn: [string, number, number, number, number][];
    quality: number | null;
  }[] = [];
  const create = (width: number, height: number): StripCanvas<string> => {
    const canvas = {
      width,
      height,
      drawn: [] as [string, number, number, number, number][],
      quality: null as number | null,
    };
    made.push(canvas);
    return {
      draw: (frame, x, y, tileWidth, tileHeight) =>
        canvas.drawn.push([frame, x, y, tileWidth, tileHeight]),
      toJpeg: async (quality) => {
        canvas.quality = quality;
        return new Blob([new Uint8Array(bytes)], { type: "image/jpeg" });
      },
    };
  };
  return { create, made };
}

describe("sampleVideoStrip", () => {
  it("draws the sampled frames left to right into one JPEG strip", async () => {
    const video = fakeVideo();
    const canvas = fakeCanvas();
    const strip = await sampleVideoStrip(video, canvas.create);
    expect(video.asked).toEqual([
      0.25, 0.75, 1.25, 1.75, 2.25, 2.75, 3.25, 3.75,
    ]);
    expect(canvas.made).toHaveLength(1);
    expect(canvas.made[0]).toMatchObject({ width: 2000, height: 187 });
    expect(canvas.made[0]!.drawn.slice(0, 3)).toEqual([
      ["frame@0.25", 0, 0, 250, 187],
      ["frame@0.75", 250, 0, 250, 187],
      ["frame@1.25", 500, 0, 250, 187],
    ]);
    expect(canvas.made[0]!.drawn).toHaveLength(8);
    expect(canvas.made[0]!.quality).toBeGreaterThan(0.5);
    expect(strip).toMatchObject({ frames: 8, width: 2000, height: 187 });
    expect(strip.blob.type).toBe("image/jpeg");
  });

  it("refuses a video longer than twenty seconds before reading a frame", async () => {
    const video = fakeVideo({ duration: 21 });
    const canvas = fakeCanvas();
    await expect(sampleVideoStrip(video, canvas.create)).rejects.toMatchObject({
      name: "VideoReferenceError",
      reason: "too_long",
    });
    expect(video.asked).toEqual([]);
    expect(canvas.made).toEqual([]);
    // Twenty seconds exactly is taken.
    await expect(
      sampleVideoStrip(fakeVideo({ duration: 20 }), canvas.create),
    ).resolves.toMatchObject({ frames: 8 });
  });

  it("refuses a video it cannot read, or a strip the upload would refuse", async () => {
    const unreadable = { name: "VideoReferenceError", reason: "unreadable" };
    for (const broken of [
      { duration: Infinity },
      { duration: Number.NaN },
      { width: 0 },
      {
        frameAt: async () => {
          throw new Error("decode failed");
        },
      },
    ])
      await expect(
        sampleVideoStrip(fakeVideo(broken), fakeCanvas().create),
      ).rejects.toMatchObject(unreadable);
    await expect(
      sampleVideoStrip(fakeVideo(), fakeCanvas(21 * 1024 * 1024).create),
    ).rejects.toMatchObject(unreadable);
  });
});

describe("videoReferenceStrip", () => {
  const clip = new File(["video"], "shy wave.take 2.mp4", {
    type: "video/mp4",
  });

  it("makes one JPEG image file named after the video, and closes the video", async () => {
    const video = fakeVideo();
    const strip = await videoReferenceStrip(
      clip,
      async () => video,
      fakeCanvas(2048).create,
    );
    expect(strip).toBeInstanceOf(File);
    expect(strip.name).toBe("shy wave.take 2-frames.jpg");
    expect(strip.type).toBe("image/jpeg");
    expect(strip.size).toBe(2048);
    expect(video.closed).toBe(1);
  });

  it("closes the video when it is refused, and says a video that will not open is unreadable", async () => {
    const video = fakeVideo({ duration: 21 });
    await expect(
      videoReferenceStrip(clip, async () => video, fakeCanvas().create),
    ).rejects.toBeInstanceOf(VideoReferenceError);
    expect(video.closed).toBe(1);

    await expect(
      videoReferenceStrip(
        clip,
        async () => {
          throw new Error("no decoder");
        },
        fakeCanvas().create,
      ),
    ).rejects.toMatchObject({ reason: "unreadable" });
  });
});
