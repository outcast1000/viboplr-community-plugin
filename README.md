# Viboplr Community (plugin `community`)

This plugin is the Viboplr client for [Viboplr Community](https://community.viboplr.com), where listeners share things with each other. Each kind of thing is a **module**, and the plugin builds itself from the server's module list (`GET /v1/modules`, remembered for the next start). It shows one tab per module, plus **Mine**.

- **Every module, with no code here:**
  - A tab with search, sort and load-more. Rows come from each item's `card` (title, facts, publisher, uses).
  - **Open page**, and **Share a …** when the module has a website form.
  - The module's notice.
  - A **Mine** section listing what you shared, with Open page and Edit.
- **Integrations** (`INTEGRATIONS` in `index.js`, keyed by `kind`) add what only app code can do:
  - **Cue sheets:** **Import**/**Update** through the host's `api.cues`, the "for one song" scope (the playing track, or the one you right-clicked), and a Mine section for the sheets on this computer, with publish, update and unpublish. A sheet imported from the community that you haven't changed isn't offered for publishing.
  - **Synced lyrics:** search the tab and **Import** on demand. An import is a one-off write through the host's `api.lyrics.save` (app 1.0.94+), the same write as the in-app lyrics editor, so the song's lyrics simply become the shared LRC and open views update at once. The plugin is **not** a lyrics provider and looks nothing up at play time; it keeps only `lyricsImports` (song → item id + version) for the Imported / Update badges. Importing over existing synced lyrics asks first. **Undo import** forgets it and re-walks the user's provider chain (`api.informationTypes.fetch(..., { force: true })`). **Publish** (right-click a track) shares whatever synced lyrics the app has for the song, from any source; only plain lyrics are refused.
  - **Mixtapes:** **Play** (through `api.playback.playTracks`, with a playlist banner) and **Save to Playlists** (through `api.playlists.save`). Every entry is metadata-only, so the app's resolvers find each song in the library, on a server or through a plugin. A saved mixtape records `{ communityId, communityVersion }` in its playlist `metadata`, so the tab badges it Saved or Update, and Mine marks it "From the community" and won't publish it. Publish a saved playlist (right-click it in Playlists → **Publish as a mixtape…**, or from Mine) or the queue (Mine → name it → **Publish the queue**). Only title, artist, album and length are sent, never a file path or plugin URI.
  - **Subsonic servers:** members only (`membersOnly` in `/v1/modules`). Signed out, the tab shows a sign-in prompt and fetches nothing, and signing out clears the listing. **Add** passes the listing, public login included, to `api.collections.requestAdd`, which opens the app's own Add Server dialog already filled in. The user confirms there.

**Adding a module:** declare it on the server (`src/modules.rs` in `viboplr-community`). It then appears here, and on viboplr.com's Community page, without a release. Add an `INTEGRATIONS` entry only when the module should do something in the app beyond opening its page.

Sign-in and links:
- **Sign in with GitHub** (the usual way) opens your browser. The server hands a one-time code back through `viboplr://plugin/community/auth`, and the plugin trades it for a revocable token using PKCE.
- **Sign in with a code** (the header's second button, or **Use a code instead** while a browser sign-in is waiting) uses a device code (RFC 8628). The plugin gets a short code from `POST /auth/device`, shows it, and opens `community.viboplr.com/device?code=…`. You sign in there and confirm the code, in that browser or on any other device. Meanwhile the plugin polls `POST /auth/device/token` and receives the same kind of token once you confirm. Nothing has to come back from the browser, so this works behind company proxies that isolate the browser, where the `viboplr://` link can't reach the app. Starting one sign-in gives up the other, so a late link from an abandoned browser sign-in is ignored.
  - The verifier never leaves the plugin.
  - The GitHub token never reaches the app.
- **Share links** of the form `viboplr://plugin/community/open?id=…` (the *Open in Viboplr* button on a cue sheet or mixtape page) open the item: a cue sheet ready to import, a mixtape ready to save.

It needs Viboplr **1.0.93+**, the first release with the `api.cues` plugin API. It runs on the worker runtime with these permissions:
- `network:community.viboplr.com`
- `system:open`
- `cues:read` / `cues:write`
- `playback:read` / `playback:control` (find sheets for the playing song, publish the queue, play a mixtape)
- `library:read` / `library:write` (list and read your playlists to publish them; save a mixtape)
- `lyrics:write` (put lyrics you import in place)
- `plugins:call` (read a song's lyrics through the app's lyrics providers to publish them, and look a song up again on Undo import)

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
