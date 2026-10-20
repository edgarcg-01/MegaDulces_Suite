# Caja General — alcance y objetivos de esta tanda (`CGA`)

> **2026-10-16 · propuesto · dueño: Edgar · anexo de alcance, no es una fase nueva.**
>
> Esto NO reemplaza a [`FASE_CG_PLAN_POR_CAPAS.md`](FASE_CG_PLAN_POR_CAPAS.md) (`CGP`, 14-oct), que
> sigue siendo el plan de estabilización del corte. Este documento hace otra cosa: **fija QUÉ dinero
> entra y sale del módulo, y acota el trabajo de esta tanda a dos frentes** que Edgar nombró hoy.
>
> ⭐ **Diferencia con `CGP`:** aquel plan se armó **sin acceso a producción** y marcó con `NO MEDIDO`
> todo lo que exigía leerla. Este se armó **leyendo prod** (`pg-prod`, `system_identifier`
> **`7688376744939610156`**, sólo lectura, `SET default_transaction_read_only = on`) el 2026-10-16
> entre las 09:50 y las 10:40 hora de México. Cada cifra de abajo tiene su consulta.

---

## 0. Cómo cambió el pedido, en orden

Importa el orden, porque la primera medición se hizo con un alcance que ya no es el vigente y
**sus cifras siguen siendo verdaderas pero dejaron de ser el objetivo**:

| # | Lo que se pidió | Efecto |
|---|---|---|
| 1 | *"encontrar todos los ingresos y egresos pendientes de `/finanzas/caja-general`… necesito una verdad absoluta"* | Se midió el universo completo. Resultado en §2. |
| 2 | *"genera un plan por fases, antes de codificar entiende el objetivo del módulo, las entradas y salidas de dinero, y cómo se conciliaba antes y cómo vamos a conciliar ahora"* | El entregable deja de ser una lista y pasa a ser un **plan**. |
| 3 | ⭐ *"sólo hay que cazar los movimientos de ingresos de rutas de detalle y vecinal. A los proveedores haremos un sistema de configuración en interfaz que seleccionemos qué proveedores se les paga con efectivo, y poner sus órdenes de entrada o el proceso siguiente para tener un historial de que se les debe"* | **Acota el alcance.** Los 9,619 egresos pendientes **dejan de ser una cola que cazar**: el egreso se resuelve con configuración + historial de deuda, no capturando el pasado. |

| 4 | ⭐⭐ *"nosotros nos enfocamos del día 10 para adelante, todo lo anterior ya debería estar conciliado"* | **Fija el piso del libro en el 2026-10-10** — el último día que vivió en el Access. El rezago pasa de **13,316 a 110** movimientos (§2.5.5). |

⛔ **Lo que esto deroga:** cualquier lectura de que "hay 13,316 movimientos pendientes de capturar".
Ese número es el universo histórico; **el trabajo son 110 movimientos, $453,148.92, y 103 de ellos
son trabajo de verdad** (7 son errores de fecha de Kepler). Ver §2.5.5.

---

## 1. Qué es el módulo, en una pantalla

**Caja General es la tesorería en efectivo del corporativo**: ~$82 M al año que entran por cobranza
de rutas y salen a proveedores, nómina y gastos, casi sin tocar el banco.

**Son dos cajas físicas, no una** (lo dice `CGP` §1.1 y lo confirma `v_caja_posicion`):

- **El cajón** — efectivo de oficina, se cuenta a mano.
- **La bóveda CAOS** — máquina que recibe depósitos y dispensa billetes. Publica **flujos**, nunca el
  saldo (`VERDAD_ABSOLUTA` §28).

**El corte real ya ocurrió.** No es un plan: está medido.

| Evidencia | Valor |
|---|---|
| `BDatos.mdb` (el Access «Control») — última escritura | **2026-10-10 12:39** |
| `caja_general_ods.doctos` — último `_synced_at` / último `fecha` | **2026-10-10 18:49** / **2026-10-10** |
| `caja_general_ods._ship_watermark` para `cg20.Doctos` | congelado en **2026-10-10 18:49**, `updated_at` avanza a hoy |
| `caja_general_ship` — `rows_affected` de cada corrida desde entonces | **0** (estado `ok`, 7,517 corridas) |
| Primer movimiento de una cajera real en `finance.cash_ledger` | **2026-10-09**, `carmen_rodriguez` |
| Captura diaria sostenida en la Suite | **desde 2026-10-12**, todos los días hasta hoy |

