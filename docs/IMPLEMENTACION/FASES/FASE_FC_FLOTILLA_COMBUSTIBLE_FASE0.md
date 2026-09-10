# Fase FC — Control Inteligente de Flotilla y Combustible · **FASE 0 corregida**

> **Qué es este archivo.** El prompt de implementación que acompaña a la
> *Especificación Funcional y Técnica v1.0 (31-ago-2026)* trae una FASE 0
> verificada en el commit `6ad92f4`. El repo se movió desde entonces. Este
> documento **reemplaza esa sección 4**: cada ítem está contrastado contra el
> código y contra la data de `platform_test` el **2026-09-09**, y se agregan los
> hallazgos que la revisión profunda de Logística encontró y que son
> prerequisito directo de las fases 1–3.
>
> El resto del prompt (secciones 1–3 y 5 en adelante) sigue vigente.
> ⚠️ Las secciones 6–12 del prompt **no están en el repo todavía** — llegaron
> truncadas. La sección 12 es el gate explícito de las decisiones abiertas.

---

## 0. El hallazgo que reordena las prioridades

Censo de `logistics.*` en `platform_test` (copia de prod), 2026-09-09:

| Estado | Tablas |
|---|---|
| **Con pulso diario** | `vehicle_positions` (36,391) · `fleet_alerts` (802) · `vehicle_stops` (98) · `route_expenses` (782) · `route_odometer` (187) |
| **Semilla / demo** | `shipments` (9) · `delivery_guides` (3) · `guide_recipients` (3) · `shipment_expenses` (6) · `vehicles` (31) · `drivers` (27) — todo del 3-sep |
| **Vacías (13)** | `liquidations` · `payroll_adjustments` · `load_details` · `unload_details` · `vehicle_maintenance` · `vehicle_usage_logs` · `fuel_transactions` · `shipment_checklists` · `shipment_photos` · `carrier_fiscal_profile` · `cartaporte_documents` · `route_optimizations` · `home_delivery_warehouses` |

**Consecuencias para el plan:**

1. **La columna vertebral de la Fase J (embarque → guía → costo → nómina) tiene
   adopción cero.** No hay que preservar comportamiento en producción ahí; hay
   libertad de diseño que el prompt asumía inexistente. La advertencia de
   §5.2 (*"no toques la máquina de estados del embarque"*) sigue siendo buena
   práctica, pero no protege data real.
2. **`logistics.fuel_transactions` y `logistics.vehicle_usage_logs` están
   VACÍAS.** El prompt las trata como dos de las tres fuentes de litros a
   conciliar (§0.4). En los hechos hay **una sola fuente con captura real**:
   `logistics.route_expenses` con `expense_type` marcado `lleva_litros`.
3. **Lo que sí está vivo es el GPS.** El maestro de unidades y el odómetro
   telemétrico se pueden construir sobre data real desde el día uno.

---

## 1. Ítems de la FASE 0 original — veredicto

| Ítem | Veredicto | Detalle |
|---|---|---|
| **0.1** Cerrar permisos (BLOQUEANTE) | ✅ **Ya hecho** | Los 13 controllers declaran `@RequirePermissions` / `@RequireAnyPermission` en **todos** sus handlers. Cerrado por `AUTHZ.5.1` y `AUTHZ-HARD.1`. La premisa *"cualquier autenticado puede crear vehículos y calcular nómina"* ya no aplica. **No re-ejecutar.** |
| **0.2** Colisión de rutas en `logistics-config` | ❌ **Falso positivo** | `@Get(':id')` matchea **un** segmento; `config/routes/list` son **dos**. No colisionan. `listRoutes()` lo consumen 3 pantallas y funciona. |
| **0.3** Dos definiciones de margen | ✅ **Arreglado** | Era real y peor: `/reports/kpi` sumaba el flete de embarques **`cancelado`** y restaba comisiones (doble conteo contra nómina). Unificado a *flete realizado − costos del viaje*, comisiones como línea aparte. |
| **0.4** Fuentes de litros sin conciliar | ✅ **Arreglado (parcial)** | Ver §2 abajo — el reader ya lee las tres y **declara** lo no atribuible. La reconciliación de fondo sigue pendiente y es FASE 1. |
| **0.5** Radios de geocerca hardcodeados | ⬜ **Real, pendiente** | Y hay más de los listados: `OFFLINE_MIN=90`, `OFFLINE_MAX=1440`, `SPEED_KMH=90` (`fleet-alerts.service`), `DEAD_THRESHOLD_MIN=20`, `OFF_STORE_MIN=15`, `IDLE_GAP_CAP_MIN=15` (`fleet-productivity.service`), `STOP_RADIUS_M=40`, `GEOFENCE_M=90`, `OFFLINE_GAP_MIN=30` (`trip-builder.service`). |
| **0.6** Inyección en `fleetUtilization` | ✅ **Ya hecho** | Va con bindings `?` desde `AUTHZ-HARD.1`. **No re-ejecutar.** |

---

## 2. Ítems NUEVOS de FASE 0 (de la revisión profunda)

### FC.0.7 — El combustible real no se puede atribuir a ninguna unidad ⛔ BLOQUEANTE

Medido en `platform_test`:

```
route_expenses  782 filas · vehicle_id presente en   0  (0.0 %)
route_odometer  187 filas · vehicle_id presente en   0  (0.0 %)

COMBUSTIBLES 2026: 776 cargas · $839,850.02 · 34,443 L · 13 rutas
```

