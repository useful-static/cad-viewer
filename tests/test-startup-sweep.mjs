#!/usr/bin/env node
// The page's start from its address, swept (r57). Each run is main.js's own code (tests/startup-harness.mjs).
// The sweep is a product:
// - an address: ?src=, ?list= with and without a named model, ?tour= with and without its own
//   model, ?add=, #view=, each plain, an embed, and an embed's poster;
// - one read's outcome: all ok, or the list, the tour or the model failing, timing out or
//   redirecting;
// - one visitor act: none, an early pick, a drop, a refused file, Add model…, a list pick, View in
//   3D, Back, a #view= edit;
// - when the act lands: before, during the list's or the tour's read, during the model's load, or
//   after.
// Hand-picked cases could not close the space between them (START_CASES went from 43 to 84, each
// round finding paths between the last's). It asserts invariants, not per-case answers:
//   I1 nothing the address names opens over a file (or list pick) the visitor opened;
//   I2 a refusal is told;
//   I3 the page never ends on a load or read card;
//   I4 no address tour left pending (a poster still up keeps it);
//   I5 an error on the card has words;
//   I6 Back to the first entry reaches what the start opened (onto the model shown, loading
//      nothing), and a #view= edit applies only to the model its link names;
//   I7 Cancel is offered during every load;
//   I8 nothing throws;
//   I9 the address's tour never starts after a list pick;
//   I10 a model the visitor added stays in the scene;
//   I11 a list model shown once the address's tour is over sees it over (its own tour plays);
//   I12 what the page says the address opened, it opened;
//   I13 "the tour is ready" is never told over its own model's failure;
//   I14 a tour read that names no model is played or said ready, not dropped unsaid;
//   I15 a list entry's own tour plays when its model opens, and never over a view link's view on it;
//   I16 every model the address names loads from where it is served (beside its list, its tour).
// (r58: the harness runs the load's own rules -- the view link's view, the entry's tour -- serves
// only the model paths given, and Back restores the first entry's #view=.)
//   node tests/test-startup-sweep.mjs            (exit 0 = all pass)
//   node tests/test-startup-sweep.mjs --list     (every violation, not the first of each)

import assert from 'node:assert/strict';
import { runStart } from './startup-harness.mjs';
import { test, done } from './harness.mjs';

// (each entry with a tour of its own, as a list's models carry them: the entry's tour plays when its
// model opens, held back by the address's tour and by a view link's view over it -- r58 A3)
const LIST = JSON.stringify({ 'a.stl': { name: 'A', tours: [{ name: 'own', url: 'at.json' }] }, 'b.stl': { name: 'B', tours: [{ name: 'own', url: 'bt.json' }] } });
const TOUR = (model) => JSON.stringify({ cadtour: 1, ...(model ? { model } : {}), steps: [{ title: 'one' }] });
const BIG = 'big.stl is over 2 GB, more than this viewer opens';
const LP = 'lists/l.json'; // (the list's path)

