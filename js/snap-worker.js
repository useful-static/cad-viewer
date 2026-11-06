// The 2D view's snap tree (js/dxf-view.js), built off the page's thread: the points come in, the
// tree's arrays go back, moved, not copied. Built on the page, 1.5 million paths of a drawing at
// hand held it 1.6 s as Measure turned on (round 28 Q7, carried open; rated and fixed in round 67).
//
//   { xy: Float64Array, ids: Uint32Array }  ->  { order, m, P, box, D }  (js/box-tree.js boxTree)

import { boxTree } from './box-tree.js';

self.onmessage = (e) => {
  const { xy, ids } = e.data;
  const t = boxTree(xy, ids, 2, true);
  self.postMessage(t, [t.order.buffer, t.box.buffer]);
};
