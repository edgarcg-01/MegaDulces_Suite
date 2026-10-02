#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# VL.9 — DESPLIEGUE de PRODUCCIÓN al servidor `md` (192.168.0.222).
#
#   ops/prod/deploy.sh --estado        # qué corre allá, QUÉ FALTA subir, y los últimos deploys
#   ops/prod/deploy.sh --imagenes      # construye las 7 imágenes, no recrea nada
#   ops/prod/deploy.sh --imagenes api  # …o sólo la de ese servicio
#   ops/prod/deploy.sh --db            # sólo levanta pg-prod + pg-rag
#   ops/prod/deploy.sh --recrear api   # sube el compose y recrea, SIN reconstruir imágenes
#   ops/prod/deploy.sh --tunel         # levanta/recrea el Cloudflare Tunnel (perfil `tunel`)
#   ops/prod/deploy.sh --volver 4bf36b2 # ROLLBACK: reapunta :latest a esa versión y recrea
#   ops/prod/deploy.sh --verificar     # ¿está funcionando? con datos, no con rótulos
#   ops/prod/deploy.sh --pitr          # ensayo de recuperación a un punto en el tiempo
#   ops/prod/deploy.sh                 # construye y recrea todo
#   ops/prod/deploy.sh api worker      # construye y recrea SÓLO esos (desde [VL.11.D])
#   ops/prod/deploy.sh --sin-migraciones "<motivo>" api   # desarma la compuerta, con motivo
#
# ── [VL.15] Las tres cosas que un despliegue ahora hace y antes no ──────────
#   B. FRENA si HEAD trae migraciones que prod no tiene aplicadas (antes de construir).
#   D. VERIFICA que `/api/health` sirva el commit que se acaba de levantar, y FALLA si no.
#   C. ANOTA en `ops.deploys` de prod: commit, servicios, resultado, quién, cuándo.
# Las tres nacen del mismo día: el 2026-09-23 la imagen viva estaba 63 commits atrás con 6
# migraciones sin aplicar, y no había forma de saberlo sin ir a mirar a mano.
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
# � [K3S.17] api, worker, portal y vendor SALIERON: viven en K3s desde 2026-10-01.
# Quedan los que NO migraron: los dos Postgres (16.3 GiB de estado contra 1.06 GiB de
# proceso -- ver ops/k3s/README.md) y el respaldo, que depende de ellos.
# [K3S.22 2026-10-01] VUELVEN api/worker/portal/vendor/redis. Se habían sacado al migrarlos a
# K3s, pero la migración se PAUSÓ el mismo día: los pods quedaron 36 commits atrás porque no
# existe camino automático de build → containerd, y sirvieron ese build a los usuarios internos.
# Mientras corran en Compose tienen que estar acá, o `--todo` los deja fuera del despliegue.
# ⚠️ Esta línea y la etiqueta `migracion:` de ops/k3s/*.yaml son DOS declaraciones del mismo
# hecho — `npm run check:k3s` las compara y se pone rojo si se contradicen. Se mueven juntas.
SERVICIOS_DEF="registry pg-prod pg-rag redis api backup"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM

# `--sin-migraciones` desarma la compuerta de abajo. Existe porque un freno sin escape se
# termina saltando desactivándolo para siempre; pero pide motivo y lo deja escrito.
FORZAR_MIG=0
MOTIVO_FORZAR=""

ssh_md() { ssh -o BatchMode=yes -o ConnectTimeout=15 "$SRV" "$@"; }

# Escapa un valor para SQL: en SQL la comilla simple se duplica.
sqlq() { printf "%s" "$1" | sed "s/'/''/g"; }

# ─────────────────────────────────────────────────────────────────────────────
# `[VL.15]` LAS MIGRACIONES SON PARTE DEL DESPLIEGUE, aunque no viajen en la imagen.
#
# ⛔ QUÉ LO DISPARÓ, medido el 2026-09-23: entre la imagen viva (`67a30bea`) y `HEAD` había
# **63 commits y 7 migraciones, de las cuales 6 NO estaban aplicadas** en prod. Desplegar
# habría subido código que espera columnas y vistas que no existen — y eso **no falla en el
# build, falla en runtime**, en la cara de quien abra la pantalla. Nada avisaba: se encontró
# mirando a mano.
#
# La compuerta compara los archivos de `database/migrations-newdb/` en HEAD contra lo que prod
# dice tener aplicado, y **se niega a desplegar** `api`/`worker` si falta alguna.
#
# ⛔ `public.knex_migrations` VA EXPLÍCITO, y no es prolijidad: en prod hay **DOS** tablas con
#    ese nombre y el `search_path` empieza por `identity`, que tiene 0-1 filas y `batch` NULL.
#    La real es `public` (829 nombres, lote 520 al 2026-09-23). Sin calificar el esquema, esta
#    comprobación diría que están pendientes LAS 829 — y el freno se volvería ruido que alguien
#    apagaría el primer día. Es el mismo motivo por el que `migrate.latest()` está prohibido acá.
# ─────────────────────────────────────────────────────────────────────────────
# ── [VL.21] Clasifica, no sólo resta ────────────────────────────────────────────────────────
# Emite una línea por migración que prod no tiene:
#   PEND <archivo>              → falta de verdad
#   DUP  <archivo> <ya-corrida> → MISMO contenido que una ya aplicada bajo otro nombre
#
# ⛔ La distinción no es académica: el 2026-09-24 esta compuerta frenó un despliegue por dos
# migraciones que **no había que aplicar** —los nombres viejos de un renombre a medio
# commitear— y el reflejo natural (aplicarlas) habría dejado en `knex_migrations` una fila para
# un archivo que al commitearse el renombre ya no existe. Detalle en el `.awk`.
#
# ⭐ Y de paso se va `comm -23`, que exigía orden byte a byte: sin `LC_ALL=C` avisa por stderr
# —donde nadie lo ve, porque hay un `2>/dev/null` en el camino— y devuelve un resultado que no
# vale. `deploy.sh` no tenía ese `LC_ALL=C` (`auto-deploy.sh` sí). Comparar por blob no depende
# del orden, así que el modo de falla deja de existir en vez de quedar tapado.
migraciones_pendientes() {
  cd "$REPO"
  : > "$TMP/mig-prod.txt"
  # El nombre que registra knex es el BASENAME del archivo, no la ruta.
  ssh_md "docker exec pg-prod psql -U postgres -At -d railway -c \"SELECT name FROM public.knex_migrations\"" \
    2>/dev/null | tr -d '\r' | grep -E '\.js$' > "$TMP/mig-prod.txt" || true
  [ -s "$TMP/mig-prod.txt" ] || return 0
  # "<blob-sha> <basename>": git ya es direccionable por contenido, así que dos archivos
  # idénticos comparten SHA y no hace falta calcular ningún hash.
  git ls-tree -r HEAD database/migrations-newdb/ 2>/dev/null \
    | awk '{ n = split($4, p, "/"); if (p[n] ~ /\.js$/) print $3 " " p[n] }' > "$TMP/mig-blobs.txt" || true
  awk -v prod="$TMP/mig-prod.txt" -f "$REPO/ops/prod/clasificar-migraciones.awk" "$TMP/mig-blobs.txt"
}

