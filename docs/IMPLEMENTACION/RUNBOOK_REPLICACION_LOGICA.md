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

Config por env: `ODS_HASH_TABLES` (carril hash), `ODS_LIVE_BRANCHES` (default `00,01,02,03,04,05,06` — **CEDIS/oficinas 00 SÍ está en replicación lógica desde 2026-08-20** (§8); su kdm1/kdm2 fluyen, pero sus tablas de FINANZAS necesitan estar en `KP_ODS_TABLES` — ver §8.E), `KP_DEST_URL` (solo modo pg on-prem/test). Flags: `--apply`, `--watch[=seg]`, `--prime` (fija watermark ctid al máx sin shipear), `--branch=`, `--tables=`, `--full`.

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

---

## 8. Sucursal 00 (oficinas / CEDIS-finanzas @192.168.9.95) — activación 2026-08-20

**Por qué faltaba.** La 00 estaba en la topología (§1) y fue la rama que se VERIFICÓ lista (§2.4), pero se **excluyó del rollout** por una creencia — "su Postgres solo tiene pruebas". **Desmentido 2026-08-20:** `md_00@9.95` tiene **107k filas actuales** y la **conciliación de finanzas depende de él** (es el Kepler vivo de oficinas; el CEDIS-almacén sobre Access es Fase CA, aparte). Síntoma que lo destapó: el movimiento `X-D-26` folio `0017742` (12-ago) estaba en el source pero NO en `kepler_ods` (el ODS suc-00 congelado en folio `0017736`/18-ago) → las vistas derive-no-copy (`erp_supplier_payments`, `kepler_bank_movements`) salían stale para 00. Decisión de Edgar: **todo debe vivir en el ODS** → la 00 entra con réplica lógica propia (no el parche remoto).

**Readiness re-verificado 2026-08-20 (`md_00@9.95`):** PG **16.4** · `wal_level=replica` (⚠ **exige RESTART**) · `max_replication_slots=10`/`max_wal_senders=10` (OK) · `max_slot_wal_keep_size=-1` (⚠ **poner tope**) · `archive_mode=off` · **0 slots/pubs/walsenders** (limpio) · **las 11 tablas a publicar TIENEN PK** (cero `ALTER TABLE`) · copia inicial `kdm2 170MB + kdm1 129MB` (~300MB, trivial).

### 8.A En el POS @9.95 (lo hace Edgar — superuser + OS)
```conf
# postgresql.conf:
wal_level = logical
max_slot_wal_keep_size = '20GB'     # ← OBLIGATORIO (hoy -1=ilimitado → riesgo de llenar disco)
```
→ **RESTART** del servicio Postgres de 9.95 (única indisponibilidad; horario cerrado).
```sql
CREATE ROLE ods_repl WITH REPLICATION LOGIN PASSWORD '<secreto-00>';
GRANT USAGE ON SCHEMA md TO ods_repl;
GRANT SELECT ON ALL TABLES IN SCHEMA md TO ods_repl;
ALTER DEFAULT PRIVILEGES IN SCHEMA md GRANT SELECT ON TABLES TO ods_repl;
CREATE PUBLICATION ods_pub FOR TABLES IN SCHEMA md;   -- mirror completo (como las otras ramas)
```
```conf
# pg_hba.conf (recargar con SELECT pg_reload_conf(); NO requiere restart):
host   md_00   ods_repl   <IP_DEL_SUBSCRIBER>/32   scram-sha-256
```

### 8.B En el subscriber @:5433 (pgvector-md) — ✅ DB + DDL YA HECHOS 2026-08-20
`setup-branch-subscriber.js --branch=00 --apply` creó **`kepler_md_00` + 348 tablas VACÍAS** (DDL clonado por
introspección `format_type`+PK; `pg_dump` no está en PATH → se usa el script, reusable para futuras ramas).
Verificado: md_00 = **348 tablas, TODAS con PK** → full-schema logical replication segura. El nombre `kepler_md_00`
es obligatorio (`localDbName('00')`). **Falta SOLO** (tras el POS §8.A):
```bash
psql -p 5433 -d kepler_md_00 -c "CREATE SUBSCRIPTION sub_md_00 \
  CONNECTION 'host=192.168.9.95 port=5432 dbname=md_00 user=ods_repl password=<secreto-00>' \
  PUBLICATION ods_pub"                                  # dispara la COPIA inicial (~300MB); luego streaming
```
Rerun de `setup-branch-subscriber.js` es idempotente (reusa la DB, salta tablas existentes).

