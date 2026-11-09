// Alkane Battle: 1-gegen-1 im Kahoot-Stil.
// Der Host-Client erzeugt die Fragen, der Server verteilt sie, misst die Zeit und zählt die Punkte.
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 10000;
const LIMIT_MS = 15000;      // Zeit pro Frage
const REVEAL_MS = 4000;      // Auflösung anzeigen
const START_MS = 3500;       // Countdown vor der ersten Frage
const EMOTES = new Set(['fire','wave','gg','laugh','cool','mind','skull','flask','crown','cold','salute','cry','nerd','alembic','goat','muscle','eyes','clap']);

const rooms = new Map();     // code -> room
let waiting = null;          // Spieler in der Schnellsuche

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ ok: true, online: wss.clients.size, rooms: rooms.size }));
});
const wss = new WebSocketServer({ server, maxPayload: 600 * 1024 });

const send = (ws, msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };
const both = (room, fn) => room.players.forEach((p, i) => p && send(p, fn(i)));
const profile = p => ({ name: p.name, avatar: p.avatar, title: p.title });
const clean = (s, n) => String(s || '').replace(/[<>]/g, '').slice(0, n);

function newCode() {
  let c; do { c = String(1000 + Math.floor(Math.random() * 9000)); } while (rooms.has(c));
  return c;
}

function startMatch(room) {
  room.state = 'prep'; room.scores = [0, 0]; room.qi = -1; room.questions = null; room.rematch = [false, false];
  room.players.forEach((p, i) => { p.slot = i; p.room = room; });
  both(room, i => ({ type: 'matched', code: room.code, you: i, host: i === 0, opp: profile(room.players[1 - i]) }));
}

function nextQuestion(room) {
  clearTimeout(room.timer);
  room.qi++;
  if (room.qi >= room.questions.length) return endMatch(room);
  room.state = 'question'; room.answers = [null, null]; room.t0 = Date.now();
  const q = room.questions[room.qi];
  both(room, () => ({ type: 'q', qi: room.qi, total: room.questions.length, limit: LIMIT_MS, q: { q: q.q, o: q.o, svg: q.svg || '', t: q.t } }));
  room.timer = setTimeout(() => reveal(room), LIMIT_MS + 300);
}

function reveal(room) {
  if (room.state !== 'question') return;
  clearTimeout(room.timer);
  room.state = 'reveal';
  const q = room.questions[room.qi];
  const gained = room.answers.map(a => (a && a.i === q.a) ? Math.round(500 + 500 * Math.max(0, 1 - a.ms / LIMIT_MS)) : 0);
  room.scores = room.scores.map((s, i) => s + gained[i]);
  both(room, () => ({ type: 'reveal', qi: room.qi, a: q.a, e: q.e || '', picks: room.answers.map(a => a ? a.i : -1), gained, scores: room.scores }));
  room.timer = setTimeout(() => nextQuestion(room), REVEAL_MS);
}

function endMatch(room) {
  room.state = 'end';
  const [a, b] = room.scores;
  both(room, () => ({ type: 'end', scores: room.scores, winner: a === b ? -1 : (a > b ? 0 : 1) }));
}

function leave(ws) {
  if (waiting === ws) waiting = null;
  const room = ws.room; if (!room) return;
  ws.room = null;
  clearTimeout(room.timer);
  const other = room.players.find(p => p && p !== ws);
  if (other) { other.room = null; send(other, { type: 'opp_left' }); }
  rooms.delete(room.code);
}

wss.on('connection', ws => {
  ws.name = 'Spieler'; ws.avatar = 'scientist'; ws.title = 'Neuling'; ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const room = ws.room;
    switch (m.type) {
      case 'hello':
        ws.name = clean(m.name, 16) || 'Spieler'; ws.avatar = clean(m.avatar, 20) || 'scientist'; ws.title = clean(m.title, 30) || 'Neuling';
        send(ws, { type: 'hi', online: wss.clients.size });
        break;
      case 'quick':
        leave(ws);
        if (waiting && waiting !== ws && waiting.readyState === 1) {
          const code = newCode(); const r = { code, players: [waiting, ws] }; rooms.set(code, r); waiting = null; startMatch(r);
        } else { waiting = ws; send(ws, { type: 'searching' }); }
        break;
      case 'create': {
        leave(ws);
        const code = newCode(); const r = { code, players: [ws, null], state: 'lobby' };
        rooms.set(code, r); ws.room = r; send(ws, { type: 'room', code });
        break;
      }
      case 'join': {
        const r = rooms.get(clean(m.code, 4));
        if (!r || r.state !== 'lobby' || r.players[1]) return send(ws, { type: 'error', msg: 'Raum nicht gefunden oder schon voll.' });
        if (r.players[0] === ws) return;
        leave(ws); r.players[1] = ws; startMatch(r);
        break;
      }
      case 'cancel': leave(ws); send(ws, { type: 'cancelled' }); break;
      case 'questions':
        if (!room || ws.slot !== 0 || room.state !== 'prep' || !Array.isArray(m.list)) return;
        room.questions = m.list.slice(0, 15).map(q => ({ q: String(q.q).slice(0, 2000), o: (q.o || []).slice(0, 4).map(x => String(x).slice(0, 4000)), a: q.a | 0, e: String(q.e || '').slice(0, 2000), svg: String(q.svg || '').slice(0, 60000), t: q.t | 0 }));
        if (!room.questions.length) return;
        room.state = 'countdown';
        both(room, () => ({ type: 'start', in: START_MS, total: room.questions.length }));
        room.timer = setTimeout(() => nextQuestion(room), START_MS);
        break;
      case 'answer':
        if (!room || room.state !== 'question' || m.qi !== room.qi || room.answers[ws.slot]) return;
        room.answers[ws.slot] = { i: m.i | 0, ms: Date.now() - room.t0 };
        send(room.players[1 - ws.slot], { type: 'opp_answered' });
        if (room.answers[0] && room.answers[1]) reveal(room);
        break;
      case 'emote':
        if (room && EMOTES.has(m.e)) both(room, () => ({ type: 'emote', from: ws.slot, e: m.e }));
        break;
      case 'rematch':
        if (!room || room.state !== 'end') return;
        room.rematch[ws.slot] = true;
        send(room.players[1 - ws.slot], { type: 'opp_rematch' });
        if (room.rematch[0] && room.rematch[1]) startMatch(room);
        break;
      case 'leave': leave(ws); break;
    }
  });
  ws.on('close', () => leave(ws));
});

// Verbindungen am Leben halten, tote Verbindungen aufräumen
setInterval(() => wss.clients.forEach(ws => { if (!ws.alive) return ws.terminate(); ws.alive = false; ws.ping(); }), 25000);

server.listen(PORT, () => console.log('Alkane Battle läuft auf Port ' + PORT));
