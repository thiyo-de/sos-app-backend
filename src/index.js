/**
 * Remote Access Server Gateway
 * Express + WebSocket Server for device management
 */

import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import config from './config.js';
import adminRoutes from './routes/admin.js';
import { socketRegistry } from './services/socketRegistry.js';
import { commandDispatcher } from './services/commandDispatcher.js';
import HealthMonitor from './services/healthMonitor.js';
import { fcmSender } from './services/fcmSender.js';
import { notifyDeviceOnline, notifyDeviceOffline, notifySetupComplete } from './services/emailNotifier.js';
import { saveCapturedNotification, saveNotification } from './services/database.js';
import { authMiddleware, createToken, verifyToken } from './middleware/auth.js';
import { csrfMiddleware } from './middleware/csrf.js';
import { validateProductionConfig } from './config.js';
import morgan from 'morgan';
import { getMetrics, getMetricsContentType, metricConnectedDevices, metricActiveConnections } from './services/metrics.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Validate runtime configuration before any socket is opened.
// Abort startup in production if unsafe/missing configuration is detected.
try {
    const issues = validateProductionConfig();
    if (issues.length > 0) {
        console.error('[FATAL] Unsafe production configuration detected:');
        for (const issue of issues) console.error(`  - ${issue}`);
        if (config.helpers.isProduction) {
            console.error('[FATAL] Refusing to start in production with unsafe config.');
            process.exit(1);
        } else {
            console.warn('[WARN] Production config issues detected in development/test — continuing.');
        }
    }
} catch (e) {
    console.error('[FATAL] Configuration validation error:', e.message);
    if (config.helpers.isProduction) process.exit(1);
}

// Initialize Express app
const app = express();

// Express sits behind Render's reverse proxy (and any TLS-terminating proxy).
// Trust a single hop so req.ip reflects the real client and HSTS / CORS work.
app.set('trust proxy', 1);

const server = http.createServer(app);

// HTTPS server (development only — Render terminates TLS in production)
let httpsServer = null;

if (config.helpers.isDevelopment) {
    try {
        const certsDir = path.join(__dirname, '../certs');
        const pfxPath = path.join(certsDir, 'cert.pfx');
        const keyPath = path.join(certsDir, 'key.pem');
        const certPath = path.join(certsDir, 'cert.pem');

        let sslOptions = null;

        // Passphrase may come from env (HTTPS_CERT_PASSPHRASE) — never hardcode it.
        // DEV TIP: generate a local self-signed cert using `selfsigned` (devDep):
        //   npm i -g selfsigned  # already a devDependency
        // Or place cert.pfx / key.pem + cert.pem in server-gateway/certs/.
        const pfxPassphrase = process.env.HTTPS_CERT_PASSPHRASE;

        if (fs.existsSync(pfxPath) && pfxPassphrase) {
            sslOptions = {
                pfx: fs.readFileSync(pfxPath),
                passphrase: pfxPassphrase,
            };
            console.log('[HTTPS] SSL certificate loaded from certs/cert.pfx');
        } else if (fs.existsSync(pfxPath) && !pfxPassphrase) {
            // Avoid silently falling through — surface the missing env var so the
            // operator rotates the cert and supplies the passphrase via env.
            console.warn('[HTTPS] certs/cert.pfx exists but HTTPS_CERT_PASSPHRASE is not set — skipping PFX cert');
        }
        if (!sslOptions && fs.existsSync(keyPath) && fs.existsSync(certPath)) {
            sslOptions = {
                key: fs.readFileSync(keyPath),
                cert: fs.readFileSync(certPath),
            };
            console.log('[HTTPS] SSL certificates loaded from certs/');
        }

        if (sslOptions) {
            httpsServer = https.createServer(sslOptions, app);
        } else {
            console.log('[HTTPS] No SSL certs found in certs/ — mic Speech Recognition requires HTTPS in development');
        }
    } catch (e) {
        console.error('[HTTPS] Error loading certs:', e.message);
    }
}

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ─── CORS (restricted to configured public URL + development origins) ───
const DEVELOPMENT_ORIGINS = [
    'http://localhost:3000',
    'http://localhost:5173',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:5173',
];

function buildAllowedOrigins() {
    const origins = [];

    // Production: the configured public URL is the only allowed origin.
    if (config.publicUrl) {
        const normalized = config.publicUrl.replace(/\/+$/, '');
        origins.push(normalized);
    }

    // Development: also allow localhost origins.
    if (config.helpers.isDevelopment || config.helpers.isTest) {
        for (const dev of DEVELOPMENT_ORIGINS) {
            if (!origins.includes(dev)) {
                origins.push(dev);
            }
        }
    }

    return origins;
}

let ALLOWED_ORIGINS = buildAllowedOrigins();

