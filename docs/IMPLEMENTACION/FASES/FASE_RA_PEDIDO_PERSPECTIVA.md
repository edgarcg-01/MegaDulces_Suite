# Fase RA-PRO.64+ — `/compras/pedido` con perspectiva del comprador

> **Origen:** simulación comprador vs. vendedor de GONAC (2026-10-01) sobre el SKU **83185 CHECHI
> MEGA AHUMADO /24**, con datos de producción en solo lectura. El comprador cuida presupuesto y días
> de inventario; el vendedor empuja volumen ("Zamora no tiene inventario", "llévate múltiplos de 11
> por el 10+1"). La pantalla resolvió bien el pedido base y se quedó corta en los dos argumentos del
> vendedor. Este plan cierra esos huecos **por etapas**: primero lo que no necesita migración.
>
> Decisiones de Francisco sobre el feedback (2026-10-01): 1 ✅ · 2 ✅ · 3 → V30d/Máx + globo de 12
> meses · 4 → distintivo de sell-in/sell-out · 5 ✅ · 6 ✅ · 7 → unidades como en Cotización ·
> 8 → esperar el mínimo/reorden/máximo dinámico de PM e integrarlo.

## Lo que la simulación midió (2026-10-01)

| Hecho | Valor | Consecuencia en pantalla |
|---|---|---|
| Zamora Centro (05) con el 83185 | 0 existencia, 0 venta en 12 meses, **sin política de reorden** | El workbook la excluía (`stock_pz > 0 OR daily_pieces > 0 OR transit_cajas > 0`): no había dónde capturarla |
| Kepler en la 05 | El artículo **sí** está dado de alta (familia CC013) | El "árbol" no era el problema; era el filtro del workbook |
| Política de reorden | `computed` en 8 almacenes (al 1-oct), **ninguna en 05**; Kepler `c33–c35` en 0 en todas | "sin mínimo" es una ausencia real, no un cero |
| Venta 30d Padre Hidalgo | 49.9 cj (motor 48.6) · prorrateo 60/40 = 53.8 cj | El globo cuadra con el motor |
| Junio 2026 en Padre Hidalgo | 8.5 cj vs ~40 normales · **480 paq de venta perdida** | El globo muestra un desabasto que la Venta 30d no muestra |
| "Mínimo" de GONAC | 908 cajas / $214,113 — ⚠️ es el pedido **típico** derivado del historial, no un mínimo (corregido en Etapa 2) | Ya viajaba en `/filters` y no se mostraba |
| En camino | 1 OC abierta (folio 0006790, 70 cj, 23 días) | El motor ya la pondera por P(llega). ⚠️ La tabla `analytics.purchase_in_transit` (27-ago) está **retirada** desde el 28-ago — no leerla |
| Margen | 18.7% sobre venta (costo estándar Kepler); `sales_daily` da 11.1% constante (álgebra de markup) | Etapa 2 |

## Etapas

### Etapa 1 — sin migraciones (🧪 EN CÓDIGO 2026-10-01)

| Item | Qué | Dónde |
|---|---|---|
| **[RA-PRO.64]** | **+ Agregar sucursal** en el desglose (almacenes del filtro, sin rutas, que el workbook no mandó) y **leyendas** por renglón: *sin existencia · sin venta · sin mínimo · agregada*. El renglón agregado arranca en 0, se captura y entra a la requisición/PDF/XLSX como cualquier otro; *quitar* borra también lo capturado. | front: `compras-pedido-real.component.ts` · back: `filters()` manda `w.kind` |
| **[RA-PRO.65]** | Columna **V30d / Máx** (venta 30 d ÷ máximo de ESE almacén, en cajas). Clic → **globo** con 13 meses (barra = venta en $, número = cajas) contra el mismo mes del año anterior, los últimos 30 d, los próximos 30 d del año anterior y el **prorrateo 60/40 del sistema anterior** como referencia. Botón "venta por mes" para la red. | back: `GET /commercial/replenishment/workbook/:productId/monthly?code=` (`monthlySales()`, ~40 ms) + celdas con `mx`/`rop` |
| **[RA-PRO.66]** | ~~Pedido mínimo del proveedor~~ → **corregido en RA-PRO.69**: el dato es el pedido TÍPICO derivado del historial, no un mínimo. | front (ya viajaba en `/filters`) |

Reglas que se respetaron: las cajas sólo se publican donde el peldaño está medido (`units × rung_factor`
sin mezcla); lo demás se marca `*`/`?` y la barra en $ queda completa (ADR-056/059). Las rutas se pliegan
a su sucursal madre con el mismo `rmap` del fact. El 60/40 **no** alimenta el pedido.

### Etapa 2 — sin migraciones (🧪 EN CÓDIGO 2026-10-02)

| Item | Qué quedó | Dónde |
|---|---|---|
| **[RA-PRO.67]** | Señales por SKU en cada fila del workbook (`signals`, sólo la página en pantalla; el XLSX no las paga). **Tres márgenes sobre costo**, porque son tres preguntas: *hoy* (= `margen_real_pct` de Costo estándar, ponderado por venta 30 d, plaza 00 fuera), *esta compra* (precio de ficha neto ÷ costo de caja del plan = lista del proveedor en Kepler `kdpv_prov_prod`, la que toma la OC) y *con lo pagado* (`replenishment_plan.real_buy_cost`, testigo de la lista). **Venta perdida** en dos fuentes por separado: Wincaja (verificada contra el precio de ficha) y mostrador FLT (`agotado`). Insignias en la fila (*compra bajo costo · bajo costo · costo bajó · perdió $X*) y por sucursal. | back: `skuSignals()` (consultas) + `pedido-senales.ts` (armado puro) · contrato `replenishment-signals.contract.ts` |
| **[RA-PRO.68]** | Unidades de mayor a menor con los rótulos de Kepler (regla COT.16/17): "4 cj 3 paq" en el 83185 (antes "4 cj 3 pz"), "1 cj 2 paq 5 pz" en KINDER. Botones de captura, equivalencia del desglose, traspasos, acuse y los dos PDF. La suma por almacén ya no mezcla sueltas de unidades distintas. | `pedido-redondeo.ts` (`etiquetaUnidades`, `textoUnidades`, `textoSumaUnidades`) + workbook manda `unidad_u2`/`unidad_u3` |
| **[RA-PRO.69]** | **Pedido TÍPICO** del proveedor (antes publicado como "mínimo" en RA-PRO.66): "llevas $X de $Y" en la cabecera, neutro, y nota en el PDF global. **No rellena nada.** | `evaluarPedidoTipico()` · `/filters` manda `min_order_amount` |

**Medido en prod (solo lectura) y que cambió el diseño:**

1. ⛔ **`min_order_*` no es un mínimo del proveedor.** `import-supplier-params.js` (RA-PRO.10) lo DERIVA del historial (pedido típico del almacén principal) y no hay columna que separe lo capturado de lo derivado. RA-PRO.66 lo había rotulado "pedido mínimo": se corrigió.
2. ⛔ **Hallazgo fuera de esta etapa — `/compras/proveedores` → "Ver pedido" rellena hasta ese "mínimo"** (`supplierOrder()`). Aproximación con la fórmula del workbook a 30 d: **208 de 287 proveedores** se rellenarían, **$13.1M** sobre $7.6M de necesidad; CHARLY con un "típico" de $583k = 3.1 meses de su venta al costo. **No se tocó** (mueve lo que se compra): decisión pendiente.
3. **La venta perdida de Wincaja no siempre cuadra con su cantidad.** Sobre 2026: el importe cuadra con el precio de ficha de algún peldaño en **79–88 %** de los renglones de tienda y sólo en **44.8 %** del CEDIS ($9.3M de $16.4M fuera, hasta 56× el precio). Sólo se suma lo verificado; el resto se cuenta como *sin verificar*. El árbitro por peldaño (pieza/paquete/caja) salió de un falso negativo de KINDER (razón 6.6 = 0.66 contra su paquete de 10).
4. **Kepler no registra faltantes.** Wincaja dejó de anotarlos en cada plaza al migrar (CEDIS el 30-sep); la única fuente viva es FLT (13 reportes). Se declara en el tooltip con la fecha del último dato.
5. **Los costos se contradicen y se publican los tres.** NIKOLO 95434: reposición $61.42 (−23 %), lista $40.39 (+17 %), pagado $60.91 → −7.9 % tras la recepción del 1-oct. Sobre los 500 SKUs de más venta, lista vs pagado: mediana **1.0000** (192 al centavo), p75 1.04 → aviso *confirmar precio* sólo con ≥ 5 % de diferencia en costo (**104 de 490**; con 2 puntos de margen salía en la mitad = ruido).
6. **Guarda de unidad:** costo de compra fuera de 0.5×–2× la reposición → margen null (83518 +1,178 % y 70006 −92 %, unidades capturadas a mano). **Candado `al_dia`: 371/371** —donde Costo estándar dice "al día", el margen de esta compra coincide con el de hoy de la misma sucursal (<1 pp)—.
7. **Máximo vs venta (V30d/Máx):** en el 83185 el máximo `computed` queda **por debajo de la venta de un mes** en 5 de 7 sucursales (Morelia Abastos 37.2 vs 17.9). Insumo para la Etapa 5 de PM.

**Candados:** `pedido-senales.spec.ts` 13 (4 negativas, rotas a propósito y verificadas en rojo) · `pedido-unidades.spec.ts` 20 · arnés DB-direct que ejecuta el `skuSignals` real (500 SKUs en ~0.4 s).

### Etapa 3 — bonificación X+Y (⬜, requiere migración)

**[RA-PRO.70]** Capturar "10 + 1" por proveedor/producto con vigencia; el pedido redondea a múltiplos de
11, muestra **costo efectivo por caja**, días de inventario con lo gratis incluido y el ahorro.
Migración aditiva: tabla `commercial.supplier_free_goods_deals` (tenant, supplier, product NULL = toda la
línea, compra_x, regalo_y, vigencia, audit) + `purchase_requisition_lines.free_qty` (nullable). La
requisición separa cajas pagadas y regaladas — sin eso el PDF valúa lo gratis a precio completo.

### Etapa 4 — sell-in / sell-out y su efecto (⬜, requiere migración + modelo)

**[RA-PRO.71]** Distintivo en la fila cuando el producto tiene un **sell-in** (empuje al canal: promo de
compra, bonificación) o **sell-out** (activación al consumidor: MKT/Trade) vigente. **[RA-PRO.72]**
Medición antes / durante / después por semana, catorcena, 30 d y mes, para distinguir **aceleración real**
de **adelanto de compra** (la venta sube durante y cae después ⇒ sólo movió el tiempo). **[RA-PRO.73]**
Icono de historial con los eventos pasados y su reacción comercial.

Antes de crear la tabla, **medir si Fase G (Growth) o Trade ya tienen campañas/promociones** que sirvan
de fuente (CLAUDE.md: derivar, no copiar). Si no hay, tabla propia de datos HITL
`commercial.trade_events` (tipo sell_in/sell_out, productos, sucursales, inicio/fin, inversión, área).

### Etapa 5 — integrar el mínimo/reorden/máximo dinámico de PM (⏸️ espera a PM)

PM está construyendo la política dinámica semanal con temporalidad. **Propuesta de contrato para no
rehacer la pantalla:**

1. PM escribe en la tabla que ya existe, **`commercial.reorder_policy`**, con `source = 'dynamic'` (hoy:
   `computed` 33,527 · `kepler` 1,547). La pantalla ya lee `min/reorder/max` de ahí: **cero cambios de UI**
   para el corte.
2. Migración aditiva chica (cuando PM la necesite): `computed_at`, `valid_from`, `method_version` y una
   tabla de **historia** `commercial.reorder_policy_history` (valor anterior por semana) — para que el
   globo pueda dibujar el máximo de cada mes sobre la venta y se vea si el dinámico acompañó la temporada.
3. Latido en `analytics.cron_runs` + umbral en `CRON_JOBS` (si el cálculo semanal se detiene, el tablero
   se pone rojo en vez de seguir mostrando un máximo viejo como vigente).
4. Mientras tanto, `V30d / Máx` ya muestra el máximo `computed`; al cambiar la fuente sólo cambia el número.

## Pendiente de las Etapas 1 y 2

- Validación visual en el navegador (no se pudo levantar sesión en esta corrida).
- Decidir el relleno de `supplierOrder()` (hallazgo 2 de la Etapa 2).
- Redeploy api+view. Sin migraciones ni permisos nuevos → sin re-login.
