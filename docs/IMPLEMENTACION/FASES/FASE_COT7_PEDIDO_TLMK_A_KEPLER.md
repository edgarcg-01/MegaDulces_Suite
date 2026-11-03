# Anexo COT.7 — La cotización aceptada se arma como «Pedido Telemarketing» en Kepler

> **Anexo de alcance de [`FASE_COT_COTIZACIONES.md`](FASE_COT_COTIZACIONES.md)** — reescribe su
> COT.7 («convertirla en pedido»). Escrito el 2026-11-03.

| | |
|---|---|
| **OBJETIVO** | Que una cotización aceptada no se vuelva a capturar a mano en Kepler: la Suite arma el `U-D-40` con origen `TELEMARK` en el servidor de su sucursal, y Kepler sigue su camino de siempre (autorizar → surtir → checar → embarcar → facturar). |
| **MÉTRICA** | HOY (2026-11-03): **0** cotizaciones llegaron a pedido, y no existe la acción de aceptar (59 vivas, todas `draft`). META: el 100 % de las aceptadas con cliente del ERP llega a Kepler sin recaptura, y **0** diferencias de precio entre la cotización y la factura `U-D-8`. |
| **CAPA TOPE** | C3 (botón en `/telemarketing/cotizaciones/:id`) |
| **ÁREA** | Telemarketing · escribe en el ERP |
| **DUEÑO** | ⚠️ sin asignar (lo decide el PM) |
| **ESTADO** | 🔨 C0 (sólo lectura) desde el 2026-11-03 · C1 en espera de cupo (6 🔨 de 4). Ver D6. |

Medido con `pg-prod` en sólo lectura (`system_identifier` 7688376744939610156), sobre
`kepler_ods.kdm1`/`kdm2` y `commercial.*`, el 2026-11-03.

---

## 1. En una pantalla

Hoy el telemarketista cotiza en la Suite y, si el cliente acepta, **captura el pedido otra vez**
en Kepler (*Ventas › TeleMarketing › Pedido Telemarketing*, `pv_tk_tel_emb.kpl`). Ese pedido es
el documento **`U-D-40` con `c27='TELEMARK'`**: el mismo documento y la misma pantalla que el
«Pedido de Sucursal», separados sólo por el origen (`ERP_KEPLER.md` §3.y.3).

La Suite **ya sabe escribir `U-D-40`**: el sink de KR (`kepler-requisition-sink.adapter.ts`) lo
clona para el traspaso (doctipo `traspaso`, apagado). Y **ya escribe en Kepler en producción**:
la requisición `X-A-30` está encendida en las 9 sucursales desde el 2026-10-28.

| Hecho | Medido |
|---|---|
| Pedidos `U-D-40` TELEMARK en los últimos 30 días | **1,483** en 4 sucursales (01: 529 · 06: 444 · 08: 372 · 05: 138) |
| Su importe (`c16`), 30 días | **≈ $17.1 M** (01: 5.62 M · 08: 6.09 M · 06: 5.26 M · 05: 0.16 M) |
| Cómo nacen | `CREADO` (815 vivos) → `AUTORIZADO` (365) → `SURTIDO` → `CHECADO` → `EMBARCADO` (6,662) |
| Cadena hasta la factura | pedido → embarque `U-D-41` → factura `U-D-8`, por `c37`+`c39`. En la 01, 20 días: **313 pedidos → 295 embarques → 311 facturas** |
| ⭐⭐ ¿La factura re-calcula el precio? | **No.** Renglón a renglón (`kdm2.c12`), 40 pedidos de la 01: **442 de 444 iguales** al centavo (99.5 %) |
| Pedidos TELEMARK a cliente `CONTADO`, 30 días | 5 de 1,483 |
| Cotizaciones vivas en la Suite | 59 `draft`; **45** con cliente del ERP; 0 aceptadas |
| Interruptor de escritura (`commercial.kepler_push_switch`) | `compra` encendida en 00–08 · `traspaso` apagado («hasta desplegar PQ.19, unidad base») |

⭐⭐ **La consecuencia del hecho de en medio:** el precio que la Suite escriba en el pedido **es el
que se le factura al cliente**. Escribir este documento es poner precio de venta, no capturar un
borrador. Por eso el árbitro de precio (C0.2) va antes de cualquier código que escriba.

---

## 2. Cómo cambió el pedido

| # | Lo que se pidió | Efecto |
|---|---|---|
| 1 | COT.7 original (2026-09-22): *«crea un `commercial.orders` normal y lo apunta»* | La Suite tendría su propio pedido; surtido y factura siguen en Kepler, así que habría quedado en doble captura |
| 2 | Edgar, 2026-11-03: *«que la cotización, al aceptarla, se pueda armar el pedido en Kepler. Es "pedido tlmkt"»* | **Deroga el 1.** El destino es el `U-D-40` TELEMARK en Kepler, no `commercial.orders` |

