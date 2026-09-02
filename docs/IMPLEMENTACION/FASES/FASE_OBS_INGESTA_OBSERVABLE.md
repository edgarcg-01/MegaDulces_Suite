# Fase OBS — Ingesta que no se cae en silencio

> **ADR-053 (propuesto).** Un feed sin latido propio es un feed invisible. Todo carril de ingesta
> reporta su propia **entrega** a `analytics.cron_runs` por un canal que **no es el que vigila**, corre
> bajo un supervisor con healthcheck de entrega (no de "el proceso está vivo"), se auto-cura de sus
> modos de muerte conocidos, y su alerta **sale del edificio**. Lo derivado del ODS **declara su
> rezago** en vez de dibujarse como fresco. Hereda ADR-035 (`feeds-ingest`), ADR-043 (INFRA) y
> ADR-051 (declarar, no dibujar).

**Estado global:** 🔨 EN CURSO (arranque 2026-09-02)
**Persona:** Edgar + plataforma (Railway + on-prem)

---

## 1. Por qué (el incidente)

El 2026-09-02 se descubrió que el carril de catálogos del ODS estaba **parado desde el 2026-08-27**
(6 días). `kdii`, `kdik`, `kdil` y `kdud` acumulaban **~23,200 filas sin shipear — 10,248 de ellas de
costo**. La plataforma siguió publicando precio, costo, margen y reorden con toda confianza.

**Cómo se descubrió:** por accidente. Edgar corrigió a mano un precio en Kepler (SKU `88222`,
$54.00 → $165.28, un precio que estaba **54% bajo el costo** de $117.46) y el cambio nunca apareció
en la app. El diagnóstico de por qué no aparecía destapó el congelamiento.

### Cronología

| fecha | qué pasó |
|---|---|
| 2026-08-21 | Se montan los slots `ods_cdc_00..06` (ADR-047). Quedan invalidados (`wal_status='lost'`). Los 7 consumidores entran en crash-loop. |
| 2026-08-26 19:05 | El loop viejo se corta a mano (`^C` en `ods-live-loop.log`). |
| 2026-08-27 01:0x | Última corrida del carril de catálogos (`ods.ctl.last_run_at`). Se completa el cutover CDC.6: `OdsLiveLoop`, `OdsFullMirror`, `OdsFastLoop`, `OdsReplicate*` → `Disabled` — **con el carril nuevo ya muerto**. |
| 2026-08-27 → 09-02 | **Nadie shipea catálogos.** Los 7 `cdc_wal_*` acumulan ~4,600–5,560 reinicios hasta que PM2 se rinde. |
| 2026-09-02 | Diagnóstico, deshielo manual, OBS.0/OBS.1. |

### Qué falló — y qué NO

**La detección funcionó.** `db-health` tenía los 7 `cdc_wal_*` en `error`, con el `note` diciendo el
comando exacto a correr, y el sensor `kepler_ods` (`_sync_status.last_push_at`, `critH: 1` h) en
crítico. **El diseño de la alarma es bueno.** Fallaron cuatro cosas distintas:

1. **El canal de salida.** `DbHealthScannerService` ya manda correo (`MAILER_PORT` →
   `SmtpMailerAdapter`, crítico-only, batch por ciclo, recordatorio 24 h). **`SMTP_*` no está
   configurado** → `isConfigured() === false` → no-op silencioso. La alarma sonó en una habitación vacía.
2. **El carril que alimenta prod era mudo.** `replicate-ods-live.js` no escribía latido y no tenía
   entrada en `CRON_JOBS`. Su única señal era el `mtime` de un `.log`. Igual `replicate-ods-fast.js`
   y `ods-cdc-forward.js`.
3. **El supervisor no sabe curar.** `ensurePubSlot` (`ods-cdc-wal.js:60-70`) trata un slot
   *existente pero `lost`* como sano → `slot ya existía` → `muerteTimer` sale con 1 → PM2 reinicia →
   repite. El comentario delega backoff y recreación del slot al supervisor; **PM2 no hace ninguna**.
4. **El sustrato depende de una sesión.** PM2 corre en sesión `Console` del usuario.

### Lo que el propio repo ya había predicho

- `FASE_SYNC_TIEMPO_REAL.md` §8: *"**Verificar frescura por fecha-dato**: el heartbeat prueba que
  arrancó, no que avanzó."* — nunca se construyó (era Fase 1.5).
