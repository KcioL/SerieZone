import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  sendPasswordResetEmail, updateProfile, signOut, onAuthStateChanged,
  deleteUser, reauthenticateWithCredential, EmailAuthProvider
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, getDoc, getDocs, setDoc, deleteDoc, updateDoc, deleteField, writeBatch,
  onSnapshot, query, orderBy
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig, relaisTMDB } from "./firebase-config.js";

const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);

const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

const $ = (id) => document.getElementById(id);

let currentUser  = null;
let unsubscribe  = null;
let mode         = "login";
let listeCache   = [];
let ficheCourante = null;     // série affichée dans la fiche
let filtreStatut = "tous";
let categorieActive = null;

/* Les séries suivies sont rangées dans users/{uid}/series. */
const COLLECTION = "series";
const refSerie = (uid, id) => doc(db, "users", uid, COLLECTION, id);

/* ══════════════════ TMDB ══════════════════

   The Movie Database connaît toutes les séries, avec leurs saisons, leurs
   épisodes, leurs dates de diffusion et les plateformes françaises.

   Le site ne parle jamais directement à TMDB : il passe par le relais
   (dossier relais-tmdb/), qui garde la clé côté serveur. Ici, on n'a que
   l'adresse du relais, qui ne permet rien d'autre que lire des séries.
   ══════════════════════════════════════════ */

const IMG = "https://image.tmdb.org/t/p/";

const relaisPret = () => !!relaisTMDB && !/TON-|xxx/i.test(relaisTMDB);

async function tmdb(chemin, params = {}, essais = 2) {
  if (!relaisPret()) throw new Error("relais TMDB pas encore configuré");

  const url = new URL(relaisTMDB.replace(/\/+$/, "") + "/" + chemin);
  Object.entries({ language: "fr-FR", ...params }).forEach(([k, v]) => {
    if (v !== null && v !== undefined && v !== "") url.searchParams.set(k, v);
  });

  let res;
  try {
    res = await fetch(url);
  } catch {
    if (essais > 0) { await pause(1500); return tmdb(chemin, params, essais - 1); }
    throw new Error("connexion impossible");
  }

  // TMDB tolère une quarantaine d'appels par seconde ; l'import peut s'en approcher.
  if (res.status === 429 && essais > 0) {
    await pause(2000);
    return tmdb(chemin, params, essais - 1);
  }
  if (!res.ok) throw new Error(`TMDB a répondu ${res.status}`);
  return res.json();
}

/* Les noms de genres de TMDB ne sont qu'à moitié traduits (« War & Politics »,
   « Kids »…). On garde donc notre propre table, par identifiant. */
const GENRES = {
  10759: "Action & aventure", 16: "Animation", 35: "Comédie", 80: "Crime",
  99: "Documentaire", 18: "Drame", 10751: "Familial", 10762: "Jeunesse",
  9648: "Mystère", 10763: "Actualités", 10764: "Téléréalité",
  10765: "Science-fiction & fantastique", 10766: "Feuilleton",
  10767: "Talk-show", 10768: "Guerre & politique", 37: "Western"
};

// Ce qui encombre les listes sans être des séries qu'on « suit » : journaux,
// talk-shows, téléréalité et feuilletons quotidiens.
const SANS_BRUIT = "10763,10767,10764,10766";

const TYPES = {
  Scripted: "Série", Miniseries: "Mini-série", Documentary: "Documentaire",
  Reality: "Téléréalité", "Talk Show": "Talk-show", News: "Actualités", Video: "Vidéo"
};

const DIFFUSION = {
  "Returning Series": "en_cours", "In Production": "en_cours", "Planned": "a_venir",
  "Pilot": "a_venir", "Ended": "finie", "Canceled": "finie"
};

const affiche = (chemin, taille = "w342") => (chemin ? IMG + taille + chemin : "");

/* Saisons « régulières » seulement : la saison 0 de TMDB regroupe les
   bonus et épisodes spéciaux, qu'on ne compte pas dans la progression.

   Pour chaque saison, on distingue les épisodes annoncés de ceux déjà
   diffusés. TMDB liste souvent toute une saison avant sa sortie : sans cette
   distinction, quelqu'un d'à jour sur Severance se verrait « en retard » de
   dix épisodes qui n'existent pas encore. */
function lireSaisons(m) {
  const dernier = m.last_episode_to_air;
  return (m.seasons || [])
    .filter((s) => s.season_number > 0)
    .sort((a, b) => a.season_number - b.season_number)
    .map((s) => {
      let diffuses = 0;
      if (dernier) {
        if (s.season_number < dernier.season_number) diffuses = s.episode_count || 0;
        else if (s.season_number === dernier.season_number) diffuses = Math.min(dernier.episode_number, s.episode_count || dernier.episode_number);
      }
      return {
        numero: s.season_number,
        nom: s.name || `Saison ${s.season_number}`,
        total: s.episode_count || 0,
        diffuses,
        date: s.air_date || ""
      };
    });
}

const episodeCourt = (e) => e ? { saison: e.season_number, episode: e.episode_number, date: e.air_date || "" } : null;

/* Disponibilités en France, fournies par JustWatch via TMDB. TMDB ne donne
   pas un lien par plateforme, seulement une page qui les regroupe toutes. */
function lirePlateformes(wp) {
  const fr = wp?.results?.FR;
  if (!fr) return null;
  const garder = (l) => (l || []).map((p) => ({
    nom: p.provider_name, logo: affiche(p.logo_path, "w92"), rang: p.display_priority ?? 99
  }));
  const fusion = (...listes) => {
    const vus = new Set();
    return listes.flat().sort((a, b) => a.rang - b.rang)
      .filter((p) => !vus.has(p.nom) && vus.add(p.nom));
  };
  const abonnement = fusion(garder(fr.flatrate), garder(fr.free), garder(fr.ads));
  const achat = fusion(garder(fr.rent), garder(fr.buy))
    .filter((p) => !abonnement.some((a) => a.nom === p.nom));
  if (!abonnement.length && !achat.length) return null;
  return { lien: fr.link || "", abonnement, achat };
}

/* Une seule forme de série dans tout le site, qu'elle vienne d'une recherche
   (résumé court, sans saisons) ou d'une fiche complète (« complet »). */
const normaliser = (m) => {
  const saisons = m.seasons ? lireSaisons(m) : null;
  return {
    id:        String(m.id),
    title:     m.name || m.original_name || "Sans titre",
    original:  m.original_name || "",
    cover:     affiche(m.poster_path),
    resume:    (m.overview || "").trim(),
    genres:    (m.genres ? m.genres.map((g) => g.id) : m.genre_ids || [])
                 .map((id) => GENRES[id]).filter(Boolean),
    annee:     (m.first_air_date || "").slice(0, 4) || null,
    anneeFin:  (m.last_air_date || "").slice(0, 4) || null,
    debut:     m.first_air_date || "",
    statutDiff:m.status || "",
    diffusion: DIFFUSION[m.status] || (m.first_air_date && m.first_air_date > aujourdhui() ? "a_venir" : ""),
    type:      m.type || "",
    reseau:    m.networks?.[0]?.name || "",
    createurs: (m.created_by || []).map((c) => c.name).filter(Boolean),
    popularite:m.popularity || 0,
    saisons,
    episodes:  saisons ? saisons.reduce((n, s) => n + s.diffuses, 0) : 0,
    prochain:  episodeCourt(m.next_episode_to_air),
    liens:     lirePlateformes(m["watch/providers"]),
    complet:   !!saisons
  };
};

const aujourdhui = () => new Date().toISOString().slice(0, 10);
const dansJours = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

const avecAffiche = (liste) => liste.filter((m) => m.poster_path);

/* Deux pages à la fois : vingt résultats font une grille un peu maigre. */
async function deuxPages(chemin, params) {
  const pages = await Promise.all([1, 2].map((page) =>
    tmdb(chemin, { ...params, page }).catch(() => ({ results: [] }))));
  const vus = new Set();
  return pages.flatMap((p) => p.results || [])
    .filter((m) => !vus.has(m.id) && vus.add(m.id));
}

/* Ce qui sort cette semaine : des épisodes diffusés dans les sept jours, parmi
   des séries assez suivies pour que ça intéresse quelqu'un. */
async function cetteSemaine() {
  const liste = await deuxPages("discover/tv", {
    "air_date.gte": aujourdhui(), "air_date.lte": dansJours(7),
    sort_by: "popularity.desc", "vote_count.gte": 30,
    without_genres: SANS_BRUIT, include_null_first_air_dates: false
  });
  return avecAffiche(liste).slice(0, 24).map(normaliser);
}

/* Les nouvelles séries pas encore sorties, classées par popularité — c'est la
   mesure de l'attente chez TMDB. */
async function nouveautes() {
  const liste = await deuxPages("discover/tv", {
    "first_air_date.gte": dansJours(1), sort_by: "popularity.desc",
    without_genres: SANS_BRUIT
  });
  return avecAffiche(liste).slice(0, 24).map(normaliser);
}

const CATEGORIES = [
  { nom: "Tendances",       chemin: "trending/tv/week", note: "Les séries dont on parle le plus cette semaine." },
  { nom: "Les mieux notées", params: { sort_by: "vote_average.desc", "vote_count.gte": 2500 },
    note: "Les meilleures notes de TMDB, parmi les séries notées par au moins 2 500 personnes." },
  { nom: "Drame",           genre: 18 },
  { nom: "Crime",           genre: 80 },
  { nom: "SF & fantastique", genre: 10765 },
  { nom: "Comédie",         genre: 35 },
  { nom: "Action & aventure", genre: 10759 },
  { nom: "Mystère",         genre: 9648 },
  { nom: "Guerre & politique", genre: 10768 },
  { nom: "Mini-séries",     params: { with_type: 2 }, note: "Des histoires complètes en une seule saison." },
  { nom: "Documentaires",   genre: 99 },
  { nom: "Animation",       genre: 16 },
  { nom: "Familial",        genre: 10751 },
  { nom: "Western",         genre: 37 }
];

async function parCategorie(cat) {
  if (cat.chemin) {
    const d = await deuxPages(cat.chemin, {});
    return avecAffiche(d).map(normaliser);
  }
  const params = {
    sort_by: "popularity.desc", "vote_count.gte": 150,
    without_genres: SANS_BRUIT, ...cat.params
  };
  if (cat.genre) params.with_genres = cat.genre;
  if (cat.plateforme) {
    params.with_watch_providers = cat.plateforme;
    params.watch_region = "FR";
    params.with_watch_monetization_types = "flatrate|free|ads";
    params["vote_count.gte"] = 50;
  }
  const d = await deuxPages("discover/tv", params);
  return avecAffiche(d).map(normaliser);
}

/* Les plateformes disponibles en France, dans l'ordre où TMDB les met en avant. */
async function plateformesFR() {
  const d = await tmdb("watch/providers/tv", { watch_region: "FR" });
  return (d.results || [])
    .filter((p) => p.display_priorities?.FR !== undefined)
    .sort((a, b) => a.display_priorities.FR - b.display_priorities.FR)
    .slice(0, 10)
    .map((p) => ({ nom: p.provider_name, plateforme: p.provider_id,
                   note: `Séries disponibles sur ${p.provider_name} en France, par popularité.` }));
}

async function chercher(terme) {
  const d = await tmdb("search/tv", { query: terme, include_adult: false });
  return (d.results || []).map(normaliser);
}

/* Rouvrir la même fiche dans la session ne redemande rien : une série ne
   change pas de résumé en dix minutes. */
const ficheCache = new Map();

async function parIdentifiant(id, { frais = false } = {}) {
  if (!frais && ficheCache.has(id)) return ficheCache.get(id);

  const m = await tmdb(`tv/${id}`, { append_to_response: "watch/providers" });

  // Beaucoup de séries n'ont pas de résumé en français : on prend l'anglais.
  if (!m.overview) {
    try { m.overview = (await tmdb(`tv/${id}`, { language: "en-US" })).overview || ""; } catch {}
  }

  const a = normaliser(m);
  ficheCache.set(id, a);
  return a;
}

/* ══════════════════ Saisons et progression ══════════════════

   La progression est enregistrée comme un simple nombre d'épisodes vus
   (« vus »), tous comptés à la suite. Avec la liste des épisodes diffusés par
   saison (« saisons », par exemple [10, 10, 10, 10, 10, 10, 7, 6] pour Game of
   Thrones), on en déduit à tout moment la saison et l'épisode.

   Ce choix garde les compteurs simples — total d'épisodes vus, succès — et
   rend les rattrapages faciles : « j'ai fini la saison 3 » se traduit en un
   seul nombre.
   ══════════════════════════════════════════════════════════════ */

/* Saison et épisode du dernier épisode vu. */
function position(vus, saisons) {
  if (!Array.isArray(saisons) || !saisons.length) return null;
  let reste = vus;
  for (let i = 0; i < saisons.length; i++) {
    if (reste <= saisons[i]) return { saison: i + 1, episode: reste };
    reste -= saisons[i];
  }
  // Plus d'épisodes vus que de diffusés (données TMDB corrigées depuis) :
  // on s'arrête au dernier.
  const der = saisons.length - 1;
  return { saison: der + 1, episode: saisons[der] };
}

/* Nombre d'épisodes vus correspondant à « saison n, épisode e ». */
const vusJusqua = (saisons, n, e) =>
  saisons.slice(0, n - 1).reduce((t, x) => t + x, 0) + e;

/* Saisons entièrement vues. */
function saisonsVues(s) {
  if (!Array.isArray(s.saisons)) return 0;
  let cumul = 0, n = 0;
  for (const x of s.saisons) {
    if (!x) continue;
    cumul += x;
    if (s.vus >= cumul) n++;
  }
  return n;
}

const sxe = (saison, episode) => `S${saison} · É${episode}`;

/* « Où j'en suis », pour les cartes et la fiche. */
function texteOuJenSuis(s) {
  const total = s.episodes || 0;
  if (!s.vus && estTermine(s)) return "Vue en entier";
  if (!s.vus) return total ? `${total} épisode${total > 1 ? "s" : ""} à voir` : "Pas commencée";
  const p = position(s.vus, s.saisons);
  const pct = total ? ` · ${Math.min(100, Math.round((s.vus / total) * 100))} %` : "";
  if (p) return `${sxe(p.saison, p.episode)}${pct}`;
  return `${s.vus} / ${total || "?"} épisodes${pct}`;
}

const estAJour = (s) => s.episodes > 0 && s.vus >= s.episodes;
const estTermine = (s) => s.statut === "termine";

/* ══════════════════ Mise en forme ══════════════════ */

const MOIS = ["janvier","février","mars","avril","mai","juin",
              "juillet","août","septembre","octobre","novembre","décembre"];

function dateLongue(iso) {
  const [y, m, d] = String(iso || "").split("-").map(Number);
  if (y && m && d) return `${d === 1 ? "1er" : d} ${MOIS[m - 1]} ${y}`;
  if (y && m) return `${MOIS[m - 1]} ${y}`;
  if (y) return String(y);
  return "";
}

const dateDebut = (a) => dateLongue(a.debut) || "date inconnue";

/* TMDB ne donne que le jour de diffusion, pas l'heure. Un compte à rebours
   en jours suffit : « dans 3 jours » se comprend d'un coup d'œil. */
function quand(iso) {
  if (!iso) return "";
  const j = Math.round((Date.parse(iso + "T00:00:00") - Date.parse(aujourdhui() + "T00:00:00")) / 86400000);
  if (j < 0)  return `sorti le ${dateLongue(iso)}`;
  if (j === 0) return "aujourd'hui";
  if (j === 1) return "demain";
  if (j < 7)  return `dans ${j} jours`;
  if (j < 60) return `le ${dateLongue(iso).replace(/ \d{4}$/, "")}`;
  return `le ${dateLongue(iso)}`;
}

const majuscule = (t) => t ? t[0].toUpperCase() + t.slice(1) : t;

