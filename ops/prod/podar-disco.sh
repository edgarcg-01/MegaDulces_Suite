#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────────────────────
# `[VL.20.5]` EL DISCO DEJA DE CRECER SIN TOPE — y se puede saber si eso está pasando.
#
# ── Lo que lo obliga, medido en `md` el 2026-09-24 ──────────────────────────────────────────
#   · Caché de construcción: **80.23 GB**, de los cuales **58.56 GB reclamables**. `daemon.json`
#     no declara ninguna política de GC, así que nadie la recorta nunca.
#   · **12 etiquetas** de `trade-prod-api` y 12 de `trade-prod-worker`… con `RETENER_IMG=5`.
#   · Disco: 250 de 492 GB usados (volúmenes 96 GB, imágenes 26 GB).
#
# ⛔ Y el motivo de las 12 etiquetas no era que faltara la política: `podar_imagenes()` existía
# en `deploy.sh` y funciona. Pero el camino que despliega **7 veces al día** es
# `auto-deploy.sh`, que **nunca la llamaba**. La política estaba escrita en el carril que casi
# no se usa. Por eso ahora esto es UN script —no una función adentro de un guion— y lo llaman
# los tres: `deploy.sh`, `auto-deploy.sh` y la agenda.
#
# ── Por qué un cron y no `builder.gc` en `daemon.json` ──────────────────────────────────────
# Porque esa vía pide recargar el demonio de Docker, y el demonio de `md` sostiene producción.
# Un cron no toca el demonio.
#
# ⚠️ El techo NO es agresivo a propósito. Una poda que deja el caché en 5 GB se paga entera en
# el siguiente despliegue (vuelve a bajar deps, vuelve a compilar Angular). 30 GB alcanza para
# que `deps`, `src` y las dos capas de Nx sobrevivan entre despliegues, que es lo que hace que
# un deploy tarde 4 minutos y no 15.
#
# ⭐ LATE. Un carril de higiene sin latido es indistinguible de uno que no corre (ADR-053), y
# esta fase nació justamente de encontrar seis cosas que reportaban estar bien sin hacer nada.
# Reporta GB de caché e imágenes antes/después y el disco libre; se pone en `error` si tras
# podar el disco sigue por debajo del piso.
#
#   a mano:   sh ~/ops/prod/podar-disco.sh
#   tablero:  Salud BD → job_key = 'poda_disco'
# ─────────────────────────────────────────────────────────────────────────────────────────────
set -u

RETENER="${RETENER_IMG:-5}"
# La política PRINCIPAL es la edad (ver el bloque 2: el techo por tamaño está medido y no
# cumple). 72 h conserva el caché de los últimos ~3 días de despliegues, que es lo que hace que
# un build tarde ~4 min y no ~15.
EDAD_CACHE="${PODA_EDAD_CACHE:-72h}"
EDAD_APRETADA="${PODA_EDAD_APRETADA:-24h}"
TECHO_CACHE="${PODA_TECHO_CACHE:-30GB}"   # segunda pasada, best-effort — NO se le cree
TECHO_DURO_GB="${PODA_TECHO_DURO_GB:-45}" # pasado esto, se apura la edad una vez
PISO_LIBRE_GB="${PODA_PISO_LIBRE_GB:-60}"
TENANT="${CRON_TENANT_ID:-00000000-0000-0000-0000-00000000d01c}"
IMAGENES="trade-prod-pg trade-prod-api trade-prod-worker trade-prod-portal trade-prod-vendor trade-prod-backup trade-prod-caddy"

di() { echo "[$(date '+%F %T')] $*"; }

# GB usados por un renglón de `docker system df`, como entero.
#
# ⛔ Va por `--format` y NO por columnas del formato tabla. La tabla parece regular y no lo es:
# el renglón de imágenes termina en `18.32GB (65%)` —dos campos— y el del caché en `52.77GB`
# —uno—, así que un `$(NF-1)` acierta en Build Cache y en Images devuelve **lo reclamable en vez
# del tamaño**. Verificado contra la salida real de `md` antes de escribir esto.
# Se normaliza porque la unidad cambia sola según el tamaño (kB/MB/GB/TB).
usado_gb() { # usado_gb "Images" | usado_gb "Build Cache"
  docker system df --format '{{.Type}}|{{.Size}}' 2>/dev/null | awk -F'|' -v t="$1" '
    $1 == t {
      v=$2
      if (v ~ /TB$/) { sub("TB","",v); printf "%d", v*1024 }
      else if (v ~ /GB$/) { sub("GB","",v); printf "%d", v }
      else if (v ~ /MB$/) { sub("MB","",v); printf "%d", v/1024 }
      else printf "0"
      exit
    }'
}
cache_gb()    { usado_gb 'Build Cache'; }
imagenes_gb() { usado_gb 'Images'; }
libre_gb() { df -BG --output=avail / 2>/dev/null | tail -1 | tr -dc '0-9'; }

latir() { # latir <ok|error> <nota>
  _n=$(printf '%s' "$2" | sed "s/'/''/g")
  sh "$HOME/ops/prod/pgprod.sh" -q >/dev/null 2>&1 <<SQL || di "aviso: no se pudo escribir el latido"
INSERT INTO analytics.cron_runs (tenant_id, job_key, label, last_start, last_finish, status, note, host, updated_at)
VALUES ('$TENANT', 'poda_disco', 'Poda de imágenes y caché de construcción', now(), now(), '$1', '$_n', 'md', now())
ON CONFLICT (tenant_id, job_key) DO UPDATE
  SET last_finish = now(), status = EXCLUDED.status, note = EXCLUDED.note, host = EXCLUDED.host, updated_at = now();
SQL
}

