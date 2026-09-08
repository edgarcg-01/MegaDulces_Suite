# Runbook — Réplica viva de prod para desarrollo (Fase REP)

> Estado: **F0 y F1.2 cerrados. F1 BLOQUEADO** esperando pgvector en `.245` (paso 1 de acá abajo,
> lo hace una persona con acceso a esa máquina). Todo lo demás está listo para arrancar detrás.

---

## Qué es esto y por qué

Hoy no hay camino a un dev con dato realista:

- `ONBOARDING.md` §2 (`dev:up` + `seed:new` + `seed:testdata`) da una base **vacía con 5 filas demo**.
  MR, sell-out, RA, Maat, CB y Compras no se pueden ni abrir.
- `.245/platform_test`, que es lo que usa el equipo, está **42 migraciones atrás de prod** y a la vez
  tiene **15 que prod no tiene**. Se desarrolla contra un schema que no es el de prod, en las dos
  direcciones.

La tesis, en una línea: **el dato fresco no viene de prod — prod lo recibe de acá.** La PC de
sistemas (`192.168.0.249`) hospeda las réplicas lógicas de los 7 Kepler y de Wincaja, y de ahí salen
los contenedores y procesos que alimentan producción. La réplica de dev se cuelga del **mismo
origen**, y prod sólo aporta lo que nadie más tiene, por lectura.

```
        Kepler POS (6 cajas LAN)                     Wincaja .mdb (Z:)
                 │ replicación lógica                       │ CDC Jet 32-bit (PM2)
                 ▼                                          ▼
    ┌──────────────── .249  :5433  pgvector-md ─────────────────────────┐
    │  kepler_md_00..07 (schema md)            wincaja (40 GB)          │
    │  ods.ctl / ods.shadow  ← ESTADO DE PROD: NI SE TOCA NI SE COPIA   │
    └───┬───────────────────────────────────────────────────┬───────────┘
        │ ① publicación FOR TABLES IN SCHEMA md (F4)        │ ③ los shippers de
        ▼                                                   │   HOY, sin cambios
  ┌── .245 : kepler_md_00..07 ──┐                           ▼
  │  copia propia + ods.ctl     │                      PROD (Railway)
  │  PROPIO                     │                      kepler_ods.*
  └───┬─────────────────────────┘                           │
      │ ② carril shipper DEV                                │ ④ pg_dump SOLO LECTURA
      ▼                                                     ▼
  ┌──────────────── .245 : platform_replica ─────────────────────────────┐
  │  kepler_ods.* wincaja.* analytics.*  ← ② vivo                        │
  │  identity commercial trade finance fiscal logistics … ← ④ de prod    │
  │  mirror.*  ← estado del espejo. NO existe en prod, y ése es el punto │
  └──────────────────────────────────────────────────────────────────────┘
```

**Lo que resuelve la cascada:** el shipper del ODS guarda su watermark (`ods.ctl`) y sus hashes
(`ods.shadow`) **en el ORIGEN**, con llave `table_name` a secas. Los dos carriles de prod sólo evitan
pelearse partiendo el set de tablas con `ODS_EXCLUDE_TABLES`. Un tercer carril sobre las mismas
tablas **haría que prod pierda filas en silencio**. Al cascadear, las réplicas de `.245` tienen su
propio `ods.ctl` y el carril dev nunca ve el de prod.

---

## ⛔ Paso 1 — instalar pgvector en `.245` (BLOQUEANTE, y no se puede hacer por red)

**Por qué bloquea.** Prod usa el tipo `vector` en **7 columnas**, y una es
`catalog.products.embedding` — el catálogo central de 14,807 productos. Sin la extensión, el
`pg_restore` falla al crear esa tabla y no hay forma de "saltearla": un `--use-list` puede omitir una
tabla entera, no una columna.

**Medido el 2026-09-08:**

| | |
|---|---|
| `.245` | PostgreSQL **18.4 x86_64-windows, compilado con MSVC 19.44** · `data_directory = C:/Program Files/PostgreSQL/18/data` |
| extensiones de prod disponibles en `.245` | `cube`, `earthdistance`, `pg_trgm`, `pgcrypto`, `postgres_fdw`, `unaccent` |
| **falta** | **`vector`** |
| versión que usa prod | **0.8.2**, tipo `vector(1024)` en las 7 columnas |
| la misma versión, ya funcionando | contenedor `pgvector-md` de `.249` (`pgvector/pgvector:pg18`) → **0.8.2** |

