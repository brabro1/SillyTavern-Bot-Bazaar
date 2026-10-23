# Bot Bazaar

An all-in-one SillyTavern extension to browse **JanitorAI**, **Chub** and **Saucepan** and import characters —
definition, greetings, tags, avatar **and their lorebooks** — or lorebooks on their own, without
leaving SillyTavern. Works on desktop and on phones.

## Install

In SillyTavern open **Extensions → Install extension** and paste:

```
https://github.com/brabro1/SillyTavern-Bot-Bazaar
```

## Use

Open it with the store button next to "Import content from external URL" in the character panel
(or **Bot Bazaar** in the Extensions wand menu), then pick **JanitorAI**, **Chub** or **Saucepan** at the top.

- Browse by Trending / Popular / Latest (Chub also has Top rated, Newest, Updated), search,
  switch between All and Limited only, and page through results.
- Click a creator's **@name** to see their profile and everything they published; click any tag to filter by it.
- Open a card for the full page: stats, created/updated dates, token counts and the creator's own
  (coloured) description.
- **Import to SillyTavern** creates the character. Its lorebooks become one World Info file that is
  linked to the character.
- **Lorebook only** saves just the lorebook — handy when you already have the card from elsewhere.
- On Chub and Saucepan you can also browse **Lorebooks** and import them directly.
- Each site has its own look: JanitorAI's purple cards, a navy Chub theme with wide cards and the
  character's portrait blurred behind its page, and a warm tomato-red Saucepan theme with tall portrait cards.
- Character pages show the creator's description with their own colours, fonts and styling, a
  **Lorebooks** panel (name, kind — lorebook, linked, embedded or code script — and whether it can be
  imported), a preview of the definition, and the **comments** with replies.
- **Click a character's picture** to open it full screen and zoom: the + / − buttons, the mouse wheel, pinch with
  two fingers, double-click/double-tap, and drag to move around. `Esc` closes it.
- **Back** returns to the list exactly where you left it (same scroll position, same page of results, same card
  focused). A sticky **Back** bar stays at the top of every character page, `Esc` / `Backspace` / `Alt+←` and your
  phone's own back button or swipe all go back inside Bot Bazaar, and every button, tab and card can be reached
  with the keyboard (`Tab`, `Enter`).
- Paste a `janitorai.com/characters/…`, `janitorai.com/profiles/…`, `chub.ai/characters/…`,
  `chub.ai/lorebooks/…`, `saucepan.ai/companion/…`, `saucepan.ai/lorebook/…` or `saucepan.ai/u/…` link into
  the search box to jump straight to it.

## Favorites and Library

- **Favorites** collects bots from every site on one gold poster wall. Press the ☆ star on any card or
  character page. With your accounts connected, the favorites you set **on JanitorAI, Chub and Saucepan appear here
  by themselves** (checked whenever you open the tab and every few minutes while it's open), and ones you
  un-favorite on the site disappear. Stored on your SillyTavern server, so every device sees the same list.
- **Library** lists every character you imported with Bot Bazaar: chat with it, jump back to its page,
  or delete it (optionally together with its lorebook).

## Chub

Browsing needs nothing — Chub's API is public. Linked lorebooks are merged with the card's own lorebook.

## Saucepan

Saucepan works like the other sites — browse, search, tags, creators, comments, favorites and import — once
SillyTavern's built-in proxy is on (Saucepan only answers its own website, so SillyTavern has to ask on your
behalf). Switch it on once: in `config.yaml` set `enableCorsProxy: true` and restart SillyTavern. The Saucepan tab
has copy-paste commands for it (Windows, Android/Termux, Linux, Mac).

- Connect your account with the same Bot Bazaar bookmark (on saucepan.ai). Your email must be verified on
  Saucepan for lorebooks.
- **Imported:** picture, name, short description, tags, creator, and every lorebook the creator made open
  (entry titles become the trigger words).
- **Definitions and greetings:** Saucepan only shows definitions on its own page (other apps get a scrambled
  copy). So on a bot's page, press the **Bot Bazaar bookmark**: it opens the page's own *Definition → Show* and
  *View scenarios*, reads what Saucepan shows you there, and comes back to Bot Bazaar with the definition, every
  greeting (your persona name turned back into `{{user}}`) and the lorebooks — tap **Import**. While browsing in
  Bot Bazaar, **Get definition from Saucepan** opens that page for you. Hidden definitions stay hidden.

