# VL.2b · Runbook del corte — mudar la fuente del ODS a `md`

> **Ventana estimada: 35–45 min**, de los cuales **~9 min son la transferencia**.
> Todo lo de abajo está **medido** contra las máquinas reales el 2026-09-11, no estimado.
> Requisito previo cerrado: `pg_hba` de las 8 ramas (`ods_repl` 8/8 · `platform_ro` 6/6).

---

## 0. Lo que hay que saber antes de leer el resto

**Sacar datos de `.249` es lento y no es culpa del plan.** Medido, 4 GB reales por cada camino:

| Camino | Velocidad | |
|---|---|---|
| Lectura del volumen **dentro** del contenedor | **69 MB/s** | el disco no es el problema |
| `tar` + `zstd -1` + `ssh`, **todo dentro** del contenedor | **21 MB/s** | ⭐ **el que se usa** |
| `tar` + `ssh` sin comprimir, dentro del contenedor | 16 MB/s | comprimir **sí** conviene: ratio **4.6×** |
| Windows → LAN por `ssh`, sin Docker | 68 MB/s | la red está bien |
| ⛔ stdout de `docker run` (la API de Docker Desktop) | **5 MB/s** | 13× más lento |
| ⛔ el volumen por el path `\\wsl$\…` (9P), 22,007 archivos | **5 MB/s** | |

**Conclusión operativa: los bytes NUNCA deben cruzar la frontera Windows↔WSL.** El `tar`, el `zstd`
y el `ssh` corren **los tres dentro del contenedor**; así los datos van del volumen a la LAN sin
pasar por la API de Docker ni por 9P.

**Y no se transfieren los 50.8 GB, sino ~11.** `wincaja` es el **OID 561593** = `base/561593` =
**39.7 GB**, y se queda en `.249` con su carril hasta VL.5 (decisión D3). Excluirla baja la
transferencia de **44 min a ~9**. Se compensa arrancando el cluster nuevo sin nada que pueda tocar
esa base (paso 4).

---

## 1. Preparación — días antes, SIN ventana

### 1.1 ⛔ Arreglar primero las 7 tablas atascadas de `md_00`

`sub_md_00` tiene **7 tablas en copia inicial desde siempre** (`kdfe33nomem`, `kdrhdfes`, `kdrhfeba`,
`kdrhfpag`, `kdrhhor`, `kdrhrut`, `kdrhtpcn`) porque `ods_repl` no tiene SELECT sobre ellas — son de
dueño `sa` y son las únicas 7 de todo `md.*` sin permiso. Reintenta en bucle y **`md_00` está en 8 de
10 `max_replication_slots`**. Si se copia así, el cluster nuevo hereda el problema.

En el POS `192.168.9.95`, como superusuario o como el propio `sa`:

```sql
GRANT SELECT ON ALL TABLES IN SCHEMA md TO ods_repl;
ALTER DEFAULT PRIVILEGES FOR ROLE sa IN SCHEMA md GRANT SELECT ON TABLES TO ods_repl;
```

Verificar que quedó en `r` y que los slots se liberaron solos:

```bash
docker exec pgvector-md psql -U postgres -d kepler_md_00 -tAc \
  "select srsubstate::text, count(*) from pg_subscription_rel r
     join pg_subscription s on s.oid=r.srsubid where s.subname='sub_md_00' group by 1;"
# esperado: una sola fila, r | 355
```

### 1.2 Disco de datos en `md` — LV aparte, no `/`

`/` son 100 G (85 libres) y el VG tiene **~850 GB sin asignar**. El volumen de Docker aterriza en
`/var/lib/docker`, que hoy vive en `/`. Con Wincaja y prod por venir, eso se queda corto.

