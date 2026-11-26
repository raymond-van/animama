/**
 * Stable, machine-readable Avatar findings. Each site that logs or lists an
 * English warning for the dev panels also records one of these, so the
 * Diagnostics view can show localized text and reports stay free of model,
 * material and effect names. Parameters hold only counts, part roles, binding
 * keys, glTF extension names and runtime effect ids; a Local effect's runtime
 * id derives from its name, so shareable reports replace it
 * (`avatarDiagnosticsReport.ts`).
 */
export const AVATAR_ISSUE_CODES = [
  // The file and its load (Diagnostics' off-screen load).
  "file_unavailable",
  "file_unreadable",
  // A glTF extension the file needs that the runtime cannot load
  // (`avatarGltfExtensions.ts`); read from the file, before any load.
  "avatar_extension_unsupported",
  // Meshes whose primitives name their morph targets differently, which load
  // unnamed (`primitiveTargetNames.ts`); read from the file, before any load.
  "morph_target_names_mismatched",
  // Humanoid bones naming bones that move nothing: moved to the bones the mesh
  // follows at load, or left without a counterpart (`humanoidBoneRepair.ts`);
  // read from the file, before any load.
  "humanoid_bones_remapped",
  "humanoid_bones_unweighted",
  // Every material ignores light, so the file looks flat as authored; the
  // loader adds toon shading unless the Materials setting is Simple
  // (`unlitToonShading.ts`); read from the file, before any load.
  "materials_unlit",
  "avatar_load_failed",
  // The live scene's primitives could not be listed.
  "scene_bindings_unavailable",
  // Face parts (`vfx/faceParts.ts`, `Avatar`, `runtimeAvatarFaceParts.ts`).
  "face_parts_detection_failed",
  "face_parts_expressions_missing",
  "face_parts_whole_body_head_missing",
  "face_parts_correction_invalid",
  "face_parts_correction_schema_unsupported",
  "face_parts_correction_other_file",
  "face_parts_correction_digest_unknown",
  "face_parts_correction_unknown_bindings",
  // Expressions (`diagnostics/avatarDiagnostics.ts`).
  "face_expressions_none",
  // Face landmarks (`vfx/AvatarFaceLandmarks.ts`).
  "landmarks_face_skin_missing",
  "landmarks_anchor_missing",
  "landmarks_face_bounds_failed",
  "landmarks_eyes_missing",
  // Face texture anchors (`vfx/AvatarFaceTextureAnchors.ts`).
  "anchors_landmarks_unavailable",
  "anchors_face_skin_missing",
  "anchors_projection_failed",
  "anchors_mouth_missing",
  // Springs (`spring-bone/`).
  "springs_source_unavailable",
  "springs_metadata_missing",
  "springs_unmapped_joints",
  "springs_helper_failed",
  // Effects (`vfx/AvatarVFXController.ts`).
  "effect_unknown",
  "effect_wrong_kind",
  "effect_target_unknown",
  "effect_load_failed",
  "effect_placement_failed",
  "effect_attachment_limit",
  "effect_face_part_missing",
  // Iris art on an eye estimated on the face, which has no iris mesh part.
  "effect_iris_mesh_missing",
  // Painted face art that would not show: its anchor lies under eyes or a
  // nose modelled over the skin, the face shows no paintable texture, or
  // darkening art lies on a face too dark for it to change.
  "effect_anchor_covered",
  "effect_face_texture_hidden",
  "effect_surface_too_dark",
  "effect_target_unresolved",
  "effect_target_incompatible",
  "effect_overlay_required",
  "effect_face_skin_required",
  "effect_skin_color_unavailable",
  "eye_detail_not_hidden",
  // `Fcl_EYE_Iris_Hide` on a model without that shape (`irisHideExpression.ts`).
  "iris_hide_unavailable",
] as const;

export type AvatarIssueCode = (typeof AVATAR_ISSUE_CODES)[number];

/** Parameters an issue's catalog text may interpolate. */
export type AvatarIssueParams = Readonly<Record<string, string | number>>;

export type AvatarIssue = {
  readonly code: AvatarIssueCode;
  readonly params?: AvatarIssueParams;
};

function issueKey(issue: AvatarIssue): string {
  const params = Object.entries(issue.params ?? {}).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return JSON.stringify([issue.code, params]);
}

/** Append an issue unless an equal one (same code and parameters) is listed. */
export function addAvatarIssue(
  issues: AvatarIssue[],
  issue: AvatarIssue,
): void {
  const key = issueKey(issue);
  if (issues.some((listed) => issueKey(listed) === key)) return;
  issues.push(issue);
}

/** The issues of several sources, each listed once, in first-seen order. */
export function mergeAvatarIssues(
  ...sources: readonly (readonly AvatarIssue[] | null | undefined)[]
): AvatarIssue[] {
  const merged: AvatarIssue[] = [];
  for (const source of sources) {
    for (const issue of source ?? []) addAvatarIssue(merged, issue);
  }
  return merged;
}
