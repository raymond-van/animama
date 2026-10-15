import * as THREE from "three";

import type { Avatar } from "../Avatar";
import {
  PARTICLE_VFX_ROOT_OBJECT_NAME,
  applyParticleVFXRectangleShapeAutoFit,
  resolveParticleVFXAvatarBoundsRectangleFit,
} from "./autoFit";
import {
  createParticleVFXEffectContainer,
  createParticleVFXEmitterAnchorBindings,
  updateParticleVFXEmitterAnchors,
  type ParticleVFXEmitterAnchorBindings,
} from "./emitterAnchors";
import { createParticleVFXBatchedRenderer } from "./batchedRenderer";
import { cloneParticleVFXPrefab } from "./quarksClone";
import {
  alignParticleVFXRootToAvatar,
  cloneParticleVFXTransform,
  mergeParticleVFXTransform,
  resolveParticleVFXAnchorLocalPosition,
} from "./runtime";
import {
  EMPTY_RUNTIME_MEDIA_PROVIDER,
  type AnimaRuntimeMediaProvider,
} from "@/lib/runtime-content/AnimaRuntimeMediaCatalog";
import type {
  ParticleVFXAnchor,
  ParticleVFXControllerSnapshot,
  ParticleVFXPlayRequest,
  ParticleVFXPerformanceBudget,
  ParticleVFXPreloadResult,
  ParticleVFXPreloadTier,
  ParticleVFXResolvedAnchor,
  ParticleVFXRuntimeLifetime,
  ParticleVFXRuntimeInstance,
  ParticleVFXRuntimeInstanceSnapshot,
} from "./types";

type ThreeQuarksModule = typeof import("three.quarks");
type BatchedRendererInstance = InstanceType<
  ThreeQuarksModule["BatchedRenderer"]
>;
type QuarksParticleSystem = Parameters<
  BatchedRendererInstance["deleteSystem"]
>[0] & {
  dispose?: () => void;
  instancingGeometry?: THREE.BufferGeometry;
  material?: THREE.Material;
  worldSpace?: boolean;
};
type DisposableQuarksBatch = THREE.Object3D & {
  dispose?: () => void;
  material?: THREE.Material | THREE.Material[];
};

const MAX_WARNING_COUNT = 8;
const MAX_ACTIVE_PARTICLE_EFFECTS = 4;
const MAX_ACTIVE_PARTICLES = 512;

/**
 * Runtime host for avatar-bound three.quarks particle effects.
 *
 * The controller is intentionally plain Three.js rather than React Three Fiber:
 * Avatar owns the lifecycle, and active particle objects live under
 * `avatar.scene` so existing avatar transform controls move them together.
 * Their root is turned into the Avatar frame (see
 * `alignParticleVFXRootToAvatar`), so effects face the same way on VRM 0 and
 * VRM 1 Avatars.
 */
export class ParticleVFXController {
  private readonly _avatar: Avatar;
  private readonly _catalogProvider: AnimaRuntimeMediaProvider;
  /**
   * Parent of every active effect. Its rotation is owned by
   * `alignParticleVFXRootToAvatar` (the Avatar frame); do not reset it.
   */
  private readonly _root = new THREE.Group();
  private readonly _prefabPromises = new Map<string, Promise<THREE.Object3D>>();
  private readonly _loadedPrefabs = new Map<string, THREE.Object3D>();
  private readonly _loadedEffectIds = new Set<string>();
  private readonly _activeInstances = new Map<
    string,
    ParticleVFXRuntimeInstance
  >();
  private readonly _emitterAnchors = new Map<
    string,
    ParticleVFXEmitterAnchorBindings
  >();
  private readonly _requestVersions = new Map<string, number>();
  private readonly _pendingAppliedIds = new Set<string>();
  private readonly _pendingReservations = new Map<
    string,
    Pick<ParticleVFXPerformanceBudget, "canCoexist" | "maxParticles">
  >();
  private _quarksPromise: Promise<ThreeQuarksModule> | null = null;
  private _quarks: ThreeQuarksModule | null = null;
  private _batchRenderer: BatchedRendererInstance | null = null;
  private _snapshot: ParticleVFXControllerSnapshot;
  private _warnings: string[] = [];
  private _lastError: string | null = null;
  private _isDisposed = false;

