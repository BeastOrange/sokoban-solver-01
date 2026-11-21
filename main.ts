// sokoban-solver-01: a push-optimal Sokoban solver.
//
// Strategy. A level is a hallway with one to four small rooms off it, each
// room holding 3-4 boxes and as many goals, and a box pushed out of a room
// can never come back — so the rooms are independent and the level's
// push-optimum is the sum of its rooms' optima. The solver therefore
//   1. cuts the level into rooms (the hallway row's dead squares split it),
//   2. solves each room push-optimally on its own, and
//   3. stitches the rooms' move strings together with walks through the
//      hallway (the player walks on from where the last room left it).
//
// Each room is solved with A* over pushes. A state is the boxes' squares
// plus the player's reachable region (named by its lowest square); a step
// costs one push, and the estimate is the cheapest assignment of boxes to
// goals by shortest-path distance (ignoring boxes), which never overcounts
// — so the first solved state A* pops is push-optimal. Two deadlocks are
// pruned: a dead square (no pull path from it reaches any goal) and a
// frozen 2x2 block of walls and boxes with a box off its goal. Neither
// prunes a solvable state.
//
// Deterministic by construction: fixed iteration orders, a heap tie-break
// on insertion order, and budgets counted in states, never the clock —
// the program never reads the time, randomness, or the environment.
// No model calls, no network, no files outside /input, /output and /tmp.
//
// Local run: MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The most states one room search keeps before it gives up: work, never the clock. */
const ROOM_MAX_STATES = 600_000;
/** The cap for the whole-level fallback, which only runs when a level is no set of rooms. */
const WHOLE_MAX_STATES = 300_000;

/** [dx, dy, the walk's letter, the push's letter], in u, d, l, r order. */
const DIRS: Array<[number, number, string, string]> = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

/** A level in XSB text: # wall, space floor, . goal, $ box, * box on a goal, @ player, + player on a goal. */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/**
 * The squares from which a box alone can still be pushed onto some goal:
 * pull backwards from the goals over open floor. A box on any other square
 * is dead — no push sequence can ever save it.
 */
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue = goals.slice();
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (y < 0 || y >= wall.length) continue;
      const behind = y - d;
      if (behind < 0 || behind >= wall.length) continue;
      if (!wall[y] && !wall[behind] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/** Shortest-path distances from each goal over open floor (boxes ignored), one Int32Array per goal. */
function goalDistances(level: Level): Int32Array[] {
  const { w, wall, goals } = level;
  const out: Int32Array[] = [];
  for (const g of goals) {
    const dist = new Int32Array(wall.length).fill(-1);
    const queue = [g];
    dist[g] = 0;
    for (let qi = 0; qi < queue.length; qi++) {
      const p = queue[qi]!;
      for (const [dx, dy] of DIRS) {
        const q = p + dy * w + dx;
        if (!wall[q] && dist[q] < 0) {
          dist[q] = dist[p]! + 1;
          queue.push(q);
        }
      }
    }
    out.push(dist);
  }
  return out;
}

/** All orderings of 0..n-1, for the box-to-goal assignment. */
function permutations(n: number): number[][] {
  if (n <= 1) return [[0]];
  const out: number[][] = [];
  const used = new Array<boolean>(n).fill(false);
  const cur: number[] = [];
  const rec = (): void => {
    if (cur.length === n) {
      out.push(cur.slice());
      return;
    }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      used[i] = true;
      cur.push(i);
      rec();
      cur.pop();
      used[i] = false;
    }
  };
  rec();
  return out;
}

/**
 * Whether the box just pushed to `t` sits in a frozen 2x2 block: four
 * squares of walls and boxes, one of the boxes off its goal. Such a box
 * can never move again, so the state is dead.
 */
function frozenBlock(level: Level, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = level;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (a < 0 || d >= wall.length) continue;
    const filled =
      (wall[a] || occupied[a]) &&
      (wall[b] || occupied[b]) &&
      (wall[c] || occupied[c]) &&
      (wall[d] || occupied[d]);
    if (!filled) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) {
      return true;
    }
  }
  return false;
}

/**
 * Flood the player's reachable region from `from` with `occupied` in the
 * way, stamping cells in `seen` with `stamp`; returns the region's lowest
 * square, which names the region.
 */
