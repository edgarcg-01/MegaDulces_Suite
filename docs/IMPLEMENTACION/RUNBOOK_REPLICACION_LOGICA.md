# Runbook — Replicación Lógica Nativa (Kepler → ODS realtime)

> **Objetivo.** Reemplazar el poll actual (`replicate-ods-fast.js` con watermark `ctid`, que **pierde los UPDATE in-place** en catálogos) por replicación lógica nativa de PostgreSQL: cada rama Kepler **publica** sus cambios, un subscriber local los recibe **al instante y sin perder UPDATEs**.
>
> **Estado verificado (2026-08-17):** las 6 ramas = **PostgreSQL 16.4**, `wal_level=replica`, `max_replication_slots=10`, `max_wal_senders=10`, `max_slot_wal_keep_size=-1` (**ilimitado ⚠**). Uniforme y moderno — soporta todo lo de abajo.

---

## 0-bis. Impacto en la lógica/uso de Kepler — VERIFICADO (2026-08-17)

Sondeo read-only a los 6 POS. Resultado: **la replicación lógica NO cambia nada de cómo funciona o consulta Kepler.** Evidencia:

| Qué se verificó | Resultado | Implicación |
|---|---|---|
| ¿Kepler ya usa replicación? (slots/standbys/publicaciones/subs) | **Ninguno, en las 6** | No pisamos nada de Kepler; nada que romper |
| `archive_mode` | **off** (6/6) | No hay archivado de WAL que se amplifique |
| ¿Las 11 tablas a publicar tienen PK? | **Sí, todas** (`replident=default`) | **CERO `ALTER TABLE`, cero locks, WAL mínimo** (UPDATE/DELETE por PK, no FULL) |
| Tamaño total a snapshotear | ~293 MB (kdm1 125MB + kdm2 168MB; resto en kB) | Copia inicial trivial, una vez |

**Lo que NO cambia (garantizado por diseño de PostgreSQL):** resultados de queries, semántica SQL, transacciones/aislamiento, constraints, triggers, planes de ejecución. `wal_level=logical` es **ortogonal** a la ejecución de queries — es un superset de `replica` que solo escribe más metadata al WAL. La app Kepler no ve ninguna diferencia.

**Lo único que sí cuesta:** (1) **un reinicio** por servidor para aplicar `wal_level=logical` (única indisponibilidad real, hacer en horario cerrado); (2) **más volumen de WAL** por escritura (modesto: identidad por PK, no FULL; `archive_mode=off` no lo amplifica); (3) el **riesgo de disco del slot** (mitigado con `max_slot_wal_keep_size`, §0.3); (4) CPU/IO menor del walsender.

**Lo que NO se puede verificar técnicamente (flags de negocio):** (a) **soporte/garantía del ERP** — tocar el `postgresql.conf` de Kepler puede violar términos de soporte; (b) **carga de escritura pico** — medí tamaños, no el WAL/seg en hora pico (con identidad por PK el overhead es acotado igual); (c) **un update futuro del ERP** podría resetear el `.conf` o recrear tablas (si dropea una tabla publicada, se quita sola de la publicación → esa tabla deja de replicar en silencio).

**Veredicto:** técnicamente es **seguro y transparente** para la operación de Kepler. El costo real es operativo (reinicios + administrar 6 servidores + el freno de disco), no de corrupción ni de cambio de comportamiento.

---

## 0. Tres frenos que decidir ANTES de tocar nada

1. **Son POS de terceros (Kepler).** Esto exige `postgresql.conf` + **reinicio** + `CREATE PUBLICATION` + posible `ALTER TABLE … REPLICA IDENTITY` sobre las tablas del ERP. Puede violar soporte, ser revertido por un update del ERP, o arriesgar el uptime de la caja. **El replicador actual solo usa `SELECT` (cero cambios, cero riesgo).** Confirmar que se pueden tocar estos servidores.
2. **Reinicio obligatorio.** `wal_level=logical` **solo aplica reiniciando** Postgres → ventana de downtime en **cada** caja.
3. **Riesgo de disco (el más grave).** Un slot de replicación **retiene WAL hasta que el subscriber lo consume**. Con `max_slot_wal_keep_size=-1` (hoy), si el subscriber se cae/atrasa el WAL **crece sin límite y llena el disco del POS → la caja se cae**. **Poner un tope es OBLIGATORIO** (abajo).

