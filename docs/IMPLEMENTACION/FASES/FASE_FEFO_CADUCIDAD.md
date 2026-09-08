# Fase P2 — Caducidad / lote / FEFO

> **Estado: 🟢 MVP de caducidad/FEFO COMPLETO — P2 PAUSADO 2026-06-18** (P2.4/P2.5 diferidos por decisión del usuario; el core ya entrega valor). Entregado: `commercial.stock_lots` + **trigger del invariante** con FEFO-decrement **no-vencido-primero** + **captura lote/caducidad** en recepción + endpoints `GET .../lots` y `GET .../expiring` + **cron de alerta `expiring_lots`** + **aviso `sold_expired`** (warn, NO bloquea) + **dashboard "Por vencer"** (`/comercial/inventory/expiring`) + **trazabilidad por lote** (`commercial.stock_lot_movements` + `GET .../lot-movements`). **Verificado LIVE:** smoke I.5 26/26 + alerts WS 25/25 (P2.3 → 26/26 tras 1 reinicio) + trigger expired-last (script FEFO + J.6.1 19/0). Decisión en [ADR-022](../02_DECISIONES_ARQUITECTURA.md). **Pendiente menor:** QA visual de P2.2c + 1 reinicio para verde live de P2.3. **Diferido:** P2.4 (conteo por lote), P2.5 (caducidad en vendedor/portal).

Digitaliza el control de **caducidad** para Mega Dulces (distribuidora de dulces): no vender producto vencido, rotar por **FEFO** (First Expired First Out) y medir/alertar la merma por vencimiento. Reduce merma 30–50% (benchmark industria).

## Modelo (ADR-022, resumen)

**Sub-ledger de lotes aditivo.** Nueva tabla `commercial.stock_lots` que descompone el total de `commercial.stock` por lote+caducidad. `commercial.stock` **sigue siendo el total autoritativo**:

```
INVARIANTE:  SUM(stock_lots.quantity) por (tenant, warehouse, product) == stock.quantity
             SUM(stock_lots.reserved_quantity) ...               == stock.reserved_quantity
```

Así el order flow / conteo físico / portal **no se reescriben**; FEFO se capa encima. FEFO se aplica en el **consumo** (fulfill decrementa el lote que vence primero).

## Gate

1. **¿El ERP/sync provee `lote` + `fecha_caducidad`?** → **RESUELTO 2026-06-18: NO.** Introspección de `inventory.*`/`catalog.*`/`commercial.*` no halló columnas de lote/caducidad (solo `lead_reservations.expires_at`, irrelevante). La data sincronizada del ERP **no trae caducidad** → **P2.1 = captura en recepción** (`recordMovement('in')` con `lot_code`+`expiry_date`). Sync desde las tablas batch crudas de Kepler (kdXX) = refinamiento futuro si se confirma que las tienen.
2. **(abierto) ¿Qué productos caducan?** ¿Todos, o un subset? El lote `NA` (sin caducidad) cubre no-perecederos / sin dato.
3. **Requisito regulatorio MX** (etiquetado/trazabilidad de alimentos): ¿basta caducidad, o se necesita lote para trazabilidad de retiro? (Define si el lote es obligatorio u opcional.)

## Esquema propuesto (`commercial.stock_lots`)

```
id              uuid pk
tenant_id       uuid notNull            -- RLS forzado, FK identity.tenants
warehouse_id    uuid notNull            -- FK compuesta (tenant_id, warehouse_id)
product_id      uuid notNull            -- FK compuesta (tenant_id, product_id)
lot_code        varchar(60) notNull     -- 'NA' para productos sin lote
expiry_date     date                    -- null = no caduca / desconocida
quantity        decimal(14,3) notNull default 0   CHECK >= 0
reserved_quantity decimal(14,3) notNull default 0 CHECK >= 0, CHECK quantity >= reserved
received_at     timestamp
created_at / updated_at / updated_by
UNIQUE (tenant_id, warehouse_id, product_id, lot_code, expiry_date)
INDEX (tenant_id, warehouse_id, product_id, expiry_date)  -- FEFO: ORDER BY expiry_date ASC NULLS LAST
```