### 8.E SHIP de las tablas de finanzas a prod (`kepler_ods`)
La subscription trae las 348 tablas de 00 al **replica local** `kepler_md_00`. Pero `replicate-ods-live` (OdsLiveLoop)
solo **shippea a prod** las tablas de `KP_ODS_TABLES` (hoy 11 en el launcher) → las de finanzas (`kdc2*` pólizas,
`kdco`, `kdc3`, `kdpv_folio_caja`) NO llegan a prod `kepler_ods`. **Medido 2026-08-20:** un espejo COMPLETO
(`--tables=*`, 348 tablas) tarda <100s/rama → ×6 = ~10min/ciclo, **NO meterlo en el loop caliente** (degradaría la
frescura @10s de venta/stock).

**Solución recomendada (2026-08-20) — glob en el set del loop caliente, SIN nueva tarea ni full-mirror:** las tablas de
finanzas son CHICAS (kdco 371 / kdpv_folio_caja 916 / kdc2YYMM ~611 filas) → sumarlas al hot loop es barato. Se agregó
**soporte de patrón `*`** en `replicate-ods-live` (`KP_ODS_TABLES`/`ODS_HASH_TABLES`): `kdc2*` expande a todas las
pólizas mensuales por-rama y **auto-cubre la rotación** de `kdc2YYMM`. En `run-ods-live-loop.cmd` (Edgar):
```bat
set "KP_ODS_TABLES=kdm1,kdm2,kdij,kdue,kdii,kdil,kdik,kdig,kdib,kdid,kduv,kdud,kdb1,kdco,kdc3,kdpv_folio_caja,kdxd,kdxe,kdc2*"
set "ODS_HASH_TABLES=kdii,kdil,kdik,kdig,kdid,kduv,kdud,kdb1,kdm_rutas,kdm_transporte,kdm_chofer,kdco,kdc3,kdpv_folio_caja,kdxd,kdxe,kdc2*"
```
> ⚠️ **CORRECCIÓN 2026-08-21 — `kdb1` faltaba en `KP_ODS_TABLES`** (estaba solo en `ODS_HASH_TABLES`, que es un
> SUBSET-filtro de la lista maestra → nunca embarcaba). El launcher real medido 2026-08-21 traía solo 11 tablas
> (`…,kdib,kdid,kduv`), sin ninguna de finanzas. **Efecto medido en prod:** `kepler_ods` para **sucursal 00** tenía
> **0 filas** en kdb1/kdco/kdc3/kdpv_folio_caja/kdxd/kdxe/kdc2* → `import-kepler-bank-movements` (conciliación CB, lee
> `kepler_ods.kdb1 WHERE sucursal='00'`) hacía **SKIP silencioso** (guard sin escribir). Regla: una tabla debe estar en
> `KP_ODS_TABLES` (lista maestra) para embarcar; `ODS_HASH_TABLES` solo decide el CARRIL (hash vs ctid) de las que YA
> están en la maestra. Se agregaron kdb1/kdxd/kdxe/kdud a la maestra. **Tras editar el launcher: reiniciar el loop ODS.**

Verificado (dry-run branch 03): `kdc2*` → kdc22501…kdc22608… todas ruteadas **hash** (mutable-safe). Steady-state el
hash-delta shippea solo el delta (≈0) → costo despreciable. (Si algún día se quiere el espejo COMPLETO real, `KP_ODS_TABLES=*`
en una **tarea separada** `--watch=300`, no en el loop caliente.)

### 8.C Código — ✅ YA HECHO
`ODS_LIVE_BRANCHES` default ahora `00,01,02,03,04,05,06` (replicate-ods-live.js). Hasta que exista `kepler_md_00` el ciclo la **salta** (`⚠ replica 00: no conecta — skip`, inofensivo); al crear la subscription **se activa sola** — sin tocar el launcher `run-ods-live-loop.cmd` (no setea `ODS_LIVE_BRANCHES`).

### 8.D Verificación
```sql
-- publisher 9.95:  slot activo, retenido chico, streaming
SELECT slot_name, active, wal_status, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) retenido FROM pg_replication_slots;
-- subscriber :5433: lag ~0
SELECT subname, received_lsn, latest_end_lsn FROM pg_stat_subscription WHERE subname='sub_md_00';
```
**Prueba de negocio:** en `kepler_ods.kdm1 WHERE sucursal='00'` el máx folio `X-D-26` debe pasar de `0017736` → aparecer `0017742` (el movimiento que la conciliación marcaba faltante). Rollback = `DROP SUBSCRIPTION sub_md_00` + limpiar slot en 9.95 (§5); el código soporta 00 ausente (skip).

---

## 9. Morelia Madero (Wincaja `32`) — alta pendiente, medida el 2026-09-08

