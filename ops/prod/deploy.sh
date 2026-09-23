#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# VL.9 — DESPLIEGUE de PRODUCCIÓN al servidor `md` (192.168.0.222).
#
#   ops/prod/deploy.sh --estado        # qué corre allá y con qué imagen
#   ops/prod/deploy.sh --imagenes      # construye las 6 imágenes, no recrea nada
#   ops/prod/deploy.sh --imagenes api  # …o sólo la de ese servicio
#   ops/prod/deploy.sh --db            # sólo levanta pg-prod + pg-rag
#   ops/prod/deploy.sh --recrear api   # sube el compose y recrea, SIN reconstruir imágenes
#   ops/prod/deploy.sh --tunel         # levanta/recrea el Cloudflare Tunnel (perfil `tunel`)
#   ops/prod/deploy.sh --volver 4bf36b2 # ROLLBACK: reapunta :latest a esa versión y recrea
#   ops/prod/deploy.sh --verificar     # ¿está funcionando? con datos, no con rótulos
#   ops/prod/deploy.sh --pitr          # ensayo de recuperación a un punto en el tiempo
#   ops/prod/deploy.sh                 # construye y recrea todo
#   ops/prod/deploy.sh api worker      # construye y recrea SÓLO esos (desde [VL.10.D])
#
# Hermano de `ops/vl/deploy.sh` (la ingesta) y con las mismas dos reglas duras:
#
# ⛔ SE ARCHIVA `HEAD`, NO LA COPIA DE TRABAJO. El índice de git de este repo lo
#    comparten ~10 sesiones a la vez: un archive del working tree mandaría a
#    producción el WIP de otra persona. Avisa qué no viaja y sigue.
#
# ⚠️ `md` no tiene el repo. Las imágenes son autocontenidas (el código se copia
#    adentro), así que un cambio de código exige RECONSTRUIR, no reiniciar.
#
# ── Por qué se archiva el árbol ENTERO y no una lista de rutas ───────────────
# `ops/vl/deploy.sh` lista las rutas que copia su Dockerfile, y su propio
# encabezado avisa del riesgo: "si ahí se agrega un COPY, acá también". Acá hay
# CUATRO Dockerfiles distintos (api, worker, portal, vendor) con listas de COPY
# que ya divergen entre sí. Mantener la unión a mano es una trampa con cuatro
# caras, y el síntoma de equivocarse no menciona ni Docker ni el COPY — es el
# mismo modo de falla que motivó `scripts/check-docker-context.js`. El árbol
# entero cuesta unos segundos de LAN y no puede desincronizarse.
# ─────────────────────────────────────────────────────────────────────────────
set -eu

SRV="${DEPLOY_HOST:-superoot@192.168.0.222}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
REMOTO="~/build-prod"
SERVICIOS_DEF="pg-prod pg-rag api worker portal vendor backup"

ssh_md() { ssh -o BatchMode=yes -o ConnectTimeout=15 "$SRV" "$@"; }

estado() {
  echo "── Qué corre en $SRV (proyecto compose: prod) ──"
  ssh_md 'docker ps --filter "label=com.docker.compose.project=prod" --format "{{.Names}}|{{.Status}}|{{.Image}}" | sort | column -t -s"|" || true'
  echo
  echo "── Imágenes de prod ──"
  ssh_md 'for i in trade-prod-pg trade-prod-api trade-prod-worker trade-prod-portal trade-prod-vendor trade-prod-backup; do
            docker image inspect "$i:latest" --format "  {{.RepoTags}}  creada {{.Created}}" 2>/dev/null || echo "  $i:latest  (no existe)";
          done'
  echo
  echo "── La INGESTA (proyecto vl) — no se toca desde acá ──"
  ssh_md 'docker ps --format "{{.Names}}|{{.Status}}" | grep -E "pgvector-md|ods-|feeds-|store-" | sort | column -t -s"|" || true'
}

