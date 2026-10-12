// Shared waveforms: the app asks Community for a waveform it doesn't have,
// and shares one it computed (api.waveforms, feature-detected).
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadPlugin } = require("./harness/sandbox");
const { makeHost } = require("./harness/host");

const SIGNED_IN = { token: "vcom_tok", user: { login: "alice" } };
const FACTS = {
  title: "Jóga",
  artistName: "Björk",
  albumName: "Homogenic",
  albumArtistName: null,
  durationSecs: 305,
  codec: "flac",
  sampleRate: 44100,
  bitDepth: 16,
  channels: 2,
  bitrateKbps: null,
};

function nodes(tree, type, out = []) {
  if (!tree || typeof tree !== "object") return out;
  if (tree.type === type) out.push(tree);
  for (const c of tree.children || []) nodes(c, type, out);
  if (tree.control) nodes(tree.control, type, out);
  return out;
}

// `waveform` is what the server has for the song (base64), or null.
async function setup(opts = {}) {
  const plugin = loadPlugin();
  const server = { waveform: opts.waveform ?? null, status: opts.status ?? 200 };
  const route = (u, init = {}) => {
    if (server.status !== 200) return { status: server.status, body: { error: "nope" } };
    if (u.pathname === "/v1/waveforms/lookup") return { body: { waveform: server.waveform, durationSecs: 305 } };
    if (u.pathname === "/v1/waveforms" && init.method === "PUT") return { body: { stored: true } };
    return undefined;
  };
  const host = makeHost({ route, waveforms: opts.waveforms !== false });
  if (opts.session) host.storage.set("session", opts.session);
  if (opts.shareWaveforms !== undefined) host.storage.set("shareWaveforms", opts.shareWaveforms);
  await plugin.activate(host.api);
  // Only the waveform requests, for assertions.
  const calls = () => host.requests.filter((r) => /\/v1\/waveforms/.test(r.url));
  return { plugin, host, server, calls };
}

test("signed out: the lookup answers null and nothing is asked", async () => {
  const { plugin, host, calls } = await setup();
  assert.equal(await host.waveformLookup(FACTS), null);
  await host.waveformShare(FACTS, [0.1, 0.2]);
  assert.equal(calls().length, 0);
  plugin.deactivate();
});

test("Share waveforms off: no lookup and no share", async () => {
  const { plugin, host, calls } = await setup({ session: SIGNED_IN, shareWaveforms: false, waveform: "AAEC" });
  assert.equal(await host.waveformLookup(FACTS), null);
  await host.waveformShare(FACTS, [0.1, 0.2]);
  assert.equal(calls().length, 0);
  plugin.deactivate();
});

test("a song without a title, artist or length is never asked about", async () => {
  const { plugin, host, calls } = await setup({ session: SIGNED_IN, waveform: "AAEC" });
  assert.equal(await host.waveformLookup({ ...FACTS, durationSecs: null }), null);
  assert.equal(await host.waveformLookup({ ...FACTS, artistName: null }), null);
  assert.equal(await host.waveformLookup({ ...FACTS, title: "" }), null);
  assert.equal(calls().length, 0);
  plugin.deactivate();
});

test("a hit decodes to per-second rms in 0..1", async () => {
  const bytes = [0, 64, 128, 255, 12];
  const { plugin, host, calls } = await setup({ session: SIGNED_IN, waveform: Buffer.from(bytes).toString("base64") });
  const got = await host.waveformLookup(FACTS);
  assert.equal(got.rms.length, bytes.length);
  assert.deepEqual(got.rms, bytes.map((b) => b / 255));
  assert.ok(got.rms.every((v) => v >= 0 && v <= 1));
  const [req] = calls();
  assert.equal(req.init.method, "POST");
  assert.ok(req.url.endsWith("/v1/waveforms/lookup"));
  assert.equal(req.init.headers.Authorization, "Bearer vcom_tok");
  assert.ok(req.init.timeoutMs <= 3000, "answers before the app gives up");
  // Only the facts that are set go out.
  assert.deepEqual(JSON.parse(req.init.body), {
    title: "Jóga",
    artistName: "Björk",
    albumName: "Homogenic",
    durationSecs: 305,
    codec: "flac",
    sampleRate: 44100,
    bitDepth: 16,
    channels: 2,
  });
  plugin.deactivate();
});

test("a miss or a failure is null, logged and never thrown", async () => {
  const { plugin, host, server } = await setup({ session: SIGNED_IN });
  assert.equal(await host.waveformLookup(FACTS), null);
  server.status = 503;
  assert.equal(await host.waveformLookup(FACTS), null);
  assert.ok(host.logs.some((l) => l.level === "error" && /waveform/.test(l.message)));
  plugin.deactivate();
});

test("a share sends one PUT with the normalized bytes", async () => {
  const { plugin, host, calls } = await setup({ session: SIGNED_IN });
  const rms = [0, 0.05, 0.1, 0.2, 0.025];
  await host.waveformShare(FACTS, rms);
  const sent = calls();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].init.method, "PUT");
  assert.ok(sent[0].url.endsWith("/v1/waveforms"));
  const body = JSON.parse(sent[0].init.body);
  assert.deepEqual([...Buffer.from(body.waveform, "base64")], [0, 64, 128, 255, 32]);
  assert.equal(body.durationSecs, 305);
  assert.equal(body.codec, "flac");
  assert.ok(!("albumArtistName" in body) && !("bitrateKbps" in body), "null fields are left out");
  plugin.deactivate();
});

