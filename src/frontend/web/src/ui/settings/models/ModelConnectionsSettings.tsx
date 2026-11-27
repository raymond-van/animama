import { type ReactNode, useId, useState } from "react";
import { Info, Plus, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import type {
  PyConfiguredModel,
  PyModelConnection,
  WebSearchCapability,
} from "@animama/runtime-contracts/api-types";
import { alternateModelIds, modelDisplayName } from "@/lib/chat/model-catalog";
import { cn } from "@/lib/utils";
import {
  useConnectionReachability,
  useModelConnectionPresets,
  useModelConnections,
} from "@/query/hooks/useModelConfiguration";
import { useChatGPTPlanAvailable } from "@/query/hooks/useChatGPTPlan";
import { useRefreshChatGPTPlanModels } from "@/query/mutations/useChatGPTPlan";
import { useRuntimeCapabilities } from "@/query/hooks/useRuntimeCapabilities";
import { Button } from "@/ui/components/button";
import { ModelSelectorLogo } from "@/ui/components/model-selector";
import { Tabs, TabsContent } from "@/ui/components/tabs";
import {
  DesktopCredentialsPanel,
  useDesktopCredentialsAvailable,
} from "@/ui/settings/DesktopCredentialsPanel";

import {
  CHATGPT_PLAN_PRESET,
  baseUrlHost,
  builtinConnectionKey,
  connectionEditPresets,
  connectionLocation,
  connectionProviderEntry,
  connectionStatusText,
  defaultLocationProvider,
  locationProviderGroups,
  modelCapabilityChips,
  modelConfigurationErrorCode,
  modelLocationLabel,
  modelProviderPurpose,
  modelSettingsAvailability,
  visibleModelLocations,
  type BuiltinConnectionKey,
  type ConnectionReachability,
  type ModelLocation,
  type ModelProviderEntry,
  type ModelProviderGroup,
} from "./model-configuration-state";
import {
  ModelConnectionDialog,
  ModelConnectionForm,
} from "./ModelConnectionDialog";
import { ModelInfoDialog } from "./ModelInfoDialog";
import { ModelLocationTabsList } from "./ModelLocationTabsList";
import { ChatGPTPlanCard } from "./ChatGPTPlanCard";
import { ModelProviderTabsList } from "./ModelProviderTabsList";
import { OwnerModelDialog, ShowModelButton } from "./OwnerModelDialog";
import { useModelRemoval } from "./useModelRemoval";

const BASE_URL_PLACEHOLDER: Record<ModelLocation, string> = {
  cloud: "https://api.example.com/v1",
  local: "http://127.0.0.1:8080/v1",
};

const TAG_CLASS =
  "bg-muted text-muted-foreground shrink-0 rounded-sm px-1.5 py-0.5 text-2xs font-medium";

/**
 * App Settings → Models connections: **Cloud** and **Local** tabs, each with
 * a row of provider tabs. A provider tab shows only that provider: its
 * connection card (status, Edit/Remove, models) when connected, otherwise
 * its connect form inline; Custom lists each custom server plus "Add a
 * custom server". Each built-in card (OpenAI, Anthropic) carries its own key
 * field on desktop. Each model row shows capability chips and opens an Info modal;
 * hidden rows stay listed behind a toggle so they can be shown again.
 * Connecting stays on that provider's tab and opens the add-model dialog.
 *
 * Renders nothing unless the runtime allows model configuration (the hosted
 * composition keeps its fixed catalog).
 */
export function ModelConnectionsSettings({
  disabled,
  defaultTab = "cloud",
}: {
  disabled: boolean;
  defaultTab?: ModelLocation;
}) {
  const { t } = useTranslation("models");
  const capabilities = useRuntimeCapabilities();
  const { modelConfiguration: enabled } = modelSettingsAvailability(
    capabilities.data,
  );
  const search = capabilities.data?.web_search;
  const chatgptPlan = useChatGPTPlanAvailable();
  const presets = useModelConnectionPresets(enabled);
  const connections = useModelConnections(enabled);
  const managedKeys = useDesktopCredentialsAvailable();
  const { startRemoval, dialog: removalDialog } = useModelRemoval(managedKeys);
  const [tab, setTab] = useState<ModelLocation>(defaultTab);
  // The owner's provider tab per location; unset opens the default one.
  const [providerTab, setProviderTab] = useState<
    Partial<Record<ModelLocation, string>>
  >({});
  const [addingCustom, setAddingCustom] = useState<ModelLocation | null>(null);
  const [connectionEditor, setConnectionEditor] =
    useState<PyModelConnection | null>(null);
  const [modelAdder, setModelAdder] = useState<PyModelConnection | null>(null);
  // Ids rather than rows, so the Info modal follows refetched data.
  const [info, setInfo] = useState<{
    connectionId: string;
    modelId: string;
  } | null>(null);

  const all = connections.data ?? [];
  const locations = visibleModelLocations(all);
  // A hidden location (Local behind its flag) falls back to Cloud.
  const shownTab = locations.includes(tab) ? tab : "cloud";
  const templates = all
    .filter((connection) => connection.source === "builtin")
    .flatMap((connection) => connection.models ?? [])
    .filter(
      (model) => model.source === "builtin" && model.model_kind === "chat",
    );
  const infoConnection = info
    ? all.find((connection) => connection.id === info.connectionId)
    : undefined;
  const infoModel = infoConnection?.models?.find(
    (model) => model.id === info?.modelId,
  );

  if (!enabled) return null;
  if (connections.isError)
    return (
      <p className="text-muted-foreground py-3 text-sm" role="status">
        {t("connections.loadFailed")}
      </p>
    );
  if (!connections.isSuccess) return null;

  const presetById = (id: string) =>
    presets.data?.find((preset) => preset.id === id);

  /** Show a new connection's provider tab and add its first model. */
  const connected = (saved: PyModelConnection) => {
    // A custom server lands on the location its address implies.
    const location = connectionLocation(saved);
    setTab(location);
    setProviderTab((current) => ({
      ...current,
      [location]: connectionProviderEntry(saved).id,
    }));
    setAddingCustom(null);
    setModelAdder(saved);
  };

  const providerPanel = (
    location: ModelLocation,
    { entry, connections: group }: ModelProviderGroup<PyModelConnection>,
  ) => {
    // OpenAI's tab holds both ways to use its models. Signing in with a
    // ChatGPT plan takes no key or address, so it has its own card, followed by
    // the models OpenAI lists while the plan is usable; the API key card follows.
    const offersPlan = entry.id === "openai" && chatgptPlan;
    const plan = group.find(
      (connection) =>
        connection.preset === CHATGPT_PLAN_PRESET &&
        connection.credential_state === "configured",
    );
    const items = group.filter(
      (connection) => connection.preset !== CHATGPT_PLAN_PRESET,
    );
    const planSection = offersPlan ? (
      <>
        <ChatGPTPlanCard disabled={disabled} />
        {plan ? (
          <ChatGPTPlanModels
            connection={plan}
            search={search}
            disabled={disabled}
            onInfo={(model) =>
              setInfo({ connectionId: plan.id, modelId: model.id })
            }
          />
        ) : null}
      </>
    ) : null;
    const custom = entry.presetId === "custom";
    const preset = presetById(entry.presetId);
    const form = (onCancel?: () => void) =>
      preset ? (
        <div className="border-border/60 rounded-xl border p-4">
          <ModelConnectionForm
            presets={[preset]}
            managedKeys={managedKeys}
            baseUrlPlaceholder={BASE_URL_PLACEHOLDER[location]}
            onSaved={connected}
            footer={({ saving, valid }) => (
              <div className="flex justify-end gap-2">
                {onCancel ? (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={saving}
                    onClick={onCancel}
                  >
                    {t("actions.cancel")}
                  </Button>
                ) : null}
                <Button type="submit" disabled={disabled || !valid || saving}>
                  {saving
                    ? t("connections.connecting")
                    : t("connections.connect")}
                </Button>
              </div>
            )}
          />
        </div>
      ) : null;
    return (
      <>
        <p className="text-muted-foreground text-xs">
          {modelProviderPurpose(entry, offersPlan)}
        </p>
        {planSection}
        {items.map((connection) => (
          <ConnectionCard
            key={connection.id}
            connection={connection}
            entry={entry}
            // Beside the plan, the key card says which way it is.
            title={offersPlan ? t("connections.apiKey.title") : undefined}
            description={
              offersPlan ? t("connections.apiKey.description") : undefined
            }
            location={location}
            active={shownTab === location}
            logo={
              connection.logo_provider ??
              presetById(connection.preset)?.logo_provider ??
              null
            }
            disabled={disabled}
            canEdit={presets.isSuccess}
            managedKeys={managedKeys}
            search={search}
            onEdit={() => setConnectionEditor(connection)}
            onRemove={() =>
              startRemoval({ kind: "connection", connection, usage: null })
            }
            onAddModel={() => setModelAdder(connection)}
            onInfo={(model) =>
              setInfo({ connectionId: connection.id, modelId: model.id })
            }
          />
        ))}
        {custom ? (
          addingCustom === location ? (
            form(() => setAddingCustom(null))
          ) : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled || !preset}
              onClick={() => setAddingCustom(location)}
            >
              <Plus className="size-4" aria-hidden />
              {t("connections.addCustomServer")}
            </Button>
          )
        ) : items.length === 0 ? (
          form()
        ) : null}
      </>
    );
  };

  const tabContent = (location: ModelLocation) => {
    const groups = locationProviderGroups(
      all,
      location,
      undefined,
      chatgptPlan,
    );
    const active = defaultLocationProvider(groups, providerTab[location]);
    return (
      <Tabs
        value={active}
        onValueChange={(value) =>
          setProviderTab((current) => ({ ...current, [location]: value }))
        }
      >
        <ModelProviderTabsList
          groups={groups}
          active={active}
          label={t("providers.tabsLabel", {
            location: modelLocationLabel(location),
          })}
        />
        {/* Every provider panel stays mounted so a half-filled connect form
            survives switching tabs. */}
        {groups.map((group) => (
          <TabsContent
            key={group.entry.id}
            value={group.entry.id}
            forceMount
            className="mt-4 space-y-4 data-[state=inactive]:hidden"
          >
            {providerPanel(location, group)}
          </TabsContent>
        ))}
      </Tabs>
    );
  };

  return (
    <div className="min-w-0 py-3">
      <Tabs
        value={shownTab}
        onValueChange={(value) => setTab(value as ModelLocation)}
      >
        <ModelLocationTabsList locations={locations} active={shownTab} />
        {locations.map((id) => (
          <TabsContent
            key={id}
            value={id}
            forceMount
            className="mt-4 data-[state=inactive]:hidden"
          >
            {tabContent(id)}
          </TabsContent>
        ))}
      </Tabs>
      {connectionEditor ? (
        <ModelConnectionDialog
          open
          onOpenChange={(open) => !open && setConnectionEditor(null)}
          presets={connectionEditPresets(connectionEditor, presets.data ?? [])}
          connection={connectionEditor}
          managedKeys={managedKeys}
        />
      ) : null}
      {modelAdder ? (
        <OwnerModelDialog
          open
          onOpenChange={(open) => !open && setModelAdder(null)}
          connection={modelAdder}
          templates={templates}
        />
      ) : null}
      {infoConnection && infoModel ? (
        <ModelInfoDialog
          onOpenChange={(open) => !open && setInfo(null)}
          connection={infoConnection}
          model={infoModel}
          templates={templates}
          disabled={disabled}
          onRemove={(model) => {
            setInfo(null);
            startRemoval({ kind: "model", model, usage: null });
          }}
        />
      ) : null}
      {removalDialog}
    </div>
  );
}