⭐ **El feed NO está roto, y confundirlo cuesta caro.** `caja_general_ship` reporta verde con
`rows_affected = 0` porque **no hay filas nuevas que traer**: el archivo de Access dejó de cambiar.
El carril hermano sí avanza (`BMovimientosCajas.mdb`, los arqueos, escrito el **2026-10-15 18:16**;
watermark `cgarq20` al **2026-10-16**), que es justo el control que distingue "se murió la tubería"
de "se murió el origen". **Se murió el origen, a propósito.**

⚠️ **Consecuencia que hay que decir en voz alta:** entre el 11-oct y hoy, el único libro de caja que
existe es `finance.cash_ledger`, y tiene **137 movimientos vivos**. El Access ya no se escribe y la
Suite todavía no cubre todo. **No hay un libro completo del efectivo en ninguna parte.**

---

## 2. El universo medido (lo que la pregunta #1 contestó)

Todo con `app.tenant_id = 00000000-0000-0000-0000-00000000d01c`.

### 2.1 Lo que YA está en el libro — `finance.cash_ledger`

**140 filas crudas · 137 vivas · 3 canceladas · 0 borradas.**

| tipo | estado | origen | filas | monto |
|---|---|---|---:|---:|
| ingreso | registrado | cobro | 8 | $149,606.02 |
| ingreso | registrado | caos | 12 | $228,385.50 |
| ingreso | registrado | *(manual)* | 3 | $52,811.00 |
| ingreso | en_corte | caos | 17 | $266,057.00 |
| ingreso | en_corte | cobro | 2 | $32,190.00 |
| ingreso | en_corte | *(manual)* | 4 | $86,856.00 |
| gasto | registrado | pago_proveedor | 52 | $788,132.69 |
| gasto | registrado | caos | 1 | $5,000.00 |
| gasto | registrado | *(manual)* | 2 | $4,797.23 |
| gasto | en_corte | pago_proveedor | 30 | $184,093.87 |
| gasto | en_corte | caos | 4 | $12,670.00 |
| gasto | en_corte | *(manual)* | 2 | $16,793.00 |
| gasto | **cancelado** | — | 3 | $121.00 |

**Quién lo captura:** `carmen_rodriguez` (116 movimientos), `mayra_gutierrez` (31), `superoot` (5).

### 2.2 Lo que está PENDIENTE — `finance.v_caja_movimientos_pendientes`

**13,316 movimientos · $162.5 M.** Reconcilia exacto contra sus dos ramas:

| Rama | Elegibles | En el libro | **Pendientes** |
|---|---:|---:|---:|
| Kepler (`analytics.mv_caja_movimientos`, `tipo_cuenta='caja'`) | 13,376 | 89 | **13,287** |
| Cobro de ruta (`analytics.route_collections`, cuenta `0011`) | 32 grupos | 3 | **29** |
| | | | **13,316** |

Y el libro cierra por el otro lado: 89 + 3 anclados = 92, más 34 de CAOS, 11 manuales y 3 cancelados
= **140**. ✔ No sobra ni falta una fila.

Por tipo: **9,619 gastos ($82.77 M)** y **3,697 ingresos ($79.76 M)**, del 2025-01-01 al 2026-12-14.

**La bandeja no muestra eso.** Con la ventana por default (`CAJA_VENTANA_DIAS = 45`) y el descuento
por glosa (`[CG.85]`, esconde 142):

| | filas | monto |
|---|---:|---:|
| En ventana (01-sep → 16-oct) | **1,849** | $17,149,100.49 |
| Atrás de la ventana | 11,318 | $144,216,629.24 |
| **Mal fechados** (futuro) | **7** | $50,796.40 |
| Universo tras descuento | 13,174 | $161,416,526.13 |

⭐ **El pendiente y el libro viejo son el mismo dinero visto dos veces.** El espejo de Control
(`analytics.caja_general_movimientos`) trae 13,414 movimientos de 2026 ($81.6 M ingresos + $82.5 M
gastos) y mes a mes coincide con el pendiente de Kepler dentro de centésimas — p.ej. gastos de
jun-2026: Kepler $9,206,861.89 vs Control $9,206,165.89. **No son dos backlogs: es uno.**

### 2.3 CAOS (la bóveda), segunda fuente

| | filas | monto |
|---|---:|---:|
| Ingresos pendientes (`type_id = 0`) | **726** | $17,987,560.00 |
| Gastos pendientes (`type_id = 4`) | **363** | $17,903,900.00 |
| Ya en el libro | 34 | — |
| Ya enlazados a un gasto | 10 | — |

