import { describe, expect, it, vi } from "vitest";

import {
  createParticleVFXEditorDraftFromBlank,
  setParticleVFXSimpleControl,
} from "@/lib/avatar/particle-vfx";
import type { CatalogSaveInput } from "@/lib/content/catalogApi";
import type { PyContentItem } from "@/lib/content/catalogTypes";
import type { CreatorRecoveryStore } from "@/lib/content/creatorRecoveryStore";
import { createDefaultSceneEffectDocument } from "@/lib/scene-vfx/editor";
import { avatarEffectSaveAdapter } from "@/ui/avatar-effect-creator/useAvatarEffectSave";
import { createAvatarEffectHistorySnapshot } from "@/ui/avatar-effect-creator/avatarEffectCreatorBehavior";
import { particleVFXSaveAdapter } from "@/ui/particle-vfx-creator/useParticleVFXSave";
import { sceneEffectSaveAdapter } from "@/ui/scene-effect-creator/useSceneEffectSave";
import {
  createCreatorSaveSession,
  CreatorRecoveryDroppedError,
  isCreatorSavePause,
  runCreatorSave,
  type CreatorSaveAdapter,
} from "./useCreatorSave";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

type Snapshot = { name: string; body: string };
type Record = { userId: string; documentKey: string; snapshot: Snapshot };

function fakeAdapter(
  notices: readonly string[] = [],
): CreatorSaveAdapter<Snapshot, Record> {
  return {
    kind: "scene_effect",
    defaultName: "New Thing",
    savedMessage: "Saved.",
    pausedMessage: "Paused.",
    store: {} as CreatorRecoveryStore<Record>,
    fingerprint: (snapshot) => JSON.stringify(snapshot),
    name: (snapshot) => snapshot.name,
    withName: (snapshot, name) => ({ ...snapshot, name }),
    buildPayload: async ({ snapshot, name, target }) => ({
      files: [new File([snapshot.body], "body.txt")],
      companionPaths: ["body.txt"],
      descriptor: { id: target.logicalKey, name },
      savedSnapshot: { ...snapshot, body: snapshot.body.trim() },
      notices,
    }),
    toRecovery: ({ userId, documentKey, snapshot }) => ({
      userId,
      documentKey,
      snapshot,
    }),
    fromRecovery: (record) => ({
      snapshot: record.snapshot,
      operationId: "restored",
    }),
    editRoute: (itemId) => ({
      to: "/scene-effects/$sceneEffectId/edit",
      params: { sceneEffectId: itemId },
    }),
  };
}

function harness(adapter = fakeAdapter()) {
  const calls: string[] = [];
  const item = { item_id: "item-9" } as PyContentItem;
  const deps = {
    resolveName: vi.fn(async () => "New Thing 2"),
    saveTarget: vi.fn((name: string) => ({
      logicalKey: `local:scene-effect:${name}`,
      catalogItemId: undefined,
      expectedRevision: undefined,
    })),
    progress: vi.fn(),
    persist: vi.fn(async () => {
      calls.push("persist");
    }),
    save: vi.fn<(input: CatalogSaveInput) => Promise<PyContentItem>>(
      async () => {
        calls.push("save");
        return item;
      },
    ),
    clearRecovery: vi.fn(async () => {
      calls.push("clear");
    }),
    onSaved: vi.fn(async () => {
      calls.push("onSaved");
    }),
    navigate: vi.fn(async () => {
      calls.push("navigate");
    }),
  };
  return { adapter, calls, deps, item };
}

