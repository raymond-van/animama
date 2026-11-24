import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type {
  CredentialStatus,
  CredentialsBridge,
  ProviderCredentialStatus,
} from "../../../../shared/desktop-runtime";
import {
  DesktopCredentialFailures,
  DesktopCredentialsPanel,
  DesktopKeyStorageNote,
  desktopCredentialStorageKey,
} from "./DesktopCredentialsPanel";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { queryKeys } from "@/query/keys";
import {
  applyCredentialChanges,
  credentialChangesFromDrafts,
  credentialFailureMessage,
  refreshCredentialDependents,
  saveCredentialChanges,
} from "./desktop-credential-state";

const desktop = vi.hoisted(() => ({
  bridge: {
    list: async () => [] as unknown[],
    apply: async () => [] as unknown[],
  },
}));
vi.mock("@/platform/RuntimePlatformProvider", () => ({
  useRuntimePlatform: () => ({
    kind: "desktop",
    isDesktop: true,
    desktopBridge: {
      windowRole: "main",
      runtime: { status: async () => ({ state: "ready" }) },
      credentials: desktop.bridge,
    },
  }),
}));
vi.mock("@/app/runtime/RuntimeOwnerContext", () => ({
  useRuntimeCacheKey: () => "owner-1",
}));
vi.mock("@/hooks/useDesktopFeaturePacks", () => ({
  useDesktopFeaturePacks: () => ({ busy: false }),
}));

/** A client whose cache says keys can be managed and holds these statuses. */
function credentialClient(statuses: CredentialStatus[]): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(queryKeys.desktopCredentials.available("owner-1"), true);
  client.setQueryData(
    queryKeys.desktopCredentials.statuses("owner-1"),
    statuses,
  );
  return client;
}

const renderWith = (client: QueryClient, node: ReactNode) =>
  renderToStaticMarkup(
    <QueryClientProvider client={client}>{node}</QueryClientProvider>,
  );

const configured: ProviderCredentialStatus = {
  provider: "openai",
  configured: true,
  updatedAt: "2026-09-15T00:00:00Z",
  restartRequired: false,
};

function bridge(status = configured): CredentialsBridge {
  return {
    list: vi.fn(async () => [status]),
    apply: vi.fn(async () => [status]),
    storage: vi.fn(async () => ({ protection: "system" as const })),
  };
}

describe("credential failures after product-window recreation", () => {
  it("renders retained failures from main on a fresh view, including another provider", () => {
    const statuses: CredentialStatus[] = [
      configured,
      {
        ...configured,
        provider: "elevenlabs",
        error: "secure_storage_unavailable",
      },
    ];
    const first = renderToStaticMarkup(
      <DesktopCredentialFailures statuses={statuses} />,
    );
    const recreated = renderToStaticMarkup(
      <DesktopCredentialFailures statuses={statuses} />,
    );
    expect(recreated).toBe(first);
    expect(recreated).toContain('role="status"');
    expect(recreated).toContain("ElevenLabs: The key change could not finish.");
    expect(recreated).toContain("retry the change.");
    expect(recreated).not.toContain("Key saved");
  });

  it("shows saved-status recovery guidance without exposing an exception payload", () => {
    const html = renderToStaticMarkup(
      <DesktopCredentialFailures
        statuses={[
          {
            ...configured,
            error: "private exception payload must not be shown",
            restartRequired: true,
          },
        ]}
      />,
    );
    expect(html).toContain("Saved key status is shown above");
    expect(html).toContain("Open runtime recovery");
    expect(html).not.toContain("private exception payload");
    expect(
      renderToStaticMarkup(
        <DesktopCredentialFailures statuses={[configured]} />,
      ),
    ).toBe("");
  });

  it("does not announce a save as successful when main reports its failure", async () => {
    const current = bridge({
      ...configured,
      error: "secure_storage_unavailable",
    });
    await expect(
      applyCredentialChanges(current, [
        { provider: "openai", value: "fixture-new-key" },
      ]),
    ).rejects.toThrow("credential_change_failed");
  });

  it("does not claim deletion when the configured status remains true", async () => {
    await expect(
      applyCredentialChanges(bridge(), [{ provider: "openai" }]),
    ).rejects.toThrow("credential_change_failed");
  });

  it("accepts a save or removal only after main reports the corresponding saved status", async () => {
    await expect(
      applyCredentialChanges(bridge(), [
        { provider: "openai", value: "fixture-key" },
      ]),
    ).resolves.toEqual([configured]);
    const removed = { ...configured, configured: false, updatedAt: null };
    await expect(
      applyCredentialChanges(bridge(removed), [{ provider: "openai" }]),
    ).resolves.toEqual([removed]);
  });
});

describe("refreshing key-dependent queries", () => {
  it("invalidates model availability and connection key status for the owner", async () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await refreshCredentialDependents(client, "owner-1");

    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual(
      [
        ["model-providers", "owner-1"],
        ["model-configuration", "owner-1"],
        ["desktop-credentials", "owner-1", "statuses"],
      ],
    );
  });
});

