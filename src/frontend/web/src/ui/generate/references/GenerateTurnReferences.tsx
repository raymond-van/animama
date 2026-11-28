import { useTranslation } from "react-i18next";

import { ChatMessageImages } from "@/ui/main/chat/ChatMessageImages";
import type { GenerationRunReferences } from "./generationReferences";

/**
 * What a turn of the person carried besides its words, shown above its
 * bubble: its images as a chat message shows them, then the Gesture it
 * started from and its examples of the feel, by name. Names are the person's
 * content and are shown as they are.
 */
export function GenerateTurnReferences({
  references,
  imagesSent = true,
}: {
  references: GenerationRunReferences;
  /** `false` when the run's model took none of the turn's images. */
  imagesSent?: boolean;
}) {
  const { t } = useTranslation("generate");
  const { startingPoint, examples, images } = references;
  const named = (name: string) => name || t("references.unnamed");
  const gestures = Boolean(startingPoint) || examples.length > 0;
  if (!gestures && images.length === 0) return null;
  return (
    <div
      className="flex max-w-full flex-col items-end gap-1"
      data-testid="generate-turn-references"
    >
      {images.length > 0 ? <ChatMessageImages images={images} /> : null}
      {images.length > 0 && !imagesSent ? (
        <p className="text-muted-foreground text-right text-xs">
          {t("transcript.references.imagesUnused")}
        </p>
      ) : null}
      {gestures ? (
        <ul
          aria-label={t("transcript.references.label")}
          className="text-muted-foreground space-y-0.5 text-right text-xs"
        >
          {startingPoint ? (
            <li>
              {t("transcript.references.startingPoint", {
                name: named(startingPoint.name),
              })}
            </li>
          ) : null}
          {examples.length > 0 ? (
            <li>
              {t("transcript.references.examples", {
                names: examples.map(({ name }) => named(name)),
              })}
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
