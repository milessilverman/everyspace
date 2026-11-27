#!/usr/bin/env node
// Phase 1 acceptance run: 10 Los Angeles single-family situs addresses -> buildPropertyProfile with the KEYLESS providers
// (county locator + Census geocoder -> LA assessor -> LARIAC outlines -> yard split), then independent checks, written to
// docs/phase1-accuracy.md. No API keys: RentCast and Google Solar are skipped and reported as "not run".
//
//   NODE_USE_ENV_PROXY=1 node scripts/phase1-accuracy.mjs            # run the 10 addresses below, write the doc
//   NODE_USE_ENV_PROXY=1 node scripts/phase1-accuracy.mjs --select   # print addresses chosen by the documented rule
// Live network: ONLY public.gis.lacounty.gov and geocoding.geo.census.gov, sequential, 250 ms apart, hard cap on requests.

import { writeFileSync } from 'node:fs';
import { buildPropertyProfile } from '../core/property-profile.js';
import { createDefaultRegistry } from '../core/providers/registry.js';
import { lariacBuildings } from '../core/providers/lariac-buildings.js';
import { ringsToGeoJSON, situsMatchesAddress } from '../core/parcel.js';

/** The ONLY input of the accuracy run: situs addresses as the assessor publishes them (public record). */
const ADDRESSES = [
  '5847 S FIGUEROA ST LOS ANGELES CA 90003', '15739 MULHOLLAND PL LOS ANGELES CA 90049', '13300 MISSION TIERRA WAY LOS ANGELES CA 91344',
  '3207 AMETHYST ST LOS ANGELES CA 90032', '2106 BARRYWOOD AVE LOS ANGELES CA 90731', '1829 S COCHRAN AVE LOS ANGELES CA 90019',
  '7723 VARNA AVE LOS ANGELES CA 91605', '5313 S CENTINELA AVE LOS ANGELES CA 90066', '2705 W LYTELLE PL LOS ANGELES CA 90041',
  '5741 CORBIN AVE LOS ANGELES CA 91356',
];
const ZIPS = ['90003', '90049', '91344', '90032', '90731', '90019', '91605', '90066', '90041', '91356', '90016', '90065', '90061', '91402'];
const ALLOWED = new Set(['public.gis.lacounty.gov', 'geocoding.geo.census.gov']);
const MAX_REQUESTS = Number(process.env.MAX_REQUESTS ?? 100);
const PARCEL = 'https://public.gis.lacounty.gov/public/rest/services/LACounty_Cache/LACounty_Parcel/MapServer/0/query';
const NOW = new Date().toISOString();

let count = 0; const byHost = {}; let last = 0;
async function liveFetch(url, init) {
  const host = new URL(url).hostname;
  if (!ALLOWED.has(host)) throw new Error(`host not allowed: ${host}`);
  if (count >= MAX_REQUESTS) throw new Error(`request cap ${MAX_REQUESTS} reached`);
  const wait = 250 - (Date.now() - last); if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now(); count++; byHost[host] = (byHost[host] ?? 0) + 1;
  return fetch(url, init);
}
const deps = { fetch: liveFetch, now: NOW, timeoutMs: 30000 };
const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const fmt = (n, d = 2) => (n === null || n === undefined ? 'n/a' : Number(n).toFixed(d));

