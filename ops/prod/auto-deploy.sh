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
# estaba en `origin/main`. Acá sólo entra lo que está en el remoto.
#
# ⛔ ESTA LÍNEA DECÍA "lo que pasó por la rama protegida" Y ERA FALSO. Medido el 2026-09-30:
# `main` **no tiene ninguna protección** — el repo es privado en plan free y GitHub responde 403
# tanto a `branches/main/protection` como a `rulesets`, y la cuenta no va a pasar a Pro. O sea
# que hasta hoy esto desplegaba lo que hubiera en `origin/main`, verde o rojo, sin que nada lo
# mirara. La compuerta que esa frase daba por hecha es `[CI.SELLO]`, más abajo: exige que el
# commit esté sellado por el CI (`build` + `secret-scan`) antes de construir.
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
# ⚠️ El repo se RENOMBRÓ a `MegaDulces_Suite` (medido el 2026-09-30). GitHub redirige el nombre
#    viejo, así que esto venía funcionando por cortesía del redirect, no por estar bien.
REMOTO="git@github.com:edgarcg-01/MegaDulces_Suite.git"
RAMA="${AUTO_DEPLOY_BRANCH:-main}"
LLAVE="${AUTO_DEPLOY_KEY:-$HOME/.ssh/deploy_md}"
# `[VL.20.4]` `SERVICIOS` YA NO SE FIJA ACÁ: se calcula más abajo, cuando ya se sabe contra qué
# commit comparar (api y worker siempre; portal y vendedor sólo si cambiaron). Dejarlo también
# acá daría dos fuentes de verdad para lo mismo. `AUTO_DEPLOY_SERVICIOS` sigue mandando.
JOB=auto_deploy
TENANT="${CRON_TENANT_ID:-00000000-0000-0000-0000-00000000d01c}"

SECO=0; [ "${1:-}" = "--seco" ] && SECO=1
ESTADO=0; [ "${1:-}" = "--estado" ] && ESTADO=1

di() { echo "[$(date '+%F %T %Z')] $*"; }

# ── [VL.20.4] EL MAPA servicio → imagen / contenedor, UNA sola vez ──────────────────────────
# Este `case` estaba copiado TRES veces —`guardar_anteriores()`, el bucle de construcción y
# `revertir()`— cada una con su propio `*) continue`. Al sumar `portal` y `vendedor` habría
# divergido en la tercera, y la tercera es `revertir()`: o sea que el modo de falla habría sido
# **desplegar dos servicios sin nada a qué volver**, callado, hasta el día que hiciera falta.
# Verificado contra `md`: los contenedores son `prod-api`, `prod-worker`, `prod-portal`,
# `prod-vendor` (el compose los nombra así; `pg-prod` y `pg-rag` NO siguen el patrón, pero este
# carril no los toca).
img_de()  { case "$1" in api) echo trade-prod-api ;; worker) echo trade-prod-worker ;; portal) echo trade-prod-portal ;; vendor) echo trade-prod-vendor ;; *) echo '' ;; esac; }
# [K3S.22] `api2` sale del mapa: el servicio se retiró del compose el 2026-10-01. Dejarlo acá
# no es inocuo — `cont_de api2` devolvería `prod-api-2`, el carril intentaría recrear un
# servicio que ya no existe, y fallaría cada 5 minutos sobre algo que está bien.
cont_de() { case "$1" in api) echo prod-api ;; worker) echo prod-worker ;; portal) echo prod-portal ;; vendor) echo prod-vendor ;; *) echo '' ;; esac; }

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

