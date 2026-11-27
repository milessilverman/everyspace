// Tests for the yard work (2026-11-27, AERIAL): road lines, street reference and front edge, estimated lot, aerial reading, NAIP provider,
// remodeled year, usable yard, geometry bundle + measureFromGeometry, and the builder's parallel wiring. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifySegment, streetsFromTiles, overtureRoads } from '../providers/overture-roads.js';
import { clearOvertureCache } from '../providers/overture-buildings.js';
import { sameStreet, streetReference, addressStreet } from '../street-ref.js';
import { splitYard, yardZoneAt } from '../yard.js';
import { estimateLot, polygonIoU } from '../lot-estimate.js';
import { classifyPixel, classifyLot, CLASS, parseNpy, imageFromPlanes, pixelToLngLat, lngLatToPixel, pixelAreaM2 } from '../aerial.js';
import { naipAerial, flightsFrom, imageBox, displayImage } from '../providers/naip-aerial.js';
import { remodeledYear, fieldsFromParcel } from '../providers/la-assessor.js';
import { usableYard, openByDisc } from '../usable-yard.js';
import { measureFromGeometry, footprintAreaSqft } from '../measure.js';
import { buildPropertyProfile, toSourcedProfile } from '../property-profile.js';
import { createRegistry } from '../providers/registry.js';
import { polygonAreaSqft } from '../geometry.js';
import { sourced, unavailable } from '../provenance.js';

