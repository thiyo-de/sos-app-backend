import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';

vi.mock('../config.js', () => ({
  default: { secretKey: 'test-mock-secret-32-minimum-size' },
}));

describe('csrf middleware', () => {
  let generateCsrfToken, csrfMiddleware;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../middleware/csrf.js');
    generateCsrfToken = mod.generateCsrfToken;
    csrfMiddleware = mod.csrfMiddleware;
  });

  describe('generateCsrfToken', () => {
    it('returns null for null authToken', () => {
      expect(generateCsrfToken(null)).toBeNull();
    });

    it('returns a hex string for a valid authToken', () => {
      const token = generateCsrfToken('test-auth-token');
      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThan(0);
      expect(/^[0-9a-f]+$/i.test(token)).toBe(true);
    });

    it('same input produces same output', () => {
      expect(generateCsrfToken('abc')).toBe(generateCsrfToken('abc'));
    });

    it('different inputs produce different outputs', () => {
      expect(generateCsrfToken('abc')).not.toBe(generateCsrfToken('xyz'));
    });
  });

  describe('csrfMiddleware', () => {
    it('skips CSRF check for GET requests', () => {
      const req = { method: 'GET', path: '/api/data', headers: {}, header: vi.fn() };
      const next = vi.fn();
      csrfMiddleware(req, {}, next);
      expect(next).toHaveBeenCalled();
    });

    it('skips CSRF check for HEAD requests', () => {
      const req = { method: 'HEAD', path: '/api/data', headers: {}, header: vi.fn() };
      const next = vi.fn();
      csrfMiddleware(req, {}, next);
      expect(next).toHaveBeenCalled();
    });

    it('skips CSRF check for OPTIONS requests', () => {
      const req = { method: 'OPTIONS', path: '/api/data', headers: {}, header: vi.fn() };
      const next = vi.fn();
      csrfMiddleware(req, {}, next);
      expect(next).toHaveBeenCalled();
    });

    it('skips CSRF check for /auth/login', () => {
      const req = { method: 'POST', path: '/auth/login', headers: {}, header: vi.fn() };
      const next = vi.fn();
      csrfMiddleware(req, {}, next);
      expect(next).toHaveBeenCalled();
    });

    it('skips CSRF check for /api/device-upload-temp', () => {
      const req = { method: 'POST', path: '/api/device-upload-temp', headers: {}, header: vi.fn() };
      const next = vi.fn();
      csrfMiddleware(req, {}, next);
      expect(next).toHaveBeenCalled();
    });

    it('returns 403 for POST missing X-CSRF-Token header', () => {
      const req = { method: 'POST', path: '/api/upload', headers: {}, header: vi.fn(() => null) };
      const json = vi.fn();
      const status = vi.fn(() => ({ json }));
      csrfMiddleware(req, { status }, vi.fn());
      expect(status).toHaveBeenCalledWith(403);
    });

    it('returns 401 when auth cookie is missing', () => {
      const req = { method: 'POST', path: '/api/upload', headers: {}, header: vi.fn(() => 'token-123') };
      const json = vi.fn();
      const status = vi.fn(() => ({ json }));
      csrfMiddleware(req, { status }, vi.fn());
      expect(status).toHaveBeenCalledWith(401);
    });

    it('returns 403 when CSRF token is invalid', () => {
      const req = {
        method: 'POST',
        path: '/api/upload',
        headers: { cookie: 'auth_token=fake-auth-token' },
        header: vi.fn(() => 'wrong-csrf'),
      };
      const json = vi.fn();
      const status = vi.fn(() => ({ json }));
      csrfMiddleware(req, { status }, vi.fn());
      expect(status).toHaveBeenCalledWith(403);
    });

    it('calls next() when CSRF token matches', () => {
      const correctToken = generateCsrfToken('real-auth-token');
      const req = {
        method: 'POST',
        path: '/api/upload',
        headers: { cookie: 'auth_token=real-auth-token' },
        header: vi.fn(() => correctToken),
      };
      const next = vi.fn();
      csrfMiddleware(req, {}, next);
      expect(next).toHaveBeenCalled();
    });
  });
});