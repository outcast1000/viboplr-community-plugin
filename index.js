// viboplr-community-plugin — Viboplr Community client: share Now Playing cue
// sheets and import ones other people made, and add the Subsonic / Navidrome
// servers their owners opened to everyone.
//
// Design notes:
//  - THE SERVER OWNS ACCOUNTS, THE APP OWNS SHEETS. Sign-in happens in the
//    browser (GitHub, through community.viboplr.com); the plugin only ever holds the
//    the server's own revocable `vcom_` token. Sheets are read and written through the
//    host's api.cues, so every import goes through the app's normalizer — what
//    lands is exactly what the app would accept from any other writer.
//  - PKCE OVER A DEEP LINK. The server hands a one-time code back through
//    viboplr://plugin/community/auth (scoped, so only this plugin sees it). The code
//    is useless without the verifier, which never leaves this worker — another
//    app that claims the viboplr:// scheme gets nothing.
//  - PROVENANCE LIVES HERE. A sheet file has no "came from the community" field, so
//    the mapping song → community item (+ the local updatedAt at import) is kept in
//    this plugin's storage. That is what lets "My sheets" tell an untouched
//    import (not ours to republish) from one the user has since changed.
//  - SERVERS GO THROUGH THE APP'S OWN DIALOG. "Add" hands the listing to
//    api.collections.requestAdd, which opens the same prefilled Add Server
//    dialog a viboplr://add-collection link opens. The user confirms there;
//    the plugin never creates a collection itself.
//  - NOT READY IS A BANNER. A server that can't be reached is shown inside the
//    view with a Retry, never as a toast (plugin view design guidelines).

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
var SERVER = "https://community.viboplr.com";
var VIEW = "community";
var TIMEOUT_MS = 15000;
var AUTH_TTL_MS = 10 * 60 * 1000;
var LINK_PREFIX = "viboplr://plugin/community/";
var USER_AGENT = "Viboplr-Community-Plugin/0.1 (+https://github.com/outcast1000/viboplr-community-plugin)";
var MAX_AUTHOR_CHARS = 64;
var FIRST_LOAD_DELAY_MS = 3000;

var api = null;
var state = freshState();
var firstLoadTimer = null;

