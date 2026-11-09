// The one argument rule of the command-line tools (stp2mesh, cadmesh-export, dwg-check,
// split-board, set-colours): each had its own parser, and they disagreed -- one took the next
// word as a value whatever it was (`-o --raw` wrote a file named "--raw"), one let a repeated
// option overwrite the first, one took an unknown option as a file name and ignored it.
//
//   parseCli(argv, { values: ['-o', '--to'], flags: ['--raw'], max: 1 })
//     -> { help: true } for -h / --help given as an option (not as an option's value), else
//        { opts: { '-o': 'x', '--raw': true }, pos: ['in.stp'] }
//
// Refused (thrown as a CliError, which the tools print with their usage, exit 2): an option not
// in values or flags; a value option with no value, or with one of the tool's own options (or
// -h) as its value -- another word beginning with "-" is a value ("--orient -z+y"); an option
// given twice; more than `max`
// positional words. `--opt=value` is the same as `--opt value`. A lone "-" is a positional word.
// "--" ends the options: every word after it is positional ("-old.dwg" -- r90 Q4, r91 A4).
//
//   runCli('split-board', main, USAGE)
//     the rule's other half: an input the tool cannot read (main throws an Error) is said in one
//     line on stderr, exit 1 -- not node's stack trace; a usage error, "<tool>: <what>" and the
//     usage, exit 2, in each tool
//
//   await readInput(path), await checkOutput(path, inputs)
//     the input read, and the output checked before the work, in the five tools' one wording;
//     inputs: the files it reads in another format than the output's, which it must not be
//     ("it is the input ...": r92 Q3, r93 A1, A5)
//
//   await writeOutput(path, bytes), gzipsOutput(path, inputGzipped)
//     the one writer of all five tools: whole or not at all (a file beside it, renamed over it),
//     through a link (to a file not there yet too), the file's mode, owner and group kept where
//     the user may keep them; a file with other names written in place from the whole file
//     beside it; a pipe or a device written as it is; and whether a .cadmesh from a .cadmesh is
//     gzipped -- a name ending .gz always (r93 Q1, r94 A1, A3, A4, Q3, r95 A1, A2, A4, A5)
//
// Pure ES module; only runCli touches the process (stderr, exit), when it runs; readInput and
// checkOutput load node:fs when called (the page never calls them).

export class CliError extends Error {}

const isOption = (w) => w.length > 1 && w[0] === '-' && !/^-\d|^-\.\d/.test(w);

