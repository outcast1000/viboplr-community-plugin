// Plugin 1.0: Discover, the Community tab on Viboplr's own pages, and the
// seek-bar ticks.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadPlugin } = require("./harness/sandbox");
const { makeHost } = require("./harness/host");

function nodes(tree, type, out = []) {
  if (!tree || typeof tree !== "object") return out;
  if (tree.type === type) out.push(tree);
  for (const c of tree.children || []) nodes(c, type, out);
  if (tree.control) nodes(tree.control, type, out);
  return out;
}

const flush = async (n = 5) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

const SIGNED_IN = { token: "vcom_tok", user: { login: "alice" } };
const JOGA = { id: 7, kind: "track", name: "Jóga", artistName: "Björk", counts: { cue_sheet: 1 }, likes: 3, liked: false, comments: 1, url: "https://community.viboplr.com/track/7" };
const BJORK = { id: 2, kind: "artist", name: "Björk", counts: {}, likes: 9, comments: 0, url: "https://community.viboplr.com/artist/2" };
const SHEET_ITEM = {
  id: "abc123",
  kind: "cue_sheet",
  title: "Jóga",
  artistName: "Björk",
  version: 1,
  importCount: 4,
  publisher: { login: "bob" },
  url: "https://community.viboplr.com/cue-sheets/abc123",
  card: { title: "Björk — Jóga", facts: ["2 cues", "cards"], action: { label: "Open in Viboplr", link: "viboplr://x" } },
};
const COMMENT = { id: 11, subjectId: 7, body: "that bridge", atSecs: 161, createdAt: 0, likes: 2, liked: false, author: { login: "bob", avatarUrl: null }, url: "https://community.viboplr.com/track/7#comment-11" };

// What POST /v1/plays answers; a test sets it to simulate an outage.
const playsServer = { status: 200 };

// A community with Jóga (a cue sheet, a comment) and Björk (songs with something shared).
function route(log = []) {
  return (u, init = {}) => {
    log.push([init.method || "GET", u.pathname + u.search]);
    const p = u.pathname;
    if (p === "/v1/subjects/resolve") {
      const kind = u.searchParams.get("kind");
      if (kind === "track" && u.searchParams.get("title") === "Jóga") return { body: { subject: JOGA } };
      if (kind === "artist" && u.searchParams.get("name") === "Björk") return { body: { subject: BJORK } };
      return undefined;
    }
    if (p === "/v1/subjects/7/comments") {
      if (init.method === "POST") return { status: 201, body: { comment: { ...COMMENT, id: 12, body: JSON.parse(init.body).body } } };
      return { body: { comments: u.searchParams.get("timed") ? [COMMENT] : [COMMENT], hasMore: false } };
    }
    if (p === "/v1/plays") {
      if (playsServer.status !== 200) return { status: playsServer.status, body: { error: "nope" } };
      const n = JSON.parse(init.body).plays.length;
      return { body: { accepted: n, skipped: 0 } };
    }
    if (p === "/v1/likes") return { body: { subject: { id: 7, kind: "track", url: "u" }, likes: 4, liked: init.method === "PUT" } };
    if (p === "/v1/subjects/7/like") return { body: { likes: init.method === "PUT" ? 4 : 3, liked: init.method === "PUT" } };
    if (p === "/v1/subjects/2/comments") return { body: { comments: [], hasMore: false } };
    if (p === "/v1/subjects/2/children") return { body: { tracks: [JOGA], albums: [] } };
    if (p === "/v1/subjects/7") return { body: { subject: JOGA } };
    if (p === "/v1/items" && u.searchParams.get("kind") === "cue_sheet") return { body: { items: [SHEET_ITEM] } };
    if (p === "/v1/subjects/search") return { body: { subjects: [BJORK, JOGA], hasMore: false } };
    if (p === "/v1/activity") {
      return {
        body: {
          entries: [
            { type: "comment", event: "commented", at: 0, comment: COMMENT, subject: JOGA },
            { type: "item", event: "published", at: 0, item: { id: "mx1", kind: "mixtape", title: "Late night", version: 1, publisher: { login: "bob" }, url: "u" }, subject: null },
          ],
          hasMore: false,
        },
      };
    }
    return undefined;
  };
}

