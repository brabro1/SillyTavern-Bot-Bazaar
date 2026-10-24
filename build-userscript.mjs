// Builds bot-bazaar.user.js from bookmark.js, so the bookmark and the userscript can never drift apart.
// Run after changing bookmark.js:  node build-userscript.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const here = new URL('.', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', here), 'utf8'));
const bookmark = readFileSync(new URL('bookmark.js', here), 'utf8');
const bookmarkVersion = Number(readFileSync(new URL('connect.js', here), 'utf8').match(/BOOKMARK_VERSION = (\d+)/)[1]);

const script = `// ==UserScript==
// @name         Bot Bazaar: send to SillyTavern
// @namespace    https://github.com/brabro1/SillyTavern-Bot-Bazaar
// @version      ${manifest.version}
// @description  Adds a "Bot Bazaar" button to Saucepan, Chub and JanitorAI pages. It does what the Bot Bazaar bookmark does (reads your login and, on Saucepan, the bot's definition and greetings from the page) and hands it to SillyTavern. No bookmark needed.
// @match        https://saucepan.ai/*
// @match        https://*.saucepan.ai/*
// @match        https://chub.ai/*
// @match        https://*.chub.ai/*
// @match        https://janitorai.com/*
// @match        https://*.janitorai.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    if (window.top !== window.self || document.getElementById('bot-bazaar-userscript')) return;

${bookmark}
    var KEY = 'botBazaar.st';
    var busy = false;

    function address() {
        var saved = '';
        try { saved = localStorage.getItem(KEY) || ''; } catch (e) { /* storage unavailable */ }
        if (saved) return saved;
        var typed = prompt('Bot Bazaar: the address you open SillyTavern at on this device', 'http://127.0.0.1:8000');
        if (!typed) return '';
        typed = typed.trim().replace(/[/]+$/, '');
        if (!/^https?:[/][/]/i.test(typed)) typed = 'http://' + typed;
        try { localStorage.setItem(KEY, typed); } catch (e) { /* storage unavailable */ }
        return typed;
    }

    var button = document.createElement('button');
    button.id = 'bot-bazaar-userscript';
    button.type = 'button';
    button.textContent = 'Bot Bazaar';
    button.title = 'Send this to SillyTavern (long-press to change the SillyTavern address)';
    button.style.cssText = 'position:fixed;z-index:2147483646;right:12px;bottom:90px;min-height:44px;padding:0 16px;border:0;border-radius:22px;background:#ff6a3d;color:#fff;font:700 14px system-ui,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.45);opacity:.92';
    button.addEventListener('click', function () {
        if (busy) return;
        var st = address();
        if (!st) return;
        busy = true;
        window.botBazaarBookmark(st, ${bookmarkVersion}).then(function () { busy = false; }, function () { busy = false; });
    });
    var pressTimer = 0;
    button.addEventListener('touchstart', function () {
        pressTimer = setTimeout(function () { try { localStorage.removeItem(KEY); } catch (e) { /* storage unavailable */ } address(); }, 900);
    }, { passive: true });
    ['touchend', 'touchmove', 'touchcancel'].forEach(function (name) { button.addEventListener(name, function () { clearTimeout(pressTimer); }, { passive: true }); });
    (document.body || document.documentElement).appendChild(button);
})();
`;

writeFileSync(new URL('bot-bazaar.user.js', here), script);
console.log(`bot-bazaar.user.js written (${script.length} characters, version ${manifest.version}, bookmark ${bookmarkVersion})`);
