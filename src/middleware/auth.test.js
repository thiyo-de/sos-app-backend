import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';

vi.mock('../config.js', () => ({
  default: {
    secretKey: 'test-mock-secret-key-32-minimum-size',
    auth: { tokenExpiry: 3600000 },
  },
}));

describe('auth middleware', () => {
  let createToken, verifyToken, authMiddleware;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../middleware/auth.js');
    createToken = mod.createToken;
    verifyToken = mod.verifyToken;
    authMiddleware = mod.authMiddleware;
  });

  describe('createToken', () => {
    it('returns a colon-separated token', () => {
      const token = createToken('admin');
      const parts = token.split(':');
      expect(parts).toHaveLength(3);
      expect(parts[0]).toBe('admin');
    });

    it('token contains valid expiry timestamp', () => {
      const token = createToken('user');
      const [, expiry] = token.split(':');
      const expiryMs = parseInt(expiry, 10);
      expect(expiryMs).toBeGreaterThan(Date.now());
    });
  });

  describe('verifyToken', () => {
    it('returns valid: false for null/empty token', () => {
      expect(verifyToken(null).valid).toBe(false);
      expect(verifyToken('').valid).toBe(false);
    });

    it('returns valid: false for malformed token', () => {
      expect(verifyToken('short').valid).toBe(false);
      expect(verifyToken('a:b').valid).toBe(false);
    });

    it('returns reason: expired for expired token', () => {
      const past = Date.now() - 10000;
      const payload = `user:${past}`;
      const sig = crypto
        .createHmac('sha256', 'test-mock-secret-key-32-minimum-size')
        .update(payload)
        .digest('hex');
      const token = `user:${past}:${sig}`;
      const result = verifyToken(token);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('expired');
    });

    it('returns valid: true with csrfToken for a valid token', () => {
      const token = createToken('admin');
      const result = verifyToken(token);
      expect(result.valid).toBe(true);
      expect(result.username).toBe('admin');
      expect(result.csrfToken).toBeDefined();
    });

    it('returns valid: false for tampered signature', () => {
      const token = createToken('admin');
      const parts = token.split(':');
      parts[2] = 'tampered';
      const result = verifyToken(parts.join(':'));
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('invalid_signature');
    });
  });

  describe('authMiddleware', () => {
    it('skips authentication for /login.html', () => {
      const req = { path: '/login.html', headers: {} };
      const next = vi.fn();
      authMiddleware(req, {}, next);
      expect(next).toHaveBeenCalled();
    });

    it('skips auth for /auth/login', () => {
      const req = { path: '/auth/login', headers: {} };
      const next = vi.fn();
      authMiddleware(req, {}, next);
      expect(next).toHaveBeenCalled();
    });

    it('redirects to login when no auth cookie', () => {
      const req = { path: '/dashboard', headers: {} };
      const redirect = vi.fn();
      const next = vi.fn();
      const res = { redirect };
      authMiddleware(req, res, next);
      expect(redirect).toHaveBeenCalledWith('/login.html');
      expect(next).not.toHaveBeenCalled();
    });

    it('returns JSON 401 for API path without auth', () => {
      const req = { path: '/api/devices', headers: {} };
      const json = vi.fn();
      const status = vi.fn(() => ({ json }));
      authMiddleware(req, { status }, vi.fn());
      expect(status).toHaveBeenCalledWith(401);
    });

    it('proceeds with valid auth cookie', () => {
      const token = createToken('admin');
      const req = {
        path: '/dashboard',
        headers: { cookie: `auth_token=${token}` },
      };
      const next = vi.fn();
      authMiddleware(req, {}, next);
      expect(next).toHaveBeenCalled();
      expect(req.adminUser).toBe('admin');
    });
  });
});