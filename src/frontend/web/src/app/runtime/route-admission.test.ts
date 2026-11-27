import { afterEach, describe, expect, it, vi } from "vitest";
import { hostedCapabilitiesFixture } from "./runtime-fixture";
import {
  unavailableReasonText,
  unavailableRouteReason,
} from "./route-admission";
import { Route as PipRoute } from "@/routes/desktop/pip/$animaId";
import { Route as QuickChatRoute } from "@/routes/desktop/quick-chat/$animaId";

describe("native auxiliary route admission", () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each([
    [PipRoute, "pip", "pip"],
    [QuickChatRoute, "quick-chat", "quickChat"],
  ] as const)(
    "preserves the native child route's exact preload role and bridge check (%s)",
    (route, role, member) => {
      const admit = () => {
        const guard = route.options.beforeLoad;
        if (typeof guard === "function") return guard({} as never);
      };
      for (const bridge of [
        undefined,
        { isDesktop: false, windowRole: role, [member]: {} },
        { isDesktop: true, windowRole: "main", [member]: {} },
        { isDesktop: true, windowRole: role },
      ]) {
        vi.stubGlobal("window", { animamaDesktop: bridge });
        expect(admit).toThrow();
      }
      vi.stubGlobal("window", {
        animamaDesktop: { isDesktop: true, windowRole: role, [member]: {} },
      });
      expect(admit).not.toThrow();
    },
  );
  it.each(["/desktop/pip/fixture", "/desktop/quick-chat/fixture"])(
    "lets local %s reach its renderer bridge guard with Compose-shaped capabilities",
    (path) => {
      expect(
        unavailableRouteReason(path, {
          ...hostedCapabilitiesFixture,
          runtime_kind: "self_hosted_web",
          native_features: false,
        }),
      ).toBeNull();
    },
  );
  it.each(["/desktop/pip/fixture", "/desktop/quick-chat/fixture"])(
    "keeps hosted %s excluded",
    (path) => {
      const reason = unavailableRouteReason(path, hostedCapabilitiesFixture);
      expect(reason).toBe("native_features");
      expect(unavailableReasonText(reason!)).toContain("desktop application");
    },
  );
});

describe("the content assistant's route", () => {
  const local = {
    ...hostedCapabilitiesFixture,
    runtime_kind: "self_hosted_web",
  } as const;

  it.each(["/generate", "/generate/"])(
    "offers %s only to a runtime that reports content generation",
    (path) => {
      expect(
        unavailableRouteReason(path, { ...local, content_generation: true }),
      ).toBeNull();
      // Not reported (an older runtime) reads as withheld, like `false`.
      for (const capabilities of [
        local,
        { ...local, content_generation: false },
        hostedCapabilitiesFixture,
      ]) {
        const reason = unavailableRouteReason(path, capabilities);
        expect(reason).toBe("content_generation");
        expect(unavailableReasonText(reason!)).toContain("Content generation");
      }
    },
  );

  it("leaves other routes that only start with the same letters alone", () => {
    expect(unavailableRouteReason("/generated", local)).toBeNull();
    expect(unavailableRouteReason("/gestures/new", local)).toBeNull();
  });
});
