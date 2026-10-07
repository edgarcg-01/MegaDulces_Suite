# `[VEC.8]` — Migrar el sell-out a la fuente compartida

> **Estado: escrito, NO ejecutado.** Requiere ventana fuera de horario hábil.
> Escrito el 2026-10-06, con todo medido contra prod (`md` · `pg-prod`).

## Por qué

El sell-out y la venta por ruta miden el mismo hecho del mismo ERP y **hoy se contradicen**.
Medido en septiembre-2026, sobre las rutas vecinales:

| | |
|---|---|
| venta real (`U-D-10`) | **$1,945,184.67** |
| lo que publica el sell-out | **$3,150,428.68** |
| diferencia | **$1,205,244.01 — 62%** |

La diferencia es `U-D-12`: en estas rutas **re-emite el mismo ticket de caja** (medido por línea,
mismo cliente/día/SKU/cantidad: PH 99.8%, Morelia 100% y 97.9%, **placebo 0** en las tres). Fuera
de las rutas `U-D-12` es venta genuina en el 68.5%, así que no se trata de sacarlo del universo:
se trata de **marcarlo donde es espejo**.

⚠️ **En el total de una plaza no se nota**: PH agosto da $10,557,889.02 en el sell-out contra
$10,505,404.24 del árbitro `kdm1.c16`. Coinciden porque **los dos cuentan el espejo**. *Dos
derivaciones que comparten el error se confirman entre sí.*

## Lo que ya está hecho (y no hace falta repetir)

`analytics.v_kepler_sales_lines` (`[VEC.7]` / `[VEC.7.1]`, batches 752-753) es la línea de venta
resuelta una sola vez: llave con **caja**, documento en **su** plaza, cancelados fuera, `doc_tipo`
como columna, y `canal` / `vendor_code` **carácter por carácter** los del sell-out.

⭐ **Prueba de fidelidad, ya corrida contra prod (septiembre-2026):** agregando la canónica con los
mismos filtros del sell-out (catálogo, almacén, `SER`, `qty > 0`), los **cinco canales coinciden
al centavo**:

```
credito     $282,880.69   Δ 0.00
mayoreo  $11,219,208.82   Δ 0.00
mostrador $24,675,499.72  Δ 0.00
preventa  $3,150,428.68   Δ 0.00
ruta        $226,980.47   Δ 0.00
```

Es decir: **cambiar la fuente del sell-out a la canónica no cambia ninguna cifra**. Lo único que
cambia es lo que se decida filtrar — y eso es exactamente `WHERE NOT es_refactura`.

## Lo que falta, y por qué necesita ventana

`mv_kepler_sales_daily` es una **matview**: no hay `CREATE OR REPLACE`. Cambiar su definición
obliga a `DROP ... CASCADE`, y el cierre transitivo **no son los 5 dependientes directos**:

```
15 objetos en 3 niveles · 5 de ellos matviews · 2,453 MB en total
```

Nivel 1 `mv_sales_blended`, `v_sellout_daily`, `v_price_signals`, `v_price_experiment_results`,
`v_sku_price_response` · Nivel 2 `mv_sellout_monthly`, `mv_profitability_sales_agg`,
`mv_sku_price_response`, `v_promo_agreement_sellout`, `v_sellout_vs_facturacion` · Nivel 3
`v_sales_entity`, `v_price_action`, `v_purchase_decision_signals`, `v_sellout_channel_coverage`.

⚠️ Además **ningún índice de `mv_kepler_sales_daily` es UNIQUE**, así que su refresco **no puede
ser `CONCURRENTLY`**: toma `ACCESS EXCLUSIVE` y el sell-out queda inaccesible mientras dura.

⛔ **Se descartó el atajo** de parchear `v_sellout_daily` (una vista, barata de reemplazar) para
que descuente la re-facturación: dejaría la matview con el dato inflado y a sus otros consumidores
leyéndolo. Sería **una tercera versión** de la misma verdad, que es justo lo que esta fase existe
para eliminar.

## Pasos

1. **Ventana**: fuera de horario hábil. Avisar — la venta publicada del sell-out **baja ~$1.1M/mes**
   en las plazas con ruta vecinal. No es una pérdida: es dejar de contar dos veces. Que no lo
   descubra alguien el lunes en un tablero.
2. **Capturar** `pg_get_viewdef` de los 15 objetos y los `indexdef` de las 5 matviews.
   ⚠️ Pedir la definición con `SET LOCAL search_path = pg_catalog`: `pg_get_viewdef` **imprime
   según el `search_path` de quien pregunta** y sin eso los nombres salen sin calificar
   (lección de `[VEC.1]`).
3. **Medir el antes** por canal y mes, y guardarlo.
4. `DROP MATERIALIZED VIEW analytics.mv_kepler_sales_daily CASCADE`.
5. **Recrear** la matview leyendo de `analytics.v_kepler_sales_lines`, con los mismos filtros
   (catálogo, almacén, `SER`, `qty > 0`) y **`WHERE NOT es_refactura`**.
6. Recrear índices y los 15 objetos **en orden de nivel** (1 → 2 → 3).
7. Refrescar las matviews del cierre.
8. **Verificar**: los canales distintos de `preventa` deben quedar **idénticos al centavo**, y
   `preventa` debe bajar exactamente el valor de `es_refactura` del período. Cualquier otra
   diferencia significa que algo se recreó mal → revertir.
9. Correr `database/tests/test-newdb-vecinal-truth.js`: su aserción *"el sell-out y la venta por
   ruta dicen lo mismo de la vecinal"* **está en rojo a propósito** y debe pasar a verde. Es el
   criterio de aceptación de este runbook.

## Después

Con la canónica en producción como fuente del sell-out, las demás derivaciones de venta
(`erp_sale_ticket_lines`, `erp_sales_invoice_lines`, `v_seller_sales_lines`, `mv_erp_margin_daily`…)
pueden migrar una por una, cada una con su propia verificación de fidelidad. **De las 44 vistas de
`analytics` que leen `kdm1`/`kdm2`, ninguna comparte reglas con otra**: unas unen por caja y otras
no, unas excluyen cancelados y otras no. Ése es el trabajo de fondo que esta fase abre.
