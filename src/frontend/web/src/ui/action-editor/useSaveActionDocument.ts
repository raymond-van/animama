import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import {
  contentFileFingerprint,
  sha256File,
} from "@/lib/content/contentUploads";
import { contentSaveFieldError } from "@/lib/content/contentSaveErrors";
import { WordedError } from "@/lib/errors/apiError";
import {
  type EditSessionIdentity,
  useActionEditorActions,
} from "@/query/mutations/useActionEditorActions";
import type { ManageActionTarget } from "@/ui/action-manage/ActionManageDialog";
import type { ActionSaveStage } from "./ActionEditorWorkspaceContext";
import {
  validateActionDocument,
  type ActionDocument,
  type ActionIntent,
} from "./actionDocument";

/**
 * A document that lacks a required detail. The person was already told which
 * (a toast names them), so callers show nothing more for it.
 */
export class ActionDocumentIncompleteError extends WordedError {
  constructor(message: string) {
    super(message);
    this.name = "ActionDocumentIncompleteError";
  }
}

export type SaveActionDocumentInput = {
  /** The document to save, as captured from where it was authored. */
  document: ActionDocument;
  /** The Local item the document replaces; without one a new item is saved. */
  itemId?: string | null;
  /** A VRMA document's animation file. */
  vrma?: File | null;
  /**
   * Names what is being saved when one caller saves unrelated documents (the
   * Generate page's drafts). A failed save keeps its edit session so a retry
   * continues it; a save under another key starts a new session instead of
   * continuing one that belongs to a different document.
   */
  sessionKey?: string;
  /**
   * Runs as soon as the catalog accepted the save, before the session is
   * closed and the person is told. The creator marks its document clean here.
   */
  onSaved?: () => void;
};

/**
 * The Gesture and Reaction save: validate the document, open or continue its
 * edit session, stage its file, save it to the Library and say so. The
 * creator and the Generate page both save through this one implementation.
 *
 * The hook keeps the edit session between attempts, so a retry after a
 * failure continues the same session and a staged file is not uploaded again.
 */
export function useSaveActionDocument(intent: ActionIntent) {
  const { t } = useTranslation("actionEditor");
  const actions = useActionEditorActions(intent);
  const [identity, setIdentityState] = useState<EditSessionIdentity | null>(
    null,
  );
  // Read by a save in progress, so it must not lag a render behind.
  const identityRef = useRef<EditSessionIdentity | null>(null);
  const uploadedRootFile = useRef<{
    sessionId: string;
    fileRef: string;
    fingerprint: string;
  } | null>(null);
  const sessionKey = useRef<string | undefined>(undefined);
  const [stage, setStage] = useState<ActionSaveStage>("idle");

  const setIdentity = useCallback((next: EditSessionIdentity | null) => {
    identityRef.current = next;
    setIdentityState(next);
  }, []);

  /** Forget the edit session: the document it belonged to was replaced or saved. */
  const resetSession = useCallback(() => {
    setIdentity(null);
    uploadedRootFile.current = null;
  }, [setIdentity]);

  const ensureSession = async (
    document: ActionDocument,
    itemId: string | null | undefined,
  ) => {
    const operationId = crypto.randomUUID();
    const current = identityRef.current;
    if (!current) {
      const created = await actions.beginSession.mutateAsync({
        document,
        operationId,
        itemId: itemId ?? undefined,
      });
      setIdentity(created);
      return created;
    }
    const updated = await actions.updateSession.mutateAsync({
      identity: current,
      document,
    });
    setIdentity(updated);
    return updated;
  };

  /** Save once and return the exact typed target used by Save & Equip. */
  const saveDocument = async (
    input: SaveActionDocumentInput,
  ): Promise<ManageActionTarget> => {
    const { document } = input;
    // Live validation belongs to the document, not a cached save failure.
    const issues = validateActionDocument(document, t);
    if (issues.length) {
      setStage("idle");
      const description = issues.map((issue) => issue.message).join(" ");
      toast.error(
        intent === "gesture"
          ? t("page.save.incomplete.gesture")
          : t("page.save.incomplete.reaction"),
        { description },
      );
      throw new ActionDocumentIncompleteError(description);
    }
    try {
      setStage("preparing");
      if (sessionKey.current !== input.sessionKey) {
        sessionKey.current = input.sessionKey;
        resetSession();
      }
      const session = await ensureSession(document, input.itemId);
      const file =
        document.implementation === "vrma"
          ? (input.vrma ?? null)
          : new File(
              [JSON.stringify(document.sequence)],
              `${document.semanticKey || "reaction"}.json`,
              { type: "application/json" },
            );
      if (!file)
        throw contentSaveFieldError(t("page.save.chooseVrma"), "files");
      const sha256 = await sha256File(file);
      const fingerprint = contentFileFingerprint(file, sha256);
      if (
        uploadedRootFile.current?.sessionId !== session.sessionId ||
        uploadedRootFile.current.fingerprint !== fingerprint
      ) {
        setStage("uploading");
        const uploaded = await actions.stageFile.mutateAsync({
          sessionId: session.sessionId,
          file,
          role: document.implementation === "vrma" ? "animation" : "sequence",
          sha256,
        });
        uploadedRootFile.current = {
          sessionId: session.sessionId,
          fileRef: uploaded.file_ref,
          fingerprint,
        };
      }
      setStage("saving");
      const ready = await actions.save.mutateAsync({ identity: session });
      input.onSaved?.();
      resetSession();
      setStage("idle");
      toast.success(
        intent === "gesture"
          ? t("page.save.saved.gesture")
          : t("page.save.saved.reaction"),
        { description: t("page.save.savedDescription") },
      );
      return {
        kind: intent,
        itemId: ready.item_id,
        name: document.name.trim(),
        description: document.aiDescription.trim(),
        source: ready.source,
        semanticKey: document.semanticKey,
        ...(intent === "reaction" && document.suggestedEmotion.trim()
          ? {
              emotion: document.suggestedEmotion,
              intensity: document.suggestedIntensity,
            }
          : {}),
        includedCount: document.dependencies.length,
      };
    } catch (cause) {
      setStage("idle");
      throw cause;
    }
  };

  return {
    /** The editable-catalog operations the save uses; the creator also previews through them. */
    actions,
    /** The edit session a failed or interrupted save left open. */
    identity,
    /** Continue an edit session recovered from an earlier visit. */
    restoreSession: setIdentity,
    resetSession,
    stage,
    setStage,
    /** A save is running: one of its requests is pending or a stage is shown. */
    isSaving:
      actions.beginSession.isPending ||
      actions.updateSession.isPending ||
      actions.stageFile.isPending ||
      actions.save.isPending ||
      stage !== "idle",
    saveDocument,
  };
}