Madero **ya cambió su punto de venta a Kepler**. Nada de nuestro lado está cableado todavía, y esto
es el estado exacto, medido, no supuesto:

| | |
|---|---|
| `wincaja.branches` para `32` | `kepler_code = NULL`, `status = live_on_wincaja` |
| Sucursales en `kepler_ods.kdm1` | `00, 01, 02, 03, 04, 05, 06` — **no hay una nueva** |
| Réplica local | **no existe** `kepler_md_07` (sólo `00`–`06` en `:5433`) |
| Suscripción | **no existe** (hay 7: `sub_md_00,01,02,04,05,06` + `sub_pilot`→`md_03`) |
| `192.168.32.32` puertos 5432 y 1977 | **sin respuesta TCP** |
| `commercial.warehouses` | sigue como `MD-32` "Almacén Morelia Madero (32)" |
| Réplica cruda Wincaja `w32` | **todavía con movimiento** — último 06/09/2026 |

### 9.1 Lo que NO se puede derivar y hay que confirmar antes de tocar

Dos datos, y de los dos cuelga el sell-out:

1. **El código de sucursal con el que Kepler va a emitir su venta** (el valor de `md.kdm1.sucursal`).
   Canindo tomó `06`; lo natural sería `07`, pero **eso es una suposición** y si sale mal el sell-out
   suma la venta a la sucursal equivocada. El verificador lo imprime en cuanto haya acceso:
   `SELECT DISTINCT sucursal FROM md.kdm1`.
2. **Host y puerto del POS.** El patrón de infra se cumple en 6 de 6 ramas —
   `192.168.<código Wincaja>.<código Wincaja>` (10→.10.10 · 40→.40.40 · 42→.42.42 · 44→.44.44 ·
   50→.50.50 · 54→.54.54)— así que Madero debería ser **`192.168.32.32`**. El puerto NO es uniforme:
   `01` y `06` escuchan en **1977**, el resto en 5432. Hoy no responde ninguno de los dos.

### 9.1-bis Lo que se midió EN el POS (pgAdmin, 2026-09-08)

Corriendo la consulta del Paso 1 en el propio POS. Cambia el trabajo: **casi todo está ya puesto**
y sólo faltan dos parámetros, los dos en `postgresql.conf`.

| parámetro | valor en el POS | veredicto |
|---|---|---|
| `version` | PostgreSQL **16.4** | igual que los POS `02`/`03` |
| `config_file` / `hba_file` | `C:/Program Files/PostgreSQL/16/data/` | instalación estándar |
| `listen_addresses` | `*` | **ya expone la LAN** — no tocar |
| `max_replication_slots` / `max_wal_senders` | `10` / `10` | ya OK |
| `password_encryption` | `scram-sha-256` | → en `pg_hba` va `scram-sha-256` |
| `port` | **1977** | como la `01` y la `06`, **no** 5432 |
| `ssl` | `off` | sin `sslmode` en la conninfo |
| `wal_level` | **`replica`** | ⚠️ falta `logical` — **exige reiniciar** |
| `max_slot_wal_keep_size` | **`-1`** | ⚠️ falta el tope (ver abajo) |

**El `-1` es el hallazgo que importa.** Es el default de Postgres y significa retención de WAL
**ilimitada**: si el suscriptor se cae un fin de semana, el POS acumula WAL hasta **llenar el disco
y tumbar la caja**. Los POS `02` y `03` tienen `20480` (20 GB) puesto a mano — este nunca se
preparó. Va junto con `wal_level` en la misma edición.

**Y `listen_addresses` ya está en `*`**, así que el motivo de que `192.168.32.32` no responda ni en
5432 ni en 1977 se reduce a dos: el **firewall de Windows** del POS, o que la máquina no esté en esa
IP. Se resuelve con un `ipconfig` en el POS — no con más suposiciones sobre el patrón de IP.

**La base es `md_07`** (confirmado 2026-09-08). Eso hace muy probable que el código de sucursal
sea `07` —Canindo es `md_06` → sucursal `06`— pero **el nombre de la base no es el código**: el
valor real es lo que traiga `SELECT DISTINCT sucursal FROM md.kdm1`, y el verificador lo imprime
en cuanto haya acceso. De ese código cuelgan el sell-out y el corte con Wincaja, así que se
confirma antes de registrar la rama, no después.

⚠️ **Lo único que falta para poder llegar: la IP del POS.** `192.168.32.32` no responde ni en 5432
ni en 1977, y `listen_addresses` ya es `*`, así que es el firewall de Windows del POS o una IP
distinta. No está en el repo: las IPs de los POS viven en la conninfo de cada suscripción
(`SELECT subconninfo FROM pg_subscription;` en `:5433`), y la de Canindo tampoco figura en el
código. Se resuelve con un `ipconfig` en el POS.

