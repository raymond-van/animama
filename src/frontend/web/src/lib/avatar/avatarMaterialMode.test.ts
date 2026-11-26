import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Avatar } from "./Avatar";
import type { AvatarMaterialMode } from "./avatarSettings";
import { canvasFrameCap } from "./canvasFrameCap";
import { LILTOON_MATERIALS_EXTENSION } from "./liltoon/lilToon";
import {
  automaticDecisionSinceLoad,
  resetAvatarCanvasGpuForTesting,
  writeLilToonGpuMeasurement,
} from "./liltoon/lilToonGpuCheck";
import { loadTestAvatarWithGltf } from "./motion-authoring/testing/includedAvatars";

type LoadVrm = (
  url: string,
  onProgress: unknown,
  resourceUrls: unknown,
  materialMode: AvatarMaterialMode,
  unlitToon: boolean,
) => Promise<never>;

/**
 * Load with `materialMode` and return the mode the VRM loader was asked for
 * and whether it toon-shades unlit-only files; the loader stops the load
 * there.
 */
async function loaderMode(
  materialMode: AvatarMaterialMode,
): Promise<{ mode: AvatarMaterialMode; unlitToon: boolean; avatar: Avatar }> {
  const loadVrm = vi
    .spyOn(Avatar as unknown as { _loadVrm: LoadVrm }, "_loadVrm")
    .mockRejectedValue(new Error("stop"));
  const avatar = new Avatar(new THREE.PerspectiveCamera());
  await expect(
    avatar.load({ filePath: "/converted.vrm", materialMode }),
  ).rejects.toThrow("stop");
  return {
    mode: loadVrm.mock.calls[0]![3],
    unlitToon: loadVrm.mock.calls[0]![4],
    avatar,
  };
}

/** Per-viewer storage, empty. */
function stubStorage() {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  });
}

/** Store this GPU's measurements, taken now, oldest first. */
function storeMeasurement(
  frameMs: number | number[],
  options: { stub?: boolean } = {},
) {
  if (options.stub !== false) {
    stubStorage();
    resetAvatarCanvasGpuForTesting("Apple | Test GPU");
  }
  writeLilToonGpuMeasurement("Apple | Test GPU", {
    status: "measured",
    method: 3,
    samples: [frameMs].flat().map((value) => ({
      frameMs: value,
      frames: 60,
      pixels: 1_920_000,
      measuredAt: new Date().toISOString(),
    })),
  });
}

/**
 * Load an Included Avatar on `canvas` with `materialMode`; with `lilToon`, as
 * a file whose authored lilToon materials rendered (one material marked as
 * three-liltoon marks its own).
 */
async function loadOnCanvas(
  canvas: HTMLElement,
  materialMode: AvatarMaterialMode,
  lilToon: boolean,
): Promise<Avatar> {
  const { vrm, gltf } = await loadTestAvatarWithGltf("Andrew");
  if (lilToon) {
    (gltf.parser.json as { extensionsUsed?: string[] }).extensionsUsed = [
      LILTOON_MATERIALS_EXTENSION,
    ];
    let marked = false;
    vrm.scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (marked || !mesh.isMesh) return;
      Object.assign([mesh.material].flat()[0]!, { isLilToonMaterial: true });
      marked = true;
    });
  }
  vi.spyOn(
    Avatar as unknown as { _loadVrm: () => Promise<unknown> },
    "_loadVrm",
  ).mockResolvedValue({ gltf, vrm });
  const avatar = new Avatar(new THREE.PerspectiveCamera(), canvas);
  await avatar.load({ filePath: "/converted.vrm", materialMode });
  vi.restoreAllMocks();
  return avatar;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetAvatarCanvasGpuForTesting();
});

