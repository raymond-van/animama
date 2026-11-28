import type { ChatAttachmentHold } from "@animama/product-ui/chat";
import { useFormatters } from "@animama/product-ui/i18n";
import { useUppyState } from "@uppy/react";
import type { TFunction } from "i18next";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import {
  useUserFileUpload,
  type UserFileUploadUppy,
} from "@/hooks/useUserFileUpload";
import type { PyGesture, PyUserFileResponse } from "@/lib/content/catalogTypes";
import { createLogger } from "@/lib/logger";
import { resolveChatAttachmentHold } from "@/lib/user-files/chat-attachment-hold";
import {
  MAX_CHAT_IMAGES_PER_MESSAGE,
  attachedChatImages,
  attachedImageCount,
  chatImageRefusal,
  chatImageRefusalMessage,
  isUserImageFile,
  modelAcceptsImages,
  type ChatImageRefusal,
} from "@/lib/user-files/chat-images";
import {
  MAX_USER_IMAGE_UPLOAD_SIZE_BYTES,
  isUserImageFileName,
} from "@/lib/user-files/uploads";
import { useGestures } from "@/query/hooks/useActions";
import { useUserFiles } from "@/query/hooks/useUserFiles";
import { useRuntimeFeatureEnabled } from "@/ui/app/RuntimeFeatureGate";
import {
  MAX_GENERATION_REFERENCE_EXAMPLES,
  hasGenerationReferences,
  referenceGestureChoices,
  type GenerationReferenceGesture,
  type GenerationReferenceImage,
  type GenerationRunReferences,
} from "./generationReferences";
import {
  GENERATE_VIDEO_REFERENCES_ENABLED,
  MAX_VIDEO_REFERENCE_SECONDS,
  VideoReferenceError,
  videoReferenceStrip,
  type VideoReferenceRefusal,
} from "./videoReferences";

const logger = createLogger("GenerateReferences");

/** What the composer took out for a message, and how to put it back. */
export type TakenGenerationReferences = {
  /** What the message carries; `null` when the composer held nothing. */
  references: GenerationRunReferences | null;
  /** Put it back into the composer: the message was not sent after all. */
  restore: () => void;
};

/**
 * The references of the Generate page's composer: what the next message
 * carries besides its words, and the Library Gestures its pickers offer.
 */
export type GenerateReferencesController = {
  /**
   * Whether the next message may start from a Gesture: only one that writes a
   * new Gesture draft may.
   */
  offersStartingPoint: boolean;
  startingPoint: GenerationReferenceGesture | null;
  /** Choose the Gesture a new draft starts as, or `null` for none. */
  chooseStartingPoint: (gesture: GenerationReferenceGesture | null) => void;
  /** The examples of the feel, in the order chosen; at most three. */
  examples: readonly GenerationReferenceGesture[];
  addExample: (gesture: GenerationReferenceGesture) => void;
  removeExample: (itemId: string) => void;
  /** The Library Gestures a request may name. */
  gestures: {
    local: PyGesture[];
    included: PyGesture[];
    loading: boolean;
    error: boolean;
    retry: () => void;
    /**
     * Whether a chosen Gesture is still in the Library; `true` until the
     * Library has been read.
     */
    has: (itemId: string) => boolean;
  };
  /**
   * The person's own images given with the next message, uploaded as chat's
   * images are; `null` where the runtime offers no uploads.
   */
  images: {
    /** The uploader whose tray shows the images attached. */
    uppy: UserFileUploadUppy;
    /**
     * Attach images the person chose or pasted. One the composer refuses is
     * explained by a notice, as in chat.
     */
    add: (
      files: readonly File[],
      kind?: GenerationReferenceImage["kind"],
    ) => void;
    /**
     * The person's stored images attached by their file id, in the order
     * chosen: nothing is uploaded for them. They count with the uploads
     * against the four images a request carries.
     */
    existing: readonly PyUserFileResponse[];
    /**
     * Attach one of the person's stored images, or take it off again. One
     * beyond the limit is refused with a notice, as in chat.
     */
    toggleExisting: (file: PyUserFileResponse) => void;
    removeExisting: (fileId: string) => void;
    /**
     * `false` when the assistant's model cannot look at images. No image
     * can then be attached; ones attached before the model was chosen stay,
     * kept with the conversation and sent to no model.
     */
    modelSeesImages: boolean;
    /**
     * Why no image can be attached now, in chat's own words: the model
     * cannot look at images. `null` while images can be attached.
     */
    unavailable: string | null;
  } | null;
  /**
   * A short video as a reference, behind its switch
   * (`GENERATE_VIDEO_REFERENCES_ENABLED`): `null` while that is off, or
   * where the runtime offers no uploads.
   */
  video: {
    /**
     * Sample a local video's frames into one strip image and attach that
     * as a reference image. The video itself is never uploaded. One that is
     * too long or cannot be read is explained by a notice.
     */
    add: (video: File) => Promise<void>;
    /** A video is being read. */
    sampling: boolean;
  } | null;
  /**
   * Whether the attached images let a message be sent, as chat's composer
   * holds one: `waiting` while an image uploads, `blocked` while one failed.
   */
  hold: ChatAttachmentHold;
  /** The hold as it stands now, read when a message is sent. */
  getHold: () => ChatAttachmentHold;
  /**
   * Take what the next message carries out of the composer, as chat takes a
   * message's images: the composer then starts the following message empty.
   */
  take: () => TakenGenerationReferences;
};

