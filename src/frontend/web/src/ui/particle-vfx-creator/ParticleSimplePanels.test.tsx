// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PARTICLE_VFX_SIMPLE_NEUTRAL,
  applyParticleVFXEmitterPatch,
  createParticleVFXEditorDraftFromBlank,
  particleVFXSimpleControlBounds,
  type ParticleVFXSimpleFactors,
  type ParticleVFXSimpleReference,
} from "@/lib/avatar/particle-vfx";

import {
  ParticleSimpleAdjustPanel,
  ParticleSimpleEffectPanel,
  simpleLimitNote,
} from "./ParticleSimplePanels";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Count the bound searches; they still compute the real bounds.
vi.mock("@/lib/avatar/particle-vfx", async (original) => {
  const actual = await original<typeof import("@/lib/avatar/particle-vfx")>();
  return {
    ...actual,
    particleVFXSimpleControlBounds: vi.fn(
      actual.particleVFXSimpleControlBounds,
    ),
  };
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(element: React.ReactElement) {
  container = document.createElement("div");
  document.body.append(container);
  act(() => {
    root = createRoot(container!);
    root.render(element);
  });
  return {
    rerender: (next: React.ReactElement) => act(() => root!.render(next)),
  };
}

function slider(name: string): HTMLElement {
  const thumb = container!.querySelector<HTMLElement>(
    `[role="slider"][aria-label="${name}"]`,
  );
  if (!thumb) throw new Error(`No ${name} slider`);
  return thumb;
}

function press(element: HTMLElement, key: string) {
  act(() => {
    element.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  });
}

const blank = createParticleVFXEditorDraftFromBlank();
const reference: ParticleVFXSimpleReference = {
  catalog: blank.catalog,
  quarksJson: blank.quarksJson,
};
/** The colour theme at Original with nothing pending. */
const themeProps = {
  colourTheme: "original",
  themeStatus: { pending: null, error: null },
  onColourTheme: () => undefined,
} as const;

function swatches(): HTMLElement[] {
  return [...container!.querySelectorAll<HTMLElement>('[role="radio"]')];
}

function swatch(name: string): HTMLElement {
  const found = swatches().find((radio) => radio.textContent === name);
  if (!found) throw new Error(`No ${name} swatch`);
  return found;
}

describe("Particle Simple panels", () => {
  let frames: FrameRequestCallback[];
  beforeEach(() => {
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      frames[id - 1] = () => undefined;
    });
  });
  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    vi.unstubAllGlobals();
  });

  it("summarises the effect: its template or name, where it plays and its layers", () => {
    render(
      <ParticleSimpleEffectPanel
        templateName="Heart Burst"
        effectName="Heart Burst 1"
        anchorLabel="Chest"
        layerCount={6}
      />,
    );
    const text = container!.textContent;
    expect(text).toContain("From templateHeart Burst");
    expect(text).toContain("Plays atChest");
    expect(text).toContain("Layers6");
    expect(text).not.toContain("Heart Burst 1");

    act(() =>
      root!.render(
        <ParticleSimpleEffectPanel
          templateName={null}
          effectName=""
          anchorLabel="Head"
          layerCount={1}
        />,
      ),
    );
    expect(container!.textContent).toContain("EffectNew Particle FX");
  });

  it("labels four keyboard sliders with their percentages; each step is applied at once", () => {
    const onAdjust = vi.fn();
    const onAdjustStart = vi.fn();
    render(
      <ParticleSimpleAdjustPanel
        reference={reference}
        factors={{ ...PARTICLE_VFX_SIMPLE_NEUTRAL, speed: 150 }}
        onAdjustStart={onAdjustStart}
        onAdjust={onAdjust}
        onAdjustEnd={vi.fn()}
        {...themeProps}
      />,
    );
    for (const [name, value] of [
      ["Amount", "100 %"],
      ["Size", "100 %"],
      ["Speed", "150 %"],
      ["Spread", "100 %"],
    ])
      expect(slider(name).getAttribute("aria-valuetext")).toBe(value);
    expect(slider("Amount").getAttribute("aria-valuemax")).toBe("400");
    expect(slider("Size").getAttribute("aria-valuemin")).toBe("25");

    press(slider("Size"), "ArrowRight");
    press(slider("Size"), "ArrowRight");
    expect(onAdjust.mock.calls).toEqual([
      ["size", 105],
      ["size", 105],
    ]);
    expect(onAdjustStart).not.toHaveBeenCalled();
  });

  it("makes a drag one step and applies its latest value at most once a frame", () => {
    const calls: string[] = [];
    let factors: ParticleVFXSimpleFactors = { ...PARTICLE_VFX_SIMPLE_NEUTRAL };
    const panel = () => (
      <ParticleSimpleAdjustPanel
        reference={reference}
        factors={factors}
        onAdjustStart={() => calls.push("start")}
        onAdjust={(control, value) => {
          calls.push(`${control} ${value}`);
          factors = { ...factors, [control]: value };
        }}
        onAdjustEnd={() => calls.push("end")}
        {...themeProps}
      />
    );
    const view = render(panel());
    const spread = slider("Spread");
    const searches = vi.mocked(particleVFXSimpleControlBounds);
    searches.mockClear();

    // Pressing the thumb itself starts a drag without moving it.
    act(() => {
      spread.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    // Keyboard moves while the pointer is down stand in for pointer moves.
    press(spread, "ArrowRight");
    press(spread, "ArrowRight");
    press(spread, "ArrowRight");
    expect(calls).toEqual(["start"]);
    // The thumb shows the value before the draft catches up.
    expect(slider("Spread").getAttribute("aria-valuetext")).toBe("115 %");

    act(() => frames.splice(0).forEach((frame) => frame(0)));
    expect(calls).toEqual(["start", "spread 115"]);
    view.rerender(panel());
    // The draft moved, but the bounds stay those from the drag's start.
    expect(searches).not.toHaveBeenCalled();

    press(slider("Spread"), "ArrowRight");
    act(() => {
      slider("Spread").dispatchEvent(new Event("pointerup", { bubbles: true }));
    });
    // Release applies the pending value, then closes the step.
    expect(calls).toEqual(["start", "spread 115", "spread 120", "end"]);
    view.rerender(panel());
    // After the drag the bounds follow the new positions.
    expect(searches.mock.lastCall?.[1]).toEqual({
      ...PARTICLE_VFX_SIMPLE_NEUTRAL,
      spread: 120,
    });
    act(() => frames.splice(0).forEach((frame) => frame(0)));
    expect(calls).toHaveLength(4);
  });

  it("explains a slider a limit stops, and an Amount with nothing to scale", () => {
    expect(
      simpleLimitNote({
        min: 25,
        max: 205,
        minLimit: null,
        maxLimit: "particles",
      }),
    ).toBe("Stops at 205 %: higher would pass the 512-particle limit.");
    expect(
      simpleLimitNote({
        min: 100,
        max: 300,
        minLimit: "duration",
        maxLimit: null,
      }),
    ).toBe("Stops at 100 %: lower would run longer than 30 seconds.");
    expect(
      simpleLimitNote({ min: 25, max: 300, minLimit: null, maxLimit: null }),
    ).toBeNull();

    // One burst particle and no stream: a single-particle layer.
    const single = applyParticleVFXEmitterPatch(
      blank,
      blank.emitters[0]!.path,
      { burstCount: { min: 1, max: 1 } },
    );
    render(
      <ParticleSimpleAdjustPanel
        reference={{ catalog: single.catalog, quarksJson: single.quarksJson }}
        factors={PARTICLE_VFX_SIMPLE_NEUTRAL}
        onAdjustStart={vi.fn()}
        onAdjust={vi.fn()}
        onAdjustEnd={vi.fn()}
        {...themeProps}
      />,
    );
    expect(slider("Amount").hasAttribute("data-disabled")).toBe(true);
    expect(container!.textContent).toContain(
      "Each layer shows a single particle, so there is nothing to scale.",
    );
    // The description and the note describe the slider.
    const described = slider("Amount")
      .getAttribute("aria-describedby")!
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent);
    expect(described).toEqual([
      "How many particles each layer emits",
      "Each layer shows a single particle, so there is nothing to scale.",
    ]);
    expect(
      slider("Size")
        .getAttribute("aria-describedby")!
        .split(" ")
        .map((id) => document.getElementById(id)?.textContent),
    ).toEqual(["How big every particle is"]);
  });

  it("offers the colour theme as a labelled radio group of swatches", async () => {
    const onColourTheme = vi.fn();
    const panel = (
      colourTheme: "original" | "sky",
      themeStatus: { pending: "gold" | null; error: string | null },
    ) => (
      <ParticleSimpleAdjustPanel
        reference={reference}
        factors={PARTICLE_VFX_SIMPLE_NEUTRAL}
        onAdjustStart={vi.fn()}
        onAdjust={vi.fn()}
        onAdjustEnd={vi.fn()}
        colourTheme={colourTheme}
        themeStatus={themeStatus}
        onColourTheme={onColourTheme}
      />
    );
    const view = render(panel("sky", { pending: null, error: null }));

    const group = container!.querySelector<HTMLElement>('[role="radiogroup"]')!;
    expect(
      document.getElementById(group.getAttribute("aria-labelledby")!)
        ?.textContent,
    ).toBe("Colour theme");
    expect(swatches().map((radio) => radio.textContent)).toEqual([
      "Original",
      "Rose",
      "Gold",
      "Mint",
      "Sky",
      "Violet",
      "White",
    ]);
    // The chosen swatch is marked for assistive technology.
    expect(
      swatches().map((radio) => radio.getAttribute("aria-checked")),
    ).toEqual(["false", "false", "false", "false", "true", "false", "false"]);
    // Arrow keys move to the next swatch and choose it (Radix moves focus
    // on the next task).
    act(() => swatch("Sky").focus());
    press(swatch("Sky"), "ArrowRight");
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(document.activeElement).toBe(swatch("Violet"));
    expect(onColourTheme).toHaveBeenLastCalledWith("violet");
    act(() => swatch("Original").click());
    expect(onColourTheme).toHaveBeenLastCalledWith("original");

    // While a theme is applied: the choice shows, the work is announced and
    // the sliders wait; the swatches stay usable.
    view.rerender(panel("sky", { pending: "gold", error: null }));
    expect(swatch("Gold").getAttribute("aria-checked")).toBe("true");
    expect(group.getAttribute("aria-busy")).toBe("true");
    expect(container!.querySelector('[aria-live="polite"]')?.textContent).toBe(
      "Recolouring the art…",
    );
    expect(slider("Size").hasAttribute("data-disabled")).toBe(true);
    expect(swatch("Mint").hasAttribute("disabled")).toBe(false);

    view.rerender(
      panel("sky", { pending: null, error: "This effect shows no colour." }),
    );
    expect(container!.querySelector('[role="alert"]')?.textContent).toBe(
      "This effect shows no colour.",
    );
    expect(container!.querySelector('[aria-live="polite"]')?.textContent).toBe(
      "",
    );
    expect(slider("Size").hasAttribute("data-disabled")).toBe(false);
  });
});
