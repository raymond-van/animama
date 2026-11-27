import { useEffect, useRef } from "react";
import { useProductApiClient, useRuntimeCacheKey } from "@animama/product-ui";
import * as sdk from "@animama/runtime-contracts/sdk";
import { useProductChatSession } from "@animama/product-ui/chat";
import { useQueryClient } from "@tanstack/react-query";
import { useRuntimeAdmission } from "@/app/runtime/RuntimeAdmissionProvider";
import { SettingsProvider, useSettings } from "@/ui/settings/SettingsProvider";
import {
  saveCatalogItem,
  previewTypedCatalogItem,
  deleteCatalogItem,
} from "@/lib/content/catalogApi";
import {
  createPackageImportApi,
  createPackageExportApi,
} from "@/query/mutations/packageSharingApi";
import { PackageImportSession } from "@/lib/content-sharing/importSession";
import { VerifiedByteLoader } from "@/lib/runtime-content/VerifiedByteLoader";
import { PreviewByteSession } from "@/lib/runtime-content/PreviewByteSession";
import { useRescanContent } from "@/query/hooks/useContentCatalog";
import { useElevenLabsTtsRuntime } from "@/hooks/useElevenLabsTtsRuntime";
import { useAnimaLoadoutMutations } from "@/query/mutations/useAnimaLoadoutMutations";
import { useVoiceSelection } from "@/query/mutations/useVoiceSelection";
import { useVoiceCloneActions } from "@/query/mutations/useVoiceCloneActions";
import { useDeleteContentItem } from "@/query/mutations/useDeleteContentItem";
import { useUpdateAnima } from "@/query/mutations/useUpdateAnima";
import { useUpdateAnimaEmotionalState } from "@/query/mutations/useUpdateAnimaEmotionalState";
import { useRepairAnimaMemories } from "@/query/mutations/useRepairAnimaMemories";
import { useCreateMemoryManagerRun } from "@/query/mutations/useCreateMemoryManagerRun";
import { useCreateReflectionMemoryManagerRun } from "@/query/mutations/useCreateReflectionMemoryManagerRun";
import { useCreateEpisodeProcessingMemoryManagerRun } from "@/query/mutations/useCreateEpisodeProcessingMemoryManagerRun";
import { useAppendMemoryManagerMessage } from "@/query/mutations/useAppendMemoryManagerMessage";
import { useDecideMemoryManagerApproval } from "@/query/mutations/useDecideMemoryManagerApproval";
import { useUndoMemoryManagerApproval } from "@/query/mutations/useUndoMemoryManagerApproval";
import { useCompleteMemoryManagerRun } from "@/query/mutations/useCompleteMemoryManagerRun";
import { queryKeys } from "@/query/keys";

const chatRuntime = {
  runtimeRevision: "fixture-revision",
  canChat: true,
  remountLatest: () => {},
};
const ignoreRoute = () => {};

/** Test observer over the real admitted hooks and modules; the shared router still owns the UI. */
function WorkflowObserver() {
  const client = useProductApiClient();
  const key = useRuntimeCacheKey();
  const settings = useSettings();
  const queryClient = useQueryClient();
  const rescan = useRescanContent();
  const warnings = useRef<string[]>([]);
  const speech = useElevenLabsTtsRuntime({
    onWarning: (_run, reason) => {
      warnings.current.push(reason);
    },
  });
  const loadout = useAnimaLoadoutMutations("fixture-anima");
  const voice = useVoiceSelection("fixture-anima");
  const clones = useVoiceCloneActions();
  // A clone is deleted through the shared content delete, as the app does.
  const removeContent = useDeleteContentItem().mutateAsync;
  const updateAnima = useUpdateAnima();
  const emotion = useUpdateAnimaEmotionalState();
  const repair = useRepairAnimaMemories();
  const chat = useProductChatSession({
    animaId: "fixture-anima",
    runtime: chatRuntime,
    openDraftChatRoute: ignoreRoute,
    replaceChatRoute: ignoreRoute,
  });
  const general = useCreateMemoryManagerRun(),
    reflect = useCreateReflectionMemoryManagerRun(),
    episodes = useCreateEpisodeProcessingMemoryManagerRun();
  const append = useAppendMemoryManagerMessage(),
    decide = useDecideMemoryManagerApproval(),
    undo = useUndoMemoryManagerApproval(),
    complete = useCompleteMemoryManagerRun();
  useEffect(() => {
    const observer = {
      client,
      key,
      settings,
      sdk,
      saveCatalogItem,
      previewTypedCatalogItem,
      deleteCatalogItem,
      createPackageImportApi,
      createPackageExportApi,
      PackageImportSession,
      VerifiedByteLoader,
      PreviewByteSession,
      rescan: rescan.mutateAsync,
      speech,
      warnings: warnings.current,
      loadout,
      voice: voice.mutateAsync,
      clones: {
        save: clones.saveVoiceClone.mutateAsync,
        rename: clones.renameVoiceClone.mutateAsync,
        remove: (clone: { item_id: string; revision_sha256: string }) =>
          removeContent({
            itemId: clone.item_id,
            kind: "voice",
            revision: clone.revision_sha256,
          }),
      },
      identity: {
        update: updateAnima.mutateAsync,
        emotion: emotion.mutateAsync,
        repair: repair.mutateAsync,
        snapshot: () =>
          queryClient.getQueryData(
            queryKeys.animas.detail(key ?? "__anon__", "fixture-anima"),
          ),
      },
      chat,
      manager: {
        general: general.mutateAsync,
        reflect: reflect.mutateAsync,
        episodes: episodes.mutateAsync,
        append: append.mutateAsync,
        decide: decide.mutateAsync,
        undo: undo.mutateAsync,
        complete: complete.mutateAsync,
      },
      managerSnapshot: (runId: string) =>
        queryClient.getQueryData(
          queryKeys.memoryManager.run(key ?? "__anon__", runId),
        ),
      currentManager: () =>
        queryClient.getQueryData(
          queryKeys.memoryManager.current(key ?? "__anon__"),
        ),
    };
    Object.assign(window, { workflowFixture: observer });
    return () => {
      const target = window as unknown as { workflowFixture?: typeof observer };
      if (target.workflowFixture === observer) delete target.workflowFixture;
    };
  }, [
    client,
    key,
    settings,
    rescan.mutateAsync,
    speech,
    loadout,
    voice.mutateAsync,
    clones.saveVoiceClone.mutateAsync,
    clones.renameVoiceClone.mutateAsync,
    removeContent,
    updateAnima.mutateAsync,
    emotion.mutateAsync,
    repair.mutateAsync,
    chat,
    general.mutateAsync,
    reflect.mutateAsync,
    episodes.mutateAsync,
    append.mutateAsync,
    decide.mutateAsync,
    undo.mutateAsync,
    complete.mutateAsync,
    queryClient,
  ]);
  return (
    <output aria-label="App preference save status">
      {settings.isUpdating ? "Saving" : "Idle"}
    </output>
  );
}

export function HostedWorkflowObserver() {
  const { admission } = useRuntimeAdmission();
  if (admission.status !== "ready") return null;
  return (
    <SettingsProvider animaId="fixture-anima">
      <WorkflowObserver />
    </SettingsProvider>
  );
}
