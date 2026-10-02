#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# [K3S.26] APLICA LOS MANIFIESTOS DE PROD A K3s, con el commit sustituido.
#
#     sh ~/ops/prod/aplicar-k3s-prod.sh <commit>
#
# ── Por qué existe, y por qué existe ANTES de que haga falta ────────────────
#
# El 2026-10-01 los pods del ODS quedaron 36 commits atrás y le sirvieron ese build a los
# usuarios internos durante horas, con todos los rótulos en verde. La causa no fue un error
# de dedo: era que NO HABÍA camino. Las imágenes entraban a containerd a mano y los
# manifiestos se aplicaban a mano, así que bastaba con que alguien se olvidara una vez.
#
# El mismo día se intentó mover `portal` y `vendor` al clúster y se tuvo que REVERTIR en el
# acto, porque `auto-deploy.sh` actualizaba Compose y no K3s: el primer despliegue compartido
# los habría dejado viejos en silencio. Este guion es lo que faltaba para que ese corte sea
# permanente en vez de una promesa.
#
# ⭐ HOY ES UN NO-OP A PROPÓSITO, y eso es una virtud, no un defecto. Los manifiestos de prod
# están marcados `migracion: preparado` —corren en Compose—, así que esto no aplica nada y
# sale 0. El día que una app se marque `migrado`, el camino ya está puesto y probado. Construir
# el camino el día del corte es cómo el corte termina haciéndose a mano.
#
# ── Las dos cosas que NO hace, y por qué ────────────────────────────────────
#
# ⛔ NO toca el namespace `ingesta`. Esos carriles los despliega `ops/vl/deploy.sh`, que
#    construye `trade-ingest` — una imagen que este carril NO construye. Si aplicara sus
#    manifiestos con SU commit, pediría `localhost:5000/trade-ingest:<commit-de-prod>`, que no
#    existe, y los siete carriles del ODS caerían en ImagePullBackOff. El filtro por namespace
#    es lo único que separa dos cadencias de build que comparten repo.
#
# ⛔ NO aplica los `migracion: preparado`. Un `kubectl apply -f ops/k3s/` a secas levantaría
#    también lo que corre en Compose y crearía el doble-corredor AL INSTANTE y en silencio.
#    `npm run check:k3s` exige que un archivo no mezcle los dos estados — es lo único que
#    vuelve válido este filtro por archivo.
#
# ⚠️ Lee de `~/ops/k3s/`, la copia INSTALADA, no del clon que mantiene `auto-deploy.sh`. Es el
#    mismo criterio que ya rige para `auto-deploy.sh` y `verificar.sh`: el carril corre lo que
#    se instaló a propósito, así un commit malo no puede dejar sin carril al mecanismo que
#    tendría que revertirlo. La copia la pone `subir_compose` de `ops/prod/deploy.sh`.
# ─────────────────────────────────────────────────────────────────────────────
set -u

COMMIT="${1:-}"
[ -n "$COMMIT" ] || { echo "⛔ falta el commit:  sh aplicar-k3s-prod.sh <commit>"; exit 2; }

DIR="${K3S_DIR:-$HOME/ops/k3s}"
export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"

# Ausencias DECLARADAS, no asumidas: en una máquina sin clúster esto no es una falla, es que no
# hay nada que aplicar. Salir 1 acá rompería el despliegue de Compose por una pieza que no existe.
command -v k3s >/dev/null 2>&1 || { echo "   (no hay k3s en este host: nada que aplicar)"; exit 0; }
[ -d "$DIR" ] || { echo "   (no existe $DIR: nada que aplicar)"; exit 0; }