  constructor(
    avatar: Avatar,
    catalogProvider: AnimaRuntimeMediaProvider = EMPTY_RUNTIME_MEDIA_PROVIDER,
  ) {
    this._avatar = avatar;
    this._catalogProvider = catalogProvider;
    this._root.name = PARTICLE_VFX_ROOT_OBJECT_NAME;
    this._root.userData.animamaParticleVFXRoot = true;
    this._root.matrixAutoUpdate = true;
    alignParticleVFXRootToAvatar(this._root, avatar);
    avatar.scene?.add(this._root);
    this._snapshot = this._createSnapshot();
  }

  getSnapshot(): ParticleVFXControllerSnapshot {
    return this._snapshot;
  }

  async preloadEffect(effectId: string): Promise<boolean> {
    if (this._isDisposed) return false;

    const effect = await this._catalogProvider.resolveParticleVFX(effectId);
    if (!effect) {
      this._pushWarning(`Unknown particle VFX effect "${effectId}".`);
      return false;
    }

    try {
      await this._loadPrefab(effect.id, effect.assetPath);
      if (this._isDisposed) return false;
      this._lastError = null;
      this._emit();
      return true;
    } catch (error) {
      if (this._isDisposed) return false;
      this._lastError = error instanceof Error ? error.message : String(error);
      this._pushWarning(
        `Particle VFX "${effect.id}" failed to preload: ${this._lastError}`,
      );
      return false;
    }
  }

  async preloadCatalogTier(
    preloadTier: ParticleVFXPreloadTier,
    options: { concurrency?: number } = {},
  ): Promise<ParticleVFXPreloadResult> {
    if (this._isDisposed) {
      return { requestedCount: 0, loadedCount: 0, failedCount: 0 };
    }

    const effectIds = this._catalogProvider.getParticlePreloadIds(preloadTier);
    const concurrency = Math.max(1, Math.floor(options.concurrency ?? 2));
    let loadedCount = 0;
    let failedCount = 0;
    let index = 0;

    const workers = Array.from(
      { length: Math.min(concurrency, effectIds.length) },
      async () => {
        while (index < effectIds.length && !this._isDisposed) {
          const effectId = effectIds[index];
          index += 1;
          if (await this.preloadEffect(effectId)) {
            loadedCount += 1;
          } else {
            failedCount += 1;
          }
        }
      },
    );

    await Promise.all(workers);
    return {
      requestedCount: effectIds.length,
      loadedCount,
      failedCount,
    };
  }

