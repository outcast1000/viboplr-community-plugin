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

// The settings panel's Account section, as the user reads it: "Signed out",
// "Signing in…" (a sign-in on its way) or the signed-in login ("@alice").
function accountState(host) {
  const section = nodes(host.lastView(), "section").find((s) => s.title === "Account");
  const rows = nodes({ children: section.children }, "settings-row");
  if (rows.some((r) => r.label === "Signed out")) return "Signed out";
  const me = rows.find((r) => /^Signed in as /.test(r.label));
  return me ? me.label.replace("Signed in as ", "") : "Signing in…";
}

// A share link's notice, if it asked (null otherwise).
const asked = (host, id) => host.notices.filter((n) => n.options && n.options.action && n.options.action.id === id).at(-1) || null;

// The website's "Open in Vibo" for item `id`, answered with the notice's button.
async function openAndAnswer(host, id) {
  await host.deepLink("viboplr://plugin/community/open?id=" + id);
  for (let i = 0; i < 10; i++) await flush();
  assert.ok(asked(host, "answer-open"), "the link asks in a notice");
  await host.actions["answer-open"]();
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

test("signed out, the settings panel offers the browser sign-in first and a code second", async () => {
  const { host } = await setup(() => undefined);
  assert.equal(accountState(host), "Signed out");
  const section = nodes(host.lastView(), "section").find((s) => s.title === "Account");
  const buttons = nodes({ children: section.children }, "button");
  assert.deepEqual(
    buttons.map((b) => [b.action, b.variant]),
    [["sign-in", "accent"], ["sign-in-code", "secondary"], ["open-site", "secondary"]]
  );
  assert.equal(buttons[1].label, "Sign in with a code");
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
  assert.equal(accountState(host), "Signing in…");
  // While it waits, the code sign-in is one click away.
  assert.ok(nodes(host.lastView(), "button").some((b) => b.action === "sign-in-code" && b.label === "Use a code instead"));

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
  assert.equal(accountState(host), "@alice");
});

test("a cancelled sign-in clears the waiting state", async () => {
  const { host } = await setup(() => undefined);
  await host.actions["sign-in"]();
  const st = new URL(host.opened[0]).searchParams.get("state");
  await host.deepLink(`viboplr://plugin/community/auth?error=cancelled&state=${st}`);
  assert.equal(accountState(host), "Signed out");
  assert.match(host.lastNotice().message, /cancelled/);
});

const DEVICE = {
  deviceCode: "device-secret",
  userCode: "BCDF-GHJK",
  verificationUri: "https://community.viboplr.com/device",
  verificationUriComplete: "https://community.viboplr.com/device?code=BCDF-GHJK",
  expiresIn: 600,
  // Poll at once, so the test doesn't wait out the real five seconds.
  interval: 0,
};

// Wait for the plugin's timers and requests to settle into `cond`.
async function until(cond) {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 1));
  return cond();
}

// A server whose device sign-in answers `answers` in turn, then the last forever.
function deviceRoute(answers, polls, extra) {
  return (u, init) => {
    if (u.pathname === "/auth/device") return { body: DEVICE };
    if (u.pathname === "/auth/device/token") {
      polls.push(JSON.parse(init.body));
      return answers[Math.min(polls.length, answers.length) - 1];
    }
    if (u.pathname === "/v1/me/items") return { body: { items: [] } };
    if (u.pathname === "/v1/items/search") return { body: { items: [], hasMore: false } };
    return extra ? extra(u, init) : undefined;
  };
}
const PENDING = { status: 400, body: { error: "authorization_pending" } };

test("sign-in: the browser confirms a code, the plugin polls until it's a session", async () => {
  const polls = [];
  const token = { body: { token: "vcom_tok", user: { login: "alice" } } };
  const { host } = await setup(deviceRoute([PENDING, PENDING, token], polls));
  await host.actions["sign-in-code"]();
  assert.deepEqual(host.opened, [DEVICE.verificationUriComplete]);
  assert.equal(accountState(host), "Signing in…");
  // The code is on screen too, for a browser that didn't open.
  const banner = nodes(host.lastView(), "text").find((n) => n.content.includes("BCDF-GHJK"));
  assert.match(banner.content, /community\.viboplr\.com\/device/);
  assert.ok(nodes(host.lastView(), "button").some((b) => b.action === "open-sign-in-page"));

  assert.ok(await until(() => host.storage.get("session")), "signed in");
  assert.equal(polls.length, 3);
  assert.ok(polls.every((p) => p.deviceCode === "device-secret"));
  assert.ok(!host.opened.some((u) => u.includes("device-secret")), "the device code never goes to the browser");
  assert.deepEqual(host.storage.get("session"), { token: "vcom_tok", user: { login: "alice" } });
  assert.equal(accountState(host), "@alice");
  assert.match(host.lastNotice().message, /Signed in .* as @alice/);
  await until(() => false);
  assert.equal(polls.length, 3, "no polling once signed in");
});