(El movimiento por lote se registra reutilizando `commercial.stock_movements` + un `lot_code`/`expiry_date` opcional, o un sub-ledger por lote — decisión de P2.1.)

## Fases

| Fase | Tema | Entrega |
|---|---|---|
| **P2.0** ✅ | Schema `stock_lots` + backfill | ✅ 2026-06-18 (mig `20260618200000`): tabla aditiva (RLS forzado, FKs compuestas a tablas reales, unique `NULLS NOT DISTINCT`, índice FEFO), backfill de 1 lote `NA` por fila de `stock` (32835), invariante verificado local (0 desbalances). Falta el helper que mantenga el invariante en escrituras → P2.1. |
| **P2.1a** ✅ | Trigger del invariante stock↔stock_lots | ✅ 2026-06-18 (mig `20260618210000`): trigger `AFTER UPDATE OF quantity ON commercial.stock` mantiene `SUM(lotes.quantity)=stock.quantity` para **todos** los writers (cero cambios al order flow). NA balancea; baja que excede el buffer NA → decremento **FEFO** de lotes reales (caducidad ASC) — esto **ya cubre el grueso de P2.3**. Verificado: lógica (rollback) + **J.6.1 order flow 19/0** + inventario 22/0. Reserved por lote diferido (P2.3). |
| **P2.1b** ✅ código | Captura lote/caducidad en recepción + lectura de lotes | ✅ 2026-06-18: `recordMovement('in')` acepta `lot_code`+`expiry_date` → upsert del lote real **antes** del update de stock (el trigger mantiene NA). Nuevo `GET /commercial/inventory/stock/:wh/:product/lots` (gate VER, orden FEFO). Build api verde + check en smoke I.5. ⏳ **requiere reinicio de API** para probar live (es código de API). Habilita P2.2 (alertas) y P2.5 (mostrar caducidad). |
| **P2.2a** ✅ código | Endpoint de lotes por vencer | ✅ 2026-06-18: `GET /commercial/inventory/expiring?days=30&warehouse_id=` (gate VER) — lotes con caducidad ≤ hoy+days y stock>0 (incluye vencidos, `days_to_expiry` puede ser ≤0), con producto/almacén/`value_at_cost`, orden caducidad ASC. Build verde + checks en smoke I.5 (ventana 90 incluye / 30 excluye). ⏳ requiere reinicio para probar live. |
| **P2.2b** ✅ código | Cron de alerta de lotes por vencer | ✅ 2026-06-18: scan #3 en `AlertsScannerService` (lotes con `expiry_date <= hoy+30d` y qty>0, **incluye vencidos**) → `emitExpiringLots` (severity `critical` si `<=7d` o vencido, si no `warn`). Reusa el patrón `low_stock` (RLS por `SET LOCAL`, cooldown 1h, gateado por `ENABLE_COMMERCIAL_ALERTS`; `scan-now` lo dispara manual). Tipo `expiring_lots` + umbrales `EXPIRING_LOTS_DAYS=30/CRITICAL_DAYS=7`. Build verde + check WS en smoke alerts (almacén dedicado + lote a +3d → alerta `critical`). ⏳ requiere reinicio para probar live. |
| **P2.2c** ✅ código | Dashboard "Por vencer" | ✅ 2026-06-18: página `/comercial/inventory/expiring` (gate VER, tab "Por vencer" en el strip de inventario) — consume `GET /expiring`, KPIs (valor en riesgo al costo / lotes / ya vencidos), tabla con tag de días (vencido `danger` / ≤7d `danger` / ≤15d `warn`), filtro de ventana (7/15/30/60/90d) + almacén. Build view verde. ⏳ verificación visual manual (no automatizable desde CLI). |
| **P2.2d** ✅ código | Vencidos: no despachar primero + aviso (warn-only) | **Decisión 2026-06-18: warn, NO block** (no se toca el camino de reserva/dinero). Dos partes: (1) **trigger expired-last** (mig `20260618220000`): el decremento FEFO ahora consume **no-vencidos primero** (`ORDER BY (expired) ASC, expiry ASC`), vencidos solo como último recurso → la venta normal ya no despacha vencido. Invariante intacto. **Verificado** (`database/scripts/verify-fefo-expired-last.js` PASS + J.6.1 19/0). (2) **aviso `sold_expired`**: `consume()` devuelve `expiredConsumed` (=`qty - bueno_no_vencido`); `OrdersService.fulfill` emite alerta WS `warn` cuando un despacho tocó lote vencido. Build verde + check WS en smoke alerts. ⏳ la parte (2) requiere reinicio para probar live. |
| **P2.3** ✅ código | Trazabilidad del lote consumido | ✅ 2026-06-18: el decremento FEFO ya lo hace el trigger; acá `consume()` hace **diff before/after** de `stock_lots` (observa, no re-simula) y registra en `commercial.stock_lot_movements` (mig `20260618230000`, RLS forzado, append-only) **qué lote(s) salieron de cada venta** + la ref del pedido. `GET /commercial/inventory/lot-movements?lot_code=&reference_id=&product_id=&warehouse_id=` (gate AJUSTAR) → recall "¿qué pedidos consumieron el lote X?" y "¿de qué lotes salió el pedido Y?". Build api verde + check en smoke alerts (pedido con lote vencido → lot-movement qty 5). ⏳ requiere reinicio. Deferred: trazar ajustes/reconcile a nivel lote (hoy solo ventas). |
| **P2.4** ⏸️ diferido | Conteo físico por lote | **Diferido 2026-06-18** (P2 pausado en MVP por decisión del usuario). Extender Fase I: snapshot/conteo por lote; **regla de reconciliación del invariante** (a qué lote imputar la varianza — el problema más complejo de ADR-022). |
| **P2.5** ⏸️ diferido | FEFO en vendedor/portal | **Diferido 2026-06-18.** Mostrar caducidad / próximos a vencer al armar pedido (vendedor + portal B2B); opcional impedir vender casi-vencido. Alto valor de uso; retomar cuando se priorice la UX de pedido. |

