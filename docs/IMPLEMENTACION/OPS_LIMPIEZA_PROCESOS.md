# OPS.LIMPIEZA — Procesos de ingesta con latido en rojo (2026-10-19)

> **Para qué existe este documento:** si en el futuro algo de lo que se toca acá falla, acá está
> qué se cambió, por qué, con qué evidencia, cómo se verifica y **cómo se revierte**. El estado
> vivo de cada item está en `01_TRACKER_PROGRESO.md` › sección `OPS.LIMPIEZA` (bajo Fase OBS).

**Origen:** diagnóstico de 11 procesos de `analytics.cron_runs` en rojo o dudosos. Conclusión:
ninguno duplica a otro; había latidos huérfanos, chequeos que marcaban error sin dato malo y
pasos que violaban la regla principal (leer del ODS). Todo lo medido es en **sólo lectura**.

---

## Resumen de cambios

| Item | Commit | Qué cambia | Riesgo si falla |
|---|---|---|---|
| OPS.LIMPIEZA.1 | `a0a1730f6` | `ui_usage_flush` late `ok` sin tráfico + migración que borra 3 latidos huérfanos | Bajo: sólo telemetría y el tablero de salud |
| OPS.LIMPIEZA.3 | `a1e3b502d` | `ods_publish_tienda` reescribe forzado las filas iguales en valor y distintas en texto | Medio: escribe en la base de la **tienda mayorista** (Railway) |
| OPS.LIMPIEZA.4 | `88ea1b029` | Las marcas de `feed_catalog` salen de `kepler_ods.kdig`, no de los POS de cada sucursal | Medio: da de alta filas en `catalog.brands` |
| OPS.LIMPIEZA.5 | `7f5718334` | El latido de `cdc_reconcile_full` nombra la tabla que abortó el DELETE | Nulo: sólo cambia el texto del error |

Los cuatro están en `origin/main` (push del 2026-10-19 15:15, `b497d5edb..7f5718334`). **Un push
NO despliega** (el renglón de `auto-deploy` está comentado): el código nuevo corre cuando se
reconstruyan las imágenes de `api` y de `feeds-cron`.

---

## OPS.LIMPIEZA.1 — `ui_usage_flush` y los latidos huérfanos

**Problema.** `libs/platform-core/.../usage-metrics.interceptor.ts` mandaba el motivo «sin trafico
en la ventana» dentro de `fallas`, así que `latirCron` lo escribía como `error`. Resultado: 38.8 %
de los latidos en rojo, sobre todo de madrugada, sin que nada fallara.

**Arreglo.** `latir(0, 0, [])`: el cero se declara con `ceroEsOk`, que es su lugar.
**Prueba:** `usage-metrics.interceptor.spec.ts`. Con la línea vieja da `status: "error"` (prueba
negativa vista en rojo); con la nueva, `ok`.

**Migración `20261019144127_cron_runs_retira_latidos_huerfanos.js`.** Borra de `analytics.cron_runs`:

| `job_key` | Por qué es huérfano | Última escritura (medida 2026-10-19 15:16) |
|---|---|---|
| `rd_commission_runner` | Cron retirado el 2026-10-07 (`[RD.22]`): la quincena se recalcula a demanda | 2026-10-08 01:35 (`error`) |
| `fact_replenishment_plan` (sin sufijo) | `run-prod-feeds.js` invoca el importer sólo con `--hb=stock` y `--hb=nightly` | 2026-10-09 17:17 |
| `prueba_no_usar` | Prueba manual, cero emisores en el repo | 2026-09-29 17:35 |

- **Antes:** 3 filas (tenant `mega_dulces`). **Después esperado:** 0.
- **Sólo `DELETE`, sin objeto de esquema** → la compuerta del despliegue la clasifica `NO_MEDIDO`
  y **frena a todo el equipo** mientras no se aplique.
- **Cómo revertir:** el `down` es no-op a propósito: eran latidos de procesos que ya no existen.
  Si alguno volviera a correr, su primer `hb.begin()` recrea la fila solo; no hay estado que
  restaurar a mano.
- ⚠️ **`feed_route_stock` NO se borró.** `scripts/check-importer-sin-agenda.js` declara
  `import-route-stock.js` deuda A AGENDAR (decide Edgar). Es `OPS.LIMPIEZA.2`.

