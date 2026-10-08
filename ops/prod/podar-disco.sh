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
# ─────────────────────────────────────────────────────────────────────────────────────────────
# `[CD.22]` LA PODA ESTABA OPTIMIZANDO EL RECURSO EQUIVOCADO, Y COSTABA 10 MINUTOS POR DESPLIEGUE
#
# Lo que decía esta línea —«72 h … hace que un build tarde ~4 min y no ~15»— quedó medido y es
# optimista: el 2026-10-06, con el caché tal como lo deja esta poda, reconstruir las etapas del
# `api` costó
#
#     deps  (npm ci) ......... 416 s      ⬅ 6 min 56 s
#     src   (copiar el repo) . 215 s      ⬅ 3 min 35 s
#     build-api (Angular+Nest) ... 8 s
#     runner-api ................. 2 s
#     tocar main.ts y reconstruir  2 s    ⬅ con el caché caliente, TODO el sistema son 2 s
#
# ⭐ Compilar el código cuesta 8 segundos. Los 10:31 restantes son rehacer lo que esta poda
#    acababa de tirar. Y `deps` sólo cambia de verdad si cambia `package-lock.json`: medido,
#    **11 de 1,916 commits**. Se estaba reconstruyendo en el 99.4 % de los casos sin motivo.
#
# ⛔ Y el disco no lo justificaba. Medido el mismo día:
#
#     pgbackrest ....... 97 GB      volúmenes ... 115.6 GB
#     backups .......... 20 GB      imágenes ..... 23.3 GB
#     caché de build ... 16.9 GB    ⬅ el 5.6 % de los 303 GB usados, con 168 GB LIBRES
#
#    Se podaba cada 72 h lo que menos pesa y más cuesta rehacer, mientras 212 GB de respaldos y
#    volúmenes nadie los miraba. La poda no estaba de más: estaba apuntada al lugar equivocado.
#
# ⚠️ LOS DOS NÚMEROS SE MUEVEN JUNTOS O NO SIRVE DE NADA. Subir sólo la edad quedaba anulado por
#    `TECHO_DURO_GB`, que al superarse aprieta a `EDAD_APRETADA` y se lleva lo mismo que acabamos
#    de proteger. Con 168 GB libres, un caché de hasta 90 GB es el 18 % del disco: cabe.
#
# ⚠️ `PISO_LIBRE_GB` queda igual (60 GB) y sigue siendo el freno de verdad: si el disco se
#    aprieta, la poda aprieta, sin importar estos números. Eso es lo que hace seguro subirlos.
# ─────────────────────────────────────────────────────────────────────────────────────────────
EDAD_CACHE="${PODA_EDAD_CACHE:-336h}"     # 14 días — cubre una quincena sin desplegar
EDAD_APRETADA="${PODA_EDAD_APRETADA:-72h}" # lo que ANTES era el default, ahora es la emergencia
TECHO_CACHE="${PODA_TECHO_CACHE:-80GB}"   # segunda pasada, best-effort — NO se le cree
TECHO_DURO_GB="${PODA_TECHO_DURO_GB:-90}" # pasado esto, se apura la edad una vez
# ⭐ El PISO es el único número que de verdad importa: es el que decide si se escala (§4). El
# techo del caché es un medio; esto es el fin. Referencia medida: el kubelet marca `DiskPressure`
# por debajo del **10% de `nodefs`** — en los 492 GB de `md`, unos 49 GB. 60 deja margen para que
# la poda actúe ANTES de que el nodo empiece a desalojar pods, no después.
PISO_LIBRE_GB="${PODA_PISO_LIBRE_GB:-60}"
# Edad mínima de una imagen sin usar para que el escalón de §4 la borre. 7 días conserva las
# imágenes base de la semana (volver a bajarlas cuesta segundos, pero sin motivo no se tiran).
EDAD_IMG="${PODA_EDAD_IMG:-168h}"
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

