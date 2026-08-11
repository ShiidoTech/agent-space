# Audit architectural — Agent Space / Feature Intelligence

## 0. Vue d'ensemble du parcours de données

Il existe deux surfaces d'affichage et trois sources de persistance :
- Persistance : `GlobalStore` (`preferences.json`, `projects.json`) → `src/storage/globalStore.ts` ; `Store` (par projet : `features.json`, `features/{id}/agents.json`, `features/{id}/services.json`) → `src/storage/store.ts` ; config projet `<repo>/.agentspace/config.json` (+ overlay local) → `src/projects/projectConfig.ts`.
- Affichage : webview Sidebar (`FeatureSidebarProvider`) et panneaux `HomePanel` (welcome / project / feature). Le "Feature page" au sens large = sidebar + `HomePanel.showFeature` (`getFeatureHtml`) + page projet (`getProjectHtml`).
- Git : pas d'abstraction unique. Commandes éparpillées dans 6 fichiers avec duplication de helpers (voir §2).

Point clé : aucun `git fetch` implicite nulle part dans `src` (le seul texte "fetch" est un conseil dans `doctor.ts:659`). Aucune dépendance à `gh`. Confirmé par scan.

## 1. Modèle Feature

### Types (`src/types.ts`)
- `FeatureStatus` = `"active" | "done"` — line 1.
- `GitAwareStatus` = `"new" | "modified" | "ahead" | "merged"` — line 2 (le modèle de "représentation" actuel, très réducteur).
- `Feature` — lines 73-86 : `id`, `name`, `branch`, `worktreePath`, `status`, `color`, `isolation`, `createdAt`, `createdFromSha?`. Propriété clé : `createdFromSha` ("Commit the feature branch was created from, when known").
- `CompanionState` (wrapper `features.json`) — 162-164.
- `Agent` (118-160) avec `sessionBinding`, `sessionBaseline`, `launchedAt`, STARTUP (attention non persistée, recomputée), `Service` (176-187).

### Persistance (`src/storage/store.ts`)
- `loadFeatures`/`saveFeatures` → `features.json` (19-35).
- `loadAgents`/`saveAgents` → `features/{id}/agents.json` (37-59).
- `loadServices`/`saveServices` → `features/{id}/services.json` (61-83).
- `deleteFeatureData` → `rm -rf features/{id}` (85-92).
- Écriture atomique tmp+rename (94-98).

### FeatureManager (`src/features/featureManager.ts`)
- État en mémoire features chargé au constructeur (54), pas de ré-reload tant que `reload()` n'est pas appelé (référence mémorisée, mutée puis `saveFeatures` à chaque fois).
- Branche canonique : `reconcileFeatureBranch` (213-230) — Git est l'autorité : si `git symbolic-ref --quiet --short HEAD` du worktree diffère de `feature.branch` persistée, il réécrit la record. En HEAD détaché / worktree manquant, il garde la valeur persistée (fail-closed, ne devine jamais).
- Base branch : `getBaseBranch` (179-202) — config `baseBranch` en priorité, sinon `git rev-parse --abbrev-ref HEAD` du main checkout, fallback `"main"` en cas d'échec. Fallback implicite `main` : c'est le seul "default non déclaré" (row 199), à noter.
- Création – `createFeatureRecord` (269-321) puis `provisionFeatureAsync` (345-375) : `git rev-parse <base>` → `git worktree add <path> -b <branch> <base>`, stocke `createdFromSha`. Worktree path dérivé `{worktreeBase}/{kind}-{normalizedName}` (296-299).
- Worktree base : `resolveWorktreeBaseDir` (`projectConfig.ts:247-256`) — config `worktreesDir` sinon `<repo>/.worktrees`.
- Delete : `getDeletionSafety` (419-428) → délègue à `checkWorktreeDeletionSafety` ; `deleteFeature` (435-485) → `git worktree remove` (+`--force` seulement en chemin forcé), `deleteFeatureData`.
- `inspectFeatureLifecycle` (111-172) — diagnostic read-only `valid | missing_worktree | detached_head | branch_mismatch | git_state_unknown`.

