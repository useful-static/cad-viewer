// The page's first module (index.html loads it before main.js): it starts the downloads the
// address names -- its ?list=, and the model it opens -- while main.js's modules arrive and the GPU
// starts, and hands them to main.js through js/early-fetch.js. On a 3G link the model's download
// began only at 20 s, after every module and the GPU; its URL is known as soon as the list is read,
// or at once for a full-URL ?src=. Which model the address names, and whether a poster holds it
// back, are js/model-list.js modelUrlFrom / modelNameFrom / posterAsked: the rules main.js reads the
// address by. A tour's own model is not fetched here (the tour must be read first: main.js opens it).

import { fetchModelLists, modelNameFrom, modelUrlFrom, posterAsked, timedFetch } from './model-list.js';
import { directFor } from './open-url.js';
import { setEarlyLists, startEarly } from './early-fetch.js';

const params = new URLSearchParams(location.search);
const lists = params.getAll('list');
const poster = posterAsked(params);
// the model the address opens, as main.js will ask for it (loadUrl: a share page's file, directFor)
const fetchModel = (url) => { if (url && !poster) startEarly(directFor(url).url); };
const src = params.get('src');

if (lists.length) {
  const read = fetchModelLists(lists, location.href, timedFetch);
  setEarlyLists(lists, read);
  // (what the address names by the list: main.js's own test, modelNameFrom -- this module kept its
  // own, and an empty ?model= beside a ?tour= fetched the list's first for no one: r54 A4)
  const place = modelNameFrom(params, lists);
  if (src && !place) {
    // a full-URL ?src= beside a list: not a name the list must be read for, fetched at once (it was
    // fetched after the list, when main.js had asked for it already: two downloads -- r53 A1)
    fetchModel(src);
  } else {
    // the model a name gives, or the list's first (for a name the list lacks); with nothing named,
    // the list's first where main.js opens it -- not beside a ?tour=, whose own model opens first
    // (a name the list lacks, beside a ?tour=: the tour's own model opens, not the list's first --
    // the start-up's one order, r55 A4)
    const first = (r) => (params.get('tour') ? null : r.entries[0]?.url);
    read.then((r) => { fetchModel(place ? modelUrlFrom(params, lists, r.entries, location.href) || first(r) : first(r)); },
      () => { /* a read that failed outright: main.js reads the lists itself (readLists) */ });
  }
} else {
  fetchModel(src);
}