**Orden de valor real:** P2.0 ✅ → P2.1a ✅ (trigger; FEFO-decrement) → P2.1b ✅ captura → P2.2a ✅ `/expiring` → P2.2b ✅ alerta "por vencer" → P2.2d ✅ no-despachar-vencido-primero + aviso `sold_expired` (warn) → P2.2c ✅ dashboard "Por vencer" → P2.3 ✅ trazabilidad del lote consumido → **⏸️ PAUSA (MVP completo)** → P2.4 conteo por lote (diferido) → P2.5 vendedor/portal (diferido).

**P2.2 = 🟢 COMPLETA** (alertas + gate warn + dashboard; falta solo QA visual de P2.2c). **P2.3 ✅ código** (lot-movements ledger; ⏳ reinicio para verde live). **P2.4/P2.5 ⏸️ diferidos** (decisión 2026-06-18: pausar en MVP).

### P2.6 — Control de Caducidades digital (retomado 2026-08-10)

Digitaliza la hoja manual "CONTROL DE CADUCIDADES" (inspección de anaquel): personal de sucursal recorre el estante y captura por producto **cantidad + fecha de caducidad + estado físico (bueno/regular/malo) + observaciones + acción de seguimiento + foto de evidencia** — datos que el sub-ledger FEFO no tenía.

