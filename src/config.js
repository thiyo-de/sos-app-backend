import dotenv from 'dotenv';
dotenv.config();

const VALID_ENVS = ['development', 'test', 'testing', 'production'];
const rawEnv = process.env.NODE_ENV;

function resolveNodeEnv() {
  if (!rawEnv) return 'development';
  const normalized = rawEnv === 'testing' ? 'test' : rawEnv;
  if (!VALID_ENVS.includes(normalized)) {
    console.error(
      `[FATAL] Invalid NODE_ENV: "${rawEnv}". Must be one of: ${VALID_ENVS.join(', ')}`
    );
    process.exit(1);
  }
  return normalized;
}

const NODE_ENV = resolveNodeEnv();

function resolvePublicUrl() {
  if (NODE_ENV !== 'production') {
    const port = process.env.PORT || 3000;
    if (process.env.DEV_HTTPS === '1' || process.env.LOCAL_HTTPS === '1') {
      return `https://localhost:${parseInt(port) + 443}`;
    }
    return `http://localhost:${port}`;
  }

  if (process.env.RENDER_EXTERNAL_URL) {
    return process.env.RENDER_EXTERNAL_URL.replace(/\/+$/, '');
  }
  if (process.env.RENDER_URL) {
    return process.env.RENDER_URL.replace(/\/+$/, '');
  }
  return 'https://rat-backend-hhjv.onrender.com';
}

function resolveWebSocketUrl() {
  const wsUrl = resolvePublicUrl()
    .replace(/^http:/, 'ws:')
    .replace(/^https:/, 'wss:');
  return wsUrl;
}

const isProd = NODE_ENV === 'production';
const isTest = NODE_ENV === 'test';
const isDev = NODE_ENV === 'development';

const wsDeviceSecret = process.env.WS_DEVICE_SECRET;
if (!wsDeviceSecret) {
  if (isProd) {
    console.error('[FATAL] WS_DEVICE_SECRET environment variable is required. Set it in .env or environment.');
    process.exit(1);
  }
  console.error('[FATAL] WS_DEVICE_SECRET environment variable is required in all environments. Set it in .env or environment.');
  process.exit(1);
}

const deviceSecret = wsDeviceSecret;

function resolveSecretKey() {
  const key = process.env.SECRET_KEY;
  if (!key) {
    console.error('[FATAL] SECRET_KEY environment variable is required. Set it in .env or environment.');
    process.exit(1);
  }
  return key;
}

const secretKey = resolveSecretKey();

function resolveAdminCredentials() {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !password) {
    console.error('[FATAL] ADMIN_USERNAME and ADMIN_PASSWORD are required. Set them in .env or environment.');
    process.exit(1);
  }
  return {
    username,
    password,
  };
}

function shouldUseSupabase() {
  if (isTest) return false;
  if (isDev && process.env.DEV_USE_SUPABASE !== '1') return false;
  return true;
}

function shouldUseFCM() {
  if (isTest) return false;
  if (isDev && process.env.DEV_USE_FCM !== '1') return false;
  return true;
}

const adminCreds = resolveAdminCredentials();

/**
 * Validate that production configuration is safe to use.
 * Returns an array of issue strings (empty = safe).
 */
export function validateProductionConfig() {
  const issues = [];

  if (isProd) {
    if (!process.env.WS_DEVICE_SECRET) {
      issues.push('WS_DEVICE_SECRET is not set');
    }
    if (!process.env.SECRET_KEY) {
      issues.push('SECRET_KEY is not set');
    }

    const url = resolvePublicUrl();
    if (url.startsWith('http://localhost') || url.startsWith('ws://localhost')) {
      issues.push(`publicUrl resolves to localhost in production: ${url}`);
    }
    if (url.includes('placeholder') || url.includes('example')) {
      issues.push(`publicUrl contains placeholder value: ${url}`);
    }

    if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD) {
      issues.push('ADMIN_USERNAME / ADMIN_PASSWORD are not set');
    }
  }

  return issues;
}

export const env = {
  NODE_ENV,
  isDevelopment: isDev,
  isTest,
  isProduction: isProd,
};

export const config = {
  port: process.env.PORT || 3000,
  nodeEnv: NODE_ENV,
  secretKey,

  publicUrl: resolvePublicUrl(),
  websocketUrl: resolveWebSocketUrl(),

  auth: {
    username: adminCreds.username,
    password: adminCreds.password,
    tokenExpiry: 24 * 60 * 60 * 1000,
  },

  websocket: {
    pingInterval: 30000,
    connectionTimeout: 60000,
    deviceSecret,
  },

  upload: {
    maxFileSize: 100 * 1024 * 1024,
    allowedMimeTypes: [
      'image/jpeg', 'image/png', 'image/gif', 'image/webp',
      'video/mp4', 'video/webm', 'video/3gpp',
      'audio/mpeg', 'audio/wav', 'audio/aac', 'audio/ogg',
      'application/pdf', 'application/zip',
      'application/vnd.android.package-archive',
      'application/octet-stream',
      'text/plain',
    ],
  },

  supabase: {
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_KEY,
    enabled: shouldUseSupabase(),
  },

  fcm: {
    enabled: shouldUseFCM(),
  },

  email: {
    // Optional — if unset, email alerts are disabled (server still runs)
    user: process.env.EMAIL_USER || '',
    appPassword: process.env.EMAIL_APP_PASSWORD || '',
    to: process.env.EMAIL_TO || '',
  },

  security: {
    trustProxy: isProd,
    hstsEnabled: isProd,
    secureCookies: isProd,
  },

  jobs: {
    healthMonitorEnabled: !isTest,
    selfPingEnabled: isProd,
  },

  helpers: {
    isDevelopment: isDev,
    isProduction: isProd,
    isTest,
  },

  env,
};

export default config;