type TrayFile = ReturnType<UserFileUploadUppy["getFile"]>;

/** The file meta key that marks an upload as a strip of video frames. */
const REFERENCE_KIND_META = "generate_reference_kind";

function trayFileKind(file: TrayFile): GenerationReferenceImage["kind"] {
  return file.meta[REFERENCE_KIND_META] === "video_frames"
    ? "video_frames"
    : "image";
}

/**
 * Why the composer refuses a file before uploading it: chat's rules for an
 * image (a model that takes none, format, size, four to a message), and
 * anything that is no image.
 */
function referenceImageRefusal(file: {
  name: string | null | undefined;
  size: number | null | undefined;
  imagesAttached: number;
  /** False when the assistant's model is known not to take image input. */
  imagesAccepted: boolean;
}): ChatImageRefusal | null {
  return (
    chatImageRefusal(file) ??
    (isUserImageFileName(file.name) ? null : "unsupported_format")
  );
}

/** Why a video was not added, in words. */
function videoRefusalText(
  t: TFunction<"generate">,
  reason: VideoReferenceRefusal,
): string {
  switch (reason) {
    case "too_long":
      return t("references.video.tooLong", {
        seconds: MAX_VIDEO_REFERENCE_SECONDS,
      });
    case "unreadable":
      return t("references.video.unreadable");
  }
}

/** The title of the notice for a video that was not added. */
function videoRefusalTitle(t: TFunction<"generate">): string {
  return t("references.video.rejected");
}

/**
 * The state behind the references row of the Generate page's composer
 * (`GenerateReferencesRow`). Mount it once per conversation: another
 * conversation starts with no references, and with its own uploader.
 */
