import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REQUIRED_PROPS = ['project_id', 'client_email', 'private_key'];

function sanitizedSourceLabel(source) {
  switch (source) {
    case 'env':
      return 'env var FIREBASE_SERVICE_ACCOUNT';
    case 'base64':
      return 'env var FIREBASE_SERVICE_ACCOUNT_BASE64';
    case 'path':
      return 'env var FIREBASE_SERVICE_ACCOUNT_PATH';
    case 'local':
      return 'local file firebase-service-account.json';
    default:
      return source;
  }
}

function hasRequiredProps(parsed, source) {
  const missing = REQUIRED_PROPS.filter(
    (prop) => !parsed[prop] || typeof parsed[prop] !== 'string' || parsed[prop].trim() === ''
  );
  if (missing.length > 0) {
    console.log(`[FCM] ✗ ${sanitizedSourceLabel(source)} is missing required properties: ${missing.join(', ')}`);
    return false;
  }
  return true;
}

function isOverEscaped(str) {
  return str.includes('\\"') || /\\[nr]/.test(str);
}

function tryParseEnv(str, source) {
  if (!str || str.trim() === '') {
    console.log(`[FCM] ✗ ${sanitizedSourceLabel(source)} is empty`);
    return null;
  }

  try {
    return JSON.parse(str);
  } catch (parseErr) {
    const trimmed = str.trim();

    if (isOverEscaped(trimmed)) {
      console.log(`[FCM] ✗ ${sanitizedSourceLabel(source)} contains backslash-escaped quotes or newline sequences`);
      console.log(`[FCM]   The value appears to be double-escaped (e.g., \\" instead of ").`);
      console.log(`[FCM]   Replace it with the original Firebase service-account JSON using ONE of:`);
      console.log(`[FCM]   1. Single-line compact JSON (no surrounding quotes):`);
      console.log(`[FCM]      FIREBASE_SERVICE_ACCOUNT={"type":"service_account","project_id":"...","private_key":"-----BEGIN PRIVATE KEY-----\\n...\\n-----END PRIVATE KEY-----\\n",...}`);
      console.log(`[FCM]   2. Base64-encoded JSON:`);
      console.log(`[FCM]      FIREBASE_SERVICE_ACCOUNT_BASE64=$(cat service-account.json | base64 -w0)`);
      console.log(`[FCM]   3. File path to service-account JSON:`);
      console.log(`[FCM]      FIREBASE_SERVICE_ACCOUNT_PATH=/etc/secrets/firebase-service-account.json`);
      return null;
    }

    console.log(`[FCM] ✗ ${sanitizedSourceLabel(source)} contains malformed JSON: ${parseErr.message}`);
    return null;
  }
}

function tryParseBase64(str, source) {
  if (!str || str.trim() === '') {
    console.log(`[FCM] ✗ ${sanitizedSourceLabel(source)} is empty`);
    return null;
  }

  const trimmed = str.trim().replace(/\s/g, '');

  // Validate base64 character set
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(trimmed)) {
    console.log(`[FCM] ✗ ${sanitizedSourceLabel(source)} contains invalid base64 characters`);
    return null;
  }

  let decoded;
  try {
    decoded = Buffer.from(trimmed, 'base64').toString('utf8');
  } catch (decodeErr) {
    console.log(`[FCM] ✗ ${sanitizedSourceLabel(source)} is not valid base64: ${decodeErr.message}`);
    return null;
  }

  return tryParseEnv(decoded, source);
}

function tryParseFilePath(filePath, source) {
  if (!filePath || filePath.trim() === '') {
    console.log(`[FCM] ✗ ${sanitizedSourceLabel(source)} is empty`);
    return null;
  }

  const resolved = path.resolve(filePath.trim());

  if (!existsSync(resolved)) {
    console.log(`[FCM] ✗ ${sanitizedSourceLabel(source)} file not found: ${resolved}`);
    return null;
  }

  let content;
  try {
    content = readFileSync(resolved, 'utf8');
  } catch (readErr) {
    console.log(`[FCM] ✗ ${sanitizedSourceLabel(source)} could not be read: ${readErr.message}`);
    return null;
  }

  return tryParseEnv(content, source);
}

export function loadFirebaseCredentials() {
  let parsed = null;
  let source = null;

  // Priority 1: FIREBASE_SERVICE_ACCOUNT (raw JSON string)
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    source = 'env';
    parsed = tryParseEnv(process.env.FIREBASE_SERVICE_ACCOUNT, source);
    if (parsed) {
      console.log('[FCM] Loading credentials from env var');
    }
  }

  // Priority 2: FIREBASE_SERVICE_ACCOUNT_BASE64 (base64-encoded JSON)
  if (!parsed && process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    source = 'base64';
    parsed = tryParseBase64(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, source);
    if (parsed) {
      console.log('[FCM] Loading credentials from base64 env var');
    }
  }

  // Priority 3: FIREBASE_SERVICE_ACCOUNT_PATH (path to JSON file)
  if (!parsed && process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
    source = 'path';
    parsed = tryParseFilePath(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, source);
    if (parsed) {
      console.log('[FCM] Loading credentials from file path');
    }
  }

  // Priority 4: Legacy local file (firebase-service-account.json in project root)
  if (!parsed) {
    const legacyPath = path.join(__dirname, '../../firebase-service-account.json');
    if (existsSync(legacyPath)) {
      source = 'local';
      parsed = tryParseFilePath(legacyPath, source);
      if (parsed) {
        console.log('[FCM] Loading credentials from local file');
      }
    }
  }

  if (parsed) {
    if (!hasRequiredProps(parsed, source)) {
      return null;
    }
    return parsed;
  }

  return null;
}