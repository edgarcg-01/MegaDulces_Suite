# Dónde vive la ingesta

> **Fuente única de "qué corre dónde".** Si otro documento contradice a éste, gana éste —
> y corregí el otro. Medido en vivo el **2026-09-11**.
>
> Antes de este día TODA la ingesta corría en una máquina de escritorio Windows (`.249`),
> con la agenda en el Programador de Windows: fuera del repo, invisible en un diff, y
> **17 de 21 tareas atadas a una sesión de usuario abierta**. La noche del 10-sep esa
> máquina se reinició por Windows Update y **la ingesta estuvo 9.5 h parada** porque Docker
> Desktop no arranca hasta que alguien inicia sesión. Eso es lo que la Fase VL vino a
> terminar (ADR-060).

---

## 1. Los dos lugares

| | `md` — **el servidor** | `.249` — **la máquina de escritorio** |
|---|---|---|
| Qué es | `192.168.0.222` · Ubuntu Server 26.04.1 · Ryzen 5 4600G 6c/12h · 14 GiB · NVMe 1 TB | `SISTEMAS` · Windows 11 · Ryzen 5 3400G · 30 GB |
| Qué corre | **La ingesta completa**: la fuente + los 13 carriles | Sólo lo que **no puede** correr en Linux, y el respaldo |
| Cómo arranca | `systemd` → Docker → `restart: unless-stopped`. **Sin sesión, sin nadie.** | Docker Desktop y 5 de 6 tareas **exigen sesión iniciada** |
| Verificado | ⭐ **Reinicio real el 2026-09-11**: los 8 contenedores volvieron solos en **39 s**, Postgres sin recuperación de caída, las 8 suscripciones al instante | — |

Acceso: `ssh superoot@192.168.0.222`.

---

## 2. Qué corre en `md`

Todo se define en **[`ops/vl/docker-compose.yml`](vl/docker-compose.yml)** (en el servidor vive
en `~/ops/vl/`). Los secretos en `~/secrets/{feeds,ingest}.env`, permisos `600`, **fuera del repo**.

### 2.1 Contenedores

| Contenedor | Qué hace | Cadencia | Latido |
|---|---|---|---|
| `pgvector-md` | **La fuente**: Postgres 18 con las 8 réplicas lógicas de las sucursales + `kepler_consolidado`. Publica `:5433` | — | healthcheck `pg_isready` |
| `ods-live-hot` | Carril caliente réplica → `kepler_ods` de prod (venta, movimientos, catálogos) | @15 s | `ods_live_hot` |
| `ods-live-mirror` | Espejo completo de lo que el hot no cubre | @300 s | `ods_live_mirror` |
| `ods-reconcile` | **La única alarma de COMPLETITUD**: compara llaves y repone el delta | @900 s | `cdc_reconcile` |
| `feeds-cron` | Los **12 carriles agendados** (§2.2) | ver abajo | uno por carril |
| `feeds-livefast` | Venta del día + cajas abiertas. Sub-minuto, por eso **no** va en cron | @60 s | `feed_livefast` |
| `store-poller` | Tickets en vivo → `/tienda/live` | @25 s | `store_poller` |
| `ods-autoheal` | **El brazo**: reinicia lo que se declare `unhealthy` | @30 s | — |

### 2.2 Los carriles agendados

La agenda vive **versionada en el repo**: [`ops/vl/crontab.feeds`](vl/crontab.feeds). Un cambio se
revisa en un diff, que es justo lo que el Programador de Windows no permitía.

```
* * * * *     receipts · contpaqi · fleet-gps
*/2 * * * *   refresh-consolidado
*/5 * * * *   watchdog
*/15 * * * *  stock
*/30 * * * *  live · prices
0 * * * *     intraday
0 */2 * * *   contpaqi-slow
0 3 * * *     nightly
0 2 * * 6     catalog          (sábado 02:00)
```

Todos pasan por **[`ops/vl/run-feed.sh`](vl/run-feed.sh)**, que hace dos cosas que `crond` no:
carga el entorno desde el archivo (busybox `crond` **no hereda** el entorno del contenedor) y
serializa con `flock` (no existe el `IgnoreNew` del Programador, y los de 1 minuto se apilarían).

---

## 3. Qué sigue en `.249`, y por qué

| Tarea | Por qué no se mudó | Cuándo |
|---|---|---|
| `WincajaLive` · `WincajaSyncActual` · `WincajaSyncConcentrada` | ⛔ **El único bloqueo real de "todo en Linux"**: leen `.mdb` con **Jet 4.0 de 32 bits** sobre `Z:` (`\\192.168.0.245\D`). `Z:` es una unidad **mapeada por sesión**, así que la tarea **no puede** correr sin sesión iniciada — y un token `S4U` tampoco lleva credenciales de red | **VL.5**, decisión pendiente |
| `\Kepler\FeedGuardian` | Su único vigilado vivo es `WincajaLive`; se retira cuando cierre VL.5 | VL.5 → VL.6 |
| `TradeMarketing-DailyBackup` | `pg_dump` de prod. Es `S4U`: **sí sobrevive al reinicio**. Late en `backup_prod` | **VL.6.3** |
| `PM2 Resurrect ODS` | Residuo: PM2 salió del proyecto | VL.7 |