Si estos tres no están resueltos, la alternativa de bajo riesgo es **arreglar el `ctid` del replicador actual** (usar `xmin` o full-scan de catálogos) — mismo objetivo, sin tocar los POS.

---

## 1. Topología

```
6 ramas Kepler (LAN, publishers)          Subscriber LOCAL (LAN)             Railway
  md_00  192.168.9.95:5432   ──┐
  md_01  192.168.10.10:1977  ──┤          Postgres nuevo en .245/.249         prod
  md_02  192.168.42.42:5432  ──┼─logical→   6 DBs: kepler_md_00..05    →  (feeds-ingest push)
  md_03  192.168.40.40:5432  ──┤            normalizer → kepler_ods         kepler_ods / *
  md_04  192.168.44.44:5432  ──┤            (agrega `sucursal`)
  md_05  192.168.54.54:5432  ──┘
```

**El subscriber DEBE estar en la LAN** (Railway NO alcanza `192.168.x`). El push a Railway sigue siendo el hop-2 actual (`feeds-ingest`, ingress-free).

**Por qué 6 databases y no 1:** las 6 ramas publican con el **mismo nombre calificado** `md.kdii`, `md.kdil`, … La replicación lógica **nativa mapea por nombre exacto y NO remapea schema**. Seis fuentes `md.kdii` no caben en un solo `md.kdii` (colisión de PK entre plazas). Solución core = **una database por rama** en el subscriber. (Si se quiere UNA sola DB con remap/filtro, eso es **`pglogical`** — extensión, ya no "nativa"; ver §6.)

---

## 2. EN CADA SERVIDOR KEPLER (publisher) — repetir ×6

### 2.1 `postgresql.conf`
```conf
wal_level = logical                 # ← el cambio que exige REINICIO
max_slot_wal_keep_size = '20GB'      # ← TOPE OBLIGATORIO (ajustar al disco libre). Si el slot
                                     #    excede esto, se invalida (el subscriber re-sincroniza)
                                     #    en vez de llenar el disco y tumbar la caja.
# max_replication_slots = 10  → ya está OK (necesitamos 1 por subscriber)
# max_wal_senders      = 10  → ya está OK
```
Luego **reiniciar** el servicio Postgres de esa caja (ventana de downtime).

### 2.2 Rol de replicación (SQL, una vez por rama)
```sql
CREATE ROLE ods_repl WITH REPLICATION LOGIN PASSWORD '<secreto-por-rama>';
GRANT USAGE ON SCHEMA md TO ods_repl;
GRANT SELECT ON ALL TABLES IN SCHEMA md TO ods_repl;
ALTER DEFAULT PRIVILEGES IN SCHEMA md GRANT SELECT ON TABLES TO ods_repl;  -- para tablas kdc2YYMM futuras
```

### 2.3 Publicación — SOLO las tablas que espejamos (no `FOR ALL TABLES`)
```sql
CREATE PUBLICATION ods_pub FOR TABLE
  md.kdii,          -- productos (catálogo — el que perdía UPDATEs)
  md.kdil,          -- existencia
  md.kdik,          -- costo
  md.kdud,          -- clientes
  md.kdm1, md.kdm2, -- movimientos
  md.kdig,          -- líneas/marcas
  md.kdco,          -- catálogo de cuentas
  md.kdm_rutas, md.kdm_transporte, md.kdm_chofer;
-- Las kdc2YYMM (pólizas) rotan por mes; si se quieren, agregarlas con
-- ALTER PUBLICATION ods_pub ADD TABLE md.kdc2YYMM;  (o publicar por schema en PG15+:
-- CREATE PUBLICATION ... FOR TABLES IN SCHEMA md;   ← incluye TODO md.* automáticamente)
```

### 2.4 REPLICA IDENTITY — ✅ VERIFICADO: no hace falta tocar nada
La replicación lógica necesita identificar la fila a UPDATE/DELETE. Default = **PK**. Si no hay PK, habría que hacer `ALTER TABLE … REPLICA IDENTITY FULL` (infla WAL + toma un lock).
**Verificado 2026-08-17 en md_00: las 11 tablas a publicar TIENEN PK** (`relreplident=default`). → **CERO `ALTER TABLE`, cero locks, cero inflado de WAL por FULL.** UPDATE/DELETE se replican por PK (mínimo overhead). Re-verificar con el diag si se agregan tablas nuevas a la publicación.

