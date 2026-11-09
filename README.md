# Chemie: Alkane Trainer

Lern-App für die 1. Chemieklausur (Alkane, 10.11.26) mit Training, Online-Battles, Shop und KI-Nachhilfe.
Läuft als Android-App (APK), als installierbare Web-App auf iPhone/iPad und im Browser.

- **Web-App:** https://alkane-trainer.onrender.com (iPhone/iPad: Safari → Teilen → „Zum Home-Bildschirm“)
- **Battle-Server:** https://alkane-battle.onrender.com (Render, Region Frankfurt, kostenloser Plan)
- **Repo:** Vanacho1202/Chemie-

## Funktionen

| Bereich | Was es kann |
|---|---|
| Lernplan | Countdown bis zur Klausur, Themenliste mit Fortschritt, Spickzettel, Hell/Dunkel |
| 7 Themen | Erklärung, interaktiver Teil (Baukasten, ΔEN-Rechner, Isomer-Jagd, Van-der-Waals-Animation …), Lernvideos, Check mit 5 Fragen |
| Training | endlos neue Aufgaben (Generatoren), Schwächen zuerst, Satz-Puzzles, Zuordnen-Spiel, Trefferquote pro Thema |
| Probeklausur | 15 Fragen, halb neu erzeugt, Auswertung pro Thema, Fehlerheft |
| Karteikarten / Aufgaben | 26 Klausur-Definitionen (ausblendbar), eigene Stapel von Alki („Erstell mir Karteikarten zu …“), Karten löschen, bearbeiten, hinzufügen; 10 Klausuraufgaben mit Musterlösung |
| Battle | 1 gegen 1 (Schnellsuche, Raum-Code, Freund herausfordern), 2 gegen 2 und 3 gegen 3, Kahoot-Punkte, 20 s pro Frage, Weiter erst wenn alle bereit, Emotes, Revanche |
| Bots | 1 gegen Bot oder Teams mit Bots auffüllen, Stufen leicht/mittel/schwer, mit Bots halbe Münzen |
| Freunde | Online-Liste, Freundschaftsanfragen, Herausfordern, in Team-Raum einladen, 👀 Zuschauen |
| Shop | Münzen für richtige Antworten, Emotes, Avatare, Titel, Namensfarben |
| Alki | KI-Chemie-Nachhilfe (Google Gemini), Live-Text; ohne KI Antworten aus dem Lernstoff |
| Spielstand | lokal gespeichert und zusätzlich in der Cloud, Spielstand-Code zum Übertragen auf andere Geräte |
| Updates | App lädt die neueste Version von GitHub, Hinweis „Update verfügbar“ mit Neu-laden-Knopf |

## Aufbau

| Ordner | Inhalt |
|---|---|
| `web/` | Die App (eine HTML-Datei) plus Manifest, Service Worker, Icons, `version.json`. Render veröffentlicht diesen Ordner. |
| `server/` | Battle-Server (Node + WebSocket): Battles, Teams, Bots, Freunde, Zuschauer, KI-Proxy, Cloud-Spielstand. |
| `android/` | Android-Hülle (WebView). `assets/index.html` ist eine Ladeseite, die `web/index.html` von GitHub holt; `assets/app.html` ist die Offline-Kopie. |
| `tools/` | `build_web.sh` (baut `web/index.html`), `rebuild.py` + `sign_v2.py` (APK ohne Android SDK umbauen und signieren). |
| `docs/` | Projektnotiz für Obsidian. |

## Server (Render-Dienst `alkane-battle`)

Umgebungsvariablen:
- `GEMINI_API_KEY`: Schlüssel aus Google AI Studio für Alki
- `GEMINI_MODEL` (optional): Komma-Liste von Modellen; beim Start wird das schnellste gewählt
- `DATABASE_URL`: Postgres für den Cloud-Spielstand (Neon, läuft nicht ab; vorher Render `alkane-saves`)
- `OLD_DATABASE_URL` (optional, nur beim Umzug): alte Datenbank; beim Start werden ihre Spielstände übernommen, danach wieder entfernen

HTTP-Endpunkte: `GET /` (Status), `GET /diag` (Verbindung zu Gemini prüfen), `POST /ask` (Alki, Antwort als Text-Stream), `POST /cards` (Karteikarten als JSON), `POST /cloud/save|get|load` (Spielstand).
WebSocket-Nachrichten: `hello`, `who`, `quick`, `create`, `join`, `tcreate`, `tbot`, `tkick`, `botduel`, `tswitch`, `tstart`, `tinvite`, `invite`, `friend_req`, `watch`, `answer`, `ready`, `emote`, `rematch`, `resume`, `leave`.

Wichtig:
- Die System-Adressauflösung hängt bei Render teils minutenlang. Der Server löst Adressen deshalb selbst über 8.8.8.8/1.1.1.1 auf.
- Gemini 2.5 ist für neue Schlüssel nicht mehr verfügbar; Gemini 3 läuft mit `thinkingLevel: minimal`.
- Der Cloud-Spielstand liegt seit 09.11.2026 bei Neon (Projekt „lern app“, Frankfurt, Free-Plan, läuft nicht ab). Die alte Render-Datenbank `alkane-saves` wird nicht mehr gebraucht.

## Updates ohne Battle-Abbruch

Render baut bei jedem Commit auch den Battle-Server neu, dabei gehen laufende Battles verloren.
Commits, die nur `web/` oder `android/` ändern, mit `[skip render]` in der Commit-Nachricht pushen
und danach nur die statische Seite `alkane-trainer` neu deployen. Bei jeder neuen App-Version
`APP_VERSION` in der App und `web/version.json` erhöhen, dann erscheint der Update-Hinweis.

## APK

Die installierte APK holt sich Inhalts-Updates selbst. Eine neue APK braucht es nur, wenn sich die Android-Hülle ändert.
Bauen (Windows): `cd android` → `gradlew.bat assembleDebug`.
Ohne Android SDK: `tools/rebuild.py` tauscht die Assets einer vorhandenen APK, `repro-apk zipalign` richtet sie aus, `tools/sign_v2.py` signiert sie (v2).
Eine anders signierte APK lässt sich nicht über die installierte App installieren, dann vorher deinstallieren.