describe("Avatar Materials setting", () => {
  it("Automatic keeps lilToon at the frame rate this GPU sustains", async () => {
    storeMeasurement(14.4);
    const { mode, avatar } = await loaderMode("automatic");
    expect(mode).toBe("liltoon");
    expect(avatar.materialMode).toBe("automatic");
    expect(avatar.automaticMaterials).toMatchObject({
      choice: "liltoon",
      reason: "capped",
      fpsCap: 45,
      frameMs: 14.4,
    });
  });

  it("Automatic loads Simple only after two measurements too slow for 24 fps", async () => {
    storeMeasurement(40);
    const once = await loaderMode("automatic");
    expect(once.mode).toBe("liltoon");
    expect(once.avatar.automaticMaterials).toMatchObject({
      reason: "remeasuring",
      fpsCap: 24,
    });
    vi.restoreAllMocks();
    storeMeasurement([40, 36]);
    const twice = await loaderMode("automatic");
    expect(twice.mode).toBe("simple");
    expect(twice.avatar.automaticMaterials).toMatchObject({
      choice: "simple",
      reason: "slow",
      fpsCap: null,
      frameMs: 36,
    });
  });

  it("Automatic loads lilToon after a fast measurement or none", async () => {
    storeMeasurement(4);
    expect((await loaderMode("automatic")).mode).toBe("liltoon");
    vi.restoreAllMocks();
    resetAvatarCanvasGpuForTesting(null, null);
    const unmeasured = await loaderMode("automatic");
    expect(unmeasured.mode).toBe("liltoon");
    expect(unmeasured.avatar.automaticMaterials?.reason).toBe("not_measured");
  });

  it("an explicit setting ignores the measurement", async () => {
    storeMeasurement([40, 36]);
    const liltoon = await loaderMode("liltoon");
    expect(liltoon.mode).toBe("liltoon");
    expect(liltoon.avatar.automaticMaterials).toBeNull();
    vi.restoreAllMocks();
    expect((await loaderMode("simple")).mode).toBe("simple");
  });

  it("toon-shades unlit-only files unless the setting is Simple, whatever the GPU check chose", async () => {
    storeMeasurement([40, 36]);
    const automatic = await loaderMode("automatic");
    expect(automatic).toMatchObject({ mode: "simple", unlitToon: true });
    vi.restoreAllMocks();
    expect((await loaderMode("liltoon")).unlitToon).toBe(true);
    vi.restoreAllMocks();
    expect((await loaderMode("simple")).unlitToon).toBe(false);
  });

  it("Automatic reads the stored measurement before any canvas notes its GPU", async () => {
    // An off-screen Diagnostics or Library load: no Avatar canvas mounted
    // yet, so the GPU a fresh context names is looked up instead.
    storeMeasurement([40, 36]);
    resetAvatarCanvasGpuForTesting(null, "Apple | Test GPU");
    const { mode, avatar } = await loaderMode("automatic");
    expect(mode).toBe("simple");
    expect(avatar.automaticMaterials?.reason).toBe("slow");
  });

  it("uses a measurement stored after a load from the next load on", async () => {
    stubStorage();
    resetAvatarCanvasGpuForTesting("Apple | Test GPU");
    const first = await loaderMode("automatic");
    expect(first.mode).toBe("liltoon");
    expect(automaticDecisionSinceLoad(first.avatar.automaticMaterials)).toBe(
      null,
    );

    // The chat canvas finishes its measurement while this Avatar is shown.
    storeMeasurement(20, { stub: false });
    expect(
      automaticDecisionSinceLoad(first.avatar.automaticMaterials),
    ).toMatchObject({ choice: "liltoon", reason: "capped", fpsCap: 30 });
    vi.restoreAllMocks();
    const next = await loaderMode("automatic");
    expect(next.mode).toBe("liltoon");
    expect(next.avatar.automaticMaterials?.fpsCap).toBe(30);
    expect(automaticDecisionSinceLoad(next.avatar.automaticMaterials)).toBe(
      null,
    );
  });

  it("caps the canvas showing a lilToon Avatar under Automatic, until unloaded", async () => {
    storeMeasurement(20);
    const canvas = {} as HTMLElement;
    const avatar = await loadOnCanvas(canvas, "automatic", true);
    expect(avatar.lilToonMaterials).toBe("rendered");
    expect(canvasFrameCap(canvas)).toBe(30);
    avatar.unload();
    expect(canvasFrameCap(canvas)).toBeNull();

    // An explicit lilToon setting renders at the full rate.
    const explicit = await loadOnCanvas(canvas, "liltoon", true);
    expect(canvasFrameCap(canvas)).toBeNull();
    explicit.dispose();
  }, 30_000);

  it("leaves Avatars without lilToon materials, like the Included ones, uncapped", async () => {
    storeMeasurement(20);
    const canvas = {} as HTMLElement;
    const avatar = await loadOnCanvas(canvas, "automatic", false);
    expect(avatar.lilToonMaterials).toBe("none");
    expect(canvasFrameCap(canvas)).toBeNull();
    avatar.dispose();
  }, 30_000);
});