async function select() {
  const out = [], log = [];
  for (const zip of ZIPS) {
    if (out.length >= 10) break;
    const where = `UseCode_2='01' AND UseType='Residential' AND SQFTmain1>0 AND SitusCity LIKE 'LOS ANGELES%' AND SitusZIP LIKE '${zip}%' AND SitusHouseNo<>' ' AND SitusStreet<>' '`;
    const r = await (await liveFetch(PARCEL + '?' + new URLSearchParams({ where, outFields: '*', returnGeometry: 'true', outSR: '4326', orderByFields: 'OBJECTID', resultRecordCount: '4', f: 'json' }).toString().replace(/\+/g, '%20'))).json();
    let picked = null;
    for (const f of r.features ?? []) {
      const a = f.attributes, g = ringsToGeoJSON(f.geometry.rings);
      if (!/^\d+$/.test(String(a.SitusHouseNo).trim()) || !a.SitusFullAddress) { log.push(`${zip}: skip ${a.AIN} incomplete situs`); continue; }
      const b = await lariacBuildings.lookup({ lat: a.CENTER_LAT, lng: a.CENTER_LON, parcel: g }, deps);
      if (b.ok && b.buildings.length === 1) { picked = a.SitusFullAddress; break; }
      log.push(`${zip}: skip ${a.AIN} (${b.ok ? b.buildings.length + ' building records' : b.reason})`);
    }
    if (picked) out.push(picked); else log.push(`${zip}: no qualifying parcel among the first 4`);
  }
  console.log(JSON.stringify({ addresses: out, log, requests: count }, null, 1));
}

function check(p, input) {
  const d = p.details ?? {}, f = p.fields;
  const cc = f.lot_sqft.cross_check;
  const raw = d.parcel?.raw ?? {};
  const extra = ['SQFTmain2', 'SQFTmain3', 'SQFTmain4', 'SQFTmain5'].filter((k) => Number(raw[k]) > 0).length;
  const bld = (d.buildings ?? []);
  const ratio = f.house_sqft.value && f.building_footprint_sqft.value ? f.house_sqft.value / f.building_footprint_sqft.value : null;
  const y = d.yard;
  const ysum = ['front_yard_sqft', 'back_yard_sqft', 'side_yard_sqft'].every((k) => typeof f[k].value === 'number') ? f.front_yard_sqft.value + f.back_yard_sqft.value + f.side_yard_sqft.value : null;
  return {
    input, address: p.address, apn: p.apn,
    geo: Object.fromEntries((d.address_providers ?? []).map((x) => [x.id, x.ok ? (x.mismatch ? 'mismatch' : 'match') : 'fail'])),
    situsEq: d.parcel?.situs ? situsMatchesAddress(input, d.parcel.situs) : null,
    polyVsStored: cc?.differencePct ?? null, lot: f.lot_sqft.value, stored: d.parcel?.assessorAreaSqft ?? null,
    nBuild: bld.length, footprint: f.building_footprint_sqft.value,
    layerDiff: bld.length ? Math.max(...bld.map((b) => b.areaDifferencePct ?? 0)) : null,
    house: f.house_sqft.value, ratio, floors: f.floors.value,
    assessorHouse: Number(raw.SQFTmain1) || null, assessorBeds: raw.Bedrooms1 ?? null, assessorBaths: raw.Bathrooms1 ?? null, assessorYear: raw.YearBuilt1 ?? null, extraRecords: extra,
    openSqft: y?.openSqft ?? null, ysum, yardWarn: (y?.warnings ?? []).length, yardWarnings: y?.warnings ?? [], yardOk: ysum !== null,
    frontConf: f.front_yard_sqft.confidence, frontEdge: y?.frontEdge ?? null,
    failed: p.providers.filter((x) => x.status === 'failed'), warnings: p.warnings,
    val: { lot: f.lot_sqft, house: f.house_sqft, beds: f.beds, baths: f.baths, year: f.year_built },
  };
}

async function run(list) {
  const registry = await createDefaultRegistry();
  const { splitYard } = await import('../core/yard.js').catch(() => ({ splitYard: null }));
  const rows = [];
  for (const a of list) {
    const p = await buildPropertyProfile({ address: a }, { registry, fetch: liveFetch, now: NOW, keys: {}, splitYard: splitYard ?? undefined, timeoutMs: 30000 });
    rows.push({ ...check(p, a), profile: p });
  }
  return { rows, hasYard: Boolean(splitYard) };
}

function stats(vals) { const v = vals.filter((x) => x !== null && x !== undefined); return { n: v.length, med: med(v), max: v.length ? Math.max(...v) : null }; }
const pct = (a, b) => (a && b ? (Math.abs(a - b) / b) * 100 : null);