test("asking for a code again while waiting reopens the page instead of starting over", async () => {
  const polls = [];
  const { host } = await setup(deviceRoute([PENDING], polls));
  await host.actions["sign-in-code"]();
  await host.actions["sign-in-code"]();
  assert.equal(host.requests.filter((r) => new URL(r.url).pathname === "/auth/device").length, 1);
  assert.deepEqual(host.opened, [DEVICE.verificationUriComplete, DEVICE.verificationUriComplete]);
  await host.actions["cancel-sign-in"]();
});

test("cancelling a sign-in stops asking", async () => {
  const polls = [];
  const { host } = await setup(deviceRoute([PENDING], polls));
  await host.actions["sign-in-code"]();
  assert.ok(await until(() => polls.length >= 2));
  await host.actions["cancel-sign-in"]();
  const asked = polls.length;
  await until(() => false);
  assert.ok(polls.length <= asked + 1, "at most the poll already in flight");
  assert.equal(accountState(host), "Signed out");
  assert.equal(host.storage.get("session"), undefined);
});

test("an expired code ends the sign-in and says so", async () => {
  const polls = [];
  const { host } = await setup(deviceRoute([PENDING, { status: 400, body: { error: "expired_token" } }], polls));
  await host.actions["sign-in-code"]();
  assert.ok(await until(() => accountState(host) === "Signed out"));
  assert.equal(polls.length, 2);
  assert.match(host.lastNotice().message, /expired/);
});

