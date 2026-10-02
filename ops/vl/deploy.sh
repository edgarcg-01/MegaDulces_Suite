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
# [K3S.21] `ops/k3s` viaja: los manifiestos se aplican desde la copia de HEAD en `md`, no desde
# lo que alguien tenga en su editor. Antes no viajaban porque se aplicaban A MANO, que es
# exactamente el camino que esta entrega cierra.
RUTAS="ops/ingest ops/vl ops/k3s database/importers database/scripts services/feeds-ingest libs/platform-core/src/lib/provenance/target-guard.js"
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
# � [K3S.6 2026-10-01] `ods-reconcile-chicas` SALIO de esta lista: vive en K3s desde hoy.
# No es cosmetico. Los dos mundos comparten ODS_RECONCILE_HB_KEY=cdc_reconcile_chicas, asi que
# si --todo lo resucitara en Compose habria DOS duenos del mismo renglon de analytics.cron_runs
# peleandoselo -- la falla que la guarda de dueno de health.js detecta, causada por nosotros.
# El servicio sigue declarado en el compose bajo el perfil `retirado-k3s`: no arranca solo.
# Lo candadea `npm run check:k3s` (bloque "ningun carril en los dos mundos").
SERVICIOS_DEF="ods-reconcile-full"

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
    # ⭐ [INFRA.5 2026-09-30] `/app/ops/ingest` FALTABA, y es donde vive `health.js` — el código
    # que decide si un carril está `healthy` y, por lo tanto, si `ods-autoheal` lo reinicia. O sea
    # que el detector de deriva no hasheaba al que decide la salud. Medido el día que se encontró,
    # con `ods-reconcile-full` corriendo código viejo de verdad:
    #
    #            digest sin ops/ingest    digest con ops/ingest
    #   latest        9f90143b18af             9dcdd3d5107b
    #   el carril     9f90143b18af  ← "igual"  9efbf981013b  ← DISTINTO
    #
    # Su `health.js` tenía md5 `5d88e4fa…` contra `d50d567d…` de la imagen, y **cero** ocurrencias
    # de `otroEntregando` (la caducidad del guard de dueño, `[OBS.4.4]`) contra 5 en los otros
    # siete. El detector igual imprimía «imagen vieja, MISMO codigo».
    # Son **2 archivos de 194**: un punto ciego del 1% que escondía un healthcheck viejo.
    DIG="find /app/database/importers /app/services/feeds-ingest /app/ops/ingest /app/ops/vl /app/libs -type f \( -name \*.js -o -name \*.sh \) | sort | xargs md5sum | md5sum | cut -c1-12"
    ACT=$(docker image inspect -f "{{.Id}}" trade-ingest:latest 2>/dev/null | cut -c8-19)
    echo "  trade-ingest:latest = ${ACT:-NO EXISTE}"
    REF=$(docker run --rm trade-ingest:latest sh -c "$DIG" 2>/dev/null)
    echo "  digest del codigo   = ${REF:-NO MEDIDO}"
    echo
    viejos=0; cosmeticos=0
    # ⛔ [K3S.32] SÓLO LOS QUE DE VERDAD SIGUEN EN COMPOSE. Esta lista tenía los ocho carriles y
    # siete viven en K3s desde hoy: imprimía «(no existe)» siete veces y NO lo contaba como
    # problema, así que cerraba con «✓ los 8 carriles en la misma imagen» sobre siete ausencias.
    # Los pods se miden en el bloque de abajo, con su propio digest.
    # ⚠️ Si un carril vuelve a Compose, vuelve a esta línea — y `npm run check:k3s` lo exige
    # comparando contra la etiqueta `migracion:` de ops/k3s/*.yaml.
    for c in ods-reconcile-full; do
      ID=$(docker inspect -f "{{.Image}}" "$c" 2>/dev/null | cut -c8-19)
      if [ -z "$ID" ]; then
        # Ahora SÍ cuenta: si este guion lo nombra, es porque debería estar.
        M="** NO EXISTE ** (deberia estar en Compose)"; viejos=$((viejos + 1))
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
      echo "  ✓ los de Compose corren el MISMO codigo ($cosmeticos con imagen vieja: deriva"
      echo "    cosmetica, la imagen cambio de ID por archivos ajenos al build. No urge)."
    else
      # ⚠️ [K3S.32] Decia «los 8 carriles» con un 8 escrito a mano. Cuando siete se fueron a
      # K3s siguio diciendo 8 — un numero fijo en un mensaje es una afirmacion que nadie
      # vuelve a comprobar. Ahora no promete un conteo que no midio.
      echo "  ✓ los carriles de Compose, en la misma imagen"
    fi'

  # ⛔ [K3S.21] Y LOS PODS TAMBIÉN. Todo el bloque de arriba mira SÓLO contenedores de Docker,
  # así que desde que los carriles se fueron a K3s este detector dejó de verlos: los 7 que de
  # verdad alimentan el ODS quedaron fuera del único chequeo que compara CÓDIGO.
  #
  # No es hipotético. El mismo punto ciego, del lado de prod, dejó a los pods del API 36
  # commits atrás sirviendo a los usuarios internos durante horas (2026-10-01) — y nadie lo vio
  # porque el verificador medía el :8080 de Docker, que sí estaba al día.
  #
  # ⭐ Compara el DIGEST DEL CÓDIGO, no el ID de imagen, por la misma razón que [CPU.4]: con
  # ~10 sesiones sobre el repo la imagen cambia de ID varias veces al día por archivos ajenos
  # al contexto de build. Medido hoy: los 7 pods tenían imagen distinta a `latest` y código
  # IDÉNTICO. Una alarma que grita en falso enseña a ignorar el tablero.
  echo
  echo "── Versión por pod de K3s ──"
  ssh_md '
    export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
    command -v k3s >/dev/null 2>&1 || { echo "   (no hay k3s en este host)"; exit 0; }
    DIG="find /app/database/importers /app/services/feeds-ingest /app/ops/ingest /app/ops/vl /app/libs -type f \( -name \*.js -o -name \*.sh \) | sort | xargs md5sum | md5sum | cut -c1-12"
    REF=$(docker run --rm --entrypoint sh trade-ingest:latest -c "$DIG" 2>/dev/null)
    echo "   trade-ingest:latest = ${REF:-NO SE PUDO MEDIR}"
    viejos=0; n=0
    for p in $(k3s kubectl get pods -n ingesta -o name 2>/dev/null); do
      n=$((n+1))
      d=$(k3s kubectl exec -n ingesta $p -- sh -c "$DIG" 2>/dev/null)
      if [ -z "$d" ]; then printf "   %-40s %s\n" "${p#pod/}" "NO MEDIDO (no se pudo entrar al pod)"
      elif [ "$d" = "$REF" ]; then printf "   %-40s %s\n" "${p#pod/}" "$d"
      else printf "   %-40s %s  <- CODIGO VIEJO\n" "${p#pod/}" "$d"; viejos=$((viejos+1)); fi
    done
    if [ "$n" -eq 0 ]; then echo "   (ningun pod en el namespace ingesta)"
    elif [ "$viejos" -gt 0 ]; then echo "   ⛔ $viejos pod(s) con CODIGO viejo — corre: ops/vl/deploy.sh --k3s"
    else echo "   ✓ los $n pods corren el MISMO codigo que la imagen"; fi'
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

