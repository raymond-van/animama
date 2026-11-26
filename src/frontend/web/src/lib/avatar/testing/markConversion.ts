import type { Avatar } from "../Avatar";
import { ANIMAMA_CONVERSION_EXTENSION } from "../avatarConversionMarker";

/**
 * Mark a loaded test Avatar as an MMD model converted by Animama Avatar
 * Converter: its glTF lists the converter's marker. Face parts and landmarks
 * read it when they are found again (`setFacePartCorrections(null)`).
 */
export function markAnimamaConversion(avatar: Avatar): void {
  const json = avatar.sourceGltf!.parser.json as { extensionsUsed?: string[] };
  json.extensionsUsed = [
    ...(json.extensionsUsed ?? []),
    ANIMAMA_CONVERSION_EXTENSION,
  ];
}
