import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Quaternion } from "three";

import {
  ANIMA_POSE_CLIP_V2_SCHEMA,
  MAX_ANIMA_POSE_CLIP_BYTES,
  parseAnimaPoseClip,
  type AnimaPoseClipV2,
} from "../poses/animaPoseClip";
import { RELAXED_REST_POSE_ID, getResolvedAvatarPose } from "../poses/catalog";
import {
  JOINT_DEFINITIONS,
  JOINT_IDS,
  decomposeJointRotation,
  resolveJoint,
  type JointComponentDefinition,
} from "../poses/anatomy/anatomy";
import { checkMotion, formatMotionCheckReport } from "./checks";
import {
  INCLUDED_AVATAR_FILES,
  loadHeadlessVrm,
  type IncludedAvatarId,
} from "./headlessVrm";
import {
  loadReviewSidecar,
  resolveReviewNote,
  retainReviewVersion,
  reviewPathsFor,
  saveReviewSidecar,
  type ReviewSidecar,
} from "./preview/reviewNotes";
import {
  RETIRED_DESCRIPTION_MESSAGE,
  RETIRED_DESCRIPTION_SCHEMA,
  sourceVersion,
} from "./preview/sources";
import {
  formatKilobytes,
  validateClip,
  type ClipValidation,
} from "./validateClip";

export type MotionCliContext = {
  /** Directory holding the Included `.vrm` files. */
  avatarDirectory: string;
  /** Working directory for relative paths. */
  cwd: string;
  out: (text: string) => void;
  /**
   * The version of a reviewed file whose version is not its text hash (an
   * Avatar Effect covers its images too, as the preview's does), or null.
   */
  fileVersion?: (file: string) => Promise<string | null>;
};

const USAGE = `Usage: pnpm animation <command>

Commands:
  joints                      List joints, components, meanings and ranges.
  base                        Print the base pose (Relaxed Rest) as joint values.
  validate <clip.json> [--out <compact.json>]
                              Validate an animaPoseClip/2.0 clip: structure,
                              anatomical limits and saved size. --out writes
                              the compact file the creator saves, only when valid.
  check <clip.json> [--json]  Run the motion checks on both Included Avatars.
                              A 2.0 clip supplies its contacts and plantFeet.
  review <notes.review.json>  List preview review notes with their ids and status.
  resolve <notes.review.json> <note id> <resolution>
                              Mark a note resolved by the reviewed source's
                              current version (run after changing the source).
  promote <items.json> [--dry-run]
                              Promote owner-approved Gestures to Included
                              content (owner approval and a PR required).`;

/** Run a motion-authoring command. Returns the process exit code. */
export async function runMotionCli(
  argv: readonly string[],
  context: MotionCliContext,
): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "joints":
      context.out(formatJointTable());
      return 0;
    case "base":
      context.out(JSON.stringify(baseJointValues(), null, 2));
      return 0;
    case "validate":
      return validate(rest, context);
    case "check":
      return check(rest, context);
    case "review":
      return review(rest, context);
    case "resolve":
      return resolve(rest, context);
    default:
      context.out(USAGE);
      return command === undefined || command === "help" ? 0 : 2;
  }
}

async function validate(
  args: readonly string[],
  context: MotionCliContext,
): Promise<number> {
  const input = args[0];
  const options = parseOptions(args.slice(1), ["--out"]);
  if (!input || "error" in options) {
    context.out(`${"error" in options ? `${options.error}\n\n` : ""}${USAGE}`);
    return 2;
  }
  const read = await readJson(input, context);
  if ("error" in read) {
    context.out(read.error);
    return 1;
  }
  const compacted = compactClipFile(read.value);
  if (!compacted.ok) {
    context.out(compacted.message);
    return 1;
  }
  const { clip, saved, savedBytes } = compacted;
  const outputPath = options.values["--out"]
    ? path.resolve(context.cwd, options.values["--out"])
    : null;
  if (outputPath) await writeFile(outputPath, saved);
  const tracks = countTracks(clip);
  context.out(
    [
      `Valid ${input}${outputPath ? `; wrote ${displayPath(outputPath, context.cwd)}` : ""}`,
      `  id ${clip.id}, ${clip.duration}s, ${clip.loop ? "loop" : "one-shot"}, ${clip.beats.length} beats: ${clip.beats.map(({ label }) => label).join(", ")}`,
      `  ${tracks.tracks} tracks, ${tracks.keys} keys; expressions: ${Object.keys(clip.expressions ?? {}).join(", ") || "none"}`,
      `  planted feet: ${clip.plantFeet ? "yes" : "no"}; contacts: ${clip.contacts?.length ?? 0}`,
      `  saved size: ${formatKilobytes(savedBytes)} of ${formatKilobytes(MAX_ANIMA_POSE_CLIP_BYTES)}`,
      `  muted layers: ${clip.mutedProceduralLayers?.join(", ") || "none"}`,
    ].join("\n"),
  );
  return 0;
}