| Ítem | Estado | Detalle |
|---|---|---|
| **P2.6.0** ✅ código | Schema | Mig `20260810120000`: `commercial.expiry_reviews` (encabezado: almacén, fecha, responsable snapshot, status draft/submitted) + `commercial.expiry_review_lines` (producto opcional + raw, cantidad, caducidad, condición, observación, acción, `files jsonb`, `fed_to_fefo`/`fefo_qty`). RLS forzado + FK compuestas + audit. Verificado local (tablas existen). |
| **P2.6.1** ✅ código | Backend | `libs/commercial/commercial-expiry-reviews` (`/commercial/expiry-reviews`: list/get/create/lines CRUD/upload/submit). **Submit alimenta FEFO**: reclasifica del lote `NA` a un lote fechado `EXP-<fecha>` (mismo total → invariante intacto, trigger no dispara). Foto base64 → Cloudinary. `TenantKnexService.run()` en todo. Wireado en AppModule. |
| **P2.6.2** ✅ código | Permisos | `COMMERCIAL_EXPIRY_VER` / `COMMERCIAL_EXPIRY_CAPTURAR` (recipe 6 touch-points: enum backend + ability.factory + frontend enums view/vendor/portal + permission-meta + authz-tree). Restrictivos → asignar en `/admin/roles` + re-login. |
| **P2.6.3** ✅ código | Frontend | Montado en **dos módulos** con misma UI y permiso: **Punto de Venta** (`/tienda/caducidades`, hogar del encargado) y **Almacén** (`/almacen/inventory/caducidades`, junto a "Por vencer"). Lista de hojas + detalle de captura **mobile-first** (alta de renglón con búsqueda de producto, chips de estado, foto por fila, días-a-caducar; sticky submit). Navegación relativa (mount-agnostic) + strip de tabs de Almacén solo bajo `/almacen`. Builds api+view verdes. |
| **P2.6.4** 🧪 | Smoke | `database/tests/http-expiry-reviews-test.js`: crea hoja → renglones + ubicación → submit → lote en `/expiring` + invariante `stock.quantity` sin cambios + `fed_lines` + scoping de promotor. ⏳ **pendiente correr tras reiniciar API** (en corrida LIVE 2026-08-10 salió submit=500 por `expiry_date` que llega como `Date`; fix `toYmd()` a YYYY-MM-DD; el resto pasó). |
| **P2.6.5** ✅ código | Ubicación | Mig `20260810140000`: `expiry_reviews.default_location` + `expiry_review_lines.location` (anaquel/bodega/exhibidor). El default de la hoja pre-llena cada renglón (persiste entre altas, editable). Chip 📍 en la lista de renglones. |
| **P2.6.6** ✅ código | Promotores marca propia | Mig `20260810160000` `commercial.promoter_brands` (RLS, multi-marca). Usuario con marcas asignadas = promotor → buscador scopeado a SUS `brand_ids` + banner, y `listReviews` solo sus hojas. Endpoint productos `+brand_ids` (CSV). Admin **/admin/promotores** (`USUARIOS_GESTIONAR`) asigna marcas. Nota: el capturador necesita también `COMMERCIAL_PRODUCTS_VER` (buscador). |

| **P2.6.7** ✅ código | Plazo automático + unidad de medida + evidencia honesta (2026-08-25) | Reportado desde la pantalla en uso. **(a) Plazo**: el sistema clasifica solo desde la fecha — *Buen plazo* >90d · *Intermedio* 31–90d · *Riesgoso* ≤30d · *Vencido* — en vivo bajo el campo y en cada renglón. Umbrales = 2 constantes al tope del componente; **30d es el mismo umbral con el que ya alerta `EXPIRING_LOTS_DAYS`**, así que la hoja y las alertas dicen lo mismo. `ESTADO` se relabela a **`ESTADO FÍSICO` ("cómo llegó, no la fecha")**: competía con el plazo, y por eso se pedía que el sistema lo dedujera. **(b) Unidad**: mig `20260825180000` agrega `unit` (`caja|pieza|bulto|kg`, CHECK, nullable, sin default) — al almacén no todo llega en piezas y antes TODO decía "pz", así que 3 cajas y 3 piezas se veían igual… y ese conteo alimenta FEFO al enviar. La UI **sugiere** (código de anaquel numérico → caja; producto escaneado → pieza) y deja de sugerir al primer toque manual. **(c) Foto**: la evidencia no se guardaba porque `POST /upload` responde 400 *"Almacenamiento no configurado (faltan env S3_*)"* — **es entorno, no código** —, pero la UI lo tapaba con un genérico y dejaba guardar el renglón sin avisar; ahora muestra el motivo real y advierte *"queda sin evidencia"*. **Bug de paso:** el `GET` del detalle selecciona columnas explícitas y no incluía `l.unit` (se guardaba y no volvía) — lo cazó la verificación en navegador, no el smoke de API. |