- `FASE_CDC_ODS_LOGICAL.md`: *"CDC.5 es requisito operacional **antes** de retirar el poll (CDC.6)"*.
  El cutover se hizo sin ese requisito.
- `reconcile-ods-window.js:163`: *"los latidos de `cdc_wal_00..06` estuvieron verdes y correctos todo
  el tiempo mientras se perdía 2-7% de las filas diarias. **Un latido prueba que el caño se mueve, no
  que llegó todo.**"*

### Lo que NO causó el incidente

Los **~81 precios de etiqueta bajo costo** no los causó el congelamiento: bajaron de 82 a 81 tras el
deshielo. Son basura de configuración en Kepler que la **moda** de `label-compute` elige por mayoría
(sucursales que no manejan el SKU votan su `c90` sin configurar). Eso es **Fase ET**, plan aparte.

---

## 2. Decisiones (Edgar, 2026-09-02)

| tema | decisión |
|---|---|
| Canales | **Correo + en la app + WhatsApp** al celular |
| Sustrato | **Docker** (`restart: unless-stopped` + `HEALTHCHECK`) |
| Robustez | **Un nodo + auto-curación** (no redundancia multi-nodo) |
| Dato viejo | **Declara el rezago y sigue** (no bloquea la operación) |
| Alcance | **Todos los feeds** |
| Umbrales | **Por clase de feed** (vivo 15 min · horario 3 h · nocturno 26 h) |
| WhatsApp | Hay que **crear la plantilla** de utilidad → ⚠️ BLOCKED hasta aprobación de Meta |
| Correo | **Google Workspace** (`smtp.gmail.com:587` + contraseña de aplicación) |

---

## 3. Arquitectura — cuatro capas, cada una contra una falla distinta

```
①  ENTREGA        cada carril late su propia entrega   →  analytics.cron_runs
②  COMPLETITUD    reconciliador cuenta huecos          →  cron_runs (canal DIRECTO, no el sink)
③  SUPERVISIÓN    Docker restart + HEALTHCHECK de entrega  +  auto-curación del slot
④  SALIDA         db-health → correo + WhatsApp + app  +  el dato declara su rezago
```

**Principio que no se negocia** (`reconcile-ods-window.js:154-166`): *un latido no debe viajar por el
mismo canal que vigila*. `ods-cdc-wal.js` late **por el sink que monitorea** — el 2026-08-26 una
rotación de key dio 401 en los 7 consumidores **sin alarma**. Todo latido nuevo va **directo a prod**.

---

## 4. Sprints

Ruta crítica: **OBS.0 → OBS.1 → OBS.2 → OBS.5**.

### OBS.0 — Parar la sangría
- ✅ **OBS.0.1** (2026-09-02) Limpieza de `~/.pm2/dump.pm2`: borradas 8 apps muertas (`ods-cdc` +
  7 `cdc-wal-*`) y 2 rotas (`ods-live`/`ods-mirror` con `script: CMD.EXE` — PM2 no ejecuta `.cmd`).
  La tarea `PM2 Resurrect ODS` (trigger de logon) las habría revivido en crash-loop. Quedan sólo
  `wincaja-inc`/`wincaja-hash`, sanos. **Falta `pm2 save`** (se hace junto con OBS.4).
- ⬜ **OBS.0.2** `SMTP_*` + `DB_HEALTH_ALERT_EMAILS` + `APP_PUBLIC_URL` en Railway. **Esto solo
  convierte la alarma existente en una que avisa** — mejor relación valor/esfuerzo de la fase.
  Verificar con `POST /admin/db-health/scan-now`.

### OBS.1 — Que el carril mudo hable ✅ (2026-09-02, commit `3375d0d7`)
- ✅ Latido por carril en `replicate-ods-live.js`: `ods_live_hot` / `ods_live_mirror`, **directo a
  prod**. Var propia **`ODS_HB_URL`** (fallback `FLEET_DB_URL`) porque en ese script
  `DATABASE_URL_NEW` apunta al **contenedor de replicas** `:5433`, no a prod — un latido ahí es
  invisible para el tablero (GOTCHAS §17/§18).
- ✅ Preflight fail-fast en watch: sin destino de latido **aborta**; y rechaza un `ODS_HB_URL` que
  apunte a la FUENTE.
