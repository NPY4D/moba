const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ---------------- Champion roster (flavor + role only, skills not yet functional) ----------------
const CHAMPIONS = [
  { id: 'ronak', name: 'Ronak',  role: 'fighter',   skill: 'Whirlwind Slash', color: '#e74c3c' },
  { id: 'kade',  name: 'Kade',   role: 'fighter',   skill: 'Iron Fist',       color: '#e74c3c' },
  { id: 'vera',  name: 'Vera',   role: 'fighter',   skill: 'Blood Charge',    color: '#e74c3c' },
  { id: 'thorne',name: 'Thorne', role: 'fighter',   skill: 'Thorn Guard',     color: '#e74c3c' },
  { id: 'lyra',  name: 'Lyra',   role: 'marksman',  skill: 'Wind Arrow',      color: '#f39c12' },
  { id: 'zeke',  name: 'Zeke',   role: 'marksman',  skill: 'Rapid Fire',      color: '#f39c12' },
  { id: 'nova',  name: 'Nova',   role: 'marksman',  skill: 'Meteor Shot',     color: '#f39c12' },
  { id: 'kai',   name: 'Kai',    role: 'marksman',  skill: 'Piercing Bolt',   color: '#f39c12' },
  { id: 'mira',  name: 'Mira',   role: 'support',   skill: 'Moon Heal',       color: '#2ecc71' },
  { id: 'doran', name: 'Doran',  role: 'support',   skill: 'Holy Barrier',    color: '#2ecc71' },
  { id: 'sana',  name: 'Sana',   role: 'support',   skill: 'Spirit Ward',     color: '#2ecc71' },
  { id: 'boro',  name: 'Boro',   role: 'support',   skill: 'Binding Chain',   color: '#2ecc71' },
  { id: 'fenna', name: 'Fenna',  role: 'jungle',    skill: 'Shadow Pounce',   color: '#16a085' },
  { id: 'grix',  name: 'Grix',   role: 'jungle',    skill: 'Bramble Smash',   color: '#16a085' },
  { id: 'yuna',  name: 'Yuna',   role: 'jungle',    skill: 'Night Pounce',    color: '#16a085' },
  { id: 'bask',  name: 'Bask',   role: 'jungle',    skill: 'Iron Maul',       color: '#16a085' },
  { id: 'elowen',name: 'Elowen', role: 'mage',      skill: 'Fireball',        color: '#9b59b6' },
  { id: 'ozzy',  name: 'Ozzy',   role: 'mage',      skill: 'Frost Nova',      color: '#9b59b6' },
  { id: 'sable', name: 'Sable',  role: 'mage',      skill: 'Dark Bolt',       color: '#9b59b6' },
  { id: 'wren',  name: 'Wren',   role: 'mage',      skill: 'Chain Lightning', color: '#9b59b6' },
];

// ---------------- Map / game constants ----------------
const MAP_SIZE = 800;
const LANES = [
  { name: 'top', y: 150 },
  { name: 'mid', y: 400 },
  { name: 'bot', y: 650 },
];
const BASE_A_X = 50, BASE_B_X = 750;
const TOWER_A_X = 220, TOWER_B_X = 580;
const DRAFT_TURN_MS = 20000;
const WAVE_INTERVAL_S = 20;

const rooms = {}; // code -> room

function genCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function publicPlayers(room) {
  return room.players.map(p => ({ id: p.id, name: p.name, team: p.team, ready: p.ready, champion: p.champion }));
}

function broadcastLobby(code) {
  const room = rooms[code];
  if (!room) return;
  io.to(code).emit('lobbyUpdate', {
    code, hostId: room.hostId, players: publicPlayers(room), phase: room.phase,
  });
}

