'use strict';
/**
 * Pico Park 스타일 협동 플랫폼 - 서버
 *
 * 구조: "클라이언트가 자기 캐릭터의 물리를 시뮬레이션하고(Arcade Physics),
 *       서버는 방/게임 상태(버튼·문·열쇠·사망·클리어)의 권위(authority)를 가진다."
 *  - 클라이언트 -> 서버: move(좌표/속도/눌린 버튼/탈출 여부), dead, keyGet
 *  - 서버 -> 클라이언트: snap(전체 좌표 + 문 상태 + 버튼 상태, 30Hz), stageStart, stageCleared, results ...
 */
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { STAGES, PLAYER, MAX_PLAYERS, MIN_PLAYERS, WIDTH, HEIGHT } = require('./public/shared.js');

const PORT = process.env.PORT || 3000;
const TICK_MS = 33;
const NEXT_STAGE_DELAY = 2500;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
// Phaser를 npm 패키지에서 직접 서빙 (CDN 불필요)
app.use('/vendor', express.static(path.join(__dirname, 'node_modules', 'phaser', 'dist')));
const server = http.createServer(app);
const io = new Server(server);

const BUTTON_IDS = STAGES.map((s) => new Set(s.buttons.map((b) => b.id)));
const rooms = new Map();

// ---------- 헬퍼 ----------
const getRoom = (socket) => rooms.get(socket.data.room);
const r1 = (v) => Math.round(v * 10) / 10;
const cleanName = (n) => String(n || '').replace(/[<>]/g, '').trim().slice(0, 10) || '플레이어';

function genCode() {
  for (;;) {
    let s = '';
    for (let i = 0; i < 4; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!rooms.has(s)) return s;
  }
}

function publicPlayers(room) {
  return [...room.players.values()].map((p) => ({ id: p.id, name: p.name, color: p.color, ready: p.ready }));
}

function emitLobby(room) {
  io.to(room.code).emit('lobby', {
    code: room.code,
    phase: room.phase,
    hostId: room.players.keys().next().value,
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    players: publicPlayers(room),
  });
}

function addPlayer(room, socket, name) {
  const used = new Set([...room.players.values()].map((p) => p.color));
  let color = 0;
  while (used.has(color)) color++;
  room.players.set(socket.id, {
    id: socket.id, name, color, ready: false,
    x: 0, y: 0, vx: 0, vy: 0, flip: false, pressing: [], atGoal: false,
  });
  socket.join(room.code);
  socket.data.room = room.code;
}

// ---------- 게임 흐름 ----------
function maybeStart(room) {
  if (room.phase !== 'lobby') return;
  if (room.players.size < MIN_PLAYERS) return;
  if (![...room.players.values()].every((p) => p.ready)) return;
  room.phase = 'starting';
  emitLobby(room);
  room.timer = setTimeout(() => {
    room.timer = null;
    if (!rooms.has(room.code) || room.phase !== 'starting') return;
    startGame(room);
  }, 1000);
}

function startGame(room) {
  room.stageIdx = 0;
  room.deaths = 0;
  room.stageTimes = [];
  room.runStart = Date.now();
  startStage(room, null);
}

function startStage(room, reason) {
  clearTimeout(room.timer);
  room.timer = null;
  room.phase = 'playing';
  room.attempt++;
  room.keyTaken = false;
  room.stageStartAt = Date.now();
  const stage = STAGES[room.stageIdx];
  const spawns = {};
  let i = 0;
  for (const p of room.players.values()) {
    const s = stage.spawns[i % stage.spawns.length];
    spawns[p.id] = { x: s.x, y: s.y };
    p.x = s.x; p.y = s.y - PLAYER.h / 2;
    p.vx = 0; p.vy = 0; p.pressing = []; p.atGoal = false;
    i++;
  }
  io.to(room.code).emit('stageStart', {
    stageIdx: room.stageIdx,
    attempt: room.attempt,
    total: STAGES.length,
    name: stage.name,
    hint: stage.hint,
    spawns,
    players: publicPlayers(room),
    reason,
  });
}

function clearStage(room) {
  room.phase = 'cleared';
  room.clearTime = Date.now() - room.stageStartAt;
  room.stageTimes.push(room.clearTime);
  const last = room.stageIdx === STAGES.length - 1;
  io.to(room.code).emit('stageCleared', {
    stageIdx: room.stageIdx, time: room.clearTime, last, name: STAGES[room.stageIdx].name,
  });
  room.timer = setTimeout(() => {
    room.timer = null;
    if (!rooms.has(room.code) || room.phase !== 'cleared') return;
    if (last) finishGame(room);
    else { room.stageIdx++; startStage(room, null); }
  }, NEXT_STAGE_DELAY);
}

function finishGame(room) {
  room.phase = 'finished';
  io.to(room.code).emit('results', {
    total: Date.now() - room.runStart,
    stageTimes: room.stageTimes,
    stageNames: STAGES.map((s) => s.name),
    deaths: room.deaths,
    players: publicPlayers(room),
  });
}

function toLobby(room) {
  clearTimeout(room.timer);
  room.timer = null;
  room.phase = 'lobby';
  for (const p of room.players.values()) p.ready = false;
  emitLobby(room);
}

function leaveRoom(socket) {
  const room = getRoom(socket);
  if (!room) return;
  const p = room.players.get(socket.id);
  room.players.delete(socket.id);
  socket.leave(room.code);
  socket.data.room = null;
  if (room.players.size === 0) {
    clearTimeout(room.timer);
    rooms.delete(room.code);
    return;
  }
  const name = p ? p.name : '플레이어';
  io.to(room.code).emit('notice', `${name} 님이 나갔습니다.`);
  if (room.phase === 'lobby') { emitLobby(room); maybeStart(room); }
  else if (room.players.size < MIN_PLAYERS || room.phase === 'starting') toLobby(room);
  else if (room.phase === 'playing') startStage(room, { type: 'left', name });
}

