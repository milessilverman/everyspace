import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { overtureBuildings, withOvertureFallback, createOvertureCache, clearOvertureCache, tileFileUrl, OVERTURE_CATALOG_URL, ATTRIBUTION_TEXT, ATTRIBUTION_HTML, ringsAreaFixup, datasetOf, buildingsFromTiles, MIN_AREA_M2 } from '../providers/overture-buildings.js';
import { tileId, parseDirectory, findEntry, decodeMvtLayer, decodePolygons, tilePointToLngLat, lngToTileX, latToTileY, createPmtilesReader, PmtilesError } from '../providers/pmtiles.js';
import { lariacBuildings } from '../providers/lariac-buildings.js';
import { ringsToGeoJSON } from '../parcel.js';
import { polygonAreaSqft, pointInPolygon } from '../geometry.js';

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/providers/${n}`, import.meta.url), 'utf8'));
const NOW = '2026-11-27T12:00:00Z';
const LATER = '2026-11-28T13:00:00Z'; // 25 hours on
const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };
const RELEASE = '2026-11-18.0';
const FILE = tileFileUrl(RELEASE);
const hang = (_u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));

// ---- a tiny vector-tile and PMTiles WRITER (test-only): the reader under test is the production code ----------------------------
const varint = (n) => { const o = []; while (n >= 128) { o.push((n % 128) | 128); n = Math.floor(n / 128); } o.push(n); return o; };
const zig = (n) => (n < 0 ? -2 * n - 1 : 2 * n);
const lenDelim = (field, bytes) => [...varint(field * 8 + 2), ...varint(bytes.length), ...bytes];
const str = (s) => [...new TextEncoder().encode(s)];
function encodeValue(v) {
  if (typeof v === 'string') return lenDelim(1, str(v));
  if (typeof v === 'boolean') return [...varint(7 * 8), v ? 1 : 0];
  const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v, true); return [...varint(3 * 8 + 1), ...b];
}
/** features: [{props, rings:[[x,y]...] (tile units, open rings), type?:3}] */
function encodeTile(features, { name = 'building', ext = 4096 } = {}) {
  const keys = [], vals = [], keyIx = new Map(), valIx = new Map();
  const feats = features.map((f) => {
    const tags = [];
    for (const [k, v] of Object.entries(f.props ?? {})) {
      if (v === null || v === undefined) continue;
      if (!keyIx.has(k)) { keyIx.set(k, keys.length); keys.push(k); }
      const vk = `${typeof v}:${v}`;
      if (!valIx.has(vk)) { valIx.set(vk, vals.length); vals.push(v); }
      tags.push(keyIx.get(k), valIx.get(vk));
    }
    const geom = []; let x = 0, y = 0;
    for (const R of f.rings) {
      geom.push(...varint((1 << 3) | 1), ...varint(zig(R[0][0] - x)), ...varint(zig(R[0][1] - y))); [x, y] = R[0];
      geom.push(...varint(((R.length - 1) << 3) | 2));
      for (const p of R.slice(1)) { geom.push(...varint(zig(p[0] - x)), ...varint(zig(p[1] - y))); [x, y] = p; }
      geom.push(...varint((1 << 3) | 7));
    }
    return [...lenDelim(2, tags.flatMap((t) => varint(t))), ...varint(3 * 8), f.type ?? 3, ...lenDelim(4, geom)];
  });
  const layer = [...lenDelim(1, str(name)), ...feats.flatMap((f) => lenDelim(2, f)), ...keys.flatMap((k) => lenDelim(3, str(k))), ...vals.flatMap((v) => lenDelim(4, encodeValue(v))), ...varint(5 * 8), ...varint(ext), ...varint(15 * 8), 2];
  return new Uint8Array(lenDelim(3, layer));
}
const concat = (...a) => { const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
function encodeDir(entries) { // entries sorted by id: {id, off, len, run}
  const o = [...varint(entries.length)]; let last = 0;
  for (const e of entries) { o.push(...varint(e.id - last)); last = e.id; }
  for (const e of entries) o.push(...varint(e.run));
  for (const e of entries) o.push(...varint(e.len));
  entries.forEach((e, i) => o.push(...varint(i > 0 && e.off === entries[i - 1].off + entries[i - 1].len ? 0 : e.off + 1)));
  return new Uint8Array(o);
}
/** A whole synthetic PMTiles v3 file: tiles = [{z,x,y,bytes}] (raw vector tiles, gzipped here). */
function buildPmtiles(tiles, { maxz = 14, ic = 2, tc = 2 } = {}) {
  const comp = (b, c) => (c === 2 ? new Uint8Array(gzipSync(b)) : b);
  const items = tiles.map((t) => ({ id: tileId(t.z, t.x, t.y), data: comp(t.bytes, tc) })).sort((a, b) => a.id - b.id);
  let off = 0; const entries = [];
  for (const it of items) { entries.push({ id: it.id, off, len: it.data.length, run: 1 }); off += it.data.length; }
  const root = comp(encodeDir(entries), ic);
  const h = new Uint8Array(127); h.set(str('PMTiles')); h[7] = 3;
  const dv = new DataView(h.buffer);
  const u64 = (o, v) => dv.setBigUint64(o, BigInt(v), true);
  u64(8, 127); u64(16, root.length); u64(40, 0); u64(48, 0); u64(56, 127 + root.length); u64(64, off);
  h[97] = ic; h[98] = tc; h[99] = 1; h[100] = 0; h[101] = maxz;
  return concat(h, root, ...items.map((i) => i.data));
}
const resp = (bytes, status = 206) => new Response(bytes, { status });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
/** Serves the catalog and a file by Range. `file` is a Uint8Array, or a function(rangeString)->Response|Uint8Array|undefined. */
function world({ file, catalog = () => json({ latest: RELEASE }), url = FILE } = {}) {
  const calls = [];
  const f = async (u, init = {}) => {
    u = String(u);
    const range = init.headers?.Range ?? null;
    calls.push({ url: u, range });
    if (u === OVERTURE_CATALOG_URL) return catalog();
    if (u === url) {
      if (typeof file === 'function') { const r = await file(range, u); return r instanceof Response ? r : r ? resp(r) : new Response('missing', { status: 404 }); }
      const m = /^bytes=(\d+)-(\d+)$/.exec(range ?? '');
      if (!m) return new Response(file, { status: 200 });
      return resp(file.subarray(Number(m[1]), Math.min(Number(m[2]) + 1, file.length)));
    }
    return new Response('not found', { status: 404 });
  };
  f.calls = calls;
  f.fileCalls = () => calls.filter((c) => c.url !== OVERTURE_CATALOG_URL);
  f.catalogCalls = () => calls.filter((c) => c.url === OVERTURE_CATALOG_URL).length;
  return f;
}
const deps = (fetch, extra = {}) => ({ fetch, now: NOW, overtureCache: createOvertureCache(), ...extra });

// geometry helpers: lng/lat <-> tile units at z14
const Z = 14;
const toTile = (x, y, lng, lat, ext = 4096) => {
  const n = 2 ** Z, s = Math.sin((lat * Math.PI) / 180);
  return [Math.round(((lng + 180) / 360 * n - x) * ext), Math.round(((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n - y) * ext)];
};
/** A rectangle centred on lng/lat, w x h metres, as an open ring of tile units (outer ring winding: as given by `rev`). */
function rect(x, y, lng, lat, wM, hM, rev = false) {
  const dLng = wM / 2 / (111320 * Math.cos((lat * Math.PI) / 180)), dLat = hM / 2 / 110540;
  const r = [[lng - dLng, lat - dLat], [lng + dLng, lat - dLat], [lng + dLng, lat + dLat], [lng - dLng, lat + dLat]].map(([a, b]) => toTile(x, y, a, b));
  return rev ? r.reverse() : r;
}
// a synthetic neighbourhood in Phoenix-ish coordinates (no real building is meant)
const P0 = { lat: 33.4500, lng: -112.0700 };
const TX = lngToTileX(P0.lng, Z), TY = latToTileY(P0.lat, Z);
const parcelAround = (lng, lat, wM, hM) => {
  const dLng = wM / 2 / (111320 * Math.cos((lat * Math.PI) / 180)), dLat = hM / 2 / 110540;
  return { type: 'Polygon', coordinates: [[[lng - dLng, lat - dLat], [lng + dLng, lat - dLat], [lng + dLng, lat + dLat], [lng - dLng, lat + dLat], [lng - dLng, lat - dLat]]] };
};
const feat = (props, rings) => ({ props, rings, type: 3 });
const SYN_PARCEL = parcelAround(P0.lng, P0.lat, 60, 50);
const synFile = (features, tiles = []) => buildPmtiles([{ z: Z, x: TX, y: TY, bytes: encodeTile(features) }, ...tiles]);
const lk = (q, d) => overtureBuildings.lookup(q, d);
const near = (a, b, pct) => Math.abs(a - b) / b * 100 <= pct;

// ---- pure pieces ---------------------------------------------------------------------------------------------------------------
test('tileId: matches the PMTiles Hilbert numbering (z0=0, z1 = 1..4, z2 starts at 5)', () => {
  assert.equal(tileId(0, 0, 0), 0);
  assert.deepEqual([[0, 0], [0, 1], [1, 1], [1, 0]].map(([x, y]) => tileId(1, x, y)), [1, 2, 3, 4]);
  assert.equal(tileId(2, 0, 0), 5);
  assert.equal(new Set(Array.from({ length: 16 }, (_, i) => tileId(2, i % 4, Math.floor(i / 4)))).size, 16);
});

test('parseDirectory/findEntry: tile runs, leaf pointers (run 0) and the gap between them', () => {
  const E = parseDirectory(encodeDir([{ id: 5, off: 0, len: 10, run: 1 }, { id: 9, off: 10, len: 7, run: 3 }, { id: 20, off: 99, len: 4, run: 0 }]));
  assert.deepEqual(E, [{ id: 5, run: 1, len: 10, off: 0 }, { id: 9, run: 3, len: 7, off: 10 }, { id: 20, run: 0, len: 4, off: 99 }]);
  assert.equal(findEntry(E, 5).off, 0);
  assert.equal(findEntry(E, 10).id, 9, 'inside a run');
  assert.equal(findEntry(E, 12), null, 'just past a run');
  assert.equal(findEntry(E, 4), null);
  assert.equal(findEntry(E, 25).run, 0, 'a leaf pointer covers every id after it');
  assert.throws(() => parseDirectory(new Uint8Array([200])), PmtilesError);
});

test('decodeMvtLayer/decodePolygons: round trip, holes by winding, other layers ignored', () => {
  const outer = [[10, 10], [110, 10], [110, 110], [10, 110]], hole = [[40, 40], [40, 80], [80, 80], [80, 40]];
  const bytes = encodeTile([feat({ id: 'a', class: 'house', height: 7.5, flag: true }, [outer, hole])]);
  const L = decodeMvtLayer(bytes, 'building');
  assert.equal(L.ext, 4096); assert.equal(L.features.length, 1);
  assert.deepEqual(L.features[0].props, { id: 'a', class: 'house', height: 7.5, flag: true });
  const polys = decodePolygons(L.features[0].rings);
  assert.equal(polys.length, 1); assert.equal(polys[0].length, 2, 'outer ring plus one hole');
  assert.equal(decodeMvtLayer(bytes, 'water'), null);
  assert.deepEqual(decodePolygons([[[0, 0], [1, 1]]]), [], 'a 2-point ring is not a polygon');
  const [lng, lat] = tilePointToLngLat(14, 2810, 6541, 4096, [0, 0]);
  assert.equal(lngToTileX(lng + 1e-9, 14), 2810); assert.equal(latToTileY(lat - 1e-9, 14), 6541);
});

test('ringsAreaFixup: closes rings, outer counter-clockwise, hole clockwise', () => {
  const [o, h] = ringsAreaFixup([[[0, 0], [0, 1], [1, 1], [1, 0]], [[0.2, 0.2], [0.4, 0.2], [0.4, 0.4], [0.2, 0.4]]]);
  assert.deepEqual(o[0], o.at(-1)); assert.deepEqual(h[0], h.at(-1));
  const ccw = (r) => r.reduce((s, p, i) => { const q = r[(i + 1) % r.length]; return s + (p[0] * q[1] - q[0] * p[1]); }, 0) > 0;
  assert.equal(ccw(o), true); assert.equal(ccw(h), false);
});

test('datasetOf: the flattened geometry source, a sources JSON string, or null', () => {
  assert.equal(datasetOf({ '@geometry_source': 'Microsoft ML Buildings' }), 'Microsoft ML Buildings');
  assert.equal(datasetOf({ sources: JSON.stringify([{ dataset: 'OpenStreetMap' }]) }), 'OpenStreetMap');
  assert.equal(datasetOf({ sources: 'not json' }), null);
  assert.equal(datasetOf({}), null);
});

test('tile file url and the attribution texts are exactly StreetForge\'s', () => {
  assert.equal(tileFileUrl('2026-11-18.0'), 'https://overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com/tiles/2026-11-18.0/buildings.pmtiles');
  assert.equal(ATTRIBUTION_TEXT, 'Drafted buildings: Overture Maps Foundation (ODbL)');
  assert.equal(ATTRIBUTION_HTML, 'Drafted buildings: <a href="https://overturemaps.org" target="_blank" rel="noopener">Overture Maps Foundation</a> (ODbL)');
  assert.match(overtureBuildings.licenseNote, /ODbL/);
  assert.deepEqual([overtureBuildings.id, overtureBuildings.kind, overtureBuildings.needsKey, overtureBuildings.coverage], ['overture-buildings', 'footprint', false, { national: true, exceptCountyFips: ['06037'] }]);
});

// ---- REAL recorded data: Los Angeles City Hall and Chicago City Hall ---------------------------------------------------------------
const REAL = fx('overture-city-halls.json');
const b64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
/** Serve the recorded header/root and leaf bytes (real) and re-encoded tiles holding the real decoded features. */
function realWorld(c, over = {}) {
  const map = new Map([[c.header.range, b64(c.header.b64)], [c.leaf.range, b64(c.leaf.b64)]]);
  for (const t of c.tiles) map.set(t.range, new Uint8Array(gzipSync(encodeTile(t.features, { ext: t.ext }))));
  return world({ file: (range) => over[range] ?? map.get(range), catalog: () => json(REAL.catalog) });
}
const laParcel = () => ringsToGeoJSON(fx('la-assessor-situs-200-n-spring.json').features[0].geometry.rings);

test('REAL: Los Angeles City Hall on its parcel; area within 1% of LARIAC; attribution, release, height, dataset; request cost', async () => {
  const f = realWorld(REAL.la);
  const r = await lk({ ...REAL.la.point, parcel: laParcel() }, deps(f));
  assert.equal(r.ok, true);
  const main = r.buildings[0];
  assert.equal(main.id, REAL.la.expectedMainId); assert.equal(main.kind, 'civic'); assert.equal(main.dataset, 'OpenStreetMap');
  assert.equal(main.heightFt, 65.6, 'height 20 m (the building part, not the tower)'); assert.equal(main.floors, undefined, 'no floor count in the data: no key at all');
  assert.equal(main.onParcel, true); assert.equal(main.name, 'Los Angeles City Hall');
  assert.ok(near(main.areaSqft, polygonAreaSqft(main.polygon), 0.01), 'areaSqft is computed from the geometry');
  // LARIAC on the same parcel (recorded live): its largest building is the 2020 City Hall outline
  const lf = async (u) => new Response(JSON.stringify(fx('lariac-buildings-200-n-spring.json')), { status: 200 });
  const L = await lariacBuildings.lookup({ lat: REAL.la.point.lat, lng: REAL.la.point.lng, parcel: laParcel() }, { fetch: lf, now: NOW });
  const lMain = Math.max(...L.buildings.map((b) => b.areaSqft));
  const diffPct = Math.abs(main.areaSqft - lMain) / lMain * 100;
  assert.ok(diffPct < 1, `Overture ${main.areaSqft} vs LARIAC ${lMain}: ${diffPct.toFixed(2)}%`);
  assert.equal(r.attribution, ATTRIBUTION_TEXT); assert.equal(r.counts.release, RELEASE); assert.match(r.license, /ODbL/);
  // cost: catalog + header/root + leaf + two z14 tiles (the box crosses a tile edge) = 5 requests
  assert.equal(r.counts.requests, 5); assert.equal(r.counts.tiles, 2);
  assert.deepEqual(f.fileCalls().map((c) => c.range), [REAL.la.header.range, REAL.la.leaf.range, ...REAL.la.tiles.map((t) => t.range)]);
  assert.ok(f.fileCalls().every((c) => /^bytes=\d+-\d+$/.test(c.range)), 'only range requests, never the whole file');
  assert.equal(r.counts.skippedClass, 4, 'the recorded roof/carport/shelter features (2 per tile) are skipped');
});

test('REAL: Chicago City Hall by point, outside California: names, floors, heights, only the building under the point is onParcel', async () => {
  const f = realWorld(REAL.chicago);
  const r = await lk({ ...REAL.chicago.point, radiusM: REAL.chicago.radiusM }, deps(f));
  assert.equal(r.ok, true);
  const hall = r.buildings.find((b) => b.name === 'Chicago City Hall');
  assert.ok(hall && hall.areaSqft > 40000 && hall.areaSqft < 52000, `City Hall ${hall?.areaSqft}`);
  for (const b of r.buildings) assert.equal(b.onParcel, pointInPolygon(REAL.chicago.point, b.polygon), `${b.name}: onParcel means the building contains the point`);
  assert.equal(hall.kind, 'public');
  const tower = r.buildings.find((b) => b.name === '120 North LaSalle');
  assert.equal(tower.floors, 39); assert.ok(near(tower.heightFt, 502, 1));
  assert.equal(r.counts.requests, 4, 'catalog + header + leaf + one tile');
});

test('REAL: a second lookup in the same cache costs only tile requests; a day later the catalog is read again', async () => {
  const f = realWorld(REAL.la);
  const cache = createOvertureCache();
  const q = { ...REAL.la.point, parcel: laParcel() };
  await lk(q, { fetch: f, now: NOW, overtureCache: cache });
  const before = f.calls.length;
  const r2 = await lk(q, { fetch: f, now: '2026-11-27T20:00:00Z', overtureCache: cache });
  assert.equal(r2.ok, true);
  assert.equal(f.calls.length - before, 2, 'two tiles only: no catalog, header or leaf');
  assert.equal(r2.counts.requests, 2);
  await lk(q, { fetch: f, now: LATER, overtureCache: cache });
  assert.equal(f.catalogCalls(), 2, 'the catalog is asked again after a day');
});

test('module-level memo works without an injected cache, and clearOvertureCache forgets it', async () => {
  clearOvertureCache();
  const f = realWorld(REAL.chicago);
  const q = { ...REAL.chicago.point, radiusM: 60 };
  await lk(q, { fetch: f, now: NOW });
  await lk(q, { fetch: f, now: NOW });
  assert.equal(f.catalogCalls(), 1);
  clearOvertureCache();
  await lk(q, { fetch: f, now: NOW });
  assert.equal(f.catalogCalls(), 2);
  clearOvertureCache();
});

// ---- failure modes -------------------------------------------------------------------------------------------------------------
test('failure: catalog unreachable (HTTP 500, network error, bad JSON, no release name, timeout)', async () => {
  const q = { ...REAL.chicago.point };
  const cases = [
    [() => new Response('x', { status: 500 }), /HTTP 500/],
    [() => { throw new Error('ECONNRESET'); }, /ECONNRESET/],
    [() => new Response('<html>', { status: 200 }), /not valid JSON/],
    [() => json({ latest: 'nightly' }), /no usable current release/],
    [() => json({}), /no usable current release/],
  ];
  for (const [catalog, re] of cases) {
    const r = await lk(q, deps(world({ file: new Uint8Array(1), catalog })));
    assert.equal(r.ok, false); assert.equal(r.code, 'catalog_unreachable'); assert.match(r.reason, re);
  }
  const t = await lk(q, deps(world({ catalog: () => new Promise(() => {}) }), { timeoutMs: 20 }));
  assert.equal(t.code, 'timeout');
  const hungFetch = async (u, init) => hang(u, init);
  assert.equal((await lk(q, deps(hungFetch, { timeoutMs: 20 }))).code, 'timeout');
});

test('failure: the buildings file is gone (404) -> a remembered release is refreshed once; a fresh one is not retried', async () => {
  const f = realWorld(REAL.chicago);
  const cache = createOvertureCache();
  cache.release = { release: '2026-01-01.0', atMs: Date.parse(NOW) - 3600e3 }; // a release Overture has since deleted
  const r = await lk({ ...REAL.chicago.point, radiusM: 60 }, { fetch: f, now: NOW, overtureCache: cache });
  assert.equal(r.ok, true); assert.equal(r.counts.release, RELEASE);
  assert.equal(f.calls[0].url, tileFileUrl('2026-01-01.0')); assert.equal(f.catalogCalls(), 1);
  const gone = world({ file: () => new Response('no', { status: 404 }), catalog: () => json(REAL.catalog) });
  const r2 = await lk({ ...REAL.chicago.point }, deps(gone));
  assert.equal(r2.ok, false); assert.equal(r2.code, 'http_error'); assert.match(r2.reason, /HTTP 404/);
  assert.equal(gone.fileCalls().length, 1, 'a release read from the catalog this very call is not retried');
});

test('failure: not a PMTiles file; unsupported compression; the server ignores Range (200) is refused, not downloaded', async () => {
  const q = { ...P0 };
  const junk = new Uint8Array(200).fill(7);
  assert.equal((await lk(q, deps(world({ file: junk })))).code, 'decode_error');
  const brotli = buildPmtiles([{ z: Z, x: TX, y: TY, bytes: encodeTile([]) }]); brotli[98] = 3; // tile compression 3 = brotli
  const rb = await lk(q, deps(world({ file: brotli })));
  assert.equal(rb.ok, false); assert.equal(rb.code, 'unsupported'); assert.match(rb.reason, /compression type 3/);
  let cancelled = false;
  const r200 = await lk(q, deps(world({ file: () => { const r = new Response('whole file'); Object.defineProperty(r, 'body', { value: { cancel: async () => { cancelled = true; } } }); return r; } })));
  assert.equal(r200.code, 'unsupported'); assert.match(r200.reason, /ignored the Range header/); assert.equal(cancelled, true);
});

test('failure: tile request errors (HTTP 500, network, timeout) and tile decode errors (bad gzip, truncated vector tile)', async () => {
  const good = synFile([feat({ id: 'a', class: 'house' }, [rect(TX, TY, P0.lng, P0.lat, 30, 20)])]);
  const header = good.subarray(0, 127), tileStart = Number(new DataView(good.buffer, good.byteOffset).getBigUint64(56, true));
  const mk = (tileResp) => world({ file: (range) => { const m = /^bytes=(\d+)-(\d+)$/.exec(range); return Number(m[1]) >= tileStart ? tileResp(range) : good.subarray(Number(m[1]), Number(m[2]) + 1); } });
  const q = { ...P0, parcel: SYN_PARCEL };
  const e500 = await lk(q, deps(mk(() => new Response('x', { status: 500 })))); assert.deepEqual([e500.ok, e500.code], [false, 'http_error']);
  const eNet = await lk(q, deps(mk(() => { throw new Error('socket hang up'); }))); assert.deepEqual([eNet.ok, eNet.code], [false, 'network']); assert.match(eNet.reason, /socket hang up/);
  const eTime = await lk(q, deps(mk((_r) => new Promise(() => {})), { timeoutMs: 25 })); assert.deepEqual([eTime.ok, eTime.code], [false, 'timeout']);
  const eGz = await lk(q, deps(mk(() => resp(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))))); assert.deepEqual([eGz.ok, eGz.code], [false, 'decode_error']); assert.match(eGz.reason, /gzip/);
  const trunc = new Uint8Array(gzipSync(encodeTile([feat({ id: 'a' }, [rect(TX, TY, P0.lng, P0.lat, 30, 20)])]).subarray(0, 25)));
  const eMvt = await lk(q, deps(mk(() => resp(trunc)))); assert.deepEqual([eMvt.ok, eMvt.code], [false, 'decode_error']); assert.match(eMvt.reason, /could not decode tile/);
  assert.equal(header.length, 127);
});

test('tile missing from the file = no buildings there (ok, empty, counted, with a note), not an error', async () => {
  const f = world({ file: synFile([feat({ id: 'a' }, [rect(TX, TY, P0.lng, P0.lat, 30, 20)])]) });
  const far = { lat: 33.9, lng: -111.0 }; // a tile the file does not hold
  const r = await lk({ ...far, radiusM: 40 }, deps(f));
  assert.equal(r.ok, true); assert.deepEqual(r.buildings, []); assert.equal(r.counts.tilesMissing, 1); assert.equal(r.counts.tiles, 0);
  assert.match(r.note, /no Overture building near this point/);
});

test('no building on the parcel -> ok with an empty list and a note (a vacant lot); the neighbour is counted, not returned', async () => {
  const neighbour = feat({ id: 'n1', class: 'house' }, [rect(TX, TY, P0.lng + 0.0004, P0.lat, 20, 20)]);
  const f = world({ file: synFile([neighbour]) });
  const r = await lk({ ...P0, parcel: SYN_PARCEL }, deps(f));
  assert.equal(r.ok, true); assert.deepEqual(r.buildings, []); assert.equal(r.counts.outsideParcel, 1);
  assert.match(r.note, /no Overture building lies on this parcel/);
  const withNear = await lk({ ...P0, parcel: parcelAround(P0.lng - 0.0004, P0.lat, 30, 30), includeNear: true, nearM: 80 }, deps(f));
  assert.equal(withNear.buildings.length, 1, JSON.stringify(withNear.counts)); assert.equal(withNear.buildings[0].onParcel, false); assert.equal(withNear.counts.near, 1);
});

// ---- filters and properties (synthetic tile: documented) -----------------------------------------------------------------------
test('filters: roof/carport/shelter classes, underground, specks under 8 m2 are dropped; a 30x20 m house and a holed courtyard building are kept with true areas', () => {
  const c = (x, y, lng, lat, w, h, rev) => rect(x, y, lng, lat, w, h, rev);
  const house = feat({ id: 'h', class: 'house', subtype: 'residential', height: 6.5, num_floors: 2, '@geometry_source': 'Microsoft ML Buildings' }, [c(TX, TY, P0.lng, P0.lat, 30, 20)]);
  const outer = c(TX, TY, P0.lng, P0.lat, 40, 40), hole = c(TX, TY, P0.lng, P0.lat, 10, 10, true);
  const court = feat({ id: 'c', class: 'commercial' }, [outer, hole]);
  const skipped = ['roof', 'carport', 'shelter'].map((k) => feat({ id: `s-${k}`, class: k }, [c(TX, TY, P0.lng, P0.lat, 20, 20)]));
  const under = feat({ id: 'u', class: 'house', is_underground: true }, [c(TX, TY, P0.lng, P0.lat, 20, 20)]);
  const speck = feat({ id: 'sp', class: 'shed' }, [c(TX, TY, P0.lng, P0.lat, 2, 2)]);
  const point = { props: { id: 'pt' }, rings: [], type: 1 };
  const layer = decodeMvtLayer(encodeTile([house, court, ...skipped, under, speck, point]), 'building');
  const box = { w: P0.lng - 0.01, e: P0.lng + 0.01, s: P0.lat - 0.01, n: P0.lat + 0.01 };
  const { buildings, counts } = buildingsFromTiles([{ z: Z, x: TX, y: TY, layer }], box);
  assert.deepEqual(buildings.map((b) => b.id).sort(), ['c', 'h']);
  assert.deepEqual([counts.skippedClass, counts.underground, counts.speck, counts.notPolygon], [3, 1, 1, 1]);
  const h = buildings.find((b) => b.id === 'h'), cc = buildings.find((b) => b.id === 'c');
  assert.ok(near(h.areaSqft / 10.7639, 600, 8), `house ${h.areaSqft / 10.7639} m2`);
  assert.ok(near(cc.areaSqft / 10.7639, 1500, 8), `courtyard building ${cc.areaSqft / 10.7639} m2 (1600 minus a 100 m2 hole)`);
  assert.equal(cc.polygon.coordinates.length, 2, 'the hole is kept');
  assert.equal(MIN_AREA_M2, 8);
});

test('properties: height in metres -> feet, floors only when a positive number, no zero or guessed values, source dataset recorded', async () => {
  const mk = (id, props, dx) => feat({ id, class: 'house', ...props }, [rect(TX, TY, P0.lng + dx, P0.lat, 20, 14)]);
  const f = world({ file: synFile([mk('a', { height: 10, num_floors: 3, '@geometry_source': 'OpenStreetMap' }, 0), mk('b', { height: 0, num_floors: 0 }, 0.0002), mk('c', { height: '12', num_floors: '2' }, 0.0004), mk('d', {}, 0.0006)]) });
  const r = await lk({ ...P0, radiusM: 120 }, deps(f));
  const by = Object.fromEntries(r.buildings.map((b) => [b.id, b]));
  assert.equal(by.a.heightFt, 32.8); assert.equal(by.a.floors, 3); assert.equal(by.a.dataset, 'OpenStreetMap');
  for (const k of ['b', 'c', 'd']) { assert.equal('heightFt' in by[k], false, `${k}: no height key`); assert.equal('floors' in by[k], false, `${k}: no floors key`); }
  assert.equal(by.d.dataset, null);
});

test('a building cut by a tile edge: the largest piece, partial:true; identical duplicates (tile buffers) are not partial', () => {
  const x1 = TX + 1;
  const big = feat({ id: 'cut' }, [rect(TX, TY, P0.lng, P0.lat, 30, 20)]);
  const piece = feat({ id: 'cut' }, [rect(x1, TY, P0.lng, P0.lat, 10, 20)]); // the neighbour tile holds only a clipped piece of the same id
  const dupA = feat({ id: 'dup' }, [rect(TX, TY, P0.lng + 0.0003, P0.lat, 20, 20)]);
  const dupB = feat({ id: 'dup' }, [rect(x1, TY, P0.lng + 0.0003, P0.lat, 20, 20)]);
  const tiles = [[TX, [big, dupA]], [x1, [piece, dupB]]].map(([x, fs]) => ({ z: Z, x, y: TY, layer: decodeMvtLayer(encodeTile(fs), 'building') }));
  const { buildings } = buildingsFromTiles(tiles, { w: -180, e: 180, s: -90, n: 90 });
  const cut = buildings.find((b) => b.id === 'cut'), dup = buildings.find((b) => b.id === 'dup');
  assert.equal(cut.partial, true); assert.equal(cut.fragments, 2); assert.ok(cut.areaSqft / 10.7639 > 400, 'the largest piece, not the sum');
  assert.equal(dup.partial, false);
});

test('an area spanning more than 9 tiles is refused (bad_query) before any tile is read', async () => {
  const f = world({ file: synFile([]) });
  const r = await lk({ lat: 33.45, lng: -112.07, radiusM: 20000 }, deps(f));
  assert.equal(r.ok, false); assert.equal(r.code, 'bad_query'); assert.match(r.reason, /too many map tiles/);
  assert.equal(f.fileCalls().length, 1, 'only header/root and nothing else (no tile fetched)');
});

test('bad input: no lat/lng, no fetch, no injected now', async () => {
  const f = world({ file: synFile([]) });
  assert.equal((await lk({}, deps(f))).code, 'bad_query');
  assert.equal((await lk({ lat: NaN, lng: 1 }, deps(f))).code, 'bad_query');
  assert.equal((await lk({ ...P0 }, { now: NOW })).code, 'no_fetch');
  const noNow = await lk({ ...P0 }, { fetch: f });
  assert.equal(noNow.ok, false); assert.equal(noNow.code, 'bad_query'); assert.match(noNow.reason, /now/);
  assert.equal(f.calls.length, 0, 'nothing was requested');
});

test('deterministic and no mutation: frozen inputs, two runs with fresh caches give deep-equal results', async () => {
  const q = deepFreeze({ ...REAL.la.point, parcel: laParcel() });
  const a = await lk(q, deps(realWorld(REAL.la)));
  const b = await lk(q, deps(realWorld(REAL.la)));
  assert.deepEqual(a, b);
  assert.equal(a.retrievedAt, NOW);
  assert.deepEqual(q.parcel, laParcel(), 'the parcel was not touched');
});

// ---- the LARIAC wrapper: Overture only when LARIAC finds nothing or fails ------------------------------------------------------------
test('withOvertureFallback: LARIAC answers -> Overture is never asked; LARIAC empty or failing -> Overture answers and says so; both empty -> the primary\'s own result', async () => {
  const mkPrimary = (result) => ({ ...lariacBuildings, lookup: async () => result });
  const hit = { ok: true, buildings: [{ polygon: {}, areaSqft: 1 }], source: 'LARIAC' };
  const empty = { ok: true, buildings: [], source: 'LARIAC' };
  const failed = { ok: false, reason: 'HTTP 500', code: 'server_error' };
  const q = { ...REAL.chicago.point, radiusM: 60 };
  const f1 = realWorld(REAL.chicago);
  assert.equal(await withOvertureFallback(mkPrimary(hit)).lookup(q, deps(f1)), hit);
  assert.equal(f1.calls.length, 0, 'Overture was not asked');
  for (const [primary, why] of [[empty, /found no building on the parcel/], [failed, /failed: HTTP 500/]]) {
    const f = realWorld(REAL.chicago);
    const w = withOvertureFallback(mkPrimary(primary));
    const r = await w.lookup(q, deps(f));
    assert.equal(r.ok, true); assert.ok(r.buildings.length > 0); assert.match(r.source, /Overture/); assert.equal(r.fallbackFrom, 'lariac-buildings'); assert.match(r.fallbackReason, why); assert.match(r.warnings.at(-1), /Overture Maps instead/);
    assert.deepEqual([w.id, w.kind, w.coverage], ['lariac-buildings', 'footprint', lariacBuildings.coverage]);
    assert.match(w.licenseNote, /Overture Maps buildings \(ODbL/);
  }
  const none = withOvertureFallback(mkPrimary(empty));
  const fz = world({ file: synFile([]) });
  assert.equal(await none.lookup({ ...P0, radiusM: 40 }, deps(fz)), empty, 'Overture found nothing either: the primary result is returned as is');
  assert.equal(await withOvertureFallback(mkPrimary(failed)).lookup({ ...P0, radiusM: 40 }, deps(world({ catalog: () => new Response('x', { status: 500 }) }))), failed, 'both failed: the primary failure');
});
