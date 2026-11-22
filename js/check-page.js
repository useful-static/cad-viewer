// check.html: a model list's health (js/list-check.js), for its owner.
// ?list=<url> (repeatable, as the viewer's) fills the box and runs the check;
// the File menu's "Check this list…" opens it so. Each model's checks fill
// the table as they finish; the summary line says the verdict.

import { checkLists, insertInOrder, summary } from './list-check.js';

const $ = (id) => document.getElementById(id);
// (a shape per state, not a colour alone, and its word for a title: R99-3)
const MARK = { ok: '✓', warn: '▲', bad: '✗' };
const WORD = { ok: 'ok', warn: 'look at', bad: 'failed' };

function row(entry) {
  const frag = document.createDocumentFragment();
  entry.checks.forEach((c, k) => {
    const tr = document.createElement('tr');
    tr.className = c.level;
    const cells = [MARK[c.level] || '', k === 0 ? entry.name : '', c.what, c.detail, c.url];
    cells.forEach((text, j) => {
      const td = document.createElement('td');
      td.textContent = text;
      if (j === 0) { td.className = 'mark'; td.title = WORD[c.level] || ''; }
      if (j === 1) {
        td.className = 'model';
        if (k === 0 && entry.id) {
          const s = document.createElement('small');
          s.textContent = `id ${entry.id}`;
          td.append(s);
        }
      }
      if (j === 3) td.className = 'res';
      if (j === 4) td.className = 'url';
      tr.append(td);
    });
    frag.append(tr);
  });
  return frag;
}

async function run(urls) {
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
      p.textContent = l.error ? `${MARK.bad} the list ${l.url} was not read: ${l.error}` : `${MARK.ok} the list ${l.url} was read`;
      $('listnotes').append(p);
    }
    $('summary').textContent = summary(result);
  } catch (e) {
    $('summary').textContent = `the check stopped: ${e.message || e}`;
  } finally {
    $('go').disabled = false;
    // (the button disabled itself while it ran, dropping the focus to the page: back on it -- R99-4)
    const f = document.activeElement;
    if (!f || f === document.body) $('go').focus?.();
  }
}

const given = new URLSearchParams(location.search).getAll('list');
$('lists').value = given.join('\n');
$('form').onsubmit = (ev) => {
  ev.preventDefault();
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
