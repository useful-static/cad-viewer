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
//   I19 the model the address names is the model shown (after a pick, Back, Forward, a failed pick);
//   I20 a failed pick leaves the history as it was before it (its own entries gone, none ahead);
//   I21 the page leaves only by the visitor's own Back from its first entry;
//   I22 the address's ?add=s are in the scene exactly when the address at the end names them;
//   I23 "this file is in" writes ?unit= beside the model it is for;
//   I24 after a reload, the model shown is the one the address shown opens fresh (Back onto an entry
//       from before it read that page's marks as its own: r64 Q3);
//   I25 "this file is in" while another model opens is refused in words (r64 S1; untested: r65 A6);
//   I26 the address's tour failing after the visitor left that address is told, never written into
//       the shown model's ready line (which way it went was the order of two answers: r66);
//   I27 "this file is in", chosen more than once, reads the model in the last unit chosen, and a
//       re-read ends the tour (r66 A2, Q1, Q4, Q5);
//   I28 the units row's select says the unit the model is read in (a re-read cancelled left it on
//       the choice: r67 Q3, Q4).
// (r59: the harness keeps a real history -- Back and a #view= edit fire popstate and hashchange as a
// browser does --, the real setModelParam and Cancel, a device file with no URL, a view by its text,
// a new header for each added model, and the list's late answer running the entry's rules.)
// (r58: the harness runs the load's own rules -- the view link's view, the entry's tour -- serves
// only the model paths given, and Back restores the first entry's #view=.)
//   node tests/test-startup-sweep.mjs            (exit 0 = all pass)
//   node tests/test-startup-sweep.mjs --list     (every violation, not the first of each)

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runStart as runOnePage } from './startup-harness.mjs';
import { test, done } from './harness.mjs';

// One run across the reloads in it: a page that reloads -- the visitor's reload, or a step onto an
// entry another page wrote -- is followed by the page the browser opens then, on the same history,
// at the entry shown, with the acts not yet made (r64 Q3). The run's result is the last page's, and
// pageCase the case it ran -- its address the page's own start, its acts those made on it -- which
// the invariants are checked against; allEvents: every page's, each after the first marked "page".
async function runStart(c) {
  let r = await runOnePage(c);
  const events = [...r.events];
  let rest = [].concat(c.after || []).slice(r.afterDone || 0);
  let page = c;
  for (let n = 0; r.reloaded && n < 4; n++) {
    const u = new URL(r.prior.stack[r.prior.at].href);
    // (the page opens its entry's address: its own search and fragment, the outcome's network as it was)
    // (the first page's moments are its own; a case's duringNext are the next page's)
    // (and a case's failsNext, the files that fail from the next page on: a model that loaded
    // before the reload and fails after it -- every page had the first's network: r65 Q5)
    page = { ...c, q: u.search.slice(1), hash: u.hash, during: n === 0 ? c.duringNext || [] : [], early: undefined, after: rest, prior: r.prior, fails: c.failsNext || c.fails };
    // (its address's own shape: a tour or a list only where it names one)
    const addr = { ...c.addr, q: page.q, list: /(?:^|&)list=/.test(page.q) };
    if (!/(?:^|&)tour=/.test(page.q)) delete addr.tour;
    page.addr = addr;
    r = await runOnePage(page);
    events.push('page', ...r.events);
    rest = rest.slice(r.afterDone || 0);
  }
  r.allEvents = events;
  r.pageCase = page;
  return r;
}

