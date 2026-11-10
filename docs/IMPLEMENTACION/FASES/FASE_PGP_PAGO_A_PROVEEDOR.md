# Fase PGP — Pago a proveedor, de punta a punta

> El método que la gobierna: [`docs/METODO_DE_TRABAJO.md`](../../METODO_DE_TRABAJO.md).
> Pedido de Edgar, 2026-10-22: *«armar la automatización de todo el proceso de pago a proveedor,
> juntar todo en una interfaz y automatizar todo el proceso»*.

```
OBJETIVO: que un pago a proveedor nazca, se firme, salga y quede asentado en Kepler sin que
          nadie lo vuelva a teclear — y que las 8 pantallas del ciclo sean UNA estación.
MÉTRICA:  pagos del mes ejecutados por la plataforma y ligados a su documento de Kepler
          HOY (2026-10-22, medido): 0 de 154 pagos de octubre = 0.0%
          META: 60% de los pagos a proveedor por transferencia, para 2026-12-15
CAPA TOPE: C3
ÁREA:      Finanzas
DUEÑO:     <por asignar — ver §6>
ESTADO:    ✅ medido 2026-11-09: pago↔banco misma cuenta ±ESTADO:     ±5 días 65/87, placebo 0; comprobante↔banco por la cuenta de origen del OCR 87/90, placebo 0; sólo 7 % de los pagos traen cuenta de origen; el catálogo de CLABE de proveedores está vacío; la ventanilla sólo deja rastro después de Kepler (no abre hasta que haya cupo — ver §6)
```

---

## 1. Qué problema resuelve

**El motor ya está construido y no ha movido un solo peso.**

Medido contra prod el 2026-10-22 (`system_identifier 7688376744939610156`, sólo lectura `dev_ro`):

### El universo

| Hecho | Medido |
|---|---:|
| Deuda viva a acreedores | **$138,422,806** en 2,941 documentos / 373 proveedores |
| …de ella, mercancía (`C*`) | $92,740,999 — **$57,972,816 ya vencida (62.5%)** |
| Pago a proveedor por mes (jul–sep) | $41.9M – $48.0M · 346–583 movimientos · 144–197 proveedores |
| Octubre a la fecha | 154 pagos · $22,763,014 |
| Medio real en octubre (`c45`) | banco 102 pagos/$20.21M · caja 49/$1.93M · puente 4/$0.63M |

### Lo que la plataforma ya tiene

El motor del Calendario de Pagos (Fase TP) cubre el ciclo entero: armar el pago → proponer el
orden del día → preparar método/banco/caja (valida la CLABE con dígito de control) → autorizar el
lote → ejecutar → ligar con el documento de Kepler → cerrar el día → PDF preliminar y de Caja
General. Son 1,252 líneas de servicio y 24 endpoints de escritura, más 8 pantallas vivas.

### Lo que no ocurre

| Hecho | Medido |
|---|---|
| Pagos armados en el calendario desde el 16-oct | 13 — **10 `pending` ($2,699,022) + 3 `cancelled` ($1,723,658)** |
| Lotes de día creados | 6 — **los 6 en `draft`** |
| Lotes autorizados | **0** |
| Pagos ejecutados | **0** |
| Pagos ligados a su documento de Kepler | **0 de 13** |
| Pagos que el ERP sí registró en esa misma ventana (16–21 oct) | **34 · $5,107,063** |
| **Cobertura efectiva de la plataforma** | **0%** |

### Dónde se detiene exactamente, y por qué

⚠️ **La primera lectura fue equivocada y queda escrita para que nadie la repita:** parecía que
faltaba la firma de Dirección. No es eso. Medido pago por pago el 2026-10-22:

| Paso del circuito | Estado | Medido |
|---|---|---|
| 1. Tesorería arma el pago | ✅ ocurre | 13 pagos armados |
| 2. Tesorería le da orden de pago | ⚠️ a medias | **6 de 10 sin `priority_rank`** |
| 3. **Tesorería lo prepara** (método · cuenta origen · cuenta destino) | ⛔ **nunca ocurrió** | **0 de 10.** Los 10 sin método, sin origen y sin destino |
| 4. Dirección autoriza el lote | ⛔ imposible | `releaseLot` rechaza el día si **un solo** pago está sin preparar |
| 5. Caja General ejecuta | ⛔ bloqueado por el 4 | 0 |
| 6. Se liga al documento de Kepler | ⛔ bloqueado por el 5 | 0 |

⭐ **O sea: aunque Dirección hubiera entrado a firmar, el botón le habría devuelto un 400.** La
capacidad del día **sí** está definida en los 6 días ($2.15M–$6.18M autorizados) y el consumo cabe
en todos. Lo único que falta es el paso 3.

⭐⭐ **Y el paso 3 no se puede dar, porque `commercial.supplier_payment_accounts` tiene CERO
filas.** Preparar una transferencia exige cuenta destino: del catálogo, o CLABE tecleada a mano.
Sin catálogo, preparar un pago es teclear 18 dígitos sin red. El circuito anti-fraude de TP.7
(toda alta pasa por solicitud) existe completo y nunca se usó —
`supplier_payment_account_change_requests` también está en cero.

**El nudo es uno solo: sin cuentas de proveedor sembradas, el circuito entero no arranca.**

Lo demás que quedó sin alimentar:

- **`finance.financial_commitments`: 0 filas.** El origen de obligación de Finanzas no se alimenta.
- **`finance.payment_program` quedó congelado**: 2,716 filas de una carga única del **2026-08-08**.
  El Excel `PROGRAMA PAGOS 2026.xlsx` sigue siendo el libro vivo, fuera de la plataforma.
- **La doble captura sigue intacta**: Carmen en Access Control y Mayra en Kepler `X-D-26`, sin
  llave que las una (Δ 2026: 30 movimientos / $185,812).

⭐ **Por eso esta fase no empieza por construir pantallas.** Empieza por hacer que el circuito
cierre **una vez**, con un pago real. Lo demás ya existe y está esperando.

---

## 2. Qué NO incluye

- **No reemplaza a ContPAQi** como sistema de registro contable (ADR-040). El asiento sigue saliendo
  por el puente CP.
- **No toca cobranza ni clientes.** Es sólo el lado que paga.
- **No importa el Excel de Tesorería otra vez.** `payment_program` se retira cuando el circuito
  nuevo cubra el mes completo, no antes, y hasta entonces queda como testigo independiente.
- **No escribe pagos en efectivo a Kepler en la primera entrega** — ver D1 en §5.
- **No crea una segunda materialización de la deuda.** El estado de cuenta sale de la vista sobre
  `kepler_ods` que ya construyó la Fase ECA.

---

## 3. Objetivos, entregables y orden

Cinco objetivos. Cada uno tiene **su propio número medido hoy**, su entregable y su prioridad por
**dinero en juego × esfuerzo** (método §3.1). Se hacen **en este orden** porque cada uno destraba
al siguiente — no por preferencia.

### O1 · Que el circuito cierre una vez — «PGP-A»

> **Qué cambia:** Tesorería puede preparar un pago sin teclear 18 dígitos a ciegas, y un lote
> llega a ejecutarse de punta a punta.
> **Métrica:** pagos con cuenta destino del catálogo — **HOY: 0 de 10 pendientes (0%)** →
> **META: el primer lote autorizado y ejecutado**, antes del 2026-11-07.
> **Dinero en juego:** Alto — destraba los $45M/mes del proceso entero · **Esfuerzo:** S
> (el circuito de TP.7 ya está construido, falta alimentarlo) · **Prioridad: 1**

⭐ **El atajo que lo hace S y no L:** no hay que sembrar 169 proveedores. Medido jul–oct 2026 sobre
los pagos por banco ($129,254,884): **10 proveedores cubren el 50% del dinero y 37 cubren el 80%**.

⛔ **Y la CLABE no se puede derivar: hay que capturarla.** Se midió: de 14,456 salidas bancarias
desde julio, **24 traen 18 dígitos seguidos en el concepto (0.17%)**. El estado de cuenta trae el
**nombre del beneficiario** (`raw_code = '510'`), no su cuenta. La CLABE vive hoy en la banca en
línea de Tesorería y en el Excel — no en ninguna tabla nuestra (`catalog.suppliers` **no tiene**
ninguna columna de banco).

⚠️ **Tampoco se sugiere el beneficiario del banco, y eso también se midió antes de prometerlo:**
cruzar el nombre del estado de cuenta contra el proveedor de Kepler por las primeras tres palabras
normalizadas casa el **36.1 % (61 de 169)**, y **sin control placebo eso no se distingue de ruido**
— es la trampa que ya cobró en el cruce folio↔entrada (86.7 % de señal contra 83.7 % de placebo).
En su lugar, cada renglón trae **el último pago real (fecha y monto al centavo)**, que es exacto y
sirve para ubicar al beneficiario en la banca en línea por importe.

**Entregables:**

| # | Entregable | Quién lo usa |
|---|---|---|
| E1.1 | 🧪 **Lista de a quién le falta cuenta**, ordenada por dinero, con la cobertura arriba y el renglón donde se cruza el 80 % marcado — `[PGP.1]`, 2026-10-22 | Tesorería · Compras |
| E1.2 | Las 37 cuentas dadas de alta por el circuito de solicitud de TP.7 (solicita Compras, aprueba quien tiene `FINANCE_PAYMENT_CALENDAR_AUTORIZAR`) | Tesorería · Dirección |
| E1.3 | 🧪 **El trabajo detenido aparece en «Mi trabajo»**, en dos bandejas: lo que falta **preparar** y los días que faltan **autorizar** — `[PGP.3]`, 2026-10-22. ⚠️ Su migración **no está aplicada en prod** | Tesorería · Dirección |
| E1.4 | **Un lote real recorrido entero**, con su acta: armado → ordenado → preparado → autorizado → ejecutado | todos |

⚠️ **Bloqueo con nombre:** E1.2 depende de una persona de Tesorería con acceso a la banca en
línea. Sin esa persona asignada, O1 no arranca y el resto no existe.

### O2 · Que el día de pago se arme en la plataforma, no en el Excel — «PGP-B»

> **Qué cambia:** el programa de pagos del mes nace en la plataforma; el Excel pasa a testigo.
> **Métrica:** pagos del mes que nacen en el calendario — **HOY: 13 armados contra 154 pagos
> reales de octubre (8.4%), de los cuales 0 ejecutados** → **META: 60% de los pagos por
> transferencia, 2026-12-15.**
> **Segunda métrica, medida el 2026-10-22:** la deuda viva de mercancía con obligación en el
> Calendario — **HOY: 33 de 1,740 documentos (1.9 %) · $2,714,042 de $92,846,437 (2.9 %)**.
> **Dinero en juego:** Alto · **Esfuerzo:** M · **Prioridad: 1**

**Entregables:**

⚠️ **E2.1 cambió de forma al medirlo, y el cambio importa.** Decía «precargar las obligaciones
desde la deuda viva». Medido el 2026-10-22, el mecanismo **ya existe y está bien hecho**:
`[TP.15]` crea la obligación al aceptar un renglón de entrega de compra, y la crea **por el
pendiente vivo de Kepler** (`v_supplier_payables`), no por el importe de la entrega — una decisión
que ya evitó ofrecer para pago 21 de 38 documentos que no debían nada.

Lo que falta no es el mecanismo: es que **cubre el 2.9 % del dinero**.

| | Documentos | Pendiente |
|---|---:|---:|
| Deuda viva de mercancía (`C*`) | **1,740** | **$92,846,437** |
| …con obligación en el Calendario | **33 (1.9 %)** | **$2,714,042 (2.9 %)** |

Y el embudo dice por qué: de **481** renglones de entrega, **66 aceptados** y **414 en
«entregado»** —esperando que alguien los decida—; el camino **arrancó en octubre de 2026**, hace
tres semanas.

⭐⭐ **Eso destapa que son DOS poblaciones, no una, y sólo la primera tiene camino:**

1. **La compra nueva.** Entra por entregas y se vuelve obligación al aceptarla. Su cuello es
   humano: 414 renglones sin decidir.
2. **La deuda preexistente — $90.1 M en 1,707 documentos — no tiene NINGÚN camino.** Nunca pasó
   por una entrega y nunca va a pasar. Incluye los **539 documentos con más de 90 días vencidos**
   ($10.3 M) y los 432 de 1 a 30 días ($30.1 M).

⛔ **Y no se arregla con un importer** (regla principal): copiar 1,707 filas del ODS a
`supplier_payment_obligations` crearía una segunda materialización de una deuda que ya vive en
`kdxe`. Lo que corresponde es **elegirla de la deuda viva**: ofrecer los documentos pendientes
que todavía no tienen obligación y crearla **a demanda, con su procedencia** (`kepler_sucursal`,
`kepler_doc_tipo`, `kepler_doc_sub`, `kepler_folio` — columnas que la tabla **ya tiene** y que
`[TP.15]` ya llena). Es una obligación por documento elegido, no un volcado.

| # | Entregable | Quién lo usa |
|---|---|---|
| E2.1 | **Elegir del pendiente vivo lo que se va a programar**: la deuda sin obligación, por antigüedad y monto, y crear la obligación con su procedencia al elegirla. Reusa el `INSERT` de `[TP.15]`, no inventa otro | Tesorería · Compras |
| E2.1b | Destrabar los **414 renglones de entrega sin decidir** — es trabajo de personas, no de código: va a la bandeja de `[PGP.3]` | Compras |
| E2.2 | **Tope de firma por monto** (D2): Tesorería autoriza ≤ $100,000, Dirección arriba | Tesorería · Dirección |
| E2.3 | El pronto pago entra al armado del día: lo que vence primero se propone primero | Tesorería |
| E2.4 | `finance.financial_commitments` alimentado (hoy 0 filas) | Finanzas |

### O3 · Una sola captura: el `X-D-26` lo escribe la plataforma — «PGP-C»

> **Qué cambia:** se acaba la doble captura (Carmen en Control · Mayra en Kepler).
> **Métrica:** pagos ejecutados con su documento de Kepler escrito por la plataforma —
> **HOY: 0 de 13 (0%)** → **META: 100% de los ejecutados por transferencia.**
> **Dinero en juego:** Alto · **Esfuerzo:** L · **Prioridad: 2**

**Entregables:**

| # | Entregable | Quién lo usa |
|---|---|---|
| E3.1 | Armador del `X-D-26`: clona plantilla, pisa campos de negocio, folio `MAX+1` | — |
| E3.2 | Las aplicaciones `kdxf` del pago (1 factura, o las 8 del caso máximo medido) | — |
| E3.3 | Compuerta: no se escribe a Kepler lo que no esté autorizado y ejecutado, **con su prueba en rojo** | — |
| E3.4 | Conciliador diario: `kdm1` vs `kdxe` por folio — si no da 1:1, hay un pago escrito a medias | Tesorería |
| E3.5 | Interruptor de apagado por variable de entorno, como en KR | Plataforma |

⚠️ Arranca **sólo por transferencia** (102 de 155 pagos de octubre, $20.21M de $22.76M = 88.8% del
dinero). El efectivo espera el dictamen de Contabilidad — ver §6.

### O4 · Una sola estación de trabajo — «PGP-D»

> **Qué cambia:** la pregunta «¿qué pago hoy y con qué dinero?» se responde sin cambiar de pantalla.
> **Métrica:** pantallas que hay que recorrer para responderla — **HOY: 8 pantallas en 2 módulos,
> 4 de ellas fuera de la entrada «Pagos»** → **META: 1 estación.**
> **Dinero en juego:** Medio · **Esfuerzo:** L · **Prioridad: 3**

⛔ **No arranca hasta que O1 y O3 estén verificados.** El método no deja subir a C3 sin C2 cerrada,
y una estación construida sobre un circuito que nunca ejecutó un pago es exactamente lo que
produjo los 330 items 🧪 del tracker.

**Entregables:** la estación (E4.1), las 4 pantallas sueltas absorbidas (E4.2), y el permiso propio
de «Cuentas por pagar», que hoy se gatea con `FINANCE_AI_CHAT` (E4.3).

### O5 · Retirar el Excel de Tesorería — «PGP-E»

> **Qué cambia:** deja de existir un libro paralelo que nadie concilia.
> **Métrica:** meses del año cubiertos por la plataforma sin el importer — **HOY: 0 (la última
> carga de `payment_program` es del 2026-08-08)** → **META: un mes completo cuadrado al 99%.**
> **Dinero en juego:** Bajo (no mueve dinero: quita trabajo) · **Esfuerzo:** S · **Prioridad: 3**

⚠️ **El Excel no se apaga antes de que O2 cubra un mes entero.** Hasta entonces es el único testigo
independiente del circuito nuevo, y se conserva a propósito.

### O6 · La cuenta destino se propone sola, desde el comprobante del propio proveedor — «PGP-F»

> Pedido de Edgar, 2026-10-28: *«ya sabemos a qué cuenta; automaticemos ese autorrellenado»*.

**Qué cambia:** hoy, preparar un pago exige que alguien **teclee la CLABE** del proveedor, y el
catálogo del que debería salir (`commercial.supplier_payment_accounts`) tiene **0 filas** —
medido el 2026-10-28, sid `7688376744939610156`. Por eso ningún pago se prepara solo.

⭐ **La fuente no es un dicho ni una captura: es el propio proveedor.** Cuando nos cobra, timbra
un **REP** y en él declara `CtaBeneficiario` — la cuenta a la que quiere que le paguen, firmada
por él ante el SAT. Eso ya está en `fiscal.cfdi_payment_links`, y `[PGP.27]` acaba de hacerlo
alcanzable para más acreedores al resolver su RFC.

**Lo medido hoy, y lo que NO alcanza:**

| | acreedores |
|---|---:|
| declaran alguna cuenta en su REP | **63** |
| …con **UNA CLABE de 18 válida** (dígito de control incluido) | **21** ✅ |
| …con **varias** CLABE distintas: hay que elegir, no se propone | 2 |
| …con 18 dígitos que **no pasan** el dígito de control | 2 |
| …sólo con cuenta de **10 dígitos**, que **NO es una CLABE** | **36** ⛔ |

⛔ **Los 36 de 10 dígitos no se pueden completar.** Una CLABE es banco(3) + **plaza(3)** +
cuenta(11) + control(1), y la plaza no está en ningún lado nuestro. 522 de esos REP sí traen el
RFC del banco, y **aun así no alcanza**. Esos 36 siguen necesitando que el proveedor la dé.

**Métrica:** cuentas de proveedor sembradas con evidencia — **HOY: 0** → **META: 21**, que cubren
**165 documentos · 15 acreedores · $10,251,411** de deuda viva (de $140,700,697 totales, **7.3 %**).
⭐ **38 de esos 165 documentos sólo se alcanzan por el RFC que `[PGP.27]` resolvió por nombre**:
sin ese trabajo previo, este objetivo valía un quinto menos.
**Dinero en juego:** Alto · **Esfuerzo:** S · **Prioridad: 1**

⚠️ **Verificación obligatoria antes de sembrar una sola:** el dígito de control de la CLABE
(Banxico, pesos 3·7·1 sobre los 17 primeros). Control negativo ya corrido: **39 de 42 cuentas
reales de 18 dígitos lo pasan, y 0 lo pasan con el último dígito movido** — o sea que el
verificador mide algo y no bendice cualquier cadena.

### O7 · La solicitud de cuenta se arma sola; la persona sólo FIRMA — «PGP-G»

> Pedido de Edgar, 2026-10-28: *«automaticemos también lo de solicitar cuenta»*.

**Qué cambia:** dar de alta la cuenta de un proveedor pasa hoy por
`supplier_payment_account_change_requests`: alguien la solicita tecleándola y Gerencia aprueba.
El trabajo caro no es aprobar, es **conseguir y teclear el dato**. Con O6, el sistema **arma la
solicitud ya llena**, con la CLABE que el proveedor declaró y **el UUID del REP como evidencia
adjunta**, y la persona sólo decide.

⛔⛔ **Lo que NO se automatiza, y es deliberado: la FIRMA.** El flujo de alta de cuenta es un
control **anti-fraude** —`requested_by` ≠ `decided_by`, nunca alta directa— y cambiar la cuenta
de un proveedor es exactamente el movimiento que un fraude necesita. La propuesta nace en
`pendiente` y **jamás se auto-aprueba**. Es la misma línea que trazó `[VE.3]`: *automatizar una
decisión no es quitar un botón innecesario, es quitarle la firma a quien responde por ella.*

**Qué gana quien firma, que hoy no tiene:** de dónde salió la cuenta (REP timbrado, con su UUID),
desde cuándo, cuántas veces la declaró, si cambió respecto de la anterior, y si el RFC con el que
se buscó vino de Kepler o lo resolvió el nombre (`rfc_fuente`, `[PGP.27]`).

**Métrica:** solicitudes de alta que llegan **ya llenas y con evidencia** — **HOY: 0 de 0** →
**META: 21 armadas solas**, 0 tecleadas, 0 auto-aprobadas.
**Dinero en juego:** Alto (es el tapón de O1) · **Esfuerzo:** S · **Prioridad: 1** · depende de O6.

⚠️ **Una cuenta que CAMBIA no se trata como una nueva.** Si el REP más reciente declara una CLABE
distinta de la activa, eso **no** se aplica solo: se levanta una solicitud de **cambio** marcada
como tal. Un cambio silencioso de cuenta es, literalmente, el fraude que este flujo existe para
impedir.

### ⛔ Lo que NO se va a autorrellenar, y por qué — la cuenta de ORIGEN

> Se escribe acá para que nadie lo vuelva a abrir: **se midió y la premisa no se sostiene.**

Sabemos perfectamente **con** qué cuentas pagamos: las **16** cuentas de tesorería que aparecen en
`analytics.erp_supplier_payments.cuenta_tesoreria` (de `kdm1.c45`), y el dato está **completo** —
**1,992 de 1,992 pagos por banco** de los últimos 365 días la traen, por $377,322,895. Lo que
**no** se puede es adivinar **cuál toca** para un pago nuevo:

| Si se propusiera… | grupos con una cuenta dominante ≥80 % | dinero que cubriría |
|---|---:|---:|
| por **acreedor** | 51 de 206 | $39,273,481 de $377,322,895 (**10.4 %**) |
| por **sucursal** | **0 de 1** | **0 %** |
| por sucursal + acreedor | 51 de 206 | 10.4 % |

⭐ Y la segunda fila explica la primera: **todos los pagos a proveedor salen de la sucursal `00`**,
con 16 cuentas y la más usada apenas en el 23 %. La cuenta de origen **no es un atributo del
proveedor: es una decisión de Tesorería sobre la liquidez del día**. Proponerla por acreedor sería
dibujar un patrón que no existe, y acertaría 1 de cada 10 pesos.

**Lo que sí corresponde**, y ya existe: elegirla **una vez por lote** (`bulkOriginId` en el paso 2
del Calendario), no una vez por pago.

> ⚠️ **Este no-objetivo se puso en duda el 2026-10-28 y SOBREVIVIÓ.** Una medición nueva contó
> **146 de 316 acreedores (46.2 %)** con cuenta dominante ≥90 % y pareció contradecirlo. No lo
> contradice: **contaba acreedores, no dinero**. Pesada por dinero, la propuesta cubre
> **$23,490,265 de $461,837,979 = 5.1 %** — *peor* que el 10.4 % de arriba, porque los acreedores
> estables son los chicos. ⭐ **La lección es la de siempre: un denominador distinto no es una
> cifra mejor.** Lo que sí resultó cierto es otra cosa, y es `[PGP.30]`: el **método** cubre
> **$403,483,667 = 87.4 %** del dinero.
>
> Y apareció la razón fina de por qué la cuenta no sube: de 154 acreedores con cuenta resuelta,
> **116 pagan desde CAJA GENERAL**, que el selector de origen excluye a propósito («la caja no es
> origen de una transferencia»). No es que el patrón no exista: es que **el patrón apunta a una
> cuenta que no es elegible**. Esos 116 ahora se **informan** en el diálogo en vez de callarse.

### O8 · El método de pago se precarga del hábito del acreedor — «PGP-H»

> Pedido de Edgar, 2026-10-28, mirando la pantalla: *«aquí todavía me pide asociarlo»*.

**Qué cambia:** el Calendario pedía **método** y **cuenta de origen** a mano, pago por pago. Los
dos pagos de ese día estaban detenidos con el rótulo «Falta el método» — $550,411.04 esperando un
desplegable.

**Lo que la casa ya sabía**, medido contra prod sobre 4,881 pagos de 316 acreedores:

| | acreedores | dinero |
|---|---:|---:|
| método dominante ≥80 % | **288 de 316 (91.1 %)** | **$403,483,667 (87.4 %)** |
| el método repite el del pago anterior | 250 de 282 (88.7 %) | |
| transferencia, sobre todos los pagos | | 92.6 % |

⛔ **Y por eso NO se autorrellena con el promedio:** **J&F ENTERPRISE se paga con cheque 16 de 16
veces**. Poner «transferencia» porque es el 92.6 % global le erraría justo al pago que estaba
frenado en pantalla. El hábito del acreedor **gana** al valor del lote.

**Lo que se construyó:** vista `analytics.v_supplier_payment_habit` (migración `20261028163649`,
**292 ms**) + `GET /finance/payment-calendar/payment-habits` + precarga en el diálogo de preparar.

⛔⛔ **Nada se aplica solo.** El valor llega **editable** y con **su evidencia al lado**: «así se le
pagó 16 de 16 veces, la última el 2026-10-19, desde BB 4166». Un número puesto solo, sin decir con
qué, es una orden disfrazada.

**Y cuando no precarga, lo dice** en vez de quedarse callado: `caja_general` (116 acreedores —
dato que no estaba en ninguna pantalla), `variable`, `no_resuelve`, y si la **carga falla**, «no se
pudo leer con qué se le suele pagar» (ADR-056), nunca dibujado como «no tiene hábito».

**Lo que esta vista NO puede proponer, declarado:** Kepler (`kdm1.c31`) sólo distingue
`transferencia`, `cheque` y `anticipo`. **`efectivo` y `cargo_automatico` nunca se proponen** —
ausencia de propuesta **no es** evidencia de que no se usen — y `anticipo` se excluye porque no es
un método, es la naturaleza del documento.

⚠️ **Sin validación visual**: la pantalla no se levantó (prohibido compilar en local). Tipa,
plantillas verdes, `check:pantalla` 0 fallas nuevas — pero nadie la vio.

### Resumen del orden

| Objetivo | Fase | Dinero | Esfuerzo | Prioridad | Depende de |
|---|---|---|---|---|---|
| O1 · El circuito cierra una vez | PGP-A | Alto | S | **1** | una persona de Tesorería |
| O2 · El día se arma en la plataforma | PGP-B | Alto | M | **1** | O1 |
| **O6 · La cuenta destino se propone sola** | **PGP-F** | **Alto** | **S** | **1** | `[PGP.27]` aplicado |
| **O7 · La solicitud de cuenta se arma sola** | **PGP-G** | **Alto** | **S** | **1** | O6 |
| O3 · Una sola captura (Kepler) | PGP-C | Alto | L | **2** | O1 · ADR-092 ext. |
| O4 · Una sola estación | PGP-D | Medio | L | **3** | O1 · O3 verificados |
| O5 · Retirar el Excel | PGP-E | Bajo | S | **3** | O2 con un mes completo |

⭐ **O6 y O7 se cuelan delante de O3 a propósito:** O1 está detenido porque **no hay una sola
cuenta de proveedor sembrada**, y entre los dos siembran 21 con evidencia fiscal y esfuerzo S.
Son el tapón de O1, no un adorno.

---

## 4. Las capas

### C0 · Dato

| # | Item | Estado | Verificado contra |
|---|---|---|---|
| PGP.0.1 | Decode del documento de pago `X-D-26`: qué tablas escribe y con qué llave | 🧪 **medido 2026-10-22** | Ver cuadro abajo |
| PGP.0.2 | Columnas `NOT NULL` de `md.kdm1`, `md.kdxe` y `md.kdxf` + **qué puede tocar `kepler_push`** | 🧪 **medido 2026-10-22** | Catálogo de `md_00` (`192.168.9.95`). Ver «el bloqueo de O3» abajo |
| PGP.0.3 | Documento plantilla de `X-D-26` para clonar, por sucursal | 🧪 **candidata 00/1/0023768** (2026-11-04) | Un pago real reciente del `00`, leído entero |
| PGP.0.4 | Precedente de `c45` (cuenta de tesorería) por banco de origen | 🧪 **18 de 18 resuelven** (2026-11-04) | El decode de `c45` + estado de cuenta CB |

**Lo ya medido en PGP.0.1** (sucursal `00`, sep–oct 2026, contra el ODS):

| Tabla | Qué guarda del pago | Cuántas filas por pago |
|---|---|---|
| `kdm1` | el documento (`c2='X'`, `c3='D'`, `c4=26`) | 1 — folio **denso**, máximo `0023531` |
| `kdm2` | — | **0.** El pago no tiene renglones, a diferencia de la requisición de KR |
| `kdxe` | el documento de cuentas por pagar (`c3='D'`, `c4=26`) | 1 |
| `kdxf` | el casamiento: qué facturas cubre | **1 en 3,602 pagos · 2 a 8+ en 269** |

⭐ **La correspondencia `kdm1` ↔ `kdxe` es exacta: 3,513 documentos de un lado, 3,513 del otro,
3,513 casan por folio.** Cero huérfanos en cualquier dirección. Eso da el testigo de integridad
gratis: un pago escrito a medias se detecta al instante comparando los dos conteos.

