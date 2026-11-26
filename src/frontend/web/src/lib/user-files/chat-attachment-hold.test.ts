import { describe, expect, it } from "vitest";

import type { PyUserFileResponse } from "@/lib/content/catalogTypes";
import { resolveChatAttachmentHold } from "@/lib/user-files/chat-attachment-hold";
import type {
  UserFileUploadStage,
  UserFileUploadStatusFile,
} from "@/lib/user-files/upload-card-status";

function trayFile(
  stage: UserFileUploadStage,
  overrides: Partial<NonNullable<UserFileUploadStatusFile["meta"]>> = {},
): UserFileUploadStatusFile {
  return {
    meta: { file_id: "file-1", anima_stage: stage, ...overrides },
    progress: { uploadStarted: null, bytesUploaded: false },
  };
}

function row(
  status: string,
  overrides: Partial<PyUserFileResponse> = {},
): PyUserFileResponse {
  return {
    file_id: "file-1",
    original_filename: "report.pdf",
    normalized_extension: ".pdf",
    status,
    declared_size_bytes: 100,
    ...overrides,
  };
}

describe("resolveChatAttachmentHold", () => {
  it("never holds an empty tray", () => {
    expect(
      resolveChatAttachmentHold({ files: [], processingEnabled: true }),
    ).toBe("none");
  });

  it.each<UserFileUploadStage>([
    "preparing",
    "initializing",
    "uploading",
    "finalizing",
    "queued",
    "processing",
  ])("waits while an attachment is %s", (stage) => {
    expect(
      resolveChatAttachmentHold({
        files: [trayFile(stage)],
        processingEnabled: true,
      }),
    ).toBe("waiting");
  });

  it("waits for a saved original while processing is on, and blocks it while processing is off", () => {
    for (const files of [
      [trayFile("uploaded")],
      [trayFile("processing")],
    ] as const) {
      expect(
        resolveChatAttachmentHold({
          files,
          backendFiles: [row("uploaded")],
          processingEnabled: true,
        }),
      ).toBe("waiting");
    }
    expect(
      resolveChatAttachmentHold({
        files: [trayFile("uploaded")],
        processingEnabled: false,
      }),
    ).toBe("blocked");
    expect(
      resolveChatAttachmentHold({
        files: [trayFile("uploaded")],
        backendFiles: [row("uploaded")],
        processingEnabled: false,
      }),
    ).toBe("blocked");
  });

  it("waits for a saved image's ready row even while processing is off", () => {
    const image = { ...trayFile("uploaded"), name: "cat.png" };
    expect(
      resolveChatAttachmentHold({ files: [image], processingEnabled: false }),
    ).toBe("waiting");
    expect(
      resolveChatAttachmentHold({
        files: [image],
        backendFiles: [
          row("ready", {
            original_filename: "cat.png",
            normalized_extension: ".png",
          }),
        ],
        processingEnabled: false,
      }),
    ).toBe("none");
  });

  it("waits while the backend row is still processing", () => {
    expect(
      resolveChatAttachmentHold({
        files: [trayFile("queued")],
        backendFiles: [
          row("processing", {
            latest_processing_job: {
              attempts: 1,
              job_id: "job-1",
              max_attempts: 3,
              status: "running",
            },
          }),
        ],
        processingEnabled: true,
      }),
    ).toBe("waiting");
  });

  it("releases the hold once every attachment is ready or keyword-only", () => {
    expect(
      resolveChatAttachmentHold({
        files: [
          trayFile("processing"),
          trayFile("queued", { file_id: "file-2" }),
        ],
        backendFiles: [
          row("ready"),
          row("ready_keyword_only", {
            file_id: "file-2",
            last_error: "Embeddings unavailable.",
          }),
        ],
        processingEnabled: true,
      }),
    ).toBe("none");
  });

  it("blocks a failed upload or a failed processing job until it is removed", () => {
    expect(
      resolveChatAttachmentHold({
        files: [trayFile("failed", { anima_error: "Upload failed." })],
        processingEnabled: true,
      }),
    ).toBe("blocked");
    expect(
      resolveChatAttachmentHold({
        files: [trayFile("processing")],
        backendFiles: [
          row("failed", { last_error: "The PDF has no selectable text." }),
        ],
        processingEnabled: true,
      }),
    ).toBe("blocked");
  });

  it("blocks a saved original whose processing could not be queued", () => {
    // The backend row stays `uploaded`; the browser's failure is newer.
    expect(
      resolveChatAttachmentHold({
        files: [
          trayFile("failed", {
            anima_error:
              "Upload completed, but processing could not be queued.",
          }),
        ],
        backendFiles: [row("uploaded")],
        processingEnabled: true,
      }),
    ).toBe("blocked");
  });

  it("releases the hold once the failed file is removed", () => {
    const failed = trayFile("failed", { anima_error: "Upload failed." });
    const ready = trayFile("processing", { file_id: "file-2" });
    const backendFiles = [row("ready", { file_id: "file-2" })];
    expect(
      resolveChatAttachmentHold({
        files: [failed, ready],
        backendFiles,
        processingEnabled: true,
      }),
    ).toBe("blocked");
    expect(
      resolveChatAttachmentHold({
        files: [ready],
        backendFiles,
        processingEnabled: true,
      }),
    ).toBe("none");
  });

  it("asks for removal before waiting when one attachment failed and another is pending", () => {
    expect(
      resolveChatAttachmentHold({
        files: [
          trayFile("uploading", { file_id: "file-2" }),
          trayFile("failed", { anima_error: "Upload failed." }),
        ],
        processingEnabled: true,
      }),
    ).toBe("blocked");
  });

  it("ignores backend rows for files that are not in the tray", () => {
    // Library selections and other uploads never hold a send.
    expect(
      resolveChatAttachmentHold({
        files: [trayFile("processing")],
        backendFiles: [row("ready"), row("failed", { file_id: "file-9" })],
        processingEnabled: true,
      }),
    ).toBe("none");
  });
});
