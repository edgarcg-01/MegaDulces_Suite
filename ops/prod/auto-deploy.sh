#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# `[VL.17]` DESPLIEGUE AUTOMÁTICO — corre EN `md`, mira `origin/main`, y no confía en nadie.
#
#   auto-deploy.sh              # una pasada: si origin/main cambió, construye y recrea
#   auto-deploy.sh --estado     # qué hay desplegado vs qué hay en origin/main
#   auto-deploy.sh --seco       # dice qué haría y NO toca nada
#
# ── POR QUÉ ES SEGURO AUTOMATIZARLO AHORA, Y NO LO ERA AYER ─────────────────
# Porque las tres compuertas que faltaban se pusieron hoy, y las tres se probaron rompiéndolas:
#   · `[VL.15.B]` se NIEGA a desplegar si HEAD trae migraciones que prod no tiene aplicadas.
#     Sin eso, un despliegue automático sube código que espera columnas inexistentes y revienta
#     en la cara de quien abra la pantalla, no en el build.
#   · `[VL.15.D]` verifica que `/api/health` sirva el commit que se acaba de levantar.
#   · `[VL.16.D2]` golpea el login y exige 401. "La versión correcta" no es "funciona": el
#     2026-09-23 un despliegue pasó su verificación de commit con el login devolviendo 500 a
#     TODO el mundo.
# Un despliegue automático sin esas tres es una forma de romper producción sin testigos.
#
# ── ⭐ DESPLIEGA `origin/main`, NO EL HEAD LOCAL ────────────────────────────
# Y eso lo hace MÁS seguro que el despliegue a mano de hoy, no menos: `ops/prod/deploy.sh`
# archiva el HEAD de quien lo corre, así que puede subir a producción código que nadie revisó y
# que no está en el remoto — medido el 2026-09-23, prod corrió durante horas un commit que no
# estaba en `origin/main`. Acá sólo entra lo que pasó por la rama protegida.
#
# ── ⛔ AUTO-REVERSIÓN ───────────────────────────────────────────────────────
# Si el humo del login falla, vuelve SOLO a la imagen anterior. No es exceso de celo: pasó ayer
# y la reversión a mano tardó seis minutos con el login caído. Lo que lo hace decidible es que
# el humo distingue "se levantó" de "sirve"; sin esa señal, revertir automático sería adivinar.
# ⚠️ NO revierte por un fallo de RED ni por un 429 del throttler: eso es "no se pudo medir", y
#    revertir por no haber medido es peor que no revertir (ADR-056).
#
# ⚠️ LATE. Escribe `analytics.cron_runs` → se ve en Salud BD. Un carril de despliegue mudo es un
#    carril que no sabés si corre: exactamente lo que este proyecto pasó el día entero cerrando.
# ─────────────────────────────────────────────────────────────────────────────
set -u

REPO_DIR="${AUTO_DEPLOY_REPO:-$HOME/auto-deploy/repo}"
REMOTO="git@github.com:edgarcg-01/Trade_marketing.git"
RAMA="${AUTO_DEPLOY_BRANCH:-main}"
LLAVE="${AUTO_DEPLOY_KEY:-$HOME/.ssh/deploy_md}"
SERVICIOS="${AUTO_DEPLOY_SERVICIOS:-api worker}"
JOB=auto_deploy
TENANT="${CRON_TENANT_ID:-00000000-0000-0000-0000-00000000d01c}"

SECO=0; [ "${1:-}" = "--seco" ] && SECO=1
ESTADO=0; [ "${1:-}" = "--estado" ] && ESTADO=1

di() { echo "[$(date '+%F %T %Z')] $*"; }