const nombreCourt = (n) =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(".", ",")} k` : String(n);

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ══════════════════ Authentification ══════════════════ */

/* Le site est consultable sans compte : « À venir », « Découvrir » et les
   fiches fonctionnent pour tout le monde. Un compte n'ouvre que le suivi
   personnel et la notation. L'application reste donc toujours affichée, et
   c'est l'état de connexion qui pilote les fonctions disponibles. */
onAuthStateChanged(auth, async (user) => {
  currentUser = user;

  $("app-screen").hidden = false;
  chargerAVenir();
  construireCategories();

  const connecte = !!user;
  $("user-email").hidden       = !connecte;
  $("logout").hidden           = !connecte;
  $("supprimer-compte").hidden = !connecte;
  $("ouvrir-connexion").hidden = connecte;
  $("ouvrir-login").hidden    = connecte;
  $("liste-invite").hidden     = connecte;
  $("liste-contenu").hidden    = !connecte;

  if (!connecte) {
    montrerAvatar(null);
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    listeCache = [];
    profilsCharges = false;
    diffusionsFaites = false;
    if (ficheCourante) majFiche();
    rafraichirCartes();
    afficherMesProchains();
    return;
  }

  fermerConnexion();
  $("user-email").textContent = user.displayName || user.email;
  suivreListe(user.uid);

  try {
    const profil = await getDoc(doc(db, "users", user.uid));
    if (profil.exists()) {
      if (profil.data().pseudo) $("user-email").textContent = profil.data().pseudo;
      montrerAvatar(profil.data().avatar);
    }
    chargerEtatPublication();
  } catch { /* le profil n'est pas indispensable à l'affichage */ }
});

/* ══════════════════ Fenêtre de connexion ══════════════════ */

/* motif : message d'explication quand l'ouverture est provoquée par une action
   qui exige un compte. modeVoulu : « signup » pour arriver directement sur la
   création, puisqu'un bouton « Créer un compte » qui ouvre l'écran de
   connexion demande un clic de plus pour rien. */
function ouvrirConnexion(motif, modeVoulu = "login") {
  $("auth-screen").hidden = false;
  showReset(false);
  appliquerMode(modeVoulu);
  if (motif) toast(motif);
  setTimeout(() => $("email").focus(), 100);
}

function fermerConnexion() {
  $("auth-screen").hidden = true;
  hideError();
}

$("ouvrir-connexion").addEventListener("click", () => ouvrirConnexion(null, "signup"));
$("ouvrir-login").addEventListener("click", () => ouvrirConnexion(null, "login"));
document.querySelectorAll(".deja-compte").forEach((b) =>
  b.addEventListener("click", () => ouvrirConnexion(null, "login")));
$("invite-connexion").addEventListener("click", () => ouvrirConnexion(null, "signup"));
$("auth-fermer").addEventListener("click", fermerConnexion);

// Clic sur le fond, ou touche Échap : deux façons attendues de refermer.
$("auth-screen").addEventListener("click", (e) => {
  if (e.target === $("auth-screen")) fermerConnexion();
});

addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("auth-screen").hidden) fermerConnexion();
});

/* Un seul endroit décide de l'apparence du formulaire. Le bouton de bascule et
   l'ouverture directe en création passent tous les deux par ici, sans quoi les
   deux chemins finissent par diverger. */
function appliquerMode(m) {
  mode = m;
  const signup = m === "signup";

  $("auth-titre").textContent       = signup ? "Créer ton compte" : "Se connecter";
  $("auth-submit").textContent      = signup ? "Créer mon compte" : "Se connecter";
  $("auth-switch-text").textContent = signup ? "Tu as déjà un compte ?" : "Pas encore de compte ?";
  $("auth-toggle").textContent      = signup ? "Se connecter" : "Créer un compte";
  $("password").autocomplete        = signup ? "new-password" : "current-password";
  $("auth-forgot-wrap").hidden      = signup;
  $("pseudo-field").hidden          = !signup;
  $("pseudo").required              = signup;
  $("avatar-field").hidden          = !signup;
  hideError();
}

$("auth-toggle").addEventListener("click", () =>
  appliquerMode(mode === "login" ? "signup" : "login"));

/* ══════════════════ Avatars ══════════════════

   Six images posées dans le dossier « avatar/ ». C'est la seule liste à
   modifier pour en ajouter, en retirer ou en renommer : le formulaire se
   construit à partir d'elle, et les règles Firestore n'acceptent qu'un
   identifiant de cette forme.
   ═════════════════════════════════════════════ */

const AVATARS = ["femme_1", "femme_2", "femme_3", "homme_1", "homme_2", "homme_3"];

const cheminAvatar = (id) => `avatar/${id}.png`;

let avatarChoisi = null;

(function construireAvatars() {
  const zone = $("avatar-choix");

  AVATARS.forEach((id) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "avatar-option";
    btn.setAttribute("aria-pressed", "false");
    btn.setAttribute("aria-label", `Avatar ${id.replace("_", " ")}`);

    const img = document.createElement("img");
    img.src = cheminAvatar(id);
    img.alt = "";
    img.loading = "lazy";
    btn.appendChild(img);

    btn.addEventListener("click", () => {
      // Recliquer sur le même avatar l'enlève : le choix reste facultatif.
      avatarChoisi = avatarChoisi === id ? null : id;
      zone.querySelectorAll(".avatar-option").forEach((b, i) => {
        const actif = AVATARS[i] === avatarChoisi;
        b.classList.toggle("is-active", actif);
        b.setAttribute("aria-pressed", String(actif));
      });
    });

    zone.appendChild(btn);
  });
})();

/* Affiche l'avatar à côté du pseudo. Un compte sans avatar — les anciens, ou
   ceux qui n'en ont pas voulu — se contente de son pseudo. */
function montrerAvatar(id) {
  const img = $("user-avatar");
  const valide = id && AVATARS.includes(id);
  img.hidden = !valide;
  if (valide) img.src = cheminAvatar(id);
}

$("auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  hideError();

  const email = $("email").value.trim();
  const pass  = $("password").value;

  if (!email || pass.length < 6) {
    return showError("Il faut une adresse valide et un mot de passe d'au moins 6 caractères.");
  }

  $("auth-submit").disabled = true;
  try {
    if (mode === "signup") await creerCompte(email, pass);
    else await signInWithEmailAndPassword(auth, email, pass);
    $("auth-form").reset();
  } catch (err) {
    if (err.message === "pseudo-invalide") {
      showError("Le pseudo doit faire 3 à 20 caractères, sans espace ni accent.");
    } else if (err.message === "pseudo-pris") {
      showError("Ce pseudo est déjà utilisé. Choisis-en un autre.");
    } else {
      console.error("Firebase Auth :", err.code, err.message, err);
      showError(authMessage(err.code));
    }
  } finally {
    $("auth-submit").disabled = false;
  }
});

/* Le pseudo est réservé dans une collection dédiée : l'identifiant du document
   étant le pseudo en minuscules, Firestore garantit son unicité. */
async function creerCompte(email, pass) {
  const pseudo = $("pseudo").value.trim();
  if (!/^[a-zA-Z0-9_-]{3,20}$/.test(pseudo)) throw new Error("pseudo-invalide");

  const cle = pseudo.toLowerCase();
  if ((await getDoc(doc(db, "usernames", cle))).exists()) throw new Error("pseudo-pris");

  const { user } = await createUserWithEmailAndPassword(auth, email, pass);

  try {
    const profil = { pseudo, createdAt: Date.now() };
    // Champ absent plutôt que vide : les règles refusent une valeur inconnue,
    // et un compte sans avatar est un cas normal.
    if (avatarChoisi) profil.avatar = avatarChoisi;

    await setDoc(doc(db, "usernames", cle), { uid: user.uid });
    await setDoc(doc(db, "users", user.uid), profil);
    await updateProfile(user, { displayName: pseudo });
    $("user-email").textContent = pseudo;
    montrerAvatar(avatarChoisi);
  } catch (err) {
    console.error("Enregistrement du pseudo :", err.code, err.message);
    toast("Compte créé, mais le pseudo n'a pas pu être enregistré.");
  }
}

$("logout").addEventListener("click", () => signOut(auth));

function authMessage(code) {
  const messages = {
    "auth/email-already-in-use": "Cette adresse a déjà un compte. Connecte-toi.",
    "auth/invalid-email":        "Cette adresse e-mail n'est pas valide.",
    "auth/weak-password":        "Le mot de passe doit faire au moins 6 caractères.",
    "auth/invalid-credential":   "Adresse ou mot de passe incorrect — ou aucun compte pour cette adresse.",
    "auth/too-many-requests":    "Trop de tentatives. Réessaie dans quelques minutes.",
    "auth/network-request-failed": "Connexion au serveur impossible.",
    "auth/operation-not-allowed": "Active le fournisseur E-mail/Mot de passe dans la console Firebase.",
    "auth/unauthorized-domain":  "Ce domaine n'est pas autorisé dans Authentication → Settings."
  };
  return messages[code] || `Échec de l'opération. Code renvoyé : ${code || "inconnu"}`;
}

const showError = (msg) => {
  const el = $("auth-error");
  el.textContent = msg; el.classList.remove("is-note"); el.hidden = false;
};
const hideError = () => {
  const el = $("auth-error"); el.hidden = true; el.classList.remove("is-note");
};

/* ══════════════════ Mot de passe oublié ══════════════════ */

$("auth-forgot").addEventListener("click", () => showReset(true));
$("reset-back").addEventListener("click", () => showReset(false));

function showReset(on) {
  $("login-view").hidden = on;
  $("reset-view").hidden = !on;
  hideError(); hideResetError();
  if (on) { $("reset-form").reset(); $("reset-email").focus(); }
}

$("reset-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  hideResetError();
  const email = $("reset-email").value.trim();
  if (!email) { $("reset-email").focus(); return showResetError("Saisis l'adresse de ton compte."); }

  $("reset-submit").disabled = true;
  try {
    await sendPasswordResetEmail(auth, email);
    confirmSent();
  } catch (err) {
    // On ne révèle pas si l'adresse a un compte : même message dans les deux cas.
    if (err.code === "auth/user-not-found") confirmSent();
    else showResetError(authMessage(err.code));
  } finally {
    $("reset-submit").disabled = false;
  }
});

function confirmSent() {
  showResetError("Si un compte existe pour cette adresse, un lien vient d'y être envoyé. Regarde aussi dans les indésirables.");
  $("reset-error").classList.add("is-note");
  $("reset-form").reset();
}

const showResetError = (msg) => {
  const el = $("reset-error");
  el.textContent = msg; el.classList.remove("is-note"); el.hidden = false;
};
const hideResetError = () => {
  const el = $("reset-error"); el.hidden = true; el.classList.remove("is-note");
};

/* ══════════════════ Navigation ══════════════════ */

document.querySelectorAll("[data-vue]").forEach((btn) => {
  btn.addEventListener("click", () => showView(btn.dataset.vue));
});

$("fiche-retour").addEventListener("click", () => showView(vuePrecedente));

let vuePrecedente = "avenir";
let vueAffichee   = "avenir";

/* Position de défilement de chaque vue. Ouvrir une série depuis le bas d'une
   liste de trois cents jaquettes puis revenir tout en haut oblige à refaire
   tout le chemin — et à retrouver de mémoire où l'on en était. */
const defilements = {};

function showView(nom) {
  // On note où l'on en était avant de quitter la vue courante.
  if (vueAffichee) defilements[vueAffichee] = window.scrollY;
  vueAffichee = nom;

  if (nom !== "fiche" && nom !== "profil") vuePrecedente = nom;

  $("view-avenir").hidden    = nom !== "avenir";
  $("view-decouvrir").hidden = nom !== "decouvrir";
  $("view-succes").hidden    = nom !== "succes";
  $("view-profils").hidden   = nom !== "profils";
  $("view-profil").hidden    = nom !== "profil";
  $("view-liste").hidden     = nom !== "liste";
  $("view-fiche").hidden     = nom !== "fiche";

  /* Ni la fiche ni le profil d'un membre n'ont d'onglet à eux : on garde en
     surbrillance celui d'où l'on vient. */
  const onglet = (nom === "fiche" || nom === "profil") ? vuePrecedente : nom;

  document.querySelectorAll("[data-vue]").forEach((btn) => {
    const actif = btn.dataset.vue === onglet;
    btn.classList.toggle("is-active", actif);
    btn.setAttribute("aria-current", actif ? "page" : "false");
  });

  if (nom === "profils") chargerProfils();
  if (nom === "succes")  afficherSucces();

  /* L'ordre est lu dans la barre elle-même. Une liste écrite à la main finit
     toujours par mentir : en insérant l'onglet Succès en troisième position
     dans le HTML sans le déplacer dans la liste, le curseur se posait sur
     « Ma liste » pendant qu'on ouvrait les succès. */
  const barre = document.querySelector(".barre-basse");
  const rang = [...(barre?.querySelectorAll(".onglet-bas") || [])]
    .findIndex((b) => b.dataset.vue === onglet);
  if (rang >= 0) barre.style.setProperty("--onglet", rang);

  if (nom !== "fiche") ficheCourante = null;

  /* Une fiche ou un profil qu'on vient d'ouvrir commence en haut : c'est un
     contenu neuf. Une liste retrouvée reprend là où on l'avait laissée.
     Le report à la trame suivante laisse au navigateur le temps de calculer
     la hauteur de la grille qu'on vient de réafficher. */
  const cible = (nom === "fiche" || nom === "profil") ? 0 : (defilements[nom] || 0);
  requestAnimationFrame(() => window.scrollTo(0, cible));

  // Comptage des visites par onglet pour le tableau de bord (voir suivi.js)
  window.suivi?.page(nom);
}

/* ══════════════════ À venir ══════════════════

   Trois blocs, du plus personnel au plus général : les prochains épisodes de
   tes séries, ce qui passe cette semaine, puis les nouvelles séries attendues.
   ══════════════════════════════════════════════ */

let avenirCharge = false;

async function chargerAVenir() {
  if (avenirCharge) return;
  avenirCharge = true;

  const blocs = [
    { grille: $("semaine-liste"), source: cetteSemaine, genre: "semaine" },
    { grille: $("avenir-liste"),  source: nouveautes,   genre: "avenir" }
  ];

  await Promise.all(blocs.map(async ({ grille, source, genre }) => {
    grille.innerHTML = `<p class="loading">Chargement…</p>`;
    try {
      const series = await source();
      grille.innerHTML = "";
      if (!series.length) grille.innerHTML = `<p class="loading">Rien pour le moment.</p>`;
      series.forEach((a) => grille.appendChild(carte(a, genre)));
    } catch (err) {
      avenirCharge = false;
      console.error("À venir :", err);
      grille.innerHTML = `<p class="loading">Indisponible pour le moment (${escapeHtml(err.message)}).</p>`;
    }
  }));
}

/* Les prochains épisodes de tes séries viennent de ta liste : leurs dates sont
   rafraîchies en arrière-plan (voir majDiffusions), sans requête ici. */
function afficherMesProchains() {
  const zone = $("mes-prochains");
  const bloc = $("bloc-mes-prochains");
  const auj = aujourdhui();

  const prochains = listeCache
    .filter((s) => s.prochain?.date && s.prochain.date >= auj && s.statut !== "abandonne")
    .sort((a, b) => a.prochain.date.localeCompare(b.prochain.date) || parTitre(a, b));

  bloc.hidden = !currentUser || !prochains.length;
  zone.innerHTML = "";
  prochains.slice(0, 18).forEach((s) => {
    const el = carte({ id: s.id, title: s.title, cover: s.cover, annee: null, genres: s.genres || [] }, "prochain", s);
    zone.appendChild(el);
  });
}

/* ══════════════════ Découvrir ══════════════════ */

let plateformesChargees = false;

function construireCategories() {
  const zone = $("categories");
  if (zone.children.length) return;

  CATEGORIES.forEach((cat, i) => zone.appendChild(puceCategorie(cat, i === 0)));
  categorieActive = CATEGORIES[0];
  chargerCategorie();
  construirePlateformes();
}

function puceCategorie(cat, active = false) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `categorie ${active ? "is-active" : ""}`;
  btn.textContent = cat.nom;
  btn.addEventListener("click", () => {
    categorieActive = cat;
    document.querySelectorAll(".categorie").forEach((b) => b.classList.remove("is-active"));
    btn.classList.add("is-active");
    chargerCategorie();
  });
  return btn;
}

async function construirePlateformes() {
  if (plateformesChargees) return;
  plateformesChargees = true;
  try {
    const liste = await plateformesFR();
    const zone = $("plateformes-categories");
    liste.forEach((cat) => zone.appendChild(puceCategorie(cat)));
    $("bloc-plateformes").hidden = !liste.length;
  } catch (err) {
    plateformesChargees = false;
    console.warn("Plateformes :", err.message);
  }
}

async function chargerCategorie() {
  const cat = categorieActive;
  const grille = $("categorie-liste");

  $("categorie-note").textContent = cat.note || `Genre « ${cat.nom} », classé par popularité.`;
  grille.innerHTML = `<p class="loading">Chargement…</p>`;

  try {
    const series = await parCategorie(cat);
    if (categorieActive !== cat) return;    // un autre choix a pris le relais
    grille.innerHTML = "";
    if (!series.length) {
      grille.innerHTML = `<p class="loading">Aucun résultat pour cette catégorie.</p>`;
      return;
    }
    series.forEach((a) => grille.appendChild(carte(a, "populaire")));
  } catch (err) {
    if (categorieActive !== cat) return;
    console.error("Catégorie :", err);
    grille.innerHTML = `<p class="loading">Indisponible (${escapeHtml(err.message)}).</p>`;
  }
}

/* ══════════════════ Recherche ══════════════════ */

let minuteur = null, jeton = 0;