Vive del **2026-05-27** a hoy, y el feed `caos_movimientos` está **vivo** (última corrida OK hoy 09:57).

### 2.4 Los cortes

**Sólo 2 cortes en toda la historia, los dos cerrados, ninguno autorizado.**

| Folio | Fecha | Esperado | Contado | Diferencia | Cerró | Autorizó |
|---|---|---:|---:|---:|---|---|
| CC-2026-00001 | 2026-10-12 | $3,402.45 | $3,653.50 | +$251.05 | carmen_rodriguez | — |
| CC-2026-00002 | 2026-10-13 | **−$149,915.32** | $57,571.00 | **+$207,486.32** | carmen_rodriguez | — |

⛔ **Un esperado NEGATIVO no es un descuadre de caja: es la prueba de que faltan ingresos en el
libro.** `esperado = fondo + ingresos − gastos + dispensado − depositado`; si da −$149 K es porque
los gastos están entrando y los ingresos no. **Es exactamente el frente que Edgar acotó.**

Y **78 movimientos vivos no tienen corte**: 43 del 14-oct, 23 del 15-oct, más 12 anteriores.
Las jornadas del **14, 15 y 16 de octubre no están cerradas**.

---

## 2.5 La entrada y la salida del efectivo, completas

> Esto contesta las cuatro preguntas de Edgar del 2026-10-16: *«¿ya sabemos nuestra entrada de
> efectivo? ¿nuestra salida? ¿lo que llevamos rezagado?»*. **Sí, las tres.**

### 2.5.1 ENTRADA — tres documentos, y uno se lleva el 95 %

Universo completo de `analytics.mv_caja_movimientos` (`tipo_cuenta='caja'`, `signo>0`, sin traspasos):

| doc_tipo | Qué es | Docs | Monto | % |
|---|---|---:|---:|---:|
| **`U-A-5`** | **Depósito de efectivo a Caja General** — la cobranza de ruta y la venta de sucursal, agregada por día y plaza | **3,626** | **$75,415,288.14** | **95.1 %** |
| `X-A-45` | Ingreso de caja | 45 | $3,919,920.58 | 4.9 % |
| `U-A-25` | Ingreso de caja | 4 | $3,981.65 | 0.0 % |
| | **Total** (2025-07-05 → 2026-12-14) | **3,675** | **$79,339,190.37** | |

⭐ **No hay una cuarta forma de que entre efectivo.** Esa es la respuesta completa, y es más corta de
lo que parecía: el ingreso de Caja General **es, en la práctica, el depósito `U-A-5`**.

### 2.5.2 SALIDA — también tres, y uno se lleva el 92 %

| doc_tipo | Qué es | Docs | Monto | % |
|---|---|---:|---:|---:|
| **`X-D-26`** | **Pago a proveedor / egreso de caja** | **9,652** | **$77,456,509.12** | **92.5 %** |
| `X-D-60` | Egreso de caja (grandes) | 48 | $6,280,943.54 | 7.5 % |
| `X-D-25` | Egreso de caja | 1 | $9,770.80 | 0.0 % |
| | **Total** (2025-01-01 → 2026-12-10) | **9,701** | **$83,747,223.46** | |

⚠️ **Y lo que NO es entrada ni salida:** `N-A-26` — 16 movimientos, $62,384.08 — son **traspasos**
entre cajas y la vista los excluye a propósito (`es_traspaso = true`). Sumarlos sería contar el
mismo dinero moviéndose de bolsillo como si entrara o saliera.

### 2.5.3 El ritmo mensual de 2026

| Mes | Entradas | Monto entrada | Salidas | Monto salida | Neto |
|---|---:|---:|---:|---:|---:|
| 2026-01 | 299 | $8,160,262.59 | 654 | $10,213,059.38 | −$2,052,796.79 |
| 2026-02 | 352 | $8,994,119.87 | 565 | $8,702,751.99 | +$291,367.88 |
| 2026-03 | 377 | $9,084,923.07 | 1,060 | $9,371,895.04 | −$286,971.97 |
| 2026-04 | 405 | $8,256,097.57 | 997 | $8,605,307.85 | −$349,210.28 |
| 2026-05 | 408 | $8,458,944.44 | 1,412 | $7,712,184.91 | +$746,759.53 |
| 2026-06 | 477 | $10,110,573.30 | 1,223 | $9,206,861.89 | +$903,711.41 |
| 2026-07 | 477 | $10,452,158.24 | 1,202 | $9,580,938.37 | +$871,219.87 |
| 2026-08 | 414 | $6,965,006.00 | 1,008 | $8,518,523.05 | −$1,553,517.05 |
| 2026-09 | 390 | $7,050,778.80 | 983 | $6,727,898.75 | +$322,880.05 |
| **2026-10** | **66** | **$977,921.14** | **523** | **$3,237,767.79** | **−$2,259,846.65** |
| **ene–oct** | **3,665** | **$78,510,785.02** | **9,627** | **$81,877,189.02** | **−$3,366,404.00** |

