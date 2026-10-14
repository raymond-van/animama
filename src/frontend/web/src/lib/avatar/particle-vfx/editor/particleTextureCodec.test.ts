import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createParticleVFXTextureCodec,
  fetchBuiltInParticleVFXTexture,
} from "./particleTextureCodec";
import {
  ParticleVFXTextureSurfaceUnavailable,
  recolourParticleVFXTexture,
  sampleParticleVFXTexture,
} from "./textureRecolour";

vi.mock("./textureRecolour", async (original) => ({
  ...(await original<typeof import("./textureRecolour")>()),
  sampleParticleVFXTexture: vi.fn(),
  recolourParticleVFXTexture: vi.fn(),
}));

const sample = {
  width: 1,
  height: 1,
  data: new Uint8ClampedArray([255, 0, 0, 255]),
};
const png = new Blob(["png"], { type: "image/png" });
const sky = { kind: "rotate", degrees: -140 } as const;

/** A stand-in Worker that records its jobs and answers on demand. */
class FakeWorker {
  static created: FakeWorker[] = [];
  readonly posted: { id: number; task: string }[] = [];
  readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  terminated = false;
  constructor() {
    FakeWorker.created.push(this);
  }
  addEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  postMessage(message: { id: number; task: string }) {
    this.posted.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  emit(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

describe("the colour theme's texture codec", () => {
  beforeEach(() => {
    FakeWorker.created = [];
    vi.mocked(sampleParticleVFXTexture).mockResolvedValue(sample);
    vi.mocked(recolourParticleVFXTexture).mockResolvedValue(png);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("works on the main thread without a worker, keeping each result", async () => {
    vi.stubGlobal("Worker", undefined);
    const codec = createParticleVFXTextureCodec();
    const blob = new Blob(["a"]);

    expect(await codec.sample(blob)).toBe(sample);
    expect(await codec.sample(blob)).toBe(sample);
    expect(await codec.recolour(blob, sky)).toBe(png);
    expect(await codec.recolour(blob, { ...sky })).toBe(png);
    expect(sampleParticleVFXTexture).toHaveBeenCalledTimes(1);
    expect(recolourParticleVFXTexture).toHaveBeenCalledTimes(1);

    // A failure is not kept: choosing the theme again retries.
    vi.mocked(recolourParticleVFXTexture).mockRejectedValueOnce(
      new Error("The image could not be encoded."),
    );
    await expect(codec.recolour(blob, { kind: "desaturate" })).rejects.toThrow(
      "could not be encoded",
    );
    expect(await codec.recolour(blob, { kind: "desaturate" })).toBe(png);
  });

  it("sends the work to a worker and returns its answers", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const codec = createParticleVFXTextureCodec();

    const sampled = codec.sample(new Blob(["a"]));
    const coloured = codec.recolour(new Blob(["b"]), sky);
    const worker = FakeWorker.created[0]!;
    expect(worker.posted.map(({ task }) => task)).toEqual([
      "sample",
      "recolour",
    ]);
    worker.emit("message", {
      data: { id: worker.posted[0]!.id, ok: true, sample },
    });
    worker.emit("message", {
      data: {
        id: worker.posted[1]!.id,
        ok: false,
        message: "The image could not be decoded.",
        unsupported: false,
      },
    });
    expect(await sampled).toBe(sample);
    await expect(coloured).rejects.toThrow("could not be decoded");
    expect(sampleParticleVFXTexture).not.toHaveBeenCalled();

    codec.dispose();
    expect(worker.terminated).toBe(true);
  });

  it("finishes on the main thread when the worker has no canvas or fails", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const codec = createParticleVFXTextureCodec();
    const first = codec.sample(new Blob(["a"]));
    const second = codec.recolour(new Blob(["b"]), sky);
    const worker = FakeWorker.created[0]!;
    worker.emit("message", {
      data: {
        id: worker.posted[0]!.id,
        ok: false,
        message: new ParticleVFXTextureSurfaceUnavailable().message,
        unsupported: true,
      },
    });
    expect(await first).toBe(sample);
    expect(await second).toBe(png);
    expect(worker.terminated).toBe(true);
    // Later work stays on the main thread.
    await codec.sample(new Blob(["c"]));
    expect(FakeWorker.created).toHaveLength(1);

    const crashing = createParticleVFXTextureCodec();
    const pending = crashing.sample(new Blob(["d"]));
    FakeWorker.created[1]!.emit("error", new Event("error"));
    expect(await pending).toBe(sample);
  });

  it("fetches each built-in texture once, so its results are reused", async () => {
    const fetches = vi.fn(async () => new Response(new Blob(["png"])));
    vi.stubGlobal("fetch", fetches);
    const first = await fetchBuiltInParticleVFXTexture(
      "textures/spark-dot.png",
    );
    const again = await fetchBuiltInParticleVFXTexture(
      "textures/spark-dot.png",
    );
    expect(again).toBe(first);
    expect(fetches).toHaveBeenCalledTimes(1);
    expect(fetches).toHaveBeenCalledWith(
      "/effects/vfx/particle-vfx/textures/spark-dot.png",
    );
    expect(
      await fetchBuiltInParticleVFXTexture("textures/glyph-1.png"),
    ).toBeNull();

    // A failed load is retried on the next choice.
    fetches.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(
      fetchBuiltInParticleVFXTexture("textures/zzz.png"),
    ).rejects.toThrow("zzz.png could not be loaded");
    await expect(
      fetchBuiltInParticleVFXTexture("textures/zzz.png"),
    ).resolves.toBeInstanceOf(Blob);
  });
});