app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
        res.header('Access-Control-Allow-Origin', origin);
        res.header('Access-Control-Allow-Credentials', 'true');
    }
    // Same-origin requests (no Origin header) don't need CORS headers
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-CSRF-Token');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// ─── Security Headers (Helmet-equivalent) ───
app.use((req, res, next) => {
    res.header('X-Content-Type-Options', 'nosniff');
    res.header('X-Frame-Options', 'DENY');
    res.header('X-XSS-Protection', '0'); // Disabled per OWASP — CSP is the real defense
    res.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.header('X-DNS-Prefetch-Control', 'off');
    res.header('X-Download-Options', 'noopen');
    res.header('X-Permitted-Cross-Domain-Policies', 'none');
    res.header('Cross-Origin-Opener-Policy', 'same-origin');
    res.header('Cross-Origin-Resource-Policy', 'same-origin');
    // CSP: allow inline scripts/styles (required for single-file HTML pages)
    // Allow blob: for binary media streams, data: for base64 images
    res.header('Content-Security-Policy',
        "default-src 'self'; " +
        "script-src 'self' 'unsafe-inline' https://unpkg.com; " +
        "style-src 'self' 'unsafe-inline' https://api.fontshare.com; " +
        "img-src 'self' data: blob: https://mt1.google.com https://tile.openstreetmap.org https://server.arcgisonline.com https://*.basemaps.cartocdn.com; " +
        "media-src 'self' blob:; " +
        "connect-src 'self' ws: wss:; " +
        "font-src 'self' data: https://cdn.fontshare.com; " +
        "object-src 'none'; " +
        "base-uri 'self'; " +
        "form-action 'self'"
    );
    if (config.security.hstsEnabled) {
        res.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
});

// ─── Structured Request Logging (morgan) ───
const morganFormat = config.helpers.isProduction
    ? ':remote-addr :method :url :status :res[content-length] - :response-time ms'
    : 'dev';
app.use(morgan(morganFormat));

// ─── Prometheus Metrics ───
// Export metrics endpoint (protected by auth middleware below)
app.get('/metrics', async (req, res) => {
    try {
        metricConnectedDevices.set(socketRegistry.getDeviceCount());
        metricActiveConnections.set(wss ? wss.clients.size : 0);
        res.set('Content-Type', getMetricsContentType());
        res.end(await getMetrics());
    } catch (err) {
        res.status(500).end(err.message);
    }
});

// Update metrics periodically
setInterval(() => {
    metricConnectedDevices.set(socketRegistry.getDeviceCount());
    metricActiveConnections.set(wss ? wss.clients.size : 0);
}, 30_000);

// ─── Rate Limiting (login brute-force protection) ───
const loginAttempts = new Map();
function loginRateLimit(req, res, next) {
    const ip = req.ip || req.socket.remoteAddress;
    const now = Date.now();
    let attempts = loginAttempts.get(ip) || [];
    // Keep only attempts in last 60 seconds
    attempts = attempts.filter(t => now - t < 60_000);
    if (attempts.length >= 5) {
        res.setHeader('Retry-After', '60');
        return res.status(429).json({
            success: false,
            error: 'Too many login attempts. Try again in 60 seconds.',
            code: 'RATE_LIMIT_EXCEEDED',
        });
    }
    attempts.push(now);
    loginAttempts.set(ip, attempts);
    next();
}
// Cleanup stale entries every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [ip, attempts] of loginAttempts) {
        const recent = attempts.filter(t => now - t < 60_000);
        if (recent.length === 0) loginAttempts.delete(ip);
        else loginAttempts.set(ip, recent);
    }
}, 5 * 60 * 1000);

// ─── Authentication Routes (public, no middleware) ───

// Login endpoint (rate-limited)
app.post('/auth/login', loginRateLimit, (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({
            success: false,
            error: 'Username and password are required',
        });
    }

    if (username === config.auth.username && password === config.auth.password) {
        const token = createToken(username);

        res.cookie('auth_token', token, {
            httpOnly: true,
            secure: config.security.secureCookies,
            sameSite: config.security.secureCookies ? 'strict' : 'lax',
            maxAge: config.auth.tokenExpiry,
            path: '/',
        });

        return res.json({
            success: true,
            message: 'Authentication successful',
        });
    }

    return res.status(401).json({
        success: false,
        error: 'Invalid username or password',
        code: 'AUTH_INVALID_CREDENTIALS',
    });
});

// Logout endpoint
app.get('/auth/logout', (req, res) => {
    res.clearCookie('auth_token', { path: '/' });
    res.redirect('/login.html');
});

// Session check endpoint
app.get('/auth/check', (req, res) => {
    const cookies = {};
    const header = req.headers.cookie;
    if (header) {
        header.split(';').forEach(c => {
            const [name, ...rest] = c.trim().split('=');
            cookies[name] = decodeURIComponent(rest.join('='));
        });
    }

    const result = verifyToken(cookies.auth_token);

    if (result.valid) {
        return res.json({ success: true, username: result.username, csrfToken: result.csrfToken });
    }
    return res.status(401).json({ success: false, error: 'Not authenticated' });
});

// Health check endpoint (ABOVE auth — must be public for monitoring services)
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        devices: socketRegistry.getDeviceCount(),
    });
});

// ─── Auth Middleware (protects everything below) ───
app.use(authMiddleware);

// ─── CSRF Protection (state-changing requests only) ───
// Must run AFTER authMiddleware. Safe methods (GET/HEAD/OPTIONS) pass
// through immediately. Bootstrap (login) and HMAC device uploads are
// exempted inside the middleware.
app.use(csrfMiddleware);

// Serve static admin dashboard (protected) - no cache for HTML files
app.use((req, res, next) => {
    if (req.path.endsWith('.html') || req.path === '/') {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
    }
    next();
});
app.use(express.static(path.join(__dirname, '../public')));

// API routes (protected)
app.use('/api', adminRoutes);

// (Health endpoint moved above auth middleware)

// Initialize WebSocket Server on HTTP
const wss = new WebSocketServer({
    server,
    path: '/',
});

// Also attach WebSocket to HTTPS if available
let wssHttps = null;
if (httpsServer) {
    wssHttps = new WebSocketServer({
        server: httpsServer,
        path: '/',
    });
}

console.log('[WebSocket] Server initialized');

/**
 * Safe send — prevents crash if socket is null or closed
 */
function safeSend(ws, data) {
    try {
        if (ws && ws.readyState === ws.OPEN) {
            ws.send(typeof data === 'string' ? data : JSON.stringify(data));
            return true;
        }
    } catch (e) {
        console.error(`[WebSocket] safeSend failed: ${e.message}`);
    }
    return false;
}

/**
 * Broadcast a message to all WebSocket clients (HTTP + HTTPS) except sender
 * IMPORTANT: senderWs may only exist on one server's client list. Only
 * broadcast on the server that actually contains the sender (the other
 * server cannot exclude it and would echo back to the sender).
 */
