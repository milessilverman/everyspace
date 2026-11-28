// Everyspace "Your lot from above": the aerial photo of the lot with the outlines that were measured on top of it, which the owner can adjust.
// Dependency-free ES module (no map library). It draws into #lot-map and talks to the estimator page only through the two functions app.js hands
// it (getProfile, applyOwnerCorrections) plus clearOwnerCorrections, so it never reaches into app.js state and app.js never waits for it.
//
// THE FRAME. The picture is a "frame" whose logical size is Wd x Hd CSS pixels (re-measured on resize). The frame shows the box
// [west, south, east, north] in WGS84 degrees, which is the lot's box plus 15 m on every side. Mapping used everywhere (outlines, handles,
// tints, the canvas, the photo):
//     x = (lng - west)  / (east - west)  * Wd        y = (north - lat) / (north - south) * Hd
// Wd / Hd is the TRUE ground aspect, ((east - west) * cos(lat)) / (north - south), so one pixel is the same length east-west and north-south.
// THE PHOTO. One request to the USGS NAIP image service (core/providers/naip-aerial.js USGS_EXPORT) for exactly that box, in WGS84 (bboxSR and
// imageSR 4326), with the pixel grid in DEGREES square (Wr / Hr = (east - west) / (north - south)). Asking for square degree pixels means the
// service has nothing to adjust, so the image is the box stretched edge to edge. The <img> is then displayed in the true-aspect frame, which
// squeezes it east-west by cos(lat): that is the "pixel aspect corrected for latitude" and it is what makes outlines and photo line up.
// The photo is NAIP at about 60 cm per pixel, so it is soft when enlarged; the caption says so. If it does not load, nothing is said and the
// outlines sit on a plain background.
//
// NUMBERS. Every figure comes from core/measure.js measureFromGeometry, the same function the lookup's numbers can be reproduced with, so a dragged
// outline and the list cannot disagree. While dragging it runs once per animation frame (and backs off when a frame is slow); on release the
// figures that changed are pushed into the list through applyOwnerCorrections ("Edited by you" + Undo, as if typed).
// Core modules are imported lazily inside the page (dynamic import) so that a problem there can never stop the estimator itself from loading.

const R_EARTH = 6371008.8, RAD = Math.PI / 180, FT = 0.3048;
const MARGIN_M = 15;
const FRONT_OFFSET_M = 3; // the street line handed to the yard split runs this far outside the chosen lot edge
const SIDE_PX = { min: 480, max: 900 };
const USGS_EXPORT_FALLBACK = 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer/exportImage';
const CREDIT_FALLBACK = 'Aerial photo: USDA NAIP (US Government imagery)';
const SVGNS = 'http://www.w3.org/2000/svg';
const COMMIT_IDLE_MS = 350;
const DOUBLE_TAP_MS = 420;

// keys the map can change, and which ones each kind of change may touch (a number the owner typed is only overwritten when an outline it depends on moved)
const YARD_KEYS = ['front_yard_sqft', 'back_yard_sqft', 'yard_area_sqft', 'usable_yard_sqft', 'usable_front_yard_sqft', 'usable_back_yard_sqft'];
const AFFECTS = {
  lot: ['lot_area_sqft', ...YARD_KEYS],
  bld: ['building_footprint_sqft', 'roof_area_sqft', ...YARD_KEYS],
  front: YARD_KEYS,
};
const USABLE_KEYS = ['usable_yard_sqft', 'usable_front_yard_sqft', 'usable_back_yard_sqft'];
AFFECTS.lot.push('driveway_area_sqft'); AFFECTS.bld.push('driveway_area_sqft');
AFFECTS.drv = ['driveway_area_sqft', ...USABLE_KEYS];
AFFECTS.kind = [];
AFFECTS.yard = YARD_KEYS;
const ALL_KEYS = ['lot_area_sqft', 'building_footprint_sqft', 'roof_area_sqft', ...YARD_KEYS, 'driveway_area_sqft'];
/** What an outline other than the house can be called (the choice relabels it and tells the earnings logic about garages and guest houses). */
const WHAT = [['garage', 'Garage'], ['adu', 'ADU / guest house'], ['shed', 'Shed'], ['carport', 'Carport'], ['pool_house', 'Pool house'], ['other', 'Other']];
const WHAT_NAME = Object.fromEntries(WHAT);
/** Which area of the picture a list line is about (hover, focus or scrolling to the line lights that area up). */
const LINE_AREAS = { lot_area_sqft: ['lot'], roof_area_sqft: ['house'], building_footprint_sqft: ['house'], driveway_area_sqft: ['drv'], front_yard_sqft: ['front'], back_yard_sqft: ['back'],
  usable_yard_sqft: ['usable'], usable_front_yard_sqft: ['usable'], usable_back_yard_sqft: ['usable'], yard_area_sqft: ['front', 'back'], garage_area_sqft: ['garage'], adu_area_sqft: ['adu'] };
/** Lines that also get an "Edit on photo" button, and the area it edits. */
const LINE_EDIT = { lot_area_sqft: 'lot', roof_area_sqft: 'house', building_footprint_sqft: 'house', driveway_area_sqft: 'drv', front_yard_sqft: 'front', back_yard_sqft: 'back', garage_area_sqft: 'garage', adu_area_sqft: 'adu' };
/** The list line to bring into view when an area is tapped on the picture. */
const AREA_LINE = { lot: 'lot_area_sqft', house: 'roof_area_sqft', drv: 'driveway_area_sqft', front: 'front_yard_sqft', back: 'back_yard_sqft', usable: 'usable_yard_sqft', garage: 'garage_area_sqft', adu: 'adu_area_sqft' };
const AREA_LABEL = { lot: 'lot', house: 'house', drv: 'driveway', front: 'front yard', back: 'back yard', usable: 'usable yard' };
const WHAT_LOWER = { garage: 'garage', adu: 'ADU / guest house', shed: 'shed', carport: 'carport', pool_house: 'pool house', other: 'building' };
const SNAP_PX = 7;
const KIND_KEYS = ['garage_present', 'garage_area_sqft', 'adu_present', 'adu_area_sqft'];
const SLIVER_SQFT = 100;
const inPolyXY = (pts, x, y) => { let c = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const [xi, yi] = pts[i], [xj, yj] = pts[j]; if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
/** Driveway area on the lot and not under a building (sq ft), 0.25 m grid; used only when core/driveway.js cannot be loaded. */
export function drivewayAreaOwn(dv, lot, blds) {
  const d = ptsOfRing(dv.coordinates[0]), l = ptsOfRing(lot.coordinates[0]), bs = blds.map((b) => ptsOfRing(b.coordinates[0]));
  const { kx, ky } = metresPerDegree(d[0][1]);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of d) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
  const cell = 0.25; let n = 0;
  for (let y = y0 + (cell / ky) / 2; y < y1; y += cell / ky) for (let x = x0 + (cell / kx) / 2; x < x1; x += cell / kx) if (inPolyXY(d, x, y) && inPolyXY(l, x, y) && !bs.some((b) => inPolyXY(b, x, y))) n++;
  return Math.round(n * cell * cell * 10.763910416709722);
}

// ---------------------------------------------------------------------------------------------------------------
// pure helpers (exported for tests)
// ---------------------------------------------------------------------------------------------------------------
let VID = 0;
const cap = (t) => (t ? t[0].toUpperCase() + t.slice(1) : t);
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Equirectangular scale at a latitude: metres per degree of longitude and latitude (the same constants as core/geometry.js localProjection). */
export const metresPerDegree = (lat) => ({ kx: R_EARTH * Math.cos(lat * RAD) * RAD, ky: R_EARTH * RAD });

/** Do two segments cross or touch? (a1-a2 against b1-b2, points are [x, y]) */
function segHit(a1, a2, b1, b2) {
  const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const on = (p, q, r) => Math.min(p[0], q[0]) <= r[0] && r[0] <= Math.max(p[0], q[0]) && Math.min(p[1], q[1]) <= r[1] && r[1] <= Math.max(p[1], q[1]);
  const d1 = o(a1, a2, b1), d2 = o(a1, a2, b2), d3 = o(b1, b2, a1), d4 = o(b1, b2, a2);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  return (d1 === 0 && on(a1, a2, b1)) || (d2 === 0 && on(a1, a2, b2)) || (d3 === 0 && on(b1, b2, a1)) || (d4 === 0 && on(b1, b2, a2));
}
/** True when the ring (array of {lng, lat}) crosses itself, repeats a corner, or has no area. */
export function ringCrosses(verts) {
  const n = verts.length;
  if (n < 3) return true;
  const p = verts.map((v) => [v.lng, v.lat]);
  let area = 0;
  for (let i = 0; i < n; i++) area += p[i][0] * p[(i + 1) % n][1] - p[(i + 1) % n][0] * p[i][1];
  if (Math.abs(area) < 1e-18) return true;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue; // neighbours share a corner
      if (segHit(p[i], p[(i + 1) % n], p[j], p[(j + 1) % n])) return true;
    }
  }
  return false;
}

const outerOf = (g) => (g?.type === 'Polygon' ? g.coordinates : g?.type === 'MultiPolygon' ? (g.coordinates.reduce((a, c) => (ringArea(c[0]) > ringArea(a[0]) ? c : a))) : null);
function ringArea(r) { let a = 0; for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; a += p[0] * q[1] - q[0] * p[1]; } return Math.abs(a / 2); }
const ptsOfRing = (r) => {
  const out = [];
  for (const p of r) { if (!Array.isArray(p) || !num(p[0]) || !num(p[1])) continue; const q = out[out.length - 1]; if (q && q[0] === p[0] && q[1] === p[1]) continue; out.push([p[0], p[1]]); }
  if (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop();
  return out;
};

/**
 * What the map needs from a property profile: the builder's `profile.geometry` bundle when present, otherwise the same bundle built from
 * the profile's attributes (parcel_boundary, buildings, location, roof inputs). Pure. Returns null when there is no outline to show.
 * @param {any} profile
 */
export function sourceFromProfile(profile) {
  if (!profile) return null;
  const g = profile.geometry;
  if (g && typeof g === 'object' && (g.parcel || (Array.isArray(g.buildings) && g.buildings.length))) {
    const { parcel, parcelSource, buildings, image, driveway, zones: _z, ...rest } = g;
    const list = (buildings ?? []).filter((b) => b && (b.polygon || b.type)).map((b) => ({ polygon: b.polygon ?? b, main: Boolean(b.main), kind: typeof b.kind === 'string' ? b.kind : null }));
    return { from: 'bundle', parcel: parcel ?? null, parcelSource: parcel ? (parcelSource ?? 'record') : null, buildings: list, rest, image: image ?? null, driveway: driveway?.polygon ?? null, ref: g };
  }
  const a = profile.attributes ?? {};
  const val = (k) => (a[k] && a[k].tag !== 'unavailable' && a[k].value !== null && a[k].value !== undefined ? a[k].value : null);
  const parcel = val('parcel_boundary');
  const rows = val('buildings');
  const list = Array.isArray(rows) ? rows.filter((r) => r && r.polygon).map((r) => ({ polygon: r.polygon, main: false, sq: Number(r.footprintSqft) || 0 })) : [];
  if (!parcel && !list.length) return null;
  let mi = -1;
  list.forEach((b, i) => { if (mi < 0 || b.sq > list[mi].sq) mi = i; });
  if (mi >= 0) list[mi].main = true;
  const loc = val('location');
  const jur = val('jurisdiction');
  const rest = {
    roof: { yearBuilt: num(val('year_built')) ? val('year_built') : null, propertyType: typeof val('property_type') === 'string' ? val('property_type') : null, stories: num(val('floors')) ? val('floors') : null, state: jur && typeof jur.state === 'string' ? jur.state : null },
    ...(loc ? { frontPointHint: loc } : {}),
  };
  const ps = parcel ? (a.parcel_boundary?.tag === 'estimated' ? 'estimated' : 'record') : null;
  return { from: 'attributes', parcel: parcel ?? null, parcelSource: ps, buildings: list.map(({ polygon, main }) => ({ polygon, main, kind: null })), rest, image: null, driveway: null };
}

/** A simple starting lot around a building: its footprint plus 15 ft along its long axis and 5 ft across it. Returns a closed [lng, lat] ring or null. */
export function starterRing(buildingGeom) {
  const part = outerOf(buildingGeom);
  const ring = part ? ptsOfRing(part[0]) : [];
  if (ring.length < 3) return null;
  const lat0 = ring.reduce((s, p) => s + p[1], 0) / ring.length, lng0 = ring.reduce((s, p) => s + p[0], 0) / ring.length;
  const { kx, ky } = metresPerDegree(lat0);
  const xy = ring.map((p) => [(p[0] - lng0) * kx, (p[1] - lat0) * ky]);
  let best = null;
  for (let i = 0; i < xy.length; i++) {
    const a = xy[i], b = xy[(i + 1) % xy.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-6) continue;
    const ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const p of xy) { const u = p[0] * ux + p[1] * uy, v = -p[0] * uy + p[1] * ux; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area - 1e-9) best = { area, ux, uy, u0, u1, v0, v1 };
  }
  if (!best) return null;
  // the long side of the building's tightest box is the "front/back" direction (15 ft each end); the short side gets 5 ft each
  let { ux, uy, u0, u1, v0, v1 } = best;
  if (u1 - u0 < v1 - v0) { const t = [ux, uy]; ux = -t[1]; uy = t[0]; [u0, u1, v0, v1] = [v0, v1, -u1, -u0]; }
  u0 -= 15 * FT; u1 += 15 * FT; v0 -= 5 * FT; v1 += 5 * FT;
  const at = (u, v) => [lng0 + (u * ux - v * uy) / kx, lat0 + (u * uy + v * ux) / ky];
  const c = [at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)];
  c.push(c[0]);
  return c;
}

/**
 * Lng/lat <-> frame pixels for a backdrop whose picture covers [west, south, east, north]: 'wgs84' (linear in degrees, what NAIP is asked for) or
 * 'webmercator' (latitude through the Mercator formula), so a backdrop in either frame can sit under the same overlay. Only 'wgs84' is used today.
 */
export function frameProject(frame, bbox, W, H) {
  const [w, s, e, n] = bbox;
  const my = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * RAD) / 2));
  if (frame === 'webmercator') {
    const y0 = my(n), y1 = my(s);
    return {
      toPx: (lng, lat) => [((lng - w) / (e - w)) * W, ((y0 - my(lat)) / (y0 - y1)) * H],
      toLngLat: (x, y) => { const m = y0 - (y / H) * (y0 - y1); return [w + (x / W) * (e - w), (2 * Math.atan(Math.exp(m)) - Math.PI / 2) / RAD]; },
    };
  }
  return { toPx: (lng, lat) => [((lng - w) / (e - w)) * W, ((n - lat) / (n - s)) * H], toLngLat: (x, y) => [w + (x / W) * (e - w), n - (y / H) * (n - s)] };
}

/** The photo behind the outlines. Swappable: any source that can draw a box in one of the two frames and says who to credit. Only NAIP is used. */
export const NAIP_BACKDROP = {
  id: 'naip', frame: 'wgs84', credit: CREDIT_FALLBACK,
  /** @param {{bbox:number[], width:number, height:number}} q @param {string} [base] */
  imageUrl(q, base = USGS_EXPORT_FALLBACK) {
    const u = new URL(base);
    for (const [k, v] of Object.entries({ bbox: q.bbox.map((x) => x.toFixed(7)).join(','), bboxSR: '4326', imageSR: '4326', size: `${q.width},${q.height}`, format: 'jpg', bandIds: '0,1,2', interpolation: 'RSP_BilinearInterpolation', f: 'image' })) u.searchParams.set(k, v);
    return u.href;
  },
};

/** Image request for a box: WGS84, square degree pixels, about `longSide` px on the long side. Returns the URL. */
export function photoUrl(bbox, longSide, base = USGS_EXPORT_FALLBACK, backdrop = NAIP_BACKDROP) {
  const [w, s, e, n] = bbox;
  const ar = (e - w) / (n - s);
  const width = ar >= 1 ? longSide : Math.max(8, Math.round(longSide * ar)), height = ar >= 1 ? Math.max(8, Math.round(longSide / ar)) : longSide;
  return backdrop.imageUrl({ bbox, width, height }, base);
}

