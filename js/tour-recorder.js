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
//   modelUrl()             the model's URL, when it was opened from one
//   model()                the model open now: { key, unit, name } (the draft is tied to one), or null
//   orient()               the view's orientation ("+z-y"), written into a new tour
//   save(text, name)       download the file
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
  if (draft.loop) out.loop = true;
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
    add: $('teadd'), open: $('teopen'), file: $('tefile'), close: $('teclose'), play: $('teplay'), save: $('tesave'),
    note: $('tenote'), step: $('testep'), pics: $('tepics'), video: $('tevideo'), sTitle: $('tes-title'), sText: $('tes-text'), sCam: $('tes-cam'), sDim: $('tes-dim'),
    sFly: $('tes-transition'), sHold: $('tes-hold'), sOrbit: $('tes-orbit'), sUpdate: $('tes-update'), sGo: $('tes-go'),
  };
  // the inputs take what the parser takes (js/tour.js)
  el.title.maxLength = TITLE_MAX;
  el.sTitle.maxLength = TITLE_MAX;
  el.sText.maxLength = TEXT_MAX;

  const note = (t) => { el.note.textContent = t; if (t) api.announce(t); };

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

  function renderList() {
    el.list.textContent = '';
    draft.steps.forEach((s, i) => {
      const li = document.createElement('li');
      li.className = i === draft.sel ? 'sel' : '';
      const name = document.createElement('button');
      name.className = 'tename';
      name.textContent = s.title || `Step ${i + 1}`;
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
      del.textContent = '✕'; del.setAttribute('aria-label', `Delete step ${i + 1}`);
      del.onclick = () => remove(i);
      li.append(name, up, down, del);
      el.list.append(li);
    });
    el.step.hidden = draft.sel < 0;
    el.play.disabled = el.save.disabled = el.pics.disabled = el.video.disabled = !draft.steps.length || busy;
  }

  function fillEditor() {
    const s = draft.steps[draft.sel];
    if (!s) return;
    el.sTitle.value = s.title || '';
    el.sText.value = s.text || '';
    el.sCam.value = s.frame ? 'frame' : 'exact';
    el.sDim.value = s.dim || DEFAULTS.dim;
    el.sFly.value = s.transition ?? DEFAULTS.transition;
    el.sHold.value = s.hold ?? DEFAULTS.hold;
    el.sOrbit.value = s.orbit ?? 0;
  }

  function select(i) {
    draft.sel = i;
    renderList();
    fillEditor();
  }

  function move(i, by) {
    const j = i + by;
    if (j < 0 || j >= draft.steps.length) return;
    [draft.steps[i], draft.steps[j]] = [draft.steps[j], draft.steps[i]];
    if (draft.sel === i) draft.sel = j; else if (draft.sel === j) draft.sel = i;
    renderList();
  }

  function remove(i) {
    draft.steps.splice(i, 1);
    // (a step deleted above the one being edited moves it up one: the editor kept its index and
    // held the next step)
    if (i < draft.sel) draft.sel--;
    if (draft.sel >= draft.steps.length) draft.sel = draft.steps.length - 1;
    renderList();
    fillEditor();
    note(`step ${i + 1} deleted`);
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
  el.title.addEventListener('input', () => { draft.title = el.title.value; });
  el.mode.onchange = () => { draft.mode = el.mode.value; };
  el.loop.onchange = () => { draft.loop = el.loop.checked; };

  // play the draft: from the step being edited, paused there (Show), or all
  // of it from the start as it will play (Preview)
  function preview(from, play) {
    if (!sameModel('shown')) return;
    let tour;
    try { tour = api.validate(text()); } catch (e) { note(`not ready: ${e.message}`); return; }
    api.preview(tour, from, play);
  }
  el.sGo.onclick = () => preview(Math.max(0, draft.sel), false);
  el.play.onclick = () => preview(0, true);

  el.save.onclick = () => {
    if (!sameModel('saved')) return;
    let t;
    try { api.validate(text()); t = text(); } catch (e) { note(`not saved: ${e.message}`); return; }
    const slug = tourSlug(draft.title);
    api.save(`${t}\n`, `${slug}.cadtour.json`);
    note(api.modelUrl() ? `saved ${slug}.cadtour.json` : `saved ${slug}.cadtour.json (the model was opened from this device: the file names no model, so open the model, then the tour)`);
  };

  // the tour as files: its pictures (a zip), or a video of it playing
  async function exportAs(kind) {
    if (!sameModel(kind === 'video' ? 'recorded' : 'pictured')) return;
    let tour;
    try { tour = api.validate(text()); } catch (e) { note(`not ready: ${e.message}`); return; }
    busy = true;
    renderList();
    note(kind === 'video' ? 'recording the tour: it plays once through (a drag or a key stops it)…' : 'taking a picture of each step…');
    try {
      const r = kind === 'video' ? await api.video(tour) : await api.pictures(tour);
      if (typeof r === 'number' && r > 0) note(kind === 'video' ? `saved the video, ${(r / 1048576).toFixed(1)} MB` : `saved ${r} pictures`);
      else note(`no ${kind === 'video' ? 'video' : 'pictures'}: ${typeof r === 'string' ? r : 'nothing came back from the GPU'}`);
    } finally {
      busy = false;
      renderList();
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
  }
  el.open.onclick = () => el.file.click();
  el.file.onchange = async () => {
    const f = el.file.files[0];
    el.file.value = '';
    if (!f) return;
    try { load(api.validate(await f.text())); note(`${f.name}: ${draft.steps.length} steps`); } catch (e) { note(`${f.name}: ${e.message}`); }
  };

  function show(on, tour = null) {
    el.panel.hidden = !on;
    if (on) {
      if (tour) load(tour);
      renderList();
      fillEditor();
      (draft.steps.length ? el.list.querySelector('.tename') : el.add).focus();
    } else api.stopPreview();
  }
  el.close.onclick = () => show(false);
  el.panel.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); e.stopPropagation(); show(false); } });

  renderList();
  return { show, isOpen: () => !el.panel.hidden, toJSON, load };
}
