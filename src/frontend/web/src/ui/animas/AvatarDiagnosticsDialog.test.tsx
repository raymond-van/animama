// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AvatarLiveDiagnostics } from "@/lib/avatar/diagnostics/avatarDiagnostics";
import {
  avatarDiagnosticsJson,
  avatarDiagnosticsText,
  buildAvatarDiagnosticsReport,
} from "@/lib/avatar/diagnostics/avatarDiagnosticsReport";
import { AnimaSettingsModal } from "@/ui/main/header/AnimaSettingsModal";
import type { AvatarDiagnosticsView } from "./useAvatarDiagnostics";

const diagnostics = vi.hoisted(() => ({
  view: null as AvatarDiagnosticsView | null,
}));
vi.mock("./useAvatarDiagnostics", () => ({
  useAvatarDiagnostics: () => diagnostics.view,
}));
vi.mock("@/ui/settings/SettingsProvider", () => ({
  useSettings: () => ({
    userPreferences: {},
    animaPreferences: {},
    updateAnimaPreferences: vi.fn(),
    isLoading: false,
    isUpdating: false,
  }),
}));
// The panel's Avatar settings rows have their own tests.
// The Avatar choice row has its own tests.
vi.mock("@/ui/animas/AnimaAvatarChoiceRow", () => ({
  AnimaAvatarChoiceRow: () => null,
}));
vi.mock("@/query/hooks/useAvatarSettings", () => ({
  useAvatarSettingsAvailable: () => ({ available: false, checking: false }),
  useAvatarSettings: () => ({ data: undefined, isLoading: false }),
}));
vi.mock("@/query/mutations/useSaveAvatarSettings", () => ({
  useSaveAvatarSettings: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/query/hooks/useAnimaLoadout", () => ({
  useAnimaLoadout: () => ({ data: undefined }),
}));
vi.mock("@/query/hooks/useAnimaRuntimeCatalog", () => ({
  useAnimaRuntimeCatalog: () => ({ data: undefined }),
}));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const live: AvatarLiveDiagnostics = {
  face: {
    detected: true,
    parts: [
      {
        role: "face_skin",
        source: "signals",
        bindingCount: 1,
        regionCount: 0,
        confidence: 0.9,
      },
      {
        role: "eyeline",
        source: "missing",
        bindingCount: 0,
        regionCount: 0,
        confidence: 0,
      },
      {
        role: "eyelash",
        source: "signals",
        bindingCount: 0,
        regionCount: 2,
        confidence: 0.5,
      },
      {
        role: "eye_left",
        source: "estimated",
        estimate: "eye_bone",
        bindingCount: 0,
        regionCount: 0,
        confidence: 0.4,
      },
    ],
    landmarks: "ready",
    textureAnchors: "ready",
  },
  expressions: {
    presets: [
      { name: "happy", source: "model" },
      { name: "relaxed", source: "arkit" },
      { name: "blink", source: "left_right" },
      { name: "aa", source: "vrchat" },
      { name: "oh", source: "mmd" },
    ],
    missingPresets: ["lookUp"],
    arkit: { resolved: 41, total: 52, playsFaces: true },
    moods: [{ preset: "happy", brow: "mmd", eye: "mmd", mouth: "arkit" }],
    unresolved: { names: ["surprised"], otherCount: 2 },
  },
  motion: {
    humanoidBones: 52,
    missingRequiredBones: [],
    missingOptionalBones: [
      { bone: "upperChest", standIn: "chest", covers: "motion_and_contacts" },
      { bone: "leftEye", standIn: null, covers: "nothing" },
      {
        bone: "rightIndexDistal",
        standIn: "rightIndexIntermediate",
        covers: "contacts",
      },
    ],
    springJoints: 120,
    springColliders: 18,
    wind: {
      mode: "off",
      ambientForces: false,
      strength: 1,
      automaticOff: null,
    },
    restPose: {
      armDegrees: 40,
      handDegrees: 2,
      armsNormalized: true,
      handsNormalized: false,
    },
  },
  materials: {
    mode: "simple",
    lilToon: "fallback",
    automatic: null,
    nextLoad: null,
  },
  issues: [
    {
      code: "effect_face_part_missing",
      params: { effectId: "fx-1", part: "eyeline" },
    },
  ],
};

