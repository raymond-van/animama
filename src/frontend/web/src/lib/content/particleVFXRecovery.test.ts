import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createParticleVFXEditorDraftFromBlank,
  setParticleVFXSimpleControl,
} from "@/lib/avatar/particle-vfx";
import { creatorRecoveryKey } from "./creatorRecoveryStore";
import {
  PARTICLE_VFX_RECOVERY_SCHEMA,
  particleVFXRecoveryStore,
} from "./particleVFXRecovery";

describe("Particle Effect recovery", () => {
  const values = new Map<string, string>();

  beforeEach(() => {
    values.clear();
    vi.stubGlobal("window", {
      indexedDB: undefined,
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("round-trips bounded authoring state for the current user", async () => {
    const draft = createParticleVFXEditorDraftFromBlank();
    const saved = await particleVFXRecoveryStore.save({
      schema: PARTICLE_VFX_RECOVERY_SCHEMA,
      userId: "user-a",
      documentKey: "new",
      source: null,
      operationId: "operation-a",
      fileOperationIds: ["operation-a-manifest", "operation-a-texture-1"],
      displayName: draft.catalog.label,
      catalog: draft.catalog,
      quarksJson: draft.quarksJson,
      textures: [],
      simple: null,
      updatedAt: "2026-08-09T12:00:00.000Z",
    });

    expect(saved).toEqual({
      stored: true,
      metadataOnly: false,
      warning: null,
    });
    expect(await particleVFXRecoveryStore.load("user-a", "new")).toMatchObject({
      operationId: "operation-a",
      fileOperationIds: ["operation-a-manifest", "operation-a-texture-1"],
    });
    expect(await particleVFXRecoveryStore.load("user-b", "new")).toBeNull();

    await particleVFXRecoveryStore.clear("user-a", "new");
    expect(await particleVFXRecoveryStore.load("user-a", "new")).toBeNull();
  });

  it("reports unavailable recovery without failing the ordinary save path", async () => {
    const draft = createParticleVFXEditorDraftFromBlank();
    vi.stubGlobal("window", {
      indexedDB: undefined,
      localStorage: {
        getItem: () => null,
        setItem: () => {
          throw new DOMException("Quota exceeded", "QuotaExceededError");
        },
        removeItem: () => undefined,
      },
    });

    const result = await particleVFXRecoveryStore.save({
      schema: PARTICLE_VFX_RECOVERY_SCHEMA,
      userId: "user-a",
      documentKey: "new",
      source: null,
      operationId: "operation-a",
      fileOperationIds: [],
      displayName: draft.catalog.label,
      catalog: draft.catalog,
      quarksJson: draft.quarksJson,
      textures: [],
      simple: null,
      updatedAt: "2026-08-09T12:00:00.000Z",
    });

    expect(result.stored).toBe(false);
    expect(result.warning).toContain("crash recovery is unavailable");
  });

  it("keeps texture bytes in the database record and drops them from the text fallback", async () => {
    const draft = createParticleVFXEditorDraftFromBlank();
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    const record = {
      schema: PARTICLE_VFX_RECOVERY_SCHEMA,
      userId: "user-a",
      documentKey: "new",
      source: null,
      operationId: "operation-a",
      fileOperationIds: [],
      displayName: draft.catalog.label,
      catalog: draft.catalog,
      quarksJson: draft.quarksJson,
      textures: [
        {
          reference: "textures/glyph-1.png",
          blob,
          sha256: "a".repeat(64),
          width: 8,
          height: 8,
        },
      ],
      simple: null,
      updatedAt: "2026-10-09T12:00:00.000Z",
    } as const;

    const saved = await particleVFXRecoveryStore.save(record);
    expect(saved.metadataOnly).toBe(true);
    expect(saved.warning).toContain("Choose the missing textures again");
    expect(await particleVFXRecoveryStore.load("user-a", "new")).toMatchObject({
      textures: [],
      operationId: "operation-a",
    });
  });

  it("restores drafts saved before records carried textures", async () => {
    const draft = createParticleVFXEditorDraftFromBlank();
    values.set(
      `anima.particleVfxCreator.recovery.v1:${creatorRecoveryKey("user-a", "new")}`,
      JSON.stringify({
        schema: "animama/particle-effect-recovery/2",
        userId: "user-a",
        documentKey: "new",
        source: null,
        operationId: "operation-old",
        fileOperationIds: [],
        displayName: "Old draft",
        catalog: draft.catalog,
        quarksJson: draft.quarksJson,
        updatedAt: "2026-08-09T12:00:00.000Z",
      }),
    );
    const loaded = await particleVFXRecoveryStore.load("user-a", "new");
    expect(loaded).toMatchObject({
      schema: PARTICLE_VFX_RECOVERY_SCHEMA,
      operationId: "operation-old",
      textures: [],
      simple: null,
    });
  });

  it("keeps Simple's reference and control positions", async () => {
    const draft = setParticleVFXSimpleControl(
      setParticleVFXSimpleControl(
        createParticleVFXEditorDraftFromBlank(),
        "amount",
        200,
      ),
      "speed",
      150,
    );
    await particleVFXRecoveryStore.save({
      schema: PARTICLE_VFX_RECOVERY_SCHEMA,
      userId: "user-a",
      documentKey: "new",
      source: null,
      operationId: "operation-a",
      fileOperationIds: [],
      displayName: draft.catalog.label,
      catalog: draft.catalog,
      quarksJson: draft.quarksJson,
      textures: [],
      simple: draft.simple,
      updatedAt: "2026-10-13T12:00:00.000Z",
    });

    const loaded = await particleVFXRecoveryStore.load("user-a", "new");
    expect(loaded?.simple).toEqual(draft.simple);
    expect(loaded?.simple?.factors).toEqual({
      amount: 200,
      size: 100,
      speed: 150,
      spread: 100,
    });
  });

  it("restores a version 3 draft, or unreadable Simple state, at 100 %", async () => {
    const draft = createParticleVFXEditorDraftFromBlank();
    const record = (schema: string, simple: unknown) =>
      JSON.stringify({
        schema,
        userId: "user-a",
        documentKey: "new",
        source: null,
        operationId: "operation-old",
        fileOperationIds: [],
        displayName: "Old draft",
        catalog: draft.catalog,
        quarksJson: draft.quarksJson,
        textures: [],
        simple,
        updatedAt: "2026-10-09T12:00:00.000Z",
      });
    const key = `anima.particleVfxCreator.recovery.v1:${creatorRecoveryKey("user-a", "new")}`;

    values.set(key, record("animama/particle-effect-recovery/3", undefined));
    expect(await particleVFXRecoveryStore.load("user-a", "new")).toMatchObject({
      schema: PARTICLE_VFX_RECOVERY_SCHEMA,
      simple: null,
    });

    values.set(
      key,
      record(PARTICLE_VFX_RECOVERY_SCHEMA, {
        reference: { catalog: draft.catalog, quarksJson: draft.quarksJson },
        factors: { amount: "lots", size: 100, speed: 100, spread: 100 },
      }),
    );
    expect(await particleVFXRecoveryStore.load("user-a", "new")).toMatchObject({
      operationId: "operation-old",
      simple: null,
    });

    // Positions outside a control's range are not Simple's either.
    values.set(
      key,
      record(PARTICLE_VFX_RECOVERY_SCHEMA, {
        reference: { catalog: draft.catalog, quarksJson: draft.quarksJson },
        factors: { amount: 900, size: 100, speed: 100, spread: 100 },
      }),
    );
    expect(
      (await particleVFXRecoveryStore.load("user-a", "new"))?.simple,
    ).toBeNull();
  });
});
