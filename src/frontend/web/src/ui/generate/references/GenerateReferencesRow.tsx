import { useUppyState } from "@uppy/react";
import { Film, ImagePlus } from "lucide-react";
import { useId, useRef } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import type { PyGesture } from "@/lib/content/catalogTypes";
import { USER_IMAGE_EXTENSIONS } from "@/lib/user-files/uploads";
import {
  LoadoutPoolMemberChip,
  LoadoutPoolPicker,
  type LoadoutPoolPickerCopy,
} from "@/ui/animas/LoadoutPool";
import { Button } from "@/ui/components/button";
import { ChatInputFileTray } from "@/ui/components/chat-input-file-tray";
import { GenerateInspirations } from "../inspirations/GenerateInspirations";
import {
  GenerateStyleControl,
  GenerateStyleFailure,
} from "./GenerateStyleControl";
import {
  MAX_GENERATION_REFERENCE_EXAMPLES,
  type GenerationReferenceGesture,
} from "./generationReferences";
import type { GenerateReferencesController } from "./useGenerateReferences";
import type { GenerationStyleChoice } from "./useGenerationStyle";

/** The pickers' wording; `add` is the visible text of a picker's button. */
function pickerCopy(
  t: TFunction<"generate">,
  add: string,
): LoadoutPoolPickerCopy {
  return {
    add,
    search: t("references.picker.search"),
    local: t("references.picker.local"),
    included: t("references.picker.included"),
    loading: t("references.picker.loading"),
    noResults: t("references.picker.noResults"),
    catalogUnavailable: t("references.picker.unavailable"),
    retryCatalog: t("references.picker.retry"),
  };
}

const asReference = (gesture: PyGesture): GenerationReferenceGesture => ({
  itemId: gesture.item_id,
  name: gesture.name,
});

/** The image formats chat accepts, as a file picker filters by them. */
const IMAGE_ACCEPT = USER_IMAGE_EXTENSIONS.join(",");

/**
 * The references row of the Generate page's composer, between the line that
 * says what the next message writes and the request field: a Gesture to
 * start from (for a new Gesture draft) and up to three examples of the feel,
 * each chosen from the Library and shown as a chip with Remove, and the
 * person's own images, attached and shown as chat's composer shows them.
 * Behind its switch, a short video is added as one image of its frames.
 * Inspirations opens a dialog of starters, Included Gestures and the
 * person's stored images to choose from. The conversation's style is chosen
 * here too: it is no reference, and goes with every request until it is
 * changed.
 *
 * The pickers show no Preview: this page holds the app's one preview canvas
 * for its drafts, so the Library's preview dock cannot open here.
 */
