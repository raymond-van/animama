import { expect, type Locator, type Page } from "playwright/test";

import {
  OBSERVATION_SAMPLE_INTERVAL_MS,
  readPlaybackObservation,
  type PlaybackObservation,
  type PlaybackTargetKind,
} from "./playback-observation";
import { selectAnnieFromSidebar } from "./preview-surfaces";

export type CreatorKind =
  | "Gesture"
  | "Reaction"
  | "Particle VFX"
  | "Avatar VFX"
  | "Scene VFX";

type CreatorDefinition = {
  /** Accessible name of the Create page control that opens the creator. */
  actionName: RegExp;
  /**
   * Effect cards open the Effects template picker at their kind; the helper
   * then chooses Start from scratch. Action creators are direct links.
   */
  viaTemplatePicker: boolean;
  canvasTestId: string;
  path: string;
  targetKind: PlaybackTargetKind;
};

const CREATORS: Record<CreatorKind, CreatorDefinition> = {
  Gesture: {
    actionName: /^Create Gesture$/,
    viaTemplatePicker: false,
    canvasTestId: "action-editor-canvas",
    path: "/gestures/new",
    targetKind: "anima_pose_clip",
  },
  Reaction: {
    actionName: /^Create Reaction$/,
    viaTemplatePicker: false,
    canvasTestId: "action-editor-canvas",
    path: "/reactions/new",
    targetKind: "anima_pose_clip",
  },
  "Particle VFX": {
    actionName: /^Particle FX\b.*\bCreate Particle FX$/,
    viaTemplatePicker: true,
    canvasTestId: "particle-vfx-creator-canvas",
    path: "/particle-effects/new",
    targetKind: "particle_vfx",
  },
  "Avatar VFX": {
    actionName: /^Avatar FX\b.*\bCreate Avatar FX$/,
    viaTemplatePicker: true,
    canvasTestId: "avatar-effect-creator-canvas",
    path: "/avatar-effects/new",
    targetKind: "avatar_vfx",
  },
  "Scene VFX": {
    actionName: /^Scene FX\b.*\bCreate Scene FX$/,
    viaTemplatePicker: true,
    canvasTestId: "scene-effect-creator-canvas",
    path: "/scene-effects/new",
    targetKind: "scene_vfx",
  },
};

export type CreatorStage = {
  animaId: string | null;
  observation: PlaybackObservation;
  surface: Locator;
};

/**
 * Select Annie, follow visible Create links (for effects, the template
 * picker's Start from scratch), and resolve one real creator preview without
 * deep-link navigation or access to editor/controller state.
 */