$("search-input").addEventListener("input", () => {
  const terme = $("search-input").value.trim();
  clearTimeout(minuteur);

  if (terme.length < 2) {
    jeton++;
    $("search-results").hidden = true;
    $("search-input").classList.remove("is-searching");
    return;
  }

  $("search-input").classList.add("is-searching");
  minuteur = setTimeout(() => lancerRecherche(terme), 350);
  // Tableau de bord : la recherche est comptée quand on s'arrête d'écrire (pas chaque lettre)
  clearTimeout(minuteurRechercheSuivie);
  minuteurRechercheSuivie = setTimeout(() => window.suivi?.recherche(terme), 2000);
});
let minuteurRechercheSuivie = null;

$("search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  clearTimeout(minuteur);
  const terme = $("search-input").value.trim();
  clearTimeout(minuteurRechercheSuivie);
  if (terme) { lancerRecherche(terme); window.suivi?.recherche(terme); }
});

async function lancerRecherche(terme) {
  const mien = ++jeton;
  const box = $("search-results");
  box.hidden = false;

  try {
    const series = await chercher(terme);
    if (mien !== jeton) return;   // une frappe plus récente a pris le relais

    box.innerHTML = `<h2 class="section-title">Résultats</h2>`;
    if (!series.length) {
      box.innerHTML += `<p class="section-note">Rien pour « ${escapeHtml(terme)} ».</p>`;
      return;
    }
    const grille = document.createElement("div");
    grille.className = "grille";
    series.forEach((a) => grille.appendChild(carte(a, "populaire")));
    box.appendChild(grille);
  } catch (err) {
    if (mien !== jeton) return;
    box.innerHTML = `<p class="section-note">Recherche impossible : ${escapeHtml(err.message)}.</p>`;
  } finally {
    if (mien === jeton) $("search-input").classList.remove("is-searching");
  }
}

/* ══════════════════ Cartes ══════════════════ */

/* Une série saisie à la main n'a pas toujours d'image. Un <img src=""> fait
   afficher au navigateur son icône d'image cassée : on met un carré aux
   initiales à la place, qui a au moins l'air voulu. */
const initiales = (titre) => String(titre || "?")
  .split(/\s+/).filter(Boolean).slice(0, 2)
  .map((m) => m[0]).join("").toUpperCase() || "?";

const jaquette = (url, titre) => url
  ? `<img src="${escapeHtml(url)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
  : `<span class="carte-sans-image">${escapeHtml(initiales(titre))}</span>`;

/* Badge en haut de la jaquette : l'état de ta progression, d'un coup d'œil. */
function badgeSuivi(s) {
  if (!s) return "";
  if (estTermine(s)) return `<span class="carte-suivi">Terminée</span>`;
  if (s.statut === "en_cours" && estAJour(s)) return `<span class="carte-suivi est-ajour">À jour</span>`;
  return `<span class="carte-suivi">Suivie</span>`;
}

function carte(a, genre, suiviForce = null) {
  const suivi = suiviForce || listeCache.find((s) => s.id === a.id);

  let bandeau = "", chaud = false;
  if (genre === "avenir") {
    bandeau = a.debut ? majuscule(quand(a.debut)) : "Date à venir";
    chaud = true;
  } else if (genre === "prochain" && suivi?.prochain) {
    bandeau = `${sxe(suivi.prochain.saison, suivi.prochain.episode)} ${quand(suivi.prochain.date)}`;
    chaud = true;
  } else if (suivi) {
    bandeau = texteOuJenSuis(suivi);
  }

  const meta = [a.annee, a.genres?.[0]].filter(Boolean).join(" · ");

  const el = document.createElement("button");
  el.type = "button";
  el.className = "carte";
  el.dataset.serie = a.id;
  el.innerHTML = `
    <span class="carte-img">
      ${jaquette(a.cover, a.title)}
      ${genre === "prochain" ? "" : badgeSuivi(suivi)}
      ${bandeau ? `<span class="carte-bandeau${chaud ? " est-chaud" : ""}">${escapeHtml(bandeau)}</span>` : ""}
    </span>
    <span class="carte-nom">${escapeHtml(a.title)}</span>
    <span class="carte-meta">${escapeHtml(meta)}</span>
    <span class="carte-note">${texteNote(suivi)}</span>`;

  if (genre === "prochain") el.__suivi = suivi;
  else el.__serie = a;
  return el;
}

/* Un seul écouteur pour toutes les cartes, posé sur le document.

   Les grilles sont reconstruites de fond en comble : « Ma liste » à chaque
   retour de Firestore, les résultats de recherche à chaque frappe. Si la
   reconstruction tombe entre le moment où le doigt touche l'écran et celui
   où il le quitte, la carte touchée n'existe plus, et un écouteur posé sur
   elle serait parti avec elle. Un écouteur délégué survit à tout. */
document.addEventListener("click", (ev) => {
  const el = ev.target.closest?.(".carte");
  if (!el) return;

  if (el.__apercu) return ouvrirApercu(el.__apercu);
  if (el.__suivi)  return ouvrirEtCompleter(depuisSuivi(el.__suivi));
  if (el.__serie)  return ouvrirEtCompleter(el.__serie);
});

/* On ouvre immédiatement avec ce qu'on a déjà — titre, jaquette, progression,
   note — puis la fiche complète (saisons, plateformes, résumé) arrive et
   complète l'affichage sur place. Si entre-temps tu es reparti ailleurs, la
   réponse est ignorée : elle ne doit pas écraser la fiche que tu regardes. */
async function ouvrirEtCompleter(base) {
  ouvrirFiche(base);
  if (base.locale || base.complet) return;

  if (!base.resume) $("fiche-resume").textContent = "Chargement des détails…";
  try {
    const complet = await parIdentifiant(base.id);
    if (ficheCourante?.id !== base.id) return;
    ficheCourante = complet;
    majFiche();
    synchroniser(complet);
  } catch (err) {
    console.warn("Fiche :", err.message);
    if (ficheCourante?.id === base.id && !ficheCourante.resume) $("fiche-resume").textContent = "";
  }
}

/* Une série suivie garde en mémoire ses saisons et sa date de prochain
   épisode. Quand TMDB en sait plus — un épisode est sorti, une saison est
   annoncée, la série s'est arrêtée — on met la liste à jour. */
function champsDiffusion(a) {
  return {
    episodes: a.episodes || 0,
    saisons:  (a.saisons || []).map((s) => s.diffuses).slice(0, 80),
    finie:    a.diffusion === "finie",
    prochain: a.prochain || null,
    genres:   (a.genres || []).slice(0, 12),
    format:   (a.type || "").slice(0, 20),
    majAt:    Date.now()
  };
}

async function synchroniser(a) {
  if (!currentUser || !a?.complet) return;
  const s = listeCache.find((x) => x.id === a.id);
  if (!s) return;

  const neuf = champsDiffusion(a);
  const change =
    neuf.episodes !== s.episodes ||
    JSON.stringify(neuf.saisons) !== JSON.stringify(s.saisons || []) ||
    neuf.finie !== !!s.finie ||
    JSON.stringify(neuf.prochain) !== JSON.stringify(s.prochain || null);

  const maj = change ? neuf : { majAt: neuf.majAt };
  if (!s.cover && a.cover) maj.cover = a.cover;

  try { await updateDoc(refSerie(currentUser.uid, s.id), maj); }
  catch (err) { console.warn("Synchronisation :", err.code, err.message); }
}

/* Une fois par visite, on rafraîchit en arrière-plan les séries encore en
   diffusion : c'est ce qui fait apparaître les nouveaux épisodes et les dates
   des prochains, sans avoir à rouvrir chaque fiche. Une série vérifiée il y a
   moins de douze heures est laissée tranquille. */
let diffusionsFaites = false;

async function majDiffusions() {
  if (diffusionsFaites || !currentUser || !relaisPret()) return;
  diffusionsFaites = true;

  const limite = Date.now() - 12 * 3600 * 1000;
  const aVerifier = listeCache
    .filter((s) => !estLocale(s.id) && !s.finie && s.statut !== "abandonne" && (s.majAt || 0) < limite)
    .sort((a, b) => (a.majAt || 0) - (b.majAt || 0))
    .slice(0, 80);

  await enParallele(aVerifier, 3, async (s) => {
    try { await synchroniser(await parIdentifiant(s.id, { frais: true })); }
    catch (err) { console.warn("Diffusion de", s.title, ":", err.message); }
  });
}

/* Traite une liste avec au plus « n » tâches à la fois. */
async function enParallele(liste, n, tache) {
  let i = 0;
  const ouvrier = async () => { while (i < liste.length) await tache(liste[i++], i - 1); };
  await Promise.all(Array.from({ length: Math.min(n, liste.length) }, ouvrier));
}

/* ══════════════════ Ma liste ══════════════════ */

function suivreListe(uid) {
  $("loading").hidden = false;
  const q = query(collection(db, "users", uid, COLLECTION), orderBy("addedAt", "asc"));

  unsubscribe = onSnapshot(q, (snap) => {
    $("loading").hidden = true;
    listeCache = snap.docs.map((d) => d.data());
    afficherListe();
    if (ficheCourante) majFiche();
    rafraichirCartes();
    majPublication();
    if (!$("view-succes").hidden) afficherSucces();
    planifierVitrine();   // les compteurs publiés suivent la liste
    afficherMesProchains();
    majDiffusions();      // une fois par visite, en arrière-plan
  }, (err) => {
    console.error("Firestore :", err.code, err.message);
    $("loading").textContent = "Impossible de lire ta liste. Vérifie les règles Firestore.";
  });
}

document.querySelectorAll(".filtre").forEach((btn) => {
  btn.addEventListener("click", () => {
    filtreStatut = btn.dataset.statut;
    document.querySelectorAll(".filtre").forEach((b) => b.classList.remove("is-active"));
    btn.classList.add("is-active");
    afficherListe();
  });
});

/* ══════════════════ Tri des listes ══════════════════

   Le même tri sert à ta liste et à celle d'un profil consulté : c'est une
   préférence de lecture, pas une propriété des données. Elle est retenue d'une
   visite à l'autre.
   ════════════════════════════════════════════════════ */

const TRIS = {
  defaut: "En cours d'abord",
  ajout:  "Ordre d'ajout",
  recent: "Ajouts récents",
  alpha:  "Alphabétique"
};

let rechercheListe = "";

$("liste-recherche").addEventListener("input", (e) => {
  rechercheListe = e.target.value;
  afficherListe();
});

let triCourant = "defaut";
try { triCourant = localStorage.getItem("seriezone-tri") || "defaut"; } catch {}
if (!TRIS[triCourant]) triCourant = "defaut";

const parTitre = (a, b) =>
  a.title.localeCompare(b.title, "fr", { sensitivity: "base", numeric: true });

function trier(liste) {
  const copie = [...liste];

  // Les séries en cours d'abord : c'est ce qu'on vient consulter.
  const rang = (s) => (s.statut === "en_cours" ? 0 : s.statut === "a_voir" ? 1 : 2);

  switch (triCourant) {
    case "alpha":  return copie.sort(parTitre);
    case "ajout":  return copie.sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0) || parTitre(a, b));
    case "recent": return copie.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0) || parTitre(a, b));
    default:       return copie.sort((a, b) => rang(a) - rang(b) || parTitre(a, b));
  }
}

/* Un <select> natif ne se style pas : la liste qui s'ouvre est dessinée par le
   système, blanche et carrée au milieu d'une interface sombre. On construit
   donc le menu à la main — un bouton et un panneau — pour qu'il ressemble au
   reste du site. Le comportement clavier et les rôles ARIA reproduisent ce que
   le select offrait gratuitement. */
const rappelsTri = [];

function construireTri(id, auChangement) {
  const hote = $(id);
  hote.innerHTML = "";

  const bouton = document.createElement("button");
  bouton.type = "button";
  bouton.className = "tri-bouton";
  bouton.setAttribute("aria-haspopup", "listbox");
  bouton.setAttribute("aria-expanded", "false");
  bouton.setAttribute("aria-label", hote.dataset.libelle || "Trier");
  bouton.innerHTML = `
    <svg class="tri-icone" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 5v14M7 19l-3-3M7 19l3-3M17 19V5M17 5l-3 3M17 5l3 3"/>
    </svg>
    <span class="tri-valeur"></span>
    <svg class="tri-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>`;

  const menu = document.createElement("div");
  menu.className = "tri-menu";
  menu.setAttribute("role", "listbox");
  menu.hidden = true;

  const lignes = Object.entries(TRIS).map(([cle, libelle]) => {
    const opt = document.createElement("button");
    opt.type = "button";
    opt.className = "tri-option";
    opt.setAttribute("role", "option");
    opt.innerHTML = `<span>${libelle}</span>
      <svg class="tri-coche" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12.5l5 5L20 6.5"/></svg>`;
    opt.addEventListener("click", () => {
      triCourant = cle;
      try { localStorage.setItem("seriezone-tri", triCourant); } catch {}
      fermerTris();
      rappelsTri.forEach((f) => f());     // les deux menus suivent le même choix
    });
    menu.appendChild(opt);
    return { cle, opt };
  });

  const peindre = () => {
    bouton.querySelector(".tri-valeur").textContent = TRIS[triCourant];
    lignes.forEach(({ cle, opt }) => {
      const actif = cle === triCourant;
      opt.classList.toggle("is-active", actif);
      opt.setAttribute("aria-selected", String(actif));
    });
  };

  bouton.addEventListener("click", (e) => {
    e.stopPropagation();
    const ouvert = !menu.hidden;
    fermerTris();
    if (!ouvert) {
      menu.hidden = false;
      bouton.setAttribute("aria-expanded", "true");
      lignes.find((l) => l.cle === triCourant)?.opt.focus();
    }
  });

  hote.append(bouton, menu);
  peindre();

  rappelsTri.push(() => { peindre(); auChangement(); });
  return peindre;
}

function fermerTris() {
  document.querySelectorAll(".tri-menu").forEach((m) => { m.hidden = true; });
  document.querySelectorAll(".tri-bouton").forEach((b) =>
    b.setAttribute("aria-expanded", "false"));
}

document.addEventListener("click", fermerTris);
addEventListener("keydown", (e) => { if (e.key === "Escape") fermerTris(); });

construireTri("tri-liste", () => afficherListe());
construireTri("tri-profil", () => afficherListeProfil());

function afficherListe() {
  const grille = $("liste");
  grille.innerHTML = "";

  $("stats").hidden = listeCache.length === 0;

  const episodes = listeCache.reduce((n, s) => n + s.vus, 0);
  const termines = listeCache.filter(estTermine).length;

  $("stat-suivis").textContent   = listeCache.length;
  $("stat-episodes").textContent = episodes;
  $("stat-termines").textContent = termines;

  /* La recherche est purement locale : la liste est déjà en mémoire, aucune
     requête n'est nécessaire. Le titre est normalisé des deux côtés — sans
     accents ni ponctuation — pour que « re zero » trouve « Re:ZERO ». */
  const cherche = cleTitre(rechercheListe);

  const visibles = trier(listeCache
    .filter((s) => filtreStatut === "tous" || s.statut === filtreStatut)
    .filter((s) => !cherche || cleTitre(s.title).includes(cherche)));

  if (listeCache.length === 0) {
    $("liste-vide").textContent =
      "Rien ici pour l'instant. Passe par À venir ou Découvrir pour ajouter une série.";
    $("liste-vide").hidden = false;
  } else if (visibles.length === 0) {
    $("liste-vide").textContent = cherche
      ? `Aucune série de ta liste ne correspond à « ${rechercheListe.trim()} ».`
      : "Aucune série avec ce statut.";
    $("liste-vide").hidden = false;
  } else {
    $("liste-vide").hidden = true;
  }

  visibles.forEach((s) => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "carte";
    el.dataset.serie = s.id;

    const badge = estTermine(s) ? `<span class="carte-suivi">Terminée</span>`
      : (s.statut === "en_cours" && estAJour(s) ? `<span class="carte-suivi est-ajour">À jour</span>` : "");
    el.innerHTML = `
      <span class="carte-img">
        ${jaquette(s.cover, s.title)}
        ${badge}
        <span class="carte-bandeau">${escapeHtml(texteOuJenSuis(s))}</span>
      </span>
      <span class="carte-nom">${escapeHtml(s.title)}</span>
      <span class="carte-meta">${LIBELLE_STATUT[s.statut] || ""}</span>
      <span class="carte-note">${texteNote(s)}</span>`;

    el.__suivi = s;
    grille.appendChild(el);
  });
}

const LIBELLE_STATUT = {
  a_voir: "À voir", en_cours: "En cours",
  termine: "Terminée", abandonne: "Abandonnée"
};

/* Reconstitue une fiche minimale depuis ce qui est enregistré, pour que la
   consultation reste possible sans réseau. */
