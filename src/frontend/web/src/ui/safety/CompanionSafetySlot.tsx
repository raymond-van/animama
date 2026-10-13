import { useCompanionSafety } from "./CompanionSafetyProvider";
import { CompanionSafetyView } from "./CompanionSafetyView";

/**
 * Connected safety surface for the main window. The main window places the AI
 * notice (above the chat input) and the crisis card (bottom-right corner)
 * separately, so each slot renders one part.
 */
export function CompanionSafetySlot({
  part,
  className,
}: {
  part: "notice" | "crisis";
  className?: string;
}) {
  const safety = useCompanionSafety();
  if (!safety) return null;
  return (
    <CompanionSafetyView
      notice={part === "notice" ? safety.notice : null}
      noticeVisible={safety.noticeVisible}
      crisis={part === "crisis" ? safety.crisis : null}
      onDismissCrisis={safety.dismissCrisis}
      className={className}
    />
  );
}

/** Avatar-only mode has no chat panel: notice at bottom-center, card at bottom-right. */
export function AvatarOnlySafetyOverlay() {
  return (
    <>
      <div className="absolute inset-x-0 bottom-0 flex justify-center px-4 pb-6">
        <CompanionSafetySlot part="notice" className="max-w-xl" />
      </div>
      <div className="absolute right-4 bottom-4 w-[min(24rem,calc(100%-2rem))]">
        <CompanionSafetySlot part="crisis" />
      </div>
    </>
  );
}
