// @ts-check
// Dependency-free PMTiles v3 reader (HTTP range requests) and Mapbox Vector Tile layer decoder, for browsers and Node 22.
//
// PORTED FROM StreetForge streetforge2d.html (read-only reference), lines 13598-13630 (object `PMT`: reader, dir, id, find, range,
// open, tile, layer) and 13631-13638 (header offsets). Differences from the original, on purpose:
//  - `fetch`, the gunzip function and a directory cache are INJECTED (the original used globals and a module-level Map).
//  - A range request that answers 200 (the server ignored Range) is REFUSED instead of reading the whole file: these files are
//    multi-gigabyte. StreetForge accepted 200 and called arrayBuffer() on it.
//  - Every failure is a PmtilesError with a stable `code` (network, timeout, http, not_pmtiles, unsupported, decode) instead of a bare Error.
//  - Compression other than none/gzip is refused with code 'unsupported' (StreetForge would have tried to read it as raw bytes).
// Header layout used (PMTiles v3 spec): 0-6 'PMTiles', 7 version, 8/16 root directory offset/length, 40 leaf directories offset,
// 56 tile data offset, 97 internal compression, 98 tile compression (1 none, 2 gzip), 101 max zoom.

export class PmtilesError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) { super(message); this.name = 'PmtilesError'; this.code = code; }
}

/** First request: the header (127 bytes) and, usually, the whole root directory. */
export const HEADER_FETCH_BYTES = 16384;
/** Directory depth limit (PMTiles v3 allows root + up to 3 leaf levels). */
const MAX_DEPTH = 4;
/** Sanity cap on one decompressed tile or directory. */
const MAX_BYTES = 64 * 1024 * 1024;

/** Little-endian unsigned 64-bit as a JS number (exact below 2^53, far beyond any real file). @param {Uint8Array} b @param {number} o */
export function u64(b, o) {
  let v = 0;
  for (let i = 7; i >= 0; i--) v = v * 256 + b[o + i];
  return v;
}

/** Protobuf-style reader over a byte array. @param {Uint8Array} b */
function pbReader(b) {
  let i = 0;
  const vr = () => {
    let v = 0, m = 1, c;
    do { if (i >= b.length) throw new PmtilesError('decode', 'truncated varint'); c = b[i++]; v += (c & 127) * m; m *= 128; } while (c & 128);
    return v;
  };
  return {
    get end() { return i >= b.length; },
    vr,
    tag: () => { const t = vr(); return /** @type {[number, number]} */ ([Math.floor(t / 8), t & 7]); },
    bytes: () => { const l = vr(); if (i + l > b.length) throw new PmtilesError('decode', 'truncated field'); const s = b.subarray(i, i + l); i += l; return s; },
    skip: (/** @type {number} */ w) => { if (w === 0) vr(); else if (w === 1) i += 8; else if (w === 2) { const l = vr(); i += l; } else if (w === 5) i += 4; else i = b.length; },
    f: (/** @type {number} */ n) => { if (i + n > b.length) throw new PmtilesError('decode', 'truncated float'); const d = new DataView(b.buffer, b.byteOffset + i, n); i += n; return n === 8 ? d.getFloat64(0, true) : d.getFloat32(0, true); },
  };
}

/**
 * Parse one PMTiles directory (already decompressed) into entries sorted by tile id.
 * run > 0: a tile entry (run = how many consecutive ids share it); run 0: a pointer to a leaf directory.
 * @param {Uint8Array} bytes @returns {Array<{id:number, run:number, len:number, off:number}>}
 */
export function parseDirectory(bytes) {
  const r = pbReader(bytes), n = r.vr();
  if (n > 5_000_000) throw new PmtilesError('decode', 'directory too large');
  /** @type {any[]} */ const E = [];
  let last = 0;
  for (let i = 0; i < n; i++) { last += r.vr(); E.push({ id: last }); }
  for (const e of E) e.run = r.vr();
  for (const e of E) e.len = r.vr();
  for (let i = 0; i < n; i++) { const v = r.vr(); E[i].off = v === 0 && i > 0 ? E[i - 1].off + E[i - 1].len : v - 1; }
  return E;
}

/** The tile's id on the Hilbert curve that orders a PMTiles file. @param {number} z @param {number} x @param {number} y */
export function tileId(z, x, y) {
  let d = 0;
  const p = [x, y];
  for (let s = 2 ** (z - 1); s >= 1; s /= 2) {
    const rx = (p[0] & s) > 0 ? 1 : 0, ry = (p[1] & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) { if (rx === 1) { p[0] = s - 1 - p[0]; p[1] = s - 1 - p[1]; } const t = p[0]; p[0] = p[1]; p[1] = t; }
  }
  return (4 ** z - 1) / 3 + d;
}

/** Binary search for the entry holding `id` (exact, or the preceding run / leaf pointer that covers it). @param {any[]} E @param {number} id */
export function findEntry(E, id) {
  let lo = 0, hi = E.length - 1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (E[m].id < id) lo = m + 1; else if (E[m].id > id) hi = m - 1; else return E[m]; }
  if (hi >= 0) { const e = E[hi]; if (e.run === 0 || id - e.id < e.run) return e; }
  return null;
}

