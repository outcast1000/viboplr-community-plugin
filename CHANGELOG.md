## 0.6.0

- **What's shared for a song:** a track's page now says how many cue sheets and synced lyrics people have shared for it, e.g. "2 cue sheets · 1 lyric sheet on Community". It's looked up only when you open the page.
- The mini player can show the same line for the song that's playing: switch on **Shared on Community** in Settings → Playback → Now playing info. It's off by default, because with it on every song you play is looked up on community.viboplr.com.
- Both need the Viboplr Community server with song pages (subjects). On an older server they show nothing.

## 0.5.1

- New icon: two people replace the upload arrow, in the sidebar and in Extensions.

## 0.5.0

- **Sign in with a code**, a second way to sign in that works behind company proxies. **Sign in with GitHub** works as before: your browser hands the sign-in back to Viboplr. Behind a proxy that runs the browser remotely (for example Zscaler browser isolation), that handoff never arrives. Choose **Sign in with a code** instead, or **Use a code instead** while a sign-in is waiting. Viboplr shows a short code and opens community.viboplr.com. Sign in with GitHub there and confirm the code, and Viboplr signs you in a few seconds later. You can also enter the code on another device, such as your phone.
- Signing in with a code needs the Viboplr Community server with device sign-in (`/auth/device`). It works on the same Viboplr versions as before.

## 0.4.0

- The **Servers** tab is now **Subsonic servers**, so it says what kind of server it lists.
- **Subsonic servers are for signed-in members only.** Signed out, the tab asks you to sign in with GitHub; signing out takes the listing off the screen. Cue sheets, synced lyrics and mixtapes still need no account.

## 0.3.0

- **Synced lyrics:** a new tab for time-synced lyrics people shared. Search it whenever you like and **Import** what you want: the lyrics become the song's lyrics, as if you'd edited them in yourself, and scroll along in Now Playing straight away. Nothing is looked up while you listen — only when you search or import.
- If the song already has synced lyrics, Viboplr asks before replacing them, and says where yours came from. **Undo import** (**Mine → Synced lyrics**) gives the song back to your lyrics providers.
- **Publish synced lyrics:** right-click a track → **Publish synced lyrics…** shares whatever synced lyrics Viboplr has for it, wherever they came from. Plain lyrics can't be shared.
- Right-click a track → **Find shared synced lyrics** searches the tab for that song. Share links open it, ready to import.
- Importing needs Viboplr 1.0.94 or later; searching and publishing work on 1.0.93.
- New permissions, asked for once on update: `lyrics:write`, to put lyrics you import in place, and `plugins:call`, to read a song's lyrics through Viboplr's lyrics providers.

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