### Estado de la aplicación en prod

✅ **APLICADA el 2026-10-19 15:16:37, lote 960** (`public.knex_migrations` id 1629). **Verificado
15:22:** las 3 filas ya no existen (0 filas).

⚠️ **No la aplicó la sesión que la escribió.** Esa sesión hizo el pre-vuelo a las 15:16:22
(identidad `7688376744939610156`, `knex_migrations_lock` libre, `rollout status deploy/api`
completo) y su intento de aplicarla lo **bloqueó el control de permisos** antes de ejecutarse:
los archivos todavía no estaban en `md`. Quince segundos después la aplicó **otra sesión**. Al
correr el script a mano a las 15:21 respondió *«NO está pendiente»*: es la señal de que ya
estaba, no un error. Si en el futuro hay que rastrear quién la aplicó, el dato es el lote 960.

Lo que sigue queda como **receta probada**, con los dos tropiezos de ese día corregidos:

- **El paso 1 se corre en la máquina de trabajo** (donde está el repo), **no en `md`**: en `md` no
  existe `database/migrations-newdb/…` y `scp` responde `stat local … No such file`.
- **Elegir un pod que esté corriendo.** `{.items[0]}` a secas tomó `api-67dfcf95cd-kfw75`, en
  estado `Completed`, un resto del desalojo del 18-oct, y `kubectl exec` respondió *«cannot exec
  into a container in a completed pod»*. Tras el desalojo quedaron **28 pods que no están en
  `Running`** en el clúster: cualquier receta con `items[0]` puede caer en uno. Se agrega
  `--field-selector=status.phase=Running`.

Paso 1, en la máquina de trabajo (⚠️ pisa el `/tmp/apply-one-migration-prod.js` que otra sesión
pueda haber dejado en `md`):

```sh
scp database/migrations-newdb/20261019144127_cron_runs_retira_latidos_huerfanos.js \
    database/scripts/apply-one-migration-prod.js superoot@192.168.0.222:/tmp/
```

Paso 2, en `md` (`ssh superoot@192.168.0.222`):

```sh
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
F=20261019144127_cron_runs_retira_latidos_huerfanos.js
API=$(k3s kubectl get pods -n prod -l app=api --field-selector=status.phase=Running \
        -o jsonpath='{.items[0].metadata.name}')
echo "pod: $API"
k3s kubectl cp /tmp/$F prod/$API:/app/database/migrations-newdb/ -c api
k3s kubectl cp /tmp/apply-one-migration-prod.js prod/$API:/app/database/scripts/ -c api
k3s kubectl exec -n prod $API -c api -- sh -c \
  "PROD_DB_URL=\"\$DATABASE_URL_NEW\" node /app/database/scripts/apply-one-migration-prod.js $F"
```

**Verificar después** (desde el pod de `pg-prod`):

```sql
SELECT count(*) FROM analytics.cron_runs
 WHERE job_key IN ('rd_commission_runner','fact_replenishment_plan','prueba_no_usar');  -- 0
SELECT name FROM public.knex_migrations WHERE name LIKE '20261019144127%';               -- 1 fila
```

Si `knex` responde «migration directory is corrupt», al pod le faltan migraciones **ya aplicadas**
por otras sesiones: el error las nombra, se le copian igual que ésta y se reintenta (ver la
cabecera de `apply-one-migration-prod.js`).

---

## OPS.LIMPIEZA.3 — `ods_publish_tienda` en rojo perpetuo

**Evidencia** (log del pod `feeds-cron`, namespace `ingesta`, 2026-10-19): 35 de 35 pasadas con las
**mismas 2 filas** de `kepler_ods.kdii` —`c1=89535` sucursal `04` y `c1=95029` sucursal `01`— y
siempre `aplicadas=0`.

**Mecanismo, probado con el log:** el UPSERT sin churn de `raw-upsert` compara por **valor**
(`IS DISTINCT FROM`) y no ve nada que cambiar; la huella del publicador compara
`md5(fila::text)`, o sea el **texto**, y sí ve diferencia. Las dos tienen razón en su idioma y la
fila nunca converge.

**NO medido:** qué columna difiere. Exige leer la base de la tienda con su credencial, y eso no
se hizo. El arreglo no depende de saberlo.

