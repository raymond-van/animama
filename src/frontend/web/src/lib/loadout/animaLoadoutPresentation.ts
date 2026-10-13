import type {
  PyAnimaLoadout,
  PyCatalogLoadoutSource,
  PyGestureBinding,
} from "@animama/runtime-contracts/api-types";
import type {
  PyExactContentSource,
  PyGesture,
} from "@/lib/content/catalogTypes";

export type GestureLoadoutPresentation = {
  starter: PyGestureBinding[];
  custom: PyGestureBinding[];
  disabledStarter: Array<{
    starterId: string;
    motionType: PyGesture["implementation_kind"] | null;
    gesture: PyGesture | null;
  }>;
  starterSummary: string;
};

export type GestureCatalogRow = {
  gesture: PyGesture;
  binding: PyGestureBinding | null;
};

export type GestureCatalogPresentation = {
  rows: GestureCatalogRow[];
  unlistedEquipped: PyGestureBinding[];
};

export type UnifiedGestureListRow = {
  id: string;
  kind: "custom" | "starter";
  source: "included" | "local";
  name: string;
  description: string | null;
  equipped: boolean;
  updateAvailable: boolean;
  motionType: PyGesture["implementation_kind"] | null;
  gesture: PyGesture | null;
  binding: PyGestureBinding | null;
  starterId: string | null;
};

export type UnifiedGestureListPresentation = {
  rows: UnifiedGestureListRow[];
  equippedCount: number;
  totalCount: number;
  includedCount: number;
  localCount: number;
  updateAvailableCount: number;
  motionTypeCounts: Record<PyGesture["implementation_kind"], number>;
};

export type UnifiedGestureStatusFilter = "all" | "equipped" | "unequipped";

export type UnifiedGestureSort = "custom-first" | "name-asc" | "name-desc";

export type UnifiedGestureMotionFilter =
  | "all"
  | PyGesture["implementation_kind"];

function sameExactSource(
  binding: PyCatalogLoadoutSource,
  available: PyExactContentSource | null,
): boolean {
  if (!available || available.type !== "catalog") return false;
  return binding.catalog_item_id === available.catalog_item_id;
}

/** Reconcile the full ready catalog with the exact bindings on this Anima. */
export function presentGestureCatalog(
  gestures: PyGesture[],
  equipped: PyGestureBinding[],
): GestureCatalogPresentation {
  const readyGestures = gestures.filter(
    (gesture) => gesture.state === "ready" && Boolean(gesture.source),
  );
  const rows = [
    ...new Map(
      readyGestures.map((gesture) => [gesture.item_id, gesture]),
    ).values(),
  ]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((gesture) => ({
      gesture,
      binding:
        equipped.find(
          (candidate) =>
            candidate.logical_item_id === gesture.item_id ||
            sameExactSource(candidate.source, gesture.source),
        ) ?? null,
    }));
  const representedBindingIds = new Set(
    rows.flatMap((row) => (row.binding ? [row.binding.binding_id] : [])),
  );
  return {
    rows,
    unlistedEquipped: equipped.filter(
      (binding) => !representedBindingIds.has(binding.binding_id),
    ),
  };
}

/** Keep catalog origin separate from starter/custom loadout behavior. */
function gestureSource(gesture: PyGesture): "included" | "local" {
  return gesture.source?.type === "catalog" && gesture.source.source
    ? gesture.source.source
    : gesture.origin === "builtin"
      ? "included"
      : "local";
}

/** Starter policy IDs are Included logical-key slugs, not AI selector names. */
function includedGestureId(
  source: PyExactContentSource | PyCatalogLoadoutSource | null,
): string | null {
  const prefix = "builtin:gesture:";
  return source?.type === "catalog" &&
    source.source === "included" &&
    source.logical_key?.startsWith(prefix)
    ? source.logical_key.slice(prefix.length)
    : null;
}

