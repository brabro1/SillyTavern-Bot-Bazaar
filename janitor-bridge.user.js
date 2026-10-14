// ==UserScript==
// @name         Janitor Importer bridge for SillyTavern
// @namespace    sillytavern-janitor-importer
// @version      1.1.0
// @description  Lets the SillyTavern "Janitor Importer" extension browse JanitorAI through your own logged-in JanitorAI tab.
// @match        https://janitorai.com/*
// @include      http://127.0.0.1:*/*
// @include      http://localhost:*/*
// @include      http://127.0.0.1/*
// @include      http://localhost/*
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      janitorai.com
// @run-at       document-start
// @noframes
// ==/UserScript==

/*
 * How it works
 *
 *  SillyTavern page  <-- window.postMessage -->  this script (SillyTavern side)
 *                                                     |  GM storage change events (cross-tab)
 *                                                this script (JanitorAI side)  -- same-origin fetch --> janitorai.com API
 *
 * The JanitorAI side only performs read-only GET requests to the character/tag/script API, using the
 * session of the JanitorAI tab you are logged in to. Your login token never leaves that tab.
 */

(function () {
    'use strict';

    const VERSION = '1.1.0';
    const TAG = '[Janitor Importer bridge]';
    const REQ = 'jai_req';
    const ACK = 'jai_ack';
    const RES = 'jai_res';
    const API_PATH = /^\/hampter\/(characters|tags|script)([/?]|$)/;
    const IMAGE_HOST = /^https:\/\/([a-z0-9-]+\.)*janitorai\.com\//i;

    if (location.hostname === 'janitorai.com') {
        janitorSide();
    } else {
        tavernSide();
    }

    // ------------------------------------------------------------------ SillyTavern side

    function tavernSide() {
        const waiting = new Map(); // bus id -> { onAck, onRes }

        GM_addValueChangeListener(ACK, (_name, _old, value) => waiting.get(value?.id)?.onAck());
        GM_addValueChangeListener(RES, (_name, _old, value) => waiting.get(value?.id)?.onRes(value));

        const reply = (id, data) => window.postMessage({ source: 'jai-bridge', id, ...data }, location.origin);
        const isTavern = () => !!document.getElementById('sheld');

        function relayApi(path) {
            return new Promise((resolve) => {
                const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
                let acked = false;
                const finish = (result) => {
                    clearTimeout(ackTimer);
                    clearTimeout(resTimer);
                    waiting.delete(id);
                    resolve(result);
                };
                const ackTimer = setTimeout(() => !acked && finish({ ok: false, code: 'no-tab', error: 'No JanitorAI tab answered.' }), 4000);
                const resTimer = setTimeout(() => finish({ ok: false, code: 'timeout', error: 'JanitorAI did not answer in time.' }), 60000);
                waiting.set(id, {
                    onAck: () => { acked = true; },
                    onRes: (value) => finish({ ok: true, status: value.status, body: value.body, authed: value.authed, error: value.error }),
                });
                GM_setValue(REQ, { id, path, t: Date.now() });
            });
        }

        function fetchImage(url) {
            return new Promise((resolve) => {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url,
                    responseType: 'arraybuffer',
                    timeout: 45000,
                    onload: (r) => {
                        if (r.status >= 200 && r.status < 300 && r.response) {
                            const type = /content-type:\s*([^\r\n;]+)/i.exec(r.responseHeaders || '')?.[1] || '';
                            resolve({ ok: true, buffer: r.response, type });
                        } else {
                            resolve({ ok: false, error: `Image request failed (${r.status})` });
                        }
                    },
                    onerror: () => resolve({ ok: false, error: 'Image request failed' }),
                    ontimeout: () => resolve({ ok: false, error: 'Image request timed out' }),
                });
            });
        }

        window.addEventListener('message', async (event) => {
            const msg = event.data;
            if (event.source !== window || event.origin !== location.origin || msg?.source !== 'jai-ext') return;
            if (!isTavern()) return;

            if (msg.op === 'hello') {
                reply(msg.id, { ok: true, event: 'hello', version: VERSION });
            } else if (msg.op === 'api') {
                if (typeof msg.path !== 'string' || !API_PATH.test(msg.path)) {
                    return reply(msg.id, { ok: false, error: 'Path not allowed' });
                }
                reply(msg.id, await relayApi(msg.path));
            } else if (msg.op === 'image') {
                if (typeof msg.url !== 'string' || !IMAGE_HOST.test(msg.url)) {
                    return reply(msg.id, { ok: false, error: 'Image URL not allowed' });
                }
                reply(msg.id, await fetchImage(msg.url));
            }
        });

        // Announce ourselves in case the extension loaded first.
        const announce = () => isTavern() && window.postMessage({ source: 'jai-bridge', event: 'hello', version: VERSION }, location.origin);
        window.addEventListener('DOMContentLoaded', announce);
        window.addEventListener('load', announce);
    }

    // ------------------------------------------------------------------ JanitorAI side

    function janitorSide() {
        const page = unsafeWindow;
        const pageFetch = page.fetch.bind(page);
        const sniffed = {}; // headers the JanitorAI app itself sends to its API

        const keep = (name) => /^(authorization|x-[a-z0-9-]+)$/i.test(name);
        const remember = (name, value) => {
            if (typeof name === 'string' && typeof value === 'string' && keep(name)) sniffed[name.toLowerCase()] = value;
        };
        const rememberAll = (headers) => {
            if (!headers) return;
            if (typeof headers.forEach === 'function' && !Array.isArray(headers)) {
                headers.forEach((value, name) => remember(name, value));
            } else if (Array.isArray(headers)) {
                headers.forEach(([name, value]) => remember(name, value));
            } else {
                Object.entries(headers).forEach(([name, value]) => remember(name, value));
            }
        };
        const isApi = (url) => typeof url === 'string' && url.includes('/hampter/');

        try {
            page.fetch = function (input, init) {
                try {
                    const url = typeof input === 'string' ? input : (input?.url || String(input));
                    if (isApi(url)) {
                        if (input && typeof input === 'object' && input.headers) rememberAll(input.headers);
                        rememberAll(init?.headers);
                    }
                } catch { /* never break the site */ }
                return pageFetch(input, init);
            };

            const xhr = page.XMLHttpRequest.prototype;
            const open = xhr.open;
            const setHeader = xhr.setRequestHeader;
            xhr.open = function (method, url) {
                this.__jaiApi = isApi(String(url));
                return open.apply(this, arguments);
            };
            xhr.setRequestHeader = function (name, value) {
                try { if (this.__jaiApi) remember(name, String(value)); } catch { /* ignore */ }
                return setHeader.apply(this, arguments);
            };
        } catch (error) {
            console.warn(TAG, 'Could not hook the page requests', error);
        }

        /** Looks for the Supabase session the site keeps in cookies / localStorage. */
        function storedToken() {
            const candidates = [];
            try {
                const cookies = {};
                document.cookie.split(';').forEach((part) => {
                    const i = part.indexOf('=');
                    if (i > 0) cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1));
                });
                const groups = {};
                Object.keys(cookies).filter(k => /auth-token/i.test(k)).sort().forEach((key) => {
                    const base = key.replace(/\.\d+$/, '');
                    groups[base] = (groups[base] || '') + cookies[key];
                });
                candidates.push(...Object.values(groups));
            } catch { /* ignore */ }
            try {
                for (let i = 0; i < localStorage.length; i++) {
                    const key = localStorage.key(i);
                    if (/auth-token|^sb-/i.test(key)) candidates.push(localStorage.getItem(key));
                }
            } catch { /* ignore */ }

            for (let raw of candidates) {
                try {
                    if (!raw) continue;
                    if (raw.startsWith('base64-')) {
                        const b64 = raw.slice(7).replace(/-/g, '+').replace(/_/g, '/');
                        raw = new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
                    }
                    const parsed = JSON.parse(raw);
                    const token = parsed?.access_token || parsed?.currentSession?.access_token || (Array.isArray(parsed) ? parsed[0] : null);
                    if (typeof token === 'string' && token.split('.').length === 3 && !expired(token)) return token;
                } catch { /* try the next one */ }
            }
            return null;
        }

        function expired(jwt) {
            try {
                const payload = JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
                return typeof payload.exp === 'number' && payload.exp * 1000 < Date.now() + 5000;
            } catch {
                return false;
            }
        }

        function requestHeaders() {
            const headers = { accept: 'application/json', ...sniffed };
            const token = storedToken();
            if (token) headers.authorization = `Bearer ${token}`;
            return headers;
        }

        // Only one JanitorAI tab should answer, even when several are open.
        let isWorker = !navigator.locks;
        navigator.locks?.request('jai-bridge-worker', () => {
            isWorker = true;
            return new Promise(() => { });
        });

        GM_addValueChangeListener(REQ, async (_name, _old, req) => {
            if (!isWorker || !req?.id || typeof req.path !== 'string') return;
            if (!API_PATH.test(req.path) || Date.now() - req.t > 15000) return;

            GM_setValue(ACK, { id: req.id });
            try {
                const headers = requestHeaders();
                const response = await pageFetch(req.path, { method: 'GET', headers, credentials: 'include' });
                const body = await response.text();
                GM_setValue(RES, { id: req.id, status: response.status, body, authed: !!headers.authorization });
            } catch (error) {
                GM_setValue(RES, { id: req.id, status: 0, body: '', error: String(error?.message || error) });
            }
        });

        // Small, short-lived hint so it's obvious the bridge is running in this tab.
        window.addEventListener('DOMContentLoaded', () => {
            const pill = document.createElement('div');
            pill.textContent = 'SillyTavern bridge active';
            pill.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483647;padding:6px 10px;border-radius:999px;'
                + 'background:rgba(20,20,28,.9);color:#fff;font:12px system-ui,sans-serif;pointer-events:none;transition:opacity .6s;';
            document.body.appendChild(pill);
            setTimeout(() => { pill.style.opacity = '0'; }, 3500);
            setTimeout(() => pill.remove(), 4500);
        });
        console.info(TAG, 'ready, version', VERSION);
    }
})();
