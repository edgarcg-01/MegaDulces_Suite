#!/bin/sh
# ops/prod/desplegar-ingesta.sh — `[OPS.ING.1]` la ingesta se despliega DESDE md, como la API.
#
#   sh ~/auto-deploy/repo/ops/prod/desplegar-ingesta.sh [<commit9>]
#
# Lo llama `auto-deploy.sh` (el vigía de `prod-release`) cuando la API ya sirve el commit, y se puede correr a
# mano en `md` con el mismo efecto. Corre DESDE EL CHECKOUT del despliegue (no desde `~/ops/prod`): la versión
# que actúa es la del commit sellado, sin que nadie la suba desde una laptop.
#
# ── ⛔ POR QUÉ EXISTE (2026-11-12) ─────────────────────────────────────────────────────────────────────────────
# Los once carriles del namespace `ingesta` (ODS, CAOS, feeds, relojes) SÓLO se desplegaban con
# `ops/vl/deploy.sh --k3s` corrido desde una laptop: `git archive` del árbol local → `docker build` en `md`. Sin
# laptop no había despliegue; con el `HEAD` local podía viajar código que el CI nunca aprobó; y `auto-deploy.sh`
# excluía a propósito `trade-ingest`. Además `md` dejó de compilar el 2026-10-31 (`[OPS.CI.1]`: los tres OOM que
# mataron a Postgres cayeron dentro de un `docker build`), y la ingesta era lo único que se seguía compilando ahí.
#
# ── QUÉ HACE ─────────────────────────────────────────────────────────────────────────────────────────────────
#  1. ⛔ Sólo el commit que la API YA SIRVE: ése pasó el sello del CI, las migraciones y el arranque. La ingesta no
#     corre un commit que la API no corre (mismo esquema, una sola verdad).
#  2. Por cada imagen que piden los manifiestos de `ingesta`, la etiqueta es el hash de lo que copia
#     (`etiqueta-imagen.sh`). Si el registro local ya la tiene, no se trae nada y el pod no se toca.
#  3. Si no la tiene: la DESCARGA de GHCR (la construyó `imagenes.yml`), verifica que sea de este commit por su
#     etiqueta OCI `revision`, y la publica en el registro local. Con `AUTO_DEPLOY_IMAGENES=local` la construye acá
#     (la vuelta atrás de `[OPS.CI.1]`, explícita).
#  4. Prevuelo: si falta una imagen en el registro local, NO se aplica nada.
#  5. Aplica los manifiestos `namespace: ingesta` (salvo `migracion: preparado`) y espera cada rollout. El que no
#     levanta se REVIERTE él solo; la API no se toca (su despliegue ya se verificó).
#  6. Late en `analytics.cron_runs` como `auto_deploy_ingesta`, aparte del latido de la API.
set -u

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_DIR" || exit 1
K3S_DIR="$REPO_DIR/ops/k3s"
KC="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
REGISTRO="${INGESTA_REGISTRO:-127.0.0.1:5000}"
HEALTH="${INGESTA_HEALTH_URL:-http://127.0.0.1:30080/api/health}"
GHCR="${AUTO_DEPLOY_GHCR:-ghcr.io/edgarcg-01}"
ESPERA_MIN="${INGESTA_GHCR_ESPERA_MIN:-30}"
TENANT="${CRON_TENANT_ID:-00000000-0000-0000-0000-00000000d01c}"
IMAGENES="${AUTO_DEPLOY_IMAGENES:-}"
if [ -z "$IMAGENES" ] && [ -f "$HOME/ops/prod/vigia.env" ]; then
  IMAGENES=$(sed -n 's/^[[:space:]]*AUTO_DEPLOY_IMAGENES=//p' "$HOME/ops/prod/vigia.env" | tail -1 | tr -d "\"' ")
fi
IMAGENES="${IMAGENES:-local}"

