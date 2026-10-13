import { renderToString } from "react-dom/server";
import { PerspectiveCamera } from "three";
import { describe, expect, it } from "vitest";

import {
  addParticleVFXEditorEmitter,
  createParticleVFXEditorDraftFromBlank,
  removeParticleVFXEditorEmitter,
  updateParticleVFXEditorCatalogDraft,
  type ParticleVFXEditorDraft,
} from "@/lib/avatar/particle-vfx";
import { createDefaultAvatarEffectDocument } from "@/lib/avatar/vfx/editor";
import { createDefaultSceneEffectDocument } from "@/lib/scene-vfx/editor";
import {
  avatarEffectHistoryEdit,
  createAvatarEffectHistorySnapshot,
  equalAvatarEffectHistorySnapshots,
} from "@/ui/avatar-effect-creator/avatarEffectCreatorBehavior";
import { AvatarEffectDragSession } from "@/ui/avatar-effect-creator/avatarEffectDrag";
import type { ScreenPlacement } from "@/ui/avatar-effect-creator/directManipulation";
import { equalParticleVFXDrafts } from "@/ui/particle-vfx-creator/particleVFXDocument";
import {
  createSceneEffectHistorySnapshot,
  equalSceneEffectHistorySnapshots,
  sceneEffectHistoryEdit,
  sceneEffectTemplateEdit,
} from "@/ui/scene-effect-creator/sceneEffectCreatorBehavior";
import {
  useCreatorDocumentHistory,
  type CreatorDocumentHistory,
} from "./useCreatorDocumentHistory";

/**
 * Server rendering exposes the real history callbacks without a DOM; the
 * latest snapshot is read through `getSnapshot`.
 */
function mount<T>(
  initialValue: () => T,
  equals: (left: T, right: T) => boolean,
): CreatorDocumentHistory<T> {
  let editor!: CreatorDocumentHistory<T>;
  function Harness() {
    editor = useCreatorDocumentHistory({ initialValue, equals });
    return null;
  }
  renderToString(<Harness />);
  return editor;
}

