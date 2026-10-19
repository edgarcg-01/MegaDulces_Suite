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
nombre del Postgres de Compose, que está parado). Por eso `kepler_sales_fact_full` mostraba
`running` desde hacía 35 h: `last_finish` 03:01:33.177 y `last_start` .186, dos emisores con la
misma llave. **Alguien lo arrancó el 19-oct a las 15:09:45**, sin rastro en git. **No se tocó.**

Para pararlo (decide quien lleve `OPS.DISCO` o Edgar):

```sh
docker update --restart=no feeds-cron && docker stop feeds-cron
```

Sin `--restart=no`, `unless-stopped` lo revive en el próximo reinicio de `md`.

---

## Lo que queda abierto

- **OPS.LIMPIEZA.2** — `feed_route_stock`: ¿retirar o agendar `import-route-stock.js`? Decide Edgar.
- **OPS.LIMPIEZA.6** — Apagar `caja_general_ship` y `caja_general_replica_all` (copian un Access
  que se dejó de escribir el 10-oct) y decidir `caja_autollenado`. Decide Edgar.
- **`caos_ingreso_conciliar`** (dos cálculos del mismo ingreso, corte a las 18:00): va a la fase CGA
  porque toca dinero de Caja General.