### 2.5 `pg_hba.conf` — permitir al subscriber
```conf
# logical replication conecta a la DB REAL (no al pseudo-db 'replication', que es solo físico)
host   md_00   ods_repl   <IP_DEL_SUBSCRIBER>/32   scram-sha-256
```
`SELECT pg_reload_conf();` (no requiere reinicio).

---

## 3. EN EL SERVIDOR SUBSCRIBER (LAN, .245/.249)

### 3.1 `postgresql.conf`
```conf
max_worker_processes = 16                  # ≥ workers de repl + otros bg
max_logical_replication_workers = 8        # ≥ nº de subscriptions (6) + apply
max_sync_workers_per_subscription = 2
```
Reiniciar el subscriber (una sola vez, es nuestro, sin impacto POS).

### 3.2 Una database + subscription por rama (×6)
```sql
CREATE DATABASE kepler_md_00;
\c kepler_md_00
CREATE SCHEMA md;
-- crear las tablas destino con la MISMA estructura que el publisher.
-- La forma limpia: pg_dump --schema-only de la rama y aplicarlo aquí:
--   pg_dump -h 192.168.9.95 -U platform_ro -d md_00 -n md --schema-only > md_00.sql
--   psql -d kepler_md_00 -f md_00.sql
CREATE SUBSCRIPTION sub_md_00
  CONNECTION 'host=192.168.9.95 port=5432 dbname=md_00 user=ods_repl password=<secreto>'
  PUBLICATION ods_pub;
-- repetir para 01 (port 1977!), 02, 03, 04, 05 con su host/db.
```
`CREATE SUBSCRIPTION` hace una **COPIA inicial** de todas las filas (pesado en `kdm1/kdm2`). Para tablas enormes se puede diferir con `WITH (copy_data = false)` y sembrar a mano una vez.

### 3.3 Normalizer live — ✅ IMPLEMENTADO (`replicate-ods-live.js`, 2026-08-17)

`database/importers/kepler/replicate-ods-live.js` (evoluciona `replicate-ods-fast.js`, que sigue intacto). En vez de pollear las ramas **remotas** por `ctid` (carga el POS y **pierde los UPDATE in-place** de catálogos), lee los **replicas lógicos LOCALES** (`kepler_md_XX` en `pgvector-md :5433`, siempre al día) con **dos carriles**:

- **Carril `ctid`** (grandes append-only: `kdm1,kdm2,kdij,kdue,kdpord`): como en origen no hay UPDATE/DELETE, el `ctid` es monótono → Tid Range Scan barato, sin pérdida.
- **Carril `hash-delta`** (catálogos chicos mutables: `kdii,kdil,kdik,kdig,kdid,kduv,kdud,kdm_rutas,kdm_transporte,kdm_chofer`): full-scan LOCAL + `md5(fila)` contra un **shadow local** (`ods.shadow`) → shipea **solo las filas cuyo hash cambió**. Captura todo UPDATE; el egress = solo el delta real.

Estado co-locado en cada replica (schema `ods`: `ctl` watermark + `shadow` hashes) → no depende de `.245`, no colisiona con `kp.ods_fast_control` del normalizer remoto. El ship es **idéntico** (handler `raw-upsert`, UPSERT sin churn, `sucursal` agregada) → **el destino prod `kepler_ods` no cambia**, y el hop-2 (`feeds-ingest` → Railway) tampoco.

Config por env: `ODS_HASH_TABLES` (carril hash), `ODS_LIVE_BRANCHES` (default `01,02,03,04,05,06`; **CEDIS 00 NO está en replicación lógica** → se queda en su feed actual), `KP_DEST_URL` (solo modo pg on-prem/test). Flags: `--apply`, `--watch[=seg]`, `--prime` (fija watermark ctid al máx sin shipear), `--branch=`, `--tables=`, `--full`.

Verificado local **sin tocar prod** (2026-08-17): ruteo de carriles, hash-delta (detecta UPDATE/nuevo/sin-cambio), pipeline `--apply` end-to-end ambos carriles vía el handler real (auto-create `kepler_ods.<tabla>` + UPSERT + `_sync_status` + shadow). Estado de prueba limpiado.