**Arreglo:**
- `services/feeds-ingest/apply-handlers.js`: opción `meta.forceRewrite` (opt-in; **sin ella nada
  cambia**) que omite el guard `IS DISTINCT FROM`.
- `database/importers/kepler/publish-ods-remote.js`: después del UPSERT normal, las filas que
  siguen distintas se reescriben forzadas. **Tope `ODS_PUBLISH_REWRITE_MAX` (default 50) por
  ciclo**; arriba de eso no se fuerza nada y se declara (muchas filas ya no son «una
  representación rara»: es otra cosa).
- El latido dice **cuáles** filas no cuadran en vez de `87086/87086`.
- La llave compuesta usa un separador invisible (`\u001f`): `89535␟04` se leía `8953504`, que no
  existe. Ahora se imprime `89535/04`.

**Prueba:** `database/tests/test-newdb-raw-upsert.js` paso 6 (`numeric 20` contra `20.00`: sin la
opción no se reescribe; con ella, sí; y el default sigue sin churn). ⚠️ **No se corrió en local**
(Docker Desktop caído en la máquina de trabajo); la corre el job `pruebas-db` del CI, que todavía
es informativo.

**Cómo saber si falla:** latido `ods_publish_tienda`. Esperado: `ok`. Si sigue en `error`, el
mensaje ahora trae las llaves; si aparecen **más de 50** «no convergen», hay un problema real de
tipos entre origen y destino y **no** hay que subir el tope a ciegas.

**Cómo revertir:** `git revert a1e3b502d` y reconstruir la imagen de `feeds-cron`. El daño
posible de la opción es acotado: reescribe con el valor **del origen** filas cuyo valor ya era
igual.

---

## OPS.LIMPIEZA.4 — Marcas de `feed_catalog` desde el ODS

**Problema.** `database/importers/kepler/import-brands-lineas.js` abría una conexión por sucursal
con `stockMap()`, que devuelve el **POS remoto** de cada sucursal (no la réplica local): 9 viajes
por la red de las plazas, y una sucursal caída se saltaba con un `⚠` que nadie leía. Violaba la
regla principal.

**Arreglo.** Una consulta a `kepler_ods.kdig` (misma base que el destino), `ORDER BY sucursal`, con
la misma regla «la primera sucursal que trae el código gana» y la misma normalización de nombre.
Si `kdig` devuelve 0 filas el paso **falla**; antes seguía como si no hubiera líneas nuevas.

**Equivalencia medida en prod (2026-10-19):** 9 sucursales con 546–548 líneas cada una, 549
códigos, y **un solo** código con nombre distinto entre sucursales: `002` (GRUPO KI´SNACKS en
00/02/03/04/05; MONDELEZ en 01/06/07/08). Antes y después gana la `00`. **No se corrió un dry-run
contra prod.**

**Cómo saber si falla:** latido `feed_catalog` (sábado 02:00). El paso imprime
`kepler_ods.kdig: 00=548 · 01=547 …`; si alguna sucursal falta o el total baja mucho, mirar el
carril del ODS de esa sucursal, no este script.

**Cómo revertir:** `git revert 88ea1b029`. El script sólo da de **alta** marcas y adopta códigos;
nunca renombra ni borra.

---

## OPS.LIMPIEZA.5 — Investigación de la noche del 18-oct

**`cdc_reconcile_full`.** Abortó un DELETE de más del 60 % el **18-oct 02:10**. La tabla no se pudo
saber: el latido no la nombraba y el log murió con el pod. Arreglo (`7f5718334`): el error lleva
`tabla@sucursal` y la fracción. Si resulta ser una poda por antigüedad, `reconcile-ods-window.js`
ya tiene `podaCol` para declararla.

**La caída de producción (la lleva otra sesión: `VL.9.10b` / `OPS.DISCO.3`).** El disco de `md`
pasó de 86 % (15-oct) a 94 % (19-oct). El aviso de `image_gc_manager` estaba en el journal desde el
15-oct. **Entre 23:35 y 23:36 del 18-oct el kubelet desalojó toda prod** (`pg-prod`, `api`, `caddy`,
`cloudflared`, `portal`, `vendor`, `redis`, `worker` y la ingesta). Nada volvió hasta los
reinicios de 07:53 y 09:10 del 19-oct. Por eso el nocturno y `ods-reconcile-full` del 19 no
corrieron.