test("silence isn't shared, and a failed share is only logged", async () => {
  const { plugin, host, server, calls } = await setup({ session: SIGNED_IN });
  await host.waveformShare(FACTS, [0, 0, 0]);
  assert.equal(calls().length, 0);
  server.status = 500;
  await host.waveformShare(FACTS, [0.1, 0.3]);
  assert.equal(calls().length, 1, "no retry");
  assert.ok(host.logs.some((l) => l.level === "error" && /share a waveform/.test(l.message)));
  plugin.deactivate();
});

test("the base64 codec round-trips every length", () => {
  const plugin = loadPlugin();
  for (let n = 0; n < 10; n++) {
    const bytes = Array.from({ length: n }, (_, i) => (i * 97 + 13) & 255);
    const text = plugin._base64Encode(bytes);
    assert.equal(text, Buffer.from(bytes).toString("base64"));
    assert.deepEqual(plugin._base64Decode(text), bytes);
  }
  assert.equal(plugin._base64Decode("not base64!"), null);
});

test("Settings has the Share waveforms switch, on by default, and it sticks", async () => {
  const { plugin, host, calls } = await setup({ session: SIGNED_IN, waveform: "AAEC" });
  await host.actions.tab({ tabId: "settings" });
  const section = nodes(host.lastView(), "section").find((s) => s.title === "Share with Viboplr Community");
  assert.ok(section);
  const toggle = () => nodes(host.lastView(), "toggle").find((t) => t.action === "toggle-share-waveforms");
  assert.equal(toggle().checked, true);
  await host.actions["toggle-share-waveforms"]({ value: false });
  assert.equal(host.storage.get("shareWaveforms"), false);
  assert.equal(toggle().checked, false);
  assert.equal(await host.waveformLookup(FACTS), null);
  assert.equal(calls().length, 0);
  plugin.deactivate();
});

test("an app without api.waveforms: activates fine and says the switch needs a newer Viboplr", async () => {
  const { plugin, host } = await setup({ session: SIGNED_IN, waveforms: false });
  assert.equal(host.api.waveforms, undefined);
  await host.actions.tab({ tabId: "settings" });
  assert.match(JSON.stringify(host.lastView()), /Sharing waveforms needs a newer Viboplr/);
  assert.equal(await host.waveformLookup(FACTS), null);
  plugin.deactivate();
});

// ---- read-only assistant tools ---------------------------------------------

const STATS = {
  copies: 3, members: 2,
  tiers: { hires: 1, lossless: 2, lossy: 1, unknown: 0 },
  codecs: [{ codec: "flac", copies: 2 }, { codec: "mp3", copies: 1 }],
  sampleRates: [{ sampleRate: 44100, copies: 2 }], bitDepths: [{ bitDepth: 16, copies: 2 }],
};

async function toolSetup(subject) {
  const plugin = loadPlugin();
  const route = (u) => {
    if (u.pathname === "/v1/subjects/resolve") return subject ? { body: { subject } } : { status: 404, body: { error: "not found" } };
    if (u.pathname === "/v1/formats") return { body: u.searchParams.get("subject") ? { ...STATS, subject: { id: subject.id } } : STATS };
    return undefined;
  };
  const host = makeHost({ route });
  host.storage.set("session", SIGNED_IN);
  await plugin.activate(host.api);
  return { plugin, host };
}

test("get_formats: global stats, and a song's by its subject — asked anonymously", async () => {
  const { plugin, host } = await toolSetup({ id: 42, kind: "track", name: "Jóga", waveforms: [] });
  assert.deepEqual(await host.tools.get_formats({}), STATS);
  const song = await host.tools.get_formats({ kind: "track", title: "Jóga", artistName: "Björk" });
  assert.equal(song.found, true);
  assert.equal(song.copies, 3);
  assert.ok(host.requests.some((r) => /\/v1\/formats\?subject=42/.test(r.url)));
  // Signed in, yet nothing carries the token: a question about a song isn't tied to the account.
  assert.ok(host.requests.every((r) => !((r.init && r.init.headers) || {}).Authorization));
  plugin.deactivate();
});

test("get_formats: unknown subject is found=false; bad input is a readable error", async () => {
  const { plugin, host } = await toolSetup(null);
  assert.deepEqual(await host.tools.get_formats({ kind: "album", name: "Homogenic", artistName: "Björk" }), { found: false, copies: 0 });
  await assert.rejects(async () => host.tools.get_formats({ kind: "playlist" }), /kind must be/);
  await assert.rejects(async () => host.tools.get_formats({ kind: "artist" }), /name is required/);
  await assert.rejects(async () => host.tools.get_formats({ kind: "track" }), /title is required/);
  plugin.deactivate();
});

test("has_waveform lists the shared versions without their peaks", async () => {
  const { plugin, host } = await toolSetup({
    id: 42, kind: "track", name: "Jóga",
    waveforms: [{ durationSecs: 305, peaks: "AAEC", sharedBy: "alice" }, { durationSecs: 412, peaks: "AAEC", sharedBy: null }],
  });
  const out = await host.tools.has_waveform({ title: "Jóga", artistName: "Björk" });
  assert.deepEqual(out, {
    title: "Jóga", artistName: "Björk", shared: true,
    waveforms: [{ durationSecs: 305, sharedBy: "alice" }, { durationSecs: 412, sharedBy: null }],
  });
  plugin.deactivate();
});

test("has_waveform: nothing on Community is shared=false", async () => {
  const { plugin, host } = await toolSetup(null);
  const out = await host.tools.has_waveform({ title: "Nowhere", artistName: "Nobody" });
  assert.equal(out.shared, false);
  assert.deepEqual(out.waveforms, []);
  plugin.deactivate();
});
