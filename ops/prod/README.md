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

## 3. Cómo se restaura la base — y por qué el respaldo diario NO alcanza para cortar

El respaldo diario (`scripts/backup-db.ps1`) corre con `--no-owner --no-privileges`, elegido
para portabilidad. Consecuencia **medida**:

- **no trae los roles** — y prod tiene **613 políticas RLS que nombran `app_runtime`**. Un
  `pg_restore` contra una base sin ese rol falla en 613 sentencias, **a mitad del restore**,
  no al principio.
- **no trae los GRANT**. O sea que aunque el rol exista, no tiene permisos sobre nada.

Por eso el orden es:

```sh
# 1. los roles, ANTES
docker exec -i pg-prod psql -U postgres -d railway -v ON_ERROR_STOP=1 < ~/secrets/roles.sql

# 2. el archivo ADENTRO del contenedor  ⛔ no por stdin: ver la nota de abajo
docker cp /tmp/prod-AAAAMMDD.dump pg-prod:/tmp/restore.dump

# 3. el restore, en paralelo
docker exec pg-prod pg_restore -U postgres -d railway \
  --no-owner --no-privileges --jobs=4 /tmp/restore.dump

# 4. borrar la copia de adentro (ocupa lo mismo que el dump en la capa del contenedor)
docker exec pg-prod rm -f /tmp/restore.dump
```

⛔ **`pg_restore --jobs` NO puede leer de la entrada estándar** — falla con *"parallel restore
from standard input is not supported"*, porque para repartir el trabajo necesita **saltar por
el archivo**, y un tubo no se puede rebobinar. O sea que el `… < archivo.dump` que uno escribe
por reflejo obliga a restaurar **en un solo hilo**. Sobre 34 GB la diferencia no es cosmética.

⛔ **Y para el CORTE de verdad hace falta un volcado DISTINTO**, que hoy nadie toma:

```sh
pg_dumpall --globals-only   # roles con su hash de contraseña
pg_dump --format=custom     # SIN --no-privileges, para que viajen los GRANT
```

Sin eso, la base cortada arranca con los permisos incompletos y el síntoma llega como
`permission denied for table …` en runtime, no en el restore.

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

**Plan de la fase:** [`FASE_VL`](../../docs/IMPLEMENTACION/FASES/FASE_VL_VPS_LOCAL.md) ·
decisión en **ADR-060** · el ADR propio de VL.9 está **pendiente**.
