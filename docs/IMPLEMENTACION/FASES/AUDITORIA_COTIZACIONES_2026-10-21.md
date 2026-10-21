# Auditoría del módulo de Cotizaciones (Telemarketing) — 2026-10-21

> Pedido: *"revisa todo el modulo de cotizaciones a profundidad"*, después de *"hagamos que
> cotizaciones se puedan editar"*. Alcance: backend (`libs/commercial/src/lib/commercial-quotes/`,
> ~2.6 k líneas), las tres pantallas y el entregable (`apps/view/src/app/modules/televenta/`,
> ~5.6 k líneas), migraciones, pruebas y los datos de producción.
>
> **Evidencia.** Nivel **B**: consultas de sólo lectura contra prod (`system_identifier
> 7688376744939610156`). Nivel **C**: lectura del código, en cuatro pasadas (backend, diseño,
> lógica del frontend y verificación cruzada de los hallazgos graves). ⛔ **Nivel A no**: nada se
> midió en la pantalla viva; lo visual se declara «sin validación visual».
>
> Cada hallazgo dice si está **[V]** verificado (leído en el código y, cuando se pudo, medido en
> prod) o **[I]** inferido.

---

## 0. La foto en producción (medida)

| | |
|---|---|
| Cotizaciones | **26**, todas en `draft`, de **7 usuarios** (4 son operadores de telemarketing), del 21-sep al 21-oct |
| Con cliente del ERP | 24 · sólo contacto: 2 · cliente de la plataforma: 0 |
| Renglones | 217 en 22 cotizaciones (promedio 9.9, máximo 55) · **4 cotizaciones vacías** desde septiembre |
| Vigencia | **12 de 26 ya vencidas** y siguen en `draft` (nada las vence) |
| Teléfono / correo del destinatario | **0 de 26** tienen alguno |
| Enviadas / convertidas en pedido | **0 / 0** — esas etapas no existen en código (COT.5 y COT.7 ⬜) |
| Cabecera contra renglones | ✅ **22 de 22 cuadran**: `total = Σ renglones × (1 − % del cliente)`. El descuento del cliente vive sólo en la cabecera, por diseño |
| Renglón: `unit_price × cantidad = line_total` | ✅ 217 de 217 |
| Precio cotizado por encima de lista | ✅ 0 · con descuento (volumen/promo): 123 |
| Disponibilidad | ⚠️ **217 de 217 dicen `available` con `stock_at_quote` vacío** (ver H-B4) |
| Permisos repartidos | VER+GESTIONAR: superadmin, supervisor, supervisor_ventas, telemarketing, vendedor_telemarketing · **sólo VER: direccion** |

---

## 1. Lo que está bien (y conviene no romper)

- **El precio lo decide el servidor, siempre.** Ningún body trae precio ni descuento; las condiciones
  del cliente se congelan desde el ERP al crear (`commercial-quotes.service.ts:821-864`). [V]
- **El alcance por sucursal está en todos los caminos** (`getOne`, `cancel`, `addLine`, `updateLine`,
  `removeLine`); los renglones se buscan por `quote_id`: no hay IDOR entre cotizaciones. [V]
- **El folio `COT-YYYY-NNNNN` es atómico** (UPSERT). [V]
- **Los totales guardados son coherentes** con los renglones (22/22, medido). [V]

---

## 2. Hallazgos, de más grave a menos

### 🔴 Críticos — dinero que se le promete al cliente o trabajo que se pierde

**C1 · El PDF/Excel que sale del DETALLE imprime cuentas que no cierran.** [V, código + prod]
- `televenta-quote-detail.component.ts:1422-1425` toma `q.subtotal` —que el servidor calcula como
  `total / 1.16`, o sea **ya con el descuento y sin IVA** (`quote-pricing.service.ts:1108-1111`)— y
  le vuelve a restar el descuento: `discountAmount = subtotal × pct`. El papel lo rotula «Subtotal
  Lista» (`quote-deliverable-export.ts:589`).
- Ejemplo: renglones por $1,000 con 3 %. El papel dice **$836.21 − $25.09 = $970.00**: la resta no da.
  Sin descuento dice «Subtotal $862.07 · Total $1,000.00» sin renglón de IVA, y afirma «precios con
  impuestos incluidos».
- **La misma cotización produce dos papeles distintos**: el alta imprime $1,000 − $50 = $950.

