# Fase E.12 — Cotizaciones de mayoreo (submódulo de Telemarketing)

> Ruta: `/telemarketing/cotizaciones` · Permisos: `COMMERCIAL_QUOTES_VER` / `COMMERCIAL_QUOTES_GESTIONAR`
> Estado: **🧪 E.12.0 EN CÓDIGO** (cimiento verificado contra `platform_test`) · 2026-09-21

---

## 1. Para qué funciona (el problema, en una frase)

**Hoy la venta de mayoreo empieza en una pregunta de precio, y esa pregunta no se guarda en ningún
lado.**

Telemarketing sabe hacer exactamente una cosa con un cliente: levantarle un **pedido en firme**
(`/telemarketing/lead/:id/take-order` → `commercial.orders`). Pero el trabajo real del canal casi
nunca arranca ahí. Arranca de dos maneras, y las dos producen el mismo objeto:

| Cómo llega | Qué pasa hoy |
|---|---|
| **El cliente manda su lista.** Por correo o WhatsApp, con SUS nombres y SUS códigos, pidiendo precio. | Alguien la cotiza a mano en Excel, la manda, y ahí muere. No queda qué se ofreció, a qué precio, con qué vigencia, ni si el cliente contestó. |
| **La visita de ruta.** Se visita al cliente de mayoreo y se le levanta la venta ahí mismo. | A veces es pedido en firme (y entonces el flujo actual sirve) y a veces es "déjame el precio y te confirmo" (y entonces no hay dónde ponerlo). |

El objeto común es **una oferta de precio, con vigencia, que todavía no es una venta**. Este
submódulo le da casa para que deje de vivir en un Excel y en la memoria del operador.

Lo que se gana, en concreto:

- **El precio ofrecido queda escrito**, con quién lo ofreció, cuándo y hasta cuándo vale.
- **Se puede medir la conversión**: cuántas se cotizaron, cuántas se ganaron, cuántas se vencieron
  sin que nadie las persiguiera.
- **Aparece la demanda que hoy es invisible**: lo que el cliente pidió en su lista y NO pudimos
  cotizar porque no lo manejamos. Hoy ese renglón se borra del Excel y nadie se entera.

---

## 2. La decisión de fondo: tabla propia, no un status más en `orders`

Era la opción barata y **se descartó con medición**, por dos razones independientes:

1. **Confirmar un pedido reserva stock.** Desde Fase B.2, `confirm` descuenta inventario en la
   misma transacción, con `FOR UPDATE` anti-race. Una cotización **no debe tocar inventario**:
   cotizamos lo mismo a diez clientes y se lo lleva uno. Meterla en `orders` obliga a poner un `if`
   en el camino del dinero, que es exactamente donde no se ponen `if`.
2. **`commercial.orders` tiene 163 referencias en 30 archivos** (medido 2026-09-21), y **21 lugares
   filtran por `status='draft'`**. Un status nuevo no se queda quieto: se cuela al pipeline del
   Command Center, a los conteos de analytics, a las olas de surtido y a las guías de logística.
   Son 30 archivos a auditar para no publicar una cifra falsa, contra una tabla nueva que no le
   cambia el número a nadie.

**La cotización no se "convierte": crea un pedido y lo apunta** (`quotes.order_id`). Un solo camino
al dinero, con linaje de ida y vuelta. Lo sostiene un CHECK: un `order_id` sobre una cotización que
no está `accepted` es una conversión por la puerta de atrás, y la base lo rechaza.

---

## 3. Lo que se investigó del ERP (y por qué cambió el diseño)

> Regla del proyecto: **nunca adivinar una fuente de datos**. Todo lo de abajo se verificó contra
> `kepler_ods` el 2026-09-21, a partir de las pantallas reales de Kepler que aportó Dirección.

### 3.1 ⭐ El padrón de clientes es POR SUCURSAL, y las condiciones NO son las mismas

El catálogo de clientes (`md_cat_cli.kpl` → `kepler_ods.kdud`) trae las condiciones comerciales:
vendedor (`c12`), grupo (`c13`), zona (`c14`), **límite de crédito (`c15`)**, **plazo (`c16`)** y
**descuento (`c17`, y `c18` para el segundo)**.