compuerta_migraciones() {
  # Sólo frena a los servicios que llevan CÓDIGO de la app. `portal`/`vendor` son bundles
  # estáticos y `pg-prod`/`backup` no leen el schema de negocio: frenarlos sería ruido.
  case " $* " in *" api "*|*" worker "*) ;; *) return 0 ;; esac

  clas=$(migraciones_pendientes || true)

  # ⚠️ Si no se pudo LEER prod, eso NO es "todo al día" ni "829 pendientes": es NO MEDIDO, y se
  # declara (ADR-056). Fallar cerrado, porque el modo de falla contrario —desplegar a ciegas— es
  # justo el que esta compuerta existe para cerrar.
  if [ ! -s "$TMP/mig-prod.txt" ]; then
    echo "⛔ NO SE PUDO LEER \`public.knex_migrations\` en prod — el estado de las migraciones"
    echo "   quedó SIN MEDIR. No se despliega a ciegas."
    echo "   Comprobá:  ssh $SRV 'docker exec pg-prod psql -U postgres -c \"select 1\"'"
    exit 1
  fi

  # `[VL.21]` Los duplicados NO frenan: ya corrieron. Se avisan igual, porque un renombre a medio
  # commitear es un estado transitorio que conviene ver — y porque aplicarlos sería el daño.
  dups=$(printf '%s\n' "$clas" | grep '^DUP ' || true)
  if [ -n "$dups" ]; then
    echo "   ℹ️ $(echo "$dups" | wc -l | tr -d ' ') archivo(s) que prod no tiene pero cuyo CONTENIDO ya corrió con otro nombre"
    echo "      (renombre a medio commitear). ⛔ NO se aplican: dejarían una fila en knex_migrations"
    echo "      para un archivo que va a dejar de existir."
    echo "$dups" | sed 's/^DUP /      /; s/ / → ya aplicada como /2'
  fi
  pend=$(printf '%s\n' "$clas" | grep '^PEND ' | sed 's/^PEND //' || true)

  if [ -z "$pend" ]; then
    MIG_PEND_N=0
    echo "   ✓ migraciones: prod al día con HEAD"
    return 0
  fi

  n=$(echo "$pend" | wc -l | tr -d ' ')
  MIG_PEND_N="$n"   # viaja a la bitácora: un despliegue forzado queda marcado con CUÁNTAS faltaban
  echo
  echo "⛔ $n MIGRACIÓN(ES) DE HEAD NO ESTÁN APLICADAS EN PROD:"
  echo "$pend" | sed 's/^/      /'
  echo
  echo "   Desplegar así sube código que espera un schema que no existe. NO falla en el build:"
  echo "   falla en runtime, en la pantalla de alguien."
  echo
  echo "   ⛔ NO uses \`knex migrate:latest\`: el search_path lleva a la tabla VACÍA y reaplicaría"
  echo "      las 829. Se aplican a mano, una por una, con \`lock_timeout\` — ops/prod/README.md."
  echo
  if [ "$FORZAR_MIG" = 1 ]; then
    echo "   ⚠️ FORZADO con --sin-migraciones: $MOTIVO_FORZAR"
    echo
    return 0
  fi
  echo "   Si sabés lo que hacés:  deploy.sh --sin-migraciones \"<motivo>\" $*"
  exit 1
}

