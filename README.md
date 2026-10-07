# Viboplr Community (plugin `community`)

This plugin is the Viboplr client for [Viboplr Community](https://community.viboplr.com). You can publish the Now Playing cue sheets you've made and import ones other people shared. A sheet is keyed by artist + title, so an imported sheet plays over *any* copy of that song.

- **Browse** lets you search Viboplr Community and sort by recent or most imported.
- **This song** shows the sheets shared for the track that's playing, or for the one you right-clicked.
- **My sheets** lists your local sheets. You can publish, update or unpublish each one. A sheet imported from the community that you haven't changed isn't offered for publishing.
- **Sign in with GitHub** opens your browser. The hub hands a one-time code back through `viboplr://plugin/community/auth`, and the plugin trades it for a revocable hub token using PKCE.
  - The verifier never leaves the plugin.
  - The GitHub token never reaches the app.
- **Share links** of the form `viboplr://plugin/community/open?id=…` (the website's *Open in Viboplr* button) open the sheet, ready to import.

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
