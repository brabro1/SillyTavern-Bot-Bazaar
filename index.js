/*
 * Bot Bazaar — SillyTavern extension
 *
 *  • Browse and search JanitorAI, Chub and Saucepan from inside SillyTavern.
 *  • Import characters with their full definition, greetings, tags, avatar and lorebooks, or import lorebooks alone.
 *
 * Everything runs in the browser.
 *  - Chub's API is public, so it needs nothing.
 *  - Saucepan only answers its own website, so it goes through SillyTavern's built-in CORS proxy; definitions and
 *    lorebooks need the user's Saucepan login (captured by the same bookmark).
 *  - JanitorAI only gives definitions and lorebooks to a signed-in account, so the user connects their account by
 *    pasting a login token (stored in the extension settings, sent only to janitorai.com), or installs the optional
 *    helper userscript (janitor-bridge.user.js). Definitions and lorebooks the creator keeps private stay private.
 */

import { deleteCharacter, processDroppedFiles } from '../../../../script.js';
import { deleteWorldInfo } from '../../../world-info.js';

const TAG = '[Bot Bazaar]';
const SITE = 'https://janitorai.com';
const AVATARS = 'https://ella.janitorai.com/bot-avatars/';
const USERSCRIPT_URL = new URL('janitor-bridge.user.js', import.meta.url).href;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const ctx = () => SillyTavern.getContext();

// ---------------------------------------------------------------------------------------------- account token

const TOKEN = /eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/;
const JANITOR_AUTH = 'https://auth.janitorai.com/auth/v1';

function settings() {
    const all = ctx().extensionSettings;
    all.janitorImporter ??= { token: '' };
    return all.janitorImporter;
}

const fromBase64Url = (text) => atob(text.replace(/-/g, '+').replace(/_/g, '/'));

/** Pulls a bare login token out of whatever was pasted. */
function extractToken(raw) {
    const text = String(raw || '').trim();
    const variants = [text];
    try { variants.push(decodeURIComponent(text)); } catch { /* not URL-encoded */ }
    for (const variant of [...variants]) {
        const encoded = variant.match(/base64-([\w+/=-]+)/);
        try { if (encoded) variants.push(fromBase64Url(encoded[1])); } catch { /* not base64 */ }
    }
    for (const variant of variants) {
        const match = variant.match(TOKEN);
        if (match) return match[0];
    }
    return '';
}

function tokenExpiry(token) {
    try {
        const exp = JSON.parse(fromBase64Url(token.split('.')[1])).exp;
        return typeof exp === 'number' ? exp * 1000 : null;
    } catch {
        return null;
    }
}

const SESSION_KEY = 'botBazaar.janitorSession';
const TOKEN_KEY = 'botBazaar.janitorToken';
// One shared copy on the SillyTavern server, so every tab and device uses the same, newest login. Written as its own
// file (like the favorites), so a tab holding old settings in memory can't save an outdated login over it.
const SESSION_FILE = 'bot-bazaar-login.json';
let fileSession = null;

const readLocal = (key) => {
    try { return localStorage.getItem(key) || ''; } catch { return ''; }
};

const parseSession = (raw) => {
    if (!raw) return null;
    try {
        const session = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return session && typeof session === 'object' ? session : null;
    } catch {
        return null;
    }
};

const sessionExpiry = (session) => (session?.expires_at ? session.expires_at * 1000 : (session?.access_token ? tokenExpiry(session.access_token) : null));

/** Newest copy wins: by save time, then by expiry. A disconnect is saved too (no token), so it wins over older logins. */
const newestSession = (copies) => copies.filter(Boolean)
    .sort((a, b) => ((b.saved_at || 0) - (a.saved_at || 0)) || ((sessionExpiry(b) || 0) - (sessionExpiry(a) || 0)))[0] || null;

/**
 * The JanitorAI login. The access token is what the API needs; when the bookmark also captured the refresh token
 * and the site's public key, Bot Bazaar renews the access token the same way the JanitorAI website does.
 */
function janitorSession() {
    const newest = newestSession([parseSession(settings().session), parseSession(readLocal(SESSION_KEY)), fileSession]);
    if (newest) return newest.access_token ? newest : null;
    const token = settings().token || readLocal(TOKEN_KEY);
    return token ? { access_token: token } : null;
}

async function loadSessionFile() {
    try {
        const response = await fetch(`/user/files/${SESSION_FILE}?t=${Date.now()}`, { cache: 'no-store' });
        if (response.ok) fileSession = parseSession(await response.json());
    } catch { /* no shared copy yet */ }
    return fileSession;
}

async function uploadSessionFile(record) {
    fileSession = record;
    try {
        await fetch('/api/files/upload', {
            method: 'POST',
            headers: ctx().getRequestHeaders(),
            body: JSON.stringify({ name: SESSION_FILE, data: base64Utf8(JSON.stringify(record)) }),
        });
    } catch (error) {
        console.warn(TAG, 'Could not save the shared login', error);
    }
}

/** Saves the login in this browser, the SillyTavern settings and the shared login file. Pass null to disconnect. */
function storeJanitorSession(session) {
    const record = { ...(session || {}), saved_at: Date.now() };
    const serial = JSON.stringify(record);
    settings().session = serial;
    settings().token = session?.access_token || '';
    ctx().saveSettingsDebounced();
    try {
        localStorage.setItem(SESSION_KEY, serial);
        if (session?.access_token) localStorage.setItem(TOKEN_KEY, session.access_token);
        else localStorage.removeItem(TOKEN_KEY);
    } catch { /* storage unavailable */ }
    return uploadSessionFile(record);
}

/** Manual-paste path: wrap a bare token as a (non-renewable) session. */
const storeToken = (token) => storeJanitorSession(token ? { access_token: token } : null);

function account() {
    const session = janitorSession();
    const token = session?.access_token || '';
    const expiry = sessionExpiry(session);
    return {
        token,
        session,
        canRefresh: !!(session?.refresh_token && session?.apikey),
        expired: !!token && expiry !== null && expiry < Date.now(),
        minutesLeft: expiry !== null ? Math.round((expiry - Date.now()) / 60000) : null,
    };
}

let refreshing = null;

/** Renews the JanitorAI login from its refresh token — the same request the JanitorAI website makes in the background. */
function refreshJanitor() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
        try {
            // Another tab or device may already have renewed it; never renew from an outdated copy.
            await loadSessionFile();
            const { session, minutesLeft } = account();
            if (!session?.refresh_token || !session?.apikey) return false;
            if (minutesLeft !== null && minutesLeft > 2) return true;

            const response = await fetch(`${JANITOR_AUTH}/token?grant_type=refresh_token`, {
                method: 'POST',
                credentials: 'omit',
                headers: { apikey: session.apikey, Authorization: `Bearer ${session.apikey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ refresh_token: session.refresh_token }),
            });
            if (!response.ok) {
                // Maybe someone renewed it a moment ago; if so, use theirs.
                await loadSessionFile();
                const latest = account();
                if (latest.session?.refresh_token && latest.session.refresh_token !== session.refresh_token) return true;
                // Otherwise the renewal is no longer valid (signed out on the site): keep the login until it expires, stop renewing.
                if (response.status === 400 || response.status === 401) await storeJanitorSession({ access_token: session.access_token, expires_at: session.expires_at });
                return false;
            }
            const data = await response.json();
            if (!data?.access_token) return false;
            await storeJanitorSession({
                access_token: data.access_token,
                refresh_token: data.refresh_token || session.refresh_token,
                expires_at: data.expires_at || (data.expires_in ? Math.floor(Date.now() / 1000) + data.expires_in : undefined),
                apikey: session.apikey,
            });
            return true;
        } catch {
            return false;
        } finally {
            refreshing = null;
        }
    })();
    return refreshing;
}

/** Before a request, renew the token if it has expired or is about to, and we can. */
async function ensureFreshJanitor() {
    const { token, canRefresh, minutesLeft } = account();
    if (token && canRefresh && (minutesLeft === null || minutesLeft <= 2)) await refreshJanitor();
}

/** On start: pick up the shared login (and share this browser's, if it is newer or the file doesn't exist yet). */
async function syncSessionOnStart() {
    await loadSessionFile();
    const local = newestSession([parseSession(settings().session), parseSession(readLocal(SESSION_KEY))]);
    if (local?.access_token && (!fileSession || (local.saved_at || 0) > (fileSession.saved_at || 0))) {
        await uploadSessionFile({ ...local, saved_at: local.saved_at || Date.now() });
    }
    scheduleRefresh();
    if (root) updateStatus();
}

let refreshTimer = null;

/** Keeps the login current while SillyTavern is open, refreshing shortly before it would expire. */
function scheduleRefresh() {
    clearTimeout(refreshTimer);
    const { token, canRefresh, minutesLeft } = account();
    if (!token || !canRefresh) return;
    const delay = Math.max(60000, ((minutesLeft ?? 60) - 2) * 60000);
    refreshTimer = setTimeout(async () => {
        if (await refreshJanitor()) updateStatus();
        scheduleRefresh();
    }, delay);
}

// Renewable logins count as connected even past the access token's expiry, since the next request refreshes first.
const signedIn = () => !!bridgeVersion || (!!account().token && (!account().expired || account().canRefresh));

// ---------------------------------------------------------------------------------------------- transport

const pending = new Map();
let seq = 0;
let bridgeVersion = null;
let bridgeProbed = false;
let queue = Promise.resolve();

// Messages from the optional helper userscript.
window.addEventListener('message', (event) => {
    const msg = event.data;
    if (event.source !== window || msg?.source !== 'jai-bridge') return;
    if (msg.event === 'hello') {
        bridgeVersion = msg.version;
        updateStatus();
    }
    const waiter = pending.get(msg.id);
    if (waiter) {
        pending.delete(msg.id);
        clearTimeout(waiter.timer);
        waiter.resolve(msg);
    }
});

function send(op, payload = {}, timeout = 70000) {
    return new Promise((resolve) => {
        const id = `jai${++seq}`;
        const timer = setTimeout(() => {
            pending.delete(id);
            resolve({ ok: false, code: 'error', error: 'The helper script did not answer.' });
        }, timeout);
        pending.set(id, { resolve, timer });
        window.postMessage({ source: 'jai-ext', id, op, ...payload }, location.origin);
    });
}

async function detectBridge() {
    if (!bridgeVersion && !bridgeProbed) {
        await send('hello', {}, 500);
        bridgeProbed = true;
    }
    return !!bridgeVersion;
}

class ApiError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

async function viaHelper(path) {
    const res = await send('api', { path });
    if (!res.ok) throw new ApiError(res.code || 'error', res.error || 'Request failed.');
    return { status: res.status, body: res.body || '', authed: !!res.authed };
}

async function direct(path) {
    await ensureFreshJanitor();
    const { token, expired } = account();
    const headers = { Accept: 'application/json' };
    // JanitorAI treats a bad token as "anonymous" instead of rejecting it, so never send one we know is stale.
    if (token && !expired) headers.Authorization = `Bearer ${token}`;
    let response;
    try {
        response = await fetch(SITE + path, { headers, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
    } catch {
        throw new ApiError('network', 'Could not reach JanitorAI from this browser. Check that janitorai.com opens in a normal tab on this device.');
    }
    return { status: response.status, body: await response.text(), authed: !!headers.Authorization };
}

/** GET a JanitorAI API path. Requests run one at a time. */
function api(path) {
    const run = async () => {
        const res = await detectBridge() ? await viaHelper(path) : await direct(path);
        const isJson = /^\s*[{[]/.test(res.body);
        if ((res.status === 401 || res.status === 403) && isJson) {
            throw new ApiError('auth', res.authed ? 'JanitorAI did not accept your login.' : 'This needs a JanitorAI account.');
        }
        if (!isJson) {
            throw new ApiError('http', `JanitorAI sent an unexpected answer (${res.status}). It may be showing a browser check — open janitorai.com in a tab, wait for it to load, then try again.`);
        }
        if (res.status < 200 || res.status >= 300) {
            const error = new ApiError('http', `JanitorAI answered with an error (${res.status}).`);
            error.status = res.status;
            throw error;
        }
        return JSON.parse(res.body);
    };
    const result = queue.then(run, run);
    queue = result.catch(() => { });
    return result;
}

async function fetchImage(url) {
    if (bridgeVersion) {
        const res = await send('image', { url });
        if (res.ok) return new Blob([res.buffer], { type: res.type || 'image/png' });
    }
    try {
        const response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
        return response.ok ? await response.blob() : null;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------------------------- conversion

const str = (value) => (typeof value === 'string' ? value : '');
const firstDefined = (...values) => values.find(v => v !== undefined && v !== null);

function toList(value) {
    if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
    if (typeof value === 'string') return value.split(',').map(v => v.trim()).filter(Boolean);
    return [];
}

function tryJson(value) {
    if (typeof value !== 'string') return value;
    const text = value.trim();
    if (!text.startsWith('{') && !text.startsWith('[')) return value;
    try {
        return JSON.parse(text);
    } catch {
        return value;
    }
}

const CONTENT_FIELDS = ['content', 'text', 'entry', 'value'];
const KEY_FIELDS = ['keys', 'key', 'keywords', 'triggers', 'primary_keys', 'primaryKeys', 'activation_keys'];
const SECONDARY_FIELDS = ['secondary_keys', 'keysecondary', 'secondaryKeys', 'secondary_keywords'];

function looksLikeEntry(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const hasContent = CONTENT_FIELDS.some(f => typeof item[f] === 'string');
    const hasKeys = KEY_FIELDS.some(f => f in item) || 'constant' in item || 'always_on' in item;
    return hasContent && hasKeys;
}

/** Finds the list of lorebook entries inside whatever shape a script comes in. */
function findEntries(node, depth = 0) {
    node = tryJson(node);
    if (!node || typeof node !== 'object' || depth > 6) return null;

    const list = Array.isArray(node) ? node : null;
    if (list?.some(looksLikeEntry)) return list.filter(looksLikeEntry);

    if (!list) {
        // SillyTavern style: { entries: { "0": {...}, "1": {...} } }
        const values = Object.values(node);
        if (values.length && values.every(v => v && typeof v === 'object') && values.some(looksLikeEntry)) {
            return values.filter(looksLikeEntry);
        }
    }

    for (const value of (list || Object.values(node))) {
        const found = findEntries(value, depth + 1);
        if (found?.length) return found;
    }
    return null;
}

function convertEntry(entry, index, defaults = {}) {
    const keys = toList(firstDefined(...KEY_FIELDS.map(f => entry[f])));
    const secondary = toList(firstDefined(...SECONDARY_FIELDS.map(f => entry[f])));
    const content = str(firstDefined(...CONTENT_FIELDS.map(f => (typeof entry[f] === 'string' ? entry[f] : undefined))));
    const title = [entry.comment, entry.name, entry.title, entry.memo, entry.label].map(str).find(t => t.trim()) || keys[0] || `Entry ${index + 1}`;
    const enabled = entry.enabled !== undefined ? !!entry.enabled : (entry.disable !== undefined ? !entry.disable : (entry.disabled !== undefined ? !entry.disabled : true));
    const constant = !!firstDefined(entry.constant, entry.always_on, entry.alwaysOn, entry.always_active, entry.alwaysActive, keys.length === 0);
    const order = Number(firstDefined(entry.insertion_order, entry.order, entry.priority, 100));
    const numericPosition = typeof entry.position === 'number' || /^\d+$/.test(str(entry.position)) ? Number(entry.position) : null;
    const before = entry.position === 'before_char' || numericPosition === 0 || entry.position === 'before' || entry.placementPosition === 'before';
    const probability = Number(firstDefined(entry.probability, entry.extensions?.probability, 100));
    const caseSensitive = firstDefined(entry.case_sensitive, entry.caseSensitive, entry.extensions?.case_sensitive);
    const wholeWords = firstDefined(entry.matchWholeWords, entry.match_whole_words, entry.extensions?.match_whole_words);
    // JanitorAI's "depth" is how many recent messages are scanned for keywords (per entry, or for the whole book).
    const scanDepth = Number(firstDefined(entry.scan_depth, entry.scanDepth, entry.extensions?.scan_depth, entry.depth, defaults.depth));
    const group = str(firstDefined(entry.inclusionGroupRaw, entry.group)).trim();

    const extensions = { ...(entry.extensions && typeof entry.extensions === 'object' ? entry.extensions : {}) };
    extensions.position = numericPosition ?? (before ? 0 : 1);
    extensions.probability = Number.isFinite(probability) ? probability : 100;
    extensions.useProbability = true;
    if (typeof caseSensitive === 'boolean') extensions.case_sensitive = caseSensitive;
    if (typeof wholeWords === 'boolean') extensions.match_whole_words = wholeWords;
    if (Number.isFinite(scanDepth) && scanDepth > 0) extensions.scan_depth = scanDepth;
    if (Number.isFinite(entry.selectiveLogic)) extensions.selectiveLogic = entry.selectiveLogic;
    if (group) {
        extensions.group = group;
        if (Number.isFinite(entry.groupWeight)) extensions.group_weight = entry.groupWeight;
    }

    return {
        id: index,
        keys,
        secondary_keys: secondary,
        comment: title,
        name: title,
        content,
        constant,
        selective: secondary.length > 0,
        insertion_order: Number.isFinite(order) ? order : 100,
        enabled,
        position: before ? 'before_char' : 'after_char',
        use_regex: false,
        extensions,
    };
}

const scriptTitle = (script, index) => str(script?.title) || str(script?.name) || `Script ${index + 1}`;

/** Splits a character's attached scripts into what can be imported and what can't. */
function sortScripts(detail) {
    let scripts = tryJson(detail.scripts);
    if (!scripts) scripts = [];
    if (!Array.isArray(scripts)) scripts = [scripts];
    const lorebooks = scripts.filter(s => s?.type !== 'advanced');
    return {
        all: scripts,
        shared: lorebooks.filter(s => s?.is_public !== false),
        private: lorebooks.filter(s => s?.is_public === false),
        advanced: scripts.filter(s => s?.type === 'advanced'),
    };
}

/**
 * Collects every shared lorebook attached to a JanitorAI character into one V2 character_book.
 * A character lists its scripts as { id, title, type, is_public }; the entries live at /hampter/script/<id>
 * as a JSON string in "script", and only when the creator made the lorebook public.
 * @returns {Promise<{book: object|null, warnings: string[], scriptCount: number}>}
 */
const scriptCache = new Map();

/**
 * Fetches one lorebook. A lorebook can be attached publicly while its contents stay private
 * (is_code_public: false) — JanitorAI then sends no entries at all.
 * @returns {Promise<{status: 'ok'|'private'|'unreadable', entries?: object[], settings?: object}>}
 */
async function fetchScript(id) {
    if (scriptCache.has(id)) return scriptCache.get(id);
    let result;
    try {
        const full = await api(`/hampter/script/${encodeURIComponent(id)}`);
        const entries = findEntries(full?.script ?? null);
        const settings = tryJson(full?.settings);
        if (entries?.length) result = { status: 'ok', entries, settings: settings && typeof settings === 'object' ? settings : {} };
        else result = { status: full?.is_code_public === false || full?.script == null ? 'private' : 'unreadable' };
    } catch (error) {
        if (error.code === 'auth') throw error;
        console.warn(TAG, 'Could not fetch script', id, error);
        result = { status: error.status === 404 ? 'private' : 'unreadable' };
    }
    scriptCache.set(id, result);
    return result;
}

const nameList = (names) => names.map(n => `"${n}"`).join(', ');

/**
 * Collects every readable lorebook attached to a JanitorAI character into one V2 character_book.
 * A character lists its scripts as { id, title, type, is_public }; the entries live at /hampter/script/<id>
 * as a JSON string in "script", and only when the creator made the contents public.
 * @returns {Promise<{book: object|null, warnings: string[], scriptCount: number}>}
 */
async function buildLorebook(detail, bookName) {
    const scripts = sortScripts(detail).all;
    const entries = [];
    const hidden = [];
    const unreadable = [];
    const code = [];

    for (const [i, raw] of scripts.entries()) {
        const script = tryJson(raw);
        const id = typeof script === 'string' ? script : firstDefined(script?.id, script?.script_id);
        const label = scriptTitle(script, i);

        if (script?.type === 'advanced') {
            code.push(label);
            continue;
        }

        const inline = findEntries(script);
        if (inline?.length) {
            inline.forEach(entry => entries.push(convertEntry(entry, entries.length)));
            continue;
        }
        if (!id || !UUID.test(String(id))) {
            unreadable.push(label);
            continue;
        }
        if (script?.is_public === false) {
            hidden.push(label);
            continue;
        }

        const result = await fetchScript(String(id));
        if (result.status === 'ok') result.entries.forEach(entry => entries.push(convertEntry(entry, entries.length, result.settings)));
        else (result.status === 'private' ? hidden : unreadable).push(label);
    }

    const warnings = [];
    if (hidden.length) {
        warnings.push(hidden.length === 1
            ? `The creator keeps the contents of the lorebook ${nameList(hidden)} private, so it can't be imported.`
            : `The creator keeps the contents of ${hidden.length} lorebooks private, so they can't be imported: ${nameList(hidden)}.`);
    }
    if (unreadable.length) warnings.push(`Could not read ${unreadable.length === 1 ? 'the lorebook' : 'these lorebooks'}: ${nameList(unreadable)}.`);
    if (code.length) warnings.push(`Skipped ${code.length === 1 ? 'a code script' : 'code scripts'} SillyTavern can't run: ${nameList(code)}.`);

    if (!entries.length) return { book: null, warnings, scriptCount: scripts.length };
    return {
        book: { name: bookName, description: `Imported from JanitorAI (${detail.id})`, extensions: {}, entries },
        warnings,
        scriptCount: scripts.length,
    };
}

const cleanTag = (name) => str(name).replace(/^[^\p{L}\p{N}#]+/u, '').trim();
const safeName = (name) => str(name)
    .replace(/\{\{(\w+)\}\}/g, (_, macro) => macro.charAt(0).toUpperCase() + macro.slice(1))
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
// Greetings stay visible even when the creator hides the definition, so they don't count.
const hasDefinition = (d) => !!(str(d.personality).trim() || str(d.scenario).trim() || str(d.example_dialogs).trim());

function buildCard(detail, book) {
    const greetings = [...new Set(
        [detail.first_message, ...(Array.isArray(detail.first_messages) ? detail.first_messages : [])].map(str).filter(g => g.trim()),
    )];
    const firstMes = greetings[0] || '';
    const alternates = greetings.slice(1);
    const name = safeName(detail.chat_name) || safeName(detail.name) || 'Janitor character';
    const tags = [...new Set([
        ...(Array.isArray(detail.tags) ? detail.tags.map(t => cleanTag(t?.name ?? t)) : []),
        ...(Array.isArray(detail.custom_tags) ? detail.custom_tags.map(cleanTag) : []),
    ].filter(Boolean))];

    const data = {
        name,
        description: str(detail.personality),
        personality: '',
        scenario: str(detail.scenario),
        first_mes: firstMes,
        mes_example: str(detail.example_dialogs),
        creator_notes: str(detail.description),
        system_prompt: '',
        post_history_instructions: '',
        alternate_greetings: alternates,
        tags,
        creator: str(detail.creator_name),
        character_version: '',
        extensions: {
            talkativeness: '0.5',
            fav: false,
            world: book ? book.name : '',
            depth_prompt: { prompt: '', depth: 4, role: 'system' },
            janitor: {
                id: detail.id,
                title: str(detail.name),
                source: `${SITE}/characters/${detail.id}`,
                ...(detail.definition_source ? { definition_source: detail.definition_source } : {}),
            },
        },
    };
    if (book) data.character_book = book;

    return { spec: 'chara_card_v2', spec_version: '2.0', data };
}

// ---------------------------------------------------------------------------------------------- PNG writer

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function base64Utf8(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(binary);
}

/** Inserts a tEXt "chara" chunk (the character card) right before IEND. */
function embedCard(png, card) {
    const text = new TextEncoder().encode(`chara\0${base64Utf8(JSON.stringify(card))}`);
    const typeAndData = new Uint8Array(4 + text.length);
    typeAndData.set([0x74, 0x45, 0x58, 0x74]); // tEXt
    typeAndData.set(text, 4);

    const chunk = new Uint8Array(12 + text.length);
    const view = new DataView(chunk.buffer);
    view.setUint32(0, text.length);
    chunk.set(typeAndData, 4);
    view.setUint32(8 + text.length, crc32(typeAndData));

    const iend = png.length - 12;
    const out = new Uint8Array(png.length + chunk.length);
    out.set(png.subarray(0, iend));
    out.set(chunk, iend);
    out.set(png.subarray(iend), iend + chunk.length);
    return out;
}

async function avatarPng(imageUrl, displayName) {
    let bitmap = null;
    if (imageUrl) {
        try {
            const blob = await fetchImage(imageUrl);
            if (blob) bitmap = await createImageBitmap(blob);
        } catch (error) {
            console.warn(TAG, 'Avatar download failed', error);
        }
    }

    const canvas = document.createElement('canvas');
    const g = canvas.getContext('2d');
    if (bitmap) {
        const scale = Math.min(1, 1536 / Math.max(bitmap.width, bitmap.height));
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    } else {
        canvas.width = 400;
        canvas.height = 600;
        const gradient = g.createLinearGradient(0, 0, 400, 600);
        gradient.addColorStop(0, '#3b2a55');
        gradient.addColorStop(1, '#16161f');
        g.fillStyle = gradient;
        g.fillRect(0, 0, 400, 600);
        g.fillStyle = '#ffffffcc';
        g.font = 'bold 120px sans-serif';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText((displayName.match(/[\p{L}\p{N}]/u)?.[0] || '?').toUpperCase(), 200, 300);
    }

    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    return { bytes: new Uint8Array(await blob.arrayBuffer()), placeholder: !bitmap };
}

// ---------------------------------------------------------------------------------------------- outside definition

const JANNY = 'https://jannyai.com/characters/';

/** Reads the character card stored inside a PNG (tEXt chunk "ccv3" or "chara"). */
function readCardFromPng(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const found = {};
    for (let offset = 8; offset + 12 <= bytes.length;) {
        const length = view.getUint32(offset);
        const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
        if (type === 'tEXt') {
            const data = bytes.subarray(offset + 8, offset + 8 + length);
            const split = data.indexOf(0);
            const keyword = new TextDecoder('latin1').decode(data.subarray(0, split)).toLowerCase();
            if (keyword === 'chara' || keyword === 'ccv3') found[keyword] = data.subarray(split + 1);
        }
        if (type === 'IEND') break;
        offset += 12 + length;
    }
    const raw = found.chara || found.ccv3;
    if (!raw) return null;
    const binary = atob(new TextDecoder('latin1').decode(raw));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, c => c.charCodeAt(0))));
}

