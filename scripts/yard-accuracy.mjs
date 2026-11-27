#!/usr/bin/env node
// Yard accuracy run (Stages 1-4 of the "yards from aerial photos" work). Re-runnable. Reads ONLY the ten Los Angeles addresses below
// (the public assessor situs addresses of docs/phase1-accuracy.md) and prints the measurement tables used in docs/yard-accuracy.md.
//
//   NODE_USE_ENV_PROXY=1 node scripts/yard-accuracy.mjs --cache <dir> [--max-requests 160] [--png <dir>] [--json <file>]
//
// Live network: ONLY the six hosts in ALLOWED, sequential, 300 ms apart, with a hard cap. Every answer is kept in --cache (keyed by url, range
// and body), so a second run makes no request. Imagery is written only when --png is given (keep it out of the repository: photos of homes).
// Nothing personal is printed: per-address area figures and aggregate numbers only.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { laAssessor } from '../core/providers/la-assessor.js';
import { laCamsAddress } from '../core/providers/la-cams-address.js';
import { lariacBuildings } from '../core/providers/lariac-buildings.js';
import { overtureBuildings } from '../core/providers/overture-buildings.js';
import { overtureRoads } from '../core/providers/overture-roads.js';
import { streetReference } from '../core/street-ref.js';
import { splitYard } from '../core/yard.js';
import { centroid, polygonAreaSqft, pointInPolygon } from '../core/geometry.js';
import { estimateLot, polygonIoU } from '../core/lot-estimate.js';
import { naipAerial } from '../core/providers/naip-aerial.js';
import { classifyLot, CLASS } from '../core/aerial.js';

const ADDRESSES = [
  '5847 S FIGUEROA ST LOS ANGELES CA 90003', '15739 MULHOLLAND PL LOS ANGELES CA 90049', '13300 MISSION TIERRA WAY LOS ANGELES CA 91344',
  '3207 AMETHYST ST LOS ANGELES CA 90032', '2106 BARRYWOOD AVE LOS ANGELES CA 90731', '1829 S COCHRAN AVE LOS ANGELES CA 90019',
  '7723 VARNA AVE LOS ANGELES CA 91605', '5313 S CENTINELA AVE LOS ANGELES CA 90066', '2705 W LYTELLE PL LOS ANGELES CA 90041',
  '5741 CORBIN AVE LOS ANGELES CA 91356',
];
const ALLOWED = new Set(['imagery.nationalmap.gov', 'planetarycomputer.microsoft.com', 'overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com', 'stac.overturemaps.org', 'public.gis.lacounty.gov', 'geo.fcc.gov']);
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const CACHE = arg('--cache', null);
const MAX = Number(arg('--max-requests', '160'));
const PNG = arg('--png', null);
const JSON_OUT = arg('--json', null);
const NOW = new Date().toISOString();
if (!CACHE) { console.error('pass --cache <dir> (answers are kept there; a second run makes no request)'); process.exit(2); }
mkdirSync(CACHE, { recursive: true });

let live = 0, cached = 0, last = 0; const byHost = {}; let bytes = 0;
/** fetch with an allowlist, a cap, a polite gap and a disk cache. Returns a fetch-like response. */
async function liveFetch(url, init = {}) {
  const host = new URL(url).hostname;
  if (!ALLOWED.has(host)) throw new Error(`host not allowed: ${host}`);
  const h = init.headers ?? {};
  const key = createHash('sha1').update(`${url}|${init.method ?? 'GET'}|${h.Range ?? h.range ?? ''}|${init.body ?? ''}`).digest('hex');
  const f = join(CACHE, key);
  let meta, body;
  if (existsSync(`${f}.meta`)) { meta = JSON.parse(readFileSync(`${f}.meta`, 'utf8')); body = readFileSync(`${f}.body`); cached++; }
  else {
    if (live >= MAX) throw new Error(`request cap ${MAX} reached`);
    const wait = 300 - (Date.now() - last); if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now(); live++; byHost[host] = (byHost[host] ?? 0) + 1;
    const r = await fetch(url, { ...init, signal: undefined });
    body = Buffer.from(await r.arrayBuffer()); bytes += body.length;
    meta = { status: r.status, headers: Object.fromEntries(r.headers.entries()) };
    writeFileSync(`${f}.meta`, JSON.stringify(meta)); writeFileSync(`${f}.body`, body);
    appendFileSync(join(CACHE, 'requests.log'), `${new Date().toISOString()} ${host} ${body.length}\n`);
  }
  const hd = new Map(Object.entries(meta.headers));
  return { ok: meta.status >= 200 && meta.status < 300, status: meta.status, headers: { get: (k) => hd.get(String(k).toLowerCase()) ?? null },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length), text: async () => body.toString('utf8'), json: async () => JSON.parse(body.toString('utf8')) };
}
const deps = { fetch: liveFetch, now: NOW, timeoutMs: 30000 };
const med = (a) => { const v = a.filter((x) => x !== null && Number.isFinite(x)).sort((x, y) => x - y); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
const mx = (a) => { const v = a.filter((x) => x !== null && Number.isFinite(x)); return v.length ? Math.max(...v) : null; };
const f0 = (n) => (n === null || n === undefined || !Number.isFinite(n) ? 'n/a' : String(Math.round(n)));
const f1 = (n) => (n === null || n === undefined || !Number.isFinite(n) ? 'n/a' : n.toFixed(1));
const f2 = (n) => (n === null || n === undefined || !Number.isFinite(n) ? 'n/a' : n.toFixed(2));
const pctErr = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && b ? ((a - b) / b) * 100 : null);