function broadcastToClients(senderWs, msg) {
    const message = typeof msg === 'string' ? msg : JSON.stringify(msg);
    const doBroadcast = (server) => {
        if (!server) return;
        // Only broadcast on this server if the sender IS on it (so we can
        // exclude them); or if there's no sender at all (e.g. server-initiated).
        if (senderWs && ![...server.clients].includes(senderWs)) return;
        server.clients.forEach(client => {
            if (client !== senderWs && client.readyState === client.OPEN) {
                client.send(message);
            }
        });
    };
    doBroadcast(wss);
    doBroadcast(wssHttps);
}

/**
 * MIC-002/003/014: Broadcast binary data to browser clients (max MAX_BINARY_LISTENERS).
 * Excludes sender and any connection with the same deviceId (prevents self-feedback).
 */
const MAX_BINARY_LISTENERS = 3; // MIC-014: Limit concurrent browser listeners per device

// CAM-010: Track binary viewer count per device
const deviceViewerCounts = new Map();
const viewerToDevice = new Map(); // ws → deviceId being watched
const activeLiveSessions = new Map(); // LOC-009: deviceId → { intervalMs, startTime, pendingClearTimeout }
const LIVE_SESSION_GRACE_MS = 45_000; // LOC-009: grace period before clearing session on disconnect

/**
 * Broadcast viewer count updates to all dashboard clients
 */
function broadcastViewerCount(deviceId) {
    const count = deviceViewerCounts.get(deviceId) || 0;
    const msg = JSON.stringify({
        type: 'camera_viewer_count',
        deviceId,
        count,
        max: MAX_BINARY_LISTENERS,
        warn: count > 2,
    });
    const doBroadcast = (server) => {
        if (!server) return;
        server.clients.forEach(client => {
            if (client.readyState === client.OPEN) {
                client.send(msg);
            }
        });
    };
    doBroadcast(wss);
    doBroadcast(wssHttps);
}

function broadcastBinaryToClients(senderWs, data) {
    const senderDeviceId = senderWs?.deviceId;
    const eligible = [];
    const collectEligible = (server) => {
        if (!server) return;
        if (senderWs && ![...server.clients].includes(senderWs)) return;
        server.clients.forEach(client => {
            if (client.readyState !== client.OPEN) return;
            if (client === senderWs) return;
            if (client.deviceId && client.deviceId === senderDeviceId) return;
            eligible.push(client);
        });
    };

    // WEBRTC-001: Find browser WebSocket by deviceId + browserSessionId
    function findBrowserWs(deviceId, browserSessionId) {
        if (!global.browserSessions) return null;
        return global.browserSessions.get(`${deviceId}:${browserSessionId}`) || null;
    }
    collectEligible(wss);
    collectEligible(wssHttps);

    if (eligible.length > MAX_BINARY_LISTENERS) {
        console.warn(`[Binary] ${senderDeviceId || 'unknown'} — dropping ${eligible.length - MAX_BINARY_LISTENERS} of ${eligible.length} binary listeners (limit: ${MAX_BINARY_LISTENERS})`);
    }

    const count = Math.min(eligible.length, MAX_BINARY_LISTENERS);
    for (let i = 0; i < count; i++) {
        eligible[i].send(data);
        viewerToDevice.set(eligible[i], senderDeviceId);
    }

    // CAM-010: Update viewer count and broadcast to all clients
    if (senderDeviceId) {
        const prevCount = deviceViewerCounts.get(senderDeviceId) || 0;
        if (prevCount !== count) {
            deviceViewerCounts.set(senderDeviceId, count);
            broadcastViewerCount(senderDeviceId);
        }
    }
}

/**
 * WebSocket connection handler — shared between HTTP and HTTPS servers
 */
