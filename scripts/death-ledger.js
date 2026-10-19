'use strict';
// The death ledger of the dragon stages (note 1575, the user's call of
// 2026-10-14 04:30Z): one row per death across every dragon-N run on a port,
// read from the stage logs and the flight records, the deaths ranked by the
// mechanism that made them. The fix goes to the top of the ranking, and the
// ranking says afterwards whether it moved.
//   node scripts/death-ledger.js [--port 25588] [--root ~/Code/jevcraft] [--runs 100-121] [--json out.jsonl] [--md out.md]
// A row: run, time, crystals broken before it, minutes in, position and class,
// the step in progress, the last twelve seconds of damage (cause, health),
// Jev's last pick and its weight, the mechanism.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const os = require('node:os');

const args = Object.fromEntries(process.argv.slice(2).reduce((out, a, i, all) => (a.startsWith('--') ? [...out, [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]] : out), []));
const port = String(args.port || '25588');
const root = args.root ? path.resolve(String(args.root).replace(/^~(?=$|[\\/])/, os.homedir())) : path.join(__dirname, '..');
const WINDOW_MS = 12000;

// The runs: every midgame log of a dragon stage, its start the file's birth.
const logs = fs.readdirSync(path.join(root, 'artifacts')).filter(f => /^midgame-.*-dragon-\d+\.log$/.test(f));
let runs = logs.map(f => {
  const n = Number(f.match(/-dragon-(\d+)\.log$/)[1]);
  const st = fs.statSync(path.join(root, 'artifacts', f));
  return { n, file: path.join(root, 'artifacts', f), start: (st.birthtimeMs || st.ctimeMs), end: st.mtimeMs };
}).sort((a, b) => a.n - b.n);
if (args.runs) { const [a, b] = String(args.runs).split('-').map(Number); runs = runs.filter(r => r.n >= a && r.n <= (b || a)); }

// The flight files of the port, begun when their names say.
const flightDir = path.join(root, '.bot-state', 'flight');
const begun = f => { const m = f.match(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/); return m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) : null; };
const flights = fs.readdirSync(flightDir).filter(f => f.includes(`-${port}-`) && f.endsWith('.jsonl'))
  .map(f => ({ f: path.join(flightDir, f), b: begun(f), part: Number((f.match(/-part(\d+)\.jsonl$/) || [])[1] || 1), end: fs.statSync(path.join(flightDir, f)).mtimeMs }))
  .filter(x => x.b).sort((a, b) => a.b - b.b || a.part - b.part);
// The files that may hold a moment: begun before it, written after it.
const filesAt = t => flights.filter(x => x.b <= t && x.end >= t - WINDOW_MS);