// the addresses: q, hash, what it reads (list / tour), the tour's own model
const ADDRESSES = {
  src: { q: 'src=a.stl' },
  list: { q: 'list=lists/l.json', list: true },
  'list+index': { q: 'list=lists/l.json&index=2', list: true },
  'list+lacking': { q: 'list=lists/l.json&model=nope', list: true },
  'tour (its model)': { q: 'tour=t.json', tour: 'c.stl' },
  'tour (no model)': { q: 'tour=t.json', tour: null },
  'src+tour (its model)': { q: 'src=a.stl&tour=t.json', tour: 'c.stl' },
  'src+tour (no model)': { q: 'src=a.stl&tour=t.json', tour: null },
  'list+tour (its model)': { q: 'list=lists/l.json&tour=t.json', list: true, tour: 'c.stl' },
  'list+tour (no model)': { q: 'list=lists/l.json&tour=t.json', list: true, tour: null },
  // (a name the list lacks beside a tour: what opens instead is said at the tour's end -- r57 Q7 m9)
  'list+lacking+tour (no model)': { q: 'list=lists/l.json&model=nope&tour=t.json', list: true, tour: null },
  'src+add': { q: 'src=a.stl&add=b.stl' },
  'src+view': { q: 'src=a.stl', hash: '#view=v' },
  'list+view': { q: 'list=lists/l.json', hash: '#view=v', list: true },
  // (r58: the paths round 57's sweep lacked -- A7, Q5)
  'list+add': { q: 'list=lists/l.json&add=x.stl', list: true },
  'tour (its model)+add': { q: 'tour=t.json&add=x.stl', tour: 'c.stl' },
  'list+lacking+tour (its model)': { q: 'list=lists/l.json&model=nope&tour=t.json', list: true, tour: 'c.stl' },
  'list+lacking+view': { q: 'list=lists/l.json&model=nope', hash: '#view=v', list: true },
  'list+src place': { q: 'list=lists/l.json&src=b.stl', list: true },
  'list+index+view': { q: 'list=lists/l.json&index=2', hash: '#view=v', list: true },
  'src+add+view': { q: 'src=a.stl&add=b.stl', hash: '#view=v' },
  // (a ?list= that is not a URL beside a ?src=: refused in words, the ?src= opening -- r58 Q6)
  'src+bad list': { q: 'src=a.stl&list=http://[x' },
};
// the model an address's ?add= names
const addOf = (q) => (q.match(/(?:^|&)add=([^&]+)/) || [])[1] || null;
const EMBEDS = { plain: '', embed: 'embed=1&', poster: 'embed=1&poster=p.png&' };
// one read's outcome (the rest ok)
function outcomes(a) {
  const out = [['all ok', {}]];
  for (const [read, path] of [['list', LP], ['tour', 't.json']]) {
    if (!a[read === 'list' ? 'list' : 'tour'] && !(read === 'tour' && 'tour' in a)) continue;
    out.push([`${read} fails`, { missing: path }], [`${read} times out`, { timeout: path }], [`${read} redirects`, { redirect: { [path]: `moved/${path}` } }]);
  }
  out.push(['the model fails', { failsFirst: true }]);
  return out;
}
// one act, and when it lands
function acts(a, embed) {
  const when = ['during the model'];
  if (a.list) when.unshift('during the list');
  if ('tour' in a) when.unshift('during the tour');
  when.push('after');
  const out = [['none', {}], ['an early pick', { early: [{ name: 'v.stl', size: 10 }] }], ['an early refusal', { early: [{ name: 'big.stl', size: 3e9 }] }]];
  const at = (w) => (w === 'during the list' ? LP : w === 'during the tour' ? 't.json' : w === 'during the model' ? 'model' : null);
  for (const w of when) {
    const place = (d) => (at(w) ? { during: [{ at: at(w), ...d }] } : { after: [d] });
    out.push([`a drop ${w}`, place({ file: 'v.stl' })], [`a refused file ${w}`, place({ file: 'big.stl', size: 3e9 })], [`Add model… ${w}`, place({ add: 'e.stl' })]);
    if (a.list && w !== 'during the list') out.push([`a list pick ${w}`, place({ pick: 2 })]);
    if (embed === 'poster' && w !== 'during the model') out.push([`View in 3D ${w}`, place({ click: true })]);
  }
  // (Add model… while the address's ?add= loads: queued after it, neither cancelling the other -- r57 A5, Q3)
  // (and then a file of the visitor's own while the ?add= still loads, quick or slow: the newer ask
  // wins over the queued add -- r58 A1, Q2)
  if (addOf(a.q)) {
    out.push(['Add model… during the ?add=', { during: [{ at: addOf(a.q), add: 'e.stl' }] }],
      ['Add model…, then a drop, during the ?add=', { during: [{ at: addOf(a.q), add: 'e.stl' }, { at: addOf(a.q), file: 'v.stl' }] }],
      ['Add model…, then a slow drop, during the ?add=', { slow: ['v.stl'], during: [{ at: addOf(a.q), add: 'e.stl' }, { at: addOf(a.q), file: 'v.stl' }] }],
      // (the visitor's file shown while a slow ?add= still settles: what waited on the adds then
      // meets the visitor's file -- r58 R2)
      ['a drop during a slow ?add=', { slow: [addOf(a.q)], during: [{ at: addOf(a.q), file: 'v.stl' }] }]);
  }
  if (a.list) out.push(['a list pick, then Back', { after: [{ pick: 2 }, { back: true }] }]);
  // (the visitor's file over the address's model before it showed, then a pick and Back: the page
  // first showed the visitor's file, not the model whose load it superseded -- r57 Q4)
  if (a.list && embed !== 'poster') out.push(['a drop during the model, then a list pick and Back', { during: [{ at: 'model', file: 'v.stl' }], after: [{ pick: 2 }, { back: true }] }]);
  // (Back with no entry of the page's own before it: onto the model shown -- behind a poster, with
  // nothing shown and no pick, there is no entry to go back to)
  if (a.list && embed !== 'poster') out.push(['Back after', { after: [{ back: true }] }]);
  // (two acts: the visitor's file during the tour's read, then Add model… once it shows -- the tour's
  // own model opened over both under a mutant one act never reaches: r57 Q7 m6)
  if ('tour' in a) out.push(['a drop during the tour, then Add model…', { slow: ['t.json'], during: [{ at: 't.json', file: 'v.stl' }, { at: 'loaded v.stl', add: 'e.stl' }] }]);
  out.push(['a #view= edit after', { after: [{ hash: true }] }]);
  if (embed === 'poster') out.push(['View in 3D, then a #view= edit', { after: [{ click: true }, { hash: true }] }]);
  return out;
}