async function setup(opts = {}) {
  const plugin = loadPlugin();
  const log = [];
  const host = makeHost({ route: route(log), ...opts });
  if (opts.session) host.storage.set("session", opts.session);
  if (opts.ticks) host.storage.set("ticks", true);
  if (opts.syncLikes !== undefined) host.storage.set("syncLikes", opts.syncLikes);
  await plugin.activate(host.api);
  return { plugin, host, log };
}

const tab = (host, kind, entity) => host.infoProviders["community_" + kind]({ id: 0, ...entity });
const joga = { kind: "track", name: "Jóga", artistName: "Björk" };

test("Discover searches songs, albums and artists and opens them on their Community tab", async () => {
  const { host } = await setup();
  await host.actions["discover-search"]({ query: "bjork" });
  const view = host.lastView();
  assert.deepEqual(nodes(view, "tabs")[0].tabs.map((t) => t.label), ["Discover", "Mixtapes", "Subsonic servers", "You", "Settings"]);
  const sections = nodes(view, "section").map((s) => s.title);
  assert.deepEqual(sections.slice(0, 2), ["Artists", "Songs"]);
  const song = nodes(view, "track-row-list")[1].items[0];
  assert.equal(song.subtitle, "Song · Björk · 1 cue sheet · 1 comment · ♥ 3");
  await host.actions["open-subject"]({ itemId: song.id });
  assert.deepEqual(host.entityOpens.at(-1), ["track", { name: "Jóga", artistName: "Björk" }, { tab: "community_track" }]);
  // An older app without navigateToEntity: the page opens, without the tab.
  delete host.api.ui.navigateToEntity;
  await host.actions["open-subject"]({ itemId: "subject:2" });
  assert.deepEqual(host.requestedActions.at(-1), ["navigate-to-artist", { name: "Björk" }]);
});

test("the feed says who did what, and each entry opens where it belongs", async () => {
  const { host, plugin } = await setup();
  await plugin._state();
  await host.actions.tab({ tabId: "discover" });
  await flush();
  const feed = nodes(host.lastView(), "track-row-list").at(-1).items;
  assert.equal(feed[0].title, "Jóga · Björk");
  assert.match(feed[0].subtitle, /^@bob commented: “that bridge” · /);
  await host.actions["open-entry"]({ itemId: feed[0].id });
  assert.deepEqual(host.entityOpens.at(-1)[0], "track");
});

test("the song's Community tab: like, the cue sheets to import, and comments", async () => {
  const { host } = await setup({ session: SIGNED_IN });
  const out = await tab(host, "track", joga);
  assert.equal(out.status, "ok");
  const tree = out.value;
  const like = nodes(tree, "button").find((b) => b.action === "tab-like");
  assert.equal(like.label, "♡ Like · 3");
  const sections = nodes(tree, "section").map((s) => s.title);
  assert.deepEqual(sections, ["Cue sheets · 1", "Comments · 1"]);
  const sheetRow = nodes(nodes(tree, "section")[0], "track-row-list")[0].items[0];
  assert.deepEqual(sheetRow.actions, ["tab-import", "page"]);
  const comment = nodes(nodes(tree, "section")[1], "track-row-list")[0].items[0];
  assert.equal(comment.title, "that bridge");
  assert.match(comment.subtitle, /^@bob · at 2:41 · .* · ♥ 2$/);
  assert.deepEqual(comment.actions, ["tab-comment-like", "tab-comment-report"]);

  // Like: one PUT, then the tab is redrawn in place.
  await host.actions["tab-like"]({ entity: joga });
  const redraw = host.sectionData.at(-1);
  assert.equal(redraw.typeId, "community_track");
  assert.equal(nodes(redraw.data, "button").find((b) => b.action === "tab-like").label, "♥ Liked · 4");
});

