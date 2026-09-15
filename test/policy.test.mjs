import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AdminKey, verifySigned, effectivePolicy, requiredReserve, STRICT_DEFAULTS } from '../lib/policy.js';
import { Usage } from '../lib/usage.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-test-'));
const admin = new AdminKey(tmp);
const pub = admin.create();
const pol = { sessionLocalLimitPercent: 60, weeklyLocalLimitPercent: 20, sessionReservePercent: 20, weeklyReservePercent: 30, sessionReleaseHours: 2, weeklyReleaseDays: 2 };
const signed = admin.sign(pol, 'test');
const v = verifySigned(signed, pub);
assert.equal(v.error, undefined); assert.equal(v.policy.weeklyLocalLimitPercent, 20); assert.equal(v.note, 'test');
const tampered = signed.replace(/^[^.]+/, (d) => Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(d, 'base64url')), weeklyLocalLimitPercent: 90 })).toString('base64url'));
assert.match(verifySigned(tampered, pub).error, /Signature invalide/, 'politique falsifiée refusée');
const other = new AdminKey(path.join(tmp, 'other')); other.create();
assert.match(verifySigned(other.sign(pol), pub).error, /Signature invalide/, 'autre clé refusée');

const cfgLocked = { adminPublicKey: pub, signedPolicy: signed };
assert.equal(effectivePolicy(cfgLocked).locked, true); assert.equal(effectivePolicy(cfgLocked).valid, true);
const bad = effectivePolicy({ adminPublicKey: pub, signedPolicy: '' });
assert.equal(bad.valid, false); assert.equal(bad.weeklyLocalLimitPercent, STRICT_DEFAULTS.weeklyLocalLimitPercent, 'verrou sans politique = valeurs strictes');
assert.equal(effectivePolicy({ ...pol }).locked, false);

const H = 3_600_000;
assert.equal(requiredReserve(20, Date.now() + 3 * H, 2 * H), 20, 'plus de 2 h restantes : pleine réserve');
assert.equal(Math.round(requiredReserve(20, Date.now() + 1 * H, 2 * H)), 10, '1 h restante : moitié');
assert.equal(Math.round(requiredReserve(20, Date.now() + 20 * 60_000, 2 * H) * 10) / 10, 3.3, '20 min restantes : 3,3 %');
assert.equal(requiredReserve(0, Date.now() + H, 2 * H), 0);

const now = Date.now();
let reading = { five_hour: { utilization: 50, resets_at: now + 3 * H }, seven_day: { utilization: 60, resets_at: now + 5 * 86_400_000 } };
const fetchImpl = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => reading });
const u = new Usage({ hub: { broadcast() {} }, config: cfgLocked, fetchImpl, readCreds: () => ({ accessToken: 'x' }), minGapMs: 0 });
u.graceMs = 0;
await u.refresh({ force: true });
assert.equal(u.blocked(), null, '50 % et 60 % : sous les seuils (80 / 70)');
reading = { ...reading, seven_day: { utilization: 71, resets_at: now + 5 * 86_400_000 } };
await u.refresh({ force: true });
assert.match(u.blocked() || '', /Réserve maison.*la semaine/, 'semaine : 29 % libres < 30 % de réserve');
reading = { ...reading, seven_day: { utilization: 71, resets_at: now + 12 * H } };
await u.refresh({ force: true });
assert.equal(u.blocked(), null, 'fin de semaine proche : réserve libérée');
reading = { five_hour: { utilization: 85, resets_at: now + 3 * H }, seven_day: reading.seven_day };
await u.refresh({ force: true });
assert.match(u.blocked() || '', /Réserve maison.*5 h/, '5 h : 15 % libres < 20 %');
reading = { five_hour: { utilization: 85, resets_at: now + 20 * 60_000 }, seven_day: reading.seven_day };
await u.refresh({ force: true });
assert.equal(u.blocked(), null, '20 min avant la fin : 3,3 % exigés, 15 % libres');
const b = u.barriers();
assert.equal(b.list.length, 4, 'quatre barrières actives (deux parts locales à 0, deux réserves)');
assert.ok(b.headroom > 0);

reading = { five_hour: { utilization: 20, resets_at: now + 4 * H }, seven_day: { utilization: 10, resets_at: now + 5 * 86_400_000 } };
await u.refresh({ force: true });
u.homeEvents = []; // les hausses « au repos » simulées plus haut comptaient comme de l'activité maison
assert.equal(u.moment().level, 'good', 'beaucoup de marge, maison calme');
reading = { five_hour: { utilization: 24, resets_at: now + 4 * H }, seven_day: reading.seven_day };
await u.refresh({ force: true });
assert.equal(u.moment().level, 'bad', 'maison très active');
assert.match(u.moment().reasons.join(' '), /Maison active/);
fs.rmSync(tmp, { recursive: true, force: true });
console.log('policy.test : OK');
