# Caja General: liberación del plan por capas (`[CGP]`)

**Para:** quien suelta a producción (Edgar).
**Rama:** `cgp/fase-1-ci`. **Plan:** [`FASE_CG_PLAN_POR_CAPAS`](../FASES/FASE_CG_PLAN_POR_CAPAS.md) §7–§8.

## Antes de soltar

1. **Fusionar `origin/main` y volver a probar.** Al 2026-10-15 la rama va 38 commits adelante y 1
   atrás. Un CI verde sobre una rama atrasada describe un `main` que ya no existe.
2. **CI verde**, incluido el job `caja-db`. Sus pasos:
   - suites del corte;
   - servicio real del corte;
   - «Fechas de caja en tres zonas».
   «Build & typecheck» es el que tipa las plantillas: los specs no lo hacen.
3. **Migraciones: la rama no trae ninguna nueva.** La de invariantes (`20261014212702`, `[CGP-D.3]`)
   entró a `main` con el #413. El código la nombra: traduce sus restricciones a frases (`caja-errores`).
   Verificar que esté aplicada:

   ```sh
   ssh superoot@192.168.0.222 'ops/prod/soltar.sh --ver'
   ```

   Si aparece pendiente, se aplica **antes** del código, una por una (`apply-one-migration-prod.js`
   dentro de `prod-api`; nunca `migrate:latest`). Ver
   [`RUNBOOK-despliegue`](../../../ops/prod/RUNBOOK-despliegue.md).

## Soltar

El sello `ci-green` y `auto-deploy` hacen el resto (compuertas: arranque, migraciones, commit servido,
humo del login).

## Humo después de soltar

- `GET /api/health` responde.
- La pantalla abre y el bloque **Cierre de la jornada** muestra los pasos del corte.
- `GET /api/finance/cash-ledger/saldo/00` responde. Con un corte contado, `conteo_sellado` trae
  `desglose` y `morralla` (`[CGP-V.2]`).
- `GET /api/finance/cash-ledger/cortes/jornadas-pendientes?sucursal=00` responde con `hoy` y la lista.

## Qué cambia para quien usa la pantalla

Avisar a cajeras y supervisores (la guía: [`CAJA_GENERAL_OPERACION`](CAJA_GENERAL_OPERACION.md)):

- **Las capturas con cambio devuelto ya se aceptan** (`[CGP-L.8]`). Antes el servidor sumaba el
  cambio en vez de restarlo y las rechazaba por «no cuadra». El comprobante imprime el cambio aparte.
- La caja se cierra **paso a paso**, y el conteo, una vez guardado, queda de **sólo lectura**. Para
  corregirlo hay que recontar, una vez y con motivo (`[CGP-V.1]`/`[CGP-V.2]`).
- Las jornadas atrasadas se cierran **en orden**, desde el mismo botón (`[CGP-V.3]`).
- Se puede **contar cero**, declarándolo (`[CGP-V.9]`).
- Quien sólo tiene VER ya **no ve** los botones de captura ni de cierre, y la pantalla dice qué
  permiso falta (`[CGP-V.6]`).

## Volver atrás

```sh
ssh superoot@192.168.0.222 'ops/prod/soltar.sh --volver <SHA anterior>'
```

Como la rama no trae migraciones, volver al código anterior no deja la base adelantada.

## Métricas de la primera semana (`[CGP-E.6]`)

Sólo lectura, como `dev_ro`. El módulo está listo cuando hay **cinco días hábiles seguidos** con el
corte cerrado y autorizado el mismo día (plan §10).

```sql
-- 1 · Cortes de los últimos 14 días: ¿cerrado y autorizado el MISMO día?
SELECT c.fecha::text AS jornada, c.folio, c.estado,
       (c.closed_at AT TIME ZONE 'America/Mexico_City')::date = c.fecha     AS cerrado_el_mismo_dia,
       (c.authorized_at AT TIME ZONE 'America/Mexico_City')::date = c.fecha AS autorizado_el_mismo_dia
  FROM finance.cash_ledger_cuts c
 WHERE c.sucursal = '00' AND c.fecha >= (now() AT TIME ZONE 'America/Mexico_City')::date - 14
 ORDER BY c.fecha;

-- 2 · Horas en borrador (el sensor avisa a las 26 h; crítico a las 50 h).
SELECT folio, fecha::text AS jornada, round(extract(epoch FROM now() - created_at) / 3600) AS horas
  FROM finance.cash_ledger_cuts WHERE estado = 'borrador' ORDER BY created_at;

-- 3 · Movimientos vivos de 30 días anclados a su documento de Kepler (origen_ref).
SELECT tipo, count(*) AS movimientos,
       count(*) FILTER (WHERE origen_ref IS NOT NULL) AS anclados,
       round(100.0 * count(*) FILTER (WHERE origen_ref IS NOT NULL) / nullif(count(*), 0), 1) AS pct
  FROM finance.cash_ledger
 WHERE deleted_at IS NULL AND cancelled_at IS NULL
   AND fecha >= (now() AT TIME ZONE 'America/Mexico_City')::date - 30
 GROUP BY tipo ORDER BY tipo;
```

**4 · Depósitos de ruta capturados** (al 2026-10-14: 18 de 749). Se mide con el método de
[`FASE_CG`](../FASES/FASE_CG_CAJA_GENERAL.md) (`atribuirDeposito()` sobre los `ref` reales de CAOS),
que no se repite acá. Que **nadie captura esos depósitos** es una decisión pendiente (plan §9.4), no un
defecto del código.

Las tres consultas se probaron contra la base local de prueba (corren; ahí no hay datos de negocio).