// (each entry with a tour of its own, as a list's models carry them: the entry's tour plays when its
// model opens, held back by the address's tour and by a view link's view over it -- r58 A3)
// (and the first with parts it hides when it opens -- held back by a link's view as its tour is: r59 A6, Q4)
// (and a third, for a pick made while another downloads: r62 A2)
const LIST = JSON.stringify({ 'a.stl': { name: 'A', tours: [{ name: 'own', url: 'at.json' }], hide: ['lid'] }, 'b.stl': { name: 'B', tours: [{ name: 'own', url: 'bt.json' }] }, 'd.stl': { name: 'D' } });
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
  // (a link the page wrote itself: its list spelled lists%2Fl.json, entry 2 with a view -- r63 Q1, Q9)
  'list+index (page-spelled)+view': { q: 'list=lists%2Fl.json&index=2', hash: '#view=v', list: true, pageSpelled: true },
  // (a ?unit= with no model named, and beside a tour's own model: whose is it -- r62 Q2)
  'list+unit': { q: 'list=lists/l.json&unit=in', list: true },
  'tour (its model)+unit': { q: 'tour=t.json&unit=in', tour: 'c.stl' },
  // (the list's first named in another unit: a pick names its own model, not in that unit -- r60 Q6 B)
  'list+index1+unit': { q: 'list=lists/l.json&index=1&unit=in', list: true },
  // (the list's first named, with a view: a pick that fails returns to it -- r60 A5)
  'list+index1+view': { q: 'list=lists/l.json&index=1', hash: '#view=v', list: true },
  'src+late list+view': { q: `src=${encodeURIComponent('https://site.example/v/lists/a.stl')}&list=lists/l.json`, hash: '#view=v', list: true, lateList: true },
  // (its model shown while its ?add= waits for the list, nothing loading: "this file is in" then
  // ended the add -- the wait the round-64 audit called shadowed: r65 Q6)
  'src+late list+add': { q: `src=${encodeURIComponent('https://site.example/v/lists/a.stl')}&list=lists/l.json&add=x.stl`, list: true, lateList: true },
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
      // (r62 Q5: a pick during the ?add=, Back during the pick -- the first model shown alone, Back
      // reopens it with its adds; an edit then Back during the ?add=; a pick during it that fails --
      // its adds cancelled, put back: Q3)
      ['a list pick during a slow ?add=, Back during the pick', { slow: [addOf(a.q), 'b.stl'], during: [{ at: addOf(a.q), pick: 2 }, { at: 'b.stl', back: true }] }],
      ['a #view= edit then Back during a slow ?add=', { slow: [addOf(a.q)], during: [{ at: addOf(a.q), hash: true }, { at: addOf(a.q), back: true }] }],
      ['a list pick during a slow ?add=, the pick failing', { failsPick: true, slow: [addOf(a.q)], during: [{ at: addOf(a.q), pick: 2 }] }],
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
  // (r62: an edit, then Back, during a failing pick -- A1, Q1; a pick during a pick, the second
  // failing -- A2. "During b.stl" is the pick's download only where the start opens another model.)
  if (a.list && embed !== 'poster' && !/(?:^|&)(index=2|src=b\.stl)/.test(a.q)) {
    out.push(['a list pick that fails, an edit then Back during it', { failsPick: true, slow: ['b.stl'], during: [{ at: 'b.stl', hash: true }, { at: 'b.stl', back: true }], after: [{ pick: 2 }] }],
      ['a pick during a pick, the second failing', { failsPick: 'd', slow: ['b.stl'], during: [{ at: 'b.stl', pick: 3 }], after: [{ pick: 2 }] }]);
  }
  // (r60 Q1, Q5: Back while the pick still loads; a pick, Back, then Forward)
  if (a.list && embed !== 'poster') {
    out.push(['Back during the pick\'s load', { slow: ['b.stl'], during: [{ at: 'b.stl', back: true }], after: [{ pick: 2 }] }],
      ['a pick, Back, then Forward', { after: [{ pick: 2 }, { back: true }, { forward: true }] }]);
  }
  // (r64 Q3: a reload keeps the history, and the entries before it are another page's)
  out.push(['a reload', { after: [{ reload: true }] }]);
  if (a.list && embed !== 'poster') {
    out.push(['a list pick, a reload, then Back', { after: [{ pick: 2 }, { reload: true }, { back: true }] }],
      ['a list pick, a reload, Back, then Forward', { after: [{ pick: 2 }, { reload: true }, { back: true }, { forward: true }] }],
      ['a list pick, Back, a reload, then Forward', { after: [{ pick: 2 }, { back: true }, { reload: true }, { forward: true }] }],
      // (a pick on the reloaded page: its chain must not read the page before's marks on its entry)
      ['a list pick, a reload, then a list pick that fails', { failsPick: 'd', after: [{ pick: 2 }, { reload: true }, { pick: 3 }] }],
      // (an edit during it takes its marks from the reloaded entry: the page before's pick depth
      // there sent the take-back one step too far)
      ['a list pick, a reload, then a list pick that fails, an edit during it', { failsPick: 'd', slow: ['d.stl'], duringNext: [{ at: 'd.stl', hash: true }], after: [{ pick: 2 }, { reload: true }, { pick: 3 }] }],
      // (r65 Q5: the pick's model failing after the reload, picked again -- the new page's first
      // chain, whose number the page before's marks on that entry carry)
      ['a list pick, a reload, the pick\'s model now failing, picked again', { failsNext: ['b.stl'], after: [{ pick: 2 }, { reload: true }, { pick: 2 }] }]);
  }
  // (r62 Q2: "this file is in" inches once the model shows; Q4: a drop, a pick, then Back)
  out.push(['this file is in inches, after', { after: [{ unit: 'in' }] }]);
  if (a.list && embed !== 'poster') {
    out.push(['a drop, a list pick, then Back', { after: [{ file: 'v.stl' }, { pick: 2 }, { back: true }] }],
      // (r63: an edit, a pick, then Back -- the edited first entry still the first, A1, Q3; inches, a
      // pick, then Back -- the unit kept, A2; a drop then a failing pick -- the file kept, Q2; a drop,
      // a pick, Back during it -- the pick ended, Q4)
      ['a #view= edit, a list pick, then Back', { after: [{ hash: true }, { pick: 2 }, { back: true }] }],
      ['this file is in inches, a list pick, then Back', { after: [{ unit: 'in' }, { pick: 2 }, { back: true }] }],
      ['a drop, then a list pick that fails', { failsPick: true, after: [{ file: 'v.stl' }, { pick: 2 }] }]);
    // ("during b.stl" is the pick's download only where the start opens another model)
    if (!/(?:^|&)(index=2|src=b\.stl)/.test(a.q)) {
      out.push(['a drop, a list pick, Back during it', { slow: ['b.stl'], during: [{ at: 'b.stl', back: true }], after: [{ file: 'v.stl' }, { pick: 2 }] }],
        // (the visitor's file shown first: the address then names no model at all -- r63 Q4)
        ['a drop during the model, a list pick, Back during it', { slow: ['b.stl'], during: [{ at: 'model', file: 'v.stl' }, { at: 'b.stl', back: true }], after: [{ pick: 2 }] }]);
    }
  }
  // (r64 A4: "this file is in" while something else loads -- a slow ?add=, a list pick, a dropped
  // file: the wait for the adds, and a re-read begun over a load, never ran)
  if (addOf(a.q) && embed !== 'poster') out.push(['this file is in inches, during a slow ?add=', { slow: [addOf(a.q)], during: [{ at: addOf(a.q), unit: 'in' }] }]);
  if (a.list && embed !== 'poster' && !/(?:^|&)(index=2|src=b\.stl)/.test(a.q)) {
    out.push(['this file is in inches, during a list pick', { slow: ['b.stl'], during: [{ at: 'b.stl', unit: 'in' }], after: [{ pick: 2 }] }]);
  }
  out.push(['this file is in inches, during a dropped file', { slow: ['v.stl'], during: [{ at: 'v.stl', unit: 'in' }], after: [{ file: 'v.stl' }] }]);
  // (r66 A2, Q1, Q4: a second choice of "this file is in" -- back to mm during the inches re-read;
  // two while the ?add=s wait -- the last one chosen is what the model is read in)
  // (the second choice in the same task as the first, its re-read just begun: a moment the page can be
  // acted at too -- a re-read asks for nothing, and ui-diff never saw a "reread" moment: r66)
  out.push(['this file is in inches, then mm during its re-read', { after: [{ unit: 'in', andThen: 'mm' }] }]);
  // (r67 Q3: inches, then Cancel during the re-read -- the select must say the reading again)
  out.push(['this file is in inches, then Cancel during its re-read', { after: [{ unit: 'in', thenCancel: true }] }]);
  if (addOf(a.q) && a.lateList) out.push(['this file is in inches then mm, once the model shows', { during: [{ at: `loaded ${firstOfAddress({ addr: a })}`, unit: 'in' }, { at: `loaded ${firstOfAddress({ addr: a })}`, unit: 'mm' }] }]);
  // (r65 Q6: once the model shows, its ?add= still waiting -- for a late list. Only there: with the
  // list in, the add starts at once, and in the page the act came after it joined -- the
  // differential, r65)
  if (addOf(a.q) && a.lateList) out.push(['this file is in inches, once the model shows', { during: [{ at: `loaded ${firstOfAddress({ addr: a })}`, unit: 'in' }] }]);
  // (r63 A1: during a slow ?add=, an edit, then a pick that fails -- the edited first entry's adds put back)
  if (a.list && addOf(a.q) && embed !== 'poster') out.push(['during a slow ?add=, an edit, then a pick that fails', { failsPick: true, slow: [addOf(a.q)], during: [{ at: addOf(a.q), hash: true }, { at: addOf(a.q), pick: 2 }] }]);
  // (r63 Q1: the start's model failing, picked again, Back during the retry -- on an address spelled
  // as the page writes its own links)
  if (a.pageSpelled) out.push(['the start\'s model failing, picked again, Back during it', { slow: ['b.stl'], during: [{ at: 'b.stl#2', back: true }], after: [{ pick: 2 }] }]);
  // (a #view= edit while the model loads, and while the list is read: popstate then hashchange -- r59 Q2)
  out.push(['a #view= edit during the model', { during: [{ at: 'model', hash: true }] }]);
  if (a.list) out.push(['a #view= edit during the list', { during: [{ at: LP, hash: true }] }]);
  // (two acts: the visitor's file during the tour's read, then Add model… once it shows -- the tour's
  // own model opened over both under a mutant one act never reaches: r57 Q7 m6)
  if ('tour' in a) out.push(['a drop during the tour, then Add model…', { slow: ['t.json'], during: [{ at: 't.json', file: 'v.stl' }, { at: 'loaded v.stl', add: 'e.stl' }] }]);
  out.push(['a #view= edit after', { after: [{ hash: true }] }]);
  if (embed === 'poster') out.push(['View in 3D, then a #view= edit', { after: [{ click: true }, { hash: true }] }]);
  // (r71 Q4: "this file is in" inches while the list entry's own tour is read, the re-read quick and
  // slow -- which answer came first decided whether the tour played)
  if (a.list && !('tour' in a) && embed !== 'poster' && !/(?:^|&)(index=2|src=b\.stl)/.test(a.q)) {
    out.push(['this file is in inches, during the entry\'s tour read', { slow: ['lists/at.json'], during: [{ at: 'lists/at.json', unit: 'in' }] }],
      ['this file is in inches, during the entry\'s tour read, the re-read slow', { slow: ['lists/at.json', 'a.stl'], during: [{ at: 'lists/at.json', unit: 'in' }] }],
      // (and an Add model… then: the tour started, and the model joining ended it, or played after it
      // -- the differential's src+late list run, r71)
      ['Add model… during the entry\'s tour read', { slow: ['lists/at.json'], during: [{ at: 'lists/at.json', add: 'e.stl' }] }],
      ['Add model… during the entry\'s tour read, the model slow', { slow: ['lists/at.json', 'e.stl'], during: [{ at: 'lists/at.json', add: 'e.stl' }] }]);
  }
  return out;
}

