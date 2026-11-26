import { renderToStaticMarkup } from "react-dom/server";
import { getI18n } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PyModelAssetState } from "@animama/runtime-contracts/api-types";
import {
  DownloadGuardError,
  PACK_WORK_BLOCKS_ASSET,
} from "@/query/model-download-coordination";
import {
  HostSpeechModelsNote,
  modelChangeErrorText,
  requestModelChange,
  useOfflineSpeechDownloads,
  type OfflineSpeechDownloadsViewProps,
} from "./OfflineSpeechDownloads";
import { VoiceCloneSettings } from "./VoiceDownloads";

const manager = vi.hoisted(() => ({
  assets: [] as PyModelAssetState[],
  retryAssetIds: new Set<string>(),
  mutate: vi.fn(),
  blockedReason: null as string | null,
  offered: true,
  downloadsOffered: true,
  /** Local runtimes administer their own model installation. */
  capabilities: {
    offline_speech_enabled: false,
    local_filesystem_administration: true,
  } as Record<string, unknown>,
}));

const clients = vi.hoisted(() => {
  const client = () => ({
    disposeIdle: vi.fn(async () => true),
    getLastBackendState: () => null,
    getWebgpuStatus: vi.fn(() => new Promise(() => undefined)),
  });
  return { parakeet: client(), sensevoice: client() };
});
vi.mock("@/lib/speech/offline-stt/clients", () => ({
  offlineSttClients: clients,
  get OFFLINE_SPEECH_DOWNLOADS_OFFERED() {
    return manager.offered;
  },
}));
vi.mock("@/hooks/usePocketVoiceDownloads", () => ({
  usePocketVoiceDownloads: () => ({
    availability: () => null,
    install: manager.mutate,
    remove: manager.mutate,
  }),
}));
vi.mock("@/query/hooks/useModelAssets", async (importOriginal) => ({
  // The real operator-managed check reads the mocked runtime capabilities.
  ...(await importOriginal<typeof import("@/query/hooks/useModelAssets")>()),
  useModelAssets: () => ({
    data: {
      assets: manager.assets,
      free_bytes: 40 * 1024 ** 3,
      downloads_offered: manager.downloadsOffered,
    },
    retryAssetIds: manager.retryAssetIds,
  }),
}));
vi.mock("@/query/hooks/useRuntimeCapabilities", () => ({
  useRuntimeCapabilities: () => ({ data: manager.capabilities }),
}));
// The clone library has its own tests; these cover the encoder download row.
vi.mock("@/ui/animas/VoiceCloneLibrary", () => ({
  VoiceCloneLibrary: () => null,
}));
vi.mock("./SavedVoiceClones", () => ({ SavedVoiceClones: () => null }));
vi.mock("@/query/mutations/useModelAssetActions", () => ({
  useModelAssetAction: () => ({
    mutate: manager.mutate,
    isPending: false,
    busy: false,
    blockedReason: manager.blockedReason,
  }),
}));

const ENDED_NOTE =
  "Animama no longer offers model downloads. Anything already downloaded keeps working; chat, Avatars and the built-in voices need no downloads.";

const set = (
  id: string,
  size: number,
  extra: Partial<PyModelAssetState> = {},
): PyModelAssetState => ({
  id,
  status: "not_installed",
  size_bytes: size,
  required_free_bytes: size * 2,
  media_type: null,
  license_ref: "CC-BY-4.0",
  files_total: id === "parakeet-stt" ? 7 : 3,
  files_verified: 0,
  ...extra,
});