di() { echo "[$(date '+%F %T %Z')] ingesta: $*"; }
k() { KUBECONFIG="$KC" k3s kubectl "$@"; }
latir() {
  [ -f "$HOME/ops/prod/pgprod.sh" ] || return 0
  sh "$HOME/ops/prod/pgprod.sh" -q >/dev/null 2>&1 <<SQL || di "aviso: el latido no se pudo escribir"
INSERT INTO analytics.cron_runs (tenant_id, job_key, label, last_start, last_finish, status, note, host, updated_at)
VALUES ('$TENANT', 'auto_deploy_ingesta', 'Despliegue de la ingesta (sigue a la API)', now(), now(),
        '$(echo "$1" | sed "s/'/''/g")', '$(echo "$2" | sed "s/'/''/g")', 'md', now())
ON CONFLICT (tenant_id, job_key) DO UPDATE
  SET last_finish = now(), status = EXCLUDED.status, note = EXCLUDED.note, host = EXCLUDED.host, updated_at = now();
SQL
}
fallo() { di "FALLO: $1"; latir error "$1"; exit 1; }

# La imagen → su Dockerfile. Una imagen que los manifiestos piden y no está acá FRENA (no se saltea en silencio:
# es el defecto de la caída de caddy del 2026-10-01).
dockerfile_de() {
  case "$1" in
    trade-ingest)  echo ops/ingest/Dockerfile ;;
    trade-relojes) echo ops/relojes/Dockerfile ;;
    *) echo '' ;;
  esac
}

# ── 1. ¿Qué commit? El que sirve la API, y nada más ─────────────────────────────────────────────────────────
SHA=$(git rev-parse HEAD) || fallo "el checkout $REPO_DIR no es un repo"
COMMIT=$(echo "$SHA" | cut -c1-9)
PEDIDO="${1:-}"
if [ -n "$PEDIDO" ] && [ "$PEDIDO" != "$COMMIT" ]; then
  fallo "piden $PEDIDO y el checkout está en $COMMIT — no se despliega otro commit que el del checkout"
fi
SIRVE=$(curl -fsS --max-time 15 "$HEALTH" 2>/dev/null | sed -n 's/.*"commit":"\([0-9a-f]*\)".*/\1/p')
[ -n "$SIRVE" ] || fallo "no se pudo leer qué commit sirve la API ($HEALTH) — sin ese testigo NO se despliega"
if [ "$SIRVE" != "$COMMIT" ]; then
  fallo "la API sirve $SIRVE y el checkout está en $COMMIT: la ingesta sólo despliega el commit que ya pasó las compuertas del vigía"
fi
di "commit $COMMIT (el que sirve la API) · imágenes: $IMAGENES"