Todo se importa por `route_code`, nunca por unidad. **RN-001 del spec
(«no puede existir combustible sin `vehicle_id`») hoy se incumple en el 100 %
de la captura real.** Sin resolver esto, ni km/L ni costo/km ni Vehicle Health
Score tienen denominador.

Ruta: resolver `route_code → vehicle_id`. Ya existe el puente —
`logistics.trackers.route_number` — que el rastreo usa para ligar ruta y unidad.

### FC.0.8 — 21 lecturas de odómetro están invertidas ⛔ BLOQUEANTE

```
km_final > km_inicial   165 filas   +478,694 km
km_final < km_inicial    21 filas   −662,321 km   ← sepulta a las buenas
iguales                   1 fila           0 km
                       ─────────────────────────
TOTAL                                −183,627 km
```

Ejemplo: ruta `504` período 10 → inicial `219,957`, final `3,225`.

Cualquier KPI de km sobre esta tabla da negativo. El motor de plausibilidad de
§9 del spec es exactamente la defensa que falta — pero **primero hay que
decidir qué hacer con las 21 filas existentes**: no se puede adivinar cuál de
los dos números es el bueno. Propuesta: marcarlas y excluirlas del cálculo,
no corregirlas a ciegas.

### FC.0.9 — 7 cargas con precio por litro implausible

`min $20.68 · avg $24.51 · max $105.00` · 7 cargas sobre $30/L. Nadie las
detecta. Es el caso de uso directo del motor de plausibilidad.

### FC.0.10 — El smoke de rastreo nunca corrió en la regresión ✅ arreglado

`test-newdb-logistics-tracking.js` existía desde la Fase LT y **no estaba
registrado** en `run-all-tests.js`: exigía `MAGNI_USER`/`MAGNI_PASS` y hacía
login real contra el proveedor. Ahora es `skip-graceful` y trae un bloque
offline que valida el contrato en DB (8 asserts, sin escribir).

---

## 3. Bugs de código arreglados en esta pasada

Todos verificados con el banco de pruebas `tmp/logi-review/proof.js`
(transacción + `ROLLBACK`, **8/8**):

| # | Qué pasaba | Dónde |
|---|---|---|
| **F-1** | `fuelEfficiency()` leía **una** de tres fuentes de litros. Quien capturaba por el formulario "Registrar carga" (misma pestaña) veía `km/L = null`; quien usaba dos, el rendimiento al doble. Ahora suma las tres, publica `liters_by_source` y **declara** los 34,443 L sin unidad en vez de omitirlos. | `logistics-fleet.service.ts` |
| **F-2** | `total_cost` no se recalculaba al corregir `actual_km` por `PATCH /shipments/:id`. Probado: km 100→400 dejaba el costo en $2,000; ahora da $5,000. | `logistics-shipments.service.ts` |
| **F-3** | La pantalla de Nómina editaba `bonuses`/`deductions`, pero el backend los **deriva** de `payroll_adjustments` y los pisaba en cada recálculo. Dinero que desaparecía sin rastro. Ahora el API responde 400 explicando que se registre un ajuste, y la UI los muestra como derivados. | `logistics-payroll.service.ts` + `logistica-payroll.component.ts` |
| **F-4** | "Reconocer" una alerta viva la silenciaba 5 minutos: el scanner buscaba sólo `status='open'`, no encontraba la `ack` e **insertaba un duplicado** (el único parcial es `WHERE status='open'`, no lo frena). La `ack` quedaba colgada para siempre y `listActive` mostraba las dos. | `fleet-alerts.service.ts` |
| **F-5** | Una unidad se podía asignar a dos embarques abiertos, y el primero en cerrar la marcaba `disponible` mientras seguía en la calle. Agregada la reserva en `assertVehicleAvailable` (409) y `releaseVehicleIfIdle`. | `logistics-shipments.service.ts` |
| **F-6** | `shipment-profitability` aplicaba `LIMIT` **antes** de ordenar: el "top N por margen" era N filas cualesquiera. Probado: el embarque de $48,000 de margen no aparecía en el top 2. | `logistics-analytics.service.ts` |
| **0.3** | Ver tabla anterior. Probado: dejaba de contarse $80,000 de flete de un embarque cancelado. | `logistics-reports.service.ts` |

---

## 4. Lo que queda pendiente de FASE 0

- [ ] **FC.0.5** — parametrizar los 9 umbrales a `config_finance` categoría `geocerca`.
- [ ] **FC.0.7** — resolver `route_code → vehicle_id` ⛔ bloqueante de todo km/L.
- [ ] **FC.0.8** — decidir qué hacer con las 21 lecturas invertidas ⛔.
- [ ] **FC.0.9** — regla de plausibilidad de precio por litro.
- [ ] Pendientes menores de la revisión (no bloquean): comisión que depende de
      subir la guía a `entregada` a mano · Carta Porte declara siempre el almacén
      default como origen fiscal · `updatePeriod` de nómina sin validaciones ni
      control de traslape · `deleteAdjustment` borra físico · folios con año en TZ
      del servidor en vez de `mx-date.ts`.

---

## 5. Decisiones que necesito de Edgar

1. **Margen** — quedó como *flete realizado − costos del viaje*, con comisiones
   publicadas aparte (razón: se liquidan por `logistics.liquidations`; restarlas
   ahí las contaría dos veces). Si el negocio las quiere dentro, se cambia en un
   solo lugar.
2. **FC.0.8** — las 21 lecturas invertidas: ¿se marcan y excluyen, o hay una
   fuente para corregirlas?
3. **Secciones 6–12 del prompt** — faltan en el repo. La 12 es el gate.
