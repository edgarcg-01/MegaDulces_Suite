#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────────────────────
# `[SEG.4]` ¿Las tres cuentas de solo lectura hacen lo que dicen? Corre EN `md`.
#
#   ssh superoot@192.168.0.222 'sh ~/ops/prod/dev-ro-verificar.sh'
#
# ⛔ Se conecta POR LA RED (puerto publicado 5434), no con `docker exec` al contenedor. Dentro
# del contenedor `pg_hba` dice `host all all 127.0.0.1/32 trust`, o sea que desde ahi la
# contraseña ni se pide: una prueba hecha asi saldria verde sin haber probado la autenticacion.
# Se usa el contenedor `pg-rag` como cliente porque `md` no tiene `psql` en el host.
#
# ⚠️ La clave se pasa por STDIN y se lee con `read`, nunca por `-e` ni en la URL: `docker exec`
# publica sus argumentos en la lista de procesos de la maquina.
#
# Las cinco preguntas, y las dos ultimas son las que de verdad importan:
#   1. ¿entra?
#   2. ¿VE FILAS en una tabla con RLS forzada?  ← si esto da 0, `app.tenant_id` no quedo puesto
#                                                 y el rol es inutil sin dar ningun error
#   3. ¿lee una vista materializada?            ← `GRANT ON ALL TABLES` no las cubre
#   4. ¿se le NIEGA escribir?                    (prueba negativa)
#   5. ¿se le NIEGA `password_hash`?             (prueba negativa)
# ─────────────────────────────────────────────────────────────────────────────────────────────
set -u

CRED="${DEV_RO_CRED:-$HOME/secrets/dev-ro-credenciales.txt}"
CLIENTE="${DEV_RO_CLIENTE:-pg-rag}"
HOST="${DEV_RO_HOST:-192.168.0.222}"
PUERTO="${DEV_RO_PUERTO:-5434}"
BASE="${DEV_RO_DB:-railway}"

[ -f "$CRED" ] || { echo "⛔ no existe $CRED — corré dev-ro-crear.sh primero."; exit 1; }

# Ejecuta SQL como <usuario>. La clave entra por stdin; el SQL va por -c.
como() { # como <usuario> <clave> <sql>
  printf '%s\n' "$2" | docker exec -i "$CLIENTE" sh -c \
    "read -r P; PGPASSWORD=\"\$P\" PGCONNECT_TIMEOUT=10 psql -h $HOST -p $PUERTO -U '$1' -d $BASE -At -c \"\$0\" 2>&1" "$3"
}

ok=0; mal=0
juzgar() { # juzgar <rotulo> <esperado-regex> <obtenido>
  # ⚠️ El `--` NO es adorno: sin él, un patrón que empieza con `-` (como `-0000d01c$`) lo toma
  # `grep` como una OPCIÓN y responde `invalid argument for --directories`. Salía ✗ con el valor
  # correcto en la mano. Un test que falla por el motivo equivocado también puede aprobar por el
  # motivo equivocado.
  if printf '%s' "$3" | grep -qE -- "$2"; then printf '      ✓ %s\n' "$1"; ok=$((ok+1))
  else printf '      ✗ %s  → %s\n' "$1" "$(printf '%s' "$3" | head -1 | cut -c1-90)"; mal=$((mal+1)); fi
}

# Se leen del archivo de credenciales: "usuario   clave" (se saltan comentarios y vacias).
grep -vE '^#|^$' "$CRED" | while IFS= read -r linea; do
  u=$(printf '%s' "$linea" | awk '{print $1}')
  k=$(printf '%s' "$linea" | awk '{print $2}')
  [ -n "$u" ] && [ -n "$k" ] || continue
  echo "── $u ──"

  juzgar "1. entra y se identifica"            "^$u\$"        "$(como "$u" "$k" 'SELECT current_user')"
  juzgar "2. VE filas con RLS forzada"         '^[1-9][0-9]*$' "$(como "$u" "$k" 'SELECT count(*) FROM commercial.orders')"
  # ⚠️ El patrón se escribe contra el valor REAL, no contra el que uno recuerda: el UUID termina
  # en `…-00000000d01c`, así que un `-0000d01c$` no casa nunca. Costó dos corridas en rojo sobre
  # un valor que estaba bien.
  juzgar "   · y el tenant quedó puesto"       '00000000d01c$' "$(como "$u" "$k" "SELECT current_setting('app.tenant_id')")"
  juzgar "3. lee una vista materializada"      '^[0-9]+$'      "$(como "$u" "$k" 'SELECT count(*) FROM analytics.mv_kepler_sales_daily')"
  juzgar "4. NO puede escribir"                'read-only|solo lectura|denied|denegado' \
                                               "$(como "$u" "$k" 'CREATE TABLE public.zz_prueba_dev_ro(x int)')"
  juzgar "5. NO puede leer password_hash"      'denied|denegado|permiso'  \
                                               "$(como "$u" "$k" 'SELECT password_hash FROM identity.users LIMIT 1')"
  juzgar "   · pero SÍ el resto de la tabla"   '^[0-9]+$'      "$(como "$u" "$k" 'SELECT count(*) FROM identity.users')"
  # ⚠️ Postgres NORMALIZA el intervalo: se pidió `60s` y `current_setting` devuelve `1min`.
  # Esperar el literal que uno escribió da un ✗ sobre un valor que está bien.
  juzgar "6. tiene tope de consulta"           '^(60s|1min|60000)$' "$(como "$u" "$k" "SELECT current_setting('statement_timeout')")"
  juzgar "7. la sesión nace de solo lectura"   '^on$'               "$(como "$u" "$k" "SELECT current_setting('default_transaction_read_only')")"
done

echo
echo "(el conteo por cuenta va arriba; cada ✗ es un permiso que hay que revisar antes de repartir la clave)"
