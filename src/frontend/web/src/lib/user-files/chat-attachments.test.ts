import { describe, expect, it } from "vitest";

import type { PyUserFileResponse } from "@/lib/content/catalogTypes";
import {
  mergeChatAttachedFileIds,
  selectableChatUserFiles,
} from "@/lib/user-files/chat-attachments";

function userFile(
  fileId: string,
  status: string,
  chunkCount: number,
): PyUserFileResponse {
  return {
    file_id: fileId,
    original_filename: `${fileId}.txt`,
    normalized_extension: ".txt",
    status,
    declared_size_bytes: 10,
    chunk_count: chunkCount,
    metadata: {},
  };
}

describe("chat user-file attachments", () => {
  it("offers only ready files with persisted chunks", () => {
    const files = [
      userFile("ready", "ready", 2),
      userFile("keyword", "ready_keyword_only", 1),
      userFile("empty", "ready", 0),
      userFile("processing", "processing", 4),
    ];

    expect(selectableChatUserFiles(files).map((file) => file.file_id)).toEqual([
      "ready",
      "keyword",
    ]);
  });

  it("offers ready images, which have no chunks, and nothing else of theirs", () => {
    const image = (fileId: string, status: string): PyUserFileResponse => ({
      ...userFile(fileId, status, 0),
      original_filename: `${fileId}.png`,
      normalized_extension: ".png",
      metadata: { kind: "image" },
    });

    expect(
      selectableChatUserFiles([
        image("ready-image", "ready"),
        image("uploaded-image", "uploaded"),
        image("failed-image", "failed"),
      ]).map((file) => file.file_id),
    ).toEqual(["ready-image"]);
  });

  it("merges uploaded and existing IDs without duplicate or blank values", () => {
    expect(
      mergeChatAttachedFileIds(
        [" file-uploaded ", undefined, "file-shared"],
        ["file-existing", "file-shared", ""],
      ),
    ).toEqual(["file-uploaded", "file-shared", "file-existing"]);
  });
});