/** Slippy-map tile covering a longitude. @param {number} lng @param {number} z */
export const lngToTileX = (lng, z) => Math.floor(((lng + 180) / 360) * 2 ** z);
/** Slippy-map tile row covering a latitude. @param {number} lat @param {number} z */
export const latToTileY = (lat, z) => { const s = Math.sin((lat * Math.PI) / 180); return Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z); };

/**
 * gzip -> bytes with the platform's DecompressionStream (browsers, Node 18+). Injected so tests/other runtimes can replace it.
 * @param {Uint8Array} b @returns {Promise<Uint8Array>}
 */
export async function defaultGunzip(b) {
  if (typeof DecompressionStream === 'undefined') throw new PmtilesError('unsupported', 'this runtime has no DecompressionStream, so gzip tiles cannot be read');
  const out = new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  if (out.length > MAX_BYTES) throw new PmtilesError('decode', 'decompressed data too large');
  return out;
}

/**
 * A PMTiles v3 reader over HTTP range requests.
 * @param {{url:string, fetch:(url:string, init?:any)=>Promise<any>, gunzip?:(b:Uint8Array)=>Promise<Uint8Array>, timeoutMs?:number,
 *   dirCache?:Map<string, any[]>, stats?:{requests:number, bytes:number}}} o
 */
export function createPmtilesReader(o) {
  const gunzip = o.gunzip ?? defaultGunzip;
  const timeoutMs = o.timeoutMs ?? 12000;
  const dirCache = o.dirCache ?? new Map();
  const stats = o.stats ?? { requests: 0, bytes: 0 };
  /** @type {any} */ let F = null;

  /** @param {number} off @param {number} len */
  async function range(off, len) {
    if (typeof o.fetch !== 'function') throw new PmtilesError('network', 'no fetch provided');
    const ctl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
    try {
      stats.requests++;
      const res = await o.fetch(o.url, { headers: { Range: `bytes=${off}-${off + len - 1}` }, signal: ctl.signal, credentials: 'omit' });
      if (!res) throw new PmtilesError('network', 'empty response');
      if (res.status === 200) { try { await res.body?.cancel?.(); } catch { /* ignore */ } throw new PmtilesError('unsupported', 'the server ignored the Range header (HTTP 200); refusing to read the whole file'); }
      if (res.status !== 206) throw new PmtilesError('http', `HTTP ${res.status}`);
      const b = new Uint8Array(await res.arrayBuffer());
      stats.bytes += b.length;
      return b;
    } catch (e) {
      if (e instanceof PmtilesError) throw e;
      if (timedOut) throw new PmtilesError('timeout', `timeout after ${timeoutMs} ms`);
      throw new PmtilesError('network', `network error: ${e instanceof Error ? e.message : String(e)}`);
    } finally { clearTimeout(timer); }
  }

  /** @param {Uint8Array} b @param {number} compression */
  async function inflate(b, compression) {
    if (compression === 1 || compression === 0) return b;
    if (compression === 2) return gunzip(b);
    throw new PmtilesError('unsupported', `compression type ${compression} is not supported (only none and gzip)`);
  }

  return {
    stats,
    /** Read the header and root directory. Safe to call twice. */
    async open() {
      if (F) return F;
      const h = await range(0, HEADER_FETCH_BYTES);
      if (h.length < 127 || String.fromCharCode(...h.subarray(0, 7)) !== 'PMTiles' || h[7] !== 3) throw new PmtilesError('not_pmtiles', 'not a PMTiles v3 file');
      const f = { url: o.url, leaf: u64(h, 40), data: u64(h, 56), ic: h[97], tc: h[98], maxz: h[101], root: /** @type {any} */ (null) };
      const ro = u64(h, 8), rl = u64(h, 16);
      const key = `${o.url}|root`;
      let dir = dirCache.get(key);
      if (!dir) {
        let rb = ro + rl <= h.length ? h.slice(ro, ro + rl) : await range(ro, rl);
        rb = await inflate(rb, f.ic);
        try { dir = parseDirectory(rb); } catch (e) { throw e instanceof PmtilesError ? e : new PmtilesError('decode', 'bad root directory'); }
        dirCache.set(key, dir);
      }
      f.root = dir;
      F = f;
      return F;
    },
    get maxZoom() { return F?.maxz ?? null; },
    /** The raw (decompressed) tile bytes, or null when the file has no such tile. */
    async tile(/** @type {number} */ z, /** @type {number} */ x, /** @type {number} */ y) {
      const f = await this.open();
      const id = tileId(z, x, y);
      let E = f.root;
      for (let depth = 0; depth < MAX_DEPTH; depth++) {
        const e = findEntry(E, id);
        if (!e) return null;
        if (e.run > 0) return inflate(await range(f.data + e.off, e.len), f.tc);
        const key = `${o.url}|leaf|${e.off}`;
        let L = dirCache.get(key);
        if (!L) {
          const lb = await inflate(await range(f.leaf + e.off, e.len), f.ic);
          try { L = parseDirectory(lb); } catch (err) { throw err instanceof PmtilesError ? err : new PmtilesError('decode', 'bad leaf directory'); }
          dirCache.set(key, L);
          if (dirCache.size > 64) dirCache.delete(/** @type {string} */ (dirCache.keys().next().value));
        }
        E = L;
      }
      return null;
    },
  };
}

