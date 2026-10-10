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
  await plugin.activate(host.api);
  return { plugin, host, log };
}

const tab = (host, kind, entity) => host.infoProviders["community_" + kind]({ id: 0, ...entity });
const joga = { kind: "track", name: "Jóga", artistName: "Björk" };

test("Discover searches songs, albums and artists and opens them on their Community tab", async () => {
  const { host } = await setup();
  await host.actions["discover-search"]({ query: "bjork" });
  const view = host.lastView();
  assert.deepEqual(nodes(view, "tabs")[0].tabs.map((t) => t.label), ["Discover", "Mixtapes", "Subsonic servers", "You"]);
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
  await host.actions.tab({ tabId: "you" });
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