```bash
sudo lvcreate -L 300G -n lv_docker ubuntu-vg
sudo mkfs.ext4 -m 0 /dev/ubuntu-vg/lv_docker
sudo systemctl stop docker docker.socket
sudo mv /var/lib/docker /var/lib/docker.old
sudo mkdir /var/lib/docker
echo '/dev/ubuntu-vg/lv_docker /var/lib/docker ext4 defaults,noatime 0 2' | sudo tee -a /etc/fstab
sudo mount -a && sudo rsync -aHAX /var/lib/docker.old/ /var/lib/docker/
sudo systemctl start docker && docker images   # debe listar trade-ingest:latest
sudo rm -rf /var/lib/docker.old
```

### 1.3 Medir el disco de los 8 publicadores

Mientras la réplica esté abajo, **los publicadores retienen WAL**. La ventana es corta, pero el dato
se mide, no se supone:

```bash
docker exec pgvector-md psql -U postgres -tAc \
  "select subname||'|'||subconninfo from pg_subscription order by subname;" \
  | ssh superoot@192.168.0.222 'bash /tmp/slots.sh'
```

Hoy los 8 slots retienen **56 bytes** y están `reserved`. Cualquier rama con poco disco libre se
atiende antes, o se hace aparte.

### 1.4 Registrar el BASELINE del reconciliador

Es contra esto que se juzga el corte, **no contra cero** (§4).

```bash
ssh superoot@192.168.0.222 'set -a; . ~/secrets/ingest.env; set +a;
  psql "$ODS_HB_URL" -F" | " -A -f /tmp/hb.sql'
```

Observado en régimen normal (2026-09-10/11): `huecos` **167 · 49 · 48 · 42 · 12**, y en todas
`repuestas == huecos` con `errores 0`. **Anotar el valor del día antes del corte.**

---

## 2. El corte

### Paso 1 — apagar los carriles en `.249`

⛔ **Nunca dos shippers a la vez**: `ods.ctl`/`ods.shadow` son estado compartido.

```powershell
docker compose -f ops/ingest/docker-compose.yml stop ods-live-hot ods-live-mirror ods-reconcile
```

### Paso 2 — parar la fuente

```powershell
docker stop pgvector-md
```

Desde acá corre el reloj de la ventana.

### Paso 3 — transferir (~9 min) — TODO dentro del contenedor

