/**
 * Anti-CSRF Middleware
 *
 * Double-submit cookie defense: the dashboard receives a CSRF token via
 * /auth/check (derived from the HMAC-signed auth cookie) and must echo it
 * back as the X-CSRF-Token header on every state-changing request. This
 * binds the request to the authenticated session and prevents cross-site
 * request forgery even if a malicious site can send cookies via the
 * browser.
 *
 * Token algorithm MUST match middleware/auth.js::generateCsrfToken so the
 * token the client receives from /auth/check matches the one this
 * middleware recomputes. Both use hmac(secretKey, authToken + ':csrf').
 */

import crypto from 'crypto';
import config from '../config.js';

/**
 * Generate a CSRF token derived from the user's auth token.
 * MUST stay in sync with the token generated in middleware/auth.js
 * (HMAC-SHA256(secretKey, authToken + ':csrf'), hex digest).
 */
export function generateCsrfToken(authToken) {
    if (!authToken) return null;
    return crypto
        .createHmac('sha256', config.secretKey)
        .update(authToken + ':csrf')
        .digest('hex');
}

/**
 * CSRF protection middleware for state-changing requests.
 * Verifies the X-CSRF-Token header against the auth cookie.
 */
export function csrfMiddleware(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        return next();
    }

    // Endpoints that bootstrap or do HMAC auth themselves are exempt.
    // /auth/login establishes the cookie; device uploads use HMAC headers.
    const skipPaths = [
        '/auth/login',
        '/api/device-upload-temp',
    ];
    if (skipPaths.some(p => req.path === p)) {
        return next();
    }

    const providedToken = req.header('X-CSRF-Token');
    if (!providedToken) {
        return res.status(403).json({
            success: false,
            error: 'Missing CSRF token (X-CSRF-Token header required)',
        });
    }

    // Read the auth cookie
    let authCookie = null;
    if (req.headers.cookie) {
        for (const cookie of req.headers.cookie.split(';')) {
            const [name, ...rest] = cookie.trim().split('=');
            if (name === 'auth_token') {
                authCookie = decodeURIComponent(rest.join('='));
                break;
            }
        }
    }

    if (!authCookie) {
        return res.status(401).json({
            success: false,
            error: 'Missing authentication cookie',
        });
    }

    const expectedToken = generateCsrfToken(authCookie);

    const providedBuf = Buffer.from(providedToken, 'utf8');
    const expectedBuf = Buffer.from(expectedToken, 'utf8');

    if (providedBuf.length !== expectedBuf.length ||
        !crypto.timingSafeEqual(providedBuf, expectedBuf)) {
        return res.status(403).json({
            success: false,
            error: 'Invalid CSRF token',
        });
    }

    next();
}

export default csrfMiddleware;
