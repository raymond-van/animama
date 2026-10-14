/// <reference lib="webworker" />

import type { ParticleVFXColourTransform } from "../lib/avatar/particle-vfx/editor/colourPixels";
import {
  ParticleVFXTextureSurfaceUnavailable,
  recolourParticleVFXTexture,
  sampleParticleVFXTexture,
} from "../lib/avatar/particle-vfx/editor/textureRecolour";

/** One texture job: measure its colour, or recolour it as a PNG. */
export type ParticleTextureWorkerRequest =
  | { id: number; task: "sample"; blob: Blob }
  | {
      id: number;
      task: "recolour";
      blob: Blob;
      transform: ParticleVFXColourTransform;
    };

export type ParticleTextureWorkerResponse =
  | {
      id: number;
      ok: true;
      sample?: { width: number; height: number; data: Uint8ClampedArray };
      blob?: Blob;
    }
  | {
      id: number;
      ok: false;
      message: string;
      /** This worker cannot draw; the main thread should do the job. */
      unsupported: boolean;
    };

const scope = self as DedicatedWorkerGlobalScope;

scope.addEventListener(
  "message",
  (event: MessageEvent<ParticleTextureWorkerRequest>) => {
    void run(event.data);
  },
);

/**
 * Decode, recolour and encode off the main thread, so a 2048 px sprite
 * sheet does not stall the creator. Sample pixels are transferred.
 */
async function run(request: ParticleTextureWorkerRequest): Promise<void> {
  try {
    if (request.task === "sample") {
      const sample = await sampleParticleVFXTexture(request.blob);
      scope.postMessage(
        {
          id: request.id,
          ok: true,
          sample,
        } satisfies ParticleTextureWorkerResponse,
        [sample.data.buffer],
      );
      return;
    }
    const blob = await recolourParticleVFXTexture(
      request.blob,
      request.transform,
    );
    scope.postMessage({
      id: request.id,
      ok: true,
      blob,
    } satisfies ParticleTextureWorkerResponse);
  } catch (error) {
    scope.postMessage({
      id: request.id,
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : "The texture could not be recoloured.",
      unsupported: error instanceof ParticleVFXTextureSurfaceUnavailable,
    } satisfies ParticleTextureWorkerResponse);
  }
}

export {};
