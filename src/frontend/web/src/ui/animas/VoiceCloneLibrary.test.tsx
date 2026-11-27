// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PyModelAssetState } from "@animama/runtime-contracts/api-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PocketVoiceEncoderDownloadRequired } from "@/lib/speech/pocket/voice-cloning-encoder";
import { withRuntime } from "@/test/runtime-markup";
import { VoiceCloneLibrary } from "./VoiceCloneLibrary";

const fixture = vi.hoisted(() => ({
  capabilities: {} as Record<string, unknown>,
  downloadsEnded: false,
  prepare: vi.fn(),
  modelAction: vi.fn(),
}));

vi.mock("@/query/hooks/useRuntimeCapabilities", () => ({
  useRuntimeCapabilities: () => ({ data: fixture.capabilities }),
}));
vi.mock("@/query/hooks/useModelDownloadsEnded", () => ({
  useModelDownloadsEnded: () => fixture.downloadsEnded,
}));
vi.mock("@/lib/speech/pocket/voice-clones", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/speech/pocket/voice-clones")
  >()),
  prepareVoiceClone: fixture.prepare,
}));
vi.mock("@/query/mutations/useModelAssetActions", () => ({
  useModelAssetAction: () => ({ mutateAsync: fixture.modelAction }),
}));
vi.mock("@/query/mutations/useVoiceCloneActions", () => ({
  useVoiceCloneActions: () => ({
    saveVoiceClone: { mutateAsync: vi.fn() },
  }),
}));
// The download prompt's own copy is covered by its tests.
vi.mock("./VoiceCloningDownload", () => ({
  VoiceCloningDownload: () => <button type="button">Download and clone</button>,
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const encoder: PyModelAssetState = {
  id: "pocket-tts-voice-cloning-encoder",
  status: "not_installed",
  size_bytes: 39_768_446,
  required_free_bytes: 39_768_446,
  media_type: "application/octet-stream",
  license_ref: "pocket-tts-voice-cloning",
  files_total: 1,
  files_verified: 0,
};

let root: Root | null = null;
let container: HTMLElement | null = null;

/** Choose a sample and press Clone voice while the encoder is not installed. */
async function cloneWithoutEncoder() {
  container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(
      withRuntime(
        <VoiceCloneLibrary disabled={false} onBusyChange={() => {}} />,
      ),
    );
  });
  const input = container.querySelector<HTMLInputElement>(
    'input[aria-label="Upload custom voice sample"]',
  )!;
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [new File(["sample"], "Narrator.wav", { type: "audio/wav" })],
  });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const clone = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "Clone voice",
  )!;
  await act(async () => clone.click());
}

describe("voice cloning without the encoder", () => {
  beforeEach(() => {
    fixture.prepare.mockRejectedValue(
      new PocketVoiceEncoderDownloadRequired(encoder),
    );
    fixture.modelAction.mockReset();
    fixture.downloadsEnded = false;
  });
  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  it("explains an operator-managed encoder instead of offering a download", async () => {
    fixture.capabilities = { local_filesystem_administration: false };
    await cloneWithoutEncoder();
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("Download voice cloning?");
    expect(text).not.toContain("Download and clone");
    expect(text).toContain(
      "Voice cloning is not available here. Speech models are managed by the hosted operator.",
    );
    expect(fixture.modelAction).not.toHaveBeenCalled();
  });

  it("explains that voice cloning can no longer be downloaded once downloads have ended", async () => {
    fixture.capabilities = { local_filesystem_administration: true };
    fixture.downloadsEnded = true;
    await cloneWithoutEncoder();
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("Download voice cloning?");
    expect(text).not.toContain("Download and clone");
    expect(text).toContain(
      "Voice cloning needs a model that can no longer be downloaded. Saved clones keep working.",
    );
    expect(fixture.modelAction).not.toHaveBeenCalled();
  });

  it("offers the first-use download where the owner administers models", async () => {
    fixture.capabilities = { local_filesystem_administration: true };
    await cloneWithoutEncoder();
    const text = document.body.textContent ?? "";
    expect(text).toContain("Download voice cloning?");
    expect(text).toContain("Download and clone");
    expect(text).not.toContain("managed by the hosted operator");
  });
});