**Por qué no lo puede hacer un script desde `.249`:** el recurso `C$` de `.245` responde
`Permission denied`. La instalación toca `C:\Program Files\PostgreSQL\18\`, así que va **con RDP o
sesión local en `.245`**.

### Los pasos

1. Conseguir pgvector **0.8.2** para **PostgreSQL 18, x64, MSVC**. Dos rutas:
   - binario ya compilado que empate exactamente esa combinación, o
   - compilarlo con las *Build Tools* de Visual Studio siguiendo el `README` de pgvector
     (`nmake /F Makefile.win`), con `PGROOT=C:\Program Files\PostgreSQL\18`.

   ⚠️ **La versión importa.** Si instalás una anterior a 0.8.2, el restore de prod puede fallar sobre
   objetos que esa versión no conoce. Igualá 0.8.2 o subí.

2. Copiar los tres archivos (hace falta ser administrador):

   ```
   vector.dll            →  C:\Program Files\PostgreSQL\18\lib\
   vector.control        →  C:\Program Files\PostgreSQL\18\share\extension\
   vector--*.sql         →  C:\Program Files\PostgreSQL\18\share\extension\
   ```

3. **No hace falta reiniciar Postgres.** `pg_available_extensions` lee el directorio en cada
   consulta; `CREATE EXTENSION` carga la `.dll` en la sesión.

4. Verificar, desde donde sea:

   ```sql
   SELECT name, default_version FROM pg_available_extensions WHERE name = 'vector';
   -- tiene que devolver: vector | 0.8.2
   ```

   Y avisar. El paso 2 arranca solo con eso.

---

## Paso 2 — la base destino (F1)

Se corre desde `.249`. Es aditivo: no toca `platform_test` ni `hr`.

```sql
-- ⚠️ BARRA NORMAL. Con 'D:\pgdata_replica' Postgres responde
--    42P17 "la ubicación del tablespace debe ser una ruta absoluta". Medido.
--    (El ts_platform_test que ya existe se ve como D:\pgdata_test al leerlo, pero
--     al CREARLO hay que escribirlo con barras normales.)
CREATE TABLESPACE ts_platform_replica LOCATION 'D:/pgdata_replica';
CREATE DATABASE  platform_replica TABLESPACE ts_platform_replica;
```

El directorio `D:\pgdata_replica` se crea antes (desde `.249` está mapeado como `Z:`). `D:` de `.245`
tiene **839 GB libres**; `C:` de `.245`, que es donde vive `pg_default`, no se midió — por eso la
réplica va explícitamente al tablespace y no al default.

Después, las 7 extensiones de prod:

```sql
CREATE EXTENSION IF NOT EXISTS cube;
CREATE EXTENSION IF NOT EXISTS earthdistance;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS postgres_fdw;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS vector;   -- ← la del paso 1
```

---

## Paso 3 — antes de copiar un byte: el `doctor`

```bash
MIRROR_TARGET_URL="postgresql://postgres:…@192.168.0.245:5432/platform_replica" \
  node database/scripts/pull-prod-to-local.js doctor
