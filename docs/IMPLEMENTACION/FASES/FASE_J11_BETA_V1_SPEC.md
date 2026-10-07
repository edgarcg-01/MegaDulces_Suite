# Fase J.11 — Beta v1 Logística (gap analysis vs Fase J implementada)

> **Estado**: 📋 SPEC + GAP ANALYSIS — Fase J cubrió ~95% del Beta v1 sin que lo supiéramos al escribir la spec inicial. Solo quedan 2 gaps menores.
> **Origen**: mockup `_imported/logistica/beta_v1.html` (4611 LOC, localStorage, sin backend) entregado por el usuario el 2026-06-04.
> **Revisión**: 2026-06-04 — auditoría contra schema real reveló que ~95% del Beta v1 ya está implementado.

---

## 1. Auditoría: estado real vs Beta v1

| Concepto Beta v1 | Schema DB | Backend module | Frontend page | Estado |
|---|---|---|---|---|
| **Guías** (delivery notes) | `logistics.delivery_guides` (24 cols) | `logistics-guides` | `logistica-guides` | ✅ Implementado |
| **Destinatarios múltiples** | `logistics.guide_recipients` (20 cols, con GPS+photo+delivered_to) | ✅ | ✅ | ✅ Implementado |
| **Viáticos por persona** | `delivery_guides.per_diem_breakdown` JSONB + `per_diem_total` | ✅ | ✅ | ✅ Implementado |
| **Carga de salida** | `logistics.load_details` (driver + rate) | `logistics-shipments` | sub-form en `logistica-shipments` | ✅ Implementado |
| **Descarga/LAB** | `logistics.unload_details` (driver + amount + **type**) | ✅ | ✅ | ✅ Implementado |
| **Liquidaciones** | `logistics.liquidations` (per_diem + commissions + load_unload + bonuses + deductions + neto) | `logistics-payroll` | `logistica-payroll` | ✅ Implementado |
| **Períodos catorcenales** | `logistics.payroll_periods` (number/year/start/end/payment) | ✅ | ✅ | ✅ Implementado (27 períodos seedeados) |
| **Catálogo destinos** | `logistics.routes` (driver_commission + helper_commission) | `logistics-config` | `logistica-config` | ✅ Implementado (97 rutas seedeadas) |
| **Costo $/km por modelo** | `logistics.config_finance` (15 entries `costo_km_*`) | ✅ | ✅ | ✅ Implementado |
| **Factores por región** | `logistics.config_finance` (8 entries `factor_*`) | ✅ | ✅ | ✅ Implementado |
| **Tarifas maniobras** | `logistics.config_finance` (`tarifa_maniobra_carga/descarga`) | ✅ | ✅ | ✅ Implementado |
| **Tarifas viáticos** | `logistics.config_finance` (`viatico_*`) | ✅ | ✅ | ✅ **Seedeado 2026-06-04** (gap cerrado) |
| **Colaboradores** | `logistics.drivers` (full_name + roles[] + employee_type + nss + phone + emergency_contact) | `logistics-fleet` | `logistica-staff` | ⚠️ Falta CURP/RFC/blood_type/federal_license/hire_date/base_salary_biweekly/emergency_phone |
| **Anticipos/préstamos/multas/faltas/bonos auditables** | `liquidations.bonuses/deductions` (solo totales) | — | — | ⚠️ Sin `payroll_adjustments` por persona/concepto/fecha |
| **Vehículos / flotilla** | `logistics.vehicles` (plate + model + brand + year + capacity + fuel_efficiency) | ✅ | `logistica-fleet` | ✅ Implementado |
| **Costos por embarque** | `logistics.shipment_expenses` (fuel+tolls+lodging+parking+permits+repairs+helpers+handling+per_diem+other+ subtotal + fixed_cost_per_km) | `logistics-expenses` | `logistica-costs` | ✅ Implementado |

**Conclusión:** Fase J llegó MUY lejos. De 16 conceptos del Beta v1, **14 están implementados** (schema + backend + frontend). Quedan **2 gaps reales**:

