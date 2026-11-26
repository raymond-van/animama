import { describe, expect, it } from "vitest";

import {
  readTestAvatarBytes,
  VRM0_FIXTURE_ID,
} from "../motion-authoring/testing/includedAvatars";
import { dummyThumbVrmBytes } from "../testing/dummyThumbVrm";
import { encodeGlb as glb } from "../testing/glb";
import {
  avatarFileIssues,
  readAvatarFileFacts,
  readImagePixelSize,
} from "./avatarFileFacts";

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // IHDR
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function jpeg(width: number, height: number): Uint8Array {
  // SOI, an APP0 segment to skip, then a baseline start-of-frame.
  const bytes = new Uint8Array(2 + 18 + 19);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 0xffd8);
  view.setUint16(2, 0xffe0);
  view.setUint16(4, 16);
  view.setUint16(20, 0xffc0);
  view.setUint16(22, 17);
  bytes[24] = 8;
  view.setUint16(25, height);
  view.setUint16(27, width);
  return bytes;
}

function webpExtended(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  bytes.set(new TextEncoder().encode("WEBPVP8X"), 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 10, true);
  const uint24 = (at: number, value: number) =>
    bytes.set([value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff], at);
  uint24(24, width - 1);
  uint24(27, height - 1);
  return bytes;
}

describe("readAvatarFileFacts", () => {
  it.each(["Andrew", "Annie"] as const)(
    "describes the Included Avatar %s",
    async (id) => {
      const facts = readAvatarFileFacts(await readTestAvatarBytes(id));
      expect(facts).toMatchObject({ container: "glb", vrmVersion: "1.0" });
      expect(facts!.extensionsUsed).toContain("VRMC_vrm");
      expect(facts!.primitiveCount).toBeGreaterThan(facts!.meshCount);
      expect(facts!.morphedPrimitiveCount).toBeGreaterThan(0);
      expect(facts!.materialKinds.mtoon).toBeGreaterThan(0);
      expect(facts!.textures.length).toBeGreaterThan(0);
      for (const texture of facts!.textures) {
        expect(texture.byteLength).toBeGreaterThan(0);
        expect(texture.width).toBeGreaterThan(0);
        expect(texture.height).toBeGreaterThan(0);
      }
    },
  );

  it("reads a VRM 0 file's version and MToon materials", async () => {
    const facts = readAvatarFileFacts(
      await readTestAvatarBytes(VRM0_FIXTURE_ID),
    );
    expect(facts?.vrmVersion).toBe("0.x");
    expect(facts?.materialKinds.mtoon).toBeGreaterThan(0);
  });

  it("describes a file whose required extension no loader decodes", () => {
    const image = png(512, 256);
    const facts = readAvatarFileFacts(
      glb(
        {
          asset: { version: "2.0" },
          extensionsUsed: ["KHR_draco_mesh_compression", "KHR_materials_unlit"],
          extensionsRequired: ["KHR_draco_mesh_compression"],
          meshes: [{ primitives: [{ targets: [{}] }, {}] }],
          materials: [{ extensions: { KHR_materials_unlit: {} } }, {}],
          bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: image.length }],
          images: [
            { bufferView: 0, mimeType: "image/png" },
            { uri: "textures/outside.png" },
          ],
        },
        image,
      ),
    );
    expect(facts).toMatchObject({
      vrmVersion: null,
      extensionsRequired: ["KHR_draco_mesh_compression"],
      meshCount: 1,
      primitiveCount: 2,
      morphedPrimitiveCount: 1,
      mismatchedMorphNameMeshCount: 0,
      materialCount: 2,
      materialKinds: { mtoon: 0, liltoon: 0, unlit: 1, pbr: 1 },
      textures: [
        {
          mimeType: "image/png",
          byteLength: image.length,
          width: 512,
          height: 256,
        },
        { mimeType: null, byteLength: null, width: null, height: null },
      ],
    });
  });

  it("reads lilToon materials and data URI images", () => {
    const image = jpeg(64, 32);
    const uri = `data:image/jpeg;base64,${btoa(String.fromCharCode(...image))}`;
    const facts = readAvatarFileFacts(
      glb({
        extensions: { VRMC_vrm: { specVersion: "1.0" } },
        materials: [{ extensions: { MOCHIYA_materials_liltoon: {} } }],
        images: [{ uri, mimeType: "image/jpeg" }],
      }),
    );
    expect(facts?.materialKinds.liltoon).toBe(1);
    expect(facts?.textures[0]).toMatchObject({ width: 64, height: 32 });
  });

  it("keeps the JSON facts of a file cut off in its binary chunk", () => {
    const image = png(8, 8);
    const full = glb(
      {
        meshes: [{ primitives: [{}] }],
        bufferViews: [
          { buffer: 0, byteOffset: 0, byteLength: image.length },
          { buffer: 0, byteOffset: -4, byteLength: 4 },
        ],
        images: [{ bufferView: 0 }, { bufferView: 1 }],
      },
      image,
    );
    const facts = readAvatarFileFacts(full.slice(0, full.length - 8));
    expect(facts).toMatchObject({ meshCount: 1, primitiveCount: 1 });
    // No binary chunk survived, so no image size is claimed.
    expect(facts!.textures.map((texture) => texture.byteLength)).toEqual([
      null,
      null,
    ]);
    // A bad offset never reads from the wrong place.
    expect(readAvatarFileFacts(full)!.textures[1]!.byteLength).toBeNull();
  });

  it("returns null for bytes that are not glTF", () => {
    expect(
      readAvatarFileFacts(new TextEncoder().encode("not a model")),
    ).toBeNull();
    const truncated = glb({ asset: {} }).slice(0, 24);
    expect(readAvatarFileFacts(truncated)).toBeNull();
  });
});