⛔ Sin importer: todo sale del ODS por vista. La unidad acá es el peso y se prueba de los dos lados
(importe de `kdxe.c11` contra la suma de `kdxf.c10` aplicado).

#### ⛔⛔ El bloqueo de O3: hoy NO se puede escribir el pago, y no es por el código

Medido el 2026-10-22 contra el Kepler vivo (`md_00`, `192.168.9.95`), con el usuario
`kepler_push` que la Fase KR dejó configurado. Sólo lectura del catálogo del sistema:

| Tabla | Existe | Filas | Columnas | `NOT NULL` | `kepler_push` puede |
|---|---|---:|---:|---:|---|
| `md.kdm1` | sí | 130,544 | 200 | **200** | SELECT · **INSERT** |
| `md.kdm2` | sí | 263,870 | 70 | **70** | SELECT · **INSERT** |
| `md.kdxe` | sí | 45,574 | 31 | **31** | ⛔ **nada** |
| `md.kdxf` | sí | 29,932 | 11 | **11** | ⛔ **nada** |
| `md.kdxd` | sí | 769 | 36 | 36 | ⛔ **nada** |
| `md.kdmm` | sí | 167 | 61 | 61 | ⛔ **nada** |
| `md.kdfolio` | sí | 2 | 3 | 3 | SELECT · UPDATE |

⭐ **`kepler_push` puede tocar 3 de las 360 tablas de `md`.** El acceso se acotó a lo que la
requisición `X-A-30` necesitaba, y el pago necesita otra cosa: medido en C0, un `X-D-26` escribe
en **tres** tablas (`kdm1` + `kdxe` + `kdxf`) y tenemos privilegio sobre **una**.

⛔ **La hipótesis que lo habría salvado está refutada:** no hay **ningún** trigger ni regla sobre
`kdm1`, y `kdxe`/`kdxf` son tablas reales, no vistas. **El ERP no deriva solo** el documento de
cuentas por pagar a partir del movimiento: lo escribe su propia aplicación. Insertar sólo en
`kdm1` dejaría un pago que mueve el inventario de documentos y **no baja la deuda del proveedor**
— peor que no escribirlo.

⚠️ **Y tampoco se puede deshacer una prueba:** `kepler_push` no tiene `DELETE` sobre ninguna de las
tres. El protocolo que usó KR —escribir, verificar en pantalla, borrar— lo cerró alguien con otra
cuenta; conviene saberlo antes de planear la prueba, no durante.

**Qué lo destraba** (lo ejecuta el dueño de las tablas, que es `sa`):

```sql
GRANT SELECT, INSERT ON md.kdxe, md.kdxf TO kepler_push;  -- el pago y sus aplicaciones
GRANT SELECT          ON md.kdxd, md.kdmm TO kepler_push;  -- validar acreedor y tipo de documento
```

⭐ **`DELETE` no se pide, a propósito.** Darle a un usuario de aplicación permiso de borrar en el
ERP es un riesgo permanente a cambio de una comodidad de un día. El borrado de los documentos de
prueba lo hace quien administra Kepler, que es el mismo patrón que ya se siguió en KR.

#### ⭐ C0 de O3 re-medido (2026-11-04, `[PGP.71]`) — y el permiso que faltaba pedir

Medido contra `kepler_ods` en prod (sólo lectura), sobre los **471 pagos `X-D-26` por transferencia a
proveedores de compra** (`c10 LIKE 'C%'`, sin Caja General) de oficinas, agosto–noviembre 2026. Hoy
**no se pudo** volver a leer el catálogo del Kepler vivo: `md_00` rechaza la conexión desde la máquina
de trabajo (`pg_hba.conf`), así que **los permisos de `kepler_push` siguen NO MEDIDOS** desde el 22-oct.

⛔⛔ **Corrección al «qué lo destraba» de arriba: falta un `UPDATE`.** Kepler **guarda** el saldo de
cada factura en `kdxe.c20`: en 2,072 de 2,081 facturas abiertas es igual a importe − aplicado
(control placebo contra el saldo de otra factura del mismo acreedor: 45 de 1,223). El pago, a su vez,
deja su propio remanente en su `kdxe.c20` (23,663 de 23,963). Ni `kdm1` (`c42` = total en 8,609 de
8,609 entradas) ni el catálogo `kdxd` guardan saldo. Escribir el pago sin bajar `c20` dejaría la
factura **debiéndose en Kepler** con el pago ya escrito. El pedido correcto es:

```sql
GRANT SELECT, INSERT     ON md.kdxe, md.kdxf TO kepler_push;  -- el pago y sus aplicaciones
GRANT UPDATE (c20)       ON md.kdxe          TO kepler_push;  -- ⭐ el saldo de la factura, y sólo esa columna
GRANT SELECT             ON md.kdxd, md.kdmm, md.kdxv, md.kdb1 TO kepler_push;  -- acreedor, tipos, conceptos, bancos
```

**El documento, campo por campo** (lo que no está aquí se copia de la plantilla: 166 de las 200
columnas de `kdm1` tienen **un solo valor** en los 471 pagos):

| Campo | Qué es | Regla | Medido |
|---|---|---|---|
| `kdm1.c16` = `c42` = `kdxe.c11` = `c17` | importe | el del pago | 471 / 471 |
| `kdm1.c11` = `kdxe.c16` | referencia | el folio de la Suite | 471 / 471 |
| `kdm1.c45` = `kdxe.c22` | cuenta de tesorería (`kdb1`) | la cuenta de origen | 471 / 471 · las **18** cuentas bancarias de la Suite resuelven a **un** código cada una |
| `kdm1.c12` = `kdxe.c18` | concepto (`kdxv`: C-001 CEDIS, C-010 MORELIA ABASTOS…) | el de las facturas | 414 / 471 · ⚠️ 64 pagos mezclan conceptos: **se rechazan** (ver abajo) |
| `kdm1.c48` | la sucursal, en texto | el nombre del concepto | C-001→CEDIS 254 · C-010→MORELIA ABASTOS 83 · C-020→CANINDO 42 (Kepler la teclea con dedazos) |
| `kdm1.c81` / `c82` / `c84` | IVA redondeado / sin redondear / IEPS | Σ aplicado × impuesto ÷ total de cada factura | **471 / 471** (170 con IVA ≠ 0; `c82` casa a 0.0001) |
| `kdm1.c22` · `c32`–`c35` | RFC, nombre, domicilio | los del último `X-D-26` de ese acreedor; si no hay, `kdxd` | 451 / 456 |
| `kdm1.c17` | días de crédito | `kdxd.c16` | 463 / 471 |
| `kdm1.c85` | banco destino | los 3 primeros dígitos de la CLABE (código ABM) | 012/072/002/030 observados |
| `kdxf` | una aplicación por factura | `c4 26 · c5 1 · c6` folio · `c7 c8 c9` la factura · `c10` = `c11` aplicado | 11,544 / 11,544 con `c10 = c11` |
| `kdxe.c20` de la factura | saldo | `c20 − aplicado`, con `WHERE c20 >= aplicado` | arriba |

**Lo que NO se pudo derivar, declarado:**

- ⚠️ **`c86`, los últimos dígitos de la cuenta destino.** No hay CLABE de proveedor en ninguna tabla
  `kdx*` del ODS, y el estado de cuenta no la repite (5 de 402). Se escribe **vacío**, que Kepler ya
  acepta. **Pregunta a Tesorería:** ¿de dónde la toma quien captura?
- ⚠️ **Pagos con facturas de conceptos distintos** (64 de 471, 13.6 %). Kepler pide uno y quien captura
  elige; en 31 de esos 64 no es el de la factura mayor. Se **rechaza** con el motivo, y Tesorería parte
  el pago en uno por concepto. **Pregunta a Edgar** si prefiere otra regla.
- Cada servidor paga en el suyo (desde el 1-oct, los nueve: oficinas lleva $27.6 M de $42.5 M), con su
  serie `1` y prefijo `XD2601-`. Ningún `kdxf` cruza de servidor. **Arranque propuesto: sólo `00`.**
- La plantilla candidata en `00` es **`X-D-26 1/0023768`** (transferencia, una factura, `c19`/`c20`/`c24`
  vacíos). Antes de C2 se lee entera en el Kepler vivo y se compara con el valor mayoritario de las ocho
  columnas que tienen dos valores (`c18`, `c41`, `c91`, `c101`, `c188`, `c191`, `c195`, `c197`).
- ⛔ **Lo abierto de ADR-092 aplica aquí con más fuerza:** Kepler se negaba a dar de baja una
  requisición escrita por la Suite. **Un pago que no se puede cancelar es peor que uno que no se puede
  crear.** El primer pago real se escribe en presencia de quien administra Kepler, y se prueba
  cancelarlo **desde la pantalla de Kepler** antes de encender nada.

**C1 hecho** (`[PGP.71]`, 🧪): [`pago-kepler.armador.ts`](../../../libs/finance/src/lib/payment-calendar/kepler-pago/pago-kepler.armador.ts)
arma las cuatro escrituras sin tocar Kepler, `motivosParaNoEscribir` es la compuerta E3.3 y
`escrituraDePagoEncendida` el interruptor E3.5 (apagado salvo `KEPLER_PAGO_ESCRITURA=encendida`).
20 pruebas; dos mutantes probados en rojo (quitar «marcado pagado» y quitar el tope de saldo).

**C2, el adaptador, en código y APAGADO** (`[PGP.71]`, 🧪 sin ensayar): [`kepler-pago-sink.adapter.ts`](../../../libs/finance/src/lib/payment-calendar/kepler-pago/kepler-pago-sink.adapter.ts)
lee lo vivo de Kepler (acreedor en `kdxd`, código de tesorería en `kdb1`, saldo y concepto de cada factura), arma con el
armador, clona la plantilla y escribe `kdm1` + `kdxe` + `kdxf` + la baja de `c20` en UNA transacción; si otro pago se
adelantó al saldo, se deshace todo. Cuatro candados: `KEPLER_PAGO_ESCRITURA=encendida`, `KEPLER_PUSH_URL_NN`,
`KEPLER_PAGO_TEMPLATE_FOLIO_NN` (sin default en ningún servidor) y los `GRANT`. **No está registrado en ningún módulo**:
no lo llama nada todavía. La regla de conexión por servidor se mudó a `platform-core` (`kepler-servidor.ts`) para no
escribirla dos veces.

⚠️ **El ensayo** ([`kepler-pago-sink.ensayo.spec.ts`](../../../libs/finance/src/lib/payment-calendar/kepler-pago/kepler-pago-sink.ensayo.spec.ts))
corre `entregar()` entero contra el Kepler real y termina en `ROLLBACK`: **NO MEDIDO**. `pg_hba.conf` de Kepler sólo
acepta a `kepler_push` desde `md`, y esta sesión no puede entrar a `md`. Lo corre una persona desde `md`:
`KEPLER_ENSAYO=1 KEPLER_PAGO_TEMPLATE_FOLIO_00=0023768 npx vitest run --config vitest.config.ts src/lib/payment-calendar/kepler-pago/kepler-pago-sink.ensayo.spec.ts`
(desde `libs/finance`). Antes de C3 (el endpoint y su botón) falta: que el ensayo pase, el reclamo atómico del pago en
`payment_allocations.kepler_payment_folio` (el doble clic de `PGP.UI.1`) y su prueba contra base real en el CI.

**Medido en el Kepler vivo el 2026-11-04 por la noche, desde `md` con `psql`** (autorizado por Edgar; la conexión viajó
por la entrada estándar, no en la línea de comandos):

| Tabla | `kepler_push` puede |
|---|---|
| `md.kdm1` | SELECT · INSERT |
| `md.kdxd` | SELECT (el 22-oct no podía: alguien lo dio después, probablemente para `[PQ.17]`) |
| `md.kdxe` · `md.kdxf` · `md.kdmm` · `md.kdxv` · `md.kdb1` | ⛔ **nada** |

- La plantilla `00/1/0023768` existe, y sus ocho columnas de dos valores traen `1800-01-01` (el valor mayoritario).
- **Ensayo parcial de `kdm1`, con ROLLBACK:** se clonó la plantilla en una temporal, el folio salió `MAX+1` (`0023996`) y
  las 27 columnas que pisa el armador se aplicaron con parámetros sin tipo, como los manda `node-pg`: **Postgres resolvió
  todos los tipos**. Después del ROLLBACK, 0 documentos con la referencia del ensayo.
- `c81`, `c82`, `c84` y `c17` son **`varchar`** en Kepler y `c16`/`c42` `numeric`: los números viajan como texto sin
  relleno (`160`, `0`, `30`), el mismo formato que traen los pagos reales (`516.82`, `0`).
- ⛔ **El ensayo completo no puede correr todavía:** lo primero que lee es `kdxe`, y hoy da «permiso denegado». Los
  `GRANT` son lo único que falta para ensayar el pago entero.

**El menú «Pagos a proveedor» de Kepler, documento por documento** (catálogo `kdmm` y oficinas desde el 1-ago-2026,
medido el 2026-11-04 a pedido de Edgar):

| Opción del menú | Documento | Escribe | Uso desde el 1-ago | Para la Suite |
|---|---|---|---|---|
| Transferencia a proveedor | `X-D-26` | `kdm1` + `kdxe` + `kdxf` + saldo | 1,014 a compra (`C…`) · 5,681 a gasto (`G…`) · 61 a otros | ⭐ **lo de este armador** (hoy sólo `C…`) |
| Cheques a proveedor | `X-D-25` | lo mismo | 78 a compra · 101 a gasto | el mismo armador con `c4=25`, `c31=Che`, prefijo `XD2501-`; `c11` lleva `CH-<folio del cheque>` en 128 de 179 |
| Transferencia a no proveedor | `N-A-26` «Transferencia bancaria» | **sólo `kdm1`**: sin cuentas por pagar ni facturas | 523 · $77.5 M | ⛔ **no es pago a proveedor**: los 523 van a la **misma persona física**, desde 17 cuentas. No entra al Calendario sin que Edgar diga qué son |
| Cheques a no proveedor | — | — | 0 documentos | — |

- Los pagos a **acreedores de gasto** (`G…`) son el mismo documento y casan facturas igual (5,632 de 5,681): sus
  conceptos son los de gasto del catálogo `kdxv` (`012` gastos financieros 2,892, `007` gastos generales 2,296,
  `009` nómina 455). Entran con el mismo armador quitando el filtro `C…` y con `c48` vacío (el mapa de sucursal sólo
  existe para los conceptos de compra). **Propuesta: primero compra por transferencia, después cheque y gasto.**
- Los tipos `X-D-20/23/24` («Pago prov. Trans/cheq/banc», «0 %», «8 %») existen en el catálogo y no tienen documentos.

#### ⛔⛔ El pago escribe SEIS cosas, no cuatro (2026-11-04, rastreo de un folio en las 242 tablas replicadas)

| Tabla | Qué guarda | Medido (471 pagos por transferencia de oficinas, ago–nov) |
|---|---|---|
| `kdm1` | el documento | decodificado arriba |
| **`kdm5`** | **un renglón por factura saldada**: `c7` renglón · `c8 c9 c10 c11` la factura · `c12`=`c13` aplicado · `c14` la referencia del proveedor | 471 / 471 con tantos renglones como `kdxf`; suma = importe en 470 |
| `kdxe` (`c3=D`) | el renglón de cuentas por pagar | decodificado arriba |
| `kdxf` | las aplicaciones | decodificado arriba |
| `kdxe.c20` de la factura | el saldo | decodificado arriba |
| **`kdc2AAMM`** | **la póliza contable del mes** (`kdc22610` = oct-2026): `102` bancos al abono por el total, `201` proveedores al cargo por factura; `c1` número de póliza; sin renglones de IVA | 131 / 131 en octubre; el pago del 4-nov ya la tiene: **nace al capturar** |

⛔ El «el pago no tiene renglones» de PGP.0.1 miró sólo `kdm2`; los renglones están en `kdm5`. Y la póliza vive en una
**tabla por mes**: escribirla exige permiso sobre la tabla de cada mes y decodificar de dónde sale su número.

⛔ **Y el rastreo sólo ve 242 de las 360 tablas de `md_00`.** El instrumento que ve todas es
[`foto-contadores.js`](../../../ops/prod/ensayo-pago-kepler/foto-contadores.js): lee los contadores de inserciones,
cambios y borrados de Postgres (`pg_stat_user_tables`) de las 360 tablas. Control: dos fotos seguidas, ninguna tabla
cambió. **Protocolo:** foto → Tesorería captura UN pago en Kepler → foto → comparar. La diferencia es el conjunto
completo de escrituras. **El pedido de `GRANT` no se manda hasta tener esa lista**, para no pedir permisos dos veces.

#### ⭐⭐ Deducido por ingeniería inversa (2026-11-04, a pedido de Edgar): lo que escribe una transferencia a proveedor

**Las fuentes:** (1) en el Kepler vivo **no hay ningún disparador, función ni regla** en `md`, así que todo lo escribe el
programa cliente; (2) los contadores de las 360 tablas desde que el servidor arrancó (2026-11-04 10:24): **sólo 46 tablas
se escribieron, y las 46 están replicadas en el ODS**, así que las 118 que el ODS no ve no se tocan en la operación normal;
(3) cada hipótesis se probó contra el estado acumulado de las tablas.

| # | Escritura | Regla deducida | Prueba |
|---|---|---|---|
| 1 | INSERT `kdm1` | el documento (decodificado arriba) | 471 / 471 |
| 2 | INSERT `kdm5` × N | un renglón por factura: `c7` renglón · `c8 c9 c10 c11` la factura · `c12`=`c13` aplicado · `c14` referencia | 471 / 471 |
| 3 | INSERT `kdxe` | el renglón `D` | 471 / 471 |
| 4 | INSERT `kdxf` × N | las aplicaciones | 471 / 471 |
| 5 | UPDATE `kdxe.c20` × N | saldo de cada factura − aplicado | 2,075 / 2,083 |
| 6 | UPDATE `kdxg` | acumulado del acreedor por mes: **abonos** en `c35`–`c46` (ene–dic) += importe. Cargos en `c47`–`c58` | 229 / 229 acreedores en octubre (y todos los meses); **los contadores: 1,358 cambios en `kdxg` = 1,358 inserciones en `kdxe`** |
| 7 | INSERT `kdc2AAMM` | la póliza del mes, tipo `E`, número **MAX+1 por mes y tipo** (octubre: 1..1,070 sin huecos, en orden de captura): un abono `102` por el total y un cargo `201` por factura | 131 / 131 pagos de octubre |
| 8 | UPDATE `kdc126` | acumulados de la cuenta por mes: **cargos** `c27`–`c38`, **abonos** `c63`–`c74` (+ un segundo juego `c51`–`c62` / `c75`–`c86` casi igual) → `201` cargo y `102` abono del mes | octubre al centavo en `102` y `201` |

**No los toca:** `kdcn26` (acumulados por centro de costo: ninguna clave es cuenta 102/201, y ningún pago a compra trae
renglones `kdm6`), `kdm2`, `kdm6`, la entrada `kdm1` de la factura (`c42` = total en 8,609 de 8,609). **No deducido:**
`kdxg.c5` (casa con el saldo sólo en 42 %), qué es el segundo juego de `kdc126` (¿lo «afectado»?) y si `kdc2AAMM` lleva
renglones de IVA en algún caso.

⭐ **Y una pista mayor:** `kdmx_26` guarda el **XML del motor de documentos de Kepler** (`k_docXml`: `Operacion ALTA`, los
campos `k_67`, `k_81`… que son las columnas de `kdm1`, y la póliza armada con su `npoliza`) para la nota de crédito
(`X-D-55`), el anticipo a proveedor (`X-D-60`) y `X-A-45`. Kepler tiene un motor que recibe un documento en XML y
escribe **todo** lo de esta tabla. **Si ese motor se puede llamar desde fuera, la Suite no tendría que reproducir 8
escrituras ni la contabilidad de Kepler**: le mandaría el documento y Kepler haría lo suyo. Es la pregunta al proveedor
de Kepler antes de seguir con el adaptador directo.

⛔ **Lo que esto cambia:** escribir el pago directo en las tablas ya no son 4 escrituras sino 8, tres de ellas
**contables** (póliza numerada y dos juegos de acumulados). Un error ahí descuadra la balanza de Kepler. El adaptador de
C2 cubre 1, 3, 4 y 5; le faltan 2, 6, 7 y 8, y el pedido de `GRANT` crece a `kdm5`, `kdxg`, `kdc2AAMM` (una tabla
por mes) y `kdc126`.

### C1 · Dominio

| # | Item | Estado | Prueba que lo ejerce |
|---|---|---|---|
| PGP.1.1 | Tope de firma por monto y a quién le toca cada pago | 🧪 `validacion-pago.contract.ts`, 15 pruebas (mutante del uno a uno: rojo) | Casos en los dos lados del tope, y exactamente en el tope |
| PGP.1.2 | Armador del documento `X-D-26`: clonar plantilla, pisar campos de negocio, derivar folio `MAX+1` | 🧪 `[PGP.71]` | Contra la plantilla real, sin escribir |
| PGP.1.3 | Repartidor de aplicaciones `kdxf`: un pago que cubre N facturas | 🧪 `[PGP.71]` | El caso de 8 aplicaciones, y el de 1 |
| PGP.1.4 | Conciliador: lo escrito por la plataforma contra lo que el ODS devuelve | 🔨 `validacion-pago.sql.ts` + `validacion` en el día; «Pagado» sólo con banco y comprobante en pantalla; el candado de Kepler (`motivosParaNoEscribir`) lo exige. NO MEDIDO: el caso de integración (CI / `TP_IT_DB`) y la pantalla viva. Deuda: el servidor todavía no lo exige en `execute` | Un pago escrito y releído |

### C2 · API

| # | Item | Estado | ¿Escribe? | Prueba contra base real |
|---|---|---|---|---|
| PGP.1 | `GET /commercial/supplier-payment-accounts/faltantes` + la lista en `/compras/cuentas-pago` | 🧪 **2026-10-22** | no | Guión de sólo lectura contra prod (ver abajo) |
| PGP.3 | Las dos bandejas de pagos en «Mi trabajo» + la responsabilidad `finanzas.pagos` | 🧪 **2026-10-22** | sí (la migración) | `verify-pgp3-bandejas-pagos.js`, 4 controles. ⚠️ **La migración NO está aplicada en prod**: `sh ops/prod/aplicar-migracion.sh 20261022150827_pagos_responsabilidad.js`, y exige el commit empujado |
| PGP.2.2 | Sembrar `supplier_payment_accounts` desde el circuito de solicitud | 🧪 en código (e1dee0f5c): `execute()` exige la validación (efectivo a mano) y guarda salida, comprobante, fecha, importe y hora; migración `20261110080925` (5 columnas NULLABLE, sin FK) va ANTES del código. NO MEDIDO: la integración corre en el CI | sí | ⛔ obligatoria, con el payload de la pantalla |
| PGP.2.3 | `POST /finance/payment-calendar/allocations/:id/kepler/escribir` — escribe el `X-D-26` | 🧪 en código (246156863): `cfdisDeFacturas` + lectura en 4 pasos, sólo en días autorizados o que ya llegaron. Con el código real en prod: 225 únicos (216 PPD, 9 PUE), 33 varios, 60 sin CFDI, 15 sin RFC. Índice `20261110082041` (CONCURRENTLY, fuera de horario). NO MEDIDO: el tiempo con el índice; `v_supplier_rfc` sigue en ~280 ms | **sí, al ERP** | ⛔ obligatoria + deshacer el documento, como hizo KR |
| PGP.2.4 | Compuerta: no se escribe a Kepler un pago que no esté `executed` y autorizado | ⬜ | no | ⛔ rota a propósito una vez |

⛔ **Los tres endpoints que escriben van contra base real antes de cerrar.** La regla nació de
`POST /cortes/:id/contar`, que devolvió 500 durante 8 días con el build en verde.

### C3 · UI

| # | Item | Estado | `check:pantalla` antes → después |
|---|---|---|---|
| PGP.1 (C3) | La lista de «a quién le falta cuenta» en `/compras/cuentas-pago` | 🧪 **2026-10-22** | módulo `compras` **104 → 101 fallas** · las 3 NUEVAS son **las mismas tres de antes** (deuda ajena, ninguna de este cambio). En la pantalla, las **tres** fallas de deuda quedaron **resueltas**: `Q.1` answer-first (MetricStrip), `§2` matriz de estados (LoadState) y `§9` frescura (FreshnessPill con el `computed_at` real del espejo del ERP) |
| PGP.3.1 | Estación «Pagos a proveedor»: el ciclo completo en una pantalla | ⬜ | <por medir> |
| PGP.3.2 | Las 4 pantallas sueltas entran a la estación (Cuadre y deuda · Estado de cuenta acreedores · Cuentas por pagar · Cuentas de pago) | ⬜ | <por medir> |
| PGP.3.3 | Permiso propio para «Cuentas por pagar» — hoy se gatea con `FINANCE_AI_CHAT` | ⬜ | — |

⭐ **La unificación ya empezó y no se tira**: `[TP.20.3]` juntó 4 pantallas bajo la entrada «Pagos»
con `PAGOS_TABS`. Quedan fuera 4, una de ellas en otro módulo (`/compras/cuentas-pago`).

| # | Pantalla | Ruta | En la entrada «Pagos» |
|---|---|---|---|
| 1 | Pronto pago | `/finanzas/pronto-pago` | ✅ |
| 2 | Calendario de pagos | `/finanzas/calendario-pagos` | ✅ |
| 3 | Pagos a proveedor (evidencia) | `/finanzas/pagos-comprobantes` | ✅ |
| 4 | Programa de pagos | `/finanzas/programa-pagos` | ✅ |
| 5 | Cuadre y deuda | `/finanzas/cuadre-proveedor` | ⛔ suelta |
| 6 | Estado de cuenta acreedores | `/finanzas/estado-cuenta-acreedores` | ⛔ suelta |
| 7 | Cuentas por pagar | `/finanzas/pagos-control` | ⛔ suelta, y con permiso prestado |
| 8 | Cuentas de pago | `/compras/cuentas-pago` | ⛔ vive en Compras |

⛔ Cargar la skill `diseno` antes de tocar el primer archivo. <500 ms.

#### `[PGP.97]` «Salidas del banco» — las doce preguntas de la skill `diseno`, por escrito (2026-11-07)

