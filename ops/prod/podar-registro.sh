#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────────────────────
# `[OPS.DISCO.4]` EL REGISTRO DE IMÁGENES DEJA DE CRECER SIN TOPE.
#
# ── Lo que lo obliga, medido el 2026-10-19 ──────────────────────────────────────────────────
# `prod_registry-data` pesaba **34.5 GB** con 101–136 etiquetas por imagen (una por despliegue,
# desde el 1-oct) y nadie lo podaba nunca. `podar-disco.sh` ya lo declaraba («el blob del
# REGISTRO es otra cosa y sigue aparte … queda DECLARADO, no resuelto acá»). Esto lo resuelve.
#
# ── Qué conserva (todo lo demás se borra) ───────────────────────────────────────────────────
#   · Las RETENER etiquetas más NUEVAS de cada repositorio (por fecha del enlace de la etiqueta).
#   · ⛔ CUALQUIER imagen que k3s referencie: Deployments, CronJobs, Pods **y ReplicaSets** — los
#     ReplicaSets viejos son el historial de `kubectl rollout undo`; borrar su imagen deja el
#     rollback apuntando a la nada, y eso se descubre justo cuando hace falta.
#   · `latest`.
#   ⚠️ Se protege por DIGEST, no por nombre: el registro borra manifiestos por digest, y dos
#      etiquetas pueden compartirlo. Borrar el digest de una etiqueta vieja que comparte con una
#      conservada se llevaría la conservada.
#
# ── Cómo ────────────────────────────────────────────────────────────────────────────────────
#   1. DELETE del manifiesto por la API (el registro tiene REGISTRY_STORAGE_DELETE_ENABLED=true).
#   2. `registry garbage-collect` dentro del contenedor, que es lo que libera los blobs.
#   ⛔ Todo bajo `flock /tmp/auto-deploy.lock` — el MISMO candado que `vigia-ci-green.sh` y el cron
#      de despliegue. El GC con un push en curso puede borrar capas que el push acaba de subir;
#      con el candado, un despliegue y una poda no pueden coincidir.
#   ⛔ Si `kubectl` no devuelve qué imágenes están en uso, se ABORTA sin borrar: no se adivina.
#
#   simular (default):  sh ~/ops/prod/podar-registro.sh
#   aplicar:            sh ~/ops/prod/podar-registro.sh --aplicar
#   tablero:            Salud BD → job_key = 'poda_registro'
# ─────────────────────────────────────────────────────────────────────────────────────────────
set -u
RETENER="${RETENER_REG:-5}"
REG="${REGISTRO_URL:-http://localhost:5000}"
CONT="${REGISTRO_CONTENEDOR:-prod-registry}"
LOCK="${REGISTRO_LOCK:-/tmp/auto-deploy.lock}"
TENANT="${CRON_TENANT_ID:-00000000-0000-0000-0000-00000000d01c}"
APLICAR=0; [ "${1:-}" = "--aplicar" ] && APLICAR=1
ACEPTA='Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json'
RAIZ=/var/lib/registry/docker/registry/v2/repositories

di() { echo "[$(date '+%F %T')] $*"; }

# Re-entrar bajo el candado de despliegues. -w 600: si hay un despliegue en curso se espera hasta
# 10 min; si no se libera, se aborta sin tocar nada.
if [ -z "${PODAR_REGISTRO_CON_CANDADO:-}" ]; then
  PODAR_REGISTRO_CON_CANDADO=1 flock -w 600 -E 9 "$LOCK" /bin/sh "$0" "$@"
  rc=$?
  [ "$rc" = 9 ] && di "⛔ no se obtuvo el candado de despliegue en 10 min — NO se podó nada"
  exit "$rc"
fi

latir() { # latir <ok|error> <nota>
  [ "$APLICAR" = 1 ] || return 0
  _n=$(printf '%s' "$2" | sed "s/'/''/g")
  sh "$HOME/ops/prod/pgprod.sh" -q >/dev/null 2>&1 <<SQL || di "aviso: no se pudo escribir el latido"
INSERT INTO analytics.cron_runs (tenant_id, job_key, label, last_start, last_finish, status, note, host, updated_at)
VALUES ('$TENANT', 'poda_registro', 'Poda del registro de imágenes', now(), now(), '$1', '$_n', 'md', now())
ON CONFLICT (tenant_id, job_key) DO UPDATE
  SET label = EXCLUDED.label, last_finish = now(), status = EXCLUDED.status, note = EXCLUDED.note,
      host = EXCLUDED.host, updated_at = now();
SQL
}

