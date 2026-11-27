import assert from "node:assert/strict";
import { before, test } from "node:test";

import sharp from "sharp";

import {
  BinaryBuilder,
  denseAccessorBytes,
  readGlb,
  viewBytes,
  writeGlb,
} from "./vrm-optimize/glb.mjs";
import { imageRoles, optimizeVrm } from "./vrm-optimize/optimize.mjs";
import { compareVrm } from "./vrm-optimize/verify.mjs";
import { parseArgs } from "./vrm-optimize.mjs";

const VERTICES = 64;
const OWNER_META = {
  name: "Fixture",
  authors: ["Animama"],
  licenseUrl: "https://vrm.dev/licenses/1.0/",
  modification: "allowModificationRedistribution",
};

/** An uncompressed PNG, so WebP is reliably smaller. */
const gradientPng = (size) =>
  sharp(
    Buffer.alloc(size * size * 4, 0).map((_, index) =>
      index % 4 === 3 ? 255 : (index * 7) % 256,
    ),
    {
      raw: { width: size, height: size, channels: 4 },
    },
  )
    .png({ compressionLevel: 0 })
    .toBuffer();

/**
 * A VRM 1.0 GLB with a colour texture, a data texture, a thumbnail, one
 * mostly-zero morph target and one all-zero morph target.
 */
async function fixtureVrm() {
  const builder = new BinaryBuilder();
  const colour = builder.add(await gradientPng(256));
  const data = builder.add(await gradientPng(256));
  const thumbnail = builder.add(await gradientPng(1500));
  const positions = new Float32Array(VERTICES * 3).map(
    (_, index) => index / 10,
  );
  const moved = new Float32Array(VERTICES * 3);
  moved[5 * 3 + 1] = 0.25;
  const position = builder.add(Buffer.from(positions.buffer));
  const sparseTarget = builder.add(Buffer.from(moved.buffer));
  const zeroTarget = builder.add(
    Buffer.from(new Float32Array(VERTICES * 3).buffer),
  );
  const vec3 = (bufferView) => ({
    bufferView,
    componentType: 5126,
    count: VERTICES,
    type: "VEC3",
  });
  const json = {
    asset: { version: "2.0" },
    extensionsUsed: ["VRMC_vrm", "VRMC_materials_mtoon"],
    extensions: {
      VRMC_vrm: {
        specVersion: "1.0",
        meta: {
          name: "Source",
          authors: ["Someone"],
          licenseUrl: "https://vrm.dev/licenses/1.0/",
          thumbnailImage: 2,
        },
        humanoid: { humanBones: { hips: { node: 0 } } },
      },
    },
    nodes: [{ name: "hips", mesh: 0 }],
    scenes: [{ nodes: [0] }],
    meshes: [
      {
        name: "Face",
        primitives: [
          {
            attributes: { POSITION: 0 },
            targets: [{ POSITION: 1 }, { POSITION: 2 }],
            material: 0,
          },
        ],
        extras: { targetNames: ["Fcl_EYE_Joy", "Fcl_HA_Hide"] },
      },
    ],
    accessors: [
      { ...vec3(position), min: [0, 0, 0], max: [19.1, 19.2, 19.3] },
      vec3(sparseTarget),
      vec3(zeroTarget),
    ],
    images: [
      { name: "colour", bufferView: colour, mimeType: "image/png" },
      { name: "data", bufferView: data, mimeType: "image/png" },
      { name: "Thumbnail", bufferView: thumbnail, mimeType: "image/png" },
    ],
    textures: [{ source: 0 }, { source: 1 }],
    materials: [
      {
        name: "Face_SKIN",
        pbrMetallicRoughness: { baseColorTexture: { index: 0 } },
        extensions: {
          VRMC_materials_mtoon: {
            specVersion: "1.0",
            shadeMultiplyTexture: { index: 0 },
            outlineWidthMultiplyTexture: { index: 1 },
          },
        },
      },
    ],
  };
  json.bufferViews = builder.views;
  const bin = builder.toBuffer();
  json.buffers = [{ byteLength: bin.length + (-bin.length & 3) }];
  return writeGlb(json, bin);
}

let source;
let optimized;
before(async () => {
  source = await fixtureVrm();
  optimized = (await optimizeVrm(source, { meta: OWNER_META })).bytes;
});

test("colour textures become WebP and data textures stay pixel-identical", async () => {
  const before = readGlb(source);
  const after = readGlb(optimized);
  assert.equal(after.json.images[0].mimeType, "image/webp");
  assert.deepEqual(after.json.textures[0], {
    extensions: { EXT_texture_webp: { source: 0 } },
  });
  assert.ok(after.json.extensionsRequired.includes("EXT_texture_webp"));

  assert.equal(after.json.images[1].mimeType, "image/webp");
  const pixels = (document, image) =>
    sharp(viewBytes(document, document.json.images[image].bufferView))
      .ensureAlpha()
      .raw()
      .toBuffer();
  assert.ok((await pixels(before, 1)).equals(await pixels(after, 1)));
});

