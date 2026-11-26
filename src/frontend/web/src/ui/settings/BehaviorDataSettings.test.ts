import { getI18n } from "react-i18next";
import { describe, expect, it } from "vitest";

import type { PyAutomaticEpisodeProcessingStatus } from "@animama/runtime-contracts/api-types";
import {
  AUTOMATIC_PROCESSING_THRESHOLDS,
  automaticProcessingDescription,
} from "@/ui/settings/BehaviorDataSettings";

const t = getI18n().getFixedT(null, "settings");

function status(
  state: PyAutomaticEpisodeProcessingStatus["state"],
  values: Partial<PyAutomaticEpisodeProcessingStatus> = {},
): PyAutomaticEpisodeProcessingStatus {
  return { threshold: 10, state, pending_count: 0, runs_today: 0, ...values };
}

describe("automatic episode processing setting", () => {
  it("offers Off and the thresholds the backend accepts", () => {
    expect(AUTOMATIC_PROCESSING_THRESHOLDS[0]).toBe(0);
    expect(
      AUTOMATIC_PROCESSING_THRESHOLDS.slice(1).every(
        (value) => value >= 5 && value <= 50,
      ),
    ).toBe(true);
  });

  it("explains why processing is not running", () => {
    expect(automaticProcessingDescription(t, status("memory_off"))).toBe(
      "Turn on Memory and Memory updates to process notes automatically.",
    );
    expect(automaticProcessingDescription(t, status("needs_model"))).toMatch(
      /Memory Manager model/,
    );
    expect(
      automaticProcessingDescription(t, status("needs_plan_agreement")),
    ).toMatch(/ChatGPT plan/);
    expect(automaticProcessingDescription(t, status("plan_paused"))).toMatch(
      /usage limit/,
    );
    expect(
      automaticProcessingDescription(t, status("needs_plan_sign_in")),
    ).toMatch(/Sign in with ChatGPT/);
    expect(
      automaticProcessingDescription(
        t,
        status("paused", { last_error: "Model refused." }),
      ),
    ).toBe(
      "Paused after repeated failures. Change this setting to try again. Last error: Model refused.",
    );
    expect(
      automaticProcessingDescription(
        t,
        status("backing_off", { last_error: "Timed out." }),
      ),
    ).toBe("Retrying later after a failure. Last error: Timed out.");
    expect(automaticProcessingDescription(t, status("backing_off"))).toBe(
      "Daily limit reached. Processing continues tomorrow.",
    );
  });

  it("reports a run in progress and otherwise describes the setting", () => {
    expect(
      automaticProcessingDescription(t, status("running", { batch_size: 10 })),
    ).toBe("Crystallizing 10 notes into memory…");
    for (const state of ["off", "waiting", "ready"] as const) {
      expect(automaticProcessingDescription(t, status(state))).toBe(
        "Fold notes from your chats into your memory files once this many are waiting.",
      );
    }
    expect(automaticProcessingDescription(t, undefined)).toMatch(/Fold notes/);
  });
});