io.on('connection', socket => {
  socket.emit('champList', CHAMPIONS);

  socket.on('createRoom', ({ name }) => {
    let code = genCode();
    while (rooms[code]) code = genCode();
    rooms[code] = {
      code, hostId: socket.id, phase: 'lobby',
      players: [{ id: socket.id, name: safeName(name), team: 'A', ready: false, champion: null }],
      draft: null, game: null,
    };
    socket.join(code);
    socket.data.room = code;
    broadcastLobby(code);
  });

  socket.on('joinRoom', ({ name, code }) => {
    code = (code || '').toUpperCase().trim();
    const room = rooms[code];
    if (!room) return socket.emit('errorMsg', 'ไม่พบห้องนี้');
    if (room.phase !== 'lobby') return socket.emit('errorMsg', 'เกมเริ่มไปแล้ว เข้าร่วมไม่ได้');
    if (room.players.length >= 10) return socket.emit('errorMsg', 'ห้องเต็มแล้ว (10 คน)');
    const teamACount = room.players.filter(p => p.team === 'A').length;
    const teamBCount = room.players.filter(p => p.team === 'B').length;
    const team = teamACount <= teamBCount ? 'A' : 'B';
    room.players.push({ id: socket.id, name: safeName(name), team, ready: false, champion: null });
    socket.join(code);
    socket.data.room = code;
    broadcastLobby(code);
  });

  socket.on('switchTeam', () => {
    const room = currentRoom(socket);
    if (!room || room.phase !== 'lobby') return;
    const p = room.players.find(p => p.id === socket.id);
    if (p) p.team = p.team === 'A' ? 'B' : 'A';
    broadcastLobby(room.code);
  });

  socket.on('toggleReady', () => {
    const room = currentRoom(socket);
    if (!room || room.phase !== 'lobby') return;
    const p = room.players.find(p => p.id === socket.id);
    if (p) p.ready = !p.ready;
    broadcastLobby(room.code);
  });

  socket.on('startDraft', () => {
    const room = currentRoom(socket);
    if (!room || room.hostId !== socket.id || room.phase !== 'lobby') return;
    const teamA = room.players.filter(p => p.team === 'A');
    const teamB = room.players.filter(p => p.team === 'B');
    if (teamA.length < 1 || teamB.length < 1) {
      return socket.emit('errorMsg', 'ต้องมีผู้เล่นทั้งสองทีมอย่างน้อยทีมละ 1 คน');
    }
    if (teamA.length > 5 || teamB.length > 5) {
      return socket.emit('errorMsg', 'แต่ละทีมรับได้สูงสุด 5 คน');
    }
    room.phase = 'draft';
    const queue = [];
    // Alternating bans, sides swap, 3 per team, A starts
    for (let i = 0; i < 3; i++) {
      queue.push({ type: 'ban', team: 'A', actorId: teamA[0].id });
      queue.push({ type: 'ban', team: 'B', actorId: teamB[0].id });
    }
    // Alternating picks, one per player, interleaved (B picks first after A banned first)
    const maxLen = Math.max(teamA.length, teamB.length);
    for (let i = 0; i < maxLen; i++) {
      if (teamB[i]) queue.push({ type: 'pick', team: 'B', actorId: teamB[i].id });
      if (teamA[i]) queue.push({ type: 'pick', team: 'A', actorId: teamA[i].id });
    }
    room.draft = { queue, index: 0, banned: [], turnDeadline: Date.now() + DRAFT_TURN_MS };
    broadcastDraft(room.code);
    scheduleDraftTimeout(room.code);
  });

  socket.on('draftAction', ({ championId }) => {
    const room = currentRoom(socket);
    if (!room || room.phase !== 'draft') return;
    const step = room.draft.queue[room.draft.index];
    if (!step || step.actorId !== socket.id) return;
    resolveDraftStep(room.code, championId);
  });

  socket.on('move', ({ x, y }) => {
    const room = currentRoom(socket);
    if (!room || room.phase !== 'game') return;
    const champ = room.game.champions.find(c => c.playerId === socket.id);
    if (champ && champ.hp > 0) {
      champ.target = {
        x: clamp(x, 10, MAP_SIZE - 10),
        y: clamp(y, 10, MAP_SIZE - 10),
      };
    }
  });

  socket.on('disconnect', () => {
    const room = currentRoom(socket);
    if (!room) return;
    room.players = room.players.filter(p => p.id !== socket.id);
    if (room.players.length === 0) return clearRoom(room.code);
    if (room.hostId === socket.id) room.hostId = room.players[0].id;
    if (room.phase === 'lobby') broadcastLobby(room.code);
  });
});

