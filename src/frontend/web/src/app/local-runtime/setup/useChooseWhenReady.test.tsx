// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useChooseWhenReady } from "./useChooseWhenReady";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
const choose = vi.fn();

function Probe(props: {
  loaded: boolean;
  ready: boolean;
  modelId: string | null;
}) {
  useChooseWhenReady(
    props.loaded,
    { ready: props.ready, modelId: props.modelId },
    choose,
  );
  return null;
}

function show(ready: boolean, modelId: string | null, loaded = true) {
  act(() =>
    root.render(<Probe loaded={loaded} ready={ready} modelId={modelId} />),
  );
}

beforeEach(() => {
  choose.mockReset();
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => act(() => root.unmount()));

describe("choosing a provider's model during setup", () => {
  it("chooses when the provider becomes ready with its model", () => {
    show(false, null);
    show(true, "openai:luna");
    expect(choose).toHaveBeenCalledExactlyOnceWith("openai:luna");
  });

  it("waits for a model that arrives after readiness, as a plan's models do", () => {
    show(false, null);
    show(true, null);
    expect(choose).not.toHaveBeenCalled();
    show(true, "plan:luna");
    expect(choose).toHaveBeenCalledExactlyOnceWith("plan:luna");
    // Later catalog changes do not choose again.
    show(true, "plan:terra");
    expect(choose).toHaveBeenCalledTimes(1);
  });

  it("chooses nothing for a provider that was ready before setup acted", () => {
    show(true, "openai:luna", false);
    show(true, "openai:luna");
    show(true, "openai:terra");
    expect(choose).not.toHaveBeenCalled();
  });

  it("forgets a provider that stopped being ready before its model arrived", () => {
    show(false, null);
    show(true, null);
    show(false, null);
    show(false, "plan:luna");
    expect(choose).not.toHaveBeenCalled();
  });
});