const depuisSuivi = (s) => ({
  locale: estLocale(s.id),
  id: s.id, title: s.title, original: "", cover: s.cover, resume: "",
  genres: s.genres || [], annee: null, anneeFin: null, debut: "",
  statutDiff: "", diffusion: s.finie ? "finie" : "", type: s.format || "",
  reseau: "", createurs: [], popularite: 0, saisons: null,
  episodes: s.episodes || 0, prochain: s.prochain || null, liens: null,
  complet: false
});

function rafraichirCartes() {
  document.querySelectorAll(".carte[data-serie]").forEach((el) => {
    const suivi = listeCache.find((s) => s.id === el.dataset.serie);

    const note = el.querySelector(".carte-note");
    if (note) note.textContent = texteNote(suivi);

    const img = el.querySelector(".carte-img");
    const badge = img.querySelector(".carte-suivi");
    if (el.closest("#liste") || el.closest("#mes-prochains")) return;
    badge?.remove();
    if (suivi) img.querySelector("img, .carte-sans-image")?.insertAdjacentHTML("afterend", badgeSuivi(suivi));
  });
}

/* ══════════════════ Suppression du compte ══════════════════

   Un compte qu'on ne peut pas supprimer n'est pas vraiment à soi. La
   suppression est donc réelle et complète, pas un simple drapeau posé sur le
   profil : la liste, les notes, la réservation du pseudo, la vitrine publique
   et le compte d'authentification lui-même disparaissent.

   L'ordre compte. On réauthentifie d'abord — Firebase l'exige pour une
   opération aussi lourde, et ça vérifie que c'est bien le titulaire du compte
   qui est devant l'écran. On efface ensuite les données, tant que les règles
   nous y autorisent encore. Le compte d'authentification part en dernier :
   une fois lui supprimé, plus aucune écriture n'est possible et ce qui
   resterait serait irrécupérable, sans propriétaire pour y accéder.
   ═══════════════════════════════════════════════════════════ */

const MOT_CONFIRMATION = "SUPPRIMER";

function ouvrirSuppression() {
  if (!currentUser) return;
  $("supprimer-screen").hidden = false;
  $("supprimer-mot").value = "";
  $("supprimer-mdp").value = "";
  $("supprimer-erreur").hidden = true;
  $("supprimer-detail").textContent =
    `${listeCache.length} série${listeCache.length > 1 ? "s" : ""} suivie${listeCache.length > 1 ? "s" : ""}` +
    `, tes notes, ton pseudo et ton profil public s'il est publié.`;
  setTimeout(() => $("supprimer-mot").focus(), 100);
}

const fermerSuppression = () => { $("supprimer-screen").hidden = true; };

$("supprimer-compte").addEventListener("click", ouvrirSuppression);
$("supprimer-fermer").addEventListener("click", fermerSuppression);
$("supprimer-annuler").addEventListener("click", fermerSuppression);
$("supprimer-screen").addEventListener("click", (e) => {
  if (e.target === $("supprimer-screen")) fermerSuppression();
});
addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("supprimer-screen").hidden) fermerSuppression();
});

function erreurSuppression(msg) {
  $("supprimer-erreur").textContent = msg;
  $("supprimer-erreur").hidden = false;
}

/* Firestore ne supprime pas une sous-collection en supprimant son parent :
   chaque document doit partir explicitement. On les efface par lots. */
async function effacerDonnees(uid, pseudo) {
  const OPS = 400;
  const refs = [];

  const series = await getDocs(collection(db, "users", uid, COLLECTION));
  series.forEach((d) => refs.push(refSerie(uid, d.id)));

  refs.push(doc(db, "profilsPublics", uid));
  if (pseudo) refs.push(doc(db, "usernames", pseudo.toLowerCase()));
  refs.push(doc(db, "users", uid));

  for (let i = 0; i < refs.length; i += OPS) {
    const lot = writeBatch(db);
    refs.slice(i, i + OPS).forEach((r) => lot.delete(r));
    await lot.commit();
  }
  return refs.length;
}

$("supprimer-valider").addEventListener("click", async () => {
  if (!currentUser) return;

  if ($("supprimer-mot").value.trim().toUpperCase() !== MOT_CONFIRMATION) {
    return erreurSuppression(`Écris ${MOT_CONFIRMATION} en toutes lettres pour confirmer.`);
  }
  const mdp = $("supprimer-mdp").value;
  if (!mdp) return erreurSuppression("Ton mot de passe est nécessaire pour confirmer.");

  $("supprimer-valider").disabled = true;
  $("supprimer-valider").textContent = "Suppression…";

  try {
    const user = currentUser;
    const uid  = user.uid;

    await reauthenticateWithCredential(
      user, EmailAuthProvider.credential(user.email, mdp));

    // Le pseudo est lu avant l'effacement : après, le profil n'existe plus.
    let pseudo = null;
    try { pseudo = (await getDoc(doc(db, "users", uid))).data()?.pseudo || null; } catch {}

    if (unsubscribe) { unsubscribe(); unsubscribe = null; }   // plus d'écoute pendant l'effacement

    await effacerDonnees(uid, pseudo);
    await deleteUser(user);

    fermerSuppression();
    toast("Ton compte et toutes tes données ont été supprimés.");
  } catch (err) {
    console.error("Suppression :", err.code, err.message);
    erreurSuppression(
      err.code === "auth/wrong-password" || err.code === "auth/invalid-credential"
        ? "Mot de passe incorrect."
        : err.code === "auth/too-many-requests"
          ? "Trop de tentatives. Réessaie dans quelques minutes."
          : "La suppression a échoué. Tes données sont intactes, réessaie.");
  } finally {
    $("supprimer-valider").disabled = false;
    $("supprimer-valider").textContent = "Supprimer définitivement";
  }
});


/* Le clavier logiciel et la barre du bas ne s'entendent pas : iOS place les
   éléments fixés par rapport à la fenêtre de mise en page, qui ne bouge pas
   quand le clavier apparaît. La barre se retrouve alors flottante au milieu
   de l'écran, immobile pendant qu'on fait défiler la page.

   On l'escamote pendant la saisie. C'est aussi ce qu'on veut à ce moment-là :
   la place gagnée sert à voir les résultats de la recherche. */
const champDeSaisie = (el) =>
  !!el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && el.type !== "checkbox";

addEventListener("focusin", (e) => {
  if (champDeSaisie(e.target)) document.body.classList.add("clavier-ouvert");
});

addEventListener("focusout", () => {
  // Le temps que le focus passe d'un champ à l'autre sans faire clignoter la barre.
  setTimeout(() => {
    if (!champDeSaisie(document.activeElement)) {
      document.body.classList.remove("clavier-ouvert");
    }
  }, 120);
});

/* ══════════════════ Succès ══════════════════

   Tout se calcule à la volée depuis la liste déjà en mémoire : rien n'est
   stocké, rien n'est écrit, aucun succès ne peut se désynchroniser des données
   qu'il décrit. Retirer une série retire le succès qu'elle avait débloqué, ce
   qui est la seule définition honnête d'un compteur.
   ════════════════════════════════════════════ */

const SUCCES = [
  { famille: "Parcours", titre: "Premiers pas",         desc: "Terminer une première série", cible: 1,   mesure: (b) => b.termines },
  { famille: "Parcours", titre: "Habitué",              desc: "Terminer 10 séries",          cible: 10,  mesure: (b) => b.termines },
  { famille: "Parcours", titre: "Sériephile",           desc: "Terminer 25 séries",          cible: 25,  mesure: (b) => b.termines },
  { famille: "Parcours", titre: "Vétéran",              desc: "Terminer 50 séries",          cible: 50,  mesure: (b) => b.termines },
  { famille: "Parcours", titre: "Bibliothèque vivante", desc: "Terminer 100 séries",         cible: 100, mesure: (b) => b.termines },
  { famille: "Parcours", titre: "Encyclopédie",         desc: "Terminer 200 séries",         cible: 200, mesure: (b) => b.termines },

  { famille: "Saisons", titre: "Première saison",       desc: "Finir une saison entière",    cible: 1,   mesure: (b) => b.saisons },
  { famille: "Saisons", titre: "Abonné",                desc: "Finir 10 saisons",            cible: 10,  mesure: (b) => b.saisons },
  { famille: "Saisons", titre: "Fidèle",                desc: "Finir 50 saisons",            cible: 50,  mesure: (b) => b.saisons },
  { famille: "Saisons", titre: "Pilier de canapé",      desc: "Finir 100 saisons",           cible: 100, mesure: (b) => b.saisons },
  { famille: "Saisons", titre: "Saga",                  desc: "Terminer une série d'au moins 7 saisons", cible: 1, mesure: (b) => b.sagas },

  { famille: "Temps passé", titre: "Cent épisodes",     desc: "Voir 100 épisodes",           cible: 100,  mesure: (b) => b.episodes },
  { famille: "Temps passé", titre: "Habitude prise",    desc: "Voir 500 épisodes",           cible: 500,  mesure: (b) => b.episodes },
  { famille: "Temps passé", titre: "Marathonien",       desc: "Voir 1 000 épisodes",         cible: 1000, mesure: (b) => b.episodes },
  { famille: "Temps passé", titre: "Insomniaque",       desc: "Voir 2 500 épisodes",         cible: 2500, mesure: (b) => b.episodes },
  { famille: "Temps passé", titre: "Increvable",        desc: "Voir 5 000 épisodes",         cible: 5000, mesure: (b) => b.episodes },
  { famille: "Temps passé", titre: "Longue haleine",    desc: "Terminer une série de 100 épisodes ou plus", cible: 1, mesure: (b) => b.fleuve },
  { famille: "Temps passé", titre: "À jour",            desc: "Être à jour sur 5 séries encore en diffusion", cible: 5, mesure: (b) => b.ajour },

  { famille: "Curiosité", titre: "Éclectique",          desc: "Avoir terminé des séries de 5 genres différents",  cible: 5,  mesure: (b) => b.genres.size },
  { famille: "Curiosité", titre: "Touche-à-tout",       desc: "Avoir terminé des séries de 10 genres différents", cible: 10, mesure: (b) => b.genres.size },
  { famille: "Curiosité", titre: "Histoires courtes",   desc: "Terminer 5 mini-séries",      cible: 5,  mesure: (b) => b.minis },
  { famille: "Curiosité", titre: "Le réel",             desc: "Terminer 3 séries documentaires", cible: 3, mesure: (b) => b.docs },

  { famille: "Tenue de liste", titre: "Premier avis",   desc: "Noter une série",             cible: 1,   mesure: (b) => b.notees },
  { famille: "Tenue de liste", titre: "Critique",       desc: "Noter 50 séries",             cible: 50,  mesure: (b) => b.notees },
  { famille: "Tenue de liste", titre: "Juré",           desc: "Noter 150 séries",            cible: 150, mesure: (b) => b.notees },
  { famille: "Tenue de liste", titre: "Archiviste",     desc: "Créer 5 séries à la main",    cible: 5,   mesure: (b) => b.locales },
  { famille: "Tenue de liste", titre: "Exigeant",       desc: "Mettre la note maximale à 10 séries", cible: 10, mesure: (b) => b.parfaites },
  { famille: "Tenue de liste", titre: "Sur tous les fronts", desc: "Suivre 5 séries en cours en même temps", cible: 5, mesure: (b) => b.enCours }
];

/* Un palier se lit en entier : « 330 / 1 000 » dit ce qu'il reste à faire,
   « 330 / 1,0 k » oblige à convertir de tête. L'espace insécable évite que le
   nombre se coupe en fin de ligne. */
const chiffre = (n) => n.toLocaleString("fr-FR").replace(/ | /g, " ");

function bilanSucces() {
  const genres = new Set();
  let minis = 0, docs = 0, fleuve = 0, parfaites = 0, sagas = 0, saisons = 0, ajour = 0;

  listeCache.forEach((s) => {
    const fini = estTermine(s);
    saisons += saisonsVues(s);
    if (fini) (s.genres || []).forEach((g) => genres.add(g));
    if (fini && s.format === "Miniseries") minis++;
    if (fini && (s.format === "Documentary" || (s.genres || []).includes("Documentaire"))) docs++;
    if (fini && (s.episodes || 0) >= 100) fleuve++;
    if (fini && (s.saisons || []).filter(Boolean).length >= 7) sagas++;
    if (!fini && !s.finie && s.statut === "en_cours" && estAJour(s)) ajour++;
    if (s.note && s.note === (s.sur || 10)) parfaites++;
  });

  return {
    termines: listeCache.filter(estTermine).length,
    enCours:  listeCache.filter((s) => s.statut === "en_cours").length,
    episodes: listeCache.reduce((n, s) => n + (s.vus || 0), 0),
    notees:   listeCache.filter((s) => s.note).length,
    locales:  listeCache.filter((s) => estLocale(s.id)).length,
    genres, minis, docs, fleuve, parfaites, sagas, saisons, ajour
  };
}

