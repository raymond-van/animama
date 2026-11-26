import { useProductApiClient } from "@animama/product-ui";
import { useEffect, useState } from "react";

import {
  rememberAvatarFileMaterials,
  useAvatarFileTraitsStore,
} from "@/lib/avatar/avatarSettings";
import { readAvatarFileFacts } from "@/lib/avatar/diagnostics/avatarFileFacts";
import { usesLilToonMaterials } from "@/lib/avatar/liltoon/lilToon";
import { avatarItemRuntimeEntry } from "@/lib/content/avatarPreviewTarget";
import { createLogger } from "@/lib/logger";
import { runtimeAvatarModelSha256 } from "@/lib/runtime-content/runtimeAvatarFaceParts";
import { runtimeContentDownloadUrl } from "@/lib/runtime-content/runtimeContentDelivery";

const logger = createLogger("AvatarItemFileTraits");

/**
 * The sha256 of an Avatar item's VRM file while `enabled`, and, when this
 * session has not loaded that file yet, a read of its file facts so the
 * Avatar settings know which materials it has (lilToon, all unlit or
 * neither) before any surface loads it. The backend keeps no file facts, so this downloads the file once
 * per file per session; a failed read leaves the Materials row hidden.
 */
export function useAvatarItemFileTraits(
  itemId: string | null,
  enabled: boolean,
): { vrmSha256: string | null } {
  const apiClient = useProductApiClient();
  const [vrmSha256, setVrmSha256] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !itemId) return;
    const controller = new AbortController();
    const { signal } = controller;
    void (async () => {
      let release: (() => void) | null = null;
      try {
        const entry = await avatarItemRuntimeEntry(apiClient, itemId, signal);
        const sha256 = runtimeAvatarModelSha256(entry);
        if (signal.aborted) return;
        setVrmSha256(sha256);
        if (!sha256) return;
        if (
          useAvatarFileTraitsStore.getState().materialsBySha256[sha256] !==
          undefined
        )
          return;
        const lease = await runtimeContentDownloadUrl(entry, undefined, {
          signal,
        });
        if (!lease) return;
        release = () => lease.release();
        const response = await fetch(lease.url, { signal });
        if (!response.ok) throw new Error("avatar_model_fetch_failed");
        const facts = readAvatarFileFacts(await response.arrayBuffer());
        if (signal.aborted) return;
        // A file whose glTF cannot be read does not load either; remembering
        // it as having neither kind avoids reading it again each time.
        rememberAvatarFileMaterials(
          sha256,
          facts === null
            ? "other"
            : usesLilToonMaterials({ extensionsUsed: facts.extensionsUsed })
              ? "liltoon"
              : facts.unlitOnly
                ? "unlit"
                : "other",
        );
      } catch (error) {
        if (signal.aborted) return;
        logger.warn("Load", "Could not read the Avatar file's materials", {
          reason: "avatar_file_traits_unavailable",
          error,
        });
      } finally {
        release?.();
      }
    })();
    return () => controller.abort();
  }, [apiClient, enabled, itemId]);

  return { vrmSha256: enabled ? vrmSha256 : null };
}
