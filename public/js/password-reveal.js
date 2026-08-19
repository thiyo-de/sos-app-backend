/**
 * Password text reconstruction engine.
 *
 * Android masks password input both in accessibility EVENT payloads and in the
 * source node's text (AccessibilityNodeInfo.getText()) — a snapshot looks like
 * "••••••••••••j": one bullet per character plus the NEWEST character visible.
 *
 * That single visible character per snapshot is enough to rebuild the real text:
 * string together the newest character of each snapshot in order, undo backspaces
 * when snapshots shrink, and flag cases where full recovery is impossible (paste,
 * select-all overwrite, first snapshot mid-field, fully-masked OEM builds).
 *
 * Pure and deterministic: given the same chronological event list it always
 * returns the same result, so it is unit-testable and can be moved to the server
 * (precompute) or the phone later without a rewrite.
 *
 * Works in the browser (window.PasswordReveal) and in Node (module.exports) so
 * vitest can exercise it.
 */

(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory();
    } else {
        root.PasswordReveal = factory();
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // Bullets used by Android/apps to mask characters.
    const BULLET_RE = /[•●◦○∙⋅·\u2022\u25CF\u25CB\u2219\u00B7]/;

    /** True when the string contains at least one bullet (i.e. it is masked). */
    function isMasked(text) {
        return BULLET_RE.test(text || '');
    }

    /** Character count in code points (survives emoji passwords). */
    function countChars(str) {
        return Array.from(str || '').length;
    }

    function lastChar(str) {
        const a = Array.from(str || '');
        return a.length ? a[a.length - 1] : '';
    }

    /** Number of trailing non-bullet characters — the visible tail. */
    function visibleSuffixLen(str) {
        const a = Array.from(str || '');
        let i = a.length - 1;
        while (i >= 0 && !BULLET_RE.test(a[i])) i--;
        return a.length - 1 - i;
    }

    /**
     * Pick the best snapshot for an event: an unmasked string is authoritative
     * (full real text); otherwise the candidate with the longest visible tail.
     */
    // Only these event types carry a password-field snapshot.
    const TEXT_TYPES = { text_changed: 1, text_selection: 1, selection: 1, content_change: 1 };

    function pickBestSnapshot(ev) {
        const cands = [];
        if (ev.realText) cands.push(String(ev.realText));
        if (ev.text) cands.push(String(ev.text));
        if (!cands.length) return '';
        let best = cands[0];
        for (const c of cands) {
            if (!isMasked(c)) return c; // full truth
            if (visibleSuffixLen(c) > visibleSuffixLen(best)) best = c;
            else if (visibleSuffixLen(c) === visibleSuffixLen(best) && countChars(c) > countChars(best)) best = c;
        }
        return best;
    }

    /**
     * Reconstruct the real text of a password field from its chronological
     * snapshot events (one typing session / burst).
     *
     * @param {Array<Object>} events  chronological text events for one field
     * @returns {{text: string, partial: boolean, reason: (string|null)}}
     */
    function reconstructPassword(events) {
        const list = Array.isArray(events) ? events : [];

        let lastUnmasked = null; // full readable string seen (authoritative)
        let recovered = '';
        let prev = '';
        let prevCount = 0;
        let partial = false;
        let reason = null;

        for (const ev of list) {
            const type = ev.type || '';
            if (type && !TEXT_TYPES[type]) continue; // clicks/focus/etc. carry no snapshot

            const snap = pickBestSnapshot(ev);
            if (!snap) continue;

            const snapCount = countChars(snap);
            const tail = visibleSuffixLen(snap);
            const newChar = tail > 0 ? lastChar(snap) : '';
            const added = Number(ev.addedCount) || 0;
            const removed = Number(ev.removedCount) || 0;

            if (!isMasked(snap) && snapCount > 1) {
                // Whole string is readable and more than one char — this is the
                // truth (app/OEM not masking the node text). Stop reasoning.
                lastUnmasked = snap;
                prev = snap;
                prevCount = snapCount;
                continue;
            }
            if (lastUnmasked !== null) continue; // already have full text

            if (snap === prev) continue; // duplicate event (~3/keystroke)

            if (prev === '') {
                // First snapshot of the burst. If it already has N bullets we have
                // no history for the earlier N-1 chars — only the newest is known.
                recovered = newChar;
                partial = tail > 0 && snapCount > 1;
                reason = partial ? 'started mid-field' : null;
            } else if (snapCount > prevCount) {
                const diff = snapCount - prevCount;
                if (added > 1 || diff > 1) {
                    // paste or multi-char jump — middle chars are lost
                    recovered += newChar;
                    partial = true;
                    reason = added > 1 ? 'paste' : 'multi-char jump';
                } else {
                    recovered += newChar;
                }
            } else if (snapCount < prevCount) {
                if (removed > 0 && removed >= prevCount) {
                    // select-all overwrite: reset then keep the new char
                    recovered = newChar;
                    partial = true;
                    reason = 'select-all overwrite';
                } else {
                    // backspace / deletion
                    recovered = Array.from(recovered).slice(0, snapCount).join('');
                    partial = partial || countChars(recovered) !== snapCount;
                    if (partial && !reason) reason = 'length drift';
                }
            } else {
                // same length → replace last character
                if (newChar && newChar !== lastChar(prev)) {
                    const a = Array.from(recovered);
                    a[a.length - 1] = newChar;
                    recovered = a.join('');
                }
            }

            prev = snap;
            prevCount = snapCount;
        }

        if (lastUnmasked !== null) {
            return { text: lastUnmasked, partial: false, reason: null };
        }
        if (!recovered) {
            return { text: '', partial: true, reason: 'unrecoverable' };
        }
        return { text: recovered, partial: partial, reason: partial ? reason : null };
    }

    return {
        isMasked: isMasked,
        countChars: countChars,
        lastChar: lastChar,
        visibleSuffixLen: visibleSuffixLen,
        pickBestSnapshot: pickBestSnapshot,
        reconstructPassword: reconstructPassword,
    };
});
