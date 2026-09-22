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
cacheado. En `md` le damos 6 GB de `shared_buffers` **más** el page cache del host, y el compose
**no le pone `mem_limit` a propósito** (ver el comentario en `x-pg`).

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
plan. Lo que lo mantiene invisible es que `REFRESH` de estas vistas **no aparece en ningún cron ni
importador** — sólo en migraciones y scripts sueltos. O sea que la próxima migración que cambie una
de estas definiciones se va a colgar en producción, y nadie lo tiene anotado.

⚠️ **Tres hipótesis se probaron y se cayeron antes de dar con ésta**, y se dejan escritas para que
nadie las repita: *no* eran estadísticas faltantes (todas las tablas grandes con `reltuples` exacto
y `analizada = t`), *no* era configuración pobre (la copia tiene **más** que prod: `shared_buffers`
6 GB vs 1.5, `work_mem` 32 MB vs 16, `maintenance_work_mem` 1 GB vs 256 MB), y *no* eran los índices
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
| 1 | **El dominio** ⛔ **intentado 2026-09-22 y RECHAZADO** | Todo cuelga de `*.up.railway.app`, que es de Railway y **no se puede mover**. **553 referencias** en 33 archivos, incluidos agentes desplegados en cajas de sucursal (`store-agent.template.cmd`) y los assets compilados del **APK de vendedor**. Al intentar agregar el dominio propio, el CLI devuelve `Unauthorized. Please run railway login again` — **y el mensaje miente**: la sesión es válida (los `railway variables --set` de esta misma sesión funcionaron) y las lecturas también. Falla **sólo** crear dominio, con cualquier nombre → es una restricción de **plan/feature de la cuenta**, no de credenciales | Edgar, desde el **dashboard** de Railway (§6.1) |
| 2 | **Cloudflare Tunnel** | Elegido como forma de exposición. `cloudflared` ya está declarado en el compose, tras el perfil `tunel` | Hace falta cuenta de Cloudflare + el dominio (o un subdominio delegado) en su DNS, y el `CLOUDFLARE_TUNNEL_TOKEN` |
| 3 | **VL.8 — aguante** | **Sin UPS gestionado** (`nut`/`apcupsd` ausentes), **sin respaldo fuera de sitio**, **un solo enlace** de 44 Mbit de subida compartido con la oficina y con los 14 carriles | Compra de UPS + destino de respaldo externo. Elegido como **precondición dura** |
| 4 | **La alarma no avisa** | El worker manda el correo (verificado en vivo) pero Gmail lo rechaza: `534-5.7.9 Application-specific password required`. `SMTP_PASS` tiene 11 caracteres; una contraseña de aplicación son 16 | Generar la contraseña de aplicación en la cuenta de Google y ponerla en `SMTP_PASS` de **los dos** servicios |
| 5 | **El volcado correcto** | El respaldo diario no trae roles ni GRANT (§3) | Tomar `pg_dumpall --globals-only` + `pg_dump` con privilegios el día del corte |
| 6 | **`JWT_SECRET` cambia** | El valor de Railway **contiene un salto de línea** y `env_file` de Compose no puede expresarlo. Recortarlo equivale a rotarlo | Decidirlo: rotar una sola vez y avisar que **todos re-loguean** |
| 7 | **El bucket** | 597 MB de comprobantes (§5) | Decidir MinIO on-prem o seguir en Railway |

### 6.1 El dominio: por qué no alcanza con apuntar el DNS, y las dos vías

**Lo que NO funciona**, y conviene saberlo antes de perder una tarde: poner un `CNAME` de
`app.megadulces.com.mx` a `megadulces.up.railway.app` **no sirve**. Railway rutea por el
**encabezado `Host`**, así que una petición que llega con `Host: app.megadulces.com.mx` no
coincide con ningún dominio registrado y Railway contesta *"Application not found"*. El DNS
sólo resuelve la IP; no cambia el `Host`.

Por eso el dominio propio tiene que estar **registrado del lado de Railway**. Dos vías:

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

⚠️ **Y una advertencia sobre el APK**: la app nativa de vendedor trae la URL **compilada
adentro** (`NATIVE_API_URL`), así que el dominio nuevo **no la alcanza** hasta que se
reconstruya y se redistribuya. Medido: hoy apunta a
`trademarketing-production-5084.up.railway.app`, que **responde 404** — o sea que ese host ya
no existe y conviene averiguar de qué vive la app instalada **antes** de tocar nada más.

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

**Plan de la fase:** [`FASE_VL`](../../docs/IMPLEMENTACION/FASES/FASE_VL_VPS_LOCAL.md) ·
decisión en **ADR-060** · el ADR propio de VL.9 está **pendiente**.
