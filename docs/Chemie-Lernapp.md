---
tags: [projekt, app, android, web, chemie]
status: aktiv
repo: https://github.com/Vanacho1202/Chemie-
web: https://alkane-trainer.onrender.com
server: https://alkane-battle.onrender.com
version: "2.4"
aktualisiert: 2026-11-09
---

# Chemie-Lernapp (Alkane Trainer)

Lern-App für die 1. Chemieklausur über Alkane (Klausur am Di, 10.11.2026, 11:30). Läuft als Android-APK, als installierbare Web-App auf iPhone und iPad und im Browser. Getrennt von [[MonsterDeals-App]]: eigenes Repo und eigene Render-Dienste.

## Wünsche und Vorgaben (Gabriel)

- Lern-App zu allen 7 Themen der Themenliste, interaktiv und erklärt, als Android-APK und als Webseite fürs iPad (später auch iPhone)
- Code im eigenen GitHub-Repo „Chemie“ (`Vanacho1202/Chemie-`)
- Backend auf Render, getrennt von MonsterDeals, damit es keine Probleme gibt
- APK soll sich wie bei MonsterDeals live über Updates aktualisieren
- Auf dem PC liegt der Desktop-Ordner „Chemie lern app.apk“ für die App
- Projekt soll bei der Obsidian-Synchronisation mit drin sein

## Wo liegt was

| Was | Wo |
|---|---|
| Code | GitHub `Vanacho1202/Chemie-`, Branch `main` (Ordner `web`, `server`, `android`, `tools`, `docs`) |
| Web-App | https://alkane-trainer.onrender.com |
| Battle-Server | https://alkane-battle.onrender.com |
| Datenbank | Render Postgres `alkane-saves` |
| PC | Desktop-Ordner „Chemie lern app.apk“ (erstes Android-Projekt) |
| Obsidian | diese Notiz (`docs/Chemie-Lernapp.md` im Repo) |

## Backend (Render)

Workspace `tea-daevqv740ujc738v5nlg`, Region Frankfurt, alles kostenloser Plan.

| Dienst | Typ | ID | Einstellungen |
|---|---|---|---|
| `alkane-trainer` | statische Seite | `srv-dboqbve7bikc739vlggg` | veröffentlicht den Ordner `web` |
| `alkane-battle` | Web-Dienst (Node) | `srv-dbos2749v7es7387j780` | Build `cd server && npm install --omit=dev`, Start `node server/server.js`, Auto-Deploy an |
| `alkane-saves` | Postgres | `dpg-dbouluc9v7es738enaog-a` | kostenlos, **läuft am 09.12.2026 ab** (dann Bezahlplan oder neu anlegen) |

**Kein Blueprint:** Die Dienste wurden direkt angelegt, es gibt keine `render.yaml`. Anders als bei MonsterDeals (Blueprint „Monster“). Änderungen an Einstellungen also direkt im Render-Dashboard.

Umgebungsvariablen von `alkane-battle` (Werte nur bei Render, nie im Repo):
- `GEMINI_API_KEY`: Schlüssel aus Google AI Studio für Alki
- `DATABASE_URL`: „Internal Database URL“ von `alkane-saves`
- `GEMINI_MODEL` (optional): Komma-Liste von Modellen; beim Start wird das schnellste gewählt (aktuell `gemini-3.1-flash-lite-preview`)

Server (`server/server.js`, Node mit `ws` 8.18 und `pg` 8.13):
- HTTP: `GET /` Status, `GET /diag` Gemini-Test, `POST /ask` Alki als Text-Stream, `POST /cards` Karteikarten als JSON, `POST /cloud/save|get|load` Spielstand
- WebSocket: Battles 1v1, Team-Räume 2v2/3v3, Bots (leicht/mittel/schwer), Freunde, Einladungen, Zuschauer, Emotes, Revanche, Wiederverbinden per Token
- Tabelle `saves(pid, secret, code, name, data jsonb, updated_at)`; Spielstand-Code im Format `XXXX-XXXX`
- Ping alle 15 s gegen Geisterspieler; doppelte Verbindungen werden zusammengeführt

## GitHub

