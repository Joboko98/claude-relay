/**
 * Client de la boîte aux lettres (voir mailbox/worker.js).
 *
 * Ce poste y dépose son propre relevé de consommation, et lit ceux des autres postes.
 * Ne transitent que des chiffres : jamais un titre de conversation, jamais un message,
 * jamais le jeton Claude.
 */

const PUBLICATION_MS = 15 * 60_000;   // dépôt périodique
const LECTURE_MS = 5 * 60_000;        // rafraîchissement des relevés distants
const ANTI_RAFALE_MS = 60_000;        // dépôts automatiques : au plus un par minute
const PLANCHER_MS = 10_000;           // même forcé, jamais deux dépôts à moins de dix secondes

export class Mailbox {
  constructor({ config, usage, hub, updater, fetchImpl = globalThis.fetch }) {
    this.config = config;
    this.usage = usage;
    this.hub = hub;
    this.updater = updater;
    this.fetchImpl = fetchImpl;
    this.postes = [];
    this.luLe = 0;
    this.publieLe = 0;
    this.erreur = null;
    this.derniereTache = 0;
    this.enCours = 0;
    this.minuteurs = [];
    this.enAttente = false;   // un dépôt est déjà programmé
  }

  get actif() {
    return Boolean(this.config.mailboxUrl && this.config.mailboxSecret);
  }

  get nom() {
    return (this.config.posteName || '').trim();
  }

  adresse(suffixe) {
    return String(this.config.mailboxUrl).replace(/\/+$/, '') + suffixe;
  }

  entetes() {
    return { Authorization: `Bearer ${this.config.mailboxSecret}`, 'Content-Type': 'application/json' };
  }

  etat() {
    return {
      configure: this.actif,
      publie: Boolean(this.config.mailboxPublish),
      lit: Boolean(this.config.mailboxRead),
      nom: this.nom,
      url: this.config.mailboxUrl || '',
      aSecret: Boolean(this.config.mailboxSecret),
      postes: this.config.mailboxRead ? this.postes.filter((p) => p.poste !== this.nom) : [],
      luLe: this.luLe,
      publieLe: this.publieLe,
      derniereTache: this.derniereTache || null,
      erreur: this.erreur,
    };
  }

  /** Relevé de ce poste : uniquement des nombres et des dates. */
  releve() {
    const u = this.usage.snapshot();
    const fenetres = {};
    for (const [cle, valeur] of Object.entries(u.local || {})) {
      fenetres[cle] = {
        points: valeur.points,
        cout: valeur.cost,
        estimation: valeur.estimate,
        calibre: valeur.calibrated,
        retenu: valeur.effective,
        finFenetre: valeur.resetsAt,
      };
    }
    const compte = {};
    for (const cle of ['five_hour', 'seven_day']) {
      if (u.data?.[cle]) compte[cle] = u.data[cle].utilization;
    }
    const st = this.updater?.status?.();
    return {
      version: st?.running?.version || null,
      plateforme: process.platform,
      fenetres,
      compte,
      marge: u.barriers?.headroom ?? null,
      derniereTache: this.derniereTache || null,
      enCours: this.enCours,
    };
  }

  async publier({ force = false } = {}) {
    if (!this.actif || !this.config.mailboxPublish) return null;
    if (!this.nom) { this.erreur = 'Nomme ce poste dans les réglages pour publier.'; return null; }
    if (Date.now() - this.publieLe < (force ? PLANCHER_MS : ANTI_RAFALE_MS)) return null;
    try {
      const r = await this.fetchImpl(this.adresse(`/v1/postes/${encodeURIComponent(this.nom)}`), {
        method: 'PUT',
        headers: this.entetes(),
        body: JSON.stringify(this.releve()),
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) throw new Error(r.status === 401 ? 'secret refusé' : `réponse ${r.status}`);
      this.publieLe = Date.now();
      this.erreur = null;
      return this.publieLe;
    } catch (err) {
      this.erreur = `Publication impossible : ${err.message}`;
      return null;
    }
  }

  async lire({ force = false } = {}) {
    if (!this.actif || !this.config.mailboxRead) return this.etat();
    if (!force && Date.now() - this.luLe < 60_000) return this.etat();
    try {
      const r = await this.fetchImpl(this.adresse('/v1/postes'), {
        headers: this.entetes(),
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) throw new Error(r.status === 401 ? 'secret refusé' : `réponse ${r.status}`);
      const j = await r.json();
      this.postes = Array.isArray(j.postes) ? j.postes : [];
      this.luLe = Date.now();
      this.erreur = null;
      this.hub?.broadcast({ type: 'postes', ...this.etat() });
    } catch (err) {
      this.erreur = `Lecture impossible : ${err.message}`;
    }
    return this.etat();
  }

  /**
   * Dépôt garanti : si le plancher anti-rafale l'interdit pour l'instant, il est reprogrammé
   * plutôt qu'abandonné. Sans cela, une tâche courte survenant peu après un dépôt passerait
   * inaperçue jusqu'au dépôt périodique suivant.
   */
  publierBientot(delai = 0) {
    if (!this.actif || !this.config.mailboxPublish || this.enAttente) return;
    const reste = Math.max(delai, PLANCHER_MS - (Date.now() - this.publieLe));
    if (reste <= 0) { this.publier({ force: true }).catch(() => {}); return; }
    this.enAttente = true;
    const t = setTimeout(() => {
      this.enAttente = false;
      this.publier({ force: true }).catch(() => {});
    }, reste);
    t.unref?.();
  }

  /** Une tâche vient de se terminer : on note l'heure et on dépose un relevé frais. */
  tacheTerminee() {
    this.derniereTache = Date.now();
    this.publierBientot(3000);          // laisse le compteur de consommation se rafraîchir
    const tardif = setTimeout(() => this.publierBientot(0), 100_000); // après le relevé différé
    tardif.unref?.();
  }

  demarrer() {
    this.arreter();
    if (!this.actif) return;
    const differe = (fn, ms) => {
      const t = setInterval(fn, ms);
      t.unref?.();
      this.minuteurs.push(t);
    };
    setTimeout(() => { this.publier({ force: true }).catch(() => {}); this.lire({ force: true }).catch(() => {}); }, 4000).unref?.();
    differe(() => this.publier({ force: true }).catch(() => {}), PUBLICATION_MS);
    differe(() => this.lire({ force: true }).catch(() => {}), LECTURE_MS);
  }

  arreter() {
    for (const t of this.minuteurs) clearInterval(t);
    this.minuteurs = [];
  }
}
