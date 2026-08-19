import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('firebase-admin', () => ({
  default: {
    apps: [],
    app: () => ({ messaging: vi.fn() }),
    initializeApp: vi.fn(),
    credential: { cert: vi.fn() },
    messaging: vi.fn(() => ({
      send: vi.fn(() => Promise.resolve('msg-1')),
      sendEachForMulticast: vi.fn(() =>
        Promise.resolve({ successCount: 1, failureCount: 0, responses: [] })
      ),
    })),
  },
}));

vi.mock('./firebaseCredentials.js', () => ({
  loadFirebaseCredentials: vi.fn(() => null),
}));

vi.mock('../config.js', () => ({
  config: { fcm: { enabled: false } },
}));

describe('fcmSender', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('does not throw on import (FCM disabled)', async () => {
    const { default: fcmSender } = await import('./fcmSender.js');
    expect(fcmSender).toBeDefined();
    expect(fcmSender.initialized).toBe(false);
  });

  it('wakeDevice returns false when not initialized', async () => {
    const { default: fcmSender } = await import('./fcmSender.js');
    const result = await fcmSender.wakeDevice('token-123', 'dev1');
    expect(result).toBe(false);
  });

  it('sendToUser returns failure when not initialized', async () => {
    const { default: fcmSender } = await import('./fcmSender.js');
    const result = await fcmSender.sendToUser('user-1', ['token-a']);
    expect(result.success).toBe(false);
  });

  it('sendToUser returns failure when tokens is empty', async () => {
    const { default: fcmSender } = await import('./fcmSender.js');
    fcmSender.initialized = true;
    const result = await fcmSender.sendToUser('user-1', []);
    expect(result.success).toBe(false);
  });

  it('sendToUser returns failure when tokens is null', async () => {
    const { default: fcmSender } = await import('./fcmSender.js');
    fcmSender.initialized = true;
    const result = await fcmSender.sendToUser('user-1', null);
    expect(result.success).toBe(false);
  });
});