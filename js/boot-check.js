// Whether the app started, said on the page when it did not. A classic script, loaded in the head
// before the modules, so it is listening before any of them is fetched. The app is ES modules: when
// one of them cannot be downloaded -- the network changed or dropped while the page loaded
// (Chromium aborts every request then, net::ERR_NETWORK_CHANGED) -- main.js never runs, and the
// page stayed on its shell, "loading", with nothing to say why and nothing to press (r72: seen
// twice in the differential, 1 in 316 tries of one run; the evidence a run keeps showed the
// modules' requests failing at 170 ms).
//
// Once the page has loaded (module scripts run or failed by then), no app (window.__cadv, which
// main.js sets as it starts) is a page that did not start: it says so, with the files that failed,
// and a Reload button. Nothing is retried on its own.
(function () {
  var failed = [], thrown = null;
  // (a script or a preloaded module that could not be fetched: its error event, caught on the way
  // down, as it does not bubble; and an error the code threw as it ran -- main.js stopping at its top
  // level was said as a download that failed: r73)
  window.addEventListener('error', function (e) {
    var t = e.target;
    if ((!t || t === window) && !thrown) thrown = e.message || String(e.error || 'an error');
    // (each file once: a module's preload and its script fail alike)
    var f = t && t !== window && (t.tagName === 'SCRIPT' || t.tagName === 'LINK') ? (t.src || t.href || '').split('/').pop() : '';
    if (f && failed.indexOf(f) < 0) failed.push(f);
  }, true);
  window.addEventListener('load', function () {
    if (window.__cadv) return;
    var d = document.createElement('div');
    d.id = 'bootfail';
    d.className = 'card';
    d.setAttribute('role', 'alert');
    var h = document.createElement('h2');
    h.textContent = 'cad.place did not start';
    var p = document.createElement('p');
    // (a file not loaded -- not downloaded, or not served as a script -- or else the error it stopped
    // with, in its own words)
    p.textContent = failed.length || !thrown
      ? 'A part of the viewer could not be loaded' + (failed.length ? ' (' + failed.slice(0, 3).join(', ') + (failed.length > 3 ? ', …' : '') + ')' : '') + ': the connection may have changed or dropped while the page loaded. Reloading usually fixes it.'
      : 'The viewer stopped as it started: ' + thrown + '. Reloading may fix it.';
    var b = document.createElement('button');
    b.className = 'primary';
    b.textContent = 'Reload';
    b.addEventListener('click', function () { location.reload(); });
    d.appendChild(h); d.appendChild(p); d.appendChild(b);
    (document.getElementById('stage') || document.body).appendChild(d); // (#stage: where the cards are drawn)
  });
}());
