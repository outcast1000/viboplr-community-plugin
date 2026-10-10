// viboplr-community-plugin — Viboplr Community client: what Viboplr listeners
// share with each other (cue sheets, servers, and whatever comes next).
//
// Design notes:
//  - MODULES COME FROM THE SERVER. GET /v1/modules lists what can be shared,
//    and every item carries a `card` (title, facts, in-Viboplr action), so a
//    new module gets a tab and a section on You here with no plugin release.
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
//    import) is kept in this plugin's storage. That is what lets You tell an
//    untouched import (not ours to republish) from one the user has changed.
//  - A MIXTAPE IS A TRACK LIST. Publishing sends title/artist/album/length
//    only — never a track's source (a file path names the publisher's home
//    folder; a plugin URI plays only where that plugin is installed). Played
//    or saved here, every entry is metadata-only and the host's resolvers find
//    a copy. A saved mixtape remembers where it came from in its playlist
//    `metadata` ({ communityId, communityVersion }), so You can tell it apart
//    from the user's own and the tab can offer an update.
//  - AN IMPORT IS A ONE-OFF WRITE. Shared synced lyrics become the song's
//    lyrics through api.lyrics.save, like an edit in the app; the plugin is not
//    a lyrics provider and looks nothing up while anyone listens.
//  - NOT READY IS A BANNER. A server that can't be reached is shown inside the
//    view with a Retry, never as a toast (plugin view design guidelines).
//  - MUSIC LIVES ON VIBOPLR'S OWN PAGES. Cue sheets, synced lyrics, likes
//    and comments about a song, album or artist are a "Community" tab on
//    that page (a `plugin_view` information type), not tabs of this view. The
//    view is Discover (search + what's new, opening those pages) · Mixtapes ·
//    Subsonic servers · You.
//  - NOTHING IS ASKED WHILE MUSIC PLAYS unless the user switched it on: the
//    Now Playing item and the seek-bar ticks (timed comments) both name every
//    song played to the server, so both start off.

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
var USER_AGENT = "Viboplr-Community-Plugin/1.0(+https://github.com/outcast1000/viboplr-community-plugin)";
var MAX_AUTHOR_CHARS = 64;
var FIRST_LOAD_DELAY_MS = 3000;
var MINE = "you";
var DISCOVER = "discover";
// The Community tab on each kind of page (information type ids: one per
// entity kind, since a plugin's type ids are unique).
var TAB_TYPES = { track: "community_track", album: "community_album", artist: "community_artist" };

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
    // The tab: "discover", a module's kind (Mixtapes, Subsonic servers), or "you".
    tab: DISCOVER,
    // Discover: song/album/artist search and the activity feed.
    discover: { query: "", results: null, feed: null, feedPage: 0, feedMore: false },
    // Subjects as the server last described them: by id (for opening one) and
    // a one-minute cache of lookups by name (resolveSubject). The header line,
    // the mini player item and the ticks share its anonymous entries; the tab
    // always asks again, as the member, and caches that apart.
    subjectsById: {},
    subjectLookups: {},
    // The Community tab's data per page, by tabKey(entity).
    tabs: {},
    // Seek-bar ticks for the playing song's timed comments. Off by default:
    // with them on, every song played is named to the server.
    ticks: false,
    // The track whose ticks were last asked for, so it's asked once.
    ticksKey: null,
    // Send the likes made in the app to Community. Off by default: a like on
    // Community is public, and it names the song to the server.
    syncLikes: false,
    // Scrobbling: send the songs played to Community. Off by default. The
    // queue holds plays not yet sent, saved across restarts.
    scrobble: false,
    playQueue: [],
    // Comments posted from a tab this session: the comment box's stateKey.
    commentsPosted: 0,
    // Per module: { query, sort, page, items, more }.
    browse: {},
    // Per module: the items this user shared (GET /v1/me/items).
    shared: {},
    loading: false,
    error: null,
    // --- cue sheets ---
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
// section on You (what you shared, with Open page / Edit). INTEGRATIONS, keyed
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
    area: "music",
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
    area: "music",
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
    area: "mixtapes",
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
    area: "servers",
  },
];

// A module's area (the server's `area`; for servers from before it: mixtapes
// and members-only servers are their own areas, everything else is music).
function areaOf(m) {
  if (m && typeof m.area === "string") return m.area;
  if (m && m.membersOnly) return "servers";
  return m && m.kind === "mixtape" ? "mixtapes" : "music";
}

// Music modules have no tab: their items live on Viboplr's own song pages.
function tabModules() {
  return state.modules.filter(function (m) {
    return areaOf(m) !== "music";
  });
}

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
    return m && typeof m.kind === "string" && typeof m.name === "string" && typeof m.url === "string" && m.kind !== MINE && m.kind !== DISCOVER;
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
//   mine       { title, nodes(), load() } — the module's section on You, in
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
  redrawTabs(false);
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
      return Promise.all([loadShared(), m && m.membersOnly ? loadTab() : null, redrawTabs(true), sendPlays()]);
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
      return redrawTabs(false);
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
      if (!isTab(state.tab)) state.tab = DISCOVER;
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

function isTab(tab) {
  return (
    tab === MINE ||
    tab === DISCOVER ||
    tabModules().some(function (m) {
      return m.kind === tab;
    })
  );
}

function switchTab(tab) {
  state.tab = isTab(tab) ? tab : DISCOVER;
  state.error = null;
  if (state.tab === MINE) return loadMine();
  if (state.tab === DISCOVER) return loadDiscover();
  return loadTab();
}

