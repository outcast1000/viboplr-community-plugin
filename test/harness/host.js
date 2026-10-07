// A stand-in for the app's plugin API: just the parts this plugin calls, with
// everything it does recorded for assertions. `route(url, init)` answers
// network.fetch with `{ status, body }` (body is JSON-encoded) or undefined
// for a 404.

function makeHost({ route, current = null } = {}) {
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
  };
  const key = (title, artist) =>
    `track:${String(artist || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")}:${String(title).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")}`;
  let clock = 1000;

  host.api = {
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
    playback: { getCurrentTrack: () => current },
    ui: {
      setViewData: (id, data) => host.views.push({ id, data }),
      setViewHeader: (id, header) => host.headers.push({ id, header }),
      showNotification: (message, options) => host.notices.push({ message, options }),
      onAction: (id, handler) => {
        host.actions[id] = handler;
        return () => {};
      },
      navigateToView: (id) => host.navigated.push(id),
    },
    contextMenu: {
      onAction: (id, handler) => {
        host.menu[id] = handler;
        return () => {};
      },
    },
  };

  host.lastView = () => host.views[host.views.length - 1].data;
  host.lastHeader = () => host.headers[host.headers.length - 1].header;
  host.lastNotice = () => host.notices[host.notices.length - 1];
  host.addSheet = (title, artist, sheet, extra = {}) => host.api.cues.set(title, artist, sheet, extra);
  return host;
}

module.exports = { makeHost };
