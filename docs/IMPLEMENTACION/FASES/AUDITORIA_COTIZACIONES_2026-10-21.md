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
| 2 | ✅ **`[E.20]` hecho (2026-10-21, ver §8)** · **A1 + A2 + A3**: `contactoNombre` como signal, decimales para lo que se vende por kilo, cantidad del detalle al salir del campo | Errores de 10× y un botón que no se habilita, en el uso diario | Chico |
| 3 | 🧪 **`[E.21]` en código (2026-10-21, ver §9; prueba HTTP pendiente de correr)** · **C3**: `POST /quotes` con renglones en una transacción | Cotizaciones a medias y folios duplicados | Medio |
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

---

## 8. `[E.20]` Paso 2 hecho: lo que fallaba en el uso diario (2026-10-21)

- **A1 · el botón «Crear»**: `contactoNombre` pasa a `signal`. ⭐ **La compuerta `reactividad` no lo
  cazaba porque sólo contaba como mutable un campo que el TypeScript reasigna**; éste lo cambiaba
  `[(ngModel)]` en la plantilla. Ahora la compuerta lee la plantilla (inline o `templateUrl`), con
  dos casos de autoprueba y **prueba negativa** (sin la detección nueva, el caso falla).
  ⛔ **Y destapó 6 casos más fuera de cotizaciones**: filtros y buscadores que no filtran en
  Almacén › Existencia (`fSupplier`) y Logística › Configuración (`routeSearch`), Costos (`search`)
  y Guías (`search`, `statusFilter`, `driverFilter` — verificado a mano: el comentario del código
  dice «se recalcula vía signal» y ninguno de los tres es señal). Quedan en la lista base de la
  compuerta como **deuda E.20 con nombre**; no son de este módulo.
- **A2 · kilos**: una sola lectura, `parseCantidad()` en `quote-units.ts` (Postel: fracción sólo
  donde la unidad se pesa; la coma sólo como separador de miles; «2,5» es ambiguo y no se adivina),
  usada en la franja de cantidad, la bandeja y el renglón del detalle. Al revisarlo aparecieron
  **dos `Math.floor` más** que cortaban los kilos aunque se teclearan bien: el de la bandeja al
  re-preciar y el de «aplicar volumen» (un mínimo de 2.5 kg quedaba en 2, abajo del umbral).
- **A3 · cantidad del detalle**: se guarda al confirmar (Enter o salir del campo), no con cada
  tecla; lo que no se entiende vuelve a la cantidad guardada con un aviso; y después de agregar,
  cambiar o quitar un renglón la página se refresca **sin** el estado de carga global que la
  desmontaba.
- Pruebas: `parseCantidad` 4 casos nuevos (`quote-units.spec` 19/19), televenta 29/29,
  `ngc --noEmit` con control, `reactividad --self-test` 6/6, demás compuertas verdes.
- ⛔ **Sin validación visual** ni prueba en navegador del ciclo teclear → confirmar → guardar.

---

## 9. `[E.21]` Paso 3 en código: el alta es atómica (2026-10-21) — 🧪, NO ejercida todavía

- **Backend**: `POST /commercial/quotes` acepta `lines[]` (qué y cuánto; nunca precio) y los agrega
  **en la misma transacción** que la cabecera. El cuerpo de `addLine` se movió tal cual a
  `addLineTrx(trx, …)` (diff sin espacios: idéntico); `addLine` queda como envoltorio con su
  propia transacción, sin cambio de comportamiento. Si un renglón falla, se revierte todo —
  cabecera y consecutivo del folio— y el 400 dice cuál: «Renglón 2 (SKU): …». Tope 300 renglones.
- **Pantalla de alta**: una sola llamada; al terminar abre el **detalle** de lo guardado (antes iba
  a la lista); si falla, no queda nada y la bandeja sigue intacta para reintentar.
- **Contrato**: el body del controlador declara `salesperson_code/name` (el servicio ya los usaba
  sin declararlos) y `lines`.
- ⚠️ **Costo declarado**: el candado de `quote_sequences` se sostiene mientras se precian los
  renglones; otra alta simultánea espera (segundos en la cotización más grande). Con 26 altas al mes
  es aceptable; la mejora con nombre es preciar ANTES de abrir la transacción.
- ⚠️ **Arranque no verificado** (protocolo §8.0b punto 30): `CommercialQuotesService` ahora recibe
  `QuotePricingService` por constructor (mismo módulo, import de valor, sin ciclo). No se levantó la
  API: lo confirma el despliegue o el CI.
