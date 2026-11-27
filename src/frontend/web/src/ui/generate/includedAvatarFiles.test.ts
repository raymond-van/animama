import { createHash } from "node:crypto";
import { createClient } from "@animama/runtime-contracts/sdk";
import { describe, expect, it, vi } from "vitest";

import type { IncludedAvatarId } from "@/lib/avatar/motion-authoring/headlessVrm";
import {
  createIncludedAvatarFiles,
  includedAvatarFile,
  isIncludedAvatarId,
  type IncludedAvatarCatalogItem,
} from "./includedAvatarFiles";
import { jsonResponse } from "./testing/generationFixtures";

const ORIGIN = "http://runtime.fixture.test";

function avatarItem(
  filename: string,
  source: "included" | "local",
  bytes = `bytes of ${filename}`,
) {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    item_id: `item-${source}-${filename}`,
    name: filename.replace(".vrm", ""),
    source,
    files: [
      {
        file_ref: `ref/${source}/${filename}`,
        filename,
        logical_path: filename,
        role: "vrm",
        ordinal: 1,
        media_type: "model/gltf-binary",
        size_bytes: bytes.length,
        sha256,
        // What a listing would say; a Local file's URL names no digest.
        url: `/v1/content/files/listed-${filename}`,
      },
    ],
  };
}

const CATALOG = [
  avatarItem("Custom.vrm", "local"),
  // A person's own Avatar that happens to share an Included file's name.
  avatarItem("Annie.vrm", "local", "someone's own Avatar"),
  avatarItem("Annie.vrm", "included"),
  avatarItem("Andrew.vrm", "included"),
  avatarItem("Other.vrm", "included"),
];

describe("isIncludedAvatarId", () => {
  it("accepts only Andrew and Annie", () => {
    expect(isIncludedAvatarId("Andrew")).toBe(true);
    expect(isIncludedAvatarId("Annie")).toBe(true);
    for (const value of [
      "Other",
      "andrew",
      "Annie.vrm",
      "toString",
      "__proto__",
      "",
      null,
      3,
    ])
      expect(isIncludedAvatarId(value)).toBe(false);
  });
});

describe("includedAvatarFile", () => {
  it("resolves each Included Avatar to its Included catalog file", () => {
    for (const id of ["Andrew", "Annie"] as const) {
      const listed = CATALOG.find(
        (item) => item.source === "included" && item.name === id,
      )!.files[0]!;
      expect(includedAvatarFile(id, CATALOG)).toEqual({
        file_ref: listed.file_ref,
        // The digest-keyed URL, which only an Included file answers.
        url: `/v1/content/files/${encodeURIComponent(listed.file_ref)}/sha256/${listed.sha256}`,
        media_type: "model/gltf-binary",
        size_bytes: listed.size_bytes,
        sha256: listed.sha256,
      });
    }
  });

  it("accepts no other id, whatever the catalog holds", () => {
    for (const id of ["Other", "Custom", "Annie.vrm", "toString", ""])
      expect(includedAvatarFile(id, CATALOG)).toBeNull();
  });

  it("never resolves a Local item, even one named like an Included file", () => {
    const local = CATALOG.filter((item) => item.source === "local");
    expect(includedAvatarFile("Annie", local)).toBeNull();
    // An item that only claims a source this page does not know is refused too.
    expect(
      includedAvatarFile("Annie", [
        { ...avatarItem("Annie.vrm", "included"), source: "shared" },
      ] as unknown as IncludedAvatarCatalogItem[]),
    ).toBeNull();
  });

  it("refuses a file whose digest cannot key the Included URL", () => {
    const item = avatarItem("Annie.vrm", "included");
    item.files[0]!.sha256 = "../../files/other";
    expect(includedAvatarFile("Annie", [item])).toBeNull();
    expect(includedAvatarFile("Annie", [{ source: "included" }])).toBeNull();
  });
});

