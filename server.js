const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ---------------- Champion roster ----------------
// power = raw strength rating used by the auto-sim (not shown to the player as a "stat", just flavor-adjacent)
const CHAMPIONS = [
  { id: 'ronak',  name: 'Ronak',  role: 'fighter',  skill: 'Whirlwind Slash', color: '#e74c3c', power: 74 },
  { id: 'kade',   name: 'Kade',   role: 'fighter',  skill: 'Iron Fist',       color: '#e74c3c', power: 71 },
  { id: 'vera',   name: 'Vera',   role: 'fighter',  skill: 'Blood Charge',    color: '#e74c3c', power: 76 },
  { id: 'thorne', name: 'Thorne', role: 'fighter',  skill: 'Thorn Guard',     color: '#e74c3c', power: 69 },
  { id: 'lyra',   name: 'Lyra',   role: 'marksman', skill: 'Wind Arrow',      color: '#f39c12', power: 73 },
  { id: 'zeke',   name: 'Zeke',   role: 'marksman', skill: 'Rapid Fire',      color: '#f39c12', power: 70 },
  { id: 'nova',   name: 'Nova',   role: 'marksman', skill: 'Meteor Shot',     color: '#f39c12', power: 75 },
  { id: 'kai',    name: 'Kai',    role: 'marksman', skill: 'Piercing Bolt',   color: '#f39c12', power: 68 },
  { id: 'mira',   name: 'Mira',   role: 'support',  skill: 'Moon Heal',       color: '#2ecc71', power: 58 },
  { id: 'doran',  name: 'Doran',  role: 'support',  skill: 'Holy Barrier',    color: '#2ecc71', power: 61 },
  { id: 'sana',   name: 'Sana',   role: 'support',  skill: 'Spirit Ward',     color: '#2ecc71', power: 56 },
  { id: 'boro',   name: 'Boro',   role: 'support',  skill: 'Binding Chain',   color: '#2ecc71', power: 60 },
  { id: 'fenna',  name: 'Fenna',  role: 'jungle',   skill: 'Shadow Pounce',   color: '#16a085', power: 70 },
  { id: 'grix',   name: 'Grix',   role: 'jungle',   skill: 'Bramble Smash',   color: '#16a085', power: 68 },
  { id: 'yuna',   name: 'Yuna',   role: 'jungle',   skill: 'Night Pounce',    color: '#16a085', power: 72 },
  { id: 'bask',   name: 'Bask',   role: 'jungle',   skill: 'Iron Maul',       color: '#16a085', power: 66 },
  { id: 'elowen', name: 'Elowen', role: 'mage',     skill: 'Fireball',        color: '#9b59b6', power: 74 },
  { id: 'ozzy',   name: 'Ozzy',   role: 'mage',     skill: 'Frost Nova',      color: '#9b59b6', power: 69 },
  { id: 'sable',  name: 'Sable',  role: 'mage',     skill: 'Dark Bolt',       color: '#9b59b6', power: 72 },
  { id: 'wren',   name: 'Wren',   role: 'mage',     skill: 'Chain Lightning', color: '#9b59b6', power: 67 },
];

const ROLE_TO_LANE = { fighter: 'top', mage: 'mid', marksman: 'bot', support: 'bot', jungle: 'jungle' };
const LANES = ['top', 'mid', 'bot'];
const LANE_LABEL = { top: 'บน', mid: 'กลาง', bot: 'ล่าง' };

const TACTICS = {
  aggressive: { label: 'เกมรุก', powerMult: 1.15, killBonus: 1.35, towerDefense: 0.85 },
  balanced:   { label: 'สมดุล',   powerMult: 1.0,  killBonus: 1.0,  towerDefense: 1.0 },
  defensive:  { label: 'เกมรับ', powerMult: 0.9,  killBonus: 0.75, towerDefense: 1.3 },
};

const DRAFT_TURN_MS = 20000;
const TACTIC_TURN_MS = 15000;
const MAX_ROUNDS = 14;

const rooms = {}; // code -> room

function genCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}
function safeName(name) {
  return (String(name || 'Player').trim().slice(0, 16)) || 'Player';
}
function currentRoom(socket) {
  const code = socket.data.room;
  return code ? rooms[code] : null;
}
function clearRoom(code) {
  const room = rooms[code];
  if (!room) return;
  if (room.draftTimer) clearTimeout(room.draftTimer);
  if (room.tacticTimer) clearTimeout(room.tacticTimer);
  delete rooms[code];
}
function publicPlayers(room) {
  return room.players.map(p => ({ id: p.id, name: p.name, team: p.team, ready: p.ready, champion: p.champion }));
}
function broadcastLobby(code) {
  const room = rooms[code];
  if (!room) return;
  io.to(code).emit('lobbyUpdate', { code, hostId: room.hostId, players: publicPlayers(room), phase: room.phase });
}

