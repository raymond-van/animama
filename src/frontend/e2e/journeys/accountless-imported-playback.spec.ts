import { randomUUID } from "node:crypto";
import type { Locator, Page } from "playwright/test";
import type {
  PyAnimaRuntime,
  PyAvatarCatalogPage,
  PyTypedContentPreview,
} from "@animama/runtime-contracts/api-types";
import { expect, test, type EvidenceAttachment } from "../fixtures/animama";
import { attachPlaybackCheckpoint } from "../helpers/checkpoints";
import { openCreatorStage } from "../helpers/creator-surfaces";
import {
  commitSharingPackage,
  downloadSharingPackage,
  reviewSharingExport,
  uploadSharingPackage,
} from "../helpers/content-sharing";
import {
  audioCount,
  createPlaybackFixtures,
  installAudioObservation,
  playbackFamilies,
  playbackInventory,
  proveAudioPlayback,
  proveLibraryParticleReplay,
  proveParticleCreatorPlayback,
  type OwnedPlaybackItem,
  type PlaybackItem,
  type PlaybackKind,
} from "../helpers/imported-playback";
import {
  proveAvatarVFXPlayback,
  proveEmotionJoySceneDom,
  proveParticlePlayback,
  provePoseClipPlayback,
  proveScenePlayback,
  proveVrmaPlayback,
} from "../helpers/playback-assertions";
import {
  observePlaybackWindow,
  readPlaybackObservation,
  type ExpectedPlaybackTarget,
  type PlaybackObservation,
} from "../helpers/playback-observation";
import { readPoseJson } from "../helpers/pose-content";
import { selectAnnieFromSidebar } from "../helpers/preview-surfaces";

const runtimeId = (item: PlaybackItem) =>
  item.kind === "gesture"
    ? item.semantic_key
    : (item.logical_key?.split(":").at(-1) ?? item.item_id);

