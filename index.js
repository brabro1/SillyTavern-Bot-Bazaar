/*
 * Janitor Importer — SillyTavern extension
 *
 *  • Browse / search JanitorAI characters from inside SillyTavern.
 *  • Import a character with its full definition, greetings, tags, avatar and attached lorebook(s).
 *
 * Everything runs in the browser: the extension calls JanitorAI's own API directly. Anonymous visitors only get
 * the first page of results and no definitions, so the user can connect their account by pasting a login token
 * (stored in the extension settings, sent only to janitorai.com). Definitions the creator has hidden stay hidden.
 *
 * Optional: if the "Janitor Importer bridge" userscript (janitor-bridge.user.js) is installed, requests are relayed
 * through the user's logged-in JanitorAI tab instead and no token is needed.
 */

import { processDroppedFiles } from '../../../../script.js';

const TAG = '[Janitor Importer]';
const SITE = 'https://janitorai.com';
const AVATARS = 'https://ella.janitorai.com/bot-avatars/';
const USERSCRIPT_URL = new URL('janitor-bridge.user.js', import.meta.url).href;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const ctx = () => SillyTavern.getContext();

// ---------------------------------------------------------------------------------------------- account token

const TOKEN = /eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/;

function settings() {
    const all = ctx().extensionSettings;
    all.janitorImporter ??= { token: '' };
    return all.janitorImporter;
}

const fromBase64Url = (text) => atob(text.replace(/-/g, '+').replace(/_/g, '/'));

/** Pulls the login token out of whatever was pasted: the bare token, "Bearer …", a cookie value or session JSON. */
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

function account() {
    const token = settings().token || '';
    const expiry = token ? tokenExpiry(token) : null;
    return {
        token,
        expired: !!token && expiry !== null && expiry < Date.now(),
        minutesLeft: expiry !== null ? Math.round((expiry - Date.now()) / 60000) : null,
    };
}

const signedIn = () => !!bridgeVersion || (!!account().token && !account().expired);

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
    const before = entry.position === 'before_char' || entry.position === 0 || entry.position === 'before' || entry.placementPosition === 'before';
    const probability = Number(firstDefined(entry.probability, entry.extensions?.probability, 100));
    const caseSensitive = firstDefined(entry.case_sensitive, entry.caseSensitive, entry.extensions?.case_sensitive);
    const wholeWords = firstDefined(entry.matchWholeWords, entry.match_whole_words, entry.extensions?.match_whole_words);
    // JanitorAI's "depth" is how many recent messages are scanned for keywords (per entry, or for the whole book).
    const scanDepth = Number(firstDefined(entry.scan_depth, entry.scanDepth, entry.extensions?.scan_depth, entry.depth, defaults.depth));
    const group = str(firstDefined(entry.inclusionGroupRaw, entry.group)).trim();

    const extensions = { ...(entry.extensions && typeof entry.extensions === 'object' ? entry.extensions : {}) };
    extensions.position = typeof entry.position === 'number' ? entry.position : (before ? 0 : 1);
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
async function buildLorebook(detail, bookName) {
    const warnings = [];
    const scripts = sortScripts(detail).all;
    const entries = [];

    for (const [i, raw] of scripts.entries()) {
        const script = tryJson(raw);
        const id = typeof script === 'string' ? script : firstDefined(script?.id, script?.script_id);
        const label = scriptTitle(script, i);

        if (script?.type === 'advanced') {
            warnings.push(`"${label}" is an advanced (code) script. SillyTavern can't run those, so it was skipped.`);
            continue;
        }

        let found = findEntries(script);
        let defaults = {};
        if (!found && id && UUID.test(String(id))) {
            try {
                const full = await api(`/hampter/script/${encodeURIComponent(id)}`);
                found = findEntries(full?.script ?? full);
                const bookSettings = tryJson(full?.settings);
                if (bookSettings && typeof bookSettings === 'object') defaults = bookSettings;
            } catch (error) {
                console.warn(TAG, 'Could not fetch script', id, error);
                if (error.status === 404 || script?.is_public === false) {
                    warnings.push(`"${label}" is a private lorebook — its creator has not shared the contents, so it can't be imported.`);
                    continue;
                }
                if (error.code === 'auth') throw error;
            }
        }

        if (found?.length) {
            found.forEach(entry => entries.push(convertEntry(entry, entries.length, defaults)));
        } else {
            warnings.push(`The lorebook "${label}" could not be read.`);
        }
    }

    if (!entries.length) return { book: null, warnings, scriptCount: scripts.length };
    return {
        book: { name: bookName, description: `Imported from JanitorAI (${detail.id})`, extensions: {}, entries },
        warnings,
        scriptCount: scripts.length,
    };
}

