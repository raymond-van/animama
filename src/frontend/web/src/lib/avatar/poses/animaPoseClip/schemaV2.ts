import type { VRMHumanBoneName } from "@pixiv/three-vrm";

import { isVRMHumanBoneName } from "../animaPose";
import { JOINT_DEFINITIONS, resolveJoint, type Side } from "../anatomy/anatomy";
import {
  ARM_BONE,
  CONTACT_POINTS,
  FINGER_BONE,
  HAND_BONE,
  HAND_OR_FINGER_BONE,
  type ContactPoint,
} from "../anatomy/contactPoints";
import {
  HAND_ADJUSTMENT_LIMITS,
  HAND_DIGIT_OFFSETS,
  HAND_DIGITS,
  HAND_FINGER_OFFSET_LIMIT,
  HAND_PRESETS,
  type HandDigit,
  type HandDigitOffset,
  type HandPreset,
} from "../anatomy/handPresetIds";
import {
  ANIMA_POSE_CLIP_DECIMALS,
  KNOWN_ANIMA_POSE_CLIP_EASINGS,
  roundAnimaPoseClipNumber,
  sanitizeAnimaPoseClipEvents,
  sanitizeAnimaPoseClipFade,
  sanitizeAnimaPoseClipLayerMutes,
  sanitizeAnimaPoseClipPlayback,
  sanitizeAnimaPoseClipRole,
  type AnimaPoseClipEasing,
  type AnimaPoseClipEvent,
  type AnimaPoseClipFade,
  type AnimaPoseClipMutableLayerId,
  type AnimaPoseClipPlayback,
  type AnimaPoseClipRole,
  type QuaternionTuple,
} from "./clipVocabulary";
import { isRecord } from "@/lib/records";

/**
 * `animaPoseClip/2.0`: motion stored as keyed tracks grouped by beats.
 *
 * Every key belongs to a beat and stores its time as an offset `dt` from it,
 * so retiming a beat moves its keys, editing its pose shifts them and deleting
 * it removes them. Values stay absolute. Anatomical tracks (`joints`) carry
 * authored motion in the joint model's degrees; rotation tracks (`rotations`)
 * carry hand-made poses as canonical quaternions.
 */
export const ANIMA_POSE_CLIP_V2_SCHEMA = "animaPoseClip/2.0" as const;

/**
 * How motion arrives at a key: `smooth` (monotone cubic, velocity carries
 * through keys), `linear`, `hold` (keep the previous value, then change at the
 * key) or one of the shared clip easings.
 */
export type AnimaPoseClipEase = "smooth" | "hold" | AnimaPoseClipEasing;

export type AnimaPoseClipBeat = {
  /** Stable id that keys refer to. */
  id: string;
  /** Readable name shown in the creator, for example "Raise". */
  label: string;
  time: number;
  /** Default arrival for the beat's keys. */
  ease?: AnimaPoseClipEase;
};

type BeatOwned = {
  beat: string;
  /** Seconds from the beat's time (default 0). */
  dt?: number;
  ease?: AnimaPoseClipEase;
};

export type AnimaPoseClipScalarKey = BeatOwned & {
  /** A number, or `"base"` for the base pose's value of this channel. */
  v: number | "base";
  /** `flat` stops motion at a smooth key. */
  tangent?: "auto" | "flat";
};

export type AnimaPoseClipRotationKey = BeatOwned & { q: QuaternionTuple };

export type AnimaPoseClipHandKey = BeatOwned & {
  preset: HandPreset;
  /** Relative finger curl after the preset, degrees. */
  curl?: number;
  /** Relative base-segment spread after the preset, degrees. */
  spread?: number;
  /**
   * Per-finger offsets after the preset, Curl and Spread. They belong to the
   * key's beat and blend between keys with the preset; a missing offset is 0.
   */
  fingers?: Partial<Record<HandDigit, HandDigitOffset>>;
};

/**
 * An intended touch between `bone` and `target` from `from` to `to` seconds
 * after its beat. The motion checks measure every contact; playback moves the
 * arm only for a contact with `solve`.
 */
export type AnimaPoseClipContact = {
  bone: string;
  target: string;
  /** Metres at the reference height, in the target's rest-aligned frame. */
  offset?: [number, number, number];
  beat: string;
  /** Seconds from the beat. */
  from: number;
  to: number;
  tolerance?: number;
  /** Where on `bone` the contact is measured (default `joint`, its origin). */
  point?: ContactPoint;
  /** Where on `target` the contact lands (default `joint`). */
  targetPoint?: ContactPoint;
  /** The checks also verify that the palm of `bone`'s hand faces the target. */
  facing?: boolean;
  /**
   * Playback moves the arm on each Avatar so `point` lands on the target during
   * the window, blending in and out over `blendIn`/`blendOut` seconds
   * (default {@link ANIMA_POSE_CLIP_V2_CONTACT_SOLVE}`.defaultBlendSeconds`).
   */
  solve?: AnimaPoseClipContactSolve;
};

export type AnimaPoseClipContactSolve = { blendIn?: number; blendOut?: number };

