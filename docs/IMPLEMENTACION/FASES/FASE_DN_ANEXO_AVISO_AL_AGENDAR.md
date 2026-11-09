# Fase DN · Anexo A — Lo que el cliente pide se captura siempre; el aviso de agotado llega al agendar, con su sustituto

> Anexo de [`FASE_DN_DEMANDA_NEGADA.md`](FASE_DN_DEMANDA_NEGADA.md). Cambia el alcance de **DN.3**
> (preventa vecinal) y agrega **DN.6–DN.15**. Decisión técnica: **ADR-115 (aceptado el 2026-11-07)**,
> que modifica una viñeta de ADR-107. Método: [`METODO_DE_TRABAJO.md`](../../METODO_DE_TRABAJO.md).
> Las decisiones de este anexo se numeran **DA1–DA10** para no confundirlas con las D1–D5 del plan base.

```
OBJETIVO: que todo lo que el cliente de preventa pide quede registrado aunque no haya, y que el
          vendedor tenga, al cerrar el pedido, una oferta de sustituto en lugar de un «no se puede».
MÉTRICA:  renglones capturados sin existencia en su sucursal de surtido que QUEDAN REGISTRADOS
          HOY (2026-11-07): 0 — no hay dónde registrarlos; cuántos bloquea la app: NO MEDIDO.
          Contexto medido (apéndice, misma base): antes del bloqueo entraba sin existencia el 14.2 %
          de los renglones (31 de 218); con el bloqueo, el 0.23 % (2 de 857).
          → META: 100 % de los capturados sin existencia registrados, con su decisión; la fecha la
          compromete el dueño al pasar a 🔨. Se mide por versión de la app (§9 R8).
CAPA TOPE: C3 (app del vendedor y pantalla del surtidor)
ÁREA:      Comercial (preventa) → Compras
DUEÑO:     Francisco (DN, negocio) · David (app del vendedor, MCP)
ESTADO:    🔨 frente 1 (DN.6–DN.8 + DN.11a) — aprobado por Edgar el 2026-11-07 por encima del cupo
           (9 🔨 contra 4) y de la Fase 0; lo comunicó Francisco. El porqué va en la tarjeta del
           Tablero PM: es la base de la asistencia de IA a los usuarios que pide el CTO (sin el
           registro no hay con qué entrenar ni medir el motor de sustitutos). Frentes 2 y 3: ⬜.
```

Medido en `pg-prod` (`system_identifier` 7688376744939610156), **sólo lectura**, usuario nominal,
sábado 2026-11-07 por la noche. **Con verificador adversarial** (otro agente intentó refutar por un
camino independiente; aquí van las cifras corregidas): catálogo y embeddings, sustituciones del
surtidor, tiempo de levantar a surtir, agotado al levantar contra surtido, historial del cliente.
**Medidas una sola vez, sin verificador:** uso de pantallas (`ui_usage`), latencias, cobertura del
canal vecinal (§3), pedidos `U-D-40` de la 05, permisos y costo de la búsqueda de sustitutos. La
métrica de la cabecera sale de la consulta del apéndice. El 47 % de DA3 es de ADR-107 (2026-10-27).
⚠️ Repo público: aquí van conteos y porcentajes; los montos van a la tarjeta del Tablero PM.

---

## 1. En una pantalla

`[MCP.3.16]` (ADR-107, David con su PM) hizo dos cosas. La primera es buena y **se queda**: la
existencia del vendedor dice su verdad en cuatro estados (hay N · agotado · no se maneja aquí · sin
dato). La segunda es la que este anexo cambia: **no deja agregar** un producto agotado o que la
sucursal no maneja. `prod-release` lo incluye desde el 2026-10-28 (5f5cd09c7; hoy prod sirve
aee639d73); la hora en que llegó a los teléfonos no está medida. El bloqueo ocurre **en el
teléfono**, con un aviso que se va solo, antes de llamar al servidor: **no queda registro de que el
cliente lo pidió**, ni de cuánto. Compras no se entera, no compra, y el agotado se repite.

Además, el «agotado» de Kepler **no es un testigo fiable de «no hay»**:

| Hecho medido | Cifra | Qué dice |
|---|---|---|
| Pares producto-sucursal de Kepler con existencia ≤ 0 que son **saldos negativos** (la vista los recorta a 0) | 2,798 de 9,525 (29.4 %) | el saldo no es el anaquel. Es un indicio, no una medición de anaquel |
| Pares-día activos que la foto de cierre daba sin existencia y que **Kepler vendió al día siguiente** | 1,449 de 19,065 (7.6 %); 1,134 (5.9 %) si además cerraron ese día sin existencia. 11 días, sucursales 01–08 | una parte de lo «agotado» sí se vendía |
| Renglones de preventa levantados sin existencia **antes** del bloqueo, ya surtidos | 18 renglones (22 menos 1 promoción y 3 cierres de más de 7 días): los 18 **se marcaron** «completo»; testigo de Kepler de que el producto estaba físicamente en 6, facturado en 3, 1 indicio contrario, el resto sin rastro | muestra chica: la dirección se sostiene, la magnitud no está medida |
| `POST …/lines` de vendedor desde el 29-oct contra errores 4xx | 951 llamadas, **1** error | el bloqueo es del teléfono: el servidor casi nunca ve el intento |

**La propuesta (Francisco y David, 2026-11-07):**
1. El vendedor **captura sin restricción** lo que el cliente pide. Cada producto sigue mostrando su estado.
2. **Al agendar**, una sola hoja: *«Estos productos pueden estar agotados»*, con un sustituto sugerido
   por el sistema para que el vendedor haga la oferta. No hay avisos durante la captura.
3. El **renglón original nunca se pierde**: queda registrado como demanda, con lo que se ofreció y lo que se decidió.
4. Las sugerencias **crecen por pasos**: reglas + lo que el cliente ya compra → similitud por
   significado → modelo entrenado con las decisiones registradas.

## 2. Cómo cambió el pedido

| # | Lo que se pidió | Efecto |
|---|---|---|
| 1 | 2026-10-27, David con su PM (ADR-107): «agregar de una sucursal agotado o no_se_maneja se rechaza» | bloqueo en la app y 409 `SIN_EXISTENCIA` en el servidor |
| 2 | 2026-11-07, un vendedor reporta que no puede capturar un producto en 0 y que así no se genera el histórico de lo negado | origen de este anexo |
| 3 | 2026-11-07, Francisco: *«que al levantar no tenga restricción, y al cerrar el pedido le avise que esos productos pueden estar agotados, que si desea ofrecer otro producto en sustitución»* | aviso al final, no en cada captura |
| 4 | 2026-11-07, David: un aviso en cada captura enseña al vendedor a **dejar de capturar** la necesidad y a sustituir por intuición; se captura todo y al final el sistema le «corrige la plana» con una sugerencia | la hoja única al agendar; la demanda se escribe antes de la oferta |
| 5 | 2026-11-07, Francisco: *«¿si ponemos Machine Learning, con qué lo va sustituyendo?»* | §6 y frente 3 (§8): el modelo es el resultado de registrar decisiones, no el arranque |

