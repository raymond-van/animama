import type { VRM } from "@pixiv/three-vrm";
import {
  BoxGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Texture,
} from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Avatar } from "./Avatar";

/** Stand-in for the browser ImageBitmap that GLTFLoader decodes into. */
class FakeImageBitmap {
  close = vi.fn();
}

beforeEach(() => {
  vi.stubGlobal("ImageBitmap", FakeImageBitmap);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A loaded model attached to a host scene, as React Three Fiber mounts it. */
function attachModel(avatar: Avatar) {
  const host = new Group();
  const scene = new Group();
  const bitmap = new FakeImageBitmap();
  scene.add(
    new Mesh(
      new BoxGeometry(),
      new MeshBasicMaterial({
        map: new Texture(bitmap as unknown as ImageBitmap),
      }),
    ),
  );
  host.add(scene);
  avatar.vrm = { scene } as unknown as VRM;
  return { host, scene, bitmap };
}

describe("Avatar disposal", () => {
  it("unloading detaches the model and releases its decoded textures", () => {
    const avatar = new Avatar(new PerspectiveCamera(), null);
    const { host, scene, bitmap } = attachModel(avatar);

    avatar.unload();

    expect(host.children).not.toContain(scene);
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(avatar.vrm).toBeNull();
  });

  it("drops caller-supplied sinks, providers and elements when disposed", () => {
    const viewport = { tagName: "CANVAS" } as unknown as HTMLElement;
    const cursorLookAtInputProvider = { read: vi.fn() };
    const avatar = new Avatar(new PerspectiveCamera(), viewport, {
      cursorLookAtInputProvider:
        cursorLookAtInputProvider as unknown as NonNullable<
          ConstructorParameters<typeof Avatar>[2]
        >["cursorLookAtInputProvider"],
    });
    const poseSink = { playSfx: vi.fn() };
    const reactionSink = { playSfx: vi.fn() };
    avatar.setPoseClipExternalEventSink(poseSink);
    avatar.setReactionClipExternalEventSink(reactionSink);
    const held = Object.values(avatar);
    expect(held).toContain(poseSink);
    expect(held).toContain(reactionSink);
    expect(held).toContain(cursorLookAtInputProvider);
    expect(held).toContain(viewport);

    avatar.dispose();

    // A stale closure that still reaches this Avatar must not keep the
    // caller's components, canvas or previous model state alive through it.
    const retained = Object.values(avatar);
    expect(retained).not.toContain(poseSink);
    expect(retained).not.toContain(reactionSink);
    expect(retained).not.toContain(cursorLookAtInputProvider);
    expect(retained).not.toContain(viewport);
  });
});
