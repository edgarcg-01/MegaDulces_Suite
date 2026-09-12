# Fase SD — Retiro del linaje imperativo de ventas (`analytics.sales_daily` → ODS)

> **Estado**: 🔨 DISEÑADO (planeación) 2026-09-11 · **NO ejecutado**.
> Nace de la petición "purgar todo lo inventado / no fresco / obsoleto". La purga de basura
> (respaldos, latidos zombie, tablas dead-on-arrival) se aplicó a prod aparte. **Esto es lo que
> quedó identificado como "inventado" pero que NO se puede purgar: es load-bearing.**

## Tesis

`analytics.sales_daily` (3.76 GB) y su cadena de rollups imperativos son **el mismo hecho de venta
que el ODS, materializado por importer y desincronizado**. Es "inventado" en el sentido del proyecto
(valor materializado que no cuadra con la primaria), pero **65 servicios lo leen** — entre ellos el
motor de margen. No se purga: **se declara no-autoritativo y se migran los lectores al linaje
declarativo del ODS**, con un candado de paridad. Purgar sin migrar tira prod; y borrar dato stale
no lo vuelve fresco, lo vuelve ausente.

## Evidencia medida (agosto 2026, canales Kepler)

| Fuente | Revenue agosto |
|---|--:|
| `analytics.sales_daily` (tabla, lo que lee el código) | $21,296,918.56 |
| `analytics.mv_kepler_sales_daily` (matview sobre ODS) | $25,742,138.56 |
| **Brecha** | **$4,445,220 — 17.3%** |

Descompuesta por canal (**no va en una sola dirección** — clave):

| canal | matview ODS | tabla `sales_daily` | delta |
|---|--:|--:|--:|
| `ruta` | $2,031,381.68 | **$0.00** | +$2,031,382 (la tabla NO tiene venta de ruta) |
| `credito` | $7,481,351.83 | $4,802,028.91 | +$2,679,323 (subcuenta) |
| `tienda` | $16,229,405.05 | $16,494,889.65 | **−$265,485** (la tabla tiene MÁS) |

**El signo negativo de `tienda` es el bloqueante**: el matview pierde algo que la tabla sí tiene. El
matview NO es automáticamente el correcto. Mover lectores sin explicar ese −$265k es cambiar un
número equivocado por otro — el error exacto que la Fase MR ya pagó.

## Lectores (medido: 65 refs a `sales_daily` vs 13 a `mv_kepler_sales_daily`)

Prioridad (dinero primero):
1. `libs/commercial/src/lib/commercial-profitability/commercial-profitability.service.ts` — motor de margen.
2. `libs/commercial/src/lib/commercial-analytics/commercial-analytics.service.ts` — Command Center.

## Costo del duplicado

16 objetos del mismo hecho ≈ 30% del tamaño de la DB: `sales_daily` 3.76 GB · `mv_wincaja_sales_daily`
2.74 GB · `mv_sales_blended` 1.47 GB · `product_sales_daily` 1.30 GB · `sales_boxes_monthly` 689 MB ·
`sales_monthly` 242 MB · `sales_by_vendor_monthly` 297 MB · `product_sales_monthly` 92 MB · …

## Plan (sin big-bang, sin borrar tablas)

- **SD.0 — Explicar el −$265,485 de `tienda`** (ruta crítica, bloquea todo lo demás). Reconciliar
  fila a fila `sales_daily` vs `mv_kepler_sales_daily` para tienda; identificar qué incluye la tabla
  que el matview no (¿devoluciones? ¿un doctype? ¿fechas de captura vs valor?). Hasta no cerrarlo,
  NO se mueve un solo lector.
- **SD.1 — Candado de paridad**: smoke que compare los dos linajes mes×canal y falle sobre umbral
  (patrón `database/run-all-tests.js`; hermano de `test-newdb-sellout-parity.js` de VP.1). Debe
  incluir el hueco (venta de ruta ausente), no sólo el doble conteo.
- **SD.2 — Declarar `sales_daily` no-autoritativa** (comentario en tabla + doc), sin borrarla.
- **SD.3 — Migrar el motor de margen** al linaje ODS (`v_sales_demand_truth`/`mv_kepler_sales_daily`
  + Wincaja), con la medición antes/después del número publicado (un commit que cambia un número no
  cierra sin el antes/después — regla del proyecto).
- **SD.4 — Migrar Command Center**.
- **SD.5 — Retirar los rollups imperativos** que ya nadie lea (convertir a vista sobre el ODS o
  declarar deuda con nombre). Recién aquí se libera espacio, y sólo tras probar 0 lectores.

## Verificación

- La comparación agosto por canal debe explicarse **por completo** (los tres deltas) antes de mover
  un lector.
- `node database/run-all-tests.js` verde antes y después.
- Frescura: `sales_daily` por canal hoy muestra `tienda`/`credito` en 0 días de atraso; si el cambio
  los rompe, revertir.
- Visual: `/comercial/rentabilidad` + Command Center (dev servers los levanta Edgar).

## Relación con otras fases

Hereda **ADR-056/VP** (verdad y procedencia: el número declara con qué se calculó; `fresh|stale|unknown`)
y **ADR-059/VERDAD_ABSOLUTA** (la venta se arbitra contra el ODS; ya movió la venta +$15.8M/90d). Es
la contraparte de escritura de VP: VP declaró el problema, SD retira la fuente equivocada.

## Lo que este plan NO es

- No es una purga. Nada se borra hasta SD.5, y sólo con 0 lectores probados.
- No toca el ODS ni los matviews (son la fuente correcta que se adopta).