Pedido de Francisco: *«utiliza el workbook de bancos para identificar lo que se pagó fuera de programa
y está pendiente de elaborar el pago en Kepler, para que sirva de guía al área de pagos a proveedor
[…] la meta es que el 100 % de los pagos pasen por el programa de pagos»*. Mediciones con controles
(prod, sólo lectura) en `C:\DEV\_tmp\pgp97\` (fuera del repo: llevan nombres de proveedores).

| # | Paso | Respuesta |
|---|---|---|
| 1 | Propósito | **¿Qué salió del banco a proveedores sin quedar asentado: sin su pago en Kepler, o sin haber pasado por el programa?** El acto que cierra: elaborar en Kepler el pago que falta (hoy a mano; con O3, la Suite) y regularizar lo pagado fuera del programa. |
| 2 | Quién entra | Responsabilidad `finanzas.pagos` (10 personas en 4 puestos) y quien captura el `X-D-26` en Kepler (usa Bancos › Conciliación 25 de 30 días y el Calendario 6). Permiso `FINANCE_PAYMENTS_VER`: **ya repartido** a 10 roles / 31 personas — regla 20 cumplida sin tocar permisos. |
| 3 | Estado real | Octubre, bancos: 244 salidas a proveedor; **239 tienen su pago en Kepler** (placebo −35/−60/+35 días: 0); **4 faltan** y 1 se capturó con otro importe. Por el programa: **8.9 % del dinero** en octubre, 33.1 % en la vida del Calendario, **98.1 % del 1 al 7-nov**; Caja General **0 %** en todas. El workbook llega al 30/31-oct: **noviembre se perdió** (ver `[PGP.97.1]`). |
| 4 | Qué ve, en orden | (1) el veredicto —cuánto falta en Kepler— con hasta qué día llegan los bancos; (2) la tira: falta · por corregir · fuera del programa · % por el programa (meta 100 %); (3) **«Sin pago en Kepler»**, las más atrasadas primero, con a quién se le pagó, su evidencia y las facturas que salda; (4) «Por corregir en Kepler»; (5) «Pagado fuera del programa», por acreedor; (6) la meta por universo; (7) lo que no se pudo medir. |
| 5 | Qué no ve | Las salidas en programa y en Kepler (sólo cuentan: están bien) · lo que no es pago a proveedor (nómina, traspasos) · la conciliación movimiento por movimiento (vive en Bancos). |
| 6 | Mapa de desglose | Cada cifra de la tira → su sección en la misma página · cada acreedor de «fuera del programa» → sus pagos (fila expandible) · cada renglón → su documento de Kepler (folio + sucursal por nombre) y su partida del Calendario (día). Endpoint único: `GET /finance/payment-calendar/fuera-de-programa`. |
| 7 | Accesibilidad | Todo a 0–1 clics; dinero al centavo (es lo que se teclea en Kepler); estado en palabra, no sólo color; tabla PrimeNG con teclado; la jerga en `<app-context-help topic="salidas-del-banco">`. ⚠️ **Documento fuente**: el PDF del comprobante NO se ofrece — no entra ningún comprobante desde el 5-oct (`[PGP.96]`); se ubica por folio. |
| 8 | Ligas | Viene del workbook (Bancos) y de Kepler; va a Kepler (elaborar o corregir) y al Calendario (la partida). ⛔ **Liga rota con nombre**: el Calendario no abre un día desde la URL, así que el renglón dice el día pero no lleva a él. |
| 9 | ¿Le toca? | Sí: es el paso que cierra el pago (salió del banco y quedó en Kepler) y donde O3 lo va a escribir solo. Por eso entra a `PAGOS_TABS` antes del expediente. No revive `/finanzas/tareas` (MA, dormida desde el 5-ago): sería una segunda guía. |
| 10 | Maqueta | Veredicto + cobertura → tira de 4 → tabla «Sin pago en Kepler» → «Por corregir» (+ «En Kepler sin salida») → «Fuera del programa» por acreedor (expandible) → meta por universo → «Lo que no se pudo medir» (plegado con su conteo). |
| 11 | Aceptación | `check:pantalla -- salidas-banco`: **cumple las 10 reglas, 0 fallas**; `check:templates-types --all`: 0 errores en `view`; `check-primeng-api` sin API retirada nueva. **Sin validación visual** (no se levanta la app). |
| 12 | Lo que la interfaz no resuelve | (a) **Noviembre no está en el workbook**: Tesorería tiene que volver a subirlo — con `[PGP.97.1]` ya cae en su periodo; (b) Caja General no se sube al día (su hoja llega al 10-oct): la guía es de bancos y caja sólo sale en la meta, del lado Kepler; (c) **crear el pago desde aquí es O3** y espera los `GRANT` de quien administra Kepler. |

---

## 5. Decisiones (→ ADR)

| # | Decisión | ADR | Fecha |
|---|---|---|---|
| **D1** | **La plataforma escribe el pago `X-D-26` en Kepler.** Mata la captura de Mayra y cierra la Δ contra Control. Extiende ADR-092 (que autorizó `X-A-30`) a un segundo documento. **Arranca sólo por transferencia bancaria**: son 102 de 155 pagos de octubre y $20.21M de $22.76M (88.8% del dinero); el efectivo entra cuando el carril esté probado. | ADR-092 ext. | 2026-10-22 |
| **D2** | **Dos firmas por monto.** Tesorería autoriza hasta el tope; arriba firma Dirección. **Tope recomendado: $100,000** — ver abajo. | nuevo | 2026-10-22 |
| **D3** | **Una sola estación de trabajo** con el ciclo completo, no cuatro pestañas más. Se construye **después** de que el circuito cierre una vez (el método no deja subir a C3 sin C2 verificado). | nuevo | 2026-10-22 |

**Por qué $100,000 como tope** (distribución real de los 4,824 pagos de 2026):

| Monto | Pagos | % de los pagos | Dinero | % del dinero |
|---|---:|---:|---:|---:|
| < $50k | 3,182 | 66.0% | $34.7M | 7.7% |
| $50k – $100k | 450 | 9.3% | $32.6M | 7.2% |
| **Subtotal < $100k** | **3,632** | **75.3%** | **$67.3M** | **14.9%** |
| $100k – $250k | 612 | 12.7% | $101.0M | 22.3% |
| $250k – $500k | 379 | 7.9% | $132.3M | 29.3% |
| $500k – $1M | 182 | 3.8% | $126.3M | 27.9% |
| ≥ $1M | 19 | 0.4% | $25.1M | 5.6% |
| **Subtotal ≥ $100k** | **1,192** | **24.7%** | **$384.7M** | **85.1%** |

Con el tope en $100,000, Tesorería despacha **3 de cada 4 pagos** —el trabajo diario deja de
esperar— y Dirección conserva la firma sobre el **85.1% del dinero**. ⚠️ El tope es una decisión
de control interno, no técnica: Dirección lo confirma antes de codificarlo.

---

## 6. Riesgos y bloqueos

| Bloqueo | Dueño | Causa | Qué lo destraba |
|---|---|---|---|
| **No hay cupo.** 4 fases 🔨 (PO · MS · CGA · RH) y Fase 0 de aterrizaje en curso | Edgar | Método §7 | Colgarla de **CGA** (Caja General ya es quien ejecuta el pago) **o** cerrar una de las cuatro |
| La fase no tiene dueño | Edgar | — | Asignarlo antes de pasar a 🔨 |
| El tope de firma no está confirmado | Dirección | Control interno | Confirmar los $100,000 de D2 |
| Escribir al ERP vivo puede ensuciar datos reales | dueño de la fase | Primera escritura de un segundo documento | El protocolo de KR: escribir, verificar en pantalla, **deshacer**, y dejar el carril apagado por variable de entorno |
| Si alguien da de baja el documento plantilla, la escritura deja de funcionar | dueño de la fase | El clon depende de una fila real | Lo dice con todas sus letras en vez de fallar con `undefined` (igual que KR) |
| Kepler está en uso activo mientras se escribe | dueño de la fase | Folio denso compartido | `MAX+1` y dejar que la llave primaria rebote el choque; ⛔ nunca `LOCK TABLE` |
| 89 pagos en efectivo > $100k al año, con 15% de RFC capturado | **Contabilidad** | Art. 27 fr. III LISR | Dictamen de Contabilidad **antes** de automatizar el carril de efectivo |
| ⛔ **O3 no puede escribir el pago**: `kepler_push` no tiene privilegio sobre `md.kdxe` ni `md.kdxf`, y el ERP **no las deriva solo** (no hay trigger: medido) | quien administra Kepler (dueño `sa`) | El acceso se acotó a lo que necesitaba la requisición de KR | Dos `GRANT` (§4 · C0). Sin ellos, O3 **no arranca** y el código que se escriba no se puede probar |

---

## 7. Definición de Terminado

- [ ] 1. Métrica remedida: pagos del mes ejecutados y ligados, antes (0 de 154) / después
- [ ] 2. Cada capa verificada o declarada NO MEDIDA (ADR-056)
- [ ] 3. Los 3 endpoints que escriben, ejercidos contra base real con el payload de la pantalla
- [ ] 4. La compuerta de PGP.2.4 rota a propósito una vez, rojo verificado
- [ ] 5. El armador de documentos de Kepler vive en `libs/` compartido con el de KR, o queda como deuda con nombre
- [ ] 6. Tracker + `03_LOG_REVISIONES.md` + fila en el roadmap de `CLAUDE.md`
- [ ] 7. En prod, con el permiso **repartido** (regla 20), o escrito por qué no

---

## 8. Items de arranque (PGP-A), listos para copiar al tracker

Se copian a `01_TRACKER_PROGRESO.md` **el día que la fase pase a 🔨**, no antes (método §4).

```markdown
- [ ] **[PGP.1]** ⬜ **Tesorería ve a quién le falta cuenta, ordenado por dinero** — 2026-10-22.
  **Para:** Tesorería (`tesoreria`, `auxiliar finanzas`) · **Por qué:** sin cuenta destino no se
  puede preparar un pago, y sin preparar no se puede autorizar ninguno. Destraba los $45M/mes.
  **Capa:** C2 · **Depende de:** —
  **Criterios:**
  - Dado los pagos por banco de los últimos 120 días, cuando se abre la lista, entonces salen los
    proveedores sin cuenta en `commercial.supplier_payment_accounts` ordenados por monto pagado,
    con su nombre de beneficiario tal como aparece en el estado de cuenta (`raw_code='510'`), y
    el acumulado dice en qué renglón se llega al 80% del dinero (medido hoy: renglón 37).
  - Dado un proveedor que ya tiene cuenta activa, entonces NO aparece en la lista.
  - Dado que el estado de cuenta no tiene movimientos del periodo, entonces la lista dice
    «sin movimientos en el periodo» — ⛔ nunca una lista vacía que se lea como «no falta ninguno».
  - Dado que la consulta falla, entonces se distingue del caso vacío.
  - ❌ Dado un puesto sin `FINANCE_PAYMENTS_VER`, cuando llama, entonces 403.
  **Verificado contra:** `analytics.erp_supplier_payments` con `medio_pago='banco'` (c45), mismo
  grano proveedor×periodo. Hoy: 169 proveedores, $129,254,884 jul–oct.
  **¿Escribe?** no.
  **No incluye:** capturar la CLABE — eso es `[PGP.2]`, y lo hace una persona.

- [ ] **[PGP.2]** ⬜ **Las 37 cuentas que mueven el 80% del dinero quedan dadas de alta** — 2026-10-22.
  **Para:** Tesorería captura · Dirección aprueba · **Por qué:** es la llave del circuito entero.
  **Capa:** C2 · **Depende de:** PGP.1 (🧪)
  **Criterios:**
  - Dado una CLABE de 18 dígitos válida, cuando se solicita el alta, entonces queda `pending` y
    NO se puede usar para preparar un pago hasta que alguien con
    `FINANCE_PAYMENT_CALENDAR_AUTORIZAR` la apruebe.
  - Dado una CLABE de 17 o 19 dígitos, entonces el error dice cuántos dígitos tiene y cuántos
    lleva una CLABE.
  - Dado una CLABE de 18 dígitos con dígito de control equivocado, entonces se rechaza nombrándolo.
  - ❌ Dado quien solicitó el alta, cuando intenta aprobarla él mismo, entonces se rechaza — la
    separación es el control, y esta prueba la intenta violar a propósito.
  **Verificado contra:** las 37 cuentas contra la banca en línea, una por una, por Tesorería.
  **¿Escribe?** sí → prueba contra base real con el payload de la pantalla de solicitud.
  **No incluye:** las 132 cuentas restantes (el 20% del dinero) ni el efectivo.

- [ ] **[PGP.3]** ⬜ **Quien firma se entera de que hay un lote esperando** — 2026-10-22.
  **Para:** Dirección · **Por qué:** 6 lotes llevan desde el 16-oct en `draft` y nadie lo supo.
  **Capa:** C2 · **Depende de:** —
  **Criterios:**
  - Dado un lote en `draft` con todos sus pagos preparados, entonces quien tiene
    `FINANCE_PAYMENT_CALENDAR_AUTORIZAR` recibe el aviso con la fecha, el número de pagos y el total.
  - Dado un lote en `draft` con pagos **sin preparar**, entonces el aviso dice **cuántos faltan y
    de quién es el paso** — ⛔ no se avisa «listo para firmar» algo que el servidor va a rechazar.
  - Dado cero lotes en `draft`, entonces no se emite aviso (y no se emite uno vacío).
  **¿Escribe?** sí (el aviso) → prueba contra base real.

- [ ] **[PGP.4]** ⬜ **Un lote real recorre el circuito entero y queda su acta** — 2026-10-22.
  **Para:** todos · **Por qué:** es el DoD de O1: hoy la cobertura es 0%.
  **Capa:** C2 · **Depende de:** PGP.2 (✅), PGP.3 (🧪)
  **Criterios:**
  - Dado un día con capacidad definida y sus pagos preparados, cuando Tesorería ordena y Dirección
    autoriza, entonces el lote pasa a `released` con folio, y cada pago recibe el suyo.
  - Dado que Caja General lo ejecuta, entonces el pago queda `executed` y el acta registra quién
    hizo cada paso y a qué hora.
  - Dado un pago que falla en el banco, entonces queda `failed`, **su obligación NO se liquida** y
    el saldo vuelve a revisión.
  - ❌ Dado un lote con un pago sin preparar, cuando se intenta autorizar, entonces 400 diciendo
    cuántos faltan — el rojo se verifica a propósito (es el que estuvo tapando el circuito).
  **Verificado contra:** el pago aparece en el estado de cuenta bancario del día siguiente, por
  monto y beneficiario.
  **¿Escribe?** sí, los cuatro pasos → cada uno ejercido contra base real.
