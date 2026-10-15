import { existsSync, readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BoxGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  Vector3,
} from "three";

import type { Avatar } from "@/lib/avatar";
import {
  AVATAR_PARTICLE_VFX_CATALOG,
  PARTICLE_VFX_ROOT_OBJECT_NAME,
  ParticleVFXController,
  applyParticleVFXRectangleShapeAutoFit,
  classifyParticleVFXTextureUrl,
  getParticleVFXCatalogEntryById,
  getParticleVFXCombinedOffset,
  normalizeParticleVFXTransform,
  resolveParticleVFXAvatarBoundsRectangleFit,
  resolveParticleVFXAnchorLocalPosition,
} from "@/lib/avatar/particle-vfx";
import type { ParticleVFXCatalogEntry } from "@/lib/avatar/particle-vfx";
import { EMPTY_RUNTIME_MEDIA_PROVIDER } from "@/lib/runtime-content/AnimaRuntimeMediaCatalog";

/**
 * The Included Particle Effects (their `content/included/vfx/particle/quark/`
 * folder stems), which the catalog reads from their descriptors.
 */
const INCLUDED_PARTICLE_VFX_IDS = [
  "aroma-ribbons",
  "butterfly-flutter",
  "buzzing-flies",
  "cheer-streamers",
  "cold-breeze",
  "confetti",
  "dizzy-stars",
  "drifting-leaves",
  "electric-crackle",
  "energy-wave-charge",
  "fireworks-show",
  "flower-pop",
  "fright-jolt",
  "fume-puffs",
  "gloom-wisps",
  "golden-aura",
  "golden-willow",
  "halo-rays",
  "heart-burst",
  "heart-fireworks",
  "hearts-v1",
  "musical-cascade",
  "overheat-steam",
  "petal-drift",
  "question-orbit",
  "rage-aura",
  "rage-embers",
  "rain-cloud",
  "snow-crystal-flurry",
  "sparkle-bubbles",
  "sparkle-hearts",
  "spit-spray-mist",
  "star-burst",
  "stink-miasma",
  "sweat-spray",
  "ta-da-glitter",
  "twinkle-shimmer",
] as const;

function fixtureEntry(
  entry: Omit<ParticleVFXCatalogEntry, "defaultFollowAnchor" | "assetPath">,
): ParticleVFXCatalogEntry {
  return {
    ...entry,
    defaultFollowAnchor: true,
    assetPath: `/effects/vfx/quark/${entry.id}/particle.json`,
  };
}

/**
 * Controller fixtures, independent of the Included library: a short head
 * burst and a second tier-A effect, and a looping chest effect that allows
 * manual lifetime.
 */
const TEST_PARTICLE_VFX_CATALOG: ParticleVFXCatalogEntry[] = [
  fixtureEntry({
    id: "heart-fixture",
    label: "Heart fixture",
    description: "A short head burst.",
    defaultAnchor: "head",
    defaultDurationSec: 1.8,
    defaultTransform: normalizeParticleVFXTransform({
      offset: { y: 0.32 },
      depthOffset: 0.12,
    }),
    preloadTier: "tierA",
    performanceBudget: {
      maxDurationSec: 2.2,
      maxParticles: 8,
      loopingAllowed: false,
      canCoexist: true,
    },
  }),
  fixtureEntry({
    id: "star-fixture",
    label: "Star fixture",
    description: "A second tier-A head burst.",
    defaultAnchor: "head",
    defaultDurationSec: 1.4,
    defaultTransform: normalizeParticleVFXTransform({
      offset: { y: 0.26 },
      depthOffset: 0.1,
    }),
    preloadTier: "tierA",
    performanceBudget: {
      maxDurationSec: 1.8,
      maxParticles: 10,
      loopingAllowed: false,
      canCoexist: true,
    },
  }),
  fixtureEntry({
    id: "loop-fixture",
    label: "Loop fixture",
    description: "A looping chest aura that allows manual lifetime.",
    defaultAnchor: "chest",
    defaultDurationSec: 8,
    defaultTransform: normalizeParticleVFXTransform({
      offset: { y: 0.06 },
      depthOffset: 0.08,
      scale: { x: 0.88, y: 0.88, z: 0.88 },
    }),
    preloadTier: "none",
    performanceBudget: {
      maxDurationSec: 30,
      maxParticles: 64,
      loopingAllowed: true,
      canCoexist: false,
    },
  }),
];

function testParticleEntry(effectId: string): ParticleVFXCatalogEntry {
  const entry = TEST_PARTICLE_VFX_CATALOG.find(
    (candidate) => candidate.id === effectId,
  );
  if (!entry) throw new Error(`Missing particle fixture ${effectId}.`);
  return entry;
}

const TEST_PARTICLE_MEDIA_PROVIDER = {
  ...EMPTY_RUNTIME_MEDIA_PROVIDER,
  listParticleVFX: () => TEST_PARTICLE_VFX_CATALOG,
  getParticlePreloadIds: (tier: "tierA" | "tierB" | "none") =>
    TEST_PARTICLE_VFX_CATALOG.filter((entry) => entry.preloadTier === tier).map(
      (entry) => entry.id,
    ),
  resolveParticleVFX: async (runtimeId: string) =>
    TEST_PARTICLE_VFX_CATALOG.find((entry) => entry.id === runtimeId) ?? null,
};

type CatalogQuarksJson = {
  images?: Array<{ url?: string }>;
  materials?: Array<{ uuid?: string; blending?: number }>;
  object?: {
    children?: Array<{
      name?: string;
      ps?: {
        looping?: boolean;
        prewarm?: boolean;
        renderMode?: number;
        rendererEmitterSettings?: Record<string, unknown>;
        uTileCount?: number;
        vTileCount?: number;
        behaviors?: Array<{ type?: string }>;
      };
    }>;
  };
};

type MockParticleSystem = {
  worldSpace: boolean;
  autoDestroy: boolean;
  emitterShape: {
    type: string;
    width?: number;
    height?: number;
  };
  emitter: MockParticleEmitter | null;
  _renderer: { deleteSystem: (system: MockParticleSystem) => void } | null;
  clone: () => MockParticleSystem;
  getRendererSettings: () => { material: { toneMapped?: boolean } };
  dispose: ReturnType<typeof vi.fn>;
  play: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
};