/** A Local card's reachability from its model-listing query. */
function reachabilityOf(query: {
  isSuccess: boolean;
  isError: boolean;
  error: unknown;
}): ConnectionReachability {
  if (query.isSuccess) return { state: "reachable" };
  if (query.isError)
    return {
      state: "failed",
      category: modelConfigurationErrorCode(query.error),
    };
  return { state: "checking" };
}

/**
 * One connected provider: name, status and actions, a built-in card's own
 * key, then its models. Local cards list the server's models once to report
 * whether it is running.
 */
function ConnectionCard({
  connection,
  entry,
  title,
  description,
  location,
  active,
  logo,
  disabled,
  canEdit,
  managedKeys,
  search,
  onEdit,
  onRemove,
  onAddModel,
  onInfo,
}: {
  connection: PyModelConnection;
  entry: ModelProviderEntry;
  /** A heading in place of the connection's name, and a line under it. */
  title?: string;
  description?: string;
  location: ModelLocation;
  /** Its location tab is showing; Local cards check reachability only then. */
  active: boolean;
  logo: string | null;
  disabled: boolean;
  canEdit: boolean;
  managedKeys: boolean;
  search: WebSearchCapability | null | undefined;
  onEdit: () => void;
  onRemove: () => void;
  onAddModel: () => void;
  onInfo: (model: PyConfiguredModel) => void;
}) {
  const { t } = useTranslation("models");
  const headingId = useId();
  const reachability = useConnectionReachability(
    connection.id,
    location === "local" && active,
  );
  const builtin = connection.source === "builtin";
  const builtinKey = builtinConnectionKey(connection);
  const status = connectionStatusText(
    connection,
    location === "local" ? reachabilityOf(reachability) : undefined,
  );
  // A custom cloud server's name may not say where it is.
  const host =
    location === "cloud" &&
    connectionProviderEntry(connection).presetId === "custom"
      ? baseUrlHost(connection.base_url)
      : null;

  return (
    <section
      aria-labelledby={headingId}
      className="border-border/60 space-y-3 rounded-xl border p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          {logo ? (
            <ModelSelectorLogo provider={logo} className="size-5" />
          ) : null}
          <div className="min-w-0">
            <h4
              id={headingId}
              className="flex flex-wrap items-center gap-2 text-sm font-semibold"
            >
              {title ?? connection.name}
              {entry.recommended ? (
                <span className="bg-primary/10 text-primary text-2xs rounded-sm px-1.5 py-0.5 font-medium">
                  {t("providers.recommended")}
                </span>
              ) : null}
            </h4>
            <p className="text-muted-foreground truncate text-xs">
              {/* Plain text: a live region per card would announce every
                  card whenever the tab opens. */}
              {host ? t("connections.detail", { host, status }) : status}
            </p>
          </div>
        </div>
        {builtin ? null : (
          <div className="flex gap-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={disabled || !canEdit}
              aria-label={t("connections.editNamed", { name: connection.name })}
              onClick={onEdit}
            >
              {t("actions.edit")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={disabled}
              aria-label={t("connections.removeNamed", {
                name: connection.name,
              })}
              onClick={onRemove}
            >
              {t("actions.remove")}
            </Button>
          </div>
        )}
      </div>
      {description ? (
        <p className="text-muted-foreground text-sm">{description}</p>
      ) : null}
      {builtinKey ? (
        <BuiltinKey
          name={connection.name}
          builtinKey={builtinKey}
          managedKeys={managedKeys}
        />
      ) : null}
      <ConnectionModels
        connection={connection}
        search={search}
        disabled={disabled}
        onInfo={onInfo}
        action={
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            aria-label={t("connections.addModelTo", { name: connection.name })}
            onClick={onAddModel}
          >
            <Plus className="size-4" aria-hidden />
            {t("connections.addModel")}
          </Button>
        }
      />
    </section>
  );
}

