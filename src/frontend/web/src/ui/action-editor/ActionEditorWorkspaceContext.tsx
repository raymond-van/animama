import { createContext, useContext, type ReactNode } from "react";

import type {
  PyCatalogViewItem,
  PyGesture,
  PyReaction,
} from "@/lib/content/catalogTypes";
import type { CreatorHistoryController } from "@/ui/creator-history/CreatorHistory";
import type { ActionComponentType } from "./actionDependencies";
import type {
  ActionAuthoringSnapshot,
  ActionDocument,
  ActionDocumentIssue,
} from "./actionDocument";
import type { ActionEditorMode } from "./actionEditorCapabilities";
import type { ActionImport } from "./actionProject";

export type ActionSaveStage = "idle" | "preparing" | "uploading" | "saving";

export type ActionDependencySection = {
  label: string;
  contentType: ActionComponentType;
  items: PyCatalogViewItem[];
  isPending: boolean;
  errorMessage: string | null;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => Promise<unknown>;
  retry: () => Promise<unknown>;
};

export type ActionEditorWorkspaceValue = {
  document: ActionDocument;
  setDocument: (updater: (current: ActionDocument) => ActionDocument) => void;
  history: CreatorHistoryController<ActionAuthoringSnapshot>;
  mode: ActionEditorMode;
  setMode: (mode: ActionEditorMode) => void;
  busy: boolean;
  dirty: boolean;
  saveStage: ActionSaveStage;
  issues: ActionDocumentIssue[];
  /** True after a save action asks the user to resolve validation errors. */
  validationAttempted: boolean;
  error: string | null;
  /** Canonical creator control associated with the current save failure. */
  errorField: string | null;
  clearSaveErrorField: (field: string) => void;
  itemId?: string;
  identityExists: boolean;
  /** Changes whenever New, Load, or Import replaces the authored document. */
  timelineSession: number;
  dependencyQuery: string;
  setDependencyQuery: (query: string) => void;
  activeDependencyType: ActionComponentType;
  setActiveDependencyType: (contentType: ActionComponentType) => void;
  dependencySections: ActionDependencySection[];
  /** Add one effect and dependency atomically, returning its timeline event ID. */
  addComponent: (
    item: PyCatalogViewItem,
    contentType: ActionComponentType,
    options?: { timeSec?: number },
  ) => string | undefined;
  removeDependency: (alias: string) => void;
  mapDependency: (
    alias: string,
    item: PyCatalogViewItem,
    contentType: ActionComponentType,
  ) => void;
  /** Replace the workspace with an Included Starter clip as a Local copy. */
  loadStarter: (item: PyGesture | PyReaction) => Promise<void>;
  /** Restore one owned valid catalog item directly into the workspace. */
  loadOwned: (item: PyGesture | PyReaction) => Promise<void>;
  applyImport: (value: ActionImport) => void;
  /**
   * Make the creator ready for a content assistant run and return the
   * document the run starts from (`prepareCreatorForAssistantRun`): a
   * keyframe's pose being edited in Pose mode is applied, and the creator
   * moves to Clip. `null` when the run must not start: the pose editor holds
   * an unsaved pose of its own, which the result would discard.
   */
  prepareAssistantRun: () => ActionDocument | null;
  /**
   * What the pose editor holds that an assistant result would lose
   * (`pendingActionEditorPoseEdit`); a result is not applied over either.
   */
  pendingPoseEdit: () => "pose_draft" | "keyframe_edit" | null;
  /**
   * Put the content assistant's result (a draft's project) into the document,
   * keeping the item's own details, effects and dependencies
   * (`applyAssistantProject`). A run's first result is one new history entry;
   * with `replace`, a later version of the same run takes that entry's place,
   * so the whole run stays one undoable change. Returns the document it
   * becomes and whether it differs from the one before; throws a worded
   * error for a result that cannot be applied.
   */
  applyAssistantResult: (
    project: unknown,
    options?: { replace?: boolean },
  ) => { document: ActionDocument; changed: boolean };
  /** Start a blank document and synchronize the canonical new-content route. */
  startNew: () => Promise<void>;
  vrma: File | null;
  setVrma: (file: File | null) => void;
  /** True while exact component resources are entering the local sandbox. */
  localPreviewPending: boolean;
  save: () => Promise<void>;
  saveAndEquip: () => Promise<void>;
};

const ActionEditorWorkspaceContext =
  createContext<ActionEditorWorkspaceValue | null>(null);

export function ActionEditorWorkspaceProvider({
  value,
  children,
}: {
  value: ActionEditorWorkspaceValue;
  children: ReactNode;
}) {
  return (
    <ActionEditorWorkspaceContext.Provider value={value}>
      {children}
    </ActionEditorWorkspaceContext.Provider>
  );
}

export function useActionEditorWorkspace(): ActionEditorWorkspaceValue {
  const value = useContext(ActionEditorWorkspaceContext);
  if (!value) {
    throw new Error(
      "useActionEditorWorkspace must be used inside ActionEditorWorkspaceProvider",
    );
  }
  return value;
}