  async playEffect(request: ParticleVFXPlayRequest): Promise<boolean> {
    if (this._isDisposed || request.signal?.aborted) return false;

    const effect = await this._catalogProvider.resolveParticleVFX(
      request.effectId,
    );
    if (this._isDisposed || request.signal?.aborted) return false;
    if (!effect) {
      this._pushWarning(`Unknown particle VFX effect "${request.effectId}".`);
      return false;
    }

    const appliedId = request.appliedId?.trim() || effect.id;
    const lifetimeRequest = request.lifetime;
    let lifetime: ParticleVFXRuntimeLifetime;
    let durationWasCapped = false;
    if (lifetimeRequest?.kind === "manual") {
      if (!effect.performanceBudget.loopingAllowed) {
        this._pushWarning(
          `Particle VFX "${effect.id}" cannot use manual lifetime because its catalog budget does not allow looping.`,
        );
        return false;
      }
      lifetime = { kind: "manual" };
    } else {
      const requestedDurationSec =
        lifetimeRequest?.kind === "duration" &&
        typeof lifetimeRequest.durationSec === "number" &&
        Number.isFinite(lifetimeRequest.durationSec)
          ? Math.max(0.05, lifetimeRequest.durationSec)
          : typeof request.durationSec === "number" &&
              Number.isFinite(request.durationSec)
            ? Math.max(0.05, request.durationSec)
            : effect.defaultDurationSec;
      const durationSec = Math.max(
        0.05,
        Math.min(requestedDurationSec, effect.performanceBudget.maxDurationSec),
      );
      lifetime = { kind: "duration", durationSec };
      durationWasCapped = durationSec < requestedDurationSec;
    }

    const otherActiveInstances = Array.from(
      this._activeInstances.entries(),
    ).flatMap(([activeId, instance]) =>
      activeId === appliedId ? [] : [instance],
    );
    const otherPendingReservations = Array.from(
      this._pendingReservations.entries(),
    ).flatMap(([pendingId, reservation]) =>
      pendingId === appliedId ? [] : [reservation],
    );
    const hasExclusiveEffect = [
      ...otherActiveInstances.map(
        (instance) => instance.effect.performanceBudget,
      ),
      ...otherPendingReservations,
    ].some((budget) => !budget.canCoexist);
    const clearsConflicts =
      !effect.performanceBudget.canCoexist || hasExclusiveEffect;
    if (clearsConflicts) {
      this.clearAll();
    } else if (
      otherActiveInstances.length + otherPendingReservations.length >=
      MAX_ACTIVE_PARTICLE_EFFECTS
    ) {
      this._pushWarning("Particle VFX concurrency limit reached.");
      return false;
    }
    const activeParticleBudget = clearsConflicts
      ? 0
      : [
          ...otherActiveInstances.map(
            (instance) => instance.effect.performanceBudget,
          ),
          ...otherPendingReservations,
        ].reduce((total, budget) => total + budget.maxParticles, 0);
    if (
      activeParticleBudget + effect.performanceBudget.maxParticles >
      MAX_ACTIVE_PARTICLES
    ) {
      this._pushWarning("Particle VFX active-particle budget reached.");
      return false;
    }
    const anchor = request.anchor ?? effect.defaultAnchor;
    const transform = mergeParticleVFXTransform(
      effect.defaultTransform,
      request.transform,
    );
    const fallbackResolvedAnchor = this._resolveAnchor(anchor, transform);
    if (!fallbackResolvedAnchor) {
      this._pushWarning(
        `Particle VFX "${effect.id}" could not resolve a host.`,
      );
      return false;
    }
    const autoFitResult = resolveParticleVFXAvatarBoundsRectangleFit({
      avatar: this._avatar,
      transform,
      shapeAutoFit: effect.shapeAutoFit,
    });
    if (autoFitResult.warning) {
      this._pushWarning(
        `Particle VFX "${effect.id}": ${autoFitResult.warning}`,
      );
    }

    this.clearEffect(appliedId);
    const requestVersion = this._bumpRequestVersion(appliedId);
    this._pendingAppliedIds.add(appliedId);
    this._pendingReservations.set(appliedId, {
      canCoexist: effect.performanceBudget.canCoexist,
      maxParticles: effect.performanceBudget.maxParticles,
    });

    let object: THREE.Object3D | null = null;
    try {
      const quarks = await this._ensureQuarks();
      const batchRenderer = this._batchRenderer;
      if (
        !batchRenderer ||
        request.signal?.aborted ||
        !this._isCurrentRequest(appliedId, requestVersion)
      ) {
        return false;
      }

      const prefab = await this._loadPrefab(effect.id, effect.assetPath);
      if (
        request.signal?.aborted ||
        !this._isCurrentRequest(appliedId, requestVersion)
      )
        return false;

      object = createParticleVFXEffectContainer(cloneParticleVFXPrefab(prefab));
      object.name = `ParticleVFX:${effect.id}:${appliedId}`;
      object.frustumCulled = false;
      object.traverse((child) => {
        child.frustumCulled = false;
      });
      const resolvedAnchor = fallbackResolvedAnchor;
      const autoFitPlacement = autoFitResult.fit;
      if (autoFitPlacement) {
        const patchedCount = applyParticleVFXRectangleShapeAutoFit({
          object,
          shapeAutoFit: effect.shapeAutoFit,
          width: autoFitPlacement.width,
          height: autoFitPlacement.height,
        });
        if (patchedCount === 0) {
          this._pushWarning(
            `Particle VFX "${effect.id}" requested avatar-bounds rectangle auto-fit, but no matching rectangle emitters were found; using anchor placement.`,
          );
        }
      }
      const emitterAnchors = createParticleVFXEmitterAnchorBindings(object);
      applyInitialInstanceTransform(object, resolvedAnchor, transform);
      this._root.add(object);
      for (const warning of updateParticleVFXEmitterAnchors({
        bindings: emitterAnchors,
        avatar: this._avatar,
        defaultAnchor: anchor,
      })) {
        this._pushWarning(warning);
      }

      quarks.QuarksUtil.addToBatchRenderer(object, batchRenderer);
      quarks.QuarksUtil.setAutoDestroy(object, false);
      quarks.QuarksUtil.play(object);

      const usesWorldSpace = this._usesWorldSpaceParticleSystems(object);
      const requestedFollowAnchor =
        request.followAnchor ?? effect.defaultFollowAnchor;
      const followAnchor = requestedFollowAnchor && !usesWorldSpace;
      this._emitterAnchors.set(appliedId, emitterAnchors);
      this._activeInstances.set(appliedId, {
        appliedId,
        ownerId: request.ownerId ?? null,
        effect,
        anchor,
        lifetime,
        durationSec: lifetime.kind === "duration" ? lifetime.durationSec : null,
        elapsedSec: 0,
        transform,
        followAnchor,
        usesWorldSpace,
        object,
        resolvedAnchor,
      });
      this._lastError = null;
      if (resolvedAnchor.warning) {
        this._pushWarning(resolvedAnchor.warning);
      }
      if (usesWorldSpace && requestedFollowAnchor) {
        this._pushWarning(
          `Particle VFX "${effect.id}" uses world-space emitters, so continuous anchor follow is disabled for this instance.`,
        );
      }
      if (durationWasCapped) {
        const durationSec =
          lifetime.kind === "duration" ? lifetime.durationSec : 0;
        this._pushWarning(
          `Particle VFX "${effect.id}" duration was capped at ${durationSec.toFixed(2)}s by its catalog budget.`,
        );
      }
      if (
        !resolvedAnchor.warning &&
        (!usesWorldSpace || !requestedFollowAnchor) &&
        !durationWasCapped
      ) {
        this._emit();
      }
      return true;
    } catch (error) {
      if (object) {
        this._safeRemoveObject(object);
      }
      if (
        request.signal?.aborted ||
        !this._isCurrentRequest(appliedId, requestVersion)
      )
        return false;
      this._lastError = error instanceof Error ? error.message : String(error);
      this._pushWarning(
        `Particle VFX "${effect.id}" failed to play: ${this._lastError}`,
      );
      return false;
    } finally {
      if (this._requestVersions.get(appliedId) === requestVersion) {
        this._pendingAppliedIds.delete(appliedId);
        this._pendingReservations.delete(appliedId);
      }
    }
  }

