const test = require("node:test");
const assert = require("node:assert/strict");
const nodeCrypto = require("node:crypto");
const { loadPlugin } = require("./harness/sandbox");
const { makeHost } = require("./harness/host");

const ITEM = {
  id: "abc123",
  kind: "cue_sheet",
  title: "Jóga",
  artistName: "Björk",
  albumName: "Homogenic",
  durationSecs: 305,
  author: "Claude",
  mode: "cards",
  cueCount: 2,
  version: 1,
  importCount: 4,
  publisher: { login: "alice", avatarUrl: null },
  url: "https://community.viboplr.com/c/abc123",
};
const SHEET = { cues: [{ at: 0, text: "hi" }, { at: 12, kind: "quote", text: "there" }] };

// Find every node of `type` anywhere in a view tree.
function nodes(tree, type, out = []) {
  if (!tree || typeof tree !== "object") return out;
  if (tree.type === type) out.push(tree);
  for (const c of tree.children || []) nodes(c, type, out);
  return out;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

async function setup(route, opts = {}) {
  const plugin = loadPlugin();
  const host = makeHost({ route, ...opts });
  if (opts.session) host.storage.set("session", opts.session);
  await plugin.activate(host.api);
  return { plugin, host };
}

test("song keys fold case and accents like the app's entity keys", () => {
  const p = loadPlugin();
  assert.equal(p._songKey(" Jóga ", "Björk"), "track:bjork:joga");
  assert.equal(p._songKey("JOGA", "BJORK"), p._songKey("Jóga", "Björk"));
  assert.equal(p._songKey("Untitled", null), "track::untitled");
});

test("base64url matches RFC 4648 and parseLink reads scoped links only", () => {
  const p = loadPlugin();
  assert.equal(p._base64url(Uint8Array.from([0xfb, 0xff])), "-_8");
  assert.equal(p._base64url(Buffer.from("foob")), "Zm9vYg");
  assert.deepEqual(p._parseLink("viboplr://plugin/community/auth?code=x&state=y"), { path: "auth", params: { code: "x", state: "y" } });
  assert.deepEqual(p._parseLink("viboplr://plugin/community/open/?id=1"), { path: "open", params: { id: "1" } });
  assert.equal(p._parseLink("viboplr://plugin/other/auth?code=x"), null);
});

test("an imported sheet's byline keeps its author and names who shared it", () => {
  const p = loadPlugin();
  assert.equal(p._importAuthor(ITEM), "Claude · via @alice");
  assert.equal(p._importAuthor({ ...ITEM, author: null }), "@alice");
  assert.ok(p._importAuthor({ ...ITEM, author: "x".repeat(100) }).length <= 64);
});

test("sign-in: PKCE challenge in the browser link, verifier only in the exchange", async () => {
  const exchanges = [];
  const { host } = await setup((u, init) => {
    if (u.pathname === "/auth/exchange") {
      exchanges.push(JSON.parse(init.body));
      return { body: { token: "vcom_tok", user: { login: "alice" } } };
    }
    if (u.pathname === "/v1/me/items") return { body: { items: [] } };
    if (u.pathname === "/v1/items/search") return { body: { items: [], hasMore: false } };
  });
  await host.actions["sign-in"]();
  const start = new URL(host.opened[0]);
  assert.equal(start.origin + start.pathname, "https://community.viboplr.com/auth/github/start");
  assert.equal(start.searchParams.get("client"), "app");
  assert.equal(start.searchParams.get("code_challenge_method"), "S256");
  const st = start.searchParams.get("state");
  assert.equal(host.lastHeader().status.label, "Signing in…");

  // A link with someone else's state is ignored.
  await host.deepLink("viboplr://plugin/community/auth?code=evil&state=wrong");
  assert.equal(exchanges.length, 0);

  await host.deepLink(`viboplr://plugin/community/auth?code=one-time&state=${st}`);
  await flush();
  assert.equal(exchanges.length, 1);
  const { code, verifier } = exchanges[0];
  assert.equal(code, "one-time");
  const challenge = nodeCrypto.createHash("sha256").update(verifier).digest("base64url");
  assert.equal(challenge, start.searchParams.get("code_challenge"));
  assert.ok(!host.opened[0].includes(verifier), "the verifier never goes to the browser");
  assert.deepEqual(host.storage.get("session"), { token: "vcom_tok", user: { login: "alice" } });
  assert.equal(host.lastHeader().status.label, "@alice");
});

test("a cancelled sign-in clears the waiting state", async () => {
  const { host } = await setup(() => undefined);
  await host.actions["sign-in"]();
  const st = new URL(host.opened[0]).searchParams.get("state");
  await host.deepLink(`viboplr://plugin/community/auth?error=cancelled&state=${st}`);
  assert.equal(host.lastHeader().status.label, "Signed out");
  assert.match(host.lastNotice().message, /cancelled/);
});

test("import installs the sheet through api.cues and remembers where it came from", async () => {
  const counted = [];
  const { plugin, host } = await setup((u) => {
    if (u.pathname === "/v1/items/abc123") return { body: { item: { ...ITEM, payload: SHEET } } };
    if (u.pathname === "/v1/items/abc123/imported") counted.push(1);
    return { status: 204 };
  });
  await host.actions.import({ itemId: "abc123" });
  const row = await host.api.cues.get("Jóga", "Björk");
  assert.deepEqual(row.sheet, SHEET);
  assert.equal(row.author, "Claude · via @alice");
  assert.equal(row.albumName, "Homogenic");
  assert.equal(plugin._state().imports["track:bjork:joga"].id, "abc123");
  await flush();
  assert.equal(counted.length, 1);
  assert.match(host.lastNotice().message, /Imported/);
});

test("import asks before replacing a sheet the user already has", async () => {
  const { host } = await setup((u) => {
    if (u.pathname === "/v1/items/abc123") return { body: { item: { ...ITEM, payload: SHEET } } };
    return { status: 204 };
  });
  await host.addSheet("joga", "bjork", { cues: [{ at: 1, text: "mine" }] });
  await host.actions.import({ itemId: "abc123" });
  const confirm = nodes(host.lastView(), "confirm")[0];
  assert.equal(confirm.confirmAction, "confirm-replace");
  assert.equal((await host.api.cues.get("Jóga", "Björk")).sheet.cues[0].text, "mine", "nothing replaced yet");
  await host.actions["confirm-replace"](confirm.data);
  assert.equal((await host.api.cues.get("Jóga", "Björk")).sheet.cues[0].text, "hi");
});

test("publish sends the local sheet with the bearer token", async () => {
  const posts = [];
  const { host } = await setup(
    (u, init) => {
      if (u.pathname === "/v1/items" && init.method === "POST") {
        posts.push(init);
        return { status: 201, body: { item: { ...ITEM, id: "new1", url: "https://community.viboplr.com/c/new1" }, created: true } };
      }
      if (u.pathname === "/v1/items/search") return { body: { items: [], hasMore: false } };
    },
    { session: { token: "vcom_tok", user: { login: "alice" } } }
  );
  await host.addSheet("Jóga", "Björk", SHEET, { author: "Claude", durationSecs: 305 });
  await host.menu["publish-cues"]({ kind: "track", title: "Jóga", artistName: "Björk" });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].headers.Authorization, "Bearer vcom_tok");
  const body = JSON.parse(posts[0].body);
  assert.equal(body.kind, "cue_sheet");
  assert.deepEqual(body.sheet, SHEET);
  assert.equal(body.durationSecs, 305);
  assert.equal(host.lastNotice().options.action.id, "open-last-published");
});

