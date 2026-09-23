# Producción on-prem (VL.9) — qué está construido y qué falta

> **Fuente única de "cómo está prod en `md`".** Hermano de [`ops/README.md`](../README.md),
> que es la INGESTA. Si otro documento contradice a éste, gana éste — y corregí el otro.
> Medido en vivo el **2026-09-22**.

---

## 0. Lo primero: esto NO ha cortado nada

Prod **sigue en Railway** y los usuarios siguen yendo a `*.up.railway.app`. Lo que hay en `md`
es una copia levantada **en paralelo**, sin usuarios, para poder verificarla antes de decidir
el corte. Ése fue el encargo textual: *"primero hay que instalar todo antes de migrar, tener
primeramente todo instalado y funcionando, luego migrar a los usuarios"*.

El corte tiene, además, una **precondición declarada y elegida**: VL.8 (UPS + respaldo fuera
de sitio + enlace). Hoy no existe ninguna de las tres.

---

## 1. Qué es prod, medido — no lo que uno se imagina

Prod no es "una app". Son **nueve servicios, dos bases, un bucket y un dominio**:

| Servicio en Railway | Qué es | Techo | ¿Portado a `md`? |
|---|---|---|---|
| `MegaDulces` | API NestJS + SPA `view` (nginx adentro) | 2 vCPU / 2 GB | ✅ `api` |
| `worker` | El mismo binario con `WORKER=true`: 48 `@Cron` + cola pg-boss | 1 / 1 GB | ✅ `worker` |
| `BD_CENTRALIZADO` | **La base**: PG 18.6, **34 GB** | 4 / 6 GB | ✅ `pg-prod` |
| `RAG_PRODUCTS` | Postgres de embeddings (Fase K) | 1 / 1 GB | ✅ `pg-rag` |
| `Portal_MegaDulces` | Portal B2B (clientes) | 0.5 / 0.5 GB | ✅ `portal` |
| `Vendor_MegaDulces` | App de vendedor (campo) | 1 / 2 GB | ✅ `vendor` |
| `feeds-ingest` | Recibe changesets por HTTPS | 1 / 2 GB | ⛔ **retirado con motivo** (§5) |
| `Megadulces-Logistica` | Mismo `/Dockerfile`, 21 vars | 0.5 / 0.5 GB | ⛔ **sin portar** (§5) |
| `observability` | `grafana/otel-lgtm` | 0.5 / 0.5 GB | ⛔ **sin portar** (§5) |
| bucket `foldable-pannikin` | **513 objetos, 597 MB** de comprobantes en PDF | — | ⛔ **sin portar** (§5) |

⚠️ **Los techos suman 11 vCPU y `md` tiene 8 hilos.** No son comparables (un techo no es uso),
pero conviene saberlo: **el recurso escaso acá es la CPU, no la RAM.**

### ¿Cabe? — medido del lado de la carga, no del techo

Prod, en un momento cualquiera de horario hábil (2026-09-22):

```text
conexiones 17 · activas 3 · cache hit 88.81 %
```

Tres consultas activas sobre 8 hilos **no es el problema**. Y el `88.81 %` de aciertos de caché
—que para una base de este tamaño es **bajo**— tiene una causa estructural que la mudanza
**mejora**: en Railway el contenedor de la base tiene un tope de **6 GB**, y bajo un cgroup el
**page cache cuenta contra ese tope**, así que Postgres termina releyendo del disco lo que creía
cacheado. En `md` le damos **12 GB** de `shared_buffers` (6 hasta el 2026-09-23; los subió
`[VL.11.E]`) **más** el page cache del host, y el compose **no le pone `mem_limit` a propósito**
(ver el comentario en `x-pg`).

⚠️ Esto **no prueba** que vaya a ir más rápido — para eso hay que medir la copia con tráfico
real. Sí dice que el argumento de "no cabe" hay que hacerlo con números, y los que hay hoy no
lo sostienen.

### El fierro, medido — y corrige a `FASE_VL` §6.1

| | El plan decía | Medido el 2026-09-22 |
|---|---|---|
| CPU | Ryzen 5 4600G · 6c/12t | **Ryzen 5 3400G · 4c/8t** |
| RAM | 14 GiB | **28.8 GiB** (la subida ya se hizo) |
| Disco | NVMe 1 TB | NVMe 953,9 G · LV de 500 G con **387 G libres** · ~450 G sin asignar en el VG |

---

## 2. Cómo se despliega

```sh
ops/prod/deploy.sh --estado      # qué corre allá y con qué imagen
ops/prod/deploy.sh --imagenes    # construye las 4 imágenes, no recrea nada
ops/prod/deploy.sh --db          # sólo pg-prod + pg-rag
ops/prod/deploy.sh               # construye y recrea todo
ops/prod/deploy.sh api worker    # sólo esos
```

Mismas dos reglas duras que la ingesta: **se archiva `HEAD`, no la copia de trabajo** (el
índice lo comparten ~10 sesiones), y **un cambio de código exige reconstruir**, porque la
imagen es autocontenida.

Los secretos viven en `md:~/secrets/` con permisos `600` y **no se versionan**:

| Archivo | Para qué |
|---|---|
| `prod.env` | `env_file` de `api` y `worker` |
| `prod-compose.env` | lo que interpola el propio compose (contraseñas de superusuario, token del túnel) |
| `roles.sql` | `CREATE ROLE app_runtime` + `fdw_verificador_ro`, **antes** del restore |

Se generan con [`make-prod-env.js`](make-prod-env.js) a partir de `railway variables --json`.
Reapunta **sólo host y puerto**; usuario, contraseña y base se conservan byte a byte, así que
la copia nace con las credenciales que la app ya trae. **Rotar es un paso aparte del corte**
(ver [`ops/ACCESO_RAILWAY.md`](../ACCESO_RAILWAY.md)), no un efecto secundario del empaquetado.

---

## 3. Cómo se restaura la base — y por qué el respaldo diario NO alcanzaba para cortar

> ⭐ **[VL.6.4] Esta sección describía el respaldo de PowerShell. El 2026-09-22 el respaldo se
> mudó a `md`** (`ops/prod/backup-prod.sh`, contenedor `prod-backup`, 22:00 MX) **y se le quitó
> `--no-privileges` justo por lo que sigue.** Lo de abajo se conserva porque explica **por qué**,
> y porque cualquier dump viejo que alguien encuentre en disco tiene esta forma.

El respaldo de PowerShell (`scripts/backup-db.ps1`) corría con `--no-owner --no-privileges`,
elegido para portabilidad. Consecuencia **medida**:

- **no trae los roles** — y prod tiene **613 políticas RLS que nombran `app_runtime`**. Un
  `pg_restore` contra una base sin ese rol falla en 613 sentencias, **a mitad del restore**,
  no al principio.
- **no trae los GRANT**. O sea que aunque el rol exista, no tiene permisos sobre nada. Hubo que
  extraer **1,304 sentencias** de un dump aparte y aplicarlas a mano (§3.4).

El respaldo nuevo conserva `--no-owner` (el destino crea todo como `postgres`; el dueño es ruido)
y **sí trae los privilegios**. Los roles siguen yendo aparte, con `pg_dumpall --globals-only`.

### 3.0 ⭐ MEDIDO: la ventana del corte es ~2.5 h, no 6+

El plan de VL.9 proyectaba **6.1 h** de volcado a partir de **6.22 MB/min**. Está mal, y vale la
pena decir por qué para no repetirlo: **esa tasa se midió durante el cuelgue del socket muerto**,
o sea cronometrando un proceso que no transfería nada. Medir la velocidad de algo que está
colgado da la velocidad del cuelgue.

Los cuatro respaldos reales que existen en disco dicen otra cosa (el nombre del archivo lleva la
hora de inicio; el `mtime`, la de fin):

| Volcado | Tamaño | Duración |
|---|---|---|
| 08-sep 13:23 → 14:31 | 2003 MB | 68 min |
| 08-sep 17:00 → 18:09 | 2005 MB | 69 min |
| 09-sep 17:00 → 18:29 | 2161 MB | 89 min |
| 10-sep 17:00 → 18:14 | 2171 MB | 74 min |

⇒ **~30 MB/min comprimidos, ~75 min.** ⚠️ Los volcados de **236 MB** del 1 al 6 de septiembre
**no cuentan**: son de la base equivocada — el bug que el propio script dice haber cerrado el
08-sep. Usarlos para promediar da una tasa fantasía.

Y el cable no es el cuello. Medido con el **mismo comando** desde las dos máquinas (100 MB
generados en prod hacia `/dev/null`): **218 MB/min desde `SISTEMAS`, 260 MB/min desde `md`** —
~35 Mbit, casi el techo del enlace de 44.

⚠️ **El catálogo cuesta 121 s ANTES del primer byte de datos.** Prod tiene 1,251
tablas/vistas/matvistas, 2,527 índices y 27,290 columnas, y el viaje de ida y vuelta a Railway es
de **149 ms**: `pg_dump` hace miles de consultas de catálogo antes de empezar. Una sonda de 90 s
devuelve **0 bytes** y parece un cuelgue. No lo es.

**Consecuencia para el corte:** volcado ~75 min + restore ~73 min ≈ **2.5 h**. Sigue sin caber en
día hábil, pero deja de **exigir** `wal_level=logical` como única salida: una ventana de noche o
de fin de semana alcanza. La medición de F0.2 sigue valiendo la pena, ya no como bloqueo.

Por eso el orden es:

```sh
# 1. los roles, ANTES
docker exec -i pg-prod psql -U postgres -d railway -v ON_ERROR_STOP=1 < ~/secrets/roles.sql

# 2. el restore, en paralelo, DESDE EL HOST (md trae pg_restore 18.6 nativo)
set -a; . ~/secrets/prod-compose.env; set +a
PGPASSWORD="$PGPROD_SUPERPASS" pg_restore -h 127.0.0.1 -p 5434 -U postgres -d railway \
  --no-owner --no-privileges --jobs=4 /tmp/prod-AAAAMMDD.dump
```

⭐ **Desde el host, no con `docker exec`.** `md` tiene `pg_restore 18.6` instalado (la misma
versión que el servidor), así que el archivo se lee **donde ya está**. Meterlo al contenedor con
`docker cp` funcionaría, pero duplica el dump dentro de la capa de escritura del contenedor —
2 GB hoy, y el del corte va a ser bastante más — y no compra nada.

⛔ **`pg_restore --jobs` NO puede leer de la entrada estándar** — falla con *"parallel restore
from standard input is not supported"*, porque para repartir el trabajo necesita **saltar por
el archivo**, y un tubo no se puede rebobinar. O sea que el `… < archivo.dump` que uno escribe
por reflejo obliga a restaurar **en un solo hilo**. Sobre 34 GB la diferencia no es cosmética.

⛔ **Y para el CORTE de verdad hace falta un volcado DISTINTO**, que hasta hoy nadie tomaba:

```sh
pg_dumpall --globals-only   # roles con su hash de contraseña   ✅ HECHO (ver abajo)
pg_dump --format=custom     # SIN --no-privileges, para los GRANT   ⬜ pendiente del corte
```

