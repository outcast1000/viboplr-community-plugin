# Viboplr Community (plugin `community`)

This plugin is the Viboplr client for [Viboplr Community](https://community.viboplr.com), where listeners share things with each other. Since 1.0 it mirrors the site's three areas: **Music** (songs, albums, artists), **Mixtapes** and **Subsonic servers**.

- **A Community tab on Viboplr's own pages.** Every song, album and artist page gets a **Community** tab (information types `community_track` / `community_album` / `community_artist`, display kind `plugin_view` — app 1.0.97+). It holds everything shared about that page, each action answered in place (the tab is redrawn with `api.informationTypes.setSectionData`):
  - **Like** (`PUT /v1/subjects/{id}/like`), **Open the page** on the website.
  - Songs: the shared **cue sheets** and **synced lyrics**, with today's Import / Update / Imported badges, and **Publish my cue sheet / synced lyrics**.
  - Albums list what's shared per track; artists their albums and songs (`/v1/subjects/{id}/children`).
  - **Comments**, flat, newest first. On a song that is playing, **@ 2:13** pins the comment to that moment.
  - A page nobody shared anything about still gets the tab, inviting the first share.
- **The view** (sidebar → Community) has four tabs:
  - **Discover**: search songs, albums and artists (`/v1/subjects/search`) and **New this week** (`/v1/activity`). Opening one goes to Viboplr's own page for it, on its Community tab (`api.ui.navigateToEntity`; an older app opens the page without picking the tab). Songs you don't have get a page too, built from their name.
  - **Mixtapes** and **Subsonic servers**: the modules whose `area` isn't music, built from the server's module list as before (a new non-music module gets a tab with no release).
  - **You**: the **seek-bar ticks** switch, publishing from this computer (cue sheets, synced lyrics, playlists, the queue), and what you shared. Likes and comments are on the website (**Open my page**).
- **Integrations** (`INTEGRATIONS` in `index.js`, keyed by `kind`) add what only app code can do:
  - **Cue sheets:** **Import**/**Update** through the host's `api.cues`, and a You section for the sheets on this computer, with publish, update and unpublish. A sheet imported from the community that you haven't changed isn't offered for publishing.
  - **Synced lyrics:** **Import** is a one-off write through the host's `api.lyrics.save`, the same write as the in-app lyrics editor. The plugin is **not** a lyrics provider; it keeps only `lyricsImports` (song → item id + version) for the badges. Importing over synced lyrics the song already has asks first — in the view, or in the song's tab when imported from there — and says where the current ones came from. **Undo import** (You) re-walks the user's provider chain. **Publish** (right-click a track, or the song's tab) shares whatever synced lyrics the app has for the song, from any source.
  - **Mixtapes:** **Play** (metadata-only entries, with a playlist banner) and **Save to Playlists**. A saved mixtape records `{ communityId, communityVersion }` in its playlist `metadata`, so the tab badges it Saved or Update and You won't publish it. Only title, artist, album and length are ever sent.
  - **Subsonic servers:** members only. **Add** opens the app's own Add Server dialog, filled in.
- **Seek-bar ticks** (You → *While you listen*, **off by default**): the playing song's timed comments as ticks on the seek bar (`api.playback.setMarkers`), the comment shown when you point at one. With them on, every song you play is looked up on the server, which is why they start off.
- **What's shared for a song** (`/v1/subjects/resolve`, asked anonymously and kept a minute for the header line, the mini player item and the ticks; the tab asks fresh, as you): the track page's header shows "♥ 128 · 2 cue sheets · 1 lyric sheet on Community" (`community_shared`, `title_line`, which Viboplr keeps for six hours), and the mini player's **Shared on Community** item says the same — **off by default**, for the same reason as the ticks.

**Adding a module:** declare it on the server (`src/modules.rs` in `viboplr-community`). A non-music module then gets a tab here, and every module shows on viboplr.com's Community page, without a release. Add an `INTEGRATIONS` entry only when the module should do something in the app beyond opening its page.

Sign-in and links:
- **Sign in with GitHub** (the usual way) opens your browser. The server hands a one-time code back through `viboplr://plugin/community/auth`, and the plugin trades it for a revocable token using PKCE.
- **Sign in with a code** (the header's second button, or **Use a code instead** while a browser sign-in is waiting) uses a device code (RFC 8628). The plugin gets a short code from `POST /auth/device`, shows it, and opens `community.viboplr.com/device?code=…`. You sign in there and confirm the code, in that browser or on any other device. Meanwhile the plugin polls `POST /auth/device/token` and receives the same kind of token once you confirm. Nothing has to come back from the browser, so this works behind company proxies that isolate the browser, where the `viboplr://` link can't reach the app. Starting one sign-in gives up the other, so a late link from an abandoned browser sign-in is ignored.
  - The verifier never leaves the plugin.
  - The GitHub token never reaches the app.
- **Share links** of the form `viboplr://plugin/community/open?id=…` (the *Open in Viboplr* button on a cue sheet or mixtape page) open the item: a cue sheet or synced lyrics ready to import (in Discover), a mixtape ready to save.
- **`viboplr://plugin/community/subject?id=…`** (the *Open in Viboplr* button on a song, album or artist page) opens Viboplr's own page for it, on its Community tab.

It needs Viboplr **1.0.97+**, the first release with interactive information tabs (`plugin_view`), `api.informationTypes.setSectionData`, `api.ui.navigateToEntity` and `api.playback.setMarkers`. It runs on the worker runtime with these permissions:
- `network:community.viboplr.com`
- `system:open`
- `cues:read` / `cues:write`
- `playback:read` / `playback:control` (the playing song's moment for a comment, publish the queue, play a mixtape)
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
