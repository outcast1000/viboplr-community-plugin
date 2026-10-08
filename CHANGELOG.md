## 0.2.1

- **Mine** never lists Viboplr's own playlists — Liked Tracks, Disliked Tracks and the mixes it makes for you — on any version of Viboplr, not only 1.0.94+. That includes one you published earlier; unpublish it from its page on the website.

## 0.2.0

- **Mixtapes:** a new tab for playlists people shared. **Play** one right away, or **Save to Playlists**. Each song is found in your library, on your servers or through your plugins, and anything you can't get is skipped. When the person who shared it updates it, the row offers **Update**.
- **Publish your playlists as mixtapes:** right-click a playlist → **Publish as a mixtape…**, or use **Community → Mine**, which also publishes the queue under a name you give it. Only titles, artists, albums and lengths are shared, never your file paths.
- Mixtape share links open the Mixtapes tab, ready to save.
- Every tab now refreshes when you come back to it, so a mixtape or cue sheet updated in the meantime shows its **Update** badge without a restart.
- Row buttons are icons (▶ play, ⬇ import, ⇪ publish, ↻ update, ↗ open page…), named in their tooltips. Before, longer labels overflowed the small round buttons.
- **Mine** lists your own playlists only. Liked/Disliked and the mixes Viboplr makes for you are left out (on Viboplr 1.0.94+, which says which are which), as are empty playlists. You can still publish any playlist by right-clicking it.
- New permissions, asked for once on update: `playback:control` to play a mixtape, and `library:read` / `library:write` to read your playlists and save mixtapes to them.

## 0.1.0

- First release: a **Community** view with one tab per module (**Cue sheets** and **Servers**) plus **Mine**.
- **Cue sheets:** browse and search what people shared, or narrow the tab to the song that's playing, and import one with a single click. Right-click a track for **Find shared cue sheets** or **Publish cue sheet…**.
- **Servers:** the Subsonic / Navidrome servers their owners opened to everyone. **Add** opens the app's own Add Server dialog, already filled in; you confirm there.
- **Mine:** your cue sheets, to publish, update or unpublish, and the servers you listed, to open or edit on the website.
- **Sign in with GitHub** to share. Browsing, importing and adding need no account.
- Share links (`viboplr://plugin/community/open?id=…`) open the sheet in the app, ready to import.