# ── [VL.20.4] QUÉ SERVICIOS ENTRAN — portal y vendedor sólo si cambiaron ────────────────────
# ⛔ EL HUECO QUE CIERRA: hasta hoy este carril construía **sólo `api` y `worker`**. Medido el
# 2026-09-24, las imágenes de `portal` y `vendedor` tenían **34 horas**: un commit que tocara
# esas dos apps se mergeaba a `main` y **nunca llegaba a producción**, sin que nada lo dijera.
# (El frontend principal sí viajaba: `apps/view` va adentro de `trade-prod-api`.)
#
# `api` y `worker` van SIEMPRE, y no es pereza: `/api/health` y el humo del login son las dos
# comprobaciones de entrega de este carril, y las dos viven en el API. Además, con el grafo
# unificado el API es quien materializa `deps`/`src`/`build-api`, así que las otras imágenes
# salen casi gratis después.
#
# ⚠️ ES UNA HEURÍSTICA DE RUTAS, NO EL GRAFO DE Nx, y se declara. Lo correcto sería
# `nx show projects --affected`, pero `md` tiene el clon **sin `node_modules`**: Nx no puede
# correr acá. Entonces se hace CONSERVADORA — ante cualquier cambio compartido (o ante la duda,
# o si no se puede comparar) entran las cuatro. Equivocarse de más cuesta minutos de CPU;
# equivocarse de menos deja producción atrás sin avisar, que es el defecto que esto cierra.
# [K3S.22] Sin `api2`: el servicio se retiró del compose el 2026-10-01. ⚠️ Ojo con la lección
# que lo puso acá en primer lugar — `api2` ENTRÓ a esta lista porque NO estar en ella la dejó
# ocho horas sirviendo otra versión. Sacarla ahora es correcto sólo porque el servicio dejó de
# existir; si vuelve a haber una segunda réplica en Compose, tiene que volver a esta línea.
SERVICIOS="api worker"
_extra=''
if [ "$VIVO" != desconocido ] && git cat-file -e "$VIVO^{commit}" 2>/dev/null; then
  _cambios=$(git diff --name-only "$VIVO" "$DESEADO" 2>/dev/null)
  if echo "$_cambios" | grep -qE '^(libs/|package(-lock)?\.json|nx\.json|tsconfig|eslint\.config\.js|vitest\.shared\.ts|Dockerfile)'; then
    _extra='portal vendor'
    di "cambió algo compartido ⇒ entran también portal y vendedor"
  else
    echo "$_cambios" | grep -q '^apps/portal/' && _extra="$_extra portal"
    echo "$_cambios" | grep -q '^apps/vendor/' && _extra="$_extra vendor"
  fi
else
  _extra='portal vendor'
  di "no se pudo comparar contra $VIVO ⇒ se construyen las cuatro (conservador)"
fi
[ -n "$_extra" ] && SERVICIOS="$SERVICIOS $_extra"
# Se puede forzar la lista completa con AUTO_DEPLOY_SERVICIOS, igual que antes.
SERVICIOS="${AUTO_DEPLOY_SERVICIOS:-$SERVICIOS}"
di "servicios: $SERVICIOS"

# ═══ [K3S.27] QUÉ SE CONSTRUYE ≠ QUÉ SE DESPLIEGA DÓNDE ═════════════════════════════════════
#
# `$SERVICIOS` es "lo que cambió y hay que construir". Eso NO dice en qué mundo vive cada uno.
# Hasta el 2026-10-01 daba igual porque todos estaban en Compose; desde que `portal` y `vendor`
# viven en K3s, pasar la lista entera a `docker compose up -d` RESUCITA sus contenedores —
# la misma trampa que ya mordió con `depends_on` ([K3S.19], [K3S.23]).
#
# ⛔ ESTA LISTA Y LA ETIQUETA `migracion:` DE ops/k3s/*.yaml SON DOS DECLARACIONES DEL MISMO
# HECHO. Si se contradicen, el servicio se despliega en el mundo equivocado o en ninguno.
# Se mueven juntas, y `npm run check:k3s` compara el lado de `SERVICIOS_DEF`.
SERVICIOS_K3S="${AUTO_DEPLOY_SERVICIOS_K3S:-portal vendor worker api}"

SERVICIOS_COMPOSE=''
_s_k3s_tocados=''
for s in $SERVICIOS; do
  case " $SERVICIOS_K3S " in
    *" $s "*) _s_k3s_tocados="$_s_k3s_tocados $s" ;;
    *)        SERVICIOS_COMPOSE="$SERVICIOS_COMPOSE $s" ;;
  esac
done
SERVICIOS_COMPOSE=$(echo "$SERVICIOS_COMPOSE" | sed 's/^ *//')
_s_k3s_tocados=$(echo "$_s_k3s_tocados" | sed 's/^ *//')
di "   en Compose: ${SERVICIOS_COMPOSE:-(ninguno)}  ·  en K3s: ${_s_k3s_tocados:-(ninguno)}"

if [ "$SECO" = 1 ]; then di "SECO: acá se construiría y recrearía ($SERVICIOS). No se toca nada."; exit 0; fi

# ── La compuerta de migraciones, ANTES de construir ─────────────────────────
# Se reusa la de `deploy.sh` en vez de reimplementarla: dos compuertas para lo mismo divergen, y
# la que se olvide de actualizar es la que va a dejar pasar el despliegue malo (ADR-056).
# ⛔ `LC_ALL=C` NO es cosmético. Sin él `sort` usa el orden de la configuración regional y `comm`
# —que exige orden byte a byte— avisa `archivo 1 no está en orden ordenado` **por stderr** y
# devuelve un resultado que no vale. Con `2>/dev/null` de por medio ese aviso no se ve, y la
# compuerta puede DEJAR PASAR una migración pendiente o inventar una que no existe. Medido el
# 2026-09-24 en `md`: los tres avisos salieron; esa vez el veredicto coincidió de casualidad
# (4 pendientes con los dos órdenes), lo cual es justo lo que vuelve invisible al defecto.
docker exec pg-prod psql -U postgres -At -d railway -c 'SELECT name FROM public.knex_migrations' 2>/dev/null \
  | tr -d '\r' | grep -E '\.js$' > /tmp/ad-prod.txt