⚠️ Choca en parte con la decisión 2 de COT §5 (*«la captura vive en la Suite»*): esa hablaba de
la **cotización** (`U-D-35`), no del pedido, así que no se contradicen. ADR-092 autorizó escribir
UN documento (`X-A-30`); este anexo pide el segundo y **necesita su propia firma** (D0).

---

## 3. Universo y trabajo

- **Universo:** los ≈ 1,483 pedidos TELEMARK de 30 días (≈ $17.1 M) que hoy se capturan a mano.
- **Trabajo:** sólo los que nacen de una cotización de la Suite. Hoy son **0**: ninguna cotización
  se ha aceptado todavía. Cuánto del universo pasa por cotización: **NO MEDIDO** (necesita que la
  acción de aceptar exista).

## 4. Lo que creíamos y cayó

| # | Lo que decía | Lo que midió prod |
|---|---|---|
| 1 | `CLAUDE.md`: *«la escritura Suite→Kepler está apagada»* | La compra `X-A-30` está **encendida en las 9 sucursales** desde el 2026-10-28 |
| 2 | Kepler re-precia al facturar | Hereda el precio del pedido en el 99.5 % de los renglones |
| 3 | El pedido de sucursal y el de telemarketing nacen igual | Sucursal nace `AUTORIZADO`; TELEMARK nace **`CREADO`** |

---

## 5. Decisiones

> ✅ **D0–D5 firmadas por Edgar el 2026-11-03** («sí, lo que recomiendes»): quedan como la recomendación. D6 la decidió Claude por encargo: ver abajo. ADR-113.

| # | Decisión | Opciones | Recomendación |
|---|---|---|---|
| **D0** | ¿Se autoriza escribir un segundo documento en Kepler (`U-D-40` TELEMARK)? | sí (ADR nuevo que extiende ADR-092) · no (queda la recaptura) | **Sí.** El carril ya existe y está probado en prod con la compra; sin esto, COT.7 es otra doble captura |
| **D1** | ¿En qué estado nace? | `CREADO` · `AUTORIZADO` | **`CREADO`**, igual que los 815 que hoy captura la gente: la autorización (crédito) sigue siendo de Kepler y de quien la hace hoy |
| **D2** | ¿Qué precio se escribe? | el de la cotización · re-cotizar al momento de aceptar | **Re-cotizar al aceptar** (`checkQuote`): si algún renglón cambió de precio en Kepler, la Suite no escribe hasta que el vendedor re-cotice. Nunca un precio vencido, porque es el que se factura |
| **D3** | ¿Cliente sin clave del ERP (prospecto)? | se rechaza · se da de alta en Kepler | **Se rechaza con su porqué.** Hoy 14 de 59 no tienen clave del ERP. Dar de alta clientes es otra escritura y otra firma. `CONTADO` sí es clave válida (5 pedidos así en 30 días) |
| **D4** | ¿Quién puede mandarlo a Kepler? | quien cotiza (con `GESTIONAR` y COT.21: sólo las suyas) · una llave aparte | **Quien cotiza**, con `COMMERCIAL_QUOTES_GESTIONAR`. El freno operativo es el interruptor por sucursal (`kepler_push_switch`, tipo nuevo `telemarketing`, apagado al nacer) |
| **D5** | Vendedor del pedido (`c12`) | el de la cotización (`salesperson_code`) · el del cliente en Kepler | **El de la cotización**, obligatorio. Sin vendedor no se escribe |
| **D6** | Cupo (6 🔨 de 4) | pausar una fase · esperar a que cierre una | ✅ **COT.7 es item de COT, sin fila nueva en el roadmap. C0 (sólo lectura) arranca ya; C1 —lo primero que escribe— espera a que el tablero baje de 4 🔨.** |

---

## 6. Qué NO incluye

- Alta de clientes o prospectos en Kepler (D3).
- Autorizar, surtir, embarcar o facturar desde la Suite: eso sigue en Kepler.
- Editar o cancelar en Kepler un pedido ya escrito: si hay que corregirlo, se corrige en Kepler.
- `commercial.orders`: la cotización no crea pedido de la Suite.
- Credenciales nuevas: usa las `KEPLER_PUSH_URL_NN` que ya existen (regla 7, no se tocan).

---

## 7. Las capas

### C0 — El documento y su árbitro (sólo lectura)

