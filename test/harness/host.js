// A stand-in for the app's plugin API: just the parts this plugin calls, with
// everything it does recorded for assertions. `route(url, init)` answers
// network.fetch with `{ status, body }` (body is JSON-encoded) or undefined
// for a 404.

function makeHost({ route, current = null, queue = [], appVersion = "1.0.94" } = {}) {
  const host = {
    requests: [],
    opened: [],
    notices: [],
    views: [],
    headers: [],
    logs: [],
    actions: {},
    menu: {},
    deepLink: null,
    storage: new Map(),
    cues: new Map(),
    navigated: [],
    addRequests: [],
    // id → { id, name, description, metadata, tracks }
    playlists: new Map(),
    plays: [],
    queue,
    // A small model of the host's lyrics: the user's provider chain
    // (`webLyrics`) and the one cache Now Playing reads, which
    // api.lyrics.save writes like the lyrics editor does.
    lyricsCache: new Map(),
    webLyrics: new Map(),
    infoFetches: [],
    lyricsSaves: [],
    // typeId → handler, as api.informationTypes.onFetch registers them.
    infoProviders: {},
    // Now Playing info: registered items and their fetch handlers.
    npItems: [],
    npHandlers: {},
    // Host APIs from app 1.0.97: tab redraws, seek-bar markers,
    // page opens, and the track-started handler.
    sectionData: [],
    markers: [],
    entityOpens: [],
    requestedActions: [],
    trackStarted: null,
    position: 0,
    // What api.library.ftsTracks finds (library Track rows).
    libraryTracks: [],
  };
  let nextPlaylistId = 1;
  const key = (title, artist) =>
    `track:${String(artist || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")}:${String(title).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")}`;
  let clock = 1000;

  host.api = {
    appVersion,
    log: (level, message) => host.logs.push({ level, message }),
    network: {
      fetch: async (url, init = {}) => {
        host.requests.push({ url, init });
        const answer = route ? await route(new URL(url), init) : undefined;
        const status = answer ? answer.status ?? 200 : 404;
        const body = answer && answer.body !== undefined ? JSON.stringify(answer.body) : status === 404 ? '{"error":"not found"}' : "";
        return { status, headers: {}, text: async () => body, json: async () => JSON.parse(body) };
      },
      openUrl: async (url) => {
        host.opened.push(url);
      },
      onDeepLink: (handler) => {
        host.deepLink = handler;
        return () => {};
      },
    },
    storage: {
      get: async (k) => (host.storage.has(k) ? structuredClone(host.storage.get(k)) : null),
      set: async (k, v) => {
        host.storage.set(k, structuredClone(v));
      },
      delete: async (k) => {
        host.storage.delete(k);
      },
    },
    cues: {
      get: async (title, artist) => host.cues.get(key(title, artist)) || null,
      list: async () => [...host.cues.values()].sort((a, b) => b.updatedAt - a.updatedAt),
      set: async (title, artist, sheet, meta = {}) => {
        const prev = host.cues.get(key(title, artist));
        clock += 1;
        const row = {
          title,
          artistName: artist ?? null,
          albumName: meta.albumName ?? null,
          durationSecs: meta.durationSecs ?? null,
          author: meta.author ?? null,
          version: prev ? prev.version + 1 : 1,
          createdAt: prev ? prev.createdAt : clock,
          updatedAt: clock,
          sheet,
        };
        host.cues.set(key(title, artist), row);
        return row;
      },
      delete: async (title, artist) => host.cues.delete(key(title, artist)),
    },
    playback: {
      getPosition: () => host.position,
      setMarkers: (trackKey, markers) => host.markers.push({ trackKey, markers }),
      onTrackStarted: (handler) => {
        host.trackStarted = handler;
        return () => {};
      },
      getCurrentTrack: () => host.current,
      getQueue: () => ({ tracks: host.queue, index: 0 }),
      playTracks: (tracks, startIndex, context) => host.plays.push({ tracks, startIndex, context }),
    },
    library: {
      ftsTracks: async () => structuredClone(host.libraryTracks),
    },
    playlists: {
      list: async () =>
        [...host.playlists.values()].map((p) => ({
          id: p.id,
          name: p.name,
          source: null,
          savedAt: p.id,
          imagePath: null,
          trackCount: p.tracks.length,
          description: p.description ?? null,
          metadata: p.metadata ? structuredClone(p.metadata) : null,
        })),
      save: async (data) => {
        const id = nextPlaylistId++;
        host.playlists.set(id, { id, ...structuredClone(data) });
        return id;
      },
      delete: async (id) => {
        host.playlists.delete(id);
      },
      getTracks: async (id) =>
        (host.playlists.get(id)?.tracks || []).map((t) => ({
          title: t.title,
          artistName: t.artistName ?? null,
          albumName: t.albumName ?? null,
          durationSecs: t.durationSecs ?? null,
          source: t.source ?? null,
          imagePath: null,
        })),
    },
    informationTypes: {
      fetch: async (typeId, entity, opts = {}) => {
        host.infoFetches.push({ typeId, entity, opts });
        const k = key(entity.name, entity.artistName);
        if (!opts.force && host.lyricsCache.has(k)) {
          return { typeId, status: "ok", source: "cache", value: host.lyricsCache.get(k) };
        }
        const web = host.webLyrics.get(k);
        if (web) host.lyricsCache.set(k, web);
        else host.lyricsCache.delete(k);
        return { typeId, status: web ? "ok" : "not_found", source: "fetch", value: web || null };
      },
      onFetch: (typeId, handler) => {
        host.infoProviders[typeId] = handler;
        return () => {};
      },
      setSectionData: async (typeId, entity, data) => {
        host.sectionData.push({ typeId, entity, data });
      },
    },
    nowPlayingInfo: {
      registerItem: (descriptor) => {
        host.npItems.push(descriptor);
        return () => {};
      },
      onFetch: (id, handler) => {
        host.npHandlers[id] = handler;
        return () => {};
      },
    },
    lyrics: {
      save: async (track, lyrics) => {
        host.lyricsSaves.push({ track, lyrics });
        host.lyricsCache.set(key(track.title, track.artistName), { text: lyrics.text, kind: lyrics.kind });
      },
    },
    collections: {
      requestAdd: async (source) => {
        host.addRequests.push(source);
      },
    },
    ui: {
      setViewData: (id, data) => host.views.push({ id, data }),
      setViewHeader: (id, header) => host.headers.push({ id, header }),
      showNotification: (message, options) => host.notices.push({ message, options }),
      onAction: (id, handler) => {
        host.actions[id] = handler;
        return () => {};
      },
      navigateToView: (id) => host.navigated.push(id),
      navigateToEntity: (kind, ref, opts) => host.entityOpens.push([kind, ref, opts]),
      requestAction: (action, payload) => host.requestedActions.push([action, payload]),
    },
    contextMenu: {
      onAction: (id, handler) => {
        host.menu[id] = handler;
        return () => {};
      },
    },
  };

  host.current = current;
  host.lastView = () => host.views[host.views.length - 1].data;
  host.lastHeader = () => host.headers[host.headers.length - 1].header;
  host.lastNotice = () => host.notices[host.notices.length - 1];
  host.addSheet = (title, artist, sheet, extra = {}) => host.api.cues.set(title, artist, sheet, extra);
  host.addPlaylist = (name, tracks, extra = {}) => host.api.playlists.save({ name, tracks, ...extra });
  return host;
}

module.exports = { makeHost };
