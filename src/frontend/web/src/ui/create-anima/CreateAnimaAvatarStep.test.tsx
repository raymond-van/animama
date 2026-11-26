import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PyAvatarContent } from "@animama/runtime-contracts/sdk";
import type {
  AnimaCreationOperations,
  AnimaCreationSources,
} from "@/query/hooks/useAnimaCreation";
import {
  avatarCollisionTarget,
  CreateAnimaAvatarStep,
} from "./CreateAnimaAvatarStep";
import { newCreateAnimaDraft } from "./createAnimaDraft";
import { checkCreationVrm } from "./createAnimaFiles";
import { parseCreateAnimaSearch } from "./createAnimaSearch";
import { ref } from "./createAnimaTestFixtures";

vi.mock("./CreateAnimaUploadDiagnostics", () => ({
  CreateAnimaUploadDiagnostics: ({
    file,
    stage,
  }: {
    file: File;
    stage: { status: string };
  }) => <p data-upload-diagnostics={stage.status}>{file.name}</p>,
}));

function avatar(
  item_id: string,
  source: "included" | "local",
  filename: string,
) {
  return {
    ...ref(item_id),
    source,
    editable: source === "local",
    files: [{ filename, role: "model" }],
  } as PyAvatarContent;
}

function binaryVrm(document: string) {
  const bytes = new TextEncoder().encode(
    document.padEnd(Math.ceil(document.length / 4) * 4, " "),
  );
  const result = new Uint8Array(20 + bytes.length);
  const header = new DataView(result.buffer);
  [0x46546c67, 2, result.length, bytes.length, 0x4e4f534a].forEach(
    (value, index) => header.setUint32(index * 4, value, true),
  );
  result.set(bytes, 20);
  return new File([result], "test.vrm");
}

function vrm(version: string, uri?: string) {
  return binaryVrm(
    JSON.stringify({
      extensions: {
        [version === "0.0" ? "VRM" : "VRMC_vrm"]: { specVersion: version },
      },
      buffers: [{ ...(uri ? { uri } : {}) }],
    }),
  );
}

