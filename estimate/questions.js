// The owner questions as a guided card: one question at a time, moving by itself, with "I don't know" on every question.
// It owns everything about the questions (what is asked and in what order comes from core/opportunities.js ownerQuestions; this file only
// shows it), so estimate/app.js has just a small, marked mount (see "owner questions" in app.js).
//
//  - Answers apply at once through the page's owner-correction path (ctx.apply), so page 2 is always up to date.
//  - "I don't know" is remembered for this visit only (in memory): the question is not asked again, the answer is not stored as a value
//    (never a No, never a number), and an option that waits for it is named on the earnings page with a link back here.
//  - After an answer the next question slides in in place; the page only scrolls when the card is not fully on screen, never with
//    prefers-reduced-motion; focus moves to the new question's heading and a live region says "Question 4 of 7".
//  - The yes/no and choice lines of the property list advance too (factAnswered): the next empty line takes focus.
// Nothing is stored anywhere; the state below is in memory and cleared with the session.
import { ownerQuestions, heldBack, GEAR_CHOICES } from '../core/opportunities.js';

export const REASSURE = 'This is only for your estimate — nothing is saved and nothing gets listed. You can change any answer later.';
const ACKS = ['Got it', 'Good to know', 'Thanks', 'Noted'];
const SUMMARY_LABEL = { equipment_owned: 'Gear', roof_type: 'Roof shape', hoa_allows_rentals: 'HOA allows rentals', assigned_parking_spaces: 'Assigned parking spaces' };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const reduced = () => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
const hasVal = (a) => Boolean(a) && a.tag !== 'unavailable' && a.value !== null && a.value !== undefined;

/**
 * @param {{getProfile:()=>any, apply:(key:string, value:any)=>void, undo:(keys:string[])=>void, parse:(key:string, raw:string)=>({value:any}|{error:string}),
 *   label:(key:string)=>string, goProperty:()=>void, rerender:()=>void}} ctx
 */