// the model the address's start opens first, by name (as caseOf's firstModel)
function firstOfAddress(c) {
  const q = c.addr.q;
  return /src=a\.stl/.test(q) ? 'a.stl' : c.addr.tour && !/src=/.test(q) ? 'c.stl' : /(index=2|src=b\.stl)/.test(q) ? 'b.stl' : 'a.stl';
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
  const files = a.list ? [`${listAt}a.stl`, `${listAt}b.stl`, `${listAt}d.stl`, `${tourAt}c.stl`, 'x.stl'] : ['a.stl', 'b.stl', `${tourAt}c.stl`, 'x.stl'];
  if (a.lateList) files.push('lists/a.stl'); // (its ?src= a URL of its own, wherever the list answers)
  // the model that fails: the one the start would open first
  const firstModel = /src=a\.stl/.test(a.q) ? 'a.stl' : a.tour && !/src=/.test(a.q) ? 'c.stl' : /(index=2|src=b\.stl)/.test(a.q) ? 'b.stl' : 'a.stl';
  // (a list answering after its model: read slowly)
  const slow = [...(actC.slow || []), ...(a.lateList ? [LP] : [])];
  // (a pick that fails: the entry it picks, b.stl, not found)
  const fails = [...(o.failsFirst ? [firstModel] : []), ...(actC.failsPick ? [actC.failsPick === 'd' ? 'd.stl' : 'b.stl'] : [])];
  return { q: embedQ + a.q, hash: a.hash, serve, redirect, files, ...actC, fails, slow };
}

