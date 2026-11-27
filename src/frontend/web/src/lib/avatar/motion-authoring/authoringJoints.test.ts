import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { runMotionCli } from "./cli";

/** The generator `pnpm authoring:joints` runs; a script, so it has no types. */
type AuthoringJointsScript = {
  generateAuthoringJoints: (run: typeof runMotionCli) => Promise<string>;
};

const SCRIPT = new URL(
  "../../../../scripts/authoring-joints.mjs",
  import.meta.url,
);
const TRACKED = new URL("./authoring-joints.generated.md", import.meta.url);

describe("the authoring joint table", () => {
  // The backend packages a copy of this file as authoring guidance, so a
  // changed joint, range or base pose must be regenerated here first.
  it("matches a fresh generation from the joint definitions", async () => {
    const { generateAuthoringJoints } = (await import(
      /* @vite-ignore */ SCRIPT.href
    )) as AuthoringJointsScript;

    const generated = await generateAuthoringJoints(runMotionCli);

    expect(
      await readFile(TRACKED, "utf8"),
      "Run `node scripts/authoring-joints.mjs --write` from src/frontend/web, then " +
        "`uv run --no-sync python src/backend/packaging/shared_catalogs.py --write` from the repository root.",
    ).toBe(generated);
    // The file is guidance for authors who cannot run a command.
    expect(generated).not.toContain("pnpm");
    expect(generated).toContain("leftUpperArm, rightUpperArm");
    expect(generated).toContain("rightUpperArm: elevation ");
  });
});
