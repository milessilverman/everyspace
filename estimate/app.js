// Everyspace public income estimator. UI and glue only: every number shown comes from the /core modules.
// Nothing the visitor types is stored (no localStorage, cookies, analytics or account); the only network calls are the
// lookups made by core/parcel.js (Nominatim, the county parcel service, Overpass), and only after an explicit submit.
import { resolveAddress, BROWSER_GEOCODERS } from '../core/parcel.js';
import { createProfile, applyOwnerCorrection, summarize as summarizeProfile } from '../core/profile.js';
import { confidenceLabel } from '../core/provenance.js';
import { identifyOpportunities, missingEvidence, defaultResourceCapacity } from '../core/opportunities.js';
import { defaultInputs, withOverrides, estimateOpportunity, summarize, INPUT_KEYS } from '../core/revenue.js';
import { optimize, GOALS } from '../core/optimizer.js';
import { SCENARIO_NAMES } from '../core/data/scenarios.js';
import { ATTRIBUTE_QUESTIONS } from '../core/data/categories.js';

// ---------------------------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nowIso = () => new Date().toISOString();
const safeId = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '_');
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const usd2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const pct = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 });
/** Money from integer cents (formatting only). */
const money = (cents) => usd0.format(cents / 100);
const money2 = (cents) => usd2.format(cents / 100);
const dateText = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
};

// ---------------------------------------------------------------------------------------------------------------
// vocabulary
// ---------------------------------------------------------------------------------------------------------------
const TAG_WORDS = { measured: 'Measured', estimated: 'Estimated', 'owner-confirmed': 'You confirmed', unavailable: 'Not available' };
const TAG_CLASS = { measured: 'ok', estimated: 'warn', 'owner-confirmed': 'accent', unavailable: '' };
const TAG_HELP = {
  measured: 'Read from an official record or computed from a recorded outline.',
  estimated: 'Worked out by a rule of thumb or from map data that may be incomplete. Please check it.',
  'owner-confirmed': 'You entered or confirmed this value, so it overrides automated values.',
  unavailable: 'We could not find this. Fill it in if you know it.',
};
const CONF_WORDS = { low: 'Low', medium: 'Medium', high: 'High' };
const STEP_NAMES = { geocode: 'Address search', parcel: 'Parcel record', buildings: 'Buildings', pool: 'Pool', transit: 'Transit stops' };
const GOAL_LABELS = {
  max_net_income: 'Most net income',
  min_upfront: 'Least money up front',
  min_effort: 'Least effort',
  privacy: 'Most privacy',
  fastest_payback: 'Fastest payback',
};
const GOAL_HELP = {
  max_net_income: 'The combination with the highest yearly net income.',
  min_upfront: 'The highest first-year cash after start-up costs.',
  min_effort: 'Only low-effort uses, then the highest net income.',
  privacy: 'Only uses that keep strangers out of your home, then the highest net income.',
  fastest_payback: 'The shortest time to earn back start-up costs.',
};
const BASIS_WORDS = { existing: 'Ready now', setup: 'Needs small setup', permit: 'Needs a permit first', construction: 'Needs building work first' };
const NOW_BASES = new Set(['existing', 'setup']);
const PROPERTY_TYPES = [
  ['single_family', 'Single-family home'], ['condo', 'Condo or apartment'], ['multi_family', 'Multi-family (2+ units)'],
  ['land', 'Vacant land'], ['commercial', 'Commercial'],
];
const EQUIPMENT = [['atv', 'ATV'], ['snowmobile', 'Snowmobile'], ['kayak', 'Kayak'], ['boat', 'Boat'], ['jet_ski', 'Jet ski'], ['ebike', 'E-bike'], ['camper', 'Camper']];

const ATTR_LABELS = {
  address: 'Address', location: 'Map location', jurisdiction: 'City and state', parcel_id: 'Parcel number (APN)', parcel_boundary: 'Parcel outline',
  lot_area_sqft: 'Lot size', property_type: 'Property type', use_type: 'Assessor use type', year_built: 'Year built', bedrooms: 'Bedrooms',
  living_area_sqft: 'Living area', units: 'Number of units', buildings: 'Buildings on the lot', building_footprint_sqft: 'Building footprint',
  roof_area_sqft: 'Roof area', yard_area_sqft: 'Yard area', driveway_area_sqft: 'Driveway area', parking_spaces: 'Parking spaces',
  garage_present: 'Garage', pool_present: 'Pool', adu_present: 'Guest house or ADU', zoning: 'Zoning', transit_distance_m: 'Distance to transit',
  demand_generators: 'Nearby venues and events', equipment_owned: 'Gear you could rent out',
};
const humanKeys = (t) => t.replace(/\b[a-z]+(?:_[a-z]+)+\b/g, (k) => (ATTR_LABELS[k] ?? k.replace(/_/g, ' ')).toLowerCase());
const attrLabel = (k) => ATTR_LABELS[k] ?? cap(k.replace(/_/g, ' ').replace(/\bavailable$/, 'available'));
const UNIT_OF = { lot_area_sqft: 'sqft', living_area_sqft: 'sqft', building_footprint_sqft: 'sqft', roof_area_sqft: 'sqft', yard_area_sqft: 'sqft', driveway_area_sqft: 'sqft', transit_distance_m: 'm' };
const NUMBER_KEYS = new Set(['lot_area_sqft', 'year_built', 'bedrooms', 'living_area_sqft', 'units', 'building_footprint_sqft', 'roof_area_sqft', 'yard_area_sqft', 'driveway_area_sqft', 'parking_spaces', 'transit_distance_m']);
const TEXT_KEYS = new Set(['address', 'use_type', 'parcel_id', 'zoning']);
const READONLY_KEYS = new Set(['location', 'parcel_boundary', 'buildings', 'demand_generators']);
const kindOf = (key) => {
  if (key === 'property_type') return 'type';
  if (key === 'jurisdiction') return 'jurisdiction';
  if (key === 'equipment_owned') return 'equipment';
  if (READONLY_KEYS.has(key)) return 'readonly';
  if (TEXT_KEYS.has(key)) return 'text';
  if (NUMBER_KEYS.has(key)) return 'number';
  if (/_(present|available)$/.test(key) || key === 'waterfront_access') return 'bool';
  return 'number';
};

const INPUT_LABEL = (key, unit) => ({
  priceCents: `Price per ${unit}`, unitsPerMonth: `${cap(unit)}s rented per month`, capacityUnitsPerMonth: `${cap(unit)}s available per month`,
  bookingsPerMonth: 'Bookings per month', platformFeeRate: 'Listing-site fee', cleaningCentsPerBooking: 'Cleaning cost per booking',
  utilitiesCentsPerMonth: 'Extra utilities per month', insuranceCentsPerMonth: 'Extra insurance per month', taxRate: 'Occupancy or sales tax',
  permitCentsPerYear: 'Permit or registration fee per year', upfrontCents: 'Start-up cost (one time)', seasonality: 'Seasonality',
}[key] ?? key);
const CENTS_KEYS = new Set(['priceCents', 'cleaningCentsPerBooking', 'utilitiesCentsPerMonth', 'insuranceCentsPerMonth', 'permitCentsPerYear', 'upfrontCents']);
const RATE_KEYS = new Set(['platformFeeRate', 'taxRate']);
const NEEDED_KEYS = ['priceCents', 'unitsPerMonth', 'capacityUnitsPerMonth'];
const COST_LINES = [
  ['grossCentsPerMonth', 'Gross income', []],
  ['platformFeeCentsPerMonth', 'Listing-site fees', ['platformFeeRate']],
  ['cleaningCentsPerMonth', 'Cleaning', ['cleaningCentsPerBooking', 'bookingsPerMonth']],
  ['utilitiesCentsPerMonth', 'Extra utilities', ['utilitiesCentsPerMonth']],
  ['insuranceCentsPerMonth', 'Extra insurance', ['insuranceCentsPerMonth']],
  ['taxAndPermitCentsPerMonth', 'Taxes and permits', ['taxRate', 'permitCentsPerYear']],
];