function afficherSucces() {
  $("succes-invite").hidden  = !!currentUser;
  $("succes-contenu").hidden = !currentUser;
  if (!currentUser) return;

  const b = bilanSucces();
  const obtenus = SUCCES.filter((x) => x.mesure(b) >= x.cible).length;
  $("succes-bilan").textContent =
    `${obtenus} succès sur ${SUCCES.length} · ${chiffre(b.saisons)} saison${b.saisons > 1 ? "s" : ""} terminée${b.saisons > 1 ? "s" : ""}.`;

  const zone = $("succes-liste");
  zone.innerHTML = "";

  const familles = [...new Set(SUCCES.map((x) => x.famille))];

  familles.forEach((famille) => {
    const titre = document.createElement("h3");
    titre.className = "succes-famille";
    titre.textContent = famille;
    zone.appendChild(titre);

    const grille = document.createElement("div");
    grille.className = "succes-grille";

    SUCCES.filter((x) => x.famille === famille).forEach((x) => {
      const valeur = x.mesure(b);
      const acquis = valeur >= x.cible;
      const part   = Math.min(100, Math.round((valeur / x.cible) * 100));

      const el = document.createElement("article");
      el.className = "succes" + (acquis ? " est-acquis" : "");
      el.innerHTML = `
        <div class="succes-tete">
          <span class="succes-titre">${escapeHtml(x.titre)}</span>
          ${acquis ? `<svg class="succes-coche" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12.5l5 5L20 6.5"/></svg>` : ""}
        </div>
        <p class="succes-desc">${escapeHtml(x.desc)}</p>
        <div class="succes-barre"><span style="width:${part}%"></span></div>
        <p class="succes-compte">${chiffre(Math.min(valeur, x.cible))} / ${chiffre(x.cible)}</p>`;
      grille.appendChild(el);
    });

    zone.appendChild(grille);
  });
}

$("succes-connexion").addEventListener("click", () =>
  ouvrirConnexion("Crée un compte pour suivre tes succès.", "signup"));

/* ══════════════════ Profils publics ══════════════════

   Publier son profil est un choix explicite, et réversible d'un geste.
   Ce que ça expose, littéralement : le pseudo, l'avatar, les compteurs, et la
   liste des séries avec les notes. Rien d'autre — ni adresse e-mail, ni date
   d'inscription, ni les séries abandonnées en silence, puisque tout est dans
   la même liste. C'est dit en clair dans l'interface avant de publier.

   Le mécanisme tient en une phrase : l'existence d'un document dans
   « profilsPublics » vaut autorisation de lecture sur la liste. Les règles
   Firestore la vérifient à chaque requête. Retirer le document referme donc
   la liste dans la seconde, sans avoir à toucher aux séries elles-mêmes.
   ═════════════════════════════════════════════════════ */

let profilPublic   = false;     // mon profil est-il publié ?
let profilsCache   = [];
let profilsCharges = false;
let profilVu       = null;      // profil consulté : { uid, pseudo, avatar, series }
let filtreProfil   = "tous";
let minuteurVitrine;

const compteurs = (liste) => ({
  series:   liste.length,
  episodes: liste.reduce((n, s) => n + (s.vus || 0), 0),
  termines: liste.filter((s) => s.statut === "termine").length
});

async function chargerEtatPublication() {
  profilPublic = false;
  if (!currentUser) return majPublication();
  try {
    profilPublic = (await getDoc(doc(db, "profilsPublics", currentUser.uid))).exists();
  } catch (err) {
    console.error("Profil public :", err.code);
  }
  majPublication();
}

function majPublication() {
  const c = compteurs(listeCache);
  $("publier").textContent = profilPublic ? "Rendre privé" : "Publier mon profil";
  $("publication-etat").textContent = profilPublic
    ? `Visible par les membres : ton pseudo, ton avatar, tes ${c.series} séries et tes notes.`
    : "Ton profil est privé. Personne ne voit ta liste ni tes notes.";
}

/* La vitrine recopie des compteurs déjà calculés côté client : les règles
   n'acceptent que des nombres, donc rien qui puisse servir à afficher un
   texte arbitraire sur une page vue par tout le monde. */
async function ecrireVitrine() {
  if (!currentUser || !profilPublic) return;

  const c = compteurs(listeCache);
  const data = {
    pseudo: $("user-email").textContent || "membre",
    ...c,
    maj: Date.now()
  };
  const avatar = $("user-avatar").hidden ? null : $("user-avatar").src.split("/").pop().replace(".png", "");
  if (avatar && AVATARS.includes(avatar)) data.avatar = avatar;

  try { await setDoc(doc(db, "profilsPublics", currentUser.uid), data); }
  catch (err) { console.error("Vitrine :", err.code, err.message); }
}

/* La liste bouge à chaque épisode coché. On ne réécrit pas la vitrine à chaque
   fois : on attend que ça se calme. */
function planifierVitrine() {
  if (!profilPublic) return;
  clearTimeout(minuteurVitrine);
  minuteurVitrine = setTimeout(ecrireVitrine, 4000);
}

$("publier").addEventListener("click", async () => {
  if (!currentUser) return ouvrirConnexion("Crée un compte pour publier ton profil.", "signup");

  $("publier").disabled = true;
  try {
    if (profilPublic) {
      await deleteDoc(doc(db, "profilsPublics", currentUser.uid));
      profilPublic = false;
      toast("Ton profil est redevenu privé.");
    } else {
      profilPublic = true;
      await ecrireVitrine();
      toast("Ton profil est publié.");
    }
    majPublication();
    profilsCharges = false;
    chargerProfils();
  } catch (err) {
    console.error("Publication :", err.code, err.message);
    profilPublic = !profilPublic;
    toast("L'opération a échoué.");
  } finally {
    $("publier").disabled = false;
  }
});

$("profils-connexion").addEventListener("click", () =>
  ouvrirConnexion("Crée un compte pour voir les profils.", "signup"));

async function chargerProfils() {
  $("profils-invite").hidden  = !!currentUser;
  $("profils-contenu").hidden = !currentUser;
  if (!currentUser || profilsCharges) return;

  profilsCharges = true;
  $("profils-note").textContent = "Chargement…";

  try {
    const snap = await getDocs(collection(db, "profilsPublics"));
    profilsCache = snap.docs.map((d) => ({ uid: d.id, ...d.data() }))
      .sort((a, b) => (b.series || 0) - (a.series || 0));
    afficherProfils();
  } catch (err) {
    console.error("Profils :", err.code, err.message);
    profilsCharges = false;
    $("profils-note").textContent = "Impossible de charger les profils pour l'instant.";
  }
}

function afficherProfils() {
  const zone = $("profils-liste");
  zone.innerHTML = "";

  const moi    = profilsCache.find((p) => p.uid === currentUser?.uid);
  const autres = profilsCache.filter((p) => p.uid !== currentUser?.uid);

  $("profils-note").textContent = autres.length
    ? (autres.length > 1
        ? `${autres.length} membres partagent leur liste.`
        : "1 membre partage sa liste.")
    : "Personne d'autre n'a encore publié son profil.";

  /* Ton propre profil figure dans la liste, en tête et signalé comme tien.
     Le masquer t'empêchait de vérifier ce que les autres voient de toi —
     et c'est précisément ce qu'on veut regarder après avoir publié. */
  const aAfficher = moi ? [moi, ...autres] : autres;

  aAfficher.forEach((p) => {
    const estMoi = p.uid === currentUser?.uid;
    const el = document.createElement("button");
    el.type = "button";
    el.className = "profil-carte" + (estMoi ? " est-moi" : "");

    const avatar = p.avatar && AVATARS.includes(p.avatar)
      ? `<img class="profil-carte-avatar" src="${cheminAvatar(p.avatar)}" alt="" loading="lazy">`
      : `<span class="profil-carte-avatar profil-carte-vide">${escapeHtml(initiales(p.pseudo))}</span>`;

    el.innerHTML = `
      ${avatar}
      <span class="profil-carte-nom">${escapeHtml(p.pseudo || "membre")}${
        estMoi ? `<span class="profil-moi">ton profil</span>` : ""}</span>
      <span class="profil-carte-stats">
        <span><strong>${p.series || 0}</strong> séries</span>
        <span><strong>${nombreCourt(p.episodes || 0)}</strong> épisodes</span>
        <span><strong>${p.termines || 0}</strong> terminées</span>
      </span>`;

    el.addEventListener("click", () => ouvrirProfil(p));
    zone.appendChild(el);
  });
}


/* Aperçu d'une série hors TMDB : ce que le membre a saisi, et rien de plus.
   Pas de résumé à inventer, pas de bouton qui ne mènerait nulle part. */
function ouvrirApercu(s) {
  $("apercu-titre").textContent = s.title;

  const avecImage = !!s.cover;
  $("apercu-image").hidden = !avecImage;
  $("apercu-vide").hidden  = avecImage;
  if (avecImage) $("apercu-image").src = s.cover;
  else $("apercu-vide").textContent = initiales(s.title);

  $("apercu-statut").textContent = LIBELLE_STATUT[s.statut] || "—";

  const vus = s.vus || 0;
  $("apercu-episodes").textContent = s.episodes
    ? `${vus} vus sur ${s.episodes}`
    : (vus ? `${vus} vus, total inconnu` : "Non renseigné");

  $("apercu-note").textContent = texteNote(s) || "Pas de note";

  $("apercu-screen").hidden = false;
}

const fermerApercu = () => { $("apercu-screen").hidden = true; };

$("apercu-fermer").addEventListener("click", fermerApercu);
$("apercu-ok").addEventListener("click", fermerApercu);
$("apercu-screen").addEventListener("click", (e) => {
  if (e.target === $("apercu-screen")) fermerApercu();
});
addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("apercu-screen").hidden) fermerApercu();
});

async function ouvrirProfil(p) {
  profilVu = { ...p, series_liste: null };
  filtreProfil = "tous";

  $("profil-pseudo").textContent = p.pseudo || "membre";
  $("profil-avatar").hidden = !(p.avatar && AVATARS.includes(p.avatar));
  if (!$("profil-avatar").hidden) $("profil-avatar").src = cheminAvatar(p.avatar);

  $("profil-stats").innerHTML = `
    <p><strong>${p.series || 0}</strong> séries suivies</p>
    <p><strong>${nombreCourt(p.episodes || 0)}</strong> épisodes vus</p>
    <p><strong>${p.termines || 0}</strong> terminées</p>`;

  document.querySelectorAll(".filtre-profil").forEach((b) =>
    b.classList.toggle("is-active", b.dataset.statut === "tous"));

  $("profil-liste").innerHTML = `<p class="loading">Chargement de la liste…</p>`;
  $("profil-vide").hidden = true;
  showView("profil");

  try {
    const snap = await getDocs(collection(db, "users", p.uid, COLLECTION));
    if (profilVu?.uid !== p.uid) return;         // parti ailleurs entre-temps
    profilVu.series_liste = snap.docs.map((d) => d.data())
      .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    afficherListeProfil();
  } catch (err) {
    console.error("Liste du profil :", err.code, err.message);
    $("profil-liste").innerHTML =
      `<p class="empty-state">Cette liste n'est plus accessible. Le profil est peut-être redevenu privé.</p>`;
  }
}

function afficherListeProfil() {
  const zone = $("profil-liste");
  const toutes = profilVu?.series_liste || [];
  const vues = trier(
    filtreProfil === "tous" ? toutes : toutes.filter((s) => s.statut === filtreProfil));

  zone.innerHTML = "";
  $("profil-vide").hidden = vues.length > 0;

  vues.forEach((s) => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "carte";
    el.innerHTML = `
      <span class="carte-img">
        ${jaquette(s.cover, s.title)}
        ${s.statut === "termine" ? `<span class="carte-bandeau">Terminé</span>` : ""}
      </span>
      <span class="carte-nom">${escapeHtml(s.title)}</span>
      <span class="carte-bas">
        <span class="carte-meta">${LIBELLE_STATUT[s.statut] || ""}</span>
        <span class="carte-note">${texteNote(s)}</span>
      </span>`;

    /* Une série d'un autre membre garde son identifiant TMDB : on ouvre sa
       vraie fiche. Une série qu'il a saisie à la main n'existe que chez lui,
       mais elle reste une série de sa liste : elle ouvre un aperçu réduit
       plutôt que de rester inerte au milieu de cartes qui, elles, réagissent. */
    if (estLocale(s.id)) el.__apercu = s;
    else el.__suivi = s;
    zone.appendChild(el);
  });
}

document.querySelectorAll(".filtre-profil").forEach((btn) => {
  btn.addEventListener("click", () => {
    filtreProfil = btn.dataset.statut;
    document.querySelectorAll(".filtre-profil").forEach((b) =>
      b.classList.toggle("is-active", b === btn));
    afficherListeProfil();
  });
});

$("profil-retour").addEventListener("click", () => showView("profils"));

/* ══════════════════ Séries saisies à la main ══════════════════

   TMDB ne connaît pas tout : les séries confidentielles, les web-séries,
   celles dont l'orthographe résiste. Plutôt que de les perdre, on les crée
   localement. Leur identifiant commence par « local_ », ce qui suffit à savoir
   qu'il ne faut pas aller les chercher en ligne, et qu'elles sont modifiables.
   ══════════════════════════════════════════════════════════════ */

const ID_LOCAL = "local_";
const estLocale = (id) => String(id || "").startsWith(ID_LOCAL);
const nouvelIdLocal = () =>
  ID_LOCAL + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

let serieEnEdition = null;   // identifiant en cours de modification, sinon null
let couvertureChoisie = null;

/* Une photo de téléphone pèse plusieurs mégaoctets ; un document Firestore est
   plafonné à un. On redimensionne donc dans le navigateur avant d'enregistrer,
   aux proportions d'une jaquette. */
async function imageReduite(fichier, largeurMax, qualite) {
  const bitmap = await createImageBitmap(fichier, { imageOrientation: "from-image" });
  const ratio = Math.min(1, largeurMax / bitmap.width);
  const l = Math.round(bitmap.width * ratio);
  const h = Math.round(bitmap.height * ratio);

  const toile = document.createElement("canvas");
  toile.width = l; toile.height = h;
  toile.getContext("2d").drawImage(bitmap, 0, 0, l, h);
  bitmap.close?.();
  return toile.toDataURL("image/jpeg", qualite);
}

async function preparerCouverture(fichier) {
  let data = await imageReduite(fichier, 420, 0.72);
  if (data.length > 200000) data = await imageReduite(fichier, 340, 0.6);
  if (data.length > 200000) data = await imageReduite(fichier, 260, 0.5);
  if (data.length > 280000) throw new Error("image-trop-lourde");
  return data;
}

function ouvrirSerie(suivi = null) {
  if (!currentUser) return ouvrirConnexion("Crée un compte pour tenir ta liste.", "signup");

  serieEnEdition = suivi?.id || null;
  couvertureChoisie = suivi?.cover || null;

  $("serie-screen").hidden = false;
  $("serie-titre-fenetre").textContent = suivi ? "Modifier la série" : "Ajouter une série";
  $("serie-valider").textContent = suivi ? "Enregistrer" : "Ajouter à ma liste";

  $("serie-nom").value      = suivi?.title || "";
  $("serie-episodes").value = suivi?.episodes || "";
  $("serie-vus").value      = suivi?.vus ?? 0;
  $("serie-statut").value   = suivi?.statut || "termine";
  $("serie-note").value     = suivi?.note || "";
  $("serie-sur").value      = String(suivi?.sur || echellePreferee);
  $("serie-erreur").hidden  = true;
  $("serie-fichier").value  = "";

  /* Une série liée à TMDB voit sa fiche rechargée à chaque ouverture : un
     titre corrigé serait écrasé dans la seconde. La modifier la détache donc
     de la base, définitivement, et c'est assez lourd de conséquence pour être
     annoncé avant plutôt que découvert après. */
  const liee = suivi && !estLocale(suivi.id);
  $("serie-detache").hidden = !liee;

  majApercuCouverture();
  setTimeout(() => $("serie-nom").focus(), 100);
}

function fermerSerie() { $("serie-screen").hidden = true; }

function majApercuCouverture() {
  const img = $("serie-apercu");
  img.hidden = !couvertureChoisie;
  $("serie-sans-image").hidden = !!couvertureChoisie;
  $("serie-retirer-image").hidden = !couvertureChoisie;
  if (couvertureChoisie) img.src = couvertureChoisie;
}

$("ouvrir-serie").addEventListener("click", () => ouvrirSerie());
$("serie-fermer").addEventListener("click", fermerSerie);
$("serie-annuler").addEventListener("click", fermerSerie);
$("serie-screen").addEventListener("click", (e) => {
  if (e.target === $("serie-screen")) fermerSerie();
});
addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("serie-screen").hidden) fermerSerie();
});

$("fiche-modifier").addEventListener("click", () => {
  const s = listeCache.find((x) => x.id === ficheCourante?.id);
  if (s) ouvrirSerie(s);
});

$("serie-retirer-image").addEventListener("click", () => {
  couvertureChoisie = null;
  $("serie-fichier").value = "";
  majApercuCouverture();
});

$("serie-fichier").addEventListener("change", async () => {
  const fichier = $("serie-fichier").files?.[0];
  if (!fichier) return;

  $("serie-sans-image").textContent = "Préparation de l'image…";
  try {
    couvertureChoisie = await preparerCouverture(fichier);
    majApercuCouverture();
  } catch (err) {
    console.error("Image :", err);
    toast("Cette image n'a pas pu être préparée. Essaie une autre photo.");
  } finally {
    $("serie-sans-image").textContent = "Aucune image";
  }
});

$("serie-valider").addEventListener("click", async () => {
  const titre = $("serie-nom").value.trim();
  if (titre.length < 1) {
    $("serie-erreur").textContent = "Il faut au moins un titre.";
    $("serie-erreur").hidden = false;
    return $("serie-nom").focus();
  }

  const episodes = Math.min(Math.max(parseInt($("serie-episodes").value, 10) || 0, 0), 5000);
  let vus = Math.min(Math.max(parseInt($("serie-vus").value, 10) || 0, 0), 5000);
  // Le serveur refuse une progression supérieure au total annoncé.
  if (episodes && vus > episodes) vus = episodes;

  const sur = echelleRangee($("serie-sur").value);
  const brute = parseInt($("serie-note").value, 10);
  const note = Number.isInteger(brute) && brute >= 1 ? Math.min(brute, sur) : null;
  echellePreferee = sur;

  const donnees = {
    id: serieEnEdition || nouvelIdLocal(),
    title: titre.slice(0, 300),
    cover: couvertureChoisie || "",
    episodes, vus,
    statut: $("serie-statut").value,
    addedAt: Date.now()
  };
  if (note) { donnees.note = note; donnees.sur = sur; }

  /* Détacher, c'est changer d'identifiant : « local_… » est précisément ce
     qui dit au site de ne plus rien demander à TMDB. On recrée donc la
     fiche sous un nouvel identifiant, avec la progression et la note, puis on
     supprime l'ancienne. Deux écritures, jamais de doublon visible. */
  const detache = serieEnEdition && !estLocale(serieEnEdition);
  if (detache) donnees.id = nouvelIdLocal();

  $("serie-valider").disabled = true;
  try {
    const ref = refSerie(currentUser.uid, donnees.id);

    if (detache) {
      const ancien = listeCache.find((x) => x.id === serieEnEdition);
      donnees.addedAt = ancien?.addedAt || donnees.addedAt;
      await setDoc(ref, donnees);
      await deleteDoc(refSerie(currentUser.uid, serieEnEdition));
      toast("Série détachée de TMDB et modifiée.");
      if (ficheCourante?.id === serieEnEdition) {
        ficheCourante = depuisSuivi({ ...donnees, note, sur });
        majFiche();
      }
      fermerSerie();
      return;
    }

    if (serieEnEdition) {
      // On garde la date d'ajout d'origine : elle ordonne la liste.
      const ancien = listeCache.find((x) => x.id === serieEnEdition);
      donnees.addedAt = ancien?.addedAt || donnees.addedAt;
      if (!note) { donnees.note = deleteField(); donnees.sur = deleteField(); }
      await updateDoc(ref, donnees);
      toast("Série modifiée.");
      if (ficheCourante?.id === serieEnEdition) {
        ficheCourante = depuisSuivi({ ...donnees, note, sur });
        majFiche();
      }
    } else {
      await setDoc(ref, donnees);
      toast(`${titre} est dans ta liste.`);
    }
    fermerSerie();
  } catch (err) {
    console.error("Série :", err.code, err.message);
    $("serie-erreur").textContent = "L'enregistrement a échoué. L'image est peut-être trop lourde.";
    $("serie-erreur").hidden = false;
  } finally {
    $("serie-valider").disabled = false;
  }
});