function handleWebSocketConnection(ws, req) {
    console.log('[WebSocket] New connection from:', req.socket.remoteAddress);

    let deviceId = null;
    let heartbeatInterval = null;

    // Handle messages
    ws.on('message', (message, isBinary) => {
        try {
            // ── Binary frame handler (media streams) ──
            // Protocol: [1 byte type] [N bytes payload]
            // 0x01=screen, 0x02=camera, 0x03=mic
            if (isBinary && Buffer.isBuffer(message) && message.length > 1) {
                broadcastBinaryToClients(ws, message);
                return;
            }

            const data = JSON.parse(message.toString());


            // Normalize message structure (Android sends 'action', Frontend expects 'type')
            if (data.action && !data.type) {
                data.type = data.action;
            }

            // Inject deviceId if missing (for frontend)
            if (!data.deviceId && deviceId) {
                data.deviceId = deviceId;
            }

            // Handle browser identification
            if (data.type === 'identify') {
                // WEBRTC-001: Register browser session for WebRTC routing
                if (data.role === 'browser' && data.deviceId && data.browserSessionId) {
                    // Store browser session mapping on the WebSocket
                    ws.deviceId = data.deviceId;
                    ws.browserSessionId = data.browserSessionId;
                    console.log(`[WebSocket] Browser session registered: ${data.deviceId} / ${data.browserSessionId}`);
                    // Optional: store in a registry for quick lookup
                    if (!global.browserSessions) global.browserSessions = new Map();
                    global.browserSessions.set(`${data.deviceId}:${data.browserSessionId}`, ws);
                }
                return;
            }

            // Handle device registration (with HMAC authentication)
            if (data.type === 'register') {
                const incomingDeviceId = data.deviceId;

                // ─── HMAC Device Authentication ───
                const authToken = data.authToken;
                const authTimestamp = data.authTimestamp;

                if (!authToken || !authTimestamp) {
                    console.warn(`[WebSocket] ❌ Device ${incomingDeviceId} rejected — no auth token provided`);
                    safeSend(ws, {
                        type: 'auth_failed',
                        error: 'Missing authentication token — all devices must authenticate',
                    });
                    ws.close(4001, 'Authentication required');
                    return;
                }

                // Verify HMAC-SHA256 signature
                const payload = `${incomingDeviceId}:${authTimestamp}`;
                const expectedHmac = crypto
                    .createHmac('sha256', config.websocket.deviceSecret)
                    .update(payload)
                    .digest('hex');

                // Timing-safe comparison to prevent timing attacks
                const tokenBuf = Buffer.from(authToken, 'utf8');
                const expectedBuf = Buffer.from(expectedHmac, 'utf8');

                if (tokenBuf.length !== expectedBuf.length ||
                    !crypto.timingSafeEqual(tokenBuf, expectedBuf)) {
                    console.warn(`[WebSocket] ❌ HMAC verification FAILED for deviceId: ${incomingDeviceId}`);
                    safeSend(ws, {
                        type: 'auth_failed',
                        error: 'Invalid device authentication token',
                    });
                    ws.close(4001, 'Authentication failed');
                    return;
                }

                // Reject stale tokens (older than 5 minutes)
                const tokenAge = Date.now() - parseInt(authTimestamp);
                if (tokenAge > 5 * 60 * 1000) {
                    console.warn(`[WebSocket] ❌ Stale auth token for deviceId: ${incomingDeviceId} (${tokenAge}ms old)`);
                    safeSend(ws, {
                        type: 'auth_failed',
                        error: 'Authentication token expired',
                    });
                    ws.close(4002, 'Token expired');
                    return;
                }

                console.log(`[WebSocket] ✅ HMAC verified for deviceId: ${incomingDeviceId}`);

                deviceId = incomingDeviceId;
                ws.deviceId = deviceId; // MIC-002/003: Track device on ws for binary frame filtering

                // Email alert: real "came online" only (new device or was offline/sleep —
                // NOT on reconnect handoffs where the old socket was still open)
                const prevDevice = socketRegistry.getDevice(deviceId);
                const wasActive = prevDevice && prevDevice.metadata &&
                    ['online', 'sleep'].includes(prevDevice.metadata.status);
                socketRegistry.register(deviceId, ws, data.metadata || {});
                if (!wasActive) {
                    notifyDeviceOnline(deviceId, data.metadata || {});
                    saveNotification(deviceId, 'device_online', 'Device came online', `Device registered with the server`, { model: data.metadata?.model || null, battery: data.metadata?.battery ?? null });
                }

                // Log initial device state for observability
                if (data.metadata?.state) {
                    console.log(`[WebSocket] 📋 Initial state for ${deviceId}:`, JSON.stringify(data.metadata.state));
                }

                // Send welcome message
                safeSend(ws, {
                    type: 'registered',
                    deviceId,
                    message: 'Successfully registered',
                });

                // Automatically flush scheduled commands if the device registered while unlocked
                if (data.metadata?.isUnlocked === true) {
                    console.log(`[WebSocket] 🔓 Device ${deviceId} registered in UNLOCKED state, flushing queue...`);
                    commandDispatcher.flushScheduled(deviceId);
                }

                // LOC-009: Resume live tracking session after reconnect
                const prevSession = activeLiveSessions.get(deviceId);
                if (prevSession) {
                    // Cancel any pending grace-period clear timeout
                    if (prevSession.pendingClearTimeout) {
                        clearTimeout(prevSession.pendingClearTimeout);
                        prevSession.pendingClearTimeout = null;
                    }
                    console.log(`[LOC-009] Resuming live session for ${deviceId} (interval: ${prevSession.intervalMs}ms)`);
                    // Fire and forge — don't wait for response to avoid blocking registration
                    commandDispatcher.sendCommand(deviceId, 'location_live_start', { interval: prevSession.intervalMs }).catch(err => {
                        console.warn(`[LOC-009] Failed to resume live session: ${err.message}`);
                    });
                }

                // Start heartbeat monitoring
                heartbeatInterval = setInterval(() => {
                    if (!safeSend(ws, { type: 'ping' })) {
                        clearInterval(heartbeatInterval);
                        console.log(`[WebSocket] Ping failed for ${deviceId}, clearing interval`);
                    }
                }, config.websocket.pingInterval);

                return;
            }

            // Handle heartbeat from device
            if (data.type === 'heartbeat') {
                if (deviceId) {
                    socketRegistry.updateMetadata(deviceId, {
                        lastHeartbeat: new Date().toISOString(),
                    });
                    safeSend(ws, { type: 'heartbeat_ack' });
                }
                return;
            }

            // Handle heartbeat pong
            if (data.type === 'pong') {
                if (deviceId) {
                    socketRegistry.updateMetadata(deviceId, {
                        lastSeen: new Date().toISOString(),
                    });
                }
                return;
            }

            // Handle device state changes (sleep/online from screen on/off)
            if (data.type === 'device_state') {
                console.log(`[WebSocket] 📱 device_state from ${deviceId}: ${data.state}`);
                if (deviceId) {
                    if (data.state === 'sleep') {
                        socketRegistry.markSleep(deviceId);
                    } else if (data.state === 'online') {
                        socketRegistry.updateMetadata(deviceId, { status: 'online' });
                    }
                    // Broadcast state change to dashboard
                    broadcastToClients(ws, { type: 'device_state', deviceId, state: data.state });
                }
                return;
            }

            // Handle active state sync from device
            if (data.type === 'active_state_sync' && deviceId) {
                console.log(`[WebSocket] 📋 active_state_sync from ${deviceId}:`, JSON.stringify(data.state));
                socketRegistry.updateMetadata(deviceId, { state: data.state });
                broadcastToClients(ws, { type: 'active_state_sync', deviceId, state: data.state });
                return;
            }

            // Handle setup_complete event — device reports all protection grants enabled
            if (data.type === 'setup_complete' && deviceId) {
                const existing = socketRegistry.getDevice(deviceId)?.metadata;
                const alreadyComplete = existing?.setupComplete === true;
                socketRegistry.updateMetadata(deviceId, {
                    setupComplete: true,
                    setupCompletedAt: existing?.setupCompletedAt || new Date().toISOString(),
                    state: data.state || {},
                });
                console.log(`[WebSocket] ✅ setup_complete from ${deviceId} (${alreadyComplete ? 're-sync' : 'first time'})`);
                if (!alreadyComplete) {
                    // First event: email alert + dashboard toast + DB record
                    const meta = socketRegistry.getDevice(deviceId)?.metadata || {};
                    notifySetupComplete(deviceId, data.state || {}, meta);
                    saveNotification(deviceId, 'setup_complete', 'Device fully protected', 'All protection grants enabled', data.state || {});
                    broadcastToClients(ws, {
                        type: 'setup_complete',
                        deviceId,
                        state: data.state || {},
                    });
                } else {
                    // Re-sync (reconnect): silently refresh the badge only
                    broadcastToClients(ws, {
                        type: 'active_state_sync',
                        deviceId,
                        state: data.state || {},
                    });
                }
                return;
            }

            // Handle device unlock events (flush pending commands)
            if (data.type === 'device_unlocked') {
                console.log(`[WebSocket] 🔓 device_unlocked from ${deviceId}`);
                if (deviceId) {
                    commandDispatcher.flushScheduled(deviceId);
                }
                return;
            }

            // Handle device info updates
            if (data.type === 'device_info') {
                if (deviceId) {
                    socketRegistry.updateMetadata(deviceId, data.info);
                }
                return;
            }

            // Handle periodic metadata updates from device (DEVINFO-007)
            if (data.type === 'metadata_update') {
                if (deviceId && data.metadata) {
                    socketRegistry.updateMetadata(deviceId, {
                        ...data.metadata,
                        lastMetadataPush: new Date().toISOString(),
                    });
                    console.log(`[WebSocket] 📊 metadata_update from ${deviceId}`);
                    // Broadcast to dashboard clients for live updates
                    broadcastToClients(ws, { type: 'metadata_update', deviceId, metadata: data.metadata });
                }
                return;
            }

            // Handle notification_event — phone notification caught by the listener
            if (data.type === 'notification_event' && deviceId) {
                const notif = data.notification || {};
                if (notif.event === 'removed') {
                    // Removal events just forward to the dashboard (no DB write)
                    broadcastToClients(ws, { type: 'notification_event', deviceId, notification: notif });
                    if (notif.uuid) safeSend(ws, { type: 'event_ack', deviceId, ids: [notif.uuid] });
                    return;
                }
                // Live-broadcast to the dashboard feed (immediate)
                broadcastToClients(ws, { type: 'notification_event', deviceId, notification: notif });
                // Persist to Supabase; ACK only after the row is written so the
                // phone outbox can drop it (at-least-once + content-hash dedup).
                saveCapturedNotification(deviceId, notif).then(saved => {
                    if (saved && notif.uuid) {
                        safeSend(ws, { type: 'event_ack', deviceId, ids: [notif.uuid] });
                    } else if (!saved) {
                        console.warn(`[WebSocket] notification_event NOT persisted for ${deviceId} — phone will retry`);
                    }
                });
                return;
            }

            // Handle FCM token update (sent separately after registration)
            if (data.type === 'fcm_token') {
                if (deviceId && data.fcmToken) {
                    socketRegistry.updateMetadata(deviceId, { fcmToken: data.fcmToken });
                    console.log(`[WebSocket] 🔔 FCM token stored for ${deviceId}`);
                }
                return;
            }

            // Handle browser audio chunks - broadcast to all connected devices (walkie-talkie)
            if (data.type === 'browser_audio_chunk' && data.deviceId) {
                const pcmBytes = Buffer.from(data.data, 'base64');
                const frame = Buffer.alloc(1 + pcmBytes.length);
                frame[0] = 0x04;
                pcmBytes.copy(frame, 1);
                // AV-010: Broadcast to ALL devices (not just target device)
                const devices = socketRegistry.listDevices();
                let sentCount = 0;
                for (const [id, entry] of devices) {
                    if (entry.ws && entry.ws.readyState === entry.ws.OPEN) {
                        entry.ws.send(frame);
                        sentCount++;
                    }
                }
                if (sentCount > 1) {
                    console.log(`[Walkie-Talkie] Broadcast audio to ${sentCount} devices`);
                }
                return;
            }

            // WebRTC signaling: answer from Android device → forward to specific browser session
            if (data.type === 'webrtc_answer' && deviceId) {
                // Include browserSessionId if present for multi-viewer support
                const msg = { ...data, deviceId };
                if (data.browserSessionId) {
                    // Send only to the specific browser session
                    const targetWs = findBrowserWs(deviceId, data.browserSessionId);
                    if (targetWs) {
                        safeSend(targetWs, msg);
                    }
                } else {
                    // Legacy: broadcast to all browsers
                    broadcastToClients(ws, msg);
                }
                return;
            }

            // WebRTC signaling: ICE candidate — bidirectional routing
            if (data.type === 'webrtc_ice_candidate') {
                if (deviceId) {
                    // From Android device → forward to browsers (with browserSessionId if present)
                    if (data.browserSessionId) {
                        const targetWs = findBrowserWs(deviceId, data.browserSessionId);
                        if (targetWs) {
                            safeSend(targetWs, { ...data, deviceId });
                        }
                    } else {
                        broadcastToClients(ws, { ...data, deviceId });
                    }
                } else {
                    // From browser → forward to target device
                    const targetDeviceId = data.deviceId;
                    if (targetDeviceId) {
                        const targetDevice = socketRegistry.getDevice(targetDeviceId);
                        if (targetDevice && targetDevice.ws && targetDevice.ws.readyState === ws.OPEN) {
                            safeSend(targetDevice.ws, data);
                        } else {
                            console.warn(`[WebRTC] ICE candidate from browser could not be delivered — device ${targetDeviceId} not connected`);
                        }
                    }
                }
                return;
            }

            // Handle clean disconnection request
            if (data.type === 'disconnect' && deviceId) {
                console.log(`[WebSocket] Device ${deviceId} requesting clean disconnect`);
                socketRegistry.deleteDevice(deviceId);
                safeSend(ws, { type: 'disconnect_ack' });
                return;
            }

            // Handle command delivery ACK from Android device
            // Android sends this BEFORE executing the command to confirm it was received.
            // This allows the server to stop retrying without waiting for the full response.
            if (data.type === 'cmd_ack' && data.id) {
                commandDispatcher.markDelivered(data.id);
                return;
            }

            // Handle command responses
            if (data.replyTo) {
                commandDispatcher.handleResponse(data);
                return;
            }

            // Handle device-pushed status updates (mic_state, camera_state)
            if (['mic_state', 'camera_state'].includes(data.type) && deviceId) {
                socketRegistry.updateMetadata(deviceId, { [data.type]: data.state || data });
                // Broadcast to all browser clients for real-time dashboard alerts
                const label = { mic_state: '🎤', camera_state: '📷' }[data.type] || '📡';
                console.log(`[WebSocket] ${label} ${data.type} PUSH from ${deviceId}: state=${data.state || 'unknown'}`);
                broadcastToClients(ws, { ...data, deviceId });
                return;
            }

            // MIC-020: Forward mic_stream_died / mic_stream_restarted to browser clients
            if ((data.type === 'mic_stream_died' || data.type === 'mic_stream_restarted') && deviceId) {
                broadcastToClients(ws, { ...data, deviceId });
                return;
            }

            // Handle accessibility status — forward to all browsers for dashboard alerts
            if (data.type === 'accessibility_status' && deviceId) {
                broadcastToClients(ws, { ...data, deviceId });
                return;
            }

            // Handle video playback status — forward to all browsers for dashboard sync
            if (data.type === 'video_status' && deviceId) {
                broadcastToClients(ws, { ...data, deviceId });
                return;
            }

            // Handle UI change notifications — forward to browsers for live Smart UI updates
            if (data.type === 'ui_changed' && deviceId) {
                broadcastToClients(ws, { type: 'ui_changed', deviceId });
                return;
            }

            // Handle location live tracking updates — forward to browsers
            if (data.type === 'location_update' && deviceId) {
                // LOC-009: Track active live session + cancel any pending grace-period clear
                const existing = activeLiveSessions.get(deviceId);
                if (existing && existing.pendingClearTimeout) {
                    clearTimeout(existing.pendingClearTimeout);
                    existing.pendingClearTimeout = null;
                    console.log(`[LOC-009] Live session grace period cancelled — device is actively streaming`);
                }
                if (!activeLiveSessions.has(deviceId)) {
                    activeLiveSessions.set(deviceId, { intervalMs: 5000, startTime: Date.now() });
                    console.log(`[LOC-009] Live session started for ${deviceId}`);
                }
                broadcastToClients(ws, { ...data, deviceId });
                return;
            }

            // Handle notification events — forward to browsers for live feed
            if ((data.type === 'notification_posted' || data.type === 'notification_removed' || data.type === 'notification_listener_state') && deviceId) {
                broadcastToClients(ws, { ...data, deviceId });
                return;
            }



            // Handle activity data pushed from device
            if (data.type === 'activity_data' && deviceId) {
                const events = data.events || [];
                if (events.length > 0) {
                    // Store in memory (live dashboard read path)
                    if (!global.activityCache) global.activityCache = new Map();
                    let cached = global.activityCache.get(deviceId);
                    if (!cached) {
                        cached = [];
                        global.activityCache.set(deviceId, cached);
                    }
                    events.forEach(ev => {
                        cached.unshift({ ...ev, deviceId, receivedAt: new Date().toISOString() });
                    });
                    // Trim to 2000 max
                    if (cached.length > 2000) {
                        global.activityCache.set(deviceId, cached.slice(0, 2000));
                    }

                    // Persist immediately — the phone outbox retries until it gets
                    // an event_ack, and event_uuid dedup makes re-sends harmless.
                    const uuids = events.map(ev => ev.uuid).filter(Boolean);
                    import('./services/database.js').then(async db => {
                        try {
                            const ok = await db.saveActivityEvents(deviceId, events);
                            if (ok) {
                                // Drop persisted events from the live cache (avoids duplicates vs DB reads)
                                if (uuids.length > 0) {
                                    const persisted = new Set(uuids);
                                    const current = global.activityCache?.get(deviceId);
                                    if (current) {
                                        const remaining = current.filter(c => !persisted.has(c.uuid));
                                        if (remaining.length !== current.length) {
                                            global.activityCache.set(deviceId, remaining);
                                        }
                                    }
                                    safeSend(ws, { type: 'event_ack', deviceId, ids: uuids });
                                }
                            } else {
                                console.warn(`[WebSocket] activity_data NOT persisted for ${deviceId} (${events.length} events) — phone will retry`);
                            }
                        } catch (_) { /* no ack → phone retries */ }
                    }).catch(() => { /* no ack → phone retries */ });

                    // Broadcast to browser clients for live feed
                    broadcastToClients(ws, { type: 'activity_data', deviceId, events, count: events.length });
                }
                return;
            }


            console.log('[WebSocket] Unknown message type:', data);
        } catch (error) {
            console.error('[WebSocket] Error parsing message:', error);
        }
    });

    // Handle disconnection — mark device offline (keep in registry)
    ws.on('close', () => {
        console.log(`[WebSocket] Client disconnected: ${deviceId || 'unknown'}`);

        // CAM-010: Clean up viewer tracking
        const watchedDevice = viewerToDevice.get(ws);
        if (watchedDevice) {
            viewerToDevice.delete(ws);
            const viewers = [...viewerToDevice.entries()].filter(([, d]) => d === watchedDevice).length;
            deviceViewerCounts.set(watchedDevice, viewers);
            broadcastViewerCount(watchedDevice);
        }

        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
        }

        if (deviceId) {
            commandDispatcher.clearDeviceCommands(deviceId);

            // LOC-009: Grace-period live session clearance — delay 45s to allow reconnect resume
            if (activeLiveSessions.has(deviceId)) {
                const session = activeLiveSessions.get(deviceId);
                // Cancel any previous pending clear (redundant safety)
                if (session.pendingClearTimeout) clearTimeout(session.pendingClearTimeout);
                session.pendingClearTimeout = setTimeout(() => {
                    activeLiveSessions.delete(deviceId);
                    console.log(`[LOC-009] Live session cleared for ${deviceId} after grace period`);
                }, LIVE_SESSION_GRACE_MS);
                console.log(`[LOC-009] Live session for ${deviceId} in grace period (${LIVE_SESSION_GRACE_MS}ms)`);
            }

            const graceTimer = setTimeout(() => {
                // FCM wake push — device dropped its socket; try to revive it remotely
                const meta = socketRegistry.getDevice(deviceId)?.metadata;
                if (meta?.fcmToken) {
                    fcmSender.wakeDevice(meta.fcmToken, deviceId).catch(() => { });
                }
                socketRegistry.markOffline(deviceId);
            console.log(`[WebSocket] Device ${deviceId} marked offline`);

            // Broadcast offline state to dashboard browsers immediately
            broadcastToClients(ws, {
                type: 'device_state',
                deviceId,
                state: 'offline'
            });
            }, 10_000);
            socketRegistry.setPendingOffline(deviceId, graceTimer);
        }
    });

    // Handle errors — mark offline (keep in registry)
    ws.on('error', (error) => {
        console.error(`[WebSocket] Connection error for ${deviceId || 'unknown'}:`, error.message);

        // CAM-010: Clean up viewer tracking
        const watchedDevice = viewerToDevice.get(ws);
        if (watchedDevice) {
            viewerToDevice.delete(ws);
            const viewers = [...viewerToDevice.entries()].filter(([, d]) => d === watchedDevice).length;
            deviceViewerCounts.set(watchedDevice, viewers);
            broadcastViewerCount(watchedDevice);
        }

        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
        }
        if (deviceId) {
            commandDispatcher.clearDeviceCommands(deviceId);
            const graceTimer = setTimeout(() => {
                // FCM wake push — device errored out; try to revive it remotely
                const meta = socketRegistry.getDevice(deviceId)?.metadata;
                if (meta?.fcmToken) {
                    fcmSender.wakeDevice(meta.fcmToken, deviceId).catch(() => { });
                }
                socketRegistry.markOffline(deviceId);
            console.log(`[WebSocket] Device ${deviceId} marked offline after error`);

            // Broadcast offline state to dashboard browsers immediately
            broadcastToClients(ws, {
                type: 'device_state',
                deviceId,
                state: 'offline'
            });
            }, 10_000);
            socketRegistry.setPendingOffline(deviceId, graceTimer);
        }
    });
}