/**
 * A connection's models with the hidden-models toggle, and one action beside
 * it (adding a model, or refreshing the plan's list).
 */
function ConnectionModels({
  connection,
  search,
  disabled,
  onInfo,
  action,
  emptyText,
}: {
  connection: PyModelConnection;
  search: WebSearchCapability | null | undefined;
  disabled: boolean;
  onInfo: (model: PyConfiguredModel) => void;
  action: ReactNode;
  /** Shown when the connection has no models; defaults to the add-a-model hint. */
  emptyText?: string;
}) {
  const { t } = useTranslation("models");
  const [showHidden, setShowHidden] = useState(false);
  const models = connection.models ?? [];
  const hiddenCount = models.filter((model) => model.hidden).length;
  const listed = showHidden ? models : models.filter((model) => !model.hidden);
  const alternates = alternateModelIds(listed);
  return (
    <>
      <ul
        aria-label={t("connections.modelsOf", { name: connection.name })}
        className="divide-border/60 divide-y"
      >
        {listed.map((model) => (
          <ModelRow
            key={model.id}
            model={model}
            search={search}
            alternate={alternates.has(model.id)}
            disabled={disabled}
            onInfo={() => onInfo(model)}
          />
        ))}
        {models.length === 0 ? (
          <li className="text-muted-foreground py-2 text-xs">
            {emptyText ?? t("connections.noModels")}
          </li>
        ) : null}
      </ul>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {hiddenCount ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="-ml-2"
            aria-expanded={showHidden}
            onClick={() => setShowHidden((value) => !value)}
          >
            {showHidden
              ? t("connections.hideHidden")
              : t("connections.showHidden", { count: hiddenCount })}
          </Button>
        ) : (
          <span />
        )}
        {action}
      </div>
    </>
  );
}