**Deroga** de ADR-107 sólo la viñeta del rechazo (ver ADR-115). Los cuatro estados, la vista
canónica y el resolvedor único se quedan.

## 3. El universo y el trabajo (dos números distintos)

- **Universo del canal:** la preventa vecinal es mucho más grande que la app. En 30 días Kepler trae
  3,288 tickets `U-D-10` con vendedor vecinal (878 clientes) contra 272 pedidos `PD-` de la Suite
  (170 clientes): **la app cubre ≈ 8 % de los documentos del canal** (en la 07, 5 contra 1,392).
  Lo que este anexo registra es **lo que pasa por la app**, y la pantalla de Compras lo tiene que
  decir así; no es «el total de la preventa negada».
- **El trabajo:** 293 pedidos `PD-` en 60 días (189 clientes; 288 levantados por `vendedor_ruta`),
  ~1,078 renglones. Con la tasa medida antes del bloqueo (14.2 %), del orden de **uno de cada siete
  renglones** llegaría a la hoja del aviso. Derivado, no medido: se mide con DN.8.

## 4. Lo que creíamos y cayó

| # | Lo que se decía | Lo que midió prod (2026-11-07) |
|---|---|---|
| 1 | «Agotado en Kepler = no hay» | 29.4 % de los ≤ 0 son saldos negativos; 5.9–7.6 % de los «sin existencia» al cierre se vendieron al día siguiente (§1) |
| 2 | «En preventa la mercancía puede llegar antes de entregar» | el hueco entre levantar y surtir es de **horas**: p50 0.9 h y p90 3.3 h contra la hora del ticket de Kepler (`kdm1.c62`), en los 147 de 252 pedidos cuyo ticket cuadra (los otros 105, casi toda la 04 y la 07, sin medir). Desde el 21-oct la entrega por omisión es el mismo día (247 de 254). El argumento que queda es la **calidad del dato**, no el reabasto |
| 3 | «Ya hay un motor de sustitutos probado» (MCP.13, el del surtidor) | existe desde el 06-nov (merge 938caf7bd; hora de despliegue no medida): **0** sustituciones en los 42 surtidos cerrados desde entonces (2 con faltante: de 1 a 3 renglones de oportunidad) y **0** consultas a `…/lines/:lineId/substitutes`. Su calidad **no está medida** |
| 4 | «Hay embeddings para buscar parecidos» | `catalog.products.embedding` es el vector legado de Trade: 205 de 5,686 productos vendibles (3.6 %); sólo lo escribe el alta o edición del planograma y no cambia desde el 2026-05-30. Los vectores vigentes (v2) viven en `pg-rag` y hoy **no se pudieron medir** (no hay acceso de sólo lectura desde este equipo) |
| 5 | «El catálogo trae familia o línea» | `department` y `product_line` al 0 %; la marca es la razón social del proveedor en el 73.1 %; la categoría es otra agrupación de compra. Lo que sí sirve: nombre (100 %), proveedor (97.2 %), unidad de venta, IEPS (eje dulce/botana) |
| 6 | «La preventa vecinal es el pedido `PD-`» (DN §1.3) | es ≈ 8 % de los documentos del canal (§3) |
| 7 | «`commercial.orders` tiene `source='suite'`» (DN §1.3) | esa columna **no existe**; la preventa se reconoce por `code` `PD-`, `requested_delivery_date` y `delivery_type='route'` |
| 8 | «ADR-091 propuesto» (cabecera de DN) | ADR-091 es otro (comisiones y viáticos de logística). Este anexo propone **ADR-115** |
| 9 | «El 409 del servidor dice cuántas veces se bloqueó» | 1 error en 951 llamadas: el bloqueo es del teléfono y no deja rastro (§1) |
| 10 | «El renglón negado puede quedarse en `order_lines` con cantidad 0» | `CHECK quantity > 0` y `quantity <= requested_quantity`, y ~25 lectores suman `quantity`/`line_total` (totales, CFDI, guía, carta porte, analítica): **no cabe ahí** |
| 11 | «El historial del cliente sirve para sugerir» | **sí**: 177 de 189 clientes de preventa tienen clave de Kepler y 168 compraron en 90 días (mediana ≈ 21 productos distintos sin contar su propio pedido cobrado). Con el historial **anterior** al pedido, en el 63.5 % de los renglones el cliente ya compró otro producto del mismo proveedor (la primera lectura daba 72.4 % porque contaba el propio pedido) |
| 12 | «El tracker dice que MCP.3.16 está en 🧪» | `prod-release` lo incluye desde el 2026-10-28. El estado del item es de David: se le avisa, no se corrige aquí |

## 5. Decisiones a firmar

| # | Decisión | Opciones | Recomendación |
|---|---|---|---|
| **DA1** | ¿Qué hace el sustituto con el original? | (a) **condicional**: «si no hay X, lleva Y»; el original se queda en el pedido y el surtidor aplica Y **sólo si X falta** · (b) reemplazo inmediato: X sale del pedido y entra Y | **(a) por omisión**, con «cambiar ya» cuando el cliente lo prefiera. Por el hecho #1 de §4, el «agotado» no es testigo fiable de «no hay»: el reemplazo inmediato podría cambiar producto que sí iba a llegar. Además la elección del vendedor **ya es** la respuesta del cliente (etiqueta para el modelo) y le da al surtidor un sustituto aceptado de antemano |
| **DA2** | ¿Dónde vive el trabajo? | DN (Compras) · MCP (preventa) · los dos | **Anexo de DN** (este doc), con David como co-dueño del cambio en la app y el surtidor. El registro es de Compras; la pantalla es de MCP |
| **DA3** | ¿Agotado y no se maneja se tratan igual? | igual · separados | **Separados**: en el aviso, «agotado» primero y «tu sucursal no lo maneja» aparte, con otro texto; para Compras son decisiones distintas (quiebre contra surtido). En la 01 el 47 % del catálogo es «no se maneja» (ADR-107): tratarlo como quiebre produciría avisos que nadie lee |
| **DA4** | ¿El «sugerido» (canasta predicha) incluye agotados? | sí · no | **No**, como hoy: lo predijo el sistema, no lo pidió el cliente; registrarlo ensuciaría la demanda negada |
| **DA5** | ¿Qué precio ve el vendedor en el sustituto? | de lista (lo que da el motor del surtidor) · el que se cobra (`tarificarConMotor`) | **El que se cobra**, calculado sólo para los primeros N; si no se puede, se rotula «precio de lista» |
| **DA6** | ¿La decisión por renglón es obligatoria para agendar? | obligatoria · opcional | **Obligatoria con un toque**, con «Dejarlo» ya marcado. No se pregunta nada más al cliente |
| **DA7** | Fuente única de «lo que el cliente ya compra» (regla 1) | `analytics.v_kepler_sales_lines` · `erp_sale_tickets` + `erp_sales_invoices` | **`v_kepler_sales_lines`, contando días con compra** (180 d), no cantidades: así no la afectan las refacturas ni la unidad |
| **DA8** | Similitud por significado (embeddings) | backfill del vector legado en `catalog.products` · medir los v2 de `pg-rag` | **Medir primero los v2** (DN.13). El legado sólo lo escribe el planograma y no cambia desde mayo. Requiere un acceso de sólo lectura a `pg-rag`: lo da Edgar (credenciales) |
| **DA9** | Al corregir un pedido ya agendado | volver a preguntar todo · sólo lo nuevo | **Sólo lo nuevo o lo que cambió de estado** (lo sostiene la llave de DN.6) |
| **DA10** | Prioridad frente a DN.1 | esperar cupo · adelantar el frente 1 | Por la tabla de §3.1 del método este anexo completo es prioridad **3–4** (dinero derivado, esfuerzo L): **DN.1 va antes**. El **frente 1** (DN.6–DN.8 + DN.11a) es el pedazo S/M que se lleva el valor. Abrirlo sin rebasar el cupo exige llevar a ✅ o ⏸️ una de las 9 🔨 (la elige el PM); si se abre por encima del cupo y de la Fase 0, se escribe por qué en la tarjeta y se agrega la fila DN al roadmap de `CLAUDE.md` |