**El hallazgo:** hay una fila por sucursal, y no dicen lo mismo. El caso que lo destapó, C1086
(MANUEL RIOS DURAN):

| Sucursal | Límite de crédito | Descuento | Zona |
|---|---|---|---|
| 01 (La Piedad) | **$60,000** | **3%** | `01` |
| 00 (CEDIS) y 02 | $30,000 | **ninguno** | `10000` |

Y no es un caso aislado. Sobre **1,574 clientes distintos**:

| Difiere entre sucursales | Clientes | % |
|---|---|---|
| Límite de crédito | **204** | 13.0% |
| Plazo de pago | **118** | 7.5% |
| Grupo | 60 | 3.8% |
| Descuento | 57 | 3.6% |

**Consecuencia de diseño:** "el descuento del cliente" **no existe** como dato único. Existe el
descuento del cliente **en una sucursal**. Una cotización que no diga con qué condiciones se armó
no se puede auditar después — así que se **congelan en la cotización** (`terms_discount_pct`,
`terms_credit_limit`, `terms_payment_days`, `source_branch`) junto con su procedencia
(`terms_source`). Un CHECK impide decir "esto viene de Kepler" sin decir de qué sucursal.

### 3.2 ⭐ El precio de mayoreo es una escalera, y ya existe — hay que derivarla, no reinventarla

El menú **Descuentos** de Kepler tiene cuatro mecanismos, y los cuatro están en el ODS con
vigencia y por sucursal:

| Pantalla Kepler | Tabla ODS | Umbral | Filas | **Vigentes hoy** |
|---|---|---|---|---|
| Descuento por Cantidad (`PV_descuxq`) | `kdpv_descuxq` | Cant. a partir | 56,995 | **396** |
| Descuento por Monto (`PV_descuxm`) | `kdpv_descuxm` | Monto a partir | 3,549 | **0** |
| Prod. Gratis por Cantidad (`PV_gratisxq`) | `kdpv_gratisxq` | Cant. a partir | 35 | **0** |
| Prod. Gratis por Monto (`PV_gratisxm`) | `kdpv_gratisxm` | Monto a partir | 7 | **0** |

Sumado al descuento propio del cliente (§3.1), **eso es el precio de una cotización**. El módulo lo
**deriva**; no inventa un esquema de descuento nuevo. `quote_lines.price_source` declara cuál de
los mecanismos se aplicó, para que un precio bajo sea *explicable* y no *sospechoso*.

**Cuatro trampas medidas, que darían un precio mal:**

- ⚠️ **Sólo el 0.7% de las reglas está vigente** (396 de 56,995 en `descuxq`). Un motor que no
  filtre por `c7`/`c8` aplicaría promociones muertas. Hay centinelas de "infinito" en las dos
  puntas: fechas `1800-01-01` y `2106-02-28`.
- ⚠️ **Tres de los cuatro mecanismos están hoy en cero.** Eso se **declara**, no se interpreta: no
  significa que no se usen, significa que hoy no hay nada activo. El motor los lee igual.
- ⚠️ **El descuento es por UNIDAD, no por producto.** El mismo SKU aparece con reglas distintas en
  `PAQ` y en `CJA` (66 combinaciones vigentes). Es el campo minado de unidades del proyecto
  (ADR-055/057): aplicar la regla de la caja a un precio por paquete da un número redondo y falso.
- ⚠️ **El aviso "No debe Traslapar Promociones Activas" es una instrucción a la persona, no una
  restricción del sistema.** Medido: hay 1 combinación con **3 filas idénticas** vigentes. No
  cambia el precio (las tres dicen 33%), pero **un JOIN sin deduplicar triplicaría el renglón**.

### 3.3 El renglón que no casa con el catálogo es el punto, no el borde

Cuando el cliente manda su lista, parte de los renglones **no van a casar**: pide algo que no
manejamos, lo llama distinto, o manda su código de proveedor. Por eso `quote_lines.product_id` es
**NULL-able a propósito** y existe `requested_text` (lo que el cliente escribió, tal cual).

