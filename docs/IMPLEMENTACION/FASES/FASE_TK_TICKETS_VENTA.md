# Fase TK — Tickets de venta (buscar cualquier folio y reimprimirlo)

> **Estado:** 🧪 TK.0–TK.3 EN CÓDIGO y probado contra `platform_test` · 2026-09-18
> **Pendiente:** validación visual · aplicar migraciones a prod · redeploy api+view · re-login.

---

## 1. Qué se pidió

Un apartado **Tickets** dentro de la sección **Ventas** que:

1. **Busque el folio de un ticket de venta, sin limitarse al canal** — "no hay que limitarnos en
   que sólo sea de sucursal, tlmk, ruta, etc.: el folio que sea, tú lo buscas y das con él".
2. Lo imprima **en el formato normal de un ticket**, agregando **el descuento total que se le hizo
   y su precio sin el descuento**, "para que sepa el cliente cuál era su precio antes y en cuánto
   le queda ahora".
3. Lo imprima también **en tamaño carta**, con los mismos datos, "de acorde a lo que hemos estado
   creando para que no haya muchos diseños de los mismos documentos".

---

## 2. Lo que se midió antes de diseñar

Todo contra `platform_test` (copia real de Kepler). Ninguna de estas cifras es una suposición.

### 2.1 ⛔ El descuento del ticket de mostrador NO está donde uno lo busca

| qué se probó | resultado |
|---|---|
| `kdm1.c13` (descuento de cabecera) en `U-D-10` | **0.00 en el 100%** de 30,549 documentos |
| `kdm2.c13 = c9 × c12` | **exacto en el 100%** de 29,353 renglones |

O sea: por el camino obvio —el que usa el anexo de telemarketing (Fase AX)— **el descuento del
mostrador no existe**. Si la fase se hubiera construido asumiendo el patrón del hermano, habría
publicado "Descuento $0.00" en todos los tickets y nadie lo habría notado.

> ⛔ **CADUCÓ — 2026-09-28.** El "100%" se midió **sin Morelia**. Contra prod, mostrador de
> septiembre 2026: las ramas `06`, `07` y `08` sí traen `c13 ≠ 0` (20 tickets, $1,948.15), porque
> ahí el mostrador cobra el **descuento del cliente** (`kdud.c17` → `kdm1.c19`/`c13`). El comentario
> *"Siempre 0.00 en el mostrador (medido, 100%)"* que la vista `analytics.erp_sale_tickets` lleva
> en el código dice lo mismo y también caducó. La conclusión de diseño **no cambia** (`c66` sigue
> siendo el testigo del descuento de renglón), pero la afirmación sí. Detalle en
> [`FASE_DC`](FASE_DC_DESCUENTOS_CLIENTE.md) §6.

### 2.2 ⭐ Dónde sí está: `kdm2.c66` = precio de lista de la unidad base

| doctype | renglones | cobran lista | con descuento | **cobran de más** |
|---|---|---|---|---|
| `U-D-10` mostrador | 29,353 | 24,900 | 4,422 (15.1%) | **31 (0.106%)** |
| `U-D-12` crédito | 569 | 386 | 180 | 3 (0.53%) |
| `U-D-8` telemarketing | 1,175 | 615 | 549 | 8 (0.68%) |

A nivel documento: **30% de los tickets de mostrador traen descuento real**, $25.50 promedio (3.3%).

### 2.3 ⛔ El testigo alterno quedó REFUTADO, no descartado por gusto

Comparar `c12` contra el precio del **catálogo** (`kdii.c90/c91/c92` del peldaño vendido) da
**1.9% de renglones cobrando por encima de lista** contra **0.10%** del renglón — **18× peor**. Y
el fallo es estructural, no de calidad: `kdii` es el precio de HOY y el renglón trae el de la
venta. No reintroducirlo.

### 2.4 ⛔ Las dos capas de descuento NO se explican entre sí

De 609 facturas `U-D-8`, sólo **172** cuadran entre `kdm1.c13` (descuento comercial del documento)
y la suma del descuento de renglón; **435 difieren en más de $1**, error medio **$183**. Son dos
cosas distintas que conviven, y por eso la cascada las muestra en dos renglones separados.

### 2.5 ⚠️⚠️ `c66` no existe antes del 2026-08-13 — el límite real de la fase

| mes | renglones `U-D-10` | `c66` vacío |
|---|---|---|
| ene–jul 2026 | ~1,046,000 | **100%** |
| ago 2026 | 241,754 | 39% (arranca el 13; sucursal `02` el 13, `03` el 14) |
| sep 2026 | 10,269 | 0.02% |