peso_gb() { docker exec "$CONT" du -sm /var/lib/registry 2>/dev/null | awk '{printf "%.1f", $1/1024}'; }
digest_de() { # digest_de <repo> <tag>
  curl -fsS -I -H "$ACEPTA" "$REG/v2/$1/manifests/$2" 2>/dev/null \
    | awk -F': ' 'tolower($1)=="docker-content-digest"{gsub("\r","",$2); print $2}'
}

# Imágenes del registro que k3s referencia en cualquier objeto (incluido el historial de rollout).
EN_USO=$(kubectl get deploy,rs,cronjob,pod -A -o jsonpath='{range .items[*]}{range .spec.template.spec.containers[*]}{.image}{"\n"}{end}{range .spec.template.spec.initContainers[*]}{.image}{"\n"}{end}{range .spec.jobTemplate.spec.template.spec.containers[*]}{.image}{"\n"}{end}{range .spec.containers[*]}{.image}{"\n"}{end}{end}' 2>/dev/null \
  | grep '^localhost:5000/' | sed 's|^localhost:5000/||' | sort -u)
if [ -z "$EN_USO" ]; then
  di "⛔ kubectl no devolvió ninguna imagen del registro en uso — se aborta sin borrar nada"
  latir error "NO MEDIDO: no se pudo leer qué imágenes usa k3s; no se borró nada"
  exit 1
fi

p0=$(peso_gb)
di "registro ${p0}GB · $(echo "$EN_USO" | wc -l) imágenes en uso por k3s · retener $RETENER por repo · $( [ $APLICAR = 1 ] && echo APLICANDO || echo SIMULACIÓN )"

borrados=0; conservados=0; fallos=0
for repo in $(docker exec "$CONT" ls "$RAIZ" 2>/dev/null); do
  # Etiquetas de la más nueva a la más vieja (mtime del enlace de la etiqueta = cuándo se subió).
  tags=$(docker exec "$CONT" ls -t "$RAIZ/$repo/_manifests/tags" 2>/dev/null)
  [ -n "$tags" ] || continue
  # 1) Qué se conserva: las N más nuevas + las que usa k3s + latest. Se juntan sus DIGESTS.
  keep_d=""; i=0; b_repo=0
  for t in $tags; do
    i=$((i + 1))
    if [ "$i" -le "$RETENER" ] || [ "$t" = latest ] || echo "$EN_USO" | grep -qx "$repo:$t"; then
      d=$(digest_de "$repo" "$t")
      if [ -z "$d" ]; then di "⛔ sin digest para la etiqueta CONSERVADA $repo:$t — se salta el repo entero"; keep_d="ABORTA"; break; fi
      keep_d="$keep_d $d"
    fi
  done
  [ "$keep_d" = "ABORTA" ] && { fallos=$((fallos + 1)); continue; }
  # 2) Lo demás se borra por digest, salvo que el digest sea de algo conservado.
  for t in $tags; do
    d=$(digest_de "$repo" "$t")
    [ -n "$d" ] || continue
    case " $keep_d " in *" $d "*) conservados=$((conservados + 1)); continue ;; esac
    if [ "$APLICAR" = 1 ]; then
      if curl -fsS -o /dev/null -X DELETE "$REG/v2/$repo/manifests/$d"; then borrados=$((borrados + 1)); b_repo=$((b_repo + 1))
      else fallos=$((fallos + 1)); di "aviso: no se pudo borrar $repo:$t ($d)"; fi
    else
      borrados=$((borrados + 1)); b_repo=$((b_repo + 1))
    fi
    keep_d="$keep_d $d"   # mismo digest bajo otra etiqueta: ya se borró, no se intenta dos veces
  done
  di "  $repo: $(echo "$tags" | wc -l) etiquetas → $b_repo manifiestos a borrar"
done

if [ "$APLICAR" != 1 ]; then
  di "SIMULACIÓN: se borrarían $borrados manifiestos y se conservarían $conservados. Nada se tocó."
  exit 0
fi

di "manifiestos borrados: $borrados · conservados: $conservados · fallos: $fallos — recolectando blobs…"
docker exec "$CONT" registry garbage-collect /etc/docker/registry/config.yml >/dev/null 2>&1 \
  || { di "⛔ garbage-collect falló"; latir error "borrados $borrados manifiestos pero garbage-collect FALLÓ: no se liberó espacio"; exit 1; }
p1=$(peso_gb)
nota="registro ${p0}→${p1}GB · $borrados manifiestos borrados · $conservados conservados · $fallos fallos (retener $RETENER + lo que usa k3s)"
di "$nota"
if [ "$fallos" -gt 0 ]; then latir error "$nota"; exit 1; fi
latir ok "$nota"
