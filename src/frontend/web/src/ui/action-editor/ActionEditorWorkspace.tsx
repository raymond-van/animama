import { useProductApiClient } from "@animama/product-ui";
import { useFormatters } from "@animama/product-ui/i18n";
import type { TFunction } from "i18next";
import { getI18n, useTranslation } from "react-i18next";

import {
  BoneIcon,
  HandIcon,
  Clock3Icon,
  LibraryIcon,
  Settings2Icon,
  SlidersHorizontalIcon,
  SmileIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useRef,
  type ComponentType,
  type ReactNode,
} from "react";
import { PoseCreatorHandPanel } from "@/ui/pose-creator/PoseCreatorHandPanel";
import { usePoseCreatorHands } from "@/ui/pose-creator/usePoseCreatorHands";
import { handPanelLayout } from "./handPanelLayout";

import {
  ANIMA_POSE_SCHEMA,
  parseAnimaPose,
  type AnimaPose,
  type AnimaPoseSnapshot,
} from "@/lib/avatar";
import { usePoses } from "@/query/hooks/usePoses";
import {
  apiErrorLine,
  apiErrorText,
  readApiError,
  WordedError,
} from "@/lib/errors/apiError";
import { cn } from "@/lib/utils";
import {
  DEFAULT_POSE_CREATOR_BASE_POSE,
  selectCanRedoClip,
  selectCanRedoPose,
  selectCanUndoPose,
  selectCanUndoClip,
  POSE_CREATOR_VRM_T_POSE_BASE_POSE_ID,
  usePoseCreatorStore,
} from "@/stores/pose-creator-store";
import { Button } from "@/ui/components/button";
import { PlaybackObservationOutput } from "@/ui/avatar-preview/PlaybackObservationOutput";
import { Input } from "@/ui/components/input";
import {
  CreatorHistoryShortcut,
  type CreatorHistoryController,
} from "@/ui/creator-history/CreatorHistory";
import {
  ActionEditorBoneSection,
  ActionEditorClipInspector,
  ActionEditorClipPreviewSync,
  ActionEditorExpressionSection,
  ActionEditorPreviewSettings,
  replaceActionEditorPose,
} from "./ActionEditorPrimitives";
import {
  commitActionEditorInlineKeyframe,
  editActionEditorSavedPose,
  insertActionEditorSavedPose,
  setActionEditorAuthoringMode,
} from "./actionEditorSavedPose";
import { ActionCatalogDragProvider } from "./ActionCatalogDrag";
import { ActionEditorScene } from "./ActionEditorScene";
import { ActionEventList } from "./ActionEventList";
import { ActionEditorEffectsPanel } from "./ActionEditorEffectsPanel";
import { ActionEditorHeader } from "./ActionEditorHeader";
import {
  ActionTimelineDocumentSync,
  ActionTimelineEditor,
} from "./ActionTimelineEditor";
import {
  CreatorCollapsedPanelHeader,
  CreatorPanelCollapseButton,
} from "./CreatorPanelChrome";
import {
  ReactionEmotionSettings,
  ReactionTimelineSettings,
} from "./ReactionTimelineSettings";
import { useActionEditorWorkspace } from "./ActionEditorWorkspaceContext";
import { useActionEditorPreview } from "./ActionEditorPreviewProvider";
import { useSceneVFXStore } from "@/stores/scene-vfx-store";
import { pruneUnusedTimelineDependencies } from "./actionDependencies";
import { actionEditorCapabilities } from "./actionEditorCapabilities";
import { retainActionEditorWorkspace } from "./actionEditorStoreLifecycle";
import { findPoseCreatorClipKeyframeAtTime } from "@/ui/pose-creator/poseCreatorClipAuthoring";
import { samplePoseCreatorDraft } from "@/ui/pose-creator/poseCreatorClipMotion";
import { samplePoseCreatorClipExpressions } from "@/ui/pose-creator/poseCreatorClipPreview";
import { useActionEditorDesktopLayout } from "./useActionEditorDesktopLayout";
import { CreatorGenerateControl } from "@/ui/generate/creator/CreatorGenerateControl";
import { GenerationPreviewRendererBridge } from "@/ui/generate/GenerationPreviewRendererBridge";

/** Capture a keyframe before entering inline editing at an unselected playhead. */
export function captureActionEditorPoseAtPlayhead(): boolean {
  const state = usePoseCreatorStore.getState();
  const t = getI18n().getFixedT(null, "actionEditor");
  try {
    const draft = state.clipDraft;
    const sample = samplePoseCreatorDraft(draft, draft.currentTimeSec, null);
    if (sample?.diagnostics.missingPoseRefs.length)
      throw new WordedError(t("workspace.capture.posesUnavailable"));
    state.captureClipPoseAtPlayhead();
    return true;
  } catch (error) {
    state.setImportError(
      apiErrorLine(
        apiErrorText(readApiError(error), null, t("workspace.capture.failed")),
      ),
    );
    return false;
  }
}

