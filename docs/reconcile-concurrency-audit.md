# Audit — Concurrence des réconciliations Feature/Git

## Symptôme (logs pré-fix)

Sur des projets volumineux, des réconciliations Git de **mêmes features** tournent
simultanément : mêmes commandes répétées sur les mêmes SHAs
(`merge-base`, `diff --stat`, `diff --numstat`, `rev-list`, `status --porcelain`),
des passes de réconciliation finissant après 130–337 s, des commandes Git unitaires
de 5–12 s. Une partie de ce travail est purement gaspillé : seul le dernier pass à
committer publie.

## Cause racine

1. **Pas de garde in-flight par scope.** Seule la réconciliation globale
   `FeatureStateCoordinator.reconcile()` (featureStateCoordinator.ts) est protégée
   par `this.inFlight`. `reconcileFeature(featureId)` et `reconcileProject(projectId)`
   lancent une observation complète à chaque appel, sans partage ni fusion des
   requêtes concurrentes pour le même `(projectId, featureId)`.

2. **Les générations ne protègent que la publication, pas l'exécution.**
   `beginDeepObservation`/`commitDeep` invalident le commit d'un pass dont la
   génération est dépassée, mais le pass a déjà exécuté toute la batterie Git
   (`observeBaseRef` + `observeProject` + `inspect()` : resolveCommit ×3–4,
   merge-base, diff --stat/--numstat, rev-list ×2, status…). Un pass concurrent du
   même scope exécute tout, puis est jeté.

3. **Aucun cache Git.** `GitClient` (gitClient.ts) lance un sous-processus `git`
   frais à chaque `read`/`readSync`. `reconcileFeature` relit en plus des faits de
   niveau repository (`observeBaseRef`, `observeProject`) par feature et par pass.

### Déclencheurs qui se chevauchent pour la même feature

- `HomePanel.maybeRefreshFocusedScope` (homePanel.ts) — focus/visibilité du panneau,
  gardé par `isFeatureStale` (45 s) ; or un pass en vol reste « stale »
  (`featureDeepObservedAt` n'est posé qu'à la fin, dans `commitDeep`), donc un
  re-focus pendant un pass de 130–337 s relance.
- Message webview « refresh » (homePanel.ts) — `invalidateFeature` + `void
  reconcileFeature(...)`, sans garde de staleness.
- Fin d'une observation GitHub différée — `void this.reconcileFeature(feature.id)`
  (featureStateCoordinator.ts, `deferGithubObservation`).
- Ré-affichage du panneau → `maybeRefreshFocusedScope`.

## Correctif (branche `fix/coalesce-reconcile-scopes`)

Coalescence par scope, miroir du motif `inFlight`/`reconcileAfterFlight` de
`reconcile()` mais par feature et par projet :

- `featureReconciles` / `projectReconciles` : maps `{ promise, rerun }`.
- Une requête `reconcileFeature(featureId)` pendant qu'une observation est en vol
  **partage sa promesse** (une seule observation à la fois, plus de lectures Git
  parallèles sur les mêmes SHAs) et pose `rerun` ; la boucle ré-observe une fois
  après la passe courante. Idem pour `reconcileProject`.
- Sémantique conservée :
  - « later call wins » : le re-fresh d'un appelant arrivé en vol est publié par le
    suivi (test « a later reconcileFeature call always wins »).
  - Invalidation **demand-driven** : `invalidateFeature` supersede une passe en vol
    via le bump de génération ; rien ne se relance automatiquement (tests
    « invalidated while its repo reads are in flight… »).
  - La coalescence est **par scope** : deux features différentes s'observent encore
    en parallèle (test « coalescing is scoped per feature »).

## Vérification

- `npm run typecheck`
- `npx vitest run src/__tests__/featureStateCoordinator.test.ts` — 41 tests
  (dont 4 nouveaux : partage in-flight 3→1, scoping par feature, coalescence
  `reconcileProject`, refresh mid-flight invalidate+reconcile).
- `npm test -- --run` — baseline connue : 16 échecs environnementaux inchangés.
- `npm run compile`.