- ✅ `cycleAll` agrega las **fallas por rama** al `error` del latido. Antes un replica caído era un
  `continue` mudo: la pasada podía shipear **cero** e imprimir `APPLY hecho.` igual. Patrón copiado
  de `replicate-wincaja-live.js:200-207`.
- ✅ `CRON_JOBS`: los 2 carriles nuevos + **5 huérfanos** que **ya latían** pero, sin umbral
  registrado, caían en el `cfg ? classify : 'ok'` de `checkCronRuns()` y se pintaban **verde
  incondicional**: `wincaja_replica_inc`, `wincaja_replica_hash`, `contpaqi_add_cfdis`,
  `analytics_refresh_wincaja`, `feed_guardian`. *Un latido sin umbral registrado no es una alarma.*
- 🔵 **Descartado por Edgar:** endurecer el default de `checkCronRuns()` para que un job no
  registrado no herede el verde incondicional. Queda el riesgo de que el próximo huérfano sea
  invisible; se mitiga registrando a mano.
- ⬜ **OBS.1.2** Mismo tratamiento a `replicate-ods-fast.js` y `ods-cdc-forward.js` (siguen mudos).

**Verificado en vivo:** `ods_live_mirror` reportando `7/7 ramas · 118 filas · 0 tablas con error`
en prod. `tsc --noEmit` del API en verde.

### OBS.2 — Auto-curación ⛔ ruta crítica
- ⬜ **OBS.2.1** `ensurePubSlot` (`ods-cdc-wal.js:60-70`) debe validar `wal_status` y `active`, no
  sólo existencia. Slot `lost`/`unreserved` → dropear + recrear + **disparar el backfill por scan**
  (`replicate-ods-live --branch=XX --apply`) automáticamente. Es lo que hoy el `note` le pide a un humano.
- ⬜ **OBS.2.2** Backoff exponencial + jitter antes de salir (hoy sale inmediato → 5,000 reinicios).
  `min_uptime` + `exp_backoff_restart_delay` en el supervisor.
- ⬜ **OBS.2.3** **Los dos carriles quedan permanentes**: CDC para latencia, scan para
  reconciliación. Nunca uno solo — tratarlos como sustitutos es lo que convirtió una falla en 6 días
  de congelamiento. **Revierte la premisa de CDC.6.**

### OBS.3 — Completitud, no sólo latido
- ⬜ **OBS.3.1** **Arrancar `reconcile-ods-window.js`** (`--days=3 --apply --watch=900`). Ya está
  escrito, ya late directo a prod (`cdc_reconcile`), ya marca `error` cuando
  `huecos > ODS_RECONCILE_ALERT` (50). Está declarado en `ecosystem.cdc.config.js:71` y **nunca se
  levantó**. Cero código nuevo. Su entrada en `CRON_JOBS` ya existía.
- ⬜ **OBS.3.2** Sensor de **fecha-dato por (tabla, sucursal)** para catálogos — el Fase 1.5 nunca
  construido. Hoy `_sync_status` de `kepler_ods` **no tiene dimensión de sucursal**
  (`apply-handlers.js:521-524` la anula a propósito) y los sensores por rama que existen
  (`kepler_ods_branch_stale`) miran `kdm1` = **venta, no catálogo**. Por eso 6 días de catálogo
  congelado no dispararon ningún sensor por rama.

### OBS.4 — Sustrato Docker
- ⬜ **OBS.4.1** `ops/ingest/docker-compose.yml` + `env_file` **fuera del repo**
  (`C:\KeplerRunner\ingest.env`), `restart: unless-stopped`, un servicio por carril.
- ⬜ **OBS.4.2** **`HEALTHCHECK` que mide ENTREGA, no proceso**: `health.js` sale ≠ 0 si el latido
  del carril no avanzó en N min. Es lo que PM2 no puede dar — el 2026-09-02 `pm2 ls` dijo `online`
  mientras el batch no se ejecutaba (PM2 abrió un `cmd` interactivo).
- ⬜ **OBS.4.3** **Red**: los shippers leen `localhost:5433`, que dentro de un contenedor no
  resuelve. Unirse a la red de `pgvector-md` y usar su nombre de servicio (o `host.docker.internal`).
- ⬜ **OBS.4.4** Retirar los `.cmd :loop` de `C:\KeplerRunner` y con ellos la **key en texto plano**.
- ⚠️ **Excepción al "todo Docker"**: los carriles vivos de **Wincaja** leen `.mdb` de Access por SMB
  con **Jet 32-bit**, que no existe en Linux. `wincaja-inc`/`wincaja-hash` **se quedan en Windows**
  (llevan 42 h con 0 reinicios). El sustrato queda **mixto a propósito**: Docker para lo que habla
  Postgres/HTTP, Windows para lo que necesita Jet.

