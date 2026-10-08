// viboplr-community-plugin — Viboplr Community client: what Viboplr listeners
// share with each other (cue sheets, servers, and whatever comes next).
//
// Design notes:
//  - MODULES COME FROM THE SERVER. GET /v1/modules lists what can be shared,
//    and every item carries a `card` (title, facts, in-Viboplr action), so a
//    new module gets a tab and a Mine section here with no plugin release.
//    INTEGRATIONS adds what only app code can do for a known module (import a
//    cue sheet, open the Add Server dialog). See "Modules" below.
//  - THE SERVER OWNS ACCOUNTS, THE APP OWNS WHAT IT HOLDS. Sign-in happens in
//    the browser (GitHub, through community.viboplr.com); the plugin only ever
//    holds the server's own revocable `vcom_` token. Cue sheets are written
//    through the host's api.cues (the app's own normalizer), servers through
//    api.collections.requestAdd (the app's own Add Server dialog, which the
//    user confirms).
//  - TWO WAYS TO SIGN IN. The usual one is PKCE over a deep link: the server
//    hands a one-time code back through viboplr://plugin/community/auth
//    (scoped, so only this plugin sees it), useless without the verifier,
//    which never leaves this worker. The other is a device code (RFC 8628):
//    the person confirms a short code on the website in any browser and this
//    worker polls until they have. Nothing comes back from the browser, so it
//    works where the deep link can't arrive — a browser a company proxy runs
//    in isolation, or a system where viboplr:// isn't registered.
//  - PROVENANCE LIVES HERE. A sheet file has no "came from the community"
//    field, so the mapping song → community item (+ the local updatedAt at
//    import) is kept in this plugin's storage. That is what lets Mine tell an
//    untouched import (not ours to republish) from one the user has changed.
//  - A MIXTAPE IS A TRACK LIST. Publishing sends title/artist/album/length
//    only — never a track's source (a file path names the publisher's home
//    folder; a plugin URI plays only where that plugin is installed). Played
//    or saved here, every entry is metadata-only and the host's resolvers find
//    a copy. A saved mixtape remembers where it came from in its playlist
//    `metadata` ({ communityId, communityVersion }), so Mine can tell it apart
//    from the user's own and the tab can offer an update.
//  - AN IMPORT IS A ONE-OFF WRITE. Shared synced lyrics become the song's
//    lyrics through api.lyrics.save, like an edit in the app; the plugin is not
//    a lyrics provider and looks nothing up while anyone listens.
//  - NOT READY IS A BANNER. A server that can't be reached is shown inside the
//    view with a Retry, never as a toast (plugin view design guidelines).

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
var SERVER = "https://community.viboplr.com";
var VIEW = "community";
var TIMEOUT_MS = 15000;
var AUTH_TTL_MS = 10 * 60 * 1000;
// Device sign-in, when the server doesn't say: RFC 8628's defaults.
var DEVICE_POLL_DEFAULT_SECS = 5;
var DEVICE_TTL_DEFAULT_SECS = 600;
var LINK_PREFIX = "viboplr://plugin/community/";
var USER_AGENT = "Viboplr-Community-Plugin/0.2(+https://github.com/outcast1000/viboplr-community-plugin)";
var MAX_AUTHOR_CHARS = 64;
var FIRST_LOAD_DELAY_MS = 3000;
var MINE = "mine";

var api = null;
var state = null; // set up in activate() — BUILTIN_MODULES must exist first
var firstLoadTimer = null;

