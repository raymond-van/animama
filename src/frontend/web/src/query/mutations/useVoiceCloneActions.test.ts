import { client as testApiClient } from "@animama/runtime-contracts/default-client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PyVoiceContent } from "@animama/runtime-contracts/api-types";
const api = vi.hoisted(() => ({
  save: vi.fn(),
  get: vi.fn(),
  stream: vi.fn(),
  encode: vi.fn(),
}));
vi.mock("@animama/runtime-contracts/sdk", async (original) => ({
  ...(await original<typeof import("@animama/runtime-contracts/sdk")>()),
  saveVoiceContent: api.save,
  getContentItemV1ContentItemsItemIdGet: api.get,
  streamContentFileV1ContentFilesFileRefGet: api.stream,
}));
vi.mock("@/lib/speech/pocket/catalog-builder", () => ({
  buildPocketVoiceCatalogFile: api.encode,
}));
import {
  renameSavedVoiceClone,
  savePreparedVoiceClone,
} from "./useVoiceCloneActions";
import { prepareVoiceClone } from "@/lib/speech/pocket/voice-clones";

const clone: PyVoiceContent = {
  item_id: "voice-item",
  name: "Original name",
  codec: "pocket-tts-catalog-v1",
  source: "local",
  editable: true,
  revision_sha256: "revision-1",
  logical_key: "local:voice:identity",
  files: [
    {
      file_ref: "source-ref",
      filename: "original.wav",
      logical_path: "original.wav",
      role: "source_sample",
      media_type: "audio/wav",
      size_bytes: 8,
      sha256: "source-hash",
      ordinal: 0,
      url: "/v1/content/files/source-ref",
    },
    {
      file_ref: "descriptor-ref",
      filename: "voice.json",
      logical_path: "voice.json",
      role: "descriptor",
      media_type: "application/json",
      size_bytes: 200,
      sha256: "descriptor-hash",
      ordinal: 1,
      url: "/v1/content/files/descriptor-ref",
    },
    {
      file_ref: "catalog-ref",
      filename: "voice.bin",
      logical_path: "voice.bin",
      role: "pocket_voice_catalog",
      media_type: "application/octet-stream",
      size_bytes: 7,
      sha256: "catalog-hash",
      ordinal: 2,
      url: "/v1/content/files/catalog-ref",
    },
  ],
};
const descriptor = {
  schema_version: 1,
  content_type: "voice",
  content_id: clone.logical_key,
  codec: clone.codec,
  name: clone.name,
  voices: ["neutral"],
  provenance: { encoder: "pocket-tts", format_version: 1 },
  files: clone
    .files!.filter((file) => file.role !== "descriptor")
    .map((file) => ({
      path: file.logical_path,
      role: file.role,
    })),
};

beforeEach(() => {
  vi.clearAllMocks();
  api.save.mockResolvedValue({ data: clone });
  api.encode.mockResolvedValue(new File(["catalog"], "voice.bin"));
  api.get.mockResolvedValue({
    data: {
      revision_sha256: clone.revision_sha256,
      relative_locator: "voices/original-folder",
      metadata: descriptor,
    },
  });
  api.stream.mockImplementation(
    async ({ path }: { path: { file_ref: string } }) => ({
      data: new Blob([path.file_ref === "source-ref" ? "original" : "catalog"]),
    }),
  );
});