/* ══════════════════ Import d'une liste ══════════════════

   Beaucoup de gens tiennent déjà leur liste ailleurs : les notes du
   téléphone, un carnet, un tableur. Retaper trois cents titres un par un
   n'aurait aucun sens. On colle le texte, le site cherche chaque titre sur
   TMDB, on vérifie ce qu'il a reconnu, et tout part d'un coup.

   L'étape de vérification n'est pas une politesse : une recherche par
   titre approximatif se trompe forcément quelques fois, et personne ne veut
   découvrir après coup vingt séries qu'il n'a jamais regardées dans sa liste.
   ════════════════════════════════════════════════════════ */

let importEntrees = [];
let importOccupe  = false;
let importEchecs  = 0;

/* Réduit un titre à sa forme comparable : sans casse, sans accents, sans
   ponctuation. « Re:ZERO -Starting Life- » et « Re Zero Starting Life »
   deviennent alors la même chaîne. */
const cleTitre = (s) => String(s || "")
  .toLowerCase()
  .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .replace(/[^a-z0-9]+/g, " ")
  .trim();

/* La note est ramenée à l'échelle choisie, pas systématiquement sur 10 :
   un 17/20 reste un 17/20. Passer par 10 écraserait 17 et 18 sur la même
   valeur, et 19 et 20 aussi. */
let echelleImport = 20;

const surEchelle = (valeur, max) =>
  (!Number.isFinite(valeur) || !max)
    ? null
    : Math.min(echelleImport, Math.max(1, Math.round((valeur / max) * echelleImport)));

/* Une liste tenue dans les notes du téléphone est pleine d'annotations
   personnelles : « (attente saison 2) », « (ost : sparkle) », « arrêt épisode
   7 ». Elles arrivent aussi bien avant qu'après la note, et n'ont rien à faire
   dans une recherche. Tout ce qui est entre parenthèses part donc au panier. */
function nettoyerTitre(t) {
  return String(t)
    .replace(/\([^)]*\)?/g, " ")          // commentaires, même parenthèse jamais refermée
    .replace(/\[[^\]]*\]?/g, " ")
    .replace(/[.\u2026]{2,}/g, " ")       // « ... » et « … » de troncature
    .replace(/\u2026/g, " ")
    .replace(/^[\s\-\u2013\u2014•*·>+]+/, "")
    .replace(/^\d{1,3}\s*[.)]\s+/, "")    // numérotation « 12. »
    .replace(/[\s\-\u2013\u2014:;,|.\/)\]]+$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Un titre doit contenir des lettres : « 3) » ou « 2020 » sont des résidus.
const aDuTexte = (t) => /[a-zA-Z\u00C0-\u024F]{2}/.test(t);

const creerEntree = (titre, note, brut) =>
  ({ titre, note, brut: brut.trim(), garder: true, candidats: [], choix: null, sur: 0 });

/* Une note écrite « 18/20 » est reconnaissable n'importe où dans la ligne :
   son dénominateur ne laisse aucun doute. C'est ce qui permet de récupérer
   « sword art online 20/20 (suite 12 octobre) », où la note est au milieu. */
const RE_FRACTION = /(\d{1,3}(?:[.,]\d+)?)\s*\/\s*(\d{1,3})/g;

function analyserLigne(ligne, echelle) {
  const source = String(ligne).trim();
  if (!source) return [];

  const fractions = [...source.matchAll(RE_FRACTION)]
    .filter((m) => Number(m[2]) >= 3 && Number(m[2]) <= 100);

  if (!fractions.length) {
    const seule = sansFraction(source, echelle);
    return seule ? [seule] : [];
  }

  /* Deux notes sur une ligne, c'est deux séries qu'un retour à la ligne
     manquant a collées ensemble. Chaque note ferme le titre qui la précède. */
  const entrees = [];
  let debut = 0;

  fractions.forEach((m) => {
    const titre = nettoyerTitre(source.slice(debut, m.index));
    debut = m.index + m[0].length;
    if (!titre || !aDuTexte(titre)) return;
    entrees.push(creerEntree(
      titre,
      surEchelle(parseFloat(m[1].replace(",", ".")), Number(m[2])),
      source
    ));
  });

  return entrees;
}

/* Sans dénominateur, le piège ce sont les titres qui finissent par un
   chiffre : « Steins;Gate 0 », « Mob Psycho 100 », « 86 ». D'où les
   garde-fous — séparateur obligatoire, note dans l'échelle choisie, et titre
   restant non vide. */
function sansFraction(source, echelle) {
  let reste = source;
  let note = null;

  // « Naruto (8) » : une parenthèse qui ne contient qu'un nombre est une note.
  const entreParentheses = source.match(/[(\[](\d{1,2}(?:[.,]\d+)?)[)\]]\s*$/);

  if (entreParentheses) {
    const valeur = parseFloat(entreParentheses[1].replace(",", "."));
    if (valeur >= 1 && valeur <= echelle) {
      note  = surEchelle(valeur, echelle);
      reste = source.slice(0, entreParentheses.index);
    }
  } else {
    reste = source.replace(/\([^)]*\)?/g, " ").replace(/\[[^\]]*\]?/g, " ");
    const nue = reste.match(/[-\s:;=|\u2013\u2014]\s*(\d{1,2}(?:[.,]\d+)?)\s*$/);
    if (nue) {
      const valeur = parseFloat(nue[1].replace(",", "."));
      const avant  = nettoyerTitre(reste.slice(0, nue.index));
      if (valeur >= 1 && valeur <= echelle && avant.length >= 2) {
        note  = surEchelle(valeur, echelle);
        reste = avant;
      }
    }
  }

  const titre = nettoyerTitre(reste);
  return titre && aDuTexte(titre) ? creerEntree(titre, note, source) : null;
}

/* Deuxième chance pour les titres restés sans résultat. « saekano/how to
   raise a boring girlfriend » ou « hell mode : the hardcore gamer » sont deux
   titres accolés : le premier morceau suffit presque toujours. */
function variante(titre) {
  const coupe = titre.split(/\s*[\/:|]\s*/)[0].trim();
  if (coupe.length >= 3 && coupe !== titre) return coupe;

  const mots = titre.split(/\s+/);
  if (mots.length > 4) return mots.slice(0, 4).join(" ");
  return null;
}

/* TMDB n'a pas de requête groupée : chaque titre est une recherche. On en
   lance douze en même temps, ce qui ramène une liste de trois cents séries à
   une trentaine de vagues de quelques dixièmes de seconde. */
const LOT = 12;

const simplifier = (m) => ({
  id:       String(m.id),
  title:    m.name || m.original_name || "Sans titre",
  cover:    affiche(m.poster_path, "w185"),
  episodes: 0,
  format:   "",
  genres:   (m.genre_ids || []).map((id) => GENRES[id]).filter(Boolean),
  annee:    (m.first_air_date || "").slice(0, 4) || null,
  noms:     [m.name, m.original_name].filter(Boolean).map(cleTitre)
});

/* Combien on peut faire confiance à un résultat. Zéro veut dire qu'aucun des
   noms de la série ne ressemble à ce qui était écrit : c'est le cas des
   titres mal orthographiés ou trop courts. Ces lignes-là arrivent
   décochées, pour qu'une série jamais regardée n'entre pas dans la liste. */
/* Le rapprochement se faisait sur un simple « commence par » ou « contient »,
   sans regarder les longueurs. « nana » acceptait donc « nanatsu no taizai »,
   et « parasite » n'importe quel titre débutant de même : une série jamais
   regardée entrait dans la liste sous un nom crédible.

   Deux garde-fous désormais. Un rapport de longueurs : un titre trois fois
   plus long que le tien n'est pas le tien. Et une proportion de mots communs,
   qui rattrape les orthographes flottantes — « kimetsu no yaiba/demon slayer »
   partage assez de mots avec « Kimetsu no Yaiba » pour rester sûr, quand
   « nana » n'en partage aucun avec « nanatsu no taizai ». */
function confiance(media, cle) {
  const motsA = cle.split(" ").filter(Boolean);
  let meilleur = 0;

  for (const n of media.noms) {
    if (!n) continue;
    if (n === cle) return 3;

    const rapport = Math.min(n.length, cle.length) / Math.max(n.length, cle.length);

    const motsB = n.split(" ").filter(Boolean);
    const communs = motsA.filter((m) => motsB.includes(m)).length;
    const recouvrement = (2 * communs) / (motsA.length + motsB.length);

    let score = 0;
    if ((n.startsWith(cle) || cle.startsWith(n)) && rapport >= 0.6) score = 2;
    else if (recouvrement >= 0.7) score = 2;
    else if ((n.includes(cle) || cle.includes(n)) && rapport >= 0.5) score = 1;
    else if (recouvrement >= 0.5) score = 1;

    meilleur = Math.max(meilleur, score);
  }
  return meilleur;
}

function classer(entree) {
  const cle = cleTitre(entree.titre);
  let meilleur = null, meilleurSur = -1;

  // À score égal on garde l'ordre de TMDB : sa pertinence vaut mieux qu'un
  // départage arbitraire de notre part.
  entree.candidats.forEach((c) => {
    const s = confiance(c, cle);
    if (s > meilleurSur) { meilleur = c; meilleurSur = s; }
  });

  entree.choix  = meilleur;
  entree.sur    = Math.max(meilleurSur, 0);
  // Une correspondance douteuse est décochée : mieux vaut une série absente
  // qu'une série jamais regardée dans la liste. Une absence totale de résultat,
  // en revanche, part en création manuelle — le titre, lui, est certain.
  // Il faut désormais une correspondance franche pour être coché d'office.
  // Le reste attend ton avis plutôt que d'entrer dans ta liste en douce.
  entree.garder = meilleur ? meilleurSur >= 2 : true;
}

async function interrogerLot(titres) {
  const reponses = await Promise.all(titres.map((t) =>
    tmdb("search/tv", { query: t, include_adult: false })));
  // Quatre propositions par titre suffisent pour corriger une erreur.
  return reponses.map((d) => (d.results || []).slice(0, 4).map(simplifier));
}

/* Trois cents lignes, c'est une trentaine d'allers-retours réseau. Sur un
   téléphone qui change d'antenne, ou face à une coupure de rythme de TMDB,
   il y en aura un qui échouera — et faire échouer l'import entier pour lui
   revenait à jeter vingt-cinq requêtes réussies. Chaque paquet est donc isolé :
   il retente une fois, puis abandonne seul. Les lignes concernées ressortent
   simplement comme non trouvées, donc créées à la main, donc pas perdues. */
async function chercherLot(entrees, avancement) {
  let echecs = 0;

  async function traiter(paquet, titres) {
    for (let tentative = 0; tentative < 2; tentative++) {
      try {
        return await interrogerLot(titres);
      } catch (err) {
        console.warn("Paquet en échec :", err.message);
        if (tentative === 0) {
          $("import-etat").textContent = "Connexion difficile, nouvelle tentative…";
          await pause(4000);
        }
      }
    }
    echecs += paquet.length;
    $("import-etat").textContent = "Recherche des séries sur TMDB…";
    return null;
  }

  for (let i = 0; i < entrees.length; i += LOT) {
    const paquet = entrees.slice(i, i + LOT);
    const reponses = await traiter(paquet, paquet.map((e) => e.titre));

    if (reponses) paquet.forEach((e, j) => { e.candidats = reponses[j]; classer(e); });
    else paquet.forEach((e) => { e.echec = true; e.candidats = []; classer(e); });

    avancement(Math.min(i + LOT, entrees.length));
    if (i + LOT < entrees.length) await pause(400);
  }

  importEchecs = echecs;

  /* Seconde chance : les titres restés bredouilles repartent sous une forme
     raccourcie. « saekano/how to raise a boring girlfriend » ne donne rien,
     « saekano » donne la bonne série. */
  const bredouilles = entrees
    .map((e) => ({ e, autre: e.candidats.length ? null : variante(e.titre) }))
    .filter((x) => x.autre);

  for (let i = 0; i < bredouilles.length; i += LOT) {
    const paquet = bredouilles.slice(i, i + LOT);
    $("import-etat").textContent = "Nouvel essai sur les titres non trouvés…";
    const reponses = await traiter(paquet, paquet.map((x) => x.autre));
    if (!reponses) continue;

    paquet.forEach((x, j) => {
      if (!reponses[j].length) return;
      x.e.candidats = reponses[j];
      classer(x.e);
    });

    if (i + LOT < bredouilles.length) await pause(400);
  }
}

/* ── Fenêtre ── */

function etapeImport(nom) {
  $("import-saisie").hidden    = nom !== "saisie";
  $("import-analyse").hidden   = nom !== "analyse";
  $("import-resultats").hidden = nom !== "resultats";
}

function ouvrirImport() {
  if (!currentUser) return ouvrirConnexion("Crée un compte pour importer ta liste.");
  $("import-screen").hidden = false;
  etapeImport("saisie");
  setTimeout(() => $("import-texte").focus(), 100);
}

function fermerImport() {
  if (importOccupe) return;   // une écriture en cours ne se referme pas à moitié
  $("import-screen").hidden = true;
}

$("ouvrir-import").addEventListener("click", ouvrirImport);
$("import-fermer").addEventListener("click", fermerImport);
$("import-annuler").addEventListener("click", fermerImport);
$("import-retour").addEventListener("click", () => etapeImport("saisie"));

$("import-screen").addEventListener("click", (e) => {
  if (e.target === $("import-screen")) fermerImport();
});

addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("import-screen").hidden) fermerImport();
});

$("import-analyser").addEventListener("click", async () => {
  const echelle = Number($("import-echelle").value) || 10;

  echelleImport = echelleRangee(echelle);
  importEchecs  = 0;

  const entrees = $("import-texte").value
    .split("\n").flatMap((l) => analyserLigne(l, echelle));

  if (!entrees.length) return toast("Colle d'abord ta liste, une série par ligne.");
  if (entrees.length > 500) return toast("500 séries au maximum en une fois.");

  importEntrees = entrees;
  importOccupe  = true;
  etapeImport("analyse");
  progressionImport(0, entrees.length);

  try {
    await chercherLot(entrees, (fait) => progressionImport(fait, entrees.length));
    afficherResultatsImport();
    etapeImport("resultats");
  } catch (err) {
    /* On arrive ici pour une panne franche — plus de réseau du tout. Le texte
       collé reste intact dans le champ, il n'y a rien à retaper. */
    console.error("Import :", err);
    etapeImport("saisie");
    $("import-etat").textContent = "Recherche des séries sur TMDB…";
    toast(`Recherche interrompue : ${err.message}. Ton texte est intact, réessaie.`);
  } finally {
    importOccupe = false;
  }
});

function progressionImport(fait, total) {
  $("import-barre").style.width = `${total ? Math.round((fait / total) * 100) : 0}%`;

  // Le rythme est bridé pour ménager TMDB et le relais : autant
  // annoncer l'attente plutôt que de laisser une barre avancer en silence.
  const restant = Math.ceil((total - fait) / LOT);
  $("import-compteur").textContent =
    `${fait} série${fait > 1 ? "s" : ""} sur ${total}`
    + (restant > 5 ? ` — encore ${restant} secondes environ` : "");
}

function afficherResultatsImport() {
  const zone = $("import-lignes");
  zone.innerHTML = "";

  importEntrees.forEach((e) => zone.appendChild(ligneImport(e)));
  bilanImport();
}

/* Une ligne de vérification. Tout y est modifiable : la série retenue, la
   note, et la recherche elle-même — sans quoi les titres que TMDB ne
   reconnaît pas seraient perdus, et il y en a toujours. */
