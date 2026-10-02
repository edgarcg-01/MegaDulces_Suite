#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# [K3S.43] CÓMO SE LE HABLA A pg-prod — una sola implementación, los dos mundos.
#
#   sh ~/ops/prod/pgprod.sh -At -c "select 1"                 # psql por TCP
#   echo "select 1" | sh ~/ops/prod/pgprod.sh -q -f -          # psql por stdin
#   sh ~/ops/prod/pgprod.sh --dentro pgbackrest --stanza=prod info
#
# ── Por qué existe ───────────────────────────────────────────────────────────
# Hasta el 2026-10-01 había VEINTIÚN `docker exec pg-prod psql ...` repartidos en siete
# guiones. El día que la base pasó a ser un pod, los veintiuno dejaron de funcionar a la vez
# — incluidos el latido del despliegue y la compuerta que lee `knex_migrations`, o sea que el
# carril que despliega siete veces al día se habría quedado sin saber el estado de prod.
#
# ⭐ La forma de hablarle a la base no puede ser una decisión repetida en cada archivo. Es UNA,
# y vive acá. Dos implementaciones de lo mismo divergen; veintiuna, no se enteran juntas.
#
# ── Dos modos, porque son dos preguntas distintas ───────────────────────────
#
#  (sin bandera)  → `psql` por TCP al 5434. Funciona IGUAL antes y después del corte, porque
#                   el puerto es el mismo: Compose lo publicaba, el pod lo toma por `hostPort`.
#                   ⚠️ Por TCP sí pide contraseña (el socket unix no). Se lee de los secretos.
#
#  --dentro       → correr algo ADENTRO. Lo necesitan `pgbackrest` y cualquier cosa que toque
#                   archivos del datadir: no hay forma de hacer eso por una conexión SQL.
#                   Elige `docker exec` o `kubectl exec` según cuál esté vivo — y en los dos
#                   baja a `postgres` con `su`, porque `kubectl exec` entra como root y
#                   pgBackRest se niega a correr como root.
# ─────────────────────────────────────────────────────────────────────────────
set -u

PGH="${PGPROD_HOST:-127.0.0.1}"
PGP="${PGPROD_PORT:-5434}"
PGU="${PGPROD_USER:-postgres}"
PGD="${PGPROD_DB:-railway}"
SECRETOS="${PGPROD_SECRETOS:-$HOME/secrets/prod-compose.env}"

if [ "${1:-}" = "--dentro" ]; then
  shift
  [ $# -gt 0 ] || { echo "⛔ --dentro necesita un comando" >&2; exit 2; }
  # Un solo string para `su -c`, con cada argumento entrecomillado.
  _cmd=''
  for _a in "$@"; do _cmd="$_cmd '$(printf '%s' "$_a" | sed "s/'/'\\''/g")'"; done

  # Docker primero SÓLO si el contenedor está CORRIENDO. ⚠️ Tras el corte queda `exited` a
  # propósito (es la vuelta atrás): preguntarle a un contenedor detenido devuelve un error del
  # demonio que no menciona la causa, y el guion que llama lo lee como "pgbackrest falló".
  if docker inspect -f '{{.State.Running}}' pg-prod 2>/dev/null | grep -q true; then
    exec docker exec pg-prod su postgres -c "$_cmd"
  fi
  if command -v k3s >/dev/null 2>&1; then
    KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"; export KUBECONFIG
    if k3s kubectl -n prod get deploy pg-prod >/dev/null 2>&1; then
      exec k3s kubectl -n prod exec deploy/pg-prod -- su postgres -c "$_cmd"
    fi
  fi
  echo "⛔ pg-prod no está ni en Docker (corriendo) ni en K3s" >&2
  exit 1
fi

# ── Modo psql ────────────────────────────────────────────────────────────────
if [ -z "${PGPASSWORD:-}" ] && [ -r "$SECRETOS" ]; then
  PGPASSWORD=$(grep -m1 '^PGPROD_SUPERPASS=' "$SECRETOS" | cut -d= -f2- | tr -d '\r')
  export PGPASSWORD
fi
exec psql -h "$PGH" -p "$PGP" -U "$PGU" -d "$PGD" "$@"