function caseOf(a, embedQ, o, actC) {
  const serve = {};
  if (a.list) serve[LP] = LIST;
  if ('tour' in a) serve['t.json'] = TOUR(a.tour);
  if (o.missing) delete serve[o.missing];
  if (o.timeout) serve[o.timeout] = 'TIMEOUT';
  // (a redirected read is served at its asked path; its files -- models, the entries' tours -- only
  // where it answered, so one resolved against the asked URL is not found: r58 Q4)
  const redirect = o.redirect;
  // (the list in a folder of its own, its models beside it: an entry resolved against the page, not
  // the list, is not found -- a relative ?src= the list names opened from the page: r58 Q3)
  const listAt = o.redirect?.[LP] ? 'moved/lists/' : 'lists/', tourAt = o.redirect?.['t.json'] ? 'moved/' : '';
  if (a.list) { serve[`${listAt}at.json`] = TOUR(); serve[`${listAt}bt.json`] = TOUR(); }
  // (with no list, a.stl and b.stl are the page's own: ?src=, ?add=; x.stl an ?add= no list names)
  const files = a.list ? [`${listAt}a.stl`, `${listAt}b.stl`, `${tourAt}c.stl`, 'x.stl'] : ['a.stl', 'b.stl', `${tourAt}c.stl`, 'x.stl'];
  // the model that fails: the one the start would open first
  const firstModel = /src=a\.stl/.test(a.q) ? 'a.stl' : a.tour && !/src=/.test(a.q) ? 'c.stl' : /(index=2|src=b\.stl)/.test(a.q) ? 'b.stl' : 'a.stl';
  return { q: embedQ + a.q, hash: a.hash, serve, redirect, files, fails: o.failsFirst ? [firstModel] : [], ...actC };
}

