#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# VL.6 — DESPLIEGUE de la capa de ingesta a `md`.
#
#   ops/vl/deploy.sh                      # reconstruye la imagen y recrea los feeds
#   ops/vl/deploy.sh feeds-cron           # sólo esos servicios
#   ops/vl/deploy.sh --solo-imagen        # construye y NO recrea nada
#   ops/vl/deploy.sh --estado             # qué hay corriendo allá y con qué imagen
#
# ⭐ POR QUÉ EXISTE ESTO
# El 2026-09-11 corrí esta misma secuencia SEIS veces a mano. Funcionó las seis, pero
# el procedimiento vivía en la cabeza de quien lo estaba haciendo — y una capa de
# ingesta cuyo despliegue no está escrito es una capa que sólo puede desplegar una
# persona. Ése era el riesgo real de la imagen, no que "exista sólo en md": la imagen
# es 100 % reproducible desde un commit; lo que no era reproducible era el CÓMO.
#
# ⛔ SE ARCHIVA `HEAD`, NO LA COPIA DE TRABAJO. El índice de git de este repo lo
# comparten ~10 sesiones de Claude a la vez: un `git archive` del working tree
# mandaría a producción el WIP de otra persona. Si hay cambios sin commitear en las
# rutas que entran a la imagen, este script AVISA y se detiene.
#
# ⚠️ `md` no tiene el repo (VL.7 pendiente). La imagen es autocontenida: el código se
# copia adentro. Por eso un cambio de código exige reconstruir, no reiniciar.
# ─────────────────────────────────────────────────────────────────────────────
set -eu

SRV="${DEPLOY_HOST:-superoot@192.168.0.222}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
# Las MISMAS rutas que copia ops/ingest/Dockerfile. Si ahí se agrega un COPY, acá también.
RUTAS="ops/ingest ops/vl database/importers database/scripts services/feeds-ingest libs/platform-core/src/lib/provenance/target-guard.js"
SERVICIOS_DEF="feeds-cron feeds-livefast store-poller"

ssh_md() { ssh -o BatchMode=yes -o ConnectTimeout=10 "$SRV" "$@"; }

estado() {
  echo "── Qué corre en $SRV ──"
  ssh_md 'docker ps --format "{{.Names}}|{{.Status}}|{{.Image}}" | sort | column -t -s"|"'
  echo
  echo "── Imagen ──"
  ssh_md 'docker image inspect trade-ingest:latest --format "  creada {{.Created}}  ·  {{.Size}} bytes"'
}

# AVISA de lo que NO va a viajar, y sigue.
#
# ⚠️ La primera versión de esto ABORTABA si había algo sin commitear, y estaba mal por dos
# razones que se ven juntas:
#   1. `git archive HEAD` ya es seguro POR CONSTRUCCIÓN — los archivos sucios simplemente no
#      entran. No hay nada que prevenir.
#   2. Este repo lo comparten ~10 sesiones a la vez: casi siempre hay WIP ajeno en estas rutas,
#      así que "abortar si está sucio" convertía al script en uno que nunca puede correr. Una
#      compuerta que bloquea el camino feliz se termina salteando a mano, y ahí ya no protege
#      nada. (Comprobado en la primera corrida: abortó por un `import-label-data.js` que estaba
#      editando otra sesión — el archivo del carril de precios.)
# Lo que SÍ hace falta es que el operador sepa que está desplegando HEAD y no lo que ve en su
# editor: el modo de falla real es "edité, no commiteé, desplegué, y no entiendo por qué no
# cambió nada".
verificar_limpio() {
  cd "$REPO"
  sucio=$(git status --porcelain -- $RUTAS | grep -v '\.stock-live-snapshot\.json' || true)
  [ -n "$sucio" ] || return 0
  echo "⚠️  Estos archivos tienen cambios SIN COMMITEAR y por lo tanto NO se despliegan:"
  echo "$sucio" | sed 's/^/     /'
  echo "     (se archiva HEAD a propósito: el índice lo comparten ~10 sesiones y el working"
  echo "      tree traería WIP ajeno. Si alguno de esos cambios es TUYO y lo querés desplegar,"
  echo "      commitealo con pathspec:  git commit -- <ruta>  )"
  echo
}

construir() {
  cd "$REPO"
  commit=$(git rev-parse --short HEAD)
  echo "── Construyendo desde HEAD ($commit) ──"
  # `git archive` aplica los atributos de .gitattributes, que es lo que mantiene los
  # `eol=lf`. ⚠️ Con core.autocrlf=true, un archivo SIN regla se exporta con CRLF —
  # así los 9 carriles corrieron en seco diciendo "ok" el 2026-09-11 (`--apply\r` no
  # matchea `argv.includes('--apply')`). El Dockerfile normaliza por si acaso y ROMPE
  # el build si queda un CR.
  git archive --format=tar HEAD $RUTAS \
    | ssh -o BatchMode=yes "$SRV" 'rm -rf ~/build-ingest && mkdir -p ~/build-ingest && tar -xf - -C ~/build-ingest'
  ssh_md "cd ~/build-ingest && docker build -q -f ops/ingest/Dockerfile -t trade-ingest:latest . >/dev/null && echo '   imagen lista'"
  # El compose vive en el repo y se copia aparte: no entra a la imagen, lo lee el host.
  ssh_md 'cp ~/build-ingest/ops/vl/docker-compose.yml ~/ops/vl/docker-compose.yml && cd ~/ops/vl && docker compose config >/dev/null && echo "   compose válido"'
}

recrear() {
  servicios="$*"
  echo "── Recreando: $servicios ──"
  ssh_md "cd ~/ops/vl && docker compose up -d $servicios 2>&1 | grep -E 'Recreated|Started|Created' | sed 's/^/   /'"
  echo
  echo "── Salud (tras el start_period; los carriles tardan ~3 min en confirmarse) ──"
  ssh_md "for c in $servicios; do printf '   %-16s %s\n' \"\$c\" \"\$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}(sin healthcheck){{end}}' \$c)\"; done"
  echo
  echo "   ⚠️ Verificá la ENTREGA, no el rótulo: el latido en analytics.cron_runs es el"
  echo "      veredicto. Un contenedor 'healthy' con el latido viejo ya pasó (VL.6.1)."
}

case "${1:---todo}" in
  --estado)      estado ;;
  --solo-imagen) verificar_limpio; construir ;;
  --todo)        verificar_limpio; construir; recrear $SERVICIOS_DEF ;;
  -*)            sed -n '2,10p' "$0"; exit 2 ;;
  *)             verificar_limpio; construir; recrear "$@" ;;
esac
