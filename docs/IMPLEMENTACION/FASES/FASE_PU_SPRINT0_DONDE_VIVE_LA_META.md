# Sprint 0 · ¿Dónde vive el presupuesto de verdad?

> **Carril:** Ingresos (`trade-marketing-06`). **Verifica:** el carril que arma el plan
> (`FASE_PU_PLAN_PRESUPUESTO.md` §5). **Fecha de la medición: 2026-10-10, contra `pg-prod`.**
>
> ⛔ **Sprint 0 bloquea a todos los demás.** La pregunta no es técnica: es si el módulo tiene que
> **leer** un presupuesto que ya existe o **reemplazar** el trámite que lo produce. Construir sin
> contestarla es cómo se llegó acá.

---

## 0 · La respuesta, en una línea

**No existe ningún presupuesto ni meta fijada por una persona en toda la base de producción.**

Cada candidato que podía contener uno lo escribió un proceso automático de este mismo proyecto. El
módulo **no le compite a una meta real: no hay ninguna que leer.**

⇒ Lo que decide el diseño de la fase **no está en la base**. Está en §4, y son preguntas para
personas.

---

## 1 · El barrido: todo lo que podía ser una meta

Se buscaron en el catálogo de prod **todas** las tablas base fuera de `budget.*` con alguna columna
que pudiera contener un objetivo (`target|meta_|_meta|presupuest|budget|objetivo|cuota`). Nueve
tablas. Éste es el veredicto de cada una.

| tabla | filas | ¿la escribió una persona? |
|---|---|---|
| `commercial.sales_targets` | **572** | ⛔ **No** — la escribió nuestro propio código |
| `analytics.kpi_thresholds` | **5** | ⛔ **No** — las registró otro carril, hoy |
| `commercial.margin_targets` | **1** | ⛔ **No** — persiste una constante que ya estaba en el código |
| `commercial.promo_agreements` | **0** | — tabla vacía |
| `analytics.contpaqi_ledger_monthly` | 58,051 | ⛔ **No lleva presupuesto**: sólo real |
| `commercial.purchase_orders` / `_requisitions` | — | `target_basis` es el método de reorden, no una meta |
| `finance.expense_proofs` | — | `capture_meta` es metadato de captura |
| `identity.users` | — | `meta_puntos` es gamificación |
| `intelligence.push_directives` | — | `target_id`/`target_kind` es el destinatario de un aviso |

---

## 2 · Las tres que sí parecían, una por una

### 2.1 ⛔ `commercial.sales_targets` — **la escribió `projectToSalesTargets`**

```
572 filas · created_by NULL en las 572 · creadas 2026-10-07 y 2026-10-08
scopes: route 286 · branch 176 · channel 88 · total 22
meses:  2026-01 → 2027-10   (= exactamente FY2026 + FY2027)
```

Cuatro evidencias que convergen y ninguna depende de las otras:

1. El `INSERT` de [`budget-sales-plan.service.ts:732`](../../../libs/finance/src/lib/budget/budget-sales-plan.service.ts)
   escribe `(tenant_id, scope, scope_key, year_month, target_monto)` — **no escribe `created_by`**,
   y por eso está en NULL en las 572.
2. Las fechas de creación son **los dos días en que corrió el autopiloto**.
3. La estructura de cuatro `scope` es exactamente la que emite `projectToSalesTargets`.
4. El rango de 22 meses cubre justo los dos ejercicios que el autopiloto generó.

⚠️ Hay un **segundo escritor** (`commercial-analytics.service.ts:6321`) con el mismo patrón sin
`created_by`; no explica estas filas, pero conviene saber que existe.

⭐ **La cadena es circular, y eso es lo grave:**

```
histórico de Kepler → autopiloto → budget.sales_plan_lines → projectToSalesTargets
   → commercial.sales_targets → las pantallas comerciales comparan la venta contra eso
     COMO SI alguien lo hubiera fijado
```

### 2.2 ⛔ `analytics.kpi_thresholds` — **otro carril, y de otro dominio**

Las 5 filas se crearon el **2026-10-10** y su `source` las nombra: *«CPA.0 — banda medida contra
pg-prod… ver `FASE_CPA_AUTOMATIZACION_CONTABLE.md` §10»*. Las cinco `kpi_key` son
`cierre_contable.{bancos,compras,gastos,nomina,ventas}`.

