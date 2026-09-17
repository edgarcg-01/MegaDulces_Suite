# Fase SU — Surtido por olas, desconsolidación y chequeo

> **Tesis (ADR-067 propuesto):** el pedido de preventa **ya existe y ya tiene dueño**
> (`commercial.orders`, folio `PD-YYYY-NNNNN`). Lo que falta no es un pedido nuevo ni un
> sistema nuevo: falta el **tramo de almacén** entre que el pedido se autoriza y que sale al
> reparto — pool, ola, picking consolidado, desconsolidación y chequeo. Eso se construye como un
> **eje de fulfillment paralelo** al estado comercial del pedido, **no** ampliando el `status`
> del pedido a 33 valores.
>
> Origen: `Flujo_Integral_Pedidos_Preventa_Mega_Dulces.md` v1.0 (Septiembre 2026). Este plan es
> la contrapropuesta de implementación de ese documento, **después de medir qué existe**.

Estado: **🔨 DISEÑADO (planeación) 2026-09-17. Sin código.**

---

## 0. Lo medido antes de planear

⭐ **El documento origen está escrito como si se partiera de cero. No se parte de cero.** De sus
18 etapas, entre 10 y 12 ya están construidas y en producción. Medido por grep sobre el repo y
consulta a la base, no por memoria.

### 0.1 Lo que el documento pide construir y YA EXISTE

| Etapa del documento | Dónde vive hoy |
|---|---|
| 1 — Pedido maestro, estados, historial | `commercial.orders` + `commercial.order_status_history`, folio `PD-YYYY-NNNNN` |
| 2 — Interfaz del vendedor (§6, §7) | `apps/vendor` → `/vendor/take-order` (Fase D.2, auditada 2026-09-17 en `[TO.1]`–`[TO.5]`) |
| 9 — Facturación / CFDI (§22) | FE.5: `INVOICE_ISSUER_PORT` → `libs/fiscal` → PAC. **Se dispara al fulfillar, no en caja** |
| 10 — Embarques (§23) | Fase J + `logistics.delivery_guides` |
| 11 — Cadena de custodia (§24) | Fase LM + `commercial-home-delivery` |
| 12 — Entrega (§25) | POD + GPS + firma (Fase J/LM) |
| 13 — Liquidación (§26) | `commercial-rider-liquidation`: `open` / `preview` / `close` / `reconcile` + **arqueo ciego** (`blindCloseOwn`) |
| 14–15 — Corte de caja e integración financiera (§29, §30) | `libs/finance/lib/caja` (Caja General) + Fase CB |
| 16 — Recuperación / traspasos (§17) | Fase RA (`commercial-replenishment`), traspasos y red de abasto |
| 17–18 — Inteligencia y copiloto (§31–§34) | Thot (ADR-018), `commercial-recommendations` (4 categorías, D.4), pitch "por qué ofrecerlo", feedback 👍/👎 |
| §12 — Ubicaciones físicas | `commercial.warehouse_bins` + `commercial.stock_lot_locations` (WMS-REC), **con backend y UI** |
| §36 — Indicadores de almacén | `commercial-bi-almacen` |

**Reconstruir cualquiera de estas es trabajo perdido.** Donde el documento y lo construido
difieren, la diferencia se resuelve en §3 (choques), no reimplementando.

### 0.2 Lo que NO existe (el proyecto de verdad)

Grep de `picking_wave`, `ola_pedidos`, `desconsolid` sobre `libs/`, `apps/` y
`database/migrations-newdb/`: **cero resultados**.

- Pool central de pedidos (§8)
- Motor de olas / picking waves (§9, §10)
- Consolidación por SKU y su reverso (§11, §19)
- Interfaz del surtidor (§13)
- Excepciones de picking sin detener el surtido (§14)
- Distribución de inventario escaso con reglas (§15)
- Chequeo de salida (§20)

Son las **etapas 3 a 8 más la 20** del documento. Coherentes, valiosas, y es donde debe ir el
esfuerzo.

### 0.3 ⛔ El dato que reordena el plan entero

```text
commercial.warehouse_bins ......... 0 filas
commercial.stock_lot_locations .... 0 filas
```

La tabla existe desde la migración `20260817140000`, tiene **backend completo**
(`POST /bins`, `put-away`, `unlocated`, y hasta `pick-suggestion`) y **UI**
(`apps/view/.../almacen/pages/almacen-ubicaciones.component.ts`). Nunca se usó.