/** The frame box for a ring: its bounds plus the margin, and the true ground aspect. */
export function frameFor(ring) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const p of ring) { w = Math.min(w, p[0]); e = Math.max(e, p[0]); s = Math.min(s, p[1]); n = Math.max(n, p[1]); }
  const { kx, ky } = metresPerDegree((s + n) / 2);
  const bbox = [w - MARGIN_M / kx, s - MARGIN_M / ky, e + MARGIN_M / kx, n + MARGIN_M / ky];
  const aspect = ((bbox[2] - bbox[0]) * kx) / ((bbox[3] - bbox[1]) * ky);
  return { bbox, aspect, kx, ky };
}

/** Page layout hooks shared with the read-only picture: mark the property card as having a picture (two columns / pinned strip) and tell CSS how tall the header is. */
export function syncPicLayout(shown, editing = false) {
  try {
    document.getElementById('property')?.classList.toggle('has-pic', Boolean(shown));
    document.getElementById('property')?.classList.toggle('pic-editing', Boolean(shown && editing));
    const h = document.querySelector('header.top')?.getBoundingClientRect().height;
    document.documentElement.style.setProperty('--lm-top', `${Math.round(h || 56)}px`);
  } catch { /* layout only */ }
}

/**
 * The photo's box for a display of a given width/height ratio: the lot's box (plus 15 m) widened so the frame, whatever its shape, is filled
 * with photo, and tall enough for a tall frame (a phone, a taller strip) too. Never smaller than frameFor(ring).
 */
export function frameForDisplay(ring, containerAspect) {
  const f = frameFor(ring);
  const wm = (f.bbox[2] - f.bbox[0]) * f.kx, hm = (f.bbox[3] - f.bbox[1]) * f.ky;
  const A = Math.max(Number.isFinite(containerAspect) ? containerAspect : 1.2, 2.0);
  const W = Math.max(wm, hm * A), H = Math.max(hm, wm / 0.7);
  const cx = (f.bbox[0] + f.bbox[2]) / 2, cy = (f.bbox[1] + f.bbox[3]) / 2;
  const bbox = [cx - W / 2 / f.kx, cy - H / 2 / f.ky, cx + W / 2 / f.kx, cy + H / 2 / f.ky];
  return { bbox, aspect: W / H, kx: f.kx, ky: f.ky };
}

// ---------------------------------------------------------------------------------------------------------------
// the view
// ---------------------------------------------------------------------------------------------------------------
/**
 * @param {{getProfile:()=>any, applyOwnerCorrections:(b:Record<string,any>)=>any, clearOwnerCorrections:(keys:string[])=>any, mount:HTMLElement, now?:()=>string}} opts
 * @returns {{update:()=>void, hide:()=>void}}
 */