const NOW = '2026-11-27T12:00:00Z';
const LAT0 = 34, LNG0 = -118, FT = 0.3048, R = 6371008.8, RAD = Math.PI / 180;
const KX = R * Math.cos(LAT0 * RAD) * RAD, KY = R * RAD;
/** feet east/north of the origin -> [lng, lat] */
const P = (x, y) => [LNG0 + (x * FT) / KX, LAT0 + (y * FT) / KY];
const rect = (a, b, c, d) => ({ type: 'Polygon', coordinates: [[P(a, b), P(c, b), P(c, d), P(a, d), P(a, b)]] });
const line = (...pts) => ({ type: 'LineString', coordinates: pts.map(([x, y]) => P(x, y)) });
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b} (±${tol})`);

// ---------------------------------------------------------------- Stage 1: road lines
const CH = JSON.parse(readFileSync(new URL('./fixtures/providers/overture-roads-city-hall.json', import.meta.url), 'utf8'));

test('overture-roads: StreetForge filters (footpaths, sidewalks, steps, driveways, parking aisles, motorways, rail, links dropped; alleys kept and flagged)', () => {
  const k = (p) => classifySegment({ subtype: 'road', ...p });
  assert.equal(k({ class: 'footway', subclass: 'sidewalk' }).keep, false);
  assert.equal(k({ class: 'steps' }).keep, false);
  assert.equal(k({ class: 'service', subclass: 'driveway' }).keep, false);
  assert.equal(k({ class: 'service', subclass: 'parking_aisle', '@name': 'X' }).keep, false);
  assert.equal(k({ class: 'service' }).keep, false, 'unnamed service road');
  assert.deepEqual(k({ class: 'service', subclass: 'alley' }), { keep: true, alley: true, kind: 'alley' });
  assert.equal(k({ class: 'motorway' }).keep, false); assert.equal(k({ class: 'primary', subclass: 'link' }).keep, false);
  assert.equal(classifySegment({ subtype: 'rail', class: 'light_rail' }).keep, false);
  assert.equal(k({ class: 'residential' }).keep, true); assert.equal(k({ class: 'unknown' }).keep, false); assert.equal(k({ class: 'unknown', '@name': 'A St' }).keep, true);
  assert.equal(k({ class: 'primary', road_flags: '[{"values":["is_tunnel"]}]' }).keep, false, 'a whole tunnel');
});

test('overture-roads: real recorded tile features at LA City Hall -> the named streets around it, nearest first, no footpaths', () => {
  const r = streetsFromTiles([{ z: CH.z, x: CH.x, y: CH.y, layer: { ext: CH.ext, features: CH.features } }], CH.point, 100);
  const names = new Set(r.streets.map((s) => s.name));
  for (const n of ['North Spring Street', 'North Main Street']) assert.ok(names.has(n), n);
  assert.ok(r.streets.every((s) => s.kind !== 'path' && s.geometry.coordinates.length >= 2));
  assert.ok(r.counts.dropped['footpath, steps or track'] > 0 || r.counts.dropped['sidewalk or crossing'] > 0);
  for (let i = 1; i < r.streets.length; i++) assert.ok(r.streets[i].distanceM >= r.streets[i - 1].distanceM);
  assert.ok(r.streets.every((s) => s.distanceM <= 100));
});

test('overture-roads: failures are values, never throws (catalog down, fetch throws, no fetch, bad point)', async () => {
  clearOvertureCache();
  const down = await overtureRoads.lookup({ lat: 34, lng: -118 }, { fetch: async () => ({ ok: false, status: 503, text: async () => '' }), now: NOW, overtureCache: { release: null, dirs: new Map() } });
  assert.equal(down.ok, false); assert.match(down.reason, /catalog/);
  const thrown = await overtureRoads.lookup({ lat: 34, lng: -118 }, { fetch: async () => { throw new TypeError('Failed to fetch (CORS)'); }, now: NOW, overtureCache: { release: null, dirs: new Map() } });
  assert.equal(thrown.ok, false);
  assert.equal((await overtureRoads.lookup({ lat: 34, lng: -118 }, { now: NOW })).code, 'no_fetch');
  assert.equal((await overtureRoads.lookup({ lat: NaN, lng: -118 }, { fetch: async () => null, now: NOW })).code, 'bad_query');
});

test('street reference: names match across spellings; alleys only alongside a matched street; otherwise the nearest non-alley street', () => {
  assert.ok(sameStreet('S COCHRAN AVE', 'South Cochran Avenue')); assert.ok(!sameStreet('N SPRING ST', 'South Spring Street')); assert.ok(!sameStreet('ELM ST', 'Elm Avenue'));
  assert.equal(addressStreet('1829 S COCHRAN AVE, LOS ANGELES'), 'S COCHRAN AVE');
  const streets = [{ name: null, alley: true, geometry: line([0, 120], [50, 120]) }, { name: 'Elm Street', geometry: line([-50, -30], [100, -30]) }, { name: 'Oak Avenue', geometry: line([-30, -50], [-30, 200]) }];
  const m = streetReference({ streets, address: '10 ELM ST' });
  assert.equal(m.matched, true); assert.equal(m.streetName, 'ELM ST'); assert.equal(m.streets.length, 3); assert.equal(m.alleys, 1);
  const u = streetReference({ streets, address: '10 PINE ST' });
  assert.equal(u.matched, false); assert.equal(u.streets.length, 2, 'the alley is left out when nothing matched');
  assert.equal(streetReference({ streets: [streets[0]], address: '10 PINE ST' }), null, 'an alley alone is never a front reference');
});

test('front edge with centrelines: named street, corner lot, rear alley, and a junction connector at the corner (the facing rule)', () => {
  const lot = rect(0, 0, 50, 100), house = rect(10, 25, 40, 65);
  const elm = line([-100, -30], [200, -30]), oak = line([-30, -100], [-30, 300]), alley = line([-100, 110], [200, 110]);
  const named = splitYard({ parcel: lot, buildings: [house], streets: [{ name: 'ELM ST', geometry: elm }, { name: 'OAK AVE', geometry: oak }, { name: 'alley', geometry: alley }], streetName: 'ELM ST' });
  assert.equal(named.ok, true); near(named.frontEdge.inwardBearingDeg, 0, 1, 'front faces south (Elm), inward = north');
  assert.ok(named.frontEdge.otherFrontages.some((f) => f.street === 'OAK AVE' && f.kind === 'side'), 'corner lot');
  assert.ok(named.frontEdge.otherFrontages.some((f) => f.street === 'alley' && f.kind === 'rear'), 'rear alley is back, not front');
  near(named.frontYardSqft, 50 * 25, 2); near(named.backYardSqft, 50 * 35, 2);
  const corner = splitYard({ parcel: lot, buildings: [house], streets: [{ name: 'OAK AVE', geometry: oak }, { name: 'ELM ST', geometry: elm }], streetName: 'OAK AVE' });
  near(corner.frontEdge.inwardBearingDeg, 90, 1, 'named Oak: the west edge is the front');
  // the front street bends round the lot's corner (a junction connector 8 ft off the corner): the corner is nearest, but the edge that FACES it wins
  const bend = line([-100, -30], [-12, -30], [-8, -8], [-30, 20], [-30, 300]);
  const f = splitYard({ parcel: lot, buildings: [house], streets: [{ name: 'ELM ST', geometry: line([-12, -30], [200, -30]) }, { name: 'X', geometry: bend }], streetName: 'ELM ST' });
  near(f.frontEdge.inwardBearingDeg, 0, 1);
});

// ---------------------------------------------------------------- Stage 2: estimated lot
const block = (opts = {}) => {
  // houses 30 x 40 ft on 50 x 120 ft lots south of Elm (centreline y = 0, assumed half width 30 ft -> lots from y = -30 to -150),
  // a second row of lots behind (backing on), facing a street at y = -300
  const hs = [];
  for (let k = -3; k <= 3; k++) {
    if (opts.dropEast && k > 0) continue;
    hs.push(rect(10 + 50 * k, -90, 40 + 50 * k, -50));
    hs.push(rect(10 + 50 * k, -250, 40 + 50 * k, -210));
  }
  return hs;
};
const streetsAB = [{ name: 'Elm Street', class: 'residential', geometry: line([-400, 0], [400, 0]) }, { name: 'Ash Street', class: 'residential', geometry: line([-400, -300], [400, -300]) }];

test('estimated lot: regular block -> the 50 x 120 ft lot within 10% (area) and IoU >= 0.8; deterministic; inputs untouched', () => {
  const hs = block(), house = hs[6]; // k = 0, front row
  const before = JSON.stringify({ hs, streetsAB });
  const e = estimateLot({ building: house, neighbours: hs.filter((h) => h !== house), streets: streetsAB, streetName: 'ELM ST' });
  assert.equal(e.ok, true, e.reason);
  near(e.areaSqft, 6000, 600, 'area');
  assert.ok(polygonIoU(e.polygon, rect(0, -150, 50, -30)) >= 0.8, `IoU ${polygonIoU(e.polygon, rect(0, -150, 50, -30))}`);
  assert.equal(e.confidence, 0.15); assert.match(e.method, /no parcel record/); assert.equal(e.frontStreet, 'Elm Street');
  assert.deepEqual(estimateLot({ building: house, neighbours: hs.filter((h) => h !== house), streets: streetsAB, streetName: 'ELM ST' }), e);
  assert.equal(JSON.stringify({ hs, streetsAB }), before);
});

test('estimated lot: corner lot is bounded by the side street; missing neighbours on one side -> warning; no street -> refused', () => {
  const hs = block({ dropEast: true }), house = hs.find((h) => h.coordinates[0][0][0] === P(10, -90)[0] && h.coordinates[0][0][1] === P(10, -90)[1]);
  const side = [...streetsAB, { name: 'Oak Avenue', class: 'residential', geometry: line([80, 200], [80, -500]) }];
  const c = estimateLot({ building: house, neighbours: hs.filter((h) => h !== house), streets: side, streetName: 'ELM ST' });
  assert.equal(c.ok, true);
  const xs = c.polygon.coordinates[0].map((p) => ((p[0] - LNG0) * KX) / FT);
  near(Math.max(...xs), 50, 1, 'east line = Oak centreline (x 80) - 30 ft');
  const open = estimateLot({ building: house, neighbours: hs.filter((h) => h !== house), streets: streetsAB, streetName: 'ELM ST' });
  assert.ok(open.warnings.some((w) => /one side/.test(w)), open.warnings.join('; '));
  assert.equal(estimateLot({ building: house, neighbours: [], streets: [] }).ok, false);
  assert.equal(estimateLot({ building: null }).ok, false);
});

// ---------------------------------------------------------------- Stage 3: aerial reading
test('aerial: pixel rules (NIR vegetation, StreetForge canopy tone, water needs low NIR, shadow, no data, visible-only fallback)', () => {
  assert.equal(classifyPixel(60, 110, 50, 180), CLASS.VEG_TREE);
  assert.equal(classifyPixel(150, 200, 120, 255), CLASS.VEG_LOW);
  assert.equal(classifyPixel(150, 150, 150, 140), CLASS.PAVED);
  assert.equal(classifyPixel(60, 160, 200, 30), CLASS.WATER);
  assert.notEqual(classifyPixel(60, 160, 200, 200), CLASS.WATER, 'a blue roof or tarp reflects near-infrared: not water (NDVI may even call it vegetation)');
  assert.equal(classifyPixel(20, 22, 25, 20), CLASS.SHADOW);
  assert.equal(classifyPixel(1, 2, 3, 0), CLASS.NODATA);
  assert.notEqual(classifyPixel(60, 160, 200, null), CLASS.WATER, 'without NIR no water is ever reported');
});

/** a synthetic photo over the box [-20, -20] .. [80, 120] ft at ~2 ft pixels */
function synthImage(paint) {
  const [w, s] = P(-20, -20), [e, n] = P(80, 120);
  const W = 50, H = 70, r = new Uint8Array(W * H).fill(150), g = new Uint8Array(W * H).fill(150), b = new Uint8Array(W * H).fill(150), nir = new Uint8Array(W * H).fill(140), mask = new Uint8Array(W * H).fill(255);
  const im = { width: W, height: H, bbox: [w, s, e, n], r, g, b, nir, mask, date: '2024-05-06', gsdM: 0.6, source: 'test', bands: 'red, green, blue, near-infrared' };
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const [lng, lat] = pixelToLngLat(im, i, j); const x = ((lng - LNG0) * KX) / FT, y = ((lat - LAT0) * KY) / FT;
    const c = paint(x, y); if (!c) continue; const k = j * W + i; [r[k], g[k], b[k], nir[k]] = c;
  }
  return im;
}

test('aerial: georeferencing round trip pixel <-> lng/lat; pixel area', () => {
  const im = synthImage(() => null);
  for (const [i, j] of [[0, 0], [10, 33], [49, 69]]) { const [lng, lat] = pixelToLngLat(im, i, j); const [pi, pj] = lngLatToPixel(im, lng, lat); near(pi, i + 0.5, 1e-9); near(pj, j + 0.5, 1e-9); }
  near(pixelAreaM2(im) * 10.7639, (100 / 50) * (140 / 70), 0.01, 'a 2 x 2 ft pixel');
});

test('aerial: synthetic lot -> green rectangle, paved driveway, pool ellipse, shadow band within pixel tolerance; a tarp-sized blob and a blue roof are not pools', () => {
  const lot = rect(0, 0, 50, 100), house = rect(10, 30, 40, 60);
  const im = synthImage((x, y) => {
    if (x >= 10 && x <= 40 && y >= 30 && y <= 60) return [60, 160, 200, 200]; // blue roof (on the house)
    if (((x - 25) / 12) ** 2 + ((y - 80) / 7) ** 2 <= 1) return [60, 160, 200, 30]; // pool ellipse 24 x 14 ft = 264 sq ft
    if (x >= 2 && x <= 6 && y >= 70 && y <= 74) return [60, 160, 200, 30]; // 4 x 4 ft blue blob (a tarp): too small
    if (x >= 0 && x <= 50 && y >= 0 && y < 20) return [80, 130, 60, 200]; // lawn 50 x 20 = 1000 sq ft (front)
    if (x >= 0 && x <= 50 && y >= 92) return [20, 22, 25, 20]; // shadow band 50 x 8 = 400
    return null; // paved grey elsewhere
  });
  const y = splitYard({ parcel: lot, buildings: [house], streets: [{ name: 'ELM ST', geometry: line([-50, -30], [100, -30]) }], streetName: 'ELM ST' });
  const c = classifyLot({ image: im, parcel: lot, buildings: [house], zoneAt: yardZoneAt(y) });
  assert.equal(c.ok, true); assert.equal(c.coverage, 1);
  const s = c.summary, px = 4; // sq ft per pixel
  near(s.openPixelSqft, 5000 - 900, 60, 'open ground');
  near(s.greenSqft, 1000, 60, 'lawn'); near(s.green.front, 1000, 60, 'lawn is in the front zone');
  near(s.shadowSqft, 400, 60, 'shadow');
  assert.ok(s.pool, 'pool found'); near(s.pool.areaSqft, Math.PI * 12 * 7, 40, 'pool area'); assert.equal(s.pool.count, 1); assert.equal(s.pool.zone, 'back');
  assert.ok(s.waterRegions.some((w) => !w.pool && w.why === 'too small for a pool'), 'the tarp-sized blob is not a pool');
  near(s.pavedSqft + s.greenSqft + s.shadowSqft + s.waterSqft, s.openPixelSqft, px, 'every open pixel has one class');
  assert.equal(s.roofPixels > 0, true, 'roof pixels are left out of the open ground');
});

test('aerial: .npy parsing and planes; bad files are refused', () => {
  const hdr = "{'descr': '|u1', 'fortran_order': False, 'shape': (5, 2, 3), }";
  const pad = 128 - 10 - hdr.length - 1;
  const h = new TextEncoder().encode(hdr + ' '.repeat(pad) + '\n');
  const bytes = new Uint8Array(10 + h.length + 30); bytes.set([0x93, 78, 85, 77, 80, 89, 1, 0, h.length & 255, h.length >> 8]); bytes.set(h, 10);
  for (let k = 0; k < 30; k++) bytes[10 + h.length + k] = k;
  const a = parseNpy(bytes); assert.deepEqual(a.shape, [5, 2, 3]);
  const im = imageFromPlanes(a, { bbox: [0, 0, 1, 1], hasMask: true, nirBand: true, source: 't' });
  assert.deepEqual([...im.r], [0, 1, 2, 3, 4, 5]); assert.deepEqual([...im.nir], [18, 19, 20, 21, 22, 23]); assert.deepEqual([...im.mask], [24, 25, 26, 27, 28, 29]);
  assert.throws(() => parseNpy(new Uint8Array([1, 2, 3])), /not a .npy/);
  assert.throws(() => parseNpy(bytes.subarray(0, bytes.length - 3)), /truncated/);
});

// ---- NAIP provider with a fake service
function npyBytes(W, H, fill) {
  const hdr = `{'descr': '|u1', 'fortran_order': False, 'shape': (5, ${H}, ${W}), }`;
  const total = Math.ceil((10 + hdr.length + 1) / 64) * 64; const h = new TextEncoder().encode(hdr + ' '.repeat(total - 10 - hdr.length - 1) + '\n');
  const out = new Uint8Array(10 + h.length + 5 * W * H); out.set([0x93, 78, 85, 77, 80, 89, 1, 0, h.length & 255, h.length >> 8]); out.set(h, 10);
  const o = 10 + h.length; for (let k = 0; k < W * H; k++) { const [r, g, b, n] = fill(k); out[o + k] = r; out[o + W * H + k] = g; out[o + 2 * W * H + k] = b; out[o + 3 * W * H + k] = n; out[o + 4 * W * H + k] = 255; }
  return out;
}
const stacJson = (box) => ({ features: [{ id: 'ca_old', bbox: [box[0] - 1, box[1] - 1, box[2] + 1, box[3] + 1], properties: { gsd: 0.6, 'naip:year': '2022', datetime: '2022-05-11T16:00:00Z' } },
  { id: 'ca_new', bbox: [box[0] - 1, box[1] - 1, box[2] + 1, box[3] + 1], properties: { gsd: 0.6, 'naip:year': '2024', datetime: '2024-05-06T16:00:00Z' } }, { id: 'coarse', properties: { gsd: 1, datetime: '2025-01-01' } }] });
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, arrayBuffer: async () => (typeof body === 'string' ? new TextEncoder().encode(body).buffer : body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)) });
function naipWorld(over = {}) {
  const calls = [];
  const fetch = async (u) => {
    calls.push(u);
    if (u.includes('/stac/v1/search')) { if (over.stac) return over.stac(u); const bb = /bbox=([^&]+)/.exec(u)[1].split(',').map(Number); return res(200, JSON.stringify(stacJson(bb))); }
    if (u.includes('/api/data/v1/item/bbox/')) { if (over.item) return over.item(u); const [, W, H] = /\/(\d+)x(\d+)\.npy/.exec(u); return res(200, npyBytes(+W, +H, () => [150, 150, 150, 140])); }
    if (u.includes('imagery.nationalmap.gov')) { if (over.usgs) return over.usgs(u); return res(200, new Uint8Array([1, 2, 3])); }
    throw new Error(`unexpected ${u}`);
  };
  return { fetch, calls };
}

test('naip-aerial: newest 60 cm flight, one search + one image request, native size, NIR present, display url for an <img>', async () => {
  const w = naipWorld();
  const r = await naipAerial.lookup({ parcel: rect(0, 0, 50, 100) }, { fetch: w.fetch, now: NOW });
  assert.equal(r.ok, true, r.reason); assert.equal(w.calls.length, 2); assert.match(w.calls[1], /item=ca_new/); assert.match(w.calls[1], /asset_bidx=image%7C1%2C2%2C3%2C4/);
  assert.equal(r.date, '2024-05-06'); assert.equal(r.nir, true); assert.equal(r.counts.requests, 2);
  const bx = imageBox({ parcel: rect(0, 0, 50, 100) }); assert.equal(r.image.width, bx.W); assert.equal(r.image.height, bx.H);
  near(bx.W, Math.ceil((50 * FT + 12) / 0.6), 1);
  const d = displayImage(r); assert.match(d.url, /\.png\?/); assert.match(d.url, /image%7C1%2C2%2C3(&|$)/); assert.deepEqual(d.bbox, r.image.bbox); assert.equal(d.crs, 'EPSG:4326');
  assert.deepEqual(flightsFrom(stacJson([0, 0, 1, 1]), [0, 0, 1, 1]).map((f) => f.key), ['2024', '2022'], 'the 1 m item is dropped, newest first');
});

test('naip-aerial failure modes: 404, decode error, CORS-blocked (thrown), timeout, too large; USGS fallback only with a decoder', async () => {
  const q = { parcel: rect(0, 0, 50, 100) };
  const nf = await naipAerial.lookup(q, { fetch: naipWorld({ item: () => res(404, 'no') }).fetch, now: NOW });
  assert.equal(nf.ok, false); assert.equal(nf.code, 'not_found');
  const bad = await naipAerial.lookup(q, { fetch: naipWorld({ item: () => res(200, new Uint8Array([1, 2, 3])) }).fetch, now: NOW });
  assert.equal(bad.code, 'decode_error');
  const cors = await naipAerial.lookup(q, { fetch: async () => { throw new TypeError('Failed to fetch'); }, now: NOW });
  assert.equal(cors.ok, false); assert.equal(cors.code, 'network');
  const slow = await naipAerial.lookup(q, { fetch: () => new Promise(() => {}), now: NOW, timeoutMs: 50 });
  assert.equal(slow.code, 'timeout');
  assert.equal((await naipAerial.lookup({ parcel: rect(0, 0, 2000, 100) }, { fetch: naipWorld().fetch, now: NOW })).code, 'bad_query');
  // fallback: the Planetary Computer search fails, USGS PNG decoded by the injected decoder (visible only)
  const fb = await naipAerial.lookup(q, { fetch: naipWorld({ stac: () => res(500, 'x') }).fetch, now: NOW, decodeImage: async () => { const bx = imageBox(q); return { width: bx.W, height: bx.H, data: new Uint8Array(bx.W * bx.H * 4).fill(200) }; } });
  assert.equal(fb.ok, true); assert.equal(fb.nir, false); assert.equal(fb.date, null); assert.match(fb.fallbackReason, /HTTP 500/);
  const fbBad = await naipAerial.lookup(q, { fetch: naipWorld({ stac: () => res(500, 'x') }).fetch, now: NOW, decodeImage: async () => { throw new Error('canvas tainted'); } });
  assert.equal(fbBad.code, 'decode_error');
});

// ---------------------------------------------------------------- Stage 4: remodeled year
test('remodeled_year: effective year later than the year built -> estimated; equal, empty, 0000 or future -> unavailable with the reason', () => {
  const ctx = { at: NOW, idConf: 0.9 };
  const ok = remodeledYear({ EffectiveYear1: '1960' }, { value: 1914, slot: 1 }, ctx);
  assert.deepEqual([ok.value, ok.tag, ok.method], [1960, 'estimated', "assessor's effective year (updated after major remodels)"]); assert.ok(ok.confidence <= 0.5);
  assert.equal(remodeledYear({ EffectiveYear1: '1953' }, { value: 1953, slot: 1 }, ctx).tag, 'unavailable');
  assert.equal(remodeledYear({ EffectiveYear1: '0000' }, { value: 1953, slot: 1 }, ctx).tag, 'unavailable');
  assert.equal(remodeledYear({ EffectiveYear1: null }, { value: 1953, slot: 1 }, ctx).tag, 'unavailable');
  assert.equal(remodeledYear({ EffectiveYear1: '2031' }, { value: 1953, slot: 1 }, ctx).tag, 'unavailable');
  assert.equal(remodeledYear({ EffectiveYear2: '1990', EffectiveYear1: '1950' }, { value: 1950, slot: 1 }, ctx).tag, 'unavailable', 'the main improvement slot, not another');
  const f = fieldsFromParcel({ AIN: '1', YearBuilt1: '1948', EffectiveYear1: '1960', SQFTmain1: 1000 }, null, { at: NOW, idConf: 0.9, method: 'x' });
  assert.equal(f.remodeled_year.value, 1960);
});

// ---------------------------------------------------------------- usable yard
const L50 = rect(0, 0, 50, 100), H50 = rect(5, 20, 35, 60); // 5 ft gap west, 15 ft gap east, set back 20 ft, 40 ft rear line at 60
const elm = [{ name: 'ELM ST', geometry: line([-50, -20], [100, -20]) }];

test('usable yard: 50 x 100 ft lot, 30 x 40 ft house set back 20 ft, 5 and 15 ft side gaps (W = 10 ft)', () => {
  const y = splitYard({ parcel: L50, buildings: [H50], streets: elm, streetName: 'ELM ST' });
  assert.deepEqual([y.frontYardSqft, y.backYardSqft, y.sideYardSqft], [1000, 2000, 800]);
  const u = usableYard({ parcel: L50, buildings: [H50], yard: y });
  assert.equal(u.ok, true); assert.equal(u.minWidthFt, 10); assert.match(u.method, /at least 10 ft wide; narrow strips beside the house are left out; slope and what is on the ground are not known/); assert.match(u.method, /modelling assumption/);
  // exact geometry: front 1,000 and back 2,000 less 5.4 sq ft per right-angled lot corner the 10 ft disc cannot reach -> 989 and 1,989;
  // side: the 15 x 40 ft strip (600) counts, the 5 ft strip (200) does not. Grid tolerance: 0.25 m cells, half a cell along each 50 ft edge, 40 sq ft.
  near(u.usableFrontSqft, 989, 40, 'front'); near(u.usableBackSqft, 1989, 40, 'back'); near(u.usableSideSqft, 600, 40, 'side: only the 15 ft strip');
  assert.ok(u.usableSideSqft < 700, 'the 5 ft strip is excluded');
  const cells = u.cells; assert.equal(cells.mask.length, cells.width * cells.height); assert.equal(cells.cellM, 0.25);
});

test('usable yard: L-shaped lot, a pool excluded, W monotonic, deterministic, no mutation', () => {
  const L = { type: 'Polygon', coordinates: [[P(0, 0), P(60, 0), P(60, 40), P(20, 40), P(20, 100), P(0, 100), P(0, 0)]] }; // 60x40 + 20x60
  const u = usableYard({ parcel: L, buildings: [] });
  near(u.openSqft, 60 * 40 + 20 * 60, 40); near(u.usableSqft, 3600 - 4 * 5.4, 60, 'every part is at least 20 ft wide');
  const narrow = usableYard({ parcel: L, buildings: [], minWidthFt: 25 });
  near(narrow.usableSqft, 60 * 40 - 3 * 28.9, 80, 'W 25 ft: the 20 ft arm drops out');
  const pool = usableYard({ parcel: L50, buildings: [H50], exclude: [rect(10, 70, 40, 85)] });
  const plain = usableYard({ parcel: L50, buildings: [H50] });
  assert.ok(plain.usableSqft - pool.usableSqft >= 450 - 40, `pool 30 x 15 ft removed: ${plain.usableSqft} -> ${pool.usableSqft}`);
  let last = Infinity;
  for (const w of [2, 6, 10, 14, 20, 30]) { const v = usableYard({ parcel: L50, buildings: [H50], minWidthFt: w }).usableSqft; assert.ok(v <= last, `W ${w}: ${v} > ${last}`); last = v; }
  const before = JSON.stringify([L50, H50]);
  assert.deepEqual(usableYard({ parcel: L50, buildings: [H50] }).usableSqft, plain.usableSqft); assert.equal(JSON.stringify([L50, H50]), before);
  assert.equal(usableYard({ parcel: L50, minWidthFt: -1 }).ok, false); assert.equal(usableYard({ parcel: null }).ok, false);
  // the opening itself: a 3-cell-wide bar vanishes under a radius-2 disc, a 9-cell square survives
  const m = new Uint8Array(20 * 20); for (let j = 2; j < 5; j++) for (let i = 2; i < 18; i++) m[j * 20 + i] = 1; for (let j = 8; j < 17; j++) for (let i = 8; i < 17; i++) m[j * 20 + i] = 1;
  const o = openByDisc(m, 20, 20, 2); assert.equal(o.slice(0, 100).reduce((a, b) => a + b, 0), 0); assert.ok(o[12 * 20 + 12] === 1);
});

// ---------------------------------------------------------------- builder: wiring, geometry, measureFromGeometry, timing
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEYS = ['apn', 'lot_sqft', 'house_sqft', 'floors', 'beds', 'baths', 'year_built', 'remodeled_year', 'property_type', 'use_code', 'units'];
const baseP = { needsKey: false, coverage: { national: true }, retentionDays: null, licenseNote: 'test provider only' };
const recs = (delay = 0) => ({ ...baseP, id: 'f-records', label: 'Fake county', kind: 'records', async lookup() {
  await sleep(delay);
  const have = { apn: '9', lot_sqft: Math.round(polygonAreaSqft(L50)), year_built: 1950, remodeled_year: 1990 };
  return { ok: true, fields: Object.fromEntries(KEYS.map((k) => [k, k in have ? sourced(have[k], { tag: k === 'remodeled_year' ? 'estimated' : 'measured', source: 'Fake county', confidence: 0.8, retrievedAt: NOW }) : unavailable('fake', 'Fake county')])),
    parcel: { boundary: L50, apn: '9', address: null, assessorAreaSqft: null, matchedBy: 'x', method: 'x', confidence: 0.9 } };
} });
const garage = rect(38, 75, 48, 95);
const foot = (delay = 0) => ({ ...baseP, id: 'f-foot', label: 'Fake outlines', kind: 'footprint', async lookup() {
  await sleep(delay);
  return { ok: true, buildings: [H50, garage].map((g) => ({ polygon: g, areaSqft: footprintAreaSqft(g) })) };
} });
const street = (delay = 0) => ({ ...baseP, id: 'f-street', label: 'Fake streets', kind: 'street', async lookup() { await sleep(delay); return { ok: true, streets: [{ name: 'Elm Street', geometry: line([-50, -20], [100, -20]) }], attribution: 'Street lines: test' }; } });
const aerial = (delay = 0, fail = false) => ({ ...baseP, id: 'f-aerial', label: 'Fake photo', kind: 'aerial', async lookup(q) {
  await sleep(delay);
  if (fail) return { ok: false, reason: 'photo service down', code: 'server_error' };
  const im = synthImage((x, y) => (y < 20 ? [80, 130, 60, 200] : null));
  return { ok: true, image: im, source: 'USDA NAIP (test)', date: im.date, attribution: 'Aerial photo: USDA NAIP (US Government imagery)', counts: { requests: 2, bytes: 1 } };
} });
const registry = (d = {}) => [recs(d.r), foot(d.f), street(d.s), aerial(d.a, d.aFail)].reduce((r, p) => r.register(p), createRegistry());
const Q = { address: '10 ELM ST, Testville, CA', lat: LAT0 + (40 * FT) / KY, lng: LNG0 + (20 * FT) / KX };
const J = { state: 'CA', countyFips: '06999', county: 'Test County' };

test('builder: centrelines feed the yard; side yard hidden; usable yard, photo reading and remodeled year arrive as fields; geometry bundle', async () => {
  const pj = await buildPropertyProfile(Q, { registry: registry(), fetch: async () => { throw new Error('no fetch'); }, now: NOW, jurisdiction: J, splitYard });
  assert.equal(pj.details.yard.reference, 'centreline'); assert.match(pj.fields.front_yard_sqft.note, /street centreline/);
  assert.equal(pj.front_yard_sqft, 1000); assert.equal(pj.back_yard_sqft, 2000 - 200);
  assert.equal(pj.fields.side_yard_sqft.hidden, true);
  const sp = toSourcedProfile(pj);
  assert.equal(sp.attributes.side_yard_sqft, undefined, 'not offered to pages'); assert.equal(sp.attributes.yard_area_sqft.value, pj.front_yard_sqft + pj.back_yard_sqft + pj.fields.side_yard_sqft.value);
  for (const k of ['usable_yard_sqft', 'usable_front_yard_sqft', 'usable_back_yard_sqft', 'green_area_sqft', 'paved_area_sqft', 'remodeled_year']) {
    assert.ok(pj.fields[k].value !== null, k); assert.equal(pj.fields[k].tag, 'estimated', k); assert.ok(sp.attributes[k], k);
  }
  assert.match(pj.fields.usable_yard_sqft.method, /10 ft wide/);
  near(pj.fields.green_area_sqft.value, 1000, 60, 'front lawn of the synthetic photo'); assert.match(pj.fields.green_area_sqft.source, /2024-05-06/);
  assert.equal(pj.fields.tree_cover_sqft.tag, 'unavailable'); assert.equal(pj.fields.pool_area_sqft.tag, 'unavailable');
  assert.ok(pj.details.usable_yard.photo.greenShare > 0 && pj.details.usable_yard.photo.pavedShare > 0);
  assert.ok(pj.attributions.includes('Street lines: test') && pj.attributions.includes('Aerial photo: USDA NAIP (US Government imagery)'));
  const g = pj.geometry;
  assert.equal(g.parcelSource, 'record'); assert.deepEqual(g.parcel, L50); assert.deepEqual(g.buildings.map((b) => b.main), [true, false]);
  assert.equal(g.frontEdge.coordinates.length, 2); assert.equal(g.reference, 'centreline'); assert.equal(g.streets[0].name, 'ELM ST'); assert.equal(g.streetName, 'ELM ST');
  assert.ok(g.zones.bands && g.zones.usable.mask.length === g.zones.usable.width * g.zones.usable.height);
  assert.deepEqual(Object.keys(g.image).sort(), ['bbox', 'corsForImg', 'credit', 'crs', 'date', 'height', 'url', 'width']);
});

test('measureFromGeometry(builder geometry) reproduces the builder exactly; a moved corner changes the numbers', async () => {
  const pj = await buildPropertyProfile(Q, { registry: registry(), fetch: async () => { throw new Error('no fetch'); }, now: NOW, jurisdiction: J, splitYard });
  const m = measureFromGeometry(pj.geometry, { now: NOW });
  const sp = toSourcedProfile(pj).attributes;
  assert.deepEqual(
    [m.lot_area_sqft, m.building_footprint_sqft, m.roof_area_sqft, m.front_yard_sqft, m.back_yard_sqft, m.yard_area_sqft, m.usable_yard_sqft, m.usable_front_yard_sqft, m.usable_back_yard_sqft],
    [pj.lot_sqft, pj.building_footprint_sqft, pj.roof_sqft, pj.front_yard_sqft, pj.back_yard_sqft, sp.yard_area_sqft.value, pj.usable_yard_sqft, pj.usable_front_yard_sqft, pj.usable_back_yard_sqft]);
  const deeper = measureFromGeometry({ ...pj.geometry, parcel: rect(0, 0, 50, 120) }, { now: NOW });
  assert.equal(deeper.back_yard_sqft, pj.back_yard_sqft + 1000); assert.equal(deeper.lot_area_sqft, Math.round(polygonAreaSqft(rect(0, 0, 50, 120))));
  // a front line the owner drew instead of street lines
  const fe = measureFromGeometry({ parcel: L50, buildings: [{ polygon: H50, main: true }], frontEdge: { coordinates: [P(0, 0), P(50, 0)] } }, { now: NOW });
  assert.equal(fe.front_yard_sqft, 1000);
  assert.ok(measureFromGeometry({ parcel: L50, buildings: [H50] }, { now: NOW }).reasons.some((r) => /no street reference/.test(r)));
});

test('builder: roads and the photo run in parallel with records and footprints (total ~ the slowest); a failed photo leaves its facts empty', async () => {
  const t = Date.now();
  const pj = await buildPropertyProfile(Q, { registry: registry({ r: 300, f: 300, s: 300, a: 300 }), fetch: async () => { throw new Error('no fetch'); }, now: NOW, jurisdiction: J, splitYard });
  const dt = Date.now() - t;
  assert.ok(dt >= 290 && dt < 600, `four 300 ms groups took ${dt} ms (sum 1,200)`);
  assert.ok(pj.green_area_sqft > 0);
  const failed = await buildPropertyProfile(Q, { registry: registry({ aFail: true }), fetch: async () => { throw new Error('no fetch'); }, now: NOW, jurisdiction: J, splitYard });
  assert.equal(failed.fields.green_area_sqft.tag, 'unavailable'); assert.match(failed.fields.green_area_sqft.note, /photo service down/);
  assert.equal(failed.providers.find((p) => p.id === 'f-aerial').status, 'failed');
  assert.equal(failed.front_yard_sqft, 1000, 'the yard does not depend on the photo');
  const off = await buildPropertyProfile(Q, { registry: registry(), fetch: async () => { throw new Error('no fetch'); }, now: NOW, jurisdiction: J, splitYard, aerial: false });
  assert.equal(off.providers.find((p) => p.id === 'f-aerial'), undefined);
});

test('builder: deterministic and the estimated lot stays off unless asked', async () => {
  const run = () => buildPropertyProfile(Q, { registry: registry(), fetch: async () => { throw new Error('no fetch'); }, now: NOW, jurisdiction: J, splitYard });
  const a = await run(), b = await run();
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
  // no parcel record: the lot is not estimated by default
  const noParcel = [{ ...recs(), async lookup() { return { ok: false, reason: 'no parcel', code: 'no_match' }; } }, foot(), street(), aerial()].reduce((r, p) => r.register(p), createRegistry());
  const off = await buildPropertyProfile(Q, { registry: noParcel, fetch: async () => { throw new Error('x'); }, now: NOW, jurisdiction: J, splitYard });
  assert.equal(off.fields.front_yard_sqft.tag, 'unavailable'); assert.equal(off.geometry.parcel, null);
});

// ---------------------------------------------------------------- driveway and building kinds (2026-11-27, second pass)
import { detectDriveway, drivewayAreaSqft } from '../driveway.js';
import { kindFromSource } from '../building-kind.js';

const GAR = rect(38, 75, 48, 95);
/** lawn everywhere; a paved strip x 38..48 from the street to the rear garage; a paved patio behind the house that never reaches the street */
const drivePaint = (opts = {}) => (x, y) => {
  if (opts.strip !== false && x >= 38 && x <= 48 && y >= -20 && y < 75) return [150, 150, 150, 140];
  if (x >= 5 && x <= 30 && y >= 68 && y <= 90) return [150, 150, 150, 140];
  return [80, 130, 60, 200];
};
const dvRun = (paint, extra = {}) => {
  const y = splitYard({ parcel: L50, buildings: [H50, GAR], streets: elm, streetName: 'ELM ST', mainBuildingIndex: 0 });
  const im = synthImage(paint);
  const c = classifyLot({ image: im, parcel: L50, buildings: [H50, GAR], zoneAt: yardZoneAt(y) });
  return detectDriveway({ parcel: L50, buildings: [H50, GAR], mainBuildingIndex: 0, yard: y, image: im, classes: c.classes, ...extra });
};

test('driveway: a paved strip from the street to a rear garage is found (photo); width, length, the garage it reaches, few corners', () => {
  const d = dvRun(drivePaint());
  assert.equal(d.ok, true, d.reason); assert.equal(d.source, 'photo'); assert.equal(d.reachesBuildingIndex, 1, 'the garage');
  near(d.widthFt, 10, 3, 'width'); near(d.lengthFt, 75, 5, 'length'); near(d.areaSqft, 750, 120, 'area');
  assert.ok(d.polygon.coordinates[0].length - 1 <= 12); assert.ok(d.warnings.some((w) => /other than the house/.test(w)));
  const xs = d.polygon.coordinates[0].map((p) => ((p[0] - LNG0) * KX) / FT);
  assert.ok(Math.min(...xs) > 33, 'the patio behind the house is not part of it');
  assert.deepEqual(dvRun(drivePaint()), d, 'deterministic');
});

test('driveway: a patio that never reaches the street is not a driveway; no photo and no line -> ok:false; a mapped line picks its strip', () => {
  const none = dvRun(drivePaint({ strip: false }));
  assert.equal(none.ok, false); assert.match(none.reason, /street side/);
  const noPhoto = detectDriveway({ parcel: L50, buildings: [H50], yard: splitYard({ parcel: L50, buildings: [H50], streets: elm, streetName: 'ELM ST' }) });
  assert.equal(noPhoto.ok, false);
  const lineOnly = detectDriveway({ parcel: L50, buildings: [H50], yard: splitYard({ parcel: L50, buildings: [H50], streets: elm, streetName: 'ELM ST' }), driveways: [{ geometry: line([43, -20], [43, 75]) }] });
  assert.equal(lineOnly.ok, false); assert.match(lineOnly.reason, /no aerial photo to show its width/); assert.ok(lineOnly.line, 'the line is handed back, no rectangle is guessed');
  const map = dvRun(drivePaint(), { driveways: [{ geometry: line([43, -20], [43, 75]) }] });
  assert.equal(map.source, 'map+photo'); assert.equal(map.confidence, 0.4);
  assert.equal(detectDriveway({ parcel: L50 }).ok, false, 'no front line');
});

test('driveway area is clipped to the lot minus buildings; measureFromGeometry leaves the driveway out of the usable yard, not out of the yards', () => {
  const dv = rect(38, -10, 48, 80); // runs off the lot at the front and under the garage
  near(drivewayAreaSqft(dv, L50, [GAR]), 10 * 75, 25, 'on the lot, not under the garage');
  const base = { parcel: L50, buildings: [{ polygon: H50, main: true }, { polygon: GAR }], streets: elm, streetName: 'ELM ST' };
  const a = measureFromGeometry(base, { now: NOW }), b = measureFromGeometry({ ...base, driveway: { polygon: dv } }, { now: NOW });
  assert.equal(a.driveway_area_sqft, null); near(b.driveway_area_sqft, 750, 25);
  assert.deepEqual([b.front_yard_sqft, b.back_yard_sqft, b.yard_area_sqft], [a.front_yard_sqft, a.back_yard_sqft, a.yard_area_sqft]);
  assert.ok(a.usable_yard_sqft - b.usable_yard_sqft >= 400, `usable ${a.usable_yard_sqft} -> ${b.usable_yard_sqft}`);
});

test('building kinds: only what a source says; measureFromGeometry totals and minor outlines', () => {
  assert.deepEqual(kindFromSource({ buildingClass: 'garage' }), { kind: 'garage', source: 'Overture Maps building class', value: 'garage' });
  assert.equal(kindFromSource({ buildingClass: 'residential' }).kind, null, 'a general class is not a kind');
  assert.equal(kindFromSource({ kind: 'Building' }).kind, null, 'LARIAC says nothing');
  assert.equal(kindFromSource({ osmBuilding: 'shed' }).kind, 'shed');
  const speck = rect(2, 92, 8, 98); // 36 sq ft
  const m = measureFromGeometry({ parcel: L50, buildings: [{ polygon: H50, main: true, kind: 'house' }, { polygon: GAR, kind: 'garage' }, { polygon: speck, kind: 'shed' }, { polygon: rect(5, 70, 15, 85), kind: 'adu' }], streets: elm, streetName: 'ELM ST' }, { now: NOW });
  assert.deepEqual(m.buildings.map((b) => [b.kind, b.minor ?? false]), [['house', false], ['garage', false], ['shed', true], ['adu', false]]);
  assert.equal(m.garage_present, true); near(m.garage_area_sqft, 200, 1); assert.equal(m.adu_present, true); near(m.adu_area_sqft, 150, 1); near(m.shed_area_sqft, 36, 1);
  assert.equal(m.other_buildings_area_sqft, null);
  const unknown = measureFromGeometry({ parcel: L50, buildings: [{ polygon: H50, main: true }, { polygon: GAR }], streets: elm, streetName: 'ELM ST' }, { now: NOW });
  assert.deepEqual([unknown.garage_present, unknown.adu_present, unknown.garage_area_sqft], [null, null, null], 'no kind: unknown, never "no garage"');
  assert.equal(measureFromGeometry({ parcel: L50, buildings: [{ polygon: H50, kind: 'castle' }], streets: elm, streetName: 'ELM ST' }, { now: NOW }).buildings[0].kind, null);
});

test('builder: driveway field and geometry.driveway; garage kind from the source; measureFromGeometry still reproduces the builder', async () => {
  const foot2 = { ...baseP, id: 'f-foot', label: 'Fake outlines', kind: 'footprint', async lookup() { return { ok: true, buildings: [{ polygon: H50, areaSqft: footprintAreaSqft(H50) }, { polygon: GAR, areaSqft: footprintAreaSqft(GAR), buildingClass: 'garage' }] }; } };
  const photo = { ...baseP, id: 'f-aerial', label: 'Fake photo', kind: 'aerial', async lookup() { const im = synthImage(drivePaint()); return { ok: true, image: im, source: 'USDA NAIP (test)', date: im.date, attribution: 'x' }; } };
  const reg2 = (over = {}) => [recs(), foot2, street(), photo].reduce((r, p) => r.register(p), createRegistry());
  const pj = await buildPropertyProfile(Q, { registry: reg2(), fetch: async () => { throw new Error('no fetch'); }, now: NOW, jurisdiction: J, splitYard });
  assert.ok(pj.driveway_area_sqft > 500, `driveway ${pj.driveway_area_sqft}`); assert.equal(pj.fields.driveway_area_sqft.tag, 'estimated'); assert.match(pj.fields.driveway_area_sqft.method, /paved/);
  const g = pj.geometry;
  assert.deepEqual(Object.keys(g.driveway).sort(), ['areaSqft', 'confidence', 'polygon', 'source']); assert.equal(g.driveway.areaSqft, pj.driveway_area_sqft);
  assert.deepEqual(g.buildings.map((b) => [b.main, b.kind]), [[true, 'house'], [false, 'garage']]); assert.equal(g.buildings[1].kindSource, 'Overture Maps building class');
  assert.equal(pj.fields.garage_present.value, true); assert.equal(pj.fields.garage_present.tag, 'estimated');
  const sp = toSourcedProfile(pj).attributes;
  assert.equal(sp.garage_present.value, true); assert.equal(sp.adu_present, undefined, 'no source says ADU'); assert.equal(sp.driveway_area_sqft.value, pj.driveway_area_sqft);
  assert.ok(!('parking_spaces' in pj.fields), 'no parking-space count');
  const m = measureFromGeometry(g, { now: NOW });
  assert.deepEqual([m.driveway_area_sqft, m.usable_yard_sqft, m.usable_front_yard_sqft, m.usable_back_yard_sqft, m.front_yard_sqft, m.back_yard_sqft, m.roof_area_sqft],
    [pj.driveway_area_sqft, pj.usable_yard_sqft, pj.usable_front_yard_sqft, pj.usable_back_yard_sqft, pj.front_yard_sqft, pj.back_yard_sqft, pj.roof_sqft]);
  assert.equal(m.garage_present, true);
  const off = await buildPropertyProfile(Q, { registry: reg2(), fetch: async () => { throw new Error('no fetch'); }, now: NOW, jurisdiction: J, splitYard, detectDriveway: false });
  assert.equal(off.fields.driveway_area_sqft.tag, 'unavailable'); assert.equal(off.geometry.driveway, null); assert.ok(off.usable_yard_sqft > pj.usable_yard_sqft);
});