**El descuento de una venta sólo se puede afirmar desde esa fecha.** Es la limitación más
importante de la entrega y se DECLARA en pantalla y en el papel, no se disimula: `precio_lista`
viaja en **`NULL`, nunca en `0`** (un cero se lee como *"no costaba nada"* en un documento que
cobró dinero), la columna de lista desaparece entera cuando ningún renglón la tiene, y el aviso
dice literalmente *"un $0.00 acá significa 'no se sabe', no 'no hubo'"*.

### 2.6 ⚠️ Kepler no guarda la HORA

Las 10 columnas `timestamp` de `kdm1` y `kdm2.c32`: **todas en `00:00:00`** en los 10,716
documentos de la ventana. El papel imprime la fecha de **reimpresión**, rotulada como tal, y nunca
el reloj del navegador en el lugar de la hora de venta — la falla que VP.0 midió en 21 de 24
píldoras de frescura.

### 2.7 ⚠️⚠️ El folio NO identifica un documento

`kdmm` lo dice: `U-D-10` tipo N = **"Ticket Contado Caja N"** → **`c5` es la caja**, y el contador
de folios es por **sucursal × caja**. Medido: el folio `0018665` existe **7 veces** (sucursales 02,
03 y 04; dentro de la 03, en sus cuatro cajas), con fechas de marzo a agosto y totales de $27.50 a
$244.20. Por eso la búsqueda devuelve **candidatos** y sólo abre sola cuando hay exactamente uno.

---

## 3. Decisiones (Edgar, 2026-09-18)

| decisión | elegida |
|---|---|
| Qué descuento va en el papel | **Los dos, en cascada**: lista → descuento de precio → descuento del documento → total |
| Alcance de la búsqueda | Mostrador (`U-D-10`) + telemarketing y crédito (`U-D-8/12`) + pedidos propios (`PD-`). **Wincaja fuera** de esta entrega |
| Formato ticket | **Térmica 80 mm desde el navegador**, calcando `ticket-arqueo.ts` que ya está en las cajas |
| Permiso | `COMMERCIAL_TICKETS_VER` nuevo, repartido **calcando** a `COMMERCIAL_SALES_DOCS_VER` |

---

## 4. Qué se construyó

### TK.0 — Vistas en vivo del ticket (`20260918160000`)

`analytics.erp_sale_tickets` + `analytics.erp_sale_ticket_lines`, **derive-no-copy** sobre
`kepler_ods` (frescura del CDC, ~segundos; sin tabla, sin importer).

**Por qué vistas NUEVAS y no extender `erp_sales_invoices`:** se midió el radio de impacto. Esa
vista la leen `weekly-analytics`, `commercial-profitability`, `commercial-televenta`,
`mv_kepler_sales_daily`, `product_volume_tiers` y `v_product_box_factor`. Meterle el mostrador la
multiplicaría por ~60 (30,549 docs/30 d contra 477) y movería en silencio cifras ya publicadas —
justo lo que ADR-056 existe para impedir. El universo de doctipos queda repartido **sin traslape**:
`8/12` allá, `10` acá.

### TK.0b — Precio de lista también para `U-D-8` / `U-D-12` (`20260918160100`)

Tres columnas **aditivas** al final de `analytics.erp_sales_invoice_lines` (`precio_lista`,
`descuento_unitario`, `descuento_linea`). El decode de `c66` vive en un solo lugar conceptual; no
se copió una segunda vista. **No toca** `derivar()` del anexo, que sigue repartiendo el descuento
comercial a prorrata.

### TK.0c — Reparto del permiso (`20260918160200`)

`COMMERCIAL_TICKETS_VER` → **12 roles** (los mismos que hoy ven Facturación de Telemarketing).
*Un módulo nuevo no está entregado hasta que su permiso está REPARTIDO, no sólo declarado en el
enum* — la lección de LC.6.2.

### TK.1 — Backend `libs/commercial/src/lib/commercial-tickets/`

`GET /commercial/tickets?q=` (candidatos) · `GET /commercial/tickets/:id` (detalle con cascada) ·
`GET /commercial/tickets/:id/carta.pdf`. Alcance de sucursal recortado con `ScopeService`: que la
búsqueda no se limite **por canal** no la exime de respetar a qué plazas alcanza quien pregunta.

**La cascada cierra exacto en las dos restas**, y es a propósito: lo único que un cliente puede
comprobar de un papel es que los números sumen. Los dos descuentos se definen como **diferencias
medidas**, no como los porcentajes declarados (`c19` se imprime al lado, como referencia).

### TK.2 — Ticket térmico + pantalla