io.on('connection', socket => {
  socket.emit('champList', CHAMPIONS);

  socket.on('createRoom', ({ name }) => {
    let code = genCode();
    while (rooms[code]) code = genCode();
    rooms[code] = {
      code, hostId: socket.id, phase: 'lobby',
      players: [{ id: socket.id, name: safeName(name), team: 'A', ready: false, champion: null }],
      draft: null, tactics: null, matchResult: null,
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
    if (teamA.length < 1 || teamB.length < 1) return socket.emit('errorMsg', 'ต้องมีผู้เล่นทั้งสองทีมอย่างน้อยทีมละ 1 คน');
    if (teamA.length > 5 || teamB.length > 5) return socket.emit('errorMsg', 'แต่ละทีมรับได้สูงสุด 5 คน');

    room.phase = 'draft';
    const queue = [];
    for (let i = 0; i < 3; i++) {
      queue.push({ type: 'ban', team: 'A', actorId: teamA[0].id });
      queue.push({ type: 'ban', team: 'B', actorId: teamB[0].id });
    }
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

  socket.on('chooseTactic', ({ tactic }) => {
    const room = currentRoom(socket);
    if (!room || room.phase !== 'tactics' || !TACTICS[tactic]) return;
    const p = room.players.find(p => p.id === socket.id);
    if (!p) return;
    const captainA = room.players.filter(pl => pl.team === 'A')[0];
    const captainB = room.players.filter(pl => pl.team === 'B')[0];
    if (p.id !== captainA.id && p.id !== captainB.id) return; // only captains decide the team tactic
    room.tactics[p.team] = tactic;
    broadcastTactics(room.code);
    if (room.tactics.A && room.tactics.B) {
      if (room.tacticTimer) clearTimeout(room.tacticTimer);
      runMatch(room.code);
    }
  });

  socket.on('playAgain', () => {
    const room = currentRoom(socket);
    if (!room || room.hostId !== socket.id) return;
    room.phase = 'lobby';
    room.draft = null;
    room.tactics = null;
    room.matchResult = null;
    room.players.forEach(p => { p.champion = null; p.ready = false; });
    broadcastLobby(room.code);
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

// ---------------- Draft ----------------
function broadcastDraft(code) {
  const room = rooms[code];
  if (!room || !room.draft) return;
  io.to(code).emit('draftUpdate', {
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
  room.draftTimer = setTimeout(() => autoResolve(code), Math.max(room.draft.turnDeadline - Date.now(), 0));
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
  resolveDraftStep(code, avail[Math.floor(Math.random() * avail.length)].id);
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
    startTactics(code);
    return;
  }
  room.draft.turnDeadline = Date.now() + DRAFT_TURN_MS;
  broadcastDraft(code);
  scheduleDraftTimeout(code);
}

// ---------------- Tactics phase ----------------
function startTactics(code) {
  const room = rooms[code];
  room.phase = 'tactics';
  room.tactics = { A: null, B: null, deadline: Date.now() + TACTIC_TURN_MS };
  const captainA = room.players.filter(p => p.team === 'A')[0];
  const captainB = room.players.filter(p => p.team === 'B')[0];
  io.to(code).emit('tacticsStart', {
    deadline: room.tactics.deadline,
    captainA: captainA.id, captainB: captainB.id,
    options: Object.entries(TACTICS).map(([id, t]) => ({ id, label: t.label })),
    rosterA: room.players.filter(p => p.team === 'A').map(p => ({ name: p.name, champion: p.champion })),
    rosterB: room.players.filter(p => p.team === 'B').map(p => ({ name: p.name, champion: p.champion })),
  });
  room.tacticTimer = setTimeout(() => {
    if (!room.tactics.A) room.tactics.A = 'balanced';
    if (!room.tactics.B) room.tactics.B = 'balanced';
    runMatch(code);
  }, TACTIC_TURN_MS);
}
function broadcastTactics(code) {
  const room = rooms[code];
  io.to(code).emit('tacticsUpdate', { A: room.tactics.A, B: room.tactics.B });
}

// ---------------- Auto match simulation (runs instantly, client replays the log) ----------------
function runMatch(code) {
  const room = rooms[code];
  room.phase = 'result';

  const rosterOf = team => room.players.filter(p => p.team === team).map(p => {
    const def = CHAMPIONS.find(c => c.id === p.champion) || CHAMPIONS[Math.floor(Math.random() * CHAMPIONS.length)];
    return { playerId: p.id, name: p.name, championId: def.id, championName: def.name, role: def.role, power: def.power, lane: ROLE_TO_LANE[def.role], kills: 0 };
  });

  const teamA = rosterOf('A');
  const teamB = rosterOf('B');
  const tacticA = TACTICS[room.tactics.A];
  const tacticB = TACTICS[room.tactics.B];

  const towers = {};
  LANES.forEach(l => { towers[l] = { A: true, B: true }; });
  const laneStreak = { top: { A: 0, B: 0 }, mid: { A: 0, B: 0 }, bot: { A: 0, B: 0 } };

  const events = [];
  let winner = null;

  function laneRoster(roster, lane) {
    return roster.filter(c => c.lane === lane);
  }
  function janglePower(roster) {
    return roster.filter(c => c.lane === 'jungle').reduce((s, c) => s + c.power, 0);
  }
  function towersRemaining(team) {
    return LANES.filter(l => towers[l][team]).length;
  }

  let round = 1;
  while (round <= MAX_ROUNDS && !winner) {
    for (const lane of LANES) {
      if (winner) break;
      const laneA = laneRoster(teamA, lane);
      const laneB = laneRoster(teamB, lane);
      if (laneA.length === 0 && laneB.length === 0) continue;

      const gankA = Math.random() < 0.5 ? janglePower(teamA) * 0.4 : 0;
      const gankB = Math.random() < 0.5 ? janglePower(teamB) * 0.4 : 0;

      let powerA = (laneA.reduce((s, c) => s + c.power, 0) + gankA) * tacticA.powerMult;
      let powerB = (laneB.reduce((s, c) => s + c.power, 0) + gankB) * tacticB.powerMult;
      if (!towers[lane].A) powerB *= 1.1;
      if (!towers[lane].B) powerA *= 1.1;

      powerA *= 0.85 + Math.random() * 0.3;
      powerB *= 0.85 + Math.random() * 0.3;

      const laneWinnerTeam = powerA >= powerB ? 'A' : 'B';
      const winnerRoster = laneWinnerTeam === 'A' ? teamA : teamB;
      const loserRoster = laneWinnerTeam === 'A' ? teamB : teamA;
      const winnerTactic = laneWinnerTeam === 'A' ? tacticA : tacticB;
      const winnerLaners = laneRoster(winnerRoster, lane);
      const loserLaners = laneRoster(loserRoster, lane);

      laneStreak[lane][laneWinnerTeam]++;
      laneStreak[lane][laneWinnerTeam === 'A' ? 'B' : 'A'] = 0;

      const roll = Math.random();
      if (roll < 0.4 * winnerTactic.killBonus && loserLaners.length > 0) {
        const killer = (winnerLaners.length ? winnerLaners : winnerRoster)[Math.floor(Math.random() * (winnerLaners.length ? winnerLaners.length : winnerRoster.length))];
        const victim = loserLaners[Math.floor(Math.random() * loserLaners.length)];
        killer.kills++;
        events.push({ round, team: laneWinnerTeam, type: 'kill', lane, text: `${killer.name} (${killer.championName}) สอยตาย ${victim.name} (${victim.championName}) ที่เลน${LANE_LABEL[lane]}` });
      } else {
        events.push({ round, team: laneWinnerTeam, type: 'farm', lane, text: `ทีม ${laneWinnerTeam} คุมเลน${LANE_LABEL[lane]}ได้ในรอบนี้` });
      }

      const loserTeamKey = laneWinnerTeam === 'A' ? 'B' : 'A';
      const wasAlreadyExposed = towersRemaining(loserTeamKey) === 0;

      if (laneStreak[lane][laneWinnerTeam] >= 2 && towers[lane][loserTeamKey]) {
        const towerDefRoll = Math.random() * (loserTeamKey === 'A' ? tacticA.towerDefense : tacticB.towerDefense);
        if (towerDefRoll < 0.55) {
          towers[lane][loserTeamKey] = false;
          laneStreak[lane][laneWinnerTeam] = 0;
          events.push({ round, team: laneWinnerTeam, type: 'tower', lane, text: `ป้อมเลน${LANE_LABEL[lane]}ของทีม ${loserTeamKey} ถูกทำลาย!` });
          if (towersRemaining(loserTeamKey) === 0) {
            events.push({ round, team: laneWinnerTeam, type: 'nexus-exposed', lane, text: `ป้อมทีม ${loserTeamKey} หมดแล้ว! Nexus เปิดโล่ง` });
          }
        }
      }

      // If the loser's nexus was already exposed before this exchange, a lane win now has a chance to end the game
      if (wasAlreadyExposed && Math.random() < 0.45) {
        winner = laneWinnerTeam;
        events.push({ round, team: laneWinnerTeam, type: 'victory', lane, text: `ทีม ${laneWinnerTeam} บุกทำลาย Nexus! จบเกม` });
      }
    }
    round++;
  }

  if (!winner) {
    const killsA = teamA.reduce((s, c) => s + c.kills, 0);
    const killsB = teamB.reduce((s, c) => s + c.kills, 0);
    const towersA = towersRemaining('A'), towersB = towersRemaining('B');
    const scoreA = killsA * 2 + (3 - towersB) * 3;
    const scoreB = killsB * 2 + (3 - towersA) * 3;
    winner = scoreA >= scoreB ? 'A' : 'B';
    events.push({ round: MAX_ROUNDS, team: winner, type: 'victory', lane: 'mid', text: `หมดเวลาการแข่งขัน ทีม ${winner} ชนะด้วยคะแนนรวม` });
  }

  room.matchResult = {
    winner, events,
    teamA: teamA.map(c => ({ name: c.name, championId: c.championId, championName: c.championName, kills: c.kills })),
    teamB: teamB.map(c => ({ name: c.name, championId: c.championId, championName: c.championName, kills: c.kills })),
    towers,
    tacticA: room.tactics.A, tacticB: room.tactics.B,
  };
  io.to(code).emit('matchResult', room.matchResult);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server running on port ' + PORT));
