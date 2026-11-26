/**
 * Model-agnostic face and eye part detection.
 *
 * VRM does not name face parts, so detection reads spec signals first: the
 * humanoid eye bones, skin weights, the primitives that the `blink` and `aa`
 * expressions morph (filled from MMD, ARKit or VRChat shapes where the file
 * leaves them empty, `faceSignals.ts`; `blink` alone when `aa` morphs no
 * mesh), expression look-at texture transforms
 * and spring-bone joints. Material names are only a per-role fallback, and user corrections
 * (keyed to the exact VRM digest) override both.
 */
import type { AvatarFacePartCorrection } from "@animama/runtime-contracts/api-types";
import type { VRM } from "@pixiv/three-vrm";
import * as THREE from "three";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";

import type { Avatar } from "../Avatar";
import { isAnimamaConversion } from "../avatarConversionMarker";
import { addAvatarIssue, type AvatarIssue } from "../diagnostics/issues";
import { createBoneClassifier, type BoneClass } from "./boneClasses";
import { buildRuntimePrimitiveBindings } from "../vrmEditorInspection";
import {
  readVertexPosition,
  resolvePrimitiveVertexRange,
  UnionFind,
} from "./avatarPrimitiveUtils";
import type { RuntimePrimitiveBindingEntry } from "./avatarPrimitiveUtils";
import {
  matchAvatarTargetRole,
  resolveEyeIrisTargetBindings,
  resolveFaceTargetBinding,
} from "./avatarRuntimeTargeting";
import { findFaceIslandTriangles } from "./faceIsland";
import { resolveAvatarVFXModelProfile } from "./profiles";
import {
  isAttachmentVFXEntry,
  isEyeHoverVFXEntry,
  isTextureVFXEntry,
  type AvatarVFXParsedEntry,
  type AvatarVFXTargetRole,
} from "./types";

export const AVATAR_FACE_PARTS_SCHEMA = "animama/avatar-face-parts/1";

/** Roles a correction can name; `eye_left`/`eye_right` hold the irises. */
export const AVATAR_FACE_PART_ROLES = [
  "face_skin",
  "eye_left",
  "eye_right",
  "eye_highlight",
  "eyeline",
  "eyelash",
  "hair",
] as const;
export type AvatarFacePartRole = (typeof AVATAR_FACE_PART_ROLES)[number];

/**
 * Lowercase part names for English runtime diagnostics. The creator words
 * parts in the UI Locale instead (`facePartRoleName`).
 */
export const AVATAR_FACE_PART_LABELS: Record<AvatarFacePartRole, string> = {
  face_skin: "face skin",
  eye_left: "left eye",
  eye_right: "right eye",
  eye_highlight: "eye highlight",
  eyeline: "eye line",
  eyelash: "eyelash",
  hair: "hair",
};

/**
 * Where a part's bindings came from, in decreasing order of trust. An
 * `estimated` eye has no geometry of its own (it is painted on the face skin
 * or modelled inside the face primitive); only its position is known, from
 * its {@link AvatarEyeEstimate}.
 */
export type AvatarFacePartSource =
  | "corrected"
  | "signals"
  | "names"
  | "estimated"
  | "missing";

/**
 * What an estimated eye's position comes from: where `blink` moves the face
 * skin on that side, or the humanoid eye bone.
 */
export type AvatarEyeEstimate = "blink" | "eye_bone";

/**
 * Where an estimated eye lies, in head-anchor space, measured once at
 * detection; `AvatarFaceLandmarks` builds the eye's landmark from it.
 * Runtime only.
 */
export type AvatarEyeEstimateGeometry = {
  /** The face skin binding the eye lies on. */
  bindingKey: string;
  center: THREE.Vector3;
  /** An iris-sized width and height (m). */
  width: number;
  height: number;
  /**
   * A `blink` eye's region: the face vertices blink moves there and their
   * rest positions, for the eye's texture rect on the face texture.
   */
  region?: { vertices: number[]; points: THREE.Vector3[] };
  /**
   * The depth (anchor-space z) of the face surface's front over the eye and
   * one eye size around it, so art hovering over the eye can sit in front
   * of it. Unset when the face surface cannot be read.
   */
  surfaceFront?: number;
};

/**
 * Triangles of one primitive that hold a part drawn inside another part's
 * primitive (lash strands in the face mesh, say), or the face skin's head
 * region of a primitive that also holds the body, as triangle numbers in that
 * primitive's index buffer. Runtime only: corrections and packages name whole
 * primitives.
 */
export type AvatarFacePartRegion = {
  bindingKey: string;
  triangles: readonly number[];
};

export type AvatarFacePart = {
  role: AvatarFacePartRole;
  /** glTF `node:mesh:primitive` keys, as `buildRuntimePrimitiveBindings` emits. */
  bindings: string[];
  /**
   * Eye lines and lashes inside the face or eye primitives; see the type.
   * On face skin, the head region of a binding whose primitive also holds
   * the body: the face is only those triangles of it
   * ({@link findFaceSkinRegion}).
   */
  regions?: AvatarFacePartRegion[];
  source: AvatarFacePartSource;
  /** For an `estimated` eye, what its position comes from. */
  estimate?: AvatarEyeEstimate;
  /** 0 (missing) to 1 (corrected); signals report how clearly they separated. */
  confidence: number;
  /**
   * For a corrected part, what detection found without the correction. A
   * saved correction pins every required part, so only a part whose bindings
   * differ from detection was changed by the user ({@link isFacePartEdited}).
   */
  detected?: AvatarFacePart;
};

/**
 * A saved correction (`AvatarFacePartCorrection`, shared with the backend via
 * OpenAPI): required face and eye parts, optional others, for one VRM digest.
 */
export type AvatarFacePartCorrections = AvatarFacePartCorrection;

export type AvatarFacePartMap = {
  parts: Record<AvatarFacePartRole, AvatarFacePart>;
  /** Eye-bone primitives classified as eye whites; diagnostic only. */
  eyeWhite: string[];
  diagnostics: string[];
  /** `diagnostics` as stable codes, for the Diagnostics view. */
  issues: AvatarIssue[];
  /** Where each `estimated` eye lies; present only when an eye is estimated. */
  eyeEstimates?: Partial<Record<"left" | "right", AvatarEyeEstimateGeometry>>;
};

export type DetectAvatarFacePartsOptions = {
  /** Allow material-name fallback per role. Defaults to true. */
  names?: boolean;
  /** Select a per-model name profile for the fallback. */
  sourceKey?: string | null;
  sourceUrl?: string | null;
  corrections?: AvatarFacePartCorrections | null;
  /** sha256 of the loaded VRM bytes; a correction must match it. */
  vrmSha256?: string | null;
};

/** Head-skinned: ≥90% of skin weight on the head and its non-spring, non-eye descendants. */
const HEAD_SKINNED_MIN_SHARE = 0.9;
/** "Mostly" skinned to a bone class. */
const MAJORITY_SHARE = 0.5;
/**
 * A face primitive with more of its skin weight than this below the neck
 * (spine, chest, hips, limbs; not the neck) also holds the body, even when
 * most of it is on the head, as on a one-mesh chibi Avatar (about half below
 * the neck). Separate face meshes hold about none.
 */
const BODY_SKIN_SHARE = 0.35;
/**
 * Confidence in a face found as the head region of a whole-body primitive:
 * its outline comes from skinning and facing, not from the face's own mesh.
 */
const WHOLE_BODY_FACE_CONFIDENCE = 0.6;
/** A primitive weighted ≥80% to one eye bone holds only that eye. */
const SINGLE_EYE_SHARE = 0.8;
/** VRoid bangs root on the head bone, so a spring share marks hair. */
const HAIR_MIN_SPRING_SHARE = 0.1;
/** A highlight is under half its iris's area; a white is larger than it. */
const HIGHLIGHT_MAX_AREA_RATIO = 0.5;
/** Eye lines and lashes move almost entirely when the avatar blinks. */
const BLINK_MOVED_MIN_SHARE = 0.8;
/** …and about as far as the eyelid skin does. */
const BLINK_DISPLACEMENT_MIN_RATIO = 0.5;
/**
 * Lashes along a lid's outer and lower edges follow it only part of the way
 * (about 13% for a lower lash and 45% for an eyeliner wing tip on a converted
 * VRChat Avatar), so an island inside the box its lid sweeps qualifies when
 * blink moves it this share as far as the lid.
 */
const LID_EDGE_DETAIL_MIN_RATIO = 0.1;
/** …and are small compared with the face skin. */
const EYE_DETAIL_MAX_AREA_RATIO = 0.25;
/**
 * The eye window spans the eyes plus this many eye-bone distances: wide enough
 * that face skin (which surrounds the eyes) outweighs the eye whites filling
 * its eye holes.
 */
const EYE_WINDOW_HALF_WIDTH = 3;
const EYE_WINDOW_HALF_HEIGHT = 2.5;
const MOVED_EPSILON = 1e-4;
/**
 * How far past the eyelids an eye layer found without eye bones, or a lash
 * that follows its lid part of the way, may reach, as a share of their size.
 */
const EYE_REGION_MARGIN = 0.25;
/**
 * How deep behind its lid's front an eye layer found without eye bones may
 * lie, as a share of the two lids' width. Eye meshes sit just behind the
 * lids; a part hidden inside the head (an inner mouth, a spare pupil) or
 * beside it (ears) can reach into the lids' outline from far deeper.
 */
const EYE_LAYER_MAX_DEPTH = 0.15;
/**
 * An eye's blink region holds the vertices blink moves at least this share as
 * far as the farthest one on its side: the upper lid and lash line, without
 * the skin around them that moves a little with it.
 */
const BLINK_REGION_MIN_SHARE = 0.5;
/**
 * A lid's edge (its lash line) is the part blink moves at least this share as
 * far as the farthest vertex on that side; the lid skin above it moves less.
 */
const LASH_LINE_MIN_SHARE = 0.9;
/** An estimated eye's confidence, by what its position comes from. */
const EYE_ESTIMATE_CONFIDENCE: Record<AvatarEyeEstimate, number> = {
  blink: 0.5,
  eye_bone: 0.4,
};
/**
 * An eye placed from its blink region is sized like an iris: on the Included
 * Avatars the iris spans about these shares of the region's width and height
 * (the region also holds the lid skin above the lash line).
 */
const BLINK_IRIS_WIDTH_SHARE = 0.55;
const BLINK_IRIS_HEIGHT_SHARE = 0.67;
/**
 * An eye placed from its bone: iris width and height as a share of the face's
 * width (the Included Avatars and the VRM 0 fixture measure 0.12-0.16).
 */
const BONE_IRIS_FACE_WIDTH_SHARE = 0.14;
/**
 * An estimated eye is at least this share of the distance between the eyes
 * wide and high: the Included Avatars' irises measure 0.33-0.43 of it, and a
 * blink region can be much smaller than the painted or modelled eye (a lid
 * line, the lower half of an eye dot), which sized overlays and decals too
 * small to see.
 */
const ESTIMATED_EYE_MIN_SPACING_SHARE = 0.3;
/**
 * An eye bone marks an eye only this share of the face's width or more to its
 * own side of the centre line (the Included eyes sit about 0.19 out), above
 * the face's lowest {@link EYE_BONE_MIN_HEIGHT_SHARE} and inside its front view.
 */
const EYE_BONE_MIN_SIDE_SHARE = 0.1;
const EYE_BONE_MIN_HEIGHT_SHARE = 0.25;
/**
 * An eye placed from its bone lands on face triangles whose centre lies in
 * this front share of the face's depth, so the back of the head cannot.
 */
const FACE_FRONT_DEPTH_SHARE = 0.5;

const LOOK_AT_EXPRESSIONS = ["lookLeft", "lookRight", "lookUp", "lookDown"];
/**
 * Names that mean hair: English, and the Japanese, Chinese and Korean names
 * MikuMikuDance and other models give hair materials (髪, 髮, 头发, 刘海,
 * アホ毛, 앞머리 …). 发 alone counts at the start of a name or after a
 * position, length or colour (前发, 长发, 白发), but not in words such as 发光
 * (glow), 发条 (wind-up), 发射 (launch) or 出发 (depart).
 */
const HAIR_NAME_PATTERN =
  /hair|bangs?|fringe|ponytail|twin_?tails?|pigtail|ahoge|髪|髮|头发|頭髪|刘海|瀏海|劉海|呆毛|アホ毛|ツインテ|ポニーテ|머리카락|앞머리|뒷머리|옆머리|(?:^|[前后後侧側鬓鬢长長短卷捲白黑金银銀])发(?![光条射出送生现現动動表布])/i;

/** Names that contain a hair word but are not hair: ornaments, and English words like "chair". */
const NOT_HAIR_NAME_PATTERN = /chair|bangle|飾|饰|ornament|accessor/i;

/** Whether a material, object or node name means hair. */
export function isHairName(name: string): boolean {
  const trimmed = name.trim();
  return (
    HAIR_NAME_PATTERN.test(trimmed) && !NOT_HAIR_NAME_PATTERN.test(trimmed)
  );
}

type EyeSide = "left" | "right" | "both";

type SkinShares = Record<BoneClass, number>;

type Candidate = {
  entry: RuntimePrimitiveBindingEntry;
  shares: SkinShares;
};

type Geometry2D = {
  /** Triangle area projected on the head's front plane, in m². */
  area: number;
  /** Area of triangles whose centroid lies inside the eye window. */
  eyeWindowArea: number;
  /** Both, with each triangle scaled by its corners' mean vertex weight. */
  weightedArea: number;
  weightedEyeWindowArea: number;
  /** Mean vertex coordinate along the face's front axis. */
  front: number;
  center: THREE.Vector3;
  minX: number;
  maxX: number;
};

type EyeWindow = { minX: number; maxX: number; minY: number; maxY: number };