describe("credential failure copy", () => {
  it("never reads as a success, which the packaged smoke waits for", () => {
    const codes = [
      "connection_credentials_full",
      "secure_storage_unavailable",
      "credential_delivery_failed",
      "backend_readiness_mismatch",
      "runtime_not_ready",
    ];
    for (const error of codes)
      for (const restartRequired of [false, true]) {
        const message = credentialFailureMessage({
          ...configured,
          error,
          restartRequired,
        });
        expect(message).toBeTruthy();
        expect(message).not.toMatch(/\bsaved\./iu);
        expect(message).not.toMatch(/restart/iu);
      }
  });
});

describe("batched API key changes", () => {
  const status = (
    provider: ProviderCredentialStatus["provider"],
    configured: boolean,
    extra: Partial<ProviderCredentialStatus> = {},
  ): CredentialStatus => ({
    provider,
    configured,
    updatedAt: configured ? "2026-09-25T00:00:00Z" : null,
    restartRequired: false,
    ...extra,
  });
  const connection = (
    configured: boolean,
    extra: Partial<CredentialStatus> = {},
  ): CredentialStatus => ({
    connection: "ANIMAMA_CONNECTION_C_0123456789AB_API_KEY",
    configured,
    updatedAt: configured ? "2026-09-25T00:00:00Z" : null,
    restartRequired: false,
    ...extra,
  });

  it("builds one change per edited provider and ignores blank inputs", () => {
    expect(
      credentialChangesFromDrafts({
        openai: { value: "  fixture-key  " },
        elevenlabs: { value: "   ", remove: true },
      }),
    ).toEqual([
      { provider: "openai", value: "fixture-key" },
      { provider: "elevenlabs" },
    ]);
    expect(
      credentialChangesFromDrafts({
        elevenlabs: { value: "fixture-voice", remove: true },
      }),
    ).toEqual([{ provider: "elevenlabs", value: "fixture-voice" }]);
  });

  it("applies a batch in one call and confirms each saved status", async () => {
    const apply = vi.fn(async () => [
      status("openai", true),
      status("elevenlabs", false),
      connection(true),
    ]);
    const current = { ...bridge(), apply };
    await expect(
      applyCredentialChanges(current, [
        { provider: "openai", value: "fixture-key" },
        { provider: "elevenlabs" },
        {
          connection: "ANIMAMA_CONNECTION_C_0123456789AB_API_KEY",
          value: "fixture-connection",
        },
      ]),
    ).resolves.toHaveLength(3);
    expect(apply).toHaveBeenCalledOnce();
  });

  it("confirms a removed connection key by its absence", async () => {
    const current = {
      ...bridge(),
      apply: vi.fn(async () => [status("openai", true)]),
    };
    await expect(
      applyCredentialChanges(current, [
        { connection: "ANIMAMA_CONNECTION_C_0123456789AB_API_KEY" },
      ]),
    ).resolves.toHaveLength(1);
    await expect(
      applyCredentialChanges(current, [
        {
          connection: "ANIMAMA_CONNECTION_C_0123456789AB_API_KEY",
          value: "fixture",
        },
      ]),
    ).rejects.toMatchObject({
      failed: ["ANIMAMA_CONNECTION_C_0123456789AB_API_KEY"],
    });
  });

  it("reports only the keys whose change did not land", async () => {
    const current = {
      ...bridge(),
      apply: vi.fn(async () => [
        status("openai", true),
        status("elevenlabs", true, { error: "secure_storage_unavailable" }),
        connection(false, { error: "secure_storage_unavailable" }),
      ]),
    };
    await expect(
      applyCredentialChanges(current, [
        { provider: "openai", value: "fixture-key" },
        { provider: "elevenlabs" },
        {
          connection: "ANIMAMA_CONNECTION_C_0123456789AB_API_KEY",
          value: "fixture-connection",
        },
      ]),
    ).rejects.toMatchObject({
      failed: ["elevenlabs", "ANIMAMA_CONNECTION_C_0123456789AB_API_KEY"],
    });
  });
});