### Agents / services / sessions
- `AgentManager` (`src/agents/agentManager.ts`) : worktrees per-agent `git worktree add` (104-111), `isAgentBranchMerged` via `merge-base --is-ancestor agentBranch→feature.branch` (355-371), `removeWorktree` (457-479), `deleteAllAgents` (385-393). Sessions tmux `sessionName` dans `tmux.ts` (18-40).
- `ServiceManager` (`src/services/serviceManager.ts`) : tmux sessions services, `refreshStatuses` TTL 5s (97-131), `deleteAllServices` (90-95).
- `TerminalController` (`src/agents/terminalController.ts`) : kill de terminaux par feature.

## 2. Abstractions Git existantes (inventaire exhaustif)

### Helpers locaux dupliqués (3 copies du même pattern)
| Fichier | Helper |
|---|---|
| `src/features/featureGitStatus.ts` | `git(command, cwd)` sync |
| `src/features/featureGitStatus.ts` | `gitQuiet` (retourne null) |
| `src/git/worktreeSafety.ts` | `git(command, cwd)` sync |
| `src/features/featureGitStatus.ts` | `gitCmd` async |
| `src/utils/platform.ts` | `exec/execFile/execAsync/execAsyncSilent` |

### Commandes exécutées (par fichier : ligne)
`featureGitStatus.ts`
- `git status --porcelain` (worktree) — 194, 285
- `git reflog show --format=%H <branch>` (repoRoot) — 26, 270
- `git rev-parse <branch>` — 207, 298 (et 208/301 base)
- `git merge-base --is-ancestor <feature> <base>` — 211, 304
- `git rev-list --count <base>..<feature>` — 230, 323
- `git status --porcelain` base (repoRoot) — 132
- `git rev-list --left-right --count origin/<b>...<b>` — 137
- `git rev-parse --verify --quiet refs/remotes/origin/<b>` — 145
- `git log -1 --format=%h%x20%s <b>` — 150

`worktreeSafety.ts`
- `git status --porcelain` — 49
- `git rev-list --count <base>..<branch>` — 60
- `git rev-parse <branch>/<base>` — 70-71
- `git merge-base --is-ancestor <branch> <base>` — 74

`featureManager.ts`
- `git rev-parse --is-inside-work-tree` — 124
- `git symbolic-ref --quiet --short HEAD` — 142, 216
- `git rev-parse --abbrev-ref HEAD` — 193
- `git rev-parse <baseBranch>` — 351, 383
- `git worktree add <path> -b <branch> <base>` — 359-370, 387
- `git worktree remove <path>[ --force]` — 453-460

`agentManager.ts`
- `git worktree add` (agent isolate) — 104-111, 326-339
- `git merge-base --is-ancestor <agent> <feature>` — 360-366
- `git worktree remove` — 469
- `git rev-parse --abbrev-ref HEAD` — 527

`extension.ts`
- `git push origin <branch>` (worktree) — 1379
- `git remote get-url origin` — 1384
- `git config branch.<b>.github-pr-base-branch <meta>` — 1414-1422
- `git rev-parse --is-inside-work-tree` — 1663
- `git branch --track <b> refs/remotes/origin/<b>` — 1684
- `git show-ref --verify --quiet refs/heads/<b>|refs/remotes/origin/<b>` — 1702