export type AnimaPoseClipV2 = {
  schema: typeof ANIMA_POSE_CLIP_V2_SCHEMA;
  id: string;
  name: string;
  role?: AnimaPoseClipRole;
  duration: number;
  loop?: boolean;
  playback?: AnimaPoseClipPlayback;
  basePose?: string;
  fadeIn?: AnimaPoseClipFade;
  fadeOut?: AnimaPoseClipFade;
  mutedProceduralLayers?: AnimaPoseClipMutableLayerId[];
  /** Solve the legs during playback so both feet stay at rest. */
  plantFeet?: boolean;
  beats: AnimaPoseClipBeat[];
  joints?: Record<string, Record<string, AnimaPoseClipScalarKey[]>>;
  rotations?: Partial<Record<VRMHumanBoneName, AnimaPoseClipRotationKey[]>>;
  hipsPosition?: Partial<Record<"x" | "y" | "z", AnimaPoseClipScalarKey[]>>;
  hands?: Partial<Record<Side, AnimaPoseClipHandKey[]>>;
  expressions?: Record<string, AnimaPoseClipScalarKey[]>;
  contacts?: AnimaPoseClipContact[];
  events?: AnimaPoseClipEvent[];
};

export type AnimaPoseClipV2Issue = { path: string; message: string };

export type AnimaPoseClipV2Validation =
  | { ok: true; clip: AnimaPoseClipV2 }
  | { ok: false; issues: AnimaPoseClipV2Issue[] };

/** Bounds that keep parsing untrusted clips cheap. */
export const ANIMA_POSE_CLIP_V2_LIMITS = {
  /** Seconds; far beyond any Gesture, it keeps every time finite. */
  duration: 3600,
  beats: 1000,
  tracks: 400,
  keys: 50_000,
  idLength: 64,
  labelLength: 80,
} as const;

/** Value bounds for track keys, shared with the backend validator. */
export const ANIMA_POSE_CLIP_V2_VALUE_BOUNDS = {
  /** Joint components, degrees either side of zero. */
  jointDegrees: 360,
  /** Hips offset from rest, metres either side of zero. */
  hipsMetres: 1,
  /** Smallest accepted quaternion length. */
  minQuaternionLength: 1e-6,
} as const;

/** Solved-contact blends, shared with the backend validator. */
export const ANIMA_POSE_CLIP_V2_CONTACT_SOLVE = {
  /** Seconds a missing `blendIn` or `blendOut` lasts (applied at playback). */
  defaultBlendSeconds: 0.15,
  /** Longest accepted `blendIn` or `blendOut`, seconds. */
  maxBlendSeconds: 2,
} as const;

/**
 * The top-level fields the 2.0 format defines. The shared vocabulary fixture
 * lists the same fields for the backend, which keeps only these of a clip
 * that did not come from a file.
 */
export const ANIMA_POSE_CLIP_V2_FIELDS: readonly string[] = [
  "schema",
  "id",
  "name",
  "role",
  "duration",
  "loop",
  "playback",
  "basePose",
  "fadeIn",
  "fadeOut",
  "mutedProceduralLayers",
  "plantFeet",
  "beats",
  "joints",
  "rotations",
  "hipsPosition",
  "hands",
  "expressions",
  "contacts",
  "events",
];

const KNOWN_FIELDS = new Set(ANIMA_POSE_CLIP_V2_FIELDS);

export const ANIMA_POSE_CLIP_EASES: ReadonlySet<string> = new Set<string>([
  "smooth",
  "hold",
  ...KNOWN_ANIMA_POSE_CLIP_EASINGS,
]);
const HAND_PRESET_IDS = new Set<string>(HAND_PRESETS.map(({ id }) => id));
const LEG_JOINT = /^(left|right)(UpperLeg|LowerLeg|Foot)$/;
const MAX_DEGREES = ANIMA_POSE_CLIP_V2_VALUE_BOUNDS.jointDegrees;
const MAX_HIPS_OFFSET = ANIMA_POSE_CLIP_V2_VALUE_BOUNDS.hipsMetres;
/**
 * Minimum spacing between beats, between keys of a track, and between a key
 * and its beat's neighbours. Saved files round times to 0.1 ms, so closer
 * spacing could turn a valid clip invalid once saved.
 */
export const ANIMA_POSE_CLIP_V2_MIN_SPACING = 0.0005;
/**
 * Times are validated and kept in whole ticks of the saved precision
 * (0.1 ms), so a clip that validates in memory validates the same once saved.
 */
const TICKS_PER_SECOND = 10 ** ANIMA_POSE_CLIP_DECIMALS.time;
export const ANIMA_POSE_CLIP_V2_MIN_SPACING_TICKS = Math.round(
  ANIMA_POSE_CLIP_V2_MIN_SPACING * TICKS_PER_SECOND,
);
/** Whole ticks, rounding exactly as the saved file does. */
export const toAnimaPoseClipTicks = (seconds: number) =>
  Math.round(
    roundAnimaPoseClipNumber(seconds, ANIMA_POSE_CLIP_DECIMALS.time) *
      TICKS_PER_SECOND,
  );
export const fromAnimaPoseClipTicks = (ticks: number) =>
  ticks / TICKS_PER_SECOND;
const toTicks = toAnimaPoseClipTicks;
const fromTicks = fromAnimaPoseClipTicks;