test("publishing needs a sign-in and refuses an untouched import", async () => {
  const { host } = await setup((u) => {
    if (u.pathname === "/v1/items/abc123") return { body: { item: { ...ITEM, payload: SHEET } } };
    return { status: 204 };
  });
  await host.menu["publish-cues"]({ kind: "track", title: "Jóga", artistName: "Björk" });
  assert.equal(host.lastNotice().options.action.id, "sign-in");

  const { host: signedIn } = await setup(
    (u) => {
      if (u.pathname === "/v1/items/abc123") return { body: { item: { ...ITEM, payload: SHEET } } };
      return { status: 204 };
    },
    { session: { token: "vcom_tok", user: { login: "bob" } } }
  );
  await signedIn.actions.import({ itemId: "abc123" });
  const before = signedIn.requests.length;
  await signedIn.menu["publish-cues"]({ kind: "track", title: "Jóga", artistName: "Björk" });
  assert.equal(signedIn.requests.length, before, "no request sent");
  assert.match(signedIn.lastNotice().message, /isn't yours/);
});

test("a 401 signs the plugin out instead of failing silently", async () => {
  const { host } = await setup(
    (u) => {
      if (u.pathname === "/v1/items") return { status: 401, body: { error: "sign in required" } };
    },
    { session: { token: "vcom_revoked", user: { login: "alice" } } }
  );
  await host.addSheet("Song", "Band", SHEET);
  await host.menu["publish-cues"]({ kind: "track", title: "Song", artistName: "Band" });
  assert.equal(host.storage.get("session"), null);
  assert.equal(host.lastHeader().status.label, "Signed out");
  assert.match(host.lastNotice().message, /sign in again/i);
});

test("an unreachable server is a banner in the view, not a toast", async () => {
  const { host } = await setup(() => {
    throw new Error("connection refused");
  });
  await host.actions.search({ query: "bjork" });
  const banners = nodes(host.lastView(), "layout").filter((n) => /ds-banner/.test(n.className || ""));
  assert.equal(banners.length, 1);
  assert.match(banners[0].children[0].content, /connection refused/);
  assert.equal(host.notices.length, 0);
});

test("a proxy's web page instead of JSON is named as such, and requests identify themselves", async () => {
  // Seen live behind Zscaler: HTTP 200 carrying its "Browser Isolation" page.
  const { host } = await setup(() => ({ status: 200, body: undefined }));
  host.api.network.fetch = async (url, init = {}) => {
    host.requests.push({ url, init });
    return { status: 200, headers: {}, text: async () => "<!doctype html><title>Browser Isolation</title>" };
  };
  await host.actions.search({ query: "x" });
  const banners = nodes(host.lastView(), "layout").filter((n) => /ds-banner/.test(n.className || ""));
  assert.match(banners[0].children[0].content, /proxy or filter on your network/);
  assert.match(host.requests[0].init.headers["User-Agent"], /^Viboplr-Community-Plugin\//);
  assert.ok(host.logs.some((l) => l.level === "warn" && /Browser Isolation/.test(l.message)));
});

test("Mine marks published, imported and own sheets differently", async () => {
  const p = loadPlugin();
  const sheet = { title: "Song", artistName: "Band", sheet: SHEET, updatedAt: 5, author: "Claude" };
  assert.deepEqual(p._localRow(sheet, null, null).actions, ["publish"]);
  assert.equal(p._localRow(sheet, { id: "x" }, null).badge.label, "Published");
  assert.deepEqual(p._localRow(sheet, null, { id: "x", updatedAt: 5 }).actions, []);
  assert.deepEqual(p._localRow(sheet, null, { id: "x", updatedAt: 4 }).actions, ["publish"], "changed since import");
});

test("a cue sheet row says when an imported sheet has an update", async () => {
  const { plugin } = await setup(() => undefined);
  plugin._state().imports["track:bjork:joga"] = { id: "abc123", version: 1, updatedAt: 1 };
  const cue = plugin._builtinModules[0];
  const row = plugin._cardRow(cue, { ...ITEM, version: 2 });
  assert.equal(row.badge.label, "Update");
  assert.deepEqual(row.actions, ["update", "page"]);
  assert.equal(plugin._cardRow(cue, { ...ITEM, id: "other" }).badge, undefined);
});

test("a share link opens the song and asks to import", async () => {
  const { host } = await setup((u) => {
    if (u.pathname === "/v1/items/abc123") return { body: { item: { ...ITEM, payload: SHEET } } };
    if (u.pathname === "/v1/items") return { body: { items: [ITEM] } };
  });
  await host.deepLink("viboplr://plugin/community/open?id=abc123");
  await flush();
  assert.deepEqual(host.navigated, ["community"]);
  const view = host.lastView();
  assert.equal(nodes(view, "tabs")[0].activeTab, "cue_sheet");
  assert.equal(nodes(view, "select").find((n) => n.action === "cue-scope").value, "song");
  assert.equal(nodes(view, "confirm")[0].confirmAction, "confirm-import");
});

const SERVER_ITEM = {
  id: "srv1",
  kind: "subsonic_server",
  title: "Jazz box",
  address: "https://music.example.com",
  username: "guest",
  password: "g&t",
  host: "music.example.com",
  tags: ["jazz", "flac"],
  importCount: 2,
  publisher: { login: "alice" },
  url: "https://community.viboplr.com/servers/srv1",
  card: {
    title: "Jazz box",
    facts: ["music.example.com", "jazz, flac"],
    action: { label: "Add to Viboplr", link: "viboplr://add-collection?kind=subsonic&name=Jazz+box" },
  },
};

test("the Servers tab lists servers and Add opens the app's own dialog with the login", async () => {
  const counted = [];
  const { host } = await setup((u) => {
    if (u.pathname === "/v1/items/search" && u.searchParams.get("kind") === "subsonic_server") {
      return { body: { items: [SERVER_ITEM], hasMore: false } };
    }
    if (u.pathname === "/v1/items/srv1/imported") counted.push(1);
    return { status: 204 };
  });
  await host.actions.tab({ tabId: "subsonic_server" });
  const list = nodes(host.lastView(), "track-row-list")[0];
  assert.equal(list.items[0].title, "Jazz box");
  assert.equal(list.items[0].subtitle, "music.example.com · jazz, flac · @alice · 2 adds");
  assert.deepEqual(list.items[0].actions, ["add-server", "page"]);

  await host.actions["add-server"]({ itemId: "srv1" });
  await flush();
  assert.deepEqual(host.addRequests, [
    { kind: "subsonic", name: "Jazz box", url: "https://music.example.com", username: "guest", password: "g&t" },
  ]);
  assert.equal(counted.length, 1);
});

test("on an app without requestAdd, Add opens the server's page instead", async () => {
  const { host } = await setup(() => ({ status: 204 }));
  delete host.api.collections.requestAdd;
  await host.actions["add-server"]({ itemId: "srv1" });
  assert.deepEqual(host.opened, ["https://community.viboplr.com/servers/srv1"]);
  assert.equal(host.addRequests.length, 0);
});

test("tabs are one per module plus Mine, which has a section per module", async () => {
  const { host } = await setup(
    (u) => {
      if (u.pathname === "/v1/me/items") {
        return { body: { items: [{ ...ITEM, kind: "cue_sheet" }, SERVER_ITEM] } };
      }
      if (u.pathname === "/v1/items/search") return { body: { items: [], hasMore: false } };
    },
    { session: { token: "vcom_tok", user: { login: "alice" } } }
  );
  await host.addSheet("Jóga", "Björk", SHEET);
  assert.deepEqual(nodes(host.lastView(), "tabs")[0].tabs.map((t) => t.id), ["cue_sheet", "synced_lyrics", "mixtape", "subsonic_server", "mine"]);

  await host.actions.tab({ tabId: "mine" });
  const sections = nodes(host.lastView(), "section");
  // Cue sheets and mixtapes bring their own sections (what's on this computer); servers use the generic one.
  assert.deepEqual(sections.map((n) => n.title), ["Cue sheets on this computer", "Synced lyrics", "Your playlists", "Your servers"]);
  const [sheets, , , servers] = sections.map((n) => nodes({ children: n.children }, "track-row-list")[0]);
  assert.equal(sheets.items[0].badge.label, "Published", "matched against your cue sheets online");
  assert.equal(servers.items[0].title, "Jazz box");
  assert.deepEqual(servers.items[0].actions, ["page", "edit"]);

  await host.actions.edit({ itemId: "srv1" });
  assert.equal(host.opened.at(-1), "https://community.viboplr.com/servers/srv1/edit");
  await host.actions.share({ kind: "subsonic_server" });
  assert.equal(host.opened.at(-1), "https://community.viboplr.com/servers/new");
});

test("a module the plugin has never heard of still gets a working tab and Mine section", async () => {
  const PRESET = {
    id: "eq1",
    kind: "eq_preset",
    title: "HD 600",
    importCount: 1,
    publisher: { login: "bob" },
    url: "https://community.viboplr.com/eq-presets/eq1",
    card: { title: "HD 600", facts: ["10 bands"], action: { label: "Use in Viboplr", link: "viboplr://x" } },
  };
  const { plugin, host } = await setup(
    (u) => {
      if (u.pathname === "/v1/modules") {
        return {
          body: {
            modules: [
              ...plugin_modules(),
              {
                kind: "eq_preset", slug: "eq-presets", name: "EQ presets", singular: "EQ preset", intro: "",
                notice: "Shared EQ presets.", popularLabel: "Most used", useNoun: ["use", "uses"],
                url: "https://community.viboplr.com/eq-presets", shareUrl: null,
              },
            ],
          },
        };
      }
      if (u.pathname === "/v1/items/search" && u.searchParams.get("kind") === "eq_preset") return { body: { items: [PRESET], hasMore: false } };
      if (u.pathname === "/v1/me/items") return { body: { items: [PRESET] } };
      if (u.pathname === "/v1/items/search") return { body: { items: [], hasMore: false } };
    },
    { session: { token: "vcom_tok", user: { login: "bob" } } }
  );
  await plugin._loadModules();
  assert.deepEqual(nodes(host.lastView(), "tabs")[0].tabs.map((t) => t.label), ["Cue sheets", "Synced lyrics", "Mixtapes", "Servers", "EQ presets", "Mine"]);
  assert.ok(host.storage.get("modules").some((m) => m.kind === "eq_preset"), "remembered for the next start");

  await host.actions.tab({ tabId: "eq_preset" });
  const view = host.lastView();
  assert.ok(nodes(view, "text").some((n) => n.content === "Shared EQ presets."), "the module's notice");
  const row = nodes(view, "track-row-list")[0];
  assert.deepEqual(row.actions, [{ id: "page", label: "Open page", icon: "↗" }]);
  assert.deepEqual(row.items[0], { id: "eq1", title: "HD 600", subtitle: "10 bands · @bob · 1 use", actions: ["page"] });
  await host.actions.page({ itemId: "eq1" });
  assert.equal(host.opened.at(-1), "https://community.viboplr.com/eq-presets/eq1");

  await host.actions.tab({ tabId: "mine" });
  const titles = nodes(host.lastView(), "section").map((n) => n.title);
  assert.deepEqual(titles, ["Cue sheets on this computer", "Synced lyrics", "Your playlists", "Your servers", "Your eq presets"]);
});

// The built-in module descriptions as the server would send them.
function plugin_modules() {
  return loadPlugin()._builtinModules;
}

test("a bad module list from the server is ignored, not fatal", async () => {
  const { plugin, host } = await setup((u) => {
    if (u.pathname === "/v1/modules") return { body: { modules: [{ kind: 3 }, null, { name: "no kind" }] } };
  });
  await plugin._loadModules();
  assert.deepEqual(nodes(host.lastView(), "tabs")[0].tabs.map((t) => t.id), ["cue_sheet", "synced_lyrics", "mixtape", "subsonic_server", "mine"]);
});

// ---- mixtapes ---------------------------------------------------------------

const MIX = {
  id: "mx1",
  kind: "mixtape",
  title: "Late night",
  trackCount: 2,
  artists: ["Miles Davis"],
  version: 1,
  importCount: 0,
  publisher: { login: "bob" },
  url: "https://community.viboplr.com/mixtapes/mx1",
  card: { title: "Late night", facts: ["2 tracks", "15 min", "Miles Davis"], action: { label: "Open in Viboplr", link: "viboplr://x" } },
};
const MIX_TRACKS = [
  { title: "So What", artistName: "Miles Davis", albumName: "Kind of Blue", durationSecs: 562 },
  { title: "Blue in Green", artistName: "Miles Davis", albumName: null, durationSecs: 337 },
];

// A community holding MIX at `at.version`, recording what's published to it.
function mixRoute(posted, at = { version: 1 }) {
  return (u, init) => {
    const mix = { ...MIX, version: at.version };
    if (u.pathname === "/v1/items/mx1") return { body: { item: { ...mix, payload: { description: "Slow ones.", tracks: MIX_TRACKS } } } };
    if (u.pathname === "/v1/items/search") return { body: { items: u.searchParams.get("kind") === "mixtape" ? [mix] : [], hasMore: false } };
    const published = (body, i) => ({ ...MIX, id: "mine" + i, title: body.title, publisher: { login: "alice" }, url: "https://community.viboplr.com/mixtapes/mine" + i });
    if (u.pathname === "/v1/me/items") return { body: { items: posted.map(published) } };
    if (u.pathname === "/v1/items" && init.method === "POST") {
      const body = JSON.parse(init.body);
      posted.push(body);
      return { status: 201, body: { created: true, item: published(body, posted.length - 1) } };
    }
    if (u.pathname.endsWith("/imported")) return { status: 204 };
  };
}

test("a mixtape's tracks are metadata only, whatever shape they come in", () => {
  const p = loadPlugin();
  assert.deepEqual(
    p._mixtapeTracks([
      { title: " So What ", artistName: "Miles Davis", albumName: "Kind of Blue", durationSecs: 562, source: "file:///Users/me/Music/a.flac", imagePath: "/x" },
      { title: "Naima", artist_name: "John Coltrane", album_title: "Giant Steps", duration_secs: 261, path: "spotify:track:1", key: "q:3" },
      { title: "", artistName: "nobody" },
      null,
    ]),
    [
      { title: "So What", artistName: "Miles Davis", albumName: "Kind of Blue", durationSecs: 562 },
      { title: "Naima", artistName: "John Coltrane", albumName: "Giant Steps", durationSecs: 261 },
    ]
  );
});

test("publishing a playlist sends its track list and never a file path", async () => {
  const posted = [];
  const { host } = await setup(mixRoute(posted), { session: { token: "vcom_tok", user: { login: "alice" } } });
  const id = await host.addPlaylist(
    "Sunday",
    [{ title: "So What", artistName: "Miles Davis", durationSecs: 562, source: "file:///Users/alice/Music/so-what.flac" }],
    { description: "Coffee." }
  );
  await host.menu["publish-mixtape"]({ kind: "playlist", playlistId: id, playlistName: "Sunday" });
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0], {
    kind: "mixtape",
    title: "Sunday",
    description: "Coffee.",
    tracks: [{ title: "So What", artistName: "Miles Davis", albumName: null, durationSecs: 562 }],
  });
  assert.ok(!JSON.stringify(posted).includes("file://"));
  assert.match(host.lastNotice().message, /Published “Sunday”/);

  // Mine now shows it as published, with the online actions.
  await host.actions.tab({ tabId: "mine" });
  const section = nodes(host.lastView(), "section").find((s) => s.title === "Your playlists");
  const row = nodes({ children: section.children }, "track-row-list")[0].items[0];
  assert.equal(row.badge.label, "Published");
  assert.deepEqual(row.actions, ["republish-playlist", "unpublish-mixtape", "mixtape-page"]);
});

