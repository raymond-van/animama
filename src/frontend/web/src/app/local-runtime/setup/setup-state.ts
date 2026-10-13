import type {
  PyModelConnection,
  PyModelConnectionDetection,
  PyModelProviderCatalogItem,
} from "@animama/runtime-contracts/api-types";
import {
  SETUP_STEPS,
  type SetupDraft,
  type SetupModelLocation,
  type SetupStep,
  type SetupTtsProvider,
} from "@/app/local-runtime/setup-draft";
import {
  ANTHROPIC_DEFAULT_MODEL_ID,
  ANTHROPIC_MESSAGES_PROVIDER_TYPE,
  RESPONSES_PROVIDER_TYPE,
  alternateModelIds,
  modelDisplayName,
} from "@/lib/chat/model-catalog";
import type { SpeechPreferences } from "@/lib/settings/preferences";
import type { TtsProviderOption } from "@/lib/speech/tts-provider";
import {
  connectionLocation,
  roleCandidates,
} from "@/ui/settings/models/model-configuration-state";

/** Step labels for the progress list and its "Step 2 of 3" line. */
export const SETUP_STEP_LABELS: Record<SetupStep, string> = {
  welcome: "Welcome",
  ai: "AI",
  voice: "Voice",
};

/** "Step 2 of 3" for a step. */
export function setupStepPosition(step: SetupStep): string {
  return `Step ${SETUP_STEPS.indexOf(step) + 1} of ${SETUP_STEPS.length}`;
}

/** The neighbouring step, or null at either end. */
export function adjacentSetupStep(
  step: SetupStep,
  direction: 1 | -1,
): SetupStep | null {
  return SETUP_STEPS[SETUP_STEPS.indexOf(step) + direction] ?? null;
}

/** The built-in connections whose key the AI step takes. */
export type SetupBuiltinProvider = "openai" | "anthropic";

/** A built-in connection, found by its preset; each built-in has its own. */
export function builtinConnectionOf<
  C extends Pick<PyModelConnection, "source" | "preset">,
>(connections: readonly C[], preset: SetupBuiltinProvider): C | undefined {
  return connections.find(
    (connection) =>
      connection.source === "builtin" && connection.preset === preset,
  );
}

/** A built-in provider's key state and the model saving its key chooses. */
export type SetupBuiltin = {
  provider: SetupBuiltinProvider;
  /** Its key is set (in the desktop vault or the server environment). */
  ready: boolean;
  /** The model saving its key chooses, while the key is set; else null. */
  modelId: string | null;
};

/**
 * The AI step's built-in providers. Saving OpenAI's key chooses its default
 * Responses model and saving Anthropic's chooses Claude Haiku 5.5, each only
 * while its connection offers that model for chat.
 */
export function setupBuiltins(
  items: readonly PyModelProviderCatalogItem[],
  connections: readonly PyModelConnection[],
  systemDefaultId: string | null | undefined,
): Record<SetupBuiltinProvider, SetupBuiltin> {
  const builtin = (
    provider: SetupBuiltinProvider,
    model: PyModelProviderCatalogItem | null,
  ): SetupBuiltin => {
    const ready =
      builtinConnectionOf(connections, provider)?.credential_state ===
      "configured";
    return { provider, ready, modelId: ready ? (model?.id ?? null) : null };
  };
  return {
    openai: builtin(
      "openai",
      openAiDefaultModel(items, connections, systemDefaultId),
    ),
    anthropic: builtin("anthropic", anthropicDefaultModel(items, connections)),
  };
}

/** A chat model on one of the owner's connections, as the AI step tracks it. */
export type SetupModelChoice = {
  id: string;
  label: string;
  connectionName: string;
};

/**
 * The model saving the OpenAI key chooses: the built-in OpenAI Responses chat
 * model the system uses by default (`systemDefaultId`, from the Chat role), or
 * else the first visible one. Null when the catalog has none.
 */
export function openAiDefaultModel(
  items: readonly PyModelProviderCatalogItem[],
  connections: readonly PyModelConnection[],
  systemDefaultId: string | null | undefined,
): PyModelProviderCatalogItem | null {
  const openAi = builtinConnectionOf(connections, "openai");
  const candidates = roleCandidates(items, "chat").filter(
    (item) =>
      openAi !== undefined &&
      item.connection_id === openAi.id &&
      item.model_provider === RESPONSES_PROVIDER_TYPE,
  );
  return (
    candidates.find((item) => item.id === systemDefaultId) ??
    candidates[0] ??
    null
  );
}

/**
 * The model saving the Anthropic key chooses: Claude Haiku 5.5, Anthropic's
 * default, when the built-in Anthropic connection offers it for chat. The
 * application default stays OpenAI's.
 */
