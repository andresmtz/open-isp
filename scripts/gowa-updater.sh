#!/bin/bash
# Actualizador de GoWA (corre en el HOST, no en el contenedor de la app).
# La app pide una versión escribiendo docker-data/updater/request.json ({"target":"v9.6.0"}); systemd (gowa-updater.path)
# ejecuta este script. Pasos: valida la versión, la descarga, detiene GoWA, respalda su carpeta de datos, cambia la
# versión (GOWA_VERSION en .env), lo levanta y comprueba que quede corriendo. Si no arranca, vuelve a la versión anterior
# con el respaldo. El resultado queda en result.json y la versión en uso en status.json.
#   gowa-updater.sh          → procesa un pedido (si hay)
#   gowa-updater.sh status   → solo actualiza status.json
set -u
APP=/opt/open-isp
DIR=$APP/docker-data/updater
REQ=$DIR/request.json; RES=$DIR/result.json; ST=$DIR/status.json
IMG=aldinokemal2104/go-whatsapp-web-multidevice
mkdir -p "$DIR" "$APP/docker-data/backups"
exec 9>"$DIR/.lock"; flock -n 9 || exit 0

current() { docker inspect --format '{{.Config.Image}}' gowa 2>/dev/null | sed 's/.*://'; }
running() { [ "$(docker inspect -f '{{.State.Running}}' gowa 2>/dev/null)" = "true" ] && echo true || echo false; }
write_status() { printf '{"current":"%s","running":%s,"at":"%s"}\n' "$(current)" "$(running)" "$(date -Is)" > "$ST.tmp" && mv "$ST.tmp" "$ST"; }
json_msg() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
result() { printf '{"ok":%s,"from":"%s","to":"%s","at":"%s","message":"%s"}\n' "$1" "$FROM" "$TARGET" "$(date -Is)" "$(json_msg "$2")" > "$RES.tmp" && mv "$RES.tmp" "$RES"; write_status; }
set_version() { if grep -q '^GOWA_VERSION=' "$APP/.env" 2>/dev/null; then sed -i "s/^GOWA_VERSION=.*/GOWA_VERSION=$1/" "$APP/.env"; else echo "GOWA_VERSION=$1" >> "$APP/.env"; fi; }

if [ "${1:-}" = "status" ] || [ ! -f "$REQ" ]; then write_status; exit 0; fi

TARGET=$(grep -o '"target" *: *"v[0-9]\{1,3\}\.[0-9]\{1,3\}\.[0-9]\{1,3\}"' "$REQ" | grep -o 'v[0-9.]*' | tail -1)
rm -f "$REQ"
FROM=$(current)
if [ -z "$TARGET" ]; then TARGET="?"; result false "Versión pedida inválida."; exit 0; fi
if [ "$TARGET" = "$FROM" ]; then result true "Ya estaba en $TARGET."; exit 0; fi
result null "Descargando $TARGET…"
cd "$APP" || exit 1
if ! docker pull -q "$IMG:$TARGET" >/dev/null 2>&1; then result false "No se pudo descargar $TARGET (¿existe esa versión? ¿hay internet?). No se tocó nada: sigue $FROM."; exit 0; fi

result null "Respaldando la sesión de WhatsApp…"
BK="$APP/docker-data/backups/gowa-$FROM-$(date +%Y%m%d-%H%M%S).tgz"
docker compose stop gowa >/dev/null 2>&1
if ! tar czf "$BK" -C "$APP/docker-data" gowa gowa.env; then docker compose up -d gowa >/dev/null 2>&1; result false "No se pudo hacer el respaldo; no se actualizó. Sigue $FROM."; exit 0; fi
ls -1t "$APP"/docker-data/backups/gowa-*.tgz 2>/dev/null | tail -n +6 | xargs -r rm -f   # se guardan los 5 últimos

result null "Iniciando $TARGET…"
set_version "$TARGET"
docker compose up -d gowa >/dev/null 2>&1
sleep 25
if [ "$(running)" = "true" ] && [ "$(current)" = "$TARGET" ]; then
  result true "WhatsApp actualizado de $FROM a $TARGET. Respaldo: $(basename "$BK")."
  exit 0
fi

# No arrancó: vuelve a la versión anterior con los datos del respaldo
docker compose stop gowa >/dev/null 2>&1
rm -rf "$APP/docker-data/gowa" && tar xzf "$BK" -C "$APP/docker-data"
set_version "$FROM"
docker compose up -d gowa >/dev/null 2>&1
sleep 10
result false "$TARGET no arrancó; se volvió a $FROM con el respaldo ($(basename "$BK"))."