// The records of a window, streamed: damage, decision, danger, action, end_combat, survival.
async function windowRecords(t0, t1, files) {
  const out = [];
  for (const x of files) {
    const rl = readline.createInterface({ input: fs.createReadStream(x.f), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      // The record's own time is its last "at" (the snapshot's nested ones come first).
      const i = line.lastIndexOf('"at":"'); if (i < 0) continue;
      const at = Date.parse(line.slice(i + 6, i + 30));
      if (!Number.isFinite(at)) continue;
      if (at < t0) continue;
      if (at > t1) break;
      let o; try { o = JSON.parse(line); } catch (_) { continue; }
      if (['damage', 'decision', 'danger', 'action', 'end_combat', 'survival', 'vitals', 'observation', 'walk_end', 'no_route', 'error', 'lag'].includes(o.kind)) out.push(o);
    }
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

const r1 = n => Math.round(n * 10) / 10;
const pos = p => p ? `(${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)})` : '?';
const cause = label => (label || '').replace(/^hurt: /, '');

// Where the body was: the step says the column, the height says it too; water by oxygen or the step.
function positionClass(snap, step) {
  const y = snap?.position?.y ?? 0;
  const s = step || '';
  if (/pillar_down|hold_on_pillar|water_drop|down_after_the_blow|climb|pillar_punch|up_to_the_pillar|hold/.test(s) && y > 66) return 'column';
  if (y > 66) return 'height';
  if ((snap?.oxygen ?? 20) < 20) return 'water';
  if (y <= 0) return 'void';
  if (/leave_high_ground/.test(s)) return 'ledge';
  if (Math.hypot(snap?.position?.x || 0, snap?.position?.z || 0) > 42 && y < 58) return 'rim';
  return 'ground';
}

// The mechanism, from the last damages: what killed, and what put the body there.
function mechanism(damages, dead) {
  const last = damages.at(-1), causes = damages.map(d => cause(d.label));
  const lastCause = cause(last?.label), y0 = damages[0]?.snapshot?.position?.y ?? dead?.snapshot?.position?.y ?? 0;
  const had = re => causes.some(c => re.test(c));
  const breath = /indirect magic by ender_dragon|dragon_breath|dragonBreath/;
  if (/drown/.test(lastCause)) return 'drowned';
  if (/out of world|void/.test(lastCause) || (dead?.snapshot?.position?.y ?? 1) <= 0) return had(/ender_dragon/) ? 'void after the dragon\'s blow' : 'void';
  if (/fall/.test(lastCause)) {
    if (had(/mob attack by ender_dragon/)) return 'fall after the dragon\'s body (carried)';
    if (had(breath)) return 'fall after the breath (knocked)';
    if (had(/enderman/)) return 'fall after an enderman';
    return y0 > 66 ? 'fall from a height, unhurt before' : 'fall, unhurt before';
  }
  if (breath.test(lastCause)) {
    const cls = positionClass(last.snapshot, last.snapshot?.goal?.step?.action);
    return `breath on the ${cls}`;
  }
  if (/mob attack by ender_dragon/.test(lastCause)) return 'the dragon\'s body (melee/charge)';
  if (/enderman/.test(lastCause)) return 'enderman';
  if (/explosion/.test(lastCause)) return 'explosion (crystal)';
  if (/fire|lava|burn/.test(lastCause)) return 'fire';
  if (/starve/.test(lastCause)) return 'starved';
  return lastCause ? `other: ${lastCause}` : 'unknown (no damage record)';
}

(async () => {
  const rows = [], perRun = [];
  for (const run of runs) {
    let text; try { text = fs.readFileSync(run.file, 'utf8'); } catch (_) { continue; }
    const lines = text.split('\n');
    const struckAt = [];
    let crystals = 0;
    const deaths = [];
    for (const l of lines) {
      if (/\[end combat\] crystal \d+ struck from/.test(l) || /\[end combat\] crystal \d+ (shot|hit).*gone/.test(l)) { crystals++; struckAt.push(crystals); }
      // One death, not its recovery's second record a second later (dragon-150, 2026-10-14: two rows 1.3 s apart for one fall).
      if (l.startsWith('{"death"')) { try { const d = JSON.parse(l).death; const at = Date.parse(d.at); if (!deaths.length || at - deaths[deaths.length - 1].at > 5000) deaths.push({ at, position: d.position, crystals }); } catch (_) {} }
    }
    const minutes = r1((run.end - run.start) / 60000);
    // The process held (event loop stalls of two seconds or more) during the run, from its flight files.
    const runFiles = flights.filter(x => x.b >= run.start - 5000 && x.b <= run.end);
    const stalls = [];
    for (const x of runFiles) {
      const rl = readline.createInterface({ input: fs.createReadStream(x.f), crlfDelay: Infinity });
      for await (const line of rl) { if (line.includes('"kind":"lag"')) { const m = line.match(/"lagMs":(\d+)/); if (m) stalls.push(Number(m[1])); } }
    }
    perRun.push({ n: run.n, start: new Date(run.start).toISOString(), minutes, crystals, deaths: deaths.length, stalls: stalls.length, stallMax: stalls.length ? Math.max(...stalls) : 0 });
    for (const d of deaths) {
      const files = filesAt(d.at);
      // Sixty seconds back for the decisions (a question comes every few seconds); twelve for the damage.
      const recs = files.length ? await windowRecords(d.at - 60000, d.at + 1500, files) : [];
      const damages = recs.filter(r => r.kind === 'damage' && Date.parse(r.at) >= d.at - WINDOW_MS);
      const dead = recs.filter(r => r.kind === 'danger' && r.snapshot?.health === 0).at(-1) || null;
      const decisions = recs.filter(r => r.kind === 'decision');
      const lastDec = decisions.at(-1);
      const judg = lastDec?.snapshot?.decision?.judgments;
      // judgments: [{ branch, choice, confidence, probabilities: { option: p } }].
      const weights = Array.isArray(judg) ? (judg.find(j => j && j.probabilities)?.probabilities || null) : judg && typeof judg === 'object' ? (judg.weights || judg) : null;
      const pick = lastDec?.label || null;
      const pickWeight = weights && pick && Number.isFinite(weights[pick]) ? weights[pick] : null;
      const noneGood = weights && Number.isFinite(weights.none_good) ? weights.none_good : null;
      const lastSnap = (damages.at(-1) || dead || recs.at(-1))?.snapshot || null;
      const step = lastSnap?.goal?.step?.action || recs.filter(r => r.snapshot?.step?.action && r.snapshot.step.action !== 'end_combat').at(-1)?.snapshot?.step?.action || recs.filter(r => r.snapshot?.goal?.step?.action).at(-1)?.snapshot?.goal?.step?.action || null;
      const first = damages[0]?.snapshot;
      // The dragon's body near the fall with no hurt recorded (note 1580): a landing or sitting dragon's wings push without hurting (EnderDragon.knockBack hurts only when not sitting), and dragon-128 (2026-10-14 05:26Z) was pushed off a pillar's top by the dragon coming to its perch, 'fall, unhurt before'. The last question's state says where the dragon was.
      const lastState = lastDec?.snapshot?.decision?.state;
      const dragonOff = lastState?.dragon?.position && lastState?.position ? Math.round(Math.hypot(lastState.dragon.position.x - lastState.position.x, lastState.dragon.position.y - lastState.position.y, lastState.dragon.position.z - lastState.position.z)) : null;
      const sinceDecision = lastDec ? r1((d.at - Date.parse(lastDec.at)) / 1000) : null;
      // The process held (the event loop stalled) in the last twelve seconds: a body that cannot step out of a cloud.
      const lags = recs.filter(r => r.kind === 'lag' && Date.parse(r.at) >= d.at - WINDOW_MS).map(r => ({ s: r1((Date.parse(r.at) - d.at) / 1000), ms: r.detail?.lagMs, work: r.detail?.work }));
      rows.push({
        lagMs: lags.length ? Math.max(...lags.map(l => l.ms || 0)) : 0, lags,
        run: run.n, at: new Date(d.at).toISOString(), minutesIn: r1((d.at - run.start) / 60000), crystalsBefore: d.crystals,
        where: pos(d.position), y: Math.round(d.position?.y ?? 0), fromY: first ? Math.round(first.position.y) : null,
        positionClass: positionClass(first || lastSnap, step), step,
        damage: damages.map(x => `${r1((Date.parse(x.at) - d.at) / 1000)}s ${cause(x.label)} h${r1(x.snapshot?.health ?? 0)} y${Math.round(x.snapshot?.position?.y ?? 0)}`),
        healthBefore: first ? r1(first.health) : null,
        pick, pickWeight, noneGood, decisionsInWindow: decisions.length,
        dragonOffAtLastQuestion: dragonOff, secondsSinceLastQuestion: sinceDecision,
        mechanism: (() => { const m = mechanism(damages, dead); return m === 'fall, unhurt before' && dragonOff !== null && dragonOff <= 16 && sinceDecision !== null && sinceDecision <= 20 ? 'fall after the dragon\'s body (pushed, no hurt)' : m; })(), files: files.length,
      });
    }
  }
  // The ranking: deaths per mechanism, with runs and the share.
  const byMech = {};
  for (const r of rows) (byMech[r.mechanism] ||= []).push(r);
  const ranking = Object.entries(byMech).map(([m, rs]) => ({ mechanism: m, deaths: rs.length, runs: rs.map(r => r.run), perRun: r1(rs.length / Math.max(1, runs.length) * 100) / 100, crystalsBeforeAvg: r1(rs.reduce((n, r) => n + r.crystalsBefore, 0) / rs.length), lastFive: rs.filter(r => r.run > (runs.at(-1)?.n || 0) - 5).length })).sort((a, b) => b.deaths - a.deaths);
  // The rates: the last five runs against the five before.
  const rate = list => { const n = list.length || 1, mins = list.reduce((s, r) => s + r.minutes, 0) || 1; return { runs: list.length, crystals: list.reduce((s, r) => s + r.crystals, 0), crystalsPerRun: r1(list.reduce((s, r) => s + r.crystals, 0) / n), crystalsPerMinute: Math.round(list.reduce((s, r) => s + r.crystals, 0) / mins * 100) / 100, deathsPerCrystal: Math.round(list.reduce((s, r) => s + r.deaths, 0) / Math.max(1, list.reduce((s, r) => s + r.crystals, 0)) * 100) / 100, minutesPerRun: r1(mins / n), stallsPerRun: r1(list.reduce((s, r) => s + (r.stalls || 0), 0) / n), stallsPerMinute: Math.round(list.reduce((s, r) => s + (r.stalls || 0), 0) / mins * 100) / 100 }; };
  const last5 = perRun.slice(-5), prev5 = perRun.slice(-10, -5), all = perRun;
  const report = { port, runs: perRun.length, deaths: rows.length, ranking, rates: { all: rate(all), prev5: rate(prev5), last5: rate(last5) } };

  if (args.json) fs.writeFileSync(String(args.json), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  const md = [];
  md.push(`# Death ledger, port ${port}: ${perRun.length} runs, ${rows.length} deaths (${new Date().toISOString()})`, '');
  md.push('## Ranking by mechanism', '', '| mechanism | deaths | per run | last 5 runs | crystals before (avg) | runs |', '|---|---|---|---|---|---|');
  for (const r of ranking) md.push(`| ${r.mechanism} | ${r.deaths} | ${r.perRun} | ${r.lastFive} | ${r.crystalsBeforeAvg} | ${r.runs.slice(-12).join(' ')}${r.runs.length > 12 ? ' …' : ''} |`);
  md.push('', '## Rates', '', '| window | runs | crystals/run | crystals/min | deaths/crystal | min/run | stalls/run | stalls/min |', '|---|---|---|---|---|---|---|---|');
  for (const [k, v] of Object.entries(report.rates)) md.push(`| ${k} | ${v.runs} | ${v.crystalsPerRun} | ${v.crystalsPerMinute} | ${v.deathsPerCrystal} | ${v.minutesPerRun} | ${v.stallsPerRun} | ${v.stallsPerMinute} |`);
  md.push('', '## Runs', '', '| run | start | min | crystals | deaths | stalls (max ms) |', '|---|---|---|---|---|---|');
  for (const r of perRun) md.push(`| ${r.n} | ${r.start.slice(5, 16)} | ${r.minutes} | ${r.crystals} | ${r.deaths} | ${r.stalls} (${r.stallMax}) |`);
  md.push('', '## Rows', '', '| run | at | min in | crystals | where | class | step | mechanism | damage (s before, cause, health, y) | pick (w) | none_good | lag (ms) |', '|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) md.push(`| ${r.run} | ${r.at.slice(5, 19)} | ${r.minutesIn} | ${r.crystalsBefore} | ${r.where} | ${r.positionClass} | ${r.step || ''} | ${r.mechanism} | ${r.damage.join('; ')} | ${r.pick || ''}${r.pickWeight !== null ? ` (${r.pickWeight})` : ''} | ${r.noneGood ?? ''} | ${r.lagMs || ''} |`);
  const lagged = rows.filter(r => r.lagMs >= 500);
  md.push('', `Deaths with the process held 500 ms or more in the last twelve seconds: ${lagged.length} of ${rows.length}${lagged.length ? ` (${lagged.map(r => `${r.run}: ${r.lagMs} ms in ${r.lags.find(l => l.ms === r.lagMs)?.work || '?'}`).join('; ')})` : ''}.`);
  const text = md.join('\n') + '\n';
  if (args.md) fs.writeFileSync(String(args.md), text);
  console.log(JSON.stringify({ port, runs: perRun.length, deaths: rows.length, lagged: rows.filter(r => r.lagMs >= 500).length, ranking: ranking.map(r => ({ mechanism: r.mechanism, deaths: r.deaths, lastFive: r.lastFive })), rates: report.rates }, null, 1));
})();
