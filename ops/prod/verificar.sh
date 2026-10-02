#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# [VL.9.8] ¿ESTÁ FUNCIONANDO? — la respuesta con datos, no con rótulos.
#
#   ops/prod/verificar.sh            # desde tu máquina, por ssh
#   sh ~/ops/prod/verificar.sh       # o directo en md
#
# Existe porque "el contenedor está Up" no es el veredicto, y esta fase lo demostró
# cuatro veces: los cuatro defectos que aparecieron (la app exige TLS contra la base,
# los GRANT no viajan en el volcado, las matvistas no se reconstruían, `/api/health`
# no decía qué versión servía) dan TODOS `healthy` en Docker y 200 en el healthcheck.
#
# Cada bloque compara contra un número esperado. Lo que no se puede medir se DECLARA
# como tal — nunca se da por bueno (ADR-056).
# ─────────────────────────────────────────────────────────────────────────────
set -u

API=http://127.0.0.1:30080
PGH=127.0.0.1; PGP=5434; PGU=postgres; DB=railway
fallas=0
nomed=0

ok()    { printf '   \033[32m✓\033[0m %s\n' "$1"; }
mal()   { printf '   \033[31m✗\033[0m %s\n' "$1"; fallas=$((fallas+1)); }
nm()    { printf '   \033[33m?\033[0m %s \033[33m(NO MEDIDO)\033[0m\n' "$1"; nomed=$((nomed+1)); }
titulo(){ printf '\n\033[1m══ %s ══\033[0m\n' "$1"; }

if [ -z "${PGPASSWORD:-}" ] && [ -r /home/superoot/secrets/prod-compose.env ]; then
  PGPASSWORD=$(grep -m1 '^PGPROD_SUPERPASS=' /home/superoot/secrets/prod-compose.env | cut -d= -f2-)
  export PGPASSWORD
fi
q() { psql -h $PGH -p $PGP -U $PGU -d $DB -At -q -c "$1" 2>/dev/null; }

titulo "Contenedores"
# ⛔ [K3S.25][K3S.28] `prod-portal`, `prod-vendor` y `prod-worker` SALIERON de esta lista: viven
# en K3s desde el 2026-10-01 y sus contenedores están detenidos a propósito. Dejarlos acá
# reportaba fallas rojas sobre un estado sano, que es cómo se aprende a ignorar el tablero.
#
# ⭐ Al worker NO alcanza con verlo "arriba": es el singleton de los 51 @Cron, y lo que importa
# es que ENTREGUE. Su veredicto está en `analytics.cron_runs` — `ui_usage_flush` es su latido
# más frecuente y es el único job_key que existe SÓLO en el API, sin ningún carril que lo
# escriba también (verificado con grep sobre database/importers y ops/).
#
# ⚠️ Y el reverso importa igual: si un servicio vuelve a Compose, tiene que VOLVER a esta
# línea. Un contenedor que nadie vigila es indistinguible de uno que no existe.
# Los pods se verifican abajo, por su NodePort y pidiendo un recurso real.
#
# ⭐ [K3S.43] `pg-prod` y `pg-rag` SALIERON de la lista de contenedores: son pods desde el
# 2026-10-01/02. Sus contenedores quedan DETENIDOS a propósito —protegen el volumen de
# `docker volume prune` y son la vuelta atrás—, así que buscarlos como "healthy" daría rojo
# sobre un estado sano.
#
# ⛔ Pero NO se dejan sin vigilar, y acá el riesgo es asimétrico: lo peligroso no es que estén
# apagados, es que estén PRENDIDOS. Un Postgres de Compose corriendo sobre el mismo datadir que
# el pod ya tiene montado no da un conflicto de puerto que avise: corrompe.
# ⚠️ La rama entrante del merge (PR #213) todavía los listaba como contenedores a comprobar.
# Esa intención —que alguien mire a pg-rag— se conserva acá, con el sentido invertido.
for _pg in pg-prod pg-rag; do
  _est=$(docker inspect -f '{{.State.Status}}' "$_pg" 2>/dev/null)
  case "$_est" in
    exited|created) ok "$_pg (contenedor): $_est — detenido a propósito, es la vuelta atrás" ;;
    '')             nm "el contenedor $_pg ya no existe: se perdió la vuelta atrás inmediata" ;;
    *)              mal "⛔⛔ $_pg CORRIENDO en Docker ($_est) con el pod arriba: DOS Postgres sobre el mismo datadir" ;;
  esac