describe("avatarFileIssues", () => {
  it("finds nothing in the Included Avatars", async () => {
    for (const id of ["Andrew", "Annie"] as const) {
      const facts = readAvatarFileFacts(await readTestAvatarBytes(id));
      expect(avatarFileIssues(facts)).toEqual([]);
    }
  });

  it("names a VRM 1.0 file whose materials all ignore light", () => {
    const unlit = {
      pbrMetallicRoughness: { baseColorTexture: { index: 0 } },
      extensions: { KHR_materials_unlit: {} },
    };
    const vrm = { VRMC_vrm: { specVersion: "1.0" } };
    const facts = readAvatarFileFacts(
      glb({ extensions: vrm, materials: [unlit, unlit] }),
    );
    expect(facts?.unlitOnly).toBe(true);
    expect(avatarFileIssues(facts)).toEqual([{ code: "materials_unlit" }]);

    // One lit material means the unlit ones are deliberate.
    const mixed = readAvatarFileFacts(
      glb({ extensions: vrm, materials: [unlit, {}] }),
    );
    expect(mixed?.unlitOnly).toBe(false);
    expect(avatarFileIssues(mixed)).toEqual([]);
  });

  it("names a required Draco extension before any load", () => {
    const facts = readAvatarFileFacts(
      glb({
        asset: { version: "2.0" },
        extensionsUsed: ["VRMC_vrm", "KHR_draco_mesh_compression"],
        extensionsRequired: ["KHR_draco_mesh_compression"],
        extensions: { VRMC_vrm: { specVersion: "1.0" } },
      }),
    );
    expect(avatarFileIssues(facts)).toEqual([
      {
        code: "avatar_extension_unsupported",
        params: { extension: "KHR_draco_mesh_compression" },
      },
    ]);
  });

  it("accepts the extensions converted and optimized Avatars use", () => {
    const extensions = [
      "MOCHIYA_avatar_composition",
      "MOCHIYA_materials_liltoon",
      "EXT_meshopt_compression",
    ];
    const facts = readAvatarFileFacts(
      glb({
        extensionsUsed: ["VRMC_vrm", ...extensions],
        extensionsRequired: extensions,
        extensions: { VRMC_vrm: { specVersion: "1.0" } },
      }),
    );
    expect(avatarFileIssues(facts)).toEqual([]);
  });

  it("counts meshes whose primitives name their morph targets differently", () => {
    const primitive = (names: string[]) => ({
      attributes: { POSITION: 0 },
      targets: [{ POSITION: 1 }, { POSITION: 1 }],
      extras: { targetNames: names },
    });
    const facts = readAvatarFileFacts(
      glb({
        meshes: [
          // Loads named: the lists agree.
          { primitives: [primitive(["a", "b"]), primitive(["a", "b"])] },
          // Loads unnamed: the lists disagree.
          { primitives: [primitive(["a", "b"]), primitive(["a", "c"])] },
          { primitives: [primitive(["a", "b"]), primitive(["b", "a"])] },
        ],
      }),
    );
    expect(facts?.mismatchedMorphNameMeshCount).toBe(2);
    expect(avatarFileIssues(facts)).toEqual([
      { code: "morph_target_names_mismatched", params: { count: 2 } },
    ]);
  });

  it("reports humanoid bones the loader moves to the bones the mesh follows", () => {
    const facts = readAvatarFileFacts(dummyThumbVrmBytes());
    expect(facts?.humanoidBones).toEqual({ remapped: 3, unweighted: 0 });
    expect(avatarFileIssues(facts)).toEqual([
      { code: "humanoid_bones_remapped", params: { count: 3 } },
    ]);
  });

  it("reports humanoid bones that move nothing and have no counterpart", () => {
    const facts = readAvatarFileFacts(
      dummyThumbVrmBytes({ vrm: 0, counterpart: "none" }),
    );
    expect(facts?.humanoidBones).toEqual({ remapped: 0, unweighted: 3 });
    expect(avatarFileIssues(facts)).toEqual([
      { code: "humanoid_bones_unweighted", params: { count: 3 } },
    ]);
  });

  it("reads the Included Avatars' skin weights and finds every bone in use", async () => {
    for (const id of ["Andrew", "Annie"] as const) {
      const facts = readAvatarFileFacts(await readTestAvatarBytes(id));
      expect(facts?.humanoidBones).toEqual({ remapped: 0, unweighted: 0 });
    }
  });

  it("leaves humanoid bones unreported when it cannot read the weights", () => {
    const bytes = dummyThumbVrmBytes();
    const view = new DataView(bytes.buffer);
    const jsonLength = view.getUint32(12, true);
    const json = JSON.parse(
      new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)),
    );
    const bin = bytes.subarray(20 + jsonLength + 8);
    const meshopt = structuredClone(json);
    meshopt.bufferViews[2].extensions = { EXT_meshopt_compression: {} };
    expect(readAvatarFileFacts(glb(meshopt, bin))?.humanoidBones).toBeNull();
    // Draco keeps the skin in its compressed stream: accessors without views.
    const draco = structuredClone(json);
    draco.accessors.forEach((accessor: Record<string, unknown>) => {
      delete accessor.bufferView;
    });
    draco.meshes[0].primitives[0].extensions = {
      KHR_draco_mesh_compression: { bufferView: 0, attributes: {} },
    };
    expect(readAvatarFileFacts(glb(draco, bin))?.humanoidBones).toBeNull();
    expect(
      readAvatarFileFacts(glb({ asset: { version: "2.0" } }))?.humanoidBones,
    ).toBeNull();
  });

  it("reports an unreadable file", () => {
    expect(avatarFileIssues(null)).toEqual([{ code: "file_unreadable" }]);
  });
});

describe("readImagePixelSize", () => {
  it("reads PNG, JPEG and WebP headers", () => {
    expect(readImagePixelSize(png(2048, 1024))).toEqual({
      width: 2048,
      height: 1024,
    });
    expect(readImagePixelSize(jpeg(640, 480))).toEqual({
      width: 640,
      height: 480,
    });
    expect(readImagePixelSize(webpExtended(4096, 2048))).toEqual({
      width: 4096,
      height: 2048,
    });
  });

  it("returns null for other formats", () => {
    expect(readImagePixelSize(new Uint8Array(40))).toBeNull();
  });
});
