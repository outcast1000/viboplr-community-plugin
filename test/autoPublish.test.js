// Auto-publish: synced lyrics (api.lyrics.onChanged) and cue sheets
// (api.cues.onChanged) go to Community as they land, once each, through one
// queue that respects the server's hourly write budget.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadPlugin } = require("./harness/sandbox");
const { makeHost } = require("./harness/host");

const SIGNED_IN = { token: "vcom_tok", user: { login: "alice" } };
const LRC = "[00:01.00]Love, love is a verb\n[00:05.00]Love is a doing word";

function change(extra = {}) {
  return {
    title: "Teardrop",
    artistName: "Massive Attack",
    albumTitle: "Mezzanine",
    durationSecs: 330,
    kind: "synced",
    text: LRC,
    origin: "provider",
    pluginId: null,
    provider: "lyrics/lrclib",
    ...extra,
  };
}

function nodes(tree, type, out = []) {
  if (!tree || typeof tree !== "object") return out;
  if (tree.type === type) out.push(tree);
  for (const c of tree.children || []) nodes(c, type, out);
  if (tree.control) nodes(tree.control, type, out);
  return out;
}

// A small Community: published items by id, and a write budget.
async function setup(t, opts = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const plugin = loadPlugin();
  const server = { items: new Map(opts.items || []), posts: [], limited: !!opts.limited, nextId: 1 };
  const route = (u, init = {}) => {
    if (u.pathname === "/v1/items" && init.method === "POST") {
      if (server.limited) return { status: 429, body: { error: "slow down" } };
      const body = JSON.parse(init.body);
      server.posts.push(body);
      const id = "id" + server.nextId++;
      const item = { id, url: "https://community.viboplr.com/x/" + id, kind: body.kind, title: body.title, artistName: body.artistName, publisher: { login: "alice" }, payload: { lrc: body.lrc } };
      server.items.set(id, item);
      return { body: { created: true, item } };
    }
    if (u.pathname === "/v1/items" && (init.method || "GET") === "GET") {
      const kind = u.searchParams.get("kind");
      const title = u.searchParams.get("title");
      const items = [...server.items.values()].filter((it) => it.kind === kind && it.title === title);
      return { body: { items } };
    }
    const one = /^\/v1\/items\/([^/]+)$/.exec(u.pathname);
    if (one && server.items.has(one[1])) return { body: { item: server.items.get(one[1]) } };
    return undefined;
  };
  const host = makeHost({ route, changeEvents: opts.changeEvents !== false });
  if (opts.signedOut !== true) host.storage.set("session", SIGNED_IN);
  if (opts.autoPublish !== undefined) host.storage.set("autoPublish", opts.autoPublish);
  await plugin.activate(host.api);
  // Let the queue run: flush promises, advance the clock, repeat.
  const drain = async (rounds = 40, step = 4000) => {
    for (let i = 0; i < rounds; i++) {
      await new Promise((r) => setImmediate(r));
      t.mock.timers.tick(step);
    }
    await new Promise((r) => setImmediate(r));
  };
  return { plugin, host, server, drain };
}

test("a synced lyric a provider found is published, once", async (t) => {
  const { plugin, host, server, drain } = await setup(t);
  host.lyricsChanged(change());
  await drain();
  assert.equal(server.posts.length, 1);
  assert.equal(server.posts[0].kind, "synced_lyrics");
  assert.equal(server.posts[0].lrc, LRC);
  assert.equal(server.posts[0].durationSecs, 330);
  assert.equal(server.posts[0].albumName, "Mezzanine");
  // The same text again (a cache expiry re-walk) sends nothing.
  host.lyricsChanged(change());
  await drain();
  assert.equal(server.posts.length, 1);
  // Edited text goes out.
  host.lyricsChanged(change({ origin: "edit", provider: null, text: LRC + "\n[00:09.00]Talk is only talk" }));
  await drain();
  assert.equal(server.posts.length, 2);
  plugin.deactivate();
});

test("plain lyrics, and lyrics Community's own provider served, are never published", async (t) => {
  const { plugin, host, server, drain } = await setup(t);
  host.lyricsChanged(change({ kind: "plain", text: "Love, love is a verb" }));
  host.lyricsChanged(change({ provider: "community" }));
  await drain();
  assert.equal(server.posts.length, 0);
  plugin.deactivate();
});

test("lyrics the member already shared with the same text cost no write", async (t) => {
  const existing = { id: "old", kind: "synced_lyrics", title: "Teardrop", artistName: "Massive Attack", publisher: { login: "alice" }, payload: { lrc: LRC + "\n" } };
  const { plugin, host, server, drain } = await setup(t, { items: [["old", existing]] });
  host.lyricsChanged(change());
  await drain();
  assert.equal(server.posts.length, 0);
  // …and is remembered, so the next identical event doesn't even ask.
  const asked = host.requests.length;
  host.lyricsChanged(change());
  await drain();
  assert.equal(host.requests.filter((r) => /\/v1\/items/.test(r.url)).length, host.requests.slice(0, asked).filter((r) => /\/v1\/items/.test(r.url)).length);
  plugin.deactivate();
});

