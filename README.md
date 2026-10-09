# Nexa ERP

Application de gestion d'entreprise **hors ligne d'abord** : une seule base de code pour le web (PWA), Windows, macOS, Linux et mobile.

Premiers modules : **Utilisateurs/Accès**, **Stock**, **Ventes**.

## Architecture

| Dossier | Rôle |
|---|---|
| `client/` | Interface React + TypeScript (Vite). Données locales dans IndexedDB (Dexie). Emballée par Tauri 2 pour le bureau (`client/src-tauri`) et servie comme PWA pour le navigateur. |
| `server/` | API Rust (Axum) + PostgreSQL. Authentification, permissions, synchronisation. |
| `scripts/smoke.mjs` | Test de bout en bout du serveur. |
| `.github/workflows/` | `ci.yml` (tests) et `release.yml` (applications de bureau). |

### Fonctionnement hors ligne
- L'interface lit et écrit **uniquement dans la base locale**. Elle est embarquée (Tauri) ou mise en cache (service worker de la PWA), donc elle s'ouvre sans réseau.
- Chaque écriture ajoute une **opération** (identifiant unique) à une file d'envoi. Au retour du réseau, le client envoie la file, puis lit les changements du serveur depuis son curseur.
- Le serveur applique chaque opération **une seule fois** (rejeu sans effet) et la valide. Une opération refusée est annulée localement et listée dans la barre de synchronisation.
- **Stock** : registre de mouvements en ajout seulement ; la quantité est la somme des mouvements. Une vente qui rend le stock négatif est acceptée et signalée dans « Anomalies de stock ».
- **Numéros de vente** attribués par le serveur (`VE-000001`…) ; « En attente d'envoi » s'affiche tant qu'ils ne sont pas connus.
- **Données de référence** (articles, clients, entrepôts) : en cas de modification concurrente, la dernière opération reçue par le serveur l'emporte.
- **Comptes utilisateurs** : gérés uniquement en ligne.

### Rôles
`admin` (tout), `vendeur` (ventes, lecture du stock), `magasinier` (stock, lecture des ventes). Les permissions sont vérifiées par le serveur à chaque requête.

## Développer (GitHub Codespaces)

```bash
# 1. Serveur (PostgreSQL requis, par exemple une base Neon)
cd server
cp .env.example .env   # puis renseigner les valeurs
set -a; source .env; set +a
cargo run

# 2. Client (autre terminal)
cd client
npm ci
npm run dev            # http://localhost:5173, l'API est relayée vers le port 8080
```

Connexion avec `ADMIN_EMAIL` / `ADMIN_PASSWORD` (compte créé au premier démarrage si la base est vide).

Tests :
```bash
ADMIN_EMAIL=… ADMIN_PASSWORD=… node scripts/smoke.mjs                 # serveur
cd client && TEST_API_URL=http://localhost:8080 ADMIN_EMAIL=… ADMIN_PASSWORD=… npm test   # synchro hors ligne
```

## Déployer le serveur (Railway + Neon)
1. Créer le service depuis le dépôt avec **Root Directory = `server`** (le `Dockerfile` est utilisé).
2. Variables : `DATABASE_URL` (URL Neon avec `?sslmode=require`), `JWT_SECRET` (≥ 32 caractères aléatoires), `ADMIN_EMAIL`, `ADMIN_PASSWORD`.
3. Les migrations s'appliquent au démarrage.

## Construire les applications
- **PWA** : `cd client && VITE_API_URL=https://<votre-service> npm run build` puis héberger `client/dist`.
- **Bureau** : dans GitHub, ajouter la variable de dépôt `API_URL` (URL du serveur, et `CURRENCY` si ≠ EUR), puis pousser une étiquette `v0.1.0` (ou lancer `release` manuellement). Les installateurs Windows, macOS et Linux sont attachés à une version brouillon.
- **Android / iOS** : non configurés dans cette version (voir « Suite »).

## Limites connues et suite
- Pas de limitation du nombre de tentatives de connexion (à ajouter avant une exposition publique large).
- Pas de suppression d'entités (désactivation via « Actif »). Quantités entières uniquement.
- Les données locales ne sont pas chiffrées ; à la déconnexion sans opération en attente, elles sont effacées.
- Stockage local : IndexedDB (fonctionne à l'identique dans le navigateur et dans Tauri). Passage à SQLite possible plus tard derrière les modules `ops.ts` / `sync.ts` / `stock.ts`.
- Mobile : `npx tauri android init` puis un job de build à ajouter à `release.yml`.