| **P2.6.8** ✅ código | Escaneo: pistola de cajera + cámara + código tecleado (2026-09-07) | Pedido desde la pantalla en uso: dar con el producto **rápido**. Los **tres** caminos terminan en un endpoint nuevo **`GET /commercial/expiry-reviews/resolve?code=`** (gate `EXPIRY_VER`): (a) **lector HID de caja** — no se "conecta" a nada, *teclea* el código en el campo con foco y manda `Enter`; (b) **cámara del teléfono** (`@zxing/browser`, formatos de retail EAN/UPC/CODE_128/ITF); (c) **tecleado** para etiqueta rota o código de anaquel. **Un solo campo para los tres** (`app-product-scan-field`): dos inputs compitiendo por el foco es justo lo que rompe una pistola en modo wedge — el disparo se va al elemento equivocado. Foco automático tras cada resolución y tras guardar renglón → captura en ráfaga. **El resolvedor lee `catalog.product_barcodes` (1→N), no `products.barcode`**: esa columna es escalar y guarda solo el EAN de la **pieza** (Kepler `kdii.c7`); el de la **caja** (`c82`) — el que más se escanea en bodega — no está ahí. Efecto de paso: como la tabla trae `unit`+`factor`, el código leído **dice en qué unidad se escaneó** y eso reemplaza a la heurística "numérico = caja" de P2.6.7, **que adivinaba mal** (un EAN de pieza también es numérico). También normaliza **UPC-A 12 ↔ EAN-13 con cero al frente** (según cómo esté configurada la pistola entrega una u otra, y el catálogo guarda la otra → "no existe"). **Dos decisiones deliberadas, distintas al Andén:** sin match **no es 404** (la hoja acepta el renglón raw — regla P2.6 — y tirar error en una ráfaga convertiría un dato válido en falla), y **ambiguo no corta**: devuelve candidatos para que el operador elija. Scoping de promotor server-side: código de otra marca no autocompleta y **dice por qué**. Ruta declarada **antes de `@Get(':id')`** (Nest matchea en orden: `:id` se la tragaría como UUID → 400). Sin migración. Builds api+view verdes; checks de `resolve` agregados a `http-expiry-reviews-test.js`. ⏳ **smoke y validación visual pendientes** (Docker local caído en esta sesión). |

### P2.7 — Captura scan-first + asistente por voz (2026-09-08)

Reportado desde la pantalla en uso: *"aquí los productos los vamos a escanear para que llene todos los apartados, solo modifique la fecha y la cantidad"*, más un asistente al que se le **habla**.

**La tesis del rediseño:** de los 8 campos del formulario, **6 no son datos del anaquel** — son ficha del producto (presentación, unidad, ubicación) o son opcionales (observación, acción, foto). Lo único que el anaquel agrega es **cuánto hay** y **qué fecha marca el empaque**. Así que el formulario dejó de pedir todo a la vez y pasó a **dos pasos**:

| | Antes | Ahora |
|---|---|---|
| Paso 1 | 8 campos en blanco, incluido "Producto" | **¿Qué producto es?** — escaneo (pistola/cámara/tecleado), o buscador por nombre, o **voz** |
| Paso 2 | — | Ficha del producto identificado + **Cantidad** y **Fecha** grandes; el resto plegado en *Más detalles* (ya prellenado) |

Un código sin match también pasa al paso 2 (la hoja acepta el renglón raw, regla P2.6) y lo dice: *"sin catálogo — no alimenta FEFO"*.

