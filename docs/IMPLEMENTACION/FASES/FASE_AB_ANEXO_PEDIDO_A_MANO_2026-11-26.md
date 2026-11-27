# FASE AB · Anexo PM — El pedido a mano, dentro de Autoabasto (2026-11-26)

> **Pedido de Francisco, 2026-11-26:** «lo que me toca a mí en Autoabasto es captura pedido manual,
> en una interfaz similar a la de Cotizaciones, donde una sucursal le pide a su matriz u otra
> sucursal un pedido para traspaso; en Kepler corren en el mismo tracking de surtido, checado y
> embarques, diferenciando entre telemarketing y sucursal». Revisada la maqueta: **«eso es lo que
> ocupamos, avanza; lo único que le agregaría es la medición del alcance en días como se mide en
> pedido de compras a proveedor»**.
>
> **No es fase nueva:** es un frente de la fase AB (dueño: Edgar). Llena lo que el
> [anexo de interfaz](FASE_AB_ANEXO_INTERFAZ_2026-11-23.md) dejó en su §8 como «la captura manual
> como módulo: es otro frente», y lo construye como su §10.4 pide: **una pantalla con una decisión,
> no dos pantallas**.

---

## 1. En una frase

La sucursal **ya pide a mano todos los días, en Kepler**. Esto lo trae a la Suite, dentro de la misma
pantalla del pedido sugerido, y lo manda por **el mismo escritor** que ya existe.

---

## 2. Lo medido (`pg-prod`, sólo lectura, `system_identifier` verificado, 2026-11-26)

| Qué | Medido |
|---|---:|
| Pedidos de sucursal (`U-D-40`, `c27='SUCURSAL'`) a otra sucursal (`TI###`), 30 días | **1,506**, todos tecleados en Kepler, en el servidor del origen |
| Pedidos de telemarketing (`c27='TELEMARK'`) en el mismo periodo | 1,409 |
| Por servidor de origen | 00: 694 · 08: 304 · 01: 186 · 06: 65 · las otras cinco, menos de 30 cada una |
| A Morelia Madero (`TI009`), 30 días | **125 desde Morelia Abastos** (26 días distintos, ~5 al día, mediana 10 renglones) · 50 desde CEDIS (mediana 3) · 6 de otras |
| Pedidos de sucursal escritos por la Suite | **0** (0 de 2,604 requisiciones de traspaso con folio de Kepler) |
| Borradores de Autoabasto | 7, los 7 sin enviar |
| Interruptor `traspaso` | encendido en **07 y 08** (desde 2026-11-23); apagado en las otras siete |

**Lo que esto decide del diseño:**

- ⛔ **`enviar()` sólo acepta productos que el motor sugirió.** Uno que no está en el plan sale como
  «No le falta a esta sucursal» (`autoabasto-pedido.service.ts`). El pedido a mano necesita **su
  propio camino para guardar**; el de **escribir en Kepler se comparte**
  (`crearRequisicionesDeSucursal` + `soltarPedidoDeSucursal`, ADR-127).
- ⭐ **«Un producto no llega dos veces» ya está en la base:** `commercial.autoabasto_pedido_lineas`
  tiene `UNIQUE (tenant_id, pedido_id, product_id)`. Pedirlo a mano es **mover** el renglón, no
  duplicarlo.
- ⭐ **El alcance en días ya existe una sola vez** (ADR-056): `diasDeCobertura()` en
  [`cantidad-pedido.contract.ts`](../../../libs/contracts/src/http/cantidad-pedido.contract.ts) —
  `(existencia + lo que ya viene + lo que pides) × 30.4 ÷ venta de 30 días`, en unidad base — con el
  tope `TOPE_COBERTURA_DIAS = 45` y la cobertura de cada almacén en `coberturaAutoabasto()` (07 → 21
  días). Es la misma cuenta que Pedido de Compras. **No se escribe otra.**
- ✅ **La unidad, probada contra un hecho independiente:** en el plan de Morelia Madero, 07212 trae
  10 «en tránsito» con factor 1, y son **los 10 PAQ del pedido 0001700** de Morelia Abastos, que hoy
  está en checado. Existencia, tránsito y pedido hablan la misma unidad.

---

## 3. Las cinco preguntas (`diseno` §0b), por escrito

1. **Qué ve y en qué orden.** En la mesa: lo que impide mandar → lo que sale → **pedir algo a mano**
   → lo que te va a llegar. En la captura: a quién se lo pides → el buscador → lo que llevas, por
   destino → lo que sale. La pregunta de la pantalla: **«¿qué le pido hoy, y a quién?»**.