/** Validate a 2.0 clip, reporting every problem with its JSON path. */
export function validateAnimaPoseClipV2(
  value: unknown,
): AnimaPoseClipV2Validation {
  const issues: AnimaPoseClipV2Issue[] = [];
  const fail = (path: string, message: string) => {
    issues.push({ path, message });
    return null;
  };
  if (!isRecord(value))
    return {
      ok: false,
      issues: [{ path: "$", message: "Expected a JSON object." }],
    };
  if (value.schema !== ANIMA_POSE_CLIP_V2_SCHEMA)
    fail("schema", `Expected "${ANIMA_POSE_CLIP_V2_SCHEMA}".`);
  const id = requiredString(value.id) ?? fail("id", "Expected a non-empty id.");
  const name =
    requiredString(value.name) ?? fail("name", "Expected a non-empty name.");
  const role =
    value.role === undefined
      ? undefined
      : (sanitizeAnimaPoseClipRole(value.role) ??
        fail("role", 'Expected "motion" or "reaction".'));
  const playback =
    value.playback === undefined
      ? undefined
      : (sanitizeAnimaPoseClipPlayback(value.playback) ??
        fail("playback", "Invalid playback lifetime."));
  // Kept at the saved precision, like every other time.
  const duration =
    typeof value.duration === "number" &&
    Number.isFinite(value.duration) &&
    toTicks(value.duration) > 0 &&
    value.duration <= ANIMA_POSE_CLIP_V2_LIMITS.duration
      ? fromTicks(toTicks(value.duration))
      : fail(
          "duration",
          `Expected a positive number of seconds, at most ${ANIMA_POSE_CLIP_V2_LIMITS.duration}.`,
        );
  if (value.loop !== undefined && typeof value.loop !== "boolean")
    fail("loop", "Expected true or false.");
  if (value.plantFeet !== undefined && typeof value.plantFeet !== "boolean")
    fail("plantFeet", "Expected true or false.");
  const basePose =
    value.basePose === undefined
      ? undefined
      : (requiredString(value.basePose) ??
        fail("basePose", "Expected a pose id."));
  const fades: Partial<Record<"fadeIn" | "fadeOut", AnimaPoseClipFade>> = {};
  for (const field of ["fadeIn", "fadeOut"] as const)
    if (value[field] !== undefined) {
      const fade = sanitizeAnimaPoseClipFade(value[field]);
      if (fade) fades[field] = fade;
      else
        fail(
          field,
          "Expected { duration, easing? } with a non-negative duration.",
        );
    }
  const mutes =
    value.mutedProceduralLayers === undefined
      ? undefined
      : (sanitizeAnimaPoseClipLayerMutes(value.mutedProceduralLayers) ??
        fail("mutedProceduralLayers", "Expected an array of layer ids."));
  const endTicks = duration ? toTicks(duration) : Number.POSITIVE_INFINITY;
  const plantFeet = value.plantFeet === true;

  // Beats.
  const beats: AnimaPoseClipBeat[] = [];
  if (!Array.isArray(value.beats)) fail("beats", "Expected an array of beats.");
  else if (value.beats.length > ANIMA_POSE_CLIP_V2_LIMITS.beats)
    fail("beats", `At most ${ANIMA_POSE_CLIP_V2_LIMITS.beats} beats.`);
  else
    value.beats.forEach((beat, index) => {
      const path = `beats[${index}]`;
      if (!isRecord(beat)) return fail(path, "Expected { id, label, time }.");
      const beatId = requiredString(
        beat.id,
        ANIMA_POSE_CLIP_V2_LIMITS.idLength,
      );
      const label = requiredString(
        beat.label,
        ANIMA_POSE_CLIP_V2_LIMITS.labelLength,
      );
      if (!beatId)
        fail(
          `${path}.id`,
          `Expected a non-empty id of at most ${ANIMA_POSE_CLIP_V2_LIMITS.idLength} characters.`,
        );
      else if (beats.some((other) => other.id === beatId))
        fail(`${path}.id`, `Duplicate beat id "${beatId}".`);
      if (!label)
        fail(
          `${path}.label`,
          `Expected a non-empty label of at most ${ANIMA_POSE_CLIP_V2_LIMITS.labelLength} characters.`,
        );
      const time =
        typeof beat.time === "number" && Number.isFinite(beat.time)
          ? toTicks(beat.time)
          : null;
      const previous =
        beats.length > 0
          ? toTicks(beats[beats.length - 1].time)
          : Number.NEGATIVE_INFINITY;
      if (time === null || time < 0 || time > endTicks)
        fail(`${path}.time`, "Expected a time from 0 to the clip duration.");
      else if (time < previous + ANIMA_POSE_CLIP_V2_MIN_SPACING_TICKS)
        fail(
          `${path}.time`,
          `Beat times must increase by at least ${ANIMA_POSE_CLIP_V2_MIN_SPACING} s.`,
        );
      const ease = optionalEase(beat.ease, `${path}.ease`, fail);
      if (beatId && label && time !== null)
        beats.push({
          id: beatId,
          label,
          time: fromTicks(time),
          ...(ease ? { ease } : {}),
        });
    });
  const beatIndex = new Map(beats.map((beat, index) => [beat.id, index]));

  // Keys: ownership, offsets, windows and ordering.
  let trackCount = 0;
  let keyCount = 0;
  const keys = <K>(
    path: string,
    raw: unknown,
    parseValue: (
      key: Record<string, unknown>,
      keyPath: string,
    ) => Omit<K, keyof BeatOwned> | null,
  ): (K & BeatOwned)[] | null => {
    trackCount += 1;
    if (!Array.isArray(raw) || raw.length === 0)
      return fail(path, "Expected a non-empty array of keys.");
    keyCount += raw.length;
    const result: (K & BeatOwned)[] = [];
    let previous = Number.NEGATIVE_INFINITY;
    raw.forEach((key, index) => {
      const keyPath = `${path}[${index}]`;
      if (!isRecord(key)) return fail(keyPath, "Expected a key object.");
      const owner =
        typeof key.beat === "string" ? beatIndex.get(key.beat) : undefined;
      if (owner === undefined)
        return fail(
          `${keyPath}.beat`,
          `Unknown beat ${JSON.stringify(key.beat ?? null)}.`,
        );
      const rawDt = key.dt === undefined ? 0 : key.dt;
      if (typeof rawDt !== "number" || !Number.isFinite(rawDt))
        return fail(`${keyPath}.dt`, "Expected an offset in seconds.");
      const dt = toTicks(rawDt);
      const time = toTicks(beats[owner].time) + dt;
      const lower =
        owner > 0 ? toTicks(beats[owner - 1].time) : Number.NEGATIVE_INFINITY;
      const upper =
        owner < beats.length - 1
          ? toTicks(beats[owner + 1].time)
          : Number.POSITIVE_INFINITY;
      if (time < 0 || time > endTicks)
        fail(
          `${keyPath}.dt`,
          `Key time ${fromTicks(time)} is outside 0 to the clip duration.`,
        );
      else if (
        time < lower + ANIMA_POSE_CLIP_V2_MIN_SPACING_TICKS ||
        time > upper - ANIMA_POSE_CLIP_V2_MIN_SPACING_TICKS
      )
        fail(
          `${keyPath}.dt`,
          `Key time ${fromTicks(time)} must lie between the neighbouring beats of "${beats[owner].id}".`,
        );
      else if (time < previous + ANIMA_POSE_CLIP_V2_MIN_SPACING_TICKS)
        fail(
          `${keyPath}.dt`,
          `Key times must increase by at least ${ANIMA_POSE_CLIP_V2_MIN_SPACING} s within a track.`,
        );
      previous = time;
      const ease = optionalEase(key.ease, `${keyPath}.ease`, fail);
      const parsed = parseValue(key, keyPath);
      if (!parsed) return;
      result.push({
        ...(parsed as K),
        beat: beats[owner].id,
        ...(dt !== 0 ? { dt: fromTicks(dt) } : {}),
        ...(ease ? { ease } : {}),
      });
    });
    return result;
  };
  const scalar =
    (min: number, max: number, allowBase: boolean) =>
    (key: Record<string, unknown>, keyPath: string) => {
      const v = key.v;
      if (v === "base" && allowBase) {
        // allowed
      } else if (typeof v !== "number" || !Number.isFinite(v))
        return fail(
          `${keyPath}.v`,
          allowBase ? 'Expected a number or "base".' : "Expected a number.",
        );
      else if (v < min || v > max)
        return fail(`${keyPath}.v`, `${v} is outside ${min} to ${max}.`);
      if (
        key.tangent !== undefined &&
        key.tangent !== "auto" &&
        key.tangent !== "flat"
      )
        return fail(`${keyPath}.tangent`, 'Expected "auto" or "flat".');
      return {
        v: v as number | "base",
        ...(key.tangent === "flat" ? { tangent: "flat" as const } : {}),
      };
    };

  const joints: NonNullable<AnimaPoseClipV2["joints"]> = {};
  const jointBones = new Set<string>();
  if (value.joints !== undefined) {
    if (!isRecord(value.joints))
      fail("joints", "Expected an object of joints.");
    else
      for (const [jointId, components] of Object.entries(value.joints)) {
        const path = `joints.${jointId}`;
        const joint = resolveJoint(jointId);
        if (!joint) {
          fail(path, `Unknown joint "${jointId}".`);
          continue;
        }
        if (plantFeet && LEG_JOINT.test(jointId)) {
          fail(
            path,
            "Legs are solved during playback while plantFeet is true.",
          );
          continue;
        }
        if (!isRecord(components) || Object.keys(components).length === 0) {
          fail(path, "Expected an object of component tracks.");
          continue;
        }
        joint.bones.forEach((bone) => jointBones.add(bone));
        const definition = JOINT_DEFINITIONS[joint.type];
        const parsedComponents: Record<string, AnimaPoseClipScalarKey[]> = {};
        for (const [component, raw] of Object.entries(components)) {
          // Own properties only: "constructor" is not a component.
          if (!Object.hasOwn(definition.components, component)) {
            fail(
              `${path}.${component}`,
              `Unknown component. ${jointId} accepts: ${Object.keys(definition.components).join(", ")}.`,
            );
            continue;
          }
          const track = keys<AnimaPoseClipScalarKey>(
            `${path}.${component}`,
            raw,
            scalar(-MAX_DEGREES, MAX_DEGREES, true),
          );
          if (track) parsedComponents[component] = track;
        }
        joints[jointId] = parsedComponents;
      }
  }

  const rotations: NonNullable<AnimaPoseClipV2["rotations"]> = {};
  if (value.rotations !== undefined) {
    if (!isRecord(value.rotations))
      fail("rotations", "Expected an object of bones.");
    else
      for (const [bone, raw] of Object.entries(value.rotations)) {
        const path = `rotations.${bone}`;
        if (!isVRMHumanBoneName(bone)) {
          fail(path, `Unknown humanoid bone "${bone}".`);
          continue;
        }
        if (jointBones.has(bone)) {
          fail(path, "This bone already has anatomical tracks under joints.");
          continue;
        }
        if (plantFeet && LEG_JOINT.test(bone)) {
          fail(
            path,
            "Legs are solved during playback while plantFeet is true.",
          );
          continue;
        }
        const track = keys<AnimaPoseClipRotationKey>(
          path,
          raw,
          (key, keyPath) => {
            const q = key.q;
            if (
              !Array.isArray(q) ||
              q.length !== 4 ||
              !q.every((n) => typeof n === "number" && Number.isFinite(n)) ||
              Math.hypot(...(q as number[])) <
                ANIMA_POSE_CLIP_V2_VALUE_BOUNDS.minQuaternionLength
            )
              return fail(
                `${keyPath}.q`,
                "Expected a non-zero quaternion [x, y, z, w].",
              );
            return { q: q as QuaternionTuple };
          },
        );
        if (track) rotations[bone] = track;
      }
  }

  const hipsPosition: NonNullable<AnimaPoseClipV2["hipsPosition"]> = {};
  if (value.hipsPosition !== undefined) {
    if (!isRecord(value.hipsPosition))
      fail("hipsPosition", "Expected { x?, y?, z? } tracks.");
    else
      for (const [axis, raw] of Object.entries(value.hipsPosition)) {
        if (axis !== "x" && axis !== "y" && axis !== "z") {
          fail(`hipsPosition.${axis}`, "Expected x, y or z.");
          continue;
        }
        const track = keys<AnimaPoseClipScalarKey>(
          `hipsPosition.${axis}`,
          raw,
          scalar(-MAX_HIPS_OFFSET, MAX_HIPS_OFFSET, true),
        );
        if (track) hipsPosition[axis] = track;
      }
  }

  const hands: NonNullable<AnimaPoseClipV2["hands"]> = {};
  if (value.hands !== undefined) {
    if (!isRecord(value.hands)) fail("hands", "Expected { left?, right? }.");
    else
      for (const [side, raw] of Object.entries(value.hands)) {
        if (side !== "left" && side !== "right") {
          fail(`hands.${side}`, 'Expected "left" or "right".');
          continue;
        }
        const track = keys<AnimaPoseClipHandKey>(
          `hands.${side}`,
          raw,
          (key, keyPath) => parseHandKey(key, keyPath, fail),
        );
        if (track) hands[side] = track;
      }
  }

  const expressions: NonNullable<AnimaPoseClipV2["expressions"]> = {};
  if (value.expressions !== undefined) {
    if (!isRecord(value.expressions))
      fail("expressions", "Expected an object of expression tracks.");
    else
      for (const [expression, raw] of Object.entries(value.expressions)) {
        if (!expression.trim() || expression === "__proto__") {
          fail(`expressions.${expression}`, "Expected an expression name.");
          continue;
        }
        const track = keys<AnimaPoseClipScalarKey>(
          `expressions.${expression}`,
          raw,
          scalar(0, 1, false),
        );
        if (track) expressions[expression] = track;
      }
  }

  const contacts: AnimaPoseClipContact[] = [];
  const solvedWindows: SolvedWindow[] = [];
  if (value.contacts !== undefined) {
    if (!Array.isArray(value.contacts))
      fail("contacts", "Expected an array of contacts.");
    else
      value.contacts.forEach((contact, index) => {
        const path = `contacts[${index}]`;
        if (!isRecord(contact))
          return fail(path, "Expected { bone, target, beat, from, to }.");
        const bone = contact.bone;
        const target = contact.target;
        if (
          typeof bone !== "string" ||
          typeof target !== "string" ||
          !isVRMHumanBoneName(bone) ||
          !isVRMHumanBoneName(target)
        )
          return fail(
            path,
            "Expected humanoid bone names for bone and target.",
          );
        if (typeof contact.beat !== "string" || !beatIndex.has(contact.beat))
          return fail(
            `${path}.beat`,
            `Unknown beat ${JSON.stringify(contact.beat ?? null)}.`,
          );
        // Checked in ticks, like key times, so it holds once saved.
        const beatTicks = toTicks(beats[beatIndex.get(contact.beat)!].time);
        if (
          typeof contact.from !== "number" ||
          typeof contact.to !== "number" ||
          !Number.isFinite(contact.from) ||
          !Number.isFinite(contact.to) ||
          beatTicks + toTicks(contact.from) < 0 ||
          toTicks(contact.to) < toTicks(contact.from) ||
          beatTicks + toTicks(contact.to) > endTicks
        )
          return fail(
            path,
            "Expected offsets from ≤ to, in seconds from the beat, inside the clip.",
          );
        const offset = contact.offset;
        if (
          offset !== undefined &&
          !(
            Array.isArray(offset) &&
            offset.length === 3 &&
            offset.every((n) => typeof n === "number" && Number.isFinite(n))
          )
        )
          return fail(`${path}.offset`, "Expected [x, y, z] metres.");
        const tolerance = contact.tolerance;
        if (
          tolerance !== undefined &&
          !(
            typeof tolerance === "number" &&
            Number.isFinite(tolerance) &&
            tolerance > 0
          )
        )
          return fail(
            `${path}.tolerance`,
            "Expected a positive distance in metres.",
          );
        const fields = parseContactFields(contact, bone, target, path, fail);
        if (!fields) return;
        if (fields.solve) {
          const blend = ANIMA_POSE_CLIP_V2_CONTACT_SOLVE.defaultBlendSeconds;
          const side: Side = bone.startsWith("left") ? "left" : "right";
          solvedWindows.push({
            index,
            side,
            start: beatTicks + toTicks(contact.from),
            end: beatTicks + toTicks(contact.to),
            crossTarget:
              ARM_BONE.exec(target)?.[1] !== otherSide(side)
                ? null
                : HAND_OR_FINGER_BONE.test(target)
                  ? "hand"
                  : "arm",
            blendIn: toTicks(fields.solve.blendIn ?? blend),
            blendOut: toTicks(fields.solve.blendOut ?? blend),
          });
        }
        contacts.push({
          bone,
          target,
          beat: contact.beat,
          from: fromTicks(toTicks(contact.from)),
          to: fromTicks(toTicks(contact.to)),
          ...(offset ? { offset: offset as [number, number, number] } : {}),
          ...(tolerance !== undefined ? { tolerance } : {}),
          ...fields,
        });
      });
  }
  checkSolvedWindows(solvedWindows, fail);
  checkMutualWindows(solvedWindows, endTicks, value.loop === true, fail);

  const events =
    value.events === undefined
      ? undefined
      : (sanitizeAnimaPoseClipEvents(value.events, duration ?? undefined) ??
        fail(
          "events",
          "Invalid events: check each event's kind, time and fields.",
        ));

  if (trackCount > ANIMA_POSE_CLIP_V2_LIMITS.tracks)
    fail("$", `At most ${ANIMA_POSE_CLIP_V2_LIMITS.tracks} tracks.`);
  if (keyCount > ANIMA_POSE_CLIP_V2_LIMITS.keys)
    fail("$", `At most ${ANIMA_POSE_CLIP_V2_LIMITS.keys} keys.`);
  // A clip must move something or trigger something.
  if (keyCount === 0 && (!events || events.length === 0))
    fail("$", "A clip needs at least one track key or event.");

  if (issues.length > 0 || !id || !name || !duration)
    return { ok: false, issues };
  const unknownFields = Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !KNOWN_FIELDS.has(key))
      .map(([key, field]) => [key, structuredClone(field)]),
  );
  return {
    ok: true,
    clip: {
      ...unknownFields,
      schema: ANIMA_POSE_CLIP_V2_SCHEMA,
      id,
      name,
      ...(role ? { role } : {}),
      duration,
      ...(value.loop === true ? { loop: true } : {}),
      ...(playback ? { playback } : {}),
      ...(basePose ? { basePose } : {}),
      ...fades,
      ...(mutes && mutes.length > 0 ? { mutedProceduralLayers: mutes } : {}),
      ...(plantFeet ? { plantFeet: true } : {}),
      beats,
      ...nonEmpty("joints", joints),
      ...nonEmpty("rotations", rotations),
      ...nonEmpty("hipsPosition", hipsPosition),
      ...nonEmpty("hands", hands),
      ...nonEmpty("expressions", expressions),
      ...(contacts.length > 0 ? { contacts } : {}),
      ...(events && events.length > 0 ? { events } : {}),
    },
  };
}

