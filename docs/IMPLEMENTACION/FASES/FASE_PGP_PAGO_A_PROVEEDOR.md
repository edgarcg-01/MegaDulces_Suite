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
ESTADO:    ⬜ (no abre hasta que haya cupo — ver §6)
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

### Resumen del orden

| Objetivo | Fase | Dinero | Esfuerzo | Prioridad | Depende de |
|---|---|---|---|---|---|
| O1 · El circuito cierra una vez | PGP-A | Alto | S | **1** | una persona de Tesorería |
| O2 · El día se arma en la plataforma | PGP-B | Alto | M | **1** | O1 |
| O3 · Una sola captura (Kepler) | PGP-C | Alto | L | **2** | O1 · ADR-092 ext. |
| O4 · Una sola estación | PGP-D | Medio | L | **3** | O1 · O3 verificados |
| O5 · Retirar el Excel | PGP-E | Bajo | S | **3** | O2 con un mes completo |

---

## 4. Las capas

### C0 · Dato

| # | Item | Estado | Verificado contra |
|---|---|---|---|
| PGP.0.1 | Decode del documento de pago `X-D-26`: qué tablas escribe y con qué llave | 🧪 **medido 2026-10-22** | Ver cuadro abajo |
| PGP.0.2 | Columnas `NOT NULL` de `md.kdm1`, `md.kdxe` y `md.kdxf` + **qué puede tocar `kepler_push`** | 🧪 **medido 2026-10-22** | Catálogo de `md_00` (`192.168.9.95`). Ver «el bloqueo de O3» abajo |
| PGP.0.3 | Documento plantilla de `X-D-26` para clonar, por sucursal | ⬜ | Un pago real reciente del `00`, leído entero |
| PGP.0.4 | Precedente de `c45` (cuenta de tesorería) por banco de origen | ⬜ | El decode de `c45` + estado de cuenta CB |

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

### C1 · Dominio

| # | Item | Estado | Prueba que lo ejerce |
|---|---|---|---|
| PGP.1.1 | Tope de firma por monto y a quién le toca cada pago | ⬜ | Casos en los dos lados del tope, y exactamente en el tope |
| PGP.1.2 | Armador del documento `X-D-26`: clonar plantilla, pisar campos de negocio, derivar folio `MAX+1` | ⬜ | Contra la plantilla real, sin escribir |
| PGP.1.3 | Repartidor de aplicaciones `kdxf`: un pago que cubre N facturas | ⬜ | El caso de 8 aplicaciones, y el de 1 |
| PGP.1.4 | Conciliador: lo escrito por la plataforma contra lo que el ODS devuelve | ⬜ | Un pago escrito y releído |

### C2 · API

| # | Item | Estado | ¿Escribe? | Prueba contra base real |
|---|---|---|---|---|
| PGP.1 | `GET /commercial/supplier-payment-accounts/faltantes` + la lista en `/compras/cuentas-pago` | 🧪 **2026-10-22** | no | Guión de sólo lectura contra prod (ver abajo) |
| PGP.3 | Las dos bandejas de pagos en «Mi trabajo» + la responsabilidad `finanzas.pagos` | 🧪 **2026-10-22** | sí (la migración) | `verify-pgp3-bandejas-pagos.js`, 4 controles. ⚠️ **La migración NO está aplicada en prod**: `sh ops/prod/aplicar-migracion.sh 20261022150827_pagos_responsabilidad.js`, y exige el commit empujado |
| PGP.2.2 | Sembrar `supplier_payment_accounts` desde el circuito de solicitud | ⬜ | sí | ⛔ obligatoria, con el payload de la pantalla |
| PGP.2.3 | `POST /finance/payment-calendar/allocations/:id/kepler/escribir` — escribe el `X-D-26` | ⬜ | **sí, al ERP** | ⛔ obligatoria + deshacer el documento, como hizo KR |
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
| 2026-10-23 | ⚠️ **El tracker perdió los items PGP**: el incidente de `c7d94aa7b` (un commit que arrastró hunks ajenos) los devolvió al árbol y se descartaron. El código está en prod; la bitácora de esta fase es, por ahora, el único registro. Reponerlos exige tocar un archivo que otra sesión tiene en vuelo. | Claude |

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