test("morph targets are stored sparsely, and an all-zero target keeps no data", () => {
  const after = readGlb(optimized);
  const [, sparseTarget, zeroTarget] = after.json.accessors;
  assert.equal(sparseTarget.bufferView, undefined);
  assert.equal(sparseTarget.sparse.count, 1);
  assert.equal(zeroTarget.bufferView, undefined);
  assert.equal(zeroTarget.sparse, undefined);
  const values = new Float32Array(
    denseAccessorBytes(after, sparseTarget).buffer.slice(0),
  );
  assert.equal(values[5 * 3 + 1], 0.25);
});

test("meta is replaced but keeps the thumbnail, which shrinks to a JPEG", async () => {
  const after = readGlb(optimized);
  assert.deepEqual(after.json.extensions.VRMC_vrm.meta, {
    ...OWNER_META,
    thumbnailImage: 2,
  });
  assert.equal(after.json.images[2].mimeType, "image/jpeg");
  const thumbnail = await sharp(
    viewBytes(after, after.json.images[2].bufferView),
  ).metadata();
  assert.equal(thumbnail.width, 1024);
});

test("verification passes for the optimized file and catches a changed value", async () => {
  assert.deepEqual(
    await compareVrm(source, optimized, { meta: OWNER_META }),
    [],
  );
  assert.deepEqual(await compareVrm(source, optimized), [
    "JSON differs at $.extensions.VRMC_vrm.meta.name",
    "JSON differs at $.extensions.VRMC_vrm.meta.authors.0",
    "JSON differs at $.extensions.VRMC_vrm.meta.modification",
  ]);

  const tampered = readGlb(Buffer.from(optimized));
  tampered.json.extensions.VRMC_vrm.meta = { ...OWNER_META, thumbnailImage: 2 };
  const valueView = tampered.json.accessors[1].sparse.values.bufferView;
  viewBytes(tampered, valueView).writeFloatLE(0.5, 4);
  const differences = await compareVrm(
    source,
    writeGlb(tampered.json, tampered.bin),
    { meta: OWNER_META },
  );
  assert.deepEqual(differences, ["accessor 1 values differ"]);
});

test("files the optimizer cannot preserve are refused", async () => {
  const document = readGlb(source);
  const vrm0 = structuredClone(document.json);
  delete vrm0.extensions.VRMC_vrm;
  await assert.rejects(
    optimizeVrm(writeGlb(vrm0, document.bin)),
    /Only VRM 1.0/,
  );

  const meshopt = structuredClone(document.json);
  meshopt.extensionsUsed.push("EXT_meshopt_compression");
  await assert.rejects(
    optimizeVrm(writeGlb(meshopt, document.bin)),
    /Unsupported glTF extensions: EXT_meshopt_compression/,
  );
});

/** The fixture as a Mochiya conversion: lilToon materials and a composition record. */
const convertedJson = (json) => {
  const converted = structuredClone(json);
  converted.extensionsUsed.push(
    "MOCHIYA_avatar_composition",
    "MOCHIYA_materials_liltoon",
  );
  converted.extensions.MOCHIYA_avatar_composition = {
    specVersion: "1.0",
    nodes: [{ node: 0, role: "body" }],
  };
  converted.materials[0].extensions = {
    MOCHIYA_materials_liltoon: {
      specVersion: "1.0",
      textures: {
        _MainTex: { index: 0, texCoord: 0 },
        _ShadowStrengthMask: { index: 1, texCoord: 0 },
      },
    },
  };
  return converted;
};

test("a converted Avatar keeps Mochiya's extensions and its lilToon textures' roles", async () => {
  const document = readGlb(source);
  const converted = convertedJson(document.json);
  assert.deepEqual(Object.fromEntries(imageRoles(converted)), {
    0: "colour",
    1: "data",
  });

  const result = await optimizeVrm(writeGlb(converted, document.bin));
  const after = readGlb(result.bytes);
  assert.deepEqual(
    after.json.extensions.MOCHIYA_avatar_composition,
    converted.extensions.MOCHIYA_avatar_composition,
  );
  assert.deepEqual(
    after.json.materials[0].extensions.MOCHIYA_materials_liltoon,
    converted.materials[0].extensions.MOCHIYA_materials_liltoon,
  );
  const pixels = (glb, image) =>
    sharp(viewBytes(glb, glb.json.images[image].bufferView))
      .ensureAlpha()
      .raw()
      .toBuffer();
  assert.ok((await pixels(document, 1)).equals(await pixels(after, 1)));
});

test("a Mochiya extension that points into the binary is refused", async () => {
  const document = readGlb(source);
  const converted = convertedJson(document.json);
  converted.extensions.MOCHIYA_avatar_composition.data = { bufferView: 0 };
  await assert.rejects(
    optimizeVrm(writeGlb(converted, document.bin)),
    /MOCHIYA_avatar_composition references binary data/,
  );
});

