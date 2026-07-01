# Runbook — KP_CONCENTRADA (ODS concentrado de Kepler)

> DB en `192.168.0.245` que **concentra todas las tablas `md.*` de las 6 sucursales**
> Kepler (`md_00..md_05`) en un solo lugar, schema `kp.*`, con **watermark** por
> `(sucursal, tabla)` para refresco incremental. Corre **on-prem** (la LAN de Kepler
> no es alcanzable desde Railway ni desde el chat).

Script: [`database/importers/kepler/concentrate-kepler.js`](../../../database/importers/kepler/concentrate-kepler.js).

## Qué hace

- **Schema-discovery**: descubre en runtime cada tabla/columna de `md.*` (soporta las ~330 sin config). Crea `kp.<tabla>` con `sucursal` + columnas crudas (`cN`, tipos preservados) + `_loaded_at`.
- **Watermark** en `kp.sync_control (sucursal, table_name, ts_col, mode, last_value, last_run_at, rows_last, rows_total)`. `last_value` = MAX de la columna de fecha cargada → de ahí sigue el próximo run.
- **Modo por tabla** (automático):
  - **incremental** si la tabla tiene columna timestamp/date (elige la de MAX más reciente). Overlap-reload: `DELETE where ts >= last_value; INSERT where ts >= last_value` → idempotente, sin duplicados ni huecos.
  - **full** (reemplazo por sucursal) si no hay columna de fecha (catálogos).
- **Lectura sin OOM**: keyset por `ctid` dentro de una trx REPEATABLE READ (snapshot estable, O(n), memoria acotada). Sin dependencias externas.

## Requisitos

- Correr desde on-prem (laptop `192.168.0.249` o el propio `.245`) con acceso a las 6 sucursales + a `.245`.
- Credenciales: destino `.245` = `postgres/superoot`; sucursales = `platform_ro/kepler123` (ajustar en env si difiere).

## Uso

```bash
# 1) DRY-RUN (default): imprime el PLAN (tablas, modo, ts_col, filas a cargar). No escribe.
node database/importers/kepler/concentrate-kepler.js

# 2) Primera carga COMPLETA (crea la DB si no existe + carga todo):
node database/importers/kepler/concentrate-kepler.js --create-db --apply

# 3) Refresco INCREMENTAL (corridas siguientes; solo lo nuevo por watermark):
node database/importers/kepler/concentrate-kepler.js --apply

# 4) Reconciliación FULL (recomendado semanal — reconcilia masters con fecha NULL):
node database/importers/kepler/concentrate-kepler.js --apply --full
```

### Flags / env útiles

- `--branch=03` — solo una sucursal. `--tables=kdm1,kdpord` — solo esas (pruebas).
- `--create-db` — crea `KP_CONCENTRADA` si falta (necesita permiso de superusuario).
- `KP_DEST_URL` — destino (default `postgresql://postgres:superoot@192.168.0.245:5432/KP_CONCENTRADA`).
- `KP_BRANCH_MAP` — JSON `[{code,url}]` para override de sucursales (IPs/puertos).
- `KP_EXCLUDE` — csv de tablas a saltar. **Recomendado** si no querés el peso fiscal:
  `KP_EXCLUDE=kdmx_25,kdmx_26` (XML CFDI, ~450k filas de blobs). Los `kdfe*` (119 tablas
  de timbrado) también son ruido si solo te interesa lo comercial/operativo.

## Consultar el watermark (¿hasta cuándo tengo datos?)

```sql
-- Última carga por sucursal×tabla, con la fecha del último dato tomado.
SELECT sucursal, table_name, mode, ts_col, last_value, last_run_at, rows_total
FROM kp.sync_control
ORDER BY last_run_at DESC;

-- Ej: ¿hasta qué fecha tengo ventas (kdm1) por sucursal?
SELECT sucursal, last_value AS ultima_venta_cargada
FROM kp.sync_control WHERE table_name = 'kdm1' ORDER BY sucursal;
```

## Notas y límites

- **Incremental sigue la columna de fecha.** Filas cuya fecha sea NULL (posible en
  algunos catálogos) se cargan en el primer full y no se re-evalúan → correr `--full`
  periódicamente reconcilia. Las tablas transaccionales (kdm1/kdij/kdpord) tienen fecha
  siempre poblada → incremental fiel.
- **Detección de `ts_col`**: elige la columna timestamp/date con MAX más reciente
  (la "fecha de actividad"). Ej. verificado: kdpord→c6, kdij→c10, kdm1→c18.
- **Idempotente**: re-correr no duplica (overlap-reload por sucursal).
- **Automatizar**: agendar en el Task Scheduler on-prem (junto a `run-prod-feeds.js`):
  incremental cada X horas, `--full` semanal.
- Es un **ODS crudo** (raw `kp.*`). La capa semántica (mart.ventas, etc.) y los
  importers KV pueden apuntar acá para leer **una** DB en vez de seis (paso futuro).