function knownItem(id) {
  var lists = [];
  Object.keys(state.tabs).forEach(function (k) {
    var t = state.tabs[k];
    lists.push(t.cues || [], t.lyrics || []);
  });
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
// What's shared about a song
// ---------------------------------------------------------------------------
//
// One call (GET /v1/subjects/resolve) says how many of each kind exist for a
// song. It is asked only when someone looks: the track page's header line, or
// the Now Playing item — which is off until the user switches it on, because
// with it on every song played is named to the server.

// "Nothing shared" is an answer too, so the cache holds empties.
var SUBJECT_TTL_MS = 60 * 1000;

function lookupKey(kind, name, artist) {
  return kind + ":" + (kind === "artist" ? "" : fold(artist)) + ":" + fold(name);
}

// What the server knows about one song, album (by its album artist) or artist,
// or null when nothing was ever shared about it (404 — or a server from before
// subjects, which answers 404 to the route itself). Cached briefly and shared,
// in flight too: a page open asks for its header line and its Community tab at
// once.
//
// Anonymous unless `asMember`: the header line, the Now Playing item and the
// seek-bar ticks look songs up as they play, and with a token attached the
// server could tie every song played to the signed-in account. Only the
// Community tab — which the user opened, and which shows whether they like it —
// asks as a member. The two are cached apart, since only one carries `liked`.
function resolveSubject(kind, name, artist, fresh, asMember) {
  var member = !!(asMember && state.token);
  var key = (member ? "member|" : "") + lookupKey(kind, name, artist);
  var hit = state.subjectLookups[key];
  if (!fresh && hit && Date.now() - hit.at < SUBJECT_TTL_MS) return hit.promise;
  var q = kind === "track" ? { kind: kind, title: name, artist: artist } : kind === "album" ? { kind: kind, name: name, artist: artist } : { kind: kind, name: name };
  var promise = request("GET", "/v1/subjects/resolve?" + queryString(q), undefined, member)
    .then(function (data) {
      var s = (data && data.subject) || null;
      if (s) state.subjectsById[s.id] = s;
      return s;
    })
    .catch(function (e) {
      if (e && e.status === 404) return null;
      delete state.subjectLookups[key];
      throw e;
    });
  state.subjectLookups[key] = { at: Date.now(), promise: promise };
  return promise;
}

function forgetSubject(kind, name, artist) {
  var key = lookupKey(kind, name, artist);
  delete state.subjectLookups[key];
  delete state.subjectLookups["member|" + key];
}

// { [kind]: n } for one song; {} when nothing is shared.
function songCounts(title, artist) {
  return resolveSubject("track", title, artist).then(function (s) {
    return s ? Object.assign({}, s.counts || {}, s.likes ? { _likes: s.likes } : {}, s.plays ? { _plays: s.plays } : {}) : {};
  });
}

// The counts in the server's module order, named the way the module names
// itself; kinds this build has never heard of are left out.
function countParts(counts) {
  var parts = [];
  var kinds = state.modules.map(function (m) {
    return m.kind;
  });
  Object.keys(counts || {}).forEach(function (k) {
    if (kinds.indexOf(k) < 0 && k.charAt(0) !== "_") kinds.push(k);
  });
  kinds.forEach(function (kind) {
    var n = Number(counts && counts[kind]);
    var m = knownModule(kind);
    if (!m || !(n > 0)) return;
    parts.push({ n: n, noun: n === 1 ? m.singular || m.name : pluralOf(m) });
  });
  return parts;
}

// Now Playing: "Community: 2 cue sheets · 1 lyric sheet", or "" for none.
function countsText(counts) {
  var parts = countParts(counts);
  if (!parts.length) return "";
  return (
    "Community: " +
    parts
      .map(function (p) {
        return p.n + " " + p.noun;
      })
      .join(" · ")
  );
}

// The track page's header line (`title_line`): "♥ 128 · 2 cue sheets · 1 lyric
// sheet on Community", or null for none.
function countsTitleLine(counts) {
  var parts = countParts(counts);
  var likes = Number(counts && counts._likes) || 0;
  var plays = Number(counts && counts._plays) || 0;
  if (!parts.length && !likes && !plays) return null;
  var items = parts.map(function (p) {
    return { value: p.n, label: p.noun };
  });
  if (plays) items.unshift({ value: plays, label: plays === 1 ? "play" : "plays" });
  if (likes) items.unshift({ value: "♥ " + likes, label: "" });
  items[items.length - 1].label += (items[items.length - 1].label ? " " : "") + "on Community";
  return { items: items };
}

function registerSongCounts() {
  if (api.informationTypes && typeof api.informationTypes.onFetch === "function") {
    api.informationTypes.onFetch("community_shared", function (entity) {
      if (!entity || !entity.name) return Promise.resolve({ status: "not_found" });
      return songCounts(entity.name, entity.artistName || null)
        .then(function (counts) {
          var value = countsTitleLine(counts);
          return value ? { status: "ok", value: value } : { status: "not_found" };
        })
        .catch(function (e) {
          api.log("warn", "Couldn't read what's shared for a song: " + errorText(e));
          return { status: "error" };
        });
    });
  }
  if (api.nowPlayingInfo && typeof api.nowPlayingInfo.registerItem === "function") {
    api.nowPlayingInfo.registerItem({ id: "shared", label: "Shared on Community", priority: 200, defaultEnabled: false });
    api.nowPlayingInfo.onFetch("shared", function (track) {
      if (!track || !track.title) return Promise.resolve({ status: "empty" });
      return songCounts(track.title, track.artist_name || null)
        .then(function (counts) {
          var text = countsText(counts);
          return text ? { status: "ok", text: text } : { status: "empty" };
        })
        .catch(function (e) {
          api.log("warn", "Couldn't read what's shared for the playing song: " + errorText(e));
          return { status: "error" };
        });
    });
  }
}

// ---------------------------------------------------------------------------
// Cue sheets
// ---------------------------------------------------------------------------

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

// The album artist of a song's album, so a compilation track files under
// "Various Artists" — the album the app's own album page asks about — rather
// than under its performer. The playing track carries it; otherwise the
// library copy does. Null when neither knows (the server then uses the
// track's artist, as before).
function albumArtistFor(title, artist, album) {
  if (!album) return Promise.resolve(null);
  var want = songKey(title, artist);
  var now = api.playback && typeof api.playback.getCurrentTrack === "function" ? api.playback.getCurrentTrack() : null;
  if (now && songKey(now.title, now.artist_name) === want && fold(now.album_title) === fold(album)) {
    return Promise.resolve(now.album_artist_name || null);
  }
  if (!api.library || typeof api.library.ftsTracks !== "function") return Promise.resolve(null);
  return api.library
    .ftsTracks(title, { limit: 25 })
    .then(function (rows) {
      var hit = (rows || []).filter(function (t) {
        return songKey(t.title, t.artist_name) === want && fold(t.album_title) === fold(album);
      })[0];
      return (hit && hit.album_artist_name) || null;
    })
    .catch(function (e) {
      api.log("warn", "Couldn't look up the album artist of “" + title + "”: " + errorText(e));
      return null;
    });
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
      return albumArtistFor(row.title, row.artistName, row.albumName).then(function (albumArtist) {
        return request(
          "POST",
          "/v1/items",
          {
            kind: "cue_sheet",
            title: row.title,
            artistName: row.artistName,
            albumName: row.albumName,
            albumArtistName: albumArtist || undefined,
            durationSecs: row.durationSecs,
            author: row.author,
            sheet: row.sheet,
          },
          true
        );
      }).then(function (data) {
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

// One local sheet → a row on You, given what the user published and imported.
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

// A share link (viboplr://plugin/community/open?id=…). A cue sheet or synced
// lyrics ask to import (in Discover); a mixtape opens its tab and asks to save.
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
      state.confirm = {
        kind: item.kind === "synced_lyrics" ? "import-lyrics" : "import",
        id: item.id,
        title: item.title,
        artist: item.artistName,
        by: item.publisher.login,
      };
      return switchTab(DISCOVER);
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
//
// A cached answer is used at any age: what the app has is what's shown, and what
// a publish should send, so a stale row must not trigger a provider walk. Only a
// song with no usable cached lyrics at all goes to the providers.
function currentLyrics(title, artist) {
  if (!canFetchInfo()) return Promise.resolve(null);
  var entity = trackEntity(title, artist);
  var cached =
    typeof api.informationTypes.getValue === "function"
      ? api.informationTypes.getValue("lyrics", entity).catch(function (e) {
          api.log("warn", "Couldn't read cached lyrics for " + title + ": " + errorText(e));
          return null;
        })
      : Promise.resolve(null);
  return cached
    .then(function (row) {
      if (row && row.status === "ok" && row.value && typeof row.value.text === "string" && row.value.text.trim()) {
        return { status: "ok", value: row.value };
      }
      return api.informationTypes.fetch("lyrics", entity);
    })
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
// that didn't come from this same item — in the view, or through `ask(confirm)`
// when the caller shows the question somewhere else (the Community tab).
function importLyrics(id, confirmed, ask) {
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
          var question = {
            kind: "replace-lyrics",
            id: item.id,
            title: item.title,
            artist: item.artistName,
            by: item.publisher.login,
            from: lyricsSource(existing),
          };
          if (ask) ask(question);
          else {
            state.confirm = question;
            render();
          }
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
// The core reports instead of toasting, so the menu item and the assistant tool
// share it: it resolves { status: "published" | "updated", item } or
// { status: "no-lyrics" | "plain-only" }, and rejects when it can't try or the
// server says no (signed out, lyrics unreadable, network, a 4xx).
function publishLyricsCore(title, artist, album) {
  if (!state.token) return Promise.reject(requestError("Sign in with GitHub first.", 401));
  if (!canFetchInfo()) return Promise.reject(new Error("This version of Viboplr doesn't let plugins read lyrics."));
  return currentLyrics(title, artist).then(function (value) {
    if (!value || typeof value.text !== "string" || !value.text.trim()) return { status: "no-lyrics" };
    if (value.kind !== "synced") return { status: "plain-only" };
    var body = { kind: "synced_lyrics", title: title, artistName: artist || undefined, albumName: album || undefined, lrc: value.text };
    var now = api.playback && api.playback.getCurrentTrack ? api.playback.getCurrentTrack() : null;
    if (now && songKey(now.title, now.artist_name) === songKey(title, artist) && now.duration_secs) body.durationSecs = now.duration_secs;
    return albumArtistFor(title, artist, album)
      .then(function (albumArtist) {
        if (albumArtist) body.albumArtistName = albumArtist;
        return request("POST", "/v1/items", body, true);
      })
      .then(function (data) {
        var list = (state.shared.synced_lyrics || []).filter(function (it) {
          return it.id !== data.item.id;
        });
        state.shared.synced_lyrics = list.concat([data.item]);
        state.lastPublishedUrl = data.item.url;
        render();
        return { status: data.created ? "published" : "updated", item: data.item };
      });
  });
}

function publishLyrics(title, artist, album) {
  if (!requireSignIn("publish")) return Promise.resolve();
  return publishLyricsCore(title, artist, album)
    .then(function (out) {
      if (out.status === "no-lyrics") notify("There are no lyrics for “" + title + "” to publish.");
      else if (out.status === "plain-only") notify("“" + title + "” only has plain lyrics. Only synced lyrics can be shared.");
      else {
        notify((out.status === "published" ? "Published the synced lyrics for “" : "Updated the synced lyrics for “") + title + "”.", {
          action: { label: "Open page", id: "open-last-published" },
        });
      }
    })
    .catch(function (e) {
      fail("Couldn't publish", e);
    });
}

// The spelling the library uses for a song. The app caches lyrics under the
// song's exact title and artist, but an assistant types them from memory
// ("yesterday", no artist), which misses that cache and sends the song back to
// the lyrics providers — possibly publishing a different copy than the one the
// user has. Match loosely (case and accents, as songKey does) and adopt the
// library's own spelling. No artist given and several artists match: ask for one
// rather than guess. Not in the library: use what was given.
function canonicalSong(title, artist, album) {
  var given = { title: title, artist: artist, album: album };
  if (!api.library || typeof api.library.ftsTracks !== "function") return Promise.resolve(given);
  return api.library
    .ftsTracks(title, { limit: 50 })
    .then(function (rows) {
      var hits = (rows || []).filter(function (t) {
        return fold(t.title) === fold(title) && (!artist || fold(t.artist_name) === fold(artist));
      });
      if (!hits.length) return given;
      var artists = {};
      hits.forEach(function (t) {
        artists[fold(t.artist_name)] = true;
      });
      if (Object.keys(artists).length > 1) {
        throw new Error(
          "“" + title + "” is by several artists in Viboplr (" +
            hits.map(function (t) { return t.artist_name; }).filter(function (a, i, all) { return all.indexOf(a) === i; }).join(", ") +
            "). Call again with artistName."
        );
      }
      var hit = hits[0];
      var wantAlbum = album ? hits.filter(function (t) { return fold(t.album_title) === fold(album); })[0] : null;
      return { title: hit.title, artist: hit.artist_name || artist, album: (wantAlbum && wantAlbum.album_title) || album || hit.album_title || null };
    })
    .catch(function (e) {
      if (e && /several artists/.test(e.message)) throw e;
      api.log("warn", "Couldn't look up “" + title + "” in the library: " + errorText(e));
      return given;
    });
}

// The assistant's version: request/response, so the caller learns what happened.
// It publishes only what the app already has for the song — it never takes
// lyrics from the caller — and the "Plugin actions" switch gates it.
function publishLyricsTool(args) {
  var title = args && typeof args.title === "string" ? args.title.trim() : "";
  if (!title) throw new Error("title is required.");
  var artist = args && typeof args.artistName === "string" && args.artistName.trim() ? args.artistName.trim() : null;
  var album = args && typeof args.albumName === "string" && args.albumName.trim() ? args.albumName.trim() : null;
  if (!state.token) {
    throw new Error("Not signed in to Viboplr Community. Ask the user to sign in with GitHub in the Community view (You tab); you can't do that for them.");
  }
  return canonicalSong(title, artist, album).then(function (song) {
    title = song.title;
    return publishLyricsCore(song.title, song.artist, song.album);
  }).then(function (out) {
    if (out.status === "no-lyrics") throw new Error("Viboplr has no lyrics for “" + title + "”. Nothing was published.");
    if (out.status === "plain-only") throw new Error("“" + title + "” only has plain lyrics in Viboplr; only synced lyrics can be shared. Nothing was published.");
    return { status: out.status, id: out.item.id, url: out.item.url };
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

// A row id on You → its song key and which list it came from.
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

// One saved playlist → a row on You, given what the user published.
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

// The playlists You offers: the user's own. Never a special one, and never an
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
// Opening Viboplr's own pages
// ---------------------------------------------------------------------------

// A song, album or artist page in Viboplr, on its Community tab. Something not
// in the library still gets its page, built from the name. Older apps open the
// page without choosing the tab.
function openInApp(kind, name, artistName, albumTitle) {
  if (!name) return;
  var ref = { name: name };
  if (artistName) ref.artistName = artistName;
  if (albumTitle) ref.albumTitle = albumTitle;
  if (typeof api.ui.navigateToEntity === "function") {
    api.ui.navigateToEntity(kind, ref, { tab: TAB_TYPES[kind] });
    return;
  }
  api.ui.requestAction("navigate-to-" + kind, ref);
}

function openSubject(s) {
  if (s) openInApp(s.kind, s.name, s.kind === "artist" ? null : s.artistName);
}

// viboplr://plugin/community/subject?id=… — the website's "Open in Viboplr".
function openSubjectLink(id) {
  if (!id) return Promise.resolve();
  return request("GET", "/v1/subjects/" + encodeURIComponent(id))
    .then(function (data) {
      state.subjectsById[data.subject.id] = data.subject;
      openSubject(data.subject);
    })
    .catch(function (e) {
      if (e && e.status === 404) notify("That isn't on Viboplr Community any more.");
      else fail("Couldn't open that link", e);
    });
}

// ---------------------------------------------------------------------------
// Discover: search + what's new
// ---------------------------------------------------------------------------

var KIND_LABELS = { track: "Song", album: "Album", artist: "Artist" };

function ago(ts) {
  var d = Math.max(0, Math.floor(Date.now() / 1000) - Number(ts || 0));
  if (d < 60) return "just now";
  if (d < 3600) return Math.floor(d / 60) + " min";
  if (d < 86400) return Math.floor(d / 3600) + " h";
  return Math.floor(d / 86400) + " d";
}

// "2 cue sheets · 3 comments · ♥ 12" for a subject.
function subjectFacts(s) {
  var bits = countParts(s.counts).map(function (p) {
    return p.n + " " + p.noun;
  });
  if (s.comments) bits.push(plural(s.comments, "comment", "comments"));
  if (s.likes) bits.push("♥ " + s.likes);
  return bits;
}

// The subject's picture as the server matched it (a song's is its album's
// cover, else its artist's photo): the small thumbnail, and only one served
// by Community itself. Without one the row keeps the host's own art for the
// names (artwork: "cached"), else none.
function subjectArt(s) {
  var url = s && s.art && s.art.small;
  return typeof url === "string" && url.indexOf(SERVER + "/art/") === 0 ? url : undefined;
}

function subjectRow(s) {
  var lead = [KIND_LABELS[s.kind] || s.kind];
  if (s.kind !== "artist" && s.artistName) lead.push(s.artistName);
  return {
    id: "subject:" + s.id,
    title: s.name,
    subtitle: lead.concat(subjectFacts(s)).join(" · "),
    artistName: s.kind === "artist" ? s.name : s.artistName || null,
    albumTitle: s.kind === "album" ? s.name : null,
    imageUrl: subjectArt(s),
    action: "open-subject",
  };
}

// Only the latest search lands: an earlier one answering late (or failing)
// must not put its results, or its error, under the query typed since.
function searchSubjects(query) {
  var d = state.discover;
  var seq = (d.seq = (d.seq || 0) + 1);
  d.query = String(query || "").trim();
  if (!d.query) {
    d.results = null;
    return Promise.resolve(render());
  }
  return withLoading(function () {
    return request("GET", "/v1/subjects/search?" + queryString({ q: d.query })).then(
      function (data) {
        if (seq !== d.seq) return;
        d.results = data.subjects || [];
        d.results.forEach(function (s) {
          state.subjectsById[s.id] = s;
        });
      },
      function (e) {
        if (seq === d.seq) throw e;
        api.log("debug", "A superseded Community search failed: " + errorText(e));
      }
    );
  });
}

function loadFeed(page) {
  var d = state.discover;
  return request("GET", "/v1/activity?" + queryString({ page: page || 0 }), undefined, !!state.token).then(function (data) {
    var entries = data.entries || [];
    entries.forEach(function (e) {
      if (e.subject) state.subjectsById[e.subject.id] = e.subject;
    });
    d.feed = page > 0 && d.feed ? d.feed.concat(entries) : entries;
    d.feedPage = page || 0;
    d.feedMore = !!data.hasMore;
  });
}

function loadDiscover() {
  return withLoading(function () {
    return loadFeed(0);
  });
}

// One feed entry → a row: who did what, and where it opens.
function feedRow(e, i) {
  var s = e.subject;
  var who;
  var what;
  if (e.type === "comment") {
    who = e.comment.author.login;
    what = "commented: “" + String(e.comment.body).slice(0, 120) + "”";
  } else {
    var m = knownModule(e.item.kind) || { singular: "item" };
    who = e.item.publisher.login;
    what = (e.event === "updated" ? "updated " : "shared ") + (s ? "a " + m.singular : "the " + m.singular);
  }
  var title = s ? s.name + (s.kind !== "artist" && s.artistName ? " · " + s.artistName : "") : e.item ? e.item.title : "";
  return {
    id: "entry:" + i,
    title: title,
    subtitle: "@" + who + " " + what + " · " + ago(e.at),
    artistName: s ? (s.kind === "artist" ? s.name : s.artistName || null) : null,
    albumTitle: s && s.kind === "album" ? s.name : null,
    imageUrl: subjectArt(s),
    action: "open-entry",
  };
}

function rowsNode(items, actions) {
  return {
    type: "track-row-list",
    selectable: true,
    selectionMode: "single",
    openOnClick: true,
    artwork: "cached",
    contextMenu: false,
    actions: withIcons(actions || []),
    items: items,
  };
}

function discoverNodes() {
  var d = state.discover;
  var nodes = [{ type: "search-input", placeholder: "Find an artist, album or song on Community", action: "discover-search", value: d.query, submitOnly: true, buttonLabel: "Search" }];
  if (d.query && d.results) {
    var groups = [
      ["artist", "Artists"],
      ["album", "Albums"],
      ["track", "Songs"],
    ];
    var any = false;
    groups.forEach(function (g) {
      var rows = d.results.filter(function (s) {
        return s.kind === g[0];
      });
      if (!rows.length) return;
      any = true;
      nodes.push({ type: "section", title: g[1], children: [rowsNode(rows.map(subjectRow))] });
    });
    if (!any) nodes.push({ type: "text", content: "Nothing shared matches that yet." });
  }
  var feed = [];
  if (!d.feed && state.loading) feed.push({ type: "loading", message: "Loading what's new…" });
  else if (d.feed && !d.feed.length) feed.push({ type: "text", content: "Nothing shared yet." });
  else if (d.feed) {
    feed.push(rowsNode(d.feed.map(feedRow)));
    if (d.feedMore) feed.push({ type: "button", label: state.loading ? "Loading…" : "Load more", action: "feed-more", variant: "secondary", disabled: state.loading });
  }
  nodes.push({ type: "section", title: "New this week", children: feed });
  nodes.push({
    type: "text",
    className: "ds-muted",
    content: "Opening a song, album or artist goes to its page in Viboplr, on its Community tab — songs you don't have get a page too, built from their name.",
  });
  return nodes;
}

function openEntry(i) {
  var e = state.discover.feed && state.discover.feed[i];
  if (!e) return Promise.resolve();
  if (e.subject) {
    openSubject(e.subject);
    return Promise.resolve();
  }
  if (e.item && e.item.kind === "mixtape") return playMixtape(e.item.id);
  if (e.item && e.item.kind === "subsonic_server") return addServer(e.item.id);
  return e.item ? api.network.openUrl(e.item.url) : Promise.resolve();
}

// ---------------------------------------------------------------------------
// The Community tab on song, album and artist pages
// ---------------------------------------------------------------------------
//
// A `plugin_view` information type: the page's tab is drawn from the tree this
// returns, and its buttons reach the ACTIONS below with the page's entity in the
// payload. After a like or a post the tab is redrawn in place with
// api.informationTypes.setSectionData — no refetch of the whole page.

var COMMENT_ACTIONS = [
  { id: "tab-comment-like", label: "Like" },
  { id: "tab-comment-unlike", label: "Unlike" },
  { id: "tab-comment-delete", label: "Delete" },
  { id: "tab-comment-report", label: "Report" },
];
var ACTION_ICONS_TAB = { "tab-comment-like": "♡", "tab-comment-unlike": "♥", "tab-comment-delete": "✕", "tab-comment-report": "⚑" };

function tabKey(entity) {
  return entity.kind + ":" + (entity.kind === "artist" ? "" : fold(entity.artistName)) + ":" + fold(entity.name);
}

function entityOf(p) {
  var e = p && p.entity;
  return e && e.kind && e.name ? { kind: e.kind, name: e.name, artistName: e.artistName || null, albumTitle: e.albumTitle || null } : null;
}

// The tab an action came from, loaded if this plugin has never seen it: the
// host draws a tab from its own cache while that is fresh (the manifest `ttl`),
// across restarts and plugin reloads, without asking onFetch — so the tab on
// screen can be one `state.tabs` knows nothing about. Null only for a payload
// that names no entity.
function ensureTab(p) {
  var e = entityOf(p);
  if (!e) return Promise.resolve(null);
  var key = tabKey(e);
  if (state.tabs[key]) return Promise.resolve(state.tabs[key]);
  return loadTabData(e).then(function (data) {
    state.tabs[key] = data;
    return data;
  });
}

// A tab action, run on the tab's state. A failed load is said, not swallowed:
// the button the user pressed would otherwise just do nothing.
function withTab(p, run) {
  return ensureTab(p).then(
    function (t) {
      return t ? run(t) : undefined;
    },
    function (e) {
      fail("Couldn't load the Community tab", e);
    }
  );
}

function fmtMoment(secs) {
  var s = Math.max(0, Math.floor(Number(secs) || 0));
  var h = Math.floor(s / 3600);
  var m = Math.floor((s % 3600) / 60);
  var r = s % 60;
  var mm = h ? (m < 10 ? "0" : "") + m : String(m);
  return (h ? h + ":" : "") + mm + ":" + (r < 10 ? "0" : "") + r;
}

// The playing track, when it is the song this tab is about.
function playingHere(entity) {
  if (!entity || entity.kind !== "track" || !api.playback || typeof api.playback.getCurrentTrack !== "function") return null;
  var t = api.playback.getCurrentTrack();
  return t && songKey(t.title, t.artist_name) === songKey(entity.name, entity.artistName) ? t : null;
}

// Everything the tab shows, fetched together. A subject nobody ever shared
// anything about is null: the tab still shows, inviting the first share.
function loadTabData(entity) {
  var key = tabKey(entity);
  var prev = state.tabs[key];
  return resolveSubject(entity.kind, entity.name, entity.artistName, true, true).then(function (subject) {
    var data = {
      entity: entity,
      subject: subject,
      cues: null,
      lyrics: null,
      comments: [],
      commentsMore: false,
      children: null,
      localSheet: false,
      at: prev ? prev.at : null,
      confirm: null,
      fetchedAt: Date.now(),
    };
    var loads = [];
    if (entity.kind === "track") {
      loads.push(
        api.cues
          .get(entity.name, entity.artistName)
          .then(function (row) {
            data.localSheet = !!row;
          })
          .catch(function (e) {
            // Only decides whether "Publish my cue sheet" shows.
            api.log("warn", "Couldn't read the cue sheet for " + entity.name + ": " + errorText(e));
            data.localSheet = false;
          })
      );
    }
    if (!subject) return Promise.all(loads).then(function () {
      return data;
    });
    var id = encodeURIComponent(subject.id);
    loads.push(
      request("GET", "/v1/subjects/" + id + "/comments", undefined, !!state.token).then(function (d) {
        data.comments = d.comments || [];
        data.commentsMore = !!d.hasMore;
      })
    );
    if (entity.kind === "track") {
      var q = { title: entity.name, artist: entity.artistName };
      if ((subject.counts || {}).cue_sheet) {
        loads.push(
          request("GET", "/v1/items?" + queryString(Object.assign({ kind: "cue_sheet" }, q))).then(function (d) {
            data.cues = d.items;
          })
        );
      }
      if ((subject.counts || {}).synced_lyrics) {
        loads.push(
          request("GET", "/v1/items?" + queryString(Object.assign({ kind: "synced_lyrics" }, q))).then(function (d) {
            data.lyrics = d.items;
          })
        );
      }
    } else {
      loads.push(
        request("GET", "/v1/subjects/" + id + "/children").then(function (d) {
          data.children = d;
          (d.tracks || []).concat(d.albums || []).forEach(function (s) {
            state.subjectsById[s.id] = s;
          });
        })
      );
    }
    return Promise.all(loads).then(function () {
      return data;
    });
  });
}

function likeButton(subject) {
  if (!subject) return null;
  var n = subject.likes || 0;
  if (!state.token) return { type: "button", label: "♡ Like · " + n, action: "tab-sign-in", variant: "secondary" };
  return { type: "button", label: (subject.liked ? "♥ Liked · " : "♡ Like · ") + n, action: "tab-like", variant: subject.liked ? "accent" : "secondary" };
}

function commentRows(data) {
  var me = state.user && state.user.login;
  return data.comments.map(function (c) {
    var bits = ["@" + c.author.login];
    if (c.atSecs !== null && c.atSecs !== undefined) bits.push("at " + fmtMoment(c.atSecs));
    bits.push(ago(c.createdAt));
    if (c.likes) bits.push("♥ " + c.likes);
    var actions = [];
    if (state.token) actions.push(c.liked ? "tab-comment-unlike" : "tab-comment-like");
    actions.push(me && c.author.login === me ? "tab-comment-delete" : "tab-comment-report");
    return {
      id: "comment:" + c.id,
      title: c.body,
      subtitle: bits.join(" · "),
      imageUrl: c.author.avatarUrl || undefined,
      actions: actions,
    };
  });
}

function commentNodes(data) {
  var e = data.entity;
  var nodes = [];
  if (!data.subject) return nodes;
  if (state.token) {
    // A new stateKey after each post empties the box (the host keeps typed
    // text per key, and reads `value` only for a key it hasn't seen). A count
    // that only grows, so a deleted comment can't bring an old key — and the
    // text kept under it — back.
    var composer = [
      {
        type: "search-input",
        placeholder: "Comment on " + e.name,
        action: "tab-comment",
        value: "",
        stateKey: "comment:" + state.commentsPosted,
        submitOnly: true,
        buttonLabel: "Post",
      },
    ];
    if (e.kind === "track") {
      var here = playingHere(e);
      if (data.at !== null && data.at !== undefined) {
        composer.push({ type: "button", label: "at " + fmtMoment(data.at) + " ✕", action: "tab-comment-at", variant: "accent" });
      } else if (here) {
        var pos = typeof api.playback.getPosition === "function" ? api.playback.getPosition() : 0;
        composer.push({ type: "button", label: "@ " + fmtMoment(pos), action: "tab-comment-at", variant: "secondary" });
      }
    }
    nodes.push({ type: "layout", direction: "horizontal", children: composer });
  } else {
    nodes.push(banner("Sign in with GitHub to comment and like.", "muted", [{ type: "button", label: "Sign in", action: "tab-sign-in", variant: "accent" }]));
  }
  if (!data.comments.length) nodes.push({ type: "text", content: "No comments yet.", className: "ds-muted" });
  else {
    nodes.push({
      type: "track-row-list",
      selectable: true,
      selectionMode: "single",
      contextMenu: false,
      actions: COMMENT_ACTIONS.map(function (a) {
        return Object.assign({}, a, { icon: ACTION_ICONS_TAB[a.id] });
      }),
      items: commentRows(data),
    });
    if (data.commentsMore) nodes.push({ type: "button", label: "More comments on the website", action: "tab-page", variant: "secondary" });
  }
  return nodes;
}

// A shared item list in the tab: the module's own row (Imported / Update
// badges), with the tab's import actions.
function tabItems(kind, items, localSheet) {
  var m = knownModule(kind);
  var importId = kind === "cue_sheet" ? "tab-import" : "tab-import-lyrics";
  return {
    type: "track-row-list",
    selectable: true,
    selectionMode: "single",
    artwork: "cached",
    contextMenu: false,
    actions: withIcons([
      { id: importId, label: kind === "cue_sheet" && localSheet ? "Use instead of yours" : "Import", icon: "⬇" },
      { id: kind === "cue_sheet" ? "tab-update" : "tab-update-lyrics", label: "Update", icon: "↻" },
      { id: "page", label: "Open page" },
    ]),
    items: items.map(function (item) {
      var row = cardRow(m, item);
      row.actions = row.actions.map(function (a) {
        if (a === "import" || a === "import-lyrics") return importId;
        if (a === "update") return "tab-update";
        if (a === "update-lyrics") return "tab-update-lyrics";
        return a;
      });
      return row;
    }),
  };
}

function childRows(list) {
  return rowsNode(list.map(subjectRow));
}

function tabTree(data) {
  var e = data.entity;
  var s = data.subject;
  var noun = e.kind === "track" ? "song" : e.kind;
  var top = [];
  var like = likeButton(s);
  if (like) top.push(like);
  if (s) top.push({ type: "button", label: "Open the " + noun + "'s page", action: "tab-page", variant: "secondary" });
  if (e.kind === "track" && state.token) {
    if (data.localSheet) top.push({ type: "button", label: "Publish my cue sheet", action: "tab-publish-sheet", variant: "secondary" });
    top.push({ type: "button", label: "Publish my synced lyrics", action: "tab-publish-lyrics", variant: "secondary" });
  }
  var children = [];
  // A question the tab asked (replace the song's synced lyrics?) comes first,
  // where the button that raised it was pressed.
  if (data.confirm) {
    children.push(Object.assign({}, confirmNode(data.confirm), { confirmAction: "tab-confirm-replace-lyrics", cancelAction: "tab-cancel-confirm" }));
  }
  if (top.length) children.push({ type: "layout", direction: "horizontal", children: top });
  if (!s) {
    children.push({
      type: "text",
      content:
        "Nothing on Viboplr Community about this " + noun + " yet." +
        (e.kind === "track" ? " Publish your cue sheet or synced lyrics for it and it gets a page others can like and comment on." : ""),
    });
    if (!state.token && e.kind === "track") children.push(banner("Sign in with GitHub to share.", "muted", [{ type: "button", label: "Sign in", action: "tab-sign-in", variant: "accent" }]));
    return { type: "layout", direction: "vertical", children: children };
  }
  if (e.kind === "track") {
    if (data.cues && data.cues.length) children.push({ type: "section", title: "Cue sheets · " + data.cues.length, children: [tabItems("cue_sheet", data.cues, data.localSheet)] });
    if (data.lyrics && data.lyrics.length) children.push({ type: "section", title: "Synced lyrics · " + data.lyrics.length, children: [tabItems("synced_lyrics", data.lyrics)] });
  } else {
    var kids = data.children || {};
    if (e.kind === "album" && kids.tracks && kids.tracks.length) children.push({ type: "section", title: "What's shared per track", children: [childRows(kids.tracks)] });
    if (e.kind === "artist" && kids.albums && kids.albums.length) children.push({ type: "section", title: "Albums", children: [childRows(kids.albums)] });
    if (e.kind === "artist" && kids.tracks && kids.tracks.length) children.push({ type: "section", title: "Songs with something shared", children: [childRows(kids.tracks)] });
  }
  children.push({ type: "section", title: "Comments · " + (s.comments || data.comments.length), children: commentNodes(data) });
  return { type: "layout", direction: "vertical", children: children };
}

// Redraw an open tab: from what we have (`reload` false — a like), or after
// asking the server again (a post, an import).
function refreshTab(entity, reload) {
  var key = tabKey(entity);
  var ready = reload || !state.tabs[key] ? loadTabData(entity) : Promise.resolve(state.tabs[key]);
  return ready
    .then(function (data) {
      state.tabs[key] = data;
      if (api.informationTypes && typeof api.informationTypes.setSectionData === "function") {
        return api.informationTypes.setSectionData(TAB_TYPES[entity.kind], entity, tabTree(data));
      }
    })
    .catch(function (e) {
      api.log("warn", "Couldn't refresh the Community tab: " + errorText(e));
    });
}

// How long the host keeps a tab's tree (the manifest's `ttl` on the three
// community_* types). A tab older than this is redrawn by the host itself, by
// asking onFetch again.
var TAB_TTL_MS = 300 * 1000;

// Signing in or out changes what every tab shows — the like button, the
// comment box, whose comments can be deleted, `liked` itself — but the host
// keeps drawing the tree it cached. So each tab the host may still be showing
// from that cache is redrawn: from what we have after a sign-out (a signed-out
// tree reads nothing member-only), asked again after a sign-in (only the member
// answer carries `liked`). Older ones are dropped; the host asks for them anew.
function redrawTabs(signedIn) {
  var now = Date.now();
  return Promise.all(
    Object.keys(state.tabs).map(function (k) {
      var t = state.tabs[k];
      if (now - t.fetchedAt > TAB_TTL_MS) {
        delete state.tabs[k];
        return null;
      }
      return refreshTab(t.entity, signedIn);
    })
  );
}

function registerTabs() {
  if (!api.informationTypes || typeof api.informationTypes.onFetch !== "function") return;
  Object.keys(TAB_TYPES).forEach(function (kind) {
    api.informationTypes.onFetch(TAB_TYPES[kind], function (entity) {
      if (!entity || !entity.name) return Promise.resolve({ status: "not_found" });
      var e = { kind: kind, name: entity.name, artistName: entity.artistName || null, albumTitle: entity.albumTitle || null };
      return loadTabData(e)
        .then(function (data) {
          state.tabs[tabKey(e)] = data;
          return { status: "ok", value: tabTree(data) };
        })
        .catch(function (err) {
          api.log("warn", "Couldn't load the Community tab: " + errorText(err));
          return { status: "error" };
        });
    });
  });
}

function itemIdOf(p, prefix) {
  var id = rowId(p);
  if (typeof id !== "string") return null;
  return prefix && id.indexOf(prefix) === 0 ? id.slice(prefix.length) : id;
}

var TAB_ACTIONS = {
  "tab-sign-in": function () {
    return signIn();
  },
  "tab-page": function (p) {
    return withTab(p, function (t) {
      return api.network.openUrl(t.subject ? t.subject.url : SERVER);
    });
  },
  "tab-like": function (p) {
    if (!requireSignIn("like")) return Promise.resolve();
    return withTab(p, function (t) {
      if (!t.subject) return;
      var on = !t.subject.liked;
      return request(on ? "PUT" : "DELETE", "/v1/subjects/" + encodeURIComponent(t.subject.id) + "/like", undefined, true)
        .then(function (d) {
          t.subject = Object.assign({}, t.subject, { likes: d.likes, liked: d.liked });
          forgetSubject(t.entity.kind, t.entity.name, t.entity.artistName);
          return refreshTab(t.entity, false);
        })
        .catch(function (e) {
          fail("Couldn't like that", e);
        });
    });
  },
  "tab-comment": function (p) {
    var body = String((p && p.query) || "").trim();
    if (!body || !requireSignIn("comment")) return Promise.resolve();
    return withTab(p, function (t) {
      if (!t.subject) return;
      var payload = { body: body };
      if (t.at !== null && t.at !== undefined) payload.atSecs = t.at;
      return request("POST", "/v1/subjects/" + encodeURIComponent(t.subject.id) + "/comments", payload, true)
        .then(function () {
          t.at = null;
          state.commentsPosted++;
          retick(t.entity);
          return refreshTab(t.entity, true);
        })
        .catch(function (e) {
          fail("Couldn't post that comment", e);
        });
    });
  },
  // Pin the comment to where the song is now (or unpin it).
  "tab-comment-at": function (p) {
    return withTab(p, function (t) {
      if (t.at !== null && t.at !== undefined) t.at = null;
      else if (playingHere(t.entity)) t.at = Math.floor(typeof api.playback.getPosition === "function" ? api.playback.getPosition() : 0);
      else {
        notify("Play the song to pin a comment to a moment of it.");
        return;
      }
      return refreshTab(t.entity, false);
    });
  },
  "tab-comment-like": function (p) {
    return likeComment(p, true);
  },
  "tab-comment-unlike": function (p) {
    return likeComment(p, false);
  },
  "tab-comment-delete": function (p) {
    var id = itemIdOf(p, "comment:");
    if (!id) return Promise.resolve();
    return withTab(p, function (t) {
      return request("DELETE", "/v1/comments/" + encodeURIComponent(id), undefined, true)
        .then(function () {
          retick(t.entity);
          return refreshTab(t.entity, true);
        })
        .catch(function (e) {
          fail("Couldn't delete that comment", e);
        });
    });
  },
  // Reporting asks for a reason, which the website's form collects.
  "tab-comment-report": function (p) {
    var id = itemIdOf(p, "comment:");
    if (!id) return Promise.resolve();
    return withTab(p, function (t) {
      var c = t.comments.filter(function (x) {
        return String(x.id) === id;
      })[0];
      if (c) return api.network.openUrl(c.url);
    });
  },
  "tab-import": function (p) {
    return tabImport(p);
  },
  "tab-update": function (p) {
    return tabImport(p);
  },
  "tab-import-lyrics": function (p) {
    return tabImportLyrics(p);
  },
  "tab-update-lyrics": function (p) {
    return tabImportLyrics(p);
  },
  "tab-confirm-replace-lyrics": function (p) {
    return withTab(p, function (t) {
      t.confirm = null;
      return importLyrics(p && p.id, true).then(function () {
        return refreshTab(t.entity, false);
      });
    });
  },
  "tab-cancel-confirm": function (p) {
    return withTab(p, function (t) {
      t.confirm = null;
      return refreshTab(t.entity, false);
    });
  },
  "tab-publish-sheet": function (p) {
    var e = entityOf(p);
    return e ? publishSong(e.name, e.artistName).then(function () {
      return refreshTab(e, true);
    }) : Promise.resolve();
  },
  "tab-publish-lyrics": function (p) {
    var e = entityOf(p);
    return e ? publishLyrics(e.name, e.artistName, e.albumTitle).then(function () {
      return refreshTab(e, true);
    }) : Promise.resolve();
  },
  "open-subject": function (p) {
    var id = itemIdOf(p, "subject:");
    openSubject(id && state.subjectsById[id]);
  },
};

// A cue sheet from the tab: the button's own label says what happens ("Use
// instead of yours" when the song has a sheet), so it doesn't stop to ask again.
// Reloaded afterwards, so "Publish my cue sheet" follows the sheet now in place.
function tabImport(p) {
  var id = rowId(p);
  if (!id) return Promise.resolve();
  return withTab(p, function (t) {
    return importItem(id, true).then(function () {
      return refreshTab(t.entity, true);
    });
  });
}

// Synced lyrics from the tab. Their button says only "Import", so replacing
// synced lyrics the song already has — which may be the user's own edit, and
// Undo can't bring back — asks first, in the tab itself: the view's confirm is
// on a page the user isn't looking at.
function tabImportLyrics(p) {
  var id = rowId(p);
  if (!id) return Promise.resolve();
  return withTab(p, function (t) {
    t.confirm = null;
    return importLyrics(id, false, function (c) {
      t.confirm = c;
    }).then(function () {
      return refreshTab(t.entity, false);
    });
  });
}

function likeComment(p, on) {
  var id = itemIdOf(p, "comment:");
  if (!id || !requireSignIn("like")) return Promise.resolve();
  return withTab(p, function (t) {
    return request(on ? "PUT" : "DELETE", "/v1/comments/" + encodeURIComponent(id) + "/like", undefined, true)
      .then(function (d) {
        t.comments = t.comments.map(function (c) {
          return String(c.id) === id ? Object.assign({}, c, { likes: d.likes, liked: d.liked }) : c;
        });
        return refreshTab(t.entity, false);
      })
      .catch(function (e) {
        fail("Couldn't like that comment", e);
      });
  });
}

// ---------------------------------------------------------------------------
// Seek-bar ticks: the playing song's timed comments
// ---------------------------------------------------------------------------

function canMark() {
  return !!(api.playback && typeof api.playback.setMarkers === "function");
}

// The playing song's timed comments as ticks. Once per track (the start event
// and the restore at launch can both ask); `fresh` asks again past the lookup
// cache, after a comment changed what there is to show.
function loadTicks(track, fresh) {
  if (!state.ticks || !canMark() || !track || !track.title || !track.key) return Promise.resolve();
  if (!fresh && state.ticksKey === track.key) return Promise.resolve();
  state.ticksKey = track.key;
  return resolveSubject("track", track.title, track.artist_name || null, !!fresh)
    .then(function (s) {
      if (!s || !s.comments) return [];
      return request("GET", "/v1/subjects/" + encodeURIComponent(s.id) + "/comments?timed=1").then(function (d) {
        return d.comments || [];
      });
    })
    .then(function (comments) {
      // Switched off while this was on its way: the bar was cleared, keep it so.
      if (!state.ticks || !api) return;
      api.playback.setMarkers(
        track.key,
        comments.map(function (c) {
          return { at: c.atSecs, label: "@" + c.author.login + ": " + c.body };
        })
      );
    })
    .catch(function (e) {
      api.log("warn", "Couldn't load the timed comments: " + errorText(e));
    });
}

function currentTrack() {
  return api.playback && typeof api.playback.getCurrentTrack === "function" ? api.playback.getCurrentTrack() : null;
}

function setTicks(on) {
  state.ticks = !!on;
  state.ticksKey = null;
  var current = currentTrack();
  return api.storage.set("ticks", state.ticks).then(function () {
    render();
    if (state.ticks) return loadTicks(current, true);
    if (canMark() && current && current.key) api.playback.setMarkers(current.key, []);
  });
}

// ---------------------------------------------------------------------------
// Your likes: the app's likes, sent to Community
// ---------------------------------------------------------------------------
//
// One direction only (owner decision): a like, dislike or un-like made in the
// app (api.library.onLikeChanged) becomes a like or un-like here, from the
// moment the switch is on — nothing already liked is sent. Community has no
// dislike, so disliking something you had liked takes the Community like
// away. A like on something nothing was shared about creates its subject on
// the server (PUT /v1/likes). Tags aren't Community subjects.

var LIKE_KINDS = { track: true, album: true, artist: true };

function canSyncLikes() {
  return !!(api.library && typeof api.library.onLikeChanged === "function");
}

// What a change becomes on Community: "PUT" (a like), "DELETE" (a like that
// was undone, or turned into a dislike), or null (nothing to send — a dislike
// of something never liked, a tag, a repeat).
function likeMethod(change) {
  if (!change || !LIKE_KINDS[change.kind] || !change.name) return null;
  if (change.kind === "album" && !change.artistName) return null;
  if (change.liked === 1 && change.previous !== 1) return "PUT";
  if (change.liked !== 1 && change.previous === 1) return "DELETE";
  return null;
}

// Likes go out one at a time, in the order they were made, so a quick like
// then un-like can't land the other way round.
var likeChain = Promise.resolve();

function onLikeChanged(change) {
  if (!state || !state.syncLikes || !state.token) return;
  var method = likeMethod(change);
  if (!method) return;
  var body = { kind: change.kind, name: change.name, artistName: change.artistName || null };
  if (change.kind === "track") {
    body.albumName = change.albumTitle || null;
    body.albumArtistName = change.albumArtistName || null;
  }
  var entity = { kind: change.kind, name: change.name, artistName: change.artistName || null, albumTitle: change.albumTitle || null };
  likeChain = likeChain
    .then(function () {
      if (!api || !state.syncLikes || !state.token) return;
      return request(method, "/v1/likes", body, true).then(function () {
        forgetSubject(entity.kind, entity.name, entity.artistName);
        // A Community tab showing it would show the old count until its TTL.
        if (state.tabs[tabKey(entity)]) return refreshTab(entity, true);
      });
    })
    .catch(function (e) {
      // Background work the user didn't wait on: the log, not a toast.
      api.log("warn", "Couldn't send a like to Viboplr Community (" + change.kind + " " + JSON.stringify(change.name) + "): " + errorText(e));
    });
  return likeChain;
}

// ---------------------------------------------------------------------------
// Your plays: a scrobbler, like Last.fm's
// ---------------------------------------------------------------------------
//
// With the switch on, every song the app counts as played (its scrobble
// threshold: half the song or four minutes, never under 30 seconds) is sent
// to POST /v1/plays. Community shows only totals — a song's plays and
// listeners, the charts; a member's own list is theirs alone. Plays wait in a
// queue saved to plugin storage until they're sent, so a play made offline
// (or signed out, or while the server is down) goes later, at its own time.
// From the moment it's switched on: nothing already played is sent.

var PLAY_BATCH = 50; // the server's per-request maximum
var PLAY_QUEUE_MAX = 2000; // past this, the oldest wait in vain
var PLAY_MAX_AGE_SECS = 14 * 24 * 60 * 60; // the server refuses older plays
var PLAY_RETRY_MS = 5 * 60 * 1000;
var playRetryTimer = null;
var playSending = null;

function canScrobble() {
  return !!(api.playback && typeof api.playback.onTrackScrobbled === "function");
}

function onTrackScrobbled(track) {
  if (!state || !state.scrobble || !track || !track.title || !track.artist_name) return;
  var nowSecs = Math.floor(Date.now() / 1000);
  var pos = typeof api.playback.getPosition === "function" ? Number(api.playback.getPosition()) : 0;
  state.playQueue.push({
    title: track.title,
    artistName: track.artist_name,
    albumName: track.album_title || null,
    albumArtistName: track.album_artist_name || null,
    // When the play started: the event comes at the threshold, mid-song.
    playedAt: nowSecs - (isFinite(pos) && pos > 0 ? Math.floor(pos) : 0),
  });
  if (state.playQueue.length > PLAY_QUEUE_MAX) state.playQueue.splice(0, state.playQueue.length - PLAY_QUEUE_MAX);
  return savePlayQueue().then(sendPlays);
}

function savePlayQueue() {
  return api.storage.set("playQueue", state.playQueue).catch(function (e) {
    api.log("error", "Couldn't save the plays waiting to be sent: " + errorText(e));
  });
}

function retryPlaysLater() {
  if (playRetryTimer) return;
  playRetryTimer = setTimeout(function () {
    playRetryTimer = null;
    if (api) sendPlays();
  }, PLAY_RETRY_MS);
}

// Send what's queued, a batch at a time; one send at a time. A batch the
// server took (or refused as malformed) leaves the queue; one that couldn't be
// sent stays, and is tried again in a few minutes or with the next play.
function sendPlays() {
  if (playSending) return playSending;
  if (!state.scrobble || !state.token || !state.playQueue.length) return Promise.resolve();
  var oldest = Math.floor(Date.now() / 1000) - PLAY_MAX_AGE_SECS;
  var fresh = state.playQueue.filter(function (p) {
    return p.playedAt >= oldest;
  });
  if (fresh.length !== state.playQueue.length) {
    api.log("info", "Dropped " + (state.playQueue.length - fresh.length) + " plays older than two weeks: Viboplr Community no longer takes them.");
    state.playQueue = fresh;
  }
  var batch = state.playQueue.slice(0, PLAY_BATCH);
  if (!batch.length) return savePlayQueue();
  playSending = request("POST", "/v1/plays", { plays: batch }, true)
    .then(
      function () {
        return true;
      },
      function (e) {
        // 400: nothing in it will ever be taken. Anything else is worth a retry.
        if (e.status === 400) {
          api.log("warn", "Viboplr Community refused " + batch.length + " plays, dropping them: " + errorText(e));
          return true;
        }
        if (e.status !== 401) api.log("warn", "Couldn't send plays to Viboplr Community, trying again later: " + errorText(e));
        retryPlaysLater();
        return false;
      }
    )
    .then(function (done) {
      playSending = null;
      if (!done || !api) return;
      state.playQueue = state.playQueue.slice(batch.length);
      return savePlayQueue().then(function () {
        if (state.tab === MINE) render();
        if (state.playQueue.length) return sendPlays();
      });
    });
  return playSending;
}

function setScrobble(on) {
  state.scrobble = !!on;
  // Off means stop sending: what was still waiting is dropped with it, and
  // so is a pending retry.
  if (!state.scrobble) {
    state.playQueue = [];
    if (playRetryTimer) clearTimeout(playRetryTimer);
    playRetryTimer = null;
  }
  return Promise.all([api.storage.set("scrobble", state.scrobble), savePlayQueue()]).then(function () {
    render();
  });
}

function scrobbleNodes() {
  if (!canScrobble()) {
    return [{ type: "text", className: "ds-muted", content: "Sending your plays needs a newer Viboplr." }];
  }
  var nodes = [
    {
      type: "settings-row",
      label: "Send my plays to Community",
      description:
        "Like a Last.fm scrobbler: each song you play past halfway (or four minutes) is sent to Viboplr Community. Your list of plays is only yours to see; Community shows only totals, like how often a song was played and by how many people. Songs you already played aren't sent.",
      control: { type: "toggle", label: "", action: "toggle-scrobble", checked: state.scrobble && !!state.token, disabled: !state.token },
    },
  ];
  if (!state.token) {
    nodes.push({ type: "text", className: "ds-muted", content: "Sign in to send your plays." });
    return nodes;
  }
  if (state.scrobble) {
    var waiting = state.playQueue.length;
    nodes.push({
      type: "layout",
      direction: "horizontal",
      children: [
        { type: "text", className: "ds-muted", content: waiting ? plural(waiting, "play", "plays") + " waiting to be sent." : "All your plays are sent." },
        { type: "button", label: "See your plays", action: "open-my-plays", variant: "secondary" },
      ],
    });
  }
  return nodes;
}

function setSyncLikes(on) {
  state.syncLikes = !!on;
  return api.storage.set("syncLikes", state.syncLikes).then(function () {
    render();
  });
}

function likeSyncNodes() {
  if (!canSyncLikes()) {
    return [{ type: "text", className: "ds-muted", content: "Sending your likes needs a newer Viboplr." }];
  }
  var row = {
    type: "settings-row",
    label: "Send my likes to Community",
    description:
      "From now on, a song, album or artist you like in Viboplr is liked on Viboplr Community too, and un-liking or disliking it takes that like away. Likes there are public. Likes you already have aren't sent.",
    control: { type: "toggle", label: "", action: "toggle-sync-likes", checked: state.syncLikes && !!state.token, disabled: !state.token },
  };
  var nodes = [row];
  if (!state.token) nodes.push({ type: "text", className: "ds-muted", content: "Sign in to send your likes." });
  return nodes;
}

// A comment was posted or deleted on this tab's song: redraw its ticks if it
// is the one playing.
function retick(entity) {
  var here = playingHere(entity);
  return here ? loadTicks(here, true) : null;
}

function tickNodes() {
  if (!canMark()) {
    return [{ type: "text", className: "ds-muted", content: "Ticks on the seek bar need a newer Viboplr." }];
  }
  return [
    {
      type: "settings-row",
      label: "Timed comments on the seek bar",
      description:
        "Ticks where people commented on a moment of the playing song; point at one to read it. While this is on, every song you play is looked up on Viboplr Community.",
      control: { type: "toggle", label: "", action: "toggle-ticks", checked: state.ticks },
    },
  ];
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

// You: the seek-bar ticks switch, then what's shareable from this computer and
// what you shared — a section per module.
function mineNodes() {
  var nodes = [];
  if (!state.token) {
    nodes.push(banner("Sign in with GitHub to share, and to see what you've shared.", "muted", [{ type: "button", label: "Sign in", action: "sign-in", variant: "accent" }]));
  }
  nodes.push({ type: "section", title: "While you listen", children: tickNodes() });
  nodes.push({ type: "section", title: "Send from Viboplr", children: scrobbleNodes().concat(likeSyncNodes()) });
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
  nodes.push({
    type: "layout",
    direction: "horizontal",
    children: [
      { type: "text", className: "ds-muted", content: "Your likes and comments are on the website." },
      { type: "button", label: "Open my page", action: "open-my-page", variant: "secondary" },
    ],
  });
  return nodes;
}

// The generic section on You: the items you shared in a module.
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

function confirmNode(c) {
  c = c || state.confirm;
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
        "'s shows theirs instead — undo the import later (Community → You) and yours come back.",
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
      tabs: [{ id: DISCOVER, label: "Discover" }]
        .concat(
          tabModules().map(function (m) {
            return { id: m.kind, label: m.name };
          })
        )
        .concat([{ id: MINE, label: "You" }]),
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
  var body = state.tab === DISCOVER ? discoverNodes() : state.tab === MINE || !m ? mineNodes() : moduleNodes(m);
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
    return switchTab(state.tab);
  },
  // --- discover ---
  "discover-search": function (p) {
    return searchSubjects(p && p.query);
  },
  "feed-more": function () {
    return withLoading(function () {
      return loadFeed(state.discover.feedPage + 1);
    });
  },
  "open-entry": function (p) {
    var id = itemIdOf(p, "entry:");
    return openEntry(Number(id));
  },
  // --- you ---
  "toggle-ticks": function (p) {
    return setTicks(p && p.value);
  },
  "toggle-scrobble": function (p) {
    if (!state.token) return Promise.resolve(render());
    return setScrobble(p && p.value);
  },
  "open-my-plays": function () {
    return api.network.openUrl(SERVER + "/me?tab=plays");
  },
  "toggle-sync-likes": function (p) {
    if (!state.token) return Promise.resolve(render());
    return setSyncLikes(p && p.value);
  },
  "open-my-page": function () {
    return api.network.openUrl(SERVER + "/me");
  },
  // --- cue sheets ---
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
  else if (link.path === "subject") openSubjectLink(link.params.id);
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
  Object.keys(TAB_ACTIONS).forEach(function (id) {
    api.ui.onAction(id, TAB_ACTIONS[id]);
  });
  // The song's own page, on its Community tab.
  api.contextMenu.onAction("show-on-community", function (target) {
    if (!target || !target.title) return;
    openInApp("track", target.title, target.artistName || null, target.albumTitle || null);
  });
  api.contextMenu.onAction("publish-cues", function (target) {
    if (!target || !target.title) return;
    return publishSong(target.title, target.artistName || null);
  });
  if (api.assistant && typeof api.assistant.onTool === "function") {
    api.assistant.onTool("publish_lyrics", publishLyricsTool);
  }
  api.contextMenu.onAction("publish-lyrics", function (target) {
    if (!target || !target.title) return;
    return publishLyrics(target.title, target.artistName || null, target.albumTitle || null);
  });
  api.contextMenu.onAction("publish-mixtape", function (target) {
    if (!target || target.playlistId === undefined || target.playlistId === null) return;
    return publishPlaylist(target.playlistId, target.playlistName || "Untitled mixtape");
  });
  api.network.onDeepLink(onDeepLink);
  registerSongCounts();
  registerTabs();
  if (api.playback && typeof api.playback.onTrackStarted === "function") {
    api.playback.onTrackStarted(function (track) {
      loadTicks(track);
    });
  }
  if (canSyncLikes()) api.library.onLikeChanged(onLikeChanged);
  if (canScrobble()) api.playback.onTrackScrobbled(onTrackScrobbled);

  var restored = Promise.all([
    api.storage.get("session"),
    api.storage.get("imports"),
    api.storage.get("modules"),
    api.storage.get("lyricsImports"),
    api.storage.get("ticks"),
    api.storage.get("syncLikes"),
    api.storage.get("scrobble"),
    api.storage.get("playQueue"),
  ]).then(function (vals) {
    var session = vals[0];
    if (session && session.token) {
      state.token = session.token;
      state.user = session.user || null;
    }
    state.imports = vals[1] || {};
    var cached = validModules(vals[2]);
    if (cached.length) state.modules = cached;
    state.lyricsImports = vals[3] || {};
    state.ticks = vals[4] === true;
    state.syncLikes = vals[5] === true;
    state.scrobble = vals[6] === true;
    state.playQueue = Array.isArray(vals[7]) ? vals[7] : [];
  });
  // The song already playing: its start event came before the setting was
  // read, or not at all (the plugin was enabled or updated mid-song).
  restored.then(function () {
    if (api) loadTicks(currentTrack());
    // Plays left waiting by the last run (offline, or the app closed).
    if (api) sendPlays();
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
          if (api && state.tab !== MINE) switchTab(state.tab);
        });
      }, FIRST_LOAD_DELAY_MS);
    });
  return restored;
}

function deactivate() {
  if (firstLoadTimer) clearTimeout(firstLoadTimer);
  firstLoadTimer = null;
  if (playRetryTimer) clearTimeout(playRetryTimer);
  playRetryTimer = null;
  playSending = null;
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
  _countsText: countsText,
  _countsTitleLine: countsTitleLine,
  _tabTree: tabTree,
  _feedRow: feedRow,
  _subjectRow: subjectRow,
  _areaOf: areaOf,
  _builtinModules: BUILTIN_MODULES,
  _loadModules: function () {
    return loadModules();
  },
  _state: function () {
    return state;
  },
};
