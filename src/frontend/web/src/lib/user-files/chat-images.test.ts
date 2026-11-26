import { describe, expect, it } from "vitest";

import type { PyUserFileResponse } from "@/lib/content/catalogTypes";
import {
  attachedChatImages,
  attachedImageCount,
  chatImageRefusal,
  isUserImageFile,
  MAX_CHAT_IMAGES_PER_MESSAGE,
  modelAcceptsImages,
  pastedImageFiles,
  sentChatImages,
} from "@/lib/user-files/chat-images";
import {
  isUserImageFileName,
  MAX_USER_IMAGE_UPLOAD_SIZE_BYTES,
  USER_FILE_UPLOAD_ACCEPT,
  USER_FILE_UPLOAD_RESTRICTIONS,
} from "@/lib/user-files/uploads";

function libraryFile(fileId: string, kind?: "image"): PyUserFileResponse {
  return {
    file_id: fileId,
    original_filename: kind ? `${fileId}.png` : `${fileId}.pdf`,
    normalized_extension: kind ? ".png" : ".pdf",
    status: "ready",
    declared_size_bytes: 100,
    metadata: kind ? { kind } : {},
  };
}

function clipboard(text: string, files: File[]) {
  return {
    files: files as unknown as FileList,
    getData: (type: string) => (type === "text/plain" ? text : ""),
  };
}

const accepting = { imagesAttached: 0, imagesAccepted: true };

describe("chat images in the composer", () => {
  it("recognises the image formats the server accepts by extension", () => {
    for (const name of ["a.png", "b.JPG", "c.jpeg", "d.webp", "e.gif"]) {
      expect(isUserImageFileName(name)).toBe(true);
    }
    for (const name of ["notes.txt", "photo.heic", "archive", ""]) {
      expect(isUserImageFileName(name)).toBe(false);
    }
    expect(USER_FILE_UPLOAD_ACCEPT).toContain(".webp");
    expect(USER_FILE_UPLOAD_ACCEPT).not.toContain(".heic");
  });

  it("leaves documents to their own rules", () => {
    expect(
      chatImageRefusal({
        name: "notes.txt",
        size: 10,
        ...accepting,
        imagesAccepted: false,
      }),
    ).toBeNull();
  });

  it("accepts an image within the limits for a model that sees images", () => {
    expect(
      chatImageRefusal({ name: "cat.png", size: 1024, ...accepting }),
    ).toBeNull();
  });

  it("names HEIC and HEIF as formats it cannot read", () => {
    expect(
      chatImageRefusal({ name: "IMG_1.HEIC", size: 10, ...accepting }),
    ).toBe("unsupported_format");
    expect(
      chatImageRefusal({ name: "IMG_2.heif", size: 10, ...accepting }),
    ).toBe("unsupported_format");
  });

  it("refuses an image for a model without image input", () => {
    expect(
      chatImageRefusal({
        name: "cat.png",
        size: 10,
        imagesAttached: 0,
        imagesAccepted: false,
      }),
    ).toBe("model_unsupported");
  });

  it("refuses an image over the upload limit", () => {
    expect(
      chatImageRefusal({
        name: "big.jpg",
        size: MAX_USER_IMAGE_UPLOAD_SIZE_BYTES + 1,
        ...accepting,
      }),
    ).toBe("too_large");
  });

  it("refuses a fifth image for one message", () => {
    expect(
      chatImageRefusal({
        name: "fifth.png",
        size: 10,
        imagesAttached: MAX_CHAT_IMAGES_PER_MESSAGE,
        imagesAccepted: true,
      }),
    ).toBe("too_many");
  });

  it("reads a stored file's kind and a model's image input", () => {
    expect(isUserImageFile({ metadata: { kind: "image" } })).toBe(true);
    expect(isUserImageFile({ metadata: {} })).toBe(false);
    expect(modelAcceptsImages({ accepts: ["text", "image"] })).toBe(true);
    expect(modelAcceptsImages({ accepts: ["text"] })).toBe(false);
    // A model the catalog has not loaded yet: the server decides.
    expect(modelAcceptsImages(undefined)).toBe(true);
  });

  it("lets Uppy's type rule list only the formats it uploads", () => {
    // The composer refuses HEIC by name before this rule runs.
    expect(USER_FILE_UPLOAD_RESTRICTIONS.allowedFileTypes).toContain(".gif");
    expect(USER_FILE_UPLOAD_RESTRICTIONS.allowedFileTypes).not.toContain(
      ".heic",
    );
  });

  it("counts tray images and Library images toward one message", () => {
    expect(
      attachedImageCount(
        [{ name: "a.png" }, { name: "notes.txt" }, { name: "b.JPG" }],
        [libraryFile("pick", "image"), libraryFile("report")],
      ),
    ).toBe(3);
  });

  it("takes only the sent images out of the composer", () => {
    const sent = sentChatImages({
      trayFiles: [
        { id: "uppy-image", name: "a.png", meta: { file_id: "image-1" } },
        { id: "uppy-doc", name: "notes.txt", meta: { file_id: "doc-1" } },
        { id: "uppy-later", name: "b.png", meta: { file_id: "image-2" } },
        { id: "uppy-uploading", name: "c.png" },
      ],
      existingFiles: [
        libraryFile("pick", "image"),
        libraryFile("report"),
        libraryFile("unsent-pick", "image"),
      ],
      sentFileIds: ["image-1", "doc-1", "pick", "report"],
    });

    expect(sent).toEqual({
      trayFileIds: ["uppy-image"],
      existingFileIds: ["pick"],
    });
  });

  it("attaches pasted images but pastes text that comes with a picture", () => {
    const image = new File(["png"], "image.png", { type: "image/png" });
    const text = new File(["text"], "notes.txt", { type: "text/plain" });

    expect(pastedImageFiles(clipboard("", [image, text]))).toEqual([image]);
    expect(pastedImageFiles(clipboard("Q3 total\t42", [image]))).toEqual([]);
    expect(pastedImageFiles(clipboard("", []))).toEqual([]);
  });

  it("describes the images a turn sent, from their rows or their tray uploads", () => {
    const row = {
      ...libraryFile("pick", "image"),
      metadata: { kind: "image", image: { width: 400, height: 300 } },
    };
    expect(
      attachedChatImages(["doc-1", "upload-1", "pick", "unknown"], {
        trayFiles: [
          { id: "uppy-1", name: "photo.jpg", meta: { file_id: "upload-1" } },
          { id: "uppy-2", name: "notes.txt", meta: { file_id: "doc-1" } },
        ],
        rows: [row, libraryFile("doc-1")],
      }),
    ).toEqual([
      { fileId: "upload-1", name: "photo.jpg" },
      { fileId: "pick", name: "pick.png", width: 400, height: 300 },
    ]);
  });
});