Without the proxy, Saucepan still works through the bookmark: press it on a bot's Saucepan page and you land back
in Bot Bazaar on that bot, ready to import (it also brings your favorites). Pasted Saucepan links show the bot's
page and comments too.

## Connecting your accounts

JanitorAI, Chub and Saucepan only accept sign-ins on their own pages (JanitorAI even asks for a captcha that only works
on janitorai.com), so Bot Bazaar borrows the login your browser already has, with **one bookmark**:

1. One-time: in **Accounts → Set up the bookmark**, add the **Bot Bazaar** bookmark (computer: drag it to the bookmarks
   bar; phone: **Copy bookmark code**, make a bookmark named `bazaar` with that code as its address).
   No bookmark? **Copy code for the address bar**, then on the site type `javascript:` and paste.
2. Open JanitorAI, Chub or Saucepan (signed in) and run it.
3. A **sheet appears at the bottom of the page** and shows what it is doing. When it says *Done*, it opens
   SillyTavern by itself, or you tap **Open SillyTavern**. The sheet also has **Copy code** (then paste into
   Accounts → *Have a code?*, which works in every browser) and **Change address** (if the bookmark was made on another
   device, fix the SillyTavern address right there). Any failure is written out in red with a **Copy details** button.

**If it doesn't work on a phone:** open **Accounts → Check this device**. It lists what the browser can do, the
SillyTavern address the bookmark will use, and what the last hand-over did (or that none arrived).
Android Chrome only runs a `javascript:` bookmark from the address bar (type `bazaar`, tap the bookmark in the
suggestions), not from the bookmarks list, and the bookmark must be made on the phone itself.

The login is handed over inside the page URL's `#` fragment, which browsers never send to any server, and is
cleared from the address bar immediately. (If you ever need it, the Account panel still has a manual paste box.)

**JanitorAI now stays logged in.** The bookmark also captures the refresh part of your JanitorAI session, so
Bot Bazaar renews the login in the background the same way janitorai.com does. You connect once and stay
connected — no more reconnecting every few hours. (If you sign out of JanitorAI in your browser, or it's been
untouched for a long time, just press the bookmark again.) Keeping janitorai.com open in the same browser can
cancel Bot Bazaar's copy of the login, because the website renews it too. To avoid that, sign in to JanitorAI in a
private/incognito window, press the bookmark there, and close the window without logging out.

- **Chub** only needs connecting for your Chub favorites; browsing never needs it.
- **Saucepan** stays connected once connected; on a bot's page the same bookmark also brings that bot over.

Desktop alternative for JanitorAI with nothing to press: install [Tampermonkey](https://www.tampermonkey.net/),
switch on **Allow User Scripts** for it, and install `janitor-bridge.user.js` from this repository.

Your logins are stored in your SillyTavern settings and this browser, and only sent to janitorai.com, chub.ai and
saucepan.ai (Saucepan's through your own SillyTavern server's proxy) —
never share them, and remember they're inside settings backups.

## Hidden definitions, private lorebooks and JannyAI

JanitorAI creators can hide a character's definition and keep lorebook contents private.
JanitorAI does not send those, and this extension does not (and will not) try to get around that.
Such characters import with their public parts: name, avatar, description, tags and greetings.

When a definition is hidden, the character page offers to use **JannyAI's copy** of the card instead
(JannyAI is a separate site that publishes its own, possibly older, copies):

- **Try to fetch it** asks your SillyTavern server to download the copy. JannyAI's bot protection
  often blocks this.
- Otherwise press **Open on JannyAI**, download the card there yourself, and hand the file to the
  extension with **Use downloaded card**.

The extension then imports one character: definition from the JannyAI copy, everything else from JanitorAI.

JanitorAI "advanced" (code) scripts cannot be converted and are skipped.

Saucepan creators can hide definitions and lorebook contents too; Bot Bazaar only imports what Saucepan sends to
your own account, and imports hidden characters with their public parts (name, picture, short description, tags).

---

This project is not affiliated with JanitorAI, Chub, Saucepan, JannyAI or SillyTavern. Respect creators' work.

## License

MIT
