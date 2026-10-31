#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# `[OPS.OFF.1]` LA COPIA FUERA DE `md` — Cloudflare R2, cifrada en el cliente (rclone crypt).
#
# ── Por qué (medido 2026-10-31) ──────────────────────────────────────────────
# La base de prod, el repositorio de pgBackRest (51 GB: 33 de WAL + 18 de respaldos), los
# volcados diarios (~21 GB) y `pgvector-md` (73 GB) viven en el MISMO NVMe, sin UPS, en una
# máquina que ya se apagó en seco dos veces (SEG.2). Si muere el disco se pierden prod y sus
# respaldos JUNTOS. Y `pgvector-md` no tenía NINGÚN respaldo: adentro está `wincaja` (35 GB,
# «la única copia» de lo que las sucursales vendieron en Wincaja, ops/README §3.1.1) y
# `kepler_consolidado`, donde escriben las vans de ruta. VL.8 estaba ⬜ desde septiembre.
#
# ── Qué sube ─────────────────────────────────────────────────────────────────
#   1. El repositorio de pgBackRest ENTERO (respaldos + WAL = recuperación a un punto en el
#      tiempo). `sync` con `--backup-dir`: lo que pgBackRest expira acá NO se borra en R2, se
#      mueve a `borrados/<fecha>/` (una regla de ciclo de vida del bucket lo vence). Un `rm` o
#      un cifrado malicioso en `md` no se propaga como borrado.
#   2. El volcado diario de prod más reciente (`/backups/*.dump`, últimas 30 h).
#   3. `pgvector-md`: `wincaja` UNA vez (congelada desde el corte de Wincaja, 2026-10-01) y
#      `kepler_consolidado` los domingos.
#
# ── Por qué NO es un `repo2` de pgBackRest ───────────────────────────────────
# Con dos repositorios, el `archive_command` de pg-prod empuja el WAL a los dos: si R2 no
# contesta, el archivado falla, el WAL se acumula y el disco se llena — prod caído POR el
# respaldo, que es exactamente VL.9.10b. Este carril corre aparte: si R2 se cae, prod no se
# entera y lo único que pasa es que este latido se pone rojo.
#
# ── La credencial ────────────────────────────────────────────────────────────
# `/secrets-fuera/offsite.env` (hostPath `~/secrets/fuera/`, un DIRECTORIO y no un archivo: el
# bind de un archivo se ata al INODO y no ve una reescritura — VL.13). La crea una persona; este
# script no la inventa. Sin ella el latido queda en ROJO con «NO MEDIDO», nunca en verde:
#   R2_ACCOUNT_ID  R2_ACCESS_KEY_ID  R2_SECRET_ACCESS_KEY  R2_BUCKET
#   OFFSITE_CRYPT_PASSWORD  OFFSITE_CRYPT_SALT      (los dos en forma `rclone obscure`)
# ⛔ SIN LA CONTRASEÑA DE CIFRADO LA COPIA NO SE PUEDE LEER. Guardarla también FUERA de `md`;
#    si sólo vive en `md`, la copia muere con el disco que viene a proteger.
#
#   a mano (dentro del pod):  sh /usr/local/bin/offsite-sync.sh
#   tablero:                  Salud BD → job_key = 'respaldo_fuera'
# ─────────────────────────────────────────────────────────────────────────────
set -u

TENANT="${CRON_TENANT_ID:-00000000-0000-0000-0000-00000000d01c}"
JOB="respaldo_fuera"
YO="md-backup"
CRED="${OFFSITE_ENV:-/secrets-fuera/offsite.env}"
REPO="${OFFSITE_REPO_DIR:-/var/lib/pgbackrest}"
DUMPS="${OFFSITE_DUMPS_DIR:-/backups}"
PISO_GB="${OFFSITE_MIN_FREE_GB:-20}"   # wincaja comprimida mide varios GB; sin disco no se vuelca

di() { echo "[$(date '+%F %T %Z')] $*"; }

# ── Latido: mismo contrato que backup-prod.sh (SQL por stdin: psql no interpola en `-c`) ──
URLK=""
if [ -r /secrets/ingest.env ]; then
  set -a; . /secrets/ingest.env; set +a
  case "${ODS_HB_URL:-}" in *\?*) SEP='&';; *) SEP='?';; esac
  [ -n "${ODS_HB_URL:-}" ] && URLK="${ODS_HB_URL}${SEP}connect_timeout=15"
fi
latido_ini() {
  [ -n "$URLK" ] || { di "aviso: sin ODS_HB_URL, el latido no se escribe"; return 0; }
  psql "$URLK" -q -v t="$TENANT" -v j="$JOB" -v h="$YO" -f - <<'SQL' >/dev/null 2>&1 || di "aviso: el latido de inicio no se pudo escribir"
INSERT INTO analytics.cron_runs (tenant_id, job_key, label, last_start, status, host, updated_at)
VALUES (:'t', :'j', 'Copia fuera de md (R2, cifrada)', now(), 'running', :'h', now())
ON CONFLICT (tenant_id, job_key) DO UPDATE
  SET label = EXCLUDED.label, last_start = now(), status = 'running', host = EXCLUDED.host, updated_at = now();
SQL
}
latido_fin() { # latido_fin <ok|error> <texto>
  [ -n "$URLK" ] || return 0
  if [ "$1" = ok ]; then _n="$2"; _e=''; else _n=''; _e="$2"; fi
  psql "$URLK" -q -v t="$TENANT" -v j="$JOB" -v s="$1" -v n="$_n" -v e="$_e" -f - <<'SQL' >/dev/null 2>&1 || di "aviso: el latido de fin no se pudo escribir"
UPDATE analytics.cron_runs
   SET last_finish = now(), status = :'s', note = NULLIF(:'n',''), error = NULLIF(:'e',''),
       duration_ms = CASE WHEN last_start IS NOT NULL
                          THEN (EXTRACT(EPOCH FROM (now() - last_start))*1000)::bigint END,
       updated_at = now()
 WHERE tenant_id = :'t' AND job_key = :'j';
SQL
}
morir() { di "FALLO: $*"; latido_fin error "$*"; exit 1; }

