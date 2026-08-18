import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sendMailMock = vi.fn().mockResolvedValue({ accepted: ['x@y.z'] });
const transportMock = {
    sendMail: sendMailMock,
    close: vi.fn(),
};
const createTransportMock = vi.fn().mockReturnValue(transportMock);

vi.mock('nodemailer', () => ({
    default: {
        createTransport: (...args) => createTransportMock(...args),
    },
}));

async function loadNotifierWithEnv(envVars = {}) {
    vi.resetModules();
    for (const [k, v] of Object.entries(envVars)) {
        process.env[k] = v;
    }
    const mod = await import('./emailNotifier.js');
    return mod;
}

function clearEnv() {
    delete process.env.EMAIL_USER;
    delete process.env.EMAIL_APP_PASSWORD;
    delete process.env.EMAIL_TO;
}

describe('emailNotifier', () => {
    beforeEach(() => {
        clearEnv();
        vi.clearAllMocks();
    });

    afterEach(() => {
        clearEnv();
    });

    it('returns false without sending when email is not configured', async () => {
        const mod = await loadNotifierWithEnv();
        const result = await mod.sendEmail('test', 'body');
        expect(result).toBe(false);
        expect(createTransportMock).not.toHaveBeenCalled();
    });

    it('sends email when configured', async () => {
        const mod = await loadNotifierWithEnv({
            EMAIL_USER: 'me@gmail.com',
            EMAIL_APP_PASSWORD: 'abcd efgh ijkl mnop',
            EMAIL_TO: 'me@gmail.com',
        });
        const result = await mod.sendEmail('Hello', 'Body text');
        expect(result).toBe(true);
        expect(createTransportMock).toHaveBeenCalledWith({
            service: 'gmail',
            auth: { user: 'me@gmail.com', pass: 'abcd efgh ijkl mnop' },
        });
        expect(sendMailMock).toHaveBeenCalledWith(
            expect.objectContaining({ to: 'me@gmail.com', subject: 'Hello', text: 'Body text' })
        );
    });

    it('notifies online with cooldown — second call within 15 min is skipped', async () => {
        const mod = await loadNotifierWithEnv({
            EMAIL_USER: 'me@gmail.com',
            EMAIL_APP_PASSWORD: 'abcd efgh ijkl mnop',
            EMAIL_TO: 'me@gmail.com',
        });
        const first = await mod.notifyDeviceOnline('dev-1', { model: 'Pixel 8' });
        const second = await mod.notifyDeviceOnline('dev-1', { model: 'Pixel 8' });
        expect(first).toBe(true);
        expect(second).toBe(false);
        expect(sendMailMock).toHaveBeenCalledTimes(1);
    });

    it('allows a different device through the cooldown (per-device keys)', async () => {
        const mod = await loadNotifierWithEnv({
            EMAIL_USER: 'me@gmail.com',
            EMAIL_APP_PASSWORD: 'abcd efgh ijkl mnop',
            EMAIL_TO: 'me@gmail.com',
        });
        await mod.notifyDeviceOnline('dev-1', {});
        const second = await mod.notifyDeviceOnline('dev-2', {});
        expect(second).toBe(true);
        expect(sendMailMock).toHaveBeenCalledTimes(2);
    });

    it('sends setup_complete without cooldown blocking', async () => {
        const mod = await loadNotifierWithEnv({
            EMAIL_USER: 'me@gmail.com',
            EMAIL_APP_PASSWORD: 'abcd efgh ijkl mnop',
            EMAIL_TO: 'me@gmail.com',
        });
        const result = await mod.notifySetupComplete('dev-1', {
            adminActive: true,
            notificationListenerConnected: true,
            bootStartEnabled: true,
            watchdogRunning: true,
        }, { model: 'Redmi Note 12' });
        expect(result).toBe(true);
        expect(sendMailMock).toHaveBeenCalledTimes(1);
        expect(sendMailMock.mock.calls[0][0].subject).toContain('SOS fully protected');
    });
});