  clearEffect(appliedId: string): boolean {
    if (this._isDisposed) return false;
    this._bumpRequestVersion(appliedId);
    this._pendingAppliedIds.delete(appliedId);
    this._pendingReservations.delete(appliedId);
    const instance = this._activeInstances.get(appliedId);
    if (!instance) return false;

    this._removeInstance(instance);
    this._activeInstances.delete(appliedId);
    this._emit();
    return true;
  }

  clearAll(): void {
    if (this._isDisposed) return;
    for (const appliedId of this._pendingAppliedIds) {
      this._bumpRequestVersion(appliedId);
    }
    this._pendingAppliedIds.clear();
    this._pendingReservations.clear();
    for (const instance of this._activeInstances.values()) {
      this._removeInstance(instance);
    }
    this._activeInstances.clear();
    this._emit();
  }

  update(deltaSec: number): void {
    if (this._isDisposed || !Number.isFinite(deltaSec) || deltaSec < 0) return;

    const expiredIds: string[] = [];
    for (const instance of this._activeInstances.values()) {
      instance.elapsedSec += deltaSec;
      if (instance.followAnchor) {
        const resolvedAnchor = this._resolveAnchor(
          instance.anchor,
          instance.transform,
        );
        if (resolvedAnchor) {
          instance.resolvedAnchor = resolvedAnchor;
          applyInstancePosition(instance.object, resolvedAnchor);
          const bindings = this._emitterAnchors.get(instance.appliedId);
          if (bindings)
            updateParticleVFXEmitterAnchors({
              bindings,
              avatar: this._avatar,
              defaultAnchor: instance.anchor,
            });
        }
      }
      if (
        instance.lifetime.kind === "duration" &&
        instance.elapsedSec >= instance.lifetime.durationSec
      ) {
        expiredIds.push(instance.appliedId);
      }
    }

    this._batchRenderer?.update(deltaSec);

    for (const appliedId of expiredIds) {
      this.clearEffect(appliedId);
    }
    if (this._activeInstances.size > 0 || expiredIds.length > 0) {
      this._emit();
    }
  }

