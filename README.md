# gittree

Un mod Claude Code qui affiche le graphe git du dépôt dans un panneau à côté de la conversation, au plus près du graphe Source Control de VS Code et de l'extension Git Graph. Il suit en direct les commandes git que Claude lance, et marque d'un `✦` les commits créés pendant la session. Il est strictement en lecture seule.

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
j: ↓  k: ↑  ⏎ déplier  e: expliquer  r: rafraîchir  q: fermer
```

## Essayer

```sh
git clone git@github.com:nathbns/ctree.git ~/ctree
cd ton-projet
claude --plugin-dir ~/ctree
```

Puis `/gittree` au prompt. En mode plein écran (terminal d'au moins 110 colonnes), le panneau s'ancre à côté de la conversation. Sinon, il s'ouvre au-dessus du prompt.

## Touches

| Touche | Effet |
| --- | --- |
| `j` / `k`, `↓` / `↑` | ligne suivante / précédente (la suite de l'historique se charge en descendant) |
| `Entrée` | sur un commit : déplie ses fichiers ; sur un fichier : affiche son diff |
| `e` | prépare dans le prompt une question pour que Claude explique le commit (ou le fichier) sélectionné, sans l'envoyer |
| `r` | recharge le dépôt |
| `q` | ferme le panneau ; dans la vue diff, revient à la liste |
| `Échap` | ferme le panneau ; dans la vue diff, revient à la liste ; juste après `e`, rend la main au prompt sans fermer |

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

## Rafraîchissement

- Après une commande Bash de Claude qui contient `git`, tout le graphe est rechargé.
- Après une modification de fichier (Edit, Write, ou commande Bash qui écrit), seul le statut est relu.
- Les rechargements sont regroupés : 150 ms après le dernier appel.
- Pas de surveillance périodique : `r` sert pour les changements faits hors de la session.

## Sécurité

Le mod ne lance que des lectures, sans shell, en passant les arguments directement (`$.process.run`).

- Toute commande hors de la liste blanche (`src/git-commands.ts`, `isReadOnly`) est refusée avant d'être lancée.
- Chaque appel passe aussi `--no-optional-locks`, `-c core.fsmonitor=false` et `-c log.showSignature=false` ; les diffs passent `--no-ext-diff --no-textconv`. Un dépôt ne peut donc ni écrire son index ni lancer un programme configuré.

## Structure

```
src/      cœur pur, sans dépendance à Claude Code : commandes git, parsing,
          calcul des lanes, couleurs, étiquettes, mise en page, lignes
hooks/    le mod : register.tsx (hooks), controller.ts (état), view.tsx (rendu)
types/    contrat $.state (l'état des refs au début de la session, pour ✦)
tests/    lanes, parsing, étiquettes et couleurs, lignes, contrôleur, panneau monté
```

## Développer

Depuis le dossier du dépôt :

```sh
claude plugin test .         # 64 tests
claude plugin validate .
npx -p typescript tsc -p .   # après un premier lancement avec --plugin-dir,
                             # qui dépose les types dans .claude-plugin/types/
```
