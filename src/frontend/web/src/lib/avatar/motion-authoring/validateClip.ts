import {
  ANIMA_POSE_CLIP_V2_SCHEMA,
  MAX_ANIMA_POSE_CLIP_BYTES,
  serializeAnimaPoseClipFile,
  validateAnimaPoseClipV2,
  type AnimaPoseClipV2,
  type AnimaPoseClipV2Issue,
} from "../poses/animaPoseClip";
import {
  JOINT_DEFINITIONS,
  resolveJoint,
  type JointComponentDefinition,
} from "../poses/anatomy/anatomy";
import { isRecord } from "@/lib/records";

/**
 * The authoring validation of an `animaPoseClip/2.0` clip, shared by
 * `pnpm animation validate`, the Included promotion tool and the app's draft
 * checks. It runs in Node, in a page and in a worker, so it imports nothing
 * from Node.
 */

/** One problem in a clip, by JSON path (`$` is the whole clip). */
export type ClipIssue = AnimaPoseClipV2Issue;

/** A valid clip with the compact file the creator saves, or its problems. */
export type ClipValidation =
  | {
      ok: true;
      loadable: true;
      /** Always empty; present so callers read one shape. */
      issues: ClipIssue[];
      clip: AnimaPoseClipV2;
      saved: string;
      savedBytes: number;
    }
  | {
      ok: false;
      /**
       * Whether the app can still load and play the clip: its structure is
       * valid and its file is within the size the app loads. The app's loader
       * does not apply the anatomical limits, so a clip that only exceeds
       * those plays, and the motion checks can measure it.
       */
      loadable: boolean;
      issues: ClipIssue[];
      /** The issues as the text `animation validate` prints. */
      message: string;
    };

/**
 * Validate a 2.0 clip (structure, anatomical limits and saved size) and
 * serialize the file the creator saves. Never throws on malformed input.
 */
export function validateClip(value: unknown): ClipValidation {
  const result = validateAnimaPoseClipV2(value);
  // Both kinds of problem at once, so one run lists everything to fix.
  const issues = [
    ...(result.ok ? [] : result.issues),
    ...anatomicalLimitIssues(value),
  ];
  if (!result.ok) return invalid(issues, false);
  const saved = serializeAnimaPoseClipFile(result.clip);
  const savedBytes = new TextEncoder().encode(saved).byteLength;
  const tooLarge = savedBytes > MAX_ANIMA_POSE_CLIP_BYTES;
  if (issues.length > 0) return invalid(issues, !tooLarge);
  if (tooLarge) {
    const message = `Too large: the clip saves as ${formatKilobytes(savedBytes)}, over the ${formatKilobytes(MAX_ANIMA_POSE_CLIP_BYTES)} the app will load.`;
    return {
      ok: false,
      loadable: false,
      issues: [{ path: "$", message }],
      message,
    };
  }
  return {
    ok: true,
    loadable: true,
    issues,
    clip: result.clip,
    saved,
    savedBytes,
  };
}

function invalid(issues: ClipIssue[], loadable: boolean): ClipValidation {
  return {
    ok: false,
    loadable,
    issues,
    message:
      `Invalid ${ANIMA_POSE_CLIP_V2_SCHEMA} (${issues.length} issue(s)):\n` +
      issues.map(({ path, message }) => `  ${path}: ${message}`).join("\n"),
  };
}

/**
 * Joint values beyond each component's hard (anatomical) limit. Reads the
 * raw clip, so it also reports clips with structural problems.
 */
export function anatomicalLimitIssues(value: unknown): ClipIssue[] {
  const issues: ClipIssue[] = [];
  const joints = isRecord(value) && isRecord(value.joints) ? value.joints : {};
  for (const [jointId, components] of Object.entries(joints)) {
    const joint = resolveJoint(jointId);
    if (!joint || !isRecord(components)) continue;
    const definitions = JOINT_DEFINITIONS[joint.type].components as Record<
      string,
      JointComponentDefinition
    >;
    for (const [name, keys] of Object.entries(components)) {
      if (!Object.hasOwn(definitions, name) || !Array.isArray(keys)) continue;
      const [min, max] = definitions[name].hard;
      keys.forEach((key: unknown, index) => {
        const v = isRecord(key) ? key.v : undefined;
        if (typeof v === "number" && (v < min || v > max))
          issues.push({
            path: `joints.${jointId}.${name}[${index}].v`,
            message: `${v}° is beyond the anatomical limit ${min}..${max}.`,
          });
      });
    }
  }
  return issues;
}

/** A byte count as whole kilobytes, as the validation messages word sizes. */
export function formatKilobytes(bytes: number): string {
  return `${Math.round(bytes / 1024)} KB`;
}