const report = buildAvatarDiagnosticsReport({
  avatar: { source: "local", itemId: "item-9" },
  file: {
    byteLength: 12 * 1024 * 1024,
    container: "glb",
    vrmVersion: "1.0",
    extensionsUsed: ["VRMC_vrm", "KHR_texture_transform"],
    extensionsRequired: [],
    meshCount: 3,
    primitiveCount: 17,
    morphedPrimitiveCount: 2,
    mismatchedMorphNameMeshCount: 0,
    humanoidBones: { remapped: 0, unweighted: 0 },
    materialCount: 12,
    materialKinds: { mtoon: 10, liltoon: 2, unlit: 0, pbr: 0 },
    unlitOnly: false,
    textures: [
      { mimeType: "image/png", byteLength: 4096, width: 2048, height: 1024 },
    ],
  },
  live,
  settings: {
    springMode: "off",
    springModeSource: "stored",
    windStrength: 100,
    windStrengthSource: "default",
    materialMode: "simple",
    materialModeSource: "stored",
  },
});

let root: Root | null = null;

function render() {
  const container = document.createElement("div");
  document.body.append(container);
  act(() => {
    root = createRoot(container);
    root.render(<AnimaSettingsModal animaId="anima-1" />);
  });
}

const buttonNamed = (name: string) =>
  [...document.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === name,
  );

function click(name: string) {
  const button = buttonNamed(name);
  if (!button) throw new Error(`No button named ${name}`);
  act(() => button.click());
}

const dialog = () => document.querySelector('[role="dialog"]');

