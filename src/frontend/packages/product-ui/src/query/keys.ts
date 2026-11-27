export const queryKeys = {
  runtimeCapabilities: (ownerId: string) =>
    ["runtime-capabilities", ownerId] as const,
  /** Hosted account usage and limits, from the composition's account actions. */
  accountUsage: (ownerId: string) => ["account-usage", ownerId] as const,
  crisisResources: (ownerId: string, locale: string) =>
    ["crisis-resources", ownerId, locale] as const,
  modelAssets: (ownerId: string) => ["model-assets", ownerId] as const,
  desktopFeaturePacks: (ownerId: string) =>
    ["desktop-feature-packs", ownerId] as const,
  animaCreation: {
    all: (userId: string) => ["anima-creation", userId] as const,
    options: (userId: string) =>
      [...queryKeys.animaCreation.all(userId), "options"] as const,
    list: (userId: string, kind: string) =>
      [...queryKeys.animaCreation.all(userId), "list", kind] as const,
    preview: (userId: string, kind: string, itemId: string, revision: string) =>
      [
        ...queryKeys.animaCreation.all(userId),
        "preview",
        kind,
        itemId,
        revision,
      ] as const,
    image: (userId: string, itemId: string, revision: string) =>
      [
        ...queryKeys.animaCreation.all(userId),
        "image",
        itemId,
        revision,
      ] as const,
  },
  userProfile: {
    all: (userId: string) => ["user-profile", userId] as const,
    current: (userId: string) =>
      [...queryKeys.userProfile.all(userId), "current"] as const,
  },
  particleEffects: {
    all: (userId: string) => ["particle-effects", userId] as const,
    list: (userId: string, query: string, origin: string, sort = "updated") =>
      [
        ...queryKeys.particleEffects.all(userId),
        "list",
        query,
        origin,
        sort,
      ] as const,
    detail: (userId: string, itemId: string) =>
      [...queryKeys.particleEffects.all(userId), "detail", itemId] as const,
  },
  soundEffects: {
    all: (userId: string) => ["sound-effects", userId] as const,
    list: (userId: string, query: string, origin: string, sort = "updated") =>
      [
        ...queryKeys.soundEffects.all(userId),
        "list",
        query,
        origin,
        sort,
      ] as const,
    detail: (userId: string, itemId: string) =>
      [...queryKeys.soundEffects.all(userId), "detail", itemId] as const,
  },
  avatarEffects: {
    all: (userId: string) => ["avatar-effects", userId] as const,
    list: (userId: string, query: string, origin: string, sort = "updated") =>
      [
        ...queryKeys.avatarEffects.all(userId),
        "list",
        query,
        origin,
        sort,
      ] as const,
    detail: (userId: string, itemId: string) =>
      [...queryKeys.avatarEffects.all(userId), "detail", itemId] as const,
  },
  sceneEffects: {
    all: (userId: string) => ["scene-effects", userId] as const,
    detail: (userId: string, itemId: string) =>
      [...queryKeys.sceneEffects.all(userId), "detail", itemId] as const,
  },
  actionComponentPreviews: {
    bundle: (userId: string, digest: string) =>
      ["action-component-previews", userId, "bundle", digest] as const,
  },
  poses: {
    all: (userId: string) => ["poses", userId] as const,
    list: (userId: string, query = "", origin = "all") =>
      [...queryKeys.poses.all(userId), "list", query, origin] as const,
    detail: (userId: string, itemId: string) =>
      [...queryKeys.poses.all(userId), "detail", itemId] as const,
    save: (userId: string) => [...queryKeys.poses.all(userId), "save"] as const,
  },
  voiceContent: {
    all: (ownerId: string) => ["voice-content", ownerId] as const,
    list: (ownerId: string) =>
      [...queryKeys.voiceContent.all(ownerId), "list"] as const,
  },
  gestures: {
    idlePlayback: (userId: string, itemId: string, revision: string) =>
      [
        ...queryKeys.gestures.all(userId),
        "idle-playback",
        itemId,
        revision,
      ] as const,
    all: (userId: string) => ["gestures", userId] as const,
    detail: (userId: string, itemId: string) =>
      [...queryKeys.gestures.all(userId), "detail", itemId] as const,
    list: (
      userId: string,
      query: string,
      origin: string,
      sort = "name",
      implementationKind = "all",
    ) =>
      [
        ...queryKeys.gestures.all(userId),
        "list",
        query,
        origin,
        sort,
        implementationKind,
      ] as const,
  },
  reactions: {
    all: (userId: string) => ["reactions", userId] as const,
    detail: (userId: string, itemId: string) =>
      [...queryKeys.reactions.all(userId), "detail", itemId] as const,
    list: (userId: string, query: string, origin: string, sort = "name") =>
      [
        ...queryKeys.reactions.all(userId),
        "list",
        query,
        origin,
        sort,
      ] as const,
  },
  appearanceImages: {
    all: (userId: string) => ["appearance-images", userId] as const,
    list: (userId: string) =>
      [...queryKeys.appearanceImages.all(userId), "list"] as const,
    preview: (userId: string, releaseId: string, use: string) =>
      [
        ...queryKeys.appearanceImages.all(userId),
        "preview",
        releaseId,
        use,
      ] as const,
  },
  animaLoadouts: {
    details: (userId: string) => ["anima-loadout", userId] as const,
    detail: (userId: string, animaId: string) =>
      [...queryKeys.animaLoadouts.details(userId), animaId] as const,
    runtimes: (userId: string) => ["anima-runtime", userId] as const,
    runtime: (userId: string, animaId: string) =>
      [...queryKeys.animaLoadouts.runtimes(userId), animaId] as const,
  },
  avatars: {
    all: (userId: string) => ["avatars", userId] as const,
    list: (userId: string, includePrivate: boolean) =>
      [...queryKeys.avatars.all(userId), "list", includePrivate] as const,
    releases: (userId: string, avatarId: string) =>
      [...queryKeys.avatars.all(userId), "releases", avatarId] as const,
    /** An Avatar's effective face part correction and revision. */
    faceParts: (userId: string, itemId: string) =>
      [...queryKeys.avatars.all(userId), "face-parts", itemId] as const,
    /** An Avatar's wind and material settings (local runtimes only). */
    settings: (userId: string, itemId: string) =>
      [...queryKeys.avatars.all(userId), "settings", itemId] as const,
    /** An Avatar item's preview files, for creator model previews. */
    preview: (userId: string, itemId: string) =>
      [...queryKeys.avatars.all(userId), "preview", itemId] as const,
  },
  avatarCatalog: {
    all: (userId: string) => ["avatar-catalog", userId] as const,
    list: (userId: string, query: string, origin: string, sort: string) =>
      ["avatar-catalog", userId, "list", query, origin, sort] as const,
  },
  modelProviders: {
    all: (userId: string) => ["model-providers", userId] as const,
  },
  /** Owner model connections, presets and role status (local composition). */
  modelConfiguration: {
    all: (userId: string) => ["model-configuration", userId] as const,
    presets: (userId: string) =>
      [...queryKeys.modelConfiguration.all(userId), "presets"] as const,
    connections: (userId: string) =>
      [...queryKeys.modelConfiguration.all(userId), "connections"] as const,
    roles: (userId: string) =>
      [...queryKeys.modelConfiguration.all(userId), "roles"] as const,
    /** Whether a connection's server answers a model listing (Local tab status). */
    reachability: (userId: string, connectionId: string) =>
      [
        ...queryKeys.modelConfiguration.all(userId),
        "reachability",
        connectionId,
      ] as const,
    /** OpenRouter's public model list for the add-model picker. */
    openRouterModels: (userId: string) =>
      [
        ...queryKeys.modelConfiguration.all(userId),
        "openrouter-models",
      ] as const,
    /** The installation's ChatGPT plan sign-in status (local composition). */
    chatgptPlan: (userId: string) =>
      [...queryKeys.modelConfiguration.all(userId), "chatgpt-plan"] as const,
  },
  /**
   * Desktop provider key availability and saved status (status only, never
   * values), shared by every panel that edits the vault.
   */
  desktopCredentials: {
    all: (ownerId: string) => ["desktop-credentials", ownerId] as const,
    available: (ownerId: string) =>
      [...queryKeys.desktopCredentials.all(ownerId), "available"] as const,
    statuses: (ownerId: string) =>
      [...queryKeys.desktopCredentials.all(ownerId), "statuses"] as const,
  },
  /** The installation's application web search backend (local composition). */
  webSearchSettings: (userId: string) =>
    ["web-search-settings", userId] as const,
  /** The content assistant's conversations and their drafts (local composition). */
  generation: {
    all: (userId: string) => ["generation", userId] as const,
    conversations: (userId: string) =>
      [...queryKeys.generation.all(userId), "conversations"] as const,
    conversation: (userId: string, conversationId: string) =>
      [
        ...queryKeys.generation.all(userId),
        "conversation",
        conversationId,
      ] as const,
  },
  /** The owner's automatic episode-processing setting and state (local composition). */
  automaticEpisodeProcessing: (userId: string) =>
    ["automatic-episode-processing", userId] as const,
  userFiles: {
    all: (userId: string) => ["user-files", userId] as const,
    list: (userId: string) =>
      [...queryKeys.userFiles.all(userId), "list"] as const,
  },
  /**
   * The bytes of one chat image, kept apart from `userFiles` so an upload's
   * list refresh does not refetch every image.
   */
  userFileImages: {
    file: (userId: string, fileId: string) =>
      ["user-file-images", userId, fileId] as const,
    variant: (
      userId: string,
      fileId: string,
      variant: "thumbnail" | "preview" | "original",
    ) => [...queryKeys.userFileImages.file(userId, fileId), variant] as const,
  },
  content: {
    sharingInventory: (owner: string) =>
      [...queryKeys.content.all(owner), "sharing-inventory"] as const,
    sharingSummary: (owner: string, selection: string) =>
      [...queryKeys.content.all(owner), "sharing-summary", selection] as const,
    all: (userId: string) => ["content", userId] as const,
    catalog: (userId: string) =>
      [...queryKeys.content.all(userId), "catalog"] as const,
  },
  memoryEntries: {
    all: (userId: string) => ["memory-entries", userId] as const,
    list: (
      userId: string,
      opts?: {
        animaId?: string | null;
        parentId?: string | null;
        recursive?: boolean;
      },
    ) =>
      [
        ...queryKeys.memoryEntries.all(userId),
        "list",
        opts?.animaId ?? "__user__",
        opts?.parentId ?? "__root__",
        opts?.recursive === true ? 1 : 0,
      ] as const,
    details: (userId: string) =>
      [...queryKeys.memoryEntries.all(userId), "detail"] as const,
    detail: (userId: string, entryId: string) =>
      [...queryKeys.memoryEntries.details(userId), entryId] as const,
    animaIdentities: (userId: string) =>
      [...queryKeys.memoryEntries.all(userId), "anima-identities"] as const,
    versions: (userId: string, entryId: string) =>
      [...queryKeys.memoryEntries.all(userId), "versions", entryId] as const,
    versionDetail: (userId: string, entryId: string, version: number) =>
      [
        ...queryKeys.memoryEntries.versions(userId, entryId),
        "detail",
        version,
      ] as const,
    byPath: (
      userId: string,
      opts: {
        animaId?: string | null;
        path: string;
        type?: "file" | "directory";
      },
    ) =>
      [
        ...queryKeys.memoryEntries.all(userId),
        "by-path",
        opts.animaId ?? "__user__",
        opts.path,
        opts.type ?? "file",
      ] as const,
  },
  memoryEpisodes: {
    all: (userId: string) => ["memory-episodes", userId] as const,
    list: (
      userId: string,
      opts?: {
        status?: "pending" | "processed" | null;
        limit?: number;
      },
    ) =>
      [
        ...queryKeys.memoryEpisodes.all(userId),
        "list",
        opts?.status ?? "__all__",
        opts?.limit ?? 100,
      ] as const,
  },
  memoryManager: {
    all: (userId: string) => ["memory-manager", userId] as const,
    current: (userId: string) =>
      [...queryKeys.memoryManager.all(userId), "current"] as const,
    run: (userId: string, runId: string) =>
      [...queryKeys.memoryManager.all(userId), "run", runId] as const,
  },
  settings: {
    all: (userId: string) => ["settings", userId] as const,
    user: (userId: string) =>
      [...queryKeys.settings.all(userId), "user"] as const,
    anima: (userId: string, animaId: string) =>
      [...queryKeys.settings.all(userId), "anima", animaId] as const,
  },
  animas: {
    all: (userId: string) => ["animas", userId] as const,
    list: (userId: string) =>
      [...queryKeys.animas.all(userId), "list"] as const,
    detail: (userId: string, id: string) =>
      [...queryKeys.animas.all(userId), "detail", id] as const,
  },
  chats: {
    all: (userId: string) => ["chats", userId] as const,
    detail: (userId: string, chatId: string) =>
      [...queryKeys.chats.all(userId), "detail", chatId] as const,
    list: (userId: string, opts?: { includeLastMessageAt?: boolean }) =>
      [
        ...queryKeys.chats.all(userId),
        "list",
        opts?.includeLastMessageAt === false ? 0 : 1,
      ] as const,
    messages: (userId: string, chatId: string) =>
      [...queryKeys.chats.all(userId), "messages", chatId] as const,
  },
} as const;