Sin eso, la base cortada arranca con los permisos incompletos y el síntoma llega como
`permission denied for table …` en runtime, no en el restore.

**La mitad de arriba ya está hecha (2026-09-22).** `md:~/secrets/globals.sql` (`600`) trae los
3 roles de prod con su **hash SCRAM real**, y ya se aplicó a la copia. Verificado comparando
`pg_authid` de los dos lados — **coinciden fila por fila**:

```text
app_runtime         login=t  con contraseña
fdw_verificador_ro  login=t  SIN contraseña   <- también en prod, no es un defecto de la copia
postgres            super=t  con contraseña
```

⚠️ Al aplicarlo salen **3 `ERROR: role … already exists`** y son correctos: los roles ya
existían por `roles.sql`. Lo que importa son los **6 `ALTER ROLE`** que sí corrieron — son los
que ponen atributos y hash exactos. Un `ON_ERROR_STOP=1` acá **abortaría en el primer renglón**
y dejaría los roles a medias: es de los pocos lugares donde parar en el primer error es peor.

⚠️ Y sigue faltando lo de verdad difícil: **los GRANT**. Los globals traen *quién es* cada rol,
no *qué puede tocar*. Eso viaja en el dump de la base, y sólo si se toma **sin**
`--no-privileges`.


### 3.1 ⛔ Las matviews NO se reconstruyen con el planificador por defecto

Medido el 2026-09-22 en el restore de verificación. El `pg_restore` cargó los datos en ~35 min y
después se quedó **más de 70 minutos** en `REFRESH MATERIALIZED VIEW`, con el disco al **1.65 %**
de utilización y los backends al **98 % de CPU** — sin terminar.

La causa está en el plan, no en la máquina:

```text
GroupAggregate  (rows=16)              <- estima 16; la realidad son 24,397
  -> Nested Loop  (rows=7)             <- estima 7 iteraciones
       -> Parallel Seq Scan kdm1  (rows=178,048)
       -> Memoize -> Index Scan kdm2_pkey    <- una búsqueda por CADA fila
     Filter: (sucursal = btrim(c1)) AND (btrim(c4) = ANY ...) AND ...
```

Los `btrim()` y el filtro correlacionado `sucursal = btrim(c1)` colapsan la selectividad estimada,
el planificador cree que son 7 filas y elige un **nested loop**; termina haciendo una búsqueda por
índice por cada una de **178 mil** filas. `mv_kepler_sales_daily` sufre lo mismo (`rows=1` en su
nodo superior contra **779,144** reales).

**La receta, medida:**

```sh
psql … -c "SET enable_nestloop = off;" -c "REFRESH MATERIALIZED VIEW analytics.mv_kepler_sold_rung;"
```

| Vista | Plan por defecto | Con `enable_nestloop=off` |
|---|---|---|
| `mv_kepler_sold_rung` | **>70 min sin terminar** | **9.7 s** |
| `mv_kepler_sales_daily` | **>70 min sin terminar** | **29.6 s** |

Son **~140×** en la grande y **>430×** en la chica, con una sola línea de `SET`.

⚠️ **Esto no es un defecto de la copia: es de prod.** Misma definición, mismas estadísticas, mismo
plan.

> ⛔ **CORREGIDO el 2026-09-23.** Acá decía que *"`REFRESH` de estas vistas **no aparece en ningún
> cron ni importador** — sólo en migraciones y scripts sueltos"*. **Es falso, y de la forma más
> cara:** las corre el cron nocturno de
> [`analytics-refresh.service.ts`](../../libs/commercial/src/lib/commercial-analytics/analytics-refresh.service.ts)
> — `mv_kepler_sales_daily` en la línea 132 y `mv_kepler_sold_rung` en la 144 — y se comprueba sin
> leer código, mirando `analytics.cron_runs`: ahí están `analytics_refresh_kepler` y
> `analytics_refresh_sold_rung` con su umbral registrado. O sea que **el defecto de planificador
> no espera a una migración futura: ya está agendado todas las noches**, y las dos vistas que
> tardan `>70 min` contra `9.7 s` corren dentro de un `for` secuencial. `enable_nestloop=off` —la
> receta medida acá mismo, de 140× y 430×— **no existe en ninguna parte del código** (grep sobre
> `libs/`, `apps/` y `database/`: cero). Quedó escrita en este README y nunca se cableó donde corre.

⚠️ **Tres hipótesis se probaron y se cayeron antes de dar con ésta**, y se dejan escritas para que
nadie las repita: *no* eran estadísticas faltantes (todas las tablas grandes con `reltuples` exacto
y `analizada = t`), *no* era configuración pobre (la copia tenía **más** que prod: `shared_buffers`
6 GB vs 1.5, `work_mem` 32 MB vs 16, `maintenance_work_mem` 1 GB vs 256 MB — cifras **de esa
medición**; hoy son 12 GB / 64 MB / 4 GB), y *no* eran los índices
que faltaban (los 2 ausentes son parciales sobre `c2='U' AND c3='A'` — abonos — y estas vistas
filtran por `c3='D'`).

⚠️ Y una que también se cayó: al ver los workers paralelos en 0 % de CPU concluí que el `-j4` del
restore era el error. Falso — el trabajo total de CPU es fijo y los 4 núcleos estaban al 98 % en
trabajo útil. **El `-j` no es la palanca; el plan sí.**


⛔ **Y el ORDEN importa: primero el esquema, después las matviews.** Medido el 2026-09-22: con un
`REFRESH MATERIALIZED VIEW` corriendo, una migración `ALTER TABLE commercial.warehouses ADD COLUMN`
quedó **bloqueada** — la vista lee esa tabla con `ACCESS SHARE` y el `ALTER` necesita
`ACCESS EXCLUSIVE`. Y como la cola de locks de Postgres es FIFO, ese `ALTER` bloqueado **frena a
todo lo que venga detrás**, aunque no toque esa tabla.

Con un restore de una fecha anterior a la de prod (que es el caso normal: el dump siempre es más
viejo que el momento del corte) hay migraciones pendientes que aplicar. La secuencia correcta:

```text
1. pg_restore  (datos + índices)        ← las matviews quedan sin poblar, y está bien
2. knex migrate:latest                  ← el esquema al día, sin nada que lo bloquee
3. SET enable_nestloop=off; REFRESH …   ← al final, cuando ya no hay DDL esperando
```

Hacerlo al revés cuesta lo que costó acá: la migración esperando a una vista que tardaba una hora.


### 3.2 ⛔ Hay una migración que NO se puede aplicar con `knex migrate:latest`

Medido el 2026-09-22 al poner la copia al día (663 → 825 migraciones). La corrida se detuvo en
`20260911170000_declared_gaps.js`:

```text
migration file "20260911170000_declared_gaps.js" failed
error: DELETE FROM analytics.declared_gaps WHERE clave = '__probe__'
       - current transaction is aborted, commands ignored until end of transaction block
```

⚠️ **Ese mensaje es la consecuencia, no la causa.** La migración trae una **prueba negativa dentro
de sí misma**: inserta a propósito una fila que debe violar un `CHECK`, atrapa el error en
JavaScript y sigue. Pero en Postgres **una sentencia fallida aborta la transacción entera**, y knex
corre cada migración en una transacción — así que el `DELETE` siguiente muere, y el `if (!mordio)
throw` de abajo ni se alcanza.

**El código es correcto; lo incompatible es el envoltorio.** Corriendo el mismo `up()` sin
transacción, la propia migración imprime *"el CHECK de sólo-lectura **mordió** en la prueba
negativa"*.

⚠️ **Y lo que esto significa para el corte es más grande que la migración:** prod tiene esa
migración registrada (sola en el batch 382, 2026-09-11 22:10) con la tabla y el `CHECK` correctos —
pero **su historia no se puede reproducir desde el repo con el comando estándar**. Un restore que
haya que poner al día se traba ahí.

**Qué NO hacer:** editar el archivo. La compuerta `npm run check:migrations` lo prohíbe —
una migración ya aplicada que se edita no se re-corre, así que el arreglo nunca llegaría a prod.

**Qué hacer:** correr ese `up()` fuera de transacción y registrarlo. El arreglo de fondo
(envolver la inserción deliberada en un `SAVEPOINT`) va en una migración **nueva**, o en el
próximo archivo que use este patrón — porque el patrón *"prueba negativa dentro de la migración"*
es bueno y conviene que siga existiendo, bien hecho:

```js
await knex.raw('SAVEPOINT prueba');
try { await knex.raw('INSERT … que debe fallar'); }
catch (e) { mordio = /nombre_del_check/.test(e.message); }
await knex.raw(mordio ? 'ROLLBACK TO SAVEPOINT prueba' : 'RELEASE SAVEPOINT prueba');
```


### 3.3 ⭐ MEDIDO: «restaurar un dump viejo y migrar hacia adelante» NO reproduce prod

Se probó de verdad el 2026-09-22: restore del dump del 10-sep (663 migraciones) + `knex
migrate:latest` para llegar a las 825 de prod. **Falló tres veces, por dos causas, y la segunda es
estructural.**

**Causa 1 — una migración que no corre en transacción.** Es §3.2 de arriba.

**Causa 2 — migraciones que dependen de datos cambiados FUERA de toda migración.** Dos de ellas:

- `20260915130000_jefes_de_zona_y_escalera_operaciones.js` aborta con *"No existe la persona
  `aaron_alejo`"*. Medido: esa persona **sí existe** en la copia — se llama **`aaronalejo`**, sin
  guión bajo. Alguien renombró dos usuarios desde la UI de administración entre el 10 y el 15 de
  septiembre, y una migración posterior **hardcodeó el nombre nuevo**.
- `20260915140000_historia_puesto_filtro_adentro.js` aborta porque **1 persona no tiene tramo
  vigente** — otra condición de datos que difiere entre la foto y prod.

⇒ Esa clase de migración **no se puede replayar sobre ningún restore anterior al cambio de datos**,
y no hay forma de saber cuántas más hay sin llegar a ellas una por una. No es un defecto de una
migración: es una **propiedad del sistema** — el estado de prod es *esquema + datos editados a
mano*, y sólo la primera mitad vive en el repo.

**Consecuencia para el corte, sin ambigüedad:** hace falta un **dump FRESCO** (o replicación
lógica). `restore viejo + migrate` queda **descartado como camino**, no como preferencia.

⚠️ Pero sí sirve, y mucho, para **ejercitar la cadena de migraciones**: en ~60 migraciones encontró
tres defectos reales que nadie había visto. Vale la pena repetirlo de vez en cuando **a propósito**,
sabiendo que va a fallar y que eso es el punto.


### 3.4 ⛔ La app EXIGE TLS contra la base — y los GRANT no vienen en el dump

Los dos se descubrieron levantando el stack contra la copia el 2026-09-22, y los dos aparecen
**sólo en runtime**: el restore termina en verde y la app arranca igual.