/**
 * Decode ONE layer of a Mapbox Vector Tile: its extent and features with properties and rings in tile units.
 * Ported from streetforge2d.html:13619-13630 (`PMT.layer`). Returns null when the tile has no layer of that name.
 * Feature `type`: 1 point, 2 line, 3 polygon. `rings` are in tile units; each outer ring is followed by its holes only by
 * winding (see decodePolygons).
 * @param {Uint8Array} b @param {string} want
 * @returns {{ext:number, features:Array<{type:number, props:Record<string,any>, rings:number[][][]}>}|null}
 */
export function decodeMvtLayer(b, want) {
  const p = pbReader(b), td = new TextDecoder(), zz = (/** @type {number} */ n) => (n % 2 ? -(n + 1) / 2 : n / 2);
  while (!p.end) {
    const [f, w] = p.tag();
    if (f !== 3) { p.skip(w); continue; }
    const q = pbReader(p.bytes());
    let name = '', ext = 4096;
    /** @type {string[]} */ const keys = [];
    /** @type {any[]} */ const vals = [];
    /** @type {Uint8Array[]} */ const feats = [];
    while (!q.end) {
      const [g, w2] = q.tag();
      if (g === 1) name = td.decode(q.bytes());
      else if (g === 2) feats.push(q.bytes());
      else if (g === 3) keys.push(td.decode(q.bytes()));
      else if (g === 4) {
        const v = pbReader(q.bytes());
        let val = null;
        while (!v.end) {
          const [h, w3] = v.tag();
          if (h === 1) val = td.decode(v.bytes()); else if (h === 2) val = v.f(4); else if (h === 3) val = v.f(8);
          else if (h === 4 || h === 5) val = v.vr(); else if (h === 6) val = zz(v.vr()); else if (h === 7) val = !!v.vr(); else v.skip(w3);
        }
        vals.push(val);
      } else if (g === 5) ext = q.vr(); else q.skip(w2);
    }
    if (name !== want) continue;
    return {
      ext,
      features: feats.map((fb) => {
        const r = pbReader(fb);
        let type = 0, tags = /** @type {number[]} */ ([]), geom = /** @type {number[]} */ ([]);
        while (!r.end) {
          const [h, w3] = r.tag();
          if (h === 2 || h === 4) { const s = pbReader(r.bytes()), o2 = /** @type {number[]} */ ([]); while (!s.end) o2.push(s.vr()); if (h === 2) tags = o2; else geom = o2; }
          else if (h === 3) type = r.vr(); else r.skip(w3);
        }
        /** @type {Record<string,any>} */ const props = {};
        for (let k = 0; k + 1 < tags.length; k += 2) props[keys[tags[k]]] = vals[tags[k + 1]];
        /** @type {number[][][]} */ const rings = [];
        let x = 0, y = 0, cur = /** @type {number[][]|null} */ (null);
        for (let k = 0; k < geom.length;) {
          const c = geom[k++], cmd = c & 7, n = c >>> 3;
          if (cmd === 7) { if (cur) rings.push(cur); cur = null; continue; }
          for (let j = 0; j < n && k + 1 < geom.length; j++) {
            x += zz(geom[k++]); y += zz(geom[k++]);
            if (cmd === 1) { if (cur) rings.push(cur); cur = [[x, y]]; } else if (cur) cur.push([x, y]);
          }
        }
        if (cur) rings.push(cur);
        return { type, props, rings };
      }),
    };
  }
  return null;
}

/**
 * Group a polygon feature's rings into polygons (outer ring + its holes) by winding: the first non-degenerate ring says which
 * way outer rings turn (streetforge2d.html:13652-13654). Pure.
 * @param {number[][][]} rings @returns {number[][][][]}  list of polygons, each [outer, ...holes]
 */
export function decodePolygons(rings) {
  const signed = (/** @type {number[][]} */ R) => { let a = 0; for (let i = 0, j = R.length - 1; i < R.length; j = i++) a += (R[i][0] - R[j][0]) * (R[i][1] + R[j][1]); return a; };
  let outerSign = 0;
  /** @type {number[][][][]} */ const polys = [];
  for (const R of rings) {
    if (R.length < 3) continue;
    const a = signed(R);
    if (!a) continue;
    if (!outerSign) outerSign = Math.sign(a);
    if (Math.sign(a) === outerSign) polys.push([R]); else if (polys.length) polys[polys.length - 1].push(R);
  }
  return polys;
}

/** Tile-unit point -> [lng, lat] (Web Mercator). @param {number} z @param {number} x @param {number} y @param {number} ext @param {number[]} p */
export function tilePointToLngLat(z, x, y, ext, p) {
  const n = 2 ** z, X = (x + p[0] / ext) / n, Y = (y + p[1] / ext) / n;
  return [X * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - 2 * Y))) * 180) / Math.PI];
}