export function initQuestions(ctx) {
  const st = { unknown: new Set(), skipped: new Set(), cur: null, advance: null, history: [], showMore: false, gear: false, focus: false, shownKey: null, factFrom: null, err: null, ack: '', acks: 0, announced: null };
  try {
    if (!document.querySelector('link[data-questions-css]')) {
      const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = new URL('./questions.css', import.meta.url).href; l.dataset.questionsCss = '1'; document.head.append(l);
    }
  } catch { /* the card still works without its polish */ }

  const ptypeKnown = (p) => { const a = p?.attributes?.property_type; return hasVal(a) && typeof a.value === 'string' && a.value !== 'unknown'; };
  /** Everything the card shows, from the profile and the in-memory state. Null when the property type is not known yet. */
  function model() {
    const p = ctx.getProfile();
    if (!p || !ptypeKnown(p)) return null;
    const r = ownerQuestions(p, { asked: [...st.unknown] });
    const queue = [...r.ask, ...(st.showMore ? r.lessCommon : [])].sort((a, b) => a.order - b.order);
    const seen = new Set();
    const all = [...r.answered, ...r.unknown, ...queue].filter((q) => !seen.has(q.key) && seen.add(q.key)).sort((a, b) => a.order - b.order);
    let cur = st.cur && all.some((q) => q.key === st.cur) ? st.cur : null;
    if (!cur) {
      const pending = queue.filter((q) => !st.skipped.has(q.key));
      const after = st.advance !== null ? pending.find((q) => q.order > st.advance) : null;
      cur = (after ?? pending[0])?.key ?? null;
      st.cur = cur;
    }
    return { p, r, queue, all, cur, lessCount: st.showMore ? 0 : r.lessCommon.length };
  }
  const defOf = (m, key) => m.all.find((q) => q.key === key);
  const ownerVal = (m, key) => m.r.answered.find((q) => q.key === key)?.value;

  // ---- html ------------------------------------------------------------------------------------------------------------
  const btn = (id, key, v, label, pressed, kbd) => `<button type="button" class="q-btn${v === 'dk' ? ' q-dk' : ''}" id="${id}" data-q="a" data-key="${esc(key)}" data-v="${esc(v)}" aria-pressed="${pressed ? 'true' : 'false'}">${esc(label)}${kbd ? `<kbd aria-hidden="true">${kbd}</kbd>` : ''}</button>`;
  function answersHtml(m, q) {
    const id = `q-${q.key}`;
    const val = ownerVal(m, q.key), dk = st.unknown.has(q.key);
    const sure = (v) => !dk && val === v;
    if (q.type === 'yesno') return `<div class="q-answers" role="group" aria-labelledby="qh">${btn(`${id}-yes`, q.key, 'yes', 'Yes', sure(true), '1')}${btn(`${id}-no`, q.key, 'no', 'No', sure(false), '2')}${btn(`${id}-dk`, q.key, 'dk', "I don't know", dk, '3')}</div>`;
    if (q.type === 'choice') {
      const cs = q.choices ?? [];
      return `<div class="q-answers" role="group" aria-labelledby="qh">${cs.map((c, i) => btn(`${id}-${c.value}`, q.key, c.value, c.label, !dk && val === c.value, String(i + 1))).join('')}${btn(`${id}-dk`, q.key, 'dk', "I don't know", dk || (q.unknownValue && val === q.unknownValue), String(cs.length + 1))}</div>`;
    }
    if (q.type === 'number') {
      const shown = typeof val === 'number' ? nf.format(val) : '';
      const err = st.err && st.err.key === q.key ? `<p class="q-err" id="q-err" role="alert">${esc(st.err.msg)}</p>` : '';
      return `<div class="q-number"><label class="sr-only" for="${id}-n">${esc(q.question)}</label><span class="q-numrow"><input id="${id}-n" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="Add" value="${esc(shown)}"${err ? ' aria-invalid="true" aria-describedby="q-err"' : ''}>${q.unit ? `<span class="q-unit">${esc(q.unit)}</span>` : ''}</span>${err}
        <div class="q-answers q-row2"><button type="button" class="q-btn primary" id="${id}-save" data-q="n" data-key="${esc(q.key)}">Save</button>${btn(`${id}-dk`, q.key, 'dk', "I don't know", dk)}</div></div>`;
    }
    if (q.type === 'gear') {
      const have = Array.isArray(val) ? val : [];
      const open = st.gear || have.length > 0;
      const gate = `<div class="q-answers" role="group" aria-labelledby="qh">${btn(`${id}-yes`, q.key, 'yes', 'Yes', open, '1')}${btn(`${id}-no`, q.key, 'no', 'No', !dk && Array.isArray(val) && val.length === 0 && !st.gear, '2')}${btn(`${id}-dk`, q.key, 'dk', "I don't know", dk, '3')}</div>`;
      if (!open) return gate;
      return `${gate}<fieldset class="q-gear"><legend class="small muted">Tick what you own</legend>${GEAR_CHOICES.map(([k, l]) => `<label class="check"><input type="checkbox" id="${id}-g-${k}" data-q="tick" data-key="${esc(q.key)}" value="${k}"${have.includes(k) ? ' checked' : ''}>${esc(l)}</label>`).join('')}
        <button type="button" class="q-btn primary" id="${id}-done" data-q="gear-done" data-key="${esc(q.key)}">Done</button></fieldset>`;
    }
    return '';
  }
  const shortLabel = (q) => (q.parent ? `${ctx.label(q.parent)} size` : (SUMMARY_LABEL[q.key] ?? ctx.label(q.key)));
  function valueText(q, v) {
    if (st.unknown.has(q.key)) return "I don't know";
    if (q.type === 'yesno') return v === true ? 'Yes' : v === false ? 'No' : '';
    if (q.type === 'number') return typeof v === 'number' ? `${nf.format(v)}${q.unit ? ` ${q.unit}` : ''}` : '';
    if (q.type === 'choice') return v === q.unknownValue ? "I don't know" : (q.choices?.find((c) => c.value === v)?.label ?? String(v));
    if (q.type === 'gear') return Array.isArray(v) && v.length ? v.map((k) => GEAR_CHOICES.find((g) => g[0] === k)?.[1] ?? k).join(', ') : 'None';
    return String(v);
  }
  function summaryHtml(m) {
    const done = m.all.filter((q) => !q.parent && (m.r.answered.some((a) => a.key === q.key) || st.unknown.has(q.key)));
    const sizes = m.all.filter((q) => q.parent && (m.r.answered.some((a) => a.key === q.key) || st.unknown.has(q.key)));
    if (!done.length && !sizes.length) return '';
    const rows = [...done, ...sizes.filter((s) => !done.some((d) => d.key === s.parent))].map((q) => {
      const v = ownerVal(m, q.key);
      const size = done.includes(q) ? sizes.find((s) => s.parent === q.key) : null;
      const extra = size ? ` · about ${valueText(size, ownerVal(m, size.key))}`.replace('about I don\'t know', "size: I don't know") : '';
      const dk = st.unknown.has(q.key);
      const ctl = q.type === 'yesno'
        ? `<span class="q-mini" role="group" aria-label="Change ${esc(shortLabel(q))}">${[['yes', 'Yes', v === true && !dk], ['no', 'No', v === false && !dk], ['dk', "I don't know", dk]].map(([a, l, on]) => `<button type="button" class="q-mini-b" id="qs-${esc(q.key)}-${a}" data-q="a" data-from="summary" data-key="${esc(q.key)}" data-v="${a}" aria-pressed="${on ? 'true' : 'false'}">${l}</button>`).join('')}</span>`
        : `<button type="button" class="q-mini-b" id="qs-${esc(q.key)}-edit" data-q="edit" data-key="${esc(q.key)}" aria-label="Change ${esc(shortLabel(q))}">Change</button>`;
      return `<li data-qrow="${esc(q.key)}"><span class="q-lab">${esc(shortLabel(q))}</span><span class="q-val">${esc(valueText(q, v))}${esc(extra)}</span>${ctl}</li>`;
    }).join('');
    return `<div class="q-sum" id="q-sum"><h4>Your answers</h4><ul>${rows}</ul></div>`;
  }
  function html() {
    const m = model();
    if (!m) return '';
    const total = m.all.length, q = m.cur ? defOf(m, m.cur) : null;
    const pos = q ? m.all.findIndex((x) => x.key === q.key) + 1 : total;
    const enter = q && st.shownKey !== null && st.shownKey !== q.key;
    const dots = total > 1 ? `<span class="q-dots" aria-hidden="true">${m.all.map((x, i) => `<button type="button" tabindex="-1" class="q-dot ${x.key === m.cur ? 'on' : m.r.answered.some((a) => a.key === x.key) ? 'done' : st.unknown.has(x.key) ? 'dk' : ''}" data-q="go" data-key="${esc(x.key)}" aria-label="Question ${i + 1} of ${total}"></button>`).join('')}</span>` : '';
    const progress = q ? `<span class="q-progress" id="q-progress">${pos} of ${total}</span>` : '';
    const ack = st.ack ? `<p class="q-ack" id="q-ack"><span aria-hidden="true">✓</span> ${esc(st.ack)}</p>` : '';
    let body;
    if (q) {
      body = `<div class="q-body${enter ? ' enter' : ''}" id="q-body" data-key="${esc(q.key)}">${ack}<h3 id="qh" tabindex="-1">${esc(q.question)}</h3>${q.parent ? '<p class="q-help small muted">A rough number is fine.</p>' : ''}${answersHtml(m, q)}
        <div class="q-nav"><button type="button" class="q-link" id="q-back" data-q="back"${st.history.length ? '' : ' disabled'}>Back</button>${m.queue.some((x) => x.key === q.key) ? '<button type="button" class="q-link" id="q-skip" data-q="skip">Skip</button>' : ''}</div></div>`;
    } else {
      const skipped = m.queue.filter((x) => st.skipped.has(x.key));
      body = `<div class="q-body q-finish${enter ? ' enter' : ''}" id="q-body" data-key="">${ack}<h3 id="qh" tabindex="-1">${skipped.length ? 'That is all for now.' : "That's everything we need."}</h3>
        <p class="q-help">${skipped.length ? `You skipped ${skipped.length}. You can answer them, or see what it could earn now.` : 'See what it could earn. You can come back and change any answer.'}</p>
        <p><button type="button" class="btn primary lg" id="q-next" data-act="next-earn">See what it could earn</button></p>
        <div class="q-nav">${st.history.length ? '<button type="button" class="q-link" id="q-back" data-q="back">Back</button>' : ''}${skipped.length ? `<button type="button" class="q-link" id="q-skipped" data-q="skipped">Answer the ${skipped.length} you skipped</button>` : ''}${m.lessCount ? `<button type="button" class="q-link" id="q-more" data-q="more">Show a few less common ideas (${m.lessCount})</button>` : ''}</div></div>`;
    }
    return `<section class="qcard" id="qcard" aria-labelledby="qh" data-qtotal="${total}" data-qpos="${q ? pos : ''}"><p class="q-reassure small" id="q-reassure">${esc(REASSURE)}</p>
      <div class="q-head">${progress}${dots}</div>${body}${summaryHtml(m)}<p class="sr-only" id="q-live" role="status" aria-live="polite"></p></section>`;
  }

  // ---- showing the next thing ----------------------------------------------------------------------------------------------
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const top = (document.querySelector('header.top')?.offsetHeight ?? 0) + 6;
    return r.top >= top && r.bottom <= (window.innerHeight || 800) - 6;
  };
  function ensureVisible(el) {
    if (!el || visible(el)) return;
    try { el.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: el.getBoundingClientRect().height > (window.innerHeight || 800) * 0.8 ? 'start' : 'center' }); } catch { /* no scrolling */ }
  }
  /** Called after every render of the page: moves focus and (only when needed) the scroll to what the owner just reached. */
  function afterRender() {
    const card = document.getElementById('qcard');
    if (!card || card.offsetParent === null) { if (!card && !document.getElementById('facts')) { /* nothing drawn yet */ } return; } // the property page is hidden while the earnings page shows
    if (st.factFrom) {
      const key = st.factFrom;
      st.factFrom = null;
      const rows = [...document.querySelectorAll('#facts .fact')];
      const i = rows.findIndex((r) => r.dataset.key === key);
      const next = rows.slice(i + 1).find((r) => r.querySelector('.yn') && !r.querySelector('[aria-pressed="true"]') && r.dataset.state !== 'loading');
      if (next) { next.querySelector('.yn-b')?.focus({ preventScroll: true }); ensureVisible(next); return; }
      const h = card?.querySelector('#qh');
      if (h) { h.focus({ preventScroll: true }); ensureVisible(card.querySelector('#q-body') ?? card); return; }
      const nb = document.getElementById('next-earn'); nb?.focus({ preventScroll: true }); ensureVisible(nb);
      return;
    }
    const key = card.querySelector('#q-body')?.dataset.key ?? '';
    if (st.focus) {
      st.focus = false;
      const h = card.querySelector('#qh');
      const typing = document.activeElement?.closest?.('#qcard input[type="text"]');
      if (h && !typing) h.focus({ preventScroll: true });
      ensureVisible(card.querySelector('#q-body') ?? card);
      if (st.announced !== key + card.dataset.qpos) {
        const n = card.dataset.qpos;
        card.querySelector('#q-live').textContent = key ? `Question ${n} of ${card.dataset.qtotal}` : "That's everything we need.";
        st.announced = key + n;
      }
    }
    st.shownKey = key;
    if (st.ack) { st.ack = ''; setTimeout(() => document.getElementById('q-ack')?.classList.add('gone'), 1500); }
  }

  // ---- doing things ---------------------------------------------------------------------------------------------------------
  const ack = (dk) => { st.ack = dk ? "No problem. You can come back to it." : ACKS[st.acks++ % ACKS.length]; };
  const orderOf = (key) => { const m = model(); return defOf(m, key)?.order ?? null; };
  function leave(key, { push = true } = {}) { if (push && !st.history.includes(key)) st.history.push(key); else if (push) { st.history = st.history.filter((k) => k !== key); st.history.push(key); } }
  function done(key, { fromSummary = false, dk = false } = {}) {
    const o = orderOf(key);
    if (fromSummary) { st.advance = null; st.cur = null; } else { leave(key); st.advance = o; st.cur = null; }
    ack(dk); st.err = null; st.focus = true;
  }
  function answer(key, v, { fromSummary = false } = {}) {
    const m = model(); const q = m && defOf(m, key); if (!q) return;
    if (v === 'dk') {
      const had = ownerVal(m, key) !== undefined;
      if (q.unknownValue) { st.unknown.delete(key); done(key, { fromSummary, dk: true }); ctx.apply(key, q.unknownValue); return; }
      if (had) ctx.undo([key]);
      st.unknown.add(key); st.gear = false;
      done(key, { fromSummary, dk: true }); ctx.rerender(); return;
    }
    st.unknown.delete(key);
    if (q.type === 'gear') {
      if (v === 'yes') { st.gear = true; st.focus = false; st.cur = key; ctx.rerender(); document.getElementById('q-equipment_owned-g-atv')?.focus(); return; }
      st.gear = false; done(key, { fromSummary }); ctx.apply(key, []); return;
    }
    const value = q.type === 'yesno' ? v === 'yes' : v;
    done(key, { fromSummary });
    ctx.apply(key, value);
  }
  function saveNumber(key) {
    const input = document.getElementById(`q-${key}-n`);
    const raw = (input?.value ?? '').trim();
    if (!raw) { st.err = { key, msg: 'Type a number, or choose I don\'t know.' }; ctx.rerender(); return; }
    const r = ctx.parse(key, raw);
    if (r.error) { st.err = { key, msg: r.error }; ctx.rerender(); document.getElementById(`q-${key}-n`)?.focus(); return; }
    st.unknown.delete(key); done(key); ctx.apply(key, r.value);
  }
  function go(key, { fresh = true } = {}) { st.cur = key; st.advance = null; st.gear = false; st.focus = true; st.err = null; if (fresh) st.ack = ''; ctx.rerender(); }

  document.addEventListener('click', (ev) => {
    const b = ev.target.closest?.('[data-q]');
    if (!b || !b.closest('#qcard, #view-earn')) return;
    const a = b.dataset.q, key = b.dataset.key;
    if (a === 'a') answer(key, b.dataset.v, { fromSummary: b.dataset.from === 'summary' });
    else if (a === 'n') saveNumber(key);
    else if (a === 'go' || a === 'edit') go(key);
    else if (a === 'back') { const k = st.history.pop(); if (k) { st.cur = k; st.advance = null; st.focus = true; st.ack = ''; ctx.rerender(); } }
    else if (a === 'skip') { const m = model(); const q = m?.cur; if (q) { st.skipped.add(q); leave(q); st.advance = orderOf(q); st.cur = null; st.focus = true; st.ack = ''; ctx.rerender(); } }
    else if (a === 'skipped') { st.skipped.clear(); st.advance = null; st.cur = null; st.focus = true; ctx.rerender(); }
    else if (a === 'more') { st.showMore = true; st.advance = null; st.cur = null; st.focus = true; ctx.rerender(); }
    else if (a === 'gear-done') { const g = [...document.querySelectorAll('#qcard [data-q="tick"]')].filter((c) => c.checked).map((c) => c.value); st.gear = false; done(key); ctx.apply(key, g); }
    else if (a === 'reopen') { ev.preventDefault(); reopen(key); }
  });
  document.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t instanceof HTMLInputElement && t.dataset.q === 'tick') {
      const g = [...document.querySelectorAll('#qcard [data-q="tick"]')].filter((c) => c.checked).map((c) => c.value);
      st.gear = true; st.cur = t.dataset.key; st.unknown.delete(t.dataset.key);
      ctx.apply(t.dataset.key, g);
      document.getElementById(t.id)?.focus();
    }
  });
  document.addEventListener('keydown', (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLElement) || !t.closest('#qcard')) return;
    if (t instanceof HTMLInputElement && t.type === 'text' && t.id.endsWith('-n')) {
      if (ev.key === 'Enter') { ev.preventDefault(); saveNumber(t.id.replace(/^q-/, '').replace(/-n$/, '')); }
      return;
    }
    if (ev.ctrlKey || ev.metaKey || ev.altKey || t instanceof HTMLInputElement) return;
    const body = document.getElementById('q-body'); const key = body?.dataset.key;
    if (!key) return;
    const m = model(); const q = m && defOf(m, key); if (!q) return;
    const k = ev.key.toLowerCase();
    let v = null;
    if (q.type === 'yesno' || q.type === 'gear') v = k === '1' || k === 'y' ? 'yes' : k === '2' || k === 'n' ? 'no' : k === '3' || k === 'd' ? 'dk' : null;
    else if (q.type === 'choice') { const cs = q.choices ?? []; const i = Number(k) - 1; v = i >= 0 && i < cs.length ? cs[i].value : (k === String(cs.length + 1) || k === 'd') ? 'dk' : null; }
    if (v) { ev.preventDefault(); answer(key, v); }
  });

  /** The property list's yes/no and choice lines: after one is answered, the next empty line takes focus. */
  function factAnswered(key, wasEmpty) { if (wasEmpty) st.factFrom = key; }
  /** Back to a question the owner said "I don't know" to (from the earnings page link). */
  function reopen(key) { st.unknown.delete(key); st.cur = key; st.advance = null; st.focus = true; st.skipped.delete(key); ctx.goProperty(); ctx.rerender(); }
  const unknownKeys = () => [...st.unknown];
  /** Page 2: one plain line per option that waits for an "I don't know" answer, with a link straight back to its question. */
  function heldHtml() {
    const p = ctx.getProfile();
    const lines = p ? heldBack(p, unknownKeys()) : [];
    if (!lines.length) return '';
    return `<section aria-labelledby="h-needs" id="needs-your-answer"><div class="section-title"><h2 id="h-needs">A few ideas need an answer from you</h2></div><ul class="plain q-held">${lines.map((l) => `<li data-held="${esc(l.key)}">${esc(l.line)}. <a href="./" class="back" data-q="reopen" data-key="${esc(l.key)}">Answer it</a></li>`).join('')}</ul></section>`;
  }
  function reset() { st.unknown.clear(); st.skipped.clear(); st.cur = null; st.advance = null; st.history = []; st.showMore = false; st.gear = false; st.focus = false; st.shownKey = null; st.factFrom = null; st.err = null; st.ack = ''; st.announced = null; }
  return { html, afterRender, factAnswered, reopen, heldHtml, unknownKeys, reset };
}