describe("createIncludedAvatarFiles", () => {
  function runtime(catalog = CATALOG) {
    const requests: string[] = [];
    const answer = async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requests.push(url.pathname);
      if (url.pathname === "/v1/avatar-content")
        return jsonResponse({ items: catalog });
      const [, ref, digest] =
        /^\/v1\/content\/files\/(.+)\/sha256\/([0-9a-f]{64})$/.exec(
          url.pathname,
        ) ?? [];
      const file = catalog
        .filter((item) => item.source === "included")
        .flatMap((item) => item.files)
        .find(
          (entry) =>
            entry.file_ref === decodeURIComponent(ref ?? "") &&
            entry.sha256 === digest,
        );
      // As the backend: the digest path answers Included files only.
      return file
        ? new Response(`bytes of ${file.filename}`)
        : jsonResponse({ detail: { code: "content_file_not_found" } }, 404);
    };
    const fetcher = vi.fn(answer) as unknown as typeof fetch;
    const read = createIncludedAvatarFiles(
      createClient({ baseUrl: ORIGIN, fetch: fetcher }),
      { fetcher, apiBaseUrl: ORIGIN },
    );
    return { read, requests };
  }
  const text = async (bytes: Promise<ArrayBuffer>) =>
    new TextDecoder().decode(await bytes);

  it("reads both Included Avatars' verified bytes, listing the catalog once", async () => {
    const { read, requests } = runtime();
    expect(await text(read("Annie"))).toBe("bytes of Annie.vrm");
    expect(await text(read("Andrew"))).toBe("bytes of Andrew.vrm");
    expect(await text(read("Annie"))).toBe("bytes of Annie.vrm");
    expect(requests.filter((path) => path === "/v1/avatar-content")).toEqual([
      "/v1/avatar-content",
    ]);
    // Every byte request names an Included file by its digest.
    for (const path of requests.filter((path) => path.includes("/files/")))
      expect(path).toMatch(
        /^\/v1\/content\/files\/ref%2Fincluded%2FAn(nie|drew)\.vrm\/sha256\/[0-9a-f]{64}$/,
      );
  });

  it("refuses any other id before it asks the catalog", async () => {
    const { read, requests } = runtime();
    for (const id of ["Other", "Custom", "toString"])
      await expect(read(id as IncludedAvatarId)).rejects.toThrow(
        "Only the Included Avatars",
      );
    expect(requests).toEqual([]);
  });

  it("fails when the catalog has no Included item for the Avatar", async () => {
    const { read, requests } = runtime(
      CATALOG.filter((item) => item.source === "local"),
    );
    await expect(read("Annie")).rejects.toThrow("not in the catalog");
    // The person's own Annie.vrm was not requested.
    expect(requests).toEqual(["/v1/avatar-content"]);
  });

  it("rejects bytes that do not match the catalog's digest", async () => {
    const tampered = structuredClone(CATALOG);
    const annie = tampered.find(
      (item) => item.source === "included" && item.name === "Annie",
    )!;
    annie.files[0]!.sha256 = "0".repeat(64);
    const { read } = runtime(tampered);
    await expect(read("Annie")).rejects.toThrow();
  });

  it("lists the catalog again after a failed listing", async () => {
    let fail = true;
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/v1/avatar-content") {
        if (fail) return jsonResponse({ detail: "unavailable" }, 503);
        return jsonResponse({ items: CATALOG });
      }
      return new Response("bytes of Annie.vrm");
    }) as typeof fetch;
    const read = createIncludedAvatarFiles(
      createClient({ baseUrl: ORIGIN, fetch: fetcher }),
      { fetcher, apiBaseUrl: ORIGIN },
    );
    await expect(read("Annie")).rejects.toBeDefined();
    fail = false;
    expect(new TextDecoder().decode(await read("Annie"))).toBe(
      "bytes of Annie.vrm",
    );
  });
});