⛔ **Octubre no es un mes flojo: es un mes roto.** Ver §2.5.4.

### 2.5.4 ⛔⛔ HALLAZGO NUEVO — el registro del INGRESO en Kepler se apagó el 12-oct

Entradas y salidas por **semana de captura** (`c68`, cuándo Kepler lo registró — no `fecha_valor`,
que es otra pregunta):

| Semana | Entradas | Monto | Salidas | Monto |
|---|---:|---:|---:|---:|
| 2026-08-03 | 113 | $1,944,348.45 | 161 | $539,718.31 |
| 2026-08-10 | 89 | $1,654,451.39 | 295 | $2,656,262.17 |
| 2026-08-17 | 105 | $2,013,623.59 | 283 | $2,927,217.34 |
| 2026-08-24 | 111 | $1,924,800.48 | 207 | $2,175,946.91 |
| 2026-08-31 | 71 | $3,234,393.02 | 275 | $1,079,402.92 |
| 2026-09-07 | 87 | $2,914,424.63 | 243 | $2,146,496.54 |
| 2026-09-14 | 116 | $2,531,283.02 | 180 | $2,545,484.24 |
| 2026-09-21 | 111 | $1,971,882.15 | 170 | $987,320.81 |
| 2026-09-28 | 79 | $1,385,120.65 | 235 | $1,917,400.00 |
| 2026-10-05 | 54 | $745,243.43 | 425 | $2,269,518.42 |
| **2026-10-12** | **3** | **$59,084.50** | **173** | **$1,178,056.44** |

**De ~90–115 depósitos por semana a TRES.** Y las salidas siguen normales.

**Las tres explicaciones fáciles están descartadas, medidas:**

| Hipótesis | Por qué NO |
|---|---|
| Rezago de captura del ERP | La mediana es **3 días** y el máximo 12; hoy es 16-oct, así que la semana del 5-oct ya debería estar completa y tiene 54 contra ~100 |
| Se cayó el feed del ODS | `kepler_ods.kdm1` con `c45` trae **19,606 filas** la semana del 12-oct (parcial) contra ~30,000 de una semana completa — **proporcional, sano** |
| Se cayó todo el carril de caja | Las **salidas** del mismo `kdm1`, misma cuenta, misma semana: **173**. Sólo se apagó el ingreso |

⭐ **Y la fecha es la misma que la del corte del Access** (§1). La lectura más probable —**no
medida**— es que quien capturaba el depósito en Kepler lo hacía como parte del flujo de Access, y al
pasarse a la Suite ese paso se dejó de hacer.

⛔ **Por qué esto es peligroso y no sólo feo:** la bandeja de pendientes se va a **vaciar sola**, y
una bandeja vacía se lee como *«ya no hay trabajo»*. Es la misma trampa de GOTCHAS §84 un piso más
arriba: *el dinero sigue entrando; lo que se apagó es su registro.* **Hay que preguntar en
operación antes de construir nada encima.**

### 2.5.5 El REZAGO — y el corte de alcance que lo vuelve manejable

⭐⭐ **DECISIÓN DE EDGAR, 2026-10-16:** *«nosotros nos enfocamos del día 10 para adelante, todo lo
anterior ya debería estar conciliado.»* El libro arranca en el **10-oct**, que es el último día que
vivió en el Access. Todo lo anterior es historia de Control, **no cola de trabajo**.

**Eso cambia la escala de 13,316 a 110.**

| | Universo completo | **Desde el 10-oct** |
|---|---:|---:|
| Ingresos pendientes | 3,697 · $79,758,900.94 | **4 · $115,836.31** |
| Egresos pendientes | 9,619 · $82,774,996.90 | **106 · $337,312.61** |
| **Total** | **13,316 · $162,533,897.84** | **110 · $453,148.92** |
| Fuera de alcance (antes del 10-oct) | — | 13,206 · $162,080,748.92 |

**Y de esas 110, siete no son trabajo:** son los **mal fechados** que Kepler registró con fecha de
diciembre (6 gastos $12,432.59 + 1 ingreso $38,363.81 = **$50,796.40**). Se corrigen **en Kepler**,
no capturándolos acá.