# ── El diario se recorta solo ────────────────────────────────────────────────
# `md` no tiene `logrotate` a mano para un usuario sin sudo, y una pasada cada 5 minutos escribe
# todos los días para siempre. Un log sin tope es cómo el contenedor `backup` quedó sin `logging:`
# y creció sin freno (`[OBS.7]`). 4,000 líneas son ~2 semanas de pasadas.
recortar_diario() {
  _log="${AUTO_DEPLOY_LOG:-$HOME/ops/prod/auto-deploy.log}"
  [ -f "$_log" ] || return 0
  if [ "$(wc -l < "$_log" 2>/dev/null || echo 0)" -gt 4000 ]; then
    tail -n 2000 "$_log" > "$_log.tmp" 2>/dev/null && mv "$_log.tmp" "$_log"
  fi
}
recortar_diario

# Latido a prod. Nunca hace fallar el despliegue: una bitácora que tumba lo que registra es peor
# que no tenerla (mismo criterio que `backup-prod.sh`).
latir() {
  _st="$1"; _nota="$2"
  docker exec -i pg-prod psql -U postgres -q -d railway >/dev/null 2>&1 <<SQL || di "aviso: el latido no se pudo escribir"
INSERT INTO analytics.cron_runs (tenant_id, job_key, label, last_start, last_finish, status, note, host, updated_at)
VALUES ('$TENANT', '$JOB', 'Despliegue automático (origin/$RAMA)', now(), now(), '$(echo "$_st" | sed "s/'/''/g")',
        '$(echo "$_nota" | sed "s/'/''/g")', 'md', now())
ON CONFLICT (tenant_id, job_key) DO UPDATE
  SET last_finish = now(), status = EXCLUDED.status, note = EXCLUDED.note, host = EXCLUDED.host, updated_at = now();
SQL
}

# ── El repo, en SÓLO LECTURA y superficial ──────────────────────────────────
# `--depth` acotado a propósito: acá no se desarrolla, se despliega. Un clon completo de este
# repo son cientos de MB de historia que nadie va a leer en el servidor.
export GIT_SSH_COMMAND="ssh -i $LLAVE -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
if [ ! -d "$REPO_DIR/.git" ]; then
  di "primer clon de $RAMA en $REPO_DIR"
  mkdir -p "$(dirname "$REPO_DIR")"
  git clone --depth 50 --branch "$RAMA" "$REMOTO" "$REPO_DIR" >/dev/null 2>&1 \
    || { di "FALLO: no se pudo clonar. ¿La llave de despliegue está dada de alta en GitHub?"; latir error "no se pudo clonar el repo"; exit 1; }
fi

cd "$REPO_DIR" || { di "FALLO: no existe $REPO_DIR"; exit 1; }
git fetch --depth 50 origin "$RAMA" >/dev/null 2>&1 \
  || { di "FALLO: no se pudo hacer fetch de origin/$RAMA"; latir error "fetch falló (llave o red)"; exit 1; }
git reset --hard "origin/$RAMA" >/dev/null 2>&1
DESEADO=$(git rev-parse --short HEAD)

# ── Qué está corriendo, según la IMAGEN (no según lo que alguien anotó) ─────
# ⛔ Se le pregunta a Docker cuál etiqueta de commit comparte ID con `:latest`, igual que
# `deploy.sh`: el commit que sirve es el que está HORNEADO, no el del último `git pull`.
VIVO=$(docker images --format '{{.Tag}} {{.ID}}' trade-prod-api 2>/dev/null \
  | grep -v '^latest ' \
  | awk -v v="$(docker images --format '{{.ID}}' trade-prod-api:latest 2>/dev/null | head -1)" '$2==v {print $1; exit}')
[ -n "$VIVO" ] || VIVO=desconocido

if [ "$ESTADO" = 1 ]; then
  echo "  origin/$RAMA : $DESEADO"
  echo "  corriendo    : $VIVO"
  [ "$VIVO" = "$DESEADO" ] && echo "  ✓ al día" || echo "  ⛔ hay $(git rev-list --count "$VIVO..HEAD" 2>/dev/null || echo '?') commit(s) sin desplegar"
  exit 0
fi

if [ "$VIVO" = "$DESEADO" ]; then
  latir ok "al día en $DESEADO"
  exit 0
fi

di "origin/$RAMA = $DESEADO · corriendo = $VIVO ⇒ hay que desplegar"

# ── ⛔ CUARENTENA: UN COMMIT QUE YA TIRÓ PROD NO SE VUELVE A INTENTAR ────────────────────────
# Sin esto la agenda de 5 min es una máquina de repetir el incidente. Medido el 2026-09-24:
# `0e1fef3` no arrancaba (un módulo sin su import); el carril lo desplegó, el API murió, la
# reversión lo devolvió a `a2052fa1` a las 13:34:46 — y **a las 13:35:03 el siguiente disparo
# volvió a construirlo, esta vez con la caché, o sea en 3 segundos, y tiró prod de nuevo**. Dos
# ventanas de caída por un solo commit malo, y de haber seguido serían doce por hora.
#
# La cuarentena es por COMMIT, no por tiempo: reintentar dentro de 30 min el mismo binario que
# ya falló da el mismo resultado. Lo que la levanta es que alguien empuje algo distinto —
# o sea, que exista un arreglo. `--forzar` la ignora, para cuando se sabe lo que se hace.
CUARENTENA="$HOME/ops/prod/.auto-deploy-cuarentena"
FORZAR=0; [ "${1:-}" = "--forzar" ] && FORZAR=1
if [ -f "$CUARENTENA" ]; then
  _malo=$(cat "$CUARENTENA" 2>/dev/null)
  if [ "$_malo" = "$DESEADO" ] && [ "$FORZAR" = 0 ]; then
    di "EN CUARENTENA: $DESEADO ya tumbó producción en un intento anterior. No se reintenta."
    di "  Se levanta sola cuando origin/$RAMA avance a otro commit (o sea: cuando haya un arreglo)."
    di "  Para forzar igual: auto-deploy.sh --forzar"
    latir error "commit $DESEADO en cuarentena — no arranca; esperando un arreglo en origin/$RAMA"
    exit 1
  fi
  # El commit cambió: hubo un arreglo (o al menos algo distinto). Se limpia y se intenta.
  rm -f "$CUARENTENA"
fi

if [ "$SECO" = 1 ]; then di "SECO: acá se construiría y recrearía. No se toca nada."; exit 0; fi

# ── La compuerta de migraciones, ANTES de construir ─────────────────────────
# Se reusa la de `deploy.sh` en vez de reimplementarla: dos compuertas para lo mismo divergen, y
# la que se olvide de actualizar es la que va a dejar pasar el despliegue malo (ADR-056).
# ⛔ `LC_ALL=C` NO es cosmético. Sin él `sort` usa el orden de la configuración regional y `comm`
# —que exige orden byte a byte— avisa `archivo 1 no está en orden ordenado` **por stderr** y
# devuelve un resultado que no vale. Con `2>/dev/null` de por medio ese aviso no se ve, y la
# compuerta puede DEJAR PASAR una migración pendiente o inventar una que no existe. Medido el
# 2026-09-24 en `md`: los tres avisos salieron; esa vez el veredicto coincidió de casualidad
# (4 pendientes con los dos órdenes), lo cual es justo lo que vuelve invisible al defecto.
git ls-tree -r --name-only HEAD database/migrations-newdb/ \
  | sed 's#.*/##' | grep -E '\.js$' | LC_ALL=C sort > /tmp/ad-repo.txt
docker exec pg-prod psql -U postgres -At -d railway -c 'SELECT name FROM public.knex_migrations' 2>/dev/null \
  | tr -d '\r' | grep -E '\.js$' | LC_ALL=C sort > /tmp/ad-prod.txt
PEND=$(LC_ALL=C comm -23 /tmp/ad-repo.txt /tmp/ad-prod.txt)
if [ ! -s /tmp/ad-prod.txt ]; then
  di "FALLO: no se pudo leer public.knex_migrations — estado de migraciones NO MEDIDO. No se despliega a ciegas."
  latir error "no se pudo leer knex_migrations"; exit 1
fi
if [ -n "$PEND" ]; then
  n=$(echo "$PEND" | wc -l | tr -d ' ')
  di "FRENADO: $n migración(es) de $DESEADO sin aplicar en prod:"
  echo "$PEND" | sed 's/^/      /'
  di "Se aplican a mano, una por una, con lock_timeout. NUNCA migrate:latest (hay DOS knex_migrations)."
  latir error "$n migración(es) sin aplicar — despliegue frenado"
  exit 1
fi
di "migraciones: prod al día"

# ── Construir y recrear ─────────────────────────────────────────────────────
ANTERIOR="$VIVO"
# ⛔ ANTES de construir. El `docker build -t …:latest` PISA la etiqueta `latest`, así que después
# del build ya no hay forma de saber qué imagen estaba sirviendo cada servicio.
guardar_anteriores
cd "$REPO_DIR" || exit 1
for s in $SERVICIOS; do
  case "$s" in api) img=trade-prod-api; df=Dockerfile ;; worker) img=trade-prod-worker; df=Dockerfile.worker ;; *) continue ;; esac
  di "construyendo $img:$DESEADO"
  if ! docker build -q -f "$df" --build-arg GIT_COMMIT_SHA="$DESEADO" -t "$img:$DESEADO" -t "$img:latest" . >/dev/null 2>&1; then
    di "FALLO: no compiló $img"; latir error "build de $img falló en $DESEADO"; exit 1
  fi
