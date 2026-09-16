-- Semantic cache — Part 11's deferred "Semantic" layer of the three-layer
-- cache (Exact/Semantic/Evidence), Part 26.4 addition #2. Deferred at
-- Phase 1 (Sept 14, 2026, see architecture-decisions.md "Caching, Phase 1")
-- for lack of real usage data to tune a safe similarity threshold safely.
-- Built Sept 16, 2026.
--
-- Design mirrors verification_cache_exact (0001_init.sql) as closely as
-- possible: a cache row references a verification_id rather than storing
-- the verdict/evidence itself, so there is exactly one place (the
-- verifications table) that owns the actual result content. The
-- difference is the lookup key: instead of an exact sha256 hash, a match
-- is "this new claim's embedding is cosine-similar enough to an existing
-- cached claim's embedding, within the same input_type and engine_version
-- namespace" — see lib/verification-cache.ts's getSemanticCacheMatch for
-- the application-side half of this, and its own header comment for why
-- the match threshold starts conservative (0.95) rather than tuned.
--
-- engine_version is included in the WHERE clause of the match function
-- below for the exact same reason it's part of the exact-cache key: a
-- change to which model/prompt/schema serves a tier must never be able to
-- silently keep matching against pre-change semantic-cache rows. See
-- architecture-decisions.md "Model-tier differentiation fix" for the real
-- incident that made this lesson concrete for the exact-cache layer — it
-- applies identically here.

create extension if not exists vector;

create table if not exists verification_cache_semantic (
  id uuid primary key default gen_random_uuid(),
  input_type text not null,
  engine_version text not null,
  normalized_claim text not null,
  embedding vector(768) not null,
  verification_id uuid not null references verifications(id) on delete cascade,
  freshness_class text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

comment on table verification_cache_semantic is
  'Semantic-match cache (Part 11 "Semantic" layer). One row per real pipeline run (never re-written on a hit, same convention as verification_cache_exact) storing that claim''s embedding so a later, differently-worded but semantically equivalent claim can reuse the same verdict without a fresh Gemini+Tavily call. Matched via match_verification_cache() below, using pgvector cosine distance.';

-- Same RLS convention as every other table in this schema (0001_init.sql):
-- enabled, zero policies — only the service_role client (via API routes)
-- can touch this table, never the anon/authenticated roles directly.
alter table verification_cache_semantic enable row level security;

-- HNSW over ivfflat — Supabase's current general recommendation for
-- pgvector similarity search (better recall/latency tradeoff, no
-- training-list-size tuning needed the way ivfflat requires). Cosine
-- distance (vector_cosine_ops) matches getSemanticCacheMatch's
-- `1 - (embedding <=> query_embedding)` similarity calculation below.
create index if not exists verification_cache_semantic_embedding_idx
  on verification_cache_semantic
  using hnsw (embedding vector_cosine_ops);

-- Composite index for the namespace filter (input_type + engine_version +
-- expires_at) the match function applies before/alongside the vector
-- search — keeps a large cache table from forcing a full vector scan
-- across every input_type/engine_version combination at once.
create index if not exists verification_cache_semantic_namespace_idx
  on verification_cache_semantic (input_type, engine_version, expires_at);

-- Match function — same reason Supabase's own semantic-search cookbook
-- uses an RPC function rather than a direct REST query: PostgREST/
-- supabase-js can pass a plain JS number[] to a `vector` parameter here
-- (pgvector defines the array->vector cast this relies on), which a direct
-- .select() on the table cannot do as cleanly. Returns at most
-- match_count rows, most-similar first, restricted to non-expired rows in
-- the same input_type/engine_version namespace with similarity strictly
-- above match_threshold.
create or replace function match_verification_cache(
  query_embedding vector(768),
  p_input_type text,
  p_engine_version text,
  match_threshold float,
  match_count int default 1
)
returns table (
  verification_id uuid,
  similarity float,
  created_at timestamptz
)
language sql
stable
as $$
  select
    verification_id,
    1 - (embedding <=> query_embedding) as similarity,
    created_at
  from verification_cache_semantic
  where input_type = p_input_type
    and engine_version = p_engine_version
    and expires_at > now()
    and 1 - (embedding <=> query_embedding) > match_threshold
  order by embedding <=> query_embedding
  limit match_count;
$$;

-- Write-side RPC, for the same reason as the match function above (a
-- vector-typed parameter, not a direct table insert) — see
-- lib/verification-cache.ts's writeSemanticCache. Upserts nothing (unlike
-- verification_cache_exact, there is no natural unique key to upsert on —
-- each real pipeline run gets its own semantic-cache row, which is fine:
-- a slightly denser embedding index only improves future match recall).
create or replace function upsert_verification_cache_semantic(
  p_input_type text,
  p_engine_version text,
  p_normalized_claim text,
  p_embedding vector(768),
  p_verification_id uuid,
  p_freshness_class text,
  p_expires_at timestamptz
)
returns void
language sql
as $$
  insert into verification_cache_semantic (
    input_type, engine_version, normalized_claim, embedding,
    verification_id, freshness_class, expires_at
  )
  values (
    p_input_type, p_engine_version, p_normalized_claim, p_embedding,
    p_verification_id, p_freshness_class, p_expires_at
  );
$$;

-- Same service_role grants every prior migration's new tables/functions
-- need (see architecture-decisions.md's "service_role had no table
-- privileges" bug fix for why this is explicit rather than assumed) —
-- belt-and-suspenders alongside the ALTER DEFAULT PRIVILEGES statements
-- already run against both vuryfy-test and vuryfy-prod.
grant all on verification_cache_semantic to service_role;
grant execute on function match_verification_cache to service_role;
grant execute on function upsert_verification_cache_semantic to service_role;