export function anthropicDefaultModel(
  items: readonly PyModelProviderCatalogItem[],
  connections: readonly PyModelConnection[],
): PyModelProviderCatalogItem | null {
  const anthropic = builtinConnectionOf(connections, "anthropic");
  return (
    roleCandidates(items, "chat").find(
      (item) =>
        anthropic !== undefined &&
        item.connection_id === anthropic.id &&
        item.model_provider === ANTHROPIC_MESSAGES_PROVIDER_TYPE &&
        item.id === ANTHROPIC_DEFAULT_MODEL_ID,
    ) ?? null
  );
}

/**
 * Chat models on the owner's own connections in one location, which the AI
 * step can have chosen by adding them. Built-in models are chosen only by
 * saving their provider's key.
 */
export function ownerModelChoices(
  items: readonly PyModelProviderCatalogItem[],
  connections: readonly PyModelConnection[],
  location: SetupModelLocation,
): SetupModelChoice[] {
  const byId = new Map(
    connections.map((connection) => [connection.id, connection]),
  );
  const listed = roleCandidates(items, "chat").filter((item) => {
    const connection = byId.get(item.connection_id ?? "");
    return (
      connection !== undefined &&
      connection.source !== "builtin" &&
      connectionLocation(connection) === location
    );
  });
  const alternates = alternateModelIds(listed);
  return listed.map((item) => ({
    id: item.id,
    label: modelDisplayName(item, alternates.has(item.id)),
    connectionName: byId.get(item.connection_id ?? "")?.name ?? "",
  }));
}

/**
 * Models a running server lists that are not yet added to Animama, so the
 * AI step can offer to add them. An existing connection to the same address
 * already lists its added models as choices.
 */
export function detectedModelsToAdd(
  detection: PyModelConnectionDetection,
  connections: readonly PyModelConnection[],
): string[] {
  const added = new Set(
    connections
      .filter(
        (connection) =>
          connection.preset === detection.preset &&
          sameBaseUrl(connection.base_url, detection.base_url),
      )
      .flatMap((connection) => connection.models ?? [])
      .map((model) => model.model),
  );
  return detection.models.filter((model) => !added.has(model));
}

/** The owner's connection to a detected server, if one exists. */
export function connectionForDetection(
  detection: PyModelConnectionDetection,
  connections: readonly PyModelConnection[],
): PyModelConnection | undefined {
  return connections.find(
    (connection) =>
      connection.source !== "builtin" &&
      connection.preset === detection.preset &&
      sameBaseUrl(connection.base_url, detection.base_url),
  );
}

function sameBaseUrl(left: string | null | undefined, right: string): boolean {
  const normalize = (value: string) => value.trim().replace(/\/+$/u, "");
  return normalize(left ?? "") === normalize(right);
}

/**
 * The Voice step's Text-to-Speech provider: the owner's choice in this setup,
 * else the saved preference, else built-in voices.
 */
export function resolveSetupTtsProvider(
  draft: Pick<SetupDraft, "ttsProvider">,
  saved: SpeechPreferences | null | undefined,
): SetupTtsProvider {
  const savedProvider =
    saved?.tts_provider === "elevenlabs" || saved?.tts_provider === "pocket_tts"
      ? saved.tts_provider
      : null;
  return draft.ttsProvider ?? savedProvider ?? "pocket_tts";
}

/**
 * The speech preferences Finish merges into the saved ones, or null when the
 * owner kept the default provider. Text-to-Speech is on by default, so a
 * choice always keeps it on.
 */
export function setupTtsPatch(
  draft: Pick<SetupDraft, "ttsProvider">,
): Pick<SpeechPreferences, "tts_enabled" | "tts_provider"> | null {
  if (draft.ttsProvider === null) return null;
  return { tts_enabled: true, tts_provider: draft.ttsProvider };
}

/**
 * Setup's two provider tabs, with availability from App Settings' options.
 * A `source` names the model, linked to its public page, ahead of the
 * description.
 */
export function setupTtsOptions(options: readonly TtsProviderOption[]): Array<{
  id: SetupTtsProvider;
  label: string;
  source?: { name: string; href: string };
  description: string;
  disabled: boolean;
  reason?: string;
}> {
  const find = (id: SetupTtsProvider) =>
    options.find((option) => option.id === id);
  const pocket = find("pocket_tts");
  const elevenlabs = find("elevenlabs");
  return [
    {
      id: "pocket_tts",
      label: "PocketTTS (built-in)",
      source: {
        name: "Kyutai's Pocket TTS",
        href: "https://github.com/kyutai-labs/pocket-tts",
      },
      description:
        "speaks replies on this computer, with no key or account needed.",
      disabled: pocket?.disabled ?? true,
      reason: pocket?.reason,
    },
    {
      id: "elevenlabs",
      label: "ElevenLabs",
      description: "Cloud voices with your ElevenLabs API key.",
      disabled: elevenlabs?.disabled ?? true,
      reason: elevenlabs?.reason,
    },
  ];
}