/** Everything one address needs, fetched once. */
async function gather(address) {
  const rec = await laAssessor.lookup({ address }, deps);
  const cams = await laCamsAddress.resolve(address, deps);
  const parcel = rec.ok ? rec.parcel.boundary : null;
  const pc = parcel ? centroid(parcel) : null;
  const lar = parcel ? await lariacBuildings.lookup({ lat: pc.lat, lng: pc.lng, parcel }, deps) : null;
  const roads = pc ? await overtureRoads.lookup({ lat: pc.lat, lng: pc.lng }, deps) : null;
  const ov = pc ? await overtureBuildings.lookup({ lat: pc.lat, lng: pc.lng, radiusM: 70 }, deps) : null;
  return { address, rec, cams, parcel, pc, lar, roads, ov };
}

/** Front-edge identity: the set of parcel edge indexes of the chosen front group, compared as midpoints. */
const frontKey = (y) => (y && y.ok ? y.frontEdge.edges.map((e) => `${e.from.lat.toFixed(6)},${e.from.lng.toFixed(6)}`).sort().join('|') : null);

function stage1(d) {
  const buildings = d.lar?.ok ? d.lar.buildings.map((b) => b.polygon) : [];
  if (!d.parcel || !buildings.length) return { ok: false, why: 'no parcel or no building' };
  let main = 0; d.lar.buildings.forEach((b, i) => { if (b.areaSqft > d.lar.buildings[main].areaSqft) main = i; });
  const pt = d.cams.ok ? { lat: d.cams.lat, lng: d.cams.lng } : null;
  const byPoint = pt ? splitYard({ parcel: d.parcel, buildings, frontPoint: pt, mainBuildingIndex: main }) : { ok: false, reason: 'county locator found no point' };
  const ref = d.roads?.ok ? streetReference({ streets: d.roads.streets, address: d.address }) : null;
  const byLine = ref ? splitYard({ parcel: d.parcel, buildings, streets: ref.streets, ...(ref.streetName ? { streetName: ref.streetName } : {}), mainBuildingIndex: main }) : { ok: false, reason: 'no street lines' };
  return { ok: true, byPoint, byLine, ref, main, buildings, sameFront: byPoint.ok && byLine.ok ? frontKey(byPoint) === frontKey(byLine) : null };
}

function stage2(d, s1) {
  if (!d.parcel || !d.ov?.ok || !d.roads?.ok) return { ok: false, why: 'missing parcel, Overture buildings or roads' };
  // the house: the Overture building on the parcel (centroid inside) that is largest; neighbours: every other Overture building found
  const onP = d.ov.buildings.filter((b) => pointInPolygon(centroid(b.polygon.type === 'Polygon' ? b.polygon : { type: 'Polygon', coordinates: b.polygon.coordinates[0] }), d.parcel));
  if (!onP.length) return { ok: false, why: 'no Overture building on the parcel' };
  const house = onP.sort((a, b) => b.areaSqft - a.areaSqft)[0];
  const neighbours = d.ov.buildings.filter((b) => b !== house).map((b) => b.polygon);
  const ref = streetReference({ streets: d.roads.streets, address: d.address });
  const est = estimateLot({ building: house.polygon, neighbours, streets: d.roads.streets, streetName: ref?.streetName ?? null });
  if (!est.ok) return { ok: false, why: est.reason };
  const trueA = polygonAreaSqft(d.parcel);
  const iou = polygonIoU(est.polygon, d.parcel);
  const yEst = ref ? splitYard({ parcel: est.polygon, buildings: [house.polygon], streets: ref.streets, ...(ref.streetName ? { streetName: ref.streetName } : {}), mainBuildingIndex: 0 }) : null;
  return { ok: true, est, trueA, errPct: pctErr(est.areaSqft, trueA), iou, yEst, onParcel: onP.length };
}