  dispose(): void {
    if (this._isDisposed) return;
    this.clearAll();
    this._isDisposed = true;
    this._disposeBatchRenderer();
    this._disposeLoadedPrefabs();
    this._root.parent?.remove(this._root);
    this._prefabPromises.clear();
    this._loadedPrefabs.clear();
    this._loadedEffectIds.clear();
    this._requestVersions.clear();
    this._pendingAppliedIds.clear();
    this._pendingReservations.clear();
    this._warnings = [];
    this._lastError = null;
    this._snapshot = this._createSnapshot();
  }

  private _bumpRequestVersion(appliedId: string): number {
    const nextVersion = (this._requestVersions.get(appliedId) ?? 0) + 1;
    this._requestVersions.set(appliedId, nextVersion);
    return nextVersion;
  }

  private _isCurrentRequest(appliedId: string, version: number): boolean {
    return (
      !this._isDisposed && this._requestVersions.get(appliedId) === version
    );
  }

  private async _ensureQuarks(): Promise<ThreeQuarksModule> {
    if (this._quarks) return this._quarks;
    if (!this._quarksPromise) {
      this._quarksPromise = import("three.quarks");
    }
    const quarks = await this._quarksPromise;
    this._quarks = quarks;
    if (this._isDisposed) return quarks;
    if (!this._batchRenderer) {
      this._batchRenderer = createParticleVFXBatchedRenderer(quarks);
      this._batchRenderer.name = "AnimamaParticleVFXBatchedRenderer";
      this._root.add(this._batchRenderer);
    }
    return quarks;
  }