### OBS.5 — Que la alerta salga del edificio
- ⬜ **OBS.5.1** Correo: ya cableado, sólo faltan las env (OBS.0.2). **No hace falta Grafana.**
- ⬜ **OBS.5.2** WhatsApp: `AlertsNotifierAdapter` calcando
  `apps/api/src/composition/finance-notifier.binding.module.ts`, llamando
  `WHATSAPP_PORT.sendTemplate()`. Consumidor: `DbHealthScannerService`, **sólo crítico**, mismo
  anti-spam de `last_notified_at` que el correo. ⚠️ BLOCKED por la plantilla de Meta (3 variables:
  feed, estado, antigüedad). `WHATSAPP_PROVIDER` default es `simulator` → se prueba sin Meta.
- ✅ **OBS.5.3** App: ya funciona (`AlertsGateway` → `emitDbHealth` → `HealthAlertToastComponent` +
  `NotificationsBellComponent`). Sin trabajo.
- ⬜ **OBS.5.4** **Vigilar al vigilante**: `database/importers/lib/health-watchdog.js` ya existe, con
  canario sobre `db_health_scan` y `WATCHDOG_WEBHOOK_URL`; actúa sólo cuando el scanner del API está
  caído. Falta configurarle el webhook y meterlo al sustrato nuevo.
- ⬜ **OBS.5.5** `run-feed-guardian.ps1` **no cubre nada supervisado por PM2/Docker** — hoy nada
  externo vigila los consumidores CDC ni los carriles de Wincaja. Extenderlo o reemplazarlo por el
  healthcheck de OBS.4.2.

### OBS.6 — El dato declara su rezago ✅ 6.1 + 6.2 (2026-09-02, commit `f7333af0`)

- ✅ **OBS.6.1** `analytics.v_feed_freshness` — unifica `analytics.cron_runs` (por carril) y
  `kepler_ods._sync_status` (por tabla) sin copiar ninguna: `derive-no-copy` sobre las dos primarias.

  **Devuelve hechos, no veredicto — y eso fue deliberado.** La vista da EDAD y no lleva umbrales:
  esos ya tienen dueño único en `CRON_JOBS`/`EXT_SOURCES` de `db-health.service.ts`. Clavarlos
  también en SQL crearía dos fuentes que se separan en silencio — alguien afloja el umbral en TS, la
  vista sigue diciendo lo viejo, y el tablero y la pantalla se contradicen sin que nadie sepa cuál
  manda. El veredicto lo emite quien tiene la política.

  **Las dos lecturas de una tabla vieja** (lo que el diseño ingenuo habría roto): `last_push_at`
  marca el último EMPUJE, no la última revisión. Un valor viejo admite dos lecturas opuestas —
  *(a)* el carril está caído (el incidente del 27-ago) o *(b)* la tabla no cambió (frescura
  perfecta: el carril hash sólo empuja lo que difiere). Medido en prod **con los tres carriles
  sanos**, `k95doc`, `kdrhfpag`, `kdmt` y compañía dan ~334 h de "edad" y están al día. Por eso
  `clase` va **NULL** para `origen='ods_table'`: el ritmo de una tabla del ERP no se deduce de su
  nombre, y la vista no inventa lo que no puede medir. **El carril prueba que se REVISÓ; la tabla
  dice cuándo CAMBIÓ.** Son preguntas distintas y hacen falta las dos.