type MobileTool =
  | "timeline"
  | "components"
  | "inspector"
  | "settings"
  | "bones"
  | "expressions";

type ToolOption = {
  id: MobileTool;
  icon: ComponentType<{ className?: string }>;
};

const CLIP_TOOLS: ToolOption[] = [
  { id: "timeline", icon: Clock3Icon },
  { id: "components", icon: LibraryIcon },
  { id: "inspector", icon: SlidersHorizontalIcon },
  { id: "settings", icon: Settings2Icon },
];

const REACTION_TOOLS: ToolOption[] = [
  { id: "timeline", icon: Clock3Icon },
  { id: "expressions", icon: SmileIcon },
  { id: "components", icon: LibraryIcon },
  { id: "inspector", icon: SlidersHorizontalIcon },
];

const POSE_TOOLS: ToolOption[] = [
  { id: "bones", icon: BoneIcon },
  { id: "expressions", icon: SmileIcon },
  { id: "settings", icon: Settings2Icon },
];

/** Tab label for a mobile tool; Pose mode's settings tab holds the preview controls. */
function toolLabel(
  t: TFunction<"actionEditor">,
  tool: MobileTool,
  pose: boolean,
): string {
  switch (tool) {
    case "timeline":
      return t("workspace.tools.timeline");
    case "components":
      return t("workspace.tools.effects");
    case "inspector":
      return t("workspace.tools.inspector");
    case "settings":
      return pose
        ? t("workspace.tools.preview")
        : t("workspace.tools.settings");
    case "bones":
      return t("workspace.tools.bones");
    case "expressions":
      return t("workspace.tools.expressions");
  }
}

/** Immersive product editor shared by typed Gesture and Reaction routes. */
export function ActionEditorWorkspace() {
  return (
    <ActionCatalogDragProvider>
      <ActionEditorWorkspaceContent />
    </ActionCatalogDragProvider>
  );
}