> ### 🎯 **El trabajo real: 103 movimientos · $402,352.52**

**Día por día, completo:**

| Día | Gastos | Monto | Ingresos | Monto | Qué es |
|---|---:|---:|---:|---:|---|
| **2026-10-10** | **80** | $176,633.94 | 1 | $19,138.00 | **El último día del Access.** El grueso del rezago está acá |
| 2026-10-12 | 1 | $421.00 | 1 | $28,204.50 | |
| 2026-10-13 | — | — | 1 | $30,130.00 | |
| 2026-10-14 | 3 | $10,684.08 | — | — | |
| 2026-10-15 | 15 | $135,891.00 | — | — | |
| 2026-10-16 | 1 | $1,250.00 | — | — | hoy |
| *(mal fechados)* | *6* | *$12,432.59* | *1* | *$38,363.81* | *se corrigen en Kepler* |

⭐ **El rezago no está repartido: el 78 % está en un solo día**, el 10-oct — el día del corte. Es
exactamente lo que se espera de una migración: el último lote del sistema viejo se quedó sin pasar.
**Del 12-oct en adelante, el rezago diario es de 1 a 15 movimientos.**

**Los 4 ingresos pendientes, nombrados:**

| Día | doc | folio | Sucursal | Monto |
|---|---|---|---|---:|
| 10-oct | `U-A-5` | 0000094 | 01 Padre Hidalgo | $19,138.00 |
| 12-oct | `U-A-5` | 0000095 | 01 Padre Hidalgo | $28,204.50 |
| 13-oct | `U-A-5` | 0000124 | 01 Padre Hidalgo | $30,130.00 |
| *14-dic* | `U-A-5` | 0000129 | 02 La Piedad | *$38,363.81 — mal fechado* |

⚠️ **Los tres reales son todos de Padre Hidalgo (`01`).** Ninguna otra plaza tiene depósito
pendiente — porque ninguna otra tiene depósito **registrado** desde el 12-oct (§2.5.4).

**Las otras dos fuentes, mismo recorte:**

| Fuente | Pendiente desde el 10-oct | Monto |
|---|---:|---:|
| **CAOS** (bóveda) | 11 gastos + 2 ingresos = **13** | $562,710.00 |
| **Cobro de ruta detalle** (`D-23-1`) | **4** — los 4 del 10-oct (`ruta_21`, `22`, `26`, `27`) | $49,350.89 |

⭐ Los 3 cobros de ruta del 12-oct **ya están en el libro** ($32,189.62, capturados como
`en_corte`). O sea que el carril de ruta de detalle **sí se está usando** — su rezago son los 4 del
día del corte.

### 2.5.6 El avance real, con el denominador correcto

| | Denominador | En el libro | Pendiente | Avance |
|---|---:|---:|---:|---:|
| Con el universo entero | 13,405 | 92 | 13,316 | 0.69 % |
| **Con el alcance del 10-oct** | **199** | **89** | **110** | **44.7 %** |
| **Descontando los mal fechados** | **192** | **89** | **103** | **46.4 %** |

⭐ **No es un módulo sin adoptar: es un módulo a la mitad, con el rezago concentrado en un día.**
Publicar «0.69 %» contra el universo histórico describe una decisión de alcance, no el trabajo
—y leído como avance, acusa a la gente de no usar algo que sí está usando.

---

## 3. Cómo se conciliaba antes, y cómo se va a conciliar ahora

### 3.1 Antes — el Access «Control» (hasta el 10-oct)

Una sola tabla, `Doctos`, con seis pantallas encima y el tipo de documento como discriminador:

| Forma | Qué registra | `TipoDto` |
|---|---|---|
| `Fichas1` / `Fichas2` / `FichasVarios` | **Fichas de efectivo por cobranza** y otros ingresos | 1 |
| `Gastos` / `CompGtos` | Comprobante y comprobación de gasto | 2 |
| `Depositos` | Depósito al banco | 3 |

La conciliación era **aritmética dentro de la misma tabla**: un **saldo corrido** (`SaldoD`) que se
arrastraba fila a fila, más el **desglose por denominación** (15 campos `B1000…Mor`) que convertía la
pantalla en un arqueo. El testigo externo era el depósito bancario.

⚠️ Lo que eso **no** tenía: ningún vínculo con el documento del ERP. El número de Control y el de
Kepler eran dos capturas humanas del mismo hecho, y cuadrarlas era trabajo manual.

### 3.2 Ahora — la Suite (desde el 12-oct)

