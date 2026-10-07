#!/bin/sh
# ═══════════════════════════════════════════════════════════════════════════════════════════
# `[CD.10]` NODE EN `md` SIN INSTALAR NODE EN `md`
#
#   sh ~/ops/prod/node.sh <script.js> [args...]     # corre un script del repo clonado
#   sh ~/ops/prod/node.sh --version
#   sh ~/ops/prod/node.sh -e 'console.log(1)'
#
# ── El problema ────────────────────────────────────────────────────────────────────────────
# En el host de `md` NO hay node (medido el 2026-10-02: ni PATH, ni /usr/local/bin, ni nvm, ni
# snap). Eso dejaba una friccion real: `~/auto-deploy/repo` tiene el clon fresco de
# `origin/main`, pero para correr cualquier herramienta de `database/scripts/*.js` contra ese
# clon habia que entrar a un pod — que tiene una version YA CONSTRUIDA y distinta del codigo.
#
# ── Por que esto y no `apt install nodejs` ─────────────────────────────────────────────────
# Medido el 2026-10-02:
#   · apt de Ubuntu 26.04 ofrece node **22.22.1**; el pod de prod corre **v20.20.2**. Instalar
#     por apt abre deriva de versiones justo en las herramientas que tocan la base de prod.
#   · `sudo` pide contrasena en `md`, asi que no es automatizable.
#   · ADR-060 dice que el sustrato es Docker declarado en el repo, y el Dockerfile ya razona que
#     el runtime viaja CON la imagen (ahi es por la glibc). Un paquete en el host es lo
#     contrario de eso.
#
# Esta via usa la imagen de la PROPIA app, que se reconstruye en cada despliegue:
#   · **paridad exacta** con lo que corre en produccion (v20.20.2, verificado)
#   · sin sudo, sin paquete nuevo en el host, sin nada que mantener al dia a mano
#   · si el dia de manana la app sube a node 22, esto sube con ella sola
#
# ⚠️ El contenedor ve SOLO el directorio montado. Un script que lea rutas absolutas del host o
#    que necesite otra carpeta no va a encontrarlas: se monta el repo, no la maquina.
# ⚠️ Corre como root dentro del contenedor y escribe con ese owner en el volumen montado. Para
#    lectura y para los scripts de `database/scripts/` alcanza; si algo tiene que escribir en el
#    repo, revisar el owner despues.
# ═══════════════════════════════════════════════════════════════════════════════════════════
set -eu

REPO="${AUTO_DEPLOY_REPO:-$HOME/auto-deploy/repo}"
IMAGEN="${NODE_IMAGEN:-trade-prod-worker:latest}"

if [ ! -d "$REPO" ]; then
  echo "⛔ no existe $REPO — ¿corrio alguna vez auto-deploy.sh?" >&2
  exit 1
fi

if ! docker image inspect "$IMAGEN" >/dev/null 2>&1; then
  echo "⛔ falta la imagen $IMAGEN en este host." >&2
  echo "   Es la de la app: aparece con el primer despliegue. docker images | grep trade-prod" >&2
  exit 1
fi

# `--network host` para que los scripts que hablan con la base la alcancen igual que el host.
# `--entrypoint node` saltea el CMD de la imagen (que arrancaria el worker).
# Sin `-it`: esto se usa tambien desde cron y desde auto-deploy, donde no hay TTY.
exec docker run --rm \
  --network host \
  -v "$REPO":/repo \
  -w /repo \
  --entrypoint node \
  "$IMAGEN" "$@"
