# Nomenclature des états Feature

Document de référence pour la sémantique des états d'une Feature sur les
différentes surfaces (sidebar, page Feature, page Projet, vue Tmux). Tout
changement de label doit mettre à jour ce document.

## Modèle

Le label d'état n'est pas un champ stocké : il est **dérivé à chaque rendu**
par `presentFeatureCockpit` (src/features/featureCockpitPresentation.ts) à
partir de trois sources :

1. **`primaryAction`** — la première action proposée
   (`refresh_evidence`, `open_agent`, `open_workspace`, `open_pull_request`,
   `create_pull_request`, `review_finish`).
2. **`attention`** — les problèmes détectés par `attentionEvaluator`, triés par
   priorité explicite : `error` > `agent_waiting_for_user` > autres `warning` >
   `info` décisional. La priorité est volontaire : un agent qui attend
   l'utilisateur ne doit jamais être masqué par un warning d'un autre type
   (ex. worktree non commité).
3. **`work` / `delivery` / `runtime`** — l'évidence Git/GitHub/runtime.

`presentSummary` choisit l'état dans cet ordre :
1. s'il existe un problème actionnable (`error`/`warning`/décisional-info)
   → l'état dérive du **problème principal** (alerts[0]) ;
2. sinon, si le worktree contient des changements non commités → `In progress` ;
3. sinon, l'état dérive de la `primaryAction` ;
4. sinon, de l'état d'intégration.

## États dérivés d'un problème (attention)

Lorsqu'un problème est actionnable, l'état dit **ce qui ne va pas**, pas
seulement « il faut agir ». « Needs you » est réservé aux cas où un agent
attend réellement l'utilisateur.

| Code (attentionEvaluator) | État affiché |
|---|---|
| `agent_waiting_for_user` | **Needs you** |
| `agent_failed` | **Agent failed** |
| `agent_tmux_missing` | **Agent terminal missing** |
| `service_failed` | **Service failed** |
| `service_tmux_missing` | **Service terminal missing** |
| `working_tree_changes` | **In progress** |
| `working_tree_conflicted` | **Merge conflicts** |
| `working_tree_unknown` | **Evidence unavailable** |
| `detached_head` | **Detached HEAD** |
| `branch_mismatch` | **Unexpected branch** |
| `worktree_missing` | **Worktree missing** |
| `worktree_observation_unknown` | **Evidence unavailable** |
| `feature_source_unknown` | **Evidence unavailable** |
| `git_observation_unknown` | **Evidence unavailable** |
| `integration_unknown` | **Evidence unavailable** |
| `agent_runtime_unknown` | **Runtime unknown** |
| `service_runtime_unknown` | **Runtime unknown** |
| `upstream_unknown` | **Evidence unavailable** |
| `delivery_relation_unknown` | **Evidence unavailable** |
| `active_delivery_diverged` | **Delivery diverged** |
| `feature_diverged` | **Diverged** |
| `continuation_outside_delivery` | **Work outside delivery** |
| `new_work_after_integration` | **New work after integration** |
| `pull_request_ambiguous` | **Several PRs** |
| `pull_request_base_mismatch` | **PR base mismatch** |
| `pull_request_head_mismatch` | **PR head mismatch** |
| (autre) | **Needs attention** |

Le détail (`detail`) complète toujours l'état : `« <summary du problème> — <detail> »`,
affiché en clair sur la page Feature et en tooltip sur la sidebar.

## États dérivés de l'action / de l'intégration (aucun problème)

| Situation | État affiché |
|---|---|
| `open_agent` | **Needs you** |
| Worktree non commité | **In progress** |
| `refresh_evidence` (évidence essentielle inconnue) | **Evidence unavailable** |
| `open_pull_request` | **PR #N open** |
| `create_pull_request` | **Ready for PR** |
| `review_finish` | **Ready to finish** |
| `new_work_after_integration` | **New work after integration** |
| `integrated_by_ancestry` (local seulement) | **Integrated locally** |
| `no_feature_commits` + base avancée au-delà | **Integrated** |
| `no_feature_commits` + branche sur la base courante | **Not started** |
| défaut | **In progress** |

> `no_feature_commits` survient quand la branche Feature n'a aucun commit
> exclusif (pointe == point de création, déjà dans la base). S'il est atteignable
> depuis la base et que la base a avancé, la Feature est **integrated** — un
> « Not started » y serait trompeur. « Not started » n'est conservé que lorsque la
> branche est exactement sur la pointe actuelle de la base (feature réellement
> pas commencée).

## Tones

- `error` → rouge (problème bloquant : conflit, worktree manquant, agent failed…)
- `warning` → orange (attention : agent en attente, écart de delivery…)
- `normal` → neutre (état sain : prêt, intégré, PR ouverte)
- `muted` → gris (pas commencé, inconnu non bloquant)

## Surfaces

- **Sidebar** : badge `status-badge` = `summary.label`, couleur = `tone`,
  `summary.detail` en tooltip (hover).
- **Page Feature** : `headline` = `summary.label` (titre), `summary.detail`
  affiché en clair dessous, puis les alertes 2..N dans un repliable
  « N more items need attention ».
- **Page Projet / vue Tmux** : utilisent le même `presentFeatureCockpit` ;
  la ligne runtime affiche « N agents running · M need you · … » où « need you »
  compte les agents `waiting_for_user`/`failed`/`errored` (état **agent**, pas
  état feature).