type MockLoadQueueItem =
  | { kind: "resolve"; object: Object3D }
  | { kind: "reject"; error: unknown };

type MockBatch = Object3D & {
  dispose: ReturnType<typeof vi.fn>;
  material: MeshBasicMaterial;
  settings: { material: MeshBasicMaterial };
};

type MockBatchRenderer = Object3D & {
  systems: Set<MockParticleSystem>;
  batches: MockBatch[];
  addSystem: (system: MockParticleSystem) => void;
  deleteSystem: (system: MockParticleSystem) => void;
  update: ReturnType<typeof vi.fn>;
};

const quarksMockState = vi.hoisted(() => ({
  createdSystems: [] as MockParticleSystem[],
  lastBatchRenderer: null as MockBatchRenderer | null,
  loadAttempts: 0,
  loadAssetPaths: [] as string[],
  loadQueue: [] as MockLoadQueueItem[],
  playThrows: false,
}));

vi.mock("three.quarks", async () => {
  const THREE = await vi.importActual<typeof import("three")>("three");

  class BatchedRenderer extends THREE.Object3D implements MockBatchRenderer {
    systems = new Set<MockParticleSystem>();
    batches: MockBatch[] = [];
    update = vi.fn();

    constructor() {
      super();
      quarksMockState.lastBatchRenderer = this;
    }

    addSystem(system: MockParticleSystem) {
      system._renderer = this;
      this.systems.add(system);
      if (this.batches.length === 0) {
        const batch = new THREE.Object3D() as MockBatch;
        batch.dispose = vi.fn();
        batch.material = new THREE.MeshBasicMaterial();
        batch.settings = { material: batch.material };
        this.batches.push(batch);
        this.add(batch);
      }
    }

    deleteSystem(system: MockParticleSystem) {
      this.systems.delete(system);
      system._renderer = null;
    }
  }

  class QuarksLoader {
    load(
      assetPath: string,
      onLoad: (object: Object3D) => void,
      _onProgress?: unknown,
      onError?: (error: unknown) => void,
    ) {
      quarksMockState.loadAttempts += 1;
      quarksMockState.loadAssetPaths.push(assetPath);
      const item = quarksMockState.loadQueue.shift();
      if (!item) {
        onError?.(new Error("No mock particle VFX load queued."));
        return;
      }
      if (item.kind === "reject") {
        onError?.(item.error);
        return;
      }
      onLoad(item.object);
    }
  }

  const QuarksUtil = {
    runOnAllParticleEmitters(
      object: Object3D,
      callback: (emitter: MockParticleEmitter) => void,
    ) {
      object.traverse((child) => {
        if (child.type === "ParticleEmitter") {
          callback(child as MockParticleEmitter);
        }
      });
    },
    addToBatchRenderer(object: Object3D, batchRenderer: MockBatchRenderer) {
      QuarksUtil.runOnAllParticleEmitters(object, (emitter) => {
        batchRenderer.addSystem(emitter.system);
      });
    },
    setAutoDestroy(object: Object3D, value: boolean) {
      QuarksUtil.runOnAllParticleEmitters(object, (emitter) => {
        emitter.system.autoDestroy = value;
      });
    },
    play(object: Object3D) {
      if (quarksMockState.playThrows) {
        throw new Error("mock play failed");
      }
      QuarksUtil.runOnAllParticleEmitters(object, (emitter) => {
        emitter.system.play();
      });
    },
    stop(object: Object3D) {
      QuarksUtil.runOnAllParticleEmitters(object, (emitter) => {
        emitter.system.stop();
      });
    },
  };

  return { BatchedRenderer, QuarksLoader, QuarksUtil };
});

class MockParticleEmitter extends Object3D {
  override type = "ParticleEmitter";
  system: MockParticleSystem;

  constructor(system: MockParticleSystem) {
    super();
    this.system = system;
    system.emitter = this;
  }

  override clone(): this {
    const emitter = new MockParticleEmitter(this.system.clone());
    emitter.copy(this, false);
    return emitter as this;
  }
}

function createMockAvatar(
  bones: Record<string, Vector3>,
): Pick<Avatar, "scene" | "vrm"> {
  const scene = new Group();
  const boneNodes = new Map<string, Object3D>();

  for (const [boneName, position] of Object.entries(bones)) {
    const node = new Object3D();
    node.position.copy(position);
    scene.add(node);
    boneNodes.set(boneName, node);
  }
  scene.updateMatrixWorld(true);

  return {
    scene,
    vrm: {
      humanoid: {
        getNormalizedBoneNode: (boneName: string) =>
          boneNodes.get(boneName) ?? null,
      },
    } as never,
  } as Pick<Avatar, "scene" | "vrm">;
}

function createMockParticleSystem(
  worldSpace: boolean,
  emitterShape: MockParticleSystem["emitterShape"] = { type: "sphere" },
): MockParticleSystem {
  const system: MockParticleSystem = {
    worldSpace,
    autoDestroy: true,
    emitterShape: { ...emitterShape },
    emitter: null,
    _renderer: null,
    clone: () => {
      const cloned = createMockParticleSystem(worldSpace, system.emitterShape);
      quarksMockState.createdSystems.push(cloned);
      return cloned;
    },
    // Tone-mapped like every Included effect, so batching stays stock.
    getRendererSettings: () => ({ material: { toneMapped: true } }),
    dispose: vi.fn(() => {
      system._renderer?.deleteSystem(system);
      system.emitter?.parent?.remove(system.emitter);
    }),
    play: vi.fn(),
    stop: vi.fn(),
  };
  return system;
}

function createMockQuarksPrefab(
  options: {
    worldSpace?: boolean;
    emitterShape?: MockParticleSystem["emitterShape"];
    emitterName?: string;
  } = {},
): Object3D {
  const prefab = new Group();
  const system = createMockParticleSystem(
    options.worldSpace ?? false,
    options.emitterShape,
  );
  const emitter = new MockParticleEmitter(system);
  if (options.emitterName) emitter.name = options.emitterName;
  prefab.add(emitter);
  return prefab;
}

