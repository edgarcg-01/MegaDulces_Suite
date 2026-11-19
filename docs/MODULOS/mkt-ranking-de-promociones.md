# Mercadotecnia › Ranking de promociones, Objetivos e Incentivos

## Problema

Cada lunes Mercadotecnia armaba a mano un Excel («RANKING SEMANA NN») con la venta de cada promoción por sucursal, ruta, televenta y vecinal, y los incentivos «$X por caja». Auditados los 45 archivos de 2026: 165 renglones de incentivos multiplicaban por otro monto que el de su texto (uno pagaba $4,875 donde eran $1,218.75), una promoción con objetivo 1 decidía el lugar de una sucursal, los promedios dejaban filas fuera y el promedio general se tecleaba.

## Solución

Tres pantallas en Promociones MKT:

- **Ranking** (`/mkt/ranking`): quién cumplió las promociones de la semana, por canal (Sucursales · Vecinal · Rutas · Televenta). La venta sale sola de Kepler. PDF semanal.
- **Objetivos** (`/mkt/ranking/promociones`): dar de alta las promociones (código de Kepler, vigencia, canales, sucursales) y fijar su objetivo semanal con un sugerido.
- **Incentivos** (`/mkt/incentivos`): la regla de pago se captura una vez y el pago de cada vendedor sale de la venta. PDF de pago con firmas.

**Buscar dentro del detalle (`[MKT.27]`, 2026-11-17).** El detalle de una sucursal o vendedor trae un buscador: promoción, código, producto, SKU, proveedor o **código de barras** (pistola, cámara o tecleado). Los códigos salen de `catalog.product_barcodes` y viajan una sola vez por respuesta (`codigos_barras`); si no se pueden leer, la pantalla lo avisa. El precio queda pendiente hasta verificar su fuente en Kepler.

**Por vendedor en Vecinal, Rutas y Telemarketing (`[MKT.28]`, 2026-11-18).** Kepler guarda la ruta, no a la persona; el nombre sale de quién tiene asignada esa ruta en la Suite (`trade.catalogs.erp_vendor_code` → `daily_assignments`), con la ruta y el apoyo abajo. Una ruta sin ligar muestra el nombre de Kepler y lo dice. «Televenta» se llama ahora «Telemarketing».

**Rutas por camioneta (`[MKT.29]`, 2026-11-18).**
- *Problema:* en Rutas salía un solo renglón (`06:30001`, la venta que Kepler registra en la sucursal de Canindo); la venta de cada camioneta no estaba.
- *Solución:* leer la venta de cada camioneta del push (`analytics.v_route_sales_lines`), la misma que ya usan Ventas por ruta y las comisiones de RD, y nombrar a cada una con una sola regla compartida (`libs/commercial/src/lib/rutas/quien-trabaja-la-ruta.ts`): chofer de la comisión → persona asignada en la Suite → nombre de Kepler → «sin chofer».
- *Implementada:* semana 46, Rutas pasa de 1 participante y 27 piezas de promo a 10 y 159. `06:30001` se queda: es otra venta, medida contra placebo.
- *Por qué:* no se crea fuente nueva ni se copia nada (regla 1), y Ventas por ruta y el ranking dejan de dar dos respuestas distintas a «quién trabaja esta ruta» (ADR-056).

**Dos rankings que no se mezclan (`[MKT.30]`/`[MKT.31]`, 2026-11-19).**
- *Problema:* la pantalla contestaba «¿quién cumplió su meta?» (orden por cubrimiento), sin total de la semana ni dinero, y Mercadotecnia necesita saber qué promoción se vende más, dónde y quién vendió más.
- *Solución:* dos pestañas. **Ranking de promociones**: toda la venta de la semana en los 4 canales, la más vendida primero, con paquetes, objetivo, avance y dinero; se filtra por canal, sucursal o zona, y cada promoción abre dónde se vendió. **Ranking de vendedores**: sólo lo que se le cargó a cada uno (en Sucursales, lo que la cajera asignó en su arqueo), con precio por paquete y total. Un botón **Objetivos** cambia el objetivo por sucursal de todas las promociones en un solo lugar.
- *Implementada:* `GET /commercial/mkt-ranking/venta` (sólo lectura) y las reglas en `libs/commercial/src/lib/mkt-ranking/mkt-venta.logic.ts`. Dinero = lo que pagó el cliente por los productos que activan la promoción, en los tickets donde se aplicó (un piso); sin producto identificado dice «sin dato», no $0.
- *Por qué:* lo que se vendió y lo que se le carga a cada vendedor son números distintos (el segundo siempre es menor: los tickets que la cajera no asigna no son de nadie), y mezclarlos hacía que ninguno se leyera bien. El dinero de Ruta vecinal, Ruta directa y Telemarketing todavía no se contrasta contra Kepler y la pantalla lo dice.

## Cómo se implementó

- Venta: `analytics.v_kepler_sales_lines` (ranking semanal) y `analytics.mv_kepler_sales_daily` (incentivos y sugerido, ventanas largas). Nada se copia.
- Caja: unidades ÷ `analytics.v_kepler_unit_ladder.factor_caja` de cada sucursal.
- Lo que decide una persona vive en 4 tablas nuevas: `commercial.mkt_ranking_promos`, `mkt_ranking_objectives`, `mkt_incentives`, `mkt_incentive_captures`.
- API `GET/POST/PATCH/PUT/DELETE /commercial/mkt-ranking/*` con los permisos que Mercadotecnia ya tiene (`MKT_AGREEMENTS_VER` / `_GESTIONAR`).

## Por qué así

- **Cubrimiento con tope de 100 %**: cumplir de más una promoción no tapa las que no se cumplieron.
- **Sin objetivo no es cero**: se cuenta aparte; quien no tiene ninguno queda sin lugar.
- **Alta manual de la promoción**: Kepler no guarda la vigencia y reutiliza códigos.
- **Dar de baja = terminar ayer**: las semanas pasadas no cambian.
- **El incentivo calcula, no paga**: no escribe en nómina ni en caja; el PDF lleva firmas.