# ═══ [K3S.21] PUBLICAR — el paso que faltaba entre construir y K3s ══════════════════════════
#
# Hasta el 2026-10-01 NO existía camino automático: las imágenes entraban a containerd a mano,
# con `docker save | sudo k3s ctr images import`. Y lo que se hace a mano se olvida — los pods
# quedaron 36 commits atrás y le sirvieron ese build a los usuarios internos, con TODOS los
# rótulos en verde (pod Running, sonda 200, y el verificador midiendo el otro mundo).
#
# ⭐ EL TAG ES EL COMMIT, NUNCA `latest`. Con `latest` + `imagePullPolicy: IfNotPresent` el
# kubelet no vuelve a jalar jamás; con el commit adentro del tag, un commit distinto es un tag
# distinto, y un tag distinto OBLIGA a crear un pod nuevo. La obsolescencia deja de ser
# improbable y pasa a ser imposible. Y si la imagen falta, falla A LA VISTA (ImagePullBackOff).
#
# Medido: las 5 imágenes (5 GB) suben en 5 s. Es loopback y las capas se deduplican.
publicar() {
  commit=$(cd "$REPO" && git rev-parse --short HEAD)
  echo "── Publicando trade-ingest:$commit en el registry local ──"
  ssh_md "docker tag trade-ingest:latest localhost:5000/trade-ingest:$commit && \
    docker push localhost:5000/trade-ingest:$commit >/dev/null 2>&1 && echo '   publicada'" || {
    echo "   ⛔ no se pudo publicar. ¿Está arriba el registry?  docker ps | grep prod-registry"
    exit 1
  }
}

