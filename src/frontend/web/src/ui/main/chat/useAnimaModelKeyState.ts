import type { PyModelProviderCatalogItem } from "@animama/runtime-contracts/api-types";
import { useAnima } from "@/query/hooks/useAnima";
import {
  useModelConnections,
  useModelRoles,
} from "@/query/hooks/useModelConfiguration";
import { useModelProviders } from "@/query/hooks/useModelProviders";
import { useRuntimeCapabilities } from "@/query/hooks/useRuntimeCapabilities";
import {
  modelKeyMissing,
  modelSettingsAvailability,
  replacementChatModel,
  roleCandidates,
} from "@/ui/settings/models/model-configuration-state";

/** An Anima whose chat model cannot reply because its connection has no key. */
export type AnimaModelKeyState = {
  /** The Anima's model. */
  model: PyModelProviderCatalogItem;
  /** The model one action can switch to: the Chat default, else the only able one. */
  replacement: PyModelProviderCatalogItem | null;
  /** Whether any chat model can reply, so choosing one is worth offering. */
  hasAbleModel: boolean;
};

/**
 * Whether `animaId`'s chat model is on a connection that needs a key and has
 * none, as happens to a starter Anima when setup chose no model and the owner
 * later set up another provider. Null when the model can reply, while lists
 * load, and on runtimes whose owner does not configure connections.
 */
export function useAnimaModelKeyState(
  animaId: string,
): AnimaModelKeyState | null {
  const { modelConfiguration } = modelSettingsAvailability(
    useRuntimeCapabilities().data,
  );
  const { data: anima } = useAnima(animaId);
  const { data: catalog } = useModelProviders();
  const { data: connections } = useModelConnections(modelConfiguration);
  const { data: roles } = useModelRoles(modelConfiguration);
  if (!modelConfiguration || !catalog || !connections) return null;

  const model = catalog.find(
    (item) => item.id === anima?.chat_profile?.default_model_provider_id,
  );
  if (!model || !modelKeyMissing(model, connections)) return null;
  const chatDefaultId = roles?.roles.find(
    (role) => role.role === "chat",
  )?.model_provider_id;
  return {
    model,
    replacement: replacementChatModel(catalog, connections, chatDefaultId),
    hasAbleModel: roleCandidates(catalog, "chat").some(
      (item) => !modelKeyMissing(item, connections),
    ),
  };
}
