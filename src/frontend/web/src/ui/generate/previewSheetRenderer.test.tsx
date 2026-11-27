// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { WebGLRenderer } from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IncludedAvatarId } from "@/lib/avatar/motion-authoring/headlessVrm";
import type { IncludedAvatarReviewSheetsRequest } from "@/lib/avatar/motion-authoring/reviewSheet";
import { GenerationPreviewRendererBridge } from "./GenerationPreviewRendererBridge";
import {
  PreviewRendererUnavailableError,
  registerPreviewSheetRenderer,
  reviewSheetTimes,
  usePreviewSheetRenderer,
  type PreviewSheetRenderer,
} from "./previewSheetRenderer";

const sheets = vi.hoisted(() => ({
  /** The Avatars drawn, with the renderer they were drawn on. */
  drawn: [] as { avatar: string; renderer: unknown }[],
  requests: [] as unknown[],
  /** Runs right after an Avatar's tiles were drawn. */
  onDrawn: null as ((avatar: string) => void) | null,
}));
const three = vi.hoisted(() => ({ gl: null as unknown }));

// Stands in for the real sheet drawing: one sheet per Included Avatar, each
// after asking for that Avatar's file.
vi.mock("@/lib/avatar/motion-authoring/reviewSheet", () => ({
  MAX_REVIEW_SHEET_ROWS: 6,
  renderIncludedAvatarReviewSheets: async (
    request: IncludedAvatarReviewSheetsRequest,
  ) => {
    sheets.requests.push(request);
    const result = [];
    for (const avatar of ["Andrew", "Annie"] as IncludedAvatarId[]) {
      await request.avatarFile(avatar);
      sheets.drawn.push({ avatar, renderer: request.renderer });
      sheets.onDrawn?.(avatar);
      result.push({
        avatar,
        blob: new Blob([avatar]),
        width: 944,
        height: 2008,
      });
    }
    return result;
  },
}));
vi.mock("@react-three/fiber", () => ({
  useThree: (select: (state: { gl: unknown }) => unknown) =>
    select({ gl: three.gl }),
}));

function fakeRenderer() {
  const state = { lost: false };
  return {
    renderer: {
      getContext: () => ({ isContextLost: () => state.lost }),
    } as unknown as WebGLRenderer,
    loseContext: () => {
      state.lost = true;
    },
  };
}

/** The registered renderer, read as a component reads it. */
function registered(): PreviewSheetRenderer | null {
  let render: PreviewSheetRenderer | null = null;
  function Probe() {
    render = usePreviewSheetRenderer();
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() => root.render(<Probe />));
  act(() => root.unmount());
  return render;
}

const REQUEST = {
  clip: { schema: "animaPoseClip/2.0" },
  times: [0, 0.5],
  avatarFile: async () => new ArrayBuffer(4),
};

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  sheets.drawn = [];
  sheets.requests = [];
  sheets.onDrawn = null;
});

