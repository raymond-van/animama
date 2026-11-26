-- Seed the built-in model connections and their provider/model catalog rows after
-- Alembic creates the tables. Only built-in rows are inserted, updated or retired;
-- owner-added connections and models, and the owner's hidden and Compact early
-- flags, are never changed. A newly inserted built-in Chat Completions chat row
-- starts hidden.
-- Generated from animama.app.model_catalog serializers by tests/test_model_provider_catalog.py.
INSERT INTO model_connections (
    id,
    source,
    name,
    preset,
    base_url,
    credential_env,
    compatibility,
    timeout_seconds,
    active
) VALUES
    ('openai', 'builtin', 'OpenAI', 'openai', NULL, NULL, '{"fold_developer_role":false,"reasoning_mode":"openai_effort","send_openai_extensions":true,"send_stream_usage":true,"strip_function_strict":false}'::jsonb, NULL, TRUE),
    ('anthropic', 'builtin', 'Anthropic', 'anthropic', NULL, NULL, '{"fold_developer_role":false,"reasoning_mode":"omit","send_openai_extensions":false,"send_stream_usage":false,"strip_function_strict":false}'::jsonb, NULL, TRUE),
    ('chatgpt_plan', 'builtin', 'ChatGPT plan', 'chatgpt_plan', NULL, NULL, '{"fold_developer_role":false,"reasoning_mode":"openai_effort","send_openai_extensions":true,"send_stream_usage":true,"strip_function_strict":false}'::jsonb, NULL, TRUE)
ON CONFLICT (id) DO UPDATE SET
    source = EXCLUDED.source,
    name = EXCLUDED.name,
    preset = EXCLUDED.preset,
    base_url = EXCLUDED.base_url,
    credential_env = EXCLUDED.credential_env,
    compatibility = EXCLUDED.compatibility,
    timeout_seconds = EXCLUDED.timeout_seconds,
    active = EXCLUDED.active,
    updated_at = CURRENT_TIMESTAMP
WHERE model_connections.source = 'builtin';