```powershell
MSYS_NO_PATHCONV=1 docker run --rm `
  -v pgvector-md-data:/data -v "C:/Users/Sistemas/.ssh:/keys:ro" alpine sh -c '
  apk add --no-cache zstd openssh-client >/dev/null 2>&1
  cp /keys/id_ed25519 /tmp/k && chmod 600 /tmp/k
  tar cf - --numeric-owner -C /data/18/docker --exclude=base/561593 --exclude=pg_wal/* . \
   | zstd -1 -T0 \
   | ssh -i /tmp/k -o StrictHostKeyChecking=no -o BatchMode=yes -o Compression=no \
       superoot@192.168.0.222 "sudo -n mkdir -p /srv/pgods && sudo -n tar xf - --numeric-owner -I zstd -C /srv/pgods"'
```

⚠️ `--exclude=base/561593` es **`wincaja`** — confirmar el OID antes de correr, no confiar en este
número: `select oid, datname from pg_database where datname='wincaja';`
⚠️ `--numeric-owner` en **los dos lados**: el `postgres` del contenedor es un uid numérico, no un
nombre que exista en `md`.
⚠️ `pg_wal/*` se excluye a propósito — el cluster lo regenera y son 256 MB de nada.

### Paso 4 — arrancar aislado y dropear `wincaja`

**Aislado a propósito:** sin autovacuum y sin workers de replicación, nada puede tocar la base cuyos
archivos no vinieron ni conectarse a las sucursales antes de que verifiquemos.

```bash
sudo mkdir -p /var/lib/docker/volumes/pgvector-md-data/_data/18 \
 && sudo mv /srv/pgods /var/lib/docker/volumes/pgvector-md-data/_data/18/docker
docker run -d --name pgods-tmp -v pgvector-md-data:/var/lib/postgresql pgvector/pgvector:pg18 \
  postgres -c autovacuum=off -c max_logical_replication_workers=0 \
           -c max_replication_slots=20 -c max_wal_senders=20 -c max_worker_processes=24
docker exec pgods-tmp psql -U postgres -c "DROP DATABASE wincaja;"
docker rm -f pgods-tmp
```

### Paso 5 — levantar el stack definitivo

```bash
cd ~/ops/vl && docker compose --profile db up -d pg-ods
# esperar a que acepte y confirmar que las 8 suscripciones retoman
docker exec pgvector-md psql -U postgres -d kepler_md_00 -F' | ' -A -c \
  "select subname, (received_lsn is not null) recibiendo,
          round(extract(epoch from (now()-latest_end_time))) hace_s
   from pg_stat_subscription order by subname;"
```

**Criterio: las 8 en `recibiendo=t`.** Retoman desde su slot — por eso la copia es física.

### Paso 6 — VL.2c: desactivar las suscripciones viejas en `.249`

Los dos clusters tienen ahora las 8 suscripciones apuntando a **los mismos slots**, y un slot admite
**una sola** conexión activa.

```powershell
docker start pgvector-md   # sigue haciendo falta: `wincaja` vive acá hasta VL.5
```
```sql
-- en cada kepler_md_XX de .249
ALTER SUBSCRIPTION <nombre> DISABLE;
```

⛔ **`DISABLE`, nunca `DROP`.** Se conservan como rollback. Y si algún día se dropean, **primero
`ALTER SUBSCRIPTION … SET (slot_name = NONE)`**, o el `DROP` borra el slot **del publicador** y le
corta la fuente al servidor nuevo.

### Paso 7 — mover los carriles

```bash
sed -i 's#@192\.168\.0\.249:5433#@pg-ods:5432#' ~/secrets/ingest.env
cd ~/ops/vl && docker compose up -d
```

---

## 3. Verificación

```bash
ssh superoot@192.168.0.222 'set -a; . ~/secrets/ingest.env; set +a;
  psql "$ODS_HB_URL" -F" | " -A -f /tmp/hb.sql'
```

**Verde = los 3 latidos con `host` NUEVO, frescos, y `8/8 ramas`.** Un carril que dice `0/8 ramas` no
está entregando aunque el contenedor esté `healthy`.

---

## 4. El candado de cierre (VL.3)

⚠️ **El criterio NO es "0 filas ausentes".** Ése era un error de este plan: el reconciliador encuentra
**42–167 huecos por ventana de 3 días y los repone todos**, de forma continua y en régimen normal.
Exigir cero es pedir un verde que no existe.

**Criterio real, contra el baseline de §1.4:**

| | |
|---|---|
| `huecos` | en el mismo rango que el baseline |
| `repuestas == huecos` | repone todo lo que encuentra |
| `errores` | 0 |
| clases de hueco | ninguna nueva |

---

## 5. Rollback

**Sólo es limpio de inmediato.** En cuanto el servidor nuevo confirma LSNs, los slots avanzan y volver
deja un **hueco**.

```bash
# en md
cd ~/ops/vl && docker compose stop ods-live-hot ods-live-mirror ods-reconcile
docker compose --profile db stop pg-ods
```
```sql
-- en .249, reactivar las 8
ALTER SUBSCRIPTION <nombre> ENABLE;
```
```powershell
docker compose -f ops/ingest/docker-compose.yml start ods-live-hot ods-live-mirror ods-reconcile
```

---

## 6. Lo que este corte NO resuelve

- **Wincaja sigue en `.249`** (3 carriles con Jet 32-bit sobre `Z:`) → VL.5. Su Postgres sigue arriba
  allá sólo para eso.
- **`.249` sigue arrancando Docker con el login del usuario.** El 2026-09-10 se reinició por Windows
  Update a las 23:05 y el motor no volvió hasta las 08:35 → **9.5 h sin ingesta**. Después de este
  corte eso deja de afectar al ODS, pero **sí sigue afectando a los ~13 carriles del Programador**
  hasta VL.4.
