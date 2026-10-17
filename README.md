# Viboplr Community (plugin `community`)

This plugin is the Viboplr client for [Viboplr Community](https://community.viboplr.com), where listeners share things with each other. Browsing is the website's: since 1.7 the plugin does only what needs the app — publish what's on this computer, take a shared item into the app, the Community tab on Viboplr's own pages, and what runs while you listen. The website shows everything shared and, on a member's page, everything they added.

- **A Community tab on Viboplr's own pages.** Every song, album and artist page gets a **Community** tab (information types `community_track` / `community_album` / `community_artist`, display kind `plugin_view` — app 1.0.97+). It holds everything shared about that page, each action answered in place (the tab is redrawn with `api.informationTypes.setSectionData`):
  - **Like** (`PUT /v1/subjects/{id}/like`), **Open the page** on the website.
  - Songs: the shared **cue sheets** and **synced lyrics**, with today's Import / Update / Imported badges, and **Publish my cue sheet / synced lyrics**.
  - Albums list what's shared per track; artists their albums and songs (`/v1/subjects/{id}/children`).
  - **Comments**, flat, newest first. On a song that is playing, **@ 2:13** pins the comment to that moment.
  - A page nobody shared anything about still gets the tab, inviting the first share.
- **The view** (sidebar → Community) has two tabs:
  - **You**: publishing from this computer (cue sheets, synced lyrics, playlists, the queue), and what you shared. **Browse Community** opens the website, where songs, mixtapes and Subsonic servers are browsed; **Open my page** opens your page there (likes, comments, plays, waveforms and a history of it all).
  - **Settings**: every switch the plugin has — the **seek-bar ticks**, sending your plays, sending your likes (on by default) — and, on Viboplr 1.0.103 or later, **Open in Extensions** for its permissions, which of its menu items and views show, and switching it off.
- **Integrations** (`INTEGRATIONS` in `index.js`, keyed by `kind`) add what only app code can do:
  - **Cue sheets:** **Import**/**Update** through the host's `api.cues`, and a You section for the sheets on this computer, with publish, update and unpublish. A sheet imported from the community that you haven't changed isn't offered for publishing.
  - **Synced lyrics:** **Import** is a one-off write through the host's `api.lyrics.save`, the same write as the in-app lyrics editor. The plugin is **not** a lyrics provider; it keeps only `lyricsImports` (song → item id + version) for the badges. Importing over synced lyrics the song already has asks first — in the view, or in the song's tab when imported from there — and says where the current ones came from. **Undo import** (You) re-walks the user's provider chain. **Publish** (right-click a track, or the song's tab) shares whatever synced lyrics the app has for the song, from any source.
  - **Mixtapes:** **Save to Playlists** from a share link (saving again after the publisher updates it swaps in the new version). A saved mixtape records `{ communityId, communityVersion }` in its playlist `metadata`, so You won't publish it. Only title, artist, album and length are ever sent.
  - **Subsonic servers** need no integration: the website's **Add** opens the app's own Add Server dialog by itself (`viboplr://add-collection`).
- **Seek-bar ticks** (Settings → *While you listen*, **off by default**): the playing song's timed comments as ticks on the seek bar (`api.playback.setMarkers`), the comment shown when you point at one. With them on, every song you play is looked up on the server, which is why they start off.
- **Shared cue sheets in Now Playing** (Settings → *While you listen*: Off / Notify me (default) / Import automatically). Only while Now Playing is actually on screen (`api.ui.getContext` / `onContextChanged`, permission `ui:read` — the view or audio fullscreen, the window visible, not the mini player), signed in, and the song has no sheet of yours: `GET /v1/items?kind=cue_sheet` asked anonymously, your own published sheets dropped, the most imported first. A sheet fits when its `durationSecs` is within 3 s of the playing copy; when either side has no length the fit can't be checked, so auto never imports it and notify offers it only when nothing fits exactly, saying the timing wasn't checked. Notify shows a toast with **Import**; auto goes through the ordinary import (provenance kept, so *Undo import* works). A suggested import never raises the *Replace?* question: it re-reads `api.cues.get` first and leaves a sheet of yours alone. The toast's button is one fixed UI action (the host runs it with no payload, and actions can't be unregistered), so what each toast offers is kept by song and Import imports the offer for the song playing *now*, or nothing. Each song is checked once ever, counted only once the check has an answer (own sheet, nothing fits, offered or imported) — a failed lookup or a song that changed meanwhile is asked again (`cueAsked` in storage, capped at 1000; checks in flight are kept in memory so one song is asked once at a time).
- **Shared waveforms** (Settings → *Share with Viboplr Community*, on by default, signed in only): `api.waveforms.onLookup` / `onShare`, `POST /v1/waveforms/lookup` and `PUT /v1/waveforms` **as the member**, so Community keeps a private record of which songs the member holds and in what format (removable with *Delete my play history* on the website) besides the anonymous public format stats. A lookup arriving before the saved session is read back waits for it, inside the app's ~3 s budget; routine failures (offline, timeouts, 429, 5xx) log as warnings.
- **What's shared for a song** (`/v1/subjects/resolve`, asked anonymously and kept a minute for the header line, the mini player item and the ticks; the tab asks fresh, as you): the track page's header shows "♥ 128 · 2 cue sheets · 1 lyric sheet on Community" (`community_shared`, `title_line`, which Viboplr keeps for six hours), and the mini player's **Shared on Community** item says the same — **off by default**, for the same reason as the ticks.

**Adding a module:** declare it on the server (`src/modules.rs` in `viboplr-community`). A module then gets a section on You here, and shows on viboplr.com's Community page, without a release. Add an `INTEGRATIONS` entry only when the module should do something in the app beyond opening its page.

Sign-in and links:
- **Sign in with GitHub** (the usual way) opens your browser. The server hands a one-time code back through `viboplr://plugin/community/auth`, and the plugin trades it for a revocable token using PKCE.
- **Sign in with a code** (the header's second button, or **Use a code instead** while a browser sign-in is waiting) uses a device code (RFC 8628). The plugin gets a short code from `POST /auth/device`, shows it, and opens `community.viboplr.com/device?code=…`. You sign in there and confirm the code, in that browser or on any other device. Meanwhile the plugin polls `POST /auth/device/token` and receives the same kind of token once you confirm. Nothing has to come back from the browser, so this works behind company proxies that isolate the browser, where the `viboplr://` link can't reach the app. Starting one sign-in gives up the other, so a late link from an abandoned browser sign-in is ignored.
  - The verifier never leaves the plugin.
  - The GitHub token never reaches the app.
- **Share links** of the form `viboplr://plugin/community/open?id=…` (the *Open in Viboplr* button on a cue sheet or mixtape page) open the item on You: a cue sheet or synced lyrics ready to import, a mixtape ready to save. Anything else (a Subsonic server, a kind this build doesn't know) opens its page on the website.
- **`viboplr://plugin/community/subject?id=…`** (the *Open in Viboplr* button on a song, album or artist page) opens Viboplr's own page for it, on its Community tab.

It needs Viboplr **1.0.97+**, the first release with interactive information tabs (`plugin_view`), `api.informationTypes.setSectionData`, `api.ui.navigateToEntity` and `api.playback.setMarkers`. It runs on the worker runtime with these permissions:
- `network:community.viboplr.com`
- `system:open`
- `cues:read` / `cues:write`
- `playback:read` (the playing song's moment for a comment, publish the queue)
- `playback:markers` (the seek-bar ticks, only once you switch them on)
- `library:read` / `library:write` (list and read your playlists to publish them; save a mixtape)
- `lyrics:write` (put lyrics you import in place)
- `plugins:call` (read a song's lyrics through the app's lyrics providers to publish them, and look a song up again on Undo import)

It needs the Viboplr Community server with music areas (subject search, activity, likes, comments, `/v1/subjects/{id}/children`).

The server lives in [`outcast1000/viboplr-community`](https://github.com/outcast1000/viboplr-community).

## Develop

```sh
node --test          # tests (fake host in test/harness)
node --check index.js
scripts/package.sh   # community.zip + update.json
```

Release by pushing a `v<version>` tag that matches `manifest.json`. CI then publishes the release.

To live-test against a local server:
1. Temporarily point `SERVER` at it.
2. Add its host to `permissions`.
3. Load the folder as the dev plugin (`devPluginPath`).