async function main() {
  const rows = [];
  for (const a of ADDRESSES) {
    const d = await gather(a);
    const s1 = stage1(d);
    const s2 = stage2(d, s1);
    let s3 = null;
    if (s1.ok && s1.byLine.ok || s1.ok && s1.byPoint.ok) {
      const y = s1.byLine.ok ? s1.byLine : s1.byPoint;
      const img = await naipAerial.lookup({ parcel: d.parcel, lat: d.pc.lat, lng: d.pc.lng }, deps);
      s3 = img.ok ? { img, cls: classifyLot({ image: img.image, parcel: d.parcel, buildings: s1.buildings, yard: y, streets: s1.ref?.streets ?? [] }) } : { img };
    }
    rows.push({ d, s1, s2, s3 });
    if (PNG && s3?.img?.ok) { const { writeClassPng } = await import('./lib/png.mjs').catch(() => ({ writeClassPng: null })); if (writeClassPng) writeClassPng(join(PNG, `addr${rows.length}`), s3.img.image, s3.cls); }
  }
  report(rows);
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(rows.map((r, i) => ({ i: i + 1, s1: summary1(r), s2: summary2(r), s3: summary3(r) })), null, 1));
}

const summary1 = (r) => (r.s1.ok ? { point: r.s1.byPoint.ok ? pick(r.s1.byPoint) : r.s1.byPoint.reason, line: r.s1.byLine.ok ? pick(r.s1.byLine) : r.s1.byLine.reason, same: r.s1.sameFront, ref: r.s1.ref?.how ?? null } : r.s1.why);
const pick = (y) => ({ front: y.frontYardSqft, back: y.backYardSqft, side: y.sideYardSqft, open: y.openSqft, conf: y.confidence, warn: y.warnings });
const summary2 = (r) => (r.s2.ok ? { est: Math.round(r.s2.est.areaSqft), truth: Math.round(r.s2.trueA), errPct: r.s2.errPct, iou: r.s2.iou, warn: r.s2.est.warnings } : r.s2.why);
const summary3 = (r) => (r.s3?.cls ? r.s3.cls.summary : r.s3?.img?.reason ?? null);