**⛔ Un segundo planificador.** El contenedor de Docker Compose `feeds-cron`
(`trade-ingest:latest`, creado el 16-oct 17:46) está vivo con **la misma agenda** que el pod k3s
`feeds-cron`. Corrió el nocturno el 17 y el 19-oct y falló a los ~340 s (`EAI_AGAIN pg-prod`: es el
nombre del Postgres de Compose, que está parado).

> ❌ **DIAGNÓSTICO EQUIVOCADO, corregido el 2026-10-20.** Acá decía que ese duplicado explicaba
> que `kepler_sales_fact_full` estuviera en `running` 35 h, porque `last_finish` (03:01:33.177) y
> `last_start` (.186) estaban a 9 ms: «dos emisores con la misma llave». **No era así.** Esos
> 9 ms los produce un solo `hb.begin()`: encuentra la corrida anterior colgada en `running`, la
> cierra como error (eso escribe `last_finish`) y abre la nueva (`last_start`) en la misma
> llamada. Con el duplicado de Compose ya detenido, el 20-oct se repitió idéntico
> (03:00:44.182 / .198). **La causa real es `OPS.LIMPIEZA.9`, más abajo:** el proceso muere por
> falta de memoria. ⭐ La lección: dos marcas a milisegundos NO prueban dos emisores; antes hay
> que leer qué escribe `begin()`.

### OPS.LIMPIEZA.7 — Docker Compose no debería existir en `md`: todo va en k3s

**Corrección de lo que se creyó primero:** nadie arrancaba `feeds-cron` a mano. Lo hacía
**`ods-autoheal`**: su log muestra *«found to be unhealthy - Restarting container»* cada ~6.7 min
(13:26, 13:33, 13:39, 13:46…). El chequeo de salud falla porque el contenedor busca `pg-prod`,
que es el nombre del Postgres de Compose y está parado (`EAI_AGAIN pg-prod`). El bucle no
terminaba nunca, y en cada vuelta el contenedor volvía a cargar la agenda del nocturno.

**Inventario de Compose vivo en `md` (2026-10-19 15:25):**

| Contenedor | Proyecto | ¿Equivalente en k3s? | Decisión |
|---|---|---|---|
| `feeds-cron` | `vl` | Sí: `ingesta/feeds-cron` | **Apagar**: es el duplicado |
| `ods-autoheal` | `vl` | No hace falta: sólo vigila contenedores con `autoheal=true` y el único vivo era `feeds-cron` | **Apagar** |
| `prod-backup` | `prod` | **No** | Se queda hasta migrarlo: es el respaldo de prod (pgBackRest), recreado hoy por `VL.9.10b` |
| `prod-registry` | `prod` | **No** | Se queda hasta migrarlo: registro de imágenes |
| `sonar-server`, `sonar-db` | `sonar` | No | Herramienta de desarrollo, no de prod |
| `obs-netdata` | `obs` | No | Monitoreo |

**En el repo:** `ops/vl/docker-compose.yml` ya declaraba `feeds-cron` bajo el perfil
`retirado-k3s`; se le agrega el mismo perfil a `autoheal`, que era el único servicio sin perfil.
Así ningún `docker compose up -d` lo levanta. `feeds-cron` se creó el 16-oct a las 17:46, un
minuto después de que se copiara el compose a `md` (17:45): alguien lo levantó con su nombre
explícito, porque el perfil por sí solo no lo habría arrancado.

**En `md`: ✅ HECHO el 2026-10-19.** `ods-autoheal` se detuvo a las 15:27:21 y `feeds-cron` a las
15:27:39 (hora MX), los dos con `restart=no`. Los corrió una persona en `md`, porque el control de
permisos bloqueó a la sesión de Claude. **Verificado:** `running=false`, `exited`, `restart=no`; los
deployments k3s `ingesta/feeds-cron` y `ingesta/feeds-livefast` siguen `1/1`. Receta usada:

```sh
docker update --restart=no feeds-cron ods-autoheal
docker stop -t 20 ods-autoheal feeds-cron
docker inspect feeds-cron ods-autoheal \
  --format '{{.Name}} | running={{.State.Running}} | restart={{.HostConfig.RestartPolicy.Name}}'
```

