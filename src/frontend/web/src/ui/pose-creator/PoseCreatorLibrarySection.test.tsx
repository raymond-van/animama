import type { FormEvent, ReactElement } from "react";
import { renderToString } from "@/test/runtime-markup";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ContentSaveApiError } from "@/lib/content/contentSaveErrors";
import { usePoseCreatorStore } from "@/stores/pose-creator-store";
import { PoseCreatorLibrarySection } from "./PoseCreatorLibrarySection";
import { buildPoseCreatorAnimaPoseForExport } from "./poseCreatorAuthoring";

type State = ReturnType<typeof usePoseCreatorStore.getState>;
const harness = vi.hoisted(() => ({
  selectors: [] as Array<(state: State) => unknown>,
  save: vi.fn(),
  names: vi.fn(),
  submit: null as ((event: FormEvent) => void) | null,
}));

vi.mock("@/query/hooks/usePoses", () => ({
  usePoses: () => ({ data: { items: [] }, isError: false, refetch: vi.fn() }),
  fetchPoseNames: harness.names,
}));
// The shared delete confirmation has its own tests.
vi.mock("@/ui/content-delete/ContentDeleteDialog", () => ({
  ContentDeleteDialog: () => null,
}));
vi.mock("@/query/mutations/usePoseContentActions", () => ({
  usePoseContentActions: () => ({
    savePose: { mutateAsync: harness.save, isPending: false },
  }),
}));

// SSR supplies the actual component selectors and event closures; the live
// store lets us check which subscriptions would invalidate a mounted toolbar.
vi.mock("@/stores/pose-creator-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/stores/pose-creator-store")>();
  return {
    ...actual,
    usePoseCreatorStore: Object.assign(
      (selector: (state: State) => unknown) => {
        harness.selectors.push(selector);
        return selector(actual.usePoseCreatorStore.getState());
      },
      actual.usePoseCreatorStore,
    ),
  };
});
vi.mock("@/ui/content-creator/CreatorHeaderDocument", () => ({
  CreatorHeaderDocument: ({
    children,
  }: {
    children: ReactElement<{ onSubmit: (event: FormEvent) => void }>;
  }) => {
    harness.submit = children.props.onSubmit;
    return children;
  },
}));
vi.mock("./poseCreatorAuthoring", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./poseCreatorAuthoring")>();
  return {
    ...actual,
    buildPoseCreatorAnimaPoseForExport: vi.fn(
      actual.buildPoseCreatorAnimaPoseForExport,
    ),
  };
});

const armDraft = (x: number) => ({
  baseQuaternion: [0, 0, 0, 1] as [number, number, number, number],
  rotationDegrees: { x, y: 0, z: 0 },
});

beforeEach(() => {
  usePoseCreatorStore.getState().resetWorkspace();
  harness.save.mockReset();
  harness.names.mockReset().mockResolvedValue([]);
  harness.save.mockImplementation(async (input) => ({
    item_id: input.itemId ?? "saved-item",
    name: input.name,
    kind: "pose",
    source: "local",
    pose_id: input.pose.id,
    logical_key: input.pose.id,
    revision_sha256: "saved-revision",
    editable: true,
  }));
  usePoseCreatorStore.getState().setDraftName("Wave");
  usePoseCreatorStore.getState().setBoneDraft("leftUpperArm", armDraft(10));
  usePoseCreatorStore.getState().beginPoseUndoGroup();
  harness.selectors = [];
  harness.submit = null;
});