**1. TLS.** `GET /api/sucursales` daba `500: The server does not support SSL connections`, y
`pg-boss` arrancaba *"inerte"* por lo mismo. Causa: el bloque `production` de
`database/knexfile-newdb.js` pone `ssl: { rejectUnauthorized: false }` **sin condicional**, y en
Railway la imagen de la base es `postgres-ssl` (TLS activo). `pgvector/pgvector:pg18` no lo trae.

Se arregla **del lado de la base**, no del código, para que la configuración de la app quede
idéntica en los dos lados. Certificado autofirmado, una vez, dentro del volumen:

```sh
docker exec -u postgres pg-prod sh -c 'cd $PGDATA &&
  openssl req -new -x509 -days 3650 -nodes -text -out server.crt -keyout server.key \
    -subj "/CN=pg-prod" && chmod 600 server.key server.crt'
```

y `ssl=on` + `ssl_cert_file` + `ssl_key_file` en el `command:` del compose (ya está). Verificado:
`SHOW ssl` → `on`, y las conexiones negocian **TLSv1.3**. ⚠️ Vale para `pg-rag` también.

**2. Los GRANT.** Con TLS resuelto, el mismo endpoint pasó a fallar con `aclcheck_error` —
permiso denegado. Es el bloqueo que §3 ya declaraba: el respaldo diario corre con
`--no-privileges`, así que la app (que conecta como `app_runtime`) no tiene permisos sobre nada.

Mientras el dump del corte no se tome con privilegios, se resuelve trasplantándolos:

```sh
pg_dump --schema-only --no-owner "$ODS_HB_URL" > /tmp/prod-schema.sql
grep -E '^(GRANT|REVOKE|ALTER DEFAULT PRIVILEGES)' /tmp/prod-schema.sql > /tmp/grants.sql
psql … -v ON_ERROR_STOP=0 -f /tmp/grants.sql
```

Medido: **1,304 sentencias — 1,298 a `app_runtime` y 6 a `fdw_verificador_ro`**; se aplicaron
1,217 `GRANT` con **cero errores**.

**Después de los dos arreglos, verificado contra la copia:**

```text
/api/health           200
/api/sucursales       200 · sucursales reales · 33 ms
/api/kp/precios-todos 200 · 9,532 productos · 1.8 MB · 1.13 s
```

⚠️ **Ninguno de los dos lo habría encontrado un smoke de infraestructura.** `pg_isready` decía
`healthy`, el contenedor decía `Up`, y `/api/health` devolvía 200 — porque no toca la base. Hizo
falta pedirle **datos**.

---

## 4. Cómo se verifica — el rótulo no es el veredicto

`healthy` dice que un contenedor contesta. Que **prod** esté bien se comprueba con datos:

```sh
# la base responde y es la que creemos
docker exec pg-prod psql -U postgres -d railway -tAc \
  "SELECT current_database(), pg_size_pretty(pg_database_size(current_database())), version();"

# el conteo de tablas por schema, contra el mismo conteo en Railway
docker exec pg-prod psql -U postgres -d railway -tAc \
  "SELECT table_schema, count(*) FROM information_schema.tables
    WHERE table_schema NOT IN ('pg_catalog','information_schema') GROUP BY 1 ORDER BY 1;"

# el API contesta de verdad
curl -fsS http://192.168.0.222:8080/api/health
```

⚠️ **El `worker` no abre puerto**, así que "está arriba" es lo único que Docker puede ver por
sí solo — y ése es exactamente el falso verde que VL.6.1 cerró en los carriles de la ingesta.
El veredicto de verdad es la **entrega** (`analytics.cron_runs`). Queda declarado como
pendiente: `[VL.9.x]` healthcheck de entrega para el worker, mismo patrón que `health-lane.sh`.

---

## 5. Lo que NO está portado, con su motivo

**`feeds-ingest` — RETIRADO, no olvidado.** Su propio encabezado declara su única razón de
ser: *"el runner on-prem no puede escribir a Postgres barato (el proxy público factura las
respuestas como egress). Este servicio recibe el changeset por HTTPS (ingress = GRATIS) y lo
escribe por red interna."* On-prem los carriles y la base quedan **en la misma máquina**, así
que el rodeo deja de comprar nada. `database/importers/lib/sink.js` ya tiene el interruptor:
`FEEDS_SINK=pg` + `DATABASE_URL_NEW` escribe directo. Es una simplificación que **la mudanza
se gana sola**. ⚠️ `FEEDS_INGEST_KEY` queda para **rotar**.

**`Megadulces-Logistica` — sin portar, y medido: NO es este código.** Está configurado con el
MISMO `/Dockerfile` que el API pero con **21 variables contra las 70 del API**: tiene
`DATABASE_URL` y Cloudinary, y **no tiene `JWT_SECRET` ni `DATABASE_URL_NEW`** — sin
`JWT_SECRET` no puede validar una sesión. Probado en vivo el 2026-09-22:

```text
https://megadulces-logistica-production.up.railway.app/            -> 200
                                        .../api/health             -> 404
título de la página servida:  "Megadulces | Control Logístico"
```

Y ese título **no es el de ninguna de las tres apps de este repo** (`view` y `portal` dicen
*Mega Dulces*, `vendor` dice *vendor-MD*). O sea que está sirviendo el bundle de **otro
código** — casi seguro el logístico standalone que la Fase J.9 portó dentro de `apps/view`,
congelado en el deploy de entonces. Es una cáscara: sirve HTML y su API no contesta.

⛔ **No se porta y tampoco se apaga desde acá.** Apagar algo que alguien podría tener
marcado es una decisión del dueño, no una deducción mía. Lo que hay que medir antes está
en Railway (logs de HTTP del servicio): si nadie le pega, es un servicio menos que pagar.

**`observability`** — es el destino de `OTEL_EXPORTER_OTLP_ENDPOINT`. Apagarlo no rompe la app
(el exportador de OTEL traga el error), pero tampoco se declara "migrado". Va en su sprint.

**El bucket `foldable-pannikin` (513 objetos / 597 MB)** — guarda **comprobantes financieros
en PDF**: entradas, pagos, cobranza, gastos, comprobaciones, caducidades, bancos. Son
**registros del negocio**, y es un tercer activo a migrar que el plan de VL no contemplaba.
Opciones: MinIO on-prem (el código habla S3 estándar y ya acepta `S3_ENDPOINT`), o seguir
pagándole a Railway sólo por el bucket. **Decisión abierta.**

---

## 6. Lo que BLOQUEA el corte

| # | Bloqueo | Estado medido | Quién lo destraba |
|---|---|---|---|
| 1 | ~~**El dominio en Railway**~~ ⭐ **SE CAE 2026-09-22 (tarde): no bloquea el corte on-prem** | El `Unauthorized` al crear dominio en Railway es real (restricción de **plan**, no de credenciales: los `railway variables --set` de la misma sesión funcionaron). Pero **ese dominio sólo hacía falta para la vía B**, que existe para que el dominio propio sirva *desde Railway* durante la convivencia. Con la vía **C** (§6.1) el dominio nuevo apunta al túnel **desde el día uno** y Railway nunca necesita un dominio propio. **Y lo que lo vuelve barato está medido:** las 3 apps web usan `apiUrl: '/api'` **relativo** — mismo origen — así que un dominio nuevo **no obliga a recompilar nada**. De las 564 ocurrencias de `up.railway.app` (37 archivos) sólo **13 archivos son código vivo**, y la única URL absoluta de la app es `NATIVE_API_URL`, del APK **que nadie usa** | — (decisión tomada: dominio nuevo en Cloudflare) |
| 2 | ~~**Cloudflare Tunnel**~~ ✅ **RESUELTO 2026-09-22** — `megadulcessuite.com` sirve prod por HTTPS | `cloudflared` declarado en el compose tras el perfil `tunel`, por token. **Verificado en vivo 2026-09-22**: (a) un túnel efímero sirvió la app entera por HTTPS real desde `md` —login renderizado, 0 errores de consola, `/api/health` respondiendo `067eae72`— y se cerró; (b) desde la red `prod_default` el contenedor del túnel alcanza `http://api:10000`, `http://portal:10000` y `http://vendor:10000`, los tres **HTTP 200** — que es exactamente lo que se carga en el tablero. **No falta código** | Registrar el dominio en la cuenta de Cloudflare y cargar `CLOUDFLARE_TUNNEL_TOKEN` en `~/secrets/prod-compose.env` (§6.2) |
| 3 | **VL.8 — aguante** | **Sin UPS gestionado** (`nut`/`apcupsd` ausentes), **sin respaldo fuera de sitio**, **un solo enlace** de 44 Mbit de subida compartido con la oficina y con los 14 carriles | Compra de UPS + destino de respaldo externo. Elegido como **precondición dura** |
| 4 | **La alarma no avisa** | El worker manda el correo (verificado en vivo) pero Gmail lo rechaza: `534-5.7.9 Application-specific password required`. `SMTP_PASS` tiene 11 caracteres; una contraseña de aplicación son 16 | Generar la contraseña de aplicación en la cuenta de Google y ponerla en `SMTP_PASS` de **los dos** servicios |
| 5 | ~~**El volcado correcto**~~ ✅ **RESUELTO 2026-09-22** | Era que el respaldo diario usaba `--no-privileges`. Desde `[VL.6.4]` el carril de `md` lo toma **con** privilegios, y `restaurar.sh` **aborta** si el volcado trae menos de 100 entradas `ACL` — o sea que el defecto ya no puede volver en silencio | — |
| 6 | **`JWT_SECRET` cambia** | El valor de Railway **contiene un salto de línea** y `env_file` de Compose no puede expresarlo. Recortarlo equivale a rotarlo | Decidirlo: rotar una sola vez y avisar que **todos re-loguean** |
| 7 | **El bucket** | 597 MB de comprobantes (§5) | Decidir MinIO on-prem o seguir en Railway |
| 9 | ~~**Los agentes en las cajas de sucursal**~~ ⭐ **SE DESARMA 2026-09-23: no hay cajas que tocar** | Esta fila decía *"están instalados en las máquinas de tienda"* y *"hay que tocar cada caja"*. **Falso hoy.** Wincaja **ya no existe** — sus POS migraron a Kepler (`MD-32`→`md_07` el 08-sep, `MD-30`→`md_08` el 18-sep, Canindo→`'06'`), y los datos lo confirman: los códigos `MD-*` **cortan exactamente en esas fechas** y llevan **0 tickets en 24 h**, mientras `01`–`08` entregan con **0–4 minutos** de rezago. Las 8 ramas las lee **`store-poller`, que corre EN `md`**. ⇒ El único cliente remoto del endpoint son **dos contenedores de `md`** (`store-poller`, `feeds-livefast`): **dos variables, no treinta máquinas**. ⛔ **Y no se tocan hoy**: Railway sigue siendo prod, repuntarlas mandaría la venta viva a la copia | — (pasa a ser un renglón del corte, no un bloqueo) |
| 8 | ~~**El RPO**~~ ✅ **RESUELTO 2026-09-22** | ⭐ **No estaba en esta lista y era el peor**: prod corre pgBackRest con `archive_mode=on` y la copia estaba en `off` — el corte bajaba la recuperación de *minutos* a *24 horas*, en silencio. Cerrado en §9 | — |