export function sanitizeAnimaPoseClipV2(
  value: unknown,
): AnimaPoseClipV2 | null {
  const result = validateAnimaPoseClipV2(value);
  return result.ok ? result.clip : null;
}

/** Parse a 2.0 clip or throw an error listing its problems. */
export function parseAnimaPoseClipV2(value: unknown): AnimaPoseClipV2 {
  const result = validateAnimaPoseClipV2(value);
  if (result.ok) return result.clip;
  throw new Error(
    `Invalid ${ANIMA_POSE_CLIP_V2_SCHEMA} payload: ${formatAnimaPoseClipV2Issues(result.issues.slice(0, 5))}`,
  );
}

export function formatAnimaPoseClipV2Issues(
  issues: readonly AnimaPoseClipV2Issue[],
): string {
  return issues.map(({ path, message }) => `${path}: ${message}`).join("; ");
}

/** Absolute time of a key, given its beat's time. */
export function animaPoseClipKeyTime(
  beatTime: number,
  key: { dt?: number },
): number {
  return beatTime + (key.dt ?? 0);
}

function optionalEase(
  value: unknown,
  path: string,
  fail: (path: string, message: string) => null,
): AnimaPoseClipEase | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && ANIMA_POSE_CLIP_EASES.has(value))
    return value as AnimaPoseClipEase;
  fail(
    path,
    `Unknown ease. Use one of: ${[...ANIMA_POSE_CLIP_EASES].join(", ")}.`,
  );
  return undefined;
}