function report(rows) {
  const L = [];
  L.push(`Run ${NOW}; live requests ${live} (${Object.entries(byHost).map(([h, c]) => `${h} ${c}`).join(', ') || 'none'}), ${Math.round(bytes / 1024)} KB; answered from cache ${cached}.`, '');
  // ---- stage 1
  L.push('STAGE 1: front edge from the county locator point vs from Overture centrelines (same parcel and LARIAC outlines)', '');
  L.push('| # | ref | same front | front pt / line | back pt / line | side pt / line | conf pt / line |', '|---|---|---|---|---|---|---|');
  const dF = [], dB = [];
  rows.forEach((r, i) => {
    if (!r.s1.ok) { L.push(`| ${i + 1} | ${r.s1.why} | | | | | |`); return; }
    const p = r.s1.byPoint, l = r.s1.byLine;
    const v = (y, k) => (y.ok ? f0(y[k]) : 'fail');
    if (p.ok && l.ok) { dF.push(Math.abs(p.frontYardSqft - l.frontYardSqft)); dB.push(Math.abs(p.backYardSqft - l.backYardSqft)); }
    L.push(`| ${i + 1} | ${r.s1.ref ? (r.s1.ref.matched ? 'named' : 'nearest') : 'none'} | ${r.s1.sameFront === null ? 'n/a' : r.s1.sameFront ? 'yes' : 'NO'} | ${v(p, 'frontYardSqft')} / ${v(l, 'frontYardSqft')} | ${v(p, 'backYardSqft')} / ${v(l, 'backYardSqft')} | ${v(p, 'sideYardSqft')} / ${v(l, 'sideYardSqft')} | ${p.ok ? p.confidence : '-'} / ${l.ok ? l.confidence : '-'} |`);
  });
  const both = rows.filter((r) => r.s1.ok && r.s1.byPoint.ok && r.s1.byLine.ok);
  L.push('', `both methods: ${both.length}/10; same front edge: ${both.filter((r) => r.s1.sameFront).length}/${both.length}; |front diff| median ${f0(med(dF))} max ${f0(mx(dF))} sq ft; |back diff| median ${f0(med(dB))} max ${f0(mx(dB))} sq ft;`
    + ` centreline split produced: ${rows.filter((r) => r.s1.ok && r.s1.byLine.ok).length}/10 (named street matched: ${rows.filter((r) => r.s1.ref?.matched).length}); point split produced: ${rows.filter((r) => r.s1.ok && r.s1.byPoint.ok).length}/10`, '');
  for (const [i, r] of rows.entries()) if (r.s1.ok) { const w = (y) => (y.ok ? y.warnings.join('; ') : y.reason); L.push(`#${i + 1} point: ${w(r.s1.byPoint)}`, `#${i + 1} line: ${w(r.s1.byLine)}`); }
  // ---- stage 2
  L.push('', 'STAGE 2: estimated lot (Overture buildings + Overture roads) vs the assessor parcel', '', '| # | est sq ft | parcel sq ft | error % | IoU | front est/true | back est/true | warnings |', '|---|---|---|---|---|---|---|---|');
  rows.forEach((r, i) => {
    if (!r.s2.ok) { L.push(`| ${i + 1} | ${r.s2.why} | | | | | | |`); return; }
    const t = r.s1.ok && r.s1.byLine.ok ? r.s1.byLine : null, e = r.s2.yEst?.ok ? r.s2.yEst : null;
    L.push(`| ${i + 1} | ${f0(r.s2.est.areaSqft)} | ${f0(r.s2.trueA)} | ${f1(r.s2.errPct)} | ${f2(r.s2.iou)} | ${e ? f0(e.frontYardSqft) : 'fail'}/${t ? f0(t.frontYardSqft) : 'n/a'} | ${e ? f0(e.backYardSqft) : 'fail'}/${t ? f0(t.backYardSqft) : 'n/a'} | ${r.s2.est.warnings.length} |`);
  });
  const errs = rows.filter((r) => r.s2.ok).map((r) => Math.abs(r.s2.errPct));
  L.push('', `lot area |error|: n ${errs.length}, median ${f1(med(errs))}%, max ${f1(mx(errs))}%; IoU median ${f2(med(rows.filter((r) => r.s2.ok).map((r) => r.s2.iou)))}, min ${f2(Math.min(...rows.filter((r) => r.s2.ok).map((r) => r.s2.iou)))}`);
  const rule = errs.length === 10 && med(errs) <= 20 && mx(errs) <= 50;
  L.push(`DECISION RULE (median <= 20% and max <= 50% on all ten): ${rule ? 'MET' : 'NOT MET'}`, '');
  // ---- stage 3
  L.push('STAGE 3: aerial classification of the open ground (USDA NAIP, 60 cm)', '', '| # | photo | open geom | open pixels | green | tree | paved/bare | water | shadow | pool | roof veg % | front paving warn |', '|---|---|---|---|---|---|---|---|---|---|---|---|');
  rows.forEach((r, i) => {
    const c = r.s3?.cls;
    if (!c || !c.ok) { L.push(`| ${i + 1} | ${r.s3?.img?.reason ?? c?.reason ?? 'not run'} | | | | | | | | | | |`); return; }
    const s = c.summary;
    L.push(`| ${i + 1} | ${r.s3.img.image.date} ${r.s3.img.image.bands} | ${f0(s.openGeomSqft)} | ${f0(s.openPixelSqft)} | ${f0(s.greenSqft)} | ${f0(s.treeSqft)} | ${f0(s.pavedSqft)} | ${f0(s.waterSqft)} | ${f0(s.shadowSqft)} | ${s.pool ? f0(s.pool.areaSqft) : '-'} | ${f1(s.roofVegPct)} | ${c.frontPavingWarning ? 'yes' : 'no'} |`);
  });
  const imgReq = rows.map((r) => r.s3?.img?.counts?.requests ?? null), imgB = rows.map((r) => r.s3?.img?.counts?.bytes ?? null);
  L.push('', `imagery cost per property: requests median ${f0(med(imgReq))}, bytes median ${f0(med(imgB))}; roads: requests ${rows.map((r) => r.d.roads?.counts?.requests ?? '-').join(',')} bytes ${rows.map((r) => r.d.roads?.counts?.bytes ?? '-').join(',')}`);
  L.push(`remodeled_year: ${rows.filter((r) => r.d.rec.ok && r.d.rec.fields.remodeled_year?.value != null).length}/10 have an effective year later than the year built (${rows.map((r) => r.d.rec.ok ? `${r.d.rec.raw?.YearBuilt1 ?? '-'}->${r.d.rec.raw?.EffectiveYear1 ?? '-'}` : '-').join(', ')})`);
  console.log(L.join('\n'));
}

main().catch((e) => { console.error(e); process.exit(1); });