if [ ! -s /tmp/ad-prod.txt ]; then
  di "FALLO: no se pudo leer public.knex_migrations — estado de migraciones NO MEDIDO. No se despliega a ciegas."
  latir error "no se pudo leer knex_migrations"; exit 1
fi

# ── [VL.21] CLASIFICA, NO SÓLO RESTA ────────────────────────────────────────
# ⛔ El 2026-09-24 esta compuerta frenó un despliegue por DOS migraciones que **no había que
# aplicar**: los nombres viejos de un renombre a medio commitear, cuyo contenido ya había
# corrido en prod bajo otro nombre. El reflejo natural —aplicarlas— habría dejado en
# `knex_migrations` una fila para un archivo que al commitearse el renombre deja de existir,
# que es el estado que este proyecto ya vivió como "directory corrupt" → crash loop.
# La lógica vive en `clasificar-migraciones.awk`, compartido con `deploy.sh`, porque dos
# compuertas para lo mismo divergen y la que se olvide es la que va a dejar pasar el error.
#
# ⭐ Y se va `comm -23` con su `LC_ALL=C`: comparar por blob de git no depende del orden, así
# que el modo de falla del `sort` regional deja de existir en vez de quedar tapado.
CLASIF="$HOME/ops/prod/clasificar-migraciones.awk"
if [ ! -f "$CLASIF" ]; then
  di "FALLO: falta $CLASIF — no se puede clasificar y no se despliega a ciegas."
  di "  Se sube con: ops/prod/deploy.sh --imagenes (subir_compose lo sincroniza)."
  latir error "falta clasificar-migraciones.awk en md"; exit 1
fi
git ls-tree -r HEAD database/migrations-newdb/ \
  | awk '{ n = split($4, p, "/"); if (p[n] ~ /\.js$/) print $3 " " p[n] }' > /tmp/ad-blobs.txt
CLAS=$(awk -v prod=/tmp/ad-prod.txt -f "$CLASIF" /tmp/ad-blobs.txt) || {
  di "FALLO: el clasificador de migraciones salió con error. NO MEDIDO."
  latir error "clasificador de migraciones falló"; exit 1
}
DUPS=$(printf '%s\n' "$CLAS" | grep '^DUP ' || true)
PEND=$(printf '%s\n' "$CLAS" | grep '^PEND ' | sed 's/^PEND //' || true)

if [ -n "$DUPS" ]; then
  di "ℹ️ $(echo "$DUPS" | wc -l | tr -d ' ') archivo(s) que prod no tiene pero cuyo contenido YA corrió con otro nombre (renombre a medio commitear) — NO se aplican, NO frenan:"
  echo "$DUPS" | sed 's/^DUP /      /; s/ / → ya aplicada como /2'
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

# ── `[CI.SELLO]` La compuerta de CI, ANTES de construir ─────────────────────
# Sólo se despliega un commit que el CI haya SELLADO (job `sellar` en ci.yml, que mueve la rama
# marcadora `ci-green` cuando `build` y `secret-scan` pasan).
#
# ── Por qué acá y no en GitHub ──────────────────────────────────────────────
# Porque la protección de rama no se va a comprar (decisión del 2026-09-30) y en un repo privado
# de plan free no existe. La cabecera de este archivo decía "acá sólo entra lo que pasó por la
# rama protegida" — **era falso**: `main` no tiene ninguna protección, así que hasta hoy este
# script desplegaba lo que hubiera en `origin/main`, verde o rojo. Ésta es la compuerta que esa
# frase daba por hecha.
#
# ⭐ Y es la única que NO se evade: `.githooks/pre-push` vive en la máquina de cada dev, se salta
# con `--no-verify` y no existe para quien no corrió `npm run hooks:install`. Esto corre en `md`.
#
# ── Qué frena y qué no, a propósito ─────────────────────────────────────────
#   · build roto o secreto filtrado → FRENA. Lo primero no funciona; lo segundo ya se filtró.
#   · lint/tests/estilo (`verify`)  → NO frena. Hoy está rojo por deuda preexistente y exigirlo
#     dejaría a producción sin despliegues desde el primer día. Se declara en el CI.
#
# ⚠️ "Todavía sin sello" NO es un error: el CI tarda ~4 min y la agenda dispara cada 5, así que
#    la pasada que sigue a un push normalmente llega antes que el sello. Eso late `ok` y espera.
#    Recién a los 30 min se vuelve error — para entonces no es que falte, es que falló.
# ⚠️ Si `ci-green` no se puede traer, esto NO frena: no haber medido no es motivo para bloquear
#    un despliegue (ADR-056, mismo criterio que la auto-reversión con la red caída).
# ⚠️ La lógica NO vive acá: vive en `compuerta-ci.sh`, por lo mismo que `clasificar-migraciones.awk`
#    — para que `test-compuerta-ci.sh` pueda correr EL MISMO archivo que corre en producción.
COMPUERTA_CI="$HOME/ops/prod/compuerta-ci.sh"
AVISO_CI=""   # se llena sólo si se desplegó sin compuerta; viaja hasta el latido final
if [ "${AUTO_DEPLOY_SIN_CI:-0}" = "1" ]; then
  di "compuerta CI: SALTEADA a mano (AUTO_DEPLOY_SIN_CI=1)"
