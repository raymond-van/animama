import { getI18n } from "react-i18next";
import { describe, expect, it } from "vitest";
import type { PyModelRoleAssignment } from "@animama/runtime-contracts/api-types";

import { effectiveNote } from "./ModelDefaultsSettings";

const t = () => getI18n().getFixedT(null, "models");

const assignment = (
  extra: Partial<PyModelRoleAssignment>,
): PyModelRoleAssignment => ({
  role: "utility",
  source: "owner",
  assignment_available: true,
  ...extra,
});

describe("a default model's note", () => {
  it("says a lost choice fell back, or that the role waits for it", () => {
    expect(
      effectiveNote(
        t(),
        assignment({ source: "inherited", assignment_available: false }),
      ),
    ).toBe("The chosen model is unavailable, so the default is used.");
    // A ChatGPT plan model that is unavailable is not replaced (spec #919 R5.2).
    expect(
      effectiveNote(
        t(),
        assignment({ source: "off", assignment_available: false }),
      ),
    ).toBe(
      "The chosen model is unavailable, so this waits until it is available again.",
    );
  });
});