/**
 * The models the signed-in account's plan includes, as OpenAI lists them.
 * They cannot be added or removed here; each can be hidden, and the list can
 * be read again.
 */
function ChatGPTPlanModels({
  connection,
  search,
  disabled,
  onInfo,
}: {
  connection: PyModelConnection;
  search: WebSearchCapability | null | undefined;
  disabled: boolean;
  onInfo: (model: PyConfiguredModel) => void;
}) {
  const { t } = useTranslation("models");
  const headingId = useId();
  const refresh = useRefreshChatGPTPlanModels();
  const run = async () => {
    try {
      await refresh.mutateAsync();
      toast.success(t("chatgptPlan.models.refreshed"));
    } catch {
      toast.error(t("chatgptPlan.models.refreshFailed"));
    }
  };
  return (
    <section
      aria-labelledby={headingId}
      className="border-border/60 space-y-3 rounded-xl border p-4"
    >
      <div>
        <h4 id={headingId} className="text-sm font-semibold">
          {t("chatgptPlan.models.title")}
        </h4>
        <p className="text-muted-foreground text-xs">
          {t("chatgptPlan.models.description")}
        </p>
      </div>
      <ConnectionModels
        connection={connection}
        search={search}
        disabled={disabled}
        onInfo={onInfo}
        emptyText={t("chatgptPlan.models.none")}
        action={
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled || refresh.isPending}
            onClick={() => void run()}
          >
            <RefreshCw className="size-4" aria-hidden />
            {refresh.isPending
              ? t("chatgptPlan.models.refreshing")
              : t("chatgptPlan.models.refresh")}
          </Button>
        }
      />
    </section>
  );
}

