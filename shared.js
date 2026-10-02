/* 서버(Node)와 클라이언트(브라우저)가 함께 쓰는 상수 + 스테이지 데이터
 *
 * 맵 문자 범례 (타일 40px, 32x18 = 1280x720)
 *  #  벽/바닥        ^  가시          P  스폰 지점
 *  a-z 버튼(바닥 압력판)  A-D 문(연결된 버튼이 눌려 있는 동안 열림)
 *  L  잠긴 문(열쇠를 먹으면 열림)    K  열쇠        G  탈출 문(Goal)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SHARED = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const T = 40, COLS = 32, ROWS = 18;
  const PLAYER = { w: 28, h: 38, speed: 220, jump: 500, gravity: 1200 };
  const COLORS = [0xff5c5c, 0x4da3ff, 0x4cd97b, 0xffd43b];
  const COLOR_NAMES = ['빨강', '파랑', '초록', '노랑'];
  const MAX_PLAYERS = 4, MIN_PLAYERS = 2;

  // ---------- 맵 빌더 헬퍼 ----------
  function blank() {
    const g = [];
    for (let r = 0; r < ROWS; r++) g.push(new Array(COLS).fill('.'));
    for (let c = 0; c < COLS; c++) { g[0][c] = '#'; g[ROWS - 1][c] = '#'; }
    for (let r = 0; r < ROWS; r++) { g[r][0] = '#'; g[r][COLS - 1] = '#'; }
    return g;
  }
  function fill(g, ch, c1, r1, c2, r2) {
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) g[r][c] = ch;
  }
  function spawns(g) { [2, 3, 4, 5].forEach((c) => { g[16][c] = 'P'; }); }
  // 오른쪽 끝: 잠긴 문(L) + 탈출 문(G)
  function exitArea(g) {
    fill(g, '#', 28, 1, 28, 14);
    fill(g, 'L', 28, 15, 28, 16);
    fill(g, 'G', 29, 15, 30, 16);
  }

  // ---------- 스테이지 정의 ----------
  function stage1() {
    const g = blank();
    spawns(g);
    g[16][9] = 'a';                       // 왼쪽 버튼
    fill(g, '#', 13, 1, 14, 14);          // 벽
    fill(g, 'A', 13, 15, 14, 16);         // 문 A
    g[16][17] = 'b';                      // 문 너머 버튼 (문 A와 연결)
    fill(g, '^', 21, 16, 22, 16);         // 가시
    g[16][25] = 'K';
    exitArea(g);
    return {
      name: '버튼과 문',
      hint: '한 명이 버튼을 밟고 있어야 문이 열려요. 문 너머의 버튼으로 마지막 사람을 통과시키세요!',
      grid: g,
      links: { A: ['a', 'b'] },
    };
  }

  function stage2() {
    const g = blank();
    spawns(g);
    fill(g, '#', 14, 14, 15, 15);         // 높이 3칸 벽 (혼자서는 못 넘음)
    fill(g, 'C', 14, 16, 15, 16);         // 벽 아래 작은 문
    g[13][14] = 'c'; g[13][15] = 'c';     // 벽 위 버튼
    fill(g, '.', 21, 17, 23, 17);         // 낭떠러지
    g[16][26] = 'K';
    exitArea(g);
    return {
      name: '탑 쌓기',
      hint: '벽이 너무 높아요. 동료 머리 위로 올라타 벽 위 버튼을 밟으면 아래 문이 열립니다. 낭떠러지 조심!',
      grid: g,
      links: { C: ['c'] },
    };
  }

  function stage3() {
    const g = blank();
    spawns(g);
    g[16][7] = 'a';
    fill(g, '#', 10, 1, 11, 14); fill(g, 'A', 10, 15, 11, 16);
    g[16][13] = 'b';
    fill(g, '#', 14, 15, 15, 16);         // 계단 1
    fill(g, '#', 16, 13, 17, 16);         // 계단 2
    g[12][16] = 'c'; g[12][17] = 'c';     // 계단 꼭대기 버튼
    fill(g, '^', 18, 16, 20, 16);         // 가시 구간
    fill(g, '#', 24, 1, 25, 14); fill(g, 'C', 24, 15, 25, 16);
    g[16][26] = 'd';                      // 문 C 너머 버튼
    g[16][27] = 'K';
    exitArea(g);
    return {
      name: '릴레이 문',
      hint: '문이 두 개! 버튼을 누르는 사람과 먼저 통과한 사람이 번갈아 문을 열어 주세요.',
      grid: g,
      links: { A: ['a', 'b'], C: ['c', 'd'] },
    };
  }

  // ---------- 그리드 -> 오브젝트 변환 ----------
  function parse(def) {
    const g = def.grid;
    const st = {
      name: def.name, hint: def.hint, links: def.links || {},
      solids: [], spikes: [], buttons: [], doors: [], key: null, goal: null, spawns: [],
    };
    const doorBox = {};
    let goalBox = null;
    const grow = (box, c, r) => {
      box.c1 = Math.min(box.c1, c); box.r1 = Math.min(box.r1, r);
      box.c2 = Math.max(box.c2, c); box.r2 = Math.max(box.r2, r);
    };
    const open = {}; // 세로 병합용

    for (let r = 0; r < ROWS; r++) {
      let c = 0;
      while (c < COLS) {
        const ch = g[r][c];
        if (ch === '#' || ch === '^') {
          let c2 = c;
          while (c2 + 1 < COLS && g[r][c2 + 1] === ch) c2++;
          const n = c2 - c + 1;
          if (ch === '#') {
            const k = c + ':' + n;
            const prev = open[k];
            if (prev && prev.y + prev.h === r * T) prev.h += T;
            else { const rect = { x: c * T, y: r * T, w: n * T, h: T }; st.solids.push(rect); open[k] = rect; }
          } else {
            st.spikes.push({ x: c * T, y: r * T, w: n * T, h: T });
          }
          c = c2 + 1;
          continue;
        }
        if (/[a-z]/.test(ch)) st.buttons.push({ id: ch, x: c * T, y: r * T, w: T, h: T });
        else if (/[ABCDL]/.test(ch)) {
          doorBox[ch] = doorBox[ch] || { id: ch, c1: c, r1: r, c2: c, r2: r };
          grow(doorBox[ch], c, r);
        } else if (ch === 'G') {
          goalBox = goalBox || { c1: c, r1: r, c2: c, r2: r };
          grow(goalBox, c, r);
        } else if (ch === 'K') st.key = { x: c * T + T / 2, y: r * T + T / 2 };
        else if (ch === 'P') st.spawns.push({ x: c * T + T / 2, y: (r + 1) * T });
        c++;
      }
    }
    const box = (b) => ({ x: b.c1 * T, y: b.r1 * T, w: (b.c2 - b.c1 + 1) * T, h: (b.r2 - b.r1 + 1) * T });
    st.doors = Object.values(doorBox).map((b) => Object.assign({ id: b.id }, box(b)));
    st.goal = box(goalBox);
    st.spawns.sort((a, b) => a.x - b.x);
    return st;
  }

  const STAGES = [stage1(), stage2(), stage3()].map(parse);

  return { T, COLS, ROWS, WIDTH: COLS * T, HEIGHT: ROWS * T, PLAYER, COLORS, COLOR_NAMES, MAX_PLAYERS, MIN_PLAYERS, STAGES };
});
