// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PyPose } from "@animama/runtime-contracts/api-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePoseCreatorStore } from "@/stores/pose-creator-store";
import { withRuntime } from "@/test/runtime-markup";
import type { ContentToDelete } from "@/ui/content-delete/ContentDeleteDialog";
import { PoseCreatorLibrarySection } from "./PoseCreatorLibrarySection";

const harness = vi.hoisted(() => ({
  dialog: null as null | {
    item: ContentToDelete | null;
    onClose: () => void;
    onDeleted?: (item: ContentToDelete) => void;
  },
}));

const wave = {
  item_id: "wave-item",
  pose_id: "local:pose:wave",
  logical_key: "local:pose:wave",
  name: "Wave",
  source: "local",
  editable: true,
  revision_sha256: "wave-revision",
} as PyPose;
const salute = {
  ...wave,
  item_id: "salute-item",
  name: "Salute",
  source: "included",
  editable: false,
} as PyPose;

vi.mock("@/query/hooks/usePoses", () => ({
  usePoses: () => ({
    data: { items: [salute, wave] },
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  }),
  fetchPoseNames: vi.fn(async () => []),
}));
vi.mock("@/query/mutations/usePoseContentActions", () => ({
  usePoseContentActions: () => ({
    savePose: { mutateAsync: vi.fn(), isPending: false },
  }),
}));
vi.mock("@/ui/content-creator/CreatorHeaderDocument", () => ({
  CreatorHeaderDocument: ({ children }: { children: ReactNode }) => children,
}));
// The shared confirmation is covered by its own tests; this records what it
// is asked to confirm.
vi.mock("@/ui/content-delete/ContentDeleteDialog", () => ({
  ContentDeleteDialog: (props: NonNullable<typeof harness.dialog>) => {
    harness.dialog = props;
    return null;
  },
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  usePoseCreatorStore.getState().resetWorkspace();
  harness.dialog = null;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root!.render(withRuntime(<PoseCreatorLibrarySection variant="toolbar" />)),
  );
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

const load = () =>
  document.querySelector<HTMLButtonElement>('[aria-label="Load pose"]')!;

describe("deleting a Pose from the editor's Load list", () => {
  it("opens the shared confirmation instead of a browser confirm", async () => {
    // The editor used to ask through the browser's own confirm.
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    await act(async () => load().click());
    // Included Poses offer no Delete.
    expect(document.querySelector('[aria-label="Delete Salute"]')).toBeNull();

    await act(async () =>
      document
        .querySelector<HTMLElement>('[aria-label="Delete Wave"]')!
        .click(),
    );

    expect(confirm).not.toHaveBeenCalled();
    expect(harness.dialog?.item).toMatchObject({
      itemId: "wave-item",
      kind: "pose",
      name: "Wave",
      revision: "wave-revision",
    });
    // The list closes for the confirmation, and focus returns to Load.
    expect(document.querySelector('[aria-label="Delete Wave"]')).toBeNull();
    expect(harness.dialog?.item?.focus?.kept()).toBe(load());
    expect(harness.dialog?.item?.focus?.deleted()).toBe(load());
  });

  it("keeps the open Pose's draft as unsaved work once it is deleted", async () => {
    const store = usePoseCreatorStore.getState();
    store.setDraftName("Wave");
    store.setBoneDraft("leftUpperArm", {
      baseQuaternion: [0, 0, 0, 1],
      rotationDegrees: { x: 30, y: 0, z: 0 },
    });
    usePoseCreatorStore.setState({
      isDirty: false,
      savedPoseIdentity: {
        itemId: "wave-item",
        poseId: "local:pose:wave",
        logicalKey: "local:pose:wave",
        revision: "wave-revision",
        name: "Wave",
      },
    });
    await act(async () => load().click());
    await act(async () =>
      document
        .querySelector<HTMLElement>('[aria-label="Delete Wave"]')!
        .click(),
    );

    act(() => harness.dialog?.onDeleted?.(harness.dialog.item!));

    const after = usePoseCreatorStore.getState();
    // Save now creates a new Pose from the same draft.
    expect(after.savedPoseIdentity).toBeNull();
    expect(after.isDirty).toBe(true);
    expect(after.draftName).toBe("Wave");
    expect(after.boneDrafts.leftUpperArm?.rotationDegrees.x).toBe(30);
  });

  it("leaves another open Pose alone when a different one is deleted", async () => {
    usePoseCreatorStore.setState({
      savedPoseIdentity: {
        itemId: "other-item",
        poseId: "local:pose:other",
        logicalKey: "local:pose:other",
        revision: "other-revision",
        name: "Other",
      },
    });
    await act(async () => load().click());
    await act(async () =>
      document
        .querySelector<HTMLElement>('[aria-label="Delete Wave"]')!
        .click(),
    );

    act(() => harness.dialog?.onDeleted?.(harness.dialog.item!));

    expect(usePoseCreatorStore.getState().savedPoseIdentity?.itemId).toBe(
      "other-item",
    );
  });
});
