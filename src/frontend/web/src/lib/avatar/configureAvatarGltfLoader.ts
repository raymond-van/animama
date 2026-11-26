import type {
  GLTFLoader,
  GLTFLoaderPlugin,
  GLTFParser,
} from "three/examples/jsm/loaders/GLTFLoader.js";

import { unloadableGltfExtensions } from "./diagnostics/avatarGltfExtensions";
import { HumanoidBoneRepairPlugin } from "./humanoidBoneRepair";
import { PrimitiveTargetNamesPlugin } from "./primitiveTargetNames";

type MeshoptDecoder = NonNullable<GLTFParser["options"]["meshoptDecoder"]>;

let meshoptDecoder: Promise<MeshoptDecoder> | null = null;

/**
 * three's meshopt decoder, imported and compiled on first use. Its
 * WebAssembly compiles as soon as the module is evaluated, which a page
 * whose CSP lacks `'wasm-unsafe-eval'` (the landing site) refuses even when
 * it never decodes a file. A failed import or compile is not cached.
 */
function loadMeshoptDecoder(): Promise<MeshoptDecoder> {
  meshoptDecoder ??= import("three/examples/jsm/libs/meshopt_decoder.module.js")
    .then(async ({ MeshoptDecoder }) => {
      await MeshoptDecoder.ready;
      return MeshoptDecoder;
    })
    .catch((error: unknown) => {
      meshoptDecoder = null;
      throw error;
    });
  return meshoptDecoder;
}

/** Whether a glTF document uses or requires `name`. */
function mentions(json: Record<string, unknown>, name: string): boolean {
  return ["extensionsUsed", "extensionsRequired"].some((field) => {
    const names = json[field];
    return Array.isArray(names) && names.includes(name);
  });
}

const prepared = new WeakMap<GLTFParser, Promise<void>>();

/**
 * Prepares each file once before three parses it: fails a file that needs an
 * extension the runtime cannot load, naming it (three's loader only warns
 * about an unknown required extension and draws the file without it; a
 * missing decoder such as Draco's fails inside three already), and gives a
 * meshopt-compressed file the decoder. three reads the decoder from the
 * parser's options when it loads each buffer view, after every plugin's
 * `beforeRoot`; a plugin that reads buffers in its own `beforeRoot` awaits
 * this first.
 */
export function prepareAvatarFile(parser: GLTFParser): Promise<void> {
  let preparation = prepared.get(parser);
  if (!preparation) {
    preparation = (async () => {
      const json = parser.json as Record<string, unknown>;
      const unloadable = unloadableGltfExtensions(json);
      if (unloadable.length > 0)
        throw new Error(
          `The file requires glTF extensions Animama cannot load: ${unloadable.join(", ")}`,
        );
      if (mentions(json, "EXT_meshopt_compression"))
        parser.options.meshoptDecoder = await loadMeshoptDecoder();
    })();
    prepared.set(parser, preparation);
  }
  return preparation;
}

/** Runs `prepareAvatarFile` as the first plugin's `beforeRoot`. */
class AvatarExtensionsPlugin implements GLTFLoaderPlugin {
  readonly name = "ANIMAMA_avatar_extensions";

  private readonly parser: GLTFParser;

  constructor(parser: GLTFParser) {
    this.parser = parser;
  }

  beforeRoot(): Promise<void> {
    return prepareAvatarFile(this.parser);
  }
}

/**
 * Give a glTF loader what every Avatar loader shares: the meshopt decoder for
 * files that use it (its WebAssembly is embedded, so no runtime asset is
 * served), a clear failure for a file whose extensions the runtime cannot
 * load (`LOADABLE_GLTF_EXTENSIONS`), morph-target names stored only per
 * primitive (`PrimitiveTargetNamesPlugin`), and a humanoid mapping repaired
 * where it names bones that move nothing (`HumanoidBoneRepairPlugin`), so the
 * app and every tool that loads an Avatar see the same names and bones.
 * Diagnostics reports these from the file's facts
 * (`avatar_extension_unsupported`, `morph_target_names_mismatched`,
 * `humanoid_bones_remapped`, `humanoid_bones_unweighted`). Register this
 * before other plugins. Returns the loader.
 */
export function configureAvatarGltfLoader(loader: GLTFLoader): GLTFLoader {
  loader.register((parser) => new AvatarExtensionsPlugin(parser));
  loader.register((parser) => new PrimitiveTargetNamesPlugin(parser));
  loader.register(
    (parser) =>
      new HumanoidBoneRepairPlugin(parser, () => prepareAvatarFile(parser)),
  );
  return loader;
}