El cambio de fondo (ADR-070 + decisión de dirección del 18-sep): **el registro precede al dinero**.
No se teclea un movimiento: se **confirma** un documento que Kepler ya registró, y el monto lo manda
el ERP. Cada movimiento queda atado por `origen_tipo` + `origen_ref`, que es lo que hace idempotente
toda la bandeja.

La conciliación pasa a tener **cuatro testigos independientes**, no uno:

| Testigo | Qué arbitra | Dónde vive |
|---|---|---|
| **Kepler** (`kdm1.c45`, cuenta de tesorería) | que el documento exista y por cuánto | `analytics.mv_caja_movimientos` |
| **CAOS** | el efectivo que la máquina contó de verdad | `analytics.caos_cash_movements` |
| **El arqueo ciego** | lo que una persona contó sin ver el esperado | `finance.cash_ledger_cut_denominations` |
| **El banco** (CB) | el depósito que salió de la caja | conciliación bancaria |

⭐ **Y la regla que define el proyecto:** lo que no se pudo medir **se declara** (`unknown`,
`measured:false`), nunca se dibuja como cero ni como verde (ADR-056). Por eso la bandeja publica
`datos_al`, cuenta lo que deja fuera de la ventana y muestra los mal fechados en vez de esconderlos.

⚠️ **Lo que todavía NO concilia, y es el hueco de esta tanda:** el ingreso de ruta. Los cuatro
testigos cubren el gasto y el efectivo físico; **el ingreso de detalle y el de vecinal no tienen
puente al libro**, y por eso el esperado del corte sale negativo.

---

## 3.5 ⛔⛔ La corrección que cambia los frentes A y B

> **Escrito después de medir, el mismo 2026-10-16.** La primera versión de este documento proponía
> «conectar el puente vecinal que ya existe». **Estaba mal, y el repo ya lo decía.**

### El conflicto, con sus dos fechas

| Fecha | Dónde | Qué afirma |
|---|---|---|
| **2026-10-13** | `01_TRACKER_PROGRESO.md`, `[VEC.10]` | *«`U-D-10` se llama "Ticket Contado Caja N" — la vecinal **se timbra en una caja registradora de la sucursal y su efectivo se cuenta en el arqueo de esa caja**. Caja General no es su destino y nunca lo fue.»* Cobertura medida: **568 de 569 día-caja con arqueo = 99.8 %** |
| **2026-10-15** | `libs/finance/src/lib/caja/caja-vecinal.query.ts`, `CGP-VEC.1` | Construye el puente que mete `efectivo_contado` de esos mismos cierres a `finance.cash_ledger` |

Dos días de diferencia, conclusiones opuestas, **las dos en `main`**.

### Quién gana, medido hoy

El ingreso de Caja General **ya tiene vehículo, y es uno solo**:

| doc_tipo | Pendientes | Monto | % |
|---|---:|---:|---:|
| **`U-A-5`** — depósito de efectivo a Caja General | **3,648** | **$75,834,998.71** | **95.4 %** |
| `X-A-45` | 45 | $3,919,920.58 | 4.9 % |
| `U-A-25` | 4 | $3,981.65 | 0.0 % |

Y los conceptos de esos `U-A-5` dicen de dónde viene el dinero, con todas las letras:

```
VENTA SUC PH SABADO 20-06-2026          $224,063.50
DEPOSITO CAJA GENERAL 23/03/26 MORELIA ABASTOS   $550,000.00
VENTA 8ESQ 04 Y 05 JULIO 2026           $308,934.58
VENTA SUC PADRE HIDALGO 04-07-2026      $206,724.73
```

⭐ **`VEC.10` tenía razón.** El efectivo de sucursal y de ruta se cuenta en **el arqueo de su propia
caja**, y llega a Caja General **como un depósito `U-A-5`, ya agregado por día y plaza**. El puente
de `CGP-VEC.1` metería los 572 cierres **encima** de esos depósitos: **~$9 M contados dos veces**.

Por eso su propio autor lo dejó escrito y **sin conectar** — *«todavía no se conecta a la pantalla»*
—, y por eso la hipótesis de parear por importe falló: no estaba buscando el gemelo del depósito,
estaba buscando **el mismo dinero en dos granos distintos** (572 cierres contra 3,648 depósitos).

### Lo que esto cambia

1. ⛔ **No se construye ningún puente nuevo de ingreso.** El ingreso de detalle y vecinal **ya está
   en la bandeja**: son los 3,648 `U-A-5`. El trabajo no es derivarlo, es **confirmarlo**.
