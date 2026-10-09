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
manda sobre el mes. Costo medido: un mes completo (106 cortes), **630–750 ms en caliente**; el plan usa índice en `kdue`, `kdm5` y `cash_cuts`, y casi todo el tiempo es la vista `analytics.erp_collections` (forma de pago del cobro).

## 5. Items

- [x] **[CSU.0]** Decode y medición en prod (este documento §2). ✅ 2026-10-05
- [x] **[CSU.1]** Backend `GET /finance/cortes-sucursales` (`libs/finance/src/lib/cortes-sucursales/`),
  contrato `cortes-sucursales.contract.ts`, permiso `FINANCE_CORTES_VER` + migración
  `20261005200000` que lo reparte calcando `FINANCE_INCOME_VER` (11 roles). Motor puro con 10
  pruebas, incluida la negativa. 🧪 2026-10-05
- [x] **[CSU.2]** Pantalla `/finanzas/cortes-sucursales`: resumen, tabla por sucursal, cortes de la
  sucursal y detalle (arqueo esperado/contado por forma de pago + cobros aplicados). Sección nueva
  **Ingresos** en el menú (Cortes/Sucursales · Ingresos contables · Crédito). 🧪 2026-10-05
- [x] **[CSU.6]** **Quién ve qué** (decisión de Francisco, 2026-10-05): Finanzas, todas las
  sucursales; encargados y auxiliares de tienda, **sólo la suya**. Lo decide `ScopeService`
  (ADR-050, el mismo del arqueo de tienda) con `role_scopes`/`user_scopes`, no un `if` por rol
  ni un `_VER_ALL`. La migración nueva `20261005210000` suma `encargado_tienda` y `auxiliar_tienda`
  al permiso (va aparte: `20261005200000` ya está en `main` y no se modifica). La
  respuesta trae `alcance` y la pantalla lo dice ("Viendo sólo tu sucursal: 05 Zamora Centro") o
  avisa si la ficha no tiene sucursal. **Medido en prod con el servicio real** (148 usuarios
  activos, 44 con acceso): 31 de 32 de Finanzas → todas; `jlh_lopez` (vendedor de ruta con
  superadmin como complemento) → sólo 04, porque el alcance toma el rol principal; 11 de 12 de
  tienda → su sucursal; `yadira_campero` → ninguna (sin `warehouse_code`; asignarla en
  Personas). Excepciones personales sobre INCOME/CORTES: 0. La API relee permisos cada 30 s; el
  menú necesita re-login. 🧪 2026-10-05
- [x] **[CSU.7]** **Devoluciones pagadas en caja** (pedido de Francisco al revisar Zamora `Caja 2-171`,
  "Corte distinto −$179.92"). El arqueo de Kepler (`kdpv_folio_caja`) espera la venta **bruta** del
  turno; el corte `U-D-23` ya **resta** las notas de crédito POS pagadas en esa caja. Son dos
  documentos: `U-A-21-1` "Nota Créd/Dev POS" (fiscal) y `U-A-25-1` "Nota Créd/Dev NoFis POS",
  ligados al turno por `kdm1.c81` (caja) + `kdm1.c80` (folio de turno), ±1 día porque el folio de
  turno se repite entre fechas. Ej.: esperado $12,908.53 − `UA2101-0000071` $179.92 = corte
  $12,728.61. **Medido en prod con el motor real, 1–8 oct-2026 (los 196 cortes con arqueo que lista la pantalla):** cuadraban 141; con el esperado
  neto cuadran **184** («con diferencia» baja de 55 a 12) — incluidos los "Faltante en arqueo" de Madero 4-28 (−$2,641.97) y Abastos
  3-12 (−$3,450.52), que eran devoluciones. `U-A-35-1` también trae caja pero no explica ningún
  corte: fuera. Un caso (Madero 2-23) tiene devolución y el corte salió por el bruto: se acepta
  como `cuadra` contra el bruto y la pantalla lo dice ("Kepler no la descontó en este corte");
  ⚠️ ese respaldo va antes del chequeo contra lo contado, así que en ese caso un faltante del
  arqueo no se ve (igual que antes del cambio). **Declarado, no resuelto:** hay devoluciones POS
  sin caja o sin turno en Kepler (38 desde el 24-sep; p. ej. una de Yurécuaro por $937.06) que no
  casan con ningún corte, y las devoluciones sólo se pintan cuando el corte tiene arqueo. Quedan 9 `corte_distinto`, casi todos con el corte **arriba** de
  lo esperado (Abastos, hasta +$18,141.81): otra causa, sin investigar. El detalle muestra cada
  devolución (cliente y motivo) y el "esperado neto". Motor 17 pruebas, mutación verificada (4
  rojas con el bruto). Sin migración ni permisos. ⚠️ La consulta del mes tarda **~6 s** contra prod
  **desde antes de este cambio** (la parte de devoluciones cuesta ~36 ms); el "630–750 ms" de
  CSU.1 quedó viejo — revisar aparte. 🧪 2026-10-08
- [ ] **[CSU.3]** Entrega 2 — banco: cruzar los cobros con `finance.bank_movements` (tarjeta y
  transferencia), tolerando que un abono cubra varios cobros y que el cobro no trae la fecha real.
  Requiere el estado de cuenta de oct-2026 cargado en Bancos.
- [ ] **[CSU.4]** Entrega 2 — efectivo: tramo Caja Fuerte (`/finanzas/caos`) → Caja General →
  depósito, por corte.
- [ ] **[CSU.5]** "Cobro sin corte": cobros de CONTADO aplicados a otros documentos (La Piedad
  cobró $38,363.81 y sólo $113.45 quedó en cortes). Pendiente decidir si se muestra.

## 6. Pendiente para prod

1. Aplicar las migraciones `20261005200000_grant_finance_cortes_ver.js` y
   `20261005210000_grant_finance_cortes_ver_tienda.js`, una por una y en ese orden.
2. Redeploy api + view (automático al entrar a `main`).
3. Re-login de los usuarios para que el permiso llegue al token.
4. **Validación visual pendiente**: no se levantó la app en local (regla del 2026-10-02); la
   consulta y el motor sí se ejecutaron contra prod en solo lectura.
