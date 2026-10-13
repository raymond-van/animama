"use client";

import { useProductApiClient } from "@animama/product-ui";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import {
  previewGesture,
  previewIdleStyle,
  previewReaction,
} from "@animama/runtime-contracts/sdk";
import type {
  PyCatalogLoadoutSource,
  PyGestureIntent,
  PyIdleStyleIntent,
  PyLoadoutPlan,
  PyReactionIntent,
} from "@animama/runtime-contracts/api-types";
import type {
  PyExactContentSource,
  PyGesture,
  PyIdleStyle,
  PyReaction,
} from "@/lib/content/catalogTypes";
import type { ContentPreviewTarget } from "@/lib/content-preview/types";
import { withLibraryPreviewAnimaContext } from "@/lib/content-preview/targets";
import { actionPreviewTarget } from "@/lib/content-preview/actionPreviewTarget";
import { idleStylePreviewTarget } from "@/lib/content-preview/idleStylePreviewTarget";
import {
  typedActionPreview,
  typedIdleStylePreview,
} from "@/lib/content/typedPreviewAdapters";
import {
  presentGestureCatalog,
  presentGestureLoadout,
} from "@/lib/loadout/animaLoadoutPresentation";
import { buildReactionLoadoutGrid } from "@/lib/loadout/reactionLoadoutGrid";
import { adaptRuntimeSnapshot } from "@/lib/runtime-content/runtimeSnapshotAdapter";
import { useAnimaLoadout as useLoadout } from "@/query/hooks/useAnimaLoadout";
import { useIdleStyles } from "@/query/hooks/useIdleStyles";
import { useGestures, useReactions } from "@/query/hooks/useActions";
import { useAnimaRuntimeCatalog } from "@/query/hooks/useAnimaRuntimeCatalog";
import { useAnimaLoadoutMutations } from "@/query/mutations/useAnimaLoadoutMutations";
import { VoiceLoadoutSection } from "@/ui/animas/VoiceLoadoutSection";
import { GestureLoadoutSection } from "@/ui/animas/GestureLoadoutSection";
import { IdleStyleLoadoutSection } from "@/ui/animas/IdleStyleLoadoutSection";
import { ReactionLoadoutGrid } from "@/ui/animas/ReactionLoadoutGrid";
import { Button } from "@/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/components/dialog";

type ReviewedChange =
  | {
      family: "gesture";
      intent: PyGestureIntent;
      plan: PyLoadoutPlan;
      idempotencyKey: string;
    }
  | {
      family: "reaction";
      intent: PyReactionIntent;
      plan: PyLoadoutPlan;
      idempotencyKey: string;
    }
  | {
      family: "idle_style";
      intent: PyIdleStyleIntent;
      plan: PyLoadoutPlan;
      idempotencyKey: string;
    };

type PreviewableAction = {
  name?: string | null;
  source?: PyExactContentSource | PyCatalogLoadoutSource | null;
};

function intentSource(
  source: PyExactContentSource | PyCatalogLoadoutSource | null | undefined,
): PyCatalogLoadoutSource | null {
  if (!source || !("catalog_item_id" in source) || !source.source) return null;
  return {
    type: "catalog",
    catalog_item_id: source.catalog_item_id,
    logical_key: source.logical_key,
    source: source.source,
  };
}