  private _loadPrefab(
    effectId: string,
    assetPath: string,
  ): Promise<THREE.Object3D> {
    const existing = this._prefabPromises.get(effectId);
    if (existing) return existing;

    const promise = this._ensureQuarks()
      .then(
        (quarks) =>
          new Promise<THREE.Object3D>((resolve, reject) => {
            const loader = new quarks.QuarksLoader();
            loader.load(
              assetPath,
              (object) => {
                object.name = object.name || `ParticleVFXPrefab:${effectId}`;
                if (this._isDisposed) {
                  this._disposePrefabParticleSystemResources(object);
                  disposeObjectTree(object);
                  resolve(object);
                  return;
                }
                this._loadedPrefabs.set(effectId, object);
                this._loadedEffectIds.add(effectId);
                this._emit();
                resolve(object);
              },
              undefined,
              (error) => {
                reject(error);
              },
            );
          }),
      )
      .catch((error) => {
        this._prefabPromises.delete(effectId);
        throw error;
      });
    this._prefabPromises.set(effectId, promise);
    return promise;
  }

  private _resolveAnchor(
    anchor: ParticleVFXAnchor,
    transform: ParticleVFXRuntimeInstance["transform"],
  ): ParticleVFXResolvedAnchor | null {
    return resolveParticleVFXAnchorLocalPosition({
      avatar: this._avatar,
      anchor,
      transform,
    });
  }

  private _removeInstance(instance: ParticleVFXRuntimeInstance): void {
    this._emitterAnchors.delete(instance.appliedId);
    this._safeRemoveObject(instance.object);
  }

  private _safeRemoveObject(object: THREE.Object3D): void {
    try {
      this._removeObject(object);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this._pushWarning(`Particle VFX cleanup failed: ${message}`);
    }
  }

  private _removeObject(object: THREE.Object3D): void {
    const quarks = this._quarks;
    if (quarks) {
      try {
        quarks.QuarksUtil.stop(object);
      } catch {
        // Continue cleanup even if a malformed effect cannot be stopped cleanly.
      }
      for (const system of this._collectParticleSystems(object)) {
        if (typeof system.dispose === "function") {
          system.dispose();
        } else {
          this._batchRenderer?.deleteSystem(system);
        }
      }
    }
    object.parent?.remove(object);
  }

  private _collectParticleSystems(
    object: THREE.Object3D,
  ): QuarksParticleSystem[] {
    const quarks = this._quarks;
    if (!quarks) return [];

    const systems = new Set<QuarksParticleSystem>();
    quarks.QuarksUtil.runOnAllParticleEmitters(object, (emitter) => {
      systems.add(emitter.system as QuarksParticleSystem);
    });
    return Array.from(systems);
  }

  private _usesWorldSpaceParticleSystems(object: THREE.Object3D): boolean {
    return this._collectParticleSystems(object).some(
      (system) => system.worldSpace === true,
    );
  }

  private _disposeBatchRenderer(): void {
    const batchRenderer = this._batchRenderer;
    if (!batchRenderer) return;

    const batches =
      (batchRenderer as unknown as { batches?: DisposableQuarksBatch[] })
        .batches ?? [];
    for (const batch of batches) {
      try {
        batch.dispose?.();
      } catch {
        // Disposing the avatar should continue even if an individual batch fails.
      }
      disposeMaterial(batch.material);
      batch.parent?.remove(batch);
    }
    batchRenderer.parent?.remove(batchRenderer);
    this._batchRenderer = null;
  }

  private _disposeLoadedPrefabs(): void {
    for (const prefab of this._loadedPrefabs.values()) {
      this._disposePrefabParticleSystemResources(prefab);
      disposeObjectTree(prefab);
    }
  }

  private _disposePrefabParticleSystemResources(prefab: THREE.Object3D): void {
    const systems = this._collectParticleSystems(prefab);
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();

    for (const system of systems) {
      if (system.instancingGeometry) geometries.add(system.instancingGeometry);
      collectMaterials(system.material, materials);
      system.dispose?.();
    }
    for (const geometry of geometries) {
      geometry.dispose();
    }
    for (const material of materials) {
      disposeMaterial(material);
    }
  }

