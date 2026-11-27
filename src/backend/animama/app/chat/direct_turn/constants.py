"""Shared constants for the direct chat turn runtime."""

from animama.app.chat.api_standard import ANTHROPIC_MESSAGES_PROVIDER_TYPE, CHATGPT_PLAN_RESPONSES_PROVIDER_TYPE

DIRECT_CHAT_NODE_ID = "direct-chat:model-client"

OPENAI_RESPONSES_PROVIDER = "OpenAIResponsesHTTPAgent"
OPENAI_CHAT_COMPLETIONS_PROVIDER = "OpenAIHTTPAgent"
ANTHROPIC_MESSAGES_PROVIDER = ANTHROPIC_MESSAGES_PROVIDER_TYPE
# Not in NATIVE_COMPACTION_PROVIDERS: the plan route was not shown to compact, so the app fits its prompts.
CHATGPT_PLAN_PROVIDER = CHATGPT_PLAN_RESPONSES_PROVIDER_TYPE
MOCK_MODEL_PROVIDER = "MockModelClient"
# Requested through `native_tools`; hosted by OpenAI Responses or Anthropic, otherwise the application tool.
WEB_SEARCH_NATIVE_TOOL = "web_search"

# Providers whose server compacts long chats (OpenAI Responses and Anthropic
# Messages): the application neither fits their prompts to the window nor runs
# its own compaction for them.
NATIVE_COMPACTION_PROVIDERS = frozenset({OPENAI_RESPONSES_PROVIDER, ANTHROPIC_MESSAGES_PROVIDER})

DIRECT_MEMORY_TOOL_SUPPORT_BY_PROVIDER = frozenset(
    {
        OPENAI_RESPONSES_PROVIDER,
        OPENAI_CHAT_COMPLETIONS_PROVIDER,
        ANTHROPIC_MESSAGES_PROVIDER,
        CHATGPT_PLAN_PROVIDER,
        MOCK_MODEL_PROVIDER,
    }
)

MAX_MEMORY_TOOL_ROUNDS = 4
CONTEXT_LIMIT_FINAL_INSTRUCTION = (
    "The tool results do not fit the model's context window. Produce the required final structured response "
    "from what you already know, and say briefly if you could not look something up. Do not request more tools."
)
MEMORY_TOOL_LIMIT_FINAL_INSTRUCTION = (
    "Tool round limit reached. Use the tool results already provided in this turn to produce the "
    "required final structured response. Do not request more tools."
)

# One extra request per turn when the final reply fails local validation.
STRUCTURED_REPLY_REPAIR_ROUND_INDEX = MAX_MEMORY_TOOL_ROUNDS + 2
STRUCTURED_REPLY_REPAIR_INSTRUCTION = (
    "The last reply did not match the required response format. Reply to the user again with only one valid "
    "JSON object in the required shape, with the fields in the required order and no markdown or text outside it."
)
# Final metadata recording the repair outcome: "attempted" or "request_failed".
STRUCTURED_REPAIR_METADATA_KEY = "structured_repair"