1. **Columnas legales en `drivers`** (CURP/RFC/sangre/licencia/contrato/sueldo/emergencia tel)
2. **Tabla `payroll_adjustments`** para audit trail de bonos y deducciones

---

## 2. Gap #1: Columnas legales en `logistics.drivers`

### Estado actual

Columnas existentes en `drivers`:
- `full_name`, `roles[]`, `employee_type` (fijo|eventual), `status`, `nss`, `phone`, `emergency_contact`

### Faltantes (del Beta v1)

| Columna | Tipo | Comentario |
|---|---|---|
| `curp` | VARCHAR(18) | Mexico, formato XXXX######XXXXXX## |
| `rfc` | VARCHAR(13) | Persona física |
| `blood_type` | VARCHAR(5) | O+/O-/A+/A-/B+/B-/AB+/AB- |
| `federal_license` | VARCHAR(50) | Solo para `roles` que incluyan `chofer` |
| `hire_date` | DATE | Fecha de ingreso (para cálculo de antigüedad) |
| `base_salary_biweekly` | NUMERIC(12,2) | Solo si `employee_type='fijo'` |
| `emergency_phone` | VARCHAR(30) | El actual `emergency_contact` es solo nombre/parentesco |

### Migración propuesta

```js
// database/migrations-newdb/<timestamp>_drivers_legal_fields.js
exports.up = async (knex) => {
  await knex.schema.withSchema('logistics').alterTable('drivers', (t) => {
    t.string('curp', 18).nullable();
    t.string('rfc', 13).nullable();
    t.string('blood_type', 5).nullable();
    t.string('federal_license', 50).nullable();
    t.date('hire_date').nullable();
    t.decimal('base_salary_biweekly', 12, 2).nullable();
    t.string('emergency_phone', 30).nullable();
  });
  await knex.raw(`
    ALTER TABLE logistics.drivers
    ADD CONSTRAINT drivers_blood_type_check
    CHECK (blood_type IS NULL OR blood_type IN ('O+','O-','A+','A-','B+','B-','AB+','AB-'))
  `);
};
```

**Backend impact:** `LogisticsFleetService` DTO + service necesitan los nuevos campos en createDriver / updateDriver.
**Frontend impact:** `logistica-staff.component.ts` form expandir con los nuevos campos.

**Estimado:** ~1.5h (migración + DTO + service + form + smoke test).

---

## 3. Gap #2: Tabla `logistics.payroll_adjustments`

### Estado actual

`logistics.liquidations` tiene:
- `bonuses` NUMERIC — total bonos del período
- `deductions` NUMERIC — total deducciones del período

Pero **NO se puede saber** qué bonos/deducciones individuales conforman cada total — sin audit trail.

### Diseño propuesto

```js
// database/migrations-newdb/<timestamp>_create_payroll_adjustments.js
exports.up = async (knex) => {
  await knex.schema.withSchema('logistics').createTable('payroll_adjustments', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable();
    t.uuid('driver_id').notNullable();
    t.uuid('period_id').notNullable();
    t.string('type', 20).notNullable(); // anticipo|prestamo|multa|falta|bono
    t.decimal('amount', 12, 2).notNullable();
    t.date('date').notNullable();
    t.text('notes');
    t.timestamps(true, true);
    t.uuid('created_by');
    t.uuid('updated_by');
    t.foreign(['tenant_id', 'driver_id']).references(['tenant_id', 'id']).inTable('logistics.drivers');
    t.foreign(['tenant_id', 'period_id']).references(['tenant_id', 'id']).inTable('logistics.payroll_periods');
    t.index(['tenant_id', 'driver_id', 'period_id']);
  });
  await knex.raw(`
    ALTER TABLE logistics.payroll_adjustments
    ADD CONSTRAINT payroll_adjustments_type_check
    CHECK (type IN ('anticipo','prestamo','multa','falta','bono')),
    ADD CONSTRAINT payroll_adjustments_amount_positive
    CHECK (amount > 0)
  `);
  await knex.raw(`
    ALTER TABLE logistics.payroll_adjustments ENABLE ROW LEVEL SECURITY;
    ALTER TABLE logistics.payroll_adjustments FORCE ROW LEVEL SECURITY;
    CREATE POLICY payroll_adjustments_tenant_isolation ON logistics.payroll_adjustments
      USING (tenant_id = current_tenant_id())
      WITH CHECK (tenant_id = current_tenant_id());
    GRANT SELECT, INSERT, UPDATE, DELETE ON logistics.payroll_adjustments TO app_runtime;
  `);
};
```