**C2 · El mismo PDF del detalle aplica DOS VECES el descuento por volumen o promo en cada renglón.** [V, código + prod]
- En el detalle, `discount_pct` del renglón es `(lista − unitario) / lista`, o sea el volumen o la
  promo, que **ya están dentro** del `unit_price` (`commercial-quotes.service.ts:476-479`). El detalle
  se lo pasa al entregable (`detail:1419`) y el entregable lo aplica otra vez:
  `unit_price × (1 − dtoPct)` (`quote-deliverable-export.ts:440-451`, `807-817`). Lista $100 y
  volumen $90 → el papel imprime **«Neto $81»**.
- **Medido en prod: 123 renglones de 18 cotizaciones** quedarían impresos **$8,539.97 por debajo** de lo
  cotizado ($418,895.52 → $410,355.55).
- Y esos renglones se quedan **sin** el descuento del cliente (el `discount_pct` del renglón tapa al de
  la cotización), cuando el servidor dice que el descuento del cliente «NO toca `unit_price`».

**C3 · Crear no es atómico: deja cotizaciones a medias y el reintento duplica el folio.** [V]
- El alta crea la cabecera y después agrega los renglones de a uno por HTTP
  (`televenta-quote-new.component.ts:2050-2069`). Si falla el renglón k, el folio ya existe con k−1
  renglones, el aviso dice «No se pudo crear la cotización» (`:2088-2090`), la bandeja sigue llena y
  «Crear» genera **otro folio**. Ninguna pantalla puede cancelar el huérfano (`svc.cancel` no tiene
  llamador). Las 4 cotizaciones vacías de prod son compatibles con este camino. [I la causa de esas 4]

### 🟠 Altos

**A1 · En «Todavía no es cliente», el botón Crear no se habilita al escribir el nombre.** [V]
`puedeCrear` es un `computed` que lee `contactoNombre`, un string plano (`new:1344`, `1410-1417`):
teclear no lo recalcula. Se destraba sólo cambiando de sucursal o de modo. ⚠️ La compuerta
`reactividad`, que existe para esto, no lo cazó.

**A2 · Cantidades: «2.5 kg» se vuelve 25 en el alta y 2 en el detalle.** [V]
`replace(/\D/g,'')` (`new:1753`, `1932`) borra el punto; el detalle hace `Math.floor`
(`detail:1153`, `1266`). El servidor sí acepta decimales. Error de 10× en lo que se vende por kilo.

**A3 · En el detalle, la cantidad se guarda con cada tecla.** [V el código, I el efecto exacto]
`(ngModelChange)="pedirCambio(...)"` sobre `type=number` sin debounce (`detail:542-551`): «48» manda un
PATCH con 4, el campo se deshabilita y el 8 se pierde. Cada guardado llama a `recargar()`, que pone
toda la página en «cargando».

**A4 · Concurrencia: totales que se pisan y renglones que entran a una cotización cancelada.** [V el código, I la carrera]
`removeLine` no bloquea la cotización y `recalcTotals` suma y luego escribe
(`quote-pricing.service.ts:1046-1118`): dos operadores sobre la misma cotización pueden dejar un total
que no corresponde a sus renglones. `addLine` lee el estado sin candado y bloquea recién después
(`:692-704`, `:736`): un `cancel` en medio deja entrar el renglón. Arreglo: `SELECT … FOR UPDATE` como
primera sentencia de todo verbo que escribe.

**A5 · `rung` no se valida y puede escribir `NaN` en el dinero.** [V el camino; ✅ medido que `NaN` pasa los CHECK]
`led.rungs[rung]` con `rung = "__proto__"` devuelve `Object.prototype`, el precio queda `undefined` y
`round()` da `NaN` (`:475`, `:611-612`). **Medido en prod: `'NaN'::numeric > 0` es verdadero**, así que
los CHECK de no-negativo no lo frenan y el `sum(total)` del resumen quedaría envenenado. Exige
GESTIONAR. `priceLine` lo usa también pedidos.

**A6 · El esquema prohíbe un renglón que el motor sí produce → 500.** [V el código y el CHECK en prod; latente]
CHECK `commercial_quote_lines_unmatched_has_no_price`: sin `product_id` no puede haber precio. El motor
devuelve precio con `product_id` nulo si el SKU tiene precio en el ERP pero no está en
`catalog.products`, y lo mismo el renglón de regalo. **Medido hoy: 0 de 9,629 SKU con precio en la 01
faltan en el catálogo, y las promos de regalo tienen 0 reglas vigentes**: no muerde todavía. Muerde el
día que el ERP dé de alta un SKU antes que el catálogo, y en ese caso se lleva también el renglón que
paga (misma transacción).

**A7 · El detalle ofrece editar a quien sólo puede ver.** [V]
`editable` mira estado y sucursal, no el permiso GESTIONAR (`detail:1019`). En prod `direccion` tiene
sólo VER: ve los controles, captura y recibe 403.