export function useGenerateReferences(input: {
  conversationId: string | null;
  /** The next message writes a new Gesture draft, so it may start from a Gesture. */
  offersStartingPoint: boolean;
  /** The assistant's chosen model row; one not read yet counts as taking images. */
  model: { accepts?: readonly string[] | null } | null;
}): GenerateReferencesController {
  const { offersStartingPoint } = input;
  const { t } = useTranslation("chat");
  const generate = useTranslation("generate");
  const formatters = useFormatters();
  const [startingPoint, setStartingPoint] =
    useState<GenerationReferenceGesture | null>(null);
  const [examples, setExamples] = useState<
    readonly GenerationReferenceGesture[]
  >([]);
  // A starting point goes with a new Gesture draft only: choosing a draft to
  // revise, or a Reaction, drops it for good rather than hiding it.
  if (!offersStartingPoint && startingPoint) setStartingPoint(null);

  const library = useGestures({
    origin: "all",
    sort: "name",
    implementationKind: "anima_clip",
  });
  const choices = useMemo(
    () =>
      referenceGestureChoices(
        library.data?.pages.flatMap((page) => page.items) ?? [],
      ),
    [library.data],
  );
  const offeredIds = useMemo(
    () =>
      library.data
        ? new Set(
            [...choices.local, ...choices.included].map(
              (gesture) => gesture.item_id,
            ),
          )
        : null,
    [choices, library.data],
  );
  const { refetch } = library;
  const gestures = useMemo(
    () => ({
      ...choices,
      loading: library.isPending,
      error: library.isError,
      retry: () => void refetch(),
      has: (itemId: string) => offeredIds?.has(itemId) ?? true,
    }),
    [choices, library.isError, library.isPending, offeredIds, refetch],
  );

  const addExample = useCallback(
    (gesture: GenerationReferenceGesture) =>
      setExamples((current) =>
        current.length >= MAX_GENERATION_REFERENCE_EXAMPLES ||
        current.some(({ itemId }) => itemId === gesture.itemId)
          ? current
          : [...current, gesture],
      ),
    [],
  );
  const removeExample = useCallback(
    (itemId: string) =>
      setExamples((current) =>
        current.filter((example) => example.itemId !== itemId),
      ),
    [],
  );

  // Reference images reuse chat's image uploads: the same routes, limits and
  // refusals. Only images are admitted, and an image is never processed.
  const uploadsOffered = useRuntimeFeatureEnabled("chat_file_uploads");
  const uppy = useUserFileUpload({
    id: `generate-references-${input.conversationId ?? "none"}`,
    autoProcess: false,
  });
  // The stored images attached by id, as chat attaches a Library file.
  const [existing, setExisting] = useState<readonly PyUserFileResponse[]>([]);
  // Read by Uppy's onBeforeFileAdded, which outlives each render.
  const existingRef = useRef(existing);
  existingRef.current = existing;
  // With a model that cannot look at images none is attached, as in chat
  // (spec R2.3). Read where an image is added, which outlives each render.
  const imagesAccepted = modelAcceptsImages(input.model);
  const imagesAcceptedRef = useRef(imagesAccepted);
  imagesAcceptedRef.current = imagesAccepted;
  // What a stored image attached by id is, where it is not a plain image: a
  // strip of video frames put back after a request that was not sent.
  const [existingKinds, setExistingKinds] = useState<
    Readonly<Record<string, GenerationReferenceImage["kind"]>>
  >({});
  const refuseImage = useCallback(
    (refusal: ChatImageRefusal, name: string) => {
      toast.error(t("composer.images.rejected"), {
        description: chatImageRefusalMessage(
          t,
          refusal,
          name,
          formatters.fileSize(MAX_USER_IMAGE_UPLOAD_SIZE_BYTES),
        ),
      });
    },
    [formatters, t],
  );
  useEffect(() => {
    uppy.setOptions({
      onBeforeFileAdded: (file, files) => {
        // Uppy's own duplicate check, which this option replaces.
        if (Object.hasOwn(files, file.id)) return false;
        const refusal = referenceImageRefusal({
          name: file.name,
          size: file.size,
          imagesAttached: attachedImageCount(
            Object.values(files),
            existingRef.current,
          ),
          imagesAccepted: imagesAcceptedRef.current,
        });
        if (refusal === null) return true;
        refuseImage(refusal, file.name ?? "");
        return false;
      },
    });
  }, [refuseImage, uppy]);
  const toggleExisting = useCallback(
    (file: PyUserFileResponse) => {
      const attached = existingRef.current;
      if (attached.some(({ file_id }) => file_id === file.file_id)) {
        setExisting(attached.filter(({ file_id }) => file_id !== file.file_id));
        return;
      }
      const uploads = Object.values(uppy.getState().files);
      // Only a ready image is a reference, and one uploaded for this
      // message is attached already.
      if (
        !isUserImageFile(file) ||
        file.status !== "ready" ||
        uploads.some(({ meta }) => meta.file_id === file.file_id)
      )
        return;
      if (!imagesAcceptedRef.current) {
        refuseImage("model_unsupported", file.original_filename);
        return;
      }
      // A stored image passed chat's format and size rules when it was
      // uploaded; only the number a request carries is left to check.
      if (
        attachedImageCount(uploads, attached) >= MAX_CHAT_IMAGES_PER_MESSAGE
      ) {
        refuseImage("too_many", file.original_filename);
        return;
      }
      setExisting([...attached, file]);
    },
    [refuseImage, uppy],
  );
  const removeExisting = useCallback(
    (fileId: string) =>
      setExisting((current) =>
        current.filter(({ file_id }) => file_id !== fileId),
      ),
    [],
  );
  const addImages = useCallback(
    (
      files: readonly File[],
      kind: GenerationReferenceImage["kind"] = "image",
    ) => {
      for (const file of files) {
        try {
          uppy.addFile({
            data: file,
            isRemote: false,
            name: file.name,
            source: "generate-references",
            type: file.type || "application/octet-stream",
            meta: kind === "image" ? {} : { [REFERENCE_KIND_META]: kind },
          });
        } catch {
          // The composer explained its refusal, or Uppy reported its own.
        }
      }
    },
    [uppy],
  );
  // An uploaded image waits for its stored row, which says it is ready.
  const attached = useUppyState(
    uppy,
    (state) => Object.keys(state.files).length,
  );
  const rows = useUserFiles({
    enabled: uploadsOffered && attached > 0,
    pollActive: true,
  }).data;
  const holdFor = useCallback(
    (files: Record<string, TrayFile>) =>
      resolveChatAttachmentHold({
        files: Object.values(files),
        backendFiles: rows,
        // Only images are attached here, and an image is never processed.
        processingEnabled: false,
      }),
    [rows],
  );
  const hold = useUppyState(uppy, (state) => holdFor(state.files));
  const getHold = useCallback(
    () => holdFor(uppy.getState().files),
    [holdFor, uppy],
  );
  const images = useMemo(
    () =>
      uploadsOffered
        ? {
            uppy,
            add: addImages,
            existing,
            toggleExisting,
            removeExisting,
            modelSeesImages: imagesAccepted,
            unavailable: imagesAccepted
              ? null
              : t("composer.images.modelUnsupported"),
          }
        : null,
    [
      addImages,
      existing,
      imagesAccepted,
      removeExisting,
      t,
      toggleExisting,
      uploadsOffered,
      uppy,
    ],
  );

  const [sampling, setSampling] = useState(false);
  const wordVideoRefusal = generate.t;
  const addVideo = useCallback(
    async (file: File) => {
      // Its strip would be an image the model cannot look at: the video is
      // not read at all.
      if (!imagesAcceptedRef.current) {
        refuseImage("model_unsupported", file.name);
        return;
      }
      setSampling(true);
      try {
        addImages([await videoReferenceStrip(file)], "video_frames");
      } catch (error) {
        const reason =
          error instanceof VideoReferenceError ? error.reason : "unreadable";
        logger.warn("Video", "Video reference refused", { reason });
        toast.error(videoRefusalTitle(wordVideoRefusal), {
          description: videoRefusalText(wordVideoRefusal, reason),
        });
      } finally {
        setSampling(false);
      }
    },
    [addImages, refuseImage, wordVideoRefusal],
  );
  const video = useMemo(
    () =>
      images && GENERATE_VIDEO_REFERENCES_ENABLED
        ? { add: addVideo, sampling }
        : null,
    [addVideo, images, sampling],
  );

  // Read when a message is sent, which may be before the next render.
  const held = useRef({
    startingPoint,
    examples,
    offersStartingPoint,
    rows,
    existing,
    existingKinds,
  });
  held.current = {
    startingPoint,
    examples,
    offersStartingPoint,
    rows,
    existing,
    existingKinds,
  };
  const take = useCallback((): TakenGenerationReferences => {
    const taken = held.current;
    // The images that finished uploading, in the order attached.
    const sent = Object.values(uppy.getState().files).filter(
      (file) => file.meta.file_id,
    );
    const kinds = new Map(
      sent.map((file) => [file.meta.file_id, trayFileKind(file)]),
    );
    const references: GenerationRunReferences = {
      startingPoint: taken.offersStartingPoint ? taken.startingPoint : null,
      examples: taken.examples,
      // The uploads first, then the stored images chosen, as chat orders them.
      images: attachedChatImages(
        [
          ...sent.flatMap((file) => file.meta.file_id ?? []),
          ...taken.existing.map(({ file_id }) => file_id),
        ],
        { trayFiles: sent, rows: [...(taken.rows ?? []), ...taken.existing] },
      ).map((image) => ({
        ...image,
        kind:
          kinds.get(image.fileId) ??
          taken.existingKinds[image.fileId] ??
          "image",
      })),
    };
    setStartingPoint(null);
    setExamples([]);
    setExisting([]);
    setExistingKinds({});
    for (const file of sent) uppy.removeFile(file.id);
    return {
      references: hasGenerationReferences(references) ? references : null,
      restore: () => {
        setStartingPoint(taken.startingPoint);
        setExamples(taken.examples);
        // An upload taken out is stored already: it comes back as the stored
        // image it now is, attached by its file id, and is not uploaded a
        // second time. Its row is the one that said the upload was ready.
        const stored = sent.flatMap((file) => {
          const row = taken.rows?.find(
            ({ file_id }) => file_id === file.meta.file_id,
          );
          return row ? [{ row, kind: trayFileKind(file) }] : [];
        });
        setExisting([...taken.existing, ...stored.map(({ row }) => row)]);
        setExistingKinds({
          ...taken.existingKinds,
          ...Object.fromEntries(
            stored.map(({ row, kind }) => [row.file_id, kind]),
          ),
        });
      },
    };
  }, [uppy]);

  return {
    offersStartingPoint,
    startingPoint: offersStartingPoint ? startingPoint : null,
    chooseStartingPoint: setStartingPoint,
    examples,
    addExample,
    removeExample,
    gestures,
    images,
    video,
    hold: images ? hold : "none",
    getHold: images ? getHold : () => "none",
    take,
  };
}