elif [ ! -f "$COMPUERTA_CI" ]; then
  # ⛔ NO se frena por esto, y la primera versión SÍ lo hacía — habría parado TODOS los despliegues
  #    desde el commit que la introdujo hasta que alguien hiciera el `scp`. Los archivos de
  #    `ops/prod/` llegan a `md` a mano (igual que `clasificar-migraciones.awk`), así que "todavía
  #    no está copiada" es el estado NORMAL el día que esto se publica, no una avería.
  # ⚠️ Pero tampoco se finge verde: late `ok` con la nota que lo dice, así se ve en Salud BD que la
  #    compuerta NO está puesta. Un gate ausente que no se declara es indistinguible de uno que
  #    pasa — que es exactamente cómo este repo llegó a desplegar rojo sin que nadie lo notara.
  di "compuerta CI: NO INSTALADA — falta $COMPUERTA_CI en md. Se sigue, pero NADIE está mirando el CI."
  di "  Instalarla:  scp ops/prod/compuerta-ci.sh superoot@192.168.0.222:~/ops/prod/"
  # ⚠️ El aviso viaja hasta el latido FINAL, no se late acá: el `latir ok` del cierre pisaría a
  #    éste y en Salud BD no quedaría rastro de que se desplegó a ciegas.
  AVISO_CI=" · ⚠️ SIN compuerta de CI (falta compuerta-ci.sh en md)"
else
  VEREDICTO=$(sh "$COMPUERTA_CI" "$REPO_DIR" HEAD 2>&1); RC=$?
  case "$RC" in
    0)  di "compuerta CI: $VEREDICTO" ;;
    10) di "compuerta CI: $VEREDICTO"
        di "  El CI tarda ~4 min y esta agenda dispara cada 5; la pasada que viene lo agarra."
        latir ok "esperando el sello del CI para $DESEADO"
        exit 0 ;;
    30) di "compuerta CI: $VEREDICTO — se sigue, no se frena por no haber medido (ADR-056)." ;;
    *)  di "FRENADO: $VEREDICTO"
        di "  O falló build/secret-scan, o el job 'sellar' no corrió. Mirá: gh run list --branch $RAMA --limit 3"
        di "  Escape de emergencia: AUTO_DEPLOY_SIN_CI=1 sh \$HOME/ops/prod/auto-deploy.sh"
        latir error "$DESEADO sin sello del CI — despliegue frenado"
        exit 1 ;;
  esac
fi

# ── Construir y recrear ─────────────────────────────────────────────────────
# ⚠️ Las funciones se DEFINEN antes de usarlas: en `sh` no hay izado. Estaba declarada 50
# lineas mas abajo y el 2026-09-24 la corrida real imprimio `guardar_anteriores: not found` y
# siguio como si nada (`set -u` cubre variables, no comandos) — o sea que el despliegue corria
# **con la reversion desarmada**, que es justo el defecto que esta funcion existe para cerrar.
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
    c=$(cont_de "$s"); [ -n "$c" ] || continue
    _id=$(docker inspect -f '{{.Image}}' "$c" 2>/dev/null)
    [ -n "$_id" ] && eval "PREV_$s=\$_id"
  done
}

