# MKT › Promociones MKT (MKT.7)

Pantallas: `/mkt/promotions` (Promociones), `/mkt/erp-promos` (Promos ERP), `/mkt/acuerdos`, `/mkt/resultado`.

## Problema

Auditoría del 2026-11-11, medida en producción en sólo lectura:

1. **«Promociones» decía «Crea tu primera promoción».** La lista es el motor de promociones de la Suite
   (`commercial.promotions`, para el portal y los pedidos) y tiene **0 filas**. Quien busca las promociones de la
   semana (Mercadotecnia lleva ~90 códigos en su ranking semanal) entendía que había que darlas de alta otra vez a mano.
   Si la consulta fallaba, la pantalla decía lo mismo que si no hubiera nada.
2. **«Promos ERP» salía vacía con 328 reglas vigentes en Kepler.** Leía `analytics.erp_promotions`, clavada en la
   sucursal 03 (8 Esquinas), que hoy tiene 0 reglas vigentes; Zamora Centro tiene 187 y Morelia Abastos 126.
3. **El descuento se pintaba en pesos.** `c6` de `kdpv_descuxq` es un **porcentaje** (verificado 113 contra 2 en
   `v_label_promotions`): «$50 desc.» era 50 %. El umbral salía como «1 u» sin decir si era paquete o caja, y el año 2106
   (sin fin) salía como fecha.
4. **Mercadotecnia no veía sus pestañas.** «Acuerdos» y «Resultado» pedían sólo `MKT_AGREEMENT_EVIDENCE_SUBIR`; los
   roles `marketing` y `jefe_marketing` tienen `MKT_AGREEMENTS_VER` sin esa clave. La ruta los dejaba entrar y la
   pestaña se les escondía. «Promos ERP» pedía un permiso distinto al de su ruta.
5. Si la consulta de Promos ERP fallaba, la pantalla se caía: Angular 22 lanza al leer `value()` de un recurso en error.

## Solución

- «Promociones», vacía, dice qué lista es y lleva a **Promos ERP**; si la consulta falla dice «No se pudo cargar» y no
  pinta un 0. El encabezado ya no mezcla «activas de esta página» con el total.
- «Promos ERP» muestra las reglas vigentes **de todas las tiendas**, con el beneficio en su unidad («50 % de descuento»,
  «Gratis 1 PZA de …»), el umbral en su presentación («1 PAQ»), «Sin fin» para el 2106 y el nombre de la tienda.
- Cada pestaña pide el mismo permiso que el guard de su ruta.

## Cómo se implementó

- **Sin migración ni vista nueva.** `erpPromotions()` lee `analytics.v_erp_discount_rules` (la del motor de precio de
  cotizaciones, `[COT.1.0]`: los cuatro `kdpv_*`, todas las tiendas, deduplicada, sólo vigentes). El SQL y el mapeo viven
  en `libs/commercial/src/lib/commercial-analytics/erp-promotions.ts`. La herramienta de Thot `thot_active_promotions`
  usa el mismo método y gana las mismas filas.
- Pruebas: `erp-promotions.spec.ts` (12, con prueba negativa: volver a `erp_promotions` la pone en rojo),
  `promos-tabs.spec.ts` (5, con prueba negativa) y `mkt-promos-vacio.spec.ts` (8).

## Por qué así

- Reusar la vista que ya cubre las tiendas evita una segunda definición de «promo vigente» (regla 2 del repo).
- La vieja `analytics.erp_promotions` **no se tocó**: la usa Rentabilidad (`commercial-profitability.service.ts`), que
  ya declara que la encuentra vacía (`[MR.8.0e]`). Repuntarla es otra decisión, de esa fase.

## Lo que esta pantalla todavía NO muestra

Las promociones del ranking de Mercadotecnia **no son** las de `kdpv_*`: son **códigos simbólicos «= GRATIS» de `kdii`**
(a $0.01, ERP_KEPLER §2.9), que se venden como renglón en `kdm2`. Ninguna pantalla del módulo los lista. Kepler no guarda
su vigencia y el mismo código cambia de promoción (la identidad es código + descripción). Llevarlos al módulo es una
funcionalidad nueva que pide decisiones de negocio (ver el reporte de la auditoría).