type Context = {
  vrm: VRM;
  gltf: GLTF;
  entries: RuntimePrimitiveBindingEntry[];
  anchor: THREE.Object3D;
  frontSign: 1 | -1;
  diagnostics: string[];
  issues: AvatarIssue[];
  /** Vertex positions in anchor space, per mesh, read once. */
  points: Map<THREE.Mesh, THREE.Vector3[]>;
};

/** Record a finding as dev-panel text and as a stable code. */
function report(context: Context, issue: AvatarIssue, message: string): void {
  context.diagnostics.push(message);
  addAvatarIssue(context.issues, issue);
}

/**
 * Identify face skin, irises (per side), eye highlights, eye lines, eyelashes
 * and hair on a loaded VRM. Every role is reported, with `missing` when nothing
 * qualified. With `names: false`, only spec signals and corrections are used
 * before estimates. An eye still missing after corrections, on a face whose
 * skin is known, is `estimated` from where blink moves the face or from its
 * eye bone ({@link estimateMissingEyes}), with its place in `eyeEstimates`.
 */
export function detectAvatarFaceParts(
  vrm: VRM,
  gltf: GLTF,
  options: DetectAvatarFacePartsOptions = {},
): AvatarFacePartMap {
  const useNames = options.names ?? true;
  const entries = buildRuntimePrimitiveBindings({
    scene: vrm.scene,
    sourceGltf: gltf,
  }).entries;
  const anchor = vrm.humanoid?.getNormalizedBoneNode("head") ?? vrm.scene;
  const context: Context = {
    vrm,
    gltf,
    entries,
    anchor,
    frontSign: vrm.meta?.metaVersion === "0" ? -1 : 1,
    diagnostics: [],
    issues: [],
    points: new Map(),
  };

  const signals = detectFromSignals(context);
  const names = useNames ? detectFromNames(context, options) : null;

  const parts = {} as Record<AvatarFacePartRole, AvatarFacePart>;
  for (const role of AVATAR_FACE_PART_ROLES) {
    const fromSignals = signals.parts[role];
    if (
      fromSignals &&
      (fromSignals.bindings.length > 0 ||
        (fromSignals.regions?.length ?? 0) > 0)
    ) {
      parts[role] = { role, source: "signals", ...fromSignals };
      continue;
    }
    const fromNames = names?.[role] ?? [];
    parts[role] =
      fromNames.length > 0
        ? { role, bindings: fromNames, source: "names", confidence: 0.5 }
        : { role, bindings: [], source: "missing", confidence: 0 };
  }

  applyCorrections(context, parts, options);
  keepFaceSkinToHead(context, parts);
  const eyeEstimates = estimateMissingEyes(context, parts);
  return {
    parts,
    eyeWhite: signals.eyeWhite,
    diagnostics: context.diagnostics,
    issues: context.issues,
    // Only an Avatar with an estimated eye carries the field.
    ...(Object.keys(eyeEstimates).length > 0 ? { eyeEstimates } : {}),
  };
}

/** True when the user changed this part's bindings from what was detected. */
export function isFacePartEdited(part: AvatarFacePart): boolean {
  if (part.source !== "corrected") return false;
  const detected = new Set(part.detected?.bindings ?? []);
  return (
    part.bindings.length !== detected.size ||
    part.bindings.some((key) => !detected.has(key))
  );
}

/** VFX target roles in the name matcher's precedence: detail, iris, skin. */
const TARGET_ROLE_PARTS: ReadonlyArray<
  [AvatarVFXTargetRole, readonly AvatarFacePartRole[]]
> = [
  ["eye_highlight", ["eye_highlight"]],
  ["eyeline", ["eyeline"]],
  ["eyelash", ["eyelash"]],
  ["eye_iris", ["eye_left", "eye_right"]],
  ["face_skin", ["face_skin"]],
];

/**
 * Every VFX target role a binding serves. One mesh can hold several parts,
 * such as eyelashes drawn in the eye-line mesh, and an effect on any of them
 * uses it. A part the user corrected comes first, so it is the primary role;
 * the rest follow the name matcher's precedence. Hair is not a VFX target.
 */
export function resolveFacePartTargetRoles(
  map: AvatarFacePartMap | null,
  bindingKey: string,
): AvatarVFXTargetRole[] {
  if (!map) return [];
  const held = TARGET_ROLE_PARTS.filter(([, roles]) =>
    roles.some((role) => map.parts[role].bindings.includes(bindingKey)),
  );
  const edited = held.filter(([, roles]) =>
    roles.some((role) => isFacePartEdited(map.parts[role])),
  );
  return [...edited, ...held.filter((entry) => !edited.includes(entry))].map(
    ([target]) => target,
  );
}

/** The primary VFX target role for a binding ({@link resolveFacePartTargetRoles}). */
export function resolveFacePartTargetRole(
  map: AvatarFacePartMap | null,
  bindingKey: string,
): AvatarVFXTargetRole | null {
  return resolveFacePartTargetRoles(map, bindingKey)[0] ?? null;
}

/** Live entries for a part, in binding order. */
export function selectFacePartEntries(
  map: Pick<AvatarFacePartMap, "parts"> | null,
  roles: readonly AvatarFacePartRole[],
  entries: readonly RuntimePrimitiveBindingEntry[],
): RuntimePrimitiveBindingEntry[] {
  if (!map) return [];
  const keys = new Set(roles.flatMap((role) => map.parts[role].bindings));
  return entries.filter((entry) => keys.has(entry.bindingKey));
}

/**
 * The first face part an effect needs that the map lacks, or null. Face
 * landmarks need face skin, so every hover and decal needs it; an eye hover
 * also needs the eye(s) it covers, which an estimated position serves; an
 * iris texture needs either iris as a mesh part to paint.
 */
export function findMissingFacePart(
  map: AvatarFacePartMap,
  effect: AvatarVFXParsedEntry,
): AvatarFacePartRole | null {
  const missing = (role: AvatarFacePartRole) =>
    map.parts[role].bindings.length === 0;
  // Body, sticker and silhouette attachments need no face part.
  if (isAttachmentVFXEntry(effect)) return null;
  if (isTextureVFXEntry(effect)) {
    if (effect.targetRole === "eye_iris") {
      return missing("eye_left") && missing("eye_right") ? "eye_left" : null;
    }
    return missing(effect.targetRole) ? effect.targetRole : null;
  }
  if (missing("face_skin")) return "face_skin";
  if (isEyeHoverVFXEntry(effect)) {
    const sides: AvatarFacePartRole[] =
      effect.side && !effect.requiresMirror
        ? [effect.side === "left" ? "eye_left" : "eye_right"]
        : ["eye_left", "eye_right"];
    return (
      sides.find(
        (role) => missing(role) && map.parts[role].source !== "estimated",
      ) ?? null
    );
  }
  return null;
}

/**
 * Whether either eye's position is only estimated (no eye mesh part), so eye
 * planes attach to the face skin binding instead of an iris.
 */
export function hasEstimatedEyes(map: AvatarFacePartMap | null): boolean {
  return (
    map !== null &&
    (["eye_left", "eye_right"] as const).some(
      (role) => map.parts[role].source === "estimated",
    )
  );
}

/** The live entries landmarks, anchors and hover clearance read. */
export type AvatarFacePartEntries = {
  /** The first face skin entry. */
  face: RuntimePrimitiveBindingEntry | null;
  /** Every face skin entry (a correction can list several). */
  faces: RuntimePrimitiveBindingEntry[];
  leftEyes: RuntimePrimitiveBindingEntry[];
  rightEyes: RuntimePrimitiveBindingEntry[];
  hair: RuntimePrimitiveBindingEntry[];
};

/**
 * Resolve the Avatar's part map against live entries. An Avatar without a map
 * (a test double, or a load that predates detection) uses name matching.
 */
export function resolveAvatarFacePartEntries(
  avatar: Pick<
    Avatar,
    "facePartMap" | "sourceGltf" | "sourceKey" | "sourceUrl"
  >,
  entries: RuntimePrimitiveBindingEntry[],
): AvatarFacePartEntries {
  const map = avatar.facePartMap;
  if (map) {
    const faces = selectFacePartEntries(map, ["face_skin"], entries);
    return {
      face: faces[0] ?? null,
      faces,
      leftEyes: selectFacePartEntries(map, ["eye_left"], entries),
      rightEyes: selectFacePartEntries(map, ["eye_right"], entries),
      hair: selectFacePartEntries(map, ["hair"], entries),
    };
  }
  const source = { sourceKey: avatar.sourceKey, sourceUrl: avatar.sourceUrl };
  const irises = resolveEyeIrisTargetBindings({ ...source, entries });
  const face = resolveFaceTargetBinding({ ...source, entries });
  return {
    face,
    faces: face ? [face] : [],
    leftEyes: irises,
    rightEyes: irises,
    hair: avatar.sourceGltf
      ? resolveNamedHairBindings(avatar.sourceGltf, entries)
      : [],
  };
}

/**
 * For a face primitive that also holds neck or body vertices (under 90% of its
 * skin weight on the head), a test keeping its head-weighted vertices, so face
 * bounds come from the face. A whole-body primitive whose face is its head
 * `region` (see {@link findFaceSkinRegion}) keeps that region's vertices.
 * Null for a head-skinned primitive, whose bounds use every vertex.
 */
export function createFaceVertexFilter(
  vrm: VRM,
  mesh: THREE.Mesh,
  region: AvatarFacePartRegion | null = null,
): ((vertex: number) => boolean) | null {
  if (region) {
    const index = mesh.geometry.getIndex();
    const vertices = new Set<number>();
    for (const triangle of region.triangles) {
      for (let corner = 0; corner < 3; corner += 1) {
        const at = triangle * 3 + corner;
        vertices.add(index ? index.getX(at) : at);
      }
    }
    return (vertex) => vertices.has(vertex);
  }
  const classify = createBoneClassifier(vrm);
  if (measureSkinShares(mesh, classify).head >= HEAD_SKINNED_MIN_SHARE) {
    return null;
  }
  const head = measureVertexClassShares(mesh, classify, "head");
  return (vertex) => (head[vertex] ?? 0) >= MAJORITY_SHARE;
}

/**
 * The face skin's region in one of its primitives: set when that primitive
 * also holds the body (one mesh for the whole Avatar), whose face is then only
 * its head region. Null for a primitive that is face skin throughout.
 */
export function findFaceSkinRegion(
  map: Pick<AvatarFacePartMap, "parts"> | null,
  bindingKey: string,
): AvatarFacePartRegion | null {
  return (
    map?.parts.face_skin.regions?.find(
      (region) => region.bindingKey === bindingKey,
    ) ?? null
  );
}

/** Whether eye lines or lashes were found as geometry (primitives or regions). */
export function hasEyeDetailGeometry(map: AvatarFacePartMap): boolean {
  return (["eyeline", "eyelash"] as const).some(
    (role) =>
      map.parts[role].bindings.length > 0 ||
      (map.parts[role].regions?.length ?? 0) > 0,
  );
}

/**
 * Each eyelid on a face primitive: the bounds, in `anchor` space, of the
 * vertices blink moves, open and closed, split by the head's left-right axis.
 * A face whose lashes are painted into its texture draws them there.
 */
export function measureEyelidBounds(
  vrm: VRM,
  mesh: THREE.Mesh,
  anchor: THREE.Object3D,
): { left: THREE.Box3 | null; right: THREE.Box3 | null } {
  const lids = measureLidBoxes(
    {
      anchor,
      points: new Map(),
      frontSign: vrm.meta?.metaVersion === "0" ? -1 : 1,
    },
    mesh,
    collectMorphBinds(vrm, "blink"),
  );
  return {
    left: lids.left.isEmpty() ? null : lids.left,
    right: lids.right.isEmpty() ? null : lids.right,
  };
}

/** An eye's closed cover: see {@link measureClosedEyeCovers}. */
export type ClosedEyeCover = {
  /** In anchor space: the eye's parts, open and closed. */
  bounds: THREE.Box3;
  /**
   * The frontmost anchor-space depth (z) of those parts and of the face
   * skin's lids there, open or closed.
   */
  front: number;
  /**
   * The frontmost depth of the iris and of the face skin blink moves on this
   * side, open or closed: without the lashes, which stand further out and
   * which eye art hides.
   */
  skinFront: number;
};

/**
 * Each eye's closed cover: the box, in `anchor` space, that the eye's iris
 * and the eye lines and lashes on its side span, at rest and with `blink`
 * closing them, and the frontmost depth of those and of the face skin's lids. A converted MikuMikuDance model
 * often closes an eye with its lash mesh rather than the face skin, so eye
 * art that hides the lashes needs a skin patch this size in front of it.
 * Whole primitives and part regions count; sides follow the head's
 * left-right axis. Null for a side with none of those parts.
 */