// The invariants, each a check of one run: a list of [invariant, what was seen] when broken
const visitorFiles = new Set(['v.stl', 'e.stl']);
function check(c0, r) {
  // (a run that reloaded: the last page's own start and acts -- runStart)
  const c = r.pageCase || c0;
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
    // (every entry the visitor picked; and a failed pick's take-back, which reopens the page as first
    // opened with its ?add=s -- the restoring rule, r62 Q3)
    const picked = acts.filter((d) => d.pick).map((d) => ['a.stl', 'b.stl', 'd.stl'][d.pick - 1]);
    // (the take-back's reopen, over the first model only: never over the visitor's file -- r63 Q2)
    const own = (u) => visitorFiles.has(u.split('/').pop()) || picked.includes(u.split('/').pop()) || acts.some((d) => d.back) || (!!c.failsPick && !acts.some((d) => d.file));
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
    // (an ?add= that goes on loading after Back is the start's, not Back's own load)
    const loadsAfter = r.events.slice(backAt + 1).filter((e) => e.startsWith('load ')).map((e) => e.slice(5)).filter((f) => !new URLSearchParams(c.q).getAll('add').includes(f));
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
    const namedF = idx === '1' ? 'a.stl' : idx === '2' ? 'b.stl' : idx === '3' ? 'd.stl' : ''; // (r63 Q10)
    if (idx && shownF !== namedF && !(c.fails || []).includes(namedF)) v('I19', `the address names entry ${idx}, ${shownF} shown`);
    // (Back onto an entry naming no model -- the visitor's own file shown first -- while the pick
    // downloads: the pick ends, never shown under it -- r63 Q4)
    const backAt2 = r.events.lastIndexOf('back');
    if (!idx && !hq.get('src') && !hq.get('model') && !r.app.addressUrl && backAt2 > r.events.indexOf('pick')
      && r.events.slice(backAt2 + 1).includes(`shown ${shownF}`) && ['b.stl', 'd.stl'].includes(shownF)) v('I19', `the pick's ${shownF} shown after Back onto an entry naming no model`);
    if (!idx && !hq.get('src') && !hq.get('model') && r.app.addressUrl && shownF !== String(r.app.addressUrl).split('/').pop()) v('I19', `the address names the page as first opened (${String(r.app.addressUrl).split('/').pop()}), ${shownF} shown`);
  }
  // (and the entry's hidden parts laid once per open, not again by a later rule run: r60 Q6 H)
  // (a re-read in another unit is no open: it keeps the visitor's hidden parts, which it lays again -- r64 A4)
  const opens = r.events.map((e, i) => [e, i]).filter(([e]) => e.startsWith('load ') || e.startsWith('reread ')).map(([, i]) => i);
  opens.forEach((i, k) => {
    const seg = r.events.slice(i, opens[k + 1] ?? r.events.length);
    if (seg.filter((e) => e === 'hide').length > 1) v('I15', `the entry's hidden parts laid ${seg.filter((e) => e === 'hide').length} times in one open`);
  });
  // I20: a pick that failed leaves no entry of its own in the history -- Back from an edit made during
  // its download, or Forward, opened it again (r61 A2, Q3)
  const failedIdx = c.failsPick === 'd' ? '3' : '2';
  const idxF = (h) => new URL(h).searchParams.get('index') === failedIdx;
  if (c.failsPick && r.events.includes('pick') && r.stack && !idxF(r.stack[0]) && r.stack.some(idxF)) {
    v('I20', `the failed pick's entry left in the history: ${(r.stack || []).map((h) => new URL(h).search).join(' | ')}`);
  }
  // (and, with no step of the visitor's own after it failed, the history as it was before the pick:
  // the entries to the one shown the same, those ahead copies of it -- the take-back stepped one too
  // many, off the page: r62 A1, Q1, Q8)
  const sp = (h) => { const u = new URL(h); return u.search + u.hash; };
  if (c.failsPick && r.pickSnap && !r.left && !(c.after || []).some((d) => d.back || d.forward)) {
    const now = r.stack.slice(0, r.at + 1).map(sp), was = r.pickSnap.stack.slice(0, r.pickSnap.at + 1).map(sp);
    const ahead = r.stack.slice(r.at + 1).map(sp);
    if (JSON.stringify(now) !== JSON.stringify(was) || ahead.some((h) => h !== now[now.length - 1])) {
      v('I20', `the history after the failed pick ${JSON.stringify(r.stack.map(sp))} at ${r.at}, before it ${JSON.stringify(r.pickSnap.stack.map(sp))} at ${r.pickSnap.at}`);
    }
  }
  // I21: the page leaves only by the visitor's own Back from its first entry -- a take-back left it,
  // and every invariant passed a page that was gone (r62 Q7)
  if (r.left && r.leftBy !== 'visitor') v('I21', `the page left by itself (${r.events.join(' > ')})`);
  // I22: the scene's models the address's ?add=s name are there exactly when the address at the end
  // names them -- Back after a device file opened the adds under an address naming none (r62 Q4)
  const endAdds = r.href ? new URL(r.href).searchParams.getAll('add') : [];
  const sceneNames = (r.app.scene || []).map((m) => String(m.url).split('/').pop());
  for (const f of qp.getAll('add')) {
    if (!r.left && sceneNames.includes(f) && !endAdds.includes(f) && !acts.some((d) => d.add === f)) v('I22', `${f} in the scene, the address names no ?add= of it: ${r.href}`);
  }
  // (and the other way: an ?add= the address at the end names is in the scene, unless the visitor
  // cancelled it, opened something of their own, or its model failed -- a failed pick during the
  // ?add= left it cancelled under an address naming it: r62 Q3)
  const quiet = !r.left && r.status !== 'loading' && !acts.some((d) => d.cancel || d.file || d.click) && !(c.fails || []).some((f) => f !== (c.failsPick === 'd' ? 'd.stl' : 'b.stl')) && r.app.scene;
  if (quiet && r.app.sourceUrl && String(r.app.sourceUrl).split('/').pop() === firstOfAddress(c) && !(c.fails || []).some((f) => qp.getAll('add').includes(f))) {
    for (const f of endAdds) if (!sceneNames.includes(f)) v('I22', `the address names ?add=${f}, the scene ${JSON.stringify(sceneNames)}`);
  }
  // (nor does a failed pick open again a scene that was whole when it was made: the take-back's
  // reopen is for adds the pick cancelled -- its guard was untested, r63 Q8)
  if (c.failsPick && qp.getAll('add').length) {
    const pickAt3 = r.events.indexOf('pick');
    const addedBefore = r.events.slice(0, pickAt3).filter((e) => e === 'added').length;
    const failedAt = r.events.indexOf(`load ${c.failsPick === 'd' ? 'd.stl' : 'b.stl'}`, pickAt3);
    if (pickAt3 >= 0 && failedAt >= 0 && addedBefore >= qp.getAll('add').length && r.events.slice(failedAt + 1).includes(`load ${firstOfAddress(c)}`)) {
      v('I22', `a failed pick opened again a scene that was whole (${r.events.join(' > ')})`);
    }
  }
  // I27: the last unit chosen is the reading, when every act was a unit choice and one model, read
  // from its bytes, is shown (a choice back to mm during the inches re-read was nothing: r66 A2)
  if (acts.length && acts.every((d) => d.unit && !d.thenCancel) && r.status === 'ready' && r.app.meshSource && (r.app.scene || []).length === 1) {
    const last = acts[acts.length - 1].andThen || acts[acts.length - 1].unit;
    if (r.unitRead !== last) v('I27', `the last unit chosen ${last}, the model read in ${r.unitRead}`);
  }
  // (and the re-read ends the tour, as setMeshUnit ends it: a tour started before it, none after)
  {
    const ev = r.events, rr = ev.findIndex((e) => e.startsWith('reread '));
    if (rr >= 0 && ev.slice(0, rr).some((e) => e.startsWith('tour ')) && !ev.slice(rr).some((e) => e === 'tour-end' || e.startsWith('tour ') || e.startsWith('shown '))
      && !ev.slice(0, rr).some((e) => e === 'tour-end')) v('I27', `a tour left playing over the re-read (${ev.join(' > ')})`);
  }
  // I28: the units row says what the model is read in, once settled
  if (r.app.meshSource && !['loading', 'tessellating'].includes(r.status) && r.dom.meshunit.value && r.dom.meshunit.value !== r.app.meshSource.unit) {
    v('I28', `the units row says ${r.dom.meshunit.value}, the model read in ${r.app.meshSource.unit}`);
  }
  // I26: the start's tour, failing after a pick left its address, is not the picked model's line
  if (qp.get('tour') && !new URL(r.href).searchParams.get('tour') && r.status === 'ready' && /the tour (not found|gave no answer)/.test(r.msg || '')) {
    v('I26', `the start's tour's failure in the ready line of an address naming no tour: ${r.msg}`);
  }
  // (and told: the line's half alone passed a page that said nothing -- r67 A2)
  // (when the visitor left during the start, before the tour's answer; one made after, the failure
  // was said on the card or the line before it)
  if (qp.get('tour') && /^tour (fails|times out)/.test(c.outcome) && [].concat(c.during || []).some((d) => d.pick || d.file || d.early) && !new URL(r.href).searchParams.get('tour') && r.status === 'ready'
    && !/the tour (not found|gave no answer)/.test(r.msg || '') && !r.shown.some((t) => /^the tour (not found|gave no answer)/.test(t))) {
    v('I26', `the start's tour failed, the visitor elsewhere, and nothing said: ${JSON.stringify(r.shown)}`);
  }
  // I25: "this file is in" chosen while another model opens is refused, and said so
  if (r.events.includes('unit while another opens') && !r.shown.some((t) => /^not read in inches: another model is opening$/.test(t))) {
    v('I25', `"this file is in" while another model opened, no refusal told: ${JSON.stringify(r.shown)}`);
  }
  // (and chosen while the ?add=s wait: once they join, a scene has no unit to choose -- said: r65 Q9)
  if (r.events.includes('unit while adds wait') && (r.app.scene || []).length > 1 && !r.shown.some((t) => /^not read in inches: models were added beside it$/.test(t))) {
    v('I25', `"this file is in" while the ?add=s waited, the scene made, nothing told: ${JSON.stringify(r.shown)}`);
  }
  // I24: after a reload, the model shown is the one the address shown opens fresh -- its ?src, its
  // ?index, else a tour's own model, else the list's first (unless that one fails, as I19)
  // (and on a failed end, the model whose failure is shown: the take-back went past it, the address
  // naming the list's first under the pick's failure -- r65 Q5)
  // (only where the failure is all that is shown -- the card, no model: a failed pick leaves the
  // model before it shown, which the address names)
  const failedF = r.status === 'error' && r.card && r.card[0] && !r.app.header ? ((r.msg || '').match(/could not download (\S+):/) || [])[1] : null;
  if ([].concat(c0.after || []).some((d) => d.reload) && ((r.status === 'ready' && r.app.sourceUrl) || failedF) && !r.left) {
    const hq = new URL(r.href).searchParams;
    const fresh = hq.get('src') ? decodeURIComponent(hq.get('src')).split('/').pop() : hq.get('index') ? ['a.stl', 'b.stl', 'd.stl'][+hq.get('index') - 1]
      : hq.get('model') ? null : hq.get('tour') && c.addr.tour && !/^tour (fails|times out)/.test(c.outcome) ? c.addr.tour : hq.get('list') ? 'a.stl' : null;
    const shownF = failedF ? failedF.split('/').pop() : String(r.app.sourceUrl).split('/').pop();
    // (unless the address's own model fails, as I19: a pick from a start that failed shows its own failure)
    if (fresh && shownF !== fresh && !(c.fails || []).includes(fresh)) v('I24', `after a reload ${failedF ? `${shownF}'s failure` : shownF} shown, the address ${r.href} opens ${fresh}`);
  }
  // I23: "this file is in" puts ?unit= beside the model it is for: a reload opens that model in that
  // unit (written beside an address naming no model, a reload ignored it and dropped it: r62 Q2)
  if (acts.some((d) => d.unit) && r.app.sourceUrl && !r.left) {
    const hq = new URL(r.href).searchParams;
    // (the model it is beside resolving to the model shown: beside ?model=nope a reload still
    // dropped it -- r63 Q7)
    const resolved = hq.get('index') ? ['a.stl', 'b.stl', 'd.stl'][+hq.get('index') - 1] : hq.get('src') ? hq.get('src').split('/').pop() : null;
    const shownU = String(r.app.sourceUrl).split('/').pop();
    // (unless the model it names will not open, as I19)
    // (nor the start's own address, a ?unit= typed with no model named: the visitor's, not written)
    const typed = !resolved && qp.get('unit') && !qp.get('index') && !qp.get('src') && !qp.get('model');
    if (hq.get('unit') && resolved !== shownU && !(c.fails || []).includes(resolved) && !typed) v('I23', `?unit= beside an address naming ${resolved || 'no model it has'}, ${shownU} shown: ${r.href}`);
  }
  // (and the other way: a model alone, from a URL, read in a unit not mm has that ?unit= in the
  // address, so a reload opens it so -- syncUnitParam beside the model the address names, r64 A4)
  if (r.status === 'ready' && !r.left && r.app.sourceUrl && (r.app.scene || []).length === 1 && r.unitRead && r.unitRead !== 'mm'
    && new URL(r.href).searchParams.get('unit') !== r.unitRead) {
    v('I23', `${String(r.app.sourceUrl).split('/').pop()} read in ${r.unitRead}, the address's ?unit= ${new URL(r.href).searchParams.get('unit') || 'none'}: ${r.href}`);
  }
  // (and Back to the page as first opened keeps the unit the visitor chose there -- the start's
  // address put back lost it: r63 A2)
  // (not on a page that opens as a scene -- ?add= --: a scene has no "this file is in", the
  // harness's copy wrote one there: r64 A4)
  if (acts.some((d) => d.unit) && acts.some((d) => d.back) && !r.left && r.status === 'ready' && r.app.sourceUrl && !qp.get('add')
    && String(r.app.sourceUrl).split('/').pop() === firstOfAddress(c) && !new URL(r.href).searchParams.get('unit')) {
    v('I23', `Back to the page as first opened dropped the visitor's ?unit=: ${r.href}`);
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
    // (to the next model shown, or the next re-read of this one: it ends the tour, and keeps the visitor's hidden parts)
    const nextShown = ev.findIndex((x, j) => j > i && (x.startsWith('shown ') || x.startsWith('reread ')));
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
    // (and a re-read chosen while its tour was read: the tour plays once it lands, not dropped or
    // played by which of the two answers came first -- r71 Q4. The cut at the next "reread" above
    // exempted every such run)
    const rr = ev.indexOf(`reread ${f}`, i + 1);
    if (rr >= 0 && acts.some((d) => d.unit && String(d.at).endsWith(`/${f[0]}t.json`)) && pending === false && viewAt < 0 && !acts.some((d) => d.hash)
      && !ev.slice(i + 1, rr).some((x) => x.startsWith('shown ')) && !ev.slice(rr + 1).includes(own)) {
      v('I15', `${own} never played after the re-read chosen during its read (${ev.join(' > ')})`);
    }
    // (an Add model… chosen while its tour was read: the tour plays once the model joins, not ended
    // by it -- r71, the differential)
    const ad = ev.indexOf('added', i + 1);
    if (ad >= 0 && acts.some((d) => d.add && String(d.at).endsWith(`/${f[0]}t.json`)) && pending === false && viewAt < 0 && !acts.some((d) => d.hash)
      && !ev.slice(i + 1, ad).some((x) => x.startsWith('shown ') || x.startsWith('reread ')) && !ev.slice(ad + 1).includes(own)) {
      v('I15', `${own} never played after the Add model… chosen during its read (${ev.join(' > ')})`);
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
  // (the history's entries, each its address's search and fragment, and the one shown: r62 A3, Q6)
  const hist = { stack: (r.stack || []).map((h) => { const u = new URL(h); const s = u.searchParams; s.delete('backend'); return `${s.toString()}${u.hash}`; }), at: r.at };
  const base = (u) => String(u || '').split('/').pop();
  const ev = r.events;
  // (the scene's last change: a model shown, or one joining it -- each ends the tour and sets the view)
  // (a re-read in another unit too: the model shown again, at its preset view -- r66)
  const lastShown = ev.map((e) => e.startsWith('shown ') || e.startsWith('reshown ') || e === 'added').lastIndexOf(true);
  const after = ev.slice(lastShown + 1);
  const view = after.filter((e) => e.startsWith('view ')).pop();
  // (a tour ended since -- a re-read ends it: r63 Q6 -- is no tour)
  const tourAt = after.map((e) => e.startsWith('tour ')).lastIndexOf(true);
  const tour = tourAt >= 0 && !after.slice(tourAt + 1).includes('tour-end') ? after[tourAt] : undefined;
  // (in its own order: a parameter moved is a difference -- r61 A3, A1)
  const q = new URL(r.href).searchParams;
  q.delete('backend');
  return {
    status: r.status, msg: r.msg, card: r.card, told: r.shown,
    scene: (r.app.scene || []).map((m) => base(m.url)), address: q.toString(), hash: new URL(r.href).hash.replace(/^#view=/, ''),
    view: view ? view.slice(5) : null, tour: tour ? tour.slice(5) : null, poster: r.posterUp, entries: r.entries, history: hist,
    // (a take-back left waiting, or a chain left open: the stuck state an end state did not show, r63 Q11)
    stuck: { skipPop: !!r.app.skipPop, chain: !!r.app.pickChain },
    // (the unit the model shown was read in, a model alone -- r64 Q5)
    unit: (r.app.scene || []).length === 1 ? r.unitRead || 'mm' : null,
    // (the units row's select, while it is shown: it said inches over a model in mm -- r67 Q3, Q4)
    meshUnit: r.app.meshSource ? r.dom.meshunit.value || null : null,
  };
}

// --export <file> [--names <file>]: a sample of the sweep for tests/ui-diff.py -- every act at every
// moment once, every address and embed mode once, then every run named in <file> (one name a line,
// as --list prints them) -- each with the harness's end state; written, and no test run.
const exportAt = process.argv.indexOf('--export');
if (exportAt > 0) {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const namesAt = process.argv.indexOf('--names');
  // (a "#" line is a comment: tests/ui-diff-pinned.txt's header)
  const wanted = namesAt > 0 ? new Set(readFileSync(process.argv[namesAt + 1], 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))) : new Set();
  const seen = new Set(), pick = [];
  const take = (key, item) => { if (!seen.has(key)) { seen.add(key); pick.push(item); } };
  const parts = (n) => n.split(' | ');
  // (each act on an address it can act on: a pick needs a list, an ?add= act an ?add=, "this file is
  // in" a list (where it names the model) -- the first address that had the act took it, and a pick
  // on an address with no list ran nothing in the page: r63 A4)
  const fits = (act, addr) => (!/pick/.test(act) || addr.list) && (!/\?add=/.test(act) || addOf(addr.q)) && (!/inches/.test(act) || addr.list);
  for (const item of cases) { const [, , , act] = parts(item[0]); if (fits(act, item[1].addr)) take(`act ${act}`, item); }
  for (const item of cases) { const [addr, embed] = parts(item[0]); take(`addr ${addr}`, item); take(`embed ${embed}`, item); }
  for (const item of cases) if (wanted.has(item[0])) take(`name ${item[0]}`, item);
  // (a name given that is no run now -- an act renamed -- is said, not dropped in silence)
  const runNames = new Set(cases.map(([n]) => n));
  const gone = [...wanted].filter((n) => !n.startsWith('#') && !runNames.has(n));
  if (wanted.size) console.log(`NAMES ${wanted.size} given, ${gone.length} no run now${gone.length ? `: ${gone.slice(0, 20).join(' ; ')}` : ''}`);
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

// (--pin <names file>...: the runs named added to tests/ui-diff-pinned.txt, the sample every round's
// differential runs whole -- the runs that differed in any round and the rounds' samples, so the
// sample only grows and its counts compare round to round: r65. A name that is no run now refused.)
const pinAt = process.argv.indexOf('--pin');
if (pinAt > 0) {
  const { readFileSync, writeFileSync, existsSync } = await import('node:fs');
  const file = new URL('./ui-diff-pinned.txt', import.meta.url);
  const was = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const have = new Set(was.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')));
  const runNames = new Set(cases.map(([n]) => n));
  const add = process.argv.slice(pinAt + 1).filter((a) => !a.startsWith('--'))
    .flatMap((f) => readFileSync(f, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')));
  const gone = add.filter((n) => !runNames.has(n));
  if (gone.length) { console.log(`PIN refused: ${gone.length} names are no run now: ${gone.slice(0, 10).join(' ; ')}`); process.exit(2); }
  const fresh = [...new Set(add)].filter((n) => !have.has(n));
  writeFileSync(file, `${was}${was && !was.endsWith('\n') ? '\n' : ''}${fresh.map((n) => `${n}\n`).join('')}`);
  console.log(`PIN ${fresh.length} added, ${have.size + fresh.length} pinned`);
  process.exit(0);
}

// (--one <name>: one run, its events, history and violations, to read a finding by)
const oneAt = process.argv.indexOf('--one');
if (oneAt > 0) {
  const item = cases.find(([n]) => n === process.argv[oneAt + 1]);
  if (!item) { console.log(`no run named ${process.argv[oneAt + 1]}`); process.exit(2); }
  const r = await runStart(item[1]);
  console.log(JSON.stringify({ events: r.events, href: r.href, stack: r.stack, at: r.at, status: r.status, msg: r.msg, unitRead: r.unitRead, threw: r.threw, violations: check(item[1], r) }, null, 1));
  process.exit(0);
}

// (the invariants' range from this file's own header, not written in the title: it went stale three
// times -- r67 A9)
const lastInvariant = Math.max(...[...readFileSync(new URL(import.meta.url), 'utf8').matchAll(/^\/\/\s+I(\d+) /gm)].map((m) => +m[1]));
await test(`the start-up sweep: ${cases.length} runs of main.js's own start, each against the invariants I1-I${lastInvariant}`, async () => {
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