function resetQuarksMockState() {
  quarksMockState.createdSystems = [];
  quarksMockState.lastBatchRenderer = null;
  quarksMockState.loadAttempts = 0;
  quarksMockState.loadAssetPaths = [];
  quarksMockState.loadQueue = [];
  quarksMockState.playThrows = false;
  vi.clearAllMocks();
}

const INCLUDED_PARTICLE_VFX_ROOT = new URL(
  "../../../../../content/included/vfx/particle/",
  import.meta.url,
);

function includedParticleVfxFile(publicPath: string): URL {
  const aliases = [
    ["/effects/vfx/quark/", "quark/"],
    ["/effects/vfx/particle-vfx/", "particle-vfx/"],
  ] as const;
  for (const [routePrefix, includedPrefix] of aliases) {
    if (publicPath.startsWith(routePrefix)) {
      return new URL(
        `${includedPrefix}${publicPath.slice(routePrefix.length)}`,
        INCLUDED_PARTICLE_VFX_ROOT,
      );
    }
  }
  throw new Error(`Unmapped Included particle VFX URL: ${publicPath}`);
}

function readCatalogQuarksJson(effectId: string): CatalogQuarksJson {
  const entry = getParticleVFXCatalogEntryById(effectId);
  expect(entry).toBeTruthy();
  const jsonPath = includedParticleVfxFile(entry?.assetPath ?? "");
  return JSON.parse(readFileSync(jsonPath, "utf8")) as CatalogQuarksJson;
}

function collectCatalogQuarksImageUrls(json: CatalogQuarksJson): Set<string> {
  return new Set((json.images ?? []).map((image) => image.url ?? ""));
}

beforeEach(() => {
  resetQuarksMockState();
});

describe("particle VFX catalog", () => {
  it("lists every Included Particle Effect, read from its descriptor", () => {
    const ids = AVATAR_PARTICLE_VFX_CATALOG.map((entry) => entry.id);
    expect(ids).toEqual(INCLUDED_PARTICLE_VFX_IDS);
    expect(getParticleVFXCatalogEntryById("heart-burst")).toEqual({
      id: "heart-burst",
      label: "Heart Burst",
      description: expect.stringContaining("heart"),
      assetPath: "/effects/vfx/quark/heart-burst/particle.json",
      defaultAnchor: "chest",
      defaultDurationSec: 2.5,
      defaultFollowAnchor: true,
      defaultTransform: expect.any(Object),
      preloadTier: "none",
      performanceBudget: {
        maxDurationSec: 3,
        maxParticles: 38,
        loopingAllowed: false,
        canCoexist: true,
      },
    });
    expect(getParticleVFXCatalogEntryById("hearts-v1")).toMatchObject({
      defaultAnchor: "head",
      defaultDurationSec: 5.1,
      defaultTransform: {
        offset: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
      },
      preloadTier: "none",
      performanceBudget: { maxDurationSec: 5.1, loopingAllowed: false },
    });
    expect(getParticleVFXCatalogEntryById("missing-effect")).toBeNull();
  });

  it("keeps each descriptor's stored runtime defaults", () => {
    for (const id of INCLUDED_PARTICLE_VFX_IDS) {
      const descriptor = JSON.parse(
        readFileSync(
          new URL(`quark/${id}/${id}.json`, INCLUDED_PARTICLE_VFX_ROOT),
          "utf8",
        ),
      ) as {
        runtime_defaults: {
          runtime_id: string;
          slots: { particle_vfx: Record<string, unknown> };
        };
      };
      const slot = descriptor.runtime_defaults.slots.particle_vfx;
      expect(descriptor.runtime_defaults.runtime_id).toBe(id);
      expect(getParticleVFXCatalogEntryById(id), id).toMatchObject({
        label: slot.label,
        description: slot.description,
        defaultAnchor: slot.anchor,
        defaultDurationSec: slot.duration_seconds,
        performanceBudget: {
          maxDurationSec: slot.max_duration_seconds,
          maxParticles: slot.max_particles,
          loopingAllowed: slot.looping_allowed,
          canCoexist: slot.can_coexist,
        },
      });
    }
  });

  it("uses root-relative public asset paths", () => {
    for (const entry of AVATAR_PARTICLE_VFX_CATALOG) {
      expect(entry.assetPath).toMatch(/^\/.+/);
      expect(entry.assetPath.trim()).toBe(entry.assetPath);
      expect(entry.assetPath).not.toContain("brackeys_vfx_bundle");
      expect(entry.assetPath).not.toContain("kenney_particle-pack");
      expect(entry.assetPath).not.toContain("LeLu");
    }
  });

  it("points every catalog entry at an existing public quarks JSON asset", () => {
    for (const entry of AVATAR_PARTICLE_VFX_CATALOG) {
      const jsonPath = includedParticleVfxFile(entry.assetPath);
      expect(existsSync(jsonPath), entry.assetPath).toBe(true);
    }
  });

  it("declares preload tiers and conservative performance budgets", () => {
    for (const entry of AVATAR_PARTICLE_VFX_CATALOG) {
      expect(["tierA", "none"]).toContain(entry.preloadTier);
      expect(entry.performanceBudget.maxDurationSec).toBeGreaterThanOrEqual(
        entry.defaultDurationSec,
      );
      expect(entry.performanceBudget.maxParticles).toBeGreaterThan(0);
      expect(typeof entry.performanceBudget.canCoexist).toBe("boolean");
    }
    // Only the sustained aroma and steam effects loop; all load on demand.
    expect(
      AVATAR_PARTICLE_VFX_CATALOG.filter(
        (entry) => entry.performanceBudget.loopingAllowed,
      ).map((entry) => entry.id),
    ).toEqual(["aroma-ribbons", "overheat-steam"]);
    expect(
      AVATAR_PARTICLE_VFX_CATALOG.filter(
        (entry) => entry.preloadTier === "tierA",
      ).map((entry) => entry.id),
    ).toEqual([]);
  });

  it("uses runtime-safe relative texture urls in catalog quarks JSON", () => {
    for (const entry of AVATAR_PARTICLE_VFX_CATALOG) {
      const jsonPath = includedParticleVfxFile(entry.assetPath);
      const json = JSON.parse(readFileSync(jsonPath, "utf8")) as {
        images?: Array<{ url?: string }>;
      };

      expect(json.images?.length).toBeGreaterThan(0);
      for (const image of json.images ?? []) {
        expect(typeof image.url).toBe("string");
        expect(classifyParticleVFXTextureUrl(image.url ?? "")).toBe("relative");
        expect(image.url).toMatch(/^textures\/[\w.-]+$/);
        const texturePath = new URL(image.url ?? "", jsonPath);
        expect(existsSync(texturePath), image.url).toBe(true);
        expect(texturePath.pathname).toContain(
          "/content/included/vfx/particle/quark/",
        );
        expect(texturePath.pathname).toContain("/textures/");
        expect(image.url).not.toContain("brackeys_vfx_bundle");
        expect(image.url).not.toContain("kenney_particle-pack");
        expect(image.url).not.toContain("LeLu");
      }
    }
  });

  it("authors layered Included effects within the emitter limit", () => {
    for (const id of INCLUDED_PARTICLE_VFX_IDS) {
      const json = readCatalogQuarksJson(id);
      const emitters = (json.object?.children ?? []).filter(
        (child) => child.ps,
      );
      expect(emitters.length, id).toBeGreaterThanOrEqual(1);
      expect(emitters.length, id).toBeLessThanOrEqual(16);
    }
    expect(
      collectCatalogQuarksImageUrls(readCatalogQuarksJson("heart-burst")),
    ).toEqual(
      new Set([
        "textures/glint-star.png",
        "textures/glossy-heart.png",
        "textures/heart-glow.png",
        "textures/heart-ring.png",
      ]),
    );
  });
});

