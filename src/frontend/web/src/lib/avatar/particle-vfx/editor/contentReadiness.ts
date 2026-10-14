import { getUnsupportedAdvancedBehaviorLabels } from "./advancedBehaviors";
import { readJsonObject } from "./json";
import { PARTICLE_VFX_EDITOR_TEXTURES } from "./constants";
import { estimateParticleVFXParticles } from "./particleEstimate";
import { validateParticleVFXEditorDraft } from "./validation";
import type {
  JsonObject,
  ParticleVFXContentReadiness,
  ParticleVFXEditorDraft,
  ParticleVFXEditorValidationIssue,
} from "./types";

const MAX_MANIFEST_BYTES = 5 * 1024 * 1024;
/** Most emitters (Quarks particle systems) one Particle Effect may carry. */
export const PARTICLE_VFX_MAX_EMITTERS = 16;
const MAX_RESOURCES = 64;
const MAX_NODES = 128;
const MAX_TEXTURES = 16;
/** Longest maximum duration a private Particle Effect may declare. */
export const PARTICLE_VFX_MAX_DURATION_SECONDS = 30;
/** Most particles a private Particle Effect may declare or be estimated at. */
export const PARTICLE_VFX_MAX_PARTICLES = 512;
const MAX_DURATION_SECONDS = PARTICLE_VFX_MAX_DURATION_SECONDS;
const MAX_PARTICLES = PARTICLE_VFX_MAX_PARTICLES;
const RUNTIME_ID_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

export type ParticleVFXContentReadinessOptions = {
  /** Exact logical references whose bytes can be included in the package. */
  resolvableTextureReferences?: ReadonlySet<string>;
  /** Exact retained App references that the package builder will normalize. */
  trustedLegacyTextureReferences?: ReadonlySet<string>;
};

/**
 * Apply the browser-visible portion of the private Particle Effect contract.
 *
 * The backend remains authoritative. This check prevents allocating an upload
 * draft for known-invalid creator output and deliberately excludes transport
 * concerns such as canonical image byte validation.
 */
