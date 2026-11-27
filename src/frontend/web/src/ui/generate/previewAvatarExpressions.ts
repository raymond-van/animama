import type { Avatar } from "@/lib/avatar";

/**
 * The chosen preview Avatar's expression names, as the assistant is told
 * them and as a draft's keyed names are compared with them. Only names are
 * read: nothing else of the person's own Avatar leaves the preview.
 */
export type PreviewAvatarExpressions = {
  /** Every expression the Avatar can show, ARKit shapes under their canonical names. */
  names: string[];
  /**
   * The canonical ARKit names this Avatar resolved, which group as its ARKit
   * family; `undefined` when the Avatar reports no ARKit coverage, so the
   * canonical list decides.
   */
  arkitNames: string[] | undefined;
};

/** Read a loaded Avatar's expression names; `null` without an Avatar. */
export function previewAvatarExpressions(
  avatar: Pick<Avatar, "getAvailableExpressions" | "arkitFace"> | null,
): PreviewAvatarExpressions | null {
  if (!avatar) return null;
  const resolved = avatar.arkitFace?.capability.resolved;
  return {
    names: avatar.getAvailableExpressions(),
    arkitNames: resolved ? [...resolved.keys()] : undefined,
  };
}
