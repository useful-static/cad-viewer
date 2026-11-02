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
import { dxfPairs, byHandle, compare } from './dwg-compare.mjs';

const summary = (dr) => JSON.stringify({ paths: dr.paths.length, texts: dr.texts.length, layers: dr.layers.length, extents: dr.extents, layouts: dr.layouts.length });

export function validate(std, path) {
  const res = { std, path, ok: true, notes: [] };
  let d;
  try { d = readDWG(readFileSync(path)); } catch (err) { res.ok = false; res.error = String(err.message || err); return res; }
  res.version = d.version; res.objects = d.objects.size;
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
  // 4: the answer key
  const twin = path.replace(/\.dwg$/i, '.dxf');
  if (existsSync(twin)) {
    const key = dxfPairs(twin);
    if (key) {
      res.twin = compare(byHandle(key), byHandle(P), (h) => d.objects.has(h), d.v, (h) => d.objects.get(h));
      if (res.twin.differences) res.ok = false;
    } else res.notes.push('twin DXF is binary: not compared');
  }
  return res;
}

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
    s.objects += r.objects || 0;
    if (r.complexity) { s.ent.push(r.complexity.entities); s.types.push(r.complexity.entityTypes); }
    if (r.decoded) { s.decoded += r.decoded[0]; s.decodable += r.decoded[1]; }
    for (const [, [p, t]] of Object.entries(r.checks || {})) { s.checks += t; s.checkFail += t - p; }
    if (r.adapter) { s.owned += r.adapter.owned; s.emitted += r.adapter.emitted; s.unexplained += r.adapter.unexplained; if (r.adapter.roundTrip) s.roundTrip++; }
    if (r.twin) { s.twins++; s.matched += r.twin.matched; s.fields += r.twin.fieldsCompared; s.diffs += r.twin.differences; s.drift += r.twin.notInFile + r.twin.represented + (r.twin.keyInconsistent || 0); }
  }
  const rng = (a) => (a.length ? `${Math.min(...a)}–${Math.max(...a)}` : '-');
  const lines = ['| | Standard | Files passing | Entities per file | Entity types per file | Objects decoded (of decodable) | Format checks failed (of run) | Adapter: emitted (of owned), unexplained drops | Adapter round trip | DXF twins | Twin fields compared | Twin differences | Twin drift, or the key contradicting itself (not compared) |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const [std, s] of Object.entries(by)) {
    lines.push(`| ${s.pass === s.files ? '🟢' : '🔴'} | ${std} | ${s.pass} of ${s.files} | ${rng(s.ent)} | ${rng(s.types)} | ${s.decoded} of ${s.decodable} | ${s.checkFail} of ${s.checks} | ${s.emitted} of ${s.owned}, ${s.unexplained} | ${s.roundTrip} of ${s.files} | ${s.twins} | ${s.fields} | ${s.diffs} | ${s.drift} |`);
  }
  console.log(lines.join('\n'));
  for (const r of results) if (!r.ok) console.log(`FAIL ${r.std} ${r.path}: ${r.error || [...(r.checkFailures || []), ...Object.entries(r.decodeErrors || {}).map(([k, n]) => `decode ${k} x${n}`), ...(r.adapter && r.adapter.unexplained ? [`adapter drops ${JSON.stringify(r.adapter.dropped)}`] : []), ...(r.adapter && !r.adapter.roundTrip ? ['adapter round trip differs'] : []), ...((r.twin && r.twin.examples) || [])].join('; ')}`);
  const mi = args.indexOf('--md');
  if (mi >= 0) {
    const per = ['', '| Standard | File | Entities | Entity types | Blocks | Layers | DXF twin |', '|---|---|---|---|---|---|---|',
      ...results.map((r) => `| ${r.std} | ${r.path.split('/').slice(-2).join('/')} | ${r.complexity ? r.complexity.entities : '-'} | ${r.complexity ? r.complexity.entityTypes : '-'} | ${r.complexity ? r.complexity.blocks : '-'} | ${r.complexity ? r.complexity.layers : '-'} | ${r.twin ? `${r.twin.matched} matched, ${r.twin.differences} differ` : '-'} |`)];
    writeFileSync(args[mi + 1], lines.join('\n') + '\n' + per.join('\n') + '\n');
  }
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}
if (import.meta.url === `file://${process.argv[1]}`) main();
