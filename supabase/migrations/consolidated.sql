-- =============================================================================
-- FlockBots v1.0 — consolidated schema
-- =============================================================================
-- Apply this once in your Supabase project's SQL editor to bootstrap every
-- table, function, policy, index, and realtime publication the dashboard
-- needs. The wizard (`flockbots init`) will open the Supabase SQL editor
-- for you and copy this file to your clipboard.
--
-- Idempotent — safe to re-run. Tracked in flockbots_migrations at 1.0.0.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0. Migration tracking
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS flockbots_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------------------------
-- 1. Access allowlist + helper function
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS flockbots_console_access (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  granted_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE flockbots_console_access ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can check own access" ON flockbots_console_access;
CREATE POLICY "Users can check own access"
  ON flockbots_console_access FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Service role manages access" ON flockbots_console_access;
CREATE POLICY "Service role manages access"
  ON flockbots_console_access FOR ALL
  TO service_role
  USING (true);

CREATE OR REPLACE FUNCTION has_flockbots_console_access()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM flockbots_console_access WHERE user_id = auth.uid()
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- -----------------------------------------------------------------------------
-- 2. Core tables — coordinator writes with service role; dashboard reads
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
-- 3. Indexes
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
-- 4. RLS + policies
-- -----------------------------------------------------------------------------
ALTER TABLE flockbots_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE flockbots_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE flockbots_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE flockbots_escalations ENABLE ROW LEVEL SECURITY;
ALTER TABLE flockbots_system_health ENABLE ROW LEVEL SECURITY;
ALTER TABLE flockbots_stream_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE flockbots_sub_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE flockbots_customizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_inbox ENABLE ROW LEVEL SECURITY;

-- Read policies (allowlisted authenticated users)
DROP POLICY IF EXISTS "Allowlisted users can read tasks" ON flockbots_tasks;
CREATE POLICY "Allowlisted users can read tasks"
  ON flockbots_tasks FOR SELECT TO authenticated
  USING (has_flockbots_console_access());

DROP POLICY IF EXISTS "Allowlisted users can read events" ON flockbots_events;
CREATE POLICY "Allowlisted users can read events"
  ON flockbots_events FOR SELECT TO authenticated
  USING (has_flockbots_console_access());

DROP POLICY IF EXISTS "Allowlisted users can read usage" ON flockbots_usage;
CREATE POLICY "Allowlisted users can read usage"
  ON flockbots_usage FOR SELECT TO authenticated
  USING (has_flockbots_console_access());

DROP POLICY IF EXISTS "Allowlisted users can read escalations" ON flockbots_escalations;
CREATE POLICY "Allowlisted users can read escalations"
  ON flockbots_escalations FOR SELECT TO authenticated
  USING (has_flockbots_console_access());

DROP POLICY IF EXISTS "Allowlisted users can read health" ON flockbots_system_health;
CREATE POLICY "Allowlisted users can read health"
  ON flockbots_system_health FOR SELECT TO authenticated
  USING (has_flockbots_console_access());

DROP POLICY IF EXISTS "Allowlisted users can read stream log" ON flockbots_stream_log;
CREATE POLICY "Allowlisted users can read stream log"
  ON flockbots_stream_log FOR SELECT TO authenticated
  USING (has_flockbots_console_access());

DROP POLICY IF EXISTS "Console users read sub-agents" ON flockbots_sub_agents;
CREATE POLICY "Console users read sub-agents"
  ON flockbots_sub_agents FOR SELECT TO authenticated
  USING (has_flockbots_console_access());

DROP POLICY IF EXISTS "Console users read customizations" ON flockbots_customizations;
CREATE POLICY "Console users read customizations"
  ON flockbots_customizations FOR SELECT TO authenticated
  USING (has_flockbots_console_access());

-- Customizations: allowlisted users can upsert/update (their own UI prefs)
DROP POLICY IF EXISTS "Console users upsert customizations" ON flockbots_customizations;
CREATE POLICY "Console users upsert customizations"
  ON flockbots_customizations FOR INSERT TO authenticated
  WITH CHECK (has_flockbots_console_access());

DROP POLICY IF EXISTS "Console users update customizations" ON flockbots_customizations;
CREATE POLICY "Console users update customizations"
  ON flockbots_customizations FOR UPDATE TO authenticated
  USING (has_flockbots_console_access())
  WITH CHECK (has_flockbots_console_access());

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

-- Webhook inbox: service role full access; allowlisted users can insert dashboard actions
DROP POLICY IF EXISTS "Service role can manage webhook inbox" ON webhook_inbox;
CREATE POLICY "Service role can manage webhook inbox"
  ON webhook_inbox FOR ALL TO service_role USING (true);

DROP POLICY IF EXISTS "Allowlisted users can insert dashboard actions" ON webhook_inbox;
CREATE POLICY "Allowlisted users can insert dashboard actions"
  ON webhook_inbox FOR INSERT TO authenticated
  WITH CHECK (has_flockbots_console_access() AND source = 'dashboard');

-- -----------------------------------------------------------------------------
-- 5. Realtime publications (dashboard subscribes via Supabase realtime)
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
-- 6. Storage bucket for QA screenshots + videos
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
-- 7. Record this migration
-- -----------------------------------------------------------------------------
INSERT INTO flockbots_migrations (version) VALUES ('1.0.0')
  ON CONFLICT (version) DO NOTHING;
