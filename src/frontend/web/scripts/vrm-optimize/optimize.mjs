import sharp from "sharp";

import {
  BinaryBuilder,
  COMPONENT_SIZE,
  TYPE_COMPONENTS,
  denseAccessorBytes,
  readGlb,
  viewBytes,
  writeGlb,
} from "./glb.mjs";

/**
 * Size optimization for VRM 1.0 files Animama ships. It only re-encodes image
 * bytes, stores morph targets sparsely and optionally replaces the licence
 * meta. It never prunes, merges, reorders or quantizes anything: every morph
 * target is addressable by name in Animama, and face-part corrections key
 * node, mesh and primitive positions.
 */

const COLOUR_WEBP = { quality: 90, alphaQuality: 100, effort: 6 };
const DATA_WEBP = { lossless: true, effort: 6 };
export const THUMBNAIL_MAX = 1024;
const THUMBNAIL_JPEG = { quality: 85, mozjpeg: true };

/** Extensions the optimizer can carry through untouched; anything else stops it. */
const SUPPORTED_EXTENSIONS = new Set([
  "VRMC_vrm",
  "VRMC_springBone",
  "VRMC_springBone_extended_collider",
  "VRMC_node_constraint",
  "VRMC_materials_mtoon",
  "VRMC_materials_hdr_emissiveMultiplier",
  "KHR_materials_unlit",
  "KHR_texture_transform",
  "KHR_materials_emissive_strength",
  "EXT_texture_webp",
  // Mochiya Avatar Tools' conversion record and authored lilToon materials,
  // and Animama Avatar Converter's conversion record. They are JSON that
  // points at textures by index, never into the binary, which
  // `assertSupported` checks, so new buffer storage cannot break them.
  "MOCHIYA_avatar_composition",
  "MOCHIYA_materials_liltoon",
  "ANIMAMA_avatar_conversion",
]);

/** Extensions carried only while nothing in them names a buffer view or accessor. */
const JSON_ONLY_EXTENSIONS = [
  "MOCHIYA_avatar_composition",
  "MOCHIYA_materials_liltoon",
  "ANIMAMA_avatar_conversion",
];

/**
 * lilToon texture properties whose pixels are colours; any other lilToon
 * texture (masks, normal, smoothness and metallic maps) is data.
 */
const LILTOON_COLOUR_SLOTS = new Set([
  "_MainTex",
  "_BaseMap",
  "_BaseColorMap",
  "_Main2ndTex",
  "_Main3rdTex",
  "_ShadowColorTex",
  "_Shadow2ndColorTex",
  "_Shadow3rdColorTex",
  "_EmissionMap",
  "_Emission2ndMap",
  "_MatCapTex",
  "_MatCap2ndTex",
  "_RimColorTex",
  "_ReflectionColorTex",
  "_BacklightColorTex",
  "_GlitterColorTex",
  "_OutlineTex",
]);

/** MToon texture slots whose pixels are colours; any other texture slot is data. */
const MTOON_COLOUR_SLOTS = new Set([
  "shadeMultiplyTexture",
  "matcapTexture",
  "rimMultiplyTexture",
]);

/** Image index of a texture, through EXT_texture_webp when it carries the source. */
export function textureImage(texture) {
  return texture.extensions?.EXT_texture_webp?.source ?? texture.source;
}

/** Classify each image as "colour" (lossy allowed) or "data" (lossless only). */
export function imageRoles(json) {
  const roles = new Map();
  const mark = (info, role) => {
    if (info?.index === undefined) return;
    const image = textureImage(json.textures[info.index]);
    if (image === undefined) return;
    if (roles.get(image) !== "data") roles.set(image, role);
  };
  for (const material of json.materials ?? []) {
    mark(material.pbrMetallicRoughness?.baseColorTexture, "colour");
    mark(material.emissiveTexture, "colour");
    mark(material.pbrMetallicRoughness?.metallicRoughnessTexture, "data");
    mark(material.normalTexture, "data");
    mark(material.occlusionTexture, "data");
    for (const [slot, info] of Object.entries(
      material.extensions?.VRMC_materials_mtoon ?? {},
    )) {
      if (slot.endsWith("Texture"))
        mark(info, MTOON_COLOUR_SLOTS.has(slot) ? "colour" : "data");
    }
    for (const [slot, info] of Object.entries(
      material.extensions?.MOCHIYA_materials_liltoon?.textures ?? {},
    )) {
      mark(info, LILTOON_COLOUR_SLOTS.has(slot) ? "colour" : "data");
    }
  }
  return roles;
}