```

---

## 9. Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
| 2026-10-22 | Investigación y medición del circuito completo contra prod. 8 pantallas inventariadas, motor TP medido con 0% de cobertura, decode del `X-D-26` (3 tablas, sin renglones), tope de firma calculado. D1–D3 firmadas por Edgar. | Claude |
| 2026-10-22 | **Corrección al diagnóstico de la misma sesión**: el tapón no era la firma de Dirección sino el paso anterior — 0 de 10 pagos preparados, y no se pueden preparar porque no hay ninguna cuenta de proveedor sembrada. Se midió que 37 proveedores cubren el 80% del dinero por banco, y que la CLABE no se puede derivar del estado de cuenta (24 de 14,456). Objetivos O1–O5, entregables e items de arranque. | Claude |
| 2026-10-22 | **C0 de O3 medido, y destapa un bloqueo**: `kepler_push` puede tocar 3 de las 360 tablas de `md_00` — tiene INSERT en `kdm1`/`kdm2` y **nada** en `kdxe`/`kdxf`, que son dos de las tres que el pago escribe. La hipótesis que lo salvaba (que un trigger las derivara) está **refutada**: no hay ninguno. O3 necesita dos `GRANT` del dueño antes de escribir una línea de código. | Claude |
| 2026-10-22 | **O2 corregido al medirlo**: el mecanismo que crea obligaciones ya existe (`[TP.15]`, por el pendiente vivo de Kepler) y cubre el **2.9 % del dinero**. El hueco no es el mecanismo: son **dos poblaciones**, y la deuda preexistente ($90.1 M en 1,707 documentos) no tiene ningún camino. | Claude |
| 2026-10-22 | **E2.1 construido** (`[PGP.5]` + `[PGP.6]`): el candado de un documento = una obligación, y el camino para elegir del pendiente vivo lo que nadie programó. Medido: 1,733 documentos vivos, **2.93 % programado**. ⛔ Y se midió que filtrar esa vista por sucursal cuesta **43.6–47.7 s** contra 450–550 ms sin filtro (3 corridas de cada una, reproducido); no es el predicado empujado y la causa queda **NO DETERMINADA**. | Claude |
| 2026-10-23 | **`[PGP.7]` De tres pantallas a una.** Edgar: *«calendario de pagos, pronto pago, programa de pagos… hacen lo mismo»*. Tenía razón y el inventario que lo negaba (`FASE_TP` §23) estaba **vencido** — se midió antes de `[TP.20.4]`. Medido hoy: Programa de pagos **76 días sin cargar**, la mitad retrospectiva de Pronto pago **55 días sin producir** (98 hallazgos, los 98 sin triar), y su mitad prospectiva ya vivía en el Calendario. Las dos salen del MENÚ (no del router) y el Calendario recibe la tasa observada y un orden por urgencia de descuento. | Claude |
| 2026-10-28 | **`[PGP.27]` El autorrelleno del Calendario deja de depender de un solo campo del ERP** — 🧪 en código, **sin aplicar ni empujar**. El motor de evidencia (`[PGP.19]`) sacaba el RFC del acreedor sólo de `kdxd.c10`; lo que no estuviera ahí quedaba sin factura. Medido contra prod (sid `7688376744939610156`): **1,000 documentos ($29,067,071) sin RFC** y —lo que no se veía— **368 documentos ($20,232,802, 14 acreedores) CON un RFC mal escrito**: `BALO20930EL9` por `BAL020930EL9` (letra O por cero; **$14,281,642**, la deuda más grande de la casa), `CAMR-590304-B` con guiones, `DGR0531773A` con un dígito de menos. ⭐ **Un RFC mal formado no es un RFC capturado**, y se leía como si lo fuera. Ahora `analytics.v_supplier_rfc` responde una sola vez «¿cuál es el RFC de este acreedor?» con su procedencia: el de Kepler **si pasa la forma del SAT**, si no el que resuelve el **nombre normalizado entero** (sin acentos, sin forma societaria — el cruce viejo comparaba 14 caracteres y perdía `GAMAHUBIN SA DE CV` contra `GAMAHUBIN`) contra ContPAQi y los CFDI recibidos, exigiendo unicidad; si no, NULL **con su motivo**. Resultado: **1,125 → 1,291 documentos con factura (+166) · +$10,415,534**, **0 pierden** lo que ya veían y **control negativo 0**. ⛔ El costo casi lo hunde: la llamada de pantalla pasaba de **2.0 s a 6.9–9.2 s** porque `fiscal.cfdis` son 460 MB sin índice por emisor; la migración **crea `ix_fiscal_cfdis_emisor`** y **se revierte sola si no bajó del tope** (mide y lanza). ⚠️ **NO MEDIDO**: el costo con el índice —la conexión de trabajo es de sólo lectura y no puede crearlo—; lo decide la compuerta al aplicar. ⚠️ Quedan **414 documentos donde Kepler trae un RFC bien formado y el nombre dice otro** (MONDELEZ `PENC620207982`, persona física en una sociedad, $3,067,873): **gana Kepler** y se publica en `rfc_discrepa` para que alguien decida — eso es captura, no derivación. | Claude |
| 2026-10-28 | **`[PGP.30]` O8 construido — 🧪 en código, sin aplicar.** El Calendario precarga **método** y **cuenta de origen** del hábito del acreedor; los dos pagos frenados ese día con «Falta el método» eran $550,411.04. Vista `analytics.v_supplier_payment_habit` (migración `20261028163649`), **292 ms**. Contra prod: **288 de 316 acreedores (91.1 %) con método estable, $403,483,667 = 87.4 % del dinero**; 43 con cuenta de origen proponible. ⭐ **J&F ENTERPRISE se paga con CHEQUE 16 de 16 veces**: el hábito gana al valor del lote a propósito, porque «transferencia» (92.6 % global) le habría errado justo a él. ⛔⛔ **Dos defectos cazados ANTES de soltar:** (1) 111 de 154 propuestas de cuenta apuntaban a **CAJA GENERAL**, que el selector excluye — se habrían visto como un desplegable vacío sin decir por qué; ahora salen como `caja_general` e **informan**. (2) Un **acento grave** en un comentario dentro del literal SQL cerraba el template. ⛔ **Se retractó una corrección propia**: contar 146 de 316 acreedores (46.2 %) parecía tumbar el no-objetivo de la cuenta de origen, pero pesado por **dinero** da **5.1 %**, peor que el 10.4 % original — **el no-objetivo sobrevivió**. ⚠️ **Sin validación visual.** | Claude |
| 2026-10-28 | **Dos objetivos nuevos al plan, pedidos por Edgar: O6 (la cuenta destino se propone sola) y O7 (la solicitud de alta se arma sola).** Medido el mismo día contra prod: el catálogo `supplier_payment_accounts` está en **0 filas**, y la fuente que lo puede llenar no es una captura sino **el REP que el propio proveedor timbra**: 63 acreedores declaran alguna cuenta, de los cuales **23 traen UNA CLABE de 18 que pasa el dígito de control** — ésos cubren **165 documentos · 15 acreedores · $10,251,411** de deuda viva, y **38 de esos documentos sólo se alcanzan por el RFC que `[PGP.27]` resolvió por nombre**. ⛔ **36 acreedores declaran sólo una cuenta de 10 dígitos, que NO es una CLABE y no se puede completar**: falta la plaza, y tener el RFC del banco (522 REP lo traen) no alcanza. ⛔⛔ Y se midió —y **se descartó**— la premisa de autorrellenar la cuenta de ORIGEN: la conocemos completa (**1,992 de 1,992 pagos por banco** traen `cuenta_tesoreria`, 16 cuentas, $377,322,895) pero **no es predecible**: por acreedor cubriría el **10.4 %** del dinero y por sucursal el **0 %**, porque **todos los pagos a proveedor salen de la sucursal `00`** y la cuenta más usada apenas llega al 23 %. La cuenta de origen es una decisión de Tesorería sobre la liquidez del día, no un atributo del proveedor; queda declarado en el plan para que no se reabra. | Claude |
| 2026-10-28 | **⛔ `[PGP.27]` se aplicó, su compuerta disparó y se revirtió sola — y la corrección es mejor que lo que yo había escrito.** Al aplicarla, la compuerta de costo midió **5,349 ms contra un tope de 1,000 ms** y lanzó: la transacción se revirtió entera (prod quedó sin índice y sin vistas) y otra sesión retiró el commit de main antes de soltar, porque el código leía `e.rfc`/`e.rfc_fuente` y sin la migración habría dado **500 en el Calendario**. Era justo el costo que yo había declarado **NO MEDIDO** por no poder crear el índice desde una conexión de sólo lectura. ⭐ Al re-medirlo apareció que **la apuesta del índice era además innecesaria**: la pata del CFDI (460 MB de `fiscal.cfdis`) agrega **11 documentos y 1 cuenta** por **ocho veces** el costo. La versión viva usa **sólo ContPAQi** (3,417 filas): resolver cuesta **0.53–0.6 s** —pasa la compuerta—, da **1,122 → 1,278 documentos con factura (+156) · +$8,638,221**, **0 pierden**, y **GAMAHUBIN sobrevive**. Se retiró el índice: no se deja en prod uno de 12 MB que no se midió que sirva. También se corrigió un rótulo que había quedado mintiendo («ni en ningún CFDI recibido», con esa fuente ya apagada). | Claude |
| 2026-10-28 | **`[PGP.29]` O6 construido — 🧪 en código, sin aplicar.** `/finanzas/cuentas-pago` ya no abre un formulario vacío: la tabla «A quién le falta cuenta» trae la **CLABE que el proveedor declaró en su propio REP timbrado**, con el dígito de control verificado, cuántas veces la declaró y cuándo; el botón dice «Revisar y solicitar» y el diálogo abre **con la cuenta puesta y el comprobante citado en el motivo**. Vista `analytics.v_supplier_account_proposal` (migración `20261028093850`), medida en **794 ms**. Contra prod: **21 acreedores proponibles · 32 con sólo cuenta corta (no se puede completar: falta la plaza) · 2 con el dígito de control mal · 1 con varias, que NO se elige por él**; los cuatro casos dicen por qué en la columna. ⭐ Entre los proponibles está **GAMAHUBIN**, que sólo se alcanza por el RFC que `[PGP.27]` resolvió por nombre — y la pantalla lo **advierte antes de firmar**. ⛔⛔ **No da de alta**, y no se agregó ningún camino de escritura nuevo: la solicitud sigue yendo a la firma de otra persona. ⚠️ **Sin validación visual**: la pantalla no se levantó (prohibido compilar en local) — tipa, las plantillas typechequean y `check:pantalla` da 0 fallas nuevas, pero nadie la vio. | Claude |
| 2026-10-28 | **⛔ `[PGP.31]` se aplicó, se revirtió sola por una compuerta MÍA mal escrita, y al corregirla apareció un segundo defecto peor.** La guarda de costo copiaba `TOPE_MS = 1000` de `[PGP.27]` —donde vigila `v_supplier_rfc`, que cuesta ~200 ms— y se lo aplicaba a una sonda que cuenta `v_payable_evidence`, **cuyo piso documentado es 2.0 s**: imposible de cumplir por construcción, habría disparado con cero cambios. Disparó con 3,109 ms, el rollback fue limpio (`knex_migrations` sin registro) y dejó el despliegue frenado con **19 commits de 9 sesiones** detrás. Re-medido en sólo lectura contra prod: la vista viva **2,596 ms / 1,275 documentos**, con la prioridad invertida **2,510 ms / 1,287** — el cambio no encarece nada. El tope ahora es **relativo a lo que la propia migración mide antes de reemplazar** (1.5× + 500 ms) más un techo absoluto de 8 s. ⛔⛔ **El segundo defecto lo destapó que la otra sesión pegara la salida ÍNTEGRA**: el renglón decía «32 acreedores con RFC en disputa» donde el ADR-108 dice 18. A `rfc_discrepa` le faltaba exigir que el valor de Kepler **tenga forma de RFC**, así que mezclaba **18 contradicciones reales** (J&F, MONDELEZ) con **14 errores de dedo** (`PTE120913`, `DGR0531773A`) que ya declara `rfc_kepler_mal_formado`. Una pantalla que leyera esa columna habría llamado «contradicción de identidad» a una letra mal tecleada. Control nuevo con su prueba negativa: contra la vista sin corregir devuelve 14. ⭐ **Cómo se me escapó, que es la lección:** verifiqué **el SQL** dentro de una transacción que revertí, **no la migración** — el cuerpo estaba bien y el `up()` que lo envuelve, no. Segunda vez en esta fase que el defecto vive en el envoltorio y no en la consulta. ✅ **Aplicada en prod el mismo día, batch 1054** (14.7 s): `universo 2906 → 2906 · con evidencia 1275 → 1287 (+12) · $76,414,197 → $76,429,016 · 18 acreedores con RFC en disputa · la evidencia 3,326 ms → 2,706 ms`. ⭐ Quedó **más rápida que antes**: la cifra que mató al primer intento no era un costo, era el piso. | Claude |
| 2026-10-28 | **`[PGP.32]` La discrepancia de RFC sale a la pantalla — 🧪 en código, sin aplicar.** Era el pendiente que ADR-108 dejó escrito, y resultó más urgente de lo que parecía: `[PGP.31]` dejó **mintiendo** a dos rótulos que antes decían la verdad. «Kepler no tiene un RFC utilizable para este acreedor» era cierto con `[PGP.27]` —el nombre sólo ganaba cuando Kepler no tenía nada o lo tenía mal escrito— pero desde `[PGP.31]` el nombre **también** gana cuando Kepler SÍ tiene uno bien formado y distinto: **18 acreedores, 91 documentos**. Ahora el renglón del Calendario ramifica entre «RFC deducido: X» y «**RFC en disputa: Kepler dice X, sus comprobantes Y**», y el diálogo de alta de cuenta —donde alguien **firma** a qué cuenta se le paga— muestra los dos números; el motivo que **queda guardado** para quien autoriza también. Migración `20261028201548`: las dos vistas dejan pasar columnas que ya viajan en la fila, sin costo medido (**propuesta 390 → 359 ms · evidencia 680 → 654 ms**). ⛔ **Depende de `[PGP.31]` y lo verifica por implicación lógica** (con `[PGP.27]` `rfc_discrepa` implica `fuente='kepler'`; con `[PGP.31]`, `'nombre'`), porque aplicarla sobre la vista vieja publicaría los dos valores **intercambiados**; prueba negativa: contra la vista de hoy devuelve 160 y lanza. ⛔ Y la compuerta de costo **no mide con `count(*)` pelado**: medido, el planificador lo resuelve sin producir la columna (680 ms contra 2.5 s con el `FILTER`) — una sonda que se puede saltear no vigila nada. ⚠️ **Sin validación visual**: tipa, las plantillas typechequean en las 4 apps y `check:pantalla` deja las dos pantallas en ⚠ sin falla nueva, pero nadie las vio. | Claude |
| 2026-10-29 | **`[PGP.33]` Una premisa que nadie habia medido, en cuatro capas — 🧪 en codigo, sin aplicar.** Pedido de Edgar: *«caja general solo es efectivo, tambien existe el proceso de transferencia u otros»*. Tenia razon, y al medirlo el defecto era mas grande que la frase. (1) El selector de cuenta de origen excluia `kind='cash'` con la premisa escrita *«la caja no es origen de una transferencia»*; medido contra prod, **2,771 pagos ($54,897,784) salieron de CAJA GENERAL** y el propio decode de Kepler los clasifica `tipo_cuenta='caja'` — el **56.7 % de los 4,898 pagos** por conteo. El desplegable no podia reproducir mas de la mitad de como se ha pagado siempre. Migracion `20261029134018`: se retira el estado `caja_general` de `v_supplier_payment_habit` y las propuestas de cuenta van de **43 a 154 (+111)**, universo intacto en 316 (medido con el cuerpo real, en solo lectura). (2) El documento imprimible se titulaba «Instruccion de Ejecucion — **Caja General**» y pedia una sola firma para el lote entero, cuando **$404,105,108 — el 87.3 % del dinero — sale de banco** y lo dispersa **Tesoreria**, que no figuraba en el papel: ahora el titulo es neutro, cada renglon trae su columna **Ejecuta** y las firmas son las de los ejecutores que el lote realmente involucra; la etapa «Pagar» del tablero tambien se deriva. (3) Al elegir **efectivo** la pantalla declara que Kepler (`kdm1.c31`) no lo distingue —**cero de 4,898 pagos** registrados asi— para que quien concilie no lo lea como error de captura. ⭐ **La leccion: un mecanismo que necesita una excusa para la MAYORIA de sus casos describe una premisa falsa, no una excepcion.** `[PGP.30]` tuvo que inventar el estado `caja_general` para explicar por que no podia proponer el 72 % de lo que resolvia; esa excusa era el sintoma. ADR-109. ⚠️ **Sin validacion visual**: `check:pantalla` da **0 fallas nuevas** en la pantalla y las plantillas typechequean en las 4 apps, pero nadie la abrio. | Claude |
| 2026-10-29 | ⚠️ **Correccion a un hallazgo propio del 2026-10-29**: se reporto que el rol `surtidor` podia **autorizar** el lote de pagos (8 usuarios). **Es falso.** El instrumento estaba mal: `permissions -> 'KEY' IS NOT NULL` mide que la CLAVE este presente en el JSONB, no que el permiso este **otorgado**. Medido por el valor: `surtidor` trae 230 claves y solo **4 en `true`**, y `FINANCE_PAYMENT_CALENDAR_AUTORIZAR` la tiene en **`false`**. Quien autoriza de verdad: `direccion` (2) y `superadmin` (9) = **11 usuarios**. ⭐ La regla de `CLAUDE.md` sobre `-> 'KEY' IS NULL` es para **diffs de presencia**; usarla como prueba de otorgamiento invierte el resultado. Lo que si queda en pie, como observacion y no como defecto: `preparar` y `ejecutar` comparten `FINANCE_PAYMENTS_GESTIONAR` (9 roles, **31 usuarios**), o sea que la misma mano prepara y marca pagado — con la autorizacion de Direccion en medio. | Claude |
| 2026-10-29 | **`[PGP.34]` Simulacion del circuito, de punta a punta — `database/scripts/simular-pago-proveedor.sql`, solo lectura.** Edgar: *«genera una simulacion de todo el proceso»*. Camina los 6 pasos contra los datos reales y dice donde se detiene, por que y que lo destraba, sin escribir una fila. Cada compuerta es la del codigo citada por `archivo:linea`; el encabezado **declara que es una SEGUNDA implementacion en SQL** y que una cita colgada la haria mentir en verde. ⭐ Arranca con controles cuya respuesta ya se conoce, y cazaron **dos defectos mios**: un join que inflaba x9 (`v_supplier_account_proposal` es una fila por acreedor x cuenta declarada — 6,575 filas para 800 acreedores) y una cifra de **filas** que yo habia reportado como **acreedores** (178 filas = **20 acreedores** proponibles). Medido: **27 pagos vivos, $6,683,082.26, TODOS detenidos en el paso 3**; **4 pagos ($546,012.07) se destraban HOY** porque su REP ya trae la CLABE verificada (GAMAHUBIN, NANCY KARINA ACOSTA, ABARROTES DEL CENTRO GUERRERO). | Claude |
| 2026-10-29 | **`[PGP.35]` $2,506,811.31 del Calendario no son deuda viva — 🧪 en codigo, sin desplegar.** Lo destapo la simulacion en el paso 5: **11 de los 27 pagos** apuntan a facturas que **Kepler ya no debe**. ⛔ Antes de escribir una linea se descarto la hipotesis grave: las 27 lineas huerfanas **existen en `kepler_ods.kdxe` con saldo 0** —pagadas por fuera o con nota de credito—, o sea que **NO es deriva de la llave derivada**, que habria sido defecto nuestro; control: 0 de 2,910 facturas vivas faltan del universo reconstruido. ⭐⭐ **Lo mejor es que el dato ya estaba y se tiraba**: la etiqueta del beneficiario se rearma desde `analytics.v_supplier_payables`, que filtra `pendiente > 0.005`, asi que una factura saldada devolvia `label` vacio y el codigo pintaba «—». La pantalla ya mostraba **el sintoma exacto que `kepler-payable-key.contract.ts:22` anticipa** —*«una etiqueta en blanco y un saldo que no baja»*— y nadie lo leyo como lo que era. Cero consultas nuevas. Ahora el renglon lo dice donde se decide, el encabezado declara cuanto del total publicado no es deuda viva **sin recortar el total por cuenta propia**, y el dialogo de «marcar pagados» avisa **antes** de apretar cuales van a fallar (DESIGN §10 poka-yoke). ⭐ **Verificado que no puede dar falso positivo por RLS**: la vista no filtra por tenant, no tiene `security_invoker` y `kdxd`/`kdxe`/`kdxf` tienen `relrowsecurity = false` — lo que ve la sonda como `postgres` es lo que ve la app como `app_runtime`. ⚠️ **Sin validacion visual.** | Claude |
| 2026-10-29 | **`[PGP.36]`/`[PGP.37]` El Calendario dice POR QUE se paga cada cosa, y el orden mira el descuento — 🧪 en codigo, sin desplegar.** Pedido de Edgar: *«orientemos al usuario al 100 de por que debe pagar eso, que estamos aprovechando»*. **Lo medido primero** (prod, sid `7688376744939610156`): sobre $139.6M de deuda viva hay **$2,427,564 de descuento con ventana abierta** (486 facturas capturables $2,124,211 + 53 por vencer $303,353), **$1,278,649 fuera de ventana con 100 dias de atraso promedio**, y ⛔ **1,918 facturas ($73,571,291, el 52.7 %) SIN MEDIR**. Historico 2026: **$16,467,704 cobrados** en 2,113 pagos; 779 pagos ($91,055,536) a proveedores con politica salieron sin descuento (hasta $5,830,348, cota superior) — captura ~**73.9 %**. ⭐ **El mecanismo ya existia (`[TP.20.4]`) y su matview se refresca cada noche** (verificado: 07:54 de hoy, 16 ok / 0 fallas, 21.6 s): el defecto era que **solo hablaba cuando convenia** — mudo en `fuera_de_ventana` y `sin_medir`, o sea sobre **$97.4M de $139.6M**, y un silencio se lee como «aca no hay nada que ganar». Ahora **las cuatro razones hablan** y las tres negativas dicen cosas distintas (se paso la ventana / no sabemos / no aplica), el encabezado del dia declara **«captura $X · deja pasar $Y»**, y el orden propuesto mete el descuento **dentro de su clase, nunca por encima** (5 pagos cambian de lugar, $6,251.03 sube, 0 criticos desplazados). Costo del dato: la ventana viaja en la MISMA consulta que ya rearmaba la etiqueta — **319.9 ms → 326.3 ms**. ⭐⭐ **Y un hallazgo que corrige la intuicion**: la ventana **global no discrimina** (mediana 25 dias con descuento contra **13 sin el**); **por proveedor si**, de 4 dias a 68. Derivar por acreedor no era una preferencia de diseno: es lo unico defendible. ⛔ **NO PROBADO**: `suggestPriorityOrder` ESCRIBE y no se ejercio contra base real (regla 13); su SELECT si se valido extrayendo el SQL real del template y corriendolo con `EXPLAIN` contra prod. ⚠️ **Sin validacion visual.** | Claude |
| 2026-10-29 | **`[PGP.38]` La propuesta del dia ya puede ADELANTAR lo que pierde descuento — 🧪 en codigo, sin desplegar.** Era **el techo de toda la automatizacion** y estaba escrito como regla: `sugerirArmado` solo tomaba lo vencido, *«nunca lo que vence despues: eso no se adelanta solo»*. Razonable —adelantar dinero sin motivo es un costo— salvo que **el pronto pago consiste exactamente en adelantarse**. Medido contra prod: de los **$2,427,564** con ventana abierta sobre la deuda viva, **$1,522,587 (62.7 %) vivia en 358 facturas que la propuesta NUNCA ofrecia** porque todavia no vencen. Ahora entran, **solo** si su ventana cierra dentro de 5 dias **y** hay beneficio medido >0 (adelantar sin descuento seria sacar dinero antes por nada), con el **mismo margen** que el aviso de la pantalla; y **lo vencido va primero siempre**: si el disponible no alcanza se recorta el adelanto, nunca la deuda. ⛔ **Defecto propio cazado al escribirlo**: el subtitulo decia «la mas vieja vencio el X» usando `oldest`, que en un grupo que entra solo por descuento es **el limite de su ventana**, no un vencimiento — habria afirmado que una factura vencio cuando todavia no. Estaba en **dos** lugares (lo que cabe y lo que no) y las dos mentian. ⭐ **6 pruebas nuevas, cada una con su control negativo** (beneficio 0, ventana a 30 dias, ventana ya cerrada, sin ventana), 31/31 verdes, y **prueba negativa de la compuerta**: forzando `adelantable` a false, 3 se ponen rojas y vuelven a verde al restaurar. ⚠️ **Sin validacion visual.** | Claude |
| 2026-10-29 | **`[PGP.39]` Un detector que se calla deja RASTRO — 🧪 en codigo, sin aplicar.** Buscando por que no se aprovecha el pronto pago aparecio que `finance.findings` tiene `descuento_no_capturado` con **98 hallazgos por $5,363,294, los 98 SIN TRIAR**, y que **no produce desde el 2026-08-29** (61 dias). ⚠️ **Mi primera lectura fue «el motor de hallazgos esta muerto» y era FALSA** — queda escrita para que nadie la repita: el motor corre (163,420 hallazgos, 6,028 reescritos anoche, **13 reglas con `last_seen` de HOY**). El error fue **ordenar por antiguedad y leer el peor tramo como si fuera el todo**. Medido regla por regla: **13 vivas (160,834 hallazgos) · 7 tibias (539) · 24 MUDAS >30 dias (2,047)**, y **21 de las 24 se callaron el MISMO dia (2026-09-15)** — un corte unico, no 21 fallas. ⛔ **Por que fue invisible**: `maat-detector.service.ts` salteaba el detector que falla con un `logger.warn` + `continue`, y como la tabla **conserva los hallazgos viejos**, un detector parado se ve **identico** a uno sin hallazgos nuevos. Mismo patron que el repo ya tiene nombrado para las matvistas (*«una MV parada se ve VERDE», OBS.1*). Migracion `20261029171135`: cuatro columnas en `finance.rule_registry` (`last_run_at` · `last_ok_at` · `last_error` · `last_error_at`) que **nacen en NULL a proposito** —NULL es «nunca se midio», no «nunca corrio»; sembrarlas con `now()` dibujaria 75 reglas como recien ejecutadas, que es la mentira que esto cierra—, con tres controles (las 4 existen · universo 75→75 · ninguna nace con fecha). ⛔ El `UPDATE` va en **`SAVEPOINT`**: un detector que revienta deja la transaccion abortada y el rastro moriria con **25P02**, justo el que viene a dejar constancia del fallo. ⭐ **No arregla las 21 mudas a proposito**: todavia no se sabe POR QUE fallan, y adivinarlo sin el mensaje seria el mismo pecado — con esto, la proxima corrida lo dice. ⛔ **NO MEDIDO**: `libs/finance/src/lib/maat` no tiene specs. | Claude |
| 2026-10-29 | ⚠️ **Correccion de un defecto propio, cazado por la compuerta correcta.** `[PGP.38]` infirio `motivo` como `string` en vez de su union literal y rompia `ArmadoGrupo<T>` (**TS2322**). ⭐ **`check:pantalla` lo dio por bueno** («tipa, 0 errores semanticos») y lo cazo **`check-template-types`**, que es el unico local que tipa de verdad la plantilla — el gotcha que el repo ya documenta, vivido otra vez. El tipo ahora se **anota**. | Claude |
| 2026-10-31 | **`[PGP.40]`/`[PGP.41]`/`[PGP.42]` El sistema dice QUE PAGAR, y el dia sin tope deja de salir vacio — 🧪 en codigo, 2 migraciones sin aplicar.** ⭐ **Primera validacion visual de la fase**: Edgar mando la pantalla viva y salieron **dos defectos mios que ninguna compuerta habia visto**. (1) **El renglon no decia a quien se le paga**: «—» y «Sin sucursal» en 2 de 3 pagos. Era el fallback de `[PGP.35]` —la etiqueta se arma desde la deuda viva y una factura saldada vuelve vacia— que yo **declare en el contrato y deje pintado igual**. El nombre nunca se perdio: medido, **33 de 33** lo tienen en `kepler_ods.kdxe`, `kdxd` y en `catalog.suppliers`; ahora se rescata del universo completo, una consulta mas y solo cuando hay huerfanas. (2) **Pedia «Falta el metodo» con boton «Preparar»** sobre un pago que el sistema ya sabe que va a fallar — DESIGN §10 poka-yoke: si NINGUNA de sus facturas se debe no se pide preparar, se ofrece sacarlo del dia; si solo algunas, el pago si se puede hacer por el resto. ⭐⭐ Y el pedido que ordeno el resto: *«te pedi 100 % de automatizacion, ya el mismo sistema me debe decir que pago»*. Tenia razon — el Calendario sabia todo y **no lo decia solo**. `analytics.v_pago_sugerido` (migracion `20261031140043`) responde por acreedor cuanto pagarle, cuanto se gana, cuando cierra la ventana y si se puede preparar hoy: medido, **32 acreedores · pagar $9,196,114.81 · ganar $507,960.87 · 6 cierran hoy o manana · 3 con cuenta proponible**. Se carga **al abrir**, no al apretar. ⛔ Deja fuera los compromisos financieros —entre ellos los **prestamos de socios por $14,480,000** que Edgar confirmo ese dia, vencidos hace 22 meses, que encabezan cualquier orden por antiguedad y **nunca caben** en el tope de un dia— con **control negativo** en la migracion. ⚠️ NO excluye proveedor inactivo ni factura vieja: la vista propone por dinero en riesgo, **no depura cartera**. Y `[PGP.42]` cierra una contradiccion de la propia pantalla: decia *«se pueden armar pagos»* y `proponer()` se iba en seco sin tope de Presupuestos — **2 de los 7 dias** de la semana salian vacios con descuento venciendo. Ahora propone igual, **sin dibujar un «cabe» que nadie midio** y **sin auto-marcar nada**: marcar por omision contra un presupuesto no fijado seria elegir cuanto gastar en lugar de Presupuestos. 33/33 pruebas verdes con sus controles negativos. ⚠️ **Sin validacion visual** de lo nuevo. | Claude |
| 2026-11-02 | **`[PGP.43]` La vista que todavía no existe se DICE, no se devuelve un 500 — 🧪 en código.** Visto en la pantalla viva: el panel de «qué conviene pagar» mostraba *«Internal server error»*, porque el código de `[PGP.41]` llegó a un backend donde `analytics.v_pago_sugerido` no estaba — la migración va **antes** de soltar y ahí no se había aplicado. Es el mismo orden que ya costó el retiro de `[PGP.29]`. Ahora se atrapa **únicamente** `42P01` (`undefined_table`) y se traduce a un 503 que dice la verdad: *«todavía no está disponible en esta base: falta aplicar su migración»*. ⛔ Cualquier otro error sigue subiendo tal cual: un fallo de datos disfrazado de «todavía no disponible» sería peor que el 500. Y queda en el log con el nombre de la vista y el de su migración, que es lo que necesita quien lo va a arreglar. | Claude |
| 2026-11-03 | **`[PGP.44]` Lo que el panel dice que conviene pagar ahora se puede TOMAR — 🧪 en código.** ⭐ **Segunda validación visual de la fase, y otra vez la encontró Edgar mirando la pantalla, no una compuerta.** Cuatro defectos, el primero de fondo: **el panel afirmaba $479,287.84 de pronto pago en juego y no había ningún camino para tomarlo** — Ley 0 del estándar de interfaces (*nada afirma lo que no es, y todo lo que importa se puede alcanzar*). Ahora cada renglón es un botón que lleva a las facturas de ese acreedor con el buscador ya puesto; **no arma el pago solo**, lleva a donde se arma, porque `[PGP.15]` ya agrupa por proveedor y sucursal y agrega el grupo entero de un clic. Es la regla Q.4 (del dato a su lugar de arreglo con el filtro puesto), no una segunda interfaz para el mismo flujo. Los otros tres eran de veracidad del texto: *«y 32 acreedores más, por $239,108.55»* se leía como el importe de esos 32 —que suman **$4.7M**— cuando era **lo que ganan** de pronto pago; *«Para los 1 pagos»*; y el veredicto del tope repetía **palabra por palabra** la misma frase en el lugar donde iba la métrica. ⚠️ **Sin validación visual** del arreglo. | Claude |
| 2026-11-03 | **`[PGP.45]` La condición PACTADA del proveedor: «no da descuento» deja de ser indistinguible de «no preguntamos» — 🧪 en código, 1 migración sin aplicar.** ⛔⛔ **Y lo primero es que corrige un titular mío.** `[PGP.36]` publicó *«1,918 facturas, $73,571,291, el 52.7 % SIN MEDIR»* como si fuera la bolsa de pronto pago sin explotar. Medido hoy contra prod, el «sin medir» son $72,748,758.86 de $143,746,177.10 de deuda viva — pero **sólo $28,064,252.05 es deuda de COMPRA**. El resto es **$19,898,880.71 de crédito bancario** (BBVA, Bajío), **$17,980,000 de préstamos** (los de socios entre ellos), **$6,321,622.70 de gasto** (nómina, SAT, arrendamiento) y $477,859.40 de tarjetas y factoraje. Sobre un crédito de BBVA no hay pronto pago que capturar: perseguir los $72.7M era perseguir un número que incluye la deuda financiera. ⭐ **Y dentro de compra la concentración es extrema**: **9 acreedores cubren el 80 %**, y uno solo —`CB005` BOLSAS DE LOS ALTOS, 139 facturas— es **$14,861,580.73, el 53 %**. La captura no son 245 fichas: son **nueve preguntas**. ⭐⭐ **El hallazgo que ordenó el trabajo** apareció al mirar a quién se le paga: no son proveedores desconocidos, son los que más nos cobran — `CB005` **120 pagos y $34,465,840.40 en 12 meses con $0.00 de descuento**, `CH003` 41 pagos y $9,195,568.11 con $0.00, `CJ0036` 46 pagos y $5,903,842.23 con $0.00. **223 pagos · $51,553,655.21 · cero descuento registrado**, y el sistema los pinta `sin_medir`, o sea **se calla** — y un silencio se lee como «acá no hay nada que ganar». Hay **dos** explicaciones y hoy el sistema no puede distinguirlas: que no den pronto pago, o que lo dejemos pasar 120 veces al año. ⭐ **Kepler no tiene el dato y lo verifiqué en vez de suponerlo** (regla 10): `kdxd.c16` sí trae días de crédito (1,356 de 6,584 filas, 137 proveedores de compra), pero eso es el **plazo**, no la ventana del descuento; los descuentos del proveedor `c17/c18/c19` están **vacíos** (8 · 0 · 0 de 6,584). Por eso una tabla propia es legítima acá. Y la tabla **ya existía y estaba muerta**: `commercial.supplier_discount_policy`, **147 filas, todas `observed`, todas del 2026-08-05, `discount_days` vacío en el 100 %, nunca actualizadas**. Lo que entra: `source` admite **`'pactado'`**, una fila pactada **exige la fecha en que se pactó** (sin fecha no se contrasta) y, si declara descuento, **exige los días** (tasa sin ventana es el defecto que `[PP.0]` midió); ⭐⭐ **`pactado` con tasa 0 significa «preguntamos y NO da»**, que es una **medición**, no una ausencia; y `analytics.v_supplier_payment_terms` resuelve por proveedor **qué condición rige y de dónde salió**, con **lo pactado ganando sobre lo observado** y **lo observado viajando igual al lado**, que es lo que por fin permite la pregunta que `[PP.0]` dejó escrita: *¿nos dan lo que dijeron?* (`cumplimos`). Prueba nueva con **sus controles negativos** (`test-newdb-pgp45-condicion-pactada.js`): ejerce el **`up()` real** contra una base de verdad —no su SQL retipeado—, rompe los tres CHECK a propósito y verifica el rojo, siembra tres pagos a 20 días y comprueba que un pacto a 10 **gana** y reporta `cumplimos=false`, y separa los **tres** valores de `da_descuento` (`true` / `false` / ausente). ⛔ **Esto cierra C0 (el dato) y nada más**: la regla que lo lee (`sqlVentanaProntoPago`) **no** se cambió todavía a propósito, porque la vista aún no existe en prod y el código que la leyera antes de tiempo tiraría el Calendario con `42P01` — es el expand/contract que ya costó un incidente el 2026-10-30. | Claude |
| 2026-11-03 | **`[PGP.46]` Preparar un pago dejaba de ser un callejón sin salida — 🧪 en código, sin desplegar.** ⛔⛔ **El dato que ordenó todo lo demás: en 18 días nadie terminó de preparar un pago, ni una vez.** Medido en prod: **146 pagos creados, 0 con método**, 33 lotes **todos en `draft`** (0 autorizados, 0 cerrados), y **49 de 146 sacados del día con la ✕** — la única acción que alguien llega a completar. La pantalla tiene 5 pasos y **nunca pasó del 2**. Lo encontró Edgar diciendo *«demasiada carga visual, poco intuitiva y muchos clics»* y pidiendo el conteo; el conteo salió **81 clics + 24 CLABEs tecleadas** para un día de 24 pagos, pero la causa era más dura. ⭐⭐ **Tres puertas cerradas a la vez, y ninguna visible desde una sesión `superadmin`** —que es desde donde se venía mirando, y donde el guard da god-mode (*«admin/superadmin pasa todo»*)—: (1) `commercial.supplier_payment_accounts` tiene **0 filas**, así que «Aplicar a los 24» prepara método y origen y **deja los 24 sin destino** (`isPrepared` lo exige), con el aviso en un **toast de 10 s** y 24 nombres pegados por comas; (2) la CLABE tecleada **se guardaba sólo en ese pago** —`confirmPrepare` no escribía en ningún catálogo— así que la semana siguiente son los mismos 18 dígitos; (3) de los **9 roles con `FINANCE_PAYMENTS_GESTIONAR`, 8 no podían ni LEER el catálogo (403) ni PEDIR el alta** — sólo `gerente_compras`. El diálogo les decía *«pide a Compras que la dé de alta»*: salir de la pantalla y escribirle a otra área. Es la regla 20 textual. ⭐ **Y antes de construir, una medición mató la salida fácil**: llenar el catálogo desde el REP del proveedor (`analytics.v_supplier_account_proposal`, `[PGP.29]`) resolvería **1 de 34 pagos de la semana** ($16,475.45 de $7.8M) y **12 de 365 proveedores** de la deuda viva ($9.0M de $143.9M, 6.3 %); **745 proveedores no tienen REP ninguno**. El dato no existe: **lo tiene que capturar una persona, una vez**. Entonces lo que entra es quedárselo: teclear la CLABE al preparar **deja pedida el alta sola**, idempotente (diez pagos del mismo proveedor = **una** solicitud), y el diálogo la propone la próxima vez **con su procedencia** (quién la capturó, cuándo, y que **no está aprobada**) — patrón de `[PGP.30]`, un valor puesto solo sin decir con qué es una orden disfrazada. ⛔⛔ **Lo que NO se tocó: aprobar.** Sigue exigiendo `FINANCE_PAYMENT_CALENDAR_AUTORIZAR` (Dirección); una solicitud es una fila `pending_approval` que no mueve un peso. `clabeValida` sube a `libs/contracts` (ADR-056) porque ahora la usan dos fases y dejarla donde estaba creaba un **ciclo de importación** —que no falla al compilar, falla en ejecución con un `undefined` donde iba la función—, y nace `clabeDeTexto`, que **se niega a elegir** cuando el texto trae dos CLABEs. ⭐ **Dos defectos propios cazados por sus propias pruebas negativas, antes de salir**: el `where` de idempotencia filtraba por `status: 'pendiente'` y el CHECK de la tabla sólo admite `pending_approval|approved|rejected|applied` —no habría casado nunca y **cada pago habría dejado una solicitud nueva**, con el INSERT quedando bien por el DEFAULT de la columna, o sea **sin que nada se pusiera rojo**—; y la prueba que lo cubría **habría pasado igual**, porque el doble ignoraba los argumentos del `where` (un doble nunca valida SQL). 21 pruebas nuevas, **2,153 verdes en toda la suite de `finance`**, prueba negativa del grafo de Nest (quitar el import pone rojo el candado) y `@Optional()` a propósito: si el cableado falla se pierde el atajo, **no el pago**. ⚠️ **Sin validación visual** y ⚠️ **arranque no verificado en local** (toca una firma inyectada de Nest — lo mide `boot-api` en el CI). | Claude |
| 2026-11-03 | **`[PGP.47]` El preliminar dejaba de decir CONTRA QUÉ se paga — 🧪 en código, sin desplegar.** El documento que va a autorización imprimía **una fila por pago**, con los beneficiarios concatenados por `;` y **ninguna referencia al documento que liquida**. Quien firma, firmaba un total; quien arma el expediente físico volvía a la pantalla documento por documento. Lo escondido, medido contra prod: los **102 pagos vivos tapan 236 líneas de factura** (2.4 por pago, hasta 9) y el día de hoy son **71 documentos en 28 pagos**. Entra el desglose —un renglón por factura— con **sucursal por NOMBRE, folio interno, folio externo, fechas, importe del documento, lo que el pago le abona y qué papel existe** (cobertura sobre las 226 líneas derivadas vivas: folio interno **85.4 %**, folio externo **74.3 %**, PDF **62.8 %**, sólo UUID fiscal 15.9 %, **sin papel 21.2 %**), más un bloque **«Control del expediente»** que cuenta lo que hay que resolver antes de que el papel sirva de carátula. ⛔ **Las 33 facturas que el ERP ya tiene saldadas ahora lo gritan en su renglón**: hasta hoy sumaban al día como deuda viva y el problema aparecía al EJECUTAR, después de preparar, autorizar y firmar. ⭐⭐ **Tres mediciones cambiaron el diseño antes de rotular una columna.** (1) `referencia` (`kdxe.c16`) **NO es el folio del proveedor**: contrastada contra `fiscal.cfdis` anclando por RFC + importe ±$1, de **219 pares coincide en 4** exactos y 11 por dígitos, **con placebo (el folio interno de Kepler) en 0**; se teclea `0-F1549` contra un CFDI `F961549` y hay `40 S/N`. Es captura manual y se publica como tal. (2) `ref_evidencia` **son DOS cosas con la misma forma**: 142 líneas traen el id interno del comprobante y 36 el **UUID fiscal del SAT**, los dos de 36 caracteres — `uuid_fiscal` se llena **sólo** cuando la evidencia es `uuid`, porque publicar el otro mentiría en **142 de 178**. (3) El folio externo viaja con su **FUENTE en columna propia** (CFDI timbrado / OCR leído), porque una lectura de una foto no vale lo que un folio timbrado. ⛔ `goods_receipt_proofs.folio_interno` **no se usa**: 2 de 142 y **0 verificados**; el comprobante confirma el folio del ERP por otro lado (`p.folio` casa **142 de 142**). ⭐⭐ **La validación visual encontró un defecto que las 13 pruebas no vieron**: generado el papel con datos reales, el primer renglón publicaba como folio externo un **UUID** —el OCR a veces lee el identificador fiscal—; **5 de 35 folios leídos eran ilegibles (14.3 %)**, cuatro UUID y un `-1649` cortado. `folioExternoLegible` los descarta sin tocar los 30 buenos (tirar el OCR entero habría bajado la cobertura del **74.3 % al 16 %**) y la línea queda **«sin folio externo legible»**, declarada, **no promovida a `uuid_fiscal`** (una lectura no está casada con el documento). Verificación: el **SQL real del builder de knex** (compilado con `.toString()`, no uno parecido) corrido contra prod en READ ONLY devuelve **67 filas con todos los LEFT JOIN contra 67 sin ellos** —no pierde ni duplica—; **17 pruebas** nuevas con **tres controles negativos** verificados (código de sucursal crudo, obligación propia contada como «sin papel», filtro desactivado); **2,174 verdes** en toda la suite de `finance`; `tsc` acotado **38 = línea base**. ⚠️ El PDF **no se abrió**: se validó el HTML generado por el código real con datos de prod, **no el documento impreso**. | Claude |
| 2026-11-03 | **`[PGP.48]` Lo que la auditoría de `/finanzas/calendario-pagos` encontró afirmando lo que no es — 🧪 en código, sin desplegar, sin validación visual.** Auditoría con `auditoria-diseno` en **nivel B + C** (prod en sólo lectura + fuente; los dos navegadores los tenía otra sesión, así que **nada visual se dio por medido**). Seis defectos de veracidad y alcance, cada uno con su cifra de prod: ⛔⛔ (1) **$5,696,319.13 en 23 pagos se quedaron en 5 días ya pasados** (19 al 29-oct), ninguno preparado. Un pago pendiente aparta el saldo de sus facturas y la lista sólo trae `available_amount > 0`, así que **esas facturas desaparecían de «Agregar facturas» y de la propuesta**, y la tira —que sólo mira la semana— no lo decía; abierto el día, el veredicto pedía «Faltan N por preparar» como si siguiera vivo. Ahora: endpoint de sólo lectura `GET pendientes-atrasados` (**5.4 ms** en prod, devuelve las mismas 23 / $5,696,319.13: control cuadrado), una línea en la tira que lleva al primer día, el veredicto en rojo con **«Mover los N a otro día»** (un diálogo, reparto parcial reportado), y un día pasado **ya no recibe facturas** (el diálogo ya exigía `>= hoy`; el «+» no). ⛔ (2) **«se puede pagar el resto» era falso**: `execute()` rechaza el pago ENTERO si una sola factura está saldada, y quitar una factura no tenía botón aunque `DELETE allocations/:id/items/:itemId` existía. Ahora el renglón dice «quítalas para pagar el resto» con **«Quitar esas N»** (sólo en día sin autorizar: en uno autorizado cambiaría un importe firmado), y el desglose marca cuál ya no se debe. Exposición: 59 de 105 pagos pendientes llevan más de una factura; cuántos están hoy parcialmente saldados **NO MEDIDO**. (3) **El día sin tope proponía con casillas y SIN botón para guardar** (`[PGP.42]`): la rama «sin tope» del veredicto iba antes que la del día vacío. 5 de los próximos 14 días no tienen tope. (4) **La evidencia de la factura sólo se pedía para los primeros 50 renglones**; del 51 al ~1,000 no salía ni la factura ni el motivo. Ahora se pide toda, en tandas de 200 **en secuencia** (cada consulta tiene un piso de ~2.3 s; en paralelo serían cinco a la vez), y el renglón dice «buscando la factura…» o «no se pudo buscar». ⚠️ Costo declarado: hasta ~5 consultas de ~2.3 s por visita. (5) **Dos errores se pintaban como vacío**: falla de la deuda → «Sin obligaciones con estos filtros» y «0 por pagar» (ahora `LoadState` con error y reintento); falla del crédito a favor → **$4,484,249 de avisos desaparecían** sin decirlo. (6) **«y 32 acreedores más» no se podía recorrer** (37 acreedores, $8,771,120.69, gana $478,574.80; se veían 5): ahora se abre ahí mismo. Menores: `--action` salió del texto de urgencia (sólo el botón principal), voseo → tuteo, «la cola de la izquierda» → «la tira de arriba», «Mover» con fecha mínima y deshabilitado sin motivo, importe que acepta «1,250.00». **No se tocó (no es código, es de Edgar/Dirección)**: nunca se ha autorizado un día —**33 lotes, los 33 en `draft`**— y `FINANCE_PAYMENT_CALENDAR_AUTORIZAR` sólo la tienen `direccion` y `superadmin` aunque la pantalla dice «Gerencia o Dirección»; hoy el día excede el tope por **$950,840.35**; y el catálogo de cuentas de proveedor tiene **0 cuentas y 0 solicitudes** (lo ataca `[PGP.46]`, sin desplegar). Verificación: `ngc` sin errores, **arrancado con un control** (`{{ controlQueNoExiste() }}` → TS2339 en rojo; quitado); `tsc` de la API sin errores; `check:templates` verde; `check:pantalla` **0 fallas nuevas** (las 2 que marca, §9 frescura y definiciones en `title`, ya estaban selladas); 3 casos nuevos en `payment-calendar.it.spec.ts` (quitar una factura devuelve su saldo · ⛔ no se quita la única · los días pasados se listan y los futuros no) — **corren en el job `pruebas-db` del CI, NO MEDIDOS en local** (no hay Postgres local). | Claude |
| 2026-11-03 | **`[PGP.49]` La primera validación visual de `[PGP.48]` encontró lo que la auditoría no midió — 🧪 en código, sin desplegar.** Edgar mandó la pantalla viva (día 3-nov) y preguntó por carga visual, comprensión y accesibilidad: **la auditoría de `[PGP.48]` no las había medido** (de ahí la ficha nueva de `auditoria-diseno` §3c). Medidas con la captura y los tokens: ⛔ (1) **«100 % del tope» en un día al 115.4 %** ($7,129,178.35 de $6,178,338): el rótulo reusaba `usedPct()`, topado en 100 para la barra. Ahora el número es el real y la cifra excedida se rotula **«Excede»**, no «Libre -$950,840.35»; en la tira, **«excede $950.8K»** en vez de «$-950.8K libre», con letra de cifras sólo en la cifra. ⛔ (2) **«Aplicar a los 31» pisaba los 5 ya preparados** (un cheque se volvía transferencia): ahora sólo toca los que no están preparados, y la barra dice **«Para los 26 sin preparar»**. ⛔ (3) **Contraste**: el ámbar como texto (`--warn-fg`) daba **2.15:1** —los avisos de error eran lo menos legible de la pantalla, uno de ellos escrito en `[PGP.48]`— y el verde (`--ok-fg`) **3.30:1**; los 13 usos como texto pasan a `-soft-fg` (**7.09** y **7.13** en claro, **12.29** y **12.62** en oscuro; controles 21.00 y 4.48). (4) **Repetición**: «Falta el método» era pastilla ámbar en **26 de 31** renglones; ahora va sin tono —palabra, icono y peso, regla del PM del 26-oct, que manda sobre el criterio de `[PGP.19]`, que fue de una sesión—, y el paso «Armar» ya hecho deja de repetir «31 pagos · $7.13M». Elementos con color en la primera pantalla: **19 → 13**; «31 pagos» en pantalla: **6 → 3**. (5) **La evidencia de `[PGP.48]` salía pegada al folio** («0000304buscando la factura…») y repetida en 1,000 renglones: ahora el renglón calla mientras busca y **una línea arriba de la lista** dice cuántas faltan, o que falló, con «Reintentar»; se cuenta por respuesta, para que un documento que no regrese no deje «buscando…» para siempre. (6) El contador «Mostrando N de M» era `aria-live` y un lector de pantalla lo anunciaba **~19 veces** por carga: ya no. (7) 15 textos sin acento en pantalla y en `title` («se paso», «condicion», «credito»…). **Sigue abierto**: la lista arranca por $8M y $6M de préstamos de socios vencidos hace 22 meses y su rótulo dice «las más próximas a vencer» (decisión de Edgar: sacarlos del orden por omisión o esperar el dictamen de Contabilidad); el día excedido no propone qué mover; y el botón principal (blanco sobre `--action`) da **3.39:1**, un token de todo el sistema. | Claude |
| 2026-11-03 | **`[PGP.50]` La lista de deuda escondía la semana, «qué conviene pagar» tapaba el día, y el día excedido no decía qué mover — 🧪 en código, sin desplegar, sin validación visual.** Segunda revisión visual (captura de Edgar ya con `[PGP.49]`). ⛔⛔ (1) **La lista de «Agregar facturas» no traía NADA de esta semana.** Ordena por vencimiento ascendente y se topa en 1,000, así que entregaba las 1,000 MÁS VIEJAS mientras el rótulo decía «las más próximas a vencer». Medido en prod sobre la deuda de Kepler (aproximación: sin descontar reservas ni duplicados): corte en el **1-jun-2026** y **0 de las 160 facturas que vencen esta semana ($9,022,851.47)** en la lista. Nuevo orden `cercania` (días de distancia a hoy en CDMX, en los dos sentidos) como default de la pantalla: **160 de 160**, ventana 7-oct a 30-nov, y las 5 de más de un año (los $8M y $6M de préstamos de socios entre ellas) salen del arranque **sin esconderse por tipo** — siguen en «Más vencidas primero» y en el buscador. El backend conserva `vencimiento` como default (el armado y otras pantallas dependen de él); el rótulo ahora dice qué parte trae según el orden. ⛔ (2) **«Qué conviene pagar» se mudó al panel de «Agregar facturas»**: arriba de la tabla del día medía ~380 px y dejaba a la vista **2 de 31 pagos**, y en un día excedido decía «pagando $8.77M más se ganan…» justo debajo de «excede, quita pagos». Ahora: un renglón por acreedor, «sin cuenta para transferir» como una cifra en el encabezado (34 de 37) en vez de en cada renglón, y plegado por omisión cuando el día excede su tope (el encabezado conserva cuánto, a cuántos y cuánto se gana). (3) **El día excedido propone qué mover y a dónde**: los últimos del orden de pago hasta cubrir el exceso, cada uno al primer día siguiente con espacio en su tope; lo que el ERP ya no debe no se mueve. ⭐ **Repartir salió de una medición**: el exceso ($950,840.35) era mayor que lo libre de CUALQUIER día (máx. $912,434.29), así que un solo destino lo dejaba excedido. Simulado con los montos de hoy: 6 pagos ($1,015,591.37), 5 al miércoles y 1 al jueves, y el martes queda dentro con $64,751.02 libres. El diálogo enseña cuál va a qué día; nada sale sin el clic. Y «Buscando la factura de 550 facturas» → «… de 550 renglones». Prueba nueva en `payment-calendar.it.spec.ts` (el SQL de `cercania` corre contra Postgres en el job `pruebas-db`, **NO MEDIDO en local**). | Claude |
| 2026-11-03 | **`[PGP.51]` Con el día excedido, primero se quita lo que el ERP ya no debe — 🧪 en código, sin desplegar, sin validación visual.** Tercera revisión visual (captura local con `[PGP.50]`): la propuesta movía **6 pagos ($1,015,591.37)** a otros días mientras el encabezado decía «de los cuales $697,075.94 el ERP ya no los debe». Mover dinero que sí se debe con eso todavía adentro es mover de más. ⛔ Y **esa cifra estaba inflada** desde `[PGP.35]`: sumaba el pago COMPLETO de todo pago con al menos una factura saldada (uno de 4 facturas con 1 saldada contaba las 4); ahora suma sólo lo saldado (`kepler_saldadas_importe`). La cifra corregida de ese día **NO MEDIDA** (la saldada se calcula en el servicio, no en una tabla). El veredicto del día excedido ofrece primero **«Quitar lo que el ERP ya no debe»** —con un diálogo que dice qué pago sale del día y cuál sólo pierde algunas facturas—, y sólo después propone qué mover para lo que reste. Menores: «Ver la factura» dejó el naranja de acción (5 en la primera pantalla, compitiendo con el botón principal); el selector de orden decía «Más cercanas…» cortado y ahora sus opciones caben («Cerca de hoy», «Más vencidas», «Pierde descuento»). | Claude |
| 2026-11-03 | **`[PGP.52]` REDISEÑO de `/finanzas/calendario-pagos`: una columna, un paso a la vez — 🧪 en código, sin desplegar, sin validación visual.** Edgar, tras tres rondas de parches: *«sigue siendo un asco, necesito un rediseño a una más simple»*. Diagnóstico (`diseno` §3a) sobre su captura: contestaba **5 preguntas a la vez** (la semana, el día, qué agregar, qué conviene pagar, cómo sale cada pago) en dos paneles que se peleaban el ancho; **~70 controles y ~60 cifras** en la primera pantalla; cada pago en hasta 4 líneas con 5 controles; y fuera del veredicto todo medía 12–13 px. La causa de fondo: enseñaba **todo el proceso** cuando la persona está en **un paso**, más una lista de ~1,000 facturas siempre abierta que nadie recorre (*«el 80 % es el buscador»*). Ahora, en este orden: **la semana** (sólo lo libre; cada día dice lo suyo) · **el veredicto** con su UN botón, el tope en la tira de métricas y el avance en una línea (*«Paso 2 de 5: Preparar · Tesorería · 5 de 31 listos»*, eran cinco pasos) · **el buscador**, siempre a la vista; sin búsqueda, en lugar de la lista, tres enlaces con su cuenta (*«Conviene pagar: 37 acreedores…»*, *«Ver todas las facturas por pagar (2,867)»*, *«50 por confirmar»*); la lista aparece al buscar o con «Ver todas», con alto propio y «Cerrar la lista» · **los pagos del día**, un renglón por pago en columnas (*A quién · Cómo sale · Importe · acción*), con las flechas de orden al pasar el cursor o con el foco; el porqué del pago, las notas, lo saldado y cada factura viven en el **desglose**. Fuera del renglón: el «RFC deducido» (lo dicen la ficha y el PDF) y el color del pronto pago del encabezado. Efecto colateral medido en código: con la lista cerrada **ya no se pintan ~1,000 renglones ni se piden ~5 consultas de evidencia de ~2.3 s** por visita. Conteo en código (nivel C, sin pantalla): marco de la primera pantalla ~24 controles + 3 por pago (eran 5); ~30 cifras (eran ~60). **NO MEDIDO**: cómo se ve, la altura real, el teclado y `forced-colors`. Toda la lógica y todos los endpoints quedan iguales: cambia lo que se ve, no lo que hace. Verificación: `check:templates`, reactividad y estilos en verde; `check:pantalla` **0 fallas nuevas** y desaparece la de «definición escondida en un `title`»; `ngc` sin errores en este archivo. | Claude |
| 2026-11-04 | **`[PGP.53]` El pronto pago pasa a ser LO PRIMERO que se paga, con su porqué y por el día en que cierra — 🧪 en código, sin desplegar, sin validación visual.** Edgar, sobre su captura de `[PGP.52]`: *«mencionamos pronto pago, pero esa es la prioridad: recomendar firmemente que paguemos eso y por qué, desglosar por qué, y darle prioridad en base a su vencimiento»*. Era una línea plegada bajo el buscador y, abierta, 37 renglones planos con «sin cuenta» repetido. Ahora es una **sección propia entre el veredicto y «Agregar»**: título *«Paga primero el pronto pago»* + lo que se gana en la semana; una frase firme (*«N acreedores cierran hoy o mañana: si no se les paga a tiempo, se pierden  de descuento»*; si lo urgente pasa de lo libre del día: *«primero el de mayor %»*); **grupos por el día en que CIERRA el descuento** (hoy y mañana abiertos, los demás una línea con su total); renglón = a quién · importe · lo que gana · %; **desglose del porqué**: hasta qué día, cuánto y qué %, **con cuántos pagos del último año se midió y a cuántos días de la factura**, si además ya está vencida, si tiene cuenta, y si el día abierto ya es tarde. «Agregar» lleva a sus facturas (el mismo camino de `[PGP.44]`). Backend: `quePagar()` cruza `mv_supplier_prompt_discount` (la misma fuente que calcula `gana`) y devuelve `pagos_con_descuento`, `dias_tipicos`, `ganado_12m`; medido en prod (sólo lectura): **37 de 37** acreedores con evidencia, sin inflar, ~700 ms igual que antes (⚠️ la vista ya pasaba de 500 ms: deuda previa, no de este cambio). La tasa se contrastó contra Kepler: cada pago de CS006/CB004/CC025 registra c84/(c84+c16) = 6.90 % (28 de 28). ⚠️ **Abierto**: 65 proveedores observan exactamente 6.90 %; es lo que Kepler registró pago por pago, pero parece una tasa estándar y no un acuerdo por proveedor — la ficha pactada de `[PGP.45]` es la que lo resuelve. Se retiran 7 miembros y ~25 reglas CSS de la lista vieja. Verificación: `check:templates`, reactividad y estilos en verde; `check:pantalla` 0 fallas nuevas; `ngc` 0 errores en este archivo **con control negativo** (un binding inexistente en la sección nueva → lo marcó); `tsc` de la API en verde. **NO MEDIDO**: la pantalla viva (navegador ocupado por otra sesión), el teclado y el ancho angosto. | Claude |
| 2026-10-23 | ⚠️ **El tracker perdió los items PGP**: el incidente de `c7d94aa7b` (un commit que arrastró hunks ajenos) los devolvió al árbol y se descartaron. El código está en prod; la bitácora de esta fase es, por ahora, el único registro. Reponerlos exige tocar un archivo que otra sesión tiene en vuelo. | Claude |
| 2026-11-04 | **`[PGP.70]` Auditoría de `/finanzas/calendario-pagos` (nivel C + B, sin pantalla viva) y sus arreglos — 🧪 en código, sin empujar.** (1) La ✕ «Quitar del día» actuaba con un clic, sin confirmar ni deshacer, y se perdía la preparación: ahora abre «Quitar del día», que dice qué se pierde y ofrece «Mover a otro día» (conserva método y cuentas); la ✕ y el botón se apagan mientras guarda. (2) «Pagado» en la fila marcaba sin confirmar algo que aquí no se deshace: abre el MISMO diálogo que el lote, con ese pago solo. (3) «búscalo arriba» apuntaba a un buscador que desde PGP.66 vive en «Agregar facturas». (4) El panel de pronto pago repetía su título. (5) «netear» → «descontar del pago», «documento(s)», «Elígela», «de más». **Medido en prod (sólo lectura):** de 74 pagos quitados, 47 se volvieron a agregar (la mitad en menos de un minuto), pero 65 de las 74 bajas son de cuentas de prueba: para la gente real **no es concluyente**. Reordenar (`/orden`) se rechazó en 38 de 41 intentos de Contabilidad, Finanzas y Tesorería, todos antes de que PGP.60 llegara a prod: después, **NO MEDIDO**. ⛔ El hallazgo de fondo: desde el 16-oct **ningún día se ha autorizado ni se ha marcado un solo pago como pagado**, y 180 de 188 pagos los crearon cuentas de prueba — autorizar, pagar, rebotó y cerrar **nunca se ejercieron en prod** (regla 13). | Claude (auditoría) |
| 2026-11-04 | **`[PGP.71]` O3 abierto por el PM (PGP-C, por encima del cupo) — C0 re-medido y C1 en código, 🧪, sin tocar Kepler.** ⛔ El C0 del 22-oct no veía que Kepler **guarda** el saldo de la factura (`kdxe.c20`, 2,072 de 2,081): el pedido de permisos suma `UPDATE (c20)` sobre `md.kdxe` (§4 · C0). Decodificados contra 471 pagos: importe, referencia, cuenta de tesorería, concepto, IVA/IEPS proporcional (471 de 471) y domicilio. Declarados: `c86` (sin fuente) y los pagos con conceptos mezclados (se rechazan). Armador, compuerta E3.3 e interruptor E3.5 con 20 pruebas y dos mutantes en rojo. Falta: los `GRANT` (quien administra Kepler), leer la plantilla en vivo, el adapter C2 y que un día cierre en la Suite. | Claude |
| 2026-11-04 | **`[PGP.58]`/`[PGP.59]` Desde el pago se abre la factura y se ubica por su folio — 🚀 en prod.** Edgar: *«¿puedo ver la factura en PDF o imagen? el folio interno para ubicarla»*. El desglose de cada pago trae **Folio Kepler** (abre su ficha) · **Referencia** · **Factura** («Ver la factura», «sin archivo; hay UUID» o «sin factura»). Medido: de 182 facturas, **121 tienen archivo, 44 sólo UUID y 18 nada**. `[PGP.59]`: «Ver la factura» abría *Cannot GET* porque una llave del bucket no es una URL; ahora sólo se firma `^https?://` y, si había archivos y ninguno firmó, se dice. De paso, 11 anillos de foco hechos con el halo `--action-ring` (1.56:1, no se ve) pasan a `--focus-ring`, y `check:estilos` lo frena desde `[AUD.4]` (techo 39 en el repo). |
| 2026-11-04 | **`[PGP.60]`/`[PGP.61]` Con el día armado, los pagos van arriba — 🚀 en prod.** Medido: 104 de 109 pagos armados esperaban PREPARAR y el primero aparecía cortado bajo 8 grupos de pronto pago. Cada renglón dice **«por qué hoy»**, una **línea de corte** marca desde qué pago lo acumulado ya no cabe en el tope, y reordenar va en 3 pasos (en paralelo chocaba con la regla del rango único: **68 de 178** POST fallaban). «sin tope» quedaba a 3.62:1 por un `opacity:.7`: el día vacío se angosta en vez de atenuarse. `[PGP.61]`: del pronto pago, los 3 días que cierran primero; el resto en una línea. |
| 2026-11-04 | **`[PGP.62]`–`[PGP.64]`, `[PGP.66]` El día entra sin desplazar, y lo secundario va en paneles — 🚀 en prod.** Edgar: *«todo tiene que entrar sin hacer scroll»*, después *«está muy compactado… ¿cómo se vería con paneles laterales?»* (eligió la opción B y la densidad cómoda). Fuera lo que no decide (el total de libres, «0 de 10 listos», la nota de la favorita); el veredicto en dos renglones; el tope y el paso viajan al encabezado de los pagos; el pronto pago nace cerrado con el día armado. `[PGP.66]`: pronto pago y agregar facturas son botones de la barra que abren su panel lateral, y cada pago mide 48 px. Medido a 2135×1232: el día entra completo (15 pagos). ⚠️ A 1920×970 sobraban ~204 px antes de los paneles: **no re-medido**. |
| 2026-11-04 | **`[PGP.67]` Un pago CANCELADO en Kepler no saldaba la deuda — 🚀, migración aplicada en prod.** Edgar: *«la 168 D ($11,799) se tiene que poder pagar hoy»*. Kepler **no borra** las aplicaciones (`kdxf`) de un pago cancelado (`kdm1.c43='C'`), y `v_supplier_payables` las restaba: **22 documentos por $335,033** se veían saldados. Ojo: el folio del pago se repite entre documentos, así que el cruce va por sucursal, `c1`, proveedor, tipo, sub y folio (sólo por folio daba 25 y $341,149, mal). Costo medido: mediana **381 ms** contra 331 ms. Verificado en prod: la CFE 168 queda pendiente por $11,799. Antes de pagarla, Tesorería confirma que la CFE no la cobró ya por cargo directo. |
| 2026-11-04 | **`[PGP.68]` El Preliminar dice CÓMO se paga cada pago — 🚀 en prod.** Edgar: *«hay que agregar al preliminar cuando se paga con cheque o con qué banco se debe pagar»*. Cada pago dice método, banco y número de cheque o cuenta destino, y lo que falta se nombra («banco sin elegir», «sin número de cheque», **FALTA DEFINIR**) en vez de dejarlo en blanco. Nueva tabla «Cómo sale el dinero del día», por método y banco, con lo que falta al final. 32 de 32 pruebas; un mutante pone 2 en rojo. |
| 2026-11-04 | **`[PGP.69]` → `[PGP.72]` El comprobante de pago se adjunta desde Pagos — PGP.69 🚀; PGP.72 🧪 sin empujar.** Edgar: *«optimizar el tener que ir a Pagos a proveedor»*. Primero un panel lateral propio (`[PGP.69]`, en prod). Edgar: *«sólo un apartado donde se pueda soltar el PDF»*: se quitó y se reusa el componente compartido `app-pagos-captura-lote` (`f79faa085`, en prod: ⚠️ su mensaje dice `[PGP.71]`, número que ya era de O3, y `68cef19e7` renombró sus marcas). Edgar: *«sólo replicar ese botón en un apartado pequeño»*: el componente gana un modo **compacto**, un botón de 28 px en la barra de los pagos que recibe el PDF soltado; la bandeja de confirmación sale sólo con archivos. «Ver con diferencias» abre «Pagos a proveedor» ya filtrada (`?estado=`). Guardar sigue siendo un clic (PC.3). **NO MEDIDO**: soltar un PDF real (sube y lee: escribe). |
| 2026-11-04 | **`[PGP.73]` «Mover a otro día» dice lo que cuesta — 🧪 sin empujar.** De una auditoría externa sobre una captura (*«mover 18 pagos sin riesgos ni impacto económico»*), contrastada en vivo: la ventana ya listaba cuáles y a qué fecha, pero no el costo. De los 18 que el veredicto proponía mover, **3 traían pronto pago por $23,387.58** y nada lo avisaba, y con una sola fecha el jueves 5 quedaba **excedido por $1,130,078.10**. Ahora cada pago dice el pronto pago que deja pasar a la fecha elegida, la suma lleva sus nombres, se dice cómo queda el día destino (o que no se mide), y el veredicto avisa antes del clic. «Deja pasar», no «pierde»: la ventana es observada. ⚠️ **Decisión de Edgar, abierta**: qué se mueve sigue siendo «los últimos del orden» (`[PGP.50]`); no tocar ningún pronto pago ese día obligaba a mover la factura vencida hace 134 días ($1.1M). |
| 2026-11-04 | **`[PGP.74]` Lo cierto de esa auditoría externa — 🧪 sin empujar.** De sus 15 puntos, 4 eran ciertos y baratos (los demás, falsos o resueltos: la ✕ ya confirma desde `[PGP.70]`, «Aplicar a los 20» sólo toca los sin preparar, el texto secundario da ≥4.80:1, a 390 px son tarjetas). (1) **Cabecera fija**: `surf-table--sticky` sola no alcanzaba porque PrimeNG pone `overflow:auto` **en línea** al contenedor de toda `p-table`. ⛔ Esa clase aparece **127 veces** en el repo, y en las `p-table` queda sin efecto: el arreglo global va aparte. (2) **El importe al lado de a quién**: de ~1,720 px a 848 a 2,135 de ancho (458 a 1,440). (3) «sin tope» → **«sin tope fijado»**: se leía «sin límite». (4) «Preliminar» → **«Preliminar para autorizar»**. |
| 2026-11-04 | **`[PGP.75]` Los pagos del día llegan prellenados con su historial — 🧪 en código, sin validación visual, sin empujar.** Pedido de Edgar («que todo venga autorrellenado con sugerencias históricas»); eligió *historial + una decisión*. Medido sobre 76 pagos pendientes: el **método** sale del hábito en 55 (PGP.30) y la **CLABE destino** de una fuente nueva, el OCR de los comprobantes de pago del propio proveedor (`supplier_payment_proofs`: 1,350 comprobantes, 140 acreedores con CLABE, 126 con una sola; 55–118 ms al vuelo, sin migración) en 48; con método y CLABE quedan **48 de 76 listos contra 3**. La **cuenta de origen no** se propone por proveedor (la decisión medida de arriba sigue en pie): se elige una vez para el día. Cada renglón dice «Sugerido: … » con su procedencia; «Aplicar a los N» usa el método de cada proveedor y su CLABE (la favorita aprobada gana; la del historial queda pedida de alta, PGP.46). El diálogo «Preparar» precarga la misma CLABE con su procedencia. De paso, `kdm1.c86` = los últimos dígitos de esa CLABE (746 de 815). | Claude |
| 2026-11-05 | **`[PGP.76]` Reordenar los pagos del día sin pasos — 🧪 en código, sin validación visual, sin empujar.** Edgar: «mover el orden de los pagos es demasiado complicado». Eran flechas ↑↓ escondidas que movían de a un lugar, y cada clic eran 3 escrituras y una recarga de la semana: llevar el pago 20 al turno 1 eran 19 clics (`ui_usage`, 30 días: 234 `POST …/orden`, 71 con error). Ahora la fila se **arrastra** por su asa y, con el foco en el asa, ↑ ↓ mueven de a uno e Inicio/Fin al principio o al final; la lista cambia al instante y se guarda **completa en una sola escritura** (`POST days/:date/orden`), que rechaza entera una lista que no es la de pendientes del día y un día ya autorizado. Prueba contra base real `test-newdb-pgp76-orden-del-dia.js` en `pruebas-db` (NO MEDIDA en local: sin base de pruebas); la expresión del UPDATE se ejerció como SELECT de sólo lectura contra prod. Pendiente: en pantalla táctil no hay arrastre. | Claude |
| 2026-11-05 | **`[PGP.78]` «Kepler ya no tiene saldo» de una factura que Kepler sí debe — 🧪 en código, sin empujar.** Edgar lo vio al agregar una factura buscada por nombre. El candado de saldo (`assertKeplerBalance`) buscaba el documento por el código del proveedor **sacado del catálogo**; un acreedor de Kepler que no está dado de alta no tiene fila ahí, la suma salía vacía y se leía como saldo cero. Medido en prod (sólo lectura): 4 facturas de 3 acreedores, unos $63 mil, imposibles de programar. Ahora la deuda derivada lleva su código de Kepler y el candado busca por él (control en prod: el candado nuevo da el saldo de la factura; el viejo, nada). De paso, la llave del pago (`paymentGroupKey`) juntaba a **todos** los acreedores sin id de la misma sucursal en un solo pago; sin id ahora va por nombre, como ya lo hacía la pantalla (prueba nueva, rota a propósito con la llave vieja: roja). ⚠️ Hallazgo aparte, sin tocar: 16 facturas capturadas por Entregas ($1.09 M) siguen listadas como por pagar aunque Kepler ya no las debe; al agregarlas sale el mismo aviso, y ése sí es verdadero. | Claude |
| 2026-11-06 | **`[PGP.79]` Firmar en Aprobación de gastos AUTORIZA la solicitud en Kepler — 🧪 en código, APAGADO, sin empujar.** Decisión del usuario: la firma de `/finanzas/aprobacion-gastos` reemplaza a «Autorización de Sol Gasto» de Kepler; rechazar NO cancela allá (por ahora). **Ingeniería inversa** (sólo lectura): el «Grabar» de esa pantalla reescribe toda su lista pendiente, una transacción por renglón (visto en `md_00` y dos veces en `md_01`); en esas transacciones, sobre las **360 tablas** de `md_01`, sólo cambió `kdm1`, y en `kdm1` lo único que distingue a una autorizada es `c43` (5,180 solicitudes de 120 días). O sea: **`kdm1.c43 N → A` y nada más**. `orglogtbl_26` es la bitácora de sesiones, no de documentos. **Permiso**: `GRANT UPDATE (c43) ON md.kdm1 TO kepler_push` corrido por el usuario en las 9 bases (en cada servidor, local); verificado desde `md`: `c43` sí, el resto de la tabla no. **Código**: regla pura `autorizacion-kepler.ts` + adaptador `KeplerAutorizacionGastoAdapter` (UPDATE por la llave primaria con `c43='N'` en el WHERE: idempotente y nunca encima de A/F/C) + `approve()` lo llama DESPUÉS del commit de la firma y anota el resultado en 3 columnas nulas nuevas (`kepler_authorization_status/_at/_note`, migración `20261106135537`). Apagado con `KEPLER_GASTO_AUTORIZACION`. **Pruebas**: unitarias (10 ✓) · arranque `design:paramtypes` (3 ✓; rota a propósito quitando el provider: 3 ✗) · contra Postgres real `test-newdb-kepler-autorizacion-gasto.js` (14 ✓ en local, con un rol de SÓLO `UPDATE (c43)`; mutante sin `c43='N'`: 5 ✗) · ensayo contra el Kepler vivo con ROLLBACK (`ops/prod/ensayo-autorizacion-gasto/`, desde `md`, 2026-11-06): **verde en las 9 sucursales** — el adaptador real escribió la `A` sobre la solicitud en `N` más reciente de cada una, se vio `A` dentro de la transacción y, tras el ROLLBACK, `N` con otra conexión. **Despliegue**: migración aplicada en prod (14:16), en prod desde `4bdf3fadd` (14:28, `/api/health`); la API ya trae `KEPLER_PUSH_URL_00…08` del secreto `kepler-push`, todas con el usuario `kepler_push`; `KEPLER_GASTO_AUTORIZACION` sin poner = apagado. **🚀 ENCENDIDO 2026-11-06 ~14:50 (autorización del usuario), en las 9 sucursales**: la llave va en el secreto `prod/kepler-push` (no lo define ningún manifiesto: sobrevive a `aplicar-k3s-prod.sh`) + `rollout restart deploy/api`; verificado `printenv` en los 2 pods y `/api/health` ok. Apagar = quitar la llave del secreto + `rollout restart`. ⚠️ Medido: de los vales firmados en 30 días, Kepler ya tenía 338 en F y 63 en A al firmar; sólo 1 en N — sirve cuando Finanzas deje de autorizar allá. ⚠️ Hallazgo de seguridad, sin tocar: `pg_hba` de Padre Hidalgo y Canindo (y probablemente Morelia Madero) acepta `host all all 0.0.0.0/0 md5`, y la contraseña de `sa` quedó escrita en un chat. **Falta**: que Finanzas deje de autorizar en Kepler, y ver la primera firma real escrita (al encender no había ninguna). | Claude |
| 2026-11-06 | **`[PGP.80]` Aprobación de gastos dice dónde está cada solicitud en Kepler — 🧪 en código, sin validación visual, sin empujar.** Pedido del usuario: *«en la interfaz, el folio y todo eso»*. Medido: `del-dia` (lo que lee la pantalla) no traía nada de Kepler —ni estado ni constancia— y el renglón mostraba el folio pelón. Ahora: (1) el renglón nombra la solicitud como la busca Kepler (`XA1501-0009678`) y trae **una pastilla** —«sin autorizar», «autorizada por la Suite», «autorizada», «aplicada», «cancelada», «no se pudo autorizar», «sin medir»; la frase lo dice, el color acompaña—; (2) el detalle del vale gana «Solicitud en Kepler»: estado hoy y qué hizo la Suite al firmar, con quién y cuándo, o el motivo y qué hacer; (3) al aprobar, un aviso dice qué pasó en Kepler y el «no se pudo» se queda en pantalla. La lectura va en su **propio endpoint** (`GET /finance/expenses/kepler-autorizacion?ids=`, `FINANCE_EXPENSES_COMPROBAR`, hasta 200 ids; la pantalla pide en tandas de 150) para no tocar `delDia()` mientras otra sesión lo traía en un merge. La regla de la pastilla y la frase viven en el contrato (`lecturaKepler`, `explicacionKepler`): una para el renglón y el detalle. ⛔ Fuera de la vista es «sin medir», nunca «sin autorizar»; si la consulta falla, el renglón dice «no se pudo consultar». **Pruebas**: contrato (40 ✓) · arranque `design:paramtypes` del controlador y el servicio nuevos (4 ✓) · pantalla y componentes (203 ✓; 5 nuevas; mutante que calla el fallo: rojo) · `check:pantalla` 0 fallas nuevas. Lo de la búsqueda de arriba sólo trae la pastilla al abrir el vale. | Claude |
| 2026-11-06 | **`[PGP.90]`–`[PGP.92]` reservados para lo de Francisco que el rediseño no trae.** El PR #482 (sus `PGP.50`–`57`) se cerró sin fusionar porque `[PGP.52]`–`[PGP.79]` rehicieron la pantalla. De lo que pedía, tres cosas siguen sin estar en `main` (medido con `git grep`): **`[PGP.90]` referencia fija en la cuenta de pago**, **`[PGP.91]` descuento al pagar** y **`[PGP.92]` quitar UNA factura de un pago** (el endpoint `DELETE allocations/:id/items/:itemId` ya existe y lo usa «Quitar las que el ERP ya no debe»; falta el botón por factura). Los números saltan a 90 para no volver a chocar con los de Edgar. | Claude |
| 2026-11-06 | **`[PGP.90]` La referencia fija de la cuenta de pago — 🔨 en código, sin empujar, sin validación visual.** Proveedores que exigen la MISMA referencia (convenio) en cada transferencia: sin ella no identifican el depósito. Mig `20261106172407` (dos columnas `text` NULLABLE: la de la cuenta y la propuesta; aditiva, idempotente, sin aplicar). Pasa por la MISMA firma que la CLABE: se propone en «Cuentas de pago», se aplica sólo al aprobar y viaja en el texto del destino de cada pago (lo que imprime la instrucción a Caja General). ⭐ Hueco del diseño de `#482` corregido: una solicitud de CAMBIO que no trae el campo **conserva** la vigente (antes la habría borrado al aprobar); vacía la quita. Pantalla: la referencia va como segunda línea de la celda CLABE y sólo si existe — no columna propia, porque hoy ninguna cuenta la tiene y una columna de guiones no decide nada; el valor se selecciona entero para pegarlo en la banca. En «Preparar» del Calendario se ve al elegir la cuenta. Regla 14: el único camino montado que escribe esas tablas es `libs/finance/.../supplier-payment-accounts.service.ts`; el gemelo de `libs/commercial` no lo registra ningún módulo (código muerto). Verificación: `tsc` de los archivos tocados 0 errores (control negativo: un error sembrado sí lo marca); `check:pantalla` 0 fallas nuevas en las dos pantallas; templates/tokens/emojis/teclado en verde; `check:estilos` rojo por +1 `outline` ajeno (0 en este diff). **NO MEDIDO**: la prueba de integración nueva (`supplier-payment-accounts.it.spec.ts`, 5 casos contra Postgres real) corre en el CI (`pruebas-db`), en local se salta por falta de base; la pantalla viva. | Claude |
| 2026-11-06 | **`[PGP.92]` Quitar UNA factura de un pago desde su desglose — 🔨 en código, sin empujar, sin validación visual.** El endpoint `DELETE allocations/:id/items/:itemId` ya existía (lo usa «Quitar lo que el ERP ya no debe», `[PGP.48]`/`[PGP.51]`), pero no había botón para quitar una factura cualquiera: había que quitar el pago entero y volver a armarlo. Ahora cada factura del desglose lleva su ✕, sólo en un pago pendiente de un día SIN autorizar y si el pago tiene más de una (la última se quita con la ✕ del renglón, `[PGP.70]`). Se confirma en un diálogo, como `[PGP.70]`: dice qué sale, cuánto le queda al pago y que conserva su preparación. ⭐ El candado del día autorizado pasa al SERVIDOR (antes sólo lo escondía la pantalla: con una pantalla vieja se cambiaba en silencio un importe ya firmado) y `removeItem` registra `updated_by`. La revisión adversarial (3 revisores, 2 escépticos por hallazgo) confirmó 2 defectos, ya corregidos: el aviso decía «regresa a lo que se debe» también de una factura que el ERP ya no debe (no regresa: la deuda sólo trae lo pendiente), y las dos firmas reescritas no declaraban tipo de retorno (la compuerta `boundary` del push). Refutó 3. Prueba negativa nueva en `payment-calendar.it.spec.ts` (día autorizado → rechazo, el pago queda igual). Verificación: `check:pantalla` 0 fallas nuevas; templates, tablas densas, tokens, emojis, teclado y reactividad en verde; `tsc` sin errores en las líneas tocadas. **NO MEDIDO**: la prueba de integración (corre en el CI, `pruebas-db`); la pantalla viva. | Claude |
| 2026-11-06 | **`[PGP.91]` Descuento al pagar, factura por factura — 🔨 en código, sin empujar, sin validación visual, migraciones SIN aplicar.** Proveedores que al pagarles descuentan (3 % de pronto pago, volumen): Tesorería sacaba el neto a mano y el sobrante de la factura se volvía a ofrecer mientras llegaba la nota de crédito. Modelo de #482 (Francisco), rehecho sobre el rediseño: `applied_amount` sigue siendo el NETO que sale del banco y lo CUBIERTO es neto + descuento (eso es lo que deja de ofrecerse: reserva, Agregar facturas, Pronto pago, `v_pago_sugerido`). C0: migs `20261106183612` (6 columnas en `payment_allocation_items` con quién/cuándo y 4 CHECK; ⛔ va en prod ANTES del código) y `20261106183613` (`v_pago_sugerido` sobre el cuerpo de `[PGP.41]`, ancla verificada una vez). C1: `descuento-al-pagar.ts` (un solo validador para los tres caminos; el servidor revisa la cuenta ±1 centavo) + `descuentoSobreCubierto`. C2: endpoint nuevo `POST allocations/:id/items/:itemId/descuento` (0 lo quita; candado de día autorizado; `forUpdate`), alta/agregar/mover/marcar pagado con descuento, PDF y expediente («Factura − descuento», ya no «pago parcial»), Pronto pago sin el sobrante, ficha del documento. C3: botón «Descuento» en el desglose sólo donde el servidor lo acepta; diálogo con motivo, % o pesos y la cuenta «este pago cubre − descuento = se transfieren»; el % de «Pronto pago» se precarga con la tasa OBSERVADA y lo dice («observado, no pactado»); avisa que si Kepler ya trae la nota de crédito no se captura (doble descuento). Decisiones (recomendación del plan, = #482): D1 en el desglose, D2 precarga observada, D3 al mover viaja y se avisa, D4 un parcial con descuento sale entero del sugerido; **por ratificar con Edgar: D6 (reservar `[PGP.93]` para seguir la nota de crédito) y D7 (basta `GESTIONAR`: el descuento sale en el PDF que firma Gerencia)**. Revisión adversarial de la pantalla: 11 confirmados, 0 refutados, todos corregidos (⭐ el campo de pesos leía «1166,40» como $116,640 y lo dejaba guardar; ahora coma o espacio ambiguos se rechazan). Verificación: 25 + 22 + 37 + 33 + 124 pruebas unitarias en verde con controles negativos; `check:pantalla` 0 nuevas; tsc y templates-types sin errores en lo tocado. **NO MEDIDO**: 20 casos de integración nuevos (CI, `pruebas-db`), el arranque con el `@Body()` nuevo (caso #414; DTO como interfaz, igual que `AllocationItemDto`), la pantalla viva. | Claude |
| 2026-11-06 | **`[PGP.94]`–`[PGP.98]` El cierre del día contra lo que Kepler pagó — `[PGP.94]`–`[PGP.96]` 🧪 en código, sin empujar, sin validación visual, sin migración.** Pedido de Francisco (las mejoras que pidieron los usuarios tras los primeros días; lo habló con Edgar el 2026-11-06). **Medido (prod, sólo lectura):** 0 días autorizados y 0 pagos `executed` en todo el Calendario; de los 71 pendientes en días pasados (19-oct a 5-nov, $13.9 M) Kepler ya había pagado **30 ($6.05 M)** —18 el mismo día, 9 un día después, 3 antes de programarlos—, 5 en parte, **36 ($6.25 M) sin pagar y ninguno con día nuevo**, 6 sin medir (facturas que no son de Kepler). **D1 (Francisco): se cierra SOLO**, con el número de pago y su PDF. **`[PGP.94]` C1+C2**: `cierre-kepler.contract.ts` (la regla: tipo del documento por `kdmm`, estado por factura y por pago, desfase en días, frase) y `cierre-kepler.sql.ts` (la lectura: `kdxf` abono→cargo, fecha y cuenta del `kdxe` D, nombre de la cuenta en `kdb1`, comprobante en `supplier_payment_proofs`). ⛔ Fuera los pagos CANCELADOS con el cruce de `[PGP.67]` (707 de 11,955 aplicaciones desde septiembre lo son), y lo pendiente con la misma cuenta que `v_supplier_payables`. Tiempo: 2,004 → 125 ms (todos los días pasados) y 388 → 86 ms (un día) al agregar c1 y proveedor al cruce, medido sin cambio en ningún número. `listDayAllocations` trae `kepler_cierre` por pago; no se guarda nada. **`[PGP.95]`** `pendientes-atrasados` cuenta sólo lo que Kepler no ha saldado (`pagos`/`monto`) y dice aparte `conciliados`/`conciliados_monto`. **`[PGP.96]` C3**: en un día pasado, el renglón saldado dice «Pagado en Kepler el mismo día · Transferencia XD2601-0017253 · SANTANDER 2169» con botón PDF (si hay comprobante) y sin Mover ni ✕; el desglose lista cada documento (sucursal por nombre, fecha, cuenta, importe, PDF o por qué no hay); el encabezado dice «N pagos por $X pagados en Kepler»; el veredicto cuenta y mueve sólo lo que falta. En un día por venir no cambia nada: lo que Kepler ya pagó sigue siendo «quítalo del día». ⚠️ **Cobertura de PDF: 0 de 65 documentos** — el último comprobante de transferencia entró el 5-oct y los pagos de sucursal no están en el espejo de pagos. **Pendientes con número:** `[PGP.97]` cumplimiento del programa y lo pagado FUERA de él (3–5 nov: $1.45 M de $5.39 M a proveedores de compra, 47 pagos a 28 proveedores) · `[PGP.98]` no dejar programar lo que Kepler ya pagó. **Verificación:** 16 + 8 pruebas unitarias (mutantes: holgura 3→4 y quitar el proveedor del cruce de cancelados, los dos rojos); `tsc` de la API sin errores en lo tocado (control sembrado: rojo); `check:templates-types` verde (control sembrado: rojo en la línea exacta); `check:pantalla` 0 nuevas. **NO MEDIDO**: el caso de integración nuevo (F1 pagada vs F2 con transferencia cancelada; CI, `pruebas-db`); la pantalla viva. | Claude |
| 2026-11-07 | **`[PGP.99]` Una nota de crédito CANCELADA en Kepler escondía la deuda — 🧪 migración en código, sin empujar, SIN aplicar.** Reportado: la orden de entrada de Hershey `XA2001-0000684` (sucursal 01) no aparecía para capturarla en el Calendario. Kepler la debe ($64,672.73 en `kdxe.c20`). La nota `X-D-55 0000130` se canceló y se recapturó como `0000131`; Kepler no borra la aplicación cancelada de `kdxf`, la vista sumaba las dos, el pendiente salía negativo y se filtraba. `[PGP.67]` sólo restaba pagos cancelados (`25/26/60`); ahora también notas (`55`) y devoluciones (`40`). Medido en prod (sólo lectura): reaparecen **23 documentos** (13 de un mismo acreedor por una sola nota cancelada); los 23 casan al centavo con el saldo que Kepler guarda. Vista 349–412 → 370–417 ms. El SQL del `up` y del `down` se ejerció contra prod en transacción READ ONLY: el `down` reproduce la vista actual fila por fila. Mig `20261107113116_pgp99_nota_cancelada_no_salda_la_deuda`. |
| 2026-11-07 | **`[PGP.94.1]` El cierre descarta los mismos documentos cancelados que la vista — 🧪 en código, sin migración.** `[PGP.99]` le sumó a `v_supplier_payables` las notas de crédito (55) y devoluciones (40) canceladas, y `cierre-kepler.sql.ts` (`[PGP.94]`) se quedó con la lista vieja de `[PGP.67]` (25/26/60): en las facturas del Calendario había 6 aplicaciones canceladas ($62,627.51) que la vista restaba y el cierre contaba. Ahora la lista es una constante (`TIPOS_CANCELADOS_QUE_NO_SALDAN` = 25, 26, 40, 55, 60) y una prueba la amarra al `up()` de la migración más nueva que fija la de la vista: si se separan, rojo. **Medido en prod (sólo lectura), 307 facturas del Calendario:** cierre y vista NO coinciden en **0** con la lista nueva y en **1** con la vieja (control). Prueba del ancla contra la migración de `origin/main`: lista nueva verde, lista vieja roja. **NO MEDIDO**: la pantalla viva. | Claude |
| 2026-11-08 | **`[PGP.97]` «Salidas del banco»: lo que salió del banco a proveedores, contra Kepler y contra el programa — 🧪 en código, sin migración, sin validación visual. Y `[PGP.97.1]`: el periodo del workbook ya no se pierde por un nombre sin año.** Pedido de Francisco (2026-11-07): *«utiliza el workbook de bancos para identificar lo que se pagó fuera de programa y está pendiente de elaborar el pago en Kepler, para que sirva de guía al área de pagos a proveedor; la meta es que el 100 % pase por el programa»*. Pestaña nueva en «Pagos» (`/finanzas/salidas-banco`, permiso `FINANCE_PAYMENTS_VER`, ya repartido), `GET /finance/payment-calendar/fuera-de-programa`, regla pura en `libs/contracts/src/finance/salida-proveedor.contract.ts`, lectura en `fuera-de-programa.sql.ts` — **cero tablas, cero importers**: el workbook (`bank_movements`), la vista de tesorería de la conciliación (`kepler_bank_movements`), `kdxf`, el Calendario y la deuda viva. **Medido (prod, sólo lectura, con placebo):** la salida a proveedor se reconoce por la columna M del libro (98.0 % de precisión, 97.6 % de cobertura); el par salida↔pago de Kepler (misma cuenta, ±$1, ±5 días) casa 239 de 244 en octubre y **0 de 244** con las fechas corridas −35/−60/+35; una transferencia que Kepler capturó en varios documentos (uno por sucursal, o transferencia + anticipo) se parea junta: 3 en septiembre, 0 en el placebo. **Cifras de hoy:** octubre, banco: 4 salidas sin pago en Kepler a más de 7 días (una de ellas con partida viva del mismo acreedor e importe: es lo que O3 va a escribir), 1 capturada con otro importe, 225 pagadas fuera del programa. La meta, por dinero y desde Kepler: **8.9 %** en octubre, 33.1 % en la vida del Calendario, **98.1 %** del 1 al 7-nov por banco; **Caja General 0 %** en todas las ventanas. ⛔ **Noviembre no está en el workbook**: el 5-nov se subió «11 NOVIEMBRE.xlsx» (896 movimientos), cayó al periodo de octubre porque el nombre no traía año y la siguiente subida de octubre lo barrió — `[PGP.97.1]` deriva el periodo del mes aunque falte el año; Tesorería tiene que volver a subir noviembre. **Revisión adversarial** (5 dimensiones, cada hallazgo con un escéptico): 21 confirmados y corregidos antes del PR — entre ellos, que una partida cancelada DESPUÉS de pagar (la limpieza de lo saldado) se leía como «se quitó del programa» (la meta del 1–7 nov pasaba de 98.1 % a 94.7 %), que un día sin movimientos en el banco se declaraba «captura doble», y que el veredicto decía «todo tiene su pago» con renglones en espera. **Pruebas:** 47 unitarias con 13 mutantes en rojo; integración contra Postgres real (local, en transacción revertida: verde; el pago cancelado no cuenta como pagado); `check:pantalla` 10 de 10. **NO MEDIDO:** la pantalla viva; el arranque de Nest (no se tocó ningún constructor ni firma inyectada: el método va en `PaymentCalendarService`). **Deuda con nombre:** dos copias de las palabras vacías del comparador de nombres (`finance-bank.service.ts` y el contrato); `removeItem` borra el renglón y una factura quitada de un pago no deja rastro; el Calendario no abre un día desde la URL. | Claude |
| 2026-11-09 | **`[PGP.100]` Qué le falta a un pago para cerrarse, dicho por separado, y `[PGP.101]` varios descuentos al pagar sobre la misma factura — 🔨 en código, sin empujar, sin validación visual; `[PGP.101]` lleva migración.** Pedidos de Edgar (2026-11-09): *«que se pueda agregar más de un descuento»* y *«especificar si falta comprobante o si falta aplicar en Kepler»*. **`[PGP.100]`** regla pura `faltaParaCerrar` en `cierre-kepler.contract.ts`: `kepler` (Kepler no registra el pago o lo registra en parte), `comprobante` (pagado con dinero desde Matriz y sin PDF subido), `sin_medir` (no viene de Kepler: se declara). ⚠️ Un pago de sucursal sin PDF NO cuenta como «falta comprobante»: hoy no se le puede subir (`sinComprobantePorque`, la misma regla que ya decía el desglose, ahora en un solo lugar). En pantalla: el renglón pagado en Kepler dice «Falta el comprobante» / «Falta aplicar en Kepler el resto y el comprobante»; el marcado pagado deja de decir sólo «Marcado pagado». **`[PGP.101]`** columna `discount_lines jsonb` en `finance.payment_allocation_items` (migración `20261109163309_pgp101_varios_descuentos_por_factura.js`, aditiva, NULLABLE, ⛔ va en prod ANTES del código). Las columnas de `[PGP.91]` quedan como AGREGADO (suma, motivo del mayor, tasa y nota sólo con uno): lo cubierto, el neto, el tope del día y el cruce con Kepler no cambian. `POST …/descuento` acepta `discounts: [...]` (la lista completa; `[]` lo quita) y sigue aceptando el cuerpo de un descuento. Cada % va sobre lo cubierto; uno en cascada se captura en pesos (decisión de diseño, revisable). Máximo 5 por factura. El PDF del día, la ficha de la factura y «pronto pago capturado» leen los renglones. **Verificación:** 7 pruebas de contrato + 11 del validador del servidor + 3 de la pantalla (con casos negativos: suma = factura, tasa que no cuadra, «Otro» sin detalle, renglón en cero); `check:pantalla` 0 nuevas y tipa; `check:templates` verde; `tsc` de `finance`/`commercial` sin errores nuevos en lo tocado. **NO MEDIDO:** los 2 casos de integración nuevos (`payment-calendar.it.spec.ts`, cuerpo exacto del diálogo con dos renglones, y quitar con `[]`) corren sólo con `TP_IT_DB` local o en el CI; la pantalla viva. | Claude |