// The invariants, each a check of one run: a list of [invariant, what was seen] when broken
const visitorFiles = new Set(['v.stl', 'e.stl']);
function check(c, r) {
  const bad = [];
  const v = (inv, why) => bad.push([inv, why]);
  if (r.threw) v('I8', `threw ${r.threw}`);
  // (the acts that happened: one set for a moment that never came -- no model loads behind a poster
  // -- is not counted)
  const acts = r.acted;
  // I1: after the visitor's own file (an early pick, a drop) or a list pick, nothing else the address names loads
  const visitorAt = (() => {
    if (c.early && c.early[0].size < 1e9) return r.loadedUrls.indexOf('v.stl');
    if (acts.some((d) => d.file === 'v.stl')) return r.loadedUrls.indexOf('v.stl');
    if (acts.some((d) => d.pick) && !acts.some((d) => d.back)) return r.loadedUrls.findIndex((u) => /b\.stl$/.test(u) && r.loadedUrls.indexOf(u) > 0);
    return -1;
  })();
  if (visitorAt >= 0) {
    // (a list pick and Back after it are the visitor's own acts, not the address's)
    const own = (u) => visitorFiles.has(u.split('/').pop()) || (acts.some((d) => d.pick) && /\/b\.stl$/.test(u)) || acts.some((d) => d.back);
    const later = r.loadedUrls.slice(visitorAt + 1).filter((u) => !own(u));
    if (later.length) v('I1', `after the visitor's ${r.loadedUrls[visitorAt]}: ${later.join(', ')}`);
  }
  // (and the visitor's own acts in their order: an add asked before a file they opened next does not
  // load after it, over it -- e.stl counted as the visitor's let it: r58 Q5)
  const addAt = r.events.indexOf('add'), fileAt = r.events.indexOf('file v.stl');
  if (addAt >= 0 && fileAt > addAt && r.events.slice(fileAt + 1).includes('load e.stl')) v('I1', `Add model… asked before the visitor's v.stl loaded after it (${r.events.join(' > ')})`);
  // I2: a refusal is told (shown in the view), or is the error on the card at the end
  const refused = (c.early && c.early[0].size > 1e9) || acts.some((d) => d.size > 1e9);
  // (and with nothing shown at the end, on the card: told while the start ran, a note after it
  // replaced it, the card empty -- r58 Q7)
  if (refused && !r.app.header && !r.posterUp && r.status !== 'error' && !acts.some((d) => d.file === 'v.stl' || d.pick || d.click)) v('I2', `"${BIG}" told, then off the card with nothing shown (ended ${r.status} ${JSON.stringify(r.msg)})`);
  if (refused && !r.shown.includes(BIG) && r.card[1] !== BIG) v('I2', `"${BIG}" neither told nor on the card (told ${JSON.stringify(r.shown)}, card ${JSON.stringify(r.card)})`);
  // I3: not ended on a load or a read
  if (['loading', 'tessellating', 'init', 'recovering'].includes(r.status)) v('I3', `ended ${r.status}: ${r.msg}`);
  if (r.app.readingList) v('I3', 'ended reading the list');
  if (/^reading the /.test(r.msg || '')) v('I3', `ended on "${r.msg}"`);
  // I4: the address's tour over by the end (a poster still up keeps it)
  if (r.app.urlTourPending && !r.posterUp) v('I4', 'the address\'s tour still pending');
  // I5: an error on the card has words
  if (r.status === 'error' && (!r.card[1] || r.card[1].length < 6 || r.card[1] === 'error')) v('I5', `the card's error ${JSON.stringify(r.card[1])}`);
  // I6: Back to the first entry reaches what the start opened; a #view= edit applies to it
  if (acts.some((d) => d.back)) {
    const startModel = r.app.addressUrl;
    const backAt = r.events.indexOf('back');
    // (what Back itself loaded, if anything: an ?add= loaded before it is not Back's)
    const loadsAfter = r.events.slice(backAt + 1).filter((e) => e.startsWith('load ')).map((e) => e.slice(5));
    const last = loadsAfter[loadsAfter.length - 1];
    if (startModel && last && last !== startModel.split('/').pop()) v('I6', `Back loaded ${last}, the start opened ${startModel}`);
    // (Back onto the model already shown loads nothing: r57 Q6 m13 -- one whose load failed is not
    // shown, and Back tries it again)
    const before = r.events.slice(0, backAt).filter((e) => e.startsWith('load ')).pop();
    const reload = r.events.slice(backAt + 1).find((e) => e.startsWith('load '));
    if (startModel && before === `load ${startModel.split('/').pop()}` && !(c.fails || []).includes(before.slice(5)) && reload) v('I6', `Back onto the shown ${before.slice(5)}: ${reload}`);
    // (and what it loads is a model the page showed from its address before the pick -- the first
    // start-up load that started, superseded by the visitor's file unseen, was taken: r57 Q4)
    // (an address that names its model -- ?src=, ?index= -- has Back open that one, shown or not)
    if (reload && !/(?:^|&)(src|index)=/.test(c.q)) {
      const f = reload.slice(5);
      const shownBefore = r.events.slice(0, backAt).filter((e) => e.startsWith('shown ')).map((e) => e.slice(6));
      const firstShown = shownBefore[0];
      if (visitorFiles.has(firstShown) || (firstShown && f !== firstShown && !(c.fails || []).includes(f))) v('I6', `Back loaded ${f}; the page first showed ${firstShown}`);
    }
  }
  // (a #view= is for the model its address names, or, naming none, a file from the device -- never a
  // list's first: the view link's rule, one for every path, r57 A2)
  if (acts.some((d) => d.hash) && r.app.header) {
    // (a ?model= the list lacks names nothing it has: the list's first opens instead, not its model)
    const named = /(?:^|&)(src|index)=/.test(c.q);
    const shown = String(r.app.sourceUrl || '').split('/').pop();
    const forIt = named ? r.app.sourceUrl === r.app.addressUrl && !!r.app.addressUrl : !r.app.sourceUrl || visitorFiles.has(shown);
    if (forIt && r.views < 1) v('I6', `a #view= edit not applied to ${shown || 'the device file'}`);
    if (!forIt && r.views > 0) v('I6', `a #view= edit applied to ${shown}, which it does not name`);
  }
  // (the view a page opens with, by the same rule: applied to the model its address names once that
  // shows first, and never, with none named, to anything but a file from the device -- the load's own
  // rule was not run, and Back put the device file's view on the list's first: r58 Q1, Q4, A4)
  if (c.hash && !acts.some((d) => d.hash)) {
    const namedFile = /(?:^|&)src=a\.stl/.test(c.q) ? 'a.stl' : /(?:^|&)(index=2|src=b\.stl)/.test(c.q) ? 'b.stl' : null;
    const shownFiles = r.events.filter((e) => e.startsWith('shown ')).map((e) => e.slice(6));
    const deviceShown = shownFiles.some((f) => visitorFiles.has(f));
    // (a list pick before it showed is the visitor's own open: the link's view went with the page's)
    const pickFirst = r.events.indexOf('pick') >= 0 && r.events.indexOf('pick') < r.events.indexOf(`shown ${namedFile}`);
    // (nor a file the visitor opened before the view could apply -- it waits on the ?add=s)
    if (namedFile && shownFiles[0] === namedFile && !pickFirst && !acts.some((d) => d.file === 'v.stl') && r.views < 1) v('I6', `the link's view not applied to ${namedFile}, which it names`);
    if (!namedFile && !deviceShown && r.views > 0) v('I6', `the link's view applied to ${shownFiles.join(', ')}, none of which it names`);
    // (and each time it applies, onto the model it is for: the one named, else a device file -- the
    // view waiting on the ?add=s went onto the visitor's file: r58 R2)
    r.events.forEach((e, i) => {
      if (e !== 'view') return;
      const on = (r.events.slice(0, i).filter((x) => x.startsWith('shown ')).pop() || '').slice(6);
      if (namedFile ? on !== namedFile : !visitorFiles.has(on)) v('I6', `the link's view applied onto ${on || 'nothing'}`);
    });
  }
  // I7: every load offered Cancel
  if (r.cancelHidden.length) v('I7', `loaded with Cancel hidden: ${r.cancelHidden.join(', ')}`);
  // I9: the address's tour never starts after a list pick, which ends it (r57 A1, Q1)
  const pickAt = r.events.indexOf('pick');
  if (pickAt >= 0 && r.events.slice(pickAt + 1).includes('tour t.json')) v('I9', `the address's tour started after the list pick (${r.events.join(' > ')})`);
  // I10: a model the visitor added (a scene to add to) is in the scene at the end -- neither an ?add=
  // nor anything else the address names drops it (r57 A5, Q3)
  // (unless the visitor opened a file of their own after asking: the newer ask wins -- r58 A1, Q2)
  const fileAfterAdd = r.events.indexOf('add') >= 0 && r.events.indexOf('file v.stl') > r.events.indexOf('add');
  if (r.events.includes('add') && !fileAfterAdd && !(r.app.scene || []).some((m) => String(m.url).endsWith('e.stl'))) {
    v('I10', `the visitor's e.stl not in the scene: ${JSON.stringify((r.app.scene || []).map((m) => String(m.url).split('/').pop()))}`);
  }
  // (nor does the visitor's add drop the address's own ?add=, its model still shown)
  // (and the address's ?add= joins whatever first model its start opens: ?src=, the tour's own model,
  // the list's first -- only ?src= took it: r58 A2)
  const added = addOf(c.q);
  const startShown = r.events.find((e) => e.startsWith('shown '));
  if (added && !(c.fails || []).length && !acts.some((d) => d.file || d.pick || d.back) && !c.early && startShown && !r.posterUp
    && !(r.app.scene || []).some((m) => String(m.url).split('/').pop() === added)) {
    v('I10', `the address's ?add= ${added} not in the scene: ${JSON.stringify((r.app.scene || []).map((m) => String(m.url).split('/').pop()))}`);
  }
  // I11: a list model shown once the address's tour is over -- it failed, or there is none -- sees it
  // over, so its own tour plays (applyListEntry; r57 A6)
  const tourOver = !('tour' in c.addr) || /^tour (fails|times out)/.test(c.outcome);
  for (const [file, pending] of r.pendingAtList) if (tourOver && pending) v('I11', `${file} shown with the address's tour still pending`);
  // I12: what the page says the address opened, it opened -- "has no model X" only beside a model
  // the address opened, "its first opens" only with the list's first loaded (r57 Q7 m9)
  const addressLoads = r.loadedUrls.filter((u) => !visitorFiles.has(u.split('/').pop()));
  for (const s of r.shown.filter((t) => /^the model list has no model /.test(t))) {
    if (!addressLoads.length) v('I12', `"${s}" with nothing the address names opened`);
    if (/: its first opens$/.test(s) && !addressLoads.some((u) => u.endsWith('/a.stl'))) v('I12', `"${s}" with the list's first never loaded`);
  }
  // I13: "the tour is ready" is not told over its own model's failure -- that model is what it waits
  // for (r57 Q7 m7)
  if (c.addr.tour && (c.fails || []).includes(c.addr.tour) && r.shown.some((t) => /^the tour is ready/.test(t))) v('I13', 'the tour said ready with its own model failed');
  // I14: a tour read that names no model of its own is played or said ready -- not dropped unsaid --
  // unless a list pick ended it, the poster still holds it, or a file dropped on the poster set the
  // poster's content aside (START_CASES, r55 A3) (a failed list kept it unsaid: r57 A3)
  const posterDrop = /poster=/.test(c.q) && acts.some((d) => d.file);
  if (c.addr.tour === null && !/^tour /.test(c.outcome) && !r.posterUp && !acts.some((d) => d.pick) && !posterDrop
    && !r.events.includes('tour t.json') && !r.shown.some((t) => /^the tour is ready/.test(t))) v('I14', 'the tour read, neither played nor said ready');
  // I16: every model the address names loads from where it is served -- a list's entry from beside the
  // list, a tour's model from beside the tour (a relative ?src= the list names opened from the page's
  // address behind a poster: r58 Q3; and a redirect's base, r56 A1)
  // (with the list unread nothing names it: a relative ?src= is read from the page's address, its
  // 404 saying so -- the designed fallback)
  if (!/^list (fails|times out)/.test(c.outcome)) for (const e of r.events.filter((x) => x.startsWith('missing '))) v('I16', `loaded ${e.slice(8)}, which nothing serves`);
  // I15: a list entry's own tour never plays over a view link's view on its model, and plays when its
  // model opens with no link's view over it and the address's tour over (applyListEntry read the
  // pending view, which the load had already cleared -- backwards both ways: r58 A3)
  const ev = r.events;
  const shows = ev.map((e, i) => [e, i]).filter(([e]) => /^shown [ab]\.stl$/.test(e));
  shows.forEach(([e, i], k) => {
    const f = e.slice(6);
    const own = `tour ${f[0]}t.json`;
    const end = k + 1 < shows.length ? shows[k + 1][1] : ev.length;
    const nextShown = ev.findIndex((x, j) => j > i && x.startsWith('shown '));
    const seg = ev.slice(i + 1, nextShown < 0 ? ev.length : nextShown);
    const viewAt = seg.indexOf('view'), ownAt = seg.indexOf(own);
    // (a view applied at the load comes before the entry's rules: applied first, then its tour)
    if (viewAt >= 0 && ownAt > viewAt && !seg.slice(0, viewAt).includes('hash')) v('I15', `${own} played over the link's view on ${f}`);
    const pending = (r.pendingAtList.find(([pf]) => pf === f) || [])[1];
    if (end === ev.length && nextShown < 0 && pending === false && viewAt < 0 && ownAt < 0 && !seg.includes('tour t.json') && !acts.some((d) => d.hash)) {
      v('I15', `${f} opened with no link's view over it and the address's tour over, and ${own} never played`);
    }
  });
  return bad;
}