**El beneficio central del documento —"disminuir recorridos" (§12)— depende por completo de un
dato que hoy no existe.** Y poblarlo no es software: es gente recorriendo el almacén, rotulando
y capturando. El software para hacerlo ya está escrito.

> ⚠️ Medido en `platform_test` (la base compartida de desarrollo). **Falta confirmarlo en
> prod.** Si en prod hubiera ubicaciones cargadas, SU.0 se reduce a verificar cobertura; si está
> igual, SU.0 es el camino crítico de toda la fase.

### 0.4 El catálogo no está listo para que el surtidor cuente sin unidad

Medido sobre `analytics.product_units` (8,887 SKUs; prod ronda 8,928):

| Unidad base declarada | SKUs |
|---|---:|
| PAQ | 6,586 |
| PZA | 1,906 |
| KG | 232 |
| `500`, `250` (gramaje en el campo de unidad) | 108 |
| CJA | 22 |

Y **6,128 de 8,887 (69%)** tienen más de una presentación.

El documento nunca nombra la unidad en sus pantallas operativas: §11 consolida
`Carlos V = 23` y §13 le pide al surtidor `Cantidad requerida: 43`. **Este proyecto ya pagó por
eso**: ADR-055 midió **$866,805 de sobre-pedido y $2.68M de inventario invisible** por un divisor
equivocado, y ADR-057 dejó el resolvedor único (`analytics.v_unit_truth`). Un número sin unidad
en la mano del surtidor reproduce el defecto en el punto donde se toca la mercancía.

---

## 1. Principio de la fase

**El pedido no cambia de dueño ni de identidad.** `commercial.orders` sigue siendo el pedido
maestro con su folio `PD-`. La fase agrega un **segundo eje** —el avance físico— que referencia
al pedido y nunca lo sustituye.

```text
EJE COMERCIAL (existe, no se toca)
  draft → pending_approval → confirmed → fulfilled → cancelled

EJE DE FULFILLMENT (nuevo, esta fase)
  pool → asignado_ola → en_surtido → surtido → desconsolidado → checado → listo_embarque
```

⛔ **Se rechaza ampliar `commercial.orders.status` a los 33 estados del documento** (22
principales + 11 extraordinarios). Razones medidas:

1. El CHECK vivo tiene 5 valores y de él cuelga **todo** el flujo comercial actual (portal,
   vendedor, telemarketing, tienda, bot). Multiplicarlo por siete toca cada consumidor.
2. Mezcla dos preguntas distintas: *¿el cliente ya se comprometió?* y *¿dónde va la mercancía?*
   Cuando un CASE mezcla dos preguntas, la precedencia le miente a una (ADR-057, pasó tres veces
   en una sola fase).
3. Los "estados extraordinarios" del documento (`FALTANTE`, `AGOTADO`, `DIFERENCIA`,
   `SUSTITUCION_PENDIENTE`…) **no son estados: son excepciones abiertas**, y varias pueden
   coexistir sobre el mismo pedido. Un enum no las representa; una tabla de excepciones sí.

---

## 2. Sprints

### SU.0 — El mapa del almacén y la línea base ⛔ CAMINO CRÍTICO

**No es software.** Es el insumo sin el cual el resto no rinde.

- **SU.0.1** Confirmar en **prod** el estado de `warehouse_bins` / `stock_lot_locations`.
- **SU.0.2** Definir la nomenclatura de ubicación (el documento propone `A-01-03`: pasillo–rack–
  nivel) y rotular físicamente el almacén.
- **SU.0.3** Capturar ubicaciones con la UI que ya existe. Cobertura objetivo: **los SKU que
  concentran el 80% de las líneas de pedido**, no el catálogo entero.
- **SU.0.4** ⭐ **Medir la línea base de HOY**: tiempo de surtido por pedido, líneas por hora,
  errores y diferencias, con el proceso actual de WhatsApp.

> ⭐ **Sin SU.0.4 el §47 del documento ("criterio de éxito") es indemostrable.** Pide bajar
> tiempos y errores, y hoy no existe el número contra el cual comparar. Medir después del cambio
> sólo produce una cifra sin antes. Es la misma regla que ya rige los commits de este repo: *un
> commit que cambia un número no se cierra sin la medición del antes/después.*

**Criterio de cierre:** cobertura de ubicación medida y publicada (no "cargamos ubicaciones",
sino *qué % de las líneas de un día real caen en un SKU ubicado*), y una línea base con fecha.

---

### SU.1 — La unidad, antes que las olas