describe("model change errors", () => {
  it("explains refusals from the backend without raw payloads", () => {
    expect(
      modelChangeErrorText({ detail: { code: "model_asset_in_use" } }),
    ).toBe(
      "Speech recognition is in use. Close dictation and Voice Mode to remove it.",
    );
    expect(
      modelChangeErrorText({ detail: { code: "model_asset_required_by" } }),
    ).toBe("Remove GPU acceleration first.");
    expect(modelChangeErrorText(new Error("/private/path"))).not.toContain(
      "/private",
    );
    expect(
      modelChangeErrorText({ detail: { code: "model_downloads_ended" } }),
    ).toBe(ENDED_NOTE);
  });

  it("words the feature pack guard in the UI Locale", async () => {
    // Thrown in English, shown after the switch: the guard follows the locale.
    const guard = new DownloadGuardError(PACK_WORK_BLOCKS_ASSET);
    await getI18n().changeLanguage("ja");
    try {
      expect(modelChangeErrorText(guard)).toBe(
        getI18n().t("app:featurePacks.guards.packChangeRunning"),
      );
    } finally {
      await getI18n().changeLanguage("en");
    }
  });
});

describe("sending a model change", () => {
  it("releases the idle leases of the engine whose set is removed", async () => {
    let props!: OfflineSpeechDownloadsViewProps;
    function Probe() {
      props = useOfflineSpeechDownloads("sensevoice");
      return null;
    }
    renderToStaticMarkup(<Probe />);
    expect(props.engine).toBe("sensevoice");
    props.onChange("remove", "sensevoice-stt");
    await vi.waitFor(() =>
      expect(manager.mutate).toHaveBeenCalledWith(
        { action: "remove", assetId: "sensevoice-stt" },
        expect.anything(),
      ),
    );
    expect(clients.sensevoice.disposeIdle).toHaveBeenCalledOnce();
    expect(clients.parakeet.disposeIdle).not.toHaveBeenCalled();
  });

  it("releases this page's idle leases before sending a removal", async () => {
    const order: string[] = [];
    let finishRelease!: () => void;
    const releaseIdleLeases = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRelease = () => {
            order.push("released");
            resolve();
          };
        }),
    );
    const send = vi.fn(() => order.push("sent"));
    const removal = requestModelChange("remove", "parakeet-stt", {
      releaseIdleLeases,
      send,
    });
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();
    finishRelease();
    await removal;
    expect(order).toEqual(["released", "sent"]);
    expect(send).toHaveBeenCalledWith({
      action: "remove",
      assetId: "parakeet-stt",
    });
  });
  it("installs and cancels without touching leases", async () => {
    const releaseIdleLeases = vi.fn(async () => true);
    const send = vi.fn();
    await requestModelChange("install", "parakeet-stt", {
      releaseIdleLeases,
      send,
    });
    await requestModelChange("cancel", "parakeet-stt", {
      releaseIdleLeases,
      send,
    });
    expect(releaseIdleLeases).not.toHaveBeenCalled();
    expect(send.mock.calls.map(([request]) => request.action)).toEqual([
      "install",
      "remove",
    ]);
  });
});

describe("host speech models in Vite development", () => {
  it("shows each engine's acquire commands instead of downloads", () => {
    const html = [
      renderToStaticMarkup(<HostSpeechModelsNote engine="parakeet" />),
      renderToStaticMarkup(<HostSpeechModelsNote engine="sensevoice" />),
    ].join("");
    expect(html).toContain("scripts/models/parakeet.py acquire");
    expect(html).toContain("parakeet_webgpu.py acquire");
    expect(html).toContain("scripts/models/sensevoice.py acquire");
    expect(html).not.toContain("--source upstream");
    expect(html).toContain("sensevoice_webgpu.py acquire");
    expect(html).not.toContain("<button");
  });
});

