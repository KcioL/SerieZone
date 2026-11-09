/* Service worker de SérieZone.

   Le code du site passe par le réseau d'abord, pour qu'une mise en ligne
   s'applique immédiatement. Les images et les bibliothèques versionnées
   restent en cache. */

const VERSION = "seriezone-v2";

const COQUE = [
  "./", "./index.html", "./style.css", "./app.js",
  "./firebase-config.js", "./manifest.json", "./suivi.js"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => Promise.allSettled(COQUE.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((noms) => Promise.all(noms.filter((n) => n !== VERSION).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  /* SDK Firebase et polices : indispensables au démarrage, et leur URL porte
     un numéro de version. Sans elles en cache, l'import échoue hors ligne et
     aucune ligne de app.js ne s'exécute. */
  const BIBLIOTHEQUES = ["www.gstatic.com", "fonts.googleapis.com", "fonts.gstatic.com"];

  if (BIBLIOTHEQUES.includes(url.hostname)) {
    e.respondWith(caches.match(req).then((c) => c || fetch(req).then((rep) => {
      if (rep.ok) { const copie = rep.clone(); caches.open(VERSION).then((ca) => ca.put(req, copie)); }
      return rep;
    })));
    return;
  }

  // Données : jamais interceptées. TMDB (via le relais), Firestore et l'authentification
  // doivent rester en direct.
  if (url.origin !== self.location.origin) return;

  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req).then((rep) => {
        const copie = rep.clone();
        caches.open(VERSION).then((c) => c.put("./index.html", copie));
        return rep;
      }).catch(() => caches.match("./index.html"))
    );
    return;
  }

  // Le code évolue avec la page : même stratégie qu'elle, sans quoi les deux
  // se désynchronisent et l'affichage casse après une mise en ligne.
  if (/\.(css|js|json)$/.test(url.pathname)) {
    e.respondWith(
      fetch(req).then((rep) => {
        if (rep.ok) { const copie = rep.clone(); caches.open(VERSION).then((c) => c.put(req, copie)); }
        return rep;
      }).catch(() => caches.match(req))
    );
    return;
  }

  e.respondWith(caches.match(req).then((c) => c || fetch(req)));
});
