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
//   I16 every model the address names loads from where it is served (beside its list, its tour);
//   I17 a list pick pushes an address naming its model alone (no first entry's ?add=s, ?tour=), and
//       each ?add= sits at its own ?addat=;
//   I18 File › Check this list… names each list as the address gives it;
//   I19 the model the address names is the model shown (after a pick, Back, Forward, a failed pick).
// (r59: the harness keeps a real history -- Back and a #view= edit fire popstate and hashchange as a
// browser does --, the real setModelParam and Cancel, a device file with no URL, a view by its text,
// a new header for each added model, and the list's late answer running the entry's rules.)
// (r58: the harness runs the load's own rules -- the view link's view, the entry's tour -- serves
// only the model paths given, and Back restores the first entry's #view=.)
//   node tests/test-startup-sweep.mjs            (exit 0 = all pass)
//   node tests/test-startup-sweep.mjs --list     (every violation, not the first of each)

import assert from 'node:assert/strict';
import { runStart } from './startup-harness.mjs';
import { test, done } from './harness.mjs';

// (each entry with a tour of its own, as a list's models carry them: the entry's tour plays when its
// model opens, held back by the address's tour and by a view link's view over it -- r58 A3)
// (and the first with parts it hides when it opens -- held back by a link's view as its tour is: r59 A6, Q4)
const LIST = JSON.stringify({ 'a.stl': { name: 'A', tours: [{ name: 'own', url: 'at.json' }], hide: ['lid'] }, 'b.stl': { name: 'B', tours: [{ name: 'own', url: 'bt.json' }] } });
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
  // (r59: two ?add=s, each at its own ?addat= -- Q7; a list that answers after its model opened, the
  // entry's rules then run by the list's fill -- Q6; the same with a link's view -- A6)
  'src+2 adds': { q: 'src=a.stl&add=b.stl&addat=1,0,0&add=x.stl&addat=0,2,0' },
  'src+late list': { q: `src=${encodeURIComponent('https://site.example/v/lists/a.stl')}&list=lists/l.json`, list: true, lateList: true },
  // (a list entry named beside an ?add=, in another unit: a pick and Back reopen it with its add --
  // the first entry's address rewritten under it, ?unit= moved: r61 A1; it failing, the ?add= joined
  // the pick: r61 Q1, Q4)
  'list+index1+add+unit': { q: 'list=lists/l.json&index=1&add=x.stl&unit=in', list: true },
  // (the list's first named in another unit: a pick names its own model, not in that unit -- r60 Q6 B)
  'list+index1+unit': { q: 'list=lists/l.json&index=1&unit=in', list: true },
  // (the list's first named, with a view: a pick that fails returns to it -- r60 A5)
  'list+index1+view': { q: 'list=lists/l.json&index=1', hash: '#view=v', list: true },
  'src+late list+view': { q: `src=${encodeURIComponent('https://site.example/v/lists/a.stl')}&list=lists/l.json`, hash: '#view=v', list: true, lateList: true },
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
      ['a drop during a slow ?add=', { slow: [addOf(a.q)], during: [{ at: addOf(a.q), file: 'v.stl' }] }],
      // (Cancel on the ?add=, an Add model… queued behind it: no newer ask, it joins -- r59 Q5)
      ['Add model…, then Cancel, during a slow ?add=', { slow: [addOf(a.q)], during: [{ at: addOf(a.q), add: 'e.stl' }, { at: addOf(a.q), cancel: true }] }],
      // (a #view= edit while the ?add= loads: the address's last view is the one that stays -- r59 A2, Q3)
      ['a #view= edit during a slow ?add=', { slow: [addOf(a.q)], during: [{ at: addOf(a.q), hash: true }] }]);
  }
  if (a.list) out.push(['a list pick, then Back', { after: [{ pick: 2 }, { back: true }] }]);
  // (the visitor's file over the address's model before it showed, then a pick and Back: the page
  // first showed the visitor's file, not the model whose load it superseded -- r57 Q4)
  if (a.list && embed !== 'poster') out.push(['a drop during the model, then a list pick and Back', { during: [{ at: 'model', file: 'v.stl' }], after: [{ pick: 2 }, { back: true }] }]);
  // (Back with no entry of the page's own before it: onto the model shown -- behind a poster, with
  // nothing shown and no pick, there is no entry to go back to)
  // (a pick of the model shown, then Back: onto the model shown -- r57 Q6 m13. Back with no entry
  // before it leaves the page, which the history now keeps: r59)
  if (a.list && embed !== 'poster') out.push(['a pick of the first, then Back', { after: [{ pick: 1 }, { back: true }] }]);
  // (Add model… once the model shows and before its list answers: the header made anew, the entry's
  // rules then run by the list's fill -- the hide went over the link's view: r59 A6)
  if (a.lateList) out.push(['Add model… once the model shows, the list still read', { during: [{ at: 'loaded a.stl', add: 'e.stl' }] }]);
  // (r60 A3-A6: a drop, then a #view= edit; an edit while the visitor's own Add model… loads; the
  // #view= taken out while the model loads; a list pick that fails, beside a #view=)
  out.push(['a drop, then a #view= edit', { after: [{ file: 'v.stl' }, { hash: true }] }],
    ['a #view= edit during Add model…', { during: [{ at: 'e.stl', hash: true }], after: [{ add: 'e.stl' }] }],
    ['the #view= taken out during the model', { during: [{ at: 'model', unhash: true }] }]);
  if (a.list) out.push(['a list pick that fails', { failsPick: true, after: [{ pick: 2 }] }]);
  // (a pick that fails with a #view= edited in during its download, and a failed pick then Forward:
  // every entry it made taken back, none left to land on -- r61 A2, Q3)
  if (a.list && embed !== 'poster') {
    out.push(['a list pick that fails, a #view= edit during it', { failsPick: true, slow: ['b.stl'], during: [{ at: 'b.stl', hash: true }], after: [{ pick: 2 }] }],
      ['a list pick that fails, then Back', { failsPick: true, after: [{ pick: 2 }, { back: true }] }],
      ['a list pick that fails, then Forward', { failsPick: true, after: [{ pick: 2 }, { forward: true }] }]);
  }
  // (r60 Q1, Q5: Back while the pick still loads; a pick, Back, then Forward)
  if (a.list && embed !== 'poster') {
    out.push(['Back during the pick\'s load', { slow: ['b.stl'], during: [{ at: 'b.stl', back: true }], after: [{ pick: 2 }] }],
      ['a pick, Back, then Forward', { after: [{ pick: 2 }, { back: true }, { forward: true }] }]);
  }
  // (a #view= edit while the model loads, and while the list is read: popstate then hashchange -- r59 Q2)
  out.push(['a #view= edit during the model', { during: [{ at: 'model', hash: true }] }]);
  if (a.list) out.push(['a #view= edit during the list', { during: [{ at: LP, hash: true }] }]);
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
  if (a.lateList) files.push('lists/a.stl'); // (its ?src= a URL of its own, wherever the list answers)
  // the model that fails: the one the start would open first
  const firstModel = /src=a\.stl/.test(a.q) ? 'a.stl' : a.tour && !/src=/.test(a.q) ? 'c.stl' : /(index=2|src=b\.stl)/.test(a.q) ? 'b.stl' : 'a.stl';
  // (a list answering after its model: read slowly)
  const slow = [...(actC.slow || []), ...(a.lateList ? [LP] : [])];
  // (a pick that fails: the entry it picks, b.stl, not found)
  const fails = [...(o.failsFirst ? [firstModel] : []), ...(actC.failsPick ? ['b.stl'] : [])];
  return { q: embedQ + a.q, hash: a.hash, serve, redirect, files, ...actC, fails, slow };
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
  // (but never under a poster still up, which stands for the model and hides the card: r59 Q7 Q-m2)
  if (refused && r.posterUp && r.status === 'error') v('I2', `the refusal made the page's error under the poster still up`);
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
    // (its model first, the address's ?add=s after it)
    const last = loadsAfter[0];
    if (startModel && last && last !== startModel.split('/').pop()) v('I6', `Back loaded ${last}, the start opened ${startModel}`);
    // (Back onto the model already shown loads nothing: r57 Q6 m13 -- one whose load failed is not
    // shown, and Back tries it again)
    const before = r.events.slice(0, backAt).filter((e) => e.startsWith('load ')).pop();
    const reload = r.events.slice(backAt + 1).find((e) => e.startsWith('load '));
    // (by name: under a redirect, the late list names an a.stl at another URL than its ?src=, two
    // models of one name -- these checks key on names, so that pair is left out)
    const twoOfOneName = c.addr.lateList && c.redirect;
    // (an address with ?add=s reopens its model with them over the model shown alone: r59 A3)
    if (startModel && !twoOfOneName && !addOf(c.q) && before === `load ${startModel.split('/').pop()}` && !(c.fails || []).includes(before.slice(5)) && reload) v('I6', `Back onto the shown ${before.slice(5)}: ${reload}`);
    // (nor onto the model still shown while a pick downloads: the pick ends, the model stays -- it was
    // downloaded again: r61 Q6)
    const lastShown = r.events.slice(0, backAt).filter((e) => e.startsWith('shown ')).pop();
    const loadingAtBack = r.events.slice(0, backAt).filter((e) => e.startsWith('load ') || e.startsWith('shown ')).pop();
    if (!addOf(c.q) && lastShown && loadingAtBack && loadingAtBack.startsWith('load ') && reload === `load ${lastShown.slice(6)}`
      && !(c.fails || []).includes(lastShown.slice(6))) v('I6', `Back onto the shown ${lastShown.slice(6)}, a pick downloading: ${reload}`);
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
  // The view link's rule, by the ADDRESS (r57 A2, r58 A4, Q1, r59 A1): a #view= -- the address's own
  // (v), or one edited in (v2) -- is for the model its address names, the one its list has there once
  // read (for nothing while the list is unread or lacks it), or, naming none, for a file from the
  // device; never the list's first.
  const qp = new URLSearchParams(c.q);
  const place = !!(qp.get('index') || qp.get('model') || (qp.get('src') && !/^https?:/.test(qp.get('src'))));
  const names = !!(qp.get('src') || place);
  const listUnread = /^list (fails|times out)/.test(c.outcome);
  const namedFile = !names || (place && listUnread) ? null : qp.get('index') === '2' ? 'b.stl' : qp.get('index') === '1' ? 'a.stl'
    : qp.get('model') ? null : (qp.get('src') || '').split('/').pop();
  const forView = (f) => (names ? !!namedFile && f === namedFile : visitorFiles.has(f));
  const shownAt = (i) => (r.events.slice(0, i).filter((x) => x.startsWith('shown ')).pop() || '').slice(6);
  // (the #view= taken out: no view lands after it -- the start's still did: r60 A4; and a pick that
  // failed leaves the page as it was, its camera too -- the undo's Back applied the link's view
  // again: r60 A5)
  const unhashAt = r.events.indexOf('unhash');
  if (unhashAt >= 0 && r.events.slice(unhashAt + 1).some((e) => e.startsWith('view '))) v('I6', `a view applied after the #view= was taken out (${r.events.join(' > ')})`);
  if (c.failsPick && r.events.includes('pick')) {
    const pickAt2 = r.events.indexOf('pick');
    if (r.events.slice(pickAt2 + 1).some((e) => e.startsWith('view '))) v('I6', `a view applied after a pick that failed (${r.events.join(' > ')})`);
  }
  if (c.hash || acts.some((d) => d.hash)) {
    // (each time a view applies, onto the model it is for -- onto the visitor's file for a named
    // model: r58 R2, r59 A1)
    // (an edit made after a device file showed is judged by the address then, which names no model:
    // the device file forgot the address's model -- forgetAddressModel)
    // (the visitor's own file: v.stl -- e.stl only ever joins, as 'added': r61 Q11)
    const deviceBefore = (i) => r.events.slice(0, i).some((x) => x === 'shown v.stl');
    r.events.forEach((e, i) => {
      if (!e.startsWith('view ')) return;
      const ok = e === 'view v2' && deviceBefore(i) ? visitorFiles.has(shownAt(i)) : forView(shownAt(i));
      if (!ok) v('I6', `the link's ${e} applied onto ${shownAt(i) || 'nothing'}`);
    });
    const shownFiles = r.events.filter((e) => e.startsWith('shown ')).map((e) => e.slice(6));
    // (the address's own view, applied to its model once that shows first -- unless the visitor's own
    // open, a pick or a file, came before it could)
    const pickFirst = r.events.indexOf('pick') >= 0 && r.events.indexOf('pick') < r.events.indexOf(`shown ${namedFile}`);
    if (c.hash && namedFile && shownFiles[0] === namedFile && !pickFirst && !acts.some((d) => d.file === 'v.stl' || d.hash || d.unhash) && r.views < 1) v('I6', `the link's view not applied to ${namedFile}, which it names`);
    // (an edit, with its model shown at the end: the last view applied, after the edit, is the edit's
    // -- an edit during the ?add=s was overwritten by the start's older view: r59 A2, Q3)
    const hashAt = r.events.indexOf('hash');
    const endShown = shownAt(r.events.length);
    if (hashAt >= 0 && forView(endShown) && !acts.some((d) => d.file || d.pick || d.back)) {
      const after = r.events.slice(hashAt + 1).filter((e) => e.startsWith('view '));
      if (after[after.length - 1] !== 'view v2') v('I6', `the #view= edit not the view at the end (${r.events.join(' > ')})`);
    }
  }
  // I17: a list pick pushes an address that names its model alone, with the page's lists -- not the
  // first entry's ?add=s and ?tour=, which a reload then opened and played (r59 A4, Q1); and each
  // ?add= sits at its own ?addat= (r59 Q7)
  // (a pick that failed takes its address back: the page's as before it)
  if (acts.some((d) => d.pick) && !acts.some((d) => d.back) && !c.failsPick && r.events.includes('pick')) {
    const h = new URL(r.href).searchParams;
    if (['add', 'addat', 'tour', 'unit'].some((k) => h.get(k))) v('I17', `the pick's address keeps the first entry's ${['add', 'addat', 'tour', 'unit'].filter((k) => h.get(k)).join(', ')}: ${r.href}`);
  }
  // I19: the model the address names is the model shown -- a pick shown under the entry Back went to,
  // and Forward's entry over the model before it, read otherwise (r60 Q1, Q5)
  // (and after a pick that failed, the page "error" over the model still shown: r61 A2, Q3)
  if (!r.left && !['loading', 'tessellating'].includes(r.status) && r.app.sourceUrl && r.events.includes('pick')) {
    const hq = new URL(r.href).searchParams;
    const idx = hq.get('index');
    const shownF = String(r.app.sourceUrl).split('/').pop();
    // (unless the model it names will not open: Back onto an entry whose model fails shows the last
    // model that opened, the address the entry's -- a load failure, not a lost step)
    const namedF = idx === '1' ? 'a.stl' : idx === '2' ? 'b.stl' : '';
    if (idx && shownF !== namedF && !(c.fails || []).includes(namedF)) v('I19', `the address names entry ${idx}, ${shownF} shown`);
    if (!idx && !hq.get('src') && !hq.get('model') && r.app.addressUrl && shownF !== String(r.app.addressUrl).split('/').pop()) v('I19', `the address names the page as first opened (${String(r.app.addressUrl).split('/').pop()}), ${shownF} shown`);
  }
  // (and the entry's hidden parts laid once per open, not again by a later rule run: r60 Q6 H)
  const opens = r.events.map((e, i) => [e, i]).filter(([e]) => e.startsWith('load ')).map(([, i]) => i);
  opens.forEach((i, k) => {
    const seg = r.events.slice(i, opens[k + 1] ?? r.events.length);
    if (seg.filter((e) => e === 'hide').length > 1) v('I15', `the entry's hidden parts laid ${seg.filter((e) => e === 'hide').length} times in one open`);
  });
  // I20: a pick that failed leaves no entry of its own in the history -- Back from an edit made during
  // its download, or Forward, opened it again (r61 A2, Q3)
  const idx2 = (h) => new URL(h).searchParams.get('index') === '2';
  if (c.failsPick && r.events.includes('pick') && r.stack && !idx2(r.stack[0]) && r.stack.some(idx2)) {
    v('I20', `the failed pick's entry left in the history: ${(r.stack || []).map((h) => new URL(h).search).join(' | ')}`);
  }
  // I18: File › Check this list… names each list as the address gives it, one that is not a URL too,
  // for check.html to refuse in words (it was left out, and the check named nothing wrong: r59 A5)
  if (qp.getAll('list').length && !/embed=1/.test(c.q)) {
    const given = new URL(r.dom.checklist.href || 'https://x/').searchParams.getAll('list');
    if (given.length !== qp.getAll('list').length) v('I18', `the list check names ${given.length} list(s) of ${qp.getAll('list').length}: ${r.dom.checklist.href}`);
  }
  const ats = qp.getAll('addat');
  qp.getAll('add').forEach((f, i) => {
    const m = (r.app.scene || []).find((x) => String(x.url).split('/').pop() === f);
    if (m && ats[i] && m.at !== ats[i]) v('I17', `${f} at ${m.at}, its ?addat= ${ats[i]}`);
  });
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
  // (and Back to the first entry after a pick reopens it with them -- Back opened the model alone:
  // r59 A3, Q1)
  const pickBack = acts.length >= 2 && acts[acts.length - 1].back && acts.some((d) => d.pick) && !acts.some((d) => d.file);
  if (added && !(c.fails || []).length && (!acts.some((d) => d.file || d.pick || d.back || d.cancel) || pickBack) && !c.early && startShown && !r.posterUp
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
    const viewAt = seg.findIndex((x) => x.startsWith('view ')), ownAt = seg.indexOf(own);
    // (a view applied at the load comes before the entry's rules: applied first, then its tour)
    // (an edit's view too: the exemption for one made before excused nothing, and hid a tour over an
    // edit landed during the ?add=s -- r61 Q2, Q5)
    if (viewAt >= 0 && ownAt > viewAt) v('I15', `${own} played over the link's view on ${f}`);
    // (nor ended at once by the address's own ?add= joining after it started: the page as first
    // opened is the model with its adds, and its tour is theirs -- the differential, r60)
    if (ownAt >= 0 && seg.slice(ownAt + 1).includes('added') && !acts.some((d) => d.add)) {
      v('I15', `${own} ended by the address's ?add= joining after it (${ev.join(' > ')})`);
    }
    // (nor its hidden parts, by the model's URL whatever replaced its header -- an Add model…, a
    // re-read: r59 A6, Q4)
    if (viewAt >= 0 && seg.indexOf('hide') > viewAt) v('I15', `the entry's hidden parts laid over the link's view on ${f}`);
    const pending = (r.pendingAtList.find(([pf]) => pf === f) || [])[1];
    if (end === ev.length && nextShown < 0 && pending === false && viewAt < 0 && ownAt < 0 && !seg.includes('tour t.json') && !acts.some((d) => d.hash)
      && !(c.addr.lateList && c.redirect)) { // (two models of one name: see I6)
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

// The end state of one run, as tests/ui-diff.py reads the same state off the real page in Chromium
// (r60): the page's status and line, the card, what was told, the scene's models, the address, the
// view link's view on the model shown last, and the tour playing over it.
export function endState(r) {
  if (r.left) return { left: true }; // (Back from the first entry: the page left)
  const base = (u) => String(u || '').split('/').pop();
  const ev = r.events;
  // (the scene's last change: a model shown, or one joining it -- each ends the tour and sets the view)
  const lastShown = ev.map((e) => e.startsWith('shown ') || e === 'added').lastIndexOf(true);
  const after = ev.slice(lastShown + 1);
  const view = after.filter((e) => e.startsWith('view ')).pop();
  const tour = after.filter((e) => e.startsWith('tour ')).pop();
  // (in its own order: a parameter moved is a difference -- r61 A3, A1)
  const q = new URL(r.href).searchParams;
  q.delete('backend');
  return {
    status: r.status, msg: r.msg, card: r.card, told: r.shown,
    scene: (r.app.scene || []).map((m) => base(m.url)), address: q.toString(), hash: new URL(r.href).hash.replace(/^#view=/, ''),
    view: view ? view.slice(5) : null, tour: tour ? tour.slice(5) : null, poster: r.posterUp, entries: r.entries,
  };
}

// --export <file> [--names <file>]: a sample of the sweep for tests/ui-diff.py -- every act at every
// moment once, every address and embed mode once, then every run named in <file> (one name a line,
// as --list prints them) -- each with the harness's end state; written, and no test run.
const exportAt = process.argv.indexOf('--export');
if (exportAt > 0) {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const namesAt = process.argv.indexOf('--names');
  const wanted = namesAt > 0 ? new Set(readFileSync(process.argv[namesAt + 1], 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)) : new Set();
  const seen = new Set(), pick = [];
  const take = (key, item) => { if (!seen.has(key)) { seen.add(key); pick.push(item); } };
  const parts = (n) => n.split(' | ');
  for (const item of cases) { const [, , , act] = parts(item[0]); take(`act ${act}`, item); }
  for (const item of cases) { const [addr, embed] = parts(item[0]); take(`addr ${addr}`, item); take(`embed ${embed}`, item); }
  for (const item of cases) if (wanted.has(item[0])) take(`name ${item[0]}`, item);
  const out = [];
  for (const [name, c] of [...new Map(pick.map((p) => [p[0], p])).values()]) {
    const r = await runStart(c);
    const { addr, ...spec } = c;
    out.push({ name, case: spec, harness: endState(r) });
  }
  writeFileSync(process.argv[exportAt + 1], JSON.stringify(out, null, 1));
  console.log(`EXPORT ${out.length} runs of ${cases.length}`);
  process.exit(0);
}

await test(`the start-up sweep: ${cases.length} runs of main.js's own start, each against the invariants I1-I19 (r57-r61)`, async () => {
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