describe("feature-local key fields", () => {
  const unset: CredentialStatus[] = [
    { ...configured, configured: false, updatedAt: null },
    {
      provider: "elevenlabs",
      configured: false,
      updatedAt: null,
      restartRequired: false,
    },
  ];
  const inputs = (html: string) =>
    [...html.matchAll(/<label[^>]*>([^<]+)<\/label>/gu)].map(
      (match) => match[1],
    );

  it("shows only the filtered providers, without the general copy", () => {
    const client = credentialClient(unset);
    const filtered = renderWith(
      client,
      <DesktopCredentialsPanel
        providers={["elevenlabs"]}
        showTitle={false}
        description={null}
      />,
    );
    expect(inputs(filtered)).toEqual(["ElevenLabs"]);
    expect(filtered).not.toContain("Add an OpenAI");
    expect(filtered).toContain('type="password"');

    const full = renderWith(client, <DesktopCredentialsPanel />);
    expect(inputs(full)).toEqual([
      "OpenAI",
      "Anthropic",
      "ElevenLabs",
      "Gemini",
    ]);
    expect(full).toContain(
      "Keys are encrypted with this computer’s secure storage",
    );
  });

  it("says so wherever keys are entered when no secret store protects them", () => {
    const client = credentialClient(unset);
    const claim = "Keys are encrypted with this computer’s secure storage";
    const notice = "keys are saved without system protection";
    client.setQueryData(desktopCredentialStorageKey("owner-1"), {
      protection: "unprotected",
    });
    const full = renderWith(client, <DesktopCredentialsPanel />);
    expect(full).toContain(notice);
    // The usual statement would be false here.
    expect(full).not.toContain(claim);
    // Feature-local panels show no general copy, but still show the notice.
    expect(
      renderWith(
        client,
        <DesktopCredentialsPanel
          providers={["elevenlabs"]}
          showTitle={false}
          description={null}
        />,
      ),
    ).toContain(notice);
    // A host's own description says "Encrypted on this computer" too, so it
    // gives way to the notice as well.
    const hosted = renderWith(
      client,
      <DesktopCredentialsPanel description="Encrypted on this computer." />,
    );
    expect(hosted).toContain(notice);
    expect(hosted).not.toContain("Encrypted on this computer.");
    // The same notice stands alone for key fields outside the panel.
    expect(renderWith(client, <DesktopKeyStorageNote />)).toContain(notice);

    client.setQueryData(desktopCredentialStorageKey("owner-1"), {
      protection: "system",
    });
    const protectedPanel = renderWith(client, <DesktopCredentialsPanel />);
    expect(protectedPanel).not.toContain(notice);
    expect(protectedPanel).toContain(claim);
    expect(
      renderWith(
        client,
        <DesktopKeyStorageNote>
          Encrypted on this computer.
        </DesktopKeyStorageNote>,
      ),
    ).toContain("Encrypted on this computer.");
  });

  it("lets no key field state that keys are encrypted except through the storage note", () => {
    // `keys.encrypted` is the sentence under a feature's own key field. Shown
    // raw it would be false on a Linux desktop without a secret store.
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const sources = readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((name) => name.endsWith(".tsx") && !name.endsWith(".test.tsx"))
      .map((name) => ({
        name,
        text: readFileSync(path.join(root, name), "utf8"),
      }));
    const uses = sources.flatMap(({ name, text }) =>
      [...text.matchAll(/t\("keys\.encrypted"\)/gu)].map((match) => ({
        name,
        wrapped: /<DesktopKeyStorageNote[^<]*$/u.test(
          text.slice(0, match.index),
        ),
      })),
    );
    expect(uses.length).toBeGreaterThanOrEqual(2);
    expect(uses.filter((use) => !use.wrapped)).toEqual([]);
  });

  it("reports only its own keys' failures", () => {
    const client = credentialClient([
      { ...unset[0], error: "secure_storage_unavailable" },
      unset[1],
    ]);
    const html = renderWith(
      client,
      <DesktopCredentialsPanel providers={["elevenlabs"]} description={null} />,
    );
    expect(html).not.toContain("OpenAI: The key change could not finish");
    expect(
      renderWith(client, <DesktopCredentialsPanel providers={["openai"]} />),
    ).toContain("OpenAI: The key change could not finish");
  });

  it("shares saved status between a feature field and API Keys after a save in either", async () => {
    const client = credentialClient(unset);
    const both = () =>
      renderWith(
        client,
        <>
          <DesktopCredentialsPanel
            providers={["openai"]}
            showTitle={false}
            description={null}
          />
          <DesktopCredentialsPanel showTitle={false} />
        </>,
      );
    const openAiStatus = (html: string) =>
      [...html.matchAll(/>OpenAI<\/label><p[^>]*>([^<]+)<\/p>/gu)].map(
        (match) => match[1],
      );
    expect(openAiStatus(both())).toEqual(["Not set", "Not set"]);

    const saved: CredentialStatus[] = [configured, unset[1]];
    const current = {
      list: vi.fn(async () => saved),
      apply: vi.fn(async () => saved),
    };
    await expect(
      saveCredentialChanges(client, "owner-1", current, [
        { provider: "openai", value: "fixture-key" },
      ]),
    ).resolves.toEqual({ ok: true });

    expect(openAiStatus(both())).toEqual(["Configured", "Configured"]);
  });

  it("publishes main's reported status when a save fails", async () => {
    const client = credentialClient(unset);
    const failed: CredentialStatus[] = [
      { ...unset[0], error: "secure_storage_unavailable" },
      unset[1],
    ];
    const current = {
      list: vi.fn(async () => failed),
      apply: vi.fn(async () => failed),
    };
    await expect(
      saveCredentialChanges(client, "owner-1", current, [
        { provider: "openai", value: "fixture-key" },
      ]),
    ).resolves.toEqual({ ok: false, failed: ["openai"] });
    expect(
      client.getQueryData(queryKeys.desktopCredentials.statuses("owner-1")),
    ).toEqual(failed);
  });
});