⚠️ La verificación se hace con `docker inspect`, **no** con `docker ps --format`: `ps` no expone
`HostConfig` y responde *«can't evaluate field HostConfig»*. Ese error es de la plantilla, no
del `stop`.

⚠️ **Primero `ods-autoheal`, después `feeds-cron`** (el `stop` los procesa en ese orden): al revés,
autoheal puede volver a levantar `feeds-cron` en la ventana de 30 s. Y sin `--restart=no`,
`unless-stopped` los revive en el próximo reinicio de `md`.

**Cómo revertir:** `docker update --restart=unless-stopped feeds-cron ods-autoheal && docker start
ods-autoheal feeds-cron`. No tiene sentido hacerlo: duplicaría el nocturno otra vez.

**Lo que falta para que Compose desaparezca de verdad:** migrar `prod-backup` y `prod-registry` a
k3s. Quedó como **`OPS.LIMPIEZA.8`** en el tracker, con las decisiones D1/D2, los criterios de «hecho»
y el riesgo. Lo esencial: `prod-registry` es de donde k3s baja **todas** las imágenes propias, así
que no es un resto sino una pieza crítica. Es trabajo de infraestructura con riesgo propio: el respaldo no se puede quedar sin correr
ni un día, y si el registro se cae no hay despliegues. Va como fase o item aparte, no como
limpieza.

---

## OPS.LIMPIEZA.8 — `prod-registry` y `prod-backup` de Compose a k3s

**Estado: CORTADO el 2026-10-19 ~15:58–16:00; falta la noche de verificación (paso C).**
Lo corrió una persona en `md` (el control de permisos bloquea a Claude), paso a paso, con la
verificación de cada uno:

| Paso | Resultado |
|---|---|
| 0 | `api` sin despliegue en curso, 0 pods `Pending`. Registro con 8 repositorios. `trade-prod-backup:base-7fee9ed6c22a` subida (`sha256:c9d14dbf…`) |
| A1 | `registry:2` precargada en containerd (`26b2eb03618e7`, 10.1 MB) |
| A2 | `prod-registry` detenido con `restart=no` · pod `registry` `Running` · el `_catalog` devuelve los **mismos 8 repositorios** · sólo él escucha en `127.0.0.1:5000` · el manifiesto de `trade-prod-api:7f5718334` responde HTTP 200 |
| A3 | `crictl pull` (prueba negativa con el viejo apagado): **resultado no registrado** |
| B | `prod-backup` detenido con `restart=no` · pod `backup` `Running` · agenda 22:00/23:30 intacta · `pgbackrest --stanza=prod check` → WAL `00000001000001A90000001E` archivado, *completed successfully* |

**Después del corte, el Docker de `md` sólo tiene herramientas** (`sonar-server`, `sonar-db`,
`obs-netdata`): ya no queda ningún contenedor de producción en Compose.

**Antes del corte** (se deja como estaba escrito): los manifiestos estaban escritos y validados,
y el corte se hacía a mano, fuera de horario hábil (regla 9). Se hizo a las 16:00 de un lunes,
con decisión del PM: el registro deja ~1 min sin poder bajar imágenes, y se verificó antes que
no hubiera despliegue en curso ni pods `Pending`.

| Archivo | Qué es |
|---|---|
| `ops/k3s/63-registry.deployment.yaml` | `registry:2` con `hostNetwork`, escuchando en `127.0.0.1:5000`, sobre el MISMO directorio (`prod_registry-data`) |
| `ops/k3s/53-prod-backup.deployment.yaml` | La misma imagen de respaldo (cron + pgBackRest), la misma agenda y los mismos hostPath |

**Validado:** `kubectl apply --dry-run=server` acepta los dos · `npm run check:k3s` sin rojos
propios (`los 2 PREPARADO(s) siguen corriendo en Compose`) · `npm run check:base-tags`:
`trade-prod-backup:base-7fee9ed6c22a` ✔.

**Por qué `migracion: preparado` y el compose sin tocar:** es el protocolo de `check:k3s`. Un
manifiesto escrito y sin aplicar se etiqueta `preparado`, el servicio sigue en Compose, y
`aplicar-k3s-prod.sh` **lo salta**: nadie lo aplica por accidente antes del corte. La etiqueta
`migrado` y el perfil `retirado-k3s` en `ops/prod/docker-compose.yml` van **en el commit del
corte**, no antes. Si se adelantan, `check:k3s` marca *«EN LOS DOS MUNDOS»*.