⚠️ **Las 11 tareas que sí se mudaron quedaron DESHABILITADAS, no borradas** — son el rollback.
No las vuelvas a habilitar sin apagar antes su contenedor: **un carril = UN dueño**, y dos
procesos con el mismo `job_key` se pisan el renglón del latido (pasó hoy con el watchdog).

---

## 4. Cómo se despliega un cambio

`md` **no tiene el repo**, y la imagen es **autocontenida** (el código se copia adentro). O sea
que un cambio de código exige **reconstruir**, no reiniciar:

```sh
ops/vl/deploy.sh                 # reconstruye y recrea los feeds
ops/vl/deploy.sh feeds-cron      # sólo esos servicios
ops/vl/deploy.sh --estado        # qué corre allá y con qué imagen
```

⛔ Archiva **`HEAD`**, no la copia de trabajo: el índice de git lo comparten ~10 sesiones y el
working tree traería WIP ajeno a producción. Te avisa qué archivos no viajan.

---

## 5. Cómo se sabe si está sano

**El rótulo no es el veredicto.** Un contenedor `healthy` con el latido viejo ya pasó — por eso
los healthchecks miden **entrega** (`analytics.cron_runs` **en prod**), no que el proceso exista:

```sh
ssh superoot@192.168.0.222 'set -a; . ~/secrets/ingest.env; set +a;
  psql "$ODS_HB_URL" -c "SELECT job_key, status, host,
    round(extract(epoch from (now()-last_finish))/60.0,1) AS hace_min, note
    FROM analytics.cron_runs ORDER BY last_finish DESC NULLS LAST;"'
```

Reglas que ya costaron caro:

- **Un latido sin umbral registrado en `CRON_JOBS`** (`apps/api/src/modules/db-health/db-health.service.ts`)
  **no es una alarma: es decoración** — `db-health` lo pinta verde por viejo que esté.
- **`status='error'` no siempre significa "reiniciá"**: en varios carriles es alarma de **dato**
  (ContPAQi caído, sesión del GPS vencida). Por eso llevan `ODS_HB_IGNORE_ERROR=1`: lo que
  dispara el brazo es que el ciclo **deje de completarse**.
- **`cdc_reconcile` NO se juzga contra cero.** El régimen normal medido son **42–167 huecos por
  ventana de 3 días, todos repuestos**. El criterio es `repuestas == huecos` y `errores 0`.

---

## 6. Las variables, que significan cosas distintas según el carril

⚠️ Ver [`docs/GOTCHAS.md`](../docs/GOTCHAS.md) §17. En resumen, dentro de `md`:

| Variable | Apunta a |
|---|---|
| `ODS_SOURCE_BASE` | **la fuente** — el Postgres de réplicas del propio `md` |
| `DATABASE_URL_NEW` | **prod** en los feeds… pero **la fuente** en los shippers del ODS |
| `ODS_HB_URL` / `FLEET_DB_URL` | **prod, siempre** — por eso el latido usa éstas y no `DATABASE_URL_NEW` |

Un latido escrito en el lugar equivocado es invisible para el tablero, que vive en prod: ése es
exactamente el modo de falla que la Fase OBS existe para eliminar.

---

## 7. De dónde salen las réplicas

`pgvector-md` **no copia** de las sucursales con un importer: son **8 suscripciones de
replicación lógica** que tiran (`pull`) desde 8 subredes distintas. La copia de VL.2b fue
**física** justamente para preservar `pg_replication_origin` y que las 8 retomaran desde su slot
**sin hueco**.

⚠️ Las suscripciones viejas quedaron en `.249` en **`DISABLE`, no `DROP`** (rollback). ⛔ Si
alguna vez se dropean allá, **primero `ALTER SUBSCRIPTION … SET (slot_name = NONE)`**, o el
`DROP` le borra el slot **al publicador** y le corta la fuente al servidor nuevo.

---

## 8. Lectura de desarrollo

Los devs leen las réplicas de `md` (**no prod**) con un rol por persona, sólo lectura:
`ops/vl/dev-ro-setup.sh` · credenciales en `md:~/secrets/dev-ro/<usuario>.txt`.
Detalle y trampas en el encabezado de [`ops/vl/sql/dev-ro-grants.sql`](vl/sql/dev-ro-grants.sql).

---

**Plan completo, sprint por sprint:**
[`docs/IMPLEMENTACION/FASES/FASE_VL_VPS_LOCAL.md`](../docs/IMPLEMENTACION/FASES/FASE_VL_VPS_LOCAL.md)
· decisión en **ADR-060**.