verificar_limpio() {
  cd "$REPO"
  sucio=$(git status --porcelain | grep -vE '\.stock-live-snapshot\.json' || true)
  [ -n "$sucio" ] || return 0
  echo "⚠️  Hay cambios SIN COMMITEAR. NO viajan (se archiva HEAD a propósito):"
  echo "$sucio" | head -20 | sed 's/^/     /'
  n=$(echo "$sucio" | wc -l)
  [ "$n" -gt 20 ] && echo "     … y $((n - 20)) más"
  echo "     El índice lo comparten ~10 sesiones. Si algo de eso es TUYO y lo querés"
  echo "     desplegar, commitealo con pathspec:  git commit -- <ruta>"
  echo
}

enviar() {
  cd "$REPO"
  commit=$(git rev-parse --short HEAD)
  echo "── Enviando HEAD ($commit) a $SRV ──"
  # `git archive` aplica .gitattributes, que es lo que mantiene los `eol=lf`. ⚠️ Con
  # core.autocrlf=true un archivo SIN regla se exporta con CRLF — así los 9 carriles de
  # la ingesta corrieron en seco diciendo "ok" el 2026-09-11.
  git archive --format=tar HEAD \
    | ssh -o BatchMode=yes "$SRV" "rm -rf $REMOTO && mkdir -p $REMOTO && tar -xf - -C $REMOTO"
  ssh_md "du -sh $REMOTO | sed 's/^/   contexto: /'"
}

# Sube el compose (y NADA más) y lo valida allá. Está aparte de `construir` porque cambiar
# una línea del compose no tiene por qué costar cuatro builds de ~20 min — y porque la
# alternativa, un `scp` a mano, se salta la validación y deja el archivo de `md` divergiendo
# del repo sin que nadie lo note.
subir_compose() {
  ssh_md "mkdir -p ~/ops/prod"
  # El compose y los guiones que corren en el HOST (no dentro de un contenedor). `restaurar.sh`
  # usa `pg_restore` nativo de `md` y para/levanta contenedores: no puede vivir en una imagen.
  # ⛔ Se copia a un nombre temporal y se MUEVE encima, nunca directo. `sh` lee el guion
  # POR POSICIÓN mientras lo ejecuta: sobrescribir el mismo inodo de un guion en curso le
  # hace ejecutar basura desde el byte donde iba. `mv` desenlaza el inodo viejo, y el
  # proceso que lo está corriendo lo sigue leyendo entero y sano.
  # No es teórico: `esperar-y-restaurar.sh` puede estar corriendo durante horas.
  for a in docker-compose.yml restaurar.sh esperar-y-restaurar.sh verificar.sh probar-pitr.sh; do
    scp -q -o BatchMode=yes "$REPO/ops/prod/$a" "$SRV:ops/prod/.$a.nuevo"
  done
  ssh_md "cd ~/ops/prod && for a in docker-compose.yml restaurar.sh esperar-y-restaurar.sh verificar.sh probar-pitr.sh; do mv -f \".\$a.nuevo\" \"\$a\"; done && chmod +x restaurar.sh esperar-y-restaurar.sh verificar.sh probar-pitr.sh"
  ssh_md "cd ~/ops/prod && set -a && . ~/secrets/prod-compose.env && set +a && docker compose -p prod config >/dev/null && echo '   compose válido'"
}