describe("voice clone library writes", () => {
  it("retries a prepared creation with the same operation, descriptor and full original bytes", async () => {
    const prepared = await prepareVoiceClone(testApiClient, {
      name: "New voice",
      file: new File(["entire original"], "source.wav"),
      operationId: "create-operation",
    });
    api.save.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(
      savePreparedVoiceClone(testApiClient, prepared),
    ).rejects.toThrow("draft is preserved");
    await expect(savePreparedVoiceClone(testApiClient, prepared)).resolves.toBe(
      clone,
    );
    expect(api.encode).toHaveBeenCalledTimes(1);
    expect(api.save.mock.calls[0][0]).toEqual(api.save.mock.calls[1][0]);
    const { body } = api.save.mock.calls[1][0];
    expect(body.operation_id).toBe("create-operation");
    expect(JSON.parse(body.companion_paths_json)).toEqual([
      "original.wav",
      "voice.bin",
    ]);
    expect(await body.files[0].text()).toBe("entire original");
    expect(await body.files[1].text()).toBe("catalog");
  });

  it("renames the same item with unchanged original/catalog bytes, identity and provenance", async () => {
    await renameSavedVoiceClone(testApiClient, {
      clone,
      name: " Renamed voice ",
      operationId: "rename-operation",
    });
    expect(api.encode).not.toHaveBeenCalled();
    const { path, body } = api.save.mock.calls[0][0];
    expect(path).toEqual({ entry_name: "original-folder" });
    expect(body).toMatchObject({
      catalog_item_id: clone.item_id,
      expected_revision: "revision-1",
      operation_id: "rename-operation",
    });
    expect(JSON.parse(body.descriptor_json)).toEqual({
      ...descriptor,
      name: "Renamed voice",
    });
    expect(await body.files[0].text()).toBe("original");
    expect(await body.files[1].text()).toBe("catalog");
    expect(body.files).toHaveLength(2);
    expect(
      api.stream.mock.calls.map(([request]) => request.path.file_ref),
    ).toEqual(["source-ref", "catalog-ref"]);
  });

  it("renames an imported encoded-only clone without adding a recording or changing provenance", async () => {
    const importedClone = {
      ...clone,
      files: clone.files!.filter((file) => file.role !== "source_sample"),
    };
    const importedDescriptor = {
      ...descriptor,
      files: descriptor.files.filter((file) => file.role !== "source_sample"),
    };
    api.get.mockResolvedValueOnce({
      data: {
        revision_sha256: importedClone.revision_sha256,
        relative_locator: "voices/imported-folder",
        metadata: importedDescriptor,
      },
    });
    await renameSavedVoiceClone(testApiClient, {
      clone: importedClone,
      name: "Imported narrator",
      operationId: "rename-imported",
    });
    const { path, body } = api.save.mock.calls[0][0];
    expect(path).toEqual({ entry_name: "imported-folder" });
    expect(body).toMatchObject({
      catalog_item_id: importedClone.item_id,
      expected_revision: importedClone.revision_sha256,
      operation_id: "rename-imported",
    });
    expect(JSON.parse(body.descriptor_json)).toEqual({
      ...importedDescriptor,
      name: "Imported narrator",
    });
    expect(JSON.parse(body.companion_paths_json)).toEqual(["voice.bin"]);
    expect(body.files).toHaveLength(1);
    expect(await body.files[0].text()).toBe("catalog");
    expect(
      api.stream.mock.calls.map(([request]) => request.path.file_ref),
    ).toEqual(["catalog-ref"]);
    expect(api.encode).not.toHaveBeenCalled();
  });

  it.each(["missing catalog", "duplicate catalogs", "duplicate recordings"])(
    "rejects %s before loading or saving any bytes",
    async (caseName) => {
      const catalog = clone.files!.find(
        (file) => file.role === "pocket_voice_catalog",
      )!;
      const sample = clone.files!.find(
        (file) => file.role === "source_sample",
      )!;
      const files =
        caseName === "missing catalog"
          ? [sample]
          : caseName === "duplicate catalogs"
            ? [catalog, catalog]
            : [catalog, sample, sample];
      await expect(
        renameSavedVoiceClone(testApiClient, {
          clone: { ...clone, files },
          name: "Rename",
        }),
      ).rejects.toThrow();
      expect(api.stream).not.toHaveBeenCalled();
      expect(api.save).not.toHaveBeenCalled();
    },
  );

  it("rejects stale rename without reloading bytes or overwriting a newer descriptor", async () => {
    api.get.mockResolvedValueOnce({
      data: { revision_sha256: "newer-revision" },
    });
    await expect(
      renameSavedVoiceClone(testApiClient, { clone, name: "Changed" }),
    ).rejects.toMatchObject({ code: "catalog_revision_conflict" });
    expect(api.stream).not.toHaveBeenCalled();
    expect(api.save).not.toHaveBeenCalled();
  });

  it("reports a lost save reply as a connection failure", async () => {
    // A lost connection or paused runtime scope yields no HTTP response.
    const lost = { error: new TypeError("Failed to fetch") };
    api.save.mockResolvedValueOnce(lost);
    const prepared = await prepareVoiceClone(testApiClient, {
      name: "New voice",
      file: new File(["original"], "source.wav"),
      operationId: "create-operation",
    });
    const failure = savePreparedVoiceClone(testApiClient, prepared);
    await expect(failure).rejects.toMatchObject({
      status: null,
      message: expect.stringContaining("could not be reached"),
    });
    await expect(failure).rejects.not.toThrow(/Cannot read properties/);
  });

  it("refuses mutations to Included content", async () => {
    const included = { ...clone, source: "included" as const, editable: false };
    await expect(
      renameSavedVoiceClone(testApiClient, { clone: included, name: "Rename" }),
    ).rejects.toThrow("Local");
    expect(api.save).not.toHaveBeenCalled();
  });
});