/** Throw unless the file is a VRM 1.0 GLB whose extensions this tool preserves. */
function assertSupported(json) {
  if (!json.extensions?.VRMC_vrm) {
    throw new Error(
      "Only VRM 1.0 files are supported (no VRMC_vrm extension).",
    );
  }
  const unknown = [...extensionNames(json)].filter(
    (name) => !SUPPORTED_EXTENSIONS.has(name),
  );
  if (unknown.length) {
    throw new Error(`Unsupported glTF extensions: ${unknown.join(", ")}.`);
  }
  for (const name of JSON_ONLY_EXTENSIONS) {
    if (referencesBinary(extensionValues(json, name))) {
      throw new Error(
        `${name} references binary data, which the optimizer would move.`,
      );
    }
  }
  if (
    (json.buffers ?? []).length > 1 ||
    json.buffers?.[0]?.uri ||
    (json.images ?? []).some((image) => image.bufferView === undefined)
  ) {
    throw new Error(
      "Only self-contained GLB files with one buffer are supported.",
    );
  }
}

/** Every value stored under the named extension, wherever it appears. */
function extensionValues(json, name) {
  const values = [];
  const visit = (value) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") {
      if (value.extensions?.[name] !== undefined)
        values.push(value.extensions[name]);
      Object.values(value).forEach(visit);
    }
  };
  visit(json);
  return values;
}

/** Whether a value names a buffer view or accessor at any depth. */
function referencesBinary(value) {
  if (Array.isArray(value)) return value.some(referencesBinary);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, child]) =>
      key === "bufferView" || key === "accessor" || referencesBinary(child),
  );
}

/**
 * Every extension the document declares or uses anywhere, so an undeclared one
 * that might reference buffer views is refused too.
 */
function extensionNames(json) {
  const names = new Set(json.extensionsUsed ?? []);
  const visit = (value) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (key === "extensions" && child && typeof child === "object") {
          Object.keys(child).forEach((name) => names.add(name));
        }
        visit(child);
      }
    }
  };
  visit(json);
  return names;
}

function morphAccessorIndices(json) {
  const indices = new Set();
  for (const mesh of json.meshes ?? []) {
    for (const primitive of mesh.primitives) {
      for (const target of primitive.targets ?? []) {
        for (const accessor of Object.values(target)) indices.add(accessor);
      }
    }
  }
  return indices;
}

/**
 * The non-zero elements of a float morph-target accessor, or null when sparse
 * storage would not be smaller. -0 counts as zero; it renders identically.
 */
function sparseMorph(document, accessor) {
  if (accessor.sparse || accessor.componentType !== 5126 || accessor.normalized)
    return null;
  const components = TYPE_COMPONENTS[accessor.type];
  const floats = new Float32Array(
    denseAccessorBytes(document, accessor).buffer.slice(0),
  );
  const indices = [];
  for (let element = 0; element < accessor.count; element += 1) {
    for (let component = 0; component < components; component += 1) {
      if (floats[element * components + component] !== 0) {
        indices.push(element);
        break;
      }
    }
  }
  const indexType =
    accessor.count <= 0xff ? 5121 : accessor.count <= 0xffff ? 5123 : 5125;
  const elementSize = components * 4;
  const sparseSize = indices.length * (COMPONENT_SIZE[indexType] + elementSize);
  if (sparseSize >= accessor.count * elementSize) return null;
  const IndexArray = { 5121: Uint8Array, 5123: Uint16Array, 5125: Uint32Array }[
    indexType
  ];
  const values = new Float32Array(indices.length * components);
  indices.forEach((element, at) =>
    values.set(
      floats.subarray(element * components, (element + 1) * components),
      at * components,
    ),
  );
  return {
    count: indices.length,
    indexType,
    indices: Buffer.from(IndexArray.from(indices).buffer),
    values: Buffer.from(values.buffer),
  };
}

/** Decoded RGBA pixels, for checking that a data texture survives unchanged. */
export const rgbaPixels = (bytes) =>
  sharp(bytes).ensureAlpha().raw().toBuffer();

/**
 * Re-encode an image for its role. Lossless WebP still discards the colour
 * under fully transparent pixels, so a data texture whose pixels would change
 * keeps its original bytes (returns null).
 */
async function encodeImage(bytes, role) {
  if (role === "colour") return sharp(bytes).webp(COLOUR_WEBP).toBuffer();
  const encoded = await sharp(bytes).webp(DATA_WEBP).toBuffer();
  const [before, after] = await Promise.all([
    rgbaPixels(bytes),
    rgbaPixels(encoded),
  ]);
  return before.equals(after) ? encoded : null;
}

