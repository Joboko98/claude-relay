import assert from 'node:assert/strict';
import worker from '../mailbox/worker.js';
import { Mailbox } from '../lib/mailbox.js';

/* --- boîte aux lettres simulée : le vrai code du Worker, un stockage en mémoire --- */
function faireEnv(secret = 'phrase-secrete-longue') {
  const kv = new Map();
  return {
    RELAY_SECRET: secret,
    RELEVES: {
      async get(k) { return kv.has(k) ? kv.get(k) : null; },
      async put(k, v) { kv.set(k, v); },
      async delete(k) { kv.delete(k); },
      async list({ prefix }) { return { keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }; },
    },
  };
}
const env = faireEnv();
const appeler = (chemin, init = {}) => worker.fetch(new Request('https://boite.test' + chemin, init), env);
const avecSecret = (secret, init = {}) => ({ ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${secret}` } });

/* --- Worker : autorisation --- */
assert.equal((await appeler('/v1/postes')).status, 401, 'sans secret : refusé');
assert.equal((await appeler('/v1/postes', avecSecret('mauvais'))).status, 401, 'mauvais secret : refusé');
assert.equal((await appeler('/v1/postes', avecSecret('phrase-secrete-longu'))).status, 401, 'secret tronqué : refusé');
assert.equal((await appeler('/')).status, 200, "page d'accueil ouverte, sans donnée");

/* --- Worker : dépôt et lecture --- */
let r = await appeler('/v1/postes/bureau', avecSecret('phrase-secrete-longue', { method: 'PUT', body: JSON.stringify({ fenetres: { seven_day: { points: 14, cout: 3.2 } }, enCours: 0 }) }));
assert.equal(r.status, 200);
r = await appeler('/v1/postes', avecSecret('phrase-secrete-longue'));
let corps = await r.json();
assert.equal(corps.postes.length, 1);
assert.equal(corps.postes[0].poste, 'bureau', 'le nom vient du chemin, pas du corps');
assert.ok(corps.postes[0].maj > 0, "l'heure est posée par le service");
assert.equal(corps.postes[0].fenetres.seven_day.points, 14);

/* --- Worker : refus des entrées douteuses --- */
assert.equal((await appeler('/v1/postes/nom%20invalide%21', avecSecret('phrase-secrete-longue', { method: 'PUT', body: '{}' }))).status, 400, 'nom invalide');
assert.equal((await appeler('/v1/postes/bureau', avecSecret('phrase-secrete-longue', { method: 'PUT', body: 'x'.repeat(9000) }))).status, 413, 'relevé trop volumineux');
assert.equal((await appeler('/v1/postes/bureau', avecSecret('phrase-secrete-longue', { method: 'PUT', body: 'pas du json' }))).status, 400, 'corps illisible');
assert.equal((await appeler('/v1/inconnu', avecSecret('phrase-secrete-longue'))).status, 404, 'route inconnue');

/* --- Client : publication puis lecture par un autre poste --- */
const fetchVersWorker = async (url, init = {}) => {
  const req = new Request(url, { method: init.method || 'GET', headers: init.headers, body: init.body });
  return worker.fetch(req, env);
};
const faireUsage = (points, cout) => ({
  snapshot: () => ({
    local: { seven_day: { points, cost: cout, estimate: points, calibrated: true, effective: points, resetsAt: 123 },
             five_hour: { points: 2, cost: 0.5, estimate: 2, calibrated: true, effective: 2, resetsAt: 45 } },
    data: { seven_day: { utilization: 40 }, five_hour: { utilization: 12 } },
    barriers: { headroom: 6 },
  }),
});
const updater = { status: () => ({ running: { version: '0.2.2' } }) };

const cfgBureau = { mailboxUrl: 'https://boite.test', mailboxSecret: 'phrase-secrete-longue', posteName: 'bureau', mailboxPublish: true, mailboxRead: false };
const bureau = new Mailbox({ config: cfgBureau, usage: faireUsage(14, 3.2), hub: null, updater, fetchImpl: fetchVersWorker });
bureau.derniereTache = Date.now() - 20 * 60_000;
assert.ok(await bureau.publier({ force: true }), 'le bureau publie');

const cfgPortable = { mailboxUrl: 'https://boite.test/', mailboxSecret: 'phrase-secrete-longue', posteName: 'portable', mailboxPublish: false, mailboxRead: true };
const portable = new Mailbox({ config: cfgPortable, usage: faireUsage(1, 0.1), hub: { broadcast() {} }, updater, fetchImpl: fetchVersWorker });
const etat = await portable.lire({ force: true });
const vuBureau = etat.postes.find((p) => p.poste === 'bureau');
assert.ok(vuBureau, 'le portable voit le bureau');
assert.equal(vuBureau.fenetres.seven_day.points, 14);
assert.equal(vuBureau.fenetres.seven_day.cout, 3.2);
assert.equal(vuBureau.version, '0.2.2');
assert.ok(vuBureau.derniereTache > 0);
assert.equal(vuBureau.compte.seven_day, 40, 'le total du compte vu par le bureau est transmis');

/* --- Le relevé ne contient aucun texte de conversation --- */
const brut = JSON.stringify(bureau.releve());
assert.ok(!/conversation|titre|message|token|secret/i.test(brut), 'relevé purement chiffré : ' + brut);

/* --- Un poste ne se voit pas lui-même dans la liste --- */
await portable.publier({ force: true }).catch(() => {});
cfgPortable.mailboxPublish = true;
await portable.publier({ force: true });
await portable.lire({ force: true });
assert.ok(!portable.etat().postes.some((p) => p.poste === 'portable'), 'le poste s\'exclut de sa propre liste');

/* --- Secret erroné : message clair, pas d'exception --- */
const cfgFaux = { ...cfgPortable, mailboxSecret: 'pas-le-bon-secret-la' };
const faux = new Mailbox({ config: cfgFaux, usage: faireUsage(1, 0.1), hub: { broadcast() {} }, updater, fetchImpl: fetchVersWorker });
await faux.lire({ force: true });
assert.match(faux.erreur, /secret refusé/, 'secret refusé signalé clairement');

console.log('mailbox.test : OK');
