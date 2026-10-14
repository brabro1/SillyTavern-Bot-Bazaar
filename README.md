# Bot Bazaar

An all-in-one SillyTavern extension to browse **JanitorAI** and **Chub** and import characters —
definition, greetings, tags, avatar **and their lorebooks** — or lorebooks on their own, without
leaving SillyTavern. Works on desktop and on phones.

## Install

In SillyTavern open **Extensions → Install extension** and paste:

```
https://github.com/brabro1/SillyTavern-Bot-Bazaar
```

## Use

Open it with the store button next to "Import content from external URL" in the character panel
(or **Bot Bazaar** in the Extensions wand menu), then pick **JanitorAI** or **Chub** at the top.

- Browse by Trending / Popular / Latest (Chub also has Top rated, Newest, Updated), search,
  switch between All and Limited only, and page through results.
- Click a creator's **@name** to see their profile and everything they published; click any tag to filter by it.
- Open a card for the full page: stats, created/updated dates, token counts and the creator's own
  (coloured) description.
- **Import to SillyTavern** creates the character. Its lorebooks become one World Info file that is
  linked to the character.
- **Lorebook only** saves just the lorebook — handy when you already have the card from elsewhere.
- On Chub you can also browse **Lorebooks** and import them directly.
- Each site has its own look: JanitorAI's purple cards, and a navy Chub theme with wide cards and the
  character's portrait blurred behind its page.
- Character pages show the creator's description with their own colours, fonts and styling, a
  **Lorebooks** panel (name, kind — lorebook, linked, embedded or code script — and whether it can be
  imported), a preview of the definition, and the **comments** with replies.
- Paste a `janitorai.com/characters/…`, `janitorai.com/profiles/…`, `chub.ai/characters/…` or
  `chub.ai/lorebooks/…` link into the search box to jump straight to it.

## Favorites and Library

- **Favorites** collects bots from both sites on one gold poster wall. Press the ☆ star on any card or
  character page. With your accounts connected, the favorites you set **on JanitorAI and Chub appear here
  by themselves** (checked whenever you open the tab and every few minutes while it's open), and ones you
  un-favorite on the site disappear. Stored on your SillyTavern server, so every device sees the same list.
- **Library** lists every character you imported with Bot Bazaar: chat with it, jump back to its page,
  or delete it (optionally together with its lorebook).

## Chub

Browsing needs nothing — Chub's API is public. Linked lorebooks are merged with the card's own lorebook.

## Connecting your accounts

JanitorAI and Chub don't let other apps sign you in, so Bot Bazaar borrows the login your browser already has —
with **one bookmark**, and **no copy-paste**:

1. One-time: in **Account**, add the **Bot Bazaar** bookmark (computer: drag it to the bookmarks bar; phone:
   **Copy bookmark code**, then make a bookmark named `bazaar` with that code as its address).
2. Open JanitorAI or Chub (signed in) and press the bookmark.
3. It jumps straight back to SillyTavern and connects by itself — nothing to paste. Works on Android Chrome.

The login is handed over inside the page URL's `#` fragment, which browsers never send to any server, and is
cleared from the address bar immediately. (If you ever need it, the Account panel still has a manual paste box.)

**JanitorAI now stays logged in.** The bookmark also captures the refresh part of your JanitorAI session, so
Bot Bazaar renews the login in the background the same way janitorai.com does. You connect once and stay
connected — no more reconnecting every few hours. (If you sign out of JanitorAI in your browser, or it's been
untouched for a long time, just press the bookmark again.)

- **Chub** only needs connecting for your Chub favorites; browsing never needs it.

Desktop alternative for JanitorAI with nothing to press: install [Tampermonkey](https://www.tampermonkey.net/),
switch on **Allow User Scripts** for it, and install `janitor-bridge.user.js` from this repository.

Your logins are stored in your SillyTavern settings and this browser, and only sent to janitorai.com and chub.ai —
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

---

This project is not affiliated with JanitorAI, Chub, JannyAI or SillyTavern. Respect creators' work.

## License

MIT