describe("optional speech synthesis downloads", () => {
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
  beforeEach(() => {
    manager.assets = [{ ...encoder }];
    manager.retryAssetIds = new Set();
    manager.blockedReason = null;
  });
  const html = () => renderToStaticMarkup(<VoiceCloneSettings />);
  it("offers only the sized cloning action without a voice browser or eager install", () => {
    const result = html();
    expect(result).not.toContain("PocketTTS voices");
    expect(result).not.toContain("Browse voices");
    expect(result).toContain("Download voice cloning");
    expect(result).toContain("37.9 MB download");
    expect(result).not.toContain("Model attribution</summary>");
    expect(result).not.toContain("Select Eve");
    expect(manager.mutate).not.toHaveBeenCalled();
  });
  it("reconciles retry and installed states from the shared manager", () => {
    manager.retryAssetIds.add(encoder.id);
    expect(html()).toContain("Retry cloning download");
    manager.assets[0].status = "installed";
    expect(html()).toContain("Remove voice cloning");
    expect(html()).toContain("Saved clones work without this model");
    expect(html()).not.toContain("Retry cloning download");
  });
  it("keeps cancellation available during a raced native transition", () => {
    manager.assets[0].status = "downloading";
    manager.blockedReason = "Speech recognition is being activated.";
    expect(html()).toContain(manager.blockedReason);
    expect(html()).toMatch(
      /<button(?![^>]*disabled="")[^>]*>Cancel download<\/button>/u,
    );
  });
});

describe("operator-managed speech models", () => {
  const encoder = set("pocket-tts-voice-cloning-encoder", 39_768_446);
  const managedNote = "Speech models are managed by the hosted operator.";
  beforeEach(() => {
    manager.offered = true;
    manager.retryAssetIds = new Set();
    manager.blockedReason = null;
    // Hosted runtimes provision models; install and removal are refused.
    manager.capabilities = {
      offline_speech_enabled: true,
      offline_speech_asset_version: "fixture",
      local_filesystem_administration: false,
    };
  });
  afterEach(() => {
    manager.capabilities = {
      offline_speech_enabled: false,
      local_filesystem_administration: true,
    };
  });
  it.each([
    ["installed", "Installed · Saved clones work without this model."],
    ["not_installed", "Not available"],
  ] as const)(
    "shows a %s voice cloning model without download or removal",
    (status, text) => {
      manager.assets = [{ ...encoder, status }];
      const html = renderToStaticMarkup(<VoiceCloneSettings />);
      expect(html).toContain(text);
      expect(html).toContain(managedNote);
      expect(html).not.toContain("<button");
      expect(manager.mutate).not.toHaveBeenCalled();
    },
  );

  it("keeps self-hosted download actions", () => {
    manager.capabilities = { local_filesystem_administration: true };
    manager.assets = [encoder];
    const html = renderToStaticMarkup(<VoiceCloneSettings />);
    expect(html).not.toContain(managedNote);
    expect(html).toContain("Download voice cloning");
  });
});

describe("after model downloads have ended", () => {
  const encoder = set("pocket-tts-voice-cloning-encoder", 39_768_446);
  beforeEach(() => {
    manager.downloadsOffered = false;
    manager.retryAssetIds = new Set();
    manager.blockedReason = null;
  });
  afterEach(() => {
    manager.downloadsOffered = true;
  });

  it("reports the end to the speech recognition panels", () => {
    manager.assets = [set("parakeet-stt", 631_000_000)];
    let props!: OfflineSpeechDownloadsViewProps;
    function Probe() {
      props = useOfflineSpeechDownloads("parakeet");
      return null;
    }
    renderToStaticMarkup(<Probe />);
    expect(props.downloadsEnded).toBe(true);
  });

  it("explains a voice cloning model that was never installed, without a download", () => {
    manager.assets = [{ ...encoder, status: "not_installed" }];
    const html = renderToStaticMarkup(<VoiceCloneSettings />);
    expect(html).toContain("Not available");
    expect(html).toContain(ENDED_NOTE);
    expect(html).not.toContain("<button");
    expect(html).not.toContain("37.9 MB download");
  });

  it("keeps an installed voice cloning model removable", () => {
    manager.assets = [{ ...encoder, status: "installed" }];
    const html = renderToStaticMarkup(<VoiceCloneSettings />);
    expect(html).toContain("Remove voice cloning");
    expect(html).not.toContain(ENDED_NOTE);
  });
});