Ese renglón es **demanda que estamos rechazando** — el mismo hecho que `commercial.floor_stockouts`
captura en el mostrador — y desaparece si la tabla exige `product_id`. La mesa lo muestra como
"N sin casar" por cotización.

### 3.4 El regalo trae un cero que SÍ es real

`kdpv_gratisxq` regala **otro SKU** (`c6`), con su propia unidad (`c12`). O sea que un renglón
cotizado puede engendrar un segundo renglón, de otro producto, a precio cero.

Ese cero es legítimo, y hay que poder distinguirlo del cero que significa "no supe ponerle precio"
— que en esta tabla es **NULL** (ADR-056: lo que no se midió se declara, no se dibuja como cero).
Los separa `price_source='free_goods'`, y `parent_line_number` apunta al renglón que se ganó el
regalo: sin eso, un regalo suelto parece un error de captura.

### 3.5 Direcciones de entrega: son varias, y cada una trae su ruta

`kdudent` (pantalla "Direcciones de entrega"): un mayorista puede tener N direcciones, cada una con
su **Ruta Asignada** (`R0015` en el ejemplo). La cotización guarda la **clave** de la dirección
(`delivery_address_key`), no una copia del texto.

### 3.6 Suelto, para E.10

`kdud.c13` es el **grupo** del cliente, y `1M001` es el que la pantalla rotula
**"TELEMARKETING LA PIEDAD"**. `kduj` es el catálogo de grupos de vendedor (`RM-01` =
"VENDEDORES TELEMARKETING", cuenta contable `401-003`). Eso es candidato directo a resolver el
pendiente **E.10** ("la cola prioriza 412 clientes de campo que no son de telemarketing; debería
trabajar los 206 reales"). **No verificado todavía** que `c13` sea el discriminante correcto.

---

## 4. Qué se construyó en E.12.0 (y qué NO)

### Construido y verificado

| Pieza | Dónde |
|---|---|
| Schema: `commercial.quotes` + `quote_lines` + `quote_sequences` (RLS forzado, grants, FK compuestas, 21 CHECK) | `database/migrations-newdb/20260921190000_commercial_quotes.js` |
| Folio atómico `COT-YYYY-NNNNN` por (tenant, año) | mismo UPSERT que `order_sequences` |
| Backend: list + summary + getOne + create + cancel | `libs/commercial/src/lib/commercial-quotes/` |
| Permisos propios (5 touch-points de GOTCHAS §4) | `permissions.ts`, `permission-meta.ts`, `authz-tree.ts`, guard de ruta, gate del nav |
| Frontend: mesa de cotizaciones | `apps/view/.../televenta/pages/televenta-quotes.component.ts` |
| Smoke con **prueba negativa de cada candado** | `database/tests/test-newdb-quotes.js` — **22/22 verde** |

### NO construido — declarado, no insinuado

La pantalla lo dice arriba y una sola vez, porque un módulo a medias que no lo dice se lee como un
módulo roto:

- ~~**E.12.1 — El editor de renglones + el motor de precio.**~~ ✅ **HECHO, en dos tramos y con
  otro nombre**: el motor es `[COT.1]` (2026-09-22) y la pantalla `[COT.1b]` (2026-09-23), los dos
  en [`FASE_COT`](FASE_COT_COTIZACIONES.md). ⚠️ **Dos nombres para un sprint**: si buscás
  "E.12.1" en el código no lo vas a encontrar — los commits dicen `[COT.1]` y `[COT.1b]`.
- ⚠️ **La superficie NO se movió.** `FASE_COT` §5 había fijado `/cotizaciones` como proyecto
  propio por decisión de Dirección (2026-09-22); Edgar lo **revirtió el 2026-09-23** y la pantalla
  se queda en `/telemarketing/cotizaciones`. El diagnóstico que sostenía la mudanza sigue vivo y
  está en §4 de ese doc.
- **E.12.2 — Pegar la lista del cliente.** Que el operador pegue el correo/WhatsApp y el sistema
  intente casar cada renglón (reusar el match AI de Fase K), dejando en `unmatched` lo que no casó.
- **E.12.3 — Enviar y PDF.** El documento que ve el cliente. Reusa el patrón de `AnexoVentaService`
  (Fase AX), que ya tiene su propio Chromium.
- **E.12.4 — Convertir en pedido.** Crear el `commercial.orders` y apuntarlo. Es el único punto
  donde se toca inventario.
- **E.12.5 — Cron de vencimiento.** Hoy una cotización vencida sigue diciendo `sent`; la mesa lo
  **declara** ("vencidas sin cerrar") en vez de mentir, pero nadie la cierra sola.

---

## 5. Pendientes y riesgos abiertos

- ✅ **Validación visual hecha** (2026-09-21): mesa + alta ejercidas en el navegador; COT-2026-00001 creada para C1086 sucursal 01 con las condiciones congeladas, y borrada después.
- ✅ **Verificación HTTP hecha con ROL MÍNIMO** (`http-quotes-test.js`, **25/25**, en la
  regresión): dos usuarios efímeros —uno con el rol `telemarketing`, que la migración reparte, y
  otro **sin** la llave, que recibe **403** en los tres endpoints—. No se probó con un admin a
  propósito: los roles de plataforma pasan por god-mode y un gate mal puesto —o un permiso que
  nadie repartió— **sale verde igual**. Fue exactamente la forma de `[LC.6.2]`.
- ✅ **Permisos repartidos por migración** (`20260921210000_grant_quotes_permissions.js`): VER y
  GESTIONAR a quien tiene `COMMERCIAL_TELEVENTA_OPERATE = true`. Probada contra un baseline
  limpio (**0 → 2 roles**: `telemarketing` y `superadmin`) y comprobada idempotente.
- ⚠️ **Decisión declarada, deliberadamente NO resuelta acá.** El `televentaGuard` del shell exige
  `COMMERCIAL_TELEVENTA_OPERATE` y **ignora el hermano `_VER`**. Consecuencia medida:
  `direccion` (1 usuario) tiene `_VER` y **no puede entrar al módulo** — su llave de lectura ya
  estaba muerta antes de esta fase; `supervisor` (1) y `supervisor_ventas` (3) lo tienen en
  `false` explícito. Darles cotizaciones sería **una llave que no abre nada**. Abrirles el
  módulo es decisión de negocio, porque arrastra la cola y la toma de pedido; colarlo en una
  migración de permisos sería ampliar accesos por la puerta de atrás.
- ⚠️ **Pendiente prod:** 3 migraciones + redeploy api/view + **re-login** (los permisos viajan
  en el JWT).
- 🔍 **Abierto:** que el mismo submódulo sirva desde `apps/vendor` para la visita de ruta
  (`origin='route_visit'` ya existe en el esquema, pero la app del vendedor no lo consume).

---

## 6. Nota de proceso

Este sprint se construyó **dos veces en paralelo** por dos sesiones sobre el mismo pedido. El
commit `ec391b33` llegó primero con el esqueleto; esta línea lo reconcilió encima, y en el camino
corrigió tres cosas reales del árbol fusionado:

1. **Ruta duplicada** (`path: 'cotizaciones'` dos veces). La segunda quedaba muerta, y usaba
   `anyPermissionGuard(QUOTES_VER, TELEVENTA_OPERATE)` — que vuelve decorativo el permiso nuevo:
   cualquiera que opere telemarketing entraría sin la llave de cotizar. Se dejó el
   `permissionGuard(COMMERCIAL_QUOTES_VER)` exacto.
2. **Enlace de nav duplicado y sin gatear.** La señal `verCotizaciones` estaba declarada y **nunca
   usada**: un gate muerto. Ahora gatea de verdad.
3. **El esquema no conocía nada de §3.** Se le agregaron el snapshot de condiciones, el
   `price_source`, el renglón de regalo y la clave de dirección de entrega — con sus CHECK y su
   prueba negativa.

Y una lección del propio smoke: las 6 primeras aserciones negativas salieron rojas **por la razón
equivocada** (el folio de prueba pasaba de `varchar(30)`, así que el INSERT moría por longitud
antes de llegar al CHECK). Si el test hubiera afirmado *"falló"* en vez de *"falló por ESTE
candado"*, habrían salido **verdes sin probar nada**. Cada aserción compara contra el **nombre del
constraint**.