export function GenerateReferencesRow({
  references,
  disabled,
  ready,
  style,
  onFillRequest,
}: {
  references: GenerateReferencesController;
  /** The assistant is working, or the conversation is not ready. */
  disabled: boolean;
  /** The conversation is read: its style can be chosen, during a run too. */
  ready: boolean;
  /** The conversation's style, with its choice. */
  style?: GenerationStyleChoice;
  /**
   * Put a prompt starter's text in the request field, with the cursor. With
   * it the row offers Inspirations.
   */
  onFillRequest?: (text: string) => void;
}) {
  const { t } = useTranslation("generate");
  const limitId = useId();
  const imagesNoteId = useId();
  const styleFailureId = useId();
  const styleFailed = style !== undefined && style.failure !== undefined;
  const imageInput = useRef<HTMLInputElement>(null);
  const videoInput = useRef<HTMLInputElement>(null);
  const { gestures, startingPoint, examples, images, video } = references;
  const full = examples.length >= MAX_GENERATION_REFERENCE_EXAMPLES;
  const exampleIds = new Set(examples.map(({ itemId }) => itemId));
  const library = {
    local: gestures.local,
    included: gestures.included,
    loading: gestures.loading,
    error: gestures.error,
    busy: false,
    onRetry: gestures.retry,
  };
  const chip = (
    gesture: GenerationReferenceGesture,
    removeLabel: string,
    onRemove: () => void,
  ) => (
    <LoadoutPoolMemberChip
      key={gesture.itemId}
      member={{
        binding_id: gesture.itemId,
        name: gesture.name,
        available: gestures.has(gesture.itemId),
      }}
      unavailableText={t("references.missing")}
      removeLabel={removeLabel}
      disabled={disabled}
      onRemove={onRemove}
    />
  );

  return (
    <div
      role="group"
      aria-label={t("references.label")}
      data-testid="generate-references"
      className="space-y-1.5 px-1"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {references.offersStartingPoint ? (
          <span data-testid="generate-reference-start">
            <LoadoutPoolPicker
              {...library}
              addLabel={t("references.startingPoint.choose")}
              copy={pickerCopy(t, t("references.startingPoint.add"))}
              disabled={disabled}
              status={(gesture) =>
                gesture.item_id === startingPoint?.itemId
                  ? {
                      text: t("references.picker.chosen"),
                      tone: "muted",
                      disabled: true,
                    }
                  : null
              }
              onSelect={(gesture) => {
                references.chooseStartingPoint(asReference(gesture));
                return true;
              }}
            />
          </span>
        ) : null}
        <span data-testid="generate-reference-examples">
          <LoadoutPoolPicker
            {...library}
            addLabel={t("references.examples.choose")}
            copy={pickerCopy(t, t("references.examples.add"))}
            disabled={disabled || full}
            describedBy={full ? limitId : undefined}
            status={(gesture) =>
              exampleIds.has(gesture.item_id)
                ? {
                    text: t("references.picker.chosen"),
                    tone: "muted",
                    disabled: true,
                  }
                : null
            }
            onSelect={(gesture) => {
              references.addExample(asReference(gesture));
              return true;
            }}
          />
        </span>
        {images ? (
          <>
            <input
              ref={imageInput}
              type="file"
              hidden
              multiple
              accept={IMAGE_ACCEPT}
              data-testid="generate-reference-images-input"
              onChange={(event) => {
                images.add(Array.from(event.target.files ?? []));
                // The same file can be chosen again after it was removed.
                event.target.value = "";
              }}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              // A model that cannot look at images takes none (R2.3); the
              // note below says why.
              disabled={disabled || images.unavailable !== null}
              aria-describedby={images.unavailable ? imagesNoteId : undefined}
              data-testid="generate-reference-attach"
              className="shrink-0"
              onClick={() => imageInput.current?.click()}
            >
              <ImagePlus />
              {t("references.images.add")}
            </Button>
          </>
        ) : null}
        {video ? (
          <>
            <input
              ref={videoInput}
              type="file"
              hidden
              accept="video/*"
              data-testid="generate-reference-video-input"
              onChange={(event) => {
                const chosen = event.target.files?.[0];
                if (chosen) void video.add(chosen);
                event.target.value = "";
              }}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={
                disabled || video.sampling || images?.unavailable != null
              }
              aria-describedby={images?.unavailable ? imagesNoteId : undefined}
              aria-busy={video.sampling}
              data-testid="generate-reference-video"
              className="shrink-0"
              onClick={() => videoInput.current?.click()}
            >
              <Film />
              {t("references.video.add")}
            </Button>
          </>
        ) : null}
        {onFillRequest ? (
          <GenerateInspirations
            references={references}
            disabled={disabled}
            onFillRequest={onFillRequest}
          />
        ) : null}
        {style ? (
          <GenerateStyleControl
            style={style}
            disabled={!ready}
            failureId={styleFailed ? styleFailureId : undefined}
          />
        ) : null}
      </div>
      {style && style.failure !== undefined ? (
        <GenerateStyleFailure id={styleFailureId} code={style.failure} />
      ) : null}
      {startingPoint ? (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="text-muted-foreground shrink-0 text-xs">
            {t("references.startingPoint.label")}
          </span>
          <ul
            aria-label={t("references.startingPoint.listLabel")}
            data-testid="generate-reference-start-list"
            className="flex min-w-0 flex-wrap gap-1.5"
          >
            {chip(
              startingPoint,
              t("references.startingPoint.remove", {
                name: startingPoint.name,
              }),
              () => references.chooseStartingPoint(null),
            )}
          </ul>
        </div>
      ) : null}
      {examples.length > 0 ? (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="text-muted-foreground shrink-0 text-xs">
            {t("references.examples.label")}
          </span>
          <ul
            aria-label={t("references.examples.listLabel")}
            data-testid="generate-reference-examples-list"
            className="flex min-w-0 flex-wrap gap-1.5"
          >
            {examples.map((example) =>
              chip(
                example,
                t("references.examples.remove", { name: example.name }),
                () => references.removeExample(example.itemId),
              ),
            )}
          </ul>
        </div>
      ) : null}
      {full ? (
        <p id={limitId} className="text-muted-foreground text-xs">
          {t("references.examples.full", {
            max: MAX_GENERATION_REFERENCE_EXAMPLES,
          })}
        </p>
      ) : null}
      {images ? (
        <ChatInputFileTray
          uppy={images.uppy}
          existingFiles={images.existing}
          onRemoveExistingFile={images.removeExisting}
        />
      ) : null}
      {images && images.unavailable !== null ? (
        <ReferenceImagesNote
          id={imagesNoteId}
          images={images}
          unavailable={images.unavailable}
        />
      ) : null}
    </div>
  );
}

/**
 * What the row says while the assistant's model cannot look at images: why
 * none can be attached, in chat's words; or, while images attached before
 * that model was chosen are still in the tray, that they are kept and not
 * used. The attach controls are described by it.
 */
function ReferenceImagesNote({
  id,
  images,
  unavailable,
}: {
  id: string;
  images: NonNullable<GenerateReferencesController["images"]>;
  unavailable: string;
}) {
  const { t } = useTranslation("generate");
  const uploads = useUppyState(
    images.uppy,
    (state) => Object.keys(state.files).length,
  );
  const attached = uploads + images.existing.length > 0;
  return (
    <p
      id={id}
      data-testid="generate-reference-images-note"
      className="text-muted-foreground text-xs"
    >
      {attached ? t("references.images.unused") : unavailable}
    </p>
  );
}