describe("registerPreviewSheetRenderer", () => {
  let unregister: (() => void) | null = null;
  afterEach(() => {
    unregister?.();
    unregister = null;
  });

  it("offers no renderer until a preview canvas registers one", () => {
    expect(registered()).toBeNull();
  });

  it("draws both Included Avatars' sheets on the registered renderer", async () => {
    const { renderer } = fakeRenderer();
    unregister = registerPreviewSheetRenderer(renderer);

    const result = await registered()!(REQUEST);

    expect(result.map(({ avatar }) => avatar)).toEqual(["Andrew", "Annie"]);
    expect(sheets.drawn).toEqual([
      { avatar: "Andrew", renderer },
      { avatar: "Annie", renderer },
    ]);
    expect(sheets.requests[0]).toMatchObject({
      clip: REQUEST.clip,
      times: REQUEST.times,
    });
  });

  it("withdraws the renderer and draws nothing once unregistered", async () => {
    const { renderer } = fakeRenderer();
    const withdraw = registerPreviewSheetRenderer(renderer);
    const render = registered()!;
    withdraw();

    expect(registered()).toBeNull();
    await expect(render(REQUEST)).rejects.toBeInstanceOf(
      PreviewRendererUnavailableError,
    );
    expect(sheets.drawn).toEqual([]);
  });

  it("stops before the next Avatar when the canvas leaves mid-request", async () => {
    const { renderer } = fakeRenderer();
    const withdraw = registerPreviewSheetRenderer(renderer);
    let release!: () => void;
    const pending = registered()!({
      ...REQUEST,
      // The canvas unmounts while Annie's file is being read.
      avatarFile: (avatar) =>
        avatar === "Andrew"
          ? Promise.resolve(new ArrayBuffer(4))
          : new Promise<ArrayBuffer>((resolve) => {
              release = () => resolve(new ArrayBuffer(4));
            }),
    });
    await vi.waitFor(() => expect(sheets.drawn).toHaveLength(1));
    withdraw();
    release();

    await expect(pending).rejects.toBeInstanceOf(
      PreviewRendererUnavailableError,
    );
    expect(sheets.drawn.map(({ avatar }) => avatar)).toEqual(["Andrew"]);
  });

  it("discards sheets that finish after the canvas left", async () => {
    const { renderer } = fakeRenderer();
    const withdraw = registerPreviewSheetRenderer(renderer);
    // Both files were read; the canvas leaves as the last sheet is drawn.
    sheets.onDrawn = (avatar) => {
      if (avatar === "Annie") withdraw();
    };
    await expect(registered()!(REQUEST)).rejects.toBeInstanceOf(
      PreviewRendererUnavailableError,
    );
    expect(sheets.drawn).toHaveLength(2);
  });

  it("refuses to draw on a lost WebGL context", async () => {
    const { renderer, loseContext } = fakeRenderer();
    unregister = registerPreviewSheetRenderer(renderer);
    loseContext();
    await expect(registered()!(REQUEST)).rejects.toBeInstanceOf(
      PreviewRendererUnavailableError,
    );
    expect(sheets.drawn).toEqual([]);
  });

  it("keeps a newer canvas's renderer when an older one unregisters late", () => {
    const older = registerPreviewSheetRenderer(fakeRenderer().renderer);
    unregister = registerPreviewSheetRenderer(fakeRenderer().renderer);
    const current = registered();
    older();
    expect(registered()).toBe(current);
  });
});

describe("GenerationPreviewRendererBridge", () => {
  it("registers the canvas's renderer while it is mounted", async () => {
    const { renderer } = fakeRenderer();
    three.gl = renderer;
    const root = createRoot(document.createElement("div"));
    act(() => root.render(<GenerationPreviewRendererBridge />));

    await registered()!(REQUEST);
    expect(sheets.drawn[0]!.renderer).toBe(renderer);

    act(() => root.unmount());
    expect(registered()).toBeNull();
  });
});

describe("reviewSheetTimes", () => {
  const clip = (times: unknown[]) => ({
    beats: times.map((time, index) => ({ id: `beat-${index}`, time })),
  });

  it("shows a clip's beats in time order", () => {
    expect(reviewSheetTimes(clip([0, 0.5, 0.9, 2, 2.5]))).toEqual([
      0, 0.5, 0.9, 2, 2.5,
    ]);
    expect(reviewSheetTimes(clip([2, 0, 0.5, 0.5]))).toEqual([0, 0.5, 2]);
  });

  it("keeps six rows of a longer clip, with its first and last beat", () => {
    const times = reviewSheetTimes(
      clip([0, 0.2, 0.4, 0.6, 0.8, 1, 1.2, 1.4, 1.6, 1.8, 2]),
    );
    expect(times).toEqual([0, 0.4, 0.8, 1.2, 1.6, 2]);
    expect(
      reviewSheetTimes(clip(Array.from({ length: 40 }, (_, beat) => beat))),
    ).toHaveLength(6);
  });

  it("shows the start of a clip whose beats cannot be read", () => {
    expect(reviewSheetTimes(clip([]))).toEqual([0]);
    expect(reviewSheetTimes(clip(["soon", -1, Number.NaN, null]))).toEqual([0]);
    expect(reviewSheetTimes({ beats: "none" })).toEqual([0]);
    expect(reviewSheetTimes(null)).toEqual([0]);
  });
});
