# Viboplr Community (plugin `community`)

This plugin is the Viboplr client for [Viboplr Community](https://community.viboplr.com), where listeners share things with each other. Browsing is the website's, and so is "what I shared": since 1.7 the plugin has no view of its own and does only what needs the app — publish what's on this computer, take a shared item into the app, the Community tab on Viboplr's own pages, and what runs while you listen. The website shows everything shared and, on a member's page, everything they added (with Edit and Unpublish).

- **A Community tab on Viboplr's own pages.** Every song, album and artist page gets a **Community** tab (information types `community_track` / `community_album` / `community_artist`, display kind `plugin_view` — app 1.0.97+). It holds everything shared about that page, each action answered in place (the tab is redrawn with `api.informationTypes.setSectionData`):
  - The **likes**, read-only ("♥ 12 on Community · you like it"), and **Open the page** on the website. A song, album or artist is liked with Viboplr's own heart, which reaches Community through *Send my likes* (`PUT /v1/likes`); neither the tab nor the website likes them (since 1.7.1 — the server answers `410` to `PUT /v1/subjects/{id}/like`), so Community can't drift from the app.
  - Songs: the shared **cue sheets** and **synced lyrics**, with today's Import / Update / Imported badges, **Publish my cue sheet / synced lyrics**, and **Undo lyrics import** once you imported some (it works even after those lyrics left the community, and needs no sign-in).
  - Albums list what's shared per track; artists their albums and songs (`/v1/subjects/{id}/children`).
  - **Comments**, flat, newest first. On a song that is playing, **@ 2:13** pins the comment to that moment.
  - A page nobody shared anything about still gets the tab, inviting the first share.
- **No view of its own.** The account and every switch are the plugin's **settings panel** (`settingsPanel`, Extensions → Viboplr Community → Configuration): **Account** (signed in as whom, Sign out; or Sign in with GitHub / with a code, and the code while a sign-in waits; **Open my page** / **Open website**), **While you listen** (seek-bar ticks, shared cue sheets in Now Playing), **Send from Viboplr** (plays, likes), **Share with Viboplr Community** (waveforms).
- **Publishing** is right-click: a track's **Publish cue sheet…** / **Publish synced lyrics…**, a playlist's **Publish as a mixtape…** (or the song's Community tab). Publishing again updates it. Unpublishing and editing are on the website.
- **Integrations** (`INTEGRATIONS` in `index.js`, keyed by `kind`) add what only app code can do:
  - **Cue sheets:** **Import**/**Update** through the host's `api.cues`. A sheet imported from the community that you haven't changed isn't yours to publish.
  - **Synced lyrics:** **Import** is a one-off write through the host's `api.lyrics.save`, the same write as the in-app lyrics editor. The plugin is **not** a lyrics provider; it keeps only `lyricsImports` (song → item id + version) for the badges and Undo. Importing over synced lyrics the song already has asks first — in the song's tab when imported from there, else in a notice — and says where the current ones came from. **Undo lyrics import** (the song's tab) re-walks the user's provider chain. **Publish** shares whatever synced lyrics the app has for the song, from any source.
  - **Mixtapes:** only a **playlist you saved** is published — never the queue, never the app's own Liked / Disliked / mixes, never a mixtape saved from the community. **Save to Playlists** from a share link (saving again after the publisher updates it swaps in the new version). A saved mixtape records `{ communityId, communityVersion }` in its playlist `metadata`. Only title, artist, album and length are ever sent.
  - **Subsonic servers** need no integration: the website's **Add** opens the app's own Add Server dialog by itself (`viboplr://add-collection`).
- **Seek-bar ticks** (Settings → *While you listen*, **off by default**): the playing song's timed comments as ticks on the seek bar (`api.playback.setMarkers`), the comment shown when you point at one. With them on, every song you play is looked up on the server, which is why they start off.
- **Shared cue sheets in Now Playing** (Settings → *While you listen*: Off / Notify me (default) / Import automatically). Only while Now Playing is actually on screen (`api.ui.getContext` / `onContextChanged`, permission `ui:read` — the view or audio fullscreen, the window visible, not the mini player), signed in, and the song has no sheet of yours: `GET /v1/items?kind=cue_sheet` asked anonymously, your own published sheets dropped, the most imported first. A sheet fits when its `durationSecs` is within 3 s of the playing copy; when either side has no length the fit can't be checked, so auto never imports it and notify offers it only when nothing fits exactly, saying the timing wasn't checked. Notify shows a toast with **Import**; auto goes through the ordinary import (provenance kept, so *Undo import* works). A suggested import never raises the *Replace?* question: it re-reads `api.cues.get` first and leaves a sheet of yours alone. The toast's button is one fixed UI action (the host runs it with no payload, and actions can't be unregistered), so what each toast offers is kept by song and Import imports the offer for the song playing *now*, or nothing. Each song is checked once ever, counted only once the check has an answer (own sheet, nothing fits, offered or imported) — a failed lookup or a song that changed meanwhile is asked again (`cueAsked` in storage, capped at 1000; checks in flight are kept in memory so one song is asked once at a time).
- **Shared waveforms** (Settings → *Share with Viboplr Community*, on by default, signed in only): `api.waveforms.onLookup` / `onShare`, `POST /v1/waveforms/lookup` and `PUT /v1/waveforms` **as the member**, so Community keeps a private record of which songs the member holds and in what format (removable with *Delete my play history* on the website) besides the anonymous public format stats. A lookup arriving before the saved session is read back waits for it, inside the app's ~3 s budget; routine failures (offline, timeouts, 429, 5xx) log as warnings.
- **What's shared for a song** (`/v1/subjects/resolve`, asked anonymously and kept a minute for the header line, the mini player item and the ticks; the tab asks fresh, as you): the track page's header shows "♥ 128 · 2 cue sheets · 1 lyric sheet on Community" (`community_shared`, `title_line`, which Viboplr keeps for six hours), and the mini player's **Shared on Community** item says the same — **off by default**, for the same reason as the ticks.

**Adding a module:** declare it on the server (`src/modules.rs` in `viboplr-community`). It then shows on the website and on viboplr.com's Community page, and is named in the counts here, without a release. Add an `INTEGRATIONS` entry only when the module should do something in the app beyond opening its page.

Sign-in and links:
- **Sign in with GitHub** (the usual way) opens your browser. The server hands a one-time code back through `viboplr://plugin/community/auth`, and the plugin trades it for a revocable token using PKCE.
- **Sign in with a code** (the settings panel's second button, or **Use a code instead** while a browser sign-in is waiting) uses a device code (RFC 8628). The plugin gets a short code from `POST /auth/device`, shows it, and opens `community.viboplr.com/device?code=…`. You sign in there and confirm the code, in that browser or on any other device. Meanwhile the plugin polls `POST /auth/device/token` and receives the same kind of token once you confirm. Nothing has to come back from the browser, so this works behind company proxies that isolate the browser, where the `viboplr://` link can't reach the app. Starting one sign-in gives up the other, so a late link from an abandoned browser sign-in is ignored.
  - The verifier never leaves the plugin.
  - The GitHub token never reaches the app.
- **Share links** of the form `viboplr://plugin/community/open?id=…` (the *Open in Viboplr* button on a cue sheet, lyrics or mixtape page) ask in a notice — "Import this cue sheet?", "Save this mixtape?" — whose button does it; unanswered, it waits in the app's notifications list. A notice's button carries no payload, so the latest question is the one answered, and a question that would **replace** something the song has ("Replace your cue sheet?") has its own button (`answer-replace`, a warning), so a leftover Import can never be what replaces it. Anything else (a Subsonic server, a kind this build doesn't know) opens its page on the website.
- **`viboplr://plugin/community/subject?id=…`** (the *Open in Viboplr* button on a song, album or artist page) opens Viboplr's own page for it, on its Community tab.

It needs Viboplr **1.0.97+**, the first release with interactive information tabs (`plugin_view`), `api.informationTypes.setSectionData`, `api.ui.navigateToEntity` and `api.playback.setMarkers`. It runs on the worker runtime with these permissions:
- `network:community.viboplr.com`
- `system:open`
- `cues:read` / `cues:write`
- `playback:read` (the playing song's moment for a comment)
- `playback:markers` (the seek-bar ticks, only once you switch them on)
- `library:read` / `library:write` (read a playlist you publish; save a mixtape)
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