# ─────────────────────────────────────────────────────────────────────────────
# `[VL.15.C]` LA BITÁCORA. "¿Qué se subió y cuándo?" se contestaba con arqueología sobre la
# fecha de creación de una imagen de Docker: sin quién, sin por qué, sin resultado, y sin
# rastro de los despliegues que fallaron a la mitad — que son justo los que uno quiere leer.
#
# Vive en prod porque es donde el dato es útil y donde ya hay respaldo (`prod-backup` + PITR).
# Se auto-crea: un ledger de operación no puede depender de una migración, porque las
# migraciones son justamente lo que esto vigila.
#
# ⚠️ NUNCA hace fallar el despliegue. Una bitácora que tumba lo que registra es peor que no
# tenerla — es el mismo criterio que el latido de `backup-prod.sh`.
# ─────────────────────────────────────────────────────────────────────────────
bitacora() {
  _commit="$1"; _servicios="$2"; _resultado="$3"; _pend="$4"
  _quien=$(cd "$REPO" && git config user.name 2>/dev/null || echo desconocido)
  {
    echo "CREATE SCHEMA IF NOT EXISTS ops;"
    echo "CREATE TABLE IF NOT EXISTS ops.deploys ("
    echo "  id bigserial PRIMARY KEY,"
    echo "  desplegado_en timestamptz NOT NULL DEFAULT now(),"
    echo "  commit_sha text NOT NULL,"
    echo "  servicios text NOT NULL,"
    echo "  resultado text NOT NULL,"
    echo "  migraciones_pendientes int NOT NULL DEFAULT 0,"
    echo "  quien text,"
    echo "  desde text"
    echo ");"
    echo "INSERT INTO ops.deploys (commit_sha, servicios, resultado, migraciones_pendientes, quien, desde)"
    echo "VALUES ('$(sqlq "$_commit")', '$(sqlq "$_servicios")', '$(sqlq "$_resultado")', $_pend, '$(sqlq "$_quien")', '$(sqlq "$(hostname 2>/dev/null || echo ?)")');"
  } | ssh_md "docker exec -i pg-prod psql -U postgres -q -d railway -f -" >/dev/null 2>&1 \
    || echo "   ⚠️ bitácora: no se pudo escribir (el despliegue NO falla por esto)"
}

