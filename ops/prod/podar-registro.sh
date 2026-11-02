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
# ⛔ `[OPS.DISCO.4b]` 2026-10-31: el registro corre en k3s (pod `registry`, OPS.LIMPIEZA.8) desde el
# 2026-10-20, y este script seguía haciendo `docker exec prod-registry` — el contenedor de Compose,
# `Exited` desde ese día. Nunca llegó a agendarse, así que nadie lo notó: el registro creció de
# 34.5 a 47.4 GB (183 etiquetas de `api`). Ahora todo pasa por el pod.
REG_NS="${REGISTRO_NS:-prod}"
REG_DEPLOY="${REGISTRO_DEPLOY:-registry}"
en_registro() { k3s kubectl exec -n "$REG_NS" "deploy/$REG_DEPLOY" -- "$@"; }
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

peso_gb() { en_registro du -sm /var/lib/registry 2>/dev/null | awk '{printf "%.1f", $1/1024}'; }
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
# Sin peso no hay pod alcanzable: seguir sería «podar» una lista vacía y latir ok sin haber hecho nada,
# que es exactamente como pasó desapercibido el `docker exec` contra un contenedor muerto.
if [ -z "$p0" ]; then
  di "⛔ no se pudo leer el registro (deploy/$REG_DEPLOY en $REG_NS) — se aborta sin borrar nada"
  latir error "NO MEDIDO: el pod del registro no respondió; no se borró nada"
  exit 1
fi
di "registro ${p0}GB · $(echo "$EN_USO" | wc -l) imágenes en uso por k3s · retener $RETENER por repo · $( [ $APLICAR = 1 ] && echo APLICANDO || echo SIMULACIÓN )"

borrados=0; conservados=0; fallos=0; huerfanos=0
for repo in $(en_registro ls "$RAIZ" 2>/dev/null); do
  # Etiquetas de la más nueva a la más vieja (mtime del enlace de la etiqueta = cuándo se subió).
  tags=$(en_registro ls -t "$RAIZ/$repo/_manifests/tags" 2>/dev/null)
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
  conserv_d="$keep_d"   # sólo lo conservado (keep_d crece abajo con lo que se borra)
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
  # 3) ⛔ `[OPS.DISCO.4c]` LOS HUÉRFANOS (2026-11-02). Docker 29 sube cada imagen como un ÍNDICE OCI
  #    con dos manifiestos hijos (imagen + atestación). El paso 2 borra el índice y los hijos quedan
  #    sin etiqueta pero vivos, reteniendo sus capas: medido, `trade-prod-api` tenía 11 etiquetas y
  #    573 revisiones, y la poda del 1-nov dio «registro 44.6→44.6GB». Acá se borra toda revisión que
  #    ninguna etiqueta CONSERVADA alcanza.
  #    ⛔ NO `garbage-collect --delete-untagged`: trata como «sin etiqueta» también a los hijos de un
  #    índice conservado y los borra — rompe justo las imágenes que se quieren guardar.
  #    Lo que se protege = cada digest conservado + TODO lo que su manifiesto referencia (hijos del
  #    índice; capas y config, que no son revisiones, sobran sin daño). Si un manifiesto conservado
  #    no se puede leer, se salta el repo entero: sin sus hijos no se sabe qué protege.
  vivos="$conserv_d"; h_repo=0; aborta_h=no
  for d in $conserv_d; do
    if ! m=$(curl -fsS -H "$ACEPTA" "$REG/v2/$repo/manifests/$d" 2>/dev/null); then
      di "⛔ no se pudo leer el manifiesto CONSERVADO $repo@$d — no se buscan huérfanos en este repo"; aborta_h=si; break
    fi
    vivos="$vivos $(printf '%s' "$m" | grep -oE 'sha256:[0-9a-f]{64}' | tr '\n' ' ')"
  done
  if [ "$aborta_h" = si ]; then fallos=$((fallos + 1)); else
    for h in $(en_registro ls "$RAIZ/$repo/_manifests/revisions/sha256" 2>/dev/null); do
      d="sha256:$h"
      case " $vivos $keep_d " in *" $d "*) continue ;; esac   # conservado, hijo de conservado, o ya tratado en 2)
      [ -n "${PODAR_LISTAR:-}" ] && echo "    huérfano $repo@$d"
      if [ "$APLICAR" = 1 ]; then
        if curl -fsS -o /dev/null -X DELETE "$REG/v2/$repo/manifests/$d"; then huerfanos=$((huerfanos + 1)); h_repo=$((h_repo + 1))
        else fallos=$((fallos + 1)); di "aviso: no se pudo borrar el huérfano $repo@$d"; fi
      else
        huerfanos=$((huerfanos + 1)); h_repo=$((h_repo + 1))
      fi
    done
  fi
  di "  $repo: $(echo "$tags" | wc -l) etiquetas → $b_repo manifiestos a borrar · $h_repo huérfanos"
done

if [ "$APLICAR" != 1 ]; then
  di "SIMULACIÓN: se borrarían $borrados manifiestos etiquetados y $huerfanos huérfanos; se conservarían $conservados. Nada se tocó."
  exit 0
fi

di "manifiestos borrados: $borrados · huérfanos: $huerfanos · conservados: $conservados · fallos: $fallos — recolectando blobs…"
en_registro registry garbage-collect /etc/docker/registry/config.yml >/dev/null 2>&1 \
  || { di "⛔ garbage-collect falló"; latir error "borrados $borrados manifiestos pero garbage-collect FALLÓ: no se liberó espacio"; exit 1; }
# ⛔ El registro trae `cache: blobdescriptor: inmemory`: después del GC sigue «recordando» blobs que
# ya no están en disco, y un push posterior puede saltarse la subida de una capa que ya no existe
# (imagen rota que se descubre al desplegar). Reiniciar el pod vacía esa caché. Es `Recreate`:
# unos segundos sin registro, que sólo afectan a un pull — y estamos bajo el candado de despliegue.
k3s kubectl rollout restart -n "$REG_NS" "deploy/$REG_DEPLOY" >/dev/null 2>&1 \
  && k3s kubectl rollout status -n "$REG_NS" "deploy/$REG_DEPLOY" --timeout=180s >/dev/null 2>&1 \
  || { di "⛔ el registro no volvió tras el reinicio"; latir error "GC hecho pero el registro NO volvió del reinicio — revisar deploy/$REG_DEPLOY"; exit 1; }
p1=$(peso_gb)
nota="registro ${p0}→${p1}GB · $borrados manifiestos borrados · $huerfanos huérfanos · $conservados conservados · $fallos fallos (retener $RETENER + lo que usa k3s)"
di "$nota"
if [ "$fallos" -gt 0 ]; then latir error "$nota"; exit 1; fi
latir ok "$nota"