/**
 * A hand key's shape: a known preset, Curl and Spread within their limits,
 * and per-finger offsets. Every problem is reported at its JSON path. Zero
 * adjustments and offsets are dropped, since a missing one changes nothing.
 */
function parseHandKey(
  key: Record<string, unknown>,
  keyPath: string,
  fail: (path: string, message: string) => null,
): Omit<AnimaPoseClipHandKey, keyof BeatOwned> | null {
  let valid = true;
  const reject = (path: string, message: string) => {
    valid = false;
    fail(path, message);
  };
  if (typeof key.preset !== "string" || !HAND_PRESET_IDS.has(key.preset))
    reject(
      `${keyPath}.preset`,
      `Unknown preset. Use one of: ${[...HAND_PRESET_IDS].join(", ")}.`,
    );
  const adjustments: { curl?: number; spread?: number } = {};
  for (const field of ["curl", "spread"] as const) {
    const amount = key[field];
    if (amount === undefined) continue;
    const limit = HAND_ADJUSTMENT_LIMITS[field];
    if (!isDegrees(amount, limit))
      reject(
        `${keyPath}.${field}`,
        `Expected degrees from −${limit} to ${limit}.`,
      );
    else if (amount !== 0) adjustments[field] = amount;
  }
  const fingers =
    key.fingers === undefined
      ? {}
      : parseHandFingers(key.fingers, `${keyPath}.fingers`, reject);
  if (!valid) return null;
  return {
    preset: key.preset as HandPreset,
    ...adjustments,
    ...nonEmpty("fingers", fingers),
  };
}