- ⛔ **Regla 13 — un endpoint que escribe no está probado hasta que una prueba lo ejerce contra base
  real con el payload de la pantalla.** El smoke `http-quote-lines-test.js` §8 está escrito (alta con
  renglón de catálogo + no manejado; prueba negativa: renglón inválido → 400 que lo nombra, ninguna
  cotización a medias, folio sin consumir) pero **necesita la API arriba** y **no se ha corrido**.
- Pruebas que sí corrieron: `commercial-quotes` 57/57, televenta 29/29, `ngc --noEmit` con control.

---

## 10. `[E.22]` La estructura básica: qué precio cobraría Kepler (2026-10-21)

Reporte con captura: **SKU 89008**, Kepler cobra 36 PAQ a **$51.76**; la COT-2026-00026 cotizó 38 PAQ
a **$55.00** (y su PDF, con el defecto C2 todavía en prod, imprimió $54.09).

- **Causa, medida:** la escalera de volumen de `kdpv_prod_util` para ese PAQ tiene tres tramos sin
  encimarse (3-5 $55.00 · 6-9 $53.16 · 10+ $51.76) y el motor sólo conocía **el primero**
  (`v_label_prices.wholesale_*`). Lista y escalera son idénticas en la 01 y la 08: la sucursal no
  explica nada.
- **Arbitrado con dinero** (lo cobrado por Kepler, no lo configurado): 89008 coincide en el 100 % de
  sus renglones de venta; a escala, en escaleras disjuntas Kepler cobra el tramo de la cantidad
  4,275 veces contra 26 el primer tramo. Detalle y corrección del decode en `ERP_KEPLER.md` §2.7.
- **Arreglo:** el motor elige el tramo que CONTIENE la cantidad (`tramoDeCantidad`) cuando la
  escalera es disjunta; encimada → nivel 0 sin cambio. El primer tramo de `kdpv` coincide con
  `v_label_prices` en 8,165 de 8,182 SKUs disjuntos de la 01 (3 difieren por centavos): no mueve lo
  que estaba bien. ⚠️ **Lo usan también los PEDIDOS** (`commercial-orders`): su precio por volumen
  cambia igual.
- **Impacto en cotizaciones reales:** 89008 (+$123.12 de más), 40814 (+$38.00), 40078 (+$27.30, a 10
  PAQ no aplicaba ningún volumen) y 65124 (5 PAQ cotizados **por debajo** de su tramo). Las demás
  diferencias de la medición son promos sobre el mismo tramo o precios que el ERP movió desde la
  fecha de la cotización.
- ⛔ **No derivable, declarado:** aun en escaleras disjuntas, Kepler cobra lista en el 28.6 % y menos
  que el tramo en el 15.9 % de los renglones. La cotización da el precio que el ERP **configura**;
  si en el pedido se cobra lista o algo menor, es decisión de quien captura y no está medido quién.
- Prueba: `volume-tiers.spec.ts` con la escalera real del 89008 (3/3) y **prueba negativa** (la
  regla vieja del primer tramo la pone roja); `commercial-quotes` + `commercial-orders` 60/60.
- ⛔ **Sin ejercer contra la API** (lo usan `addLine` y los pedidos, caminos que escriben).

## 11. `[E.23]` La verdad absoluta, medida: el replay contra los pedidos de Kepler (2026-10-21)

**El instrumento.** `scripts/kepler/replay-cotizacion/` re-cotiza con el **motor real** (el
`quote-pricing.service.ts` empaquetado: corre su propio SQL, no es un doble) cada renglón de los
pedidos de telemarketing de Kepler (`U-D-40`, `c27 = 'TELEMARK'`) y lo compara campo por campo
contra lo que Kepler registró. Sólo lectura (sesión psql con `default_transaction_read_only`, con
sus controles: valor conocido, error, escritura rechazada). Arranca con dos renglones reales que
tiene que reproducir o no mide nada.

**Lo que Kepler guarda en el pedido, medido (1,639 pedidos, 30 d):** precio del renglón con
impuestos (`c12`, a centavos) · `c66` = precio original del renglón · `c16` = Σ renglones × (1 − %
cliente) en el 98.4 % / 97.1 % · `c14` IVA y `c15` IEPS **por la tasa de cada producto** · `c13` =
descuento del cliente sin impuestos. La tasa de `kdii` (`c18`/`c19`) = la del renglón en 2,011 de
2,011.

