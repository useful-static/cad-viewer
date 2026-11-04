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
//     line on stderr, exit 1 -- not node's stack trace
//
// Pure ES module; only runCli touches the process (stderr, exit), when it runs.

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