test("publishing needs a sign-in, and the queue publishes under the name you give it", async () => {
  const posted = [];
  const queue = [{ key: "q:1", path: "file:///Users/me/a.mp3", title: "Naima", artist_name: "John Coltrane", album_title: null, duration_secs: 261 }];
  const signedOut = await setup(mixRoute(posted), { queue });
  await signedOut.host.actions["publish-queue"]({ query: "Tonight" });
  assert.equal(posted.length, 0);
  assert.match(signedOut.host.lastNotice().message, /Sign in/);

  const { host } = await setup(mixRoute(posted), { queue, session: { token: "vcom_tok", user: { login: "alice" } } });
  await host.actions["publish-queue"]({ query: "  " });
  assert.equal(posted.length, 0, "a name is required");
  await host.actions["publish-queue"]({ query: "Tonight" });
  assert.equal(posted[0].title, "Tonight");
  assert.deepEqual(posted[0].tracks, [{ title: "Naima", artistName: "John Coltrane", albumName: null, durationSecs: 261 }]);
});

test("Play plays the mixtape as metadata-only entries with a playlist banner", async () => {
  const { host } = await setup(mixRoute([]));
  await host.actions["play-mixtape"]({ itemId: "mx1" });
  assert.equal(host.plays.length, 1);
  const play = host.plays[0];
  assert.equal(play.startIndex, 0);
  assert.deepEqual(play.context, { name: "Late night", source: "playlist", description: "Slow ones." });
  assert.deepEqual(play.tracks[0], { title: "So What", artist_name: "Miles Davis", album_title: "Kind of Blue", duration_secs: 562 });
  await flush();
  assert.ok(host.requests.some((r) => r.url.endsWith("/v1/items/mx1/imported")), "a play counts");
});

