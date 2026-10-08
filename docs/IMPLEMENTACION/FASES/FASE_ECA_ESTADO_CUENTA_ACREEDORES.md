# Fase ECA — Estado de cuenta de acreedores

> **Estado:** 🧪 ECA.0–ECA.2 en código, 2026-10-07. Pedido de Francisco (Finanzas).
> **Pantalla:** `/finanzas/estado-cuenta-acreedores` (menú Finanzas › Pagos, junto a «Cuadre y deuda»).
> **API:** `GET /finance/creditor-statements` y `GET /finance/creditor-statements/:codigo`.
> **Permiso:** `FINANCE_PAYMENTS_VER` (el mismo del resto de Pagos) → sin migración, sin re-login.

## Qué resuelve

El reporte «Estado de cuenta del proveedor» de Kepler, para **todos** los acreedores y separado
por **tipo**: Mercancía, Servicios y Financieros (deuda). Cada documento que sube la deuda
(«Aplica Orden Entrada», etc.) sale con los pagos y notas de crédito que Kepler le aplicó, y su saldo.

Sólo lectura: los pagos se siguen capturando y aplicando en Kepler. Vista derivada del ODS, sin
importer ni tabla nueva.

## Decode (medido en prod, 2026-10-07)

| Tabla | Qué es | Columnas |
|---|---|---|
| `kdxd` | Catálogo de proveedores (777 en el 00) | `c2` clave · `c3` nombre · `c4–c6` dirección · `c7` teléfono · `c10` RFC · `c12` agente · **`c13` grupo** · `c14` zona · `c15` límite de crédito · `c16` días de crédito · `c24` comentarios |
| `kdxe` | Documentos de cuentas por pagar | `c1` almacén · `c2` acreedor · **`c3` naturaleza** (`A` sube la deuda, `D` la baja) · `c4`/`c5` tipo y subtipo · `c6` folio · `c7` fecha · `c10` vence (1800 = sin fecha) · `c11` importe · `c16` referencia · `c18` concepto |
| `kdxf` | **Casamiento**: qué cargo se aplicó a qué abono | `c2` acreedor · `c3` fecha · `c4/c5/c6` el cargo (pago) · `c7/c8/c9` el abono (factura) · `c10` importe aplicado |
| `kdmm` | Nombre del tipo de documento | `c1='X'` · `c2` naturaleza · `c3` tipo · `c4` subtipo → `c5` (20 = Aplica Orden Entrada, 26 = Transferencia a proveedor, 55 = Nota crédito…) |

- **El casamiento es estructural:** de 30,073 aplicaciones, las 30,073 van de un `D` a un `A`.
  Contra el reporte de Kepler de Mondelez (CM009, 01/08–31/10/2026) cuadran 5 documentos y
  8 aplicaciones al centavo. Es una mejora sobre CXP.8, que casaba factura↔pago por **FIFO estimado**.
- **Réplica cruzada:** la sucursal 03 trae 734 documentos de la 02 → `btrim(c1) = sucursal`.
- **El reporte de Kepler muestra «Clasificaciones» = zona (`c14`) + agente (`c12`)**, no el grupo.
- **Nombres de grupo deducidos.** El catálogo de nombres no llega al ODS; `c13` trae exactamente
  11 códigos, los mismos 11 del combo «Grupo» de Kepler y en el mismo orden, y cada uno cuadra con
  quién lo tiene (001 AMDIVED = Mondelez/Hershey/Effem · 002 Plásticos = Bolsas de los Altos ·
  100 Cómputo = Cyberpuerta · 120 Instituciones financieras = los bancos · 130 Servicios
  especializados = AT&T, contadores · 140 Financiamiento vehicular = STM). Viven en
  `GRUPOS_KEPLER` del motor; un código nuevo se muestra como «Grupo NNN».

## Regla de tipo (decisiones de Francisco, 2026-10-07)

La clave de Kepler ya separa casi todo; el Grupo sólo capturado en 43 de 777 proveedores.

1. `TI*` → **interno** (sucursales dadas de alta como proveedor). No se lista: no es deuda.
2. Grupo 140, o clave `A*` (préstamos), `B.B.*` (factoraje), `TC*` (tarjetas) → **Financieros**.
3. `C*` → **Mercancía**.
4. `G*` → **Servicios**, **incluidos los bancos `GB*`**: lo que se les debe son comisiones
   («IVA SER BANCA», $48), no créditos. *(Decisión 1.)*
5. Lo demás → **Sin clasificar**, visible, no adivinado.

Prueba negativa: si el grupo 120 entra a Financieros, la prueba de los bancos se pone roja (verificado).

## Hallazgos que se declaran en pantalla

- **Kepler dice $138.8M pendientes de mercancía y ContPAQi (2120, sep-2026) $79.4M.** De esos,
  **$59.9M son facturas en el Kepler de una sucursal con fecha anterior al 1-oct-2026**: hasta esa
  fecha el 00 concentraba y muchas se pagaron desde el 00 sin aplicarse en la sucursal (p. ej. la 01
  tiene $28M de jun–ago). La pantalla las suma aparte y lo avisa; **no son deuda segura**.
- **Los créditos bancarios no están en Kepler** (Banorte crédito simple, BBVA crédito, Financiera
  Bajío, línea Bajío: ~$26M sólo en la 2140 de ContPAQi). *(Decisión 2: se darán de alta en Kepler.)*
  Para que caigan en Financieros: clave `A*` o grupo 140. Hasta entonces Financieros muestra sólo
  factoraje, STM, tarjetas y préstamos de personas (12 acreedores, $4.4M).

## Medido (prod, 2026-10-07)

| | Acreedores | Pendiente | Vencido | Pagos sin aplicar | Saldo |
|---|---|---|---|---|---|
| Mercancía | 339 | $138.8M | $108.5M | $4.6M | $129.7M |
| Servicios | 313 | $6.1M | $5.1M | $1.7M | $4.0M |
| Financieros | 12 | $4.6M | $3.3M | $0.16M | $4.4M |
| Sin clasificar | 3 | $6k | $6k | 0 | $6k |
| Interno (no se lista) | 9 | $38.6M | | | |

Resumen de los 676 acreedores: **489 ms**. Estado de cuenta de Mondelez (261 documentos, 184
aplicaciones): **38 ms**.

## Items

- [x] **[ECA.0]** Decode `kdxd/kdxe/kdxf/kdmm` + regla de tipo + contraste contra ContPAQi. ✅ 2026-10-07
- [x] **[ECA.1]** API `libs/finance/creditor-statements` (motor puro + 11 pruebas, 2 negativas) + contrato. 🧪 2026-10-07
- [x] **[ECA.2]** Pantalla con selector de tipo, lista de acreedores y estado de cuenta casado. Validación visual pendiente. 🧪 2026-10-07
- [ ] **[ECA.3]** Imprimir / exportar el estado de cuenta (como el PDF de Kepler).
- [ ] **[ECA.4]** Lente ContPAQi por acreedor (2120 / 2140) junto al saldo de Kepler.
- [ ] **[ECA.5]** Replicar al ODS el catálogo de nombres de grupo (hoy deducidos en código).
- [ ] **[ECA.6]** Revisar con Finanzas las facturas de sucursal anteriores al 1-oct ($59.9M) y decidir si se aplican en Kepler.
