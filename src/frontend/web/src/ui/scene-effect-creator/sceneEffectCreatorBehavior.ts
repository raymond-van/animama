import { preflightContentFile, sha256File } from "@/lib/content/contentUploads";
import {
  addSceneEffectImage,
  applySceneEffectTemplate,
  canonicalSceneEffectImageName,
  createDefaultSceneEffectDocument,
  inspectSceneEffectImage,
  replaceSceneEffectImage,
  sceneEffectDocumentFingerprint,
  sceneEffectEditorReducer,
  sceneEffectImageItemLabel,
  sceneEffectImageMetadata,
  uniqueSceneEffectImageName,
  type SceneEffectEditorDocument,
  type SceneEffectEditorImage,
  type SceneEffectEditorImageResource,
  type SceneEffectImageTarget,
} from "@/lib/scene-vfx/editor";
import {
  fetchSceneStickerFile,
  type SceneSticker,
} from "@/lib/scene-vfx/stickers";

/** One undo step: the authored document and the private images it references. */
export type SceneEffectHistorySnapshot = {
  document: SceneEffectEditorDocument;
  imageResources: SceneEffectEditorImageResource[];
};

export function createSceneEffectHistorySnapshot(): SceneEffectHistorySnapshot {
  return { document: createDefaultSceneEffectDocument(), imageResources: [] };
}

/** Compare authored data and immutable File identities without serializing bytes. */
export function equalSceneEffectHistorySnapshots(
  left: SceneEffectHistorySnapshot,
  right: SceneEffectHistorySnapshot,
): boolean {
  return (
    sceneEffectDocumentFingerprint(left.document) ===
      sceneEffectDocumentFingerprint(right.document) &&
    left.imageResources.length === right.imageResources.length &&
    left.imageResources.every(
      (resource, index) =>
        resource.logicalName === right.imageResources[index]?.logicalName &&
        resource.sha256 === right.imageResources[index]?.sha256 &&
        resource.file === right.imageResources[index]?.file,
    )
  );
}

/**
 * Build one undoable edit from a reducer action. Omitting `imageResources`
 * keeps the current images; a list replaces them with the same step.
 */
export function sceneEffectHistoryEdit(
  action: Parameters<typeof sceneEffectEditorReducer>[1],
  imageResources?: SceneEffectEditorImageResource[],
): (snapshot: SceneEffectHistorySnapshot) => SceneEffectHistorySnapshot {
  return (snapshot) => ({
    document: sceneEffectEditorReducer(snapshot.document, action),
    imageResources: imageResources ?? snapshot.imageResources,
  });
}

/**
 * One undoable edit that starts the draft over from a loaded template (see
 * `applySceneEffectTemplate`). The step carries the template's image Files,
 * so undo restores the previous images with the previous layers.
 */
export function sceneEffectTemplateEdit(
  template: SceneEffectHistorySnapshot,
): (snapshot: SceneEffectHistorySnapshot) => SceneEffectHistorySnapshot {
  return (snapshot) => ({
    document: applySceneEffectTemplate(snapshot.document, template.document),
    imageResources: template.imageResources,
  });
}

/** Save and recovery fingerprint: the document plus its image digests. */
export function sceneEffectSnapshotFingerprint(
  snapshot: SceneEffectHistorySnapshot,
): string {
  const digests = [...snapshot.imageResources]
    .sort((left, right) => left.logicalName.localeCompare(right.logicalName))
    .map((resource) => `${resource.logicalName}:${resource.sha256}`)
    .join("|");
  return `${sceneEffectDocumentFingerprint(snapshot.document)}:${digests}`;
}

export type SceneEffectCreatorKeyboardAction = "save" | "toggle-preview" | null;

export function sceneEffectCreatorKeyboardAction(args: {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  editing: boolean;
}): SceneEffectCreatorKeyboardAction {
  if ((args.metaKey || args.ctrlKey) && args.key.toLowerCase() === "s")
    return "save";
  if (!args.editing && args.code === "Space") return "toggle-preview";
  return null;
}

export const SCENE_EFFECT_PREVIEW_MOTION_CLASS =
  "motion-safe:animate-pulse motion-reduce:animate-none";

export function createSceneEffectObjectUrlLease(
  resources: readonly SceneEffectEditorImageResource[],
  api: Pick<typeof URL, "createObjectURL" | "revokeObjectURL"> = URL,
): { urls: ReadonlyMap<string, string>; dispose: () => void } {
  const urls = new Map(
    resources.map((resource) => [
      resource.logicalName,
      api.createObjectURL(resource.file),
    ]),
  );
  let disposed = false;
  return {
    urls,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const url of urls.values()) api.revokeObjectURL(url);
    },
  };
}