describe("creator document history", () => {
  describe("Avatar Effect snapshots", () => {
    const create = () =>
      mount(
        createAvatarEffectHistorySnapshot,
        equalAvatarEffectHistorySnapshots,
      );

    it("undoes and redoes sequential edits without losing earlier ones", () => {
      const editor = create();
      const original = editor.getSnapshot().document;
      editor.update(
        avatarEffectHistoryEdit({ type: "patch", patch: { name: "Sparkle" } }),
      );
      editor.update(
        avatarEffectHistoryEdit({
          type: "patch",
          patch: { description: "Bright" },
        }),
      );
      editor.history.undo();
      expect(editor.getSnapshot().document).toEqual({
        ...original,
        name: "Sparkle",
      });
      editor.history.undo();
      expect(editor.getSnapshot().document).toEqual(original);
      editor.history.redo();
      expect(editor.getSnapshot().document.name).toBe("Sparkle");
    });

    it("restores image bytes together with the image metadata", () => {
      const editor = create();
      const file = new File(["image bytes"], "sparkle.webp", {
        type: "image/webp",
      });
      const resource = { file, sha256: "sparkle-hash" };
      const image = {
        logicalName: file.name,
        originalName: file.name,
        contentType: file.type,
        sizeBytes: file.size,
        sha256: resource.sha256,
      };
      editor.update(
        avatarEffectHistoryEdit(
          { type: "patch-art", patch: { image } },
          { image: resource },
        ),
      );
      editor.update(
        avatarEffectHistoryEdit(
          { type: "replace", document: createDefaultAvatarEffectDocument() },
          { image: null, otherEyeImage: null },
        ),
      );
      editor.history.undo();
      expect(editor.getSnapshot().document.art.image).toEqual(image);
      expect(editor.getSnapshot().imageResources.image?.file).toBe(file);
      editor.history.redo();
      expect(editor.getSnapshot().document.art.image).toBeNull();
      expect(editor.getSnapshot().imageResources.image).toBeNull();
    });

    it("makes one direct-manipulation drag a single undo step", () => {
      const editor = create();
      const original = editor.getSnapshot();
      const placement = {
        index: 0,
        label: "right",
        mirrored: false,
        rotationSense: -1 as const,
        corners: [
          { x: 90, y: 90 },
          { x: 110, y: 90 },
          { x: 110, y: 110 },
          { x: 90, y: 110 },
        ] as ScreenPlacement["corners"],
        center: { x: 100, y: 100 },
        rotateHandle: { x: 100, y: 62 },
      };
      const drag = AvatarEffectDragSession.begin({
        hit: { mode: "scale", placement },
        pointer: { x: 110, y: 110 },
        frame: {
          attachment: "face_landmark",
          placements: [],
          offsetSpace: null,
          surface: null,
          unitLength: null,
        },
        attachment: original.document.attachment,
        view: { camera: new PerspectiveCamera(), width: 200, height: 200 },
        target: {
          beginGroup: editor.history.beginGroup,
          endGroup: editor.history.endGroup,
          apply: (patch) =>
            editor.update(
              avatarEffectHistoryEdit({ type: "patch-attachment", patch }),
            ),
        },
      })!;
      for (const step of [115, 120, 130])
        drag.move(
          { x: step, y: step },
          {
            camera: new PerspectiveCamera(),
            width: 200,
            height: 200,
          },
        );
      drag.end();
      // The corner moved from 10 to 30 px from the centre: three times larger.
      expect(editor.getSnapshot().document.attachment).toMatchObject({
        scale: { x: 3, y: 3 },
      });
      // One undo returns to the start: the moves were not separate steps.
      editor.history.undo();
      expect(editor.getSnapshot()).toEqual(original);
      editor.history.redo();
      expect(editor.getSnapshot().document.attachment).toMatchObject({
        scale: { x: 3, y: 3 },
      });
    });

    it("resets at new, load and recovery boundaries", () => {
      const editor = create();
      editor.update(
        avatarEffectHistoryEdit({ type: "patch", patch: { name: "First" } }),
      );
      editor.history.undo();
      editor.update(
        avatarEffectHistoryEdit({ type: "patch", patch: { name: "Second" } }),
      );
      editor.history.redo();
      expect(editor.getSnapshot().document.name).toBe("Second");
      const loaded = {
        document: { ...createDefaultAvatarEffectDocument(), name: "Loaded" },
        imageResources: { image: null, otherEyeImage: null },
      };
      editor.reset(loaded);
      editor.history.undo();
      editor.history.redo();
      expect(editor.getSnapshot()).toEqual(loaded);
    });
  });

  describe("Scene Effect snapshots", () => {
    const create = () =>
      mount(createSceneEffectHistorySnapshot, equalSceneEffectHistorySnapshots);

    it("undoes edits to separate layers in order", () => {
      const editor = create();
      const original = editor.getSnapshot().document;
      editor.update(
        sceneEffectHistoryEdit({
          type: "patch-solid",
          patch: { enabled: !original.background.solid.enabled },
        }),
      );
      const first = editor.getSnapshot().document;
      editor.update(
        sceneEffectHistoryEdit({
          type: "patch-pattern",
          patch: { enabled: !first.background.pattern.enabled },
        }),
      );
      editor.history.undo();
      expect(editor.getSnapshot().document).toEqual(first);
      editor.history.undo();
      expect(editor.getSnapshot().document).toEqual(original);
      editor.history.redo();
      expect(editor.getSnapshot().document).toEqual(first);
    });

    it("restores removed images and their exact Files together", () => {
      const editor = create();
      const file = new File(["image bytes"], "sparkle.webp", {
        type: "image/webp",
      });
      const resource = { logicalName: file.name, file, sha256: "sparkle-hash" };
      const item = {
        id: "sparkle",
        kind: "image" as const,
        label: "Sparkle",
        image: {
          logicalName: file.name,
          originalName: file.name,
          contentType: file.type,
          sizeBytes: file.size,
          sha256: resource.sha256,
        },
      };
      editor.update(
        sceneEffectHistoryEdit({ type: "set-marquee-items", items: [item] }, [
          resource,
        ]),
      );
      editor.update(
        sceneEffectHistoryEdit({ type: "set-marquee-items", items: [] }, []),
      );
      editor.history.undo();
      expect(editor.getSnapshot().document.background.marquee.items).toEqual([
        item,
      ]);
      expect(editor.getSnapshot().imageResources[0]?.file).toBe(file);
      editor.history.redo();
      expect(editor.getSnapshot().imageResources).toEqual([]);
    });

    it("applies a loaded template as one step whose undo restores the previous images", () => {
      const editor = create();
      const image = (name: string) => {
        const file = new File([name], name, { type: "image/png" });
        return {
          resource: { logicalName: name, file, sha256: `${name}-hash` },
          metadata: {
            logicalName: name,
            originalName: name,
            contentType: file.type,
            sizeBytes: file.size,
            sha256: `${name}-hash`,
          },
        };
      };
      const sparkle = image("sparkle.png");
      editor.update(
        sceneEffectHistoryEdit({ type: "patch", patch: { name: "Mine" } }),
      );
      editor.update(
        sceneEffectHistoryEdit(
          {
            type: "set-marquee-items",
            items: [
              {
                id: "sparkle",
                kind: "image",
                label: "Sparkle",
                image: sparkle.metadata,
              },
            ],
          },
          [sparkle.resource],
        ),
      );
      const before = editor.getSnapshot();
      const tile = image("bokeh-tile.png");
      const templateDocument = createDefaultSceneEffectDocument();
      templateDocument.name = "Emotion Love 1";
      templateDocument.durationMs = null;
      templateDocument.background.tile = {
        ...templateDocument.background.tile,
        enabled: true,
        image: tile.metadata,
      };

      editor.update(
        sceneEffectTemplateEdit({
          document: templateDocument,
          imageResources: [tile.resource],
        }),
      );

      const applied = editor.getSnapshot();
      expect(applied.document).toMatchObject({
        name: "Mine",
        durationMs: null,
      });
      expect(applied.document.background.tile.image).toEqual(tile.metadata);
      expect(applied.document.background.marquee.items).toEqual([]);
      expect(applied.imageResources.map((resource) => resource.file)).toEqual([
        tile.resource.file,
      ]);
      editor.history.undo();
      expect(editor.getSnapshot()).toEqual(before);
      expect(editor.getSnapshot().imageResources[0]?.file).toBe(
        sparkle.resource.file,
      );
      // The marquee edit is the step before: the template was one step.
      editor.history.undo();
      expect(editor.getSnapshot().document.background.marquee.items).toEqual(
        [],
      );
      expect(editor.getSnapshot().document.name).toBe("Mine");
      editor.history.redo();
      editor.history.redo();
      expect(editor.getSnapshot().imageResources[0]?.file).toBe(
        tile.resource.file,
      );
    });

    it("allows undoing an import and ignores value-equal edits", () => {
      const editor = create();
      editor.update(
        sceneEffectHistoryEdit({ type: "patch", patch: { name: "First" } }),
      );
      const imported = {
        ...createDefaultSceneEffectDocument(),
        name: "Imported",
      };
      editor.update(
        sceneEffectHistoryEdit({ type: "replace", document: imported }, []),
      );
      editor.history.undo();
      expect(editor.getSnapshot().document.name).toBe("First");
      editor.update(
        sceneEffectHistoryEdit({ type: "patch", patch: { name: "Second" } }),
      );
      editor.history.undo();
      // Re-applying the current value creates no step and keeps redo.
      editor.update(
        sceneEffectHistoryEdit({ type: "patch", patch: { name: "First" } }),
      );
      editor.history.redo();
      expect(editor.getSnapshot().document.name).toBe("Second");
    });
  });

  describe("Particle Effect drafts", () => {
    const create = () =>
      mount<ParticleVFXEditorDraft>(
        createParticleVFXEditorDraftFromBlank,
        equalParticleVFXDrafts,
      );

    it("restores emitter removal and discards a branched redo", () => {
      const editor = create();
      editor.update(addParticleVFXEditorEmitter);
      const added = editor.getSnapshot();
      editor.update((draft) =>
        removeParticleVFXEditorEmitter(draft, added.emitters[0]!.path),
      );
      editor.history.undo();
      expect(editor.getSnapshot()).toEqual(added);
      editor.update((draft) =>
        updateParticleVFXEditorCatalogDraft(draft, { label: "Branch" }),
      );
      editor.history.redo();
      expect(editor.getSnapshot().catalog.label).toBe("Branch");
      expect(editor.getSnapshot().emitters).toEqual(added.emitters);
    });

    it("keeps undo across save normalization and clears it on reset", () => {
      const editor = create();
      const initial = editor.getSnapshot();
      editor.update((draft) =>
        updateParticleVFXEditorCatalogDraft(draft, { label: "Saved" }),
      );
      editor.history.replacePresent({
        ...editor.getSnapshot(),
        source: "imported",
      });
      editor.history.undo();
      expect(editor.getSnapshot()).toEqual(initial);
      editor.history.redo();
      expect(editor.getSnapshot().catalog.label).toBe("Saved");
      const next = updateParticleVFXEditorCatalogDraft(initial, {
        label: "Loaded",
      });
      editor.reset(next);
      editor.history.undo();
      editor.history.redo();
      expect(editor.getSnapshot()).toEqual(next);
    });
  });
});