// ---------------------------------------------------------------------------------------------------------------
// state (in memory only)
// ---------------------------------------------------------------------------------------------------------------
const S = {
  busy: false, address: '', phase: 'address', // address | confirm | candidates | results
  result: null, confirmed: false, profile: null, steps: [], manual: false,
  includeInvestments: false, overrides: {}, editAttr: null, editInput: null,
  goal: 'max_net_income', maxUpfront: '', noStrangers: false, onlyKnownRules: false,
  open: new Set(['steplog']), focusId: null, error: '',
  limiter: { lastAt: null }, yardYes: false, selectOnFocus: null, keepStatus: false,
  dirty: false, discardOk: false, // dirty = the owner has typed a correction this session; discardOk = they were warned that searching again drops it
};

const MAX_ADDRESS = 300; // same cap as the input's maxlength; a street address is never longer
const els = { form: $('#address-form'), input: $('#address'), submit: $('#address-submit'), status: $('#status'), lookup: $('#lookup'), results: $('#results') };

function announce(msg, isError = false) {
  els.status.textContent = msg;
  els.status.classList.toggle('err', isError);
}

// ---------------------------------------------------------------------------------------------------------------
// lookups
// ---------------------------------------------------------------------------------------------------------------
async function lookup(extra = {}) {
  if (S.busy) return;
  S.busy = true; els.submit.disabled = true; els.submit.classList.add('busy');
  announce('Looking up your address. This can take a few seconds.');
  renderLookup();
  let res;
  try {
    res = await resolveAddress(S.address, {
      fetch: (url, init) => fetch(url, init), now: nowIso(), geocoders: BROWSER_GEOCODERS, nowMs: () => Date.now(), nominatimLimiter: S.limiter, ...extra,
    });
  } catch (e) {
    res = { ok: false, profile: createProfile(), steps: [{ step: 'geocode', ok: false, reason: e instanceof Error ? e.message : String(e), source: 'lookup' }] };
  }
  S.busy = false; els.submit.disabled = false; els.submit.classList.remove('busy');
  S.result = res; S.steps = res.steps ?? [];
  if (res.needsConfirmation) {
    S.phase = 'confirm'; S.profile = null;
    S.focusId = 'confirm-yes';
    announce(`We found ${res.matchedAddress}. Please confirm it is your property.`);
  } else if (!res.ok && res.candidates?.length) {
    S.phase = 'candidates'; S.profile = null;
    S.focusId = 'cand-none';
    announce('We could not tell which parcel is yours. Please pick it from the list.');
  } else if (res.ok) {
    S.phase = 'results'; S.manual = false; S.profile = res.profile;
    announce('Property found. Review the details and answer a few questions below.');
    S.focusId = 'h-profile';
  } else {
    S.phase = 'results'; S.manual = true; S.profile = res.profile ?? createProfile(); S.open.add('missing-attrs');
    announce('We could not look up your property. Enter the basics below and we can still estimate.');
    S.focusId = 'h-profile';
  }
  S.keepStatus = S.phase === 'results';
  renderAll();
}

function resetSession() {
  S.result = null; S.confirmed = false; S.profile = null; S.steps = []; S.manual = false; S.overrides = {};
  S.editAttr = null; S.editInput = null; S.phase = 'address'; S.error = ''; S.dirty = false; S.discardOk = false;
}

/** Start a new search or manual session only when nothing typed by the owner would be lost silently. */
function canRestart() {
  if (S.busy) { announce('Still looking up your address. Please wait a few seconds.'); return false; }
  if (S.dirty && !S.discardOk) {
    S.discardOk = true;
    announce('You have corrections on this page. Starting again discards them. Press the same button again to start over, or keep working below.', true);
    return false;
  }
  return true;
}

els.form.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const q = els.input.value.trim().slice(0, MAX_ADDRESS);
  if (S.busy) { announce('Still looking up your address. Please wait a few seconds.'); return; }
  if (!q) { announce('Please type an address first.', true); els.input.focus(); return; }
  if (!canRestart()) return;
  resetSession(); S.address = q; renderAll();
  lookup();
});
$('#manual-start').addEventListener('click', () => {
  if (!canRestart()) return;
  resetSession(); S.address = els.input.value.trim(); S.phase = 'results'; S.manual = true; S.profile = createProfile(); S.open.add('missing-attrs');
  announce('Enter the basics about your property below. Nothing is looked up.');
  S.keepStatus = true; S.focusId = 'h-profile';
  renderAll();
});

// ---------------------------------------------------------------------------------------------------------------
// compute (all numbers come from /core)
// ---------------------------------------------------------------------------------------------------------------
function compute() {
  const now = nowIso();
  const profile = S.profile;
  const opps = identifyOpportunities(profile, { now, includeInvestmentIdeas: S.includeInvestments });
  /** @type {Record<string, any>} */
  const estimates = {};
  for (const o of opps) {
    let inputs = defaultInputs(o, profile);
    const ov = S.overrides[o.id];
    if (ov && Object.keys(ov).length) {
      try { inputs = withOverrides(inputs, ov, now); } catch (e) { S.error = e instanceof Error ? e.message : String(e); delete S.overrides[o.id]; }
    }
    estimates[o.id] = estimateOpportunity(o, inputs);
  }
  const constraints = { allowUnknownRegulatory: !S.onlyKnownRules, resourceCapacity: defaultResourceCapacity(profile) };
  if (S.noStrangers) constraints.noStrangersInHome = true;
  const mu = parseFloat(S.maxUpfront);
  if (S.maxUpfront !== '' && Number.isFinite(mu) && mu >= 0) constraints.maxUpfrontCents = Math.round(mu * 100); // dollars typed by the owner -> cents
  const opt = optimize(opps, estimates, { goal: S.goal, scenario: 'baseline', constraints });
  const byId = Object.fromEntries(opps.map((o) => [o.id, o]));
  return { now, opps, estimates, opt, byId };
}

// ---------------------------------------------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------------------------------------------
function renderAll() {
  const active = document.activeElement;
  const wantFocus = S.focusId ?? (active && active.id && (els.results.contains(active) || els.lookup.contains(active)) ? active.id : null);
  S.focusId = null;
  renderLookup();
  renderResults();
  if (wantFocus) {
    const el = document.getElementById(wantFocus);
    if (el) { el.focus({ preventScroll: false }); if (el.select && el.type === 'number' && S.selectOnFocus === wantFocus) el.select(); }
  }
  S.selectOnFocus = null;
}

function dKey(key, label, body, _unused = false, cls = 'panel') {
  const open = S.open.has(key);
  return `<details class="${cls}" data-dk="${esc(key)}"${open ? ' open' : ''}><summary>${label}</summary>${body}</details>`;
}

