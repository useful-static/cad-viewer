#!/usr/bin/env node
// Validate js/dwg.js and its DXF adapter on a corpus of DWG files.
//
//   node tests/validate-dwg.mjs LIST.txt [--json OUT.json] [--md OUT.md]
//
// LIST.txt: one "<standard> <path.dwg>" per line (the standard: R13, R14, R2000, R2004, R2007,
// R2010, R2013, R2018). For each file:
//
//   1. the format checks the file carries (CRCs, checksums, sentinels, object map): all pass;
//   2. every object of a type the reader decodes decodes (data and handles inside the object);
//   3. the adapter (dwgToPairs, the DWG as DXF group codes): every decoded entity a block record
//      owns is emitted, or dropped for a stated reason (not drawn: ATTRIB, VERTEX of nothing...;
//      a reference whose block is not in the file); the pairs and the same pairs written as DXF
//      text and read back draw the same drawing (parseDXF: paths, texts, extents, layers);
//   4. where AutoCAD's own DXF of the drawing sits beside it (same name .dxf), every entity, block
//      entity and layer is matched by handle and compared (tests/dwg-compare.mjs).
//
// It also measures how complex each file is: decoded entities, distinct entity types, blocks,
// layers. Exit status 0 only when every file passes 1-4.
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { readDWG, dwgToPairs, pairsToDXF } from '../js/dwg.js';
import { parseDXF } from '../js/dxf.js';
import { dxfPairs, byHandle, compare, hexHandle } from './dwg-compare.mjs';

const summary = (dr) => JSON.stringify({ paths: dr.paths.length, texts: dr.texts.length, layers: dr.layers.length, extents: dr.extents, layouts: dr.layouts.length });

export function validate(std, path) {
  const res = { std, path, ok: true, notes: [] };
  let d;
  try { d = readDWG(readFileSync(path)); } catch (err) { res.ok = false; res.error = String(err.message || err); return res; }
  res.version = d.version; res.objects = d.objects.size; res.writer = d.writer || '';
  res.checks = Object.fromEntries(Object.entries(d.checks).map(([k, c]) => [k, [c.pass, c.pass + c.fail]]));
  res.checkFailures = d.failures;
  let decoded = 0, decodable = 0;
  const errs = {}, entTypes = new Set();
  let blocks = 0, layers = 0;
  for (const o of d.objects.values()) {
    if (o.decoded || o.error) decodable++;
    if (o.decoded) { decoded++; if (o.e) entTypes.add(o.name); }
    if (o.error) errs[o.name] = (errs[o.name] || 0) + 1;
    if (o.decoded && o.name === 'BLOCK_RECORD') blocks++;
    if (o.decoded && o.name === 'LAYER') layers++;
  }
  res.decoded = [decoded, decodable];
  res.decodeErrors = errs;
  if (d.failures.length || decoded !== decodable) res.ok = false;
  // 3: the adapter
  const P = dwgToPairs(d);
  const st = P.stats;
  const unexplained = Object.entries(st.dropped).filter(([k]) => !/\((not drawn|block not in the file)\)$/.test(k));
  const viaPairs = parseDXF(P), viaText = parseDXF(pairsToDXF(P));
  res.adapter = { owned: st.owned, emitted: st.emitted, dropped: st.dropped, unexplained: unexplained.length, roundTrip: summary(viaPairs) === summary(viaText), drawn: viaPairs.paths.length + viaPairs.texts.length };
  if (unexplained.length || !res.adapter.roundTrip) res.ok = false;
  if (!res.adapter.drawn) res.notes.push('nothing 2D to draw (3D solids are not read)');
  res.complexity = { entities: st.owned, entityTypes: entTypes.size, blocks, layers };
  // 4: the answer keys beside the file: NAME.dxf (the drawing's own DXF: AutoCAD's, or the
  // writer's), NAME.oda.dxf (ODA's reading of the DWG), NAME.libredwg.dxf (LibreDWG's reading),
  // each compared on its own (res.keys[source]); res.twin is NAME.dxf's
  const base = path.replace(/\.dwg$/i, '');
  res.keys = {};
  const B = byHandle(P);
  for (const [src, f] of [['dxf', `${base}.dxf`], ['oda', `${base}.oda.dxf`], ['libredwg', `${base}.libredwg.dxf`]]) {
    if (!existsSync(f)) continue;
    const key = dxfPairs(f);
    if (!key) { res.notes.push(`${src} key is binary: not compared`); continue; }
    // ODA's DXF writer parts a spline's repeated knots by 1e-9 (as its DWG writer does: the
    // LibreDWG key and the drawing's own DXF hold them unmoved): counted apart (knotMoved)
    // an R13/R14 file holds names as R13/R14 can (upper case, "_" for what they cannot hold);
    // a key may give the original (ODA restores it from AutoCAD's EXTNAMES data): names are
    // compared the R13/R14 way (dwg-compare.mjs opts.oldNames)
    res.keys[src] = compare(byHandle(key), B, (h) => d.objects.has(h), d.v, (h) => d.objects.get(h), { ...(src === 'oda' ? { knotTol: 1e-8 } : {}), oldNames: d.v <= 14 });
  }
  if (res.keys.dxf) res.twin = res.keys.dxf;
  // a difference counts against the reader when every key that has the object holds it; one
  // that a key with the object contradicts (it agrees with us there: AutoCAD's own DXF, or the
  // other reader) is the reading of the keys that hold it (counted apart: res.loneKey, by key)
  res.loneKey = {};
  const confirmed = new Set();
  const srcs = Object.keys(res.keys);
  const ids = Object.fromEntries(srcs.map((s) => [s, new Set(res.keys[s].diffIds)]));
  for (const s of srcs) {
    for (const id of ids[s]) {
      const h = hexHandle(id.split('|')[0]);
      const others = srcs.filter((t) => t !== s && res.keys[t].keyHas.has(h));
      const contradicted = others.some((t) => !ids[t].has(id));
      if (contradicted) res.loneKey[s] = (res.loneKey[s] || 0) + 1; else confirmed.add(id);
    }
  }
  for (const s of srcs) delete res.keys[s].keyHas;
  res.confirmed = confirmed.size;
  res.confirmedIds = [...confirmed].slice(0, 20);
  if (res.confirmed) res.ok = false;
  return res;
}

