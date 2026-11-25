-- A store created by @statewalker/ai-tasks 0.1.0 (generated once; do not edit).
-- Subscription `work` on jobs.*, tasks id1 (leased as id3, one progress entry) and id2 (waiting).
CREATE TABLE task_items (seq INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL, id TEXT NOT NULL, subject TEXT NOT NULL, destination TEXT,
      sender TEXT NOT NULL, payload TEXT NOT NULL, bytes INTEGER NOT NULL, created INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, reply_to TEXT, correlation_id TEXT,
      matched INTEGER NOT NULL DEFAULT 0, UNIQUE (project, id));
CREATE TABLE task_subscriptions (project TEXT NOT NULL,
      name TEXT NOT NULL, subject TEXT NOT NULL, destination TEXT, sender TEXT,
      lease_ms INTEGER NOT NULL, max_attempts INTEGER NOT NULL, owner TEXT NOT NULL,
      created INTEGER NOT NULL, inbox INTEGER NOT NULL DEFAULT 0, expired INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (project, name));
CREATE TABLE task_deliveries (project TEXT NOT NULL,
      subscription TEXT NOT NULL, task INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      lease TEXT, lease_expires INTEGER, holder TEXT, PRIMARY KEY (project, subscription, task));
CREATE INDEX task_deliveries_lease ON task_deliveries (lease);
CREATE INDEX task_deliveries_task ON task_deliveries (task);
CREATE TABLE task_dead (seq INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL, subscription TEXT NOT NULL, task TEXT NOT NULL, bytes INTEGER NOT NULL,
      attempts INTEGER NOT NULL, reason TEXT NOT NULL, dead_at INTEGER NOT NULL,
      expires INTEGER NOT NULL);
CREATE TABLE task_takers (project TEXT NOT NULL, task TEXT NOT NULL,
      holder TEXT NOT NULL, reply_to TEXT NOT NULL, correlation_id TEXT, until INTEGER NOT NULL,
      replied INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (project, task, holder));
CREATE TABLE task_jobs (id TEXT PRIMARY KEY, project TEXT NOT NULL,
      task TEXT NOT NULL, subscription TEXT NOT NULL, holder TEXT NOT NULL, sender TEXT NOT NULL,
      until INTEGER NOT NULL);
CREATE TABLE task_job_entries (seq INTEGER PRIMARY KEY AUTOINCREMENT,
      job TEXT NOT NULL, at INTEGER NOT NULL, progress TEXT NOT NULL);
CREATE TABLE task_changes (project TEXT PRIMARY KEY,
      seq INTEGER NOT NULL);
INSERT INTO task_items (seq, project, id, subject, destination, sender, payload, bytes, created, expires_at, reply_to, correlation_id, matched) VALUES (1, 'alpha', 'id1', 'jobs.a', NULL, 'user:ann', '{"n":1}', 7, 1000000, 605800000, NULL, NULL, 1);
INSERT INTO task_items (seq, project, id, subject, destination, sender, payload, bytes, created, expires_at, reply_to, correlation_id, matched) VALUES (2, 'alpha', 'id2', 'jobs.b', NULL, 'user:ann', '{"n":2}', 7, 1000000, 605800000, NULL, NULL, 1);
INSERT INTO task_subscriptions (project, name, subject, destination, sender, lease_ms, max_attempts, owner, created, inbox, expired) VALUES ('alpha', 'work', 'jobs.*', NULL, NULL, 300000, 3, 'user:ann', 1000000, 0, 0);
INSERT INTO task_deliveries (project, subscription, task, attempts, lease, lease_expires, holder) VALUES ('alpha', 'work', 1, 1, 'id3', 1300000, 'user:ann');
INSERT INTO task_deliveries (project, subscription, task, attempts, lease, lease_expires, holder) VALUES ('alpha', 'work', 2, 0, NULL, NULL, NULL);
INSERT INTO task_jobs (id, project, task, subscription, holder, sender, until) VALUES ('id3', 'alpha', 'id1', 'work', 'user:ann', 'user:ann', 1210600000);
INSERT INTO task_job_entries (seq, job, at, progress) VALUES (1, 'id3', 1000000, '{"step":1}');
INSERT INTO task_changes (project, seq) VALUES ('alpha', 2);
