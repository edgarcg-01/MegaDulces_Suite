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
# ⚠️ Correrlo de nuevo ROTA las claves: los roles y permisos son idempotentes, las contraseñas no.
# Es la forma de rotar, y hay que avisar antes de hacerlo porque invalida las que ya se repartieron.
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
: > "$VARS"
: > "$CRED"
{
  echo "# [SEG.4] Cuentas de SOLO LECTURA sobre $BASE ($CONTENEDOR, puerto $PUERTO_HOST de $(hostname))."
  echo "# Generado $(date '+%F %T %Z'). NO se versiona. NO se manda por chat ni por correo."
  echo "#"
  echo "# Conexion:  postgresql://<usuario>:<clave>@192.168.0.222:$PUERTO_HOST/$BASE"
  echo "#"
  echo "# Lo que PUEDEN: leer los schemas de negocio, incluidas las vistas materializadas."
  echo "# Lo que NO: escribir nada, leer password_hash ni los tokens de orgmail, abrir mas de 5"
  echo "#            conexiones, ni correr una consulta de mas de 60 s."
  echo ""
} >> "$CRED"

for p in $PERSONAS; do
  c=$(clave)
  printf "\\\\set clave_%s '%s'\n" "$p" "$c" >> "$VARS"
  printf "%-12s %s\n" "$p" "$c" >> "$CRED"
done
chmod 600 "$VARS" "$CRED"

di "aplicando $SQL contra $BASE…"
# Por stdin: ni las claves ni el SQL pasan por argv.
cat "$VARS" "$SQL" | docker exec -i "$CONTENEDOR" psql -U postgres -d "$BASE" -v ON_ERROR_STOP=1 \
  || { di "⛔ FALLO al aplicar — no se cambio nada (el script va en una transaccion)."; rm -f "$VARS"; exit 1; }

rm -f "$VARS"
di "listo. Las claves estan en $CRED (permisos $(stat -c %a "$CRED"))."
di "Leelas con:  ssh superoot@192.168.0.222 'cat $CRED'"
