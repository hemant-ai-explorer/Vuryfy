-- 0022_widen_api_cost_logs_provider.sql
-- Sept 24, 2026 — closes the "Google Vision API cost isn't logged" gap
-- flagged in an earlier cost-instrumentation pull. lib/web-detection.ts
-- (Google Cloud Vision Web Detection, called from image Deep Investigation)
-- now logs real per-call cost the same way lib/ai-gateway.ts and
-- lib/search-gateway.ts already do, but api_cost_logs.provider's check
-- constraint (0012_api_cost_logs.sql) only allowed 'gemini'/'tavily' —
-- widen it to include 'google_vision'.

alter table api_cost_logs drop constraint api_cost_logs_provider_check;
alter table api_cost_logs add constraint api_cost_logs_provider_check
  check (provider in ('gemini', 'tavily', 'google_vision'));