export function validateParticleVFXContentReadiness(
  draft: ParticleVFXEditorDraft,
  options: ParticleVFXContentReadinessOptions = {},
): ParticleVFXContentReadiness {
  const issues = validateParticleVFXEditorDraft(draft).map(
    promoteContentBlockingIssue,
  );
  const push = (
    code: ParticleVFXEditorValidationIssue["code"],
    message: string,
    target: string,
  ) => issues.push({ severity: "error", code, message, target });
  const serialized = JSON.stringify(draft.quarksJson);
  const estimatedManifestBytes = new TextEncoder().encode(serialized).length;

  if (
    draft.catalog.id.length > 64 ||
    !RUNTIME_ID_PATTERN.test(draft.catalog.id)
  ) {
    push(
      "asset-runtime-id",
      "Runtime ID must use lowercase letters, numbers, single hyphens, or underscores.",
      "catalog.id",
    );
  }
  if (estimatedManifestBytes > MAX_MANIFEST_BYTES) {
    push(
      "asset-manifest-limit",
      "Particle VFX manifest exceeds the 5 MiB content limit.",
      "json",
    );
  }

  const resourceKeys = ["geometries", "materials", "textures", "images"];
  for (const key of resourceKeys) {
    const resources = draft.quarksJson[key];
    if (!Array.isArray(resources) || resources.length > MAX_RESOURCES) {
      push(
        "asset-resource-limit",
        `${key} must be an array with no more than ${MAX_RESOURCES} entries.`,
        key,
      );
    }
  }

  const { nodeCount, systemCount, unsupportedNode } = inspectNodes(
    draft.quarksJson.object,
  );
  if (nodeCount > MAX_NODES) {
    push(
      "asset-node-limit",
      `Particle VFX contains more than ${MAX_NODES} object nodes.`,
      "object",
    );
  }
  if (systemCount < 1 || systemCount > PARTICLE_VFX_MAX_EMITTERS) {
    push(
      "asset-system-limit",
      `Particle VFX must contain between 1 and ${PARTICLE_VFX_MAX_EMITTERS} emitters.`,
      "object.children",
    );
  }
  if (unsupportedNode) {
    push(
      "unsupported-asset-structure",
      "Private Particle Effects support only Group and ParticleEmitter nodes.",
      "object",
    );
  }

  const images = Array.isArray(draft.quarksJson.images)
    ? draft.quarksJson.images
    : [];
  const uniqueTextureReferences: string[] = [];
  const seenReferences = new Set<string>();
  const basenames = new Map<string, string>();
  const curated = new Set(
    PARTICLE_VFX_EDITOR_TEXTURES.map((texture) =>
      normalizeLogicalReference(texture.relativeUrl),
    ).filter((value): value is string => value !== null),
  );
  const resolvable = options.resolvableTextureReferences ?? curated;
  for (const [index, rawImage] of images.entries()) {
    const url = readJsonObject(rawImage)?.url;
    if (typeof url !== "string") continue;
    const logicalReference =
      normalizeLogicalReference(url) ??
      (options.trustedLegacyTextureReferences?.has(url) ? url : null);
    if (!logicalReference) {
      push(
        "unsafe-texture-reference",
        "Asset textures must use a safe package-relative path.",
        `images.${index}.url`,
      );
      continue;
    }
    const basename = logicalReference.split("/").at(-1) ?? logicalReference;
    const portableName = basename.normalize("NFC").toLocaleLowerCase("en-US");
    const priorReference = basenames.get(portableName);
    if (priorReference && priorReference !== logicalReference) {
      push(
        "ambiguous-texture-filename",
        `Texture paths ${priorReference} and ${logicalReference} share one portable filename.`,
        `images.${index}.url`,
      );
    } else {
      basenames.set(portableName, logicalReference);
    }
    if (!seenReferences.has(logicalReference)) {
      seenReferences.add(logicalReference);
      uniqueTextureReferences.push(logicalReference);
    }
    if (!resolvable.has(logicalReference)) {
      push(
        "unresolved-texture",
        `Texture ${logicalReference} is not available to the content entry.`,
        `images.${index}.url`,
      );
    }
  }
  if (uniqueTextureReferences.length > MAX_TEXTURES) {
    push(
      "asset-resource-limit",
      `Particle VFX references more than ${MAX_TEXTURES} unique textures.`,
      "images",
    );
  }

  const maximumDuration = draft.catalog.performanceBudget.maxDurationSec;
  if (
    !Number.isFinite(maximumDuration) ||
    maximumDuration <= 0 ||
    maximumDuration > MAX_DURATION_SECONDS ||
    draft.catalog.defaultDurationSec <= 0 ||
    draft.catalog.defaultDurationSec > maximumDuration
  ) {
    push(
      "invalid-runtime-defaults",
      "Default duration must be positive and no greater than a 30-second maximum duration.",
      "catalog.performanceBudget.maxDurationSec",
    );
  }
  if (
    draft.emitters.some(
      (emitter) =>
        emitter.durationSec === null ||
        emitter.durationSec > maximumDuration ||
        emitter.durationSec > MAX_DURATION_SECONDS,
    )
  ) {
    push(
      "asset-duration-limit",
      "Every emitter duration must fit the saved maximum duration budget.",
      "emitters",
    );
  }
  if (
    draft.emitters.some((emitter) => emitter.looping) &&
    !draft.catalog.performanceBudget.loopingAllowed
  ) {
    push(
      "asset-looping-metadata",
      "A looping emitter requires looping to be allowed in runtime defaults.",
      "catalog.performanceBudget.loopingAllowed",
    );
  }
  // The editor's check (promoted above) reports an estimate over the saved
  // budget; this adds the private limit.
  const estimatedParticles = estimateParticleVFXParticles(draft.quarksJson);
  const budget = draft.catalog.performanceBudget.maxParticles;
  if (
    budget > MAX_PARTICLES ||
    (Number.isFinite(estimatedParticles) && estimatedParticles > MAX_PARTICLES)
  ) {
    push(
      "particle-budget-exceeded",
      `Estimated ${estimatedParticles} particles with a saved budget of ${budget}: both must fit the ${MAX_PARTICLES}-particle private limit.`,
      "catalog.performanceBudget.maxParticles",
    );
  }

  for (const emitter of draft.emitters) {
    const target = `emitter:${emitter.name}`;
    if (
      emitter.shape.type === "unsupported" ||
      !Number.isInteger(emitter.renderer.renderMode) ||
      emitter.renderer.renderMode < 0 ||
      emitter.renderer.renderMode > 5 ||
      emitter.startLife === null ||
      emitter.startSpeed === null ||
      emitter.startSize === null ||
      emitter.startRotation === null ||
      emitter.emissionOverTime === null ||
      emitter.emissionOverDistance === null ||
      emitter.startColorGenerator.mode === "unsupported" ||
      emitter.colorOverLife.mode === "unsupported" ||
      emitter.frameOverLife.mode === "unsupported" ||
      getUnsupportedAdvancedBehaviorLabels(emitter.advancedBehaviors).length > 0
    ) {
      push(
        "unsupported-asset-structure",
        "This emitter preserves settings outside the portable creator contract.",
        target,
      );
    }
  }

  return {
    ready: !issues.some((issue) => issue.severity === "error"),
    issues,
    uniqueTextureReferences,
    estimatedManifestBytes,
  };
}

