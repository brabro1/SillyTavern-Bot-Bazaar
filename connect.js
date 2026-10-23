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
export const EXTENSION_VERSION = '5.0.2';

const LAST_KEY = 'botBazaar.lastHandoff';
const ADDRESS_KEY = 'botBazaar.st';

/**
 * The code that runs on janitorai.com / chub.ai / saucepan.ai. It is turned into text (a bookmark) with
 * Function.toString(), so it must stay self-contained and obey the rules of a one-line address:
 *   - no // comments (browsers remove line breaks, so one would comment out everything after it)
 *   - no percent signs (a javascript: address is percent-decoded before it runs)
 * @param {string} ST the address of SillyTavern this bookmark was made from
 * @param {number} BV the bookmark version
 */
async function botBazaarBookmark(ST, BV) {
    /* Keep this function free of // comments and percent signs: see above. */
    const doc = document;
    const CHUB = /(^|\.)(chub\.ai|characterhub\.org)$/.test(location.hostname);
    const JANITOR = /(^|\.)janitorai\.com$/.test(location.hostname);
    const SAUCEPAN = /(^|\.)saucepan\.ai$/.test(location.hostname);
    let sheet = null, lines = null, tray = null, timer = 0, failed = false;

    const make = (tag, style, text) => {
        const e = doc.createElement(tag);
        if (style) e.style.cssText = style;
        if (text) e.textContent = text;
        return e;
    };
    const frame = () => {
        if (sheet && sheet.isConnected) return;
        sheet = make('div', 'position:fixed;z-index:2147483647;left:0;right:0;bottom:0;box-sizing:border-box;max-height:80vh;overflow:auto;padding:14px 16px 24px;background:#1b1820;color:#fff;font:15px/1.45 system-ui,-apple-system,sans-serif;border-top:3px solid #ff6a3d;box-shadow:0 -10px 30px rgba(0,0,0,.55);text-align:left');
        lines = make('div', 'color:#ddd;margin:4px 0 12px;word-break:break-word;white-space:pre-wrap');
        tray = make('div', 'display:flex;flex-wrap:wrap;gap:8px');
        sheet.appendChild(make('div', 'font-weight:700;font-size:16px', 'Bot Bazaar'));
        sheet.appendChild(lines);
        sheet.appendChild(tray);
        (doc.body || doc.documentElement).appendChild(sheet);
    };
    const say = (text, bad) => {
        try {
            frame();
            lines.textContent = text;
            lines.style.color = bad ? '#ff8a80' : '#ddd';
        } catch (e) { /* no page to draw on */ }
    };
    /* Real buttons, never links: some sites (Saucepan) catch taps on links that leave them and show a warning instead. */
    const button = (label, onTap, quiet) => {
        const b = make('button', 'flex:1 1 150px;min-height:48px;padding:0 14px;box-sizing:border-box;border:0;border-radius:12px;color:#fff;font:700 15px/48px system-ui,sans-serif;text-align:center;cursor:pointer;background:' + (quiet ? '#44404c' : '#ff6a3d'), label);
        b.addEventListener('click', (ev) => {
            ev.stopPropagation();
            clearTimeout(timer);
            if (onTap) onTap(ev);
        });
        tray.appendChild(b);
        return b;
    };
    const closeSheet = () => { clearTimeout(timer); if (sheet) sheet.remove(); sheet = null; };
    const fail = (message) => {
        failed = true;
        say(message, true);
        tray.textContent = '';
        const details = ['Bot Bazaar bookmark ' + BV, location.href.split('?')[0], 'SillyTavern address: ' + ST, navigator.userAgent, message].join('\n');
        button('Copy details', () => { try { navigator.clipboard.writeText(details); } catch (e) { /* nothing more to try */ } }, true);
        button('Close', closeSheet, true);
    };

    const run = async () => {
        if (!CHUB && !JANITOR && !SAUCEPAN) {
            say('Open janitorai.com, chub.ai or saucepan.ai (signed in) first, then run this again.', true);
            button('Close', closeSheet, true);
            return;
        }
        let payload;
        if (SAUCEPAN) {
            const key = localStorage.getItem('hallucination/auth_token') || '';
            if (!key) return fail('No Saucepan login found on this page. Sign in to saucepan.ai first, then run this again.');
            say('Connecting to your Saucepan login…');
            const H = { Authorization: 'Bearer ' + key, 'cf-edge-token-8af3': 'e3b0c44298fc1c14' };
            const call = async (path, body) => {
                try {
                    const r = await fetch(path, body ? { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, H), body: JSON.stringify(body) } : { headers: H });
                    const d = await r.json().catch(() => null);
                    return { status: r.status, data: d };
                } catch (e) { return { status: 0, data: null }; }
            };
            const sauce = {};
            const me = await call('/api/v1/users/me');
            const u = me.data && (me.data.user || me.data);
            if (u && u.id) sauce.me = { id: u.id, handle: u.handle, is_verified: u.is_verified };
            const page = location.pathname.match(/\/(companion|lorebook)\/([0-9a-f-]{36})/i);
            const wait = ms => new Promise(r => setTimeout(r, ms));
            /* Saucepan sends definitions to other apps only scrambled, but shows them on this page to you. So, like you */
            /* would by hand, open the page's own "Definition → Show" and "View scenarios", and read what it displays. */
            const reveal = async (trigger) => {
                const added = [];
                const mo = new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(x => { if (x.nodeType === 1) added.push(x); })));
                mo.observe(doc.body, { childList: true, subtree: true });
                trigger.click();
                for (let i = 0; i < 20 && !added.some(x => x.innerText && x.innerText.length > 40); i++) await wait(150);
                await wait(300);
                mo.disconnect();
                const top = added.filter(x => x.isConnected && !added.some(o => o !== x && o.contains(x)));
                return top.sort((a, b) => b.innerText.length - a.innerText.length)[0] || null;
            };
            const readPage = async () => {
                const out = {};
                const findLabel = () => [].slice.call(doc.querySelectorAll('body *')).find(e => [].slice.call(e.childNodes).some(n => n.nodeType === 3 && /^\s*Definition:?\s*$/.test(n.textContent)));
                let label = findLabel();
                for (let i = 0; i < 40 && !label; i++) { await wait(200); label = findLabel(); }
                let btn = null;
                for (let n = label, i = 0; n && i < 5 && !btn; i++) {
                    n = n.parentElement;
                    btn = n && [].slice.call(n.querySelectorAll('button')).find(b => /^(show|hide)$/i.test(b.innerText.trim()));
                }
                if (btn) {
                    if (/hide/i.test(btn.innerText)) { btn.click(); await wait(500); }
                    const box = await reveal(btn);
                    if (box) out.definition = box.innerText;
                    btn.click();
                }
                const scen = [].slice.call(doc.querySelectorAll('button')).find(b => /^view .*scenarios?$/i.test(b.innerText.trim()));
                if (scen) {
                    const dialog = await reveal(scen);
                    const list = [];
                    let persona = '';
                    for (let i = 0; dialog && i < 30; i++) {
                        const text = dialog.innerText;
                        const m = text.match(/Scenario (\d+) of (\d+)\n/);
                        if (!m) break;
                        const rows = text.split('\n');
                        const end = text.indexOf('\nPrev\n', m.index);
                        const msg = text.slice(m.index + m[0].length, end > 0 ? end : undefined).trim();
                        const head = text.slice(0, m.index).split('\n').filter(l => l.trim() && !/can be edited/i.test(l));
                        const pi = rows.lastIndexOf('Start Chat');
                        if (pi > 0) persona = rows[pi - 1].trim();
                        list.push({ title: head[head.length - 1] || '', message: msg });
                        if (Number(m[1]) >= Number(m[2])) break;
                        const next = [].slice.call(dialog.querySelectorAll('button')).find(b => b.innerText.trim() === 'Next');
                        if (!next) break;
                        next.click();
                        for (let k = 0; k < 20 && dialog.innerText.indexOf('Scenario ' + (Number(m[1]) + 1) + ' of') < 0; k++) await wait(100);
                    }
                    out.scenarios = list;
                    out.persona = persona;
                    doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                }
                return out;
            };
            if (page && page[1].toLowerCase() === 'companion') {
                say('Reading this character from the page…');
                let shown = {};
                try { shown = await readPage(); } catch (e) { /* the page didn't show it; the rest still comes */ }
                say('Getting this character…');
                const id = page[2];
                const c = await call('/api/v2/companions/' + id);
                if (c.data && c.data.companion) { delete c.data.companion.full_description_fragments; delete c.data.companion.starting_scenarios_fragments; }
                const d = await call('/api/v1/companion/definition?companion_id=' + id);
                const l = await call('/api/v2/companions/' + id + '/lorebooks');
                const books = [];
                for (const b of (l.data && l.data.lorebooks) || []) {
                    const r = await call('/api/v1/lorebooks/' + b.id);
                    books.push({ meta: b, status: r.status, data: r.status === 200 ? r.data : null });
                }
                const titles = d.data && Array.isArray(d.data.sections) ? d.data.sections.map(s => s && s.title).filter(Boolean) : [];
                sauce.companion = { data: c.data, definition: { status: d.status, data: null, titles: titles, message: d.data && d.data.error ? d.data.error.message : '' }, shown: shown, books: books, booksStatus: l.status };
            } else if (page) {
                say('Getting this lorebook…');
                const r = await call('/api/v1/lorebooks/' + page[2]);
                sauce.lorebook = { id: page[2], status: r.status, data: r.status === 200 ? r.data : null };
            }
            if (sauce.me) {
                say('Getting your favorites…');
                const favs = [];
                let ok = true;
                const pages = [['/api/v1/search', 'companions', 'character', { special_view: { view: 'favorites' } }], ['/api/v1/search/favorited-lorebooks', 'lorebooks', 'lorebook', {}]];
                for (const [path, field, kind, extra] of pages) {
                    for (let o = 0; o < 960; o += 24) {
                        const r = await call(path, Object.assign({ order_by: 'favorited_at', asc: false, offset: o, limit: 24, sus: true }, extra));
                        const list = r.data && r.data[field];
                        if (r.status !== 200 || !Array.isArray(list)) { if (kind === 'character') ok = false; break; }
                        list.forEach(x => favs.push({ id: x.id, kind: kind, name: x.display_name || x.name, image: kind === 'character' ? (x.image && x.image.id) : x.image_id, creator: x.author_handle || x.owner_handle, creatorId: x.author_id || x.owner_id }));
                        if (list.length < 24) break;
                    }
                }
                if (ok) sauce.favorites = favs;
            }
            payload = { v: 1, bv: BV, saucepan: key, sauce: sauce };
        } else if (CHUB) {
            say('Reading your Chub login…');
            let key = localStorage.getItem('URQL_TOKEN') || '';
            try { const parsed = JSON.parse(key); if (typeof parsed === 'string') key = parsed; } catch (e) { /* already plain */ }
            if (!key) return fail('No Chub login found on this page. Sign in to chub.ai first, then run this again.');
            payload = { v: 1, bv: BV, chub: key };
        } else {
            say('Reading your JanitorAI login…');
            const decode = (s) => {
                try { s = decodeURIComponent(s); } catch (e) { /* already decoded */ }
                const m = s.match(/base64-([\w+/=-]+)/);
                if (m) { try { return atob(m[1].replace(/-/g, '+').replace(/_/g, '/')); } catch (e) { /* not base64 */ } }
                return s;
            };
            const cookies = {};
            doc.cookie.split(';').map(p => p.trim()).forEach((p) => { const i = p.indexOf('='); if (i > 0) cookies[p.slice(0, i)] = p.slice(i + 1); });
            const groups = {};
            Object.keys(cookies).filter(k => /auth-token/i.test(k)).sort().forEach((k) => { const base = k.replace(/\.\d+$/, ''); groups[base] = (groups[base] || '') + cookies[k]; });
            const candidates = Object.values(groups);
            for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (/auth-token|^sb-/i.test(k)) candidates.push(localStorage.getItem(k)); }
            let session = null;
            for (const raw of candidates) { try { const o = JSON.parse(decode(raw)); if (o && o.access_token && o.refresh_token) { session = o; break; } } catch (e) { /* skip */ } }
            if (!session) return fail('No JanitorAI login found on this page. Sign in to janitorai.com first (open the site itself, not the app), then run this again.');
            let apikey = '';
            try {
                const src = [].slice.call(doc.querySelectorAll('script[src]')).map(s => s.src).filter(s => /index-.*\.js/.test(s))[0];
                const txt = await (await fetch(src)).text();
                const jwts = txt.match(/eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/g) || [];
                apikey = jwts.filter((j) => { try { return JSON.parse(atob(j.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).role === 'anon'; } catch (e) { return false; } })[0] || '';
            } catch (e) { /* no renewal key; the login still works until it expires */ }
            payload = { v: 1, bv: BV, janitor: { access_token: session.access_token, refresh_token: session.refresh_token, expires_at: session.expires_at, apikey: apikey } };
        }

        say('Packing it…');
        const json = JSON.stringify(payload);
        let data;
        if (window.CompressionStream) {
            const buf = new Uint8Array(await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
            let bin = '';
            for (let i = 0; i < buf.length; i += 32768) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 32768));
            data = 'z.' + btoa(bin);
        } else {
            data = btoa(unescape(encodeURIComponent(json)));
        }

        let target = ST;
        try { target = localStorage.getItem('botBazaar.st') || ST; } catch (e) { /* storage unavailable */ }
        const code = 'bazaar:' + data;
        const where = () => target.replace(/^https?:[/][/]/, '');
        const link = () => target + '/#botbazaar=' + encodeURIComponent(data);
        const showReady = () => {
            tray.textContent = '';
            say('Done. Opening SillyTavern at ' + where() + ' …\nIf that is not the right address, tap Change address.');
            button('Open SillyTavern', () => { location.href = link(); });
            button('Copy code', copyCode, true);
            button('Change address', changeAddress, true);
            button('Close', closeSheet, true);
            timer = setTimeout(() => { location.href = link(); }, 2500);
        };
        const copyCode = async () => {
            try {
                await navigator.clipboard.writeText(code);
                say('Code copied. In SillyTavern open Bot Bazaar → Accounts and paste it into the box.');
                return;
            } catch (e) { /* try the older way */ }
            const box = make('textarea', 'width:100vw;max-width:100vw;box-sizing:border-box;height:90px;margin-top:10px;font:12px monospace');
            box.value = code;
            sheet.appendChild(box);
            box.focus();
            box.select();
            let copied = false;
            try { copied = doc.execCommand('copy'); } catch (e) { /* not allowed here */ }
            say(copied ? 'Code copied. In SillyTavern open Bot Bazaar → Accounts and paste it into the box.' : 'Select all of the text below and copy it, then paste it in Bot Bazaar → Accounts.');
        };
        const changeAddress = () => {
            tray.textContent = '';
            say('Type the address you use for SillyTavern on this device, for example  http://192.168.1.20:8000');
            const input = make('input', 'flex:1 1 100vw;min-height:48px;box-sizing:border-box;padding:0 12px;border-radius:12px;border:1px solid #777;background:#fff;color:#000;font:16px system-ui,sans-serif');
            input.value = target;
            input.setAttribute('autocapitalize', 'none');
            input.setAttribute('autocorrect', 'off');
            input.setAttribute('inputmode', 'url');
            tray.appendChild(input);
            button('Save and open', () => {
                let v = input.value.trim().replace(/[/]+$/, '');
                if (v && !/^https?:[/][/]/i.test(v)) v = 'http://' + v;
                target = v || ST;
                try { localStorage.setItem('botBazaar.st', target); } catch (e) { /* storage unavailable */ }
                showReady();
                location.href = link();
            });
        };
        showReady();
    };
    try {
        await run();
    } catch (e) {
        if (!failed) fail('Something went wrong: ' + ((e && e.message) || e));
    }
}

/**
 * The text of the bookmark.
 * @param {string} origin the SillyTavern address it should open
 * @param {{bare?: boolean}} [options] bare = without the "javascript:" prefix, for typing into the address bar yourself
 *   (Chrome on phones removes that prefix from pasted text)
 */
export function buildBookmarklet(origin, { bare = false } = {}) {
    const code = botBazaarBookmark.toString();
    const flat = code.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ');
    if (/(^|\n)\s*\/\/|[;{}]\s+\/\/ /.test(code) || code.includes('%')) console.error('[Bot Bazaar]', 'The bookmark code contains a // comment or a percent sign and would break.');
    return `${bare ? '' : 'javascript:'}(${flat})(${JSON.stringify(origin)},${BOOKMARK_VERSION});void 0`;
}

// ---------------------------------------------------------------------------------------------- the packet

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