// Wire up WebSocket handlers
wss.on('connection', handleWebSocketConnection);

// Email + DB record when a device goes offline (grace timers + health monitor route here)
socketRegistry.setOfflineListener((deviceId, metadata) => {
    notifyDeviceOffline(deviceId, metadata);
    saveNotification(deviceId, 'device_offline', 'Device went offline', 'Device stopped responding', { lastSeen: metadata.lastSeen || null });
});

// Initialize and start health monitor (disabled in test environment)
const healthMonitor = new HealthMonitor(socketRegistry);
if (config.jobs.healthMonitorEnabled) {
    healthMonitor.start();
} else {
    console.log('[HealthMonitor] Disabled — test environment');
}

// Notify browsers instantly when scheduled commands change
commandDispatcher.onScheduleUpdate = (deviceId) => {
    const msg = JSON.stringify({ type: 'schedule_updated', deviceId });
    const broadcast = (server) => {
        if (!server) return;
        server.clients.forEach(client => {
            if (client.readyState === client.OPEN) {
                client.send(msg);
            }
        });
    };
    broadcast(wss);
    broadcast(wssHttps);
};

// Self-ping to keep Render server alive (every 4 minutes).
// Uses the public URL so the ping goes through Render's routing layer and
// prevents the free-tier spin-down timer from elapsing.  The health
// endpoint is public (no auth required).
if (config.jobs.selfPingEnabled && config.publicUrl) {
    const healthUrl = `${config.publicUrl}/health`;
    setInterval(async () => {
        try {
            const res = await fetch(healthUrl);
            const data = await res.json();
            console.log(`[KeepAlive] Ping OK - ${data.devices} device(s) connected`);
        } catch (err) {
            console.log('[KeepAlive] Self-ping failed:', err.message);
        }
    }, 4 * 60 * 1000);
}

