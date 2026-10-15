import { describe, expect, it, vi } from "vitest";
import { hostedLocaleInput, readHostedStartup } from "./hosted-context";

describe("early hosted display context", () => {
  it("uses the original same-origin transport and leaves a reusable admission response", async () => {
    const context = {
      schema_version: 1,
      state: "session_required",
      locale: { preference: null, visitor: "ja" },
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(context),
    );
    const startup = await readHostedStartup("https://app.example.test", fetch);
    const request = fetch.mock.calls[0]![0] as Request;
    expect(request.url).toBe(
      "https://app.example.test/v1/hosted/runtime-context",
    );
    expect(request.credentials).toBe("same-origin");
    expect(request.cache).toBe("no-store");
    expect(request.redirect).toBe("error");
    expect(startup.locale).toEqual(context.locale);
    expect(await startup.response?.json()).toEqual(context);
  });

  it("distinguishes missing extension from an unavailable read and validates hints individually", async () => {
    expect(hostedLocaleInput({ state: "active" })).toBeUndefined();
    expect(
      hostedLocaleInput({ locale: { preference: "ja-JP", visitor: "ko" } }),
    ).toEqual({ preference: null, visitor: "ko" });
    expect(
      hostedLocaleInput({ locale: { preference: "ja", visitor: 7 } }),
    ).toEqual({ preference: "ja", visitor: null });
    const failed = await readHostedStartup(
      "https://app.example.test",
      vi.fn().mockRejectedValue(new TypeError("offline")),
    );
    expect(failed.locale).toBeNull();
    expect(failed.response).toBeUndefined();
    const legacy = await readHostedStartup(
      "https://app.example.test",
      vi.fn(async () => Response.json({ schema_version: 1 })),
    );
    expect(legacy.locale).toBeUndefined();
  });
});
