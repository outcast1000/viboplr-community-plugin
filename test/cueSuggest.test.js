// Shared cue sheets in Now Playing: while Now Playing is on screen and the
// playing song has no sheet of the user's, Community is asked for one that
// fits; it's offered (a toast with Import) or imported, per the setting.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadPlugin } = require("./harness/sandbox");
const { makeHost } = require("./harness/host");

const SIGNED_IN = { token: "vcom_tok", user: { login: "alice" } };
const JOGA = { key: "q:1", title: "Jóga", artist_name: "Björk", album_title: "Homogenic", duration_secs: 305, path: "file:///m/joga.flac", format: "flac" };
const ON_SCREEN = {
  view: "nowplaying", entity: null, nowPlaying: { visible: true, fullscreen: false }, pluginView: null,
  window: { visible: true, focused: true, mini: false },
};
const ELSEWHERE = { ...ON_SCREEN, view: "home", nowPlaying: { visible: false, fullscreen: false } };
const SHEET = { mode: "cards", cues: [{ at: 1, text: "Hello" }] };

function sheetItem(id, extra = {}) {
  return { id, kind: "cue_sheet", title: "Jóga", artistName: "Björk", durationSecs: 305, importCount: 3, publisher: { login: "bob" }, ...extra };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

// `server.status` fails the list lookup with that HTTP status; `server.gate`
// (a promise) holds its answer back until it resolves.
async function setup({ items = [sheetItem("cue1")], session = SIGNED_IN, mode, context = ON_SCREEN, current = JOGA, server = {} } = {}) {
  const plugin = loadPlugin();
  const route = async (u) => {
    if (u.pathname === "/v1/items") {
      if (server.gate) await server.gate;
      if (server.status) return { status: server.status, body: { error: "nope" } };
      return { body: { items: items.filter((i) => i.title === u.searchParams.get("title")) } };
    }
    const m = /^\/v1\/items\/([^/]+)$/.exec(u.pathname);
    if (m) {
      const it = items.find((i) => i.id === m[1]);
      return it ? { body: { item: { ...it, version: 1, payload: SHEET } } } : undefined;
    }
    if (/\/imported$/.test(u.pathname)) return { body: {} };
    return undefined;
  };
  const host = makeHost({ route, current, uiContext: context });
  if (session) host.storage.set("session", session);
  if (mode) host.storage.set("cueSuggest", mode);
  await plugin.activate(host.api);
  await flush();
  await flush();
  const lookups = () => host.requests.filter((r) => /\/v1\/items\?/.test(r.url));
  return { plugin, host, lookups };
}

test("Now Playing on screen, no sheet of yours: one anonymous lookup and a toast with Import", async () => {
  const { plugin, host, lookups } = await setup();
  assert.equal(lookups().length, 1);
  assert.ok(!((lookups()[0].init && lookups()[0].init.headers) || {}).Authorization, "asked without the token");
  const notice = host.notices.find((n) => /cue sheet by @bob is shared/.test(n.message));
  assert.ok(notice, "offered");
  assert.equal(notice.options.action.id, "import-suggested-cue");
  assert.equal(host.cues.size, 0, "nothing imported until asked");

  await host.actions["import-suggested-cue"]();
  assert.equal(host.cues.size, 1);
  plugin.deactivate();
});

test("asked once per song, even across plays and context changes", async () => {
  const { plugin, host, lookups } = await setup();
  await host.setContext({ ...ON_SCREEN, nowPlaying: { visible: true, fullscreen: true } });
  await host.trackStarted(JOGA);
  await flush();
  assert.equal(lookups().length, 1);
  assert.ok(host.storage.get("cueAsked")[Object.keys(host.storage.get("cueAsked"))[0]] > 0, "remembered");
  plugin.deactivate();
});

test("nothing is asked while Now Playing isn't on screen", async () => {
  const { plugin, host, lookups } = await setup({ context: ELSEWHERE });
  assert.equal(lookups().length, 0);
  // A hidden window counts as not looking, whatever the view.
  await host.setContext({ ...ON_SCREEN, nowPlaying: { visible: false, fullscreen: false }, window: { visible: false, focused: false, mini: false } });
  assert.equal(lookups().length, 0);
  // Coming to Now Playing asks.
  await host.setContext(ON_SCREEN);
  await flush();
  assert.equal(lookups().length, 1);
  plugin.deactivate();
});

test("your own sheet wins: no lookup at all", async () => {
  const plugin = loadPlugin();
  const host = makeHost({ route: () => ({ body: { items: [sheetItem("cue1")] } }), current: JOGA, uiContext: ON_SCREEN });
  host.storage.set("session", SIGNED_IN);
  await host.addSheet("Jóga", "Björk", SHEET);
  await plugin.activate(host.api);
  await flush();
  await flush();
  assert.equal(host.requests.filter((r) => /\/v1\/items\?/.test(r.url)).length, 0);
  plugin.deactivate();
});

test("signed out, switched off, a video, or an older app: nothing is asked", async () => {
  for (const opts of [{ session: null }, { mode: "off" }, { current: { ...JOGA, format: "mp4", path: "file:///m/joga.mp4" } }, { context: false }]) {
    const { plugin, lookups } = await setup(opts);
    assert.equal(lookups().length, 0, JSON.stringify(opts));
    plugin.deactivate();
  }
});

test("a sheet timed to another recording isn't offered", async () => {
  const { plugin, host } = await setup({ items: [sheetItem("live", { durationSecs: 412 })] });
  assert.ok(!host.notices.some((n) => /cue sheet/.test(n.message)));
  plugin.deactivate();
});

test("Import automatically imports the most imported fitting sheet", async () => {
  const items = [sheetItem("other-cut", { durationSecs: 412, importCount: 9 }), sheetItem("best", { importCount: 5 }), sheetItem("second", { importCount: 1 })];
  const { plugin, host } = await setup({ mode: "auto", items });
  assert.equal(host.cues.size, 1);
  assert.ok(host.requests.some((r) => /\/v1\/items\/best$/.test(new URL(r.url).pathname)));
  assert.ok(host.notices.some((n) => /Imported the cue sheet/.test(n.message)));
  plugin.deactivate();
});

test("the Settings select stores the mode", async () => {
  const { plugin, host } = await setup({ context: ELSEWHERE });
  await host.actions["set-cue-suggest"]({ value: "auto" });
  assert.equal(host.storage.get("cueSuggest"), "auto");
  await host.actions["set-cue-suggest"]({ value: "nonsense" });
  assert.equal(host.storage.get("cueSuggest"), "notify");
  plugin.deactivate();
});

// ---- when a song counts as asked, and what Import imports -------------------

const ARMY = { key: "q:2", title: "Army of Me", artist_name: "Björk", album_title: "Post", duration_secs: 234, path: "file:///m/army.flac", format: "flac" };
const HUNTER = { key: "q:3", title: "Hunter", artist_name: "Björk", album_title: "Homogenic", duration_secs: 255, path: "file:///m/hunter.flac", format: "flac" };
const asked = (host) => Object.keys(host.storage.get("cueAsked") || {});
const offers = (host) => host.notices.filter((n) => /cue sheet.* is shared/.test(n.message));
// A "Replace yours?" question is a notice with a Replace button.
const confirmed = (host) => host.notices.some((n) => /Replace your cue sheet\?/.test(n.message) || (n.options && n.options.action && n.options.action.id === "answer-replace"));

test("a lookup that failed doesn't count as asked: the next look asks again", async () => {
  const server = { status: 503 };
  const { plugin, host, lookups } = await setup({ server });
  assert.equal(lookups().length, 1);
  assert.equal(offers(host).length, 0);
  assert.deepEqual(asked(host), [], "not remembered");
  assert.ok(host.logs.some((l) => l.level === "warn" && /cue sheet/.test(l.message)));
  server.status = 0;
  await host.setContext({ ...ON_SCREEN, nowPlaying: { visible: true, fullscreen: true } });
  await flush();
  assert.equal(lookups().length, 2);
  assert.equal(offers(host).length, 1);
  assert.equal(asked(host).length, 1);
  plugin.deactivate();
});

test("a song that stopped playing mid-check isn't remembered, and a check in flight isn't repeated", async () => {
  let release;
  const server = { gate: new Promise((r) => (release = r)) };
  const { plugin, host, lookups } = await setup({ server });
  assert.equal(lookups().length, 1);
  // The same song coming on screen again while its check is still out.
  await host.setContext({ ...ON_SCREEN, nowPlaying: { visible: true, fullscreen: true } });
  await host.trackStarted(JOGA);
  await flush();
  assert.equal(lookups().length, 1, "one check at a time per song");
  host.current = HUNTER;
  release();
  await flush();
  await flush();
  assert.equal(offers(host).length, 0);
  assert.deepEqual(asked(host), []);
  plugin.deactivate();
});

test("a stale toast's Import imports only the sheet offered for the song playing now", async () => {
  const items = [sheetItem("joga-sheet"), sheetItem("army-sheet", { title: "Army of Me", durationSecs: 234 })];
  const { plugin, host } = await setup({ items });
  assert.equal(offers(host).length, 1);
  host.current = ARMY;
  await host.trackStarted(ARMY);
  await flush();
  await flush();
  assert.equal(offers(host).length, 2);
  // Either toast's Import, with Army of Me playing: its sheet, and only it.
  await host.actions["import-suggested-cue"]();
  assert.equal(host.cues.size, 1);
  assert.ok(await host.api.cues.get("Army of Me", "Björk"));
  assert.equal(await host.api.cues.get("Jóga", "Björk"), null);
  // Used up: pressing it again (or on a song with no offer) imports nothing.
  host.current = HUNTER;
  await host.actions["import-suggested-cue"]();
  assert.equal(host.cues.size, 1);
  assert.match(host.lastNotice().message, /isn't playing any more/);
  plugin.deactivate();
});

test("a sheet of your own made after the toast wins: Import imports nothing and asks nothing", async () => {
  const { plugin, host } = await setup();
  assert.equal(offers(host).length, 1);
  await host.addSheet("Jóga", "Björk", { mode: "cards", cues: [{ at: 2, text: "Mine" }] });
  await host.actions["import-suggested-cue"]();
  assert.equal((await host.api.cues.get("Jóga", "Björk")).sheet.cues[0].text, "Mine");
  assert.ok(!confirmed(host), "no Replace? question");
  assert.match(host.lastNotice().message, /You have your own cue sheet for “Jóga” now — nothing was imported/);
  assert.ok(!host.requests.some((r) => /\/imported$/.test(r.url)), "no use counted");
  plugin.deactivate();
});

test("Import automatically leaves a sheet of your own alone, without asking", async () => {
  let release;
  const server = { gate: new Promise((r) => (release = r)) };
  const { plugin, host } = await setup({ mode: "auto", server });
  // Made while the lookup was out.
  await host.addSheet("Jóga", "Björk", { mode: "cards", cues: [{ at: 2, text: "Mine" }] });
  release();
  await flush();
  await flush();
  assert.equal((await host.api.cues.get("Jóga", "Björk")).sheet.cues[0].text, "Mine");
  assert.ok(!confirmed(host));
  assert.ok(!host.notices.some((n) => /nothing was imported|Imported/.test(n.message)), "the auto path is quiet");
  assert.equal(asked(host).length, 1);
  plugin.deactivate();
});

test("unknown length: never imported on its own, offered saying its timing wasn't checked", async () => {
  // Auto: a sheet without a length isn't imported, and the song is done.
  let s = await setup({ mode: "auto", items: [sheetItem("nolen", { durationSecs: null })] });
  assert.equal(s.host.cues.size, 0);
  assert.equal(asked(s.host).length, 1);
  s.plugin.deactivate();
  // Auto: nor is any sheet when the playing copy has no length.
  s = await setup({ mode: "auto", current: { ...JOGA, duration_secs: null } });
  assert.equal(s.host.cues.size, 0);
  s.plugin.deactivate();
  // Notify: offered, saying so.
  s = await setup({ items: [sheetItem("nolen", { durationSecs: null })] });
  assert.match(offers(s.host)[0].message, /\(its timing couldn't be checked against this copy\)/);
  s.plugin.deactivate();
  s = await setup({ current: { ...JOGA, duration_secs: null } });
  assert.match(offers(s.host)[0].message, /timing couldn't be checked/);
  s.plugin.deactivate();
  // Notify: an exact fit is preferred over a more imported unknown one.
  s = await setup({ items: [sheetItem("nolen", { durationSecs: null, importCount: 9, publisher: { login: "carol" } }), sheetItem("exact")] });
  const [offer] = offers(s.host);
  assert.match(offer.message, /by @bob/);
  assert.doesNotMatch(offer.message, /timing/);
  assert.match(offer.message, /1 more on its Community tab/);
  s.plugin.deactivate();
});

test("a sheet you published yourself is never offered back to you", async () => {
  let s = await setup({ items: [sheetItem("mine", { publisher: { login: "alice" }, importCount: 9 })] });
  assert.equal(offers(s.host).length, 0);
  assert.equal(asked(s.host).length, 1, "nothing else fits: done");
  s.plugin.deactivate();
  s = await setup({ items: [sheetItem("mine", { publisher: { login: "alice" }, importCount: 9 }), sheetItem("bobs")] });
  const [offer] = offers(s.host);
  assert.match(offer.message, /by @bob/);
  assert.doesNotMatch(offer.message, /more on its Community tab/);
  s.plugin.deactivate();
});
