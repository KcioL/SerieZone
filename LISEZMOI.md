# SérieZone — mise en route

C'est le même principe qu'AnimeZone, mais pour les séries. Les données viennent de TMDB.
La mise en route se fait en trois étapes, une seule fois (environ 20 minutes).

---

## 1. Le relais qui cache la clé TMDB (Cloudflare, gratuit)

Un site hébergé sur GitHub Pages ne peut rien cacher : n'importe qui peut lire le
code d'une page. La clé TMDB est donc rangée dans un petit relais Cloudflare.
Le site passe par ce relais, et la clé n'apparaît jamais dans le site.

1. Crée un compte gratuit sur <https://dash.cloudflare.com/sign-up>.
2. Va dans **Workers & Pages → Create → Create Worker**. Nomme-le `seriezone-tmdb`,
   puis clique sur **Deploy**.
3. Clique sur **Edit code**. Efface tout, colle le contenu du fichier
   `relais-tmdb/worker.js`, puis clique sur **Deploy**.
4. Va dans **Settings → Variables and Secrets** et ajoute :
   - `TMDB_TOKEN`, de type **Secret** : ton **jeton d'accès en lecture** TMDB,
     le long jeton qui commence par `eyJ…`.
   - `ORIGINES`, de type **Text** : l'adresse de ton site, sans `/` à la fin.
     Par exemple `https://tonpseudo.github.io`. Pour tester sur ton ordinateur,
     ajoute `,http://localhost:8000` à la suite.
5. Note l'adresse du relais, affichée en haut de la page,
   par exemple `https://seriezone-tmdb.tonpseudo.workers.dev`.

Pour vérifier, ouvre `https://seriezone-tmdb.tonpseudo.workers.dev/tv/1399` dans
ton navigateur. Tu dois voir « Site non autorisé ». C'est normal : seul ton site
a le droit de l'utiliser.

> La clé ne doit apparaître **nulle part** dans les fichiers du site, ni sur GitHub.

## 2. Un nouveau projet Firebase

1. Sur <https://console.firebase.google.com>, crée un projet `seriezone`.
2. Va dans **Authentication → Sign-in method** et active **E-mail/Mot de passe**.
3. Va dans **Firestore Database → Créer une base de données**. Choisis une région
   en Europe (par exemple `europe-west1`) et le mode production.
4. Dans **Firestore → Règles**, colle le contenu de `firestore.rules`, puis clique
   sur **Publier**.
5. Va dans **Paramètres du projet → Tes applications → </> (Web)**. Enregistre l'appli
   et copie l'objet `firebaseConfig`.
6. Dans **Authentication → Settings → Authorized domains**, ajoute le domaine de ton
   site (par exemple `tonpseudo.github.io`).

## 3. Relier les deux et mettre en ligne

Ouvre `firebase-config.js` et remplis :

- `firebaseConfig` : les valeurs copiées à l'étape 2.5 ;
- `relaisTMDB` : l'adresse du relais notée à l'étape 1.5.

Mets ensuite le dossier sur GitHub et active GitHub Pages, comme pour AnimeZone.

---

## Comment fonctionne le suivi

- Chaque série garde **le nombre d'épisodes vus**, et le site en déduit la saison et
  l'épisode (« S3 · É5 »).
- Dans la fiche d'une série :
  - **J'ai vu S3 · É6** avance d'un épisode ;
  - **Choisir où j'en suis** permet de choisir une saison et un épisode ;
  - **Tout vu** sur une saison coche tout jusqu'à la fin de cette saison.
- Si une série est encore en diffusion et que tu as tout vu, tu es **« À jour »** : elle
  reste en cours. Quand un nouvel épisode sort, il apparaît de lui-même.
- À chaque visite, les séries en diffusion sont rafraîchies en arrière-plan. C'est
  ce qui remplit le bloc **« Tes prochains épisodes »** de l'onglet À venir.
- L'import accepte les mêmes listes qu'AnimeZone (« breaking bad 18/20 »…). Les
  séries marquées « déjà vues » qui sont encore en diffusion sont mises « à jour ».

## Le tableau de bord des visites

`suivi.js` envoie les statistiques dans la Realtime Database d'**AnimeZone**, sous
`stats/seriezone/`. Ton tableau de bord voit ainsi les deux sites. Si les règles
`stats` de cette base n'acceptent qu'un nom de site précis, ajoute `seriezone`.

## Ce qui reste à faire de ton côté

- Les conditions de TMDB demandent leur logo dans les crédits. La mention écrite
  est déjà en bas de page. Tu peux y ajouter leur logo officiel, téléchargeable sur
  <https://www.themoviedb.org/about/logos-attribution>.