- **`[COT.7.0]` Decodificar el `U-D-40` TELEMARK para ESCRIBIRLO.** Cabecera: `c10` cliente ·
  `c12` vendedor · `c11` estado · `c27` origen · `c85` dirección de envío · `c14`/`c15`/`c16`
  IVA/IEPS/importe · `c63` prefijo · serie `c5` por sucursal · `c24` (texto libre, va la marca
  de la Suite, igual que el traspaso). Renglón: `c8` SKU · `c9`/`c11` cantidad y unidad base ·
  `c51`/`c55`/`c56` pedida y presentación · `c12` precio · `c13` importe · `c17`/`c18`
  impuestos · `c66` lista. Y la lista `limpiar` (responsables de surtido/checado/embarque).
  **Árbitro con respuesta conocida:** reconstruir 20 pedidos TELEMARK reales desde sus propios
  renglones tiene que dar sus mismos `c13` y `c14`/`c15`/`c16` al centavo.
- **`[COT.7.0b]` Árbitro de precio: el motor de la cotización contra Kepler.** Para pedidos
  TELEMARK reales (mismo cliente, SKU, presentación y fecha), ¿cuántos renglones da el motor de
  COT.1 iguales al centavo? Umbral para pasar a C1: **≥ 99 %**, y las diferencias explicadas una
  por una. Si no llega, **no se escribe precio** y se vuelve a D2.
- **`[COT.7.0c]` La unidad.** El traspaso está apagado por la unidad base (PQ.19): ver si lo que
  se resolvió ahí aplica igual a la venta, o qué falta.

### C1 — El doctipo (sólo cuando C0 tenga árbitro)

- Doctipo `telemarketing` en `kepler-doctipo.ts` (`U-D-40`, `c27='TELEMARK'`, `c11='CREADO'`,
  marca en `c24`), plantilla por sucursal y renglón en `kepler-servidores.ts`; mismo sink, sin
  escrituras parciales: si un renglón no resuelve unidad o precio, no se escribe nada.

### C2 — La acción

- `POST /commercial/quotes/:id/to-kepler`: cotización vigente, del autor (COT.21), con cliente
  ERP y vendedor, re-cotizada sin cambios (D2), interruptor encendido. **Idempotente**: guarda
  sucursal y folio de Kepler en la cotización y, si ya los tiene, no vuelve a escribir. Pasa a
  `accepted`. Columnas nuevas *nullable* (compatibles con la API desplegada).
- ⛔ Regla 13: no está probado hasta ejercerlo contra una base real con el payload de la pantalla.

### C3 — El botón

- «Aceptar y armar pedido en Kepler» en el detalle, que muestra el folio `UD40nn-000nnnn` al
  terminar y, si no se puede, el porqué (sin cliente ERP, precio cambió, interruptor apagado).
  Con la skill `diseno` y sus 5 preguntas por escrito.

---

## 7b. C0 — lo medido el 2026-11-03 (sólo lectura, sid 7688376744939610156)

### [COT.7.0] El documento: ✅ con árbitro

Cabecera (`kdm1`), 299 pedidos TELEMARK de 01/06/08 (15 días):

| Regla | Cuadra |
|---|---|
| Sin descuento de cliente: `c16 = Σ kdm2.c13` | 131 / 131 |
| Con descuento: `c16 = Σc13 × (1 − c19/100)` (`c19` = % del cliente) | 168 / 168 |
| `c14` IVA y `c15` IEPS = Σ del impuesto incluido en cada renglón × (1 − c19/100) | 299 / 299 y 299 / 299 |
| `c13` = descuento **sin** impuestos: `(Σc13 − IVA − IEPS) × c19/100` | 168 / 168 |
| `c42` = importe por facturar; `c43` = estado de facturación (`N` → `c42 = c16`; `F` → 0) | el recién creado nace `N` |
| Fijas: `c5=1` · `c7='PESOS'` · `c31='Ped'` · `c40=1` · `c63='PD-'` · `c97='0\|0'` | 1,485 / 1,485 (30 días) |
| `c24` es texto libre (`PEDIDO TIK TOK`, `FACTURA`, vacío en 488) → la marca de la Suite cabe ahí, como en el traspaso | — |
| `c10` cliente · `c12` vendedor · `c22` RFC · `c32`–`c35` nombre y dirección · `c30` condición de pago · `c67` capturista | del cliente en `kdud` |

Renglón (`kdm2`), 581 renglones `CREADO`/`AUTORIZADO`:

| Regla | Cuadra |
|---|---|
| `c9 = c51 × c58` (`c51` piezas en la presentación `c55`; `c58` factor; `c9` en la unidad base `c11`) | 406 / 406 |
| `c12 = round(c57 / c58, 2)` (`c57 = c65` precio de la presentación) | 406 / 406 |
| `c13 = c12 × c9` — **el importe se calcula con la base redondeada** | 406 / 406 |
| `c63` = costo estándar `kdii.c77` (por unidad base); `c62` = costo por presentación | 401 / 406 |
| `c66 = c57 / c58` sin redondear (precio original); difiere en 71 por descuento de volumen | 335 / 406 |
| `c24 = c9` · `c56 = c51` · `c25` = cliente · `c27` = vendedor · `c28='CREADO'` · `c29=1` | 581 / 581 |