function renderLookup() {
  const parts = [];
  if (S.busy) parts.push('<div class="card flat"><p>Looking up your address&hellip;</p></div>');
  if (!S.busy && S.phase === 'confirm' && S.result) {
    parts.push(`<section class="card" aria-labelledby="h-confirm"><h2 id="h-confirm">Is this your property?</h2>
      <p class="stack" style="margin-top:8px">We found: <strong id="matched-address">${esc(S.result.matchedAddress)}</strong>. Is this your property?</p>
      <p class="small muted" style="margin-top:6px">You typed: ${esc(S.address)}. The search matched a different street address, so we have not looked up a parcel yet.</p>
      <div class="row" style="margin-top:12px"><button class="btn primary" id="confirm-yes" type="button" data-act="confirm-yes">Yes, that is my property</button>
      <button class="btn" id="confirm-no" type="button" data-act="confirm-no">No, edit the address</button></div></section>`);
  }
  if (!S.busy && S.phase === 'candidates' && S.result) {
    const list = S.result.candidates.map((c, i) => `<li class="row between" style="padding:8px 0;border-top:${i ? '1px solid var(--line)' : '0'}">
        <span>${c.address ? esc(c.address) : 'Parcel with no street address on file'} <span class="muted small">(parcel ${esc(c.apn ?? 'unknown')})</span></span>
        <button class="btn sm" id="pick-${safeId(c.apn ?? i)}" type="button" data-act="pick" data-apn="${esc(c.apn ?? '')}"${c.apn ? '' : ' disabled'}>This is mine</button></li>`).join('');
    parts.push(`<section class="card" aria-labelledby="h-cands"><h2 id="h-cands">Which parcel is yours?</h2>
      <p class="small muted" style="margin-top:6px">We found parcels near that address but none matched it exactly, so we will not guess. Pick yours by its address.</p>
      <ul class="plain" style="list-style:none;padding:0;margin-top:8px">${list}</ul>
      <div style="margin-top:10px"><button class="btn" id="cand-none" type="button" data-act="cand-none">None of these. I will enter the details myself</button></div></section>`);
  }
  if (!S.busy && S.steps.length) {
    const items = S.steps.map((s) => `<li><span class="chip ${s.ok ? 'ok' : 'bad'}">${s.ok ? 'Found' : 'Failed'}</span>
      <strong>${esc(STEP_NAMES[s.step] ?? s.step)}</strong> <span class="muted">from ${esc(s.source)}</span>${s.ok ? '' : ` <span>${esc(s.reason ?? 'no reason given')}</span>`}</li>`).join('');
    const failed = S.steps.filter((s) => !s.ok).length;
    parts.push(dKey('steplog', `What we looked up (${S.steps.length} steps${failed ? `, ${failed} failed` : ''})`, `<ul class="log" id="step-log">${items}</ul>`));
  }
  els.lookup.innerHTML = parts.join('<div style="height:14px"></div>');
}

function renderResults() {
  if (S.phase !== 'results' || !S.profile) { els.results.innerHTML = ''; return; }
  let view;
  try { view = compute(); } catch (e) {
    els.results.innerHTML = `<div class="callout bad" role="alert">Something went wrong while working out the estimates: ${esc(e instanceof Error ? e.message : e)}</div>`;
    return;
  }
  S.view = view;
  const err = S.error ? `<div class="callout bad" role="alert" id="input-error">${esc(S.error)}</div>` : '';
  S.error = '';
  els.results.innerHTML = `<div class="stack">
    <div class="callout warn" id="plan-note"><strong>These are planning estimates, not promises.</strong> Prices and bookings are Everyspace planning defaults unless you enter your own.</div>
    <p class="small muted" id="session-note">Nothing is saved. If you reload or leave this page, everything you entered here is cleared and you start again.</p>
    ${err}
    ${profileHtml(view)}
    ${oppsHtml(view)}
    ${comboHtml(view)}
  </div>`;
  if (S.keepStatus) { S.keepStatus = false; return; } // a lookup just announced its own outcome
  const n = view.opps.length;
  announce(`Estimates updated: ${n} way${n === 1 ? '' : 's'} to earn found.`);
}

// ---- profile -------------------------------------------------------------------------------------------------

function valueText(key, v, unit) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (key === 'property_type') return PROPERTY_TYPES.find(([k]) => k === v)?.[1] ?? cap(String(v).replace(/_/g, ' '));
  if (key === 'location') return `${nf.format(v.lat)}, ${nf.format(v.lng)}`;
  if (key === 'jurisdiction') return [v.city, v.state].filter(Boolean).join(', ') + (v.county ? ` (${v.county})` : '');
  if (key === 'parcel_boundary') return 'Outline on file';
  if (key === 'buildings') return `${v.length} building${v.length === 1 ? '' : 's'} mapped`;
  if (key === 'demand_generators') return `${v.length} nearby`;
  if (key === 'equipment_owned') return v.length ? v.map((x) => EQUIPMENT.find(([k]) => k === x)?.[1] ?? x).join(', ') : 'None';
  if (typeof v === 'number') {
    const u = unit ?? UNIT_OF[key];
    return `${key === 'year_built' ? String(v) : nf.format(v)}${u === 'sqft' ? ' sq ft' : u === 'm' ? ' m' : ''}`;
  }
  return String(v);
}

function badge(tag) {
  return `<span class="chip ${TAG_CLASS[tag] ?? ''}" title="${esc(TAG_HELP[tag] ?? '')}">${esc(TAG_WORDS[tag] ?? tag)}</span>`;
}
const confText = (label) => `${CONF_WORDS[label] ?? label} confidence`;