function freshState() {
  return {
    token: null,
    user: null,
    // In-flight sign-in. Through the browser's deep link:
    // { mode: "link", state, verifier, at }. With a device code:
    // { mode: "device", deviceCode, userCode, url, intervalMs, expiresAt, timer }.
    auth: null,
    // What can be shared (GET /v1/modules); BUILTIN_MODULES until it answers.
    modules: BUILTIN_MODULES.slice(),
    // The tab: a module's kind, or "mine".
    tab: BUILTIN_MODULES[0].kind,
    // Per module: { query, sort, page, items, more }.
    browse: {},
    // Per module: the items this user shared (GET /v1/me/items).
    shared: {},
    loading: false,
    error: null,
    // --- cue sheets ---
    // Everything ("all"), or the sheets for one song ("song").
    cueScope: "all",
    // The song the cue sheets are narrowed to: { title, artist }.
    song: null,
    songItems: null,
    // api.cues.list() rows.
    local: null,
    // songKey → { id, version, updatedAt } for sheets imported from the community.
    imports: {},
    // A pending in-view question: { kind: "import" | "replace", id, title, artist, by }.
    confirm: null,
    lastPublishedUrl: null,
    // --- mixtapes ---
    // api.playlists.list() rows; null until read.
    playlists: null,
    // --- synced lyrics ---
    // songKey → { id, version, title, artist, by, url } for lyrics imported
    // from the community (the text itself is the app's, via api.lyrics.save).
    lyricsImports: {},
  };
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

// The app's entity-key fold (db/likes.rs norm_segment): lowercase, strip
// combining marks. Björk and Bjork are one song, as they are to the app.
function fold(s) {
  return String(s || "").trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function songKey(title, artist) {
  return "track:" + fold(artist) + ":" + fold(title);
}

function base64url(bytes) {
  var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  var out = "";
  for (var i = 0; i < bytes.length; i += 3) {
    var n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
    var chars = Math.min(3, bytes.length - i) + 1;
    for (var j = 0; j < chars; j++) out += alphabet[(n >> (18 - 6 * j)) & 63];
  }
  return out;
}

function queryString(params) {
  var parts = [];
  Object.keys(params).forEach(function (k) {
    var v = params[k];
    if (v === undefined || v === null || v === "") return;
    parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(String(v)));
  });
  return parts.join("&");
}

// `viboplr://plugin/community/<path>?<params>` → { path, params }, else null.
function parseLink(url) {
  if (typeof url !== "string" || url.indexOf(LINK_PREFIX) !== 0) return null;
  var rest = url.slice(LINK_PREFIX.length);
  var q = rest.indexOf("?");
  var path = (q === -1 ? rest : rest.slice(0, q)).replace(/\/+$/, "");
  var params = {};
  if (q !== -1) {
    new URLSearchParams(rest.slice(q + 1)).forEach(function (v, k) {
      params[k] = v;
    });
  }
  return { path: path, params: params };
}

// The byline an imported sheet carries: its own author plus who shared it.
function importAuthor(item) {
  var by = item && item.publisher && item.publisher.login ? "@" + item.publisher.login : null;
  var own = item && typeof item.author === "string" && item.author.trim() ? item.author.trim() : null;
  var label = own && by ? own + " · via " + by : own || by || "Viboplr Community";
  return label.slice(0, MAX_AUTHOR_CHARS);
}

function plural(n, one, many) {
  return n + " " + (n === 1 ? one : many);
}

function errorText(e) {
  if (!e) return "Unknown error";
  return e.message || String(e);
}

// ---------------------------------------------------------------------------
// Modules
// ---------------------------------------------------------------------------
//
// Generic: every module gets a tab (search, sort, load more, rows from each
// item's card, "Open page", "Share" when the module has a website form) and a
// Mine section (what you shared, with Open page / Edit). INTEGRATIONS, keyed
// by kind, adds what only app code can do. A module with no integration still
// works — it just can't do more than the website does.

// Until the server answers (or when it can't be reached on a first start).
var BUILTIN_MODULES = [
  {
    kind: "cue_sheet",
    slug: "cue-sheets",
    name: "Cue sheets",
    singular: "cue sheet",
    plural: "cue sheets",
    notice: "",
    popularLabel: "Most imported",
    useNoun: ["import", "imports"],
    url: SERVER + "/cue-sheets",
    shareUrl: null,
  },
  {
    kind: "synced_lyrics",
    slug: "lyrics",
    name: "Synced lyrics",
    singular: "lyric sheet",
    plural: "synced lyrics",
    notice: "",
    popularLabel: "Most imported",
    useNoun: ["import", "imports"],
    url: SERVER + "/lyrics",
    shareUrl: null,
  },
  {
    kind: "mixtape",
    slug: "mixtapes",
    name: "Mixtapes",
    singular: "mixtape",
    plural: "mixtapes",
    notice: "A mixtape is a track list, not music: songs you can't get anywhere are skipped.",
    popularLabel: "Most played",
    useNoun: ["play", "plays"],
    url: SERVER + "/mixtapes",
    shareUrl: null,
  },
  {
    kind: "subsonic_server",
    slug: "servers",
    name: "Subsonic servers",
    singular: "Subsonic server",
    plural: "Subsonic servers",
    notice: "Listings carry their owner's shared login in plain text. Treat them as public.",
    popularLabel: "Most added",
    useNoun: ["add", "adds"],
    url: SERVER + "/servers",
    shareUrl: SERVER + "/servers/new",
    membersOnly: true,
  },
];

// A module's plural inside a sentence. Servers that predate `plural` only send
// `name`; lowercasing it is the fallback, not the rule, since it would turn
// "Subsonic servers" into "subsonic servers".
function pluralOf(m) {
  return typeof m.plural === "string" && m.plural ? m.plural : m.name.toLowerCase();
}

// A members-only module (the server says which) shows nothing until the user
// signs in: its reads answer 401 to anyone else.
function membersLocked(m) {
  return !!(m && m.membersOnly) && !state.token;
}

// Signing out takes members-only listings off the screen with the session.
function forgetMembersOnly() {
  state.modules.forEach(function (m) {
    if (m.membersOnly) delete state.browse[m.kind];
  });
}

// Only modules whose description is usable; anything else is ignored rather
// than breaking the view.
function validModules(list) {
  if (!Array.isArray(list)) return [];
  return list.filter(function (m) {
    return m && typeof m.kind === "string" && typeof m.name === "string" && typeof m.url === "string" && m.kind !== MINE;
  });
}

function moduleFor(kind) {
  for (var i = 0; i < state.modules.length; i++) if (state.modules[i].kind === kind) return state.modules[i];
  return null;
}

// The module as the server describes it, else as this build knows it.
function knownModule(kind) {
  var m = moduleFor(kind);
  if (m) return m;
  for (var i = 0; i < BUILTIN_MODULES.length; i++) if (BUILTIN_MODULES[i].kind === kind) return BUILTIN_MODULES[i];
  return null;
}

function currentModule() {
  return moduleFor(state.tab);
}

function uses(m, n) {
  var noun = m && Array.isArray(m.useNoun) ? m.useNoun[n === 1 ? 0 : 1] : n === 1 ? "use" : "uses";
  return n + " " + noun;
}

// Row actions render as small round buttons, which only fit a glyph; the
// label becomes the button's tooltip. An action without one keeps its label.
var ACTION_ICONS = {
  page: "↗",
  edit: "✎",
  import: "⬇",
  update: "↻",
  publish: "⇪",
  republish: "↻",
  unpublish: "✕",
  "sheet-page": "↗",
  "play-mixtape": "▶",
  "save-mixtape": "＋",
  "update-mixtape": "↻",
  "publish-playlist": "⇪",
  "republish-playlist": "↻",
  "unpublish-mixtape": "✕",
  "mixtape-page": "↗",
  "add-server": "＋",
  "import-lyrics": "⬇",
  "update-lyrics": "↻",
  "remove-lyrics": "✕",
  "unpublish-lyrics": "✕",
  "lyrics-page": "↗",
};

function withIcons(actions) {
  return actions.map(function (a) {
    return ACTION_ICONS[a.id] && !a.icon ? Object.assign({}, a, { icon: ACTION_ICONS[a.id] }) : a;
  });
}

// Any item → a row, from its card alone. An integration may then adjust it.
function cardRow(m, item) {
  var card = item.card || { title: item.title, facts: [] };
  var bits = (card.facts || []).slice();
  if (item.publisher && item.publisher.login) bits.push("@" + item.publisher.login);
  if (item.importCount) bits.push(uses(m, item.importCount));
  var row = { id: item.id, title: card.title || item.title, subtitle: bits.join(" · "), actions: ["page"] };
  var integration = INTEGRATIONS[m.kind];
  return integration && integration.row ? integration.row(item, row) : row;
}

function browseState(kind) {
  if (!state.browse[kind]) state.browse[kind] = { query: "", sort: "recent", page: 0, items: null, more: false };
  return state.browse[kind];
}

// ---------------------------------------------------------------------------
// Integrations: what app code does for a known module
// ---------------------------------------------------------------------------
//
//   actions    extra row actions [{ id, label }] (handlers live in ACTIONS)
//   row        (item, row) → row: badges, which actions this row shows
//   controls   () → nodes shown above the module's list
//   body       () → nodes replacing the generic list, or null for the generic one
//   load       () → Promise replacing the generic load, or null
//   mine       { title, nodes(), load() } — the module's Mine section, in
//              place of the generic "what you shared" list

var INTEGRATIONS = {
  cue_sheet: {
    actions: [
      { id: "import", label: "Import" },
      { id: "update", label: "Update" },
    ],
    row: function (item, row) {
      row.artistName = item.artistName || null;
      row.albumTitle = item.albumName || null;
      var imported = state.imports[songKey(item.title, item.artistName)];
      if (imported && imported.id === item.id) {
        if (imported.version < item.version) {
          row.badge = { label: "Update", variant: "accent" };
          row.actions = ["update", "page"];
        } else {
          row.badge = { label: "Imported", variant: "success" };
          row.actions = ["page"];
        }
      } else {
        row.actions = ["import", "page"];
      }
      return row;
    },
    controls: function () {
      return [
        {
          type: "select",
          label: "Show",
          action: "cue-scope",
          value: state.cueScope,
          options: [
            { value: "all", label: "All cue sheets" },
            { value: "song", label: "For one song" },
          ],
        },
      ];
    },
    body: function () {
      return state.cueScope === "song" ? songNodes() : null;
    },
    load: function () {
      return state.cueScope === "song" ? loadSong(state.song || currentSong()) : null;
    },
    mine: {
      title: "Cue sheets on this computer",
      load: function () {
        return api.cues.list().then(function (rows) {
          state.local = rows;
        });
      },
      nodes: function () {
        return mySheetNodes();
      },
    },
  },
  synced_lyrics: {
    actions: [
      { id: "import-lyrics", label: "Import" },
      { id: "update-lyrics", label: "Update" },
    ],
    row: function (item, row) {
      row.artistName = item.artistName || null;
      row.albumTitle = item.albumName || null;
      var imported = state.lyricsImports[songKey(item.title, item.artistName)];
      if (imported && imported.id === item.id) {
        if (imported.version < item.version) {
          row.badge = { label: "Update", variant: "accent" };
          row.actions = ["update-lyrics", "page"];
        } else {
          row.badge = { label: "Imported", variant: "success" };
          row.actions = ["page"];
        }
      } else {
        row.actions = ["import-lyrics", "page"];
      }
      return row;
    },
    mine: {
      title: "Synced lyrics",
      nodes: function () {
        return myLyricsNodes();
      },
    },
  },
  mixtape: {
    actions: [
      { id: "play-mixtape", label: "Play" },
      { id: "save-mixtape", label: "Save to Playlists" },
      { id: "update-mixtape", label: "Update" },
    ],
    row: function (item, row) {
      // Art for the row: the artist with the most tracks on it.
      row.artistName = (item.artists && item.artists[0]) || null;
      var saved = savedPlaylistFor(item.id);
      if (!saved) {
        row.actions = ["play-mixtape", "save-mixtape", "page"];
      } else if (savedVersion(saved) < item.version) {
        row.badge = { label: "Update", variant: "accent" };
        row.actions = ["play-mixtape", "update-mixtape", "page"];
      } else {
        row.badge = { label: "Saved", variant: "success" };
        row.actions = ["play-mixtape", "page"];
      }
      return row;
    },
    // The badges above need the saved playlists, so read them with the list.
    load: function () {
      return loadPlaylists().then(function () {
        return loadList("mixtape", 0);
      });
    },
    mine: {
      title: "Your playlists",
      load: function () {
        return loadPlaylists();
      },
      nodes: function () {
        return myPlaylistNodes();
      },
    },
  },
  subsonic_server: {
    actions: [{ id: "add-server", label: "Add" }],
    row: function (item, row) {
      row.actions = ["add-server", "page"];
      return row;
    },
  },
};

// ---------------------------------------------------------------------------
// Host plumbing
// ---------------------------------------------------------------------------

function randomBytes(n) {
  var bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return bytes;
}

function pkceChallenge(verifier) {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)).then(function (buf) {
    return base64url(new Uint8Array(buf));
  });
}

function notify(message, options) {
  if (api) api.ui.showNotification(message, options);
}

function fail(what, e) {
  api.log("error", what + ": " + errorText(e));
  notify(what + ": " + errorText(e));
}

// `code` is the server's machine-readable `error`, where it has one (the
// device sign-in answers: authorization_pending, slow_down, expired_token).
function requestError(message, status, code) {
  var e = new Error(message);
  e.status = status;
  e.code = code || null;
  return e;
}

// One request to the server. `auth` adds the bearer token and turns a 401 into
// a signed-out state (the token was revoked or the account suspended).
function request(method, path, body, auth) {
  var headers = { Accept: "application/json", "User-Agent": USER_AGENT };
  if (auth) {
    if (!state.token) return Promise.reject(requestError("Sign in with GitHub first.", 401));
    headers.Authorization = "Bearer " + state.token;
  }
  var init = { method: method, headers: headers, timeoutMs: TIMEOUT_MS };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return api.network.fetch(SERVER + path, init).then(function (resp) {
    if (resp.status === 204) return null;
    return resp.text().then(function (text) {
      var data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch (e) {
        data = null;
      }
      if (resp.status === 401 && auth) {
        sessionLost();
        throw requestError("Your Viboplr Community sign-in has ended. Sign in again.", 401);
      }
      if (resp.status >= 400) {
        throw requestError((data && data.error) || "Viboplr Community answered HTTP " + resp.status, resp.status, data && data.error);
      }
      // A 3xx here is a redirect the host refused to follow (it leads off
      // community.viboplr.com — a captive portal or a filtering proxy), and a
      // 2xx without JSON is nobody we know. Either way, say what came back.
      if (resp.status >= 300 || data === null) {
        api.log("warn", "Unexpected answer to " + method + " " + path + " (HTTP " + resp.status + "): " + String(text || "").slice(0, 200));
        var where = resp.headers && resp.headers.location ? " to " + resp.headers.location : "";
        throw requestError(
          resp.status >= 300
            ? "the request was redirected" + where + " (HTTP " + resp.status + ") — something on your network may be blocking community.viboplr.com"
            : /^\s*</.test(text || "")
              ? "a web page came back instead of Viboplr Community — a company proxy or filter on your network is intercepting community.viboplr.com"
              : "the server's answer wasn't readable (HTTP " + resp.status + ")",
          resp.status
        );
      }
      return data;
    });
  });
}