## 6. Qué NO incluye

- **DN.1** (vista de Kepler para telemarketing y traspasos) ni la pantalla de Compras completa: este
  anexo sólo alimenta la parte de preventa de la app (**DN.3** redefinido).
- **Entrenar un modelo.** Se registra desde el día uno lo que hace falta para entrenarlo; el modelo
  es DN.14, con condición de arranque medida.
- **Backfill de embeddings** ni escritura en `pg-rag`.
- **Portal B2B, televenta y entrega a domicilio** (`home_delivery`): hoy no se les bloquea y su
  demanda en agotado tampoco se registra; es otro anexo. El asistente (Thot) coloca sin fecha de
  entrega: si se registra, va **declarado aparte**, no mezclado con la preventa.
- **Lo que el vendedor quita con el bote antes de agendar** (fuera de la hoja): se entiende como
  «el cliente cambió de opinión» y no se registra. **NO MEDIDO por diseño** (§9 R6).
- **H1** (preventa, control de un pedido ya surtido): ver Tablero PM. Es de MCP; se le pasa a David.
- **Corregir el estado de MCP.3.16 en el tracker** (🧪 → 🚀): es de David.

## 7. El orden

| Orden | Frente | Items | Por qué va ahí |
|---|---|---|---|
| 1 | **Captura libre y registro en el servidor** | DN.6, DN.7, DN.8, DN.11a | el pedazo S/M que se lleva el valor: la app deja de bloquear (DN.11a), lo que llega se guarda (DN.7) y el servidor registra todo lo agotado como `sin_aviso` (DN.8). Sin DN.11a no hay nada que registrar: el bloqueo vive en el teléfono |
| 1b | **Compras lo lee** | DN.3 | arranca en cuanto DN.6 tiene filas |
| 2 | **La hoja del aviso con sustituto condicional** | DN.9, DN.10, DN.10b, DN.11, DN.15 | la oferta al cerrar (pedidos 3 y 4); usa el motor tal como está, rotulado como no medido |
| 3 | **El motor aprende** | DN.12, DN.13, DN.14 | señal del cliente, evaluación fuera de línea, similitud; el modelo, sólo con datos. Se detallan cuando el frente 2 tenga árbitro |

## 8. Las capas

### C0 · Dato

- [ ] **[DN.6]** 🔨 **Un renglón pedido sin existencia queda registrado aunque nadie lo decida** — 2026-11-07.
  **Para:** gerente_compras, compras (leen); vendedor_ruta (lo genera) · **Por qué:** es la métrica de este anexo.
  **Capa:** C0 · **Depende de:** ADR-115 firmado (✅ 2026-11-07).
  **Hecho (2026-11-07):** migración `20261107175004_dn6_order_stock_notices.js` (generada; RLS habilitado
  y forzado; GRANT sin DELETE más `REVOKE DELETE, TRUNCATE`, porque el privilegio por omisión de
  `commercial` da arwd; compuertas que leen RLS y privilegios y abortan; `down()` se niega con filas).
  Prueba contra base real escrita y registrada: `database/tests/test-newdb-dn-registro-negado.js`
  (CHECKs 23514, llave vigente 23505, RLS con `app_runtime`). ⚠️ **Contra base: NO MEDIDA en local**
  (no hay Postgres local encendido); la corre el job `pruebas-db` del CI, que es informativo.
  **Cambio contra el plan:** las filas `con_existencia` **se guardan** (no se borran): son el
  denominador de la métrica por versión de la app. «0 filas» se lee «0 filas de demanda negada».
  Tabla propia `commercial.order_stock_notices` (dato capturado en la Suite: legítima; **no** es copia
  de nada): `tenant_id` UUID NOT NULL + audit · `context` (`vendedor` | `surtidor`) · **copia del
  original** (`product_id` del legado, cantidad en base, `qty_unit`, `qty_factor`, precio de
  referencia) · `stock_state` (incluye `pendiente`, ver DN.8) + `stock_qty` + `stock_checked_at` ·
  `candidates` jsonb (rango, puntaje, señales, `engine` y versión, `shown_n`) · `decision` (`dejar` |
  `condicional` | `cambiar_ya` | `otra_sucursal` | `quitar` | `sin_aviso` |
  `condicional_no_aplicable`) · sustituto o sucursal elegidos (producto, cantidad, unidad, renglón
  creado) · `decided_by/at` · `superseded_at`.
  **Llave** (única sobre las filas vigentes, `superseded_at IS NULL`): ~~`root_order_id` +
  `product_id` + sucursal~~ → **`order_id` (el pedido en el que queda el renglón después de separar) +
  `product_id` + sucursal de surtido efectiva** (`COALESCE(source_warehouse_id, warehouse_id)`).
  Corregido el 2026-11-07 por la revisión adversarial: con la raíz, reabrir una PARTE y reagendarla
  (`separarPorSucursal` le cambia `group_id`) dejaba la misma demanda vigente dos veces, y dos partes
  del grupo con el mismo producto y sucursal se pisaban la cantidad. `root_order_id` se queda como
  dato para agrupar (DN.3), conservando la de las filas anteriores del pedido. Reagendar marca
  `superseded_at` en la vigente de la misma llave y en la de un renglón que cambió de sucursal (mismo
  `order_line_id`), e inserta otra: nunca deja dos vigentes. Migración **generada** (`node scripts/nueva-migracion.js`),
  idempotente, con RLS; en prod **una por una**.
  **Criterios:**
  - Dado un pedido agendado con 3 renglones, uno agotado en su sucursal de surtido, entonces hay 3 filas
    vigentes y 1 de demanda negada (`agotado`), con la cantidad en base **y** en su presentación (no se
    suman PAQ con CJA).
  - Dado un pedido agendado sin renglones agotados, entonces 0 filas de demanda negada (sus filas
    quedan `con_existencia`: el denominador).
  - Dado un renglón que después se borra (`removeLine`, `replaceLines`), entonces su fila sigue con la copia del original.
  - Dado `separarPorSucursal`, reabrir y reagendar (también una PARTE), o la reposición de la caja
    (renglón con id nuevo), entonces sigue habiendo **1** fila vigente por renglón (no se cuenta doble)
    y todas conservan la raíz original del grupo.
  - Dado un renglón sincronizado sin conexión (llega con `qty_unit` null), entonces se guarda null y
    se declara «sin presentación (sin conexión)»; nunca se rellena con la base.
  - Dado `sin_dato`, entonces **no** se registra como agotado (ADR-056); se guarda el estado tal cual.
  - ❌ Dado un `INSERT` sin `tenant_id` o con otro tenant, entonces lo rechaza RLS.
  **Verificado contra:** los renglones del pedido + `analytics.v_erp_stock_on_hand` del mismo momento.
  **¿Escribe?** sí → prueba contra base real.
  **No incluye:** la lectura para Compras (DN.3).