export function measureClosedEyeCovers(
  vrm: VRM,
  map: AvatarFacePartMap,
  entries: readonly RuntimePrimitiveBindingEntry[],
  anchor: THREE.Object3D,
): { left: ClosedEyeCover | null; right: ClosedEyeCover | null } {
  const context = {
    anchor,
    points: new Map<THREE.Mesh, THREE.Vector3[]>(),
    frontSign: (vrm.meta?.metaVersion === "0" ? -1 : 1) as 1 | -1,
  };
  const byKey = new Map(entries.map((entry) => [entry.bindingKey, entry]));
  // Each primitive's vertices that count: all of a part primitive's, or a
  // region's triangles' corners; and which primitives hold an iris.
  const vertices = new Map<RuntimePrimitiveBindingEntry, Set<number> | null>();
  const irises = new Set<RuntimePrimitiveBindingEntry>();
  for (const role of ["eye_left", "eye_right", "eyeline", "eyelash"] as const) {
    const part = map.parts[role];
    if (role === "eye_left" || role === "eye_right") {
      for (const key of part.bindings) {
        const entry = byKey.get(key);
        if (entry) irises.add(entry);
      }
    }
    const regionKeys = new Set(
      (part.regions ?? []).map((region) => region.bindingKey),
    );
    for (const key of part.bindings) {
      const entry = byKey.get(key);
      if (entry && !regionKeys.has(key)) vertices.set(entry, null);
    }
    for (const region of part.regions ?? []) {
      const entry = byKey.get(region.bindingKey);
      const index = entry?.object.geometry.getIndex();
      if (!entry || !index || vertices.get(entry) === null) continue;
      const set = vertices.get(entry) ?? new Set<number>();
      for (const triangle of region.triangles)
        for (let corner = 0; corner < 3; corner += 1)
          set.add(index.getX(triangle * 3 + corner));
      vertices.set(entry, set);
    }
  }
  const blink = collectMorphBinds(vrm, "blink");
  const covers: Record<"left" | "right", ClosedEyeCover | null> = {
    left: null,
    right: null,
  };
  const ahead = (z: number, of: number) => (z - of) * context.frontSign > 0;
  const skinFronts: Record<"left" | "right", number | null> = {
    left: null,
    right: null,
  };
  const addSkin = (side: "left" | "right", point: THREE.Vector3) => {
    const front = skinFronts[side];
    if (front === null || ahead(point.z, front)) skinFronts[side] = point.z;
  };
  const add = (side: "left" | "right", point: THREE.Vector3) => {
    const cover = (covers[side] ??= {
      bounds: new THREE.Box3(),
      front: point.z,
      skinFront: point.z,
    });
    cover.bounds.expandByPoint(point);
    if (ahead(point.z, cover.front)) cover.front = point.z;
  };
  for (const [entry, only] of vertices) {
    const mesh = entry.object;
    const points = anchorSpacePoints(context, mesh);
    const closed = new Map<number, THREE.Vector3>();
    forEachMorphDelta(
      context,
      mesh,
      (blink.get(mesh) ?? []).map((index) => ({ index, weight: 1 })),
      (vertex, point, delta) => closed.set(vertex, point.clone().add(delta)),
    );
    const iris = irises.has(entry);
    const visit = (vertex: number) => {
      const point = points[vertex];
      if (!point) return;
      // The side comes from the rest position, which a closed lid shares.
      const side = point.x * context.frontSign >= 0 ? "left" : "right";
      const shut = closed.get(vertex);
      for (const at of shut ? [point, shut] : [point]) {
        add(side, at);
        if (iris) addSkin(side, at);
      }
    };
    if (only) only.forEach(visit);
    else points.forEach((_, vertex) => visit(vertex));
  }
  // The face skin's lids, open and closed: on each side, the vertices blink
  // moves at least BLINK_REGION_MIN_SHARE as far as the farthest there, not
  // the cheeks and brows it drags a little.
  for (const key of map.parts.face_skin.bindings) {
    const mesh = byKey.get(key)?.object;
    if (!mesh) continue;
    const moved: {
      side: "left" | "right";
      point: THREE.Vector3;
      shut: THREE.Vector3;
      distance: number;
    }[] = [];
    const farthest = { left: 0, right: 0 };
    forEachMorphDelta(
      context,
      mesh,
      (blink.get(mesh) ?? []).map((index) => ({ index, weight: 1 })),
      (_vertex, point, delta) => {
        const side = point.x * context.frontSign >= 0 ? "left" : "right";
        const distance = delta.length();
        farthest[side] = Math.max(farthest[side], distance);
        moved.push({ side, point, shut: point.clone().add(delta), distance });
      },
    );
    for (const { side, point, shut, distance } of moved) {
      if (distance < farthest[side] * BLINK_REGION_MIN_SHARE) continue;
      addSkin(side, point);
      addSkin(side, shut);
    }
  }
  for (const side of ["left", "right"] as const) {
    const cover = covers[side];
    const skin = skinFronts[side];
    if (!cover) continue;
    // Without iris or lids there, the skin is taken to be at the cover's
    // front; lids in front of the lashes move the cover's front forward.
    cover.skinFront = skin ?? cover.front;
    if (ahead(cover.skinFront, cover.front)) cover.front = cover.skinFront;
  }
  return covers;
}

/**
 * Each side's eyelid box on a face primitive: the vertices blink moves, open
 * and closed, so the box spans the opening a lid closes over even when only
 * the upper lid moves. Sides follow the head's left-right axis.
 */
function measureLidBoxes(
  context: Pick<Context, "anchor" | "points" | "frontSign">,
  mesh: THREE.Mesh,
  blink: Map<THREE.Object3D, number[]>,
): { left: THREE.Box3; right: THREE.Box3 } {
  const lids = { left: new THREE.Box3(), right: new THREE.Box3() };
  const binds = (blink.get(mesh) ?? []).map((index) => ({ index, weight: 1 }));
  forEachMorphDelta(context, mesh, binds, (_vertex, point, delta) => {
    const lid = lids[point.x * context.frontSign >= 0 ? "left" : "right"];
    lid.expandByPoint(point);
    lid.expandByPoint(delta.clone().add(point));
  });
  return lids;
}

/** One morph target an expression drives, at the weight it drives it. */
type WeightedMorphBind = { index: number; weight: number };

/**
 * Call `visit` for each vertex of `mesh` that `binds` move: its rest position
 * and its delta at the binds' weights, both in anchor space (`delta` is
 * reused between calls).
 */
function forEachMorphDelta(
  context: Pick<Context, "anchor" | "points">,
  mesh: THREE.Mesh,
  binds: readonly WeightedMorphBind[],
  visit: (vertex: number, point: THREE.Vector3, delta: THREE.Vector3) => void,
): void {
  const targets = mesh.geometry.morphAttributes.position ?? [];
  if (binds.length === 0) return;
  const points = anchorSpacePoints(context, mesh);
  // Morph deltas are mesh-local directions; turn them into anchor space.
  context.anchor.updateWorldMatrix(true, false);
  const toAnchor = new THREE.Matrix3().setFromMatrix4(
    context.anchor.matrixWorld
      .clone()
      .invert()
      .multiply(composeWorldMatrix(mesh)),
  );
  const delta = new THREE.Vector3();
  const step = new THREE.Vector3();
  points.forEach((point, vertex) => {
    delta.set(0, 0, 0);
    for (const { index, weight } of binds) {
      const target = targets[index];
      if (!target || vertex >= target.count) continue;
      delta.addScaledVector(
        step.set(target.getX(vertex), target.getY(vertex), target.getZ(vertex)),
        weight,
      );
    }
    if (delta.length() <= MOVED_EPSILON) return;
    visit(vertex, point, delta.applyMatrix3(toAnchor));
  });
}

/**
 * The morph targets an expression plays on one primitive, at their bind
 * weights; a bind of weight 0 or less plays nothing and is left out.
 */
function collectPlayingMorphBinds(
  vrm: VRM,
  expressionName: string,
  primitive: THREE.Object3D,
): WeightedMorphBind[] {
  const expression = vrm.expressionManager?.getExpression(expressionName);
  const binds: WeightedMorphBind[] = [];
  for (const bind of expression?.binds ?? []) {
    const morph = bind as {
      primitives?: unknown;
      index?: unknown;
      weight?: unknown;
    };
    const weight = typeof morph.weight === "number" ? morph.weight : 1;
    if (
      Array.isArray(morph.primitives) &&
      morph.primitives.includes(primitive) &&
      typeof morph.index === "number" &&
      weight > 0
    ) {
      binds.push({ index: morph.index, weight });
    }
  }
  return binds;
}

/** Where blink moves one side of a face primitive; see {@link measureBlinkRegions}. */
type BlinkEyeRegion = {
  /** Vertices of the eye's piece of the blink core. */
  vertices: number[];
  /** Their rest positions in anchor space, in `vertices` order. */
  points: THREE.Vector3[];
  /** The box around their open and closed positions. */
  bounds: THREE.Box3;
  /**
   * Halfway between each vertex's open and closed positions, averaged by how
   * far it moves: the middle of the eye opening the lid closes over.
   */
  center: THREE.Vector3;
  /**
   * The highest rest height (anchor-space y) of the vertices blink moves at
   * least {@link LASH_LINE_MIN_SHARE} as far as the farthest: the top of the
   * open lid's edge, below the lid skin and brows above it.
   */
  lashLineTop: number;
};

/**
 * Each eye's blink region on a face primitive whose eyes have no geometry of
 * their own: the vertices `blink` moves at least {@link BLINK_REGION_MIN_SHARE}
 * as far as the farthest on that side (the lid and lash line), split by the
 * head's left-right axis, in anchor space, keeping the eye's piece
 * ({@link keepMainBlinkPiece}). Null for a side blink leaves still.
 */
function measureBlinkRegions(
  context: Pick<Context, "anchor" | "points" | "frontSign">,
  mesh: THREE.Mesh,
  binds: readonly WeightedMorphBind[],
): { left: BlinkEyeRegion | null; right: BlinkEyeRegion | null } {
  type Moved = { vertex: number; point: THREE.Vector3; delta: THREE.Vector3 };
  const moved: Record<"left" | "right", Moved[]> = { left: [], right: [] };
  forEachMorphDelta(context, mesh, binds, (vertex, point, delta) => {
    moved[point.x * context.frontSign >= 0 ? "left" : "right"].push({
      vertex,
      point,
      delta: delta.clone(),
    });
  });
  const regionOf = (side: Moved[]): BlinkEyeRegion | null => {
    // A loop, not a spread: a merged body mesh can move many vertices.
    let farthest = 0;
    for (const { delta } of side) farthest = Math.max(farthest, delta.length());
    const core = side.filter(
      ({ delta }) => delta.length() >= farthest * BLINK_REGION_MIN_SHARE,
    );
    if (farthest <= MOVED_EPSILON || core.length === 0) return null;
    const kept = keepMainBlinkPiece(mesh, core);
    const bounds = new THREE.Box3();
    const center = new THREE.Vector3();
    let weight = 0;
    let lashLineTop = -Infinity;
    for (const { point, delta } of kept) {
      bounds.expandByPoint(point);
      bounds.expandByPoint(point.clone().add(delta));
      const distance = delta.length();
      center.addScaledVector(
        point.clone().addScaledVector(delta, 0.5),
        distance,
      );
      weight += distance;
      if (distance >= farthest * LASH_LINE_MIN_SHARE) {
        lashLineTop = Math.max(lashLineTop, point.y);
      }
    }
    return {
      vertices: kept.map(({ vertex }) => vertex),
      points: kept.map(({ point }) => point),
      bounds,
      center: center.multiplyScalar(1 / weight),
      lashLineTop,
    };
  };
  return { left: regionOf(moved.left), right: regionOf(moved.right) };
}

/**
 * The piece of one side's blink core that holds the eye: the connected piece
 * (triangles joining core vertices, welded by position) with the most
 * vertices, and every piece whose front-view extent, open or closed, overlaps
 * it. A brow or a closed-eye line that blink also moves, apart from the lid,
 * is left out. Only core vertices are welded: a seam's duplicates move alike,
 * so they are in the core too.
 */
function keepMainBlinkPiece<
  T extends { vertex: number; point: THREE.Vector3; delta: THREE.Vector3 },
>(mesh: THREE.Mesh, core: readonly T[]): T[] {
  const geometry = mesh.geometry;
  const position = geometry.getAttribute("position");
  const index = geometry.getIndex();
  const weld = createPositionWeld(position);
  const inCore = new Set(core.map(({ vertex }) => vertex));
  const pieces = new UnionFind();
  const count = index ? index.count : position.count;
  const corner = (at: number) => (index ? index.getX(at) : at);
  for (let at = 0; at + 2 < count; at += 3) {
    const corners = [corner(at), corner(at + 1), corner(at + 2)]
      .filter((vertex) => inCore.has(vertex))
      .map(weld);
    for (let other = 1; other < corners.length; other += 1) {
      pieces.union(corners[0]!, corners[other]!);
    }
  }
  const byPiece = new Map<number, { members: T[]; extent: THREE.Box2 }>();
  for (const member of core) {
    const root = pieces.find(weld(member.vertex));
    let piece = byPiece.get(root);
    if (!piece) {
      piece = { members: [], extent: new THREE.Box2() };
      byPiece.set(root, piece);
    }
    piece.members.push(member);
    const { point, delta } = member;
    piece.extent.expandByPoint(new THREE.Vector2(point.x, point.y));
    piece.extent.expandByPoint(
      new THREE.Vector2(point.x + delta.x, point.y + delta.y),
    );
  }
  const all = [...byPiece.values()];
  const main = all.reduce((best, piece) =>
    piece.members.length > best.members.length ? piece : best,
  );
  return all
    .filter(
      (piece) => piece === main || piece.extent.intersectsBox(main.extent),
    )
    .flatMap((piece) => piece.members);
}

/**
 * Give each eye detection left missing an estimated place, when the face skin
 * is known: where blink moves the face skin on that side, else the humanoid
 * eye bone when it plausibly sits behind an eye, moved onto the front of the
 * face. Runs after corrections, so an eye a correction marks absent stays
 * absent. The face is the first face skin entry, as the landmarks take it.
 */
