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

test("My sheets marks published, imported and own sheets differently", async () => {
  const p = loadPlugin();
  const sheet = { title: "Song", artistName: "Band", sheet: SHEET, updatedAt: 5, author: "Claude" };
  assert.deepEqual(p._localRow(sheet, null, null).actions, ["publish"]);
  assert.equal(p._localRow(sheet, { id: "x" }, null).badge.label, "Published");
  assert.deepEqual(p._localRow(sheet, null, { id: "x", updatedAt: 5 }).actions, []);
  assert.deepEqual(p._localRow(sheet, null, { id: "x", updatedAt: 4 }).actions, ["publish"], "changed since import");
  assert.equal(p._itemRow({ ...ITEM, version: 2 }, { id: "abc123", version: 1 }).badge.label, "Update");
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
  assert.equal(nodes(view, "tabs")[0].activeTab, "song");
  assert.equal(nodes(view, "confirm")[0].confirmAction, "confirm-import");
});