export function initLotMap(opts) {
  const { getProfile, applyOwnerCorrections, clearOwnerCorrections, mount } = opts;
  const now = opts.now ?? (() => new Date().toISOString());
  /** @type {any} */ let core = null;
  let coreState = 'idle';
  /** @type {any} */ let M = null; // the model for the property on screen
  let pushing = false, setupTimer = 0, layoutObs = null, suspended = false, pendingCommit = false;
  const mq = typeof matchMedia === 'function' ? matchMedia('(max-width: 899px)') : { matches: false, addEventListener() {} };
  const phone = () => mq.matches;
  const reduced = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
  const uid = 'lm';

  const loadCore = () => {
    if (coreState !== 'idle') return;
    coreState = 'loading';
    Promise.all([import('../core/measure.js'), import('../core/geometry.js'), import('../core/providers/naip-aerial.js').catch(() => ({})), import('../core/driveway.js').catch(() => ({}))])
      .then(([me, ge, na, dr]) => { core = { measure: me.measureFromGeometry, areaSqft: ge.polygonAreaSqft, drvArea: dr.drivewayAreaSqft ?? null, aware: false, usgs: na.USGS_EXPORT ?? USGS_EXPORT_FALLBACK, credit: na.ATTRIBUTION_TEXT ?? CREDIT_FALLBACK }; coreState = 'ready'; update(); })
      .catch(() => { coreState = 'none'; mount.hidden = true; });
  };

  // ----- model --------------------------------------------------------------------------------------------------
  const sigOf = (g) => {
    const rings = [];
    const walk = (c) => { if (typeof c[0] === 'number') { rings.push(c); } else for (const x of c) walk(x); };
    try { walk(g?.coordinates ?? []); } catch { /* ignore */ }
    let sx = 0, sy = 0; for (const p of rings) { sx += p[0]; sy += p[1]; }
    return `${rings.length}:${sx.toFixed(7)}:${sy.toFixed(7)}`;
  };
  const makeShape = (geom, kind, main, name) => {
    const parts = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
    let ei = 0, ea = -1;
    parts.forEach((p, i) => { const a = ringArea(p[0]); if (a > ea) { ea = a; ei = i; } });
    const pts = ptsOfRing(parts[ei][0]);
    return { id: kind === 'lot' ? 'lot' : kind === 'drv' ? 'drv' : kind === 'yard' ? name : `bld${VID++}`, kind, main, name, what: null, whatSrc: null, removed: false, touched: false, geomType: geom.type, parts: parts.map((p) => p.map((r) => r.map((q) => [q[0], q[1]]))), ei, verts: pts.map(([lng, lat]) => ({ id: ++VID, lng, lat })) };
  };
  const toGeo = (sh) => {
    const ring = sh.verts.map((v) => [v.lng, v.lat]); ring.push([sh.verts[0].lng, sh.verts[0].lat]);
    const parts = sh.parts.map((p, i) => (i === sh.ei ? [ring, ...p.slice(1)] : p));
    return sh.geomType === 'Polygon' ? { type: 'Polygon', coordinates: parts[0] } : { type: 'MultiPolygon', coordinates: parts };
  };
  const cloneShape = (sh) => ({ ...sh, parts: sh.parts.map((p) => p.map((r) => r.map((q) => [q[0], q[1]]))), verts: sh.verts.map((v) => ({ ...v })) });
  const snap = () => ({ lot: M.lot ? M.lot.verts.map((v) => ({ ...v })) : null, drv: M.drv ? cloneShape(M.drv) : null, blds: M.blds.map(cloneShape), front: M.frontIds ? [...M.frontIds] : null, frontSet: M.frontSet,
    yards: { front: M.yards.front ? cloneShape(M.yards.front) : null, back: M.yards.back ? cloneShape(M.yards.back) : null }, later: M.yardLater });
  const restore = (s) => {
    if (M.lot && s.lot) M.lot.verts = s.lot.map((v) => ({ ...v }));
    M.drv = s.drv ? cloneShape(s.drv) : null;
    M.blds = s.blds.map(cloneShape);
    M.yards = { front: s.yards?.front ? cloneShape(s.yards.front) : null, back: s.yards?.back ? cloneShape(s.yards.back) : null }; M.yardLater = s.later ?? 'back';
    M.frontIds = s.front ? [...s.front] : null; M.frontSet = s.frontSet;
  };
  const live = () => M.blds.filter((b) => !b.removed);

  /** the front line handed to the yard split: the chosen lot corners, pushed 3 m outward so it reads as the street in front of that side */
  const frontLine = (ids) => {
    const vs = ids.map((id) => M.lot.verts.find((v) => v.id === id)).filter(Boolean);
    if (vs.length < 2) return null;
    const { kx, ky } = metresPerDegree(vs[0].lat);
    const c = M.lot.verts.reduce((s, v) => [s[0] + v.lng / M.lot.verts.length, s[1] + v.lat / M.lot.verts.length], [0, 0]);
    const a = vs[0], b = vs[vs.length - 1];
    let nx = (b.lat - a.lat) * ky, ny = -(b.lng - a.lng) * kx; // right of a->b in metres
    const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l;
    const toC = [(c[0] - a.lng) * kx, (c[1] - a.lat) * ky];
    if (nx * toC[0] + ny * toC[1] > 0) { nx = -nx; ny = -ny; } // make it point away from the lot's middle
    return vs.map((v) => [v.lng + (nx * FRONT_OFFSET_M) / kx, v.lat + (ny * FRONT_OFFSET_M) / ky]);
  };

  const bundle = () => {
    const rest = { ...M.rest };
    if (M.source === 'attributes') {
      const p = getProfile(); const a = p?.attributes ?? {};
      const v = (k) => (a[k] && a[k].tag !== 'unavailable' ? a[k].value : null);
      rest.roof = { yearBuilt: num(v('year_built')) ? v('year_built') : null, propertyType: typeof v('property_type') === 'string' ? v('property_type') : null, stories: num(v('floors')) ? v('floors') : null, state: rest.roof?.state ?? null };
    }
    const g = { ...rest, parcel: M.lot ? toGeo(M.lot) : null, buildings: live().map((b) => ({ polygon: toGeo(b), main: b.main, kind: b.what ?? null })) };
    const yf = M.yards.front && !M.yards.front.inert ? M.yards.front : null, yb = M.yards.back && !M.yards.back.inert ? M.yards.back : null;
    if (yf || yb) g.yards = { ...(yf ? { front: toGeo(yf) } : {}), ...(yb ? { back: toGeo(yb) } : {}), later: M.yardLater };
    if (M.drv) { const dg = toGeo(M.drv); g.driveway = dg; if (!core.aware && M.drv.touched) g.exclude = [...(rest.exclude ?? []), dg]; } // core without driveway support: keep the owner's driveway out of the usable yard here
    if (M.frontIds && M.lot) { const l = frontLine(M.frontIds); if (l) { g.streets = []; g.streetName = null; g.frontPoint = null; g.frontEdge = { coordinates: l }; } }
    return g;
  };
  function drivewayArea() {
    const dg = toGeo(M.drv), lg = toGeo(M.lot), bg = live().map(toGeo);
    try { if (core.drvArea) { const v = core.drvArea(dg, lg, bg); if (num(v)) return v; } } catch { /* use ours */ }
    try { return drivewayAreaOwn(dg, lg, bg); } catch { return null; }
  }
  const measureNow = () => {
    const t0 = performance.now();
    let m = null;
    try {
      m = core.measure(bundle(), { now: now() });
      if (m && 'driveway_area_sqft' in m) core.aware = true; // the core measures driveways itself
      if (m && !num(m.driveway_area_sqft)) m.driveway_area_sqft = M.drv ? drivewayArea() : null;
    } catch { m = null; }
    M.lastMs = performance.now() - t0;
    return m;
  };

  /** with no street data on the page (the lookup's bundle absent), find which lot side the lookup treated as the front by matching its front/back yard numbers */
  const inferFront = () => {
    const a = getProfile()?.attributes ?? {};
    const f0 = a.front_yard_sqft, b0 = a.back_yard_sqft;
    if (!M.lot || !f0 || !b0 || f0.tag === 'owner-confirmed' || b0.tag === 'owner-confirmed' || !num(f0.value) || !num(b0.value)) return null;
    const vs = M.lot.verts; let best = null;
    for (let i = 0; i < vs.length; i++) {
      const ids = [vs[i].id, vs[(i + 1) % vs.length].id];
      M.frontIds = ids;
      const m = measureNow();
      if (!m || !num(m.front_yard_sqft) || !num(m.back_yard_sqft)) continue;
      const err = Math.abs(m.front_yard_sqft - f0.value) + Math.abs(m.back_yard_sqft - b0.value);
      if (!best || err < best.err) best = { err, ids };
    }
    M.frontIds = null;
    return best && best.err <= 2 ? best.ids : null;
  };

  const readSource = () => {
    const p = getProfile();
    return p ? sourceFromProfile(p) : null;
  };

  /** An apartment building's roof is only an estimate once the owner has given the roof type: until the list has a roof figure, the picture shows none. */
  const roofShown = () => { const a = getProfile()?.attributes ?? {}; if (a.property_type?.value !== 'multi_family') return true; const r = a.roof_area_sqft; return Boolean(r && r.tag !== 'unavailable' && r.value !== null && r.value !== undefined); };
  const areaOf = (sh) => { try { return core.areaSqft(toGeo(sh)); } catch { return 0; } };
  /** a tiny outline that is not the house: still measured, but no handles of its own and no legend line */
  const isSliver = (sh) => sh.kind === 'bld' && !sh.main && !sh.what && areaOf(sh) < SLIVER_SQFT;
  /** exactly one house: the one the lookup flagged, unless it is a sliver and something bigger exists; with none flagged, the largest */
  function pickMain() {
    if (!M.blds.length) return;
    const areas = M.blds.map(areaOf);
    let mi = M.blds.findIndex((b) => b.main && !b.removed);
    const big = areas.reduce((bi, a, i) => (a > areas[bi] ? i : bi), 0);
    if (mi < 0 || (areas[mi] < SLIVER_SQFT && areas[big] >= SLIVER_SQFT)) mi = big;
    M.blds.forEach((b, i) => { b.main = i === mi; });
  }
  /** the lookup's own measurement (street lines, front side, roof inputs) arrived after the map was set up from attributes: adopt it */
  /** what the lookup's own outlines measure (the numbers a typed-over line and Reset go back to) */
  function baselineMeasure() { const cur = snap(); restore(M.base); const m = measureNow(); restore(cur); return m; }
  function adoptBundle(src) {
    M.bundleRef = src.ref;
    M.source = 'bundle'; M.rest = src.rest;
    if (src.parcelSource && !M.starter) M.parcelSource = src.parcelSource;
    if (src.image) { M.imageInfo = src.image; if (M.imgState === 'ok') showCredit(); }
    if (!M.frontSet) { M.frontIds = null; }
    M.baseFront = null; if (M.base) { M.base.front = null; M.base.frontSet = false; }
    if (src.driveway && !(M.drv && M.drv.touched) && !(M.base && M.base.drv)) { try { M.drv = makeShape(src.driveway, 'drv', false, 'Driveway'); if (M.base) M.base.drv = cloneShape(M.drv); } catch { /* keep none */ } }
    for (const b of M.blds) { const sb = src.buildings.find((x) => sigOf(x.polygon) === sigOf(toGeo(b))); if (sb?.kind && !b.main && b.whatSrc !== 'owner') { b.what = sb.kind; b.whatSrc = 'lookup'; } }
    if (M.base) for (const bb of M.base.blds) { const sb = src.buildings.find((x) => sigOf(x.polygon) === sigOf(toGeo(bb))); if (sb?.kind && !bb.main) { bb.what = sb.kind; bb.whatSrc = 'lookup'; } }
    if (M.starter) return;
    M.m = measureNow(); M.baseM = baselineMeasure();
    if (M.edited && !M.drag) { // the owner already moved an outline: the lookup's street side now gives it front and back figures, so the list gets them too
      setTimeout(() => { if (M && !M.drag) { M.gestureBefore = snap(); commit('front'); } }, 0);
    } else M.lastMeasure = M.m;
    // the bundle can bring outlines the picture has no elements for yet (the driveway): build them before drawing,
    // but never while a corner is being dragged (rebuilding would drop the drag) — then it is done when the drag ends
    if (D.body) { D.sub.textContent = subline(); if (M.drag) M.needStructure = true; else { structure(); M.needStructure = false; } paint(true); }
  }

  function setup(src) {
    const sigP = src.parcel ? sigOf(src.parcel) : 'none';
    const m0 = { sigP, sigB: src.buildings.map((b) => sigOf(b.polygon)).join('|') };
    M = {
      ...m0, source: src.from, rest: src.rest, parcelSource: src.parcelSource, starter: false, lot: null, blds: [], drv: null, baseM: null, tip: '', yards: { front: null, back: null }, yardLater: 'back', edit: null, pick: null, hl: null, view: { x: 0, y: 0, z: 1 }, big: false, frontIds: null, frontSet: false, base: null, baseFront: null,
      history: [], mapKeys: new Map(), gestureBefore: null, edited: false, sel: null, m: null, lastMeasure: null, lastMs: 0, note: '', image: null, imgState: 'idle', imageInfo: src.image,
      Wd: 0, Hd: 0, frame: null, drag: null, lastTap: null, bundleRef: src.ref ?? null,
    };
    try {
      src.buildings.forEach((b) => { try { const sh = makeShape(b.polygon, 'bld', b.main, b.main ? 'House' : 'Building'); if (b.kind && !b.main) { sh.what = b.kind; sh.whatSrc = 'lookup'; } M.blds.push(sh); } catch { /* skip an outline that is not a polygon */ } });
      pickMain();
      if (src.driveway) { try { M.drv = makeShape(src.driveway, 'drv', false, 'Driveway'); } catch { M.drv = null; } }
      if (src.parcel) M.lot = makeShape(src.parcel, 'lot', false, 'Lot');
      else {
        const main = M.blds.find((b) => b.main);
        const ring = main ? starterRing(toGeo(main)) : null;
        if (ring) { M.lot = makeShape({ type: 'Polygon', coordinates: [ring] }, 'lot', false, 'Lot'); M.starter = true; }
      }
    } catch { M = null; return false; }
    if (!M.lot) { M = null; return false; }
    M.frame = frameFor(M.lot.verts.map((v) => [v.lng, v.lat])); M.wm = (M.frame.bbox[2] - M.frame.bbox[0]) * M.frame.kx;
    const hasRef = (M.rest.streets && M.rest.streets.length) || M.rest.frontEdge || M.rest.frontPoint;
    if (!hasRef && !M.starter) { const ids = inferFront(); if (ids) { M.frontIds = ids; M.baseFront = ids; } }
    M.base = snap();
    M.m = measureNow();
    M.lastMeasure = M.m; M.baseM = M.m;
    return true;
  }

  // ----- DOM ----------------------------------------------------------------------------------------------------
  /** @type {any} */ const D = {};
  const svgEl = (name, attrs = {}, parent = null) => { const e = document.createElementNS(SVGNS, name); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); if (parent) parent.append(e); return e; };
  const html = (tag, attrs = {}, text = null, parent = null) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); if (text !== null) e.textContent = text; if (parent) parent.append(e); return e; };

  function build() {
    mount.textContent = '';
    mount.className = 'lm';
    mount.setAttribute('role', 'region');
    mount.setAttribute('aria-labelledby', `${uid}-title`);
    const head = html('div', { class: 'lm-head' }, null, mount); D.head = head;
    const tw = html('div', { class: 'lm-titlewrap' }, null, head);
    html('h3', { id: `${uid}-title`, class: 'lm-title' }, 'Your lot from above', tw);
    D.sub = html('p', { class: 'lm-sub small muted', id: `${uid}-sub` }, '', tw);
    const hb = html('div', { class: 'lm-headbtns' }, null, head);
    D.bSize = html('button', { type: 'button', class: 'btn sm lm-sizebtn', id: `${uid}-size`, 'aria-pressed': 'false' }, 'Bigger', hb);
    D.toggle = html('button', { type: 'button', class: 'btn sm', id: `${uid}-toggle`, 'aria-expanded': 'true', 'aria-controls': `${uid}-body` }, 'Hide photo', hb);
    D.body = html('div', { id: `${uid}-body`, class: 'lm-body' }, null, mount);
    D.stage = html('div', { class: 'lm-stage' }, null, D.body);
    D.frame = html('div', { class: 'lm-frame' }, null, D.stage);
    D.img = html('img', { class: 'lm-img', alt: '', 'aria-hidden': 'true', decoding: 'async', referrerpolicy: 'no-referrer', draggable: 'false', hidden: '' }, null, D.frame);
    D.canvas = html('canvas', { class: 'lm-canvas', 'aria-hidden': 'true' }, null, D.frame);
    D.svg = svgEl('svg', { class: 'lm-svg', role: 'group', 'aria-label': 'Outlines of your lot and buildings on the photo. Each corner can be dragged or moved with the arrow keys.', 'aria-describedby': `${uid}-keys` }, D.frame);
    D.defs = svgEl('defs', {}, D.svg);
    defsMarkup(D.defs);
    const cp = svgEl('clipPath', { id: `${uid}-lotclip` }, D.defs); D.clipLot = svgEl('path', {}, cp);
    D.gZC = svgEl('g', { 'clip-path': `url(#${uid}-lotclip)` }, D.svg); // a yard outline the owner drew never shows outside the lot
    D.gZones = svgEl('g', { mask: `url(#${uid}-bmask)` }, D.gZC);
    D.zFront = svgEl('path', { class: 'lm-zone', 'data-area': 'front', fill: `url(#${uid}-pf)`, 'fill-rule': 'evenodd' }, D.gZones);
    D.zBack = svgEl('path', { class: 'lm-zone', 'data-area': 'back', fill: `url(#${uid}-pb)`, 'fill-rule': 'evenodd' }, D.gZones);
    D.gDrvFill = svgEl('g', { 'clip-path': `url(#${uid}-lotclip)` }, D.svg); // the driveway never shows outside the lot or under a building
    D.gDrvMask = svgEl('g', { mask: `url(#${uid}-bmask)` }, D.gDrvFill);
    D.drvFill = svgEl('path', { class: 'lm-drvfill', 'data-area': 'drv', fill: `url(#${uid}-pd)` }, D.gDrvMask);
    D.gShapes = svgEl('g', {}, D.svg);
    D.gFront = svgEl('g', { class: 'lm-frontline' }, D.svg);
    D.gLabels = svgEl('g', { class: 'lm-labels', 'aria-hidden': 'true' }, D.svg);
    D.gAreas = svgEl('g', { class: 'lm-areas' }, D.svg); // what a tap picks at rest: one transparent shape per area
    D.hitFront = svgEl('path', { class: 'lm-area', 'data-area': 'front' });
    D.hitBack = svgEl('path', { class: 'lm-area', 'data-area': 'back' });
    D.gEdges = svgEl('g', {}, D.svg);
    D.gPlus = svgEl('g', {}, D.svg);
    D.gHandles = svgEl('g', {}, D.svg);
    D.canvas.dataset.area = 'usable';
    D.frame.append(D.canvas); // the hatched usable yard sits over the tints (it ignores the pointer, so corners stay draggable)
    html('p', { id: `${uid}-keys`, class: 'sr-only' }, 'Arrow keys move the corner 1 foot. Shift and an arrow key move it 5 feet. Delete removes it.', D.body);
    D.credit = html('p', { class: 'lm-credit tiny muted', hidden: '' }, '', D.body);
    D.pickBar = html('div', { class: 'lm-pick', hidden: '', role: 'group', 'aria-label': 'Selected area' }, null, D.body);
    D.pickText = html('span', { class: 'lm-picktext small' }, '', D.pickBar);
    D.bPickEdit = html('button', { type: 'button', class: 'btn sm primary', id: `${uid}-pick-edit`, 'data-lm': 'pickedit' }, 'Edit', D.pickBar);
    D.bPickX = html('button', { type: 'button', class: 'linkbtn', id: `${uid}-pick-x`, 'data-lm': 'pickclear' }, 'Close', D.pickBar);
    D.editBar = html('div', { class: 'lm-editbar', hidden: '', role: 'group', 'aria-label': 'Editing tools' }, null, D.body);
    const eh = html('div', { class: 'lm-edithead' }, null, D.editBar);
    D.editMsg = html('p', { class: 'lm-editmsg', id: `${uid}-editmsg`, role: 'status', 'aria-live': 'polite' }, '', eh);
    D.live = html('span', { class: 'lm-live', id: `${uid}-live` }, '', eh);
    D.editBtns = html('div', { class: 'lm-editbtns' }, null, D.editBar);
    D.bDone = html('button', { type: 'button', class: 'btn sm primary', id: `${uid}-done`, 'data-lm': 'done' }, 'Done', D.editBtns);
    D.bUndo = html('button', { type: 'button', class: 'btn sm', id: `${uid}-undo`, 'data-lm': 'undo' }, 'Undo', D.editBtns);
    D.bResetArea = html('button', { type: 'button', class: 'btn sm', id: `${uid}-resetarea`, 'data-lm': 'resetarea' }, 'Reset this area', D.editBtns);
    D.bZoom = html('button', { type: 'button', class: 'btn sm', id: `${uid}-zoom`, 'data-lm': 'zoom' }, 'Zoom out', D.editBtns);
    D.bFront = html('button', { type: 'button', class: 'btn sm', id: `${uid}-bfront`, 'data-lm': 'front', hidden: '' }, 'This side faces the street', D.editBtns);
    D.bAdd = html('button', { type: 'button', class: 'btn sm', id: `${uid}-badd`, 'data-lm': 'add', hidden: '' }, 'Add a corner', D.editBtns);
    D.bRemove = html('button', { type: 'button', class: 'btn sm', id: `${uid}-bremove`, 'data-lm': 'remove', hidden: '' }, 'Remove corner', D.editBtns);
    D.kindWrap = html('label', { class: 'lm-kindwrap small', hidden: '' }, null, D.editBtns);
    D.kindWrap.append(document.createTextNode('What is this? '));
    D.kindSel = html('select', { class: 'lm-what', id: `${uid}-kind-bar`, 'aria-label': 'What is this building?' }, null, D.kindWrap);
    D.bRmDrv = html('button', { type: 'button', class: 'btn sm', id: `${uid}-brmdrv`, 'data-lm': 'rmdrv', hidden: '' }, 'Remove driveway', D.editBtns);
    D.overlap = html('p', { class: 'lm-overlap small muted', hidden: '' }, 'If the front and back yards overlap, the one you changed last keeps the overlap.', D.editBar);
    D.actions = html('div', { class: 'lm-actions', role: 'group', 'aria-label': 'Outline tools' }, null, D.body);
    D.bAddBld = html('button', { type: 'button', class: 'btn sm', id: `${uid}-baddbld`, 'data-lm': 'addbld' }, 'Add a building', D.actions);
    D.bReset = html('button', { type: 'button', class: 'btn sm', id: `${uid}-breset`, 'data-lm': 'reset', hidden: '' }, 'Reset everything', D.actions);
    D.noteEl = html('p', { class: 'lm-note small', id: `${uid}-note`, role: 'status', 'aria-live': 'polite' }, '', D.body);
    D.legend = html('ul', { class: 'lm-legend', 'aria-label': 'Sizes of the outlines' }, null, D.body);
    D.hintDrv = html('p', { class: 'lm-tip small muted', hidden: '' }, 'Drag the corners to match your driveway', D.body);
    D.hintUnknown = html('p', { class: 'lm-tip small muted', hidden: '' }, 'Choose the side of your lot that faces the street to see the front and back yard.', D.body);
    D.sr = html('p', { class: 'sr-only', id: `${uid}-sr`, role: 'status', 'aria-live': 'polite' }, '', D.body);

    D.toggle.addEventListener('click', () => {
      const open = D.body.hidden;
      D.body.hidden = !open;
      D.toggle.textContent = open ? 'Hide photo' : 'Show photo of my lot';
      D.toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) { layout(); paint(true); }
    });
    D.svg.addEventListener('pointerdown', onDown);
    D.svg.addEventListener('pointermove', onMove);
    D.svg.addEventListener('pointerup', onUp);
    D.svg.addEventListener('pointercancel', onUp);
    D.svg.addEventListener('touchstart', (e) => { if (e.target.closest?.('.lm-h')) e.preventDefault(); }, { passive: false }); // a corner drag by touch must not scroll the page
    D.svg.addEventListener('keydown', onKey);
    D.svg.addEventListener('focusin', onFocusIn);
    D.actions.addEventListener('click', onAction);
    D.editBar.addEventListener('click', onAction);
    D.pickBar.addEventListener('click', onAction);
    D.legend.addEventListener('click', onAction);
    D.bSize.addEventListener('click', () => { setBig(!M.big, true); });
    D.body.addEventListener('change', onWhat);
    D.img.addEventListener('load', () => { if (!M) return; M.imgState = 'ok'; D.img.hidden = false; showCredit(); });
    D.img.addEventListener('error', () => { if (!M) return; M.imgState = 'none'; D.img.hidden = true; D.img.removeAttribute('src'); D.credit.hidden = true; });
    if (typeof ResizeObserver === 'function') { layoutObs?.disconnect(); layoutObs = new ResizeObserver(() => { if (M && !D.body.hidden && D.stage.clientWidth && Math.abs(D.stage.clientWidth - (M.stageW ?? 0)) > 1) { layout(); paint(true); } }); layoutObs.observe(D.stage); }
  }

  function defsMarkup(defs) {
    const mask = svgEl('mask', { id: `${uid}-bmask`, maskUnits: 'userSpaceOnUse' }, defs);
    D.maskBg = svgEl('rect', { x: 0, y: 0, width: 10, height: 10, fill: '#fff' }, mask);
    D.maskG = svgEl('g', { fill: '#000' }, mask);
    const pf = svgEl('pattern', { id: `${uid}-pf`, width: 8, height: 8, patternUnits: 'userSpaceOnUse' }, defs);
    svgEl('rect', { width: 8, height: 8, fill: '#38bdf8', 'fill-opacity': '.34' }, pf);
    svgEl('circle', { cx: 4, cy: 4, r: 1.5, fill: '#ffffff', stroke: '#075985', 'stroke-width': '.7' }, pf);
    const pb = svgEl('pattern', { id: `${uid}-pb`, width: 8, height: 8, patternUnits: 'userSpaceOnUse' }, defs);
    svgEl('rect', { width: 8, height: 8, fill: '#c084fc', 'fill-opacity': '.34' }, pb);
    svgEl('path', { d: 'M-1 9 L9 -1 M-1 1 L1 -1 M7 9 L9 7', stroke: '#6b21a8', 'stroke-width': '1.6', fill: 'none' }, pb);
    const pd = svgEl('pattern', { id: `${uid}-pd`, width: 8, height: 8, patternUnits: 'userSpaceOnUse' }, defs);
    svgEl('rect', { width: 8, height: 8, fill: '#00e5ff', 'fill-opacity': '.30' }, pd);
    svgEl('path', { d: 'M0 2 H8 M0 6 H8', stroke: '#0e7490', 'stroke-width': '1.4', fill: 'none' }, pd);
    const pu = svgEl('pattern', { id: `${uid}-pu`, width: 8, height: 8, patternUnits: 'userSpaceOnUse' }, defs);
    svgEl('rect', { width: 8, height: 8, fill: '#ffffff', 'fill-opacity': '.28' }, pu);
    svgEl('path', { d: 'M-1 -1 L9 9 M-1 7 L1 9 M7 -1 L9 1', stroke: '#111827', 'stroke-width': '2.6', 'stroke-opacity': '.6', fill: 'none' }, pu);
    svgEl('path', { d: 'M-1 -1 L9 9 M-1 7 L1 9 M7 -1 L9 1', stroke: '#ffffff', 'stroke-width': '1.3', fill: 'none' }, pu);
  }

  // ----- layout / structure ------------------------------------------------------------------------------------
  // THE PICTURE'S SPACES. The photo covers a "world" of WW x HH units (HH = 1000, WW from the box's true ground aspect); one world unit is the
  // same length east-west and north-south. The frame (what is on screen, Wd x Hd px) shows a window onto it: M.view = {cx, cy, sc} = the world
  // point at the frame's middle and screen pixels per world unit. Screen x = (X - cx) * sc + Wd / 2, and the same for y.
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const headerH = () => Math.round(document.querySelector('header.top')?.getBoundingClientRect().height || 56);
  /** how tall the frame can be: the room under the header, less the title row and (while editing) the bar */
  function frameHeight() {
    const ph = phone(), ih = window.innerHeight || 800, top = headerH();
    const headH = (D.head?.offsetHeight || 44), barH = M.edit && !D.editBar.hidden ? D.editBar.offsetHeight + 12 : 0, creditH = D.credit && !D.credit.hidden ? D.credit.offsetHeight + 10 : 0;
    if (M.edit) return Math.round(clamp(ih - top - headH - barH - creditH - (ph ? 78 : 42), 240, 880)); // the whole picture and the bar fit the screen together
    if (ph) return Math.round(M.big ? Math.max(260, ih * 0.5) : Math.max(110, ih * 0.3 - 46));
    return Math.round(clamp(ih - top - 200, 300, 760));
  }
  function layout() {
    if (!M) return;
    const ph = phone();
    mount.classList.toggle('lm-phone', ph); mount.classList.toggle('lm-compact', ph && !M.big && !M.edit); mount.classList.toggle('lm-big', ph && (M.big || Boolean(M.edit)));
    const cw = D.stage.clientWidth || mount.clientWidth || 600;
    M.stageW = cw;
    const Wd = Math.max(80, Math.floor(cw)), Hd = frameHeight();
    M.Wd = Wd; M.Hd = Hd; M.proj = null;
    M.WW = Math.round(1000 * M.frame.aspect * 100) / 100; M.HH = 1000; M.upm = M.WW / M.wm;
    D.frame.style.width = `${Wd}px`; D.frame.style.height = `${Hd}px`;
    D.svg.setAttribute('viewBox', `0 0 ${Wd} ${Hd}`);
    D.svg.setAttribute('width', String(Wd)); D.svg.setAttribute('height', String(Hd));
    D.maskBg.setAttribute('width', String(Wd)); D.maskBg.setAttribute('height', String(Hd));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    D.canvas.width = Math.round(Wd * dpr); D.canvas.height = Math.round(Hd * dpr);
    D.frame.dataset.bbox = M.frame.bbox.map((v) => v.toFixed(9)).join(',');
    D.frame.dataset.size = `${Wd}x${Hd}`; D.frame.dataset.world = `${M.WW},${M.HH}`;
    D.bSize.hidden = !ph;
    M.view = M.edit && M.edit.area !== 'street' && M.edit.zoomed !== false && areaShape(M.edit.area) ? viewFor(areaShape(M.edit.area)) : restView();
    applyView();
  }

  const proj = () => M.proj ?? (M.proj = frameProject(NAIP_BACKDROP.frame, M.frame.bbox, M.WW, M.HH));
  /** lng/lat <-> screen pixels of the frame, through the world and the current view */
  const px = (lng, lat) => { const [X, Y] = proj().toPx(lng, lat); const v = M.view; return [(X - v.cx) * v.sc + M.Wd / 2, (Y - v.cy) * v.sc + M.Hd / 2]; };
  const inv = (x, y) => { const v = M.view; return proj().toLngLat((x - M.Wd / 2) / v.sc + v.cx, (y - M.Hd / 2) / v.sc + v.cy); };
  const worldBox = (sh) => { const pts = sh.verts.map((q) => proj().toPx(q.lng, q.lat)); const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]); return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys), pts }; };
  /** the window that shows a box with a margin (world units), no more than `capPxPerM` pixels per metre, kept inside the photo where it fits */
  function windowFor(box, marginW, capPxPerM, minSc = 0) {
    const bw = Math.max(1e-6, box.x1 - box.x0), bh = Math.max(1e-6, box.y1 - box.y0);
    let sc = Math.min(M.Wd / (bw + 2 * marginW), M.Hd / (bh + 2 * marginW));
    if (capPxPerM) sc = Math.min(sc, capPxPerM / M.upm);
    sc = Math.max(sc, minSc);
    const ww = M.Wd / sc, wh = M.Hd / sc;
    let cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
    cx = ww >= M.WW ? M.WW / 2 : clamp(cx, ww / 2, M.WW - ww / 2); cy = wh >= M.HH ? M.HH / 2 : clamp(cy, wh / 2, M.HH - wh / 2);
    return { cx, cy, sc };
  }
  /** nothing being edited: the lot with 15 m round it; on a phone's compact strip the photo cropped close to the lot */
  const restView = () => (M.lot && M.Wd ? windowFor(worldBox(M.lot), (phone() && !M.big ? 3 : 15) * M.upm) : { cx: (M.WW ?? 1000) / 2, cy: 500, sc: 1 });
  const zoomed = () => M.view.sc > restView().sc * 1.06;
  function applyView() {
    const v = M.view;
    D.img.style.width = `${M.WW}px`; D.img.style.height = `${M.HH}px`;
    D.img.style.transform = `translate(${(M.Wd / 2 - v.cx * v.sc).toFixed(2)}px, ${(M.Hd / 2 - v.cy * v.sc).toFixed(2)}px) scale(${v.sc})`;
    D.frame.dataset.zoom = (v.sc / restView().sc).toFixed(2); D.frame.dataset.view = `${v.cx.toFixed(3)},${v.cy.toFixed(3)},${v.sc.toFixed(5)}`;
  }
  /** the window that fits one area with a margin; if two corners would sit closer than ~46 px, zoom in further (as far as the whole area still fits) */
  function viewFor(sh) {
    const box = worldBox(sh), bw = Math.max(1e-6, box.x1 - box.x0), bh = Math.max(1e-6, box.y1 - box.y0);
    const pad = Math.max(bw, bh) * 0.14 + 1.5 * M.upm;
    let v = windowFor(box, pad, 45);
    let minD = Infinity;
    for (let i = 0; i < box.pts.length; i++) for (let j = i + 1; j < box.pts.length; j++) minD = Math.min(minD, Math.hypot(box.pts[i][0] - box.pts[j][0], box.pts[i][1] - box.pts[j][1]));
    if (Number.isFinite(minD) && minD > 0 && minD * v.sc < 46) {
      const areaFit = Math.min(M.Wd / (bw * 1.08), M.Hd / (bh * 1.08));
      v = windowFor(box, pad, 0, Math.max(v.sc, Math.min(46 / minD, areaFit)));
    }
    return v;
  }
  function setView(target) {
    const to = target ?? restView();
    cancelAnimationFrame(M.viewRaf);
    if (reduced() || !M.Wd || D.body.hidden) { M.view = { ...to }; applyView(); if (D.els) paint(false); return; }
    const from = { ...M.view }, t0 = performance.now();
    const step = (t) => {
      if (!M) return;
      const k = Math.min(1, (t - t0) / 180), e = 1 - Math.pow(1 - k, 3);
      M.view = { cx: from.cx + (to.cx - from.cx) * e, cy: from.cy + (to.cy - from.cy) * e, sc: from.sc * Math.pow(to.sc / from.sc, e) };
      applyView(); paint(false);
      if (k < 1) M.viewRaf = requestAnimationFrame(step);
    };
    M.viewRaf = requestAnimationFrame(step);
  }
  function toggleZoom() {
    if (!M.edit || M.edit.area === 'street') return;
    if (zoomed()) { M.edit.zoomed = false; setView(restView()); } else { M.edit.zoomed = true; const sh = areaShape(M.edit.area); if (sh) setView(viewFor(sh)); }
    updateActions();
  }
  function setBig(big, user) {
    if (!M) return;
    M.big = big;
    D.bSize.textContent = big ? 'Smaller' : 'Bigger'; D.bSize.setAttribute('aria-pressed', big ? 'true' : 'false');
    layout();
    paint(true);
    if (user) D.bSize.focus({ preventScroll: true });
  }
  /** wide screens: while an area is edited the picture takes the whole width and the list steps aside; the scroll position comes back after */
  function setEditLayout(on) {
    const prop = document.getElementById('property'); if (!prop || phone()) return;
    if (on) { M.scrollBefore = window.scrollY; prop.classList.add('pic-editing'); const slot = document.getElementById('lot-map-slot'); window.scrollTo(0, Math.max(0, (slot ?? prop).getBoundingClientRect().top + window.scrollY - headerH() - 10)); }
    else { prop.classList.remove('pic-editing'); if (M.scrollBefore != null) window.scrollTo(0, M.scrollBefore); M.scrollBefore = null; }
  }

  const shapes = () => [M.lot, ...(M.yards.front ? [M.yards.front] : []), ...(M.yards.back ? [M.yards.back] : []), ...(M.drv ? [M.drv] : []), ...live()];
  const shapeOf = (key) => (key === 'lot' ? M.lot : key === 'drv' ? M.drv : key === 'front' || key === 'back' ? M.yards[key] : live().find((b) => b.id === key));
  /** Corners that get a handle. Short outlines show every corner. A long one (a rounded corner or a curved wall is many tiny segments) shows the
   *  real turns only, and never two handles within 1.5 m of each other, so the picture does not fill with dots. */
  const visibleVerts = (sh) => {
    const vs = sh.verts;
    if (vs.length <= 12) return vs;
    const keep = [];
    vs.forEach((v, i) => {
      const a = vs[(i + vs.length - 1) % vs.length], b = vs[(i + 1) % vs.length];
      const { kx, ky } = metresPerDegree(v.lat);
      const x1 = (v.lng - a.lng) * kx, y1 = (v.lat - a.lat) * ky, x2 = (b.lng - v.lng) * kx, y2 = (b.lat - v.lat) * ky;
      const l1 = Math.hypot(x1, y1), l2 = Math.hypot(x2, y2);
      if (l1 < 1e-6 || l2 < 1e-6) return;
      if (Math.acos(Math.max(-1, Math.min(1, (x1 * x2 + y1 * y2) / (l1 * l2)))) <= 25 * RAD) return;
      if (keep.some((k) => Math.hypot((k.lng - v.lng) * kx, (k.lat - v.lat) * ky) < 1.5)) return;
      keep.push(v);
    });
    return keep.length >= 3 ? keep : vs.slice(0, 3);
  };

  const areaOfShape = (sh) => (sh.kind === 'lot' ? 'lot' : sh.kind === 'drv' ? 'drv' : sh.kind === 'yard' ? sh.id : sh.main ? 'house' : sh.id);
  const areaShape = (a) => (a === 'house' ? live().find((b) => b.main) : shapeOf(a));
  const areaName = (a) => { if (AREA_LABEL[a]) return AREA_LABEL[a]; const sh = shapeOf(a); return sh?.what ? WHAT_LOWER[sh.what] : 'building'; };
  function structure() {
    // outlines, tap areas, and (only for the area being edited) edges, plus marks and corners; rebuilt whenever the corner list or the mode changes; positions are set by paint()
    D.gShapes.textContent = ''; D.gAreas.textContent = ''; D.gEdges.textContent = ''; D.gPlus.textContent = ''; D.gHandles.textContent = ''; D.maskG.textContent = ''; D.legend.textContent = '';
    D.els = { shapes: new Map(), edges: [], plus: [], handles: new Map(), legend: new Map(), mask: new Map(), areas: new Map() };
    D.hlKey = null;
    mount.classList.toggle('is-editing', Boolean(M.edit));
    const street = M.edit?.area === 'street';
    const editing = M.edit && !street ? areaShape(M.edit.area) : null;
    const addArea = (area, el) => { el.setAttribute('data-area', area); D.gAreas.append(el); D.els.areas.set(area, el); };
    addArea('lot', svgEl('path', { class: 'lm-area' }));
    addArea('front', D.hitFront); addArea('back', D.hitBack);
    if (M.drv) addArea('drv', svgEl('path', { class: 'lm-area' }));
    for (const b of live()) addArea(areaOfShape(b), svgEl('path', { class: 'lm-area' }));
    shapes().forEach((sh) => {
      const cls = sh.kind === 'lot' ? 'lm-lot' : sh.kind === 'drv' ? 'lm-drv' : sh.kind === 'yard' ? `lm-yardline is-${sh.id}` : sh.main ? 'lm-house' : 'lm-other';
      const area = areaOfShape(sh);
      const casing = svgEl('path', { class: 'lm-casing', fill: 'none', 'data-area': area }, D.gShapes);
      const path = svgEl('path', { class: cls, fill: 'none', 'data-area': area }, D.gShapes);
      D.els.shapes.set(sh.id, { casing, path });
      if (sh.kind === 'bld') D.els.mask.set(sh.id, svgEl('path', {}, D.maskG));
      const showEdges = editing === sh || (street && sh.kind === 'lot');
      if (showEdges) sh.verts.forEach((v, i) => {
        const line = svgEl('line', { class: 'lm-edge', 'data-shape': sh.id, 'data-i': i }, D.gEdges);
        if (sh.kind === 'lot') { line.setAttribute('tabindex', '0'); line.setAttribute('role', 'button'); line.setAttribute('aria-label', `Lot side ${i + 1} of ${sh.verts.length}. Press Enter to choose it as the side facing the street.`); line.id = `${uid}-e-${v.id}`; }
        D.els.edges.push({ sh, i, line });
        if (editing === sh) {
          const pl = svgEl('g', { class: 'lm-plus', 'data-shape': sh.id, 'data-i': i, role: 'button', 'aria-label': `Add a corner on side ${i + 1}` }, D.gPlus);
          svgEl('circle', { class: 'lm-plushit', r: 18 }, pl); svgEl('circle', { class: 'lm-plusc', r: 11 }, pl);
          const t = svgEl('text', { class: 'lm-plust', 'text-anchor': 'middle', 'dominant-baseline': 'central' }, pl); t.textContent = '+';
          D.els.plus.push({ sh, i, g: pl });
        }
      });
      if (editing === sh) {
        const vis = visibleVerts(sh); const ids = new Set(vis.map((v) => v.id));
        let rank = 0;
        sh.verts.forEach((v, i) => {
          if (!ids.has(v.id)) return;
          rank++;
          const g = svgEl('g', { class: 'lm-h', id: `${uid}-v-${v.id}`, tabindex: '0', role: 'button', 'data-vid': v.id, 'data-shape': sh.id, 'aria-label': `${shapeName(sh)} corner ${rank} of ${vis.length}` }, D.gHandles);
          svgEl('circle', { class: 'lm-hit', r: 22 }, g);
          svgEl('circle', { class: 'lm-ring', r: 18 }, g);
          svgEl('circle', { class: `lm-dot ${sh.kind === 'lot' ? 'is-lot' : sh.kind === 'drv' ? 'is-drv' : 'is-bld'}`, r: 14 }, g);
          const nt = svgEl('text', { class: 'lm-num', 'text-anchor': 'middle', 'dominant-baseline': 'central' }, g); nt.textContent = String(rank);
          D.els.handles.set(v.id, g);
        });
      }
    });
    buildLegend();
  }

  const shapeName = (sh) => (sh.kind === 'lot' ? 'Lot' : sh.kind === 'drv' ? 'Driveway' : sh.kind === 'yard' ? (sh.id === 'front' ? 'Front yard' : 'Back yard') : sh.main ? 'House' : sh.what ? WHAT_NAME[sh.what] : 'Building');
  const swatch = (kind) => {
    const defsRef = (id) => `url(#${uid}-${id})`;
    const body = {
      lot: '<rect x="2" y="2" width="26" height="14" rx="2" class="lm-casing" fill="none"/><rect x="2" y="2" width="26" height="14" rx="2" class="lm-lot" fill="none"/>',
      house: '<rect x="2" y="2" width="26" height="14" rx="2" class="lm-casing" fill="none"/><rect x="2" y="2" width="26" height="14" rx="2" class="lm-house" fill="none"/>',
      other: '<rect x="2" y="2" width="26" height="14" rx="2" class="lm-casing" fill="none"/><rect x="2" y="2" width="26" height="14" rx="2" class="lm-other" fill="none"/>',
      front: `<rect x="1" y="1" width="28" height="16" rx="2" fill="${defsRef('pf')}" stroke="#075985" stroke-width="1"/>`,
      back: `<rect x="1" y="1" width="28" height="16" rx="2" fill="${defsRef('pb')}" stroke="#6b21a8" stroke-width="1"/>`,
      drv: `<rect x="1" y="1" width="28" height="16" rx="2" fill="${defsRef('pd')}" stroke="#00e5ff" stroke-width="2"/>`,
      usable: `<rect x="1" y="1" width="28" height="16" rx="2" fill="${defsRef('pu')}" stroke="#111827" stroke-opacity=".7" stroke-width="1"/>`,
    }[kind];
    return `<svg class="lm-sw" width="30" height="18" viewBox="0 0 30 18" aria-hidden="true" focusable="false">${body}</svg>`;
  };
  function buildLegend() {
    const row = (id, kind, name, extra = '', area = null) => {
      const li = html('li', { class: 'lm-li', 'data-row': id }, null, D.legend);
      const edit = area ? `<button type="button" class="btn sm lm-editbtn" id="${uid}-edit-${area}" data-lm="edit" data-edit="${area}">Edit</button>` : '';
      li.innerHTML = `${swatch(kind)}<span class="lm-name">${esc(name)}</span><span class="lm-val"></span><span class="lm-ctl">${extra}${edit}</span>`;
      D.els.legend.set(id, { li, name: li.querySelector('.lm-name'), val: li.querySelector('.lm-val'), edit: li.querySelector('.lm-editbtn') });
    };
    row('lot', 'lot', 'Lot outline', '', 'lot');
    for (const b of live()) {
      if (b.main) row(b.id, 'house', 'House', '', 'house');
      else if (!isSliver(b)) row(b.id, 'other', 'Other building', `<select class="lm-what" id="${uid}-kind-${b.id}" data-bid="${b.id}" aria-label="What is this building?"></select>`, b.id);
    }
    if (live().filter(isSliver).length > 1) row('small', 'other', 'Other buildings');
    row('driveway', 'drv', 'Driveway', `<button type="button" class="btn sm" id="${uid}-adddrv" data-lm="adddrv">Add your driveway</button><button type="button" class="btn sm" id="${uid}-rmdrv" data-lm="rmdrv">Remove driveway</button>`, 'drv');
    row('front', 'front', 'Front yard', `<button type="button" class="btn sm" id="${uid}-street" data-lm="street">Choose the street side</button>`, 'front');
    row('back', 'back', 'Back yard', '', 'back');
    row('usable', 'usable', 'Usable yard');
    for (const sel of D.legend.querySelectorAll('select.lm-what')) fillWhat(sel, shapeOf(sel.dataset.bid));
  }
  /** options of a "What is this?" menu for one outline; a kind the lookup stated is pre-selected and marked ≈ */
  function fillWhat(sel, sh) {
    if (!sh) return;
    sel.textContent = '';
    const add = (v, t, selected) => { const o = html('option', { value: v }, t, sel); if (selected) o.selected = true; };
    if (!sh.what) add('', 'What is this?', true);
    for (const [v, t] of WHAT) add(v, `${sh.what === v && sh.whatSrc === 'lookup' ? '≈ ' : ''}${t}`, sh.what === v);
    add('__house', 'This one is the house', false);
    add('__remove', 'Not a building — remove it', false);
  }

  const pathOf = (pts) => (pts.length ? `M${pts.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('L')}Z` : '');

  // ----- paint (one animation frame) ---------------------------------------------------------------------------
  let raf = 0, needMeasure = false, lastMeasureAt = 0;
  const schedule = (measure = true) => { if (measure) needMeasure = true; if (!raf) raf = requestAnimationFrame(() => { raf = 0; paint(false); }); };

  /** outlines, tap areas, corners, marks: cheap, and run synchronously while a corner is dragged so it never lags behind the pointer */
  function paintShapes() {
    for (const sh of shapes()) {
      const pts = sh.verts.map((v) => px(v.lng, v.lat));
      const e = D.els.shapes.get(sh.id);
      if (!e) { M.needStructure = true; continue; } // an outline that arrived after the last structure(): drawn once the elements exist
      const d = pathOf(pts);
      e.casing.setAttribute('d', d); e.path.setAttribute('d', d);
      if (sh.kind === 'bld') D.els.mask.get(sh.id)?.setAttribute('d', d);
      const hit = D.els.areas.get(areaOfShape(sh)); if (hit && sh.kind !== 'yard') hit.setAttribute('d', d);
      if (sh.kind === 'drv') D.drvFill.setAttribute('d', d);
      if (sh.kind === 'lot') { D.clipLot.setAttribute('d', d); }
      sh.verts.forEach((v, i) => {
        const h = D.els.handles.get(v.id);
        if (h) { h.setAttribute('transform', `translate(${pts[i][0].toFixed(2)} ${pts[i][1].toFixed(2)})`); h.dataset.lng = v.lng.toFixed(9); h.dataset.lat = v.lat.toFixed(9); h.dataset.x = pts[i][0].toFixed(2); h.dataset.y = pts[i][1].toFixed(2); }
      });
    }
    for (const { sh, i, line } of D.els.edges) {
      const a = px(sh.verts[i].lng, sh.verts[i].lat), b = px(sh.verts[(i + 1) % sh.verts.length].lng, sh.verts[(i + 1) % sh.verts.length].lat);
      line.setAttribute('x1', a[0].toFixed(1)); line.setAttribute('y1', a[1].toFixed(1)); line.setAttribute('x2', b[0].toFixed(1)); line.setAttribute('y2', b[1].toFixed(1));
      line.classList.toggle('is-sel', Boolean(M.sel && M.sel.type === 'e' && M.sel.shape === sh.id && M.sel.i === i));
    }
    for (const { sh, i, g } of D.els.plus) {
      const a = px(sh.verts[i].lng, sh.verts[i].lat), b = px(sh.verts[(i + 1) % sh.verts.length].lng, sh.verts[(i + 1) % sh.verts.length].lat);
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      g.setAttribute('transform', `translate(${((a[0] + b[0]) / 2).toFixed(2)} ${((a[1] + b[1]) / 2).toFixed(2)})`);
      g.style.display = len < 52 ? 'none' : '';
    }
    for (const [id, g] of D.els.handles) g.classList.toggle('is-sel', Boolean(M.sel && M.sel.type === 'v' && M.sel.vid === id));
    // corners close together share the room: each corner's grab area is at most half the distance to its nearest neighbour, so two never overlap
    const hs = [...D.els.handles.values()];
    if (hs.length > 1) {
      const pts = hs.map((g) => [Number(g.dataset.x), Number(g.dataset.y)]);
      hs.forEach((g, i) => { let d = Infinity; pts.forEach((p, j) => { if (j !== i) d = Math.min(d, Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1])); }); g.firstChild?.setAttribute('r', clamp(d / 2 - 0.5, 8, 22).toFixed(1)); });
    }
  }

  function paint(full) {
    if (!M || !M.Wd || D.body.hidden) return;
    const tNow = performance.now();
    if (full || (needMeasure && tNow - lastMeasureAt >= Math.min(250, M.lastMs * 2))) {
      M.m = measureNow(); needMeasure = false; lastMeasureAt = performance.now();
    } else if (needMeasure) schedule(true); // too soon after a slow one: try again next frame
    const m = M.m;
    paintShapes();
    if (!M.drv) D.drvFill.setAttribute('d', '');
    paintZones(m);
    paintLegend(m);
    paintUsable(m);
    applyHl(); updateLive(m);
    if (full) D.frame.dataset.model = JSON.stringify({ lot: M.lot.verts.map((v) => [v.lng, v.lat]), blds: live().map((b) => ({ main: b.main, what: b.what, geo: toGeo(b) })), drv: M.drv ? toGeo(M.drv) : null, drvTouched: Boolean(M.drv && M.drv.touched), yards: (M.yards.front && !M.yards.front.inert) || (M.yards.back && !M.yards.back.inert) ? { ...(M.yards.front && !M.yards.front.inert ? { front: toGeo(M.yards.front) } : {}), ...(M.yards.back && !M.yards.back.inert ? { back: toGeo(M.yards.back) } : {}), later: M.yardLater } : null });
    D.frame.dataset.front = M.frontIds && M.lot ? JSON.stringify(frontLine(M.frontIds)) : '';
    updateActions();
  }

  /** the picture's key areas: highlighted from the list, dimmed while one is edited */
  function applyHl() {
    const edit = M.edit && M.edit.area !== 'street' ? M.edit.area : null;
    const want = edit ? null : (M.hl && M.hl.length ? M.hl : M.pick ? [M.pick] : null);
    const key = `${edit ?? ''}|${want ? want.join(',') : ''}|${live().map((b) => `${b.id}${b.what ?? ''}${b.main ? 'm' : ''}`).join(',')}`;
    if (D.hlKey === key) return;
    D.hlKey = key;
    const match = (area) => Boolean(want && (want.includes(area) || (want.includes('garage') && shapeOf(area)?.what === 'garage') || (want.includes('adu') && shapeOf(area)?.what === 'adu')));
    D.svg.classList.toggle('has-hl', Boolean(want));
    D.frame.classList.toggle('has-hl', Boolean(want));
    for (const el of D.svg.querySelectorAll('[data-area]')) {
      const a = el.getAttribute('data-area');
      el.classList.toggle('is-hl', match(a));
      el.classList.toggle('is-edit', Boolean(edit && (a === edit)));
    }
    D.canvas.classList.toggle('is-hl', match('usable'));
  }
  function updateLive(m) {
    if (!M.edit || M.edit.area === 'street') return;
    const v = areaFigure(M.edit.area, m);
    D.live.textContent = num(v) ? `${fmt(v)} sq ft` : '';
  }
  function areaFigure(area, m) {
    if (area === 'lot') return m?.lot_area_sqft;
    if (area === 'house') return m?.building_footprint_sqft;
    if (area === 'drv') return m?.driveway_area_sqft;
    if (area === 'front') return m?.front_yard_sqft;
    if (area === 'back') return m?.back_yard_sqft;
    const sh = shapeOf(area); return sh ? Math.round(areaOf(sh)) : null;
  }

  // Sutherland-Hodgman against one half-plane: keep points with f(p) <= 0
  const clipHalf = (ring, f) => {
    const out = [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length], fa = f(a), fb = f(b);
      if (fa <= 0) out.push(a);
      if ((fa < 0 && fb > 0) || (fa > 0 && fb < 0)) { const t = fa / (fa - fb); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
    }
    return out;
  };
  const centroidPx = (pts) => {
    let a = 0, cx = 0, cy = 0;
    for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; const f = p[0] * q[1] - q[0] * p[1]; a += f; cx += (p[0] + q[0]) * f; cy += (p[1] + q[1]) * f; }
    return Math.abs(a) < 1e-6 ? null : [cx / (3 * a), cy / (3 * a)];
  };
  const boxOf = (pts) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const p of pts) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); } return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 }; };
  const label = (x, y, text, cls = '') => { const t = svgEl('text', { x: x.toFixed(1), y: y.toFixed(1), class: `lm-label ${cls}`, 'text-anchor': 'middle', 'dominant-baseline': 'middle' }, D.gLabels); t.textContent = text; };

  /** the automatic front and back zones (lot clipped by the depth bands), as lng/lat rings */
  function derivedZones(m) {
    const b = m?.zones?.bands;
    if (!b || !M.lot) return null;
    const { kx, ky } = metresPerDegree(b.origin.lat);
    const ring = M.lot.verts.map((v) => [(v.lng - b.origin.lng) * kx, (v.lat - b.origin.lat) * ky]);
    const depth = (p) => p[0] * b.nx + p[1] * b.ny - b.depth0;
    const toLL = (r) => r.map((p) => [b.origin.lng + p[0] / kx, b.origin.lat + p[1] / ky]);
    return { front: toLL(clipHalf(ring, (p) => depth(p) - b.d1)), back: toLL(clipHalf(ring, (p) => b.d2 - depth(p))), b, kx, ky, ring, depth };
  }
  /** an editable outline for a yard, from its automatic zone: at most 8 corners, always a simple shape */
  function makeYard(which) {
    const dz = derivedZones(M.m);
    if (!dz || dz[which].length < 3) return null;
    let ring = dz[which].map((p) => ({ lng: p[0], lat: p[1] }));
    const { kx, ky } = metresPerDegree(ring[0].lat);
    while (ring.length > 8) { // drop the corner that changes the shape least (smallest triangle with its neighbours)
      let bi = 0, ba = Infinity;
      ring.forEach((v, i) => { const a = ring[(i + ring.length - 1) % ring.length], c = ring[(i + 1) % ring.length]; const ar = Math.abs(((v.lng - a.lng) * (c.lat - a.lat) - (c.lng - a.lng) * (v.lat - a.lat)) * kx * ky) / 2; if (ar < ba) { ba = ar; bi = i; } });
      ring.splice(bi, 1);
    }
    if (ringCrosses(ring)) { // a lot too crooked to simplify: use the zone's bounding box in the street's frame
      const b = dz.b; const { kx: bkx, ky: bky } = dz; const ux = -b.ny, uy = b.nx;
      let a0 = Infinity, a1 = -Infinity, d0 = Infinity, d1 = -Infinity;
      for (const q of dz.ring) { const a = q[0] * ux + q[1] * uy, d = q[0] * b.nx + q[1] * b.ny; a0 = Math.min(a0, a); a1 = Math.max(a1, a); }
      for (const q of dz[which]) { const l = [(q[0] - b.origin.lng) * bkx, (q[1] - b.origin.lat) * bky]; const d = l[0] * b.nx + l[1] * b.ny; d0 = Math.min(d0, d); d1 = Math.max(d1, d); }
      const at = (a, d) => ({ lng: b.origin.lng + (a * ux + d * b.nx) / bkx, lat: b.origin.lat + (a * uy + d * b.ny) / bky });
      ring = [at(a0, d0), at(a1, d0), at(a1, d1), at(a0, d1)];
    }
    const poly = { type: 'Polygon', coordinates: [[...ring.map((v) => [v.lng, v.lat]), [ring[0].lng, ring[0].lat]]] };
    const ys = makeShape(poly, 'yard', false, which); ys.inert = true; // drawn, but not measured until a corner is actually moved: opening an edit changes no number
    return ys;
  }

  function paintZones(m) {
    D.gLabels.textContent = ''; D.gFront.textContent = '';
    const dz = derivedZones(m);
    let front = '', back = '';
    for (const which of ['front', 'back']) {
      const ov = M.yards[which];
      let pts;
      if (ov) pts = ov.verts.map((v) => px(v.lng, v.lat));
      else if (dz) { const r = dz[which].map((p) => px(p[0], p[1])); pts = r.length >= 3 ? r : []; } else pts = [];
      const d = pts.length >= 3 ? pathOf(pts) : '';
      if (which === 'front') front = d; else back = d;
      (which === 'front' ? D.hitFront : D.hitBack).setAttribute('d', d);
      if (pts.length >= 3 && !(M.edit && M.edit.area === which)) {
        const bx = boxOf(pts), c = centroidPx(pts);
        if (c && bx.w > 74 && bx.h > 26) label(c[0], c[1], which === 'front' ? 'Front yard' : 'Back yard', 'is-zone');
      }
    }
    D.zFront.setAttribute('d', front); D.zBack.setAttribute('d', back);
    const fe = m?.zones?.frontEdge?.edges;
    if (Array.isArray(fe) && fe.length) {
      const pts = [px(fe[0].from.lng, fe[0].from.lat), ...fe.map((e) => px(e.to.lng, e.to.lat))];
      svgEl('polyline', { class: 'lm-front-casing', points: pts.map((p) => p.join(',')).join(' '), fill: 'none' }, D.gFront);
      svgEl('polyline', { class: 'lm-front-line', points: pts.map((p) => p.join(',')).join(' '), fill: 'none' }, D.gFront);
      const mid = pts[Math.floor(pts.length / 2)], nxt = pts[Math.floor(pts.length / 2) - 1] ?? pts[0];
      const c = M.lot.verts.reduce((s, v) => { const q = px(v.lng, v.lat); return [s[0] + q[0] / M.lot.verts.length, s[1] + q[1] / M.lot.verts.length]; }, [0, 0]);
      let ox = (mid[0] + nxt[0]) / 2 - c[0], oy = (mid[1] + nxt[1]) / 2 - c[1]; const l = Math.hypot(ox, oy) || 1; ox /= l; oy /= l;
      const mx = (mid[0] + nxt[0]) / 2 + ox * 15, my = (mid[1] + nxt[1]) / 2 + oy * 15;
      label(Math.max(30, Math.min(M.Wd - 30, mx)), Math.max(10, Math.min(M.Hd - 10, my)), 'Street side', 'is-street');
    }
    for (const b of live()) {
      if (b.main || !b.what) continue;
      const pts = b.verts.map((v) => px(v.lng, v.lat)), bx = boxOf(pts), c = centroidPx(pts);
      if (c && bx.w > 34 && bx.h > 16) label(c[0], c[1], WHAT_NAME[b.what], 'is-what');
    }
    const house = live().find((x) => x.main);
    if (house && m && num(m.roof_area_sqft) && roofShown()) {
      const pts = house.verts.map((v) => px(v.lng, v.lat)), bx = boxOf(pts), c = centroidPx(pts);
      if (c && bx.w > 96 && bx.h > 30) label(c[0], c[1], `Roof about ${fmt(m.roof_area_sqft)} sq ft`, 'is-roof');
    }
  }

  function paintLegend(m) {
    const set = (id, text, muted = false, hide = false) => {
      const r = D.els.legend.get(id); if (!r) return;
      r.li.hidden = hide;
      if (r.val.textContent !== text) { // a brief tick when a figure changes (not on the first paint)
        const had = r.val.dataset.had === '1'; r.val.textContent = text; r.val.dataset.had = text ? '1' : '';
        if (had && text && !reduced()) { r.val.classList.remove('lm-tick'); void r.val.offsetWidth; r.val.classList.add('lm-tick'); }
      }
      r.val.classList.toggle('is-muted', muted);
    };
    const setName = (id, t) => { const r = D.els.legend.get(id); if (r && r.name) r.name.textContent = t; };
    set('lot', m && num(m.lot_area_sqft) ? `${fmt(m.lot_area_sqft)} sq ft${M.starter || M.parcelSource === 'estimated' ? ' (a first guess; drag the corners)' : ''}` : '', false, !(m && num(m.lot_area_sqft)));
    const unnamed = live().filter((b) => !b.main && !b.what && !isSliver(b));
    for (const b of live()) {
      let text;
      if (b.main) text = m && num(m.building_footprint_sqft) ? `${fmt(m.building_footprint_sqft)} sq ft footprint${num(m.roof_area_sqft) && roofShown() ? ` · roof about ${fmt(m.roof_area_sqft)} sq ft` : ''}` : '';
      else { try { text = `${fmt(core.areaSqft(toGeo(b)))} sq ft`; } catch { text = ''; } }
      if (!b.main) setName(b.id, b.what ? `${WHAT_NAME[b.what]}${b.whatSrc === 'lookup' ? ' ≈' : ''}` : `Other building${unnamed.length > 1 ? ` ${unnamed.indexOf(b) + 1}` : ''}`);
      set(b.id, text, false, !text);
    }
    const dv = D.els.legend.get('driveway');
    if (dv) {
      const have = Boolean(M.drv);
      dv.val.textContent = have && m && num(m.driveway_area_sqft) ? `${fmt(m.driveway_area_sqft)} sq ft` : '';
      dv.li.querySelector('[data-lm="adddrv"]').hidden = have; dv.li.querySelector('[data-lm="rmdrv"]').hidden = !have;
      dv.li.hidden = !live().length && !have;
    }
    D.hintDrv.hidden = !(M.drv && M.drv.starter);
    const slivers = live().filter(isSliver);
    if (slivers.length > 1) set('small', `${fmt(slivers.reduce((t, b) => t + areaOf(b), 0))} sq ft in all (${slivers.length} small outlines)`);
    const hasYard = m && num(m.front_yard_sqft) && num(m.back_yard_sqft);
    set('front', hasYard ? `${fmt(m.front_yard_sqft)} sq ft` : 'choose the side that faces the street', !hasYard, !live().length);
    set('back', hasYard ? `${fmt(m.back_yard_sqft)} sq ft` : '', false, !hasYard);
    const u = m && num(m.usable_yard_sqft);
    set('usable', u ? `${fmt(m.usable_yard_sqft)} sq ft${num(m.usable_front_yard_sqft) && num(m.usable_back_yard_sqft) ? ` (front ${fmt(m.usable_front_yard_sqft)} · back ${fmt(m.usable_back_yard_sqft)})` : ''}` : '', false, !u);
    D.hintUnknown.hidden = Boolean(hasYard) || !live().length;
    // each row's Edit button: named for what it edits, only where there is an outline (or an automatic yard) to edit
    const dzOk = Boolean(derivedZones(m));
    for (const [id, r] of D.els.legend) {
      if (!r.edit) continue;
      const area = r.edit.dataset.edit;
      r.edit.textContent = `Edit ${areaName(area)}`;
      r.edit.hidden = (area === 'front' || area === 'back') ? !(M.yards[area] || dzOk) : area === 'drv' ? !M.drv : false;
      r.edit.setAttribute('aria-pressed', M.edit?.area === area ? 'true' : 'false');
    }
    const st = D.els.legend.get('front')?.li.querySelector('[data-lm="street"]'); if (st) st.hidden = Boolean(hasYard);
  }

  let hatchTile = null;
  function paintUsable(m) {
    const c = D.canvas, ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    const cells = m?.usable?.cells;
    if (!cells || !cells.mask || !cells.width || !cells.height) return;
    const k = c.width / M.Wd;
    const t = document.createElement('canvas'); t.width = cells.width; t.height = cells.height;
    const tc = t.getContext('2d'); if (!tc) return;
    const img = tc.createImageData(cells.width, cells.height);
    for (let i = 0; i < cells.mask.length; i++) if (cells.mask[i]) img.data[i * 4 + 3] = 255;
    tc.putImageData(img, 0, 0);
    const [w, s, e, n] = cells.bbox;
    const [x0, y0] = px(w, n), [x1, y1] = px(e, s);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(t, x0 * k, y0 * k, (x1 - x0) * k, (y1 - y0) * k);
    ctx.globalCompositeOperation = 'source-in'; ctx.fillStyle = 'rgba(255,255,255,.26)'; ctx.fillRect(0, 0, c.width, c.height);
    if (!hatchTile || hatchTile.k !== k) {
      const tile = document.createElement('canvas'); const s8 = Math.max(4, Math.round(8 * k)); tile.width = s8; tile.height = s8;
      const g = tile.getContext('2d');
      if (g) {
        const line = (w2, col) => { g.lineWidth = w2 * k; g.strokeStyle = col; g.beginPath(); g.moveTo(-s8, -s8); g.lineTo(2 * s8, 2 * s8); g.moveTo(-s8, 0); g.lineTo(s8, 2 * s8); g.moveTo(0, -s8); g.lineTo(2 * s8, s8); g.stroke(); };
        line(2.6, 'rgba(17,24,39,.6)'); line(1.3, '#fff');
      }
      hatchTile = { k, tile };
    }
    const pat = ctx.createPattern(hatchTile.tile, 'repeat');
    if (pat) { ctx.globalCompositeOperation = 'source-atop'; ctx.fillStyle = pat; ctx.fillRect(0, 0, c.width, c.height); }
    ctx.globalCompositeOperation = 'source-over';
  }

  function updateActions() {
    const sel = M.sel, ed = M.edit;
    const v = sel?.type === 'v' ? vertexById(sel.vid) : null;
    const editing = Boolean(ed);
    const street = ed?.area === 'street';
    D.editBar.hidden = !editing; D.actions.hidden = editing;
    D.pickBar.hidden = editing || !M.pick;
    if (M.pick && !editing) {
      const fig = areaFigure(M.pick, M.m);
      D.pickText.textContent = `${cap(areaName(M.pick))}${num(fig) ? ` · ${fmt(fig)} sq ft` : ''}`;
      const can = M.pick !== 'usable';
      D.bPickEdit.hidden = !can; D.bPickEdit.textContent = `Edit ${areaName(M.pick)}`; D.bPickEdit.dataset.area = M.pick;
    }
    D.bReset.hidden = !M.edited;
    mount.classList.toggle('is-street-mode', street);
    if (editing) {
      D.bFront.hidden = street || !(ed.area === 'lot' && sel?.type === 'e');
      D.bAdd.hidden = street || !(sel && (sel.type === 'e' || v));
      D.bRemove.hidden = street || !v; D.bRemove.disabled = Boolean(v && v.sh.verts.length <= 3);
      D.bRmDrv.hidden = ed.area !== 'drv';
      D.bUndo.hidden = street; D.bResetArea.hidden = street; D.bZoom.hidden = street;
      D.bUndo.disabled = !ed.undo.length;
      D.bZoom.textContent = zoomed() ? 'Zoom out' : 'Zoom in';
      const bsh = !street && ed.area !== 'lot' && ed.area !== 'drv' && ed.area !== 'house' && ed.area !== 'front' && ed.area !== 'back' ? shapeOf(ed.area) : null;
      D.kindWrap.hidden = !bsh;
      const kkey = bsh ? `${bsh.id}:${bsh.what ?? ''}:${bsh.whatSrc ?? ''}` : '';
      if (bsh && D.kindKey !== kkey) { D.kindKey = kkey; D.kindSel.dataset.for = bsh.id; fillWhat(D.kindSel, bsh); }
      D.overlap.hidden = !((ed.area === 'front' || ed.area === 'back') && M.yards.front && M.yards.back);
      D.overlap.textContent = `If the front and back yards overlap, the one you changed last (${areaName(M.yardLater)}) keeps the overlap.`;
      D.editMsg.textContent = ed.msg || (street ? 'Tap the side of your lot that faces the street' : `Editing ${areaName(ed.area)} — drag a corner`);
    }
    D.noteEl.textContent = M.note || (M.needsMatchNote ? 'Outline no longer matches the number · Reset outlines' : '');
  }

  const vertexById = (vid) => { for (const sh of shapes()) { const i = sh.verts.findIndex((x) => x.id === Number(vid)); if (i >= 0) return { sh, i, v: sh.verts[i] }; } return null; };
  const setNote = (t) => { M.note = t; D.noteEl.textContent = t; };
  const announce = (t) => { D.sr.textContent = ''; setTimeout(() => { D.sr.textContent = t; }, 30); };

  // ----- interaction -------------------------------------------------------------------------------------------
  const pointerXY = (e) => { const r = D.svg.getBoundingClientRect(); return [((e.clientX - r.left) * M.Wd) / r.width, ((e.clientY - r.top) * M.Hd) / r.height]; };
  const beginGesture = () => {
    if (M.gestureBefore) return;
    M.gestureBefore = snap();
    if (M.edit && M.yards[M.edit.area]) M.yards[M.edit.area].inert = false; // from the first move on, the yard follows the owner's outline
    if (M.edit) { M.edit.undo.push(M.gestureBefore); M.edit.changed = true; if (M.edit.area === 'front' || M.edit.area === 'back') M.yardLater = M.edit.area; }
  };
  const kindOf = (sh) => (sh.kind === 'lot' ? 'lot' : sh.kind === 'drv' ? 'drv' : sh.kind === 'yard' ? 'yard' : 'bld');

  function moveVertex(sh, v, lng, lat) {
    const [w, s, e, n] = M.frame.bbox;
    lng = Math.max(w, Math.min(e, lng)); lat = Math.max(s, Math.min(n, lat));
    const old = { lng: v.lng, lat: v.lat };
    v.lng = lng; v.lat = lat;
    if (ringCrosses(sh.verts)) { v.lng = old.lng; v.lat = old.lat; setNote("An outline can't cross itself, so the corner went back."); return false; }
    if (M.note) setNote('');
    if (sh.kind === 'drv') { sh.touched = true; sh.starter = false; }
    return true;
  }

  /** a light pull toward the lot's corners and edges, and toward right angles, when within a few pixels of one (Alt, or a long press, turns it off) */
  function snapPoint(sh, v, x0, y0) {
    let r = snapOnce(sh, v, x0, y0);
    if (r.snapped) { const r2 = snapOnce(sh, v, r.x, r.y); if (r2.snapped) r = { x: r2.x, y: r2.y, snapped: true }; } // a second look lets two right angles meet at one point
    return r;
  }
  function snapOnce(sh, v, x, y) {
    let best = null;
    const consider = (cx, cy) => { const d = Math.hypot(cx - x, cy - y); if (d <= SNAP_PX && (!best || d < best.d)) best = { x: cx, y: cy, d }; };
    if (sh.kind !== 'lot') {
      const L = M.lot.verts.map((q) => px(q.lng, q.lat));
      L.forEach((p) => consider(p[0], p[1]));
      L.forEach((p, i) => {
        const q = L[(i + 1) % L.length]; const dx = q[0] - p[0], dy = q[1] - p[1], l2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((x - p[0]) * dx + (y - p[1]) * dy) / l2));
        consider(p[0] + t * dx, p[1] + t * dy);
      });
    }
    const vs = sh.verts, n = vs.length, i = vs.findIndex((q) => q.id === v.id);
    if (n >= 4 && i >= 0) {
      const P = (k) => { const q = vs[(k + n) % n]; return px(q.lng, q.lat); };
      const a = P(i - 1), ap = P(i - 2), b = P(i + 1), bn = P(i + 2);
      const lines = [];
      const perp = (c, from) => { // the line through c at right angles to from->c: where v makes a right angle at c
        const dx = c[0] - from[0], dy = c[1] - from[1], l = Math.hypot(dx, dy); if (l < 1e-6) return;
        const ux = -dy / l, uy = dx / l; const t = (x - c[0]) * ux + (y - c[1]) * uy;
        const qx = c[0] + t * ux, qy = c[1] + t * uy;
        lines.push({ c, ux, uy, d: Math.hypot(qx - x, qy - y) }); consider(qx, qy);
      };
      perp(a, ap); perp(b, bn);
      if (lines.length === 2 && lines[0].d <= SNAP_PX && lines[1].d <= SNAP_PX) { // both right angles at once: the one point where they meet
        const [l1, l2] = lines, den = l1.ux * l2.uy - l1.uy * l2.ux;
        if (Math.abs(den) > 1e-6) { const t = ((l2.c[0] - l1.c[0]) * l2.uy - (l2.c[1] - l1.c[1]) * l2.ux) / den; const ix = l1.c[0] + t * l1.ux, iy = l1.c[1] + t * l1.uy; if (Math.hypot(ix - x, iy - y) <= SNAP_PX * 1.6) return { x: ix, y: iy, snapped: true }; }
      }
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, r = Math.hypot(b[0] - a[0], b[1] - a[1]) / 2, dd = Math.hypot(x - mx, y - my);
      if (r > 1 && dd > 1e-6) consider(mx + ((x - mx) * r) / dd, my + ((y - my) * r) / dd); // a right angle at v itself
    }
    return best ? { x: best.x, y: best.y, snapped: true } : { x, y, snapped: false };
  }

  function onDown(e) {
    if (!M || (e.button && e.button !== 0)) return;
    const h = e.target.closest?.('.lm-h');
    if (h) {
      const ref = vertexById(h.dataset.vid); if (!ref) return;
      const [x, y] = pointerXY(e), [vx, vy] = px(ref.v.lng, ref.v.lat);
      M.drag = { pid: e.pointerId, vid: ref.v.id, shape: ref.sh.id, dx: vx - x, dy: vy - y, moved: false, free: e.altKey, cx: e.clientX, cy: e.clientY, timer: 0 };
      M.drag.timer = setTimeout(() => { if (M?.drag && !M.drag.moved) { M.drag.free = true; h.classList.add('is-free'); } }, 450); // a long press frees the corner from snapping
      try { h.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
      select({ type: 'v', vid: ref.v.id });
      h.focus({ preventScroll: true });
      beginGesture();
      e.preventDefault();
      return;
    }
    const pl = e.target.closest?.('.lm-plus');
    if (pl) { M.tap = { pid: e.pointerId, plus: { shape: pl.dataset.shape, i: Number(pl.dataset.i) }, x: e.clientX, y: e.clientY }; return; }
    const ed = e.target.closest?.('.lm-edge');
    if (ed) { M.tap = { pid: e.pointerId, shape: ed.dataset.shape, i: Number(ed.dataset.i), x: e.clientX, y: e.clientY, t: performance.now() }; return; }
    const ar = e.target.closest?.('.lm-area');
    if (ar && !M.edit) { M.tap = { pid: e.pointerId, area: ar.dataset.area, x: e.clientX, y: e.clientY }; return; }
    M.tap = { pid: e.pointerId, none: true, x: e.clientX, y: e.clientY };
  }
  function onMove(e) {
    if (!M?.drag || e.pointerId !== M.drag.pid) return;
    const d = M.drag;
    const sh = shapeOf(d.shape); const v = sh?.verts.find((x) => x.id === d.vid);
    if (!sh || !v) return;
    if (!d.moved && Math.hypot(e.clientX - d.cx, e.clientY - d.cy) < 2) return;
    if (!d.moved) { d.moved = true; clearTimeout(d.timer); }
    let [x, y] = pointerXY(e); x += d.dx; y += d.dy;
    let snapped = false;
    if (!d.free && !e.altKey) ({ x, y, snapped } = snapPoint(sh, v, x, y));
    const [lng, lat] = inv(x, y);
    moveVertex(sh, v, lng, lat);
    D.els.handles.get(v.id)?.classList.toggle('is-snap', snapped);
    paintShapes(); // the corner and its outline follow the pointer in this very event; the figures catch up on the next frame
    schedule(true);
  }
  function onUp(e) {
    if (!M) return;
    if (M.drag && e.pointerId === M.drag.pid) {
      const d = M.drag; M.drag = null; clearTimeout(d.timer);
      D.els.handles.get(d.vid)?.classList.remove('is-snap', 'is-free');
      if (M.needStructure) { M.needStructure = false; try { structure(); } catch { /* keep the picture as it is */ } }
      const sh = shapeOf(d.shape);
      if (d.moved && sh) { M.edited = true; paint(true); commit(kindOf(sh)); } else { M.gestureBefore = null; M.edit?.undo.pop(); }
      return;
    }
    const t = M.tap; M.tap = null;
    if (!t || t.pid !== e.pointerId || Math.hypot(e.clientX - t.x, e.clientY - t.y) > 8) return;
    if (t.area) { pickArea(t.area); return; }
    if (t.plus) { const sh = shapeOf(t.plus.shape); if (sh) addCornerAt(sh, t.plus.i, null); return; }
    if (t.none) { if (M.sel) select(null); else if (M.pick) { M.pick = null; setHl(null); paint(false); } M.lastTap = null; return; }
    if (M.edit?.area === 'street' && t.shape === 'lot') { chooseFront(t.i); exitEdit(); return; }
    const now2 = performance.now(), last = M.lastTap;
    if (last && last.shape === t.shape && last.i === t.i && now2 - last.t < DOUBLE_TAP_MS) { M.lastTap = null; addCornerAt(shapeOf(t.shape), t.i, pointerXY(e)); return; }
    M.lastTap = { shape: t.shape, i: t.i, t: now2 };
    if (t.shape === 'lot') select({ type: 'e', shape: 'lot', i: t.i });
    else select(null);
  }
  function select(sel) { M.sel = sel; schedule(false); updateActions(); }
  function onFocusIn(e) {
    if (!M) return;
    const h = e.target.closest?.('.lm-h');
    if (h) { if (!(M.sel?.type === 'v' && String(M.sel.vid) === h.dataset.vid)) select({ type: 'v', vid: Number(h.dataset.vid) }); return; }
    const ed = e.target.closest?.('.lm-edge');
    if (ed && ed.dataset.shape === 'lot') select({ type: 'e', shape: 'lot', i: Number(ed.dataset.i) });
  }

  let commitTimer = 0;
  function onKey(e) {
    if (!M) return;
    if (e.key === 'Escape') { if (M.edit) { e.preventDefault(); exitEdit(); } else if (M.pick) { M.pick = null; setHl(null); paint(false); } else select(null); return; }
    const h = e.target.closest?.('.lm-h'), ed = e.target.closest?.('.lm-edge');
    if (h) {
      const ref = vertexById(h.dataset.vid); if (!ref) return;
      const step = e.shiftKey ? 5 : 1;
      const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[e.key];
      if (dir) {
        e.preventDefault();
        beginGesture();
        const { kx, ky } = metresPerDegree(ref.v.lat);
        if (moveVertex(ref.sh, ref.v, ref.v.lng + (dir[0] * step * FT) / kx, ref.v.lat + (dir[1] * step * FT) / ky)) M.edited = true;
        paintShapes(); schedule(true);
        clearTimeout(commitTimer); pendingCommit = true; commitTimer = setTimeout(() => { pendingCommit = false; paint(true); commit(kindOf(ref.sh)); }, COMMIT_IDLE_MS);
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeCorner(ref.sh, ref.v.id); }
      return;
    }
    if (ed && ed.dataset.shape === 'lot' && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      if (M.edit?.area === 'street') { chooseFront(Number(ed.dataset.i)); exitEdit(); return; }
      select({ type: 'e', shape: 'lot', i: Number(ed.dataset.i) });
      D.bFront.focus();
    }
  }
  const onDocKey = (e) => { if (e.key === 'Escape' && M?.edit && mount.contains(document.activeElement)) { e.preventDefault(); exitEdit(); } };

  function onAction(e) {
    const b = e.target.closest?.('[data-lm]'); if (!b || !M) return;
    const act = b.dataset.lm, sel = M.sel;
    if (act === 'front' && sel?.type === 'e') chooseFront(sel.i);
    else if (act === 'add' && sel) { if (sel.type === 'e') addCornerAt(shapeOf(sel.shape), sel.i, null); else { const r = vertexById(sel.vid); if (r) addCornerAt(r.sh, r.i, null); } }
    else if (act === 'remove' && sel?.type === 'v') { const r = vertexById(sel.vid); if (r) removeCorner(r.sh, r.v.id); }
    else if (act === 'reset') resetAll();
    else if (act === 'adddrv') addDriveway();
    else if (act === 'rmdrv') removeDriveway();
    else if (act === 'addbld') addBuilding();
    else if (act === 'edit') enterEdit(b.dataset.edit);
    else if (act === 'pickedit') enterEdit(M.pick);
    else if (act === 'pickclear') { M.pick = null; setHl(null); paint(false); }
    else if (act === 'street') enterEdit('street');
    else if (act === 'done') exitEdit();
    else if (act === 'undo') undoEdit();
    else if (act === 'resetarea') resetArea();
    else if (act === 'zoom') toggleZoom();
  }

  // ----- edit one area at a time ------------------------------------------------------------------------------
  function flushEdit() {
    if (!M?.edit || !pendingCommit) return;
    clearTimeout(commitTimer); pendingCommit = false;
    const sh = areaShape(M.edit.area);
    paint(true); if (sh) commit(kindOf(sh));
  }
  /** the picture's space changed (edit layout on or off, the bar shown or hidden): resize the frame and glide the view to where it should be */
  function relayout(enter) {
    const from = { ...M.view };
    updateActions(); // the bar, or its absence, decides how tall the frame can be
    setEditLayout(enter);
    layout();
    const to = M.view; M.view = from; applyView();
    structure();
    setView(to);
  }
  function enterEdit(areaIn) {
    if (!M || !areaIn) return;
    if (M.edit) { flushEdit(); M.edit = null; }
    let area = areaIn;
    if (area === 'garage' || area === 'adu') { const b = live().find((x) => x.what === area); if (!b) return; area = b.id; }
    M.pick = null; M.hl = null; M.sel = null; D.kindKey = null;
    try { const slot = mount.closest('#lot-map-slot'); if (slot) slot.scrollTop = 0; } catch { /* layout only */ } // the picture, not the legend, is what shows while editing
    if (area === 'street') {
      M.edit = { area, undo: [], changed: false, msg: '', zoomed: false };
      relayout(true); paint(true);
      (D.els.edges.find((x) => x.sh.kind === 'lot')?.line)?.focus({ preventScroll: true });
      return;
    }
    let sh = areaShape(area), created = false;
    if (!sh && (area === 'front' || area === 'back')) {
      sh = makeYard(area);
      if (!sh) { setNote('Choose the side of your lot that faces the street first, then you can edit the yards.'); updateActions(); return; }
      M.yards[area] = sh; created = true;
    }
    if (!sh) return;
    M.edit = { area, undo: [], created, changed: false, msg: '', zoomed: true };
    relayout(true); paint(true);
    D.els.handles.values().next().value?.focus({ preventScroll: true });
    announce(`Editing ${areaName(area)}. Drag a corner, or use the arrow keys.`);
  }
  function exitEdit(focusBack = true) {
    if (!M?.edit) return;
    flushEdit();
    const { area, created, changed } = M.edit;
    if (created && !changed && (area === 'front' || area === 'back')) M.yards[area] = null; // looked at, not changed: back to the automatic split
    M.edit = null; M.sel = null; D.kindKey = null;
    relayout(false); paint(true);
    if (focusBack && area !== 'street') (document.getElementById(`${uid}-edit-${area}`) ?? D.bAddBld)?.focus({ preventScroll: true });
  }
  function undoEdit() {
    const ed = M.edit; if (!ed || !ed.undo.length) return;
    const prev = ed.undo.pop();
    M.gestureBefore = snap(); // a step of its own for the list's Undo, and nothing is pushed to the edit's stack
    restore(prev); M.sel = null;
    const sh = areaShape(ed.area);
    structure(); paint(true);
    if (sh) { ed.msg = 'Stepped back.'; commit(kindOf(sh)); } else { commit('bld'); exitEdit(); }
    const fig = areaFigure(ed.area, M.m); if (M.edit && num(fig)) M.edit.msg = `Stepped back — ${areaName(ed.area)} is ${fmt(fig)} sq ft`;
    updateActions();
  }
  /** this area only: back to what the lookup measured (a yard goes back to the automatic split) */
  function resetArea() {
    const ed = M.edit; if (!ed || ed.area === 'street') return;
    const area = ed.area, sh = areaShape(area); if (!sh) return;
    beginGesture();
    const base = M.base;
    let leave = false;
    if (area === 'lot') { M.lot.verts = base.lot.map((v) => ({ ...v })); if (M.frontIds && !M.frontIds.every((id) => M.lot.verts.some((v) => v.id === id))) M.frontIds = base.front ? [...base.front] : null; }
    else if (area === 'front' || area === 'back') { M.yards[area] = null; leave = true; }
    else if (area === 'drv') { M.drv = base.drv ? cloneShape(base.drv) : null; leave = !M.drv; }
    else { const bb = base.blds.find((b) => b.id === sh.id); if (bb) sh.verts = bb.verts.map((v) => ({ ...v })); else { sh.removed = true; leave = true; } }
    M.sel = null;
    structure(); paint(true);
    commit(area === 'front' || area === 'back' ? 'yard' : area === 'lot' ? 'lot' : area === 'drv' ? 'drv' : 'bld');
    if (leave) { exitEdit(); return; }
    const fig = areaFigure(area, M.m);
    M.edit.msg = `Back to what we measured${num(fig) ? ` — ${areaName(area)} is ${fmt(fig)} sq ft` : ''}`; updateActions();
    setView(viewFor(areaShape(area)));
  }

  // ----- tap an area, light up an area ------------------------------------------------------------------------
  function lineKeyFor(area) {
    if (AREA_LINE[area]) return AREA_LINE[area];
    const sh = shapeOf(area); return sh?.what === 'garage' ? 'garage_area_sqft' : sh?.what === 'adu' ? 'adu_area_sqft' : null;
  }
  function flashLine(key) {
    const row = key ? document.querySelector(`.fact[data-key="${key}"]`) : null;
    if (!row) return;
    row.scrollIntoView({ block: 'center', behavior: reduced() ? 'auto' : 'smooth' });
    row.classList.remove('lm-flash'); void row.offsetWidth; row.classList.add('lm-flash');
    setTimeout(() => row.classList.remove('lm-flash'), 1100);
  }
  function pickArea(area) {
    M.pick = area; M.sel = null; M.hl = null; D.hlKey = null;
    paint(false);
    flashLine(lineKeyFor(area));
  }
  function setHl(areas) { if (!M) return; M.hl = areas; D.hlKey = null; if (D.els) applyHl(); }

  function onWhat(e) {
    const t = e.target; if (!t?.classList?.contains('lm-what') || !M) return;
    const sh = shapeOf(t.dataset.bid || t.dataset.for); if (sh) setWhat(sh, t.value);
  }
  function setWhat(sh, v) {
    beginGesture();
    M.edited = true; M.sel = null;
    let again = null;
    if (v === '__remove') { sh.removed = true; again = `${uid}-baddbld`; announce('Outline removed.'); }
    else if (v === '__house') { for (const b of M.blds) b.main = false; sh.main = true; sh.what = null; sh.whatSrc = null; announce('That outline is now the house.'); }
    else { sh.what = v || null; sh.whatSrc = v ? 'owner' : null; again = `${uid}-kind-${sh.id}`; announce(`${v ? WHAT_NAME[v] : 'Unnamed'}.`); }
    structure(); paint(true);
    commit(v === '__remove' || v === '__house' ? 'bld' : 'kind');
    if ((v === '__remove' || v === '__house') && M.edit) { exitEdit(false); }
    const el = again ? document.getElementById(again) : null; el?.focus({ preventScroll: true });
  }

  function addDriveway() {
    const m = M.m, fe = m?.zones?.frontEdge?.edges, bd = m?.zones?.bands;
    if (!fe?.length || !bd || !live().length) { setNote('Tap the side of your lot that faces the street first, then add your driveway.'); return; }
    const a = fe[0].from, z = fe[fe.length - 1].to, mid = { lng: (a.lng + z.lng) / 2, lat: (a.lat + z.lat) / 2 };
    const { kx, ky } = metresPerDegree(mid.lat);
    const nx = bd.nx, ny = bd.ny, ux = -ny, uy = nx;
    const house = live().find((x) => x.main);
    const hp = house ? house.verts.map((v) => [v.lng, v.lat]) : null, lp = M.lot.verts.map((v) => [v.lng, v.lat]);
    let t = 0.5;
    for (; t < 80; t += 0.25) {
      const lng = mid.lng + (nx * t) / kx, lat = mid.lat + (ny * t) / ky;
      if (hp && inPolyXY(hp, lng, lat)) break;
      if (t > 1.5 && !inPolyXY(lp, lng, lat)) break;
    }
    t = house ? Math.max(3, t - 0.1) : Math.min(8, t);
    const h = 5 * FT, t0 = 0.2;
    const at = (tt, s) => [mid.lng + (nx * tt + ux * s) / kx, mid.lat + (ny * tt + uy * s) / ky];
    const ring = [at(t0, -h), at(t0, h), at(t, h), at(t, -h)]; ring.push(ring[0]);
    beginGesture();
    M.drv = makeShape({ type: 'Polygon', coordinates: [ring] }, 'drv', false, 'Driveway'); M.drv.touched = true; M.drv.starter = true;
    M.edited = true; M.sel = null;
    structure(); paint(true); commit('drv');
    enterEdit('drv');
    announce('Driveway added. Drag its corners to match your driveway.');
  }
  function removeDriveway() {
    if (!M.drv) return;
    beginGesture();
    M.drv = null; M.edited = true; M.sel = null;
    structure(); paint(true); commit('drv');
    if (M.edit) exitEdit(false);
    document.getElementById(`${uid}-adddrv`)?.focus({ preventScroll: true });
    announce('Driveway removed.');
  }
  function addBuilding() {
    if (!M.lot) return;
    const bd = M.m?.zones?.bands;
    const lp = M.lot.verts.map((v) => [v.lng, v.lat]);
    const c = lp.reduce((s, p) => [s[0] + p[0] / lp.length, s[1] + p[1] / lp.length], [0, 0]);
    const { kx, ky } = metresPerDegree(c[1]);
    const nx = bd ? bd.nx : 0, ny = bd ? bd.ny : 1, ux = -ny, uy = nx;
    const w = 14 * FT / 2, d = 12 * FT / 2;
    const others = live().map((b) => b.verts.map((v) => [v.lng, v.lat]));
    const at = (t, a, b) => [c[0] + (nx * (t + b) + ux * a) / kx, c[1] + (ny * (t + b) + uy * a) / ky];
    const fits = (t) => {
      const corners = [at(t, -w, -d), at(t, w, -d), at(t, w, d), at(t, -w, d)], ctr = at(t, 0, 0);
      if (!corners.every((p) => inPolyXY(lp, p[0], p[1]))) return false;
      if (others.some((o) => inPolyXY(o, ctr[0], ctr[1]) || corners.some((p) => inPolyXY(o, p[0], p[1])) || o.some((p) => inPolyXY(corners, p[0], p[1])))) return false;
      return true;
    };
    let tt = 0, found = false;
    for (let t = 60; t >= -10; t -= 0.5) if (fits(t)) { tt = t; found = true; break; }
    if (!found) tt = 0;
    const ring = [at(tt, -w, -d), at(tt, w, -d), at(tt, w, d), at(tt, -w, d)]; ring.push(ring[0]);
    beginGesture();
    const sh = makeShape({ type: 'Polygon', coordinates: [ring] }, 'bld', false, 'Building'); sh.added = true;
    M.blds.push(sh); M.edited = true; M.sel = null;
    structure(); paint(true); commit('bld');
    enterEdit(sh.id);
    announce('Building added. Drag its corners, then say what it is.');
  }

  function addCornerAt(sh, i, point) {
    if (!sh || !M) return;
    const a = sh.verts[i], b = sh.verts[(i + 1) % sh.verts.length];
    let lng = (a.lng + b.lng) / 2, lat = (a.lat + b.lat) / 2;
    if (point) { // the tap's position projected onto the side, so the shape does not change until the corner is moved
      const [ax, ay] = px(a.lng, a.lat), [bx, by] = px(b.lng, b.lat);
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0.1, Math.min(0.9, ((point[0] - ax) * dx + (point[1] - ay) * dy) / l2));
      [lng, lat] = inv(ax + dx * t, ay + dy * t);
    }
    beginGesture(); if (sh.kind === 'drv') sh.touched = true;
    const nv = { id: ++VID, lng, lat };
    sh.verts.splice(i + 1, 0, nv);
    if (sh.kind === 'lot' && M.frontIds) { const ia = M.frontIds.indexOf(a.id), ib = M.frontIds.indexOf(b.id); if (ia >= 0 && ib === ia + 1) M.frontIds.splice(ib, 0, nv.id); }
    M.edited = true;
    structure(); select({ type: 'v', vid: nv.id });
    paint(true); commit(kindOf(sh));
    focusVertex(nv.id);
    announce('Corner added.');
  }

  function removeCorner(sh, vid) {
    if (sh.verts.length <= 3) { setNote('An outline needs at least 3 corners.'); return; }
    const i = sh.verts.findIndex((v) => v.id === vid);
    const trial = sh.verts.filter((v) => v.id !== vid);
    if (ringCrosses(trial)) { setNote("That would make the outline cross itself, so the corner stayed."); return; }
    beginGesture(); if (sh.kind === 'drv') sh.touched = true;
    const before = M.frontIds ? [...M.frontIds] : null;
    sh.verts = trial;
    if (sh.kind === 'lot' && M.frontIds) {
      M.frontIds = M.frontIds.filter((x) => x !== vid);
      if (M.frontIds.length < 2) { // the street side lost a corner: keep the side that is now nearest to where it was
        const keep = before.map((id) => sh.verts.find((v) => v.id === id)).filter(Boolean)[0] ?? sh.verts[Math.max(0, i - 1)];
        const k = sh.verts.findIndex((v) => v.id === keep.id);
        M.frontIds = [sh.verts[k].id, sh.verts[(k + 1) % sh.verts.length].id];
      }
    }
    setNote('');
    M.edited = true; M.sel = null;
    structure(); paint(true); commit(kindOf(sh));
    const nb = sh.verts[Math.max(0, i - 1) % sh.verts.length];
    focusVertex(nb.id);
    announce('Corner removed.');
  }

  function focusVertex(vid) { const g = D.els.handles.get(vid) ?? D.els.handles.values().next().value; g?.focus({ preventScroll: true }); }

  function chooseFront(i) {
    const vs = M.lot.verts;
    beginGesture();
    M.frontIds = [vs[i].id, vs[(i + 1) % vs.length].id]; M.frontSet = true;
    M.edited = true;
    const m = measureNow(); M.m = m;
    paint(true); commit('front');
    D.bFront.hidden = true;
    announce('Street side set.');
  }

  /** push what changed into the list, remember how to take it back */
  function commit(kind) { commitCore(kind); try { if (M && D.els) updateActions(); } catch { /* display only */ } }
  function commitCore(kind) {
    clearTimeout(commitTimer);
    const before = M.gestureBefore; M.gestureBefore = null;
    if (!before) return;
    pendingCommit = false;
    const m = M.m ?? measureNow(); M.m = m;
    if (M.edit && M.edit.area !== 'street') { const fig = areaFigure(M.edit.area, m); if (num(fig)) M.edit.msg = `Nice — ${areaName(M.edit.area)} is now ${fmt(fig)} sq ft`; }
    const keys = new Set(AFFECTS[kind] ?? ALL_KEYS);
    if (M.starter) keys.add('lot_area_sqft');
    const batch = {}, clearList = [];
    for (const k of keys) {
      const v = m?.[k];
      const own = M.mapKeys.get(k);
      if (!num(v)) { if (own && !own.typed) clearList.push(k); continue; } // e.g. the driveway was removed: the line goes back to what the lookup said
      if (own && !own.typed && M.baseM && v === M.baseM[k]) { clearList.push(k); continue; } // the outlines are back to what was looked up
      if (M.starter && !M.history.length && !M.mapKeys.size) { batch[k] = v; continue; }
      if (v !== M.lastMeasure?.[k]) batch[k] = v;
    }
    // garage and guest-house facts, from the names the owner gave to outlines (what the lookup said is left to the lookup)
    const F = kindFacts();
    for (const [k, v] of Object.entries(F)) if (M.mapKeys.get(k)?.pushed !== v) batch[k] = v;
    for (const k of KIND_KEYS) if (!(k in F)) { const own = M.mapKeys.get(k); if (own && !own.typed) clearList.push(k); }
    M.lastMeasure = m;
    if (!Object.keys(batch).length && !clearList.length) return;
    M.history.push({ before, keys: [...Object.keys(batch), ...clearList] });
    for (const [k, v] of Object.entries(batch)) M.mapKeys.set(k, { pushed: v, typed: false });
    for (const k of clearList) M.mapKeys.delete(k);
    pushing = true;
    try { if (Object.keys(batch).length) applyOwnerCorrections(batch); if (clearList.length) clearOwnerCorrections(clearList); } finally { pushing = false; }
    announce(`${num(batch.lot_area_sqft) ? `Lot size is now ${fmt(batch.lot_area_sqft)} sq ft. ` : ''}${num(batch.building_footprint_sqft) ? `House footprint is now ${fmt(batch.building_footprint_sqft)} sq ft. ` : ''}`.trim() || 'Numbers updated.');
  }

  /** garage and ADU facts implied by the names the owner gave */
  function kindFacts() {
    const F = {}; let g = 0, a = 0, hg = false, ha = false;
    for (const b of live()) {
      if (b.main || b.whatSrc !== 'owner') continue;
      if (b.what === 'garage') { hg = true; g += areaOf(b); } else if (b.what === 'adu') { ha = true; a += areaOf(b); }
    }
    if (hg) { F.garage_present = true; F.garage_area_sqft = Math.round(g); }
    if (ha) { F.adu_present = true; F.adu_area_sqft = Math.round(a); }
    return F;
  }

  function resetAll() {
    const typedKeep = [...M.mapKeys].filter(([, o]) => o.typed).map(([k]) => k);
    const clear = [...M.mapKeys.keys()].filter((k) => !typedKeep.includes(k));
    restore(M.base);
    M.frontIds = M.baseFront ? [...M.baseFront] : null; M.frontSet = false;
    M.history = []; M.mapKeys = new Map(); M.edited = false; M.sel = null; M.gestureBefore = null; M.note = ''; M.needsMatchNote = false;
    structure();
    M.m = measureNow(); M.lastMeasure = M.m;
    pushing = true;
    try { if (clear.length) clearOwnerCorrections(clear); } finally { pushing = false; }
    paint(true);
    D.toggle.focus({ preventScroll: true });
    announce('Outlines reset to what we measured.');
  }

  /** the owner pressed Undo on a line in the list: take the outlines back to before the change that produced it */
  function rollback(undone) {
    let idx = M.history.findIndex((h) => h.keys.some((k) => undone.includes(k)));
    if (idx < 0) idx = 0;
    const dropped = M.history.slice(idx);
    const droppedKeys = new Set(dropped.flatMap((h) => h.keys));
    for (const k of undone) droppedKeys.add(k);
    const target = M.history[idx]?.before ?? M.base;
    restore(target);
    M.history = M.history.slice(0, idx);
    const clear = [];
    for (const k of droppedKeys) {
      const o = M.mapKeys.get(k);
      M.mapKeys.delete(k);
      if (o && !o.typed && !undone.includes(k)) clear.push(k);
    }
    M.edited = M.history.length > 0; M.sel = null; M.note = '';
    structure();
    M.m = measureNow(); M.lastMeasure = M.m;
    if (clear.length) { pushing = true; try { clearOwnerCorrections(clear); } finally { pushing = false; } }
    paint(true);
  }

  // ----- the photo ---------------------------------------------------------------------------------------------
  function showCredit() {
    const year = M.imageInfo?.date ? String(M.imageInfo.date).slice(0, 4) : '';
    D.credit.textContent = `${M.imageInfo?.credit ?? core.credit}${/^\d{4}$/.test(year) ? `, ${year}` : ''}. It is a soft public photo, so treat it as a guide.`;
    D.credit.hidden = false;
  }
  function loadPhoto() {
    if (!M || M.imgState !== 'idle') return;
    M.imgState = 'loading';
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const long = Math.round(clamp(M.wm * 9 * (dpr > 1 ? 1.15 : 1), 700, 1800)); // about 9 px per metre across the whole box: enough for the picture at its largest
    const url = photoUrl(M.frame.bbox, long, core.usgs);
    D.frame.dataset.photoUrl = url;
    D.img.src = url;
  }

  // ----- update (called after every render of the page) -----------------------------------------------------
  function update() {
    if (suspended) return;
    let profile = null;
    try { profile = getProfile(); } catch { profile = null; }
    if (!profile) { if (M) { M = null; mount.hidden = true; } return; }
    if (coreState === 'none') return;
    const src = readSource();
    if (!src || (!src.parcel && !src.buildings.length)) { if (M) { M = null; mount.hidden = true; } return; }
    if (coreState !== 'ready') { loadCore(); return; }
    if (pushing) return;
    // a new property, or new outlines arriving for this one
    const sigP = src.parcel ? sigOf(src.parcel) : 'none', sigB = src.buildings.map((b) => sigOf(b.polygon)).join('|');
    if (M && M.sigP !== sigP) { clearTimeout(setupTimer); M = null; }
    else if (M && src.from === 'bundle' && M.bundleRef !== src.ref) adoptBundle(src);
    if (M && M.sigP === sigP && M.sigB !== sigB && !M.starter && (!M.edited || !M.blds.length)) { refreshBuildings(src, sigB); return; }
    if (!M) {
      mount.hidden = true;
      if (setupTimer) return;
      // heavy work after the page has painted the list
      setupTimer = requestAnimationFrame(() => { setupTimer = setTimeout(() => {
        setupTimer = 0;
        if (suspended) return;
        const s2 = readSource();
        if (!s2 || !setup(s2)) { mount.hidden = true; return; }
        build(); mount.hidden = false;
        // the photo's box follows the shape of the space it will fill, so the picture is as large as the column allows
        M.frame = frameForDisplay(M.lot.verts.map((v) => [v.lng, v.lat]), (D.stage.clientWidth || 600) / frameHeight()); M.wm = (M.frame.bbox[2] - M.frame.bbox[0]) * M.frame.kx;
        layout(); structure(); D.sub.textContent = subline(); paint(true); afterRender();
        setTimeout(() => { if (M) loadPhoto(); }, 0);
      }, 0); });
      return;
    }
    // typed-over or undone lines
    if (!pushing) {
      const a = profile.attributes ?? {};
      const undone = [];
      for (const [k, o] of M.mapKeys) {
        const at = a[k];
        if (!at || at.tag !== 'owner-confirmed') undone.push(k);
        else if (at.value !== o.pushed) o.typed = true;
      }
      if (undone.length) rollback(undone);
    }
  }
  /** building outlines arrived (or changed) for the property on screen: swap them in place, keeping the frame and the photo */
  function refreshBuildings(src, sigB) {
    M.sigB = sigB; M.blds = [];
    for (const b of src.buildings) { try { const sh = makeShape(b.polygon, 'bld', b.main, b.main ? 'House' : 'Building'); if (b.kind && !b.main) { sh.what = b.kind; sh.whatSrc = 'lookup'; } M.blds.push(sh); } catch { /* skip */ } }
    pickMain();
    if (src.driveway && !(M.drv && M.drv.touched)) { try { M.drv = makeShape(src.driveway, 'drv', false, 'Driveway'); } catch { /* keep none */ } }
    const gb = M.drag ? M.gestureBefore : null; // a corner being dragged keeps the snapshot it started from
    M.base = snap(); M.history = []; M.mapKeys = new Map(); M.sel = null; M.gestureBefore = gb;
    const hasRef = (M.rest.streets && M.rest.streets.length) || M.rest.frontEdge || M.rest.frontPoint;
    if (!hasRef && !M.frontSet) { const ids = inferFront(); M.frontIds = ids; M.baseFront = ids; M.base = snap(); }
    M.m = measureNow(); M.baseM = baselineMeasure(); M.lastMeasure = M.edited ? {} : M.m; // edited: every yard figure the map now has is new to the list
    const dragging = M.drag ? { ...M.drag } : null;
    structure(); paint(true);
    if (dragging) { // the corner being dragged was rebuilt with the rest: hand the pointer to the new one, no focus change otherwise
      const g = D.els.handles.get(dragging.vid);
      if (g) { try { g.setPointerCapture(dragging.pid); } catch { /* pointer already gone */ } if (document.activeElement && document.activeElement.closest?.('#lot-map')) g.focus({ preventScroll: true }); }
    }
  }
  const subline = () => (M.starter ? 'This is a starting box around your house. Drag the corners to match your lot.'
    : M.parcelSource === 'estimated' ? 'This lot outline is an estimate. Drag the corners to match your lot.'
      : 'These are the outlines we measured. Drag a corner if one is off.');

  // ----- the list and the picture talk to each other ----------------------------------------------------------
  const H = { focus: null, hover: null, mid: null };
  function refreshListHl() {
    if (!M || !D.els || M.edit) return;
    const a = H.focus ?? H.hover ?? H.mid, next = a ? [...a] : null;
    if (JSON.stringify(next) === JSON.stringify(M.hl)) return;
    M.hl = next; D.hlKey = null; applyHl();
  }
  const rowOf = (t) => t?.closest?.('#facts .fact[data-key]') ?? null;
  const areasOfRow = (row) => (row ? (LINE_AREAS[row.dataset.key] ?? null) : null);
  document.addEventListener('focusin', (e) => { H.focus = areasOfRow(rowOf(e.target)); refreshListHl(); });
  document.addEventListener('focusout', (e) => { H.focus = areasOfRow(rowOf(e.relatedTarget)); refreshListHl(); });
  document.addEventListener('mouseover', (e) => { H.hover = areasOfRow(rowOf(e.target)); refreshListHl(); });
  document.addEventListener('mouseout', (e) => { H.hover = areasOfRow(rowOf(e.relatedTarget)); refreshListHl(); });
  document.addEventListener('click', (e) => { const b = e.target.closest?.('[data-lm-edit]'); if (!b || !M) return; e.preventDefault(); enterEdit(b.dataset.lmEdit); });
  document.addEventListener('keydown', onDocKey);
  let io = null; const midRows = new Set();
  function observeRows() {
    if (typeof IntersectionObserver !== 'function') return;
    if (!io) io = new IntersectionObserver((entries) => {
      for (const en of entries) { const k = en.target.dataset.key; if (en.isIntersecting) midRows.add(k); else midRows.delete(k); }
      const last = [...midRows].filter((k) => LINE_AREAS[k]).pop();
      H.mid = last ? LINE_AREAS[last] : null; refreshListHl();
    }, { rootMargin: '-42% 0px -42% 0px' });
    io.disconnect(); midRows.clear(); H.mid = null;
    for (const row of document.querySelectorAll('#facts .fact[data-key]')) if (LINE_AREAS[row.dataset.key]) io.observe(row);
  }
  function canEdit(area) {
    if (area === 'lot') return true;
    if (area === 'house') return live().some((b) => b.main);
    if (area === 'drv') return Boolean(M.drv);
    if (area === 'front' || area === 'back') return Boolean(M.yards[area] || derivedZones(M.m));
    return live().some((b) => b.what === area);
  }
  /** a small "Edit on photo" button on each list line that has an area on the picture (added after every render of the list) */
  function injectListButtons() {
    for (const row of document.querySelectorAll('#facts .fact[data-key]')) {
      const area = LINE_EDIT[row.dataset.key];
      if (!area || row.querySelector('.lm-listedit') || !canEdit(area)) continue;
      const ctl = row.querySelector('.fact-meta') ?? row.querySelector('.fact-ctl'); if (!ctl) continue;
      const label = row.querySelector('.flabel')?.textContent?.trim() || row.dataset.key;
      const b = document.createElement('button');
      b.type = 'button'; b.tabIndex = -1; /* typing down the list stays a straight run of inputs; the same Edit buttons sit in the picture's legend */ b.className = 'linkbtn lm-listedit'; b.dataset.lmEdit = area; b.textContent = 'Edit on photo'; b.setAttribute('aria-label', `Edit ${label} on the photo`);
      ctl.append(b);
    }
  }
  function afterRender() {
    const shown = Boolean(M && !mount.hidden && !suspended);
    syncPicLayout(shown, Boolean(M?.edit) && !phone());
    if (shown) { try { injectListButtons(); observeRows(); } catch { /* the buttons are a convenience */ } }
  }
  const hdr = document.querySelector('header.top');
  if (hdr && typeof ResizeObserver === 'function') new ResizeObserver(() => syncPicLayout(document.getElementById('property')?.classList.contains('has-pic'))).observe(hdr);
  if (mq.addEventListener) mq.addEventListener('change', () => { if (M && D.els) { layout(); if (M.edit && M.edit.area !== 'street') { const sh = areaShape(M.edit.area); if (sh) M.view = viewFor(sh); applyView(); } paint(true); } });

  /** Let go of the mount (a condo owner sees the read-only picture there instead); the next update() builds again. */
  function hide() { suspended = true; layoutObs?.disconnect(); if (M) { M = null; mount.hidden = true; } }

  return { update: () => { suspended = false; update(); afterRender(); }, hide: () => { hide(); syncPicLayout(false); } };
}