/** Build a searchable catalog without hiding unequipped Included Gestures. */
export function presentUnifiedGestureList({
  presentation,
  catalog,
  showIncluded,
  showLocal,
  updatesOnly,
  status,
  motionType,
  sort,
  query,
}: {
  presentation: GestureLoadoutPresentation;
  catalog: GestureCatalogPresentation;
  showIncluded: boolean;
  showLocal: boolean;
  updatesOnly: boolean;
  status: UnifiedGestureStatusFilter;
  motionType: UnifiedGestureMotionFilter;
  sort: UnifiedGestureSort;
  query: string;
}): UnifiedGestureListPresentation {
  const disabledStarterIds = new Set(
    presentation.disabledStarter.map((row) => row.starterId),
  );
  const catalogRows: UnifiedGestureListRow[] = catalog.rows.map(
    ({ gesture, binding }) => {
      const source = gestureSource(gesture);
      const includedId = includedGestureId(gesture.source);
      const disabledStarter =
        includedId !== null && disabledStarterIds.has(includedId);
      // Explicit bindings keep Remove semantics even when their source is a starter.
      const kind = binding?.origin ?? (disabledStarter ? "starter" : "custom");
      return {
        id: `catalog:${gesture.item_id}`,
        kind,
        source,
        name: gesture.name,
        description: gesture.description ?? null,
        equipped: Boolean(binding),
        updateAvailable: false,
        motionType: binding?.implementation_kind ?? gesture.implementation_kind,
        gesture,
        binding,
        starterId:
          kind === "starter" ? (binding?.semantic_key ?? includedId) : null,
      };
    },
  );
  const representedIncludedIds = new Set([
    ...catalog.rows
      .filter(({ gesture }) => gestureSource(gesture) === "included")
      .map(({ gesture }) => includedGestureId(gesture.source)),
    ...catalog.unlistedEquipped
      .filter((binding) => binding.source.source === "included")
      .map((binding) => includedGestureId(binding.source)),
  ]);
  // Retain loadout-only entries while the catalog loads or a source is unavailable.
  const allRows: UnifiedGestureListRow[] = [
    ...catalogRows,
    ...catalog.unlistedEquipped.map((binding) => ({
      id: `binding:${binding.binding_id}`,
      kind: binding.origin,
      source: binding.source.source,
      name: binding.name,
      description: binding.description ?? null,
      equipped: true,
      updateAvailable: false,
      motionType: binding.implementation_kind,
      gesture: null,
      binding,
      starterId: binding.origin === "starter" ? binding.semantic_key : null,
    })),
    ...presentation.disabledStarter
      .filter(({ starterId }) => !representedIncludedIds.has(starterId))
      .map(({ starterId, motionType, gesture }) => ({
        id: `starter-disabled:${starterId}`,
        kind: "starter" as const,
        source: "included" as const,
        name: gesture?.name ?? starterId,
        description: gesture?.description ?? null,
        equipped: false,
        updateAvailable: false,
        motionType: gesture?.implementation_kind ?? motionType,
        gesture,
        binding: null,
        starterId,
      })),
  ];
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const rows = allRows.filter((row) => {
    const matchesSource = row.source === "included" ? showIncluded : showLocal;
    const matchesQuery =
      !normalizedQuery ||
      row.name.toLocaleLowerCase().includes(normalizedQuery) ||
      row.description?.toLocaleLowerCase().includes(normalizedQuery);
    const matchesStatus =
      status === "all" ||
      (status === "equipped" ? row.equipped : !row.equipped);
    const matchesMotionType =
      motionType === "all" || row.motionType === motionType;
    return (
      matchesSource &&
      matchesQuery &&
      matchesStatus &&
      matchesMotionType &&
      (!updatesOnly || row.updateAvailable)
    );
  });
  rows.sort((left, right) => {
    if (sort === "custom-first" && left.kind !== right.kind)
      return left.kind === "custom" ? -1 : 1;
    const direction = sort === "name-desc" ? -1 : 1;
    return (
      direction *
      (left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
    );
  });

  return {
    rows,
    equippedCount: allRows.filter((row) => row.equipped).length,
    totalCount: allRows.length,
    includedCount: allRows.filter((row) => row.source === "included").length,
    localCount: allRows.filter((row) => row.source === "local").length,
    updateAvailableCount: allRows.filter((row) => row.updateAvailable).length,
    motionTypeCounts: {
      anima_clip: allRows.filter((row) => row.motionType === "anima_clip")
        .length,
      vrma: allRows.filter((row) => row.motionType === "vrma").length,
    },
  };
}

/** Keep Starter inventory compact while preserving custom typed roots. */
export function presentGestureLoadout(
  loadout: PyAnimaLoadout,
  builtinGestures: readonly PyGesture[] = [],
): GestureLoadoutPresentation {
  const starter = loadout.gestures.filter((row) => row.origin === "starter");
  const custom = loadout.gestures.filter((row) => row.origin === "custom");
  const disabled = loadout.disabled_starter_gestures.length;
  const builtinByStarterId = new Map(
    builtinGestures
      .filter(
        (gesture) =>
          gesture.origin === "builtin" &&
          gesture.state === "ready" &&
          Boolean(gesture.source),
      )
      .map((gesture) => [includedGestureId(gesture.source), gesture]),
  );
  return {
    starter,
    custom,
    disabledStarter: loadout.disabled_starter_gestures.map((starterId) => ({
      starterId,
      motionType:
        loadout.starter_gesture_implementation_kinds?.[starterId] ?? null,
      gesture: builtinByStarterId.get(starterId) ?? null,
    })),
    starterSummary: `${starter.length} active${disabled ? ` · ${disabled} disabled` : ""}`,
  };
}

/** Product-facing state label for a canonical Reaction cell. */
export function reactionStateLabel(
  state: "starter" | "custom" | "empty",
): string {
  if (state === "starter") return "Starter";
  if (state === "custom") return "Custom";
  return "Empty";
}
