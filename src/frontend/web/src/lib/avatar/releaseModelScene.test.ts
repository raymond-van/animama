import {
  BoxGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  ShaderMaterial,
  Texture,
} from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { releaseModelScene } from "./releaseModelScene";

/** Stand-in for the browser ImageBitmap that GLTFLoader decodes into. */
class FakeImageBitmap {
  close = vi.fn();
}

function bitmapTexture(): { texture: Texture; bitmap: FakeImageBitmap } {
  const bitmap = new FakeImageBitmap();
  return {
    texture: new Texture(bitmap as unknown as ImageBitmap),
    bitmap,
  };
}

beforeEach(() => {
  vi.stubGlobal("ImageBitmap", FakeImageBitmap);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("releaseModelScene", () => {
  it("detaches the model before any of its GPU resources are disposed", () => {
    const parent = new Group();
    const model = new Group();
    const mesh = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
    model.add(mesh);
    parent.add(model);
    const parentsAtDisposal: unknown[] = [];
    mesh.geometry.addEventListener("dispose", () =>
      parentsAtDisposal.push(model.parent),
    );
    mesh.material.addEventListener("dispose", () =>
      parentsAtDisposal.push(model.parent),
    );

    releaseModelScene(model);

    expect(parent.children).not.toContain(model);
    expect(parentsAtDisposal).toEqual([null, null]);
  });

  it("closes each decoded texture image once, after its texture is disposed", () => {
    const model = new Group();
    const shared = bitmapTexture();
    const uniform = bitmapTexture();
    const events: string[] = [];
    shared.texture.addEventListener("dispose", () => events.push("dispose"));
    shared.bitmap.close.mockImplementation(() => events.push("close"));
    model.add(
      new Mesh(
        new BoxGeometry(),
        new MeshBasicMaterial({ map: shared.texture }),
      ),
      new Mesh(new BoxGeometry(), [
        new MeshBasicMaterial({ map: shared.texture }),
        new ShaderMaterial({ uniforms: { map: { value: uniform.texture } } }),
      ]),
    );

    releaseModelScene(model);

    expect(shared.bitmap.close).toHaveBeenCalledOnce();
    expect(uniform.bitmap.close).toHaveBeenCalledOnce();
    expect(events[0]).toBe("dispose");
    expect(events.at(-1)).toBe("close");
  });

  it("leaves texture sources that are not ImageBitmaps alone", () => {
    const model = new Group();
    const image = { close: vi.fn(), width: 1, height: 1 };
    model.add(
      new Mesh(
        new BoxGeometry(),
        new MeshBasicMaterial({ map: new Texture(image) }),
      ),
    );

    releaseModelScene(model);

    expect(image.close).not.toHaveBeenCalled();
  });
});