function editorHtml(key, current) {
  const kind = kindOf(key);
  const id = `ed-${safeId(key)}`;
  const v = current?.value;
  let control = '';
  if (kind === 'number') control = `<input id="${id}" type="number" min="0" step="any" inputmode="decimal" value="${esc(v ?? '')}" aria-label="${esc(attrLabel(key))}">${UNIT_OF[key] === 'sqft' ? '<span class="small muted">sq ft</span>' : UNIT_OF[key] === 'm' ? '<span class="small muted">m</span>' : ''}`;
  else if (kind === 'text') control = `<input id="${id}" type="text" value="${esc(v ?? '')}" aria-label="${esc(attrLabel(key))}">`;
  else if (kind === 'bool') control = `<select id="${id}" aria-label="${esc(attrLabel(key))}"><option value="yes"${v === true ? ' selected' : ''}>Yes</option><option value="no"${v === false ? ' selected' : ''}>No</option></select>`;
  else if (kind === 'type') control = `<select id="${id}" aria-label="Property type"><option value="">Choose&hellip;</option>${PROPERTY_TYPES.map(([k, l]) => `<option value="${k}"${v === k ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
  else if (kind === 'jurisdiction') control = `<input id="${id}-state" type="text" maxlength="2" value="${esc(v?.state ?? '')}" aria-label="State (2 letters)" placeholder="State, e.g. CA" style="width:7em"><input id="${id}-city" type="text" value="${esc(v?.city ?? '')}" aria-label="City" placeholder="City">`;
  else if (kind === 'equipment') control = EQUIPMENT.map(([k, l]) => `<label class="check"><input type="checkbox" id="${id}-${k}" value="${k}"${Array.isArray(v) && v.includes(k) ? ' checked' : ''}>${l}</label>`).join('');
  return `<div class="edit-inline">${control}<button class="btn sm primary" id="save-${safeId(key)}" type="button" data-act="save-attr" data-key="${esc(key)}">Apply</button><button class="btn sm" id="cancel-${safeId(key)}" type="button" data-act="cancel-attr">Cancel</button></div>`;
}

function profileHtml(view) {
  const rows = summarizeProfile(S.profile);
  const have = rows.filter((r) => r.tag !== 'unavailable');
  const none = rows.filter((r) => r.tag === 'unavailable');
  const attr = (k) => S.profile.attributes[k];
  const editBtn = (r, label) => (kindOf(r.key) === 'readonly'
    ? '<span class="small muted">Not editable here</span>'
    : `<button class="btn sm" id="edit-${safeId(r.key)}" type="button" data-act="edit-attr" data-key="${esc(r.key)}" aria-label="${esc(label)} ${esc(attrLabel(r.key))}">${label}</button>`);
  const haveRows = have.map((r) => `<tr data-key="${esc(r.key)}">
      <th scope="row">${esc(attrLabel(r.key))}</th>
      <td data-label="Value">${S.editAttr === r.key ? editorHtml(r.key, attr(r.key)) : `<span class="val">${esc(valueText(r.key, r.value, r.unit))}</span>`}</td>
      <td data-label="Where it came from">${badge(r.tag)}</td>
      <td data-label="Source and date">${esc(r.source)}${r.retrievedAt ? `<div class="tiny muted">${esc(dateText(r.retrievedAt))}</div>` : ''}</td>
      <td data-label="Confidence">${esc(confText(r.confidenceLabel))}</td>
      <td data-label="Change">${editBtn(r, 'Edit')}</td></tr>`).join('');
  const noneRows = none.map((r) => `<tr data-key="${esc(r.key)}">
      <th scope="row">${esc(attrLabel(r.key))}</th>
      <td data-label="Where it came from">${badge('unavailable')}</td>
      <td data-label="Why">${esc(attr(r.key)?.note ?? 'not recorded')}</td>
      <td data-label="Fill in">${S.editAttr === r.key ? editorHtml(r.key, attr(r.key)) : editBtn(r, 'Fill in')}</td></tr>`).join('');

  const profileTable = `<div class="tablewrap"><table class="stack-sm" id="profile-table"><caption class="sr-only">What we know about your property</caption>
    <thead><tr><th scope="col">Attribute</th><th scope="col">Value</th><th scope="col">Where it came from</th><th scope="col">Source and date</th><th scope="col">Confidence</th><th scope="col">Change</th></tr></thead>
    <tbody>${haveRows || '<tr><td colspan="6" class="muted">Nothing was found yet. Fill in the basics.</td></tr>'}</tbody></table></div>`;
  const noneTable = none.length ? dKey('missing-attrs', `Not available (${none.length}). Add what you know`, `<div class="tablewrap"><table class="stack-sm" id="unavailable-table"><caption class="sr-only">Details we could not find</caption>
    <thead><tr><th scope="col">Attribute</th><th scope="col">Where it came from</th><th scope="col">Why</th><th scope="col">Fill in</th></tr></thead><tbody>${noneRows}</tbody></table></div>`) : '';

  return `<section class="card" aria-labelledby="h-profile">
    <div class="section-title"><h2 id="h-profile" tabindex="-1">Your property</h2><span class="small muted">Correct anything that is wrong. Everything below updates at once.</span></div>
    ${S.manual ? manualHtml() : ''}
    ${profileTable}
    <div style="margin-top:12px">${noneTable}</div>
    <div style="margin-top:12px">${questionsHtml()}</div>
  </section>`;
}

function ownerVal(key) { const a = S.profile.attributes[key]; return a && a.tag === 'owner-confirmed' ? a.value : undefined; }
function yesNoSelect(id, key, ariaLabel) {
  const v = ownerVal(key);
  return `<select id="${id}" data-change="bool" data-key="${esc(key)}" aria-label="${esc(ariaLabel)}"><option value="">Not sure</option><option value="yes"${v === true ? ' selected' : ''}>Yes</option><option value="no"${v === false ? ' selected' : ''}>No</option></select>`;
}
function manualHtml() {
  const yard = ownerVal('yard_area_sqft');
  const yardChoice = yard > 0 ? 'yes' : yard === 0 ? 'no' : S.yardYes ? 'yes' : '';
  return `<div class="callout" id="manual-basics" style="margin-bottom:14px"><h3>Tell us the basics</h3>
    <p class="small muted" style="margin:4px 0 10px">We could not look up this property, so the estimate uses what you tell us. Leave anything blank that you do not know.</p>
    <div class="fields">
      <label class="f" for="basic-property_type">Property type<select id="basic-property_type" data-change="type" data-key="property_type"><option value="">Choose&hellip;</option>${PROPERTY_TYPES.map(([k, l]) => `<option value="${k}"${ownerVal('property_type') === k ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="f" for="basic-bedrooms">Bedrooms<input id="basic-bedrooms" type="number" min="0" step="1" inputmode="numeric" data-change="number" data-key="bedrooms" value="${ownerVal('bedrooms') ?? ''}"></label>
      <label class="f" for="basic-lot_area_sqft">Lot size in sq ft (optional)<input id="basic-lot_area_sqft" type="number" min="0" step="any" inputmode="decimal" data-change="number" data-key="lot_area_sqft" value="${ownerVal('lot_area_sqft') ?? ''}"></label>
      <label class="f" for="basic-yard">Do you have a yard?<select id="basic-yard" data-change="yard"><option value="">Not sure</option><option value="yes"${yardChoice === 'yes' ? ' selected' : ''}>Yes</option><option value="no"${yardChoice === 'no' ? ' selected' : ''}>No</option></select></label>
      <label class="f" for="basic-yard_area_sqft">Rough yard size in sq ft (optional)<input id="basic-yard_area_sqft" type="number" min="0" step="any" inputmode="decimal" data-change="number" data-key="yard_area_sqft" value="${yard > 0 ? yard : ''}"></label>
      <label class="f" for="basic-pool_present">Pool?${yesNoSelect('basic-pool_present', 'pool_present', 'Pool')}</label>
      <label class="f" for="basic-parking_spaces">Driveway or parking spaces<input id="basic-parking_spaces" type="number" min="0" step="1" inputmode="numeric" data-change="number" data-key="parking_spaces" value="${ownerVal('parking_spaces') ?? ''}"></label>
      <label class="f" for="basic-garage_present">Garage?${yesNoSelect('basic-garage_present', 'garage_present', 'Garage')}</label>
    </div>
    ${yardChoice === 'yes' && !(yard > 0) ? '<p class="small muted" style="margin-top:8px">Add a rough yard size to see yard ideas.</p>' : ''}
    ${ownerVal('property_type') ? '' : '<p class="small muted" style="margin-top:8px">Choose a property type to see ideas.</p>'}</div>`;
}

function questionList() {
  const items = missingEvidence(S.profile);
  const seen = new Set();
  const basics = S.manual ? new Set(['property_type', 'bedrooms', 'lot_area_sqft', 'yard_area_sqft', 'pool_present', 'parking_spaces', 'garage_present']) : new Set();
  const out = [];
  for (const it of items) {
    const keys = it.needs.filter((k) => !seen.has(k) && !basics.has(k));
    if (!keys.length) continue;
    keys.forEach((k) => seen.add(k));
    const question = keys.length === 1 && keys[0] === 'equipment_owned' ? ATTRIBUTE_QUESTIONS.equipment_owned : it.question;
    out.push({ ...it, keys, question });
  }
  return out;
}

function questionControl(key, qid) {
  const kind = kindOf(key);
  const id = `q-${safeId(key)}`;
  if (kind === 'bool') return `<select id="${id}" data-change="bool" data-key="${esc(key)}" aria-label="${esc(qid)}"><option value="">Not answered</option><option value="yes">Yes</option><option value="no">No</option></select>`;
  if (kind === 'type') return `<select id="${id}" data-change="type" data-key="${esc(key)}" aria-label="${esc(qid)}"><option value="">Choose&hellip;</option>${PROPERTY_TYPES.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>`;
  if (kind === 'equipment') return `<div class="stack" id="${id}">${EQUIPMENT.map(([k, l]) => `<label class="check"><input type="checkbox" id="${id}-${k}" data-change="equip" data-key="${esc(key)}" value="${k}">${l}</label>`).join('')}
    <button class="btn sm" id="${id}-none" type="button" data-act="equip-none">I do not own any of these</button></div>`;
  if (kind === 'text') return `<input id="${id}" type="text" data-change="text" data-key="${esc(key)}" aria-label="${esc(qid)}">`;
  const label = `${attrLabel(key)}${UNIT_OF[key] === 'sqft' ? ' (sq ft)' : ''}`;
  return `<label class="small muted" for="${id}">${esc(label)}</label><input id="${id}" type="number" min="0" step="any" inputmode="decimal" data-change="number" data-key="${esc(key)}" style="max-width:12em">`;
}

function questionsHtml() {
  const qs = questionList();
  if (!qs.length) return '<p class="small muted">We have no more questions. Anything else you know can be added with the Edit buttons above.</p>';
  const body = qs.map((q) => `<div class="q"><div class="qtext">${esc(q.question)}</div>${q.keys.map((k) => questionControl(k, q.question)).join('<div style="height:6px"></div>')}</div>`).join('');
  return dKey('questions', `More things you could rent (${qs.length} question${qs.length === 1 ? '' : 's'})`, `<p class="small muted" style="margin-bottom:6px">Answer any you know. A yes adds that idea to the list below. You can skip the rest.</p>${body}`);
}

// ---- opportunities ---------------------------------------------------------------------------------------------

const RULE_WORDS = {
  feasible: ['ok', 'Allowed under the rules we have on file'],
  restricted: ['warn', 'Allowed with conditions'],
  prohibited: ['bad', 'Not allowed under the rules we have on file'],
  unknown: ['warn', 'Local rules not checked — confirm with your city'],
};
const EFFECT_WORDS = { allow: 'allowed', restrict: 'restricted', prohibit: 'not allowed', require: 'requirement' };

function whyConfidence(o, e) {
  const price = e.inputs.priceCents.tag === 'owner-confirmed', units = e.inputs.unitsPerMonth.tag === 'owner-confirmed';
  const reasons = [];
  if (!price && !units) reasons.push('price and bookings are Everyspace planning defaults, not market data');
  else if (!price) reasons.push('the price is an Everyspace planning default, not market data');
  else if (!units) reasons.push('the bookings are an Everyspace planning default, not market data');
  const f = o.feasibility;
  if (f.status === 'unknown') reasons.push('local rules were not checked');
  else if (f.rules.some((r) => !r.verified)) reasons.push('the local rule text is not yet verified');
  const costMissing = e.missing.filter((k) => !NEEDED_KEYS.includes(k) && k !== 'seasonality');
  if (costMissing.length) reasons.push('some costs are not included');
  for (const n of e.notIncluded ?? []) reasons.push(n.reason);
  const fee = e.inputs.platformFeeRate;
  if (fee.tag === 'estimated') reasons.push('the listing-site fee is an unverified estimate');
  if ((o.unit === 'night' || o.unit === 'hour') && e.inputs.seasonality.tag === 'estimated') reasons.push('busy and quiet months are not set (flat year assumed)');
  if (o.evidenceConfidence < 0.4) reasons.push('the property details behind it are estimated');
  if (!reasons.length) return `${CONF_WORDS[e.confidenceLabel]}: you entered your own price and bookings and the local rules are on file.`;
  return `${CONF_WORDS[e.confidenceLabel]}: ${reasons.join(', and ')}.`;
}

function scenarioTable(o, e) {
  const head = SCENARIO_NAMES.map((s) => `<th scope="col">${cap(s)}</th>`).join('');
  const cells = (period, field, cls = '') => SCENARIO_NAMES.map((s) => {
    const c = e.scenarios[s][field];
    return `<td class="${cls}" data-opp="${esc(o.id)}" data-scenario="${s}" data-period="${period}" data-cents="${c}">${money(c)}</td>`;
  }).join('');
  const breakdownRows = COST_LINES.map(([field, label, keys]) => {
    const allMissing = keys.length && keys.every((k) => e.inputs[k].tag === 'unavailable');
    const cs = SCENARIO_NAMES.map((s) => (allMissing ? '<td class="muted">Not included</td>' : `<td>${field === 'grossCentsPerMonth' ? '' : '−'}${money(e.scenarios[s][field])}</td>`)).join('');
    return `<tr><th scope="row">${label}</th>${cs}</tr>`;
  }).join('');
  const net = SCENARIO_NAMES.map((s) => `<td><strong>${money(e.scenarios[s].noiCentsPerMonth)}</strong></td>`).join('');
  const upfront = SCENARIO_NAMES.map((s) => `<td>${e.inputs.upfrontCents.tag === 'unavailable' ? '<span class="muted">Unknown</span>' : money(e.scenarios[s].upfrontCents)}</td>`).join('');
  const gy = SCENARIO_NAMES.map((s) => `<td>${money(e.scenarios[s].grossCentsPerYear)}</td>`).join('');
  return `<div class="tablewrap"><table class="scen" data-scen-table="${esc(o.id)}"><caption class="sr-only">Estimated net income for ${esc(o.label)}</caption>
    <thead><tr><th scope="col">Net income</th>${head}</tr></thead>
    <tbody><tr><th scope="row">Per month</th>${cells('month', 'noiCentsPerMonth')}</tr>
    <tr><th scope="row">Per year</th>${cells('year', 'noiCentsPerYear', 'big')}</tr></tbody></table></div>
    ${dKey(`bd-${o.id}`, 'Where the money goes (per month)', `<div class="tablewrap"><table class="scen"><caption class="sr-only">Monthly breakdown for ${esc(o.label)}</caption>
      <thead><tr><th scope="col">Line</th>${head}</tr></thead><tbody>${breakdownRows}
      <tr><th scope="row">Net income</th>${net}</tr>
      <tr><th scope="row">Gross income per year</th>${gy}</tr>
      <tr><th scope="row">Start-up cost</th>${upfront}</tr></tbody></table></div>`, false, 'panel')}`;
}

function inputValueText(key, s) {
  if (s.tag === 'unavailable') return 'Not available';
  if (key === 'seasonality') return s.value.every((x) => x === s.value[0]) ? 'Flat across the year (no seasonal data)' : '12 monthly multipliers';
  if (CENTS_KEYS.has(key)) return money2(s.value);
  if (RATE_KEYS.has(key)) return pct.format(s.value);
  return nf.format(s.value);
}
function inputEditor(o, key, idp) {
  const id = `${idp}-${safeId(o.id)}-${key}`;
  const unit = CENTS_KEYS.has(key) ? '$' : RATE_KEYS.has(key) ? '%' : '';
  return `<div class="edit-inline"><label class="sr-only" for="${id}">${esc(INPUT_LABEL(key, o.unit))}</label>${unit === '$' ? '<span aria-hidden="true">$</span>' : ''}<input id="${id}" type="number" min="0" step="any" inputmode="decimal" data-input-edit="${esc(o.id)}|${key}">${unit === '%' ? '<span aria-hidden="true">%</span>' : ''}
    <button class="btn sm primary" id="${idp}-save-${safeId(o.id)}-${key}" type="button" data-act="save-input" data-oid="${esc(o.id)}" data-key="${key}" data-field="${id}">Apply</button>
    ${idp === 'ei' ? `<button class="btn sm" id="ei-cancel-${safeId(o.id)}-${key}" type="button" data-act="cancel-input">Cancel</button>` : ''}</div>`;
}

function assumptionsHtml(o, e) {
  const rows = INPUT_KEYS.map((key) => {
    const s = e.inputs[key];
    const editing = S.editInput && S.editInput.oppId === o.id && S.editInput.key === key;
    const overridden = S.overrides[o.id] && key in S.overrides[o.id];
    const actions = key === 'seasonality' ? '<span class="small muted">Not editable</span>'
      : editing ? inputEditor(o, key, 'ei')
        : `<button class="btn sm" id="ei-edit-${safeId(o.id)}-${key}" type="button" data-act="edit-input" data-oid="${esc(o.id)}" data-key="${key}" aria-label="${s.tag === 'unavailable' ? 'Fill in' : 'Edit'} ${esc(INPUT_LABEL(key, o.unit))}">${s.tag === 'unavailable' ? 'Fill in' : 'Edit'}</button>`
        + (overridden ? ` <button class="btn sm ghost" id="ei-reset-${safeId(o.id)}-${key}" type="button" data-act="reset-input" data-oid="${esc(o.id)}" data-key="${key}" aria-label="Reset ${esc(INPUT_LABEL(key, o.unit))} to the planning default">Reset</button>` : '');
    return `<tr data-input="${key}"><th scope="row">${esc(INPUT_LABEL(key, o.unit))}</th>
      <td data-label="Value" class="num">${esc(inputValueText(key, s))}</td>
      <td data-label="Where it came from">${badge(s.tag)}</td>
      <td data-label="Source">${s.tag === 'unavailable' ? '<span class="muted">—</span>' : esc(s.source)}${s.note ? `<div class="tiny muted">${esc(s.note)}</div>` : ''}</td>
      <td data-label="Confidence">${s.tag === 'unavailable' ? '<span class="muted">—</span>' : esc(confText(confidenceLabel(s.confidence)))}</td>
      <td data-label="Change">${actions}</td></tr>`;
  }).join('');
  const assumptions = e.assumptions.filter((a) => !a.text.startsWith('Not included')).map((a) => `<li>${esc(a.text)} <span class="muted">(${esc(a.source)})</span></li>`).join('');
  const notIncluded = e.missing.filter((k) => !NEEDED_KEYS.includes(k) && k !== 'seasonality');
  const notInc = notIncluded.length ? `<h4 style="margin-top:12px">Not included</h4><ul class="plain">${notIncluded.map((k) => `<li>${esc(INPUT_LABEL(k, o.unit))}: ${esc(String(e.inputs[k].note ?? 'not available').replace(/\.?$/, '.'))}${k === 'upfrontCents' ? '' : ' Not subtracted from the estimate; enter it to include it.'}</li>`).join('')}</ul>` : '';
  return dKey(`as-${o.id}`, 'Assumptions and sources', `<div class="tablewrap"><table class="stack-sm" data-assumptions="${esc(o.id)}"><caption class="sr-only">Inputs for ${esc(o.label)}</caption>
    <thead><tr><th scope="col">Input</th><th scope="col">Value</th><th scope="col">Where it came from</th><th scope="col">Source</th><th scope="col">Confidence</th><th scope="col">Change</th></tr></thead><tbody>${rows}</tbody></table></div>
    ${assumptions ? `<h4 style="margin-top:12px">Assumptions</h4><ul class="plain">${assumptions}</ul>` : ''}${notInc}`);
}

function ruleHtml(o) {
  const f = o.feasibility;
  const [cls, words] = RULE_WORDS[f.status] ?? RULE_WORDS.unknown;
  const unverified = f.status !== 'unknown' && f.rules.some((r) => !r.verified) ? ' (rule text not yet verified)' : '';
  const reqs = f.requirements.length ? `<div class="small" style="margin-top:6px"><strong>What you would need:</strong><ul class="plain">${f.requirements.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></div>` : '';
  const rules = f.rules.filter((r) => r.effect !== 'require').map((r) => `<li>${esc(r.summary)} <span class="muted">(${EFFECT_WORDS[r.effect] ?? r.effect}, ${r.verified ? 'verified' : 'not verified'}${r.sourceUrl && /^https?:\/\//.test(r.sourceUrl) ? `, <a href="${esc(r.sourceUrl)}" rel="noopener noreferrer">source</a>` : ''})</span></li>`).join('');
  return `<span class="chip ${cls}" data-rule-status="${esc(f.status)}">${esc(words)}${unverified}</span>
    ${f.note && f.status !== 'unknown' ? `<p class="small muted" style="margin-top:6px">${esc(f.note)}</p>` : ''}
    ${f.status === 'unknown' ? `<p class="small muted" style="margin-top:6px">${esc(f.note ?? '')}</p>` : ''}
    ${rules ? `<ul class="plain small" style="margin-top:6px">${rules}</ul>` : ''}${reqs}`;
}

function needHtml(o, e) {
  const need = e.missing.filter((k) => NEEDED_KEYS.includes(k));
  const keys = need.length ? need : e.missing.filter((k) => k !== 'seasonality');
  return `<div class="callout warn" data-unavailable="${esc(o.id)}"><strong>No estimate yet.</strong> We need: ${keys.map((k) => esc(INPUT_LABEL(k, o.unit).toLowerCase())).join(', ')}. Enter ${keys.length === 1 ? 'it' : 'them'} to see a range.
    <div class="stack" style="margin-top:8px">${keys.map((k) => `<div><div class="small"><strong>${esc(INPUT_LABEL(k, o.unit))}</strong></div>${inputEditor(o, k, 'need')}</div>`).join('')}</div></div>`;
}

function oppCard(o, e) {
  const notes = o.notes.length ? `<ul class="plain small muted">${o.notes.map((n) => `<li>${esc(humanKeys(n))}</li>`).join('')}</ul>` : '';
  return `<article class="card opp" data-opp-card="${esc(o.id)}" aria-labelledby="oh-${safeId(o.id)}">
    <header><h3 id="oh-${safeId(o.id)}">${esc(o.label)}</h3><span class="chip">${esc(BASIS_WORDS[o.basis] ?? o.basis)}</span></header>
    <div class="chips">${ruleHtml(o)}</div>
    ${e.available ? `${scenarioTable(o, e)}<p class="why small" data-confidence="${esc(e.confidenceLabel)}">${esc(whyConfidence(o, e))}</p>` : `${needHtml(o, e)}`}
    ${notes}
    <div style="margin-top:8px">${assumptionsHtml(o, e)}</div>
  </article>`;
}

function oppsHtml(view) {
  const { opps, estimates } = view;
  const now = opps.filter((o) => NOW_BASES.has(o.basis)), later = opps.filter((o) => !NOW_BASES.has(o.basis));
  const toggle = `<label class="check" for="include-investments"><input type="checkbox" id="include-investments" data-change="investments"${S.includeInvestments ? ' checked' : ''}>Also show ideas that need building work or permits</label>`;
  const group = (title, id, list, hint) => (list.length ? `<h3 class="group-title" id="${id}">${title}</h3>${hint ? `<p class="small muted">${hint}</p>` : ''}${list.map((o) => oppCard(o, estimates[o.id])).join('')}` : '');
  return `<section aria-labelledby="h-opps">
    <div class="section-title"><h2 id="h-opps">Ways your property could earn</h2><span class="small muted">${opps.length} found</span></div>
    ${toggle}
    ${opps.length ? '' : '<div class="callout" style="margin-top:12px">We have not found a way to earn yet. Add or confirm details above, or answer the questions to see more.</div>'}
    ${group('What you have now', 'g-now', now, 'Each range shows conservative, baseline and optimistic planning figures after costs we could count.')}
    ${group('Needs a permit or investment first', 'g-later', later, 'These need a permit, registration or building work before they can start. Start-up costs are unknown unless you enter them.')}
  </section>`;
}

// ---- combination -----------------------------------------------------------------------------------------------

function nameize(text, byId) {
  let t = text.replace(/(\d+) cents/g, (_, n) => money(Number(n)));
  for (const id of Object.keys(byId).sort((a, b) => b.length - a.length)) t = t.replace(new RegExp(`\\b${id}\\b`, 'g'), byId[id].label.toLowerCase());
  return t;
}

function comboHtml(view) {
  const { opt, estimates, byId, opps } = view;
  const goalOpts = GOALS.map((g) => `<option value="${g}"${S.goal === g ? ' selected' : ''}>${GOAL_LABELS[g] ?? g}</option>`).join('');
  const controls = `<div class="fields">
      <label class="f" for="goal">What matters most to you?<select id="goal" data-change="goal">${goalOpts}</select></label>
      <label class="f" for="max-upfront">Most you would spend up front (optional)<input id="max-upfront" type="number" min="0" step="any" inputmode="decimal" data-change="maxUpfront" value="${esc(S.maxUpfront)}" placeholder="No limit"></label>
    </div>
    <p class="small muted" id="goal-help" style="margin-top:6px">${esc(GOAL_HELP[S.goal] ?? '')}</p>
    <div class="stack" style="margin-top:8px">
      <label class="check" for="no-strangers"><input type="checkbox" id="no-strangers" data-change="noStrangers"${S.noStrangers ? ' checked' : ''}>No strangers inside my home</label>
      <label class="check" for="only-known"><input type="checkbox" id="only-known" data-change="onlyKnown"${S.onlyKnownRules ? ' checked' : ''}>Only include uses whose local rules are on file</label>
    </div>
    ${S.onlyKnownRules ? '' : '<div class="callout warn" id="rules-caution" style="margin-top:10px"><strong>Caution:</strong> local rules were not checked for the uses listed here. Confirm each one with your city before you start.</div>'}`;

  const label = (id) => byId[id]?.label ?? id;
  let result;
  if (!opt.selected.length) {
    result = '<div class="callout" id="combo-empty" style="margin-top:14px">No combination fits your choices yet. See below why each option was left out, or loosen a choice above.</div>';
  } else {
    const totals = SCENARIO_NAMES.map((s) => ({ s, t: summarize(estimates, opt.selected, s) }));
    const head = SCENARIO_NAMES.map((s) => `<th scope="col">${cap(s)}</th>`).join('');
    const shown = (f, t) => (f === 'upfrontCents' && t.upfrontUnknownIds.length ? (t[f] === 0 ? 'Unknown' : `${money(t[f])} + unknown`) : money(t[f]));
    const row = (title, f, cls = '', attr = '') => `<tr><th scope="row">${title}</th>${totals.map(({ s, t }) => `<td class="${cls}" ${attr ? `data-scenario="${s}" data-period="${attr}" data-cents="${t[f]}"` : ''}>${shown(f, t)}</td>`).join('')}</tr>`;
    const sel = opt.selected.map((id) => `<li><strong>${esc(label(id))}</strong> <span class="muted small">(${esc(BASIS_WORDS[byId[id]?.basis] ?? '')}, ${money(estimates[id].scenarios.conservative.noiCentsPerYear)} to ${money(estimates[id].scenarios.optimistic.noiCentsPerYear)} a year on its own, baseline ${money(estimates[id].scenarios.baseline.noiCentsPerYear)})</span></li>`).join('');
    // Only compare the two totals when something eligible was left out; the naive sum covers exactly `eligibleIds`.
    const sameSet = opt.eligibleIds.length === opt.selected.length && opt.eligibleIds.every((id) => opt.selected.includes(id));
    result = `<div style="margin-top:14px"><h3>Best combination for you</h3>
      <ul class="plain" id="combo-selected">${sel}</ul>
      <div class="tablewrap" style="margin-top:10px"><table class="scen" id="combo-totals"><caption class="sr-only">Combined net income of the best combination</caption>
        <thead><tr><th scope="col">Combined</th>${head}</tr></thead><tbody>
        ${row('Net income per month', 'noiCentsPerMonth', '', 'month')}${row('Net income per year', 'noiCentsPerYear', 'big', 'year')}
        ${row('Gross income per year', 'grossCentsPerYear')}${row('Start-up cost', 'upfrontCents')}</tbody></table></div>
      ${sameSet ? '' : `<p class="why" id="combo-naive" style="margin-top:10px">Adding everything up would give <strong data-naive-cents="${opt.naiveSumNoiCentsPerYear}">${money(opt.naiveSumNoiCentsPerYear)}</strong>, but some of these cannot run together (they share the same space or resources, or would go over your start-up budget), so the realistic total is <strong data-real-cents="${opt.totals.noiCentsPerYear}">${money(opt.totals.noiCentsPerYear)}</strong>.
        <span class="muted small">Baseline net income per year.</span></p>`}
      <p class="small muted">Confidence: ${esc(CONF_WORDS[totals[1].t.confidenceLabel])}. ${totals[1].t.upfrontUnknownIds.length ? 'Start-up cost is unknown for some of these.' : ''}</p></div>`;
  }
  const rejected = opt.rejected.filter((r) => !opt.investments.includes(r.id));
  const left = rejected.length ? `<div style="margin-top:14px"><h3>Why the other options were left out</h3><div class="tablewrap"><table class="stack-sm" id="combo-rejected"><caption class="sr-only">Options left out and why</caption>
    <thead><tr><th scope="col">Option</th><th scope="col">Reason</th></tr></thead><tbody>${rejected.map((r) => `<tr data-rejected="${esc(r.id)}"><th scope="row">${esc(label(r.id))}</th><td data-label="Reason">${esc(nameize(r.reason, byId))}</td></tr>`).join('')}</tbody></table></div></div>` : '';
  const inv = opt.investments.length ? `<div style="margin-top:14px" id="combo-investments"><h3>Needs a permit or investment (not in the total above)</h3>
    <ul class="plain">${opt.investments.map((id) => {
    const e = estimates[id];
    const range = e?.available ? `could net ${money(e.scenarios.conservative.noiCentsPerYear)} to ${money(e.scenarios.optimistic.noiCentsPerYear)} a year (baseline ${money(e.scenarios.baseline.noiCentsPerYear)}) before start-up costs` : 'no estimate yet';
    return `<li><strong>${esc(label(id))}</strong>: ${range}.</li>`;
  }).join('')}</ul></div>` : '';
  return `<section class="card" aria-labelledby="h-combo"><div class="section-title"><h2 id="h-combo">Best combination</h2><span class="small muted">${opps.length} option${opps.length === 1 ? '' : 's'} considered</span></div>
    <p class="small muted" style="margin-bottom:10px">Uses that need the same space or parking cannot all run at once, so this picks the best set that fits together.</p>
    ${controls}${result}${left}${inv}
    <p style="margin-top:14px"><a href="../host/">Already renting? Manage your spaces in the Host Console</a></p></section>`;
}

// ---------------------------------------------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------------------------------------------
function readEditor(key) {
  const kind = kindOf(key), id = `ed-${safeId(key)}`;
  const el = document.getElementById(id);
  if (kind === 'jurisdiction') {
    const state = (document.getElementById(`${id}-state`)?.value ?? '').trim().toUpperCase();
    const city = (document.getElementById(`${id}-city`)?.value ?? '').trim();
    if (!/^[A-Z]{2}$/.test(state)) return { error: 'Enter the two-letter state, for example CA.' };
    const prev = S.profile.attributes.jurisdiction?.value;
    const keep = prev && prev.state === state && (prev.city ?? '').toLowerCase() === city.toLowerCase() ? { county: prev.county, countyFips: prev.countyFips } : {};
    return { value: { country: 'US', state, ...(city ? { city } : {}), ...Object.fromEntries(Object.entries(keep).filter(([, x]) => x)) } };
  }
  if (kind === 'equipment') return { value: EQUIPMENT.map(([k]) => k).filter((k) => document.getElementById(`${id}-${k}`)?.checked) };
  if (!el) return { error: 'Nothing to save.' };
  const raw = el.value.trim();
  if (kind === 'bool') return { value: raw === 'yes' };
  if (kind === 'type') return raw ? { value: raw } : { error: 'Choose a property type.' };
  if (kind === 'text') return raw ? { value: raw } : { error: 'Type a value first.' };
  return checkNumber(key, raw);
}

const INT_KEYS = new Set(['year_built', 'bedrooms', 'units', 'parking_spaces']);
/** One place that decides whether a number typed for a property attribute is acceptable. */
function checkNumber(key, raw) {
  const n = Number(raw);
  if (String(raw).trim() === '' || !Number.isFinite(n) || n < 0) return { error: 'Enter a number that is zero or more.' };
  if (n > 1e9) return { error: 'That number is too large. Check it and try again.' };
  if (INT_KEYS.has(key) && !Number.isInteger(n)) return { error: 'Enter a whole number.' };
  if (key === 'year_built' && (n < 1600 || n > new Date().getUTCFullYear() + 2)) return { error: `Enter a year between 1600 and ${new Date().getUTCFullYear() + 2}.` };
  if (key === 'units' && n < 1) return { error: 'A property has at least one unit.' };
  return { value: n };
}
/** Show a rejected value next to the control as well as in the status line, so it is seen where the person is looking. */
function inlineError(el, msg) {
  if (!el) return;
  const host = el.closest('.edit-inline') ?? el.parentElement;
  host?.querySelector(':scope > .inline-err')?.remove();
  const p = document.createElement('p');
  p.className = 'inline-err'; p.setAttribute('role', 'alert'); p.textContent = msg;
  host?.append(p);
  el.setAttribute('aria-invalid', 'true');
}

function setOwner(key, value) {
  S.dirty = true;
  S.profile = applyOwnerCorrection(S.profile, key, value, nowIso(), UNIT_OF[key]);
}

function parseInputRaw(key, raw) {
  const n = Number(raw);
  if (String(raw).trim() === '' || !Number.isFinite(n) || n < 0) return { error: 'Enter a number that is zero or more.' };
  if (CENTS_KEYS.has(key)) return { value: Math.round(n * 100) }; // dollars typed by the owner -> integer cents
  if (RATE_KEYS.has(key)) return n > 100 ? { error: 'A percentage cannot be more than 100.' } : { value: n / 100 };
  return { value: n };
}

document.addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  if (act === 'confirm-yes') { S.confirmed = true; lookup({ confirmMatchedAddress: true }); return; }
  if (act === 'confirm-no') { S.phase = 'address'; S.result = null; S.steps = []; announce('Edit the address and search again.'); renderAll(); els.input.focus(); els.input.select(); return; }
  if (act === 'pick') { lookup({ confirmMatchedAddress: S.confirmed, parcelApn: b.dataset.apn }); return; }
  if (act === 'cand-none') {
    S.phase = 'results'; S.manual = true; S.profile = S.result?.profile ?? createProfile(); S.open.add('missing-attrs');
    announce('Enter the basics about your property below.'); S.keepStatus = true; S.focusId = 'h-profile'; renderAll(); return;
  }
  if (act === 'edit-attr') { S.editAttr = b.dataset.key; if (S.profile.attributes[S.editAttr]?.tag === 'unavailable') S.open.add('missing-attrs'); S.focusId = `ed-${safeId(b.dataset.key)}${b.dataset.key === 'jurisdiction' ? '-state' : ''}`; S.selectOnFocus = S.focusId; renderAll(); return; }
  if (act === 'cancel-attr') { const k = S.editAttr; S.editAttr = null; S.focusId = `edit-${safeId(k)}`; renderAll(); return; }
  if (act === 'save-attr') { saveAttr(b.dataset.key); return; }
  if (act === 'equip-none') { setOwner('equipment_owned', []); renderAll(); return; }
  if (act === 'edit-input') { S.editInput = { oppId: b.dataset.oid, key: b.dataset.key }; S.open.add(`as-${b.dataset.oid}`); S.focusId = `ei-${safeId(b.dataset.oid)}-${b.dataset.key}`; S.selectOnFocus = S.focusId; renderAll(); return; }
  if (act === 'cancel-input') { const e = S.editInput; S.editInput = null; if (e) S.focusId = `ei-edit-${safeId(e.oppId)}-${e.key}`; renderAll(); return; }
  if (act === 'save-input') { saveInput(b.dataset.oid, b.dataset.key, b.dataset.field); return; }
  if (act === 'reset-input') {
    const ov = S.overrides[b.dataset.oid]; if (ov) { delete ov[b.dataset.key]; if (!Object.keys(ov).length) delete S.overrides[b.dataset.oid]; }
    S.focusId = `ei-edit-${safeId(b.dataset.oid)}-${b.dataset.key}`; renderAll();
  }
});

function saveAttr(key) {
  const r = readEditor(key);
  if (r.error) { announce(r.error, true); inlineError(document.getElementById(`ed-${safeId(key)}${key === 'jurisdiction' ? '-state' : ''}`), r.error); return; }
  setOwner(key, r.value);
  S.editAttr = null; S.focusId = `edit-${safeId(key)}`;
  renderAll();
}
function saveInput(oppId, key, fieldId) {
  const el = document.getElementById(fieldId);
  const r = parseInputRaw(key, el?.value ?? '');
  if (r.error) { announce(r.error, true); inlineError(el, r.error); el?.focus(); return; }
  S.dirty = true; S.overrides[oppId] = { ...(S.overrides[oppId] ?? {}), [key]: r.value };
  S.editInput = null; S.focusId = `ei-edit-${safeId(oppId)}-${key}`;
  renderAll();
}

document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter') return;
  const t = ev.target;
  if (!(t instanceof HTMLInputElement) || t.type === 'checkbox') return;
  if (t.id.startsWith('ed-')) { ev.preventDefault(); const key = S.editAttr; if (key) saveAttr(key); }
  else if (t.dataset.inputEdit) { ev.preventDefault(); const [oppId, key] = t.dataset.inputEdit.split('|'); saveInput(oppId, key, t.id); }
});

document.addEventListener('change', (ev) => {
  const t = ev.target;
  if (!(t instanceof HTMLElement) || !t.dataset.change) return;
  const kind = t.dataset.change, key = t.dataset.key;
  // let focus settle on the next control (Tab) before the view is rebuilt
  setTimeout(() => {
    if (kind === 'bool') { if (t.value) setOwner(key, t.value === 'yes'); }
    else if (kind === 'type') { if (t.value) setOwner(key, t.value); }
    else if (kind === 'text') { if (t.value.trim()) setOwner(key, t.value.trim()); }
    else if (kind === 'number') {
      const raw = t.value.trim();
      if (raw !== '') {
        const r = checkNumber(key, raw);
        if (r.error) { announce(r.error, true); inlineError(t, r.error); return; } // keep the field as typed, do not rebuild the page over the message
        setOwner(key, r.value);
      }
    } else if (kind === 'yard') {
      S.yardYes = t.value === 'yes';
      if (t.value === 'no') setOwner('yard_area_sqft', 0);
    } else if (kind === 'equip') {
      const checked = [...document.querySelectorAll('[data-change="equip"]')].filter((c) => c.checked).map((c) => c.value);
      setOwner('equipment_owned', checked);
    } else if (kind === 'investments') S.includeInvestments = t.checked;
    else if (kind === 'goal') S.goal = t.value;
    else if (kind === 'maxUpfront') {
      S.maxUpfront = t.value.trim();
      const mu = Number(S.maxUpfront);
      if (S.maxUpfront !== '' && (!Number.isFinite(mu) || mu < 0)) { S.maxUpfront = ''; S.error = 'Enter the most you would spend as a number that is zero or more, or leave it empty for no limit. No limit is applied for now.'; }
    }
    else if (kind === 'noStrangers') S.noStrangers = t.checked;
    else if (kind === 'onlyKnown') S.onlyKnownRules = t.checked;
    renderAll();
  }, 0);
});

// remember which <details> are open across re-renders
document.addEventListener('toggle', (ev) => {
  const d = ev.target;
  if (!(d instanceof HTMLDetailsElement) || !d.dataset.dk) return;
  if (d.open) S.open.add(d.dataset.dk); else S.open.delete(d.dataset.dk);
}, true);

renderAll();

// An address submitted on the homepage arrives in the URL fragment (#address=...) or, without JavaScript there,
// the query (?address=...). Start the lookup once, as if the button had been pressed, then clear it from the address bar.
(function startFromUrl() {
  let addr = '';
  try {
    addr = new URLSearchParams(location.hash.replace(/^#/, '')).get('address') || new URLSearchParams(location.search).get('address') || '';
  } catch { addr = ''; }
  addr = addr.trim().slice(0, MAX_ADDRESS);
  if (!addr) return;
  try { history.replaceState(null, '', location.pathname); } catch { /* ignore */ }
  els.input.value = addr;
  els.form.requestSubmit();
})();