// ─── Global Express Error Handler ───
// Catches unhandled errors in route handlers to prevent server crash
app.use((err, req, res, next) => {
    console.error(`[Server] Unhandled error on ${req.method} ${req.path}:`, err.message);
    res.status(500).json({
        success: false,
        error: config.helpers.isProduction ? 'Internal server error' : err.message,
    });
});

// 404 handler for unknown API routes
app.use('/api/*', (req, res) => {
    res.status(404).json({ success: false, error: 'API endpoint not found' });
});

// ─── Process-Level Error Handlers ───
process.on('unhandledRejection', (reason, promise) => {
    console.error('[Server] Unhandled Promise Rejection:', reason);
    // Don't crash — log and continue
});

process.on('uncaughtException', (err) => {
    console.error('[Server] Uncaught Exception:', err.message);
    console.error(err.stack);
    // In production, gracefully shut down; in dev, keep running
    if (config.helpers.isProduction) {
        console.error('[Server] Fatal error in production — shutting down in 5s');
        setTimeout(() => process.exit(1), 5000);
    }
});

// Start server
server.listen(config.port, async () => {
    // Load devices from Supabase before anything else
    await socketRegistry.loadFromDB();

    // Derive WebSocket URL from public URL: https → wss, http → ws
    const wsUrl = config.publicUrl
        .replace(/^http:/, 'ws:')
        .replace(/^https:/, 'wss:');
    const dashboardUrl = config.publicUrl;

    console.log('='.repeat(50));
    console.log(`🚀 Remote Access Server Running`);
    console.log('='.repeat(50));
    console.log(`📡 HTTP Server: port ${config.port}`);
    console.log(`🔌 WebSocket: ${wsUrl}`);
    console.log(`🌍 Environment: ${config.nodeEnv}`);
    console.log(`📊 Admin Dashboard: ${dashboardUrl}`);
    if (config.helpers.isDevelopment && httpsServer) {
        const httpsPort = parseInt(config.port) + 443; // e.g., 3000 → 3443
        httpsServer.listen(httpsPort, () => {
            console.log(`🔒 HTTPS Server (dev): port ${httpsPort}`);
            console.log(`🎤 Mic/Speech (dev): ${dashboardUrl}/speak.html`);
        });

        // Set up WebSocket handlers for HTTPS server too
        if (wssHttps) {
            wssHttps.on('connection', (ws, req) => {
                handleWebSocketConnection(ws, req);
            });
        }
    }
    console.log('='.repeat(50));
});

