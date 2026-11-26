// my_likes: the member's own Community likes read back by name, and which of
// the liked songs this library lacks.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadPlugin } = require("./harness/sandbox");
const { makeHost } = require("./harness/host");

const SIGNED_IN = { token: "vcom_tok", user: { login: "alice" } };

function song(name, artistName, albumName, likedAt) {
  return { likedAt, albumName, subject: { id: likedAt, kind: "track", name, artistName, url: "https://community.viboplr.com/track/" + likedAt } };
}

// `likes` is the whole list the server holds, newest first; it pages it like
// GET /v1/me/likes does (offset + limit, hasMore, total).
async function setup(likes, { signedIn = true, findTrack = true } = {}) {
  const plugin = loadPlugin();
  const route = (u) => {
    if (u.pathname !== "/v1/me/likes") return undefined;
    const offset = Number(u.searchParams.get("offset") || 0);
    const limit = Number(u.searchParams.get("limit") || 100);
    const kind = u.searchParams.get("kind") || "track";
    const rating = u.searchParams.get("rating") || "like";
    const rows = kind !== "track" ? [] : likes.filter((l) => rating === "all" || (l.rating || "like") === rating);
    return { body: { likes: rows.slice(offset, offset + limit), hasMore: offset + limit < rows.length, total: rows.length } };
  };
  const host = makeHost({ route });
  if (!findTrack) delete host.api.library.findTrack;
  if (signedIn) host.storage.set("session", SIGNED_IN);
  await plugin.activate(host.api);
  return { plugin, host };
}

const LIKES = [
  song("Jóga", "Björk", "Homogenic", 30),
  song("Hunter", "Björk", "Homogenic", 20),
  song("Teardrop", "Massive Attack", "Mezzanine", 10),
];

test("my_likes lists the member's liked songs by name, each marked in the library or not", async () => {
  const { plugin, host } = await setup(LIKES);
  host.owned.add("bjork|joga"); // accents folded: the library has "Joga" by "Bjork"
  const out = await host.tools.my_likes({ limit: 2 });
  assert.equal(out.total, 3);
  assert.equal(out.hasMore, true);
  assert.deepEqual(out.likes.map((l) => [l.title, l.artistName, l.albumName, l.inLibrary]), [
    ["Jóga", "Björk", "Homogenic", true],
    ["Hunter", "Björk", "Homogenic", false],
  ]);
  // Asked with the token: these are the member's own.
  const req = host.requests.find((r) => /\/v1\/me\/likes/.test(r.url));
  assert.equal(req.init.headers.Authorization, "Bearer vcom_tok");
  // Any copy counts, so the album is never part of the lookup.
  assert.ok(host.findTrackCalls.every((c) => !("album" in c)));
  plugin.deactivate();
});

test("my_likes notInLibrary checks a window of likes per call and hands back a cursor for the rest", async () => {
  const many = [];
  for (let i = 0; i < 1203; i++) many.push(song("Song " + i, "Artist", null, 5000 - i));
  const { plugin, host } = await setup(many);
  for (let i = 0; i < 1203; i++) if (i % 3 !== 0) host.owned.add("artist|song " + i);
  const likeRequests = () => host.requests.filter((r) => /\/v1\/me\/likes/.test(r.url)).length;

  // The first 1000 likes, in two pages of 500: never the whole account in one call.
  const first = await host.tools.my_likes({ notInLibrary: true });
  assert.deepEqual([first.total, first.cursor, first.checked, first.missingCount, first.unknownCount], [1203, 0, 1000, 334, 0]);
  assert.deepEqual([first.hasMore, first.nextCursor], [true, 1000]);
  assert.equal(first.likes.length, 334);
  assert.ok(first.likes.every((l) => l.inLibrary === false));
  assert.equal(first.likes[0].title, "Song 0");
  assert.equal(likeRequests(), 2);
  assert.ok(host.findTrackCalls.length === 1000);

  // The rest, from the cursor; the end says so.
  const rest = await host.tools.my_likes({ notInLibrary: true, cursor: first.nextCursor });
  assert.deepEqual([rest.cursor, rest.checked, rest.missingCount, rest.hasMore, rest.nextCursor], [1000, 203, 67, false, null]);
  assert.equal(rest.likes[0].title, "Song 1002");
  plugin.deactivate();
});

test("my_likes: a limit, offset or cursor that isn't a whole number of at least 1 falls back", async () => {
  const { plugin, host } = await setup(LIKES);
  const out = await host.tools.my_likes({ limit: 0.5, offset: -3 });
  assert.equal(out.likes.length, 3, "limit 0.5 is not a page of nothing");
  assert.equal(out.offset, 0);
  assert.ok(host.requests.some((r) => /limit=100/.test(r.url)));
  const scan = await host.tools.my_likes({ notInLibrary: true, cursor: 0.4 });
  assert.equal(scan.cursor, 0);
  plugin.deactivate();
});

test("my_likes on an app without findTrack says it can't tell, and never calls those missing", async () => {
  const { plugin, host } = await setup(LIKES, { findTrack: false });
  const out = await host.tools.my_likes({});
  assert.ok(out.likes.every((l) => l.inLibrary === null));
  const missing = await host.tools.my_likes({ notInLibrary: true });
  assert.equal(missing.missingCount, 0);
  assert.equal(missing.unknownCount, 3);
  plugin.deactivate();
});

test("my_likes reads dislikes when asked, and notInLibrary scans likes only", async () => {
  const rated = [...LIKES, { ...song("Pluto", "Björk", "Homogenic", 5), rating: "dislike" }];
  const { plugin, host } = await setup(rated);
  const liked = await host.tools.my_likes({});
  assert.deepEqual(liked.likes.map((l) => [l.title, l.rating]), [["Jóga", "like"], ["Hunter", "like"], ["Teardrop", "like"]]);
  const disliked = await host.tools.my_likes({ rating: "dislike" });
  assert.deepEqual(disliked.likes.map((l) => [l.title, l.rating]), [["Pluto", "dislike"]]);
  assert.ok(host.requests.some((r) => /rating=dislike/.test(r.url)));
  assert.equal((await host.tools.my_likes({ rating: "all" })).total, 4);
  // The download list is liked songs: a disliked one you lack is not on it.
  const missing = await host.tools.my_likes({ notInLibrary: true });
  assert.ok(!missing.likes.some((l) => l.title === "Pluto"));
  await assert.rejects(async () => host.tools.my_likes({ notInLibrary: true, rating: "dislike" }), /liked songs only/);
  await assert.rejects(async () => host.tools.my_likes({ rating: "meh" }), /rating must be/);
  plugin.deactivate();
});

test("my_likes: signed out and bad input are readable errors", async () => {
  const { plugin, host } = await setup(LIKES, { signedIn: false });
  await assert.rejects(async () => host.tools.my_likes({}), /Not signed in/);
  plugin.deactivate();
  const signed = await setup(LIKES);
  await assert.rejects(async () => signed.host.tools.my_likes({ kind: "tag" }), /kind must be/);
  await assert.rejects(async () => signed.host.tools.my_likes({ kind: "album", notInLibrary: true }), /kind=track only/);
  const artists = await signed.host.tools.my_likes({ kind: "artist" });
  assert.deepEqual(artists.likes, []);
  signed.plugin.deactivate();
});
