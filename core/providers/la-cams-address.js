// @ts-check
// LA County CAMS locator (keyless address provider): suggest + resolve. Verified live 2026-11-27. The single-line parameter
// is literally named `Single Line Input` (URLSearchParams encodes the spaces). The county returns directionals spelled out
// ("200 North Spring St") and, unlike the Census geocoder, matched 200 N Spring correctly where Census returned 200 S.
// The returned point is address-range based (Addr_type StreetAddress); it is NOT claimed to be a street-side point.

import { callJson, qs, fail, isoNow, num, text } from './util.js';
import { stripUnit } from '../parcel.js';

const BASE = 'https://public.gis.lacounty.gov/public/rest/services/CAMS_Locator/GeocodeServer';
const MIN_SCORE = 85;

/** @type {import('./types.js').AddressProvider} */
export const laCamsAddress = {
  id: 'la-cams-address', label: 'LA County CAMS locator', kind: 'address', needsKey: false, role: 'primary', priority: 10, verified: true,
  coverage: { state: 'CA', countyFips: '06037', county: 'Los Angeles County' }, retentionDays: null,
  licenseNote: 'Public LA County GIS service; no licence text published. Used per request, not stored.',

  async suggest(textIn, deps) {
    const t = typeof textIn === 'string' ? textIn.trim().slice(0, 200) : '';
    if (!t) return fail('empty text', 'bad_query');
    const r = await callJson(`${BASE}/suggest?` + qs({ text: t, maxSuggestions: '5', f: 'json' }), deps);
    if (!r.ok) return fail(r.reason, r.code);
    if (r.json?.error) return fail(`service error: ${r.json.error.message ?? r.json.error.code ?? 'unknown'}`, 'http_error');
    if (!Array.isArray(r.json?.suggestions)) return fail('malformed response', 'malformed_json');
    return { ok: true, suggestions: r.json.suggestions.filter((s) => text(s?.text)).map((s) => ({ text: s.text, ...(text(s.magicKey) ? { magicKey: s.magicKey } : {}) })) };
  },

  async resolve(input, deps) {
    const at = isoNow(deps?.now);
    // a unit ("Apt 4", "#4") is not part of the street address the locator matches: it is left out of the query
    const t = stripUnit(typeof input === 'string' ? input.trim().slice(0, 200) : text(input?.text) ?? '').address;
    if (!t) return fail('empty address', 'bad_query');
    const params = new URLSearchParams({ 'Single Line Input': t, outSR: '4326', outFields: '*', maxLocations: '3', f: 'json' });
    if (typeof input === 'object' && input && text(input.magicKey)) params.set('magicKey', /** @type {string} */ (input.magicKey));
    const r = await callJson(`${BASE}/findAddressCandidates?` + qs(Object.fromEntries(params)), deps);
    if (!r.ok) return fail(r.reason, r.code);
    if (r.json?.error) return fail(`service error: ${r.json.error.message ?? r.json.error.code ?? 'unknown'}`, 'http_error');
    if (!Array.isArray(r.json?.candidates)) return fail('malformed response', 'malformed_json');
    const cands = r.json.candidates.filter((c) => num(c?.location?.x) !== null && num(c?.location?.y) !== null && num(c?.score) !== null).sort((a, b) => b.score - a.score);
    const top = cands[0];
    if (!top || top.score < MIN_SCORE) return fail(top ? `best match scored ${top.score} (< ${MIN_SCORE})` : 'no address match', 'no_match');
    const a = top.attributes ?? {};
    const second = cands[1];
    const notes = [];
    if (second && top.score - second.score < 5 && text(second.address) !== text(top.address)) notes.push(`another candidate scored almost as high: ${second.address}`);
    return {
      ok: true, address: text(top.address) ?? text(a.Match_addr) ?? t, lat: top.location.y, lng: top.location.x, retrievedAt: at,
      confidence: top.score >= 95 ? 0.85 : 0.7, ...(notes.length ? { note: notes.join('; ') } : {}),
      components: { houseNumber: text(a.StAddr)?.split(' ')[0] ?? null, direction: text(a.PreDir), street: text(a.StreetName), suffix: text(a.SufType), city: text(a.City), state: text(a.State), zip: text(a.ZIP) },
      score: top.score, addrType: text(a.Addr_type),
    };
  },
};