### 9.2 En el POS de Madero (lo corre quien tenga superusuario allá)

Todo el alta de base está en un script idempotente que **calca lo que ya corre en los POS `02` y
`03`** (leído de sus catálogos, no inventado):

```
psql -U postgres -d md_07 -f database/scripts/kepler-pos-alta-ods.sql
```

Crea `platform_ro` (SELECT) y `ods_repl` (REPLICATION), los grants, los *default privileges* para las
tablas que Kepler cree mañana, y la publicación. Pide las contraseñas por prompt para no dejarlas en
el archivo; la de `ods_repl` **tiene que ser la misma que las otras ramas** —
`SELECT subconninfo FROM pg_subscription;` en `:5433` la muestra.

Lo que el script **no puede hacer** porque son archivos del sistema operativo:

```conf
# postgresql.conf  — los dos primeros EXIGEN REINICIAR el servicio
wal_level = logical
listen_addresses = '*'                 # los 7 POS ya cableados usan '*'
max_slot_wal_keep_size = '20GB'         # tope: si el slot lo excede se invalida en vez de
                                        # llenar el disco y tumbar la caja
# max_replication_slots = 10            # ya viene así en Kepler 16.4
# max_wal_senders       = 10
```

```conf
# pg_hba.conf — DOS renglones, y el segundo se olvida siempre.
# La replicación lógica conecta a la DB REAL, no al pseudo-db 'replication'.
host    md_07    ods_repl       192.168.0.249/32    scram-sha-256
host    md_07    platform_ro    192.168.0.249/32    scram-sha-256
```
`SELECT pg_reload_conf();` alcanza para `pg_hba` (no requiere reinicio).

`192.168.0.249` es este servidor, el que hospeda las réplicas. Si tras recargar el verificador sigue
diciendo *"no pg_hba entry"*, el log del POS nombra la IP de origen real (el contenedor puede salir
con NAT distinto): usar ésa, no ampliar a `/24` a ciegas.

Y el firewall de Windows del POS tiene que dejar entrar ese puerto — es la causa más probable de que
hoy `192.168.32.32` no responda ni en 5432 ni en 1977.

### 9.3 Comprobar desde acá, antes de seguir

```
node database/scripts/verificar-pos-kepler.js --host=<IP_DEL_POS> --port=1977 --db=md_07
```

Ocho comprobaciones en el orden en que fallan de verdad: puerto → autenticación de `platform_ro` →
`ods_repl` con REPLICATION → `wal_level` → capacidad de slots → publicación → una lectura real de
`md.kdm1` → identidad de fila. Cada falla dice qué archivo tocar.

**Se probó contra las dos puntas:** `--branch=02` da **8 OK / 0 FALTA** (o sea mide algo de verdad) y
Madero da **0 OK / 1 FALTA** en el primer paso. Corre desde este servidor a propósito: un `psql`
lanzado en el propio POS da `listen_addresses`, firewall y `pg_hba` por buenos y no prueba nada.

### 9.4 De este lado, una vez que el verificador esté verde

1. **Réplica + suscripción** — §3.2 de este runbook, o `setup-branch-subscriber.js`. El nombre de la
   base sigue la convención `kepler_md_07` y el slot `sub_md_07`.
2. **Registrar la rama** en `database/importers/lib/kepler-branches.js` (`BRANCHES`), que es la fuente
   única: agregarla ahí la habilita en ~40 importers de una vez. Si no expone `platform_ro` remoto
   —el caso de Canindo— se marca con `replica: 'kepler_md_07'` y se lee del espejo local.
3. **Carril del ODS**: sumarla a `replicate-ods-live.js` para que `ods_live_hot`/`ods_live_mirror` la
   shipeen, y confirmar que aparece en `kepler_ods._sync_status`.
4. **`wincaja.branches`**: para `32`, poner `kepler_code`, `status`, y `last_movement_date` = el
   último día que de verdad vendió en Wincaja. Esa columna no es decorativa: los sensores de
   `db-health` derivan las sucursales a vigilar de `kepler_code IS NULL`, así que en cuanto se llene,
   Madero deja de alarmar por un `.mdb` que ya no se mueve. Es la lección de Canindo: una alerta que
   nunca se puede apagar entrena al equipo a ignorar el tablero.
5. **`commercial.warehouses`**: Canindo pasó de `MD-50` a código `06`. Antes de repetirlo hay que ver
   qué le pasó al histórico que apuntaba a `MD-50` (stock, ventas, políticas de reorden) — renombrar
   el `code` de un almacén con historia no es gratis.