/** Typed Gesture/Reaction configuration; dependencies remain resolver-owned. */
export function AnimaLoadout({
  animaId,
  onStagePreview,
}: {
  animaId: string;
  onStagePreview: (target: ContentPreviewTarget) => void;
}) {
  const apiClient = useProductApiClient();

  const query = useLoadout(animaId);
  const runtimeSnapshotQuery = useAnimaRuntimeCatalog(animaId);
  const runtimeData = useMemo(
    () =>
      runtimeSnapshotQuery.data
        ? adaptRuntimeSnapshot(runtimeSnapshotQuery.data)
        : undefined,
    [runtimeSnapshotQuery.data],
  );
  const runtimeQuery = { ...runtimeSnapshotQuery, data: runtimeData };
  const idleStylesQuery = useIdleStyles({ sort: "name" });
  const gesturesQuery = useGestures({ origin: "all", sort: "name" });
  const reactionsQuery = useReactions({ origin: "all", sort: "name" });
  const {
    fetchNextPage: fetchNextGesturesPage,
    hasNextPage: hasNextGesturesPage,
    isFetchNextPageError: gesturesNextPageError,
    isFetchingNextPage: gesturesFetchingNextPage,
  } = gesturesQuery;
  const {
    fetchNextPage: fetchNextReactionsPage,
    hasNextPage: hasNextReactionsPage,
    isFetchNextPageError: reactionsNextPageError,
    isFetchingNextPage: reactionsFetchingNextPage,
  } = reactionsQuery;
  const {
    fetchNextPage: fetchNextIdleStylesPage,
    hasNextPage: hasNextIdleStylesPage,
    isFetchNextPageError: idleStylesNextPageError,
    isFetchingNextPage: idleStylesFetchingNextPage,
  } = idleStylesQuery;
  const mutations = useAnimaLoadoutMutations(animaId);
  const [reviewed, setReviewed] = useState<ReviewedChange | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const loadout = query.data;

  useEffect(() => {
    if (
      hasNextGesturesPage &&
      !gesturesFetchingNextPage &&
      !gesturesNextPageError
    ) {
      void fetchNextGesturesPage();
    }
  }, [
    gesturesFetchingNextPage,
    gesturesNextPageError,
    fetchNextGesturesPage,
    hasNextGesturesPage,
  ]);

  useEffect(() => {
    if (
      hasNextReactionsPage &&
      !reactionsFetchingNextPage &&
      !reactionsNextPageError
    ) {
      void fetchNextReactionsPage();
    }
  }, [
    fetchNextReactionsPage,
    hasNextReactionsPage,
    reactionsFetchingNextPage,
    reactionsNextPageError,
  ]);

  useEffect(() => {
    if (
      hasNextIdleStylesPage &&
      !idleStylesFetchingNextPage &&
      !idleStylesNextPageError
    ) {
      void fetchNextIdleStylesPage();
    }
  }, [
    fetchNextIdleStylesPage,
    hasNextIdleStylesPage,
    idleStylesFetchingNextPage,
    idleStylesNextPageError,
  ]);

  const gesturePresentation = useMemo(
    () =>
      loadout
        ? presentGestureLoadout(
            loadout,
            gesturesQuery.data?.pages.flatMap((page) => page.items) ?? [],
          )
        : null,
    [gesturesQuery.data, loadout],
  );
  const gestureCatalog = useMemo(
    () =>
      presentGestureCatalog(
        gesturesQuery.data?.pages.flatMap((page) => page.items) ?? [],
        loadout?.gestures ?? [],
      ),
    [gesturesQuery.data, loadout?.gestures],
  );
  const reactionRows = useMemo(
    () => buildReactionLoadoutGrid(loadout?.reactions ?? []),
    [loadout?.reactions],
  );
  const availableReactions = useMemo(
    () =>
      (reactionsQuery.data?.pages.flatMap((page) => page.items) ?? []).filter(
        (reaction) => reaction.state === "ready" && reaction.source,
      ),
    [reactionsQuery.data],
  );
  const availableIdleStyles =
    idleStylesQuery.data?.pages.flatMap((page) => page.items) ?? [];

  const preview = async (
    family: "gesture" | "reaction",
    row: PreviewableAction,
  ) => {
    const catalogSource = intentSource(row.source);
    if (!catalogSource) {
      toast.error("This Loadout entry does not have a preview source.");
      return;
    }
    try {
      const itemId = catalogSource.catalog_item_id;
      const options = {
        path: { item_id: itemId },
        responseValidator: undefined,
        throwOnError: true as const,
      };
      const result =
        family === "gesture"
          ? await previewGesture({ ...options, client: apiClient })
          : await previewReaction({ ...options, client: apiClient });
      const target = actionPreviewTarget(
        typedActionPreview(result.data),
        row.name ?? "Reaction",
      );
      if (!runtimeQuery.data) {
        throw new Error("The Anima preview context is still loading.");
      }
      onStagePreview(
        withLibraryPreviewAnimaContext(target, animaId, runtimeQuery.data),
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Preview is unavailable.",
      );
    }
  };

  const planGesture = async (intent: PyGestureIntent) => {
    if (!loadout) return;
    setReviewing(true);
    try {
      const plan = await mutations.planGesture.mutateAsync({
        expected_revision: loadout.revision,
        intent,
      });
      setReviewed({
        family: "gesture",
        intent,
        plan,
        idempotencyKey: crypto.randomUUID(),
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Review failed.");
    } finally {
      setReviewing(false);
    }
  };

  const planReaction = async (intent: PyReactionIntent) => {
    if (!loadout) return;
    setReviewing(true);
    try {
      const plan = await mutations.planReaction.mutateAsync({
        expected_revision: loadout.revision,
        intent,
      });
      setReviewed({
        family: "reaction",
        intent,
        plan,
        idempotencyKey: crypto.randomUUID(),
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Review failed.");
    } finally {
      setReviewing(false);
    }
  };

  const planIdleStyle = async (intent: PyIdleStyleIntent) => {
    if (!loadout) return;
    setReviewing(true);
    try {
      const plan = await mutations.planIdleStyle.mutateAsync({
        expected_revision: loadout.revision,
        intent,
      });
      setReviewed({
        family: "idle_style",
        intent,
        plan,
        idempotencyKey: crypto.randomUUID(),
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Review failed.");
    } finally {
      setReviewing(false);
    }
  };

  const selectIdleStyle = (style: PyIdleStyle) => {
    const source = intentSource(style.source);
    if (!source) return;
    void planIdleStyle({
      operation: "set",
      source,
    });
  };

  const previewIdle = async (gestureRef?: string) => {
    if (!loadout?.idle_style.source || !runtimeQuery.data) return;
    const selectedRef = gestureRef ?? loadout.idle_style.default_pool?.[0];
    if (!selectedRef) return;
    try {
      const result = (
        await previewIdleStyle({
          client: apiClient,
          path: { item_id: loadout.idle_style.source.catalog_item_id },
          responseValidator: undefined,
          throwOnError: true,
        })
      ).data;
      onStagePreview(
        idleStylePreviewTarget(
          typedIdleStylePreview(result, selectedRef),
          loadout.idle_style.name ?? "Idle Style",
          animaId,
          runtimeQuery.data,
        ),
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Preview failed.");
    }
  };

  const confirm = async () => {
    if (!loadout || !reviewed) return;
    try {
      if (reviewed.family === "gesture")
        await mutations.commitGesture.mutateAsync({
          expected_revision: loadout.revision,
          intent: reviewed.intent,
          plan_digest: reviewed.plan.plan_digest,
          idempotency_key: reviewed.idempotencyKey,
        });
      else if (reviewed.family === "reaction")
        await mutations.commitReaction.mutateAsync({
          expected_revision: loadout.revision,
          intent: reviewed.intent,
          plan_digest: reviewed.plan.plan_digest,
          idempotency_key: reviewed.idempotencyKey,
        });
      else if (reviewed.family === "idle_style")
        await mutations.commitIdleStyle.mutateAsync({
          expected_revision: loadout.revision,
          intent: reviewed.intent,
          plan_digest: reviewed.plan.plan_digest,
          idempotency_key: reviewed.idempotencyKey,
        });
      toast.success("Loadout updated. Changes apply to the next chat mount.");
      setReviewed(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Update failed.");
    }
  };

  if (query.isPending) {
    return (
      <p className="text-muted-foreground py-10 text-center text-sm">
        Loading Gesture and Reaction Loadout…
      </p>
    );
  }
  if (query.isError || !loadout || !gesturePresentation) {
    return (
      <div className="space-y-3 rounded-xl border p-5 text-sm">
        <p className="text-destructive">The Loadout is unavailable.</p>
        <Button variant="outline" onClick={() => void query.refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  const mutationsDisabled = reviewing;
  const committing =
    mutations.commitGesture.isPending ||
    mutations.commitReaction.isPending ||
    mutations.commitIdleStyle.isPending;

  return (
    <div className="space-y-8 pt-5 md:pt-6">
      <h1 className="text-2xl font-semibold">Loadout</h1>
      {loadout.warnings?.length ? (
        <div className="border-warning/35 rounded-lg border p-3 text-sm">
          {loadout.warnings.map((warning) => (
            <p key={`${warning.code}:${warning.message}`}>{warning.message}</p>
          ))}
        </div>
      ) : null}
      <VoiceLoadoutSection key={animaId} />
      <GestureLoadoutSection
        presentation={gesturePresentation}
        catalog={gestureCatalog}
        catalogLoading={
          gesturesQuery.isPending ||
          gesturesFetchingNextPage ||
          Boolean(hasNextGesturesPage && !gesturesNextPageError)
        }
        catalogError={gesturesQuery.isError}
        mutationsDisabled={mutationsDisabled}
        onPreview={(row) => void preview("gesture", row)}
        onPreviewAvailable={(gesture) => void preview("gesture", gesture)}
        onEquip={(gesture: PyGesture) => {
          const source = intentSource(gesture.source);
          if (!source) {
            toast.error("This Gesture is not available in the local catalog.");
            return;
          }
          void planGesture({
            operation: "add",
            source,
            config_overrides: {},
          });
        }}
        onRemove={(row) =>
          void planGesture({
            operation: "remove",
            binding_id: row.binding_id,
            config_overrides: {},
          })
        }
        onDisableStarter={(row) =>
          void planGesture({
            operation: "disable_starter",
            starter_id: row.semantic_key,
            config_overrides: {},
          })
        }
        onRestoreStarter={(starterId) =>
          void planGesture({
            operation: "restore_starter",
            starter_id: starterId,
            config_overrides: {},
          })
        }
        onRetryCatalog={() => void gesturesQuery.refetch()}
      />
      <ReactionLoadoutGrid
        rows={reactionRows}
        available={availableReactions}
        availableLoading={
          reactionsQuery.isPending ||
          reactionsFetchingNextPage ||
          Boolean(hasNextReactionsPage && !reactionsNextPageError)
        }
        availableError={reactionsQuery.isError}
        mutationsDisabled={mutationsDisabled}
        onPreview={(cell) => void preview("reaction", cell)}
        onPreviewAvailable={(reaction) => void preview("reaction", reaction)}
        onSelect={(cell, reaction: PyReaction) => {
          const source = intentSource(reaction.source);
          if (!source) {
            toast.error("This Reaction is not available in the local catalog.");
            return;
          }
          void planReaction({
            operation: "replace",
            emotion: cell.emotion,
            intensity: cell.intensity,
            source,
            config_overrides: {},
          });
        }}
        onRevert={(cell) =>
          void planReaction({
            operation: "revert",
            emotion: cell.emotion,
            intensity: cell.intensity,
            config_overrides: {},
          })
        }
        onLeaveEmpty={(cell) =>
          void planReaction({
            operation: "leave_empty",
            emotion: cell.emotion,
            intensity: cell.intensity,
            config_overrides: {},
          })
        }
        onRetryAvailable={() => void reactionsQuery.refetch()}
      />
      <IdleStyleLoadoutSection
        style={loadout.idle_style}
        available={availableIdleStyles}
        availableLoading={
          idleStylesQuery.isPending ||
          idleStylesFetchingNextPage ||
          Boolean(hasNextIdleStylesPage && !idleStylesNextPageError)
        }
        disabled={mutationsDisabled}
        onPreview={() => void previewIdle()}
        onPreviewGesture={(gestureRef) => void previewIdle(gestureRef)}
        onSelect={selectIdleStyle}
        onRevert={() =>
          void planIdleStyle({
            operation: "revert",
          })
        }
        onLeaveEmpty={() =>
          void planIdleStyle({
            operation: "leave_empty",
          })
        }
      />
      <Dialog open={Boolean(reviewed)} onOpenChange={() => setReviewed(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Review Loadout change</DialogTitle>
            <DialogDescription>
              This changes the next mounted chat runtime. An active chat keeps
              its current revision.
            </DialogDescription>
          </DialogHeader>
          {reviewed ? (
            <div className="space-y-2 rounded-lg border p-4 text-sm">
              <p>
                <span className="text-muted-foreground">Action:</span>{" "}
                {reviewed.plan.action.replaceAll("_", " ")}
              </p>
              {reviewed.plan.current_name ? (
                <p>
                  <span className="text-muted-foreground">Current:</span>{" "}
                  {reviewed.plan.current_name}
                </p>
              ) : null}
              {reviewed.plan.target_name ? (
                <p>
                  <span className="text-muted-foreground">Result:</span>{" "}
                  {reviewed.plan.target_name}
                </p>
              ) : null}
              {(reviewed.plan.warnings ?? []).map((warning) => (
                <p key={warning.code} className="text-warning">
                  {warning.message}
                </p>
              ))}
            </div>
          ) : null}
          <DialogFooter>
            <Button
              onClick={() => void confirm()}
              disabled={
                committing || !reviewed || reviewed.plan.action === "unchanged"
              }
            >
              Confirm change
            </Button>
            <Button variant="outline" onClick={() => setReviewed(null)}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