test("a comment can be pinned to where the song is now", async () => {
  const { host, log } = await setup({ session: SIGNED_IN, current: { key: "q:1", title: "Jóga", artist_name: "Björk" } });
  host.position = 161.7;
  const tree = (await tab(host, "track", joga)).value;
  assert.ok(nodes(tree, "button").some((b) => b.action === "tab-comment-at" && b.label === "@ 2:41"));
  await host.actions["tab-comment-at"]({ entity: joga });
  assert.ok(nodes(host.sectionData.at(-1).data, "button").some((b) => b.label === "at 2:41 ✕"));
  await host.actions["tab-comment"]({ entity: joga, query: "  here  " });
  const post = log.find(([m, path]) => m === "POST" && path === "/v1/subjects/7/comments");
  assert.ok(post, "posted");
  const body = JSON.parse(host.requests.find((r) => r.init.method === "POST" && r.url.endsWith("/comments")).init.body);
  assert.deepEqual(body, { body: "here", atSecs: 161 });
});

test("signed out, the tab invites a sign-in instead of a composer", async () => {
  const { host } = await setup();
  const tree = (await tab(host, "track", joga)).value;
  assert.equal(nodes(tree, "button").find((b) => b.action === "tab-sign-in").label, "♡ Like · 3");
  assert.equal(nodes(tree, "search-input").length, 0);
});

test("something nobody shared about still gets a tab, inviting the first share", async () => {
  const { host } = await setup({ session: SIGNED_IN });
  const out = await tab(host, "track", { kind: "track", name: "Unheard", artistName: "Nobody" });
  assert.equal(out.status, "ok");
  assert.ok(nodes(out.value, "text").some((t) => /Nothing on Viboplr Community about this song yet/.test(t.content)));
  assert.ok(nodes(out.value, "button").some((b) => b.action === "tab-publish-lyrics"));
});

test("rows show the picture Community matched, and only one Community serves", async () => {
  const { plugin } = await setup();
  const art = { small: "https://community.viboplr.com/art/3/80.jpg?v=abc", large: "https://community.viboplr.com/art/3/240.jpg?v=abc" };
  assert.equal(plugin._subjectRow({ ...JOGA, art }).imageUrl, art.small);
  assert.equal(plugin._subjectRow({ ...JOGA, art: null }).imageUrl, undefined, "none matched: the host's own art for the names");
  assert.equal(plugin._subjectRow(JOGA).imageUrl, undefined, "an older server sends no art");
  assert.equal(plugin._subjectRow({ ...JOGA, art: { small: "https://evil.example/x.jpg" } }).imageUrl, undefined);
  const entry = { type: "comment", subject: { ...JOGA, art }, comment: COMMENT, at: 0 };
  assert.equal(plugin._feedRow(entry, 0).imageUrl, art.small);
  assert.equal(plugin._feedRow({ type: "item", event: "shared", item: SHEET_ITEM, at: 0 }, 1).imageUrl, undefined);
});

test("likes made in the app reach Community by default, as likes and un-likes, until switched off", async () => {
  const { host, log } = await setup({ session: SIGNED_IN });
  const sent = () => log.filter(([, p]) => p === "/v1/likes").map(([m]) => m);
  const like = (over) => host.likeChanged({ kind: "track", name: "Jóga", artistName: "Björk", albumTitle: "Homogenic", albumArtistName: "Björk", liked: 1, previous: 0, ...over });

  // On by default: nothing stored yet still sends.
  await host.actions.tab({ tabId: "settings" });
  const toggle = () => nodes(host.lastView(), "toggle").find((t) => t.action === "toggle-sync-likes");
  assert.equal(toggle().checked, true);

  // Switched off: nothing leaves the app, and the choice is kept.
  await host.actions["toggle-sync-likes"]({ value: false });
  assert.equal(toggle().checked, false);
  assert.equal(host.storage.get("syncLikes"), false);
  await like();
  await flush();
  assert.deepEqual(sent(), []);

  await host.actions["toggle-sync-likes"]({ value: true });
  assert.equal(toggle().checked, true);
  assert.equal(host.storage.get("syncLikes"), true);

  await like();
  await like({ liked: 0, previous: 1 }); // un-like
  await like({ liked: -1, previous: 1 }); // liked → disliked: the like goes
  await like({ liked: -1, previous: 0 }); // a dislike of something never liked: nothing to say
  await like({ kind: "tag", name: "jazz", artistName: null, albumTitle: null, albumArtistName: null }); // not a subject
  await like({ kind: "album", name: "Post", artistName: null }); // an album without its artist can't be keyed
  await flush(10);
  assert.deepEqual(sent(), ["PUT", "DELETE", "DELETE"]);
  const body = JSON.parse(host.requests.find((r) => r.url.endsWith("/v1/likes")).init.body);
  assert.deepEqual(body, { kind: "track", name: "Jóga", artistName: "Björk", albumName: "Homogenic", albumArtistName: "Björk" });
});

