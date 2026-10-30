// The tour maker: a panel over the view that builds a
// .cadtour.json from the viewer itself. Set the view (orbit, colour parts
// with the swatch, hide, explode, cut, pin notes), then Add step: the step
// takes all of it. Each step gets a title, a text, what happens to the parts
// it is not about, and its timing; steps reorder, re-take the view, and play
// from any of them. Save tour writes the file; Open… reads one back to edit.
//
// The panel owns only the draft; main.js does what touches the viewer:
//   capture(opts)          the view as a step (camera 'exact' | 'frame')
//   preview(tour, i)       play the draft from step i (paused)
//   stopPreview()          leave the preview
//   modelUrl()             the model's URL, when it was opened from one
//   save(text, name)       download the file
//   validate(text)         the tour parser: throws naming what is wrong
//   pictures(tour)         each step as a picture, zipped -> how many
//   video(tour)            the tour played and recorded -> bytes, or why not
//   announce(text)         the live region

const STEP_KEYS = ['title', 'text', 'view', 'frame', 'from', 'margin', 'colour', 'dim', 'show', 'hide', 'isolate',
  'explode', 'section', 'style', 'callouts', 'transition', 'hold', 'orbit', 'ease'];

export function createTourRecorder(api) {
  const $ = (id) => document.getElementById(id);
  const draft = { title: '', mode: 'static', loop: false, steps: [], sel: -1 };
  let busy = false; // a picture or video export under way

  const el = {
    panel: $('touredit'), title: $('tetitle'), mode: $('temode'), loop: $('teloop'), list: $('testeps'),
    add: $('teadd'), open: $('teopen'), file: $('tefile'), close: $('teclose'), play: $('teplay'), save: $('tesave'),
    note: $('tenote'), step: $('testep'), pics: $('tepics'), video: $('tevideo'), sTitle: $('tes-title'), sText: $('tes-text'), sCam: $('tes-cam'), sDim: $('tes-dim'),
    sFly: $('tes-transition'), sHold: $('tes-hold'), sOrbit: $('tes-orbit'), sUpdate: $('tes-update'), sGo: $('tes-go'),
  };

  const note = (t) => { el.note.textContent = t; if (t) api.announce(t); };

  // the draft as the file holds it (the panel's own fields left out)
  function toJSON() {
    const out = { cadtour: 1 };
    if (draft.title.trim()) out.title = draft.title.trim();
    const m = api.modelUrl();
    if (m) out.model = m;
    out.mode = draft.mode;
    if (draft.loop) out.loop = true;
    out.steps = draft.steps.map((s) => Object.fromEntries(STEP_KEYS.filter((k) => s[k] !== undefined && s[k] !== '').map((k) => [k, s[k]])));
    return out;
  }
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
    el.sDim.value = s.dim || 'none';
    el.sFly.value = s.transition ?? 1.2;
    el.sHold.value = s.hold ?? 4;
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
    if (draft.sel >= draft.steps.length) draft.sel = draft.steps.length - 1;
    renderList();
    fillEditor();
    note(`step ${i + 1} deleted`);
  }

  // the view as a step: the camera as chosen, and what the editor holds
  function take(keep = {}) {
    const cam = el.sCam.value === 'frame' ? 'frame' : 'exact';
    const s = api.capture({ camera: cam });
    if (!s) return null;
    return { ...s, title: keep.title ?? '', text: keep.text ?? '', dim: keep.dim ?? 'none',
      transition: keep.transition ?? 1.2, hold: keep.hold ?? 4, ...(keep.orbit ? { orbit: keep.orbit } : {}) };
  }

  el.add.onclick = () => {
    const prev = draft.steps[draft.sel];
    const s = take(prev ? { dim: prev.dim, transition: prev.transition, hold: prev.hold } : {});
    if (!s) { note('select parts first to frame them, or choose "this exact view"'); return; }
    draft.steps.splice(draft.sel + 1, 0, s);
    select(draft.sel + 1);
    note(`step ${draft.sel + 1} added: give it a title and a text`);
    el.sTitle.focus();
  };
  el.sUpdate.onclick = () => {
    const old = draft.steps[draft.sel];
    if (!old) return;
    const s = take(old);
    if (!s) { note('select parts first to frame them, or choose "this exact view"'); return; }
    draft.steps[draft.sel] = s;
    renderList();
    note(`step ${draft.sel + 1} now shows the view as it is`);
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
  field(el.sFly, 'transition', num(0, 30));
  field(el.sHold, 'hold', num(0, 600));
  field(el.sOrbit, 'orbit', (v) => { const n = num(-3600, 3600)(v); return n ? n : undefined; });
  el.sDim.onchange = () => { const s = draft.steps[draft.sel]; if (s) s.dim = el.sDim.value; };
  el.sCam.onchange = () => note('"Update from the view" takes the camera this way');
  el.title.addEventListener('input', () => { draft.title = el.title.value; });
  el.mode.onchange = () => { draft.mode = el.mode.value; };
  el.loop.onchange = () => { draft.loop = el.loop.checked; };

  // play the draft: from the step being edited, paused there (Show), or all
  // of it from the start as it will play (Preview)
  function preview(from, play) {
    let tour;
    try { tour = api.validate(text()); } catch (e) { note(`not ready: ${e.message}`); return; }
    api.preview(tour, from, play);
  }
  el.sGo.onclick = () => preview(Math.max(0, draft.sel), false);
  el.play.onclick = () => preview(0, true);

  el.save.onclick = () => {
    let t;
    try { api.validate(text()); t = text(); } catch (e) { note(`not saved: ${e.message}`); return; }
    const slug = (draft.title || 'tour').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'tour';
    api.save(`${t}\n`, `${slug}.cadtour.json`);
    note(api.modelUrl() ? `saved ${slug}.cadtour.json` : `saved ${slug}.cadtour.json (the model was opened from this device: the file names no model, so open the model, then the tour)`);
  };

  // the tour as files: its pictures (a zip), or a video of it playing
  async function exportAs(kind) {
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
    draft.steps = tour.steps.map((s) => ({ ...s }));
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
