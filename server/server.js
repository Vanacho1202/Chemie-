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
const EMOTES = new Set(['fire','wave','gg','laugh','cool','mind','skull','flask','crown','cold','salute','cry','nerd','alembic','goat','muscle','eyes','clap','heart','rocket','brain','sleep','party','angry','think','ghost','hundred','bolt','atom','sweat','clown','devil','star','trophy','popcorn','snail','buch','feder','maske','krug','waage','rolle','luege','wein','katze','fuss','lupe','schock']);

const rooms = new Map();     // code -> room
const waitingBy = new Map();  // Schnellsuche: Fach -> wartender Spieler (Chemie und Deutsch getrennt)
const online = new Map();    // Spieler-ID -> aktuelle Verbindung (wer gerade die App offen hat)
// online = Verbindung offen, App im Vordergrund, letzte Antwort frisch
const isLive = p => !!p && p.readyState === 1 && !p.away && Date.now() - (p.lastPong || 0) < 12000;
// Status hat sich geändert: alle kurz benachrichtigen, damit Listen sofort aktualisieren (gebündelt)
let presT = null;
function presence() { if (presT) return; presT = setTimeout(() => { presT = null; wss.clients.forEach(c => { if (c.readyState === 1 && c.pid) send(c, { type: 'pres' }); }); }, 300); }

