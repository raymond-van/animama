// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { withRuntime } from "@/test/runtime-markup";

import { ParticleVFXCreatorPage } from "./ParticleVFXCreatorPage";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
  useBlocker: () => ({ status: "idle" }),
  useNavigate: () => vi.fn(),
}));
vi.mock("@/app/runtime/RuntimeOwnerContext", () => ({
  useRuntimeOwnerId: () => "owner",
  useRuntimeCacheKey: () => "fixture-session",
}));
vi.mock("@/query/hooks/useEffects", () => ({
  useParticleEffect: () => ({ data: undefined, isError: false }),
}));
vi.mock("./useParticleVFXSave", () => ({
  useParticleVFXSave: () => ({
    recoveryReady: true,
    recovered: false,
    isBusy: false,
    canSave: true,
    notices: [],
    stage: "idle",
    error: null,
    errorField: null,
    clearSaveErrorField: vi.fn(),
  }),
}));
vi.mock("@/ui/content-creator/useContentCreatorModelPreview", () => ({
  useContentCreatorModelPreview: () => ({ modelOptions: [] }),
}));
// The WebGL stage is not under test.
vi.mock("@/ui/avatar-preview/AvatarPreviewSurface", () => ({
  AvatarPreviewSurface: () => null,
}));
// No canvas here: textures sample as red and recolour to fake PNGs.
const codec = vi.hoisted(() => ({ failNext: false }));
vi.mock("@/lib/avatar/particle-vfx/editor/particleTextureCodec", async () => {
  const { fakeParticlePng, fakeParticleTextureCodec } =
    await import("@/test/particle-colour-theme");
  return {
    createParticleVFXTextureCodec: () => ({
      ...fakeParticleTextureCodec,
      recolour: async (
        ...args: Parameters<typeof fakeParticleTextureCodec.recolour>
      ) => {
        if (codec.failNext) {
          codec.failNext = false;
          throw new Error("The image could not be encoded.");
        }
        return fakeParticleTextureCodec.recolour(...args);
      },
      dispose: () => undefined,
    }),
    fetchBuiltInParticleVFXTexture: async () => fakeParticlePng(1),
  };
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render() {
  container = document.createElement("div");
  document.body.append(container);
  act(() => {
    root = createRoot(container!);
    // Catalog-backed toolbar parts stay idle: the page is under test.
    const queries = new QueryClient({
      defaultOptions: { queries: { enabled: false, retry: false } },
    });
    root.render(
      withRuntime(
        <QueryClientProvider client={queries}>
          <ParticleVFXCreatorPage />
        </QueryClientProvider>,
      ),
    );
  });
}

function query<T extends HTMLElement>(selector: string): T | null {
  return container!.querySelector<T>(selector);
}

function slider(name: string): HTMLElement {
  const thumb = query(`[role="slider"][aria-label="${name}"]`);
  if (!thumb) throw new Error(`No ${name} slider`);
  return thumb;
}

function tab(name: string): HTMLElement {
  const found = [
    ...container!.querySelectorAll<HTMLElement>('[role="tab"]'),
  ].find((element) => element.textContent === name);
  if (!found) throw new Error(`No ${name} tab`);
  return found;
}

function chooseMode(name: "Simple" | "Advanced") {
  act(() => {
    tab(name).dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0 }),
    );
  });
}