/**
 * Validate a 2.0 clip and serialize the file the creator saves
 * (`validateClip`), after turning away a retired motion description with the
 * command line's own message. Shared by `validate --out` and the Included
 * promotion tool, so both write the same bytes.
 */
export function compactClipFile(value: unknown): ClipValidation {
  if (schemaOf(value) === RETIRED_DESCRIPTION_SCHEMA)
    return {
      ok: false,
      loadable: false,
      issues: [{ path: "schema", message: RETIRED_DESCRIPTION_MESSAGE }],
      message: RETIRED_DESCRIPTION_MESSAGE,
    };
  return validateClip(value);
}

function countTracks(clip: AnimaPoseClipV2): { tracks: number; keys: number } {
  const groups = [
    ...Object.values(clip.joints ?? {}),
    clip.rotations ?? {},
    clip.hipsPosition ?? {},
    clip.hands ?? {},
    clip.expressions ?? {},
  ];
  let tracks = 0;
  let keys = 0;
  for (const group of groups)
    for (const track of Object.values(group) as unknown[][]) {
      tracks += 1;
      keys += track.length;
    }
  return { tracks, keys };
}

function schemaOf(value: unknown): unknown {
  return typeof value === "object" && value !== null
    ? (value as { schema?: unknown }).schema
    : undefined;
}

async function review(
  args: readonly string[],
  context: MotionCliContext,
): Promise<number> {
  if (args.length !== 1) {
    context.out(USAGE);
    return 2;
  }
  const loaded = await loadExistingSidecar(args[0], context);
  if (!loaded) return 1;
  context.out(formatReviewNotes(loaded.sidecar));
  return 0;
}

async function resolve(
  args: readonly string[],
  context: MotionCliContext,
): Promise<number> {
  const [file, id, ...words] = args;
  const resolution = words.join(" ").trim();
  if (!file || !id || !resolution) {
    context.out(USAGE);
    return 2;
  }
  const loaded = await loadExistingSidecar(file, context);
  if (!loaded) return 1;
  const { sidecar, sidecarPath } = loaded;
  const sourcePath = path.resolve(path.dirname(sidecarPath), sidecar.source);
  let text: string;
  try {
    text = await readFile(sourcePath, "utf8");
  } catch (error) {
    context.out(`Cannot read the reviewed source: ${(error as Error).message}`);
    return 1;
  }
  // A broken effect falls back to its descriptor text, so it still resolves.
  const version =
    (await context.fileVersion?.(sourcePath).catch(() => null)) ??
    sourceVersion(text);
  const note = sidecar.notes.find((candidate) => candidate.id === id);
  if (!note) {
    context.out(`No review note "${id}". Run review to list them.`);
    return 1;
  }
  if (note.version === version)
    context.out(
      `Note: ${displayPath(sourcePath, context.cwd)} has not changed since this note was made.`,
    );
  const paths = reviewPathsFor(
    { kind: "file", path: sourcePath, name: "" },
    { cwd: context.cwd, notes: sidecarPath },
  );
  // Retain the resolving version so the preview can compare it.
  const next = resolveReviewNote(
    await retainReviewVersion(sidecar, paths, version, text),
    id,
    resolution,
    { version },
  );
  await saveReviewSidecar(sidecarPath, next);
  context.out(`Resolved ${id} with source version ${version}.`);
  return 0;
}

async function loadExistingSidecar(
  file: string,
  context: MotionCliContext,
): Promise<{ sidecar: ReviewSidecar; sidecarPath: string } | null> {
  const sidecarPath = path.resolve(context.cwd, file);
  try {
    await readFile(sidecarPath);
    return {
      sidecar: await loadReviewSidecar(sidecarPath, ""),
      sidecarPath,
    };
  } catch (error) {
    context.out(
      (error as NodeJS.ErrnoException).code === "ENOENT"
        ? `No review notes at ${file}.`
        : (error as Error).message,
    );
    return null;
  }
}