**A8 · Ningún camino de escritura se ejerce en CI.** [V]
Los tres smokes HTTP son `needsApi: true` y no corren en el job `pruebas-db`; `test-newdb-quotes.js`
inserta directo a la tabla; dos pruebas de `quote-pricing.spec.ts` son tautologías (arman el objeto y
comprueban sus propios campos, con campos que no existen); `quote-scope.spec.ts` usa un doble de Knex.
El entregable no tiene ninguna prueba de su aritmética. Nada cubre C1–C3, A2–A6.

### 🟡 Medios

- **M1 · Reimprimir sale con fecha de hoy y sin marca de vencida/cancelada.** La emisión es `new Date()`
  (`export.ts:291`, `734`) y exportar sólo mira que haya renglones. [V]
- **M2 · El alta exporta lo que nunca se guardó**, con precios de la bandeja que no se re-precian al
  cambiar de sucursal (`new:1615-1623`; `elegirCliente` cambia la sucursal sin avisar) y que se quedan
  viejos si falla la re-preciación (`new:1951`). El botón dice «Crear y descargar» y no crea. [V]
- **M3 · Disponibilidad dibujada como verde.** `quote-pricing.service.ts:634` escribe
  `availability='available'` en cuanto el SKU empata con el catálogo, sin mirar existencia
  (`stock_at_quote` vacío en 217/217). Hoy no se pinta en ninguna pantalla: es un dato falso latente
  para cualquier consumidor (el agente que el módulo anticipa). La migración nació honesta (`unknown`). [V]
- **M4 · Unidades adivinadas.** El peldaño del renglón se deduce del rótulo (`detail:1182-1187`), cosa
  que el propio servidor documenta como incorrecta, y el entregable saca el factor del **nombre** del
  producto con una regex `(\d+) pzas` cuando falta (`export.ts:174-182`). [V]
- **M5 · Lo que no tiene precio se imprime `$0.00`** (`export.ts:464-466`, `829-831`; ADR-056). [V]
- **M6 · El vendedor nunca aparece en el detalle**: se busca con regex en `notes`, pero viaja en
  `salesperson_name` (`detail:1387-1391`). [V]
- **M7 · El mensaje crudo que pegó el operador** (correo/WhatsApp del cliente) **se imprime en el papel
  que va al cliente** como «Nota:». [V]
- **M8 · La lista**: tope de 50 sin forma de recorrer el resto (la pantalla no manda `limit`; hoy hay
  26, latente) · error y vacío se pintan igual · la nota «Qué hace hoy» dice que no se pueden cargar
  renglones ni imprimir, y ya se puede · filtros «Aceptadas/Perdidas» que siempre salen vacíos. [V]
- **M9 · Estados**: la única transición es `draft→cancelled`, sin pantalla. Nada vence una cotización;
  `FASE_COT` y `FASE_E12` afirman que «una vencida sigue diciendo `sent`» y es falso: sigue diciendo
  `draft`. [V]
- **M10 · Cualquiera de la sucursal edita o cancela la cotización de otro.** Si es intencional, se
  declara; si no, regla de dueño. [V]
- **M11 · Condiciones atribuidas al ERP cuando el ERP no las tiene**: cliente que existe en otra
  sucursal guarda `terms_source='kepler_kdud'` con todo nulo (`service:840-850`). [V]
- **M12 · El detalle no suma un SKU repetido** (el alta sí): 2 cajas + 2 cajas quedan a precio de lista
  cuando 4 tendrían precio de mayoreo. [V]

### ⚪ Bajos (lista)

Sucursal guardada sin `trim` (un `" 08"` deja al usuario sin ver su propia cotización) · `valid_until`
inválida da 500, no 400 · vigencia por defecto y «hoy» en UTC (un día de más después de las 18:00) ·
`'01'` por omisión en `getOne:493` contra la regla COT.19 · vendedor sin validar contra el ERP y
duplicado en `internal_notes` · `warehouse_id`/`price_list_id` aceptados y sin uso · borrar renglón es
físico, sin rastro · `recalcTotals` no escribe `updated_by` · `cancel` no filtra `deleted_at` · Enter en
el buscador de cliente puede elegir el primero de una lista vieja · el body de `create` no declara
`salesperson_*` en el controlador · etiquetas de origen del precio distintas en alta y detalle (el Excel
del alta imprime «unknown»).

---

## 3. Diseño: las pantallas están fuera del sistema

### Inventario (escáner con control: una cadena con un botón crudo y uno `pButton` → exactamente 1)