test("Save remembers where the mixtape came from, and a newer version replaces the saved copy", async () => {
  const at = { version: 1 };
  const { host } = await setup(mixRoute([], at));
  await host.actions.tab({ tabId: "mixtape" });
  let row = nodes(host.lastView(), "track-row-list")[0].items[0];
  assert.deepEqual(row.actions, ["play-mixtape", "save-mixtape", "page"]);
  assert.equal(row.artistName, "Miles Davis", "art from the main artist");

  await host.actions["save-mixtape"]({ itemId: "mx1" });
  const [saved] = host.playlists.values();
  assert.equal(saved.name, "Late night");
  assert.equal(saved.description, "Slow ones.");
  assert.deepEqual(saved.metadata, { communityId: "mx1", communityVersion: 1, communityBy: "bob" });
  assert.equal(saved.tracks.length, 2);
  assert.equal(saved.source, undefined, "plays as an ordinary playlist");
  row = nodes(host.lastView(), "track-row-list")[0].items[0];
  assert.equal(row.badge.label, "Saved");

  await host.actions["save-mixtape"]({ itemId: "mx1" });
  assert.equal(host.playlists.size, 1);
  assert.match(host.lastNotice().message, /already in your Playlists/);

  // bob republishes: coming back to the tab refetches, the row offers an
  // update, and the update swaps the saved copy.
  at.version = 2;
  await host.actions.tab({ tabId: "mine" });
  await host.actions.tab({ tabId: "mixtape" });
  row = nodes(host.lastView(), "track-row-list")[0].items[0];
  assert.equal(row.badge.label, "Update");
  await host.actions["update-mixtape"]({ itemId: "mx1" });
  const copies = [...host.playlists.values()];
  assert.equal(copies.length, 1);
  assert.equal(copies[0].metadata.communityVersion, 2);
  assert.match(host.lastNotice().message, /Updated “Late night”/);
});