6. **Sacar `32` del carril vivo de Wincaja** (`wincaja-replica-config.js`), como se hizo con Canindo:
   su `.mdb` deja de moverse y el carril quedaría girando en vacío. El histórico `h32` se queda: es
   la única copia de lo que Madero vendió en Wincaja.
7. **El corte del sell-out — la parte peligrosa.** `v_sellout_daily` combina Kepler y Wincaja con un
   literal de corte por sucursal; Madero necesita el suyo, con la fecha real del cambio. Un corte mal
   puesto **duplica** la venta del día (los dos lados la traen) o le abre un **hueco** (ninguno). El
   candado `test-newdb-sellout-parity.js` mide exactamente esas dos cosas: correrlo **antes y después**
   del cambio, y comparar el mes contra su total ya conocido.

### 9.5 Corrección a §2.3 de este runbook

§2.3 documenta `CREATE PUBLICATION ods_pub FOR TABLE <lista de 11 tablas>`. **Los POS reales no están
así.** Medido el 2026-09-08 en `02` y `03`: la publicación se llama **`ods_pub_pilot`** y está
declarada **`FOR TABLES IN SCHEMA md`** — cubre **336 de 336** tablas, y una tabla nueva de Kepler
(las `kdc2YYMM` rotan cada mes) entra al pipeline sola. La única excepción es `md_00`, que quedó con
el nombre viejo `ods_pub`. Seguir §2.3 al pie crearía una publicación con 11 tablas y un nombre que el
suscriptor no espera. La forma vigente es la que aplica `kepler-pos-alta-ods.sql`.

### 9.6 Paso a paso, para quien se sienta en el POS

Pensado para hacerse una sola vez, en orden. Los valores no son sugerencias: son los que corren hoy
en los POS `02` y `03`, medidos el 2026-09-08 (`password_encryption = scram-sha-256` · `ssl = off` ·
`wal_level = logical` · `listen_addresses = *` · `max_slot_wal_keep_size = 20480`).

#### Antes de empezar — tres datos

1. La contraseña del **superusuario** del Kepler de ese POS (`postgres` o `sa`).
2. La contraseña de **`ods_repl`**, que tiene que ser **la misma que las otras sucursales**.

   **No está documentada en ningún archivo, y está bien así** (medido el 2026-09-08: 0 valores
   reales en el repo ni en el runner; los 8 sitios que la mencionan usan placeholders). Su único
   lugar de residencia es `pg_subscription.subconninfo` en el contenedor `:5433` — o sea que **no
   hay que recordarla**: se reconstruye. Las 7 suscripciones comparten una sola.

   La forma de recuperarla **sin que pase por un chat, un ticket ni un archivo**: que la propia
   consulta te devuelva la sentencia ya armada, y copiás esa celda al POS.

   ```sql
   -- en pgAdmin, conectado a localhost:5433 / base "postgres", como postgres
   SELECT 'ALTER ROLE ods_repl PASSWORD ' || quote_literal(
            (regexp_match(subconninfo, 'password=([^ ]+)'))[1]) || ';' AS correr_en_el_pos
     FROM pg_subscription WHERE subname = 'sub_md_02';
   ```

   Devuelve una celda tipo `ALTER ROLE ods_repl PASSWORD '…';` que se pega tal cual en el Query
   Tool del POS. Después **cerrá la pestaña en los dos lados**: pgAdmin guarda el historial de
   consultas y ahí quedaría en claro.

   ⚠️ **Por qué importa que sea la misma y no una nueva:** si el POS queda con otra, el
   `CREATE SUBSCRIPTION` **no falla — REINTENTA**, así que se ve como un cuelgue y no como un
   error de autenticación. Vivido con Madero el 2026-09-08: el verificador daba 8 OK, el rol
   existía con `REPLICATION`, el `pg_hba` estaba bien, y la suscripción nunca se creó. Lo que lo
   destapó fue abrir una conexión de replicación de verdad (comprobación 9 del verificador).
3. El **nombre de la base**: para Madero es `md_07` (confirmado 2026-09-08).
   Si no se sabe: en pgAdmin, al conectarse al POS, el árbol *Databases* la muestra.

---

#### Paso 1 — Ubicar los archivos de configuración (no adivinar la ruta)

En **pgAdmin**, conectado al POS **como superusuario**: botón derecho en la base → *Query Tool* →

⚠️ **No pongas varios `SHOW` seguidos**: el Query Tool de pgAdmin muestra sólo el resultado
del ÚLTIMO statement, así que cuatro `SHOW` devuelven nada más `version()`. Va en una sola
consulta, y de paso trae todo lo que hace falta más adelante:

