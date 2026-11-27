// Test-only: serves Overture's catalog and buildings PMTiles file for the two recorded public buildings (LA City Hall, Chicago City Hall) from
// core/tests/fixtures/providers/overture-city-halls.json. Header/root and leaf directory bytes are the REAL recorded bytes; each tile is a
// vector tile re-encoded here from the REAL decoded features (see that file's _fixture_note). No network. Used by unit tests and browser tests.
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const REAL = JSON.parse(readFileSync(new URL('./overture-city-halls.json', import.meta.url), 'utf8'));
export const OVERTURE_REAL = REAL;
export const RELEASE = REAL.catalog.latest;
export const CATALOG_URL = 'https://stac.overturemaps.org/catalog.json';
export const FILE_URL = REAL.fileUrl;

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
export function encodeTile(features, { name = 'building', ext = 4096 } = {}) {
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
const b64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));

/**
 * @param {'la'|'chicago'} which
 * @returns {{answer:(url:string, range:string|null)=>{status:number, body:Uint8Array|string, type:string}|null, calls:Array<{url:string, range:string|null}>}}
 */
export function overtureServer(which) {
  const c = REAL[which];
  const map = new Map([[c.header.range, b64(c.header.b64)], [c.leaf.range, b64(c.leaf.b64)]]);
  for (const t of c.tiles) map.set(t.range, new Uint8Array(gzipSync(encodeTile(t.features, { ext: t.ext }))));
  const calls = [];
  return {
    calls,
    answer(url, range) {
      calls.push({ url, range });
      if (url === CATALOG_URL) return { status: 200, type: 'application/json', body: JSON.stringify(REAL.catalog) };
      if (url === FILE_URL) { const b = range ? map.get(range) : null; return b ? { status: 206, type: 'application/octet-stream', body: b } : { status: 404, type: 'text/plain', body: 'missing' }; }
      return null;
    },
  };
}