function report({ rows, hasYard }) {
  const n = rows.length, L = [];
  const geoIds = ['la-cams-address', 'census-address'];
  const geoRate = (id) => `${rows.filter((r) => r.geo[id] === 'match').length}/${n} match, ${rows.filter((r) => r.geo[id] === 'mismatch').length} different street/number, ${rows.filter((r) => !r.geo[id] || r.geo[id] === 'fail').length} failed`;
  const s = {
    lot: stats(rows.map((r) => r.polyVsStored)), layer: stats(rows.map((r) => r.layerDiff)),
    house: stats(rows.map((r) => pct(r.val.house.value, r.assessorHouse))), beds: stats(rows.map((r) => pct(r.val.beds.value, Number(r.assessorBeds) || null))),
    baths: stats(rows.map((r) => pct(r.val.baths.value, Number(r.assessorBaths) || null))), year: stats(rows.map((r) => (r.val.year.value && Number(r.assessorYear) ? Math.abs(r.val.year.value - Number(r.assessorYear)) : null))),
    ratio: stats(rows.map((r) => r.ratio)),
  };
  const sf = (x) => `${x.n} | ${fmt(x.med)} | ${fmt(x.max)}`;
  L.push('# Phase 1 accuracy check (keyless providers, Los Angeles)', '', `Run ${NOW} by \`node scripts/phase1-accuracy.mjs\`; ${count} live requests (${Object.entries(byHost).map(([h, c]) => `${h} ${c}`).join(', ')}). Raw numbers: this file only; no owner names or values recorded.`, '',
    '## How the addresses were chosen', '',
    `Rule fixed before looking at results: ZIP list in a set order (${ZIPS.join(', ')}); for each ZIP, the first parcels by OBJECTID with \`UseCode_2='01' AND UseType='Residential'\` (single-family use codes), \`SQFTmain1>0\`, \`SitusCity LIKE 'LOS ANGELES%'\`, a complete situs (house number and street), taking up to the first 4 and keeping the first with exactly ONE LARIAC building record on the parcel (after the provider's own filtering). A ZIP with no qualifying parcel is skipped; the first 10 ZIPs that qualify are used. Bias: parcels with a detached garage or second building are under-represented. The run takes only the 10 addresses as input.`, '',
    ...rows.map((r, i) => `${i + 1}. ${r.input}`), '',
    '## Important: what is and is not measured', '',
    'With no RentCast key, `house_sqft`, `beds`, `baths`, `year_built`, `property_type` and `apn` come FROM the assessor. Their agreement with the assessor is true by construction and is NOT an accuracy measurement. The checks that mean something now are the geocoder, parcel identity, polygon vs stored area, footprint checks and the yard invariant. No ground truth exists in this run for living area, beds, baths or year.', '',
    '## Per-field comparison with the assessor', '',
    '| field | profile source | confidence | RentCast | Google Solar | n | median abs diff | max abs diff |', '|---|---|---|---|---|---|---|---|');
  const conf = (k) => `${[...new Set(rows.map((r) => r.val[k]?.confidence))].join('/')}`;
  const src = (k) => [...new Set(rows.map((r) => (r.val[k].tag === 'unavailable' ? 'unavailable' : r.val[k].source)))].join('; ');
  const NR = 'not run: API key needed';
  L.push(`| lot_sqft (polygon vs assessor stored area, independent, %) | ${src('lot')} | ${conf('lot')} | ${NR} | n/a | ${sf(s.lot)} |`,
    `| house_sqft (%) vs SQFTmain1 | ${src('house')} | ${conf('house')} | ${NR} | n/a | ${sf(s.house)} (by construction) |`,
    `| beds (%) | ${src('beds')} | ${conf('beds')} | ${NR} | n/a | ${sf(s.beds)} (by construction) |`,
    `| baths (%) | ${src('baths')} | ${conf('baths')} | ${NR} | n/a | ${sf(s.baths)} (by construction) |`,
    `| year_built (years) | ${src('year')} | ${conf('year')} | ${NR} | n/a | ${sf(s.year)} (by construction) |`,
    `| roof_sqft | footprint plan area (estimated) | 0.3 | n/a | ${NR} | - | - | - |`, '',
    `Rows with an assessor value: house ${s.house.n}, beds ${s.beds.n}, baths ${s.baths.n}, year ${s.year.n} of ${n}. Rows with extra improvement records (SQFTmain2..5 > 0, summed in the profile): ${rows.filter((r) => r.extraRecords).length}.`, '',
    '## Independent checks', '',
    `- County locator: ${geoRate('la-cams-address')}. Census geocoder: ${geoRate('census-address')} ("different" = house number, direction or street differs from the input).`,
    `- Matched parcel situs equals the input address: ${rows.filter((r) => r.situsEq).length}/${n}.`,
    `- Polygon area vs stored Shape.STArea: n ${s.lot.n}, median ${fmt(s.lot.med)}%, max ${fmt(s.lot.max)}%.`,
    `- Parcels with a building outline: ${rows.filter((r) => r.footprint).length}/${n}. Computed footprint vs the layer's own AREA: n ${s.layer.n}, median ${fmt(s.layer.med)}%, max ${fmt(s.layer.max)}%.`,
    `- Living area / footprint (plausible 0.5-4.5): n ${s.ratio.n}, median ${fmt(s.ratio.med)}, max ${fmt(s.ratio.max)}; outside range: ${rows.filter((r) => r.ratio !== null && (r.ratio < 0.5 || r.ratio > 4.5)).length}. Estimated floors (not checkable here): ${rows.map((r) => r.floors ?? '-').join(', ')}.`,
    hasYard ? `- Yard: split produced for ${rows.filter((r) => r.yardOk).length}/${n}; front+back+side = open area (within 2 sq ft rounding) for ${rows.filter((r) => r.yardOk && r.openSqft !== null && Math.abs(r.ysum - r.openSqft) <= 2).length}/${rows.filter((r) => r.yardOk).length}; results with warnings: ${rows.filter((r) => r.yardWarn).length}. The front edge comes from the Census street-side point, so it is only as good as that point.` : '- Yard: core/yard.js was not present; run without yard values.', '',
    '## Per address', '', '| # | locator/Census | situs = input | poly vs stored % | footprint sq ft | living sq ft | ratio | open / f+b+s | yard warnings |', '|---|---|---|---|---|---|---|---|---|',
    ...rows.map((r, i) => `| ${i + 1} | ${r.geo['la-cams-address'] ?? '-'}/${r.geo['census-address'] ?? '-'} | ${r.situsEq === null ? 'n/a' : r.situsEq ? 'yes' : 'NO'} | ${fmt(r.polyVsStored)} | ${r.footprint ?? 'n/a'} | ${r.house ?? 'n/a'} | ${fmt(r.ratio)} | ${r.openSqft ?? 'n/a'} / ${r.ysum ?? 'n/a'} | ${r.yardWarn} |`), '',
    '## Failures and warnings', '');
  const fails = rows.flatMap((r, i) => [...r.failed.map((x) => `#${i + 1} ${x.id}: ${x.reason}`), ...r.warnings.map((w) => `#${i + 1} warning: ${w}`)]);
  L.push(...(fails.length ? fails.map((x) => `- ${x}`) : ['- none']), '', 'Not run (no key): RentCast records and Google Solar roof area. Their columns above are empty by design; the roof and floors values are footprint-based estimates.');
  return L.join('\n') + '\n';
}

if (process.argv.includes('--select')) await select();
else {
  const list = ADDRESSES;
  if (list.length !== 10) { console.error(`expected 10 addresses in ADDRESSES, got ${list.length}; run with --select first`); process.exit(1); }
  const res = await run(list);
  const md = report(res);
  if (md.split('\n').length > 121) console.error(`warning: report is ${md.split('\n').length} lines (> 120)`);
  writeFileSync(new URL('../docs/phase1-accuracy.md', import.meta.url), md);
  console.log(md); console.error(`requests: ${count}`);
}
