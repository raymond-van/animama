// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostedComposition } from "@/app/hosted-runtime/hosted-composition";
import { RuntimeController } from "@/app/runtime/runtime-controller";
import { hostedCapabilitiesFixture as capabilities } from "@/app/runtime/runtime-fixture";
import { useUpdateUserSettings } from "./useUpdateUserSettings";

const mocks = vi.hoisted(() => ({
  controller: null as RuntimeController | null,
  patch: vi.fn(),
}));
vi.mock("@animama/product-ui", async (original) => ({
  ...(await original<object>()),
  useProductApiClient: () => ({}),
}));
vi.mock("@/app/runtime/RuntimeOwnerContext", () => ({
  useRuntimeCacheKey: () => mocks.controller?.getSnapshot().scope?.key,
}));
vi.mock("@/app/runtime/RuntimeAdmissionProvider", () => ({
  useOptionalRuntimeController: () => mocks.controller,
}));
vi.mock("@animama/runtime-contracts/sdk", () => ({
  patchUserSettingsV1UsersMeSettingsPatch: mocks.patch,
  getUserSettingsV1UsersMeSettingsGet: vi.fn(),
}));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const active = {
  schema_version: 1,
  state: "active",
  user_id: "owner",
  csrf_token: "csrf",
  recovery_session_id: "generation",
  capabilities,
  locale: { preference: "ko", visitor: "ko" },
};
const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((fn) => fn());
  mocks.patch.mockReset();
  mocks.controller = null;
});

async function fixture() {
  const fetch = vi.fn(async () => Response.json(active));
  let key = 0;
  const controller = new RuntimeController(
    createHostedComposition({
      baseUrl: "https://app.example.test",
      fetch,
      navigate: vi.fn(),
      sessionKey: () => `lifetime-${++key}`,
    }),
  );
  await controller.refresh();
  mocks.controller = controller;
  let update!: ReturnType<typeof useUpdateUserSettings>;
  function Harness() {
    update = useUpdateUserSettings();
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() =>
    root.render(
      <QueryClientProvider client={controller.getSnapshot().queryClient}>
        <Harness />
      </QueryClientProvider>,
    ),
  );
  cleanup.push(() => {
    act(() => root.unmount());
    controller.dispose();
  });
  return {
    controller,
    fetch,
    mutate: (body: Parameters<typeof update.mutateAsync>[0]["body"]) =>
      update.mutateAsync({ body }),
  };
}