test("Mine offers your own playlists, never Liked/Disliked or the app's mixes", async () => {
  const posted = [];
  const { host } = await setup(mixRoute(posted), { session: { token: "vcom_tok", user: { login: "alice" } } });
  await host.addPlaylist("Sunday", MIX_TRACKS);
  await host.addPlaylist("Liked Tracks", MIX_TRACKS);
  await host.addPlaylist("Disliked Tracks", MIX_TRACKS);
  await host.addPlaylist("Kyuss Mix", MIX_TRACKS, { metadata: { recipe: "daily-mix", first_artist: "Kyuss" } });
  await host.addPlaylist("Nothing yet", []);
  // Even one already published stays out: it's still not the user's own list.
  posted.push({ title: "Kyuss Mix" });
  await host.actions.tab({ tabId: "mine" });
  const section = nodes(host.lastView(), "section").find((s) => s.title === "Your playlists");
  const rows = nodes({ children: section.children }, "track-row-list")[0].items;
  assert.deepEqual(rows.map((r) => r.title), ["Sunday"]);
});

test("a saved community mixtape isn't yours to publish", async () => {
  const posted = [];
  const { host } = await setup(mixRoute(posted), { session: { token: "vcom_tok", user: { login: "alice" } } });
  const id = await host.addPlaylist("Late night", MIX_TRACKS, { metadata: { communityId: "mx1", communityVersion: 1, communityBy: "bob" } });
  await host.actions.tab({ tabId: "mine" });
  const section = nodes(host.lastView(), "section").find((s) => s.title === "Your playlists");
  const row = nodes({ children: section.children }, "track-row-list")[0].items[0];
  assert.equal(row.badge.label, "From the community");
  assert.deepEqual(row.actions, []);
  assert.equal(row.subtitle, "2 tracks · by @bob");
  await host.menu["publish-mixtape"]({ kind: "playlist", playlistId: id, playlistName: "Late night" });
  assert.equal(posted.length, 0);
  assert.match(host.lastNotice().message, /isn't yours to publish/);
});

test("a mixtape share link opens the Mixtapes tab and asks to save", async () => {
  const { host } = await setup(mixRoute([]));
  await host.deepLink("viboplr://plugin/community/open?id=mx1");
  for (let i = 0; i < 10; i++) await flush();
  assert.deepEqual(host.navigated, ["community"]);
  const view = host.lastView();
  assert.equal(nodes(view, "tabs")[0].activeTab, "mixtape");
  const confirm = nodes(view, "confirm")[0];
  assert.equal(confirm.confirmAction, "confirm-save-mixtape");
  assert.match(confirm.message, /@bob's mixtape “Late night” \(2 tracks\)/);
  await host.actions["confirm-save-mixtape"](confirm.data);
  assert.equal(host.playlists.size, 1);
});

// ---- synced lyrics ------------------------------------------------------------

const LRC = "[00:01.00]One\n[00:02.00]Two\n[00:03.00]Three\n";
const LYRICS_ITEM = {
  id: "ly1",
  kind: "synced_lyrics",
  title: "Jóga",
  artistName: "Björk",
  albumName: "Homogenic",
  lineCount: 3,
  version: 1,
  importCount: 0,
  publisher: { login: "bob" },
  url: "https://community.viboplr.com/lyrics/ly1",
  card: { title: "Björk — Jóga", facts: ["3 lines"], action: { label: "Open in Viboplr", link: "viboplr://x" } },
};

function lyricsRoute(posted, at = { version: 1 }) {
  return (u, init) => {
    const item = { ...LYRICS_ITEM, version: at.version };
    if (u.pathname === "/v1/items/ly1") return { body: { item: { ...item, payload: { lrc: LRC.replace("Three", "Three v" + at.version) } } } };
    if (u.pathname === "/v1/items/search") return { body: { items: u.searchParams.get("kind") === "synced_lyrics" ? [item] : [], hasMore: false } };
    if (u.pathname === "/v1/me/items") return { body: { items: [] } };
    if (u.pathname === "/v1/items" && init.method === "POST") {
      const body = JSON.parse(init.body);
      posted.push(body);
      return { status: 201, body: { created: true, item: { ...item, id: "mine1", publisher: { login: "alice" }, url: "https://community.viboplr.com/lyrics/mine1" } } };
    }
    if (u.pathname.endsWith("/imported")) return { status: 204 };
  };
}

const JOGA_KEY = "track:bjork:joga";

test("the plugin is not a lyrics provider", async () => {
  const p = loadPlugin();
  const manifest = JSON.parse(require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "manifest.json"), "utf8"));
  assert.equal(manifest.contributes.informationTypes, undefined);
  assert.ok(manifest.permissions.includes("lyrics:write"));
  assert.equal(p._provideLyrics, undefined);
});