---

## Observaciones de diseño UI — revisión del plan (2026-10-26)

> **Con qué se miró: el plan, no la pantalla** (nivel C). Nada visual se da por medido; lo que
> sólo se comprueba con la pantalla viva va como criterio a verificar. La ley es
> [`ESTANDAR_DE_INTERFACES.md`](../../ESTANDAR_DE_INTERFACES.md) (§ = sus secciones) y su
> implementación [`DESIGN.md`](../../../DESIGN.md). Severidad: 🔴 la pantalla afirmaría algo falso,
> escondería lo que importa o perdería trabajo — **bloquea pasar C3 a 🚀** · 🟠 se resuelve dentro
> de la fase · 🟡 mejora; si no entra, queda como deuda con nombre.
> Parte de la interfaz ya existe (`[PGP.1]` en `/compras/cuentas-pago`, las bandejas de `[PGP.3]`,
> `[PGP.5]`–`[PGP.7]` en el Calendario): en esas piezas cada observación es un criterio a verificar
> en ella, no un defecto medido.

**La pregunta que contesta (prueba de la frase, §4.0b):**

- *Cuentas de pago (`/compras/cuentas-pago`):* *«¿A qué proveedores les falta cuenta de pago,
  empezando por los que más dinero mueven?»* — una sola. Bien partida.
