# Chemie: Alkane Trainer

Interaktive Lern-App für die 1. Chemieklausur (Alkane): 7 Themen mit Erklärungen, endloses Training mit immer neuen Aufgaben, Probeklausur, Karteikarten und Aufgaben mit Musterlösung.

## Aufbau

| Ordner | Inhalt |
|---|---|
| `web/` | Die eigentliche App (eine HTML-Datei). Render veröffentlicht diesen Ordner als Website. |
| `server/` | Battle-Server (Node + WebSocket), läuft auf Render als `alkane-battle`. |
| `android/` | Android-Hülle (WebView). Lädt die Live-Version von Render, offline die eingebaute Kopie. |

## Live-Updates

1. `web/index.html` ändern und auf `main` pushen.
2. **Render** veröffentlicht die Website automatisch: https://alkane-trainer.onrender.com
3. **Die Android-App** lädt beim Start `web/index.html` direkt von GitHub (raw.githubusercontent.com) und merkt sich die Version. Ohne Internet nimmt sie die zuletzt geladene Version, beim allerersten Start ohne Internet die eingebaute Kopie `assets/app.html`. Eine neue APK ist für Inhalts-Updates nicht nötig.

Der Lernfortschritt bleibt dabei erhalten, weil die App immer unter derselben lokalen Adresse läuft.

## APK

- `android/app/src/main/assets/index.html`: Ladeseite (holt die Live-Version)
- `android/app/src/main/assets/app.html`: Offline-Kopie der App

Bauen (Windows): `cd android` → `gradlew.bat assembleDebug`

`tools/rebuild.py` und `tools/sign_v2.py` bauen eine vorhandene APK ohne Android SDK um (Assets tauschen, ausrichten mit `repro-apk zipalign`, v2-signieren). Wichtig: Eine Version, die mit einem anderen Schlüssel signiert ist, lässt sich nicht über die installierte App installieren. Dann vorher deinstallieren.
