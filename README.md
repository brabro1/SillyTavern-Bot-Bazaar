# Janitor Importer

A SillyTavern extension to browse JanitorAI characters and import them — definition, greetings, tags,
avatar **and the attached lorebook** — without leaving SillyTavern. Works on desktop and on phones.

## Install

In SillyTavern open **Extensions → Install extension** and paste:

```
https://github.com/brabro1/SillyTavern-Janitor-Importer
```

## Use

Click the broom button next to "Import content from external URL" in the character panel
(or **Janitor Importer** in the Extensions wand menu).

- Without an account you can look at the first page of Popular / Trending / Latest.
- Search, more pages, character definitions and lorebooks need your JanitorAI login — press **Account**.
- Open a character and press **Import to SillyTavern**. A shared lorebook becomes a World Info file
  that is linked to the character.
- You can also paste a `janitorai.com/characters/...` link into the search box.
- **Lorebook only** saves just the lorebook as a World Info file — handy when you already have the
  character card from somewhere else and only miss its lorebook.

## Connecting your account

JanitorAI's sign-in (captcha, Google/Discord/Apple) only works on its own site, so the extension cannot
show a login form. Instead you carry your login over with a small bookmark:

1. One-time: add the **Janitor token** bookmark shown in the Account panel
   (computer: drag it to the bookmarks bar; phone: copy the code and save it as a bookmark named `jtoken`).
2. On a signed-in JanitorAI tab, press that bookmark. It copies your login token.
3. Back in SillyTavern press **Paste & connect**.

A JanitorAI login lasts about 3 hours; after that repeat steps 2 and 3.

Desktop alternative with nothing to copy: install [Tampermonkey](https://www.tampermonkey.net/),
switch on **Allow User Scripts** for it, and install `janitor-bridge.user.js` from this repository.
The extension then works through your open JanitorAI tab.

## Good to know

- Everything runs in your browser; requests go straight to janitorai.com and nowhere else.
- The token is your JanitorAI login. It is stored in your SillyTavern settings — never share it,
  and remember it is inside settings backups.
- Creators can hide a character's definition and keep a lorebook private. JanitorAI does not send those,
  and this extension does not (and will not) try to get around that. Such characters import with their
  public parts only: name, avatar, description, tags and greetings.
- JanitorAI "advanced" (code) scripts cannot be converted and are skipped.

## Hidden definitions and JannyAI

When a definition is hidden, the character page offers to use **JannyAI's copy** of the card instead
(JannyAI is a separate site that publishes its own, possibly older, copies):

- **Try to fetch it** asks your SillyTavern server to download the copy. JannyAI's bot protection
  often blocks this.
- Otherwise press **Open on JannyAI**, download the card there yourself, and hand the file to the
  extension with **Use downloaded card**.

The extension then imports one character: definition from the JannyAI copy, greetings, avatar, tags
and lorebook from JanitorAI. If JannyAI has no copy, there is nothing to add.

This project is not affiliated with JanitorAI or SillyTavern. Respect creators' work.

## License

MIT