Va **antes** del motor de olas a propósito: consolidar cantidades sin unidad es el defecto de
ADR-055 movido al almacén.

- `order_lines` ya trae el sello de unidad desde `[TO.3]` (`qty_unit` / `qty_factor` /
  `qty_factor_source`). El surtido lo **consume**, no lo reinventa.
- Toda cantidad que se le muestre al surtidor lleva **unidad visible** y el resolvedor único
  `analytics.v_unit_truth` (ADR-057) detrás.
- Lo que no se pueda resolver **se declara** (`NO MEDIDO`), no se muestra como pieza.
- **Granel (232 SKUs en KG):** el flujo `escanear → contar → confirmar` del §13 **no aplica**.
  Necesita captura por peso con tolerancia. Si no entra en el alcance, **se declara y esos SKU
  salen de las olas**, en vez de dejar que el surtidor "redondee".

**Criterio de cierre:** ninguna pantalla de surtido muestra un número sin unidad; un SKU sin
unidad resoluble aparece marcado, no adivinado.

---

### SU.2 — Pool de pedidos

Bandeja de lo autorizado y todavía no asignado (§8). Lectura sobre `commercial.orders`
(`status = 'confirmed'` + sin fulfillment abierto) con los atributos del §8: hora, vendedor,
cliente, ruta, fecha de entrega, líneas, piezas, prioridad.

⚠️ **Offline.** El documento no lo menciona y es condicionante: el vendedor trabaja sin señal
(Dexie + cola de sync en `apps/vendor`). Un pedido creado offline **no existe para el pool hasta
que sincroniza**. El pool debe declarar ese rezago, no asumir que ve todo.

---

### SU.3 — Motor de olas (reglas simples)

`commercial.picking_waves` + `wave_orders` + `wave_lines`. Agrupa por sucursal / fecha de entrega
/ ruta, con tope de pedidos y de piezas. **Sin optimización matemática** — el propio documento lo
pide así (§10) y es correcto.

La consolidación por SKU (§11) guarda **siempre** el desglose por pedido: la ola dice
`Carlos V = 23 PAQ` y por debajo conserva `101→5, 102→8, 103→10`. Ese desglose es lo que hace
posible SU.6.

---

### SU.4 — Interfaz del surtidor

`ubicación → producto → cantidad → confirmar`, con la unidad siempre visible (SU.1) y el orden
por ubicación que ya calcula `pick-suggestion`. Botones grandes, escaneo, una decisión por
pantalla (§44).

---

### SU.5 — Excepciones sin detener el surtido

`commercial.picking_exceptions`: faltante, agotado, dañado, ubicación vacía. **El surtidor
registra y sigue** (§14, regla correcta). La excepción viaja al motor comercial de forma
asíncrona.

⭐ Acá conecta con lo que ya existe: la recuperación (§16) y las sustituciones (§18) son
**Thot + `commercial-recommendations`**, no un motor nuevo. El nivel 3–5 del §16 (otra sucursal,
CEDIS, traspaso express) es **Fase RA**.

---

### SU.6 — Desconsolidación y contenedores

El reverso de SU.3: la ola vuelve a partirse por pedido, cada uno con su contenedor identificado
(QR / código de barras). `commercial.fulfillment_containers`.

---

### SU.7 — Chequeo de salida

Pedido vs surtido vs físico (§20), con incidencia obligatoria cuando hay diferencia: tipo,
cantidad, responsable previo, motivo, usuario, fecha.

⚠️ **`commercial-receiving` NO sirve para esto**: es recepción de proveedor (entrada), no
verificación de salida. Comparte forma, no dominio.

**Segregación de funciones (§21):** quien surtió no puede chequear su propia ola. Es un gate, y
**un gate sin prueba negativa es una intención** (ADR-056): hay que romperlo a propósito una vez
y verificar el rojo.

---

### SU.8 — Distribución de inventario escaso

Reglas parametrizables del §15, con **la regla aplicada registrada en la fila**.

⛔ **Depende de una decisión de fondo abierta** (§3.2): hoy la preventa **no reserva stock**.

---

### SU.9 — Indicadores y cierre

Los del §36–§38, **contra la línea base de SU.0.4**. Sin ese antes, esto es decoración.

---

## 3. Choques a resolver antes de escribir código

### 3.1 ¿Quién dispara la factura?

El documento (§4.4, §22) pone a la cajera a facturar/timbrar. Hoy el CFDI se emite
**automáticamente al fulfillar** (FE.5, best-effort por puerto). Son dos diseños distintos y hay
que elegir uno; el actual tiene la ventaja de que ya funciona y no depende de una persona.