/**
 * WEBRTC-001: Browser session management (per-device browser sessions)
 */
const deviceBrowserSessions = new Map(); // deviceId -> Map<browserSessionId, ws>

function registerBrowserSession(deviceId, browserSessionId, ws) {
    if (!deviceBrowserSessions.has(deviceId)) {
        deviceBrowserSessions.set(deviceId, new Map());
    }
    deviceBrowserSessions.get(deviceId).set(browserSessionId, ws);
    console.log(`[WebRTC] Browser session ${browserSessionId} registered for device ${deviceId}`);
}

function unregisterBrowserSession(deviceId, browserSessionId) {
    const sessions = deviceBrowserSessions.get(deviceId);
    if (sessions) {
        sessions.delete(browserSessionId);
        console.log(`[WebRTC] Browser session ${browserSessionId} unregistered for device ${deviceId}`);
        if (sessions.size === 0) {
            deviceBrowserSessions.delete(deviceId);
        }
    }
}

function findBrowserWs(deviceId, browserSessionId) {
    const sessions = deviceBrowserSessions.get(deviceId);
    return sessions?.get(browserSessionId) || null;
}

/**
 * WEBRTC-005: /api/ice-config endpoint for custom TURN/STUN servers
 * Returns configured ICE servers for WebRTC clients
 */