/** How a chosen image is hashed; the content-hash worker by default. */
type SceneEffectImageHash = (file: File) => Promise<string>;

/** The document plus only the image bytes it still shows. */
function keepReferencedImages(
  document: SceneEffectEditorDocument,
  imageResources: readonly SceneEffectEditorImageResource[],
): SceneEffectHistorySnapshot {
  const referenced = new Set(
    sceneEffectImageMetadata(document).map((image) => image.logicalName),
  );
  return {
    document,
    imageResources: imageResources.filter((resource) =>
      referenced.has(resource.logicalName),
    ),
  };
}

/**
 * Check a chosen image before decoding it, then add it to `target` (or give
 * an image whose bytes are missing after reopening its new bytes). The
 * saved name follows the format the bytes are, so name and bytes agree.
 * Bytes the effect already carries (the same sticker or file chosen again)
 * are reused rather than copied. `label` names the new item (a sticker's
 * label); by default the file's.
 *
 * `getSnapshot` is read after the checks, so edits made meanwhile are kept.
 * Throws an error whose message tells the user why the image was refused.
 */
export async function addSceneEffectImageFile(
  getSnapshot: () => SceneEffectHistorySnapshot,
  source: File,
  target: SceneEffectImageTarget,
  {
    label,
    hash = sha256File,
  }: { label?: string; hash?: SceneEffectImageHash } = {},
): Promise<SceneEffectHistorySnapshot> {
  const inspection = await inspectSceneEffectImage(source);
  if (!inspection.ok) throw new Error(inspection.message);
  const preflight = await preflightContentFile("image", source);
  if (preflight.error) throw new Error(preflight.error);
  const sha256 = await hash(source);
  const { document, imageResources } = getSnapshot();
  const used = sceneEffectImageMetadata(document);
  const carried = used.find(
    (image) =>
      image.sha256 === sha256 &&
      imageResources.some(
        (resource) => resource.logicalName === image.logicalName,
      ),
  );
  // The new item is still named after the file just chosen. On the tile,
  // the reused bytes can replace another image's: those are dropped.
  if (carried)
    return keepReferencedImages(
      addSceneEffectImage(
        document,
        carried,
        target,
        label ?? sceneEffectImageItemLabel(source.name),
      ),
      imageResources,
    );
  const baseLogicalName = canonicalSceneEffectImageName(
    source.name,
    inspection.contentType,
  );
  // Reopened with this image's bytes missing: the new bytes fill every use.
  const missing = used.some(
    (image) =>
      image.logicalName === baseLogicalName &&
      !imageResources.some(
        (resource) => resource.logicalName === baseLogicalName,
      ),
  );
  const logicalName = missing
    ? baseLogicalName
    : uniqueSceneEffectImageName(
        baseLogicalName,
        used.map((image) => image.logicalName),
      );
  const file = new File([source], logicalName, {
    type: inspection.contentType,
    lastModified: source.lastModified,
  });
  const image: SceneEffectEditorImage = {
    logicalName,
    originalName: source.name,
    contentType: inspection.contentType,
    sizeBytes: source.size,
    sha256,
  };
  const nextDocument = missing
    ? replaceSceneEffectImage(document, image)
    : addSceneEffectImage(document, image, target, label);
  // Keep only bytes the document still shows (a replaced tile's go).
  return keepReferencedImages(nextDocument, [
    ...imageResources.filter(
      (resource) => resource.logicalName !== logicalName,
    ),
    { logicalName, file, sha256 },
  ]);
}

/**
 * Add a built-in sticker to `target`: its PNG is fetched and added as the
 * effect's own image, labelled with the sticker's label, exactly as a chosen
 * private image is, so Save, recovery and Portable packages carry it.
 */
export async function addSceneEffectSticker(
  getSnapshot: () => SceneEffectHistorySnapshot,
  sticker: SceneSticker,
  target: SceneEffectImageTarget,
  options: { hash?: SceneEffectImageHash } = {},
): Promise<SceneEffectHistorySnapshot> {
  const file = await fetchSceneStickerFile(sticker);
  return addSceneEffectImageFile(getSnapshot, file, target, {
    ...options,
    label: sticker.label,
  });
}
