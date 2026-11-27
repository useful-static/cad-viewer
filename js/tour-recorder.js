// The tour maker: a panel over the view that builds a
// .cadtour.json from the viewer itself. Set the view (orbit, colour parts
// with the swatch, hide, explode, cut, pin notes), then Add step: the step
// takes all of it. Each step gets a title, a text, what happens to the parts
// it is not about, and its timing; steps reorder, re-take the view, and play
// from any of them. Save tour writes the file; Open… reads one back to edit.
//
// The panel owns only the draft; main.js does what touches the viewer:
//   capture(opts)          the view as a step (camera 'exact' | 'frame')
//   captureNote()          what that capture had to change ('' nothing), said with the step
//   preview(tour, from, play)  show the draft from step `from`, playing or paused
//   stopPreview()          leave the preview
//   isPreviewing()         whether the draft is being previewed now
//   modelUrl()             the model's URL, when it was opened from one
//   model()                the model open now: { key, unit, name } (the draft is tied to one), or null
//   orient()               the view's orientation ("+z-y"), written into a new tour
//   save(text, name)       download the file
//   link(text)             a link carrying the tour, copied -> { url, copied } or { error }
//   validate(text)         the tour parser: throws naming what is wrong
//   pictures(tour)         each step as a picture, zipped -> how many
//   video(tour)            the tour played and recorded -> bytes, or why not
//   announce(text)         the live region

import { DEFAULTS, MAX_STEPS, RANGES, STEP_FIELDS, TEXT_MAX, TITLE_MAX, TOUR_VERSION, tourAt, tourSlug } from './tour.js';

// what a step keeps when the draft is written: the parser's own field list
const STEP_KEYS = ['id', ...STEP_FIELDS];

// A draft ({ title, mode, loop, orient, unit, steps }) as the file holds it, the
// panel's own fields left out. Pure: tests/test-tour.mjs reads it back with
// parseTour.
export function draftToTour(draft, modelUrl = null) {
  const out = { cadtour: TOUR_VERSION };
  if (draft.title.trim()) out.title = draft.title.trim();
  if (modelUrl) out.model = modelUrl;
  if (draft.orient) out.orient = draft.orient;
  if (draft.unit && draft.unit !== 'mm') out.unit = draft.unit;
  out.mode = draft.mode;
  if (draft.loop && draft.steps.length > 1) out.loop = true; // (one step does not loop: R86-3)
  // (each field as the file writes it: a section turned off is "off" in a file, { axis: 'off' }
  // once read)
  const asFile = (k, v) => (k === 'section' && v && v.axis === 'off' ? 'off' : v);
  out.steps = draft.steps.map((s) => Object.fromEntries(STEP_KEYS.filter((k) => s[k] !== undefined && s[k] !== '').map((k) => [k, asFile(k, s[k])])));
  return out;
}

// A step from the view as captured and the fields the editor owns, kept from `keep` (the step
// it replaces, or the one before a new step): its id, words, dimming, timing and orbit. The
// view's own fields come from the capture. Pure: tests/test-tour.mjs.
const EDITOR_FIELDS = ['id', 'title', 'text', 'dim', 'transition', 'hold', 'ease', 'orbit'];
// what a new step takes from the one before it (ease was left out: a draft of linear steps got
// an inOut one)
// A step taken in a reading of the file in modelUnit, written at the draft's size, draftUnit (the
// visitor changed "this file is in" since the first step): tourAt's scaling, as the recorder adds it
// (inside the recorder, no test reached it -- r109 C5)
export function stepAtSize(s, modelUnit, draftUnit) {
  return modelUnit && draftUnit && modelUnit !== draftUnit ? tourAt({ unit: modelUnit, steps: [s] }, draftUnit).steps[0] : s;
}
export const CARRIED_FIELDS = ['dim', 'transition', 'hold', 'ease'];
export function stepFromView(captured, keep = {}) {
  const s = { ...captured, title: '', text: '', dim: DEFAULTS.dim, transition: DEFAULTS.transition, hold: DEFAULTS.hold };
  for (const k of EDITOR_FIELDS) if (keep[k] !== undefined && keep[k] !== '') s[k] = keep[k];
  return s;
}

