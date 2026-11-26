import { describe, expect, it } from "vitest";

import { isHairName } from "./faceParts";

describe("isHairName", () => {
  it("recognises English names", () => {
    for (const name of [
      "Hair",
      "hair_front",
      "FrontHair",
      "Bangs",
      "fringe",
      "Twintail_L",
      "ponytail",
      "ahoge",
    ])
      expect(isHairName(name)).toBe(true);
  });

  it("recognises Korean names", () => {
    for (const name of ["머리카락", "앞머리", "뒷머리"])
      expect(isHairName(name)).toBe(true);
  });

  it("recognises the Japanese and Chinese names MMD models give hair", () => {
    for (const name of [
      "髪",
      "前髪",
      "後ろ髪",
      "頭髮",
      "头发",
      "发",
      "发影",
      " 发 ",
      "前发",
      "后发",
      "侧发",
      "长发",
      "白发",
      "刘海",
      "瀏海",
      "呆毛",
      "アホ毛",
      "ツインテール",
      "ポニーテール",
    ])
      expect(isHairName(name)).toBe(true);
  });

  it("does not take a bare 发 inside other words, or 发光 (glow), for hair", () => {
    for (const name of ["发光", "发条", "发射", "出发", "Body", "目", "肌"])
      expect(isHairName(name)).toBe(false);
  });

  it("does not take ornaments or words that only contain a hair word for hair", () => {
    for (const name of ["髪飾り", "发饰", "hair_ornament", "Chair", "Bangle"])
      expect(isHairName(name)).toBe(false);
  });
});
