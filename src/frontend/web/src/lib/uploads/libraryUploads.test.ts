import { getI18n } from "react-i18next";
import { afterEach, describe, expect, it } from "vitest";

import type { PyUserFileResponse } from "@/lib/content/catalogTypes";
import {
  canProcessLibraryUpload,
  filterLibraryUploads,
  hasActiveLibraryUpload,
  libraryUploadRefetchInterval,
  libraryUploadViewState,
  presentLibraryUpload,
} from "@/lib/uploads/libraryUploads";

function upload(
  overrides: Partial<PyUserFileResponse> = {},
): PyUserFileResponse {
  return {
    file_id: "file-1",
    original_filename: "Project Notes.md",
    normalized_extension: ".md",
    status: "ready",
    declared_content_type: "text/markdown",
    declared_size_bytes: 1536,
    chunk_count: 4,
    created_at: "2026-07-18T12:00:00Z",
    ...overrides,
  };
}

describe("Library Chat Uploads", () => {
  it("projects native file facts and active job status", () => {
    const row = presentLibraryUpload(
      upload({
        status: "processing",
        stored_size_bytes: 2048,
        latest_processing_job: {
          attempts: 1,
          job_id: "job-1",
          max_attempts: 3,
          status: "running",
        },
      }),
    );

    expect(row).toMatchObject({
      key: "upload:file-1",
      name: "Project Notes.md",
      extension: "MD",
      sizeBytes: 2048,
      createdAt: "2026-07-18T12:00:00Z",
      contentType: "text/markdown",
      chunkCount: 4,
      statusLabel: "Processing",
      statusTone: "active",
      active: true,
    });
  });

  it("shows a ready image with its thumbnail and a plain ready status", () => {
    const image = presentLibraryUpload(
      upload({
        file_id: "image-1",
        original_filename: "cat.png",
        normalized_extension: ".png",
        chunk_count: 0,
        metadata: { kind: "image", image: { width: 40, height: 20 } },
      }),
    );
    expect(image).toMatchObject({
      imageFileId: "image-1",
      statusLabel: "Ready",
      statusTone: "success",
      active: false,
    });

    expect(
      presentLibraryUpload(
        upload({
          status: "failed",
          normalized_extension: ".png",
          metadata: { kind: "image" },
        }),
      ).imageFileId,
    ).toBeNull();
    expect(presentLibraryUpload(upload()).imageFileId).toBeNull();
  });

  it("offers processing for documents, and for an image only to finish its upload", () => {
    const image = (status: string) =>
      upload({
        status,
        normalized_extension: ".png",
        metadata: { kind: "image" },
      });
    const enabled = { processingEnabled: true };

    expect(canProcessLibraryUpload(upload({ status: "ready" }), enabled)).toBe(
      true,
    );
    expect(
      canProcessLibraryUpload(upload({ status: "uploaded" }), {
        processingEnabled: false,
      }),
    ).toBe(false);
    expect(
      canProcessLibraryUpload(
        upload({
          status: "processing",
          latest_processing_job: {
            attempts: 1,
            job_id: "job-1",
            max_attempts: 3,
            status: "running",
          },
        }),
        enabled,
      ),
    ).toBe(false);
    // An interrupted image is completed by :process whatever the processing switch says.
    expect(
      canProcessLibraryUpload(image("uploaded"), { processingEnabled: false }),
    ).toBe(true);
    expect(canProcessLibraryUpload(image("ready"), enabled)).toBe(false);
    expect(canProcessLibraryUpload(image("failed"), enabled)).toBe(false);
  });

  it("filters the complete list by filename, extension, type, and status", () => {
    const files = [
      upload(),
      upload({
        file_id: "file-2",
        original_filename: "Budget.csv",
        normalized_extension: ".csv",
        declared_content_type: "text/csv",
        status: "failed",
      }),
    ];

    expect(
      filterLibraryUploads(files, { query: "notes", status: "all" }),
    ).toHaveLength(1);
    expect(
      filterLibraryUploads(files, { query: "CSV", status: "failed" }),
    ).toMatchObject([{ file_id: "file-2" }]);
    expect(
      filterLibraryUploads(files, { query: "markdown", status: "failed" }),
    ).toEqual([]);
  });

  it("polls only while a file or processing job is active", () => {
    const ready = [upload()];
    const uploadedWithQueuedJob = [
      upload({
        status: "uploaded",
        latest_processing_job: {
          attempts: 0,
          job_id: "job-1",
          max_attempts: 3,
          status: "queued",
        },
      }),
    ];

    expect(hasActiveLibraryUpload(ready)).toBe(false);
    expect(hasActiveLibraryUpload([upload({ status: "uploaded" })])).toBe(
      false,
    );
    expect(libraryUploadRefetchInterval(ready, true)).toBe(false);
    expect(hasActiveLibraryUpload([upload({ status: "processing" })])).toBe(
      true,
    );
    expect(libraryUploadRefetchInterval(uploadedWithQueuedJob, true)).toBe(
      3000,
    );
    expect(libraryUploadRefetchInterval(uploadedWithQueuedJob, false)).toBe(
      false,
    );
  });

  it.each([
    [
      { isPending: true, isError: false, totalCount: 0, filteredCount: 0 },
      "loading",
    ],
    [
      { isPending: false, isError: true, totalCount: 0, filteredCount: 0 },
      "error",
    ],
    [
      { isPending: false, isError: false, totalCount: 0, filteredCount: 0 },
      "empty",
    ],
    [
      { isPending: false, isError: false, totalCount: 2, filteredCount: 0 },
      "no_results",
    ],
    [
      { isPending: false, isError: false, totalCount: 2, filteredCount: 1 },
      "ready",
    ],
  ] as const)("resolves list state %#", (options, expected) => {
    expect(libraryUploadViewState(options)).toBe(expected);
  });

  it("preserves native failure details for the manager handoff", () => {
    expect(
      presentLibraryUpload(
        upload({ status: "failed", last_error: "Could not parse document." }),
      ),
    ).toMatchObject({
      statusLabel: "Failed",
      statusTone: "destructive",
      error: "Could not parse document.",
    });
  });

  describe("outside English", () => {
    afterEach(async () => {
      await getI18n().changeLanguage("en");
    });

    it("words a stored error by status, keeping the English as detail", async () => {
      await getI18n().changeLanguage("ja");
      const t = getI18n().getFixedT(null, "library");
      const detail = (message: string) =>
        getI18n().t("errors:generic.withDetail", {
          message,
          detail: "Embeddings unavailable.",
        });
      expect(
        presentLibraryUpload(
          upload({
            status: "ready_keyword_only",
            last_error: "Embeddings unavailable.",
          }),
        ).error,
      ).toBe(detail(t("uploads.keywordOnly")));
      expect(
        presentLibraryUpload(
          upload({ status: "failed", last_error: "Embeddings unavailable." }),
        ).error,
      ).toBe(detail(t("uploads.processingFailed")));
    });

    it("words a refused image as refused, not as failed processing", async () => {
      await getI18n().changeLanguage("ja");
      const t = getI18n().getFixedT(null, "library");
      expect(
        presentLibraryUpload(
          upload({
            status: "failed",
            last_error: "This image has too many pixels.",
            metadata: { kind: "image" },
          }),
        ).error,
      ).toBe(
        getI18n().t("errors:generic.withDetail", {
          message: t("uploads.imageRefused"),
          detail: "This image has too many pixels.",
        }),
      );
    });
  });
});