**La imagen del respaldo ya existe.** Los 5 archivos de entrada en `md:~/build-prod`
(`Dockerfile.backup`, `backup-prod.sh`, `pgbackrest-run.sh`, `pgbackrest.conf`,
`crontab.backup`) son idénticos, byte a byte, a los del repo (sha256 comparado el 2026-10-19), y
`trade-prod-backup:latest` se construyó a las 09:26, un minuto después de que se actualizaran.
Basta retagearla.

### Receta del corte (en `md`, fuera de horario hábil)

**0. Antes.** Que no haya un despliegue en curso, y copiar los manifiestos a la copia que se
aplica (la de `md`, no la del repo: ver la memoria «ops/k3s del REPO no es lo que se aplica»):

```sh
# en la máquina de trabajo
scp ops/k3s/63-registry.deployment.yaml ops/k3s/53-prod-backup.deployment.yaml \
    superoot@192.168.0.222:~/ops/k3s/
```

```sh
# en md
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
k3s kubectl -n prod rollout status deploy/api --timeout=10s      # nada desplegando
curl -fsS http://127.0.0.1:5000/v2/_catalog                       # registro viejo responde
# imagen del respaldo al registro (mismo directorio que va a usar el pod nuevo)
docker tag trade-prod-backup:latest localhost:5000/trade-prod-backup:base-7fee9ed6c22a
docker push localhost:5000/trade-prod-backup:base-7fee9ed6c22a
```

**A. Registro (corte de ~1 min; durante ese minuto nadie puede bajar imágenes).**

```sh
docker update --restart=no prod-registry && docker stop prod-registry
k3s kubectl apply -f ~/ops/k3s/63-registry.deployment.yaml
k3s kubectl -n prod rollout status deploy/registry --timeout=180s
curl -fsS http://127.0.0.1:5000/v2/_catalog          # mismas imágenes que en el paso 0
# PRUEBA NEGATIVA: con el contenedor viejo DETENIDO, containerd baja una imagen en uso
TAG=$(k3s kubectl -n prod get deploy api -o jsonpath='{.spec.template.spec.containers[0].image}')
sudo k3s crictl pull "$TAG"                           # tiene que decir "Image is up to date" o bajarla
```

Si `registry:2` no está en containerd y `md` no tiene internet, el pod queda en `ErrImagePull`.
Se precarga desde Docker: `docker save registry:2 | sudo k3s ctr images import -`.

**Volver atrás (registro):**
`k3s kubectl -n prod delete deploy registry && docker update --restart=unless-stopped prod-registry && docker start prod-registry`.

**B. Respaldo (fuera de 21:55–01:00: nunca dos `cron` disparando).**

```sh
docker update --restart=no prod-backup && docker stop prod-backup
k3s kubectl apply -f ~/ops/k3s/53-prod-backup.deployment.yaml
k3s kubectl -n prod rollout status deploy/backup --timeout=180s
POD=$(k3s kubectl -n prod get pods -l app=backup --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}')
k3s kubectl -n prod exec $POD -- sh -c 'cat /etc/cron.d/backup-prod | grep -v "^#"'      # la agenda
k3s kubectl -n prod exec $POD -- su -s /bin/sh postgres -c 'pgbackrest --stanza=prod check'  # llega al socket y al repo
```

**Volver atrás (respaldo):**
`k3s kubectl -n prod delete deploy backup && docker update --restart=unless-stopped prod-backup && docker start prod-backup`.

**C. La noche siguiente: no se declara hecho sin esto.**

- 22:00: `~/backups/trade_marketing_<fecha>_2200.dump` nuevo, y su latido en `analytics.cron_runs`.
- 23:30: `pgbackrest info` muestra un respaldo nuevo (incremental o completo según la edad del último).
- Prueba de restauración: `ops/prod/deploy.sh --pitr` (`probar-pitr.sh`, destino seguro).
- Recién entonces: `migracion: migrado` en los dos manifiestos + `profiles: ["retirado-k3s"]` en
  `backup` y `registry` de `ops/prod/docker-compose.yml`, en el mismo commit, y `check:k3s` en verde.

