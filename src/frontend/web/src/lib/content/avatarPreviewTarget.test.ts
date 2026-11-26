import type {
  PyAvatarContent,
  PyTypedContentPreview,
} from "@animama/runtime-contracts/api-types";
import { describe, expect, it, vi } from "vitest";

import type { PyContentPreview } from "@/lib/content/catalogTypes";
import { resolveRuntimeAvatarFaceParts } from "@/lib/runtime-content/runtimeAvatarFaceParts";
import {
  avatarPreviewPortraitRetake,
  avatarPreviewTarget,
  readAvatarContent,
} from "./avatarPreviewTarget";
import { typedPreviewTransport } from "./catalogApi";

const sdk = vi.hoisted(() => ({ getAvatarContent: vi.fn() }));
vi.mock("@animama/runtime-contracts/sdk", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAvatarContent: sdk.getAvatarContent,
}));

describe("avatarPreviewTarget", () => {
  it("maps a private Avatar VRM to an authorized model file", () => {
    const preview: PyContentPreview = {
      preview_id: "avatar-private",
      revision: "avatar-revision",
      revision_sha256: "avatar-revision",
      expires_at: "2026-08-13T00:05:00Z",
      files: [
        {
          file_ref: "vrm-ref",
          role: "vrm",
          ordinal: 1,
          filename: "avatar.vrm",
          media_type: "model/gltf-binary",
          size_bytes: 10,
          sha256: "a".repeat(64),
          url: "/v1/content/previews/avatar-private/vrm-ref",
        },
      ],
      metadata: { content_type: "avatar", spec: { presentation: {} } },
    };

    const target = avatarPreviewTarget(preview, "My Avatar");
    expect(target.kind).toBe("avatar_model");
    if (target.sourceType !== "resolved_entry") throw new Error("fixture");
    expect(target.entry.source).toMatchObject({
      type: "authorized_files",
      files: [{ role: "model", url: expect.stringContaining("vrm-ref") }],
    });
  });

  it("maps an Included Avatar to its registered catalog file", () => {
    const preview: PyContentPreview = {
      preview_id: "builtin:avatar:annie:1",
      revision: "builtin-1",
      revision_sha256: "builtin-1",
      expires_at: "2026-08-13T00:05:00Z",
      files: [
        {
          file_ref: "annie-vrm-ref",
          role: "vrm",
          ordinal: 1,
          filename: "annie.vrm",
          media_type: "model/gltf-binary",
          size_bytes: 10,
          sha256: "b".repeat(64),
          url: "/v1/content/previews/builtin-avatar/annie-vrm-ref",
        },
      ],
      metadata: { content_type: "avatar", spec: { presentation: {} } },
    };
    const target = avatarPreviewTarget(preview, "Annie");
    if (target.sourceType !== "resolved_entry") throw new Error("fixture");
    expect(target.entry.source).toMatchObject({
      type: "authorized_files",
      files: [{ role: "model", filename: "annie.vrm" }],
    });
  });

  it("loads the Avatar with its saved face part correction", () => {
    const sha = "c".repeat(64);
    const correction = {
      schema: "animama/avatar-face-parts/1" as const,
      vrm_sha256: sha,
      parts: {
        face_skin: ["3:0:1"],
        eye_left: ["3:0:2"],
        eye_right: ["3:0:2"],
      },
    };
    const typed: PyTypedContentPreview = {
      preview_id: "avatar-corrected",
      revision_sha256: "avatar-revision",
      expires_at: "2026-08-13T00:05:00Z",
      files: [
        {
          file_ref: "vrm-ref",
          role: "vrm",
          ordinal: 1,
          filename: "avatar.vrm",
          logical_path: "avatar.vrm",
          media_type: "model/gltf-binary",
          size_bytes: 10,
          sha256: sha,
          url: "/v1/content/previews/avatar-corrected/vrm-ref",
        },
      ],
      item: {
        kind: "avatar",
        item_id: "avatar-1",
        name: "My Avatar",
        editable: true,
        revision_sha256: "avatar-revision",
        source: "local",
        face_parts: correction,
      },
    };

    const target = avatarPreviewTarget(
      typedPreviewTransport(typed),
      "My Avatar",
    );
    if (target.sourceType !== "resolved_entry") throw new Error("fixture");
    expect(resolveRuntimeAvatarFaceParts(target.entry)).toEqual({
      facePartCorrections: correction,
      vrmSha256: sha,
    });
  });
});

describe("avatarPreviewPortraitRetake", () => {
  const revision = "d".repeat(64);
  const preview: PyContentPreview = {
    preview_id: "avatar-local",
    item_id: "item-7",
    revision,
    revision_sha256: revision,
    expires_at: "2026-08-13T00:05:00Z",
    files: [],
    metadata: { content_type: "avatar" },
  };
  const content = (captured: string | null, source = "local") =>
    ({
      item_id: "item-7",
      revision_sha256: revision,
      source,
      name: "Mika",
      editable: source === "local",
      portrait: { url: "/p.webp", avatar_revision_sha256: captured },
    }) as PyAvatarContent;

  it("retakes a Local portrait captured from another revision", async () => {
    sdk.getAvatarContent.mockResolvedValueOnce({
      data: content("e".repeat(64)),
    });
    const avatar = await readAvatarContent({} as never, "item-7");
    const retake = avatarPreviewPortraitRetake(preview, avatar);
    expect(retake).toEqual({ item_id: "item-7", revision_sha256: revision });

    const target = avatarPreviewTarget(preview, "Mika", retake);
    expect(target.portraitRetake).toEqual(retake);
  });

  it("keeps a current, imported or Included portrait", () => {
    expect(avatarPreviewPortraitRetake(preview, content(revision))).toBeNull();
    // An imported portrait records no capture revision.
    expect(avatarPreviewPortraitRetake(preview, content(null))).toBeNull();
    expect(
      avatarPreviewPortraitRetake(preview, content(null, "included")),
    ).toBeNull();
    expect(avatarPreviewPortraitRetake(preview, null)).toBeNull();
    expect(avatarPreviewTarget(preview, "Mika")).not.toHaveProperty(
      "portraitRetake",
    );
  });
});
