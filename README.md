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
- Paste a `janitorai.com/characters/…`, `janitorai.com/profiles/…`, `chub.ai/characters/…` or
  `chub.ai/lorebooks/…` link into the search box to jump straight to it.

## Chub

Needs nothing — Chub's API is public. Linked lorebooks are merged with the card's own lorebook.

## JanitorAI: connecting your account

Without an account JanitorAI only shows the first page of results and no definitions or lorebooks.
JanitorAI's sign-in (captcha, Google/Discord/Apple) only works on its own site, so you carry your
login over with a small bookmark:

1. One-time: add the **Janitor token** bookmark shown in the Account panel
   (computer: drag it to the bookmarks bar; phone: copy the code and save it as a bookmark named `jtoken`).
2. On a signed-in JanitorAI tab, press that bookmark. It copies your login token.
3. Back in SillyTavern press **Paste & connect**.

A JanitorAI login lasts about 3 hours; after that repeat steps 2 and 3.

Desktop alternative with nothing to copy: install [Tampermonkey](https://www.tampermonkey.net/),
switch on **Allow User Scripts** for it, and install `janitor-bridge.user.js` from this repository.
The extension then works through your open JanitorAI tab.

The token is your JanitorAI login. It is stored in your SillyTavern settings and only sent to
janitorai.com — never share it, and remember it is inside settings backups.

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
