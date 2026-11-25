# Anexo COT.7 — El pedido llega a Kepler solo, venga de donde venga

> **Pedido de Edgar, 2026-11-25:** *«necesito que cuando se genere un pedido se vaya automáticamente
> a pedido de tlmk»*. Preguntado qué pedido, contestó **«los dos»** (la tienda Wix y los de la
> Suite) y, sobre el cliente de la tienda, **«cae como ecommerce creo»** — verificado abajo: existe.
>
> Extiende [`FASE_COT7_PEDIDO_TLMK_A_KEPLER.md`](FASE_COT7_PEDIDO_TLMK_A_KEPLER.md). **No es fase
> nueva**: el cupo está en 10 🔨 contra 4, y acá no se inventa nada — se le agregan **dos
> productores** a una puerta que ya existe y ya funciona.

---

## 1. Lo que ya está hecho (y por eso esto es chico)

**La cotización de telemarketing ya escribe su pedido en Kepler, sola: 625 de 625 aceptadas
tienen folio.** No hay ni una con error pendiente. La máquina de escribir el documento
—`armarPedidoTlmk` + `KeplerPedidoTlmkSinkAdapter`, con su árbitro de COT.7.0d al 99.21 %, su
interruptor y su tope diario— **está en producción y no se toca**.

⭐ **Lo que falta no es el documento: es el productor.** Hay que armar un `PedidoTlmkEntrada`
(sucursal, cliente, vendedor, fecha, dirección de envío, renglones) desde otros dos orígenes.
*Esto es exactamente ADR-056: se reusa el primitivo en vez de inventar el noveno.*

---

## 2. El doctipo, aclarado antes de construir

`U-D-40` en Kepler es **el Pedido**, a secas (`c2='U' c3='D' c4=40`, folio `PD-`, `c8=N`: no mueve
existencia). «Pedido Telemarketing» es el nombre de la **pantalla**, no una naturaleza distinta:
quien lo marca como de telemarketing es su vendedor y su cliente, no el doctipo.

⚠️ **Casi me equivoco acá y vale escribirlo:** los 14 pedidos de la Suite que figuran ligados a
Kepler tienen folios `UD1003`/`UD1004`, y los leí como un doctipo de preventa distinto. No lo son:
son `U-D-10` **tipo 03 y 04**, o sea *tickets de mostrador*, y además están **ligados, no escritos**
(`link_source = 'mesa'`, los 14 el mismo día de octubre). El decode lo dice en
[`ERP_KEPLER.md`](../../ERP_KEPLER.md) §645. **Un doctipo no se lee del folio.**

Conclusión: **un solo doctipo, `U-D-40`, sirve para los dos orígenes.** Los pedidos de la Suite ya
usan el mismo prefijo `PD-` en su folio.

---

## 3. Origen A — la tienda Wix

**Universo medido el 2026-11-25** sobre los 848 pedidos históricos de la tienda:

| | Pedidos |
|---|---:|
| Pagados (`PAID`) | **176** |
| Sin pagar (`NOT_PAID`) | 635 |
| Reembolsados (total o parcial) | 37 |
| Cancelados | 640 |

Un pedido pagado **trae todo lo que el adapter necesita**: `lineItems[].physicalProperties.sku`
(que empata con Kepler — probado en `[CV.29]`/`[CV.30]`), cantidad, precio, correo del comprador y
domicilio de envío.

⭐ **El cliente existe y Edgar tenía razón:** `kdud` clave **`ONLINE`**, *«ENVIOS ONLINE
(E-COMMERCE)»*, **en las 9 sucursales**, vendedor `00002`, límite de crédito 0 y 0 días (contado).

⭐⭐ **Y ya se usa a mano: 1,078 documentos contra `ONLINE`** — 953 en la sucursal `01` y 125 en
`00`. Automatizar **reemplaza una captura manual que ya ocurre**; no inventa una práctica.

⚠️ **NO MEDIDO:** que esos 1,078 documentos correspondan a pedidos *de Wix*. Pueden incluir otros
canales en línea. Antes de construir hay que cruzar unos cuantos contra pedidos de la tienda por
importe y fecha — **y con control negativo**, que un cruce por importe solo no prueba nada.

