import { RefreshCwIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { PyGenerationDraft } from "@animama/runtime-contracts/api-types";

import { parseAnimaPoseClip } from "@/lib/avatar/poses/animaPoseClip";
import { usePoseCreatorStore } from "@/stores/pose-creator-store";
import { useSceneVFXStore } from "@/stores/scene-vfx-store";
import { actionEditorCapabilities } from "@/ui/action-editor/actionEditorCapabilities";
import { ActionEditorClipPreviewSync } from "@/ui/action-editor/ActionEditorPrimitives";
import { ActionEditorScene } from "@/ui/action-editor/ActionEditorScene";
import { retainActionEditorWorkspace } from "@/ui/action-editor/actionEditorStoreLifecycle";
import { PlaybackObservationOutput } from "@/ui/avatar-preview/PlaybackObservationOutput";
import { Button } from "@/ui/components/button";
import { Switch } from "@/ui/components/switch";
import { CreatorCanvasControls } from "@/ui/content-creator/CreatorCanvasControls";
import { CreatorTimelineTransport } from "@/ui/content-creator/CreatorTimeline";
import { ContentPreviewExclusiveCanvasGate } from "@/ui/content-preview/ContentPreviewDockProvider";
import {
  PoseCreatorPreviewProvider,
  usePoseCreatorPreview,
} from "@/ui/pose-creator/PoseCreatorPreviewProvider";
import { draftFailureText } from "./generationFailure";
import { GenerationPreviewRendererBridge } from "./GenerationPreviewRendererBridge";
import {
  previewAvatarExpressions,
  type PreviewAvatarExpressions,
} from "./previewAvatarExpressions";
import type { DraftValidation } from "./useDraftWorker";

/** The preview plays Gestures on the creator's own stage. */
const STAGE_CAPABILITIES = actionEditorCapabilities("gesture");
/** How many of a clip's problems the stage lists before it stops. */
const MAX_STAGE_ISSUES = 3;

/**
 * Claims the app's one preview canvas for the page and resolves the Avatars
 * the preview offers: the last active Anima's (the default), the person's own
 * and the Included ones (R5.1).
 */
export function GeneratePreviewProvider({ children }: { children: ReactNode }) {
  return (
    <ContentPreviewExclusiveCanvasGate ownerId="generate">
      <PoseCreatorPreviewProvider includedAvatars ownAvatars>
        {children}
      </PoseCreatorPreviewProvider>
    </ContentPreviewExclusiveCanvasGate>
  );
}

/**
 * The chosen preview Avatar's expression names, for the run and the draft
 * checks: `undefined` while that Avatar loads, `null` when none can be shown.
 * Only names are read from the Avatar.
 */
export function useGeneratePreviewAvatarExpressions():
  | PreviewAvatarExpressions
  | null
  | undefined {
  const preview = usePoseCreatorPreview();
  const activeAvatar = usePoseCreatorStore((state) => state.activeAvatar);
  const loadFailed = usePoseCreatorStore(
    (state) => state.loadStatus === "error",
  );
  // Read once per Avatar: the names are a fresh array on every call.
  const expressions = useMemo(
    () => previewAvatarExpressions(activeAvatar),
    [activeAvatar],
  );
  if (expressions) return expressions;
  const unavailable =
    loadFailed ||
    Boolean(preview.modelError ?? preview.runtimeError ?? preview.animaError);
  return unavailable ? null : undefined;
}

/** What the stage is doing with the selected draft. */
type GeneratePreviewPlayer = {
  /** The selected draft's clip is loaded and can be played. */
  playable: boolean;
  /** The clip passed validation but the player refused it. */
  failed: boolean;
};

/**
 * Loads the selected draft's clip into the creator's playback store and plays
 * it: as soon as it loads (R3.3), again for each new version, and again when
 * the Avatar changes. Only a clip the page validated (`validation.sequence`)
 * is ever loaded. The store is reset when the page leaves, as the creator
 * does.
 */
export function useGeneratePreviewPlayer(
  draft: PyGenerationDraft | null,
  validation: DraftValidation | undefined,
): GeneratePreviewPlayer {
  const activeAvatar = usePoseCreatorStore((state) => state.activeAvatar);
  const sequence =
    draft && validation?.version === draft.version ? validation.sequence : null;
  // A version's clip never changes, so the version identifies what is loaded:
  // a status update of the same version must not start the clip again.
  const clipKey = draft && sequence ? `${draft.id}:${draft.version}` : null;
  const sequenceRef = useRef(sequence);
  sequenceRef.current = sequence;
  const [loaded, setLoaded] = useState<{ key: string; ok: boolean } | null>(
    null,
  );

  useEffect(() => {
    usePoseCreatorStore.getState().setAuthoringMode("clip");
    return retainActionEditorWorkspace(
      usePoseCreatorStore.getState().resetWorkspace,
    );
  }, []);

  useEffect(() => {
    const store = usePoseCreatorStore.getState();
    const sequence = sequenceRef.current;
    if (!clipKey || !sequence) {
      // Nothing to play: put the Avatar back in its rest pose.
      store.resetClipDraft();
      setLoaded(null);
      return;
    }
    let ok = false;
    try {
      ok = store.hydrateClipDocument(parseAnimaPoseClip(sequence));
    } catch {
      // The player refused a clip validation let through; nothing is played.
    }
    if (ok) usePoseCreatorStore.getState().restartClipPreview();
    else store.resetClipDraft();
    setLoaded({ key: clipKey, ok });
  }, [clipKey]);

  const playable = loaded?.key === clipKey && loaded?.ok === true;
  // A newly chosen Avatar plays the draft from its start.
  useEffect(() => {
    if (activeAvatar && playable)
      usePoseCreatorStore.getState().restartClipPreview();
  }, [activeAvatar, playable]);

  return {
    playable,
    failed: loaded?.key === clipKey && loaded?.ok === false,
  };
}

/**
 * The preview stage: the creator's scene playing the selected draft on the
 * chosen Avatar. A draft that cannot be played says why instead (R4.1). The
 * stage also lends its renderer to the draft worker for review sheets.
 */
export function GeneratePreviewStage({
  draft,
  validation,
  player,
  hasDrafts,
}: {
  /** The selected draft, or `null` when none is. */
  draft: PyGenerationDraft | null;
  validation: DraftValidation | undefined;
  player: GeneratePreviewPlayer;
  hasDrafts: boolean;
}) {
  const { t } = useTranslation("generate");
  const preview = usePoseCreatorPreview();
  const activeAvatar = usePoseCreatorStore((state) => state.activeAvatar);
  const loadStatus = usePoseCreatorStore((state) => state.loadStatus);
  const loadError = usePoseCreatorStore((state) => state.loadError);
  const clipDraft = usePoseCreatorStore((state) => state.clipDraft);
  const playing = usePoseCreatorStore((state) => state.clipPlaybackPlaying);
  const playheadSec = usePoseCreatorStore(
    (state) => state.clipPlaybackAbsoluteTimeSec,
  );
  const sceneVFXActiveByKind = useSceneVFXStore((state) => state.activeByKind);
  const sceneVFX = useMemo(
    () =>
      Object.values(sceneVFXActiveByKind).filter(
        (entry): entry is NonNullable<typeof entry> => Boolean(entry),
      ),
    [sceneVFXActiveByKind],
  );
  const expressionNames = useMemo(
    () => Object.keys(clipDraft.motion.expressions ?? {}).sort(),
    [clipDraft.motion],
  );

  const validated = draft ? validation?.version === draft.version : false;
  const unplayable =
    Boolean(draft) &&
    (draft!.project === null ||
      (validated && !validation!.sequence) ||
      player.failed);
  const issues =
    validated && !validation!.sequence
      ? validation!.issues.slice(0, MAX_STAGE_ISSUES)
      : [];
  const note = !draft
    ? hasDrafts
      ? t("preview.selectDraft")
      : t("preview.empty")
    : unplayable
      ? (draftFailureText(draft) ?? t("preview.unplayable"))
      : !player.playable
        ? t("preview.loadingDraft")
        : null;

  const previewError =
    loadError ??
    preview.modelError ??
    preview.runtimeError ??
    preview.animaError;
  const previewPreparing =
    !preview.modelEntry &&
    (preview.isAnimaPending ||
      preview.isRuntimePending ||
      Boolean(preview.selectedModel));
  const observationStatus = previewError
    ? ("error" as const)
    : previewPreparing || loadStatus === "loading"
      ? ("loading" as const)
      : !activeAvatar || !player.playable
        ? ("unavailable" as const)
        : playing
          ? ("playing" as const)
          : ("stopped" as const);
  const runtimeId = clipDraft.id.trim() || "generate-draft";

  return (
    <div
      className="relative size-full"
      data-playback-surface="creator-stage"
      data-testid="generate-preview"
      data-draft-id={player.playable ? draft?.id : undefined}
    >
      <PlaybackObservationOutput
        active
        avatar={activeAvatar}
        expressionNames={expressionNames}
        poseClipSample={
          player.playable
            ? {
                runtimeId,
                active: playing,
                playheadSec,
                durationSec: clipDraft.duration,
              }
            : undefined
        }
        sceneVFX={sceneVFX}
        status={observationStatus}
        surface="creator-stage"
        target={{ kind: "anima_pose_clip", runtimeId }}
      />
      <ActionEditorClipPreviewSync />
      <ActionEditorScene
        capabilities={STAGE_CAPABILITIES}
        canvasTestId="generate-preview-canvas"
        showHumanoidTools={false}
      >
        <GenerationPreviewRendererBridge />
      </ActionEditorScene>
      {note ? (
        // Centred on the stage between the desktop panels, as the creators'
        // stage notes are, so a long reason wraps instead of running under them.
        <div className="pointer-events-none absolute inset-x-0 top-3 z-40 flex justify-center px-4 lg:top-[calc(var(--creator-header-height,3.5rem)+0.75rem)] lg:right-[calc(var(--creator-inset)+min(var(--creator-right-panel-width),27vw)+0.75rem)] lg:left-[calc(var(--app-shell-sidebar-inset)+var(--creator-inset)+min(var(--creator-left-panel-width),26vw)+0.75rem)] lg:px-0">
          <div
            role="status"
            data-testid="generate-preview-note"
            className="bg-background/90 text-foreground max-w-[28rem] rounded-md px-3 py-1.5 text-center text-xs shadow-sm"
          >
            <p>{note}</p>
            {issues.map((issue, index) => (
              <p
                key={index}
                className="text-muted-foreground mt-1 text-left break-words"
              >
                {issue.path
                  ? t("warnings.issueAt", {
                      path: issue.path,
                      message: issue.message,
                    })
                  : issue.message}
              </p>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The preview's controls: the Avatar picker and play, pause, restart and loop
 * (R5.1), in the creators' canvas control bar.
 */
export function GeneratePreviewControls({ playable }: { playable: boolean }) {
  const { t } = useTranslation("generate");
  const { t: tPose } = useTranslation("pose");
  const {
    modelOptions,
    isModelCatalogPending,
    modelCatalogError,
    selectModel,
    retryModels,
  } = usePoseCreatorPreview();
  const selectedSource = usePoseCreatorStore((state) => state.selectedSource);
  const loop = usePoseCreatorStore((state) => state.clipDraft.loop);
  const clipSession = usePoseCreatorStore((state) => state.clipSessionToken);
  const playing = usePoseCreatorStore((state) => state.clipPlaybackPlaying);
  const play = usePoseCreatorStore((state) => state.playClipPreview);
  const pause = usePoseCreatorStore((state) => state.pauseClipPreview);
  const stop = usePoseCreatorStore((state) => state.stopClipPreview);
  const restart = usePoseCreatorStore((state) => state.restartClipPreview);
  const updateClipDraft = usePoseCreatorStore((state) => state.updateClipDraft);
  // Loop is the person's choice for the preview, kept across drafts; until
  // they choose, each clip plays as it says.
  const loopChoice = useRef<boolean | null>(null);
  useEffect(() => {
    const choice = loopChoice.current;
    if (
      playable &&
      choice !== null &&
      usePoseCreatorStore.getState().clipDraft.loop !== choice
    )
      updateClipDraft({ loop: choice });
  }, [clipSession, playable, updateClipDraft]);

  const options = useMemo(
    () => [
      // A choice the lists no longer hold stays shown as chosen.
      ...(selectedSource &&
      !modelOptions.some((option) => option.key === selectedSource.key)
        ? [selectedSource]
        : []),
      ...modelOptions,
    ],
    [modelOptions, selectedSource],
  );

  return (
    <CreatorCanvasControls
      model={{
        label: t("preview.avatar"),
        value: selectedSource?.key ?? "",
        placeholder: isModelCatalogPending
          ? t("preview.loadingAvatars")
          : t("preview.chooseAvatar"),
        options: options.map((source) => ({
          value: source.key,
          label: source.displayName,
        })),
        onValueChange: (key) => {
          if (key === selectedSource?.key) return;
          const source = options.find((option) => option.key === key);
          if (source) selectModel(source);
        },
        disabled: options.length === 0,
        triggerClassName: "w-[170px]",
        testId: "generate-avatar-picker",
      }}
      domainControl={
        <>
          {modelCatalogError ? (
            // A list of Avatars could not be read: say so and offer the
            // creator's own retry.
            <span
              className="text-muted-foreground flex items-center gap-1 text-xs"
              role="status"
            >
              {modelCatalogError}
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={tPose("preview.retryModels")}
                title={tPose("preview.retryModels")}
                onClick={() => void retryModels()}
              >
                <RefreshCwIcon className="size-4" />
              </Button>
            </span>
          ) : null}
          <label className="flex shrink-0 items-center gap-2 text-xs">
            <Switch
              checked={playable && loop}
              disabled={!playable}
              aria-label={t("preview.loopLabel")}
              data-testid="generate-preview-loop"
              onCheckedChange={(checked) => {
                loopChoice.current = checked;
                updateClipDraft({ loop: checked });
              }}
            />
            <span className="text-muted-foreground shrink-0">
              {t("preview.loop")}
            </span>
          </label>
        </>
      }
      playbackControl={
        <CreatorTimelineTransport
          label={t("preview.target")}
          playing={playing}
          onTogglePlayback={playing ? pause : play}
          onStop={stop}
          onRestart={restart}
          playDisabled={!playable}
          stopDisabled={!playable}
          restartDisabled={!playable}
        />
      }
    />
  );
}
