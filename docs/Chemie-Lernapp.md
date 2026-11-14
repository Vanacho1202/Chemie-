---
tags:
  - projekt
  - android-app
  - webapp
  - backend
status: funktionsfähig
version: "5.0"
aktualisiert: 2026-11-09
---

# Chemie-Lernapp (Alkane Trainer)

## Übersicht
- **Typ:** Lern-App (Web-App in einer HTML-Datei + Android-WebView-Hülle + Node-Battle-Server)
- **Plattformen:** Android-APK, installierbare Web-App auf iPhone/iPad (Safari → Teilen → „Zum Home-Bildschirm“), Browser
- **Version:** 2.4
- **Eigenständig:** eigenes GitHub-Repo und eigene Render-Dienste, getrennt von [[MonsterDeals-App]]
- **Speicherort:** nur im GitHub-Repo; auf dem PC liegt im Desktop-Ordner „Chemie lern app.apk“ nur das erste Android-Projekt

## Links
| Was | Link |
|---|---|
| Web-App | https://alkane-trainer.onrender.com |
| Battle-Server (Status) | https://alkane-battle.onrender.com |
| Gemini-Test | https://alkane-battle.onrender.com/diag |
| GitHub-Repo | https://github.com/Vanacho1202/Chemie- |
| App-Datei (lädt die APK) | https://raw.githubusercontent.com/Vanacho1202/Chemie-/main/web/index.html |
| Render: Battle-Server | https://dashboard.render.com/web/srv-dbos2749v7es7387j780 |
| Render: Einstellungen (Environment) | https://dashboard.render.com/web/srv-dbos2749v7es7387j780/env |
| Render: Logs | https://dashboard.render.com/web/srv-dbos2749v7es7387j780/logs |
| Render: Web-App | https://dashboard.render.com/static/srv-dboqbve7bikc739vlggg |
| Neon: Datenbank | https://console.neon.tech/app/projects/divine-hill-23353652 |
| Gemini-Schlüssel | https://aistudio.google.com/apikey |

## Backend
- **Render** (Workspace `tea-daevqv740ujc738v5nlg`, Frankfurt, kostenlos)
  - `alkane-trainer` (`srv-dboqbve7bikc739vlggg`): statische Seite, veröffentlicht den Ordner `web`
  - `alkane-battle` (`srv-dbos2749v7es7387j780`): Node-Webdienst, Build `cd server && npm install --omit=dev`, Start `node server/server.js`, Auto-Deploy bei jedem Commit
  - Kein Blueprint: Dienste direkt angelegt, keine `render.yaml` (anders als MonsterDeals mit Blueprint „Monster“). Einstellungen direkt im Dashboard ändern.
  - Kostenloser Webdienst schläft nach 15 Minuten ohne Nutzung ein; der erste Aufruf danach dauert etwa eine Minute.
- **Neon** (Projekt „lern app“, `divine-hill-23353652`, Frankfurt, Free-Plan): Datenbank für den Cloud-Spielstand, läuft nicht ab, 1 GB. Seit 09.11.2026; vorher Render-Postgres `alkane-saves` (wäre am 09.12.2026 abgelaufen).
- **Google Gemini:** KI für Alki; das schnellste Modell wird beim Serverstart gewählt (zuletzt `gemini-3.1-flash-lite`).

## Einstellungen (Render → `alkane-battle` → Environment)
Werte stehen nur bei Render, nie im Repo oder hier.
- `GEMINI_API_KEY`: Schlüssel aus Google AI Studio
- `DATABASE_URL`: Connection string von Neon
- `GEMINI_MODEL` (optional): Komma-Liste von Modellen
- `OLD_DATABASE_URL` (nur für Umzüge): alte Datenbank, deren Spielstände beim Start übernommen werden; danach löschen

## Aufbau (GitHub, Branch `main`)
- `web/`: die ganze App (`index.html`), Manifest, Service Worker, Icons, `version.json`
- `server/`: Battle-Server (`server.js`): Battles, Teams, Bots, Freunde, Zuschauer, KI, Cloud-Spielstand
- `android/`: WebView-Hülle; `assets/index.html` lädt die App von GitHub, `assets/app.html` ist die Offline-Kopie
- `tools/`: `build_web.sh` baut `web/index.html`; `rebuild.py` + `sign_v2.py` bauen die APK ohne Android SDK um
- `docs/`: diese Notiz
- `README.md`: technische Details (Endpunkte, WebSocket-Nachrichten)