const cases = [];
for (const [an, a] of Object.entries(ADDRESSES)) {
  for (const [en, eq] of Object.entries(EMBEDS)) {
    for (const [on, o] of outcomes(a)) {
      for (const [actn, actC] of acts(a, en)) cases.push([`${an} | ${en} | ${on} | ${actn}`, { ...caseOf(a, eq, o, actC), addr: a, outcome: on }]);
    }
  }
}

await test(`the start-up sweep: ${cases.length} runs of main.js's own start, each against the invariants I1-I16 (r57, r58)`, async () => {
  const byInv = {};
  const t0 = Date.now();
  let unreached = 0;
  // (in batches: each run waits on timers, and they wait together)
  for (let i = 0; i < cases.length; i += 32) {
    const batch = cases.slice(i, i + 32);
    const rs = await Promise.all(batch.map(([, c]) => runStart(c)));
    batch.forEach(([name, c], j) => {
      const set = [].concat(c.during || []).length + [].concat(c.after || []).length;
      if (rs[j].acted.length < set) unreached++;
      for (const [inv, why] of check(c, rs[j])) (byInv[inv] ||= []).push(`${name}: ${why}`);
    });
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const all = process.argv.includes('--list');
  const lines = Object.entries(byInv).sort().map(([inv, l]) => `${inv}: ${l.length} runs\n  ${(all ? l : l.slice(0, 6)).join('\n  ')}`);
  console.log(`SWEEP ${cases.length} runs in ${secs} s (${unreached} with an act whose moment never came); violations: ${Object.entries(byInv).map(([k, l]) => `${k} ${l.length}`).join(', ') || 'none'}`);
  if (lines.length) console.log(lines.join('\n'));
  assert.deepEqual(Object.keys(byInv), [], 'invariants broken');
});

done();
