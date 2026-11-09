/* Suivi des visites — à copier à la racine de chaque site suivi par le tableau de bord.
 *
 * Installation dans un site : copier ce fichier à la racine du site, puis ajouter dans chaque page
 *   <script src="suivi.js" data-site="nom-du-site" data-base="https://….firebasedatabase.app" defer></script>
 * (avec le bon chemin, par exemple ../suivi.js dans un sous-dossier). « nom-du-site » : 2 à 30
 * caractères parmi a-z, 0-9 et « - ». data-base : adresse de la Realtime Database du site, où ranger
 * les chiffres. Cette base doit avoir les règles « stats » (voir regles-stats.txt du tableau de bord).
 *
 * Rien de personnel n'est envoyé : pas d'adresse IP enregistrée, pas d'identifiant durable. Chaque appareil
 * retient seulement (dans son navigateur) le jour et le mois où il a déjà été compté, pour compter
 * chaque visiteur une fois par jour et par mois. La base reçoit surtout des compteurs :
 *
 *   stats/<site>/jours/AAAA-MM-JJ   visiteurs, vues, nouveaux, appli, appareils/{mobile|ordi},
 *                                   pages/<page> (visiteurs du jour par page)
 *       et aussi                    visites (visites = passages, une visite s'arrête après 30 min sans rien),
 *                                   heures/<0-23> (visites par heure), sources/<source> (d'où vient la visite),
 *                                   revenus (visiteurs déjà venus un autre jour), retours/<délai>,
 *                                   systemes/<système>, navigateurs/<navigateur>,
 *                                   temps/<page>/{s,n} (secondes passées sur la page, nombre d'affichages),
 *                                   erreurs/<page>, bugs/<id> = { m: message, f: fichier, p, t },
 *                                   contenus/<type>/<id> (séries, recherches… consultées),
 *                                   prives (visiteurs en navigation privée : ni « nouveaux » ni comptés dans le total,
 *                                   puisque leur navigateur oublie qu'ils sont déjà venus)
 *   stats/<site>/mois/AAAA-MM       visiteurs
 *   stats/<site>/total              visiteurs, vues
 *   stats/<site>/noms/<type>/<id>   nom affiché d'un contenu
 *   stats/<site>/direct/<visite>    { p: page, t: heure } : les visites en cours (effacées en partant)
 *
 * <page> = premier dossier de l'adresse sous la racine du site (« uno » pour /uno/), ou « accueil ».
 * La racine du site est le dossier qui contient ce fichier. Pour un site d'une seule page à onglets :
 *   - data-page="carte" sur la balise donne le nom de la page affichée à l'ouverture ;
 *   - window.suivi.page('itineraires') compte le passage sur un autre onglet (une page vue de plus,
 *     et un visiteur de plus pour cet onglet s'il ne l'avait pas encore ouvert ce jour-là).
 *
 * Actions : window.suivi.action('parties-en-ligne', 'uno') ajoute 1 à
 *   stats/<site>/jours/AAAA-MM-JJ/actions/<action>/<page>   et   stats/<site>/total/actions/<action>/<page>
 * (une partie lancée, un formulaire envoyé, un clic sur un lien…). Sans <page> : la page actuelle.
 * Chaque action est aussi notée dans stats/<site>/jours/AAAA-MM-JJ/journal/<id> = { a: action, p: page,
 * t: heure du serveur }. Le tableau de bord affiche les actions dont le nom commence par « parties » comme
 * des parties jouées, avec le détail par mode.
 * Pour une partie en plusieurs manches : const ref = window.suivi.action('parties-telephone', 'skyjo', { m: 1 })
 * note m (nombre de manches) dans le journal, puis window.suivi.manches(ref, 3) le met à jour.
 * Joueurs : { j: '3+1' } (3 joueurs et 1 bot) à l'action, puis window.suivi.manches(ref, 2, '2+1') ajoute
 * ceux de la manche suivante : j devient « 3+1,2+1 » (un nombre par manche, « +bots » s'il y en a).
 * Durée et fin : window.suivi.partie(ref, { d: 340, x: true }) note la durée en secondes, et que la partie
 * est allée jusqu'au bout (sinon elle compte comme abandonnée).
 *
 * Contenus : window.suivi.contenu('serie', '12345', 'One Piece') compte une consultation de ce contenu
 * (une fois par visite) ; window.suivi.recherche('one piece') compte une recherche.
 *
 * Pas compté : localhost, hors connexion, et un appareil où l'on a ouvert le site avec ?suivi=off
 * (?suivi=on pour annuler).
 */
