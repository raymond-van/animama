import type {
  ItemRevisionRef,
  PyAvatarContent,
} from "@animama/runtime-contracts/api-types";

/**
 * The shown Avatar revision when its portrait should be captured again, or
 * null. Only a saved Local Avatar qualifies, when it has no portrait or its
 * portrait was captured from another revision (a replaced model, a face part
 * correction). Shipped and imported portraits (no capture revision) are kept.
 */
export function portraitRetakeTarget(
  shown: ItemRevisionRef | null,
  avatars: readonly PyAvatarContent[],
): ItemRevisionRef | null {
  if (!shown) return null;
  const avatar = avatars.find(
    (item) =>
      item.item_id === shown.item_id &&
      item.revision_sha256 === shown.revision_sha256,
  );
  if (!avatar || avatar.source !== "local") return null;
  const captured = avatar.portrait?.avatar_revision_sha256;
  const current = avatar.portrait
    ? captured === null ||
      captured === undefined ||
      captured === shown.revision_sha256
    : false;
  return current ? null : shown;
}