test("Import makes the shared lyrics the song's lyrics through api.lyrics.save", async () => {
  const { host } = await setup(lyricsRoute([]));
  host.webLyrics.set(JOGA_KEY, { text: "plain words", kind: "plain" });
  await host.actions["import-lyrics"]({ itemId: "ly1" });
  assert.deepEqual(host.lyricsSaves.map((s) => s.track), [{ title: "Jóga", artistName: "Björk", albumTitle: "Homogenic" }]);
  assert.equal(host.lyricsSaves[0].lyrics.kind, "synced");
  assert.match(host.lyricsCache.get(JOGA_KEY).text, /Three v1/);
  assert.match(host.lastNotice().message, /scroll along in Now Playing/);
  await flush();
  assert.ok(host.requests.some((r) => r.url.endsWith("/v1/items/ly1/imported")), "an import counts");

  await host.actions.tab({ tabId: "synced_lyrics" });
  const row = nodes(host.lastView(), "track-row-list")[0].items[0];
  assert.equal(row.badge.label, "Imported");
});

test("Import says which Viboplr it needs when the host can't save lyrics", async () => {
  const { host } = await setup(lyricsRoute([]));
  delete host.api.lyrics;
  await host.actions["import-lyrics"]({ itemId: "ly1" });
  assert.match(host.lastNotice().message, /1\.0\.94/);
  assert.equal(host.lyricsCache.size, 0);
});