`homePanel.ts` (dans le webview provider — viole "aucune commande Git dans la webview" au sens extension-host, mais c'est l'extension-host qui les exécute ; à noter : ces diffs sont des commandes git dans l'extension host, pas dans la webview DOM)
- `git diff --stat HEAD...<branch>` — 640, 665 ; fallback `git diff --stat HEAD` — 647, 673

`doctor.ts` (read-only)
- `git rev-parse --is-inside-work-tree` — 237 ; `--abbrev-ref HEAD` — 242 ; `git show-ref --verify --quiet refs/{heads,remotes/origin}/<b>` — 253-256 ; `git worktree list --porcelain` — 263.

### Status / merged
- `computeGitStatus` (176-241) : priorité `modified` (porcelain non vide) → `merged` (ancestor + preuve de mouvement reflog/createdFromSha) → `ahead` (rev-list count) → `new`.
- Limites : `status --porcelain` réduit staged/unstaged/untracked à un booléen ; la détection merged repose sur l'heuristique reflog (`branchMovedSinceCreation` 20-40, retourne null si reflog < 2 entrées). Squash merge non traité : après un squash, la branche n'est plus ancêtre de base → `rev-list base..feature` > 0 → statut `ahead` permanent. "PR mergée puis nouveaux commits" indétectable.
- Cache TTL 10s : `gitStatusCache` (42-66), `baseStateCache` (97-174).

### Worktrees / remotes / upstream
- Création/retrait via `git worktree add/remove`. Pas de gestion `--force` hors chemin forcé.
- Remotes : `git remote get-url origin`, `rev-list origin/<b>...<b>`. Aucun `git fetch`.
- `upstream/{upstream}` jamais utilisé ; le create PR utilise une clef config custom `branch.<b>.github-pr-base-branch`.

## 3. Chemin de rendu de la Feature page

### Côté extension host
1. `FeatureSidebarProvider` (`src/features/featureSidebarProvider.ts`) — WebviewViewProvider, `viewType agentSpace.features`.
   - `resolveWebviewView` (58-157) : set HTML initial, start polling, dispatcher de messages (webview→extension) lignes 78-156.
   - `refresh()` (160-162) / `refreshAsync` (169-197) : rebuild HTML complet, recalcule tous les git status en parallèle (`getFeatureGitStatusAsync`), puis `getHtml(statusMap)`.
   - `refreshState()` (165-167) / `sendUpdate` (201-335) : `postMessage sidebarUpdate` avec JSON (agents présentés via `presentAgentState`+`observe`, services, gitStatus).
   - `startPolling`/`stopPolling` (337-350) : `setInterval` 15s quand visible.
   - Rendus HTML : `renderProjectSection` (532), `renderBaseCard` (574), `renderFeatureCard` (606, badge statut 628), `renderAgentsSection` (653, badge binding 657-661), `renderServicesSection` (770).
2. `HomePanel` (`src/home/homePanel.ts`) — feature page : `showFeature` (178-189), `getFeatureHtml` (893-1006) ; project page : `getProjectHtml` (1008-1165) avec `computeBaseBranchGitState` (1030), status par feature (1050-1056) reposant sur `getFeatureGitStatus`. Polling git 15s `startGitPolling` (250-256) → `sendGitStatsAsync` (602-630) → `postMessage agentAttentionUpdate` + `gitStatsUpdate` (diff stat via `getGitDiffStatsAsync` 632-657, render `renderGitStatsContent` 700-718).

### Masse "webview"
- Sidebar : `media/webview/sidebar.js` — message handler global (302-410), incrémental ; faut que `requestFullRefresh` soit émis si un élément est absent (408). Labels statut répliqués dans JS (235-240), binding (253-258), lifecycle (260-266) → duplication de `gitStatusLabel`/`presentSessionBinding` côté webview.
- Home : `media/webview/home.js` — messages activity/git.

### Refresh / notifications
- `projectManager.onChange(() => sidebarProvider.refreshState(); HomePanel.refreshAll())` — extension.ts 487-490.
- `sessionBinder.onBound → notifyChange + sync` (323-326).
- File watcher cross-window (extension.ts 129-141) → `handleExternalFileChange` (projectManager.ts 134-194).

### Duplication
- Git status : calculé indépendamment dans sidebar (`getFeatureGitStatusAsync`), project page (`getFeatureGitStatus`), feature page (diff stat distinct), base state dans HomePanel. Quatre chemins de lecture Git non coordonnés.
- Présentation agents : `presentAgentState` + `presentSessionBinding` dupliqués en labels JS côté sidebar.

## 4. Chemin Delete Feature

`agentSpace.deleteFeature` — extension.ts 1080-1141 :
1. Résolution + garde base feature (1083-1093).
2. Confirm modal n°1 (1096-1101).
3. `collectFeatureDeletionBlockers(ctx, feature)` (47-72) : appelle `checkWorktreeDeletionSafety` pour le worktree feature (avec branch+baseBranch) puis chaque worktree agent (sans branch). Confirm modal n°2 / force (1105-1113).
4. `sessionNameSyncer.clearFeature` (1115), `terminalController.killFeatureTerminals` (1116), `serviceManager.deleteAllServices` (1118), `agentManager.deleteAllAgents` (1119).
5. `featureManager.deleteFeature(id, {force})` (1119-1121) → `git worktree remove` (featureManager 451-474), persistance nettoyée.
6. Si échec du worktree remove, la record reste (fail-closed anti-orphan, 1123-1131).

`checkWorktreeDeletionSafety` (worktreeSafety.ts 40-113) : `insideBase` + `dirty` (porcelain) + `hasLocalCommits` (`rev-list base..branch`) + `unmerged` (`merge-base --is-ancestor` seulement si pas de localCommits). `safe` = tout négatif.

Limites / écarts vs objectif :
- Aucune suppression de branche locale (`git branch -D`) ni remote (`git push origin --delete`) — le delete ne touche que le worktree + les données Agent Space. Une fois le worktree retiré, `git branch -d` n'est jamais exécuté ; la branche reste.
- Squash-merge : `hasLocalCommits` reste vrai → delete bloqué bien que le contenu soit intégré (fail-closed : sûr, mais ne reconnaît pas l'intégration).
- `dirty` combine staged/unstaged/untracked (pas de séparation).
- Agents/services réellement actifs traités seulement via kill de terminaux, pas via une évaluation runtime (un Agent running avec tmux vivant n'est pas un blocage explicite).
- Worktrees agents testés sans branch → `hasLocalCommits`/`unmerged` non calculés pour eux.

## 5. État de l'intégration GitHub

- Create PR : `agentSpace.createPR` (extension.ts 1352-1462) : `git push origin <feature>` → `git remote get-url origin` → si remote GitHub : maquette native `pr.create` (détection `getCommands(true)` 1400-1403, args `{repoPath, compareBranch}` 1435-1438, API instable documentée comme telle 1429-1434) ; pré-set `git config branch.<b>.github-pr-base-branch` (1411-1426) ; fallback = ouverture du compare URL GitHub (`buildGitHubCompareUrl`, githubCompareUrl.ts 3-14) dans le navigateur.
- Aucune détection de PR existante (pas d'inspecteur). Aucune dépendance à `gh` (confirmé par scan). Auth = navigateur GitHub / extension PR native, jamais gérée ici.
- Repo privé : `buildGitHubCompareUrl` type déjà construit, mais ouvert via `vscode.env.openExternal` — l'utilisateur doit être connecté GitHub dans le navigateur ; pas de gestion explicite.
- Parsing remote : `githubCompareUrl.ts` 25-43 (SCP `ssh:` ou `https:` github.com, deux segments).
- Seul point "libre de GitHub" : le fallback message `Branch pushed. Opening GitHub comparison` (1451-1454) déclenché pour tout remote non-GitHub → `compareUrl===null` → erreur "create PR requires GitHub origin" (1392-1397). Pas de GitLab/Bitbucket.

## 6. Patterns reconciliation / polling / cache réutilisables

| Pattern | Où | Format |
|---|---|---|
| Reconciliation cyclique 15s + unref timer | `SessionBinder.start` (sessionBinder.ts 96-105, const 12) | `setInterval`, stop/start, dispose |
| Réconciliation par état, persistance seulement si observable change | `SessionBinder.persist` (536-559), `updateSessionBinding` (agentManager 255-277) | skip-identical write pour éviter de réécrire le JSON à chaque poll |
| Leases de revalidation (REVALIDATE_BOUND_MS 5 min, sessionBinder 24/372-392) | état "bound" re-vérifié au loin, réponse réutilisée entre-temps | TTL par verdict |
| Éviter les side-effets Git pendant les loops (lecture `store.loadFeatures()` directe, jamais `getFeatures()` qui reconcilie) | `managedFeatures` (567-581), `SessionNameSyncer.getManagedFeatureIds` (136-145) | pré-réquis anti-réentrance |
| Cache TTL map + invalidation ciblée | `featureGitStatus.ts` (TTL 10s, `invalidateGitStatusCache` 56-66, `invalidateBaseBranchGitState` 164-174) | key `${branch}:${base}:${path}` |
| Debounce d'invalidation suite watcher | `AgentManager.invalidateFeature` (39-51), `ServiceManager.invalidateFeature` (20-23) | `setTimeout` 100ms |
| Polling UI 15s seulement si visible | Sidebar (337-343), HomePanel (250-256) | arrêt quand caché |
| Dérivation non persistée (attention) | `agentAttention.ts` / `agentObservationResor` (70 lines) | strict evidence, unknown au lieu de deviner |
| Cross-window sync via FileSystemWatcher | extension.ts 129-141 → `projectManager.handleExternalFileChange` | reload + notifyChange |

Le `SessionBinder` est le bon modèle : lifecycle start/stop/dispose, interval unref, fine-grained states avec `ambiguous` explicite, refus de deviner, leases. Un `FeatureStateCoordinator` peut suivre la même charpente.

## 7. Tests existants utiles et trous

### Utiles
- `featureGitStatus.test.ts` (152 l) — couvre modified/merged/new/ahead, cache TTL, invalidation. Mock `execSync`.
- `featureBranchReconciliation.test.ts` (96 l) — reconcile du branch renommé hors Agent Space.
- `worktreeSafety.test.ts` (127 l) — fail-closed deletion.
- `featureManager.test.ts` (490 l) — create/delete/provision, keep-record-quand-worktree-remove-faillit (252-268).
- `sessionBinder.test.ts` (718 l) — la réconciliation, refus de deviner, baselines, leases. Le modèle à suivre.
- `githubCompareUrl.test.ts`, `gitViewHandoff.test.ts` (pur : args propres).
- `doctor.test.ts` (285 l) — probes deps.
- `worktreeGuard.test.ts`, `store.test.ts`, `projectManager.test.ts` (220 l, cross-window), `projectConfig.test.ts` (159 l), `serviceManager.test.ts` (252 l).

### Trous de couverture pour l'objectif
1. Squash-merge / PR mergée : aucun test (statut post-squash, delete review après squash).
2. PR mergée puis nouveaux commits : rien.
3. Séparation staged/unstaged/untracked : rien (porcelain non split).
4. Commit delta vs working-tree delta : la "modified" actuelle est calculée sur l'arbre de travail, jamais distincte du delta `base..feature`.
5. Runtime delete assessment (agents/tmux/services vivants) : rien.
6. Chemin complet delete (kill terminaux + suppression de branche) : pas de test sur les commandes extensions.
7. Webview/coordinateur : aucun test sur `FeatureStateCoordinator` (n'existe pas encore) ; pas de test de contrat `sidebarUpdate`.
8. `pr.create` : détection commande + fallback non testée.

## 8. Architecture proposée

### Réutiliser tel quel
- Pattern `SessionBinder` (sessionBinder.ts 82-105, persist 536-559) → charpente du coordinator.
- `inspectFeatureLifecycle` (featureManager 111-172) → déjà un "FeatureGitInspector" read-only accepté.
- `checkWorktreeDeletionSafety` (worktreeSafety 40-113) → base de `RemovalAssessment`.
- `computeBaseBranchGitState` + caches TTL + invalidation (featureGitStatus 97-174).
- `isWorktreePathSafe` (worktreeGuard).
- Approche évidence-strict / fail-closed / "unknown au lieu de deviner" (attention resolver 129-133, `sessionBinder.resolveClaim` 450-534, `worktreeSafety safe` 110).
- `parseGitHubRemote` / `buildGitHubCompareUrl` (githubCompareUrl).
- Présentation agents (`presentAgentState`, `presentSessionBinding`) et les types `AgentStatus`, `FeatureStatus`, `ServiceStatus`.

### Extraire / refactorer
- Couche lecture Git unique : regrouper `featureGitStatus.git()`/`gitQuiet()`/`gitCmd()`, `worktreeSafety.git()`, les `git rev-parse` de `featureManager`, les `rev-parse --abbrev-ref HEAD` dédupliqués (featureManager 193, agentManager 527, serviceManager 212), les helpers async d'extension (1666-1710) et le diff-stat de `homePanel` (632-685) dans un `FeatureGitInspector` (repo). Sortie typée, repr read-only, associée à `repoRoot`+worktree.
- Splitter `git status --porcelain` en `{staged, unstaged, untracked, conflicted}` (dérivable de `--porcelain=v2` ou des deux premiers caractères) — distinct du delta commits.
- `getDeletionSafety` + `collectFeatureDeletionBlockers` (featureManager 419-428, extension 47-72) → `RemovalAssessment` enrichi.
- Supprimer les labels JS dupliqués (sidebar.js 235-266) : tout rendre via `postMessage` déjà structuré.

### Créer
Le découpage demandé, mappé aux contraintes :

| Classe | Rôle | Contraintes satisfaites |
|---|---|---|
| `FeatureSnapshot` | DTO immutable d'un feature : branch réelle, delta commits `base..feature` (séparé du working tree), `{staged, unstaged, untracked, conflicted}`, `mergedState` (`not_merged`/`branch_merged`/`pr_merged`/`squash_merged`/`merged_then_new_commits`/`ambiguous_integration`), état runtime (agents, services, tmux). | séparation working-tree vs commit delta ; état intégré honnête |
| `FeatureGitInspector` | Lecture git read-only (synch/async), caches TTL + invalidation hérités ; zéro mutation, zéro fetch. | pas de fetch implicite ; status calculé contre base réel (config avant checkout). |
| `PullRequestInspector` | Détecte une PR existante uniquement depuis les refs locales `refs/remotes/origin/<feature>` (sans fetch, sans gh) et décrit `base_sha`/`head_sha` réels. "Aucune PR connue" ≠ "pas de PR". | aucune dépendance `gh` ; delta vs merged distincts. |
| `IntegrationEvaluator` | Combine snapshot+PR pour la sémantique merged : `merge-base --is-ancestor(feature, base)` = merged (merge classique) ; branche non-ancêtre mais `origin/<feature>` décalé de base et `origin/<feature>` non décalé vs base détecté comme squash si `head_sha` local == `head_sha` remote… avec refus explicite (état `ambiguous_integration`) quand la preuve manque. PR mergée + nouveaux commits = `head_sha` local ≠ `head_sha` de la PR → état dédié. | squash traité ; merged ≠ "aucun commit en plus" ; pas de certitude sans preuve. |
| `RemovalAssessment` | Remplaçant fail-closed de deletion-safety : worktree+per-agent, branche locale/remote encore publiée, unmerged réel, agents/tmux/services vivants, nouveaux commits après merge. Sert le modale pré-delete. | opérations destructives fail-closed ; aucun unknown → false (un state inconnu = blocage). |
| `FeatureStateCoordinator` | Clone du lifecycle `SessionBinder` : interval 15s unref, loop sur `store.loadFeatures()` (jamais `getFeatures()` pour éviter la réentrance git), calcule les `FeatureSnapshot` en parallèle, ne persiste QUE si changement observable, notifie par callback (→ `sidebarProvider.refreshState()`/`HomePanel.refreshAll`), invalidations via watcher + API cache. | pas de commande git dans la webview (tout passe par le coordinateur extension-hôte). |

### Non-goals confirmés
- Pas de suppression de branche auto, pas de merge auto, pas de `pr.create` programmatique hors microsoft GitHub, pas de fetch déclenché par le polling.

## 9. Découpage en PRs (ordre de dépendance)

1. **PR 1 — Extraction `FeatureGitInspector`** (refactor pur, zéro changement de comportement) : consolidie les git reads ; `gitStatusPorcelain` split staged/unstaged/untracked/conflicted en sortie typée ; les 4 chemins de lecture actuels (sidebar, project page, feature page, base state) consomment ce layer. Vérif : `npm run typecheck`, `npm test -- --run`, `npm run compile`. Les tests featureGitStatus/worktreeSafety sont préservés (mêmes commandes au niveau mock).
2. **PR 2 — `FeatureSnapshot` + `FeatureStateCoordinator`** : shape `FeatureSnapshot` ; coordinator modèle `SessionBinder` (start/stop/dispose, 15s, persist-if-changed, leases, invalidation watcher/caches) ; sidebar + HomePanel lisent le snapshot au lieu de recalculer ; suppression des diff-stat/status dupliqués de homePanel. Premier rendu "représentation fiable".
3. **PR 3 — `PullRequestInspector` + `IntegrationEvaluator`** : détection PR depuis refs locales ; sémantique squash / PR-merged / merged+new-commits avec états d'échec explicites (`ambiguous_integration`) ; ne pas marquer "merged" sans preuve solide. Tests dédiés (y compris squash).
4. **PR 4 — `RemovalAssessment`** : enrichit deletion-safety avec runtime (agents/tmux/services actifs), suppression éventuelle de branche locale après confirmation, inclut les infos d'intégration (PR ouverte / mergée) ; fail-closed, modale pré-delete avec diagnostic structuré.
5. **PR 5 — Câblage Feature page** : la page affiche l'état réel (delta commits, merged/PR, dirty split, branches) ; le bouton Delete ouvre le `RemovalAssessment` avant toute action destructrice. Mise à jour des tests de contrat webview.

Chaque PR respecte : typecheck → tests → compile avant commit ; commit sur branche feature ; PR vers `ShiidoTech/agent-space`.