// ---------- 상태 계산 / 스냅샷 ----------
function computeState(room, stage) {
  const pressed = {};
  for (const p of room.players.values()) for (const id of p.pressing) pressed[id] = 1;
  const doors = {};
  for (const d of stage.doors) {
    if (d.id === 'L') doors.L = room.keyTaken ? 1 : 0;
    else doors[d.id] = (stage.links[d.id] || []).some((b) => pressed[b]) ? 1 : 0;
  }
  return { pressed, doors };
}

setInterval(() => {
  for (const room of rooms.values()) {
    if (room.phase !== 'playing' && room.phase !== 'cleared') continue;
    const stage = STAGES[room.stageIdx];
    const { pressed, doors } = computeState(room, stage);
    const players = {};
    let atGoal = 0;
    for (const p of room.players.values()) {
      players[p.id] = [r1(p.x), r1(p.y), Math.round(p.vx), Math.round(p.vy), p.flip ? 1 : 0];
      if (p.atGoal) atGoal++;
    }
    io.to(room.code).volatile.emit('snap', {
      a: room.attempt,
      t: room.phase === 'cleared' ? room.clearTime : Date.now() - room.stageStartAt,
      players, doors, pressed,
      key: room.keyTaken ? 1 : 0,
      goal: atGoal,
      n: room.players.size,
    });
    // 모든 플레이어가 열쇠를 얻은 뒤 탈출 문에 모여 있으면 클리어
    if (room.phase === 'playing' && room.keyTaken && room.players.size > 0 && atGoal === room.players.size) {
      clearStage(room);
    }
  }
}, TICK_MS);

// ---------- 소켓 ----------
io.on('connection', (socket) => {
  socket.on('createRoom', (data, cb) => {
    if (typeof cb !== 'function') return;
    leaveRoom(socket);
    const code = genCode();
    const room = {
      code, players: new Map(), phase: 'lobby', stageIdx: 0, attempt: 0, keyTaken: false,
      stageStartAt: 0, clearTime: 0, runStart: 0, deaths: 0, stageTimes: [], timer: null,
    };
    rooms.set(code, room);
    addPlayer(room, socket, cleanName(data && data.name));
    cb({ ok: true, code });
    emitLobby(room);
  });

  socket.on('joinRoom', (data, cb) => {
    if (typeof cb !== 'function') return;
    const code = String((data && data.code) || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return cb({ ok: false, error: '존재하지 않는 방 코드입니다.' });
    if (room.players.has(socket.id)) return cb({ ok: true, code });
    if (room.phase !== 'lobby') return cb({ ok: false, error: '이미 게임이 진행 중인 방입니다.' });
    if (room.players.size >= MAX_PLAYERS) return cb({ ok: false, error: `방이 가득 찼습니다. (최대 ${MAX_PLAYERS}명)` });
    leaveRoom(socket);
    addPlayer(room, socket, cleanName(data && data.name));
    cb({ ok: true, code });
    emitLobby(room);
  });

  socket.on('leaveRoom', () => leaveRoom(socket));

  socket.on('setReady', (ready) => {
    const room = getRoom(socket);
    if (!room || room.phase !== 'lobby') return;
    const p = room.players.get(socket.id);
    if (!p) return;
    p.ready = !!ready;
    emitLobby(room);
    maybeStart(room);
  });

  // 클라이언트 -> 서버: 내 캐릭터 상태 (약 30Hz)
  socket.on('move', (d) => {
    const room = getRoom(socket);
    if (!room || room.phase !== 'playing' || !d || d.a !== room.attempt) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    const num = (v, lo, hi) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 0);
    p.x = num(d.x, -100, WIDTH + 100);
    p.y = num(d.y, -200, HEIGHT + 300);
    p.vx = num(d.vx, -1000, 1000);
    p.vy = num(d.vy, -1500, 1500);
    p.flip = !!d.f;
    p.atGoal = !!d.g;
    const ids = BUTTON_IDS[room.stageIdx];
    p.pressing = Array.isArray(d.p) ? d.p.filter((id) => typeof id === 'string' && ids.has(id)).slice(0, 8) : [];
  });

  socket.on('keyGet', (d) => {
    const room = getRoom(socket);
    if (!room || room.phase !== 'playing' || !d || d.a !== room.attempt || room.keyTaken) return;
    room.keyTaken = true;
    const p = room.players.get(socket.id);
    io.to(room.code).emit('keyTaken', { by: p ? p.name : '' });
  });

  // 한 명이라도 죽으면 스테이지 재시작
  socket.on('dead', (d) => {
    const room = getRoom(socket);
    if (!room || room.phase !== 'playing' || !d || d.a !== room.attempt) return;
    const p = room.players.get(socket.id);
    room.deaths++;
    startStage(room, { type: 'dead', name: p ? p.name : '', cause: d.cause === 'spike' ? 'spike' : 'fall' });
  });

  socket.on('backToLobby', () => {
    const room = getRoom(socket);
    if (room && room.phase === 'finished') toLobby(room);
  });

  socket.on('disconnect', () => leaveRoom(socket));
});

server.listen(PORT, () => {
  console.log(`협동 탈출 게임 서버 실행 중 -> http://localhost:${PORT}`);
});
