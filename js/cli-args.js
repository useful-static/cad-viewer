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
//
//   runCli('split-board', main)
//     the rule's other half: an input the tool cannot read (main throws an Error) is said in one
//     line on stderr, exit 1 -- not node's stack trace; a usage error, "<tool>: <what>" and the
//     usage, exit 2, in each tool
//
//   await readInput(path), await checkOutput(path)
//     the input read, and the output checked before the work, in the five tools' one wording
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
  return readFileSync(path);
}
// An output a tool will write, checked before the work: its directory there, the path no
// directory (stp2mesh converted, split-board split, before a failed write said so)
export async function checkOutput(path) {
  const { statSync } = await import('node:fs');
  const { dirname, resolve } = await import('node:path');
  const st = (p) => { try { return statSync(p); } catch { return null; } };
  const dir = st(dirname(resolve(path)));
  if (!dir || !dir.isDirectory()) throw new Error(`could not write ${path}: no such directory ${dirname(path)}`);
  if (st(path)?.isDirectory()) throw new Error(`could not write ${path}: it is a directory`);
}

// A tool's main (sync or async) run: a thrown Error is a refused input, one line, exit 1
export async function runCli(name, main) {
  try {
    await main();
  } catch (e) {
    process.stderr.write(`${name}: ${e && e.message ? e.message : e}\n`);
    process.exit(1);
  }
}

// A value option's positive number, or a CliError naming it
export function positive(opts, k, fallback) {
  if (!(k in opts)) return fallback;
  const v = Number(opts[k]);
  if (!(v > 0) || !Number.isFinite(v)) throw new CliError(`${k} needs a positive number, not "${opts[k]}"`);
  return v;
}
