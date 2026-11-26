import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CHATGPT_MANAGE_USAGE_URL } from "@/query/hooks/useChatGPTPlan";
import { ChatGPTPlanUsageNote } from "./chatgpt-plan-usage-note";

describe("ChatGPTPlanUsageNote", () => {
  it("names the plan and links its usage while a plan model is chosen", () => {
    const html = renderToStaticMarkup(
      <ChatGPTPlanUsageNote
        model={{
          model_provider: "ChatGPTPlanResponsesHTTPAgent",
          logo_provider: "openai",
        }}
      />,
    );

    expect(html).toContain("Using ChatGPT plan");
    expect(html).toContain(`href="${CHATGPT_MANAGE_USAGE_URL}"`);
    expect(html).toContain("Manage usage");
  });

  it("shows nothing for other models", () => {
    for (const model of [
      { model_provider: "OpenAIResponsesHTTPAgent", logo_provider: "openai" },
      null,
      undefined,
    ])
      expect(renderToStaticMarkup(<ChatGPTPlanUsageNote model={model} />)).toBe(
        "",
      );
  });
});