2. ⛔ **`CGP-VEC.1` no se conecta a `/finanzas/caja-general`.** Si tiene destino, es el módulo de
   **cortes de sucursal (`CSU`)**, que es donde se cuenta esa caja — no el cajón del corporativo.
   Recordá la regla 1 de `CGP` §1.4: *«el cajón es UNO y ve todas las plazas; `cash_ledger.sucursal`
   es la plaza del **documento**, no dónde estaba el efectivo»*.
3. ⭐ **Y explica el esperado negativo.** `CC-2026-00002` cerró con −$149,915.32 porque los gastos
   entran y **los `U-A-5` no**. La prueba de que el frente sirvió es que ese número se vuelva positivo.

⚠️ **Lo que sigue abierto y es de Edgar:** el pedido fue *«cazar los ingresos de rutas de detalle y
vecinal»*. Medido, eso **es** cazar los `U-A-5`. Si lo que se quiere es además ver el cierre vecinal
día por día dentro de Caja General, eso es **otra cosa** —una vista de procedencia, no un
movimiento— y hay que decirlo así para no duplicar el dinero.

---

## 4. Los objetivos de esta tanda

> Reescritos después de §3.5. La versión anterior proponía un puente que habría duplicado ~$9 M.

### Frente A — Ingreso de **ruta de detalle**

**Qué hay:** `analytics.route_collections`, doctype **`D-23-1`**, cuenta `0011`.

| | |
|---|---|
| Cobros | **48** (32 grupos día×folio) |
| Camiones · almacenes | 4 · 4 |
| Periodo | **2026-10-02 → 2026-10-12** |
| Monto | **$577,088.21** |
| Pendientes de entrar al libro | **29 grupos** (3 ya entraron) |

⚠️ **NO MEDIDO — y es lo primero que hay que medir:** la tabla **se detiene el 12-oct**, la misma
semana del corte. Hay que distinguir tres causas antes de construir nada: (a) el feed que la llena
se detuvo, (b) las rutas de detalle dejaron de cobrar, o (c) el cobro ahora entra por otro carril.
**Cero filas por un defecto es indistinguible de cero filas por desuso** — y en este proyecto esa
confusión ya costó una vez (el arqueo de caja, 14-oct).

⚠️ **Y ojo con el grano:** estos 48 cobros son el cobro de **crédito** de la ruta de detalle
(`D-23-1`, cuenta `0011`). La **venta de contado** de esas mismas rutas no viaja por acá: cae en el
arqueo de su caja y llega como `U-A-5` (§3.5). Son dos caminos distintos del mismo camión.

**Objetivo A:** que el cobro de crédito de ruta de detalle llegue al libro **por derivación, sin
captura manual**, con su documento de Kepler como ancla — **una vez resuelto por qué el feed se
detuvo el 12-oct**.

### Frente B — Ingreso de **ruta vecinal** → **es confirmar los `U-A-5`**

⛔ **Reescrito por §3.5.** No se construye un puente: el dinero de vecinal y de sucursal **ya está
en la bandeja**, agregado por día y plaza, como depósito `U-A-5`.

| | |
|---|---|
| Qué se confirma | **3,648 depósitos `U-A-5` pendientes** |
| Monto | **$75,834,998.71** — el **95.4 %** de todo el ingreso de Caja General |
| Periodo | 2025-07-05 → 2026-12-14 (7 mal fechados, ver §2.2) |
| En la ventana de 45 días | **468 ingresos · $8,288,122.89** |
| Ritmo reciente | ago-2026 414 · sep-2026 390 · **oct-2026 sólo 88** (porque desde el 12-oct ya se captura) |

**El árbitro de procedencia sigue sirviendo, pero como TESTIGO, no como movimiento.**
`analytics.v_vecinal_conciliacion` (572 cierres, $8,991,447.41, 7 sucursales, abril→octubre) es lo
que permite contestar *«este depósito de $224 K, ¿de qué cierres viene?»*. Eso es una **vista de
procedencia colgada del `U-A-5`**, no 572 filas en el libro.

⛔ **No reconstruyas la hipótesis muerta:** parear cierre ↔ depósito **por importe** se midió con
control de placebo y dio real 3.0 % vs placebo 3.1 %. No falló por falta de tolerancia: falló
porque son **dos granos distintos** del mismo dinero.

**Objetivo B:** que los `U-A-5` se confirmen al ritmo que entran (y que el atraso se reconozca como
decisión de alcance, no como cola), **con su procedencia vecinal a la vista cuando exista**.

### Frente C — **Egreso a proveedores**: configuración, no cacería

⭐ **Cambio de forma pedido por Edgar.** Los 9,619 gastos pendientes **no se capturan**. En su lugar:

