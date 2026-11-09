# Alkane Trainer

Interaktive Lern-App für die 1. Chemieklausur (Alkane): 7 Themen mit Erklärungen, endloses Training mit immer neuen Aufgaben, Probeklausur, Karteikarten und Aufgaben mit Musterlösung.

## Aufbau

| Ordner | Inhalt |
|---|---|
| `web/` | Die eigentliche App (eine HTML-Datei). Render veröffentlicht diesen Ordner als Website. |
| `android/` | Android-Hülle (WebView). Lädt die Live-Version von Render, offline die eingebaute Kopie. |

## Live-Updates

1. `web/index.html` ändern und auf `main` pushen.
2. Render baut die Seite automatisch neu (Auto-Deploy).
3. Die Android-App zeigt beim nächsten Start (mit Internet) die neue Version. Eine neue APK ist dafür nicht nötig.

Eine neue APK braucht es nur, wenn sich an der Android-Hülle selbst etwas ändert.

## APK bauen (Windows)

```
cd android
copy web\index.html app\src\main\assets\index.html   (Offline-Kopie aktualisieren)
gradlew.bat assembleDebug
```
APK: `android/app/build/outputs/apk/debug/app-debug.apk`
