/**
 * glTF extensions the Avatar loaders can load (`configureAvatarGltfLoader`):
 * three's GLTFLoader built-ins whose decoders Animama serves (meshopt, not
 * Draco or Basis), the VRM and VRM Animation plugins, and the extensions
 * Mochiya Avatar Tools and Animama Avatar Converter write into converted
 * Avatars. Package validation
 * (`content_package_capabilities.py` `_GLTF_EXTENSIONS`) accepts these and
 * `UNDECODED_GLTF_EXTENSIONS` (the shared `package-capabilities.json` fixture
 * pins both lists), so a shared Draco Avatar imports with a notice and is
 * reported as not loadable.
 */
export const LOADABLE_GLTF_EXTENSIONS: ReadonlySet<string> = new Set([
  // @pixiv/three-vrm and @pixiv/three-vrm-animation.
  "VRM",
  "VRMC_vrm",
  "VRMC_vrm_animation",
  "VRMC_springBone",
  "VRMC_springBone_extended_collider",
  "VRMC_materials_mtoon",
  "VRMC_materials_hdr_emissiveMultiplier",
  "VRMC_node_constraint",
  // three's GLTFLoader built-ins.
  "KHR_lights_punctual",
  "KHR_materials_anisotropy",
  "KHR_materials_clearcoat",
  "KHR_materials_dispersion",
  "KHR_materials_emissive_strength",
  "KHR_materials_ior",
  "KHR_materials_iridescence",
  "KHR_materials_sheen",
  "KHR_materials_specular",
  "KHR_materials_transmission",
  "KHR_materials_unlit",
  "KHR_materials_volume",
  "KHR_mesh_quantization",
  "KHR_texture_transform",
  "EXT_materials_bump",
  "EXT_mesh_gpu_instancing",
  "EXT_meshopt_compression",
  "EXT_texture_avif",
  "EXT_texture_webp",
  // Mochiya Avatar Tools: authored lilToon materials (with glTF fallbacks)
  // and the conversion marker the spring settings read.
  "MOCHIYA_avatar_composition",
  "MOCHIYA_materials_liltoon",
  // Animama Avatar Converter's marker on MMD (PMX) conversions, which the
  // spring settings read like Mochiya's.
  "ANIMAMA_avatar_conversion",
]);

/**
 * Compression whose decoder the runtime does not serve yet (its WebAssembly
 * would be a new runtime asset). three's loader fails on Draco wherever a
 * file uses it, even beside uncompressed fallbacks, so it counts when only
 * used.
 */
export const UNDECODED_GLTF_EXTENSIONS: ReadonlySet<string> = new Set([
  "KHR_draco_mesh_compression",
]);

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/**
 * The extensions that keep a glTF document from loading in Animama, each
 * once: every required extension the runtime cannot load, and Draco wherever
 * it is used. Empty for a file the loaders can load. Accepts a parsed glTF
 * JSON document or an Avatar's file facts.
 */
export function unloadableGltfExtensions(json: {
  readonly extensionsUsed?: unknown;
  readonly extensionsRequired?: unknown;
}): string[] {
  const unloadable = new Set(
    strings(json.extensionsRequired).filter(
      (name) => !LOADABLE_GLTF_EXTENSIONS.has(name),
    ),
  );
  for (const name of strings(json.extensionsUsed)) {
    if (UNDECODED_GLTF_EXTENSIONS.has(name)) unloadable.add(name);
  }
  return [...unloadable];
}