async function readCardFile(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
    const card = isPng ? readCardFromPng(bytes) : JSON.parse(new TextDecoder().decode(bytes));
    const data = card?.data && typeof card.data === 'object' ? card.data : card;
    if (!data || typeof data !== 'object' || !(str(data.description).trim() || str(data.personality).trim() || str(data.scenario).trim())) {
        throw new Error('That file does not contain a character definition.');
    }
    return data;
}

/** SillyTavern's own server can download JannyAI's copy — when JannyAI's bot protection lets that server through. */
async function fetchJannyCopy(id) {
    const response = await fetch('/api/content/importURL', {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify({ url: `${SITE}/characters/${id}` }),
    });
    if (!response.ok) throw new Error(`SillyTavern could not download it (${response.status}).`);
    return readCardFile(await response.blob());
}

/** Fills the parts JanitorAI withholds with the ones from another copy of the card. */
function withOutsideDefinition(detail, data) {
    const hasGreeting = str(detail.first_message).trim() || (Array.isArray(detail.first_messages) && detail.first_messages.some(g => str(g).trim()));
    const merged = {
        ...detail,
        personality: [data.description, data.personality].map(str).filter(t => t.trim()).join('\n\n'),
        scenario: str(data.scenario),
        example_dialogs: str(data.mes_example),
        definition_source: 'jannyai',
    };
    if (!hasGreeting) {
        merged.first_message = str(data.first_mes);
        merged.first_messages = Array.isArray(data.alternate_greetings) ? data.alternate_greetings : [];
    }
    return merged;
}

const looseName = (name) => str(name).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

function sameCharacter(detail, data) {
    const other = looseName(data.name);
    return !!other && [detail.name, detail.chat_name].map(looseName).some(n => n && (n.includes(other) || other.includes(n)));
}

// ---------------------------------------------------------------------------------------------- import

/** Saves the lorebook (if any), builds the PNG card and hands it to SillyTavern's normal importer. */
async function finishImport(card, book, imageUrl, name, warnings = []) {
    const { saveWorldInfo, convertCharacterBook, updateWorldInfoList, getWorldInfoNames } = ctx();
    if (book) {
        // Create the world file first so the link in the card resolves as soon as the character appears.
        const replacing = getWorldInfoNames().includes(book.name);
        await saveWorldInfo(book.name, convertCharacterBook(structuredClone(book)), true);
        await updateWorldInfoList();
        console.info(TAG, `${replacing ? 'Replaced' : 'Created'} lorebook "${book.name}" with ${book.entries.length} entries`);
    }

    const avatar = await avatarPng(imageUrl, name);
    const file = new File([embedCard(avatar.bytes, card)], `${name}.png`, { type: 'image/png' });
    await processDroppedFiles([file]);

    if (book) toastr.success(`${book.entries.length} lorebook entries imported and linked.`, 'Bot Bazaar');
    warnings.forEach(w => toastr.warning(w, 'Bot Bazaar', { timeOut: 12000 }));
    if (avatar.placeholder) toastr.info('The avatar could not be downloaded, a placeholder was used.', 'Bot Bazaar');
}

async function importCharacter(detail) {
    const { Popup } = ctx();
    const name = safeName(detail.chat_name) || safeName(detail.name) || 'Janitor character';

    if (!hasDefinition(detail)) {
        const proceed = await Popup.show.confirm(
            'Definition not available',
            signedIn()
                ? 'The creator has hidden the definition of this character, so JanitorAI does not send it. Import what is public (name, avatar, description, tags, greetings and any shared lorebook)? To add the definition from a JannyAI copy instead, cancel and use the buttons under "Definition hidden".'
                : 'Your JanitorAI account is not connected, so the definition and lorebook are not available. Import only the public info (name, avatar, description, tags)?',
        );
        if (!proceed) return false;
    }

    const bookName = `${name} (Janitor Lorebook)`;
    const { book, warnings } = await buildLorebook(detail, bookName);
    const card = buildCard(detail, book);

    await finishImport(card, book, detail.avatar ? `${AVATARS}${encodeURIComponent(detail.avatar)}` : '', name, warnings);
    return true;
}

/** Imports just the shared lorebook(s) of a character as a World Info file, e.g. for a card obtained elsewhere. */
async function importLorebookOnly(detail) {
    const { saveWorldInfo, convertCharacterBook, updateWorldInfoList } = ctx();
    const name = safeName(detail.chat_name) || safeName(detail.name) || 'Janitor character';
    const bookName = `${name} (Janitor Lorebook)`;
    const { book, warnings } = await buildLorebook(detail, bookName);
    warnings.forEach(w => toastr.warning(w, 'Bot Bazaar', { timeOut: 12000 }));
    if (!book) return toastr.info('No lorebook entries could be imported for this character.', 'Bot Bazaar');

    await saveWorldInfo(bookName, convertCharacterBook(structuredClone(book)), true);
    await updateWorldInfoList();
    toastr.success(`"${bookName}" saved with ${book.entries.length} entries. To attach it, open a character and pick it with the globe button.`, 'Bot Bazaar', { timeOut: 12000 });
}

// ---------------------------------------------------------------------------------------------- Chub

const CHUB_API = 'https://gateway.chub.ai';
const CHUB_SITE = 'https://chub.ai';
const CHUB_PAGE_SIZE = 24;

/** Chub's API is public and allows browser requests, so no account or helper is needed. */
async function chubGet(url) {
    let response;
    try {
        response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
    } catch {
        throw new ApiError('network', 'Could not reach Chub from this browser. Check that chub.ai opens in a normal tab on this device.');
    }
    if (!response.ok) {
        const error = new ApiError('http', `Chub answered with an error (${response.status}).`);
        error.status = response.status;
        throw error;
    }
    return response.json();
}

const chubRawLorebookUrl = (id) => `https://api.chub.ai/api/v4/projects/${encodeURIComponent(id)}/repository/files/raw%252Fsillytavern_raw.json/raw`;

/** "user/slug" for characters, "lorebooks/user/id" for lorebooks. */
function chubParts(fullPath) {
    const parts = str(fullPath).split('/');
    const isLorebook = parts[0] === 'lorebooks';
    return { isLorebook, creator: isLorebook ? parts[1] : parts[0] };
}

const chubPageUrl = (fullPath) => `${CHUB_SITE}/${chubParts(fullPath).isLorebook ? '' : 'characters/'}${fullPath}`;

function markdownToHtml(markdown) {
    try {
        const converter = new SillyTavern.libs.showdown.Converter({ simpleLineBreaks: true, strikethrough: true, tables: true, openLinksInNewWindow: true });
        return converter.makeHtml(str(markdown));
    } catch {
        return esc(markdown).replace(/\n/g, '<br>');
    }
}

function topicChips(topics) {
    return (Array.isArray(topics) ? topics : [])
        .map(topic => `<span class="jai_chip" data-topic="${esc(topic)}" title="Show more with this tag">${esc(topic)}</span>`)
        .join('');
}

/** Turns a Chub search result into the shared card model. */
function chubModel(node) {
    const { isLorebook, creator } = chubParts(node.fullPath);
    return {
        source: 'chub',
        id: node.fullPath,
        kind: isLorebook ? 'lorebook' : 'character',
        name: node.name,
        image: node.avatar_url || '',
        creatorId: creator,
        creatorName: creator,
        verified: !!node.verified,
        blurb: esc(str(node.tagline).trim() || str(node.description).trim().slice(0, 300)),
        stats: `<i class="fa-solid fa-star"></i> ${compact(node.starCount)} <i class="fa-solid fa-heart"></i> ${compact(node.n_favorites)}${relatedLorebooks(node).length ? ' <i class="fa-solid fa-book-atlas" title="Has linked lorebooks"></i>' : ''}`,
        chats: node.nChats,
        statsTitle: `${compact(node.starCount)} stars · ${compact(node.n_favorites)} favorites · ${compact(node.nChats)} chats`,
        chips: topicChips(node.topics),
        tokens: node.nTokens,
        updated: node.lastActivityAt || node.createdAt,
    };
}

async function chubList() {
    const query = new URLSearchParams({
        first: CHUB_PAGE_SIZE,
        page: state.page,
        namespace: state.kind,
        nsfw: state.mode !== 'sfw',
        nsfl: false,
        include_forks: true,
        sort: state.sort,
        asc: false,
    });
    if (state.search) query.set('search', state.search);
    if (state.topic) query.set('topics', state.topic);
    if (state.creator) query.set('username', state.creator.id);
    const result = await chubGet(`${CHUB_API}/search?${query}`);
    const nodes = Array.isArray(result?.data?.nodes) ? result.data.nodes : [];
    return { items: nodes.map(chubModel), total: Number(result?.data?.count) || nodes.length, size: CHUB_PAGE_SIZE };
}

async function chubDetail(fullPath) {
    const { isLorebook } = chubParts(fullPath);
    const result = await chubGet(`${CHUB_API}/api/${isLorebook ? '' : 'characters/'}${fullPath}?full=true`);
    if (!result?.node) throw new ApiError('http', 'Chub did not return this page.');
    return result.node;
}

const relatedLorebooks = (node) => [...new Set([
    ...(Array.isArray(node.related_lorebooks) ? node.related_lorebooks : []),
    ...(Array.isArray(node.definition?.extensions?.chub?.related_lorebooks) ? node.definition.extensions.chub.related_lorebooks : []),
])].filter(id => Number(id) > 0);

const linkedCache = new Map();

/**
 * Downloads one linked Chub lorebook by its project id.
 * @returns {Promise<{status: 'ok'|'missing'|'failed', entries?: object[]}>}
 */
async function fetchLinkedLorebook(id) {
    if (linkedCache.has(id)) return linkedCache.get(id);
    let result;
    try {
        const world = await chubGet(chubRawLorebookUrl(id));
        const entries = (Array.isArray(world?.entries) ? world.entries : Object.values(world?.entries || {})).filter(e => e && typeof e === 'object');
        const name = str(world?.name).trim();
        result = entries.length ? { status: 'ok', entries, name: name && name !== 'Exported' ? name : '' } : { status: 'missing' };
    } catch (error) {
        console.warn(TAG, 'Linked Chub lorebook failed', id, error);
        // Chub answers 404 "Project not found" for deleted or private lorebooks.
        result = { status: error.status === 404 ? 'missing' : 'failed' };
    }
    linkedCache.set(id, result);
    return result;
}

/** Embedded lorebook + every linked lorebook of a Chub character, merged into one V2 character_book. */
async function chubBook(node, bookName) {
    const warnings = [];
    const entries = [];
    const embedded = node.definition?.embedded_lorebook;
    if (Array.isArray(embedded?.entries)) embedded.entries.forEach(entry => entries.push(convertEntry(entry, entries.length)));

    let missing = 0;
    let failed = 0;
    for (const id of relatedLorebooks(node)) {
        const linked = await fetchLinkedLorebook(id);
        if (linked.status === 'ok') linked.entries.forEach(entry => entries.push(convertEntry(entry, entries.length)));
        else if (linked.status === 'missing') missing++;
        else failed++;
    }
    if (missing) {
        warnings.push(`${missing === 1 ? 'A linked lorebook is' : `${missing} linked lorebooks are`} no longer on Chub — deleted or made private by ${missing === 1 ? 'its' : 'their'} creator — so ${missing === 1 ? 'it' : 'they'} can't be imported.`);
    }
    if (failed) warnings.push(`${failed === 1 ? 'A linked lorebook' : `${failed} linked lorebooks`} could not be downloaded from Chub right now. Try again later.`);

    if (!entries.length) return { book: null, warnings };
    return { book: { name: bookName, description: `Imported from Chub (${node.fullPath})`, extensions: {}, entries }, warnings };
}

function buildChubCard(node, book) {
    const def = node.definition || {};
    const { creator } = chubParts(node.fullPath);
    const extensions = def.extensions && typeof def.extensions === 'object' ? structuredClone(def.extensions) : {};
    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: safeName(def.name || node.name) || 'Chub character',
            description: str(def.personality),
            personality: str(def.tavern_personality),
            scenario: str(def.scenario),
            first_mes: str(def.first_message),
            mes_example: str(def.example_dialogs),
            creator_notes: str(def.description),
            system_prompt: str(def.system_prompt),
            post_history_instructions: str(def.post_history_instructions),
            alternate_greetings: (Array.isArray(def.alternate_greetings) ? def.alternate_greetings : []).map(str).filter(g => g.trim()),
            tags: Array.isArray(node.topics) ? node.topics : [],
            creator,
            character_version: '',
            extensions: {
                talkativeness: '0.5',
                fav: false,
                depth_prompt: { prompt: '', depth: 4, role: 'system' },
                ...extensions,
                world: book ? book.name : '',
                chub: { ...(extensions.chub || {}), full_path: node.fullPath, id: node.id, source: chubPageUrl(node.fullPath) },
            },
            ...(book ? { character_book: book } : {}),
        },
    };
}

async function importChubCharacter(node) {
    const name = safeName(node.definition?.name || node.name) || 'Chub character';
    const { book, warnings } = await chubBook(node, `${name} (Chub Lorebook)`);
    const card = buildChubCard(node, book);
    await finishImport(card, book, node.max_res_url || node.avatar_url || '', name, warnings);
    return true;
}

/** Saves a Chub lorebook as a World Info file. Returns the number of entries. */
async function importChubLorebook(node, bookName = safeName(node.name) || 'Chub lorebook') {
    const { saveWorldInfo, convertCharacterBook, updateWorldInfoList } = ctx();
    const embedded = node.definition?.embedded_lorebook;
    let world = null;
    if (Array.isArray(embedded?.entries) && embedded.entries.length) {
        world = convertCharacterBook(structuredClone({ ...embedded, entries: embedded.entries.map((e, i) => convertEntry(e, i)) }));
    } else {
        const raw = await chubGet(chubRawLorebookUrl(node.id));
        if (raw?.entries && Object.keys(raw.entries).length) world = raw;
    }
    if (!world) throw new Error('This lorebook has no entries.');

    await saveWorldInfo(bookName, world, true);
    await updateWorldInfoList();
    const count = Object.keys(world.entries || {}).length;
    toastr.success(`"${bookName}" saved with ${count} entries. To attach it, open a character and pick it with the globe button.`, 'Bot Bazaar', { timeOut: 12000 });
    return count;
}

// ---------------------------------------------------------------------------------------------- Chub account

const CHUB_KEY_STORE = 'botBazaar.chubKey';

function chubAccount() {
    let key = settings().chubKey || '';
    try { key = localStorage.getItem(CHUB_KEY_STORE) || key; } catch { /* storage unavailable */ }
    return { key, user: settings().chubUser || '' };
}

function storeChubKey(key, user = '') {
    settings().chubKey = key;
    settings().chubUser = user;
    ctx().saveSettingsDebounced();
    try {
        if (key) localStorage.setItem(CHUB_KEY_STORE, key);
        else localStorage.removeItem(CHUB_KEY_STORE);
    } catch { /* storage unavailable */ }
}

/** Chub's login key is a UUID (localStorage "URQL_TOKEN" on chub.ai); the token button copies it as "chub:<key>". */
const extractChubKey = (text) => str(text).match(/chub:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)?.[1] || '';

async function chubAuthed(url) {
    const { key } = chubAccount();
    let response;
    try {
        response = await fetch(url, { credentials: 'omit', headers: key ? { 'CH-API-KEY': key } : {} });
    } catch {
        throw new ApiError('network', 'Could not reach Chub from this browser.');
    }
    if (!response.ok) throw new ApiError('http', `Chub answered with an error (${response.status}).`);
    return response.json();
}

/** Checks a Chub key; Chub answers an unknown key with a guest account (negative id). */
async function verifyChubKey(key) {
    const response = await fetch(`${CHUB_API}/api/account`, { credentials: 'omit', headers: { 'CH-API-KEY': key } });
    const account = response.ok ? await response.json() : null;
    return account && Number(account.id) > 0 ? account : null;
}

// ---------------------------------------------------------------------------------------------- Saucepan

const SAUCE = 'https://saucepan.ai';
const SAUCE_PAGE_SIZE = 24;
const SAUCE_KEY_STORE = 'botBazaar.sauceToken';

/**
 * Saucepan's API only answers its own website inside a browser, so requests go through SillyTavern's built-in CORS
 * proxy (config.yaml: enableCorsProxy: true). That proxy forwards only the path, so the query is encoded into it.
 */
function sauceUrl(path) {
    const i = path.indexOf('?');
    return i < 0 ? `/proxy/${SAUCE}${path}` : `/proxy/${SAUCE}${path.slice(0, i)}${encodeURIComponent(path.slice(i))}`;
}

const sauceImage = (id, variant = 'thumbnail') => (id ? `${SAUCE}/cdn/${encodeURIComponent(id)}/${variant}` : '');
const saucePage = (id, kind = 'character') => `${SAUCE}/${kind === 'lorebook' ? 'lorebook' : 'companion'}/${encodeURIComponent(id)}`;
// Saucepan writes dates as "2025-08-25 21:47:00.046113 +00:00:00".
const sauceDate = (text) => {
    const m = str(text).match(/^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d)(\.\d+)?/);
    return m ? `${m[1]}T${m[2]}${m[3] ? m[3].slice(0, 4) : ''}Z` : str(text);
};
const prettyTag = (tag) => str(tag).replace(/_/g, ' ').replace(/\bpov\b/gi, 'POV').trim();

function sauceAccount() {
    let token = settings().sauceToken || '';
    try { token = localStorage.getItem(SAUCE_KEY_STORE) || token; } catch { /* storage unavailable */ }
    return { token, user: settings().sauceUser || '', userId: settings().sauceUserId || '', verified: settings().sauceVerified !== false };
}

function storeSauceToken(token, user = {}) {
    settings().sauceToken = token;
    settings().sauceUser = user.handle || '';
    settings().sauceUserId = user.id || '';
    settings().sauceVerified = user.is_verified !== false;
    ctx().saveSettingsDebounced();
    try {
        if (token) localStorage.setItem(SAUCE_KEY_STORE, token);
        else localStorage.removeItem(SAUCE_KEY_STORE);
    } catch { /* storage unavailable */ }
}

/** null = not checked yet, true = SillyTavern's proxy works, false = it is switched off. */
let sauceProxyOk = null;

/**
 * One Saucepan API call. GET without a body, POST with one.
 * @param {string} path e.g. "/api/v1/search"
 * @param {object|null} [body]
 * @param {{token?: string}} [options] use this login instead of the saved one
 */
