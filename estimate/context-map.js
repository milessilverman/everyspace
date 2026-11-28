// "Your building from above": a read-only picture for a condo owner. The aerial photo with the shared lot outline and the building
// outlines on it, for context only. No corners to drag, no zones, no driveway, no "Add a building", and no size pushed into the list:
// the grounds, roof and driveway of a building are shared, so none of them is the owner's number.
// It draws into the same mount as lot-map.js; app.js hands the mount to one of the two (see renderAll). Nothing is stored.
import { sourceFromProfile, frameFor, frameProject, photoUrl, NAIP_BACKDROP, syncPicLayout } from './lot-map.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const USGS_FALLBACK = 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer/exportImage';
const CREDIT_FALLBACK = 'Aerial photo: USDA NAIP (US Government imagery)';

const ringsOf = (g) => {
  if (!g) return [];
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  return polys.map((p) => (p[0] ?? []).filter((q) => Array.isArray(q) && Number.isFinite(q[0]) && Number.isFinite(q[1])));
};
const sigOf = (src) => JSON.stringify([src.parcel?.coordinates ?? null, src.buildings.map((b) => b.polygon?.coordinates ?? null)]).length + ':' + JSON.stringify(src.parcel?.coordinates?.[0]?.[0] ?? src.buildings[0]?.polygon?.coordinates?.[0]?.[0] ?? '');

/** @param {{getProfile:()=>any, mount:HTMLElement}} opts */
export function initContextMap({ getProfile, mount }) {
  let shown = false, sig = '', core = null, coreTried = false, raf = 0;
  const el = (tag, attrs = {}, text = null, parent = null) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); if (text !== null) e.textContent = text; parent?.append(e); return e; };
  const svg = (tag, attrs = {}, parent = null) => { const e = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); parent?.append(e); return e; };

  function draw(src) {
    const frameRing = (src.parcel ? ringsOf(src.parcel) : src.buildings.flatMap((b) => ringsOf(b.polygon))).flat();
    if (frameRing.length < 3) { hide(); return; }
    const fr = frameFor(frameRing);
    mount.textContent = ''; mount.className = 'lm lm-context'; mount.setAttribute('role', 'region'); mount.setAttribute('aria-labelledby', 'lmc-title');
    const head = el('div', { class: 'lm-head' }, null, mount);
    const tw = el('div', { class: 'lm-titlewrap' }, null, head);
    el('h3', { id: 'lmc-title', class: 'lm-title' }, 'Your building from above', tw);
    el('p', { class: 'lm-sub small muted' }, 'For context. The lot and the building are shared.', tw);
    const body = el('div', { class: 'lm-body' }, null, mount);
    const stage = el('div', { class: 'lm-stage' }, null, body);
    const cw = stage.clientWidth || mount.clientWidth || 600;
    const ph = typeof matchMedia === 'function' && matchMedia('(max-width: 899px)').matches; // the same pinned strip as the lot picture on a phone
    mount.classList.toggle('lm-phone', ph); mount.classList.toggle('lm-compact', ph);
    const maxH = ph ? Math.max(110, (window.innerHeight || 800) * 0.3 - 46) : Math.min(520, Math.max(280, (window.innerHeight || 800) * 0.6));
    const Wd = Math.max(80, Math.floor(Math.min(cw, maxH * fr.aspect))), Hd = Math.round(Wd / fr.aspect);
    const frame = el('div', { class: 'lm-frame', 'data-bbox': fr.bbox.map((v) => v.toFixed(9)).join(',') }, null, stage);
    frame.style.width = `${Wd}px`; frame.style.height = `${Hd}px`;
    const img = el('img', { class: 'lm-img', alt: '', 'aria-hidden': 'true', decoding: 'async', referrerpolicy: 'no-referrer', draggable: 'false', hidden: '' }, null, frame);
    const s = svg('svg', { class: 'lm-svg', role: 'img', 'aria-label': 'The shared lot and the building outlines on the aerial photo', viewBox: `0 0 ${Wd} ${Hd}`, width: Wd, height: Hd }, frame);
    s.style.pointerEvents = 'none';
    const proj = frameProject(NAIP_BACKDROP.frame, fr.bbox, Wd, Hd);
    const pathOf = (ring) => `${ring.map((p, i) => `${i ? 'L' : 'M'}${proj.toPx(p[0], p[1]).map((n) => n.toFixed(1)).join(' ')}`).join('')}Z`;
    for (const g of [src.parcel, ...src.buildings.map((b) => b.polygon)]) {
      const isLot = g === src.parcel;
      for (const ring of ringsOf(g)) {
        if (ring.length < 3) continue;
        if (isLot) svg('path', { d: pathOf(ring), class: 'lm-casing', fill: 'none' }, s);
        svg('path', { d: pathOf(ring), class: isLot ? 'lm-lot' : 'lm-ctx-bld', fill: 'none' }, s);
      }
    }
    const credit = el('p', { class: 'lm-credit tiny muted', hidden: '' }, '', body);
    const legend = el('ul', { class: 'lm-legend', 'aria-label': 'What the picture shows' }, null, body);
    const li = el('li', { class: 'lm-li', 'data-row': 'shared-lot' }, null, legend);
    li.innerHTML = '<svg class="lm-sw" width="30" height="18" viewBox="0 0 30 18" aria-hidden="true" focusable="false"><rect x="2" y="2" width="26" height="14" rx="2" class="lm-casing" fill="none"/><rect x="2" y="2" width="26" height="14" rx="2" class="lm-lot" fill="none"/></svg><span class="lm-name">Shared lot</span>';
    img.addEventListener('load', () => { img.hidden = false; credit.textContent = `${core?.credit ?? CREDIT_FALLBACK}. It is a soft public photo, so treat it as a guide.`; credit.hidden = false; });
    img.addEventListener('error', () => { img.hidden = true; img.removeAttribute('src'); credit.hidden = true; });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const long = Math.max(480, Math.min(900, Math.round(Math.max(Wd, Hd) * dpr)));
    const url = photoUrl(fr.bbox, long, core?.usgs ?? USGS_FALLBACK);
    frame.dataset.photoUrl = url; img.src = url;
    mount.hidden = false; shown = true;
    syncPicLayout(true);
  }

  function update() {
    let profile = null;
    try { profile = getProfile(); } catch { profile = null; }
    const src = profile ? sourceFromProfile(profile) : null;
    if (!src || (!src.parcel && !src.buildings.length)) { hide(); return; }
    const sg = sigOf(src);
    if (shown && sg === sig) { mount.hidden = false; syncPicLayout(true); return; }
    sig = sg;
    if (!coreTried) {
      coreTried = true;
      import('../core/providers/naip-aerial.js').then((na) => { core = { usgs: na.USGS_EXPORT ?? USGS_FALLBACK, credit: na.ATTRIBUTION_TEXT ?? CREDIT_FALLBACK }; }, () => { core = null; }).finally(() => { sig = ''; update(); });
      return;
    }
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => { try { draw(src); } catch { hide(); } });
  }
  function hide() { cancelAnimationFrame(raf); if (shown) { mount.textContent = ''; mount.hidden = true; mount.className = ''; mount.removeAttribute('role'); mount.removeAttribute('aria-labelledby'); } shown = false; sig = ''; }
  return { update, hide };
}
