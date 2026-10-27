# ctree

Un mod Claude Code qui affiche le graphe git du dépôt dans un panneau à côté de la conversation, au plus près du graphe Source Control de VS Code et de l'extension Git Graph. Il suit en direct les commandes git que Claude lance, et marque d'un `✦` les commits créés pendant la session. Il lit git, et n'écrit que ce que tu confirmes : changer de branche, créer un tag, pousser, appliquer un stash, annuler une commande de Claude.

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
j: ↓ k: ↑ ⏎ g: cherch. e: expl. d: comp. m: marq. c: br. p: push u: ⟲ v: vue h: aide
```

## Essayer

```sh
git clone git@github.com:nathbns/ctree.git ~/ctree
cd ton-projet
claude --plugin-dir ~/ctree
```

Puis `/ctree` au prompt.

- **En mode plein écran** (terminal d'au moins 110 colonnes), le panneau s'ancre à côté de la conversation. Il demande toute la largeur permise : Claude Code la plafonne à 45 % du terminal. Si tu l'as rétréci un jour, Claude Code garde ta largeur ; **Ctrl+X puis ←** l'élargit à nouveau.
- **`z` passe en pleine largeur** : ctree quitte le panneau et s'affiche dans la bande au-dessus du prompt, sur toute la largeur du terminal (jusqu'à la moitié de sa hauteur), avec messages complets, noms de branches entiers et toutes les colonnes.
  - Ctrl+X Tab, ou un clic, lui donne le clavier.
  - `z` à nouveau revient au panneau.
  - Le choix est retenu : `/ctree` rouvre là où tu l'as laissé.
- **Sinon**, il s'ouvre au-dessus du prompt, aussi haut que la place le permet. `/tui fullscreen` passe en plein écran.

## Touches

| Touche | Effet |
| --- | --- |
| `j` / `k`, `↓` / `↑` | ligne suivante / précédente (la suite de l'historique se charge en descendant) |
| `Entrée` | sur un commit : déplie ses fichiers ; sur un fichier : affiche son diff |
| `g` | cherche dans le message, l'auteur, le hash ou les fichiers ; `n` passe au résultat suivant |
| `i` | revient à HEAD |
| `m` | marque le commit sélectionné ; `d` sur un autre les compare |
| `d` | compare le commit sélectionné avec la marque (sans marque : avec HEAD) |
| `y` | copie le hash complet |
| `a` | applique le stash sélectionné (après confirmation) |
| `h` | aide : toutes les touches et la légende du graphe |
| `v` | vue d'ensemble : replie les suites linéaires (Entrée en ouvre une) ; `v` à nouveau pour tout voir |
| `f` | focus : l'historique de la branche sélectionnée, puis sa seule ligne (premier parent), puis toutes les branches |
| `e` | prépare dans le prompt une question pour que Claude explique le commit (ou le fichier) sélectionné, sans l'envoyer |
| `c` | change de branche : celle du commit sélectionné (au choix s'il en porte plusieurs) |
| `t` | crée un tag annoté sur le commit sélectionné |
| `p` | pousse la branche courante |
| `u` | annule la dernière commande git de Claude (après confirmation) |
| `l` | journal des commandes git de Claude ; Entrée sur une entrée l'annule |
| `s` | vue session : ce que cette conversation a changé ; `e` y demande une description de PR |
| `z` | pleine largeur au-dessus du prompt, ou retour au panneau (le choix est retenu) |
| `r` | recharge le dépôt |
| `q` | ferme le panneau ; dans une autre vue (diff, comparaison, résultats, journal, session, aide), revient en arrière |
| `Échap` | ferme le panneau ; annule une action en attente ; dans une autre vue, revient en arrière ; efface la recherche en cours ; juste après `e`, rend la main au prompt sans fermer |

Le bas du panneau montre les touches les plus utilisées, autant que la largeur en permet, et toujours `h: aide`. Les autres marchent aussi : `h` les liste toutes. La molette et Page↑/Page↓ font défiler la liste. Dans VS Code, il n'y a pas de raccourcis clavier : on clique sur les lignes et les boutons.

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
- **Stashs** : `≡ stash@{0}`, sur le commit où ils ont été faits, à leur date, comme dans Git Graph. Entrée liste leurs fichiers, `e` demande à Claude ce qu'ils contiennent, `a` en applique un (`git stash apply`, le stash reste dans la liste).

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

## Chercher et comparer

- **`g`, chercher.** Un champ s'ouvre ; Entrée cherche dans tout l'historique dessiné (toutes les branches, ou celle du focus), majuscules ignorées :
  - dans le message et l'auteur, toujours ;
  - dans les chemins des fichiers changés, quand le texte ressemble à un chemin (`src/lanes.ts`, `lanes.`, `docs/`) ;
  - un hash, quand le texte peut en être un ;
  - dans les stashs.

  Les résultats s'affichent du plus récent au plus ancien, avec ce qui correspond (`message · fichier`). Entrée sur l'un d'eux le sélectionne dans le graphe, même loin dans l'historique : ctree charge jusqu'à lui (5 000 commits au plus), et au-delà le montre en focus. Les commits trouvés ressortent en jaune, l'en-tête dit `⌕ « proxy » 5/36`, `n` passe au suivant, Échap efface la recherche. Une recherche trop longue (15 s) est arrêtée, et la liste le dit.
- **`m` puis `d`, comparer.** `m` marque un commit (`⚑`), `d` sur un autre ouvre la comparaison, du plus ancien au plus récent :

  ```
  ⇄ fc138c1 « deps: proxy-addr@~2.0.6 » → 1c6f1b0 « test: expand coverage… »
    1c6f1b0 a 565 commits de plus · 170 fichiers +7305 −5908
    M .editorconfig  +1 −1
  ```

  Entrée sur un fichier montre son diff entre les deux, Échap revient à la liste des fichiers, `e` demande à Claude ce qui a changé. Sans marque, `d` compare avec HEAD ; sur la ligne des modifications non commitées, il compare l'arbre de travail.
- **`y`** copie le hash complet du commit sélectionné, **`i`** revient à HEAD.

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

## Garde-fou, journal et annulation

Ce que ctree peut faire, et que les outils hors de la session ne peuvent pas : il voit chaque commande git de Claude **avant** qu'elle parte.

**Le garde-fou.** Quand une commande de Claude perdrait du travail, elle attend ta réponse, même en mode auto. La question de Claude Code dit précisément ce qui partirait :

```
Claude veut lancer « git reset --hard HEAD~2 ». 2 commits (1c6f1b0 test: … · 0dee2c5 docs: …)
ne seront plus sur aucune branche ; 3 fichiers modifiés perdus : src/a.ts, src/b.ts, README.md.
Laisser passer ?
```

| Commande | Ce qui est calculé avant |
| --- | --- |
| `reset --hard` | les commits qui ne seront plus sur aucune branche, les fichiers modifiés perdus |
| `checkout -- …`, `checkout .`, `restore`, `switch -f` / `--discard-changes` | les fichiers modifiés perdus |
| `clean -f` | les fichiers non suivis supprimés (via `git clean -n`), sans copie possible |
| `stash drop` / `clear` | les stashs perdus |
| `push --force` / `+refspec`, `push --delete` / `:branche` | les commits que la branche distante perdrait |
| `branch -D` | les commits qui n'existent que sur cette branche |
| `filter-branch`, `gc --prune=now`, `reflog expire`, `update-ref -d` | un avertissement |

- **Si tu refuses**, la commande ne part pas. Claude lit pourquoi et te demande comment procéder.
- **Si tu laisses passer** une commande qui jette des fichiers modifiés, ctree en garde d'abord une copie (`git stash create`, sans toucher à rien), récupérable depuis le journal.
- **Les commandes qui ne perdent rien** (commit, rebase, merge, push normal…) ne sont jamais retenues : elles passent par le journal.
- **Une commande lancée avec `git -C ailleurs`** est retenue avec un avertissement, sans calcul.
- **Pour couper le garde-fou** : l'option `guard` (`pluginConfigs` → `ctree@inline` → `guard: false` avec `--plugin-dir`). Le garde-fou ne s'applique pas sans personne pour répondre (`claude -p`).
- **En mode par défaut**, Claude Code peut encore demander sa propre permission après ta réponse.

**Le journal (`l`).** Chaque commande git de Claude qui déplace une branche, un tag ou HEAD, ou qui jette des changements, y est inscrite : tour de conversation, commande, ce qui a bougé (`main a2e6115 → 8282214`).

**Annuler (`u`, ou Entrée dans le journal).** La confirmation montre les commandes exactes, puis :
- une branche créée est supprimée, une branche supprimée est refaite, HEAD revient sur sa branche d'avant ;
- après un commit (ou `add` + `commit`, un amend), la branche revient avec `reset --soft` : les changements redeviennent non commités, comme avant ;
- après un `reset --hard`, un merge ou un rebase, elle revient avec `reset --keep` : les fichiers sont remis, et git refuse s'il écraserait des changements locaux ;
- si des fichiers modifiés avaient été jetés, une deuxième option les récupère aussi (`git stash apply`) ;
- une branche qui a bougé depuis est laissée telle quelle, avec une note ;
- un push n'est jamais annulé, car il faudrait un push forcé.

Claude reçoit une note : il sait que sa commande a été défaite.

**La vue session (`s`).** Ce que la conversation a changé depuis son début :
- les branches et tags créés, supprimés ou déplacés, avec `+n −m` commits ;
- les commits `✦` ;
- les fichiers changés par HEAD, avec `+/−`.

`e` y prépare la demande d'une description de pull request.

## Gros dépôts

Mesuré sur un dépôt synthétique de 440 000 commits, 7 000 branches, branches distantes et tags :

| | sans commit-graph | avec commit-graph |
| --- | --- | --- |
| ouverture | 1,6 s | 0,5 s |
| vue d'ensemble (2 000 commits) | 5,5 s | 1,2 s |
| rechargement après une commande git de Claude | 1,6 s | 0,6 s |
| recherche (message, auteur, chemin exact) | 1,7 s | 1,7 s |
| comparer deux commits à 5 000 commits d'écart | 0,02 s | 0,02 s |

- L'historique se lit par pages qui grandissent avec la profondeur (100, 200, 400… jusqu'à 1 000), car chaque page fait relire à git tout ce qui la précède.
- Sans commit-graph, git relit tout l'historique à chaque page. Une lecture de plus de 1,5 s le signale une fois : `git commit-graph write --reachable --changed-paths` accélère la lecture, et la recherche par chemin exact.
- Un chemin exact (`src/lanes.ts`, `docs/`) se cherche vite. Un morceau de nom (`lanes.`) demande de lire les changements de chaque commit : seulement si le chemin exact ne donne rien, et 15 s au plus.

## Rafraîchissement

- Après une commande Bash de Claude qui contient `git`, tout le graphe est rechargé.
- Après une modification de fichier (Edit, Write, ou commande Bash qui écrit), seul le statut est relu.
- Les rechargements sont regroupés : 150 ms après le dernier appel.
- Pas de surveillance périodique : `r` sert pour les changements faits hors de la session.

## Sécurité

Le mod lance git sans shell, en passant les arguments directement (`$.process.run`).

- Les lectures passent par une liste blanche (`src/git-commands.ts`, `isReadOnly`).
- Les écritures passent par une garde à part (`src/git-actions.ts`, `isAllowedWrite`). Elle n'admet que les formes construites par les actions et par l'annulation :
  - `switch <branche>`, `switch --track`, `switch --detach <hash>` ;
  - `tag -a … <hash>` ;
  - `push --follow-tags [-u] <distant> <branche>` ;
  - `update-ref` d'une branche ou d'un tag local, vérifié contre sa valeur actuelle ;
  - `reset --keep|--soft <hash>`, `stash apply <hash>` (`a`, ou la récupération de fichiers jetés), et `stash create` (la copie de sauvegarde).

  Elle refuse tout le reste : `--force`, refspec `+…` ou `:…`, `--delete`, `tag -d`, `reset --hard`, toute référence distante, etc. Ces écritures ne partent qu'après `y`, sauf `stash create`, qui ne modifie ni les fichiers ni les branches.
- Chaque appel passe aussi `--no-optional-locks`, `-c core.fsmonitor=false` et `-c log.showSignature=false` ; les diffs passent `--no-ext-diff --no-textconv`. Un dépôt ne peut donc ni écrire son index ni lancer un programme configuré.

## Structure

```
src/      cœur pur, sans dépendance à Claude Code : commandes git, parsing,
          calcul des lanes, couleurs, étiquettes, mise en page, lignes,
          vue d'ensemble (repliement), actions (branche, tag, push) et leur garde,
          garde-fou (guard.ts), journal et annulation (journal.ts), vue session,
          recherche (search.ts)
hooks/    le mod : register.tsx (hooks), controller.ts (état), view.tsx (rendu)
types/    contrat $.state (l'état des refs au début de la session, pour ✦)
tests/    lanes, parsing, étiquettes et couleurs, lignes, vue d'ensemble, actions, garde-fou,
          journal, recherche, contrôleur, panneau monté
```

## Développer

Depuis le dossier du dépôt :

```sh
claude plugin test .         # 194 tests
claude plugin validate .
npx -p typescript tsc -p .   # après un premier lancement avec --plugin-dir,
                             # qui dépose les types dans .claude-plugin/types/
```
