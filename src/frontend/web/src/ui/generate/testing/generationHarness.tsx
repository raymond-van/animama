import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { RuntimeCapabilities } from "@animama/runtime-contracts";

import { RuntimeOwnerProvider } from "@/app/runtime/RuntimeOwnerContext";
import { hostedCapabilitiesFixture } from "@/app/runtime/runtime-fixture";

/**
 * Mounts content assistant hooks and components as the application does:
 * inside a query cache and a runtime that reports the assistant, with every
 * request answered by the test's `fetch`. Test-only; needs a DOM (`happy-dom`).
 */

/** A local runtime that offers the content assistant. */
export const generationCapabilities: RuntimeCapabilities = {
  ...hostedCapabilitiesFixture,
  runtime_kind: "self_hosted_web",
  content_generation: true,
};

type RuntimeOptions = {
  fetch: (request: Request) => Promise<Response>;
  queryClient?: QueryClient;
  /** What the runtime reports; one that offers the assistant by default. */
  capabilities?: RuntimeCapabilities;
  /** Replay effects as development builds do (`StrictMode`). */
  strict?: boolean;
};

export type MountedNode = {
  container: HTMLElement;
  rerender: (node: ReactNode) => void;
  unmount: () => void;
  queryClient: QueryClient;
};

/** Render `node` inside the runtime; the owner's session key is `session`. */
export function renderInRuntime(
  node: ReactNode,
  options: RuntimeOptions,
): MountedNode {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const queryClient =
    options.queryClient ??
    new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // One object for the mount's life: a new transport would be a new session.
  const transport = {
    baseUrl: "http://runtime.fixture.test",
    fetch: options.fetch as typeof globalThis.fetch,
  };
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = (next: ReactNode) => {
    const tree = (
      <QueryClientProvider client={queryClient}>
        <RuntimeOwnerProvider
          ownerId="owner"
          sessionKey="session"
          transport={transport}
          capabilities={options.capabilities ?? generationCapabilities}
        >
          {next}
        </RuntimeOwnerProvider>
      </QueryClientProvider>
    );
    // Effects are replayed only below a StrictMode that wraps the mounted tree.
    act(() =>
      root.render(options.strict ? <StrictMode>{tree}</StrictMode> : tree),
    );
  };
  render(node);
  return {
    container,
    rerender: render,
    unmount: () => act(() => root.unmount()),
    queryClient,
  };
}

export type MountedHook<Props, Result> = {
  /** The hook's latest return value. */
  result: () => Result;
  rerender: (props: Props) => void;
  unmount: () => void;
  queryClient: QueryClient;
};

export function mountGenerationHook<Props, Result>(
  useHook: (props: Props) => Result,
  options: RuntimeOptions & { props: Props },
): MountedHook<Props, Result> {
  let latest!: Result;
  function Probe({ props }: { props: Props }) {
    latest = useHook(props);
    return null;
  }
  const mounted = renderInRuntime(<Probe props={options.props} />, options);
  return {
    result: () => latest,
    rerender: (props) => mounted.rerender(<Probe props={props} />),
    unmount: mounted.unmount,
    queryClient: mounted.queryClient,
  };
}

/** Let pending promises and the renders they cause finish. */
export async function settle(turns = 5): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

export type MountedInDocument = {
  container: HTMLElement;
  rerender: (node: ReactNode) => void;
  unmount: () => void;
};

/**
 * Render a component into the document, for tests that click it or open its
 * dialogs and popovers (which render into `document.body`). The component
 * needs no runtime: its data comes in through props or mocks.
 */
export function mountInDocument(node: ReactNode): MountedInDocument {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(node));
  return {
    container,
    rerender: (next) => act(() => root.render(next)),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

/** Click an element and let the renders and promises it causes finish. */
export async function click(
  element: Element | null | undefined,
): Promise<void> {
  if (!(element instanceof HTMLElement))
    throw new Error("Nothing to click: the element is not on the page.");
  await act(async () => {
    element.click();
  });
}
