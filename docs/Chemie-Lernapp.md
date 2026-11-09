---
tags: [projekt, app, android, web, chemie]
status: aktiv
repo: https://github.com/Vanacho1202/Chemie-
web: https://alkane-trainer.onrender.com
aktualisiert: 2026-11-09
---

# Chemie-Lernapp (Alkane Trainer)

Lern-App für die 1. Chemieklausur über Alkane (Klausur am 10.11.2026, 11:30). Läuft als Android-APK, als installierbare Web-App auf iPhone und iPad und im Browser.

## Wo liegt was

- **Code:** GitHub-Repo `Vanacho1202/Chemie-` (Ordner `web`, `server`, `android`, `tools`, `docs`)
- **Web-App:** https://alkane-trainer.onrender.com (Render, statische Seite `alkane-trainer`)
- **Battle-Server:** https://alkane-battle.onrender.com (Render, Web-Dienst `alkane-battle`, Frankfurt, kostenlos)
- **Datenbank:** Render Postgres `alkane-saves` (kostenlos bis 09.12.2026)
- **PC:** Desktop-Ordner „Chemie lern app.apk“ mit dem ersten Android-Projekt
- Getrennt von [[MonsterDeals-App]], eigenes Repo und eigene Render-Dienste

## Was die App kann

- **Lernen:** 7 Themen mit Erklärungen, interaktiven Teilen und Lernvideos; Lernplan mit Countdown; Spickzettel; Karteikarten; Klausuraufgaben mit Musterlösung
- **Üben:** endloses Training mit immer neuen Aufgaben, Schwächen zuerst; Probeklausur; Fehlerheft; Zuordnen-Spiel; Satz-Puzzles für Erkläre-Aufgaben
- **Battle (Kahoot-Stil):** 1 gegen 1, 2 gegen 2, 3 gegen 3; Schnellsuche oder Raum-Code; 20 s pro Frage; Weiter erst, wenn alle die Lösung gelesen haben; Emotes; Revanche
- **Bots:** 1 gegen Bot oder Teams mit Bots auffüllen (leicht, mittel, schwer); mit Bots halbe Münzen
- **Freunde:** Online-Liste, Anfragen, Herausfordern, in Team-Raum einladen, Zuschauen
- **Shop:** Münzen für richtige Antworten; Emotes, Avatare, Titel, Namensfarben
- **Alki:** KI-Nachhilfe mit Google Gemini (Gemini 3 Flash, Live-Text); ohne KI Antworten aus dem Lernstoff
- **Spielstand:** lokal und in der Cloud; Spielstand-Code überträgt alles auf ein anderes Gerät
- **Updates:** App holt sich neue Versionen von GitHub; Hinweis „Update verfügbar“ mit Neu-laden-Knopf

## Einstellungen (Render, Dienst alkane-battle)

- `GEMINI_API_KEY`: Schlüssel aus Google AI Studio
- `DATABASE_URL`: Internal Database URL von `alkane-saves`
- `GEMINI_MODEL` (optional): Modell-Liste, das schnellste wird beim Start gewählt

## Gelernt

- Render-Systemauflösung (DNS) hing minutenlang → Server löst Adressen selbst über 8.8.8.8/1.1.1.1 auf
- Gemini 2.5 gibt es für neue Schlüssel nicht mehr; Gemini 3 mit `thinkingLevel: minimal` antwortet in etwa 1 s
- Jeder Commit startet den Battle-Server neu → reine App-Änderungen mit `[skip render]` pushen
- Android-WebView blockiert CORS-Vorabanfragen aus lokalen Dateien → Anfragen als `text/plain`

## Verlauf

- 08.11.2026: erste Version (7 Themen, Probeklausur, Karteikarten), APK auf dem PC gebaut
- 09.11.2026: Training mit Generatoren, Zuordnen und Lernvideos (aus v5), GitHub + Render, Live-Updates, Shop, Battles (1v1, 2v2, 3v3), Freunde, Zuschauen, Alki, iPhone-Web-App, Bots, Cloud-Spielstand