const cleanTag = (name) => str(name).replace(/^[^\p{L}\p{N}#]+/u, '').trim();
const safeName = (name) => str(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
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

async function avatarPng(detail, displayName) {
    let bitmap = null;
    if (detail.avatar) {
        try {
            const blob = await fetchImage(`${AVATARS}${encodeURIComponent(detail.avatar)}`);
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

async function importCharacter(detail) {
    const { Popup, saveWorldInfo, convertCharacterBook, updateWorldInfoList, getWorldInfoNames } = ctx();
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
    const { book, warnings, scriptCount } = await buildLorebook(detail, bookName);
    const card = buildCard(detail, book);

    if (book) {
        // Create the world file first so the link in the card resolves as soon as the character appears.
        const replacing = getWorldInfoNames().includes(bookName);
        await saveWorldInfo(bookName, convertCharacterBook(structuredClone(book)), true);
        await updateWorldInfoList();
        console.info(TAG, `${replacing ? 'Replaced' : 'Created'} lorebook "${bookName}" with ${book.entries.length} entries`);
    }

    const avatar = await avatarPng(detail, name);
    const file = new File([embedCard(avatar.bytes, card)], `${name}.png`, { type: 'image/png' });
    await processDroppedFiles([file]);

    if (book) toastr.success(`${book.entries.length} lorebook entries imported and linked.`, 'Janitor Importer');
    warnings.forEach(w => toastr.warning(w, 'Janitor Importer', { timeOut: 10000 }));
    if (avatar.placeholder) toastr.info('The avatar could not be downloaded, a placeholder was used.', 'Janitor Importer');
    return true;
}

/** Imports just the shared lorebook(s) of a character as a World Info file, e.g. for a card obtained elsewhere. */
async function importLorebookOnly(detail) {
    const { saveWorldInfo, convertCharacterBook, updateWorldInfoList } = ctx();
    const name = safeName(detail.chat_name) || safeName(detail.name) || 'Janitor character';
    const bookName = `${name} (Janitor Lorebook)`;
    const { book, warnings } = await buildLorebook(detail, bookName);
    warnings.forEach(w => toastr.warning(w, 'Janitor Importer', { timeOut: 10000 }));
    if (!book) return;

    await saveWorldInfo(bookName, convertCharacterBook(structuredClone(book)), true);
    await updateWorldInfoList();
    toastr.success(`"${bookName}" saved with ${book.entries.length} entries. To attach it, open a character and pick it with the globe button.`, 'Janitor Importer', { timeOut: 12000 });
}

// ---------------------------------------------------------------------------------------------- UI

const state = { page: 1, sort: 'popular', mode: 'all', search: '', tag: '', total: 0, size: 0, loading: false, tagsLoaded: false, detail: null };
let root = null;

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
const compact = (n) => (typeof n === 'number' ? Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n) : '?');
const $ = (selector) => root.querySelector(selector);
const avatarUrl = (file, width) => (file ? `${AVATARS}${encodeURIComponent(file)}?width=${width}` : '');
const sanitize = (html) => SillyTavern.libs.DOMPurify.sanitize(str(html), { FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe'], FORBID_ATTR: ['style', 'class', 'id'] });

function buildUi() {
    root = document.createElement('div');
    root.id = 'jai_browser';
    root.innerHTML = `
        <div class="jai_window">
            <div class="jai_header">
                <b class="jai_title"><i class="fa-solid fa-broom"></i> Janitor Importer</b>
                <span id="jai_status" class="jai_status"></span>
                <div class="menu_button menu_button_icon" id="jai_account" title="Connect or change your JanitorAI account"><i class="fa-solid fa-key"></i><span>Account</span></div>
                <div class="menu_button fa-solid fa-xmark" id="jai_close" title="Close"></div>
            </div>
            <div class="jai_toolbar">
                <input id="jai_search" class="text_pole" type="search" placeholder="Search characters… or paste a JanitorAI character link">
                <select id="jai_sort" class="text_pole">
                    <option value="popular">Popular</option>
                    <option value="trending">Trending</option>
                    <option value="latest">Latest</option>
                </select>
                <select id="jai_mode" class="text_pole">
                    <option value="all">All</option>
                    <option value="sfw">SFW</option>
                    <option value="nsfw">NSFW</option>
                </select>
                <select id="jai_tag" class="text_pole"><option value="">Any tag</option></select>
                <div class="menu_button menu_button_icon" id="jai_go"><i class="fa-solid fa-magnifying-glass"></i><span>Search</span></div>
            </div>
            <div class="jai_body">
                <div id="jai_message" class="jai_message"></div>
                <div id="jai_grid" class="jai_grid"></div>
                <div id="jai_detail" class="jai_detail"></div>
            </div>
            <div class="jai_footer">
                <div class="menu_button menu_button_icon" id="jai_prev"><i class="fa-solid fa-chevron-left"></i><span>Prev</span></div>
                <span id="jai_page"></span>
                <div class="menu_button menu_button_icon" id="jai_next"><span>Next</span><i class="fa-solid fa-chevron-right"></i></div>
            </div>
        </div>`;
    document.body.appendChild(root);

    root.addEventListener('mousedown', (event) => event.target === root && closeBrowser());
    $('#jai_close').addEventListener('click', closeBrowser);
    $('#jai_account').addEventListener('click', () => showConnect());
    $('#jai_go').addEventListener('click', submitSearch);
    $('#jai_search').addEventListener('keydown', (event) => event.key === 'Enter' && submitSearch());
    for (const id of ['jai_sort', 'jai_mode', 'jai_tag']) {
        $(`#${id}`).addEventListener('change', () => { readFilters(); state.page = 1; loadList(); });
    }
    $('#jai_prev').addEventListener('click', () => { if (state.page > 1 && !state.loading) { state.page--; loadList(); } });
    $('#jai_next').addEventListener('click', () => { if (hasNext() && !state.loading) { state.page++; loadList(); } });
    $('#jai_grid').addEventListener('click', (event) => {
        const card = event.target.closest('.jai_card');
        if (card) openDetail(card.dataset.id);
    });
    // If an avatar doesn't load as a plain image, fetch it ourselves and show it from memory.
    root.addEventListener('error', async (event) => {
        const img = event.target;
        if (!(img instanceof HTMLImageElement) || img.dataset.jaiRetried || !img.src.startsWith(AVATARS)) return;
        img.dataset.jaiRetried = '1';
        const blob = await fetchImage(img.src);
        if (blob) img.src = URL.createObjectURL(blob);
    }, true);
    $('#jai_message').addEventListener('click', (event) => {
        const action = event.target.closest('[data-jai]')?.dataset.jai;
        if (action === 'retry') retry();
        if (action === 'open') openSite();
        if (action === 'save') saveToken();
        if (action === 'paste') pasteToken();
        if (action === 'disconnect') disconnect();
        if (action === 'resume') resume();
        if (action === 'copycode') copyText(BOOKMARKLET, 'Button code copied.');
    });
}

const openSite = () => window.open(SITE, 'jai_site');
const hasNext = () => state.size > 0 && state.page * state.size < state.total;

function readFilters() {
    state.sort = $('#jai_sort').value;
    state.mode = $('#jai_mode').value;
    state.tag = $('#jai_tag').value;
}

function submitSearch() {
    const text = $('#jai_search').value.trim();
    const id = /janitorai\.com\/characters\//i.test(text) || /^[0-9a-f-]{36}$/i.test(text) ? text.match(UUID)?.[0] : null;
    if (id) return openDetail(id);
    readFilters();
    state.search = text;
    state.page = 1;
    loadList();
}

function resume() {
    if (state.detail) return openDetail(state.detail);
    if (!signedIn()) {
        // Anonymous visitors can only see the unfiltered first page, so go back to it.
        state.page = 1;
        state.search = '';
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
        toastr.info(message, 'Janitor Importer');
    } catch {
        // Clipboard access is blocked on plain-http pages that aren't localhost (e.g. a phone on the home network).
        await ctx().Popup.show.input('Copy this text', 'Select all of it and copy.', text);
    }
}

function updateStatus() {
    if (!root) return;
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

const button = (action, icon, label) => `<div class="menu_button menu_button_icon" data-jai="${action}"><i class="fa-solid ${icon}"></i><span>${label}</span></div>`;
const actions = (...buttons) => `<div class="jai_actions">${buttons.join('')}</div>`;

/** Hides the list / detail without forgetting what the user was looking at. */
function hideViews() {
    $('#jai_grid').style.display = 'none';
    $('#jai_detail').style.display = 'none';
    root.querySelector('.jai_footer').style.display = 'none';
}

// Run on janitorai.com (as a bookmark), this copies the visitor's own login token to the clipboard.
const BOOKMARKLET = 'javascript:(()=>{if(!/(^|\\.)janitorai\\.com$/.test(location.hostname)){alert("Open janitorai.com and sign in first, then use this button there.");return}'
    + 'const dec=s=>{try{s=decodeURIComponent(s)}catch(e){}const m=s.match(/base64-([\\w+/=-]+)/);if(m){try{s+=" "+atob(m[1].replace(/-/g,"+").replace(/_/g,"/"))}catch(e){}}return s};'
    + 'const ck={};document.cookie.split(";").map(p=>p.trim()).sort().forEach(p=>{const i=p.indexOf("=");if(i>0){const k=p.slice(0,i).replace(/\\.\\d+$/,"");ck[k]=(ck[k]||"")+p.slice(i+1)}});'
    + 'const vals=[];for(const k in ck){if(/auth/i.test(k))vals.unshift(ck[k]);else vals.push(ck[k])}'
    + 'for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);const v=localStorage.getItem(k)||"";if(/auth/i.test(k))vals.unshift(v);else vals.push(v)}'
    + 'let t="";for(const v of vals){const m=dec(v).match(/eyJ[\\w-]+\\.eyJ[\\w-]+\\.[\\w-]+/);if(m){t=m[0];break}}'
    + 'if(!t){alert("No JanitorAI login found on this page. Sign in first.");return}'
    + 'const show=()=>prompt("Copy this token, then paste it into SillyTavern:",t);'
    + 'if(navigator.clipboard){navigator.clipboard.writeText(t).then(()=>alert("JanitorAI token copied. Now paste it into SillyTavern."),show)}else{show()}})();';

function showConnect(reason = '') {
    hideViews();
    const { token, expired } = account();
    const connected = token && !expired;
    showMessage(`
        <h3>Connect your JanitorAI account</h3>
        ${reason ? `<p class="jai_bad"><i class="fa-solid fa-circle-info"></i> ${esc(reason)}</p>` : ''}
        ${bridgeVersion ? '<p class="jai_ok">The helper script is installed, so no token is needed — just keep a signed-in JanitorAI tab open.</p>' : ''}
        <p>Without an account JanitorAI only shows the first page of results. Search, more pages, character definitions and lorebooks need your login. JanitorAI's sign-in only works on its own site, so you carry your login over with a token button:</p>
        <h4>One-time: add the token button</h4>
        <ul>
            <li><b>Computer:</b> press <b>Ctrl+Shift+B</b> so the bookmarks bar shows, then drag this onto it: <a class="jai_bookmarklet" href="${esc(BOOKMARKLET)}" title="Drag me to the bookmarks bar">Janitor token</a></li>
            <li><b>Phone (or if dragging fails):</b> ${button('copycode', 'fa-copy', 'Copy button code')} then bookmark any page, edit that bookmark, paste the code as its address and name it <b>jtoken</b>.</li>
        </ul>
        <h4>Each time you connect</h4>
        <ol>
            <li>${button('open', 'fa-up-right-from-square', 'Open JanitorAI')} and make sure you are signed in.</li>
            <li>On that JanitorAI tab press the <b>Janitor token</b> bookmark (phone: type <b>jtoken</b> in the address bar and tap the bookmark). It says "token copied".</li>
            <li>Come back here and press ${button('paste', 'fa-paste', 'Paste & connect')}</li>
        </ol>
        <textarea id="jai_token" class="text_pole" rows="2" spellcheck="false" placeholder="${connected ? 'A token is saved. Paste a new one here to replace it.' : '…or paste the token here yourself'}"></textarea>
        ${actions(button('save', 'fa-plug', 'Connect'), token ? button('disconnect', 'fa-plug-circle-xmark', 'Disconnect') : '', button('resume', 'fa-arrow-left', 'Back'))}
        <p class="jai_note">A JanitorAI login lasts about 3 hours, then steps 2 and 3 are needed again (the status at the top shows the time left). The token is your login: it is saved in your SillyTavern settings and sent only to janitorai.com — never share it with anyone.</p>
        <details>
            <summary>Never copy a token again (computer)</summary>
            <p>With the helper script the extension uses your open JanitorAI tab directly, so nothing expires and nothing is copied:</p>
            <ol>
                <li>Install <a href="https://www.tampermonkey.net/" target="_blank" rel="noopener">Tampermonkey</a>.</li>
                <li>Right-click the Tampermonkey icon → <b>Manage extension</b> → switch on <b>Allow User Scripts</b>. Without this switch Chrome silently blocks the script.</li>
                <li>Install the <a href="${esc(USERSCRIPT_URL)}" target="_blank" rel="noopener">helper script</a>, then reload both SillyTavern and JanitorAI and keep a JanitorAI tab open.</li>
            </ol>
        </details>`);
}

async function pasteToken() {
    let text = '';
    try {
        text = await navigator.clipboard.readText();
    } catch {
        return toastr.warning('The browser did not allow reading the clipboard. Paste the token into the box and press Connect.', 'Janitor Importer');
    }
    if (!extractToken(text)) return toastr.warning('The clipboard does not contain a JanitorAI token. Press the token bookmark on the JanitorAI tab first.', 'Janitor Importer');
    $('#jai_token').value = text;
    await saveToken();
}

async function saveToken() {
    const token = extractToken($('#jai_token').value);
    if (!token) return toastr.warning('That text does not contain a JanitorAI token.', 'Janitor Importer');
    const expiry = tokenExpiry(token);
    if (expiry !== null && expiry < Date.now()) {
        return toastr.warning('That token has already expired. Reload JanitorAI and copy a fresh one.', 'Janitor Importer');
    }

    settings().token = token;
    ctx().saveSettingsDebounced();
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
    toastr.success('JanitorAI account connected.', 'Janitor Importer');
    resume();
}

function disconnect(interactive = true) {
    settings().token = '';
    ctx().saveSettingsDebounced();
    updateStatus();
    if (interactive) {
        toastr.info('JanitorAI token removed.', 'Janitor Importer');
        showConnect();
    }
}

function showError(error) {
    console.warn(TAG, error);
    hideViews();
    updateStatus();

    if (error.code === 'no-tab') {
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
    $('#jai_detail').style.display = view === 'detail' ? '' : 'none';
    root.querySelector('.jai_footer').style.display = view === 'grid' ? '' : 'none';
    if (view !== 'detail') state.detail = null;
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
    } catch (error) {
        console.warn(TAG, 'Could not load tags', error);
    }
}

async function loadList() {
    setView('grid');
    state.loading = true;
    showMessage('<i class="fa-solid fa-spinner fa-spin"></i> Loading…');
    $('#jai_grid').innerHTML = '';
    try {
        const query = new URLSearchParams({ page: state.page, mode: state.mode, sort: state.sort });
        if (state.search) query.set('search', state.search);
        let path = `/hampter/characters?${query}`;
        if (state.tag) path += `&tag_id[]=${encodeURIComponent(state.tag)}`;

        const result = await api(path);
        const items = Array.isArray(result?.data) ? result.data : [];
        state.total = Number(result?.total) || items.length;
        state.size = Number(result?.size) || items.length;

        $('#jai_grid').innerHTML = items.map(renderCard).join('');
        root.querySelector('.jai_body').scrollTop = 0;
        showMessage(items.length ? '' : 'No characters found.');
        loadTags();
    } catch (error) {
        showError(error);
    } finally {
        state.loading = false;
        updateStatus();
        $('#jai_page').textContent = `Page ${state.page}`;
        $('#jai_prev').classList.toggle('disabled', state.page <= 1);
        $('#jai_next').classList.toggle('disabled', !hasNext());
    }
}

function renderCard(item) {
    const tags = (Array.isArray(item.tags) ? item.tags : []).slice(0, 4).map(t => `<span>${esc(t.name)}</span>`).join('');
    const blurb = sanitize(item.description).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
    return `
        <div class="jai_card" data-id="${esc(item.id)}" title="${esc(item.name)}">
            <div class="jai_thumb">
                ${item.avatar ? `<img loading="lazy" referrerpolicy="no-referrer" src="${esc(avatarUrl(item.avatar, 400))}" alt="">` : ''}
                ${item.is_nsfw ? '<span class="jai_badge">NSFW</span>' : ''}
            </div>
            <div class="jai_card_name">${esc(item.name)}</div>
            <div class="jai_card_meta">@${esc(item.creator_name)} · ${compact(item.total_tokens)} tokens · <i class="fa-solid fa-comments"></i> ${compact(item.stats?.chat)}</div>
            <div class="jai_card_blurb">${esc(blurb)}</div>
            <div class="jai_tags">${tags}</div>
        </div>`;
}

async function openDetail(id) {
    setView('detail');
    state.detail = id;
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
    const tokens = detail.token_counts?.total_tokens;
    const tags = [
        ...(Array.isArray(detail.tags) ? detail.tags.map(t => t.name) : []),
        ...(Array.isArray(detail.custom_tags) ? detail.custom_tags.map(t => `#${t}`) : []),
    ].map(t => `<span>${esc(t)}</span>`).join('');

    box.innerHTML = `
        <div class="jai_detail_side">
            ${detail.avatar ? `<img referrerpolicy="no-referrer" src="${esc(avatarUrl(detail.avatar, 600))}" alt="">` : ''}
            <div class="menu_button menu_button_icon jai_import"><i class="fa-solid fa-file-import"></i><span>Import to SillyTavern</span></div>
            ${scripts.shared.length ? '<div class="menu_button menu_button_icon jai_book_only" title="Save only the lorebook as a World Info file, without importing the character"><i class="fa-solid fa-book-atlas"></i><span>Lorebook only</span></div>' : ''}
            <div class="menu_button menu_button_icon jai_back"><i class="fa-solid fa-arrow-left"></i><span>Back to list</span></div>
            <a class="menu_button menu_button_icon" href="${SITE}/characters/${esc(detail.id)}" target="_blank" rel="noopener"><i class="fa-solid fa-up-right-from-square"></i><span>View on JanitorAI</span></a>
            <div class="menu_button menu_button_icon jai_raw" title="Copy the raw data JanitorAI sent for this character (useful for bug reports)"><i class="fa-solid fa-copy"></i><span>Copy raw data</span></div>
        </div>
        <div class="jai_detail_main">
            <h2>${esc(detail.name)}</h2>
            <div class="jai_card_meta">by @${esc(detail.creator_name)}${detail.chat_name ? ` · chat name: ${esc(detail.chat_name)}` : ''} · <i class="fa-solid fa-comments"></i> ${compact(detail.stats?.chat)} chats</div>
            <div class="jai_facts">
                <span class="${defined ? 'jai_ok' : 'jai_bad'}"><i class="fa-solid ${defined ? 'fa-check' : 'fa-lock'}"></i> ${defined ? `Definition available${tokens ? ` (${compact(tokens)} tokens)` : ''}` : (signedIn() ? 'Definition hidden by the creator (greetings only)' : 'Definition needs a connected account')}</span>
                <span class="${scripts.shared.length ? 'jai_ok' : (scripts.private.length ? 'jai_bad' : '')}" title="${esc(scriptNames)}"><i class="fa-solid fa-book-atlas"></i> ${esc(bookFact)}</span>
                ${signedIn() ? '' : '<span class="jai_link" data-jai-connect><i class="fa-solid fa-key"></i> Connect account</span>'}
            </div>
            ${!defined && signedIn() ? `
            <div class="jai_outside">
                <b>Definition hidden on JanitorAI.</b> JannyAI may have its own copy (possibly older). If it does, it can be combined with the greetings, avatar and lorebook from here:
                <div class="jai_actions">
                    <div class="menu_button menu_button_icon jai_janny_auto"><i class="fa-solid fa-wand-magic-sparkles"></i><span>Try to fetch it</span></div>
                    <a class="menu_button menu_button_icon" href="${JANNY}${esc(detail.id)}" target="_blank" rel="noopener"><i class="fa-solid fa-up-right-from-square"></i><span>Open on JannyAI</span></a>
                    <div class="menu_button menu_button_icon jai_janny_file"><i class="fa-solid fa-file-arrow-up"></i><span>Use downloaded card…</span></div>
                </div>
                <input type="file" class="jai_janny_input" accept=".png,.json,image/png,application/json" hidden>
                <div class="jai_note jai_janny_note">If fetching fails: open the JannyAI page, download the card there, then pick that file with "Use downloaded card".</div>
            </div>` : ''}
            <div class="jai_tags">${tags}</div>
            <div class="jai_description">${sanitize(detail.description)}</div>
        </div>`;

    box.querySelectorAll('.jai_description a').forEach((a) => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
    box.querySelectorAll('.jai_description img').forEach((img) => { img.referrerPolicy = 'no-referrer'; img.loading = 'lazy'; });
    box.querySelector('[data-jai-connect]')?.addEventListener('click', () => showConnect());
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
        if (autoButton.classList.contains('disabled')) return;
        autoButton.classList.add('disabled');
        await useOutside(() => fetchJannyCopy(detail.id));
        autoButton.classList.remove('disabled');
    });
    const fileInput = box.querySelector('.jai_janny_input');
    box.querySelector('.jai_janny_file')?.addEventListener('click', () => fileInput.click());
    fileInput?.addEventListener('change', async () => {
        const file = fileInput.files?.[0];
        fileInput.value = '';
        if (file) await useOutside(() => readCardFile(file));
    });

    const bookButton = box.querySelector('.jai_book_only');
    bookButton?.addEventListener('click', async () => {
        if (bookButton.classList.contains('disabled')) return;
        bookButton.classList.add('disabled');
        try {
            await importLorebookOnly(detail);
        } catch (error) {
            console.error(TAG, 'Lorebook import failed', error);
            toastr.error(String(error?.message || error), 'Janitor Importer: lorebook import failed');
        } finally {
            bookButton.classList.remove('disabled');
        }
    });

    const importButton = box.querySelector('.jai_import');
    importButton.addEventListener('click', async () => {
        if (importButton.classList.contains('disabled')) return;
        importButton.classList.add('disabled');
        importButton.querySelector('span').textContent = 'Importing…';
        try {
            if (await importCharacter(outside ? withOutsideDefinition(detail, outside) : detail)) closeBrowser();
        } catch (error) {
            console.error(TAG, 'Import failed', error);
            toastr.error(String(error?.message || error), 'Janitor Importer: import failed');
        } finally {
            importButton.classList.remove('disabled');
            importButton.querySelector('span').textContent = 'Import to SillyTavern';
        }
    });
}

async function openBrowser() {
    if (!root) buildUi();
    root.classList.add('jai_open');
    await detectBridge();
    updateStatus();
    if (!$('#jai_grid').children.length && !state.detail) loadList();
}

function closeBrowser() {
    root?.classList.remove('jai_open');
}

// ---------------------------------------------------------------------------------------------- entry points

function addButtons() {
    const external = document.getElementById('external_import_button');
    if (external && !document.getElementById('jai_open_button')) {
        const button = document.createElement('div');
        button.id = 'jai_open_button';
        button.className = 'menu_button fa-solid fa-broom';
        button.title = 'Browse & import characters from JanitorAI';
        button.addEventListener('click', openBrowser);
        external.insertAdjacentElement('afterend', button);
    }

    const menu = document.getElementById('extensionsMenu');
    if (menu && !document.getElementById('jai_menu_button')) {
        const item = document.createElement('div');
        item.id = 'jai_menu_button';
        item.className = 'list-group-item flex-container flexGap5 interactable';
        item.tabIndex = 0;
        item.innerHTML = '<div class="fa-solid fa-broom extensionsMenuExtensionButton"></div><span>Janitor Importer</span>';
        item.addEventListener('click', openBrowser);
        menu.appendChild(item);
    }
}

jQuery(() => {
    addButtons();
    console.info(TAG, 'loaded');
});