export async function openCreatorStage(args: {
  creator: CreatorKind;
  page: Page;
  selectAnnie?: boolean;
}): Promise<CreatorStage> {
  const definition = CREATORS[args.creator];
  const animaId =
    args.selectAnnie === false ? null : await selectAnnieFromSidebar(args.page);

  const createLink = args.page.getByRole("link", {
    name: "Create",
    exact: true,
  });
  await expect(createLink).toHaveCount(1);
  await expect(createLink).toBeVisible();
  await createLink.click();
  await expect(args.page).toHaveURL(/\/create(?:[/?#]|$)/);
  await expect(
    args.page.getByRole("heading", { name: "Create", exact: true }),
  ).toBeVisible();

  const creatorEntry = args.page.getByRole(
    definition.viaTemplatePicker ? "button" : "link",
    { name: definition.actionName },
  );
  await expect(creatorEntry).toHaveCount(1);
  await expect(creatorEntry).toBeVisible();
  await creatorEntry.click();
  if (definition.viaTemplatePicker) {
    const picker = effectTemplatePicker(args.page);
    await expect(picker).toBeVisible();
    await picker
      .getByRole("link", { name: "Start from scratch", exact: true })
      .click();
    await expect(picker).toBeHidden();
  }
  await expect(args.page).toHaveURL(
    new RegExp(`${escapeRegExp(definition.path)}(?:[/?#]|$)`),
  );

  const canvas = args.page.locator(
    `[data-testid="${definition.canvasTestId}"]:visible`,
  );
  await expect(canvas).toHaveCount(1);
  await expect(canvas).toBeVisible({ timeout: 30_000 });
  const surface = args.page.locator('[data-playback-surface="creator-stage"]');
  await expect(surface).toHaveCount(1);
  await expect(surface).toBeVisible();
  await expect(
    surface.locator("output[data-playback-observation]"),
  ).toHaveCount(1);

  const observation = await waitForCreatorStageReady({
    expectedKind: definition.targetKind,
    surface,
  });
  return { animaId, observation, surface };
}

export type StoredDraftExpectation = {
  /** IndexedDB database the creator writes; localStorage is always checked. */
  database: string | null;
  name: string;
  setting: { path: string[]; value: number } | null;
};

/**
 * Wait until browser recovery holds this exact draft, rather than guessing the
 * creator's autosave debounce. Never opens a database the page has not
 * created, so the creator's own schema upgrade still runs.
 */
export async function waitForStoredDraft(
  page: Page,
  expected: StoredDraftExpectation,
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(async ({ database, name, setting }) => {
          const matches = (record: unknown): boolean => {
            if (!record || typeof record !== "object") return false;
            const document = (record as { document?: unknown }).document;
            if (!document || typeof document !== "object") return false;
            if ((document as { name?: unknown }).name !== name) return false;
            if (!setting) return true;
            let value: unknown = document;
            for (const key of setting.path)
              value = (value as Record<string, unknown> | null)?.[key];
            return value === setting.value;
          };
          for (let index = 0; index < localStorage.length; index += 1) {
            const raw = localStorage.getItem(localStorage.key(index) ?? "");
            try {
              if (raw && matches(JSON.parse(raw))) return true;
            } catch {
              // Unrelated non-JSON settings.
            }
          }
          if (!database) return false;
          const known = await indexedDB.databases();
          if (!known.some((entry) => entry.name === database)) return false;
          return new Promise<boolean>((resolve) => {
            const opening = indexedDB.open(database);
            opening.onerror = () => resolve(false);
            opening.onsuccess = () => {
              const db = opening.result;
              const stores = Array.from(db.objectStoreNames);
              if (stores.length === 0) {
                db.close();
                resolve(false);
                return;
              }
              const request = db
                .transaction(stores[0]!, "readonly")
                .objectStore(stores[0]!)
                .getAll();
              request.onsuccess = () => {
                db.close();
                resolve(request.result.some(matches));
              };
              request.onerror = () => {
                db.close();
                resolve(false);
              };
            };
          });
        }, expected),
      { message: "browser recovery stores the edited draft" },
    )
    .toBe(true);
}

/**
 * Switch a creator between Simple and Advanced with its toolbar switch.
 * Creators open in Simple; the emitter, layer and texture panels are in
 * Advanced.
 */
export async function chooseCreatorMode(
  page: Page,
  mode: "Simple" | "Advanced",
): Promise<void> {
  const tab = page
    .getByRole("tablist", { name: "Creator mode", exact: true })
    .getByRole("tab", { name: mode, exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
}

/** The Effects template picker dialog, opened by any effect entry point. */
export function effectTemplatePicker(page: Page): Locator {
  return page.getByTestId("effect-template-picker");
}

/** Read the creator's portable JSON through its visible View JSON dialog. */
export async function readPortableJson(
  page: Page,
  title: string,
): Promise<string> {
  await page.getByRole("button", { name: "View JSON", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: title, exact: true });
  const value = await dialog.getByRole("textbox").inputValue();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  return value;
}

/** Exercise the actual navigation blocker, without clearing browser storage. */
export async function discardToLibrary(page: Page): Promise<void> {
  await page.getByRole("link", { name: "Library", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Discard authoring changes?",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("button", { name: "Discard and continue", exact: true })
    .click();
  await expect(page).toHaveURL(/\/library(?:[/?#]|$)/);
  // The URL changes before the blocked navigation commits. Wait for the
  // Library itself so the next sidebar navigation is not absorbed by it.
  await expect(
    page.getByRole("heading", { name: "Library", exact: true }),
  ).toBeVisible();
}

/** Wait until the selected Annie Avatar and creator lifecycle settle. */
async function waitForCreatorStageReady(args: {
  expectedKind: PlaybackTargetKind;
  surface: Locator;
  timeoutMs?: number;
}): Promise<PlaybackObservation> {
  const deadline = Date.now() + (args.timeoutMs ?? 30_000);
  let last: PlaybackObservation | null = null;
  while (Date.now() <= deadline) {
    last = await readPlaybackObservation(args.surface);
    if (last.surface !== "creator-stage") {
      throw new Error(`Expected creator-stage; received ${last.surface}.`);
    }
    if (last.target.kind !== args.expectedKind) {
      throw new Error(
        `Expected creator target ${args.expectedKind}; received ${last.target.kind}.`,
      );
    }
    if (!last.target.runtimeId.trim()) {
      throw new Error(
        "Creator observation omitted its draft runtime identity.",
      );
    }
    if (last.target.status === "error") {
      throw new Error(
        `Creator target ${last.target.runtimeId} entered error state.`,
      );
    }
    const avatarPending = last.diagnostics.some(
      (diagnostic) =>
        diagnostic.channel === "avatar" &&
        diagnostic.code === "avatar_not_ready",
    );
    if (
      !avatarPending &&
      ["ready", "playing", "stopped"].includes(last.target.status)
    ) {
      return last;
    }
    await args.surface.page().waitForTimeout(OBSERVATION_SAMPLE_INTERVAL_MS);
  }
  throw new Error(
    `Creator stage did not become Avatar-ready within ${args.timeoutMs ?? 30_000}ms; last lifecycle was ${last?.target.status ?? "unobserved"}.`,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