### Lo que se vio de paso y NO es de este item

`npm run check:base-tags` marca **`52-pg-prod` · `trade-prod-pg`**: el manifiesto dice
`base-ab04fe3d5350` y sus entradas hashean `base-a3ce41f18d79`. Alguien cambió
`ops/prod/Dockerfile.pg` / `pgbackrest.conf` sin subir la etiqueta, así que **`pg-prod` corre con
la configuración vieja sin ningún error visible**. Lo tiene que mirar quien hizo ese cambio
(probablemente `VL.9.10b`/`OPS.DISCO.3`).

---

## Verificación de la noche del 19 al 20-oct

| Qué | Resultado |
|---|---|
| `backup_prod` (pg_dump 22:00, **desde el pod k3s**) | ✅ `ok` · 2988 MB en 487 s · 786 tablas · `trade_marketing_2026-10-19_2200.dump` |
| `pgbackrest_backup` (23:30, **desde el pod k3s**) | ✅ `ok` · `diff` en 48 s (`20261018-233002F_20261019-233001D`) · 7 respaldos · 109 GB |
| `ods_publish_tienda` (OPS.LIMPIEZA.3) | ✅ `ok` (08:47, 463 aplicadas) |
| `ui_usage_flush` (OPS.LIMPIEZA.1) | ✅ `ok` |
| `cdc_reconcile_full` (OPS.LIMPIEZA.5) | ⚠️ `error`, **pero ya nombra la tabla**: `kdij@00 61026/65146 (94%)` → `OPS.LIMPIEZA.10` |
| `kepler_sales_fact_full` | ❌ sigue en `running` → la causa real es `OPS.LIMPIEZA.9` |

## OPS.LIMPIEZA.9 — El refresco completo de ventas muere por memoria desde la mudanza a k3s

**Evidencia** (log de `ingesta/feeds-cron`, 20-oct 03:00): `import-sales-fact.js` (ventana de 13
meses) termina con `FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of
memory` a los 86.5 s, con el heap en ~511 MB. Al morir así no llega a `hb.end()` y el latido queda
en `running` hasta la noche siguiente. `feed_nightly` lo reporta igual las noches del 18 y del 20.

**Mecanismo:** Node dimensiona su heap según el límite de memoria del contenedor. El pod
`feeds-cron` tiene `limits.memory: 1Gi` (`ops/k3s/26-feeds-cron.deployment.yaml`); medido dentro
del pod, `heap_size_limit` = **524 MB** y `NODE_OPTIONS` vacío. En Compose no había límite, y el
heap era varias veces mayor.

**Por qué importa:** es el **único** proceso que corrige ventas de más de 2 días atrás (el 17-sep
corrigió $9.5 M). Mientras falle, cualquier corrección tardía de Kepler no llega a
`analytics.sales_daily`. **No medido:** desde qué noche exacta falla; el renglón de `cron_runs` se
sobreescribe y el log del pod sólo guarda la vida del pod actual.

**Por qué empezó a fallar:** el proceso cargaba los 13 meses en memoria **cuatro veces** (`agg`,
`tk`, `acc` y `rows`). Su comentario habla de ~695 mil filas de origen; **hoy son 1,051,987**. La
venta creció y dejó de caber.

**Se descartó subir la memoria.** Medido el 2026-10-20: el nodo tiene 29.5 GB, con **6.8 GB
disponibles** y 3 GB de swap en uso; `pg-prod` usa 13.7 GB y `pgvector-md` 4.6 GB. Cabría, pero
vuelve a romperse cuando crezcan los datos, y le quita margen a la base de prod.

**Arreglo (commit de este item): procesar por mes.** `runCycle` arma ventanas mensuales y corre la
lectura, la conversión y el UPSERT de cada una por separado (`cargarVentana`). La memoria baja a
~1/13. El modo de N días de `livefast` queda como una sola ventana, igual que antes.

- **Por qué es exacto:** la carga es sólo UPSERT (sin DELETE) y la llave
  (`product, warehouse, channel, sale_date`) incluye la fecha; `tickets` también agrupa por fecha.
  `mart.ventas_enriched.fecha` es `date` (verificado), así que `< current_date + 1` es idéntico al
  `<= current_date` de antes.