**El hallazgo grande: Kepler cobra la cantidad al precio de la UNIDAD MAYOR que cabe en ella.**
144 PZA de `02195` (CJA de 144) salen a $2,197.95 / 144 = **$15.26**, no a la lista de la pieza
($22.20) ni a su tramo ($18.04); `c66` = 15.2635416667. El motor no lo sabía.

| arbitrado contra lo cobrado | gana «unidad mayor prorrateada» | gana «lista de su unidad» |
|---|---:|---:|
| pedidos de telemarketing, 30 d | 7,284 | 280 |
| mostrador `U-D-10`, 3 d | 5,087 | 218 |

Y el precio cobrado baja desde ahí al **más barato de tres**: la unidad mayor prorrateada, el tramo
de su propia unidad y el tramo de la unidad mayor (por las que caben enteras) prorrateado. Sobre
13,116 renglones cuyo precio no cambió desde el pedido: **11,486 aciertan (87.6 %)**; sólo con la
lista, 6,323. Cuando sólo el tramo de la unidad mayor mejora, Kepler lo cobró 1,274 de 1,476 veces.
No es deriva de precio: acierta parejo en pedidos de 0–2, 3–9 y 10–30 días (87.0 / 86.4 / 88.3 %).

**Arreglo:** `unidadMayorQueCabe()` (pura, probada con el 02195 real) + el tramo de la unidad
mayor en `priceLine`, y el precio unitario a centavos como `c12`. `list_price` pasa a ser el `c66`
de Kepler (el precio original), así que «Subtotal original − Descuento» sale como en su pantalla.

**Antes / después, mismo universo** (143 pedidos, 2,011 renglones, $2,239,552):

| | antes | después |
|---|---:|---:|
| renglones al centavo | 1,106 (55.0 %) | **1,810 (90.0 %)** |
| importe al centavo | $647,542 | **$1,978,313 (88.3 %)** |
| pedidos completos exactos (cabecera consistente) | 14 | **63** |

En esos 63 pedidos el importe cuadra 63/63 y **el impuesto por producto (`kdii`) da IVA e IEPS al
centavo en 63/63**; el modelo de hoy (IVA 16 % fijo) acierta el IVA en 22. → siguiente paso.

**Lo que queda, declarado (1 día):**

- ⛔ **Promos `descuxq`:** la misma promo, mismo SKU y sucursal, Kepler la aplica en unos pedidos y
  en otros no. Clientes sin %: 73 de 78 sí; clientes con %: 121 sí / 81 no, y **no es la magnitud**
  (5 % contra 2 %: 32 sí, 64 no). No se derivó qué decide. Es casi todo el residuo en dinero
  (−$7.7 k en la 08 en un día, cotizado **de menos**).
- 33 renglones a 1 centavo de Kepler (redondeo de la promo) · 30 donde Kepler no prorrateó (`c66` =
  lista propia, el 3.7 % que también mide la tabla) · 30 artículos a $0.01 que el ERP no publica en
  `v_label_prices` (bolsas/obsequios) · `17066` en KG sin precio.
- ⚠️ **La captura del 89008 × 36 PAQ** (3 CJA) es el único caso que contradice el tramo de la unidad
  mayor: con él saldría $50.85 y la pantalla de Kepler mostró $51.76. Los pedidos reales de 24 PAQ
  sí traen `c66` = 51.7558 (la CJA prorrateada). **Pendiente: el folio de esa captura**.
- ⛔ **El % del cliente:** `v_erp_wholesale_customers` **no tiene fila para 68 de 143 pedidos**
  (47.6 %): la cotización de esos clientes no encuentra su descuento. En los que sí, 69 iguales y 6
  distintos al `c19` del pedido.
- 36 de 143 pedidos tienen la cabecera desfasada de sus renglones (pedido vivo, sigue a lo surtido):
  se excluyen de la comparación de cabecera, no se cuentan como acierto.
- ⚠️ **Lo usan también los PEDIDOS del vendedor** (`commercial-orders` llama a `priceLine`): su
  precio cambia igual, en la misma dirección que Kepler.
- ⛔ **Sin ejercer contra la API** (lo usan `addLine`/`updateLine` y los pedidos, que escriben).

## 12. `[E.24]` Las verdades que faltaban: promociones, precedencia, padrón y costo (2026-10-22)