INSERT INTO model_providers (
    id,
    model,
    provider_type,
    model_label,
    provider_label,
    logo_provider,
    model_type,
    current_snapshot,
    context_window_tokens,
    max_output_tokens,
    connection_id,
    source,
    model_kind,
    hidden,
    early_compaction,
    service_tiers_supported,
    active,
    deprecated_at,
    accepts,
    produces,
    supports_developer_role,
    supports_tools,
    supports_streaming,
    structured_kinds,
    structured_output_transport,
    supports_reasoning,
    supported_reasoning_efforts,
    native_tool_support,
    pricing_status,
    pricing_source_provider,
    pricing_source_model,
    pricing_source_url,
    pricing_source_checked_at,
    currency,
    billing_unit,
    standard_input_price_per_million,
    standard_cached_input_price_per_million,
    standard_output_price_per_million,
    batch_input_price_per_million,
    batch_cached_input_price_per_million,
    batch_output_price_per_million,
    flex_input_price_per_million,
    flex_cached_input_price_per_million,
    flex_output_price_per_million,
    priority_input_price_per_million,
    priority_cached_input_price_per_million,
    priority_output_price_per_million,
    long_context_token_threshold,
    standard_long_context_input_price_per_million,
    standard_long_context_cached_input_price_per_million,
    standard_long_context_output_price_per_million,
    batch_long_context_input_price_per_million,
    batch_long_context_cached_input_price_per_million,
    batch_long_context_output_price_per_million,
    flex_long_context_input_price_per_million,
    flex_long_context_cached_input_price_per_million,
    flex_long_context_output_price_per_million,
    priority_long_context_input_price_per_million,
    priority_long_context_cached_input_price_per_million,
    priority_long_context_output_price_per_million,
    regional_processing_uplift_factor,
    pricing_notes,
    metadata
) VALUES
    ('AnthropicMessagesHTTPAgent:claude-haiku-5-5', 'claude-haiku-5-5', 'AnthropicMessagesHTTPAgent', 'claude-haiku-5-5', 'Anthropic', 'anthropic', 'reasoning', 'claude-haiku-5-5', 1000000, 128000, 'anthropic', 'builtin', 'chat', FALSE, TRUE, '["standard","batch"]'::json, TRUE, NULL, '["image","text"]'::json, '["text"]'::json, TRUE, TRUE, TRUE, '["main_structured_response"]'::json, 'json_schema', TRUE, '["none","low","medium","high","xhigh","max"]'::json, '["web_search"]'::json, 'priced', 'anthropic', 'claude-haiku-5-5', 'https://platform.claude.com/docs/en/about-claude/pricing', '2026-10-08', 'USD', '1M_tokens', 0.10, 0.01, 0.50, 0.05, 0.005, 0.25, NULL, NULL, NULL, NULL, NULL, NULL, 100000, 0.50, 0.05, 2.50, 0.25, 0.025, 1.25, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '["Batch rates are half the standard rates.","Prompt-cache write rates are not recorded and are not estimated.","Requests above 100,000 prompt tokens bill every token at the long-context rates.","Web search is billed separately per search and is not estimated."]'::json, '{}'::json),
    ('OpenAIHTTPAgent:gpt-6-luna', 'gpt-6-luna', 'OpenAIHTTPAgent', 'gpt-6-luna', 'OpenAI HTTP', 'openai', 'reasoning', 'gpt-6-luna', 1050000, 128000, 'openai', 'builtin', 'chat', TRUE, TRUE, '["standard"]'::json, TRUE, NULL, '["image","text"]'::json, '["text"]'::json, TRUE, TRUE, TRUE, '["main_structured_response"]'::json, 'json_schema', TRUE, '["none","low","medium","high","xhigh","max"]'::json, NULL, 'priced', 'openai', 'gpt-6-luna', NULL, '2026-09-28', 'USD', '1M_tokens', 0.10, 0.01, 0.50, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '["Prompt-cache write, batch, flex, priority and long-context rates are not recorded and are not estimated.","Standard input and output rates were supplied by the owner on 2026-09-28.","The cached-input rate ($0.01 per 1M tokens) comes from secondary sources and awaits owner confirmation."]'::json, '{}'::json),
    ('OpenAIHTTPAgent:text-embedding-3-large', 'text-embedding-3-large', 'OpenAIHTTPAgent', 'text-embedding-3-large', 'OpenAI HTTP', 'openai', NULL, NULL, NULL, NULL, 'openai', 'builtin', 'embedding', FALSE, TRUE, '[]'::json, TRUE, NULL, '["text"]'::json, '["embedding"]'::json, TRUE, FALSE, FALSE, '[]'::json, NULL, NULL, NULL, NULL, 'unpriced', 'openai', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '[]'::json, '{}'::json),
    ('OpenAIHTTPAgent:text-embedding-3-small', 'text-embedding-3-small', 'OpenAIHTTPAgent', 'text-embedding-3-small', 'OpenAI HTTP', 'openai', NULL, NULL, NULL, NULL, 'openai', 'builtin', 'embedding', FALSE, TRUE, '[]'::json, TRUE, NULL, '["text"]'::json, '["embedding"]'::json, TRUE, FALSE, FALSE, '[]'::json, NULL, NULL, NULL, NULL, 'unpriced', 'openai', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '[]'::json, '{}'::json),
    ('OpenAIResponsesHTTPAgent:gpt-6-luna', 'gpt-6-luna', 'OpenAIResponsesHTTPAgent', 'gpt-6-luna', 'OpenAI Responses HTTP', 'openai', 'reasoning', 'gpt-6-luna', 1050000, 128000, 'openai', 'builtin', 'chat', FALSE, TRUE, '["standard"]'::json, TRUE, NULL, '["image","text"]'::json, '["text"]'::json, TRUE, TRUE, TRUE, '["main_structured_response"]'::json, 'json_schema', TRUE, '["none","low","medium","high","xhigh","max"]'::json, '["apply_patch","web_search"]'::json, 'priced', 'openai', 'gpt-6-luna', NULL, '2026-09-28', 'USD', '1M_tokens', 0.10, 0.01, 0.50, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '["Prompt-cache write, batch, flex, priority and long-context rates are not recorded and are not estimated.","Standard input and output rates were supplied by the owner on 2026-09-28.","The cached-input rate ($0.01 per 1M tokens) comes from secondary sources and awaits owner confirmation."]'::json, '{}'::json)
