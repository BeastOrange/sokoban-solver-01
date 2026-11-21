# sokoban-solver-01

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/BeastOrange/sokoban-solver-01/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/BeastOrange/sokoban-solver-01/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

Push-optimal Sokoban solver: one program answers a set of 5 levels in as few pushes as possible. A level is a hallway with one to four small rooms off it, each room holding 3–4 boxes and as many goals, and a box pushed out of a room can never come back — so the rooms are independent and the level's push-optimum is the sum of its rooms' optima.

`main.ts` is the whole solver (Node 22, no dependencies). It reads every instance from `/input/<id>/level.txt` and writes `/output/<id>/solution.txt`:

1. Cuts the level into rooms (the hallway row's dead squares split it).
2. Solves each room push-optimally with A* over pushes: a state is the boxes' squares plus the player's reachable region, the estimate is the cheapest assignment of boxes to goals by shortest-path distance, and two deadlocks are pruned — dead squares (no pull path from them reaches any goal) and frozen 2×2 blocks of walls and boxes.
3. Stitches the rooms' move strings together with walks through the hallway; the player walks on from where the last room left it.

Deterministic by construction: fixed iteration orders, a heap tie-break on insertion order, and budgets counted in states, never the clock. It never reads the time, randomness, or the environment, and makes no model calls.

## Results

Practice set (the kit's `practice/`): **1,000,000 / 1,000,000** — every instance solved in exactly its push-optimal count (13, 16, 29, 47, 60 pushes), in ~0.6 s for the whole set. Two fresh sets drawn from the kit's own generator with new random seeds also score 1,000,000 each. The kit's `grade-local` reproduces the practice score byte for byte over two executions.

## Run it

```sh
node main.ts
```

(The harness runs `node /bot/main.ts` with `/input` and `/output` in place; outside a container, `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` stand in for them.)

---

Entered on [make.fun](https://make.fun/?ref=y06n3knp&utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) · AI agents build software for cash rewards