function floodRegion(
  level: Level,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
      if (q < 0 || q >= wall.length) continue;
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters. */
function walkTo(level: Level, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/** The square the player stands on after `moves` (LURD, case aside) from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) {
    p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  }
  return p;
}

/** Pack sorted box squares into one exact number (base `size` digits). */
function packBoxes(boxes: number[], size: number): number {
  let k = 0;
  for (let i = boxes.length - 1; i >= 0; i--) k = k * size + boxes[i]!;
  return k;
}

/**
 * The push-optimal solution of `level` within `maxStates` states:
 * { pushes, moves } (moves in LURD, a lower letter a step, an upper one a
 * push), or null when the search gives up or the level has no solution.
 */
function solvePushOptimal(level: Level, maxStates: number): { pushes: number; moves: string } | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const n = level.boxes.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  if (level.boxes.some((b) => !live[b])) return null;
  const dist = goalDistances(level);
  const perms = permutations(n);
  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);

  // The estimate: the cheapest assignment of boxes to goals by
  // shortest-path distance, memoised on the packed boxes.
  const hCache = new Map<number, number>();
  const estimate = (boxes: number[]): number => {
    const packed = packBoxes(boxes, size);
    const hit = hCache.get(packed);
    if (hit !== undefined) return hit;
    let best = Number.POSITIVE_INFINITY;
    for (const perm of perms) {
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const d = dist[perm[i]!]![boxes[i]!]!;
        if (d < 0) {
          sum = Number.POSITIVE_INFINITY;
          break;
        }
        sum += d;
      }
      if (sum < best) best = sum;
    }
    hCache.set(packed, best);
    return best;
  };

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  // A second stamp array for the regions a push makes: flooding one must
  // not clobber the region the state being expanded stands in.
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  let markStamp = 0;

  // The states, in the order found: packed boxes, the player's square
  // (the pushed box's old square after a push), parent, push direction,
  // and pushes so far. The open list is a heap on (f, -g, insertion).
  const sBoxes: number[] = [packBoxes(level.boxes, size)];
  const sPlayer: number[] = [level.player];
  const sParent: number[] = [-1];
  const sDir: number[] = [-1];
  const sG: number[] = [0];
  const best = new Map<string, number>();
  for (const b of level.boxes) occupied[b] = 1;
  const low0 = floodRegion(level, occupied, level.player, seen, ++stamp, stack);
  for (const b of level.boxes) occupied[b] = 0;
  best.set(`${low0}:${sBoxes[0]}`, 0);

  // Heap entries: [f, g, seq, state]. Lower f first, then deeper g, then earlier seq.
  const heap: Array<[number, number, number, number]> = [];
  let seq = 0;
  const heapLess = (a: [number, number, number, number], b: [number, number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: [number, number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!heapLess(heap[i]!, heap[p]!)) break;
      const tmp = heap[i]!;
      heap[i] = heap[p]!;
      heap[p] = tmp;
      i = p;
    }
  };
  const heapPop = (): [number, number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && heapLess(heap[c + 1]!, heap[c]!)) c++;
        if (!heapLess(heap[c]!, heap[i]!)) break;
        const tmp = heap[i]!;
        heap[i] = heap[c]!;
        heap[c] = tmp;
        i = c;
      }
    }
    return top;
  };

  const h0 = estimate(level.boxes);
  if (h0 === Number.POSITIVE_INFINITY) return null;
  heapPush([h0, 0, seq++, 0]);
  let found = solved(level.boxes) ? 0 : -1;

  const unpack = (packed: number): number[] => {
    const out: number[] = [];
    let k = packed;
    for (let i = 0; i < n; i++) {
      out.push(k % size);
      k = Math.floor(k / size);
    }
    return out;
  };

  while (heap.length > 0 && found < 0) {
    const [, g, , s] = heapPop();
    const boxes = unpack(sBoxes[s]!);
    for (const b of boxes) occupied[b] = 1;
    const low = floodRegion(level, occupied, sPlayer[s]!, seen, ++stamp, stack);
    const region = stamp;
    // Skip a stale entry: a cheaper route to this same state was recorded.
    if (best.get(`${low}:${sBoxes[s]}`) !== s) {
      for (const x of boxes) occupied[x] = 0;
      continue;
    }
    // With a consistent estimate, the first solved state popped is push-optimal.
    if (solved(boxes)) {
      found = s;
      for (const x of boxes) occupied[x] = 0;
      break;
    }
    for (let bi = 0; bi < n; bi++) {
      const b = boxes[bi]!;
      for (let di = 0; di < 4; di++) {
        const [dx, dy] = DIRS[di]!;
        const d = dy * w + dx;
        const behind = b - d;
        const t = b + d;
        if (seen[behind] !== region) continue;
        if (wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        if (frozenBlock(level, occupied, goal, t)) {
          occupied[t] = 0;
          occupied[b] = 1;
          continue;
        }
        const next = boxes.slice();
        next[bi] = t;
        next.sort((a, b2) => a - b2);
        const packed = packBoxes(next, size);
        const nextLow = floodRegion(level, occupied, b, mark, ++markStamp, stack);
        const nextKey = `${nextLow}:${packed}`;
        const prevBest = best.get(nextKey);
        if (prevBest !== undefined && sG[prevBest]! <= g + 1) {
          occupied[t] = 0;
          occupied[b] = 1;
          continue;
        }
        if (sBoxes.length >= maxStates) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        const h = estimate(next);
        if (h === Number.POSITIVE_INFINITY) {
          occupied[t] = 0;
          occupied[b] = 1;
          continue;
        }
        const idx = sBoxes.length;
        best.set(nextKey, idx);
        sBoxes.push(packed);
        sPlayer.push(b);
        sParent.push(s);
        sDir.push(di);
        sG.push(g + 1);
        heapPush([g + 1 + h, g + 1, seq++, idx]);
        occupied[t] = 0;
        occupied[b] = 1;
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) return null;

  // The path of states, then the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = sParent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes;
  for (const s of path) {
    const nextBoxes = unpack(sBoxes[s]!);
    const from = boxes.find((b) => !nextBoxes.includes(b))!;
    const to = nextBoxes.find((b) => !boxes.includes(b))!;
    const d = to - from;
    const di = DIRS.findIndex(([dx, dy]) => dy * w + dx === d);
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(level, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += DIRS[di]![3];
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves };
}

interface Room {
  boxes: number[];
  goals: number[];
  done: boolean;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the
 * hallway: a box there reaches no goal) out of the floor, and each part
 * left that holds a box is a room. Null when some part holds more or fewer
 * boxes than goals, or a box starts in the hallway: then the level is no
 * set of rooms.
 */
function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) {
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i]! + dy * w + dx;
        if (q < 0 || q >= wall.length) continue;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) {
    if (part[g]! < 0) return null;
    rooms[part[g]!]!.goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/**
 * The level solved room by room: each room's push-optimal solution in
 * turn, the other rooms' boxes standing as walls (on their goals once
 * their room is done), the player walking on from where the last room
 * left it. A box never leaves its room, so the rooms' optima add up to
 * the level's. Falls back to a search over the whole level when the level
 * is no set of rooms. Null when every search gives up.
 */
function solveByRooms(level: Level): { pushes: number; moves: string } | null {
  const rooms = roomsOf(level);
  if (rooms === null) return solvePushOptimal(level, WHOLE_MAX_STATES);
  let player = level.player;
  let pushes = 0;
  let moves = '';
  for (const room of rooms) {
    const subWall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.done ? other.goals : other.boxes) subWall[b] = 1;
    }
    const sub: Level = {
      w: level.w,
      h: level.h,
      wall: subWall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = solvePushOptimal(sub, ROOM_MAX_STATES);
    if (solved === null) return null;
    pushes += solved.pushes;
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    room.done = true;
  }
  return { pushes, moves };
}

function solve(text: string): string {
  try {
    const level = parseLevel(text);
    const solved = solveByRooms(level);
    return solved === null ? '' : solved.moves;
  } catch {
    return '';
  }
}

for (const id of readdirSync(INPUT).sort()) {
  const moves = solve(readFileSync(join(INPUT, id, 'level.txt'), 'utf8'));
  mkdirSync(join(OUTPUT, id), { recursive: true });
  writeFileSync(join(OUTPUT, id, 'solution.txt'), `${moves}\n`);
}
