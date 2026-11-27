import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  PyGenerationDraft,
  PyGenerationMessage,
} from "@animama/runtime-contracts/api-types";

import { useGenerationConversation } from "@/query/hooks/useGeneration";
import {
  generationRunDraftIds,
  generationRunWorkingDraftIds,
} from "@/stores/generation-store";
import { AppShellPage } from "@/ui/app/AppShellPage";
import { Button } from "@/ui/components/button";
import {
  CreatorFloatingPanel,
  CreatorLoading,
  CreatorWorkspaceShell,
} from "@/ui/content-creator";
import { SidebarMenuButton } from "@/ui/sidebar/SidebarMenuButton";
import { GenerateConversation } from "./GenerateConversation";
import { GenerateDraftList } from "./GenerateDraftList";
import { GenerateConversationMenu, GenerateHeader } from "./GenerateHeader";
import { GenerateModelControl } from "./GenerateModelControl";
import {
  GeneratePreviewControls,
  GeneratePreviewProvider,
  GeneratePreviewStage,
  useGeneratePreviewAvatarExpressions,
  useGeneratePreviewPlayer,
} from "./GeneratePreview";
import { GenerateSetup } from "./GenerateSetup";
import { draftBatchInfo } from "./generationBatch";
import { useDraftEffects, type DraftEffectsView } from "./useDraftEffects";
import { useDraftWorker } from "./useDraftWorker";
import {
  useGenerationConversationChoice,
  type GenerationConversationChoice,
  type OpenGenerationConversation,
} from "./useGenerationConversationChoice";
import {
  useGenerationModel,
  type GenerationModelChoice,
} from "./useGenerationModel";
import { useGenerationRun } from "./useGenerationRun";
import { useSelectedDraft } from "./useSelectedDraft";

/** The creators' full-bleed page: the stage fills it and panels float above. */
const STAGE_PAGE = {
  sidebarBehavior: "adaptive-canvas",
  className: "overflow-hidden",
  contentClassName: "h-full max-w-none gap-0 px-0 py-0 md:px-0 lg:px-0",
} as const;

/** One array for every render without drafts, so their readers stay still. */
const NO_DRAFTS: readonly PyGenerationDraft[] = [];
const NO_MESSAGES: readonly PyGenerationMessage[] = [];

/** What the workspace takes from the page above its preview. */
type GenerateWorkspaceProps = {
  modelChoice: GenerationModelChoice;
  conversations: GenerationConversationChoice;
  onOpenSetup: () => void;
};

/**
 * One conversation's workspace inside the preview that plays its drafts. The
 * conversation and the selection are read here, above the preview provider:
 * the provider mounts the selected draft's effects (R5.3), so it has to know
 * the selection that the workspace inside it shows and changes.
 */
function GenerateConversationWorkspace(props: GenerateWorkspaceProps) {
  const { conversationId } = props.conversations;
  const conversation = useGenerationConversation(conversationId);
  const snapshot = conversation.data;
  const drafts = snapshot?.drafts ?? NO_DRAFTS;
  const selection = useSelectedDraft(conversationId, snapshot);
  const effects = useDraftEffects(drafts, selection[0]);
  return (
    <GeneratePreviewProvider sandboxEntries={effects.sandboxEntries}>
      <GenerateWorkspace
        {...props}
        conversation={conversation}
        selection={selection}
        effects={effects.byDraft}
      />
    </GeneratePreviewProvider>
  );
}

/**
 * The three areas around the stage: the conversation, the preview and the
 * drafts, wired to one conversation's run and to the page's draft worker.
 * Rendered inside the preview provider, whose Avatar the run and the checks
 * read expression names from.
 */