```sql
SELECT name AS parametro, setting AS valor, context AS "para_cambiarlo"
  FROM pg_settings
 WHERE name IN ('config_file','hba_file','data_directory','port','listen_addresses',
                'wal_level','password_encryption','max_replication_slots',
                'max_wal_senders','max_slot_wal_keep_size','ssl')
UNION ALL
SELECT 'version', split_part(version(), ' on ', 1), ''
 ORDER BY 1;
```

Cómo leerlo:

| parámetro | qué esperás | si no |
|---|---|---|
| `config_file` · `hba_file` | las rutas reales a editar | vacío = no estás como superusuario |
| `wal_level` | `logical` | `context = postmaster` → reinicio |
| `listen_addresses` | `*` | `context = postmaster` → reinicio |
| `password_encryption` | `scram-sha-256` | si dice `md5`, en `pg_hba` va `md5` |
| `max_slot_wal_keep_size` | `20480` (= 20 GB) | `context = sighup` → alcanza reload |
| `max_replication_slots` / `max_wal_senders` | `10` / `10` | `postmaster` → reinicio |

La columna `para_cambiarlo` (`context`) dice si hace falta **reiniciar** el servicio o basta
`SELECT pg_reload_conf();` — no se adivina, la dice Postgres.

Por línea de comandos es lo mismo:
```bat
"C:\Program Files\PostgreSQL\16\bin\psql.exe" -U postgres -c "SHOW config_file;"
```

> Estas tres sólo las ve un superusuario. Si salen vacías, no estás conectado como `postgres`/`sa`.

---

#### Paso 2 — Crear los roles y la publicación

**Opción A (recomendada) — con `psql`,** que es como está escrito el script:

```bat
cd /d C:\ruta\donde\copiaste\el\script
"C:\Program Files\PostgreSQL\16\bin\psql.exe" -U postgres -d md_07 -f kepler-pos-alta-ods.sql
```

Va a pedir las dos contraseñas por prompt. Al terminar imprime el estado; si algo sale en `0` o en
`false`, la rama **no** está lista aunque no haya habido error.

**Opción B — desde pgAdmin.** ⚠️ El *Query Tool* de pgAdmin **no entiende** `\gset`, `\if` ni
`\prompt` (son de `psql`), así que el script tal cual **no corre ahí**. Pegá este equivalente,
reemplazando las dos contraseñas y `md_07`:

```sql
-- 1) Los dos roles. Propósitos distintos, a propósito:
--    platform_ro = SELECT para los importers · ods_repl = replicación para la suscripción.
CREATE ROLE platform_ro LOGIN PASSWORD 'PONER_LA_DE_LECTURA';
CREATE ROLE ods_repl    LOGIN REPLICATION PASSWORD 'PONER_LA_DE_REPLICACION';

-- 2) Lectura del schema de Kepler. ods_repl también la necesita: la sincronización inicial
--    de la replicación lógica LEE las tablas, no sólo el WAL.
GRANT CONNECT ON DATABASE md_07 TO platform_ro, ods_repl;
GRANT USAGE ON SCHEMA md TO platform_ro, ods_repl;
GRANT SELECT ON ALL TABLES    IN SCHEMA md TO platform_ro, ods_repl;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA md TO platform_ro, ods_repl;

-- 3) Y para las tablas que Kepler cree MAÑANA (las pólizas kdc2YYMM rotan cada mes).
--    Sin esto, la tabla nueva entra a la publicación pero no se puede leer → la rama se rompe
--    con "permission denied" y el slot se queda atrás acumulando WAL.
ALTER DEFAULT PRIVILEGES FOR ROLE sa       IN SCHEMA md GRANT SELECT ON TABLES TO platform_ro, ods_repl;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA md GRANT SELECT ON TABLES TO platform_ro, ods_repl;

-- 4) La publicación. FOR TABLES IN SCHEMA (no lista de tablas, no FOR ALL TABLES).
CREATE PUBLICATION ods_pub_pilot FOR TABLES IN SCHEMA md;
```

Y comprobá en el mismo Query Tool:
```sql
SELECT rolname, rolcanlogin, rolreplication FROM pg_roles
 WHERE rolname IN ('platform_ro','ods_repl');
SELECT pubname, (SELECT count(*) FROM pg_publication_tables t WHERE t.pubname=p.pubname) tablas
  FROM pg_publication p;
```
`ods_repl` **tiene que salir con `rolreplication = true`** y la publicación con **cientos** de tablas
(336 en el POS `02`). Si `ods_repl` sale en `false`: `ALTER ROLE ods_repl REPLICATION;`.