/**
 * A hand key's `fingers`: known digits, each with only its own offset fields
 * (`HAND_DIGIT_OFFSETS`), in degrees within `HAND_FINGER_OFFSET_LIMIT`; a
 * per-segment `curl` lists exactly one value per segment.
 */
function parseHandFingers(
  value: unknown,
  path: string,
  reject: (path: string, message: string) => void,
): NonNullable<AnimaPoseClipHandKey["fingers"]> {
  const fingers: NonNullable<AnimaPoseClipHandKey["fingers"]> = {};
  if (!isRecord(value)) {
    reject(path, `Expected { ${HAND_DIGITS.map((d) => `${d}?`).join(", ")} }.`);
    return fingers;
  }
  const limit = HAND_FINGER_OFFSET_LIMIT;
  for (const [digit, raw] of Object.entries(value)) {
    const digitPath = `${path}.${digit}`;
    // Own properties only: "constructor" is not a digit.
    if (!Object.hasOwn(HAND_DIGIT_OFFSETS, digit)) {
      reject(
        digitPath,
        `Unknown digit. Use one of: ${HAND_DIGITS.join(", ")}.`,
      );
      continue;
    }
    const { fields, segments } = HAND_DIGIT_OFFSETS[digit as HandDigit];
    if (!isRecord(raw)) {
      reject(
        digitPath,
        `Expected { ${fields.map((f) => `${f}?`).join(", ")} }.`,
      );
      continue;
    }
    const offset: Record<string, number | number[]> = {};
    for (const [field, amount] of Object.entries(raw)) {
      const fieldPath = `${digitPath}.${field}`;
      if (!(fields as readonly string[]).includes(field)) {
        reject(
          fieldPath,
          `Unknown offset. ${digit} accepts: ${fields.join(", ")}.`,
        );
        continue;
      }
      const perSegment = field === "curl" && Array.isArray(amount);
      // A copy, so the parsed clip shares no arrays with its input.
      const values: unknown[] = perSegment ? [...amount] : [amount];
      if (
        (perSegment && values.length !== segments.length) ||
        !values.every((v) => isDegrees(v, limit))
      ) {
        reject(
          fieldPath,
          `Expected degrees from −${limit} to ${limit}${field === "curl" ? `, or one value per segment (${segments.join(", ")})` : ""}.`,
        );
        continue;
      }
      if (values.some((v) => v !== 0))
        offset[field] = perSegment ? (values as number[]) : (amount as number);
    }
    if (Object.keys(offset).length > 0) fingers[digit as HandDigit] = offset;
  }
  return fingers;
}