⇒ Son umbrales de **cobertura del cierre contable**, puestos por la fase de automatización
contable. **Ninguna aplica a presupuesto**, y ninguna la fijó una persona.

⚠️ Esto **corrige** la lectura de que «alguien las registró hoy»: fue un carril, no un humano — y el
registro de umbrales sigue sin una sola meta directiva.

### 2.3 ⛔ `commercial.margin_targets` — **persiste un número que ya estaba clavado**

Una fila, `margen_objetivo = 11.552`, `updated_by` NULL, del 2026-09-29. Su propia `evidencia` lo
dice: *«Es el 15 % que ya estaba clavado en `commercial-actions.service.ts:9`,
`commercial-profitability.service.ts:190` y `comercial-rentabilidad.component.ts:1014`. Se persiste
SIN cambiarlo para que esta migración sea cero-diff de comportamiento.»*

Y su `minimo_motivo` empieza con **`NO DETERMINABLE`**. No es una meta: es una constante mudándose
de archivo a tabla, con su indeterminación declarada.

### 2.4 ⛔ ContPAQi **no lleva presupuesto**

`analytics.contpaqi_ledger_monthly` (58,051 filas, 2,337 cuentas, 2017→2026) tiene
`saldo_ini · cargos · abonos · neto` — **ninguna columna de presupuestado**. Y en 2,337 cuentas no
hay una sola de presupuesto o pronóstico: la única coincidencia del barrido fue **`TECNOMETAL`**,
que matchea `%meta%` por el nombre del proveedor.

⇒ El SoR contable guarda **lo que pasó**, no lo que se planeó.

---

## 3 · Lo único que tocó una cuenta humana

```
budget.budgets   2 filas  created_by = superoot
                 1 fila   created_by = autopilot
todo lo demas    2,112 filas  autopilot
```

⚠️ **Y ni siquiera eso es concluyente.** `superoot` es la cuenta de superadministración, y desde la
base **no se puede distinguir una persona de una sesión** que la usó. Lo que sí se puede afirmar es
el alcance: dos **cabeceras** de ejercicio. Ningún renglón, ningún supuesto, ninguna firma.

Y las tres ausencias que lo cierran:

| | |
|---|---|
| `budget.expense_plan_settings` | **0 filas** — nadie firmó un supuesto de gasto |
| `budgets.authorized_by` | **0 de 3** |
| `budgets.authorized_at` | **0 de 3** |

---

## 4 · ⛔ Lo que esto deja en manos de personas

Las mediciones de arriba agotan lo que la base puede decir. Lo que sigue **no sale de ninguna
consulta**, y de la respuesta depende si el módulo lee o reemplaza:

1. **¿Quién arma el presupuesto hoy, con qué herramienta y en qué mes?**
   Si es un Excel, el módulo tiene que leer **ese** Excel o reemplazar **ese** trámite.
2. **¿Quién lo aprueba?** Hoy `PRESUPUESTOS_GESTIONAR` prepara **y** aprueba, y lo tienen las mismas
   dos personas. Mientras siga así, cualquier bandeja de firmas le muestra a Dirección su propio
   trabajo.
3. **¿Contra qué se compara al cierre?** Sin eso, no hay forma de decir si un ejercicio se cumplió.

⇒ Mientras no haya respuesta, **todo lo que se construya encima se apoya en un plan que nadie
revisó** — y que, medido aparte, proyecta **$0.00 en Halloween, Navidad y Reyes** (99 filas en cero;
esos tres períodos valieron **$219,175,062.18 = 27.2 %** del ejercicio anterior).

---

## 5 · Cómo reproducir estas cifras

Todas salen de consultas de **sólo lectura** contra `pg-prod` del 2026-10-10:

- el barrido: `information_schema.columns` filtrando `target|meta_|_meta|presupuest|budget|objetivo|cuota`
  sobre `table_type='BASE TABLE'`, excluyendo `budget.*`;
- el autor de cada tabla: `count(*) FILTER` sobre `created_by` / `updated_by`;
- ContPAQi: `cuenta_nombre ILIKE` sobre las 2,337 cuentas, y la lista de columnas de la tabla.

⚠️ **Ninguna de estas cifras la verificó todavía otro carril.** Según §5 del plan, la verificación
le toca al carril que lo armó, con una implementación distinta. Hasta entonces este documento es
**medición propia sin cruzar**, que es exactamente el estado que el plan no acepta para aprobar.