function estimateMissingEyes(
  context: Context,
  parts: Record<AvatarFacePartRole, AvatarFacePart>,
): Partial<Record<"left" | "right", AvatarEyeEstimateGeometry>> {
  const estimates: Partial<
    Record<"left" | "right", AvatarEyeEstimateGeometry>
  > = {};
  const sides = (["left", "right"] as const).filter(
    (side) => parts[`eye_${side}`].source === "missing",
  );
  const face = selectFacePartEntries(
    { parts },
    ["face_skin"],
    context.entries,
  )[0];
  if (sides.length === 0 || !face) return estimates;
  const regions = measureBlinkRegions(
    context,
    face.object,
    collectPlayingMorphBinds(context.vrm, "blink", face.object),
  );
  let surface: FaceSurface | null | undefined;
  for (const side of sides) {
    const region = regions[side];
    let estimate: AvatarEyeEstimate = "blink";
    let geometry: AvatarEyeEstimateGeometry | null = null;
    if (region) {
      const size = region.bounds.getSize(new THREE.Vector3());
      geometry = {
        bindingKey: face.bindingKey,
        center: region.center,
        width: size.x * BLINK_IRIS_WIDTH_SHARE,
        height: size.y * BLINK_IRIS_HEIGHT_SHARE,
        region: { vertices: region.vertices, points: region.points },
        // The lids, open or closed (eye art closes them), as a first front.
        surfaceFront:
          context.frontSign > 0 ? region.bounds.max.z : region.bounds.min.z,
      };
    } else {
      estimate = "eye_bone";
      surface ??= measureFaceSurface(
        context,
        face,
        findFaceSkinRegion({ parts }, face.bindingKey),
      );
      geometry = surface && estimateEyeFromBone(context, side, face, surface);
    }
    if (!geometry) continue;
    const role = `eye_${side}` as const;
    parts[role] = {
      role,
      bindings: [],
      source: "estimated",
      estimate,
      confidence: EYE_ESTIMATE_CONFIDENCE[estimate],
    };
    estimates[side] = geometry;
  }
  const left = estimates.left;
  const right = estimates.right;
  if (left && right) {
    const least =
      Math.abs(left.center.x - right.center.x) *
      ESTIMATED_EYE_MIN_SPACING_SHARE;
    for (const eye of [left, right]) {
      eye.width = Math.max(eye.width, least);
      eye.height = Math.max(eye.height, least);
    }
  }
  const placed = [left, right].filter((eye) => eye !== undefined);
  if (placed.length > 0) {
    surface ??= measureFaceSurface(
      context,
      face,
      findFaceSkinRegion({ parts }, face.bindingKey),
    );
    if (surface) {
      for (const eye of placed) {
        eye.surfaceFront = measureSurfaceFront(context, surface, eye);
      }
    }
  }
  return estimates;
}

/**
 * The frontmost depth of the face surface over an estimated eye: projected
 * along the face's front axis ({@link projectOntoFaceFront}) at its centre
 * and at a 3 × 3 grid one eye width and height around it, which covers the
 * hover art drawn over the eye, and the front of a `blink` eye's lids, open
 * or closed (`surfaceFront` as estimated).
 */
function measureSurfaceFront(
  context: Pick<Context, "frontSign">,
  surface: FaceSurface,
  eye: AvatarEyeEstimateGeometry,
): number {
  let front =
    eye.surfaceFront === undefined
      ? -Infinity
      : eye.surfaceFront * context.frontSign;
  for (const dx of [-1, 0, 1]) {
    for (const dy of [-1, 0, 1]) {
      const point = new THREE.Vector3(
        eye.center.x + dx * eye.width,
        eye.center.y + dy * eye.height,
        eye.center.z,
      );
      const z = projectOntoFaceFront(context, surface, point).z;
      front = Math.max(front, z * context.frontSign);
    }
  }
  return front * context.frontSign;
}

/** A face skin primitive's triangles and head-weighted bounds, in anchor space. */
type FaceSurface = {
  mesh: THREE.Mesh;
  points: THREE.Vector3[];
  /** Three vertex indices per triangle of the primitive. */
  corners: number[];
  bounds: THREE.Box3;
  /** The bounds' depth at the front of the face. */
  front: number;
};

/**
 * A face skin primitive's surface. A face that is the head region of a
 * whole-body primitive (`region`) is only that region's triangles.
 */
function measureFaceSurface(
  context: Context,
  face: RuntimePrimitiveBindingEntry,
  region: AvatarFacePartRegion | null,
): FaceSurface | null {
  const mesh = face.object;
  const points = anchorSpacePoints(context, mesh);
  const all = readPrimitiveTriangles(context, face);
  const inRegion = region ? new Set(region.triangles) : null;
  const corners: number[] = [];
  all.triangles.forEach((triangle, at) => {
    if (inRegion && !inRegion.has(triangle)) return;
    corners.push(...all.corners.slice(at * 3, at * 3 + 3));
  });
  // Bounds from head-weighted vertices, as the landmarks' face bounds.
  const keep =
    createFaceVertexFilter(context.vrm, mesh, region) ?? (() => true);
  const bounds = new THREE.Box3();
  for (const vertex of corners) {
    if (keep(vertex) && points[vertex]) bounds.expandByPoint(points[vertex]);
  }
  if (bounds.isEmpty()) {
    for (const vertex of corners) {
      if (points[vertex]) bounds.expandByPoint(points[vertex]);
    }
  }
  if (bounds.isEmpty()) return null;
  return {
    mesh,
    points,
    corners,
    bounds,
    front: context.frontSign > 0 ? bounds.max.z : bounds.min.z,
  };
}

/**
 * An eye placed from its humanoid eye bone: the bone moved along the face's
 * front axis onto the front of the face ({@link projectOntoFaceFront}), with
 * an iris {@link BONE_IRIS_FACE_WIDTH_SHARE} of the face's width. Null when
 * the bone cannot sit behind this eye: on or near the centre line (or on the
 * other side), outside the face in the front view, or in its lowest quarter.
 */
function estimateEyeFromBone(
  context: Context,
  side: "left" | "right",
  face: RuntimePrimitiveBindingEntry,
  surface: FaceSurface,
): AvatarEyeEstimateGeometry | null {
  const node = context.vrm.humanoid?.getNormalizedBoneNode(
    side === "left" ? "leftEye" : "rightEye",
  );
  if (!node) return null;
  // Normalized nodes, as the landmarks read them (see resolveEyeWindow).
  context.anchor.updateWorldMatrix(true, false);
  const bone = context.anchor.worldToLocal(
    node.getWorldPosition(new THREE.Vector3()),
  );
  const { bounds } = surface;
  const width = bounds.max.x - bounds.min.x;
  const height = bounds.max.y - bounds.min.y;
  // The Avatar's left is +x in VRM 1 head space and -x in VRM 0's.
  const outward = bone.x * context.frontSign * (side === "left" ? 1 : -1);
  if (
    outward < width * EYE_BONE_MIN_SIDE_SHARE ||
    bone.x < bounds.min.x ||
    bone.x > bounds.max.x ||
    bone.y < bounds.min.y + height * EYE_BONE_MIN_HEIGHT_SHARE ||
    bone.y > bounds.max.y
  ) {
    return null;
  }
  const iris = width * BONE_IRIS_FACE_WIDTH_SHARE;
  return {
    bindingKey: face.bindingKey,
    center: projectOntoFaceFront(context, surface, bone),
    width: iris,
    height: iris,
  };
}

/**
 * Where a line along the face's front axis through `point` meets the front
 * of the face. Only triangles facing the front (by winding) whose centre lies
 * in the front {@link FACE_FRONT_DEPTH_SHARE} of the face count, so the back
 * of the head cannot; of those, the frontmost covering `point` in the front
 * view, else the nearest there (an eye hole's rim). A face wound the other
 * way is tried without the facing test; with no triangle at all, the bounds'
 * front.
 */
function projectOntoFaceFront(
  context: Pick<Context, "frontSign">,
  surface: FaceSurface,
  point: THREE.Vector3,
): THREE.Vector3 {
  const { points, corners, bounds } = surface;
  const sign = context.frontSign;
  const depth = bounds.max.z - bounds.min.z;
  // A mirroring transform flips the winding of front faces.
  const winding = composeWorldMatrix(surface.mesh).determinant() < 0 ? -1 : 1;
  const target = new THREE.Vector3(point.x, point.y, 0);
  const flat = new THREE.Triangle();
  const closest = new THREE.Vector3();
  const barycoord = new THREE.Vector3();
  const edge = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const search = (facing: boolean): number | null => {
    let front: number | null = null;
    let nearest = { distanceSq: Infinity, z: null as number | null };
    for (let at = 0; at + 2 < corners.length; at += 3) {
      const a = points[corners[at]!];
      const b = points[corners[at + 1]!];
      const c = points[corners[at + 2]!];
      if (!a || !b || !c) continue;
      const centreZ = (a.z + b.z + c.z) / 3;
      if ((surface.front - centreZ) * sign > depth * FACE_FRONT_DEPTH_SHARE) {
        continue;
      }
      if (facing) {
        normal.subVectors(b, a).cross(edge.subVectors(c, a));
        if (normal.z * sign * winding <= 0) continue;
      }
      flat.a.set(a.x, a.y, 0);
      flat.b.set(b.x, b.y, 0);
      flat.c.set(c.x, c.y, 0);
      flat.closestPointToPoint(target, closest);
      const distanceSq = closest.distanceToSquared(target);
      const covers = distanceSq <= 1e-12;
      if (!covers && distanceSq >= nearest.distanceSq) continue;
      // Null for a triangle seen edge-on from the front.
      if (!flat.getBarycoord(closest, barycoord)) continue;
      const z = a.z * barycoord.x + b.z * barycoord.y + c.z * barycoord.z;
      if (!covers) nearest = { distanceSq, z };
      else if (front === null || z * sign > front * sign) front = z;
    }
    return front ?? nearest.z;
  };
  const z = search(true) ?? search(false) ?? surface.front;
  return new THREE.Vector3(point.x, point.y, z);
}

// ─── Signals ────────────────────────────────────────────────────────────────

type SignalParts = Partial<
  Record<
    AvatarFacePartRole,
    {
      bindings: string[];
      confidence: number;
      regions?: AvatarFacePartRegion[];
    }
  >
>;