describe("Pose toolbar during bone rotation", () => {
  it.each(["standalone", "inline"])(
    "keeps subscriptions stable during %s edits with the JSON view closed",
    (mode) => {
      if (mode === "inline") {
        usePoseCreatorStore.getState().beginClipInlinePoseEdit({
          alias: "wave",
          keyframeId: "keyframe-1",
          originalPose: {
            humanoid: { leftUpperArm: { rotation: [0, 0, 0, 1] } },
          },
          boneDrafts: { leftUpperArm: armDraft(10) },
          expressionDrafts: {},
          draftName: "Wave",
        });
        usePoseCreatorStore.getState().beginClipUndoGroup();
      }
      const html = renderToString(
        <PoseCreatorLibrarySection variant="toolbar" />,
      );
      const before = usePoseCreatorStore.getState();
      const values = harness.selectors.map((select) => select(before));

      for (let x = 11; x <= 20; x++) {
        usePoseCreatorStore
          .getState()
          .setBoneDraft("leftUpperArm", armDraft(x));
        const after = usePoseCreatorStore.getState();
        expect(harness.selectors.map((select) => select(after))).toEqual(
          values,
        );
        expect(
          harness.selectors.every((select, index) =>
            Object.is(select(after), values[index]),
          ),
        ).toBe(true);
      }

      expect(html).toContain('aria-label="View pose JSON"');
      expect(buildPoseCreatorAnimaPoseForExport).not.toHaveBeenCalled();
    },
  );

  it("saves the latest rotation even when the toolbar has not rendered again", async () => {
    usePoseCreatorStore.setState({
      selectedSource: {
        key: "test-avatar",
        sourceType: "resolved_entry",
        animaId: "test-anima",
        effectiveRevision: "runtime-1",
        contentRevision: "model-1",
        displayName: "Test avatar",
        versionLabel: "Built-in v1",
        sourceLabel: "Preview Anima",
        runtimeId: "primary",
        configSchemaVersion: 1,
        config: {},
      },
    });
    renderToString(<PoseCreatorLibrarySection variant="toolbar" />);
    usePoseCreatorStore.getState().setBoneDraft("leftUpperArm", armDraft(90));
    await harness.submit!({
      preventDefault: () => undefined,
      nativeEvent: {},
    } as FormEvent);

    const pose = harness.save.mock.calls[0][0].pose;
    expect(pose?.humanoid?.leftUpperArm?.rotation?.[0]).toBeCloseTo(
      Math.SQRT1_2,
    );
    expect(pose?.humanoid?.leftUpperArm?.rotation?.[3]).toBeCloseTo(
      Math.SQRT1_2,
    );
  });

  it("retains JSON generation for the explicit data panel", () => {
    renderToString(<PoseCreatorLibrarySection variant="panel" />);
    expect(buildPoseCreatorAnimaPoseForExport).toHaveBeenCalledOnce();
  });
});

const source = {
  key: "test-avatar",
  sourceType: "resolved_entry" as const,
  animaId: "preview",
  effectiveRevision: "r",
  contentRevision: "m",
  displayName: "Test avatar",
  versionLabel: "v1",
  sourceLabel: "Preview Anima" as const,
  runtimeId: "primary",
  configSchemaVersion: 1,
  config: {},
};
const submit = () =>
  harness.submit!({
    preventDefault: () => undefined,
    nativeEvent: {},
  } as FormEvent);