test("Import asks first when the song already has synced lyrics, and says where from", async () => {
  const { host } = await setup(lyricsRoute([]));
  host.webLyrics.set(JOGA_KEY, { text: "[00:01.00]theirs", kind: "synced", _meta: { providerName: "LRCLIB" } });
  await host.actions["import-lyrics"]({ itemId: "ly1" });
  const confirm = nodes(host.lastView(), "confirm")[0];
  assert.equal(confirm.confirmAction, "confirm-replace-lyrics");
  assert.match(confirm.message, /from LRCLIB/);
  assert.equal(host.lyricsSaves.length, 0, "nothing changed yet");
  await host.actions["confirm-replace-lyrics"](confirm.data);
  assert.match(host.lyricsCache.get(JOGA_KEY).text, /Three v1/);
});

test("Undo hands the song back to the user's providers", async () => {
  const { host } = await setup(lyricsRoute([]));
  await host.actions["import-lyrics"]({ itemId: "ly1" });
  host.webLyrics.set(JOGA_KEY, { text: "plain words", kind: "plain" });
  await host.actions.tab({ tabId: "mine" });
  const section = nodes(host.lastView(), "section").find((s) => s.title === "Synced lyrics");
  const row = nodes({ children: section.children }, "track-row-list")[0].items[0];
  assert.equal(row.badge.label, "Imported");
  await host.actions["remove-lyrics"]({ itemId: row.id });
  assert.equal(host.infoFetches.at(-1).opts.force, true, "re-walks the chain");
  assert.equal(host.lyricsCache.get(JOGA_KEY).text, "plain words");
  await host.actions.tab({ tabId: "synced_lyrics" });
  assert.deepEqual(nodes(host.lastView(), "track-row-list")[0].items[0].actions, ["import-lyrics", "page"], "importable again");
});