export function parseCli(argv, { values = [], flags = [], max = Infinity } = {}) {
  const opts = {}, pos = [];
  const known = (w) => { const k = w.startsWith('--') && w.includes('=') ? w.slice(0, w.indexOf('=')) : w; return k === '-h' || k === '--help' || values.includes(k) || flags.includes(k); };
  for (let i = 0; i < argv.length; i++) {
    let k = argv[i];
    // ("--" ends the options, the POSIX rule: a file "-old.dwg" was "unknown option" -- r90 Q4)
    if (k === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (!isOption(k)) { pos.push(k); continue; }
    if (k === '-h' || k === '--help') return { help: true };
    let v;
    const eq = k.startsWith('--') ? k.indexOf('=') : -1;
    if (eq > 0) { v = k.slice(eq + 1); k = k.slice(0, eq); }
    if (values.includes(k)) {
      if (v === undefined) {
        // (the next word, unless it is one of the tool's own options: "-o --raw" left -o without
        // its value; but "--orient -z+y" and "--skip -old" are values that start with "-")
        v = argv[i + 1];
        if (v === undefined || known(v)) throw new CliError(`${k} needs a value`);
        i++;
      }
      if (v === '') throw new CliError(`${k} needs a value`);
    } else if (flags.includes(k)) {
      if (v !== undefined) throw new CliError(`${k} takes no value`);
      v = true;
    } else throw new CliError(`unknown option ${k}`);
    if (k in opts) throw new CliError(`${k} given twice`);
    opts[k] = v;
  }
  if (pos.length > max) throw new CliError(max === 1 ? `one input file, not ${pos.length}` : `unexpected argument ${pos[max]}`);
  return { opts, pos };
}

// The input a tool reads, or an Error in the tools' one wording: "<path>: no such file" / "not a
// file" (node's "ENOENT: ..." in two tools, both in a third). reason: the words without the path,
// for a tool that names the file itself (dwg-check's rows).
export async function readInput(path) {
  const { readFileSync, statSync } = await import('node:fs');
  let st = null;
  try { st = statSync(path); } catch { /* said below */ }
  if (!st || !st.isFile()) {
    const reason = st ? 'not a file' : 'no such file';
    throw Object.assign(new Error(`${path}: ${reason}`), { reason });
  }
  // (past the viewer's limit, in the page's words: node's own message named no file -- r95 A3)
  const { MAX_FILE_BYTES, OVERSIZE_WORDS } = await import('./cadmesh.js');
  if (st.size > MAX_FILE_BYTES) {
    const reason = OVERSIZE_WORDS;
    throw Object.assign(new Error(`${path}: ${reason}`), { reason });
  }
  return readFileSync(path);
}
// An output a tool will write, checked before the work: its directory there, the path no
// directory (stp2mesh converted, split-board split, before a failed write said so). inputs (asked
// of every caller, so none can leave it out): the files the tool reads that this output must not be
// -- every input in another format than the output's; an input it writes again in its own format
// (split-board's, set-colours' .cadmesh) may be left out, to write in place. An output that is one
// of them is refused, by its device and inode (a link or another spelling is the same file):
// `stp2mesh a.stp -o a.stp` replaced the STEP with a mesh and said OK (r92 Q3), and two tools that
// passed none still did (r93 A1)
export async function checkOutput(path, inputs) {
  if (!Array.isArray(inputs)) throw new TypeError('checkOutput(path, inputs): say which inputs the output must not be');
  const { accessSync, closeSync, constants, statSync, unlinkSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  const st = (p) => { try { return statSync(p); } catch { return null; } };
  const writable = (p) => { try { accessSync(p, constants.W_OK); return true; } catch { return false; } };
  const sameAs = (s) => { for (const i of inputs) { const t = st(i); if (t && t.dev === s.dev && t.ino === s.ino) throw new Error(`could not write ${path}: it is the input ${i}`); } };
  // (a pipe or a device, by the path as given: written as it is -- a FIFO opened here would send its
  // reader an end before the bytes)
  const s0 = st(path);
  if (s0 && s0.isDirectory()) throw new Error(`could not write ${path}: it is a directory`);
  if (s0 && !s0.isFile()) {
    sameAs(s0);
    if (!writable(path)) throw new Error(`could not write ${path}: permission denied`);
    return;
  }
  // (the rest opened as the system opens it, and the file it lands on asked of the open file: r101)
  const o = await openOutput(path);
  try {
    sameAs(o.st);
    // (a writable file in a directory it may not write: refused before the work, since the write
    // goes beside it -- stp2mesh converted it all to fail on a ".tmp" never named: r94 A2)
    if (!writable(dirname(o.real))) throw new Error(`could not write ${path}: permission denied`);
  } finally {
    closeSync(o.fd);
    // (one the check made is taken back: the work may fail, and nothing is left where nothing was)
    if (o.created) { try { unlinkSync(o.real); } catch { /* gone already */ } }
  }
}

// An output opened as the system opens it -- the path as given, no reading of it here: made new
// (O_EXCL), else the file there (no truncation), else through a link to a file not there yet. The
// file it lands on is asked of the open file: its stat (fstat) and its real path (the fd's link in
// /proc; without /proc, the system's realpath of the path, now there). Rounds 95 to 100 each found
// one more way a reading of the path made here, by hand, disagreed with the system's and wrote over
// a file, exit 0; the system's own errors now refuse each (r101, the parent's direction).
async function openOutput(path) {
  const { constants: C, fstatSync, openSync, readlinkSync, realpathSync, lstatSync } = await import('node:fs');
  const { dirname, resolve } = await import('node:path');
  const words = (e) => {
    switch (e.code) {
      case 'ENOENT': {
        // (the directory not there, named: a link's own target's, where the path is a link)
        let d = dirname(path);
        try { if (lstatSync(path).isSymbolicLink()) d = dirname(resolve(dirname(path), readlinkSync(path))); } catch { /* the path's */ }
        return `no such directory ${d}`;
      }
      case 'ENOTDIR': return 'a name in it is not a directory';
      case 'EISDIR': return 'it is a directory';
      case 'EACCES': case 'EPERM': case 'EROFS': return 'permission denied';
      case 'ELOOP': return 'too many links';
      default: return e.message;
    }
  };
  let fd, created = false;
  try {
    fd = openSync(path, C.O_WRONLY | C.O_CREAT | C.O_EXCL, 0o666);
    created = true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw new Error(`could not write ${path}: ${words(e)}`);
    try { fd = openSync(path, C.O_WRONLY); } catch (e2) {
      // (a link to a file not there yet: made through it, as the shell's > makes it)
      if (e2.code !== 'ENOENT') throw new Error(`could not write ${path}: ${words(e2)}`);
      try { fd = openSync(path, C.O_WRONLY | C.O_CREAT, 0o666); created = true; } catch (e3) { throw new Error(`could not write ${path}: ${words(e3)}`); }
    }
  }
  const st = fstatSync(fd);
  let real = null;
  try { real = readlinkSync(`/proc/self/fd/${fd}`); } catch { /* no /proc: below */ }
  if (!real || !real.startsWith('/')) real = realpathSync.native(path);
  return { fd, created, st, real };
}

// An output written whole or not at all: to a file beside it, then renamed over it, so a write that
// fails (a full disk, a size limit) leaves the file as it was -- set-colours and split-board, which
// may write in place, left their input cut short, and printed node's "EFBIG: ..." (r93 Q1). A
// failure is said in the five tools' one wording, "could not write <path>: ...". As a write in
// place was: through a link to its file, and the file's own mode kept (the rename turned a link
// into a file of its own and left the file it named unchanged, exit 0; 0640 came back 0644 -- r94 A1)
// A file with other names (hard links) is written in place, from the whole file beside it, so every
// name sees the new bytes (the rename gave the path a new file and left the other names the old one
// -- r94 Q3); that last copy can fail part way, so a failure there says where the whole output is.
// Owner and group are kept where the user may keep them.
export async function writeOutput(path, bytes) {
  const { chmodSync, chownSync, closeSync, copyFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } = await import('node:fs');
  const { basename, dirname, join } = await import('node:path');
  // (a pipe or a device written as it is, by the path as given: a rename put a regular file in a
  // FIFO's place -- r95 A2)
  let s0 = null;
  try { s0 = statSync(path); } catch { /* not there yet */ }
  if (s0 && !s0.isFile() && !s0.isDirectory()) {
    try { writeFileSync(path, bytes); } catch (e) { throw new Error(`could not write ${path}: ${e.message}`); }
    return;
  }
  // (the file it lands on, as the system opens it: openOutput)
  const o = await openOutput(path);
  closeSync(o.fd);
  const real = o.real;
  const was = o.created ? null : o.st;
  // (one made by this open and then not written: taken back)
  const unmake = () => { if (o.created) { try { unlinkSync(real); } catch { /* gone */ } } };
  // (a name no one can know before, made new or not at all -- `wx`: a link planted at the pid's name
  // sent the output into another file, and on the shared tree two hosts' runs of one pid shared it
  // -- r95 Q2)
  const { randomBytes } = await import('node:crypto');
  const tmp = join(dirname(real), `.${basename(real)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, bytes, { flag: 'wx' });
    if (was) {
      chmodSync(tmp, was.mode & 0o7777);
      try { chownSync(tmp, was.uid, was.gid); } catch { /* not ours to give: the user's own */ }
    }
  } catch (e) {
    rmSync(tmp, { force: true });
    unmake();
    throw new Error(`could not write ${path}: ${e.message}`);
  }
  if (was && was.nlink > 1) {
    try { copyFileSync(tmp, real); } catch (e) { throw new Error(`could not write ${path}: ${e.message} (the whole output is in ${tmp})`); }
    rmSync(tmp, { force: true });
    return;
  }
  try { renameSync(tmp, real); } catch (e) {
    rmSync(tmp, { force: true });
    unmake();
    throw new Error(`could not write ${path}: ${e.message}`);
  }
}

// Whether a tool that reads a .cadmesh and writes one (set-colours, split-board) gzips it: as its
// input came, and always for a name ending ".gz" in any case. The viewer reads either by its
// bytes, and stp2mesh writes gzipped by default whatever the name: by the name alone, recolouring
// stp2mesh's output in place wrote it uncompressed, 6,211 bytes to 32,680 (r94 A3)
export const gzipsOutput = (path, inputGzipped) => inputGzipped || /\.gz$/i.test(path);

// -h / --help asked: thrown by a tool's main, the usage printed on stdout, exit 0
export class CliHelp extends Error {}

// A tool's main (sync or async) run, the one place the three outcomes are said: a CliError is a
// usage error ("<tool>: <what>" and the usage, on stderr, exit 2); a CliHelp the usage on stdout,
// exit 0; any other Error a refused input or a failed write, one line, exit 1. (Each tool wrote
// the usage half by hand, five copies of one shape.)
export async function runCli(name, main, usage = '') {
  const tail = usage && !usage.endsWith('\n') ? `${usage}\n` : usage;
  try {
    await main();
  } catch (e) {
    if (e instanceof CliHelp) { process.stdout.write(tail); process.exit(0); }
    if (e instanceof CliError) { process.stderr.write(`${name}: ${e.message}\n${tail}`); process.exit(2); }
    process.stderr.write(`${name}: ${e && e.message ? e.message : e}\n`);
    process.exit(1);
  }
}

// runCli, only when the module at url is the command node was given -- imported, a tool runs
// nothing and exits nothing. The five tools' one guard: four had a copy each and stp2mesh none,
// so importing it ran it (r85 A6). (node:fs and node:url loaded when called, as readInput's are.)
export async function runCliIfMain(url, name, main, usage = '') {
  if (typeof process === 'undefined' || !process.argv || !process.argv[1]) return;
  const [{ realpathSync }, { pathToFileURL }] = await Promise.all([import('node:fs'), import('node:url')]);
  // (argv[1] not a file -- node -e with an argument, a REPL -- is not this tool: the import rejected
  // with ENOENT where it should run nothing: r86 A6)
  let main1;
  try { main1 = pathToFileURL(realpathSync(process.argv[1])).href; } catch { return; }
  if (url !== main1) return;
  await runCli(name, main, usage);
}

// A value option's positive number, or a CliError naming it
export function positive(opts, k, fallback) {
  if (!(k in opts)) return fallback;
  const v = Number(opts[k]);
  if (!(v > 0) || !Number.isFinite(v)) throw new CliError(`${k} needs a positive number, not "${opts[k]}"`);
  return v;
}