const PLAYED = { key: "q:1", title: "Jóga", artist_name: "Björk", album_title: "Homogenic", album_artist_name: "Björk" };

test("the manifest starts the scrobbler off in the app's Settings → Scrobbling", () => {
  const manifest = require("../manifest.json");
  assert.deepEqual(manifest.contributes.scrobbler, { defaultEnabled: false });
});

// The app hands a play over only when Settings → Scrobbling has Community on,
// so every play that arrives is sent; the handler reports how it went.
test("a play handed over is sent, with when it started, and reported as sent", async () => {
  const { host } = await setup({ session: SIGNED_IN });
  const posts = () => host.requests.filter((r) => r.url.endsWith("/v1/plays")).map((r) => JSON.parse(r.init.body).plays);
  host.position = 152;
  const before = Math.floor(Date.now() / 1000);
  const report = await host.trackScrobbled(PLAYED);
  assert.deepEqual(report, { status: "sent", pending: 0 });
  const [[sent]] = posts();
  assert.deepEqual({ ...sent, playedAt: 0 }, { title: "Jóga", artistName: "Björk", albumName: "Homogenic", albumArtistName: "Björk", playedAt: 0 });
  assert.ok(Math.abs(sent.playedAt - (before - 152)) <= 1, "the play started 152 s before the threshold");
  assert.deepEqual(host.storage.get("playQueue"), [], "sent plays leave the queue");
  await host.actions.tab({ tabId: "settings" });
  assert.match(JSON.stringify(nodes(host.lastView(), "text")), /All your plays are sent/);
  assert.ok(!nodes(host.lastView(), "toggle").some((n) => n.action === "toggle-scrobble"), "no switch of its own");
  // A song with no artist isn't a scrobble the server can take.
  assert.equal((await host.trackScrobbled({ ...PLAYED, artist_name: null })).status, "skipped");
  assert.equal(posts().length, 1);
});

// An older Viboplr ignores `scrobbler.defaultEnabled` and would hand every
// play over, so there the plugin's own opt-in switch still decides.
test("on a Viboplr that doesn't own scrobbling, plays wait for the plugin's own switch", async () => {
  const { host } = await setup({ session: SIGNED_IN });
  delete host.api.playback.reportScrobble;
  const posts = () => host.requests.filter((r) => r.url.endsWith("/v1/plays"));
  assert.equal(await host.trackScrobbled(PLAYED), undefined);
  await flush();
  assert.equal(posts().length, 0, "off until switched on");
  await host.actions.tab({ tabId: "settings" });
  assert.ok(nodes(host.lastView(), "toggle").some((n) => n.action === "toggle-scrobble"), "the switch is shown");
  await host.actions["toggle-scrobble"]({ value: true });
  assert.equal(host.storage.get("scrobble"), true);
  await host.trackScrobbled(PLAYED);
  await flush(10);
  assert.equal(posts().length, 1);
});

test("signed out, plays wait and the report says to sign in", async () => {
  const { host } = await setup();
  const report = await host.trackScrobbled(PLAYED);
  assert.deepEqual(report, { status: "queued", pending: 1, message: "Sign in to Viboplr Community to send" });
  assert.ok(!host.requests.some((r) => r.url.endsWith("/v1/plays")));
  assert.equal(host.storage.get("playQueue").length, 1);
});

