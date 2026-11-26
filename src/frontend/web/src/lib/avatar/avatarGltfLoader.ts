import { VRMLoaderPlugin } from "@pixiv/three-vrm";
import { VRMAnimationLoaderPlugin } from "@pixiv/three-vrm-animation";
import type * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

import { configureAvatarGltfLoader } from "./configureAvatarGltfLoader";
import { withEnhancedMToonPatch } from "./enhanced-rendering/mtoonPatch";
import { withOnDemandLilToon } from "./liltoon/lilToon";
import { UnmetallicMaterialsPlugin } from "./unmetallicMaterials";
import { withUnlitToonShading } from "./unlitToonShading";

/**
 * The glTF loader for Avatar VRM and VRMA files, with the shared decoders and
 * extension check (`configureAvatarGltfLoader`). With `lilToon` false, a
 * file's authored lilToon materials load as their glTF fallbacks (the Simple
 * material setting) and three-liltoon is never imported. With `unlitToon`
 * false, a file whose materials all ignore light keeps them unlit instead of
 * gaining toon shading (`unlitToonShading.ts`); a file has only one of the
 * two kinds, but Automatic can turn lilToon off for a slow GPU while keeping
 * the far cheaper toon shading.
 */
export function createAvatarGltfLoader({
  manager,
  lilToon = true,
  unlitToon = true,
}: {
  manager?: THREE.LoadingManager;
  lilToon?: boolean;
  unlitToon?: boolean;
} = {}): GLTFLoader {
  const loader = configureAvatarGltfLoader(new GLTFLoader(manager));
  loader.register((parser) => {
    const plugin = new VRMLoaderPlugin(parser);
    // lilToon is imported only for files that declare authored lilToon materials.
    // The unlit step wraps the enhanced retune so it runs after it: the
    // retune then sees only the file's own MToon, never the toon look added
    // to unlit materials.
    return withUnlitToonShading(
      withEnhancedMToonPatch(lilToon ? withOnDemandLilToon(plugin) : plugin),
      unlitToon,
    );
  });
  loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
  loader.register((parser) => new UnmetallicMaterialsPlugin(parser));
  return loader;
}