> Si usás pgAdmin, después **borrá la pestaña del Query Tool**: pgAdmin guarda el historial de
> consultas y ahí quedarían las dos contraseñas en texto plano.

---

#### Paso 3 — `postgresql.conf`

Abrilo con un editor de texto **como Administrador** (la ruta salió en el Paso 1). Buscá cada
parámetro; si está comentado con `#`, descomentalo; si no existe, agregalo al final:

```conf
listen_addresses = '*'                  # sin esto sólo escucha en localhost
wal_level = logical                     # sin esto no hay replicación lógica posible
max_replication_slots = 10
max_wal_senders = 10
max_slot_wal_keep_size = '20GB'         # TOPE: si el slot lo excede, se invalida y el
                                        # suscriptor re-sincroniza — en vez de llenar el
                                        # disco del POS y tumbar la caja
```

Para ver en qué están ahora, sin abrir el archivo:
```sql
SELECT name, setting, context FROM pg_settings
 WHERE name IN ('listen_addresses','wal_level','max_replication_slots',
                'max_wal_senders','max_slot_wal_keep_size');
```
La columna `context` dice qué hace falta para que el cambio tome efecto:
**`postmaster` = reiniciar el servicio** (es el caso de `listen_addresses` y `wal_level`),
`sighup` = alcanza un reload.

---

#### Paso 4 — `pg_hba.conf`

Dos renglones. **El de `ods_repl` es el que siempre se olvida**, y sin él la suscripción no conecta
nunca aunque todo lo demás esté bien:

```conf
# ODS de la plataforma (servidor 192.168.0.249)
host    md_07    ods_repl       192.168.0.249/32    scram-sha-256
host    md_07    platform_ro    192.168.0.249/32    scram-sha-256
```

Tres detalles que hacen fallar esto:

- **El orden importa.** `pg_hba` se lee de arriba hacia abajo y gana **la primera línea que
  coincide**. Si más arriba hay un `reject` o una regla que abarque estas IPs, poné estos dos
  renglones **antes**.
- **La replicación lógica conecta a la base REAL** (`md_07`), no al pseudo-`replication` — ése es
  para la replicación física. No pongas `database = replication`.
- **`scram-sha-256`**, porque el POS `02` corre con `password_encryption = scram-sha-256` (medido).
  Si en este POS ese parámetro dijera `md5`, la contraseña queda guardada en md5 y una línea
  `scram-sha-256` **rechaza el login**. Comprobalo con `SHOW password_encryption;` antes.

Aplicar (esto **no** requiere reinicio):
```sql
SELECT pg_reload_conf();
SELECT line_number, type, database, user_name, address, auth_method
  FROM pg_hba_file_rules ORDER BY line_number;   -- superusuario: verifica que quedaron cargados
```

---

#### Paso 5 — Reiniciar el servicio (sólo si tocaste `wal_level` o `listen_addresses`)

Es una ventana de caja cerrada: **coordinala con la sucursal.**

Por interfaz: *Servicios* de Windows (`services.msc`) → buscá `postgresql-x64-16` (el nombre exacto
puede variar) → *Reiniciar*.

Por consola, como Administrador:
```bat
net stop postgresql-x64-16 && net start postgresql-x64-16
```
Para ver el nombre real del servicio:
```bat
sc query type= service state= all | findstr /i postgres
```

Y confirmá que tomó:
```sql
SELECT name, setting FROM pg_settings WHERE name IN ('wal_level','listen_addresses');
```

---

#### Paso 6 — Firewall de Windows del POS

Es la causa más probable de que hoy `192.168.32.32` no responda ni en 5432 ni en 1977. Como
Administrador, ajustando el puerto al que de verdad use ese POS:

```bat
netsh advfirewall firewall add rule name="PostgreSQL ODS" dir=in action=allow protocol=TCP localport=1977 remoteip=192.168.0.249
```

`remoteip` deja entrar **sólo** a este servidor, que es lo que hace falta. Para ver si ya había una
regla: `netsh advfirewall firewall show rule name=all | findstr /i 5432`.

---

#### Paso 7 — Comprobar desde el servidor de la plataforma

Este paso **no se puede saltar ni hacer desde el POS**: `listen_addresses`, el firewall y `pg_hba`
sólo se prueban conectándose de verdad desde el origen. Un `psql` corrido en el propio POS los da
por buenos y no prueba nada.

```
node database/scripts/verificar-pos-kepler.js --host=<IP_DEL_POS> --port=1977 --db=md_07
```