### 3.2 ⭐ Reservar o no reservar

§15 (distribuir escasez con reglas) **exige reservas duras**. Hoy `place()` no toca stock cuando
hay fecha de entrega, y eso es deliberado: `test-newdb-order-reopen` documenta que devolver "la
cantidad de la línea" al reabrir **le suelta el apartado a otro pedido**.

Es la decisión más cara de la fase. Sin reservas, la ola puede prometer mercancía que otra ola ya
se llevó; con reservas, hay que resolver expiración, reabrir y cancelar sobre un stock que
además **no es el system of record** (§3.3).

### 3.3 De dónde sale la existencia

§7 acierta al distinguir teórica de física. Pero el repo ya decidió que la existencia sale de
`analytics.v_erp_stock_on_hand` y **no** de `commercial.stock` (acierta 91%). El documento asume
que la plataforma controla el inventario; hoy el SoR es **Kepler / Wincaja**. Un motor de olas
que reserve sobre una tabla que no manda va a discrepar con el almacén físico.

### 3.4 §30 "alimentar Contabilidad" choca con ADR-040

ContPAQi es el system of record contable/fiscal y la plataforma **lee, jamás escribe directo**.
La integración financiera se redacta como *"genera el asiento y lo entrega"*, no como *"alimenta
contabilidad"*.

### 3.5 El folio

El documento propone `PV-2026-00026845`; el vivo es `PD-YYYY-NNNNN` (`commercial.order_sequences`).
**Se conserva `PD-`.** Dos folios para el mismo pedido es la clase de cosa que después nadie puede
cuadrar.

---

## 4. Lo que el documento acierta y conviene dejar citado

- §31 ("no construir un LLM independiente por cliente") y §33 ("la IA nunca deberá añadir
  artículos automáticamente") llegan por su cuenta a **exactamente** ADR-016/018: *el motor
  decide, el agente comunica, el LLM fuera del camino del dinero*. No es una propuesta nueva: es
  una confirmación, y conviene que el documento lo diga para que nadie la re-litigue.
- §35 (medir **venta incremental real**, no mensajes generados por IA) es el criterio correcto.
- §14 (el surtidor no espera al vendedor) es la regla que evita que una excepción comercial se
  vuelva cuello de botella operativo.
- §40 (modelo de eventos, nunca depender sólo del estado actual) es lo que ya hace
  `order_status_history`.
- §49 (las cinco preguntas antes de construir) — se adopta tal cual.

---

## 5. Orden recomendado

```text
SU.0  mapa del almacén + línea base   ⛔ camino crítico, no es software
  ↓
SU.1  la unidad en la pantalla
  ↓
SU.2  pool ──→ SU.3 olas ──→ SU.4 surtidor ──→ SU.5 excepciones
                                                     ↓
                                    SU.6 desconsolidación ──→ SU.7 chequeo
                                                     ↓
                              SU.8 escasez (bloqueado por §3.2)
                                                     ↓
                                              SU.9 indicadores
```

**MVP = SU.0 → SU.7.** SU.8 espera la decisión de reservas.

---

## 6. Riesgos

| Riesgo | Por qué importa |
|---|---|
| ⛔ SU.0 no se ejecuta | Es trabajo de campo, no de devs. Si no hay ubicaciones, las olas ordenan por un dato vacío y el beneficio prometido no aparece |
| Sin línea base (SU.0.4) | El §47 queda indemostrable: se habrá construido sin poder decir si sirvió |
| El granel (232 SKUs en KG) | No entra en `escanear → contar`. Si no se declara, el surtidor redondea y la diferencia aparece en el chequeo |
| Reservas (§3.2) | Decidir mal cuesta doble: o la ola promete lo que no hay, o se reserva sobre una tabla que no es el SoR |
| Estados | Si se cede y se amplía `orders.status` a 33 valores, toca todos los consumidores del pedido |
| Alcance | El documento son 18 etapas; 10–12 ya existen. Tomarlo literal como backlog reconstruye medio sistema |

---

## 7. Datos que faltan para dimensionar

No los tengo medidos y el plan los necesita:

- **Pedidos de preventa por día y líneas por pedido** en prod (dimensiona el tamaño de ola).
- **Ubicaciones en prod** (SU.0.1).
- **Cuántos surtidores** y en cuántos turnos.
- **Ventana entre cierre de captura y salida del reparto** (define si un traspaso express es
  viable, §17).
