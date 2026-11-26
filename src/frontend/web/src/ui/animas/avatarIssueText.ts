import type { TFunction } from "i18next";

import type {
  AvatarIssue,
  AvatarIssueCode,
} from "@/lib/avatar/diagnostics/issues";
import type { AvatarFacePartRole } from "@/lib/avatar/vfx/faceParts";
import { facePartRoleName } from "@/ui/avatar-effect-creator/facePartsPanel";

/**
 * Catalog text for a finding. `effectName` words an effect id on screen
 * (reports keep the id); an unknown effect reads as "An effect".
 */
export function avatarIssueText(
  t: TFunction<"animas">,
  issue: AvatarIssue,
  effectName: (effectId: string) => string | undefined,
): string {
  const params = issue.params ?? {};
  const effect =
    effectName(String(params.effectId ?? "")) ??
    t("avatarDiagnostics.issues.anEffect");
  const part = params.part
    ? facePartRoleName(params.part as AvatarFacePartRole)
    : "";
  const count = Number(params.count ?? 0);
  const texts: Record<AvatarIssueCode, () => string> = {
    file_unavailable: () => t("avatarDiagnostics.issues.file_unavailable"),
    file_unreadable: () => t("avatarDiagnostics.issues.file_unreadable"),
    avatar_extension_unsupported: () =>
      t("avatarDiagnostics.issues.avatar_extension_unsupported", {
        extension: String(params.extension ?? ""),
      }),
    morph_target_names_mismatched: () =>
      t("avatarDiagnostics.issues.morph_target_names_mismatched", { count }),
    humanoid_bones_remapped: () =>
      t("avatarDiagnostics.issues.humanoid_bones_remapped", { count }),
    humanoid_bones_unweighted: () =>
      t("avatarDiagnostics.issues.humanoid_bones_unweighted", { count }),
    materials_unlit: () => t("avatarDiagnostics.issues.materials_unlit"),
    avatar_load_failed: () => t("avatarDiagnostics.issues.avatar_load_failed"),
    scene_bindings_unavailable: () =>
      t("avatarDiagnostics.issues.scene_bindings_unavailable"),
    face_parts_detection_failed: () =>
      t("avatarDiagnostics.issues.face_parts_detection_failed"),
    face_parts_expressions_missing: () =>
      t("avatarDiagnostics.issues.face_parts_expressions_missing"),
    face_parts_whole_body_head_missing: () =>
      t("avatarDiagnostics.issues.face_parts_whole_body_head_missing"),
    face_parts_correction_invalid: () =>
      t("avatarDiagnostics.issues.face_parts_correction_invalid"),
    face_parts_correction_schema_unsupported: () =>
      t("avatarDiagnostics.issues.face_parts_correction_schema_unsupported"),
    face_parts_correction_other_file: () =>
      t("avatarDiagnostics.issues.face_parts_correction_other_file"),
    face_parts_correction_digest_unknown: () =>
      t("avatarDiagnostics.issues.face_parts_correction_digest_unknown"),
    iris_hide_unavailable: () =>
      t("avatarDiagnostics.issues.iris_hide_unavailable"),
    face_expressions_none: () =>
      t("avatarDiagnostics.issues.face_expressions_none"),
    face_parts_correction_unknown_bindings: () =>
      t("avatarDiagnostics.issues.face_parts_correction_unknown_bindings", {
        count,
        part,
      }),
    landmarks_face_skin_missing: () =>
      t("avatarDiagnostics.issues.landmarks_face_skin_missing"),
    landmarks_anchor_missing: () =>
      t("avatarDiagnostics.issues.landmarks_anchor_missing"),
    landmarks_face_bounds_failed: () =>
      t("avatarDiagnostics.issues.landmarks_face_bounds_failed"),
    landmarks_eyes_missing: () =>
      t("avatarDiagnostics.issues.landmarks_eyes_missing"),
    anchors_landmarks_unavailable: () =>
      t("avatarDiagnostics.issues.anchors_landmarks_unavailable"),
    anchors_face_skin_missing: () =>
      t("avatarDiagnostics.issues.anchors_face_skin_missing"),
    anchors_projection_failed: () =>
      t("avatarDiagnostics.issues.anchors_projection_failed"),
    anchors_mouth_missing: () =>
      t("avatarDiagnostics.issues.anchors_mouth_missing"),
    springs_source_unavailable: () =>
      t("avatarDiagnostics.issues.springs_source_unavailable"),
    springs_metadata_missing: () =>
      t("avatarDiagnostics.issues.springs_metadata_missing"),
    springs_unmapped_joints: () =>
      t("avatarDiagnostics.issues.springs_unmapped_joints", { count }),
    springs_helper_failed: () =>
      t("avatarDiagnostics.issues.springs_helper_failed"),
    effect_unknown: () => t("avatarDiagnostics.issues.effect_unknown"),
    effect_wrong_kind: () =>
      t("avatarDiagnostics.issues.effect_wrong_kind", { effect }),
    effect_target_unknown: () =>
      t("avatarDiagnostics.issues.effect_target_unknown", { effect }),
    effect_load_failed: () =>
      t("avatarDiagnostics.issues.effect_load_failed", { effect }),
    effect_placement_failed: () =>
      t("avatarDiagnostics.issues.effect_placement_failed", { effect }),
    effect_attachment_limit: () =>
      t("avatarDiagnostics.issues.effect_attachment_limit", {
        effect,
        limit: Number(params.limit ?? 0),
      }),
    effect_face_part_missing: () =>
      t("avatarDiagnostics.issues.effect_face_part_missing", { effect, part }),
    effect_iris_mesh_missing: () =>
      t("avatarDiagnostics.issues.effect_iris_mesh_missing", { effect, part }),
    effect_anchor_covered: () =>
      t("avatarDiagnostics.issues.effect_anchor_covered", { effect }),
    effect_face_texture_hidden: () =>
      t("avatarDiagnostics.issues.effect_face_texture_hidden", { effect }),
    effect_surface_too_dark: () =>
      t("avatarDiagnostics.issues.effect_surface_too_dark", { effect }),
    effect_target_unresolved: () =>
      t("avatarDiagnostics.issues.effect_target_unresolved", { effect }),
    effect_target_incompatible: () =>
      t("avatarDiagnostics.issues.effect_target_incompatible", { effect }),
    effect_overlay_required: () =>
      t("avatarDiagnostics.issues.effect_overlay_required", { effect }),
    effect_face_skin_required: () =>
      t("avatarDiagnostics.issues.effect_face_skin_required", { effect }),
    effect_skin_color_unavailable: () =>
      t("avatarDiagnostics.issues.effect_skin_color_unavailable", { effect }),
    eye_detail_not_hidden: () =>
      t("avatarDiagnostics.issues.eye_detail_not_hidden", { effect, part }),
  };
  return texts[issue.code]();
}
