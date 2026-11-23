// check.html: a model list's health (js/list-check.js), for its owner.
// ?list=<url> (repeatable, as the viewer's) fills the box and runs the check;
// the File menu's "Check this list…" opens it so. Each model's checks fill
// the table as they finish; the summary line says the verdict.

import { checkLists, insertInOrder, summary } from './list-check.js';

const $ = (id) => document.getElementById(id);
// (a shape per state, not a colour alone, and its word for a title: R99-3)
const MARK = { ok: '✓', warn: '▲', bad: '✗' };
const WORD = { ok: 'ok', warn: 'look at', bad: 'failed' };

// A URL in parts that each stay whole, a break offered only after each "/": a <wbr> alone still let
// it split at a hyphen inside a part ("…/cad-" / "viewer/") -- R102-3, R103-3
function urlParts(text) {
  if (!text.includes('/')) return [text];
  return text.split(/(?<=\/)/).flatMap((part, n) => {
    const s = document.createElement('span');
    s.className = 'up';
    s.textContent = part;
    return n ? [document.createElement('wbr'), s] : [s];
  });
}

function row(entry) {
  const frag = document.createDocumentFragment();
  entry.checks.forEach((c, k) => {
    const tr = document.createElement('tr');
    // (a model's later checks joined to its first, not blocks of their own with no name: R100-3)
    tr.className = k ? `${c.level} more` : c.level;
    const cells = [MARK[c.level] || '', k === 0 ? entry.name : '', c.what, c.detail, c.url];
    cells.forEach((text, j) => {
      const td = document.createElement('td');
      if (j === 0) {
        td.className = 'mark';
        // (the glyph seen, its word read: the reader said "check mark" and a title the word again --
        // R100-8, R101-6)
        const g = document.createElement('span');
        g.setAttribute('aria-hidden', 'true');
        g.textContent = text;
        const w = document.createElement('span');
        w.className = 'sr';
        w.textContent = WORD[c.level] || '';
        td.append(g, w);
      } else td.textContent = text;
      if (j === 1) {
        td.className = 'model';
        if (k === 0 && entry.id) {
          const s = document.createElement('small');
          s.textContent = `id ${entry.id}`;
          td.append(s);
        }
      }
      if (j === 3) td.className = 'res';
      if (j === 4) {
        td.className = 'url';
        // (a break offered after each "/", so a URL wraps between its parts, not inside a word: R102-3)
        if (text.includes('/')) { td.textContent = ''; td.append(...urlParts(text)); }
      }
      tr.append(td);
    });
    frag.append(tr);
  });
  return frag;
}

async function run(urls) {
  // (the header's link opens the viewer with the list being checked, from the start: R100-12, R101-9)
  const home = document.querySelector?.('header a');
  if (home) home.href = `./?${urls.map((l) => `list=${encodeURIComponent(l)}`).join('&')}`;
  const body = $('results').tBodies[0];
  body.textContent = '';
  $('listnotes').textContent = '';
  $('results').hidden = true;
  $('go').disabled = true;
  $('summary').textContent = 'reading the list…';
  try {
    const result = await checkLists(urls, location.href, {
      onEntry: (entry, i, n) => {
        $('results').hidden = false;
        insertInOrder(body, row(entry), i); // (in the list's order, wherever its check finished)
        $('summary').textContent = `checked ${body.querySelectorAll('td.model:not(:empty)').length} of ${n} models…`;
      },
    });
    for (const l of result.lists) {
      const p = document.createElement('p');
      p.className = l.error ? 'bad' : 'ok'; // (its colour as the table's: R100-2)
      // (the symbol seen, not read aloud before the words, as the table's marks: R102-2)
      const g = document.createElement('span');
      g.setAttribute('aria-hidden', 'true');
      g.textContent = `${l.error ? MARK.bad : MARK.ok} `;
      // (a list read with no models says so, beside others or alone -- R105-3, R106-5)
      const none = l.models === 0 || (l.models == null && !result.entries.length);
      // (a model an earlier list already named is checked there, as the viewer keeps it there: said -- R107-4)
      const rep = l.repeats ? `: ${l.repeats === l.models ? (l.models === 1 ? 'its model is' : l.models === 2 ? 'both of its models are' : `all ${l.models} of its models are`) : `${l.repeats} of its ${l.models} models ${l.repeats === 1 ? 'is' : 'are'}`} already in an earlier list, checked there` : '';
      p.append(g, 'the list ', ...urlParts(l.url), l.error ? ` was not read: ${l.error}` : none ? ' was read: it has no models' : ` was read${rep}`);
      $('listnotes').append(p);
    }
    $('summary').textContent = summary(result);
  } catch (e) {
    $('summary').textContent = `the check stopped: ${e.message || e}`;
  } finally {
    $('go').disabled = false;
    // (the button disabled itself while it ran, dropping the focus to the page: back on it -- R99-4)
    const f = document.activeElement;
    // (without scrolling a reader of the results back up to it: R100-1)
    if (!f || f === document.body) $('go').focus?.({ preventScroll: true });
  }
}

