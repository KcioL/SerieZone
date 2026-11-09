// Configuration de SérieZone. Deux choses à remplir, une seule fois.
//
// 1. firebaseConfig : les identifiants de TON NOUVEAU projet Firebase
//    (console Firebase → Paramètres du projet → Tes applications → Config).
//    Ce sont des identifiants publics, pas des secrets — c'est firestore.rules
//    qui protège les données.
//
// 2. relaisTMDB : l'adresse de ton relais Cloudflare (voir LISEZMOI.md).
//    Ce n'est PAS la clé TMDB : la clé reste cachée dans le relais.

export const firebaseConfig = {
  apiKey:            "AIzaSyDOQDzKphZHdNDxRGiAqG9UxKw9CUHM6RI",
  authDomain:        "poker-e2c18.firebaseapp.com",
  projectId:         "poker-e2c18",
  storageBucket:     "poker-e2c18.firebasestorage.app",
  messagingSenderId: "313041421349",
  appId:             "1:313041421349:web:37153981aeeea50ba6ebcc"
};

export const relaisTMDB = "https://seriezone-tmdb.gardien64.workers.dev";