// ---------- Cloud-Spielstand (Postgres) ----------
let pool = null;
const BANS = new Map();   // Spieler-ID -> { until (ms), reason }
const banOf = pid => { const b = BANS.get(pid); if (b && b.until > Date.now()) return b; if (b) BANS.delete(pid); return null; };
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
    await pool.query(`create table if not exists bans (pid text primary key, until timestamptz not null, reason text, created_at timestamptz not null default now())`);
    const b = await pool.query('select pid, until, reason from bans where until > now()');
    b.rows.forEach(r => BANS.set(r.pid, { until: new Date(r.until).getTime(), reason: r.reason || '' }));
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
const ADMIN_PIDS = (process.env.ADMIN_PIDS || '05ea7edd8086cbd1712f,d93cc5ca02dc3647d3d0').split(',').map(x => x.trim()).filter(Boolean);
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
    const r = await pool.query(`select pid, name, code, (data->>'coins')::int as coins, data->'eq' as eq, (select coalesce(array_agg(k), '{}') from jsonb_object_keys(coalesce(data->'owned', '{}'::jsonb)) k) as owned, updated_at from saves order by updated_at desc limit 300`);
    const known = new Set(r.rows.map(x => x.pid));
    const banInfo = pid => { const b = banOf(pid); return b ? new Date(b.until).toISOString() : null; };
    const list = r.rows.map(x => ({ id: x.pid, name: x.name || '', code: x.code, coins: x.coins, avatar: x.eq && x.eq.avatar, owned: x.owned, updated: x.updated_at, online: online.has(x.pid), banned: banInfo(x.pid) }));
    // online, aber noch nie gespeichert
    for (const [pid, ws] of online) if (!known.has(pid) && ws.readyState === 1) list.unshift({ id: pid, name: ws.name || '', code: null, coins: null, avatar: ws.avatar, owned: null, updated: null, online: true, banned: banInfo(pid) });
    return [200, { players: list }];
  }
  const target = String(m.target || '');
  if (!PID.test(target)) return [400, { error: 'Ungültige Spieler-ID.' }];
  if (path === '/admin/gift') {
    const coins = Math.max(-1000000, Math.min(1000000, parseInt(m.coins, 10) || 0));
    const name = m.name ? String(m.name).replace(/[<>]/g, '').trim().slice(0, 16) : null;
    const items = Array.isArray(m.items) ? m.items.map(String).filter(x => /^[eatc]_[^<>"]{1,40}$/.test(x)).slice(0, 300) : [];
    const remove = Array.isArray(m.removeItems) ? m.removeItems.map(String).filter(x => /^[eatc]_[^<>"]{1,40}$/.test(x)).slice(0, 300) : [];
    const extra = {}; if (items.length) extra.items = items; if (m.allItems) extra.allItems = true;
    if (remove.length) extra.removeItems = remove; if (m.removeAll) extra.removeAll = true;
    if (remove.length || m.removeAll) extra.minv = 3;   // nur Apps ab 3.4 verstehen das
    if (!coins && !name && !items.length && !m.allItems && !remove.length && !m.removeAll) return [400, { error: 'Nichts zu ändern.' }];
    if (name && await nameTaken(name, target)) return [409, { error: 'Name bereits vergeben.' }];
    await pool.query('insert into gifts (pid, coins, name, note, extra) values ($1,$2,$3,$4,$5)', [target, coins, name, 'Admin', Object.keys(extra).length ? extra : null]);
    const ws = online.get(target); if (ws) send(ws, { type: 'gift' });
    console.log('Admin-Geschenk an', target.slice(0, 8), { coins, name, items: items.length, all: !!m.allItems });
    return [200, { ok: true, live: !!ws }];
  }
  if (path === '/admin/ban') {
    const secs = Math.max(1, Math.min(10 * 365 * 86400, parseInt(m.seconds, 10) || 0));
    const reason = String(m.reason || '').replace(/[<>]/g, '').slice(0, 100);
    const until = new Date(Date.now() + secs * 1000);
    await pool.query('insert into bans (pid, until, reason) values ($1,$2,$3) on conflict (pid) do update set until = excluded.until, reason = excluded.reason, created_at = now()', [target, until, reason]);
    BANS.set(target, { until: until.getTime(), reason });
    const ws = online.get(target);
    if (ws) { send(ws, { type: 'banned', until: until.toISOString(), reason }); setTimeout(() => { try { ws.close(); } catch {} }, 300); }
    console.log('Admin-Bann', target.slice(0, 8), secs, 's');
    return [200, { ok: true, until: until.toISOString() }];
  }
  if (path === '/admin/unban') {
    await pool.query('delete from bans where pid = $1', [target]); BANS.delete(target);
    return [200, { ok: true }];
  }
  if (path === '/admin/kick') {
    const ws = online.get(target); if (!ws) return [404, { error: 'Nicht online.' }];
    send(ws, { type: 'error_soft', msg: 'Du wurdest vom Admin getrennt.' }); setTimeout(() => { try { ws.close(); } catch {} }, 300);
    return [200, { ok: true }];
  }
  return [404, { error: 'unbekannt' }];
}
// Namen sind einmalig (Groß/Klein egal): gespeicherte Spielstände und gerade verbundene Spieler
async function nameTaken(name, pid) {
  const n = String(name || '').trim().toLowerCase(); if (!n) return false;
  for (const [id, ws] of online) if (id !== pid && ws.named && String(ws.name || '').trim().toLowerCase() === n) return true;
  if (!pool) return false;
  const r = await pool.query('select 1 from saves where lower(trim(name)) = $1 and pid <> $2 limit 1', [n, String(pid || '')]);
  return r.rows.length > 0;
}
async function cloudRoute(path, m) {
  if (!pool) return [503, { error: 'Cloud-Speicher ist noch nicht eingerichtet.' }];
  if (path === '/cloud/name') {
    if (!HEX.test(m.pid || '')) return [400, { error: 'bad' }];
    return [200, { ok: !(await nameTaken(String(m.name || '').slice(0, 16), m.pid)) }];
  }
  if (path === '/cloud/save') {
    if (!HEX.test(m.pid || '') || !HEX.test(m.secret || '') || typeof m.data !== 'object') return [400, { error: 'bad' }];
    const data = JSON.stringify(m.data); if (data.length > 200000) return [413, { error: 'zu groß' }];
    const wantName = String(m.data.name || '').slice(0, 16), taken = await nameTaken(wantName, m.pid);
    for (let i = 0; i < 3; i++) {
      try {
        const r = await pool.query(`insert into saves (pid, secret, code, name, data) values ($1,$2,$3,$4,$5)
          on conflict (pid) do update set data = excluded.data, name = coalesce(excluded.name, saves.name), updated_at = now() where saves.secret = excluded.secret
          returning code, updated_at`, [m.pid, m.secret, newSaveCode(), taken ? null : wantName, data]);
        if (!r.rows.length) return [403, { error: 'Falscher Schlüssel für diesen Spielstand.' }];
        return [200, { ok: true, code: r.rows[0].code, updated: r.rows[0].updated_at, nameTaken: taken || undefined, gifts: await takeGifts(m.pid, m) }];
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
const MODEL_CANDIDATES = (process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite,gemini-flash-lite-latest,gemini-3.1-flash-lite-preview').split(',').map(x => x.trim()).filter(Boolean);
let GEMINI_MODEL = MODEL_CANDIDATES[0];
// Schlaueres Modell für Alki und Karteikarten; bei Fehler oder Kontingent-Ende automatisch das schnelle Modell
const SMART_MODEL = process.env.GEMINI_SMART_MODEL || 'gemini-3-flash-preview';
let smartPauseUntil = 0;
const SYSTEM = `Du bist "Alki", ein freundlicher, kluger Chemie-Nachhilfelehrer in einer Lern-App.
Der Schüler (ca. 10. Klasse, Waldorfschule) lernt für eine Chemieklausur über Alkane. Themen:
1. Homologe Reihe der Alkane (CₙH₂ₙ₊₂, Methan bis Decan)
2. Verzweigte Alkane: Benennung nach IUPAC und Zeichnen
3. Isomerie (Konstitutionsisomere)
4. Elektronegativität und Polarität (polar, unpolar, Partialladungen δ+ und δ−)
5. Zwischenmolekulare Wechselwirkungen (Van-der-Waals-Kräfte, Dipol-Dipol, Wasserstoffbrücken)
6. Eigenschaften der Alkane (Löslichkeit, Siedetemperatur, Viskosität, Brennbarkeit) und ihre Veränderung in der Reihe
7. Formelschreibweisen (Summen-, Struktur-, Halbstruktur-, Skelettformel) und Definitionen

Fakten, die in der App gelten (nutze genau diese):
- Namen: Meth-, Eth-, Prop-, But-, Pent-, Hex-, Hept-, Oct-, Non-, Dec- + "-an". Siedetemperaturen ca.: Methan −162 °C, Ethan −89, Propan −42, Butan −1, Pentan 36, Hexan 69, Heptan 98, Octan 126, Nonan 151, Decan 174 °C. Bei 20 °C: C₁–C₄ gasförmig, ab C₅ flüssig.
- Seitenketten: Methyl- (–CH₃), Ethyl- (–C₂H₅), Propyl- (–C₃H₇), Butyl- (–C₄H₉). IUPAC: längste Kette = Stammname; so nummerieren, dass die Seitenketten möglichst kleine Nummern bekommen; gleiche Seitenketten mit di-, tri-, tetra-; Seitenketten alphabetisch (Vorsilben di/tri zählen nicht); Zahlen mit Komma trennen, Zahl und Wort mit Bindestrich, z. B. 2,3-Dimethylpentan.
- Isomere: gleiche Summenformel, andere Strukturformel und andere Eigenschaften. Butan hat 2, Pentan 3, Hexan 5, Heptan 9 Isomere.
- ΔEN: unter 0,5 unpolar, 0,5 bis 1,7 polar, über 1,7 ionisch. EN-Werte: H 2,2 · C 2,5 · N 3,0 · O 3,5 · F 4,0 · Cl 3,0. C–H ist praktisch unpolar, darum sind Alkane unpolar. Das elektronegativere Atom bekommt δ−. Ein Molekül ist ein Dipol, wenn es polare Bindungen hat UND die Ladungsschwerpunkte nicht zusammenfallen (CO₂ und CH₄ sind keine Dipole, H₂O und HCl schon).
- Van-der-Waals-Kräfte: Anziehung durch spontane (temporäre) und induzierte Dipole; je größer die Moleküloberfläche, desto stärker. Verzweigte Alkane haben eine kleinere Oberfläche als unverzweigte, deshalb niedrigere Siedetemperatur.
- Wasserstoffbrücken: zwischen einem H-Atom, das an ein stark elektronegatives Atom (F, O, N) gebunden ist, und einem freien Elektronenpaar von F, O oder N eines anderen Moleküls; stärkste der zwischenmolekularen Kräfte (Reihenfolge: Van-der-Waals < Dipol-Dipol < H-Brücken). Beispiel: Wasser hat deshalb eine hohe Siedetemperatur.
- Löslichkeit: "Ähnliches löst sich in Ähnlichem". Alkane sind hydrophob/lipophil: löslich in Benzin, Öl, Hexan; nicht in Wasser.
- Je länger die Kette, desto größer die Oberfläche, desto stärker die Van-der-Waals-Kräfte, desto höher Siedetemperatur und Viskosität.
- Bindungswinkel am C-Atom im Alkan: 109,5° (Tetraeder). Skelettformel: Zickzacklinie, jede Ecke und jedes Ende ist ein C-Atom, H-Atome werden weggelassen.

So antwortest du:
- Verstehe, was gemeint ist, auch bei Umgangssprache, Tippfehlern, Abkürzungen oder halben Sätzen (z. B. "was is homolog reihe", "wieso kocht hexan später", "check meine antwort"). Beantworte die gemeinte Frage direkt. Rückfragen nur, wenn wirklich unklar ist, was gemeint ist.
- Beginne mit der Antwort in einem Satz, dann kurz die Erklärung Schritt für Schritt mit einem konkreten Beispiel. Begründungen als Je-desto-Kette.
- Schickt der Schüler eine eigene Antwort oder Lösung, prüfe sie ehrlich: sag klar, was richtig und was falsch ist, und wie es richtig heißt. Lob nur, wenn es stimmt.
- Bei Rechen- oder Benennungsaufgaben: rechne bzw. benenne sauber Schritt für Schritt und kontrolliere dein Ergebnis, bevor du es nennst.
- Beziehe dich auf den bisherigen Chat (z. B. "und bei Pentan?" bezieht sich auf die letzte Frage).
- Deutsch mit ä, ö, ü und ß, locker und ermutigend, aber fachlich korrekt. Meist 60 bis 150 Wörter; mehr nur, wenn der Schüler es will oder die Aufgabe es braucht.
- Formeln mit Unicode-Tiefstellung, z. B. C₆H₁₄, CH₃–CH₂–CH₃.
- Formatierung nur so: **fett** für Fachbegriffe und Aufzählungen mit "- " am Zeilenanfang. Keine Tabellen, keine Überschriften.
- Wenn du dir unsicher bist, sag es ehrlich. Erfinde keine Fakten.
- Bei Fragen ohne Chemie-Bezug antworte kurz und lenke freundlich zurück zum Lernen.`;
const SYSTEM_DE = `Du bist "Alki", ein freundlicher, kluger Deutsch-Nachhilfelehrer in einer Lern-App.
Der Schüler (Oberstufe, Deutsch Grundkurs, Waldorfschule) schreibt am Donnerstag eine Klausur: Szenenanalyse bzw. Interpretation einer Szene aus Heinrich von Kleists Lustspiel "Der zerbrochne Krug". Er muss das Stück kennen, einordnen können und Figuren und Handlung verstehen.

Gesicherte Fakten (nutze genau diese, erfinde nichts dazu):
- Heinrich von Kleist, 1777–1811 (gest. am Wannsee). Weitere Werke: Michael Kohlhaas, Die Marquise von O…, Das Käthchen von Heilbronn, Prinz Friedrich von Homburg, Penthesilea, Amphitryon.
- Anstoß: 1802 in Bern ein französischer Kupferstich ("Le juge, ou la cruche cassée") bei Heinrich Zschokke; Wettstreit Zschokke / Ludwig Wieland / Kleist. Entstanden ca. 1802–1806.
- Uraufführung 2. März 1808, Weimarer Hoftheater, unter Goethe; Goethe teilte den Einakter in drei Akte, das zerstörte das Tempo; dazu ein zu langer Schluss: Misserfolg. Erstdruck 1811 Berlin; die lange Fassung des 12. Auftritts steht dort als "Variant" im Anhang.
- Lustspiel mit ernstem Kern; analytisches Drama nach dem Vorbild von Sophokles' "König Ödipus" (Unterschied: Adam weiß von Anfang an, dass er schuldig ist). Blankvers. Ein Akt, 13 Auftritte, rund 1974 Verse. Einheit von Ort (Gerichtsstube in Huisum, erfundenes Dorf bei Utrecht, Niederlande), Zeit (ein Vormittag, 1. Februar; Jahr nicht genannt, Ende 17. Jh.) und Handlung. Epoche: zwischen bzw. neben Klassik und Romantik (keiner eindeutig zuzuordnen).
- Figuren: Walter (Gerichtsrat aus Utrecht auf Revisionsreise), Adam (Dorfrichter, zehn Jahre im Amt, unverheiratet, Klumpfuß, Täter und Richter zugleich, Meister der Ausrede), Licht (Schreiber, ehrgeizig, will Richter werden, verwaltet am Ende vorläufig das Amt), Frau Marthe Rull (Klägerin, Eves Mutter, Witwe), Eve (ihre Tochter, Ruprechts Verlobte, von Adam erpresst), Veit Tümpel (Bauer), Ruprecht (sein Sohn, Eves Verlobter, eifersüchtig), Frau Brigitte (Ruprechts Muhme/Tante, Zeugin), Lebrecht (Flickschuster, tritt nicht auf), Mägde Liese und Grete, Büttel, Bedienter; erwähnt: Richter Pfaul in Holla, Perückenmacher Meister Mehl in Utrecht.
- Handlung: 1. Adam verletzt (Fuß, Wange, Nase, Auge), Ausrede: auf den "Ziegenbock" am Ofen gefallen; Licht: "Adamsfall"; Walter auf Revisionsreise, hat in Holla Richter Pfaul suspendiert. 2. Walter im Dorf; Perücke fehlt (Ausrede: Katze hat darin gejungt); Mägde: Adam kam gestern gegen elf ohne Perücke und blutend heim. 3. Adams Traum vom Selbstgericht. 4. Walter kommt: Auftrag des Obertribunals Utrecht; Adam hat fünf Kassen. 5. keine Leih-Perücke; Adam richtet kahlköpfig. 6. Parteien streiten (ohne Adam); Marthe: "Meint Er, dass die Justiz ein Töpfer ist?", "Dein guter Name lag in diesem Topfe"; Ruprecht löst die Verlobung ("Metze"). 7. Verhandlung (längster Auftritt): Adam erkennt die Parteien, bedrängt Eve heimlich (Attest, Batavia), Ausrede krankes Perlhuhn; will Ruprecht sofort verurteilen ("Welch ein gewaltsames Verfahren" – Walter); Marthes Krugbeschreibung (Übergabe der Niederlande durch Karl V. an Philipp) und Geschichte des Krugs; Ruprechts Bericht (Mann bei Eve, Tür eingetreten, Türklinke, Sand in die Augen, Verdacht auf Lebrecht); Adam verrät sich ("War's eine Klinke?"). 8. zwei Verse (Wasser/Wein). 9. Eves Befragung: Adams Versprecher "Leberecht", Eve entlastet Ruprecht und Lebrecht (Adam schickte Lebrecht mit dem Attest nach Utrecht), nennt keinen Namen; Brigitte als Zeugin gerufen. 10. Weinpause: Walter verhört Adam (Wunden, Kratzer, Perücke angeblich an der Kerze verbrannt), Adam verrät sich. 11. Brigitte bringt die Perücke (im Weinspalier unter Eves Fenster); Adam: Ruprecht für Meister Mehl mitgegeben; Brigitte sah einen kahlen Kerl mit Pferdefuß, Spur im Schnee (rechts Menschenfuß, links Pferdefuß) bis zu Adams Haus; Adam will die Synode in Den Haag nach dem Teufel fragen; Perücke passt; Adam verurteilt Ruprecht; Eve: "Der Richter Adam hat den Krug zerbrochen!"; Adam flieht. 12. Kurzfassung: Ruprecht bittet um Verzeihung, Eve nennt die Drohung "Nach Bantam" (Ostindien), Walter: "Der Brief ist falsch!", Truppen bleiben im Inland; Versöhnung; Veit: Hochzeit zu Pfingsten; Licht sieht Adam fliehen (Mauerschau); Adam suspendiert, Licht übernimmt vorläufig. Variant: Eve erzählt ausführlich (Attest, Batavia, nächtlicher Besuch), misstraut Walter, Münzszene (Beutel Gulden), Ruprecht dient ein Jahr in Utrecht, Walter kommt Pfingsten. 13. Marthe fragt nach dem Sitz der Regierung in Utrecht ("Am großen Markt", Dienstag und Freitag) und will weiterklagen.
- Themen/Motive: Wahrheit und Lüge; Recht, Justiz, Machtmissbrauch; Sündenfall (Adam, Eve, "Adamsfall"); Krug als Symbol (Eves Ehre, zerbrochenes Vertrauen/Verlobung, beschädigte Ordnung, Grenzen der Justiz); Teufelsmotiv (Klumpfuß/Pferdefuß, Glatze, Schwefel); Vertrauen (Eve–Ruprecht); Komik durch dramatische Ironie, Beiseitesprechen, Doppeldeutigkeiten, Versprecher, Situationskomik; hoher Blankvers mit derbem Inhalt.
- Szenenanalyse (Aufbau laut Unterricht): Einleitung (Titel, Autor, Entstehungszeit, Epoche, Ort, Zeit, Figuren, Thema, Deutungshypothese; TATZT-Formel) – Einordnung in den Zusammenhang (vorher/nachher) und Inhaltsangabe (Präsens, keine Zitate, indirekte Rede) – Überleitungssatz (Aspekte nennen) – Hauptteil, nur hier mit Zitaten und Versangaben: Gesprächsart, Gesprächsverhalten, Motive, Charakter und Gefühle, sprachliche Gestaltung (Wortwahl, Satzbau, Ellipsen, Fragen, Ausrufe, Wiederholungen, Ironie, Klimax, Hyperbel, Sprachniveau, Widersprüche) und dramatische Gestaltung (Regieanweisungen, Redeanteile symmetrisch/asymmetrisch) – Schluss (Zusammenfassung, Funktion der Szene im Drama). Linear vs. aspektgeleitet.

So antwortest du:
- Verstehe auch Umgangssprache, Tippfehler und halbe Sätze und beantworte die gemeinte Frage direkt; Rückfragen nur, wenn wirklich unklar.
- Beginne mit der Antwort in einem Satz, dann knapp erklären, mit Beispiel oder kurzem Zitat aus dem Stück.
- Schickt der Schüler einen eigenen Text (Einleitung, Analyse, Antwort), gib ehrliches, konkretes Feedback: was gut ist, was fehlt, wie man es besser formuliert.
- Zitiere nur Stellen, die du sicher kennst; sonst beschreibe sie mit eigenen Worten. Gib keine erfundenen Versnummern an.
- Wenn etwas umstritten oder nicht sicher belegt ist, sag das.
- Deutsch mit ä, ö, ü und ß, locker und ermutigend. Meist 60 bis 160 Wörter; mehr, wenn der Schüler es will.
- Formatierung nur so: **fett** für Fachbegriffe und Aufzählungen mit "- " am Zeilenanfang. Keine Tabellen, keine Überschriften.
- Bei Fragen ohne Bezug zum Fach antworte kurz und lenke freundlich zurück zum Lernen.`;
const systemFor = fach => fach === 'deutsch' ? SYSTEM_DE : SYSTEM;
const rate = new Map(); // IP -> [Zeitstempel]
function limited(ip, max = 20) {
  const now = Date.now(), list = (rate.get(ip) || []).filter(t => now - t < 60000);
  list.push(now); rate.set(ip, list);
  return list.length > max;
}
const thinkCfg = model => /gemini-3/.test(model) ? { thinkingLevel: 'minimal' } : { thinkingBudget: 0 };
function geminiBody(messages, model, smart, fach) {
  const contents = messages.slice(-16).map(m => ({ role: m.role === 'bot' ? 'model' : 'user', parts: [{ text: String(m.text || '').slice(0, 3000) }] }));
  const generationConfig = { temperature: smart ? 0.5 : 0.4, maxOutputTokens: smart ? 2500 : 900 };
  if (smart) generationConfig.thinkingConfig = { thinkingLevel: 'low' };            // kurz nachdenken = bessere Antworten
  else if (thinkingSupported) generationConfig.thinkingConfig = thinkCfg(model);    // schnell: kein langes Nachdenken
  return JSON.stringify({ system_instruction: { parts: [{ text: systemFor(fach) }] }, contents, generationConfig });
}
let thinkingSupported = true;   // falls das schnelle Modell die Denk-Einstellung ablehnt, ab dann ohne
// welche Modelle probieren: erst das schlaue, bei Problemen das schnelle
function modelPlan() { return (SMART_MODEL && SMART_MODEL !== GEMINI_MODEL && Date.now() > smartPauseUntil) ? [[SMART_MODEL, true], [GEMINI_MODEL, false]] : [[GEMINI_MODEL, false]]; }
function smartFailed(status, text) { if (status === 429 || status === 404 || status === 403) { smartPauseUntil = Date.now() + 15 * 60000; console.log('Schlaues Modell pausiert 15 min:', status, String(text).slice(0, 120)); } }
async function geminiStream(messages, onText, fach) {
  let r = null, lastErr = '';
  for (const [model, smart] of modelPlan()) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`;
    const once = () => httpsReq(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY }, body: geminiBody(messages, model, smart, fach), timeout: smart ? 25000 : 20000 });
    try {
      try { r = await once(); } catch (e) { console.log('Gemini nicht erreichbar, neuer Versuch:', e.name, e.code || e.message); dnsCache.clear(); r = await once(); }
      if (r.statusCode !== 200 && !smart && thinkingSupported) {
        const t = await readAll(r);
        if (/think/i.test(t)) { thinkingSupported = false; r = await once(); } else { lastErr = 'HTTP ' + r.statusCode + ' ' + t.slice(0, 300); r = null; continue; }
      }
      if (r.statusCode === 200) break;
      const t = await readAll(r); lastErr = 'HTTP ' + r.statusCode + ' ' + t.slice(0, 300);
      if (smart) smartFailed(r.statusCode, t);
      r = null;
    } catch (e) { lastErr = e.message; r = null; }
  }
  if (!r) throw new Error(lastErr || 'kein Modell erreichbar');
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
async function geminiCards(topic, fach) {
  const m = String(topic).match(/(\d{1,2})\s*(karteikarten|lernkarten|karten|flashcards)/i);
  const want = m ? Math.max(3, Math.min(25, +m[1])) : 0;
  const prompt = `Ein Schüler bittet dich in einer Lern-App: "${topic}"
Erstelle dazu Karteikarten. ${want ? 'Genau ' + want + ' Karten.' : 'So viele, wie das Thema sinnvoll hergibt: meist 8 bis 16 (bei einer Reihe eine Karte pro Glied).'}

Kontext: ${fach === 'deutsch' ? 'Oberstufe, Deutsch-Grundkurs-Klausur: Szenenanalyse zu Kleists Lustspiel „Der zerbrochne Krug“ (Autor, Entstehung, Uraufführung 1808, Erstdruck 1811, analytisches Drama, Blankvers, 13 Auftritte, Figuren Adam, Walter, Licht, Marthe Rull, Eve, Veit, Ruprecht, Frau Brigitte, Handlung nach Auftritten, Motive, Stilmittel, Aufbau einer Szenenanalyse). Nutze diese Fakten:\n' + SYSTEM_DE.split('So antwortest du:')[0] : 'Klasse 10, Chemieklausur über Alkane (homologe Reihe CₙH₂ₙ₊₂ von Methan bis Decan, verzweigte Alkane und IUPAC-Namen, Isomerie, Elektronegativität und Polarität mit ΔEN-Grenzen 0,5 und 1,7, zwischenmolekulare Wechselwirkungen, Eigenschaften der Alkane, Formelschreibweisen).'} Wenn der Schüler ein anderes Thema nennt, mach Karten genau zu diesem Thema.

Gute Karten:
- Erst verstehen, was genau gewünscht ist (Thema, Umfang, Art), auch bei Tippfehlern oder Umgangssprache.
- Mischung: Definitionen, "Warum …?"-Fragen mit Je-desto-Begründung, Beispiele, typische Klausurfragen, Unterscheidungen ("Unterschied zwischen … und …?") und Rechen- bzw. Benennungsbeispiele, wo es passt.
- Vorderseite: eine klare Frage oder ein Begriff (höchstens 90 Zeichen).
- Rückseite: die Antwort, knapp und vollständig, zum Auswendiglernen (höchstens 240 Zeichen), gern mit Beispiel.
- Jede Karte deckt etwas anderes ab, keine Wiederholungen, keine trivialen Füllkarten.
- Fachlich korrekt; prüfe jede Karte, bevor du sie ausgibst. Nichts erfinden.
- ${fach === 'deutsch' ? 'Zitate nur, wenn sicher belegt; keine erfundenen Versnummern.' : 'Formeln mit Unicode-Tiefstellung, z. B. C₆H₁₄, CH₃–CH₂–CH₃.'} Deutsch mit ä, ö, ü und ß.`;
  const schema = { type: 'ARRAY', items: { type: 'OBJECT', properties: { front: { type: 'STRING' }, back: { type: 'STRING' } }, required: ['front', 'back'] } };
  const call = async (model, smart, withSchema) => {
    const generationConfig = { temperature: 0.4, maxOutputTokens: smart ? 8000 : 3000, responseMimeType: 'application/json' };
    if (withSchema) generationConfig.responseSchema = schema;
    if (smart) generationConfig.thinkingConfig = { thinkingLevel: 'low' };
    else if (thinkingSupported) generationConfig.thinkingConfig = thinkCfg(model);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const r = await httpsReq(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig }), timeout: smart ? 45000 : 30000 });
    return { status: r.statusCode, body: await readAll(r) };
  };
  let x = null, lastErr = '';
  for (const [model, smart] of modelPlan()) {
    try {
      x = await call(model, smart, true);
      if (x.status === 400) x = await call(model, smart, false);
      if (x.status === 200) break;
      lastErr = 'HTTP ' + x.status + ' ' + x.body.slice(0, 200); if (smart) smartFailed(x.status, x.body); x = null;
    } catch (e) { lastErr = e.message; x = null; }
  }
  if (!x) throw new Error(lastErr);
  const j = JSON.parse(x.body);
  const text = ((((j.candidates || [])[0] || {}).content || {}).parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
  const arr = JSON.parse(text.replace(/^```(json)?|```$/g, '').trim());
  const seen = new Set();
  return (Array.isArray(arr) ? arr : []).filter(c => c && c.front && c.back && !seen.has(String(c.front).toLowerCase()) && seen.add(String(c.front).toLowerCase())).slice(0, 25)
    .map(c => ({ front: String(c.front).replace(/[<>]/g, '').slice(0, 140), back: String(c.back).replace(/[<>]/g, '').slice(0, 360) }));
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
      if (req.url.startsWith('/admin/') && limited('admin:' + ip, 150)) return json(429, { error: 'Zu viele Anfragen.' });
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
      try { const cards = await geminiCards(topic, m.fach === 'deutsch' ? 'deutsch' : 'chemie'); console.log('Karteikarten:', cards.length, 'in', Date.now() - t0, 'ms'); json(cards.length ? 200 : 502, cards.length ? { cards } : { error: 'Keine Karten erhalten.' }); }
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
        }, m.fach === 'deutsch' ? 'deutsch' : 'chemie');
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
const fachOf = p => (p && p.fach === 'deutsch') ? 'deutsch' : 'chemie';
const FACH_NAME = { chemie: 'Chemie', deutsch: 'Deutsch GK' };
const pub = p => ({ id: p.pid, name: p.name, avatar: p.avatar, title: p.title, color: p.color, fach: fachOf(p), status: p.room && p.room.state && p.room.state !== 'lobby' ? 'battle' : 'online' });

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
const BOT_NAMES_DE = ['Krug-Kalle', 'Richter-Rudi', 'Blankvers-Bea', 'Perücken-Paul', 'Zitat-Zoe', 'Akt-Anton', 'Kleist-Klara', 'Szenen-Sam'];
const BOT_AVATARS = ['robot', 'alien', 'owl', 'penguin', 'fox', 'panda'];
function makeBot(room, level) {
  const L = BOT_LEVEL[level] ? level : 'medium';
  const used = new Set(room.players.filter(Boolean).map(p => p.name));
  const de = room.players.some(p => p && !p.isBot && p.fach === 'deutsch');
  const name = ((de ? BOT_NAMES_DE : BOT_NAMES).find(n => !used.has('🤖 ' + n)) || 'Bot');
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
  for (const [k, w] of waitingBy) if (w === ws) waitingBy.delete(k);
  const room = ws.room; if (!room) return;
  if (room.team) return tRemove(room, ws);
  ws.room = null;
  closeRoom(room, ws);
}

// Verbindung abgerissen (App im Hintergrund): Platz freihalten
function dropped(ws) {
  for (const [k, w] of waitingBy) if (w === ws) waitingBy.delete(k);
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
        ws.color = clean(m.color, 12) || 'std'; ws.canReady = m.ready === true; if (m.fach === 'deutsch' || m.fach === 'chemie') ws.fach = m.fach;
        if (/^[a-f0-9]{16,32}$/.test(m.id || '') && banOf(m.id)) {
          const b = banOf(m.id); send(ws, { type: 'banned', until: new Date(b.until).toISOString(), reason: b.reason });
          setTimeout(() => { try { ws.close(); } catch {} }, 200); break;
        }
        if (/^[a-f0-9]{16,32}$/.test(m.id || '')) {
          ws.pid = m.id;
          online.set(ws.pid, ws);   // pro Spieler-ID zählt nur die neueste Verbindung
        }
        send(ws, { type: 'hi', online: online.size }); ws.away = false; presence();
        break;
      case 'resume': resume(ws, m); break;
      case 'away': if (!ws.away) { ws.away = true; presence(); } break;     // App im Hintergrund
      case 'back': if (ws.away) { ws.away = false; presence(); } break;
      case 'who': {
        // alle, die gerade die App offen haben (ohne einen selbst)
        // gleiche Person (Name + Avatar) nur einmal, tote Verbindungen weglassen
        const seen = new Set(), list = [];
        [...online.values()].filter(p => p !== ws && isLive(p) && p.named && p.pid !== ws.pid)
          .sort((a, b) => (b.room ? 1 : 0) - (a.room ? 1 : 0)).forEach(p => { const k = p.name.toLowerCase() + '|' + p.avatar; if (k === (ws.name || '').toLowerCase() + '|' + ws.avatar || seen.has(k)) return; seen.add(k); list.push(pub(p)); });
        const ids = Array.isArray(m.friends) ? m.friends.slice(0, 300) : [];
        send(ws, { type: 'who', list, friendsOnline: ids.filter(id => isLive(online.get(id))) });
        break;
      }
      case 'friend_req': case 'friend_ok': case 'friend_no': case 'invite': case 'invite_no': {
        const to = online.get(String(m.to || ''));
        if (!to || !ws.pid) return send(ws, { type: 'error_soft', msg: 'Der Spieler ist gerade nicht online.' });
        if (m.type === 'invite' && to.room && to.room.state && to.room.state !== 'lobby') return send(ws, { type: 'error_soft', msg: to.name + ' ist gerade in einem Battle.' });
        if (m.type === 'invite' && fachOf(to) !== fachOf(ws)) return send(ws, { type: 'error_soft', msg: to.name + ' lernt gerade ' + FACH_NAME[fachOf(to)] + '. Herausfordern geht nur im selben Fach.' });
        send(to, { type: m.type, from: pub(ws) });
        break;
      }
      case 'invite_ok': {
        // Herausforderung angenommen: beide in einen neuen Raum
        const from = online.get(String(m.to || ''));
        if (!from || from.readyState !== 1 || (from.room && from.room.state && from.room.state !== 'lobby'))
          return send(ws, { type: 'error_soft', msg: 'Die Herausforderung ist nicht mehr gültig.' });
        if (fachOf(from) !== fachOf(ws)) return send(ws, { type: 'wrongfach', fach: fachOf(from), msg: 'Die Herausforderung ist für ' + FACH_NAME[fachOf(from)] + '.' });
        leave(from); leave(ws);
        const code = newCode(); const r = { code, players: [from, ws], fach: fachOf(from) }; rooms.set(code, r); startMatch(r);
        break;
      }
      case 'quick':
        leave(ws);
        { const f = m.fach === 'deutsch' ? 'deutsch' : 'chemie'; ws.fach = f; const w = waitingBy.get(f);
          if (w && w !== ws && w.readyState === 1) {
            const code = newCode(); const r = { code, players: [w, ws] }; rooms.set(code, r); waitingBy.delete(f); startMatch(r);
          } else { waitingBy.set(f, ws); send(ws, { type: 'searching' }); } }
        break;
      case 'create': {
        leave(ws);
        const code = newCode(); const r = { code, players: [null, null], state: 'lobby', grace: [null, null], fach: fachOf(ws) };
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
        const code = newCode(); const r = { code, team: true, size: 1, players: [], teams: [], state: 'lobby', hostSlot: 0, grace: [], fach: fachOf(ws) };
        rooms.set(code, r); tSeat(r, ws); tSeat(r, makeBot(r, m.level));
        tStartPrep(r);
        break;
      }
      case 'tcreate': {
        const size = m.size === 3 ? 3 : 2;
        leave(ws);
        const code = newCode(); const r = { code, team: true, size, players: [], teams: [], state: 'lobby', hostSlot: 0, grace: [], fach: fachOf(ws) };
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
        if (fachOf(to) !== (room.fach || 'chemie')) return send(ws, { type: 'error_soft', msg: to.name + ' lernt gerade ' + FACH_NAME[fachOf(to)] + '. Einladen geht nur im selben Fach.' });
        send(to, { type: 'tinvite', from: pub(ws), code: room.code, size: room.size });
        break;
      }
      case 'join': {
        const tr = rooms.get(clean(m.code, 4));
        { const rr = tr; if (rr && rr.fach && rr.fach !== fachOf(ws) && !rr.players.includes(ws)) return send(ws, { type: 'wrongfach', fach: rr.fach, code: rr.code, msg: 'Dieser Raum ist für ' + FACH_NAME[rr.fach] + '.' }); }
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
  ws.on('close', () => { if (ws.pid && online.get(ws.pid) === ws) online.delete(ws.pid); unwatch(ws); dropped(ws); presence(); });
});

// Verbindungen am Leben halten, tote Verbindungen aufräumen
// alle 5 s anpingen; wer einmal nicht antwortet, fliegt raus (spätestens nach ~10 s offline)
setInterval(() => wss.clients.forEach(ws => { if (!ws.alive) return ws.terminate(); ws.alive = false; ws.ping(); }), 5000);

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