beforeEach(() => {
  diagnostics.view = {
    state: { status: "ready", report, issues: live.issues, live: false },
    effectNames: new Map([["fx-1", "Sparkle"]]),
  };
  toast.success.mockReset();
  toast.error.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

describe("AvatarDiagnosticsDialog", () => {
  it("opens from the Anima settings panel on the File section", () => {
    render();
    expect(dialog()).toBeNull();
    click("Open diagnostics");

    const text = dialog()?.textContent ?? "";
    expect(text).toContain("Local Avatar · loaded for this view");
    expect(text).toContain("GLB · VRM 1.0");
    expect(text).toContain("KHR_texture_transform");
    expect(text).toContain("MToon 10");
    expect(text).toContain("2,048 × 1,024");
    expect(text).toContain("Simple materials · set to Simple");
    // Focus moves into the dialog.
    expect(dialog()?.contains(document.activeElement)).toBe(true);
  });

  const measured = { frameMs: null, pixels: null, samples: 0 } as const;
  it.each([
    [
      "fallback",
      {
        choice: "simple",
        reason: "slow",
        fpsCap: null,
        budgetFps: 24,
        frameMs: 40.04,
        pixels: 1_920_000,
        samples: 2,
      },
      "Simple materials · chosen by Automatic: this GPU drew a lilToon frame in 40 ms, over the 32.1 ms budget for 24 fps",
    ],
    [
      "rendered",
      {
        choice: "liltoon",
        reason: "remeasuring",
        fpsCap: 24,
        budgetFps: 24,
        frameMs: 40,
        pixels: 1_920_000,
        samples: 1,
      },
      "Rendered with lilToon at 24 fps · chosen by Automatic: this GPU drew a lilToon frame in 40 ms, over the 32.1 ms budget for 24 fps; measuring again before choosing Simple",
    ],
    [
      "rendered",
      {
        choice: "liltoon",
        reason: "capped",
        fpsCap: 45,
        budgetFps: 45,
        frameMs: 14.4,
        pixels: 1_920_000,
        samples: 1,
      },
      "Rendered with lilToon at 45 fps · chosen by Automatic: this GPU drew a lilToon frame in 14.4 ms, within the 17.1 ms budget for 45 fps",
    ],
    [
      "rendered",
      {
        choice: "liltoon",
        reason: "fast",
        fpsCap: 60,
        budgetFps: 60,
        frameMs: 5.2,
        pixels: 1_920_000,
        samples: 3,
      },
      "Rendered with lilToon at 60 fps · chosen by Automatic: this GPU drew a lilToon frame in 5.2 ms, within the 12.8 ms budget for 60 fps",
    ],
    [
      "rendered",
      {
        ...measured,
        choice: "liltoon",
        reason: "not_measured",
        fpsCap: null,
        budgetFps: null,
      },
      "Rendered with lilToon · chosen by Automatic: this GPU's lilToon frame time is not measured yet",
    ],
    [
      "rendered",
      {
        ...measured,
        choice: "liltoon",
        reason: "unsupported",
        fpsCap: null,
        budgetFps: null,
      },
      "Rendered with lilToon · chosen by Automatic: this browser cannot time the GPU",
    ],
  ] as const)(
    "says why Automatic loaded %s materials",
    (lilToon, decision, expected) => {
      const automaticReport = buildAvatarDiagnosticsReport({
        avatar: { source: "local", itemId: "item-9" },
        file: report.file,
        live: {
          ...live,
          materials: {
            mode: "automatic",
            lilToon,
            automatic: decision,
            nextLoad: null,
          },
        },
        settings: null,
      });
      diagnostics.view = {
        state: {
          status: "ready",
          report: automaticReport,
          issues: live.issues,
          live: false,
        },
        effectNames: new Map(),
      };
      render();
      click("Open diagnostics");
      expect(dialog()?.textContent).toContain(expected);
    },
  );

  it("says what the next load uses after a measurement since this load", () => {
    const measuredReport = buildAvatarDiagnosticsReport({
      avatar: { source: "local", itemId: "item-9" },
      file: report.file,
      live: {
        ...live,
        materials: {
          mode: "automatic",
          lilToon: "rendered",
          automatic: {
            choice: "liltoon",
            reason: "not_measured",
            fpsCap: null,
            budgetFps: null,
            frameMs: null,
            pixels: null,
            samples: 0,
          },
          nextLoad: {
            choice: "liltoon",
            reason: "capped",
            fpsCap: 45,
            budgetFps: 45,
            frameMs: 14.4,
            pixels: 5_184_000,
            samples: 1,
          },
        },
      },
      settings: null,
    });
    diagnostics.view = {
      state: {
        status: "ready",
        report: measuredReport,
        issues: live.issues,
        live: false,
      },
      effectNames: new Map(),
    };
    render();
    click("Open diagnostics");
    expect(dialog()?.textContent).toContain(
      "Rendered with lilToon · chosen by Automatic: this GPU's lilToon frame time is not measured yet",
    );
    expect(dialog()?.textContent).toContain(
      "Next load: Rendered with lilToon at 45 fps · chosen by Automatic: this GPU drew a lilToon frame in 14.4 ms, within the 17.1 ms budget for 45 fps (measured since this load)",
    );
    expect(avatarDiagnosticsText(measuredReport)).toContain(
      "  Next load: Automatic chose lilToon at 45 fps: the only lilToon frame measurement on this GPU took 14.4 ms of GPU time (5184000 pixels), within the 17.1 ms budget for 45 fps (measured since this load)",
    );
  });

  it("shows every section", () => {
    render();
    click("Open diagnostics");

    click("Face");
    expect(dialog()?.textContent).toContain("Face skin");
    expect(dialog()?.textContent).toContain("Model data");
    expect(dialog()?.textContent).toContain("Not found");
    expect(dialog()?.textContent).toContain("2 inside shared parts");
    expect(dialog()?.textContent).toContain("Estimated from the eye bone");

    click("Expressions");
    expect(dialog()?.textContent).toContain("relaxed (ARKit)");
    expect(dialog()?.textContent).toContain("blink (left and right blinks)");
    expect(dialog()?.textContent).toContain("aa (VRChat)");
    expect(dialog()?.textContent).toContain("oh (MMD)");
    expect(dialog()?.textContent).toContain("41 of 52");
    expect(dialog()?.textContent).toContain("2 custom names");

    click("Motion");
    expect(dialog()?.textContent).toContain("upperChest → chest");
    expect(dialog()?.textContent).toContain(
      "Gestures, poses and contacts use the bone below",
    );
    expect(dialog()?.textContent).toContain(
      "rightIndexDistal → rightIndexIntermediate",
    );
    expect(dialog()?.textContent).toContain("Contacts use");
    expect(dialog()?.textContent).toContain("Not moved");
    expect(dialog()?.textContent).toContain("leftEye");
    expect(dialog()?.textContent).toContain("120 joints · 18 colliders");
    expect(dialog()?.textContent).toContain("Off · no wind or updraft");
    expect(dialog()?.textContent).toContain("Saved for this Avatar");
    expect(dialog()?.textContent).toContain(
      "arms rest 40° from a T-pose, normalized · hands like VRoid's",
    );

    click("Warnings (1)");
    expect(dialog()?.textContent).toContain(
      "Sparkle was skipped: this Avatar has no detected eye lines.",
    );
    expect(dialog()?.textContent).toContain("effect_face_part_missing");

    click("Raw JSON");
    const tree = dialog()?.querySelector(
      '[role="group"][aria-label="Raw JSON"]',
    );
    expect(tree?.textContent).toContain(
      '"schema": "animama/avatar-diagnostics/1"',
    );
  });

  it("names an extension the runtime cannot load", () => {
    diagnostics.view = {
      state: {
        status: "ready",
        report,
        issues: [
          {
            code: "avatar_extension_unsupported",
            params: { extension: "KHR_draco_mesh_compression" },
          },
          { code: "avatar_load_failed" },
        ],
        live: false,
      },
      effectNames: new Map(),
    };
    render();
    click("Open diagnostics");
    click("Warnings (2)");
    expect(dialog()?.textContent).toContain(
      "The file requires KHR_draco_mesh_compression, a glTF extension this app cannot load yet, so the Avatar cannot be shown.",
    );
  });

  it("says when stored shape key names disagree", () => {
    diagnostics.view = {
      state: {
        status: "ready",
        report,
        issues: [
          { code: "morph_target_names_mismatched", params: { count: 1 } },
        ],
        live: false,
      },
      effectNames: new Map(),
    };
    render();
    click("Open diagnostics");
    click("Warnings (1)");
    expect(dialog()?.textContent).toContain(
      "1 mesh stores shape key names that disagree with each other or with its shape keys, so those shape keys stay unnamed",
    );
  });

  it("says a face was found as the head of a whole-body mesh part", () => {
    const wholeBody = structuredClone(report);
    wholeBody.live!.face.parts = [
      {
        role: "face_skin",
        source: "signals",
        headRegion: true,
        bindingCount: 0,
        regionCount: 1,
        confidence: 0.6,
      },
    ];
    diagnostics.view = {
      state: { status: "ready", report: wholeBody, issues: [], live: false },
      effectNames: new Map(),
    };
    render();
    click("Open diagnostics");
    click("Face");
    expect(dialog()?.textContent).toContain("Head of a whole-body mesh part");
    expect(dialog()?.textContent).toContain("1 inside a shared part");
  });

  it("says when a whole-body mesh part has no face on its head", () => {
    diagnostics.view = {
      state: {
        status: "ready",
        report,
        issues: [{ code: "face_parts_whole_body_head_missing" }],
        live: false,
      },
      effectNames: new Map(),
    };
    render();
    click("Open diagnostics");
    click("Warnings (1)");
    expect(dialog()?.textContent).toContain(
      "One mesh part holds the whole body, but no forward-facing part of it skinned to the head bone moves",
    );
  });

  it("says why painted face art was skipped", () => {
    diagnostics.view = {
      state: {
        status: "ready",
        report,
        issues: [
          {
            code: "effect_iris_mesh_missing",
            params: { effectId: "fx-1", part: "eye_left" },
          },
          { code: "effect_anchor_covered", params: { effectId: "fx-2" } },
          { code: "effect_face_texture_hidden", params: { effectId: "fx-3" } },
          { code: "effect_surface_too_dark", params: { effectId: "fx-4" } },
        ],
        live: false,
      },
      effectNames: new Map([
        ["fx-1", "Sparkle"],
        ["fx-2", "Blush"],
        ["fx-3", "Red Face"],
        ["fx-4", "Shiver"],
      ]),
    };
    render();
    click("Open diagnostics");
    click("Warnings (4)");
    expect(dialog()?.textContent).toContain(
      "Sparkle was skipped: this Avatar's left eye was estimated on the face and has no iris mesh part to paint on.",
    );
    expect(dialog()?.textContent).toContain(
      "Blush was skipped: where it is painted on the face lies under other parts of this Avatar",
    );
    expect(dialog()?.textContent).toContain(
      "Red Face was skipped: the face skin's material shows no base color texture",
    );
    expect(dialog()?.textContent).toContain(
      "Shiver was skipped: it darkens the face where it is painted, and the face there is too dark for the change to show.",
    );
  });

  it("expands and collapses the Raw JSON tree", () => {
    render();
    click("Open diagnostics");
    click("Raw JSON");
    const toggle = (name: string) =>
      [...dialog()!.querySelectorAll("button[aria-expanded]")].find((button) =>
        button.textContent?.startsWith(`"${name}"`),
      );
    // The top two levels start open; deeper containers start collapsed.
    expect(toggle("file")?.getAttribute("aria-expanded")).toBe("true");
    expect(toggle("extensionsUsed")?.getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(dialog()?.textContent).not.toContain('"KHR_texture_transform"');

    act(() => (toggle("extensionsUsed") as HTMLButtonElement).click());
    expect(dialog()?.textContent).toContain('"KHR_texture_transform"');

    click("Collapse all");
    expect(toggle("file")?.getAttribute("aria-expanded")).toBe("false");
    click("Expand all");
    const states = [...dialog()!.querySelectorAll("button[aria-expanded]")].map(
      (button) => button.getAttribute("aria-expanded"),
    );
    expect(states.length).toBeGreaterThan(5);
    expect(new Set(states)).toEqual(new Set(["true"]));
  });

  it("copies the text report and the JSON", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render();
    click("Open diagnostics");

    await act(async () => buttonNamed("Copy report")!.click());
    expect(writeText).toHaveBeenLastCalledWith(avatarDiagnosticsText(report));
    expect(toast.success).toHaveBeenLastCalledWith("Report copied.");

    click("Raw JSON");
    await act(async () => buttonNamed("Copy JSON")!.click());
    expect(writeText).toHaveBeenLastCalledWith(avatarDiagnosticsJson(report));
    vi.unstubAllGlobals();
  });

  it("navigates sections with buttons and closes on Escape", () => {
    render();
    click("Open diagnostics");
    const face = buttonNamed("Face")!;
    expect(buttonNamed("File")!.getAttribute("aria-current")).toBe("page");
    act(() => face.focus());
    expect(document.activeElement).toBe(face);
    act(() => face.click());
    expect(face.getAttribute("aria-current")).toBe("page");

    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(dialog()).toBeNull();
  });

  it("shows the loading and unavailable states", () => {
    diagnostics.view = { state: { status: "loading" }, effectNames: new Map() };
    render();
    click("Open diagnostics");
    expect(dialog()?.textContent).toContain("Reading the Avatar…");
    expect(buttonNamed("Copy report")!.disabled).toBe(true);

    diagnostics.view = {
      state: { status: "unavailable" },
      effectNames: new Map(),
    };
    act(() => root?.render(<AnimaSettingsModal animaId="anima-1" />));
    expect(dialog()?.textContent).toContain(
      "This Anima has no Avatar to check.",
    );
  });
});