| Pantalla | Controles crudos | Lo principal |
|---|---:|---|
| Nueva | **33** | 3 `<select>` → `p-select` · fecha nativa → `p-datepicker` · 8 `<input>` → `pInputText`/`p-inputnumber` · `<textarea>` → `pTextarea` · `<table>` propia · 20 botones (píldoras, stepper, cantidades rápidas, quitar) · avisos caseros → `p-message` |
| Detalle | **14** | 12 botones (las mismas piezas que «nueva») · 2 inputs |
| Lista | 2 | filtros «chip» propios → `app-segmented` · buscador |

⛔ En lista y detalle, `styleClass="p-datatable-sm dt-stack"` sobre `p-table` **no hace nada en PrimeNG
22** (atributo muerto): el apilado en angosto que promete el comentario `[UIM.2]` no ocurre.

### Lo demás (nivel C, sin validación visual)

- **Ninguna de las tres tiene `app-load-state` ni frescura** (§2 y §9 en deuda declarada).
- **Exportar PDF pintado como destructivo** (`severity="danger"` + `#dc2626 !important`), y `--action`
  usado de adorno 40 veces (número de paso, código de cliente, importes): §10.5 Von Restorff.
- **Modo oscuro roto**: `.pill-active { background:#fff }`, `.row-no-casado {#fffbeb}`; tokens que no
  existen (`--red-600`, `--green-700`, `--primary-color`, `--action-soft`) que caen siempre al hex.
  Hex crudos: nueva 45, detalle 24, lista 6. Un emoji en la plantilla del detalle.
- **«Táctil» sin serlo**: ± de 22 px, cantidades rápidas de 30 px; ningún `pointer: coarse` (Fitts, 44 px).
- **Sin protección de trabajo**: la bandeja de «nueva» se pierde al navegar (sin `CanDeactivate`);
  quitar un renglón no pide confirmación ni deja deshacer.
- **Teclado**: en el detalle la cantidad es un `span` (48 cajas = 6–7 clics) y el buscador no responde a
  ↑↓/Enter; «nueva» sí.

### Duplicación entre «nueva» y «detalle»

**~379 líneas idénticas** (148 de plantilla, 89 de CSS, 142 de TS) en 9 bloques: buscador de artículo,
ficha, selector de peldaño, stepper, cantidades rápidas, vista previa y Agregar, avisos de volumen/regalo,
riel de totales y exportación, auxiliares. **Las copias ya divergieron**: distinto orden del catálogo,
sólo «nueva» protege contra agregar con una previa vieja (`previaCorresponde`), sólo «nueva» suma
repetidos y tiene teclado, y **dos versiones de la aritmética del entregable** (de ahí C1 y C2).

---

## 4. Editar la cabecera (el pedido que disparó esto)

Hoy no existe `PATCH /commercial/quotes/:id`. Lo que hace falta, en orden de capas:

1. **Antes, cerrar lo que el re-precio va a disparar**: A4 (candado `FOR UPDATE`), A5 (`rung` en lista
   blanca) y A6 (renglón con precio sin catálogo).
2. **Backend** — `PATCH` con GESTIONAR, sólo `draft`, `assertEscribeSucursal`, candado primero:
   - Campos que no mueven precio: contacto, vigencia (400 si es inválida o anterior a la fecha de la
     cotización), notas, origen, vendedor (validado contra el ERP; deja de copiarse en `internal_notes`).
   - **Cliente**: extraer `resolveTerms(trx, código, sucursal)` de `create` (arregla M11 de paso),
     re-congelar las condiciones y `recalcTotals`.
   - **Sucursal**: autorización sobre la vieja **y** la nueva; re-congelar condiciones; **re-preciar
     cada renglón** con un `repriceLine()` extraído de `updateLine` (regalos incluidos; lo que la nueva
     sucursal no cotiza queda declarado sin precio); un solo `recalcTotals`; devolver el antes/después.
     Es la misma pieza que necesita COT.5 (re-cotizar).
   - El body nunca trae `terms_*`, totales ni precios.
3. **Frontend** — sacar de «nueva» el bloque Destinatario y el de cierre como componentes compartidos,
   **reconstruidos con PrimeNG** y con estado en signals (arregla A1), y un «Editar cabecera» en el
   detalle (`app-side-peek`) que muestre el efecto antes de guardar («el descuento pasa de 5 % a 3 % ·
   total $X → $Y»).
4. **Prueba** HTTP con rol mínimo y el payload de la pantalla, **que corra en CI**: re-precio correcto,
   `total = Σ × (1 − %)`, 400 fuera de borrador, 403 fuera de alcance, `terms_*` del body ignorado.

---

## 5. Orden propuesto (dinero × esfuerzo)