function GenerateWorkspace({
  modelChoice,
  conversations,
  onOpenSetup,
  conversation,
  selection,
  effects,
}: GenerateWorkspaceProps & {
  /** The open conversation, as read above the preview provider. */
  conversation: ReturnType<typeof useGenerationConversation>;
  /** The selected draft and how to change the selection (`useSelectedDraft`). */
  selection: ReturnType<typeof useSelectedDraft>;
  /** What each draft that plays effects shows of them, by draft id. */
  effects: DraftEffectsView["byDraft"];
}) {
  const { t } = useTranslation("generate");
  const { conversationId } = conversations;
  const snapshot = conversation.data;
  const drafts = snapshot?.drafts ?? NO_DRAFTS;
  const expressions = useGeneratePreviewAvatarExpressions();
  // Opened from the header, and from a failed run's "Choose another model".
  const [modelControlOpen, setModelControlOpen] = useState(false);
  // The kind a new draft is written as (R7.2); a conversation's drafts may
  // be of both kinds.
  const [newDraftKind, setNewDraftKind] = useState<"gesture" | "reaction">(
    "gesture",
  );
  const controller = useGenerationRun({
    conversationId,
    modelProviderId: modelChoice.model?.id ?? null,
    reasoningEffort: modelChoice.effort,
    avatarExpressionNames: expressions?.names ?? null,
    arkitNames: expressions?.arkitNames,
  });
  const worker = useDraftWorker({
    conversationId,
    drafts,
    // `undefined` while the Avatar loads; `null` when none can be shown.
    avatarExpressionNames: expressions ? expressions.names : expressions,
  });
  const [selectedDraft, selectDraft] = selection;
  const validation = selectedDraft
    ? worker.validations[selectedDraft.id]
    : undefined;
  const player = useGeneratePreviewPlayer(selectedDraft, validation);
  const { running, batch, draftPhases, itemFailures } = controller.run;
  // Each batch draft's brief, step and failure: from the run in flight, and
  // from the stored turns after a reload.
  const messages = snapshot?.messages ?? NO_MESSAGES;
  const batchInfo = useMemo(
    () =>
      draftBatchInfo({
        drafts,
        messages,
        run: { running, batch, draftPhases, itemFailures },
      }),
    [drafts, messages, running, batch, draftPhases, itemFailures],
  );
  // A run closes the model control for good: left open in state, it would
  // open again by itself when the run ends.
  if (running && modelControlOpen) setModelControlOpen(false);
  const opening = !snapshot && !conversation.isError;
  const title = snapshot?.conversation.title.trim();

  return (
    <CreatorWorkspaceShell
      canvas={
        <GeneratePreviewStage
          draft={selectedDraft}
          validation={validation}
          player={player}
          hasDrafts={drafts.length > 0}
        />
      }
      toolbar={
        <GenerateHeader
          conversationMenu={
            <GenerateConversationMenu
              choice={conversations}
              running={running}
              currentIsEmpty={
                !snapshot ||
                (snapshot.messages.length === 0 && drafts.length === 0)
              }
            />
          }
          modelControl={
            <GenerateModelControl
              choice={modelChoice}
              disabled={running}
              onOpenSetup={onOpenSetup}
              usage={snapshot?.usage}
              open={modelControlOpen}
              onOpenChange={setModelControlOpen}
            />
          }
        />
      }
      leftPanelLabel={t("page.panels.conversation")}
      rightPanelLabel={t("page.panels.drafts")}
      leftPanelWidth={440}
      leftPanel={
        <CreatorFloatingPanel
          title={t("page.panels.conversation")}
          summary={title || t("header.untitled")}
          bodyClassName="flex flex-col overflow-hidden p-0"
        >
          <GenerateConversation
            // Another conversation starts with an empty request field.
            key={conversationId ?? "none"}
            snapshot={snapshot}
            isLoading={opening}
            loadFailed={conversation.isError && !snapshot}
            onReload={() => void conversation.refetch()}
            controller={controller}
            selectedDraft={selectedDraft}
            onStartNewDraft={() => selectDraft(null)}
            onChooseModel={() => setModelControlOpen(true)}
            framesStatus={worker.frames.status}
            newDraftKind={{ value: newDraftKind, onChange: setNewDraftKind }}
          />
        </CreatorFloatingPanel>
      }
      rightPanel={
        <CreatorFloatingPanel
          title={t("page.panels.drafts")}
          summary={t("drafts.count", { count: drafts.length })}
          bodyClassName="overflow-y-auto"
        >
          <GenerateDraftList
            drafts={drafts}
            isLoading={opening}
            loadFailed={conversation.isError && !snapshot}
            worker={worker}
            selectedDraftId={selectedDraft?.id ?? null}
            onSelect={selectDraft}
            running={running}
            runDraftIds={generationRunDraftIds(controller.run)}
            workingDraftIds={generationRunWorkingDraftIds(controller.run)}
            batchInfo={batchInfo}
            effects={effects}
          />
        </CreatorFloatingPanel>
      }
      canvasControls={<GeneratePreviewControls playable={player.playable} />}
    />
  );
}