construir() {
  commit=$(cd "$REPO" && git rev-parse --short HEAD)

  # ── [VL.10.D] CONSTRUIR SÓLO LO QUE SE PIDIÓ ────────────────────────────────────
  # Antes `deploy.sh portal` reconstruía LAS SEIS imágenes y recreaba una. Con los dos
  # bundles grandes en serie eso son minutos de CPU regalados, y en una máquina donde
  # construir y servir compiten por los mismos 8 hilos no es gratis.
  # Sin argumentos (`--todo`, `--imagenes`) sigue construyendo todo, que es lo correcto
  # para un despliegue completo.
  filtro=''
  for s in "$@"; do
    case "$s" in
      pg-prod) filtro="$filtro trade-prod-pg" ;;
      api)     filtro="$filtro trade-prod-api" ;;
      worker)  filtro="$filtro trade-prod-worker" ;;
      portal)  filtro="$filtro trade-prod-portal" ;;
      vendor)  filtro="$filtro trade-prod-vendor" ;;
      backup)  filtro="$filtro trade-prod-backup" ;;
      # `pg-rag` usa una imagen de terceros sin Dockerfile propio, y `cloudflared`
      # también: no hay nada que construir para ellos, sólo recrear.
      pg-rag|cloudflared) echo "   · $s usa imagen de terceros — no se construye" ;;
      *) echo "   ⚠️ '$s' no tiene imagen propia; se ignora al construir" ;;
    esac
  done

  if [ -n "$filtro" ]; then
    echo "── Construyendo sólo:$filtro ──"
  else
    echo "── Construyendo (esto tarda: son 3 bundles de Angular) ──"
  fi
  # En serie a propósito: 4 builds en paralelo sobre 4 núcleos físicos se pelean por CPU y
  # por RAM (cada `nx build` de Angular pide hasta 4 GB de heap). Serializar cuesta
  # wall-clock y quita el riesgo de un OOM-kill, que se ve como un log cortado a la mitad
  # sin ninguna línea de error.
  #
  # ⭐ DOBLE ETIQUETA: `:<commit>` **y** `:latest`. Sin la primera no existe el rollback —
  # medido el 2026-09-22: las 6 imágenes eran sólo `:latest` y las versiones anteriores
  # quedaban SIN ETIQUETA, o sea recuperables únicamente adivinando un hash por fecha… hasta
  # que alguien corre `docker image prune` para liberar disco y desaparecen. No poder volver
  # a la versión de ayer es la mitad que falta del control de cambios: la otra mitad (que no
  # entre una mala) la da la CI, que hoy está apagada.
  #
  # ⭐ [VL.10.C] `--build-arg` DEL COMMIT, A LAS SEIS. Hasta hoy esta línea NO pasaba ningún
  # build-arg, y eso tenía dos consecuencias que nadie había atado:
  #   1. `/api/health` sólo sabía su commit por el entorno que le pone `recrear()`, así que
  #      cualquier `docker compose up` a mano lo dejaba en `""`. Pasó dos veces el 2026-09-22.
  #   2. `apps/portal/Dockerfile` y `apps/vendor/Dockerfile` YA declaraban
  #      `ARG RAILWAY_GIT_COMMIT_SHA` y lo estampan en su `index.html` — o sea que el sello de
  #      versión del portal y del vendedor decía **`unknown`** on-prem desde el primer día.
  # Se mandan los DOS nombres porque el repo usa ambos: `RAILWAY_*` es el que Railway inyecta
  # solo y el que leen `otel.ts`/`instrument.ts`. ⚠️ Docker avisa por el arg que un Dockerfile
  # no declara; ese aviso va al log del build, no a la consola, y es inofensivo.
  ssh_md "cd $REMOTO && set -e
    FILTRO='$filtro'
    for par in 'trade-prod-pg:ops/prod/Dockerfile.pg' \
               'trade-prod-api:Dockerfile' \
               'trade-prod-worker:Dockerfile.worker' \
               'trade-prod-portal:apps/portal/Dockerfile' \
               'trade-prod-vendor:apps/vendor/Dockerfile' \
               'trade-prod-backup:ops/prod/Dockerfile.backup'; do
      img=\${par%%:*}; df=\${par#*:}
      # Los espacios de los dos lados evitan que 'trade-prod-pg' matchee dentro de otro nombre.
      if [ -n \"\$FILTRO\" ] && ! echo \" \$FILTRO \" | grep -q \" \$img \"; then continue; fi
      printf '   %-22s ' \"\$img\"
      t0=\$(date +%s)
      if docker build -q -f \"\$df\" --build-arg GIT_COMMIT_SHA=$commit --build-arg RAILWAY_GIT_COMMIT_SHA=$commit -t \"\$img:$commit\" -t \"\$img:latest\" . >/dev/null 2>/tmp/build-\$img.log; then
        echo \"ok (\$(( \$(date +%s) - t0 ))s)  →  \$img:$commit\"
      else
        echo 'FALLÓ'; tail -25 /tmp/build-\$img.log | sed 's/^/      /'; exit 1
      fi
    done"
  subir_compose
  podar_imagenes
}

# Conserva las $RETENER_IMG etiquetas de commit más nuevas de cada imagen y borra las demás.
# ⚠️ NO toca `:latest` ni la imagen que algún contenedor esté usando — `docker rmi` de una
# etiqueta en uso falla, y acá ese fallo es benigno (se ignora): lo que importa es no dejar
# el disco creciendo sin tope. Con 6 imágenes de hasta 2.2 GB, 5 versiones son ~35 GB.
RETENER_IMG="${RETENER_IMG:-5}"
podar_imagenes() {
  ssh_md "for i in trade-prod-pg trade-prod-api trade-prod-worker trade-prod-portal trade-prod-vendor trade-prod-backup; do
            docker images --format '{{.Tag}} {{.CreatedAt}}' \"\$i\" \
              | grep -v '^latest ' | sort -k2,3 -r | tail -n +\$(( $RETENER_IMG + 1 )) | awk '{print \$1}' \
              | while read t; do docker rmi \"\$i:\$t\" >/dev/null 2>&1 || true; done
          done" 2>/dev/null
  echo "   (se conservan las $RETENER_IMG versiones más nuevas de cada imagen)"
}

# ⭐ EL ROLLBACK. `deploy.sh --volver <commit>` reapunta `:latest` a esa versión y recrea.
# No hace falta registro ni reconstruir: las imágenes ya están en la máquina, etiquetadas.
volver() {
  destino="$1"; shift
  servicios="${*:-$SERVICIOS_DEF}"
  [ -n "$destino" ] || { echo "uso: deploy.sh --volver <commit-corto> [servicios...]"; exit 2; }
  echo "── Volviendo a $destino ──"
  faltan=$(ssh_md "for i in trade-prod-pg trade-prod-api trade-prod-worker trade-prod-portal trade-prod-vendor trade-prod-backup; do
                     docker image inspect \"\$i:$destino\" >/dev/null 2>&1 || echo \"\$i\"
                   done")
  if [ -n "$faltan" ]; then
    echo "⛔ No existe la etiqueta $destino para:"; echo "$faltan" | sed 's/^/     /'
    echo "   Versiones disponibles:"
    ssh_md "docker images --format '{{.Repository}}:{{.Tag}}' | grep '^trade-prod-' | grep -v ':latest' | sort -u" | sed 's/^/     /'
    exit 1
  fi
  ssh_md "for i in trade-prod-pg trade-prod-api trade-prod-worker trade-prod-portal trade-prod-vendor trade-prod-backup; do
            docker tag \"\$i:$destino\" \"\$i:latest\"; done && echo '   :latest reapuntado'"
  recrear $servicios
}

recrear() {
  servicios="$*"
  # ⛔ EL COMMIT SALE DE LA IMAGEN, NO DE `git HEAD`. Medido el 2026-09-22: la imagen se
  # construyó en `673f24fb` y al recrear —minutos después— `/api/health` reportó `07bd08fc`,
  # porque otra sesión había commiteado en el medio. El índice de git lo comparten ~10
  # sesiones y HEAD se mueve solo.
  # Decir una versión que NO es la que corre es exactamente el defecto que `[VL.9.2]` vino a
  # cerrar («la versión que sirve no se sabía»), disfrazado de dato correcto.
  # Se resuelve preguntándole a Docker cuál etiqueta de commit comparte ID con `:latest`.
  commit=$(ssh_md "docker images --format '{{.Tag}} {{.ID}}' trade-prod-api 2>/dev/null \
    | grep -v '^latest ' \
    | awk -v v=\"\$(docker images --format '{{.ID}}' trade-prod-api:latest 2>/dev/null | head -1)\" '\$2==v {print \$1; exit}'" 2>/dev/null)
  if [ -z "$commit" ]; then
    commit=desconocido
    echo "   ⚠️ la imagen no tiene etiqueta de commit — /api/health va a decir 'desconocido',"
    echo "      que es la verdad. Reconstruí con 'deploy.sh --imagenes' para que la tenga."
  fi
  echo "── Recreando: $servicios (imagen $commit) ──"
  # GIT_COMMIT_SHA viaja por el ENTORNO DEL PROCESO, no por prod.env: el formato `env_file` de
  # Compose no interpola y lo dejaría vacío — medido, `/api/health` devolvía `"commit": ""`. Es el
  # dato que dice qué versión está sirviendo; sin él el healthcheck miente por omisión.
  ssh_md "cd ~/ops/prod && set -a && . ~/secrets/prod-compose.env && set +a &&
    GIT_COMMIT_SHA=$commit docker compose -p prod up -d $servicios 2>&1 | grep -E 'Recreated|Started|Created|Error' | sed 's/^/   /'"
  echo
  echo "── Salud ──"
  ssh_md "for c in $servicios; do
            n=\$(docker ps -a --filter \"label=com.docker.compose.project=prod\" --filter \"label=com.docker.compose.service=\$c\" --format '{{.Names}}' | head -1)
            [ -n \"\$n\" ] || { printf '   %-10s (no existe)\n' \"\$c\"; continue; }
            printf '   %-10s %s\n' \"\$c\" \"\$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}} (sin healthcheck){{end}}' \$n)\"
          done"
  echo
  echo "   ⚠️ El rótulo NO es el veredicto. 'healthy' dice que el contenedor contesta;"
  echo "      que PROD esté bien se comprueba con datos: ver ops/prod/README.md §Verificación."
}

case "${1:---todo}" in
  --estado)    estado ;;
  --imagenes)  shift; verificar_limpio; enviar; construir "$@" ;;
  --db)        recrear pg-prod pg-rag ;;
  --recrear)   shift; subir_compose; [ $# -gt 0 ] || set -- $SERVICIOS_DEF; recrear "$@" ;;
  --volver)    shift; volver "$@" ;;
  --verificar) subir_compose >/dev/null; ssh_md "sh ~/ops/prod/verificar.sh" ;;
  --pitr)      subir_compose >/dev/null; ssh_md "sh ~/ops/prod/probar-pitr.sh" ;;
  # [VL.10.D] El túnel NO está en SERVICIOS_DEF (vive tras el perfil `tunel`), así que hasta
  # hoy NINGÚN camino de despliegue lo levantaba: había que escribir el `docker compose
  # --profile` a mano. ⚠️ Y hacerlo a mano es justo lo que vació `/api/health` el 2026-09-22,
  # porque `cloudflared` declara `depends_on: [api, portal, vendor]` y Compose se los lleva
  # puestos. Esta entrada pasa por `recrear()`, que sí exporta el commit.
  --tunel)     subir_compose; recrear cloudflared ;;
  --todo)      verificar_limpio; enviar; construir; recrear $SERVICIOS_DEF ;;
  -*)          sed -n '2,15p' "$0"; exit 2 ;;
  # Nombres de servicio sueltos: ahora `construir` recibe la lista y construye SÓLO esas
  # imágenes, en vez de las seis.
  *)           verificar_limpio; enviar; construir "$@"; recrear "$@" ;;
esac
