# Runbook — Réplica viva de prod para desarrollo (Fase REP)

> Estado: **F0, F1 y F1.2 cerrados.** `pgvector 0.8.2` instalado en `.245` y `platform_replica`
> creada con paridad de extensiones 8/8 contra prod. Sigue **F2 (siembra)**.

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

## ✅ Paso 1 — pgvector en `.245` (RESUELTO 2026-09-09, sin admin y sin reiniciar Postgres)

> **Lo que efectivamente se hizo.** El procedimiento de más abajo (copiar a `C:\Program Files\…` con
> RDP) sigue siendo el **canónico** y es al que conviene migrar cuando alguien tenga sesión en `.245`.
> Pero no hacía falta esperarlo: PostgreSQL 18 agregó **`extension_control_path`**, y con eso la
> extensión se instaló **entera por SQL más el share de `D:`**, sin tocar `C:` y sin reinicio.

### Cómo quedó

```
D:\pgvector\lib\vector.dll                     ← compilado en .249, ver abajo
D:\pgvector\share\extension\vector.control     ← con module_pathname = 'vector'
D:\pgvector\share\extension\vector--*.sql      ← 38 archivos
```

```sql
-- Las dos son ADITIVAS: conservan el default y suman una ruta. Contexto `superuser`,
-- así que las aplica un ALTER SYSTEM + SIGHUP: sin downtime, sin cortar conexiones.
ALTER SYSTEM SET dynamic_library_path   = '$libdir;D:/pgvector/lib';
ALTER SYSTEM SET extension_control_path = '$system;D:/pgvector/share';
SELECT pg_reload_conf();
```

Para revertir: `ALTER SYSTEM RESET` de las dos + `pg_reload_conf()`. (Primero hay que quitar la
extensión de las bases que la usen, o queda una extensión cuyo `.dll` ya no se resuelve.)

### Las cuatro cosas que hubo que descubrir midiendo

