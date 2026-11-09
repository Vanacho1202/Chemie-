// Alkane Battle: 1-gegen-1 im Kahoot-Stil.
// Der Host-Client erzeugt die Fragen, der Server verteilt sie, misst die Zeit und zählt die Punkte.
// Wer kurz die App wechselt, behält 90 Sekunden lang seinen Platz und kann wieder einsteigen.
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const https = require('https');
const dnsp = require('dns').promises;
// Eigene Adress-Auflösung mit Zeitlimit: die System-Auflösung hängt bei Render teils minutenlang
const pubResolver = new dnsp.Resolver({ timeout: 3000, tries: 2 }); pubResolver.setServers(['8.8.8.8', '1.1.1.1']);
const sysResolver = new dnsp.Resolver({ timeout: 3000, tries: 2 });
const dnsCache = new Map();
async function resolve4(host) {
  if (require('net').isIP(host)) return host;
  const c = dnsCache.get(host); if (c && c.exp > Date.now()) return c.ip;
  let ips; try { ips = await pubResolver.resolve4(host); } catch { ips = await sysResolver.resolve4(host); }
  const ip = ips[Math.floor(Math.random() * ips.length)];
  dnsCache.set(host, { ip, exp: Date.now() + 5 * 60 * 1000 });
  return ip;
}
function lookup(hostname, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  resolve4(hostname).then(ip => (opts && opts.all) ? cb(null, [{ address: ip, family: 4 }]) : cb(null, ip, 4), err => cb(err));
}
// HTTPS-Anfrage über die eigene Auflösung, mit Zeitlimit bis zur ersten Antwort
function httpsReq(url, { method = 'GET', headers = {}, body = null, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const h = { ...headers }; if (body) h['Content-Length'] = Buffer.byteLength(body);
    const req = https.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method, headers: h, lookup, family: 4 }, res => { clearTimeout(t); resolve(res); });
    const t = setTimeout(() => req.destroy(Object.assign(new Error('keine Antwort nach ' + timeout + ' ms'), { name: 'TimeoutError' })), timeout);
    req.on('error', e => { clearTimeout(t); reject(e); });
    req.end(body || undefined);
  });
}
const readAll = res => new Promise((ok, bad) => { let d = ''; res.setEncoding('utf8'); res.on('data', c => d += c); res.on('end', () => ok(d)); res.on('error', bad); });

const PORT = process.env.PORT || 10000;
const LIMIT_MS = 20000;            // Zeit pro Frage
const READY_MS = 5 * 60 * 1000;    // spätestens nach 5 Minuten geht es weiter
const START_MS = 3500;             // Countdown vor der ersten Frage
const GRACE_MS = 90 * 1000;        // so lange bleibt der Platz nach Verbindungsabbruch frei
const EMOTES = new Set(['fire','wave','gg','laugh','cool','mind','skull','flask','crown','cold','salute','cry','nerd','alembic','goat','muscle','eyes','clap','heart','rocket','brain','sleep','party','angry','think','ghost','hundred','bolt','atom','sweat','clown','devil','star','trophy','popcorn','snail']);

const rooms = new Map();     // code -> room
let waiting = null;          // Spieler in der Schnellsuche
const online = new Map();    // Spieler-ID -> aktuelle Verbindung (wer gerade die App offen hat)