describe("shared creator Save", () => {
  it("persists, saves, clears recovery, then replaces the route past the leave guard", async () => {
    const { adapter, calls, deps, item } = harness();
    const session = createCreatorSaveSession("fingerprint");

    const result = await runCreatorSave({
      adapter,
      snapshot: { name: " Sparkle ", body: " text " },
      session,
      signal: new AbortController().signal,
      noticesAcknowledged: false,
      ...deps,
    });

    expect(calls).toEqual(["persist", "save", "clear", "onSaved", "navigate"]);
    expect(deps.persist).toHaveBeenCalledWith(session, {
      name: "Sparkle",
      body: " text ",
    });
    expect(deps.save).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "scene_effect",
        entryName: "Sparkle",
        operationId: session.operationId,
        descriptor: { id: "local:scene-effect:Sparkle", name: "Sparkle" },
      }),
    );
    expect(deps.onSaved).toHaveBeenCalledWith(
      { name: "Sparkle", body: "text" },
      item,
    );
    expect(deps.navigate).toHaveBeenCalledWith({
      to: "/scene-effects/$sceneEffectId/edit",
      params: { sceneEffectId: "item-9" },
      replace: true,
      ignoreBlocker: true,
    });
    expect(result.status).toBe("saved");
  });

  it("resolves a blank name once and reuses the operation ID on retry", async () => {
    const { adapter, deps } = harness();
    deps.save.mockRejectedValueOnce(new Error("network"));
    const session = createCreatorSaveSession("fingerprint");
    const attempt = () =>
      runCreatorSave({
        adapter,
        snapshot: { name: "", body: "text" },
        session,
        signal: new AbortController().signal,
        noticesAcknowledged: false,
        ...deps,
      });

    await expect(attempt()).rejects.toThrow("network");
    expect(deps.clearRecovery).not.toHaveBeenCalled();
    await attempt();

    expect(deps.resolveName).toHaveBeenCalledOnce();
    expect(deps.resolveName).toHaveBeenCalledWith("", "New Thing");
    const operationIds = deps.save.mock.calls.map(
      ([input]) => input.operationId,
    );
    expect(operationIds).toEqual([session.operationId, session.operationId]);
    expect(deps.save.mock.calls[1]?.[0]).toMatchObject({
      entryName: "New Thing 2",
    });
  });

  it("stops for review of packaging notices until they are acknowledged", async () => {
    const { deps } = harness();
    const adapter = fakeAdapter(["Texture resized."]);
    const run = (noticesAcknowledged: boolean) =>
      runCreatorSave({
        adapter,
        snapshot: { name: "Sparkle", body: "text" },
        session: createCreatorSaveSession("fingerprint"),
        signal: new AbortController().signal,
        noticesAcknowledged,
        ...deps,
      });

    expect(await run(false)).toEqual({
      status: "review",
      notices: ["Texture resized."],
    });
    expect(deps.persist).not.toHaveBeenCalled();
    expect(deps.save).not.toHaveBeenCalled();
    expect(await run(true)).toMatchObject({
      status: "saved",
      notices: ["Texture resized."],
    });
  });

  it("pauses an interrupted Save after preserving the draft", async () => {
    const { adapter, deps } = harness();
    const controller = new AbortController();
    controller.abort();

    const failure = await runCreatorSave({
      adapter,
      snapshot: { name: "Sparkle", body: "text" },
      session: createCreatorSaveSession("fingerprint"),
      signal: controller.signal,
      noticesAcknowledged: false,
      ...deps,
    }).catch((caught: unknown) => caught);

    expect(isCreatorSavePause(failure)).toBe(true);
    expect(isCreatorSavePause(new Error("other"))).toBe(false);
    expect(deps.persist).toHaveBeenCalledOnce();
    expect(deps.save).not.toHaveBeenCalled();
  });
});