2. **Qué no ve.** El sugerido renglón por renglón (a un clic, como ya lo dejó Edgar); precios de
   venta (en un traspaso no deciden); el costo por renglón (no medido, no se pinta).
3. **Accesibilidad.** Se busca por código, nombre o proveedor, en cualquier orden, como en
   Cotizaciones; Enter agrega, flechas eligen; 44 px al dedo; el estatus dice su palabra y el alcance
   su número, nunca sólo un color.
4. **Ligado a.** Kepler: sale como pedido de sucursal, nace autorizado y entra a Surtido → Checado
   → Embarque, el mismo carril que telemarketing (Gestión de pedidos ya lee los dos por `c27`).
   Compras: lo que ninguna sucursal tiene va con su calendario.
5. **¿Le toca a esta pantalla?** Sí: es el mismo acto que el pedido sugerido —«necesito esto, ¿a
   quién se lo pido?»—. Por eso vive en Autoabasto y no en un módulo aparte.

---

## 4. El diseño (maqueta revisada con Francisco, 2026-11-26)

Cuatro pantallas: la mesa con «Pedir algo a mano», la captura estilo Cotizaciones, la confirmación y
el celular. Las reglas que la maqueta fija:

| # | Regla | De dónde sale |
|---|---|---|
| R1 | **Un producto vive una sola vez en el borrador.** Pedirlo a mano lo saca del sugerido; el buscador lo dice antes («ya va en tu pedido sugerido · 20 PAQ») | La `UNIQUE` que ya existe |
| R2 | **Lo que ya viene se dice en el renglón**, con folio y estatus («ya viene 10 PAQ · pedido 0001700, en checado»), y cuenta para el alcance | «Lo que te va a llegar» (PQ.136-137) |
| R3 | **Alcance por renglón: hoy → con lo que pides.** Más de 45 días se **dice**, no se bloquea: el tope gobierna lo que el motor sugiere, no prohíbe capturar (la regla de Pedido, `[RA.45D]`). Sin venta → «no se mide», **nunca 0** | `diasDeCobertura()`, ADR-056 |
| R4 | **La existencia del origen es un dato, nunca un candado** | ADR-127 §4 |
| R5 | **Un documento por sucursal origen**, nace `AUTORIZADO`, por el escritor que ya existe | ADR-127 §2 y §5 |
| R6 | **Origen elegible:** cualquier sucursal menos las camionetas y la propia | `origenElegido()` de `[PQ.139]` |
| R7 | **Lo que ninguna sucursal tiene → Compras, «ruta por confirmar».** Ese carril espera `[AB.NI.11]` de Edgar: hasta entonces se queda en el borrador con su motivo y **no se manda** | `[AB.NI.10]`: una ruta `proposed` no es enviable |
| R8 | **Las reglas de unidad de Pedido de Compras, reusadas, para que Kepler no rechace.** (a) Se captura en las unidades de Kepler del producto (caja, paquete, pieza, kilo), **sólo en números enteros**. Una presentación cuyo factor no da unidades base enteras (el bulto de 19.75 PAQ de `[COT.45]`) no se ofrece. (b) Lo que se propone sale con la regla de media caja: media caja o más → cajas cerradas; menos → la unidad inmediata menor (`redondearPedido`, la misma regla que `roundSeed` de Pedido). (c) El candado de Pedido antes de escribir: ni cajas enteras ni piezas enteras → no pasa (`renglonesSinUnidadEntera`, `[PQ.17]`). (d) **Lo que el traspaso exige además** (`[PQ.19]` D24): Kepler lo escribe en unidad base, y el factor de caja de la Suite del almacén que pide tiene que ser el de la ficha del origen. **Un solo renglón que no cuadre hace que Kepler rechace el documento entero.** Pedido sólo se entera al empujar; aquí se revisa **al capturar**: el renglón dice «Kepler lo rechazaría» con el motivo y no entra al envío, para no tumbar a los demás | Pedido de Compras; `kepler-requisition-sink.adapter.ts` (las tres revisiones del traspaso). Medido el 2026-11-26 (prod, sólo lectura, por SKU distinto y sólo productos vivos): de **1,193 SKU** que Morelia Madero pidió a Morelia Abastos en 30 días, **1,192 (99.9 %)** pasan; **1** no: el 99948, cuya ficha en Abastos no da factor de caja. ⚠️ **Corrige la primera medición** del mismo día («1,153 de 1,156; 2 sin factor de la Suite: 09049 y 00213»): unía `catalog.products` sin excluir los dados de baja, y esos dos SKU tienen un gemelo borrado el 10-jul sin factor. Sus productos vivos sí lo tienen (50 y 1) y pasan |

---