`ticket-venta.ts` calca `tienda/ticket-arqueo.ts`: 32 caracteres, 14 px, iframe oculto,
`@page 80mm auto`. Pantalla `/comercial/tickets` (Operations, master-detail), ítem **Tickets** en
el grupo **Ventas** del menú.

### TK.3 — Carta (PDF)

`TicketCartaService` **hereda la maqueta del anexo de venta** (membrete, sello no-fiscal, cajas de
contexto, tabla) y **reusa su Chromium compartido** vía `AnexoVentaService.renderPdf()` — lanzar
uno propio costaría los ~150 MB que su idle-timer existe para no pagar (ADR-043).

---

## 5. Verificación

| qué | resultado |
|---|---|
| `nx build api` · `nx build view` | ✅ |
| `ticket-venta.spec.ts` (candado de 32 columnas, cascada, lo que NO se imprime) | **11/11** |
| `test-newdb-sale-tickets.js` contra `platform_test` | **31/31** |
| Cobertura del precio de lista en la ventana medida | **99.98%** (8 de 38,341 renglones sin lista) |
| Prueba negativa del tope de descuento | **ejercida en 42 renglones** (no es un no-op) |

**El candado de 32 columnas atrapó dos defectos reales antes de llegar al papel:** el sello de
reimpresión medía 33 caracteres (`toLocaleString` sin opciones da `18/9/2026, 8:45:55 a.m.`) y la
leyenda legal se partía por donde cayera.

⚠️ El bloque TK.0b del smoke reporta **NO MEDIDO** en staging: reemplazar
`erp_sales_invoice_lines` exige ser su dueño y el rol de dev no lo es. El SQL **sí** se validó
—creando una vista de prueba con la misma definición— y las 22 columnas actuales quedan idénticas
con sólo 3 agregadas al final, que es lo que `CREATE OR REPLACE VIEW` exige.

---

## 6. Pendiente

- **Validación visual** de `/comercial/tickets` y de los dos papeles impresos.
- **Aplicar las 3 migraciones a prod** + redeploy `api` y `view` + **re-login** (el permiso nuevo
  viaja en el JWT).
- Wincaja (sucursales 30 y 32), fuera de esta entrega por decisión: es otra fuente de datos y su
  descuento es un **porcentaje por renglón** (`descuento1`), no una diferencia de precios.
- Los tickets anteriores al **13-ago-2026** no pueden mostrar descuento. Si se necesita, habría
  que buscar un testigo del precio vigente en esa fecha — hoy **no existe** (ver Fase VP.3:
  "cero historia de datos maestros").

---

## 7. Auditoría de la pantalla `/comercial/tickets` (2026-09-28)

Revisión pedida sobre la entrega ya hecha. **Todo medido**: el payload contra prod, el
comportamiento montando el componente real con ese payload, y **con control** en cada caso (la
misma prueba con el dato en la forma que el código asume). Lo que no se pudo comprobar se declara.

### 7.1 ⛔ `[TK.a1]` La lista de candidatos sale mutilada en TODA búsqueda

`buscar()` selecciona `t.fecha` cruda. `analytics.erp_sale_tickets.fecha` es `date` → `pg` la
entrega como objeto `Date` → NestJS la serializa entera. Payload real (folio `0018665`, el que
cita el docblock del servicio):

```json
{"id":"02UD1003-0018665","fecha":"2026-01-25T06:00:00.000Z","total":"73.72"}
```

y la plantilla hace `c.fecha + 'T12:00:00'` → `NG02311: Unable to convert … into a date`.

Montando `ComercialTicketsComponent` con ese payload, contra el control:

| | tarjeta 1 | tarjeta 2 |
|---|---|---|
| control (`2026-01-25`) | `Mostrador · $73.72 · ZAMORA UNO · caja 3 · 0018665 · 25/01/26 · CLIENTE UNO` | completa |
| **hoy** | `$73.72 ZAMORA UNO 0018665` | **vacía** |

El tiro corta el pase de binding: la primera tarjeta pierde **canal, caja, fecha y cliente**; de la
segunda en adelante quedan cajas en blanco. ⭐ **Es peor que una pantalla rota: parece que
funciona.** Y lo que falta es exactamente lo que la pantalla pide para elegir bien — su propio
aviso dice *"Elige el correcto por fecha e importe"*.

⭐ El hermano `customer-report.service.ts:190` **ya tiene** el helper `fecha()` que normaliza esto,
y `armar()` lo hace bien en el detalle. Sólo `buscar()` quedó fuera: es un olvido, no un criterio.
El `select` crudo viene del primer commit (`e66739f7`).