test("someone else's copy of the song doesn't stop the member's own", async (t) => {
  const theirs = { id: "b", kind: "synced_lyrics", title: "Teardrop", artistName: "Massive Attack", publisher: { login: "bob" }, payload: { lrc: LRC } };
  const { plugin, host, server, drain } = await setup(t, { items: [["b", theirs]] });
  host.lyricsChanged(change());
  await drain();
  assert.equal(server.posts.length, 1);
  plugin.deactivate();
});

test("switched off, or signed out: nothing is queued or sent", async (t) => {
  const off = await setup(t, { autoPublish: false });
  off.host.lyricsChanged(change());
  await off.drain();
  assert.equal(off.server.posts.length, 0);
  off.plugin.deactivate();
  t.mock.timers.reset();

  const out = await setup(t, { signedOut: true });
  out.host.lyricsChanged(change());
  await out.drain();
  assert.equal(out.server.posts.length, 0);
  out.plugin.deactivate();
});

test("a song whose recording length can't be told is skipped", async (t) => {
  const { plugin, host, server, drain } = await setup(t);
  host.lyricsChanged(change({ durationSecs: null }));
  await drain();
  assert.equal(server.posts.length, 0);
  assert.equal(host.requests.filter((r) => /\/v1\/items/.test(r.url)).length, 0, "not even a lookup");
  assert.equal(plugin._state().autoQueue.length, 0);
  plugin.deactivate();
});

test("a cue sheet the assistant saves is published, and not again for the same save", async (t) => {
  const { plugin, host, server, drain } = await setup(t);
  const row = await host.addSheet("Teardrop", "Massive Attack", { cues: [{ at: 1, kind: "text", text: "Hi" }] }, { durationSecs: 330 });
  host.cuesChanged({ title: "Teardrop", artistName: "Massive Attack", action: "saved", origin: "assistant", pluginId: null, updatedAt: row.updatedAt });
  await drain();
  assert.equal(server.posts.length, 1);
  assert.equal(server.posts[0].kind, "cue_sheet");
  host.cuesChanged({ title: "Teardrop", artistName: "Massive Attack", action: "saved", origin: "assistant", pluginId: null, updatedAt: row.updatedAt });
  // A delete publishes nothing.
  host.cuesChanged({ title: "Teardrop", artistName: "Massive Attack", action: "deleted", origin: "assistant", pluginId: null, updatedAt: null });
  await drain();
  assert.equal(server.posts.length, 1);
  plugin.deactivate();
});

test("a 429 parks the queue and the job goes out when the window reopens", async (t) => {
  const { plugin, host, server, drain } = await setup(t, { limited: true });
  host.lyricsChanged(change());
  await drain(5);
  assert.equal(server.posts.length, 0);
  assert.equal(plugin._state().autoQueue.length, 1);
  server.limited = false;
  await drain(10, 2 * 60 * 1000);
  assert.equal(server.posts.length, 1);
  assert.equal(plugin._state().autoQueue.length, 0);
  plugin.deactivate();
});

test("the queue survives a restart", async (t) => {
  const first = await setup(t, { limited: true });
  first.host.lyricsChanged(change());
  await first.drain(5);
  const saved = first.host.storage.get("autoQueue");
  assert.equal(saved.length, 1);
  first.plugin.deactivate();
  t.mock.timers.reset();

  const second = await setup(t);
  second.host.storage.set("autoQueue", saved);
  second.plugin.deactivate();
  const plugin = loadPlugin();
  await plugin.activate(second.host.api);
  await second.drain();
  assert.equal(second.server.posts.length, 1);
  plugin.deactivate();
});

test("the settings panel has the switch, on by default, and it turns off", async (t) => {
  const { plugin, host, server, drain } = await setup(t);
  const toggle = () => nodes(host.lastView(), "toggle").find((n) => n.action === "toggle-auto-publish");
  assert.equal(toggle().checked, true);
  await host.actions["toggle-auto-publish"]({ value: false });
  assert.equal(toggle().checked, false);
  assert.equal(host.storage.get("autoPublish"), false);
  host.lyricsChanged(change());
  await drain();
  assert.equal(server.posts.length, 0);
  plugin.deactivate();
});

test("an app without the change events subscribes to nothing", async (t) => {
  const { plugin, host } = await setup(t, { changeEvents: false });
  assert.equal(host.lyricsChangedHandler, null);
  assert.equal(host.cuesChangedHandler, null);
  plugin.deactivate();
});