(() => {
  const FUSEAU = 'Europe/Paris';

  const script = document.currentScript;
  const site = script && script.dataset.site;
  if (!site || !/^[a-z0-9-]{2,30}$/.test(site)) return;
  const BASE = (script.dataset.base || '').trim().replace(/\/+$/, '');
  if (!/^https:\/\/[a-z0-9.-]+\.(firebasedatabase\.app|firebaseio\.com)$/.test(BASE)) return;
  const racine = new URL('.', script.src).pathname;
  const CLE = `suivi:${site}`;
  const CLE_VISITE = `suivi-visite:${site}`;
  const IGNORER = 'suivi:ignorer';
  const S = `stats/${site}`;
  const DEBUT_CHARGEMENT = Date.now();

  function stockage() {
    try {
      const q = new URLSearchParams(location.search).get('suivi');
      if (q === 'off') localStorage.setItem(IGNORER, '1');
      if (q === 'on') localStorage.removeItem(IGNORER);
      if (localStorage.getItem(IGNORER) === '1') return null;
      return JSON.parse(localStorage.getItem(CLE) || '{}') || {};
    } catch (e) {
      return null; // stockage bloqué : on ne compte pas, plutôt que de compter chaque page comme un nouveau visiteur
    }
  }

  function partiesParis(date) {
    const p = {};
    new Intl.DateTimeFormat('en-GB', { timeZone: FUSEAU, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
      .formatToParts(date).forEach((x) => { p[x.type] = x.value; });
    return p;
  }
  function jourDe(date) {
    const p = partiesParis(date);
    return `${p.year}-${p.month}-${p.day}`;
  }
  const heureDe = (date) => Number(partiesParis(date).hour) % 24;
  // nombre de jours entre deux dates AAAA-MM-JJ
  const ecartJours = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

  const nettoyer = (nom) => {
    const p = String(nom || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/\.html?$/, '').replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
    return p.length >= 2 && p !== 'index' ? p : '';
  };

  function pageActuelle() {
    if (script.dataset.page) return nettoyer(script.dataset.page) || 'accueil';
    const chemin = location.pathname.startsWith(racine) ? location.pathname.slice(racine.length) : '';
    let premier = '';
    try { premier = decodeURIComponent(chemin.split('/')[0] || ''); } catch (e) { /* adresse mal formée */ }
    return nettoyer(premier) || 'accueil';
  }

  const horsJeu = () => location.protocol === 'file:' || ['localhost', '127.0.0.1', ''].includes(location.hostname) || !navigator.onLine;
  const requete = (chemin, methode, corps) => fetch(`${BASE}/${chemin}.json`, {
    method: methode, body: corps === undefined ? undefined : JSON.stringify(corps), keepalive: true,
  }).catch(() => {});
  const envoyer = (maj) => requete('', 'PATCH', maj);
  const UN = { '.sv': { increment: 1 } };
  const PLUS = (n) => ({ '.sv': { increment: n } });
  const MAINTENANT = { '.sv': 'timestamp' };
  const idAuHasard = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  let pageCourante = pageActuelle();
  const appli = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

  // ---------- D'où vient la visite ----------
  const SOURCES = [
    [/(^|\.)google\.|googlequicksearchbox/, 'google'], [/(^|\.)bing\.com$/, 'bing'], [/duckduckgo/, 'duckduckgo'],
    [/(^|\.)qwant\./, 'qwant'], [/(^|\.)ecosia\./, 'ecosia'], [/(^|\.)yahoo\./, 'yahoo'], [/(^|\.)brave\.com$|search\.brave/, 'brave'],
    [/instagram/, 'instagram'], [/messenger/, 'messenger'], [/(^|\.)facebook\.|(^|\.)fb\.(com|me)$|katana/, 'facebook'],
    [/whatsapp|(^|\.)wa\.me$/, 'whatsapp'], [/(^|\.)t\.co$|twitter|(^|\.)x\.com$/, 'x'], [/linkedin|(^|\.)lnkd\.in$/, 'linkedin'],
    [/(^|\.)github\.com$/, 'github'], [/youtube|(^|\.)youtu\.be$/, 'youtube'], [/tiktok/, 'tiktok'], [/reddit/, 'reddit'],
    [/discord/, 'discord'], [/snapchat/, 'snapchat'], [/pinterest/, 'pinterest'], [/telegram|(^|\.)t\.me$/, 'telegram'],
    [/chatgpt|openai/, 'chatgpt'], [/(^|\.)claude\.ai$/, 'claude'], [/perplexity/, 'perplexity'],
    [/(^|\.)mail\.|gmail|outlook|com\.google\.android\.gm|yahoo\.mail/, 'e-mail'],
  ];
  function sourceVisite() {
    try {
      const q = new URLSearchParams(location.search);
      const utm = nettoyer(q.get('utm_source') || q.get('ref') || '');
      if (utm) return utm;
    } catch (e) { /* rien */ }
    if (appli()) return 'appli';
    if (!document.referrer) return 'direct';
    let u;
    try { u = new URL(document.referrer); } catch (e) { return 'direct'; }
    if (u.origin === location.origin) {
      if (u.pathname.startsWith(racine)) return 'direct'; // depuis le site lui-même (visite reprise)
      // un autre site à la même adresse (ex. un autre dépôt GitHub Pages) : « lien-portfolio »
      const autre = nettoyer(decodeURIComponent(u.pathname.split('/')[1] || ''));
      return autre ? `lien-${autre}`.slice(0, 40) : 'direct';
    }
    const hote = (u.protocol === 'android-app:' ? u.host : u.hostname).replace(/^(www|m|l|lm|mobile)\./, '');
    for (const [motif, nom] of SOURCES) if (motif.test(hote)) return nom;
    return nettoyer(hote.replace(/\./g, '-')) || 'autre';
  }

  // ---------- Système et navigateur (grandes familles seulement) ----------
  function systeme() {
    const ua = navigator.userAgent || '';
    if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
    if (/Android/.test(ua)) return 'android';
    if (/Windows/.test(ua)) return 'windows';
    if (/CrOS/.test(ua)) return 'chromeos';
    if (/Macintosh|Mac OS X/.test(ua)) return 'macos';
    if (/Linux/.test(ua)) return 'linux';
    return 'autre';
  }
  function navigateur() {
    const ua = navigator.userAgent || '';
    if (/Instagram/.test(ua)) return 'instagram';
    if (/FBAN|FBAV/.test(ua)) return 'facebook';
    if (/SamsungBrowser/.test(ua)) return 'samsung';
    if (/EdgA?\/|EdgiOS/.test(ua)) return 'edge';
    if (/OPR\/|Opera/.test(ua)) return 'opera';
    if (/Firefox|FxiOS/.test(ua)) return 'firefox';
    if (/Chrome|CriOS/.test(ua)) return 'chrome';
    if (/Safari/.test(ua)) return 'safari';
    return 'autre';
  }

  // ---------- Navigation privée ----------
  // Un navigateur en navigation privée oublie tout en se fermant : le visiteur reviendrait « nouveau » à
  // chaque fois. On le repère (même méthode que la bibliothèque detectIncognito) pour ne pas le compter
  // comme nouveau. Rien n'est envoyé d'autre qu'un compteur.
  const estIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  async function navigationPrivee() {
    try {
      const ua = navigator.userAgent || '';
      const webkit = estIOS() || (/Safari/.test(ua) && !/Chrome|Chromium|Edg|OPR|Android|Firefox/.test(ua));
      if (webkit) {
        if (navigator.storage && navigator.storage.getDirectory) {
          try { await navigator.storage.getDirectory(); return false; } catch (e) { return /unknown transient reason/i.test(String(e && e.message)); }
        }
        try { window.openDatabase(null, null, null, null); return false; } catch (e) { return true; }
      }
      if (/Firefox/.test(ua)) {
        if (navigator.storage && navigator.storage.getDirectory) {
          try { await navigator.storage.getDirectory(); return false; } catch (e) { return /security/i.test(String((e && (e.name + e.message)) || '')); }
        }
        return navigator.serviceWorker === undefined;
      }
      if (navigator.storage && navigator.storage.estimate) {
        // Chrome, Edge, Samsung… : en navigation privée, la place de stockage permise est très petite
        const { quota } = await navigator.storage.estimate();
        const limite = (performance.memory && performance.memory.jsHeapSizeLimit) || 1073741824;
        return typeof quota === 'number' && quota < limite * 2;
      }
    } catch (e) { /* rien */ }
    return false;
  }
  const prive = navigationPrivee();

  // ---------- Visite (session) : une visite s'arrête après 30 minutes sans rien ----------
  function visiteEnCours() {
    try {
      const v = JSON.parse(sessionStorage.getItem(CLE_VISITE) || 'null');
      if (v && v.id && Date.now() - v.dernier < 30 * 60000) return v;
    } catch (e) { /* rien */ }
    return null;
  }
  function noterVisite(v) { try { sessionStorage.setItem(CLE_VISITE, JSON.stringify(v)); } catch (e) { /* rien */ } }

  function compter(page) {
    pageCourante = page;
    if (horsJeu()) return;
    prive.then((enPrive) => compterVraiment(page, enPrive));
  }
  function compterVraiment(page, enPrive) {
    const memoire = stockage();
    if (!memoire) return;

    const maintenant = new Date();
    const jour = jourDe(maintenant);
    const mois = jour.slice(0, 7);
    const d = `${S}/jours/${jour}`;
    const maj = { [`${d}/vues`]: UN, [`${S}/total/vues`]: UN };
    const plus = {}; // compteurs ajoutés plus tard : envoyés à part (si la base n'a pas encore leurs règles, le reste compte quand même)

    // navigation privée : le navigateur ne se souvient pas des visites d'avant, ce n'est pas forcément un nouveau
    if (!memoire.vu && !enPrive) {
      maj[`${d}/nouveaux`] = UN;
      maj[`${S}/total/visiteurs`] = UN;
    }
    let pages = Array.isArray(memoire.pages) ? memoire.pages : [];
    if (memoire.jour !== jour) {
      const mobile = matchMedia('(pointer: coarse)').matches;
      maj[`${d}/visiteurs`] = UN;
      maj[`${d}/appareils/${mobile ? 'mobile' : 'ordi'}`] = UN;
      if (appli()) maj[`${d}/appli`] = UN;
      pages = [];
      plus[`${d}/systemes/${systeme()}`] = UN;
      if (enPrive) plus[`${d}/prives`] = UN;
      plus[`${d}/navigateurs/${navigateur()}`] = UN;
      // visiteur déjà venu un autre jour : fidélité
      if (memoire.jour && /^\d{4}-\d{2}-\d{2}$/.test(memoire.jour)) {
        const e = ecartJours(memoire.jour, jour);
        if (e > 0) {
          plus[`${d}/revenus`] = UN;
          plus[`${d}/retours/${e === 1 ? 'veille' : e <= 7 ? 'semaine' : e <= 30 ? 'mois' : 'plus'}`] = UN;
        }
      }
    }
    if (memoire.mois !== mois) maj[`${S}/mois/${mois}/visiteurs`] = UN;
    if (!pages.includes(page)) {
      maj[`${d}/pages/${page}`] = UN;
      pages.push(page);
    }

    // nouvelle visite : son heure et d'où elle vient
    let visite = visiteEnCours();
    if (!visite) {
      visite = { id: idAuHasard(), dernier: Date.now() };
      plus[`${d}/visites`] = UN;
      plus[`${d}/heures/${heureDe(maintenant)}`] = UN;
      plus[`${d}/sources/${sourceVisite()}`] = UN;
      if (Math.random() < 0.1) nettoyerDirect();
    }
    visite.dernier = Date.now();
    noterVisite(visite);
    idVisite = visite.id;

    // Noté avant l'envoi : si l'envoi échoue, on perd une visite plutôt que d'en compter deux
    try {
      localStorage.setItem(CLE, JSON.stringify({ vu: true, jour, mois, pages }));
    } catch (e) { return; }

    envoyer(maj);
    if (Object.keys(plus).length) envoyer(plus);
    signalerPresence();
  }

  // ---------- Temps passé sur chaque page (seulement quand elle est à l'écran) ----------
  let chrono = { page: pageCourante, depuis: document.hidden ? 0 : Date.now(), cumul: 0, comptee: false };
  function arreterChrono() {
    if (chrono.depuis) { chrono.cumul += Date.now() - chrono.depuis; chrono.depuis = 0; }
  }
  function envoyerTemps() {
    arreterChrono();
    const secondes = Math.min(1800, Math.round(chrono.cumul / 1000));
    chrono.cumul = 0;
    if (secondes < 1 || !lance || horsJeu() || !stockage()) return;
    const t = `${S}/jours/${jourDe(new Date())}/temps/${chrono.page}`;
    const maj = { [`${t}/s`]: PLUS(secondes) };
    if (!chrono.comptee) { maj[`${t}/n`] = UN; chrono.comptee = true; }
    envoyer(maj);
  }
  function changerChrono(page) {
    envoyerTemps();
    chrono = { page, depuis: document.hidden ? 0 : Date.now(), cumul: 0, comptee: false };
  }

  // ---------- En direct : les visites en cours ----------
  let idVisite = '';
  let minuteurPresence = 0;
  function signalerPresence() {
    if (!idVisite || document.hidden || horsJeu() || !stockage()) return;
    requete(`${S}/direct/${idVisite}`, 'PUT', { p: pageCourante, t: MAINTENANT });
    clearTimeout(minuteurPresence);
    minuteurPresence = setTimeout(signalerPresence, 30000);
  }
  function quitterPresence() {
    clearTimeout(minuteurPresence);
    if (idVisite && lance && !horsJeu()) requete(`${S}/direct/${idVisite}`, 'DELETE');
  }
  // de temps en temps, on efface les visites restées « en cours » (téléphone éteint sans quitter la page…)
  async function nettoyerDirect() {
    try {
      const r = await fetch(`${BASE}/${S}/direct.json?shallow=false`, { cache: 'no-store' });
      const liste = (await r.json()) || {};
      const limite = Date.now() - 10 * 60000;
      Object.entries(liste).forEach(([id, v]) => { if (!v || typeof v.t !== 'number' || v.t < limite) requete(`${S}/direct/${id}`, 'DELETE'); });
    } catch (e) { /* rien */ }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { envoyerTemps(); quitterPresence(); } else {
      chrono.depuis = Date.now();
      const v = visiteEnCours();
      if (v) { v.dernier = Date.now(); noterVisite(v); signalerPresence(); } else if (lance) compter(pageCourante); // retour après 30 min : nouvelle visite
    }
  });
  addEventListener('pagehide', () => { envoyerTemps(); quitterPresence(); });

  // ---------- Erreurs JavaScript du site ----------
  let nbErreurs = 0;
  const dejaVues = new Set();
  function noterErreur(message, fichier, ligne) {
    if (nbErreurs >= 3 || horsJeu() || !stockage()) return;
    message = String(message || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    if (!message || /^Script error\.?$/i.test(message) || dejaVues.has(message)) return;
    if (fichier) {
      try { if (new URL(fichier, location.href).origin !== location.origin) return; } catch (e) { return; } // extension, autre site
    }
    dejaVues.add(message);
    nbErreurs++;
    const jour = jourDe(new Date());
    let f = '';
    try { f = fichier ? `${new URL(fichier, location.href).pathname.split('/').pop() || 'page'}${ligne ? `:${ligne}` : ''}` : ''; } catch (e) { /* rien */ }
    envoyer({ [`${S}/jours/${jour}/erreurs/${pageCourante}`]: UN });
    envoyer({ [`${S}/jours/${jour}/bugs/${idAuHasard()}`]: { m: message, f: f.slice(0, 60) || '-', p: pageCourante, t: MAINTENANT } });
  }
  addEventListener('error', (e) => {
    if (e.target && e.target !== window) return; // image ou script introuvable : pas une erreur de code
    noterErreur(e.message || (e.error && e.error.message), e.filename, e.lineno);
  });
  addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    noterErreur(`Promesse rejetée : ${(r && (r.message || r)) || 'sans raison'}`, r && r.stack && (String(r.stack).match(/(https?:\/\/[^\s)]+?):(\d+):\d+/) || [])[1]);
  });

  // ---------- Actions (parties, téléchargements, clics…) ----------
  function action(nom, page, details) {
    const a = nettoyer(nom);
    const p = nettoyer(page) || pageCourante;
    if (!a || horsJeu() || !stockage()) return null;
    const jour = jourDe(new Date());
    envoyer({ [`${S}/jours/${jour}/actions/${a}/${p}`]: UN, [`${S}/total/actions/${a}/${p}`]: UN });
    // Journal : l'heure exacte de l'action (donnée par le serveur), pour le détail heure par heure.
    // Envoyé à part : si les règles de la base n'ont pas encore le journal, les compteurs marchent quand même.
    const id = idAuHasard().replace(/^(.{8})/, '$1-');
    const entree = { a, p, t: MAINTENANT };
    const m = details && Number(details.m);
    if (Number.isInteger(m) && m >= 1 && m <= 999) entree.m = m;
    const ref = { jour, id, m: entree.m || 0, j: '', d: 0, x: false };
    const file = [];
    enAttente.set(ref, file);
    const j = details && joueursValides(details.j);
    // les joueurs, la durée… sont envoyés une fois l'entrée notée (leurs règles demandent qu'elle existe)
    envoyer({ [`${S}/jours/${jour}/journal/${id}`]: entree }).then(() => {
      enAttente.delete(ref);
      if (j) ajouterJoueurs(ref, j);
      file.forEach((f) => f());
    });
    return ref;
  }
  // une mise à jour d'une entrée du journal, une fois l'entrée créée
  // (une référence gardée par le site, par exemple après un rechargement, est toujours prête)
  const enAttente = new WeakMap();
  const quandPret = (ref, f) => { const file = enAttente.get(ref); if (file) file.push(f); else f(); };

  const joueursValides = (j) => (typeof j === 'string' && /^[0-9]{1,2}(\+[0-9]{1,2})?$/.test(j) ? j : '');
  function ajouterJoueurs(ref, j) {
    const tout = ref.j ? `${ref.j},${j}` : j;
    if (tout.length > 3000) return;
    ref.j = tout;
    envoyer({ [`${S}/jours/${ref.jour}/journal/${ref.id}/j`]: tout });
  }

  // Nombre de manches jouées d'une partie déjà notée au journal (seulement s'il augmente)
  // (et, en option, les joueurs de cette manche : '3' ou '3+1' avec un bot)
  function manches(ref, n, joueurs) {
    n = Number(n);
    if (!ref || !ref.id || !Number.isInteger(n) || n < 1 || n > 999 || n <= ref.m || horsJeu()) return;
    ref.m = n;
    quandPret(ref, () => {
      envoyer({ [`${S}/jours/${ref.jour}/journal/${ref.id}/m`]: n });
      const j = joueursValides(joueurs);
      if (j) ajouterJoueurs(ref, j);
    });
  }

  // Durée (secondes, seulement si elle augmente) et fin d'une partie notée au journal
  function partie(ref, infos = {}) {
    if (!ref || !ref.id || horsJeu()) return;
    const maj = {};
    const d = Math.round(Number(infos.d));
    if (Number.isFinite(d) && d > (ref.d || 0) && d <= 86400) { maj.d = d; ref.d = d; }
    if (infos.x === true && !ref.x) { maj.x = true; ref.x = true; }
    if (!Object.keys(maj).length) return;
    const chemin = `${S}/jours/${ref.jour}/journal/${ref.id}`;
    // chacun à part : la règle de x refuse un second envoi, elle ne doit pas bloquer la durée
    quandPret(ref, () => Object.entries(maj).forEach(([k, val]) => envoyer({ [`${chemin}/${k}`]: val })));
  }

  // ---------- Contenus consultés (séries, articles…) et recherches ----------
  const vusCetteVisite = new Set();
  function contenu(type, id, titre) {
    const ty = nettoyer(type).slice(0, 20);
    const ident = nettoyer(id);
    if (!ty || !ident || horsJeu() || !stockage()) return;
    const cle = `${ty}/${ident}`;
    let vus = [];
    try { vus = JSON.parse(sessionStorage.getItem(`suivi-vus:${site}`) || '[]'); } catch (e) { /* rien */ }
    if (vus.includes(cle) || vusCetteVisite.has(cle)) return; // une fois par visite
    vusCetteVisite.add(cle);
    try { sessionStorage.setItem(`suivi-vus:${site}`, JSON.stringify([...vus, cle].slice(-300))); } catch (e) { /* rien */ }
    envoyer({ [`${S}/jours/${jourDe(new Date())}/contenus/${ty}/${ident}`]: UN });
    const nom = String(titre || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (nom) envoyer({ [`${S}/noms/${ty}/${ident}`]: nom }); // refusé s'il existe déjà : sans importance
  }
  function recherche(terme) {
    const t = String(terme || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 60);
    if (t.length < 2) return;
    contenu('recherche', nettoyer(t), t);
  }

  // Première page : comptée un peu après l'ouverture, pour ne pas ralentir le site
  let pageInitiale = pageCourante;
  let lance = false;
  const lancer = () => setTimeout(() => {
    lance = true;
    compter(pageInitiale);
    // temps de chargement de la page (de l'ouverture à la fin du chargement)
    try {
      const nav = performance.getEntriesByType('navigation')[0];
      const ms = nav && nav.loadEventEnd > 0 ? nav.loadEventEnd : Date.now() - DEBUT_CHARGEMENT;
      if (ms > 0 && ms < 60000 && stockage() && !horsJeu()) {
        const c = `${S}/jours/${jourDe(new Date())}/chargement`;
        envoyer({ [`${c}/ms`]: PLUS(Math.round(ms)), [`${c}/n`]: UN });
      }
    } catch (e) { /* rien */ }
  }, 1500);
  if (document.readyState === 'complete') lancer();
  else addEventListener('load', lancer, { once: true });

  // Onglets d'un site d'une seule page : window.suivi.page('nom-de-l-onglet')
  window.suivi = {
    page(nom) {
      const page = nettoyer(nom);
      if (!page) return;
      if (!lance) { pageInitiale = page; pageCourante = page; chrono.page = page; return; } // pas encore compté : c'est cette page qui le sera
      if (page !== chrono.page) changerChrono(page);
      compter(page);
    },
    action,
    manches,
    partie,
    contenu,
    recherche,
  };
})();