### 7.2 ⛔ `[TK.a2]` "Lo más reciente primero" ordena por DÍA DE LA SEMANA

`out.sort(… String(b.fecha).localeCompare(String(a.fecha)))` sobre un `Date` compara
`"Sun Mar 15 2026…"`. Con los 7 documentos reales del folio `0018665`:

```
Thu 2026-03-12 · Thu 2026-06-11 · Sun 2026-07-12 · Sun 2026-01-25
Sun 2026-04-12 · Sat 2026-03-07 · Sat 2026-08-29   ← el más reciente, ÚLTIMO
```

Es la misma trampa que la Fase LC.16 ya pagó. Agrava que `MAX_CANDIDATOS = 50` recorta *"los más
recientes"* sobre ese orden falso.

### 7.3 ⛔ `[TK.a3]` Bajo el encabezado "Importe" se lee el IEPS

`[TK.4]` (`75abf7a4`) agregó al cuerpo `@if (hayImpuesto()) { <td>IEPS</td><td>IVA</td> }` y
**nunca agregó los dos `<th>`**. Medido en el componente:

```
TH (6): Producto · Cant. · Lista · Pagado · Descuento · Importe
TD (8): PALETA · 2 PZA · $12.00 · $10.00 · -$4.00 · "—" · "$2.76 16%" · $20.00
                                            └── bajo "Importe" se lee ESTO
```

El importe real y el IVA quedan en columnas **sin encabezado**. Como `impuesto_desglosado` es
verdadero casi siempre (el propio servicio midió 100% en los tres doctipos), aplica a
prácticamente todo documento. **La carta en PDF está bien** — tiene `colgroup` y encabezados
consistentes; el defecto es sólo de la pantalla.

### 7.4 ⚠️ `[TK.a4]` La optimización declarada "NO MEDIDA" no compró nada, y sí costó el orden

`LIMITE_POR_UNIVERSO` declara honestamente que quitar el `ORDER BY` se hizo sobre una hipótesis,
sin antes/después. Medido ahora (`EXPLAIN ANALYZE, BUFFERS`, prod):

| consulta | hoy (sin `ORDER BY`) | antes (con `ORDER BY`) |
|---|---|---|
| mostrador, folio `18665` | 5 ms · 228 pág | 2 ms · 226 pág |
| mostrador, folio bajo `0000001` (39 filas) | 7 ms · 353 pág | 3 ms · 353 pág |
| facturas, folio `18665` | 1 ms · 103 pág | 0 ms · 103 pág |

**Mismo plan, mismas páginas.** La hipótesis del *nested loop* venía de una consulta **por rango de
fechas**; ésta filtra por folio exacto y el plan ya estaba bien. O sea: se cambió un orden correcto
en SQL por uno roto en JS (7.2) a cambio de **cero**.

### 7.5 ⚠️ `[TK.a5]` No hay spec del componente — y es justo lo que dejó pasar 7.1 y 7.3

`comercial-reporte-cliente.component.spec.ts` existe, y su propio docblock dice que ese archivo
*"también existe para COMPILAR el template — `tsc` no mira dentro de una plantilla"*.
`comercial-tickets.component` **no tiene ninguno**. Los tres defectos de pantalla los caza un
`TestBed` de 30 líneas, con su prueba negativa.

### 7.6 ⚠️ `[TK.a6]` Seis colores en duro donde hay tokens con dark mode

`.tk-aviso` / `.tk-warn` usan `#fdf6e3 / #5c4803 / #d6b45a`; existen `--warn-soft-bg`,
`--warn-soft-fg` y `--warn-border` **con override de oscuro** en `tokens.css`. Ídem el verde de
`.tk-ahorro` / `.tk-ahorraste`. Son justo las dos cajas que el módulo usa para **declarar lo que no
puede afirmar** (ADR-056).

### 7.7 Lo que está sólido

`parseFolioBuscado` y su candado del guion opcional; la cascada que cierra exacto por construcción
usando el descuento **medido** y no el declarado (⭐ confirmado por la Fase DC: en `07 U-D-10 s4
f0000513` el real es $147.43 y `kdm1.c13` dice $135.26); el desglose de impuesto que se verifica
contra la cabecera antes de publicarse; los avisos que distinguen las tres ausencias; el alcance
por sucursal en el controller con el 404 **antes** de consultar; y no auto-resolver con ≥2
candidatos.

### 7.8 Límite de esta auditoría

**No se ejerció en navegador.** `localhost:4200` y la API `:3334` estaban arriba, pero el perfil de
Chrome no tiene sesión y rebota a `/login`. La evidencia es el componente real montado con el
payload medido de prod, con control — no una sesión con clic humano.
