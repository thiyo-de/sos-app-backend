/**
 * Email Notifier - Sends Gmail alerts for device lifecycle events.
 *
 * Events:
 *  - device online   (first registration, or offline → online after cooldown)
 *  - device offline  (grace period expired / health monitor timeout)
 *  - setup_complete  (device has ALL protection grants enabled)
 *
 * Design rules:
 *  - OPTIONAL: if EMAIL_* vars are not set, all calls are no-ops (server still works).
 *  - Fire-and-forget: never throws, never blocks the WebSocket handler.
 *  - Cooldown per device per event type — prevents email spam on reconnect flaps.
 *  - Fresh transport per send (avoids stale pooled connections on Render free tier).
 */

import nodemailer from 'nodemailer';
import config from '../config.js';

const EMAIL_COOLDOWN_ONLINE_MS = 15 * 60 * 1000;  // 15 min
const EMAIL_COOLDOWN_OFFLINE_MS = 15 * 60 * 1000; // 15 min
const lastSent = new Map(); // key: `${deviceId}:${event}` → timestamp

function emailEnabled() {
  const e = config.email;
  return Boolean(e && e.user && e.appPassword && e.to);
}

function inCooldown(key, cooldownMs) {
  const last = lastSent.get(key) || 0;
  const now = Date.now();
  if (now - last < cooldownMs) return true;
  lastSent.set(key, now);
  return false;
}

function deviceLabel(deviceId, metadata = {}) {
  const model = metadata.model || 'Unknown device';
  const manufacturer = metadata.manufacturer || '';
  return `${manufacturer ? manufacturer + ' ' : ''}${model} (${String(deviceId).slice(0, 8)}…)`;
}

/**
 * Send an email. Resolves true when delivered, false otherwise. Never rejects.
 */
export async function sendEmail(subject, text) {
  if (!emailEnabled()) {
    console.log(`[Email] Skipped (not configured): ${subject}`);
    return false;
  }
  try {
    const transport = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: config.email.user,
        pass: config.email.appPassword,
      },
    });
    await transport.sendMail({
      from: config.email.user,
      to: config.email.to,
      subject,
      text,
    });
    transport.close();
    console.log(`[Email] Sent: ${subject}`);
    return true;
  } catch (err) {
    console.error(`[Email] Failed to send "${subject}": ${err.message}`);
    return false;
  }
}

/**
 * Alert: device came online. Cooldown 15 min per device (reconnect flaps are
 * common — OEM kill recovery, WiFi↔Data switches, reboots).
 */
export async function notifyDeviceOnline(deviceId, metadata = {}) {
  const key = `${deviceId}:online`;
  if (inCooldown(key, EMAIL_COOLDOWN_ONLINE_MS)) {
    console.log(`[Email] Skipped online alert for ${deviceId} (cooldown)`);
    return false;
  }
  return sendEmail(
    `✅ SOS device online — ${deviceLabel(deviceId, metadata)}`,
    [
      `Your SOS app device came online:`,
      ``,
      `  Device: ${deviceLabel(deviceId, metadata)}`,
      `  Time:   ${new Date().toLocaleString()}`,
      ``,
      `Battery: ${metadata.battery != null ? metadata.battery + '%' : 'N/A'}`,
      `Android: ${metadata.androidVersion || 'N/A'}`,
    ].join('\n')
  );
}

/**
 * Alert: device went offline. Cooldown 15 min per device.
 */
export async function notifyDeviceOffline(deviceId, metadata = {}) {
  const key = `${deviceId}:offline`;
  if (inCooldown(key, EMAIL_COOLDOWN_OFFLINE_MS)) {
    console.log(`[Email] Skipped offline alert for ${deviceId} (cooldown)`);
    return false;
  }
  return sendEmail(
    `⚠️ SOS device offline — ${deviceLabel(deviceId, metadata)}`,
    [
      `Your SOS app device went offline:`,
      ``,
      `  Device: ${deviceLabel(deviceId, metadata)}`,
      `  Time:   ${new Date().toLocaleString()}`,
      `  Last battery: ${metadata.battery != null ? metadata.battery + '%' : 'N/A'}`,
      ``,
      `Possible causes: reboot, OEM kill, airplane mode, or network loss.`,
    ].join('\n')
  );
}

/**
 * Alert: device completed full protection setup (all grants enabled).
 * One-time by design (client dedupes) — no cooldown needed.
 */
export async function notifySetupComplete(deviceId, state = {}, metadata = {}) {
  return sendEmail(
    `🛡️ SOS fully protected — ${deviceLabel(deviceId, metadata)}`,
    [
      `Device has ALL protection grants enabled:`,
      ``,
      `  Device: ${deviceLabel(deviceId, metadata)}`,
      `  Time:   ${new Date().toLocaleString()}`,
      `  Admin:       ${state.adminActive ? '✅' : '❌'}`,
      `  Listener:    ${state.notificationListenerConnected ? '✅' : '❌'}`,
      `  Boot start:  ${state.bootStartEnabled ? '✅' : '❌'}`,
      `  Watchdog:    ${state.watchdogRunning ? '✅' : '❌'}`,
    ].join('\n')
  );
}