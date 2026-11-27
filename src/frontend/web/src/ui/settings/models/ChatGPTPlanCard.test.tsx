// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CHATGPT_MANAGE_USAGE_URL } from "@/query/hooks/useChatGPTPlan";
import { queryKeys } from "@/query/keys";
import { ChatGPTPlanCard } from "./ChatGPTPlanCard";

const SIGNED_OUT = {
  sign_in_available: true,
  unavailable_reason: null,
  state: "signed_out",
  email: null,
  plan_use_granted: false,
  sign_in_pending: false,
  confirmation_due: false,
  background_agreed: false,
  paused: false,
  failure: null,
};
const SIGNED_IN = {
  ...SIGNED_OUT,
  state: "signed_in",
  email: "person@example.test",
  plan_use_granted: true,
};
const AUTHORIZE_URL = "https://auth.openai.com/api/accounts/authorize?state=s";

const mocks = vi.hoisted(() => ({
  status: {} as Record<string, unknown>,
  get: vi.fn(),
  begin: vi.fn(),
  cancel: vi.fn(),
  signOut: vi.fn(),
  preferences: vi.fn(),
}));

vi.mock("@animama/runtime-contracts/sdk", () => ({
  getChatgptPlanV1ChatgptPlanGet: mocks.get,
  beginChatgptPlanSignInV1ChatgptPlanSignInPost: mocks.begin,
  cancelChatgptPlanSignInV1ChatgptPlanSignInDelete: mocks.cancel,
  signOutOfChatgptPlanV1ChatgptPlanSignOutPost: mocks.signOut,
  updateChatgptPlanPreferencesV1ChatgptPlanPreferencesPut: mocks.preferences,
}));
vi.mock("@/query/hooks/useRuntimeCapabilities", () => ({
  useRuntimeCapabilities: () => ({ data: { chatgpt_plan: true } }),
}));
vi.mock("@/app/runtime/RuntimeOwnerContext", () => ({
  useRuntimeCacheKey: () => "owner",
}));
vi.mock("@animama/product-ui", () => ({
  useProductApiClient: () => ({ admitted: "composition client" }),
}));
const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient;

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render(node: ReactNode) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <QueryClientProvider client={client}>{node}</QueryClientProvider>,
    );
  });
  await settle();
}