done
for c in prod-backup; do
  est=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$c" 2>/dev/null)
  case "$est" in
    healthy|running) ok "$c: $est" ;;
    '')              mal "$c: NO EXISTE" ;;
    *)               mal "$c: $est" ;;
  esac
done

titulo "La base: ¿se parece a producción?"
# Los pisos salen de prod medido el 2026-09-22. Un restore incompleto abre perfecto y
# pasa un healthcheck; lo único que lo delata es CONTAR.
for par in "kepler_ods:200" "commercial:100" "analytics:60" "finance:20"; do
  sch=${par%%:*}; piso=${par#*:}
  n=$(q "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='$sch' and c.relkind in ('r','p')")
  if [ -z "$n" ]; then nm "$sch: no se pudo consultar"
  elif [ "$n" -ge "$piso" ]; then ok "$sch: $n tablas (piso $piso)"
  else mal "$sch: $n tablas, se esperaban >= $piso"; fi
done

mv_total=$(q "select count(*) from pg_matviews")
mv_pob=$(q "select count(*) from pg_matviews where ispopulated")
if [ -z "$mv_total" ]; then nm "matvistas: no se pudo consultar"
elif [ "$mv_total" = "$mv_pob" ] && [ "$mv_total" -gt 0 ]; then ok "matvistas: $mv_pob de $mv_total pobladas"
else mal "matvistas: sólo $mv_pob de $mv_total pobladas — una matvista sin poblar hace fallar a quien la consulte"; fi

# Los GRANT no viajan en un volcado con --no-privileges, y el síntoma llega como un 500
# en runtime, no como un error del restore.
gr=$(q "select count(*) from information_schema.role_table_grants where grantee='app_runtime'")
if [ -z "$gr" ]; then nm "permisos de app_runtime: no se pudo consultar"
elif [ "$gr" -ge 1000 ]; then ok "permisos de app_runtime: $gr"
else mal "permisos de app_runtime: $gr (se esperaban >= 1000) — la app va a dar 500 por aclcheck"; fi

pol=$(q "select count(*) from pg_policy")
[ -n "$pol" ] && { [ "$pol" -ge 300 ] && ok "políticas RLS: $pol" || mal "políticas RLS: $pol (se esperaban >= 300)"; } || nm "políticas RLS"

mig=$(q "select count(*) from public.knex_migrations")
[ -n "$mig" ] && ok "migraciones aplicadas: $mig" || nm "migraciones: no se pudo consultar"

titulo "El archivado de WAL (la recuperación a un punto en el tiempo)"
am=$(q "select current_setting('archive_mode')")
if [ "$am" != "on" ]; then mal "archive_mode = ${am:-?} — SIN recuperación a un punto en el tiempo"
else
  # `failed_count` es ACUMULATIVO: lo que dice si está roto AHORA es la comparación de fechas.
  # ⚠️ SIN `::text`. Un booleano casteado a texto da `true`/`false`; sin castear, `psql -At`
  # imprime `t`/`f`. Con el cast puesto y la comparación contra `t`, esta compuerta daba ROJO
  # SIEMPRE — medido en su primera corrida real, sobre un archivador que estaba sano.
  # Una compuerta que grita en falso enseña a ignorar el tablero igual que una muda.
  sano=$(q "select last_archived_time > coalesce(last_failed_time,'-infinity') from pg_stat_archiver")
  edad=$(q "select round(extract(epoch from (now()-last_archived_time))/60.0,1) from pg_stat_archiver")
  if [ "$sano" = "t" ]; then ok "archivado sano · último hace ${edad:-?} min"
  else mal "el ÚLTIMO intento de archivado FALLÓ — el WAL se acumula en pg_wal hasta llenar el disco"; fi
fi
if sh "$HOME/ops/prod/pgprod.sh" --dentro pgbackrest --stanza=prod info 2>/dev/null | grep -q 'status: ok'; then
  ok "repositorio pgBackRest: status ok · $(du -sh /home/superoot/pgbackrest 2>/dev/null | cut -f1)"
else
  mal "pgbackrest info no dice 'status: ok'"
fi

titulo "La app: ¿contesta con DATOS?"
h=$(curl -s -m 10 "$API/api/health" 2>/dev/null)
case "$h" in
  *'"status":"ok"'*) ok "/api/health: $(echo "$h" | grep -o '"commit":"[^"]*"' || echo 'sin commit')" ;;
  '')                mal "/api/health: sin respuesta" ;;
  *)                 mal "/api/health: $(echo "$h" | head -c 80)" ;;