| # | Qué | Por qué primero | Esfuerzo |
|---|---|---|---|
| 1 | ✅ **`[E.19]` hecho (2026-10-21, ver §7)** · **C1 + C2 + M1 + M5 + M7**: una sola función de entregable que reciba del servidor `{suma de renglones, descuento, base sin IVA, IVA, total}` y no recalcule nada; fecha de la cotización; sin `$0.00`; sin el mensaje crudo | Es el precio que se le promete por escrito al cliente: $8,539.97 de diferencia en 18 cotizaciones | Chico |
| 2 | **A1 + A2 + A3**: `contactoNombre` como signal, decimales para lo que se vende por kilo, cantidad del detalle al salir del campo | Errores de 10× y un botón que no se habilita, en el uso diario | Chico |
| 3 | **C3**: `POST /quotes` con renglones en una transacción | Cotizaciones a medias y folios duplicados | Medio |
| 4 | **A4 + A5 + A6 + A8**: candados, `rung`, renglón sin catálogo, y las escrituras a una suite que corra en CI | Precondición de la edición; hoy nada protege las escrituras | Medio |
| 5 | **Edición de cabecera** (§4) **junto con** extraer el editor de renglón compartido y reconstruir con PrimeNG (§3) | Es el pedido; tocar esas pantallas sin rehacerlas sumaría a 47 controles crudos | Grande |
| 6 | **M8 + M9 + A7**: lista con `app-load-state` y recorrible, cancelar desde la UI, vencimiento, `editable` con permiso | Ciclo de vida (preparación de COT.5/COT.7) | Medio |

---

## 6. Lo que esta auditoría NO cubrió

- **Nivel A**: nada se midió en el navegador (alto, contraste, pliegue, foco, tiempos reales).
- El **match AI** y la extracción de imagen/PDF que cita `FASE_COT` §2 no se usan en estas pantallas.
- **M1 del backend (promos apiladas)** quedó como inferencia: hace falta contrastarlo contra ventas
  reales del ERP (ADR-059) antes de decidir.
- El costo de las ~6 lecturas por renglón agregado no se midió (`EXPLAIN ANALYZE` pendiente).

---

## 7. `[E.19]` Paso 1 hecho: el entregable cierra (2026-10-21)

- **Una sola cuenta**: `totalesCotizacion()` en `libs/contracts/src/money/quote-totals.ts`. Importe =
  Σ renglones con precio; descuento = el % del **cliente** (capa de documento); total =
  `round(importe × (1 − %))`; base = `round(total / 1.16)`; IVA = la diferencia; y los netos por
  renglón repartidos por mayor residuo para que **la columna sume el total al centavo**.
  **Verificada contra las 22 cotizaciones reales de prod**: reproduce total, base e IVA guardados
  al centavo en las 22 (prueba temporal con control, borrada después).
- **El entregable ya no hace aritmética al dibujar**: `modeloEntregable()` arma filas y totales; el
  PDF y el Excel sólo pintan. Requerimiento #4 de Dirección se conserva (columna «Descuento» +
  «P. Unitario Neto / Importe Neto»), pero el descuento de la columna es **sólo el del cliente**:
  el de volumen/promo ya está en el precio (C2). Totales: «Importe de los artículos − Descuento
  cliente = Total», con «incluye IVA» (C1).
- **Si el total del papel no es el que guardó el servidor, el papel no se genera** (el detalle
  manda `totalGuardado`; error visible en un toast).
- Emisión = fecha de la cotización; título «COTIZACIÓN VENCIDA / CANCELADA» en rojo (M1) · «Sin
  precio» y «Regalo» en vez de `$0.00`, y una condición «N artículos sin precio: no están en el
  total» (M5) · el mensaje crudo del cliente ya no se imprime (M7) · el vendedor sale de
  `salesperson_name` (M6, de paso) · fuera el emoji del renglón de regalo.
- **El riel de la pantalla de alta** usa la misma función: antes calculaba su descuento sin
  redondear (otra vista del mismo dato, Cruce 5).
- Pruebas: `quote-totals.spec` 6/6 (con COT-2026-00021 de prod como referencia),
  `quote-deliverable-export.spec` 10/10 con **prueba negativa** (sin el descuento del cliente,
  C1 y C2 se ponen rojos), `contracts` completo 701/701, `ngc --noEmit` con control.
- ⚠️ **Deuda con nombre**: el servidor (`recalcTotals`) todavía hace su propia cuenta; la spec fija
  que coincidan. Mudarlo a `totalesCotizacion` va en el paso 4 (escrituras), con prueba contra base.
- ⛔ **Sin validación visual**: el PDF y el Excel no se abrieron.