async function encodeThumbnail(bytes) {
  return sharp(bytes)
    .resize(THUMBNAIL_MAX, THUMBNAIL_MAX, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .flatten({ background: "#ffffff" })
    .jpeg(THUMBNAIL_JPEG)
    .toBuffer();
}

/**
 * Optimize a VRM 1.0 GLB. `meta`, when given, replaces `VRMC_vrm.meta` except
 * its `thumbnailImage`. Returns the new bytes and a per-part size report.
 */
export async function optimizeVrm(bytes, { meta } = {}) {
  const document = readGlb(bytes);
  const { json } = document;
  assertSupported(json);
  const vrmMeta = json.extensions.VRMC_vrm.meta;
  const thumbnail = vrmMeta.thumbnailImage;
  const report = { images: [], morphs: { sparse: 0, zeroFilled: 0, dense: 0 } };

  // Re-encode images; their buffer views are rewritten below.
  const roles = imageRoles(json);
  const replacedViews = new Map();
  const webpImages = new Set();
  for (const [index, image] of (json.images ?? []).entries()) {
    const source = viewBytes(document, image.bufferView);
    const role =
      index === thumbnail && !roles.has(index) ? "thumbnail" : roles.get(index);
    if (!role) continue;
    const encoded =
      role === "thumbnail"
        ? await encodeThumbnail(source)
        : await encodeImage(source, role);
    // An oversized thumbnail is always downscaled, even if its JPEG is larger.
    const { width = 0, height = 0 } =
      role === "thumbnail" ? await sharp(source).metadata() : {};
    const oversized = Math.max(width, height) > THUMBNAIL_MAX;
    const kept = !encoded || (!oversized && encoded.length >= source.length);
    report.images.push({
      index,
      name: image.name ?? "",
      role,
      before: source.length,
      after: kept ? source.length : encoded.length,
    });
    if (kept) continue;
    replacedViews.set(image.bufferView, encoded);
    image.mimeType = role === "thumbnail" ? "image/jpeg" : "image/webp";
    if (role !== "thumbnail") webpImages.add(index);
  }
  for (const texture of json.textures ?? []) {
    const image = textureImage(texture);
    if (!webpImages.has(image)) continue;
    // A texture that already carries EXT_texture_webp keeps its fallback source.
    if (texture.source === image) delete texture.source;
    texture.extensions = {
      ...texture.extensions,
      EXT_texture_webp: { source: image },
    };
  }
  if (webpImages.size) {
    for (const key of ["extensionsUsed", "extensionsRequired"]) {
      json[key] = [...new Set([...(json[key] ?? []), "EXT_texture_webp"])];
    }
  }

  // Decide sparse storage for morph targets before rebuilding the binary.
  const sparse = new Map();
  for (const index of morphAccessorIndices(json)) {
    const accessor = json.accessors[index];
    const result = sparseMorph(document, accessor);
    if (result) sparse.set(index, result);
    else report.morphs.dense += 1;
  }

  // Rebuild the binary chunk: keep referenced views in order, then add sparse data.
  const referenced = new Set();
  for (const [index, accessor] of json.accessors.entries()) {
    if (!sparse.has(index) && accessor.bufferView !== undefined)
      referenced.add(accessor.bufferView);
    if (accessor.sparse)
      referenced
        .add(accessor.sparse.indices.bufferView)
        .add(accessor.sparse.values.bufferView);
  }
  for (const image of json.images ?? []) referenced.add(image.bufferView);
  const builder = new BinaryBuilder();
  const remap = new Map();
  for (const [index, view] of json.bufferViews.entries()) {
    if (!referenced.has(index)) continue;
    const {
      buffer: _buffer,
      byteOffset: _offset,
      byteLength: _length,
      ...extra
    } = view;
    remap.set(
      index,
      builder.add(
        replacedViews.get(index) ?? viewBytes(document, index),
        extra,
      ),
    );
  }
  for (const [index, accessor] of json.accessors.entries()) {
    const result = sparse.get(index);
    if (result) {
      delete accessor.bufferView;
      delete accessor.byteOffset;
      if (result.count === 0) {
        report.morphs.zeroFilled += 1;
        continue;
      }
      report.morphs.sparse += 1;
      accessor.sparse = {
        count: result.count,
        indices: {
          bufferView: builder.add(result.indices),
          componentType: result.indexType,
        },
        values: { bufferView: builder.add(result.values) },
      };
      continue;
    }
    if (accessor.bufferView !== undefined)
      accessor.bufferView = remap.get(accessor.bufferView);
    if (accessor.sparse && !sparse.has(index)) {
      accessor.sparse.indices.bufferView = remap.get(
        accessor.sparse.indices.bufferView,
      );
      accessor.sparse.values.bufferView = remap.get(
        accessor.sparse.values.bufferView,
      );
    }
  }
  for (const image of json.images ?? [])
    image.bufferView = remap.get(image.bufferView);
  json.bufferViews = builder.views;
  const bin = builder.toBuffer();
  json.buffers = [{ byteLength: bin.length + (-bin.length & 3) }];

  if (meta) {
    json.extensions.VRMC_vrm.meta = { ...meta, thumbnailImage: thumbnail };
    if (thumbnail === undefined)
      delete json.extensions.VRMC_vrm.meta.thumbnailImage;
  }

  const output = writeGlb(json, bin);
  report.before = bytes.byteLength;
  report.after = output.length;
  return { bytes: output, report };
}