function ActionEditorWorkspaceContent() {
  const { t } = useTranslation("actionEditor");
  const workspace = useActionEditorWorkspace();
  const capabilities = actionEditorCapabilities(workspace.document.intent);
  const timelineBased = workspace.document.implementation === "anima_clip";
  const desktopLayout = useActionEditorDesktopLayout();
  const handsEnabled =
    timelineBased &&
    workspace.document.intent === "gesture" &&
    workspace.mode === "pose";
  const hands = usePoseCreatorHands(handsEnabled);
  const handStageRef = useRef<HTMLDivElement>(null);
  const handToggleRef = useRef<HTMLButtonElement>(null);
  const [handPlacement, setHandPlacement] = useState({
    adjacent: false,
    left: 16,
  });
  useEffect(() => {
    const stage = handStageRef.current;
    if (!stage || !desktopLayout) return;
    const measure = () =>
      setHandPlacement(
        handPanelLayout(
          stage.getBoundingClientRect().width,
          window.innerWidth,
          parseFloat(
            getComputedStyle(stage).getPropertyValue(
              "--app-shell-sidebar-inset",
            ),
          ) || 0,
        ),
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [desktopLayout, handsEnabled]);
  const [mobileTool, setMobileTool] = useState<MobileTool>("timeline");
  const [componentsExpanded, setComponentsExpanded] = useState(true);
  const [showTimelineEvents, setShowTimelineEvents] = useState(true);
  const [timelineExpanded, setTimelineExpanded] = useState(true);
  const [timelineHeight, setTimelineHeight] = useState(170);
  const timelinePanelBottom = timelineExpanded ? timelineHeight + 20 : 80;
  const [bonesExpanded, setBonesExpanded] = useState(true);
  const [expressionsExpanded, setExpressionsExpanded] = useState(true);
  const collapseBones = () => {
    hands.setOpen(false);
    setBonesExpanded(false);
  };
  const closeHands = () => {
    hands.setOpen(false);
    setBonesExpanded(true);
    requestAnimationFrame(() => handToggleRef.current?.focus());
  };
  const handToggle = handsEnabled ? (
    <Button
      ref={handToggleRef}
      type="button"
      variant="outline"
      size="icon-sm"
      aria-label={
        hands.open ? t("workspace.hands.hide") : t("workspace.hands.show")
      }
      aria-pressed={hands.open}
      disabled={!hands.canEdit}
      title={t("workspace.hands.title")}
      className={cn(
        "bg-background size-11 shrink-0 rounded-lg shadow-none lg:size-9",
        hands.open && "border-primary/40 bg-primary/8 text-primary",
      )}
      onClick={() => hands.setOpen(!hands.open)}
    >
      <HandIcon className="size-4" />
    </Button>
  ) : undefined;
  const collapseExpressions = useCallback(
    () => setExpressionsExpanded(false),
    [],
  );
  const activeAvatar = usePoseCreatorStore((state) => state.activeAvatar);
  const selectedBone = usePoseCreatorStore((state) => state.selectedBone);
  const clipInlineEdit = usePoseCreatorStore((state) => state.clipInlineEdit);
  const clipDraft = usePoseCreatorStore((state) => state.clipDraft);
  const clipPlaybackPlaying = usePoseCreatorStore(
    (state) => state.clipPlaybackPlaying,
  );
  const clipPlaybackAbsoluteTimeSec = usePoseCreatorStore(
    (state) => state.clipPlaybackAbsoluteTimeSec,
  );
  const loadStatus = usePoseCreatorStore((state) => state.loadStatus);
  const loadError = usePoseCreatorStore((state) => state.loadError);
  const preview = useActionEditorPreview();
  const sceneVFXActiveByKind = useSceneVFXStore((state) => state.activeByKind);
  const sceneVFX = useMemo(
    () =>
      Object.values(sceneVFXActiveByKind).filter(
        (entry): entry is NonNullable<typeof entry> => Boolean(entry),
      ),
    [sceneVFXActiveByKind],
  );
  const setClipExpressionsAtPlayhead = usePoseCreatorStore(
    (state) => state.setClipExpressionsAtPlayhead,
  );
  const setAuthoringMode = usePoseCreatorStore(
    (state) => state.setAuthoringMode,
  );
  const resetWorkspace = usePoseCreatorStore((state) => state.resetWorkspace);
  const historyController = useActionHistoryController(
    workspace.history,
    Boolean(clipInlineEdit),
  );

  useEffect(() => {
    setAuthoringMode("clip");
  }, [setAuthoringMode]);
  useEffect(
    () => retainActionEditorWorkspace(resetWorkspace),
    [resetWorkspace],
  );

  const sampledExpressionValues = useMemo(
    () => samplePoseCreatorClipExpressions(clipDraft),
    [clipDraft],
  );
  const observationExpressionNames = useMemo(
    () => Object.keys(clipDraft.motion.expressions ?? {}).sort(),
    [clipDraft.motion],
  );
  const expressionKeyframeAtPlayhead = useMemo(
    () =>
      findPoseCreatorClipKeyframeAtTime(
        clipDraft.keyframes,
        clipDraft.currentTimeSec,
      ),
    [clipDraft.currentTimeSec, clipDraft.keyframes],
  );
  const updateExpressionAtPlayhead = useCallback(
    (expressionName: string, value: number) => {
      const next = { ...sampledExpressionValues };
      if (Math.abs(value) <= 1e-6) delete next[expressionName];
      else next[expressionName] = value;
      setClipExpressionsAtPlayhead(next);
    },
    [sampledExpressionValues, setClipExpressionsAtPlayhead],
  );
  const clearExpressionsAtPlayhead = useCallback(
    () => setClipExpressionsAtPlayhead({}),
    [setClipExpressionsAtPlayhead],
  );
  const ensureExpressionKeyframeAtPlayhead = useCallback(() => {
    setClipExpressionsAtPlayhead(sampledExpressionValues);
    const state = usePoseCreatorStore.getState();
    const keyframe = findPoseCreatorClipKeyframeAtTime(
      state.clipDraft.keyframes,
      state.clipDraft.currentTimeSec,
    );
    if (keyframe) state.selectClipKeyframe(keyframe.id);
  }, [sampledExpressionValues, setClipExpressionsAtPlayhead]);

  const beginInlineKeyframeEdit = useCallback(() => {
    const state = usePoseCreatorStore.getState();
    if (!state.activeAvatar || state.clipInlineEdit) return false;
    let keyframe = state.clipDraft.keyframes.find(
      (value) => value.id === state.clipDraft.selectedKeyframeId,
    );
    if (!keyframe) {
      if (!captureActionEditorPoseAtPlayhead()) return false;
      const next = usePoseCreatorStore.getState();
      keyframe = next.clipDraft.keyframes.find(
        (value) => value.id === next.clipDraft.selectedKeyframeId,
      );
    }
    if (!keyframe) return false;
    const next = usePoseCreatorStore.getState();
    const alias = keyframe.pose;
    // A beat's key pose is what the creator Avatar plays at its time.
    const sampled = samplePoseCreatorDraft(
      next.clipDraft,
      keyframe.time,
      next.activeAvatar?.vrm ?? null,
      { omittedBasePoseId: POSE_CREATOR_VRM_T_POSE_BASE_POSE_ID },
    )?.sample;
    if (!sampled) return false;
    const pose: AnimaPoseSnapshot = {
      ...(sampled.humanoid ? { humanoid: sampled.humanoid } : {}),
      ...(sampled.expressions ? { expressions: sampled.expressions } : {}),
    };
    const animaPose = clipPoseToAnimaPose(alias, pose);
    const drafts = replaceActionEditorPose(
      next.activeAvatar,
      animaPose,
      next.clipDraft.basePose,
    );
    next.beginClipInlinePoseEdit({
      alias,
      keyframeId: keyframe.id,
      originalPose: pose,
      boneDrafts: drafts.boneDrafts,
      expressionDrafts: drafts.expressionDrafts,
      draftName: "",
    });
    return true;
  }, []);

  useEffect(() => {
    if (
      workspace.mode === "pose" &&
      usePoseCreatorStore.getState().authoringMode !== "pose"
    ) {
      setActionEditorAuthoringMode("pose");
      if (usePoseCreatorStore.getState().authoringMode !== "pose") {
        void beginInlineKeyframeEdit();
      }
    }
  }, [
    activeAvatar,
    beginInlineKeyframeEdit,
    // Same-session document hydration can replace an inline edit without
    // changing the Avatar or mode. Reattach editing to the new keyframe.
    clipInlineEdit,
    workspace.mode,
    // Document sync hydrates the new session before this parent effect runs.
    workspace.timelineSession,
  ]);

  const applyInlineKeyframe = () => {
    commitActionEditorInlineKeyframe();
  };

  const updateTimeline = (sequence: Record<string, unknown>) => {
    workspace.history.commit(
      pruneUnusedTimelineDependencies({
        ...workspace.history.present,
        sequence,
      }),
    );
  };
  const expressionTimelineAction =
    workspace.document.intent === "reaction" ? (
      <Button
        size="sm"
        className="h-8 shrink-0"
        disabled={workspace.busy || Boolean(expressionKeyframeAtPlayhead)}
        title={t("workspace.expressions.addKeyframeTitle")}
        onClick={ensureExpressionKeyframeAtPlayhead}
      >
        {t("workspace.expressions.addKeyframe")}
      </Button>
    ) : null;
  const desktopTimeline = (
    <ActionTimelineEditor
      reaction={workspace.document.intent === "reaction"}
      transportActions={expressionTimelineAction}
      settingsContent={
        workspace.document.intent === "reaction" ? (
          <ReactionTimelineSettings />
        ) : undefined
      }
      isBusy={workspace.busy}
      playbackPending={workspace.localPreviewPending}
      expanded={timelineExpanded}
      onHeightChange={setTimelineHeight}
      onExpandedChange={setTimelineExpanded}
    />
  );
  const mobileTimeline = (
    <ActionTimelineEditor
      variant="mobile"
      reaction={workspace.document.intent === "reaction"}
      transportActions={expressionTimelineAction}
      settingsContent={
        workspace.document.intent === "reaction" ? (
          <ReactionTimelineSettings />
        ) : undefined
      }
      isBusy={workspace.busy}
      playbackPending={workspace.localPreviewPending}
    />
  );
  const visiblePreviewError =
    loadError ??
    preview.modelError ??
    preview.runtimeError ??
    preview.animaError;
  const previewPreparing =
    !preview.modelEntry &&
    (preview.isAnimaPending ||
      preview.isRuntimePending ||
      Boolean(preview.selectedModel));
  const observationStatus = visiblePreviewError
    ? ("error" as const)
    : previewPreparing || loadStatus === "loading"
      ? ("loading" as const)
      : !activeAvatar
        ? ("unavailable" as const)
        : clipPlaybackPlaying
          ? ("playing" as const)
          : ("stopped" as const);
  const observationRuntimeId =
    typeof workspace.document.sequence.id === "string" &&
    workspace.document.sequence.id.trim()
      ? workspace.document.sequence.id
      : `new-${workspace.document.intent}`;

  return (
    <main
      className="bg-background relative flex h-full min-h-0 w-full flex-col overflow-hidden"
      data-playback-surface="creator-stage"
    >
      <PlaybackObservationOutput
        active
        avatar={activeAvatar}
        expressionNames={observationExpressionNames}
        poseClipSample={
          timelineBased
            ? {
                runtimeId: observationRuntimeId,
                active: clipPlaybackPlaying,
                playheadSec: clipPlaybackAbsoluteTimeSec,
                durationSec: clipDraft.duration,
              }
            : undefined
        }
        sceneVFX={sceneVFX}
        status={observationStatus}
        surface="creator-stage"
        target={{
          kind:
            workspace.document.implementation === "vrma"
              ? "animation"
              : "anima_pose_clip",
          runtimeId: observationRuntimeId,
        }}
      />
      <CreatorHistoryShortcut
        controller={historyController}
        isBusy={workspace.busy}
      />
      <ActionTimelineDocumentSync
        key={`timeline-document-${workspace.timelineSession}`}
        sequence={workspace.document.sequence}
        session={workspace.timelineSession}
        reaction={workspace.document.intent === "reaction"}
        onHistoryGroupStart={workspace.history.beginGroup}
        onHistoryGroupEnd={workspace.history.endGroup}
        onChange={updateTimeline}
      />
      <ActionEditorClipPreviewSync
        previewBasePose={
          workspace.document.intent === "reaction"
            ? DEFAULT_POSE_CREATOR_BASE_POSE
            : undefined
        }
      />
      <ActionEditorHeader
        history={historyController}
        onModeChange={(mode) => {
          if (mode === "clip" && clipInlineEdit) applyInlineKeyframe();
          setActionEditorAuthoringMode(mode);
          workspace.setMode(mode);
        }}
      />

      {timelineBased ? (
        desktopLayout ? (
          <div className="relative min-h-0 flex-1 overflow-hidden">
            <ActionEditorScene capabilities={capabilities}>
              {/* Lends the canvas to the assistant's frame review sheets. */}
              <GenerationPreviewRendererBridge />
            </ActionEditorScene>
            <CreatorGenerateControl bottom={timelinePanelBottom + 8} />
            {workspace.mode === "pose" ? (
              <div
                ref={handStageRef}
                className="pointer-events-none absolute inset-x-0 top-[88px] bottom-0 z-30"
              >
                <ActionEditorBoneSection
                  variant="workspace"
                  browserExpanded={
                    bonesExpanded && !(hands.open && !handPlacement.adjacent)
                  }
                  onCollapse={collapseBones}
                  handToggle={handToggle}
                />
                {handsEnabled && hands.open ? (
                  <aside
                    aria-label={t("workspace.hands.title")}
                    className="border-border/65 bg-background pointer-events-auto absolute top-4 z-30 max-h-[calc(100%-2rem)] w-[280px] overflow-y-auto rounded-2xl border shadow-xl shadow-black/8"
                    style={{ left: handPlacement.left }}
                  >
                    <PoseCreatorHandPanel hands={hands} onClose={closeHands} />
                  </aside>
                ) : null}
                {!bonesExpanded && !hands.open ? (
                  <CreatorCollapsedPanelHeader
                    label={t("workspace.panels.bones")}
                    summary={t("workspace.panels.bonesSummary")}
                    onExpand={() => setBonesExpanded(true)}
                    className="absolute top-4 left-[calc(var(--app-shell-sidebar-inset)+1rem)] w-[248px] transition-[left] duration-150 ease-in-out xl:left-[calc(var(--app-shell-sidebar-inset)+2rem)] xl:w-[288px] 2xl:w-[340px]"
                  />
                ) : null}
                {expressionsExpanded ? (
                  <ActionEditorExpressionSection
                    variant="workspace"
                    onCollapse={collapseExpressions}
                  />
                ) : (
                  <CreatorCollapsedPanelHeader
                    label={t("workspace.panels.expressions")}
                    summary={t("workspace.panels.expressionsSummary")}
                    onExpand={() => setExpressionsExpanded(true)}
                    className={cn(
                      "absolute right-4 w-[248px] xl:right-8 xl:w-[296px] 2xl:w-[308px]",
                      selectedBone ? "top-[19.5rem]" : "top-[5.75rem]",
                    )}
                  />
                )}
                <div className="pointer-events-auto absolute right-[280px] bottom-6 left-[calc(var(--app-shell-sidebar-inset)+280px)] flex justify-center gap-2 transition-[left] duration-150 ease-in-out">
                  <ActionEditorPreviewSettings />
                </div>
              </div>
            ) : (
              <div
                className={cn(
                  "pointer-events-none absolute inset-x-0 bottom-0 z-30",
                  workspace.document.intent === "gesture"
                    ? "top-[88px]"
                    : "top-[72px]",
                )}
              >
                <div
                  className={cn(
                    "pointer-events-auto absolute top-4 left-[calc(var(--app-shell-sidebar-inset)+1rem)] z-20 w-[312px] transition-[left,bottom,height] duration-200 motion-reduce:transition-none xl:left-[calc(var(--app-shell-sidebar-inset)+2rem)] xl:w-[360px] 2xl:w-[392px]",
                    !componentsExpanded && "h-16",
                  )}
                  style={
                    componentsExpanded
                      ? { bottom: timelinePanelBottom }
                      : undefined
                  }
                >
                  <EffectsPanel
                    expanded={componentsExpanded}
                    timelineEnabled={showTimelineEvents}
                    onTimelineEnabledChange={setShowTimelineEvents}
                    onExpandedChange={setComponentsExpanded}
                  />
                </div>
                {showTimelineEvents &&
                (clipDraft.events.length > 0 ||
                  clipDraft.keyframes.length > 0) ? (
                  <div
                    className="pointer-events-auto absolute top-4 left-[calc(var(--app-shell-sidebar-inset)+340px)] z-20 w-[180px] xl:left-[calc(var(--app-shell-sidebar-inset)+404px)] xl:w-[220px] 2xl:left-[calc(var(--app-shell-sidebar-inset)+436px)]"
                    style={{ bottom: timelinePanelBottom }}
                  >
                    <ActionEventList />
                  </div>
                ) : null}
                {workspace.document.intent === "gesture" &&
                (clipDraft.selectedKeyframeId || clipDraft.selectedEventId) ? (
                  <div
                    className={cn(
                      "pointer-events-auto absolute top-4 z-20 w-[248px] overflow-y-auto xl:w-[296px] 2xl:w-[308px]",
                      "right-4 xl:right-8",
                    )}
                    style={{ bottom: timelinePanelBottom }}
                  >
                    <ActionEditorClipInspector
                      section="inspector"
                      allowHumanoid={capabilities.allowsHumanoid}
                    />
                  </div>
                ) : null}
                {workspace.document.intent === "reaction" ? (
                  <div
                    className={cn(
                      "pointer-events-auto absolute top-4 right-4 z-20 flex w-[min(320px,24vw)] flex-col gap-3 transition-[bottom] duration-200 motion-reduce:transition-none xl:right-8 2xl:w-[360px]",
                    )}
                    style={{ bottom: timelinePanelBottom }}
                  >
                    {clipDraft.selectedEventId ||
                    clipDraft.selectedKeyframeId ? (
                      <div
                        className={cn(
                          "min-h-0 overflow-y-auto rounded-xl",
                          expressionsExpanded
                            ? "max-h-[35%] shrink-0"
                            : "flex-1",
                        )}
                      >
                        <ActionEditorClipInspector
                          section="inspector"
                          allowHumanoid={false}
                        />
                      </div>
                    ) : null}
                    <ReactionExpressionPanel
                      expanded={expressionsExpanded}
                      onExpandedChange={setExpressionsExpanded}
                      currentTimeSec={clipDraft.currentTimeSec}
                      hasKeyframe={Boolean(expressionKeyframeAtPlayhead)}
                      values={sampledExpressionValues}
                      onExpressionChange={updateExpressionAtPlayhead}
                      onClear={clearExpressionsAtPlayhead}
                    />
                  </div>
                ) : null}
                <div
                  className={cn(
                    "pointer-events-auto absolute right-4 bottom-4 left-[calc(var(--app-shell-sidebar-inset)+1rem)] z-20 flex justify-center transition-[left,height] duration-200 motion-reduce:transition-none xl:right-8 xl:left-[calc(var(--app-shell-sidebar-inset)+2rem)]",
                  )}
                  style={{ height: timelineExpanded ? timelineHeight : 60 }}
                >
                  {desktopTimeline}
                </div>
              </div>
            )}
          </div>
        ) : (
          <MobileWorkspace
            handToggle={handToggle}
            handPanel={
              handsEnabled && hands.open ? (
                <PoseCreatorHandPanel hands={hands} onClose={closeHands} />
              ) : undefined
            }
            capabilities={capabilities}
            tool={mobileTool}
            onToolChange={(tool) => {
              setMobileTool(tool);
            }}
            timeline={mobileTimeline}
            reactionExpressions={
              <ActionEditorExpressionSection
                variant="mobile"
                timelineValues={sampledExpressionValues}
                onTimelineExpressionChange={updateExpressionAtPlayhead}
                onTimelineExpressionsClear={clearExpressionsAtPlayhead}
              />
            }
          />
        )
      ) : (
        <VrmaWorkspace capabilities={capabilities} />
      )}
    </main>
  );
}

/** Reaction-only facial keyframe authoring, separate from generic selection. */
function ReactionExpressionPanel({
  expanded,
  onExpandedChange,
  currentTimeSec,
  hasKeyframe,
  values,
  onExpressionChange,
  onClear,
}: {
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  currentTimeSec: number;
  hasKeyframe: boolean;
  values: Record<string, number>;
  onExpressionChange: (expressionName: string, value: number) => void;
  onClear: () => void;
}) {
  const { t } = useTranslation("actionEditor");
  const formatters = useFormatters();
  const time = t("time.seconds", {
    value: formatters.number(currentTimeSec, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }),
  });
  return (
    <section
      className={cn(
        "bg-background flex min-h-14 flex-col overflow-hidden rounded-2xl border shadow-xl backdrop-blur-xl",
        expanded ? "min-h-0 flex-1" : "h-auto shrink-0",
      )}
    >
      <div
        className={cn(
          "flex min-h-14 shrink-0 items-center justify-between gap-3 px-3 py-2",
          expanded && "border-border/60 border-b",
        )}
      >
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold">
            {t("workspace.panels.expressions")}
          </h2>
          <p className="text-muted-foreground text-2xs truncate">
            {hasKeyframe
              ? t("workspace.expressions.keyframeAt", { time })
              : t("workspace.expressions.interpolatedAt", { time })}
          </p>
        </div>
        <CreatorPanelCollapseButton
          label={t("workspace.panels.expressions")}
          expanded={expanded}
          collapseDirection="up"
          onExpandedChange={onExpandedChange}
        />
      </div>
      {expanded ? (
        <div className="flex min-h-0 flex-1 flex-col p-3">
          <div className="min-h-0 flex-1">
            <ActionEditorExpressionSection
              variant="mobile"
              embedded
              timelineValues={values}
              onTimelineExpressionChange={onExpressionChange}
              onTimelineExpressionsClear={onClear}
            />
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function useActionHistoryController(
  documentHistory: Pick<
    CreatorHistoryController<unknown>,
    "canRedo" | "canUndo" | "redo" | "undo"
  >,
  inlineEditing: boolean,
) {
  const standalonePose = usePoseCreatorStore(
    (state) => state.authoringMode === "pose",
  );
  const canUndoPose = usePoseCreatorStore(selectCanUndoPose);
  const canRedoPose = usePoseCreatorStore(selectCanRedoPose);
  const undoPose = usePoseCreatorStore((state) => state.undoPose);
  const redoPose = usePoseCreatorStore((state) => state.redoPose);
  const canUndoInline = usePoseCreatorStore(selectCanUndoClip);
  const canRedoInline = usePoseCreatorStore(selectCanRedoClip);
  const undoClip = usePoseCreatorStore((state) => state.undoClip);
  const redoClip = usePoseCreatorStore((state) => state.redoClip);
  return useMemo(
    () => ({
      canUndo: standalonePose
        ? canUndoPose
        : inlineEditing
          ? canUndoInline
          : documentHistory.canUndo,
      canRedo: standalonePose
        ? canRedoPose
        : inlineEditing
          ? canRedoInline
          : documentHistory.canRedo,
      undo: standalonePose
        ? undoPose
        : inlineEditing
          ? undoClip
          : documentHistory.undo,
      redo: standalonePose
        ? redoPose
        : inlineEditing
          ? redoClip
          : documentHistory.redo,
    }),
    [
      standalonePose,
      canUndoPose,
      canRedoPose,
      undoPose,
      redoPose,
      canRedoInline,
      canUndoInline,
      documentHistory,
      inlineEditing,
      redoClip,
      undoClip,
    ],
  );
}

function clipPoseToAnimaPose(
  alias: string,
  pose: AnimaPoseSnapshot,
): AnimaPose {
  return parseAnimaPose({
    schema: ANIMA_POSE_SCHEMA,
    id: alias,
    name: `Keyframe ${alias}`,
    ...(pose.humanoid ? { humanoid: pose.humanoid } : {}),
    ...(pose.expressions ? { expressions: pose.expressions } : {}),
  });
}

function EffectsPanel({
  mobile = false,
  expanded = true,
  onExpandedChange,
  onTimelineItemSelect,
  timelineEnabled: controlledTimelineEnabled,
  onTimelineEnabledChange,
}: {
  mobile?: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  onTimelineItemSelect?: () => void;
  timelineEnabled?: boolean;
  onTimelineEnabledChange?: (enabled: boolean) => void;
}) {
  const apiClient = useProductApiClient();

  const [localTimelineEnabled, setLocalTimelineEnabled] = useState(true);
  const timelineEnabled = controlledTimelineEnabled ?? localTimelineEnabled;
  const setTimelineEnabled = onTimelineEnabledChange ?? setLocalTimelineEnabled;
  const hasItems = usePoseCreatorStore(
    (state) =>
      state.clipDraft.events.length + state.clipDraft.keyframes.length > 0,
  );
  const workspace = useActionEditorWorkspace();
  const gesture = workspace.document.intent === "gesture";
  const posesQuery = usePoses({ enabled: gesture });
  const savedPoses = posesQuery.data?.items ?? [];
  const live = useRef(workspace);
  live.current = workspace;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const isCurrent = () =>
    alive.current &&
    live.current.timelineSession === workspace.timelineSession &&
    live.current.document.intent === "gesture" &&
    live.current.mode === workspace.mode;
  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <ActionEditorEffectsPanel
          onCreatePose={() => workspace.setMode("pose")}
          mobile={mobile}
          expanded={expanded}
          onExpandedChange={onExpandedChange}
          query={workspace.dependencyQuery}
          onQueryChange={workspace.setDependencyQuery}
          activeType={workspace.activeDependencyType}
          onActiveTypeChange={workspace.setActiveDependencyType}
          sections={workspace.dependencySections}
          dependencies={workspace.document.dependencies}
          onAdd={workspace.addComponent}
          timelineEnabled={timelineEnabled}
          onTimelineEnabledChange={setTimelineEnabled}
          poses={gesture ? savedPoses : undefined}
          posesPending={posesQuery.isPending}
          posesError={
            posesQuery.error
              ? apiErrorLine(apiErrorText(readApiError(posesQuery.error), null))
              : null
          }
          onRetryPoses={() => void posesQuery.refetch()}
          onEditPose={
            gesture
              ? (pose) => {
                  void editActionEditorSavedPose(apiClient, pose, {
                    isCurrent,
                  }).then((loaded) => {
                    if (loaded && isCurrent()) workspace.setMode("pose");
                  });
                }
              : undefined
          }
          onAddPose={
            gesture
              ? (pose) => {
                  void insertActionEditorSavedPose(apiClient, pose, {
                    isCurrent,
                  });
                }
              : undefined
          }
        />
      </div>
      {mobile && timelineEnabled && hasItems ? (
        <div className="max-h-[40%] shrink-0 overflow-y-auto p-2">
          <ActionEventList onSelect={onTimelineItemSelect} />
        </div>
      ) : null}
    </div>
  );
}

function MobileWorkspace({
  handToggle,
  handPanel,
  capabilities,
  tool,
  onToolChange,
  timeline,
  reactionExpressions,
}: {
  handToggle?: ReactNode;
  handPanel?: ReactNode;
  capabilities: ReturnType<typeof actionEditorCapabilities>;
  tool: MobileTool;
  onToolChange: (tool: MobileTool) => void;
  timeline: React.ReactNode;
  reactionExpressions: React.ReactNode;
}) {
  const { t } = useTranslation("actionEditor");
  const workspace = useActionEditorWorkspace();
  const pose = workspace.mode === "pose";
  const tools = pose
    ? POSE_TOOLS
    : workspace.document.intent === "reaction"
      ? REACTION_TOOLS
      : CLIP_TOOLS;
  const activeTool = tools.some((option) => option.id === tool)
    ? tool
    : tools[0]!.id;
  return (
    // Tablet widths keep the stacked layout clear of the sidebar's icon rail.
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden pl-[var(--app-shell-sidebar-inset)]">
      <div className="h-[38dvh] min-h-[230px] shrink-0">
        <ActionEditorScene capabilities={capabilities} />
      </div>
      <nav
        className="border-border bg-background overflow-x-auto border-y p-2"
        aria-label={t("workspace.tools.label")}
      >
        <div className="flex w-max min-w-full gap-1" role="tablist">
          {tools.map((option) => {
            const Icon = option.icon;
            return (
              <Button
                key={option.id}
                variant="ghost"
                className={cn(
                  "h-10 min-w-24 gap-1.5 text-xs",
                  activeTool === option.id && "bg-muted",
                )}
                role="tab"
                aria-selected={activeTool === option.id}
                onClick={() => onToolChange(option.id)}
              >
                <Icon className="size-4" />
                {toolLabel(t, option.id, pose)}
              </Button>
            );
          })}
        </div>
      </nav>
      <section className="bg-background min-h-0 flex-1 overflow-hidden">
        {activeTool === "timeline" ? (
          timeline
        ) : activeTool === "components" ? (
          <EffectsPanel
            mobile
            onTimelineItemSelect={() => onToolChange("inspector")}
          />
        ) : activeTool === "inspector" ? (
          <ActionEditorClipInspector
            variant="mobile"
            section="inspector"
            allowHumanoid={capabilities.allowsHumanoid}
          />
        ) : activeTool === "settings" ? (
          pose ? (
            <ActionEditorPreviewSettings variant="mobile" />
          ) : (
            <div className="p-3">
              <ActionEditorClipInspector section="settings" />
            </div>
          )
        ) : activeTool === "bones" ? (
          handPanel ? (
            <div className="h-full overflow-y-auto overscroll-contain">
              {handPanel}
            </div>
          ) : (
            <ActionEditorBoneSection variant="mobile" handToggle={handToggle} />
          )
        ) : workspace.document.intent === "reaction" ? (
          reactionExpressions
        ) : (
          <ActionEditorExpressionSection variant="mobile" />
        )}
      </section>
    </div>
  );
}

function VrmaWorkspace({
  capabilities,
}: {
  capabilities: ReturnType<typeof actionEditorCapabilities>;
}) {
  const { t } = useTranslation("actionEditor");
  const workspace = useActionEditorWorkspace();
  return (
    <div className="grid min-h-0 flex-1 lg:grid-cols-[1fr_22rem]">
      <ActionEditorScene capabilities={capabilities} />
      <aside className="border-border overflow-y-auto border-l p-5">
        {workspace.document.intent === "reaction" ? (
          <ReactionEmotionSettings />
        ) : null}
        <label
          className={cn(
            "mt-5 grid gap-2 rounded-lg text-sm font-medium",
            workspace.errorField === "files" &&
              "bg-destructive/5 text-destructive ring-destructive/40 p-2 ring-1",
          )}
        >
          {t("workspace.vrma.label")}
          <Input
            type="file"
            accept=".vrma,model/gltf-binary"
            aria-invalid={workspace.errorField === "files"}
            onChange={(event) => {
              workspace.clearSaveErrorField("files");
              workspace.setVrma(event.target.files?.[0] ?? null);
            }}
          />
        </label>
        <p className="text-muted-foreground mt-3 text-xs">
          {t("workspace.vrma.description")}
        </p>
      </aside>
    </div>
  );
}
