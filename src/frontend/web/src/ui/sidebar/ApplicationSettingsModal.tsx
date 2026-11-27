import { useProductApiClient } from "@animama/product-ui";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  AudioLines,
  Brain,
  Info,
  Keyboard,
  KeyRound,
  LifeBuoy,
  Palette,
  Settings2,
  Cpu,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { getI18n, useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  localeNativeName,
  SUPPORTED_LOCALES,
} from "@animama/runtime-contracts/locale";
import { SafetySettingsSection } from "@/ui/settings/SafetySettingsSection";
import { WebSearchSettings } from "@/ui/settings/web-search/WebSearchSettings";

import {
  DEFAULT_ELEVENLABS_TTS_MODEL_ID,
  DEFAULT_GEMINI_TTS_MODEL_ID,
  GEMINI_TTS_MODEL_OPTIONS,
  DEFAULT_ANIMAMA_PREFERENCES,
  isParakeetWebgpuPreferred,
  mergePreferences,
  offlineSttEnginePreference,
  toGeminiTtsModelId,
  type ElevenLabsTtsModelId,
  type GeminiTtsModelId,
  type ModelRole,
  type SettingsPreferences,
} from "@/lib/settings/preferences";
import {
  defaultDesktopShortcuts,
  formatDesktopShortcut,
  resolveDesktopShortcuts,
  shortcutFromKeyboardEvent,
  shortcutFromMouseEvent,
  validateDesktopShortcut,
  type DesktopShortcut,
  type DesktopShortcutAction,
  type DesktopShortcutIssue,
  type DesktopShortcutMap,
} from "@/lib/settings/desktop-shortcuts";
import { useDesktopLoginItem } from "@/hooks/useDesktopLoginItem";
import { useDesktopMenuEntry } from "@/hooks/useDesktopMenuEntry";
import { useDesktopUpdates } from "@/hooks/useDesktopUpdates";
import type { AppSettingsRequest } from "@/stores/app-settings-request-store";
import { APPEARANCE_COLOR_TOKENS } from "@/lib/theme/appearance-overrides";
import { BEHAVIOR_FLAGS } from "@/lib/settings/behavior-defaults";
import {
  AboutVersionSetting,
  CopyDiagnosticsSetting,
  OpenLogsSetting,
} from "@/ui/settings/AboutSettings";
import {
  AppBehaviorSetting,
  AutomaticEpisodeProcessingSetting,
  behaviorLabel,
  ResetAppSettingsSetting,
} from "@/ui/settings/BehaviorDataSettings";
import {
  MicrophoneDeviceSetting,
  MicrophoneSensitivitySetting,
  MicrophoneTestSetting,
} from "@/ui/settings/MicrophoneSettings";
import {
  AdvancedColorsToggleSetting,
  AppearanceColorSetting,
  ResetColorsSetting,
  AppearanceModeSetting,
  colorGroupLabel,
  colorTokenLabel,
} from "@/ui/settings/AppearanceSettings";
import { LanguageSetting } from "@/ui/settings/LanguageSetting";
import { SpeechLanguageNotice } from "@/ui/settings/SpeechLanguageNotice";
import { useRuntimePlatform } from "@/platform/RuntimePlatformProvider";
import {
  getSttProviderOptions,
  resolveRoutedSttProvider,
  toSttProvider,
  type SttProvider,
} from "@/lib/speech/stt-provider";
import {
  offlineSpeechAvailable,
  routeOfflineSpeech,
  type OfflineSttEngine,
} from "@/lib/speech/offline-stt/routing";
import {
  recommendedSttChoice,
  availableSttChoices,
  sttChoicePatch,
  type SttChoice,
} from "@/lib/speech/stt-choices";
import {
  OfflineEngineSettingsPanel,
  SttChoiceTabs,
  sttChoiceEngine,
} from "@/ui/settings/speech/SttChoiceTabs";
import {
  getTtsProviderOptions,
  resolvePreferredTtsProvider,
  toTtsProvider,
  type TtsProvider,
} from "@/lib/speech/tts-provider";
import { Switch } from "@/ui/components/switch";
import { Button } from "@/ui/components/button";
import { DialogOverlay } from "@/ui/components/dialog";
import { DisplayNameSettings } from "@/ui/profile/DisplayNameSettings";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/components/select";
import { useSettings } from "@/ui/settings/SettingsProvider";
import {
  DesktopCredentialsPanel,
  useDesktopCredentialsAvailable,
} from "@/ui/settings/DesktopCredentialsPanel";
import { DesktopFeaturePacksPanel } from "@/ui/settings/DesktopFeaturePacksPanel";
import { DesktopUpdatesPanel } from "@/ui/settings/DesktopUpdatesPanel";
import { LaunchAtLoginSetting } from "@/ui/settings/LaunchAtLoginSetting";
import { ApplicationMenuEntrySetting } from "@/ui/settings/ApplicationMenuEntrySetting";
import { VoiceCloneSettings } from "@/ui/settings/VoiceDownloads";
import { ChoiceTabsList } from "@/ui/settings/choice-tabs/ChoiceTabsList";
import { Tabs, TabsContent } from "@/ui/components/tabs";
import {
  getSttSettingsOptions,
  getSttSettingsSelection,
} from "@/lib/speech/stt-settings";
import {
  FLAT_SETTINGS_PANEL_CLASS_NAME,
  SettingsGroup,
  SettingsRow,
} from "@/ui/settings/SettingsLayout";
import { SettingsSearch } from "@/ui/settings/SettingsSearch";
import { ModelConnectionsSettings } from "@/ui/settings/models/ModelConnectionsSettings";
import { modelSettingsAvailability } from "@/ui/settings/models/model-configuration-state";
import {
  ModelDefaultSetting,
  modelDefaultCopy,
} from "@/ui/settings/models/ModelDefaultsSettings";
import {
  availableSettingsSections,
  type SettingsSearchEntry,
} from "@/ui/settings/settings-search";
import { useAutomaticEpisodeProcessingAvailable } from "@/query/hooks/useAutomaticEpisodeProcessing";
import { useRuntimeCapabilities } from "@/query/hooks/useRuntimeCapabilities";
import { fetchRuntimeCapabilities } from "@/query/runtime-capabilities";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/ui/components/tooltip";
import { SectionedModalFrame } from "@/ui/components/sectioned-modal-frame";
import { AudioVolumePanel } from "@/ui/sound/SoundControls";
import { cn } from "@/lib/utils";

type ApplicationSettingsModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * A setting to open at, requested from outside the dialog. It is revealed
   * like a search selection once the setting is offered, then reported
   * through `onRevealed`.
   */
  reveal?: AppSettingsRequest | null;
  onRevealed?: (request: AppSettingsRequest) => void;
};

type ShortcutRecorderProps = {
  label: string;
  description?: string;
  shortcut: DesktopShortcut;
  isRecording: boolean;
  disabled: boolean;
  allowMouseShortcut: boolean;
  onStartRecording: () => void;
  onCancelRecording: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
};

function ShortcutRecorder({
  label,
  description,
  shortcut,
  isRecording,
  disabled,
  allowMouseShortcut,
  onStartRecording,
  onCancelRecording,
  onKeyDown,
}: ShortcutRecorderProps) {
  const { t } = useTranslation("settings");
  const { os } = useRuntimePlatform();
  return (
    <SettingsRow
      label={label}
      description={description}
      control={
        <Button
          type="button"
          variant={isRecording ? "default" : "outline"}
          className={cn(
            "min-h-9 min-w-36 justify-center font-mono text-xs",
            isRecording ? "animate-pulse" : "",
          )}
          disabled={disabled}
          onClick={onStartRecording}
          onBlur={() => {
            if (isRecording) onCancelRecording();
          }}
          onKeyDown={onKeyDown}
          aria-label={t("shortcuts.record", { label })}
        >
          <Keyboard className="h-3.5 w-3.5" />
          {isRecording
            ? allowMouseShortcut
              ? t("shortcuts.pressKeysOrMouse")
              : t("shortcuts.pressKeys")
            : formatDesktopShortcut(shortcut, os, (button) =>
                t("shortcuts.mouseButton", { button }),
              )}
        </Button>
      }
    />
  );
}

