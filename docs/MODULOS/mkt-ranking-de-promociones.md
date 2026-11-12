# Mercadotecnia › Ranking de promociones, Objetivos e Incentivos

## Problema

Cada lunes Mercadotecnia armaba a mano un Excel («RANKING SEMANA NN») con la venta de cada promoción por sucursal, ruta, televenta y vecinal, y los incentivos «$X por caja». Auditados los 45 archivos de 2026: 165 renglones de incentivos multiplicaban por otro monto que el de su texto (uno pagaba $4,875 donde eran $1,218.75), una promoción con objetivo 1 decidía el lugar de una sucursal, los promedios dejaban filas fuera y el promedio general se tecleaba.

## Solución

Tres pantallas en Promociones MKT:

- **Ranking** (`/mkt/ranking`): quién cumplió las promociones de la semana, por canal (Sucursales · Vecinal · Rutas · Televenta). La venta sale sola de Kepler. PDF semanal.
- **Objetivos** (`/mkt/ranking/promociones`): dar de alta las promociones (código de Kepler, vigencia, canales, sucursales) y fijar su objetivo semanal con un sugerido.
- **Incentivos** (`/mkt/incentivos`): la regla de pago se captura una vez y el pago de cada vendedor sale de la venta. PDF de pago con firmas.

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