/**
 * A built-in card's key: the desktop vault field (the same state as App
 * Settings → API Keys), or where self-hosted web reads it.
 */
function BuiltinKey({
  name,
  builtinKey,
  managedKeys,
}: {
  name: string;
  builtinKey: BuiltinConnectionKey;
  managedKeys: boolean;
}) {
  const { t } = useTranslation("models");
  return managedKeys ? (
    <DesktopCredentialsPanel
      providers={[builtinKey.provider]}
      showTitle={false}
      description={t("connections.builtinKey.managed")}
      className="bg-transparent p-3"
    />
  ) : (
    <p className="text-muted-foreground text-xs">
      {t("connections.builtinKey.server", { name, env: builtinKey.env })}
    </p>
  );
}

/** A model's name, capability chips, hidden state and Info button. */
function ModelRow({
  model,
  search,
  alternate,
  disabled,
  onInfo,
}: {
  model: PyConfiguredModel;
  search: WebSearchCapability | null | undefined;
  /** Another listed row on this connection has the same name. */
  alternate: boolean;
  disabled: boolean;
  onInfo: () => void;
}) {
  const { t } = useTranslation("models");
  const chips = modelCapabilityChips(model, search);
  const name = modelDisplayName(model, alternate);
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1.5">
      <span
        className={cn(
          "min-w-0 flex-1 basis-40 truncate text-sm",
          model.hidden && "text-muted-foreground",
        )}
      >
        {name}
      </span>
      {chips.length ? (
        <ul
          aria-label={t("fields.capabilities")}
          className="flex flex-wrap gap-1"
        >
          {chips.map((chip) => (
            <li key={chip.id} className={TAG_CLASS} title={chip.description}>
              <span aria-hidden>{chip.label}</span>
              <span className="sr-only">{chip.description}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {model.hidden ? (
        <>
          <span
            className={cn(TAG_CLASS, "border-border border bg-transparent")}
          >
            {t("modelRow.hidden")}
          </span>
          <ShowModelButton model={model} disabled={disabled} />
        </>
      ) : null}
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-8 shrink-0"
        aria-label={t("modelRow.details", { name })}
        onClick={onInfo}
      >
        <Info className="size-4" aria-hidden />
      </Button>
    </li>
  );
}