const SOLVE_FIELDS = ["blendIn", "blendOut"] as const;

type ContactFields = Pick<
  AnimaPoseClipContact,
  "point" | "targetPoint" | "facing" | "solve"
>;
/** A solved contact's window on its effector's side, in ticks. */
type SolvedWindow = {
  index: number;
  side: Side;
  start: number;
  end: number;
  /**
   * Where on the other side's arm the target is: its hand or fingers
   * (`hand`), its upper arm or forearm (`arm`), or neither (null).
   */
  crossTarget: "hand" | "arm" | null;
  /** Blend ticks before and after the window, defaults applied. */
  blendIn: number;
  blendOut: number;
};

/**
 * A contact's optional `point`, `targetPoint`, `facing` and `solve`, kept only
 * when present (defaults are applied at playback, not written). Every problem
 * is reported at its JSON path; null when any field is invalid.
 */
function parseContactFields(
  contact: Record<string, unknown>,
  bone: VRMHumanBoneName,
  target: VRMHumanBoneName,
  path: string,
  fail: (path: string, message: string) => null,
): ContactFields | null {
  let valid = true;
  const reject = (fieldPath: string, message: string) => {
    valid = false;
    fail(fieldPath, message);
  };
  const fields: ContactFields = {};
  const point = (field: "point" | "targetPoint", on: VRMHumanBoneName) => {
    const value = contact[field];
    if (value === undefined) return;
    if (!CONTACT_POINTS.includes(value as ContactPoint))
      reject(
        `${path}.${field}`,
        `Expected one of: ${CONTACT_POINTS.join(", ")}.`,
      );
    else if (value === "palm" && !HAND_BONE.test(on))
      reject(
        `${path}.${field}`,
        `"palm" applies only to a hand bone, not ${on}.`,
      );
    else if (value === "tip" && !FINGER_BONE.test(on))
      reject(
        `${path}.${field}`,
        `"tip" applies only to a finger bone, not ${on}.`,
      );
    else fields[field] = value as ContactPoint;
  };
  point("point", bone);
  point("targetPoint", target);
  if (contact.facing !== undefined) {
    if (typeof contact.facing !== "boolean")
      reject(`${path}.facing`, "Expected true or false.");
    else if (!HAND_OR_FINGER_BONE.test(bone))
      reject(
        `${path}.facing`,
        `Palm facing applies only to a hand or finger bone, not ${bone}.`,
      );
    else fields.facing = contact.facing;
  }
  if (contact.solve !== undefined) {
    const solve = parseContactSolve(contact.solve, `${path}.solve`, reject);
    const side = HAND_OR_FINGER_BONE.exec(bone)?.[1];
    if (!side)
      reject(
        `${path}.bone`,
        `A solved contact moves a hand or finger bone, not ${bone}.`,
      );
    else if (ARM_BONE.exec(target)?.[1] === side)
      reject(
        `${path}.target`,
        `A solved contact cannot target ${target}: it is on the arm the solve moves.`,
      );
    if (solve) fields.solve = solve;
  }
  return valid ? fields : null;
}

