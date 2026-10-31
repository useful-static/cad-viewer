// check.html: a model list's health (js/list-check.js), for its owner.
// ?list=<url> (repeatable, as the viewer's) fills the box and runs the check;
// the File menu's "Check this list…" opens it so. Each model's checks fill
// the table as they finish; the summary line says the verdict.

import { checkLists, summary } from './list-check.js';

const $ = (id) => document.getElementById(id);
const MARK = { ok: '🟢', warn: '🟡', bad: '🔴' };

function row(entry) {
  const frag = document.createDocumentFragment();
  entry.checks.forEach((c, k) => {
    const tr = document.createElement('tr');
    tr.className = c.level;
    const cells = [MARK[c.level] || '', k === 0 ? entry.name : '', c.what, c.detail, c.url];
    cells.forEach((text, j) => {
      const td = document.createElement('td');
      td.textContent = text;
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
        body.append(row(entry));
        $('summary').textContent = `checked ${body.querySelectorAll('td.model:not(:empty)').length} of ${n} models…`;
      },
    });
    for (const l of result.lists) {
      const p = document.createElement('p');
      p.textContent = l.error ? `🔴 the list ${l.url} was not read: ${l.error}` : `🟢 the list ${l.url} was read`;
      $('listnotes').append(p);
    }
    $('summary').textContent = summary(result);
  } catch (e) {
    $('summary').textContent = `the check stopped: ${e.message || e}`;
  } finally {
    $('go').disabled = false;
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