### [COT.7.0b] Árbitro de precio: ❌ 98.0 %, abajo del 99 %

El motor REAL de COT.1 (`QuotePricingService.priceLine`, cargado con `tsx`, rol de sólo lectura)
contra 400 renglones `CREADO` de pedidos TELEMARK de ayer y hoy (01/06/08), mismo SKU,
presentación (`c55` como rótulo) y cantidad:

| | |
|---|---|
| Precio por unidad base igual a `c12` (el que se factura) | **392 / 400 (98.0 %)** |
| Precio de la presentación igual a `c57` | 224 / 400 — por centavos: el motor multiplica la base ya redondeada; Kepler, la sin redondear. **No mueve el importe** (`c13 = c12 × c9`), pero el doctipo tiene que escribir `c57` como Kepler |
| Renglones a $0.01 (00917, 00442): el motor no da precio | 2 — correcto, falla cerrada |

Las 6 diferencias reales, una por una:

| SKU | Kepler cobró (base) | Motor | Causa |
|---|---|---|---|
| 97397 ×7 PZA | 108.73 (= lista) | 106.95 | el motor aplica «volumen desde 3 PZA»; Kepler no |
| 03004 ×10 PAQ | 39.83 (lista 43.14) | 36.02 | el motor aplica «volumen desde 3»; Kepler cobró otro precio |
| 97397 ×1 CJA | 106.94 | 99.81 | la escalera de caja del motor (998.11 / caja) no es la de Kepler; y su «volumen» (1,051.58) es **más caro** que la lista |
| 94157 ×5 CJA | 16.39 | 17.30 | lista de caja del motor 176.09 contra ≈ 164 de Kepler |
| 94156 ×5 CJA | 11.02 | 12.19 | idem (125.40 contra ≈ 110) |
| 70500 ×3 KG (factor 2) | 70.08 | 36.29 | unidad: el motor rotula el peldaño `500` y lo trata como base (C0.7.0c) |

⭐ **Es un hallazgo de COT.1, no sólo de COT.7:** las cotizaciones de hoy ya muestran esos
precios. Mientras no se explique, **C1 no arranca** (lo dijo el plan: sin árbitro no se escribe precio).

**Siguiente:** `[COT.7.0d]` — por qué Kepler no aplicó el volumen en 97397/03004 (¿la regla
excluye el canal telemarketing o la lista del cliente?) y de dónde sale la caja del motor en
94156/94157/97397 contra la de Kepler. Con eso, volver a correr el árbitro.


## 8. Riesgos y bloqueos

| Riesgo / bloqueo | Dueño | Causa | Qué lo destraba |
|---|---|---|---|
| Precio mal escrito = factura mal cobrada | quien construya C0.2 | la factura hereda el precio del pedido (99.5 %) | el árbitro de C0.2 en ≥ 99 % antes de C1 |
| Unidad mal escrita (hasta 50× en compras) | idem | mismo problema que apagó el traspaso | C0.3 |
| 02 y 03 sin pedidos TELEMARK en 30 días (sí tienen historia: 2,133 y 861) | ⚠️ sin dueño | **NO MEDIDO**: ¿dejaron de capturar o el ODS no los trae? | medirlo antes de encender esas sucursales |
| Si Kepler re-precia al abrir o autorizar el pedido en `pv_tk` | — | **NO MEDIDO** | probar un pedido en el ERP vivo (como KR: escribir, ver en pantalla, borrar) |
| Cupo | PM | 6 🔨 de 4 | D6 |

## 9. DoD

- [ ] C0 con árbitros (7.0, 7.0b, 7.0c) medidos y publicados
- [ ] ADR que extiende ADR-092 firmado (D0)
- [ ] Prueba negativa de cada compuerta (sin cliente, sin vendedor, precio cambiado, interruptor apagado)
- [ ] Endpoint ejercido contra base real con el payload de la pantalla (regla 13)
- [ ] Un pedido escrito en el ERP vivo, visto en `pv_tk` y facturado al precio de la cotización
- [ ] Permiso repartido e interruptor encendido por sucursal (regla 20)
- [ ] Tracker, log y `MATRIZ_ACCESOS` al día

## Bitácora

- **2026-11-03** — C0.7.0 ✅ (cabecera y renglón con árbitro); C0.7.0b ❌ 98.0 % (6 diferencias explicadas por mecanismo). C1 bloqueado.
- **2026-11-03** — D0–D5 firmadas (Edgar); D6 decidida; ADR-113. Arranca C0.
- **2026-11-03** — Anexo escrito. Medido: 1,483 pedidos TELEMARK / ≈ $17.1 M en 30 días; la
  factura hereda el precio del pedido en 442 de 444 renglones; compra encendida en 00–08.