esac
suc=$(curl -s -m 20 "$API/api/sucursales" 2>/dev/null | grep -o '"codigo"' | wc -l)
[ "$suc" -ge 5 ] && ok "/api/sucursales: $suc sucursales" || mal "/api/sucursales: $suc (se esperaban >= 5)"
# ⚠️ Se lee el campo `total` que la respuesta YA trae, en vez de contar apariciones de un
# nombre de campo adivinado. La version anterior contaba `"sku"` y la respuesta usa `"c"`:
# daba 0 sobre un endpoint que devuelve 9,566 productos. Un verificador que adivina el
# formato de lo que verifica reporta rojo sobre algo sano — y eso cuesta la confianza del
# tablero igual que un falso verde.
# ⛔ SIN tubería a `head`: la respuesta son ~1.8 MB y `head -c` cierra el caño, curl recibe
# SIGPIPE y la salida queda VACÍA — el conteo daba «Illegal number» sobre un endpoint sano.
# Se descarga a un archivo y se lee de ahí.
_tmp=/tmp/verificar-precios.$$
curl -s -m 60 -o "$_tmp" "$API/api/kp/precios-todos" 2>/dev/null
prod_n=$(grep -o '"total":[0-9]*' "$_tmp" 2>/dev/null | head -1 | cut -d: -f2)
rm -f "$_tmp"
prod_n=${prod_n:-0}
[ "$prod_n" -ge 5000 ] && ok "/api/kp/precios-todos: $prod_n productos" || mal "/api/kp/precios-todos: $prod_n (se esperaban >= 5000)"
# ⛔ [K3S.25] LOS PUERTOS CAMBIARON PORQUE CAMBIÓ EL MUNDO. `portal` y `vendor` viven en K3s
# desde el 2026-10-01: el 8081/8082 de Docker está MUERTO y este bloque habría reportado dos
# fallas sobre un estado sano — la misma clase de falso rojo que tenía el bloque de la ingesta.
#
# ⭐ Y no basta con cambiar el número: se pide además un RECURSO REAL (`ngsw.json`), no sólo
# la raíz. Un nginx vivo sirviendo su página por defecto devuelve 200 igual.
# ⛔⛔ [K3S.36] SE PIDE TAMBIÉN `/api/health`, Y ESO ES LO QUE FALTABA.
#
# Este bloque medía `/` y `ngsw.json` — y los dos son ARCHIVOS ESTÁTICOS que el pod sirve POR
# SU CUENTA. Lo que no medía es lo que DELEGA: cada app lleva su propio nginx que proxea
# `/api/` al backend.
#
# El 2026-10-01 ese proxy quedó roto al migrar a K3s (traía `resolver 127.0.0.11`, el DNS
# embebido de Docker, que en un pod no existe) y portal y vendedor estuvieron ~1.5 h SIN PODER
# INICIAR SESIÓN: la app se quedaba cargando para siempre. Este chequeo daba verde todo el
# tiempo, porque los estáticos nunca dejaron de servirse.
#
# ⭐ Verificar lo que un servicio sirve por su cuenta NO verifica lo que delega. Y «no es sólo
# la raíz, es un recurso real» no alcanza si ese recurso sale del mismo lugar que la raíz.
for par in "portal:30081" "vendor:30082"; do
  n=${par%%:*}; p=${par#*:}
  c=$(curl -s -o /dev/null -w '%{http_code}' -m 10 "http://127.0.0.1:$p/" 2>/dev/null)
  g=$(curl -s -o /dev/null -w '%{http_code}' -m 10 "http://127.0.0.1:$p/ngsw.json" 2>/dev/null)
  # El proxy: mismo puerto del pod, pero una ruta que NO sirve él. 000 = se cuelga (el fallo
  # original), 502 = resuelve mal, 200 = llega al backend de verdad.
  a=$(curl -s -o /dev/null -w '%{http_code}' -m 15 "http://127.0.0.1:$p/api/health" 2>/dev/null)
  if [ "$c" = 200 ] && [ "$g" = 200 ] && [ "$a" = 200 ]; then
    ok "$n (pod :$p): raíz 200 · ngsw.json 200 · /api/health 200 (el proxy llega)"
  else
    mal "$n (pod :$p): raíz $c · ngsw.json $g · /api/health $a"
  fi
done

titulo "La puerta: por donde entra la gente"
# ⛔⛔ ESTE BLOQUE FALTABA, Y EL 2026-10-01 ESTE GUION DIJO "Sin fallas" CON EL SITIO ABAJO.
#
# Durante 32 minutos (21:06–21:38) megadulcessuite.com no contestó desde internet: Caddy
# migró a K3s, su imagen no estaba en el registry y —al ser Recreate— el pod viejo ya había
# muerto. Todo lo de arriba seguía verde: la base, el WAL, la API en su NodePort, portal y
# vendedor en los suyos. ⭐ Es que nada de eso es la puerta. Verificar los cuartos no es
# verificar la entrada.
#
# Se prueba con el NOMBRE REAL y con validación de cadena completa (sin -k) porque es lo que
# hace un navegador: las apps mandan HSTS, así que un certificado malo NO es saltable y deja
# a la oficina afuera sin recurso. `--resolve` fuerza la IP sin tocar DNS; el SNI lo elige la
# URL, que es justo lo que un `--header Host:` no puede hacer.
_hosts=$(grep -oE '^[a-z0-9.-]+\.megadulcessuite\.com' /home/superoot/ops/prod/Caddyfile 2>/dev/null | sort -u)
_hosts="megadulcessuite.com $_hosts"
_puerta=0
for h in $_hosts; do
  c=$(curl -s -o /dev/null -w '%{http_code}' -m 15 --resolve "$h:443:127.0.0.1" "https://$h/" 2>/dev/null)
  if [ "$c" = 200 ] || [ "$c" = 301 ] || [ "$c" = 302 ]; then
    ok "$h por Caddy: $c"
  else
    mal "$h por Caddy: $c  (000 = nadie escucha o el certificado no valida)"
    _puerta=$((_puerta+1))
  fi
done
[ -n "$(echo "$_hosts" | tr -d ' ')" ] || nm "no pude leer los nombres del Caddyfile para probar la puerta"

# ⛔ Y el que de verdad trae a la gente de afuera. Si el túnel está abajo, Caddy puede estar
# perfecto y el sitio seguir sin contestar desde internet.
if command -v k3s >/dev/null 2>&1; then
  _cf=$(KUBECONFIG=/etc/rancher/k3s/k3s.yaml k3s kubectl -n prod get deploy cloudflared \
          -o jsonpath='{.status.availableReplicas}/{.spec.replicas}' 2>/dev/null)
  case "$_cf" in
    ''|0/*) mal "cloudflared: ${_cf:-no se pudo leer} — nadie trae el tráfico de internet" ;;
    *)      ok  "cloudflared: $_cf réplicas listas (el túnel está arriba)" ;;
  esac

  # ⭐ El patrón general, no el caso: los deployments `Recreate` no tienen red de seguridad.
  # Si uno de ellos queda en 0, ES servicio abajo — no un despliegue pendiente.
  _caidos=$(KUBECONFIG=/etc/rancher/k3s/k3s.yaml k3s kubectl -n prod get deploy \
    -o jsonpath='{range .items[*]}{.metadata.name}:{.spec.strategy.type}:{.spec.replicas}:{.status.availableReplicas}{"\n"}{end}' 2>/dev/null \
    | awk -F: '$3 > 0 && ($4 == "" || $4 == "0") { print $1 "(" $2 ")" }' | tr '\n' ' ')
  if [ -n "$(echo "$_caidos" | tr -d ' ')" ]; then
    mal "deployments de prod SIN una sola réplica viva: $_caidos"
  else
    ok "todos los deployments de prod tienen réplicas vivas"
  fi
else
  nm "sin k3s en este host no se puede medir el túnel ni los deployments"
fi

titulo "¿Hay algo vivo en el clúster que NO esté en el repo?"
# ⛔⛔ ESTE BLOQUE EXISTE POR UN SERVICE FANTASMA QUE COSTÓ ~12 h DE TICKETS EN VIVO.
#
# El puente `api` del namespace `ingesta` se creó A MANO durante la migración y nunca se
# versionó — tanto que un comentario de `24-store-poller.deployment.yaml` ya lo citaba como
# `11-api-externo.yaml`, un archivo que no existía. Apuntaba a `192.168.0.222:8080`, el
# `prod-api` de Compose; cuando el API migró a K3s ahí dejó de haber nadie y `store-poller`
# no pudo ENTREGAR ni un ticket.
#
# ⭐ Lo que lo volvió difícil de ver: el error decía "01 Padre Hidalgo: fetch failed · 02 La
# Piedad Abastos: fetch failed · ..." — se lee como "no alcanza las sucursales". Las alcanzaba
# perfecto. Un error que nombra el ORIGEN cuando el roto es el DESTINO manda a buscar al lado
# equivocado. La pista real era que fallaran las OCHO a la vez.
#
# El candado del repo (`npm run check:k3s`) no puede ver esto: sólo lee los .yaml. Lo que no
# está en el repo es invisible para él por definición. Por eso se mide ACÁ, contra el clúster.
if command -v k3s >/dev/null 2>&1; then
  _fantasmas=''
  for _ns in prod ingesta; do
    for _s in $(KUBECONFIG=/etc/rancher/k3s/k3s.yaml k3s kubectl -n "$_ns" get svc \
                  -o jsonpath='{range .items[*]}{.metadata.name} {end}' 2>/dev/null); do
      case "$_s" in kubernetes) continue ;; esac
      grep -rql "name: $_s$\|name: $_s," /home/superoot/ops/k3s/ 2>/dev/null >/dev/null \
        || _fantasmas="$_fantasmas $_ns/$_s"
    done
  done
  if [ -n "$(echo "$_fantasmas" | tr -d ' ')" ]; then
    mal "Services vivos SIN manifiesto en ~/ops/k3s:$_fantasmas — nadie los vuelve a leer"
  else
    ok "todos los Services de prod e ingesta tienen manifiesto versionado"
  fi
else
  nm "sin k3s en este host no se puede comparar el clúster contra el repo"
fi

titulo "El respaldo"
u=$(ls -t /home/superoot/backups/*.dump 2>/dev/null | head -1)
if [ -n "$u" ]; then
  ok "último volcado: $(basename "$u") · $(( $(stat -c %s "$u") / 1048576 )) MB · hace $(( ( $(date +%s) - $(stat -c %Y "$u") ) / 3600 )) h"
else
  mal "no hay ningún volcado en /home/superoot/backups"
fi
# El latido vive en la base de PRODUCCIÓN (Railway), no en la copia: por eso no se consulta acá.
nm "latido backup_prod — vive en prod, se mira con: psql \"\$ODS_HB_URL\" -c \"select * from analytics.cron_runs where job_key='backup_prod'\""

titulo "La ingesta (no se toca desde acá, pero si la rompimos hay que saberlo)"
# ⛔ [K3S.22] CUENTA LOS DOS MUNDOS, Y ANTES CONTABA UNO SOLO.
#
# Este bloque exigía >=9 contenedores con la etiqueta de Compose `vl`. Desde que los 7 carriles
# se fueron a K3s quedan 3, así que reportaba ROJO sobre un estado perfectamente SANO — medido
# el 2026-10-01: "sólo 3 de 3 sanos", con los 7 pods corriendo y entregando.
#
# ⭐ Eso no es un detalle cosmético: una alarma que grita en falso enseña a ignorar el tablero,
# y así es como la próxima falla REAL pasa inadvertida. Es la misma lección de [CT.1] (4
# versiones conviviendo 13 días) y de [CPU.4] (7 carriles marcados viejos con código idéntico).
#
# ⚠️ Si no hay k3s en el host, la mitad de K3s se DECLARA no medida — no se da por buena. Lo que
# no se puede medir nunca cuenta como verde (ADR-056).
# ⛔ [K3S.45] Y EL NÚMERO ESPERADO YA NO ES UN LITERAL. Decía `-ge 9`, y al migrar el último
# carril a K3s el total pasó a 8: el guion imprimió "sólo 8 de 8 carriles sanos" — rojo, con
# un mensaje que se contradice a sí mismo, sobre un estado sano. Es la MISMA falla que este
# bloque ya había corregido una vez (exigía 9 contenedores de Compose cuando quedaban 3).
#
# ⭐ Corregir el literal de 9 a 8 habría durado hasta la próxima mudanza. Ahora no hay número:
# se exige que CADA deployment declarado tenga réplicas vivas y que CADA contenedor de Compose
# que siga levantado esté sano. La expectativa sale de lo que hay declarado, no de la memoria
# de quien lo escribió.
viv=$(docker ps --filter "label=com.docker.compose.project=vl" --format '{{.Names}}' | wc -l)
san=$(docker ps --filter "label=com.docker.compose.project=vl" --filter "health=healthy" --format '{{.Names}}' | wc -l)
if command -v k3s >/dev/null 2>&1; then
  KC=/etc/rancher/k3s/k3s.yaml
  _depl=$(KUBECONFIG=$KC k3s kubectl get deploy -n ingesta --no-headers 2>/dev/null | wc -l)
  _caidos=$(KUBECONFIG=$KC k3s kubectl get deploy -n ingesta \
    -o jsonpath='{range .items[*]}{.metadata.name}:{.spec.replicas}:{.status.availableReplicas}{"\n"}{end}' 2>/dev/null \
    | awk -F: '$2 > 0 && ($3 == "" || $3 == "0") { print $1 }' | tr '\n' ' ')
  _cj=$(KUBECONFIG=$KC k3s kubectl get cronjob -n ingesta --no-headers 2>/dev/null | wc -l)
  echo "   ⓘ Compose: $san/$viv sanos  ·  K3s(ingesta): $_depl deployment(s) + $_cj agenda(s) nocturna(s)"
  if [ -n "$(echo "$_caidos" | tr -d ' ')" ]; then
    mal "deployments de ingesta SIN una réplica viva: $_caidos"
  elif [ "$viv" -gt 0 ] && [ "$san" -lt "$viv" ]; then
    mal "$san de $viv contenedores de Compose sanos — alguno quedó enfermo"
  else
    ok "los $_depl carriles de K3s con réplicas vivas y los $viv de Compose sanos"
  fi
else
  # Sin k3s en el host solo se puede juzgar lo que quede en Compose, y tampoco con un literal:
  # el `-ge 3` que habia aca era otro numero clavado que caduca en la proxima mudanza.
  if [ "$viv" -gt 0 ] && [ "$san" -ge "$viv" ]; then
    ok "$san de $viv contenedores de Compose sanos"
  elif [ "$viv" -gt 0 ]; then
    mal "solo $san de $viv contenedores de Compose sanos"
  else
    nm "no hay contenedores de Compose del proyecto vl y tampoco k3s: nada que medir"
  fi
  nm "la mitad de K3s — no hay k3s en este host, así que NO se midió (no se da por buena)"
fi

printf '\n\033[1m══ Veredicto ══\033[0m\n'
if [ "$fallas" = 0 ]; then
  printf '   \033[32mSin fallas.\033[0m %s puntos NO MEDIDOS (declarados arriba).\n' "$nomed"
else
  printf '   \033[31m%s falla(s).\033[0m %s punto(s) no medido(s).\n' "$fallas" "$nomed"
fi
printf '   ⚠️  Esto verifica la COPIA. Que los usuarios entren por acá necesita dominio + túnel,\n'
printf '       y VL.8 (UPS, respaldo fuera de sitio, segundo enlace) sigue sin cerrarse.\n'
[ "$fallas" = 0 ] || exit 1
exit 0