function detectFromSignals(context: Context): {
  parts: SignalParts;
  eyeWhite: string[];
} {
  const { vrm, entries } = context;
  const classify = createBoneClassifier(vrm);
  const candidates: Candidate[] = entries.map((entry) => ({
    entry,
    shares: measureSkinShares(entry.object, classify),
  }));
  const parts: SignalParts = {};
  const geometry = new Map<RuntimePrimitiveBindingEntry, Geometry2D>();
  const measure = (entry: RuntimePrimitiveBindingEntry, window?: EyeWindow) => {
    if (!window) {
      const cached = geometry.get(entry);
      if (cached) return cached;
    }
    const result = measurePrimitive(context, entry.object, window ?? null);
    if (!window) geometry.set(entry, result);
    return result;
  };

  // Eyes: irises named by look-at texture transforms, then eye-bone primitives.
  const lookAtIrises = findLookAtTextureEntries(context);
  const eyeBone = candidates.filter(
    (candidate) =>
      candidate.shares.eye_left + candidate.shares.eye_right >= MAJORITY_SHARE,
  );
  const shareOf = (entry: RuntimePrimitiveBindingEntry) =>
    candidates.find((candidate) => candidate.entry === entry)?.shares ?? null;
  // One primitive may hold both eyes (VRoid) or a single side. A look-at
  // texture iris without eye-bone weights holds both.
  const sideOf = (entry: RuntimePrimitiveBindingEntry): EyeSide => {
    const shares = shareOf(entry);
    const eyeTotal = shares ? shares.eye_left + shares.eye_right : 0;
    if (!shares || eyeTotal === 0) return "both";
    const leftShare = shares.eye_left / eyeTotal;
    if (leftShare >= SINGLE_EYE_SHARE) return "left";
    if (leftShare <= 1 - SINGLE_EYE_SHARE) return "right";
    return "both";
  };
  const eyeEntries = unique([
    ...lookAtIrises,
    ...eyeBone.map((candidate) => candidate.entry),
  ]);
  // With separate per-eye primitives, each eye has its own iris, white and
  // highlight, so each side is classified on its own.
  const perSide =
    eyeEntries.some((entry) => sideOf(entry) === "left") &&
    eyeEntries.some((entry) => sideOf(entry) === "right");
  const groups = perSide
    ? (["left", "right", "both"] as const).map((side) =>
        eyeEntries.filter((entry) => sideOf(entry) === side),
      )
    : [eyeEntries];
  const classified = groups
    .filter((group) => group.length > 0)
    .map((group) =>
      classifyEyePrimitives(
        group,
        lookAtIrises.filter((entry) => group.includes(entry)),
        measure,
      ),
    );
  let eyeParts = mergeEyeGroups(classified);
  const assignEyes = (
    found: EyeParts,
    sideOfIris: (entry: RuntimePrimitiveBindingEntry) => EyeSide,
    confidence: number,
  ) => {
    const left: string[] = [];
    const right: string[] = [];
    for (const iris of found.iris) {
      const side = sideOfIris(iris);
      if (side !== "right") left.push(iris.bindingKey);
      if (side !== "left") right.push(iris.bindingKey);
    }
    if (left.length) parts.eye_left = { bindings: unique(left), confidence };
    if (right.length) parts.eye_right = { bindings: unique(right), confidence };
    if (found.highlight.length) {
      parts.eye_highlight = {
        bindings: found.highlight.map((entry) => entry.bindingKey),
        confidence: 0.8,
      };
    }
  };
  assignEyes(
    eyeParts,
    sideOf,
    lookAtIrises.length > 0 ? 0.95 : eyeParts.confidence,
  );
  const eyeKeys = new Set(
    [...eyeBone.map((candidate) => candidate.entry), ...lookAtIrises].map(
      (entry) => entry.bindingKey,
    ),
  );

  // Face skin: head-skinned primitives of the mesh morphed by blink and aa
  // (or by blink alone, below).
  const blink = collectMorphBinds(vrm, "blink");
  const aa = collectMorphBinds(vrm, "aa");
  const reportExpressionsMissing = () =>
    report(
      context,
      { code: "face_parts_expressions_missing" },
      "The VRM's blink or aa expression moves no mesh (it is missing or only switches materials), and no MMD, ARKit or VRChat shapes stand in for it; face skin and eye details cannot be found from expressions.",
    );
  // A mouth the file swaps by materials (separate mouth meshes switched on
  // and off) or leaves unbound gives aa no mesh. The face is then found among
  // the primitives blink morphs alone, by the same rules; the warning stays
  // only when that finds no face skin.
  const blinkOnly = blink.size > 0 && aa.size === 0;
  if (blink.size === 0) reportExpressionsMissing();
  const faceMeshCandidates = candidates.filter(
    (candidate) =>
      blink.has(candidate.entry.object) &&
      (blinkOnly || aa.has(candidate.entry.object)) &&
      !eyeKeys.has(candidate.entry.bindingKey),
  );
  const window = resolveEyeWindow(context, eyeParts.iris, measure);
  const headSkinned = faceMeshCandidates
    .filter((candidate) => candidate.shares.head >= HEAD_SKINNED_MIN_SHARE)
    .map((candidate) => {
      const metrics = measure(candidate.entry, window ?? undefined);
      return {
        entry: candidate.entry,
        score: window ? metrics.eyeWindowArea : metrics.area,
      };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score);
  // A face skinned partly to the neck or jaw falls below the head-skinned
  // share. Ranked by the area its head-weighted vertices cover, it wins over
  // the head-skinned pick when it covers more, so a mouth or eye primitive
  // left head-skinned cannot take its place.
  // Only a primitive blink actually moves (its lids) qualifies, and none on
  // spring joints, so hair merged into the face mesh cannot.
  const partlyHead = faceMeshCandidates
    .filter(
      (candidate) =>
        !holdsBody(candidate.shares) &&
        candidate.shares.head < HEAD_SKINNED_MIN_SHARE &&
        candidate.shares.spring_head < HAIR_MIN_SPRING_SHARE &&
        measureMorphDisplacement(candidate.entry.object, blink).max > 0,
    )
    .map((candidate) => {
      const metrics = measurePrimitive(
        context,
        candidate.entry.object,
        window,
        measureVertexClassShares(candidate.entry.object, classify, "head"),
      );
      return {
        entry: candidate.entry,
        score: window ? metrics.weightedEyeWindowArea : metrics.weightedArea,
      };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score);
  const faceCandidates =
    partlyHead[0] && partlyHead[0].score > (headSkinned[0]?.score ?? 0)
      ? [...partlyHead, ...headSkinned].sort((a, b) => b.score - a.score)
      : headSkinned;
  let faceSkin = faceCandidates[0]?.entry ?? null;
  let headRegion: HeadRegion | null = null;
  if (faceSkin) {
    const runnerUp = faceCandidates[1]?.score ?? 0;
    const clear = faceCandidates[0].score >= runnerUp * 2;
    parts.face_skin = {
      bindings: [faceSkin.bindingKey],
      confidence: (window ? 0.9 : 0.7) * (clear ? 1 : 0.7),
    };
  } else {
    const wholeBody = detectWholeBodyFace(context, {
      candidates: faceMeshCandidates,
      classify,
      window,
      blink,
      aa,
    });
    if (wholeBody) {
      faceSkin = wholeBody.entry;
      headRegion = wholeBody.region;
      parts.face_skin = {
        bindings: [faceSkin.bindingKey],
        regions: [
          { bindingKey: faceSkin.bindingKey, triangles: headRegion.triangles },
        ],
        confidence: WHOLE_BODY_FACE_CONFIDENCE * (wholeBody.clear ? 1 : 0.7),
      };
    }
  }
  if (blinkOnly && !faceSkin) reportExpressionsMissing();

  // No eye bones or look-at textures: find the eyes where blink moves the
  // face, then their layers among the primitives over each one.
  let detailWindow = window;
  if (eyeEntries.length === 0 && faceSkin) {
    const found = detectEyesFromBlink(context, {
      faceSkin,
      candidates,
      blink,
      measure,
    });
    if (found) {
      eyeParts = found.eyeParts;
      assignEyes(found.eyeParts, found.sideOf, 0.6);
      for (const entry of [
        ...found.eyeParts.iris,
        ...found.eyeParts.white,
        ...found.eyeParts.highlight,
      ]) {
        eyeKeys.add(entry.bindingKey);
      }
      detailWindow = resolveEyeWindow(context, found.eyeParts.iris, measure);
    }
  }

  // Head meshes blink alone morphs, on a MikuMikuDance model converted by
  // Animama Avatar Converter (its marker). The converter keeps each material
  // in a mesh of its own, so aa, which moves only the mouth, never morphs its
  // lash mesh, and that mesh often also holds the brows or the eyes. Their
  // lash islands are found by the region search below, never the whole mesh,
  // so brows and eyes sharing it stay. Eye-bone meshes (searched as irises
  // and whites already), hair and meshes that hold the body never count.
  // Other Avatars keep the name fallback for such meshes.
  const blinkOnlyMeshes = !isAnimamaConversion(context.gltf.parser.json)
    ? []
    : candidates.filter(
        (candidate) =>
          blink.has(candidate.entry.object) &&
          !aa.has(candidate.entry.object) &&
          !faceMeshCandidates.includes(candidate) &&
          !eyeKeys.has(candidate.entry.bindingKey) &&
          candidate.entry !== faceSkin &&
          candidate.shares.spring_head < HAIR_MIN_SPRING_SHARE &&
          candidate.shares.head +
            candidate.shares.eye_left +
            candidate.shares.eye_right >=
            MAJORITY_SHARE &&
          candidate.shares.other <= BODY_SKIN_SHARE,
      );
  if (faceSkin) {
    const reference = measureMorphDisplacement(faceSkin.object, blink);
    // A whole-body primitive's face is its head region.
    const faceArea = headRegion?.area ?? measure(faceSkin).area;
    // Eye lines and lashes: small face-mesh primitives the blink moves
    // strongly.
    const details = faceMeshCandidates
      .filter((candidate) => candidate.entry !== faceSkin)
      .filter((candidate) => {
        const displacement = measureMorphDisplacement(
          candidate.entry.object,
          blink,
        );
        const metrics = measure(candidate.entry);
        return (
          reference.max > 0 &&
          displacement.movedShare >= BLINK_MOVED_MIN_SHARE &&
          displacement.max >= reference.max * BLINK_DISPLACEMENT_MIN_RATIO &&
          metrics.area <= faceArea * EYE_DETAIL_MAX_AREA_RATIO &&
          (!detailWindow || isInsideWindow(metrics.center, detailWindow))
        );
      })
      .map((candidate) => ({
        entry: candidate.entry,
        area: measure(candidate.entry).area,
      }))
      .sort((a, b) => b.area - a.area);
    // The lid line covers more area than the lash strands above it.
    if (details[0]) {
      parts.eyeline = {
        bindings: [details[0].entry.bindingKey],
        confidence: details.length > 1 ? 0.6 : 0.7,
      };
    }
    if (details.length > 1) {
      parts.eyelash = {
        bindings: details.slice(1).map((detail) => detail.entry.bindingKey),
        confidence: 0.6,
      };
    }

    // Lines and lashes kept inside the face or eye primitives, or inside a
    // head mesh blink alone morphs, as their own islands. An eye line found as
    // a primitive leaves every region a lash; otherwise each eye's largest
    // region that follows its lid all the way is its line.
    const regions = findEyeDetailRegions(context, {
      entries: unique([
        faceSkin,
        ...eyeParts.iris,
        ...eyeParts.white,
        ...blinkOnlyMeshes.map((candidate) => candidate.entry),
      ]),
      blink,
      referenceMax: reference.max,
      faceArea,
      window: detailWindow,
      lidSweeps: measureLidSweeps(context, faceSkin.object),
    });
    if (regions.length > 0) {
      const lines = parts.eyeline
        ? []
        : (["left", "right"] as const).flatMap((side) => {
            const largest = regions
              .filter((region) => region.side === side && !region.lidEdge)
              .sort((a, b) => b.area - a.area)[0];
            return largest ? [largest] : [];
          });
      const lashes = regions.filter((region) => !lines.includes(region));
      if (lines.length > 0) {
        parts.eyeline = {
          bindings: [],
          regions: groupRegionsByBinding(lines),
          confidence: 0.5,
        };
      }
      if (lashes.length > 0) {
        parts.eyelash = {
          bindings: parts.eyelash?.bindings ?? [],
          regions: groupRegionsByBinding(lashes),
          confidence: parts.eyelash?.confidence ?? 0.5,
        };
      }
    }
  }

  // Hair: head-subtree primitives with a real share on spring joints.
  const faceMeshObjects = new Set(
    faceMeshCandidates.map((candidate) => candidate.entry.object),
  );
  const hair = candidates.filter(
    (candidate) =>
      !faceMeshObjects.has(candidate.entry.object) &&
      !eyeKeys.has(candidate.entry.bindingKey) &&
      candidate.shares.head + candidate.shares.spring_head >=
        HEAD_SKINNED_MIN_SHARE &&
      candidate.shares.spring_head >= HAIR_MIN_SPRING_SHARE,
  );
  if (hair.length) {
    parts.hair = {
      bindings: hair.map((candidate) => candidate.entry.bindingKey),
      confidence: 0.8,
    };
  }

  return {
    parts,
    eyeWhite: eyeParts.white.map((entry) => entry.bindingKey),
  };
}

type EyeParts = {
  iris: RuntimePrimitiveBindingEntry[];
  white: RuntimePrimitiveBindingEntry[];
  highlight: RuntimePrimitiveBindingEntry[];
  confidence: number;
};

function mergeEyeGroups(groups: readonly EyeParts[]): EyeParts {
  return {
    iris: groups.flatMap((group) => group.iris),
    white: groups.flatMap((group) => group.white),
    highlight: groups.flatMap((group) => group.highlight),
    confidence: Math.min(1, ...groups.map((group) => group.confidence)),
  };
}

/**
 * Eyes on a model without eye-bone primitives or look-at textures: blink
 * moves each eyelid on the face skin, which marks each eye's region (sides by
 * the head's left-right axis). Primitives skinned to the head (eye bones
 * included: an eye mesh may skin only its irises to them) with vertices
 * behind a lid, near its front, hold that eye, behind both hold both; lines
 * and lashes (which blink moves) and spring hair are left out. Their iris,
 * white and highlight follow the eye-bone rules.
 */
function detectEyesFromBlink(
  context: Context,
  args: {
    faceSkin: RuntimePrimitiveBindingEntry;
    candidates: readonly Candidate[];
    blink: Map<THREE.Object3D, number[]>;
    measure: (entry: RuntimePrimitiveBindingEntry) => Geometry2D;
  },
): {
  eyeParts: EyeParts;
  sideOf: (entry: RuntimePrimitiveBindingEntry) => EyeSide;
} | null {
  const lids = measureLidBoxes(context, args.faceSkin.object, args.blink);
  if (lids.left.isEmpty() || lids.right.isEmpty()) return null;

  // An eye layer lies within the eyes' region; glasses, a fringe or a mouth
  // primitive reaching over an eye extend well past it.
  const region = lids.left.clone().union(lids.right);
  const regionSize = region.getSize(new THREE.Vector3());
  // A lid's box spans every vertex blink moves, which on some models reaches
  // across the whole head; its front is the lid itself.
  const maxDepth = regionSize.x * EYE_LAYER_MAX_DEPTH;
  const sign = context.frontSign;
  // Whether a triangle of a primitive lies behind `lid`: its outline in the
  // front view meets the lid's, and a corner lies no deeper than `maxDepth`
  // behind the lid's front. An eye card larger than the lid has one; a part
  // whose outline only spans the lid from deep inside the head or beside it
  // (ears) has none.
  const behind = (
    points: readonly THREE.Vector3[],
    corners: readonly number[],
    lid: THREE.Box3,
  ) => {
    const front = Math.max(lid.min.z * sign, lid.max.z * sign) - maxDepth;
    for (let at = 0; at + 2 < corners.length; at += 3) {
      const triangle = [0, 1, 2].map((corner) => points[corners[at + corner]!]);
      if (triangle.some((point) => !point)) continue;
      const xs = triangle.map((point) => point!.x);
      const ys = triangle.map((point) => point!.y);
      if (
        Math.max(...xs) >= lid.min.x &&
        Math.min(...xs) <= lid.max.x &&
        Math.max(...ys) >= lid.min.y &&
        Math.min(...ys) <= lid.max.y &&
        Math.max(...triangle.map((point) => point!.z * sign)) >= front
      ) {
        return true;
      }
    }
    return false;
  };
  region.expandByVector(regionSize.multiplyScalar(EYE_REGION_MARGIN));
  const within = (box: THREE.Box3) =>
    box.min.x >= region.min.x &&
    box.max.x <= region.max.x &&
    box.min.y >= region.min.y &&
    box.max.y <= region.max.y;
  const sides = new Map<RuntimePrimitiveBindingEntry, EyeSide>();
  for (const { entry, shares } of args.candidates) {
    if (entry === args.faceSkin) continue;
    if (
      shares.head + shares.eye_left + shares.eye_right <
      HEAD_SKINNED_MIN_SHARE
    ) {
      continue;
    }
    if (shares.spring_head >= HAIR_MIN_SPRING_SHARE) continue;
    if (
      measureMorphDisplacement(entry.object, args.blink).movedShare >=
      BLINK_MOVED_MIN_SHARE
    ) {
      continue;
    }
    const points = anchorSpacePoints(context, entry.object);
    const box = new THREE.Box3().setFromPoints(points);
    if (box.isEmpty() || !within(box)) continue;
    const { corners } = readPrimitiveTriangles(context, entry);
    const left = behind(points, corners, lids.left);
    const right = behind(points, corners, lids.right);
    if (left || right) {
      sides.set(entry, left && right ? "both" : left ? "left" : "right");
    }
  }
  if (sides.size === 0) return null;
  const groups = (["left", "right", "both"] as const)
    .map((side) => [...sides].filter(([, of]) => of === side).map(([e]) => e))
    .filter((group) => group.length > 0)
    .map((group) => classifyEyePrimitives(group, [], args.measure));
  const eyeParts = mergeEyeGroups(groups);
  if (eyeParts.iris.length === 0) return null;
  return { eyeParts, sideOf: (entry) => sides.get(entry) ?? "both" };
}

type DetailRegion = {
  entry: RuntimePrimitiveBindingEntry;
  triangles: number[];
  area: number;
  side: "left" | "right";
  /** Follows its lid only part of the way (a lower lash, a wing tip). */
  lidEdge: boolean;
};

/** The box each eye's lid sweeps; see {@link measureLidSweeps}. */
type LidSweeps = Record<"left" | "right", THREE.Box3 | null>;

/**
 * The box each eye's lid sweeps on the face skin, in anchor space: its blink
 * region (open and closed) grown by {@link EYE_REGION_MARGIN} of its size on
 * every axis, but reaching no higher than the open lid's lash line. Lower
 * lashes hang below the closed lid and wing tips reach past the outer corner;
 * brows, and lid skin that a tall blink region includes, sit above the lash
 * line. Null for a side blink leaves still or whose lid piece holds no lash
 * line, where islands keep the half-travel rule.
 */
function measureLidSweeps(context: Context, face: THREE.Mesh): LidSweeps {
  const regions = measureBlinkRegions(
    context,
    face,
    collectPlayingMorphBinds(context.vrm, "blink", face),
  );
  const grown = (region: BlinkEyeRegion | null) => {
    if (!region || !Number.isFinite(region.lashLineTop)) return null;
    const size = region.bounds.getSize(new THREE.Vector3());
    const box = region.bounds
      .clone()
      .expandByVector(size.multiplyScalar(EYE_REGION_MARGIN));
    box.max.y = Math.min(box.max.y, region.lashLineTop);
    return box;
  };
  return { left: grown(regions.left), right: grown(regions.right) };
}

/**
 * Islands of the given primitives that blink moves almost entirely and about
 * as far as the eyelid, small next to the face and inside the eye window: eye
 * lines and lashes modelled inside the face or eye mesh. Inside the box its
 * lid sweeps, an island blink moves only part as far still qualifies, as a
 * `lidEdge` lash. The primitive's own main island never qualifies, because
 * blink moves only its lids.
 */
function findEyeDetailRegions(
  context: Context,
  args: {
    entries: readonly RuntimePrimitiveBindingEntry[];
    blink: Map<THREE.Object3D, number[]>;
    referenceMax: number;
    faceArea: number;
    window: EyeWindow | null;
    lidSweeps: LidSweeps;
  },
): DetailRegion[] {
  if (args.referenceMax <= 0) return [];
  const lowestRatio =
    args.lidSweeps.left || args.lidSweeps.right
      ? LID_EDGE_DETAIL_MIN_RATIO
      : BLINK_DISPLACEMENT_MIN_RATIO;
  const regions: DetailRegion[] = [];
  for (const entry of args.entries) {
    const mesh = entry.object;
    if (!args.blink.has(mesh)) continue;
    const displacement = morphDisplacements(mesh, args.blink);
    // Nothing here moves far enough with a lid: no island can qualify.
    const threshold = args.referenceMax * lowestRatio;
    if (!displacement.some((value) => value >= threshold)) continue;
    const points = anchorSpacePoints(context, mesh);
    const islands = splitTriangleIslands(context, entry);
    for (const island of islands) {
      let moved = 0;
      let max = 0;
      for (const vertex of island.vertices) {
        const value = displacement[vertex] ?? 0;
        if (value > MOVED_EPSILON) moved += 1;
        max = Math.max(max, value);
      }
      const shape = measureTriangles(points, island.corners);
      // The avatar's left is +x in VRM 1 head space and -x in VRM 0's.
      const side = shape.center.x * context.frontSign >= 0 ? "left" : "right";
      const lidEdge =
        max < args.referenceMax * BLINK_DISPLACEMENT_MIN_RATIO &&
        max >= args.referenceMax * LID_EDGE_DETAIL_MIN_RATIO &&
        Boolean(args.lidSweeps[side]?.containsPoint(shape.center));
      if (
        moved / island.vertices.length >= BLINK_MOVED_MIN_SHARE &&
        (max >= args.referenceMax * BLINK_DISPLACEMENT_MIN_RATIO || lidEdge) &&
        shape.area > 0 &&
        shape.area <= args.faceArea * EYE_DETAIL_MAX_AREA_RATIO &&
        (!args.window || isInsideWindow(shape.center, args.window))
      ) {
        regions.push({
          entry,
          triangles: island.triangles,
          area: shape.area,
          side,
          lidEdge,
        });
      }
    }
  }
  return regions;
}

/** Regions per primitive, triangles in index order. */
function groupRegionsByBinding(
  regions: readonly DetailRegion[],
): AvatarFacePartRegion[] {
  const byKey = new Map<string, number[]>();
  for (const region of regions) {
    const triangles = byKey.get(region.entry.bindingKey) ?? [];
    triangles.push(...region.triangles);
    byKey.set(region.entry.bindingKey, triangles);
  }
  return Array.from(byKey, ([bindingKey, triangles]) => ({
    bindingKey,
    triangles: triangles.sort((a, b) => a - b),
  }));
}

type TriangleIsland = {
  /** Triangle numbers in the geometry's index buffer. */
  triangles: number[];
  vertices: number[];
  /** Three vertex indices per triangle, for measuring. */
  corners: number[];
};

/**
 * A primitive's triangles grouped into islands that share a vertex position,
 * so UV and normal seams do not split one piece of geometry. An unindexed
 * primitive numbers its triangles in vertex order (its regions are found but
 * cannot be hidden, which effects report).
 */
function splitTriangleIslands(
  context: Context,
  entry: RuntimePrimitiveBindingEntry,
): TriangleIsland[] {
  const position = entry.object.geometry.getAttribute("position");
  if (!position) return [];
  const all = readPrimitiveTriangles(context, entry);
  const weld = createPositionWeld(position);
  const sets = new UnionFind();
  for (let at = 0; at + 2 < all.corners.length; at += 3) {
    const a = weld(all.corners[at]!);
    sets.union(a, weld(all.corners[at + 1]!));
    sets.union(a, weld(all.corners[at + 2]!));
  }
  const islands = new Map<number, TriangleIsland & { seen: Set<number> }>();
  all.triangles.forEach((triangle, at) => {
    const root = sets.find(weld(all.corners[at * 3]!));
    let island = islands.get(root);
    if (!island) {
      island = { triangles: [], vertices: [], corners: [], seen: new Set() };
      islands.set(root, island);
    }
    island.triangles.push(triangle);
    for (let offset = 0; offset < 3; offset += 1) {
      const vertex = all.corners[at * 3 + offset]!;
      island.corners.push(vertex);
      if (!island.seen.has(vertex)) {
        island.seen.add(vertex);
        island.vertices.push(vertex);
      }
    }
  });
  return Array.from(islands.values(), ({ triangles, vertices, corners }) => ({
    triangles,
    vertices,
    corners,
  }));
}

/**
 * One primitive's triangles: their numbers in the geometry's index buffer
 * (vertex order for an unindexed primitive) and three corner vertex indices
 * each, over the primitive's own index range of a mesh that holds several.
 */
function readPrimitiveTriangles(
  context: Pick<Context, "gltf">,
  entry: RuntimePrimitiveBindingEntry,
): { triangles: number[]; corners: number[] } {
  const geometry = entry.object.geometry;
  const index = geometry.getIndex();
  const count = index
    ? index.count
    : (geometry.getAttribute("position")?.count ?? 0);
  const range = resolvePrimitiveVertexRange(
    { sourceGltf: context.gltf },
    entry,
  );
  const start = Math.max(0, range?.start ?? 0);
  const end = Math.min(
    count,
    range?.count === null || range?.count === undefined
      ? count
      : start + range.count,
  );
  const triangles: number[] = [];
  const corners: number[] = [];
  for (let at = start; at + 2 < end; at += 3) {
    triangles.push(at / 3);
    for (let offset = 0; offset < 3; offset += 1) {
      corners.push(index ? index.getX(at + offset) : at + offset);
    }
  }
  return { triangles, corners };
}

/** A whole-body primitive's face: see {@link measureHeadRegion}. */
type HeadRegion = {
  /** Triangle numbers, in index order. */
  triangles: number[];
  /** Three corner vertex indices per triangle. */
  corners: number[];
  /** The corner vertices. */
  vertices: Set<number>;
  /** Their area projected on the head's front plane, in m². */
  area: number;
  /** The same inside the eye window, when there is one. */
  eyeWindowArea: number;
};

/**
 * The head region of a primitive that also holds the body (one mesh for the
 * whole Avatar, its face painted on): the triangles whose corners are all
 * skinned mainly to the head (or its non-spring descendants) and which face
 * forward, with their centre in the front
 * {@link FACE_FRONT_DEPTH_SHARE} of the head's depth. The back and sides of
 * the head, the neck, the body and hair on spring joints are left out; see
 * {@link keepFaceIsland} for what in front of the face goes too. Null when
 * no triangle qualifies.
 */
function measureHeadRegion(
  context: Context,
  entry: RuntimePrimitiveBindingEntry,
  classify: (bone: THREE.Object3D | null) => BoneClass,
  window: EyeWindow | null,
): HeadRegion | null {
  const mesh = entry.object;
  const head = measureVertexClassShares(mesh, classify, "head");
  const isHead = (vertex: number) => (head[vertex] ?? 0) >= MAJORITY_SHARE;
  const points = anchorSpacePoints(context, mesh);
  const all = readPrimitiveTriangles(context, entry);
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const vertex of all.corners) {
    const point = points[vertex];
    if (!point || !isHead(vertex)) continue;
    minZ = Math.min(minZ, point.z);
    maxZ = Math.max(maxZ, point.z);
  }
  if (minZ > maxZ) return null;
  const sign = context.frontSign;
  const front = sign > 0 ? maxZ : minZ;
  const depth = maxZ - minZ;
  // A mirroring transform flips the winding of front faces.
  const winding = composeWorldMatrix(mesh).determinant() < 0 ? -1 : 1;
  const normal = new THREE.Vector3();
  const edge = new THREE.Vector3();
  const triangles: number[] = [];
  const corners: number[] = [];
  all.triangles.forEach((triangle, at) => {
    const ends = all.corners.slice(at * 3, at * 3 + 3);
    if (!ends.every(isHead)) return;
    const [a, b, c] = ends.map((vertex) => points[vertex]);
    if (!a || !b || !c) return;
    const centreZ = (a.z + b.z + c.z) / 3;
    if ((front - centreZ) * sign > depth * FACE_FRONT_DEPTH_SHARE) return;
    normal.subVectors(b, a).cross(edge.subVectors(c, a));
    if (normal.z * sign * winding <= 0) return;
    triangles.push(triangle);
    corners.push(...ends);
  });
  return triangles.length > 0
    ? summarizeHeadRegion(points, triangles, corners, window)
    : null;
}

/** A head region of these triangles, with its vertices and areas. */
function summarizeHeadRegion(
  points: readonly THREE.Vector3[],
  triangles: number[],
  corners: number[],
  window: EyeWindow | null,
): HeadRegion {
  const region: HeadRegion = {
    triangles,
    corners,
    vertices: new Set(corners),
    area: 0,
    eyeWindowArea: 0,
  };
  const centroid = new THREE.Vector3();
  for (let at = 0; at + 2 < corners.length; at += 3) {
    const a = points[corners[at]!];
    const b = points[corners[at + 1]!];
    const c = points[corners[at + 2]!];
    if (!a || !b || !c) continue;
    const projected =
      Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
    region.area += projected;
    centroid
      .copy(a)
      .add(b)
      .add(c)
      .multiplyScalar(1 / 3);
    if (window && isInsideWindow(centroid, window)) {
      region.eyeWindowArea += projected;
    }
  }
  return region;
}

/**
 * A head region narrowed to the face: its UV island between the eyes and the
 * islands inside that island's outline (eyes, mouth, brows), chosen as
 * texture anchors choose it (`findFaceIslandTriangles`). A fringe, hood rim or
 * visor in front of the face is its own island and goes, so it neither sets
 * the face's front nor takes its anchors and art. The eyes are where blink
 * moves the primitive on each side, else the humanoid eye bones; without
 * both, or without such an island, the region stays as it is.
 */
function keepFaceIsland(
  context: Context,
  entry: RuntimePrimitiveBindingEntry,
  region: HeadRegion,
  window: EyeWindow | null,
): HeadRegion {
  const mesh = entry.object;
  const position = mesh.geometry.getAttribute("position");
  const uv = mesh.geometry.getAttribute("uv");
  const eyes = locateWholeBodyEyes(context, mesh);
  if (
    !eyes ||
    !(position instanceof THREE.BufferAttribute) ||
    !(uv instanceof THREE.BufferAttribute)
  ) {
    return region;
  }
  const points = anchorSpacePoints(context, mesh);
  const keep = findFaceIslandTriangles({
    corners: region.corners,
    pointOf: (vertex) => points[vertex],
    position,
    uv,
    seed: eyes[0].clone().add(eyes[1]).multiplyScalar(0.5),
    eyes,
    withIslands: "inner",
  });
  if (!keep) return region;
  const triangles: number[] = [];
  const corners: number[] = [];
  keep.forEach((kept, at) => {
    if (!kept) return;
    triangles.push(region.triangles[at]!);
    corners.push(...region.corners.slice(at * 3, at * 3 + 3));
  });
  return summarizeHeadRegion(points, triangles, corners, window);
}

/**
 * Both eyes of a whole-body primitive's face, in anchor space: the middle of
 * where blink moves it on each side ({@link measureBlinkRegions}, as
 * estimated eyes take them), else the humanoid eye bones. Null when neither
 * gives both.
 */
function locateWholeBodyEyes(
  context: Context,
  mesh: THREE.Mesh,
): [THREE.Vector3, THREE.Vector3] | null {
  const blink = measureBlinkRegions(
    context,
    mesh,
    collectPlayingMorphBinds(context.vrm, "blink", mesh),
  );
  if (blink.left && blink.right) return [blink.left.center, blink.right.center];
  const humanoid = context.vrm.humanoid;
  const left = humanoid?.getNormalizedBoneNode("leftEye") ?? null;
  const right = humanoid?.getNormalizedBoneNode("rightEye") ?? null;
  if (!left || !right) return null;
  // Normalized nodes, as the landmarks read them (see resolveEyeWindow).
  context.anchor.updateWorldMatrix(true, false);
  return [
    context.anchor.worldToLocal(left.getWorldPosition(new THREE.Vector3())),
    context.anchor.worldToLocal(right.getWorldPosition(new THREE.Vector3())),
  ];
}

/**
 * Whether a face mesh also holds the body: under {@link MAJORITY_SHARE} of
 * its skin weight is on the head, or over {@link BODY_SKIN_SHARE} is below
 * the neck. Its face is then its head region ({@link measureHeadRegion}), so
 * whole-face art and decals leave the body, clothes, hair and ears alone.
 */
function holdsBody(shares: SkinShares): boolean {
  return shares.head < MAJORITY_SHARE || shares.other > BODY_SKIN_SHARE;
}

/**
 * The face of an Avatar whose face mesh also holds its body: among the
 * face mesh candidates (primitives blink and aa morph, or blink alone when aa
 * morphs no mesh) that hold the body ({@link holdsBody}), the
 * one whose head region
 * ({@link measureHeadRegion}) either expression moves and that covers the
 * most of the eye window (or of the front view without one). Reports when
 * such primitives exist but none has a head region they move, so face
 * effects are skipped for a named reason.
 */
function detectWholeBodyFace(
  context: Context,
  args: {
    candidates: readonly Candidate[];
    classify: (bone: THREE.Object3D | null) => BoneClass;
    window: EyeWindow | null;
    blink: Map<THREE.Object3D, number[]>;
    aa: Map<THREE.Object3D, number[]>;
  },
): {
  entry: RuntimePrimitiveBindingEntry;
  region: HeadRegion;
  clear: boolean;
} | null {
  const wholeBody = args.candidates.filter((candidate) =>
    holdsBody(candidate.shares),
  );
  if (wholeBody.length === 0) return null;
  const found = wholeBody
    .flatMap(({ entry }) => {
      const region = measureHeadRegion(
        context,
        entry,
        args.classify,
        args.window,
      );
      if (!region || !faceExpressionsMove(entry, region, args)) return [];
      const score = args.window ? region.eyeWindowArea : region.area;
      return score > 0 ? [{ entry, region, score }] : [];
    })
    .sort((a, b) => b.score - a.score);
  if (!found[0]) {
    report(
      context,
      { code: "face_parts_whole_body_head_missing" },
      "A mesh part holding the whole body carries the blink or aa shapes, but none of its forward-facing triangles skinned to the head bone moves with them; its face cannot be found.",
    );
    return null;
  }
  return {
    entry: found[0].entry,
    region: keepFaceIsland(
      context,
      found[0].entry,
      found[0].region,
      args.window,
    ),
    clear: found[0].score >= (found[1]?.score ?? 0) * 2,
  };
}

/**
 * Whether blinking or the aa mouth moves a head region: the face is where the
 * Avatar blinks or speaks.
 */
function faceExpressionsMove(
  entry: RuntimePrimitiveBindingEntry,
  region: HeadRegion,
  binds: {
    blink: Map<THREE.Object3D, number[]>;
    aa: Map<THREE.Object3D, number[]>;
  },
): boolean {
  return (
    morphMovesAny(entry.object, binds.blink, region.vertices) ||
    morphMovesAny(entry.object, binds.aa, region.vertices)
  );
}

/** Whether any of an expression's morph targets moves a vertex of `vertices`. */
function morphMovesAny(
  mesh: THREE.Mesh,
  binds: Map<THREE.Object3D, number[]>,
  vertices: ReadonlySet<number>,
): boolean {
  const displacement = morphDisplacements(mesh, binds);
  for (const vertex of vertices) {
    if ((displacement[vertex] ?? 0) > MOVED_EPSILON) return true;
  }
  return false;
}

/**
 * One weld id per vertex, read lazily: the first vertex at each position, so
 * UV and normal seams do not split one surface.
 */
function createPositionWeld(
  position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
): (vertex: number) => number {
  const welded = new Map<string, number>();
  const weldIds = new Int32Array(position.count).fill(-1);
  return (vertex) => {
    let id = weldIds[vertex];
    if (id < 0) {
      const key = `${position.getX(vertex).toFixed(5)},${position
        .getY(vertex)
        .toFixed(5)},${position.getZ(vertex).toFixed(5)}`;
      id = welded.get(key) ?? vertex;
      welded.set(key, id);
      weldIds[vertex] = id;
    }
    return id;
  };
}

/** Projected area and centroid of triangles given as vertex triples. */
function measureTriangles(
  points: readonly THREE.Vector3[],
  corners: readonly number[],
): { area: number; center: THREE.Vector3 } {
  let area = 0;
  const center = new THREE.Vector3();
  let counted = 0;
  for (let at = 0; at + 2 < corners.length; at += 3) {
    const a = points[corners[at]];
    const b = points[corners[at + 1]];
    const c = points[corners[at + 2]];
    if (!a || !b || !c) continue;
    area += Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
    center.add(a).add(b).add(c);
    counted += 3;
  }
  if (counted > 0) center.multiplyScalar(1 / counted);
  return { area, center };
}

/**
 * Separate iris, white and highlight among eye-bone primitives. The iris is
 * the primitive most consistent with "whites are larger and behind it,
 * highlights are much smaller and in front of it"; ties go to the larger one.
 */
function classifyEyePrimitives(
  eyeBoneEntries: RuntimePrimitiveBindingEntry[],
  lookAtIrises: RuntimePrimitiveBindingEntry[],
  measure: (entry: RuntimePrimitiveBindingEntry) => Geometry2D,
): {
  iris: RuntimePrimitiveBindingEntry[];
  white: RuntimePrimitiveBindingEntry[];
  highlight: RuntimePrimitiveBindingEntry[];
  confidence: number;
} {
  const all = unique([...lookAtIrises, ...eyeBoneEntries]).filter(
    (entry) => measure(entry).area > 0,
  );
  if (all.length === 0) {
    return { iris: [], white: [], highlight: [], confidence: 0 };
  }
  const isHighlightOf = (
    entry: RuntimePrimitiveBindingEntry,
    iris: Geometry2D,
  ) => {
    const metrics = measure(entry);
    return (
      metrics.area < iris.area * HIGHLIGHT_MAX_AREA_RATIO &&
      metrics.front > iris.front
    );
  };
  const isWhiteOf = (entry: RuntimePrimitiveBindingEntry, iris: Geometry2D) => {
    const metrics = measure(entry);
    return metrics.area > iris.area && metrics.front < iris.front;
  };

  let irisEntries: RuntimePrimitiveBindingEntry[];
  let confidence: number;
  if (lookAtIrises.length > 0) {
    irisEntries = lookAtIrises;
    confidence = 0.95;
  } else {
    // Ties go to the middle layer (a highlight in front and a white behind),
    // then to the larger primitive.
    const scored = all
      .map((entry) => {
        const iris = measure(entry);
        const others = all.filter((other) => other !== entry);
        const highlights = others.filter((other) => isHighlightOf(other, iris));
        const whites = others.filter((other) => isWhiteOf(other, iris));
        return {
          entry,
          consistent: highlights.length + whites.length,
          middle: highlights.length > 0 && whites.length > 0,
          area: iris.area,
        };
      })
      .sort(
        (a, b) =>
          b.consistent - a.consistent ||
          Number(b.middle) - Number(a.middle) ||
          b.area - a.area,
      );
    irisEntries = [scored[0].entry];
    const unexplained = all.length - 1 - scored[0].consistent;
    confidence = unexplained === 0 ? 0.9 : 0.6;
  }
  const irisMetrics = measure(irisEntries[0]);
  const rest = all.filter((entry) => !irisEntries.includes(entry));
  return {
    iris: irisEntries,
    white: rest.filter((entry) => isWhiteOf(entry, irisMetrics)),
    highlight: rest.filter((entry) => isHighlightOf(entry, irisMetrics)),
    confidence,
  };
}

/** Primitives whose material a look-at expression moves with a texture transform. */
function findLookAtTextureEntries(
  context: Context,
): RuntimePrimitiveBindingEntry[] {
  const materials = new Set<THREE.Material>();
  const materialIndices = new Set<number>();
  for (const name of LOOK_AT_EXPRESSIONS) {
    const expression = context.vrm.expressionManager?.getExpression(name);
    for (const bind of expression?.binds ?? []) {
      if (!isTextureTransformBind(bind)) continue;
      materials.add(bind.material);
      const index = context.gltf.parser.associations.get(
        bind.material,
      )?.materials;
      if (typeof index === "number") materialIndices.add(index);
    }
  }
  if (materials.size === 0) return [];
  return context.entries.filter((entry) => {
    const material = Array.isArray(entry.object.material)
      ? entry.object.material[0]
      : entry.object.material;
    return (
      (material !== undefined && materials.has(material)) ||
      (entry.materialIndex !== null && materialIndices.has(entry.materialIndex))
    );
  });
}

function isTextureTransformBind(
  bind: unknown,
): bind is { material: THREE.Material } {
  return (
    typeof bind === "object" &&
    bind !== null &&
    "material" in bind &&
    "offset" in bind &&
    "scale" in bind &&
    (bind as { material: unknown }).material instanceof THREE.Material
  );
}

/** Each morph-bound primitive of an expression and its morph target indices. */
function collectMorphBinds(
  vrm: VRM,
  expressionName: string,
): Map<THREE.Object3D, number[]> {
  const result = new Map<THREE.Object3D, number[]>();
  const expression = vrm.expressionManager?.getExpression(expressionName);
  for (const bind of expression?.binds ?? []) {
    const morph = bind as { primitives?: unknown; index?: unknown };
    if (!Array.isArray(morph.primitives) || typeof morph.index !== "number") {
      continue;
    }
    for (const primitive of morph.primitives as THREE.Object3D[]) {
      const indices = result.get(primitive) ?? [];
      indices.push(morph.index);
      result.set(primitive, indices);
    }
  }
  return result;
}

/** How far an expression's morph targets move each vertex (m). */
function morphDisplacements(
  mesh: THREE.Mesh,
  binds: Map<THREE.Object3D, number[]>,
): Float32Array {
  const geometry = mesh.geometry;
  const targets = geometry.morphAttributes.position ?? [];
  const position = geometry.getAttribute("position");
  const displacement = new Float32Array(position?.count ?? 0);
  for (const index of binds.get(mesh) ?? []) {
    const target = targets[index];
    if (!target) continue;
    for (let vertex = 0; vertex < target.count; vertex += 1) {
      const length = Math.hypot(
        target.getX(vertex),
        target.getY(vertex),
        target.getZ(vertex),
      );
      displacement[vertex] = Math.max(displacement[vertex], length);
    }
  }
  return displacement;
}

/** The share of vertices a morph moves and its largest displacement (m). */
function measureMorphDisplacement(
  mesh: THREE.Mesh,
  binds: Map<THREE.Object3D, number[]>,
): { movedShare: number; max: number } {
  const displacement = morphDisplacements(mesh, binds);
  if (displacement.length === 0) return { movedShare: 0, max: 0 };
  let moved = 0;
  let max = 0;
  for (const value of displacement) {
    if (value > MOVED_EPSILON) moved += 1;
    max = Math.max(max, value);
  }
  return { movedShare: moved / displacement.length, max };
}

/** Normalized skin-weight shares per bone class; unskinned meshes use their parent. */
function measureSkinShares(
  mesh: THREE.Mesh,
  classify: (bone: THREE.Object3D | null) => BoneClass,
): SkinShares {
  const shares: SkinShares = {
    eye_left: 0,
    eye_right: 0,
    head: 0,
    spring_head: 0,
    neck: 0,
    other: 0,
  };
  const geometry = mesh.geometry;
  const skinIndex = geometry.getAttribute("skinIndex");
  const skinWeight = geometry.getAttribute("skinWeight");
  if (!(mesh instanceof THREE.SkinnedMesh) || !skinIndex || !skinWeight) {
    shares[classify(mesh.parent)] = 1;
    return shares;
  }
  const bones = mesh.skeleton.bones;
  let total = 0;
  for (let vertex = 0; vertex < skinIndex.count; vertex += 1) {
    for (let slot = 0; slot < skinIndex.itemSize; slot += 1) {
      const weight = skinWeight.getComponent(vertex, slot);
      if (weight <= 0) continue;
      shares[classify(bones[skinIndex.getComponent(vertex, slot)] ?? null)] +=
        weight;
      total += weight;
    }
  }
  if (total > 0) {
    for (const key of Object.keys(shares) as BoneClass[]) shares[key] /= total;
  }
  return shares;
}

/**
 * Each vertex's skin weight on bones of one class (1 or 0 for an unskinned
 * mesh, from its parent's class).
 */
function measureVertexClassShares(
  mesh: THREE.Mesh,
  classify: (bone: THREE.Object3D | null) => BoneClass,
  boneClass: BoneClass,
): Float32Array {
  const geometry = mesh.geometry;
  const count = geometry.getAttribute("position")?.count ?? 0;
  const shares = new Float32Array(count);
  const skinIndex = geometry.getAttribute("skinIndex");
  const skinWeight = geometry.getAttribute("skinWeight");
  if (!(mesh instanceof THREE.SkinnedMesh) || !skinIndex || !skinWeight) {
    shares.fill(classify(mesh.parent) === boneClass ? 1 : 0);
    return shares;
  }
  const bones = mesh.skeleton.bones;
  for (let vertex = 0; vertex < skinIndex.count; vertex += 1) {
    let total = 0;
    let matching = 0;
    for (let slot = 0; slot < skinIndex.itemSize; slot += 1) {
      const weight = skinWeight.getComponent(vertex, slot);
      if (weight <= 0) continue;
      total += weight;
      const bone = bones[skinIndex.getComponent(vertex, slot)] ?? null;
      if (classify(bone) === boneClass) matching += weight;
    }
    shares[vertex] = total > 0 ? matching / total : 0;
  }
  return shares;
}

/** Projected triangle area, front depth and centre in head-anchor space. */
function measurePrimitive(
  context: Context,
  mesh: THREE.Mesh,
  window: EyeWindow | null,
  vertexWeights: Float32Array | null = null,
): Geometry2D {
  const geometry = mesh.geometry;
  const position = geometry.getAttribute("position");
  if (!(position instanceof THREE.BufferAttribute) || position.count === 0) {
    return {
      area: 0,
      eyeWindowArea: 0,
      weightedArea: 0,
      weightedEyeWindowArea: 0,
      front: 0,
      center: new THREE.Vector3(),
      minX: 0,
      maxX: 0,
    };
  }
  const points = anchorSpacePoints(context, mesh);
  const center = new THREE.Vector3();
  let front = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  for (const point of points) {
    center.add(point);
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    front += point.z * context.frontSign;
  }
  center.multiplyScalar(1 / points.length);
  const index = geometry.getIndex();
  const triangleCount = index ? index.count / 3 : position.count / 3;
  let area = 0;
  let eyeWindowArea = 0;
  let weightedArea = 0;
  let weightedEyeWindowArea = 0;
  const centroid = new THREE.Vector3();
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const ia = index ? index.getX(triangle * 3) : triangle * 3;
    const ib = index ? index.getX(triangle * 3 + 1) : triangle * 3 + 1;
    const ic = index ? index.getX(triangle * 3 + 2) : triangle * 3 + 2;
    const a = points[ia];
    const b = points[ib];
    const c = points[ic];
    if (!a || !b || !c) continue;
    const projected =
      Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
    const weight = vertexWeights
      ? ((vertexWeights[ia] ?? 0) +
          (vertexWeights[ib] ?? 0) +
          (vertexWeights[ic] ?? 0)) /
        3
      : 1;
    area += projected;
    weightedArea += projected * weight;
    if (window) {
      centroid
        .copy(a)
        .add(b)
        .add(c)
        .multiplyScalar(1 / 3);
      if (isInsideWindow(centroid, window)) {
        eyeWindowArea += projected;
        weightedEyeWindowArea += projected * weight;
      }
    }
  }
  return {
    area,
    eyeWindowArea,
    weightedArea,
    weightedEyeWindowArea,
    front: front / points.length,
    center,
    minX,
    maxX,
  };
}