describe("durable Pose save lifecycle", () => {
  it("saves a blank name using the current catalog and shows the chosen name", async () => {
    usePoseCreatorStore.setState({ selectedSource: source, draftName: "" });
    harness.names.mockResolvedValue(["New Pose", "New Pose 1"]);
    const html = renderToString(
      <PoseCreatorLibrarySection variant="toolbar" />,
    );
    expect(html).toContain('placeholder="New Pose"');
    await submit();
    expect(harness.names).toHaveBeenCalledOnce();
    expect(harness.save.mock.calls[0][0]).toMatchObject({
      name: "New Pose 2",
      pose: { name: "New Pose 2" },
    });
    expect(usePoseCreatorStore.getState()).toMatchObject({
      draftName: "New Pose 2",
      isDirty: false,
    });
  });

  it("reuses an unresolved blank-name save instead of allocating another name", async () => {
    usePoseCreatorStore.setState({ selectedSource: source, draftName: "" });
    harness.save.mockRejectedValueOnce(new Error("Response lost"));
    renderToString(<PoseCreatorLibrarySection variant="toolbar" />);
    await submit();
    const original = harness.save.mock.calls[0][0];
    harness.names.mockResolvedValue(["New Pose"]);
    await submit();
    expect(harness.names).toHaveBeenCalledOnce();
    expect(harness.save.mock.calls[1][0]).toBe(original);
    expect(original.name).toBe("New Pose");
  });

  it("preserves explicit names and newer edits during automatic name lookup", async () => {
    usePoseCreatorStore.setState({ selectedSource: source, draftName: "" });
    let resolveNames!: (names: string[]) => void;
    harness.names.mockReturnValueOnce(
      new Promise<string[]>((resolve) => {
        resolveNames = resolve;
      }),
    );
    renderToString(<PoseCreatorLibrarySection variant="toolbar" />);
    const pending = submit();
    usePoseCreatorStore.getState().setDraftName("My pose");
    resolveNames([]);
    await pending;
    expect(usePoseCreatorStore.getState()).toMatchObject({
      draftName: "My pose",
      isDirty: true,
    });
    await submit();
    expect(harness.save.mock.calls[1][0]).toMatchObject({
      name: "My pose",
      itemId: "saved-item",
    });
    expect(harness.names).toHaveBeenCalledOnce();
  });

  it("preserves the blank draft and permits retry when catalog lookup fails", async () => {
    usePoseCreatorStore.setState({ selectedSource: source, draftName: "" });
    harness.names.mockRejectedValueOnce(new Error("Catalog unavailable"));
    renderToString(<PoseCreatorLibrarySection variant="toolbar" />);
    await submit();
    expect(harness.save).not.toHaveBeenCalled();
    expect(usePoseCreatorStore.getState().draftName).toBe("");
    await submit();
    expect(harness.save).toHaveBeenCalledOnce();
    expect(harness.save.mock.calls[0][0].name).toBe("New Pose");
  });

  it.each([
    new Error("Save unavailable"),
    new ContentSaveApiError(409, "operation_in_progress", "Save unavailable"),
  ])(
    "retains the unresolved operation while preserving newer edits (%s)",
    async (failure) => {
      usePoseCreatorStore.setState({ selectedSource: source });
      harness.save.mockRejectedValue(failure);
      renderToString(<PoseCreatorLibrarySection variant="toolbar" />);
      await submit();
      expect(usePoseCreatorStore.getState().isDirty).toBe(true);
      expect(usePoseCreatorStore.getState().importError).toBe(
        "Save unavailable",
      );
      await submit();
      expect(harness.save.mock.calls[1][0]).toBe(harness.save.mock.calls[0][0]);
      usePoseCreatorStore.getState().setDraftName("Changed");
      await submit();
      expect(harness.save.mock.calls[2][0]).toBe(harness.save.mock.calls[0][0]);
      expect(usePoseCreatorStore.getState()).toMatchObject({
        draftName: "Changed",
        isDirty: true,
        savedPoseIdentity: null,
      });
    },
  );

  it("allows a corrected new create after a definitive name rejection", async () => {
    usePoseCreatorStore.setState({ selectedSource: source });
    harness.save.mockRejectedValueOnce(
      new ContentSaveApiError(
        409,
        "content_path_exists",
        "Choose another name.",
      ),
    );
    renderToString(<PoseCreatorLibrarySection variant="toolbar" />);
    await submit();
    const rejected = harness.save.mock.calls[0][0];
    usePoseCreatorStore.getState().setDraftName("Available name");
    await submit();
    expect(harness.save).toHaveBeenCalledTimes(2);
    const corrected = harness.save.mock.calls[1][0];
    expect(corrected.name).toBe("Available name");
    expect(corrected.itemId).toBeUndefined();
    expect(corrected.operationId).not.toBe(rejected.operationId);
    expect(usePoseCreatorStore.getState()).toMatchObject({
      draftName: "Available name",
      isDirty: false,
    });
  });

  it("settles a response-lost create before saving renamed content as an update", async () => {
    usePoseCreatorStore.setState({ selectedSource: source });
    harness.save.mockRejectedValueOnce(new Error("Response lost"));
    renderToString(<PoseCreatorLibrarySection variant="toolbar" />);
    await submit();
    const created = harness.save.mock.calls[0][0];
    usePoseCreatorStore.getState().setDraftName("Renamed");
    let settle!: (value: unknown) => void;
    harness.save.mockReturnValueOnce(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    const saving = submit();
    expect(harness.save.mock.calls[1][0]).toBe(created);
    usePoseCreatorStore
      .getState()
      .setDraftName("Later edit during reconciliation");
    settle({
      item_id: "one-pose",
      kind: "pose",
      name: created.name,
      source: "local",
      pose_id: created.pose.id,
      revision_sha256: "created-r1",
      editable: true,
    });
    await saving;
    expect(harness.save).toHaveBeenCalledTimes(3);
    const update = harness.save.mock.calls[2][0];
    expect(update).toMatchObject({
      itemId: "one-pose",
      expectedRevision: "created-r1",
      name: "Renamed",
      pose: { id: created.pose.id, name: "Renamed" },
    });
    expect(update.operationId).not.toBe(created.operationId);
    expect(usePoseCreatorStore.getState()).toMatchObject({
      draftName: "Later edit during reconciliation",
      isDirty: true,
    });
    expect(usePoseCreatorStore.getState().savedPoseIdentity).toMatchObject({
      itemId: "one-pose",
      poseId: created.pose.id,
    });
  });

  it("stops after settlement when the owner opens another pose session", async () => {
    usePoseCreatorStore.setState({ selectedSource: source });
    harness.save.mockRejectedValueOnce(new Error("Response lost"));
    renderToString(<PoseCreatorLibrarySection variant="toolbar" />);
    await submit();
    const original = harness.save.mock.calls[0][0];
    usePoseCreatorStore.getState().setDraftName("Renamed");
    let settle!: (value: unknown) => void;
    harness.save.mockReturnValueOnce(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    const saving = submit();
    usePoseCreatorStore.getState().startNewPose();
    usePoseCreatorStore.getState().setDraftName("Independent draft");
    settle({
      item_id: "old-pose",
      kind: "pose",
      name: original.name,
      source: "local",
      pose_id: original.pose.id,
      revision_sha256: "old-r1",
      editable: true,
    });
    await saving;
    expect(harness.save).toHaveBeenCalledTimes(2);
    expect(usePoseCreatorStore.getState()).toMatchObject({
      draftName: "Independent draft",
      savedPoseIdentity: null,
      isDirty: true,
    });
  });

  it("retains a failed Save request across a toolbar remount in the same session", async () => {
    usePoseCreatorStore.setState({ selectedSource: source });
    harness.save.mockRejectedValue(new Error("Response lost"));
    renderToString(<PoseCreatorLibrarySection variant="toolbar" />);
    await submit();
    const initial = harness.save.mock.calls[0][0];
    renderToString(<PoseCreatorLibrarySection variant="toolbar" />);
    await submit();
    expect(harness.save.mock.calls[1][0]).toBe(initial);
  });

  it("keeps pending edits dirty and suppresses duplicate in-flight submissions", async () => {
    usePoseCreatorStore.setState({ selectedSource: source });
    let finish!: (value: unknown) => void;
    harness.save.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    renderToString(<PoseCreatorLibrarySection variant="toolbar" />);
    const pending = submit();
    await submit();
    expect(harness.save).toHaveBeenCalledOnce();
    usePoseCreatorStore.getState().setDraftName("Newer edit");
    const input = harness.save.mock.calls[0][0];
    finish({
      item_id: input.itemId ?? "saved-item",
      name: input.name,
      kind: "pose",
      source: "local",
      pose_id: input.pose.id,
      revision_sha256: "r2",
      editable: true,
    });
    await pending;
    expect(usePoseCreatorStore.getState()).toMatchObject({
      draftName: "Newer edit",
      isDirty: true,
      savedPoseIdentity: { itemId: "saved-item", revision: "r2" },
    });
  });

  it("shows preparation errors and preserves the unsaved draft", async () => {
    usePoseCreatorStore.setState({
      selectedSource: source,
      basePose: "missing-base",
    });
    renderToString(<PoseCreatorLibrarySection variant="toolbar" />);
    await expect(Promise.resolve(submit())).resolves.toBeNull();
    expect(harness.save).not.toHaveBeenCalled();
    expect(usePoseCreatorStore.getState().isDirty).toBe(true);
    expect(usePoseCreatorStore.getState().importError).toBeTruthy();
  });
});

it("omits New from the standalone Library editor while retaining Pose Save", () => {
  const html = renderToString(
    <PoseCreatorLibrarySection variant="toolbar" hideNew />,
  );
  expect(html).not.toContain('aria-label="New"');
  expect(html).toContain('id="pose-creator-pose-save-form"');
  expect(html).toContain('aria-label="Pose name"');
});