### C1 · Dominio

- [ ] **[DN.7]** 🔨 **El servidor ya no rechaza agregar por existencia: guarda el renglón y devuelve su estado** — 2026-11-07.
  **Para:** vendedor_ruta, promotor_ruta · **Capa:** C1 · **Depende de:** DN.6.
  **Hecho (2026-11-07):** `bloqueosAlAgregar` → `revisionDeRenglones` (todos los estados, con
  `insuficiente`); `addLine`/`updateLine` responden `stock_state` + `stock_review`
  (`LineStockReview` en `libs/contracts`); la revisión va en SAVEPOINT y, si truena, el renglón se
  guarda con `sin_dato`. El texto cambia a «Puede estar agotado en LPA · PH tiene 14» (`mensajeExistencia`):
  «No se puede agregar» sería falso. **Pruebas:** `commercial-orders.stock-review.spec.ts` (antes
  `…stock-block.spec.ts`, 21 casos); negativa rota a propósito: con el `throw` de vuelta, 9 en rojo.
  `stock-state.spec.ts` de contracts **sí cambió** (el texto y `sinExistenciaAfirmada`), contra lo que
  decía el criterio. §[4] de `test-newdb-existencia-vendedor.js` invertido: escrito, NO MEDIDO en local.
  Quitar el 409 `SIN_EXISTENCIA` de `addLine` y de `updateLine` (`commercial-orders.service.ts`); el
  estado viaja en la respuesta. `bloqueosAlAgregar` se generaliza a una revisión que devuelve **todos**
  los estados (incluidos `sin_dato` e «insuficiente»), sobre el mismo `estadoDeProductos`. Las
  promociones y los legados con gemelo se tratan igual que hoy.
  **Criterios:**
  - Dado un producto agotado en la sucursal de surtido, cuando el vendedor lo agrega, entonces 201 con `stock_state: 'agotado'` (antes: 409).
  - Dado `sin_dato`, entonces 201 con `stock_state: 'sin_dato'`, nunca «con existencia».
  - ❌ Ningún rol recibe ya el 409 `SIN_EXISTENCIA` (prueba negativa: volver a poner el throw pone la prueba en rojo).
  - Se invierten las afirmaciones del 409 en `commercial-orders.stock-block.spec.ts` y
    `database/tests/test-newdb-existencia-vendedor.js` §[4]; `stock-state.spec.ts` no cambia (los cuatro estados se quedan).
  - ⚠️ **Sale ANTES que la app** (la app del vendedor es una PWA en caché).
  **No incluye:** registrar (DN.8).

- [ ] **[DN.8]** 🔨 **Al agendar, el servidor registra todo renglón sin existencia que nadie decidió** — 2026-11-07.
  **Para:** compras · **Capa:** C1 · **Depende de:** DN.6, DN.7.
  **Hecho (2026-11-07):** `libs/commercial/src/lib/commercial-orders/order-stock-notices.ts`
  (`marcarAlAgendar` en SAVEPOINT dentro de `place()`, `completarRegistro` después del commit sin
  esperar, `declararPendientesViejas`) y `OrderStockNoticesCronService` (cada 5 min, sólo en el
  worker, latido `dn_registro_barrido` con su fila en `CRON_JOBS`). La app manda `client_build` en
  `place` (en línea y sincronizado) y Thot el suyo (`vendor-thot`). **Pruebas:**
  `commercial-orders.registro-negado.spec.ts` (17 casos: el filtro con el payload de la
  sincronización, cada exclusión con su control —los admins CON la clave, para que los saque
  `isPlatformAdminRole` y no la falta de clave—, la raíz de una parte reabierta, y que ni el paso 1 ni
  el 2 tumban el agendado) y `order-stock-notices.spec.ts` (10: la llave por pedido, la presentación y
  la consulta del barrido); negativas rotas a propósito: registro apagado → 5 en rojo; sin la
  exclusión de admins → 3. El SQL de la consulta de renglones corrió en prod en sólo lectura
  (124 renglones de 20 pedidos). ⚠️ **Contra base real: escrita** (`test-newdb-dn-registro-negado.js`),
  **NO MEDIDA en local**. Latencia del paso 2 en prod: NO MEDIDA (va fuera de la respuesta).
  **Filtro:** pedidos de la app del vendedor (`esTomaDelVendedor`) de preventa (`requested_delivery_date`,
  `delivery_type='route'`), incluida la sincronización sin conexión. La entrega a domicilio queda
  fuera; el asistente, declarado aparte.
  **Durable en dos pasos:** (1) **dentro** de la transacción de `place()`, en un `SAVEPOINT`, una marca
  barata por renglón (copia del original con `stock_state='pendiente'`, sin leer existencia: ms);
  (2) **después del commit**, otra transacción lee la existencia de la raíz del grupo y sus partes y
  completa las filas (la revisión cuesta ~0.4–1.5 s según el pedido: fuera del `FOR UPDATE`; hoy
  `place` tarda 44 ms en promedio). Un barrido periódico pasa a `sin_dato` toda `pendiente` con más
  de N minutos: el hueco queda **declarado** aunque el paso 2 muera. El registro **no puede hacer
  fallar el `place`**: en la sincronización sin conexión un 4xx gasta intentos hasta dejar el pedido «muerto».
  **Criterios:**
  - Dado un pedido agendado desde el teléfono sin conexión con 1 renglón agotado, entonces su fila queda `agotado` · `sin_aviso` (todas las filas del frente 1 son `sin_aviso`: nadie vio un aviso).
  - Dado un pedido sin renglones agotados, entonces todas sus marcas `pendiente` terminan en «con existencia» (nada se borra: no hay DELETE): 0 filas de demanda negada.
  - Dado que el paso 2 falla, entonces el pedido quedó agendado y sus filas pasan a `sin_dato` en el barrido, nunca a 0.
  - Dado un pedido de entrega a domicilio, entonces 0 filas.
  - Prueba negativa: se apaga el registro a propósito y la prueba se pone roja.
  **Verificado contra:** la consulta del apéndice, antes y después, por versión de la app.
  **¿Escribe?** sí → prueba contra base real con el payload de la sincronización.

