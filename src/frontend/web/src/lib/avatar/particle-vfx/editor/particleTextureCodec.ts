/**
 * The colour theme's texture codec for the browser: a small worker decodes,
 * recolours and encodes (`textureRecolour.ts`), and the main thread does the
 * same work when there is no worker, the worker cannot start, or it has no
 * canvas for a texture that is not PNG. Results are kept per source Blob, so
 * going back to a theme reuses its copies instead of encoding them again.
 */
import type { ParticleVFXColourTransform } from "./colourPixels";
import { PARTICLE_VFX_EDITOR_TEXTURES } from "./constants";
import type { ParticleVFXTextureCodec } from "./simpleControls";
import {
  recolourParticleVFXTexture,
  sampleParticleVFXTexture,
} from "./textureRecolour";
import type {
  ParticleTextureWorkerRequest,
  ParticleTextureWorkerResponse,
} from "@/workers/particle-texture-worker";

/** A worker request before the codec numbers it. */
type JobRequest = ParticleTextureWorkerRequest extends infer Request
  ? Request extends unknown
    ? Omit<Request, "id">
    : never
  : never;

type Job = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  /** The same work on the main thread. */
  fallback: () => Promise<unknown>;
};

/** Create a codec; `dispose` stops its worker (the page owns one codec). */
export function createParticleVFXTextureCodec(): ParticleVFXTextureCodec & {
  dispose: () => void;
} {
  // undefined: not started yet; null: work on the main thread.
  let worker: Worker | null | undefined;
  let nextId = 1;
  const jobs = new Map<number, Job>();
  const samples = new WeakMap<
    Blob,
    ReturnType<ParticleVFXTextureCodec["sample"]>
  >();
  const recoloured = new WeakMap<Blob, Map<string, Promise<Blob>>>();

  /** Move every waiting job to the main thread and stop the worker. */
  const abandonWorker = () => {
    worker?.terminate();
    worker = null;
    const waiting = [...jobs.values()];
    jobs.clear();
    for (const job of waiting) job.fallback().then(job.resolve, job.reject);
  };

  const startWorker = (): Worker | null => {
    if (worker !== undefined) return worker;
    if (typeof Worker === "undefined") return (worker = null);
    try {
      worker = new Worker(
        new URL(
          "../../../../workers/particle-texture-worker.ts",
          import.meta.url,
        ),
        { type: "module" },
      );
    } catch {
      return (worker = null);
    }
    worker.addEventListener(
      "message",
      (event: MessageEvent<ParticleTextureWorkerResponse>) => {
        const response = event.data;
        const job = jobs.get(response.id);
        if (!job) return;
        jobs.delete(response.id);
        if (response.ok) job.resolve(response.sample ?? response.blob);
        else if (response.unsupported) {
          // This worker has no canvas for a texture that needs one.
          jobs.set(response.id, job);
          abandonWorker();
        } else job.reject(new Error(response.message));
      },
    );
    // The worker failed to load or crashed: finish its jobs here.
    worker.addEventListener("error", abandonWorker);
    return worker;
  };

  const run = <T>(
    request: JobRequest,
    fallback: () => Promise<T>,
  ): Promise<T> => {
    const target = startWorker();
    if (!target) return fallback();
    return new Promise<T>((resolve, reject) => {
      const id = nextId;
      nextId += 1;
      jobs.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        fallback,
      });
      target.postMessage({ ...request, id } as ParticleTextureWorkerRequest);
    });
  };

  /** Keep a pending or settled result, but forget a failure so it can retry. */
  const remember = <T>(promise: Promise<T>, forget: () => void) => {
    promise.catch(forget);
    return promise;
  };

  return {
    sample(blob) {
      const cached = samples.get(blob);
      if (cached) return cached;
      const promise = remember(
        run({ task: "sample", blob }, () => sampleParticleVFXTexture(blob)),
        () => samples.delete(blob),
      );
      samples.set(blob, promise);
      return promise;
    },
    recolour(blob, transform: ParticleVFXColourTransform) {
      const key = JSON.stringify(transform);
      let byTransform = recoloured.get(blob);
      if (!byTransform) {
        byTransform = new Map();
        recoloured.set(blob, byTransform);
      }
      const cached = byTransform.get(key);
      if (cached) return cached;
      const promise = remember(
        run({ task: "recolour", blob, transform }, () =>
          recolourParticleVFXTexture(blob, transform),
        ),
        () => byTransform.delete(key),
      );
      byTransform.set(key, promise);
      return promise;
    },
    dispose() {
      worker?.terminate();
      worker = null;
      for (const job of jobs.values())
        job.reject(new DOMException("The creator closed.", "AbortError"));
      jobs.clear();
    },
  };
}

/** Built-in texture bytes by path, fetched once per page. */
const builtInTextures = new Map<string, Promise<Blob>>();

/**
 * A built-in creator texture's bytes, fetched from the app as Save fetches
 * them, once per page so the codec's per-Blob results are reused; null for
 * a path that is not built in.
 */
export function fetchBuiltInParticleVFXTexture(
  reference: string,
): Promise<Blob | null> {
  const texture = PARTICLE_VFX_EDITOR_TEXTURES.find(
    ({ relativeUrl }) => relativeUrl === reference,
  );
  if (!texture) return Promise.resolve(null);
  const cached = builtInTextures.get(reference);
  if (cached) return cached;
  const loading = fetch(texture.publicUrl).then((response) => {
    if (!response.ok)
      throw new Error(
        `The built-in texture ${texture.fileName} could not be loaded.`,
      );
    return response.blob();
  });
  // A failed load is not kept, so choosing the theme again retries it.
  loading.catch(() => builtInTextures.delete(reference));
  builtInTextures.set(reference, loading);
  return loading;
}