app.get('/api/ice-config', (req, res) => {
    // In production, load from environment/config
    // For now, return default public STUN/TURN
    const iceServers = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
    ];
    res.json({ iceServers });
});

/**
 * Graceful shutdown — drains pending commands, closes WS connections,
 * stops health monitor, signs out of Supabase, then exits.
 */
async function gracefulShutdown(signal) {
    console.log(`[Server] ${signal} received, shutting down gracefully...`);

    // 1. Stop accepting new connections
    server.close(() => {
        console.log('[Server] HTTP server closed');
    });

    // 2. Stop health monitor
    if (healthMonitor) {
        healthMonitor.stop();
        console.log('[HealthMonitor] Stopped');
    }

    // 3. Stop stale command cleanup in commandDispatcher
    if (commandDispatcher && commandDispatcher.teardown) {
        commandDispatcher.teardown();
        console.log('[Dispatcher] Teardown complete');
    }

    // 4. Drain pending commands (reject with shutdown reason)
    console.log('[Server] Draining pending commands...');
    for (const [commandId, pending] of commandDispatcher.pendingCommands.entries()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error(`Server shutting down — command ${commandId} cancelled`));
        commandDispatcher.pendingCommands.delete(commandId);
    }
    console.log(`[Server] Drained ${commandDispatcher.pendingCommands.size} pending command(s)`);

    // 5. Close all WebSocket connections
    console.log('[Server] Closing WebSocket connections...');
    const closeWsServer = (wssServer) => {
        if (!wssServer) return;
        wssServer.clients.forEach(client => {
            try {
                client.close(1001, 'Server shutting down');
            } catch (e) {
                // ignore close errors
            }
        });
    };
    closeWsServer(wss);
    closeWsServer(wssHttps);

    // 6. Sign out of Supabase if available
    try {
        const { supabase } = await import('./services/database.js');
        if (supabase) {
            await supabase.auth.signOut();
            console.log('[Database] Supabase signed out');
        }
    } catch (e) {
        // Supabase sign out is best-effort
    }

    // 7. Force exit after timeout (in case clean shutdown hangs)
    const forceExitTimer = setTimeout(() => {
        console.error('[Server] Forced exit after 10s timeout');
        process.exit(1);
    }, 10_000);
    forceExitTimer.unref();

    // Give everything a moment to close, then exit cleanly
    setTimeout(() => {
        clearTimeout(forceExitTimer);
        console.log('[Server] Shutdown complete');
        process.exit(0);
    }, 2_000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