async function sauceFetch(path, body = null, { token = sauceAccount().token } = {}) {
    const headers = {
        // SillyTavern checks this on its own side; its proxy removes it before forwarding.
        'X-CSRF-Token': ctx().getRequestHeaders()['X-CSRF-Token'],
        Accept: 'application/json',
        'cf-edge-token-8af3': 'e3b0c44298fc1c14',
    };
    if (body) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    let response;
    try {
        response = await fetch(sauceUrl(path), { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
    } catch {
        throw new ApiError('network', 'Could not reach SillyTavern.');
    }
    const text = await response.text();
    if (/CORS proxy is disabled/i.test(text)) {
        sauceProxyOk = false;
        throw new ApiError('proxy', 'SillyTavern\'s proxy is switched off.');
    }
    if (!/^\s*[{[]/.test(text)) {
        if (response.status === 403 && /csrf/i.test(text)) {
            sauceProxyOk = false;
            throw new ApiError('proxy', 'SillyTavern\'s proxy is switched off.');
        }
        throw new ApiError('http', `Saucepan sent an unexpected answer (${response.status}). ${text.slice(0, 120)}`);
    }
    sauceProxyOk = true;
    const data = JSON.parse(text);
    if (!response.ok) {
        const code = str(data?.error?.code);
        const error = new ApiError(response.status === 401 ? 'auth' : 'http', str(data?.error?.message) || `Saucepan answered with an error (${response.status}).`);
        error.status = response.status;
        error.sauceCode = code;
        throw error;
    }
    return data;
}

/** Checks a Saucepan login; returns the account (handle, id, is_verified) or null. */
async function verifySauceToken(token) {
    const me = await sauceFetch('/api/v1/users/me', null, { token });
    const user = me?.user || me;
    return user?.id ? user : null;
}

/** Turns a Saucepan search result (companion) into the shared card model. */
function sauceModel(c) {
    return {
        source: 'saucepan',
        id: c.id,
        kind: 'character',
        name: str(c.display_name) || str(c.name),
        image: sauceImage(c.image?.id),
        creatorId: c.author_id,
        creatorName: c.author_handle,
        blurb: str(c.short_description),
        tags: Array.isArray(c.tags) ? c.tags : [],
        chats: c.chat_count,
        messages: c.interaction_count,
        favs: c.favorite_count,
        books: Number(c.lorebook_count) || 0,
        scenarios: Number(c.scenario_count) || 0,
        portraits: Number(c.portrait_count) || 0,
        tokens: c.card_token_count,
        nsfw: !!c.sus,
        updated: sauceDate(c.updated_at || c.posted_at),
        raw: c,
    };
}

function sauceBookModel(b) {
    return {
        source: 'saucepan',
        id: b.id,
        kind: 'lorebook',
        name: str(b.name),
        image: sauceImage(b.image_id),
        creatorId: b.owner_id,
        creatorName: b.owner_handle,
        blurb: str(b.short_description),
        tags: Array.isArray(b.tags) ? b.tags : [],
        favs: b.favorite_count,
        chapters: b.chapter_count,
        words: b.total_word_count,
        uses: b.public_companions,
        nsfw: !!b.nsfw,
        protection: str(b.definition_protection),
        updated: sauceDate(b.updated_at || b.posted_at),
        raw: b,
    };
}

// What the list showed, so a page can draw at once and favorites can open lorebooks.
const sauceSeen = new Map();

const SAUCE_LORE_SORT = { trending: 'favorite_count', popularity: 'companion_count', created: 'posted_at', updated: 'updated', random: 'random' };

async function sauceList() {
    if (state.search && !sauceAccount().token) {
        throw new ApiError('auth', 'Searching Saucepan by text needs your Saucepan login. Tags and creators work without one.');
    }
    const offset = (state.page - 1) * SAUCE_PAGE_SIZE;
    const body = { asc: false, offset, limit: SAUCE_PAGE_SIZE, sus: state.mode !== 'sfw' };
    if (state.search) body.text_search = state.search;
    if (state.topic) body.cnf_tags = [[state.topic]];

    if (state.kind === 'lorebooks') {
        body.order_by = SAUCE_LORE_SORT[state.sort] || 'favorite_count';
        const result = await sauceFetch('/api/v1/search/lorebooks', body);
        const items = (Array.isArray(result?.lorebooks) ? result.lorebooks : []).map(sauceBookModel);
        items.forEach(m => sauceSeen.set(m.id, m));
        return { items, total: Number(result?.total_count) || items.length, size: SAUCE_PAGE_SIZE };
    }

    body.order_by = state.sort;
    if (state.sauceBooks) body.min_lorebook_count = 1;
    if (state.creator) {
        if (!state.creator.id && state.creator.name) {
            const found = await sauceFetch(`/api/v1/user?handle=${encodeURIComponent(state.creator.name)}`);
            state.creator.id = found?.user?.id || '';
        }
        body.special_view = { view: 'user_profile', user_id: state.creator.id };
    }
    const result = await sauceFetch('/api/v1/search', body);
    const items = (Array.isArray(result?.companions) ? result.companions : []).map(sauceModel);
    items.forEach(m => sauceSeen.set(m.id, m));
    return { items, total: Number(result?.total_count) || items.length, size: SAUCE_PAGE_SIZE };
}

/** The definition object inside whatever wrapper Saucepan sends it in. */
function sauceDefinition(data) {
    const fields = ['card', 'example_dialogue', 'advanced_prompt', 'formatting_instructions', 'starting_scenarios'];
    const walk = (node, depth = 0) => {
        if (!node || typeof node !== 'object' || depth > 4) return null;
        if (!Array.isArray(node) && fields.some(f => f in node)) return node;
        for (const value of Object.values(node)) {
            const found = walk(value, depth + 1);
            if (found) return found;
        }
        return null;
    };
    return walk(data);
}

// Only plain text is used; anything Saucepan sends in another form is left out.
const sauceText = (value) => (typeof value === 'string' ? value : '');

function sauceGreetings(def) {
    return (Array.isArray(def?.starting_scenarios) ? def.starting_scenarios : [])
        .map(s => (typeof s === 'string' ? s : sauceText(s?.message)))
        .filter(t => t.trim());
}

const sauceHasDefinition = (def) => !!(sauceText(def?.card).trim() || sauceText(def?.example_dialogue).trim());

/**
 * Fetches the definition with the user's own login. Saucepan only sends it when the creator made it open (or the
 * account may otherwise see it); a hidden definition stays hidden.
 * @returns {Promise<{status: 'ok'|'hidden'|'login'|'unverified'|'failed', def?: object, message?: string}>}
 */
async function fetchSauceDefinition(id) {
    if (!sauceAccount().token) return { status: 'login' };
    try {
        const def = sauceDefinition(await sauceFetch(`/api/v1/companion/definition?companion_id=${encodeURIComponent(id)}`));
        return def ? { status: 'ok', def } : { status: 'hidden' };
    } catch (error) {
        if (error.code === 'proxy') throw error;
        if (error.code === 'auth') return { status: 'login', message: error.message };
        if (/verif/i.test(error.message) || (!sauceAccount().verified && error.status === 403)) return { status: 'unverified', message: error.message };
        if (error.status === 403 || error.status === 404) return { status: 'hidden', message: error.message };
        return { status: 'failed', message: error.message };
    }
}

/** Lorebooks attached to a character (needs the login). */
async function sauceAttachedBooks(id) {
    const result = await sauceFetch(`/api/v2/companions/${encodeURIComponent(id)}/lorebooks`);
    return Array.isArray(result?.lorebooks) ? result.lorebooks : [];
}

/** Finds lorebook entries ("chapters" on Saucepan) in a lorebook answer and normalises them for convertEntry(). */
function sauceEntries(data) {
    const generic = findEntries(data);
    if (generic?.length) return generic;
    const TEXT = ['content', 'text', 'body', 'entry', 'description', 'prompt'];
    let best = null;
    const walk = (node, depth = 0) => {
        if (!node || typeof node !== 'object' || depth > 5) return;
        if (Array.isArray(node)) {
            const objects = node.filter(v => v && typeof v === 'object' && !Array.isArray(v));
            if (objects.length && objects.some(o => TEXT.some(f => typeof o[f] === 'string' && o[f].trim())) && (!best || objects.length > best.length)) best = objects;
            node.forEach(v => walk(v, depth + 1));
            return;
        }
        Object.values(node).forEach(v => walk(v, depth + 1));
    };
    walk(data);
    if (!best) return [];
    return best.map((o) => {
        const keyField = Object.keys(o).find(k => /key|trigger|word|activation/i.test(k) && (Array.isArray(o[k]) || typeof o[k] === 'string'));
        return {
            ...o,
            content: str(TEXT.map(f => o[f]).find(v => typeof v === 'string' && v.trim())),
            keys: keyField ? toList(o[keyField]) : [],
            comment: str(o.name || o.title || o.label),
        };
    }).filter(e => e.content.trim());
}

const sauceBookCache = new Map();

/**
 * Downloads one Saucepan lorebook with the user's login.
 * @returns {Promise<{status: 'ok'|'private'|'failed', entries?: object[], name?: string}>}
 */
async function fetchSauceLorebook(id) {
    if (sauceBookCache.has(id)) return sauceBookCache.get(id);
    let result;
    try {
        const data = await sauceFetch(`/api/v1/lorebooks/${encodeURIComponent(id)}`);
        const entries = sauceEntries(data);
        result = entries.length ? { status: 'ok', entries, name: str(data?.lorebook?.name || data?.name) } : { status: 'private' };
    } catch (error) {
        if (error.code === 'proxy') throw error;
        console.warn(TAG, 'Saucepan lorebook failed', id, error);
        const refused = error.status === 403 || error.status === 404;
        // Unverified accounts are refused everything, so don't blame the creator for that.
        result = { status: refused ? (sauceAccount().verified ? 'private' : 'unverified') : 'failed', message: error.message };
    }
    sauceBookCache.set(id, result);
    return result;
}

/** Every readable lorebook attached to a Saucepan character, merged into one V2 character_book. */
async function sauceBook(id, bookName, attached = null) {
    const warnings = [];
    const entries = [];
    if (!sauceAccount().token) return { book: null, warnings };
    let books = attached;
    try {
        books ??= await sauceAttachedBooks(id);
    } catch (error) {
        if (error.code === 'proxy') throw error;
        warnings.push(`The lorebooks could not be listed: ${error.message}`);
        return { book: null, warnings };
    }
    const closed = [];
    const failed = [];
    for (const b of books) {
        const result = await fetchSauceLorebook(b.id);
        if (result.status === 'ok') result.entries.forEach(entry => entries.push(convertEntry(entry, entries.length)));
        else if (result.status === 'unverified') failed.push(str(b.name) || 'lorebook');
        else (result.status === 'private' ? closed : failed).push(str(b.name) || 'lorebook');
    }
    if (closed.length) warnings.push(`Saucepan did not send the contents of ${nameList(closed)} (kept private by the creator, or your account can't read it yet), so ${closed.length > 1 ? 'they were' : 'it was'} skipped.`);
    if (failed.length) warnings.push(sauceAccount().verified ? `Could not download ${nameList(failed)} from Saucepan right now.` : `Saucepan only sends lorebooks to accounts with a verified email, so ${nameList(failed)} could not be imported. Verify your email on saucepan.ai.`);
    if (!entries.length) return { book: null, warnings };
    return { book: { name: bookName, description: `Imported from Saucepan (${id})`, extensions: {}, entries }, warnings };
}

function buildSauceCard(c, def, book) {
    const greetings = sauceGreetings(def);
    const system = [sauceText(def?.advanced_prompt), sauceText(def?.formatting_instructions)].filter(t => t.trim()).join('\n\n');
    const defined = sauceHasDefinition(def);
    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: safeName(c.display_name || c.name) || 'Saucepan character',
            // Without the definition, the public blurb is the best there is.
            description: defined ? sauceText(def.card) : str(c.short_description),
            personality: '',
            scenario: '',
            first_mes: greetings[0] || '',
            mes_example: sauceText(def?.example_dialogue),
            creator_notes: sauceText(def?.full_description) || str(c.short_description),
            system_prompt: system,
            post_history_instructions: '',
            alternate_greetings: greetings.slice(1),
            tags: (Array.isArray(c.tags) ? c.tags : []).map(prettyTag).filter(Boolean),
            creator: str(c.author_handle),
            character_version: '',
            extensions: {
                talkativeness: '0.5',
                fav: false,
                world: book ? book.name : '',
                depth_prompt: { prompt: '', depth: 4, role: 'system' },
                saucepan: { id: c.id, author_id: c.author_id, source: saucePage(c.id), definition: defined },
            },
            ...(book ? { character_book: book } : {}),
        },
    };
}

/** @param {object} c companion  @param {object|null} defResult result of fetchSauceDefinition() */
async function importSauceCharacter(c, defResult = null) {
    const { Popup } = ctx();
    const name = safeName(c.display_name || c.name) || 'Saucepan character';
    defResult ??= await fetchSauceDefinition(c.id);
    const def = defResult.status === 'ok' ? defResult.def : null;
    if (!sauceHasDefinition(def)) {
        const why = {
            login: 'Your Saucepan account is not connected, so the definition and lorebooks are not available.',
            unverified: 'Saucepan only sends definitions to accounts with a verified email. Verify your email on saucepan.ai, then try again.',
            hidden: 'The creator keeps this definition hidden, so Saucepan does not send it.',
            failed: `Saucepan did not send the definition (${defResult.message || 'unknown error'}).`,
            ok: 'Saucepan sent an empty definition.',
        }[defResult.status];
        const proceed = await Popup.show.confirm('Definition not available', `${why} Import only the public info (name, picture, short description, tags)?`);
        if (!proceed) return false;
    }
    const { book, warnings } = await sauceBook(c.id, `${name} (Saucepan Lorebook)`);
    await finishImport(buildSauceCard(c, def, book), book, sauceImage(c.image?.id, 'public'), name, warnings);
    return true;
}

async function fetchSauceFavorites() {
    const items = [];
    for (let page = 0; page < 40; page++) {
        const result = await sauceFetch('/api/v1/search', { special_view: { view: 'favorites' }, order_by: 'favorited_at', asc: false, offset: page * SAUCE_PAGE_SIZE, limit: SAUCE_PAGE_SIZE, sus: true });
        const list = Array.isArray(result?.companions) ? result.companions : [];
        items.push(...list.map((c) => {
            const m = sauceModel(c);
            return { source: 'saucepan', id: m.id, name: m.name, image: m.image, creator: m.creatorName, creatorId: m.creatorId, kind: 'character' };
        }));
        if (list.length < SAUCE_PAGE_SIZE) break;
    }
    try {
        for (let page = 0; page < 20; page++) {
            const result = await sauceFetch('/api/v1/search/favorited-lorebooks', { order_by: 'favorited_at', asc: false, offset: page * SAUCE_PAGE_SIZE, limit: SAUCE_PAGE_SIZE, sus: true });
            const list = Array.isArray(result?.lorebooks) ? result.lorebooks : [];
            items.push(...list.map((b) => {
                const m = sauceBookModel(b);
                sauceSeen.set(m.id, m);
                return { source: 'saucepan', id: m.id, name: m.name, image: m.image, creator: m.creatorName, creatorId: m.creatorId, kind: 'lorebook' };
            }));
            if (list.length < SAUCE_PAGE_SIZE) break;
        }
    } catch (error) {
        console.warn(TAG, 'Saucepan lorebook favorites skipped', error);
    }
    return items;
}

const sauceComment = (c) => ({
    source: 'saucepan',
    id: c.id,
    user: c.user_handle || 'user',
    userId: c.user_id,
    avatar: sauceImage(c.user_avatar?.id),
    verified: false,
    pinned: !!c.pinned_at,
    date: sauceDate(c.created_at),
    text: str(c.content),
    likes: c.favorite_count,
    replyCount: Array.isArray(c.replies) ? c.replies.length : 0,
    replies: Array.isArray(c.replies) ? c.replies : [],
});

// ---------------------------------------------------------------------------------------------- favorites

// Kept as a small file in SillyTavern's user files: shared by every device using this SillyTavern, and not
// overwritten when several tabs save their settings.
const FAVORITES_FILE = 'bot-bazaar-favorites.json';
let favorites = null;
let favoritesSave = null;

const favKey = (source, id) => `${source}:${id}`;
const isFavorite = (source, id) => !!favorites?.some(f => f.key === favKey(source, id));

async function loadFavorites() {
    if (favorites) return favorites;
    try {
        const response = await fetch(`/user/files/${FAVORITES_FILE}?t=${Date.now()}`, { cache: 'no-store' });
        const data = response.ok ? await response.json() : [];
        favorites = Array.isArray(data) ? data.filter(f => f?.key && f.source && f.id) : [];
    } catch {
        favorites = [];
    }
    return favorites;
}

function saveFavorites() {
    clearTimeout(favoritesSave);
    favoritesSave = setTimeout(async () => {
        try {
            await fetch('/api/files/upload', {
                method: 'POST',
                headers: ctx().getRequestHeaders(),
                body: JSON.stringify({ name: FAVORITES_FILE, data: base64Utf8(JSON.stringify(favorites)) }),
            });
        } catch (error) {
            console.warn(TAG, 'Could not save favorites', error);
            toastr.error('Favorites could not be saved.', 'Bot Bazaar');
        }
    }, 400);
}

/** @param {{source: string, id: string, name: string, image?: string, creator?: string, creatorId?: string, kind?: string}} item */
async function toggleFavorite(item) {
    await loadFavorites();
    const key = favKey(item.source, item.id);
    const index = favorites.findIndex(f => f.key === key);
    if (index >= 0) favorites.splice(index, 1);
    else favorites.unshift({ key, source: item.source, id: item.id, name: item.name, image: item.image || '', creator: item.creator || '', creatorId: item.creatorId || '', kind: item.kind || 'character', addedAt: new Date().toISOString() });
    saveFavorites();
    return index < 0;
}

/**
 * Makes the local list follow what a site lists as your favorites: new ones are added, and ones that came from
 * that site but were un-favorited there are removed. Stars you set in Bot Bazaar yourself are never removed.
 * Returns how many were added and removed.
 */
function mergeFavorites(site, items) {
    const keys = new Set(items.map(item => favKey(item.source, item.id)));
    const before = favorites.length;
    favorites = favorites.filter(f => f.fromSite !== site || keys.has(f.key));
    const removed = before - favorites.length;
    let added = 0;
    let linked = 0;
    for (const item of items) {
        const key = favKey(item.source, item.id);
        const existing = favorites.find(f => f.key === key);
        if (existing) {
            // Already here (starred in Bot Bazaar or from an older sync): from now on it follows the site.
            if (!existing.fromSite) {
                existing.fromSite = site;
                linked++;
            }
            continue;
        }
        favorites.unshift({ key, ...item, fromSite: site, addedAt: new Date().toISOString() });
        added++;
    }
    if (added || removed || linked) saveFavorites();
    return { added, removed };
}

async function fetchJanitorFavorites() {
    const items = [];
    for (let page = 1; page <= 30; page++) {
        const result = await api(`/hampter/characters?page=${page}&mode=all&sort=latest&favorites=true`);
        const data = Array.isArray(result?.data) ? result.data : [];
        items.push(...data.map(c => ({ source: 'janitor', id: c.id, name: c.name, image: avatarUrl(c.avatar, 400), creator: c.creator_name, creatorId: c.creator_id, kind: 'character' })));
        if (data.length < (Number(result?.size) || 20) || !data.length) break;
    }
    return items;
}

async function fetchChubFavorites() {
    const items = [];
    for (const namespace of ['characters', 'lorebooks']) {
        for (let page = 1; page <= 30; page++) {
            const result = await chubAuthed(`${CHUB_API}/search?first=48&page=${page}&namespace=${namespace}&my_favorites=true&nsfw=true&nsfl=true&include_forks=true&sort=created_at`);
            const nodes = Array.isArray(result?.data?.nodes) ? result.data.nodes : [];
            items.push(...nodes.map((node) => {
                const model = chubModel(node);
                return { source: 'chub', id: model.id, name: model.name, image: model.image, creator: model.creatorName, creatorId: model.creatorId, kind: model.kind };
            }));
            if (nodes.length < 48) break;
        }
    }
    return items;
}

// ---- automatic sync: whenever the Favorites tab is open, and every few minutes while it stays open

const SYNC_SITES = ['janitor', 'chub', 'saucepan'];
const syncState = Object.fromEntries(SYNC_SITES.map(site => [site, { at: 0, busy: false, error: '' }]));
let syncTimer = null;

const siteConnected = (site) => ({ janitor: () => signedIn(), chub: () => !!chubAccount().key, saucepan: () => !!sauceAccount().token && sauceProxyOk !== false }[site]?.() ?? false);

async function syncSite(site, force = false) {
    const s = syncState[site];
    if (s.busy || !siteConnected(site) || (!force && Date.now() - s.at < 60000)) return null;
    s.busy = true;
    s.error = '';
    renderSyncBar();
    try {
        await loadFavorites();
        const items = await { janitor: fetchJanitorFavorites, chub: fetchChubFavorites, saucepan: fetchSauceFavorites }[site]();
        const result = mergeFavorites(site, items);
        s.at = Date.now();
        return result;
    } catch (error) {
        console.warn(TAG, 'Favorites sync failed', site, error);
        s.error = error.code === 'auth' ? 'login needed' : (error.code === 'proxy' ? 'proxy off' : 'could not sync');
        return null;
    } finally {
        s.busy = false;
        updateStatus();
        if (state.source === 'favorites' && !state.detail) renderFavorites();
    }
}

async function autoSync(force = false) {
    const results = await Promise.all(SYNC_SITES.map(site => syncSite(site, force)));
    const added = results.reduce((n, r) => n + (r?.added || 0), 0);
    if (added) toastr.info(`${added} new favorite${added > 1 ? 's' : ''} from your accounts.`, 'Bot Bazaar', { timeOut: 2500 });
}

function startAutoSync() {
    clearInterval(syncTimer);
    autoSync();
    syncTimer = setInterval(() => {
        if (state.source === 'favorites' && root?.classList.contains('jai_open')) autoSync();
        else clearInterval(syncTimer);
    }, 3 * 60 * 1000);
}

function syncPill(site) {
    const s = syncState[site];
    let text;
    let cls = '';
    if (!siteConnected(site)) {
        text = '<span class="jai_link" data-jai-connect-site>connect to sync</span>';
        cls = 'jai_pill_off';
    } else if (s.busy) {
        text = '<i class="fa-solid fa-rotate fa-spin"></i> syncing…';
    } else if (s.error) {
        text = s.error;
        cls = 'jai_pill_bad';
    } else {
        text = s.at ? `<i class="fa-solid fa-check"></i> synced ${esc(timeAgo(new Date(s.at).toISOString()))}` : 'waiting';
        cls = 'jai_pill_ok';
    }
    return `<span class="jai_pill ${cls}"><b>${SOURCE_LABEL[site]}</b> ${text}</span>`;
}

function renderSyncBar() {
    const bar = root?.querySelector('.jai_syncbar');
    if (bar) bar.innerHTML = `${SYNC_SITES.map(syncPill).join('')}<span class="jai_btn jai_small" data-sync-now title="Check every site now"><i class="fa-solid fa-rotate"></i><span>Sync now</span></span>`;
}

const favButton = (item) => {
    const on = isFavorite(item.source, item.id);
    return `<span class="jai_fav ${on ? 'jai_fav_on' : ''}" data-fav="${esc(JSON.stringify({ source: item.source, id: item.id, name: item.name, image: item.image, creator: item.creator, creatorId: item.creatorId, kind: item.kind }))}" title="${on ? 'Remove from favorites' : 'Add to favorites'}"><i class="fa-${on ? 'solid' : 'regular'} fa-star"></i></span>`;
};

function refreshFavButtons() {
    root.querySelectorAll('[data-fav]').forEach((el) => {
        let item;
        try { item = JSON.parse(el.dataset.fav); } catch { return; }
        const on = isFavorite(item.source, item.id);
        el.classList.toggle('jai_fav_on', on);
        el.title = on ? 'Remove from favorites' : 'Add to favorites';
        const icon = el.querySelector('i');
        if (icon) icon.className = `fa-${on ? 'solid' : 'regular'} fa-star`;
        const label = el.querySelector('span');
        if (label) label.textContent = on ? 'Favorited' : 'Favorite';
    });
}

// ---------------------------------------------------------------------------------------------- local views


const SOURCE_LABEL = { janitor: 'JanitorAI', chub: 'Chub', saucepan: 'Saucepan' };

const matchesLocal = (item) => (state.localSource === 'all' || item.source === state.localSource)
    && (!state.search || `${item.name} ${item.creator}`.toLowerCase().includes(state.search.toLowerCase()));

function siteFilter() {
    const counts = { all: 0, janitor: 0, chub: 0, saucepan: 0 };
    return (list) => {
        list.forEach((item) => { counts.all++; counts[item.source] = (counts[item.source] || 0) + 1; });
        return ['all', ...SYNC_SITES].map(s => `<span class="jai_seg ${state.localSource === s ? 'jai_active' : ''}" data-lsource="${s}">${s === 'all' ? 'All' : SOURCE_LABEL[s]} <i>${counts[s] || 0}</i></span>`).join('');
    };
}

/** Favorites: a wall of portrait posters, gold accents. */
async function renderFavorites() {
    await loadFavorites();
    const items = favorites.filter(matchesLocal);
    $('#jai_creator').innerHTML = `
        <div class="jai_favhead">
            <div class="jai_favtitle"><i class="fa-solid fa-star"></i> Favorites <span>${favorites.length}</span></div>
            <div class="jai_segs">${siteFilter()(favorites)}</div>
        </div>
        <div class="jai_syncbar"></div>`;
    $('#jai_creator').style.display = '';
    renderSyncBar();
    $('#jai_grid').innerHTML = items.map(f => `
        <div class="jai_poster" data-source="${esc(f.source)}" data-id="${esc(f.id)}" data-lopen title="${esc(f.name)}">
            ${f.image ? `<img loading="lazy" referrerpolicy="no-referrer" src="${esc(f.image)}" alt="">` : '<div class="jai_poster_blank"><i class="fa-solid fa-user"></i></div>'}
            <span class="jai_poster_site jai_site_${esc(f.source)}">${SOURCE_LABEL[f.source] || ''}${f.kind === 'lorebook' ? ' · Lorebook' : ''}</span>
            <span class="jai_poster_star" data-unfav="${esc(f.key)}" title="Remove from favorites"><i class="fa-solid fa-star"></i></span>
            <div class="jai_poster_info">
                <div class="jai_poster_name">${esc(f.name)}</div>
                ${f.creator ? `<span class="jai_creator_link" data-creator="${esc(f.creatorId || f.creator)}" data-name="${esc(f.creator)}" data-source="${esc(f.source)}">@${esc(f.creator)}</span>` : ''}
                <span class="jai_poster_when">${f.fromSite ? `from your ${SOURCE_LABEL[f.fromSite]} favorites` : `starred ${esc(timeAgo(f.addedAt))}`}</span>
            </div>
        </div>`).join('');
    showMessage(items.length ? '' : (favorites.length
        ? 'Nothing matches.'
        : 'No favorites yet. Tap the ☆ star on any character — or connect your JanitorAI, Chub or Saucepan account and the favorites you set on those sites appear here by themselves.'));
}

/** Characters this extension imported, read straight from SillyTavern's character list. */
function libraryItems() {
    const { characters, getThumbnailUrl } = ctx();
    return characters.map((c, index) => {
        const ext = c.data?.extensions || {};
        const source = ext.janitor ? 'janitor' : (ext.chub?.full_path ? 'chub' : (ext.saucepan?.id ? 'saucepan' : null));
        if (!source) return null;
        return {
            index,
            avatar: c.avatar,
            source,
            id: { janitor: ext.janitor?.id, chub: ext.chub?.full_path, saucepan: ext.saucepan?.id }[source],
            creatorId: source === 'saucepan' ? ext.saucepan.author_id || '' : '',
            name: c.name,
            image: getThumbnailUrl('avatar', c.avatar),
            creator: c.data?.creator || '',
            world: ext.world || '',
            date: Number(c.date_added) || Date.parse(c.create_date) || 0,
        };
    }).filter(Boolean);
}

/** Library: a tidy list, one row per imported character. */
function renderLibrary() {
    const all = libraryItems();
    const items = all.filter(matchesLocal)
        .sort((a, b) => (state.librarySort === 'name' ? a.name.localeCompare(b.name) : b.date - a.date));
    $('#jai_creator').innerHTML = `
        <div class="jai_libhead">
            <div class="jai_libtitle"><i class="fa-solid fa-swatchbook"></i> Library <span>${all.length} imported</span></div>
            <div class="jai_segs">${siteFilter()(all)}</div>
            <select class="jai_lsort" title="Order">
                <option value="new" ${state.librarySort === 'new' ? 'selected' : ''}>Newest first</option>
                <option value="name" ${state.librarySort === 'name' ? 'selected' : ''}>A–Z</option>
            </select>
        </div>`;
    $('#jai_creator').style.display = '';
    $('#jai_grid').innerHTML = items.length ? `<div class="jai_rows">${items.map(item => `
        <div class="jai_row" data-source="${esc(item.source)}" data-id="${esc(item.id)}">
            <img class="jai_row_avatar" loading="lazy" src="${esc(item.image)}" alt="">
            <div class="jai_row_main">
                <div class="jai_row_name">${esc(item.name)}</div>
                <div class="jai_row_meta">
                    <span class="jai_site jai_site_${esc(item.source)}">${SOURCE_LABEL[item.source]}</span>
                    ${item.creator ? `<span class="jai_creator_link" data-creator="${esc(item.source === 'chub' ? item.creator : item.creatorId)}" data-name="${esc(item.creator)}" data-source="${esc(item.source)}">@${esc(item.creator)}</span>` : ''}
                    ${item.date ? `<span title="${esc(fullDate(new Date(item.date).toISOString()))}"><i class="fa-regular fa-clock"></i> ${esc(timeAgo(new Date(item.date).toISOString()))}</span>` : ''}
                    ${item.world ? `<span class="jai_row_book" title="${esc(item.world)}"><i class="fa-solid fa-book-atlas"></i> lorebook</span>` : ''}
                </div>
            </div>
            <div class="jai_row_actions">
                <span class="jai_iconbtn jai_iconbtn_main" data-chat="${esc(item.avatar)}" title="Chat with this character"><i class="fa-solid fa-comments"></i></span>
                <span class="jai_iconbtn" data-lopen title="Show its page on ${SOURCE_LABEL[item.source]}"><i class="fa-solid fa-arrow-up-right-from-square"></i></span>
                <span class="jai_iconbtn jai_iconbtn_danger" data-delete="${esc(item.avatar)}" title="Delete from SillyTavern"><i class="fa-solid fa-trash-can"></i></span>
            </div>
        </div>`).join('')}</div>` : '';
    showMessage(items.length ? '' : (all.length ? 'Nothing matches.' : 'Nothing imported with Bot Bazaar yet.'));
}

async function deleteFromLibrary(avatar) {
    const { characters, Popup } = ctx();
    const character = characters.find(c => c.avatar === avatar);
    if (!character) return;
    const world = character.data?.extensions?.world || '';
    const ok = await Popup.show.confirm(`Delete "${character.name}"?`, 'The character and all of its chats will be removed from SillyTavern. This cannot be undone.');
    if (!ok) return;
    const removeWorld = world && ctx().getWorldInfoNames().includes(world)
        ? await Popup.show.confirm('Also delete its lorebook?', `"${world}" was imported together with this character.`)
        : false;
    const deleted = await deleteCharacter(avatar, { deleteChats: true });
    if (deleted === false) return;
    if (removeWorld) await deleteWorldInfo(world);
    toastr.success(`"${character.name}" deleted.`, 'Bot Bazaar');
    renderLibrary();
}

// ---------------------------------------------------------------------------------------------- UI

const SORTS = {
    janitor: [
        ['trending', 'fa-fire', 'Trending'],
        ['popular', 'fa-star', 'Popular'],
        ['latest', 'fa-clock', 'Latest'],
        ['relevance', 'fa-bullseye', 'Best match'],
    ],
    chub: [
        ['trending_downloads', 'fa-fire', 'Trending'],
        ['download_count', 'fa-download', 'Popular'],
        ['star_count', 'fa-star', 'Top rated'],
        ['created_at', 'fa-clock', 'Newest'],
        ['last_activity_at', 'fa-rotate', 'Updated'],
        ['default', 'fa-bullseye', 'Best match'],
    ],
    saucepan: [
        ['trending', 'fa-fire', 'Trending'],
        ['popularity', 'fa-star', 'Popular'],
        ['created', 'fa-clock', 'Newest'],
        ['updated', 'fa-rotate', 'Updated'],
        ['random', 'fa-shuffle', 'Surprise me'],
    ],
};
const DEFAULT_SORT = { janitor: 'popular', chub: 'trending_downloads', saucepan: 'trending' };
const CREATOR_SORT = { janitor: 'latest', chub: 'created_at', saucepan: 'created' };
const SEARCH_SORT = { janitor: 'relevance', chub: 'default' };
const SOURCE_KEY = 'botBazaar.source';
const isLocalView = () => state.source === 'favorites' || state.source === 'library';

const state = {
    source: 'janitor', kind: 'characters',
    page: 1, sort: 'popular', mode: 'all', search: '', tag: '', customTag: '', topic: '', creator: null,
    total: 0, size: 0, loading: false, tagsLoaded: false, detail: null, detailSource: null,
    localSource: 'all', librarySort: 'new', sauceBooks: false,
};
try {
    const saved = localStorage.getItem(SOURCE_KEY);
    if (['chub', 'saucepan', 'favorites', 'library'].includes(saved)) {
        state.source = saved;
        state.sort = DEFAULT_SORT[saved] || state.sort;
    }
} catch { /* storage unavailable */ }
let root = null;

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
const compact = (n) => (Number.isFinite(Number(n)) && n !== null && n !== '' ? Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(n)).toLowerCase() : '?');
const $ = (selector) => root.querySelector(selector);
const avatarUrl = (file, width) => (file ? `${AVATARS}${encodeURIComponent(file)}?width=${width}` : '');

function timeAgo(iso) {
    const time = Date.parse(iso);
    if (!time) return '';
    const seconds = (Date.now() - time) / 1000;
    for (const [size, unit] of [[31536000, 'y'], [2592000, 'mo'], [86400, 'd'], [3600, 'h'], [60, 'min']]) {
        if (seconds >= size) return `${Math.floor(seconds / size)}${unit} ago`;
    }
    return 'just now';
}

function fullDate(iso) {
    const time = Date.parse(iso);
    return time ? new Date(time).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
}

// Creators style their descriptions (colours, fonts, layouts, even whole <style> blocks or full web pages).
// Keep that styling, but only properties that cannot escape the description box (which clips and isolates it).
const SAFE_CSS_PROPERTY = /^(--[\w-]+|color|background(-[\w-]+)?|text-[\w-]+|font(-[\w-]+)?|line-height|letter-spacing|word-spacing|word-break|overflow-wrap|white-space|hyphens|tab-size|direction|writing-mode|unicode-bidi|margin(-[\w-]+)?|padding(-[\w-]+)?|border(-[\w-]+)?|outline(-[\w-]+)?|box-shadow|box-sizing|(max-|min-)?(width|height|inline-size|block-size)|display|visibility|opacity|vertical-align|list-style(-[\w-]+)?|gap|row-gap|column-gap|justify-[\w-]+|align-[\w-]+|place-[\w-]+|flex(-[\w-]+)?|order|grid(-[\w-]+)?|overflow(-[\w-]+)?|float|clear|filter|backdrop-filter|mix-blend-mode|isolation|animation(-[\w-]+)?|transition(-[\w-]+)?|transform(-[\w-]+)?|translate|rotate|scale|perspective(-origin)?|cursor|pointer-events|user-select|object-fit|object-position|aspect-ratio|columns?(-[\w-]+)?|caret-color|accent-color|position|top|right|bottom|left|inset(-[\w-]+)?|z-index|content|quotes|counter-[\w-]+|table-layout|caption-side|empty-cells|clip-path|mask(-[\w-]+)?|-webkit-[\w-]+|scrollbar-[\w-]+|will-change|contain)$/i;
// Only https images may load; the look-ahead covers url(x), url('x') and url("x") alike.
const UNSAFE_CSS_VALUE = /expression\s*\(|javascript:|url\(\s*(?!['"]?https:)|-moz-binding|behavior\s*:/i;
const FONT_HOSTS = /^https:\/\/(fonts\.googleapis\.com|fonts\.bunny\.net|api\.fontshare\.com)\//i;

/** Splits "a: b; c: url(x;y)" into declarations, respecting quotes and parentheses. */
function splitDeclarations(text) {
    const out = [];
    let current = '';
    let depth = 0;
    let quote = null;
    for (const ch of str(text)) {
        if (quote) {
            if (ch === quote) quote = null;
        } else if (ch === '"' || ch === '\'') {
            quote = ch;
        } else if (ch === '(') {
            depth++;
        } else if (ch === ')') {
            depth = Math.max(0, depth - 1);
        } else if (ch === ';' && depth === 0) {
            out.push(current);
            current = '';
            continue;
        }
        current += ch;
    }
    if (current.trim()) out.push(current);
    return out;
}

/**
 * Keeps the safe declarations of a style text exactly as the creator wrote them (so shorthands built from CSS
 * variables survive). "position: fixed" becomes "absolute" so nothing can pin itself over SillyTavern.
 */
function filterCss(text) {
    return splitDeclarations(text).map((declaration) => {
        const i = declaration.indexOf(':');
        if (i < 0) return null;
        const prop = declaration.slice(0, i).trim().toLowerCase();
        let value = declaration.slice(i + 1).trim();
        if (!SAFE_CSS_PROPERTY.test(prop) || !value || UNSAFE_CSS_VALUE.test(value)) return null;
        if (prop === 'position' && /fixed/i.test(value)) value = 'absolute';
        return `${prop}:${value}`;
    }).filter(Boolean).join(';');
}

const prefixClasses = (selector) => selector.replace(/\.(-?[_a-zA-Z][\w-]*)/g, '.u-$1');

/** Rewrites a creator's <style> block so every rule only applies inside their description. */
function scopeCss(css, scope) {
    const sheet = new CSSStyleSheet();
    try {
        sheet.replaceSync(css);
    } catch {
        return '';
    }
    const out = [];
    const walk = (rules) => {
        for (const rule of rules) {
            if (rule instanceof CSSStyleRule) {
                const declarations = filterCss(rule.style.cssText);
                if (!declarations) continue;
                const selector = rule.selectorText.split(',')
                    .map(s => prefixClasses(s.trim().replace(/^((html|body|:root)\b\s*)+/i, '')))
                    // "body" becomes the description box itself; "body::before" / "body:hover" stay attached to it.
                    .map(s => (!s ? scope : (s.startsWith(':') ? `${scope}${s}` : `${scope} ${s}`)))
                    .join(', ');
                out.push(`${selector}{${declarations}}`);
            } else if (rule instanceof CSSMediaRule) {
                out.push(`@media ${rule.conditionText}{`);
                walk(rule.cssRules);
                out.push('}');
            } else if (rule instanceof CSSSupportsRule) {
                out.push(`@supports ${rule.conditionText}{`);
                walk(rule.cssRules);
                out.push('}');
            } else if (rule instanceof CSSKeyframesRule && !UNSAFE_CSS_VALUE.test(rule.cssText)) {
                out.push(rule.cssText);
            } else if (rule instanceof CSSFontFaceRule && !UNSAFE_CSS_VALUE.test(rule.cssText)) {
                out.push(rule.cssText);
            }
        }
    };
    walk(sheet.cssRules);
    return out.join('\n');
}

/** Web fonts the creator imports (Google Fonts and similar font services only). */
function fontLinks(rawHtml, css) {
    const urls = new Set();
    for (const m of css.matchAll(/@import\s+(?:url\(\s*)?['"]?([^'")\s;]+)/gi)) urls.add(m[1]);
    for (const m of rawHtml.matchAll(/<link[^>]+href=["']([^"']+)["']/gi)) urls.add(m[1].replace(/&amp;/g, '&'));
    return [...urls].filter(u => FONT_HOSTS.test(u)).map(u => `<link rel="stylesheet" href="${esc(u)}" referrerpolicy="no-referrer">`).join('');
}

/** True when a Chub description is really an HTML page rather than markdown. */
const looksLikeHtml = (text) => /<(style|html|body|head|section|header|table)\b/i.test(text) || /^\s*<(div|p|center|span|h\d)\b/i.test(text);

let scopeCounter = 0;

/**
 * Cleans creator-written HTML for display, keeping the creator's styling.
 * @param {string} html Raw HTML
 * @param {boolean} [textOnly] Plain version for the small cards: no images, no styling blocks
 */
function richHtml(html, textOnly = false) {
    const raw = str(html);
    const css = textOnly ? '' : [...raw.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(m => m[1]).join('\n');
    const clean = SillyTavern.libs.DOMPurify.sanitize(raw, {
        FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe', 'textarea', 'select', 'video', 'object', 'embed', 'svg', 'math', 'link', 'meta', 'base', 'script'],
        FORBID_ATTR: ['id', 'srcset', 'autoplay'],
    });
    const template = document.createElement('template');
    template.innerHTML = clean;
    template.content.querySelectorAll('[style]').forEach((el) => {
        const kept = textOnly
            ? filterCss(el.getAttribute('style')).split(';').filter(d => /^(color|background-color|text-align|font-weight|font-style):/i.test(d)).join(';')
            : filterCss(el.getAttribute('style'));
        if (kept) el.setAttribute('style', kept);
        else el.removeAttribute('style');
    });
    // Creator class names only mean something to their own <style> block; prefix them so they can't hit SillyTavern's.
    template.content.querySelectorAll('[class]').forEach((el) => {
        if (textOnly) return el.removeAttribute('class');
        el.setAttribute('class', el.getAttribute('class').split(/\s+/).filter(Boolean).map(c => `u-${c}`).join(' '));
    });
    template.content.querySelectorAll('a').forEach((a) => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
    template.content.querySelectorAll('img').forEach((img) => {
        if (textOnly) return img.remove();
        img.referrerPolicy = 'no-referrer';
        img.loading = 'lazy';
    });
    template.content.querySelectorAll('audio').forEach((audio) => {
        if (textOnly) return audio.remove();
        audio.controls = true;
        audio.preload = 'none';
    });
    if (textOnly) {
        template.content.querySelectorAll('hr, table, picture, figure').forEach(el => el.remove());
        return template.innerHTML;
    }

    const scope = `jai_scope_${++scopeCounter}`;
    const scoped = scopeCss(css, `.${scope}`);
    return `<div class="jai_authored ${scope}">${fontLinks(raw, css)}${scoped ? `<style>${scoped.replace(/<\/style/gi, '')}</style>` : ''}${template.innerHTML}</div>`;
}

const verifiedBadge = (on) => (on ? ' <i class="fa-solid fa-circle-check jai_verified" title="Verified creator"></i>' : '');

function tagChips(item) {
    const chips = [];
    if (item.is_nsfw) chips.push('<span class="jai_chip jai_limitless" title="Not limited to safe-for-work">Limitless</span>');
    for (const tag of (Array.isArray(item.tags) ? item.tags : [])) {
        chips.push(`<span class="jai_chip" data-tag="${esc(tag.id)}" title="${esc(tag.description || 'Show characters with this tag')}">${esc(tag.name)}</span>`);
    }
    for (const tag of (Array.isArray(item.custom_tags) ? item.custom_tags : [])) {
        chips.push(`<span class="jai_chip jai_hash" data-ctag="${esc(tag)}" title="Show characters with this tag">#${esc(tag)}</span>`);
    }
    return chips.join('');
}

/** Turns a JanitorAI list item into the shared card model. */
function janitorModel(item) {
    return {
        source: 'janitor',
        id: item.id,
        kind: 'character',
        name: item.name,
        image: avatarUrl(item.avatar, 400),
        creatorId: item.creator_id,
        creatorName: item.creator_name,
        verified: !!item.creator_verified,
        blurb: richHtml(item.description, true),
        stats: `<i class="fa-regular fa-comments"></i> ${compact(item.stats?.message)}${item.public_chat_count ? ` <i class="fa-regular fa-file-lines"></i> ${compact(item.public_chat_count)}` : ''}`,
        statsTitle: `${compact(item.stats?.message)} messages · ${compact(item.stats?.chat)} chats`,
        chips: tagChips(item),
        tokens: item.total_tokens,
        updated: item.updated_at || item.first_published_at || item.created_at,
    };
}

const favAction = (item) => {
    const on = isFavorite(item.source, item.id);
    return `<div class="jai_btn jai_favbtn ${on ? 'jai_fav_on' : ''}" data-fav="${esc(JSON.stringify(item))}" title="${on ? 'Remove from favorites' : 'Add to favorites'}"><i class="fa-${on ? 'solid' : 'regular'} fa-star"></i><span>${on ? 'Favorited' : 'Favorite'}</span></div>`;
};

function buildUi() {
    root = document.createElement('div');
    root.id = 'jai_browser';
    root.innerHTML = `
        <div class="jai_window">
            <div class="jai_header">
                <b class="jai_title"><i class="fa-solid fa-store"></i> Bot Bazaar</b>
                <div class="jai_tabs jai_sources" id="jai_sources">
                    <div class="jai_tab" data-source="janitor" title="Browse JanitorAI"><span>JanitorAI</span></div>
                    <div class="jai_tab" data-source="chub" title="Browse Chub (chub.ai)"><span>Chub</span></div>
                    <div class="jai_tab" data-source="saucepan" title="Browse Saucepan (saucepan.ai)"><span>Saucepan</span></div>
                    <div class="jai_tab" data-source="favorites" title="Your favorites from both sites"><i class="fa-solid fa-star"></i><span>Favorites</span></div>
                    <div class="jai_tab" data-source="library" title="Characters you imported with Bot Bazaar"><i class="fa-solid fa-swatchbook"></i><span>Library</span></div>
                </div>
                <span id="jai_status" class="jai_status"></span>
                <div class="jai_btn" id="jai_account" title="Connect or change your JanitorAI account"><i class="fa-solid fa-key"></i><span>Account</span></div>
                <div class="jai_btn jai_icon" id="jai_close" title="Close"><i class="fa-solid fa-xmark"></i></div>
            </div>
            <div class="jai_nav">
                <div class="jai_navscroll">
                <div class="jai_tabs" id="jai_kinds">
                    <div class="jai_tab" data-kind="characters"><i class="fa-solid fa-user"></i><span>Characters</span></div>
                    <div class="jai_tab" data-kind="lorebooks"><i class="fa-solid fa-book-atlas"></i><span>Lorebooks</span></div>
                </div>
                <div class="jai_tabs" id="jai_sorts"></div>
                <div class="jai_tabs" id="jai_modes">
                    <div class="jai_tab" data-mode="all"><i class="fa-solid fa-eye"></i><span>All</span></div>
                    <div class="jai_tab" data-mode="sfw"><i class="fa-solid fa-eye-slash"></i><span>Limited only</span></div>
                    <div class="jai_tab" data-sauce-books title="Only characters with a lorebook"><i class="fa-solid fa-book-atlas"></i><span>With lorebook</span></div>
                </div>
                </div>
                <div class="jai_search">
                    <i class="fa-solid fa-magnifying-glass"></i>
                    <input id="jai_search" type="search" placeholder="Search… or paste a JanitorAI / Chub / Saucepan link">
                </div>
                <select id="jai_tag"><option value="">Any tag</option></select>
            </div>
            <div class="jai_body">
                <div id="jai_filters" class="jai_filters"></div>
                <div id="jai_message" class="jai_message"></div>
                <div id="jai_creator" class="jai_creator"></div>
                <div id="jai_grid" class="jai_grid"></div>
                <div id="jai_detail" class="jai_detail"></div>
            </div>
            <div class="jai_footer">
                <div class="jai_btn" id="jai_prev"><i class="fa-solid fa-chevron-left"></i><span>Prev</span></div>
                <span id="jai_page"></span>
                <div class="jai_btn" id="jai_next"><span>Next</span><i class="fa-solid fa-chevron-right"></i></div>
            </div>
        </div>`;
    document.body.appendChild(root);

    root.addEventListener('mousedown', (event) => event.target === root && closeBrowser());
    $('#jai_close').addEventListener('click', closeBrowser);
    $('#jai_account').addEventListener('click', () => showConnect());
    $('#jai_search').addEventListener('keydown', (event) => event.key === 'Enter' && submitSearch());
    $('#jai_tag').addEventListener('change', () => { state.tag = $('#jai_tag').value; state.page = 1; loadList(); });
    $('#jai_sources').addEventListener('click', (event) => {
        const source = event.target.closest('[data-source]')?.dataset.source;
        // Allowed even while a list is loading: loadList() ignores answers to older requests.
        if (source && source !== state.source) switchSource(source);
    });
    $('#jai_kinds').addEventListener('click', (event) => {
        const kind = event.target.closest('[data-kind]')?.dataset.kind;
        if (!kind || state.loading) return;
        state.kind = kind;
        state.page = 1;
        loadList();
    });
    $('#jai_sorts').addEventListener('click', (event) => {
        const sort = event.target.closest('[data-sort]')?.dataset.sort;
        if (!sort || state.loading) return;
        state.sort = sort;
        state.page = 1;
        loadList();
    });
    $('#jai_modes').addEventListener('click', (event) => {
        if (event.target.closest('[data-sauce-books]') && !state.loading) {
            state.sauceBooks = !state.sauceBooks;
            state.page = 1;
            return loadList();
        }
        const mode = event.target.closest('[data-mode]')?.dataset.mode;
        if (!mode || state.loading) return;
        state.mode = mode;
        state.page = 1;
        loadList();
    });
    $('#jai_prev').addEventListener('click', () => { if (state.page > 1 && !state.loading) { state.page--; loadList(); } });
    $('#jai_next').addEventListener('click', () => { if (hasNext() && !state.loading) { state.page++; loadList(); } });

    // Cards, creator names and tags are all clickable wherever they appear.
    root.querySelector('.jai_body').addEventListener('click', (event) => {
        if (event.target.closest('#jai_message')) return;
        const fav = event.target.closest('[data-fav]');
        if (fav) {
            event.stopPropagation();
            return toggleFavorite(JSON.parse(fav.dataset.fav)).then((on) => {
                refreshFavButtons();
                updateStatus();
                toastr.info(on ? 'Added to favorites.' : 'Removed from favorites.', 'Bot Bazaar', { timeOut: 1500 });
                if (state.source === 'favorites' && !state.detail) renderFavorites();
            });
        }
        const unfav = event.target.closest('[data-unfav]');
        if (unfav) {
            favorites = favorites.filter(f => f.key !== unfav.dataset.unfav);
            saveFavorites();
            updateStatus();
            return renderFavorites();
        }
        const localSource = event.target.closest('[data-lsource]');
        if (localSource) {
            state.localSource = localSource.dataset.lsource;
            return loadList();
        }
        if (event.target.closest('[data-sync-now]')) return autoSync(true);
        if (event.target.closest('[data-jai-connect-site]')) return showConnect();
        const chat = event.target.closest('[data-chat]');
        if (chat) {
            const index = ctx().characters.findIndex(c => c.avatar === chat.dataset.chat);
            if (index >= 0) {
                ctx().selectCharacterById(index);
                closeBrowser();
            }
            return;
        }
        const remove = event.target.closest('[data-delete]');
        if (remove) return deleteFromLibrary(remove.dataset.delete);
        const localOpen = event.target.closest('[data-lopen]');
        if (localOpen && !event.target.closest('[data-creator]')) {
            const card = localOpen.closest('[data-source][data-id]');
            return openItem(card.dataset.source, card.dataset.id);
        }
        const creator = event.target.closest('[data-creator]');
        if (creator) return openCreator(creator.dataset.creator, creator.dataset.name, creator.dataset.source || state.source);
        const tag = event.target.closest('[data-tag]');
        if (tag) return filterBy({ tag: tag.dataset.tag });
        const customTag = event.target.closest('[data-ctag]');
        if (customTag) return filterBy({ customTag: customTag.dataset.ctag });
        const topic = event.target.closest('[data-topic]');
        if (topic) return filterBy({ topic: topic.dataset.topic });
        const clear = event.target.closest('[data-clear]')?.dataset.clear;
        if (clear) return clearFilter(clear);
        if (event.target.closest('[data-more]')) return event.target.closest('.jai_about').classList.toggle('jai_expanded');
        const card = event.target.closest('.jai_card');
        if (card) openItem(card.dataset.source, card.dataset.id);
    });

    root.querySelector('.jai_body').addEventListener('change', (event) => {
        if (event.target.matches('.jai_lsort')) {
            state.librarySort = event.target.value;
            renderLibrary();
        }
    });

    // If an avatar doesn't load as a plain image, fetch it ourselves and show it from memory.
    root.addEventListener('error', async (event) => {
        const img = event.target;
        if (!(img instanceof HTMLImageElement) || img.dataset.jaiRetried || !/^https:\/\//i.test(img.src)) return;
        img.dataset.jaiRetried = '1';
        const blob = await fetchImage(img.src);
        if (blob) img.src = URL.createObjectURL(blob);
        else img.classList.add('jai_broken');
    }, true);
    $('#jai_message').addEventListener('click', (event) => {
        const action = event.target.closest('[data-jai]')?.dataset.jai;
        if (action === 'retry') retry();
        if (action === 'open') openSite();
        if (action === 'open-chub') window.open(CHUB_SITE, 'jai_chub');
        if (action === 'open-sauce') window.open(SAUCE, 'jai_sauce');
        if (action === 'disconnect-sauce') {
            storeSauceToken('');
            toastr.info('Saucepan account disconnected.', 'Bot Bazaar');
            showConnect();
        }
        if (action === 'save') saveToken();
        if (action === 'paste') pasteToken();
        if (action === 'disconnect') disconnect();
        if (action === 'disconnect-chub') {
            storeChubKey('');
            toastr.info('Chub account disconnected.', 'Bot Bazaar');
            showConnect();
        }
        if (action === 'resume') resume();
        if (action === 'copycode') copyText(buildBookmarklet(), 'Button code copied.');
    });
}

const openSite = () => window.open(SITE, 'jai_site');
const hasNext = () => state.size > 0 && state.page * state.size < state.total;
const openItem = (source, id) => ({ chub: openChubDetail, saucepan: openSauceDetail }[source] || openDetail)(id);

function resetFilters() {
    state.page = 1;
    state.search = '';
    state.tag = '';
    state.customTag = '';
    state.topic = '';
    state.creator = null;
    if (root) $('#jai_search').value = '';
}

function switchSource(source) {
    state.source = source;
    state.kind = 'characters';
    state.sort = DEFAULT_SORT[source] || state.sort;
    resetFilters();
    try { localStorage.setItem(SOURCE_KEY, source); } catch { /* storage unavailable */ }
    loadList();
}

function submitSearch() {
    const text = $('#jai_search').value.trim();
    const chub = text.match(/(?:chub\.ai|characterhub\.org)\/(characters|lorebooks)\/([^/?#\s]+\/[^/?#\s]+)/i);
    const janitorCharacter = /janitorai\.com\/characters\//i.test(text) || /^[0-9a-f-]{36}$/i.test(text) ? text.match(UUID)?.[0] : null;
    const janitorProfile = /janitorai\.com\/profiles\//i.test(text) ? text.match(UUID)?.[0] : null;
    const sauce = text.match(/saucepan\.ai\/(companion|lorebook)\/([0-9a-f-]{36})/i);
    const sauceUser = text.match(/saucepan\.ai\/(?:u|user)\/([^/?#\s]+)/i);

    if (sauce || sauceUser) {
        $('#jai_search').value = state.search;
        if (state.source !== 'saucepan') {
            state.source = 'saucepan';
            state.sort = DEFAULT_SORT.saucepan;
            resetFilters();
            try { localStorage.setItem(SOURCE_KEY, 'saucepan'); } catch { /* storage unavailable */ }
        }
        if (sauceUser) return openCreator('', decodeURIComponent(sauceUser[1]), 'saucepan');
        return sauce[1].toLowerCase() === 'lorebook' ? openSauceLorebook(sauce[2]) : openSauceDetail(sauce[2]);
    }

    if (chub || janitorCharacter || janitorProfile) {
        $('#jai_search').value = state.search;
        const source = chub ? 'chub' : 'janitor';
        if (state.source !== source) {
            state.source = source;
            state.sort = DEFAULT_SORT[source];
            resetFilters();
            try { localStorage.setItem(SOURCE_KEY, source); } catch { /* storage unavailable */ }
        }
        if (chub) return openChubDetail(chub[1].toLowerCase() === 'lorebooks' ? `lorebooks/${chub[2]}` : chub[2]);
        if (janitorCharacter) return openDetail(janitorCharacter);
        return openCreator(janitorProfile, '', 'janitor');
    }

    if (isLocalView()) {
        state.search = text;
        return loadList();
    }
    const searchSort = SEARCH_SORT[state.source];
    if (searchSort && text && !state.search) state.sort = searchSort;
    if (searchSort && !text && state.sort === searchSort) state.sort = DEFAULT_SORT[state.source];
    state.search = text;
    state.page = 1;
    loadList();
}

function filterBy({ tag, customTag, topic }) {
    if (tag !== undefined) state.tag = String(tag);
    if (customTag !== undefined) state.customTag = customTag;
    if (topic !== undefined) state.topic = topic;
    state.page = 1;
    loadList();
}

function clearFilter(which) {
    if (which === 'creator') {
        state.creator = null;
        state.sort = DEFAULT_SORT[state.source];
    }
    if (which === 'customTag') state.customTag = '';
    if (which === 'tag') state.tag = '';
    if (which === 'topic') state.topic = '';
    if (which === 'search') {
        state.search = '';
        $('#jai_search').value = '';
        if (state.sort === SEARCH_SORT[state.source]) state.sort = DEFAULT_SORT[state.source];
    }
    state.page = 1;
    loadList();
}

/** Shows everything one creator has published. */
function openCreator(id, name, source = state.source) {
    if (source !== state.source) {
        state.source = source;
        try { localStorage.setItem(SOURCE_KEY, source); } catch { /* storage unavailable */ }
    }
    resetFilters();
    state.kind = 'characters';
    state.creator = { id: source === 'chub' ? (name || id) : id, name: name || '', profile: null };
    // Saucepan creators are found by handle when only the handle is known (e.g. from the Library).
    if (source === 'saucepan' && !id && !name) state.creator = null;
    state.sort = CREATOR_SORT[source];
    loadList().then(() => state.creator && loadCreator(state.creator.id || state.creator.name));
}

function resume() {
    awaitingLogin = false;
    if (state.detail) return openItem(state.detailSource, state.detail);
    if (!signedIn() && state.source === 'janitor') {
        // Anonymous JanitorAI visitors can only see the first page without a search, so go back to it.
        state.page = 1;
        state.search = '';
        state.customTag = '';
        if (state.sort === 'relevance') state.sort = 'popular';
        $('#jai_search').value = '';
    }
    return loadList();
}

function retry() {
    bridgeProbed = false;
    resume();
}

async function copyText(text, message) {
    try {
        await navigator.clipboard.writeText(text);
        toastr.info(message, 'Bot Bazaar');
    } catch {
        // Clipboard access is blocked on plain-http pages that aren't localhost (e.g. a phone on the home network).
        await ctx().Popup.show.input('Copy this text', 'Select all of it and copy.', text);
    }
}

function updateStatus() {
    if (!root) return;
    if (state.source === 'chub') {
        $('#jai_status').className = 'jai_status jai_ok';
        $('#jai_status').textContent = chubAccount().key ? `Chub · connected${chubAccount().user ? ` as @${chubAccount().user}` : ''}` : 'Chub · no account needed';
        return;
    }
    if (state.source === 'saucepan') {
        const sauce = sauceAccount();
        const status = $('#jai_status');
        if (sauceProxyOk === false) {
            status.className = 'jai_status jai_bad';
            status.textContent = 'Saucepan · proxy switched off';
        } else if (sauce.token) {
            status.className = `jai_status ${sauce.verified ? 'jai_ok' : 'jai_bad'}`;
            status.textContent = `Saucepan · connected${sauce.user ? ` as @${sauce.user}` : ''}${sauce.verified ? '' : ' · email not verified'}`;
        } else {
            status.className = 'jai_status';
            status.textContent = 'Saucepan · not connected (browse only)';
        }
        return;
    }
    if (isLocalView()) {
        $('#jai_status').className = 'jai_status jai_ok';
        $('#jai_status').textContent = state.source === 'favorites' ? `${favorites?.length ?? 0} favorites` : `${libraryItems().length} imported characters`;
        return;
    }
    const { token, expired, minutesLeft } = account();
    let ok = true;
    let text;
    if (bridgeVersion) {
        text = 'Helper script connected';
    } else if (token && !expired) {
        const left = minutesLeft === null ? '' : (minutesLeft >= 120 ? ` · token valid ~${Math.round(minutesLeft / 60)} h` : ` · token valid ${Math.max(minutesLeft, 1)} min`);
        text = `Account connected${left}`;
    } else {
        ok = false;
        text = expired ? 'Token expired — reconnect' : 'Not connected — first page only';
    }
    const status = $('#jai_status');
    status.className = `jai_status ${ok ? 'jai_ok' : 'jai_bad'}`;
    status.textContent = text;
}

function showMessage(html) {
    const box = $('#jai_message');
    box.innerHTML = html || '';
    box.style.display = html ? '' : 'none';
}

const button = (action, icon, label) => `<div class="jai_btn" data-jai="${action}"><i class="fa-solid ${icon}"></i><span>${label}</span></div>`;
const actions = (...buttons) => `<div class="jai_actions">${buttons.join('')}</div>`;

/** Hides the list / detail without forgetting what the user was looking at. */
function hideViews() {
    for (const id of ['jai_grid', 'jai_detail', 'jai_creator', 'jai_filters']) $(`#${id}`).style.display = 'none';
    root.querySelector('.jai_footer').style.display = 'none';
}

// Run on janitorai.com (as a bookmark), this copies the visitor's own login token to the clipboard.
// (bookmark moved to buildBookmarklet, defined above addButtons)

let awaitingLogin = false;
let lastClipboard = '';

function showConnect(reason = '') {
    hideViews();
    awaitingLogin = true;
    const { token, expired, minutesLeft } = account();
    const chub = chubAccount();
    const janitorState = bridgeVersion
        ? '<span class="jai_ok"><i class="fa-solid fa-check"></i> helper script</span>'
        : (token && !expired
            ? `<span class="jai_ok"><i class="fa-solid fa-check"></i> connected · ${minutesLeft >= 120 ? `~${Math.round(minutesLeft / 60)} h` : `${Math.max(minutesLeft ?? 0, 1)} min`} left</span>`
            : `<span class="jai_bad">${expired ? 'login expired' : 'not connected'}</span>`);
    const sauce = sauceAccount();
    const sauceState = sauce.token
        ? `<span class="${sauce.verified ? 'jai_ok' : 'jai_bad'}"><i class="fa-solid fa-check"></i> connected${sauce.user ? ` as @${esc(sauce.user)}` : ''}${sauce.verified ? '' : ' · email not verified'}</span>`
        : '<span class="jai_bad">not connected</span>';
    const chubState = chub.key
        ? `<span class="jai_ok"><i class="fa-solid fa-check"></i> connected${chub.user ? ` as @${esc(chub.user)}` : ''}</span>`
        : '<span class="jai_bad">not connected</span>';
    const steps = (site, openAction) => `
        <ol class="jai_steps">
            <li>${button(openAction, 'fa-up-right-from-square', `Open ${site}`)} <span>and sign in.</span></li>
            <li>Press the <b>Bot Bazaar</b> bookmark on that page.</li>
            <li>Come back here — it connects by itself.</li>
        </ol>`;
    showMessage(`
        <h3>Accounts</h3>
        ${reason ? `<p class="jai_bad"><i class="fa-solid fa-circle-info"></i> ${esc(reason)}</p>` : ''}
        <div class="jai_acc_grid">
            <div class="jai_acc">
                <div class="jai_acc_head"><b>JanitorAI</b> ${janitorState}</div>
                <p class="jai_note">For search, definitions, lorebooks and your JanitorAI favorites. A JanitorAI login lasts about 3 hours, then repeat steps 2–3.</p>
                ${steps('JanitorAI', 'open')}
                ${token ? '<span class="jai_link" data-jai="disconnect">Disconnect JanitorAI</span>' : ''}
            </div>
            <div class="jai_acc">
                <div class="jai_acc_head"><b>Chub</b> ${chubState}</div>
                <p class="jai_note">Only for your Chub favorites — browsing Chub never needs it. Connect once; it doesn't expire.</p>
                ${steps('Chub', 'open-chub')}
                ${chub.key ? '<span class="jai_link" data-jai="disconnect-chub">Disconnect Chub</span>' : ''}
            </div>
            <div class="jai_acc">
                <div class="jai_acc_head"><b>Saucepan</b> ${sauceState}</div>
                <p class="jai_note">For search, definitions, lorebooks and your Saucepan favorites. Browsing works without it. Connect once; it stays connected.${sauce.token && !sauce.verified ? ' <b>Saucepan only sends definitions to accounts with a verified email</b> — verify yours on saucepan.ai.' : ''}${sauceProxyOk === false ? ' <b>Needs SillyTavern\'s proxy</b> — open the Saucepan tab for the one-time setup.' : ''}</p>
                ${steps('Saucepan', 'open-sauce')}
                ${sauce.token ? '<span class="jai_link" data-jai="disconnect-sauce">Disconnect Saucepan</span>' : ''}
            </div>
        </div>
        <details class="jai_bm" ${settings().bookmarkSeen ? '' : 'open'}>
            <summary><b>First time:</b> add the Bot Bazaar bookmark (one button for every site)</summary>
            <ul>
                <li><b>Computer:</b> press <b>Ctrl+Shift+B</b> to show the bookmarks bar, then drag this onto it: <a class="jai_bookmarklet" href="${esc(buildBookmarklet())}" title="Drag me to the bookmarks bar">Bot Bazaar</a></li>
                <li><b>Phone:</b> ${button('copycode', 'fa-copy', 'Copy bookmark code')} then bookmark any page, edit that bookmark, paste the code as its address and name it <b>bazaar</b>. On JanitorAI, Chub or Saucepan, type <b>bazaar</b> in the address bar and tap the bookmark.</li>
            </ul>
            <p class="jai_note">Added the bookmark before? Replace it with this one — it now works on Saucepan too.</p>
        </details>
        <details>
            <summary>It didn't connect by itself?</summary>
            <p class="jai_note">Some browsers (mostly on phones) don't let pages read what you copied. Paste it here instead:</p>
            <textarea id="jai_token" class="text_pole" rows="2" spellcheck="false" placeholder="Paste what the Bot Bazaar bookmark copied"></textarea>
            ${actions(button('save', 'fa-plug', 'Connect'), button('paste', 'fa-paste', 'Paste & connect'))}
        </details>
        <details>
            <summary>Never copy anything (computer, JanitorAI only)</summary>
            <p>With the helper script the extension uses your open JanitorAI tab directly, so nothing expires and nothing is copied:</p>
            <ol>
                <li>Install <a href="https://www.tampermonkey.net/" target="_blank" rel="noopener">Tampermonkey</a>.</li>
                <li>Right-click the Tampermonkey icon → <b>Manage extension</b> → switch on <b>Allow User Scripts</b>.</li>
                <li>Install the <a href="${esc(USERSCRIPT_URL)}" target="_blank" rel="noopener">helper script</a>, then reload both SillyTavern and JanitorAI and keep a JanitorAI tab open.</li>
            </ol>
        </details>
        ${actions(button('resume', 'fa-arrow-left', 'Back'))}
        <p class="jai_note">Your logins are saved in SillyTavern and this browser, and sent only to janitorai.com, chub.ai and saucepan.ai — never share them.</p>`);
    $('#jai_message').querySelector('.jai_bm')?.addEventListener('toggle', () => {
        settings().bookmarkSeen = true;
        ctx().saveSettingsDebounced();
    }, { once: true });
}

/** When you come back from JanitorAI or Chub with a login copied, connect it without asking. */
async function checkClipboardForLogin() {
    if (!awaitingLogin || !root?.classList.contains('jai_open') || !document.hasFocus() || !$('#jai_token')) return;
    let text = '';
    try {
        text = await navigator.clipboard.readText();
    } catch {
        return;
    }
    if (!text || text === lastClipboard) return;
    lastClipboard = text;
    const jwt = extractToken(text);
    const chubKey = extractChubKey(text);
    if ((!jwt && !chubKey) || (jwt && jwt === account().token) || (chubKey && chubKey === chubAccount().key)) return;
    $('#jai_token').value = text;
    await saveToken();
}

window.addEventListener('focus', () => setTimeout(checkClipboardForLogin, 300));
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') setTimeout(checkClipboardForLogin, 300);
});

async function pasteToken() {
    let text = '';
    try {
        text = await navigator.clipboard.readText();
    } catch {
        return toastr.warning('The browser did not allow reading the clipboard. Paste the token into the box and press Connect.', 'Bot Bazaar');
    }
    if (!extractToken(text) && !extractChubKey(text)) return toastr.warning('The clipboard does not contain a JanitorAI token or Chub key. Press the token bookmark on the JanitorAI or Chub tab first.', 'Bot Bazaar');
    $('#jai_token').value = text;
    await saveToken();
}

async function saveToken() {
    const bazaar = $('#jai_token').value.trim().match(/bazaar:([A-Za-z0-9+/=_-]+)/);
    if (bazaar) {
        showMessage('<i class="fa-solid fa-spinner fa-spin"></i> Connecting…');
        const done = await importLogin(decodeHandoff(bazaar[1]));
        return done.length ? showConnect() : showConnect('That was not a valid Bot Bazaar login. Press the bookmark again.');
    }
    const chubKey = extractChubKey($('#jai_token').value);
    if (chubKey) {
        showMessage('<i class="fa-solid fa-spinner fa-spin"></i> Checking the Chub key…');
        let account = null;
        try {
            account = await verifyChubKey(chubKey);
        } catch { /* handled below */ }
        if (!account) return showConnect('Chub did not accept that key. Make sure you are signed in on chub.ai and press the token button there again.');
        storeChubKey(chubKey, account.user_name || account.name || '');
        toastr.success(`Chub account connected${account.user_name ? ` as @${account.user_name}` : ''}.`, 'Bot Bazaar');
        syncState.chub.at = 0;
        return showConnect();
    }
    const token = extractToken($('#jai_token').value);
    if (!token) return toastr.warning('That text does not contain a JanitorAI token.', 'Bot Bazaar');
    const expiry = tokenExpiry(token);
    if (expiry !== null && expiry < Date.now()) {
        return toastr.warning('That token has already expired. Reload JanitorAI and copy a fresh one.', 'Bot Bazaar');
    }

    storeToken(token);
    updateStatus();
    showMessage('<i class="fa-solid fa-spinner fa-spin"></i> Checking the token…');
    try {
        // Page 2 is only served to signed-in users, which makes it a cheap login check.
        await api('/hampter/characters?page=2&mode=all&sort=popular');
    } catch (error) {
        if (error.code !== 'auth') return showError(error);
        disconnect(false);
        return showConnect('JanitorAI did not accept that token. Make sure you are signed in on JanitorAI and copy it again.');
    }
    toastr.success('JanitorAI account connected.', 'Bot Bazaar');
    syncState.janitor.at = 0;
    showConnect();
}

function disconnect(interactive = true) {
    storeToken('');
    updateStatus();
    if (interactive) {
        toastr.info('JanitorAI token removed.', 'Bot Bazaar');
        showConnect();
    }
}

function showError(error) {
    console.warn(TAG, error);
    hideViews();
    updateStatus();

    if (error.code === 'proxy') {
        showSauceSetup();
    } else if (error.code === 'auth' && state.source === 'saucepan') {
        showConnect(sauceAccount().token ? 'Saucepan did not accept your saved login — press the bookmark on saucepan.ai again.' : error.message);
    } else if (error.code === 'no-tab') {
        showMessage(`
            <h3>Open JanitorAI</h3>
            <p>The helper script is installed, but no JanitorAI tab answered. Open JanitorAI in another tab, sign in, and leave that tab open while you browse here.</p>
            ${actions(button('open', 'fa-up-right-from-square', 'Open JanitorAI'), button('retry', 'fa-rotate', 'Try again'))}`);
    } else if (error.code === 'auth' && bridgeVersion) {
        showMessage(`
            <h3>Sign in to JanitorAI</h3>
            <p>Sign in on your JanitorAI tab (reload that tab if you already are), then try again.</p>
            ${actions(button('open', 'fa-up-right-from-square', 'Open JanitorAI'), button('retry', 'fa-rotate', 'Try again'))}`);
    } else if (error.code === 'auth') {
        const { token, expired } = account();
        showConnect(expired ? 'Your JanitorAI login has expired (they last about 3 hours).' : (token ? 'JanitorAI did not accept your saved token — it has probably expired.' : 'Search and further pages need a JanitorAI account.'));
    } else {
        showMessage(`<h3>Something went wrong</h3><p>${esc(error.message || error)}</p>${actions(button('retry', 'fa-rotate', 'Try again'))}`);
    }
}

function setView(view) {
    $('#jai_grid').style.display = view === 'grid' ? '' : 'none';
    $('#jai_creator').style.display = view === 'grid' && state.creator ? '' : 'none';
    $('#jai_filters').style.display = view === 'grid' ? '' : 'none';
    $('#jai_detail').style.display = view === 'detail' ? '' : 'none';
    root.querySelector('.jai_footer').style.display = view === 'grid' ? '' : 'none';
    if (view !== 'detail') state.detail = null;
}

/** Draws the tabs for the current site and lists the active filters as removable chips. */
function renderControls() {
    root.classList.toggle('jai_theme_chub', state.source === 'chub');
    root.classList.toggle('jai_theme_fav', state.source === 'favorites');
    root.classList.toggle('jai_theme_lib', state.source === 'library');
    root.classList.toggle('jai_theme_sauce', state.source === 'saucepan');
    updateStatus();
    root.querySelectorAll('#jai_sources .jai_tab').forEach(tab => tab.classList.toggle('jai_active', tab.dataset.source === state.source));
    const isChub = state.source === 'chub';
    const local = isLocalView();
    root.querySelector('.jai_navscroll').style.display = local ? 'none' : '';
    const isSauce = state.source === 'saucepan';
    // Saucepan can't list one creator's lorebooks, so a creator page shows characters only.
    $('#jai_kinds').style.display = isChub || (isSauce && !state.creator) ? '' : 'none';
    const booksToggle = root.querySelector('[data-sauce-books]');
    booksToggle.style.display = isSauce && state.kind === 'characters' ? '' : 'none';
    booksToggle.classList.toggle('jai_active', state.sauceBooks);
    root.querySelectorAll('#jai_kinds .jai_tab').forEach(tab => tab.classList.toggle('jai_active', tab.dataset.kind === state.kind));
    $('#jai_sorts').innerHTML = (SORTS[state.source] || [])
        .filter(([sort]) => sort !== SEARCH_SORT[state.source] || state.search)
        .map(([sort, icon, label]) => `<div class="jai_tab ${sort === state.sort ? 'jai_active' : ''}" data-sort="${sort}"><i class="fa-solid ${icon}"></i><span>${label}</span></div>`)
        .join('');
    root.querySelectorAll('#jai_modes .jai_tab').forEach(tab => tab.classList.toggle('jai_active', tab.dataset.mode === state.mode));
    $('#jai_tag').style.display = isChub || isSauce || local ? 'none' : '';
    $('#jai_tag').value = state.tag;

    const chip = (which, icon, label) => `<span class="jai_filter"><i class="fa-solid ${icon}"></i> ${esc(label)} <i class="fa-solid fa-xmark" data-clear="${which}" title="Remove this filter"></i></span>`;
    const chips = [];
    if (state.creator) chips.push(chip('creator', 'fa-user', `@${state.creator.name || 'creator'}`));
    if (state.search) chips.push(chip('search', 'fa-magnifying-glass', state.search));
    if (state.tag) chips.push(chip('tag', 'fa-tag', $('#jai_tag').selectedOptions[0]?.textContent || 'tag'));
    if (state.customTag) chips.push(chip('customTag', 'fa-hashtag', state.customTag));
    if (state.topic) chips.push(chip('topic', 'fa-tag', isSauce ? prettyTag(state.topic) : state.topic));
    $('#jai_filters').innerHTML = local ? '' : chips.join('');
    $('#jai_search').placeholder = local ? 'Filter by name or creator…' : (isSauce && !sauceAccount().token ? 'Paste a Saucepan link (text search needs your login)…' : 'Search… or paste a JanitorAI / Chub / Saucepan link');
}

async function loadTags() {
    if (state.tagsLoaded) return;
    try {
        const tags = await api('/hampter/tags');
        if (!Array.isArray(tags)) return;
        const select = $('#jai_tag');
        tags.slice().sort((a, b) => cleanTag(a.name).localeCompare(cleanTag(b.name))).forEach((tag) => {
            const option = document.createElement('option');
            option.value = tag.id;
            option.textContent = tag.name;
            select.appendChild(option);
        });
        state.tagsLoaded = true;
        renderControls();
    } catch (error) {
        console.warn(TAG, 'Could not load tags', error);
    }
}

async function janitorList() {
    const query = new URLSearchParams({ page: state.page, mode: state.mode, sort: state.sort });
    if (state.search) query.set('search', state.search);
    let path = `/hampter/characters?${query}`;
    if (state.tag) path += `&tag_id[]=${encodeURIComponent(state.tag)}`;
    if (state.customTag) path += `&custom_tags[]=${encodeURIComponent(state.customTag)}`;
    if (state.creator) path += `&user_id[]=${encodeURIComponent(state.creator.id)}`;

    const result = await api(path);
    const items = Array.isArray(result?.data) ? result.data : [];
    return { items: items.map(janitorModel), total: Number(result?.total) || items.length, size: Number(result?.size) || items.length };
}

let listRequest = 0;

async function loadList() {
    setView('grid');
    renderControls();
    updateStatus();
    if (isLocalView()) {
        // Drop any site list still loading, so its answer can't land here or keep the controls locked.
        listRequest++;
        state.loading = false;
        root.querySelector('.jai_footer').style.display = 'none';
        showMessage('');
        if (state.source === 'favorites') {
            startAutoSync();
            return renderFavorites().then(updateStatus);
        }
        return renderLibrary();
    }
    state.loading = true;
    const request = ++listRequest;
    showMessage('<i class="fa-solid fa-spinner fa-spin"></i> Loading…');
    $('#jai_grid').innerHTML = '';
    try {
        const { items, total, size } = await ({ chub: chubList, saucepan: sauceList }[state.source] || janitorList)();
        if (request !== listRequest) return;
        state.total = total;
        state.size = size;
        const countBox = root.querySelector('.jai_creator_count');
        if (countBox && state.creator) {
            countBox.style.display = '';
            countBox.querySelector('b').textContent = compact(total);
        }

        if (state.creator && !state.creator.name && items[0]?.creatorName) {
            state.creator.name = items[0].creatorName;
            renderControls();
        }
        $('#jai_grid').innerHTML = items.map(m => (m.source === 'saucepan' ? renderSauceCard(m) : renderCard(m))).join('');
        root.querySelector('.jai_body').scrollTop = 0;
        showMessage(items.length ? '' : 'Nothing found.');
        if (state.source === 'janitor') loadTags();
    } catch (error) {
        if (request === listRequest) showError(error);
    } finally {
        if (request === listRequest) {
            state.loading = false;
            updateStatus();
            const pages = state.size ? Math.ceil(Math.min(state.total, 10000) / state.size) : 0;
            $('#jai_page').textContent = pages > 1 ? `Page ${state.page} of ${compact(pages)}` : `Page ${state.page}`;
            $('#jai_prev').classList.toggle('jai_disabled', state.page <= 1);
            $('#jai_next').classList.toggle('jai_disabled', !hasNext());
        }
    }
}

function renderCard(model) {
    return `
        <div class="jai_card" data-id="${esc(model.id)}" data-source="${model.source}">
            <div class="jai_card_title" title="${esc(model.name)}">${model.kind === 'lorebook' ? '<i class="fa-solid fa-book-atlas"></i> ' : ''}${esc(model.name)}</div>
            <div class="jai_thumb">
                ${model.image ? `<img loading="lazy" referrerpolicy="no-referrer" src="${esc(model.image)}" alt="">` : ''}
                ${favButton({ ...model, creator: model.creatorName })}
                <span class="jai_stats" title="${esc(model.statsTitle)}">${model.stats}</span>
            </div>
            <div class="jai_card_body">
                <span class="jai_creator_link" data-creator="${esc(model.creatorId)}" data-name="${esc(model.creatorName)}" data-source="${model.source}" title="Show everything by this creator">@${esc(model.creatorName)}${verifiedBadge(model.verified)}</span>
                <div class="jai_blurb">${model.blurb}</div>
            </div>
            <div class="jai_spark"></div>
            <div class="jai_tags">${model.chips}</div>
            <div class="jai_card_foot">
                <span>${compact(model.tokens)} tokens</span>
                ${model.updated ? `<span title="Last updated ${esc(fullDate(model.updated))}"><i class="fa-regular fa-clock"></i> ${esc(timeAgo(model.updated))}</span>` : ''}
            </div>
        </div>`;
}

/** Fills the banner above a creator's characters. */
async function loadCreator(id) {
    const box = $('#jai_creator');
    box.innerHTML = '';
    const source = state.source;
    let info;
    try {
        if (source === 'saucepan') {
            const found = await sauceFetch(`/api/v1/user?${UUID.test(id) ? 'id' : 'handle'}=${encodeURIComponent(id)}`);
            const user = found?.user || {};
            id = state.creator?.id || id;
            info = {
                name: user.handle || id,
                avatar: sauceImage(user.avatar?.id),
                verified: false,
                followers: Number(found?.follower_count),
                count: null,
                since: null,
                about: esc(str(user.description)).replace(/\n/g, '<br>'),
                link: `${SAUCE}/u/${encodeURIComponent(user.handle || id)}`,
                site: 'Saucepan',
            };
        } else if (source === 'chub') {
            const user = await chubGet(`${CHUB_API}/api/users/${encodeURIComponent(id)}`);
            info = {
                name: user.username || user.name || id,
                avatar: user.avatar_url,
                verified: false,
                followers: user.n_followers,
                count: null,
                since: null,
                about: markdownToHtml(user.bio),
                link: `${CHUB_SITE}/users/${encodeURIComponent(user.username || id)}`,
                site: 'Chub',
            };
        } else {
            const profile = await api(`/hampter/profiles/${encodeURIComponent(id)}`);
            const avatar = str(profile.avatar);
            info = {
                name: profile.user_name,
                avatar: /^https?:\/\//i.test(avatar) ? avatar : (avatar ? `https://ella.janitorai.com/avatars/${encodeURIComponent(avatar)}?width=200` : ''),
                verified: profile.is_verified,
                followers: Number(profile.followers_count),
                count: null,
                since: profile.created_at,
                about: profile.about_me,
                link: `${SITE}/profiles/${encodeURIComponent(id)}`,
                site: 'JanitorAI',
            };
        }
    } catch (error) {
        console.warn(TAG, 'Could not load creator profile', error);
        return;
    }
    if (state.creator?.id !== id || state.source !== source) return;
    if (info.name) state.creator.name = info.name;
    renderControls();

    const about = richHtml(info.about);
    const count = info.count ?? state.total;
    box.innerHTML = `
        <div class="jai_creator_head">
            ${info.avatar ? `<img referrerpolicy="no-referrer" src="${esc(info.avatar)}" alt="">` : ''}
            <div>
                <div class="jai_creator_name">@${esc(info.name || state.creator.name)}${verifiedBadge(info.verified)}</div>
                <div class="jai_creator_meta">
                    ${Number.isFinite(info.followers) ? `<span><i class="fa-solid fa-user-group"></i> ${compact(info.followers)} followers</span>` : ''}
                    <span class="jai_creator_count" ${count ? '' : 'style="display:none"'}><i class="fa-solid fa-masks-theater"></i> <b>${compact(count)}</b> ${state.kind === 'lorebooks' ? 'lorebooks' : 'characters'}</span>
                    ${info.since ? `<span><i class="fa-regular fa-calendar"></i> Member since ${esc(fullDate(info.since))}</span>` : ''}
                    <a href="${esc(info.link)}" target="_blank" rel="noopener"><i class="fa-solid fa-up-right-from-square"></i> View on ${info.site}</a>
                </div>
            </div>
        </div>
        ${about.replace(/<[^>]+>/g, '').trim() ? `<div class="jai_about"><div class="jai_about_text jai_rich">${about}</div><span class="jai_link" data-more>Show more / less</span></div>` : ''}`;
    if (!state.detail) box.style.display = '';
}

// ---------------------------------------------------------------------------------------------- character page sections

const STATUS_LABEL = {
    checking: ['jai_dim', 'fa-spinner fa-spin', 'Checking…'],
    ok: ['jai_ok', 'fa-check', 'Will be imported'],
    private: ['jai_bad', 'fa-lock', 'Contents kept private'],
    missing: ['jai_bad', 'fa-ban', 'Deleted or private'],
    unreadable: ['jai_bad', 'fa-triangle-exclamation', 'Could not be read'],
    failed: ['jai_bad', 'fa-triangle-exclamation', 'Could not be checked'],
    code: ['jai_dim', 'fa-code', 'Code — not supported'],
    unverified: ['jai_bad', 'fa-envelope', 'Needs a verified Saucepan email'],
};

/**
 * One box per lorebook: name, kind and whether it can be imported.
 * @param {{name: string, kind: string, status: string, entries?: number, meta?: string}[]} books
 */
function booksPanel(books) {
    if (!books.length) return '';
    const rows = books.map((book) => {
        const [cls, icon, label] = STATUS_LABEL[book.status] || STATUS_LABEL.checking;
        return `
            <div class="jai_book ${book.status === 'ok' ? 'jai_book_ok' : ''}">
                <div class="jai_book_head">
                    <b>${esc(book.name)}</b>
                    <span class="jai_kind">${esc(book.kind)}</span>
                </div>
                <div class="jai_book_meta">
                    <span class="${cls}"><i class="fa-solid ${icon}"></i> ${label}${book.status === 'ok' && book.entries ? ` · ${book.entries} entries` : ''}</span>
                    ${book.meta ? `<span>${esc(book.meta)}</span>` : ''}
                </div>
                ${book.about ? `<div class="jai_book_about">${esc(book.about)}</div>` : ''}
            </div>`;
    }).join('');
    return `<div class="jai_section_title"><i class="fa-solid fa-book-atlas"></i> Lorebooks</div><div class="jai_books_grid">${rows}</div>`;
}

const scriptMeta = (script) => [
    script.updated_at ? fullDate(script.updated_at) : '',
    Number(script.message_count) ? `${compact(script.message_count)} messages` : '',
].filter(Boolean).join(' · ');

/** JanitorAI scripts → lorebook boxes. `results` maps script id → fetchScript() result once known. */
function janitorBooks(scripts, results = null) {
    return scripts.all.map((raw, i) => {
        const script = tryJson(raw) || {};
        const isCode = script.type === 'advanced';
        const result = results?.get(String(script.id));
        let status = 'checking';
        if (isCode) status = 'code';
        else if (script.is_public === false) status = 'private';
        else if (result) status = result.status;
        else if (!results && !signedIn()) status = 'failed';
        return {
            name: scriptTitle(script, i),
            kind: isCode ? 'Advanced script' : 'Lorebook',
            status,
            entries: result?.entries?.length,
            meta: scriptMeta(script),
            about: str(script.description),
        };
    });
}

/** Chub: the lorebook stored in the card plus every linked one. */
function chubBooks(node, results = null) {
    const books = [];
    const embedded = node.definition?.embedded_lorebook;
    if (Array.isArray(embedded?.entries) && embedded.entries.length) {
        books.push({ name: str(embedded.name).trim() && embedded.name !== 'Exported' ? embedded.name : 'Built into the card', kind: 'Embedded', status: 'ok', entries: embedded.entries.length });
    }
    relatedLorebooks(node).forEach((id) => {
        const result = results?.get(id);
        books.push({ name: result?.name || `Linked lorebook #${id}`, kind: 'Linked', status: result ? result.status : 'checking', entries: result?.entries?.length });
    });
    return books;
}

/** Collapsible preview of the definition fields that are present. */
function definitionPanel(fields) {
    const present = fields.filter(([, text]) => str(text).trim());
    if (!present.length) return '';
    const parts = present.map(([label, text]) => `
        <details class="jai_def">
            <summary>${esc(label)} <span class="jai_dim">${compact(str(text).length)} chars</span></summary>
            <div class="jai_def_text">${esc(text)}</div>
        </details>`).join('');
    return `<div class="jai_section_title"><i class="fa-solid fa-scroll"></i> Definition</div><div class="jai_defs">${parts}</div>`;
}

// ---------------------------------------------------------------------------------------------- comments

const commentsPanel = (siteUrl, siteName) => `
    <div class="jai_comments" data-loaded="0">
        <div class="jai_section_title">
            <i class="fa-regular fa-comments"></i> Comments
            <span class="jai_comment_count jai_dim"></span>
            <select class="jai_comment_sort" title="Order">
                <option value="likes">Top</option>
                <option value="newest">Newest</option>
            </select>
            <a class="jai_btn jai_small" href="${esc(siteUrl)}" target="_blank" rel="noopener" title="Comments are written on ${esc(siteName)}"><i class="fa-solid fa-pen"></i><span>Write on ${esc(siteName)}</span></a>
        </div>
        <div class="jai_comment_list"><div class="jai_dim"><i class="fa-solid fa-spinner fa-spin"></i> Loading comments…</div></div>
        <div class="jai_btn jai_small jai_more_comments" style="display:none"><span>Load more</span></div>
    </div>`;

function commentHtml(c) {
    return `
        <div class="jai_comment ${c.pinned ? 'jai_pinned' : ''}" data-cid="${esc(c.id)}">
            ${c.avatar ? `<img class="jai_comment_avatar" referrerpolicy="no-referrer" loading="lazy" src="${esc(c.avatar)}" alt="">` : '<div class="jai_comment_avatar"></div>'}
            <div class="jai_comment_main">
                <div class="jai_comment_head">
                    <span class="jai_creator_link" data-creator="${esc(c.userId)}" data-name="${esc(c.user)}" data-source="${c.source}">@${esc(c.user)}${verifiedBadge(c.verified)}</span>
                    ${c.pinned ? '<span class="jai_pin"><i class="fa-solid fa-thumbtack"></i> Pinned</span>' : ''}
                    ${c.stars ? `<span class="jai_stars" title="${c.stars} of 5">${'★'.repeat(c.stars)}${'☆'.repeat(Math.max(0, 5 - c.stars))}</span>` : ''}
                    <span class="jai_dim" title="${esc(fullDate(c.date))}">${esc(timeAgo(c.date))}</span>
                </div>
                ${c.text ? `<div class="jai_comment_text">${esc(c.text)}</div>` : ''}
                <div class="jai_comment_foot">
                    ${c.likes !== undefined ? `<span><i class="fa-regular fa-thumbs-up"></i> ${compact(c.likes)}</span>` : ''}
                    ${c.replyCount ? `<span class="jai_link jai_replies_toggle"><i class="fa-solid fa-chevron-down"></i> ${c.replyCount} repl${c.replyCount > 1 ? 'ies' : 'y'}</span>` : ''}
                </div>
                <div class="jai_replies"></div>
            </div>
        </div>`;
}

const janitorComment = (c, pinned = false) => ({
    source: 'janitor',
    id: c.id,
    user: c.user_profiles?.user_name || 'user',
    userId: c.user_id,
    avatar: c.user_profiles?.avatar ? (/^https?:/i.test(c.user_profiles.avatar) ? c.user_profiles.avatar : `https://ella.janitorai.com/avatars/${encodeURIComponent(c.user_profiles.avatar)}`) : '',
    verified: c.user_profiles?.is_verified,
    pinned: pinned && c.is_pinned,
    date: c.created_at,
    text: str(c.content),
    likes: c.like_count,
    replyCount: Number(c.comment_count) || 0,
});

const chubComment = (c) => ({
    source: 'chub',
    id: c.id,
    user: c.username || 'user',
    userId: c.username,
    avatar: c.avatarUrl || '',
    verified: false,
    pinned: false,
    date: c.commentAt || c.createdAt,
    text: str(c.comment),
    stars: Number(c.rating) || 0,
    replyCount: Array.isArray(c.children) ? c.children.length : 0,
});

/**
 * Loads comments into a panel created by commentsPanel().
 * JanitorAI: /hampter/reviews/<character>?page&size&sortBy, replies at /hampter/reviews/comments/<review>.
 * Chub: /api/project/<id>/ratings returns every rating with its replies in one go.
 */
function wireComments(box, source, ref) {
    const panel = box.querySelector('.jai_comments');
    if (!panel) return;
    const list = panel.querySelector('.jai_comment_list');
    const more = panel.querySelector('.jai_more_comments');
    const sortSelect = panel.querySelector('.jai_comment_sort');
    const pageSize = 20;
    let page = 1;
    let chubMap = null;
    if (source !== 'janitor') sortSelect.style.display = 'none';
    const sauceReplies = new Map();

    const load = async (reset) => {
        if (reset) {
            page = 1;
            list.innerHTML = '<div class="jai_dim"><i class="fa-solid fa-spinner fa-spin"></i> Loading comments…</div>';
        }
        more.style.display = 'none';
        try {
            let items;
            let hasMore = false;
            if (source.startsWith('saucepan')) {
                const type = source === 'saucepan-lorebook' ? 'lorebook' : 'companion';
                const result = await sauceFetch(`/api/v1/comments?entity_type=${type}&entity_id=${encodeURIComponent(ref)}&limit=${pageSize}&offset=${(page - 1) * pageSize}`);
                const raw = Array.isArray(result?.comments) ? result.comments : [];
                raw.forEach(c => sauceReplies.set(c.id, Array.isArray(c.replies) ? c.replies : []));
                items = raw.map(sauceComment);
                hasMore = raw.length === pageSize;
                const total = Number(result?.count || 0) + Number(result?.reply_count || 0);
                panel.querySelector('.jai_comment_count').textContent = total ? `(${total})` : '';
                if (result?.is_disabled) {
                    list.innerHTML = '<div class="jai_dim">The creator turned comments off.</div>';
                    return;
                }
            } else if (source === 'chub') {
                const result = await chubGet(`${CHUB_API}/api/project/${encodeURIComponent(ref)}/ratings`);
                chubMap = result?.ratings_map || {};
                const all = Object.values(chubMap);
                items = all.filter(c => !c.parentId && (str(c.comment).trim() || c.rating))
                    .sort((a, b) => Date.parse(b.commentAt || b.createdAt) - Date.parse(a.commentAt || a.createdAt))
                    .map(chubComment);
                panel.querySelector('.jai_comment_count').textContent = all.length ? `(${all.length})` : '';
            } else {
                const result = await api(`/hampter/reviews/${encodeURIComponent(ref)}?page=${page}&size=${pageSize}&sortBy=${sortSelect.value}`);
                const raw = Array.isArray(result) ? result : (result?.data || []);
                items = raw.map(c => janitorComment(c, true));
                hasMore = raw.length === pageSize;
            }
            if (reset) list.innerHTML = '';
            if (!items.length && reset) list.innerHTML = '<div class="jai_dim">No comments yet.</div>';
            list.insertAdjacentHTML('beforeend', items.map(commentHtml).join(''));
            more.style.display = hasMore ? '' : 'none';
        } catch (error) {
            console.warn(TAG, 'Comments failed', error);
            if (reset) list.innerHTML = `<div class="jai_bad">${esc(error.code === 'auth' ? `Connect your ${source.startsWith('saucepan') ? 'Saucepan' : 'JanitorAI'} account to read comments.` : (error.message || 'Comments could not be loaded.'))}</div>`;
        }
    };

    sortSelect.addEventListener('change', () => load(true));
    more.addEventListener('click', () => { page++; load(false); });
    list.addEventListener('click', async (event) => {
        const toggle = event.target.closest('.jai_replies_toggle');
        if (!toggle) return;
        const comment = toggle.closest('.jai_comment');
        const replies = comment.querySelector(':scope > .jai_comment_main > .jai_replies');
        if (replies.dataset.open === '1') {
            replies.dataset.open = '0';
            replies.innerHTML = '';
            return;
        }
        replies.dataset.open = '1';
        replies.innerHTML = '<div class="jai_dim"><i class="fa-solid fa-spinner fa-spin"></i></div>';
        try {
            let items;
            if (source.startsWith('saucepan')) {
                items = (sauceReplies.get(comment.dataset.cid) || []).map(sauceComment);
            } else if (source === 'chub') {
                const parent = chubMap?.[comment.dataset.cid];
                items = (parent?.children || []).map(id => chubMap[id]).filter(Boolean).map(chubComment);
            } else {
                const result = await api(`/hampter/reviews/comments/${encodeURIComponent(comment.dataset.cid)}`);
                items = (Array.isArray(result) ? result : (result?.data || [])).map(c => janitorComment(c));
            }
            replies.innerHTML = items.map(commentHtml).join('') || '<div class="jai_dim">No replies.</div>';
        } catch (error) {
            replies.innerHTML = `<div class="jai_bad">${esc(error.message || 'Replies could not be loaded.')}</div>`;
        }
    });

    // Load when the panel scrolls into view, not before.
    const observer = new IntersectionObserver((entries) => {
        if (entries.some(e => e.isIntersecting) && panel.dataset.loaded === '0') {
            panel.dataset.loaded = '1';
            observer.disconnect();
            load(true);
        }
    }, { root: root.querySelector('.jai_body'), rootMargin: '300px' });
    observer.observe(panel);
}

async function openDetail(id) {
    setView('detail');
    renderControls();
    state.detail = id;
    state.detailSource = 'janitor';
    $('#jai_detail').style.removeProperty('--jai-backdrop');
    const box = $('#jai_detail');
    box.innerHTML = '';
    showMessage('<i class="fa-solid fa-spinner fa-spin"></i> Loading character…');

    let detail;
    try {
        detail = await api(`/hampter/characters/${encodeURIComponent(id)}`);
    } catch (error) {
        return showError(error);
    }
    if (state.detail !== id) return;
    showMessage('');

    const scripts = sortScripts(detail);
    let bookFact = signedIn() ? 'No lorebook attached' : 'Lorebook needs a connected account';
    if (scripts.shared.length) {
        bookFact = `${scripts.shared.length} lorebook${scripts.shared.length > 1 ? 's' : ''} will be imported`
            + (scripts.private.length ? ` (${scripts.private.length} more kept private by the creator)` : '');
    } else if (scripts.private.length) {
        bookFact = 'Lorebook kept private by the creator';
    }
    if (scripts.advanced.length) bookFact += ` · ${scripts.advanced.length} code script${scripts.advanced.length > 1 ? 's' : ''} (not supported)`;
    const scriptNames = scripts.all.map((script, i) => scriptTitle(script, i)).join(', ');
    const defined = hasDefinition(detail);
    const counts = detail.token_counts || {};
    const tokens = counts.total_tokens;
    const breakdown = [
        ['Personality', counts.personality_tokens],
        ['Scenario', counts.scenario_tokens],
        ['First message', counts.first_message_tokens],
        ['Examples', counts.example_dialog_tokens],
    ].filter(([, n]) => Number(n) > 0).map(([label, n]) => `${label} ${compact(n)}`).join(' · ');
    const published = detail.first_published_at || detail.created_at;
    const greetingCount = [detail.first_message, ...(Array.isArray(detail.first_messages) ? detail.first_messages : [])].map(str).filter(g => g.trim()).length;

    const permanent = Number(tokens) - Number(counts.first_message_tokens || 0);
    const tokenLine = `Character definition is ${defined ? 'visible' : 'hidden'}${tokens ? `, total ${compact(tokens)} tokens` : ''}${tokens && permanent > 0 ? `, permanent ${compact(permanent)}` : ''}`;

    box.innerHTML = `
        <div class="jai_jdetail">
            <div class="jai_jleft">
                <div class="jai_jcard">
                    <h2 class="jai_detail_title">${esc(detail.name)}</h2>
                    <div class="jai_jimage">
                        ${detail.avatar ? `<img referrerpolicy="no-referrer" src="${esc(avatarUrl(detail.avatar, 900))}" alt="">` : ''}
                        <span class="jai_stats" title="Chats · messages"><i class="fa-regular fa-message"></i> ${compact(detail.stats?.chat)} <i class="fa-regular fa-comments"></i> ${compact(detail.stats?.message)}</span>
                    </div>
                    <div class="jai_jby">
                        <span class="jai_byline">by: <span class="jai_creator_link" data-creator="${esc(detail.creator_id)}" data-name="${esc(detail.creator_name)}" title="Show all characters by this creator">@${esc(detail.creator_name)}${verifiedBadge(detail.creator_verified)}</span></span>
                        ${detail.chat_name ? `<span class="jai_dim">chat name: <b>${esc(detail.chat_name)}</b></span>` : ''}
                        ${greetingCount ? `<span class="jai_dim"><i class="fa-regular fa-hand"></i> ${greetingCount} greeting${greetingCount > 1 ? 's' : ''}</span>` : ''}
                    </div>
                    <div class="jai_tags">${tagChips(detail)}</div>
                    <div class="jai_description jai_rich">${richHtml(detail.description)}</div>
                </div>
            </div>
            <div class="jai_jright">
                <div class="jai_jactions">
                    <div class="jai_btn jai_primary jai_import"><i class="fa-solid fa-file-import"></i><span>Import to SillyTavern</span></div>
                    ${favAction({ source: 'janitor', id: detail.id, name: detail.name, image: avatarUrl(detail.avatar, 400), creator: detail.creator_name, creatorId: detail.creator_id, kind: 'character' })}
                    ${scripts.shared.length ? '<div class="jai_btn jai_book_only" title="Save only the lorebook as a World Info file, without importing the character"><i class="fa-solid fa-book-atlas"></i><span>Lorebook only</span></div>' : ''}
                    <a class="jai_btn" href="${SITE}/characters/${esc(detail.id)}" target="_blank" rel="noopener" title="View on JanitorAI"><i class="fa-solid fa-up-right-from-square"></i><span>JanitorAI</span></a>
                    <div class="jai_btn jai_raw" title="Copy the raw data JanitorAI sent for this character (useful for bug reports)"><i class="fa-solid fa-copy"></i></div>
                    <div class="jai_btn jai_back" title="Back to the list"><i class="fa-solid fa-arrow-left"></i><span>Back</span></div>
                </div>
                <div class="jai_dates">
                    ${published ? `<span><i class="fa-regular fa-calendar-plus"></i> Created ${esc(fullDate(published))}</span>` : ''}
                    ${detail.updated_at ? `<span><i class="fa-regular fa-clock"></i> Updated ${esc(fullDate(detail.updated_at))} (${esc(timeAgo(detail.updated_at))})</span>` : ''}
                </div>
                <div class="jai_facts">
                    <span class="${defined ? 'jai_ok' : 'jai_bad'}"><i class="fa-solid ${defined ? 'fa-check' : 'fa-lock'}"></i> ${defined ? 'Definition available' : (signedIn() ? 'Definition hidden by the creator (greetings only)' : 'Definition needs a connected account')}</span>
                    <span class="jai_bookfact ${scripts.shared.length ? '' : (scripts.private.length ? 'jai_bad' : '')}" title="${esc(scriptNames)}"><i class="fa-solid fa-book-atlas"></i> ${scripts.shared.length ? '<i class="fa-solid fa-spinner fa-spin"></i> Checking lorebooks…' : esc(bookFact)}</span>
                    ${signedIn() ? '' : '<span class="jai_link" data-jai-connect><i class="fa-solid fa-key"></i> Connect account</span>'}
                </div>
                ${!defined && signedIn() ? `
                <div class="jai_outside">
                    <b>Definition hidden on JanitorAI.</b> JannyAI may have its own copy (possibly older). If it does, it can be combined with the greetings, avatar and lorebook from here:
                    <div class="jai_actions">
                        <div class="jai_btn jai_janny_auto"><i class="fa-solid fa-wand-magic-sparkles"></i><span>Try to fetch it</span></div>
                        <a class="jai_btn" href="${JANNY}${esc(detail.id)}" target="_blank" rel="noopener"><i class="fa-solid fa-up-right-from-square"></i><span>Open on JannyAI</span></a>
                        <div class="jai_btn jai_janny_file"><i class="fa-solid fa-file-arrow-up"></i><span>Use downloaded card…</span></div>
                    </div>
                    <input type="file" class="jai_janny_input" accept=".png,.json,image/png,application/json" hidden>
                    <div class="jai_note jai_janny_note">If fetching fails: open the JannyAI page, download the card there, then pick that file with "Use downloaded card".</div>
                </div>` : ''}
                <div class="jai_books">${booksPanel(janitorBooks(scripts, signedIn() ? null : new Map()))}</div>
                <div class="jai_tokenline" title="${esc(breakdown)}">${esc(tokenLine)}</div>
                ${definitionPanel([
        ['Personality', detail.personality],
        ['Scenario', detail.scenario],
        ['First message', detail.first_message],
        ...(Array.isArray(detail.first_messages) ? detail.first_messages : []).map(str).filter(g => g.trim() && g !== detail.first_message).map((g, i) => [`Greeting ${i + 2}`, g]),
        ['Example dialogue', detail.example_dialogs],
    ])}
                ${commentsPanel(`${SITE}/characters/${detail.id}`, 'JanitorAI')}
            </div>
        </div>`;

    box.querySelector('[data-jai-connect]')?.addEventListener('click', () => showConnect());
    wireComments(box, 'janitor', detail.id);
    box.querySelector('.jai_back').addEventListener('click', () => ($('#jai_grid').children.length ? (setView('grid'), showMessage('')) : loadList()));
    box.querySelector('.jai_raw').addEventListener('click', async () => {
        await copyText(JSON.stringify(detail, null, 2), 'Raw character data copied to the clipboard.');
    });

    // Definition from another copy of the card (JannyAI), merged in at import time.
    let outside = null;
    const useOutside = async (load) => {
        const note = box.querySelector('.jai_janny_note');
        try {
            const data = await load();
            if (!sameCharacter(detail, data)) {
                const ok = await ctx().Popup.show.confirm('Different character?', `That card is named "${str(data.name)}", which does not look like "${str(detail.name)}". Use its definition anyway?`);
                if (!ok) return;
            }
            outside = data;
            const fact = box.querySelector('.jai_facts span');
            fact.className = 'jai_ok';
            fact.innerHTML = '<i class="fa-solid fa-check"></i> Definition from the JannyAI copy (may be older than the JanitorAI version)';
            note.textContent = 'Definition loaded. Press "Import to SillyTavern".';
            note.classList.add('jai_ok');
        } catch (error) {
            console.warn(TAG, 'Outside definition failed', error);
            note.classList.remove('jai_ok');
            note.textContent = `${error?.message || error} Open the JannyAI page, download the card there, then pick that file with "Use downloaded card". If JannyAI has no page for this character, there is no copy to use.`;
        }
    };
    const autoButton = box.querySelector('.jai_janny_auto');
    autoButton?.addEventListener('click', async () => {
        if (autoButton.classList.contains('jai_disabled')) return;
        autoButton.classList.add('jai_disabled');
        await useOutside(() => fetchJannyCopy(detail.id));
        autoButton.classList.remove('jai_disabled');
    });
    const fileInput = box.querySelector('.jai_janny_input');
    box.querySelector('.jai_janny_file')?.addEventListener('click', () => fileInput.click());
    fileInput?.addEventListener('change', async () => {
        const file = fileInput.files?.[0];
        fileInput.value = '';
        if (file) await useOutside(() => readCardFile(file));
    });

    // Attached lorebooks may still keep their contents private; check each one before promising anything.
    if (scripts.shared.length) {
        (async () => {
            const results = [];
            for (const script of scripts.shared) {
                try {
                    results.push({ id: String(script.id), title: script.title, ...(await fetchScript(String(script.id))) });
                } catch {
                    results.push({ id: String(script.id), title: script.title, status: 'unreadable' });
                }
                if (state.detail !== id) return;
            }
            const readable = results.filter(r => r.status === 'ok');
            const closed = results.filter(r => r.status !== 'ok').length + scripts.private.length;
            const total = readable.reduce((sum, r) => sum + r.entries.length, 0);
            const fact = box.querySelector('.jai_bookfact');
            if (!fact) return;
            let text = readable.length
                ? `${readable.length} lorebook${readable.length > 1 ? 's' : ''} (${total} entries) will be imported`
                : 'Lorebook contents kept private by the creator';
            if (readable.length && closed) text += ` · ${closed} more kept private by the creator`;
            if (scripts.advanced.length) text += ` · ${scripts.advanced.length} code script${scripts.advanced.length > 1 ? 's' : ''} (not supported)`;
            fact.className = `jai_bookfact ${readable.length ? 'jai_ok' : 'jai_bad'}`;
            fact.innerHTML = `<i class="fa-solid fa-book-atlas"></i> ${esc(text)}`;
            if (!readable.length) box.querySelector('.jai_book_only')?.remove();
            const panel = box.querySelector('.jai_books');
            if (panel) panel.innerHTML = booksPanel(janitorBooks(scripts, new Map(results.map(r => [r.id, r]))));
        })();
    }

    const bookButton = box.querySelector('.jai_book_only');
    bookButton?.addEventListener('click', async () => {
        if (bookButton.classList.contains('jai_disabled')) return;
        bookButton.classList.add('jai_disabled');
        try {
            await importLorebookOnly(detail);
        } catch (error) {
            console.error(TAG, 'Lorebook import failed', error);
            toastr.error(String(error?.message || error), 'Bot Bazaar: lorebook import failed');
        } finally {
            bookButton.classList.remove('jai_disabled');
        }
    });

    const importButton = box.querySelector('.jai_import');
    importButton.addEventListener('click', async () => {
        if (importButton.classList.contains('jai_disabled')) return;
        importButton.classList.add('jai_disabled');
        importButton.querySelector('span').textContent = 'Importing…';
        try {
            if (await importCharacter(outside ? withOutsideDefinition(detail, outside) : detail)) closeBrowser();
        } catch (error) {
            console.error(TAG, 'Import failed', error);
            toastr.error(String(error?.message || error), 'Bot Bazaar: import failed');
        } finally {
            importButton.classList.remove('jai_disabled');
            importButton.querySelector('span').textContent = 'Import to SillyTavern';
        }
    });
}

/** Character or lorebook page for Chub. */
async function openChubDetail(fullPath) {
    setView('detail');
    renderControls();
    state.detail = fullPath;
    state.detailSource = 'chub';
    const box = $('#jai_detail');
    box.innerHTML = '';
    showMessage('<i class="fa-solid fa-spinner fa-spin"></i> Loading…');

    let node;
    try {
        node = await chubDetail(fullPath);
    } catch (error) {
        return showError(error);
    }
    if (state.detail !== fullPath) return;
    showMessage('');

    const def = node.definition || {};
    const { isLorebook, creator } = chubParts(node.fullPath || fullPath);
    node.fullPath = node.fullPath || fullPath;
    const embeddedCount = Array.isArray(def.embedded_lorebook?.entries) ? def.embedded_lorebook.entries.length : 0;
    const related = relatedLorebooks(node);
    const greetingCount = [def.first_message, ...(Array.isArray(def.alternate_greetings) ? def.alternate_greetings : [])].map(str).filter(g => g.trim()).length;
    const bookParts = [];
    if (embeddedCount) bookParts.push(`${embeddedCount} entries in the card`);
    if (related.length) bookParts.push(`${related.length} linked lorebook${related.length > 1 ? 's' : ''}`);
    const hasBook = isLorebook || bookParts.length > 0;
    const description = str(def.description).trim() || str(node.description).trim();
    const backdrop = node.max_res_url || node.avatar_url;
    if (backdrop) box.style.setProperty('--jai-backdrop', `url("${backdrop.replace(/["\\]/g, '')}")`);

    box.innerHTML = `
        <div class="jai_detail_side">
            ${(node.max_res_url || node.avatar_url) ? `<img referrerpolicy="no-referrer" src="${esc(node.max_res_url || node.avatar_url)}" alt="">` : ''}
            <div class="jai_btn jai_primary jai_import"><i class="fa-solid ${isLorebook ? 'fa-book-atlas' : 'fa-file-import'}"></i><span>${isLorebook ? 'Import lorebook' : 'Import to SillyTavern'}</span></div>
            ${favAction({ source: 'chub', id: node.fullPath, name: node.name, image: node.avatar_url || '', creator, creatorId: creator, kind: isLorebook ? 'lorebook' : 'character' })}
            ${!isLorebook && hasBook ? '<div class="jai_btn jai_book_only" title="Save only the lorebook as a World Info file"><i class="fa-solid fa-book-atlas"></i><span>Lorebook only</span></div>' : ''}
            <div class="jai_btn jai_back"><i class="fa-solid fa-arrow-left"></i><span>Back to list</span></div>
            <a class="jai_btn" href="${esc(chubPageUrl(node.fullPath))}" target="_blank" rel="noopener"><i class="fa-solid fa-up-right-from-square"></i><span>View on Chub</span></a>
            <div class="jai_btn jai_raw" title="Copy the raw data Chub sent (useful for bug reports)"><i class="fa-solid fa-copy"></i><span>Copy raw data</span></div>
        </div>
        <div class="jai_detail_main">
            <h2 class="jai_detail_title">${isLorebook ? '<i class="fa-solid fa-book-atlas"></i> ' : ''}${esc(node.name)}</h2>
            <div class="jai_detail_by">
                <span class="jai_creator_link" data-creator="${esc(creator)}" data-name="${esc(creator)}" data-source="chub" title="Show everything by this creator">@${esc(creator)}${verifiedBadge(node.verified)}</span>
                ${node.tagline ? `<span>${esc(node.tagline)}</span>` : ''}
            </div>
            <div class="jai_statline">
                <span title="Stars"><i class="fa-solid fa-star"></i> ${compact(node.starCount)}</span>
                <span title="Favorites"><i class="fa-solid fa-heart"></i> ${compact(node.n_favorites)}</span>
                ${isLorebook ? '' : `<span title="Chats"><i class="fa-regular fa-message"></i> ${compact(node.nChats)} chats</span>`}
                ${isLorebook ? '' : `<span title="Messages"><i class="fa-regular fa-comments"></i> ${compact(node.nMessages)} messages</span>`}
                ${node.nTokens ? `<span><i class="fa-solid fa-coins"></i> ${compact(node.nTokens)} tokens</span>` : ''}
                ${!isLorebook && greetingCount ? `<span><i class="fa-regular fa-hand"></i> ${greetingCount} greeting${greetingCount > 1 ? 's' : ''}</span>` : ''}
            </div>
            <div class="jai_dates">
                ${node.createdAt ? `<span><i class="fa-regular fa-calendar-plus"></i> Created ${esc(fullDate(node.createdAt))}</span>` : ''}
                ${node.lastActivityAt ? `<span><i class="fa-regular fa-clock"></i> Updated ${esc(fullDate(node.lastActivityAt))} (${esc(timeAgo(node.lastActivityAt))})</span>` : ''}
            </div>
            <div class="jai_facts">
                ${isLorebook
        ? `<span class="${embeddedCount ? 'jai_ok' : ''}"><i class="fa-solid fa-book-atlas"></i> ${embeddedCount ? `${embeddedCount} entries` : 'Lorebook'}</span>`
        : `<span class="jai_ok"><i class="fa-solid fa-check"></i> Definition available</span>
                <span class="jai_bookfact ${embeddedCount ? 'jai_ok' : ''}"><i class="fa-solid fa-book-atlas"></i> ${related.length ? '<i class="fa-solid fa-spinner fa-spin"></i> Checking linked lorebooks…' : (bookParts.length ? `Lorebook: ${esc(bookParts.join(' + '))}` : 'No lorebook attached')}</span>`}
            </div>
            <div class="jai_tags">${topicChips(node.topics)}</div>
            <div class="jai_books">${booksPanel(chubBooks(node))}</div>
            <div class="jai_description jai_rich">${description ? richHtml(looksLikeHtml(description) ? description : markdownToHtml(description)) : '<i>No description.</i>'}</div>
            ${isLorebook ? '' : definitionPanel([
        ['Personality', def.personality],
        ['Scenario', def.scenario],
        ['First message', def.first_message],
        ...(Array.isArray(def.alternate_greetings) ? def.alternate_greetings : []).map(str).filter(g => g.trim()).map((g, i) => [`Greeting ${i + 2}`, g]),
        ['Example dialogue', def.example_dialogs],
        ['System prompt', def.system_prompt],
    ])}
            ${commentsPanel(chubPageUrl(node.fullPath), 'Chub')}
        </div>`;

    box.querySelector('.jai_back').addEventListener('click', () => ($('#jai_grid').children.length ? (setView('grid'), showMessage('')) : loadList()));
    box.querySelector('.jai_raw').addEventListener('click', () => copyText(JSON.stringify(node, null, 2), 'Raw data copied to the clipboard.'));
    wireComments(box, 'chub', node.id);

    const run = (button, label, task) => button?.addEventListener('click', async () => {
        if (button.classList.contains('jai_disabled')) return;
        button.classList.add('jai_disabled');
        button.querySelector('span').textContent = 'Importing…';
        try {
            await task();
        } catch (error) {
            console.error(TAG, 'Chub import failed', error);
            toastr.error(String(error?.message || error), 'Bot Bazaar: import failed');
        } finally {
            button.classList.remove('jai_disabled');
            button.querySelector('span').textContent = label;
        }
    });

    run(box.querySelector('.jai_import'), isLorebook ? 'Import lorebook' : 'Import to SillyTavern', async () => {
        if (isLorebook) return importChubLorebook(node);
        if (await importChubCharacter(node)) closeBrowser();
    });
    // Linked lorebooks can disappear from Chub while characters still point to them; check before promising anything.
    if (!isLorebook && related.length) {
        (async () => {
            const results = [];
            for (const id of related) {
                results.push(await fetchLinkedLorebook(id));
                if (state.detail !== fullPath) return;
            }
            const usable = results.filter(r => r.status === 'ok');
            const gone = results.filter(r => r.status === 'missing').length;
            const failed = results.length - usable.length - gone;
            const parts = [];
            if (embeddedCount) parts.push(`${embeddedCount} entries in the card`);
            if (usable.length) parts.push(`${usable.length} linked lorebook${usable.length > 1 ? 's' : ''} (${usable.reduce((n, r) => n + r.entries.length, 0)} entries)`);
            let text = parts.length ? `Lorebook: ${parts.join(' + ')}` : 'No lorebook available';
            if (gone) text += ` · ${gone} linked lorebook${gone > 1 ? 's' : ''} deleted or private on Chub`;
            if (failed) text += ` · ${failed} could not be checked`;
            const fact = box.querySelector('.jai_bookfact');
            if (!fact) return;
            fact.className = `jai_bookfact ${parts.length ? 'jai_ok' : 'jai_bad'}`;
            fact.innerHTML = `<i class="fa-solid fa-book-atlas"></i> ${esc(text)}`;
            if (!parts.length && !failed) box.querySelector('.jai_book_only')?.remove();
            const panel = box.querySelector('.jai_books');
            if (panel) panel.innerHTML = booksPanel(chubBooks(node, new Map(related.map((rid, i) => [rid, results[i]]))));
        })();
    }

    run(box.querySelector('.jai_book_only'), 'Lorebook only', async () => {
        const name = safeName(def.name || node.name) || 'Chub character';
        const { book, warnings } = await chubBook(node, `${name} (Chub Lorebook)`);
        warnings.forEach(w => toastr.warning(w, 'Bot Bazaar', { timeOut: 12000 }));
        if (!book) return toastr.info('No lorebook entries could be imported.', 'Bot Bazaar');
        const { saveWorldInfo, convertCharacterBook, updateWorldInfoList } = ctx();
        await saveWorldInfo(book.name, convertCharacterBook(structuredClone(book)), true);
        await updateWorldInfoList();
        toastr.success(`"${book.name}" saved with ${book.entries.length} entries. To attach it, open a character and pick it with the globe button.`, 'Bot Bazaar', { timeOut: 12000 });
    });
}

// ---------------------------------------------------------------------------------------------- Saucepan pages

const sauceChips = (tags) => (Array.isArray(tags) ? tags : [])
    .map(tag => `<span class="jai_chip" data-topic="${esc(tag)}" title="Show more with this tag">${esc(prettyTag(tag))}</span>`).join('');

const sauceBlurb = (text) => esc(str(text).trim()).replace(/\n{2,}/g, '<br><br>').replace(/\n/g, '<br>');

/** Saucepan card: tall portrait with the name over it, description and tags below. */
function renderSauceCard(m) {
    const isBook = m.kind === 'lorebook';
    const stats = isBook
        ? `<span title="Favorites"><i class="fa-solid fa-heart"></i> ${compact(m.favs)}</span>${m.chapters ? `<span title="Entries"><i class="fa-solid fa-list"></i> ${compact(m.chapters)}</span>` : ''}${m.words ? `<span title="Words"><i class="fa-solid fa-font"></i> ${compact(m.words)}</span>` : ''}`
        : `<span title="Favorites"><i class="fa-solid fa-heart"></i> ${compact(m.favs)}</span><span title="Chats"><i class="fa-regular fa-message"></i> ${compact(m.chats)}</span>${m.books ? `<span title="${m.books} lorebook${m.books > 1 ? 's' : ''}"><i class="fa-solid fa-book-atlas"></i> ${m.books}</span>` : ''}`;
    return `
        <div class="jai_card jai_scard" data-id="${esc(m.id)}" data-source="saucepan" data-kind="${m.kind}">
            <div class="jai_sthumb">
                ${m.image ? `<img loading="lazy" referrerpolicy="no-referrer" src="${esc(m.image)}" alt="">` : '<div class="jai_poster_blank"><i class="fa-solid fa-user"></i></div>'}
                ${favButton({ ...m, creator: m.creatorName })}
                ${isBook ? '<span class="jai_sbadge"><i class="fa-solid fa-book-atlas"></i> Lorebook</span>' : ''}
                <div class="jai_sname">
                    <b title="${esc(m.name)}">${esc(m.name)}</b>
                    <span class="jai_creator_link" data-creator="${esc(m.creatorId)}" data-name="${esc(m.creatorName)}" data-source="saucepan" title="Show everything by this creator">@${esc(m.creatorName)}</span>
                </div>
            </div>
            <div class="jai_sbody">
                <div class="jai_sstats">${stats}</div>
                <div class="jai_blurb">${sauceBlurb(m.blurb)}</div>
                <div class="jai_tags">${sauceChips(m.tags)}</div>
                <div class="jai_card_foot">
                    ${isBook ? '' : `<span>${compact(m.tokens)} tokens</span>`}
                    ${m.updated ? `<span title="Last updated ${esc(fullDate(m.updated))}"><i class="fa-regular fa-clock"></i> ${esc(timeAgo(m.updated))}</span>` : ''}
                </div>
            </div>
        </div>`;
}

/** Shown when SillyTavern's proxy is off: the one-time setup Saucepan needs. */
function showSauceSetup() {
    hideViews();
    showMessage(`
        <h3><i class="fa-solid fa-plug"></i> One-time setup for Saucepan</h3>
        <p>Saucepan only answers its own website, so Bot Bazaar talks to it through SillyTavern's built-in proxy. That proxy is switched off right now.</p>
        <ol class="jai_steps">
            <li>Open <b>config.yaml</b> in your SillyTavern folder (the same folder as <i>Start.bat</i> / <i>start.sh</i>).</li>
            <li>Find <code>enableCorsProxy: false</code> and change it to <code>enableCorsProxy: true</code>, then save.</li>
            <li>Restart SillyTavern and reload this page.</li>
        </ol>
        <p class="jai_note">Only needed once, and it then works on every device that uses this SillyTavern, phones included. JanitorAI, Chub, Favorites and the Library work without it.</p>
        ${actions(button('retry', 'fa-rotate', 'Try again'), `<div class="jai_btn" data-source-switch="chub"><i class="fa-solid fa-arrow-left"></i><span>Browse Chub instead</span></div>`)}`);
    $('#jai_message').querySelector('[data-source-switch]')?.addEventListener('click', () => switchSource('chub'));
}

function sauceStatusFact(result, open) {
    switch (result?.status) {
        case 'ok': return sauceHasDefinition(result.def) ? ['jai_ok', 'fa-check', 'Definition available'] : ['jai_bad', 'fa-lock', 'Saucepan sent no definition'];
        case 'login': return ['jai_bad', 'fa-key', 'Definition needs your Saucepan login'];
        case 'unverified': return ['jai_bad', 'fa-envelope', 'Verify your email on Saucepan to get definitions'];
        case 'hidden': return ['jai_bad', 'fa-lock', open === false ? 'Definition hidden by the creator' : 'Saucepan did not send the definition'];
        case 'failed': return ['jai_bad', 'fa-triangle-exclamation', `Definition could not be loaded: ${result.message || ''}`];
        default: return ['jai_dim', 'fa-spinner fa-spin', 'Checking the definition…'];
    }
}

/** Character page for Saucepan. */
async function openSauceDetail(id) {
    const seen = sauceSeen.get(id);
    if (seen?.kind === 'lorebook') return openSauceLorebook(id);
    setView('detail');
    renderControls();
    state.detail = id;
    state.detailSource = 'saucepan';
    const box = $('#jai_detail');
    box.innerHTML = '';
    box.style.removeProperty('--jai-backdrop');
    showMessage('<i class="fa-solid fa-spinner fa-spin"></i> Loading character…');

    let c;
    try {
        const result = await sauceFetch(`/api/v2/companions/${encodeURIComponent(id)}`);
        c = result?.companion;
        if (!c) throw new ApiError('http', 'Saucepan did not return this character.');
    } catch (error) {
        // A favorite saved as a character may really be a lorebook.
        if (error.status === 404 && !seen) return openSauceLorebook(id);
        return showError(error);
    }
    if (state.detail !== id) return;
    showMessage('');

    const m = sauceModel(c);
    const connected = !!sauceAccount().token;
    const posted = sauceDate(c.posted_at);
    const updated = sauceDate(c.updated_at);
    const tokenParts = [
        ['Card', c.card_token_count],
        ['Examples', c.example_dialogue_token_count],
        ['Advanced prompt', c.advanced_prompt_token_count],
        ['Formatting', c.formatting_instructions_token_count],
    ].filter(([, n]) => Number(n) > 0);
    const tokens = tokenParts.reduce((sum, [, n]) => sum + Number(n), 0);
    const [factCls, factIcon, factText] = sauceStatusFact(connected ? null : { status: 'login' }, c.open_definition);
    const bigImage = sauceImage(c.image?.id, 'public');
    if (bigImage) box.style.setProperty('--jai-backdrop', `url("${bigImage}")`);

    box.innerHTML = `
        <div class="jai_sdetail">
            <div class="jai_sportrait">
                ${bigImage ? `<img referrerpolicy="no-referrer" src="${esc(bigImage)}" alt="">` : ''}
                <span class="jai_sheart" title="Favorites"><i class="fa-solid fa-heart"></i> ${compact(c.favorite_count)}</span>
                ${m.portraits ? `<span class="jai_sgallery" title="Portraits on Saucepan"><i class="fa-regular fa-images"></i> ${m.portraits}</span>` : ''}
            </div>
            <div class="jai_shead">
                <h2 class="jai_detail_title">${esc(m.name)}</h2>
                <div class="jai_sby">by <span class="jai_creator_link" data-creator="${esc(c.author_id)}" data-name="${esc(c.author_handle)}" data-source="saucepan" title="Show everything by this creator">@${esc(c.author_handle)}</span>${c.sus ? ' <span class="jai_sspicy" title="Spicy">🌶</span>' : ''}</div>
                <div class="jai_sdesc">${sauceBlurb(c.short_description) || '<i>No description.</i>'}</div>
                <div class="jai_tags">${sauceChips(c.tags)}${(Array.isArray(c.fandom_tags) ? c.fandom_tags : []).map(f => `<span class="jai_chip jai_hash" title="Fandom">${esc(f.display_name || f.id || f)}</span>`).join('')}</div>
                <div class="jai_dates">
                    ${posted ? `<span><i class="fa-regular fa-calendar-plus"></i> Posted ${esc(fullDate(posted))}</span>` : ''}
                    ${updated ? `<span><i class="fa-regular fa-clock"></i> Updated ${esc(fullDate(updated))} (${esc(timeAgo(updated))})</span>` : ''}
                </div>
                <div class="jai_sstats jai_sstats_big">
                    <span title="Chats"><i class="fa-regular fa-message"></i> ${compact(c.chat_count)} chats</span>
                    <span title="Messages"><i class="fa-regular fa-comments"></i> ${compact(c.interaction_count)} messages</span>
                    ${tokens ? `<span title="${esc(tokenParts.map(([l, n]) => `${l} ${compact(n)}`).join(' · '))}"><i class="fa-solid fa-coins"></i> ${compact(tokens)} tokens</span>` : ''}
                    ${Number(c.scenario_count) > 1 ? `<span><i class="fa-regular fa-hand"></i> ${c.scenario_count} scenarios</span>` : ''}
                    ${m.books ? `<span><i class="fa-solid fa-book-atlas"></i> ${m.books} lorebook${m.books > 1 ? 's' : ''}</span>` : ''}
                </div>
                <div class="jai_jactions">
                    <div class="jai_btn jai_primary jai_import"><i class="fa-solid fa-file-import"></i><span>Import to SillyTavern</span></div>
                    ${favAction({ source: 'saucepan', id: c.id, name: m.name, image: m.image, creator: c.author_handle, creatorId: c.author_id, kind: 'character' })}
                    ${m.books ? '<div class="jai_btn jai_book_only" title="Save only the lorebooks as a World Info file"><i class="fa-solid fa-book-atlas"></i><span>Lorebook only</span></div>' : ''}
                    <a class="jai_btn" href="${esc(saucePage(c.id))}" target="_blank" rel="noopener" title="View on Saucepan"><i class="fa-solid fa-up-right-from-square"></i><span>Saucepan</span></a>
                    <div class="jai_btn jai_raw" title="Copy the raw data Saucepan sent (useful for bug reports)"><i class="fa-solid fa-copy"></i></div>
                    <div class="jai_btn jai_back" title="Back to the list"><i class="fa-solid fa-arrow-left"></i><span>Back</span></div>
                </div>
                <div class="jai_facts">
                    <span class="jai_deffact ${factCls}"><i class="fa-solid ${factIcon}"></i> ${esc(factText)}</span>
                    <span class="jai_bookfact ${m.books ? '' : 'jai_dim'}"><i class="fa-solid fa-book-atlas"></i> ${m.books ? (connected ? '<i class="fa-solid fa-spinner fa-spin"></i> Checking lorebooks…' : 'Lorebooks need your Saucepan login') : 'No lorebook attached'}</span>
                    ${c.open_definition ? '<span class="jai_ok" title="The creator shares the definition"><i class="fa-solid fa-lock-open"></i> Open definition</span>' : ''}
                    ${connected ? '' : '<span class="jai_link" data-jai-connect><i class="fa-solid fa-key"></i> Connect Saucepan</span>'}
                </div>
            </div>
        </div>
        <div class="jai_books"></div>
        <div class="jai_sdefs"></div>
        ${commentsPanel(saucePage(c.id), 'Saucepan')}`;

    box.querySelector('[data-jai-connect]')?.addEventListener('click', () => showConnect());
    box.querySelector('.jai_back').addEventListener('click', () => ($('#jai_grid').children.length ? (setView('grid'), showMessage('')) : loadList()));
    box.querySelector('.jai_raw').addEventListener('click', () => copyText(JSON.stringify(c, null, 2), 'Raw data copied to the clipboard.'));
    wireComments(box, 'saucepan', c.id);

    // With a login: the definition and the attached lorebooks, checked before promising anything.
    let defResult = connected ? null : { status: 'login' };
    let attached = null;
    const defReady = connected ? fetchSauceDefinition(c.id).then((result) => {
        defResult = result;
        if (state.detail !== id) return;
        const [cls, icon, text] = sauceStatusFact(result, c.open_definition);
        const fact = box.querySelector('.jai_deffact');
        fact.className = `jai_deffact ${cls}`;
        fact.innerHTML = `<i class="fa-solid ${icon}"></i> ${esc(text)}`;
        if (result.status === 'ok') {
            const def = result.def;
            const greetings = sauceGreetings(def);
            box.querySelector('.jai_sdefs').innerHTML = definitionPanel([
                ['Card', sauceText(def.card)],
                ...greetings.map((g, i) => [i ? `Scenario ${i + 1}` : 'First message', g]),
                ['Example dialogue', sauceText(def.example_dialogue)],
                ['Advanced prompt', sauceText(def.advanced_prompt)],
                ['Formatting instructions', sauceText(def.formatting_instructions)],
            ]);
        }
    }).catch(error => showError(error)) : Promise.resolve();

    if (connected && m.books) {
        (async () => {
            try {
                attached = await sauceAttachedBooks(c.id);
            } catch (error) {
                const fact = box.querySelector('.jai_bookfact');
                if (fact) { fact.className = 'jai_bookfact jai_bad'; fact.innerHTML = `<i class="fa-solid fa-book-atlas"></i> ${esc(error.message)}`; }
                return;
            }
            const show = (results) => {
                const panel = box.querySelector('.jai_books');
                if (panel) {
                    panel.innerHTML = booksPanel(attached.map(b => ({
                        name: str(b.name),
                        kind: b.definition_protection === 'open' ? 'Open lorebook' : 'Lorebook',
                        status: results ? (results.get(b.id)?.status || 'failed') : 'checking',
                        entries: results?.get(b.id)?.entries?.length,
                        meta: [b.owner_handle ? `@${b.owner_handle}` : '', b.total_word_count ? `${compact(b.total_word_count)} words` : '', b.chapter_count ? `${b.chapter_count} entries` : ''].filter(Boolean).join(' · '),
                        about: str(b.short_description).length > 220 ? `${str(b.short_description).slice(0, 220).trim()}…` : str(b.short_description),
                    })));
                }
            };
            show(null);
            const results = new Map();
            for (const b of attached) {
                results.set(b.id, await fetchSauceLorebook(b.id));
                if (state.detail !== id) return;
            }
            show(results);
            const ok = [...results.values()].filter(r => r.status === 'ok');
            const total = ok.reduce((n, r) => n + r.entries.length, 0);
            const fact = box.querySelector('.jai_bookfact');
            if (!fact) return;
            const closed = attached.length - ok.length;
            const fallback = sauceAccount().verified ? 'Saucepan did not send the lorebook contents' : 'Lorebooks need a verified Saucepan email';
            let text = ok.length ? `${ok.length} lorebook${ok.length > 1 ? 's' : ''} (${total} entries) will be imported` : fallback;
            if (ok.length && closed) text += ` · ${closed} not readable`;
            fact.className = `jai_bookfact ${ok.length ? 'jai_ok' : 'jai_bad'}`;
            fact.innerHTML = `<i class="fa-solid fa-book-atlas"></i> ${esc(text)}`;
            if (!ok.length) box.querySelector('.jai_book_only')?.remove();
        })();
    }

    const run = (el, label, task) => el?.addEventListener('click', async () => {
        if (el.classList.contains('jai_disabled')) return;
        el.classList.add('jai_disabled');
        el.querySelector('span').textContent = 'Importing…';
        try {
            await task();
        } catch (error) {
            console.error(TAG, 'Saucepan import failed', error);
            if (error.code === 'proxy') showSauceSetup();
            else toastr.error(String(error?.message || error), 'Bot Bazaar: import failed');
        } finally {
            el.classList.remove('jai_disabled');
            el.querySelector('span').textContent = label;
        }
    });
    run(box.querySelector('.jai_import'), 'Import to SillyTavern', async () => {
        await defReady;
        if (await importSauceCharacter(c, defResult)) closeBrowser();
    });
    run(box.querySelector('.jai_book_only'), 'Lorebook only', async () => {
        const name = safeName(m.name) || 'Saucepan character';
        const { book, warnings } = await sauceBook(c.id, `${name} (Saucepan Lorebook)`, attached);
        warnings.forEach(w => toastr.warning(w, 'Bot Bazaar', { timeOut: 12000 }));
        if (!book) return toastr.info('No lorebook entries could be imported.', 'Bot Bazaar');
        const { saveWorldInfo, convertCharacterBook, updateWorldInfoList } = ctx();
        await saveWorldInfo(book.name, convertCharacterBook(structuredClone(book)), true);
        await updateWorldInfoList();
        toastr.success(`"${book.name}" saved with ${book.entries.length} entries. To attach it, open a character and pick it with the globe button.`, 'Bot Bazaar', { timeOut: 12000 });
    });
}

/** Lorebook page for Saucepan (contents need the login). */
async function openSauceLorebook(id) {
    setView('detail');
    renderControls();
    state.detail = id;
    state.detailSource = 'saucepan';
    const box = $('#jai_detail');
    box.style.removeProperty('--jai-backdrop');
    const fav = favorites?.find(f => f.key === favKey('saucepan', id));
    const m = sauceSeen.get(id) || { id, kind: 'lorebook', name: fav?.name || 'Lorebook', image: fav?.image || '', creatorName: fav?.creator || '', creatorId: fav?.creatorId || '', blurb: '', tags: [] };
    const connected = !!sauceAccount().token;
    showMessage('');
    box.innerHTML = `
        <div class="jai_sdetail">
            <div class="jai_sportrait">
                ${m.image ? `<img referrerpolicy="no-referrer" src="${esc(m.image.replace(/\/thumbnail$/, '/public'))}" alt="">` : ''}
                ${m.favs !== undefined ? `<span class="jai_sheart"><i class="fa-solid fa-heart"></i> ${compact(m.favs)}</span>` : ''}
            </div>
            <div class="jai_shead">
                <h2 class="jai_detail_title"><i class="fa-solid fa-book-atlas"></i> ${esc(m.name)}</h2>
                ${m.creatorName ? `<div class="jai_sby">by <span class="jai_creator_link" data-creator="${esc(m.creatorId)}" data-name="${esc(m.creatorName)}" data-source="saucepan">@${esc(m.creatorName)}</span></div>` : ''}
                <div class="jai_sdesc">${sauceBlurb(m.blurb)}</div>
                <div class="jai_tags">${sauceChips(m.tags)}</div>
                <div class="jai_sstats jai_sstats_big">
                    ${m.chapters ? `<span><i class="fa-solid fa-list"></i> ${compact(m.chapters)} entries</span>` : ''}
                    ${m.words ? `<span><i class="fa-solid fa-font"></i> ${compact(m.words)} words</span>` : ''}
                    ${m.uses ? `<span><i class="fa-solid fa-user"></i> used by ${compact(m.uses)} characters</span>` : ''}
                </div>
                <div class="jai_jactions">
                    <div class="jai_btn jai_primary jai_import"><i class="fa-solid fa-book-atlas"></i><span>Import lorebook</span></div>
                    ${favAction({ source: 'saucepan', id, name: m.name, image: m.image, creator: m.creatorName, creatorId: m.creatorId, kind: 'lorebook' })}
                    <a class="jai_btn" href="${esc(saucePage(id, 'lorebook'))}" target="_blank" rel="noopener"><i class="fa-solid fa-up-right-from-square"></i><span>Saucepan</span></a>
                    <div class="jai_btn jai_back"><i class="fa-solid fa-arrow-left"></i><span>Back</span></div>
                </div>
                <div class="jai_facts">
                    <span class="jai_bookfact ${connected ? 'jai_dim' : 'jai_bad'}"><i class="fa-solid ${connected ? 'fa-spinner fa-spin' : 'fa-key'}"></i> ${connected ? 'Checking the contents…' : 'The contents need your Saucepan login'}</span>
                    ${connected ? '' : '<span class="jai_link" data-jai-connect><i class="fa-solid fa-key"></i> Connect Saucepan</span>'}
                </div>
            </div>
        </div>
        ${commentsPanel(saucePage(id, 'lorebook'), 'Saucepan')}`;
    box.querySelector('[data-jai-connect]')?.addEventListener('click', () => showConnect());
    box.querySelector('.jai_back').addEventListener('click', () => ($('#jai_grid').children.length ? (setView('grid'), showMessage('')) : loadList()));
    wireComments(box, 'saucepan-lorebook', id);

    let result = null;
    if (connected) {
        result = await fetchSauceLorebook(id).catch(error => ({ status: 'failed', message: error.message }));
        if (state.detail !== id) return;
        const fact = box.querySelector('.jai_bookfact');
        fact.className = `jai_bookfact ${result.status === 'ok' ? 'jai_ok' : 'jai_bad'}`;
        fact.innerHTML = result.status === 'ok'
            ? `<i class="fa-solid fa-check"></i> ${result.entries.length} entries will be imported`
            : `<i class="fa-solid fa-lock"></i> ${esc(sauceAccount().verified ? 'Saucepan did not send the contents (kept private by the creator)' : 'Verify your email on Saucepan to read lorebooks')}`;
    }
    const importButton = box.querySelector('.jai_import');
    importButton.addEventListener('click', async () => {
        if (result?.status !== 'ok') return toastr.warning(connected ? 'Saucepan did not send this lorebook\'s contents.' : 'Connect your Saucepan account first.', 'Bot Bazaar');
        const name = safeName(m.name) || 'Saucepan lorebook';
        const book = { name, description: `Imported from Saucepan (${id})`, extensions: {}, entries: result.entries.map((e, i) => convertEntry(e, i)) };
        const { saveWorldInfo, convertCharacterBook, updateWorldInfoList } = ctx();
        await saveWorldInfo(name, convertCharacterBook(structuredClone(book)), true);
        await updateWorldInfoList();
        toastr.success(`"${name}" saved with ${book.entries.length} entries. To attach it, open a character and pick it with the globe button.`, 'Bot Bazaar', { timeOut: 12000 });
    });
}

async function openBrowser() {
    if (!root) buildUi();
    await Promise.all([loadFavorites(), loadSessionFile()]);
    root.classList.add('jai_open');
    await detectBridge();
    updateStatus();
    if (!$('#jai_grid').children.length && !state.detail) loadList();
}

function closeBrowser() {
    root?.classList.remove('jai_open');
}

// ---------------------------------------------------------------------------------------------- entry points

/*
 * The one bookmark. Pressed on a signed-in JanitorAI or Chub tab, it collects the login this browser already holds
 * and hands it straight to SillyTavern through the page URL's #fragment (which browsers never send to any server).
 * This replaces copy-and-paste, which some phone browsers block. For JanitorAI it also captures the refresh token
 * and the site's public key, so Bot Bazaar can keep the login current by itself.
 *
 * Written as a real function so buildBookmarklet() can stringify it faithfully — backslashes in its regexes stay intact.
 */
async function botBazaarBookmark(ST) {
    const CHUB = /(^|\.)(chub\.ai|characterhub\.org)$/.test(location.hostname);
    const JANITOR = /(^|\.)janitorai\.com$/.test(location.hostname);
    const SAUCEPAN = /(^|\.)saucepan\.ai$/.test(location.hostname);
    if (!CHUB && !JANITOR && !SAUCEPAN) { alert('Open janitorai.com, chub.ai or saucepan.ai (signed in) first, then press this.'); return; }
    let payload;
    if (SAUCEPAN) {
        const key = localStorage.getItem('hallucination/auth_token') || '';
        if (!key) { alert('No Saucepan login found here. Sign in to saucepan.ai first.'); return; }
        payload = { v: 1, saucepan: key };
    } else if (CHUB) {
        let key = localStorage.getItem('URQL_TOKEN') || '';
        try { const parsed = JSON.parse(key); if (typeof parsed === 'string') key = parsed; } catch (e) { /* already plain */ }
        if (!key) { alert('No Chub login found here. Sign in to chub.ai first.'); return; }
        payload = { v: 1, chub: key };
    } else {
        const decode = (s) => {
            try { s = decodeURIComponent(s); } catch (e) { /* already decoded */ }
            const m = s.match(/base64-([\w+/=-]+)/);
            if (m) { try { return atob(m[1].replace(/-/g, '+').replace(/_/g, '/')); } catch (e) { /* not base64 */ } }
            return s;
        };
        const cookies = {};
        document.cookie.split(';').map(p => p.trim()).forEach((p) => { const i = p.indexOf('='); if (i > 0) cookies[p.slice(0, i)] = p.slice(i + 1); });
        const groups = {};
        Object.keys(cookies).filter(k => /auth-token/i.test(k)).sort().forEach((k) => { const base = k.replace(/\.\d+$/, ''); groups[base] = (groups[base] || '') + cookies[k]; });
        const candidates = Object.values(groups);
        for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (/auth-token|^sb-/i.test(k)) candidates.push(localStorage.getItem(k)); }
        let session = null;
        for (const raw of candidates) { try { const o = JSON.parse(decode(raw)); if (o && o.access_token && o.refresh_token) { session = o; break; } } catch (e) { /* skip */ } }
        if (!session) { alert('No JanitorAI login found here. Sign in to janitorai.com first.'); return; }
        let apikey = '';
        try {
            const src = [].slice.call(document.querySelectorAll('script[src]')).map(s => s.src).filter(s => /index-.*\.js/.test(s))[0];
            const txt = await (await fetch(src)).text();
            const jwts = txt.match(/eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/g) || [];
            apikey = jwts.filter((j) => { try { return JSON.parse(atob(j.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).role === 'anon'; } catch (e) { return false; } })[0] || '';
        } catch (e) { /* no renewal key; the login still works until it expires */ }
        payload = { v: 1, janitor: { access_token: session.access_token, refresh_token: session.refresh_token, expires_at: session.expires_at, apikey } };
    }
    const data = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
    if (ST) { location.replace(ST + '/#botbazaar=' + encodeURIComponent(data)); return; }
    const out = 'bazaar:' + data;
    if (navigator.clipboard) { navigator.clipboard.writeText(out).then(() => alert('Login copied. Paste it into Bot Bazaar.'), () => prompt('Copy this, then paste into Bot Bazaar:', out)); }
    else { prompt('Copy this, then paste into Bot Bazaar:', out); }
}

const buildBookmarklet = () => `javascript:(${botBazaarBookmark.toString()})(${JSON.stringify(location.origin)});void 0`;

const decodeHandoff = (data) => {
    try { return JSON.parse(decodeURIComponent(escape(atob(decodeURIComponent(data))))); } catch { return null; }
};

/** Applies a captured login. Returns the sites it connected. */
async function importLogin(payload, { open = false } = {}) {
    if (!payload || payload.v !== 1) return [];
    const connected = [];
    if (payload.janitor?.access_token) {
        storeJanitorSession({
            access_token: payload.janitor.access_token,
            refresh_token: payload.janitor.refresh_token || '',
            expires_at: payload.janitor.expires_at,
            apikey: payload.janitor.apikey || '',
        });
        syncState.janitor.at = 0;
        scheduleRefresh();
        connected.push('JanitorAI');
    } else if (typeof payload.janitor === 'string' && extractToken(payload.janitor)) {
        storeToken(extractToken(payload.janitor));
        syncState.janitor.at = 0;
        connected.push('JanitorAI');
    }
    if (payload.chub) {
        const chubUser = await verifyChubKey(payload.chub).catch(() => null);
        if (chubUser) {
            storeChubKey(payload.chub, chubUser.user_name || chubUser.name || '');
            syncState.chub.at = 0;
            connected.push('Chub');
        } else {
            toastr.error('Chub did not accept that login. Sign in on chub.ai and press the bookmark again.', 'Bot Bazaar');
        }
    }
    if (typeof payload.saucepan === 'string' && payload.saucepan) {
        try {
            const user = await verifySauceToken(payload.saucepan);
            if (user) {
                storeSauceToken(payload.saucepan, user);
                syncState.saucepan.at = 0;
                connected.push('Saucepan');
                if (user.is_verified === false) toastr.warning('Your Saucepan email is not verified yet. Saucepan only sends definitions and lorebooks to verified accounts — verify it on saucepan.ai.', 'Bot Bazaar', { timeOut: 15000 });
            } else {
                toastr.error('Saucepan did not accept that login. Sign in on saucepan.ai and press the bookmark again.', 'Bot Bazaar');
            }
        } catch (error) {
            if (error.code === 'proxy') {
                // Keep it: it will work as soon as the proxy is switched on.
                storeSauceToken(payload.saucepan);
                connected.push('Saucepan');
                toastr.warning('Saucepan login saved, but SillyTavern\'s proxy is off. Open the Saucepan tab in Bot Bazaar for the one-time setup.', 'Bot Bazaar', { timeOut: 15000 });
            } else {
                toastr.error(`Saucepan login could not be checked: ${error.message}`, 'Bot Bazaar');
            }
        }
    }
    if (connected.length) {
        toastr.success(`${connected.join(' and ')} connected.`, 'Bot Bazaar');
        if (open && !root?.classList.contains('jai_open')) openBrowser();
        else if (root?.classList.contains('jai_open')) { updateStatus(); if (awaitingLogin) showConnect(); }
    }
    return connected;
}

/** On load, pick up a login the bookmark handed over through the URL fragment, then clear it from the URL. */
function handleHandoff() {
    const match = location.hash.match(/botbazaar=([^&]*)/);
    if (!match) return;
    try { history.replaceState(null, '', location.pathname + location.search); } catch { /* ignore */ }
    const payload = decodeHandoff(match[1]);
    if (payload) importLogin(payload, { open: true });
}

function addButtons() {
    const external = document.getElementById('external_import_button');
    if (external && !document.getElementById('jai_open_button')) {
        const button = document.createElement('div');
        button.id = 'jai_open_button';
        button.className = 'menu_button fa-solid fa-store';
        button.title = 'Bot Bazaar: browse & import characters from JanitorAI, Chub and Saucepan';
        button.addEventListener('click', openBrowser);
        external.insertAdjacentElement('afterend', button);
    }

    const menu = document.getElementById('extensionsMenu');
    if (menu && !document.getElementById('jai_menu_button')) {
        const item = document.createElement('div');
        item.id = 'jai_menu_button';
        item.className = 'list-group-item flex-container flexGap5 interactable';
        item.tabIndex = 0;
        item.innerHTML = '<div class="fa-solid fa-store extensionsMenuExtensionButton"></div><span>Bot Bazaar</span>';
        item.addEventListener('click', openBrowser);
        menu.appendChild(item);
    }
}

jQuery(() => {
    addButtons();
    handleHandoff();
    syncSessionOnStart();
    console.info(TAG, 'loaded');
});