### 6.1 El dominio: por qué no alcanza con apuntar el DNS, y las tres vías

**Lo que NO funciona**, y conviene saberlo antes de perder una tarde: poner un `CNAME` de
`app.megadulces.com.mx` a `megadulces.up.railway.app` **no sirve**. Railway rutea por el
**encabezado `Host`**, así que una petición que llega con `Host: app.megadulces.com.mx` no
coincide con ningún dominio registrado y Railway contesta *"Application not found"*. El DNS
sólo resuelve la IP; no cambia el `Host`.

Eso vale **si se quiere seguir sirviendo desde Railway** con dominio propio. Tres vías:

**A) Dominio propio en Railway (lo natural).** Settings → Networking → *Custom Domain* en cada
servicio, y Railway devuelve el `CNAME` a cargar en HostGator. ⛔ **Intentado por CLI el
2026-09-22 y rechazado con `Unauthorized`** aunque la sesión es válida y las escrituras de
variables de esa misma sesión funcionaron — o sea, restricción de **plan**. El dashboard va a
decir cuál; si pide subir de plan, ése es el costo real de esta vía.

**B) Un Worker de Cloudflare que reescriba el `Host`.** Si (A) resulta cara o imposible, se
pone el dominio en Cloudflare (que igual hace falta para el túnel, §6 #2) y un Worker chico
reenvía a `megadulces.up.railway.app` **reescribiendo el `Host`**. Los clientes ya hablan con
`*.megadulces.com.mx` desde el día uno, y el día del corte el Worker se retira y el `CNAME`
pasa a apuntar al túnel. ⚠️ Cuesta un salto de red extra y un componente más que mantener
mientras dure la convivencia — pero **compra exactamente lo que importa: que el corte sea
reversible sin tocar un solo equipo en campo**.

⚠️ **Y la advertencia sobre el APK, MEDIDA — y la medición la desactiva.** La app nativa de
vendedor trae la URL **compilada adentro** (`NATIVE_API_URL`), así que un dominio nuevo no la
alcanzaría hasta reconstruirla y redistribuirla. Pero el censo de inicios de sesión de 30 días
dice que **nadie la usa**: 64 escritorio · 10 Android **navegador** (Chrome 151-153 Mobile, sin
el marcador `; wv)` de un WebView) · 2 iOS · **cero sesiones nativas**. Coherente con que su
host compilado (`trademarketing-production-5084.up.railway.app`) **responda 404** desde hace
quién sabe cuánto. ⇒ **Reconstruir y redistribuir el APK NO es parte del corte.** Un bloqueo
que se cae al medirlo.

**C) ⭐ El dominio nuevo apunta al túnel desde el día uno — DECIDIDO 2026-09-22.** Ni dominio
en Railway ni Worker. Se registra un dominio **nuevo y barato** directamente en Cloudflare
(`~$10-15 USD/año`), se crea el túnel, y ese dominio sirve `md`. Railway conserva su
`*.up.railway.app` mientras dure la convivencia, y el corte es *"la URL nueva es ésta"*.

Lo que la vuelve viable está **medido**, no supuesto:

| Hecho | Medido |
|---|---|
| Las 3 apps web llaman a `apiUrl: '/api'` **relativo** | `environment.ts` de `view`, `portal` y `vendor` — mismo origen, el `nginx` del contenedor proxya `/api` |
| ⇒ un dominio nuevo **no obliga a recompilar** ninguna app | por eso `https://<host>/api/health` contestó `067eae72`, el build de `md`, y no datos de Railway |
| La única URL absoluta de Railway en la app es `NATIVE_API_URL` | y es del **APK que nadie usa** (censo de 30 días: cero sesiones nativas) |

⚠️ **Lo que se pierde frente a la vía B, dicho sin adorno:** la vía B compra que el corte sea
*reversible sin tocar un equipo*, porque los clientes hablan con el mismo nombre antes y
después. Con la vía C el regreso es *"vuelvan a la URL vieja"*. Para ~100 personas de la casa
es un mensaje; para un cliente externo no lo sería. **Se elige C porque el dominio de hoy es
`*.up.railway.app` y ése no se puede mover: la URL iba a cambiar de todos modos.**