function saveSession() {
  return api.storage.set("session", state.token ? { token: state.token, user: state.user } : null);
}

function clearShared() {
  state.shared = {};
}

function sessionLost() {
  state.token = null;
  state.user = null;
  clearShared();
  forgetMembersOnly();
  saveSession().catch(function (e) {
    api.log("error", "Couldn't clear the stored session: " + errorText(e));
  });
  render();
}

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------

// The usual sign-in: the browser hands a one-time code back over the deep link.
function signIn() {
  if (state.auth && state.auth.mode === "link" && Date.now() - state.auth.at < AUTH_TTL_MS) {
    notify("Finish signing in in your browser, or cancel and start again.");
    return Promise.resolve();
  }
  stopSignIn();
  var verifier = base64url(randomBytes(32));
  var nonce = base64url(randomBytes(16));
  return pkceChallenge(verifier)
    .then(function (challenge) {
      state.auth = { mode: "link", state: nonce, verifier: verifier, at: Date.now() };
      render();
      return api.network.openUrl(
        SERVER + "/auth/github/start?" + queryString({ client: "app", state: nonce, code_challenge: challenge, code_challenge_method: "S256" })
      );
    })
    .catch(function (e) {
      stopSignIn();
      render();
      fail("Couldn't start signing in", e);
    });
}

function finishSignIn(params) {
  var pending = state.auth;
  if (!pending || pending.mode !== "link" || params.state !== pending.state) {
    api.log("warn", "Ignored a sign-in link that doesn't match a sign-in started here");
    return Promise.resolve();
  }
  state.auth = null;
  if (params.error) {
    render();
    notify("Sign-in cancelled.");
    return Promise.resolve();
  }
  if (Date.now() - pending.at > AUTH_TTL_MS || !params.code) {
    render();
    notify("That sign-in took too long. Start again.");
    return Promise.resolve();
  }
  return request("POST", "/auth/exchange", { code: params.code, verifier: pending.verifier, label: "Viboplr app" }).then(completeSignIn, function (e) {
    render();
    fail("Couldn't finish signing in", e);
  });
}

// The other sign-in, for when the deep link can't reach the app: a short code
// confirmed on the website, in any browser on any device.
function signInWithCode() {
  // Already waiting on a code: show the page again (its tab may be closed).
  if (state.auth && state.auth.mode === "device") return openSignInPage();
  // Waiting on the browser's link instead: that one is given up.
  stopSignIn();
  return request("POST", "/auth/device", { label: "Viboplr app" })
    .then(function (d) {
      if (!d || !d.deviceCode || !d.userCode) throw new Error("the server's answer had no sign-in code");
      var interval = Number(d.interval);
      var ttl = Number(d.expiresIn);
      state.auth = {
        mode: "device",
        deviceCode: d.deviceCode,
        userCode: d.userCode,
        url: d.verificationUriComplete || d.verificationUri || SERVER + "/device",
        intervalMs: (isFinite(interval) && interval >= 0 ? interval : DEVICE_POLL_DEFAULT_SECS) * 1000,
        expiresAt: Date.now() + (ttl > 0 ? ttl : DEVICE_TTL_DEFAULT_SECS) * 1000,
        timer: null,
      };
      render();
      schedulePoll(state.auth);
      return openSignInPage();
    })
    .catch(function (e) {
      stopSignIn();
      render();
      fail("Couldn't start signing in", e);
    });
}

// The code is in the view too, so a browser that won't open isn't the end:
// the person can type it at community.viboplr.com/device on any device.
function openSignInPage() {
  if (!state.auth || state.auth.mode !== "device") return Promise.resolve();
  return Promise.resolve(api.network.openUrl(state.auth.url)).catch(function (e) {
    fail("Couldn't open your browser", e);
  });
}

function stopSignIn() {
  if (state.auth && state.auth.timer) clearTimeout(state.auth.timer);
  state.auth = null;
}

function schedulePoll(pending) {
  pending.timer = setTimeout(function () {
    pending.timer = null;
    pollSignIn(pending);
  }, pending.intervalMs);
}

function expireSignIn() {
  stopSignIn();
  render();
  notify("The sign-in code expired. Sign in again for a new one.");
}

// One "has it been confirmed?" Every answer but a token means wait or stop;
// a sign-in cancelled (or restarted) meanwhile drops whatever comes back.
function pollSignIn(pending) {
  if (!api || state.auth !== pending) return Promise.resolve();
  if (Date.now() > pending.expiresAt) {
    expireSignIn();
    return Promise.resolve();
  }
  return request("POST", "/auth/device/token", { deviceCode: pending.deviceCode }).then(
    function (data) {
      if (!api || state.auth !== pending) return;
      state.auth = null;
      return completeSignIn(data);
    },
    function (e) {
      if (!api || state.auth !== pending) return;
      if (e.code === "authorization_pending") return schedulePoll(pending);
      if (e.code === "slow_down") {
        pending.intervalMs += DEVICE_POLL_DEFAULT_SECS * 1000;
        return schedulePoll(pending);
      }
      if (e.code === "expired_token") return expireSignIn();
      // Offline for a moment, or the server restarting: keep asking until the
      // code expires. Anything else (a proxy's page, a refusal) won't improve.
      if (!e.status || e.status >= 500) {
        api.log("warn", "Couldn't check the sign-in, trying again: " + errorText(e));
        return schedulePoll(pending);
      }
      stopSignIn();
      render();
      fail("Couldn't finish signing in", e);
    }
  );
}

function completeSignIn(data) {
  if (!data || !data.token || !data.user) {
    render();
    fail("Couldn't finish signing in", new Error("the server's answer had no session"));
    return Promise.resolve();
  }
  state.token = data.token;
  state.user = data.user;
  return saveSession()
    .then(function () {
      notify("Signed in to Viboplr Community as @" + state.user.login + ".");
      render();
      // The open tab may be one only members can see; load it now.
      var m = currentModule();
      return Promise.all([loadShared(), m && m.membersOnly ? loadTab() : null]);
    })
    .catch(function (e) {
      render();
      fail("Couldn't finish signing in", e);
    });
}