done

cd "$HOME/ops/prod" || exit 1
set -a; . "$HOME/secrets/prod-compose.env"; set +a
docker compose -p prod up -d $SERVICIOS >/dev/null 2>&1

# ── Verificar ENTREGA, no el rótulo ─────────────────────────────────────────
# ⚠️ La ventana era de 60 s y el arranque medido es de ~15 s — parecía de sobra. Pero cuando el
# despliegue va detrás de su propia construcción la máquina viene con carga 14 sobre 8 hilos, y
# 60 s dejan de ser holgura. Van 120 s.
#
# ⭐ Y no se espera en seco: si un contenedor entra en **bucle de reinicio** se corta de una, sin
# agotar la ventana. Esa distinción importa para el diagnóstico — "el proceso muere al arrancar"
# y "tardó más de lo que esperábamos" piden arreglos opuestos, y un timeout solo no los separa.
vivo_ahora=''
for i in $(seq 1 24); do
  for c in prod-api prod-worker; do
    _st=$(docker inspect -f '{{.State.Status}} {{.State.Restarting}} {{.RestartCount}}' "$c" 2>/dev/null)
    case "$_st" in
      *"true "*|restarting*)
        di "FALLO RÁPIDO: $c en bucle de reinicio ($_st) — el proceso muere al arrancar."
        docker logs --tail 40 "$c" 2>&1 | grep -iE "error|exception|cannot resolve|UnknownDependencies" | head -6 | sed 's/^/      /'
        revertir; latir error "$c no arranca con $DESEADO (bucle de reinicio) — revertido"; exit 1 ;;
    esac
  done
  r=$(curl -s --max-time 5 http://127.0.0.1:8080/api/health 2>/dev/null)
  vivo_ahora=$(printf '%s' "$r" | sed -n 's/.*"commit":"\([^"]*\)".*/\1/p')
  [ -n "$vivo_ahora" ] && break
  sleep 5
done

# ── ⛔ CADA SERVICIO VUELVE A **SU** IMAGEN ANTERIOR, NO A LA DEL API ────────────────────────
# La primera versión re-etiquetaba `$img:$ANTERIOR` para los dos, y `$ANTERIOR` es el commit que
# servía **el API**. Medido el 2026-09-24: `trade-prod-worker:a2052fa1` NO EXISTÍA (el worker no
# se reconstruye en cada despliegue; el suyo era `022a2604`, de 18 h antes), así que el
# `docker image inspect` fallaba, el `&&` saltaba el re-etiquetado en silencio, y
# `trade-prod-worker:latest` **se quedaba apuntando al build NUEVO que acababa de fallar**. O sea
# que la reversión devolvía el API a lo bueno y **dejaba el worker en lo roto** — quedó en bucle
# de reinicio, y el log decía `revertido.` igual.
#
# Ahora se guarda el ID de imagen de cada servicio ANTES de construir, que es la única forma de
# saber a qué volver: la etiqueta de commit puede no existir para ese servicio, pero el ID que
# estaba corriendo siempre existe.
guardar_anteriores() {
  for s in $SERVICIOS; do
    case "$s" in api) img=trade-prod-api; c=prod-api ;; worker) img=trade-prod-worker; c=prod-worker ;; *) continue ;; esac
    _id=$(docker inspect -f '{{.Image}}' "$c" 2>/dev/null)
    [ -n "$_id" ] && eval "PREV_$s=\$_id"
  done
}