- Repo `Vanacho1202/Chemie-`, Branch `main`, Commits als „Gabriel Kräling“
- `web/index.html`: die ganze App (eine Datei), dazu `manifest.webmanifest`, `sw.js`, Icons, `version.json`
- `android/`: WebView-Hülle; `assets/index.html` ist eine Ladeseite, die `web/index.html` von raw.githubusercontent.com holt; `assets/app.html` ist die Offline-Kopie
- `tools/build_web.sh` baut `web/index.html`; `tools/rebuild.py` + `tools/sign_v2.py` bauen die APK ohne Android SDK um und signieren sie
- `README.md`: technische Doku

## Regeln für Updates

- Jeder Commit startet den Battle-Server neu und beendet laufende Battles → reine App-Änderungen (`web/`, `android/`, `docs/`) mit `[skip render]` in der Commit-Nachricht pushen und danach nur `alkane-trainer` neu deployen
- Bei jeder neuen App-Version `APP_VERSION` in der App und `web/version.json` erhöhen, dann erscheint „Update verfügbar“
- Die installierte APK holt sich Inhalte selbst; neue APK nur, wenn sich die Android-Hülle ändert
- Anders signierte APK lässt sich nicht drüber installieren → vorher deinstallieren
- APK am PC bauen: `cd android` → `gradlew.bat assembleDebug`

## Was die App kann

- **Lernen:** 7 Themen mit Erklärungen, interaktiven Teilen und Lernvideos; Lernplan mit Countdown (Tage, Stunden, Minuten); Spickzettel; Klausuraufgaben mit Musterlösung
- **Karteikarten:** 26 Klausur-Definitionen plus eigene Stapel, die Alki auf Wunsch erstellt („Erstell mir Karteikarten zur homologen Reihe“); Karten löschen, bearbeiten, eigene hinzufügen
- **Üben:** endloses Training mit immer neuen Aufgaben, Schwächen zuerst; Probeklausur; Fehlerheft; Zuordnen-Spiel; Satz-Puzzles
- **Battle (Kahoot-Stil):** 1 gegen 1, 2 gegen 2, 3 gegen 3; Schnellsuche oder Raum-Code; 20 s pro Frage; keine doppelten Fragen; Weiter erst, wenn alle die Lösung gelesen haben; Emotes; Revanche; kurz in andere App wechseln ohne rauszufliegen
- **Bots:** 1 gegen Bot oder Teams mit Bots auffüllen; mit Bots halbe Münzen
- **Freunde:** Online-Liste (wie Clash Royale), Anfragen, Herausfordern, in Team-Raum einladen, Zuschauen
- **Shop:** Münzen für richtige Antworten; Emotes, Avatare, Titel, Namensfarben
- **Alki:** KI-Nachhilfe mit Google Gemini, Live-Text, Antwort in etwa 1 s; ohne KI Antworten aus dem Lernstoff
- **Spielstand:** lokal und in der Cloud; Spielstand-Code überträgt alles aufs iPad oder ein anderes Gerät
- **Updates:** Hinweis „Update verfügbar“ mit Neu-laden-Knopf

## Gelernt

- Render-Systemauflösung (DNS) hing minutenlang → Server löst Adressen selbst über 8.8.8.8/1.1.1.1 auf
- Gemini 2.5 gibt es für neue Schlüssel nicht mehr; Gemini 3 mit `thinkingLevel: minimal` antwortet in etwa 1 s
- Android-WebView blockiert CORS-Vorabanfragen aus lokalen Dateien → Anfragen als `text/plain`
- Halbstrukturformeln mit Strichen statt Klammern zeichnen (SVG)
- Postgres-SSL nur bei externen `*.render.com`-Adressen nötig

## Klausur-Stoff (Kurzform)

- Siedetemperatur steigt mit Kettenlänge (mehr Van-der-Waals-Kräfte); Verzweigung senkt sie
- Alkane sind unpolar → lösen sich in unpolaren Stoffen (Hexan), nicht in Wasser
- ΔEN: unter 0,5 unpolar, 0,5 bis 1,7 polar, über 1,7 ionisch; Teilladungen mit δ+ und δ− (bei H₂O: O δ−, H δ+)

## Verlauf

- 08.11.2026: erste Version (7 Themen, Probeklausur, Karteikarten), APK auf dem PC gebaut
- 09.11.2026: Training mit Generatoren, Zuordnen und Lernvideos (aus v5), GitHub + Render, Live-Updates, Shop, Battles (1v1, 2v2, 3v3), Freunde, Zuschauen, Alki, iPhone-Web-App, Update-Hinweis, Bots, Cloud-Spielstand, Alki-Karteikarten (Version 2.4)