- ✅ **OBS.6.2** La etiquetera (`/tienda/etiquetas`) declara su rezago. Es el caso que originó la fase.

  **Dos eslabones, no uno.** La cadena del precio son dos pasos que se mueren por separado:
  *(1)* `ods_live_hot` shipea `kdii`/`kdpv_prod_util` del ERP al ODS — si muere, el ERP cambia el
  precio y acá nunca llega (**lo del 27-ago**); *(2)* hop-2 recalcula
  `commercial.product_label_prices` — si muere, el ODS está fresco y la etiqueta igual queda vieja.
  Vigilar uno deja el otro ciego.

  ⚠️ **No se usa el `computed_at` de la FILA como señal.** Se movería sólo cuando ESE producto
  cambia de precio, así que un SKU estable daría semanas de "edad" estando al día — el mismo falso
  positivo de 6.1. Se usa `max(computed_at)` de la tabla, que sí prueba que el recálculo sigue vivo.

  **Sin latido = `stale`, nunca `ok`.** Es la falla más grave (el carril ni siquiera reporta), y el
  default permisivo es exactamente cómo un feed muerto se disfraza de sano. Si la frescura no se
  puede **medir**, se declara desconocida — jamás fresca.

  **Declara, no bloquea** (decisión de Edgar): el banner va arriba del escáner, sin botón de cerrar
  (es una condición del dato, no un mensaje de una acción) y **nombra qué eslabón** está viejo, para
  que el aviso sea accionable y no sólo "hay rezago".

  Tolerancias del consumidor (1 h el carril, 12 h el recálculo) **≠** umbrales de `db-health`:
  *"¿puedo pegar este número en el anaquel?"* y *"¿hay que despertar a alguien?"* son preguntas
  distintas, con audiencias distintas, y merecen números distintos.

  Guardia `to_regclass` sobre la vista → la etiquetera no se rompe entre el deploy y la migración.

- ⬜ **OBS.6.3** Los servicios que ya devuelven `data_as_of` suman `stale: boolean` + `age_human`.
  **El patrón ya existe y se renderiza**: `commercial-profitability.service.ts:663` →
  `comercial-rentabilidad.component.ts:104`, y `purchase-adjustments.service.ts:607` → las 5 páginas
  de `/compras`. Falta el veredicto, no el canal.

### OBS.7 — Regresión
- ⬜ `database/tests/test-newdb-feed-observability.js` en `run-all-tests.js`. Asertos: (a) cada
  carril vivo tiene fila en `cron_runs` con edad < umbral; (b) un latido faltante da `unknown`, no
  falso verde; (c) `status='error'` abre fila en `analytics.db_health_alerts` y marca
  `last_notified_at` sólo al enviar; (d) el healthcheck sale ≠ 0 con el latido congelado. Reusar
  `test-newdb-db-health-engine.js` y `test-newdb-raw-upsert.js`.

---

## 5. Deuda operacional abierta

- **El shipper corre por `Start-Process`** (PIDs 24740 / 28780) → **no sobrevive un reboot**. Es el
  stopgap hasta OBS.4.
- **`FEEDS_INGEST_KEY` en texto plano** en los 4 launchers de `C:\KeplerRunner` (mismo valor de 48
  chars) y horneada en `~/.pm2/dump.pm2` por `pm2 save`. Rotación → **INFRA.1.4**.
- **El CDC sigue muerto.** Prod lo sostiene el poll. Sin CDC no hay propagación de **DELETE**
  (`raw-upsert` no borra) — verificado: la rama 04 tiene **9,532 filas en el ODS contra 9,525 en el
  replica**, 7 filas que el UPSERT no puede eliminar.
- **Pasadas largas del carril hot** mientras drena el backlog (>2 h, aún en rama 02). El latido queda
  en `running` todo ese tiempo; sin `maxRunH` eso da `warn` recién al cruzar `critH`. Transitorio.

## 6. Fuera de alcance

- Redundancia multi-nodo con elección de líder (Edgar eligió un nodo + auto-curación).
- **Túnel** para que Railway se suscriba nativo a los replicas — mataría el proceso del hop 2, pero
  el Postgres administrado de Railway no admite cliente de túnel adentro (haría falta un relay con
  dirección estable) y **la replicación nativa no puede hacer el fan-in de 7 bases a una tabla con
  `sucursal`**: quedarían 7 esquemas + vista `UNION ALL`. Es rediseño, no ajuste.
- **Grafana Alerting.** El stack LGTM está en prod (INFRA.2.3) pero `db-health` + `MAILER_PORT` ya
  cubren el caso con menos piezas. Se revisita si hacen falta series históricas.
- **Fase ET** (precio de etiqueta por sucursal + piso de costo) — plan aparte.

---

## 7. Leer antes de tocar

`docs/GOTCHAS.md` §13, §17, §18, §21, §22 · `FASE_CDC_ODS_LOGICAL.md` ·
`FASE_SYNC_TIEMPO_REAL.md` §7-8 · `RUNBOOK_REPLICACION_LOGICA.md` §3.4 ·
`AUDITORIA_FRESCURA_FK_NORM.md`