```

No toca nada. Corre las cinco capas y **aborta** si alguna no cuadra. Tiene que dar 11/11.

| Capa | Qué frena |
|---|---|
| **A** `options` en la conexión | nuestro propio bug — y es la única que también cubre a `pg_dump`/`psql` vía `PGOPTIONS` |
| **B** allowlist de forma de sentencia | 10 formas de escritura rechazadas antes del cable; deja pasar `COPY (SELECT …) TO STDOUT` y rechaza `COPY t FROM STDIN` |
| **C** sonda viva | manda escrituras de verdad y exige el `25006` del motor |
| **D** `SET SESSION CHARACTERISTICS` | cinturón sobre A |
| **G** ausencia de credencial | sin `ODS_HB_URL`/`FEEDS_INGEST_KEY`/`FEEDS_MIRROR_URL`/`STORE_INGEST_KEY` no hay con qué escribir hacia afuera |

⚠️ **La capa G va a fallar con el `.env` del repo**, y está bien: esa máquina *es* la del shipper y
tiene esas credenciales. El espejo corre con su propio env. Ver `.env.replica.example`.

### La sonda que el diseño traía no servía — medido contra prod (PG 18.6)

| sonda | resultado |
|---|---|
| `pg_current_xact_id()` | **PASA** — devolvió el XID `10612378`. Igual `txid_current()`. Habría dado verde siempre. **No la vuelvas a poner.** |
| `CREATE TEMP TABLE` | rechazado `25006` (el diseño la descartaba diciendo que las escrituras temporales están permitidas — no lo están) |
| `UPDATE` de 0 filas | rechazado `25006` |

Se usan las dos que sirven. El `UPDATE` va porque `GOTCHAS.md` §33: **un `SELECT` que funciona no
prueba que un `UPDATE` funcione** — ahí un rol "de solo lectura" tumbó prod porque el login sí
escribía, y todos los chequeos de lectura habían pasado.

---

## Paso 4 — la siembra (F2, pendiente de implementar)

**Los 25 GB no viajan.** Desglose medido de prod: **heap 15.5 GB + toast 0.4 GB + índices 9.7 GB**, y
los índices se **reconstruyen localmente**. Y `pg_dump` **nunca** hace COPY del contenido de una
matview: emite `CREATE MATERIALIZED VIEW` más una entrada de TOC `MATERIALIZED VIEW DATA` que corre
`REFRESH` al restaurar — o sea que esos 2 GB ya no cruzan el cable.

**Medido el 2026-09-08:**

| medición | resultado |
|---|---|
| `pg_dump -Fc -Z6` de `catalog+identity+trade` (40 tablas) | **38 s, 197 KB** → el costo dominante es **~1 s de latencia por tabla**, no los bytes |
| `-j1` vs `-j4` sobre el schema `fiscal` | **94 s vs 63 s = 1.49×** (no 4×: `pg_dump -j` paraleliza *entre* tablas, y el piso lo pone la tabla más grande) |
| respaldo completo de prod `-Fc -Z6` | **2,003 MB en 68 min**, 601 tablas |

| Pasada | Schemas | Heap+toast | Tablas | Estimado |
|---|---|---|---|---|
| **core** | todo **menos** analytics/kepler_ods/wincaja | 1.07 GB | ~250 | **10–20 min** |
| **bulk** | `kepler_ods`, `wincaja`, `analytics` (3 dumps separados) | 14.8 GB | ~328 | **~1–1.5 h**, de noche |

Reglas de la siembra:

- `--exclude-schema`, **nunca** un `--schema` explícito. Un allowlist deja fuera en silencio
  cualquier schema que prod estrene el mes que viene.
- `-Fd -j4`, partido por schema. `-Fc` no es reanudable: 2 h todo-o-nada sobre un proxy con 674 ms de
  latencia es una apuesta.
- ⚠️ `-Fd -jN` abre **N+1 transacciones `REPEATABLE READ`** en prod. Durante 2 h eso fija el horizonte
  de xid y **bloquea el vacuum**. El split por schema mantiene cada snapshot abajo de ~1 h.
- `pg_restore --exit-on-error` — reemplaza el `|| true` de `sync-from-remote.js:154`, que se traga el
  resultado entero del restore.

---

## Paso 5 — los fixups que rompen si se hacen a la ligera (F3, pendiente)

1. **`app_runtime`** con grants sobre **los ~20 schemas**. `sync-from-remote.js:167-179` otorga sólo
   4. Y se verifica **con una escritura**, no con un `SELECT` (§33).
2. **RLS**: prod tiene **271 relaciones con `FORCE ROW LEVEL SECURITY`**. Assert: como `app_runtime`
   **sin tenant**, `public.users` debe dar **0**. Si da 125 (con hashes bcrypt), se perdió el
   `security_invoker` de la migración `20260905120000`.
3. **El ledger fantasma** (§29): prod tiene `identity.knex_migrations` **además** de
   `public.knex_migrations`. El dump trae los dos, y eso es bueno — el espejo es el detector de
   fantasmas más barato que existe, porque lee los dos ledgers de prod gratis. Si la query de §29
   devuelve más de 4 filas, **hay un runner mal configurado en prod ahora mismo**. Se repara sólo en
   local. **Nunca `DELETE FROM identity.knex_migrations`**: la tabla es el sensor de su propia causa.
4. **`disableMigrationsListValidation`**: el ledger de prod trae 619 filas y el disco tiene 636
   archivos. Cualquier fila cuyo archivo no esté en tu rama hace que knex aborte con *"directory is
   corrupt"*.
5. **Anonimización `--safe` por default.** No existe nada de esto en el repo hoy.

---

## Paso 6 — la cascada (F4, pendiente)

⚠️ **`FOR TABLES IN SCHEMA md`, jamás `FOR ALL TABLES`.** Con `FOR ALL TABLES` se replican
`ods.ctl`/`ods.shadow` y `.245` hereda el **watermark de prod**, con lo cual el carril dev saltaría
todo en silencio. Es *el* detalle que hace o rompe la fase.

Techos de `.245` que hay que levantar **antes** del sync inicial (reinicia `.245`, **no prod**):

| Setting | Hoy | A |
|---|---|---|
| `max_logical_replication_workers` | **4** | 12 |
| `max_worker_processes` | 8 | 16 |
| `max_active_replication_origins` | 10 | 20 |
| `max_replication_slots` | 10 | 20 |

⚠️ `pg_settings.pending_restart` **miente en PG18** — verificar con `SHOW`.

El carril dev es una copia de `ops/ingest/docker-compose.yml` con **cuatro cambios y ni uno más**:
`ODS_SOURCE_BASE` → `.245`, `DATABASE_URL_NEW` (destino) → la réplica, `ODS_HB_URL` → la réplica, y
**`ODS_HB_KEY` distinto**. Lo último no es cosmético: `analytics.cron_runs` tiene PK
`(tenant_id, job_key)` y **`host` FUERA de la PK**, así que un segundo escritor no crea otra fila,
**pisa la del primero** — el carril muerto pasa por sano reportando la máquina equivocada como dueña
(§35).

---

## Estado

| Item | Estado |
|---|---|
| **REP.0.0** respaldo de prod arreglado | ✅ **primer respaldo real: 2,003 MB, 601 tablas, `kepler_ods` 226** |
| **REP.0.1** guarda de destino/origen en `libs/` | ✅ |
| **REP.0.2** prueba negativa + mutación | ✅ 19/19 |
| **REP.0.3** `DISABLE_CRONS` | ✅ |
| **REP.0.4** `.env.replica.example` | ✅ |
| **REP.0.5** freno de arranque | ✅ verificado contra el bundle |
| **REP.1** capas A–D+G + `doctor` | ✅ 11/11 contra prod |
| **REP.1.2** prueba negativa del read-only | ✅ 7/7 |
| **F1** base destino | ⛔ **bloqueada por pgvector en `.245`** |
| F2 siembra · F3 fixups · F4 cascada · F5 delta · F7 frescura | ⬜ |

### Cosas que aparecieron midiendo, y no son de esta fase

- **El respaldo nocturno de prod no era de prod.** `TradeMarketing-DailyBackup` leía `DATABASE_URL`,
  que en `.249` apunta a la copia local vieja. 236.1 MB idénticos cinco días seguidos, con **1 tabla
  de `kepler_ods`** en vez de 226. Arreglado en REP.0.0.
- **`.245/postgres_platform` (123 MB) desapareció** entre las 13:05 y las 14:45 del 2026-09-08.
  No fue el trabajo de esta fase: los únicos `DROP` emitidos nombran `platform_replica` y
  `ts_platform_replica`, y la única mención de `postgres_platform` en lo que se corrió fue un
  `SELECT` de tamaño. **Rompe `npm run embeddings:sync`**
  (`database/scripts/sync-from-remote.js` lee `DATABASE_URL_REMOTE_SNAPSHOT`, que apunta ahí).
  `.245` lo comparten tres devs: hay que preguntar antes de recrearla.
- **El `.env` de `.249` está en el estado roto de §25**: `DATABASE_URL` ≠ `DATABASE_URL_NEW` y
  `VECTOR_DATABASE_URL` sin setear. El log de arranque lo dice en cada boot
  (*"el matcher usará la fuente legacy"*) y nadie lo lee.