# ═══ [K3S.21] APLICAR LOS MANIFIESTOS, con el commit sustituido ═════════════════════════════
#
# ⛔ SÓLO SE APLICAN LOS `migracion: migrado`, y el filtro no es cosmético. Un
# `kubectl apply -f ops/k3s/` a secas aplicaría también los `preparado` —los que tienen el YAML
# escrito pero siguen corriendo en Compose— y crearía el doble-corredor AL INSTANTE y en
# silencio: dos dueños del mismo renglón de `analytics.cron_runs` pisándose el latido.
#
# El filtro es POR ARCHIVO, y lo que lo vuelve confiable es que `npm run check:k3s` exige que un
# archivo no mezcle los dos estados. Sin esa regla, el filtro sería una suposición.
aplicar_k3s() {
  commit=$(cd "$REPO" && git rev-parse --short HEAD)
  echo "── Aplicando manifiestos de K3s (sólo los MIGRADO) ──"
  ssh_md "export KUBECONFIG=/etc/rancher/k3s/k3s.yaml; cd ~/build-ingest/ops/k3s && for f in *.yaml; do \
    if grep -q 'migracion: preparado' \$f; then echo \"   — \$f (PREPARADO: corre en Compose, no se aplica)\"; \
    else sed 's/__COMMIT__/$commit/g' \$f | k3s kubectl apply -f - >/dev/null && echo \"   ✓ \$f\"; fi; done" || {
    echo "   ⛔ falló el apply. Si dice ImagePullBackOff, falta /etc/rancher/k3s/registries.yaml"
    echo "      (necesita root una sola vez; el archivo está en ~superoot/registries.yaml)"
    exit 1
  }
  echo
  echo "── Esperando a que los pods tomen la imagen nueva ──"
  ssh_md "export KUBECONFIG=/etc/rancher/k3s/k3s.yaml; \
    for d in \$(k3s kubectl get deploy -n ingesta -o name 2>/dev/null); do \
      printf '   %-34s ' \"\$d\"; \
      k3s kubectl rollout status -n ingesta \$d --timeout=120s 2>&1 | tail -1; done"
  echo
  echo "   ⚠️ 'rollout complete' dice que el pod arrancó, NO que esté entregando."
  echo "      El veredicto sigue siendo el latido en analytics.cron_runs (ADR-053)."
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
  # [K3S.21] Reaplicar K3s sin tocar Compose. ⛔ CONSTRUYE IGUAL, a propósito: si publicara
  # `trade-ingest:latest` tal como esté, le pondría el tag del commit de HEAD a una imagen que
  # puede ser de OTRO commit — un tag que miente sobre lo que contiene, que es exactamente la
  # clase de defecto que esta entrega cierra. El build está cacheado: si no cambió nada, es rápido.
  --k3s)         verificar_limpio; construir; publicar; aplicar_k3s ;;
  --todo)        verificar_limpio; construir; publicar; aplicar_k3s; recrear $SERVICIOS_DEF ;;
  -*)            sed -n '2,10p' "$0"; exit 2 ;;
  *)             verificar_limpio; construir; publicar; aplicar_k3s; recrear "$@" ;;
esac