---

## 4. Origen B — los pedidos de la Suite

**Son del vendedor de ruta, y ahí está el dinero.** De 1,844 pedidos, **1,819 los creó un
`vendedor_ruta`**; sólo 1 vino del portal B2B.

| Mes | Pedidos | Importe |
|---|---:|---:|
| **Noviembre 2026** | **1,671** | **$1,450,081** |
| Octubre | 128 | $120,949 |
| Septiembre y antes | 50 | $19,773 |

⭐⭐ **Es ~180 veces la tienda Wix** (que mueve ~$8,045 al mes). Si hay que hacer uno primero, es
éste — pero también es el que puede escribir 1,671 documentos al mes en el ERP, así que entra con
tope y con interruptor.

Dos hechos que condicionan el trabajo:

- **Ninguno de los 1,844 llegó a Kepler escrito.** Los 14 que figuran están *ligados* a documentos
  que ya existían (§2).
- ⛔ **Ninguno nació de una cotización: `commercial.quotes.order_id` está vacío en los 1,844.** El
  motor «pasar a venta» `[MCP.34]`, decidido el 2026-11-24, **todavía no produjo un pedido en prod**.
  El productor de este origen tiene que leer el pedido, no la cotización.
- `delivery_channel` está muerto: 1 `whatsapp` en 1,844.

---

## 5. Decisiones

| | Decisión | Recomiendo | Por qué |
|---|---|---|---|
| **D1** | Sucursal de un pedido de la tienda | **`01`**, declarado | Ahí están 953 de los 1,078 documentos de `ONLINE`. La tienda **no está atada a una sucursal** (`[CV.29]`), así que esto **se declara, no se deriva** |
| **D2** | Qué pedidos de la tienda califican | **sólo `PAID`** | Un `NOT_PAID` escrito en el ERP es mercancía pedida que nadie pagó. Son 635 de 848 |
| **D3** | ¿Escribe solo, o alguien lo mira? | **Solo**, con el interruptor y el tope diario de COT.7 | Es el mismo carril que ya opera con 625 documentos. El freno existe y está probado |
| **D4** | ¿Se recuperan los históricos? | **No.** De aquí en adelante | 1,844 + 176 documentos retroactivos en el ERP es un evento contable, no una migración |
| **D5** | Qué lo dispara | **El evento**, nunca un cron ni un importer | Tienda: webhook de Wix al pagarse. Suite: el momento en que el pedido se confirma |
| **D6** | Sucursal de un pedido de ruta | la del vendedor | Ya la trae; no hay que inventarla |

---

## 6. Las capas (C0 → C3)

- **C0 — el dato.** Cruzar una muestra de los 1,078 documentos `ONLINE` contra pedidos de Wix, con
  control negativo, y confirmar que el productor sabe armar los renglones. **Sin esto no se sube.**
- **C1 — el productor.** Dos funciones puras `pedido → PedidoTlmkEntrada`, con sus pruebas contra
  pedidos reales. No tocan ni HTTP ni base, igual que `kepler-pedido-tlmk.ts`.
- **C2 — el disparo.** El webhook de Wix (firmado y verificado) y el evento de confirmación de la
  Suite. Falla cerrada: un renglón que no se puede escribir rechaza el pedido entero, con su SKU.
- **C3 — verlo.** Que el pedido muestre su folio de Kepler, y que el que no pudo escribirse se vea
  con su porqué. Lo que no se pudo escribir **se declara**, no se esconde.

---

## 7. Qué NO incluye

Dar de alta clientes reales de la tienda (eso es `ALC`, en 🧪) · cambiar el motor de precios ·
cobrar · facturar · tocar el pedido de telemarketing que ya funciona · recuperar históricos (D4).

---

## 8. Riesgo

⛔ **Escribir en Kepler vivo.** El carril existe, pero pasa de ~1 documento por cotización a
potencialmente **1,671 al mes** del origen B. Entra por canario, con tope diario e interruptor, y
el primer día se cuenta a mano. `[CV.29]` ya dejó la lección de qué pasa cuando se escribe en lote
sin releer: se verifica **releyendo el ERP**, nunca el acuse.