ANTERIOR="$VIVO"
# ⛔ ANTES de construir. El `docker build -t …:latest` PISA la etiqueta `latest`, así que después
# del build ya no hay forma de saber qué imagen estaba sirviendo cada servicio.
#
# ⛔ Y se comprueba que la función EXISTA. `sh` no falla ante un comando inexistente: escribe
# `not found` por stderr y SIGUE. Como la salida del carril va a un log que nadie mira en vivo,
# eso permite que el despliegue corra **con la reversión desarmada** — es lo que pasó a las 14:20
# del 2026-09-24, con la función declarada 50 líneas más abajo (en `sh` no hay izado). `sh -n`
# tampoco lo ve: es sintácticamente válido. La única forma de que se note es preguntar.
command -v guardar_anteriores >/dev/null 2>&1 || {
  di "FALLO: guardar_anteriores no está definida — la reversión quedaría sin a qué volver. No se despliega."
  latir error "auto-deploy roto: guardar_anteriores no definida"
  exit 1
}
guardar_anteriores
cd "$REPO_DIR" || exit 1
# ── [VL.20.1/.4] UN GRAFO, CUATRO DESTINOS ──────────────────────────────────────────────────
# Las cuatro apps salen del MISMO `/Dockerfile` con `--target`. Antes eran cuatro archivos
# (herencia de Railway) y **el worker recompilaba `nx build api`, la misma tarea que la imagen
# de api acababa de compilar 3 minutos antes**. Verificado el 2026-09-24 con `--progress=plain`:
# en el build del worker el paso `build-api` ahora sale `CACHED`, y el worker bajó de 1m34–1m54
# a **57 s** (de los cuales 45 s son el `COPY` de `node_modules`, que es su piso real).
#
# ⛔ EL ORDEN ESTÁ FIJO Y NO SE TOCA: `api` primero, porque es quien materializa `deps`, `src`
# y `build-api`. Por eso se recorre esta lista y no `$SERVICIOS`, que puede venir en cualquier
# orden.
#
# `GIT_COMMIT_ISO`: el sello de portal/vendedor dejó de llevar un reloj de pared (`date -u`),
# que los condenaba a nunca acertar el caché de Nx. ⚠️ `--date=format:` NO respeta `TZ` (usa la
# zona del commit); va `--date=format-local:`. Medido: con `format:` un commit de las 18:16
# -06:00 salía rotulado `18:16:50Z`, una hora falsa.
COMMIT_ISO=$(TZ=UTC git show -s --date=format-local:'%Y-%m-%dT%H:%M:%SZ' --format=%cd HEAD 2>/dev/null)

# ⛔ EL GUION Y EL REPO TIENEN QUE HABLAR EL MISMO IDIOMA, y se comprueba antes de construir.
# Este archivo vive INSTALADO en `~/ops/prod/` y el código viene de `origin/$RAMA`: son dos
# cosas que se actualizan por caminos distintos y pueden quedar desfasadas. Si esta versión
# —que construye por `--target`— se encuentra un `Dockerfile` viejo (uno por servicio), el
# `docker build` fallaría con un error de Docker que no menciona la causa.
# Se declara el desfase con el arreglo al lado (ADR-056), en vez de dejar 288 fallos por día
# con un mensaje que no se entiende.
if ! grep -q 'AS runner-api' Dockerfile 2>/dev/null; then
  di "FALLO: el Dockerfile de $DESEADO no tiene destinos (\`AS runner-api\`), pero este carril"
  di "  construye con \`--target\`. El guion instalado va ADELANTE del código de origin/$RAMA."
  di "  Arreglo: subí el commit del grafo unificado, o reinstalá la versión anterior del carril."
  latir error "auto-deploy desfasado: el Dockerfile de $DESEADO no declara runner-api"
  exit 1
fi

for s in api worker portal vendor; do
  case " $SERVICIOS " in *" $s "*) ;; *) continue ;; esac
  img=$(img_de "$s"); [ -n "$img" ] || continue
  di "construyendo $img:$DESEADO"
  if ! docker build -q -f Dockerfile --target "runner-$s" \
        --build-arg GIT_COMMIT_SHA="$DESEADO" --build-arg GIT_COMMIT_ISO="$COMMIT_ISO" \
        -t "$img:$DESEADO" -t "$img:latest" . >/tmp/auto-build-$s.log 2>&1; then
    di "FALLO: no compiló $img"
    tail -15 /tmp/auto-build-$s.log | sed 's/^/      /'
    latir error "build de $img falló en $DESEADO"; exit 1
  fi
done

# ═══ [K3S.24] AL REGISTRY, EN CADA DESPLIEGUE ══════════════════════════════════════════════
#
# Este es el camino que despliega ~7 veces al día; `ops/prod/deploy.sh` casi no se usa. Una
# política escrita sólo en el carril que nadie corre es una política que no existe — medido con
# la poda de imágenes, que vivía ahí y dejó 80 GB de caché sin tope ([VL.20.5]).
#
# Se publica aunque hoy NINGÚN pod de prod consuma estas imágenes: las cuatro apps siguen en
# Compose. El camino tiene que existir antes del corte, no inventarse el día del corte.
#
# ⚠️ No frena el despliegue si falla: nada en producción depende todavía del registry.
# ⛔ EL DÍA QUE UNA APP MIGRE A K3s ESTO TIENE QUE FRENAR — si no, el pod se queda con la
#    imagen vieja y el carril reporta DESPLEGADO igual. Es exactamente el defecto del
#    2026-10-01, y la única razón de que hoy sea un aviso es que nadie lo consume.
for s in $SERVICIOS; do
  img=$(img_de "$s"); [ -n "$img" ] || continue
  docker image inspect "$img:$DESEADO" >/dev/null 2>&1 || continue
  docker tag "$img:$DESEADO" "localhost:5000/$img:$DESEADO" 2>/dev/null
  if docker push "localhost:5000/$img:$DESEADO" >/dev/null 2>&1; then
    di "publicada localhost:5000/$img:$DESEADO"
  else
    di "⚠️ no se pudo publicar $img:$DESEADO (no frena: hoy ningun pod de prod lo consume)"
  fi
