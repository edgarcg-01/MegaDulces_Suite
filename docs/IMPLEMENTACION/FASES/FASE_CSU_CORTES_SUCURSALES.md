# Fase CSU — Cortes/Sucursales (corte de caja → cobro → ingreso a la empresa)

> Pedido por Francisco el 2026-10-05: *"monitorear los cortes y cobros; que el dinero que se
> cobró por corte llegue como ingreso a la empresa y amarrar la conciliación bancaria, más el
> corte, más el cobro en sistema"*. Pantalla `/finanzas/cortes-sucursales`, sección nueva
> **Ingresos** del menú de Finanzas.

## 1. Qué sigue el módulo

```
 1. CORTE (Kepler U-D-23)      2. COBRO (Kepler U-A-5)        3. INGRESO REAL (entrega 2)
 Corte de Caja POS       ──►   Cobro PUE aplicado al    ──►   abono en el estado de cuenta /
 cargo al cliente CONTADO      corte (kdm5)                   efectivo por Caja Fuerte → depósito
 "se vendió y se contó"        "se registró que entró"        "llegó a la empresa"
```

Sólo lectura sobre Kepler: el cobro se sigue capturando en el ERP. Derivado del ODS, sin
importer ni tabla nueva (regla principal del proyecto).

## 2. Decode — medido en prod el 2026-10-05 (no supuesto)

| Qué | Dónde | Verificado contra |
|---|---|---|
| Corte | `kepler_ods.kdue` `c29='C'`, `c4=23`, `c5=1`, `btrim(c2)='CONTADO'`. `c6` folio, `c7` fecha, `c11` importe, `c16` = `Caja <caja>-<folio de arqueo>` | Pantalla "Alta de cobro" de Kepler, Zamora Centro: los 10 documentos y sus saldos al centavo |
| Cobro aplicado | `kepler_ods.kdm5` con `c8='D'`, `c9=23`, `c10=1`, `c11`=folio del corte; `c3/c4/c5/c6` = el cobro (`UA0501-…`), `c13` monto | Cobro `UA0501-0000003` ($1,907.62) de la pantalla "Consultar cobro"; saldo previo $11,010.30 reproducido |
| Forma de pago / concepto del cobro | `analytics.erp_collections` por `(sucursal, doc_prefix, folio)` | — |
| Arqueo del turno | `analytics.cash_cuts` por `(warehouse_code, caja, folio)` | 108 de 110 cortes de oct-2026 encuentran su arqueo |

**Hallazgos que definieron la lógica:**

1. **El monto del corte es lo que CONTÓ el cajero**, no lo que vendió (efectivo + tarjeta +
   transferencia del arqueo): 91 de 121 pares iguales al centavo contra lo contado y 73 contra lo
   esperado. Por eso la caja 5-151 de Zamora Centro (02-oct) tiene corte de $1,203.36 contra
   $10,203.36 vendidos: el POS esperaba $10,067.30 de efectivo y se contaron $1,067.30. **Faltan
   $9,000.00 en el arqueo**, y el corte los arrastra.
2. **El cuadre se hace por TURNO, no por día.** Contra los tickets del día salían diferencias falsas
   de +$85,262 (Hidalgo caja 1) y −$91,413 (Abastos caja 5) porque el turno cruza la medianoche.
3. **El folio de arqueo se repite entre fechas** (Hidalgo caja 1 folio 93: 22-sep, 28-sep y
   2-oct). Se casa con la fecha más cercana dentro de ±3 días, nunca con cualquiera.
4. **El corte U-D-23 arrancó con el cambio del 1-oct-2026**: en septiembre sólo hay 5 (Hidalgo).
   La pantalla lo avisa si el periodo es anterior.
5. **Se aplican cobros al corte equivocado**: en Zamora, $1,907.62 y $421.63 son tarjeta y
   transferencia del turno 5-149 y se aplicaron al corte de la caja 4-199.

**Foto 1–5 oct 2026 (8 sucursales):** 105 cortes por **$4,531,431.68**, cobrado en Kepler
**$66,210.22 (1.5%)**, pendiente **$4,465,221.46**; 25 cortes con diferencia contra su arqueo,
1 sin arqueo, 5 cortes en blanco (< $1) declarados aparte.

## 3. Reglas del motor (`cortes-sucursales.engine.ts`)

- **Estado de cobro**: `sin_cobro` · `parcial` · `cobrado` · `sobrecobrado` (saldo = monto − Σ cobros).
- **Cuadre contra el arqueo del turno** (tolerancia $1): `cuadra` (= esperado) · `faltante_arqueo`
  / `sobrante_arqueo` (corte = contado y contado ≠ esperado) · `corte_distinto` · `sin_arqueo`.
  ⛔ Sin arqueo **nunca** es "cuadra" (prueba negativa en el spec).
- Cortes de menos de $1 (cierre de caja sin venta) no se listan; se **declaran** en el conteo.

## 4. Filtro de fechas

Mes (por defecto el **mes en curso**, hora de México) o **rango específico** (`from`+`to`), que
manda sobre el mes. Costo medido: un mes completo, 110 cortes, **~430 ms**.

## 5. Items

- [x] **[CSU.0]** Decode y medición en prod (este documento §2). ✅ 2026-10-05
- [x] **[CSU.1]** Backend `GET /finance/cortes-sucursales` (`libs/finance/src/lib/cortes-sucursales/`),
  contrato `cortes-sucursales.contract.ts`, permiso `FINANCE_CORTES_VER` + migración
  `20261005190000` que lo reparte calcando `FINANCE_INCOME_VER` (11 roles). Motor puro con 9
  pruebas, incluida la negativa. 🧪 2026-10-05
- [x] **[CSU.2]** Pantalla `/finanzas/cortes-sucursales`: resumen, tabla por sucursal, cortes de la
  sucursal y detalle (arqueo esperado/contado por forma de pago + cobros aplicados). Sección nueva
  **Ingresos** en el menú (Cortes/Sucursales · Ingresos contables · Crédito). 🧪 2026-10-05
- [ ] **[CSU.3]** Entrega 2 — banco: cruzar los cobros con `finance.bank_movements` (tarjeta y
  transferencia), tolerando que un abono cubra varios cobros y que el cobro no trae la fecha real.
  Requiere el estado de cuenta de oct-2026 cargado en Bancos.
- [ ] **[CSU.4]** Entrega 2 — efectivo: tramo Caja Fuerte (`/finanzas/caos`) → Caja General →
  depósito, por corte.
- [ ] **[CSU.5]** "Cobro sin corte": cobros de CONTADO aplicados a otros documentos (La Piedad
  cobró $38,363.81 y sólo $113.45 quedó en cortes). Pendiente decidir si se muestra.

## 6. Pendiente para prod

1. Aplicar la migración `20261005190000_grant_finance_cortes_ver.js` (una por una, como el resto).
2. Redeploy api + view (automático al entrar a `main`).
3. Re-login de los usuarios para que el permiso llegue al token.
4. **Validación visual pendiente**: no se levantó la app en local (regla del 2026-10-02); la
   consulta y el motor sí se ejecutaron contra prod en solo lectura.