c0=$(cache_gb); i0=$(imagenes_gb); l0=$(libre_gb)
di "antes: caché ${c0}GB · imágenes ${i0}GB · libre ${l0}GB"

# ── 1. Etiquetas de commit viejas ───────────────────────────────────────────────────────────
# ⚠️ NO toca `:latest` ni una imagen en uso — `docker rmi` de una etiqueta en uso falla, y acá
# ese fallo es benigno (se ignora): lo que importa es no dejar el disco creciendo.
# ⛔ Se ordena por fecha de creación, NO por nombre: las etiquetas son hashes de commit y
# ordenarlas alfabéticamente borraría versiones al azar — incluida, con mala suerte, justo
# aquella a la que uno querría volver.
for i in $IMAGENES; do
  docker images --format '{{.Tag}} {{.CreatedAt}}' "$i" 2>/dev/null \
    | grep -v '^latest ' | sort -k2,3 -r | tail -n +$((RETENER + 1)) | awk '{print $1}' \
    | while read -r t; do docker rmi "$i:$t" >/dev/null 2>&1 || true; done
done

# Capas sueltas de imágenes que ya no tienen ninguna etiqueta (las deja el `-t …:latest` al
# reapuntar). `--filter dangling=true` NO toca nada etiquetado, así que no puede borrar una
# versión a la que se quiera volver.
docker image prune --force --filter dangling=true >/dev/null 2>&1 || true

# ── 2. El caché de construcción — POR ANTIGÜEDAD, no por techo ──────────────────────────────
# ⛔ MEDIDO EL 2026-09-24, Y ES LO CONTRARIO DE LO QUE DECÍA LA DOCUMENTACIÓN DE ESTE SCRIPT
# EN SU PRIMERA VERSIÓN: `docker buildx prune --max-used-space=60GB` sobre un caché de 85 GB
# liberó 10 GB y se plantó en **75 GB**, con **62.64 GB marcados como reclamables**. Una
# segunda pasada con el mismo techo liberó **0 B**. O sea: la orden existe, no falla, imprime
# `Total: 0B` y **no pone el techo que su nombre promete**.
#
# ⚠️ Y la explicación fácil también era falsa: se sospechó de los *cache mounts* (que `prune`
# no toca sin `--all`), pero medidos son **1.0 GB de 75**; los otros **72.6 GB son caché de
# capas normal**, 1087 registros. No era eso.
#
# ⭐ Lo que SÍ funciona es el filtro por antigüedad: `--filter until=12h` sobre ese mismo caché
# liberó **14.34 GB** (75.11 → 60.76). Por eso la política principal es la edad, no el tamaño.
# La edad además es la forma correcta acá: lo que se quiere conservar es el caché de los
# últimos despliegues (el que hace que un build tarde 4 minutos y no 15), y eso es exactamente
# "lo usado hace poco".
#
# El techo queda como SEGUNDA pasada, best-effort. No se le cree; el veredicto son los GB
# reales de antes/después que van al latido.
docker buildx prune --force --filter "until=${EDAD_CACHE}" >/dev/null 2>&1 \
  || di "aviso: buildx prune por antigüedad falló — el caché NO se recortó"
docker buildx prune --force --max-used-space="$TECHO_CACHE" >/dev/null 2>&1 || true

# ── 3. Escalón, sólo si hace falta ──────────────────────────────────────────────────────────
# Si tras podar por antigüedad el caché sigue por encima del techo duro, se aprieta la edad una
# vez. ⛔ NO se escala a `--all`: eso borra también los cache mounts de npm y de Nx, y el
# siguiente despliegue saldría completamente en frío (~15 min en vez de ~4). Vaciar el caché es
# una decisión, no una rutina; si el escalón no alcanza, se DECLARA en el latido y lo mira una
# persona (ADR-056: lo que no se pudo resolver se dice, no se fuerza).
_c=$(cache_gb)
if [ "${_c:-0}" -gt "$TECHO_DURO_GB" ]; then
  di "caché en ${_c}GB sobre el techo duro de ${TECHO_DURO_GB}GB — se aprieta a until=${EDAD_APRETADA}"
  docker buildx prune --force --filter "until=${EDAD_APRETADA}" >/dev/null 2>&1 || true
fi

c1=$(cache_gb); i1=$(imagenes_gb); l1=$(libre_gb)
di "después: caché ${c1}GB · imágenes ${i1}GB · libre ${l1}GB"

nota="caché ${c0}→${c1}GB · imágenes ${i0}→${i1}GB · libre ${l0}→${l1}GB (edad $EDAD_CACHE, retener $RETENER)"
if [ "${l1:-0}" -lt "$PISO_LIBRE_GB" ]; then
  di "⛔ el disco quedó en ${l1}GB libres, por debajo del piso de ${PISO_LIBRE_GB}GB"
  latir error "$nota — POR DEBAJO DEL PISO de ${PISO_LIBRE_GB}GB, revisar a mano"
  exit 1
fi
latir ok "$nota"