describe("particle VFX avatar-bounds auto-fit helpers", () => {
  it("computes local avatar bounds while skipping particle VFX roots", () => {
    const avatar = createMockAvatar({}) as Avatar;
    const avatarMesh = new Mesh(
      new BoxGeometry(0.4, 1.2, 0.2),
      new MeshBasicMaterial(),
    );
    avatarMesh.position.set(0.2, 0.6, 0.1);
    avatar.scene?.add(avatarMesh);

    const particleRoot = new Group();
    particleRoot.name = PARTICLE_VFX_ROOT_OBJECT_NAME;
    particleRoot.add(
      new Mesh(new BoxGeometry(99, 99, 99), new MeshBasicMaterial()),
    );
    avatar.scene?.add(particleRoot);

    const result = resolveParticleVFXAvatarBoundsRectangleFit({
      avatar,
      transform: normalizeParticleVFXTransform({
        offset: { x: 0.1, y: 0.2, z: 0.3 },
        depthOffset: 0.4,
        scale: { x: 2, y: 1, z: 1 },
      }),
      shapeAutoFit: {
        kind: "avatarBoundsRectangle",
        padding: { width: 0.2, height: 0.1 },
        minSize: { width: 0.1, height: 0.1 },
      },
    });

    expect(result.warning).toBeNull();
    expect(result.fit?.bounds.center.x).toBeCloseTo(0.2);
    expect(result.fit?.bounds.center.y).toBeCloseTo(0.6);
    expect(result.fit?.bounds.size.x).toBeCloseTo(0.4);
    expect(result.fit?.bounds.size.y).toBeCloseTo(1.2);
    expect(result.fit?.width).toBeCloseTo(0.3);
    expect(result.fit?.height).toBeCloseTo(1.3);
    expect(result.fit?.position.x).toBeCloseTo(0.3);
    expect(result.fit?.position.y).toBeCloseTo(0.8);
    expect(result.fit?.position.z).toBeCloseTo(0.8);
  });

  it("patches only matching rectangle emitter shapes", () => {
    const object = new Group();
    const rectangleSystem = createMockParticleSystem(false, {
      type: "rectangle",
      width: 1,
      height: 1,
    });
    const rectangleEmitter = new MockParticleEmitter(rectangleSystem);
    rectangleEmitter.name = "target";
    const otherRectangleSystem = createMockParticleSystem(false, {
      type: "rectangle",
      width: 1,
      height: 1,
    });
    const otherRectangleEmitter = new MockParticleEmitter(otherRectangleSystem);
    otherRectangleEmitter.name = "other";
    const sphereSystem = createMockParticleSystem(false, { type: "sphere" });
    const sphereEmitter = new MockParticleEmitter(sphereSystem);
    sphereEmitter.name = "target";
    object.add(rectangleEmitter, otherRectangleEmitter, sphereEmitter);

    const patchedCount = applyParticleVFXRectangleShapeAutoFit({
      object,
      shapeAutoFit: {
        kind: "avatarBoundsRectangle",
        emitterNames: ["target"],
      },
      width: 0.8,
      height: 1.9,
    });

    expect(patchedCount).toBe(1);
    expect(rectangleSystem.emitterShape).toMatchObject({
      width: 0.8,
      height: 1.9,
    });
    expect(otherRectangleSystem.emitterShape).toMatchObject({
      width: 1,
      height: 1,
    });
    expect(sphereSystem.emitterShape).toEqual({ type: "sphere" });
  });
});

