#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────────────────────
# `[SEG.4]` Crea (o ROTA) las tres cuentas de solo lectura de `railway`. Corre EN `md`.
#
#   scp ops/prod/dev-ro.sql ops/prod/dev-ro-crear.sh superoot@192.168.0.222:ops/prod/
#   ssh superoot@192.168.0.222 'sh ~/ops/prod/dev-ro-crear.sh'
#
# ── Por que las claves se generan ACA y no se escriben en ningun otro lado ───────────────────
# Porque el unico lugar donde un secreto no molesta es donde se usa. Este guion:
#   1. las genera en `md` con `openssl`,
#   2. las deja en `~/secrets/dev-ro-credenciales.txt` con permisos 600 —el mismo cajon que ya
#      guarda `prod.env` y `prod-compose.env`—,
#   3. se las pasa a psql por **stdin**, no por la linea de comandos, para que no aparezcan ni
#      un segundo en la lista de procesos de la maquina,
#   4. y borra el archivo intermedio.
# Nunca las imprime. Quien las necesite las lee del archivo.
#
# ⚠️ Correrlo ROTA la clave de LAS PERSONAS DE ESA CORRIDA, y sólo de ésas. Los roles, permisos
# y ajustes son idempotentes; las contraseñas no. Para agregar a alguien sin tocar al resto:
#
#     DEV_RO_PERSONAS=edgar sh ~/ops/prod/dev-ro-crear.sh
#
# ⛔ En la primera versión esto NO era cierto: `DEV_RO_PERSONAS` sólo afectaba al archivo de
# credenciales, mientras la lista real vivía clavada dentro del `.sql` junto con tres
# `ALTER ROLE … PASSWORD` fijos. O sea que una alta rotaba las claves de los tres anteriores e
# invalidaba las que ya se habían repartido — y el guion ofrecía la variable como si funcionara.
# Un parámetro que no parametriza es peor que no tenerlo, porque se confía en él.
#
# ⚠️ El alfabeto de la clave excluye comilla simple, `/`, `+`, `=`, `@` y `:` a proposito: la
# comilla rompe el `\set` de psql y los otros cuatro rompen una cadena de conexion
# `postgresql://usuario:clave@host/base` sin que el error diga por que.
# ─────────────────────────────────────────────────────────────────────────────────────────────
set -eu

SQL="${DEV_RO_SQL:-$HOME/ops/prod/dev-ro.sql}"
SECRETOS="${DEV_RO_SECRETOS:-$HOME/secrets}"
CRED="$SECRETOS/dev-ro-credenciales.txt"
VARS="$SECRETOS/.dev-ro-claves.sql"
PERSONAS="${DEV_RO_PERSONAS:-david francisco sistemas}"
BASE="${DEV_RO_DB:-railway}"
CONTENEDOR="${DEV_RO_CONTENEDOR:-pg-prod}"
PUERTO_HOST="${DEV_RO_PUERTO:-5434}"

di() { echo "[$(date '+%F %T')] $*"; }

[ -f "$SQL" ] || { echo "⛔ falta $SQL — subilo con scp desde el repo."; exit 1; }
mkdir -p "$SECRETOS"; chmod 700 "$SECRETOS" 2>/dev/null || true

clave() { openssl rand -base64 30 | tr -d "=+/@:'\n" | cut -c1-28; }

umask 077
POST="$SECRETOS/.dev-ro-post.sql"
ANTES="$SECRETOS/.dev-ro-cred-anterior"
: > "$VARS"; : > "$POST"

# La lista de ESTA corrida viaja al SQL como parametro. Antes la lista real vivia clavada
# adentro del `.sql` y esta variable no hacia nada (ver la cabecera).
printf "\\\\set personas '%s'\n" "$(echo $PERSONAS | tr ' ' ',')" >> "$VARS"

# ⛔ El archivo de credenciales se MEZCLA, no se pisa: quien no entra en esta corrida conserva
# la clave que ya tiene repartida. Pisarlo dejaba a esas personas con una clave escrita que ya
# no era la suya — peor que no tener el archivo, porque parece correcto.
#
# ⛔ Y se escribe en un archivo APARTE que sólo reemplaza al bueno si el SQL aplicó. La primera
# versión lo escribía antes de aplicar: cuando el SQL falló, el archivo quedó anunciando una
# cuenta que en la base no existía. Un archivo de credenciales que miente es peor que uno viejo,
# porque nadie duda de él.
NUEVO="$CRED.nuevo"
[ -f "$CRED" ] && cp -p "$CRED" "$ANTES" || : > "$ANTES"
: > "$NUEVO"
{
  echo "# [SEG.4] Cuentas de SOLO LECTURA sobre $BASE ($CONTENEDOR, puerto $PUERTO_HOST de $(hostname))."
  echo "# Actualizado $(date '+%F %T %Z'). NO se versiona. NO se manda por chat ni por correo."
  echo "#"
  echo "# Conexion:  postgresql://<usuario>:<clave>@192.168.0.222:$PUERTO_HOST/$BASE"
  echo "#"
  echo "# Lo que PUEDEN: leer los schemas de negocio, incluidas las vistas materializadas."
  echo "# Lo que NO: escribir nada, leer password_hash ni los tokens de orgmail, abrir mas de 5"
  echo "#            conexiones, ni correr una consulta de mas de 60 s."
  echo ""
} >> "$NUEVO"

# 1) Las que NO se tocan en esta corrida, tal cual estaban.
grep -vE '^#|^$' "$ANTES" 2>/dev/null | while IFS= read -r l; do
  u=$(printf '%s' "$l" | awk '{print $1}')
  echo " $PERSONAS " | grep -q " $u " || printf '%s\n' "$l" >> "$NUEVO"
done

# 2) Las de esta corrida, con clave nueva.
for p in $PERSONAS; do
  c=$(clave)
  printf "\\\\set clave_%s '%s'\n"  "$p" "$c" >> "$VARS"
  printf "ALTER ROLE %s PASSWORD :'clave_%s';\n" "$p" "$p" >> "$POST"
  printf "%-12s %s\n" "$p" "$c" >> "$NUEVO"
done
chmod 600 "$VARS" "$POST" "$NUEVO"

di "aplicando $SQL para: $PERSONAS"
# Por stdin: ni las claves ni el SQL pasan por argv.
cat "$VARS" "$SQL" "$POST" | docker exec -i "$CONTENEDOR" psql -U postgres -d "$BASE" -v ON_ERROR_STOP=1 \
  || { di "⛔ FALLO al aplicar — no se cambio nada, ni en la base ni en el archivo de claves."; rm -f "$VARS" "$POST" "$NUEVO" "$ANTES"; exit 1; }

# Recien ACA el archivo bueno se reemplaza: la base ya acepto el cambio.
mv -f "$NUEVO" "$CRED"; chmod 600 "$CRED"
rm -f "$VARS" "$POST" "$ANTES"
di "listo. Las claves estan en $CRED (permisos $(stat -c %a "$CRED"))."
di "Leelas con:  ssh superoot@192.168.0.222 'cat $CRED'"