function button(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === name,
  );
  if (!found) throw new Error(`No button named ${name}`);
  return found as HTMLButtonElement;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
  });
  await settle();
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mocks.status = SIGNED_OUT;
  for (const mock of [
    mocks.get,
    mocks.begin,
    mocks.cancel,
    mocks.signOut,
    mocks.preferences,
  ])
    mock.mockReset();
  mocks.get.mockImplementation(async () => ({ data: mocks.status }));
  mocks.begin.mockImplementation(async () => {
    mocks.status = { ...SIGNED_OUT, sign_in_pending: true };
    return { data: { authorize_url: AUTHORIZE_URL } };
  });
  mocks.cancel.mockImplementation(async () => {
    mocks.status = SIGNED_OUT;
    return { data: undefined };
  });
  mocks.preferences.mockImplementation(
    async ({ body }: { body: Record<string, unknown> }) => ({
      data: {
        ...mocks.status,
        ...(body.confirmed ? { confirmation_due: false } : {}),
        ...(body.background_agreed === undefined
          ? {}
          : { background_agreed: body.background_agreed }),
      },
    }),
  );
  vi.spyOn(window, "open").mockImplementation(() => null);
  toasts.error.mockReset();
  toasts.success.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("ChatGPTPlanCard", () => {
  it("starts a sign-in in the browser and waits for it", async () => {
    await render(<ChatGPTPlanCard />);
    expect(document.body.textContent).toContain("Use your ChatGPT plan");
    expect(document.body.textContent).toContain("Not signed in");

    await click(button("Continue with ChatGPT"));

    expect(mocks.begin).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { enable_plan_use: false, ui_locale: "en" },
      }),
    );
    expect(window.open).toHaveBeenCalledWith(
      AUTHORIZE_URL,
      "_blank",
      "noopener,noreferrer",
    );
    expect(document.body.textContent).toContain(
      "Finish signing in in your browser",
    );

    await click(button("Open the sign-in page again"));
    expect(window.open).toHaveBeenCalledTimes(2);

    await click(button("Cancel"));
    expect(mocks.cancel).toHaveBeenCalled();
    expect(button("Continue with ChatGPT")).toBeTruthy();
  });

  it("explains why sign-in is not offered here", async () => {
    mocks.status = {
      ...SIGNED_OUT,
      sign_in_available: false,
      unavailable_reason: "remote_origin",
    };
    await render(<ChatGPTPlanCard />);

    expect(document.body.textContent).toContain(
      "Sign in from a browser on the computer running Animama",
    );
    expect(document.body.textContent).not.toContain("Continue with ChatGPT");
  });

  it("shows the account, usage, the background choice and sign-out", async () => {
    mocks.status = SIGNED_IN;
    await render(<ChatGPTPlanCard />);

    expect(document.body.textContent).toContain(
      "Signed in as person@example.test",
    );
    const usage = document.querySelector<HTMLAnchorElement>(
      `a[href="${CHATGPT_MANAGE_USAGE_URL}"]`,
    );
    expect(usage?.textContent).toContain("Manage usage");
    expect(usage?.rel).toBe("noreferrer");

    const background = document.querySelector<HTMLButtonElement>(
      'button[role="switch"]',
    )!;
    expect(background.getAttribute("aria-checked")).toBe("false");
    await click(background);
    expect(mocks.preferences).toHaveBeenCalledWith(
      expect.objectContaining({ body: { background_agreed: true } }),
    );
  });

  it("says when OpenAI could not confirm the sign-out", async () => {
    mocks.status = SIGNED_IN;
    mocks.signOut.mockImplementation(async () => {
      mocks.status = SIGNED_OUT;
      return { data: { was_signed_in: true, confirmed: false } };
    });
    await render(<ChatGPTPlanCard />);

    await click(button("Sign out"));

    expect(document.body.textContent).toContain(
      "OpenAI didn't confirm that the session ended",
    );
  });

  it("offers to enable plan use when the account signed in without it", async () => {
    mocks.status = { ...SIGNED_IN, plan_use_granted: false };
    await render(<ChatGPTPlanCard />);

    expect(document.body.textContent).toContain("plan use is off");
    await click(button("Enable plan use"));

    expect(mocks.begin).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ enable_plan_use: true }),
      }),
    );
  });

  it("asks once, unchecked, whether automatic memory updates may use the plan", async () => {
    mocks.status = { ...SIGNED_IN, confirmation_due: true };
    await render(<ChatGPTPlanCard />);

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("You're using your ChatGPT plan");
    // It names every kind of request that uses the plan.
    for (const use of [
      "chats with plan models",
      "chat titles and summaries",
      "memory updates you start",
      "drafts the assistant writes on the Generate page with a plan model",
    ])
      expect(dialog?.textContent).toContain(use);
    expect(
      dialog
        ?.querySelector('button[role="checkbox"]')
        ?.getAttribute("aria-checked"),
    ).toBe("false");

    await click(button("Got it"));

    expect(mocks.preferences).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { confirmed: true, background_agreed: false },
      }),
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("explains a declined sign-in and a session OpenAI ended", async () => {
    mocks.status = { ...SIGNED_OUT, failure: "access_denied" };
    await render(<ChatGPTPlanCard />);
    expect(document.body.textContent).toContain(
      "Sign-in was cancelled at OpenAI.",
    );

    act(() => root?.unmount());
    document.body.innerHTML = "";
    mocks.status = {
      ...SIGNED_OUT,
      state: "sign_in_required",
      email: "person@example.test",
    };
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(<ChatGPTPlanCard />);
    expect(document.body.textContent).toContain("OpenAI ended this session");
    expect(button("Continue with ChatGPT")).toBeTruthy();
  });

  it("keeps a signed-in account's controls where a new sign-in cannot start", async () => {
    mocks.status = {
      ...SIGNED_IN,
      sign_in_available: false,
      unavailable_reason: "remote_origin",
    };
    await render(<ChatGPTPlanCard />);

    expect(button("Sign out")).toBeTruthy();
    expect(document.querySelector('button[role="switch"]')).not.toBeNull();
    expect(document.body.textContent).toContain("Manage usage");
  });

  it("shows the usage-limit pause", async () => {
    mocks.status = { ...SIGNED_IN, paused: true };
    await render(<ChatGPTPlanCard />);

    expect(document.body.textContent).toContain("Paused after a usage limit");
  });

  it("explains missing secure storage, and other failed sign-ins", async () => {
    mocks.status = {
      ...SIGNED_OUT,
      sign_in_available: false,
      unavailable_reason: "secure_storage_unavailable",
    };
    await render(<ChatGPTPlanCard />);
    expect(document.body.textContent).toContain(
      "Secure storage isn't available",
    );

    act(() => root?.unmount());
    document.body.textContent = "";
    mocks.status = { ...SIGNED_OUT, failure: "id_token_invalid" };
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(<ChatGPTPlanCard />);
    expect(document.body.textContent).toContain(
      "Sign-in didn't complete. Try again.",
    );
  });

  it("words a sign-in that could not start from the backend's reason", async () => {
    mocks.begin.mockImplementation(async () => {
      throw {
        status: 409,
        detail: {
          code: "chatgpt_plan_sign_in_unavailable",
          reason: "secure_storage_unavailable",
        },
      };
    });
    await render(<ChatGPTPlanCard />);

    await click(button("Continue with ChatGPT"));

    expect(toasts.error).toHaveBeenCalledWith(
      expect.stringContaining("Secure storage isn't available"),
    );
    expect(window.open).not.toHaveBeenCalled();
  });

  it("follows the browser's return by polling, then asks for the confirmation", async () => {
    await render(<ChatGPTPlanCard />);
    await click(button("Continue with ChatGPT"));
    expect(document.body.innerHTML).not.toContain(AUTHORIZE_URL);
    const invalidate = vi.spyOn(client, "invalidateQueries");

    // Signed in, but the return is still storing the account's models.
    mocks.status = {
      ...SIGNED_IN,
      confirmation_due: true,
      sign_in_pending: true,
    };
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_200));
    });
    await settle();
    expect(invalidate).not.toHaveBeenCalledWith({
      queryKey: queryKeys.modelConfiguration.all("owner"),
    });

    mocks.status = { ...SIGNED_IN, confirmation_due: true };
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_200));
    });
    await settle();

    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "You're using your ChatGPT plan",
    );
    expect(document.body.innerHTML).not.toContain(AUTHORIZE_URL);
    // The return stored the account's models, so the catalog is read again.
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.modelConfiguration.all("owner"),
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.modelProviders.all("owner"),
    });
  });

  it("does not reread the catalog for an account already signed in", async () => {
    mocks.status = SIGNED_IN;
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await render(<ChatGPTPlanCard />);

    expect(invalidate).not.toHaveBeenCalledWith({
      queryKey: queryKeys.modelConfiguration.all("owner"),
    });
  });
});
