import assert from 'node:assert/strict';
import { Usage } from '../lib/usage.js';

const cfg = () => ({ sessionLocalLimitPercent: 0, weeklyLocalLimitPercent: 20, sessionReservePercent: 0, weeklyReservePercent: 0, sessionReleaseHours: 2, weeklyReleaseDays: 2 });
const mk = (readingRef, status = { code: 200 }) => new Usage({
  hub: { broadcast() {} }, config: cfg(), minGapMs: 0, readCreds: () => ({ accessToken: 'x' }),
  fetchImpl: async () => ({ ok: status.code === 200, status: status.code, headers: { get: () => '600' }, json: async () => readingRef.v }),
});

// Attribution, grâce, nouvelle fenêtre, reset
{
  const R = { v: { five_hour: { utilization: 40, resets_at: 1000 }, seven_day: { utilization: 10, resets_at: 5000 } } };
  const u = mk(R); const pts = () => u.snapshot().local.seven_day.points;
  await u.refresh({ force: true }); assert.equal(pts(), 0);
  R.v = { ...R.v, seven_day: { utilization: 12, resets_at: 5000 } }; await u.refresh({ force: true }); assert.equal(pts(), 0, 'hausse au repos = maison');
  u.noteStart(); await u.inflight;
  R.v = { ...R.v, seven_day: { utilization: 14, resets_at: 5000 } }; await u.refresh({ force: true }); assert.equal(pts(), 2, 'pendant la tâche');
  R.v = { ...R.v, seven_day: { utilization: 15, resets_at: 5000 } }; u.noteEnd({ costUsd: 0.5 }); await u.inflight; assert.equal(pts(), 3, 'fin de tâche');
  R.v = { ...R.v, seven_day: { utilization: 16, resets_at: 5000 } }; await u.refresh({ force: true }); assert.equal(pts(), 4, 'dans la période de grâce : attribuée');
  u.lastRunEnd = Date.now() - 400_000;
  R.v = { ...R.v, seven_day: { utilization: 17, resets_at: 5000 } }; await u.refresh({ force: true }); assert.equal(pts(), 4, 'après la grâce = maison');
  R.v = { ...R.v, seven_day: { utilization: 17, resets_at: 5155 } }; await u.refresh({ force: true }); assert.equal(pts(), 4, 'gigue de quelques ms = même fenêtre');
  R.v = { ...R.v, seven_day: { utilization: 1, resets_at: 5000 + 7 * 86_400_000 } }; await u.refresh({ force: true }); assert.equal(pts(), 0, 'nouvelle semaine');
  u.local.seven_day.points = 2.5; u.resetLocal(); assert.equal(pts(), 0, 'reset manuel');
}

// Backoff 429 levé en fin de tâche
{
  const R = { v: { five_hour: { utilization: 40, resets_at: 1000 }, seven_day: { utilization: 10, resets_at: 5000 } } };
  const st = { code: 200 }; const u = mk(R, st); const pts = () => u.snapshot().local.seven_day.points;
  await u.refresh({ force: true });
  st.code = 429; await u.refresh({ force: true }); assert.ok(u.backoffUntil > Date.now() + 100_000, 'backoff actif');
  st.code = 200; R.v = { ...R.v, seven_day: { utilization: 13, resets_at: 5000 } };
  u.noteStart(); await u.inflight; assert.equal(pts(), 0, 'noteStart pendant backoff : pas de relevé');
  u.noteEnd(); await u.inflight; assert.equal(u.backoffUntil, 0, 'noteEnd lève le backoff'); assert.equal(pts(), 3);
}

// Calibrage coût → points et estimation robuste à la maison
{
  let week = 10;
  const R = { get v() { return { five_hour: { utilization: 40, resets_at: 1000 }, seven_day: { utilization: week, resets_at: 5000 } }; } };
  const u = mk(R); u.graceMs = 0; const snap = () => u.snapshot().local.seven_day;
  await u.refresh({ force: true });
  for (let i = 0; i < 3; i++) { u.noteStart(); await u.inflight; week += 2; u.noteEnd({ costUsd: 1 }); await u.inflight; u.lastRunEnd = 0; await u.refresh({ force: true }); }
  assert.equal(snap().points, 6); assert.equal(snap().cost, 3); assert.equal(snap().samples, 3);
  assert.equal(u.ratio('seven_day'), 2, '2 pts/$'); assert.equal(snap().estimate, 6);
  u.noteStart(); await u.inflight; week += 7; u.noteEnd({ costUsd: 1 }); await u.inflight; u.lastRunEnd = 0; await u.refresh({ force: true });
  assert.equal(snap().points, 13, 'observé gonflé par la maison'); assert.equal(u.ratio('seven_day'), 2, 'médiane insensible'); assert.equal(snap().estimate, 8);
  assert.equal(u.blocked(), null, '8 < 20');
  u.noteStart(); await u.inflight; week += 12; u.noteEnd({ costUsd: 6 }); await u.inflight; u.lastRunEnd = 0; await u.refresh({ force: true });
  assert.equal(snap().estimate, 20); assert.match(u.blocked() || '', /estimés d'après le coût/, 'blocage sur l\'estimation');
  u.local.seven_day.resetsAt = 1; await u.refresh({ force: true });
  assert.equal(snap().cost, 0); assert.equal(u.ratio('seven_day'), 2, 'calibrage conservé');
}
console.log('usage.test : OK');