function promoteContentBlockingIssue(
  issue: ParticleVFXEditorValidationIssue,
): ParticleVFXEditorValidationIssue {
  return issue.code === "embedded-texture-url" ||
    issue.code === "unsupported-shape" ||
    issue.code === "unsupported-render-mode" ||
    issue.code === "unsupported-behavior-settings" ||
    issue.code === "duration-over-budget" ||
    issue.code === "particle-budget-exceeded"
    ? { ...issue, severity: "error" }
    : issue;
}

function normalizeLogicalReference(value: string): string | null {
  const normalized = value.trim().replaceAll("\\", "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.includes("?") ||
    normalized.includes("#") ||
    /^(?:data|file|https?|javascript|blob):/i.test(normalized)
  ) {
    return null;
  }
  try {
    if (decodeURIComponent(normalized) !== normalized) return null;
  } catch {
    return null;
  }
  const parts = normalized.split("/");
  return parts.some((part) => !part || part === "." || part === "..")
    ? null
    : parts.join("/");
}

function inspectNodes(value: unknown): {
  nodeCount: number;
  systemCount: number;
  unsupportedNode: boolean;
} {
  let nodeCount = 0;
  let systemCount = 0;
  let unsupportedNode = false;
  const visit = (raw: unknown, depth: number) => {
    const node = readJsonObject(raw);
    if (!node || depth > 64) {
      unsupportedNode = true;
      return;
    }
    nodeCount += 1;
    if (node.type === "ParticleEmitter") systemCount += 1;
    else if (node.type !== "Group") unsupportedNode = true;
    const children =
      node.children === undefined
        ? []
        : Array.isArray(node.children)
          ? node.children
          : null;
    if (!children) {
      unsupportedNode = true;
      return;
    }
    for (const child of children) visit(child, depth + 1);
  };
  visit(value, 0);
  return { nodeCount, systemCount, unsupportedNode };
}

/** Narrow helper used by tests and future package construction. */
export function collectParticleVFXContentReferences(
  quarksJson: JsonObject,
): readonly string[] {
  const images = Array.isArray(quarksJson.images) ? quarksJson.images : [];
  return images.flatMap((image) => {
    const url = readJsonObject(image)?.url;
    const normalized =
      typeof url === "string" ? normalizeLogicalReference(url) : null;
    return normalized ? [normalized] : [];
  });
}
