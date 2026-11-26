// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePoseCreatorStore } from "@/stores/pose-creator-store";
import { PoseEditorWorkspace } from "./PoseEditorPage";

const harness = vi.hoisted(() => ({
  loaded: false,
  itemError: null as Error | null,
}));

vi.mock("@animama/product-ui", () => ({
  useProductApiClient: () => ({ admitted: "composition client" }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: unknown }) => <a>{children as never}</a>,
  useNavigate: () => vi.fn(async () => undefined),
  useBlocker: () => ({ status: "idle" }),
}));
vi.mock("@tanstack/react-query", () => ({ useIsMutating: () => 0 }));
vi.mock("@/app/runtime/RuntimeOwnerContext", () => ({
  useRuntimeCacheKey: () => "owner",
}));
vi.mock("./poseEditorSession", () => ({
  PoseEditorSession: class {
    activate() {}
    cancelPending() {}
    isLoaded() {
      return harness.loaded;
    }
    adoptSavedItem() {}
    load() {
      return Promise.resolve(true);
    }
  },
}));
vi.mock("@/query/hooks/usePoses", () => ({
  usePose: () => ({
    isPending: false,
    data: undefined,
    error: harness.itemError,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/ui/action-editor/useActionEditorDesktopLayout", () => ({
  useActionEditorDesktopLayout: () => true,
}));
vi.mock("./PoseEditorScene", () => ({ PoseEditorScene: () => null }));
vi.mock("@/ui/pose-creator/PoseCreatorLibrarySection", () => ({
  PoseCreatorLibrarySection: () => null,
}));
vi.mock("@/ui/pose-creator/PosePrimaryActions", () => ({
  PosePrimaryActions: () => null,
}));
vi.mock("@/ui/pose-creator/PoseCreatorBoneSection", () => ({
  PoseCreatorBoneSection: () => null,
}));
vi.mock("@/ui/pose-creator/PoseCreatorExpressionSection", () => ({
  PoseCreatorExpressionSection: () => null,
}));
vi.mock("@/ui/pose-creator/PoseCreatorPreviewSettingsPanel", () => ({
  PoseCreatorPreviewSettingsPanel: () => null,
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement;

function render() {
  container = document.createElement("div");
  document.body.append(container);
  act(() => {
    root = createRoot(container);
    root.render(<PoseEditorWorkspace poseId="pose-item" />);
  });
}
const alertText = () => container.querySelector('[role="alert"]')?.textContent;

beforeEach(() => {
  usePoseCreatorStore.getState().resetWorkspace();
  harness.loaded = false;
  harness.itemError = new Error("Not Found");
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
});

describe("Pose editor item errors", () => {
  it("reports a Pose that could not be loaded", () => {
    render();
    expect(alertText()).toContain("Pose could not be loaded.");
  });

  it("keeps editing the loaded draft after its saved Pose is deleted", () => {
    // Deleting the open Pose keeps its draft; refetching the item then 404s.
    harness.loaded = true;
    render();
    expect(alertText()).toBeUndefined();
  });
});