/** A mesh's vertices (skinned at rest) in anchor space, read once per detection. */
function anchorSpacePoints(
  context: Pick<Context, "anchor" | "points">,
  mesh: THREE.Mesh,
): THREE.Vector3[] {
  const cached = context.points.get(mesh);
  if (cached) return cached;
  const position = mesh.geometry.getAttribute("position");
  const points: THREE.Vector3[] = [];
  if (position instanceof THREE.BufferAttribute) {
    // Compose the mesh's world matrix without writing `matrixWorld`: before
    // the first frame a VRM 0 scene's raw bones still hold pre-rotation
    // matrices that the bind matrices agree with, so updating an ancestor bone
    // here would skew every later skinned read (landmarks included).
    const meshWorld = composeWorldMatrix(mesh);
    context.anchor.updateWorldMatrix(true, false);
    const inverseAnchor = context.anchor.matrixWorld.clone().invert();
    for (let vertex = 0; vertex < position.count; vertex += 1) {
      points.push(
        readVertexPosition(mesh, position, vertex, new THREE.Vector3())
          .applyMatrix4(meshWorld)
          .applyMatrix4(inverseAnchor),
      );
    }
  }
  context.points.set(mesh, points);
  return points;
}

/** An object's world matrix from current local transforms, without mutation. */
function composeWorldMatrix(object: THREE.Object3D): THREE.Matrix4 {
  const world = new THREE.Matrix4();
  const local = new THREE.Matrix4();
  for (let node: THREE.Object3D | null = object; node; node = node.parent) {
    if (node.matrixAutoUpdate) {
      local.compose(node.position, node.quaternion, node.scale);
    } else {
      local.copy(node.matrix);
    }
    world.premultiply(local);
  }
  return world;
}