- [ ] **[DN.9]** ⬜ **Un solo motor de sustitutos para el surtidor y el vendedor** — 2026-11-07.
  **Capa:** C1 · **Depende de:** —.
  ADR-056 (regla 16): el segundo consumidor sube el primitivo. `presale-substitute.engine.ts` y la
  búsqueda de `PresalePickingService.substitutes()` pasan a `libs/commercial/src/lib/product-substitutes/`
  (`SubstituteFinderService`, que depende de `QuotePricingService` y no de `CommercialOrdersService`,
  para no formar un ciclo de módulos). El surtidor delega **sin cambiar su salida**. Para el vendedor,
  por parámetro: existencia y precio en la **sucursal de surtido del renglón** (hoy, en la del pedido)
  y existencia leída de una ventana ordenada por puntaje, rellenando hasta N (hoy se lee de los 150
  candidatos: medido 2.6–2.7 s con un renglón, TAKIS, en la 01). El surtidor sigue leyendo los 150.
  **Criterios:**
  - `test-newdb-sustituto-surtido.js` sigue en verde con la misma salida para el surtidor.
  - Cambia la inyección de Nest: se prueba `design:paramtypes` o se declara «arranque no verificado» (caso #414).
  - Las consultas del motor para un pedido de 7 renglones (candidatos + existencia de la ventana),
    corridas en sólo lectura, suman < 1.5 s (p90 de 20 pedidos reales). Desplegado: p90 de
    `stock-review` en `ui_usage` < 1.5 s a 7 días de soltar. ⛔ Nunca la laptop contra prod.

### C2 · API

- [ ] **[DN.10]** ⬜ **El vendedor pide la revisión de su pedido y deja su decisión por renglón** — 2026-11-07.
  **Para:** vendedor_ruta, promotor_ruta, supervisor_ventas · **Capa:** C2 · **Depende de:** DN.6, DN.9.
  `POST commercial/orders/:id/stock-review` (estado fresco por renglón en su sucursal de surtido,
  alternativas de la zona y hasta N sustitutos; **registra lo mostrado** en filas vigentes, que no
  cuentan para Compras hasta que el pedido se agenda) y
  `PATCH commercial/orders/:id/stock-notices/:noticeId` (la decisión). `cambiar_ya`, `quitar` y
  `otra_sucursal` aplican el cambio en la **misma** transacción con variantes internas que reciben
  `trx` (hoy `addLine`, `removeLine` y `updateLine` abren cada uno la suya y toman el `FOR UPDATE`:
  llamarlos desde dentro se bloquearía a sí mismo). `otra_sucursal` usa la validación de origen de
  `updateLine` (contra la zona) y conserva en la llave la sucursal original. Tipos en `libs/contracts` (`lint:boundary`).
  **Permiso:** `VENDOR_APP_ACCESS` **y** `COMMERCIAL_ORDERS_CREAR` **y** ser el dueño del pedido
  (o supervisor). Medido: con sólo la primera entraría `repartidor`; con sólo la segunda, `customer_b2b`.
  Las dos ya están repartidas en prod a los roles de vendedor (regla 20: nada nuevo que repartir).
  **Criterios:**
  - Dado un pedido de 5 renglones con 2 agotados, entonces responde 2 renglones con su estado y hasta N sustitutos cada uno.
  - Dado un pedido sin renglones agotados, entonces responde lista vacía y no registra nada.
  - Dado que la existencia no se pudo leer, entonces responde el renglón con `sin_dato` (distinto de lista vacía).
  - Dado el mismo Y elegido como condicional para dos renglones, o un Y que ya viene en el pedido, entonces 400 con texto claro.
  - Dado `quitar` sobre el único renglón, entonces 409 «se cancela el pedido, no se agenda vacío».
  - ❌ Dado `repartidor` o `customer_b2b`, entonces 403; dado otro vendedor que no es el dueño, entonces 403/404.
  - Dado el mismo agendado enviado dos veces, entonces no se duplican filas (llave de DN.6).
  **¿Escribe?** sí → prueba contra base real con el payload de la pantalla.

- [ ] **[DN.10b]** ⬜ **El surtidor aplica el sustituto que el cliente aceptó** — 2026-11-07.
  **Para:** surtidor, almacenista · **Capa:** C2 · **Depende de:** DN.6, DN.10.
  En el cierre del surtido de preventa (`warehouse/presale-picking`, con `COMMERCIAL_PICKING_GESTIONAR`,
  ya repartida): el campo `substitute` que ya existe se precarga con el condicional; se escribe la
  línea sustituta y la fila `context='surtidor'` en la misma transacción. El campo nuevo de la línea
  va en `libs/contracts` (`presale-picking.contract.ts`).
  **Criterios:**
  - Dado X presente, entonces se surte X y no hay fila nueva.
  - Dado X faltante, entonces se aplica Y y queda 1 fila `context='surtidor'`.
  - Dado X faltante en parte, entonces la cantidad de Y se ajusta en proporción y el surtidor la confirma.
  - Dado Y agotado al surtir o que no pasa la validación del cierre, entonces el cierre **no** se cae: se muestra la búsqueda normal y la fila queda `condicional_no_aplicable`.
  - ❌ Dado `vendedor_ruta`, entonces 403.
  **¿Escribe?** sí → prueba contra base real con el payload de la pantalla de surtido.

### C3 · UI

- [ ] **[DN.11a]** 🧪 **La app del vendedor deja de bloquear: el producto se agrega y conserva su estado** — 2026-11-07.
  **Para:** vendedor_ruta, promotor_ruta · **Capa:** C3 · **Depende de:** DN.7 en prod. **Frente 1.**
  **Hecho (2026-11-07):** sin compuertas en `createLine` ni `elegirOrigen` y sin lectura del 409;
  `bloqueoDe` → `sinExistenciaEn` (booleano: lo usan el sugerido y el aviso de «Pocas existencias», que
  calla con un agotado o en 0; sin conexión también, con la copia guardada de menos de 6 h); `avisoOrigen` pasa de orden a opción («puedes surtir de otra sucursal»). La app
  manda `client_build` (`apps/vendor/src/app/core/client-build.ts`). **Pruebas:**
  `vendor-estado-existencia.spec.ts` (45, con el sugerido sin conexión y su aviso) y toda la app (25
  suites, 210); negativas rotas a propósito: con la compuerta de vuelta, 8 en rojo; con el corte sin
  conexión, 1; sin el aviso del sugerido sin conexión, 1. ⚠️ `check:pantalla` **no recorre `apps/vendor`** (sólo
  `apps/view`): NO MEDIDO por la compuerta, y **sin validación visual**.
  **Las cinco preguntas (skill `diseno` §0b), por escrito:** (1) qué ve y en qué orden: lo mismo que
  hoy, el catálogo con el estado de cada producto; cambia que «+» en un agotado lo agrega y la fila
  sigue roja. (2) Qué no ve: ningún aviso emergente por existencia («No se puede agregar», «Hoy hay
  0»), porque empujaba a sustituir durante la captura. (3) Accesibilidad: el estado es texto en la
  fila, no sólo color; `avisoOrigen` es `role="status"` en la fila, sin clic. (4) Ligado a otro
  proceso: sí, lo agotado lo registra el servidor al agendar (DN.8) para Compras (DN.3). (5) ¿Le toca a
  esta pantalla?: sí; la hoja con sustitutos es DN.11, frente 2.
  En `vendor-take-order.component.ts`: se quitan las compuertas de `createLine` y `elegirOrigen` y la
  lectura del 409; el **sugerido sigue excluyendo** agotados (DA4). El estado de cada producto se
  queda (rojo «Sin existencias», gris «no se maneja»). Sin hoja: lo agotado lo registra el servidor
  como `sin_aviso` (DN.8).
  **Criterios:**
  - Dado un producto agotado, cuando el vendedor toca «+», entonces se agrega sin aviso emergente y la fila sigue en rojo.
  - Dado elegir en la tira una sucursal de la zona en 0, entonces se permite y `avisoOrigen` lo dice.
  - Las pruebas de `vendor-estado-existencia.spec.ts` que afirman el bloqueo se reescriben como «se agrega y se ve el estado», con su negativa.
  - Compuertas que SÍ recorren `apps/vendor` (tokens, motion, teclado, tablas, búsqueda, cifra, voseo) sin fallas nuevas. ⚠️ `check:pantalla` sólo recorre `apps/view`: para esta app se declara NO MEDIDO.

- [ ] **[DN.11]** ⬜ **Al agendar, el vendedor ve una sola hoja con lo que puede estar agotado y qué ofrecer** — 2026-11-07.
  **Para:** vendedor_ruta, promotor_ruta · **Capa:** C3 · **Depende de:** DN.10, DN.11a.
  En `submit()`, antes de `askAndPlace()`, la revisión del servidor; con agotados, la hoja «Pueden
  estar agotados»: por renglón, estado y sucursal, «Surtir de PH» si otra de la zona lo tiene
  (`otra_sucursal`), hasta N sustitutos con su precio, «Si no hay, lleva…» (condicional), «Cambiar
  ya», «Quitar», y **«Dejarlo» ya marcado**. Agotado y no se maneja, separados (DA3).
  **Antes de escribirla:** `auditoria-diseno` §9 al final de este anexo (sus 🔴 se vuelven items) y
  skill `diseno` §0b (las cinco preguntas por escrito).
  **Criterios:**
  - Dado un pedido con 2 agotados, cuando toca «Agendar», entonces aparece la hoja y el pedido **no** se agenda hasta continuar.
  - Dado un pedido sin agotados, entonces se agenda directo, sin hoja.
  - Dado que la revisión no responde en 2.5 s o falla, entonces se agenda igual y se dice «no se pudo revisar existencias».
  - Dado sin conexión, entonces no hay hoja (el servidor registra al sincronizar, DN.8).
  - Dado un pedido corregido, entonces sólo se pregunta lo nuevo o lo que cambió (DA9).
  - Compuertas que SÍ recorren `apps/vendor` (tokens, motion, teclado, tablas, búsqueda, cifra, voseo) sin fallas nuevas. ⚠️ `check:pantalla` sólo recorre `apps/view`: para esta app se declara NO MEDIDO.

- [ ] **[DN.15]** ⬜ **El surtidor ve el sustituto que el cliente ya aceptó y lo aplica con un toque** — 2026-11-07.
  **Para:** surtidor, almacenista · **Capa:** C3 · **Depende de:** DN.10b.
  En la pantalla de surtido de preventa (MCP.13): «el cliente acepta Y si no hay X», precargado y
  editable. Skill `diseno`; `check:pantalla` antes y después.

### Lo que lee Compras

- [ ] **[DN.3]** ⬜ **Compras ve lo negado de la preventa de la app: lo pedido, lo ofrecido y lo que llegó** — 2026-11-07 (redefinido, anexo A; antes «`PD-` contra surtido»).
  **Para:** gerente_compras, compras · **Capa:** C2–C3 · **Depende de:** DN.6 con filas.
  Une, sin doble conteo: `order_stock_notices` (filas vigentes cuyo PEDIDO —`order_id`, no la raíz—
  está confirmado o surtido; agrupadas por `root_order_id`) + lo
  que faltó al surtir (`presale_picks.report`: 13 quitados y 12 recortados en 238 surtidos cerrados)
  + lo que la caja completó. Gana una sola etapa por renglón. `otra_sucursal` cuenta como «surtido de
  otra», no como negado. Declara su cobertura (≈ 8 % del canal vecinal, §3) y que en la 05 la
  preventa también entra a Kepler como `U-D-40` (105 de 141 pedidos en 30 días llevan vendedor
  vecinal): DN.1 y DN.3 no la pueden contar dos veces. **Permiso:** D3 del plan base (con
  `COMPRAS_HALLAZGOS_VER` también entrarían finanzas, tesorería, marketing y encargado_tienda).
  **Criterios:**
  - Dado 30 días de la 01, entonces los renglones negados = filas vigentes de pedidos agendados + quitados al surtir, sin repetir renglón, por producto y en su presentación.
  - Dado un borrador revisado y cancelado, entonces no aparece.
  - Dado un grupo con la raíz cancelada y una parte viva (o al revés), entonces cuenta la parte viva y
    no la cancelada: decide el estado del pedido de cada fila, no el de la raíz.
  - Dado un renglón que entró por el SUGERIDO con existencia «sin dato» y al agendar resultó agotado,
    entonces se declara aparte (§9 R10): el registro no sabe de dónde vino el renglón.
  - Dado un periodo sin filas, entonces «sin demanda negada registrada», distinto de «sin dato».
  - Dado filas `sin_dato` o `pendiente`, entonces se muestran como «sin dato», nunca como 0.
  - ❌ Dado un puesto sin el permiso que firme D3 del plan base, entonces 403.

### Frente 3 — el motor aprende (se detalla cuando el frente 2 tenga árbitro)

- [ ] **[DN.12]** ⬜ **Lo que el cliente ya compra sube en la lista de sustitutos** — 2026-11-07.
  Señal nueva en el motor (`puntuarConSenales`, sin tocar `puntuarSustituto`, para que el surtidor no
  cambie): días con compra en 180 d de `v_kepler_sales_lines` (DA7) por la clave de Kepler del cliente.
  Para los 12 de 189 clientes sin clave y los 9 sin compras en 90 d, sólo reglas, **declarado**.
  Cada sugerencia guarda `engine` y versión.

- [ ] **[DN.13]** ⬜ **La calidad del motor se mide antes de presumirla** — 2026-11-07.
  Evaluación fuera de línea (sólo lectura): (a) los renglones que faltaron al surtir contra lo que el
  cliente compró después: ¿cayó en los primeros 3?; (b) supervisión débil desde Kepler: qué compró el
  cliente **en lugar de** su producto habitual la semana en que estaba agotado (fotos diarias desde
  ~19-oct, o el kardex antes). Sale la cifra base «acierto en los primeros 3» por motor y versión.
  Incluye medir los embeddings v2 de `pg-rag` (DA8) con pares conocidos.

- [ ] **[DN.14]** ⬜ **Modelo entrenado con las decisiones — sólo cuando haya con qué** — 2026-11-07.
  Condición de arranque, medida: suficientes decisiones etiquetadas (condicionales aplicadas o no
  por el surtidor, «cambiar ya», rechazos) y un modelo que **supere a las reglas** en la evaluación
  de DN.13. Con el registro de rango y `shown_n` desde DN.10, para no aprender «lo que se mostró
  primero». Del orden de uno de cada siete renglones llega a la hoja: el volumen tarda meses.

## 9. Riesgos y bloqueos

| # | Bloqueo / riesgo | Dueño | Causa | Qué lo destraba |
|---|---|---|---|---|
| R1 | ~~Cupo excedido (9 🔨 contra 4), Fase 0; DN sin fila en el roadmap~~ **Resuelto 2026-11-07:** Edgar aprobó el frente 1 por encima del cupo; fila DN en el roadmap de `CLAUDE.md`. Falta escribir el porqué en la tarjeta | Edgar | método §3 y §7 | — |
| R2 | ~~ADR-107 es de David y no tiene visto bueno de Edgar~~ **Resuelto 2026-11-07:** ADR-115 aceptado (David acepta el cambio, Edgar aprueba); ADR-107 lo anota en su estado | David + Edgar | decisión ajena | — |
| R3 | `FASE_DN` y la sección DN del tracker sólo viven en el `main` local de Francisco (commit 1f6c35bb4) | Francisco | commit sin empujar | que viajen en el PR de este anexo **sin montos** (barridos a la tarjeta). ⚠️ El commit viejo los conserva en su historia: por eso el PR se arma como UN commit sobre `origin/main` (índice temporal + `commit-tree`, skill `entrega`), **nunca** `push main:`, y antes de empujar se revisa que ningún monto viaje (`git log -p origin/main..<lo que sale> \| grep '\$[0-9]'`) |
| R4 | Acceso de sólo lectura a `pg-rag` | Edgar | credenciales (regla 7) | un usuario de sólo lectura |
| R5 | Falsos positivos que canibalizan la venta | David | §1: el «agotado» no es «no hay» | DA1 (condicional por omisión) + texto «puede estar» |
| R6 | Fatiga del aviso / el vendedor quita con el bote para no ver la hoja | David | hoja larga | DA3, «Dejarlo» marcado. Quitar antes de agendar es **NO MEDIDO por diseño** (§6): se vigila con `ui_usage` de `DELETE …/lines` contra `POST` |
| R7 | Latencia en campo (hoy `POST …/lines` 969 ms promedio, máx 5.7 s; catálogo 5.5 s promedio) | David | red del campo + motor | una sola llamada por pedido, existencia de una ventana, límite de 2.5 s, nunca bloquea |
| R8 | Despliegue en dos tiempos (PWA contra API) | Edgar (suelta) · Francisco (dueño de DN) | la app vive en caché | DN.7 sale primero. **Con la PWA vieja la demanda bloqueada sigue sin registrarse**: DN.8 sólo cubre lo que llega al servidor. La métrica se mide por versión de la app y el hueco de la vieja se declara |
| R9 | Doble conteo con DN.1 en la 05 | Francisco | la preventa también entra como `U-D-40` | regla de una etapa por renglón en DN.3 |
| R10 | Lo que trae el SUGERIDO con existencia «sin dato» (copia de más de 6 h, o lectura caída) y al agendar resulta agotado se registra como demanda negada, aunque DA4 dice que lo predicho no cuenta | Francisco | ni el renglón local, ni el lote (`replaceLines`), ni `place` dicen de dónde vino el renglón | **NO MEDIDO** en el frente 1, declarado; llevar el origen del renglón hasta la fila es trabajo de DN.3/DN.10 (una marca en el renglón o la lista del sugerido en el cuerpo de `place`) |

## 10. Definición de Terminado

- [ ] 1. Métrica remedida con la consulta del apéndice, antes/después y por versión de la app
- [ ] 2. Cada capa verificada **o declarada NO MEDIDA** (ADR-056)
- [ ] 3. `stock-review`, la decisión, el cierre del surtidor y el registro en `place` ejercidos contra base real con el payload de la pantalla y de la sincronización
- [ ] 4. La prueba negativa del registro (DN.8) rota a propósito una vez, rojo verificado
- [ ] 5. El motor de sustitutos vive en `libs/` y lo usan el surtidor y el vendedor
- [x] 6. Tracker + `03_LOG_REVISIONES.md` + roadmap de `CLAUDE.md` + ADR-115 al día y, al firmarse, el estado de ADR-107 dice «viñeta del rechazo modificada por ADR-115» (frente 1, 2026-11-07)
- [ ] 7. **En prod**, o escrito por qué no y qué falta

## 11. Bitácora

- **2026-11-07** — Anexo escrito a partir del reporte de un vendedor. Cinco mediciones en prod (sólo
  lectura), cada una con verificador adversarial: catálogo y embeddings (no refutada), sustituciones
  del surtidor (no refutada), tiempo levantar→surtir (no refutada), agotado al levantar contra
  surtido (no refutada en la dirección; «se surtió» corregido a «se marcó surtido»), historial del
  cliente (refutada sólo en la «prueba de uso»: 72.4 % → 63.5 % con el historial previo al pedido,
  62.1 % sin eco). Un crítico de completitud aportó el sustituto condicional (DA1), el permiso doble
  (DN.10), el doble conteo con DN.1 y la cobertura del canal (§3).
- **2026-11-07** — Revisión adversarial del anexo en tres lentes (fidelidad, método y repo público,
  factibilidad contra el código): el frente 1 no registraba nada sin quitar el bloqueo del teléfono
  (→ DN.11a); la llave se rompía con `separarPorSucursal` y al reagendar (→ raíz del grupo, filas
  vigentes); el registro después del commit no era durable (→ marca en `SAVEPOINT` + barrido);
  faltaban el C2 del surtidor (→ DN.10b), la decisión `otra_sucursal` y los criterios de los cinco
  caminos; la métrica mezclaba bases (→ apéndice con una sola base: 14.2 % → 0.23 %).
- **2026-11-07** — Edgar aprueba el frente 1 por encima del cupo y David acepta el cambio a ADR-107
  (los comunica Francisco): ADR-115 aceptado; fila DN en el roadmap. **Frente 1 en código** (DN.6,
  DN.7, DN.8, DN.11a), con pruebas unitarias y una negativa rota a propósito por item (9, 5 y 8
  pruebas en rojo con el bloqueo o el registro de vuelta; todo restaurado). Cinco lectores en
  paralelo mapearon el código antes de escribirlo; de ahí salieron tres correcciones a la migración
  (`REVOKE DELETE` por el privilegio por omisión del esquema, compuertas que leen RLS y privilegios,
  `down()` que se niega con filas) y dos al registro (el filtro de preventa se evalúa DESPUÉS de que
  `place` aplica la fecha que trae la sincronización, y el barrido late con `latirCron` sólo en el
  worker). Cambios contra el plan: las filas `con_existencia` se guardan (denominador por versión de
  la app, `client_build`); el texto pasa a «Puede estar agotado» y cambió `stock-state.spec.ts` de
  contracts. **Pendiente:** las dos pruebas contra base real están escritas y registradas, pero NO
  MEDIDAS en local (no hay Postgres local encendido); la migración se aplica en prod antes del código,
  y DN.7 sale antes que la app (R8).
- **2026-11-07** — **Revisión adversarial del código, dos rondas** (22 hallazgos en la primera, 9
  verificados y 8 reales; 15 en la segunda sobre los arreglos, 5 verificados y 3 reales). Lo que
  cambió por ellas: (1) **la llave pasa de la raíz del grupo al PEDIDO**: reabrir una PARTE y
  reagendarla le cambia `group_id` en `separarPorSucursal` y la demanda quedaba vigente dos veces, y
  dos partes con el mismo producto se pisaban la cantidad; la raíz se conserva como dato (la de las
  filas anteriores, o la de antes de separar). (2) **El sugerido sin conexión** cargaba lo agotado y el
  servidor lo registraba como negado (DA4): ahora usa la copia guardada con su frescura, avisa qué
  dejó fuera, y el texto de «sin señal» dice lo que de verdad hace. (3) **Pruebas que no podían
  fallar**: los admins se prueban CON la clave; el umbral del barrido con marcas de 5 y 20 min; el
  NO MEDIDO de [4] sólo ante la tabla faltante; cada rama del reemplazo al reagendar con su caso
  ([6b] por renglón, [6c] por llave) y el par que distingue la llave por pedido de la vieja. (4) DN.7
  baja a 🔨: cambia lo que escriben dos endpoints y eso no ha corrido contra base (regla 13). (5) Una
  fila DECIDIDA en el borrador (frente 2) ya no se duplica cuando el renglón pasa a una parte. Quedó
  declarado: R10 (el sugerido con «sin dato» que resulta agotado).

## Apéndice — Consultas del HOY

Sólo lectura contra `pg-prod`, verificando antes `system_identifier` y `transaction_read_only = on`.

**Métrica** (renglones vivos de `PD-` que entraron sin existencia en su sucursal de surtido, según la
foto de cierre del día anterior; sin promociones ni legados sin gemelo). Medido 2026-11-07:
antes del bloqueo 31 de 218 (14.2 %; 101 renglones sin foto, de antes del ~19-oct) · 28–29 oct 3 de
96 · desde el 30-oct 2 de 857 (0.23 %).

```sql
WITH ln AS (
  SELECT l.id, coalesce(l.source_warehouse_id, o.warehouse_id) AS src_wh, l.created_at,
         (l.created_at AT TIME ZONE 'America/Mexico_City')::date AS dia,
         coalesce(tw.id, p.id) AS efectivo,
         (p.sku IS NULL AND tw.id IS NULL) AS no_medible,
         (coalesce(p.nombre, '') ~* '=\s*GRATIS\y') AS es_promo
    FROM commercial.orders o
    JOIN commercial.order_lines l ON l.order_id = o.id
    LEFT JOIN catalog.products p ON p.id = l.product_id
    LEFT JOIN catalog.products tw ON p.sku IS NULL AND tw.tenant_id = p.tenant_id AND tw.sku = btrim(p.articulo)
                                 AND tw.deleted_at IS NULL AND tw.id <> p.id
   WHERE o.code LIKE 'PD-%' AND o.deleted_at IS NULL
),
m AS (
  SELECT ln.*,
         EXISTS (SELECT 1 FROM analytics.stock_snapshot_coverage c
                  WHERE c.warehouse_id = ln.src_wh AND c.fecha_corte = ln.dia - 1) AS con_foto,
         NOT EXISTS (SELECT 1 FROM analytics.stock_snapshots s
                      WHERE s.warehouse_id = ln.src_wh AND s.product_id = ln.efectivo
                        AND s.fecha_corte = ln.dia - 1 AND s.unidades > 0) AS sin_exist
    FROM ln
   WHERE NOT ln.no_medible AND NOT ln.es_promo
)
SELECT CASE WHEN created_at < '2026-10-28 00:00-06' THEN '1 antes del bloqueo'
            WHEN created_at < '2026-10-30 00:00-06' THEN '2 transición (28-29 oct)'
            ELSE '3 con bloqueo (desde 30 oct)' END AS ventana,
       count(*) FILTER (WHERE con_foto) AS renglones_con_foto,
       count(*) FILTER (WHERE con_foto AND sin_exist) AS sin_existencia,
       round(100.0 * count(*) FILTER (WHERE con_foto AND sin_exist)
             / nullif(count(*) FILTER (WHERE con_foto), 0), 2) AS pct,
       count(*) FILTER (WHERE NOT con_foto) AS sin_foto
  FROM m GROUP BY 1 ORDER BY 1;
```

Después de DN.6, la métrica se completa con: filas vigentes de `order_stock_notices` de pedidos
agendados entre los renglones que esta misma consulta marca sin existencia (meta: todos).

**El bloqueo no llega al servidor** (llamadas de vendedor y errores 4xx):

```sql
SELECT metodo, ruta, sum(hits) AS llamadas, sum(errores_4xx) AS e4xx
  FROM analytics.ui_usage
 WHERE fecha >= date '2026-10-29' AND role_name = 'vendedor_ruta' AND ruta ILIKE '%/lines%'
 GROUP BY 1, 2;
```