describe("Avatar handoff and admission", () => {
  it("accepts only a normalized optional logical Avatar ID", () => {
    expect(
      parseCreateAnimaSearch({ avatar: "  content-a  ", owner: "ignored" }),
    ).toEqual({ avatar: "content-a" });
    for (const avatar of [
      null,
      {},
      "",
      "../model.vrm",
      "file:///model.vrm",
      "https://example.test/model",
      "blob:test",
    ])
      expect(parseCreateAnimaSearch({ avatar }).avatar).toBeUndefined();
  });

  it.each(["0.0", "1.0"])(
    "permits a self-contained VRM %s provisional preview",
    async (version) => {
      await expect(checkCreationVrm(vrm(version))).resolves.toBeUndefined();
    },
  );

  it("rejects wrong containers, unsupported versions, oversized and external-resource VRMs", async () => {
    await expect(
      checkCreationVrm(new File(["not a VRM"], "test.vrm")),
    ).rejects.toThrow();
    await expect(checkCreationVrm(binaryVrm("{invalid"))).rejects.toThrow(
      "valid VRM document",
    );
    await expect(checkCreationVrm(vrm("2.0"))).rejects.toThrow("VRM 0.x");
    await expect(
      checkCreationVrm(vrm("1.0", "https://example.test/texture")),
    ).rejects.toThrow("External");
    await expect(checkCreationVrm(vrm("1.0"), 32)).rejects.toThrow(
      "self-contained",
    );
  });

  it("offers Replace only for one caller-editable matching entry", () => {
    const mine = avatar("mine", "local", "my-avatar.vrm");
    expect(avatarCollisionTarget("My Avatar", [mine])).toBe(mine);
    expect(
      avatarCollisionTarget("My Avatar", [
        avatar("included", "included", "my-avatar.vrm"),
      ]),
    ).toBeUndefined();
    expect(
      avatarCollisionTarget("My Avatar", [mine, { ...mine, item_id: "other" }]),
    ).toBeUndefined();
  });

  it("opens VRM selection directly without a nested upload section", () => {
    const html = renderToStaticMarkup(
      <CreateAnimaAvatarStep
        draft={{ ...newCreateAnimaDraft(), avatar: ref("selected-avatar") }}
        sources={
          {
            avatars: {
              data: [],
              isLoading: false,
              isError: false,
              refetch: vi.fn(),
            },
          } as unknown as AnimaCreationSources
        }
        operations={
          {
            saveAvatar: { mutateAsync: vi.fn() },
          } as unknown as AnimaCreationOperations
        }
        file={null}
        fileInputRef={createRef<HTMLInputElement>()}
        onFile={vi.fn()}
        onSelect={vi.fn(async () => undefined)}
        onWorking={vi.fn()}
      />,
    );
    // One list for every source: search and Upload share a row, no tabs.
    expect(html).not.toContain('role="tab"');
    expect(html).toMatch(
      /aria-label="Search Avatars"[^>]*>\s*<button[^>]*aria-label="Upload VRM"/u,
    );
    expect(html).toContain("No Avatars are available yet.");
    expect(html).toContain('aria-label="Choose a VRM file"');
    expect(html).toMatch(/class="[^"]*\bhidden\b/);
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain("Choose a VRM file</button>");
    expect(html).not.toContain("VRM 0.0 or 1.0");
    expect(html).not.toContain("Selected: selected-avatar");
    // MMD models upload only as VRM: the step points to the converter, and the picker stays VRM-only.
    expect(html).toContain("Have a MikuMikuDance (.pmx) model?");
    expect(html).toContain(
      'href="https://github.com/raymond-van/animama-avatar-converter#mmd-models"',
    );
    expect(html).toContain('accept=".vrm"');
  });

  it("lists every source together, with portraits where available", () => {
    const included = {
      ...avatar("included-avatar", "included", "Annie.vrm"),
      name: "Annie",
      portrait: { url: "/portraits/annie.webp" },
    } as PyAvatarContent;
    const local = {
      ...avatar("local-avatar", "local", "Mine.vrm"),
      name: "Mine",
    } as PyAvatarContent;
    const html = renderToStaticMarkup(
      <CreateAnimaAvatarStep
        draft={newCreateAnimaDraft()}
        sources={
          {
            avatars: {
              data: [included, local],
              isLoading: false,
              isError: false,
              refetch: vi.fn(),
            },
          } as unknown as AnimaCreationSources
        }
        operations={
          {
            saveAvatar: { mutateAsync: vi.fn() },
          } as unknown as AnimaCreationOperations
        }
        file={null}
        fileInputRef={createRef<HTMLInputElement>()}
        onFile={vi.fn()}
        onSelect={vi.fn(async () => undefined)}
        onWorking={vi.fn()}
      />,
    );
    expect(html.match(/type="radio"/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Annie Included"');
    expect(html).toContain('aria-label="Mine My Content"');
    // Only the Avatar with a portrait shows an image; the other a placeholder.
    expect(html.match(/<img /g)).toHaveLength(1);
    expect(html).toContain('src="/portraits/annie.webp"');
  });

  it("shows the chosen file's Diagnostics status under its preview", () => {
    const props = {
      draft: newCreateAnimaDraft(),
      sources: {
        avatars: {
          data: [],
          isLoading: false,
          isError: false,
          refetch: vi.fn(),
        },
      } as unknown as AnimaCreationSources,
      operations: {
        saveAvatar: { mutateAsync: vi.fn() },
      } as unknown as AnimaCreationOperations,
      fileInputRef: createRef<HTMLInputElement>(),
      onFile: vi.fn(),
      onSelect: vi.fn(async () => undefined),
      onWorking: vi.fn(),
    };
    const chosen = renderToStaticMarkup(
      <CreateAnimaAvatarStep
        {...props}
        file={new File([new Uint8Array(8)], "upload.vrm")}
        stageAvatar={{ avatar: null, status: "failed" }}
      />,
    );
    expect(chosen).toContain('data-upload-diagnostics="failed"');
    expect(chosen.indexOf("Previewing")).toBeLessThan(
      chosen.indexOf("data-upload-diagnostics"),
    );
    // No file, no status: a saved Avatar's settings and Diagnostics live elsewhere.
    expect(
      renderToStaticMarkup(<CreateAnimaAvatarStep {...props} file={null} />),
    ).not.toContain("data-upload-diagnostics");
  });
});
