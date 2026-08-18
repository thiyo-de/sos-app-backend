// Test environment setup for vitest
// This file runs before all tests to set up the test environment

import { vi } from 'vitest';

// Mock console methods to reduce noise in tests
global.console = {
  ...console,
  log: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.PORT = '3001';
process.env.SECRET_KEY = 'test-secret-key-32-characters-minimum';
process.env.WS_DEVICE_SECRET = 'test-device-secret-32-chars';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'test-password-123';
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
process.env.FIREBASE_PROJECT_ID = 'test-project';
process.env.FIREBASE_CLIENT_EMAIL = 'test@test.iam.gserviceaccount.com';
process.env.FIREBASE_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----\n';

// Suppress unhandled rejection warnings during tests
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

// Mock timers for testing timeouts/intervals
vi.useFakeTimers();