/** Display name of a desktop shortcut action. */
function shortcutActionLabel(
  t: TFunction<"settings">,
  action: DesktopShortcutAction,
): string {
  switch (action) {
    case "press_to_talk":
      return t("shortcuts.actions.press_to_talk");
    case "quick_chat":
      return t("shortcuts.actions.quick_chat");
    case "toggle_dictation":
      return t("shortcuts.actions.toggle_dictation");
    case "toggle_voice_mode":
      return t("shortcuts.actions.toggle_voice_mode");
    case "toggle_voice_mute":
      return t("shortcuts.actions.toggle_voice_mute");
    case "skip_tts":
      return t("shortcuts.actions.skip_tts");
    case "toggle_pip":
      return t("shortcuts.actions.toggle_pip");
  }
}

/** Why a recorded shortcut was refused, in the UI Locale. */
function shortcutIssueText(
  t: TFunction<"settings">,
  issue: DesktopShortcutIssue,
): string {
  switch (issue.reason) {
    case "non_modifier_key_required":
      return t("shortcuts.issues.non_modifier_key_required");
    case "modifier_required":
      return t("shortcuts.issues.modifier_required");
    case "unsupported_key":
      return t("shortcuts.issues.unsupported_key");
    case "unsupported_mouse_button":
      return t("shortcuts.issues.unsupported_mouse_button");
    case "mouse_press_to_talk_only":
      return t("shortcuts.issues.mouse_press_to_talk_only");
    case "in_use":
      return t("shortcuts.issues.in_use", {
        action: shortcutActionLabel(t, issue.action),
      });
  }
}

/** Description of a Gemini speech model; model names are product names. */
function geminiModelDescription(
  t: TFunction<"settings">,
  model: GeminiTtsModelId,
): string {
  switch (model) {
    case "gemini-3.8-flash-lite-tts":
      return t("voice.tts.gemini.model.descriptions.flashLite");
    case "gemini-3.8-flash-tts":
      return t("voice.tts.gemini.model.descriptions.flash");
  }
}

/**
 * Failures from the dialog's one-time speech initialization, worded when they
 * happen so the effect does not restart when the UI Locale changes.
 */
function initializationFailureText(
  failure: "capabilities" | "defaultProviders",
): string {
  const t = getI18n().getFixedT(null, "settings");
  return failure === "capabilities"
    ? t("voice.capabilitiesFailed")
    : t("voice.defaultProvidersFailed");
}

const sections = [
  "General",
  "Models",
  "Voice",
  "Shortcuts",
  "Memory & Emotion",
  "Appearance",
  "Safety",
  "API Keys",
  "Advanced",
  "About",
] as const;
type ApplicationSettingsSection = (typeof sections)[number];

/** Catalog keys for section names; section IDs stay stable English identifiers. */
const SECTION_LABEL_KEYS = {
  General: "sections.general",
  Models: "sections.models",
  Appearance: "sections.appearance",
  Voice: "sections.voice",
  Shortcuts: "sections.shortcuts",
  "Memory & Emotion": "sections.memoryEmotion",
  Safety: "sections.safety",
  "API Keys": "sections.apiKeys",
  Advanced: "sections.advanced",
  About: "sections.about",
} as const satisfies Record<ApplicationSettingsSection, string>;

/**
 * Stable setting group IDs. Grouping and group titles key on the ID; the
 * displayed (translated) name comes from `settingGroupLabel`.
 */
type SettingGroupId =
  | "profile"
  | "audio"
  | "startup"
  | "defaultModels"
  | "webSearch"
  | "animama"
  | "diagnostics"
  | "theme"
  | "colors"
  | "advancedColors"
  | "microphone"
  | "speechToText"
  | "textToSpeech"
  | "desktopShortcuts"
  | "animaDefaults"
  | "appData"
  | "messages"
  | "avatarControls"
  | "avatarRendering";

/** Display name of a setting group. */
function settingGroupLabel(
  t: TFunction<"settings">,
  group: SettingGroupId,
): string {
  switch (group) {
    case "profile":
      return t("groups.profile");
    case "audio":
      return t("groups.audio");
    case "startup":
      return t("groups.startup");
    case "defaultModels":
      return t("groups.defaultModels");
    case "webSearch":
      return t("groups.webSearch");
    case "animama":
      return t("groups.animama");
    case "diagnostics":
      return t("groups.diagnostics");
    case "theme":
      return t("appearance.theme.group");
    case "colors":
      return colorGroupLabel(t, "basic");
    case "advancedColors":
      return t("appearance.colors.advanced.label");
    case "microphone":
      return t("groups.microphone");
    case "speechToText":
      return t("groups.speechToText");
    case "textToSpeech":
      return t("groups.textToSpeech");
    case "desktopShortcuts":
      return t("groups.desktopShortcuts");
    case "animaDefaults":
      return t("groups.animaDefaults");
    case "appData":
      return t("groups.appData");
    case "messages":
      return t("groups.messages");
    case "avatarControls":
      return t("groups.avatarControls");
    case "avatarRendering":
      return t("groups.avatarRendering");
  }
}

/** Groups whose name is searchable but not shown as a heading. */
const UNTITLED_GROUPS: ReadonlySet<SettingGroupId> = new Set(["animaDefaults"]);

/** Note shown under a group heading, if the group has one. */
function settingGroupDescription(
  t: TFunction<"settings">,
  group: SettingGroupId,
): string | undefined {
  return group === "desktopShortcuts"
    ? t("shortcuts.groupDescription")
    : undefined;
}

/**
 * One searchable setting. `label`, `description` and `group` hold the displayed
 * (translated) text that search matches, plus English `keywords`. Consecutive
 * entries sharing a `groupId` render inside one SettingsGroup; entries without
 * one render a self-titled panel.
 */
type SettingEntry = SettingsSearchEntry<ApplicationSettingsSection> & {
  id: string;
  groupId?: SettingGroupId;
  /** Hidden entries are neither rendered nor searchable (e.g. unavailable sub-options). */
  hidden?: boolean;
  /** Collapsed entries stay searchable but render only while expanded. */
  collapsed?: boolean;
  render: () => ReactNode;
};

const SECTION_ICONS: Record<ApplicationSettingsSection, LucideIcon> = {
  General: Settings2,
  Models: Cpu,
  Appearance: Palette,
  Voice: AudioLines,
  Shortcuts: Keyboard,
  "Memory & Emotion": Brain,
  Safety: LifeBuoy,
  "API Keys": KeyRound,
  Advanced: SlidersHorizontal,
  About: Info,
};

/** Delay before a search-revealed setting's highlight fades. */
const REVEAL_HIGHLIGHT_MS = 1600;

const SELECT_TRIGGER_CLASS_NAME = "w-56";

/** Search entries for the default model sections in Models. */
const MODEL_DEFAULT_ENTRIES: ReadonlyArray<{
  role: ModelRole;
  id: string;
  keywords: string[];
}> = [
  {
    role: "chat",
    id: "default-chat-model",
    keywords: ["default", "chat model", "new anima", "llm"],
  },
  {
    role: "memory_manager",
    id: "memory-manager-model",
    keywords: ["memory manager", "memory", "tools"],
  },
  {
    role: "utility",
    id: "compaction-model",
    keywords: ["utility", "compaction", "summary", "chat titles"],
  },
  {
    role: "embeddings",
    id: "embeddings-model",
    keywords: ["embeddings", "search", "re-embed", "files", "archives"],
  },
];