- *Bandejas de «Mi trabajo» (`[PGP.3]`):* *«¿Qué pago está detenido en mi paso?»* — una sola, por rol.
- *Estación «Pagos a proveedor» (`PGP.3.1`, D3):* el plan la define con *«¿qué pago hoy y con qué
  dinero?»*, que es una pregunta. Pero `PGP.3.2` le mete además «Cuadre y deuda», «Estado de cuenta
  acreedores», «Cuentas por pagar» y «Cuentas de pago», que contestan *«¿cuánto le debo a cada
  acreedor?»* y *«¿a quién le falta cuenta?»*. Son tres preguntas → conflación (§4.0 A). Ver PGP.UI.5.

**Jerarquía propuesta (§3.7 · DESIGN §Q.5):**

- *Estación:* primario = **lo que sale hoy contra la capacidad del día, y cuántos pagos están
  detenidos y en qué paso** · secundario = la lista del día con el paso de cada pago y quién lo tiene
  · terciario = CLABE, folio de Kepler, referencia bancaria.
- *Cuentas de pago:* primario = **cobertura: % del dinero pagado por banco que ya tiene cuenta** ·
  secundario = la lista ordenada por dinero, con el renglón del 80 % marcado · terciario = fecha y
  monto del último pago.

| # | Sev | Observación (desde la silla de quien la usa) y costo | Ley | Criterio de aceptación |
|---|---|---|---|---|
| PGP.UI.1 | 🔴 | **«Escribir en Kepler» (`PGP.2.3`) con doble clic o reintento escribe dos `X-D-26`.** El folio se deriva `MAX+1`: un segundo intento después de que el primero escribió calcula otro folio, no choca con la llave y nace un segundo documento — **la deuda del proveedor baja dos veces**. Y no se deshace desde la Suite: `kepler_push` no tiene `DELETE` (medido en C0). Es la única acción del ciclo que escribe en un tercero y no tiene vuelta. | capa 5 · DESIGN §10 idempotencia visual · DESIGN §X.1 (plan antes de ejecutar) · §4.4 | El botón se deshabilita en el primer clic, de forma síncrona, y el servidor rechaza un segundo documento para la misma asignación (prueba con dos llamadas seguidas). Antes de escribir, el plan en llano: «Se va a escribir en Kepler un pago X-D-26 por $X a ‹proveedor› desde ‹cuenta›, que salda estas N facturas: … No se puede deshacer desde la Suite.» Ya escrito, el botón desaparece y queda «Escrito en Kepler: X-D-26 ‹folio›». Con el interruptor de E3.5 apagado (hoy la escritura de KR está apagada en las nueve sucursales), el botón no se ofrece y la fila dice «Escritura a Kepler apagada», nunca un error al hacer clic. |
| PGP.UI.2 | 🔴 | **Un pago escrito a medias se vería igual que uno escrito.** El pago toca tres tablas (`kdm1` + `kdxe` + `kdxf`) y hoy hay privilegio sobre una; el plan dice que escribir sólo `kdm1` «es peor que no escribirlo»: el documento existe y la deuda no baja. Si la fila pinta «Ligado» por haber mandado la orden, Tesorería da por saldadas facturas que en Kepler siguen vivas, y se vuelven a ofrecer para pago. En un lote, un fallo en 1 de N reportado como «falló el lote» hace reintentar los que sí se escribieron (y PGP.UI.1 los duplica). | §1.1 · §1.3 · §3.3 · DESIGN §10 fallos parciales | Por pago, tres estados con texto: «Escrito completo» (documento + deuda bajada en N facturas, leído de vuelta del ODS por el conciliador E3.4), «Escrito a medias: el documento existe pero la deuda no bajó» (`p-tag` de error, navegable a su renglón de E3.4) y «Sin escribir». En lote: «48 escritos · 2 fallaron», con los fallidos seleccionados para reintentar y los escritos fuera del reintento. |
| PGP.UI.3 | 🔴 | **«Ejecutado» afirma que el dinero salió, y sólo dice que Caja General lo marcó.** El propio `[PGP.4]` se verifica contra el estado de cuenta **del día siguiente** y prevé el pago que «falla en el banco». Si O3 escribe el `X-D-26` al pasar a `executed` (`PGP.2.4`), un rebote deja en Kepler un pago que no ocurrió, con la deuda bajada y sin `DELETE` para corregirlo. | §1.1 · §1.3 · DESIGN §X.5 | Dos estados con nombre distinto: «Enviado al banco (Caja General, hh:mm)» y «Confirmado en el estado de cuenta del dd-mmm». ⚠️ **Conflicto para Edgar:** la compuerta de `PGP.2.4` exige la confirmación del banco antes de escribir a Kepler (un día más lento) o acepta `executed` (inmediato, con el riesgo descrito). La pantalla dice cuál regla rige. |
| PGP.UI.4 | 🔴 | **E2.1 ofrece la deuda preexistente «por antigüedad y monto», y lo más viejo es justo lo que puede estar pagado.** ECA midió **$59.9M de facturas de sucursal anteriores al 1-oct, muchas pagadas desde Oficinas sin aplicarse en la sucursal** (ECA §1, ECA.6, ECA.UI.2); caen dentro de los $90.1M sin camino y de los 539 documentos con más de 90 días ($10.3M). Ordenar por antigüedad las pone arriba: Tesorería las programa y **se pagan dos veces**. La misma cifra infla el encabezado «$57,972,816 ya vencida (62.5 %)». | §1.6 · §3.2 · capa 5 (cobrar dos veces) · cruce con ECA y PO | Cada documento de esa clase lleva el `p-tag` «Por confirmar: puede estar pagada desde Oficinas» y nace **desmarcado**; programarlo pide motivo. El encabezado separa «vencido seguro» de «por confirmar», con la misma regla que ECA (una sola, en `libs/`), y lo dice en llano. |
| PGP.UI.5 | 🟠 | **La estación de D3 contesta tres preguntas a tres personas distintas.** Tesorería prepara, Dirección firma y Caja General ejecuta; sumarle el estado de cuenta de 373 proveedores y la lista de cuentas faltantes obliga a quien viene a firmar 6 lotes a encontrar su botón entre lo de los otros dos. La meta «de 8 pantallas a 1» premia la conflación. | §4.0 A · §4.0b · §3.1 | La estación abre en la pregunta del rol que entra («Lo que te toca hoy»), con `app-page-tabs` por paso y permiso por pestaña. El estado de cuenta del acreedor se abre en `app-side-peek` desde la fila del pago, sin salir de la lista. La métrica de O4 pasa a «una pregunta por pantalla, sin cambiar de módulo para resolverla». ⚠️ Toca una decisión firmada (D3): decide Edgar. |
| PGP.UI.6 | 🟠 | **El tope de D2 parte un lote entre dos firmantes y la pantalla no tiene cómo decirlo.** Con $100,000, Tesorería firma 3 de cada 4 pagos (3,632; 75.3 %) y Dirección el 85.1 % del dinero. Un día mezcla las dos clases: si el lote se ve «autorizado» cuando sólo firmó Tesorería, Caja General ejecuta lo que Dirección no vio. | §1.1 · §3.3 · §2.3 | Cada pago dice quién lo firma («Firma Tesorería» / «Firma Dirección») con texto, no sólo color; el lote tiene estado parcial: «12 de 15 firmados · faltan 3 de Dirección por $X». La regla se escribe una vez en pantalla: «Hasta $100,000.00 firma Tesorería; arriba, Dirección». Prueba en $100,000.00 exactos. |
| PGP.UI.7 | 🟠 | **Aprobar una CLABE (`[PGP.2]`) sin nada con qué contrastarla es firmar a ciegas.** Las 37 cuentas mueven el 80 % de $129.3M (jul–oct); un dígito cambiado manda el pago a otra persona, y el cambio de cuenta es la vía clásica de fraude. El plan valida la forma (18 dígitos, dígito de control) pero no dice qué ve quien aprueba. | §4.5 · DESIGN Miller · Postel · §3.2 | Quien aprueba ve: el banco que se deduce de los 3 primeros dígitos de la CLABE (derivado, no adivinado), el último pago real al proveedor (fecha y monto al centavo) y quién la solicitó. La CLABE se muestra segmentada sólo por CSS; el valor copiable va intacto. Pegar con espacios o guiones desde la banca en línea se acepta (se normaliza antes de validar). Quien solicitó no ve «Aprobar» en su propia solicitud, y el porqué se escribe. |
| PGP.UI.8 | 🟠 | **La lista de `[PGP.1]` cruza el 1-oct y no declara su universo.** Se calcula sobre `analytics.erp_supplier_payments`, jul–oct. La Fase PO encontró esa vista anclada a Oficinas (catálogo **local**, 2026-10-02, sin re-verificar en prod), y desde el 1-oct Oficinas dejó de concentrar. Si sigue así, los pagos de octubre de otros centros de costo no cuentan y «37 proveedores cubren el 80 %» salió de un universo incompleto. | §1.6 · §1.5 · cruce con PO | Bajo la cobertura, el universo en una línea: «Pagos por banco del dd-mmm al dd-mmm, todas las sucursales». Hasta que `PO.0`/`PO.2` lo midan en prod: «Desde el 1-oct pueden faltar pagos de centros de costo distintos de Oficinas (Fase PO, sin medir)». |
| PGP.UI.9 | 🟠 | **El plan se contradice sobre qué nombre lleva cada renglón.** §O1 descarta el beneficiario del estado de cuenta (casa 36.1 %, sin control placebo) y lo cambia por el último pago real; el item `[PGP.1]` de §8 todavía pide «su nombre de beneficiario tal como aparece en el estado de cuenta». Un nombre del banco junto al proveedor de Kepler se lee como «son el mismo», y con él Tesorería busca la CLABE en la banca en línea. | §1.1 · §1.6 | La fila muestra «Último pago: dd-mmm · $X» como llave para ubicar al beneficiario. Si además se muestra un nombre del banco, va rotulado «nombre en el estado de cuenta, sin verificar contra el proveedor». Se corrige el criterio de `[PGP.1]` en §8. |
| PGP.UI.10 | 🟠 | **Las bandejas de «Mi trabajo» están 🧪 y su migración no está en prod: para Dirección el aviso no existe.** Es el defecto que el plan diagnostica (6 lotes en `draft` desde el 16-oct sin que nadie se enterara). Y aplicada, la bandeja de Dirección mostraría hoy 6 días «por autorizar» que el servidor rechazaría: 0 de 10 pagos preparados. | §2.4 · §1.1 | Ningún estado arriba de 🧪 sin la migración aplicada y la responsabilidad `finanzas.pagos` repartida en prod (regla 20). La bandeja de Dirección cuenta sólo lotes con todos sus pagos preparados; los demás van a la de Tesorería con «faltan N por preparar». |
| PGP.UI.11 | 🟠 | **«Se acaba la doble captura» vale para la transferencia, no para todo.** O3 arranca sólo por banco; en octubre, 49 pagos de caja ($1.93M) y 4 por puente ($0.63M) siguen capturándose a mano en Kepler. Si la estación no lo distingue, Mayra deja de capturarlos creyendo que la Suite los escribe. | §1.4 · §1.1 | Columna «Kepler» por pago: «Lo escribe la Suite» / «Captura manual en Kepler (efectivo)». El encabezado dice cuántos quedan de captura manual y por cuánto. |
| PGP.UI.12 | 🟠 | **Filtrar la deuda viva por sucursal tarda 43.6–47.7 s (causa NO DETERMINADA); sin filtro, 450–550 ms.** Un filtro que tarda medio minuto se lee como «se colgó» y se vuelve a pedir: dos consultas de 45 s apiladas. | DESIGN Doherty · §3.5 · regla de sucursal por nombre | Hasta encontrar la causa, el filtro por sucursal se aplica sobre lo ya bajado o no se ofrece. La sucursal se nombra con la pipe `\| sucursal`, en la opción y en la celda («Oficinas», nunca «00»). |
| PGP.UI.13 | 🟡 | **`[PGP.7]` sacó del menú a Pronto pago con 98 hallazgos sin triar.** La mitad prospectiva pasó al Calendario; la retrospectiva quedó sólo por URL. Para quien tenía que triarlos, desaparecieron. Y la tabla de §4 C3 sigue contando 8 pantallas. | §2.4 · §2.1 | Los 98 se triaron o descartaron con su porqué antes de retirar la entrada, o el Calendario los muestra en una sección con su conteo («98 hallazgos de pronto pago sin revisar»). La tabla de §4 C3 se actualiza a lo que queda en el menú. |

