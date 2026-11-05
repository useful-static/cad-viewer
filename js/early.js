// The page's first module (index.html loads it before main.js): it starts the downloads the
// address names -- its ?list=, and the model it opens -- while main.js's modules arrive and the GPU
// starts, and hands them to main.js through js/early-fetch.js. On a 3G link the model's download
// began only at 20 s, after every module and the GPU; its URL is known as soon as the list is read.
// Which model the address names is js/model-list.js modelUrlFrom, the rule main.js reads it by.
// Behind an embed's poster nothing is fetched: the model loads only with View in 3D.

import { fetchModelLists, modelUrlFrom } from './model-list.js';
import { directFor } from './open-url.js';
import { setEarlyLists, startEarly } from './early-fetch.js';

const params = new URLSearchParams(location.search);
const lists = params.getAll('list');
const poster = params.get('embed') === '1' && !!params.get('poster');
// (as main.js readLists asks for them: the same timeout)
const timed = (u) => fetch(u, typeof AbortSignal.timeout === 'function' ? { signal: AbortSignal.timeout(20000) } : {});
// the model the address opens, as main.js will ask for it (loadUrl: a share page's file, directFor)
const fetchModel = (url) => { if (url && !poster) startEarly(directFor(url).url); };

if (lists.length) {
  const read = fetchModelLists(lists, location.href, timed);
  setEarlyLists(lists, read);
  // (the list's first model where main.js opens it: for a name the list lacks, or with nothing
  // named and no ?tour= -- a tour with its own model opens that one)
  const named = params.has('src') || params.has('model') || params.has('index');
  read.then((r) => { fetchModel(modelUrlFrom(params, lists, r.entries, location.href) || (named || !params.has('tour') ? r.entries[0]?.url : null)); },
    () => { /* main.js reads the lists again and says why */ });
} else {
  fetchModel(params.get('src'));
}
