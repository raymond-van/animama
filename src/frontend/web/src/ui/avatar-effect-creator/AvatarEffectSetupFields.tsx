import { FileImageIcon, LoaderCircleIcon } from "lucide-react";
import { useState } from "react";

import type { PyExactContentSource } from "@/lib/content/catalogTypes";
import {
  avatarEffectAcceptsOtherEyeImage,
  avatarEffectFaceOptionNames,
  suggestedAvatarEffectRegion,
  type AvatarEffectEditorAction,
  type AvatarEffectEditorAttachment,
  type AvatarEffectEditorDocument,
  type AvatarEffectEditorImageResources,
  type AvatarEffectEditorImageSlot,
} from "@/lib/avatar/vfx/editor";
import {
  HUMANOID_ANCHOR_LABELS,
  HUMANOID_ANCHORS,
} from "@/lib/avatar/humanoidAnchors";
import { AVATAR_VFX_TARGET_ROLES } from "@/lib/avatar/vfx/types";
import { cn } from "@/lib/utils";
import {
  CreatorField as Field,
  CreatorNumberField as NumberField,
  CreatorToggleRow as SwitchRow,
} from "@/ui/content-creator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/components/select";
import { Textarea } from "@/ui/components/textarea";
import { SoundUploadButton } from "@/ui/sound-upload/SoundUploadButton";
import { LICENSED_SOUND_NOTE } from "@/lib/content/previewSound";
import {
  ATTACHMENT_OPTIONS,
  SIDES_LABELS,
  sidesChoice,
  sidesChoicePatch,
  sidesChoices,
  type SidesChoice,
} from "./avatarEffectPlacement";

type Dispatch = (action: AvatarEffectEditorAction) => void;

type SoundOption = {
  item_id: string;
  name: string;
  source: PyExactContentSource | null;
};

/** Plain names for the face parts art can be painted on or hide. */
export const FACE_PART_NAMES: Record<
  (typeof AVATAR_VFX_TARGET_ROLES)[number],
  string
> = {
  face_skin: "Face skin",
  eye_iris: "Eyes (iris)",
  eye_highlight: "Eye highlights",
  eyeline: "Eye lines",
  eyelash: "Eyelashes",
};

const BODY_POINTS = HUMANOID_ANCHORS.map(
  (anchor) => [anchor, HUMANOID_ANCHOR_LABELS[anchor]] as const,
);

const LANDMARKS = [
  ["eyes", "Eyes"],
  ["mouth", "Mouth"],
  ["forehead", "Forehead"],
  ["top", "Top of the head"],
  ["top_edge", "Above the head"],
] as const;

const SURFACE_AREAS = [
  ["full", "Whole part"],
  ["eyes", "Eyes"],
  ["undereye", "Under the eyes"],
  ["blush", "Cheeks"],
  ["mouth", "Mouth"],
] as const;

const PIVOTS = [
  ["top-left", "Top left"],
  ["top-center", "Top"],
  ["top-right", "Top right"],
  ["center-left", "Left"],
  ["center", "Centre"],
  ["center-right", "Right"],
  ["bottom-left", "Bottom left"],
  ["bottom-center", "Bottom"],
  ["bottom-right", "Bottom right"],
] as const;