estado() {
  echo "── Qué corre en $SRV (proyecto compose: prod) ──"
  ssh_md 'docker ps --filter "label=com.docker.compose.project=prod" --format "{{.Names}}|{{.Status}}|{{.Image}}" | sort | column -t -s"|" || true'
  echo
  echo "── Imágenes de prod ──"
  ssh_md 'for i in trade-prod-pg trade-prod-api trade-prod-worker trade-prod-portal trade-prod-vendor trade-prod-backup trade-prod-caddy; do
            docker image inspect "$i:latest" --format "  {{.RepoTags}}  creada {{.Created}}" 2>/dev/null || echo "  $i:latest  (no existe)";
          done'
  echo
  echo "── La INGESTA (proyecto vl) — no se toca desde acá ──"
  ssh_md 'docker ps --format "{{.Names}}|{{.Status}}" | grep -E "pgvector-md|ods-|feeds-|store-" | sort | column -t -s"|" || true'

  # ── [VL.15.A] QUÉ FALTA SUBIR ────────────────────────────────────────────────
  # Antes esta pantalla decía qué corre, no qué falta. Son preguntas distintas y la segunda
  # es la que se hace antes de desplegar: el 2026-09-23 hubo que calcular a mano que `api`
  # estaba 63 commits atrás, y en el camino aparecieron 6 migraciones sin aplicar.
  echo
  echo "── Qué FALTA subir ──"
  cd "$REPO"
  vivo=$(ssh_md "docker images --format '{{.Tag}} {{.ID}}' trade-prod-api 2>/dev/null \
    | grep -v '^latest ' \
    | awk -v v=\"\$(docker images --format '{{.ID}}' trade-prod-api:latest 2>/dev/null | head -1)\" '\$2==v {print \$1; exit}'" 2>/dev/null || true)
  cabeza=$(git rev-parse --short HEAD)
  if [ -n "$vivo" ] && git cat-file -e "$vivo^{commit}" 2>/dev/null; then
    atras=$(git rev-list --count "$vivo..HEAD" 2>/dev/null || echo '?')
    if git merge-base --is-ancestor "$vivo" HEAD 2>/dev/null; then
      printf '   api vive en %s · HEAD es %s · %s commit(s) de diferencia\n' "$vivo" "$cabeza" "$atras"
    else
      printf '   ⚠️ api vive en %s, que NO es ancestro de HEAD (%s): hay DIVERGENCIA\n' "$vivo" "$cabeza"
    fi
  else
    printf '   api vive en %s (no resoluble en este repo) · HEAD es %s\n' "${vivo:-?}" "$cabeza"
  fi

  sinpush=$(git rev-list --count '@{upstream}..HEAD' 2>/dev/null || echo '')
  if [ -n "$sinpush" ] && [ "$sinpush" != 0 ]; then
    echo "   ⚠️ $sinpush commit(s) LOCALES sin pushear. \`deploy.sh\` archiva tu HEAD, no origin:"
    echo "      podés subir a prod código que nadie revisó, y que nadie más tiene."
  fi

  clas=$(migraciones_pendientes || true)
  pend=$(printf '%s\n' "$clas" | grep '^PEND ' | sed 's/^PEND //' || true)
  dups=$(printf '%s\n' "$clas" | grep '^DUP ' || true)
  if [ ! -s "$TMP/mig-prod.txt" ]; then
    echo "   ⛔ migraciones: NO MEDIDO (no se pudo leer public.knex_migrations en prod)"
  elif [ -z "$pend" ]; then
    echo "   ✓ migraciones: prod al día con HEAD"
  else
    echo "   ⛔ $(echo "$pend" | wc -l | tr -d ' ') migración(es) SIN APLICAR — el despliegue de api/worker se va a frenar:"
    echo "$pend" | sed 's/^/        /'
  fi
  if [ -n "$dups" ]; then
    echo "   ℹ️ $(echo "$dups" | wc -l | tr -d ' ') con el contenido YA aplicado bajo otro nombre (renombre a medio commitear) — NO aplicar:"
    echo "$dups" | sed 's/^DUP /        /; s/ / → ya aplicada como /2'
  fi

  # ── [VL.21] EL SENTIDO CONTRARIO: aplicada en prod, sin archivo en HEAD ──────
  # Es el estado que produce el `directory corrupt` → crash loop que este proyecto ya vivió, y
  # por eso existe la regla dura de no borrar migraciones aplicadas. Se AVISA y no se frena: la
  # causa más común es un archivo que alguien aplicó y todavía no commiteó, y frenar el
  # despliegue de todos por el trabajo en vuelo de uno sería ruido que se termina apagando.
  if [ -s "$TMP/mig-prod.txt" ] && [ -s "$TMP/mig-blobs.txt" ]; then
    awk '{print $2}' "$TMP/mig-blobs.txt" | LC_ALL=C sort > "$TMP/mig-enhead.txt"
    LC_ALL=C sort "$TMP/mig-prod.txt" > "$TMP/mig-prod-ord.txt"
    huerf=$(LC_ALL=C comm -13 "$TMP/mig-enhead.txt" "$TMP/mig-prod-ord.txt")
    if [ -n "$huerf" ]; then
      echo "   ⚠️ $(echo "$huerf" | wc -l | tr -d ' ') aplicada(s) en prod SIN archivo en HEAD (riesgo de \`directory corrupt\`):"
      echo "$huerf" | sed 's/^/        /'
      echo "        Si el archivo existe sin commitear, commitealo con pathspec. Si se borró, es grave."
    fi
  fi

  echo
  echo "── Últimos despliegues (ops.deploys) ──"
  ssh_md "docker exec pg-prod psql -U postgres -d railway -c \
    \"SELECT to_char(desplegado_en AT TIME ZONE 'America/Mexico_City','MM-DD HH24:MI') AS cuando,
             commit_sha AS commit, servicios, resultado, migraciones_pendientes AS mig_pend, quien
        FROM ops.deploys ORDER BY id DESC LIMIT 8\"" 2>/dev/null \
    || echo "   (todavía no hay bitácora: se crea en el próximo despliegue)"
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
  # ── [VL.20.4] LOS GUIONES DE LOS CARRILES TAMBIÉN VIAJAN ────────────────────────────────
  # ⛔ `auto-deploy.sh`, `termometro.sh` y `tunel-vigia.sh` NO estaban en esta lista: la copia
  # que corre en `md` se instalaba **a mano**, así que el repo y el servidor podían divergir sin
  # que nada lo dijera. El refactor del grafo lo volvió urgente — con el `Dockerfile` nuevo en
  # `origin/main` y la copia vieja en `md`, el carril fallaría cada 5 minutos buscando un
  # `Dockerfile.worker` que ya no existe.
  #
  # ⚠️ Esto hace que el repo GANE sobre `md`: un ajuste hecho a mano allá se pisa en el próximo
  # despliegue. Es lo que se quiere (la agenda y los guiones son memoria compartida del repo),
  # pero hay que saberlo antes de editar algo por SSH.
  #
  # ⛔ La AGENDA (`crontab.auto-deploy`) NO se instala sola a propósito: cambiar un cron sin que
  # una persona lo mire es cómo se duplica un carril. Se instala con el comando que está en la
  # cabecera de ese archivo.
  #
  # ⛔ Y el carril sigue corriendo su copia INSTALADA, no la del clon que él mismo mantiene: así
  # un commit malo no puede dejar sin carril al mecanismo que tendría que revertirlo.
  _guiones="docker-compose.yml Caddyfile restaurar.sh esperar-y-restaurar.sh verificar.sh probar-pitr.sh podar-disco.sh auto-deploy.sh aplicar-k3s-prod.sh termometro.sh tunel-vigia.sh clasificar-migraciones.awk dev-ro.sql dev-ro-crear.sh dev-ro-verificar.sh"
  for a in $_guiones; do
    scp -q -o BatchMode=yes "$REPO/ops/prod/$a" "$SRV:ops/prod/.$a.nuevo"
  done
  # ── [K3S.26] LOS MANIFIESTOS DE K3s TAMBIÉN VIAJAN ─────────────────────────────────────
  # `aplicar-k3s-prod.sh` lee de `~/ops/k3s/`, la copia INSTALADA — mismo criterio que rige
  # para `auto-deploy.sh` y `verificar.sh`: el carril corre lo que se instaló a propósito, no
  # lo que haya en un clon que él mismo mantiene. Así un commit malo no puede dejar sin carril
  # al mecanismo que tendría que revertirlo.
  #
  # ⚠️ El corolario, que hay que saber antes de editar algo por SSH: el repo GANA sobre `md`.
  # Un ajuste hecho a mano allá se pisa en el próximo despliegue.
  ssh_md "mkdir -p ~/ops/k3s"
  for a in "$REPO"/ops/k3s/*.yaml; do
    [ -f "$a" ] || continue
    scp -q -o BatchMode=yes "$a" "$SRV:ops/k3s/.$(basename "$a").nuevo"
  done
  ssh_md "cd ~/ops/k3s && for a in .*.yaml.nuevo; do [ -f \"\$a\" ] || continue; b=\${a#.}; mv -f \"\$a\" \"\${b%.nuevo}\"; done"
  # ⛔ Se mueve encima, nunca se sobrescribe el inodo en curso: `sh` lee el guion POR POSICIÓN
  # mientras lo ejecuta. `auto-deploy.sh` puede estar corriendo justo ahora (dispara cada 5 min).
  # ⛔ [INFRA.6 2026-09-30] EL `Caddyfile` NO SE MUEVE ENCIMA: SE ESCRIBE EN SU LUGAR.
  # `prod-caddy` lo monta como BIND MOUNT **DE ARCHIVO** (`~/ops/prod/Caddyfile` →
  # `/etc/caddy/Caddyfile`), y un bind mount de archivo ata el **INODO**, no el nombre. `mv -f`
  # crea un inodo nuevo y DESENGANCHA el montaje para siempre: el contenedor sigue leyendo el
  # archivo viejo mientras el del host cambia, sin un solo error ni un aviso.
  #
  # Medido hoy, con el balanceo de `api2` ya escrito:
  #   host   inodo 7733543  mtime 2026-09-30 19:13  `api-balanceado` ×3
  #   dentro inodo 7734129  mtime 2026-09-24 18:36  `api-balanceado` ×0
  # O sea que **todo cambio de Caddyfile desde el 24-sep fue invisible**, y `--recrear caddy`
  # parecía funcionar: imprimía «Recreando: caddy» y no recreaba nada.
  #
  # `cat >` conserva el inodo. Es seguro para ESTE archivo justo por lo contrario de los `.sh`:
  # Caddy no lo ejecuta por posición, lo lee entero al arrancar. Los guiones siguen con `mv`.
  ssh_md "cd ~/ops/prod && for a in $_guiones; do
            if [ \"\$a\" = Caddyfile ]; then cat \".\$a.nuevo\" > \"\$a\" && rm -f \".\$a.nuevo\"
            else mv -f \".\$a.nuevo\" \"\$a\"; fi
          done && chmod +x restaurar.sh esperar-y-restaurar.sh verificar.sh probar-pitr.sh podar-disco.sh auto-deploy.sh termometro.sh tunel-vigia.sh dev-ro-crear.sh dev-ro-verificar.sh"
  ssh_md "cd ~/ops/prod && set -a && . ~/secrets/prod-compose.env && set +a && docker compose -p prod config >/dev/null && echo '   compose válido'"
}

construir() {
  commit=$(cd "$REPO" && git rev-parse --short HEAD)

  # ── [VL.20.2] EL SELLO DE portal/vendedor, DETERMINISTA POR COMMIT ──────────────
  # Los Dockerfiles de portal y vendedor metían `date -u` —un reloj de pared— dentro de su
  # `index.html`, que está en los inputs del hash de Nx. Su propio comentario lo declaraba:
  # **ese target no acertaba el caché NUNCA, por diseño**, ni recompilando el mismo commit.
  # Acá el sello pasa a ser función del commit, así que un rollback o un reintento aciertan.
  #
  # ⚠️ TRAMPA MEDIDA: `git show --date=format:` **NO respeta `TZ`** — usa la zona del commit.
  # Con `TZ=UTC ... --date=format:'…Z'` un commit de las 18:16 -06:00 salía como `18:16:50Z`,
  # o sea una hora FALSA con rótulo UTC. `--date=format-local:` sí la respeta: `00:16:50Z`.
  # Se conserva la forma `…Z` que ya tenía el sello para no sorprender a quien lo lee.
  commit_iso=$(cd "$REPO" && TZ=UTC git show -s --date=format-local:'%Y-%m-%dT%H:%M:%SZ' --format=%cd HEAD)

  # ── [VL.11.D] CONSTRUIR SÓLO LO QUE SE PIDIÓ ────────────────────────────────────
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
      caddy)   filtro="$filtro trade-prod-caddy" ;;
      # `pg-rag` usa una imagen de terceros sin Dockerfile propio, y `cloudflared`
      # también: no hay nada que construir para ellos, sólo recrear.
      pg-rag|cloudflared) echo "   · $s usa imagen de terceros — no se construye" ;;
      *) echo "   ⚠️ '$s' no tiene imagen propia; se ignora al construir" ;;
    esac
  done

  if [ -n "$filtro" ]; then
    echo "── Construyendo sólo:$filtro ──"
  else
    echo "── Construyendo las 7 imágenes (api primero: materializa deps/src/build-api) ──"
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
  # ⭐ [VL.11.C] `--build-arg` DEL COMMIT. Hasta el 2026-09-23 esta línea NO pasaba ningún
  # build-arg, y eso tenía dos consecuencias que nadie había atado:
  #   1. `/api/health` sólo sabía su commit por el entorno que le pone `recrear()`, así que
  #      cualquier `docker compose up` a mano lo dejaba en `""`. Pasó dos veces el 2026-09-22.
  #   2. El sello de versión del portal y del vendedor decía **`unknown`** on-prem desde el
  #      primer día, porque sus Dockerfiles esperaban `RAILWAY_GIT_COMMIT_SHA`.
  # `[VL.20.1]` Ya no se manda `RAILWAY_GIT_COMMIT_SHA`: Railway no construye nada y el único
  # lector que quedaba (`apps/api/src/build-info.ts`) resuelve por `GIT_COMMIT_SHA`.
  #
  # ── [VL.20.1/.3] UN GRAFO, CUATRO DESTINOS ──────────────────────────────────────
  # Las cuatro apps salen del MISMO `/Dockerfile` con `--target`. Antes eran cuatro archivos
  # (herencia de Railway, que exige uno por servicio) y eso costaba, medido el 2026-09-24:
  # cuatro `npm ci` distintos, 7 registros de caché npm de ~3 GB, y **el worker recompilando
  # `nx build api` que la imagen de api acababa de compilar 3 minutos antes**.
  #
  # ⭐ EL ORDEN IMPORTA Y POR ESO ESTÁ FIJO: `api` PRIMERO. Es quien materializa `deps`, `src`
  # y `build-api`; los otros tres destinos son después casi todo caché de capa. Al revés
  # funciona igual pero se paga la compilación en el primero que toque.
  # `pg`, `backup` y `caddy` conservan su Dockerfile propio (no son apps de Node) y por eso
  # el tercer campo —el destino— les va vacío.
  ssh_md "cd $REMOTO && set -e
    FILTRO='$filtro'
    for par in 'trade-prod-api|Dockerfile|runner-api' \
               'trade-prod-worker|Dockerfile|runner-worker' \
               'trade-prod-portal|Dockerfile|runner-portal' \
               'trade-prod-vendor|Dockerfile|runner-vendor' \
               'trade-prod-pg|ops/prod/Dockerfile.pg|' \
               'trade-prod-backup|ops/prod/Dockerfile.backup|' \
               'trade-prod-caddy|ops/prod/Dockerfile.caddy|'; do
      img=\${par%%|*}; resto=\${par#*|}; df=\${resto%%|*}; tgt=\${resto#*|}
      # Los espacios de los dos lados evitan que 'trade-prod-pg' matchee dentro de otro nombre.
      if [ -n \"\$FILTRO\" ] && ! echo \" \$FILTRO \" | grep -q \" \$img \"; then continue; fi
      arg_t=''; [ -n \"\$tgt\" ] && arg_t=\"--target \$tgt\"
      printf '   %-22s ' \"\$img\"
      t0=\$(date +%s)
      if docker build -q -f \"\$df\" \$arg_t --build-arg GIT_COMMIT_SHA=$commit --build-arg GIT_COMMIT_ISO=$commit_iso -t \"\$img:$commit\" -t \"\$img:latest\" . >/dev/null 2>/tmp/build-\$img.log; then
        echo \"ok (\$(( \$(date +%s) - t0 ))s)  →  \$img:$commit\"
      else
        echo 'FALLÓ'; tail -25 /tmp/build-\$img.log | sed 's/^/      /'; exit 1
      fi
    done"
  publicar_prod
  subir_compose
  podar_imagenes
}

# ═══ [K3S.24] LAS IMÁGENES DE PROD VAN AL REGISTRY, SIEMPRE ═════════════════════════════════
#
# Se publican aunque HOY ningún pod las consuma: las cuatro apps siguen en Compose, marcadas
# `preparado`. Publicar de más cuesta segundos; publicar de menos es exactamente cómo los pods
# del ODS quedaron 36 commits atrás sirviendo a los usuarios internos (2026-10-01).
#
# ⭐ El camino tiene que existir ANTES de que alguien lo necesite, no el día que lo necesita.
# Si el día del corte hay que inventar el despliegue, el corte se hace a mano — y lo que se
# hace a mano se olvida.
#
# ⭐ El tag es el COMMIT. `latest` con `imagePullPolicy: IfNotPresent` es la combinación que
# hace que el kubelet no vuelva a jalar NUNCA.
#
# ⚠️ Hoy un fallo al publicar AVISA y sigue: nada en producción depende todavía del registry,
# y abortar un despliegue de Compose porque falló un paso que nadie consume sería frenar el
# camino feliz por una dependencia futura. ⛔ EL DÍA QUE UNA APP MIGRE A K3s, ESTO TIENE QUE
# ABORTAR — si no, el pod se queda con la imagen vieja y el despliegue reporta éxito.
publicar_prod() {
  echo "── Publicando al registry local (localhost:5000) ──"
  ssh_md "fallos=0
    for i in trade-prod-api trade-prod-worker trade-prod-portal trade-prod-vendor; do
      if ! docker image inspect \"\$i:$commit\" >/dev/null 2>&1; then
        printf '   %-22s —  no se construyó en esta corrida, se saltea\n' \"\$i\"; continue
      fi
      docker tag \"\$i:$commit\" \"localhost:5000/\$i:$commit\"
      if docker push \"localhost:5000/\$i:$commit\" >/dev/null 2>&1; then
        printf '   %-22s ok  →  localhost:5000/%s:%s\n' \"\$i\" \"\$i\" '$commit'
      else
        printf '   %-22s ⛔ FALLÓ al publicar\n' \"\$i\"; fallos=\$((fallos+1))
      fi
    done
    [ \"\$fallos\" -eq 0 ] || echo '   ⚠️ el registry no recibió todo. ¿Está arriba?  docker ps | grep prod-registry'"
}

# ── [VL.20.5] LA PODA VIVE EN UN SCRIPT, NO EN UNA FUNCIÓN DE ACÁ ──────────────────
# Esto ERA una función de este archivo y funcionaba — pero el camino que despliega 7 veces al
# día es `auto-deploy.sh`, que **nunca la llamaba**. Resultado medido el 2026-09-24: **12
# etiquetas** de `api` y 12 de `worker` con `RETENER_IMG=5`, y **80.23 GB de caché de
# construcción sin tope**. La política estaba escrita en el carril que casi no se usa.
#
# Ahora es `ops/prod/podar-disco.sh`, que además recorta el caché de BuildKit y **late** a
# `analytics.cron_runs` (`poda_disco`) — un carril de higiene sin latido es indistinguible de
# uno que no corre. Lo llaman los tres: este guion, `auto-deploy.sh` y la agenda diaria.
# ⚠️ Dos implementaciones de lo mismo divergen; por eso no se deja una copia acá.
RETENER_IMG="${RETENER_IMG:-5}"
podar_imagenes() {
  ssh_md "RETENER_IMG=$RETENER_IMG sh ~/ops/prod/podar-disco.sh" 2>&1 | sed 's/^/   /' \
    || echo "   ⚠️ la poda falló (el despliegue NO falla por esto)"
}

# ⭐ EL ROLLBACK. `deploy.sh --volver <commit>` reapunta `:latest` a esa versión y recrea.
# No hace falta registro ni reconstruir: las imágenes ya están en la máquina, etiquetadas.
volver() {
  destino="$1"; shift
  servicios="${*:-$SERVICIOS_DEF}"
  [ -n "$destino" ] || { echo "uso: deploy.sh --volver <commit-corto> [servicios...]"; exit 2; }
  echo "── Volviendo a $destino ──"
  # ⛔ [VL.11.A] `trade-prod-caddy` NO ENTRA EN ESTE ROLLBACK, a propósito.
  # Es el terminador TLS del camino interno: infraestructura de entrada, no código de la
  # app. Dos motivos, y el segundo es el que duele:
  #   1. Volver la app a ayer no debería cambiar con qué certificado se sirve.
  #   2. Si estuviera en esta lista, `--volver <commit anterior al 2026-09-23>` fallaría
  #      SIEMPRE por una etiqueta que no puede existir — o sea, el rollback quedaría roto
  #      justo para los commits a los que uno querría volver.
  # Mismo criterio que `cloudflared`, que tampoco se versiona con la app.
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
  # [VL.11.C] YA NO SE EXPORTA `GIT_COMMIT_SHA`: lo hornea la imagen. El `$commit` de arriba
  # sobrevive SÓLO para el rótulo —sigue siendo útil saber qué versión se está levantando— pero
  # el contenedor ya no depende de que alguien acierte a exportarlo.
  # ⛔ Y no es que sobrara: mientras el compose declaraba `GIT_COMMIT_SHA: ${GIT_COMMIT_SHA:-}`,
  # un `docker compose up` sin esta variable ponía la cadena VACÍA y **pisaba el valor de la
  # imagen**. Se quitó la declaración del compose; dejar acá el export sería reconstruir el
  # mismo acoplamiento por la otra punta.
  # ⛔ [INFRA.6] `caddy` SIEMPRE se fuerza. Su configuración no viaja en la imagen ni en la
  # especificación del servicio: viaja en un archivo montado. Compose compara la ESPECIFICACIÓN,
  # así que un Caddyfile distinto no le cambia nada y deja el contenedor en pie — `up -d caddy`
  # es un **no-op silencioso** para un cambio de config. Y aunque el inodo ahora se conserve
  # (ver `subir_compose`), Caddy lee el archivo **sólo al arrancar**: sin recrear, la config nueva
  # queda en disco y nunca en memoria. Medido: el balanceo de `api2` no entró hasta forzarlo.
  forzar=""
  case " $servicios " in *" caddy "*) forzar="--force-recreate" ;; esac
  ssh_md "cd ~/ops/prod && set -a && . ~/secrets/prod-compose.env && set +a &&
    docker compose -p prod up -d $forzar $servicios 2>&1 | grep -E 'Recreated|Started|Created|Error' | sed 's/^/   /'"
  echo
  echo "── Salud ──"
  ssh_md "for c in $servicios; do
            n=\$(docker ps -a --filter \"label=com.docker.compose.project=prod\" --filter \"label=com.docker.compose.service=\$c\" --format '{{.Names}}' | head -1)
            [ -n \"\$n\" ] || { printf '   %-10s (no existe)\n' \"\$c\"; continue; }
            printf '   %-10s %s\n' \"\$c\" \"\$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}} (sin healthcheck){{end}}' \$n)\"
          done"
  echo

  # ── [VL.15.D] LA VERIFICACIÓN ES PARTE DEL DESPLIEGUE ────────────────────────
  # `--verificar` existía como comando APARTE, o sea que nadie lo corría después de desplegar.
  # Y el rótulo `healthy` no sirve de veredicto: dice que el contenedor contesta, no que sirva
  # la versión nueva. El 2026-09-22 `/api/health` devolvió commit VACÍO dos veces y el
  # despliegue se veía bien. Acá se compara contra lo que se acaba de levantar, y si no
  # coincide el despliegue FALLA — un despliegue que no cambió nada y dice "listo" es peor
  # que uno que rompe, porque nadie lo va a ir a buscar.
  #
  # Se pregunta por la LAN (127.0.0.1:8080 desde `md`), no por el dominio: el túnel agrega
  # 225 ms y una capa de caché entre la respuesta y la verdad.
  case " $servicios " in *" api "*)
    echo "── Verificación: ¿el API sirve la versión que se levantó? ──"
    vivo=$(ssh_md "for i in 1 2 3 4 5 6 7 8 9 10; do
              r=\$(curl -s --max-time 5 http://127.0.0.1:8080/api/health 2>/dev/null)
              c=\$(printf '%s' \"\$r\" | sed -n 's/.*\"commit\":\"\\([^\"]*\\)\".*/\\1/p')
              [ -n \"\$c\" ] && { printf '%s' \"\$c\"; exit 0; }
              sleep 3
            done" 2>/dev/null || true)
    if [ -z "$vivo" ]; then
      echo "   ⛔ el API no contestó /api/health en 30 s. El despliegue NO se puede dar por bueno."
      bitacora "$commit" "$servicios" "api_sin_responder" "${MIG_PEND_N:-0}"
      exit 1
    fi
    if [ "$vivo" != "$commit" ] && [ "$commit" != desconocido ]; then
      echo "   ⛔ el API sirve '$vivo' y se levantó '$commit'. Algo NO se recreó."
      echo "      Causa típica: un \`docker compose up\` de otro servicio que arrastró a \`api\`"
      echo "      por \`depends_on\`, o una imagen \`:latest\` que no se reapuntó."
      bitacora "$commit" "$servicios" "commit_no_coincide:$vivo" "${MIG_PEND_N:-0}"
      exit 1
    fi
    echo "   ✓ /api/health sirve $vivo — es la versión que se levantó."

    # ── [VL.16.D2] QUE LA VERSIÓN SEA LA CORRECTA NO ES QUE FUNCIONE ──────────
    # ⛔ Medido el 2026-09-23, 13 minutos después de escribir la comprobación de arriba: el
    # despliegue `325323b3` pasó su verificación, se anotó `ok` en `ops.deploys`… y el login
    # devolvía **500 a todo el mundo** (`42601`, parámetro ligado en un `SET`). La comprobación
    # del commit sólo prueba que se levantó el binario correcto — no que sirva.
    #
    # Es exactamente la distinción de ADR-053: el latido mide ENTREGA, no "el proceso corre".
    # Acá la entrega mínima de una app con sesiones es que la puerta conteste.
    #
    # ⭐ Se golpea el login con credenciales A PROPÓSITO inválidas y se exige **401**:
    #   · 401 = la ruta llegó hasta validar → la transacción con RLS se ejecutó bien.
    #   · 500 = exactamente el incidente, y aborta el despliegue.
    #   · 429 = lo frenó el throttler; no dice nada del login, así que NO se cuenta como falla.
    # Nunca se usan credenciales reales: un smoke que necesita un secreto no se corre.
    echo "── Humo: ¿la puerta contesta? (login con credenciales inválidas → debe dar 401) ──"
    codigo=$(ssh_md "curl -s -o /dev/null -w '%{http_code}' --max-time 15 \
      -X POST http://127.0.0.1:8080/api/auth-mt/login \
      -H 'Content-Type: application/json' \
      -d '{\"username\":\"zz_humo_deploy\",\"password\":\"zz\"}'" 2>/dev/null || echo 000)
    case "$codigo" in
      401|403) echo "   ✓ el login responde $codigo — la ruta llega a validar." ;;
      429)     echo "   ⚠️ $codigo: lo frenó el throttler. NO se pudo medir el login (se declara, no se aprueba)." ;;
      *)
        echo "   ⛔ el login respondió $codigo (se esperaba 401). El binario es el correcto pero la"
        echo "      aplicación NO sirve. Revisá: docker logs prod-api --tail 50"
        bitacora "$commit" "$servicios" "humo_login:$codigo" "${MIG_PEND_N:-0}"
        exit 1 ;;
    esac
  esac

  bitacora "$commit" "$servicios" "ok" "${MIG_PEND_N:-0}"
  echo "   ✓ anotado en ops.deploys"
  echo "   ⚠️ El rótulo NO es el veredicto. 'healthy' dice que el contenedor contesta;"
  echo "      que PROD esté bien se comprueba con datos: ver ops/prod/README.md §Verificación."
}