const given = new URLSearchParams(location.search).getAll('list');
$('lists').value = given.join('\n');
// (the field back at each line's start once left: scrolled to its end it showed only the tails, a
// shorter second URL out of view -- R103-1)
$('lists').addEventListener?.('blur', () => { $('lists').scrollLeft = 0; });
// A left press in the box's padding as a press in the field at the nearest point: focus without a
// scroll, the caret where pressed, a drag selecting from there (R104-2; it put the caret back where it
// last was and a drag selected nothing -- R105-1, R105-2). The field is monospace, so a point's line
// and column come from its measured line pitch and one character's width, within the box the text
// shows in (not under its scrollbars). A drag past the edge goes on and scrolls the field; Shift extends
// the selection, a double press takes the word, a triple the line (R106-1, R106-3, R106-4).
function charWidth(ta) {
  const cs = getComputedStyle(ta), ctx = document.createElement('canvas').getContext('2d');
  ctx.font = `${cs.fontSize} ${cs.fontFamily}`;
  return ctx.measureText('0').width || 8;
}
function caretAt(ta, x, y, free = false) {
  const r = ta.getBoundingClientRect(), cw = charWidth(ta);
  const lines = ta.value.split('\n');
  const lh = ta.scrollHeight / lines.length || parseFloat(getComputedStyle(ta).lineHeight) || 16;
  const px = free ? x - r.left : Math.min(Math.max(x - r.left, 0), ta.clientWidth - 1);
  const cy = (free ? y - r.top : Math.min(Math.max(y - r.top, 0), ta.clientHeight - 1)) + ta.scrollTop;
  const line = Math.min(lines.length - 1, Math.max(0, Math.floor(cy / lh)));
  const col = Math.min(lines[line].length, Math.max(0, Math.round((px + ta.scrollLeft) / cw)));
  return lines.slice(0, line).reduce((n, l) => n + l.length + 1, 0) + col;
}
function showCaret(ta, at) {
  const cw = charWidth(ta), col = at - ta.value.lastIndexOf('\n', at - 1) - 1, x = col * cw;
  if (x < ta.scrollLeft) ta.scrollLeft = x;
  else if (x > ta.scrollLeft + ta.clientWidth - cw) ta.scrollLeft = x - ta.clientWidth + cw;
}
$('lists').parentElement?.addEventListener('mousedown', (e) => {
  const ta = $('lists');
  if (e.target === ta || e.button !== 0) return;
  e.preventDefault();
  const at = caretAt(ta, e.clientX, e.clientY);
  const focused = document.activeElement === ta;
  ta.focus({ preventScroll: true });
  const v = ta.value;
  if (e.detail === 2 || e.detail >= 3) {
    const word = e.detail === 2, stop = word ? /[\s/.:?&=#]/ : /\n/;
    let a = at, b = at;
    while (a > 0 && !stop.test(v[a - 1])) a--;
    while (b < v.length && !stop.test(v[b])) b++;
    ta.setSelectionRange(a, b);
    return;
  }
  const anchor = e.shiftKey && focused ? (ta.selectionDirection === 'backward' ? ta.selectionEnd : ta.selectionStart) : at;
  // (the press itself leaves the field where it is, as a press in the text does; a drag follows its end)
  const pick = (to, follow) => { ta.setSelectionRange(Math.min(anchor, to), Math.max(anchor, to), to < anchor ? 'backward' : 'forward'); if (follow) showCaret(ta, to); };
  pick(at, false);
  // (held still outside the field, the drag goes on scrolling it, sideways and up or down, each frame
  // by how far outside it is -- as a drag from the text does: R107-1)
  // (its speed by time, not by frame -- a 120 Hz screen scrolled twice as fast -- up to about 1200 px a
  // second; it stops when the button is no longer held or the window is left, a release it never
  // heard included: R108-3, R108-4)
  let last = null, raf = 0, then = 0;
  const out = (p, lo, size) => (p < lo ? p - lo : p > lo + size ? p - lo - size : 0);
  const step = (d, dt) => Math.sign(d) * Math.min(Math.abs(d) * 1.2, 20) * dt / 16.7;
  const tick = (now) => {
    raf = 0;
    if (!last) return;
    const dt = Math.min(50, then ? now - then : 16.7);
    then = now;
    const r = ta.getBoundingClientRect();
    const dx = out(last.x, r.left, ta.clientWidth), dy = out(last.y, r.top, ta.clientHeight);
    if (!dx && !dy) { then = 0; return; }
    ta.scrollLeft += step(dx, dt);
    ta.scrollTop += step(dy, dt);
    pick(caretAt(ta, last.x, last.y, true), false);
    raf = requestAnimationFrame(tick);
  };
  const move = (m) => {
    if (!(m.buttons & 1)) { up(); return; }
    last = { x: m.clientX, y: m.clientY };
    pick(caretAt(ta, last.x, last.y, true), true);
    if (!raf) raf = requestAnimationFrame(tick);
  };
  function up() {
    last = null; then = 0; cancelAnimationFrame(raf); raf = 0;
    removeEventListener('mousemove', move); removeEventListener('mouseup', up); removeEventListener('blur', up);
  }
  addEventListener('mousemove', move);
  addEventListener('mouseup', up);
  addEventListener('blur', up);
});
$('form').onsubmit = (ev) => {
  ev.preventDefault();
  $('lists').scrollLeft = 0;
  const urls = $('lists').value.split(/\s+/).map((s) => s.trim()).filter(Boolean);
  if (!urls.length) { $('summary').textContent = 'give the list\'s URL'; return; }
  const u = new URL(location.href);
  u.search = '';
  for (const l of urls) u.searchParams.append('list', l);
  history.replaceState(null, '', u);
  run(urls);
};
if (given.length) run(given);
// (the module's last statement: js/boot-check.js's sign the check started -- r74 A4)
window.__checkStarted = true;
document.getElementById('bootslow')?.remove(); // (check.html's no-script card: r76 Q4)