function signOut() {
  var revoke = state.token ? request("DELETE", "/v1/tokens/current", undefined, true) : Promise.resolve();
  return revoke
    .catch(function (e) {
      // Signing out locally still happens; the website's account page can
      // revoke the session later.
      api.log("warn", "Couldn't revoke the server session: " + errorText(e));
    })
    .then(function () {
      state.token = null;
      state.user = null;
      clearShared();
      forgetMembersOnly();
      return saveSession();
    })
    .then(function () {
      notify("Signed out of Viboplr Community.");
      render();
    });
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function withLoading(work) {
  state.loading = true;
  state.error = null;
  render();
  return work()
    .catch(function (e) {
      if (e && e.status !== 401) state.error = errorText(e);
      api.log("error", "Community request failed: " + errorText(e));
    })
    .then(function () {
      state.loading = false;
      render();
    });
}

// Ask the server what can be shared; keep the answer for the next start.
function loadModules() {
  return request("GET", "/v1/modules")
    .then(function (data) {
      var mods = validModules(data && data.modules);
      if (!mods.length) return;
      state.modules = mods;
      if (state.tab !== MINE && !moduleFor(state.tab)) state.tab = mods[0].kind;
      render();
      return api.storage.set("modules", mods);
    })
    .catch(function (e) {
      api.log("warn", "Couldn't load the module list, using the last known one: " + errorText(e));
    });
}

function loadList(kind, page) {
  var m = moduleFor(kind);
  if (membersLocked(m)) return Promise.resolve(render());
  var b = browseState(kind);
  page = page || 0;
  return withLoading(function () {
    var path = "/v1/items/search?" + queryString({ kind: kind, q: b.query, sort: b.sort, page: page });
    return request("GET", path, undefined, !!(m && m.membersOnly)).then(function (data) {
      b.items = page > 0 && b.items ? b.items.concat(data.items) : data.items;
      b.page = page;
      b.more = !!data.hasMore;
    });
  });
}

// The current module's tab: its integration's own load, else the generic list.
// Every visit refetches the first page — the rows already shown stay up while
// it loads — so what changed since (a mixtape republished, a sheet updated)
// shows without a restart.
function loadTab() {
  var m = currentModule();
  if (!m) return Promise.resolve(render());
  var integration = INTEGRATIONS[m.kind];
  var custom = integration && integration.load ? integration.load() : null;
  if (custom) return custom;
  return loadList(m.kind, 0);
}

// What this user shared, per module.
function loadShared() {
  if (!state.token) {
    clearShared();
    return Promise.resolve();
  }
  return request("GET", "/v1/me/items", undefined, true).then(function (data) {
    var byKind = {};
    data.items.forEach(function (item) {
      (byKind[item.kind] = byKind[item.kind] || []).push(item);
    });
    state.shared = byKind;
    render();
  });
}

function loadMine() {
  return withLoading(function () {
    var loads = state.modules.map(function (m) {
      var integration = INTEGRATIONS[m.kind];
      return integration && integration.mine && integration.mine.load ? integration.mine.load() : Promise.resolve();
    });
    return Promise.all(loads).then(loadShared);
  });
}

function switchTab(tab) {
  state.tab = tab === MINE || moduleFor(tab) ? tab : state.modules[0].kind;
  state.error = null;
  return state.tab === MINE ? loadMine() : loadTab();
}

function knownItem(id) {
  var lists = [state.songItems || []];
  Object.keys(state.browse).forEach(function (k) {
    lists.push(state.browse[k].items || []);
  });
  Object.keys(state.shared).forEach(function (k) {
    lists.push(state.shared[k]);
  });
  for (var i = 0; i < lists.length; i++) {
    for (var j = 0; j < lists[i].length; j++) if (lists[i][j].id === id) return lists[i][j];
  }
  return null;
}

// An item's page on the website (every item's JSON carries its own `url`).
function pageFor(id) {
  var item = knownItem(id);
  if (item) return item.url;
  var m = currentModule();
  return (m ? m.url : SERVER) + "/" + encodeURIComponent(id);
}

// ---------------------------------------------------------------------------
// Cue sheets
// ---------------------------------------------------------------------------

function cueModule() {
  return knownModule("cue_sheet");
}

function loadSong(song) {
  state.song = song;
  state.songItems = null;
  if (!song) return Promise.resolve(render());
  return withLoading(function () {
    return request("GET", "/v1/items?" + queryString({ kind: "cue_sheet", title: song.title, artist: song.artist })).then(function (data) {
      state.songItems = data.items;
    });
  });
}

function currentSong() {
  var t = api.playback && api.playback.getCurrentTrack ? api.playback.getCurrentTrack() : null;
  return t && t.title ? { title: t.title, artist: t.artist_name || null } : null;
}

// Narrow the cue sheets to one song (context menu, share link).
function showSong(song) {
  state.tab = "cue_sheet";
  state.cueScope = "song";
  return loadSong(song);
}

// Import a community sheet. Asks first when it would replace a local sheet
// that isn't this same item, untouched.
function importItem(id, confirmed) {
  return request("GET", "/v1/items/" + encodeURIComponent(id))
    .then(function (data) {
      var item = data.item;
      var key = songKey(item.title, item.artistName);
      return api.cues.get(item.title, item.artistName).then(function (existing) {
        var rec = state.imports[key];
        var sameImport = rec && existing && rec.id === item.id && rec.updatedAt === existing.updatedAt;
        if (existing && !confirmed && !sameImport) {
          state.confirm = { kind: "replace", id: item.id, title: item.title, artist: item.artistName, by: item.publisher.login };
          render();
          return;
        }
        var meta = { author: importAuthor(item) };
        if (item.albumName) meta.albumName = item.albumName;
        if (item.durationSecs) meta.durationSecs = item.durationSecs;
        return api.cues
          .set(item.title, item.artistName, item.payload, meta)
          .then(function (row) {
            state.imports[key] = { id: item.id, version: item.version, updatedAt: row.updatedAt };
            return api.storage.set("imports", state.imports);
          })
          .then(function () {
            countUse(item.id);
            state.local = null;
            notify("Imported the cue sheet for “" + item.title + "”. It plays in Now Playing.");
            render();
          });
      });
    })
    .catch(function (e) {
      fail("Couldn't import that cue sheet", e);
    });
}

function countUse(id) {
  request("POST", "/v1/items/" + encodeURIComponent(id) + "/imported").catch(function (e) {
    api.log("warn", "Couldn't count the use: " + errorText(e));
  });
}

function requireSignIn(what) {
  if (state.token) return true;
  notify("Sign in with GitHub to " + what + ".", { action: { label: "Sign in", id: "sign-in" } });
  return false;
}

function sharedSheet(key) {
  var list = state.shared.cue_sheet || [];
  for (var i = 0; i < list.length; i++) if (songKey(list[i].title, list[i].artistName) === key) return list[i];
  return null;
}

function publishSong(title, artist) {
  if (!requireSignIn("publish")) return Promise.resolve();
  return api.cues
    .get(title, artist)
    .then(function (row) {
      if (!row) {
        notify("There's no cue sheet for “" + title + "” yet.");
        return;
      }
      var key = songKey(row.title, row.artistName);
      var rec = state.imports[key];
      if (rec && rec.updatedAt === row.updatedAt) {
        notify("This sheet came from the community unchanged, so it isn't yours to publish.");
        return;
      }
      return request(
        "POST",
        "/v1/items",
        {
          kind: "cue_sheet",
          title: row.title,
          artistName: row.artistName,
          albumName: row.albumName,
          durationSecs: row.durationSecs,
          author: row.author,
          sheet: row.sheet,
        },
        true
      ).then(function (data) {
        var list = (state.shared.cue_sheet || []).filter(function (it) {
          return it.id !== data.item.id;
        });
        state.shared.cue_sheet = list.concat([data.item]);
        state.lastPublishedUrl = data.item.url;
        notify((data.created ? "Published “" : "Updated “") + row.title + "” on Viboplr Community.", {
          action: { label: "Open page", id: "open-last-published" },
        });
        render();
      });
    })
    .catch(function (e) {
      fail("Couldn't publish", e);
    });
}

function unpublishSheet(key) {
  var item = sharedSheet(key);
  if (!item) return Promise.resolve();
  return request("DELETE", "/v1/items/" + encodeURIComponent(item.id), undefined, true)
    .then(function () {
      state.shared.cue_sheet = (state.shared.cue_sheet || []).filter(function (it) {
        return it.id !== item.id;
      });
      notify("Unpublished “" + item.title + "”. Your own copy is unchanged.");
      render();
    })
    .catch(function (e) {
      fail("Couldn't unpublish", e);
    });
}

function localByKey(key) {
  var rows = state.local || [];
  for (var i = 0; i < rows.length; i++) if (songKey(rows[i].title, rows[i].artistName) === key) return rows[i];
  return null;
}

// One local sheet → a row in Mine, given what the user published and imported.
function localRow(sheet, published, imported) {
  var key = songKey(sheet.title, sheet.artistName);
  var cues = (sheet.sheet && sheet.sheet.cues) || [];
  var bits = [];
  if (sheet.artistName) bits.push(sheet.artistName);
  bits.push(plural(cues.length, "cue", "cues") + " · " + (sheet.sheet && sheet.sheet.mode === "clip" ? "lyric clip" : "cards"));
  if (sheet.author) bits.push(sheet.author);
  var row = { id: key, title: sheet.title, subtitle: bits.join(" · "), artistName: sheet.artistName || null, albumTitle: sheet.albumName || null };
  var untouchedImport = imported && imported.updatedAt === sheet.updatedAt;
  if (published) {
    row.badge = { label: "Published", variant: "success" };
    row.actions = ["republish", "unpublish", "sheet-page"];
  } else if (untouchedImport) {
    row.badge = { label: "From the community", variant: "muted" };
    row.actions = [];
  } else {
    row.actions = ["publish"];
  }
  return row;
}

function songNodes() {
  if (!state.song) {
    return [{ type: "text", content: "Play a song, or right-click a track and choose “Find shared cue sheets”." }];
  }
  var nodes = [{ type: "text", content: (state.song.artist ? state.song.artist + " — " : "") + state.song.title, className: "ds-heading" }];
  if (state.loading && !state.songItems) nodes.push({ type: "loading", message: "Looking in the community…" });
  else if (state.songItems && state.songItems.length === 0) nodes.push({ type: "text", content: "Nobody has shared a cue sheet for this song yet." });
  else if (state.songItems) nodes.push(listNode(cueModule(), state.songItems));
  return nodes;
}

function mySheetNodes() {
  var rows = state.local || [];
  if (rows.length === 0) {
    return [{ type: "text", content: "You have no cue sheets yet. Ask your AI assistant to write one for a song, or import one." }];
  }
  return [
    {
      type: "track-row-list",
      selectable: true,
      selectionMode: "single",
      artwork: "cached",
      contextMenu: false,
      actions: withIcons([
        { id: "publish", label: "Publish" },
        { id: "republish", label: "Update online" },
        { id: "unpublish", label: "Unpublish" },
        { id: "sheet-page", label: "Open page" },
      ]),
      items: rows.map(function (sheet) {
        var key = songKey(sheet.title, sheet.artistName);
        return localRow(sheet, sharedSheet(key), state.imports[key]);
      }),
    },
  ];
}

// A share link (viboplr://plugin/community/open?id=…). A cue sheet shows its
// song and asks to import; a mixtape opens its tab and asks to save.
function openShared(id) {
  if (!id) return Promise.resolve();
  api.ui.navigateToView(VIEW);
  return request("GET", "/v1/items/" + encodeURIComponent(id), undefined, !!state.token)
    .then(function (data) {
      var item = data.item;
      if (item.kind === "mixtape") {
        state.tab = "mixtape";
        state.confirm = { kind: "save-mixtape", id: item.id, title: item.title, by: item.publisher.login, count: payloadTracks(item).length };
        return loadTab();
      }
      if (item.kind === "synced_lyrics") {
        state.confirm = { kind: "import-lyrics", id: item.id, title: item.title, artist: item.artistName, by: item.publisher.login };
        return findLyrics(item.title, item.artistName);
      }
      state.confirm = { kind: "import", id: item.id, title: item.title, artist: item.artistName, by: item.publisher.login };
      return showSong({ title: item.title, artist: item.artistName });
    })
    .catch(function (e) {
      if (e && e.status === 404) notify("That isn't in the community any more.");
      else if (e && e.status === 401) notify("That link is for signed-in members. Sign in to Viboplr Community, then open it again.");
      else fail("Couldn't open that link", e);
    });
}

// ---------------------------------------------------------------------------
// Synced lyrics
// ---------------------------------------------------------------------------
//
// Importing is a one-off act: the shared LRC becomes the song's lyrics through
// the host's api.lyrics.save — the same write as editing them in the app — and
// from then on the app shows it like any lyrics it has. The plugin is not a
// lyrics provider and looks nothing up while anyone listens. It only remembers
// which songs it imported (and which version), for the Imported / Update
// badges and for Undo, which hands the song back to the user's provider chain.

function trackEntity(title, artist, album) {
  var e = { kind: "track", name: title };
  if (artist) e.artistName = artist;
  if (album) e.albumTitle = album;
  return e;
}

function canFetchInfo() {
  return !!(api.informationTypes && typeof api.informationTypes.fetch === "function");
}

function canSaveLyrics() {
  return !!(api.lyrics && typeof api.lyrics.save === "function");
}

// The lyrics the app has for a song (its cache first, else its providers), or null.
function currentLyrics(title, artist) {
  if (!canFetchInfo()) return Promise.resolve(null);
  return api.informationTypes
    .fetch("lyrics", trackEntity(title, artist))
    .then(function (out) {
      return out && out.status === "ok" && out.value ? out.value : null;
    })
    .catch(function (e) {
      api.log("warn", "Couldn't read the lyrics for " + title + ": " + errorText(e));
      return null;
    });
}

function lyricsSource(value) {
  if (value && value.local) return "a lyrics file next to the song";
  return value && value._meta && value._meta.providerName ? value._meta.providerName : null;
}

// Import community lyrics. Asks first when the song already has synced lyrics
// that didn't come from this same item.
function importLyrics(id, confirmed) {
  if (!canSaveLyrics()) {
    notify("Importing synced lyrics needs Viboplr 1.0.94 or later.");
    return Promise.resolve();
  }
  return fetchItem(id)
    .then(function (item) {
      var key = songKey(item.title, item.artistName);
      var lrc = item.payload && item.payload.lrc;
      if (!lrc) {
        notify("Those lyrics are empty.");
        return;
      }
      var rec = state.lyricsImports[key];
      var ours = rec && rec.id === item.id;
      var check = confirmed || ours ? Promise.resolve(null) : currentLyrics(item.title, item.artistName);
      return check.then(function (existing) {
        if (existing && existing.kind === "synced" && !confirmed) {
          state.confirm = {
            kind: "replace-lyrics",
            id: item.id,
            title: item.title,
            artist: item.artistName,
            by: item.publisher.login,
            from: lyricsSource(existing),
          };
          render();
          return;
        }
        return api.lyrics
          .save({ title: item.title, artistName: item.artistName || null, albumTitle: item.albumName || null }, { text: lrc, kind: "synced" })
          .then(function () {
            state.lyricsImports[key] = {
              id: item.id,
              version: item.version,
              title: item.title,
              artist: item.artistName || null,
              by: item.publisher && item.publisher.login,
              url: item.url,
            };
            return api.storage.set("lyricsImports", state.lyricsImports);
          })
          .then(function () {
            countUse(item.id);
            notify("Imported synced lyrics for “" + item.title + "”. They scroll along in Now Playing.");
            render();
          });
      });
    })
    .catch(function (e) {
      if (e && e.status === 404) notify("Those lyrics aren't in the community any more.");
      else fail("Couldn't import those lyrics", e);
    });
}

// Undo an import: forget it, and ask the user's providers for the song again,
// so whatever the app would have shown comes back.
function removeLyrics(key) {
  var rec = state.lyricsImports[key];
  if (!rec) return Promise.resolve();
  delete state.lyricsImports[key];
  return api.storage
    .set("lyricsImports", state.lyricsImports)
    .then(function () {
      if (!canFetchInfo()) return null;
      return api.informationTypes.fetch("lyrics", trackEntity(rec.title, rec.artist), { force: true });
    })
    .then(function () {
      notify("Undid the import of “" + rec.title + "”. It shows the lyrics your providers find again.");
      render();
    })
    .catch(function (e) {
      fail("Couldn't undo that import", e);
    });
}

function sharedLyrics(key) {
  var list = state.shared.synced_lyrics || [];
  for (var i = 0; i < list.length; i++) if (songKey(list[i].title, list[i].artistName) === key) return list[i];
  return null;
}

// Publish the synced lyrics the app has for a song, wherever they came from —
// a lyrics site, a file next to the song, an edit, an earlier import.
function publishLyrics(title, artist, album) {
  if (!requireSignIn("publish")) return Promise.resolve();
  if (!canFetchInfo()) {
    notify("This version of Viboplr doesn't let plugins read lyrics.");
    return Promise.resolve();
  }
  return currentLyrics(title, artist)
    .then(function (value) {
      if (!value || typeof value.text !== "string" || !value.text.trim()) {
        notify("There are no lyrics for “" + title + "” to publish.");
        return;
      }
      if (value.kind !== "synced") {
        notify("“" + title + "” only has plain lyrics. Only synced lyrics can be shared.");
        return;
      }
      var body = { kind: "synced_lyrics", title: title, artistName: artist || undefined, albumName: album || undefined, lrc: value.text };
      var now = api.playback && api.playback.getCurrentTrack ? api.playback.getCurrentTrack() : null;
      if (now && songKey(now.title, now.artist_name) === songKey(title, artist) && now.duration_secs) body.durationSecs = now.duration_secs;
      return request("POST", "/v1/items", body, true).then(function (data) {
        var list = (state.shared.synced_lyrics || []).filter(function (it) {
          return it.id !== data.item.id;
        });
        state.shared.synced_lyrics = list.concat([data.item]);
        state.lastPublishedUrl = data.item.url;
        notify((data.created ? "Published the synced lyrics for “" : "Updated the synced lyrics for “") + title + "”.", {
          action: { label: "Open page", id: "open-last-published" },
        });
        render();
      });
    })
    .catch(function (e) {
      fail("Couldn't publish", e);
    });
}

function unpublishLyrics(key) {
  var item = sharedLyrics(key);
  if (!item) return Promise.resolve();
  return request("DELETE", "/v1/items/" + encodeURIComponent(item.id), undefined, true)
    .then(function () {
      state.shared.synced_lyrics = (state.shared.synced_lyrics || []).filter(function (it) {
        return it.id !== item.id;
      });
      notify("Unpublished the synced lyrics for “" + item.title + "”. Your own copy is unchanged.");
      render();
    })
    .catch(function (e) {
      fail("Couldn't unpublish", e);
    });
}

// Search the Synced lyrics tab for one song (context menu).
function findLyrics(title, artist) {
  state.tab = "synced_lyrics";
  state.error = null;
  browseState("synced_lyrics").query = (artist ? artist + " " : "") + title;
  return loadList("synced_lyrics", 0);
}

function myLyricsNodes() {
  var rows = [];
  Object.keys(state.lyricsImports).forEach(function (key) {
    var rec = state.lyricsImports[key];
    rows.push({
      id: "imported:" + key,
      title: rec.title,
      subtitle: [rec.artist, rec.by ? "by @" + rec.by : null].filter(Boolean).join(" · "),
      artistName: rec.artist || null,
      badge: { label: "Imported", variant: "muted" },
      actions: ["remove-lyrics", "lyrics-page"],
    });
  });
  (state.shared.synced_lyrics || []).forEach(function (item) {
    rows.push({
      id: "published:" + songKey(item.title, item.artistName),
      title: item.title,
      subtitle: [item.artistName, plural(item.lineCount || 0, "line", "lines")].filter(Boolean).join(" · "),
      artistName: item.artistName || null,
      albumTitle: item.albumName || null,
      badge: { label: "Published", variant: "success" },
      actions: ["unpublish-lyrics", "lyrics-page"],
    });
  });
  if (!rows.length) {
    return [{ type: "text", content: "No synced lyrics yet. Right-click a track to publish its synced lyrics, or import some from the Synced lyrics tab." }];
  }
  return [
    {
      type: "track-row-list",
      selectable: true,
      selectionMode: "single",
      artwork: "cached",
      contextMenu: false,
      actions: withIcons([
        { id: "remove-lyrics", label: "Undo import" },
        { id: "unpublish-lyrics", label: "Unpublish" },
        { id: "lyrics-page", label: "Open page" },
      ]),
      items: rows,
    },
  ];
}

// A Mine row id → its song key and which list it came from.
function lyricsRowKey(id) {
  var s = String(id || "");
  var i = s.indexOf(":");
  return i === -1 ? null : { list: s.slice(0, i), key: s.slice(i + 1) };
}

// ---------------------------------------------------------------------------
// Mixtapes
// ---------------------------------------------------------------------------

function mixtapeKey(name) {
  return "mixtape:" + fold(name);
}

// Any track shape we hold (a playlist row, a queue entry, a published track)
// → what a mixtape carries. Metadata only: no path, URI or image, ever.
function mixtapeTracks(tracks) {
  var out = [];
  (tracks || []).forEach(function (t) {
    var title = t && typeof t.title === "string" ? t.title.trim() : "";
    if (!title) return;
    var artist = t.artistName !== undefined ? t.artistName : t.artist_name;
    var album = t.albumName !== undefined ? t.albumName : t.album_title;
    var secs = t.durationSecs !== undefined ? t.durationSecs : t.duration_secs;
    out.push({
      title: title,
      artistName: artist || null,
      albumName: album || null,
      durationSecs: typeof secs === "number" && secs > 0 ? secs : null,
    });
  });
  return out;
}

function hasPlaylistsApi() {
  return !!(api.playlists && typeof api.playlists.list === "function");
}

function loadPlaylists() {
  if (!hasPlaylistsApi()) {
    state.playlists = [];
    return Promise.resolve();
  }
  return api.playlists
    .list()
    .then(function (rows) {
      state.playlists = rows || [];
    })
    .catch(function (e) {
      // Not fatal: the tab still lists and plays mixtapes, just without badges.
      api.log("error", "Couldn't read your playlists: " + errorText(e));
      state.playlists = [];
    });
}

function communityMeta(playlist) {
  var m = playlist && playlist.metadata;
  return m && typeof m.communityId === "string" ? m : null;
}

function savedVersion(playlist) {
  var m = communityMeta(playlist);
  return m && typeof m.communityVersion === "number" ? m.communityVersion : 0;
}

function savedPlaylistFor(id) {
  var rows = state.playlists || [];
  for (var i = 0; i < rows.length; i++) {
    var m = communityMeta(rows[i]);
    if (m && m.communityId === id) return rows[i];
  }
  return null;
}

function sharedMixtape(name) {
  var key = mixtapeKey(name);
  var list = state.shared.mixtape || [];
  for (var i = 0; i < list.length; i++) if (mixtapeKey(list[i].title) === key) return list[i];
  return null;
}

function fetchItem(id) {
  return request("GET", "/v1/items/" + encodeURIComponent(id)).then(function (data) {
    return data.item;
  });
}

function payloadTracks(item) {
  return mixtapeTracks(item && item.payload && item.payload.tracks);
}

function playMixtape(id) {
  if (!api.playback || typeof api.playback.playTracks !== "function") {
    notify("This version of Viboplr can't play a mixtape from here. Save it to your Playlists instead.");
    return Promise.resolve();
  }
  return fetchItem(id)
    .then(function (item) {
      var tracks = payloadTracks(item);
      if (!tracks.length) {
        notify("That mixtape has no tracks.");
        return;
      }
      api.playback.playTracks(
        tracks.map(function (t) {
          return { title: t.title, artist_name: t.artistName, album_title: t.albumName, duration_secs: t.durationSecs };
        }),
        0,
        { name: item.title, source: "playlist", description: (item.payload && item.payload.description) || null }
      );
      countUse(item.id);
    })
    .catch(function (e) {
      if (e && e.status === 404) notify("That mixtape isn't in the community any more.");
      else fail("Couldn't play that mixtape", e);
    });
}

// Save a community mixtape as a playlist. A newer version replaces the copy
// saved before (the new one is written first, so a failure loses nothing).
function saveMixtape(id) {
  if (!hasPlaylistsApi() || typeof api.playlists.save !== "function") {
    notify("This version of Viboplr can't save playlists from a plugin.");
    return Promise.resolve();
  }
  return Promise.all([fetchItem(id), state.playlists ? Promise.resolve() : loadPlaylists()])
    .then(function (vals) {
      var item = vals[0];
      var previous = savedPlaylistFor(item.id);
      if (previous && savedVersion(previous) >= item.version) {
        notify("“" + item.title + "” is already in your Playlists.");
        return;
      }
      var tracks = payloadTracks(item);
      if (!tracks.length) {
        notify("That mixtape has no tracks.");
        return;
      }
      var by = item.publisher && item.publisher.login ? item.publisher.login : null;
      return api.playlists
        .save({
          name: item.title,
          description: (item.payload && item.payload.description) || undefined,
          metadata: { communityId: item.id, communityVersion: item.version, communityBy: by },
          tracks: tracks.map(function (t) {
            return { title: t.title, artistName: t.artistName || undefined, albumName: t.albumName || undefined, durationSecs: t.durationSecs || undefined };
          }),
        })
        .then(function () {
          return previous ? api.playlists.delete(previous.id) : null;
        })
        .then(function () {
          if (!previous) countUse(item.id);
          return loadPlaylists();
        })
        .then(function () {
          notify((previous ? "Updated “" : "Saved “") + item.title + "” in your Playlists.");
          render();
        });
    })
    .catch(function (e) {
      if (e && e.status === 404) notify("That mixtape isn't in the community any more.");
      else fail("Couldn't save that mixtape", e);
    });
}

function publishMixtape(name, description, tracks) {
  var list = mixtapeTracks(tracks);
  if (!list.length) {
    notify("There's nothing to publish: “" + name + "” has no tracks.");
    return Promise.resolve();
  }
  return request("POST", "/v1/items", { kind: "mixtape", title: name, description: description || undefined, tracks: list }, true).then(function (data) {
    var shared = (state.shared.mixtape || []).filter(function (it) {
      return it.id !== data.item.id;
    });
    state.shared.mixtape = shared.concat([data.item]);
    state.lastPublishedUrl = data.item.url;
    notify((data.created ? "Published “" : "Updated “") + name + "” on Viboplr Community.", {
      action: { label: "Open page", id: "open-last-published" },
    });
    render();
  });
}

function playlistById(id) {
  var rows = state.playlists || [];
  for (var i = 0; i < rows.length; i++) if (String(rows[i].id) === String(id)) return rows[i];
  return null;
}

function publishPlaylist(id, fallbackName) {
  if (!requireSignIn("publish")) return Promise.resolve();
  if (!hasPlaylistsApi()) {
    notify("This version of Viboplr doesn't let plugins read playlists.");
    return Promise.resolve();
  }
  var read = state.playlists ? Promise.resolve() : loadPlaylists();
  return read
    .then(function () {
      var playlist = playlistById(id);
      if (playlist && communityMeta(playlist)) {
        notify("This playlist came from the community, so it isn't yours to publish.");
        return;
      }
      var name = (playlist && playlist.name) || fallbackName;
      return api.playlists.getTracks(Number(id)).then(function (tracks) {
        return publishMixtape(name, playlist && playlist.description, tracks);
      });
    })
    .catch(function (e) {
      fail("Couldn't publish", e);
    });
}

function publishQueue(name) {
  name = String(name || "").trim();
  if (!name) {
    notify("Give the mixtape a name first.");
    return Promise.resolve();
  }
  if (!requireSignIn("publish")) return Promise.resolve();
  var queue = api.playback && typeof api.playback.getQueue === "function" ? api.playback.getQueue() : null;
  if (!queue || !queue.tracks || !queue.tracks.length) {
    notify("The queue is empty.");
    return Promise.resolve();
  }
  return publishMixtape(name, null, queue.tracks).catch(function (e) {
    fail("Couldn't publish", e);
  });
}

function unpublishMixtape(name) {
  var item = sharedMixtape(name);
  if (!item) return Promise.resolve();
  return request("DELETE", "/v1/items/" + encodeURIComponent(item.id), undefined, true)
    .then(function () {
      state.shared.mixtape = (state.shared.mixtape || []).filter(function (it) {
        return it.id !== item.id;
      });
      notify("Unpublished “" + item.title + "”. Your playlist is unchanged.");
      render();
    })
    .catch(function (e) {
      fail("Couldn't unpublish", e);
    });
}

// One saved playlist → a row in Mine, given what the user published.
function playlistRow(playlist, published) {
  var bits = [plural(playlist.trackCount || 0, "track", "tracks")];
  var row = { id: String(playlist.id), title: playlist.name, subtitle: "", actions: [] };
  var from = communityMeta(playlist);
  if (from) {
    if (from.communityBy) bits.push("by @" + from.communityBy);
    row.badge = { label: "From the community", variant: "muted" };
  } else if (published) {
    row.badge = { label: "Published", variant: "success" };
    row.actions = ["republish-playlist", "unpublish-mixtape", "mixtape-page"];
  } else {
    row.actions = ["publish-playlist"];
  }
  row.subtitle = bits.join(" · ");
  return row;
}

// The app's own playlists: Liked / Disliked (seeded under these names, which
// the app doesn't let anyone edit) and the mixes it regenerates, which all
// carry a `recipe` in their metadata. The host doesn't say which is which, so
// this is how the plugin tells.
var SPECIAL_PLAYLIST_NAMES = ["Liked Tracks", "Disliked Tracks"];

function isSpecialPlaylist(p) {
  var m = p && p.metadata;
  if (m && typeof m.recipe === "string") return true;
  return !m && SPECIAL_PLAYLIST_NAMES.indexOf(p && p.name) !== -1;
}

// The playlists Mine offers: the user's own. Never a special one, and never an
// empty one — unless it is already published, so it can still be unpublished.
function minePlaylists() {
  return (state.playlists || []).filter(function (p) {
    if (isSpecialPlaylist(p)) return false;
    if (!communityMeta(p) && sharedMixtape(p.name)) return true;
    return (p.trackCount || 0) > 0;
  });
}

function myPlaylistNodes() {
  var nodes = [];
  var rows = minePlaylists();
  if (rows.length === 0) {
    nodes.push({ type: "text", content: "You have no saved playlists yet. Save one from the queue, or save a mixtape someone shared." });
  } else {
    nodes.push({
      type: "track-row-list",
      selectable: true,
      selectionMode: "single",
      contextMenu: false,
      actions: withIcons([
        { id: "publish-playlist", label: "Publish" },
        { id: "republish-playlist", label: "Update online" },
        { id: "unpublish-mixtape", label: "Unpublish" },
        { id: "mixtape-page", label: "Open page" },
      ]),
      items: rows.map(function (p) {
        return playlistRow(p, communityMeta(p) ? null : sharedMixtape(p.name));
      }),
    });
  }
  nodes.push({ type: "text", content: "Or publish what's in the queue right now:", className: "ds-muted" });
  nodes.push({ type: "search-input", placeholder: "Name the mixtape", action: "publish-queue", value: "", submitOnly: true, buttonLabel: "Publish the queue" });
  return nodes;
}

// ---------------------------------------------------------------------------
// Servers
// ---------------------------------------------------------------------------

// Offer a listed server through the app's own Add Server dialog. A listing
// carries its (public) login, so the row we have is enough.
function addServer(id) {
  if (!api.collections || typeof api.collections.requestAdd !== "function") {
    // Older app: the website's Add button opens the same dialog by deep link.
    var listed = knownItem(id);
    return api.network.openUrl(listed ? listed.url : knownModule("subsonic_server").url + "/" + encodeURIComponent(id));
  }
  var known = knownItem(id);
  var item = known
    ? Promise.resolve(known)
    : request("GET", "/v1/items/" + encodeURIComponent(id), undefined, !!state.token).then(function (d) {
        return d.item;
      });
  return item
    .then(function (item) {
      return api.collections
        .requestAdd({ kind: "subsonic", name: item.title, url: item.address, username: item.username || "", password: item.password || "" })
        .then(function () {
          countUse(item.id);
        });
    })
    .catch(function (e) {
      if (e && e.status === 404) notify("That server isn't listed any more.");
      else if (e && e.status === 401) notify("Sign in to Viboplr Community to add a shared Subsonic server.");
      else fail("Couldn't add that server", e);
    });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function setHeader() {
  if (typeof api.ui.setViewHeader !== "function") return;
  var status;
  var account;
  if (state.auth) {
    status = { variant: "warning", label: "Signing in…" };
    account = [{ label: "Cancel sign-in", action: "cancel-sign-in", variant: "secondary" }];
  } else if (state.user) {
    status = { variant: "success", label: "@" + state.user.login };
    account = [{ label: "Sign out", action: "sign-out", variant: "secondary" }];
  } else {
    status = { variant: "muted", label: "Signed out" };
    account = [
      { label: "Sign in with GitHub", action: "sign-in", variant: "accent" },
      { label: "Sign in with a code", action: "sign-in-code", variant: "secondary" },
    ];
  }
  api.ui.setViewHeader(VIEW, { status: status, actions: account.concat([{ label: "Open website", action: "open-site", variant: "secondary" }]) });
}

function banner(text, variant, buttons) {
  return {
    type: "layout",
    direction: "horizontal",
    className: "ds-banner ds-banner--" + (variant || "warning"),
    children: [{ type: "text", content: text }].concat(buttons || []),
  };
}

// A module's items as a list. Row actions: the integration's, then "Open page".
function listNode(m, items) {
  var integration = INTEGRATIONS[m.kind] || {};
  return {
    type: "track-row-list",
    selectable: true,
    selectionMode: "single",
    artwork: "cached",
    contextMenu: false,
    actions: withIcons((integration.actions || []).concat([{ id: "page", label: "Open page" }])),
    items: items.map(function (item) {
      return cardRow(m, item);
    }),
  };
}

function shareButton(m) {
  return m.shareUrl ? { type: "button", label: "Share a " + m.singular, action: "share", variant: "secondary", data: { kind: m.kind } } : null;
}

// One module's tab: notice, its controls, then its list (or the integration's own body).
function moduleNodes(m) {
  if (membersLocked(m)) {
    return [
      banner(m.name + " are for signed-in members. Sign in with GitHub to see them.", "muted", [
        { type: "button", label: "Sign in", action: "sign-in", variant: "accent" },
      ]),
    ].concat(noticeNodes(m));
  }
  var integration = INTEGRATIONS[m.kind] || {};
  var nodes = [];
  var controls = integration.controls ? integration.controls() : [];
  var body = integration.body ? integration.body() : null;
  if (body) return nodes.concat(controls, body, noticeNodes(m));
  var b = browseState(m.kind);
  nodes.push({ type: "search-input", placeholder: "Search " + pluralOf(m), action: "search", value: b.query, submitOnly: true, buttonLabel: "Search" });
  var row = controls.concat([
    {
      type: "select",
      label: "Sort",
      action: "sort",
      value: b.sort,
      options: [
        { value: "recent", label: "Recent" },
        { value: "popular", label: m.popularLabel || "Popular" },
      ],
    },
  ]);
  var share = shareButton(m);
  if (share) row.push(share);
  nodes.push({ type: "layout", direction: "horizontal", children: row });
  nodes = nodes.concat(noticeNodes(m));
  if (state.loading && !b.items) nodes.push({ type: "loading", message: "Loading " + pluralOf(m) + "…" });
  else if (b.items && b.items.length === 0) {
    nodes.push({ type: "text", content: b.query ? "Nothing matches that search." : "Nothing shared yet." });
  } else if (b.items) {
    nodes.push(listNode(m, b.items));
    if (b.more) nodes.push({ type: "button", label: state.loading ? "Loading…" : "Load more", action: "more", variant: "secondary", disabled: state.loading });
  }
  return nodes;
}

function noticeNodes(m) {
  return m.notice ? [{ type: "text", content: m.notice, className: "ds-muted" }] : [];
}

// Mine: one section per module — the integration's own, else what you shared.
function mineNodes() {
  var nodes = [];
  if (!state.token) {
    nodes.push(banner("Sign in with GitHub to share, and to see what you've shared.", "muted", [{ type: "button", label: "Sign in", action: "sign-in", variant: "accent" }]));
  }
  if (state.loading && !state.local && !Object.keys(state.shared).length) {
    nodes.push({ type: "loading", message: "Reading what's yours…" });
    return nodes;
  }
  state.modules.forEach(function (m) {
    var integration = INTEGRATIONS[m.kind];
    if (integration && integration.mine) {
      nodes.push({ type: "section", title: integration.mine.title, children: integration.mine.nodes() });
    } else {
      nodes.push({ type: "section", title: "Your " + pluralOf(m), children: sharedNodes(m) });
    }
  });
  return nodes;
}

// The generic Mine section: the items you shared in a module.
function sharedNodes(m) {
  var share = shareButton(m);
  var tail = share ? [share] : [];
  if (!state.token) return [{ type: "text", content: "Sign in to see the " + pluralOf(m) + " you shared." }].concat(tail);
  var mine = state.shared[m.kind] || [];
  if (!mine.length) return [{ type: "text", content: "You haven't shared any " + pluralOf(m) + "." }].concat(tail);
  var actions = [{ id: "page", label: "Open page" }];
  if (m.shareUrl) actions.push({ id: "edit", label: "Edit" });
  return [
    {
      type: "track-row-list",
      selectable: true,
      selectionMode: "single",
      contextMenu: false,
      actions: withIcons(actions),
      items: mine.map(function (item) {
        var row = cardRow(m, item);
        row.actions = actions.map(function (a) {
          return a.id;
        });
        return row;
      }),
    },
  ].concat(tail);
}

function confirmNode() {
  var c = state.confirm;
  var forSong = "“" + c.title + "”" + (c.artist ? " by " + c.artist : "");
  if (c.kind === "import-lyrics") {
    return {
      type: "confirm",
      title: "Import these synced lyrics?",
      message: "@" + c.by + "'s synced lyrics for " + forSong + " will scroll along in Now Playing.",
      confirmLabel: "Import",
      confirmAction: "confirm-import-lyrics",
      cancelAction: "cancel-confirm",
      data: { id: c.id },
    };
  }
  if (c.kind === "replace-lyrics") {
    return {
      type: "confirm",
      title: "Use these synced lyrics instead?",
      message:
        forSong + " already has synced lyrics" + (c.from ? " (from " + c.from + ")" : "") + ". Importing @" + c.by +
        "'s shows theirs instead — undo the import later (Community → Mine) and yours come back.",
      confirmLabel: "Import",
      confirmAction: "confirm-replace-lyrics",
      cancelAction: "cancel-confirm",
      data: { id: c.id },
    };
  }
  if (c.kind === "save-mixtape") {
    return {
      type: "confirm",
      title: "Save this mixtape?",
      message: "@" + c.by + "'s mixtape “" + c.title + "” (" + plural(c.count, "track", "tracks") + ") will be added to your Playlists. You can also just play it from the list below.",
      confirmLabel: "Save to Playlists",
      confirmAction: "confirm-save-mixtape",
      cancelAction: "cancel-confirm",
      data: { id: c.id },
    };
  }
  var song = "“" + c.title + "”" + (c.artist ? " by " + c.artist : "");
  if (c.kind === "replace") {
    return {
      type: "confirm",
      title: "Replace your cue sheet?",
      message: "You already have a cue sheet for " + song + ". Importing @" + c.by + "'s replaces it.",
      confirmLabel: "Replace",
      confirmVariant: "danger",
      confirmAction: "confirm-replace",
      cancelAction: "cancel-confirm",
      data: { id: c.id },
    };
  }
  return {
    type: "confirm",
    title: "Import this cue sheet?",
    message: "@" + c.by + "'s cue sheet for " + song + " will play over that song in Now Playing.",
    confirmLabel: "Import",
    confirmAction: "confirm-import",
    cancelAction: "cancel-confirm",
    data: { id: c.id },
  };
}

function render() {
  if (!api) return;
  setHeader();
  var children = [
    {
      type: "tabs",
      action: "tab",
      activeTab: state.tab,
      tabs: state.modules
        .map(function (m) {
          return { id: m.kind, label: m.name };
        })
        .concat([{ id: MINE, label: "Mine" }]),
    },
  ];
  if (state.confirm) children.push(confirmNode());
  if (state.auth && state.auth.mode === "link") {
    children.push(
      banner("Finish signing in in your browser. Viboplr will pick it up when you're done. If it doesn't, sign in with a code instead.", "muted", [
        { type: "button", label: "Use a code instead", action: "sign-in-code", variant: "secondary" },
        { type: "button", label: "Cancel", action: "cancel-sign-in", variant: "secondary" },
      ])
    );
  } else if (state.auth) {
    children.push(
      banner(
        "To sign in, confirm the code " + state.auth.userCode + " in your browser, or enter it at " + SERVER.replace(/^https?:\/\//, "") + "/device on any device. Viboplr signs you in as soon as you do.",
        "muted",
        [
          { type: "button", label: "Open page", action: "open-sign-in-page", variant: "accent" },
          { type: "button", label: "Cancel", action: "cancel-sign-in", variant: "secondary" },
        ]
      )
    );
  }
  if (state.error) {
    children.push(banner("Couldn't reach Viboplr Community: " + state.error, "warning", [{ type: "button", label: "Try again", action: "retry", variant: "accent" }]));
  }
  var m = currentModule();
  var body = state.tab === MINE || !m ? mineNodes() : moduleNodes(m);
  api.ui.setViewData(VIEW, { type: "layout", direction: "vertical", children: children.concat(body) }, { scrollKey: state.tab });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function rowId(payload) {
  return payload && (payload.itemId || (payload.selectedIds && payload.selectedIds[0]));
}

var ACTIONS = {
  // --- every module ---
  tab: function (p) {
    return switchTab(p && p.tabId);
  },
  search: function (p) {
    var m = currentModule();
    if (!m) return;
    browseState(m.kind).query = (p && p.query) || "";
    return loadList(m.kind, 0);
  },
  sort: function (p) {
    var m = currentModule();
    if (!m) return;
    browseState(m.kind).sort = p && p.value === "popular" ? "popular" : "recent";
    return loadList(m.kind, 0);
  },
  more: function () {
    var m = currentModule();
    if (!m) return;
    return loadList(m.kind, browseState(m.kind).page + 1);
  },
  page: function (p) {
    return api.network.openUrl(pageFor(rowId(p)));
  },
  edit: function (p) {
    return api.network.openUrl(pageFor(rowId(p)) + "/edit");
  },
  share: function (p) {
    var m = moduleFor(p && p.kind) || currentModule();
    return m && m.shareUrl ? api.network.openUrl(m.shareUrl) : undefined;
  },
  retry: function () {
    state.error = null;
    return state.tab === MINE ? loadMine() : loadTab();
  },
  // --- cue sheets ---
  "cue-scope": function (p) {
    state.cueScope = p && p.value === "song" ? "song" : "all";
    state.error = null;
    return loadTab();
  },
  import: function (p) {
    return importItem(rowId(p), false);
  },
  update: function (p) {
    return importItem(rowId(p), true);
  },
  publish: function (p) {
    var row = localByKey(rowId(p));
    return row ? publishSong(row.title, row.artistName) : Promise.resolve();
  },
  republish: function (p) {
    return ACTIONS.publish(p);
  },
  unpublish: function (p) {
    return unpublishSheet(rowId(p));
  },
  "sheet-page": function (p) {
    var item = sharedSheet(rowId(p));
    return item ? api.network.openUrl(item.url) : Promise.resolve();
  },
  "confirm-import": function (p) {
    state.confirm = null;
    render();
    return importItem(p && p.id, false);
  },
  "confirm-replace": function (p) {
    state.confirm = null;
    render();
    return importItem(p && p.id, true);
  },
  "cancel-confirm": function () {
    state.confirm = null;
    render();
  },
  // --- synced lyrics ---
  "import-lyrics": function (p) {
    return importLyrics(rowId(p), false);
  },
  "update-lyrics": function (p) {
    return importLyrics(rowId(p), true);
  },
  "confirm-import-lyrics": function (p) {
    state.confirm = null;
    render();
    return importLyrics(p && p.id, false);
  },
  "confirm-replace-lyrics": function (p) {
    state.confirm = null;
    render();
    return importLyrics(p && p.id, true);
  },
  "remove-lyrics": function (p) {
    var r = lyricsRowKey(rowId(p));
    return r ? removeLyrics(r.key) : Promise.resolve();
  },
  "unpublish-lyrics": function (p) {
    var r = lyricsRowKey(rowId(p));
    return r ? unpublishLyrics(r.key) : Promise.resolve();
  },
  "lyrics-page": function (p) {
    var r = lyricsRowKey(rowId(p));
    if (!r) return Promise.resolve();
    var rec = r.list === "imported" ? state.lyricsImports[r.key] : sharedLyrics(r.key);
    return rec && rec.url ? api.network.openUrl(rec.url) : Promise.resolve();
  },
  // --- mixtapes ---
  "play-mixtape": function (p) {
    return playMixtape(rowId(p));
  },
  "save-mixtape": function (p) {
    return saveMixtape(rowId(p));
  },
  "update-mixtape": function (p) {
    return saveMixtape(rowId(p));
  },
  "confirm-save-mixtape": function (p) {
    state.confirm = null;
    render();
    return saveMixtape(p && p.id);
  },
  "publish-playlist": function (p) {
    var playlist = playlistById(rowId(p));
    return playlist ? publishPlaylist(playlist.id, playlist.name) : Promise.resolve();
  },
  "republish-playlist": function (p) {
    return ACTIONS["publish-playlist"](p);
  },
  "unpublish-mixtape": function (p) {
    var playlist = playlistById(rowId(p));
    return playlist ? unpublishMixtape(playlist.name) : Promise.resolve();
  },
  "mixtape-page": function (p) {
    var playlist = playlistById(rowId(p));
    var item = playlist && sharedMixtape(playlist.name);
    return item ? api.network.openUrl(item.url) : Promise.resolve();
  },
  "publish-queue": function (p) {
    return publishQueue(p && p.query);
  },
  // --- servers ---
  "add-server": function (p) {
    return addServer(rowId(p));
  },
  // --- account ---
  "sign-in": function () {
    return signIn();
  },
  "sign-in-code": function () {
    return signInWithCode();
  },
  "open-sign-in-page": function () {
    return openSignInPage();
  },
  "cancel-sign-in": function () {
    stopSignIn();
    render();
  },
  "sign-out": function () {
    return signOut();
  },
  "open-site": function () {
    return api.network.openUrl(SERVER);
  },
  "open-last-published": function () {
    return state.lastPublishedUrl ? api.network.openUrl(state.lastPublishedUrl) : Promise.resolve();
  },
};

function onDeepLink(url) {
  var link = parseLink(url);
  if (!link) return;
  if (link.path === "auth") finishSignIn(link.params);
  else if (link.path === "open") openShared(link.params.id);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function activate(pluginApi) {
  api = pluginApi;
  state = freshState();
  Object.keys(ACTIONS).forEach(function (id) {
    api.ui.onAction(id, ACTIONS[id]);
  });
  api.contextMenu.onAction("find-cues", function (target) {
    if (!target || !target.title) return;
    api.ui.navigateToView(VIEW);
    return showSong({ title: target.title, artist: target.artistName || null });
  });
  api.contextMenu.onAction("publish-cues", function (target) {
    if (!target || !target.title) return;
    return publishSong(target.title, target.artistName || null);
  });
  api.contextMenu.onAction("find-lyrics", function (target) {
    if (!target || !target.title) return;
    api.ui.navigateToView(VIEW);
    return findLyrics(target.title, target.artistName || null);
  });
  api.contextMenu.onAction("publish-lyrics", function (target) {
    if (!target || !target.title) return;
    return publishLyrics(target.title, target.artistName || null, target.albumTitle || null);
  });
  api.contextMenu.onAction("publish-mixtape", function (target) {
    if (!target || target.playlistId === undefined || target.playlistId === null) return;
    return publishPlaylist(target.playlistId, target.playlistName || "Untitled mixtape");
  });
  api.network.onDeepLink(onDeepLink);

  var restored = Promise.all([
    api.storage.get("session"),
    api.storage.get("imports"),
    api.storage.get("modules"),
    api.storage.get("lyricsImports"),
  ]).then(function (vals) {
    var session = vals[0];
    if (session && session.token) {
      state.token = session.token;
      state.user = session.user || null;
    }
    state.imports = vals[1] || {};
    var cached = validModules(vals[2]);
    if (cached.length) {
      state.modules = cached;
      state.tab = cached[0].kind;
    }
    state.lyricsImports = vals[3] || {};
  });
  restored
    .catch(function (e) {
      api.log("error", "Couldn't restore the plugin's state: " + errorText(e));
    })
    .then(function () {
      render();
      // Fill the first tab shortly after launch rather than inside it:
      // activation runs before the app is idle, and the view may never open.
      firstLoadTimer = setTimeout(function () {
        firstLoadTimer = null;
        if (!api) return;
        loadModules().then(function () {
          if (api && state.tab !== MINE) loadTab();
        });
      }, FIRST_LOAD_DELAY_MS);
    });
  return restored;
}

function deactivate() {
  if (firstLoadTimer) clearTimeout(firstLoadTimer);
  firstLoadTimer = null;
  if (state) stopSignIn();
  api = null;
}

return {
  activate: activate,
  deactivate: deactivate,
  // Exposed for tests.
  _songKey: songKey,
  _base64url: base64url,
  _parseLink: parseLink,
  _importAuthor: importAuthor,
  _cardRow: function (m, item) {
    return cardRow(m, item);
  },
  _localRow: localRow,
  _mixtapeTracks: mixtapeTracks,
  _playlistRow: playlistRow,
  _builtinModules: BUILTIN_MODULES,
  _loadModules: function () {
    return loadModules();
  },
  _state: function () {
    return state;
  },
};
