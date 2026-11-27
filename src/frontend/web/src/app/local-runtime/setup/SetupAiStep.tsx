import {
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import type {
  PyConfiguredModel,
  PyModelConnection,
  PyModelConnectionDetection,
  PyModelConnectionPreset,
} from "@animama/runtime-contracts/api-types";
import type { SetupModelLocation } from "@/app/local-runtime/setup-draft";
import {
  useModelConnectionPresets,
  useModelConnections,
  useModelRoles,
} from "@/query/hooks/useModelConfiguration";
import { useChatGPTPlanAvailable } from "@/query/hooks/useChatGPTPlan";
import { useModelProviders } from "@/query/hooks/useModelProviders";
import { useRuntimeCapabilities } from "@/query/hooks/useRuntimeCapabilities";
import {
  useCreateModelConnection,
  useDetectModelServer,
} from "@/query/mutations/useModelConfiguration";
import { Button } from "@/ui/components/button";
import { Tabs, TabsContent } from "@/ui/components/tabs";
import {
  DesktopCredentialsPanel,
  useDesktopCredentialsAvailable,
  type DesktopCredentialsController,
} from "@/ui/settings/DesktopCredentialsPanel";
import {
  ModelConnectionDialog,
  ModelConnectionForm,
} from "@/ui/settings/models/ModelConnectionDialog";
import { OwnerModelDialog } from "@/ui/settings/models/OwnerModelDialog";
import { useModelRemoval } from "@/ui/settings/models/useModelRemoval";
import { ModelLocationTabsList } from "@/ui/settings/models/ModelLocationTabsList";
import { ChatGPTPlanCard } from "@/ui/settings/models/ChatGPTPlanCard";
import { ModelProviderTabsList } from "@/ui/settings/models/ModelProviderTabsList";
import {
  baseUrlHost,
  builtinConnectionKey,
  connectionEditPresets,
  connectionLocation,
  connectionProviderEntry,
  connectionStatusText,
  defaultLocationProvider,
  detectionMessage,
  locationProviderGroups,
  modelConfigurationErrorMessage,
  modelLocationLabel,
  modelProviderLabel,
  modelProviderPurpose,
  modelSettingsAvailability,
  visibleModelLocations,
  type ModelProviderEntry,
} from "@/ui/settings/models/model-configuration-state";

import {
  connectionForDetection,
  detectedModelsToAdd,
  ownerModelChoices,
  setupBuiltins,
  setupChatGPTPlan,
  setupChatModelReady,
  type SetupBuiltinProvider,
  type SetupModelChoice,
} from "./setup-state";
import { useChooseWhenReady } from "./useChooseWhenReady";

/** A model being added in the add-model dialog, optionally prefilled. */
type ModelAdder = { connection: PyModelConnection; initialModelId?: string };

/** Whether a just-added model can be the Chat default, as the server requires. */
function canChat(model: PyConfiguredModel): boolean {
  return (
    model.model_kind === "chat" &&
    model.capabilities.supports_streaming &&
    model.context_window_tokens != null
  );
}

/**
 * Setup's AI step: where models run (Cloud | Local) and a tab per provider,
 * with OpenAI and Anthropic tagged as recommended. They take their keys; other providers connect
 * with the same form as App Settings → Models. Each local server tab looks
 * for that server at its default address and adds one of its models. The
 * model new Animas chat with is whichever was set up last (saving the OpenAI
 * or Anthropic key, or adding a chat model); with none, the system default
 * applies. The step reports whether that model can reply, so setup can ask
 * before continuing without one. A runtime that does not let the owner
 * configure models shows no choice.
 */
export function SetupAiStep({
  location,
  onLocationChange,
  chatModelId,
  onChatModelChange,
  onChatReadyChange,
  credentialsController,
  onKeyPendingChange,
  onKeyBusyChange,
  onSetUpLater,
}: {
  location: SetupModelLocation;
  onLocationChange: (location: SetupModelLocation) => void;
  chatModelId: string | null;
  onChatModelChange: (id: string | null) => void;
  /**
   * Whether the model Animas will chat with (the choice, else the system
   * default) can reply; true while that is not yet known.
   */
  onChatReadyChange: (ready: boolean) => void;
  credentialsController: Ref<DesktopCredentialsController>;
  onKeyPendingChange: (count: number) => void;
  onKeyBusyChange: (busy: boolean) => void;
  /** Leaves the step without a model ("Set up later"). */
  onSetUpLater: () => void;
}) {
  const { t } = useTranslation("setup");
  const capabilities = useRuntimeCapabilities();
  const managedKeys = useDesktopCredentialsAvailable();
  const { modelConfiguration } = modelSettingsAvailability(capabilities.data);

  // Keys are typed in the OpenAI and Anthropic key panels and in connect
  // forms, one per provider tab (all stay mounted). The step reports them to
  // setup as one source, so leaving with any unsaved asks first, and any save
  // counts as busy.
  const panels: Record<SetupBuiltinProvider, KeyPanel> = {
    openai: useKeyPanel(),
    anthropic: useKeyPanel(),
  };
  const forms = useConnectFormKeys();
  const pending =
    panels.openai.pending + panels.anthropic.pending + forms.dirtyCount;
  const busy = panels.openai.busy || panels.anthropic.busy || forms.saving;
  useEffect(() => onKeyPendingChange(pending), [onKeyPendingChange, pending]);
  useEffect(() => onKeyBusyChange(busy), [busy, onKeyBusyChange]);
  useImperativeHandle(credentialsController, () => ({
    save: async () => {
      for (const panel of Object.values(panels))
        if (panel.pending > 0 && !(await panel.ref.current?.save()))
          return false;
      return forms.save();
    },
    discard: () => {
      for (const panel of Object.values(panels)) panel.ref.current?.discard();
      forms.discard();
    },
  }));

  /** A built-in provider's desktop key field; null on web. */
  const keyField = (provider: SetupBuiltinProvider) =>
    managedKeys ? (
      <DesktopCredentialsPanel
        providers={[provider]}
        showTitle={false}
        description={t("keys.storedDescription")}
        className="bg-transparent p-3"
        controllerRef={panels[provider].ref}
        onPendingChange={panels[provider].setPending}
        onBusyChange={panels[provider].setBusy}
      />
    ) : null;

  if (capabilities.isPending)
    return (
      <p className="text-muted-foreground text-sm" role="status">
        {t("ai.checking")}
      </p>
    );
  if (capabilities.isError)
    return (
      <p className="text-muted-foreground text-sm" role="status">
        {t("ai.loadFailed")}
      </p>
    );
  if (!modelConfiguration)
    return (
      <div className="space-y-4">
        <p className="text-muted-foreground text-sm">
          {t("ai.providedModels")}
        </p>
        {keyField("openai")}
      </div>
    );
  return (
    <ModelChooser
      location={location}
      onLocationChange={onLocationChange}
      chatModelId={chatModelId}
      onChatModelChange={onChatModelChange}
      onChatReadyChange={onChatReadyChange}
      managedKeys={managedKeys}
      keyField={keyField}
      connectFormKeys={forms.keysFor}
      onSetUpLater={onSetUpLater}
    />
  );
}

/** A built-in provider's key panel: its controller and unsaved or saving state. */
type KeyPanel = {
  ref: RefObject<DesktopCredentialsController | null>;
  pending: number;
  setPending: (count: number) => void;
  busy: boolean;
  setBusy: (busy: boolean) => void;
};

function useKeyPanel(): KeyPanel {
  const ref = useRef<DesktopCredentialsController>(null);
  const [pending, setPending] = useState(0);
  const [busy, setBusy] = useState(false);
  return { ref, pending, setPending, busy, setBusy };
}

/** How an inline connect form reports its typed key to the step. */
type ConnectFormKeys = {
  controllerRef: Ref<DesktopCredentialsController>;
  onKeyDirtyChange: (dirty: boolean) => void;
  onSavingChange: (saving: boolean) => void;
};

/** A copy of `set` with `id` in or out; the same set when nothing changes. */
function toggled(
  set: ReadonlySet<string>,
  id: string,
  on: boolean,
): ReadonlySet<string> {
  if (set.has(id) === on) return set;
  const next = new Set(set);
  if (on) next.add(id);
  else next.delete(id);
  return next;
}

/**
 * Key tracking for several connect forms, keyed by provider tab. Each form
 * gets stable callbacks (so its effects do not re-run every render), and the
 * step can save or discard every typed key at once.
 */
function useConnectFormKeys() {
  const [controllers] = useState(
    () => new Map<string, RefObject<DesktopCredentialsController | null>>(),
  );
  const [keys] = useState(() => new Map<string, ConnectFormKeys>());
  const [dirty, setDirty] = useState<ReadonlySet<string>>(() => new Set());
  const [saving, setSaving] = useState<ReadonlySet<string>>(() => new Set());
  return {
    keysFor: (id: string): ConnectFormKeys => {
      let entry = keys.get(id);
      if (!entry) {
        const controllerRef: RefObject<DesktopCredentialsController | null> = {
          current: null,
        };
        controllers.set(id, controllerRef);
        entry = {
          controllerRef,
          onKeyDirtyChange: (on) => setDirty((set) => toggled(set, id, on)),
          onSavingChange: (on) => setSaving((set) => toggled(set, id, on)),
        };
        keys.set(id, entry);
      }
      return entry;
    },
    dirtyCount: dirty.size,
    saving: saving.size > 0,
    /** Connect every form holding a typed key; false at the first failure. */
    save: async () => {
      for (const id of dirty)
        if (!(await controllers.get(id)?.current?.save())) return false;
      return true;
    },
    discard: () => {
      for (const controller of controllers.values())
        controller.current?.discard();
    },
  };
}

const BASE_URL_PLACEHOLDER: Record<SetupModelLocation, string> = {
  cloud: "https://api.example.com/v1",
  local: "http://127.0.0.1:8080/v1",
};

function ModelChooser({
  location,
  onLocationChange,
  chatModelId,
  onChatModelChange,
  onChatReadyChange,
  managedKeys,
  keyField,
  connectFormKeys,
  onSetUpLater,
}: {
  location: SetupModelLocation;
  onLocationChange: (location: SetupModelLocation) => void;
  chatModelId: string | null;
  onChatModelChange: (id: string | null) => void;
  onChatReadyChange: (ready: boolean) => void;
  managedKeys: boolean;
  /** A built-in provider's desktop key field (null on web). */
  keyField: (provider: SetupBuiltinProvider) => ReactNode;
  connectFormKeys: (providerId: string) => ConnectFormKeys;
  onSetUpLater: () => void;
}) {
  const { t } = useTranslation("setup");
  const { t: tModels } = useTranslation("models");
  const headingPrefix = useId();
  const connections = useModelConnections(true);
  const providers = useModelProviders();
  const roles = useModelRoles(true);
  const presets = useModelConnectionPresets(true);
  const [adder, setAdder] = useState<ModelAdder | null>(null);
  const [editing, setEditing] = useState<PyModelConnection | null>(null);
  const { startRemoval, dialog: removalDialog } = useModelRemoval(managedKeys);
  // The owner's provider tab per location; unset opens the default one.
  const [providerTab, setProviderTab] = useState<
    Partial<Record<SetupModelLocation, string>>
  >({});

  const allConnections = connections.data ?? [];
  const locations = visibleModelLocations(allConnections);
  // A hidden location (Local behind its flag, or saved in the draft) shows Cloud.
  const shownLocation = locations.includes(location) ? location : "cloud";
  const items = providers.data ?? [];
  const systemDefaultId = roles.data?.roles.find(
    (role) => role.role === "chat",
  )?.model_provider_id;
  const builtins = setupBuiltins(items, allConnections, systemDefaultId);
  const choices: Record<SetupModelLocation, SetupModelChoice[]> = {
    cloud: ownerModelChoices(items, allConnections, "cloud"),
    local: ownerModelChoices(items, allConnections, "local"),
  };
  // Only judge a choice against settled lists, never mid-refetch.
  const settled =
    connections.isSuccess &&
    providers.isSuccess &&
    roles.isFetched &&
    !connections.isFetching &&
    !providers.isFetching;
  // Built-in chat models a new model may copy, as in App Settings → Models.
  const templates = allConnections
    .filter((connection) => connection.source === "builtin")
    .flatMap((connection) => connection.models ?? [])
    .filter(
      (model) => model.source === "builtin" && model.model_kind === "chat",
    );

  useChooseWhenReady(connections.isSuccess, builtins.openai, onChatModelChange);
  useChooseWhenReady(
    connections.isSuccess,
    builtins.anthropic,
    onChatModelChange,
  );
  // Signing in with a ChatGPT plan here chooses one of its models the same way,
  // once the catalog lists them.
  const plan = setupChatGPTPlan(items, allConnections, systemDefaultId);
  useChooseWhenReady(connections.isSuccess, plan, onChatModelChange);

  // A choice that is no longer offered (removed, or its key removed) is dropped.
  const offered =
    chatModelId === null ||
    plan.modelId === chatModelId ||
    Object.values(builtins).some(
      (builtin) => builtin.modelId === chatModelId,
    ) ||
    [...choices.cloud, ...choices.local].some(
      (item) => item.id === chatModelId,
    );
  useEffect(() => {
    if (settled && !offered) onChatModelChange(null);
  }, [offered, onChatModelChange, settled]);

  // Like a choice, readiness is judged only from settled lists; until then,
  // and when the default model could not be read, setup has nothing to warn
  // about.
  const chatReady =
    !settled ||
    !roles.isSuccess ||
    setupChatModelReady(items, allConnections, chatModelId ?? systemDefaultId);
  useEffect(() => onChatReadyChange(chatReady), [chatReady, onChatReadyChange]);

  const presetById = (id: string) =>
    presets.data?.find((preset) => preset.id === id);
  const openAdder = (next: ModelAdder) => setAdder(next);
  // A mistyped address or key is fixed or removed here, as in App Settings.
  const rowActions: ConnectionRowActions = {
    canEdit: presets.isSuccess,
    onEdit: setEditing,
    onRemove: (connection) =>
      startRemoval({ kind: "connection", connection, usage: null }),
  };

  // Setup offers the ChatGPT plan sign-in as one of its choices (spec P8).
  const chatgptPlan = useChatGPTPlanAvailable();
  const groups = {
    cloud: locationProviderGroups(
      allConnections,
      "cloud",
      undefined,
      chatgptPlan,
    ),
    local: locationProviderGroups(allConnections, "local"),
  };
  const activeProvider = (where: SetupModelLocation) =>
    defaultLocationProvider(groups[where], providerTab[where]);

  /** Show a new connection's provider tab and add its first model. */
  const connected = (saved: PyModelConnection) => {
    // A custom server lands on the location its address implies.
    const where = connectionLocation(saved);
    if (where !== shownLocation) onLocationChange(where);
    setProviderTab((current) => ({
      ...current,
      [where]: connectionProviderEntry(saved).id,
    }));
    openAdder({ connection: saved });
  };

  if (connections.isError || providers.isError)
    return (
      <p className="text-muted-foreground text-sm" role="status">
        {t("ai.loadFailed")}
      </p>
    );

  /**
   * One provider's panel: a built-in provider (OpenAI, Anthropic) with its
   * key, another cloud provider, or a local server.
   */
  const providerPanel = (
    where: SetupModelLocation,
    entry: ModelProviderEntry,
  ) => {
    const items =
      groups[where].find((group) => group.entry.id === entry.id)?.connections ??
      [];
    const builtin = Object.values(builtins).find(
      (candidate) => candidate.provider === entry.presetId,
    );
    if (builtin) {
      const headingId = `${headingPrefix}-${builtin.provider}`;
      const name = modelProviderLabel(entry);
      const env =
        builtinConnectionKey({ source: "builtin", preset: builtin.provider })
          ?.env ?? "";
      // OpenAI's tab offers both ways to use its models: the ChatGPT plan's
      // sign-in card, then the API key under its own heading.
      const offersPlan = entry.id === "openai" && chatgptPlan;
      const keySection = (
        <section
          aria-labelledby={headingId}
          className="border-border/60 space-y-2 rounded-xl border p-4"
        >
          <h3 id={headingId} className="text-sm font-semibold">
            {offersPlan ? tModels("connections.apiKey.title") : name}
          </h3>
          {offersPlan ? (
            // The size of the plan card's description beside it.
            <p className="text-muted-foreground text-sm">
              {tModels("connections.apiKey.description")}
            </p>
          ) : (
            <p className="text-muted-foreground text-xs">
              {modelProviderPurpose(entry)}
            </p>
          )}
          {managedKeys ? (
            keyField(builtin.provider)
          ) : (
            <p className="text-muted-foreground text-xs">
              {builtin.ready
                ? t("ai.builtin.serverKey", { name })
                : t("ai.builtin.serverKeyMissing", { name, env })}
            </p>
          )}
        </section>
      );
      if (!offersPlan) return keySection;
      return (
        <>
          <p className="text-muted-foreground text-xs">
            {modelProviderPurpose(entry, true)}
          </p>
          <ChatGPTPlanCard headingLevel={3} />
          {keySection}
        </>
      );
    }
    if (where === "local" && entry.presetId !== "custom")
      return (
        <LocalServer
          entry={entry}
          active={
            shownLocation === "local" && activeProvider("local") === entry.id
          }
          connections={allConnections}
          serverConnections={items}
          presetById={presetById}
          onAddModel={openAdder}
          rowActions={rowActions}
          onSetUpLater={onSetUpLater}
          hasLocalModel={choices.local.length > 0}
        />
      );
    return (
      <ConnectProvider
        entry={entry}
        location={where}
        connections={items}
        preset={presetById(entry.presetId)}
        managedKeys={managedKeys}
        keys={connectFormKeys(entry.id)}
        onConnected={connected}
        onAddModel={(connection) => openAdder({ connection })}
        rowActions={rowActions}
      />
    );
  };

  return (
    <div className="space-y-5">
      <Tabs
        value={shownLocation}
        onValueChange={(value) => onLocationChange(value as SetupModelLocation)}
      >
        <ModelLocationTabsList locations={locations} active={shownLocation} />
        {/* Every location and provider panel stays mounted, so a typed key
            or open form survives a tab switch. */}
        {locations.map((where) => (
          <TabsContent
            key={where}
            value={where}
            forceMount
            className="mt-4 data-[state=inactive]:hidden"
          >
            <Tabs
              value={activeProvider(where)}
              onValueChange={(value) =>
                setProviderTab((current) => ({ ...current, [where]: value }))
              }
            >
              <ModelProviderTabsList
                groups={groups[where]}
                active={activeProvider(where)}
                label={t("ai.providerTabs", {
                  location: modelLocationLabel(where),
                })}
                showRecommended
              />
              {groups[where].map(({ entry }) => (
                <TabsContent
                  key={entry.id}
                  value={entry.id}
                  forceMount
                  className="mt-4 space-y-4 data-[state=inactive]:hidden"
                >
                  {providerPanel(where, entry)}
                </TabsContent>
              ))}
            </Tabs>
          </TabsContent>
        ))}
      </Tabs>
      {adder ? (
        <OwnerModelDialog
          open
          onOpenChange={(open) => !open && setAdder(null)}
          connection={adder.connection}
          initialModelId={adder.initialModelId}
          templates={templates}
          onAdded={(model) => {
            if (canChat(model)) onChatModelChange(model.id);
          }}
        />
      ) : null}
      {editing ? (
        <ModelConnectionDialog
          open
          onOpenChange={(open) => !open && setEditing(null)}
          presets={connectionEditPresets(editing, presets.data ?? [])}
          connection={editing}
          managedKeys={managedKeys}
        />
      ) : null}
      {removalDialog}
    </div>
  );
}

/**
 * A cloud provider other than OpenAI, or a custom server: its connections
 * with an Add model action, then its connect form when not yet connected
 * (Custom: "Add a custom server"). Connecting opens the add-model dialog
 * (with OpenRouter's searchable list).
 */
function ConnectProvider({
  entry,
  location,
  connections,
  preset,
  managedKeys,
  keys,
  onConnected,
  onAddModel,
  rowActions,
}: {
  entry: ModelProviderEntry;
  location: SetupModelLocation;
  connections: readonly PyModelConnection[];
  preset: PyModelConnectionPreset | undefined;
  managedKeys: boolean;
  keys: ConnectFormKeys;
  onConnected: (connection: PyModelConnection) => void;
  onAddModel: (connection: PyModelConnection) => void;
  rowActions: ConnectionRowActions;
}) {
  const { t } = useTranslation("setup");
  const custom = entry.presetId === "custom";
  const [addingCustom, setAddingCustom] = useState(false);
  const formOpen = custom ? addingCustom : connections.length === 0;
  return (
    <>
      <p className="text-muted-foreground text-xs">
        {modelProviderPurpose(entry)}
      </p>
      {connections.map((connection) => (
        <ConnectionRow
          key={connection.id}
          connection={connection}
          detail={
            location === "local"
              ? baseUrlHost(connection.base_url)
              : custom
                ? t("ai.connectionDetail", {
                    host: baseUrlHost(connection.base_url),
                    status: connectionStatusText(connection),
                  })
                : connectionStatusText(connection)
          }
          onAddModel={() => onAddModel(connection)}
          actions={rowActions}
        />
      ))}
      {custom && !addingCustom ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!preset}
          onClick={() => setAddingCustom(true)}
        >
          <Plus className="size-4" aria-hidden />
          {t("ai.addCustomServer")}
        </Button>
      ) : null}
      {formOpen && preset ? (
        <div className="border-border/60 rounded-xl border p-4">
          <ModelConnectionForm
            presets={[preset]}
            managedKeys={managedKeys}
            {...keys}
            baseUrlPlaceholder={BASE_URL_PLACEHOLDER[location]}
            onSaved={(saved) => {
              setAddingCustom(false);
              onConnected(saved);
            }}
            footer={({ saving, valid }) => (
              <div className="flex justify-end gap-2">
                {custom ? (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={saving}
                    onClick={() => setAddingCustom(false)}
                  >
                    {t("actions.cancel")}
                  </Button>
                ) : null}
                <Button type="submit" disabled={!valid || saving}>
                  {saving ? t("ai.connecting") : t("ai.connect")}
                </Button>
              </div>
            )}
          />
        </div>
      ) : null}
    </>
  );
}

