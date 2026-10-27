# ctree

Un mod Claude Code qui affiche le graphe git du dépôt dans un panneau à côté de la conversation, au plus près du graphe Source Control de VS Code et de l'extension Git Graph. Il suit en direct les commandes git que Claude lance, et marque d'un `✦` les commits créés pendant la session. Il lit git, et n'écrit que trois choses, chacune après ta confirmation : changer de branche, créer un tag, pousser.

```
demo · ⎇ main · ✓ origin/main
  ◌     Modifications non commitées (2)
  ┊ ●   Panneau : colonnes adaptatives          feature/ui  Nathan          2 h  ed58ff3
  ┊ ●   Navigation j/k                                      Nathan          1 j  63622de
❯ ◉─┼─╮ Merge branch 'feature/la…  main ⇄ origin  ◇ v0.2.0  Nathan          5 h  a2e6115
  │ │ │   A lanes.txt                                                                 +2
  │ │ ● Calcul des lanes : octopus m… origin/feature/lanes  Léa             6 h  42cccc5
  ●─╯ │ Étiquettes de branches                              Nathan          2 j  57c5586
  ●───╯ Parsing de git log                        ◇ v0.1.0  Nathan          3 j  deeed04
j: ↓  k: ↑  ⏎ déplier  e: expliquer  c: branche  t: tag  p: push  r: rafraîchir  q: fermer
```

## Essayer

```sh
git clone git@github.com:nathbns/ctree.git ~/ctree
cd ton-projet
claude --plugin-dir ~/ctree
```

Puis `/ctree` au prompt.