function safeName(name) {
  return (String(name || 'Player').trim().slice(0, 16)) || 'Player';
}
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function currentRoom(socket) {
  const code = socket.data.room;
  return code ? rooms[code] : null;
}
function clearRoom(code) {
  const room = rooms[code];
  if (!room) return;
  if (room.gameLoop) clearInterval(room.gameLoop);
  if (room.draftTimer) clearTimeout(room.draftTimer);
  delete rooms[code];
}

// ---------------- Draft ----------------
function broadcastDraft(code) {
  const room = rooms[code];
  if (!room || !room.draft) return;
  io.to(code).emit('draftUpdate', {
    total: room.draft.queue.length,
    index: room.draft.index,
    upcoming: room.draft.queue.map(q => ({ type: q.type, team: q.team })),
    banned: room.draft.banned,
    picks: room.players.filter(p => p.champion).map(p => ({ id: p.id, name: p.name, team: p.team, champion: p.champion })),
    turnDeadline: room.draft.turnDeadline,
    currentActor: room.draft.queue[room.draft.index] ? room.draft.queue[room.draft.index].actorId : null,
  });
}

function scheduleDraftTimeout(code) {
  const room = rooms[code];
  if (!room || !room.draft) return;
  if (room.draftTimer) clearTimeout(room.draftTimer);
  const step = room.draft.queue[room.draft.index];
  if (!step) return;
  const timeLeft = room.draft.turnDeadline - Date.now();
  room.draftTimer = setTimeout(() => autoResolve(code), Math.max(timeLeft, 0));
}

function availableChampions(room) {
  const taken = new Set([...room.draft.banned, ...room.players.filter(p => p.champion).map(p => p.champion)]);
  return CHAMPIONS.filter(c => !taken.has(c.id));
}

function autoResolve(code) {
  const room = rooms[code];
  if (!room || !room.draft) return;
  const avail = availableChampions(room);
  if (avail.length === 0) return;
  const pick = avail[Math.floor(Math.random() * avail.length)];
  resolveDraftStep(code, pick.id);
}

function resolveDraftStep(code, championId) {
  const room = rooms[code];
  const step = room.draft.queue[room.draft.index];
  if (!step) return;
  const avail = availableChampions(room);
  if (!avail.find(c => c.id === championId)) return;
  if (step.type === 'ban') {
    room.draft.banned.push(championId);
  } else {
    const p = room.players.find(p => p.id === step.actorId);
    if (p) p.champion = championId;
  }
  room.draft.index++;
  if (room.draft.index >= room.draft.queue.length) {
    if (room.draftTimer) clearTimeout(room.draftTimer);
    startGame(code);
    return;
  }
  room.draft.turnDeadline = Date.now() + DRAFT_TURN_MS;
  broadcastDraft(code);
  scheduleDraftTimeout(code);
}

// ---------------- Game (MOBA map: lanes, towers, creep waves) ----------------
function startGame(code) {
  const room = rooms[code];
  room.phase = 'game';
  const champions = room.players.map(p => {
    const def = CHAMPIONS.find(c => c.id === p.champion) || CHAMPIONS[Math.floor(Math.random() * CHAMPIONS.length)];
    const spawnX = p.team === 'A' ? BASE_A_X : BASE_B_X;
    return {
      playerId: p.id, name: p.name, team: p.team, championId: def.id,
      x: spawnX, y: 400, target: null, hp: 1000, maxHp: 1000, speed: 3.2,
    };
  });
  const towers = [];
  LANES.forEach(lane => {
    towers.push({ id: `A-${lane.name}`, team: 'A', x: TOWER_A_X, y: lane.y, hp: 1500, maxHp: 1500, range: 90, dps: 40, alive: true });
    towers.push({ id: `B-${lane.name}`, team: 'B', x: TOWER_B_X, y: lane.y, hp: 1500, maxHp: 1500, range: 90, dps: 40, alive: true });
  });
  room.game = { champions, towers, creeps: [], nextCreepId: 1, lastWave: -WAVE_INTERVAL_S, startedAt: Date.now() };

  io.to(code).emit('gameStart', {
    mapSize: MAP_SIZE, lanes: LANES, baseA: BASE_A_X, baseB: BASE_B_X,
    champions: champions.map(c => ({ playerId: c.playerId, name: c.name, team: c.team, championId: c.championId })),
    towers,
  });
  room.gameLoop = setInterval(() => tickGame(code), 100);
}