done

# ═══ [K3S.26] Y LO QUE VIVE EN K3s ═════════════════════════════════════════════════════════
#
# HOY ES UN NO-OP, a propósito: los manifiestos de prod están marcados `migracion: preparado`
# —las cuatro apps corren en Compose— así que el guion no aplica nada y sale 0.
#
# ⭐ Se cablea igual, y ANTES de que haga falta. El 2026-10-01 se intentó mover `portal` y
# `vendor` al clúster y hubo que revertir en el acto, porque este carril actualizaba Compose y
# no K3s: el primer despliegue compartido los habría dejado viejos EN SILENCIO. Construir el
# camino el día del corte es cómo el corte termina haciéndose a mano.
#
# ⛔ Va ANTES del `up -d` de Compose y ABORTA si falla. Los servicios de los dos mundos son
# disjuntos (lo candadea `npm run check:k3s`), así que no hay orden "correcto" entre ellos —
# pero un despliegue a medias que reporta éxito parcial es peor que uno que no ocurrió.
if [ -f "$HOME/ops/prod/aplicar-k3s-prod.sh" ]; then
  if _k3s_out=$(sh "$HOME/ops/prod/aplicar-k3s-prod.sh" "$DESEADO" 2>&1); then
    echo "$_k3s_out" | sed 's/^/      /'
  else
    di "FALLO: no se pudo aplicar a K3s"
    echo "$_k3s_out" | sed 's/^/      /'
    latir error "apply a K3s falló en $DESEADO"
    exit 1
  fi
fi

cd "$HOME/ops/prod" || exit 1
set -a; . "$HOME/secrets/prod-compose.env"; set +a
# ⛔ [K3S.29] SÓLO SI HAY ALGO QUE LEVANTAR. `docker compose up -d` SIN argumentos no es un
# no-op: levanta TODO el perfil por defecto. Desde que `api` se fue a K3s esta lista puede
# quedar vacía en un despliegue normal, y entonces este comando tocaría `pg-prod`, `pg-rag`,
# `backup` y el `registry` — servicios que este carril no tiene por qué recrear.
if [ -n "$SERVICIOS_COMPOSE" ]; then
  docker compose -p prod up -d $SERVICIOS_COMPOSE >/dev/null 2>&1
else
  di "   nada que levantar en Compose (todo lo tocado vive en K3s)"