test("a refused sign-in stops with the server's reason", async () => {
  const polls = [];
  const { host } = await setup(deviceRoute([PENDING, { status: 403, body: { error: "This account is suspended." } }], polls));
  await host.actions["sign-in-code"]();
  assert.ok(await until(() => accountState(host) === "Signed out"));
  assert.match(host.lastNotice().message, /Couldn't finish signing in: This account is suspended\./);
  await until(() => false);
  assert.equal(polls.length, 2);
});

test("a dropped connection while waiting is retried, not fatal", async () => {
  const polls = [];
  const token = { body: { token: "vcom_tok", user: { login: "alice" } } };
  const { host } = await setup(deviceRoute([{ status: 502, body: { error: "bad gateway" } }, PENDING, token], polls));
  await host.actions["sign-in-code"]();
  assert.ok(await until(() => host.storage.get("session")));
  assert.equal(polls.length, 3);
});

test("switching to a code gives up the browser sign-in, so its late link is ignored", async () => {
  const polls = [];
  const exchanges = [];
  const { host } = await setup(
    deviceRoute([PENDING], polls, (u, init) => {
      if (u.pathname === "/auth/exchange") exchanges.push(JSON.parse(init.body));
    })
  );
  await host.actions["sign-in"]();
  const st = new URL(host.opened[0]).searchParams.get("state");
  await host.actions["sign-in-code"]();
  assert.equal(host.opened[1], DEVICE.verificationUriComplete);
  assert.ok(nodes(host.lastView(), "text").some((n) => n.content.includes("BCDF-GHJK")));
  await host.deepLink(`viboplr://plugin/community/auth?code=late&state=${st}`);
  await flush();
  assert.equal(exchanges.length, 0);
  // And back: the browser sign-in stops the polling.
  await host.actions["sign-in"]();
  const asked = polls.length;
  await until(() => false);
  assert.ok(polls.length <= asked + 1, "at most the poll already in flight");
  await host.actions["cancel-sign-in"]();
});

test("an imported sheet's byline keeps its author and names who shared it", () => {
  const p = loadPlugin();
  assert.equal(p._importAuthor(ITEM), "Claude · via @alice");
  assert.equal(p._importAuthor({ ...ITEM, author: null }), "@alice");
  assert.ok(p._importAuthor({ ...ITEM, author: "x".repeat(100) }).length <= 64);
});

test("import installs the sheet through api.cues and remembers where it came from", async () => {
  const counted = [];
  const { plugin, host } = await setup((u) => {
    if (u.pathname === "/v1/items/abc123") return { body: { item: { ...ITEM, payload: SHEET } } };
    if (u.pathname === "/v1/items/abc123/imported") counted.push(1);
    return { status: 204 };
  });
  await openAndAnswer(host, "abc123");
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
  await openAndAnswer(host, "abc123");
  const ask = asked(host, "answer-replace");
  assert.match(ask.message, /^Replace your cue sheet\? You already have a cue sheet for “Jóga” by Björk\. Importing @alice's replaces it\.$/);
  assert.equal(ask.options.action.label, "Replace");
  assert.equal(ask.options.kind, "warning");
  assert.equal((await host.api.cues.get("Jóga", "Björk")).sheet.cues[0].text, "mine", "nothing replaced yet");
  // A leftover Import button can't be what replaces it: that's its own button.
  await host.actions["answer-open"]();
  assert.equal((await host.api.cues.get("Jóga", "Björk")).sheet.cues[0].text, "mine");
  await host.actions["answer-replace"]();
  assert.equal((await host.api.cues.get("Jóga", "Björk")).sheet.cues[0].text, "hi");
  await host.actions["answer-replace"]();
  assert.match(host.lastNotice().message, /already answered/);
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
  await openAndAnswer(signedIn, "abc123");
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
  assert.equal(accountState(host), "Signed out");
  assert.match(host.lastNotice().message, /sign in again/i);
});

test("an unreachable server says so when a share link is opened", async () => {
  const { host } = await setup(
    () => {
      throw new Error("connection refused");
    },
    { session: { token: "vcom_tok", user: { login: "alice" } } }
  );
  await host.deepLink("viboplr://plugin/community/open?id=abc123");
  for (let i = 0; i < 5; i++) await flush();
  assert.match(host.lastNotice().message, /Couldn't open that link: connection refused/);
});

test("a proxy's web page instead of JSON is named as such, and requests identify themselves", async () => {
  // Seen live behind Zscaler: HTTP 200 carrying its "Browser Isolation" page.
  const { host } = await setup(() => ({ status: 200, body: undefined }), { session: { token: "vcom_tok", user: { login: "alice" } } });
  host.api.network.fetch = async (url, init = {}) => {
    host.requests.push({ url, init });
    return { status: 200, headers: {}, text: async () => "<!doctype html><title>Browser Isolation</title>" };
  };
  host.requests.length = 0;
  await host.deepLink("viboplr://plugin/community/open?id=abc123");
  for (let i = 0; i < 5; i++) await flush();
  assert.match(host.lastNotice().message, /proxy or filter on your network/);
  assert.match(host.requests[0].init.headers["User-Agent"], /^Viboplr-Community-Plugin\//);
  assert.ok(host.logs.some((l) => l.level === "warn" && /Browser Isolation/.test(l.message)));
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

test("a share link asks to import in a notice, whose button imports", async () => {
  const { host } = await setup((u) => {
    if (u.pathname === "/v1/items/abc123") return { body: { item: { ...ITEM, payload: SHEET } } };
    return { status: 204 };
  });
  await host.deepLink("viboplr://plugin/community/open?id=abc123");
  for (let i = 0; i < 5; i++) await flush();
  assert.deepEqual(host.navigated, [], "no view to open");
  const ask = asked(host, "answer-open");
  assert.equal(ask.message, "Import this cue sheet? @alice's cue sheet for “Jóga” by Björk will play over that song in Now Playing.");
  assert.equal(ask.options.action.label, "Import");
  assert.equal(await host.api.cues.get("Jóga", "Björk"), null, "nothing until the button");
  await host.actions["answer-open"]();
  assert.deepEqual((await host.api.cues.get("Jóga", "Björk")).sheet, SHEET);
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

test("a share link to something the app can't take in (a Subsonic server) opens its page", async () => {
  const { host } = await setup((u) => {
    if (u.pathname === "/v1/items/srv1") return { body: { item: SERVER_ITEM } };
  });
  await host.deepLink("viboplr://plugin/community/open?id=srv1");
  for (let i = 0; i < 5; i++) await flush();
  assert.deepEqual(host.opened, ["https://community.viboplr.com/servers/srv1"]);
  assert.deepEqual(host.navigated, []);
  assert.equal(host.addRequests.length, 0, "the website's Add opens the app's dialog itself");
});

test("a module the plugin has never heard of is still named in the counts", async () => {
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
                kind: "eq_preset", slug: "eq-presets", name: "EQ presets", singular: "EQ preset", intro: "", area: "presets",
                notice: "Shared EQ presets.", popularLabel: "Most used", useNoun: ["use", "uses"],
                url: "https://community.viboplr.com/eq-presets", shareUrl: null,
              },
            ],
          },
        };
      }
      if (u.pathname === "/v1/me/items") return { body: { items: [PRESET] } };
    },
    { session: { token: "vcom_tok", user: { login: "bob" } } }
  );
  await plugin._loadModules();
  assert.ok(host.storage.get("modules").some((m) => m.kind === "eq_preset"), "remembered for the next start");
  // No `plural`, so the lowercased name.
  assert.equal(plugin._countsText({ cue_sheet: 1, eq_preset: 2 }), "Community: 1 cue sheet · 2 eq presets");
  const row = plugin._cardRow(plugin._state().modules.find((m) => m.kind === "eq_preset"), PRESET);
  assert.deepEqual(row, { id: "eq1", title: "HD 600", subtitle: "10 bands · @bob · 1 use", actions: ["page"] });
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
  assert.deepEqual(plugin._state().modules.map((m) => m.kind), plugin._builtinModules.map((m) => m.kind), "the built-in list stays");
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

  // Publishing it again updates it.
  await host.menu["publish-mixtape"]({ kind: "playlist", playlistId: id, playlistName: "Sunday" });
  assert.equal(posted.length, 2);
});

test("publishing a playlist needs a sign-in, and only a playlist you saved is published", async () => {
  const posted = [];
  const signedOut = await setup(mixRoute(posted));
  const sunday = await signedOut.host.addPlaylist("Sunday", MIX_TRACKS);
  await signedOut.host.menu["publish-mixtape"]({ kind: "playlist", playlistId: sunday, playlistName: "Sunday" });
  assert.equal(posted.length, 0);
  assert.equal(signedOut.host.lastNotice().options.action.id, "sign-in");

  const { host } = await setup(mixRoute(posted), { session: { token: "vcom_tok", user: { login: "alice" } } });
  assert.equal(host.actions["publish-queue"], undefined, "the queue isn't published");
  await host.menu["publish-mixtape"]({ kind: "playlist", playlistId: 99, playlistName: "Ghost" });
  assert.equal(posted.length, 0, "a playlist that isn't saved");
  assert.match(host.lastNotice().message, /Couldn't find that playlist/);
});

test("Save remembers where the mixtape came from, and a newer version replaces the saved copy", async () => {
  const at = { version: 1 };
  const { host } = await setup(mixRoute([], at));
  const save = () => openAndAnswer(host, "mx1");

  await save();
  const [saved] = host.playlists.values();
  assert.equal(saved.name, "Late night");
  assert.equal(saved.description, "Slow ones.");
  assert.deepEqual(saved.metadata, { communityId: "mx1", communityVersion: 1, communityBy: "bob" });
  assert.equal(saved.tracks.length, 2);
  assert.equal(saved.source, undefined, "plays as an ordinary playlist");

  await save();
  assert.equal(host.playlists.size, 1);
  assert.match(host.lastNotice().message, /already in your Playlists/);

  // bob republishes: saving again swaps the saved copy for the new version.
  at.version = 2;
  await save();
  const copies = [...host.playlists.values()];
  assert.equal(copies.length, 1);
  assert.equal(copies[0].metadata.communityVersion, 2);
  assert.match(host.lastNotice().message, /Updated “Late night”/);
});

test("Liked/Disliked and the app's mixes are never published", async () => {
  const posted = [];
  const { host } = await setup(mixRoute(posted), { session: { token: "vcom_tok", user: { login: "alice" } } });
  for (const [name, extra] of [
    ["Liked Tracks", {}],
    ["Disliked Tracks", {}],
    ["Kyuss Mix", { metadata: { recipe: "daily-mix", first_artist: "Kyuss" } }],
  ]) {
    const id = await host.addPlaylist(name, MIX_TRACKS, extra);
    await host.menu["publish-mixtape"]({ kind: "playlist", playlistId: id, playlistName: name });
    assert.match(host.lastNotice().message, new RegExp("“" + name + "” is made by Viboplr, so it can't be published"));
  }
  assert.equal(posted.length, 0);
});

test("a saved community mixtape isn't yours to publish", async () => {
  const posted = [];
  const { host } = await setup(mixRoute(posted), { session: { token: "vcom_tok", user: { login: "alice" } } });
  const id = await host.addPlaylist("Late night", MIX_TRACKS, { metadata: { communityId: "mx1", communityVersion: 1, communityBy: "bob" } });
  await host.menu["publish-mixtape"]({ kind: "playlist", playlistId: id, playlistName: "Late night" });
  assert.equal(posted.length, 0);
  assert.match(host.lastNotice().message, /isn't yours to publish/);
});

test("a mixtape share link asks to save in a notice", async () => {
  const { host } = await setup(mixRoute([]));
  await host.deepLink("viboplr://plugin/community/open?id=mx1");
  for (let i = 0; i < 10; i++) await flush();
  assert.deepEqual(host.navigated, []);
  const ask = asked(host, "answer-open");
  assert.equal(ask.message, "Save this mixtape? @bob's mixtape “Late night” (2 tracks) will be added to your Playlists.");
  assert.equal(ask.options.action.label, "Save to Playlists");
  assert.equal(host.playlists.size, 0);
  await host.actions["answer-open"]();
  assert.equal(host.playlists.size, 1);
});

test("a saved mixtape deleted in the app can be saved again", async () => {
  const { host } = await setup(mixRoute([]));
  await openAndAnswer(host, "mx1");
  const [saved] = host.playlists.values();
  await host.api.playlists.delete(saved.id);
  await openAndAnswer(host, "mx1");
  assert.equal(host.playlists.size, 1, "the playlists are read again, not remembered");
  assert.match(host.lastNotice().message, /Saved “Late night”/);
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
  // The track page's "shared on Community" line, and the Community tab on each kind of page.
  assert.deepEqual(
    manifest.contributes.informationTypes.map((t) => [t.id, t.entity, t.displayKind]),
    [
      ["community_shared", "track", "title_line"],
      ["community_track", "track", "plugin_view"],
      ["community_album", "album", "plugin_view"],
      ["community_artist", "artist", "plugin_view"],
    ]
  );
  assert.ok(manifest.permissions.includes("lyrics:write"));
  assert.equal(p._provideLyrics, undefined);
});

// How a lyrics item reads in a list (the Community tab's rows).
const lyricsRow = (plugin, item) => plugin._cardRow(plugin._builtinModules.find((m) => m.kind === "synced_lyrics"), item);

test("Import makes the shared lyrics the song's lyrics through api.lyrics.save", async () => {
  const { plugin, host } = await setup(lyricsRoute([]));
  host.webLyrics.set(JOGA_KEY, { text: "plain words", kind: "plain" });
  await openAndAnswer(host, "ly1");
  assert.deepEqual(host.lyricsSaves.map((s) => s.track), [{ title: "Jóga", artistName: "Björk", albumTitle: "Homogenic" }]);
  assert.equal(host.lyricsSaves[0].lyrics.kind, "synced");
  assert.match(host.lyricsCache.get(JOGA_KEY).text, /Three v1/);
  assert.match(host.lastNotice().message, /scroll along in Now Playing/);
  await flush();
  assert.ok(host.requests.some((r) => r.url.endsWith("/v1/items/ly1/imported")), "an import counts");

  const row = lyricsRow(plugin, LYRICS_ITEM);
  assert.equal(row.badge.label, "Imported");
});

test("Import says which Viboplr it needs when the host can't save lyrics", async () => {
  const { host } = await setup(lyricsRoute([]));
  delete host.api.lyrics;
  await openAndAnswer(host, "ly1");
  assert.match(host.lastNotice().message, /1\.0\.94/);
  assert.equal(host.lyricsCache.size, 0);
});

test("Import asks first when the song already has synced lyrics, and says where from", async () => {
  const { host } = await setup(lyricsRoute([]));
  host.webLyrics.set(JOGA_KEY, { text: "[00:01.00]theirs", kind: "synced", _meta: { providerName: "LRCLIB" } });
  await openAndAnswer(host, "ly1");
  const ask = asked(host, "answer-replace");
  assert.match(ask.message, /^Use these synced lyrics instead\? “Jóga” by Björk already has synced lyrics \(from LRCLIB\)/);
  assert.equal(host.lyricsSaves.length, 0, "nothing changed yet");
  await host.actions["answer-replace"]();
  assert.match(host.lyricsCache.get(JOGA_KEY).text, /Three v1/);
});

test("Undo on the song's Community tab hands the song back to the user's providers", async () => {
  const { plugin, host } = await setup(lyricsRoute([]));
  await openAndAnswer(host, "ly1");
  host.webLyrics.set(JOGA_KEY, { text: "plain words", kind: "plain" });
  assert.equal(lyricsRow(plugin, LYRICS_ITEM).badge.label, "Imported");
  await host.actions["tab-undo-lyrics"]({ entity: { kind: "track", name: "Jóga", artistName: "Björk" } });
  assert.equal(host.infoFetches.at(-1).opts.force, true, "re-walks the chain");
  assert.equal(host.lyricsCache.get(JOGA_KEY).text, "plain words");
  assert.deepEqual(lyricsRow(plugin, LYRICS_ITEM).actions, ["import-lyrics", "page"], "importable again");
});

test("a newer version offers Update, and Update saves the new text without asking", async () => {
  const at = { version: 1 };
  const { plugin, host } = await setup(lyricsRoute([], at));
  await openAndAnswer(host, "ly1");
  at.version = 2;
  const row = lyricsRow(plugin, { ...LYRICS_ITEM, version: 2 });
  assert.equal(row.badge.label, "Update");
  await host.actions["tab-update-lyrics"]({ itemId: "ly1", entity: { kind: "track", name: "Jóga", artistName: "Björk" } });
  assert.equal(asked(host, "answer-replace"), null, "no question");
  assert.equal(nodes(host.sectionData.at(-1).data, "confirm").length, 0);
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

test("the assistant's publish_lyrics tool reports the outcome and uses the library's spelling", async () => {
  const posted = [];
  const { host } = await setup(lyricsRoute(posted), { session: { token: "vcom_tok", user: { login: "alice" } } });
  host.libraryTracks.push({ title: "Jóga", artist_name: "Björk", album_title: "Homogenic" });
  const tool = host.tools.publish_lyrics;
  assert.equal(typeof tool, "function");

  await assert.rejects(async () => tool({}), /title is required/);
  await assert.rejects(() => tool({ title: "joga" }), /no lyrics/i);
  host.lyricsCache.set(JOGA_KEY, { text: "plain words", kind: "plain" });
  await assert.rejects(() => tool({ title: "joga", artistName: "bjork" }), /only has plain lyrics/);
  assert.equal(posted.length, 0);

  // Sloppy spelling and no artist: the cache is read under the library's own.
  host.lyricsCache.set(JOGA_KEY, { text: LRC, kind: "synced" });
  host.infoFetches.length = 0;
  host.infoReads.length = 0;
  const out = await tool({ title: "joga" });
  assert.equal(out.status, "published");
  assert.equal(typeof out.url, "string");
  assert.equal(posted.length, 1);
  assert.equal(posted[0].title, "Jóga");
  assert.equal(posted[0].artistName, "Björk");
  assert.equal(posted[0].albumName, "Homogenic");
  assert.ok(host.infoReads.length > 0 && host.infoReads.every((r) => r.entity.name === "Jóga" && r.entity.artistName === "Björk"));
  // Lyrics the app already had are never fetched again.
  assert.equal(host.infoFetches.length, 0);
});

test("publish_lyrics asks for an artist when a title matches several, and for sign-in when signed out", async () => {
  const { host } = await setup(lyricsRoute([]), { session: { token: "vcom_tok", user: { login: "alice" } } });
  host.libraryTracks.push({ title: "Home", artist_name: "Depeche Mode", album_title: "A" }, { title: "Home", artist_name: "Daughter", album_title: "B" });
  await assert.rejects(() => host.tools.publish_lyrics({ title: "home" }), /several artists.*artistName/);

  const out = await setup(lyricsRoute([]));
  await assert.rejects(async () => out.host.tools.publish_lyrics({ title: "Jóga" }), /Not signed in/);
});

test("Show on Community opens the song's own page on its Community tab; a share link asks to import", async () => {
  const { host } = await setup(lyricsRoute([]));
  const opened = [];
  host.api.ui.navigateToEntity = (kind, ref, opts) => opened.push([kind, ref, opts]);
  await host.menu["show-on-community"]({ kind: "track", title: "Jóga", artistName: "Björk", albumTitle: "Homogenic" });
  assert.deepEqual(opened, [["track", { name: "Jóga", artistName: "Björk", albumTitle: "Homogenic" }, { tab: "community_track" }]]);

  await host.deepLink("viboplr://plugin/community/open?id=ly1");
  for (let i = 0; i < 10; i++) await flush();
  assert.equal(asked(host, "answer-open").message, "Import these synced lyrics? @bob's synced lyrics for “Jóga” by Björk will scroll along in Now Playing.");
});

// ---------------------------------------------------------------------------
// What's shared about a song
// ---------------------------------------------------------------------------

// Answers /v1/subjects/resolve with `counts` for Jóga by Björk, 404 otherwise.
function subjectsRoute(counts, status = 200) {
  return (url) => {
    if (url.pathname !== "/v1/subjects/resolve") return undefined;
    if (status !== 200) return { status, body: { error: "nope" } };
    if (url.searchParams.get("title") !== "Jóga" || url.searchParams.get("artist") !== "Björk") return undefined;
    return { body: { subject: { id: 7, kind: "track", name: "Jóga", counts } } };
  };
}
const JOGA_ENTITY = { kind: "track", id: 0, name: "Jóga", artistName: "Björk" };
const resolves = (host) => host.requests.filter((r) => r.url.includes("/v1/subjects/resolve"));

test("the track page's header line counts what's shared for the song, asked once", async () => {
  const { host } = await setup(subjectsRoute({ cue_sheet: 2, synced_lyrics: 1 }));
  await flush();
  assert.equal(resolves(host).length, 0, "nothing is asked until someone looks");

  const got = await host.infoProviders.community_shared(JOGA_ENTITY);
  assert.deepEqual(got, {
    status: "ok",
    value: { items: [{ value: 2, label: "cue sheets" }, { value: 1, label: "lyric sheet on Community" }] },
  });
  const asked = new URL(resolves(host)[0].url);
  assert.deepEqual([...asked.searchParams], [["kind", "track"], ["title", "Jóga"], ["artist", "Björk"]]);
  assert.equal(resolves(host)[0].init.headers.Authorization, undefined, "a public read, no token");

  // The Now Playing item reads the same answer without asking again.
  assert.deepEqual(await host.npHandlers.shared({ title: "Jóga", artist_name: "Björk" }), {
    status: "ok",
    text: "Community: 2 cue sheets · 1 lyric sheet",
  });
  assert.equal(resolves(host).length, 1);
});

test("a song with nothing shared shows nothing; a failing server is an error, not a count", async () => {
  let { host } = await setup(subjectsRoute({}));
  assert.deepEqual(await host.infoProviders.community_shared({ ...JOGA_ENTITY, name: "Other" }), { status: "not_found" });
  assert.deepEqual(await host.infoProviders.community_shared(JOGA_ENTITY), { status: "not_found" }, "empty counts");
  assert.deepEqual(await host.npHandlers.shared({ title: "Other", artist_name: "Björk" }), { status: "empty" });

  ({ host } = await setup(subjectsRoute({}, 500)));
  assert.deepEqual(await host.infoProviders.community_shared(JOGA_ENTITY), { status: "error" });
  assert.deepEqual(await host.npHandlers.shared({ title: "Jóga", artist_name: "Björk" }), { status: "error" });
});

test("the Now Playing item is off until the user switches it on", async () => {
  const { host } = await setup(subjectsRoute({}));
  assert.deepEqual(host.npItems, [{ id: "shared", label: "Shared on Community", priority: 200, defaultEnabled: false }]);
});

test("counts name kinds the way their module does, in the server's order, and skip unknown ones", async () => {
  const { plugin } = await setup(subjectsRoute({}));
  assert.equal(plugin._countsText({ synced_lyrics: 3, cue_sheet: 1, mystery: 4 }), "Community: 1 cue sheet · 3 synced lyrics");
  assert.equal(plugin._countsText({}), "");
  assert.equal(plugin._countsTitleLine({ cue_sheet: 0 }), null);
});
