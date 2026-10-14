import {
  equalParticleVFXSimpleSettings,
  type ParticleVFXEditorDraft,
} from "@/lib/avatar/particle-vfx";
import { referencedParticleVFXTextureFiles } from "@/lib/avatar/particle-vfx/editor/textureFiles";

/**
 * Fingerprint editable typed Particle Effect content, excluding camera state
 * and Simple mode's reference, control positions and colour theme (their
 * result is already in the effect). Save, recovery sessions and the
 * unsaved-changes check use it. Texture files count by content hash, and
 * only while the effect uses them.
 */
export function particleVFXDocumentFingerprint(
  draft: ParticleVFXEditorDraft,
): string {
  const textures = Object.fromEntries(
    Object.entries(referencedParticleVFXTextureFiles(draft)).map(
      ([reference, file]) => [reference, file.sha256],
    ),
  );
  return JSON.stringify(
    canonicalJson({
      catalog: draft.catalog,
      quarksJson: draft.quarksJson,
      textures,
    }),
  );
}

/**
 * History equality: equal authored content at the same Simple control
 * positions and colour theme creates no undo step. Moving a Simple control
 * or choosing a theme is a step even when it leaves the effect as it was
 * (for example Amount on an effect of single-particle layers, or White on
 * an effect without colour).
 */
export function equalParticleVFXDrafts(
  left: ParticleVFXEditorDraft,
  right: ParticleVFXEditorDraft,
): boolean {
  return (
    equalParticleVFXSimpleSettings(left, right) &&
    particleVFXDocumentFingerprint(left) ===
      particleVFXDocumentFingerprint(right)
  );
}

/**
 * Apply Simple's rebase rule to an edit that did not come from a Simple
 * control (an Advanced field such as a colour, an emitter added, duplicated
 * or removed, a preset, a texture, an import): when the edit changes the
 * effect, the edited effect becomes Simple's new reference and the controls
 * return to 100 % and Original. A colour theme's copies stay as the edited
 * effect's own textures. An edit that leaves the effect as it was keeps the
 * Simple state.
 */
export function rebaseParticleVFXSimpleControls(
  current: ParticleVFXEditorDraft,
  next: ParticleVFXEditorDraft,
): ParticleVFXEditorDraft {
  if (next === current) return current;
  if (
    particleVFXDocumentFingerprint(next) ===
    particleVFXDocumentFingerprint(current)
  )
    return next.simple === current.simple
      ? next
      : { ...next, simple: current.simple };
  return next.simple ? { ...next, simple: null } : next;
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalJson(child)]),
    );
  }
  return value;
}
