import admin from 'firebase-admin';
import { loadFirebaseCredentials } from './firebaseCredentials.js';
import { config } from '../config.js';

class FCMSender {
    constructor() {
        this.initialized = false;

        if (!config.fcm.enabled) {
            console.log('[FCM] 🔇 FCM disabled by environment config (test mode)');
            return;
        }

        try {
            const serviceAccount = loadFirebaseCredentials();

            if (!serviceAccount) {
                console.log('[FCM] ⚠️ Firebase not initialized — push wake disabled');
                return;
            }

            const existingApps = admin.apps || [];
            if (existingApps.length > 0) {
                this.messaging = admin.app().messaging();
                this.initialized = true;
                console.log('[FCM] ✅ Firebase Admin SDK initialized');
                return;
            }

            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount),
            });

            this.messaging = admin.messaging();
            this.initialized = true;
            console.log('[FCM] ✅ Firebase Admin SDK initialized');
        } catch (err) {
            console.log('[FCM] ⚠️ Firebase not initialized — push wake disabled');
            console.log(`[FCM] Reason: ${err.message}`);
        }
    }

    async wakeDevice(fcmToken, deviceId) {
        if (!this.initialized) {
            console.log(`[FCM] Cannot wake ${deviceId} — Firebase not initialized`);
            return false;
        }

        if (!fcmToken) {
            console.log(`[FCM] Cannot wake ${deviceId} — no FCM token`);
            return false;
        }

        try {
            console.log(`[FCM] Sending wake push to ${deviceId}...`);

            const result = await this.messaging.send({
                token: fcmToken,
                data: {
                    action: 'wake',
                    timestamp: Date.now().toString(),
                    deviceId: deviceId,
                },
                android: {
                    priority: 'high',
                    ttl: 60000,
                },
            });

            console.log(`[FCM] ✅ Wake push delivered to ${deviceId} (messageId: ${result})`);
            return true;
        } catch (err) {
            console.error(`[FCM] ❌ Wake push failed for ${deviceId}:`, err.message);

            if (err.code === 'messaging/invalid-registration-token' ||
                err.code === 'messaging/registration-token-not-registered') {
                console.log(`[FCM] Token expired for ${deviceId} — device needs to re-register`);
            }

            return false;
        }
    }

    /**
     * Send FCM wake push to ALL devices belonging to a user.
     * Uses sendEachForMulticast for efficient batching.
     * Automatically cleans up stale/invalid tokens.
     */
    async sendToUser(userId, tokens) {
        if (!this.initialized) {
            console.log(`[FCM] Cannot send to user ${userId} — Firebase not initialized`);
            return { success: false, sent: 0, failed: 0, staleTokens: [] };
        }

        if (!tokens || tokens.length === 0) {
            console.log(`[FCM] Cannot send to user ${userId} — no FCM tokens`);
            return { success: false, sent: 0, failed: 0, staleTokens: [] };
        }

        try {
            console.log(`[FCM] Sending multicast wake push to ${tokens.length} device(s) for user ${userId}...`);

            const result = await this.messaging.sendEachForMulticast({
                tokens,
                data: {
                    action: 'wake',
                    timestamp: Date.now().toString(),
                },
                android: {
                    priority: 'high',
                    ttl: 60000,
                },
            });

            const sent = result.successCount;
            const failed = result.failureCount;
            const staleTokens = [];

            if (result.responses) {
                result.responses.forEach((resp, idx) => {
                    if (!resp.success) {
                        const errCode = resp.error?.code;
                        if (errCode === 'messaging/invalid-registration-token' ||
                            errCode === 'messaging/registration-token-not-registered') {
                            staleTokens.push(tokens[idx]);
                        }
                    }
                });
            }

            console.log(`[FCM] ✅ Multicast result for user ${userId}: ${sent} sent, ${failed} failed, ${staleTokens.length} stale`);
            return { success: sent > 0, sent, failed, staleTokens };
        } catch (err) {
            console.error(`[FCM] ❌ Multicast push failed for user ${userId}:`, err.message);
            return { success: false, sent: 0, failed: tokens.length, staleTokens: [] };
        }
    }
}

export const fcmSender = new FCMSender();
export default fcmSender;