// ---------- Cloud-Spielstand (Postgres) ----------
let pool = null;
const CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newSaveCode = () => Array.from(crypto.randomBytes(8), b => CODE_ABC[b % CODE_ABC.length]).join('').replace(/^(.{4})/, '$1-');
async function makePool(urlStr) {
  const u = new URL(urlStr);
  // Adresse selbst auflösen (System-Auflösung hängt bei Render teils)
  let host = u.hostname; try { if (!require('net').isIP(host)) host = (await sysResolver.resolve4(host))[0]; } catch {}
  const { Pool } = require('pg');
  // Render-interne Adressen (ohne Punkt) brauchen kein SSL; extern (Render, Neon …) mit SSL und SNI
  const internal = !u.hostname.includes('.') || u.searchParams.get('sslmode') === 'disable';
  return new Pool({ host, port: +u.port || 5432, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: u.pathname.slice(1),
    ssl: internal ? false : { rejectUnauthorized: false, servername: u.hostname }, max: 3, connectionTimeoutMillis: 15000, idleTimeoutMillis: 60000 });
}
const SAVES_TABLE = `create table if not exists saves (pid text primary key, secret text not null, code text unique not null, name text, data jsonb not null, updated_at timestamptz not null default now())`;
async function initDb() {
  if (!process.env.DATABASE_URL) return console.log('Cloud-Spielstand: keine DATABASE_URL gesetzt');
  try {
    pool = await makePool(process.env.DATABASE_URL);
    pool.on('error', e => console.log('Cloud-Spielstand: Verbindung', e.message));
    await pool.query(SAVES_TABLE);
    await pool.query(`create table if not exists gifts (id serial primary key, pid text not null, coins int not null default 0, name text, note text, created_at timestamptz not null default now(), delivered_at timestamptz)`);
    await pool.query('alter table gifts add column if not exists extra jsonb');
    console.log('Cloud-Spielstand: Datenbank bereit');
  } catch (e) { console.log('Cloud-Spielstand: Datenbank-Fehler', e.message); pool = null; return; }
  // Umzug: Spielstände aus der alten Datenbank übernehmen (neuere gewinnen)
  if (process.env.OLD_DATABASE_URL) {
    try {
      const old = await makePool(process.env.OLD_DATABASE_URL);
      const { rows } = await old.query('select pid, secret, code, name, data, updated_at from saves');
      let n = 0;
      for (const r of rows) {
        const res = await pool.query(`insert into saves (pid, secret, code, name, data, updated_at) values ($1,$2,$3,$4,$5,$6)
          on conflict (pid) do update set secret=excluded.secret, code=excluded.code, name=excluded.name, data=excluded.data, updated_at=excluded.updated_at
          where saves.updated_at < excluded.updated_at`, [r.pid, r.secret, r.code, r.name, JSON.stringify(r.data), r.updated_at]);
        n += res.rowCount;
      }
      await old.end();
      console.log(`Cloud-Spielstand: Umzug fertig, ${n} von ${rows.length} Spielständen übernommen`);
    } catch (e) { console.log('Cloud-Spielstand: Umzug-Fehler', e.message); }
  }
}
const HEX = /^[a-f0-9]{16,64}$/;
// Geschenke (Münzen, Namensänderung) genau einmal an ein Gerät ausliefern, das sie versteht
async function takeGifts(pid, m) {
  if (!m.gifts) return undefined;
  try {
    // Geschenke mit extra.minv nur an Apps, die das schon verstehen (m.gifts = Fähigkeitsstufe)
    const r = await pool.query("update gifts set delivered_at = now() where pid = $1 and delivered_at is null and coalesce((extra->>'minv')::int, 1) <= $2 returning coins, name, note, extra", [pid, parseInt(m.gifts, 10) || 1]);
    return r.rows.length ? r.rows : undefined;
  } catch (e) { console.log('Geschenke-Fehler', e.message); return undefined; }
}
// ---------- Admin (nur Gabriels Account; geprüft über Spieler-ID + geheimen Schlüssel) ----------
const ADMIN_PIDS = (process.env.ADMIN_PIDS || '05ea7edd8086cbd1712f').split(',').map(x => x.trim()).filter(Boolean);
async function isAdmin(m) {
  if (!pool || !ADMIN_PIDS.includes(String(m.pid || '')) || !HEX.test(m.secret || '')) return false;
  const r = await pool.query('select 1 from saves where pid = $1 and secret = $2', [m.pid, m.secret]);
  return r.rows.length > 0;
}
const PID = /^[a-f0-9]{8,64}$/;
async function adminRoute(path, m) {
  if (!pool) return [503, { error: 'Datenbank fehlt.' }];
  if (path === '/admin/me') return [200, { admin: await isAdmin(m) }];
  if (!(await isAdmin(m))) return [403, { error: 'Kein Admin.' }];
  if (path === '/admin/players') {
    const r = await pool.query(`select pid, name, code, (data->>'coins')::int as coins, data->'eq' as eq, updated_at from saves order by updated_at desc limit 300`);
    const known = new Set(r.rows.map(x => x.pid));
    const list = r.rows.map(x => ({ id: x.pid, name: x.name || '', code: x.code, coins: x.coins, avatar: x.eq && x.eq.avatar, updated: x.updated_at, online: online.has(x.pid) }));
    // online, aber noch nie gespeichert
    for (const [pid, ws] of online) if (!known.has(pid) && ws.readyState === 1) list.unshift({ id: pid, name: ws.name || '', code: null, coins: null, avatar: ws.avatar, updated: null, online: true });
    return [200, { players: list }];
  }
  const target = String(m.target || '');
  if (!PID.test(target)) return [400, { error: 'Ungültige Spieler-ID.' }];
  if (path === '/admin/gift') {
    const coins = Math.max(-1000000, Math.min(1000000, parseInt(m.coins, 10) || 0));
    const name = m.name ? String(m.name).replace(/[<>]/g, '').trim().slice(0, 16) : null;
    const items = Array.isArray(m.items) ? m.items.map(String).filter(x => /^[eatc]_[^<>"]{1,40}$/.test(x)).slice(0, 300) : [];
    const extra = {}; if (items.length) extra.items = items; if (m.allItems) extra.allItems = true;
    if (!coins && !name && !items.length && !m.allItems) return [400, { error: 'Nichts zu schenken.' }];
    await pool.query('insert into gifts (pid, coins, name, note, extra) values ($1,$2,$3,$4,$5)', [target, coins, name, 'Admin', Object.keys(extra).length ? extra : null]);
    const ws = online.get(target); if (ws) send(ws, { type: 'gift' });
    console.log('Admin-Geschenk an', target.slice(0, 8), { coins, name, items: items.length, all: !!m.allItems });
    return [200, { ok: true, live: !!ws }];
  }
  if (path === '/admin/kick') {
    const ws = online.get(target); if (!ws) return [404, { error: 'Nicht online.' }];
    send(ws, { type: 'error_soft', msg: 'Du wurdest vom Admin getrennt.' }); setTimeout(() => { try { ws.close(); } catch {} }, 300);
    return [200, { ok: true }];
  }
  return [404, { error: 'unbekannt' }];
}
async function cloudRoute(path, m) {
  if (!pool) return [503, { error: 'Cloud-Speicher ist noch nicht eingerichtet.' }];
  if (path === '/cloud/save') {
    if (!HEX.test(m.pid || '') || !HEX.test(m.secret || '') || typeof m.data !== 'object') return [400, { error: 'bad' }];
    const data = JSON.stringify(m.data); if (data.length > 200000) return [413, { error: 'zu groß' }];
    for (let i = 0; i < 3; i++) {
      try {
        const r = await pool.query(`insert into saves (pid, secret, code, name, data) values ($1,$2,$3,$4,$5)
          on conflict (pid) do update set data = excluded.data, name = excluded.name, updated_at = now() where saves.secret = excluded.secret
          returning code, updated_at`, [m.pid, m.secret, newSaveCode(), String(m.data.name || '').slice(0, 16), data]);
        if (!r.rows.length) return [403, { error: 'Falscher Schlüssel für diesen Spielstand.' }];
        return [200, { ok: true, code: r.rows[0].code, updated: r.rows[0].updated_at, gifts: await takeGifts(m.pid, m) }];
      } catch (e) { if (!/saves_code_key/.test(e.message)) throw e; }   // Code schon vergeben: neu würfeln
    }
    return [500, { error: 'code' }];
  }
  if (path === '/cloud/get') {
    if (!HEX.test(m.pid || '') || !HEX.test(m.secret || '')) return [400, { error: 'bad' }];
    const r = await pool.query('select code, data, updated_at from saves where pid = $1 and secret = $2', [m.pid, m.secret]);
    return [200, r.rows.length ? { found: true, code: r.rows[0].code, data: r.rows[0].data, updated: r.rows[0].updated_at, gifts: await takeGifts(m.pid, m) } : { found: false }];
  }
  if (path === '/cloud/load') {
    const code = String(m.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^(.{4})/, '$1-');
    const r = await pool.query('select pid, secret, code, data from saves where code = $1', [code]);
    if (!r.rows.length) return [404, { error: 'Diesen Code gibt es nicht. Prüf ihn nochmal.' }];
    return [200, r.rows[0]];
  }
  return [404, { error: 'unbekannt' }];
}

// ---------- KI-Bot (Google Gemini) ----------
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
// Schnelle Modelle zuerst; beim Start wird das schnellste, das antwortet, ausgewählt
const MODEL_CANDIDATES = (process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite,gemini-flash-lite-latest,gemini-3-flash-preview,gemini-3.1-flash-lite-preview').split(',').map(x => x.trim()).filter(Boolean);
let GEMINI_MODEL = MODEL_CANDIDATES[0];
const SYSTEM = `Du bist "Alki", ein freundlicher Chemie-Nachhilfelehrer in einer Lern-App.
Der Schüler (ca. 10. Klasse, Waldorfschule) schreibt bald eine Chemieklausur über Alkane mit diesen Themen:
1. Homologe Reihe der Alkane (CnH2n+2, Methan bis Decan)
2. Verzweigte Alkane: Benennung nach IUPAC und Zeichnen
3. Isomerie
4. Elektronegativität und Polarität (polar, unpolar, Partialladungen); in der App gilt: ΔEN unter 0,5 unpolar, 0,5 bis 1,7 polar, über 1,7 ionisch
5. Zwischenmolekulare Wechselwirkungen (Van-der-Waals-Kräfte, Wasserstoffbrücken: Entstehung, Anwendung)
6. Eigenschaften der Alkane (Löslichkeit, Siedetemperatur, Viskosität) und ihre Veränderung in der Reihe
7. Formelschreibweisen (Summen-, Struktur-, Halbstruktur-, Skelettformel) und Definitionen
Regeln:
- Antworte immer auf Deutsch, mit ä, ö, ü und ß, locker und ermutigend, aber fachlich korrekt.
- Erkläre einfach, Schritt für Schritt, mit einem konkreten Beispiel. Bei Begründungen nutze Je-desto-Ketten.
- Halte dich kurz: höchstens etwa 150 Wörter, außer der Schüler möchte ausdrücklich mehr.
- Formeln mit Unicode-Tiefstellung schreiben, z. B. C₆H₁₄, CH₃–CH₂–CH₃.
- Formatierung nur so: **fett** für Fachbegriffe und Aufzählungen mit "- " am Zeilenanfang. Keine Tabellen, keine Überschriften.
- Wenn du dir unsicher bist, sag es ehrlich. Erfinde keine Fakten.
- Bei Fragen ohne Chemie-Bezug antworte kurz und lenke freundlich zurück zum Lernen.`;
const rate = new Map(); // IP -> [Zeitstempel]
function limited(ip) {
  const now = Date.now(), list = (rate.get(ip) || []).filter(t => now - t < 60000);
  list.push(now); rate.set(ip, list);
  return list.length > 20;
}
const thinkCfg = model => /gemini-3/.test(model) ? { thinkingLevel: 'minimal' } : { thinkingBudget: 0 };
function geminiBody(messages, thinkingOff) {
  const contents = messages.slice(-12).map(m => ({ role: m.role === 'bot' ? 'model' : 'user', parts: [{ text: String(m.text || '').slice(0, 2000) }] }));
  const generationConfig = { temperature: 0.4, maxOutputTokens: 900 };
  if (thinkingOff) generationConfig.thinkingConfig = thinkCfg(GEMINI_MODEL);   // schneller: kein langes Nachdenken
  return JSON.stringify({ system_instruction: { parts: [{ text: SYSTEM }] }, contents, generationConfig });
}
let thinkingSupported = true;   // falls das Modell thinkingBudget ablehnt, ab dann ohne
async function geminiStream(messages, onText) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse`;
  const once = off => httpsReq(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY }, body: geminiBody(messages, off), timeout: 20000 });
  const go = async off => {   // bei Netzwerkfehler oder Zeitüberschreitung einmal neu versuchen
    try { return await once(off); }
    catch (e) { console.log('Gemini nicht erreichbar, neuer Versuch:', e.name, e.code || e.message); dnsCache.clear(); return await once(off); }
  };
  let r = await go(thinkingSupported);
  if (r.statusCode !== 200 && thinkingSupported) {
    const t = await readAll(r);
    if (/think/i.test(t)) { thinkingSupported = false; r = await go(false); }
    else throw new Error('HTTP ' + r.statusCode + ' ' + t.slice(0, 300));
  }
  if (r.statusCode !== 200) throw new Error('HTTP ' + r.statusCode + ' ' + (await readAll(r)).slice(0, 300));
  r.setEncoding('utf8');
  let buf = '', total = '';
  for await (const chunk of r) {
    buf += chunk;
    let k;
    while ((k = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, k).trim(); buf = buf.slice(k + 1);
      if (!line.startsWith('data:')) continue;
      try {
        const j = JSON.parse(line.slice(5));
        const parts = (((j.candidates || [])[0] || {}).content || {}).parts || [];
        const t = parts.filter(p => !p.thought).map(p => p.text || '').join('');
        if (t) { total += t; onText(t); }
      } catch {}
    }
  }
  return total;
}

// Karteikarten erstellen lassen: Gemini liefert eine JSON-Liste {front, back}
async function geminiCards(topic) {
  const prompt = `Erstelle 10 bis 14 Karteikarten zum Thema: "${topic}".
Zielgruppe: Schüler der 10. Klasse, Chemieklausur über Alkane (homologe Reihe CnH2n+2 von Methan bis Decan, verzweigte Alkane und IUPAC-Namen, Isomerie, Elektronegativität und Polarität, zwischenmolekulare Wechselwirkungen, Eigenschaften der Alkane, Formelschreibweisen).
Regeln:
- Vorderseite: kurzer Begriff, Name oder Frage (höchstens 80 Zeichen).
- Rückseite: knappe, fachlich sichere Antwort (höchstens 220 Zeichen), zum Auswendiglernen geeignet.
- Formeln mit Unicode-Tiefstellung, z. B. C₆H₁₄, CH₃–CH₂–CH₃.
- Deutsch mit ä, ö, ü und ß. Keine Wiederholungen. Nichts erfinden.
- Bei Reihen oder Listen (z. B. homologe Reihe) je eine Karte pro Glied, z. B. Vorderseite "Hexan", Rückseite "C₆H₁₄ · 6 C-Atome · flüssig".`;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const schema = { type: 'ARRAY', items: { type: 'OBJECT', properties: { front: { type: 'STRING' }, back: { type: 'STRING' } }, required: ['front', 'back'] } };
  const call = async (withSchema, withThink) => {
    const generationConfig = { temperature: 0.3, maxOutputTokens: 3000, responseMimeType: 'application/json' };
    if (withSchema) generationConfig.responseSchema = schema;
    if (withThink) generationConfig.thinkingConfig = thinkCfg(GEMINI_MODEL);
    const r = await httpsReq(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig }), timeout: 30000 });
    return { status: r.statusCode, body: await readAll(r) };
  };
  let x = await call(true, thinkingSupported);
  if (x.status === 400) x = await call(false, false);
  if (x.status !== 200) throw new Error('HTTP ' + x.status + ' ' + x.body.slice(0, 200));
  const j = JSON.parse(x.body);
  const text = ((((j.candidates || [])[0] || {}).content || {}).parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
  const arr = JSON.parse(text.replace(/^```(json)?|```$/g, '').trim());
  return (Array.isArray(arr) ? arr : []).filter(c => c && c.front && c.back).slice(0, 20)
    .map(c => ({ front: String(c.front).replace(/[<>]/g, '').slice(0, 120), back: String(c.back).replace(/[<>]/g, '').slice(0, 300) }));
}

async function pickModel() {
  const test = async (model, think) => {
    const gc = think ? { thinkingConfig: thinkCfg(model) } : {};
    const t0 = Date.now();
    const r = await httpsReq(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Was ist Methan? Ein Satz.' }] }], generationConfig: gc }), timeout: 25000 });
    const body = await readAll(r);
    return { status: r.statusCode, ms: Date.now() - t0, body };
  };
  const results = await Promise.all(MODEL_CANDIDATES.map(async model => {
    try {
      let x = await test(model, true), think = true;
      if (x.status === 400 && /think/i.test(x.body)) { x = await test(model, false); think = false; }
      return { model, think, ok: x.status === 200, ms: x.ms, info: x.status === 200 ? '' : (x.status + ' ' + x.body.replace(/\s+/g, ' ').slice(0, 100)) };
    } catch (e) { return { model, ok: false, ms: 0, info: e.message }; }
  }));
  const good = results.filter(x => x.ok).sort((a, b) => a.ms - b.ms);
  if (good.length) { GEMINI_MODEL = good[0].model; thinkingSupported = good[0].think; }
  console.log('Modelltest: ' + results.map(x => `${x.model}${x.think === false ? ' (ohne Denk-Einstellung)' : ''}: ${x.ok ? x.ms + ' ms' : 'FEHLER ' + x.info}`).join(' | ') + ' => nehme ' + GEMINI_MODEL);
}

// Diagnose: Wo hängt die Verbindung zu Google? (zeigt den Schlüssel nicht an)
async function runDiag() {
  const out = { model: GEMINI_MODEL, keyPrefix: GEMINI_KEY ? GEMINI_KEY.slice(0, 4) + '…' : null, keyLength: GEMINI_KEY.length };
  const time = async (name, fn) => { const t0 = Date.now(); try { out[name] = { ok: true, ...(await fn()), ms: Date.now() - t0 }; } catch (e) { out[name] = { ok: false, ms: Date.now() - t0, error: e.name + ': ' + e.message + (e.cause ? ' / ' + (e.cause.code || e.cause.message) : '') }; } };
  const T = 12000;
  await Promise.all([
    time('dns', async () => ({ ip: await resolve4('generativelanguage.googleapis.com') })),
    time('google204', async () => ({ status: (await httpsReq('https://www.google.com/generate_204', { timeout: T })).statusCode })),
    time('models', async () => { const r = await httpsReq('https://generativelanguage.googleapis.com/v1beta/models?pageSize=50', { headers: { 'x-goog-api-key': GEMINI_KEY }, timeout: T }); const j = JSON.parse(await readAll(r)); return { status: r.statusCode, error: j.error && j.error.message, flash: (j.models || []).map(m => m.name).filter(n => /flash/.test(n)).slice(0, 12) }; }),
    time('generate', async () => { const r = await httpsReq(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Antworte nur mit OK' }] }] }), timeout: T }); return { status: r.statusCode, body: (await readAll(r)).slice(0, 300) }; })
  ]);
  console.log('DIAG', JSON.stringify(out));
  return out;
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Cache-Control': 'no-store' };
const server = http.createServer((req, res) => {
  const json = (code, obj) => { res.writeHead(code, { ...CORS, 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (req.method === 'GET' && req.url.startsWith('/diag')) {
    runDiag().then(out => json(200, out));
    return;
  }
  if (req.method === 'POST' && (req.url.startsWith('/cloud/') || req.url.startsWith('/admin/'))) {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 250000) req.destroy(); });
    req.on('end', async () => {
      const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0];
      if (req.url.startsWith('/cloud/load') && limited('load:' + ip)) return json(429, { error: 'Zu viele Versuche. Warte eine Minute.' });
      let m; try { m = JSON.parse(body); } catch { return json(400, { error: 'bad_json' }); }
      if (req.url.startsWith('/admin/') && limited('admin:' + ip)) return json(429, { error: 'Zu viele Anfragen.' });
      try { const path = req.url.split('?')[0]; const [code, out] = path.startsWith('/admin/') ? await adminRoute(path, m) : await cloudRoute(path, m); json(code, out); }
      catch (e) { console.log('Cloud-Fehler:', e.message); json(500, { error: 'Speichern gerade nicht möglich.' }); }
    });
    return;
  }
  if (req.method === 'POST' && req.url.startsWith('/cards')) {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 5000) req.destroy(); });
    req.on('end', async () => {
      if (!GEMINI_KEY) return json(503, { error: 'no_key' });
      const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0];
      if (limited('cards:' + ip)) return json(429, { error: 'Zu viele Anfragen. Warte kurz.' });
      let m; try { m = JSON.parse(body); } catch { return json(400, { error: 'bad_json' }); }
      const topic = String(m.topic || '').replace(/[<>"]/g, '').slice(0, 200).trim();
      if (!topic) return json(400, { error: 'Kein Thema angegeben.' });
      const t0 = Date.now();
      try { const cards = await geminiCards(topic); console.log('Karteikarten:', cards.length, 'in', Date.now() - t0, 'ms'); json(cards.length ? 200 : 502, cards.length ? { cards } : { error: 'Keine Karten erhalten.' }); }
      catch (e) { console.log('Karteikarten-Fehler:', e.message); json(502, { error: 'ai_failed' }); }
    });
    return;
  }
  if (req.method === 'POST' && req.url.startsWith('/ask')) {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 40000) req.destroy(); });
    req.on('end', async () => {
      if (!GEMINI_KEY) return json(503, { error: 'no_key' });
      const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0];
      if (limited(ip)) return json(429, { error: 'Zu viele Fragen auf einmal. Warte kurz.' });
      let m; try { m = JSON.parse(body); } catch { return json(400, { error: 'bad_json' }); }
      if (!Array.isArray(m.messages) || !m.messages.length) return json(400, { error: 'no_messages' });
      const t0 = Date.now(); let started = false;
      try {
        await geminiStream(m.messages, t => {
          if (!started) { started = true; res.writeHead(200, { ...CORS, 'Content-Type': 'text/plain; charset=utf-8', 'X-Accel-Buffering': 'no' }); console.log('Alki: erste Wörter nach', Date.now() - t0, 'ms'); }
          res.write(t);
        });
        console.log('Alki: fertig nach', Date.now() - t0, 'ms');
        if (!started) return json(200, { answer: 'Dazu fällt mir gerade nichts ein. Frag es nochmal anders.' });
        res.end();
      } catch (e) {
        console.log('Gemini-Fehler:', e.name, e.message, e.cause && (e.cause.code || e.cause.message || ''));
        if (started) { res.write('\n\n(Die Antwort wurde unterbrochen.)'); res.end(); } else json(502, { error: 'ai_failed' });
      }
    });
    return;
  }
  json(200, { ok: true, online: online.size, rooms: rooms.size, ai: !!GEMINI_KEY, cloud: !!pool });
});
const wss = new WebSocketServer({ server, maxPayload: 600 * 1024 });

const send = (ws, msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };
const both = (room, fn) => room.players.forEach((p, i) => p && send(p, fn(i)));
const profile = p => ({ name: p.name, avatar: p.avatar, title: p.title, color: p.color });
const clean = (s, n) => String(s || '').replace(/[<>]/g, '').slice(0, n);
const allReady = room => room.players.every(p => p && p.canReady);
const pub = p => ({ id: p.pid, name: p.name, avatar: p.avatar, title: p.title, color: p.color, status: p.room && p.room.state && p.room.state !== 'lobby' ? 'battle' : 'online' });

function newCode() {
  let c; do { c = String(1000 + Math.floor(Math.random() * 9000)); } while (rooms.has(c));
  return c;
}
function seat(room, ws, slot) {
  ws.slot = slot; ws.room = room; ws.token = ws.token || crypto.randomBytes(12).toString('hex');
  room.players[slot] = ws;
}

function startMatch(room) {
  room.state = 'prep'; room.scores = [0, 0]; room.qi = -1; room.questions = null; room.rematch = [false, false]; room.lastReveal = null; room.end = null;
  room.grace = room.grace || [null, null];
  room.players.forEach((p, i) => seat(room, p, i));
  both(room, i => ({ type: 'matched', code: room.code, token: room.players[i].token, you: i, host: i === 0, opp: profile(room.players[1 - i]) }));
  spec(room, specSnapshot(room));
}

function nextQuestion(room) {
  clearTimeout(room.timer);
  room.qi++;
  if (room.qi >= room.questions.length) return endMatch(room);
  room.state = 'question'; room.answers = [null, null]; room.t0 = Date.now();
  const q = room.questions[room.qi];
  both(room, () => ({ type: 'q', qi: room.qi, total: room.questions.length, limit: LIMIT_MS, q: { q: q.q, o: q.o, svg: q.svg || '', t: q.t } }));
  spec(room, { type: 'q', qi: room.qi, total: room.questions.length, limit: LIMIT_MS, q: { q: q.q, o: q.o, svg: q.svg || '', t: q.t } });
  room.timer = setTimeout(() => reveal(room), LIMIT_MS + 300);
}

function reveal(room) {
  if (room.state !== 'question') return;
  clearTimeout(room.timer);
  room.state = 'reveal';
  const q = room.questions[room.qi];
  const gained = room.answers.map(a => (a && a.i === q.a) ? Math.round(500 + 500 * Math.max(0, 1 - a.ms / LIMIT_MS)) : 0);
  room.scores = room.scores.map((s, i) => s + gained[i]);
  room.ready = [false, false];
  room.lastReveal = { type: 'reveal', auto: !allReady(room), qi: room.qi, last: room.qi === room.questions.length - 1, a: q.a, e: q.e || '', picks: room.answers.map(a => a ? a.i : -1), gained, scores: room.scores };
  both(room, () => room.lastReveal); spec(room, room.lastReveal);
  // Weiter erst, wenn beide die Lösung gelesen haben (oder nach 5 Minuten). Alte App-Versionen: nach 5 s.
  room.timer = setTimeout(() => nextQuestion(room), allReady(room) ? READY_MS : 5000);
}

function endMatch(room) {
  room.state = 'end';
  const [a, b] = room.scores;
  room.end = { type: 'end', scores: room.scores, winner: a === b ? -1 : (a > b ? 0 : 1) };
  both(room, () => room.end); spec(room, room.end);
}

// ================= Bots =================
// Leicht: oft falsch und langsam, Mittel: solide, Schwer: fast immer richtig und schnell
const BOT_LEVEL = { easy: { p: 0.45, min: 7000, max: 15000, label: 'leicht' }, medium: { p: 0.72, min: 4000, max: 10000, label: 'mittel' }, hard: { p: 0.92, min: 1800, max: 5500, label: 'schwer' } };
const BOT_NAMES = ['Methan-Max', 'Ethan-Emma', 'Propan-Paul', 'Butan-Bella', 'Pentan-Pia', 'Hexan-Hugo', 'Heptan-Hanna', 'Octan-Otto'];
const BOT_AVATARS = ['robot', 'alien', 'owl', 'penguin', 'fox', 'panda'];
function makeBot(room, level) {
  const L = BOT_LEVEL[level] ? level : 'medium';
  const used = new Set(room.players.filter(Boolean).map(p => p.name));
  const name = (BOT_NAMES.find(n => !used.has('🤖 ' + n)) || 'Bot');
  return { isBot: true, level: L, name: '🤖 ' + name, avatar: BOT_AVATARS[Math.floor(Math.random() * BOT_AVATARS.length)], title: 'Bot (' + BOT_LEVEL[L].label + ')', color: 'std', readyState: 0, token: crypto.randomBytes(12).toString('hex'), send() {}, terminate() {} };
}
function botsAnswer(room) {
  const qi = room.qi, q = room.questions[qi];
  room.players.forEach((p, slot) => {
    if (!p || !p.isBot) return;
    const L = BOT_LEVEL[p.level];
    const delay = L.min + Math.random() * (L.max - L.min);
    setTimeout(() => {
      if (room.state !== 'question' || room.qi !== qi || room.answers[slot] || room.players[slot] !== p) return;
      const right = Math.random() < L.p;
      const wrong = q.o.map((_, i) => i).filter(i => i !== q.a);
      room.answers[slot] = { i: right || !wrong.length ? q.a : wrong[Math.floor(Math.random() * wrong.length)], ms: Date.now() - room.t0 };
      tCheckAnswers(room);
    }, Math.min(delay, LIMIT_MS - 300));
  });
}

// ================= Zuschauer =================
function spec(room, msg) { if (room.spectators) room.spectators.forEach(w => send(w, msg)); }
function specCount(room) { const n = room.spectators ? room.spectators.size : 0; room.players.forEach(p => p && send(p, { type: 'specs', n })); }
function specSnapshot(room) {
  const st = { type: 'spec_start', team: !!room.team, code: room.code, state: room.state, total: room.questions ? room.questions.length : 10 };
  st.players = room.team ? tPlayers(room) : room.players.map((p, i) => p ? { ...profile(p), slot: i } : null);
  st.scores = room.team ? (room.pscores || []) : (room.scores || [0, 0]);
  if (room.team && room.pscores) st.tscores = tScores(room);
  if (room.state === 'question') { const q = room.questions[room.qi]; Object.assign(st, { qi: room.qi, limit: LIMIT_MS, elapsed: Date.now() - room.t0, q: { q: q.q, o: q.o, svg: q.svg || '', t: q.t }, answered: room.answers.map(a => !!a) }); }
  if (room.state === 'reveal') Object.assign(st, { qi: room.qi, reveal: room.lastReveal });
  if (room.state === 'end') st.end = room.end;
  if (room.state === 'countdown') st.startIn = Math.max(0, START_MS - (Date.now() - room.cdStart));
  return st;
}
function unwatch(ws) { const r = ws.watching; if (!r) return; ws.watching = null; if (r.spectators) { r.spectators.delete(ws); specCount(r); } }

// ================= Team-Battles (2 gegen 2, 3 gegen 3) =================
const tAll = (room, msg) => room.players.forEach(p => p && send(p, typeof msg === 'function' ? msg(p) : msg));
const tActive = room => room.players.filter(p => p && !p.away);
const tCount = (room, team) => room.players.filter((p, i) => p && room.teams[i] === team).length;
const tPlayers = room => room.players.map((p, i) => p ? { ...profile(p), slot: i, team: room.teams[i], away: !!p.away, host: i === room.hostSlot, bot: !!p.isBot, level: p.level } : null);
function tLobby(room) { tAll(room, p => ({ type: 'tlobby', code: room.code, size: room.size, you: p.slot, host: p.slot === room.hostSlot, token: p.token, players: tPlayers(room) })); }
function tPlayersUpdate(room) { tAll(room, { type: 'tplayers', players: tPlayers(room), host: room.hostSlot }); spec(room, { type: 'tplayers', players: tPlayers(room) }); }
function tSeat(room, ws) {
  let slot = room.players.findIndex(p => !p); if (slot < 0) slot = room.players.length;
  room.players[slot] = null;
  const team = tCount(room, 0) <= tCount(room, 1) ? 0 : 1;      // ins kleinere Team
  room.players[slot] = ws; room.teams[slot] = team;
  ws.slot = slot; ws.room = room; ws.away = false; ws.token = ws.token || crypto.randomBytes(12).toString('hex');
}
function tStartPrep(room) {
  room.state = 'prep'; room.qi = -1; room.questions = null; room.lastReveal = null; room.end = null;
  room.pscores = room.players.map(() => 0);
  tAll(room, p => ({ type: 'tprep', host: p.slot === room.hostSlot, size: room.size, you: p.slot, code: room.code, token: p.token, players: tPlayers(room) }));
}
function tNext(room) {
  clearTimeout(room.timer);
  room.qi++;
  if (room.qi >= room.questions.length) return tEnd(room);
  room.state = 'question'; room.answers = room.players.map(() => null); room.t0 = Date.now();
  const q = room.questions[room.qi];
  tAll(room, { type: 'q', qi: room.qi, total: room.questions.length, limit: LIMIT_MS, q: { q: q.q, o: q.o, svg: q.svg || '', t: q.t } });
  botsAnswer(room);
  spec(room, { type: 'q', qi: room.qi, total: room.questions.length, limit: LIMIT_MS, q: { q: q.q, o: q.o, svg: q.svg || '', t: q.t } });
  room.timer = setTimeout(() => tReveal(room), LIMIT_MS + 300);
}
const tScores = room => [0, 1].map(t => room.pscores.reduce((s, v, i) => s + (room.players[i] && room.teams[i] === t ? v : 0), 0));
function tCheckAnswers(room) {
  const act = tActive(room), done = act.filter(p => room.answers[p.slot]).length;
  tAll(room, { type: 'tanswered', count: done, total: act.length }); spec(room, { type: 'spec_answered', answered: room.answers.map(a => !!a) });
  if (act.length && done >= act.length) tReveal(room);
}
function tReveal(room) {
  if (room.state !== 'question') return;
  clearTimeout(room.timer); room.state = 'reveal';
  const q = room.questions[room.qi];
  const gained = room.answers.map(a => (a && a.i === q.a) ? Math.round(500 + 500 * Math.max(0, 1 - a.ms / LIMIT_MS)) : 0);
  room.pscores = room.pscores.map((s, i) => s + (gained[i] || 0));
  room.ready = room.players.map(p => !!(p && p.isBot));
  room.lastReveal = { type: 'treveal', qi: room.qi, last: room.qi === room.questions.length - 1, a: q.a, e: q.e || '', picks: room.answers.map(a => a ? a.i : -1), gained, pscores: room.pscores, tscores: tScores(room), players: tPlayers(room) };
  tAll(room, room.lastReveal); spec(room, room.lastReveal);
  room.timer = setTimeout(() => tNext(room), READY_MS);
}
function tCheckReady(room) {
  const act = tActive(room), done = act.filter(p => room.ready[p.slot]).length;
  tAll(room, { type: 'tready', count: done, total: act.length });
  if (act.length && done >= act.length) tNext(room);
}
function tEnd(room) {
  clearTimeout(room.timer); room.state = 'end';
  const ts = tScores(room);
  let mvp = -1; room.pscores.forEach((v, i) => { if (room.players[i] && (mvp < 0 || v > room.pscores[mvp])) mvp = i; });
  room.end = { type: 'tend', tscores: ts, pscores: room.pscores, winner: ts[0] === ts[1] ? -1 : (ts[0] > ts[1] ? 0 : 1), mvp, players: tPlayers(room) };
  tAll(room, room.end); spec(room, room.end);
}
function tRemove(room, ws) {
  const slot = room.players.indexOf(ws); if (slot < 0) return;
  room.players[slot] = null; ws.room = null; clearTimeout((room.grace || [])[slot]);
  if (!room.players.some(p => p && !p.isBot)) { clearTimeout(room.timer); rooms.delete(room.code); spec(room, { type: 'spec_end' }); return; }
  if (room.hostSlot === slot) room.hostSlot = room.players.findIndex(p => p && !p.isBot);
  if (room.state === 'lobby' || room.state === 'end') return tLobbyOrUpdate(room);
  tAll(room, { type: 'tleft', name: ws.name });
  tPlayersUpdate(room);
  if (room.state === 'prep') { const h = room.players[room.hostSlot]; if (h) send(h, { type: 'tprep', host: true, players: tPlayers(room) }); }
  if (room.state === 'question') tCheckAnswers(room);
  if (room.state === 'reveal') tCheckReady(room);
}
function tLobbyOrUpdate(room) { if (room.state === 'lobby') tLobby(room); else tPlayersUpdate(room); }
function tDropped(room, ws) {
  const slot = ws.slot;
  ws.away = true; room.grace = room.grace || [];
  clearTimeout(room.grace[slot]);
  tPlayersUpdate(room);
  if (room.state === 'question') tCheckAnswers(room);
  if (room.state === 'reveal') tCheckReady(room);
  room.grace[slot] = setTimeout(() => { if (room.players[slot] === ws) tRemove(room, ws); }, GRACE_MS);
}
function tResume(ws, room, slot) {
  const st = { type: 'resume_ok', team: true, code: room.code, token: ws.token, you: slot, host: slot === room.hostSlot, size: room.size, state: room.state, players: tPlayers(room),
    pscores: room.pscores || [], tscores: room.pscores ? tScores(room) : [0, 0], total: room.questions ? room.questions.length : 10 };
  if (room.state === 'countdown') st.startIn = Math.max(0, START_MS - (Date.now() - room.cdStart));
  if (room.state === 'question') {
    const q = room.questions[room.qi];
    Object.assign(st, { qi: room.qi, limit: LIMIT_MS, elapsed: Date.now() - room.t0, q: { q: q.q, o: q.o, svg: q.svg || '', t: q.t }, myPick: room.answers[slot] ? room.answers[slot].i : -1 });
  }
  if (room.state === 'reveal') Object.assign(st, { qi: room.qi, reveal: room.lastReveal, myReady: room.ready[slot] });
  if (room.state === 'end') st.end = room.end;
  send(ws, st);
  tPlayersUpdate(room);
  if (room.state === 'lobby') tLobby(room);
}

function closeRoom(room, except) {
  clearTimeout(room.timer); (room.grace || []).forEach(t => clearTimeout(t));
  room.players.forEach(p => { if (p && p !== except) { p.room = null; send(p, { type: 'opp_left' }); } });
  rooms.delete(room.code);
  spec(room, { type: 'spec_end' }); if (room.spectators) room.spectators.forEach(w => { w.watching = null; });
}

// Bewusst verlassen (Knopf, anderer Tab): sofort raus
function leave(ws) {
  if (waiting === ws) waiting = null;
  const room = ws.room; if (!room) return;
  if (room.team) return tRemove(room, ws);
  ws.room = null;
  closeRoom(room, ws);
}

// Verbindung abgerissen (App im Hintergrund): Platz freihalten
function dropped(ws) {
  if (waiting === ws) waiting = null;
  const room = ws.room; if (!room || !rooms.has(room.code)) return;
  const slot = ws.slot;
  if (room.players[slot] !== ws) return;          // schon durch neue Verbindung ersetzt
  if (room.team) return tDropped(room, ws);
  room.grace = room.grace || [null, null];
  clearTimeout(room.grace[slot]);
  send(room.players[1 - slot], { type: 'opp_away' });
  room.grace[slot] = setTimeout(() => { if (room.players[slot] === ws) closeRoom(room, ws); }, GRACE_MS);
}

function resume(ws, m) {
  const room = rooms.get(clean(m.code, 4));
  const slot = room ? room.players.findIndex(p => p && p.token && p.token === m.token) : -1;
  if (!room || slot < 0) return send(ws, { type: 'resume_fail' });
  const old = room.players[slot];
  ws.token = old.token; ws.name = old.name; ws.avatar = old.avatar; ws.title = old.title; ws.color = old.color; ws.canReady = old.canReady;
  old.room = null; try { old.terminate(); } catch {}
  if (room.team) { room.players[slot] = ws; ws.slot = slot; ws.room = room; ws.away = false; clearTimeout((room.grace || [])[slot]); return tResume(ws, room, slot); }
  seat(room, ws, slot);
  clearTimeout((room.grace || [])[slot]);
  const other = room.players[1 - slot];
  send(other, { type: 'opp_back' });
  const st = { type: 'resume_ok', code: room.code, token: ws.token, you: slot, host: slot === 0, state: room.state || 'lobby', scores: room.scores || [0, 0], total: room.questions ? room.questions.length : 10 };
  if (other) st.opp = profile(other);
  if (room.state === 'countdown') st.startIn = Math.max(0, START_MS - (Date.now() - room.cdStart));
  if (room.state === 'question') {
    const q = room.questions[room.qi];
    Object.assign(st, { qi: room.qi, limit: LIMIT_MS, elapsed: Date.now() - room.t0, q: { q: q.q, o: q.o, svg: q.svg || '', t: q.t },
      myPick: room.answers[slot] ? room.answers[slot].i : -1, oppDone: !!room.answers[1 - slot] });
  }
  if (room.state === 'reveal') Object.assign(st, { qi: room.qi, reveal: room.lastReveal, myReady: room.ready[slot], oppReady: room.ready[1 - slot] });
  if (room.state === 'end') st.end = room.end;
  send(ws, st);
}

wss.on('connection', ws => {
  ws.name = 'Spieler'; ws.avatar = 'scientist'; ws.title = 'Neuling'; ws.color = 'std'; ws.alive = true;
  ws.lastPong = Date.now();
  ws.on('pong', () => { ws.alive = true; ws.lastPong = Date.now(); });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const room = ws.room;
    switch (m.type) {
      case 'hello':
        ws.named = !!clean(m.name, 16).trim(); ws.name = clean(m.name, 16) || 'Spieler'; ws.avatar = clean(m.avatar, 20) || 'scientist'; ws.title = clean(m.title, 30) || 'Neuling';
        ws.color = clean(m.color, 12) || 'std'; ws.canReady = m.ready === true;
        if (/^[a-f0-9]{16,32}$/.test(m.id || '')) {
          ws.pid = m.id;
          online.set(ws.pid, ws);   // pro Spieler-ID zählt nur die neueste Verbindung
        }
        send(ws, { type: 'hi', online: online.size });
        break;
      case 'resume': resume(ws, m); break;
      case 'who': {
        // alle, die gerade die App offen haben (ohne einen selbst)
        // gleiche Person (Name + Avatar) nur einmal, tote Verbindungen weglassen
        const seen = new Set(), list = [];
        [...online.values()].filter(p => p !== ws && p.readyState === 1 && p.named && p.pid !== ws.pid && Date.now() - (p.lastPong || 0) < 40000)
          .sort((a, b) => (b.room ? 1 : 0) - (a.room ? 1 : 0)).forEach(p => { const k = p.name.toLowerCase() + '|' + p.avatar; if (k === (ws.name || '').toLowerCase() + '|' + ws.avatar || seen.has(k)) return; seen.add(k); list.push(pub(p)); });
        const ids = Array.isArray(m.friends) ? m.friends.slice(0, 300) : [];
        send(ws, { type: 'who', list, friendsOnline: ids.filter(id => online.has(id)) });
        break;
      }
      case 'friend_req': case 'friend_ok': case 'friend_no': case 'invite': case 'invite_no': {
        const to = online.get(String(m.to || ''));
        if (!to || !ws.pid) return send(ws, { type: 'error_soft', msg: 'Der Spieler ist gerade nicht online.' });
        if (m.type === 'invite' && to.room && to.room.state && to.room.state !== 'lobby') return send(ws, { type: 'error_soft', msg: to.name + ' ist gerade in einem Battle.' });
        send(to, { type: m.type, from: pub(ws) });
        break;
      }
      case 'invite_ok': {
        // Herausforderung angenommen: beide in einen neuen Raum
        const from = online.get(String(m.to || ''));
        if (!from || from.readyState !== 1 || (from.room && from.room.state && from.room.state !== 'lobby'))
          return send(ws, { type: 'error_soft', msg: 'Die Herausforderung ist nicht mehr gültig.' });
        leave(from); leave(ws);
        const code = newCode(); const r = { code, players: [from, ws] }; rooms.set(code, r); startMatch(r);
        break;
      }
      case 'quick':
        leave(ws);
        if (waiting && waiting !== ws && waiting.readyState === 1) {
          const code = newCode(); const r = { code, players: [waiting, ws] }; rooms.set(code, r); waiting = null; startMatch(r);
        } else { waiting = ws; send(ws, { type: 'searching' }); }
        break;
      case 'create': {
        leave(ws);
        const code = newCode(); const r = { code, players: [null, null], state: 'lobby', grace: [null, null] };
        rooms.set(code, r); seat(r, ws, 0); send(ws, { type: 'room', code, token: ws.token });
        break;
      }
      case 'watch': {
        const to = online.get(String(m.to || ''));
        const r = to && to.room;
        if (!r || !rooms.has(r.code) || r.state === 'lobby') return send(ws, { type: 'error_soft', msg: 'Dieser Spieler ist gerade in keinem Battle.' });
        if (r.players.includes(ws)) return;
        unwatch(ws); leave(ws);
        r.spectators = r.spectators || new Set(); r.spectators.add(ws); ws.watching = r;
        send(ws, specSnapshot(r)); specCount(r);
        break;
      }
      case 'unwatch': unwatch(ws); break;
      case 'tbot': {   // Raum-Ersteller fügt einen Bot hinzu (ins kleinere Team)
        if (!room || !room.team || room.state !== 'lobby' || ws.slot !== room.hostSlot) return;
        if (room.players.filter(Boolean).length >= room.size * 2) return send(ws, { type: 'error_soft', msg: 'Der Raum ist schon voll.' });
        const bot = makeBot(room, m.level); tSeat(room, bot); tLobby(room);
        break;
      }
      case 'tkick': {  // Bot wieder entfernen
        if (!room || !room.team || room.state !== 'lobby' || ws.slot !== room.hostSlot) return;
        const b = room.players[m.slot | 0]; if (b && b.isBot) { room.players[m.slot | 0] = null; tLobby(room); }
        break;
      }
      case 'botduel': {  // 1 gegen 1 gegen einen Bot: sofort los
        leave(ws);
        const code = newCode(); const r = { code, team: true, size: 1, players: [], teams: [], state: 'lobby', hostSlot: 0, grace: [] };
        rooms.set(code, r); tSeat(r, ws); tSeat(r, makeBot(r, m.level));
        tStartPrep(r);
        break;
      }
      case 'tcreate': {
        const size = m.size === 3 ? 3 : 2;
        leave(ws);
        const code = newCode(); const r = { code, team: true, size, players: [], teams: [], state: 'lobby', hostSlot: 0, grace: [] };
        rooms.set(code, r); tSeat(r, ws); tLobby(r);
        break;
      }
      case 'tswitch':
        if (!room || !room.team || room.state !== 'lobby') return;
        { const other = 1 - room.teams[ws.slot]; if (tCount(room, other) >= room.size) return send(ws, { type: 'error_soft', msg: 'Das andere Team ist schon voll.' }); room.teams[ws.slot] = other; tLobby(room); }
        break;
      case 'tstart':
        if (!room || !room.team || room.state !== 'lobby' || ws.slot !== room.hostSlot) return;
        { const a = tCount(room, 0), b = tCount(room, 1);
          if (!a || !b || a !== b) return send(ws, { type: 'error_soft', msg: 'Beide Teams müssen gleich groß sein (mindestens 1 Spieler pro Team).' });
          tStartPrep(room); }
        break;
      case 'tinvite': {
        const to = online.get(String(m.to || ''));
        if (!room || !room.team || room.state !== 'lobby') return;
        if (!to) return send(ws, { type: 'error_soft', msg: 'Der Spieler ist gerade nicht online.' });
        if (to.room && to.room.state && to.room.state !== 'lobby') return send(ws, { type: 'error_soft', msg: to.name + ' ist gerade in einem Battle.' });
        send(to, { type: 'tinvite', from: pub(ws), code: room.code, size: room.size });
        break;
      }
      case 'join': {
        const tr = rooms.get(clean(m.code, 4));
        if (tr && tr.team) {
          if (tr.players.includes(ws)) return tLobby(tr);
          if (tr.state !== 'lobby') return send(ws, { type: 'error', msg: 'Das Team-Battle läuft schon.' });
          if (tr.players.filter(Boolean).length >= tr.size * 2) return send(ws, { type: 'error', msg: 'Der Raum ist schon voll.' });
          leave(ws); tSeat(tr, ws); tLobby(tr);
          break;
        }
        const r = rooms.get(clean(m.code, 4));
        if (!r || r.state !== 'lobby' || r.players[1]) return send(ws, { type: 'error', msg: 'Raum nicht gefunden oder schon voll.' });
        if (r.players[0] === ws) return;
        leave(ws); r.players[1] = ws; startMatch(r);
        break;
      }
      case 'cancel': leave(ws); send(ws, { type: 'cancelled' }); break;
      case 'questions':
        if (!room || ws.slot !== (room.team ? room.hostSlot : 0) || room.state !== 'prep' || !Array.isArray(m.list)) return;
        room.questions = m.list.slice(0, 15).map(q => ({ q: String(q.q).slice(0, 2000), o: (q.o || []).slice(0, 4).map(x => String(x).slice(0, 4000)), a: q.a | 0, e: String(q.e || '').slice(0, 2000), svg: String(q.svg || '').slice(0, 60000), t: q.t | 0 }));
        if (!room.questions.length) return;
        room.state = 'countdown'; room.cdStart = Date.now();
        both(room, () => ({ type: 'start', in: START_MS, total: room.questions.length })); spec(room, { type: 'start', in: START_MS, total: room.questions.length });
        room.timer = setTimeout(() => room.team ? tNext(room) : nextQuestion(room), START_MS);
        break;
      case 'answer':
        if (!room || room.state !== 'question' || m.qi !== room.qi || room.answers[ws.slot]) return;
        room.answers[ws.slot] = { i: m.i | 0, ms: Date.now() - room.t0 };
        if (room.team) { tCheckAnswers(room); break; }
        send(room.players[1 - ws.slot], { type: 'opp_answered' }); spec(room, { type: 'spec_answered', answered: room.answers.map(a => !!a) });
        if (room.answers[0] && room.answers[1]) reveal(room);
        break;
      case 'ready':
        if (!room || room.state !== 'reveal' || m.qi !== room.qi || room.ready[ws.slot]) return;
        room.ready[ws.slot] = true;
        if (room.team) { tCheckReady(room); break; }
        send(room.players[1 - ws.slot], { type: 'opp_ready' });
        if (room.ready[0] && room.ready[1]) nextQuestion(room);
        break;
      case 'emote':
        if (room && EMOTES.has(m.e)) { both(room, () => ({ type: 'emote', from: ws.slot, e: m.e })); spec(room, { type: 'emote', from: ws.slot, e: m.e }); }
        break;
      case 'rematch':
        if (!room || room.state !== 'end') return;
        if (room.team) { if (ws.slot !== room.hostSlot) return; room.state = 'lobby'; room.players.forEach((p, i) => { if (p && p.away) tRemove(room, p); }); tLobby(room); break; }
        room.rematch[ws.slot] = true;
        send(room.players[1 - ws.slot], { type: 'opp_rematch' });
        if (room.rematch[0] && room.rematch[1]) startMatch(room);
        break;
      case 'leave': leave(ws); break;
    }
  });
  ws.on('close', () => { if (ws.pid && online.get(ws.pid) === ws) online.delete(ws.pid); unwatch(ws); dropped(ws); });
});

// Verbindungen am Leben halten, tote Verbindungen aufräumen
setInterval(() => wss.clients.forEach(ws => { if (!ws.alive) return ws.terminate(); ws.alive = false; ws.ping(); }), 15000);

server.listen(PORT, () => {
  console.log('Alkane Battle läuft auf Port ' + PORT);
  // Beim Start: schnellstes Modell auswählen, Ergebnis steht im Log
  if (GEMINI_KEY) pickModel();
  initDb();
  if (false) {
    const t0 = Date.now();
    geminiStream([{ role: 'user', text: 'Antworte nur mit: OK' }], () => {})
      .then(t => console.log('KI-Selbsttest ok nach', Date.now() - t0, 'ms, Modell', GEMINI_MODEL, ':', JSON.stringify(t.slice(0, 40))))
      .catch(e => console.log('KI-Selbsttest fehlgeschlagen nach', Date.now() - t0, 'ms:', e.name, e.message, e.cause && (e.cause.code || e.cause.message || '')));
  }
});
