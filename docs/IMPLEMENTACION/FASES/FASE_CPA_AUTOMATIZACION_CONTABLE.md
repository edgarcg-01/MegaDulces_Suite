# FASE CPA — Qué se automatiza teniendo las pólizas de ContPAQi

> Esto es el **`§8` que [`FASE_CP8`](FASE_CP8_PUENTE_CONTPAQI.md) dejó pendiente a propósito**
> (*"una vez terminado el puente generamos un plan de implementación con todo lo que se pueda
> hacer teniendo esta conexión"*, pedido de Edgar). Se escribe ahora porque la **vuelta ya es un
> hecho medible**, no un supuesto: el carril corre y la tabla está llena.
>
> **Todo lo de abajo está medido contra PROD** (`system_identifier 7688376744939610156`,
> `192.168.0.222:5434`) el **2026-10-10 ~09:30**, en lectura. Ninguna cifra es estimada.

---

## 1. Lo que de verdad tenemos (medido, no declarado)

| | Medido |
|---|---|
| `analytics.gl_polizas` | **130,134 pólizas** · 2025-01-01 → 2026-10-31 |
| `analytics.gl_poliza_lines` | **557,251 renglones** |
| De ContPAQi | 19,418 pólizas · **249,677 renglones** |
| De Kepler | 110,716 pólizas · 306,091 renglones |
| Frescura | último `computed_at` **hoy 09:20**; `feed_contpaqi` `ok` 09:25, `contpaqi_add_cfdis` `ok` 09:23 |
| `fiscal.cfdis` | **428,626** CFDIs · 407,183 asociados · **21,249 sin asociar** |

⭐ **El canal del token está libre:** `concepto` viene lleno en **16 de 557,251** renglones
(0.003 %) y `referencia` en casi ninguno. Lo que `[CP.8]` §1 supuso — que hay 100 caracteres
disponibles para correlacionar — **es cierto y está medido**.

---

## 2. ⭐⭐ El hallazgo que reencuadra todo: no hay que INVENTAR asientos

**Kepler ya contabiliza.** En septiembre-2026 produjo **15,802 pólizas / 45,783 renglones** con su
propio catálogo (`115` clientes, `102` bancos, `201` proveedores, `401-*` ventas, `511` compras,
`611-003` comisiones, `515-*` traspasos). En el mismo mes, ContPAQi recibió **901 pólizas /
11,231 renglones**.

> **O sea: la contadora está retecleando, resumida, contabilidad que Kepler ya hizo — y que
> nosotros ya tenemos del lado de acá, al documento.**

Eso cambia el problema. No es *"armar un asiento desde un evento"* (difícil, opinable); es
**traducir** un asiento que ya existe, de un catálogo grueso a uno fino:

| | Kepler | ContPAQi |
|---|---|---|
| Bancos | `102` — **una sola cuenta** | `1020260000 BBVA BANCOMER 0489962182` — **una por cuenta** |
| Clientes | `115` | `1030180001 CLIENTES 0% YURECUARO` — por sucursal y por tasa |
| Proveedores | `201` | `2120000366 CANAP BOLSAS` — uno por tercero |

Y **el diccionario ya está a medio construir, sin pedirle nada a nadie**:

- `finance.bank_accounts.contpaqi_cuenta` → **18 de 20 cuentas** mapeadas (`[CP.2]`).
- `contpaqi.supplier_accounts` → **362 `confirmado` + 59 `uuid_solido`** (`[CP.8.20]`, derivado
  por UUID contra `AsocCFDIs`, estructural).
- `analytics.contpaqi_accounts` → **8,811 cuentas** con su nombre, consultables.
- `finance.kepler_accounts` → 181 cuentas del lado Kepler.

---

## 3. El inventario de lo que se captura a mano, por familia

Clasificado por el texto del `concepto` de la póliza, **jul–sep 2026** (3 meses cerrados).
⚠️ Es una heurística de texto; `otros` (4.0 %) es lo que no clasifica y **se declara, no se
reparte**.

| Familia | Pólizas | Renglones | % renglones | Cargos | ¿Tenemos la fuente? |
|---|---:|---:|---:|---:|---|
| Ventas mensual × sucursal (`VENTAS <suc>`) | 33 | **10,192** | 27.7 % | $129.6 M | ✅ CB + CC + sell-out |
| Pago de gasto (`PAGO …`) | 1,125 | **8,165** | 22.2 % | $173.1 M | ✅ `erp_supplier_payments` + `bank_movements` |
| Venta diaria × sucursal (`VTA dd/mm Suc NN`) | 984 | **7,960** | 21.6 % | $146.2 M | ✅ sell-out + cortes (CSU) |
| **Comisiones bancarias** | 43 | **4,596** | 12.5 % | $1.15 M | ✅ `finance.bank_movements` |
| Nómina (`NOM nn …`) | 401 | 2,118 | 5.7 % | $13.0 M | ⛔ **Fase RH** (Mega Talento) |
| Otros / sin clasificar | 87 | 1,475 | 4.0 % | $15.9 M | ⚠️ por revisar |
| Libro de compras | 2 | 1,222 | 3.3 % | $74.7 M | ✅ **Fase LC, ya construida** |
| Traspasos entre cuentas | 50 | 1,106 | 3.0 % | $79.0 M | ✅ CB (ya valida TI = TE) |
| Cheque cancelado | 44 | 0 | — | — | (no es trabajo) |
| **Total** | **2,769** | **36,834** | | | |

→ **~923 pólizas y ~12,278 renglones al mes.**

⭐⭐ **El 90.2 % de esos renglones (33,241 de 36,834) tiene su fuente YA cargada en nuestra base,
y a grano más fino que el que ella captura.** Lo que no: nómina (5.7 %, depende de Fase RH) y
`otros` (4.0 %).

### 3.1 Dos cosas que sólo se ven abriendo los renglones

**(a) `VENTAS <sucursal>` no es una póliza de ventas: es de COBRANZA.** Abierta
`VENTAS YURECUARO` de sep: **66 cargos a `1020260000` (un renglón por depósito)** contra 30
abonos a `CLIENTES 0%`, 30 a `CLIENTES C/IVA` y 30 a `IEPS DE CLIENTES` — o sea **un renglón por
día por tasa**. Las dos piernas las tenemos: los depósitos en `finance.bank_movements` y
`analytics.erp_collections`; el desglose por tasa, en el propio renglón de Kepler.

**(b) Las comisiones bancarias son el peor negocio de todos:** **4,596 renglones por $1.15 M**
— la familia con más tecleo por peso de todo el libro, y la que sale entera de una columna que CB
ya clasifica. Una sola póliza (`COMISIONES BBVA 4176`, sep) trae **425 renglones**.

---

## 4. ⛔ Lo que está parado HOY, y se ve sólo porque tenemos las pólizas

| | Medido el 2026-10-10 |
|---|---|
| ⛔ **Septiembre-2026 NO tiene póliza de compras.** | Los 4 aciertos de `%COMPRAS%` en sep son `NOM 38 COMPRAS` (nómina del área). El libro de jul ($33.8 M, 607 renglones) y ago ($40.9 M, 633) **sí existen** |
| ⚠️ Esto **corrige a [`FASE_LC`](FASE_LC_LIBRO_DE_COMPRAS.md)** | El doc dice *"jul y ago-2026 no tienen hoja → no existe la póliza"*. Ya no es cierto: se pusieron al día. El hueco vivo es **septiembre**, y la Fase LC ya tiene el módulo para emitirlo |
| ⛔ **La asociación de CFDI se está atrasando** | CFDIs **recibidas** sin asociar: may 154/$3.5 M · jun 129/$3.7 M · jul 294/$10.1 M · ago 419/$22.6 M · **sep 562/$30.2 M** · oct 360/$19.0 M. En todo 2026: **2,543 por $106,654,164** |
| ⚠️ *(corregido)* | Una primera cuenta mezcló `recibidas` **y** `emitidas` y daba 618 en sep. Son dos universos: las emitidas sin asociar son 1,065/$13.5 M y es **otro problema**. Los números de arriba son sólo recibidas |
| ❓ Hipótesis, no afirmación | El rezago de asociación de sep ($30.2 M) y la póliza de compras ausente de sep son, en monto, **el mismo hueco**. Es coherente —sin póliza no hay a qué asociar— pero no está probado |
| ⚠️ `contpaqi.poliza_exports` | **0 filas.** Nunca se ha entregado nada. El puente está escrito y no estrenado |
| ⚠️ `contpaqi.account_rules` | 21 filas, **ninguna utilizable** (2 `derivada`, las dos `no_aplica`) |
| ⚠️ Basura de fechas en CB | `finance.bank_movements` tiene 6 movimientos fechados **`0206-02`** y 17 en **`2027-08`**. Nadie los ve |

---

## 5. Las tres cosas que se pueden automatizar, en orden de lo que cuestan

### A — Sin emitir NADA (riesgo cero, sólo lectura, se puede hacer ya)

El dato ya está de los dos lados; lo único que falta es **comparar y publicar**.

1. **Semáforo de cierre contable** — una pantalla que diga, por mes × familia, *qué ya está
   asentado y qué no*. Hoy nadie tiene eso: el hueco de septiembre se encontró con una consulta,
   no con un tablero. Fuente: `gl_polizas` contra el calendario de familias de §3.
2. **Cuadre Kepler ↔ ContPAQi por renglón** — `201` contra `2120*`, `102` contra `1020*`,
   `401-*` contra `401/403`, usando los diccionarios de §2. Lo que no case es, literalmente, la
   lista de pendientes de la contadora.
3. **Detector de rezago de asociación de CFDI** — ya hay señal (`fiscal.cfdis.aso_contabilidad`)
   y ya hay bandeja (`finance.findings`, Maat). Falta la regla.

⭐ Estas tres **no dependen del contador, ni del SDK, ni de que ContPAQi acepte un archivo**.

### B — Emitiendo el TXT (la ida), por orden de rendimiento

El orden correcto **no** es por monto: es por *renglones tecleados ÷ dificultad del mapa*.

| Orden | Familia | Renglones/mes | Por qué va ahí |
|---|---|---:|---|
| 1 | **Comisiones bancarias** | ~1,532 | Mapa **ya resuelto** (18/20 cuentas), una cuenta de gasto, importe chico → si sale mal, el daño es mínimo. **Es el ensayo ideal** |
| 2 | **Libro de compras** | ~410 | El módulo **ya está construido y probado** (LC.9–LC.16, 4 puertas anti-duplicado). Y hay un mes pendiente |
| 3 | **Traspasos entre cuentas** | ~369 | Las dos piernas son cuentas de banco mapeadas; CB ya valida que cuadre |
| 4 | **Pago de gasto** | ~2,722 | `poliza-egreso.ts` ya existe. Depende de las **reglas por categoría** (§6) |
| 5 | **Cobranza + venta diaria** | ~6,050 | El más grande, y el que más mapa necesita (cuentas por sucursal × tasa) |

### C — Lo que no depende de nosotros

- **Nómina** (~706 renglones/mes): Fase RH / Mega Talento. Hasta que exista, se declara.
- **`otros`** (~492/mes): hay que abrirlo antes de prometer nada.

---

## 6. Los tres candados, y cuál es de verdad

1. ⛔ **Nunca se ha importado un TXT nuestro.** El formato ya está validado contra una
   exportación real y contra el propio esquema de ContPAQi (`[CP.8.26]`/`[CP.8.28]`), pero *que
   el token vuelva* sigue siendo una **hipótesis con mecanismo**, no un hecho. **Se cierra con un
   clic de la contadora** sobre los dos archivos de prueba de `[CP.8.24]`
   ([runbook](../RUNBOOKS/CONTPAQI_PRUEBA_IMPORTACION.md)). **Es el único candado que bloquea a
   los cinco renglones de §5-B, y no cuesta código.**
2. ⚠️ **El mapa firmado (E3).** Pero **sólo lo necesitan las familias 4 y 5**: bancos y
   proveedores ya están derivados, y las cuentas de ventas/clientes por sucursal se pueden
   proponer desde `contpaqi_accounts` para que ella sólo confirme.
3. ⛔ **La regla de oro no se toca:** ADR-040 — ContPAQi es el SoR, **no le escribimos a la base**,
   y **el motor arma, la contadora decide**. Nada de esto cierra un libro solo.

---

## 7. Lo que recomiendo hacer, y en qué orden

1. **Pedir el clic** (archivos A y B de `[CP.8.24]` + la bitácora `.xls`). Sin eso, §5-B entero
   es teoría. Cuesta minutos de una persona.
2. **Construir §5-A mientras tanto** — rinde solo, no espera a nadie, y el semáforo de cierre es
   lo que habría gritado el hueco de septiembre.
3. **Estrenar la ida con comisiones bancarias**, no con lo grande.
4. **Emitir el libro de compras de septiembre** con el módulo que ya existe.
5. Recién entonces, el mapa de ventas/clientes con la contadora.

### Definición de TERMINADO (hereda `[CP.8]` §5, ADR-056)

Una familia está automatizada cuando, **medido**: el evento recorre `armada → entregada →
aplicada` **sin que nadie teclee el resultado**; reenviarla **no duplica** (probado a propósito);
un asiento descuadrado **se rechaza** (probado a propósito); y lo que no se pudo verificar sale
como `no verificado` **con motivo**, nunca como `aplicada`.

⛔ **No cuenta como terminado:** *"el TXT se generó"*.

---

## 8. Barrido por área operativa (lo que §1–§7 NO cubría)

⚠️ Lo anterior mide **la carga de trabajo del contador**. Esta sección contesta la otra mitad:
*¿qué le sirve a cada área tener las pólizas?* Medido sobre el catálogo completo (8,811 cuentas)
y la balanza 2026.

### 8.1 ⛔⛔ El hallazgo que define el límite: la contabilidad NO lleva inventario

Buscadas las palabras `INVENTARIO`, `MERCANC`, `ALMACEN` y `COSTO` en las 8,811 cuentas: los
**únicos dos aciertos son un proveedor** llamado `ALMACENADORA Y MAQUILA`. No hay cuenta de
inventarios, no hay costo de ventas, y el activo fijo entero de 2026 es **una** cuenta
(`1290000000 EQUIPO DE REPARTO`, $409,828).

> **Se lleva por método analítico: compras por proveedor (`5010`/`5020`/`5050`…), no COGS.**

Consecuencias, que conviene decir antes de que alguien las prometa:

- ⛔ **Almacén / Inventario no tiene — ni va a tener — árbitro contable.** El descuadre de
  [`FASE_IC`](FASE_IC_INVENTARIO_CONTINUO.md) ($6.6 M) y el margen de
  [`FASE_MR`](FASE_MR_MOTOR_RENTABILIDAD.md) **no se pueden cuadrar contra libros**. No es un
  hueco que se llene: es una propiedad del método contable.
- ⛔ **Logística tampoco.** Los costos de flota viven revueltos en `5200` (gastos, 107 cuentas);
  la contabilidad **no segmenta por vehículo ni por guía**. El valor de flota sigue sin testigo fiscal.
- ⭐ Y explica el *gap fiscal-vs-operación* de `[CP.4]`: no es un error, es que miden cosas
  distintas.

### 8.2 Dónde SÍ hay valor, por área

| Área | Qué traen las pólizas (medido 2026) | Qué habilita, que hoy no existe |
|---|---|---|
| **Compras / CxP** | `2120` **158 cuentas de proveedor**, $590 M · compras por tercero `5010`+`5020`+`5050`… $362 M | **Árbitro de la deuda por tercero.** [`FASE_ECA`](FASE_ECA_ESTADO_CUENTA_ACREEDORES.md) ya chocó Kepler $138.8 M vs ContPAQi $79.4 M **sin poder arbitrarlo**: el mapa de `[CP.8.20]` lo vuelve comparable proveedor por proveedor |
| **Ventas** | `4010` 0% + `4030` c/IVA — **24 cuentas con movimiento, por sucursal × canal × tasa**. Sep-2026: **$43,332,893** | El **único testigo fiscal** del sell-out, y al grano que importa (SUC / TLMKT / RUTA). ⚠️ `RUTA 23` reporta **$12,452 en el mes**: o la venta en ruta casi no se factura, o no está donde creemos |
| **Cobranza / CxC** | `103*` clientes por sucursal y tasa: saldo al cierre de sep **$27.4 M** | ⚠️ Nuestra cartera viva dice **$64.7 M** (1,388 clientes, medido hoy 09:38). **2.4× de diferencia, sin arbitrar.** No afirmo cuál está bien — afirmo que nadie lo está mirando |
| **Finanzas / Tesorería** | `1020` 18 bancos, $1,395 M, 45,151 renglones · `2140` créditos 21 ctas $119.8 M · `5500` intereses $2.8 M | Ya cubierto por CB/ECA. El aporte nuevo es la **deuda bancaria**, que sólo vive aquí |
| **Fiscal** | `1060` IVA acreditable $15.1 M · `2160` IVA trasladado $16.1 M · `2190` IEPS $22.6 M · `1470` retenciones $69.1 M | Cuadre de IVA/IEPS contra lo que el CFDI declara — [`FASE_LC`](FASE_LC_LIBRO_DE_COMPRAS.md) ya encontró $69,587.97 de IEPS por cuota mal capturado |
| **RH / Nómina** | `2150` sueldos por pagar **13 cuentas por sucursal**, $32.9 M · `2110` retenciones · 2 % sobre nómina en `5200` | Costo laboral por sucursal, que hoy no existe en la Suite. Depende de [`FASE_RH`](FASE_RH_MIGRACION_MEGA_TALENTO.md) |
| **Almacén / Inventario** | ⛔ **nada** (§8.1) | — |
| **Logística** | ⛔ casi nada (§8.1) | — |

### 8.3 ⛔⛔ Y al barrer por área apareció el costo real del mes que falta

El hueco de septiembre (§4) no es un trámite atrasado. Medido en la balanza:

| Mes | Pagos a proveedor (`2120` cargos) | Compras (`2120` abonos) | Saldo fin |
|---|---:|---:|---:|
| 2026-07 | $33.6 M | $33.8 M | $95.5 M |
| 2026-08 | $30.5 M | $40.9 M | $109.9 M |
| **2026-09** | **$30.3 M** | **$0** | **$51.7 M** |

> **En septiembre se pagaron $30.3 M a proveedores y se registraron CERO compras.** El pasivo
> cayó $58.2 M sin que nadie comprara menos, y `501`–`508` bajó de $45.9 M a $10.9 M.

⭐ **O sea: el balance de septiembre está mal por ~$40 M de pasivo y ~$35 M de costo**, y la causa
es exactamente la póliza que el módulo de [`FASE_LC`](FASE_LC_LIBRO_DE_COMPRAS.md) ya sabe
generar. **Ése es el caso de negocio de §5-A punto 1** — un semáforo de cierre lo habría gritado
el 1 de octubre; se encontró el 10, y por casualidad.

---

## ⭐ PLAN DE IMPLEMENTACIÓN

> **ADR-088 propuesto.** *La contabilidad no se construye: se TRADUCE. Kepler ya asienta cada
> documento; ContPAQi es el SoR fiscal; la Suite traduce de un catálogo al otro, y lo que no
> tiene mapa se DECLARA, nunca se arma con una cuenta inventada.* Hereda ADR-040 (nunca
> escribimos a la base de ContPAQi) y ADR-056 (lo que no se pudo medir se declara).

## 9. Lo que YA existe y no se vuelve a construir

⭐ Medido en el repo antes de planear nada. **Casi todo el puente está escrito; lo que falta es
estrenarlo.**

| Pieza | Dónde | Estado |
|---|---|---|
| Armador de egreso (puro, 33 ✓) | `libs/finance/.../contpaqi/poliza-egreso.ts` | ✅ |
| Armador por lote + servicio | `contpaqi-armado.service.ts` | ✅ (hoy **rechaza todo**, con motivo) |
| Motor del cuadre (token vs importe, 35 ✓) | `contpaqi/cuadre.engine.ts` + `contpaqi-cuadre.service.ts` | ✅ |
| Sink de archivo (42 ✓, devuelve `entregada`, nunca `aplicada`) | `txt-sink.adapter.ts` | ✅ |
| Emisor del TXT + renglones `AD` (UUID) | `purchase-book/poliza-txt.ts` | ✅ validado byte a byte |
| Bandeja del puente (API + pantalla) | `contpaqi-bridge.controller.ts` · `/contabilidad/contpaqi-puente` | ✅ en prod |
| Permisos `FISCAL_CONTPAQI_BRIDGE_VER/_GESTIONAR` | | ✅ **ya repartidos** |
| Módulo completo del Libro de Compras (20 endpoints, 4 puertas anti-duplicado) | `libs/finance/.../purchase-book/` | ✅ |
| Diccionarios | `bank_accounts.contpaqi_cuenta` 18/20 · `supplier_accounts` 421 · `contpaqi_accounts` 8,811 | ✅ |
| Carriles de vuelta (@1 min, @2 h) | `ops/vl/crontab.feeds` | 🟢 corriendo |

⛔ **Y lo que NO existe, medido:** `contpaqi.poliza_exports` **0 filas** · `account_rules`
**0 utilizables** · `finance.purchase_book_runs` **3 corridas, ninguna `entregada`**.

> ⛔⛔ **Corrección que cambia la ruta crítica:** yo había supuesto que el TXT del libro de
> compras *"ya se entrega a mano"*. **Es falso.** Las 3 corridas del módulo están en `generado` o
> `borrador`, ninguna `entregada`, y no hay corrida de ago ni de sep. El TXT que la contadora sí
> usa sale de **su Excel**, no de nosotros. → `[CPA.3]` (el clic) **también bloquea al libro de
> compras**, no sólo a los egresos.

---

## 10. Los sprints

Estados: ⬜ TODO · 🔨 EN CÓDIGO · 🧪 PROBADO · 🚀 PROD · ✅ CERRADO.

### Bloque A — rinde sin depender de nadie (sólo lectura, riesgo cero)

#### `[CPA.0]` Semáforo de cierre contable 🔨 EN CÓDIGO 2026-10-10
**Por qué primero:** es lo único que habría gritado el hueco de septiembre el día 1. No espera al
contador, ni al SDK, ni a que ContPAQi acepte nada.

> **Entregado (sin aplicar a prod):** vista `analytics.v_contpaqi_cierre_mensual`
> (mig `20261010100305`) · umbrales en `analytics.kpi_thresholds` (mig `20261010101128`) ·
> índice cubriente de `fiscal.cfdis` (mig `20261010101129`, **fuera de horario**) ·
> `ContpaqiCierreService` + `GET /contabilidad/contpaqi/cierre` · pantalla `/contabilidad/cierre`
> con su pestaña y su nodo en el árbol · candado `test-newdb-contpaqi-cierre.js` en la regresión.
>
> **Medido contra prod hoy:** la vista da **110 filas** (22 meses × 5 familias); la forma
> optimizada contra la directa, **0 diferencias** y de 1,150 ms a **938 ms**; el candado corre
> **4 ✔ · 0 ✘ · 7 ◻ NO MEDIDO** (los 7 son lo que no se puede medir hasta aplicar las
> migraciones — se declaran, no se dan por buenos).
>
> ⚠️ **Falta:** aplicar las 3 migraciones en `md` (una por una, `apply-one-migration-prod.js`
> dentro de `prod-api`; la del índice **fuera de horario**) · redeploy api+view · validación
> visual. **Sin permiso nuevo → sin re-login.**

- Vista `analytics.v_contpaqi_cierre_mensual` — **derivada** de `gl_polizas` +
  `contpaqi_ledger_monthly` (`derive-no-copy`, sin importer). Grano: `(anio_mes × familia)` con
  las 9 familias de §3.
- **CINCO estados, no tres** (ADR-056): `asentado` · `parcial` · `ausente` · `sin_medir` ·
  `no_aplica`. ⛔ Un mes sin medición **no sale verde**.
- Detector duro, ya medido: familia compras = `2120` con `cargos > 0` **y** `abonos = 0` →
  `ausente`. Reproduce jul/ago `asentado` y sep `ausente` sin tocar un parámetro.
- Pantalla: pestaña **Cierre** en `/contabilidad` (`contabilidad-tabs.ts`), permiso
  `FISCAL_CONTAB_VER` — **ya repartido, sin migración de permisos, sin re-login**.
- **Candado** `test-newdb-contpaqi-cierre.js`: jul/ago `asentado`, sep `ausente`, y **mutación a
  rojo** apagando el detector (si sep sale verde, el test falla).
- ⚠️ No lleva latido propio: es una vista. La frescura la declara `feed_contpaqi` vía
  `cron_runs`, y **se publica en pantalla** (si el carril está caído, el semáforo lo dice).

#### `[CPA.1]` Cuadre Kepler ↔ ContPAQi por rubro ⬜
- Vista `analytics.v_gl_cuadre_mensual`: `201`↔`2120*` · `102`↔`1020*` · `401-*`↔`401/403` ·
  `511`↔`501/502/505…`, usando los diccionarios de §2.
- Cada fila publica **`cobertura_mapa`** junto al número. ⛔ Lo que no tiene mapa sale
  `no_comparable` **con motivo**, nunca cero (`[CE.8]`: declarar «no se puede medir» lo que sí se
  puede es la falla simétrica de dibujar un cero).
- **Prueba negativa:** quitarle una cuenta al crosswalk tiene que mover la cobertura y marcar esa
  fila, no cambiar el total en silencio.

#### `[CPA.2]` Arbitrar la cartera: $27.4 M vs $64.7 M ⬜
- **No es construir: es medir y declarar.** Comparar `103*` por sucursal contra
  `analytics.customer_receivables` agregado por sucursal, con las diferencias **nombradas**
  (corte distinto, clientes de contado, documentos no facturados, septiembre incompleto).
- ⭐ Entregable válido: *"la contabilidad está bien y nuestra cartera infla"*. Lo que no es válido
  es publicar los dos números sin decir cuál manda.
- Hereda la regla de [`VERDAD_ABSOLUTA`](../../VERDAD_ABSOLUTA.md): el hueco se declara con
  **nombre y monto**.

### Bloque B — la dependencia humana (cero código)

#### `[CPA.3]` El clic ⬜ ⛔⛔ RUTA CRÍTICA DE TODO EL BLOQUE C
- Archivos **A** y **B** de `[CP.8.24]` (`database/scripts/generar-prueba-contpaqi.js`), importar
  con **`Cargar sin Afectar`** marcado, y guardar la **bitácora `.xls`** que ContPAQi escribe
  sola. Hoja: [`CONTPAQI_PRUEBA_IMPORTACION`](../RUNBOOKS/CONTPAQI_PRUEBA_IMPORTACION.md).
- **Qué contesta:** si el `SEP` del layout es el correcto, y si el token vuelve por el carril
  @1 min. Hoy las dos son **hipótesis con mecanismo**, no hechos.
- Cuesta minutos de una persona y **no cuesta código**.

#### `[CPA.4]` El mapa firmado (media hora del contador) ⬜
- Sólo lo necesitan **gasto** (`[CPA.8]`) y **ventas/clientes** (`[CPA.9]`). Bancos y proveedores
  ya están derivados.
- La Suite **propone** desde `contpaqi_accounts` (8,811) y el contador **confirma**; no se le pide
  que escriba de cero.
- Entregable: filas en `contpaqi.account_rules` con `estado='aprobada'` y `aprobada_por` lleno.

### Bloque C — la ida, en orden de rendimiento (renglones ÷ dificultad del mapa)

#### `[CPA.5]` Septiembre: el libro de compras que falta ⬜ 🔥 mayor valor inmediato
- **Usar el módulo que ya existe** (`POST /finance/purchase-book/:mes/generar` + `/archivo`), no
  construir nada.
- ⚠️ **El riesgo real es duplicar:** `2120` de sep ya trae $30.3 M de pagos asentados. Las cuatro
  puertas de `[LC.14]`/`[LC.15]` (UUID exacto, importe, `concepto`, CSV del asociador) existen
  justo para esto y **bloquean sin override** en la puerta exacta.
- **Terminado medible:** la balanza de sep pasa de `abonos 2120 = $0` a ~$35–40 M, y el saldo fin
  de $51.7 M a ~$110 M. ⛔ No cuenta *"el TXT se generó"*.
- Depende de `[CPA.3]` sólo para la **verificación**; el archivo se puede preparar antes.

#### `[CPA.6]` Comisiones bancarias — el ensayo de la ida automática ⬜
- ~**1,532 renglones/mes por $383 K/mes**: la familia con más tecleo por peso del libro entero, y
  la de mapa ya resuelto (18/20 cuentas). **Si sale mal, el daño es mínimo** — por eso va primero
  y no lo grande.
- Una póliza por `(cuenta de banco × mes)`, token en `concepto`, el cuadre la asciende sola.
- **Candados obligatorios, con prueba negativa cada uno:** reenviar el mismo evento **no
  duplica** · un asiento descuadrado **se rechaza** · un token que no vuelve queda
  `no_verificado` **con motivo**, jamás `aplicada`.

#### `[CPA.7]` Traspasos entre cuentas ⬜
~369 renglones/mes. Las dos piernas son cuentas de banco ya mapeadas y **CB ya valida TI = TE**,
o sea que el asiento se comprueba contra un invariante que ya existe.

#### `[CPA.8]` Pago de gasto ⬜ *(depende de `[CPA.4]`)*
~2,722 renglones/mes. `poliza-egreso.ts` y el armado por lote ya están; el IVA sale del **hermano
en el banco** (76.8 %, placebo 0.1 %) y el 23.2 % restante se arma con IVA 0 **y motivo escrito**.

#### `[CPA.9]` Cobranza + venta diaria por sucursal ⬜ *(depende de `[CPA.4]`)*
~6,050 renglones/mes — el más grande y el de mapa más caro (cuenta por sucursal × canal × tasa).
Va **al final** a propósito: para cuando llegue, los cuatro anteriores ya probaron el camino.

### Bloque D — lo que se declara y NO se promete

| | Motivo |
|---|---|
| **Nómina** (~706 renglones/mes) | Depende de [`FASE_RH`](FASE_RH_MIGRACION_MEGA_TALENTO.md). Hasta entonces el semáforo la marca `no_aplica`, no `ausente` |
| **Almacén / Inventario** | §8.1 — la contabilidad **no lleva inventario ni COGS**. No hay árbitro y no lo va a haber |
| **Logística / flota** | §8.1 — `5200` no segmenta por vehículo ni por guía |
| **`otros`** (~492 renglones/mes) | Hay que **abrirlo y medirlo** antes de prometer nada |

---

## 11. Ruta crítica

```text
[CPA.0] semáforo ─┐
[CPA.1] cuadre    ├─► rinden solos, HOY, sin depender de nadie
[CPA.2] cartera  ─┘

[CPA.3] EL CLIC ──┬─► [CPA.5] libro de sep ──► [CPA.6] comisiones ──► [CPA.7] traspasos
                  │
[CPA.4] el mapa ──┴─────────────────────────► [CPA.8] gasto ──► [CPA.9] cobranza+venta
```

⭐ **Las dos dependencias humanas son independientes entre sí**: el clic no espera al mapa, y el
mapa no espera al clic. Lo único que bloquea a todo el bloque C es el clic, y **no cuesta código**.

---

## 12. Definición de TERMINADO (hereda `[CP.8]` §5, ADR-056)

Por familia, y **medido contra prod**:

1. El evento recorre `armada → entregada → aplicada` **sin que nadie teclee el resultado**.
2. `poliza_exports.verificada = true` en ≥ 95 % de los eventos entregados del último mes cerrado,
   y **el resto con motivo escrito** — ninguno en `NULL` pasado el plazo.
3. El latido reporta **eventos sincronizados**, con umbral en `CRON_JOBS`, y **se probó en rojo**.
4. Reenviar el mismo evento **no duplica** — verificado a propósito, no por construcción.
5. Un asiento descuadrado **es rechazado**, probado mandándolo a propósito.

⛔ **No cuentan como terminado:** *"el TXT se generó"*, *"la migración se aplicó"*, *"la pantalla
abre"*.

---

## 13. Riesgos y decisiones abiertas

| | | Mitigación / dueño |
|---|---|---|
| ⛔⛔ | **La bandeja de hallazgos no se lee.** Medido: `finance.findings` tiene **157,184 en `nuevo`** y **172 `descartado`** — y `ppd_sin_rep` sola son 149,482. Meter ahí un detector más es escribir en una pared | Por eso `[CPA.0]`–`[CPA.2]` publican en **pantalla propia**, no en `findings`. Que la bandeja tenga dueño es **otra fase** |
| ⛔ | El `SEP` del TXT y el regreso del token siguen sin probarse | `[CPA.3]` |
| ⚠️ | El contador **edita el concepto** al revisar → el token se pierde | Cae a `no_verificado` **con motivo**, nunca a `aplicada` falsa. Y se mide |
| ⚠️ | Septiembre lleva $30.3 M de pagos asentados: el libro puede **duplicar** | Las 4 puertas de `[LC.14]`/`[LC.15]`; la exacta **bloquea sin override** |
| ⚠️ | Basura de fechas en CB (`0206-02`, `2027-08`) entra al asiento | Validación de rango en el armador, **declarada**, no corregida en silencio |
| ❓ | **¿Quién es el dueño del semáforo?** Sin dueño, un tablero rojo no mueve a nadie | Decisión de Dirección/Finanzas |
| ❓ | ¿`RUTA 23` factura $12,452/mes de verdad, o la venta en ruta está en otra cuenta? | Sondeo dentro de `[CPA.1]` |
| ⛔ | ADR-040 intacto: **no escribimos a la base de ContPAQi**, y **el motor arma, el contador decide** | No negociable |

---

## 14. Orden sugerido de ejecución

1. **Pedir el clic hoy** (`[CPA.3]`) — es lo único que tarda por calendario ajeno.
2. **`[CPA.0]` en paralelo** — rinde sin esperar a nadie y es el que convierte "se nos pasó
   septiembre" en algo que no vuelve a pasar.
3. **`[CPA.5]`** en cuanto el clic conteste: septiembre es dinero mal declarado **hoy**.
4. **`[CPA.6]`** como ensayo de la ida automática.
5. `[CPA.1]` / `[CPA.2]` cuando haya hueco — rinden solos, no bloquean a nadie.
6. `[CPA.4]` → `[CPA.7]` → `[CPA.8]` → `[CPA.9]`.