- **En mode plein écran** (terminal d'au moins 110 colonnes), le panneau s'ancre à côté de la conversation. Il demande toute la largeur permise : Claude Code la plafonne à 45 % du terminal. Si tu l'as rétréci un jour, Claude Code garde ta largeur ; **Ctrl+X puis ←** l'élargit à nouveau.
- **Sinon**, il s'ouvre au-dessus du prompt, aussi haut que la place le permet. `/tui fullscreen` passe en plein écran.

## Touches

| Touche | Effet |
| --- | --- |
| `j` / `k`, `↓` / `↑` | ligne suivante / précédente (la suite de l'historique se charge en descendant) |
| `Entrée` | sur un commit : déplie ses fichiers ; sur un fichier : affiche son diff |
| `v` | vue d'ensemble : replie les suites linéaires (Entrée en ouvre une) ; `v` à nouveau pour tout voir |
| `f` | focus : l'historique de la branche sélectionnée, puis sa seule ligne (premier parent), puis toutes les branches |
| `e` | prépare dans le prompt une question pour que Claude explique le commit (ou le fichier) sélectionné, sans l'envoyer |
| `c` | change de branche : celle du commit sélectionné (au choix s'il en porte plusieurs) |
| `t` | crée un tag annoté sur le commit sélectionné |
| `p` | pousse la branche courante |
| `r` | recharge le dépôt |
| `q` | ferme le panneau ; dans la vue diff, revient à la liste |
| `Échap` | ferme le panneau ; annule une action en attente ; dans la vue diff, revient à la liste ; juste après `e`, rend la main au prompt sans fermer |

La molette et Page↑/Page↓ font défiler la liste. Dans VS Code, il n'y a pas de raccourcis clavier : on clique sur les lignes et les boutons.

## Ce qui est affiché

- **Graphe** : une ligne par commit, en caractères de dessin de boîte (`│ ─ ╮ ╯ ├ ┼ …`).
  - Nœuds : `●` commit, `○` merge, `◉` HEAD, `◌` modifications non commitées, reliées à HEAD en pointillés `┊`.
  - Couleurs : une par branche, stable (dérivée du nom), le bleu étant réservé à la branche courante. La palette est celle du graphe de VS Code.
- **Étiquettes** :
  - branche courante en pastille pleine ;
  - `main ⇄ origin` quand la branche locale et sa distante pointent sur le même commit ;
  - branches distantes seules en italique, tags `◇ v1.0`, `HEAD détachée` ;
  - `(wt)` pour une branche extraite dans un autre worktree.
- **Colonnes** : message, étiquettes, auteur, date relative, hash court. L'auteur disparaît sous 84 colonnes, le hash sous 72, la date sous 60.
- **Fichiers d'un commit** : comparés à son premier parent (comme VS Code pour un merge), avec statut M/A/D/R et le nombre de lignes +/−.

## Voir tout le graphe

- **Chaque ligne prend la largeur de son propre graphe**, comme dans VS Code, lazygit ou tig. Une branche qui s'écarte loin à droite ne vole plus la place des messages des autres lignes.
- **`v`, vue d'ensemble.** Ne restent que les commits qui donnent sa forme à l'historique : pointes de branches, tags, HEAD, merges, bifurcations, racines et commits `✦` de la session. Chaque suite linéaire devient une ligne `┆ ▸ 22 commits · Léa, Nathan`. Sur express, un écran couvre ainsi 9 mois au lieu de 2 semaines.
  - La suite de l'historique se charge d'elle-même jusqu'à remplir le panneau.
  - Entrée ouvre une suite repliée ; `e` sur une suite repliée demande à Claude d'expliquer l'ensemble.
- **`f`, focus.** Trois crans, l'en-tête indiquant lequel est actif (`◎ main`, `◎ main · 1er parent`) :
  1. l'historique de la branche (ou du tag, ou du commit) sélectionnée ;
  2. sa seule ligne, au premier parent, les merges restant des `○` ;
  3. toutes les branches.

  Combiné à `v`, cela donne les versions d'un projet sur plusieurs années en un écran.
- **Écarts avec la distante** : une branche à un autre commit que sa distante l'indique dans son étiquette, par exemple `main ↑2 ↓1`.

## Changer de branche, tagger, pousser

Rien ne s'écrit sans confirmation. `c`, `t` et `p` ouvrent un bandeau en bas du panneau, à la place des touches. Il montre la commande exacte et ce qu'elle va faire ; `y` lance, `n` ou `Échap` annule.

```
 ↑ Pousser feature/ui vers origin/feature/ui
   git push --follow-tags -u origin feature/ui
   crée origin/feature/ui et la suit (-u)
   2 commits : ed58ff3 Panneau : colonnes adaptatives · 63622de Navigation j/k
   2 tags : v0.1.0, v0.3.0-rc1
 y: pousser  n: annuler
```

- **`c`, changer de branche :** `git switch <branche>`.
  - Une branche seulement distante est créée en local, en la suivant (`git switch --track`).
  - Un commit sans branche détache HEAD, avec un avertissement.
  - Les modifications non commitées sont gardées si git le peut ; sinon git refuse, et son message s'affiche.
- **`t`, créer un tag :** `git tag -a <nom> -m <message> <commit>`.
  - Le nom proposé est la version suivante (`v0.2.0` donne `v0.3.0`).
  - Un nom déjà pris ou invalide est refusé avant la confirmation.
  - Le tag est annoté, pour partir avec le push suivant.
- **`p`, pousser :** `git push --follow-tags origin <branche>`.
  - Ajoute `-u` si la branche n'a pas encore de distante.
  - La confirmation liste les commits et les tags annotés qui partiront (le dépôt distant est interrogé pour ses tags).
  - Jamais de push forcé : une branche en retard sur sa distante est bloquée, avec l'explication.

Après chaque action réussie, le graphe se recharge. Une note est ajoutée à la conversation pour Claude, que toi tu ne vois pas : Claude sait ainsi que la branche a changé sous ses pieds.

À savoir : les commandes passent par l'API des mods, qui lance git avec les hooks du dépôt désactivés. Un `pre-push` ou un `post-checkout` ne tournent donc pas pour ces actions. Pour ssh, git ne pose aucune question (`BatchMode`) : il échoue avec un message plutôt que de bloquer, sauf si tu as réglé ta propre commande ssh.

## Rafraîchissement

- Après une commande Bash de Claude qui contient `git`, tout le graphe est rechargé.
- Après une modification de fichier (Edit, Write, ou commande Bash qui écrit), seul le statut est relu.
- Les rechargements sont regroupés : 150 ms après le dernier appel.
- Pas de surveillance périodique : `r` sert pour les changements faits hors de la session.

## Sécurité

Le mod lance git sans shell, en passant les arguments directement (`$.process.run`).

- Les lectures passent par une liste blanche (`src/git-commands.ts`, `isReadOnly`).
- Les écritures passent par une garde à part (`src/git-actions.ts`, `isAllowedWrite`). Elle n'admet que les cinq formes construites par les trois actions : `switch <branche>`, `switch --track`, `switch --detach <hash>`, `tag -a … <hash>`, `push --follow-tags [-u] <distant> <branche>`. Elle refuse tout le reste : `--force`, refspec `+…` ou `:…`, `--delete`, `tag -d`, `reset`, etc. Ces écritures ne partent qu'après `y`.
- Chaque appel passe aussi `--no-optional-locks`, `-c core.fsmonitor=false` et `-c log.showSignature=false` ; les diffs passent `--no-ext-diff --no-textconv`. Un dépôt ne peut donc ni écrire son index ni lancer un programme configuré.

## Structure

```
src/      cœur pur, sans dépendance à Claude Code : commandes git, parsing,
          calcul des lanes, couleurs, étiquettes, mise en page, lignes,
          vue d'ensemble (repliement), actions (branche, tag, push) et leur garde
hooks/    le mod : register.tsx (hooks), controller.ts (état), view.tsx (rendu)
types/    contrat $.state (l'état des refs au début de la session, pour ✦)
tests/    lanes, parsing, étiquettes et couleurs, lignes, vue d'ensemble, actions, contrôleur,
          panneau monté
```

## Développer

Depuis le dossier du dépôt :

```sh
claude plugin test .         # 110 tests
claude plugin validate .
npx -p typescript tsc -p .   # après un premier lancement avec --plugin-dir,
                             # qui dépose les types dans .claude-plugin/types/
```