**Lo que esta revisión no cubre:** la pantalla viva de `/compras/cuentas-pago` y del Calendario
(contraste, foco, teclado y pliegue exigen nivel A con `auditoria-diseno`), el texto exacto del plan
en llano de PGP.UI.1 (se valida con Tesorería y Contabilidad) y el conciliador E3.4, que el plan
todavía no describe como pantalla.

### Revisión de la maqueta PGP.11 y rediseño v2 (2026-10-26)

> **Con qué se miró:** la maqueta estática [`docs/maquetas/PGP11-pagos-rediseno.html`](../../maquetas/PGP11-pagos-rediseno.html)
> abierta en el navegador (contraste y anchos medidos, con control de 21:1) y cruzada contra D2,
> el código de `[TP.16]` y las observaciones de arriba. No es la app. La propuesta está en
> [`PGP11-pagos-rediseno-v2.html`](../../maquetas/PGP11-pagos-rediseno-v2.html); su desglose dice
> qué cambió y por qué.
> ⚠️ La implementación de PGP.11 en `finanzas-calendario-pagos.component.ts` sigue la v1: las 🔴
> de abajo aplican a ese código.

| # | Sev | En la v1 | Ley | En la v2 |
|---|---|---|---|---|
| PGP11.M1 | 🔴 | «Arriba de $100,000 pide **dos firmas** de personas distintas», calculado sobre **la suma del día**, firmantes «Gerencia de Finanzas» y «Dirección General». No lo dice ni el código (`[TP.16]`: autoriza el día Gerencia o Dirección) ni D2 (por pago: hasta $100,000 Tesorería, arriba Dirección). | §1.1 · PGP.UI.6 | Firma por pago según D2, el paso partido por firmante con su monto, «0 de 2 firmados». |
| PGP11.M2 | 🔴 | La CLABE se teclea en la fila del pago y con eso el pago queda listo («Capturar otra…»): una cuenta destino que nadie aprobó. | PGP.UI.7 · §4.5 | Se captura y se valida igual de rápido (dígito de control, banco), pero va a aprobación de otra persona y el pago espera. |
| PGP11.M3 | 🔴 | Las dos notas de cargo **en dictamen ($14.0M)** encabezan la deuda en rojo con «Agregar al lunes» a un clic. | §1.3 · capa 5 | Grupo «no programables hasta que se resuelvan», sin botón. |
| PGP11.M4 | 🔴 | «CEDIS» para la sucursal 00, sabiendo que es Oficinas (la propia v1 lo declara). | §1.1 · sucursal por nombre | «Oficinas». |
| PGP11.M5 | 🔴 | El paso 4 dice «Autorizado $495,977.49» con el día sin autorizar. | §1.1 · PGP.UI.3 | «Autorizado $0.00 · 0 de 2», y «enviado al banco» separado de «confirmado en el estado de cuenta». |
| PGP11.M6 | 🟠 | La cifra de cada día en la cola es lo comprometido si hay pagos y lo libre si no: el lunes ($496.0K) se lee más apretado que el miércoles ($1.87M), y tiene más espacio. | §1.1 | Siempre lo libre del tope, con leyenda. |
| PGP11.M7 | 🟠 | Nada sobre las facturas de sucursal anteriores al 1-oct ($59.9M por confirmar, ECA). | PGP.UI.4 | La propuesta no las toma; el cajón las nombra como grupo. |
| PGP11.M8 | 🟠 | Contraste medido: encabezados y rol 2.52:1 (claro) / 3.65:1 (oscuro); botón principal 3.56:1 / 2.26:1. Viene de los tokens del sistema (`--text-faint`, `--action` con texto blanco). | DESIGN §Ing.UI 3 · `[AUD.4]` | Todo ≥ 5.18:1 en los dos temas. Arreglarlo en `tokens.css` lo decide Edgar. |
| PGP11.M9 | 🟠 | «Mi trabajo 4» contra «3 pagos sin preparar»; el veredicto es el mismo para los tres roles. | §1.5 · PGP.UI.5 | Conteo y veredicto de quien mira (Tesorería 3, Dirección 0, Caja 0). |
| PGP11.M10 | 🟠 | A 390 px el veredicto empieza en 724 px; la tabla se recorta; 19 de 19 controles < 44 px. | Fitts · Doherty | La cola es una tira de un renglón (veredicto a 475 px), el pago es un bloque rotulado y los controles miden 44 px con el dedo. |
| PGP11.M11 | 🟡 | Orden sólo arrastrando; «?» en un `title`; «Lunes 26 De Octubre». | §2.2 · §3.8 | Subir/bajar y `Alt`+flechas escrito en pantalla, quitar con deshacer, ayuda en pantalla. |

**Decisiones abiertas que la v2 deja escritas:** D2 hace que Tesorería prepare **y** firme el 75.3 %
de los pagos (separación de funciones) · «tope del día» como nombre único · contraste en los tokens
del sistema · cuándo se escribe el `X-D-26` · `warehouseName('00')`.

**Lo que firmó Edgar el 2026-10-26:** (1) **se separan funciones**: quien prepara un pago no lo firma ·
(2) el nombre es **«tope del día»** · (3) el contraste **se corrige en los tokens** (`[AUD.4]`) ·
(4) «**ya tenemos acceso al `X-D-26`**» — queda abierto **cuándo** se escribe (al enviar o al confirmar
en el estado de cuenta) · (5) «**00 es CEDIS/Oficinas**»: corrige lo que la v2 y PGP11.M4 afirmaban
(«es Oficinas, no CEDIS»).

### Diagnóstico general de `/finanzas/calendario-pagos` (2026-10-26, nivel A) — estructura, color, jerarquía

> Pedido de Edgar: *«revisa el diseño en general, estructura, colores, jerarquía de información; no
> puedes basar tu diseño en pequeñas cosas»*. Esto va **antes** que la lista CAL.A de abajo: casi
> todo lo de esa lista es síntoma de lo que se dice aquí. Medido en la app (1440×1600 y 1366×768),
> escala tipográfica leída de los estilos computados con el H1 como control (30 px · 700).

**1 · La jerarquía está invertida.** Lo que contesta la pantalla es lo más chico; lo que la rodea, lo
más grande.

| Elemento | Tamaño · peso medidos | Lo que debería ser |
|---|---|---|
| H1 «Pagos» (no dice nada que el menú no diga) | 30 px · 700 | 20 px |
| Encabezados de la tabla («Orden», «Beneficiario e importe») | **16 px · 600** | 11 px versales, apagados |
| Cada renglón de la deuda en el paso 1 | **16 px · 600/700** | 14 px |
| **El veredicto** («Faltan 5 de 5 pagos por preparar») | **14 px · 700** | **20 px · 600, lo primero que se lee** |
| Su detalle (a quién y qué le falta) | 12 px · 400 | 14 px |
| **Comprometido / libres del tope** (la segunda pregunta: ¿cabe?) | **12 px · 700** | 18 px mono |

El ojo recorre: «Pagos» → encabezados de columna → importes → y al final el veredicto. Cuando todo
lo que importa es secundario, nada es primario (estándar §3.7 · DESIGN §Q.1 / §Q.5).

**2 · La estructura gasta el primer 38 % de la pantalla en marco.** Barra global, migas, una barra de
pestañas a todo el ancho **encima** del título (el orden convencional es título → pestañas), el título
con dos renglones de instrucciones, y un navegador de semana que **repite** el de la cola. El trabajo
empieza en y=295 de 768: de 5 pagos se ven 2. Una sola banda de encabezado (título + pestañas + nada
más) devuelve ~200 px al trabajo (§3.1 · §4.6).

**3 · El color dejó de significar.** Con el paso 1 abierto hay **47 textos en naranja de acción y 34 en
rojo**. El naranja hace de botón principal, de vínculos secundarios («Esta semana», «Proponer orden»,
«Preliminar»), de día elegido, de borde del paso, de número de paso, de flechas de orden, de rótulo
(«Para los 5 pagos»), de borde punteado y de barra de avance. El ámbar de «falta» es vecino del
naranja y se confunde con él; el rojo marca a la vez «quitar» y «vencido» en cada renglón; y todas
las filas llevan fondo durazno. Resultado: la única acción que importa («Preparar los 5») no
destaca, porque todo destaca (Von Restorff · DESIGN «marca sólo en CTA / activo / seleccionado /
foco»). Presupuesto de color propuesto: naranja = **un** botón principal + el día elegido + foco;
ámbar = lo que falta, **en el campo que falta**; rojo = sólo error o vencido; lo demás, neutro.

**4 · Se agrupa con cajas, no con espacio.** El lote tiene **11 cajas con borde y radio**: tarjeta del
paso › caja punteada de «Para los 5 pagos» › tabla con filas teñidas › chips de sucursal con borde.
Tres niveles de contenedor para una sola tabla. Gestalt: el grupo se forma con espaciado; el borde es
el último recurso (DESIGN §Ing.UI 1).

**5 · La fila no dice qué le falta.** La celda de nombre (395 px) carga nombre + importe + sucursal en
chip mono + 1 a 4 folios (por eso filas de 55 y 71 px); «Método» es un selector gris igual a uno
lleno; «Sale de» dice «elegi el metodo» y «Llega a» un guion. Lo que falta no se ve en la fila: se lee
arriba en una frase. Debería verse al revés: la fila marca su hueco y la frase lo resume (§3.3).

**6 · El acordeón exclusivo parte el trabajo en dos.** Abrir «Armar el día» cierra «Ordenar y
preparar». Tesorería agrega facturas y las prepara en la misma sentada, así que tiene que recordar lo
de un panel mientras ve el otro (Tesler: la complejidad se pasó a la persona). Y los pasos 3 y 4 —el
trabajo de Dirección y de Caja— son dos renglones al fondo, iguales para todos los roles.

**Dirección del rediseño (lo que sí se hace):**
1. **Una banda de encabezado** (título 20 px + pestañas a la derecha); instrucciones al «?»; la
   semana se navega sólo desde la cola.
2. **El veredicto manda:** frase a 20 px, su detalle a 14 px, **un** botón; debajo, *comprometido ·
   libre · tope* como tira de métricas mono a 18 px (`app-metric-strip`).
3. **La tabla de preparar es el organismo principal:** encabezados quietos, filas de 44 px, el importe
   en su columna numérica, la sucursal como texto, los folios plegados («4 facturas», detalle en
   `app-side-peek`), y **el campo que falta marcado en la fila** (contorno ámbar + «falta»); las filas
   completas, neutras con su check.
4. **Agregar facturas no cierra la tabla:** la deuda se abre como panel lateral sobre el lote, no
   como paso que reemplaza al otro.
5. **El rol decide qué se abre:** Tesorería entra al paso 2; Dirección, a firmar; Caja General, a
   dispersar. Los otros pasos quedan como renglón de estado.
6. **Presupuesto de color** del punto 3, y en el teléfono una columna (CAL.A1).

**`[PGP.14]` Aplicado el 2026-10-26 (🧪, validado en la app con datos reales; escrituras bloqueadas
en el navegador porque la API local apuntaba a prod).** Medido a 1366×768 antes → después:

| | Antes | Después |
|---|---|---|
| Veredicto | 14 px, en y=295 | **20 px, en y=251** |
| Encabezados de columna | 16 px · 600 | **11 px versales** |
| Pagos visibles antes del pliegue | 2 de 5 | **3 de 6** |
| Teléfono (390 px) | lote cortado, tabla 827 px en 251 | **una columna, tabla 307 = 307, pago en bloque** |
| `check:pantalla` | 2 fallas (Q.1, §9) | **1 (§9)**, 0 nuevas |

Qué se cambió: encabezado de una banda; veredicto y `app-metric-strip` (comprometido · libre · tope
del día); tabla con columna de importe, sucursal y folios en una línea, «falta» en el campo, sin tinte
de fila, quitar y ordenar en neutro; pasos 1 y 2 abiertos a la vez; texto de estado en `--*-soft-fg`;
«tope del día» (D5); acentos, plurales y tuteo; el pie de la cola no dibuja $0.00 sin semana.
**Dos causas raíz que no eran de diseño:** (1) `styleClass` en `p-table` **se descarta en PrimeNG
v22** —esta tabla nunca tuvo `surf-table` ni su `table-layout:fixed`— y hay **110 tablas más** con el
mismo patrón; (2) las reglas `@container` de la pantalla no aplicaban nunca (ningún ancestro declara
`container-type`). Y una tercera, **global**: `styles.css` esconde con `!important` las columnas 4+ de
**todo** `p-datatable` a ≤30 rem; aquí se anuló sólo para esta tabla.
**Pendiente:** la vista por rol (no hay permiso de «preparar» ni de «dispersar», sólo `AUTORIZAR`), el
cajón de la deuda como panel lateral, los $14.0M en dictamen todavía programables (necesita la marca
en el dato), y la edad del dato (§9).

### Recorrido de punta a punta — de entrar al módulo a cerrar el día (2026-10-26, nivel A)

> Pedido de Edgar: *«revisa el diseño desde que entro al módulo hasta que termino el proceso»*. Se
> recorrió en la app con datos reales y **escrituras bloqueadas en el navegador** (la API local apunta
> a prod). Los estados que hoy no existen en el dato —un pago a medio preparar, un día autorizado con
> un pago marcado y otro rebotado— se **simularon** transformando en el navegador la respuesta real de
> la semana; nada se escribió. Abajo, cada etapa con lo que se encontró y lo que se hizo.

| Etapa | Lo que estaba mal (medido) | Qué se hizo |
|---|---|---|
| Entrar | Finanzas abre en «Egresos contables»; la barra lateral sólo tiene íconos: Pagos es un avión de papel entre 16. | **No se tocó** (navegación global, fase SN). |
| Veredicto | 🔴 El botón principal («Preparar los 7») **no hacía nada visible**: desplazaba a `#payPanel`, que la plantilla ya no tenía (también rompía `openDay()` en angosto). | `#payPanel` restaurado; el botón dice lo que hace: «Elegir el método de los N» lleva el foco a «Para los N pagos»; si falta otra cosa, abre ese pago. |
| Armar | Deuda: lo no programable abría la lista; importes sin columna (el borde se movía fila a fila); fechas sueltas en rojo; tres barras de desplazamiento anidadas; «Sugerir armado» perdido. «Armar» cerraba «Preparar». | Tabla con columnas (proveedor · vencimiento · importe a la derecha · agregar), «vencida hace N meses», lo no programable **al final, plegado, con su cuenta y su total** (eran **46** facturas y se veían 3), «Sugerir armado» arriba a la derecha, pasos 1 y 2 abiertos a la vez. |
| Preparar | 🔴 Con datos, la tabla **se rompía**: tres controles por fila encimados; la cuenta destino como botón naranja aunque ya estuviera capturada; fila lista igual que incompleta. 🔴 Si el guardado fallaba, el selector **se quedaba mostrando el valor no guardado**. | Una fila = un pago con **«Cómo sale»** en una línea y su estado («Listo» / «Falta la cuenta destino» / «Falta el método»), con la misma regla que `isPrepared()`; «Preparar»/«Cambiar» abre el diálogo (que ya valida la CLABE y lee el catálogo); método y origen de todos, arriba. |
| Autorizar | Dice «Autorizar el día · Gerencia / Dirección»: es el código de hoy (TP.16), no D2. | Sin cambio de regla (D2 + separación de funciones son backend: `PGP.1.1`). |
| Dispersar | 🔴 El veredicto **ignoraba un pago rebotado**; la fila decía «Falló» **sin el motivo**; «5 listos» con 7 pagos y «6 pagos» con el monto de 7; tres nombres para el mismo estado; sin folio; dos botones naranjas iguales. | El rebote **encabeza el veredicto** con su motivo y «Mover a otro día»; la cola dice «1 rebotó»; filas con folio, cómo sale, importe, estado y motivo; un solo nombre: **«Marcado pagado»**; conteos del mismo universo; la instrucción a Caja, secundaria. |
| Diálogos | Sin «Cancelar», «Guardar» a la izquierda. | «Cancelar» y acciones a la derecha en preparar, agregar y mover. |
| Cerrar / comprobante | El proceso **no tiene final**: no hay «cerrar el día» y el paso 4 no lleva a «Pagos a proveedor», donde se adjunta el comprobante. Esa pestaña usa otro lenguaje de encabezado y no cargó (API caída). | **Pendiente** (abajo). |

**Pendiente, con dueño de decisión:** (1) **cierre del día** y enlace de cada pago marcado a su
comprobante en «Pagos a proveedor» —es diseño del proceso, no de pantalla—; (2) la **vista por rol**
(sólo existe el permiso `AUTORIZAR`); (3) los **$14.0M en dictamen** siguen programables hasta que el
dato los marque; (4) D2 + separación de funciones en backend; (5) **dos defectos globales** que esta
pantalla destapó y que se anularon sólo aquí: `styleClass` en `p-table` ignorado en PrimeNG v22 (110
tablas) y `styles.css` escondiendo con `!important` las columnas 4+ de todo `p-datatable` en móvil.

### `[PGP.15]` Los cuatro principios del PM, aplicados (2026-10-26, nivel A) — 🧪

> Pedido de Edgar: *«debe existir la menor cantidad de interacción humana, la menor cantidad de
> colores en interfaz innecesarios, accesibilidad y visibilidad de información en todo momento,
> opción de desglose de información»*. Quedaron como ley en `ESTANDAR_DE_INTERFACES.md` §2.5, §3.10
> y §4.7 (con estos casos) y como paso 7 del recorrido de `auditoria-diseno`. Medido en la app
> (`localhost:4200`, datos reales del lun 26-oct) con **escrituras bloqueadas en el navegador**
> —control: el bloqueo atrapó el `POST` de login la primera vez que la excepción no lo cubría— y los
> estados que no existen hoy (preparado, autorizado, rebote, por cerrar, cerrado) **simulados**
> transformando la respuesta GET de la semana. Lista de escrituras que salieron del navegador: **vacía**.

| Principio | Antes (medido) | Después (medido) |
|---|---|---|
| **Interacción** — un día de 7 transferencias, de armar a cerrar | **30 clics**, y el proceso **no se podía terminar**: el backend tenía `fallo` y `cerrar` y la pantalla no los ofrecía | **6 clics** si cada proveedor tiene cuenta favorita (10 la primera vez; +2 por proveedor sin favorita). La propuesta aparece sola; el orden se pone solo; «Aplicar a los N» pone la cuenta favorita de cada proveedor; «Marcar los N pagados» de una vez; «Rebotó…» marca y mueve en un paso; «Cerrar el día» |
| **Color** | **44 elementos con color, 3 tonos, 16 papeles** | **3 elementos, 1 papel** (el botón principal). Rojo sólo en el rebote y el tope excedido. Las 30 casillas marcadas de la propuesta salían naranjas por default de PrimeNG: neutralizadas |
| **Visibilidad** | 3 de 4 pasos plegados al entrar (uno con 68,433 caracteres: toda la deuda); 2 pagos con folios tras «…»; la tira de cifras decía **$84,410.38** de un día con **$1,850,235.43** mientras contaba | Avance en una línea sin clic; **0 textos cortados**; la tira nace con su valor final (`instant`, aditivo en `MetricStrip`/`CountUp`); «46 por confirmar» dice ahora **«entre las 1,000 listadas»** (era una cifra del universo recortado sin aviso) |
| **Desglose** | Las facturas de un pago, en una línea cortada | Cada pago se abre a sus facturas con lo aplicado (control: 4 facturas = $327,006.41 = importe del pago); la propuesta muestra los 30 que caben y **los 459 que no caben en una línea con su total ($89,596,996.03) y desglosable** — antes eran 489 renglones (459 deshabilitados) y ~1.4 s de pantalla congelada |

**Defecto de dato corregido de paso:** la propuesta de armado **no excluía las facturas «por
confirmar»** (sucursal, anteriores al corte del 1-oct, posiblemente pagadas desde Oficinas) y, como
ordena por antigüedad, las ponía primero. Con una réplica de su regla en el navegador: **55 en 2 de
los 46 pagos** propuestos para el 26-oct (hoy suman $24, pero el filtro no existía). Ahora `proponer()`
filtra con el mismo `enRevision()` del cajón.

**Verificado:** `ngc --noEmit` 0 errores · `check:templates` · `check:estilos` · `check:pantalla`
(1 falla, la §9 ya declarada; **0 nuevas**) · voseo 0 en los archivos tocados · `vitest` de
`metric-strip` y `calendario-pagos-grupos` 39/39 · los cinco estados del día en la pantalla viva ·
diálogos «Marcar como pagados» (control: 4 pagos = $1,009,657.16) y «El pago rebotó» (fecha
propuesta: siguiente día hábil; botón deshabilitado sin motivo) · teléfono sin desborde horizontal.

⛔ **NO ejercido contra una base real (regla 13) — por eso 🧪 y no 🚀:** todo lo que escribe y es
nuevo en esta pantalla usa endpoints que ya existían, pero **con un orden o un cuerpo que la pantalla
no mandaba antes**: el orden automático (`proponer-orden` / `orden` = máx+1 tras agregar o mover),
«Aplicar a los N» con `supplier_payment_account_id` de la favorita, «Marcar los N pagados» (N
`ejecutar` seguidos), «Rebotó…» (`fallo` y luego `reprogramar`), «Cerrar el día» (`cerrar`) y el
«+» que agrega directo. Ninguna se probó; la API local apunta a producción. Lo más probable de
ajustar: que `reprogramar` rechace un día destino ya autorizado (el diálogo lo dice como error, no lo
previene) y que `cerrar` —que el backend no valida— se ofrezca sólo cuando no quedan pendientes (lo
cuida la pantalla, no el servidor).

**Corrección tras la revisión de Edgar (mismo día):** el diálogo «Otro importe u otro día» se
rompía y sólo dejaba elegir la semana cargada. Causas medidas: (1) el día era un desplegable con los
7 días de `week()`; (2) los `p-select` se abren dentro de su contenedor por default y el diálogo —y
las secciones del día, con `overflow:hidden`— los recortaban (barra de desplazamiento interna, el
panel tapaba el importe); (3) `styleClass` **tampoco existe en `p-select` v22** (no está entre sus
inputs): los selectores de los diálogos medían ~130 px en vez del ancho del diálogo. Ahora: fecha
libre desde hoy, con **lo que cabe ese día leído de `days/:date/summary`** (sólo lectura) y el exceso
dicho antes de agregar (control: $6,160,497.16 libres el mar 3-nov + $1,839,502.84 de exceso =
$8,000,000.00, la factura); día autorizado o importe mayor a lo que se debe → «Agregar» deshabilitado;
`assign()` lee los pagos de un día fuera de la semana para sumar al pago del mismo proveedor y
sucursal en vez de duplicarlo; los 10 `p-select` con `appendTo="body"` (medido: el panel queda fuera
del diálogo) y `[fluid]`/`size` en lugar de `styleClass` (474 de 510 px). ⚠️ **No ejercido contra base
real:** agregar a un día de otra semana (dos GET más y el mismo `POST` de siempre).

**Corte al abrir «Agregar facturas» (reporte de Edgar, mismo día) — medido y corregido.** Abrir el
cajón **congelaba la pantalla 15.9 s** (tarea larga de 14,827 ms; 18.6 s la segunda vez): pintaba
954 renglones de golpe, con 13,300 nodos y **1,908 `pButton` con su `pTooltip`**, y cada renglón
formateaba fecha e importe creando un formateador nuevo (`toLocaleString`) en cada ciclo. Ahora:
botones nativos (`title` + `aria-label`); formateadores creados una vez (`PESOS`, fechas con
memoria); los textos de cada renglón en un modelo de vista (`filasDeuda`) que sólo se recalcula si
cambia la lista o el día; y se pintan primero 50 renglones y el resto en tandas de 50 por cuadro
—el cajón dice «Mostrando N de M…» mientras tanto y al final están **los 954**. Medido con la
pestaña al frente (control: 146 cuadros/s en reposo, antes y después): **renglones visibles a
19–40 ms del clic, los 954 a 329–434 ms, el cuadro más largo de 20–40 ms y ninguno arriba de
100 ms**; con el cajón abierto, cada clic en la tabla responde en 16–26 ms. ⚠️ **Descartadas por
falla del instrumento:** una medición de 9.5–20 s con la pestaña en segundo plano (el control dio
2–4 cuadros/s: el navegador la estaba limitando) y una tarea de 2,318 ms de una traza que era el
propio perfilador arrancando (`CpuProfiler::StartProfiling`). Medido en el servidor de desarrollo;
en producción debe ser más rápido, no medido.

**El carril que más se usa: buscar y agregar (Edgar: «el 80% de la comunicación del usuario con la
interfaz es el buscador y agregar facturas de proveedores»).** Recorrido en la pantalla viva con las
escrituras contestadas con **éxito simulado en el navegador** (nada llegó a la API):

| Medido antes | Ahora |
|---|---|
| El buscador vivía dentro de un plegable cerrado, a 1.3 pantallas | Siempre a la vista, arriba (y=469 de 902), atajo `/` y Esc |
| Escribir no buscaba: hacía falta Enter y nada lo decía | Busca al escribir (300 ms): «136 facturas con «bolsas» · 7 proveedores» en 1.4 s |
| 94 clics para las 94 facturas de un proveedor | «Agregar las 94»: 1 clic, con aviso si no cabe en lo libre del día |
| Tras agregar: el foco se iba al aviso, la lista se vaciaba y el «+» seguía activo | ✓ al instante, confirmación junto al buscador (645 ms), la lista se queda y el foco vuelve al buscador |
| ⛔ Agregar UNA factura reordenó **5 pagos ajenos** del día | El orden automático toca sólo el pago que la acción creó |

