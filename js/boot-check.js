// Whether the page's app started, said on the page when it did not. A classic script, loaded in the
// head before the modules, so it is listening before any of them is fetched. The app is ES modules:
// when one of them cannot be downloaded -- the network changed or dropped while the page loaded
// (Chromium aborts every request then, net::ERR_NETWORK_CHANGED) -- or stops as it runs, the page
// stayed on its shell, "loading", with nothing to say why and nothing to press (r72: seen in the
// differential; r73: five ways, each tried on the real page).
//
// The sign of a start is a flag the app's module sets as its LAST top-level statement (main.js
// window.__cadvStarted; check.html's js/check-page.js window.__checkStarted): a throw in any
// statement before it is a page that did not start (window.__cadv, set early, missed a throw after
// it: r74 Q7). Two moments are read:
// - the page's load (its module scripts run or failed by then): no start is a page that did not
//   start, said with the files that failed or the error it stopped with, and a Reload button;
// - 20 s on, while the load has not come (a module never answered keeps it from coming, and the
//   page said nothing for good: r74 Q2): that it has not started, with Reload -- taken away if it
//   starts after all, a slow link and no fault.
// Nothing is retried on its own.
// <script src="js/boot-check.js" data-name="…" data-flag="…">: the page's own name and flag
// (default "cad.place", __cadvStarted). check.html loads it too (r74 A4: its owner saw the form and
// nothing else).
(function () {
  var me = document.currentScript || {};
  var ds = me.dataset || {};
  var name = ds.name || 'cad.place', flag = ds.flag || '__cadvStarted';
  var failed = [], thrown = null, card = null;
  var started = function () { return !!window[flag]; };
  // (a script or a preloaded module that could not be fetched: its error event, caught on the way
  // down, as it does not bubble; and an error the code threw as it ran)
  window.addEventListener('error', function (e) {
    var t = e.target;
    if ((!t || t === window) && !thrown) thrown = e.message || String(e.error || 'an error');
    // (each file once: a module's preload and its script fail alike; a script or a module preload
    // only -- an icon or the manifest failing was named in place of the error the page stopped
    // with: r75 Q8)
    var f = t && t !== window && (t.tagName === 'SCRIPT' || (t.tagName === 'LINK' && /modulepreload/i.test(t.rel || ''))) ? (t.src || t.href || '').split('/').pop() : '';
    if (f && failed.indexOf(f) < 0) failed.push(f);
  }, true);
  function say(title, text) {
    if (card) card.remove();
    // (the page's own no-script card, for when this script did not arrive: one card, not two -- r76 Q4)
    var bs = document.getElementById('bootslow');
    if (bs) bs.remove();
    var d = document.createElement('div');
    d.id = 'bootfail';
    d.className = 'card';
    d.setAttribute('role', 'alert');
    var h = document.createElement('h2');
    h.textContent = title;
    var p = document.createElement('p');
    p.textContent = text;
    var b = document.createElement('button');
    b.className = 'primary';
    b.textContent = 'Reload';
    b.addEventListener('click', function () { location.reload(); });
    d.appendChild(h); d.appendChild(p); d.appendChild(b);
    (document.getElementById('stage') || document.body).appendChild(d); // (#stage: where the viewer's cards are drawn)
    card = d;
  }
  var loaded = false, slow = false;
  // (the 20 s card taken away once the page starts, however late: it stayed over a page that had
  // started at 40 s, for good -- r75 Q2)
  var gone = function () { if (card && slow) { card.remove(); card = null; slow = false; } };
  window.addEventListener('load', function () {
    loaded = true;
    if (started()) { gone(); return; }
    // (a file not loaded -- not downloaded, or not served as a script -- or else the error it stopped
    // with, in its own words)
    say(name + ' did not start', failed.length || !thrown
      ? 'A part of it could not be loaded' + (failed.length ? ' (' + failed.slice(0, 3).join(', ') + (failed.length > 3 ? ', …' : '') + ')' : '') + ': the connection may have changed or dropped while the page loaded. Reloading usually fixes it.'
      : 'It stopped as it started: ' + thrown + '. Reloading may fix it.');
    slow = false;
  });
  // (the load not come: said at 20 s, and looked at again every 2 s -- gone once it starts)
  setTimeout(function tick() {
    if (started()) { gone(); return; }
    if (loaded) return;
    if (!card) { say(name + ' has not started', 'A part of it has not arrived after 20 s' + (failed.length ? ' (' + failed.slice(0, 3).join(', ') + ' failed)' : '') + ': the connection may be slow or have stopped. Reload to try again.'); slow = true; }
    setTimeout(tick, 2000);
  }, 20000);
}());