ON CONFLICT (id) DO UPDATE SET
    model = EXCLUDED.model,
    provider_type = EXCLUDED.provider_type,
    model_label = EXCLUDED.model_label,
    provider_label = EXCLUDED.provider_label,
    logo_provider = EXCLUDED.logo_provider,
    model_type = EXCLUDED.model_type,
    current_snapshot = EXCLUDED.current_snapshot,
    context_window_tokens = EXCLUDED.context_window_tokens,
    max_output_tokens = EXCLUDED.max_output_tokens,
    model_kind = EXCLUDED.model_kind,
    service_tiers_supported = EXCLUDED.service_tiers_supported,
    active = EXCLUDED.active,
    deprecated_at = EXCLUDED.deprecated_at,
    accepts = EXCLUDED.accepts,
    produces = EXCLUDED.produces,
    supports_developer_role = EXCLUDED.supports_developer_role,
    supports_tools = EXCLUDED.supports_tools,
    supports_streaming = EXCLUDED.supports_streaming,
    structured_kinds = EXCLUDED.structured_kinds,
    structured_output_transport = EXCLUDED.structured_output_transport,
    supports_reasoning = EXCLUDED.supports_reasoning,
    supported_reasoning_efforts = EXCLUDED.supported_reasoning_efforts,
    native_tool_support = EXCLUDED.native_tool_support,
    pricing_status = EXCLUDED.pricing_status,
    pricing_source_provider = EXCLUDED.pricing_source_provider,
    pricing_source_model = EXCLUDED.pricing_source_model,
    pricing_source_url = EXCLUDED.pricing_source_url,
    pricing_source_checked_at = EXCLUDED.pricing_source_checked_at,
    currency = EXCLUDED.currency,
    billing_unit = EXCLUDED.billing_unit,
    standard_input_price_per_million = EXCLUDED.standard_input_price_per_million,
    standard_cached_input_price_per_million = EXCLUDED.standard_cached_input_price_per_million,
    standard_output_price_per_million = EXCLUDED.standard_output_price_per_million,
    batch_input_price_per_million = EXCLUDED.batch_input_price_per_million,
    batch_cached_input_price_per_million = EXCLUDED.batch_cached_input_price_per_million,
    batch_output_price_per_million = EXCLUDED.batch_output_price_per_million,
    flex_input_price_per_million = EXCLUDED.flex_input_price_per_million,
    flex_cached_input_price_per_million = EXCLUDED.flex_cached_input_price_per_million,
    flex_output_price_per_million = EXCLUDED.flex_output_price_per_million,
    priority_input_price_per_million = EXCLUDED.priority_input_price_per_million,
    priority_cached_input_price_per_million = EXCLUDED.priority_cached_input_price_per_million,
    priority_output_price_per_million = EXCLUDED.priority_output_price_per_million,
    long_context_token_threshold = EXCLUDED.long_context_token_threshold,
    standard_long_context_input_price_per_million = EXCLUDED.standard_long_context_input_price_per_million,
    standard_long_context_cached_input_price_per_million = EXCLUDED.standard_long_context_cached_input_price_per_million,
    standard_long_context_output_price_per_million = EXCLUDED.standard_long_context_output_price_per_million,
    batch_long_context_input_price_per_million = EXCLUDED.batch_long_context_input_price_per_million,
    batch_long_context_cached_input_price_per_million = EXCLUDED.batch_long_context_cached_input_price_per_million,
    batch_long_context_output_price_per_million = EXCLUDED.batch_long_context_output_price_per_million,
    flex_long_context_input_price_per_million = EXCLUDED.flex_long_context_input_price_per_million,
    flex_long_context_cached_input_price_per_million = EXCLUDED.flex_long_context_cached_input_price_per_million,
    flex_long_context_output_price_per_million = EXCLUDED.flex_long_context_output_price_per_million,
    priority_long_context_input_price_per_million = EXCLUDED.priority_long_context_input_price_per_million,
    priority_long_context_cached_input_price_per_million = EXCLUDED.priority_long_context_cached_input_price_per_million,
    priority_long_context_output_price_per_million = EXCLUDED.priority_long_context_output_price_per_million,
    regional_processing_uplift_factor = EXCLUDED.regional_processing_uplift_factor,
    pricing_notes = EXCLUDED.pricing_notes,
    metadata = EXCLUDED.metadata,
    updated_at = CURRENT_TIMESTAMP
WHERE model_providers.source = 'builtin';

-- Retire built-in rows that the current release no longer ships. The ChatGPT plan
-- connection's rows are listed from the signed-in account at run time, not shipped.
UPDATE model_providers SET
    active = FALSE,
    deprecated_at = COALESCE(deprecated_at, CURRENT_TIMESTAMP),
    updated_at = CURRENT_TIMESTAMP
WHERE source = 'builtin' AND active AND connection_id <> 'chatgpt_plan'
    AND id NOT IN ('AnthropicMessagesHTTPAgent:claude-haiku-5-5', 'OpenAIHTTPAgent:gpt-6-luna', 'OpenAIHTTPAgent:text-embedding-3-large', 'OpenAIHTTPAgent:text-embedding-3-small', 'OpenAIResponsesHTTPAgent:gpt-6-luna');

-- Move Animas and the owner's chat-model roles off retired built-in rows onto the
-- current built-in row on the same API, so existing installations keep chatting.
UPDATE anima_chat_profiles AS profile SET
    default_model_provider_id = remap.replacement_id,
    reasoning_effort = NULL,
    updated_at = CURRENT_TIMESTAMP