describe("effect Save adapters", () => {
  const session = { operationId: "operation-1", contentFingerprint: "f" };

  it("round-trips an Avatar Effect draft and warns when its image bytes are gone", () => {
    const snapshot = createAvatarEffectHistorySnapshot();
    snapshot.document.art.image = {
      logicalName: "effect.webp",
      originalName: "effect.webp",
      contentType: "image/webp",
      sizeBytes: 4,
      sha256: "a".repeat(64),
    };
    const record = avatarEffectSaveAdapter.toRecovery({
      userId: "owner",
      documentKey: "new",
      itemId: undefined,
      session,
      snapshot,
      updatedAt: "2026-10-06T00:00:00.000Z",
    });
    const restored = avatarEffectSaveAdapter.fromRecovery(record);

    expect(restored.snapshot).toEqual(snapshot);
    expect(restored.operationId).toBe("operation-1");
    expect(restored.warning).toContain("images reselected");
  });

  it("drops an Avatar Effect draft from the earlier editor format with a notice", () => {
    const record = avatarEffectSaveAdapter.toRecovery({
      userId: "owner",
      documentKey: "new",
      itemId: undefined,
      session,
      snapshot: createAvatarEffectHistorySnapshot(),
      updatedAt: "2026-10-06T00:00:00.000Z",
    });
    expect(() =>
      avatarEffectSaveAdapter.fromRecovery({
        ...record,
        dropped: "old_editor_format",
      }),
    ).toThrow(CreatorRecoveryDroppedError);
    expect(() =>
      avatarEffectSaveAdapter.fromRecovery({
        ...record,
        dropped: "old_editor_format",
      }),
    ).toThrow(/earlier version of this creator/);
  });

  it("reports a Scene image that must be reselected against the files field", async () => {
    const document = createDefaultSceneEffectDocument();
    document.background.marquee.items = [
      {
        id: "private",
        kind: "image",
        label: "Private",
        image: {
          logicalName: "private.webp",
          originalName: "private.png",
          contentType: "image/png",
          sizeBytes: 4,
          sha256: "b".repeat(64),
        },
      },
    ];
    const failure = await sceneEffectSaveAdapter
      .buildPayload({
        snapshot: { document, imageResources: [] },
        name: "Scene",
        target: {
          logicalKey: "local:scene-effect:Scene",
          catalogItemId: undefined,
          expectedRevision: undefined,
        },
        signal: new AbortController().signal,
        progress: () => undefined,
      })
      .catch((caught: unknown) => caught);

    expect(failure).toMatchObject({
      message: "Reselect private.png before saving.",
      field: "files",
    });
  });

  it("restores a Particle draft from its recovery record and limits name length", () => {
    const draft = createParticleVFXEditorDraftFromBlank();
    const named = particleVFXSaveAdapter.withName(draft, "Hearts");
    const record = particleVFXSaveAdapter.toRecovery({
      userId: "owner",
      documentKey: "item-1",
      itemId: "item-1",
      session,
      snapshot: named,
      updatedAt: "2026-10-06T00:00:00.000Z",
    });

    expect(record).toMatchObject({
      source: { itemId: "item-1" },
      displayName: "Hearts",
      fileOperationIds: ["operation-1-manifest"],
    });
    const restored = particleVFXSaveAdapter.fromRecovery(record);
    expect(restored.snapshot.catalog.label).toBe("Hearts");
    expect(restored.snapshot.quarksJson).toEqual(named.quarksJson);
    expect(particleVFXSaveAdapter.validateName?.("x".repeat(121))).toEqual({
      message: "Give this Particle VFX a name between 1 and 120 characters.",
      field: "name",
    });
    expect(particleVFXSaveAdapter.validateName?.("Hearts")).toBeNull();
  });

  it("recovers a Particle draft's Simple controls, and stores none at 100 %", () => {
    const record = (
      snapshot: ReturnType<typeof createParticleVFXEditorDraftFromBlank>,
    ) =>
      particleVFXSaveAdapter.toRecovery({
        userId: "owner",
        documentKey: "new",
        itemId: undefined,
        session,
        snapshot,
        updatedAt: "2026-10-13T00:00:00.000Z",
      });
    const scaled = setParticleVFXSimpleControl(
      createParticleVFXEditorDraftFromBlank(),
      "amount",
      200,
    );

    const restored = particleVFXSaveAdapter.fromRecovery(record(scaled));
    expect(restored.snapshot.simple).toEqual(scaled.simple);
    expect(restored.snapshot.quarksJson).toEqual(scaled.quarksJson);

    const back = setParticleVFXSimpleControl(scaled, "amount", 100);
    expect(back.simple).not.toBeNull();
    expect(record(back).simple).toBeNull();
  });
});