| Ítem | Estado | Detalle |
|---|---|---|
| **P2.7.1** ✅ código | Formulario scan-first | Paso 1 / paso 2 según haya producto identificado (`identified()`). La ficha del paso 2 se pinta igual venga de escaneo, del buscador o de la voz. Prellenado real desde `/resolve`: **presentación** (`products.unit_sale` × `factor_sale`), **ubicación** (`products.location`, sin pisar el default de la hoja) y **unidad** (del código leído, P2.6.8). *Más detalles* pliega estado físico / ubicación / observaciones / acción / foto — siguen ahí, dejaron de competir con los dos campos que sí se capturan. |
| **P2.7.2** ✅ código | Asistente por voz | `POST /commercial/expiry-reviews/voice/transcribe` + `/voice/intake` + `/voice/pick` (gate **`EXPIRY_CAPTURAR`**) y panel `app-expiry-voice-panel`, montado en **`/tienda/caducidades`** (la pantalla nueva de captura) y en el detalle de hoja. **Cadena:** `MediaRecorder` → Groq **Whisper large-v3-turbo** (español) → Claude **Haiku 4.5** con *forced tool* `capturar_caducidad` → campos → prellena los 3 pasos. Contesta en voz alta con `speechSynthesis` del navegador (gratis, sin red, silenciable). **Trampa de permisos cazada al cablear:** el dictado de Thot (`/commercial/intelligence/thot/transcribe`) está gateado con `COMMERCIAL_ORDERS_VER` y **el colaborador de caducidades no lo tiene** — reusarlo le daba **403 al primer intento de hablar**, o forzaba a repartir un permiso de ventas para poder dictar. Se extrajo `SpeechToTextService` a `platform-core` (infra leaf, igual que `AnthropicService`) y **cada dominio expone la transcripción con SU gate**. `thot/transcribe` conserva su copia del fetch; cuando se toque, que consuma el servicio. |

**Reparto de responsabilidades (hereda ADR-016 y el nivel co-piloto de ADR-020):**

1. **El LLM solo convierte habla en campos** y redacta la pregunta que falta. Nada más.
2. **El producto lo resuelve el catálogo, no el modelo.** El LLM nunca ve ni devuelve un `product_id`: dice el NOMBRE que escuchó y el service lo busca en `public.products` (por palabras ≥3 letras, sin acentos, con la presentación dicha como *bonus* de desempate, no como filtro — si filtrara, un sinónimo dejaría 0 resultados). Varios matches → candidatos para que elija el humano. **Un LLM inventando UUIDs mete mercancía equivocada al sub-ledger FEFO.**
3. **No escribe el renglón.** Devuelve campos; el renglón lo agrega la persona viendo lo entendido.
4. **Se valida lo que dijo el modelo:** unidad contra el enum, fecha contra calendario real (mata el "31 de febrero") y contra un rango creíble (±5 años: *"dos mil sesenta y dos"* es error de dictado, no un dato). Lo que no pasa, se descarta y se vuelve a preguntar.
5. **La última palabra sobre qué preguntar la tiene el estado, no el modelo:** `composeReply()` mira qué falta de verdad (producto / cantidad / caducidad) y pregunta por eso; el texto del LLM se usa solo cuando no hay nada pendiente que reclamar.

**Decisiones tomadas y sus alternativas:**
- **Push-to-talk, no palabra de activación.** El *"hola suite"* del pedido implicaría micrófono siempre abierto: streaming continuo + motor de wake-word (Porcupine y parientes) + batería + permiso permanente. Se dejó **fuera del MVP**: se toca el micrófono, se habla, se suelta. La palabra de activación queda como decisión aparte (y con nombre a elegir — la familia es Thot / Horus / Maat).
- **STT en el server, no `webkitSpeechRecognition`.** El navegador es gratis pero solo Chrome y con calidad pobre en ruido de tienda. Groq Whisper ya estaba montado para el dictado de Thot: se reusó.
- **Los 3 chips de estado** (Producto / Cantidad / Caducidad) son el corazón de la UX: el operador **ve** llenarse lo esencial y sabe qué le falta decir sin escuchar toda la respuesta. Hablarle a algo sin retroalimentación visible es donde estos asistentes se sienten adivinanza.

