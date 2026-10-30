// A share link turned into the file it shares (feature review item 24): the
// page a host shows for a file is HTML, not the file, so ?src= of a GitHub
// "blob" page, a Dropbox ?dl=0 link or a Google Drive file page opened HTML
// and failed. Each is rewritten to the address of the file itself. Anything
// else is left as it is.
//
// Pure ES module, no DOM.

// url: an absolute URL string. Returns { url, from } (from: the host's name
// when it was rewritten, else null).
export function directUrl(url) {
  let u;
  try { u = new URL(url); } catch { return { url, from: null }; }
  // github.com/<owner>/<repo>/blob/<ref>/<path> -> raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>
  if (u.hostname === 'github.com') {
    const m = /^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/.exec(u.pathname);
    if (m) return { url: `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`, from: 'GitHub' };
  }
  // gitlab.com/<group>/<project>/-/blob/<ref>/<path> -> .../-/raw/<ref>/<path>
  if (u.hostname === 'gitlab.com' && /\/-\/blob\//.test(u.pathname)) {
    u.pathname = u.pathname.replace('/-/blob/', '/-/raw/');
    return { url: u.toString(), from: 'GitLab' };
  }
  // Dropbox: the file itself with dl=1 (www.dropbox.com and dropbox.com alike)
  if (/(^|\.)dropbox\.com$/.test(u.hostname) && (u.searchParams.get('dl') === '0' || !u.searchParams.has('dl')) && /^\/(s|scl)\//.test(u.pathname)) {
    u.searchParams.set('dl', '1');
    return { url: u.toString(), from: 'Dropbox' };
  }
  // Google Drive: drive.google.com/file/d/<id>/view -> the download of <id>
  if (u.hostname === 'drive.google.com') {
    const m = /^\/file\/d\/([^/]+)/.exec(u.pathname);
    const id = m ? m[1] : u.pathname === '/open' ? u.searchParams.get('id') : null;
    if (id) return { url: `https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}`, from: 'Google Drive' };
  }
  return { url, from: null };
}
