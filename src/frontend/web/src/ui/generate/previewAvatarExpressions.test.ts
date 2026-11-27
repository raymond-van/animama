import { describe, expect, it } from "vitest";

import { groupExpressionNames } from "@/lib/avatar/motion-authoring/expressionInventory";
import { previewAvatarExpressions } from "./previewAvatarExpressions";

type AvatarLike = NonNullable<Parameters<typeof previewAvatarExpressions>[0]>;

const avatar = (
  names: string[],
  arkit: Record<string, string[]> | null,
): AvatarLike =>
  ({
    getAvailableExpressions: () => names,
    arkitFace: arkit
      ? { capability: { resolved: new Map(Object.entries(arkit)) } }
      : null,
  }) as unknown as AvatarLike;

describe("previewAvatarExpressions", () => {
  it("reads nothing without an Avatar", () => {
    expect(previewAvatarExpressions(null)).toBeNull();
  });

  it("reads the Avatar's names and the ARKit shapes it resolved", () => {
    const expressions = previewAvatarExpressions(
      avatar(["happy", "jawOpen", "mouthSmileLeft", "Cheek_Blush"], {
        jawOpen: ["Jaw_Open"],
        mouthSmileLeft: ["MouthSmile_L"],
      }),
    )!;
    expect(expressions).toEqual({
      names: ["happy", "jawOpen", "mouthSmileLeft", "Cheek_Blush"],
      arkitNames: ["jawOpen", "mouthSmileLeft"],
    });
    // As a run groups them for the assistant.
    expect(
      groupExpressionNames(expressions.names, expressions.arkitNames).families,
    ).toMatchObject({
      vrmPresets: ["happy"],
      arkit: ["jawOpen", "mouthSmileLeft"],
      custom: ["Cheek_Blush"],
    });
  });

  it("leaves the ARKit names to the canonical list for an Avatar without coverage data", () => {
    const expressions = previewAvatarExpressions(
      avatar(["happy", "jawOpen"], null),
    )!;
    expect(expressions.arkitNames).toBeUndefined();
    expect(
      groupExpressionNames(expressions.names, expressions.arkitNames).families
        .arkit,
    ).toEqual(["jawOpen"]);
  });
});