Tiene que dar **8 OK / 0 FALTA**. Si no, cada falla dice qué archivo tocar. De control, una que ya
funciona: `node database/scripts/verificar-pos-kepler.js --branch=02` → 8 OK.

Además imprime `SELECT DISTINCT sucursal FROM md.kdm1`: **ése es el código con el que la venta de
Madero va a entrar al ODS**, y es el dato que faltaba confirmar (§9.1).

---

#### Paso 8 — Recién ahí, el cableado de este lado

Con el verificador en verde, sigue §9.4: réplica + suscripción, registrar la rama en
`kepler-branches.js`, sumarla al carril del ODS, llenar `wincaja.branches`, y el corte del sell-out
—que es la parte que hay que hacer con el candado de paridad, no a ojo.

### 9.7 La réplica de Madero, cableada — y el techo del contenedor (2026-09-08)

Con el POS en 9/9, el resto se hizo de este lado. Quedó **replicando en vivo**, pero el camino tuvo
dos tropiezos que valen para la próxima rama (la #9 va a chocar con lo mismo).

**Lo que quedó:** `kepler_md_07` en `:5433` con las **328 tablas** del schema `md`, suscripción
`sub_md_07 → ods_pub_pilot`, sync inicial completo (328/328 en estado `r`), `apply_error_count = 0`.
Filas replicadas: kdm1 161 · kdii 9,523 · kdil 2,542 · kdud 1,205 · kdm2 8,803.

**Tropiezo 1 — 12 tablas sin `GRANT` para `ods_repl`.** El sync arrancó y falló con
`permiso denegado a la tabla kdc22609`. Medido: `ods_repl` leía **316 de 328**; faltaban las
`kdc2YYMM` de póliza creadas DESPUÉS del alta (no heredaron el default privilege) más unas de RH/CFDI
(`kdc20012, kdc226, kdc22601/605/609/612, kdfecfdnm, kdfecfdnm12, kdhaca1, kdhlab1, kdrhaspent,
kdrhrut`). Se resolvió con el `GRANT` explícito + `ALTER DEFAULT PRIVILEGES` para las dos dueñas
(`sa` y `postgres`) + `GRANT SELECT ON ALL TABLES` como red. **Lección: el default privilege sólo
cubre tablas creadas por el rol declarado; si Kepler crea tablas como otro rol, se cuelan.** El
verificador debería crecer para contar `has_table_privilege('ods_repl', …)` sobre las 328, no sólo
probar que lee `kdm1`.

**Tropiezo 2 — el contenedor `:5433` estaba tope contra tope.** `max_replication_slots = 10` y
`max_active_replication_origins = 10`, pero **ya había 7 suscripciones** (cada una consume un origin
PERMANENTE), y el sync inicial de 328 tablas necesita varios slots + origins TEMPORALES a la vez. El
log lo gritaba: `todos los slots de replicación están en uso` y
`could not find free replication state slot for replication origin`. Con eso, la suscripción octava
ni podía copiar — y `CREATE SUBSCRIPTION` no falla, REINTENTA (481 sync-errors en bucle).

Se subieron a **20** los tres (`max_replication_slots`, `max_wal_senders`,
`max_active_replication_origins`) por `ALTER SYSTEM` — persisten en `postgresql.auto.conf`, que vive
en el volumen `pgvector-md-data`. Los tres son de contexto `postmaster` → **hubo que reiniciar el
contenedor** (`docker restart pgvector-md`, ~30 s de arranque). Las 6 ramas viejas se recuperaron
solas; verificado después: las 8 suscripciones `enabled` y 0 tablas fuera de `r`.

⚠️ **Rareza de PG18 anotada:** tras el `ALTER SYSTEM`, `pg_settings.pending_restart` seguía en
`false` para los tres, aun después de `pg_reload_conf()`. No creerle: la verdad es el
`postgresql.auto.conf` (que sí tenía los `= '20'`) y el valor activo tras el restart (que quedó en
20). No usar `pending_restart` como señal de "ya tomó" en este contenedor.

**Regla para la próxima rama:** antes de `CREATE SUBSCRIPTION`, contar
`(SELECT count(*) FROM pg_subscription)` contra `max_active_replication_origins` y
`max_replication_slots`. Si el margen es menor a ~4, subir el techo y reiniciar ANTES, no durante el
sync fallido.

**Todavía pendiente para que Madero llegue a la app** (es el cutover, necesita tu fecha de corte):
registrar `07` en `kepler-branches.js`, sumarla al carril `replicate-ods-live`, llenar
`wincaja.branches`, sacar `32` del carril vivo de Wincaja, y el corte del sell-out con el candado de
paridad. Ver §9.4.