function formatReviewNotes(sidecar: ReviewSidecar): string {
  const open = sidecar.notes.filter(({ status }) => status === "open").length;
  return [
    `${sidecar.source}: ${open} open, ${sidecar.notes.length - open} resolved`,
    ...[...sidecar.notes]
      .sort((a, b) => a.time - b.time)
      .flatMap((note) => [
        `  ${note.id}  ${note.status.padEnd(8)} ${note.time.toFixed(2)}s${note.beat ? ` · ${note.beat}` : ""}${note.region ? ` · ${note.region}` : ""}  ${note.text}`,
        ...(note.resolution ? [`      → ${note.resolution}`] : []),
      ]),
  ].join("\n");
}

/** Accept only the named `--flag value` options; anything else is an error. */
function parseOptions(
  args: readonly string[],
  names: readonly string[],
): { values: Record<string, string> } | { error: string } {
  const values: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!names.includes(name)) return { error: `Unknown option ${name}.` };
    if (value === undefined || value.startsWith("--"))
      return { error: `${name} needs a value.` };
    values[name] = value;
  }
  return { values };
}

function displayPath(file: string, cwd: string): string {
  const relative = path.relative(cwd, file);
  return relative.startsWith("..") ? file : relative;
}

async function readJson(
  file: string,
  context: MotionCliContext,
): Promise<{ value: unknown } | { error: string }> {
  try {
    return {
      value: JSON.parse(
        await readFile(path.resolve(context.cwd, file), "utf8"),
      ),
    };
  } catch (error) {
    return { error: `Cannot read ${file}: ${(error as Error).message}` };
  }
}

async function check(
  args: readonly string[],
  context: MotionCliContext,
): Promise<number> {
  const input = args[0];
  const unknown = args.slice(1).find((arg) => arg !== "--json");
  if (!input || unknown) {
    context.out(`${unknown ? `Unknown option ${unknown}.\n\n` : ""}${USAGE}`);
    return 2;
  }
  const read = await readJson(input, context);
  if ("error" in read) {
    context.out(read.error);
    return 1;
  }
  if (schemaOf(read.value) === RETIRED_DESCRIPTION_SCHEMA) {
    context.out(RETIRED_DESCRIPTION_MESSAGE);
    return 1;
  }
  let clip;
  try {
    clip = parseAnimaPoseClip(read.value);
  } catch (error) {
    context.out(
      `Cannot check ${input}: ${(error as Error).message}.${schemaOf(read.value) === ANIMA_POSE_CLIP_V2_SCHEMA ? " Run validate for details." : ""}`,
    );
    return 1;
  }
  const avatars = await Promise.all(
    (Object.keys(INCLUDED_AVATAR_FILES) as IncludedAvatarId[]).map(
      async (id) => ({ id, vrm: await loadAvatar(id, context) }),
    ),
  );
  const report = checkMotion(clip, avatars);
  context.out(
    args.includes("--json")
      ? JSON.stringify(report, null, 2)
      : formatMotionCheckReport(report),
  );
  return report.ok ? 0 : 1;
}

export async function loadAvatar(
  id: IncludedAvatarId,
  context: Pick<MotionCliContext, "avatarDirectory">,
) {
  const file = await readFile(
    path.join(context.avatarDirectory, INCLUDED_AVATAR_FILES[id]),
  );
  return loadHeadlessVrm(
    file.buffer.slice(
      file.byteOffset,
      file.byteOffset + file.byteLength,
    ) as ArrayBuffer,
  );
}

function baseJointValues(): Record<string, Record<string, number>> {
  const base = getResolvedAvatarPose(RELAXED_REST_POSE_ID).humanoid ?? {};
  return Object.fromEntries(
    JOINT_IDS.map((id) => {
      const joint = resolveJoint(id)!;
      const rotation = base[joint.bones[0]]?.rotation;
      const values = decomposeJointRotation(
        joint,
        rotation ? new Quaternion(...rotation) : new Quaternion(),
      );
      return [
        id,
        Object.fromEntries(
          Object.entries(values).map(([name, value]) => [
            name,
            Math.round(value * 10) / 10,
          ]),
        ),
      ];
    }),
  );
}

function formatJointTable(): string {
  const lines: string[] = [];
  for (const [type, definition] of Object.entries(JOINT_DEFINITIONS)) {
    const ids = JOINT_IDS.filter((id) => resolveJoint(id)!.type === type);
    lines.push(`${ids.join(", ")}`);
    for (const [name, component] of Object.entries(definition.components) as [
      string,
      JointComponentDefinition,
    ][])
      lines.push(
        component.auxiliary
          ? `  ${name} (auxiliary, leave at base): ${component.description}`
          : `  ${name}: ${component.description} Natural ${component.soft[0]}..${component.soft[1]}, limit ${component.hard[0]}..${component.hard[1]}.`,
      );
  }
  return lines.join("\n");
}