function spawnWave(room) {
  LANES.forEach(lane => {
    for (let i = 0; i < 3; i++) {
      room.game.creeps.push({ id: room.game.nextCreepId++, team: 'A', lane: lane.name, x: BASE_A_X, y: lane.y + (i - 1) * 16, hp: 220, maxHp: 220, speed: 1.6 });
      room.game.creeps.push({ id: room.game.nextCreepId++, team: 'B', lane: lane.name, x: BASE_B_X, y: lane.y + (i - 1) * 16, hp: 220, maxHp: 220, speed: 1.6 });
    }
  });
}

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

function tickGame(code) {
  const room = rooms[code];
  if (!room || !room.game) return;
  const g = room.game;
  const elapsed = (Date.now() - g.startedAt) / 1000;

  if (elapsed - g.lastWave >= WAVE_INTERVAL_S) {
    g.lastWave = elapsed;
    spawnWave(room);
  }

  g.champions.forEach(c => {
    if (c.hp <= 0 || !c.target) return;
    const dx = c.target.x - c.x, dy = c.target.y - c.y;
    const d = Math.hypot(dx, dy);
    if (d < c.speed) { c.x = c.target.x; c.y = c.target.y; c.target = null; }
    else { c.x += (dx / d) * c.speed; c.y += (dy / d) * c.speed; }
  });

  g.creeps.forEach(cr => {
    const targetX = cr.team === 'A' ? BASE_B_X : BASE_A_X;
    const dx = targetX - cr.x;
    if (Math.abs(dx) > 2) cr.x += Math.sign(dx) * cr.speed;
  });
  g.creeps = g.creeps.filter(cr => {
    const targetX = cr.team === 'A' ? BASE_B_X : BASE_A_X;
    return Math.abs(cr.x - targetX) > 10;
  });

  g.towers.forEach(t => {
    if (!t.alive) return;
    let target = null, best = Infinity;
    g.creeps.forEach(cr => {
      if (cr.team === t.team) return;
      const d = dist(t, cr);
      if (d <= t.range && d < best) { best = d; target = cr; }
    });
    if (!target) {
      g.champions.forEach(c => {
        if (c.team === t.team || c.hp <= 0) return;
        const d = dist(t, c);
        if (d <= t.range && d < best) { best = d; target = c; }
      });
    }
    if (target) target.hp -= t.dps * 0.1;
  });
  g.creeps = g.creeps.filter(cr => cr.hp > 0);

  g.creeps.forEach(cr => {
    g.towers.forEach(t => {
      if (!t.alive || t.team === cr.team) return;
      if (dist(cr, t) < 30) t.hp -= 8 * 0.1;
    });
  });
  g.towers.forEach(t => { if (t.hp <= 0 && t.alive) { t.alive = false; t.hp = 0; } });

  io.to(code).emit('gameTick', {
    champions: g.champions.map(c => ({ playerId: c.playerId, x: c.x, y: c.y, hp: c.hp, maxHp: c.maxHp })),
    creeps: g.creeps.map(cr => ({ id: cr.id, team: cr.team, x: cr.x, y: cr.y, hp: cr.hp, maxHp: cr.maxHp })),
    towers: g.towers.map(t => ({ id: t.id, hp: t.hp, maxHp: t.maxHp, alive: t.alive })),
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server running on port ' + PORT));