1. **Una pantalla de configuración** donde se marca **qué proveedores se pagan en efectivo**.
2. Para esos proveedores, traer sus **órdenes de entrada** (o el paso siguiente del proceso).
3. Con eso, un **historial de lo que se les debe** — el egreso deja de ser una fila que alguien
   recuerda y pasa a ser un saldo con origen.

**NO MEDIDO todavía** (es el primer trabajo del frente): qué proveedores cobran en efectivo hoy
(`kdud.c31`, formas de pago), cómo se identifican las órdenes de entrada (`XA2001`, que
`buscarPagables()` ya consulta), si hay tabla de configuración que **extender** en vez de crear
(regla: derivá o extendé, nunca una segunda materialización), y dónde cae la pantalla —
Finanzas o Compras — contra [`docs/MATRIZ_ACCESOS.md`](../../MATRIZ_ACCESOS.md).

---

## 5. Lo que NO se midió — declarado, no dibujado

| # | Hueco | Por qué importa |
|---|---|---|
| H1 | Por qué `route_collections` se detiene el 2026-10-12 | Decide si el Frente A arranca arreglando un feed o construyendo un puente |
| H2 | ~~Qué llave desempata el doble conteo vecinal ↔ `U-A-5`~~ **RESUELTO en §3.5: no hay doble conteo que desempatar porque el cierre vecinal no entra al libro.** Lo que queda abierto es otra cosa: qué llave liga un `U-A-5` con **los cierres que lo componen**, para mostrar procedencia | Deja de bloquear el Frente B; pasa a ser mejora de la pantalla |
| H3 | Catálogo de proveedores que cobran en efectivo | Bloquea el Frente C |
| H4 | Si las jornadas 14/15/16-oct se pueden cerrar desde la pantalla | `CGP` §V3 dice que **no**: la pantalla siempre abre con `todayMx()` |
| H5 | Si el Frente A/B corrige el esperado negativo de CC-2026-00002 | Es la prueba de que el frente sirvió |
| ~~H6~~ | ~~Qué pasa con los 11,318 movimientos fuera de ventana~~ | ✅ **RESUELTO por Edgar el 2026-10-16: el libro arranca el 10-oct.** Lo anterior «ya debería estar conciliado» en Control y queda fuera de alcance — 13,206 movimientos, $162,080,748.92 |
| H7 | **Dónde queda `CGP-VEC.1`** ahora que §3.5 lo saca de Caja General | Es código vivo en `main` sin destino. O se le da uno (`CSU`, cortes de sucursal) o se declara como deuda con nombre (ADR-056: un primitivo huérfano no cierra la fase) |
| H8 | Si el `U-A-5` trae algo que apunte al cierre que lo originó | Decide si la procedencia vecinal se puede derivar o hay que declararla «no medida» |
| **H9** | ⛔⛔ **POR QUÉ KEPLER DEJÓ DE REGISTRAR DEPÓSITOS `U-A-5` EL 12-OCT** (§2.5.4). De ~90–115/semana a **3**, con el feed sano y las salidas normales | **Es lo más urgente de la lista y no se arregla con código.** Si el registro del ingreso no vuelve, la bandeja se vacía sola y se lee como «ya no hay trabajo». **Se pregunta en operación, hoy** |

---

## 6. Qué sigue

1. Cerrar **H1, H2 y H3** — son mediciones, no código, y los tres bloquean su frente.
2. Con eso, el plan de implementación por fases, en las 4 capas de
   [`METODO_DE_TRABAJO.md`](../../METODO_DE_TRABAJO.md) (C0 dato → C1 dominio → C2 API → C3 UI),
   con la regla de que **ninguna fase sube de capa sin la evidencia de la de abajo**.
3. ⛔ Nada de esto abre una fase nueva en el roadmap sin autorización: rige la **campaña de
   aterrizaje** (§7 del método) y el tope de **4 fases 🔨 a la vez**.

---

## Apéndice — cómo reproducir cada cifra

Lector de sólo lectura usado en esta medición (scratchpad de la sesión, no versionado):

```js
// q.js — SET default_transaction_read_only = on antes de cada consulta
const c = new Client({ connectionString: process.env.PROD_DB_URL });
```

Toda consulta abre con:

```sql
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-00000000d01c', false);
```

sin lo cual `finance.v_caja_movimientos_pendientes` y `finance.v_caja_cobertura` devuelven **cero
filas** — y cero filas sin tenant fijado se lee igual que «no hay pendientes», que es lo contrario.