/** Edit and Remove for a connection row, as App Settings → Models offers. */
type ConnectionRowActions = {
  /** The server types to edit with have loaded. */
  canEdit: boolean;
  onEdit: (connection: PyModelConnection) => void;
  onRemove: (connection: PyModelConnection) => void;
};

/**
 * A connected provider or server with its status, Edit and Remove, and an
 * Add model action.
 */
function ConnectionRow({
  connection,
  detail,
  onAddModel,
  actions,
}: {
  connection: PyModelConnection;
  detail: string;
  onAddModel: () => void;
  actions: ConnectionRowActions;
}) {
  const { t } = useTranslation("setup");
  const { t: tModels } = useTranslation("models");
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="min-w-0">
        <p className="text-sm">{connection.name}</p>
        <p className="text-muted-foreground truncate text-xs">{detail}</p>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={!actions.canEdit}
          aria-label={tModels("connections.editNamed", {
            name: connection.name,
          })}
          onClick={() => actions.onEdit(connection)}
        >
          {tModels("actions.edit")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label={tModels("connections.removeNamed", {
            name: connection.name,
          })}
          onClick={() => actions.onRemove(connection)}
        >
          {tModels("actions.remove")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-label={t("ai.addModelTo", { name: connection.name })}
          onClick={onAddModel}
        >
          <Plus className="size-4" aria-hidden />
          {t("ai.addModel")}
        </Button>
      </div>
    </div>
  );
}

type Detection =
  | { state: "idle" | "searching" }
  | { state: "done"; found: PyModelConnectionDetection | null };

/**
 * One local server type: looks for it at its default address when its tab
 * first opens, then lists the running server's models to add. With nothing
 * running and no connection to it, it gives install guidance and "Set up
 * later".
 */
/** Local server presets that search only when asked. */
const MANUAL_DETECT_PRESETS = new Set(["vllm"]);

function LocalServer({
  entry,
  active,
  connections,
  serverConnections,
  presetById,
  onAddModel,
  rowActions,
  onSetUpLater,
  hasLocalModel,
}: {
  entry: ModelProviderEntry;
  /** Its tab is showing. */
  active: boolean;
  connections: readonly PyModelConnection[];
  /** The owner's connections of this server type. */
  serverConnections: readonly PyModelConnection[];
  presetById: (id: string) => PyModelConnectionPreset | undefined;
  onAddModel: (adder: ModelAdder) => void;
  rowActions: ConnectionRowActions;
  onSetUpLater: () => void;
  /** A local model is already available, so "Set up later" is unnecessary. */
  hasLocalModel: boolean;
}) {
  const { t } = useTranslation("setup");
  const detect = useDetectModelServer();
  const create = useCreateModelConnection();
  const [detection, setDetection] = useState<Detection>({ state: "idle" });
  const [adding, setAdding] = useState<string | null>(null);
  const preset = presetById(entry.presetId);
  const label = modelProviderLabel(entry);

  const search = async () => {
    setDetection({ state: "searching" });
    try {
      const result = await detect.mutateAsync({ presetId: entry.presetId });
      setDetection({ state: "done", found: result.reachable ? result : null });
    } catch {
      setDetection({ state: "done", found: null });
    }
  };
  // vLLM's default port (8000) is commonly used by other development
  // servers, so it is searched only on request.
  const shouldSearch =
    active &&
    detection.state === "idle" &&
    !MANUAL_DETECT_PRESETS.has(entry.presetId);
  useEffect(() => {
    if (shouldSearch) void search();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- search once when first shown
  }, [shouldSearch]);

  const found = detection.state === "done" ? detection.found : null;

  /** Connect to the server if needed, then add the model in the dialog. */
  const addDetected = async (
    server: PyModelConnectionDetection,
    model: string,
  ) => {
    let connection = connectionForDetection(server, connections);
    setAdding(model);
    try {
      connection ??= await create.mutateAsync({
        name: preset?.label ?? label,
        preset: server.preset,
        base_url: server.base_url,
        credential: { mode: "none" },
        compatibility: preset?.compatibility ?? null,
        timeout_seconds: preset?.timeout_seconds ?? null,
      });
      onAddModel({ connection, initialModelId: model });
    } catch (error) {
      toast.error(modelConfigurationErrorMessage(error));
    } finally {
      setAdding(null);
    }
  };

  const others = serverConnections.filter(
    (connection) =>
      !found || connectionForDetection(found, [connection]) === undefined,
  );
  const toAdd = found ? detectedModelsToAdd(found, connections) : [];
  const nothing =
    detection.state === "done" && !found && serverConnections.length === 0;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground text-xs">
          {modelProviderPurpose(entry)}
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={detection.state === "searching"}
          onClick={() => void search()}
        >
          {detection.state === "searching"
            ? t("ai.local.searching")
            : detection.state === "idle"
              ? t("ai.local.search")
              : t("ai.local.searchAgain")}
        </Button>
      </div>
      <p className="text-muted-foreground text-xs" role="status">
        {detection.state === "searching"
          ? t("ai.local.lookingFor", { server: label })
          : found
            ? detectionMessage(found, label)
            : ""}
      </p>
      {found ? (
        <section
          aria-label={label}
          className="border-border/60 space-y-2 rounded-xl border p-4"
        >
          <div>
            <h3 className="text-sm font-semibold">{label}</h3>
            <p className="text-muted-foreground text-xs">
              {t("ai.local.runningAt", { host: baseUrlHost(found.base_url) })}
            </p>
          </div>
          {toAdd.length ? (
            <ul className="divide-border/60 divide-y">
              {toAdd.map((model) => (
                <li
                  key={model}
                  className="flex flex-wrap items-center justify-between gap-2 py-1.5"
                >
                  <span className="min-w-0 truncate text-sm">{model}</span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={adding !== null}
                    aria-label={t("ai.local.addNamed", { model })}
                    onClick={() => void addDetected(found, model)}
                  >
                    {adding === model
                      ? t("ai.local.adding")
                      : t("ai.local.add")}
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground text-xs">
              {found.models.length
                ? t("ai.local.allAdded")
                : t("ai.local.noModels", { server: label })}
            </p>
          )}
        </section>
      ) : null}
      {others.map((connection) => (
        <ConnectionRow
          key={connection.id}
          connection={connection}
          detail={baseUrlHost(connection.base_url)}
          onAddModel={() => onAddModel({ connection })}
          actions={rowActions}
        />
      ))}
      {nothing ? (
        <div className="space-y-2">
          <p className="text-sm">{t("ai.local.notFound", { server: label })}</p>
          {hasLocalModel ? null : (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="-ml-2"
              onClick={onSetUpLater}
            >
              {t("ai.local.setUpLater")}
            </Button>
          )}
        </div>
      ) : null}
    </>
  );
}