di "── copia fuera de md ──"
latido_ini

# ── Compuerta 1: la credencial. Sin ella NO hay copia, y se dice. ──
[ -r "$CRED" ] || morir "NO MEDIDO: falta la credencial ($CRED) — NO hay copia fuera de md"
set -a; . "$CRED"; set +a
for v in R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET OFFSITE_CRYPT_PASSWORD OFFSITE_CRYPT_SALT; do
  eval "_x=\${$v:-}"; [ -n "$_x" ] || morir "NO MEDIDO: falta $v en $CRED"
done
command -v rclone >/dev/null 2>&1 || morir "rclone no está en la imagen (Dockerfile.backup)"

# rclone por variables de entorno: ningún archivo de configuración que se filtre o diverja.
export RCLONE_CONFIG_R2_TYPE=s3 RCLONE_CONFIG_R2_PROVIDER=Cloudflare \
       RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
       RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
       RCLONE_CONFIG_R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com" \
       RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true
export RCLONE_CONFIG_FUERA_TYPE=crypt RCLONE_CONFIG_FUERA_REMOTE="r2:${R2_BUCKET}" \
       RCLONE_CONFIG_FUERA_PASSWORD="$OFFSITE_CRYPT_PASSWORD" \
       RCLONE_CONFIG_FUERA_PASSWORD2="$OFFSITE_CRYPT_SALT"
OPC="--transfers 4 --checkers 8 --retries 3 --low-level-retries 10 --stats 0"
HOY=$(date +%F)

# ── Compuerta 2: R2 contesta. Mejor un rojo claro acá que un sync que falla a medias. ──
rclone lsf "r2:${R2_BUCKET}" --max-depth 1 >/dev/null 2>&1 || morir "R2 no contesta o la credencial no sirve (bucket ${R2_BUCKET})"

# ── 1. pgBackRest: respaldos + WAL ──
rclone sync "$REPO" fuera:pgbackrest --backup-dir "fuera:borrados/$HOY/pgbackrest" $OPC \
  || morir "falló el sync del repositorio de pgBackRest"
n_repo=$(du -sh "$REPO" 2>/dev/null | cut -f1)

# ── 2. El volcado de prod más reciente ──
rclone copy "$DUMPS" fuera:volcados/prod --include '/*.dump' --max-age 30h $OPC \
  || morir "falló la copia del volcado de prod"
ultimo=$(ls -t "$DUMPS"/*.dump 2>/dev/null | head -1)
[ -n "$ultimo" ] || morir "NO MEDIDO: no hay ningún volcado de prod en $DUMPS"

# ── 3. pgvector-md: wincaja una vez, kepler_consolidado los domingos ──
fuente="${ODS_SOURCE_BASE:-}"
[ -n "$fuente" ] || morir "NO MEDIDO: ODS_SOURCE_BASE vacía — no se puede respaldar pgvector-md"
fuente="${fuente%/*}"                      # sin la base: se elige abajo
mkdir -p "$DUMPS/pgvector-md"
libre_gb() { df -BG --output=avail "$DUMPS" 2>/dev/null | tail -1 | tr -dc '0-9'; }
volcar() { # volcar <base> <archivo>
  [ "$(libre_gb)" -ge "$PISO_GB" ] || morir "hacen falta $PISO_GB GB libres para volcar $1 y hay $(libre_gb)"
  pg_dump --dbname="$fuente/$1?connect_timeout=15&keepalives=1" --format=custom --compress=6 \
          --no-owner --file="$2.parcial" && mv "$2.parcial" "$2" \
    || { rm -f "$2.parcial"; morir "falló el volcado de $1 (pgvector-md)"; }
}
w_estado="ya estaba"
if [ ! -f "$DUMPS/pgvector-md/wincaja.subida" ]; then
  volcar wincaja "$DUMPS/pgvector-md/wincaja.dump"
  rclone copy "$DUMPS/pgvector-md/wincaja.dump" fuera:congelado/wincaja $OPC \
    || morir "falló la subida de wincaja"
  date '+%F %T' > "$DUMPS/pgvector-md/wincaja.subida"
  w_estado="subida hoy ($(du -sh "$DUMPS/pgvector-md/wincaja.dump" | cut -f1))"
fi
c_estado="no toca (sólo domingos)"
if [ "$(date +%u)" = 7 ]; then
  f="$DUMPS/pgvector-md/kepler_consolidado_$HOY.dump"
  volcar kepler_consolidado "$f"
  rclone copy "$f" fuera:volcados/consolidado $OPC || morir "falló la subida de kepler_consolidado"
  ls -t "$DUMPS"/pgvector-md/kepler_consolidado_*.dump 2>/dev/null | tail -n +3 | xargs -r rm -f
  c_estado="subido ($(du -sh "$f" | cut -f1))"
fi

nota="pgBackRest $n_repo sincronizado · volcado $(basename "$ultimo") · wincaja: $w_estado · consolidado: $c_estado"
di "$nota"
latido_fin ok "$nota"
