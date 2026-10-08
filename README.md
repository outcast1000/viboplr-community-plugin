# Viboplr Community (plugin `community`)

This plugin is the Viboplr client for [Viboplr Community](https://community.viboplr.com), where listeners share things with each other. Each kind of thing is a **module**, and the plugin builds itself from the server's module list (`GET /v1/modules`, remembered for the next start). It shows one tab per module, plus **Mine**.

- **Every module, with no code here:**
  - A tab with search, sort and load-more. Rows come from each item's `card` (title, facts, publisher, uses).
  - **Open page**, and **Share a …** when the module has a website form.
  - The module's notice.
  - A **Mine** section listing what you shared, with Open page and Edit.
- **Integrations** (`INTEGRATIONS` in `index.js`, keyed by `kind`) add what only app code can do:
  - **Cue sheets:** **Import**/**Update** through the host's `api.cues`, the "for one song" scope (the playing track, or the one you right-clicked), and a Mine section for the sheets on this computer, with publish, update and unpublish. A sheet imported from the community that you haven't changed isn't offered for publishing.
  - **Servers:** **Add** passes the listing, public login included, to `api.collections.requestAdd`, which opens the app's own Add Server dialog already filled in. The user confirms there.

**Adding a module:** declare it on the server (`src/modules.rs` in `viboplr-community`). It then appears here, and on viboplr.com's Community page, without a release. Add an `INTEGRATIONS` entry only when the module should do something in the app beyond opening its page.

Sign-in and links:
- **Sign in with GitHub** opens your browser. The server hands a one-time code back through `viboplr://plugin/community/auth`, and the plugin trades it for a revocable token using PKCE.
  - The verifier never leaves the plugin.
  - The GitHub token never reaches the app.
- **Share links** of the form `viboplr://plugin/community/open?id=…` (a cue sheet's *Open in Viboplr* button) open the sheet, ready to import.

It needs Viboplr **1.0.93+**, the first release with the `api.cues` plugin API. It runs on the worker runtime with these permissions:
- `network:community.viboplr.com`
- `system:open`
- `cues:read` / `cues:write`
- `playback:read`

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