fi

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
  # `[VL.20.4]` Se vigilan los contenedores que ESTE despliegue tocó, no dos fijos: con portal y
  # vendedor en la lista, dejarlos fuera sería desplegarlos sin mirar si arrancan.
  # ⚠️ [K3S.27] Sólo los de COMPOSE: un servicio que vive en K3s no tiene contenedor, y
  # `docker inspect` de uno apagado devolvería "exited" — que no es un bucle de reinicio, así
  # que este bucle lo daría por bueno sin haber mirado nada. A los pods los verifica
  # `aplicar-k3s-prod.sh`, que espera el rollout y corta ante ImagePullBackOff.
  for s in $SERVICIOS_COMPOSE; do
    c=$(cont_de "$s"); [ -n "$c" ] || continue
    _st=$(docker inspect -f '{{.State.Status}} {{.State.Restarting}} {{.RestartCount}}' "$c" 2>/dev/null)
    case "$_st" in
      *"true "*|restarting*)
        di "FALLO RÁPIDO: $c en bucle de reinicio ($_st) — el proceso muere al arrancar."
        docker logs --tail 40 "$c" 2>&1 | grep -iE "error|exception|cannot resolve|UnknownDependencies" | head -6 | sed 's/^/      /'
        revertir; latir error "$c no arranca con $DESEADO (bucle de reinicio) — revertido"; exit 1 ;;
    esac
  done
  r=$(curl -s --max-time 5 http://127.0.0.1:30080/api/health 2>/dev/null)
  vivo_ahora=$(printf '%s' "$r" | sed -n 's/.*"commit":"\([^"]*\)".*/\1/p')
  # ⛔ [K3S.30] SE ESPERA EL COMMIT ESPERADO, NO "cualquier respuesta". Esta línea decía
  # `[ -n "$vivo_ahora" ] && break` y en el mundo de Compose era correcta: `docker compose up`
  # RECREA el contenedor, así que mientras tanto el puerto está cerrado y la primera respuesta
  # ya era, por construcción, la del binario nuevo.
  #
  # En K8s eso deja de ser cierto y no un poco: el Service CONTESTA SIEMPRE. Durante el rollout
  # hay pods viejos todavía en los endpoints, así que la primera respuesta puede ser —y fue— la
  # versión ANTERIOR. Medido el 2026-10-01 19:16: el apply decía «todos los deployments al día
  # en :843521b», el pod nuevo estaba Ready, y este chequeo leyó `6bb8e4f` y REVIRTIÓ un
  # despliegue que estaba bien. Un falso rojo que deshace trabajo correcto es peor que no tener
  # chequeo: enseña a desactivarlo.
  #
  # ⚠️ Y hay un agravante propio de este Service: `sessionAffinity: ClientIP`. El curl sale
  # siempre del mismo origen (127.0.0.1), así que kube-proxy lo pega a UN pod — justamente el
  # que puede ser el viejo. Reintentar sin exigir el commit esperado no corrige eso.
  if [ "$DESEADO" = desconocido ]; then
    [ -n "$vivo_ahora" ] && break
  elif [ "$vivo_ahora" = "$DESEADO" ]; then
    break
  fi
  sleep 5
done

revertir() {
  di "REVIRTIENDO"
  # El commit queda marcado acá, en el único lugar por donde pasan TODOS los caminos de reversión.
  # Ponerlo en cada sitio de llamada es cómo se olvida en el tercero.
  echo "$DESEADO" > "$CUARENTENA" 2>/dev/null || di "aviso: no se pudo escribir la cuarentena"
  _falta=''
  for s in $SERVICIOS; do
    img=$(img_de "$s"); [ -n "$img" ] || continue
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
  # ⛔ [K3S.29] Mismo blindaje que arriba: sin argumentos, `--force-recreate` recrearía TODO
  # el perfil por defecto. En un camino de REVERSIÓN eso es peor todavía.
  [ -n "$SERVICIOS_COMPOSE" ] && cd "$HOME/ops/prod" && docker compose -p prod up -d --force-recreate $SERVICIOS_COMPOSE >/dev/null 2>&1
  # ⛔ [K3S.27] Y LOS DE K3s TAMBIÉN SE REVIERTEN. Retaguear `:latest` en Docker no mueve un
  # pod: el Deployment pide una imagen por COMMIT. `rollout undo` lo devuelve al ReplicaSet
  # anterior, cuya imagen sigue en containerd. Sin esto, "revertido." sería mentira para la
  # mitad del despliegue — y mentir en el camino de reversión es peor que no tenerlo.
  for s in $_s_k3s_tocados; do
    if KUBECONFIG=/etc/rancher/k3s/k3s.yaml k3s kubectl rollout undo "deploy/$s" -n prod >/dev/null 2>&1; then
      di "  $s (K3s) → rollout undo"
    else
      di "  ⛔ $s (K3s): NO se pudo revertir"
      _falta="$_falta $s(k3s)"
    fi
  done
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

# ── `[VL.15.D2]` Y AHORA CADA RÉPLICA, no "una cualquiera por el balanceador" ───────────────
# El chequeo de arriba hace UN `curl` al 8080, que es Caddy, que balancea entre `api` y `api2`
# con `lb_policy cookie`: la respuesta viene de UNA de las dos, y cuál es azar.
#
# ⛔ MEDIDO EL 2026-10-01, y por eso existe esto: `prod-api` servía `13a2379` y `prod-api-2`
# servía `477319f`. **Ocho horas sirviendo DOS versiones a la vez**, repartidas por cookie — y
# este chequeo daba verde todas las veces, porque le tocaba la buena. La causa era que
# `SERVICIOS` decía `"api worker"` y nunca recreaba la segunda réplica: la que `[INFRA.2]` puso
# para que el despliegue no cortara servicio era, justamente, la que se quedaba vieja.
#
# ⚠️ `api2` NO se reconstruye —comparte `trade-prod-api:latest` con `api`, y el bucle de build
# recorre una lista fija que no la incluye— pero sí tiene que RECREARSE. Por eso entró a
# `SERVICIOS`; esto es el candado que comprueba que de verdad entró.
# ⚠️ Se le pregunta a cada contenedor DIRECTO (`docker exec`), no por el 8080: preguntarle al
# balanceador es exactamente lo que no distingue una réplica de la otra.
# ⚠️ `node`, no `curl`/`wget`: la imagen del API no los trae (verificado).
# ⛔ [K3S.30] AHORA SE LE PREGUNTA A CADA **POD**, no a contenedores que ya no existen.
#
# Este bucle iteraba `docker ps | grep '^prod-api'`. Desde que el API vive en K3s esa lista
# está VACÍA, así que el bucle no fallaba: no hacía NADA. Y lo que dejaba de hacer es
# justamente la razón por la que existe — `[VL.15.D2]` lo escribió después de medir **ocho
# horas sirviendo DOS versiones a la vez**, repartidas por cookie, con el chequeo general en
# verde porque siempre le tocaba la buena.
#
# ⭐ Una compuerta que se queda sin sujeto no avisa: simplemente deja de proteger. Y con
# `sessionAffinity: ClientIP` el chequeo general es todavía MENOS capaz de distinguir una
# réplica de otra, porque sale siempre del mismo origen y se pega a un solo pod.
#
# ⚠️ `node`, no `curl`/`wget`: la imagen del API no los trae (verificado).
_KC=/etc/rancher/k3s/k3s.yaml
for _p in $(KUBECONFIG=$_KC k3s kubectl get pods -n prod -l app=api \
              -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null); do
  # ⛔ [K3S.31] SE SALTEAN LOS QUE SE ESTÁN MURIENDO. La primera versión de este bucle
  # preguntaba a TODOS los pods con la etiqueta `app=api`, y durante un rollout esa lista
  # incluye a los VIEJOS en estado Terminating. `kubectl exec` contra uno que se apaga no
  # devuelve nada, y "nada" se leía como desfasaje → revirtió un despliegue correcto.
  # Medido el 2026-10-01 19:21: «el pod api-68bdb57986-2n2r5 sirve 'nada'» — y ese hash era
  # el del ReplicaSet anterior.
  # ⭐ `deletionTimestamp` es la pregunta exacta: no "¿está listo?" sino "¿lo están matando?".
  if [ -n "$(KUBECONFIG=$_KC k3s kubectl get pod -n prod "$_p" -o jsonpath='{.metadata.deletionTimestamp}' 2>/dev/null)" ]; then
    di "pod $_p: Terminating, no se le pregunta"
    continue
  fi
  # Un pod vivo puede tardar un instante en aceptar `exec`. Vacío se REINTENTA; lo que no se
  # reintenta es un commit DISTINTO, que es el defecto que este candado existe para atrapar
  # (`[VL.15.D2]`: ocho horas sirviendo dos versiones a la vez).
  _k=''
  for _i in 1 2 3 4 5 6; do
    _k=$(KUBECONFIG=$_KC k3s kubectl exec -n prod "$_p" -c api -- \
          node -e 'fetch("http://127.0.0.1:10000/api/health").then(r=>r.json()).then(j=>console.log(j.commit)).catch(()=>console.log(""))' 2>/dev/null)
    [ -n "$_k" ] && break
    sleep 5
  done
  if [ "$DESEADO" != desconocido ] && [ "$_k" != "$DESEADO" ]; then
    di "FALLO: el pod $_p sirve '${_k:-nada}' y se levantó '$DESEADO'."
    revertir; latir error "pod $_p desfasado tras desplegar $DESEADO — revertido a $ANTERIOR"; exit 1
  fi
  di "pod $_p sirve $_k"
done

codigo=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 \
  -X POST http://127.0.0.1:30080/api/auth-mt/login \
  -H 'Content-Type: application/json' -d '{"username":"zz_humo_auto","password":"zz"}' 2>/dev/null || echo 000)
case "$codigo" in
  401|403) di "humo del login: $codigo — la puerta contesta." ;;
  429)     di "humo del login: 429 (throttler) — NO se pudo medir. No se revierte por no haber medido." ;;
  *)
    di "FALLO: el login respondió $codigo. El binario es el correcto pero la aplicación NO sirve."
    revertir; latir error "humo del login $codigo en $DESEADO — revertido a $ANTERIOR"; exit 1 ;;