revertir() {
  di "REVIRTIENDO"
  # El commit queda marcado acá, en el único lugar por donde pasan TODOS los caminos de reversión.
  # Ponerlo en cada sitio de llamada es cómo se olvida en el tercero.
  echo "$DESEADO" > "$CUARENTENA" 2>/dev/null || di "aviso: no se pudo escribir la cuarentena"
  _falta=''
  for s in $SERVICIOS; do
    case "$s" in api) img=trade-prod-api ;; worker) img=trade-prod-worker ;; *) continue ;; esac
    eval "_id=\${PREV_$s:-}"
    if [ -n "$_id" ] && docker image inspect "$_id" >/dev/null 2>&1; then
      docker tag "$_id" "$img:latest"
      di "  $img → $(echo "$_id" | cut -c8-19)"
    else
      # ⚠️ Se DECLARA. Un servicio que no se pudo revertir y no lo dice es peor que uno caído:
      # el log diría `revertido.` mientras sigue sirviendo el binario malo (ADR-056).
      di "  ⛔ $img: NO se pudo revertir — no hay imagen anterior registrada"
      _falta="$_falta $img"
    fi
  done
  cd "$HOME/ops/prod" && docker compose -p prod up -d --force-recreate $SERVICIOS >/dev/null 2>&1
  if [ -n "$_falta" ]; then
    di "revertido PARCIALMENTE — quedó sin revertir:$_falta"
  else
    di "revertido."
  fi
}

if [ -z "$vivo_ahora" ] || { [ "$vivo_ahora" != "$DESEADO" ] && [ "$DESEADO" != desconocido ]; }; then
  di "FALLO: el API sirve '${vivo_ahora:-nada}' y se levantó '$DESEADO'."
  revertir; latir error "commit no coincide tras desplegar $DESEADO — revertido a $ANTERIOR"; exit 1
fi

codigo=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 \
  -X POST http://127.0.0.1:8080/api/auth-mt/login \
  -H 'Content-Type: application/json' -d '{"username":"zz_humo_auto","password":"zz"}' 2>/dev/null || echo 000)
case "$codigo" in
  401|403) di "humo del login: $codigo — la puerta contesta." ;;
  429)     di "humo del login: 429 (throttler) — NO se pudo medir. No se revierte por no haber medido." ;;
  *)
    di "FALLO: el login respondió $codigo. El binario es el correcto pero la aplicación NO sirve."
    revertir; latir error "humo del login $codigo en $DESEADO — revertido a $ANTERIOR"; exit 1 ;;
esac

di "DESPLEGADO $DESEADO (venía de $ANTERIOR)"
latir ok "desplegado $DESEADO desde $ANTERIOR · servicios: $SERVICIOS"