## 5. Decisiones

| # | Pregunta | Con qué se construye | Quién |
|---|---|---|---|
| **D-PM1** | ¿Dentro de Autoabasto o módulo aparte? | **Dentro** (Francisco, 2026-11-26; es lo que pide el §10.4 de Edgar) | Edgar ratifica |
| **D-PM2** | ¿Un traspaso a mano necesita ruta confirmada por Compras? | **No:** el origen de un traspaso lo elige la sucursal (ADR-127 §3). La confirmación queda para lo que va a proveedor | Edgar |
| **D-PM3** | ¿Quién saca el buscador de Cotizaciones a una pieza común? | **Este frente**, que es el primero que lo necesita fuera de Cotizaciones. Con `applySmartSearch` (fase BU) | decidido |
| **D-PM4** | ¿El tope diario de traspasos se separa del de compras? | **Se queda compartido** y se mide en el piloto (`[AB.NI.8]` ya lo arregló para que la compra no se lo coma) | Edgar |
| **D-PM5** | ¿Un producto puede llegar dos veces (sugerido + a mano)? | **No** (R1) | resuelta por diseño |

---

## 6. Capas e items

| Item | Capa | Entrega |
|---|---|---|
| `[AB.PM.1]` | C0 | El renglón a mano en el borrador: se marca cómo nació (`motor` / `mano`), admite productos que el motor no sugiere y **sobrevive al recalcular**. Migración generada, idempotente, sin `NOT NULL` nuevo sin default; recorrer todos los caminos que insertan en la tabla (regla 14) |
| `[AB.PM.2]` | C1 | Primitivos puros en `libs/contracts`: el alcance del renglón (sobre `diasDeCobertura`, con sus estados *medible · sin venta · pasa el tope*), agrupar por origen y mover del sugerido. Spec con los controles de §7 y mutantes vistos en rojo |
| `[AB.PM.3]` | C2 | Buscar (con existencia del origen y la propia, lo que viene y el alcance), guardar el renglón a mano, y **enviar** por el escritor que ya existe. Permiso: `AUTOABASTO_SOLICITAR`, que ya está repartido. Regla 13: probado contra base real con el payload de la pantalla |
| `[AB.PM.4]` | C3 | «Pedir algo a mano» en la mesa (un bloque, sin rehacer lo de Edgar) y la pantalla de captura; el buscador de Cotizaciones como pieza común (D-PM3). Prueba visual en 3 perfiles |
| `[AB.PM.5]` | — | Piloto Morelia Abastos → Morelia Madero, donde el interruptor ya está encendido, y su medición |

---

## 7. Criterios verificables

1. **C0.** Un renglón a mano de un producto que el motor **no** sugiere se guarda y **sigue ahí después
   de recalcular el plan**. Prueba negativa: si el recálculo lo borra, falla. Contra Postgres real.
2. **C1.** Los controles, con datos de hoy de Morelia Madero: 07212 con 8 + 10 que viene + 10 que
   pide → **31 días**; 28022 con 77 + 30 → **47 días, pasa el tope**; 28002 sin venta → **no medible
   (`null`), nunca 0**. Mutantes que tienen que caer: ignorar lo que viene · devolver 0 sin venta ·
   tope con `≥` en vez de `>`.
3. **C2 (regla 13).** Enviar con el payload de la pantalla, contra base real: **un documento por
   origen**; con el interruptor apagado queda guardado con su motivo; un producto que estaba en el
   sugerido y se pidió a mano **sale una vez**.
4. **C3.** `check:pantalla` sin falla nueva; la vista compila; 3 perfiles (escritorio, Fold, celular)
   con 44 px al dedo y sin desplazamiento lateral.
5. **Piloto (la métrica).** De los pedidos de Morelia Abastos a Morelia Madero, **cuántos nacen en
   la Suite**. Hoy: **0 de 125** en 30 días.

---

## 7b. C3 — la pantalla, con los doce pasos de `diseno` §0a (escrito antes de la plantilla, 2026-11-26)

1. **Propósito.** Cerrar el acto de pedir a mano: lo que la sucursal necesita y el sugerido no pidió,
   a la sucursal que ella elige. La frase: **«¿qué le pido a mano a cada sucursal?»**.
2. **Quién entra** (`analytics.ui_usage`, 30 días, sólo lectura): la mesa se abrió **57 veces en 16
   días** por 8 puestos (almacenista, auxiliar de tienda, cajero, compras operaciones, dirección,
   encargado de tienda, prevención auxiliar, superadmin). Escribir, casi nadie: **1 ajuste y 1 envío**,
   los dos de superadmin. **Celular: nadie en 30 días.** Se diseña para escritorio y se sostiene a 390 px.