1. **El layout NO es plano.** Con `extension_control_path = '…;D:/pgvector'` y el `.control` suelto
   ahí, `pg_available_extensions` **no lo ve**. Postgres le agrega `extension` al final de cada
   entrada del path. Por eso el directorio espeja el layout real de una instalación
   (`lib\` + `share\extension\`) y las GUCs apuntan a `…/lib` y `…/share`.
2. **`module_pathname` hay que cambiarlo.** Upstream trae `'$libdir/vector'`, y un nombre **con
   barra** hace que Postgres salte `dynamic_library_path` y resuelva `$libdir` directo a `pkglibdir`.
   Con nombre pelado (`'vector'`) sí usa el path. Es un cambio de una línea en el `.control`.
   Si algún día se hace la instalación canónica, el `.control` de `$system` gana (se busca primero) y
   este staging queda inerte.
3. **El servicio de `.245` puede leer una carpeta creada por SMB.** Verificado *antes* de mover nada,
   con `pg_read_file('D:/pgvector/probe.txt')` — que lo ejecuta el servicio, no el cliente.
4. **`.249` y `.245` son el MISMO build**, byte por byte:
   `PostgreSQL 18.4 on x86_64-windows, compiled by msvc-19.44.35226, 64-bit`. Por eso se pudo
   compilar en `.249` (que es la caja de dev) en vez de meter un compilador en el servidor
   compartido.

### El ensayo, que es lo que hizo que esto no fuera a ciegas

Todo el procedimiento se ejecutó **primero contra el PostgreSQL 18.4 nativo de `.249`** —mismo build,
máquina propia— y ahí fue donde apareció lo del layout plano. Recién con la receta funcionando se
tocó `.245`. El ensayo se revirtió después (`ALTER SYSTEM RESET` ×2, `DROP EXTENSION`, borrado del
staging): `.249` quedó como estaba.

### Verificación (no alcanza con que `CREATE EXTENSION` no falle)

```sql
SELECT name, default_version FROM pg_available_extensions WHERE name = 'vector';  -- vector | 0.8.2
CREATE EXTENSION vector;
SELECT '[1,2,3]'::vector <-> '[4,5,6]'::vector;                    -- 5.1962 (= raíz de 27)
CREATE TABLE v(e vector(1024));
CREATE INDEX ON v USING hnsw (e vector_l2_ops);                    -- lo que usa prod
```

Las cuatro pasaron en `.245`, en una base desechable `_pgvector_smoke` que se borró después.

### Cómo se compiló (en `.249`)

```powershell
winget install --id Microsoft.VisualStudio.2022.BuildTools --accept-package-agreements `
  --accept-source-agreements --disable-interactivity `
  --override "--wait --quiet --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"

$env:PGROOT = "C:\Program Files\PostgreSQL\18"
git clone --branch v0.8.2 --depth 1 https://github.com/pgvector/pgvector.git
cd pgvector
$vswhere = "C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe"
$vsPath  = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
cmd /c "`"$vsPath\VC\Auxiliary\Build\vcvars64.bat`" >nul && nmake /F Makefile.win"
```

Produce `vector.dll` (268 KB, sha256 `730BCB10…E60B`) y `sql\vector--0.8.2.sql`. Se compila **desde
la fuente a propósito**: bajar un `.dll` de terceros a un servidor que toca datos financieros es peor
que gastar 4 GB en un compilador.

---

## Paso 1-bis — la instalación CANÓNICA, para cuando haya RDP en `.245`

Nada urge, pero conviene migrar a esto en algún momento: sobrevive a un `pg_upgrade` y no depende de
dos GUCs que alguien puede resetear sin saber.

**Por qué importa la extensión, para quien llegue sin contexto.** Prod usa el tipo `vector` en
**7 columnas**, y una es `catalog.products.embedding` — el catálogo central de 14,807 productos. Sin
la extensión, el `pg_restore` falla al crear esa tabla y no hay forma de "saltearla": un `--use-list`
puede omitir una tabla entera, no una columna.

**Por qué hizo falta el rodeo:** el recurso `C$` de `.245` responde `Permission denied` desde `.249`
(y `admin$` y `D$` también). La instalación canónica toca `C:\Program Files\PostgreSQL\18\`, así que
va **con RDP o sesión local en `.245`**.

### Los pasos, cuando haya sesión

Los artefactos **ya están compilados y verificados**, en `D:\pgvector\` de la propia `.245`. No hay
que volver a compilar nada:

```powershell
# 1. Copiar a las rutas canónicas (requiere admin en .245)
Copy-Item "D:\pgvector\lib\vector.dll"          "C:\Program Files\PostgreSQL\18\lib\"            -Force
Copy-Item "D:\pgvector\share\extension\*"       "C:\Program Files\PostgreSQL\18\share\extension\" -Force
```

```powershell
# 2. Restaurar el module_pathname de upstream en la copia canónica.
#    El de D:\ está con nombre pelado a propósito (ver "las cuatro cosas" arriba);
#    en $system conviene el valor original.
$c = "C:\Program Files\PostgreSQL\18\share\extension\vector.control"
(Get-Content $c -Raw).Replace("module_pathname = 'vector'", "module_pathname = '`$libdir/vector'") |
  Set-Content $c -NoNewline -Encoding ascii
```

```sql
-- 3. Recién ahí, soltar las dos GUCs y volver al default.
ALTER SYSTEM RESET dynamic_library_path;
ALTER SYSTEM RESET extension_control_path;
SELECT pg_reload_conf();

-- 4. Y comprobar que sigue viva DESPUÉS de soltarlas (si no, se vuelve a poner):
SELECT name, default_version FROM pg_available_extensions WHERE name = 'vector';  -- vector | 0.8.2
SELECT '[1,2,3]'::vector <-> '[4,5,6]'::vector;                                   -- 5.1962
```

⚠️ El orden importa: si se resetean las GUCs **antes** de copiar, `platform_replica` queda con una
extensión cuyo `.dll` no se resuelve. Copiar primero, resetear después, comprobar al final.

⚠️ **No hace falta reiniciar Postgres** en ningún momento. `pg_available_extensions` relee el
directorio en cada consulta y `CREATE EXTENSION` carga la `.dll` en la sesión.

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

## Paso 4 — la siembra (F2)

> ⚠️ **El plan decía "pg_dump de prod partido en core y bulk". Se cayó por dos mediciones.**
>
> **1. El grafo de dependencias es circular entre los dos pases.** Medido sobre prod:
>
> | vistas en | dependen de |
> |---|---|
> | `md` (225) | `kepler_ods` ← bulk |
> | `catalog.products_active` | `kepler_ods` ← bulk |
> | `finance.kepler_accounts` | `analytics` ← bulk |
> | `analytics` (43) | `catalog`, `commercial`, `finance`, `logistics` ← **core** |
> | `public` (23) | `catalog`, `erp`, `identity`, `trade` ← **core** |
> | `wincaja` (4) | `catalog` ← **core** |
>
> Core necesita bulk y bulk necesita core. Cualquier split por schema con `--exit-on-error`
> revienta en las dos direcciones. Un solo dump ordena solo, porque `pg_dump` ordena.
>
> **2. El respaldo nocturno ya dumpea prod entero, todos los días.** Desde REP.0.0 produce un `-Fc`
> completo. Volver a dumpear prod para el espejo sería pagar **dos veces el mismo snapshot largo**
> sobre la misma base — y el snapshot es justo lo que hay que cuidar, porque fija el horizonte de xid
> y le frena el vacuum a prod.

**Cómo quedó: el espejo se cuelga del respaldo.** Prod se lee **una vez por día, para respaldar**, y
el espejo reusa esa misma foto. Carga adicional sobre prod: **cero**. Y de yapa, el respaldo pasa a
tener un consumidor que lo ejercita todos los días — *un respaldo que nadie restaura nunca es una
hipótesis*.

```bash
MIRROR_TARGET_URL="postgresql://postgres:…@192.168.0.245:5432/platform_replica" \
  node database/scripts/pull-prod-to-local.js seed --jobs=4
# toma el .dump más nuevo de %USERPROFILE%\backups\trade_marketing
# o uno concreto con --from-dump=<ruta>
```

Del TOC se apartan las **10 `MATERIALIZED VIEW DATA`**: dentro de `pg_restore` van serializadas y, si
una falla, `--exit-on-error` tira abajo una restauración de una hora. Se refrescan aparte, una por
una y con su tiempo — y **la que falle se declara**, en vez de quedar VÁLIDA Y VACÍA, que es el peor
resultado porque vacío se lee igual que "no hay datos" (§32).

**Medido: la siembra tardó 27.7 min, sin una sola línea de error.**

### Dos cosas que `pg_restore` no hace, y que `seed` sí

**1. `ANALYZE`.** Medido tras la primera siembra: **281 tablas sin una sola fila en `pg_stats`**. No
es sólo lentitud — una réplica sin estadísticas le da al planner planes distintos a los de prod, así
que cualquier trabajo de performance hecho encima **mide otra cosa**.

**2. Refrescar las matviews ANTES de migrar.** La primera corrida las dejó "para después" y la
migración `20260909170000_sellout_dedup_madero_07.js` falló con *«la vista materializada
mv_kepler_sales_daily no ha sido poblada»*. **Las migraciones leen matviews**, así que refrescarlas
es parte de la siembra, no un paso que uno se acuerda de correr. Las dos quedaron dentro de `seed`.

### El orden, que importa

```bash
node database/scripts/pull-prod-to-local.js seed        # restore + ANALYZE + refresh de matviews
node database/scripts/pull-prod-to-local.js migrate     # dry-run: drift + fantasma
node database/scripts/pull-prod-to-local.js migrate --apply --expect-pending=N
node database/scripts/pull-prod-to-local.js grants      # la MATRIZ, no un GRANT ALL
```

`--expect-pending` no es decorativo: `migrate:latest` corre las pendientes de **todos**, así que si
el número salta hay una rama ajena en el working tree y conviene verlo antes. Probado: con un número
equivocado aborta con `exit 2`.

---

## Paso 4-bis — por qué `grants` copia la matriz en vez de otorgar parejo

`pg_dump --no-privileges` no trae ningún GRANT, así que tras el restore `app_runtime` no puede leer
nada. La tentación es un `GRANT ALL` sobre todo — que es lo que hace `sync-from-remote.js`, y encima
sólo sobre 4 de los ~20 schemas.

**Otorgar parejo rompe el motivo de usar `app_runtime`.** La matriz de prod, medida, NO es uniforme:

| schema | SELECT | INSERT | DELETE | |
|---|---|---|---|---|
| `kepler_ods` | 226 | **0** | **0** | lo alimenta el shipper |
| `md` | 225 | **0** | **0** | vistas sobre el ODS |
| `analytics` | 117 | 24 | 13 | mayormente lectura |
| `commercial` | 115 | 115 | 115 | CRUD completo |
| `identity` | 11 de 13 | 10 | 9 | dos relaciones ni se leen |
| `pgboss` | **0** | 0 | 0 | **ni USAGE**: la cola corre como `postgres` |

Con un `GRANT ALL`, un dev escribe un `INSERT` a `kepler_ods`, le funciona en la réplica y le explota
en prod. La réplica tiene que mentir lo menos posible, y **los permisos son parte de lo que replica**.

La verificación se hace **conectado COMO `app_runtime`**, y con escrituras — §33 existe porque un rol
"de solo lectura" pasó todos los `SELECT` y tumbó prod en el primer `UPDATE`. Incluye la prueba
**negativa**: `app_runtime` **no** debe poder escribir en `kepler_ods`. Si pudiera, la réplica estaría
mintiendo en la dirección peligrosa.

---

## Paso 4-ter — la siembra vieja del plan (referencia, ya no se usa)

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
| **REP.2** pgvector 0.8.2 en `.245` | ✅ **sin admin y sin reiniciar** (vía `extension_control_path` de PG18) |
| **F1** base destino | ✅ `platform_replica` en `ts_platform_replica` (`D:`), **paridad de extensiones 8/8** con prod |
| F2 siembra · F3 fixups · F4 cascada · F5 delta · F7 frescura | ⬜ |

**El `doctor` contra el destino real: 11/11**, con el aviso de base compartida. Y en su primera
corrida encontró un error de diseño propio: el destino estaba pedido como `expect:'local'`, y la
réplica vive en `.245`, que clasifica como `compartida` — correctamente, porque esa caja la ven los
tres devs. La política de destino de un espejo no es *"tiene que ser mi localhost"* sino **"no puede
ser prod y tengo que reconocerlo"**, que es exactamente `assertSafeTarget`. Se reusa esa en vez de
duplicar una segunda política que después se desincroniza.

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