function ligneImport(e) {
  const ligne = document.createElement("div");
  ligne.className = "import-ligne";

  const coche = document.createElement("input");
  coche.type = "checkbox";
  coche.setAttribute("aria-label", "Importer cette série");
  coche.addEventListener("change", () => {
    e.garder = coche.checked;
    bilanImport();
  });

  const vignette = document.createElement("img");
  vignette.className = "import-vignette";
  vignette.alt = ""; vignette.loading = "lazy"; vignette.referrerPolicy = "no-referrer";

  const vide = document.createElement("span");
  vide.className = "import-vide";
  vide.textContent = "?";

  const infos  = document.createElement("div");
  infos.className = "import-infos";
  const titre  = document.createElement("p");
  titre.className = "import-titre";
  const source = document.createElement("p");
  source.className = "import-source";
  const alt = document.createElement("select");
  alt.className = "import-alt";
  alt.setAttribute("aria-label", "Choisir une autre série");

  const note = document.createElement("input");
  note.type = "number";
  note.className = "import-note";
  note.min = 0; note.step = 1;
  note.placeholder = "—";
  note.setAttribute("aria-label", "Ta note");
  note.addEventListener("change", () => {
    const v = Math.round(Number(note.value));
    e.note = Number.isInteger(v) && v >= 1 && v <= echelleImport ? v : null;
    note.value = e.note ?? "";
  });

  // Recherche manuelle, repliée tant qu'on n'en a pas besoin.
  const relance = document.createElement("button");
  relance.type = "button";
  relance.className = "btn-link import-relance";
  relance.textContent = "Chercher un autre titre";

  const boite = document.createElement("div");
  boite.className = "import-recherche";
  boite.hidden = true;
  const champ = document.createElement("input");
  champ.type = "search";
  champ.setAttribute("aria-label", "Chercher un autre titre");
  const go = document.createElement("button");
  go.type = "button";
  go.className = "btn-ghost";
  go.textContent = "Chercher";
  boite.append(champ, go);

  relance.addEventListener("click", () => {
    boite.hidden = !boite.hidden;
    if (!boite.hidden) { champ.value = e.titre; champ.focus(); }
  });

  const lancer = async () => {
    const terme = champ.value.trim();
    if (terme.length < 2 || importOccupe) return;
    go.disabled = true; go.textContent = "…";
    try {
      const [resultats] = await interrogerLot([terme]);
      if (resultats.length) {
        e.titre = terme;
        e.candidats = resultats;
        classer(e);
        boite.hidden = true;
        peindre();
        bilanImport();
      } else {
        toast(`Rien trouvé pour « ${terme} ».`);
      }
    } catch (err) {
      toast("Recherche impossible pour le moment.");
    } finally {
      go.disabled = false; go.textContent = "Chercher";
    }
  };

  go.addEventListener("click", lancer);
  champ.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); lancer(); } });

  /* Redessine la ligne à partir de l'état de l'entrée : le même code sert au
     premier affichage et après une recherche manuelle. */
  function peindre() {
    const trouve = !!e.choix;
    ligne.classList.toggle("est-introuvable", !trouve);
    ligne.classList.toggle("est-douteuse", trouve && e.sur < 2);

    coche.checked  = e.garder;
    coche.disabled = false;      // même sans jaquette, la série est importable
    note.value     = e.note ?? "";
    note.max       = echelleImport;

    vignette.hidden = !trouve;
    vide.hidden     = trouve;
    if (trouve) vignette.src = e.choix.cover;

    const deja = trouve && listeCache.some((s) => s.id === e.choix.id);

    titre.textContent = trouve ? e.choix.title : e.titre;
    source.className  = "import-source" + (deja ? " import-deja" : "");
    source.textContent = deja
      ? "Déjà dans ta liste — ta progression sera conservée"
      : e.echec
        ? "Recherche impossible — créée sans jaquette, modifiable ensuite"
      : !trouve
        ? "Inconnue de TMDB — créée sans jaquette, modifiable ensuite"
        : (e.sur < 2 ? `Correspondance incertaine · ta ligne : ${e.brut}` : `Ta ligne : ${e.brut}`);

    alt.hidden = !e.candidats.length;
    if (!alt.hidden) {
      alt.innerHTML = "";
      e.candidats.forEach((c, i) => {
        const opt = document.createElement("option");
        opt.value = i;
        opt.textContent = c.title + (c.annee ? ` (${c.annee})` : "");
        opt.selected = trouve && c.id === e.choix.id;
        alt.appendChild(opt);
      });
      /* Quand aucune proposition ne convient, on refuse le rapprochement
         plutôt que d'en accepter un mauvais : la série est créée sous ton
         propre titre, modifiable ensuite. */
      const perso = document.createElement("option");
      perso.value = "local";
      perso.textContent = `Aucune — créer « ${e.titre} » sans jaquette`;
      perso.selected = !trouve;
      alt.appendChild(perso);
    }
  }

  alt.addEventListener("change", () => {
    if (alt.value === "local") {
      e.choix = null;             // création locale forcée
      e.sur = 0;
    } else {
      e.choix = e.candidats[Number(alt.value)];
      e.sur = Math.max(e.sur, 2); // un choix explicite n'est plus une supposition
    }
    peindre();
    bilanImport();
  });

  /* La ligne est une grille : jaquette à gauche, titre et case en haut, puis
     la source et les commandes dessous. Sur téléphone, tout tient sans que le
     titre soit rogné à trois mots. */
  const outils = document.createElement("div");
  outils.className = "import-outils";
  outils.append(note, alt, relance, boite);

  infos.append(titre);
  ligne.append(coche, vignette, vide, infos, source, outils);
  peindre();
  return ligne;
}

function bilanImport() {
  const trouvees    = importEntrees.filter((e) => e.choix).length;
  const cochees     = importEntrees.filter((e) => e.garder).length;
  const douteuses   = importEntrees.filter((e) => e.choix && e.sur === 0).length;
  const introuvable = importEntrees.length - trouvees;

  const bouts = [`${cochees} série${cochees > 1 ? "s" : ""} cochée${cochees > 1 ? "s" : ""} sur ${importEntrees.length} lignes lues`];
  if (introuvable) bouts.push(`${introuvable} créée${introuvable > 1 ? "s" : ""} à la main, sans jaquette`);
  if (importEchecs) bouts.push(`${importEchecs} non vérifiée${importEchecs > 1 ? "s" : ""} faute de réseau`);
  if (douteuses)   bouts.push(`${douteuses} incertaine${douteuses > 1 ? "s" : ""}, décochée${douteuses > 1 ? "s" : ""} par précaution`);

  $("import-bilan").textContent =
    `${bouts.join(" · ")}. Vérifie, corrige ce qui doit l'être, puis valide.`;
  $("import-valider").disabled = cochees === 0;
  $("import-tout").textContent  = cochees === 0 ? "Tout cocher" : "Tout décocher";
}

$("import-tout").addEventListener("click", () => {
  const cocher = importEntrees.filter((e) => e.garder).length === 0;
  importEntrees.forEach((e) => { e.garder = cocher; });
  $("import-lignes").querySelectorAll("input[type=checkbox]").forEach((c) => {
    c.checked = cocher;
  });
  bilanImport();
});

$("import-valider").addEventListener("click", async () => {
  if (!currentUser) return ouvrirConnexion("Crée un compte pour importer ta liste.");

  const statut = $("import-statut").value;
  const uid = currentUser.uid;

  /* Une même série peut apparaître deux fois dans le texte collé, ou deux
     lignes différentes peuvent tomber sur le même titre. */
  /* Repasser deux fois la même liste ne doit rien dupliquer. Une série
     reconnue se reconnaît à son identifiant TMDB ; une série créée à la
     main n'en a pas, on la rapproche donc par son titre normalisé — c'est le
     seul point commun entre deux imports du même fichier. */
  const localesExistantes = new Map(
    listeCache.filter((s) => estLocale(s.id)).map((s) => [cleTitre(s.title), s.id])
  );

  const vus = new Set();
  const retenues = importEntrees.filter((e) => {
    if (!e.garder) return false;
    const cle = e.choix ? e.choix.id : "titre:" + cleTitre(e.titre);
    if (vus.has(cle)) return false;
    vus.add(cle);
    return true;
  });

  if (!retenues.length) return toast("Rien de coché.");

  importOccupe = true;
  $("import-valider").disabled = true;
  $("import-valider").textContent = "Enregistrement…";

  /* Une écriture par série serait lente et bruyante. Firestore accepte 500
     opérations par lot ; on découpe large pour rester à l'aise. */
  const OPS = 400;
  const operations = [];

  /* Trois cents séries écrites en un lot partagent la même milliseconde :
     l'ordre du fichier serait perdu, et « ordre d'ajout » afficherait un
     classement arbitraire. On écarte donc les horodatages d'un millième de
     seconde chacun, dans l'ordre où les lignes ont été collées. */
  /* La recherche ne donne ni saisons ni nombre d'épisodes. On va donc chercher
     la fiche complète des nouvelles séries reconnues, quatre à la fois. Une
     fiche qui ne répond pas n'empêche rien : la série entre quand même, ses
     saisons arriveront à la prochaine visite. */
  const aCompleter = retenues
    .filter((e) => e.choix && !listeCache.some((s) => s.id === e.choix.id));
  const fiches = new Map();
  let faites = 0;

  await enParallele(aCompleter, 4, async (e) => {
    try { fiches.set(e.choix.id, await parIdentifiant(e.choix.id)); } catch {}
    faites++;
    $("import-valider").textContent = `Saisons… ${faites} / ${aCompleter.length}`;
  });
  $("import-valider").textContent = "Enregistrement…";

  const instant = Date.now();
  const reordonner = $("import-reordonner").checked;

  retenues.forEach((e, rangEntree) => {
    /* Sans correspondance TMDB, la série est créée telle qu'elle était
       écrite : titre seul, sans jaquette, modifiable depuis sa fiche. Si un
       import précédent l'a déjà créée, on reprend son identifiant au lieu
       d'en fabriquer un second. */
    const cleLocale = cleTitre(e.titre);
    const m = e.choix || {
      id: localesExistantes.get(cleLocale) || nouvelIdLocal(),
      title: e.titre, cover: "", episodes: 0
    };
    if (!e.choix) localesExistantes.set(cleLocale, m.id);
    const dejaSuivie = listeCache.find((s) => s.id === m.id);
    const fiche = fiches.get(m.id);
    const diffusion = fiche ? champsDiffusion(fiche) : {};
    const episodes = Math.min(Math.max(diffusion.episodes ?? m.episodes ?? 0, 0), 10000);

    /* « Déjà vue » sur une série encore en diffusion veut dire « à jour » :
       elle reste en cours, pour que les prochains épisodes s'affichent. */
    const statutFinal = statut === "termine" && fiche && !diffusion.finie ? "en_cours" : statut;

    const data = {
      id: m.id,
      title: (fiche?.title || m.title).slice(0, 300),
      cover: (fiche?.cover || m.cover || "").slice(0, 500),
      vus: statut === "termine" ? episodes : 0,
      statut: statutFinal,
      addedAt: instant + rangEntree,
      genres: (m.genres || []).slice(0, 12),
      format: (m.format || "").slice(0, 20),
      ...diffusion,
      episodes
    };

    // La note accompagne la série : elle reste personnelle et n'entre dans
    // aucune moyenne. Une série déjà suivie garde sa progression, mais reçoit
    // quand même la note du fichier.
    if (e.note) { data.note = e.note; data.sur = echelleImport; }

    if (dejaSuivie) {
      /* Une série déjà suivie n'est jamais réécrite : sa progression, ses
         images et ses corrections valent mieux que ce que dit le fichier.
         Seules la note et, si tu l'as demandé, sa place dans l'ordre. */
      const retouche = {};
      if (e.note) { retouche.note = e.note; retouche.sur = echelleImport; }
      if (reordonner) retouche.addedAt = instant + rangEntree;

      if (!Object.keys(retouche).length) return;
      operations.push({
        ref: refSerie(uid, m.id),
        data: retouche,
        fusion: true
      });
      return;
    }

    operations.push({ ref: refSerie(uid, m.id), data });
  });

  try {
    for (let i = 0; i < operations.length; i += OPS) {
      const lot = writeBatch(db);
      operations.slice(i, i + OPS).forEach((o) => lot.set(o.ref, o.data, { merge: !!o.fusion }));
      await lot.commit();
    }

    $("import-screen").hidden = true;
    $("import-texte").value = "";
    toast(reordonner
      ? `${retenues.length} série${retenues.length > 1 ? "s" : ""} enregistrée${retenues.length > 1 ? "s" : ""}, ta liste suit l'ordre du fichier.`
      : `${retenues.length} série${retenues.length > 1 ? "s" : ""} ajoutée${retenues.length > 1 ? "s" : ""} à ta liste.`);
  } catch (err) {
    console.error("Import :", err.code, err.message);
    toast("L'enregistrement a échoué. Réessaie dans un instant.");
  } finally {
    importOccupe = false;
    $("import-valider").disabled = false;
    $("import-valider").textContent = "Ajouter à ma liste";
  }
});

/* ══════════════════ Fiche ══════════════════ */

function ouvrirFiche(a) {
  ficheCourante = a;
  $("ep-saisie").hidden = true;
  majFiche();
  showView("fiche");
  // Tableau de bord : les séries les plus consultées (voir suivi.js)
  if (a && a.id) window.suivi?.contenu("serie", a.id, a.title);
}

/* Les années de diffusion disent beaucoup : « 2011–2019 » annonce une série
   finie, « depuis 2022 » une série en cours. */
function annees(a) {
  if (!a.annee) return "";
  if (a.diffusion === "finie" && a.anneeFin && a.anneeFin !== a.annee) return `${a.annee}–${a.anneeFin}`;
  if (a.diffusion === "en_cours" && a.complet) return `depuis ${a.annee}`;
  return a.annee;
}

function texteDiffusion(a, suivi) {
  if (a.locale) return "";
  const prochain = a.prochain || suivi?.prochain;
  if (prochain?.date && prochain.date >= aujourdhui()) {
    return `Prochain épisode : ${sxe(prochain.saison, prochain.episode)}, ${quand(prochain.date)}`;
  }
  switch (a.statutDiff) {
    case "Ended":            return `Série terminée${a.anneeFin ? ` en ${a.anneeFin}` : ""}`;
    case "Canceled":         return `Série annulée${a.anneeFin ? ` en ${a.anneeFin}` : ""}`;
    case "Returning Series": return "Renouvelée — la date de la suite n'est pas encore connue";
    case "In Production":    return "En production";
  }
  if (a.diffusion === "a_venir") {
    return a.debut ? `Première diffusion ${quand(a.debut)}` : "Annoncée, sans date pour l'instant";
  }
  return "";
}

function majFiche() {
  const a = ficheCourante;
  if (!a) return;
  const suivi = listeCache.find((s) => s.id === a.id);

  $("fiche-cover").hidden = !a.cover;
  $("fiche-cover-vide").hidden = !!a.cover;
  if (a.cover) $("fiche-cover").src = a.cover;
  else $("fiche-cover-vide").textContent = initiales(a.title);
  $("fiche-titre").textContent = a.title;

  const nbSaisons = (a.saisons || []).filter((s) => s.total > 0 || s.diffuses > 0).length;
  const bouts = a.locale ? ["Ajoutée par toi"] : [
    TYPES[a.type] || (a.complet ? "Série" : ""),
    nbSaisons ? `${nbSaisons} saison${nbSaisons > 1 ? "s" : ""}` : null,
    a.episodes ? `${a.episodes} épisode${a.episodes > 1 ? "s" : ""}` : null,
    a.reseau,
    annees(a)
  ];
  $("fiche-sous").textContent = bouts.filter(Boolean).join(" · ");

  const credits = [];
  if (a.createurs?.length) credits.push(`Créée par ${a.createurs.slice(0, 3).join(", ").replace(/, ([^,]*)$/, " et $1")}`);
  if (a.original && cleTitre(a.original) !== cleTitre(a.title)) credits.push(`Titre original : ${a.original}`);
  $("fiche-credits").textContent = credits.join(" · ");
  $("fiche-credits").hidden = !credits.length;

  $("fiche-genres").innerHTML = (a.genres || [])
    .map((g) => `<span class="etiquette">${escapeHtml(g)}</span>`).join("");

  const diffusion = texteDiffusion(a, suivi);
  $("fiche-diffusion").textContent = diffusion;
  $("fiche-diffusion").hidden = !diffusion;

  if (a.complet || a.locale || a.resume) $("fiche-resume").textContent = a.resume || "";

  afficherPlateformes(a.liens);
  afficherNotePerso(suivi);
  afficherSaisons(a, suivi);
  $("fiche-modifier").hidden = !suivi;

  $("fiche-suivi").hidden   = !suivi;
  $("fiche-danger").hidden  = !suivi;
  $("fiche-ajouter").hidden = !!suivi;
  $("fiche-ajouter").textContent = currentUser
    ? "Ajouter à ma liste"
    : "Créer un compte pour suivre cette série";

  if (!suivi) return;

  const total = suivi.episodes || 0;
  const pct = total ? Math.min(100, Math.round((suivi.vus / total) * 100)) : 0;
  const finie = suivi.finie || estLocale(suivi.id);
  const ajour = estAJour(suivi);
  const p = position(suivi.vus, suivi.saisons);

  $("fiche-barre").style.width = `${pct}%`;

  let texte;
  if (!suivi.vus) {
    texte = total ? `Pas encore commencée — ${total} épisode${total > 1 ? "s" : ""} à voir` : "Pas encore commencée";
  } else {
    const ou = p ? `Dernier épisode vu : ${sxe(p.saison, p.episode)}` : `${suivi.vus} épisode${suivi.vus > 1 ? "s" : ""} vu${suivi.vus > 1 ? "s" : ""}${total ? ` sur ${total}` : ""}`;
    const suite = !total ? ""
      : ajour ? (finie ? " — série terminée" : " — tu es à jour")
      : ` — il t'en reste ${total - suivi.vus}`;
    texte = ou + suite;
  }
  $("fiche-progression").textContent = texte;

  $("ep-moins").disabled = suivi.vus <= 0;
  $("ep-plus").disabled  = total > 0 && ajour;

  if (total > 0 && ajour) {
    $("ep-plus").textContent = finie ? "Série terminée" : "Tu es à jour";
  } else {
    const suivant = position(suivi.vus + 1, suivi.saisons);
    $("ep-plus").textContent = suivant && suivi.saisons?.length
      ? `J'ai vu ${sxe(suivant.saison, suivant.episode)}`
      : "J'ai vu l'épisode suivant";
  }

  document.querySelectorAll(".statut").forEach((b) =>
    b.classList.toggle("is-active", b.dataset.statut === suivi.statut));
}

