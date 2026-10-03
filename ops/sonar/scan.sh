#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# `[SQ.1]` CORRER LA AUDITORÍA — sobre `origin/main`, nunca sobre un árbol sucio.
#
#   uso:  sh ~/ops/sonar/scan.sh
#
# ── Por qué un checkout PROPIO y no el de auto-deploy ───────────────────────
# `~/auto-deploy/repo` existe y está en `main`, pero (1) está en el commit
# DESPLEGADO, que va por detrás de `origin/main`, y (2) el auto-deploy le mueve
# el HEAD cuando corre. Un análisis que arranca en un commit y termina en otro
# produce un informe que no describe a ninguno de los dos. Acá va su propio
# workspace, que sólo toca este script.
#
# ⚠️ El análisis mide `origin/main`, o sea **lo que está en GitHub**, no lo que
#    haya sin pushear en la máquina de nadie. Es a propósito: el informe tiene
#    que hablar de la verdad compartida. Si el tablero no muestra un cambio que
#    hiciste, lo primero a revisar es si está pusheado.
#
# ⛔ Lee con la llave de DESPLIEGUE (`~/.ssh/deploy_md`), que es de sólo lectura.
#    Este script no empuja nada y no tiene con qué.
# ─────────────────────────────────────────────────────────────────────────────
set -eu

DIR=$(cd "$(dirname "$0")" && pwd)
W="$DIR/workspace"
SERVIDOR=${SONAR_URL:-http://192.168.0.222:9000}

# La credencial vive en el .env de al lado (600, fuera de git). Nunca se imprime.
if [ -f "$DIR/.env" ]; then
  # shellcheck disable=SC1091
  . "$DIR/.env"
fi
if [ -z "${SONAR_TOKEN:-}" ]; then
  echo "⛔ falta SONAR_TOKEN en $DIR/.env"
  echo "   Generalo en $SERVIDOR → My Account → Security → Generate Token,"
  echo "   y agregalo con:  printf 'SONAR_TOKEN=%s\\n' '<token>' >> $DIR/.env"
  exit 1
fi

# ── 1. el workspace, en origin/main ─────────────────────────────────────────
export GIT_SSH_COMMAND="ssh -i $HOME/.ssh/deploy_md -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
if [ ! -d "$W/.git" ]; then
  echo "  clonando el workspace..."
  git clone -q git@github.com:edgarcg-01/Trade_marketing.git "$W"
fi
git -C "$W" fetch -q origin main
git -C "$W" reset -q --hard FETCH_HEAD
git -C "$W" clean -qfd
COMMIT=$(git -C "$W" rev-parse --short HEAD)
echo "  analizando origin/main @ $COMMIT  ($(git -C "$W" log -1 --format=%ci))"

# ⛔ Si `sonar-project.properties` no está en el commit analizado, el escáner NO
#    falla: corre con sus valores por defecto, o sea **sin ninguna exclusión**, y
#    se traga las 1,105 migraciones. El informe sale, se ve completo, y describe
#    otro universo. Es la misma clase de éxito silencioso que este repo persigue.
if [ ! -f "$W/sonar-project.properties" ]; then
  echo "⛔ ABORTA: $COMMIT no trae sonar-project.properties."
  echo "   Sin él el análisis corre SIN exclusiones y el informe no es comparable"
  echo "   con los anteriores. Pusheá la config a main antes de volver a correr."
  exit 1
fi

# ── 2. el escáner ───────────────────────────────────────────────────────────
# Corre en contenedor para no instalarle una JVM al servidor. `--network host`
# porque el servidor publica en el 9000 del host.
echo "  arrancando el escáner (la primera corrida tarda: ~790k líneas)..."
docker run --rm \
  --network host \
  -e SONAR_HOST_URL="$SERVIDOR" \
  -e SONAR_TOKEN="$SONAR_TOKEN" \
  -v "$W:/usr/src" \
  -v sonar-scanner-cache:/opt/sonar-scanner/.sonar/cache \
  sonarsource/sonar-scanner-cli:latest \
  -Dsonar.projectVersion="$COMMIT"

echo "  listo → $SERVIDOR/dashboard?id=trade-marketing"
