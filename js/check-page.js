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
      p.append(g, 'the list ', ...urlParts(l.url), l.error ? ` was not read: ${l.error}` : ' was read');
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
// (a press in the box's padding focuses the field, which only its inner row took: R104-2)
$('lists').parentElement?.addEventListener('mousedown', (e) => { if (e.target !== $('lists')) { e.preventDefault(); $('lists').focus(); } });
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