function pressRight(element: HTMLElement) {
  act(() => {
    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowRight",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

function undo() {
  const button = query<HTMLButtonElement>('button[aria-label^="Undo"]');
  if (!button) throw new Error("No Undo button");
  act(() => button.click());
}

/** Type into a field the way a person does, through React's onChange. */
function typeInto(label: string, value: string) {
  const input = query<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!input) throw new Error(`No ${label} field`);
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function swatch(name: string): HTMLElement {
  const found = [
    ...container!.querySelectorAll<HTMLElement>('[role="radio"]'),
  ].find((element) => element.textContent === name);
  if (!found) throw new Error(`No ${name} swatch`);
  return found;
}

/** Choose a swatch and let its recolouring finish. */
async function chooseSwatch(name: string) {
  await act(async () => {
    swatch(name).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function redo() {
  const button = query<HTMLButtonElement>('button[aria-label^="Redo"]');
  if (!button) throw new Error("No Redo button");
  act(() => button.click());
}

function headings(): string[] {
  return [...container!.querySelectorAll("h2")].map(
    (heading) => heading.textContent ?? "",
  );
}

describe("Particle Effect creator Simple mode", () => {
  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  it("opens in Simple with the effect and its four broad controls", () => {
    render();

    expect(tab("Simple").getAttribute("aria-selected")).toBe("true");
    expect(headings()).toEqual(expect.arrayContaining(["Effect", "Adjust"]));
    expect(headings()).not.toContain("Emitters");
    expect(container!.textContent).toContain("EffectNew Particle FX");
    expect(container!.textContent).toContain("Layers1");
    for (const name of ["Amount", "Size", "Speed", "Spread"])
      expect(slider(name).getAttribute("aria-valuetext")).toBe("100 %");
  });

  it("switches to today's panels, keeping the values Simple wrote", () => {
    render();
    pressRight(slider("Size"));
    expect(slider("Size").getAttribute("aria-valuetext")).toBe("105 %");

    chooseMode("Advanced");
    expect(headings()).toEqual(
      expect.arrayContaining(["Emitters", "Inspector"]),
    );
    expect(query('[role="slider"][aria-label="Size"]')).toBeNull();

    chooseMode("Simple");
    expect(slider("Size").getAttribute("aria-valuetext")).toBe("105 %");
  });

  it("keeps Simple's positions when the effect is renamed", () => {
    render();
    pressRight(slider("Spread"));
    typeInto("Particle FX name", "Wide sparkle");

    expect(slider("Spread").getAttribute("aria-valuetext")).toBe("105 %");
    expect(container!.textContent).toContain("EffectWide sparkle");
  });

  it("undoes a Simple step, and an Advanced edit returns Simple to 100 %", () => {
    render();
    pressRight(slider("Speed"));
    pressRight(slider("Speed"));
    expect(slider("Speed").getAttribute("aria-valuetext")).toBe("110 %");
    undo();
    expect(slider("Speed").getAttribute("aria-valuetext")).toBe("105 %");

    chooseMode("Advanced");
    const playback = query<HTMLInputElement>(
      'input[aria-label="Effect playback duration (s)"]',
    )!;
    // Speed 105 % played the 1.2 s effect in 1.1429 s.
    expect(playback.value).toBe("1.1429");
    typeInto("Effect playback duration (s)", "2");

    chooseMode("Simple");
    expect(slider("Speed").getAttribute("aria-valuetext")).toBe("100 %");
    // Undo restores the Simple position with the effect it belongs to.
    undo();
    expect(slider("Speed").getAttribute("aria-valuetext")).toBe("105 %");
  });

  it("applies a colour theme as one step that Undo and an Advanced edit return to Original", async () => {
    render();
    expect(swatch("Original").getAttribute("aria-checked")).toBe("true");

    await chooseSwatch("Sky");
    expect(swatch("Sky").getAttribute("aria-checked")).toBe("true");
    chooseMode("Advanced");
    // The emitter now draws the recoloured copy, the effect's own file.
    expect(container!.textContent).toContain("soft-dot-sky.png");
    chooseMode("Simple");

    undo();
    expect(swatch("Original").getAttribute("aria-checked")).toBe("true");
    redo();
    expect(swatch("Sky").getAttribute("aria-checked")).toBe("true");

    chooseMode("Advanced");
    typeInto("Effect playback duration (s)", "2");
    chooseMode("Simple");
    expect(swatch("Original").getAttribute("aria-checked")).toBe("true");
  });

  it("says why a theme failed and leaves the effect as it was", async () => {
    render();
    codec.failNext = true;
    await chooseSwatch("Gold");

    expect(container!.querySelector('[role="alert"]')?.textContent).toBe(
      "soft-dot.png could not be recoloured: The image could not be encoded.",
    );
    expect(swatch("Original").getAttribute("aria-checked")).toBe("true");
    expect(
      query<HTMLButtonElement>('button[aria-label^="Undo"]')?.disabled,
    ).toBe(true);
  });
});