async function openSharing(page: Page, action: "Import" | "Export") {
  await page.goto("/library");
  await page.getByRole("button", { name: action, exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

/** Bind the rendered preview to the receipt ID before examining clocks or pixels. */
function waitForTypedPreview(page: Page, item: PlaybackItem) {
  const family = playbackFamilies[item.kind as PlaybackKind];
  return page
    .waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname ===
          `/v1/${family}/${item.item_id}:preview`,
    )
    .then(async (response) => {
      expect(response.ok(), await response.text()).toBe(true);
      const prepared = (await response.json()) as PyTypedContentPreview;
      expect(prepared.item.item_id).toBe(item.item_id);
      expect(prepared.item.source).toBe("local");
      expect(prepared.item.revision_sha256).toBe(item.revision_sha256);
      return prepared;
    });
}

async function libraryRow(page: Page, item: PlaybackItem) {
  await page.goto("/library");
  await page.getByPlaceholder("Search the Library").fill(item.name);
  const row = page.getByRole("article", { name: item.name, exact: true });
  await expect(row).toHaveCount(1);
  await expect(row).toBeVisible();
  return row;
}

async function readyTarget(surface: Locator) {
  await expect(surface).toBeVisible();
  await expect
    .poll(
      async () => {
        const value = await readPlaybackObservation(surface);
        return (
          ["ready", "playing", "stopped"].includes(value.target.status) &&
          !value.diagnostics.some((entry) => entry.code === "avatar_not_ready")
        );
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  return (await readPlaybackObservation(surface)).target;
}

/** Scene observations expose first-play occurrence ownership; other effects expose aliases. */
function creatorEffectRuntimeId(
  item: PlaybackItem,
  alias: string,
  clipId: string,
  eventId: string,
) {
  return item.kind === "scene_effect"
    ? `poseCreatorClip:playback:${clipId}:${eventId}:0`
    : alias;
}

/**
 * Generated Actions must activate every imported dependency, not merely dispatch events.
 * `start` begins playback only after the Playing observer is armed; a short clip
 * can otherwise finish before a slow page reports it.
 */
async function proveIntegratedAction(args: {
  surface: Locator;
  target: ExpectedPlaybackTarget;
  effects: PlaybackItem[];
  creatorEffectRuntimeIds?: ReadonlyMap<string, string>;
  evidence: EvidenceAttachment;
  name: string;
  reaction: boolean;
  start?: () => Promise<unknown>;
}) {
  const creator =
    (await readPlaybackObservation(args.surface)).surface === "creator-stage";
  const channel = args.reaction && !creator ? "reactionClip" : "poseClip";
  if (creator)
    for (const item of args.effects)
      expect(args.creatorEffectRuntimeIds?.get(item.item_id)).toBeTruthy();
  const playing = observePlaybackWindow({
    surface: args.surface,
    expectedTarget: args.target,
    evidence: args.evidence,
    evidenceName: args.name,
    until: (samples) => {
      const clips = samples.flatMap((sample) => sample.motion[channel] ?? []);
      const times = clips.map((clip) => clip.playheadSec);
      const events = new Set(clips.flatMap((clip) => clip.firedEventIds));
      const effectsPresent = args.effects.every((item) => {
        const effectChannel =
          item.kind === "avatar_effect"
            ? "avatar"
            : item.kind === "particle_effect"
              ? "particle"
              : "scene";
        return samples.some((sample) =>
          sample.effects[effectChannel].some(
            (effect) =>
              effect.runtimeId ===
                (creator
                  ? args.creatorEffectRuntimeIds!.get(item.item_id)
                  : runtimeId(item)) && effect.active,
          ),
        );
      });
      return (
        clips.some((clip) => clip.active) &&
        Math.max(...times) - Math.min(...times) > 0.1 &&
        // Creator projects its authoring clock; event/bone counters belong to
        // the independent PoseController and are deliberately empty there.
        (creator ||
          ["avatar", "particle", "scene", "sound"].every((id) =>
            events.has(id),
          )) &&
        effectsPresent &&
        samples.some((sample) => (sample.expressions.happy ?? 0) > 0.4) &&
        (creator ||
          args.reaction ||
          samples.some(
            (sample) => (sample.motion.poseClip?.resolvedBoneCount ?? 0) > 0,
          )) &&
        !samples.some((sample) =>
          sample.diagnostics.some((entry) =>
            [
              "controller_error",
              "controller_unavailable",
              "controller_warnings",
            ].includes(entry.code),
          ),
        )
      );
    },
  });
  if (!args.start) return playing;
  const [samples] = await Promise.all([playing, args.start()]);
  return samples;
}

async function proveItem(args: {
  item: PlaybackItem;
  surface: Locator;
  target: ExpectedPlaybackTarget;
  effects: PlaybackItem[];
  creatorEffectRuntimeIds?: ReadonlyMap<string, string>;
  evidence: EvidenceAttachment;
  name: string;
  start?: () => Promise<unknown>;
}): Promise<PlaybackObservation[]> {
  const { item, surface, target, evidence, name } = args;
  const base = {
    surface,
    expectedTarget: target,
    evidence,
    evidenceName: name,
  };
  if (item.kind === "gesture" && item.implementation.kind === "vrma")
    return proveVrmaPlayback(base);
  if (item.kind === "gesture" || item.kind === "reaction")
    return proveIntegratedAction({
      ...args,
      reaction: item.kind === "reaction",
    });
  if (item.kind === "pose")
    return provePoseClipPlayback({ ...base, maxMissingBones: 1 });
  if (
    ["particle_effect", "avatar_effect", "scene_effect"].includes(item.kind) &&
    (await readPlaybackObservation(surface)).surface === "creator-stage"
  ) {
    if (item.kind === "particle_effect")
      return proveParticleCreatorPlayback({
        page: surface.page(),
        surface,
        target,
        evidence,
        name,
      });
    // These creators apply dedicated preview IDs while their public target
    // remains the imported document name. Keep both identities explicit.
    const samples = await observePlaybackWindow({
      ...base,
      until: (window) =>
        window.some((sample) =>
          item.kind === "avatar_effect"
            ? sample.effects.avatar.some(
                (effect) =>
                  effect.runtimeId === "avatar-effect-editor-preview" &&
                  effect.active &&
                  Boolean(effect.targetRole) &&
                  Boolean(effect.renderMode),
              )
            : sample.effects.scene.some(
                (effect) =>
                  /^scene-effect-editor-preview-\d+$/.test(effect.runtimeId) &&
                  effect.kind === "background_layers",
              ),
        ) && !window.some((sample) => sample.diagnostics.length > 0),
    });
    if (item.kind === "scene_effect") {
      // The creator uses its preview revision as the runtime start timestamp,
      // so epoch-based `active` is not its lifetime signal. Playing plus the
      // exact rendered entry, Blob-backed items and their drift prove it.
      const effect = samples
        .flatMap((sample) => sample.effects.scene)
        .find(
          (entry) =>
            /^scene-effect-editor-preview-\d+$/.test(entry.runtimeId) &&
            entry.kind === "background_layers",
        )!;
      const root = surface.locator(
        `[data-scene-vfx-id="${effect.runtimeId}"][data-scene-vfx-kind="background_layers"]`,
      );
      await expect(root).toHaveCount(1);
      await expect(root).toBeVisible();
      await proveEmotionJoySceneDom(root);
    }
    return samples;
  }
  if (item.kind === "particle_effect") return proveParticlePlayback(base);
  if (item.kind === "avatar_effect") return proveAvatarVFXPlayback(base);
  if (item.kind === "scene_effect")
    return (
      await proveScenePlayback({ ...base, expectedKind: "background_layers" })
    ).samples;
  if (item.kind === "idle_style")
    return proveIntegratedAction({ ...args, reaction: false });
  // A model has no playback clock; the temporal helper deliberately waits for
  // Playing and is therefore inappropriate for a ready static Avatar.
  const observation = await readPlaybackObservation(surface);
  expect(observation.target).toMatchObject(target);
  expect(observation.target.status).toBe("ready");
  expect(observation.diagnostics).not.toContainEqual({
    channel: "avatar",
    code: "avatar_not_ready",
  });
  return [observation];
}

function expectedTarget(
  item: PlaybackItem,
  preview: PyTypedContentPreview,
): ExpectedPlaybackTarget {
  if (item.kind === "avatar")
    return {
      kind: "avatar_model",
      runtimeId: `preview-avatar-${preview.preview_id}`,
    };
  if (item.kind === "pose")
    return {
      kind: "anima_pose_clip",
      runtimeId: `pose-preview:${item.item_id}`,
    };
  if (item.kind === "idle_style") {
    const ref = item.default_pool[0];
    const dependency = item.dependencies?.find((entry) => entry.ref === ref);
    const gesture = preview.supports?.find(
      (entry) => entry.item_id === dependency?.item_id,
    );
    expect(
      gesture?.kind,
      "imported Idle pool must resolve to its exact imported Gesture",
    ).toBe("gesture");
    return { kind: "anima_pose_clip", runtimeId: runtimeId(gesture!) };
  }
  return {
    kind:
      item.kind === "particle_effect"
        ? "particle_vfx"
        : item.kind === "avatar_effect"
          ? "avatar_vfx"
          : item.kind === "scene_effect"
            ? "scene_vfx"
            : item.kind === "gesture" && item.implementation.kind === "vrma"
              ? "animation"
              : "anima_pose_clip",
    runtimeId: runtimeId(item),
  };
}

async function discardNewAction(page: Page) {
  await page.getByRole("link", { name: "Library", exact: true }).click();
  const discard = page.getByRole("dialog", {
    name: "Discard authoring changes?",
    exact: true,
  });
  await expect(discard).toBeVisible();
  await discard
    .getByRole("button", { name: "Discard and continue", exact: true })
    .click();
  await expect(page).toHaveURL(/\/library(?:[/?#]|$)/);
}

/** Copy the exact imported Pose through the catalog, then play its new inline Gesture. */
async function proveImportedPoseInsertion(args: {
  page: Page;
  item: PlaybackItem;
  pose: Record<string, unknown>;
  evidence: EvidenceAttachment;
  token: string;
}) {
  const { page, item, pose, evidence, token } = args;
  const stage = await openCreatorStage({
    creator: "Gesture",
    page,
    selectAnnie: false,
  });
  // Ordinary New opens Pose; a timeline composition starts in Clip mode.
  await page.getByRole("tab", { name: "Clip", exact: true }).click();
  const name = `import-pose-${token}-gesture`;
  await page
    .getByRole("textbox", { name: "gesture name", exact: true })
    .fill(name);
  // Saved Pose insertion calls loadPoseContent, which admits the exact item
  // through its typed preview before copying its values into the clip.
  const admitted = waitForTypedPreview(page, item);
  await page
    .getByRole("button", {
      name: `Insert ${item.name} at current playhead`,
      exact: true,
    })
    .click();
  await admitted;
  await expect(
    page.getByText("Pose copied into the clip.", { exact: true }),
  ).toBeVisible();
  // The top-center toast overlaps View JSON. Clicking through it would hover
  // the notification and pause dismissal, so let it clear before using toolbar.
  await expect(
    page.getByText("Pose copied into the clip.", { exact: true }),
  ).toBeHidden({ timeout: 10_000 });
  await page.getByRole("button", { name: "View JSON", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Creator JSON",
    exact: true,
  });
  await dialog
    .getByRole("combobox", { name: "JSON format", exact: true })
    .click();
  await page.getByRole("option", { name: "Clip JSON", exact: true }).click();
  const clip = JSON.parse(
    await dialog
      .getByRole("textbox", { name: "Creator JSON preview", exact: true })
      .inputValue(),
  ) as {
    schema: string;
    id: string;
    beats: Array<{ id: string; label: string; time: number }>;
    rotations?: Record<string, Array<{ beat: string; q: number[] }>>;
    hipsPosition?: Record<string, Array<{ beat: string; v: number }>>;
    expressions?: Record<string, Array<{ beat: string; v: number }>>;
  };
  // The clip as Save writes it: 2.0, the copied Pose as a beat at 0 whose
  // values are the Pose's own (base endpoints are separate "Base" beats).
  expect(clip.schema).toBe("animaPoseClip/2.0");
  const copied = clip.beats.filter((beat) => beat.label !== "Base");
  expect(copied).toHaveLength(1);
  const [beat] = copied;
  expect(beat!.time).toBe(0);
  const at = <K extends { beat: string }>(keys: K[] | undefined) =>
    keys?.find((key) => key.beat === beat!.id);
  for (const [name, value] of Object.entries(
    (pose.expressions ?? {}) as Record<string, number>,
  ))
    expect(at(clip.expressions?.[name])?.v).toBeCloseTo(value, 4);
  for (const [bone, transform] of Object.entries(
    pose.humanoid as Record<
      string,
      { rotation?: number[]; position?: number[] }
    >,
  )) {
    transform.rotation?.forEach((value, index) =>
      expect(Math.abs(at(clip.rotations?.[bone])?.q[index] ?? NaN)).toBeCloseTo(
        Math.abs(value),
        5,
      ),
    );
    if (bone === "hips")
      transform.position?.forEach((value, index) =>
        expect(at(clip.hipsPosition?.[["x", "y", "z"][index]!])?.v).toBeCloseTo(
          value,
          4,
        ),
      );
  }
  expect(JSON.stringify(clip)).not.toContain(item.item_id);
  if (item.logical_key)
    expect(JSON.stringify(clip)).not.toContain(item.logical_key);
  await evidence.attachJson(`${name}-inline-copy`, {
    importedItemId: item.item_id,
    importedRevision: item.revision_sha256,
    sourcePose: pose,
    clip,
  });
  await page.keyboard.press("Escape");
  const target = await readyTarget(stage.surface);
  expect(target.runtimeId).toBe(clip.id);
  expect(Number(at(clip.expressions?.sad)?.v)).toBeGreaterThan(0.2);
  const playing = observePlaybackWindow({
    surface: stage.surface,
    surfaceKind: "creator-stage",
    expectedTarget: { kind: "anima_pose_clip", runtimeId: clip.id },
    evidence,
    evidenceName: name,
    until: (samples) => {
      const times = samples.flatMap((sample) =>
        sample.motion.poseClip ? [sample.motion.poseClip.playheadSec] : [],
      );
      return (
        Math.max(...times) - Math.min(...times) > 0.04 &&
        samples.some(
          (sample) =>
            sample.motion.poseClip?.active &&
            (sample.expressions.sad ?? 0) > 0.2,
        ) &&
        !samples.some((sample) =>
          sample.diagnostics.some((entry) =>
            [
              "controller_error",
              "controller_unavailable",
              "controller_warnings",
            ].includes(entry.code),
          ),
        )
      );
    },
  });
  const [, samples] = await Promise.all([
    page
      .getByRole("button", { name: "Restart clip preview", exact: true })
      .click(),
    playing,
  ]);
  await attachPlaybackCheckpoint({
    evidence,
    locator: stage.surface,
    name,
    samples,
  });
  await discardNewAction(page);
}

/** Read the visible exact-source dependency aliases used by creator playback. */
async function readCreatorProject(page: Page, expectedItemId: string) {
  await page.getByRole("button", { name: "View JSON", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Creator JSON",
    exact: true,
  });
  await dialog
    .getByRole("combobox", { name: "JSON format", exact: true })
    .click();
  await page
    .getByRole("option", { name: "Typed project JSON", exact: true })
    .click();
  const json = dialog.getByRole("textbox", {
    name: "Creator JSON preview",
    exact: true,
  });
  await expect(json).toHaveValue(new RegExp(expectedItemId));
  const project = JSON.parse(await json.inputValue()) as {
    schema: string;
    intent: string;
    dependencies: Array<{
      alias: string;
      content_type: string;
      source: { catalog_item_id?: string };
    }>;
    sequence: {
      id: string;
      events: Array<{
        id: string;
        kind: string;
        effectId?: string;
        presetId?: string;
        cueId?: string;
      }>;
    };
  };
  expect(project.schema).toBe("animamaActionProject/1.0");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  return project;
}

/** A separately imported effect must also work when inserted into a new Action through Library UI. */
async function proveImportedEffectHandoff(args: {
  page: Page;
  item: PlaybackItem;
  intent: "Gesture" | "Reaction";
  evidence: EvidenceAttachment;
  token: string;
}) {
  const { page, item, intent, evidence, token } = args;
  const row = await libraryRow(page, item);
  await row
    .getByRole("link", { name: `Use in ${intent}`, exact: true })
    .click();
  // New Actions prepare their dependencies through the shared capability API.
  // The visible project JSON below binds the exact imported source, while the
  // subsequent clock/effect proof establishes that its prepared bytes play.
  await expect(page).toHaveURL(new RegExp(`/${intent.toLowerCase()}s/new\\?`));
  const name = `import-use-${token}-${item.kind}-${intent.toLowerCase()}`;
  await page
    .getByRole("textbox", { name: `${intent.toLowerCase()} name`, exact: true })
    .fill(name);
  const project = await readCreatorProject(page, item.item_id);
  expect(project.intent).toBe(intent.toLowerCase());
  expect(project.dependencies).toHaveLength(1);
  const dependency = project.dependencies[0]!;
  expect(dependency.content_type).toBe(item.kind);
  expect(dependency.source.catalog_item_id).toBe(item.item_id);
  expect(project.sequence.events).toHaveLength(1);
  const event = project.sequence.events[0]!;
  expect(event.effectId ?? event.presetId ?? event.cueId).toBe(
    dependency.alias,
  );
  await evidence.attachJson(`${name}-exact-source`, project);
  const surface = page.locator('[data-playback-surface="creator-stage"]');
  const target = await readyTarget(surface);
  expect(target.runtimeId).toBe(project.sequence.id);
  const expectedEffectId = creatorEffectRuntimeId(
    item,
    dependency.alias,
    project.sequence.id,
    event.id,
  );
  const audioStart = await audioCount(page);
  const playing = observePlaybackWindow({
    surface,
    expectedTarget: target,
    evidence,
    evidenceName: name,
    until: (samples) => {
      const clips = samples.flatMap((sample) => sample.motion.poseClip ?? []);
      const times = clips.map((clip) => clip.playheadSec);
      const channel =
        item.kind === "avatar_effect"
          ? "avatar"
          : item.kind === "particle_effect"
            ? "particle"
            : "scene";
      return (
        clips.some((clip) => clip.active) &&
        Math.max(...times) - Math.min(...times) > 0.04 &&
        (item.kind === "sound_effect" ||
          samples.some((sample) =>
            sample.effects[channel].some(
              (effect) =>
                effect.runtimeId === expectedEffectId && effect.active,
            ),
          )) &&
        !samples.some((sample) =>
          sample.diagnostics.some((entry) =>
            [
              "controller_error",
              "controller_unavailable",
              "controller_warnings",
            ].includes(entry.code),
          ),
        )
      );
    },
  });
  const [, samples] = await Promise.all([
    page
      .getByRole("button", { name: "Restart clip preview", exact: true })
      .click(),
    playing,
  ]);
  if (item.kind === "sound_effect")
    await proveAudioPlayback(page, audioStart, evidence, `${name}-audio`);
  await attachPlaybackCheckpoint({ evidence, locator: surface, name, samples });
  await discardNewAction(page);
}

test("imported playback covers every supported content kind in Library and applicable creators", async ({
  page,
  creatorContent,
  animamaEvidence,
}, testInfo) => {
  test.setTimeout(900_000);
  const before = await creatorContent.snapshotLocalCatalog();
  await installAudioObservation(page);
  const annieId = await selectAnnieFromSidebar(page);
  const loadoutBefore = await creatorContent.snapshotAnimaLoadout(annieId);
  const sourceNames: Partial<Record<PlaybackKind, string>> = {
    pose: "Shy Finger Poke 1",
    particle_effect: "Heart Burst",
    avatar_effect: "Eye Confused Swirl",
    scene_effect: "Emotion Joy",
  };
  const sources: PlaybackItem[] = [];
  const avatarCatalogResponse = await page.request.get("/v1/avatar-catalog");
  expect(avatarCatalogResponse.ok()).toBe(true);
  const avatarCatalog =
    (await avatarCatalogResponse.json()) as PyAvatarCatalogPage;
  const portraitAvatar = avatarCatalog.items.find(
    (item) =>
      item.origin === "included" && item.preview_url && item.catalog_item_id,
  );
  expect(
    portraitAvatar,
    "an Included Avatar with a portrait must exist",
  ).toBeDefined();
  for (const kind of [
    "avatar",
    "pose",
    "particle_effect",
    "avatar_effect",
    "scene_effect",
  ] as const) {
    const inventory = await playbackInventory(page, kind);
    const source = inventory.find(
      (item) =>
        item.source === "included" &&
        (kind !== "avatar" ||
          item.item_id === portraitAvatar!.catalog_item_id) &&
        (!sourceNames[kind] || item.name === sourceNames[kind]),
    );
    expect(
      source,
      `Included ${kind} fixture ${sourceNames[kind] ?? "Avatar"} must exist`,
    ).toBeDefined();
    sources.push(source!);
  }
  const effects = sources.filter((item) =>
    ["particle_effect", "avatar_effect", "scene_effect"].includes(item.kind),
  );
  const token = randomUUID().slice(0, 8);
  sources.push(
    ...(await createPlaybackFixtures({
      page,
      content: creatorContent,
      effects,
      token,
    })),
  );

  await openSharing(page, "Export");
  for (const source of sources) {
    await page
      .getByRole("textbox", { name: "Search content", exact: true })
      .fill(source.name);
    await page
      .getByRole("checkbox", { name: source.name, exact: true })
      .check();
  }
  const exported = await reviewSharingExport(page);
  expect(exported.selected_count).toBe(sources.length);
  expect(new Set(exported.manifest.entries.map((entry) => entry.kind))).toEqual(
    new Set([...Object.keys(playbackFamilies), "appearance"]),
  );
  expect(exported.manifest.avatar_portraits.length).toBeGreaterThan(0);
  const archive = await downloadSharingPackage(
    page,
    testInfo,
    page.getByRole("button", { name: "Download package", exact: true }),
  );
  await openSharing(page, "Import");
  const reviewed = await uploadSharingPackage(page, archive);
  const owned = await commitSharingPackage({
    page,
    content: creatorContent,
    review: reviewed,
    journeyKey: `imported-playback-${token}`,
  });
  await page
    .getByRole("link", { name: "View in Library", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  const imported: PlaybackItem[] = [];
  for (const source of sources) {
    const proposal = reviewed.items.find(
      (entry) =>
        entry.selected &&
        entry.kind === source.kind &&
        entry.original_name === source.name,
    )!;
    expect(proposal).toBeDefined();
    const receipt = owned.find(
      (entry) =>
        entry.plan.kind === source.kind &&
        entry.plan.entryName === proposal.name,
    )!;
    expect(receipt).toBeDefined();
    const item = (
      await playbackInventory(page, source.kind as PlaybackKind)
    ).find((entry) => entry.item_id === receipt.itemId)!;
    expect(item).toBeDefined();
    expect(item.item_id).not.toBe(source.item_id);
    expect(item.revision_sha256).toBe(receipt.revisionSha256);
    imported.push(item);
  }
  const importedEffects = imported.filter((item) =>
    ["particle_effect", "avatar_effect", "scene_effect"].includes(item.kind),
  );
  await animamaEvidence.attachJson(
    "imported-playback-receipts",
    imported.map((item) => ({
      kind: item.kind,
      itemId: item.item_id,
      name: item.name,
    })),
  );

  for (const item of imported) {
    await test.step(`${item.kind}: exact imported Library preview`, async () => {
      const row = await libraryRow(page, item);
      if (item.kind === "avatar") {
        const portrait = row.locator("img");
        await expect(portrait).toHaveCount(1);
        await expect
          .poll(() =>
            portrait.evaluate(
              (image) =>
                (image as HTMLImageElement).complete &&
                (image as HTMLImageElement).naturalWidth > 0,
            ),
          )
          .toBe(true);
      }
      const audioStart = await audioCount(page);
      const pending = waitForTypedPreview(page, item);
      await row
        .getByRole("button", {
          name: item.kind === "sound_effect" ? "Play" : "Preview",
          exact: true,
        })
        .click();
      const preview = await pending;
      if (item.kind === "sound_effect") {
        await proveAudioPlayback(
          page,
          audioStart,
          animamaEvidence,
          "imported-sound-library",
        );
        return;
      }
      const surface = page.locator('[data-playback-surface="library-dock"]');
      await readyTarget(surface);
      const target = expectedTarget(item, preview);
      let samples: PlaybackObservation[];
      if (item.kind === "particle_effect") {
        // Heart Burst lasts only 2.5 s. Arm observation before Replay after the
        // imported resource and model are ready, rather than missing its start.
        await surface
          .getByRole("button", { name: "Stop", exact: true })
          .click();
        await expect
          .poll(
            async () => (await readPlaybackObservation(surface)).target.status,
          )
          .toBe("stopped");
        samples = await proveLibraryParticleReplay({
          surface,
          target,
          evidence: animamaEvidence,
          name: "imported-particle_effect-library",
        });
      } else {
        samples = await proveItem({
          item,
          surface,
          target,
          effects: importedEffects,
          evidence: animamaEvidence,
          name: `imported-${item.kind}-library`,
        });
      }
      if (
        (item.kind === "gesture" &&
          item.implementation.kind === "anima_clip") ||
        item.kind === "reaction" ||
        item.kind === "idle_style"
      )
        await proveAudioPlayback(
          page,
          audioStart,
          animamaEvidence,
          `imported-${item.kind}-library-sound`,
        );
      await attachPlaybackCheckpoint({
        evidence: animamaEvidence,
        locator: surface,
        name: `imported-${item.kind}-library`,
        samples,
      });
      if (item.kind === "idle_style") {
        await expect
          .poll(
            async () => {
              const observation = await readPlaybackObservation(surface);
              return (
                ["ready", "stopped"].includes(observation.target.status) &&
                !observation.motion.poseClip?.active &&
                observation.effects.avatar.length === 0 &&
                observation.effects.particle.length === 0 &&
                observation.effects.scene.every((effect) => !effect.active)
              );
            },
            { timeout: 15_000 },
          )
          .toBe(true);
      }
    });

    await test.step(`${item.kind}: applicable imported creator`, async () => {
      if (item.kind === "avatar" || item.kind === "sound_effect") return;
      const creatorAdmission = [
        "pose",
        "particle_effect",
        "avatar_effect",
        "scene_effect",
      ].includes(item.kind)
        ? waitForTypedPreview(page, item)
        : null;
      await page.goto(
        `/${playbackFamilies[item.kind as PlaybackKind]}/${item.item_id}/edit`,
      );
      await creatorAdmission;
      if (item.kind === "pose") {
        await expect(
          page.getByRole("textbox", { name: "Pose name", exact: true }),
        ).toHaveValue(item.name);
        // PoseEditorScene is a static editing canvas without a playback
        // observation output. Enabled controls require both Pose hydration
        // and the rendered Avatar; retain a real canvas checkpoint here.
        await expect(
          page.getByRole("textbox", { name: "Pose name", exact: true }),
        ).toBeEnabled();
        const canvas = page.getByTestId("pose-editor-canvas");
        await expect(canvas.locator("canvas")).toBeVisible();
        await expect(
          page.getByText("Loading Avatar…", { exact: true }),
        ).toBeHidden();
        await expect(
          page.getByText("Loading pose…", { exact: true }),
        ).toBeHidden();
        const pose = await readPoseJson(page);
        expect(Object.keys(pose.humanoid as object).length).toBeGreaterThan(0);
        await animamaEvidence.attachJson("imported-pose-creator-json", pose);
        await animamaEvidence.attachBuffer(
          "imported-pose-creator-rendered",
          await canvas.screenshot({ animations: "disabled", type: "png" }),
          "image/png",
        );
        await proveImportedPoseInsertion({
          page,
          item,
          pose,
          evidence: animamaEvidence,
          token,
        });
        return;
      }
      if (item.kind === "idle_style") {
        await expect(
          page.getByRole("textbox", { name: "Name", exact: true }),
        ).toHaveValue(item.name);
        await page
          .getByRole("button", { name: "Preview saved pool", exact: true })
          .click();
      }
      const effectTypeLabel =
        item.kind === "avatar_effect"
          ? "Avatar FX"
          : item.kind === "particle_effect"
            ? "Particle FX"
            : item.kind === "scene_effect"
              ? "Scene FX"
              : null;
      if (effectTypeLabel) {
        await expect(
          page.getByRole("textbox", {
            name: `${effectTypeLabel} name`,
            exact: true,
          }),
        ).toHaveValue(item.name);
      }
      const surface = page.locator(
        `[data-playback-surface="${item.kind === "idle_style" ? "library-dock" : "creator-stage"}"]`,
      );
      const target = await readyTarget(surface);
      if (item.kind === "gesture" || item.kind === "reaction") {
        await expect(
          page.getByRole("textbox", { name: `${item.kind} name`, exact: true }),
        ).toHaveValue(item.name);
      }
      if (item.kind === "gesture" && item.implementation.kind === "vrma") {
        // The VRMA editor hydrates the source and model but exposes no transport.
        // Moving VRMA playback is proved in Library and imported Anima Loadout.
        await expect(
          page.getByLabel("VRMA animation", { exact: true }),
        ).toBeVisible();
        await attachPlaybackCheckpoint({
          evidence: animamaEvidence,
          locator: surface,
          name: "imported-vrma-creator-loaded",
          samples: [await readPlaybackObservation(surface)],
        });
        return;
      }
      let creatorEffectRuntimeIds: Map<string, string> | undefined;
      if (item.kind === "gesture" || item.kind === "reaction") {
        // Saved Action sequences retain authored aliases. The creator runtime
        // registers each exact imported dependency under that alias. Scene
        // observations identify its owned occurrence instead of the alias.
        const project = await readCreatorProject(
          page,
          importedEffects[0]!.item_id,
        );
        expect(project.intent).toBe(item.kind);
        expect(target.runtimeId).toBe(project.sequence.id);
        creatorEffectRuntimeIds = new Map();
        for (const effect of imported.filter((candidate) =>
          [
            "avatar_effect",
            "particle_effect",
            "scene_effect",
            "sound_effect",
          ].includes(candidate.kind),
        )) {
          const dependencies = project.dependencies.filter(
            (dependency) =>
              dependency.content_type === effect.kind &&
              dependency.source.catalog_item_id === effect.item_id,
          );
          expect(dependencies).toHaveLength(1);
          const alias = dependencies[0]!.alias;
          const events = project.sequence.events.filter(
            (event) =>
              (event.effectId ?? event.presetId ?? event.cueId) === alias,
          );
          expect(events).toHaveLength(1);
          creatorEffectRuntimeIds.set(
            effect.item_id,
            creatorEffectRuntimeId(
              effect,
              alias,
              project.sequence.id,
              events[0]!.id,
            ),
          );
        }
        await animamaEvidence.attachJson(
          `imported-${item.kind}-creator-exact-dependencies`,
          project,
        );
      }
      const audioStart = await audioCount(page);
      const restart = page.getByRole("button", {
        name: /^(Restart clip preview|Restart preview)$/,
      });
      if (item.kind === "gesture" || item.kind === "reaction")
        await expect(restart).toHaveCount(1);
      if (effectTypeLabel) {
        await page
          .getByRole("button", { name: /^Restart (?:effect )?preview$/ })
          .click();
      }
      const samples = await proveItem({
        item,
        surface,
        target,
        effects: importedEffects,
        creatorEffectRuntimeIds,
        evidence: animamaEvidence,
        name: `imported-${item.kind}-creator`,
        // The 3s fixture clips must be observed from Restart, not after it.
        start:
          item.kind === "gesture" || item.kind === "reaction"
            ? () => restart.click()
            : undefined,
      });
      if (
        (item.kind === "gesture" &&
          item.implementation.kind === "anima_clip") ||
        item.kind === "reaction"
      )
        await proveAudioPlayback(
          page,
          audioStart,
          animamaEvidence,
          `imported-${item.kind}-creator-sound`,
        );
      await attachPlaybackCheckpoint({
        evidence: animamaEvidence,
        locator: surface,
        name: `imported-${item.kind}-creator`,
        samples,
      });
      if (item.kind === "scene_effect") {
        await page
          .getByRole("button", { name: "Stop preview", exact: true })
          .click();
        await expect
          .poll(async () => {
            const stopped = await readPlaybackObservation(surface);
            return {
              status: stopped.target.status,
              scenes: stopped.effects.scene.length,
            };
          })
          .toEqual({ status: "stopped", scenes: 0 });
        await expect(
          surface.locator('[data-scene-vfx-kind="background_layers"]'),
        ).toBeHidden();
      }
    });
  }
  for (const item of imported.filter((entry) =>
    [
      "avatar_effect",
      "particle_effect",
      "scene_effect",
      "sound_effect",
    ].includes(entry.kind),
  )) {
    for (const intent of ["Gesture", "Reaction"] as const) {
      await test.step(`${item.kind}: separately imported effect in a new ${intent}`, () =>
        proveImportedEffectHandoff({
          page,
          item,
          intent,
          token,
          evidence: animamaEvidence,
        }));
    }
  }
  await page.goto("/library");
  await creatorContent.assertAnimaLoadoutUnchanged(
    loadoutBefore,
    animamaEvidence,
  );
  await creatorContent.cleanupOwnedContent();
  await creatorContent.assertLocalCatalogUnchanged(
    before,
    animamaEvidence,
    "imported-playback-cleanup",
  );
});

test("imported playback complete Anima retains imported Avatar, appearance and playable loadout @complete-anima", async ({
  page,
  creatorContent,
  animamaEvidence,
}, testInfo) => {
  // The expanded starter closure has hundreds of entries; allow playback
  // verification and serial exact receipt cleanup within the same bound.
  test.setTimeout(2_400_000);
  const before = await creatorContent.snapshotLocalCatalog();
  await openSharing(page, "Export");
  await page.getByRole("tab", { name: "Anima", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Choose an Anima", exact: true })
    .selectOption({ label: "Annie" });
  const exported = await reviewSharingExport(page);
  expect(exported.manifest.kind).toBe("anima");
  const archive = await downloadSharingPackage(
    page,
    testInfo,
    page.getByRole("button", { name: "Export Anima", exact: true }),
  );
  await openSharing(page, "Import");
  const reviewed = await uploadSharingPackage(page, archive);
  const owned = await commitSharingPackage({
    page,
    content: creatorContent,
    review: reviewed,
    journeyKey: `imported-anima-playback-${randomUUID().slice(0, 8)}`,
  });
  const anima = owned.find((entry) => entry.plan.kind === "anima")!;
  expect(anima).toBeDefined();
  expect(reviewed.anima?.identity_markdown).toBe(
    exported.manifest.anima?.identity_markdown,
  );
  await page.getByRole("button", { name: "Open Anima", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/${anima.itemId}(?:[/?#]|$)`));
  const frozenLoadout = await creatorContent.snapshotAnimaLoadout(anima.itemId);
  const runtimeResponse = await page.request.get(
    `/v1/animas/${anima.itemId}/runtime`,
  );
  expect(runtimeResponse.ok(), await runtimeResponse.text()).toBe(true);
  const runtime = (await runtimeResponse.json()) as PyAnimaRuntime;
  expect(runtime.avatar?.source.source).toBe("local");
  expect(
    owned.some(
      (entry) =>
        entry.plan.kind === "avatar" &&
        entry.itemId === runtime.avatar?.source.item_id,
    ),
  ).toBe(true);
  for (const appearance of runtime.appearances ?? []) {
    expect(appearance.source.source).toBe("local");
    expect(
      owned.some(
        (entry) =>
          entry.plan.kind === "appearance" &&
          entry.itemId === appearance.source.item_id,
      ),
    ).toBe(true);
  }
  expect(owned.some((entry) => entry.plan.kind === "appearance")).toBe(true);
  await animamaEvidence.attachJson("imported-anima-runtime-provenance", {
    animaId: anima.itemId,
    avatar: runtime.avatar?.source,
    appearances: runtime.appearances?.map((entry) => ({
      use: entry.use,
      source: entry.source,
    })),
  });
  const managementRuntime = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname ===
        `/v1/animas/${anima.itemId}/runtime` &&
      response.ok(),
  );
  await page.goto(`/animas/${anima.itemId}`);
  await managementRuntime;
  await expect(page.getByTestId("anima-management-canvas")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText("Loading anima", { exact: true })).toBeHidden({
    timeout: 30_000,
  });
  await page.getByRole("tab", { name: "Loadout", exact: true }).click();

  const importedFor = (entryId: string): OwnedPlaybackItem => {
    const proposal = reviewed.items.find(
      (entry) => entry.entry_id === entryId,
    )!;
    expect(
      proposal,
      `complete starter Anima must include selected entry ${entryId}`,
    ).toBeDefined();
    const receipt = owned.find(
      (entry) =>
        entry.plan.kind === proposal.kind &&
        entry.plan.entryName === proposal.name,
    )!;
    expect(receipt).toBeDefined();
    return receipt;
  };
  const gestureEntry = reviewed.anima!.gestures[0]?.entry_id;
  const reactionEntry = reviewed.anima!.reactions.admiration?.["3"]?.entry_id;
  expect(gestureEntry).toBeTruthy();
  expect(reactionEntry).toBeTruthy();
  for (const [kind, entryId] of [
    ["gesture", gestureEntry!],
    ["reaction", reactionEntry!],
  ] as const) {
    const receipt = importedFor(entryId);
    const item = (await playbackInventory(page, kind)).find(
      (entry) => entry.item_id === receipt.itemId,
    )!;
    expect(item).toBeDefined();
    const label = kind === "gesture" ? "Gestures" : "Reactions";
    const section = page.getByRole("region", { name: label, exact: true });
    const disclosure = section.getByRole("button", {
      name: label,
      exact: true,
    });
    if ((await disclosure.getAttribute("aria-expanded")) !== "true")
      await disclosure.click();
    if (kind === "gesture")
      await section
        .getByRole("searchbox", { name: "Search gestures", exact: true })
        .fill(item.name);
    else {
      const emotion = section.getByRole("button", { name: /^admiration$/i });
      if ((await emotion.getAttribute("aria-expanded")) !== "true")
        await emotion.click();
    }
    const prepared = waitForTypedPreview(page, item);
    await section
      .getByRole("button", { name: `Preview ${item.name}`, exact: true })
      .click();
    await prepared;
    const surface = page.locator(
      '[data-playback-surface="anima-loadout-stage"]',
    );
    await expect
      .poll(
        async () => (await readPlaybackObservation(surface)).target.runtimeId,
      )
      .toBe(runtimeId(item));
    const target = await readyTarget(surface);
    expect(target.runtimeId).toBe(runtimeId(item));
    const samples =
      kind === "gesture"
        ? await (
            item.kind === "gesture" && item.implementation.kind === "vrma"
              ? proveVrmaPlayback
              : provePoseClipPlayback
          )({
            surface,
            expectedTarget: target,
            evidence: animamaEvidence,
            evidenceName: "imported-anima-gesture",
            // Annie's shipped model maps 54 of the 55 authored humanoid bones;
            // jaw is absent, as in the existing Included Gesture proof.
            maxMissingBones: 1,
          })
        : await observePlaybackWindow({
            surface,
            expectedTarget: target,
            evidence: animamaEvidence,
            evidenceName: "imported-anima-reaction",
            until: (values) => {
              const clips = values.flatMap(
                (value) => value.motion.reactionClip ?? [],
              );
              return (
                clips.some(
                  (clip) => clip.active && clip.firedEventIds.length > 0,
                ) &&
                Math.max(...clips.map((clip) => clip.playheadSec)) -
                  Math.min(...clips.map((clip) => clip.playheadSec)) >
                  0.1 &&
                values.some(
                  (value) =>
                    (value.expressions.happy ?? 0) > 0.4 &&
                    value.effects.avatar.length > 0 &&
                    value.effects.particle.length > 0 &&
                    value.effects.scene.some((effect) => effect.active),
                )
              );
            },
          });
    await attachPlaybackCheckpoint({
      evidence: animamaEvidence,
      locator: surface,
      name: `imported-anima-${kind}`,
      samples,
    });
  }
  expect(reviewed.anima!.idle_style).toBe(exported.manifest.anima!.idle_style);
  if (reviewed.anima!.idle_style === null) {
    expect(runtime.idle_style ?? null).toBeNull();
    await animamaEvidence.attachJson("imported-anima-idle-coverage", {
      sourceIdleStyle: null,
      importedIdleStyle: null,
      playback: "not exercised: the exported Anima has no selected Idle Style",
      manualCoverage:
        "a separately selected imported Idle Style requires the retained manual test Anima",
    });
  } else {
    const idleProposal = reviewed.items.find(
      (entry) => entry.entry_id === reviewed.anima!.idle_style,
    )!;
    const idleReceipt = owned.find(
      (entry) =>
        entry.plan.kind === "idle_style" &&
        entry.plan.entryName === idleProposal.name,
    )!;
    const idle = (await playbackInventory(page, "idle_style")).find(
      (entry) => entry.item_id === idleReceipt.itemId,
    )!;
    expect(idle).toBeDefined();
    const idlePrepared = waitForTypedPreview(page, idle);
    await page
      .getByRole("button", { name: "Preview active Idle Style", exact: true })
      .click();
    const idlePreview = await idlePrepared;
    const idleSurface = page.locator(
      '[data-playback-surface="anima-loadout-stage"]',
    );
    const selectedRef =
      idle.kind === "idle_style" ? idle.default_pool[0] : undefined;
    const selectedDependency = idle.dependencies?.find(
      (entry) => entry.ref === selectedRef,
    );
    const selectedGesture = (idlePreview.supports ?? []).find(
      (entry) => entry.item_id === selectedDependency?.item_id,
    )!;
    expect(selectedGesture?.kind).toBe("gesture");
    const idleTarget = {
      kind:
        selectedGesture.kind === "gesture" &&
        selectedGesture.implementation.kind === "vrma"
          ? ("animation" as const)
          : ("anima_pose_clip" as const),
      runtimeId: runtimeId(selectedGesture),
    };
    await expect
      .poll(
        async () =>
          (await readPlaybackObservation(idleSurface)).target.runtimeId,
      )
      .toBe(idleTarget.runtimeId);
    const idleSamples =
      idleTarget.kind === "animation"
        ? await proveVrmaPlayback({
            surface: idleSurface,
            expectedTarget: idleTarget,
            evidence: animamaEvidence,
            evidenceName: "imported-anima-idle",
          })
        : await provePoseClipPlayback({
            surface: idleSurface,
            expectedTarget: idleTarget,
            evidence: animamaEvidence,
            evidenceName: "imported-anima-idle",
            maxMissingBones: 1,
          });
    await attachPlaybackCheckpoint({
      evidence: animamaEvidence,
      locator: idleSurface,
      name: "imported-anima-idle",
      samples: idleSamples,
    });
  }
  // The imported frozen definition remains unchanged, which also preserves safe ledger cleanup.
  await creatorContent.assertAnimaLoadoutUnchanged(
    frozenLoadout,
    animamaEvidence,
  );
  await page.goto("/library");
  await creatorContent.cleanupOwnedContent();
  await creatorContent.assertLocalCatalogUnchanged(
    before,
    animamaEvidence,
    "imported-anima-playback-cleanup",
  );
});
