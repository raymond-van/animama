import type { PyGenerationDraft } from "@animama/runtime-contracts/api-types";

import type { PyContentDependency } from "@/lib/content/catalogTypes";
import { isRecord } from "@/lib/records";
import { actionComponentPreviewRootKey } from "@/query/hooks/useActionComponentPreviews";
import { referencedAliases } from "@/ui/action-editor/actionDocument";
import { parseActionDependencies } from "@/ui/action-editor/actionProject";

/**
 * The existing effects a draft's timeline plays (R7.3). A Gesture drafted on
 * the Generate page may hold timeline events that play Avatar, Particle and
 * Scene Effects of the owner's Library. Each event names its effect by an
 * alias, and the draft's project pins every alias to one Library item with a
 * dependency in the creator's own shape, so the creator's preview, import and
 * save read a draft's effects unchanged.
 *
 * A project is the backend's record of a model's output, so it is read
 * tolerantly here: nothing throws, and what the creator's Import would refuse
 * reads as not declared.
 */

/** What a draft's timeline plays, read from its project. */
export type DraftEffects = {
  /**
   * The dependencies its events use, as the creator's Import reads them. One
   * that no event names is left out, as the creator's Save leaves it out.
   */
  dependencies: readonly PyContentDependency[];
  /** The alias of each effect the events name, once, sorted. */
  aliases: readonly string[];
  /** Of those, the aliases the project pins to no Library item. */
  undeclared: readonly string[];
};

/** A draft's effects as its card shows them. */
export type DraftEffectsInfo = {
  /** The alias of each effect the draft plays, sorted. */
  aliases: readonly string[];
  /**
   * Of those, the effects the draft cannot play any more: the Library no
   * longer holds the item, or the draft never pinned the alias to one. While
   * any is named the draft cannot be saved; a run that revises it removes
   * their events.
   */
  missing: readonly string[];
};

const NO_EFFECTS: DraftEffects = Object.freeze({
  dependencies: Object.freeze([]),
  aliases: Object.freeze([]),
  undeclared: Object.freeze([]),
});

/**
 * One reading per project object. A draft's project is replaced only by a new
 * version, so a status update leaves the reading, and what depends on it (the
 * preview's mounted effects), as it was.
 */
const read = new WeakMap<object, DraftEffects>();

function readDraftEffects(project: Record<string, unknown>): DraftEffects {
  if (!isRecord(project.sequence)) return NO_EFFECTS;
  const aliases = referencedAliases(project.sequence);
  if (aliases.length === 0) return NO_EFFECTS;
  let declared: PyContentDependency[] = [];
  try {
    declared = parseActionDependencies(project.dependencies);
  } catch {
    // The creator's Import refuses these dependencies, and Save with them:
    // every effect the events name then counts as not declared.
  }
  const named = new Set(aliases);
  const dependencies = declared.filter(({ alias }) => named.has(alias));
  const pinned = new Set(dependencies.map(({ alias }) => alias));
  return {
    dependencies,
    aliases,
    undeclared: aliases.filter((alias) => !pinned.has(alias)),
  };
}

/** The effects a draft's timeline plays; none for a draft without a clip. */
export function draftEffects(
  draft: Pick<PyGenerationDraft, "project">,
): DraftEffects {
  const { project } = draft;
  if (!isRecord(project)) return NO_EFFECTS;
  let effects = read.get(project);
  if (!effects) {
    effects = readDraftEffects(project);
    read.set(project, effects);
  }
  return effects;
}

/**
 * Every Library item the listed drafts depend on, once each and in a stable
 * order, to resolve them all in one request. Two drafts may name the same
 * item by different aliases; the alias kept is of no consequence here.
 */
export function listedEffectDependencies(
  effects: readonly DraftEffects[],
): PyContentDependency[] {
  const bySource = new Map<string, PyContentDependency>();
  for (const { dependencies } of effects)
    for (const dependency of dependencies) {
      const key = actionComponentPreviewRootKey(dependency);
      if (!bySource.has(key)) bySource.set(key, dependency);
    }
  return [...bySource.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, dependency]) => dependency);
}

/**
 * The code a preview batch gives a root whose source the owner's Library does
 * not hold: the item was deleted. Every other code is about an item that is
 * still there (it needs a rescan, is invalid, or did not fit the batch), which
 * is no reason to hold back a draft: the Library's own save decides then.
 */
const SOURCE_GONE_CODE = "source_unavailable";

/** The root keys a preview batch reported as no longer in the Library. */
export function goneEffectRootKeys(
  diagnostics: readonly { root_key: string; code: string }[],
): Set<string> {
  return new Set(
    diagnostics
      .filter(({ code }) => code === SOURCE_GONE_CODE)
      .map(({ root_key }) => root_key),
  );
}

/**
 * What a draft's card says of its effects, given the sources known to be gone
 * from the Library; `null` for a draft that plays none. A source that was not
 * checked (the request is in flight or failed) is not known to be gone.
 */
export function draftEffectsInfo(
  effects: DraftEffects,
  goneRootKeys: ReadonlySet<string>,
): DraftEffectsInfo | null {
  if (effects.aliases.length === 0) return null;
  const missing = new Set(effects.undeclared);
  for (const dependency of effects.dependencies)
    if (goneRootKeys.has(actionComponentPreviewRootKey(dependency)))
      missing.add(dependency.alias);
  return {
    aliases: effects.aliases,
    missing: effects.aliases.filter((alias) => missing.has(alias)),
  };
}