FROM (VALUES
    ('OpenAIHTTPAgent:gpt-5-nano', 'OpenAIHTTPAgent:gpt-6-luna'),
    ('OpenAIHTTPAgent:gpt-5.4-nano', 'OpenAIHTTPAgent:gpt-6-luna'),
    ('OpenAIResponsesHTTPAgent:gpt-5-nano', 'OpenAIResponsesHTTPAgent:gpt-6-luna'),
    ('OpenAIResponsesHTTPAgent:gpt-5.4-nano', 'OpenAIResponsesHTTPAgent:gpt-6-luna'),
    ('OpenAIResponsesHTTPAgent:gpt-5.6-luna', 'OpenAIResponsesHTTPAgent:gpt-6-luna'),
    ('OpenAIResponsesHTTPAgent:gpt-5.6-terra', 'OpenAIResponsesHTTPAgent:gpt-6-luna')
) AS remap(retired_id, replacement_id)
WHERE profile.default_model_provider_id = remap.retired_id;

UPDATE user_settings AS settings SET
    preferences = jsonb_set(settings.preferences, '{chat,default_model_provider_id}', to_jsonb(remap.replacement_id)),
    updated_at = CURRENT_TIMESTAMP
FROM (VALUES
    ('OpenAIHTTPAgent:gpt-5-nano', 'OpenAIHTTPAgent:gpt-6-luna'),
    ('OpenAIHTTPAgent:gpt-5.4-nano', 'OpenAIHTTPAgent:gpt-6-luna'),
    ('OpenAIResponsesHTTPAgent:gpt-5-nano', 'OpenAIResponsesHTTPAgent:gpt-6-luna'),
    ('OpenAIResponsesHTTPAgent:gpt-5.4-nano', 'OpenAIResponsesHTTPAgent:gpt-6-luna'),
    ('OpenAIResponsesHTTPAgent:gpt-5.6-luna', 'OpenAIResponsesHTTPAgent:gpt-6-luna'),
    ('OpenAIResponsesHTTPAgent:gpt-5.6-terra', 'OpenAIResponsesHTTPAgent:gpt-6-luna')
) AS remap(retired_id, replacement_id)
WHERE settings.preferences #>> '{chat,default_model_provider_id}' = remap.retired_id;

UPDATE user_settings AS settings SET
    preferences = jsonb_set(settings.preferences, '{models,utility_model_provider_id}', to_jsonb(remap.replacement_id)),
    updated_at = CURRENT_TIMESTAMP
FROM (VALUES
    ('OpenAIHTTPAgent:gpt-5-nano', 'OpenAIHTTPAgent:gpt-6-luna'),
    ('OpenAIHTTPAgent:gpt-5.4-nano', 'OpenAIHTTPAgent:gpt-6-luna'),
    ('OpenAIResponsesHTTPAgent:gpt-5-nano', 'OpenAIResponsesHTTPAgent:gpt-6-luna'),
    ('OpenAIResponsesHTTPAgent:gpt-5.4-nano', 'OpenAIResponsesHTTPAgent:gpt-6-luna'),
    ('OpenAIResponsesHTTPAgent:gpt-5.6-luna', 'OpenAIResponsesHTTPAgent:gpt-6-luna'),
    ('OpenAIResponsesHTTPAgent:gpt-5.6-terra', 'OpenAIResponsesHTTPAgent:gpt-6-luna')
) AS remap(retired_id, replacement_id)
WHERE settings.preferences #>> '{models,utility_model_provider_id}' = remap.retired_id;

UPDATE user_settings AS settings SET
    preferences = jsonb_set(settings.preferences, '{models,memory_manager_model_provider_id}', to_jsonb(remap.replacement_id)),
    updated_at = CURRENT_TIMESTAMP
FROM (VALUES
    ('OpenAIHTTPAgent:gpt-5-nano', 'OpenAIHTTPAgent:gpt-6-luna'),
    ('OpenAIHTTPAgent:gpt-5.4-nano', 'OpenAIHTTPAgent:gpt-6-luna'),
    ('OpenAIResponsesHTTPAgent:gpt-5-nano', 'OpenAIResponsesHTTPAgent:gpt-6-luna'),
    ('OpenAIResponsesHTTPAgent:gpt-5.4-nano', 'OpenAIResponsesHTTPAgent:gpt-6-luna'),
    ('OpenAIResponsesHTTPAgent:gpt-5.6-luna', 'OpenAIResponsesHTTPAgent:gpt-6-luna'),
    ('OpenAIResponsesHTTPAgent:gpt-5.6-terra', 'OpenAIResponsesHTTPAgent:gpt-6-luna')
) AS remap(retired_id, replacement_id)
WHERE settings.preferences #>> '{models,memory_manager_model_provider_id}' = remap.retired_id;
