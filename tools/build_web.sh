#!/bin/sh
# Baut web/index.html (für Render, iPhone/iPad und die Android-App) aus der App-Datei.
# Aufruf: tools/build_web.sh <app.html>
set -e
SRC="$1"; ROOT="$(cd "$(dirname "$0")/.." && pwd)"
{
cat <<'HEAD'
<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#121817">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Alkane">
<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" href="icon-180.png">
<link rel="icon" type="image/png" href="icon-192.png">
<style>
[hidden]{display:none!important}
body{margin:0}
img{max-width:100%}
/* Platz für Statusleiste und Home-Balken, wenn die App im Vollbild läuft */
:root{padding-top:env(safe-area-inset-top,0px)}
body::before{content:"";position:fixed;inset:0 0 auto;height:env(safe-area-inset-top,0px);z-index:60;background:var(--bg,#121817)}
</style>
<script>
if (location.protocol === 'https:' && /onrender\.com$/.test(location.hostname) && 'serviceWorker' in navigator) {
  addEventListener('load', function(){ navigator.serviceWorker.register('sw.js').catch(function(){}); });
}
</script>
</head>
<body>
HEAD
cat "$SRC"
printf '\n</body>\n</html>\n'
} > "$ROOT/web/index.html"
cp "$ROOT/web/index.html" "$ROOT/android/app/src/main/assets/app.html"
echo "web/index.html gebaut"