⛔ **Y lo que la vía C NO resuelve** — los agentes de las cajas de sucursal (§6 #9) tienen su
URL de ingesta clavada en cada máquina. Ésos sí hay que tocarlos uno por uno.

---

### 6.2 El túnel, paso a paso — qué puede hacer el código y qué no

`cloudflared` ya está en el compose tras el perfil `tunel`, y lo que dependía de medir ya se
midió (§6 #2). **Lo único que falta es lo que un programa no puede hacer**: dar de alta un
dominio con una tarjeta y autorizar en un navegador.

**Lo humano (una vez, ~10 min).** En el tablero de Cloudflare, con la cuenta de la empresa:

1. **Registrar el dominio.** *Domain Registration → Register Domain*. ⚠️ Registrarlo **ahí
   dentro** y no en otro lado: así la zona DNS queda en Cloudflare sola, sin tocar
   nameservers de nada.
   ⛔ **NO se usa `megadulces.com.mx`**: su DNS vive en HostGator (`ns*.websitewelcome.com`)
   y sus **MX apuntan a Google Workspace**. Moverlo a Cloudflare exige cambiar los
   nameservers del dominio **entero** — si un registro no se importa bien, **se cae el correo
   de la empresa**. No hay ninguna razón para correr ese riesgo: el dominio de hoy tampoco es
   ése.
2. **Crear el túnel.** *Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared*.
   Nombre sugerido: `md-prod`. Copiar el **token**.
   ⚠️ Puede aparecer un túnel viejo llamado `megadulcesservice`: es de un intento anterior que
   **nunca pudo funcionar** —su `cloudflared-config.yml` enrutaba a hostnames
   `*.trycloudflare.com`, que son de Cloudflare y no se pueden reclamar— y su archivo de
   credenciales apuntaba a una ruta de Windows que ya no existe. Se puede borrar.
3. **Publicar los tres hostnames** (*Public Hostnames* del mismo túnel). Los destinos están
   **verificados alcanzables** desde la red `prod_default`:

   **Dominio registrado el 2026-09-22: `megadulcessuite.com`** (Cloudflare, plan free).
   Verificado desde fuera, no sólo en el tablero: nameservers `dom.ns.cloudflare.com` /
   `karina.ns.cloudflare.com`, y los **MX de `megadulces.com.mx` siguen en Google** — el
   correo de la empresa no se tocó.

   | Hostname | Service | Qué es |
   |---|---|---|
   | `megadulcessuite.com` (apex) | `http://api:10000` | la suite (`apps/view`) + la API |
   | `portal.megadulcessuite.com` | `http://portal:10000` | portal B2B |
   | `vendedor.megadulcessuite.com` | `http://vendor:10000` | app de vendedor en campo |
   | ~~`ingest.megadulcessuite.com`~~ | — | ⛔ **NO se publicó**, a propósito. Ver §6 #9 |

   ⚠️ El apex sirve para la suite gracias al *CNAME flattening* de Cloudflare; un subdominio
   sería igual de válido y se cambia en un clic. Se elige el apex porque es la URL que la
   gente va a teclear.

**Lo que hace el código, después.** El token **no se pega en un chat ni se commitea** — va
directo al archivo de secretos de `md`:

```sh
# en md, una sola vez (el token nunca pasa por el repo ni por la conversación)
printf 'CLOUDFLARE_TUNNEL_TOKEN=%s
' '<pegar aquí>' >> ~/secrets/prod-compose.env
chmod 600 ~/secrets/prod-compose.env

# levantar el túnel
cd ~/ops/prod && set -a && . ~/secrets/prod-compose.env && set +a   && docker compose -p prod --profile tunel up -d cloudflared
```

⛔ **Y el paso que se olvida y hace que parezca que no sirvió**: con el túnel adelante, TLS lo
termina Cloudflare, así que `TLS_TERMINADO` vuelve a **`true`** en los tres servicios web del
compose. Hoy está en `false` **a propósito** (`[VL.9.12]`, §7) porque `md` se sirve por HTTP
plano; dejarlo en `false` detrás del túnel significa servir sin `HSTS` ni
`upgrade-insecure-requests` **teniendo TLS**, que es justo cuando esas dos cabeceras sirven.

**Cómo se comprueba que quedó** — el rótulo no es el veredicto:

```sh
curl -s https://megadulcessuite.com/api/health          # debe decir el commit de md
# con TLS_TERMINADO=true las DOS cabeceras deben volver (detras del tunel si hay TLS)
curl -s -o /dev/null -D - https://megadulcessuite.com/ | grep -iE 'strict-transport|upgrade-insecure'
```

---

## 7. Lo que se arregló de paso, porque estaba roto

Cosas encontradas midiendo, **anteriores a esta fase** y ajenas a la mudanza:

1. **El respaldo de prod llevaba 12 días sin producir un solo archivo.** `backup-db.ps1` tenía
   un ParserError (`"$MinTables:"` se lee como variable calificada por unidad) y **un
   ParserError no falla esa línea: hace que el archivo entero no compile**. La tarea "corría"
   todos los días con `LastTaskResult = 1`. Arreglado, y con compuerta nueva
   (`npm run check:powershell`) que parsea los 26 `.ps1` versionados — varios de los cuales
   corren **desatendidos en cajas de sucursal**.

   ⭐ **Y el matiz que más enseña: no fue invisible.** La detección funcionó **tres veces** y
   ninguna cerró el lazo:
   - `db-health` tenía el umbral bien puesto (`warnH 26 / critH 50`) y la alerta está en
     **`critical` desde el 13-sep**;
   - el Programador devolvía `LastTaskResult = 1` **todos los días**;
   - y un humano lo escribió: la **auditoría de bases del 2026-09-14** lo anotó textualmente
     — *"`backup_prod` sin correr 2.8 d en `.249`"* — y lo **ruteó a VL.5**, una fase que no
     había empezado. Quedó clasificado como *"deuda operativa con dueño"*.

   O sea que el sistema **sí sabía**. Lo que falló fue el tramo entre saber y actuar: la
   alerta no tenía canal (§7.2), el código de salida no lo mira nadie, y el hallazgo escrito
   se archivó en una fase futura. **Un hallazgo ruteado a una fase que no arrancó es un
   hallazgo apagado**, y conviene que eso tenga nombre antes de que vuelva a pasar.

2. **La alarma se computaba donde no había canal.** El scanner de Salud BD corre en el
   `worker`, y `SMTP_*` + `DB_HEALTH_ALERT_EMAILS` estaban sólo en `MegaDulces`. Medido:
   `max(last_notified_at)` **NULL en toda la tabla** — el sistema nunca envió un correo.
   Copiadas al worker; ahora sí intenta (y falla por el bloqueo #4 de arriba, que es otra
   cosa y ahora se ve).

3. **Los 48 `@Cron` corren por duplicado.** Ni `MegaDulces` ni `worker` definen
   `DISABLE_CRONS`, así que `ScheduleModule` se registra en los dos. **Verificado en los logs
   de producción**: el API imprime `Cron in-process ACTIVOS (48 @Cron)`. Anula el propósito
   declarado del worker-tier (ADR-043) y crea **dos dueños por `job_key`** — el mismo pecado
   que `ops/README.md` nombra para los carriles. **Corregido en el stack on-prem** (el `api`
   lleva `DISABLE_CRONS=true`); **en Railway sigue igual**, porque cambiarlo es un cambio de
   comportamiento de producción que hay que decidir, no deducir.

   ⚠️ **Y el arreglo del punto 2 lo vuelve visible**: ahora los DOS servicios tienen el canal
   de correo, así que en cuanto la contraseña de aplicación funcione **cada alerta va a llegar
   dos veces**. No es un defecto nuevo — es el defecto viejo saliendo a la superficie, porque
   antes el duplicado no se notaba: ninguno de los dos podía enviar nada. Dos correos por
   alerta es exactamente el tipo de ruido que enseña a ignorar el tablero (el repo ya midió
   *488 alertas, cero reconocidas en cinco semanas*), así que conviene resolver esto **antes**
   de poner la contraseña, no después.

   ⚠️ Corolario a saber antes de aplicarlo: con `DISABLE_CRONS=true` en el API, **si el worker
   está abajo no corre ningún cron**. Hoy el API los cubre por accidente. Por eso el worker
   necesita su healthcheck de entrega (§4).

---

## 8. [VL.6.4] El respaldo de prod se mudó a `md` — y con eso deja de ser PowerShell

El respaldo diario ya no es una tarea del Programador de Windows: es el servicio `prod-backup`
del compose (`ops/prod/backup-prod.sh` + `ops/prod/crontab.backup`), **22:00 MX**, con volcados en
`/home/superoot/backups` del servidor.

**La razón NO es que Linux sea mejor, y conviene decirlo porque el argumento fácil era otro.**
Se midió el cable con el mismo comando desde las dos máquinas y dan casi igual (218 vs 260
MB/min, §3.0). Lo que decide:

- **La tarea de Windows no corre sin sesión iniciada.** Ya está medido que eso pasa: el
  2026-09-11 `WincajaSyncActual` no corrió tras un reinicio nocturno y dejó su pierna del
  sell-out tres días atrás. Los contenedores de `md` arrancan sin sesión — verificado con un
  reinicio real.
- **El cliente coincide con el servidor.** `md` trae `pg_dump` **18.6**, la misma minor que
  prod; la laptop trae 18.4.
- **Desaparece una clase entera de fallo** — la del ParserError de §7.1, donde el archivo no
  llega ni a compilar.
- **Es el ensayo del corte.** El restore del corte ocurre en `md`. Tomar acá el volcado cada
  noche es ensayar ese camino todas las noches, en vez de estrenarlo el día que importa.

### Lo que cambió respecto del script viejo, con su motivo

| | PowerShell (`.249`) | `prod-backup` (`md`) |
|---|---|---|
| ¿Es prod el destino? | por **host y nombre de base** | por **CONTENIDO**: ≥200 tablas en `kepler_ods` (prod tiene 240) |
| Privilegios | `--no-privileges` | **sí los trae** (§3) |
| Hora | 17:00, en horario laboral | 22:00 |
| Arranque | sesión de usuario | contenedor, sin sesión |
| `host` del latido | `SISTEMAS` | `md-backup` |

⭐ **Por qué la compuerta mira el contenido y no el host:** una regla por host ("no puede ser la
LAN") **se rompe sola el día del corte**, cuando prod pase a ser `pg-prod` en esta misma máquina
— o sea justo cuando más falta hace. Y lo que delató el bug del 08-sep no fue el host: fue que el
volcado traía **1 tabla de `kepler_ods`** donde prod tiene 226.

### Un solo dueño

`TradeMarketing-DailyBackup` quedó **deshabilitada, no borrada** (mismo criterio que VL.4b). Con
las dos habilitadas habría **dos dueños de `backup_prod`**, que es el pecado que `ops/README.md`
nombra para los carriles — y dos volcados de 75 min saturando el mismo enlace de 44 Mbit.

### Cómo se probó, sin esperar a las 22:00

```sh
# ejercita TODAS las compuertas en ~2 min y NO toca el latido real
docker exec prod-backup /usr/local/bin/backup-prod.sh --prueba
```

Corrido el 2026-09-22: 240 tablas de `kepler_ods` · 330 GB libres · TOC con 1,830 entradas ·
retención · TZ `CST`. Y el camino de `cron` se probó con un canario de un minuto dentro del
contenedor — porque **"el contenedor está arriba" no prueba que `cron` haya leído el archivo**:
`/etc/cron.d` ignora en silencio los archivos con punto en el nombre, escribibles por grupo, o
sin salto de línea final.

⬜ **Falta:** la primera corrida real (22:00 de hoy). El veredicto es el latido `backup_prod` con
`host = md-backup`, no que el contenedor esté `Up`.

---

## 9. [VL.9.6] pgBackRest — el corte iba a bajar el RPO de minutos a 24 horas

Medido el 2026-09-22, consultando las dos bases:

| | Railway (prod hoy) | `pg-prod` en `md` (antes de esto) |
|---|---|---|
| `archive_mode` | **`on`** | **`off`** |
| `archive_command` | `pgbackrest-archive-push-wrapper.sh %p` | *(disabled)* |

⛔ **Prod ya corre pgBackRest.** La copia no. O sea que el corte, tal como estaba planeado,
cambiaba *"puedo volver a cualquier minuto"* por *"tengo la foto de anoche"* — y eso **no
figuraba en ninguno de los 7 bloqueos** de §6. Esto no es una mejora: es reponer una capacidad
que se estaba por perder en silencio.

Y es lo único de la lista que **no escala solo**: con 10× (340 GB) el volcado completo pasa de
~75 min a **~12 h** y deja de existir como estrategia. El archivado continuo de WAL es lo que
sigue funcionando a esa escala, y montarlo es más caro cuanto más grande está la base.

### Son DOS respaldos, no uno con dos nombres

| | `prod-backup` (`pg_dump`, 22:00) | pgBackRest (continuo) |
|---|---|---|
| Qué da | un archivo **portátil** | recuperación a **un punto en el tiempo** |
| Restaura | otra versión de Postgres, otra máquina, **una sola tabla** | el **mismo clúster**, entero |
| RPO | 24 h | minutos (`archive_timeout=300`) |
| Sobrevive a | que se pierda el servidor | que alguien borre una tabla a las 11:40 |

La regla 3-2-1 pide los dos. ⬜ Y por ahora **los dos viven en la misma máquina**: el "fuera de
sitio" sigue abierto (VL.8).

### Cómo se enciende — el orden importa

⛔ **Encender `archive_mode` con el repositorio sin inicializar hace que `archive_command`
falle en CADA segmento y el WAL se acumule hasta llenar el disco.** Por eso el interruptor es
una variable (`PGPROD_ARCHIVE_MODE`, por defecto `off`) y el orden es éste:

```sh
# 1. la variable y recrear la base
echo 'PGPROD_ARCHIVE_MODE=on' >> ~/secrets/prod-compose.env
cd ~/ops/prod && set -a && . ~/secrets/prod-compose.env && set +a
docker compose -p prod up -d pg-prod

# 2. crear el stanza
docker exec -u postgres pg-prod pgbackrest --stanza=prod stanza-create

# 3. ⭐ LA PRUEBA DE VERDAD: fuerza un cambio de WAL y verifica que LLEGÓ al repositorio
docker exec -u postgres pg-prod pgbackrest --stanza=prod check

# 4. el primer respaldo completo
docker exec -u postgres pg-prod pgbackrest --stanza=prod --type=full backup
```

⚠️ **Sin el paso 4, el WAL archivado no sirve para nada**: una recuperación a un punto en el
tiempo necesita una base completa desde la cual reproducir.

### Las dos trampas que ya mordieron, para que no muerdan de nuevo

**1. El `chown` de la imagen NO aplica sobre un montaje del host.** El `Dockerfile` hace
`chown postgres` sobre `/var/lib/pgbackrest`, pero un *bind mount* **reemplaza** ese directorio
por el del host, que llega con el dueño del host (uid 1000) — y `postgres` adentro es uid **999**.
Resultado: `archive_command` habría fallado en cada segmento. Se detectó porque la verificación
**intentaba escribir**, no porque comprobaba que el directorio existiera. El arreglo, sin sudo:

```sh
docker run --rm -v /home/superoot/pgbackrest:/r alpine:3 \
  sh -c 'chown -R 999:1000 /r && chmod -R 0750 /r && chmod g+s /r'
```

Grupo 1000 + `setgid` a propósito: `postgres` escribe, **`superoot` lee** — sin eso, la copia
fuera de sitio de VL.8 no podría leer su propio repositorio.

**2. pgBackRest NO comenta con `;`.** Su parser no es INI estándar: con `;` aborta con
*"key/value found outside of section at line 1"* y **ni `stanza-create` ni `check` arrancan**.
Los comentarios van con `#`. Se descubrió con el archivado **ya encendido**, o sea con el WAL
acumulándose mientras el comando que debía archivarlo no llegaba a ejecutarse.

### ✅ Agendado — y dónde corre, que era la decisión abierta

`ops/prod/pgbackrest-run.sh`, por el cron de `prod-backup`: **completo los domingos 23:30,
diferencial el resto**. Después del volcado de las 22:00, que cierra ~23:15.

⚠️ **No era opcional**: pgBackRest expira el WAL **atado a los respaldos**. Con un solo completo,
el WAL archivado desde entonces no se borra nunca — medido, el repositorio pasó de 4 GB a 12 GB
en tres horas y sin un respaldo nuevo ese crecimiento no tiene tope, en el mismo disco donde
viven los 9 contenedores de la ingesta.

**Dónde corre.** pgBackRest necesita dos cosas a la vez: leer `PGDATA` **y** hablar con Postgres,
y la conexión sólo la sabe hacer por **socket UNIX local** — no acepta un host TCP. De las tres
formas posibles se eligió la tercera:

| | Costo |
|---|---|
| dentro de `pg-prod` | su imagen corre postgres como PID 1; meterle un segundo proceso es frágil |
| `prod-backup` + socket de Docker | **root en el host**, y ese contenedor ya tiene la credencial de la base |
| ⭐ **compartir los dos recursos** | volumen de datos en **sólo lectura** + directorio del socket. **Cero privilegio nuevo** |

⚠️ Y lo lanza cron como **root**, que baja a `postgres` sólo para el comando: el archivo de
secretos es de `superoot` y uid 999 no puede leerlo, pero pgBackRest **se niega a correr como
root**. Los dos usuarios son necesarios y ninguno alcanza solo.

Con latido propio (`pgbackrest_backup`) y umbral registrado en `CRON_JOBS` — sin umbral,
`db-health` cae en `cfg ? classify : 'ok'` y el latido sería decoración.

### ✅ El ensayo de recuperación — superado, y las tres cosas que sólo aparecen restaurando

`ops/prod/probar-pitr.sh` (o `deploy.sh --pitr`). Escribe dos marcas con un instante en medio
—**A → T_objetivo → B**— restaura a `T_objetivo` en un directorio aparte, levanta un Postgres
temporal en el 5436 y exige **A presente y B ausente**. De los tres resultados posibles sólo uno
prueba algo: si están las dos, el punto en el tiempo no se respetó; si no está ninguna, no
recuperó nada.

**Resultado 2026-09-22**: restauración en 33 s · `A=1, B=0` · 240 tablas en `kepler_ods` ·
`pg-prod` intacto. **El respaldo deja de ser una hipótesis.**

⭐ Y falló dos veces antes de pasar, por cosas que `pgbackrest info: status ok` no puede ver:

1. **pgBackRest hornea el `--pg1-path` dentro del `restore_command`.** Restaurando en `/restore`
   y arrancando en `/var/lib/postgresql/18/docker`, la recuperación moría con
   `archive-get ERROR [073]: unable to chdir() to '/restore'`, y Postgres lo reportaba como
   *"could not locate required checkpoint record"* — un mensaje que **no nombra ni la ruta ni
   pgBackRest**. ⇒ Un clúster restaurado en una ruta temporal **no puede recuperar en ninguna otra**.
2. **El clúster restaurado necesita los parámetros de recursos del original.** `FATAL: recovery
   aborted because of insufficient parameter settings — max_connections = 100 is a lower setting
   than on the primary server (200)`. Son cinco parámetros y basta que **uno** quede corto. El
   ensayo los **lee de `pg-prod`** en vez de escribirlos a mano, para que no se desincronicen.
   ⚠️ Eso va a pasar igual en una recuperación de verdad sobre una máquina configurada más chica.
3. **El ensayo borraba su propia evidencia al fallar.** La primera corrida se llevó el directorio
   restaurado y los logs justo cuando había algo que mirar, y hubo que reproducir el fallo para
   poder verlo. Ahora conserva todo y dice dónde está.

### Lo que falta

- ⛔ **Fuera de sitio** (VL.8): volcados, repositorio de pgBackRest **y la base** viven en el mismo
  disco de la misma máquina. Eso es *una* copia, no 3-2-1. Necesita hardware.
- ⬜ **Automatizar el ensayo**: hoy `--pitr` se corre a mano. Un ensayo que no se repite envejece
  igual que un respaldo que no se prueba.
---

## 10. El camino: qué está hecho, qué falta, y qué cambió del plan original

> Esta sección es **el plan**. Vive acá y no en un archivo de sesión porque los `.md` del repo
> son la memoria compartida entre máquinas: un roadmap que sólo ve una sesión no existe.
> Última medición: **2026-09-22**.

### 10.1 Hecho, y verificado con datos

| | Qué | Cómo se comprobó |
|---|---|---|
| ✅ | **El sustrato**: `pg-prod` (5434) + `pg-rag` (5435), PostgreSQL **18.6** — la misma minor que Railway — con TLS, los 3 roles con su hash real y **1,217 GRANT** aplicados | `pg_authid` comparado fila por fila contra prod; TLSv1.3 negociado |
| ✅ | **Las 6 imágenes** construidas en `md`; `api`, `worker`, `portal` y `vendor` sirviendo | `/api/health` 200 con su commit · `/api/sucursales` con sucursales reales · `/api/kp/precios-todos` 9,532 productos en 0.85 s |
| ✅ | **El respaldo diario** mudado del Programador de Windows a `md` (contenedor `prod-backup`, 22:00 MX), con 3 compuertas y clasificación del destino **por contenido** | Modo `--prueba` completo + canario de `cron` de un minuto. Tarea de Windows **deshabilitada** (un solo dueño) |
| ✅ | **pgBackRest**: archivado continuo de WAL + primer respaldo completo | `check` forzó un WAL y confirmó que llegó al repositorio · **20.3 GB → 4 GB en 66 s** · sensor `wal_archive` en Salud BD |
| ✅ | **El restore** como guion con compuertas + esperador que aguarda la *señal*, no el reloj | 4 pruebas: sin privilegios aborta · con privilegios pasa · piso de tablas aborta · volcado viejo aborta |
| 🟡 | **La copia** de los 34 GB: restaurada, **pero no fiel** (724 de 825 migraciones) | Y se sabe por qué: §3.3. Se reemplaza esta noche con un volcado fresco |

### 10.2 Lo que cambió respecto del plan original, por medición

| Lo que decía el plan | Lo medido | Consecuencia |
|---|---|---|
| Volcado de **6.1 h** a 6.22 MB/min → *"un corte por dump/restore no es viable"* | **~30 MB/min, ~75 min** (4 respaldos reales). La tasa vieja se midió **durante el cuelgue del socket muerto** — cronometrando un proceso que no transfería | La ventana del corte es **~2.5 h**. `wal_level=logical` deja de ser obligatorio: pasa a optativo |
| El enlace es el cuello de botella | **218 MB/min desde `SISTEMAS`, 260 desde `md`** con el mismo comando | El enlace no es el problema. Lo caro del volcado es el **catálogo**: 121 s antes del primer byte |
| **Coolify orquesta**, `deploy.sh` construye | Coolify 4.3.23 **no tiene el tipo `dockerimage`**; los 5 build packs exigen `git_repository` + `git_branch`. No puede adoptar una imagen ya construida. Y su proxy **tumbó la API 50 minutos** al quedarse con el puerto 8080 | **DESINSTALADO el 2026-09-22** (§10.4). Los 4 servicios siguen en este compose |
| 7 bloqueos del corte | Apareció el **#8** y no estaba en ninguna lista: prod corre pgBackRest y la copia no → el corte **bajaba el RPO de minutos a 24 h** | Cerrado en §9. Es el hallazgo de más valor de la fase |
| — | **No existe rollback**: las 6 imágenes son `:latest` y las versiones anteriores quedan **sin etiqueta**; un `docker image prune` las borra | Hueco nuevo, §10.3 |

### 10.3 Lo que falta — ordenado por lo que cuesta, no por lo que entusiasma

**Sin depender de nadie:**

1. ⬜ **Verificar el restore de esta noche.** El veredicto es `/api/sucursales` con datos, no que los contenedores arranquen.
2. ✅ **Imágenes etiquetadas por commit** + poda a 5 versiones + `deploy.sh --volver <commit>`. Ya hay a qué volver. ⚠️ Y `/api/health` reporta el commit **de la imagen**, no `git HEAD`: con ~10 sesiones commiteando, HEAD se mueve entre construir y desplegar y el campo decía una versión que no era la que corría.
3. ✅ **Respaldos de pgBackRest agendados** — completo semanal + diferencial diario, corriendo desde `prod-backup` con el volumen de datos en sólo lectura y el socket compartido: **cero privilegio nuevo**. Ver §9.
4. ✅ **Recuperación a un punto en el tiempo, PROBADA** — `A=1, B=0` sobre un clúster restaurado aparte. Falló dos veces antes de pasar, por cosas que `pgbackrest info` no puede ver (§9).
5. ⬜ **`verificar-copia.sh` completo** contra prod, una vez que la copia sea fiel.

**Requiere una persona:**

| | Qué | Por qué está trabado |
|---|---|---|
| ⛔ | **Rotar las credenciales** que se pegaron en una conversación | Es lo único urgente |
| ⛔ | **El dominio** en Railway (§6.1) | El CLI devuelve `Unauthorized` sólo al crear dominio → restricción de plan |
| ⛔ | **Cuenta de Cloudflare** + token del túnel | No existe |
| ⛔ | **Contraseña de aplicación de Google** para `SMTP_PASS` | Gmail rechaza una de 11 caracteres; son 16 |
| ⛔ | **VL.8**: UPS, respaldo fuera de sitio, segundo enlace | Precondición dura elegida por el usuario |
| ❓ | **Decidir**: `DISABLE_CRONS=true` en `MegaDulces` de Railway · rotar `JWT_SECRET` · el bucket · parar Coolify | Son decisiones de producto, no técnicas |

**Contra el estándar, no contra este corte** (§ *"debemos seguir estándares"*):

- ⛔ **La CI está apagada** (`disabled_manually` desde el 25-ago) y `main` **no tiene ningún required status check**. Los 4 gates existen y se corren a mano. *Un gate que depende de que alguien se acuerde no es un gate.* Es el hueco más grande que tiene el proyecto y no lo abre esta fase.
- ⚠️ **Secretos en texto plano** en varios lanzadores.
- ⚠️ **3-2-1 incompleto**: repositorio, volcados y base viven en **el mismo disco de la misma máquina**.

### 10.4 Coolify: instalado, medido, y DESINSTALADO el mismo día

Se instaló por decisión del usuario como capa de orquestación. Se quitó doce horas después,
con tres mediciones y un incidente.

**1. No podía hacer el trabajo.** Su enum de tipos de despliegue
(`nixpacks · railpack · static · dockerfile · dockercompose`) **no incluye ninguno que parta de
una imagen ya construida**, y los cuatro endpoints de creación exigen `git_repository` +
`git_branch`. Sólo quedaban dos entradas, y las dos rompen algo:

- **Service con compose pegado** → el compose vive en su base, duplicando el archivo versionado.
  Dos dueños de la misma verdad, que es justo lo que `ops/vl` y `ops/prod` existen para evitar.
  Y su botón *"Pull latest images"* haría `docker compose pull` de tags que no están en ningún
  registro: rompe el despliegue desde el panel.
- **Application desde git** → despliega lo *pusheado*, no lo probado, y agrega una credencial.

**2. ⛔ No era pasivo: tumbó la API.** Su proxy (Traefik) ata 80, 443 **y 8080** — el puerto del
API. Cadena medida el 2026-09-22:

| Hora | Qué pasó |
|---|---|
| 16:04 | `restaurar.sh` paró `prod-api` → el 8080 quedó libre |
| ~16:16 | **el proxy de Coolify tomó el 8080** |
| 16:28 | el `docker start` del restore falló con *"port is already allocated"* … y el error estaba silenciado con `>/dev/null 2>&1` → el guion reportó **código 0** |
| 16:28–17:20 | **la API abajo 50 minutos**, y nada lo dijo |

**3. Y se resucitaba solo.** Se paró el proxy; **veinte minutos después estaba `Up` otra vez**.
Tiene un lazo de control (`ServerManagerJob`) que lo rearma. O sea que apagarlo una vez no
alcanzaba: mientras viviera, iba a volver a pelear por ese puerto.

**Contra los cuatro marcos** (§10.2 nombra cuáles): GitOps → **negativo** (duplicaría la fuente
de verdad) · DORA → **nada** (no desplegaba nada) · SRE → nada hoy · seguridad → **negativo**
(panel con cuenta de administrador y lazo de control propio, en la máquina que va a tener los
datos de prod). Y **tampoco compra el futuro**: al 10×, si hace falta más de una máquina, lo que
se necesita es un **planificador** —que decida dónde corre cada cosa y la mueva cuando un nodo
cae—, y Coolify administra varios servidores pero **despliega a cada uno**: no reprograma ni
hace failover.

**Qué se quitó**, verificado limpio: 6 contenedores · 2 volúmenes (su base y su redis, o sea la
cuenta de administrador) · 1 red · 7 imágenes (~3 GB) · `/data` entero (sólo contenía coolify,
1.5 MB). **No dejó units de systemd ni entradas de cron** — se comprobó antes de borrar.

⚠️ **Queda UN rastro, a propósito**: el instalador reescribió `/etc/docker/daemon.json` con
rotación de logs (`max-size 10m`, `max-file 3`) y `default-address-pools: 10.0.0.0/8`.
**No se revierte**, por dos razones: la rotación de logs es una mejora que conviene conservar, y
deshacerlo exige **reiniciar el demonio de Docker**, o sea rebotar los 9 contenedores de la
ingesta para desarmar algo que no molesta (las redes existentes conservaron su subred, medido).

⭐ **La lección que deja, más allá de Coolify**: un componente sin responsabilidad no es neutro.
Éste no desplegaba nada y aun así se llevó el puerto del servicio principal y lo mantuvo caído
50 minutos. *"Lo dejo por si acaso"* tiene precio, y acá se pagó el mismo día.
---

## 11. [VL.11] La red interna deja de salir a internet para hablar con el servidor de al lado

El túnel dejó prod alcanzable, pero midiendo el resultado apareció el costo:

| Camino (desde una máquina de la oficina) | TTFB | total |
|---|---|---|
| **LAN directo** a `md` | 5.7 ms | **5.9 ms** |
| **por el túnel** (`megadulcessuite.com`) | 225 ms | **225–453 ms** |

**38–76× más lento para gente sentada en el mismo edificio que el servidor.** Una pantalla que
encadena 10 llamadas suma 2.2–4.5 s, o sea que el camino actual **rompe la regla del propio
proyecto** (*">1 s de carga = no funciona"*). Y el enlace de subida son 44 Mbit **compartidos**
con la oficina y los 14 carriles, así que el mismo byte se paga dos veces.

⭐ **El hallazgo que unifica el trabajo.** `database/importers/kepler/install-service.js:47`
**rechaza** una URL de ingesta que no sea `https://`, con el motivo escrito: *"la clave viaja en
el header"*. O sea que el plan de §6 #9 —apuntar las cajas a `http://192.168.0.222:8080/…`— lo
**bloquea una compuerta de este mismo repo, y con razón**. La solución correcta de la ingesta
resulta ser **la misma** que la del DNS: TLS local + resolución interna. Un trabajo, dos
problemas.

### Estado

| | Qué | Estado |
|---|---|---|
| **C** | El commit se **hornea en la imagen** (`ARG GIT_COMMIT_SHA`) + `--build-arg` en `deploy.sh` + un resolvedor único en `apps/api/src/build-info.ts` | ✅ |
| **D** | `deploy.sh` construye **sólo lo que se le pide**; entrada `--tunel`; `NODE_ENV` explícito en `portal`/`vendor` | ✅ |
| **A** | **TLS local en `md`** (Caddy + Let's Encrypt por DNS-01) + **DNS partido** en los MikroTik | 🧪 **certificado VIVO y verificado**; faltan las 3 líneas **por plaza** |
| **B** | La ingesta de las cajas vuelve a la LAN, **sin dejar de ser HTTPS** | ⬜ depende de A |
| **E** | RAM — **medir antes de afinar** | ⬜ |

### C — por qué el commit se hornea

`/api/health` respondió `{"commit": ""}` **dos veces** el 2026-09-22, la segunda al levantar el
túnel. Dos causas encadenadas, y las dos están arregladas:

1. `GIT_COMMIT_SHA` viajaba **sólo** como prefijo de entorno en `deploy.sh recrear()`. Cualquier
   `docker compose up` que no pasara por ahí lo dejaba vacío — y `cloudflared` declara
   `depends_on: [api, portal, vendor]`, así que levantarlo recrea el API sin la variable.
2. `app.controller.ts` usaba `??`, que es **nullish**: `"" ?? 'unknown'` devuelve `""`. El
   respaldo nunca entraba. ⚠️ Un campo con el valor equivocado es peor que uno ausente — nadie
   lo reporta, porque el endpoint sigue devolviendo 200.

⭐ De paso aparecieron **dos mentiras más del mismo dato**: `otel.ts` e `instrument.ts` leían
**sólo** `RAILWAY_GIT_COMMIT_SHA`, que on-prem no existe → toda traza salía etiquetada `dev` y
**todo error de producción llegaba a Sentry sin `release`**. Los tres leen ahora el mismo
resolvedor.

⭐ Y `deploy.sh` **no pasaba ningún `--build-arg`**, así que el sello de versión que
`apps/portal/Dockerfile` y `apps/vendor/Dockerfile` **ya estampaban** en su `index.html` decía
**`unknown`** on-prem desde el primer día.

#### ⭐⭐ La prueba negativa encontró que el arreglo estaba a medias

Hornear el commit **no alcanzaba**. El compose seguía declarando
`GIT_COMMIT_SHA: ${GIT_COMMIT_SHA:-}`, y **una variable del servicio pisa el `ENV` de la
imagen**: sin nadie que la exportara quedaba en cadena vacía y tapaba el valor horneado.
Medido reproduciendo el escenario exacto del día anterior —`docker compose up -d cloudflared`
a mano— **con el `ARG` ya puesto**:

```
/api/health            →  {"commit": "unknown"}
dentro del contenedor  →  GIT_COMMIT_SHA=[]
```

⚠️ **Y ése es el punto: el arreglo a medias se veía igual que el arreglo entero.** `unknown` es
más honesto que `""`, así que por el camino normal (`deploy.sh`) todo respondía bien. Sin correr
la prueba negativa, el item se habría cerrado afirmando algo falso.

Se retiró la declaración del compose (`api` + `worker`) y, por la otra punta, el export de
`recrear()` — dejarlo sería reconstruir el mismo acoplamiento. Verificado después:

| Camino | Resultado |
|---|---|
| `docker compose up -d --force-recreate api`, **sin** `deploy.sh` | `67a30bea` |
| el escenario que falló (`up -d cloudflared api`) | `67a30bea` |
| `worker` (sin endpoint de salud, se mira la variable) | `GIT_COMMIT_SHA=[67a30bea]` |
| los 3 hostnames del túnel | HTTP 200 |

### A — el diseño, y la trampa que no es obvia

⛔ **No hay atajo con certificado autofirmado.** Las apps mandan
`Strict-Transport-Security: max-age=31536000; includeSubDomains`, así que en cuanto un navegador
visita el dominio **todos sus subdominios quedan bloqueados por HSTS un año** y un error de
certificado **deja de ser saltable**: desaparece el "proceder de todos modos". El certificado
tiene que ser **públicamente confiable** → Let's Encrypt por **DNS-01** (la IP pública de `md`
no es fija y el dominio está *proxied*, así que HTTP-01 no aplica).

⛔ **Se descarta Traefik**, y no por gusto: es el proxy que Coolify metió y que ató 80, 443 **y
8080** —el puerto del API— dejando prod caído **50 minutos** (§10.4). El terminador nuevo
**liga sólo 80 y 443**; medido: ambos libres en `md`.

MikroTik (`192.168.0.254`, RouterOS):

```
/ip dns static add name=megadulcessuite.com          address=192.168.0.222 comment="VL.11"
/ip dns static add name=portal.megadulcessuite.com   address=192.168.0.222 comment="VL.11"
/ip dns static add name=vendedor.megadulcessuite.com address=192.168.0.222 comment="VL.11"
```

⚠️ **Tres entradas por NOMBRE EXACTO, y nada de `regexp=`.** La forma con expresión regular se
descartó por dos motivos, los dos capaces de morder callado:

1. **Un regexp amplio tipo `.*\.megadulcessuite\.com` también captura
   `_acme-challenge.megadulcessuite.com`** y devuelve un registro A donde el ACME espera un TXT
   → **la renovación del certificado fallaría en silencio dentro de 60 días**, o sea mucho
   después de que nadie recuerde haber tocado el router.
2. En RouterOS el `regexp` de DNS estático **no está anclado por defecto**, así que también
   respondería por `portal.megadulcessuite.com.loquesea.com` — un nombre ajeno resolviendo a
   nuestro servidor.

Aun así el terminador se configura con resolvedores explícitos (`1.1.1.1`, `8.8.8.8`) para su
comprobación de propagación del TXT: es defensa en profundidad, no confianza en el router.

⚠️ `md` también resuelve por el MikroTik y hoy resuelve **su propio dominio a Cloudflare**
(`172.67.155.247`): cualquier llamada del servidor a su URL pública sale a internet y vuelve.
La entrada estática también cura eso.

⚠️ **Deuda que A no cierra:** el camino interno **no pasa por Cloudflare** — sin WAF, sin
protección de DDoS, sin Access. Para una LAN es lo deseado, pero queda dicho.

### A — resultado, medido el 2026-09-23

El certificado de Let's Encrypt se obtuvo por **DNS-01** para los tres nombres y Caddy lo
renueva solo. Verificado **antes** de tocar el router, fijando la IP a mano y **sin `-k`**
—o sea exigiendo que el certificado valide de verdad—: los tres responden **HTTP 200**.

Comparación limpia, misma URL, mismo momento, **los dos caminos por HTTPS**:

| Camino | TCP | apretón TLS | **TTFB** |
|---|---|---|---|
| **Interno** (`md:443`) | 1.5 ms | 10 ms | **13 ms** |
| **Por el túnel** | 44 ms | 99 ms | **225–302 ms** |

**17–23×.** ⚠️ Y corrige a la baja una medición propia: la primera lectura del camino interno
dio 150 ms, que era ruido de la primera llamada. Con la conexión reutilizada —lo que hace un
navegador— baja a **~4 ms**.

⚠️ **Nota de la medición, no un defecto:** pedir `/api/health` cinco veces seguidas devolvió
`429 ThrottlerException`. Es el limitador de tasa de la app funcionando; la comparación se
rehízo contra `/`, que es estático.

⭐ **Falta el paso humano, y ahora SÍ es seguro darlo**: las tres entradas del MikroTik. El
orden importaba —primero el certificado— porque con HSTS encendido apuntar la oficina a `md`
sin certificado da un error que no se puede saltar. Ese riesgo ya no existe.

#### ⭐⭐ Y después del sondeo: hay un camino que NO toca la red

Antes de pedirle 8 cambios al grupo de redes se sondearon las alternativas. Resultado:
**existe una forma más simple y está probada**.

`interno.megadulcessuite.com` es un registro **A público** que apunta a **`192.168.0.222`**,
una IP privada. Suena raro y es perfectamente válido: el DNS público devuelve el número, y
sólo lo puede *usar* quien esté adentro de la red.

**El riesgo era la protección anti-rebinding** —muchos routers descartan respuestas con
direcciones privadas—, así que se preguntó **a cada router de plaza**:

| Router | Respuesta | Plaza |
|---|---|---|
| `192.168.0.254` · `.42.1` · `.40.1` · `.44.1` · `.54.1` · `.50.1` · `.32.1` · `.30.1` | **`192.168.0.222`** los 8 | oficinas + las 7 plazas |

**Ninguno filtra.** Y verificado de punta a punta desde una máquina de oficina, **sin una sola
entrada estática**: DNS → `192.168.0.222` · HTTPS **200** con certificado público válido ·
**TTFB 16 ms** · la API responde.

⭐ De paso resuelve el hueco de **CEDIS (`.9`) y Padre Hidalgo (`.10`)**, cuyos gateways ni
siquiera se pudieron ubicar: no hace falta ubicarlos.

##### Las dos opciones, con lo que cada una cuesta

| | `interno.` (registro público) | Entradas estáticas por router |
|---|---|---|
| Cambios de red | **ninguno** | 3 líneas × 8 routers |
| Cubre CEDIS y Padre Hidalgo | **sí** | hay que ubicar su gateway primero |
| Misma URL adentro y afuera | no — son dos nombres | **sí** |
| Una laptop que sale de la oficina | ese nombre deja de servirle | **sigue funcionando** |
| ⭐ **Si se cae internet** | deja de resolver al vencer el TTL | **la app interna sigue viva** |
| Publica una IP privada en DNS público | sí (RFC1918 — riesgo bajo, molesta a auditorías) | no |

⚠️ **El renglón de la caída de internet es el que decide, y no es obvio.** Hoy, con todo
pasando por el túnel, una caída de internet **ya deja la app inaccesible para todos**. El
registro público **no empeora eso**. Las entradas estáticas sí lo **mejoran**: con el enlace
caído, la app —que vive en el mismo edificio— seguiría funcionando adentro.

⇒ **Recomendación**: usar `interno.` **ya**, que desbloquea `[VL.11.B]` hoy y sin depender de
nadie; y dejar las entradas de router como mejora **posterior y opcional**, que compra la
misma URL en los dos lados y sobrevivir a una caída del enlace. No son excluyentes.

⚠️ **Nota operativa del terminador**: cambiar el `Caddyfile` **no** recrea el contenedor —es
un montaje, así que Compose no ve cambio de configuración— y `caddy reload` tampoco sirve
porque la API de administración está **apagada** a propósito. Para que tome un nombre nuevo:
`docker restart prod-caddy`. Es el costo aceptado de no dejar abierta una API que puede
recargar la configuración entera.

#### ⛔ Corrección al diseño: el DNS partido va POR PLAZA, no una vez

El diseño original hablaba de *"la entrada del MikroTik"*, en singular. **Está mal**, y lo
destapó el usuario al explicar cómo está armada la red. Medido el 2026-09-23 (mapa completo en
[`ops/README.md` §8bis](../README.md)):

- **El tercer octeto es la plaza**: `.0` oficinas · `.9` CEDIS · `.10` Padre Hidalgo · `.42`
  La Piedad · `.40` 8 Esquinas · `.44` Yurécuaro · `.54` Zamora · `.50` Canindo · `.32`
  Morelia Madero · `.30` Morelia Abastos.
- **Cada plaza tiene su propio gateway y su propio resolvedor** — los 7 identificados
  contestan en el puerto 53, y **los 8 son MikroTik RouterOS**, o sea una flota.

⇒ Una entrada en el MikroTik **de oficinas** sirve **sólo a oficinas**. Una caja en
`192.168.30.x` seguiría resolviendo a Cloudflare y **saliendo a internet para hablar con un
servidor de su misma red** — exactamente lo que `[VL.11.B]` viene a evitar. Las mismas tres
líneas van **en cada MikroTik**.

⬜ **Abierto**: los gateways de CEDIS (`.9`) y Padre Hidalgo (`.10`) no están en `.1` ni
`.254`; hay que averiguar su direccionamiento antes de incluirlas.

### B — no hay cajas que repuntar: son dos variables, y van en el corte

⭐ **La fase B era mucho más chica de lo que este documento decía, y lo destapó el usuario**
al decir *"Wincaja ya no existe"*. Verificado contra los datos el 2026-09-23:

| Almacén | Último ticket | Actividad |
|---|---|---|
| `01`–`08` (Kepler) | 2026-09-23, **0–4 min de rezago** | 18–120 tickets en 3 h, los ocho |
| **`MD-30`** | **2026-09-18 20:40** | **0 en 24 h** |
| **`MD-32`** | **2026-09-07 19:22** | **0 en 24 h** |

Los `MD-*` cortan **exactamente** en las fechas de migración que `kepler-branches.js` ya
documentaba. Wincaja está muerto.

⇒ **Nadie postea a `/api/store/live/ingest` desde una tienda.** Las 8 ramas las lee
`store-poller`, **que corre en `md`**. El único consumidor remoto del endpoint son **dos
contenedores de la misma máquina** — `store-poller` y `feeds-livefast`—, los dos con
`STORE_INGEST_URL` apuntando a `https://megadulces.up.railway.app/...`.

#### ✅ EJECUTADO 2026-09-23 — decisión del usuario, con el costo sobre la mesa

`store-poller` ya apunta a `https://interno.megadulcessuite.com/api/store/live/ingest`. La
línea vive en el **`environment:` del compose versionado**, no en `feeds.env` — ese archivo no
está versionado ni tiene generador, así que el cambio habría sido invisible desde el repo y se
perdería al regenerarlo. `environment:` gana sobre `env_file`.

**Verificado antes de desplegar, porque la falla habría sido silenciosa:** se compararon las
**huellas** de las dos llaves (la del poller en `feeds.env` contra el `STORE_INGEST_KEY` de la
API de `md`) y **coinciden**. Si no lo hicieran, el poller recibiría 401, **no se caería**, y
los tickets se perderían sin que nada se pusiera rojo.

**Resultado, medido:**

| | |
|---|---|
| `md` | los **8 almacenes** entregando, **1–10 min** de rezago, 19–133 tickets del día cada uno |
| Railway | **congelado en 15:48:00** — confirmado en dos lecturas separadas 100 s |

⚠️ **El costo, que el usuario aceptó explícitamente**: Railway **hoy sigue siendo producción**,
así que su pantalla de Tienda Live **ya no se actualiza**. Se revierte comentando esa línea del
compose y recreando el contenedor:

```sh
# revertir
sh ops/vl/deploy.sh store-poller     # con la línea STORE_INGEST_URL comentada
```

⚠️ **Parpadeo observado y descartado**: durante la verificación, una consulta a la base de
Railway devolvió `FATAL: the database system is in recovery mode`. Se midió enseguida — 3 de 3
respuestas normales y **833 minutos de uptime** — así que fue transitorio, no un incidente. Se
deja escrito porque el primer intento de diagnóstico **sacó la conclusión contraria**: comparó
una consulta *fallida* (cadena vacía) contra un valor y concluyó *"Railway sigue avanzando"*.
**Una comparación contra el resultado de algo que falló no es una medición.**

#### Lo que sigue en el corte

Railway **sigue siendo producción**. Repuntar esas dos variables ahora mandaría la venta viva
de las 8 tiendas a la **copia** de `md` en vez de al sistema real. Es un renglón **del corte**:
cambiar `STORE_INGEST_URL` a `https://interno.megadulcessuite.com/api/store/live/ingest` en
[`ops/vl/docker-compose.yml`](../vl/docker-compose.yml) y recrear los dos contenedores.

El destino ya está **probado**: **401** con llave mala y **201** `{"received":0,"inserted":0}`
con la llave real, sin escribir un solo ticket, y `analytics.store_live_tickets` sin moverse
de 237,585 filas.

⚠️ **Verruga medida que NO es pérdida de datos**: `store-poller` registra ~**32 `timeout
expired` cada 2 h**, todos de `01 Padre Hidalgo`. Se comprobó contra prod real: esa tienda está
**2 minutos atrás con 58 tickets en 3 h**, o sea que los reintentos entran. Es un enlace lento,
no un carril caído — pero el log grita 32 veces cada dos horas, y **una alarma que grita en
falso enseña a ignorar el tablero**.

### B — corrección medida a §6 #9

§6 #9 dice *"antes de tocar las 30"*. Los agentes de Wincaja **parametrizados son 2**: `'30'`
MD-30 Morelia Abastos y `'32'` MD-32 Morelia Madero (`deploy-wincaja-agent.ps1:35-39`; `'50'`
Canindo está comentado porque migró a Kepler). **El trabajo es mucho menor de lo que decía el
documento** — pero hay que contar las cajas reales antes de dimensionarlo.

⚠️ **Hallazgo de seguridad colateral**, ajeno a esta fase y encontrado midiéndola:
`database/importers/lib/kepler-branches.js:31-32` trae **credenciales por defecto en el código**,
y la llave de ingesta está en texto plano en cada caja. El guard `store-ingest.guard.ts` es un
secreto compartido en una cabecera: **sin lista blanca de IP, sin mTLS, sin límite de tasa**.

### E — no hay escasez de RAM, y eso corrige el plan

`md` tiene **28 GiB** (no los 14 que dice `FASE_VL`), con **20 disponibles**. `pg-prod` ya está
afinado: **12 GB** `shared_buffers`, **16 GB** `effective_cache_size`, `random_page_cost` 1.1,
`effective_io_concurrency` 200 — correctos para NVMe. Base de prod: `railway`, **21 GB**.

> ⚠️ **Estos dos números decían `6 GB` y `14 GB` hasta el 2026-09-23.** Los subió el commit
> `106041b3` (`[VL.11.E]`, +10 GB), que tocó **sólo el compose** — y este README, que se declara
> fuente única en su línea 4, siguió tres días afirmando el presupuesto viejo. Corregido acá y en
> las líneas 53 y 246. **Un número de configuración citado en prosa caduca en silencio:** si
> sostiene una decisión, va junto al valor o va en una prueba que se ponga roja.

⚠️ **Lo real y sutil, y ahora peor:** hay **TRES Postgres en la misma caja y cada uno cree que la
caché del sistema es suya**. Medido el 2026-09-23:

| | `pg-prod` | `pgvector-md` | `pg-rag` | Suma |
|---|---|---|---|---|
| `shared_buffers` | 12 GB | 4 GB | 0.5 GB | **16.5 GB de 28.8** |
| `effective_cache_size` | 16 GB | 9 GB | 1 GB | **26 GB** |

Descontando los 16.5 GB de `shared_buffers` y los ~3 GB de las apps, la caché real del sistema es
de **~9 GB, no 26**: los tres planificadores están contando con memoria que no existe, y
`effective_cache_size` es justo el parámetro que los empuja al *nested loop* — el mismo plan que
en §"defecto de planificador" tarda **>70 min contra 9.7 s**. ⇒ **Medir `pg_statio_user_tables`
primero**, que es lo que este renglón pide desde que se escribió y sigue sin hacerse. Cambiarlo a
ojo es adivinar. ⚠️ Y `pg-rag` **no tiene ni una tabla** (0 en las dos bases): reserva memoria y
`shm` para nada — decidir si se apaga o se le pone destino con fecha.

---

**Plan de la fase:** [`FASE_VL`](../../docs/IMPLEMENTACION/FASES/FASE_VL_VPS_LOCAL.md) ·
decisión en **ADR-060** · el ADR propio de VL.9 está **pendiente**.
