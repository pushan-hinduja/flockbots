-- =============================================================================
-- FlockBots v1.0 — consolidated schema
-- =============================================================================
-- Apply this once in your Supabase project's SQL editor to bootstrap every
-- table, function, policy, index, and realtime publication the dashboard
-- needs. The wizard (`flockbots init`) will open the Supabase SQL editor
-- for you and copy this file to your clipboard.
--
-- Idempotent — safe to re-run. Tracked in flockbots_migrations at 1.0.1.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0. Migration tracking
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS flockbots_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------------------------
-- 1. Core tables — coordinator writes with service role; dashboard reads
-- -----------------------------------------------------------------------------
-- Access model: this Supabase project is dedicated to one FlockBots install,
-- so any row in auth.users = dashboard access. No separate allowlist table.
-- If you ever want to gate access more tightly, re-introduce an allowlist
-- table + policy here. **Important:** disable public email signups in your
-- Supabase project (Authentication → Providers → Email → Enable Sign Ups: off)
-- so only the admin user(s) you create via `flockbots init` can log in.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS flockbots_tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  source TEXT,
  linear_url TEXT,
  status TEXT NOT NULL DEFAULT 'inbox',
  priority INTEGER DEFAULT 2,
  effort_size TEXT,
  dev_model TEXT,
  reviewer_model TEXT,
  use_swarm BOOLEAN DEFAULT FALSE,
  branch_name TEXT,
  pr_url TEXT,
  pr_number INTEGER,
  retry_count INTEGER DEFAULT 0,
  error TEXT,
  parent_task_id TEXT,
  dev_effort TEXT,
  reviewer_effort TEXT,
  affected_files TEXT,
  qa_status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS flockbots_events (
  id BIGSERIAL PRIMARY KEY,
  task_id TEXT REFERENCES flockbots_tasks(id),
  agent TEXT,
  event_type TEXT NOT NULL,
  message TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS flockbots_usage (
  id BIGSERIAL PRIMARY KEY,
  task_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  session_id TEXT,
  model TEXT,
  exit_code INTEGER,
  duration_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS flockbots_escalations (
  id BIGSERIAL PRIMARY KEY,
  task_id TEXT NOT NULL,
  question TEXT NOT NULL,
  context TEXT,
  status TEXT DEFAULT 'pending',
  answer TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  answered_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS flockbots_system_health (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS flockbots_stream_log (
  id BIGSERIAL PRIMARY KEY,
  task_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  session_id TEXT NOT NULL,
  chunk TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Sub-agent spawn log — powers swarm visualization
CREATE TABLE IF NOT EXISTS flockbots_sub_agents (
  id BIGSERIAL PRIMARY KEY,
  task_id TEXT NOT NULL,
  parent_agent TEXT NOT NULL,
  session_id TEXT,
  kind TEXT NOT NULL,
  sub_name TEXT,
  spawn_idx INTEGER,
  tool_use_id TEXT,
  forced BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-operator agent display overrides (sprite / name customizations)
CREATE TABLE IF NOT EXISTS flockbots_customizations (
  agent_id TEXT PRIMARY KEY,
  name TEXT,
  body_row INTEGER,
  hair_row INTEGER,
  suit_row INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Webhook inbox — relay writes incoming chat messages here, coordinator polls
CREATE TABLE IF NOT EXISTS webhook_inbox (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'whatsapp',
  sender TEXT,
  payload JSONB NOT NULL,
  processed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------------------------
-- 2. Indexes
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_flockbots_events_created
  ON flockbots_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_flockbots_stream_log_task_agent
  ON flockbots_stream_log(task_id, agent, created_at);
CREATE INDEX IF NOT EXISTS idx_flockbots_escalations_status
  ON flockbots_escalations(status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_flockbots_tasks_status
  ON flockbots_tasks(status);
CREATE INDEX IF NOT EXISTS idx_flockbots_tasks_parent
  ON flockbots_tasks(parent_task_id) WHERE parent_task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_flockbots_sub_agents_task_id
  ON flockbots_sub_agents(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_flockbots_sub_agents_tool_use
  ON flockbots_sub_agents(tool_use_id) WHERE tool_use_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_webhook_inbox_unprocessed
  ON webhook_inbox(processed, created_at) WHERE processed = FALSE;

-- -----------------------------------------------------------------------------
-- 3. RLS + policies
-- -----------------------------------------------------------------------------
ALTER TABLE flockbots_migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE flockbots_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE flockbots_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE flockbots_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE flockbots_escalations ENABLE ROW LEVEL SECURITY;
ALTER TABLE flockbots_system_health ENABLE ROW LEVEL SECURITY;
ALTER TABLE flockbots_stream_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE flockbots_sub_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE flockbots_customizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_inbox ENABLE ROW LEVEL SECURITY;

-- Read policies (any authenticated user — the Supabase project is dedicated
-- to this FlockBots install, so auth.users membership = dashboard access)
DROP POLICY IF EXISTS "Authenticated users can read tasks" ON flockbots_tasks;
CREATE POLICY "Authenticated users can read tasks"
  ON flockbots_tasks FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "Authenticated users can read events" ON flockbots_events;
CREATE POLICY "Authenticated users can read events"
  ON flockbots_events FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "Authenticated users can read usage" ON flockbots_usage;
CREATE POLICY "Authenticated users can read usage"
  ON flockbots_usage FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "Authenticated users can read escalations" ON flockbots_escalations;
CREATE POLICY "Authenticated users can read escalations"
  ON flockbots_escalations FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "Authenticated users can read health" ON flockbots_system_health;
CREATE POLICY "Authenticated users can read health"
  ON flockbots_system_health FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "Authenticated users can read stream log" ON flockbots_stream_log;
CREATE POLICY "Authenticated users can read stream log"
  ON flockbots_stream_log FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "Authenticated users read sub-agents" ON flockbots_sub_agents;
CREATE POLICY "Authenticated users read sub-agents"
  ON flockbots_sub_agents FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "Authenticated users read customizations" ON flockbots_customizations;
CREATE POLICY "Authenticated users read customizations"
  ON flockbots_customizations FOR SELECT TO authenticated
  USING (true);

-- Customizations: authenticated users can upsert/update (their own UI prefs)
DROP POLICY IF EXISTS "Authenticated users upsert customizations" ON flockbots_customizations;
CREATE POLICY "Authenticated users upsert customizations"
  ON flockbots_customizations FOR INSERT TO authenticated
  WITH CHECK (true);

DROP POLICY IF EXISTS "Authenticated users update customizations" ON flockbots_customizations;
CREATE POLICY "Authenticated users update customizations"
  ON flockbots_customizations FOR UPDATE TO authenticated
  USING (true)
  WITH CHECK (true);

-- Service role writes (coordinator uses service role key)
DROP POLICY IF EXISTS "Service role can insert tasks" ON flockbots_tasks;
CREATE POLICY "Service role can insert tasks"
  ON flockbots_tasks FOR INSERT TO service_role WITH CHECK (true);

DROP POLICY IF EXISTS "Service role can update tasks" ON flockbots_tasks;
CREATE POLICY "Service role can update tasks"
  ON flockbots_tasks FOR UPDATE TO service_role USING (true);

DROP POLICY IF EXISTS "Service role can insert events" ON flockbots_events;
CREATE POLICY "Service role can insert events"
  ON flockbots_events FOR INSERT TO service_role WITH CHECK (true);

DROP POLICY IF EXISTS "Service role can insert usage" ON flockbots_usage;
CREATE POLICY "Service role can insert usage"
  ON flockbots_usage FOR INSERT TO service_role WITH CHECK (true);

DROP POLICY IF EXISTS "Service role can manage escalations" ON flockbots_escalations;
CREATE POLICY "Service role can manage escalations"
  ON flockbots_escalations FOR ALL TO service_role USING (true);

DROP POLICY IF EXISTS "Service role can manage health" ON flockbots_system_health;
CREATE POLICY "Service role can manage health"
  ON flockbots_system_health FOR ALL TO service_role USING (true);

DROP POLICY IF EXISTS "Service role can manage stream log" ON flockbots_stream_log;
CREATE POLICY "Service role can manage stream log"
  ON flockbots_stream_log FOR ALL TO service_role USING (true);

DROP POLICY IF EXISTS "Service role manages sub-agents" ON flockbots_sub_agents;
CREATE POLICY "Service role manages sub-agents"
  ON flockbots_sub_agents FOR ALL TO service_role USING (true);

DROP POLICY IF EXISTS "Service role manages customizations" ON flockbots_customizations;
CREATE POLICY "Service role manages customizations"
  ON flockbots_customizations FOR ALL TO service_role USING (true);

-- Webhook inbox: service role full access; authenticated users can insert dashboard actions
DROP POLICY IF EXISTS "Service role can manage webhook inbox" ON webhook_inbox;
CREATE POLICY "Service role can manage webhook inbox"
  ON webhook_inbox FOR ALL TO service_role USING (true);

DROP POLICY IF EXISTS "Authenticated users can insert dashboard actions" ON webhook_inbox;
CREATE POLICY "Authenticated users can insert dashboard actions"
  ON webhook_inbox FOR INSERT TO authenticated
  WITH CHECK (source = 'dashboard');

-- -----------------------------------------------------------------------------
-- 4. Realtime publications (dashboard subscribes via Supabase realtime)
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  PERFORM 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'flockbots_tasks';
  IF NOT FOUND THEN ALTER PUBLICATION supabase_realtime ADD TABLE flockbots_tasks; END IF;

  PERFORM 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'flockbots_events';
  IF NOT FOUND THEN ALTER PUBLICATION supabase_realtime ADD TABLE flockbots_events; END IF;

  PERFORM 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'flockbots_stream_log';
  IF NOT FOUND THEN ALTER PUBLICATION supabase_realtime ADD TABLE flockbots_stream_log; END IF;

  PERFORM 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'flockbots_usage';
  IF NOT FOUND THEN ALTER PUBLICATION supabase_realtime ADD TABLE flockbots_usage; END IF;

  PERFORM 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'flockbots_escalations';
  IF NOT FOUND THEN ALTER PUBLICATION supabase_realtime ADD TABLE flockbots_escalations; END IF;

  PERFORM 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'flockbots_system_health';
  IF NOT FOUND THEN ALTER PUBLICATION supabase_realtime ADD TABLE flockbots_system_health; END IF;

  PERFORM 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'flockbots_sub_agents';
  IF NOT FOUND THEN ALTER PUBLICATION supabase_realtime ADD TABLE flockbots_sub_agents; END IF;

  PERFORM 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'flockbots_customizations';
  IF NOT FOUND THEN ALTER PUBLICATION supabase_realtime ADD TABLE flockbots_customizations; END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 5. Storage bucket for QA screenshots + videos
-- -----------------------------------------------------------------------------
-- Private bucket. The coordinator (service role) uploads screenshots + short
-- video clips from the QA agent and generates time-limited signed URLs to
-- send through the chat provider. Dashboard users never access the bucket
-- directly — signed URLs are the only read path.
INSERT INTO storage.buckets (id, name, public)
  VALUES ('qa-media', 'qa-media', false)
  ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Service role manages qa-media" ON storage.objects;
CREATE POLICY "Service role manages qa-media"
  ON storage.objects FOR ALL TO service_role
  USING (bucket_id = 'qa-media')
  WITH CHECK (bucket_id = 'qa-media');

-- -----------------------------------------------------------------------------
-- 6. Record this migration
-- -----------------------------------------------------------------------------
INSERT INTO flockbots_migrations (version) VALUES ('1.0.1')
  ON CONFLICT (version) DO NOTHING;