Todo medido con el replay de §11 sobre el **mismo universo congelado** (143 pedidos, 2,011
renglones, $2,239,552: `replay.js <universo.json>` re-cotiza los mismos renglones) y, para las
reglas, sobre los pedidos de telemarketing de 30 días.

**1. La promo `descuxq` es la de la unidad que se COBRÓ.** «La misma promo, mismo SKU y sucursal,
unos pedidos sí y otros no» (§11) no era por cliente ni por magnitud: en la 08 se aplicaba a 1–12
PAQ y no a 14–60. Cuando la cantidad completa una unidad mayor, Kepler usa la promo de ESA unidad
(umbral en unidades mayores), y si no tiene, no hay promo: **313 de 324** renglones. La vigencia
(`c7`/`c8`) se descartó antes: las 280 promos estaban vigentes el día del pedido.

**2. El precio va por PRECEDENCIA, no por el más barato** (corrige E.23). Con unidad mayor rige su
tramo prorrateado o su precio, y el tramo de la unidad propia **no cuenta**; sin unidad mayor rige
el tramo propio **aunque sea más caro que la lista**. Donde las reglas difieren: precedencia 304,
mínimo 4. Detalle en `ERP_KEPLER.md` §2.7.

| mismo universo | E.23 | + promo de la unidad mayor | + precedencia |
|---|---:|---:|---:|
| renglones al centavo | 90.0 % | 94.4 % | **96.2 %** |
| importe al centavo | $1,978,313 | $2,140,859 | **$2,180,372 (97.4 %)** |
| cotizado de menos («Kepler cobró lista») | −$5,197 | −$524 | **−$68** |
| pedidos completos exactos | 63 | 69 | **79** |

Y en esos 79 pedidos: importe 79/79 e **impuesto por producto (`kdii` c18/c19) 79/79**; el 16 % fijo
de hoy, 25/79. Controles del replay: 5 renglones reales; los 3 nuevos se ponen **rojos con el motor
de E.23** (prueba negativa) y verdes con éste.

**3. El padrón de clientes — la tabla anterior estaba mal partida.** «68 de 143 sin fila» mezclaba
dos cosas. Bien medido sobre 30 días (1,590 pedidos):

| cliente | pedidos | importe | `kdud.c17` = % del pedido |
|---|---:|---:|---:|
| `C####` (la vista lo ve) | 1,151 | $14.8 M | 1,043 (90.6 %) |
| **existe en `kdud`, la vista lo FILTRA** (`CR####`, numéricos, `CONTADO`) | **439** | **$1.3 M** | 432 (98.4 %) |

El dato está bien en `kdud`; lo que falla es la premisa de `v_erp_wholesale_customers` («el padrón
de telemarketing son los `C####`»): **el 27.6 % de los pedidos de telemarketing son de clientes que
la cotización no puede encontrar**. Es exactamente el resolvedor `DC.0` que `FASE_DC` §9 propone
(sin el filtro). ⛔ Decisión pendiente: la vista sólo la usa cotizaciones, pero cambiarla es
migración en prod.

**4. Costo.** La cotización no usa costo en ningún lado (ni lo muestra ni calcula margen): no hay
número falso. El pedido de Kepler **no congela costo** (`kdm2.c62` vacío en el 84.5 % de 3,988
renglones de 7 días); la verdad es `kdii.c77` (costo estándar, Fase CE). Contra él, **80 renglones
(2 %) se vendieron bajo costo** en esa semana: si se quiere un aviso, ésa es la fuente.

**5. Lo que queda, con nombre:** 30 renglones sin prorrateo (una capturista, 3 pedidos de un
cliente: decisión de captura) · **26 SKUs de promoción a $0.01** («10 EXH EFFEM = GRATIS 1 EXH…»):
Kepler los publica en `kdii.c90` y la vista de etiquetas los excluye a propósito, así que la
cotización dice «sin precio» donde Kepler dice $0.01 · 1 renglón de `17066` en la 08 (la vista no
tiene esa sucursal) · ~20 sueltos de 1 centavo o tramos que el ERP movió · ⚠️ la captura del 89008
× 36 PAQ sigue contradiciendo el tramo de la CJA (con la regla sale $50.85; la pantalla mostró
$51.76) — **pendiente el folio**.

⚠️ Igual que E.23: cambia también el precio de los pedidos del vendedor (`commercial-orders`), y
nada de esto está ejercido contra la API ni desplegado.