test("a newer version offers Update, and Update saves the new text without asking", async () => {
  const at = { version: 1 };
  const { host } = await setup(lyricsRoute([], at));
  await host.actions["import-lyrics"]({ itemId: "ly1" });
  at.version = 2;
  await host.actions.tab({ tabId: "mine" });
  await host.actions.tab({ tabId: "synced_lyrics" });
  const row = nodes(host.lastView(), "track-row-list")[0].items[0];
  assert.equal(row.badge.label, "Update");
  await host.actions["update-lyrics"]({ itemId: "ly1" });
  assert.equal(nodes(host.lastView(), "confirm").length, 0);
  assert.match(host.lyricsCache.get(JOGA_KEY).text, /Three v2/);
});

test("publishing shares any synced lyrics the app has, from any source", async () => {
  const posted = [];
  const { host } = await setup(lyricsRoute(posted), {
    session: { token: "vcom_tok", user: { login: "alice" } },
    current: { title: "Jóga", artist_name: "Björk", duration_secs: 305 },
  });
  const publish = () => host.menu["publish-lyrics"]({ kind: "track", title: "Jóga", artistName: "Björk", albumTitle: "Homogenic" });

  await publish();
  assert.match(host.lastNotice().message, /no lyrics/);

  host.webLyrics.set(JOGA_KEY, { text: "plain words", kind: "plain" });
  await publish();
  assert.match(host.lastNotice().message, /only has plain lyrics/);
  assert.equal(posted.length, 0);

  for (const value of [
    { text: LRC, kind: "synced", _meta: { providerName: "LRCLIB" } },
    { text: LRC, kind: "synced", local: true, _meta: { providerName: "Local file" } },
    { text: LRC, kind: "synced" },
  ]) {
    host.lyricsCache.set(JOGA_KEY, value);
    await publish();
  }
  assert.equal(posted.length, 3);
  assert.deepEqual(posted[0], { kind: "synced_lyrics", title: "Jóga", artistName: "Björk", albumName: "Homogenic", lrc: LRC, durationSecs: 305 });
});

test("Find shared synced lyrics searches the tab for that song; a share link asks to import", async () => {
  const { host } = await setup(lyricsRoute([]));
  await host.menu["find-lyrics"]({ kind: "track", title: "Jóga", artistName: "Björk" });
  const search = host.requests.filter((r) => r.url.includes("/v1/items/search")).at(-1);
  assert.equal(new URL(search.url).searchParams.get("q"), "Björk Jóga");
  assert.equal(nodes(host.lastView(), "tabs")[0].activeTab, "synced_lyrics");

  await host.deepLink("viboplr://plugin/community/open?id=ly1");
  for (let i = 0; i < 10; i++) await flush();
  const confirm = nodes(host.lastView(), "confirm")[0];
  assert.equal(confirm.confirmAction, "confirm-import-lyrics");
  assert.match(confirm.message, /@bob's synced lyrics for “Jóga” by Björk/);
});