/** Render entries in order, merging consecutive same-group entries into one group. */
function renderSettingEntries(
  t: TFunction<"settings">,
  entries: readonly SettingEntry[],
  highlightedEntryId: string | null,
  section: ApplicationSettingsSection,
): ReactNode {
  // The wrapper is the search reveal target; it stays a direct child of the
  // group's divider list so row separators are unchanged.
  const renderItem = (item: SettingEntry) => (
    <div
      key={item.id}
      data-setting-id={item.id}
      className={cn(
        // empty:hidden collapses panels that render nothing in this runtime.
        "-mx-3 rounded-lg px-3 empty:hidden motion-safe:transition-colors motion-safe:duration-700",
        highlightedEntryId === item.id && "bg-primary/10",
      )}
    >
      {item.render()}
    </div>
  );
  // Theme controls form one continuous list, including expanded colours.
  if (section === "Appearance") {
    return <SettingsGroup>{entries.map(renderItem)}</SettingsGroup>;
  }

  const blocks: Array<{
    key: string;
    groupId?: SettingGroupId;
    items: SettingEntry[];
  }> = [];
  for (const entry of entries) {
    const previous = blocks.at(-1);
    if (entry.groupId && previous?.groupId === entry.groupId) {
      previous.items.push(entry);
    } else {
      blocks.push({ key: entry.id, groupId: entry.groupId, items: [entry] });
    }
  }
  return (
    <div className="[&>*:not(:first-child)]:border-border/40 flex flex-col [&>*:not(:first-child)]:mt-6 [&>*:not(:first-child)]:border-t [&>*:not(:first-child)]:pt-6">
      {blocks.map((block) =>
        block.groupId ? (
          <SettingsGroup
            key={block.key}
            title={
              UNTITLED_GROUPS.has(block.groupId)
                ? undefined
                : settingGroupLabel(t, block.groupId)
            }
            description={settingGroupDescription(t, block.groupId)}
          >
            {block.items.map(renderItem)}
          </SettingsGroup>
        ) : (
          renderItem(block.items[0]!)
        ),
      )}
    </div>
  );
}

const shortcutRows: Array<{
  action: DesktopShortcutAction;
  /** The recorder also accepts a mouse button. */
  allowMouseShortcut?: boolean;
}> = [
  { action: "press_to_talk", allowMouseShortcut: true },
  { action: "quick_chat" },
  { action: "toggle_pip" },
  { action: "toggle_dictation" },
  { action: "toggle_voice_mode" },
  { action: "toggle_voice_mute" },
  { action: "skip_tts" },
];

