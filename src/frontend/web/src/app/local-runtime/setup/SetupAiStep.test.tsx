import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PyModelConnection,
  PyModelConnectionPreset,
} from "@animama/runtime-contracts/api-types";

import { SetupAiStep } from "./SetupAiStep";

const state = vi.hoisted(() => ({
  connections: [] as unknown[],
  presets: [] as unknown[],
}));
const idle = vi.hoisted(() => () => ({
  mutateAsync: async () => undefined,
  reset: () => undefined,
  isPending: false,
  isSuccess: false,
  data: undefined,
}));

vi.mock("@/platform/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/platform/env")>();
  return {
    ...actual,
    env: {
      ...actual.env,
      enableLocalModels: true,
      enableDeepseekHuggingface: true,
    },
  };
});
vi.mock("@/platform/RuntimePlatformProvider", () => ({
  useRuntimePlatform: () => ({ kind: "web", isDesktop: false }),
}));
vi.mock("@/app/runtime/RuntimeOwnerContext", () => ({
  useRuntimeCacheKey: () => "owner-1",
}));
vi.mock("@/query/hooks/useRuntimeCapabilities", () => ({
  useRuntimeCapabilities: () => ({
    isPending: false,
    isError: false,
    data: { model_configuration: true },
  }),
}));
vi.mock("@/query/hooks/useModelConfiguration", () => ({
  useModelConnections: () => ({
    isSuccess: true,
    isError: false,
    isFetching: false,
    data: state.connections,
  }),
  useModelConnectionPresets: () => ({ isSuccess: true, data: state.presets }),
  useModelRoles: () => ({
    isSuccess: true,
    isFetched: true,
    data: { roles: [] },
  }),
}));
vi.mock("@/query/hooks/useModelProviders", () => ({
  useModelProviders: () => ({
    isSuccess: true,
    isError: false,
    isFetching: false,
    data: [],
  }),
}));
vi.mock("@/query/hooks/useChatGPTPlan", () => ({
  useChatGPTPlanAvailable: () => false,
}));
vi.mock("@/query/mutations/useModelConfiguration", () => ({
  useAddOwnerModel: idle,
  useCreateModelConnection: idle,
  useDetectModelServer: idle,
  useListAvailableModels: idle,
  useProbeModel: idle,
  useRemoveModel: idle,
  useRemoveModelConnection: idle,
  useUpdateModel: idle,
  useUpdateModelConnection: idle,
}));

const preset = (id: string, local: boolean): PyModelConnectionPreset => ({
  id,
  label: id,
  local,
  expects_key: !local,
  logo_provider: id,
  compatibility: {},
  timeout_seconds: 60,
});

const connection = (
  id: string,
  extra: Partial<PyModelConnection>,
): PyModelConnection => ({
  id,
  name: id,
  preset: "custom",
  source: "owner",
  compatibility: {},
  credential_state: "not_required",
  models: [],
  ...extra,
});

function render(location: "cloud" | "local") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const noop = () => undefined;
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <SetupAiStep
        location={location}
        onLocationChange={noop}
        chatModelId={null}
        onChatModelChange={noop}
        onChatReadyChange={noop}
        credentialsController={null}
        onKeyPendingChange={noop}
        onKeyBusyChange={noop}
        onSetUpLater={noop}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.connections = [
    connection("Work proxy", { base_url: "https://llm.example.com/v1" }),
    connection("Docker Ollama", { base_url: "http://192.168.1.20:11434/v1" }),
    connection("Workstation vLLM", {
      preset: "vllm",
      base_url: "http://127.0.0.1:8000/v1",
    }),
  ];
  state.presets = [
    preset("ollama", true),
    preset("vllm", true),
    preset("openrouter", false),
    preset("custom", false),
  ];
});

describe("setup's AI step connections", () => {
  it("lets a custom cloud server be edited or removed", () => {
    const html = render("cloud");
    expect(html).toContain('aria-label="Edit Work proxy"');
    expect(html).toContain('aria-label="Remove Work proxy"');
    expect(html).toContain('aria-label="Add model to Work proxy"');
  });

  it("lets custom and known local servers be edited or removed", () => {
    const html = render("local");
    for (const name of ["Docker Ollama", "Workstation vLLM"]) {
      expect(html).toContain(`aria-label="Edit ${name}"`);
      expect(html).toContain(`aria-label="Remove ${name}"`);
    }
  });
});