### 3.4 CUTOVER a prod — comandos exactos (los corre Edgar; escriben a prod)

El normalizer remoto viejo tiene prod al día en **movimientos** de 01-05 (append-only, no se pierden) pero **stale en catálogos** (los UPDATE perdidos) y **sin nada de Canindo 06** (el viejo no lee md_06). Estrategia: **primar** el ctid de 01-05 (no re-shipear millones), **re-shipear catálogos una vez** (corrige stale), **sembrar 06 completo**.

Todos con las creds de prod (`FEEDS_SINK=http` + `FEEDS_INGEST_URL` + `FEEDS_INGEST_KEY` — salen de `C:\KeplerRunner\run-feeds.cmd`, NO hardcodear):

```bash
# 1) PRIME solo 01-05 (fija watermark de movimientos al presente; NO 06).
ODS_LIVE_BRANCHES=01,02,03,04,05 node database/importers/kepler/replicate-ods-live.js --prime

# 2) Canary: una tabla chica de Canindo a prod. Verificar en kepler_ods._sync_status.
FEEDS_SINK=http node database/importers/kepler/replicate-ods-live.js --branch=06 --tables=kdm_chofer --apply

# 3) Primer barrido completo (siembra catálogos corregidos 01-06 + movimientos nuevos + Canindo).
FEEDS_SINK=http node database/importers/kepler/replicate-ods-live.js --apply

# 4) Modo vivo (loop cada 10s). Reemplaza al normalizer remoto en el Task Scheduler de .249.
FEEDS_SINK=http node database/importers/kepler/replicate-ods-live.js --apply --watch=10
```

**Al cortar:** apagar/deshabilitar la tarea del `replicate-ods-fast.js` remoto **para 01-06** (evitar doble-ship). Si CEDIS 00 hoy sale de ese normalizer remoto, dejarlo corriendo **solo** `--branch=00` (o confirmar que 00 entra por el importer de Access). Rollback = volver a la tarea vieja (el live no borra ni migra nada; su estado `ods.*` es local y descartable).

---

## 4. Verificación

```sql
-- en el PUBLISHER (cada rama):
SELECT slot_name, active, wal_status,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retenido
  FROM pg_replication_slots;                 -- 'retenido' NO debe acercarse a max_slot_wal_keep_size
SELECT * FROM pg_stat_replication;           -- state=streaming

-- en el SUBSCRIBER:
SELECT subname, received_lsn, latest_end_lsn FROM pg_stat_subscription;   -- lag ~0
```
Prueba viva: cambiar un precio en Kepler (`kdii.c90`) y ver que llega al subscriber en <1-2 s.

---

## 5. Rollback
```sql
-- subscriber:
DROP SUBSCRIPTION sub_md_00;     -- esto libera el slot en el publisher (si hay conexión)
-- publisher (si el subscriber ya no existe, limpiar el slot huérfano a mano):
SELECT pg_drop_replication_slot('<slot>');   -- ← IMPORTANTE: un slot huérfano sigue reteniendo WAL
DROP PUBLICATION ods_pub;
-- revertir wal_level=replica en postgresql.conf + reiniciar (si se quiere deshacer del todo).
```

---

## 6. Alternativa: `pglogical` (si no se quieren 6 databases)
`pglogical` (extensión de 2ª gen) **sí** permite remapear schema y **filtrar filas**, así las 6 ramas caben en **una sola DB** con `md_00.*`, `md_01.*`… y hasta inyectar `sucursal`. Costo: instalar la extensión en los 6 POS (otro cambio en servidores de terceros). No es "nativa".

---

## 7. Recomendación honesta
La replicación lógica nativa resuelve la pérdida de UPDATEs, **pero** el precio es: reinicios en cajas de terceros + `ALTER REPLICA IDENTITY` en tablas del ERP + el riesgo permanente de slot-que-llena-disco + un subscriber nuevo con 6 databases + normalizer. Para un solo síntoma (los UPDATE in-place de catálogos que el `ctid` pierde), **arreglar el watermark del replicador actual** (cambiar `ctid` → `xmin`, o full-scan nocturno de los ~4 catálogos chicos) logra lo mismo **sin tocar los POS**. Native repl vale la pena si se quiere realtime de verdad en TODAS las tablas (incl. `kdm1/kdm2`) y el equipo puede administrar los 6 servidores con seguridad.
```