describe("hosted settings locale acknowledgement", () => {
  it("does not mistake an arbitrary coded server error for proof that no write happened", async () => {
    const { fetch, mutate } = await fixture();
    mocks.patch.mockResolvedValueOnce({
      error: { detail: { code: "internal_error" } },
      response: new Response(null, { status: 500 }),
    });
    fetch.mockRejectedValue(new TypeError("offline"));
    await act(async () => {
      await expect(mutate({ locale: "ja" })).rejects.toMatchObject({
        detail: { code: "locale_save_outcome_unknown" },
      });
    });
    await act(async () => {
      await mutate({ locale: "ko" }).catch(() => {});
    });
    expect(mocks.patch).toHaveBeenCalledTimes(1);
  });
  it("does not let a stale account callback invalidate the current account's pending save", async () => {
    const { controller, fetch } = await fixture();
    const oldKey = controller.getSnapshot().scope!.key;
    const next = {
      ...active,
      user_id: "next-owner",
      recovery_session_id: "next-generation",
    };
    fetch.mockResolvedValueOnce(Response.json(next));
    await controller.refresh();
    const key = controller.getSnapshot().scope!.key;
    let finish!: () => void;
    const saved = controller.saveLocale(
      key,
      "ja",
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await expect(
      controller.saveLocale(oldKey, "ko", vi.fn()),
    ).rejects.toMatchObject({ name: "AbortError" });
    fetch.mockResolvedValueOnce(
      Response.json({ ...next, locale: { preference: "ja", visitor: "ja" } }),
    );
    finish();
    await saved;
    expect(controller.getSnapshot().locale).toEqual({
      preference: "ja",
      visitor: "ja",
    });
  });
  it("treats a lost browser response as unknown and requires readback before retry", async () => {
    const { controller, fetch, mutate } = await fixture();
    mocks.patch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    fetch.mockRejectedValue(new TypeError("offline"));
    await act(async () => {
      await expect(mutate({ locale: "ja" })).rejects.toMatchObject({
        detail: { code: "locale_save_outcome_unknown" },
      });
    });
    await act(async () => {
      await mutate({ locale: "ko" }).catch(() => {});
    });
    expect(mocks.patch).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().locale).toEqual(active.locale);
  });
  it("ignores a focus read begun before a confirmed save", async () => {
    const { controller, fetch, mutate } = await fixture();
    let stale!: (response: Response) => void;
    fetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          stale = resolve;
        }),
    );
    const focused = controller.refresh();
    fetch.mockResolvedValueOnce(
      Response.json({ ...active, locale: { preference: "ja", visitor: "ja" } }),
    );
    mocks.patch.mockResolvedValueOnce({ data: { locale: "ja" } });
    await act(async () => {
      await mutate({ locale: "ja" });
    });
    stale(Response.json(active));
    await focused;
    expect(controller.getSnapshot().locale).toEqual({
      preference: "ja",
      visitor: "ja",
    });
  });

  it("drops a late save from a replaced account", async () => {
    const { controller, fetch, mutate } = await fixture();
    let saved!: (result: unknown) => void;
    mocks.patch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          saved = resolve;
        }),
    );
    let pending!: ReturnType<typeof mutate>;
    await act(async () => {
      pending = mutate({ locale: "ja" });
    });
    fetch.mockResolvedValueOnce(
      Response.json({
        ...active,
        user_id: "another-owner",
        recovery_session_id: "new-generation",
        locale: { preference: "zh-Hant", visitor: "ko" },
      }),
    );
    await controller.refresh();
    await act(async () => {
      saved({ data: { locale: "ja" } });
      await pending;
    });
    expect(controller.getSnapshot().locale).toEqual({
      preference: "zh-Hant",
      visitor: "ko",
    });
    expect(
      controller.getSnapshot().queryClient.getQueryCache().getAll(),
    ).toHaveLength(0);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("clears both hints only on an explicit successful System default save", async () => {
    const { controller, fetch, mutate } = await fixture();
    fetch.mockResolvedValueOnce(
      Response.json({ ...active, locale: { preference: null, visitor: null } }),
    );
    mocks.patch.mockResolvedValueOnce({ data: { locale: null } });
    await act(async () => {
      await mutate({ locale: null });
    });
    expect(controller.getSnapshot().locale).toEqual({
      preference: null,
      visitor: null,
    });
  });

  it("keeps an unknown outcome unknown after readback, without inferring visitor persistence or replaying", async () => {
    const { controller, fetch, mutate } = await fixture();
    const error = { detail: { code: "locale_save_outcome_unknown" } };
    mocks.patch.mockRejectedValueOnce(error);
    fetch.mockResolvedValueOnce(
      Response.json({ ...active, locale: { preference: "ja", visitor: "ko" } }),
    );
    let caught: unknown;
    await act(async () => {
      try {
        await mutate({ locale: "ja" });
      } catch (error) {
        caught = error;
      }
    });
    expect(caught).toBe(error);
    expect(controller.getSnapshot().locale).toEqual({
      preference: "ja",
      visitor: "ko",
    });
    expect(mocks.patch).toHaveBeenCalledTimes(1);
  });

  it("requires a successful authority read before another write after an unknown result", async () => {
    const { controller, fetch, mutate } = await fixture();
    mocks.patch.mockRejectedValueOnce({
      detail: { code: "locale_save_outcome_unknown" },
    });
    fetch.mockRejectedValue(new TypeError("offline"));
    await act(async () => {
      await mutate({ locale: "ja" }).catch(() => {});
    });
    await act(async () => {
      await expect(mutate({ locale: "zh-Hant" })).rejects.toMatchObject({
        detail: { code: "locale_authority_unavailable" },
      });
    });
    expect(mocks.patch).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().locale).toEqual(active.locale);
    expect(controller.getSnapshot().reconnecting).toBe(true);
  });

  it("acknowledges a confirmed partial save even when readback fails, without compensating", async () => {
    const { controller, fetch, mutate } = await fixture();
    const error = { detail: { code: "locale_saved_settings_failed" } };
    mocks.patch.mockRejectedValueOnce(error);
    fetch.mockRejectedValue(new TypeError("offline"));
    await act(async () => {
      await expect(mutate({ locale: "ja", theme: "dark" })).rejects.toBe(error);
    });
    expect(controller.getSnapshot().locale).toEqual({
      preference: "ja",
      visitor: "ja",
    });
    expect(mocks.patch).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().reconnecting).toBe(true);
  });
  it("applies an explicit confirmed choice before readback and preserves the session", async () => {
    const { controller, fetch, mutate } = await fixture();
    const original = controller.getSnapshot();
    let finish!: (response: Response) => void;
    fetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    mocks.patch.mockResolvedValueOnce({ data: { locale: "ja" } });
    let saving!: ReturnType<typeof mutate>;
    await act(async () => {
      saving = mutate({ locale: "ja" });
    });
    expect(controller.getSnapshot().locale).toEqual({
      preference: "ja",
      visitor: "ja",
    });
    expect(controller.getSnapshot().scope).toBe(original.scope);
    expect(controller.getSnapshot().queryClient).toBe(original.queryClient);
    await act(async () => {
      finish(
        Response.json({
          ...active,
          locale: { preference: "ja", visitor: "ja" },
        }),
      );
      await saving;
    });
  });

  it("does not treat an unrelated materialized settings response as a locale acknowledgement", async () => {
    const { controller, fetch, mutate } = await fixture();
    mocks.patch.mockResolvedValueOnce({
      data: { locale: "ja", theme: "dark" },
    });
    await act(async () => {
      await mutate({ theme: "dark" });
    });
    expect(controller.getSnapshot().locale).toEqual(active.locale);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