function freshState() {
  return {
    token: null,
    user: null,
    // In-flight browser sign-in: { state, verifier, at }.
    auth: null,
    tab: "browse",
    query: "",
    sort: "recent",
    results: null,
    // The Servers tab: its own search, sort and pages.
    servers: null,
    serverQuery: "",
    serverSort: "recent",
    serverPage: 0,
    serverMore: false,
    page: 0,
    more: false,
    // The song the "This song" tab is about: { title, artist }.
    song: null,
    songItems: null,
    // api.cues.list() rows, and the server's view of what the user published,
    // keyed by songKey.
    local: null,
    published: {},
    // songKey → { id, version, updatedAt } for sheets imported from the community.
    imports: {},
    loading: false,
    error: null,
    // A pending in-view question: { kind: "import" | "replace", id, title, artist, by }.
    confirm: null,
    lastPublishedUrl: null,
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

function modeLabel(mode) {
  return mode === "clip" ? "lyric clip" : "cards";
}

// One community item → a track-row-list row. `imported` is this song's import
// record, if any.
function itemRow(item, imported) {
  var bits = [];
  if (item.artistName) bits.push(item.artistName);
  bits.push(plural(item.cueCount || 0, "cue", "cues") + " · " + modeLabel(item.mode));
  if (item.publisher && item.publisher.login) bits.push("@" + item.publisher.login);
  if (item.importCount) bits.push(plural(item.importCount, "import", "imports"));
  var row = {
    id: item.id,
    title: item.title,
    subtitle: bits.join(" · "),
    artistName: item.artistName || null,
    albumTitle: item.albumName || null,
  };
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
}

// One local sheet → a "My sheets" row, given what the server says the user
// published and what was imported.
function localRow(sheet, published, imported) {
  var key = songKey(sheet.title, sheet.artistName);
  var cues = (sheet.sheet && sheet.sheet.cues) || [];
  var bits = [];
  if (sheet.artistName) bits.push(sheet.artistName);
  bits.push(plural(cues.length, "cue", "cues") + " · " + modeLabel(sheet.sheet && sheet.sheet.mode));
  if (sheet.author) bits.push(sheet.author);
  var row = { id: key, title: sheet.title, subtitle: bits.join(" · "), artistName: sheet.artistName || null, albumTitle: sheet.albumName || null };
  var untouchedImport = imported && imported.updatedAt === sheet.updatedAt;
  if (published) {
    row.badge = { label: "Published", variant: "success" };
    row.actions = ["republish", "unpublish", "page"];
  } else if (untouchedImport) {
    row.badge = { label: "From the community", variant: "muted" };
    row.actions = [];
  } else {
    row.actions = ["publish"];
  }
  return row;
}

function errorText(e) {
  if (!e) return "Unknown error";
  return e.message || String(e);
}

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

function requestError(message, status) {
  var e = new Error(message);
  e.status = status;
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
      if (resp.status >= 400) throw requestError((data && data.error) || "Viboplr Community answered HTTP " + resp.status, resp.status);
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

function sessionLost() {
  state.token = null;
  state.user = null;
  state.published = {};
  saveSession().catch(function (e) {
    api.log("error", "Couldn't clear the stored session: " + errorText(e));
  });
  render();
}

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------

function signIn() {
  if (state.auth && Date.now() - state.auth.at < AUTH_TTL_MS) {
    notify("Finish signing in in your browser, or cancel and start again.");
    return Promise.resolve();
  }
  var verifier = base64url(randomBytes(32));
  var nonce = base64url(randomBytes(16));
  return pkceChallenge(verifier)
    .then(function (challenge) {
      state.auth = { state: nonce, verifier: verifier, at: Date.now() };
      render();
      return api.network.openUrl(
        SERVER + "/auth/github/start?" + queryString({ client: "app", state: nonce, code_challenge: challenge, code_challenge_method: "S256" })
      );
    })
    .catch(function (e) {
      state.auth = null;
      render();
      fail("Couldn't start signing in", e);
    });
}

function finishSignIn(params) {
  var pending = state.auth;
  if (!pending || params.state !== pending.state) {
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
  return request("POST", "/auth/exchange", { code: params.code, verifier: pending.verifier, label: "Viboplr app" })
    .then(function (data) {
      state.token = data.token;
      state.user = data.user;
      return saveSession();
    })
    .then(function () {
      notify("Signed in to Viboplr Community as @" + state.user.login + ".");
      render();
      return loadPublished();
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
      // Signing out locally still happens; the server's /me page can revoke the
      // session later.
      api.log("warn", "Couldn't revoke the server session: " + errorText(e));
    })
    .then(function () {
      state.token = null;
      state.user = null;
      state.published = {};
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

function loadBrowse(page) {
  page = page || 0;
  return withLoading(function () {
    return request("GET", "/v1/items/search?" + queryString({ kind: "cue_sheet", q: state.query, sort: state.sort, page: page })).then(
      function (data) {
        state.results = page > 0 && state.results ? state.results.concat(data.items) : data.items;
        state.page = page;
        state.more = !!data.hasMore;
      }
    );
  });
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

function loadPublished() {
  if (!state.token) {
    state.published = {};
    return Promise.resolve();
  }
  return request("GET", "/v1/me/items", undefined, true).then(function (data) {
    var byKey = {};
    data.items.forEach(function (item) {
      byKey[songKey(item.title, item.artistName)] = item;
    });
    state.published = byKey;
    render();
  });
}

function loadMine() {
  return withLoading(function () {
    return api.cues.list().then(function (rows) {
      state.local = rows;
      return loadPublished();
    });
  });
}

function currentSong() {
  var t = api.playback && api.playback.getCurrentTrack ? api.playback.getCurrentTrack() : null;
  return t && t.title ? { title: t.title, artist: t.artist_name || null } : null;
}

function switchTab(tab) {
  state.tab = tab;
  state.error = null;
  if (tab === "browse" && !state.results) return loadBrowse(0);
  if (tab === "song") return loadSong(state.song || currentSong());
  if (tab === "mine") return loadMine();
  if (tab === "servers" && !state.servers) return loadServers(0);
  render();
  return Promise.resolve();
}

// ---------------------------------------------------------------------------
// Import / publish
// ---------------------------------------------------------------------------

function loadServers(page) {
  page = page || 0;
  return withLoading(function () {
    return request(
      "GET",
      "/v1/items/search?" + queryString({ kind: "subsonic_server", q: state.serverQuery, sort: state.serverSort, page: page })
    ).then(function (data) {
      state.servers = page > 0 && state.servers ? state.servers.concat(data.items) : data.items;
      state.serverPage = page;
      state.serverMore = !!data.hasMore;
    });
  });
}

// Offer a listed server to the user through the app's own Add Server dialog.
// The listing's login is only on the single read, so fetch it first.
function addServer(id) {
  if (!api.collections || typeof api.collections.requestAdd !== "function") {
    // Older app: the website's Add button opens the same dialog by deep link.
    return api.network.openUrl(SERVER + "/c/" + encodeURIComponent(id));
  }
  return request("GET", "/v1/items/" + encodeURIComponent(id))
    .then(function (data) {
      var item = data.item;
      var p = item.payload || {};
      return api.collections
        .requestAdd({ kind: "subsonic", name: item.title, url: p.url, username: p.username || "", password: p.password || "" })
        .then(function () {
          request("POST", "/v1/items/" + encodeURIComponent(item.id) + "/imported").catch(function (e) {
            api.log("warn", "Couldn't count the add: " + errorText(e));
          });
        });
    })
    .catch(function (e) {
      if (e && e.status === 404) notify("That server isn't listed any more.");
      else fail("Couldn't add that server", e);
    });
}

function knownItem(id) {
  var lists = [state.results || [], state.songItems || [], state.servers || []];
  for (var i = 0; i < lists.length; i++) {
    for (var j = 0; j < lists[i].length; j++) if (lists[i][j].id === id) return lists[i][j];
  }
  return null;
}

// Import a community item. Asks first when it would replace a local sheet that
// isn't this same item, untouched.
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
            request("POST", "/v1/items/" + encodeURIComponent(item.id) + "/imported").catch(function (e) {
              api.log("warn", "Couldn't count the import: " + errorText(e));
            });
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

function requireSignIn(what) {
  if (state.token) return true;
  notify("Sign in with GitHub to " + what + ".", { action: { label: "Sign in", id: "sign-in" } });
  return false;
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
        state.published[key] = data.item;
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

function unpublish(key) {
  var item = state.published[key];
  if (!item) return Promise.resolve();
  return request("DELETE", "/v1/items/" + encodeURIComponent(item.id), undefined, true)
    .then(function () {
      delete state.published[key];
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

// A share link (viboplr://plugin/community/open?id=…): show the song, ask to import.
function openShared(id) {
  if (!id) return Promise.resolve();
  api.ui.navigateToView(VIEW);
  return request("GET", "/v1/items/" + encodeURIComponent(id))
    .then(function (data) {
      var item = data.item;
      state.tab = "song";
      state.confirm = { kind: "import", id: item.id, title: item.title, artist: item.artistName, by: item.publisher.login };
      return loadSong({ title: item.title, artist: item.artistName });
    })
    .catch(function (e) {
      if (e && e.status === 404) notify("That cue sheet isn't in the community any more.");
      else fail("Couldn't open that cue sheet", e);
    });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function setHeader() {
  if (typeof api.ui.setViewHeader !== "function") return;
  var status;
  var first;
  if (state.auth) {
    status = { variant: "warning", label: "Signing in…" };
    first = { label: "Cancel sign-in", action: "cancel-sign-in", variant: "secondary" };
  } else if (state.user) {
    status = { variant: "success", label: "@" + state.user.login };
    first = { label: "Sign out", action: "sign-out", variant: "secondary" };
  } else {
    status = { variant: "muted", label: "Signed out" };
    first = { label: "Sign in with GitHub", action: "sign-in", variant: "accent" };
  }
  api.ui.setViewHeader(VIEW, { status: status, actions: [first, { label: "Open website", action: "open-site", variant: "secondary" }] });
}

function banner(text, variant, buttons) {
  return {
    type: "layout",
    direction: "horizontal",
    className: "ds-banner ds-banner--" + (variant || "warning"),
    children: [{ type: "text", content: text }].concat(buttons || []),
  };
}

function itemRowList(items) {
  return {
    type: "track-row-list",
    selectable: true,
    selectionMode: "single",
    artwork: "cached",
    contextMenu: false,
    actions: [
      { id: "import", label: "Import" },
      { id: "update", label: "Update" },
      { id: "page", label: "Open page" },
    ],
    items: items.map(function (item) {
      return itemRow(item, state.imports[songKey(item.title, item.artistName)]);
    }),
  };
}

function browseNodes() {
  var nodes = [
    { type: "search-input", placeholder: "Search artist, song or album", action: "search", value: state.query, submitOnly: true, buttonLabel: "Search" },
    {
      type: "select",
      label: "Sort",
      action: "sort",
      value: state.sort,
      options: [
        { value: "recent", label: "Recent" },
        { value: "popular", label: "Most imported" },
      ],
    },
  ];
  if (state.loading && !state.results) nodes.push({ type: "loading", message: "Loading cue sheets…" });
  else if (state.results && state.results.length === 0) {
    nodes.push({ type: "text", content: state.query ? "No cue sheets match that search." : "Nothing shared yet. Publish one from My sheets to be the first." });
  } else if (state.results) {
    nodes.push(itemRowList(state.results));
    if (state.more) nodes.push({ type: "button", label: state.loading ? "Loading…" : "Load more", action: "more", variant: "secondary", disabled: state.loading });
  }
  return nodes;
}

function songNodes() {
  if (!state.song) {
    return [{ type: "text", content: "Play a song, or right-click a track and choose “Find shared cue sheets”." }];
  }
  var nodes = [{ type: "text", content: (state.song.artist ? state.song.artist + " — " : "") + state.song.title, className: "ds-heading" }];
  if (state.loading && !state.songItems) nodes.push({ type: "loading", message: "Looking in the community…" });
  else if (state.songItems && state.songItems.length === 0) nodes.push({ type: "text", content: "Nobody has shared a cue sheet for this song yet." });
  else if (state.songItems) nodes.push(itemRowList(state.songItems));
  return nodes;
}

// One server listing → a row.
function serverRow(item) {
  var bits = [];
  if (item.host) bits.push(item.host);
  if (item.tags && item.tags.length) bits.push(item.tags.join(", "));
  if (item.publisher && item.publisher.login) bits.push("@" + item.publisher.login);
  if (item.importCount) bits.push(plural(item.importCount, "add", "adds"));
  return { id: item.id, title: item.title, subtitle: bits.join(" · "), actions: ["add-server", "page"] };
}

function serverNodes() {
  var nodes = [
    {
      type: "search-input",
      placeholder: "Search name, description, address or tag",
      action: "search-servers",
      value: state.serverQuery,
      submitOnly: true,
      buttonLabel: "Search",
    },
    {
      type: "layout",
      direction: "horizontal",
      children: [
        {
          type: "select",
          label: "Sort",
          action: "sort-servers",
          value: state.serverSort,
          options: [
            { value: "recent", label: "Recent" },
            { value: "popular", label: "Most added" },
          ],
        },
        { type: "button", label: "List a server", action: "list-server", variant: "secondary" },
      ],
    },
  ];
  if (state.loading && !state.servers) nodes.push({ type: "loading", message: "Loading servers…" });
  else if (state.servers && state.servers.length === 0) {
    nodes.push({ type: "text", content: state.serverQuery ? "No servers match that search." : "No servers listed yet. Run one you're happy to share? List it." });
  } else if (state.servers) {
    nodes.push({ type: "text", content: "Servers their owners opened to everyone. Add puts one in your library, after you confirm.", className: "ds-muted" });
    nodes.push({
      type: "track-row-list",
      selectable: true,
      selectionMode: "single",
      contextMenu: false,
      actions: [
        { id: "add-server", label: "Add" },
        { id: "page", label: "Open page" },
      ],
      items: state.servers.map(serverRow),
    });
    if (state.serverMore) {
      nodes.push({ type: "button", label: state.loading ? "Loading…" : "Load more", action: "more-servers", variant: "secondary", disabled: state.loading });
    }
  }
  return nodes;
}

function mineNodes() {
  var nodes = [];
  if (!state.token) {
    nodes.push(banner("Sign in with GitHub to publish your sheets.", "muted", [{ type: "button", label: "Sign in", action: "sign-in", variant: "accent" }]));
  }
  if (state.loading && !state.local) {
    nodes.push({ type: "loading", message: "Reading your cue sheets…" });
    return nodes;
  }
  var rows = state.local || [];
  if (rows.length === 0) {
    nodes.push({ type: "text", content: "You have no cue sheets yet. Ask your AI assistant to write one for a song, or import one from Browse." });
    return nodes;
  }
  nodes.push({
    type: "track-row-list",
    selectable: true,
    selectionMode: "single",
    artwork: "cached",
    contextMenu: false,
    actions: [
      { id: "publish", label: "Publish" },
      { id: "republish", label: "Update online" },
      { id: "unpublish", label: "Unpublish" },
      { id: "page", label: "Open page" },
    ],
    items: rows.map(function (sheet) {
      var key = songKey(sheet.title, sheet.artistName);
      return localRow(sheet, state.published[key], state.imports[key]);
    }),
  });
  return nodes;
}

function confirmNode() {
  var c = state.confirm;
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
      tabs: [
        { id: "browse", label: "Browse" },
        { id: "song", label: "This song" },
        { id: "mine", label: "My sheets", count: state.local ? state.local.length : undefined },
        { id: "servers", label: "Servers" },
      ],
    },
  ];
  if (state.confirm) children.push(confirmNode());
  if (state.auth) {
    children.push(banner("Finish signing in in your browser. Viboplr will pick it up when you're done.", "muted", [
      { type: "button", label: "Cancel", action: "cancel-sign-in", variant: "secondary" },
    ]));
  }
  if (state.error) {
    children.push(banner("Couldn't reach Viboplr Community: " + state.error, "warning", [{ type: "button", label: "Try again", action: "retry", variant: "accent" }]));
  }
  var body =
    state.tab === "song" ? songNodes() : state.tab === "mine" ? mineNodes() : state.tab === "servers" ? serverNodes() : browseNodes();
  api.ui.setViewData(VIEW, { type: "layout", direction: "vertical", children: children.concat(body) }, { scrollKey: state.tab });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function rowId(payload) {
  return payload && (payload.itemId || (payload.selectedIds && payload.selectedIds[0]));
}

function pageFor(id) {
  var item = knownItem(id);
  return item ? item.url : SERVER + "/c/" + encodeURIComponent(id);
}

var ACTIONS = {
  tab: function (p) {
    return switchTab(p && p.tabId);
  },
  search: function (p) {
    state.query = (p && p.query) || "";
    return loadBrowse(0);
  },
  "search-servers": function (p) {
    state.serverQuery = (p && p.query) || "";
    return loadServers(0);
  },
  "sort-servers": function (p) {
    state.serverSort = p && p.value === "popular" ? "popular" : "recent";
    return loadServers(0);
  },
  "more-servers": function () {
    return loadServers(state.serverPage + 1);
  },
  "add-server": function (p) {
    return addServer(rowId(p));
  },
  "list-server": function () {
    return api.network.openUrl(SERVER + "/servers/new");
  },
  sort: function (p) {
    state.sort = p && p.value === "popular" ? "popular" : "recent";
    return loadBrowse(0);
  },
  more: function () {
    return loadBrowse(state.page + 1);
  },
  retry: function () {
    state.error = null;
    if (state.tab === "song") return loadSong(state.song || currentSong());
    if (state.tab === "mine") return loadMine();
    if (state.tab === "servers") return loadServers(0);
    return loadBrowse(0);
  },
  import: function (p) {
    return importItem(rowId(p), false);
  },
  update: function (p) {
    return importItem(rowId(p), true);
  },
  page: function (p) {
    var id = rowId(p);
    if (state.tab === "mine") {
      var item = state.published[id];
      return item ? api.network.openUrl(item.url) : Promise.resolve();
    }
    return api.network.openUrl(pageFor(id));
  },
  publish: function (p) {
    var row = localByKey(rowId(p));
    return row ? publishSong(row.title, row.artistName) : Promise.resolve();
  },
  republish: function (p) {
    return ACTIONS.publish(p);
  },
  unpublish: function (p) {
    return unpublish(rowId(p));
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
  "sign-in": function () {
    return signIn();
  },
  "cancel-sign-in": function () {
    state.auth = null;
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
    state.tab = "song";
    return loadSong({ title: target.title, artist: target.artistName || null });
  });
  api.contextMenu.onAction("publish-cues", function (target) {
    if (!target || !target.title) return;
    return publishSong(target.title, target.artistName || null);
  });
  api.network.onDeepLink(onDeepLink);

  var restored = Promise.all([api.storage.get("session"), api.storage.get("imports")]).then(function (vals) {
    var session = vals[0];
    if (session && session.token) {
      state.token = session.token;
      state.user = session.user || null;
    }
    state.imports = vals[1] || {};
  });
  restored
    .catch(function (e) {
      api.log("error", "Couldn't restore the server session: " + errorText(e));
    })
    .then(function () {
      render();
      // Fill Browse shortly after launch rather than inside it: activation
      // runs before the app is idle, and the view may never be opened.
      firstLoadTimer = setTimeout(function () {
        firstLoadTimer = null;
        if (api && !state.results) loadBrowse(0);
      }, FIRST_LOAD_DELAY_MS);
    });
  return restored;
}

function deactivate() {
  if (firstLoadTimer) clearTimeout(firstLoadTimer);
  firstLoadTimer = null;
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
  _itemRow: itemRow,
  _localRow: localRow,
  _serverRow: serverRow,
  _state: function () {
    return state;
  },
};
