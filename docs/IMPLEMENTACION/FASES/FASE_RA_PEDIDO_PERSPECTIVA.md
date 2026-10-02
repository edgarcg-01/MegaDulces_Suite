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
| Mínimo de GONAC | **908 cajas** por pedido (106 SKUs) | Ya viajaba en `/filters` y no se mostraba |
| En camino | 1 OC abierta (folio 0006790, 70 cj, 23 días) | El motor ya la pondera por P(llega). ⚠️ La tabla `analytics.purchase_in_transit` (27-ago) está **retirada** desde el 28-ago — no leerla |
| Margen | 18.7% sobre venta (costo estándar Kepler); `sales_daily` da 11.1% constante (álgebra de markup) | Etapa 2 |

## Etapas

### Etapa 1 — sin migraciones (🧪 EN CÓDIGO 2026-10-01)

| Item | Qué | Dónde |
|---|---|---|
| **[RA-PRO.64]** | **+ Agregar sucursal** en el desglose (almacenes del filtro, sin rutas, que el workbook no mandó) y **leyendas** por renglón: *sin existencia · sin venta · sin mínimo · agregada*. El renglón agregado arranca en 0, se captura y entra a la requisición/PDF/XLSX como cualquier otro; *quitar* borra también lo capturado. | front: `compras-pedido-real.component.ts` · back: `filters()` manda `w.kind` |
| **[RA-PRO.65]** | Columna **V30d / Máx** (venta 30 d ÷ máximo de ESE almacén, en cajas). Clic → **globo** con 13 meses (barra = venta en $, número = cajas) contra el mismo mes del año anterior, los últimos 30 d, los próximos 30 d del año anterior y el **prorrateo 60/40 del sistema anterior** como referencia. Botón "venta por mes" para la red. | back: `GET /commercial/replenishment/workbook/:productId/monthly?code=` (`monthlySales()`, ~40 ms) + celdas con `mx`/`rop` |
| **[RA-PRO.66]** | **Pedido mínimo del proveedor** en la cabecera del desglose ("pedido mínimo 908 cajas (toda la línea)"). | front (ya viajaba en `/filters`) |

Reglas que se respetaron: las cajas sólo se publican donde el peldaño está medido (`units × rung_factor`
sin mezcla); lo demás se marca `*`/`?` y la barra en $ queda completa (ADR-056/059). Las rutas se pliegan
a su sucursal madre con el mismo `rmap` del fact. El 60/40 **no** alimenta el pedido.

### Etapa 2 — sin migraciones, más lectura (⬜)

| Item | Qué | Fuente |
|---|---|---|
| **[RA-PRO.67]** | **Margen real y venta perdida** en la fila y en el desglose | `analytics.v_kepler_standard_cost` (margen) · `analytics.v_sku_lost_demand` (venta perdida, con `dias_de_atraso` declarado) |
| **[RA-PRO.68]** | **Unidades como en Cotización**: siempre unidad mayor y luego la menor ("4 cj + 3 paq") | reusar el formateador del módulo de Cotización (por ubicar); `textoCajasPiezas` de `pedido-redondeo.ts` es el candidato a unificar |
| **[RA-PRO.69]** | Suma del pedido **vs el mínimo del proveedor** en la barra global y al armar la requisición ("te faltan 120 cj para el mínimo de GONAC") | `suppliers.min_order_boxes` |

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

## Pendiente de la Etapa 1

- Validación visual en el navegador (no se pudo levantar sesión en esta corrida).
- Redeploy api+view. Sin migraciones ni permisos nuevos → sin re-login.