**Dónde vive:** el asistente se montó en la pantalla nueva de tienda (`tienda-caducidades.component.ts`, la de captura directa un-producto-a-la-vez) porque es donde trabaja quien recorre el anaquel; `aplicarVoz()` escribe los mismos 3 pasos y la fecha se sigue interpretando con `parseExpiryShort` (una sola fuente de verdad para la fecha). También quedó en el detalle de hoja de `/almacen`.

**Reuso, no invención:** el dictado salió a `voice-dictation.service.ts` (`MediaRecorder` + transcribe) — `thot-ai-input.component.ts` tiene la misma lógica embebida y debería consumir este servicio cuando se toque, para no quedar con dos copias.

**Requiere en el entorno:** `GROQ_API_KEY` (dictado) y `ANTHROPIC_API_KEY` (el asistente). Sin ellas **no se rompe la pantalla**: el panel dice el motivo real y la captura sigue por escaneo/teclado. Y la cámara + micrófono **exigen HTTPS**: por `http://IP` de LAN el navegador no los da, y ambos lo explican en vez de quedarse mudos.

**Pendiente:** smoke live de `/voice/*` y validación visual (Docker local caído en la sesión del 2026-09-07/08). **Diferido:** palabra de activación siempre-escuchando, dictado de renglones en ráfaga ("y también 2 cajas de…"), y voz en la app del vendedor.

**Pendiente de entorno (no de código):** configurar `S3_ENDPOINT`/`S3_BUCKET`/`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` o la foto de evidencia seguirá sin subir (la UI ya lo dice claro en vez de fallar en silencio).

**Decisiones P2.6:** superficie única responsive en `apps/view` (el captor es encargado/almacenista, no vendedor → se evita el shell de `apps/vendor` que exige `VENDOR_APP_ACCESS`). Renglón sin match al catálogo se guarda igual (raw) y NO alimenta FEFO. Foto = evidencia de validación, NO OCR de la hoja. **Diferido:** edición inline de renglones (hoy alta + borrar); OCR de hoja; offline Dexie; captura embebida en vendor.

**Pendiente prod:** mig `20260810120000` a Railway + redeploy api+view + asignar permisos en `/admin/roles` + re-login.

## Riesgos / decisiones abiertas

- **Doble escritura `stock`↔`stock_lots`:** todo path que mueva stock debe tocar ambos en la misma trx (mismo riesgo que hoy `stock`↔ledger). Mitigar con un helper único; nunca escribir uno sin el otro. Considerar un trigger DB que valide el invariante al cerrar la trx (defense-in-depth).
- **Lote `NA`:** productos sin lote/caducidad viven en un lote sintético para sostener el invariante; FEFO los trata como "sin preferencia".
- **Reconciliación de conteo (Fase I) vs lotes:** hasta P2.4, un ajuste por conteo mueve el total; hay que decidir a qué lote se imputa (propuesta: al que vence primero, o exigir desglose por lote).
- **Reserva por lote:** fase 1 reserva contra el total (no por lote). Si dos pedidos compiten por el último lote bueno, la asignación se decide al consumir (fulfill), no al reservar. Evaluar si se necesita reserva-por-lote (cuando la caducidad importe en la promesa de entrega).
- **Mundo `inventory.warehouse_stock` (Kepler SKU):** FEFO es un concern de `commercial.stock`. Si el conteo físico de un almacén usa el mundo `inventory`, los lotes ahí son fase posterior.

## Relacionado
- [ADR-022](../02_DECISIONES_ARQUITECTURA.md) (decisión).
- [FASE_I_INVENTARIO.md](FASE_I_INVENTARIO.md) (conteo físico; §Roadmap P2 listaba FEFO como #1).
- ERP: [[reference_erp_kepler_schema]], `productos_activos`.