/** Small select used throughout the setup panel. */
function ChoiceField<T extends string>({
  label,
  value,
  options,
  invalid,
  onValue,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<readonly [T, string]>;
  invalid?: boolean;
  onValue: (value: T) => void;
}) {
  return (
    <Field label={label} invalid={invalid}>
      <Select value={value} onValueChange={(next) => onValue(next as T)}>
        <SelectTrigger size="sm" className="w-full text-xs" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map(([option, optionLabel]) => (
            <SelectItem key={option} value={option}>
              {optionLabel}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

/** Image chooser with drag and drop; the same control serves both images. */
function ImageField({
  label,
  hint,
  name,
  busy,
  error,
  invalid,
  hasImage,
  onChoose,
  onClear,
}: {
  label: string;
  hint: string;
  name: string | null;
  busy: boolean;
  error: string | null;
  invalid: boolean;
  hasImage: boolean;
  onChoose: (file: File) => void;
  onClear?: () => void;
}) {
  const [dragActive, setDragActive] = useState(false);
  return (
    <Field label={label} invalid={invalid}>
      <label
        className={cn(
          "border-border/70 bg-background/55 hover:bg-accent/50 flex cursor-pointer items-center gap-3 rounded-lg border border-dashed p-3 transition",
          dragActive && "border-sky-400 bg-sky-100/50 dark:bg-sky-950/30",
          invalid && "border-destructive",
        )}
        onDragEnter={(event) => {
          event.preventDefault();
          setDragActive(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={() => setDragActive(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragActive(false);
          const file = event.dataTransfer.files[0];
          if (file) onChoose(file);
        }}
      >
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300">
          {busy ? (
            <LoaderCircleIcon className="animate-spin" />
          ) : (
            <FileImageIcon />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">
            {name ?? "Choose image"}
          </div>
          <div className="text-muted-foreground text-xs">{hint}</div>
        </div>
        <span className="border-border rounded-md border px-2 py-1 text-xs">
          {hasImage ? "Replace" : "Browse"}
        </span>
        <input
          className="sr-only"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          aria-label={label}
          aria-invalid={invalid}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onChoose(file);
            event.currentTarget.value = "";
          }}
        />
      </label>
      {onClear && hasImage ? (
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground self-start text-xs underline"
          onClick={onClear}
        >
          Use the mirrored main image instead
        </button>
      ) : null}
      {error ? <p className="text-destructive mt-1 text-xs">{error}</p> : null}
    </Field>
  );
}

/**
 * The Setup panel: where the art attaches, the art itself, face options,
 * sound and description. Only the controls the chosen attachment uses appear.
 */
export function AvatarEffectSetupFields({
  document,
  imageResources,
  imageBusy,
  imageError,
  invalidField,
  soundOptions,
  soundPending,
  licensedSoundOmitted = false,
  onDispatch,
  onChooseImage,
  onClearOtherEyeImage,
}: {
  document: AvatarEffectEditorDocument;
  imageResources: AvatarEffectEditorImageResources;
  imageBusy: AvatarEffectEditorImageSlot | null;
  imageError: { slot: AvatarEffectEditorImageSlot; message: string } | null;
  /** A failed Save's or validation's field, to highlight its control. */
  invalidField: string | null;
  soundOptions: SoundOption[];
  soundPending: boolean;
  /** The draft was copied from a built-in effect whose licensed sound stayed behind. */
  licensedSoundOmitted?: boolean;
  onDispatch: Dispatch;
  onChooseImage: (slot: AvatarEffectEditorImageSlot, file: File) => void;
  onClearOtherEyeImage: () => void;
}) {
  const attachment = document.attachment;
  const invalid = (prefix: string) =>
    Boolean(invalidField && invalidField.startsWith(prefix));
  const otherEye = avatarEffectAcceptsOtherEyeImage(attachment);
  return (
    <div className="space-y-3">
      <Field label="Attach to" invalid={invalid("attachment.kind")}>
        <Select
          value={attachment.kind}
          onValueChange={(kind) =>
            onDispatch({
              type: "set-attachment",
              kind: kind as AvatarEffectEditorAttachment["kind"],
            })
          }
        >
          <SelectTrigger
            size="sm"
            className="w-full text-xs"
            aria-label="Attach to"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ATTACHMENT_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-muted-foreground text-xs">
          {
            ATTACHMENT_OPTIONS.find(
              (option) => option.value === attachment.kind,
            )?.description
          }
        </p>
      </Field>

      <AttachmentFields
        attachment={attachment}
        invalid={invalid}
        onDispatch={onDispatch}
      />

      <ImageField
        label="Image"
        hint="PNG, JPEG, or WebP · up to 16 MiB"
        name={
          imageResources.image?.file.name ??
          document.art.image?.originalName ??
          null
        }
        busy={imageBusy === "image"}
        error={imageError?.slot === "image" ? imageError.message : null}
        invalid={invalid("art.image") || invalidField === "files"}
        hasImage={Boolean(document.art.image)}
        onChoose={(file) => onChooseImage("image", file)}
      />
      {otherEye ? (
        <ImageField
          label="Other side image (optional)"
          hint="Drawn as is on the mirrored side, for a wink or other uneven art."
          name={
            imageResources.otherEyeImage?.file.name ??
            document.art.otherEyeImage?.originalName ??
            null
          }
          busy={imageBusy === "otherEyeImage"}
          error={
            imageError?.slot === "otherEyeImage" ? imageError.message : null
          }
          invalid={invalid("art.otherEyeImage")}
          hasImage={Boolean(document.art.otherEyeImage)}
          onChoose={(file) => onChooseImage("otherEyeImage", file)}
          onClear={onClearOtherEyeImage}
        />
      ) : null}
      <FlipbookFields
        document={document}
        invalid={invalid("art.flipbook")}
        onDispatch={onDispatch}
      />

      <FaceOptionFields document={document} onDispatch={onDispatch} />

      <Field label="Sound when applied" invalid={invalid("sound")}>
        <SoundUploadButton />
        <Select
          value={soundSourceKey(document.sound?.source ?? null)}
          onValueChange={(value) => {
            if (value === "none") {
              onDispatch({ type: "patch", patch: { sound: null } });
              return;
            }
            const option = soundOptions.find(
              (item) => soundSourceKey(item.source) === value,
            );
            if (!option?.source) return;
            onDispatch({
              type: "patch",
              patch: {
                sound: {
                  alias: "on-apply",
                  label: option.name,
                  source: option.source,
                },
              },
            });
          }}
        >
          <SelectTrigger
            size="sm"
            className="w-full text-xs"
            aria-label="Sound when applied"
            aria-describedby={
              licensedSoundOmitted
                ? "avatar-effect-licensed-sound-note"
                : undefined
            }
          >
            <SelectValue
              placeholder={soundPending ? "Loading sounds…" : "No sound"}
            />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">No sound</SelectItem>
            {document.sound &&
            !soundOptions.some(
              (item) =>
                soundSourceKey(item.source) ===
                soundSourceKey(document.sound?.source ?? null),
            ) ? (
              <SelectItem value={soundSourceKey(document.sound.source)}>
                {document.sound.label} · exact content
              </SelectItem>
            ) : null}
            {soundOptions.flatMap((item) =>
              item.source ? (
                <SelectItem
                  key={item.item_id}
                  value={soundSourceKey(item.source)}
                >
                  {item.name}
                </SelectItem>
              ) : (
                []
              ),
            )}
          </SelectContent>
        </Select>
        {licensedSoundOmitted ? (
          <p
            id="avatar-effect-licensed-sound-note"
            className="text-muted-foreground text-xs"
          >
            {LICENSED_SOUND_NOTE}
          </p>
        ) : null}
      </Field>
      <Field label="Description">
        <Textarea
          className="min-h-16 text-xs"
          rows={2}
          aria-label="Description"
          value={document.description}
          onChange={(event) =>
            onDispatch({
              type: "patch",
              patch: { description: event.target.value },
            })
          }
        />
      </Field>
      <ReplacesField document={document} onDispatch={onDispatch} />
    </div>
  );
}

function SidesField({
  attachment,
  onDispatch,
}: {
  attachment: AvatarEffectEditorAttachment;
  onDispatch: Dispatch;
}) {
  const choices = sidesChoices(attachment);
  const current = sidesChoice(attachment);
  if (!choices.length || !current) return null;
  const eyes =
    attachment.kind === "face_landmark" ||
    (attachment.kind === "face_surface" && attachment.area === "eyes");
  const label = (choice: SidesChoice) =>
    choice === "mirrored" && eyes
      ? "Both eyes, mirrored"
      : choice === "across" && eyes
        ? "One image across both eyes"
        : SIDES_LABELS[choice];
  return (
    <>
      <ChoiceField
        label={eyes ? "Which eyes" : "Which side"}
        value={current}
        options={choices.map((choice) => [choice, label(choice)] as const)}
        onValue={(choice) =>
          onDispatch({
            type: "patch-attachment",
            patch: sidesChoicePatch(attachment, choice),
          })
        }
      />
      {current === "mirrored" && "side" in attachment ? (
        <ChoiceField
          label="Art is drawn for the"
          // The runtime draws a sideless mirrored pair for the right eye.
          value={attachment.side ?? "right"}
          options={[
            ["left", eyes ? "Left eye" : "Left side"],
            ["right", eyes ? "Right eye" : "Right side"],
          ]}
          onValue={(side) =>
            onDispatch({ type: "patch-attachment", patch: { side } })
          }
        />
      ) : null}
    </>
  );
}

function AttachmentFields({
  attachment,
  invalid,
  onDispatch,
}: {
  attachment: AvatarEffectEditorAttachment;
  invalid: (prefix: string) => boolean;
  onDispatch: Dispatch;
}) {
  const patch = (value: Record<string, unknown>) =>
    onDispatch({ type: "patch-attachment", patch: value });
  switch (attachment.kind) {
    case "face_landmark":
      return (
        <>
          <ChoiceField
            label="Where"
            value={attachment.landmark}
            options={LANDMARKS}
            invalid={invalid("attachment.landmark")}
            onValue={(landmark) => patch({ landmark })}
          />
          {attachment.position ? (
            <ChoiceField
              label="Position"
              value={attachment.position}
              options={[
                ...(attachment.landmark === "top_edge"
                  ? ([["left_corner", "Far left"]] as const)
                  : []),
                ["left", "Left"],
                ["middle", "Middle"],
                ["right", "Right"],
                ...(attachment.landmark === "top_edge"
                  ? ([["right_corner", "Far right"]] as const)
                  : []),
              ]}
              invalid={invalid("attachment.position")}
              onValue={(position) => patch({ position })}
            />
          ) : null}
          <SidesField attachment={attachment} onDispatch={onDispatch} />
          <p className="text-muted-foreground text-xs">
            Left and right are the avatar&apos;s own.
          </p>
        </>
      );
    case "face_surface": {
      const decal = ["undereye", "blush", "mouth"].includes(attachment.area);
      return (
        <>
          <ChoiceField
            label="Where on the face"
            value={attachment.area}
            options={SURFACE_AREAS}
            invalid={invalid("attachment.area")}
            onValue={(area) =>
              patch({
                area,
                // Eye art paints the irises; other areas paint the skin.
                ...(area === "eyes" ? { part: "eye_iris" } : {}),
                ...(area === "full" ? { part: "face_skin" } : {}),
              })
            }
          />
          {!decal ? (
            <ChoiceField
              label="Paint on"
              value={attachment.part}
              options={AVATAR_VFX_TARGET_ROLES.map(
                (role) => [role, FACE_PART_NAMES[role]] as const,
              )}
              invalid={invalid("attachment.part")}
              onValue={(part) => patch({ part })}
            />
          ) : null}
          <SidesField attachment={attachment} onDispatch={onDispatch} />
          {decal ? (
            <ChoiceField
              label="Image point placed on the face"
              value={attachment.pivot ?? "center"}
              options={PIVOTS}
              invalid={invalid("attachment.pivot")}
              onValue={(pivot) => patch({ pivot })}
            />
          ) : (
            <SwitchRow
              label="Keep the original underneath"
              description="Off replaces the part's own texture where the art is."
              checked={(attachment.mode ?? "overlay") === "overlay"}
              onChecked={(keep) =>
                patch({ mode: keep ? "overlay" : "replace" })
              }
            />
          )}
          <p className="text-muted-foreground text-xs">
            Left and right are the avatar&apos;s own.
          </p>
        </>
      );
    }
    case "body":
      return (
        <>
          <ChoiceField
            label="Body point"
            value={attachment.bone}
            options={BODY_POINTS}
            invalid={invalid("attachment.bone")}
            onValue={(bone) => patch({ bone })}
          />
          <SwitchRow
            label="Always face the camera"
            description="Off keeps the art turned with the body point."
            checked={(attachment.facing ?? "camera") === "camera"}
            onChecked={(camera) =>
              patch({ facing: camera ? "camera" : "bone" })
            }
          />
        </>
      );
    case "sticker":
      return (
        <ChoiceField
          label="Beside the"
          value={attachment.around ?? "head"}
          options={[
            ["head", "Head"],
            ["body", "Body"],
          ]}
          invalid={invalid("attachment.around")}
          onValue={(around) => patch({ around })}
        />
      );
    case "silhouette":
      return (
        <>
          <ChoiceField
            label="Fill"
            value={attachment.fill ?? "pattern"}
            options={[
              ["pattern", "Repeat the image as a pattern"],
              ["tint", "Tint with the image's colour"],
            ]}
            invalid={invalid("attachment.fill")}
            onValue={(fill) => patch({ fill })}
          />
          {(attachment.fill ?? "pattern") === "pattern" ? (
            <div className="grid grid-cols-3 gap-2">
              <NumberField
                label="Tile size (×)"
                compact
                value={attachment.patternScale ?? 1}
                min={0.01}
                max={20}
                step={0.1}
                decimalPlaces={2}
                onChange={(value) =>
                  patch({ patternScale: Math.min(20, Math.max(0.01, value)) })
                }
              />
              <NumberField
                label="Scroll X (tiles/s)"
                compact
                value={attachment.scroll?.x ?? 0}
                min={-10}
                max={10}
                step={0.1}
                decimalPlaces={2}
                onChange={(x) =>
                  patch({ scroll: { x, y: attachment.scroll?.y ?? 0 } })
                }
              />
              <NumberField
                label="Scroll Y (tiles/s)"
                compact
                value={attachment.scroll?.y ?? 0}
                min={-10}
                max={10}
                step={0.1}
                decimalPlaces={2}
                onChange={(y) =>
                  patch({ scroll: { x: attachment.scroll?.x ?? 0, y } })
                }
              />
            </div>
          ) : null}
        </>
      );
  }
}

/** Flipbook: frames on a grid in the image, played at a frame rate. */
function FlipbookFields({
  document,
  invalid,
  onDispatch,
}: {
  document: AvatarEffectEditorDocument;
  invalid: boolean;
  onDispatch: Dispatch;
}) {
  const flipbook = document.art.flipbook;
  const set = (value: typeof flipbook) =>
    onDispatch({ type: "patch-art", patch: { flipbook: value } });
  const integer = (value: number, max: number) =>
    Math.min(max, Math.max(1, Math.round(value)));
  return (
    <div
      className={cn(
        "space-y-2",
        invalid && "ring-destructive/40 rounded-lg p-2 ring-1",
      )}
    >
      <SwitchRow
        label="Animated sprite sheet"
        description="The image holds frames on a grid, played in order."
        checked={Boolean(flipbook)}
        onChecked={(enabled) =>
          set(
            enabled
              ? { columns: 4, rows: 1, frames: 4, fps: 12, loop: "loop" }
              : null,
          )
        }
      />
      {flipbook ? (
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label="Columns"
            compact
            value={flipbook.columns}
            min={1}
            max={16}
            step={1}
            decimalPlaces={0}
            onChange={(value) => {
              const columns = integer(value, 16);
              set({
                ...flipbook,
                columns,
                frames: Math.min(flipbook.frames, columns * flipbook.rows),
              });
            }}
          />
          <NumberField
            label="Rows"
            compact
            value={flipbook.rows}
            min={1}
            max={16}
            step={1}
            decimalPlaces={0}
            onChange={(value) => {
              const rows = integer(value, 16);
              set({
                ...flipbook,
                rows,
                frames: Math.min(flipbook.frames, flipbook.columns * rows),
              });
            }}
          />
          <NumberField
            label="Frames"
            compact
            value={flipbook.frames}
            min={1}
            max={flipbook.columns * flipbook.rows}
            step={1}
            decimalPlaces={0}
            onChange={(value) =>
              set({
                ...flipbook,
                frames: integer(value, flipbook.columns * flipbook.rows),
              })
            }
          />
          <NumberField
            label="Frames per second"
            compact
            value={flipbook.fps}
            min={0.1}
            max={60}
            step={1}
            decimalPlaces={1}
            onChange={(value) =>
              set({ ...flipbook, fps: Math.min(60, Math.max(0.1, value)) })
            }
          />
          <div className="col-span-2">
            <ChoiceField
              label="Playback"
              value={flipbook.loop ?? "loop"}
              options={[
                ["loop", "Repeat"],
                ["once", "Play once"],
                ["pingpong", "Back and forth"],
              ]}
              onValue={(loop) => set({ ...flipbook, loop })}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Eye and mouth cleanup options; each is on unless switched off. */
function FaceOptionFields({
  document,
  onDispatch,
}: {
  document: AvatarEffectEditorDocument;
  onDispatch: Dispatch;
}) {
  const names = avatarEffectFaceOptionNames(document.attachment);
  if (!names.size) return null;
  const options = document.faceOptions;
  const eyes =
    document.attachment.kind === "face_landmark" &&
    document.attachment.landmark === "eyes";
  const set = (patch: Partial<typeof options>) =>
    onDispatch({ type: "patch-face-options", patch });
  const hidden = options.hideParts ?? [];
  return (
    <div className="space-y-2 border-t pt-3">
      {names.has("forceBlink") ? (
        <SwitchRow
          label="Close the eyes"
          description="Blink the avatar's eyes behind the art."
          checked={options.forceBlink ?? true}
          onChecked={(forceBlink) => set({ forceBlink })}
        />
      ) : null}
      {names.has("hideEyeDetails") ? (
        <SwitchRow
          label="Hide eye details"
          description="Hide eye highlights, eye lines and eyelashes."
          checked={options.hideEyeDetails ?? true}
          onChecked={(hideEyeDetails) => set({ hideEyeDetails })}
        />
      ) : null}
      {names.has("faceCleanup") ? (
        <SwitchRow
          label={eyes ? "Clean up the eye area" : "Clean up the mouth area"}
          description="Cover painted detail with the sampled skin colour."
          checked={options.faceCleanup ?? true}
          onChecked={(faceCleanup) => set({ faceCleanup })}
        />
      ) : null}
      {names.has("skinBackdrop") ? (
        <SwitchRow
          label="Skin-coloured backing"
          description="Place skin colour behind transparent parts of the art."
          checked={options.skinBackdrop ?? false}
          onChecked={(skinBackdrop) => set({ skinBackdrop })}
        />
      ) : null}
      {names.has("hideParts") ? (
        <details className="space-y-2">
          <summary className="cursor-pointer text-xs font-medium">
            Hide other face parts ({hidden.length})
          </summary>
          <p className="text-muted-foreground text-xs">
            Hide these parts while the effect plays. The part the art is on
            stays visible.
          </p>
          {AVATAR_VFX_TARGET_ROLES.map((role) => (
            <SwitchRow
              key={role}
              label={`Hide ${FACE_PART_NAMES[role].toLowerCase()}`}
              checked={hidden.includes(role)}
              onChecked={(checked) =>
                set({
                  hideParts: checked
                    ? [...hidden, role]
                    : hidden.filter((item) => item !== role),
                })
              }
            />
          ))}
        </details>
      ) : null}
    </div>
  );
}

const REGION_LABELS: Record<string, string> = {
  eyes: "Effects on the eyes",
  undereye: "Effects under the eyes",
  blush: "Effects on the cheeks",
  mouth: "Effects on the mouth",
  emote: "Nothing; it plays alongside others",
  full_face: "Nothing; it plays alongside other whole-face art",
};

/**
 * Which other effects this one replaces when both play. Face effects in the
 * same eye, cheek or mouth area replace each other; others stack.
 */
function ReplacesField({
  document,
  onDispatch,
}: {
  document: AvatarEffectEditorDocument;
  onDispatch: Dispatch;
}) {
  const kind = document.attachment.kind;
  if (kind === "body" || kind === "sticker" || kind === "silhouette")
    return null;
  const automatic = suggestedAvatarEffectRegion(document.attachment);
  const stacking = automatic === "full_face" ? "full_face" : "emote";
  const options: Array<readonly [string, string]> = [
    ["automatic", `Automatic: ${REGION_LABELS[automatic]?.toLowerCase()}`],
    ["eyes", REGION_LABELS.eyes],
    ["undereye", REGION_LABELS.undereye],
    ["blush", REGION_LABELS.blush],
    ["mouth", REGION_LABELS.mouth],
    [stacking, REGION_LABELS[stacking]!],
  ];
  // A saved custom region is always offered, so the select never shows blank.
  if (
    document.regionMode === "custom" &&
    !options.some(([value]) => value === document.region)
  )
    options.push([
      document.region,
      REGION_LABELS[document.region] ?? document.region,
    ]);
  return (
    <details className="space-y-2 border-t pt-3">
      <summary className="cursor-pointer text-xs font-medium">Advanced</summary>
      <ChoiceField
        label="Replaces"
        value={
          document.regionMode === "automatic" ? "automatic" : document.region
        }
        options={options}
        onValue={(value) =>
          onDispatch({
            type: "patch",
            patch:
              value === "automatic"
                ? { regionMode: "automatic" }
                : { region: value as AvatarEffectEditorDocument["region"] },
          })
        }
      />
      <p className="text-muted-foreground text-xs">
        When two effects on the same area play together, the newer one replaces
        the older.
      </p>
    </details>
  );
}

export function soundSourceKey(source: PyExactContentSource | null): string {
  if (!source) return "none";
  return source.type === "builtin"
    ? `builtin:${source.content_id ?? ""}:${source.version ?? ""}`
    : `catalog:${source.catalog_item_id}`;
}