**Lógica de cálculo** (cambio en `LogisticsPayrollService`): cuando se genera/recalcula una liquidación, sumar adjustments del período por tipo (bonos vs no-bonos) y reflejar en `liquidations.bonuses/deductions`. Endpoint nuevo `PATCH /api/logistics/payroll/liquidations/:id/recalculate` para forzar refresh.

**Endpoints nuevos en `LogisticsPayrollController`:**
- `POST /api/logistics/payroll/adjustments` — crear (validar period no esté `status='paid'`)
- `GET /api/logistics/payroll/adjustments?driver_id=&period_id=` — listar
- `DELETE /api/logistics/payroll/adjustments/:id` — hard delete (no soft, audit es por created_at)
- `GET /api/logistics/payroll/periods/:period_id/drivers/:driver_id/breakdown` — devuelve liquidation con array de adjustments anidado

**Frontend impact:** `logistica-payroll.component.ts` agregar form modal "Registrar anticipo/multa/bono" + tabla de adjustments en el detail modal.

**Estimado:** ~3h (migración + backend service/controller + DTOs + frontend form modal + smoke test).

---

## 4. Plan de cierre Beta v1 — CERRADO 2026-06-05

| Sprint | Scope | Estado |
|---|---|---|
| ✅ J.11.0 | Seed viáticos en `config_finance` (4 entries) + actualizado importer | DONE 2026-06-04 |
| ✅ J.11.1 | ALTER `drivers` + columnas legales (curp/rfc/blood_type/federal_license/hire_date/base_salary_biweekly/emergency_phone) + DTO/service + frontend form | DONE 2026-06-05 |
| ✅ J.11.2 | `logistics.payroll_adjustments` (audit trail anticipo/préstamo/multa/falta/bono) + endpoints + form modal en payroll | DONE 2026-06-05 |

**Fase J.11 = 🟢 CERRADA (beta scope) 2026-06-05**. Beta v1 implementado al 100%.

---

## 5. Conclusiones

1. **Fase J fue mucho más ambiciosa de lo que la memoria reflejaba.** 10 backend modules + 13 frontend pages + 17 tablas + seed completo de 96 destinos / 14 modelos / 7 factores / 27 períodos cargados.
2. **El Beta v1 HTML mockup es el espejo de Fase J ya implementada** — confirmado al hacer la auditoría columna por columna.
3. Solo 2 gaps reales quedan, ambos opcionales para una beta funcional inicial:
   - Columnas legales de empleado (importante si se hace nómina IMSS real)
   - Audit trail de adjustments (importante si los gerentes quieren ver detalle de bonos/multas en la liquidación)
4. **Recomendación**: validar el flow end-to-end del Beta v1 contra Fase J actual (crear embarque + guía + costos + liquidación) ANTES de invertir en los 2 gaps. Puede que ya funcione todo y los gaps sean cosméticos.

---

## 6. Referencias

- HTML mockup: `_imported/logistica/beta_v1.html` (gitignored)
- Schema: `logistics.*` (17 tablas)
- Backend modules: `libs/logistics/src/lib/logistics-{guides,payroll,fleet,shipments,expenses,config,checklists,photos,reports,analytics}/`
- Frontend pages: `apps/view/src/app/modules/logistica/pages/`
- Importer de seed (con viáticos agregados 2026-06-04): `database/importers/logistics_baseline.js`
- Fase J actual: [`FASE_J_LOGISTICA.md`](FASE_J_LOGISTICA.md), [`FASE_J9_UI_REPO_PORT.md`](FASE_J9_UI_REPO_PORT.md)
