/*
 * Bot Bazaar — connecting to the sites.
 *
 * JanitorAI, Chub and Saucepan only trust their own web pages (JanitorAI's sign-in even needs a captcha that only
 * works on janitorai.com), so the login has to be read on the site and handed to SillyTavern. This file holds that
 * hand-over, in three parts that don't depend on the rest of the extension:
 *
 *   1. botBazaarBookmark()  the code that runs on the site (as a bookmark, or pasted into the address bar). It shows
 *                           a big sheet at the bottom of the page — usable with a thumb — that says what it is doing,
 *                           opens SillyTavern, copies the code, lets you fix the SillyTavern address, and spells out
 *                           any failure.
 *   2. encode/decode        the packet format: JSON, gzipped when the browser can, as base64 text.
 *   3. a small journal      what the last hand-over did, so a phone that "does nothing" can be told why.
 */

export const BOOKMARK_VERSION = 5;
export const EXTENSION_VERSION = '5.1.0';

const LAST_KEY = 'botBazaar.lastHandoff';
const ADDRESS_KEY = 'botBazaar.st';

/** Where SillyTavern serves the bookmark's code (bookmark.js, next to this file). */
export const BOOKMARK_URL = new URL('bookmark.js', import.meta.url).href;

let fullText = '';

/** Fetches bookmark.js once, for the self-contained bookmark. Await it before building one with {full: true}. */
export const bookmarkReady = fetch(`${BOOKMARK_URL}?v=${EXTENSION_VERSION}`, { cache: 'no-store' })
    .then(response => (response.ok ? response.text() : ''))
    .then((text) => { fullText = text; })
    .catch(() => { fullText = ''; });

/**
 * The text of the bookmark: the whole code of bookmark.js inside a javascript: address. (Loading it from SillyTavern when
 * pressed would be shorter, but JanitorAI's security policy only lets its pages load scripts from its own servers.)
 * Await bookmarkReady before calling this.
 * @param {string} origin the SillyTavern address it should open
 * @param {{bare?: boolean}} [options] bare = without the "javascript:" prefix, for typing into the address bar yourself
 *   (Chrome on phones removes that prefix from pasted text)
 */
export function buildBookmarklet(origin, { bare = false } = {}) {
    const flat = fullText.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ');
    if (!flat) return '';
    if (/\/\/|%/.test(flat.replace(/\/\*[\s\S]*?\*\//g, ''))) console.error('[Bot Bazaar]', 'bookmark.js contains a // comment or a percent sign and would break as a bookmark.');
    return `${bare ? '' : 'javascript:'}(function(){${flat};botBazaarBookmark(${JSON.stringify(origin)},${BOOKMARK_VERSION})})();void 0`;
}

// ---------------------------------------------------------------------------------------------- the packet

/** Packs a login packet as "bazaar:" text (gzipped when the browser can), the same format the bookmark's Copy code makes. */
export async function encodeHandoff(payload) {
    const json = JSON.stringify(payload);
    if (typeof CompressionStream !== 'undefined') {
        const buf = new Uint8Array(await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
        let bin = '';
        for (let i = 0; i < buf.length; i += 32768) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 32768));
        return `bazaar:z.${btoa(bin)}`;
    }
    return `bazaar:${btoa(unescape(encodeURIComponent(json)))}`;
}

/** Reads what the bookmark handed over: base64 JSON, or "z." + base64 gzip. Returns {payload} or {error}. */
export async function decodeHandoff(data) {
    let text = String(data || '').trim();
    try { text = decodeURIComponent(text); } catch { /* already decoded */ }
    text = text.replace(/^bazaar:/, '').replace(/\s+/g, '');
    if (!text) return { error: 'The code was empty.' };
    try {
        if (text.startsWith('z.')) {
            if (typeof DecompressionStream === 'undefined') return { error: 'This browser is too old to unpack the code (it needs Chrome 80+ or Safari 16.4+). Update the browser, or use the same browser the bookmark ran in.' };
            const bytes = Uint8Array.from(atob(text.slice(2)), ch => ch.charCodeAt(0));
            const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
            return { payload: JSON.parse(await new Response(stream).text()), size: text.length };
        }
        return { payload: JSON.parse(decodeURIComponent(escape(atob(text)))), size: text.length };
    } catch (error) {
        return { error: 'The code looks cut off or damaged. Run the bookmark again and use its Open SillyTavern button.' };
    }
}

// ---------------------------------------------------------------------------------------------- the journal

export function recordHandoff(entry) {
    try { localStorage.setItem(LAST_KEY, JSON.stringify({ at: Date.now(), ...entry })); } catch { /* storage unavailable */ }
}

export function lastHandoff() {
    try { return JSON.parse(localStorage.getItem(LAST_KEY) || 'null'); } catch { return null; }
}

/** The address the bookmark on a site was told to open, if it was changed there (for the check screen). */
export const savedAddressKey = ADDRESS_KEY;

// ---------------------------------------------------------------------------------------------- this device

/** True on a phone or tablet (touch first, small screen). */
export function isPhone() {
    try {
        return matchMedia('(pointer: coarse)').matches || Math.min(screen.width, innerWidth) < 700;
    } catch {
        return false;
    }
}

/**
 * What this browser can do for the hand-over, as plain rows: [ok, label, hint].
 * @param {{proxy?: boolean|null}} [extra]
 */
export function deviceChecks({ proxy = null } = {}) {
    const rows = [];
    rows.push([true, `SillyTavern address on this device: ${location.origin}`, 'The bookmark opens this address. If you made it on another device, change the address on the sheet that appears, or make a new one here.']);
    rows.push([typeof DecompressionStream !== 'undefined', 'Can unpack the code', 'Needs Chrome 80+, Edge, Firefox 113+ or Safari 16.4+.']);
    rows.push([!!navigator.clipboard?.writeText, 'Can copy', 'Needs https or localhost; otherwise copy by hand.']);
    rows.push([!!navigator.clipboard?.readText && window.isSecureContext, 'Can paste for you', 'Without it, paste into the box yourself — that always works.']);
    let storage = true;
    try { localStorage.setItem('botBazaar.t', '1'); localStorage.removeItem('botBazaar.t'); } catch { storage = false; }
    rows.push([storage, 'Can remember logins in this browser', 'Private windows may block it; the logins are also kept by SillyTavern itself.']);
    if (proxy !== null) rows.push([proxy, 'SillyTavern\'s proxy (only for browsing Saucepan here)', 'Optional: the bookmark works without it.']);
    const last = lastHandoff();
    if (last) {
        const ago = Math.max(1, Math.round((Date.now() - last.at) / 60000));
        rows.push([!!last.ok, `Last hand-over: ${ago} min ago, ${last.ok ? `connected ${last.sites?.join(' and ') || 'something'}` : (last.error || 'nothing connected')}`, last.via === 'paste' ? 'It was pasted.' : 'It arrived through the address.']);
    } else {
        rows.push([null, 'No hand-over has reached this device yet', 'Run the bookmark on a signed-in site; this line will change when it arrives.']);
    }
    return rows;
}