3. **El estado real:** de 125 pedidos de Morelia Abastos a Morelia Madero en 30 días, **0** nacieron en la
   Suite (§2). La mesa se lee y no se usa para pedir: el cuello es que pedir lo que el motor no sugiere
   obliga a irse a Kepler.
4. **Qué ve (nivel 0).** En la mesa, un bloque «Pedir algo a mano» con lo que lleva el borrador a mano
   (renglones y a quién) y UN botón. En la captura, en este orden: a quién se lo pides → buscar y agregar
   → lo que llevas, por destino, con su alcance → lo que sale y el botón para mandarlo.
5. **Qué no ve.** Precios (en un traspaso no deciden) · costo por renglón (no medido) · el sugerido
   renglón por renglón (se queda en la mesa; el buscador sólo dice «ya va en tu sugerido» con su cantidad)
   · existencia de las otras sucursales (no medida para esta pantalla: se ve sólo la de a quién le pides).
6. **Mapa de desglose.** Existencia propia, la del origen, lo que viene, venta de 30 días y alcance:
   `GET pedido/mano` y `GET pedido/mano/buscar`. El alcance dice su cuenta al pasar el cursor y en la
   ayuda. Lo que ya viene se abre en «Lo que te va a llegar» de la mesa (folio y estatus; R2 a medias).
   El pedido mandado: su folio de Kepler en el resultado y en «Lo que te va a llegar».
7. **Accesibilidad.** Se busca por código, nombre o código de barras, en cualquier orden (el buscador
   de Cotizaciones). Enter agrega, ↑ ↓ eligen, Esc limpia. Cada renglón se cambia sin mouse (cantidad
   con flechas, como la mesa). 44 px al dedo. «Kepler lo rechazaría» y el tope dicen su palabra, no sólo
   un color.
8. **Ligas.** Lo pedido a mano sale del sugerido (R1) y la mesa lo dice. Sale como pedido de sucursal ya
   autorizado en el Kepler del origen y entra a Surtido → Checado → Embarque (ADR-127).
9. **¿Le toca a esta pantalla?** Sí, dentro de Autoabasto (D-PM1). Se abre en lugar de la mesa, como el
   detalle de órdenes de Edgar (`[AB.NI.5]`), sin rehacer su pantalla.
10. **La maqueta** (artifact aprobado el 2026-11-26), con lo que cambia: «Otra sucursal» es una lista de
    todas las que pueden surtir (`GET pedido/mano/origenes`, la misma regla que `origenElegido`); el
    buscador no dice «quién más tiene» (no medido); el grupo de Compras se ve con su motivo y **sin
    botón** (R7, espera `[AB.NI.11]`); lo que viene va como cantidad, sin folio en el renglón.
11. **Criterios.** `check:pantalla` sin falla nueva · la vista compila (`nx build view`) · 44 px en
    táctil · sin desplazamiento lateral a 390 px · prueba visual en los 3 perfiles.
12. **Lo que esta interfaz no puede resolver.** El carril de Compras (`[AB.NI.11]`), cancelar desde la
    Suite (`[PQ.142]`), la existencia de las demás sucursales y el folio de lo que viene en el renglón.

---

## 8. Lo que este anexo no incluye, y lo que se declara

- **Cancelar desde la Suite** (`[PQ.142]`): mientras no exista, un pedido equivocado se cancela en
  Kepler, y la pantalla lo dice.
- **El carril de Compras del pedido a mano** espera a `[AB.NI.11]` (R7).
- **La existencia con la que se pidió** un pedido ya enviado (`[AB.NI.6]`): se declara, no se pinta.
- **El costo por renglón:** no medido para esta pantalla, no se muestra.
- **R2 a medias en C2 (`[AB.PM.3]`):** lo que ya viene llega al renglón como **cantidad en unidad base**
  (la misma cuenta que la mesa: pedido abierto de 7 días + embarcado sin recibir). El **folio y el
  estatus** de ese pedido en el renglón todavía no: se leen en «Lo que te va a llegar» hasta que C3 los
  pida o se agregue la lectura.
- **El buscador lee el catálogo con precio de la sucursal que pide** (`v_label_prices`, más los regalos de
  precio simbólico, como Cotizaciones). Medido el 2026-11-26: cubre los **1,193 de 1,193** SKU que Morelia
  Madero pidió a Morelia Abastos en 30 días (sin los de precio simbólico, 1,187). Un producto que no esté
  en el catálogo de la sucursal que pide no aparece.
- **Pedidos de carga de ruta** (`RD`, `RUTA`): no son abasto entre sucursales (ADR-127).
