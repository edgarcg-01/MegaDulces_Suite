# Fase MCP — Mesa de Control de Preventa (pedidos de vendedor.megadulcessuite.com)

> **ADR-089 propuesto** · planeada 2026-10-08 · estado **🔨 EN CURSO — MCP.1 y MCP.4 en prod (backend, PR #318) · MCP.2 en código (pantalla), §6**
>
> **Tesis:** el pedido de preventa cruza **dos sistemas** y nadie ve el recorrido completo. Se
> **levanta y se surte en la Suite**, se **cobra en Kepler** (ticket de caja), y la **entrega de
> conformidad** vuelve a la Suite. La mesa de control junta las tres partes: el repartidor, al
> entregar, **elige en su celular el documento de Kepler** del cliente (lectura del ODS, sin
> escribir en Kepler) y queda ligado al pedido `PD-`; la cajera **imprime la guía de carga** que el
> repartidor firma; y al volver, el repartidor **liquida contra esa guía** en lugar de la tira de
> ingresos reimpresa. El surtido se trabaja con el **mismo motor** que telemarketing y sucursal
> (Fase GP).

Pedido de Francisco (2026-10-08):

> *"la mesa de control de pedidos levantados por la aplicación de vendedor.megadulcessuite.com, que
> son los que se levantan en preventa, el vendedor va avanzando y en sucursal van gestionando su
> surtido y entrega. Me gustaría que se gestionara como se gestiona el módulo de surtido que hoy da
> servicio a telemarketing y pedidos de sucursal."*

Y la precisión del flujo (misma conversación):

> *"el pedido sí termina cobrado en Kepler: el levantado y surtido van por la Suite, luego el cobro
> va por Kepler, el pescar el ticket por parte de la Suite, y la entrega de conformidad por la Suite."*

---

## 1. Lo medido antes de planear (prod, solo lectura, 2026-10-08)

| Medición | Valor |
|---|---|
| Pedidos de preventa (`requested_delivery_date` no nula) en estado `confirmed` | **27** |
| De ésos, con la fecha de entrega ya vencida | **27 de 27** (de 2 a 110 días) |
| De ésos, que alguna vez entraron a una ola de surtido de la Suite | **0** |
| Olas de surtido creadas en prod, de cualquier origen | **0** (el motor existe y nunca se ha usado) |
| Autores (60 días) | vendedor_ruta 19 · supervisor_ventas 3 · direccion 2 |
| Sucursales (60 días) | Yurécuaro (04) 7 · Morelia Madero (MD-32) 7 · Padre Hidalgo (01) 5 · La Piedad Abastos (02) 5 |
| Tamaño | 3 renglones en promedio, 13 el máximo |
| Fecha de entrega pedida | mismo día 8 · al día siguiente 12 · a 2 días 4 |

### 1.1 ⭐ Los "vencidos" no están atorados: se cobraron en Kepler y la Suite no se enteró

Buscando tickets de Kepler (`analytics.erp_sale_tickets`, `U-D-10`) del **mismo cliente, en la
misma sucursal, hasta 10 días después** de capturar el pedido:

| Pedido | Pedido $ | Ticket candidato | Fecha | Cobrado $ | Caja / cajero |
|---|---|---|---|---|---|
| PD-2026-00052 | 348.34 | 04UD1003-0002102 | 01-oct | 286.98 | Caja 3 · RUTA VECINAL YURECUARO |
| PD-2026-00053 | 1,700.12 | 04UD1003-0002097 | 01-oct | 1,564.75 | Caja 3 |
| PD-2026-00054 | 2,276.51 | 04UD1003-0002098 | 01-oct | 1,873.86 | Caja 3 |
| PD-2026-00055 | 1,474.78 | 04UD1003-0002099 | 01-oct | 1,154.32 | Caja 3 |
| PD-2026-00056 | 2,928.31 | 04UD1003-0002101 | 01-oct | 2,559.76 | Caja 3 |
| PD-2026-00057 | 150.75 | **4 candidatos** (247.31 · 1,242.59 · 626.62 · 201.99) | 01–02 oct | — | Caja 3 |
| PD-2026-00059 | 247.23 | **2 candidatos** (15.30 Caja 1 · 179.32 Caja 3) | 02-oct | — | — |

Tres cosas que de aquí salen y gobiernan el diseño:

1. **El flujo que describió Francisco ya ocurre** en Yurécuaro: el pedido se surte, la Caja 3 (la de
   ruta vecinal) cobra el ticket **con la clave del cliente**, y la Suite lo sigue mostrando como
   "confirmado vencido". Al menos **7 de los 27** tienen ticket; la mesa los reconcilia el primer día.
2. **Lo cobrado casi nunca es igual a lo pedido** (5 de 5 pares claros cobran entre 8% y 22% menos).
   Puede ser surtido incompleto, precio distinto o renglones quitados. **La diferencia es el dato**:
   se muestra, no se esconde ni se "cuadra" sola.
3. **Cliente + fecha no basta como llave**: PD-00057 tiene 4 tickets candidatos y PD-00059 tiene 2.
   Ligar por heurística sin confirmación inventaría parejas (ver §2.2).

En Yurécuaro, la Caja 3 cobró 276 tickets en 30 días y 223 traen un cliente real; la Caja 1
(mostrador) cobró 4,698 y **4,688 son público general**. La caja de ruta es una señal fuerte.

⚠️ Los clientes que el vendedor da de alta en campo (código `V-…`) **no tienen clave de Kepler**
(`erp_customer_code` nulo; p. ej. PD-00061, PD-00050, PD-00048, PD-00045). Su ticket sale a
público general o a otra clave, y **no se puede pescar por cliente**.

### 1.2 Cómo viaja hoy el pedido (verificado en código)

1. El vendedor arma el pedido en `apps/vendor` (`/vendor/take-order`), que es **sólo preventa**.
2. `POST /commercial/orders/:id/place` → `draft → confirmed`, **sin apartar inventario**.
3. `avisarSucursal` inserta en `commercial.order_notifications` y avisa en vivo a quien tenga ese
   almacén y `COMMERCIAL_PICKING_GESTIONAR`. **Sólo 1 de 6 almacenistas tiene `warehouse_id`**.
4. El pedido aparece en el pool de `/reparto/surtido` (Fase SU), **otra pantalla** distinta a la
   del almacén para telemarketing y sucursal (`/almacen/pedidos`, Fase GP).
5. Hoy, "entregar" es `POST /:id/fulfill`: **descuenta `commercial.stock` y emite CFDI solo (FE.5)**.
   ⛔ Con el cobro en Kepler, eso **duplicaría la venta**: Kepler ya emitió el ticket y descontó su
   inventario. La entrega de conformidad de preventa **no puede** ser el `fulfill` de hoy (§2.3).

### 1.3 Dos mundos de surtido que no se cruzan

| | Telemarketing / Sucursal | Preventa (vendedor) |
|---|---|---|
| Dónde nace | Kepler (`U-D-40`) | Suite (`commercial.orders`, `PD-`) |
| Dónde se cobra | Kepler | **Kepler (ticket `U-D-10`)** |
| Tablero | `/almacen/pedidos` (GP.1) | ninguno; `/comercial/orders` lo esconde por defecto |
| Surtido | GP.3 "tomar siguiente" | `/reparto/surtido` (Fase SU) |
| Origen en el motor | `source='kepler'` | `source='suite'` |

El motor (`commercial-picking`) ya une los dos en `lineasDePedidos`; lo que está partido son las
pantallas y el armado automático: `waves/auto` sólo arma Suite, `waves/auto-kepler` sólo Kepler, y
`tomarSiguiente` sólo arma desde Kepler cuando no hay olas libres.

### 1.4 Inconsistencias que el plan resuelve

1. **"Preventa" tiene dos definiciones** en el código (`place()`: tiene fecha de entrega; `list()`:
   autor `customer_b2b`). No hay columna que lo diga.
2. `/comercial/orders` abre en `pending_approval` y **no muestra** los pedidos del vendedor; su
   `list()` no filtra por sucursal.
3. El pool de surtido de la Suite no tiene alcance por sucursal (declarado en GP §8.3).
4. `orders.route_id` está muerto; la ruta sale de `customers.sales_route`.

---

## 2. El recorrido real del pedido (Francisco, 2026-10-08)

```
 SUITE        (SUITE)            SUITE           KEPLER              SUITE + papel         SUITE (celular)               SUITE + caja
Capturado ─► [Alta de cliente] ─► Surtido ─► Cobrado (documento) ─► En ruta (guía firmada) ─► Entregado (elige documento) ─► Liquidado
              sólo si es nuevo     y checado   la cajera lo emite      el repartidor lo pesca      de conformidad                 contra la guía
```

1. **Capturado** — el vendedor levanta el `PD-` en `apps/vendor`. *(ya existe)*
2. **Alta de cliente** — sólo si el cliente es nuevo (código `V-…`, sin clave de Kepler). El pedido
   **no se surte** hasta que el cliente esté dado de alta en Kepler. Hoy el alta va por WhatsApp; se
   moverá a un **embudo de altas dentro de la Suite** (módulo aparte, §6). Mientras, la mesa muestra
   el pedido como *"Esperando alta de cliente"*.
3. **Surtido** — **en cuanto el pedido está en la Suite** (D5): entra al pool de surtido por orden de
   llegada, y la fecha de entrega sólo desempata. Se surte y se checa con el motor de GP.
4. **Cobrado en Kepler** — el surtidor entrega lo surtido a la cajera y ella emite el **documento de
   Kepler a nombre del cliente** (ticket). Desde ese momento el documento existe y la Suite lo ve
   por el ODS.
5. **En ruta** — el repartidor o el vendedor **pesca sus pedidos en el celular** (los toma a su
   nombre). La cajera **imprime la guía de carga** desde la Suite y **el repartidor la firma**: es la
   constancia de lo que se lleva (D8).
6. **Entregado** — en casa del cliente, al abrir el `PD-25` de *Cliente X*, el celular **despliega
   los documentos de Kepler de ese cliente** y el repartidor **selecciona el que está entregando**.
   Esa selección es la liga pedido↔documento: la hace quien tiene la mercancía en la mano, no un
   algoritmo (D2/D6). Registra la conformidad (completo / con diferencia / no se pudo).
7. **Liquidado** — al volver, **el que entregó liquida al cajero contra la guía** (D9): lo
   entregado se cobra (efectivo o transferencia), lo no entregado regresa. Reemplaza la práctica de
   hoy de **reimprimir la tira de ingresos de la caja y firmarla**.

**Si no se entrega:** el pedido vuelve a *"En caja"* con el mismo documento y sale otro día, en
cualquier guía. Si tampoco se logra, pasa a *"Por devolver en Kepler"*: la cajera aplica la
devolución de mercancía y la nota de crédito en Kepler, y la Suite cierra el pedido como
**devuelto** cuando ve esos documentos.

### 2.1 Dónde vive cada pantalla

| Quién | Dónde | Qué hace |
|---|---|---|
| Encargado de sucursal | `/almacen/pedidos` → origen **Preventa** | Ve todos los pedidos de su sucursal por etapa, con semáforo; corrige ligas; reagenda o cancela |
| Almacenista | Motor de GP ("Tomar siguiente") | Surte y checa |
| Cajera | Mesa (vista de caja) | Ve lo surtido que le llega, **imprime la guía de carga**, recibe la **liquidación** |
| Repartidor / vendedor | `apps/vendor` (`/rider/*` y "Por entregar") | Pesca sus pedidos, elige el documento de Kepler al entregar, registra conformidad |

### 2.2 La liga pedido ↔ documento de Kepler

- **La hace el repartidor al entregar**, eligiendo entre los documentos del cliente que la Suite le
  muestra. Candidatos: misma sucursal, mismo cliente (`erp_customer_code`), fecha ≥ surtido, y
  **no ligados ya** a otro pedido. Fuente: `analytics.erp_sale_tickets` (vista viva sobre el ODS,
  **sin importer ni copia**).
- Si hay **un solo** candidato se le ofrece preseleccionado; **igual lo confirma él**.
- Si **no aparece ninguno** (la cajera no lo ha emitido, o el ODS viene atrasado), el celular lo dice
  con la frescura del dato y deja entregar marcando *"sin documento"*; la mesa lo sigue mostrando
  hasta que se ligue.
- **Sólo se guarda la liga** (dato propio, HITL): `commercial.order_kepler_tickets (tenant_id,
  order_id, sucursal, folio_digital, ligado_por, ligado_en, origen: celular|mesa)` con **UNIQUE por
  documento** (un documento no se liga a dos pedidos). El encargado puede corregirla desde la mesa.
- **Diferencia pedido vs cobrado**: por renglón (`kdm2` del documento contra `order_lines`) y total;
  se muestra, no se ajusta sola.

### 2.3 La guía de carga (sustituye el papel improvisado)

- **Una guía por ruta** (D12): si el repartidor pescó pedidos de dos rutas, salen dos guías y
  firma las dos. Cada guía lleva folio propio, ruta, repartidor, fecha, sucursal y por renglón **PD-, cliente, documento de Kepler (si ya existe), importe y forma de cobro
  esperada**, más total a liquidar.
- Se imprime para **firma del repartidor** (D8). El PDF reusa el patrón de documentos de la Suite
  (Fase AX). La guía queda guardada: es la base de la liquidación.
- Firma en papel por ahora; la firma en pantalla queda como mejora posterior.

### 2.4 La liquidación contra la guía (sustituye la tira de ingresos reimpresa)

- Al regresar, la cajera abre **las guías del repartidor** (una por ruta) y ve, por pedido: entregado / con
  diferencia / no entregado, con el importe del documento de Kepler.
- **Esperado = Σ documentos entregados** (con su diferencia declarada), **separado en efectivo y
  transferencia** (D11): el repartidor registra en el celular cómo pagó cada cliente. El efectivo
  se cuenta (**arqueo** por denominación); la transferencia se liquida con su referencia. Cada
  diferencia queda registrada con nombre.
- Lo **no entregado** regresa al almacén y **se deja para otro día con el mismo documento** (D10):
  vuelve al estado *"En caja"* y sale otro día en la guía de su ruta (D12). Si tampoco se
  logra, la mesa lo marca *"aplicar devolución y NC en Kepler"*; la cajera lo hace en Kepler y la
  Suite lo cierra cuando ve la devolución en el ODS (I1). La Suite no escribe en Kepler.
- Reusar `commercial.rider_liquidations` (Fase LM: arqueo por denominación, folio `LIQ-`), hoy casi
  sin uso (4 cortes abiertos desde julio): hay que extenderla para colgarle la guía y los documentos
  de Kepler.

### 2.5 La entrega no factura ni mueve inventario

El `fulfill` de hoy **emite CFDI (FE.5) y descuenta `commercial.stock`**. Con la venta en Kepler eso
**duplicaría la venta**. La entrega de preventa usa una transición propia (p. ej. `delivered`) que
sólo registra la conformidad, la liga y quién entregó. Es el riesgo #1 de la fase.

### 2.6 La etapa se deriva

`orders.status` + `wave_orders.stage` + documento ligado + guía + liquidación. No hay una segunda
columna "etapa". El semáforo es contra `requested_delivery_date`. Lo que no se puede medir se
declara (ADR-056): sin documento ligado no hay "cobrado" aunque el cliente haya pagado.

---

## 3. Sprints

| Sprint | Qué | Depende de |
|---|---|---|
| **MCP.1** | **Datos**: una definición de preventa + `GET /warehouse/presale` con etapa derivada, semáforo, vendedor, ruta, sucursal; alcance por sucursal con `ScopeService`. Contrato en `libs/contracts`. Bloqueo *"Esperando alta de cliente"* para clientes sin clave de Kepler. | — |
| **MCP.2** | **Tablero del encargado**: origen "Preventa" en `/almacen/pedidos` (master-detail de GP.1), etapas, filtros, ficha con recorrido y diferencia pedido↔cobrado; reagendar y cancelar con motivo. | MCP.1 |
| **MCP.3** | **Surtido al llegar**: el pool y "Tomar siguiente" de GP incluyen preventa por orden de llegada (fecha de entrega desempata). Checado de GP.4 se hereda. | GP.3a ✅ · coordinar con GP.3b |
| **MCP.4** | **Documentos de Kepler del cliente**: endpoint de candidatos (vista sobre `erp_sale_tickets`, sin importer) + tabla de liga `order_kepler_tickets` (UNIQUE por documento) + diferencia por renglón. Candado con prueba negativa. | MCP.1 |
| **MCP.5** | **Pescar pedidos y guía de carga**: el repartidor/vendedor toma sus pedidos en el celular; la cajera imprime la guía (PDF) para firma. | MCP.4 |
| **MCP.6** | **Entregar en el celular**: al abrir el pedido se despliegan los documentos de Kepler del cliente, se elige el entregado, conformidad (completo / diferencia / no se pudo). **Sin CFDI ni stock.** | MCP.4 + MCP.5 |
| **MCP.7** | **Liquidación contra la guía**: pantalla de caja, esperado vs entregado, arqueo, diferencia con nombre; documentos no entregados señalados para Kepler. Extiende `rider_liquidations`. | MCP.6 |
| **MCP.8** | **El vendedor ve el avance** y **avisos que sí llegan** (hoy dependen de `users.warehouse_id`, 1 de 6 almacenistas). | MCP.1 |
| **MCP.9** | **Indicadores**: entregado a tiempo, horas captura→entrega, diferencia pedido↔cobrado por vendedor y producto, diferencias de liquidación. | MCP.7 |

**MVP = MCP.1 → MCP.2 + MCP.4 → MCP.6**: la sucursal ve sus pedidos y el repartidor liga el
documento al entregar. **MCP.7** (liquidación) es el que retira el papel de la tira de ingresos.

---

## 4. Decisiones

**Respondidas por Francisco (2026-10-08):**

| # | Decisión |
|---|---|
| **D1** | El pedido **se cobra en Kepler**: levantado y surtido en la Suite, cobro con documento de Kepler a nombre del cliente, conformidad en la Suite. *(Corrige la primera respuesta, "vive sólo en la Suite".)* |
| **D2 / D6** | **El repartidor o el vendedor** entrega y, en su celular, **elige el documento de Kepler** que está entregando. No se necesita que la cajera anote el `PD-` en Kepler. |
| **D3** | Los 27 vencidos se muestran y la sucursal decide. |
| **D4** | La mesa la opera **el encargado de cada sucursal**, dentro de `/almacen/pedidos`. |
| **D5** | **Se surte en cuanto el pedido está en la Suite** (orden de llegada). |
| **D7** | Cliente nuevo → **embudo de altas de clientes** en la Suite (manual o PDF); el pedido no se surte hasta que esté dado de alta. **Módulo aparte** (§6). |
| **D8** | La cajera **imprime la guía de carga** y **el repartidor la firma** como constancia de lo que se lleva. |
| **D9** | **El que entrega cobra al cliente y liquida al cajero contra la guía.** Se retira la tira de ingresos reimpresa y firmada. |

| **D10** | Pedido **no entregado** → **se deja para otro día** con el mismo documento de Kepler (vuelve a salir en otra guía). Si tampoco se logra, en Kepler se aplica **devolución de mercancía y nota de crédito** al documento. La Suite lo señala y lo sigue; la devolución y la NC se hacen en Kepler. |
| **D11** | El repartidor cobra **en efectivo y por transferencia**. La liquidación separa las dos. |
| **D12** | Un repartidor **sí lleva repartos de varias rutas**, pero **cada ruta lleva su propia guía**. La guía es por (ruta, día, repartidor); un repartidor puede firmar varias guías el mismo día. |

Todas las decisiones de diseño están tomadas. Lo que queda abierto es de implementación (§4.1).

### 4.1 Pendientes de implementación (no bloquean el arranque)

| # | Qué | Para qué sprint |
|---|---|---|
| **I1** | Decodificar en `kepler_ods` el documento de **devolución de venta / nota de crédito al cliente** (el `X-D-55` conocido es de **proveedor**, no sirve) para que la Suite vea solo cuándo un documento quedó cerrado por devolución. | MCP.7 |
| ~~**I2**~~ | ✅ **Resuelto por Francisco (2026-10-08): máximo 2 reintentos** — *"sólo 2 entregas más, se empieza a maltratar la mercancía"*. El pedido sale la primera vez y puede salir 2 veces más; si al 3er intento no se entrega, va a devolución + NC en Kepler. Constante `MAX_REINTENTOS_ENTREGA = 2` en el motor. | MCP.7 |
| **I4** | **¿Morelia Madero cobra en Kepler como sucursal 07?** El almacén `MD-32` corre Wincaja y `erp_sale_tickets` no tiene sucursal `32`; pero los clientes de sus pedidos (PD-00028, PD-00032) traen clave de Kepler de la **07**, que sí publica tickets. No se asume: hoy la mesa lo declara `sucursal_sin_documentos`. Si se confirma, se mapea `MD-32 → 07` para buscar documentos. | MCP.4 |
| **I3** | Comprobante de transferencia: ¿basta la referencia capturada, o se pide foto? Su cruce con el banco es de la Fase CB, no de ésta. | MCP.7 |

---

## 5. Riesgos y lo que se hereda

- **Doble venta** si la entrega reusa el `fulfill` de hoy (CFDI + stock). Transición propia (§2.5).
- **Documento equivocado elegido en el celular**: UNIQUE por documento, diferencia visible en la mesa
  y en la liquidación, y el encargado puede corregir la liga.
- **Frescura del ODS**: un documento recién emitido puede tardar en verse; el celular declara la
  hora del dato en lugar de decir "no hay".
- **Sin señal en ruta**: elegir el documento necesita datos frescos. Precargar los documentos de los
  clientes de la guía al pescar los pedidos (los de ese día ya existen porque se cobraron antes de
  salir) y guardar la selección para subirla al recuperar señal.
- **Inventario**: la preventa no aparta (Fase SU §3.2); al surtir puede faltar.
- **Árbol compartido**: GP.3b está en vuelo en otra sesión; MCP.3 se coordina con ella.

## 6. Estado de implementación

### 6.1 MCP.1 + MCP.4 — backend (🧪 en código, 2026-10-08)

| Pieza | Dónde |
|---|---|
| Contrato | [`libs/contracts/src/http/warehouse-presale.contract.ts`](../../../libs/contracts/src/http/warehouse-presale.contract.ts) |
| Motor puro (etapa, semáforo, bloqueo de liga, comparación por renglón) + 22 pruebas | [`libs/commercial/src/lib/presale-control/`](../../../libs/commercial/src/lib/presale-control/) |
| Endpoints | `GET /warehouse/presale` · `GET /warehouse/presale/:id` · `GET :id/candidates` · `POST :id/link` · `POST :id/unlink` |
| Migración | `20261008012420_mcp4_order_kepler_documents.js` (RLS forzado, prueba negativa de la llave dentro) |

**Permisos (sin claves nuevas, sin re-login):** ver = `ALMACEN_PEDIDOS_VER` (el del tablero de GP);
ligar/desligar = `COMMERCIAL_PICKING_GESTIONAR` (lo tiene el encargado de sucursal).

**Verificado:**
- `tsc` de la API sin errores · `lint:boundary` ✅ · `check:sql-backticks` ✅ · `check:provenance` ✅.
- 24 pruebas del motor; la regla "clave de otra sucursal" se rompió a propósito y su prueba se puso roja.
- La consulta principal corrida **contra prod en solo lectura** (con la tabla de ligas sustituida por
  una vacía, porque aún no existe allá): **27 pedidos en 147 ms**, ~100 ms por sucursal para contar
  documentos posibles; Yurécuaro da 1/1/1/1/1 posibles y 4 y 2 en PD-00057/PD-00059, igual que la
  medición a mano.

**Hallazgos de la validación:**
- **16 de los 27** pedidos son de clientes **sin clave de Kepler** → quedan en *Esperando alta*.
- La clave de Kepler es **por sucursal**: se exige que la del cliente coincida con la del pedido.
- Morelia Madero: ver **I4**.

### 6.2 Revisión independiente antes del PR (2026-10-08)

Un revisor con ojos frescos leyó el diff completo. Lo que se arregló:

| # | Hallazgo | Arreglo |
|---|---|---|
| 1 | Las vistas `analytics.erp_sale_tickets` / `_lines` **no tienen RLS**: otro tenant con la misma clave de cliente podía ver y ligar tickets de Mega Dulces | `tenant_id = ?` en TODA lectura de esas vistas |
| 2 | Una liga en un pedido que luego se canceló **bloqueaba el documento para siempre** | Desligar se permite también en `cancelled`; al ligar, la liga colgada de un pedido cancelado se libera con autor y motivo; "ocupado" ya no cuenta los cancelados |
| 4 | Filtrar por `folio_digital` (concatenación) no usa índice | Se filtra por sucursal + prefijo + folio: **82→10 ms** la cabecera y **436→9 ms** los renglones (medido en prod) |
| 5 | La comparación usaba el precio de lista y Kepler cobra el precio con descuento | Precio del pedido = `line_subtotal / quantity` |
| 6 | La migración no ponía `lock_timeout` sobre `orders` | `SET LOCAL lock_timeout = '3s'` |
| 7 | La prueba negativa podía dar verde por la llave del PEDIDO | Elige pedidos sin liga y sólo acepta `ux_okd_documento_vivo`; además fija `app.tenant_id` por el RLS forzado |
| 8 | Un borrador se podía consultar por id | El camino por id filtra `confirmed/fulfilled/cancelled` |
| 9 | El tope de 30 candidatos se aplicaba antes de ordenar | Se leen 100, se ordenan por productos en común y se devuelven 30. En prod, PD-00057 (4 candidatos) queda con el correcto primero: comparte 1 de 1 producto, los otros 0 |
| 10–14 | Ventana de posibles sin tope, recorte silencioso a 500, 400 sin usuario, candado antes del alcance | Ventana de 60 días; `truncated`; 401; alcance antes del `FOR UPDATE` |

**Refutado con medición:** el hallazgo 3 decía que un ticket cancelado en Kepler se ofrecía como
candidato y proponía filtrar `kdm1.c43 = 'C'`. En los tickets de caja (`U-D-10`) **no existe ningún
`C` en 30 días**: ahí `c43` es el estado de **facturación** (`F` 85,838 · `N` 962 · `R` 33 · `A` 15;
ver `ERP_KEPLER.md`). La cancelación de un ticket de caja **no está decodificada**: queda **declarada**
(I5) en vez de inventar un filtro.

| # | Pendiente | Para |
|---|---|---|
| **I5** | Decodificar cómo se ve en `kepler_ods` un ticket de caja cancelado, para no ofrecerlo como candidato. | MCP.4 |

**NO verificado (declarado):** no se levantó la API (regla del proyecto), así que no hay prueba HTTP
de los 5 endpoints; ligar/desligar no se probó contra una base porque la tabla todavía no existe en
prod y prod es de solo lectura para esta sesión.

**Para desplegar:** aplicar la migración `20261008012420` en prod **antes** del código (sin la tabla,
la lista responde 500) · redeploy api.

### 6.3 MCP.2 — pantalla del encargado (🧪 en código, 2026-10-08)

Pestaña **Preventa** junto al Tablero de Kepler en Almacén › Pedidos ().
Mismo permiso del tablero (); ligar y corregir exigen .
Superuser y Guillermo no son  en el frente (rol principal ), pero su mapa de
permisos incluye el de : ven y operan la pantalla.

Revisión independiente: 12 hallazgos, todos corregidos — las respuestas de un pedido anterior ya no
pisan el panel del nuevo (peticiones canceladas al cambiar de pedido; las acciones de ligar no se
cancelan, sólo dejan de pintar), la lista recargada descarta respuestas viejas y vuelve a leer el
panel si el pedido cambió por fuera, se limpian filtros que dejaron de existir, el total cobrado
declara los documentos sin total en vez de sumarlos como 0, y ajustes de accesibilidad.

**Verificado:**  · eslint · compuertas de plantillas, tokens, tablas, teclado,
búsqueda, estilos y animación · 54 pruebas de pestañas y guards. **No verificado:** el navegador.

## 7. Fuera de alcance

- **Embudo de altas de clientes** (D7): módulo propio, fase aparte. Esta fase sólo **bloquea** el
  surtido de clientes sin clave de Kepler y lo **declara** en la mesa.
- Escribir en Kepler (opción B de GP, diferida). La Suite **lee** los documentos, no los crea ni los
  cancela.
- Venta desde el camión / autoventa (Fase VR).
- Pedidos del portal B2B del cliente (`customer_b2b`).