# ═══ [K3S.41] EL PREVUELO: LA IMAGEN SE COMPRUEBA ANTES DE MATAR AL POD VIEJO ═══════════════
#
# ⛔ ESTO EXISTE POR UNA CAÍDA REAL DE 32 MINUTOS — 2026-10-01, 21:06 a 21:38.
#
# `caddy` migró al clúster y su manifiesto pasó a pedir `localhost:5000/trade-prod-caddy:__COMMIT__`.
# El publicador —acá y en `auto-deploy.sh`— llevaba una lista A MANO de CUATRO imágenes (las
# apps) y nadie la extendió. Entonces cada despliegue renderizaba un commit nuevo en el
# manifiesto de `caddy` y pedía una imagen que el registry no tenía.
#
# El guardián de abajo SÍ disparó, y su mensaje decía:
#
#     "Los pods VIEJOS siguen sirviendo (maxUnavailable=0), así que NO hay caída"
#
# ⛔ ERA FALSO, y justo para el único servicio que importaba. Medido: de los 9 deployments de
# prod, CINCO son `Recreate` —caddy, worker, redis, pg-rag, pgvector-md— y `Recreate` mata al
# viejo ANTES de crear al nuevo. La frase es cierta para api/portal/vendor y falsa para los
# otros cinco. Una garantía que vale para la mayoría, impresa como si valiera para todos, es
# cómo un guardián que funcionó se lee como "no pasó nada".
#
# ⭐ El arreglo de fondo no es el mensaje: es NO APLICAR. Una imagen que no está en el registry
# no va a aparecer por aplicar el manifiesto — pero aplicarlo sí alcanza para matar al pod que
# estaba sirviendo. Se comprueba ANTES, y si falta una sola, no se toca NADA.
#
# ⚠️ Sólo se comprueban las imágenes del registry local. Las de Docker Hub (`redis`,
# `cloudflared`, `busybox`, `pgvector`) las resuelve el kubelet y no dependen del despliegue.
_faltan=''
for f in "$DIR"/*.yaml; do
  [ -f "$f" ] || continue
  grep -q 'namespace: prod' "$f" || continue
  grep -q 'migracion: preparado' "$f" && continue
  for _img in $(sed -n 's#^[[:space:]]*image:[[:space:]]*localhost:5000/\([A-Za-z0-9._-]*\):__COMMIT__.*#\1#p' "$f" | sort -u); do
    case " $_faltan " in *" $_img "*) continue ;; esac
    curl -fsS -o /dev/null \
      -H 'Accept: application/vnd.docker.distribution.manifest.v2+json' \
      -H 'Accept: application/vnd.oci.image.manifest.v1+json' \
      -H 'Accept: application/vnd.oci.image.index.v1+json' \
      "http://127.0.0.1:5000/v2/$_img/manifests/$COMMIT" 2>/dev/null \
      || _faltan="$_faltan $_img"
  done
done
if [ -n "$_faltan" ]; then
  echo "   ⛔ NO SE APLICA NADA: el registry no tiene estas imágenes en :$COMMIT —$_faltan"
  echo "      Aplicar igual mataría a los pods Recreate (caddy, worker, redis, los Postgres)"
  echo "      ANTES de descubrir que no hay con qué reemplazarlos. Eso es una caída, no un"
  echo "      despliegue fallido: pasó el 2026-10-01 y costó 32 minutos de sitio abajo."
  echo "      Quien publica es publicar_prod (deploy.sh) y el bloque [K3S.24] de auto-deploy.sh."
  echo "      Comprobar:  curl -s http://127.0.0.1:5000/v2/<imagen>/tags/list"
  exit 1
fi

aplicados=0
for f in "$DIR"/*.yaml; do
  [ -f "$f" ] || continue
  b=$(basename "$f")
  # Sólo prod. Ver arriba: el namespace es lo que separa las dos cadencias de build.
  grep -q 'namespace: prod' "$f" || continue
  if grep -q 'migracion: preparado' "$f"; then
    echo "   — $b (PREPARADO: corre en Compose, no se aplica)"
    continue
  fi
  if sed "s/__COMMIT__/$COMMIT/g" "$f" | k3s kubectl apply -f - >/dev/null 2>&1; then
    echo "   ✓ $b"
    aplicados=$((aplicados + 1))
  else
    echo "   ⛔ falló al aplicar $b"
    echo "      Si dice ImagePullBackOff: la imagen :$COMMIT no está en el registry."
    echo "      Se publica en el paso anterior del despliegue (publicar_prod / [K3S.24])."
    exit 1
  fi
done

if [ "$aplicados" -eq 0 ]; then
  echo "   ningún manifiesto de prod está MIGRADO: nada que aplicar (no es un error)"
  exit 0
fi

# ── La espera, con corte temprano ───────────────────────────────────────────────────────────
#
# ⚠️ 'rollout complete' dice que el pod ARRANCÓ, no que esté sirviendo. El veredicto de verdad
# lo da quien llama: `auto-deploy.sh` le pregunta el commit a cada réplica después de esto.
#
# ⛔ SE CORTA ANTE UN FALLO DE DESCARGA EN VEZ DE AGOTAR LA VENTANA, y esto se escribió DESPUÉS
# de medirlo: un `rollout status --timeout=180s` por deployment son 15 minutos colgado si la
# imagen no está. Y este carril corre bajo `flock -n`, así que mientras cuelga los siguientes
# ticks se saltean: un despliegue trabado deja a producción sin carril de despliegue.
#
# Una imagen que no está no va a aparecer esperando.
#
# ⭐ MEDIDO el 2026-10-01 aplicando a propósito un commit inexistente: con `maxUnavailable: 0`
# el pod NUEVO queda en ImagePullBackOff y los VIEJOS siguen sirviendo. O sea que una imagen
# mala NO tira el servicio — pero tampoco se cura sola, y el despliegue no ocurrió. Por eso
# esto sale 1: para que el carril lo reporte como error en vez de como DESPLEGADO.
echo "   ── esperando a que los pods tomen la imagen ──"
_fin=$(( $(date +%s) + 150 ))
while :; do
  _malos=$(k3s kubectl get pods -n prod \
    -o jsonpath='{range .items[*]}{.status.containerStatuses[*].state.waiting.reason}{"\n"}{end}' 2>/dev/null \
    | grep -cE 'ImagePullBackOff|ErrImagePull' || true)
  if [ "${_malos:-0}" -gt 0 ]; then
    # ⛔ ACÁ DECÍA "NO hay caída" Y ERA FALSO PARA CINCO DE NUEVE DEPLOYMENTS.
    # `maxUnavailable` protege a los que tienen réplicas (api, portal, vendor). Los `Recreate`
    # —caddy, worker, redis, pg-rag, pgvector-md— matan al viejo ANTES de crear al nuevo, así
    # que para ellos una imagen que falta ES el servicio abajo. Se mide y se dice cuál.
    _recrear=$(k3s kubectl get deploy -n prod \
      -o jsonpath='{range .items[*]}{.metadata.name}:{.spec.strategy.type}:{.status.availableReplicas}{"\n"}{end}' 2>/dev/null \
      | awk -F: '$2 == "Recreate" && ($3 == "" || $3 == "0") { print $1 }' | tr '\n' ' ')
    echo "   ⛔ $_malos pod(s) no pueden descargar la imagen :$COMMIT"
    if [ -n "$(echo "$_recrear" | tr -d ' ')" ]; then
      echo "      ⛔⛔ Y HAY SERVICIO ABAJO: $_recrear"
      echo "      (son Recreate: el pod viejo ya no existe. NO esperes a que se cure solo.)"
    else
      echo "      Los deployments con réplicas siguen sirviendo con los pods viejos."
    fi
    echo "      El despliegue NO ocurrió. Verificá que la imagen esté publicada:"
    echo "        curl -s http://127.0.0.1:5000/v2/<imagen>/tags/list"
    exit 1
  fi
  _falta=$(k3s kubectl get deploy -n prod \
    -o jsonpath='{range .items[*]}{.metadata.name}:{.status.updatedReplicas}/{.spec.replicas}/{.status.availableReplicas} {end}' 2>/dev/null \
    | tr ' ' '\n' | awk -F: '
        # ⛔ Un deployment en `replicas: 0` está apagado A PROPÓSITO (es lo que significa
        # `preparado`) y NUNCA converge: sus campos de estado ni siquiera existen, así que
        # jsonpath devuelve vacío. La primera versión los comparaba igual y el guion se colgaba
        # los 150 s esperando a `api`, `redis` y `worker` — tres deployments que nadie pidió
        # levantar. Medido el 2026-10-01: salía 1 sobre un apply perfectamente exitoso.
        NF==2 {
          split($2, a, "/")
          u = (a[1] == "" ? 0 : a[1]); d = (a[2] == "" ? 0 : a[2]); v = (a[3] == "" ? 0 : a[3])
          if (d > 0 && (u != d || v != d)) print $1
        }' | tr '\n' ' ')
  [ -z "$(echo "$_falta" | tr -d ' ')" ] && { echo "   ✓ todos los deployments de prod al día en :$COMMIT"; break; }
  if [ "$(date +%s)" -ge "$_fin" ]; then
    echo "   ⛔ se agotó la ventana con estos sin converger: $_falta"
    echo "      No es un fallo de descarga (eso se detecta aparte): mirá los eventos con"
    echo "        k3s kubectl describe pod -n prod <pod>"
    exit 1
  fi
  sleep 5
done