/** `solve`: `{}` or `{ blendIn?, blendOut? }` in seconds, kept at time precision. */
function parseContactSolve(
  value: unknown,
  path: string,
  reject: (path: string, message: string) => void,
): AnimaPoseClipContactSolve | null {
  const max = ANIMA_POSE_CLIP_V2_CONTACT_SOLVE.maxBlendSeconds;
  if (!isRecord(value)) {
    reject(path, "Expected { blendIn?, blendOut? } in seconds.");
    return null;
  }
  const solve: AnimaPoseClipContactSolve = {};
  for (const [field, seconds] of Object.entries(value)) {
    if (!(SOLVE_FIELDS as readonly string[]).includes(field)) {
      reject(
        `${path}.${field}`,
        `Unknown field. solve accepts: ${SOLVE_FIELDS.join(", ")}.`,
      );
      continue;
    }
    if (
      typeof seconds !== "number" ||
      !Number.isFinite(seconds) ||
      seconds < 0 ||
      seconds > max
    ) {
      reject(`${path}.${field}`, `Expected seconds from 0 to ${max}.`);
      continue;
    }
    solve[field as (typeof SOLVE_FIELDS)[number]] = fromTicks(toTicks(seconds));
  }
  return solve;
}

/**
 * One solved contact per side at a time: solved windows on one side must not
 * overlap, though one may start where another ends. Their blend ramps may
 * overlap; playback shortens them to meet midway. Each window that starts
 * before an earlier-starting one on its side has ended is reported at its
 * `solve`.
 */
function checkSolvedWindows(
  windows: readonly SolvedWindow[],
  fail: (path: string, message: string) => null,
) {
  for (const side of ["left", "right"] as const) {
    let reach = Number.NEGATIVE_INFINITY;
    let owner = -1;
    for (const span of windows
      .filter((candidate) => candidate.side === side)
      .sort((a, b) => a.start - b.start || a.index - b.index)) {
      if (span.start < reach)
        fail(
          `contacts[${span.index}].solve`,
          `Overlaps the solved window of contacts[${owner}]; solved contacts on the ${side} arm must not overlap in time.`,
        );
      if (span.end > reach) {
        reach = span.end;
        owner = span.index;
      }
    }
  }
}

/**
 * Mutual solves are limited to crossed arms. Two solved contacts on opposite
 * sides whose targets each lie on the other side's arm must not be active at
 * the same time (windows with their blends, wrapped across a loop's seam),
 * unless both targets are an upper arm or forearm: when either targets the
 * other hand or its fingers, each hand chases the other and the solve
 * diverges. A clap therefore solves one palm onto the other. Reported at the
 * `solve` of the contact whose active span starts first inside the other's.
 */
function checkMutualWindows(
  windows: readonly SolvedWindow[],
  end: number,
  loop: boolean,
  fail: (path: string, message: string) => null,
) {
  type Kind = "hand" | "arm";
  type Span = {
    index: number;
    side: Side;
    kind: Kind;
    start: number;
    end: number;
  };
  const spans: Span[] = [];
  for (const window of windows) {
    const kind = window.crossTarget;
    if (!kind) continue;
    const from = window.start - window.blendIn;
    const to = window.end + window.blendOut;
    const span = (start: number, stop: number) =>
      spans.push({
        index: window.index,
        side: window.side,
        kind,
        start,
        end: stop,
      });
    if (loop && to - from >= end) span(0, end);
    else {
      span(Math.max(from, 0), Math.min(to, end));
      if (loop && from < 0) span(from + end, end);
      if (loop && to > end) span(0, to - end);
    }
  }
  // Per side and kind: the latest end so far and the contact it belongs to.
  const reach: Record<Side, Record<Kind, { end: number; index: number }>> = {
    left: {
      hand: { end: Number.NEGATIVE_INFINITY, index: -1 },
      arm: { end: Number.NEGATIVE_INFINITY, index: -1 },
    },
    right: {
      hand: { end: Number.NEGATIVE_INFINITY, index: -1 },
      arm: { end: Number.NEGATIVE_INFINITY, index: -1 },
    },
  };
  // A pair can meet twice across a loop's seam; it is reported once.
  const reported = new Set<string>();
  for (const span of spans.sort(
    (a, b) => a.start - b.start || a.index - b.index,
  )) {
    const other = reach[otherSide(span.side)];
    // Two arm targets (crossed arms) may be mutual; a hand target may not.
    const latest =
      span.kind === "arm" || other.hand.end >= other.arm.end
        ? other.hand
        : other.arm;
    const pair = [span.index, latest.index].sort((a, b) => a - b).join();
    if (span.start < latest.end && !reported.has(pair)) {
      reported.add(pair);
      fail(
        `contacts[${span.index}].solve`,
        `contacts[${latest.index}] solves the other arm toward this one at the same time (windows with their blends overlap), and one of them targets a hand: only crossed arms onto the upper arm or forearm may be solved both ways. Solve only one of them.`,
      );
    }
    const own = reach[span.side][span.kind];
    if (span.end > own.end) {
      own.end = span.end;
      own.index = span.index;
    }
  }
}

const otherSide = (side: Side): Side => (side === "left" ? "right" : "left");

/** A finite number of degrees no further than `limit` from zero. */
function isDegrees(value: unknown, limit: number): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value) <= limit
  );
}

function nonEmpty<K extends string, V extends object>(key: K, value: V) {
  return Object.keys(value).length > 0
    ? ({ [key]: value } as Record<K, V>)
    : {};
}

function requiredString(
  value: unknown,
  maxLength = Number.POSITIVE_INFINITY,
): string | null {
  return typeof value === "string" && value.trim() && value.length <= maxLength
    ? value
    : null;
}