export function ApplicationSettingsModal({
  open,
  onOpenChange,
  reveal = null,
  onRevealed,
}: ApplicationSettingsModalProps) {
  const apiClient = useProductApiClient();
  const { t, i18n } = useTranslation("settings");
  const { t: tVoice } = useTranslation("voice");
  const sectionLabels = Object.fromEntries(
    sections.map((section) => [section, t(SECTION_LABEL_KEYS[section])]),
  ) as Record<ApplicationSettingsSection, string>;

  const {
    chatMarkdownEnabled,
    setChatMarkdownEnabled,
    enhancedRenderingEnabled,
    setEnhancedRenderingEnabled,
    userPreferences,
    updateUserPreferences,
  } = useSettings();
  const platform = useRuntimePlatform();
  const resolvedUserPreferences = useMemo<SettingsPreferences>(
    () => mergePreferences(DEFAULT_ANIMAMA_PREFERENCES, userPreferences),
    [userPreferences],
  );
  const [selectedSttProvider, setSelectedSttProvider] =
    useState<SttProvider | null>(null);
  const [parakeetWebgpuPreferred, setParakeetWebgpuPreferred] = useState(
    isParakeetWebgpuPreferred(resolvedUserPreferences),
  );
  // The offline engine the owner chose; null follows the UI Locale.
  const [offlineSttEngine, setOfflineSttEngine] =
    useState<OfflineSttEngine | null>(
      offlineSttEnginePreference(resolvedUserPreferences),
    );
  const [ttsEnabled, setTtsEnabled] = useState(false);
  const [selectedTtsProvider, setSelectedTtsProvider] =
    useState<TtsProvider | null>(null);
  const [selectedGeminiModelId, setSelectedGeminiModelId] =
    useState<GeminiTtsModelId>(DEFAULT_GEMINI_TTS_MODEL_ID);
  const [desktopShortcuts, setDesktopShortcuts] = useState<DesktopShortcutMap>(
    defaultDesktopShortcuts(platform.os),
  );
  const [recordingShortcutAction, setRecordingShortcutAction] =
    useState<DesktopShortcutAction | null>(null);
  const [avatarTransformControlsEnabled, setAvatarTransformControlsEnabled] =
    useState(false);
  const [activeSection, setActiveSection] =
    useState<ApplicationSettingsSection>("General");
  const [searchQuery, setSearchQuery] = useState("");
  const [advancedColorsOpen, setAdvancedColorsOpen] = useState(false);
  const [revealRequest, setRevealRequest] = useState<{
    id: string;
    nonce: number;
  } | null>(null);
  const [highlightedEntryId, setHighlightedEntryId] = useState<string | null>(
    null,
  );
  const [isInitializing, setIsInitializing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const runtimeCapabilities = useRuntimeCapabilities();
  const automaticEpisodeProcessingAvailable =
    useAutomaticEpisodeProcessingAvailable();
  // The offline choice runs the owner's engine, else the UI Locale's
  // (Parakeet for English, SenseVoice otherwise), which is also the
  // recommended one; read through `i18n` so both follow a language switch.
  const offlineRoute = routeOfflineSpeech(
    i18n.resolvedLanguage,
    offlineSttEngine,
  );
  const localeSttEngine = routeOfflineSpeech(i18n.resolvedLanguage).engine;
  const parakeetAvailable = runtimeCapabilities.data
    ? offlineSpeechAvailable(offlineRoute, runtimeCapabilities.data)
    : null;
  // Role choices do not grant provider or search-service administration.
  const {
    modelConfiguration: modelConfigurationEnabled,
    modelRoleSelection: modelRoleSelectionEnabled,
    webSearchConfiguration: webSearchConfigurationEnabled,
  } = modelSettingsAvailability(runtimeCapabilities.data);
  const initializedForOpenRef = useRef(false);
  const savedSttProviderRef = useRef<SttProvider | null>(null);
  const savedOfflineSttEngineRef = useRef<OfflineSttEngine | null>(null);
  const savedTtsProviderRef = useRef<TtsProvider | null>(null);
  const savedGeminiModelIdRef = useRef<GeminiTtsModelId>(
    DEFAULT_GEMINI_TTS_MODEL_ID,
  );
  const savedTtsEnabledRef = useRef(false);
  const savedDesktopShortcutsRef = useRef<DesktopShortcutMap>(
    defaultDesktopShortcuts(platform.os),
  );
  const savedAvatarTransformControlsEnabledRef = useRef(false);
  const updateUserPreferencesRef = useRef(updateUserPreferences);

  const savedSttProvider = toSttProvider(
    resolvedUserPreferences?.speech?.stt_provider,
  );
  const savedParakeetWebgpuPreferred = isParakeetWebgpuPreferred(
    resolvedUserPreferences,
  );
  useEffect(() => {
    setParakeetWebgpuPreferred(savedParakeetWebgpuPreferred);
  }, [savedParakeetWebgpuPreferred]);
  const savedOfflineSttEngine = offlineSttEnginePreference(
    resolvedUserPreferences,
  );
  useEffect(() => {
    setOfflineSttEngine(savedOfflineSttEngine);
    savedOfflineSttEngineRef.current = savedOfflineSttEngine;
  }, [savedOfflineSttEngine]);
  const savedTtsProvider = toTtsProvider(
    resolvedUserPreferences?.speech?.tts_provider,
  );
  const savedGeminiModelId =
    toGeminiTtsModelId(resolvedUserPreferences?.speech?.tts_gemini_model_id) ??
    DEFAULT_GEMINI_TTS_MODEL_ID;
  const savedTtsEnabled = resolvedUserPreferences?.speech?.tts_enabled === true;
  const savedDesktopShortcuts = useMemo(
    () =>
      resolveDesktopShortcuts(
        resolvedUserPreferences?.speech?.desktop_shortcuts,
        platform.os,
      ),
    [platform.os, resolvedUserPreferences?.speech?.desktop_shortcuts],
  );
  const savedAvatarTransformControlsEnabled =
    resolvedUserPreferences?.presentation?.enable_avatar_transform_controls ===
    true;
  useEffect(() => {
    savedSttProviderRef.current = savedSttProvider;
  }, [savedSttProvider]);

  useEffect(() => {
    savedTtsProviderRef.current = savedTtsProvider;
  }, [savedTtsProvider]);

  useEffect(() => {
    savedGeminiModelIdRef.current = savedGeminiModelId;
  }, [savedGeminiModelId]);

  useEffect(() => {
    savedTtsEnabledRef.current = savedTtsEnabled;
  }, [savedTtsEnabled]);

  useEffect(() => {
    savedDesktopShortcutsRef.current = savedDesktopShortcuts;
  }, [savedDesktopShortcuts]);

  useEffect(() => {
    savedAvatarTransformControlsEnabledRef.current =
      savedAvatarTransformControlsEnabled;
  }, [savedAvatarTransformControlsEnabled]);

  useEffect(() => {
    updateUserPreferencesRef.current = updateUserPreferences;
  }, [updateUserPreferences]);

  useEffect(() => {
    if (!platform.isDesktop || !platform.desktopBridge.shortcuts) return;
    void platform.desktopBridge.shortcuts.setContext({
      shortcutCaptureActive: recordingShortcutAction !== null,
    });
  }, [platform, recordingShortcutAction]);

  useEffect(() => {
    return () => {
      if (!platform.isDesktop || !platform.desktopBridge.shortcuts) return;
      void platform.desktopBridge.shortcuts.setContext({
        shortcutCaptureActive: false,
      });
    };
  }, [platform]);

  useEffect(() => {
    if (open) return;
    initializedForOpenRef.current = false;
    setIsInitializing(false);
    setIsSaving(false);
    setSelectedSttProvider(savedSttProvider);
    setSelectedTtsProvider(savedTtsProvider);
    setSelectedGeminiModelId(savedGeminiModelId);
    setTtsEnabled(savedTtsEnabled);
    setDesktopShortcuts(savedDesktopShortcuts);
    setRecordingShortcutAction(null);
    setAvatarTransformControlsEnabled(savedAvatarTransformControlsEnabled);
    setActiveSection("General");
    setSearchQuery("");
    setAdvancedColorsOpen(false);
    setRevealRequest(null);
    setHighlightedEntryId(null);
  }, [
    savedAvatarTransformControlsEnabled,
    open,
    savedSttProvider,
    savedGeminiModelId,
    savedTtsEnabled,
    savedTtsProvider,
    savedDesktopShortcuts,
  ]);

  useEffect(() => {
    if (!open) return;
    if (initializedForOpenRef.current) return;
    initializedForOpenRef.current = true;

    let cancelled = false;
    const initialSavedSttProvider = savedSttProviderRef.current;
    const initialSavedOfflineSttEngine = savedOfflineSttEngineRef.current;
    const initialSavedTtsProvider = savedTtsProviderRef.current;
    const initialSavedGeminiModelId = savedGeminiModelIdRef.current;
    const initialSavedTtsEnabled = savedTtsEnabledRef.current;
    const initialSavedDesktopShortcuts = savedDesktopShortcutsRef.current;
    const initialSavedAvatarTransformControlsEnabled =
      savedAvatarTransformControlsEnabledRef.current;
    setIsInitializing(true);

    void (async () => {
      try {
        const capabilities = await fetchRuntimeCapabilities(apiClient);
        // Resolved as dictation does: a saved offline choice stays selected
        // when only the language's set is missing (the language notice asks
        // for it).
        const resolved = resolveRoutedSttProvider({
          savedProvider: initialSavedSttProvider,
          platform,
          route: routeOfflineSpeech(undefined, initialSavedOfflineSttEngine),
          capabilities,
        });
        const resolvedTts = resolvePreferredTtsProvider({
          savedProvider: initialSavedTtsProvider,
          platform,
          offers: { gemini: capabilities.gemini_tts != null },
        });

        if (cancelled) return;
        setSelectedSttProvider(resolved.provider);
        setSelectedTtsProvider(resolvedTts.provider);
        setSelectedGeminiModelId(initialSavedGeminiModelId);
        setTtsEnabled(initialSavedTtsEnabled);
        setDesktopShortcuts(initialSavedDesktopShortcuts);
        setRecordingShortcutAction(null);
        setAvatarTransformControlsEnabled(
          initialSavedAvatarTransformControlsEnabled,
        );

        const speechPatch: {
          stt_provider?: SttProvider;
          tts_provider?: TtsProvider;
        } = {};
        if (
          !initialSavedSttProvider ||
          initialSavedSttProvider !== resolved.provider
        ) {
          speechPatch.stt_provider = resolved.provider;
        }
        if (
          resolvedTts.provider &&
          (!initialSavedTtsProvider ||
            initialSavedTtsProvider !== resolvedTts.provider)
        ) {
          speechPatch.tts_provider = resolvedTts.provider;
        }

        if (Object.keys(speechPatch).length > 0) {
          try {
            await updateUserPreferencesRef.current({
              speech: speechPatch,
            });
          } catch {
            toast.error(initializationFailureText("defaultProviders"));
          }
        }
      } catch {
        if (!cancelled) toast.error(initializationFailureText("capabilities"));
      } finally {
        if (!cancelled) setIsInitializing(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [apiClient, open, platform]);

  // After a search selection renders its section, scroll the setting into
  // view, move focus to its control and briefly highlight the row.
  useEffect(() => {
    if (!revealRequest) return;
    const target = document.querySelector<HTMLElement>(
      `[data-setting-id="${revealRequest.id}"]`,
    );
    if (!target) return;
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    target.scrollIntoView({
      block: "center",
      behavior: reduceMotion ? "auto" : "smooth",
    });
    const control =
      target.querySelector<HTMLElement>(
        // Prefer visible controls over the transparent native colour picker.
        '[role="switch"]:not(:disabled), [role="combobox"]:not(:disabled), input:not(:disabled):not([type="color"])',
      ) ?? target.querySelector<HTMLElement>("button:not(:disabled)");
    control?.focus({ preventScroll: true });
    setHighlightedEntryId(revealRequest.id);
    const timer = window.setTimeout(
      () => setHighlightedEntryId(null),
      REVEAL_HIGHLIGHT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [revealRequest]);

  // Provider options are worded in the active UI Locale, so they are rebuilt
  // on each render (they are a few small objects) rather than memoized.
  const sttProviderOptions = getSttSettingsOptions(
    getSttProviderOptions(parakeetAvailable, platform, offlineRoute.engine),
    offlineRoute.engine,
  );
  const geminiTtsOffered = runtimeCapabilities.data?.gemini_tts != null;
  const ttsProviderOptions = getTtsProviderOptions(platform, {
    gemini: geminiTtsOffered,
  });

  const selectedSttOption = getSttSettingsSelection(
    selectedSttProvider,
    parakeetWebgpuPreferred,
  );
  const currentSttOption = sttProviderOptions.find(
    (option) => option.id === selectedSttOption,
  );
  // The Speech-to-Text tabs: the browser (web only), then each offline model,
  // the UI Locale's first. A saved offline choice shows under the engine that
  // runs; either browser recognizer shows as the browser.
  const sttChoices = availableSttChoices(
    localeSttEngine,
    getSttProviderOptions(parakeetAvailable, platform, offlineRoute.engine),
  );
  const sttRecommended = recommendedSttChoice(localeSttEngine, sttChoices);
  const savedSttChoice: SttChoice | null =
    selectedSttProvider === "browser_external" ||
    selectedSttProvider === "browser_local"
      ? "browser_external"
      : selectedSttProvider === "parakeet"
        ? `${offlineRoute.engine}_${parakeetWebgpuPreferred ? "gpu" : "cpu"}`
        : null;
  const sttChoice =
    savedSttChoice && sttChoices.includes(savedSttChoice)
      ? savedSttChoice
      : sttRecommended;
  const currentGeminiModelOption = GEMINI_TTS_MODEL_OPTIONS.find(
    (option) => option.id === selectedGeminiModelId,
  );

  const firstAvailableTtsProvider =
    ttsProviderOptions.find((option) => !option.disabled)?.id ?? null;

  /**
   * Save a Speech-to-Text choice: its provider, GPU preference and, for an
   * offline choice, its engine (`sttChoicePatch`). An offline choice is saved
   * before its set is installed: its tab shows the set's state (and its
   * download while downloads are offered), and dictation says the model is
   * missing.
   */
  const handleSttChoiceChange = (choice: SttChoice) => {
    if (choice === savedSttChoice || isSaving || isInitializing) return;
    const nextSpeech = sttChoicePatch(choice);
    const nextProvider = nextSpeech.stt_provider;
    const nextOption = sttProviderOptions.find(
      (option) =>
        option.id ===
        getSttSettingsSelection(
          nextProvider,
          nextSpeech.stt_parakeet_webgpu === true,
        ),
    );
    if (!nextOption || (nextOption.disabled && nextProvider !== "parakeet")) {
      if (nextOption?.reason) {
        toast.error(nextOption.reason);
      }
      return;
    }
    const previousProvider = selectedSttProvider;
    const previousWebgpu = parakeetWebgpuPreferred;
    const previousEngine = offlineSttEngine;
    setSelectedSttProvider(nextProvider);
    setParakeetWebgpuPreferred(
      nextSpeech.stt_parakeet_webgpu ?? previousWebgpu,
    );
    setOfflineSttEngine(nextSpeech.stt_offline_engine ?? previousEngine);
    setIsSaving(true);

    void updateUserPreferences({ speech: nextSpeech })
      .catch(() => {
        setSelectedSttProvider(previousProvider);
        setParakeetWebgpuPreferred(previousWebgpu);
        setOfflineSttEngine(previousEngine);
        toast.error(t("voice.stt.updateFailed"));
      })
      .finally(() => setIsSaving(false));
  };

  const handleTtsEnabledChange = useCallback(
    (nextEnabled: boolean) => {
      if (isSaving || isInitializing) return;

      const previousEnabled = ttsEnabled;
      const previousProvider = selectedTtsProvider;

      let nextProvider = selectedTtsProvider;
      if (nextEnabled) {
        const selectedOption = ttsProviderOptions.find(
          (option) => option.id === nextProvider,
        );
        if (!nextProvider || selectedOption?.disabled) {
          nextProvider = firstAvailableTtsProvider;
        }
        if (!nextProvider) {
          toast.error(t("voice.tts.noProvider"));
          return;
        }
      }

      setTtsEnabled(nextEnabled);
      if (nextEnabled && nextProvider) {
        setSelectedTtsProvider(nextProvider);
      }
      setIsSaving(true);

      const speechPatch: {
        tts_enabled: boolean;
        tts_provider?: TtsProvider;
        tts_elevenlabs_model_id?: ElevenLabsTtsModelId;
        tts_gemini_model_id?: GeminiTtsModelId;
      } = {
        tts_enabled: nextEnabled,
      };
      if (nextProvider) {
        speechPatch.tts_provider = nextProvider;
      }
      if (nextProvider === "elevenlabs") {
        speechPatch.tts_elevenlabs_model_id = DEFAULT_ELEVENLABS_TTS_MODEL_ID;
      }
      if (nextProvider === "gemini") {
        speechPatch.tts_gemini_model_id = selectedGeminiModelId;
      }

      void updateUserPreferences({
        speech: speechPatch,
      })
        .catch(() => {
          setTtsEnabled(previousEnabled);
          setSelectedTtsProvider(previousProvider);
          toast.error(t("voice.tts.updateFailed"));
        })
        .finally(() => setIsSaving(false));
    },
    [
      firstAvailableTtsProvider,
      isInitializing,
      isSaving,
      selectedTtsProvider,
      selectedGeminiModelId,
      ttsEnabled,
      ttsProviderOptions,
      t,
      updateUserPreferences,
    ],
  );

  const handleTtsProviderChange = useCallback(
    (value: string) => {
      const nextProvider = toTtsProvider(value);
      if (!nextProvider || isSaving || isInitializing) return;
      const nextOption = ttsProviderOptions.find(
        (option) => option.id === nextProvider,
      );
      if (!nextOption || nextOption.disabled) {
        if (nextOption?.reason) {
          toast.error(nextOption.reason);
        }
        return;
      }

      const previousProvider = selectedTtsProvider;
      const previousEnabled = ttsEnabled;
      setSelectedTtsProvider(nextProvider);
      setTtsEnabled(true);
      setIsSaving(true);

      void updateUserPreferences({
        speech: {
          tts_enabled: true,
          tts_provider: nextProvider,
          ...(nextProvider === "elevenlabs"
            ? { tts_elevenlabs_model_id: DEFAULT_ELEVENLABS_TTS_MODEL_ID }
            : {}),
          ...(nextProvider === "gemini"
            ? { tts_gemini_model_id: selectedGeminiModelId }
            : {}),
        },
      })
        .catch(() => {
          setSelectedTtsProvider(previousProvider);
          setTtsEnabled(previousEnabled);
          toast.error(t("voice.tts.provider.updateFailed"));
        })
        .finally(() => setIsSaving(false));
    },
    [
      isInitializing,
      isSaving,
      selectedTtsProvider,
      selectedGeminiModelId,
      ttsEnabled,
      ttsProviderOptions,
      t,
      updateUserPreferences,
    ],
  );

  const handleGeminiModelChange = useCallback(
    (value: string) => {
      const nextModel = toGeminiTtsModelId(value);
      if (
        !nextModel ||
        isSaving ||
        isInitializing ||
        !ttsEnabled ||
        selectedTtsProvider !== "gemini"
      ) {
        return;
      }

      const previous = selectedGeminiModelId;
      setSelectedGeminiModelId(nextModel);
      setIsSaving(true);

      void updateUserPreferences({
        speech: { tts_gemini_model_id: nextModel },
      })
        .catch(() => {
          setSelectedGeminiModelId(previous);
          toast.error(t("voice.tts.gemini.model.updateFailed"));
        })
        .finally(() => setIsSaving(false));
    },
    [
      isInitializing,
      isSaving,
      selectedGeminiModelId,
      selectedTtsProvider,
      ttsEnabled,
      t,
      updateUserPreferences,
    ],
  );

  const handleShortcutRecordingStart = useCallback(
    (action: DesktopShortcutAction) => {
      if (isSaving || isInitializing) return;
      setRecordingShortcutAction(action);
    },
    [isInitializing, isSaving],
  );

  const saveShortcut = useCallback(
    (action: DesktopShortcutAction, nextShortcut: DesktopShortcut) => {
      const validationError = validateDesktopShortcut(
        action,
        nextShortcut,
        desktopShortcuts,
      );
      if (validationError) {
        toast.error(shortcutIssueText(t, validationError));
        return;
      }

      const previous = desktopShortcuts;
      const nextShortcuts: DesktopShortcutMap = {
        ...desktopShortcuts,
        [action]: nextShortcut,
      };
      setDesktopShortcuts(nextShortcuts);
      setRecordingShortcutAction(null);
      setIsSaving(true);

      void updateUserPreferences({
        speech: {
          desktop_shortcuts: {
            [action]: nextShortcut,
          },
        },
      })
        .catch(() => {
          setDesktopShortcuts(previous);
          toast.error(t("shortcuts.updateFailed"));
        })
        .finally(() => setIsSaving(false));
    },
    [desktopShortcuts, t, updateUserPreferences],
  );

  const handleShortcutKeyDown = useCallback(
    (
      action: DesktopShortcutAction,
      event: KeyboardEvent<HTMLButtonElement>,
    ) => {
      if (recordingShortcutAction !== action) return;
      event.preventDefault();
      event.stopPropagation();

      const nextShortcut = shortcutFromKeyboardEvent(event);
      if (!nextShortcut) {
        return;
      }

      saveShortcut(action, nextShortcut);
    },
    [recordingShortcutAction, saveShortcut],
  );

  useEffect(() => {
    if (recordingShortcutAction !== "press_to_talk") return;

    const handleMouseDown = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const nextShortcut = shortcutFromMouseEvent(event);
      if (!nextShortcut) return;
      saveShortcut("press_to_talk", nextShortcut);
    };
    const preventPendingMouseDefault = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };

    window.addEventListener("mousedown", handleMouseDown, { capture: true });
    window.addEventListener("auxclick", preventPendingMouseDefault, {
      capture: true,
    });
    window.addEventListener("contextmenu", preventPendingMouseDefault, {
      capture: true,
    });
    return () => {
      window.removeEventListener("mousedown", handleMouseDown, {
        capture: true,
      });
      window.removeEventListener("auxclick", preventPendingMouseDefault, {
        capture: true,
      });
      window.removeEventListener("contextmenu", preventPendingMouseDefault, {
        capture: true,
      });
    };
  }, [recordingShortcutAction, saveShortcut]);

  const handleAvatarTransformControlsChange = useCallback(
    (nextEnabled: boolean) => {
      if (isSaving || isInitializing) return;
      const previous = avatarTransformControlsEnabled;
      setAvatarTransformControlsEnabled(nextEnabled);
      setIsSaving(true);

      void updateUserPreferences({
        presentation: { enable_avatar_transform_controls: nextEnabled },
      })
        .catch(() => {
          setAvatarTransformControlsEnabled(previous);
          toast.error(t("advanced.avatarTransform.updateFailed"));
        })
        .finally(() => setIsSaving(false));
    },
    [
      avatarTransformControlsEnabled,
      isInitializing,
      isSaving,
      t,
      updateUserPreferences,
    ],
  );

  const isBusy = isSaving || isInitializing;
  // The updates panel renders nothing while updates are unavailable (browser,
  // unpackaged or unsupported desktop), so its entry is hidden then too.
  const desktopUpdates = useDesktopUpdates();
  const loginItem = useDesktopLoginItem(open);
  const menuEntry = useDesktopMenuEntry(open);
  const credentialsAvailable = useDesktopCredentialsAvailable();
  const desktopShortcutsAvailable =
    platform.isDesktop && Boolean(platform.desktopBridge.shortcuts);
  const isAudioBusy = isBusy;

  /** Group fields for an entry: its stable ID and its searchable display name. */
  const inGroup = (groupId: SettingGroupId) => ({
    groupId,
    group: settingGroupLabel(t, groupId),
  });

  const settingEntries: SettingEntry[] = [
    {
      id: "display-name",
      section: "General",
      ...inGroup("profile"),
      label: t("profile.displayName.label"),
      keywords: ["name", "user", "profile"],
      render: () => (
        <DisplayNameSettings
          className={cn(FLAT_SETTINGS_PANEL_CLASS_NAME, "py-3")}
        />
      ),
    },
    {
      id: "language",
      section: "General",
      // Sits with the display name in the Profile group.
      ...inGroup("profile"),
      label: t("language.label"),
      // English terms and native names keep the picker findable from any language.
      keywords: [
        ...t("language.keywords", { returnObjects: true }),
        "language",
        "locale",
        ...SUPPORTED_LOCALES.map(localeNativeName),
      ],
      render: () => <LanguageSetting />,
    },
    {
      id: "model-connections",
      section: "Models",
      label: t("models.connections"),
      keywords: [
        "model",
        "connection",
        "cloud",
        "openai",
        "anthropic",
        "claude",
        "compact early",
        "openrouter",
        "api key",
        "ollama",
        "lm studio",
        "llama.cpp",
        "vllm",
        "deepseek",
        "hugging face",
        "local",
        "provider",
        "detect",
        "hide",
      ],
      hidden: !modelConfigurationEnabled,
      render: () => <ModelConnectionsSettings disabled={isBusy} />,
    },
    ...MODEL_DEFAULT_ENTRIES.map(({ role, id, keywords }): SettingEntry => {
      const { label, description } = modelDefaultCopy(role);
      return {
        id,
        section: "Models",
        ...inGroup("defaultModels"),
        label,
        description,
        keywords,
        hidden: !modelRoleSelectionEnabled,
        render: () => <ModelDefaultSetting role={role} disabled={isBusy} />,
      };
    }),
    {
      id: "web-search",
      section: "Models",
      ...inGroup("webSearch"),
      label: t("models.webSearch"),
      keywords: [
        "web search",
        "internet",
        "searxng",
        "brave",
        "search api",
        "tools",
      ],
      hidden: !webSearchConfigurationEnabled,
      render: () => <WebSearchSettings disabled={isBusy} />,
    },
    {
      id: "volume",
      section: "General",
      ...inGroup("audio"),
      label: t("audio.volume"),
      keywords: ["sound", "mute", "tts", "sfx", "sound effects"],
      render: () => (
        <AudioVolumePanel
          disabled={isAudioBusy}
          showTitle={false}
          className="py-3"
          volumeCardClassName={FLAT_SETTINGS_PANEL_CLASS_NAME}
        />
      ),
    },
    {
      id: "provider-keys",
      section: "API Keys",
      label: t("apiKeys.label"),
      keywords: [
        "api key",
        "credentials",
        "openai",
        "anthropic",
        "claude",
        "elevenlabs",
        "gemini",
      ],
      hidden: !credentialsAvailable,
      render: () => (
        <DesktopCredentialsPanel
          className={FLAT_SETTINGS_PANEL_CLASS_NAME}
          showTitle={false}
        />
      ),
    },
    {
      id: "launch-at-login",
      section: "General",
      ...inGroup("startup"),
      label: t("launchAtLogin.label"),
      keywords: ["startup", "login", "autostart", "open automatically", "boot"],
      // Packaged macOS and Windows apps, and a Linux AppImage.
      hidden: !loginItem.status.available,
      render: () => <LaunchAtLoginSetting loginItem={loginItem} />,
    },
    {
      id: "application-menu-entry",
      section: "General",
      ...inGroup("startup"),
      label: t("menuEntry.label"),
      keywords: ["application menu", "launcher", "desktop entry", "shortcut"],
      // A Linux AppImage only.
      hidden: !menuEntry.status.available,
      render: () => <ApplicationMenuEntrySetting menuEntry={menuEntry} />,
    },
    {
      id: "feature-packs",
      section: "General",
      label: t("featurePacks.title"),
      keywords: ["included content", "download"],
      hidden: !platform.isDesktop,
      render: () => (
        <DesktopFeaturePacksPanel className={FLAT_SETTINGS_PANEL_CLASS_NAME} />
      ),
    },
    {
      id: "about-version",
      section: "About",
      ...inGroup("animama"),
      label: t("about.version"),
      keywords: ["about", "version", "platform", "build"],
      render: () => <AboutVersionSetting />,
    },
    {
      id: "updates",
      section: "About",
      label: t("updates.title"),
      keywords: ["update", "version", "upgrade", "restart"],
      hidden: desktopUpdates.status.state === "unavailable",
      render: () => (
        <DesktopUpdatesPanel className={FLAT_SETTINGS_PANEL_CLASS_NAME} />
      ),
    },
    {
      id: "open-logs",
      section: "About",
      ...inGroup("diagnostics"),
      label: t("about.logs.open"),
      keywords: ["logs", "troubleshooting", "debug", "support"],
      hidden: !platform.isDesktop || !platform.desktopBridge.runtime,
      render: () => <OpenLogsSetting />,
    },
    {
      id: "copy-diagnostics",
      section: "About",
      ...inGroup("diagnostics"),
      label: t("about.diagnostics.entryLabel"),
      keywords: ["diagnostics", "bug report", "support", "troubleshooting"],
      render: () => <CopyDiagnosticsSetting />,
    },
    {
      id: "appearance-mode",
      section: "Appearance",
      ...inGroup("theme"),
      label: t("appearance.theme.label"),
      keywords: [
        ...t("appearance.theme.keywords", { returnObjects: true }),
        "theme",
        "mode",
        "dark",
        "light",
        "system",
        "dark mode",
      ],
      render: () => <AppearanceModeSetting />,
    },
    ...APPEARANCE_COLOR_TOKENS.filter((token) => token.group === "basic").map(
      (token): SettingEntry => ({
        id: `appearance-${token.key}`,
        section: "Appearance",
        ...inGroup("colors"),
        label: t("appearance.colors.entryLabel", {
          label: colorTokenLabel(t, token),
        }),
        keywords: [
          ...t("appearance.colors.keywords", { returnObjects: true }),
          "theme",
          "color",
          "colour",
          "override",
          "hex",
        ],
        render: () => <AppearanceColorSetting token={token} />,
      }),
    ),
    {
      id: "appearance-reset-colours",
      section: "Appearance",
      ...inGroup("colors"),
      label: t("appearance.colors.resetAll.label"),
      keywords: [
        ...t("appearance.colors.resetAll.keywords", { returnObjects: true }),
        "theme",
        "color",
        "colour",
        "reset",
        "default",
      ],
      render: () => <ResetColorsSetting />,
    },
    {
      id: "appearance-advanced-toggle",
      section: "Appearance",
      label: t("appearance.colors.advanced.label"),
      keywords: [
        ...t("appearance.colors.advanced.keywords", { returnObjects: true }),
        "theme",
        "color",
        "colour",
        "custom",
        "advanced",
      ],
      render: () => (
        <AdvancedColorsToggleSetting
          open={advancedColorsOpen}
          onToggle={() => setAdvancedColorsOpen((value) => !value)}
        />
      ),
    },
    ...APPEARANCE_COLOR_TOKENS.filter((token) => token.group !== "basic").map(
      (token): SettingEntry => ({
        id: `appearance-${token.key}`,
        section: "Appearance",
        groupId: "advancedColors",
        // The colour's own group name keeps "surfaces" or "charts" searchable.
        group: t("appearance.colors.advanced.entryGroup", {
          group: colorGroupLabel(t, token.group),
        }),
        label: t("appearance.colors.entryLabel", {
          label: colorTokenLabel(t, token),
        }),
        keywords: [
          ...t("appearance.colors.keywords", { returnObjects: true }),
          "theme",
          "color",
          "colour",
          "advanced",
          "hex",
        ],
        collapsed: true,
        render: () => <AppearanceColorSetting token={token} />,
      }),
    ),
    {
      id: "microphone-device",
      section: "Voice",
      ...inGroup("microphone"),
      label: t("voice.microphone.device"),
      keywords: ["mic", "microphone", "input", "device", "headset", "usb"],
      render: () => (
        <MicrophoneDeviceSetting
          usesSystemRecognizer={
            selectedSttProvider === "browser_external" ||
            selectedSttProvider === "browser_local"
          }
        />
      ),
    },
    {
      id: "microphone-sensitivity",
      section: "Voice",
      ...inGroup("microphone"),
      label: t("voice.microphone.sensitivity"),
      keywords: ["mic", "voice detection", "vad", "noise", "quiet"],
      render: () => <MicrophoneSensitivitySetting disabled={isBusy} />,
    },
    {
      id: "microphone-test",
      section: "Voice",
      ...inGroup("microphone"),
      label: t("voice.microphone.test"),
      keywords: ["mic", "level", "meter", "input level"],
      render: () => <MicrophoneTestSetting />,
    },
    {
      id: "stt-provider",
      section: "Voice",
      ...inGroup("speechToText"),
      label: t("voice.stt.entryLabel"),
      description: currentSttOption?.description,
      keywords: [
        "stt",
        "dictation",
        "microphone",
        "transcription",
        "parakeet",
        "sensevoice",
        "voice mode",
        "cpu",
        "gpu",
        "webgpu",
        "experimental",
        "live previews",
      ],
      render: () => (
        <div className="space-y-3 py-3">
          <SttChoiceTabs
            choice={sttChoice}
            choices={sttChoices}
            recommended={sttRecommended}
            onChoiceChange={handleSttChoiceChange}
            selected={savedSttChoice ? sttChoiceEngine(savedSttChoice) : null}
            panel={(choice) => (
              <OfflineEngineSettingsPanel
                engine={sttChoiceEngine(choice) as OfflineSttEngine}
                set={choice.endsWith("_gpu") ? "gpu" : "cpu"}
              />
            )}
          />
          <SpeechLanguageNotice
            direction="speechToText"
            provider={selectedSttOption}
            engine={offlineSttEngine}
          />
          {isInitializing ? (
            <p className="text-muted-foreground text-xs">
              {t("voice.stt.preparing")}
            </p>
          ) : null}
        </div>
      ),
    },
    {
      id: "tts-enabled",
      section: "Voice",
      ...inGroup("textToSpeech"),
      label: t("voice.tts.enable"),
      keywords: ["tts", "text-to-speech", "speak", "voice output"],
      render: () => (
        <SettingsRow
          label={t("voice.tts.enable")}
          control={
            <Switch
              checked={ttsEnabled}
              onCheckedChange={handleTtsEnabledChange}
              disabled={isBusy}
              aria-label={t("voice.tts.enable")}
            />
          }
        />
      ),
    },
    {
      id: "tts-provider",
      section: "Voice",
      ...inGroup("textToSpeech"),
      label: t("voice.tts.provider.entryLabel"),
      keywords: [
        "tts",
        "text-to-speech",
        "pocket",
        "elevenlabs",
        "gemini",
        "voice",
      ],
      render: () => (
        <div className="space-y-3 py-3">
          <Tabs
            value={selectedTtsProvider ?? undefined}
            onValueChange={handleTtsProviderChange}
          >
            <ChoiceTabsList
              tabs={ttsProviderOptions.map((option) => ({
                id: option.id,
                label:
                  option.id === "pocket_tts"
                    ? tVoice("providers.tts.pocketBuiltIn")
                    : option.label,
                disabled: option.disabled || !ttsEnabled || isBusy,
                reason: option.reason,
              }))}
              active={selectedTtsProvider ?? ""}
              selected={
                ttsEnabled ? (selectedTtsProvider ?? undefined) : undefined
              }
              label={t("voice.tts.provider.ariaLabel")}
              selectedLabel={tVoice("providers.selected")}
            />
            {ttsProviderOptions.map((option) => (
              <TabsContent
                key={option.id}
                value={option.id}
                className="mt-4 space-y-3"
              >
                <p className="text-muted-foreground text-xs">
                  {!ttsEnabled
                    ? t("voice.tts.provider.enableFirst")
                    : option.description}
                </p>
                {option.reason && ttsEnabled ? (
                  <p className="text-warning text-xs">{option.reason}</p>
                ) : null}
                {ttsEnabled ? (
                  <SpeechLanguageNotice
                    direction="textToSpeech"
                    provider={option.id}
                  />
                ) : null}
                {option.id === "pocket_tts" ? (
                  // Voice cloning belongs to Pocket TTS, the only provider
                  // that speaks with a cloned voice.
                  <section className="space-y-2 pt-2">
                    <h4 className="text-sm font-medium">
                      {tVoice("downloads.sections.voiceClone")}
                    </h4>
                    <VoiceCloneSettings />
                  </section>
                ) : null}
                {option.id === "elevenlabs" && credentialsAvailable ? (
                  <DesktopCredentialsPanel
                    providers={["elevenlabs"]}
                    showTitle={false}
                    description={t("voice.tts.elevenLabs.key.description")}
                    className={cn(FLAT_SETTINGS_PANEL_CLASS_NAME, "py-3")}
                  />
                ) : null}
                {option.id === "gemini" ? (
                  <>
                    {credentialsAvailable ? (
                      <DesktopCredentialsPanel
                        providers={["gemini"]}
                        showTitle={false}
                        description={t("voice.tts.gemini.key.description")}
                        className={cn(FLAT_SETTINGS_PANEL_CLASS_NAME, "py-3")}
                      />
                    ) : null}
                    <SettingsRow
                      label={t("voice.tts.gemini.model.label")}
                      description={
                        currentGeminiModelOption
                          ? geminiModelDescription(
                              t,
                              currentGeminiModelOption.id,
                            )
                          : undefined
                      }
                      control={
                        <Select
                          value={selectedGeminiModelId}
                          onValueChange={handleGeminiModelChange}
                          disabled={isBusy || !ttsEnabled}
                        >
                          <SelectTrigger
                            className={SELECT_TRIGGER_CLASS_NAME}
                            aria-label={t("voice.tts.gemini.model.label")}
                          >
                            <SelectValue
                              placeholder={t(
                                "voice.tts.gemini.model.placeholder",
                              )}
                            />
                          </SelectTrigger>
                          <SelectContent>
                            {GEMINI_TTS_MODEL_OPTIONS.map((model) => (
                              <SelectItem key={model.id} value={model.id}>
                                {model.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      }
                    >
                      <p className="text-muted-foreground text-xs">
                        {t("voice.tts.gemini.model.note")}
                      </p>
                    </SettingsRow>
                  </>
                ) : null}
              </TabsContent>
            ))}
          </Tabs>
          <p className="text-muted-foreground text-xs">
            {t("voice.tts.provider.note")}
          </p>
        </div>
      ),
    },
    ...shortcutRows.map((row): SettingEntry => {
      const label = shortcutActionLabel(t, row.action);
      const description =
        row.action === "press_to_talk"
          ? t("shortcuts.pressToTalkDescription")
          : undefined;
      return {
        id: `shortcut-${row.action}`,
        section: "Shortcuts",
        ...inGroup("desktopShortcuts"),
        label,
        description,
        keywords: ["shortcut", "hotkey", "keyboard", "key binding"],
        hidden: !desktopShortcutsAvailable,
        render: () => (
          <ShortcutRecorder
            label={label}
            description={description}
            shortcut={desktopShortcuts[row.action]}
            isRecording={recordingShortcutAction === row.action}
            disabled={isBusy}
            allowMouseShortcut={row.allowMouseShortcut === true}
            onStartRecording={() => handleShortcutRecordingStart(row.action)}
            onCancelRecording={() => setRecordingShortcutAction(null)}
            onKeyDown={(event) => handleShortcutKeyDown(row.action, event)}
          />
        ),
      };
    }),
    ...BEHAVIOR_FLAGS.map(
      (flag): SettingEntry => ({
        id: `behavior-${flag}`,
        section: "Memory & Emotion",
        ...inGroup("animaDefaults"),
        label: behaviorLabel(t, flag),
        keywords: ["memory", "emotion", "default", "inherit", "anima settings"],
        render: () => <AppBehaviorSetting flag={flag} disabled={isBusy} />,
      }),
    ),
    {
      id: "behavior-automatic-episode-processing",
      section: "Memory & Emotion",
      ...inGroup("animaDefaults"),
      label: t("behavior.automaticProcessing.label"),
      keywords: ["memory", "episode", "notes", "memory manager", "automatic"],
      hidden: !automaticEpisodeProcessingAvailable,
      render: () => <AutomaticEpisodeProcessingSetting disabled={isBusy} />,
    },
    {
      id: "safety",
      section: "Safety",
      label: t("safety.entryLabel"),
      keywords: [
        "safety",
        "crisis",
        "help",
        "hotline",
        "988",
        "region",
        "reminder",
        "ai notice",
        "protocol",
      ],
      render: () => (
        <SafetySettingsSection
          safety={resolvedUserPreferences.safety}
          updateUserPreferences={updateUserPreferences}
          disabled={isBusy}
        />
      ),
    },
    {
      id: "chat-markdown",
      section: "Advanced",
      ...inGroup("messages"),
      label: t("advanced.markdown.label"),
      keywords: ["chat", "formatting"],
      render: () => (
        <SettingsRow
          label={t("advanced.markdown.label")}
          control={
            <Switch
              checked={chatMarkdownEnabled}
              onCheckedChange={setChatMarkdownEnabled}
              aria-label={t("advanced.markdown.label")}
            />
          }
        />
      ),
    },
    {
      id: "avatar-enhanced-rendering",
      section: "Advanced",
      ...inGroup("avatarRendering"),
      label: t("advanced.enhancedRendering.label"),
      keywords: [
        ...t("advanced.enhancedRendering.keywords", { returnObjects: true }),
        "shader",
        "lighting",
        "toon",
      ],
      render: () => (
        <SettingsRow
          label={t("advanced.enhancedRendering.label")}
          description={t("advanced.enhancedRendering.description")}
          control={
            <Switch
              checked={enhancedRenderingEnabled}
              onCheckedChange={setEnhancedRenderingEnabled}
              aria-label={t("advanced.enhancedRendering.label")}
            />
          }
        />
      ),
    },
    {
      id: "avatar-transform-controls",
      section: "Advanced",
      ...inGroup("avatarControls"),
      label: t("advanced.avatarTransform.label"),
      keywords: ["move", "rotate", "scale", "orbit", "zoom", "camera"],
      render: () => (
        <SettingsRow
          label={
            <span className="flex items-center gap-2">
              {t("advanced.avatarTransform.label")}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex h-5 w-5 items-center justify-center rounded-full transition focus-visible:ring-2 focus-visible:outline-none"
                    aria-label={t("advanced.avatarTransform.help")}
                  >
                    <Info className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={6} className="max-w-xs">
                  {t("advanced.avatarTransform.tooltip")}
                </TooltipContent>
              </Tooltip>
            </span>
          }
          control={
            <Switch
              checked={avatarTransformControlsEnabled}
              onCheckedChange={handleAvatarTransformControlsChange}
              disabled={isBusy}
              aria-label={t("advanced.avatarTransform.label")}
            />
          }
        />
      ),
    },
    {
      id: "reset-app-settings",
      section: "Advanced",
      ...inGroup("appData"),
      label: t("data.reset.label"),
      keywords: ["reset", "defaults", "restore", "clear"],
      // Close so controls holding local copies reload the restored values.
      render: () => (
        <ResetAppSettingsSetting onReset={() => onOpenChange(false)} />
      ),
    },
  ];

  const visibleEntries = settingEntries.filter((entry) => !entry.hidden);
  // Sections without any available setting (e.g. About in a browser before it
  // gains browser-visible rows) are left out of navigation and search.
  const availableSections = availableSettingsSections(sections, visibleEntries);
  const shownSection = availableSections.includes(activeSection)
    ? activeSection
    : (availableSections[0] ?? "General");

  /** Dropdown selection: open the entry's section, then reveal and focus it. */
  const handleSearchSelectEntry = (entry: SettingEntry) => {
    if (entry.collapsed) setAdvancedColorsOpen(true);
    setActiveSection(entry.section);
    setRevealRequest({ id: entry.id, nonce: Date.now() });
  };

  // A request from outside the dialog opens at its setting once that setting
  // is offered (an entry can stay hidden until its state loads).
  const requestedEntry = reveal
    ? visibleEntries.find((entry) => entry.id === reveal.target)
    : undefined;
  const requestReady = open && Boolean(requestedEntry);
  useEffect(() => {
    if (!requestReady || !reveal || !requestedEntry) return;
    // On a fresh open the dialog's content mounts, and takes focus, after
    // this effect. Waiting a frame lets the reveal find its row and keep the
    // focus it gives the setting.
    const frame = window.requestAnimationFrame(() => {
      handleSearchSelectEntry(requestedEntry);
      onRevealed?.(reveal);
    });
    return () => window.cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per request, when its entry is offered
  }, [requestReady, reveal?.nonce]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <DialogOverlay />
        <SectionedModalFrame<ApplicationSettingsSection>
          title={t("modal.title")}
          description={t("modal.description")}
          closeLabel={t("modal.close")}
          sidebarLabel={t("modal.navigationLabel")}
          sidebarTitle={t("modal.title")}
          sections={availableSections}
          sectionIcons={SECTION_ICONS}
          sectionLabels={sectionLabels}
          activeSection={shownSection}
          onSectionChange={setActiveSection}
          avoidSidebar
          sidebarHeader={
            <SettingsSearch
              query={searchQuery}
              onQueryChange={setSearchQuery}
              entries={visibleEntries}
              sections={availableSections}
              sectionIcons={SECTION_ICONS}
              sectionLabels={sectionLabels}
              onSelectSection={setActiveSection}
              onSelectEntry={handleSearchSelectEntry}
            />
          }
          onEscapeKeyDown={(event) => {
            // Esc clears an active search first instead of closing the dialog.
            if (!searchQuery) return;
            event.preventDefault();
            setSearchQuery("");
          }}
          headerTitle={sectionLabels[shownSection]}
          gridClassName="md:grid-cols-[240px_minmax(0,1fr)]"
          contentClassName="gap-6"
        >
          {renderSettingEntries(
            t,
            visibleEntries.filter(
              (entry) =>
                entry.section === shownSection &&
                (!entry.collapsed || advancedColorsOpen),
            ),
            highlightedEntryId,
            shownSection,
          )}
        </SectionedModalFrame>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
