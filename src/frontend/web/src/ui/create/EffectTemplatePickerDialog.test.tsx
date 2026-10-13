// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EffectTemplatePickerDialog } from "./EffectTemplatePickerDialog";

// The link's target as an href, so tests can read where each card leads.
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    onClick,
    className,
    to,
    search,
  }: {
    children: ReactNode;
    onClick?: (event: MouseEvent) => void;
    className?: string;
    to: string;
    search?: { template: string };
  }) => (
    <a
      href={search ? `${to}?template=${search.template}` : to}
      className={className}
      onClick={(event) => {
        event.preventDefault();
        onClick?.(event.nativeEvent);
      }}
    >
      {children}
    </a>
  ),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type Props = Parameters<typeof EffectTemplatePickerDialog>[0];

function mount(props: Props) {
  const opener = document.createElement("button");
  opener.textContent = "Open";
  document.body.append(opener);
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(<EffectTemplatePickerDialog {...props} />);
  });
  return {
    opener,
    rerender: (next: Props) =>
      act(() => root.render(<EffectTemplatePickerDialog {...next} />)),
    unmount: () => {
      act(() => root.unmount());
      opener.remove();
      container.remove();
    },
  };
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("EffectTemplatePickerDialog focus", () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it("returns focus to the named opener when dismissed", async () => {
    let opener: HTMLButtonElement | null = null;
    const base: Props = {
      open: true,
      onOpenChange: vi.fn(),
      returnFocus: () => opener,
    };
    const view = mount(base);
    opener = view.opener;
    cleanup = view.unmount;
    await flush();
    expect(document.activeElement).not.toBe(opener);

    view.rerender({ ...base, open: false });
    await flush();
    expect(document.activeElement).toBe(opener);
  });

  it("leaves focus to the route after a starting point is chosen", async () => {
    let opener: HTMLButtonElement | null = null;
    const onChoose = vi.fn();
    const base: Props = {
      open: true,
      initialKind: "particle",
      onOpenChange: vi.fn(),
      onChoose,
      returnFocus: () => opener,
    };
    const view = mount(base);
    opener = view.opener;
    cleanup = view.unmount;
    await flush();
    const scratch = [...document.querySelectorAll("a")].find((link) =>
      link.textContent?.includes("Start from scratch"),
    );
    act(() => scratch!.click());
    expect(onChoose).toHaveBeenCalledOnce();

    view.rerender({ ...base, open: false });
    await flush();
    expect(document.activeElement).not.toBe(opener);
  });
});

describe("EffectTemplatePickerDialog templates", () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  /** Flush until `count` thumbnails have resolved (they load lazily). */
  async function thumbnails(picker: Element, count: number) {
    for (let tries = 0; tries < 50; tries += 1) {
      if (picker.querySelectorAll("img").length >= count) break;
      await flush();
    }
    return picker.querySelectorAll("img");
  }

  /** Open the picker at `kind`'s templates; returns its links and headings. */
  async function openAt(kind: "particle" | "avatar" | "scene") {
    const view = mount({
      open: true,
      initialKind: kind,
      onOpenChange: vi.fn(),
    });
    cleanup = view.unmount;
    await flush();
    const picker = document.querySelector(
      '[data-testid="effect-template-picker"]',
    )!;
    const links = new Map(
      [...picker.querySelectorAll("a")].map((link) => [
        link.textContent ?? "",
        link.getAttribute("href"),
      ]),
    );
    const headings = [...picker.querySelectorAll("h3")].map(
      (heading) => heading.textContent,
    );
    return { picker, links, headings };
  }

  it("offers the Particle templates by mechanic, each with its thumbnail", async () => {
    const { picker, links, headings } = await openAt("particle");

    expect(headings).toEqual([
      "Bursts",
      "Streams and auras",
      "Orbits and drifts",
      "Fireworks",
      "Weather",
    ]);
    expect(links.get("Start from scratch")).toBe("/particle-effects/new");
    expect(links.get("Heart Burst")).toBe(
      "/particle-effects/new?template=heart-burst",
    );
    expect(links.get("Heart Stream")).toBe(
      "/particle-effects/new?template=hearts-v1",
    );
    // Start from scratch plus the 16 templates, each with a thumbnail.
    expect(links.size).toBe(17);
    expect(await thumbnails(picker, 16)).toHaveLength(16);
    expect(picker.querySelector('img[src*="particle/heart-burst"]')).not.toBe(
      null,
    );
    expect(picker.textContent).not.toContain("no Particle FX templates");
  });

  it("offers the Scene backgrounds by family, then the focus presets", async () => {
    const { picker, links, headings } = await openAt("scene");

    expect(headings).toEqual([
      "Affection",
      "Esteem",
      "Delight",
      "Drive",
      "Alarm",
      "Rejection",
      "Revulsion",
      "Gloom",
      "Focus lines",
    ]);
    expect(links.get("Start from scratch")).toBe("/scene-effects/new");
    expect(links.get("Emotion Love")).toBe(
      "/scene-effects/new?template=scene-vfx-emotion-love",
    );
    expect(links.get("Focus Lines Dark")).toBe(
      "/scene-effects/new?template=dark",
    );
    expect(links.size).toBe(27);
    expect(await thumbnails(picker, 26)).toHaveLength(26);
    expect(picker.querySelector('img[src*="scene/dark"]')).not.toBe(null);
  });

  it("keeps the Avatar templates with their thumbnails", async () => {
    const { picker, links, headings } = await openAt("avatar");

    expect(headings[0]).toBe("Eyes");
    expect(links.get("Eye VV")).toBe("/avatar-effects/new?template=eye_vv");
    expect(await thumbnails(picker, 75)).toHaveLength(75);
  });
});
