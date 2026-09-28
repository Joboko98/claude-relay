/**
 * Boîte aux lettres des postes claude-relay.
 *
 * Chaque poste y dépose périodiquement un relevé de sa propre consommation ; les autres
 * postes le lisent pour l'afficher. Rien d'autre ne transite : ni texte de conversation,
 * ni titre, ni jeton Claude. Le poste qui publie reste injoignable depuis l'extérieur.
 *
 * Routes :
 *   PUT  /v1/postes/<nom>   dépose le relevé de ce poste
 *   GET  /v1/postes         renvoie les relevés de tous les postes
 *   GET  /                  page d'accueil minimale (aucune donnée)
 *
 * Toutes les routes utiles exigent l'en-tête  Authorization: Bearer <SECRET>.
 */

const NOM_VALIDE = /^[a-z0-9][a-z0-9 _-]{0,31}$/i;
const TAILLE_MAX = 8192;          // un relevé pèse quelques centaines d'octets
const RETENTION = 60 * 60 * 24 * 30; // un relevé oublié s'efface au bout d'un mois

/** Comparaison à durée constante : deux secrets de longueurs égales prennent le même temps. */
function memeSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function autorise(request, env) {
  const attendu = env.RELAY_SECRET;
  if (!attendu) return false;
  const entete = request.headers.get('Authorization') || '';
  const fourni = entete.startsWith('Bearer ') ? entete.slice(7).trim() : '';
  return memeSecret(fourni, attendu);
}

const json = (corps, statut = 200) => new Response(JSON.stringify(corps), {
  status: statut,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const chemin = url.pathname.replace(/\/+$/, '') || '/';

    if (chemin === '/') {
      return new Response('Boîte aux lettres claude-relay. Rien à voir ici.', {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    if (!autorise(request, env)) return json({ erreur: 'Secret invalide' }, 401);

    if (chemin === '/v1/postes' && request.method === 'GET') {
      const liste = await env.RELEVES.list({ prefix: 'poste:' });
      const postes = [];
      for (const cle of liste.keys) {
        const brut = await env.RELEVES.get(cle.name);
        if (!brut) continue;
        try { postes.push(JSON.parse(brut)); } catch { /* relevé illisible : ignoré */ }
      }
      postes.sort((a, b) => (b.maj || 0) - (a.maj || 0));
      return json({ postes, lu: Date.now() });
    }

    const depot = chemin.match(/^\/v1\/postes\/(.+)$/);
    if (depot && request.method === 'PUT') {
      const nom = decodeURIComponent(depot[1]);
      if (!NOM_VALIDE.test(nom)) return json({ erreur: 'Nom de poste invalide' }, 400);
      const texte = await request.text();
      if (texte.length > TAILLE_MAX) return json({ erreur: 'Relevé trop volumineux' }, 413);
      let releve;
      try { releve = JSON.parse(texte); } catch { return json({ erreur: 'JSON invalide' }, 400); }
      if (!releve || typeof releve !== 'object' || Array.isArray(releve)) return json({ erreur: 'Relevé invalide' }, 400);
      releve.poste = nom;
      releve.maj = Date.now();                 // l'heure fait foi ici, pas celle du poste
      await env.RELEVES.put(`poste:${nom}`, JSON.stringify(releve), { expirationTtl: RETENTION });
      return json({ ok: true, poste: nom, maj: releve.maj }, 200);
    }

    if (depot && request.method === 'DELETE') {
      await env.RELEVES.delete(`poste:${decodeURIComponent(depot[1])}`);
      return json({ ok: true });
    }

    return json({ erreur: 'Route inconnue' }, 404);
  },
};