const KEYNAME = { dxf: 'own DXF', oda: 'ODA', libredwg: 'LibreDWG' };

function main() {
  const args = process.argv.slice(2);
  if (!args.length || args[0] === '-h' || args[0] === '--help') { console.log('usage: validate-dwg.mjs LIST.txt [--json OUT.json] [--md OUT.md]'); process.exit(args.length ? 0 : 2); }
  const list = readFileSync(args[0], 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => { const s = l.indexOf(' '); return [l.slice(0, s), l.slice(s + 1)]; });
  const results = list.map(([std, p]) => validate(std, p));
  const ji = args.indexOf('--json');
  if (ji >= 0) writeFileSync(args[ji + 1], JSON.stringify(results, null, 1));
  const by = {};
  for (const r of results) {
    const s = (by[r.std] ||= { files: 0, pass: 0, objects: 0, ent: [], types: [], decoded: 0, decodable: 0, checks: 0, checkFail: 0, owned: 0, emitted: 0, unexplained: 0, roundTrip: 0, twins: 0, matched: 0, fields: 0, diffs: 0, drift: 0 });
    s.files++; if (r.ok) s.pass++;
    // to R2000 a file has no AppInfo; R2004's and R2007's are not identified by the reader
    const w = r.writer || 'not identified';
    (s.writers ||= {})[w] = (s.writers[w] || 0) + 1;
    s.objects += r.objects || 0;
    if (r.complexity) { s.ent.push(r.complexity.entities); s.types.push(r.complexity.entityTypes); }
    if (r.decoded) { s.decoded += r.decoded[0]; s.decodable += r.decoded[1]; }
    for (const [, [p, t]] of Object.entries(r.checks || {})) { s.checks += t; s.checkFail += t - p; }
    if (r.adapter) { s.owned += r.adapter.owned; s.emitted += r.adapter.emitted; s.unexplained += r.adapter.unexplained; if (r.adapter.roundTrip) s.roundTrip++; }
    const ks = Object.entries(r.keys || {});
    if (ks.length) s.twins++;
    for (const [src, k] of ks) {
      (s.keySrc ||= {})[src] = (s.keySrc[src] || 0) + 1;
      s.matched += k.matched; s.fields += k.fieldsCompared; s.drift += k.notInFile + k.represented + (k.keyInconsistent || 0);
    }
    s.diffs += r.confirmed || 0;
    for (const [src, n] of Object.entries(r.loneKey || {})) (s.lone ||= {})[src] = (s.lone[src] || 0) + n;
  }
  const rng = (a) => (a.length ? `${Math.min(...a)}–${Math.max(...a)}` : '-');
  const lines = ['| | Standard | Files passing | Saved by (the file\'s AppInfo) | Entities per file | Entity types per file | Objects decoded (of decodable) | Format checks failed (of run) | Adapter: emitted (of owned), unexplained drops | Adapter round trip | Files with answer keys (keys by source) | Key fields compared | Differences every key holds | Differences a key holds that another key contradicts (by key) | Key drift, or a key contradicting itself (not compared) |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const [std, s] of Object.entries(by)) {
    const ws = Object.entries(s.writers).sort((a, b) => b[1] - a[1]).map(([w, n]) => `${w} ${n}`).join(', ');
    lines.push(`| ${s.pass === s.files ? '🟢' : '🔴'} | ${std} | ${s.pass} of ${s.files} | ${ws} | ${rng(s.ent)} | ${rng(s.types)} | ${s.decoded} of ${s.decodable} | ${s.checkFail} of ${s.checks} | ${s.emitted} of ${s.owned}, ${s.unexplained} | ${s.roundTrip} of ${s.files} | ${s.twins} of ${s.files}${s.keySrc ? ` (${Object.entries(s.keySrc).map(([k, n]) => `${KEYNAME[k]} ${n}`).join(', ')})` : ''} | ${s.fields} | ${s.diffs} | ${s.lone ? Object.entries(s.lone).map(([k, n]) => `${KEYNAME[k]} ${n}`).join(', ') : 0} | ${s.drift} |`);
  }
  console.log(lines.join('\n'));
  for (const r of results) if (!r.ok) console.log(`FAIL ${r.std} ${r.path}: ${r.error || [...(r.checkFailures || []), ...Object.entries(r.decodeErrors || {}).map(([k, n]) => `decode ${k} x${n}`), ...(r.adapter && r.adapter.unexplained ? [`adapter drops ${JSON.stringify(r.adapter.dropped)}`] : []), ...(r.adapter && !r.adapter.roundTrip ? ['adapter round trip differs'] : []), ...(r.confirmed ? [`differences every key holds: ${r.confirmed} (${r.confirmedIds.join(', ')})`] : []), ...Object.entries(r.keys || {}).flatMap(([src, k]) => k.examples.map((e) => `[${src}] ${e}`))].join('; ')}`);
  const mi = args.indexOf('--md');
  if (mi >= 0) {
    const per = ['', '| Standard | File | Saved by | Entities | Entity types | Blocks | Layers | Answer keys |', '|---|---|---|---|---|---|---|---|',
      ...results.map((r) => `| ${r.std} | ${r.path.split('/').slice(-2).join('/')} | ${r.writer || '-'} | ${r.complexity ? r.complexity.entities : '-'} | ${r.complexity ? r.complexity.entityTypes : '-'} | ${r.complexity ? r.complexity.blocks : '-'} | ${r.complexity ? r.complexity.layers : '-'} | ${Object.keys(r.keys || {}).length ? Object.entries(r.keys).map(([k, c]) => `${KEYNAME[k]}: ${c.matched} matched, ${c.differences} differ`).join('; ') : '-'} |`)];
    writeFileSync(args[mi + 1], lines.join('\n') + '\n' + per.join('\n') + '\n');
  }
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}
if (import.meta.url === `file://${process.argv[1]}`) main();