/** A window around both eyes, from the eye bones or else the irises. */
function resolveEyeWindow(
  context: Context,
  irises: RuntimePrimitiveBindingEntry[],
  measure: (entry: RuntimePrimitiveBindingEntry) => Geometry2D,
): EyeWindow | null {
  // Normalized eye nodes, as the landmarks use: updating a raw bone's world
  // matrix here would change later skinned reads before the first frame.
  const humanoid = context.vrm.humanoid;
  const leftEye = humanoid?.getNormalizedBoneNode("leftEye") ?? null;
  const rightEye = humanoid?.getNormalizedBoneNode("rightEye") ?? null;
  let left: THREE.Vector3 | null = null;
  let right: THREE.Vector3 | null = null;
  if (leftEye && rightEye) {
    context.anchor.updateWorldMatrix(true, false);
    left = context.anchor.worldToLocal(
      leftEye.getWorldPosition(new THREE.Vector3()),
    );
    right = context.anchor.worldToLocal(
      rightEye.getWorldPosition(new THREE.Vector3()),
    );
  } else if (irises.length > 0) {
    // Without eye bones the iris primitive spans both eyes; use its extent.
    const iris = measure(irises[0]);
    const quarter = (iris.maxX - iris.minX) / 4;
    left = iris.center.clone().setX(iris.center.x - quarter);
    right = iris.center.clone().setX(iris.center.x + quarter);
  }
  if (!left || !right) return null;
  const distance = Math.max(left.distanceTo(right), 1e-3);
  return {
    minX: Math.min(left.x, right.x) - distance * EYE_WINDOW_HALF_WIDTH,
    maxX: Math.max(left.x, right.x) + distance * EYE_WINDOW_HALF_WIDTH,
    minY: (left.y + right.y) / 2 - distance * EYE_WINDOW_HALF_HEIGHT,
    maxY: (left.y + right.y) / 2 + distance * EYE_WINDOW_HALF_HEIGHT,
  };
}