/** A page-level failure with one way on. */
function GeneratePageNotice({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  const { t } = useTranslation("generate");
  return (
    <div className="flex items-start gap-2">
      <SidebarMenuButton />
      <div className="space-y-3" role="alert">
        <h1 className="text-lg font-semibold">{t("page.title")}</h1>
        <p className="text-muted-foreground text-sm">{message}</p>
        <Button type="button" size="sm" variant="outline" onClick={onRetry}>
          {t("page.retry")}
        </Button>
      </div>
    </div>
  );
}

/** The page once the assistant has a model: its conversations and workspace. */
function GenerateConversations({
  modelChoice,
  openConversation,
  onOpenSetup,
}: {
  modelChoice: GenerationModelChoice;
  /** The open conversation's id, held by the page across Model setup. */
  openConversation: OpenGenerationConversation;
  onOpenSetup: () => void;
}) {
  const { t } = useTranslation("generate");
  const conversations = useGenerationConversationChoice(openConversation);
  if (conversations.isError && !conversations.conversationId)
    return (
      <AppShellPage>
        <GeneratePageNotice
          message={t("page.conversationsFailed")}
          onRetry={conversations.retry}
        />
      </AppShellPage>
    );
  return (
    <AppShellPage {...STAGE_PAGE}>
      {conversations.conversationId ? (
        <GenerateConversationWorkspace
          modelChoice={modelChoice}
          conversations={conversations}
          onOpenSetup={onOpenSetup}
        />
      ) : (
        <CreatorLoading message={t("page.loading")} />
      )}
    </AppShellPage>
  );
}

/**
 * The Generate page (R1.1): a conversation with the content assistant, an
 * Avatar preview and the conversation's drafts. Without a usable model it
 * shows setup instead (R1.4), which the model control reopens later.
 */
export function GeneratePage() {
  const { t } = useTranslation("generate");
  const modelChoice = useGenerationModel();
  const [setupOpen, setSetupOpen] = useState(false);
  // Held here, above the workspace, so the conversation the person had open
  // is the one they return to from Model setup.
  const openConversation = useState<string | null>(null);

  if (modelChoice.isPending)
    return (
      <AppShellPage {...STAGE_PAGE}>
        <CreatorLoading message={t("page.loading")} />
      </AppShellPage>
    );
  if (modelChoice.isError && !modelChoice.model)
    return (
      <AppShellPage>
        <GeneratePageNotice
          message={t("page.modelsFailed")}
          onRetry={modelChoice.retry}
        />
      </AppShellPage>
    );
  if (!modelChoice.model || setupOpen)
    return (
      <AppShellPage>
        <GenerateSetup
          choice={modelChoice}
          onDone={() => setSetupOpen(false)}
        />
      </AppShellPage>
    );
  return (
    <GenerateConversations
      modelChoice={modelChoice}
      openConversation={openConversation}
      onOpenSetup={() => setSetupOpen(true)}
    />
  );
}
