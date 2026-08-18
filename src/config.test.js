import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('dotenv', () => ({ default: { config: vi.fn() } }));

beforeEach(() => {
  process.env.NODE_ENV = 'test';
  process.env.WS_DEVICE_SECRET = 'WS_DEVICE_SECRET_32_CHARS_MIN_LEN';
  process.env.SECRET_KEY = 'SECRET_KEY_32_CHAR_MIN_LENGTH_!';
  process.env.ADMIN_USERNAME = 'admin';
  process.env.ADMIN_PASSWORD = 'test-password-123';
  process.env.PORT = '3000';
  delete process.env.DEV_HTTPS;
  delete process.env.LOCAL_HTTPS;
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function deleteMock() {
  delete require?.cache;
}

describe('env object', () => {
  it('has the same NODE_ENV that was on process.env', async () => {
    const { env } = await import('./config.js');
    expect(env.NODE_ENV).toBe('test');
    expect(env.isTest).toBe(true);
    expect(env.isDevelopment).toBe(false);
    expect(env.isProduction).toBe(false);
  });
});

describe('config object', () => {
  it('derives all top-level and nested keys', async () => {
    const { config } = await import('./config.js');
    expect(config.port).toBe('3000');
    expect(config.nodeEnv).toBe('test');
    expect(config.secretKey).toBe(process.env.SECRET_KEY);
    expect(config.auth).toMatchObject({
      username: process.env.ADMIN_USERNAME,
      password: process.env.ADMIN_PASSWORD,
      tokenExpiry: 86400000,
    });
    expect(config.websocket).toMatchObject({
      pingInterval: 30000,
      connectionTimeout: 60000,
      deviceSecret: process.env.WS_DEVICE_SECRET,
    });
    expect(config.upload.maxFileSize).toBe(104857600);
    expect(config.upload.allowedMimeTypes).toEqual(expect.arrayContaining(['image/jpeg', 'video/mp4']));
    expect(config.security.trustProxy).toBe(false);
    expect(config.security.hstsEnabled).toBe(false);
    expect(config.security.secureCookies).toBe(false);
    expect(config.jobs.healthMonitorEnabled).toBe(false);
    expect(config.jobs.selfPingEnabled).toBe(false);
    expect(config.helpers.isTest).toBe(true);
    expect(config.helpers.isDevelopment).toBe(false);
    expect(config.helpers.isProduction).toBe(false);
    expect(config.supabase.enabled).toBe(false);
    expect(config.fcm.enabled).toBe(false);
  });

  it('publicUrl uses http://localhost in non-prod', async () => {
    const { config } = await import('./config.js');
    expect(config.publicUrl).toBe(`http://localhost:${config.port}`);
  });

  it('websocketUrl mirrors publicUrl with ws scheme', async () => {
    const { config } = await import('./config.js');
    expect(config.websocketUrl).toBe(`ws://localhost:${config.port}`);
  });
});

describe('validateProductionConfig', () => {
  it('empty issues when production config is clean', async () => {
    process.env.NODE_ENV = 'production';
    process.env.WS_DEVICE_SECRET = 'prod_device_secret_32';
    process.env.SECRET_KEY = 'prod_secret_key_32';
    process.env.ADMIN_USERNAME = 'prodadmin';
    process.env.ADMIN_PASSWORD = 'prodpass123';
    process.env.RENDER_EXTERNAL_URL = 'https://remoteapp-prod.onrender.com';
    vi.resetModules();

    const { validateProductionConfig } = await import('./config.js');
    expect(validateProductionConfig()).toEqual([]);
  });

  it('flags localhost in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.WS_DEVICE_SECRET = 'prod_device_secret_32';
    process.env.SECRET_KEY = 'prod_secret_key_32';
    process.env.ADMIN_USERNAME = 'prodadmin';
    process.env.ADMIN_PASSWORD = 'prodpass123';
    process.env.RENDER_EXTERNAL_URL = 'http://localhost:9999';
    vi.resetModules();

    const { validateProductionConfig } = await import('./config.js');
    const issues = validateProductionConfig();
    expect(issues.find(s => s.includes('localhost'))).toBeDefined();
  });

  it('flags placeholder url', async () => {
    process.env.NODE_ENV = 'production';
    process.env.WS_DEVICE_SECRET = 'prod_device_secret_32';
    process.env.SECRET_KEY = 'prod_secret_key_32';
    process.env.ADMIN_USERNAME = 'prodadmin';
    process.env.ADMIN_PASSWORD = 'prodpass123';
    process.env.RENDER_EXTERNAL_URL = 'https://your-app-name-here.example.com';
    vi.resetModules();

    const { validateProductionConfig } = await import('./config.js');
    const issues = validateProductionConfig();
    expect(issues.find(s => s.includes('placeholder'))).toBeDefined();
  });

  it('empty array when NODE_ENV is not production', async () => {
    const { validateProductionConfig } = await import('./config.js');
    expect(validateProductionConfig()).toEqual([]);
  });
});

describe('config exports', () => {
  it('default export equals named config', async () => {
    const { config, default: defaultExport } = await import('./config.js');
    expect(defaultExport).toBe(config);
  });

  it('env export has correct shape', async () => {
    const { env } = await import('./config.js');
    expect(Object.keys(env).sort()).toEqual(
      ['NODE_ENV', 'isDevelopment', 'isProduction', 'isTest'].sort()
    );
  });
});