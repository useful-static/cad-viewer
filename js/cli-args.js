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
  const { accessSync, constants, statSync } = await import('node:fs');
  const { dirname, resolve } = await import('node:path');
  const st = (p) => { try { return statSync(p); } catch { return null; } };
  const writable = (p) => { try { accessSync(p, constants.W_OK); return true; } catch { return false; } };
  // (the file the write lands on, as writeOutput finds it: a link's own file, beside which it writes)
  const real = await writeTarget(path);
  const d = dirname(real), dir = st(d), file = st(path);
  // (the directory the write lands in, named: a link into a missing one named its own, which is
  // there -- r95 Q6; the path as given where it is not a link)
  if (!dir || !dir.isDirectory()) throw new Error(`could not write ${path}: no such directory ${d === dirname(resolve(path)) ? dirname(path) : d}`);
  if (file?.isDirectory()) throw new Error(`could not write ${path}: it is a directory`);
  for (const i of inputs) {
    const s = file && st(i);
    if (s && s.dev === file.dev && s.ino === file.ino) throw new Error(`could not write ${path}: it is the input ${i}`);
  }
  // (a directory or file it may not write: refused before the work too -- two tools ran it, then
  // printed node's "EACCES: ..."; and by what writeOutput needs -- the directory, where its file
  // beside goes, and the file there when there is one: a writable file in a read-only directory
  // passed, and stp2mesh converted it all to fail on a ".tmp" never named -- r94 A2. A file that is
  // no regular file -- a pipe, a device -- is written as it is, so only it need be writable:
  // -o /dev/null was refused -- r95 A2)
  const needs = file && !file.isFile() ? !writable(real) : !writable(d) || (file && !writable(real));
  if (needs) throw new Error(`could not write ${path}: permission denied`);
}

// The file a write to path lands on: a link's own file, followed link by link -- a link to a file not
// there yet too, which the rename replaced with a file of its own, the file it named never made, exit
// 0 (r95 A1) -- else path itself (written through, as an in-place write always was)
async function writeTarget(path) {
  const { lstatSync, readlinkSync, realpathSync, statSync } = await import('node:fs');
  const { basename, dirname, isAbsolute, resolve } = await import('node:path');
  // (a path's directory read as the system reads it, ".." after a link included, then its last
  // name: taken from the path as written, "outdir/../c.rgb" through a linked outdir wrote the
  // colours input ./c.rgb -- r97 A1 -- and a link's "../target" replaced another ./target -- r96 Q2.
  // A directory not there: as written, "no such directory" said by checkOutput)
  // (realpathSync.native, the system's own: node's JS realpathSync drops "dir/.." by string first)
  const real = (raw) => { let d; try { d = realpathSync.native(dirname(raw)); } catch { d = resolve(dirname(raw)); } return resolve(d, basename(raw)); };
  // (a pipe or a device, however it is reached -- /dev/stdout and /dev/fd/N name one through a
  // link to "pipe:[…]", no path: followed, it was "permission denied" -- r95 Q3): the path itself
  try { if (!statSync(path).isFile()) return resolve(path); } catch { /* not there yet: followed below */ }
  let p = real(path);
  for (let k = 0; k < 40; k++) {
    let s = null;
    try { s = lstatSync(p); } catch { return p; }
    if (!s.isSymbolicLink()) return p;
    const to = readlinkSync(p);
    p = real(isAbsolute(to) ? to : `${dirname(p)}/${to}`);
  }
  throw new Error(`could not write ${path}: too many links`);
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
  const { chmodSync, chownSync, copyFileSync, renameSync, rmSync, statSync, writeFileSync } = await import('node:fs');
  const { basename, dirname, join } = await import('node:path');
  let real;
  try { real = await writeTarget(path); } catch (e) { throw new Error(e.message.startsWith('could not write') ? e.message : `could not write ${path}: ${e.message}`); }
  let was = null;
  try { was = statSync(real); } catch { /* a new file: the default mode and owner */ }
  // (a pipe or a device written as it is: a rename put a regular file in a FIFO's place -- r95 A2)
  if (was && !was.isFile()) {
    try { writeFileSync(real, bytes); } catch (e) { throw new Error(`could not write ${path}: ${e.message}`); }
    return;
  }
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
    throw new Error(`could not write ${path}: ${e.message}`);
  }
  if (was && was.nlink > 1) {
    try { copyFileSync(tmp, real); } catch (e) { throw new Error(`could not write ${path}: ${e.message} (the whole output is in ${tmp})`); }
    rmSync(tmp, { force: true });
    return;
  }
  try { renameSync(tmp, real); } catch (e) {
    rmSync(tmp, { force: true });
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