# [VL.15.B] `--sin-migraciones "<motivo>"` va ADELANTE de todo, como prefijo, para que se lea
# en el historial del shell junto al comando que desarmó: `deploy.sh --sin-migraciones "…" api`.
if [ "${1:-}" = "--sin-migraciones" ]; then
  shift
  [ $# -gt 0 ] || { echo "⛔ --sin-migraciones exige un motivo entre comillas."; exit 2; }
  FORZAR_MIG=1; MOTIVO_FORZAR="$1"; shift
fi

case "${1:---todo}" in
  --estado)    estado ;;
  --imagenes)  shift; verificar_limpio; enviar; construir "$@" ;;
  --db)        recrear pg-prod pg-rag ;;
  --recrear)   shift; [ $# -gt 0 ] || set -- $SERVICIOS_DEF; compuerta_migraciones "$@"; subir_compose; recrear "$@" ;;
  --volver)    shift; volver "$@" ;;
  --verificar) subir_compose >/dev/null; ssh_md "sh ~/ops/prod/verificar.sh" ;;
  --pitr)      subir_compose >/dev/null; ssh_md "sh ~/ops/prod/probar-pitr.sh" ;;
  # [VL.11.D] El túnel NO está en SERVICIOS_DEF (vive tras el perfil `tunel`), así que hasta
  # hoy NINGÚN camino de despliegue lo levantaba: había que escribir el `docker compose
  # --profile` a mano. ⚠️ Y hacerlo a mano es justo lo que vació `/api/health` el 2026-09-22,
  # porque `cloudflared` declara `depends_on: [api, portal, vendor]` y Compose se los lleva
  # puestos. Esta entrada pasa por `recrear()`, que sí exporta el commit.
  --tunel)     subir_compose; recrear cloudflared ;;
  --todo)      verificar_limpio; compuerta_migraciones $SERVICIOS_DEF; enviar; construir; recrear $SERVICIOS_DEF ;;
  -*)          sed -n '2,15p' "$0"; exit 2 ;;
  # Nombres de servicio sueltos: ahora `construir` recibe la lista y construye SÓLO esas
  # imágenes, en vez de las seis.
  # ⛔ La compuerta va ANTES de `enviar`/`construir`: frenar después de 20 min de build es
  # frenar tarde, y el que espera 20 minutos por un "no" la desactiva la próxima vez.
  *)           verificar_limpio; compuerta_migraciones "$@"; enviar; construir "$@"; recrear "$@" ;;
esac