- **Equivalencia medida en prod** (`kepler_consolidado`, sólo lectura, 2026-10-20): **14 ventanas**,
  0 solapes, 396 días cubiertos = 396 del rango viejo; agregado de una vez contra suma por
  ventanas: **1,051,987 filas y $203,763,445.31 en los dos**.
- **Lo que sí cambia:** cada mes es su propia transacción. Si falla el mes 7, los 6 anteriores
  quedan escritos. Es idempotente: la corrida siguiente los repite sin efecto. El `ANALYZE`
  condicional se hace una sola vez al final, no por mes.
- **NO probado de punta a punta:** el importer no se corrió (ni en seco) con el código nuevo. La
  prueba real es el nocturno de las 03:00 **después de que `feeds-cron` tome la imagen nueva**:
  `kepler_sales_fact_full` tiene que cerrar en `ok`, y el log tiene que mostrar 14 líneas
  `[APPLY] COMMIT <desde> → <hasta>`.

**Cómo revertir:** `git revert` del commit y reconstruir la imagen de `feeds-cron`. Volvería a
fallar por memoria.

## OPS.LIMPIEZA.10 — `cdc_reconcile_full`: `kdij` de la sucursal 00 querría borrar el 94 %

El latido nuevo funcionó: `kdij@00 61026/65146 (94%) > 60% — ABORTADO`. El freno hizo lo correcto.

**Qué es:** `kdij` es el kardex de movimientos de inventario por almacén (`docs/ERP_KEPLER.md` §3.x).
`00/kdij` **ya estaba declarada como podada** (`ODS_PODA_POR_EDAD` vale `00/kdij:c10` por
defecto, `[OBS.12]` del 01-oct). El problema era **dónde se ponía el corte**.

**Causa, medida el 2026-10-20 en sólo lectura:** el corte era `min(c10)` del origen. La réplica
`kepler_md_00` tiene hoy **3,681 filas: 2 de dic-2025 y 16 de abr-2026 sueltas**, y después nada
hasta fines de septiembre. Esas rezagadas corrían el corte al **2025-12-03**, y las ~61 mil filas
del ODS entre diciembre y septiembre se leían como «borradas». Día por día, réplica y ODS
**coinciden exacto desde el 22-sep** (22/22, 3/3, 127/127…); antes la réplica está vacía o casi
(21-sep: 4 contra 247). Dentro de ese tramo sólo difieren 8 filas (07-oct: 240/241; 13-oct:
140/147).

**Arreglo (`reconcile-ods-window.js`, `corteDeCobertura`):** el corte es el primer día del tramo
final (hacia hoy) en que la réplica cubre **≥ 90 %** del ODS todos los días
(`ODS_PODA_COBERTURA`, default 0.9). Lo anterior es historia y se conserva; lo de adentro se
evalúa como siempre. Si ni el día más reciente cubre, el corte queda `null` → `poda_no_medida`
→ no se borra nada (igual que antes). Un día borrado entero corta el tramo y deja **más**
historia: si hay error, cae del lado seguro.

**Resultado esperado con los datos del 20-oct** (simulado a mano sobre la tabla diaria medida, no
corrido): corte = **2026-09-22** · ~61 mil filas conservadas como historia · **8 candidatas**
(0.01 %, lejos del freno del 60 %) que se propagan como bajas reales. Se ve en el próximo
`cdc_reconcile_full` (02:10) **después de que la imagen de ingesta tome el cambio**: el latido
tiene que salir `ok` con `conservadas_por_poda` y `borrados 8` (o cerca).

**Cómo revertir:** `git revert` del commit. Volvería a abortar cada noche, sin borrar nada.

---

## Lo que queda abierto

- **OPS.LIMPIEZA.2** — `feed_route_stock`: ¿retirar o agendar `import-route-stock.js`? Decide Edgar.
- **OPS.LIMPIEZA.6** — Apagar `caja_general_ship` y `caja_general_replica_all` (copian un Access
  que se dejó de escribir el 10-oct) y decidir `caja_autollenado`. Decide Edgar.
- **`caos_ingreso_conciliar`** (dos cálculos del mismo ingreso, corte a las 18:00): va a la fase CGA
  porque toca dinero de Caja General.