# ── 2-3. Las imágenes que piden los manifiestos de ingesta ──────────────────────────────────────────────────
MANIFIESTOS=''
for f in "$K3S_DIR"/*.yaml; do
  grep -q 'namespace: ingesta' "$f" || continue
  grep -q 'migracion: preparado' "$f" && continue
  MANIFIESTOS="$MANIFIESTOS $f"
done
[ -n "$MANIFIESTOS" ] || fallo "ningún manifiesto de ingesta en $K3S_DIR — ¿cambió la forma?"

# shellcheck disable=SC2086
PIDEN=$(sed -n 's#^[[:space:]]*image:[[:space:]]*localhost:5000/\([A-Za-z0-9._-]*\):__COMMIT__.*#\1#p' $MANIFIESTOS | sort -u)
[ -n "$PIDEN" ] || fallo "los manifiestos de ingesta no piden ninguna imagen del registro — ¿cambió la forma?"

en_registro() { # en_registro <img> <tag>
  curl -fsS -o /dev/null \
    -H 'Accept: application/vnd.docker.distribution.manifest.v2+json' \
    -H 'Accept: application/vnd.oci.image.manifest.v1+json' \
    -H 'Accept: application/vnd.oci.image.index.v1+json' \
    "http://$REGISTRO/v2/$1/manifests/$2" 2>/dev/null
}

SUST=''
for img in $PIDEN; do
  df=$(dockerfile_de "$img")
  [ -n "$df" ] || fallo "los manifiestos piden $img y este guion no sabe con qué Dockerfile se hace — agregalo en dockerfile_de()"
  tag=$(sh "$REPO_DIR/ops/prod/etiqueta-imagen.sh" "$df" HEAD) || fallo "no se pudo calcular la etiqueta de $img"
  SUST="$SUST -e s#localhost:5000/$img:__COMMIT__#localhost:5000/$img:$tag#g"
  if en_registro "$img" "$tag"; then
    di "  $img:$tag ya está en el registro — su código no cambió"
    continue
  fi
  if [ "$IMAGENES" = ghcr ]; then
    ref="$GHCR/$img:$SHA"
    fin=$(( $(date +%s) + ESPERA_MIN * 60 ))
    di "  $img:$tag es nueva — la trae de GHCR ($ref)"
    until docker pull -q "$ref" >"/tmp/ingesta-pull-$img.log" 2>&1; do
      [ "$(date +%s)" -ge "$fin" ] && fallo "GHCR no tiene $ref tras ${ESPERA_MIN} min — $(tail -1 "/tmp/ingesta-pull-$img.log") (¿corrió «Imágenes (GHCR)» para este commit? ¿el paquete es público?)"
      sleep 30
    done
    rev=$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$ref" 2>/dev/null)
    [ "$rev" = "$SHA" ] || fallo "la imagen $ref dice revision=${rev:-vacía}, no $SHA"
    docker tag "$ref" "localhost:5000/$img:$tag"
  else
    di "  $img:$tag es nueva — se construye acá (AUTO_DEPLOY_IMAGENES=$IMAGENES)"
    docker build -q -f "$df" -t "localhost:5000/$img:$tag" . >"/tmp/ingesta-build-$img.log" 2>&1 \
      || { tail -15 "/tmp/ingesta-build-$img.log" | sed 's/^/      /'; fallo "no compiló $img"; }
  fi
  docker push "localhost:5000/$img:$tag" >/dev/null 2>&1 || fallo "no se pudo publicar localhost:5000/$img:$tag"
  di "  publicada localhost:5000/$img:$tag"
done

# ── 4. Prevuelo: nada se aplica si falta una imagen ─────────────────────────────────────────────────────────
for img in $PIDEN; do
  tag=$(sh "$REPO_DIR/ops/prod/etiqueta-imagen.sh" "$(dockerfile_de "$img")" HEAD)
  en_registro "$img" "$tag" || fallo "el registro no tiene $img:$tag — NO SE APLICA NADA"
done

# ── 5. Aplicar y esperar ────────────────────────────────────────────────────────────────────────────────────
ANTES=$(k get deploy -n ingesta -o jsonpath='{range .items[*]}{.metadata.name}={.metadata.generation}{"\n"}{end}' 2>/dev/null)
for f in $MANIFIESTOS; do
  # shellcheck disable=SC2086
  txt=$(sed $SUST "$f")
  # Sólo renglones que no son comentario: un `__COMMIT__` mencionado en un comentario no levanta ningún pod
  # (lo encontró la prueba de control con el comentario de `29-hr-relojes`).
  if printf '%s\n' "$txt" | grep -v '^[[:space:]]*#' | grep -q '__COMMIT__'; then
    fallo "$(basename "$f") todavía pide algo con __COMMIT__ después de sustituir — una imagen que este guion no conoce"
  fi
  printf '%s\n' "$txt" | k apply -f - >/dev/null || fallo "kubectl apply de $(basename "$f") falló"
done

CAMBIARON=''
for par in $(k get deploy -n ingesta -o jsonpath='{range .items[*]}{.metadata.name}={.metadata.generation}{"\n"}{end}' 2>/dev/null); do
  printf '%s\n' "$ANTES" | grep -qx "$par" || CAMBIARON="$CAMBIARON ${par%%=*}"
done
if [ -z "$CAMBIARON" ]; then
  di "ningún carril cambió — nada que reiniciar"
  latir ok "al día en $COMMIT (sin cambios en ingesta)"
  exit 0
fi

REVERTIDOS=''
for d in $CAMBIARON; do
  if k rollout status -n ingesta "deploy/$d" --timeout=180s >/dev/null 2>&1; then
    di "  ✓ $d"
  else
    di "  ⛔ $d no levantó — se revierte"
    k rollout undo -n ingesta "deploy/$d" >/dev/null 2>&1 || di "  ⛔ y la reversión de $d falló: revisar a mano"
    REVERTIDOS="$REVERTIDOS $d"
  fi
done
[ -z "$REVERTIDOS" ] || fallo "en $COMMIT no levantaron y se revirtieron:$REVERTIDOS"
di "DESPLEGADA en $COMMIT:$CAMBIARON"
latir ok "desplegada en $COMMIT:$CAMBIARON"