## Fächer (ab Version 5.0)
- Beim ersten Start Fachauswahl, oben auf der Startseite „Fach wechseln“
- **Chemie**: Alkane (Klausur 10.11.2026)
- **Geschichte**: Deutschland 1815–1848/49 (Klausur Mo 16.11.2026, 9:50); Wiener Kongress, Nationalbewegung, Vormärz, Wirtschaft, Märzrevolution, Paulskirche, Scheitern + Quellen-/Karikaturanalyse; Zeitstrahl, Fraktionen, politische Richtungen; Server-Prompt `SYSTEM_GE`
- **Deutsch GK**: Kleist, „Der zerbrochne Krug“ + Szenenanalyse (Klausur Do 12.11.2026, 8:00); 7 Themen, Fragenpool, Generatoren (Figuren, Zitate, Auftritte, Stilmittel, Aufbau), Karteikarten, Aufgaben mit Musterlösung, Spickzettel
- Fortschritt (Themen, Training, Fehlerheft, Probeklausuren, Karten, Stapel) pro Fach gespeichert; Münzen, Shop, Freunde, Name gelten für alle
- Schnellsuche im Battle nur gegen Spieler im selben Fach; Alki und Karteikarten-KI kennen das gewählte Fach
- Neues Fach: Inhalte als `DE`-Block in der App + Eintrag in `FACHER`, Server-Prompt `SYSTEM_DE` ergänzen

## Funktionen
- **Lernen:** 7 Themen mit Erklärungen, interaktiven Teilen und Videos, Lernplan, Spickzettel, Klausuraufgaben mit Musterlösung
- **Üben:** endloses Training, Probeklausur, Fehlerheft, Zuordnen-Spiel, Satz-Puzzles
- **Karteikarten:** feste Definitionen plus eigene Stapel, die Alki erstellt; löschen, bearbeiten, hinzufügen
- **Battles:** 1v1, 2v2, 3v3 im Kahoot-Stil, Schnellsuche oder Raum-Code, Weiter erst wenn alle bereit, Emotes, Revanche, Wiederverbinden
- **Bots:** leicht, mittel, schwer; füllen Teams auf; halbe Münzen
- **Freunde:** Online-Liste, Anfragen, Herausfordern, Einladen, Zuschauen
- **Shop:** Emotes, Avatare, Titel, Namensfarben
- **Alki:** KI-Nachhilfe (Gemini) mit Live-Text
- **Spielstand:** lokal + Cloud (Neon), Spielstand-Code für andere Geräte
- **Updates:** Hinweis „Update verfügbar“ mit Neu-laden-Knopf

## Update-Regeln
- Reine App-Änderungen (`web/`, `android/`, `docs/`) mit `[skip render]` in der Commit-Nachricht pushen und danach nur `alkane-trainer` neu deployen. Jeder andere Commit startet den Battle-Server neu und beendet laufende Battles.
- Bei neuer App-Version `APP_VERSION` in der App und `web/version.json` erhöhen, sonst kommt kein Update-Hinweis.
- Neue APK nur nötig, wenn sich die Android-Hülle ändert. APK bauen: `cd android` → `gradlew.bat assembleDebug`.
- Anders signierte APK lässt sich nicht drüber installieren → alte vorher deinstallieren.

## Gelernt
- DNS bei Render hing minutenlang → Server löst Adressen selbst über 8.8.8.8 / 1.1.1.1 auf
- Gemini 2.5 gibt es für neue Schlüssel nicht mehr; Gemini 3 mit `thinkingLevel: minimal` antwortet in etwa 1 s
- Android-WebView blockiert CORS-Vorabanfragen → Anfragen als `text/plain`
- Render-Postgres kostenlos läuft nach 30 Tagen ab → Neon statt Render für die Datenbank
- Neon braucht SSL mit Servername (SNI); Render-interne Adressen ohne SSL

## Verlauf
- 08.11.2026: erste Version, APK auf dem PC gebaut
- 09.11.2026: GitHub + Render, Live-Updates, Training, Shop, Battles, Freunde, Alki, iPhone-Web-App, Bots, Cloud-Spielstand, Alki-Karteikarten (2.4); Datenbank von Render zu Neon umgezogen (5 Spielstände übernommen)

## Notizen
- Keine Zugangsdaten, Tokens oder API-Schlüssel in dieser Notiz