test("plays made while Community is unreachable wait, survive a restart, and go later", async () => {
  playsServer.status = 503;
  try {
    const { host, plugin } = await setup({ session: SIGNED_IN });
    await host.trackScrobbled(PLAYED);
    const report = await host.trackScrobbled({ ...PLAYED, title: "Hunter" });
    await flush(10);
    assert.equal(host.storage.get("playQueue").length, 2, "kept for later");
    assert.equal(report.status, "queued");
    assert.equal(report.pending, 2);
    assert.match(report.message, /Couldn't reach Viboplr Community/);
    await host.actions.tab({ tabId: "settings" });
    assert.match(JSON.stringify(nodes(host.lastView(), "text")), /2 plays waiting to be sent/);

    // The app restarts with the server back: the queue goes out on its own.
    playsServer.status = 200;
    await plugin.deactivate();
    const sentBefore = host.requests.filter((r) => r.url.endsWith("/v1/plays")).length;
    await plugin.activate(host.api);
    await flush(10);
    const posts = host.requests.filter((r) => r.url.endsWith("/v1/plays"));
    assert.equal(posts.length, sentBefore + 1, "one batch");
    assert.deepEqual(JSON.parse(posts.at(-1).init.body).plays.map((p) => p.title), ["Jóga", "Hunter"]);
    assert.deepEqual(host.storage.get("playQueue"), []);
    assert.deepEqual(host.scrobbleReports.at(-1), { status: "sent", pending: 0 }, "the late send is reported to the app");
  } finally {
    playsServer.status = 200;
  }
});

test("plays the server refuses or too old to send are dropped, and the app is told", async () => {
  const { host, plugin } = await setup({ session: SIGNED_IN });
  const old = Math.floor(Date.now() / 1000) - 15 * 86400;
  host.storage.set("playQueue", [{ title: "Old", artistName: "Björk", playedAt: old }]);
  playsServer.status = 400;
  try {
    await plugin.deactivate();
    await plugin.activate(host.api);
    await flush(10);
    assert.ok(!host.requests.some((r) => r.url.endsWith("/v1/plays")), "a two-week-old play isn't even sent");
    assert.deepEqual(host.storage.get("playQueue"), []);
    assert.equal(host.scrobbleReports.at(-1).status, "failed");
    assert.match(host.scrobbleReports.at(-1).message, /too old to send/);
    const report = await host.trackScrobbled(PLAYED);
    assert.deepEqual(host.storage.get("playQueue"), [], "a refused batch is dropped, not retried forever");
    assert.deepEqual(report, { status: "failed", message: "Viboplr Community refused 1 play", pending: 0 });
  } finally {
    playsServer.status = 200;
  }
});

test("the switches live on Settings, which links to the plugin's Extensions page on a host that opens it", async () => {
  const toggles = (host) => nodes(host.lastView(), "toggle").map((t) => t.action);
  const extButton = (host) => nodes(host.lastView(), "button").find((b) => b.action === "open-extension-settings");

  const old = await setup({ session: SIGNED_IN });
  await old.host.actions.tab({ tabId: "you" });
  assert.ok(!toggles(old.host).includes("toggle-sync-likes"), "You holds no switches");
  await old.host.actions.tab({ tabId: "settings" });
  assert.ok(toggles(old.host).includes("toggle-sync-likes"));
  assert.ok(toggles(old.host).includes("toggle-ticks"));
  assert.equal(extButton(old.host), undefined, "an older host can't open the page, so no button");

  const { host } = await setup({ session: SIGNED_IN, appVersion: "1.0.103" });
  await host.actions.tab({ tabId: "settings" });
  assert.ok(extButton(host));
  await host.actions["open-extension-settings"]();
  assert.deepEqual(host.requestedActions.at(-1), ["open-extension-settings", {}]);
});

test("a saved switch-off survives a restart: likes stay in the app", async () => {
  const { host, log } = await setup({ session: SIGNED_IN, syncLikes: false });
  await host.likeChanged({ kind: "artist", name: "Björk", artistName: null, albumTitle: null, albumArtistName: null, liked: 1, previous: 0 });
  await flush();
  assert.ok(!log.some(([, p]) => p === "/v1/likes"));
  await host.actions.tab({ tabId: "settings" });
  assert.equal(nodes(host.lastView(), "toggle").find((t) => t.action === "toggle-sync-likes").checked, false);
});

test("signed out, likes stay in the app and the switch can't be turned on", async () => {
  const { host, log } = await setup();
  host.storage.set("syncLikes", true);
  await host.actions.tab({ tabId: "settings" });
  await host.actions["toggle-sync-likes"]({ value: true });
  const toggle = nodes(host.lastView(), "toggle").find((t) => t.action === "toggle-sync-likes");
  assert.equal(toggle.disabled, true);
  await host.likeChanged({ kind: "artist", name: "Björk", artistName: null, albumTitle: null, albumArtistName: null, liked: 1, previous: 0 });
  await flush();
  assert.ok(!log.some(([, p]) => p === "/v1/likes"));
});

test("an artist's tab lists its songs with something shared, and has no image gallery", async () => {
  const { host, log } = await setup();
  const tree = (await tab(host, "artist", { kind: "artist", name: "Björk" })).value;
  assert.ok(nodes(tree, "section").some((s) => s.title === "Songs with something shared"));
  assert.equal(nodes(tree, "card-grid").length, 0);
  assert.ok(!log.some(([, p]) => p.includes("/images")), "no images are asked for");
});

test("seek-bar ticks are off until switched on, then show the playing song's timed comments", async () => {
  const track = { key: "q:5", title: "Jóga", artist_name: "Björk" };
  const { host, log } = await setup({ current: track });
  host.trackStarted(track);
  await flush();
  assert.equal(log.filter(([, p]) => p.includes("/comments")).length, 0, "nothing asked while off");
  await host.actions.tab({ tabId: "settings" });
  const toggle = nodes(host.lastView(), "toggle").find((t) => t.action === "toggle-ticks");
  assert.equal(toggle.checked, false);
  await host.actions["toggle-ticks"]({ value: true });
  await flush();
  assert.equal(host.storage.get("ticks"), true);
  assert.deepEqual(host.markers.at(-1), { trackKey: "q:5", markers: [{ at: 161, label: "@bob: that bridge" }] });
  await host.actions["toggle-ticks"]({ value: false });
  assert.deepEqual(host.markers.at(-1), { trackKey: "q:5", markers: [] });
});

test("songs looked up as they play are asked anonymously; only the Community tab asks as you", async () => {
  const track = { key: "q:5", title: "Jóga", artist_name: "Björk" };
  const { host } = await setup({ session: SIGNED_IN, current: track, ticks: true });
  host.trackStarted(track);
  await flush();
  const resolves = () => host.requests.filter((r) => new URL(r.url).pathname === "/v1/subjects/resolve");
  assert.ok(resolves().length > 0, "the ticks looked the song up");
  assert.ok(resolves().every((r) => !r.init.headers.Authorization), "no token while playing");
  await tab(host, "track", joga);
  assert.equal(resolves().at(-1).init.headers.Authorization, "Bearer vcom_tok", "the tab shows whether you like it");
});

test("a compilation track is published under its album artist", async () => {
  const { host } = await setup({ session: SIGNED_IN });
  host.libraryTracks = [{ id: 1, title: "Jóga", artist_name: "Björk", album_title: "Gling-Gló", album_artist_name: "Various Artists" }];
  await host.addSheet("Jóga", "Björk", { cues: [{ at: 1, text: "hi" }] }, { albumName: "Gling-Gló" });
  await host.menu["publish-cues"]({ kind: "track", title: "Jóga", artistName: "Björk" });
  const post = host.requests.find((r) => r.init.method === "POST" && new URL(r.url).pathname === "/v1/items");
  const body = JSON.parse(post.init.body);
  assert.equal(body.albumName, "Gling-Gló");
  assert.equal(body.albumArtistName, "Various Artists");
});

test("the website's Open in Viboplr opens the subject's page", async () => {
  const { host } = await setup();
  await host.deepLink("viboplr://plugin/community/subject?id=7");
  await flush();
  assert.deepEqual(host.entityOpens.at(-1), ["track", { name: "Jóga", artistName: "Björk" }, { tab: "community_track" }]);
});

test("the header line leads with the likes", async () => {
  const p = loadPlugin();
  const host = makeHost({ route: route() });
  await p.activate(host.api);
  assert.deepEqual(p._countsTitleLine({ cue_sheet: 2, _likes: 5 }).items, [
    { value: "♥ 5", label: "" },
    { value: 2, label: "cue sheets on Community" },
  ]);
  assert.deepEqual(p._countsTitleLine({ _likes: 5 }).items, [{ value: "♥ 5", label: "on Community" }]);
  assert.equal(p._countsTitleLine({}), null);
  // Plays come right after the likes: "♥ 5 · 1,204 plays · 2 cue sheets on Community".
  assert.deepEqual(p._countsTitleLine({ cue_sheet: 2, _likes: 5, _plays: 1204 }).items, [
    { value: "♥ 5", label: "" },
    { value: 1204, label: "plays" },
    { value: 2, label: "cue sheets on Community" },
  ]);
  assert.deepEqual(p._countsTitleLine({ _plays: 1 }).items, [{ value: 1, label: "play on Community" }]);
});

// The host draws a tab from its own cache while that is fresh — across a
// restart or a plugin reload — without asking onFetch, so an action can arrive
// for a tab this plugin never loaded.
test("a tab the host drew from its cache still acts: its buttons load what they need", async () => {
  const { host, log } = await setup({ session: SIGNED_IN });
  await host.actions["tab-like"]({ entity: joga });
  assert.ok(log.some(([m, p]) => m === "PUT" && p === "/v1/subjects/7/like"), "liked");
  assert.equal(nodes(host.sectionData.at(-1).data, "button").find((b) => b.action === "tab-like").label, "♥ Liked · 4");

  const fresh = await setup({ session: SIGNED_IN });
  await fresh.host.actions["tab-comment"]({ entity: joga, query: "hello" });
  assert.ok(fresh.log.some(([m, p]) => m === "POST" && p === "/v1/subjects/7/comments"), "posted, not dropped");

  const page = await setup();
  await page.host.actions["tab-page"]({ entity: joga });
  assert.equal(page.host.opened.at(-1), JOGA.url, "the song's page, not the site's home");
});

test("signing out redraws the open tabs as signed out", async () => {
  const { host } = await setup({ session: SIGNED_IN });
  await tab(host, "track", joga);
  await host.actions["sign-out"]();
  await flush();
  const redraw = host.sectionData.at(-1);
  assert.equal(redraw.typeId, "community_track");
  assert.ok(nodes(redraw.data, "button").some((b) => b.action === "tab-sign-in"), "invites a sign-in");
  assert.equal(nodes(redraw.data, "search-input").length, 0, "no comment box");
});

test("importing lyrics from the tab over the song's own synced lyrics asks first, in the tab", async () => {
  const LYRICS = { id: "lyr1", kind: "synced_lyrics", title: "Jóga", artistName: "Björk", version: 1, publisher: { login: "bob" }, url: "u", payload: { lrc: "[00:01.00]theirs" } };
  const base = route();
  const { host } = await setup({
    session: SIGNED_IN,
    route: (u, init) => (u.pathname === "/v1/items/lyr1" ? { body: { item: LYRICS } } : base(u, init)),
  });
  host.webLyrics.set("track:bjork:joga", { text: "[00:01.00]mine", kind: "synced" });
  await tab(host, "track", joga);
  await host.actions["tab-import-lyrics"]({ entity: joga, itemId: "lyr1" });
  assert.equal(host.lyricsSaves.length, 0, "nothing replaced yet");
  const ask = nodes(host.sectionData.at(-1).data, "confirm")[0];
  assert.ok(ask, "the tab asks");
  assert.equal(ask.confirmAction, "tab-confirm-replace-lyrics");
  assert.match(ask.message, /Community → You/);

  await host.actions[ask.confirmAction]({ ...ask.data, entity: joga });
  assert.equal(host.lyricsSaves.at(-1).lyrics.text, "[00:01.00]theirs");
  assert.equal(nodes(host.sectionData.at(-1).data, "confirm").length, 0, "the question is gone");
});

test("switching the ticks off while they load leaves the bar clear", async () => {
  const track = { key: "q:5", title: "Jóga", artist_name: "Björk" };
  let release;
  const held = new Promise((r) => (release = r));
  const base = route();
  const { host } = await setup({
    current: track,
    route: async (u, init) => {
      if (u.pathname === "/v1/subjects/7/comments") await held;
      return base(u, init);
    },
  });
  const on = host.actions["toggle-ticks"]({ value: true });
  await flush();
  await host.actions["toggle-ticks"]({ value: false });
  release();
  await on;
  await flush();
  assert.deepEqual(host.markers.at(-1), { trackKey: "q:5", markers: [] }, "the late answer drew nothing");
});

test("ticks show for the song already playing when the plugin starts, asked once", async () => {
  const track = { key: "q:5", title: "Jóga", artist_name: "Björk" };
  const { host, log } = await setup({ current: track, ticks: true });
  await flush();
  assert.deepEqual(host.markers.at(-1), { trackKey: "q:5", markers: [{ at: 161, label: "@bob: that bridge" }] });
  host.trackStarted(track);
  await flush();
  assert.equal(log.filter(([, p]) => p.startsWith("/v1/subjects/7/comments")).length, 1, "the start event didn't ask again");
});

test("a timed comment posted on the playing song shows on the bar at once", async () => {
  const track = { key: "q:5", title: "Jóga", artist_name: "Björk" };
  const comments = [];
  const base = route();
  const { host } = await setup({
    session: SIGNED_IN,
    current: track,
    ticks: true,
    route: (u, init = {}) => {
      if (u.pathname === "/v1/subjects/resolve") return { body: { subject: { ...JOGA, comments: comments.length } } };
      if (u.pathname === "/v1/subjects/7/comments") {
        if (init.method === "POST") {
          const b = JSON.parse(init.body);
          const c = { ...COMMENT, id: 20 + comments.length, body: b.body, atSecs: b.atSecs ?? null, author: { login: "alice", avatarUrl: null } };
          comments.push(c);
          return { status: 201, body: { comment: c } };
        }
        return { body: { comments, hasMore: false } };
      }
      return base(u, init);
    },
  });
  await flush();
  assert.deepEqual(host.markers.at(-1), { trackKey: "q:5", markers: [] }, "nothing timed yet");
  host.position = 42;
  await tab(host, "track", joga);
  await host.actions["tab-comment-at"]({ entity: joga });
  await host.actions["tab-comment"]({ entity: joga, query: "the drop" });
  await flush();
  assert.deepEqual(host.markers.at(-1), { trackKey: "q:5", markers: [{ at: 42, label: "@alice: the drop" }] });
});

test("the comment box empties after a post, and keeps the text when the post fails", async () => {
  let fail = false;
  const base = route();
  const { host } = await setup({
    session: SIGNED_IN,
    route: (u, init = {}) => (fail && init.method === "POST" ? { status: 500, body: { error: "down" } } : base(u, init)),
  });
  const box = (tree) => nodes(tree, "search-input")[0];
  const before = box((await tab(host, "track", joga)).value).stateKey;
  await host.actions["tab-comment"]({ entity: joga, query: "first" });
  const after = box(host.sectionData.at(-1).data).stateKey;
  assert.notEqual(after, before, "a new key: the posted text is gone");

  fail = true;
  const redraws = host.sectionData.length;
  await host.actions["tab-comment"]({ entity: joga, query: "second" });
  assert.equal(host.sectionData.length, redraws, "a failed post doesn't redraw the box away");
});

test("only the latest Discover search shows, whichever answers last", async () => {
  const held = {};
  const base = route();
  const { host } = await setup({
    route: async (u, init) => {
      if (u.pathname === "/v1/subjects/search") {
        const q = u.searchParams.get("q");
        await new Promise((r) => (held[q] = r));
        return { body: { subjects: q === "bjork" ? [BJORK] : [JOGA], hasMore: false } };
      }
      return base(u, init);
    },
  });
  const first = host.actions["discover-search"]({ query: "bjork" });
  await flush();
  const second = host.actions["discover-search"]({ query: "joga" });
  await flush();
  held.joga();
  await second;
  held.bjork();
  await first;
  await flush();
  const lists = nodes(host.lastView(), "track-row-list");
  const titles = lists.flatMap((l) => l.items.map((i) => i.title));
  assert.ok(titles.some((t) => /Jóga/.test(t)), "the latest query's results: " + titles);
  assert.ok(!titles.some((t) => t === "Björk"), "not the earlier one's: " + titles);
});

test("servers from before `area` still get the right tabs", () => {
  const p = loadPlugin();
  assert.equal(p._areaOf({ kind: "cue_sheet" }), "music");
  assert.equal(p._areaOf({ kind: "mixtape" }), "mixtapes");
  assert.equal(p._areaOf({ kind: "subsonic_server", membersOnly: true }), "servers");
  assert.equal(p._areaOf({ kind: "eq_preset", area: "presets" }), "presets");
});