**Una pantalla (Edgar: «que todo entre en la pantalla con la menor cantidad de scroll»).** Medido a
1442×902: la página medía **1,914 px dentro de un panel de 814** (casi 2.5 pantallas) y cada panel
mostraba 3 renglones en el primer intento del acomodo. Ahora: los días en una tira arriba (las
fichas en su propio renglón: lado a lado con el resumen de la semana se encimaban); el veredicto
en dos renglones (tope y avance lado a lado; «quién» sólo en el paso actual); y dos paneles que
llenan lo que queda —**a la izquierda agregar facturas, a la derecha los pagos del día**—, cada uno
con su desplazamiento y la tabla con su encabezado fijo. El alto lo mide el componente sobre el
contenedor que desplaza la app (`section.pane`, no la ventana). Resultado: **desborde de 16 px**,
5 facturas y 5 pagos a la vista, 0 textos cortados (los nombres parten renglón), «Cómo sale» debajo
del beneficiario (una columna de 21rem dejaba al nombre en ~10 px). Angosto (<75rem) y teléfono:
paneles apilados, sin desborde lateral. Sin validar en la pantalla de 2112 px de Edgar (debería
ganar renglones, no medido).

**Deuda con nombre:**

- **`PGP.15.D1`** — proponer el día cuesta **2.3 MB y 931 ms** (lee las 2,858 facturas una vez por
  visita). Va al backend: un `GET days/:date/propuesta` o, al menos, sólo las columnas del armado.
- **`PGP.15.D2`** — el conteo animado de `MetricStrip` publica montos falsos en **116 pantallas**;
  aquí se apagó con `instant`. Que el default cambie es decisión de diseño de Edgar.
- **`PGP.15.D3`** — `cerrar` no valida nada en el backend (ni pendientes ni rebotes).
- **`PGP.15.D4`** — el método y la cuenta de origen recordados viven en el navegador
  (`localStorage`, por persona): es una comodidad, no una regla de Tesorería.
- Sigue pendiente de la lista de arriba: el enlace de cada pago marcado a su comprobante en «Pagos
  a proveedor» (el cierre del día ya existe), la vista por rol, los $14.0M en dictamen —la propuesta
  ahora los **nombra** («el primero que no cabe es ACREEDOR ARTURO LOPEZ OROZCO por $8,480,000.00»)—,
  D2 + separación de funciones en backend y los dos defectos globales.

### Auditoría de la pantalla viva `/finanzas/calendario-pagos` (2026-10-26, nivel A)

> **Con qué se miró:** la app corriendo (`localhost:4200`, Playwright) contra una API local
> conectada a la base de **producción**: datos reales. Por eso **no se apretó nada que escriba**
> (preparar, aplicar, quitar, proponer orden, autorizar). Contraste medido con dos controles de
> respuesta conocida (19.06 y 7.41:1); a 1366×768, 1024×768 y 390×844. Los tokens de `[AUD.4]`
> ya estaban aplicados en el árbol, así que esta medición **los valida en la app**: texto tenue
> 5.28:1 (antes 2.56) y botón principal 5.00:1 (antes 3.39).
> **Descartado por falla del instrumento:** un desplegable que apareció abierto (lo abrió la
> captura; con recarga y 8 s sin tocar no se abre) y una primera lista de contraste medida a media
> transición de color. **No medido:** el modo oscuro de los componentes PrimeNG (cambiar de tema
> con el botón guarda la preferencia en prod), el recorrido con teclado y lo que hace cada botón
> que escribe.

| # | Sev | Lo que se ve | Medido | Ley | Qué exige |
|---|---|---|---|---|---|
| CAL.A1 | 🔴 | **En el teléfono la pantalla no se acomoda:** la cola y el lote siguen lado a lado y el lote queda cortado — se lee «Faltan 5 de…» y «Prepara…». La tabla mide 827 px dentro de 251. Dirección firma desde el teléfono. | 390×844 | §2 alcance · DESIGN §R | Debajo de ~74 rem una columna; la cola como tira de un renglón y cada pago como bloque rotulado (v2). |
| CAL.A2 | 🔴 | **Los mensajes que dicen QUÉ FALTA son los que menos se leen:** «falta preparar 5», «0 de 5 listos · le falta el método» y «2 días sin tope fijado» en `--warn-fg` `#F59E0B` a **2.15 y 1.95:1**; «cabe en el tope» en `--ok-fg` `#16A34A` a **3.3:1**. Son 6 de los 105 textos visibles, y son los seis de estado. | claro, con control | §3.5 · DESIGN §Ing.UI 3 | Tokens de texto semántico (ámbar ~`#B45309` 5.0:1, verde ~`#15803D` 5.0:1); `--warn-fg`/`--ok-fg` quedan para puntos y barras. Es la siguiente pasada de `[AUD.4]`. |
| CAL.A3 | 🟠 | **Ortografía y registro:** ~15 rótulos sin acento («Metodo», «Dias por pagar», «Tesoreria», «Armar el dia», «Direccion», «todavia», «despues») y **«elegi el metodo»** en cada fila — voseo, y sin acento, así que `check-voseo` no lo atrapa. | árbol de accesibilidad | §3.9 · regla de tuteo | «Elige el método», acentos completos; correr `check-voseo` con la forma sin acento como caso. |
| CAL.A4 | 🟠 | **El paso 1 plegado carga el 94 % de la página:** 10,827 de 11,517 nodos y 58,637 caracteres (el cajón de la deuda) existen con `display:none`. | DOM | DESIGN Doherty · §5.5 | El cuerpo del paso se crea al abrirlo (`@if`/`@defer`), no se esconde. |
| CAL.A5 | 🟠 | **El encabezado se come el trabajo:** el veredicto empieza en y=295 de 768 (38 %); de los 5 pagos del día se ven 2 a 1366×768 y 1 a 1024×768. Pestañas + título + instrucción de dos renglones + **dos navegadores de semana** (arriba y en la cola). | geometría | §3.1 · §4.6 · Q.1 | Un solo navegador de semana (el de la cola); la instrucción va al «?»; el lote sube. |
| CAL.A6 | 🟠 | **La instrucción describe otra pantalla:** «agrégale facturas desde la izquierda, y a la derecha ordénalo…». A la izquierda están los días; las facturas viven dentro del paso 1. | lectura | §1.1 | Reescribirla al recorrido real, o quitarla (los pasos ya dicen qué sigue). |
| CAL.A7 | 🟠 | **«GAMAHUBIN SA DE CV +3», «… +1»:** el «+N» no dice qué suma (¿documentos? ¿proveedores?). | lectura | §1.1 | «4 facturas» bajo el nombre, no un sufijo. |
| CAL.A8 | 🟠 | **El paso 3 dice «Autorizar el día · Gerencia / Dirección»**: es lo que hace el código (`[TP.16]`), pero ya no es la regla firmada (D2 por pago + separación de funciones). | lectura | §1.1 · PGP11.M1 | Al construir D2: firma por pago y por monto, y el que preparó no firma. |
| CAL.A9 | 🟠 | **«×» de quitar en rojo, siempre, en cada fila** y pegada al último campo: lo destructivo es lo más llamativo de la fila. No se probó si deshace (escribe en prod). | vista | §4.4 · Von Restorff | Ícono neutro, rojo sólo al pasar; deshacer o confirmar. |
| CAL.A10 | 🟡 | **30 textos a 10 px** (`--fs-nano`, «último recurso» según la escala): sucursal, folios, «sin folio», «elegi el metodo». | estilos computados | DESIGN §Typography | Sucursal y folio a 11–12 px; 10 px sólo para lo prescindible. |
| CAL.A11 | 🟡 | **«CEDIS» ×4 en la misma fila** (una por factura) y «el ERP ya registra $1,000.00 · 2» en la cola sin decir qué es el «2» ni que es otro universo. | lectura | §4.0 B · §1.5 | Agrupar por sucursal; el testigo del ERP sólo en el paso 4, con su aclaración. |
| CAL.A12 | 🟡 | «5 pago(s)», «2 dia(s)» con el número conocido; 21 de 45 controles del área miden menos de 24 px. | árbol · geometría | §3.9 · WCAG 2.5.8 | Plural real; objetivos ≥ 24 px (44 px con dedo). |

**Lo que ya funciona y no se toca:** el veredicto nombra el renglón que falta y su importe; la cola
dice «libre del tope» en todos los días; un día sin tope dice «sin tope fijado», no $0; el lote
cuadra con la cola ($2.86M = $2,863,347.69) y la semana cuadra con los días ($10.84M).

---

## Anticipos a proveedor — análisis (2026-11-09, ⬜ sin código)

> Pedido de Edgar (2026-11-09): *«un apartado para anticipos de proveedor»* y *«analiza cómo vamos a
> agregar anticipos a proveedor»*. Medido en prod, sólo lectura (`system_identifier` verificado).
> Nada de esto escribe en Kepler.

**Cómo vive hoy.** El anticipo es el documento `X-D-60` de `kepler_ods.kdxe` (`c4 = 60`; `c20` = el
remanente sin aplicar que guarda Kepler). Se aplica a la factura en `kdxf` (`c4/c5/c6` = el anticipo,
`c7/c8/c9` = la factura, `c3` = fecha de la aplicación). Se crea a mano en Kepler; casi todo sale de
Matriz, y una parte importante, de la cuenta de Caja General.

| Qué (prod, 2026-11-09) | Cifra |
|---|---|
| Anticipos, últimos 12 meses | 203 documentos, ~$15.5 M, 81 acreedores |
| **Sin aplicar hoy** | **60 documentos, ~$7.0 M, 42 acreedores** |
| … con deuda viva del mismo acreedor (se puede netear hoy) | 31 acreedores, ~$4.2 M |
| … sin deuda viva (no hay contra qué aplicar) | 11 acreedores, ~$2.8 M |
| … con más de 90 días | ~$5.0 M |
| Del anticipo a su aplicación | mediana 3 días, p90 16 días |

⭐ El saldo es publicable tal cual: `analytics.v_supplier_credits.a_favor` coincide con `kdxe.c20` en
los 60, sin una diferencia. ⚠️ No todo `X-D-60` es anticipo: en 1 de cada 3 aplicaciones la factura
es ANTERIOR al documento (pagos capturados como anticipo), los `TC*` son tarjeta y los `G*` son gasto.
Dos documentos (~$3.5 M, la mitad del saldo) huelen a saldo inicial y se revisan antes de publicar.

**Qué ya existe (ADR-056: no se inventa otro primitivo).** La vista `analytics.v_supplier_credits`
(ya publica la clase «Anticipo a proveedor»), los endpoints `creditos-a-favor` y `creditos/:acreedor`,
el aviso «trae $X a favor sin aplicar» del Calendario, la ventanilla de Caja General que ya paga
`X-D-60` con firma de Tesorería, y el estado `sin_factura` de `salida-proveedor.contract.ts`, que ya
declara «hoy el Calendario no programa anticipos».

**(A) El apartado — sin vista nueva.** El mismo endpoint de créditos filtrado a anticipo, por
acreedor: saldo, antigüedad (0–30 · 31–90 · +90), folio, cuenta de salida y referencia, y sus
facturas abiertas (contra qué se aplica). Dos grupos: «aplicable hoy» y «sin contra qué» (pedir la
factura o el reembolso). ⚠️ El cruce con `v_supplier_payables` midió 520–553 ms: se pide diferido,
como los créditos.

**(B) Programar un anticipo nuevo.**
1. La solicitud nace de la orden de compra, en `commercial.supplier_payment_obligations` con una
   columna `nature` (`factura` | `anticipo`) — sin tabla nueva. Regla 14: recorrer todos los caminos
   que insertan ahí (`supplier_id` es NOT NULL).
2. Entra al Calendario como cualquier obligación y sale por el carril de siempre (transferencia o
   ventanilla, firma de Tesorería).
3. Se liga con el `X-D-60` cuando se capture en Kepler: mismo acreedor, ±$1, ±5 días (la regla de
   pareo de `[PGP.97]`); llave `(sucursal, tipo, folio, cuenta)`.
4. Se cierra cuando `kdxf` lo aplica a la factura.
5. **No pagar dos veces:** al programar una factura de un acreedor con anticipo sin aplicar, se
   precarga como descuento (un renglón más de `[PGP.101]`, motivo nuevo «anticipo»); y el cierre
   tiene que decir «saldada con anticipo», no «pagada», o el mismo dinero cuenta dos veces.

**Decisiones de Edgar (con la recomendación):**

| # | Pregunta | Recomendación |
|---|---|---|
| D1 | ¿Quién pide y quién autoriza un anticipo? | Pide Compras, siempre atado a una OC; autoriza quien autoriza el día; firma Tesorería |
| D2 | ¿Qué acreedores? | Sólo mercancía (`C*`); fuera tarjeta (`TC*`) y gasto (`G*`) |
| D3 | Factura de un acreedor con anticipo sin aplicar | Descontarlo solo, modificable con firma (no sólo avisar) |
| D4 | Anticipo con más de 90 días sin aplicar | Alerta a Compras y CxP para exigir factura o reembolso |
| D5 | ¿Quién lo aplica en Kepler mientras la escritura siga apagada? | CxP; la Suite sólo verifica en `kdxf` |
| D6 | ¿Tope del anticipo? | Como % de la OC |
| D7 | Los dos documentos grandes que parecen saldo inicial | Revisarlos con Contabilidad antes de publicar el apartado |

**NO MEDIDO:** cuántos anticipos se pueden ligar a una OC (en Kepler la referencia es texto libre);
cuántos de los 42 acreedores existen en `catalog.suppliers`; si lo que salió de Caja General fue
efectivo.

---

## El flujo nuevo: pagar → validar contra el banco → escribir en Kepler (Edgar, 2026-11-09)

> *«Agregamos los pagos y la forma de pago, después se paga, se jalan los estados de cuenta o
> movimientos y se valida que se haya pagado (más su comprobante), y con eso insertamos el pago en
> Kepler automáticamente, ya validado.»* — Edgar, 2026-11-09.

**El cambio de fondo:** «Pagado» deja de ser un clic. Hoy «Pagado» lo marca una persona sin prueba
(y con el mismo permiso que prepara). En el flujo nuevo lo pone la **evidencia**: el movimiento del
estado de cuenta + el comprobante. Y sólo lo validado se escribe en Kepler.

```
Armar el día → Preparar (forma de pago) → Dirección autoriza → se paga en el banco / ventanilla
   → VALIDAR: movimiento del banco + comprobante (efectivo: salida de ventanilla)
   → ENSAYO: la Suite muestra el X-D-26 exacto; una persona lo aprueba
   → ESCRIBIR el X-D-26 en Kepler (automático después del ensayo)
```

**Decisiones de Edgar (2026-11-09):**

| # | Decisión |
|---|---|
| F1 | **La autorización de Dirección se queda**, antes de pagar |
| F2 | **Validar exige banco Y comprobante**: el movimiento (misma cuenta, ±$1, ±5 días — la regla medida de `[PGP.97]`) y el comprobante con la CLABE destino del pago |
| F3 | **Kepler: ensayo y luego automático** — las primeras 2 semanas cada X-D-26 se muestra y una persona lo aprueba; validado contra lo que Tesorería capturaba a mano, pasa a automático |
| F4 | **Efectivo de Caja General se valida con la ventanilla** (su salida con folio y firma de Tesorería), no con el estado de cuenta |

**Estado medido hoy (prod, sólo lectura):** los movimientos del banco llegan **hasta hoy** (noviembre
se volvió a subir el 2026-11-09; 17 movimientos con fecha imposible, posterior a hoy). Comprobantes
de pago a proveedor: **16 en 30 días** — con F2, Tesorería tiene que subir el comprobante de CADA
pago o nada se valida. Es el cuello del flujo nuevo, y se dice primero.

**Items (C0 → C3, un escalón a la vez):**

| Item | Capa | Qué | Estado |
|---|---|---|---|
| `[PGP.102]` | C0 | Medir el par **pago de la Suite ↔ movimiento del banco** (cuenta de origen del pago ↔ cuenta del estado de cuenta, ±$1, ±5 días) con control placebo, sobre los pagos que Kepler ya saldó; y el par pago ↔ comprobante (importe + CLABE) y pago en efectivo ↔ salida de ventanilla | ⬜ |
| `[PGP.103]` | C1 | Regla pura `validacionDelPago`: `sin_movimiento · falta_comprobante · comprobante_sin_movimiento · discrepa · validado` (efectivo: `sin_salida_ventanilla · validado`). Lo no medible se declara | ⬜ |
| `[PGP.104]` | C2+C3 | El día trae la validación por pago; el botón «Pagado» se retira: el estado sale de la evidencia. Lo que falta se dice con su nombre (sigue la línea de `[PGP.100]`) | ⬜ |
| `[PGP.105]` | C2+C3 | **Ensayo**: por cada pago validado y que Kepler no tenga ya, el X-D-26 exacto que se escribiría (armador `[PGP.71]`), con «Aprobar» | ⬜ |
| `[PGP.106]` | C2 | **Escribir**: reclamar el pago de forma atómica (`kepler_payment_folio`) antes de escribir, revisar que Kepler no lo tenga ya capturado a mano, escribir las **8 tablas** (falta `kdm5` y la póliza `kdc2AAMM` en el armador) | ⚠️ espera el GRANT de quien administra Kepler (INSERT `kdxe`/`kdxf`, UPDATE `kdxe.c20`, …) y la lista completa de tablas (`ops/prod/ensayo-pago-kepler/foto-contadores.js`) |

⛔ Escribir en Kepler no se deshace: `[PGP.106]` no se enciende sin el ensayo de `[PGP.105]` en verde
durante 2 semanas contra lo que Tesorería capturó a mano.

---

## El cierre contable del pago: escribirlo en Kepler y armar la póliza de egreso de ContPAQi (2026-11-09)

> *«Documenta esto, y que podamos generar la póliza de egreso automáticamente identificando PPD o
> PUE, además empatando con la factura del gasto, para que se escriba el gasto en Kepler y la póliza
> de ContPAQi.»* — Edgar, 2026-11-09.

**El flujo completo, de punta a punta.** Lo de arriba de la línea ya existe; lo de abajo es lo que
este apartado diseña:

```
Armar el día → forma de pago → Dirección autoriza → se paga en el banco
  → VALIDAR: salida del estado de cuenta + comprobante          [PGP.103/104] 🔨 en código
  → «Pagado» (sólo si validó)                                   [PGP.104]
─────────────────────────────────────────────────────────────────────────────────────────────
  → guardar QUÉ salida y QUÉ comprobante lo probaron            [PGP.107]
  → cada factura del pago ↔ su CFDI (PUE o PPD)                 [PGP.108]
  → KEPLER: el X-D-26 + su póliza interna (kdc2AAMM)            [PGP.105/106]
  → CONTPAQI: la póliza de egreso, en el TXT del día            [PGP.109/112] (ADR-040: la importa una persona)
  → PPD: cuando llega el REP del proveedor, se asocia           [PGP.110]
```

### Lo que ya quedó hecho hoy

- **Los permisos de Kepler para escribir el pago** (`ops/prod/kepler-grants/pgp106_pago_proveedor.sql`):
  aplicados y comprobados en **CEDIS** el 2026-11-09, desde `md` como `postgres` (runbook
  `KEPLER_PUSH_DESPLIEGUE.md` §14.2). `kepler_push` ya puede insertar en `kdm1 kdm5 kdxe kdxf` y en la
  póliza del mes (`kdc22611`, `kdc22612`), actualizar `kdxg`, `kdc126` y sólo `kdxe.c20`; no puede borrar
  nada. ⚠️ Volver a correrlo cuando exista la tabla de enero (`kdc22701`).
- **La validación banco + comprobante** (`[PGP.103]`/`[PGP.104]`): «Pagado» sólo con la salida del banco
  y su comprobante; el candado de Kepler (`motivosParaNoEscribir`) la exige.

### Lo que ya existe y se reutiliza (ADR-056: no se inventa otro primitivo)

| Pieza | Dónde | Qué hace |
|---|---|---|
| Asiento del pago a proveedor | `libs/finance/src/lib/contpaqi/pago-proveedor.ts` (`armarPagoProveedorCompleto`) | 2120+sufijo / banco, traspaso de IVA 1470040000 → 1060000000 e IEPS 1470110000 → 1470100000, notas de crédito, redondeo < $1. Puro; reproduce 1,051 de 1,142 pólizas reales (su propia prueba) |
| Asiento de gasto con factura | `contpaqi/gasto-con-factura.ts` | gasto 52xx + IVA del CFDI + banco. ⚠️ rechaza facturas con retención |
| El archivo de ContPAQi | `purchase-book/poliza-txt.ts` + `txt-sink.adapter.ts` | TXT con renglones `P`/`M`/`AD` (el `AD` lleva el UUID). Devuelve `entregada`, nunca `aplicada` (ADR-040) |
| Pareo pago ↔ facturas ↔ CFDI | `contpaqi/pago-proveedor.fuente.ts` | parte del banco, encuentra el X-D de Kepler y sigue `kdxf` hasta el CFDI. ⛔ necesita que el X-D ya exista en Kepler |
| Confirmación manual de facturas | `contpaqi.pago_confirmaciones` | lo ambiguo lo decide una persona |
| PUE/PPD con REP | DIOT y conciliación (`ppd_sin_rep`) | ya distinguen PPD sin REP |
| El pago en Kepler | `payment-calendar/kepler-pago/` | arma el X-D-26; escribe 4 de las 8 escrituras; apagado y sin conectar |

### Lo medido (prod, sólo lectura, 2026-11-09)

| Qué | Cifra | Qué significa |
|---|---|---|
| CFDI recibidos con `metodo_pago` | **100 %** (~1,200 facturas al mes, al día) | PUE/PPD se sabe siempre |
| PUE vs PPD | por número 44 % / 56 %; **por dinero 9 % / 91 %** | casi todo el dinero es PPD: el REP manda |
| Factura del Calendario ↔ CFDI único, por el documento de Kepler (`kdxe` + RFC + total ±$1 + fecha ±45 días) | **67.5 % de los renglones, 70 % del dinero**; control negativo (importe corrido) 0.3 % | se puede ligar sola; el resto lo decide una persona (32 con varios candidatos, 58 sin CFDI, 17 sin RFC) |
| … por el camino que usa hoy la pantalla (`v_payable_evidence`) | 13 % | ese camino pierde justo las ya pagadas |
| De las ligadas, PPD | 96 % | |
| PPD con al menos un REP (ene–ago) | 89 % de las facturas, 92 % del dinero | el proveedor sí lo emite… |
| Días del pago al REP | mediana 3.5, p80 13, **p90 24** | …pero **después** de pagar: al pagar, el REP todavía no existe |
| Espejo de REP (`contpaqi_ods.add_pagos`) | **detenido desde el 30-oct**; fue una carga inicial, no un carril vivo | sin carril vivo no hay REP que asociar |
| Lo que hace hoy la contadora | 66 % de sus pólizas de egreso llevan la factura; **40 % el REP asociado** | la póliza se arma al pagar y el REP se asocia después |
| Cuenta contable del proveedor de mercancía | 256 de 257 | alcanza |
| Cuenta contable de los gastos | **0 de 51** (`contpaqi.account_rules` sin `cuenta_gasto`) | no se puede armar un gasto sin que alguien la defina |
| Cuenta contable de los bancos | 18 de 20 | casi |
| Pólizas exportadas a ContPAQi | **0** (`contpaqi.poliza_exports`) | el puente nunca ha entregado un archivo real |
| Pagos del Calendario marcados pagados | **0** (36 días en borrador) | el evento «pagado» todavía no existe |

⚠️ `finance.gl_supplier_accounts` (929 cuentas de proveedor) viene de un Excel (`libro_compras_xlsx`):
revisarla contra la regla 1 antes de usarla; `contpaqi.supplier_accounts` confirmadas son 421.

### La regla PUE / PPD (lo que decide el asiento)

| Factura | En el pago | Después |
|---|---|---|
| **PUE** | asiento completo: proveedor (2120) / banco, y el IVA pasa de *por acreditar* a *acreditable* por lo pagado; el renglón `AD` lleva el UUID de la factura | nada |
| **PPD** | el MISMO asiento, con el IVA **proporcional a lo que se pagó** (la parcialidad: 105 renglones del Calendario pagan menos que el documento); la póliza queda **«espera REP»** | cuando el REP del proveedor aparece (`add_pagos_doc_rel`: su `IdDocumento` = UUID de la factura), se asocia a la póliza (`AD` del REP). Si a los ~30 días no llega, se avisa a Cuentas por Pagar para pedirlo: sin REP el IVA no es acreditable |

Hoy el traspaso de IVA lo decide otra regla (la provisión: $20 mil / mes anterior), no `metodo_pago`.
Que el método decida es el cambio de `[PGP.109]`, y **la regla contable la confirma la contadora (P1)**.

### Items

| Item | Capa | Qué | Estado |
|---|---|---|---|
| `[PGP.107]` | C0 | **El evento «pagado» con su evidencia**: al marcar Pagado (ya validado) se guardan en el pago la salida del banco y el comprobante que lo probaron (columnas nuevas en `finance.payment_allocations`, nullables; regla 14: recorrer todos los caminos que la tocan). Sin esto ni Kepler ni ContPAQi saben fecha, cuenta e importe reales | ⬜ |
| `[PGP.108]` | C0+C1 | **Cada factura del pago ↔ su CFDI**, por el documento de Kepler (RFC + total ±$1 + fecha ±45 días): 70 % del dinero único, control 0.3 %. Varios candidatos o ninguno → una persona elige (`contpaqi.pago_confirmaciones`). Con `metodo_pago`, `forma_pago`, IVA/IEPS y retenciones del CFDI | ⬜ |
| `[PGP.109]` | C1 | **La regla PUE/PPD en el asiento**, sobre `armarPagoProveedorCompleto` (no un armador nuevo): PUE completo; PPD proporcional a la parcialidad + estado «espera REP». Pruebas con pólizas reales de la contadora como testigo | ⬜ espera P1 |
| `[PGP.110]` | C0 | **Carril vivo de REP**: `contpaqi_ods.add_pagos` / `add_pagos_doc_rel` detenido desde el 30-oct. Sin él, ningún PPD se completa. Y la asociación del REP a la póliza ya emitida | ⬜ |
| `[PGP.111]` | C1 | **Gastos**: la cuenta contable de cada proveedor de gasto (hoy 0 de 51) se PREGUNTA en el sistema como parámetro (dueño: la contadora), y las retenciones (honorarios, arrendamiento) que hoy se rechazan | ⬜ espera P3 |
| `[PGP.112]` | C2+C3 | **Al quedar «Pagado»**: la póliza entra al TXT del día (`txt-sink`, ADR-040: la importa una persona y la Suite lee el cuadre de vuelta de `gl_polizas`); en pantalla, el pago dice «póliza armada · espera REP · entregada» | ⬜ |
| `[PGP.106]` | C2 | **Kepler**: el X-D-26 con sus 8 escrituras — incluida la **póliza interna de Kepler** (`kdc2AAMM`) y los acumulados contables (`kdxg`, `kdc126`). Permisos ✅ en CEDIS; faltan en el adaptador `kdm5`, `kdxg`, `kdc2AAMM`, `kdc126` | ⚠️ falta la foto de una captura real de Tesorería (`foto-contadores.js`) |

### Decisiones (de Edgar y de la contadora)

| # | Pregunta | Recomendación |
|---|---|---|
| P1 | En PPD, ¿el IVA pasa a acreditable **al pagar** (y el REP se asocia después) o **hasta que llega el REP**? | Al pagar, proporcional a lo pagado, con el REP asociado después: es lo que hoy hace la contadora (40 % de sus pólizas ya llevan el REP asociado) y el REP llega en p90 24 días |
| P2 | ¿Cada cuánto se entrega el TXT a ContPAQi? | Uno por día, con los pagos que quedaron «Pagado»; lo importa la contadora (ADR-040: la Suite nunca escribe directo en ContPAQi) |
| P3 | ¿Quién define la cuenta contable de cada proveedor de gasto? | La contadora, contestándola en el sistema (una pregunta por proveedor, como parámetro); mientras no esté, el gasto no se arma y se dice por qué |
| P4 | El mismo pago queda en DOS contabilidades: la póliza interna de Kepler (`kdc2AAMM`, la escribe la Suite con el X-D-26) y la de ContPAQi (el TXT). ¿Las dos? | Sí: Kepler necesita la suya para cuadrar su balanza; ContPAQi es el sistema de registro contable (ADR-040). Se comparan por UUID e importe |
| P5 | ¿Se pregunta al proveedor de Kepler por su motor de documentos (`kdmx_26` / `k_docXml`)? | Sí, antes de escribir la póliza de Kepler a mano: si existe, Kepler arma su propia contabilidad y la Suite no la reproduce |

⛔ **Orden:** `[PGP.107]` y `[PGP.108]` primero (sin ellos no hay qué contabilizar); `[PGP.110]` en
paralelo (es infraestructura); `[PGP.109]`/`[PGP.111]` cuando la contadora conteste P1 y P3;
`[PGP.112]` y `[PGP.106]` al final. Nada se enciende sin su ensayo.