function isInsideWindow(point: THREE.Vector3, window: EyeWindow): boolean {
  return (
    point.x >= window.minX &&
    point.x <= window.maxX &&
    point.y >= window.minY &&
    point.y <= window.maxY
  );
}

// ─── Names (per-role fallback) ──────────────────────────────────────────────

type NameSource = { sourceKey?: string | null; sourceUrl?: string | null };

/**
 * Material- and node-name detection, the pre-signal behaviour. Used per role
 * when signals find nothing, and by tests as the comparison baseline.
 */
export function detectAvatarFacePartsByName(
  vrm: VRM,
  gltf: GLTF,
  source: NameSource = {},
): Record<AvatarFacePartRole, string[]> {
  const entries = buildRuntimePrimitiveBindings({
    scene: vrm.scene,
    sourceGltf: gltf,
  }).entries;
  return detectFromNames(
    {
      vrm,
      gltf,
      entries,
      anchor: vrm.scene,
      frontSign: 1,
      diagnostics: [],
      issues: [],
      points: new Map(),
    },
    source,
  );
}

function detectFromNames(
  context: Context,
  source: NameSource,
): Record<AvatarFacePartRole, string[]> {
  const profile = resolveAvatarVFXModelProfile(source);
  const byRole = (role: AvatarVFXTargetRole) =>
    context.entries
      .filter(
        (entry) => matchAvatarTargetRole(entry.materialName, profile) === role,
      )
      .map((entry) => entry.bindingKey);
  const face = resolveFaceTargetBinding({
    ...source,
    entries: context.entries,
  });
  const irises = resolveEyeIrisTargetBindings({
    ...source,
    entries: context.entries,
  }).map((entry) => entry.bindingKey);
  return {
    face_skin: face ? [face.bindingKey] : [],
    eye_left: irises,
    eye_right: irises,
    eye_highlight: byRole("eye_highlight"),
    eyeline: byRole("eyeline"),
    eyelash: byRole("eyelash"),
    hair: resolveNamedHairBindings(context.gltf, context.entries).map(
      (entry) => entry.bindingKey,
    ),
  };
}

/**
 * Hair by name: everything under a top-level node named like hair, else any
 * primitive whose material, object or ancestor is named like hair.
 */
export function resolveNamedHairBindings(
  gltf: GLTF,
  entries: readonly RuntimePrimitiveBindingEntry[],
): RuntimePrimitiveBindingEntry[] {
  const rawNodes: unknown[] = Array.isArray(gltf.parser.json.nodes)
    ? gltf.parser.json.nodes
    : [];
  const parents = new Map<number, number>();
  rawNodes.forEach((node, index) => {
    for (const child of readChildren(node)) parents.set(child, index);
  });
  const nodeIndices = new Set<number>();
  const meshIndices = new Set<number>();
  const stack = rawNodes
    .map((node, index) => ({ node, index }))
    .filter(
      ({ node, index }) => !parents.has(index) && isHairName(readName(node)),
    )
    .map(({ index }) => index);
  while (stack.length > 0) {
    const index = stack.pop() ?? -1;
    if (index < 0 || nodeIndices.has(index)) continue;
    nodeIndices.add(index);
    const node = rawNodes[index];
    const mesh = (node as { mesh?: unknown } | null)?.mesh;
    if (typeof mesh === "number") meshIndices.add(mesh);
    stack.push(
      ...readChildren(node).filter((child) => child < rawNodes.length),
    );
  }
  const rooted = entries.filter(
    (entry) =>
      (entry.nodeIndex !== null && nodeIndices.has(entry.nodeIndex)) ||
      meshIndices.has(entry.meshIndex),
  );
  if (rooted.length > 0) return rooted;
  return entries.filter((entry) => {
    if (
      isHairName(entry.materialName ?? "") ||
      isHairName(entry.objectName ?? "")
    ) {
      return true;
    }
    for (let node = entry.object.parent; node; node = node.parent) {
      if (isHairName(node.name)) return true;
    }
    return false;
  });
}

function readChildren(node: unknown): number[] {
  const children = (node as { children?: unknown } | null)?.children;
  return Array.isArray(children)
    ? children.filter((child): child is number => typeof child === "number")
    : [];
}

function readName(node: unknown): string {
  const name = (node as { name?: unknown } | null)?.name;
  return typeof name === "string" ? name.trim() : "";
}

// ─── Corrections ────────────────────────────────────────────────────────────

/**
 * Replace detected roles with a correction for the same VRM bytes. Unknown
 * keys are dropped; a role left with no known key keeps its detection. An
 * explicitly empty optional role marks the part as absent.
 */
function applyCorrections(
  context: Context,
  parts: Record<AvatarFacePartRole, AvatarFacePart>,
  options: DetectAvatarFacePartsOptions,
): void {
  const corrections = options.corrections;
  if (!corrections) return;
  if (corrections.schema !== AVATAR_FACE_PARTS_SCHEMA) {
    report(
      context,
      { code: "face_parts_correction_schema_unsupported" },
      `Ignored face part corrections with unsupported schema ${String(corrections.schema)}.`,
    );
    return;
  }
  const digest = options.vrmSha256?.trim().toLowerCase() ?? "";
  if (!digest || corrections.vrm_sha256.trim().toLowerCase() !== digest) {
    if (digest) {
      report(
        context,
        { code: "face_parts_correction_other_file" },
        "Ignored face part corrections made for different VRM bytes.",
      );
    } else {
      report(
        context,
        { code: "face_parts_correction_digest_unknown" },
        "Ignored face part corrections because the VRM digest is unknown.",
      );
    }
    return;
  }
  const known = new Set(context.entries.map((entry) => entry.bindingKey));
  for (const role of AVATAR_FACE_PART_ROLES) {
    const requested = corrections.parts[role];
    if (requested === undefined || requested === null) continue;
    const bindings = unique(requested).filter((key) => known.has(key));
    const unknown = requested.filter((key) => !known.has(key));
    if (unknown.length > 0) {
      report(
        context,
        {
          code: "face_parts_correction_unknown_bindings",
          params: { part: role, count: unknown.length },
        },
        `Ignored unknown ${role} correction bindings: ${unknown.join(", ")}.`,
      );
    }
    if (requested.length > 0 && bindings.length === 0) continue;
    parts[role] = {
      role,
      bindings,
      source: "corrected",
      confidence: 1,
      detected: parts[role],
    };
  }
}

/**
 * Corrections and material names name whole primitives. Face skin they give a
 * primitive that also holds the body ({@link holdsBody}) keeps to that
 * primitive's head region, as a detected one does. Without a head region to
 * measure, a corrected primitive stays face skin whole (the user chose it).
 * A primitive found by its name needs what detection needs, a head region
 * that blinking or the aa mouth moves, or it is not face skin: a whole-body
 * mesh detection rejected cannot become the face by its material's name.
 */
function keepFaceSkinToHead(
  context: Context,
  parts: Record<AvatarFacePartRole, AvatarFacePart>,
): void {
  const face = parts.face_skin;
  if (face.source !== "corrected" && face.source !== "names") return;
  const classify = createBoneClassifier(context.vrm);
  const binds = {
    blink: collectMorphBinds(context.vrm, "blink"),
    aa: collectMorphBinds(context.vrm, "aa"),
  };
  const regions: AvatarFacePartRegion[] = [];
  const dropped = new Set<string>();
  for (const entry of selectFacePartEntries(
    { parts },
    ["face_skin"],
    context.entries,
  )) {
    if (!holdsBody(measureSkinShares(entry.object, classify))) continue;
    const measured = measureHeadRegion(context, entry, classify, null);
    const region =
      face.source === "names" &&
      measured &&
      !faceExpressionsMove(entry, measured, binds)
        ? null
        : measured;
    if (region) {
      regions.push({
        bindingKey: entry.bindingKey,
        triangles: keepFaceIsland(context, entry, region, null).triangles,
      });
    } else if (face.source === "names") {
      dropped.add(entry.bindingKey);
    }
  }
  const bindings = face.bindings.filter((key) => !dropped.has(key));
  parts.face_skin =
    bindings.length === 0
      ? { role: "face_skin", bindings: [], source: "missing", confidence: 0 }
      : {
          ...face,
          bindings,
          ...(regions.length > 0 ? { regions } : {}),
        };
}

function unique<T>(values: readonly T[]): T[] {
  return Array.from(new Set(values));
}