  private _createSnapshot(): ParticleVFXControllerSnapshot {
    const activeInstances: ParticleVFXRuntimeInstanceSnapshot[] = Array.from(
      this._activeInstances.values(),
    )
      .map((instance) => ({
        appliedId: instance.appliedId,
        ownerId: instance.ownerId,
        effectId: instance.effect.id,
        effectLabel: instance.effect.label,
        assetPath: instance.effect.assetPath,
        anchor: instance.anchor,
        resolvedAnchor: instance.resolvedAnchor.resolvedAnchor,
        boneName: instance.resolvedAnchor.boneName,
        lifetime: { ...instance.lifetime },
        durationSec: instance.durationSec,
        elapsedSec: instance.elapsedSec,
        followAnchor: instance.followAnchor,
        usesWorldSpace: instance.usesWorldSpace,
        transform: cloneParticleVFXTransform(instance.transform),
      }))
      .sort((left, right) => left.appliedId.localeCompare(right.appliedId));

    return {
      catalog: this._catalogProvider.listParticleVFX(),
      activeInstances,
      activeCount: activeInstances.length,
      loadedEffectIds: Array.from(this._loadedEffectIds).sort(),
      loadedCount: this._loadedEffectIds.size,
      warnings: [...this._warnings],
      lastError: this._lastError,
    };
  }

  private _pushWarning(message: string): void {
    const trimmed = message.trim();
    if (!trimmed) return;
    this._warnings = Array.from(new Set([...this._warnings, trimmed])).slice(
      -MAX_WARNING_COUNT,
    );
    this._emit();
  }

  private _emit(): void {
    this._snapshot = this._createSnapshot();
  }
}

function disposeObjectTree(object: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();

  object.traverse((child) => {
    const maybeGeometry = (child as { geometry?: THREE.BufferGeometry })
      .geometry;
    if (maybeGeometry) geometries.add(maybeGeometry);

    collectMaterials(
      (child as { material?: THREE.Material | THREE.Material[] }).material,
      materials,
    );
  });

  for (const geometry of geometries) {
    geometry.dispose();
  }
  for (const material of materials) {
    disposeMaterial(material);
  }
}

function collectMaterials(
  material: THREE.Material | THREE.Material[] | null | undefined,
  materials: Set<THREE.Material>,
): void {
  if (!material) return;
  if (Array.isArray(material)) {
    for (const item of material) materials.add(item);
    return;
  }
  materials.add(material);
}

function disposeMaterial(
  material: THREE.Material | THREE.Material[] | null | undefined,
): void {
  if (!material) return;
  const materials = Array.isArray(material) ? material : [material];
  const textures = new Set<THREE.Texture>();

  for (const item of materials) {
    for (const value of Object.values(item)) {
      if (value instanceof THREE.Texture) {
        textures.add(value);
      } else {
        const maybeTexture = value as {
          isTexture?: boolean;
          dispose?: () => void;
        };
        if (
          maybeTexture?.isTexture &&
          typeof maybeTexture.dispose === "function"
        ) {
          textures.add(maybeTexture as THREE.Texture);
        }
      }
    }
    item.dispose();
  }
  for (const texture of textures) {
    texture.dispose();
  }
}

function applyInitialInstanceTransform(
  object: THREE.Object3D,
  resolvedAnchor: ParticleVFXResolvedAnchor,
  transform: ParticleVFXRuntimeInstance["transform"],
): void {
  applyInstancePosition(object, resolvedAnchor);
  object.rotation.set(
    object.rotation.x + transform.rotation.x,
    object.rotation.y + transform.rotation.y,
    object.rotation.z + transform.rotation.z,
  );
  object.scale.set(transform.scale.x, transform.scale.y, transform.scale.z);
  object.updateMatrixWorld(true);
}

function applyInstancePosition(
  object: THREE.Object3D,
  resolvedAnchor: ParticleVFXResolvedAnchor,
): void {
  object.position.set(
    resolvedAnchor.position.x,
    resolvedAnchor.position.y,
    resolvedAnchor.position.z,
  );
  object.updateMatrixWorld(true);
}