test("an Animama Avatar Converter (PMX) conversion keeps its marker", async () => {
  const document = readGlb(source);
  const converted = structuredClone(document.json);
  converted.extensionsUsed.push("ANIMAMA_avatar_conversion");
  converted.extensions.ANIMAMA_avatar_conversion = {
    source: "pmx",
    converter: "0.2.0",
  };
  const result = await optimizeVrm(writeGlb(converted, document.bin));
  const after = readGlb(result.bytes);
  assert.ok(after.json.extensionsUsed.includes("ANIMAMA_avatar_conversion"));
  assert.deepEqual(after.json.extensions.ANIMAMA_avatar_conversion, {
    source: "pmx",
    converter: "0.2.0",
  });
  converted.extensions.ANIMAMA_avatar_conversion.data = { bufferView: 0 };
  await assert.rejects(
    optimizeVrm(writeGlb(converted, document.bin)),
    /ANIMAMA_avatar_conversion references binary data/,
  );
});

/** A data texture whose transparent pixels hide colour that WebP would drop. */
const paddedDataPng = () =>
  sharp(
    Buffer.alloc(64 * 64 * 4, 0).map((_, index) =>
      index % 4 === 3 ? (index < 64 * 32 * 4 ? 255 : 0) : 120 + (index % 7),
    ),
    { raw: { width: 64, height: 64, channels: 4 } },
  )
    .png({ compressionLevel: 0 })
    .toBuffer();

/** The fixture with its data texture (image 1) replaced by other PNG bytes. */
const withDataImage = (png) =>
  withDataImageFrom(readGlb(Buffer.from(source)), png);

test("a data texture whose transparent pixels WebP would change keeps its PNG", async () => {
  const padded = await withDataImage(await paddedDataPng());
  const { bytes } = await optimizeVrm(padded);
  const after = readGlb(bytes);
  assert.equal(after.json.images[1].mimeType, "image/png");
  assert.deepEqual(await compareVrm(padded, bytes), []);

  // Had it been converted, verification would catch the changed pixels.
  const forced = readGlb(Buffer.from(bytes));
  const lossless = await sharp(
    viewBytes(forced, forced.json.images[1].bufferView),
  )
    .webp({ lossless: true })
    .toBuffer();
  const converted = await withDataImageFrom(forced, lossless);
  assert.deepEqual(await compareVrm(padded, converted), [
    "data image 1 pixels differ",
  ]);
});

/** Rebuild a parsed document with image 1 replaced (same mime type kept). */
function withDataImageFrom(document, bytes) {
  const builder = new BinaryBuilder();
  const remap = document.json.bufferViews.map((view, index) => {
    const { buffer: _b, byteOffset: _o, byteLength: _l, ...extra } = view;
    return builder.add(
      index === document.json.images[1].bufferView
        ? bytes
        : viewBytes(document, index),
      extra,
    );
  });
  const json = structuredClone(document.json);
  for (const accessor of json.accessors) {
    if (accessor.bufferView !== undefined)
      accessor.bufferView = remap[accessor.bufferView];
    if (accessor.sparse) {
      accessor.sparse.indices.bufferView =
        remap[accessor.sparse.indices.bufferView];
      accessor.sparse.values.bufferView =
        remap[accessor.sparse.values.bufferView];
    }
  }
  for (const image of json.images) image.bufferView = remap[image.bufferView];
  json.bufferViews = builder.views;
  const bin = builder.toBuffer();
  json.buffers = [{ byteLength: bin.length + (-bin.length & 3) }];
  return writeGlb(json, bin);
}

test("an existing EXT_texture_webp fallback source is kept", async () => {
  const document = readGlb(Buffer.from(source));
  const json = structuredClone(document.json);
  json.extensionsUsed.push("EXT_texture_webp");
  json.textures[0] = {
    source: 1,
    extensions: { EXT_texture_webp: { source: 0 } },
  };
  const input = writeGlb(json, document.bin);
  const { bytes } = await optimizeVrm(input);
  assert.equal(readGlb(bytes).json.textures[0].source, 1);
  assert.deepEqual(await compareVrm(input, bytes), []);
});

test("the CLI refuses unknown options and treats --help as a flag", () => {
  assert.throws(
    () => parseArgs(["in.vrm", "--out", "out.vrm", "--mta", "meta.json"]),
    /Unknown option --mta for optimize/,
  );
  assert.throws(
    () => parseArgs(["verify", "a.vrm", "b.vrm", "--out", "x"]),
    /Unknown option --out for verify/,
  );
  assert.equal(parseArgs(["--help"]).help, true);
  assert.deepEqual(
    parseArgs(["in.vrm", "--out", "o.vrm", "--meta", "m.json"]).options,
    {
      out: "o.vrm",
      meta: "m.json",
    },
  );
});
