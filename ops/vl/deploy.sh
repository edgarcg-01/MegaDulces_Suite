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
# ⭐ [CT.1] LOS OCHO CARRILES, y que estuvieran sólo tres fue la causa de una deriva real.
#
# Hasta el 2026-09-24 esta línea decía `feeds-cron feeds-livefast store-poller`: los cinco
# `ods-*` NO estaban, así que `--todo` construía la imagen nueva y los dejaba corriendo la
# vieja. Medido ese día, antes del arreglo:
#
#     trade-ingest:latest = 34d5076a1b5a
#     ods-live-hot 4c2d81882737 · ods-live-mirror 4c2d81882737 · ods-reconcile a8823285003c
#     ods-reconcile-chicas a8823285003c · ods-reconcile-full 5998d0949a95
#     feeds-livefast 5998d0949a95 · store-poller 5998d0949a95      ← 7 de 8 atrasados
#
# O sea CUATRO versiones del mismo código conviviendo, y seis de ellas en imágenes que ya ni
# tienen tag (`docker images` no las lista: el rebuild retagueó `latest` y las dejó huérfanas).
#
# ⚠️ Ese día no hubo daño, pero por SUERTE: `replicate-ods-live.js` resultó idéntico en los
# cuatro contenedores (md5 a729bac5c3). El que sí difería era `refresh-caja-matview.js`, y
# casualmente sólo corre en `feeds-cron`, que era el único al día. Nada garantiza que la
# próxima divergencia caiga en un archivo inocuo.
#
# Si agregás un servicio al compose que corra código de este repo, va ACÁ también.
SERVICIOS_DEF="feeds-cron feeds-livefast store-poller ods-live-hot ods-live-mirror ods-reconcile ods-reconcile-chicas ods-reconcile-full"

ssh_md() { ssh -o BatchMode=yes -o ConnectTimeout=10 "$SRV" "$@"; }

estado() {
  echo "── Qué corre en $SRV ──"
  ssh_md 'docker ps --format "{{.Names}}|{{.Status}}|{{.Image}}" | sort | column -t -s"|"'
  echo
  echo "── Imagen ──"
  ssh_md 'docker image inspect trade-ingest:latest --format "  creada {{.Created}}  ·  {{.Size}} bytes"'
  echo
  # ⭐ [CT.1] La deriva se DECLARA, no se deduce.
  #
  # Este bloque imprimía UNA sola fecha de imagen, y eso se lee como "hay una versión". El
  # 2026-09-24 había CUATRO conviviendo y 7 de 8 carriles atrasados. La información estaba a
  # la vista —`docker ps` muestra el ID en la columna Image— pero que se pueda deducir no es
  # lo mismo que que esté dicho: nadie lo dedujo en 13 días.
  #
  # Un contenedor con imagen huérfana (sin tag) imprime su ID y no coincide con `latest`.
  #
  # ⭐⭐ [CPU.4 2026-09-28] AHORA COMPARA CÓDIGO, NO SÓLO IDENTIDAD DE IMAGEN — y la diferencia
  # no es teórica: este bloque marcó **7 carriles con código VIEJO** y, comparando `md5sum`
  # archivo por archivo DENTRO de los contenedores, **6 de los 7 corrían código byte-idéntico**
  # (`replicate-ods-live.js`, `reconcile-ods-window.js`, `live-tickets-poller.js`,
  # `kepler-branches.js`, `sink.js`, `cron-heartbeat.js`, `apply-handlers.js`). El único que
  # difería de verdad era `feeds-livefast`, por `run-prod-feeds.js`.
  #
  # La causa es estructural: la imagen cambia de ID cuando **cualquier** sesión agrega un archivo
  # al contexto de build, aunque el código de los carriles no se haya tocado. Con ~10 sesiones
  # sobre el mismo repo eso pasa varias veces al día.
  #
  # ⛔ Y por qué importa arreglarlo en vez de convivir con el ruido: `[CT.1]` documentó una deriva
  # REAL —4 versiones conviviendo, 13 días sin que nadie lo notara— y con el chequeo por ID no se
  # puede distinguir una de la otra. Una alarma que grita en falso enseña a ignorar el tablero,
  # que es exactamente cómo la próxima deriva real vuelve a pasar 13 días inadvertida.
  #
  # El digest cubre lo que los carriles EJECUTAN (los .js/.sh que el Dockerfile copia). No cubre
  # `node_modules` a propósito: eso lo fija `package.json`, que si cambia sí cambia el código.
  echo "── Versión por carril ──"
  ssh_md '
    # ⚠️ Los comodines van ESCAPADOS: sin eso el shell de afuera los expande contra su CWD antes
    # de que `find` los vea, y el digest sale de un conjunto distinto en cada contenedor.
    DIG="find /app/database/importers /app/services/feeds-ingest /app/ops/vl /app/libs -type f \( -name \*.js -o -name \*.sh \) | sort | xargs md5sum | md5sum | cut -c1-12"
    ACT=$(docker image inspect -f "{{.Id}}" trade-ingest:latest 2>/dev/null | cut -c8-19)
    echo "  trade-ingest:latest = ${ACT:-NO EXISTE}"
    REF=$(docker run --rm trade-ingest:latest sh -c "$DIG" 2>/dev/null)
    echo "  digest del codigo   = ${REF:-NO MEDIDO}"
    echo
    viejos=0; cosmeticos=0
    for c in feeds-cron feeds-livefast store-poller ods-live-hot ods-live-mirror \
             ods-reconcile ods-reconcile-chicas ods-reconcile-full; do
      ID=$(docker inspect -f "{{.Image}}" "$c" 2>/dev/null | cut -c8-19)
      if [ -z "$ID" ]; then
        M="(no existe)"
      elif [ "$ID" = "$ACT" ]; then
        M="al dia"
      else
        D=$(docker exec "$c" sh -c "$DIG" 2>/dev/null)
        if [ -z "$D" ] || [ -z "$REF" ]; then
          M="** NO MEDIDO ** (no se pudo sacar el digest)"; viejos=$((viejos + 1))
        elif [ "$D" = "$REF" ]; then
          M="imagen vieja, MISMO codigo"; cosmeticos=$((cosmeticos + 1))
        else
          M="** CODIGO VIEJO ** ($D)"; viejos=$((viejos + 1))
        fi
      fi
      printf "  %-22s %-14s %s\n" "$c" "${ID:--}" "$M"
    done
    echo
    if [ "$viejos" -gt 0 ]; then
      echo "  ⛔ $viejos carril(es) con CODIGO viejo — corré: ops/vl/deploy.sh --todo"
    elif [ "$cosmeticos" -gt 0 ]; then
      echo "  ✓ los 8 corren el MISMO codigo ($cosmeticos con imagen vieja: deriva cosmetica,"
      echo "    la imagen cambio de ID por archivos ajenos al contexto de build. No urge)."
    else
      echo "  ✓ los 8 carriles en la misma imagen"
    fi'
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