esac

di "DESPLEGADO $DESEADO (venía de $ANTERIOR)"
latir ok "desplegado $DESEADO desde $ANTERIOR · servicios: $SERVICIOS$AVISO_CI"

# ── [VL.20.5] LA PODA, DESPUÉS DE DESPLEGAR ─────────────────────────────────────────────────
# ⛔ Acá estaba el agujero: `podar_imagenes()` existía en `deploy.sh` y funcionaba, pero el
# camino que despliega **7 veces al día** es ÉSTE, y nunca la llamaba. Medido el 2026-09-24:
# **12 etiquetas** de `api` y 12 de `worker` con `RETENER_IMG=5`, y **80.23 GB** de caché de
# construcción sin ningún tope. La política existía; el carril que la necesita no la conocía.
#
# Va DESPUÉS del latido de éxito y nunca hace fallar el despliegue: una tarea de limpieza que
# tumba lo que acaba de salir bien es peor que no tenerla (mismo criterio que la bitácora).
# Si el script todavía no está en `md` (lo sube `deploy.sh subir_compose`), se dice y se sigue.
if [ -x "$HOME/ops/prod/podar-disco.sh" ] || [ -f "$HOME/ops/prod/podar-disco.sh" ]; then
  sh "$HOME/ops/prod/podar-disco.sh" 2>&1 | sed 's/^/      /' || di "aviso: la poda falló (el despliegue NO se toca)"
else
  di "aviso: falta ~/ops/prod/podar-disco.sh — no se podó (corré ops/prod/deploy.sh --imagenes para subirlo)"
fi