describe("ParticleVFXController", () => {
  it("auto-fits rectangle emitters from avatar rendered bounds at play time", async () => {
    const avatar = createMockAvatar({ head: new Vector3(0, 1.5, 0) }) as Avatar;
    const avatarMesh = new Mesh(
      new BoxGeometry(0.5, 1.8, 0.2),
      new MeshBasicMaterial(),
    );
    avatarMesh.position.set(0.1, 0.9, 0);
    avatar.scene?.add(avatarMesh);
    avatar.scene?.updateMatrixWorld(true);

    const effect = testParticleEntry("heart-fixture");
    const previousShapeAutoFit = effect.shapeAutoFit;
    effect.shapeAutoFit = {
      kind: "avatarBoundsRectangle",
      padding: { width: 0.2, height: 0.1 },
      minSize: { width: 0.1, height: 0.1 },
      emitterNames: ["fitted"],
    };

    const controller = new ParticleVFXController(
      avatar,
      TEST_PARTICLE_MEDIA_PROVIDER,
    );
    const prefab = createMockQuarksPrefab({
      emitterName: "fitted",
      emitterShape: { type: "rectangle", width: 1, height: 1 },
    });
    const unrelated = new MockParticleEmitter(createMockParticleSystem(false));
    unrelated.name = "unrelated";
    unrelated.position.x = 0.25;
    unrelated.userData.animamaParticleAnchor = "root";
    const otherRectangle = new MockParticleEmitter(
      createMockParticleSystem(false, {
        type: "rectangle",
        width: 0.3,
        height: 0.4,
      }),
    );
    otherRectangle.name = "unselected-rectangle";
    prefab.add(unrelated, otherRectangle);
    quarksMockState.loadQueue.push({ kind: "resolve", object: prefab });

    try {
      await expect(
        controller.playEffect({
          effectId: "heart-fixture",
          appliedId: "auto-fit-burst",
        }),
      ).resolves.toBe(true);

      expect(quarksMockState.createdSystems[0]?.emitterShape.type).toBe(
        "rectangle",
      );
      expect(quarksMockState.createdSystems[0]?.emitterShape.width).toBeCloseTo(
        0.7,
      );
      expect(
        quarksMockState.createdSystems[0]?.emitterShape.height,
      ).toBeCloseTo(1.9);
      const root = avatar.scene?.getObjectByName(PARTICLE_VFX_ROOT_OBJECT_NAME);
      const object = root?.children.find((child) =>
        child.name.startsWith("ParticleVFX:heart-fixture:auto-fit-burst"),
      );
      expect(object?.position.x).toBeCloseTo(0);
      expect(object?.position.y).toBeCloseTo(1.82);
      expect(object?.position.z).toBeCloseTo(0.12);
      const unselected = object?.getObjectByName(
        "unselected-rectangle",
      ) as MockParticleEmitter;
      expect(unselected.system.emitterShape).toMatchObject({
        width: 0.3,
        height: 0.4,
      });
      const unrelatedLocal = avatar.scene!.worldToLocal(
        object!.getObjectByName("unrelated")!.getWorldPosition(new Vector3()),
      );
      expect(unrelatedLocal.x).toBeCloseTo(0.25);
      expect(unrelatedLocal.y).toBeCloseTo(0.32);
      expect(controller.getSnapshot().activeInstances[0]?.followAnchor).toBe(
        true,
      );
    } finally {
      effect.shapeAutoFit = previousShapeAutoFit;
      controller.dispose();
    }
  });

  it("follows independent emitter anchors in one instance and cleans every system on stop", async () => {
    const avatar = createMockAvatar({
      head: new Vector3(0, 1.5, 0),
      leftHand: new Vector3(0.6, 0.8, 0),
    }) as Avatar;
    const prefab = createMockQuarksPrefab();
    const headEmitter = prefab.children[0]!;
    headEmitter.name = "head-sparkles";
    headEmitter.position.y = 0.1;
    const handEmitter = new MockParticleEmitter(
      createMockParticleSystem(false),
    );
    handEmitter.name = "hand-particles";
    handEmitter.userData.animamaParticleAnchor = "leftHand";
    handEmitter.position.x = 0.2;
    prefab.add(handEmitter);
    quarksMockState.loadQueue.push({ kind: "resolve", object: prefab });
    const controller = new ParticleVFXController(
      avatar,
      TEST_PARTICLE_MEDIA_PROVIDER,
    );
    await expect(
      controller.playEffect({
        effectId: "heart-fixture",
        appliedId: "gesture-event",
        ownerId: "gesture",
        anchor: "head",
      }),
    ).resolves.toBe(true);
    const root = avatar.scene!.getObjectByName(PARTICLE_VFX_ROOT_OBJECT_NAME)!;
    const instance = root.children.find((child) =>
      child.name.startsWith("ParticleVFX:"),
    )!;
    const local = (name: string) =>
      avatar.scene!.worldToLocal(
        instance.getObjectByName(name)!.getWorldPosition(new Vector3()),
      );
    expect(local("head-sparkles").y).toBeCloseTo(1.92);
    expect(local("hand-particles").x).toBeCloseTo(0.8);
    expect(local("hand-particles").y).toBeCloseTo(1.12);
    avatar.vrm!.humanoid.getNormalizedBoneNode("head")!.position.y = 1.8;
    avatar.vrm!.humanoid.getNormalizedBoneNode("leftHand")!.position.x = 0.9;
    controller.update(0.1);
    expect(local("head-sparkles").y).toBeCloseTo(2.22);
    expect(local("hand-particles").x).toBeCloseTo(1.1);
    expect(local("hand-particles").y).toBeCloseTo(1.12);
    expect(controller.clearEffect("gesture-event")).toBe(true);
    expect(instance.parent).toBeNull();
    expect(quarksMockState.lastBatchRenderer?.systems.size).toBe(0);
    expect(quarksMockState.createdSystems).toHaveLength(2);
    for (const system of quarksMockState.createdSystems)
      expect(system.dispose).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it("falls back to anchor placement when auto-fit finds no rectangle emitters", async () => {
    const avatar = createMockAvatar({ head: new Vector3(0, 1.5, 0) }) as Avatar;
    avatar.scene?.add(
      new Mesh(new BoxGeometry(0.5, 1.8, 0.2), new MeshBasicMaterial()),
    );

    const effect = testParticleEntry("heart-fixture");
    const previousShapeAutoFit = effect.shapeAutoFit;
    effect.shapeAutoFit = {
      kind: "avatarBoundsRectangle",
      minSize: { width: 0.1, height: 0.1 },
    };

    const controller = new ParticleVFXController(
      avatar,
      TEST_PARTICLE_MEDIA_PROVIDER,
    );
    quarksMockState.loadQueue.push({
      kind: "resolve",
      object: createMockQuarksPrefab({
        emitterShape: { type: "sphere" },
      }),
    });

    try {
      await expect(
        controller.playEffect({
          effectId: "heart-fixture",
          appliedId: "fallback-burst",
        }),
      ).resolves.toBe(true);

      const root = avatar.scene?.getObjectByName(PARTICLE_VFX_ROOT_OBJECT_NAME);
      const object = root?.children.find((child) =>
        child.name.startsWith("ParticleVFX:heart-fixture:fallback-burst"),
      );
      expect(object?.position.y).toBeCloseTo(1.82);
      expect(controller.getSnapshot().activeInstances[0]?.followAnchor).toBe(
        true,
      );
      expect(controller.getSnapshot().warnings.join("\n")).toContain(
        "no matching rectangle emitters",
      );
    } finally {
      effect.shapeAutoFit = previousShapeAutoFit;
      controller.dispose();
    }
  });

  it("preloads an effect without creating an active instance", async () => {
    const avatar = createMockAvatar({ head: new Vector3(0, 1.5, 0) }) as Avatar;
    const controller = new ParticleVFXController(
      avatar,
      TEST_PARTICLE_MEDIA_PROVIDER,
    );
    quarksMockState.loadQueue.push({
      kind: "resolve",
      object: createMockQuarksPrefab(),
    });

    await expect(controller.preloadEffect("heart-fixture")).resolves.toBe(true);

    const snapshot = controller.getSnapshot();
    expect(snapshot.activeCount).toBe(0);
    expect(snapshot.loadedEffectIds).toContain("heart-fixture");
    expect(quarksMockState.loadAssetPaths).toEqual([
      "/effects/vfx/quark/heart-fixture/particle.json",
    ]);
    controller.dispose();
  });

  it("retries preloading after a previous load failure", async () => {
    const avatar = createMockAvatar({ head: new Vector3(0, 1.5, 0) }) as Avatar;
    const controller = new ParticleVFXController(
      avatar,
      TEST_PARTICLE_MEDIA_PROVIDER,
    );
    quarksMockState.loadQueue.push({
      kind: "reject",
      error: new Error("temporary preload error"),
    });

    await expect(controller.preloadEffect("star-fixture")).resolves.toBe(false);
    expect(quarksMockState.loadAttempts).toBe(1);

    quarksMockState.loadQueue.push({
      kind: "resolve",
      object: createMockQuarksPrefab(),
    });

    await expect(controller.preloadEffect("star-fixture")).resolves.toBe(true);
    expect(quarksMockState.loadAttempts).toBe(2);
    expect(controller.getSnapshot().loadedEffectIds).toContain("star-fixture");
    controller.dispose();
  });

  it("preloads tier-A catalog entries with a bounded result", async () => {
    const avatar = createMockAvatar({ head: new Vector3(0, 1.5, 0) }) as Avatar;
    const controller = new ParticleVFXController(
      avatar,
      TEST_PARTICLE_MEDIA_PROVIDER,
    );
    const tierAEntries = TEST_PARTICLE_VFX_CATALOG.filter(
      (entry) => entry.preloadTier === "tierA",
    );
    for (let index = 0; index < tierAEntries.length; index += 1) {
      quarksMockState.loadQueue.push({
        kind: "resolve",
        object: createMockQuarksPrefab(),
      });
    }

    await expect(
      controller.preloadCatalogTier("tierA", { concurrency: 2 }),
    ).resolves.toEqual({
      requestedCount: tierAEntries.length,
      loadedCount: tierAEntries.length,
      failedCount: 0,
    });
    expect(controller.getSnapshot().activeCount).toBe(0);
    expect(controller.getSnapshot().loadedEffectIds).toEqual(
      tierAEntries.map((entry) => entry.id).sort(),
    );
    expect(quarksMockState.loadAssetPaths).not.toContain(
      "/effects/vfx/quark/loop-fixture/particle.json",
    );
    controller.dispose();
  });

  it("counts slow pending effects against the four-instance limit", async () => {
    const avatar = createMockAvatar({ head: new Vector3(0, 1.5, 0) }) as Avatar;
    const controller = new ParticleVFXController(
      avatar,
      TEST_PARTICLE_MEDIA_PROVIDER,
    );
    let resolvePrefab: ((object: Object3D) => void) | null = null;
    const pendingPrefab = new Promise<Object3D>((resolve) => {
      resolvePrefab = resolve;
    });
    (
      controller as unknown as {
        _loadPrefab: () => Promise<Object3D>;
      }
    )._loadPrefab = vi.fn(() => pendingPrefab);

    const requests = Array.from({ length: 5 }, (_, index) =>
      controller.playEffect({
        effectId: "heart-fixture",
        appliedId: `pending-${index}`,
      }),
    );

    await expect(requests[4]).resolves.toBe(false);
    expect(controller.getSnapshot().warnings.join("\n")).toContain(
      "concurrency limit",
    );

    controller.clearAll();
    resolvePrefab?.(createMockQuarksPrefab());
    await expect(Promise.all(requests.slice(0, 4))).resolves.toEqual([
      false,
      false,
      false,
      false,
    ]);
    controller.dispose();
  });

  it("counts slow pending effects against the total particle budget", async () => {
    const avatar = createMockAvatar({ head: new Vector3(0, 1.5, 0) }) as Avatar;
    const baseEffect = testParticleEntry("heart-fixture");
    const provider = {
      ...EMPTY_RUNTIME_MEDIA_PROVIDER,
      resolveParticleVFX: async () => ({
        ...baseEffect,
        performanceBudget: {
          ...baseEffect.performanceBudget,
          maxParticles: 200,
        },
      }),
    };
    const controller = new ParticleVFXController(avatar, provider);
    let resolvePrefab: ((object: Object3D) => void) | null = null;
    const pendingPrefab = new Promise<Object3D>((resolve) => {
      resolvePrefab = resolve;
    });
    (
      controller as unknown as {
        _loadPrefab: () => Promise<Object3D>;
      }
    )._loadPrefab = vi.fn(() => pendingPrefab);

    const first = controller.playEffect({
      effectId: "heart-fixture",
      appliedId: "budget-1",
    });
    const second = controller.playEffect({
      effectId: "heart-fixture",
      appliedId: "budget-2",
    });
    await expect(
      controller.playEffect({
        effectId: "heart-fixture",
        appliedId: "budget-3",
      }),
    ).resolves.toBe(false);
    expect(controller.getSnapshot().warnings.join("\n")).toContain(
      "active-particle budget",
    );

    controller.clearAll();
    resolvePrefab?.(createMockQuarksPrefab());
    await expect(Promise.all([first, second])).resolves.toEqual([false, false]);
    controller.dispose();
  });

  it("cleans up a partially attached effect when quarks play fails", async () => {
    const avatar = createMockAvatar({ head: new Vector3(0, 1.5, 0) }) as Avatar;
    const controller = new ParticleVFXController(
      avatar,
      TEST_PARTICLE_MEDIA_PROVIDER,
    );
    quarksMockState.loadQueue.push({
      kind: "resolve",
      object: createMockQuarksPrefab(),
    });
    quarksMockState.playThrows = true;

    const didApply = await controller.playEffect({
      effectId: "heart-fixture",
      appliedId: "failed-burst",
    });

    expect(didApply).toBe(false);
    expect(controller.getSnapshot().activeCount).toBe(0);
    expect(quarksMockState.lastBatchRenderer?.systems.size).toBe(0);
    expect(quarksMockState.createdSystems[0]?.dispose).toHaveBeenCalled();

    const root = avatar.scene?.getObjectByName("AnimamaParticleVFXRoot");
    expect(
      root?.children.some((child) => child.name.startsWith("ParticleVFX:")),
    ).toBe(false);
    controller.dispose();
  });

  it("retries a prefab load after a previous load failure", async () => {
    const avatar = createMockAvatar({ head: new Vector3(0, 1.5, 0) }) as Avatar;
    const controller = new ParticleVFXController(
      avatar,
      TEST_PARTICLE_MEDIA_PROVIDER,
    );
    quarksMockState.loadQueue.push({
      kind: "reject",
      error: new Error("temporary network error"),
    });

    await expect(
      controller.playEffect({
        effectId: "heart-fixture",
        appliedId: "retry-burst",
      }),
    ).resolves.toBe(false);
    expect(quarksMockState.loadAttempts).toBe(1);

    quarksMockState.loadQueue.push({
      kind: "resolve",
      object: createMockQuarksPrefab(),
    });

    await expect(
      controller.playEffect({
        effectId: "heart-fixture",
        appliedId: "retry-burst",
      }),
    ).resolves.toBe(true);
    expect(quarksMockState.loadAttempts).toBe(2);
    expect(controller.getSnapshot().activeCount).toBe(1);
    controller.dispose();
  });

  it("reports world-space effects and disables continuous anchor follow", async () => {
    const avatar = createMockAvatar({ head: new Vector3(0, 1.5, 0) }) as Avatar;
    const controller = new ParticleVFXController(
      avatar,
      TEST_PARTICLE_MEDIA_PROVIDER,
    );
    quarksMockState.loadQueue.push({
      kind: "resolve",
      object: createMockQuarksPrefab({ worldSpace: true }),
    });

    await expect(
      controller.playEffect({
        effectId: "heart-fixture",
        appliedId: "world-space-burst",
      }),
    ).resolves.toBe(true);

    const snapshot = controller.getSnapshot();
    expect(snapshot.activeInstances[0]).toMatchObject({
      appliedId: "world-space-burst",
      followAnchor: false,
      usesWorldSpace: true,
    });
    expect(snapshot.warnings.join("\n")).toContain("world-space emitters");
    controller.dispose();
  });

  it("disposes quarks batches when the controller is disposed", async () => {
    const avatar = createMockAvatar({ head: new Vector3(0, 1.5, 0) }) as Avatar;
    const controller = new ParticleVFXController(
      avatar,
      TEST_PARTICLE_MEDIA_PROVIDER,
    );
    quarksMockState.loadQueue.push({
      kind: "resolve",
      object: createMockQuarksPrefab(),
    });

    await expect(
      controller.playEffect({
        effectId: "heart-fixture",
        appliedId: "disposable-burst",
      }),
    ).resolves.toBe(true);
    const batch = quarksMockState.lastBatchRenderer?.batches[0];

    controller.dispose();

    expect(batch?.dispose).toHaveBeenCalled();
    expect(
      avatar.scene?.getObjectByName("AnimamaParticleVFXRoot"),
    ).toBeUndefined();
  });

  it("caps requested duration by catalog performance budget", async () => {
    const avatar = createMockAvatar({ head: new Vector3(0, 1.5, 0) }) as Avatar;
    const controller = new ParticleVFXController(
      avatar,
      TEST_PARTICLE_MEDIA_PROVIDER,
    );
    const burst = testParticleEntry("heart-fixture");
    quarksMockState.loadQueue.push({
      kind: "resolve",
      object: createMockQuarksPrefab(),
    });

    await expect(
      controller.playEffect({
        effectId: "heart-fixture",
        appliedId: "long-burst",
        durationSec: 99,
      }),
    ).resolves.toBe(true);

    const snapshot = controller.getSnapshot();
    expect(snapshot.activeInstances[0]?.durationSec).toBe(
      burst.performanceBudget.maxDurationSec,
    );
    expect(snapshot.warnings.join("\n")).toContain("duration was capped");
    controller.dispose();
  });

  it("keeps manual lifetime instances active until the applied id is cleared", async () => {
    const avatar = createMockAvatar({
      chest: new Vector3(0, 1.1, 0),
    }) as Avatar;
    const controller = new ParticleVFXController(
      avatar,
      TEST_PARTICLE_MEDIA_PROVIDER,
    );
    quarksMockState.loadQueue.push({
      kind: "resolve",
      object: createMockQuarksPrefab(),
    });

    await expect(
      controller.playEffect({
        effectId: "loop-fixture",
        appliedId: "manual-loop",
        lifetime: { kind: "manual" },
      }),
    ).resolves.toBe(true);

    controller.update(20);
    controller.update(20);

    let snapshot = controller.getSnapshot();
    expect(snapshot.activeCount).toBe(1);
    expect(snapshot.activeInstances[0]).toMatchObject({
      appliedId: "manual-loop",
      effectId: "loop-fixture",
      lifetime: { kind: "manual" },
      durationSec: null,
    });
    expect(quarksMockState.lastBatchRenderer?.update).toHaveBeenCalledTimes(2);

    expect(controller.clearEffect("manual-loop")).toBe(true);
    snapshot = controller.getSnapshot();
    expect(snapshot.activeCount).toBe(0);
    expect(quarksMockState.lastBatchRenderer?.systems.size).toBe(0);
    expect(quarksMockState.createdSystems[0]?.dispose).toHaveBeenCalled();
    controller.dispose();
  });

  it("removes manual lifetime instances through clearAll and dispose", async () => {
    const avatar = createMockAvatar({
      chest: new Vector3(0, 1.1, 0),
    }) as Avatar;
    const controller = new ParticleVFXController(
      avatar,
      TEST_PARTICLE_MEDIA_PROVIDER,
    );
    quarksMockState.loadQueue.push({
      kind: "resolve",
      object: createMockQuarksPrefab(),
    });

    await expect(
      controller.playEffect({
        effectId: "loop-fixture",
        appliedId: "manual-loop-clear-all",
        lifetime: { kind: "manual" },
      }),
    ).resolves.toBe(true);

    controller.clearAll();
    expect(controller.getSnapshot().activeCount).toBe(0);
    expect(quarksMockState.lastBatchRenderer?.systems.size).toBe(0);

    await expect(
      controller.playEffect({
        effectId: "loop-fixture",
        appliedId: "manual-loop-dispose",
        lifetime: { kind: "manual" },
      }),
    ).resolves.toBe(true);

    controller.dispose();
    expect(
      avatar.scene?.getObjectByName("AnimamaParticleVFXRoot"),
    ).toBeUndefined();
    expect(quarksMockState.lastBatchRenderer?.systems.size).toBe(0);
  });

  it("rejects manual lifetime for non-looping catalog entries", async () => {
    const avatar = createMockAvatar({ head: new Vector3(0, 1.5, 0) }) as Avatar;
    const controller = new ParticleVFXController(
      avatar,
      TEST_PARTICLE_MEDIA_PROVIDER,
    );

    await expect(
      controller.playEffect({
        effectId: "heart-fixture",
        appliedId: "manual-burst",
        lifetime: { kind: "manual" },
      }),
    ).resolves.toBe(false);

    expect(controller.getSnapshot().activeCount).toBe(0);
    expect(controller.getSnapshot().warnings.join("\n")).toContain(
      "does not allow looping",
    );
    expect(quarksMockState.loadAttempts).toBe(0);
    controller.dispose();
  });

  it("still expires duration-backed particle instances by elapsed time", async () => {
    const avatar = createMockAvatar({ head: new Vector3(0, 1.5, 0) }) as Avatar;
    const controller = new ParticleVFXController(
      avatar,
      TEST_PARTICLE_MEDIA_PROVIDER,
    );
    quarksMockState.loadQueue.push({
      kind: "resolve",
      object: createMockQuarksPrefab(),
    });

    await expect(
      controller.playEffect({
        effectId: "heart-fixture",
        appliedId: "short-burst",
        lifetime: { kind: "duration", durationSec: 0.2 },
      }),
    ).resolves.toBe(true);

    controller.update(0.1);
    expect(controller.getSnapshot().activeCount).toBe(1);
    controller.update(0.11);
    expect(controller.getSnapshot().activeCount).toBe(0);
    expect(quarksMockState.lastBatchRenderer?.systems.size).toBe(0);
    expect(quarksMockState.createdSystems[0]?.dispose).toHaveBeenCalled();
    controller.dispose();
  });
});

describe("particle VFX transforms", () => {
  it("normalizes default transform values", () => {
    expect(normalizeParticleVFXTransform(null)).toEqual({
      offset: { x: 0, y: 0, z: 0 },
      depthOffset: 0,
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    });
  });

  it("combines local z offset and depth offset for front/back placement", () => {
    const transform = normalizeParticleVFXTransform({
      offset: { x: 0.1, y: 0.2, z: 0.3 },
      depthOffset: -0.4,
    });

    const combinedOffset = getParticleVFXCombinedOffset(transform);
    expect(combinedOffset.x).toBeCloseTo(0.1);
    expect(combinedOffset.y).toBeCloseTo(0.2);
    expect(combinedOffset.z).toBeCloseTo(-0.1);
  });
});

describe("particle VFX anchor resolution", () => {
  it("resolves a direct head anchor", () => {
    const avatar = createMockAvatar({
      head: new Vector3(0, 1.5, 0),
    }) as Avatar;

    const result = resolveParticleVFXAnchorLocalPosition({
      avatar,
      anchor: "head",
      transform: normalizeParticleVFXTransform({
        offset: { y: 0.2 },
        depthOffset: 0.1,
      }),
    });

    expect(result).toMatchObject({
      requestedAnchor: "head",
      resolvedAnchor: "head",
      boneName: "head",
      position: { x: 0, y: 1.7, z: 0.1 },
      warning: null,
    });
  });

  it("falls back from chest to upperChest", () => {
    const avatar = createMockAvatar({
      upperChest: new Vector3(0.1, 1.2, 0.2),
    }) as Avatar;

    const result = resolveParticleVFXAnchorLocalPosition({
      avatar,
      anchor: "chest",
      transform: normalizeParticleVFXTransform(null),
    });

    expect(result).toMatchObject({
      requestedAnchor: "chest",
      resolvedAnchor: "chest",
      boneName: "upperChest",
      position: { x: 0.1, y: 1.2, z: 0.2 },
    });
    expect(result?.warning).toContain("fell back");
  });

  it("falls back to root when no candidate bone resolves", () => {
    const avatar = createMockAvatar({}) as Avatar;

    const result = resolveParticleVFXAnchorLocalPosition({
      avatar,
      anchor: "leftHand",
      transform: normalizeParticleVFXTransform({
        offset: { x: 0.2, y: 0.3, z: 0.4 },
        depthOffset: 0.5,
      }),
    });

    expect(result).toMatchObject({
      requestedAnchor: "leftHand",
      resolvedAnchor: "root",
      boneName: null,
      position: { x: 0.2, y: 0.3, z: 0.9 },
    });
    expect(result?.warning).toContain("fell back to root");
  });
});