# ── 4. ⭐ EL ÚLTIMO PELDAÑO: si el disco sigue bajo el piso, se escala hasta resolver ────────
#
# ⛔ **POR QUÉ EXISTE: el 2026-10-08 producción se cayó.** `DiskPressure=True`, el kubelet puso
# `node.kubernetes.io/disk-pressure:NoSchedule` y desalojó a `pg-prod`. Con la base afuera, nada
# arrancaba. 27 GB libres de 492.
#
# ⭐ **Y este script había corrido tres veces ese día, con la prueba delante, sin hacer nada:**
#     `caché 95→95GB · imágenes 74→74GB · libre 33→33GB`
# Liberó CERO las tres, incluido su escalón de emergencia. Tenía la medición del antes/después,
# que es exactamente la evidencia de que no sirvió, y se limitó a escribirla y salir con 1. El
# aviso tampoco salió: el correo lleva meses fallando (`Application-specific password required`).
# *Una poda que no comprueba si podó es un adorno; declarar sin actuar, con el disco llenándose,
# es mirar el incendio y anotar la temperatura.*
#
# ⛔ **Lo que quedó refutado:** la política de edad de §2 NO alcanza acá. Medido ese día, sobre un
# caché de 95 GB: `until=336h` liberó 0 y `until=72h` liberó 0. Con despliegues cada hora **todo
# el caché cuenta como usado hace poco**, así que *ninguna edad practicable muerde*. Lo que sí
# resolvió fue `builder prune -af`: **46 GB, 38 → 115 GB libres**, y el nodo se recuperó solo
# cuando venció el periodo de transición de 5 min del kubelet.
#
# ⚠️ El reparo de §3 contra `--all` sigue siendo CIERTO: vacía los cache mounts de npm y de Nx y
# el próximo despliegue sale en frío (~15 min en vez de ~4). Lo que cambia es la comparación.
# **Quince minutos de build no se comparan con producción caída**, y eso dejó de ser hipótesis.
# Por eso el disparador NO es el techo del caché —que es un medio— sino **el piso de disco libre**,
# que es el fin. Mientras haya espacio, no se toca nada aunque el caché esté gordo.
#
# El orden va de menos a más doloroso: primero imágenes (volver a bajarlas es rápido), y sólo
# después el caché (recompilar es lo caro).
escalon() { # escalon <rótulo> <comando…>
  _r="$1"; shift
  _l=$(libre_gb)
  [ "${_l:-0}" -ge "$PISO_LIBRE_GB" ] && return 0
  di "libre ${_l}GB < piso ${PISO_LIBRE_GB}GB — escalando: $_r"
  "$@" >/dev/null 2>&1 || di "aviso: el escalón '$_r' falló"
  di "   tras '$_r': libre $(libre_gb)GB"
}

# ⚠️ Acotado por edad a propósito: las imágenes base de los últimos días se conservan. Y NO toca
# lo que k3s sirve — los pods tiran de `localhost:5000`, que es un VOLUMEN, no estas imágenes.
escalon "imágenes sin usar de más de ${EDAD_IMG:-168h}" \
  docker image prune -af --filter "until=${EDAD_IMG:-168h}"
escalon "caché de construcción COMPLETO (el próximo build sale en frío)" \
  docker buildx prune -af

c1=$(cache_gb); i1=$(imagenes_gb); l1=$(libre_gb)
di "después: caché ${c1}GB · imágenes ${i1}GB · libre ${l1}GB"

nota="caché ${c0}→${c1}GB · imágenes ${i0}→${i1}GB · libre ${l0}→${l1}GB (edad $EDAD_CACHE, retener $RETENER)"
if [ "${l1:-0}" -lt "$PISO_LIBRE_GB" ]; then
  # Acá sí se agotó lo que este script puede hacer: ya escaló hasta vaciar el caché entero.
  # Lo que queda ocupando no es basura de construcción y lo tiene que mirar una persona —
  # el 2026-10-08 eran 122 GB de `~/pgbackrest` y 131 GB de volúmenes de Docker.
  di "⛔ el disco quedó en ${l1}GB libres, por debajo del piso de ${PISO_LIBRE_GB}GB — Y YA SE ESCALÓ TODO"
  latir error "$nota — BAJO EL PISO de ${PISO_LIBRE_GB}GB tras escalar hasta vaciar el caché: lo que ocupa NO es basura de build, revisar a mano"
  exit 1
fi
latir ok "$nota"