/* La liste des saisons : pour savoir ce qui existe, et pour rattraper d'un
   geste (« j'ai fini la saison 3 » coche d'un coup les trois premières). */
function afficherSaisons(a, suivi) {
  const zone = $("fiche-saisons");
  const bloc = $("fiche-saisons-bloc");

  // Les comptes enregistrés font foi pour la progression ; la fiche TMDB
  // apporte les noms et les dates.
  const comptes = suivi?.saisons?.length ? suivi.saisons : (a.saisons || []).map((s) => s.diffuses);
  const details = a.saisons || [];
  const n = Math.max(comptes.length, details.length);

  bloc.hidden = n === 0 || a.locale;
  zone.innerHTML = "";
  if (bloc.hidden) return;

  let cumul = 0;
  for (let i = 0; i < n; i++) {
    const d = details[i] || {};
    const diffuses = comptes[i] ?? d.diffuses ?? 0;
    const total = d.total || diffuses;
    const avant = cumul;
    cumul += diffuses;

    const vusIci = suivi ? Math.max(0, Math.min(diffuses, suivi.vus - avant)) : 0;
    const finie  = suivi && diffuses > 0 && vusIci >= diffuses;

    let meta;
    if (!diffuses) meta = d.date && d.date > aujourdhui() ? `À venir · ${quand(d.date)}` : "Pas encore diffusée";
    else if (total > diffuses) meta = `${diffuses} épisodes diffusés sur ${total}`;
    else meta = `${diffuses} épisode${diffuses > 1 ? "s" : ""}${d.date ? ` · ${d.date.slice(0, 4)}` : ""}`;

    const ligne = document.createElement("div");
    ligne.className = "saison-ligne" + (finie ? " est-vue" : "") + (!diffuses ? " est-future" : "");
    const nom = d.nom && !/^(saison|season) \d+$/i.test(d.nom) ? `Saison ${d.numero ?? i + 1} · ${d.nom}` : `Saison ${d.numero ?? i + 1}`;

    ligne.innerHTML = `
      <div class="saison-infos">
        <span class="saison-nom">${escapeHtml(nom)}</span>
        <span class="saison-meta">${escapeHtml(meta)}</span>
      </div>
      ${suivi && diffuses ? `
        <div class="saison-progression">
          <div class="saison-barre"><span style="width:${Math.round((vusIci / diffuses) * 100)}%"></span></div>
          <span class="saison-compte">${vusIci} / ${diffuses}</span>
        </div>` : ""}`;

    if (suivi && diffuses) {
      if (finie) {
        ligne.insertAdjacentHTML("beforeend",
          `<svg class="saison-coche" viewBox="0 0 24 24" aria-label="Saison vue"><path d="M4 12.5l5 5L20 6.5"/></svg>`);
      } else {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "btn-link saison-vue";
        b.textContent = "Tout vu";
        b.title = `Marquer vus tous les épisodes jusqu'à la fin de la saison ${i + 1}`;
        const fin = avant + diffuses;
        b.addEventListener("click", () => {
          const frais = listeCache.find((x) => x.id === suivi.id);
          if (frais) fixerVus(frais, Math.max(frais.vus, fin));
        });
        ligne.appendChild(b);
      }
    }
    zone.appendChild(ligne);
  }
}

$("fiche-ajouter").addEventListener("click", async () => {
  let a = ficheCourante;
  if (!a) return;
  if (!currentUser) return ouvrirConnexion("Crée un compte pour suivre cette série.");

  $("fiche-ajouter").disabled = true;
  try {
    // Les saisons ne sont pas dans les résultats de recherche : on attend la
    // fiche complète pour enregistrer une série qu'on pourra suivre épisode
    // par épisode.
    if (!a.complet && !a.locale) {
      try { a = await parIdentifiant(a.id); } catch {}
    }
    const rien = !a.episodes && (a.diffusion === "a_venir" || !a.complet);

    await setDoc(refSerie(currentUser.uid, a.id), {
      id: a.id, title: a.title.slice(0, 300), cover: a.cover || "",
      vus: 0,
      statut: rien ? "a_voir" : "en_cours",
      addedAt: Date.now(),
      genres: (a.genres || []).slice(0, 12),
      format: (a.type || "").slice(0, 20),
      ...(a.complet ? champsDiffusion(a) : { episodes: 0 })
    });
    toast(`${a.title} est dans ta liste.`);
    // Tableau de bord : les séries les plus ajoutées aux listes
    window.suivi?.contenu("ajout", a.id, a.title);
    window.suivi?.action("ajout-liste");
  } catch (err) {
    console.error("Ajout :", err.code, err.message);
    toast("L'ajout a échoué.");
  } finally {
    $("fiche-ajouter").disabled = false;
  }
});

const majSuivi = (id, champs) => updateDoc(refSerie(currentUser.uid, id), champs);

/* Le statut suit la progression : arriver au bout d'une série finie la
   termine ; arriver au bout d'une série encore en diffusion te met « à jour »,
   mais elle reste en cours pour que ses prochains épisodes s'affichent. */
function statutPour(s, vus) {
  const total = s.episodes || 0;
  if (total && vus >= total) return (s.finie || estLocale(s.id)) ? "termine" : "en_cours";
  if (vus > 0) return "en_cours";
  return s.statut === "termine" ? "en_cours" : s.statut;
}

async function fixerVus(s, vus) {
  const max = s.episodes || 10000;
  vus = Math.max(0, Math.min(vus, max));
  try {
    await majSuivi(s.id, { vus, statut: statutPour(s, vus) });
  } catch (err) {
    console.error("Progression :", err.code, err.message);
    return toast("La progression n'a pas pu être enregistrée.");
  }

  // Un petit mot quand une saison se termine : c'est un moment.
  if (Array.isArray(s.saisons) && vus > s.vus) {
    let cumul = 0;
    for (let i = 0; i < s.saisons.length; i++) {
      cumul += s.saisons[i];
      if (s.saisons[i] && cumul === vus) {
        toast(s.episodes && vus >= s.episodes && s.finie
          ? `${s.title} : série terminée !`
          : `Saison ${i + 1} terminée !`);
        break;
      }
      if (cumul > vus) break;
    }
  }
}

$("ep-plus").addEventListener("click", () => {
  const s = listeCache.find((x) => x.id === ficheCourante?.id);
  if (s) fixerVus(s, s.vus + 1);
});

$("ep-moins").addEventListener("click", () => {
  const s = listeCache.find((x) => x.id === ficheCourante?.id);
  if (s && s.vus > 0) fixerVus(s, s.vus - 1);
});

/* Choisir directement « saison 4, épisode 6 » évite quarante clics à qui
   reprend une série en cours de route. */
$("ep-choisir").addEventListener("click", () => {
  const s = listeCache.find((x) => x.id === ficheCourante?.id);
  if (!s) return;

  const panneau = $("ep-saisie");
  panneau.hidden = !panneau.hidden;
  if (panneau.hidden) return;

  const select = $("ep-saison");
  const saisons = Array.isArray(s.saisons) ? s.saisons : [];
  const avecSaisons = saisons.some(Boolean);

  $("ep-saison-champ").hidden = !avecSaisons;
  $("ep-numero-libelle").textContent = avecSaisons ? "Dernier épisode vu" : "Épisodes vus";

  if (avecSaisons) {
    select.innerHTML = "";
    saisons.forEach((n, i) => {
      if (!n) return;
      const opt = document.createElement("option");
      opt.value = i + 1;
      opt.textContent = `Saison ${i + 1} (${n} ép.)`;
      select.appendChild(opt);
    });
    const p = position(Math.max(s.vus, 1), saisons);
    select.value = String(p.saison);
    $("ep-numero").value = s.vus ? p.episode : 0;
    $("ep-numero").max = saisons[p.saison - 1];
  } else {
    $("ep-numero").value = s.vus;
    $("ep-numero").max = s.episodes || 10000;
  }
  $("ep-numero").focus();
  $("ep-numero").select?.();
});

$("ep-saison").addEventListener("change", () => {
  const s = listeCache.find((x) => x.id === ficheCourante?.id);
  const n = Number($("ep-saison").value);
  const max = s?.saisons?.[n - 1] || 0;
  $("ep-numero").max = max;
  if (Number($("ep-numero").value) > max) $("ep-numero").value = max;
});

async function validerSaisie() {
  const s = listeCache.find((x) => x.id === ficheCourante?.id);
  if (!s) return;

  const e = Number($("ep-numero").value);
  const avecSaisons = !$("ep-saison-champ").hidden;
  const max = Number($("ep-numero").max) || 10000;

  if (!Number.isInteger(e) || e < 0 || e > max) return toast(`Indique un nombre entre 0 et ${max}.`);

  const vus = avecSaisons ? vusJusqua(s.saisons, Number($("ep-saison").value), e) : e;
  await fixerVus(s, vus);
  $("ep-saisie").hidden = true;
  toast("Progression mise à jour.");
}

$("ep-valider").addEventListener("click", validerSaisie);
$("ep-numero").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") { ev.preventDefault(); validerSaisie(); }
});

document.querySelectorAll(".statut").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const s = listeCache.find((x) => x.id === ficheCourante?.id);
    if (!s) return;
    const statut = btn.dataset.statut;
    // « Terminé » sur une série finie coche aussi tous ses épisodes.
    const champs = { statut };
    if (statut === "termine" && s.episodes && s.vus < s.episodes) champs.vus = s.episodes;
    await majSuivi(s.id, champs);
  });
});

$("fiche-retirer").addEventListener("click", async () => {
  const s = listeCache.find((x) => x.id === ficheCourante?.id);
  if (!s) return;
  if (!confirm(`Retirer « ${s.title} » de ta liste ?`)) return;
  await deleteDoc(refSerie(currentUser.uid, s.id));
  toast("Retirée de ta liste.");
  showView("liste");
});

/* ══════════════════ Notes personnelles ══════════════════

   Les notes vivaient dans une collection publique, et chaque note alimentait
   une moyenne visible de tous. Elles sont désormais rangées dans la fiche de
   suivi de chacun : personne d'autre ne les voit, et ta liste n'influence plus
   ce qu'affiche le site aux autres.

   Effet de bord appréciable : la moyenne demandait une requête d'agrégation
   par jaquette entrant à l'écran. Avec trois cents séries, faire défiler sa
   liste déclenchait trois cents requêtes. La note est maintenant déjà là,
   dans les données de la liste, et ne coûte plus rien.

   L'échelle est enregistrée avec la note. Un 17 saisi sur 20 se réaffiche
   « 17/20 », pas « 9/10 » : convertir, c'est perdre la moitié des nuances.
   ════════════════════════════════════════════════════════ */

const ECHELLES = [10, 20];

// L'échelle de saisie peut être sur 5 ; on la range sur 10, qui la contient.
const echelleRangee = (e) => (Number(e) === 20 ? 20 : 10);

const convertirNote = (valeur, depuis, vers) =>
  Math.min(vers, Math.max(1, Math.round((valeur / depuis) * vers)));

const texteNote = (s) => (s && s.note ? `${s.note}/${s.sur || 10}` : "");

/* Dernière échelle utilisée, retenue le temps de la session : qui note sur 20
   note sur 20 pour toutes ses séries, et n'a pas à le redire à chaque fiche. */
let echellePreferee = 20;

/* Disponibilités en France (source : JustWatch, via TMDB). TMDB ne donne pas
   de lien direct vers chaque plateforme, seulement une page qui les réunit :
   chaque logo y mène. */
function afficherPlateformes(liens) {
  const bloc = $("fiche-plateformes");
  bloc.hidden = !liens;
  if (!liens) return;

  const zone = $("fiche-liens");
  zone.innerHTML = "";

  const groupe = (titre, liste, classe) => {
    if (!liste.length) return;
    const t = document.createElement("p");
    t.className = "plateformes-groupe";
    t.textContent = titre;
    zone.appendChild(t);

    const ligne = document.createElement("div");
    ligne.className = "plateformes-liste";
    liste.forEach((p) => {
      const el = document.createElement(liens.lien ? "a" : "span");
      el.className = "plateforme " + classe;
      if (liens.lien) { el.href = liens.lien; el.target = "_blank"; el.rel = "noopener noreferrer"; }
      el.innerHTML = (p.logo ? `<img src="${escapeHtml(p.logo)}" alt="" loading="lazy">` : "") +
        `<span>${escapeHtml(p.nom)}</span>`;
      ligne.appendChild(el);
    });
    zone.appendChild(ligne);
  };

  groupe("Avec un abonnement", liens.abonnement, "est-fr");
  groupe("À la location ou à l'achat", liens.achat, "");

  $("plateformes-note").textContent =
    "Disponibilités en France fournies par JustWatch via TMDB. Elles changent souvent : vérifie sur la plateforme.";
}

function afficherNotePerso(suivi) {
  const bloc = $("fiche-note-bloc");
  bloc.hidden = !suivi;
  if (!suivi) return;

  const sur = suivi.sur || echellePreferee;

  $("fiche-note").textContent = suivi.note
    ? `${suivi.note} sur ${sur}`
    : "Pas encore notée";

  document.querySelectorAll(".echelle").forEach((b) =>
    b.classList.toggle("is-active", Number(b.dataset.sur) === sur));

  const zone = $("fiche-notes");
  zone.innerHTML = "";

  for (let i = 1; i <= sur; i++) {
    const atteint = suivi.note && i <= suivi.note;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "note-btn" + (atteint ? " is-atteint" : "") + (suivi.note === i ? " is-active" : "");
    b.textContent = i;
    b.setAttribute("aria-pressed", String(suivi.note === i));
    // Recliquer sur sa propre note l'efface : c'est le seul moyen de revenir
    // à « pas notée » sans inventer un bouton de plus.
    b.addEventListener("click", () => noter(suivi.id, suivi.note === i ? null : i, sur));
    zone.appendChild(b);
  }

  const info = document.createElement("span");
  info.className = "note-mienne";
  info.textContent = suivi.note
    ? "Clique à nouveau sur ta note pour l'effacer"
    : "Personne d'autre ne voit tes notes";
  zone.appendChild(info);
}

async function noter(id, valeur, sur) {
  if (!currentUser) return;
  echellePreferee = sur;
  try {
    await majSuivi(id, valeur === null
      ? { note: deleteField(), sur: deleteField() }
      : { note: valeur, sur });
  } catch (err) {
    console.error("Note :", err.code, err.message);
    toast("La note n'a pas pu être enregistrée.");
  }
}

/* Changer d'échelle reporte la note au prorata : 17/20 devient 9/10. La
   conversion perd de la finesse dans ce sens, jamais dans l'autre. */
document.querySelectorAll(".echelle").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const s = listeCache.find((x) => x.id === ficheCourante?.id);
    if (!s) return;
    const sur = Number(btn.dataset.sur);
    echellePreferee = sur;
    if (!s.note) { afficherNotePerso({ ...s, sur }); return; }
    await majSuivi(s.id, { note: convertirNote(s.note, s.sur || 10, sur), sur });
  });
});

/* ══════════════════ Fond réactif ══════════════════ */

(function fondReactif() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const racine = document.documentElement;
  let enAttente = false;

  const majuster = () => {
    const hauteur = racine.scrollHeight - window.innerHeight;
    const part = hauteur > 0 ? Math.min(1, window.scrollY / hauteur) : 0;
    const x = Math.sin(part * 8.2 + 0.9) * 20 + Math.sin(part * 17.5 + 1.2) * 9;
    const y = part * 104 + Math.sin(part * 8.6) * 11;
    racine.style.setProperty("--defile", part.toFixed(4));
    racine.style.setProperty("--halo-x", x.toFixed(2));
    racine.style.setProperty("--halo-y", y.toFixed(2));
    enAttente = false;
  };

  const auDefilement = () => {
    if (enAttente) return;
    enAttente = true;
    requestAnimationFrame(majuster);
  };

  addEventListener("scroll", auDefilement, { passive: true });
  addEventListener("resize", auDefilement);
  majuster();
})();

/* ══════════════════ Application installable ══════════════════ */

if ("serviceWorker" in navigator) {
  addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js")
      .catch((err) => console.warn("Service worker non enregistré :", err.message));
  });
}

/* ══════════════════ Utilitaires ══════════════════ */

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

let toastTimer;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
}