export function createTourRecorder(api) {
  const $ = (id) => document.getElementById(id);
  // orient: an opened tour's orientation, written back as it was (a new tour has none)
  const draft = { title: '', mode: 'static', loop: false, orient: null, steps: [], sel: -1, model: null };
  let busy = false; // a picture or video export under way

  const el = {
    panel: $('touredit'), title: $('tetitle'), mode: $('temode'), loop: $('teloop'), list: $('testeps'),
    add: $('teadd'), open: $('teopen'), file: $('tefile'), close: $('teclose'), play: $('teplay'), save: $('tesave'), link: $('telink'),
    note: $('tenote'), step: $('testep'), pics: $('tepics'), video: $('tevideo'), sTitle: $('tes-title'), sText: $('tes-text'), sCam: $('tes-cam'), sDim: $('tes-dim'),
    sFly: $('tes-transition'), sHold: $('tes-hold'), sOrbit: $('tes-orbit'), sUpdate: $('tes-update'), sGo: $('tes-go'),
  };
  // the inputs take what the parser takes (js/tour.js)
  el.title.maxLength = TITLE_MAX;
  el.sTitle.maxLength = TITLE_MAX;
  el.sText.maxLength = TEXT_MAX;

  // (undo: a press that takes the last deletion back, offered in the note -- R155-2)
  let undo = null;
  const note = (t, back = null) => {
    el.note.textContent = t;
    undo = back;
    if (back) {
      const b = document.createElement('button');
      b.textContent = 'Undo';
      b.onclick = (e) => { e.stopPropagation(); back(); };
      el.note.append(' ', b);
    }
    if (t) api.announce(t);
  };
  // (a note said once, cleared by the next press that says nothing: it stayed through them -- R155-10;
  // a deletion's Undo kept until the next note, a press elsewhere dropped it -- R156-4)
  el.panel.addEventListener('click', (e) => { if (!undo && !el.note.contains(e.target)) note(''); }, true);

  // The model the draft's steps were made on: a tour plays over one model, so with another
  // open, its steps are not added to, shown or saved (saved, they named the other model)
  const model = () => (api.model ? api.model() : null);
  const sameModel = (what) => {
    const m = model();
    // a tour read back while another model was open waits for its own (by URL): opened, the draft
    // is bound to it, its steps at that model's reading (the key it waited on never matched a
    // model's, and it stayed refused after its model was opened)
    if (draft.model && draft.model.url && m && api.modelUrl() === draft.model.url) {
      if (m.unit && draft.unit && m.unit !== draft.unit) draft.steps = tourAt({ unit: draft.unit, steps: draft.steps }, m.unit).steps;
      draft.unit = m.unit || draft.unit;
      draft.model = m;
    }
    // (no model open -- a drawing shown, a load failed -- is not the steps' model either: a save
    // named the drawing as the tour's model)
    if (!draft.steps.length || !draft.model || (m && draft.model.key === m.key)) return true;
    note(`not ${what}: these steps were made on ${draft.model.name}; open it again to go on with them`);
    return false;
  };

  // (a new tour is written with the orientation its steps were taken in: its presets and
  // orbits mean that up on any page, whatever the page's own orientation)
  const toJSON = () => draftToTour({ ...draft, orient: draft.orient || (api.orient ? api.orient() : null) }, draft.modelUrl || api.modelUrl());
  const text = () => JSON.stringify(toJSON(), null, 1);
  // The draft as last saved, linked or read: steps that differ are unsaved, and leaving the page
  // asks first (R171-1)
  let kept = null;
  const unsaved = () => draft.steps.length > 0 && text() !== kept;

  const rows = []; // each step's [name, ↑, ↓, ×], as last drawn
  // an untitled step's stand-in name: step 1 takes the tour's title, as on the card (R89-3)
  const standIn = (i) => (i === 0 && draft.title ? draft.title : `Step ${i + 1}`);
  function renderList() {
    el.list.textContent = '';
    rows.length = 0;
    draft.steps.forEach((s, i) => {
      const li = document.createElement('li');
      li.className = i === draft.sel ? 'sel' : '';
      const name = document.createElement('button');
      name.className = s.title ? 'tename' : 'tename untitled'; // (a stand-in name, dimmed: R74-5)
      name.textContent = s.title || standIn(i);
      name.title = 'Edit this step';
      name.setAttribute('aria-current', String(i === draft.sel));
      name.onclick = () => select(i);
      const up = document.createElement('button');
      up.textContent = '↑'; up.disabled = i === 0; up.setAttribute('aria-label', `Move step ${i + 1} up`);
      up.onclick = () => move(i, -1);
      const down = document.createElement('button');
      down.textContent = '↓'; down.disabled = i === draft.steps.length - 1; down.setAttribute('aria-label', `Move step ${i + 1} down`);
      down.onclick = () => move(i, 1);
      const del = document.createElement('button');
      del.textContent = '×'; del.setAttribute('aria-label', `Delete step ${i + 1}`);
      del.onclick = () => remove(i);
      li.append(name, up, down, del);
      rows.push([name, up, down, del]);
      el.list.append(li);
    });
    el.step.hidden = draft.sel < 0;
    el.play.disabled = el.save.disabled = el.link.disabled = el.pics.disabled = el.video.disabled = !draft.steps.length || busy;
    // (one step does not loop: R84-1, R85-1)
    el.loop.disabled = draft.steps.length < 2;
    el.loop.title = el.loop.disabled ? 'Loop needs two steps or more' : '';
    if (el.loop.parentNode) el.loop.parentNode.title = el.loop.title; // (on the word too: R86-4)
  }

  function fillEditor() {
    const s = draft.steps[draft.sel];
    if (!s) return;
    el.sTitle.value = s.title || '';
    el.sTitle.placeholder = standIn(draft.sel); // (the name the list shows for it)
    el.sText.value = s.text || '';
    el.sCam.value = s.frame ? 'frame' : 'exact';
    el.sDim.value = s.dim || DEFAULTS.dim;
    el.sFly.value = s.transition ?? DEFAULTS.transition;
    el.sHold.value = s.hold ?? DEFAULTS.hold;
    el.sOrbit.value = s.orbit ?? 0;
  }

  function select(i) {
    const inList = el.list.contains && el.list.contains(document.activeElement);
    draft.sel = i;
    renderList();
    fillEditor();
    if (inList && rows[i]) rows[i][0].focus(); // (the rebuilt list keeps the focus on the step: R80-1)
  }

  function move(i, by) {
    const j = i + by;
    if (j < 0 || j >= draft.steps.length) return;
    [draft.steps[i], draft.steps[j]] = [draft.steps[j], draft.steps[i]];
    if (draft.sel === i) draft.sel = j; else if (draft.sel === j) draft.sel = i;
    renderList();
    fillEditor(); // (its stand-in name in the title field: R79-6)
    // (the focus follows the step to its new row, on the same arrow if it can still move: R79-3)
    const b = rows[j];
    (b[by < 0 ? 1 : 2].disabled ? b[by < 0 ? 2 : 1] : b[by < 0 ? 1 : 2]).focus();
    note(`step ${i + 1} moved to ${j + 1}`);
  }

  function remove(i) {
    const [gone] = draft.steps.splice(i, 1), sel = draft.sel;
    // (a step deleted above the one being edited moves it up one: the editor kept its index and
    // held the next step)
    if (i < draft.sel) draft.sel--;
    if (draft.sel >= draft.steps.length) draft.sel = draft.steps.length - 1;
    renderList();
    fillEditor();
    // (the focus to the × of the step now in its place, else the one above, else Add step: R79-3)
    const row = rows[Math.min(i, draft.steps.length - 1)];
    (row ? row[3] : el.add).focus();
    note(`step ${i + 1} deleted`, () => {
      draft.steps.splice(i, 0, gone);
      draft.sel = sel;
      renderList();
      fillEditor();
      rows[i][0].focus();
      note(`step ${i + 1} back`);
    });
  }

  // the view as a step: the camera as chosen, and what the editor holds
  function take(keep = {}) {
    const cam = el.sCam.value === 'frame' ? 'frame' : 'exact';
    const s = api.capture({ camera: cam });
    taken = api.captureNote ? api.captureNote() : '';
    return s ? stepFromView(s, keep) : null;
  }
  let taken = ''; // (the last take's captureNote)
  const andTaken = () => (taken ? `; ${taken}` : '');

  // A step taken now, at this reading's size, written at the draft's (the visitor changed "this file
  // is in" since the first step: js/tour.js tourAt)
  function atDraftSize(s) {
    const m = model();
    return stepAtSize(s, m && m.unit, draft.unit);
  }
  // The draft as it would be with step s at index i (added, or replacing), checked by the parser as
  // a whole -- names, notes and the file's size -- when the step is taken, in the parser's words
  // (which name the step's real number), not at Save after the work is done
  function stepOk(steps, what) {
    try { api.validate(JSON.stringify(draftToTour({ ...draft, steps }, draft.modelUrl || api.modelUrl()))); return true; } catch (e) { note(`${what}: ${e.message}`); return false; }
  }

  el.add.onclick = () => {
    if (!sameModel('added')) return;
    if (draft.steps.length >= MAX_STEPS) { note(`not added: a tour holds at most ${MAX_STEPS} steps`); return; }
    const prev = draft.steps[draft.sel];
    // (the step before's dimming and timing carry over: its words, id and orbit do not)
    let s = take(prev ? Object.fromEntries(CARRIED_FIELDS.map((k) => [k, prev[k]])) : {});
    if (!s) { note('select parts first to frame them, or choose "this exact view"'); return; }
    if (!draft.steps.length) { draft.model = model(); draft.unit = draft.model ? draft.model.unit : null; draft.modelUrl = null; }
    s = atDraftSize(s);
    const next = draft.steps.slice();
    next.splice(draft.sel + 1, 0, s);
    if (!stepOk(next, 'not added')) return;
    draft.steps.splice(draft.sel + 1, 0, s);
    select(draft.sel + 1);
    note(`step ${draft.sel + 1} added: give it a title and a text${andTaken()}`);
    el.sTitle.focus();
  };
  el.sUpdate.onclick = () => {
    if (!sameModel('updated')) return;
    const old = draft.steps[draft.sel];
    if (!old) return;
    let s = take(old);
    if (!s) { note('select parts first to frame them, or choose "this exact view"'); return; }
    s = atDraftSize(s);
    const next = draft.steps.slice();
    next[draft.sel] = s;
    if (!stepOk(next, 'not updated')) return;
    draft.steps[draft.sel] = s;
    renderList();
    note(`step ${draft.sel + 1} now shows the view as it is${andTaken()}`);
  };
  const field = (input, key, conv = (v) => v) => {
    input.addEventListener('input', () => {
      const s = draft.steps[draft.sel];
      if (!s) return;
      const v = conv(input.value);
      if (v === undefined) delete s[key]; else s[key] = v;
      if (key === 'title') renderList();
    });
  };
  const num = (lo, hi) => (v) => { const n = Number(v); return v === '' || !Number.isFinite(n) ? undefined : Math.min(hi, Math.max(lo, n)); };
  field(el.sTitle, 'title');
  field(el.sText, 'text');
  field(el.sFly, 'transition', num(...RANGES.transition));
  field(el.sHold, 'hold', num(...RANGES.hold));
  field(el.sOrbit, 'orbit', (v) => { const n = num(...RANGES.orbit)(v); return n ? n : undefined; });
  // (the inputs' own limits, from the same table: the orbit field stopped at 360 while 3600 was taken)
  for (const [input, k] of [[el.sFly, 'transition'], [el.sHold, 'hold'], [el.sOrbit, 'orbit']]) { input.min = RANGES[k][0]; input.max = RANGES[k][1]; }
  el.sDim.onchange = () => { const s = draft.steps[draft.sel]; if (s) s.dim = el.sDim.value; };
  el.sCam.onchange = () => note('"Update from the view" takes the camera this way');
  el.title.addEventListener('input', () => {
    draft.title = el.title.value;
    // (an untitled step 1 is named by the tour's title: R89-3)
    if (rows[0] && !draft.steps[0]?.title) rows[0][0].textContent = standIn(0);
    if (draft.sel === 0) el.sTitle.placeholder = standIn(0);
  });
  el.mode.onchange = () => { draft.mode = el.mode.value; };
  el.loop.onchange = () => { draft.loop = el.loop.checked; };
  // (a press on the disabled Loop says why, where touch shows no title: R86-4)
  if (el.loop.parentNode && el.loop.parentNode.addEventListener) el.loop.parentNode.addEventListener('pointerdown', () => { if (el.loop.disabled) note('Loop needs two steps or more'); });

  // play the draft: from the step being edited, paused there (Show), or all
  // of it from the start as it will play (Preview)
  function preview(from, play) {
    if (!sameModel('shown')) return;
    let tour;
    try { tour = api.validate(text()); } catch (e) { note(`not ready: ${e.message}`); return; }
    api.preview(tour, from, play);
  }
  // (a phone's maker folds as the step plays: the focus to Preview, not the page -- R129-6)
  el.sGo.onclick = () => { preview(Math.max(0, draft.sel), false); if (!el.sGo.offsetParent) el.play.focus?.(); };
  el.play.onclick = () => preview(0, true);

  // the files' one name: the tour's title, else its own model's (the first: R155-5), for the tour, its
  // pictures and its video alike (R156-9)
  const fileBase = () => {
    const first = (api.model()?.name || '').split(' + ')[0];
    const base = (first || '').replace(/\.gz$/i, '').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '-');
    return draft.title || !base ? tourSlug(draft.title) : base;
  };
  el.save.onclick = () => {
    if (!sameModel('saved')) return;
    let t;
    try { api.validate(text()); t = text(); } catch (e) { note(`not saved: ${e.message}`); return; }
    // (an untitled tour named after its model as other saves keep it, not "tour": R141-6, R142-5)
    // (after its own model only, the one it plays on; an added model is said to be left out -- R155-5)
    const [first, ...added] = (api.model()?.name || '').split(' + ');
    const slug = fileBase();
    api.save(`${t}\n`, `${slug}.cadtour.json`);
    kept = t;
    const also = added.length ? `; it plays on ${first} alone, without ${added.length === 1 ? 'the added model' : `the ${added.length} added models`}` : '';
    // (how to share it said: send the file, or put it online for a link -- the guide's web address
    // left a visitor with no site no way: R163-5)
    note(api.modelUrl() ? `saved ${slug}.cadtour.json${also}: send the file to share it (they open the model, then Make a tour… › Open…), or Copy link` :`saved ${slug}.cadtour.json (the model was opened from this device: the file names no model, so open the model, then the tour)${also}`);
  };
  // Copy link: the tour carried in the link itself, for a visitor with no site (R163-5)
  el.link.onclick = async () => {
    if (!sameModel('linked')) return;
    let t;
    try { api.validate(text()); t = text(); } catch (e) { note(`no link: ${e.message}`); return; }
    if (!JSON.parse(t).model) { note('no link: the model was opened from this device, so a link cannot open it. Save tour and send the file with the model'); return; }
    const r = await api.link(t);
    if (!r.error) kept = t;
    note(r.error ? `no link: ${r.error}` : `${r.copied ? 'link copied' : 'link shown to copy'}: it opens the model and plays the tour`);
  };

  // the tour as files: its pictures (a zip), or a video of it playing
  async function exportAs(kind) {
    if (!sameModel(kind === 'video' ? 'recorded' : 'pictured')) return;
    let tour;
    try { tour = api.validate(text()); } catch (e) { note(`not ready: ${e.message}`); return; }
    const btn = kind === 'video' ? el.video : el.pics, had = document.activeElement === btn;
    busy = true;
    renderList();
    note(kind === 'video' ? `recording the tour: it plays once through (a drag${typeof matchMedia === 'function' && matchMedia('(any-pointer: coarse) and (not (any-pointer: fine))').matches ? '' : ' or a key'} stops it)…` /* (no keys on a touch-only device) */ : 'taking a picture of each step…');
    try {
      const base = fileBase();
      const r = kind === 'video' ? await api.video(tour, base) : await api.pictures(tour, base);
      // (KB under a megabyte, one picture singular: R89-1, R89-2; the file named, as every save: R156-8)
      if (typeof r === 'number' && r > 0) note(kind === 'video' ? `saved ${base}.webm, ${r < 1048576 ? `${Math.max(1, Math.round(r / 1024))} KB` : `${(r / 1048576).toFixed(1)} MB`}` : `saved ${base}-pictures.zip, ${r} picture${r === 1 ? '' : 's'}`);
      else note(`no ${kind === 'video' ? 'video' : 'pictures'}: ${typeof r === 'string' ? r : 'the graphics gave nothing back: try again, or with a smaller window'}`);
    } finally {
      busy = false;
      renderList();
      // (the button disabled itself while busy, dropping the focus out of the maker: back on it -- R76-4)
      const f = document.activeElement;
      if (had && !el.panel.hidden && (!f || f === document.body || !el.panel.contains(f))) btn.focus();
    }
  }
  el.pics.onclick = () => exportAs('pictures');
  el.video.onclick = () => exportAs('video');

  // read a tour back to edit it
  function load(tour) {
    draft.title = tour.title || '';
    draft.mode = tour.mode;
    draft.loop = tour.loop;
    draft.orient = tour.orient || null;
    // (a tour read back is edited over the model open now, at this reading's size: made in another
    // unit, its steps are scaled to it (js/tour.js tourAt, as the player does) -- an inch tour took
    // mm steps, 25.4 times off one another; a model with no reading to choose takes it as made)
    // (and its own model: saved again, it names the model it was made for, not whatever is open;
    // a tour of another model than the one open waits for that one (sameModel), its steps as made,
    // so a step taken here is not added to it -- it was, and saved under the other model's name)
    draft.modelUrl = tour.model || null;
    const open = api.modelUrl();
    const other = draft.modelUrl && open && draft.modelUrl !== open;
    const m = other ? null : model();
    const t = m && m.unit ? tourAt(tour, m.unit) : tour;
    draft.steps = t.steps.map((s) => ({ ...s }));
    draft.unit = (m && m.unit) || tour.unit || null;
    draft.model = other ? { key: null, url: draft.modelUrl, unit: draft.unit, name: draft.modelUrl.split('/').pop() } : model();
    draft.sel = draft.steps.length ? 0 : -1;
    el.title.value = draft.title;
    el.mode.value = draft.mode;
    el.loop.checked = draft.loop;
    renderList();
    fillEditor();
    kept = text(); // (a tour read back is kept already: nothing to warn of on leaving)
  }
  el.open.onclick = () => el.file.click();
  el.file.onchange = async () => {
    const f = el.file.files[0];
    el.file.value = '';
    if (!f) return;
    try { load(api.validate(await f.text())); note(`${f.name}: ${draft.steps.length} ${draft.steps.length === 1 ? 'step' : 'steps'}`); /* (R146-4) */ } catch (e) { note(`${f.name}: ${e.message}`); }
  };

  // at: the step a tour being watched is on, selected (its card and the list agree: R74-4)
  function show(on, tour = null, at = 0) {
    el.panel.hidden = !on;
    if (on) {
      if (tour) load(tour);
      if (tour && at > 0 && at < draft.steps.length) draft.sel = at;
      renderList();
      fillEditor();
      const to = draft.steps.length ? el.list.querySelector('li.sel .tename') || el.list.querySelector('.tename') : el.add;
      // (a phone's list folded while a tour plays: Preview, the row shown -- it stayed on File: R155-11)
      (to.offsetParent ? to : el.play).focus();
    } else api.stopPreview();
  }
  el.close.onclick = () => show(false);
  // (Esc during a preview leaves the preview only, as its card's × says; the next Esc closes the maker:
  // one Esc closed both, the focus to File -- R119-1)
  el.panel.addEventListener('keydown', (e) => {
    // (Ctrl/⌘+Z in the maker, outside a text field: its own deletion back, not a part's colour -- R155-2)
    // (a field that takes typing keeps its own undo; a checkbox or a select does not -- R157-8)
    const t = e.target || {}, typed = t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'file', 'range', 'color'].includes(t.type));
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && !typed) {
      // (nothing of the maker's to undo: the key goes on to the view's Undo -- R156-4)
      if (!undo) return;
      e.preventDefault();
      e.stopPropagation();
      undo();
      return;
    }
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    e.preventDefault();
    e.stopPropagation();
    if (api.isPreviewing?.()) api.stopPreview();
    else show(false);
  });

  renderList();
  return { show, isOpen: () => !el.panel.hidden, toJSON, load, unsaved };
}
