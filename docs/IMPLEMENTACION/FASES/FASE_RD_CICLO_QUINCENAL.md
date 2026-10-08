# Fase RD — El ciclo quincenal de Ruta Directa (RD.27 … RD.36)

> **Estado**: 🔨 PLANEADA 2026-10-07 — ADR-088 propuesto. Sin código salvo lo que RD.17–RD.20
> dejó escrito y **sin correr** (ver §7) y lo que **RD.22** cambió ese mismo día: se retiraron
> los dos crons y la corrida pasó a ser un valor congelado que se escribe una vez (ver §6bis).
>
> **Qué es**: retirar `INDICADORES RD 2026.xlsx` como *herramienta de trabajo*, no como fórmula.
> Las fases anteriores copiaron el **cálculo**; ésta se ocupa del **proceso**: qué hace una
> persona, cuántas veces, y qué de eso no debería estar haciendo.
>
> Hermanas: [`FASE_RD_INDICADORES_RUTA`](FASE_RD_INDICADORES_RUTA.md) (decode del libro y motor
> de comisiones) · [`FASE_RD_INVENTARIO_RUTA`](FASE_RD_INVENTARIO_RUTA.md) (el ledger del camión).

---

## 1. Lo que se midió del archivo, no de la memoria

Medido el 2026-10-07 con `exceljs` sobre el workbook real (1.7 MB, 11 hojas):

| Hoja | Tecleadas | Fórmulas | % manual | Forma dominante |
|---|---:|---:|---:|---|
| CONCENTRADO DE INFORMACIÓN | **14,331** | 828 | **94.5%** | ref directa, SUM |
| CONTROL DE GASTOS RD | 7,369 | 1,767 | 80.7% | IF 1,609 |
| FORMATO DE PAGO | 5,333 | **15,397** | 25.7% | SUMIFS 14,820 |
| OPERACION DE LAS RUTAS | 4,383 | 1,505 | 74.4% | IF 882 · SUMIFS 568 |
| COMISIONES | 3,461 | 1,248 | 73.5% | SUMIFS 1,053 |
| RESUMEN DE OPERACION DE RUTAS | 2,352 | 2,805 | 45.6% | SUMIFS 2,386 |
| HOJA DE LLENADO OBJETIVO MENSUA | 1,471 | 394 | 78.9% | IF 268 |
| COSTO RD PH / CANINDO | 2,807 | 833 | 77.1% | SUM |
| FORMATO DE SUPERVISOR | 342 | 160 | 68.1% | IF 136 |
| OBJETIVO MENSUAL RD | 295 | 373 | 44.2% | IF 327 · INDEX 34 |
| **TOTAL** | **42,144** | **25,310** | **62.5%** | |

⭐ **El trabajo no es calcular: es teclear 42,144 celdas.** Las fases anteriores se concentraron
en reproducir las fórmulas —y lo lograron, 163 de 163 celdas al centavo— mientras el 62.5% del
libro, que es captura a mano, siguió exactamente igual.

### 1.1 El mecanismo que explica la mitad de las fórmulas

`FORMATO DE PAGO` no tiene una tabla por periodo: tiene **una sola tabla cuyas 15,397 fórmulas
apuntan a `$BQ$7`**, una celda que guarda el número de quincena. Cada celda es del tipo

```
=IF($BQ$7=1, COMISIONES!E5, IF($BQ$7=2, COMISIONES!E6, IF($BQ$7=3, …  27 niveles …
```

⭐ **Es un reporte parametrizado hecho a mano.** Cambiar `$BQ$7` y volver a imprimir es
literalmente `WHERE period_no = :n`. Quince mil fórmulas existen para emular una cláusula.

### 1.2 Dos calendarios en el mismo archivo

- **COMISIONES** → quincena de **14 días**, 27 periodos, arranca `2026-01-14`.
- **HOJA DE LLENADO OBJETIVO MENSUA** → periodos de **28 días**, 13 al año, y sus etiquetas
  siguen diciendo **2021** (`01-ENE-2021 - 28-ENE-2021`).

Son dos esquemas de incentivo con dos calendarios distintos. El motor de comisiones implementa
**el primero y nada del segundo**.

### 1.3 Tres defectos del proceso que sólo se ven abriendo el archivo

1. ⛔ **Fórmulas pisadas con números tecleados.** En `OPERACION DE LAS RUTAS`, `J5` y `K5`
   (viático+comisión por km, costo fijo por km) son fórmulas; **`J6:J12` y `K6:K12` son
   constantes** (`K6=1`, `K9=2`, `J6=5.894118364`). O sea que la ruta 21 se calcula y las otras
   doce arrastran un número congelado que nadie recuerda de cuándo es. *Una hoja no avisa cuando
   alguien reemplaza una fórmula por su resultado.*
2. ⛔ **Errores que viven en las celdas.** `CONCENTRADO!G8 = #DIV/0!` (día sin captura),
   `OPERACION!U10 = #DIV/0!` (la ruta 28 sin costo de venta). No rompen nada: se arrastran a los
   agregados y se imprimen.
3. ⛔ **Columna mal rotulada.** `OPERACION!X4` dice `RENDIM DE KM X LTO` y su fórmula es
   `=+T5/R5` = **costo por km**, no rendimiento. Dos cosas distintas bajo el mismo nombre, en la
   hoja desde la que se juzga la rentabilidad de la ruta.

### 1.4 Y hay un segundo archivo, que es el trabajo de hoy

`CUADRE rd21 05-sep.xlsx` — **modificado el 2026-10-07 a las 11:42**, 763 filas:

```
sku | unidad | producto | cargado uds | de eso a ciegas | vendido uds |
deberia tener | tiene segun ellos | diferencia uds | costo unitario | diferencia importe | veredicto
```

Se arma cruzando `rd21 05-sep.xlsx` (export de existencia de Kepler que manda el chofer, total
$37,765.58) contra carga y venta. **Un archivo por ruta y por corte.** Es exactamente lo que
`analytics.v_rd_route_ledger` y `/comercial/inventario-ruta` ya calculan desde el 3-oct.

---

## 2. El proceso real, paso por paso

| # | Paso | Dónde | Qué se teclea | Volumen/año | Cadencia |
|---|---|---|---|---|---|
| 1 | Capturar la venta | CONCENTRADO | COSTO · SUBTOTAL · VENTA por ruta×día | ~11,700 celdas | diaria |
| 2 | Capturar el gasto de flota | CONTROL DE GASTOS | folio, fecha, ruta, tipo, importe, litros | ~7,400 celdas | continua |
| 3 | Capturar el odómetro | OPERACION | KM inicial / KM final por ruta×periodo | ~700 celdas | quincenal |
| 4 | Capturar el objetivo | HOJA DE LLENADO | visitas · desarrollo de marca · volumen | ~1,500 celdas | mensual (28 d) |
| 5 | Calcular la comisión | COMISIONES | — (SUMIFS) | — | quincenal |
| 6 | Imprimir los recibos | FORMATO DE PAGO / SUPERVISOR / OBJETIVO | cambiar `$BQ$7` | — | quincenal |
| 7 | Cuadrar el camión | archivo aparte, por ruta | pegar el reporte del chofer | 763 filas × ruta × corte | ad hoc |

Los pasos **1 a 4 son captura pura**. El 5 y el 6 son un generador de reportes. El 7 es una
conciliación que se rehace a mano cada vez.

---

## 3. Qué tiene ya la plataforma para cada paso

| Paso | Objeto que lo cubre | Estado |
|---|---|---|
| 1 venta | `analytics.v_rd_commission_base` (RD.18) sobre `v_rd_route_daily` | 🧪 escrito, **sin correr** |
| 2 gasto | `logistics.route_expenses` (RD.4) — 782 filas / $848,610.04 al centavo | ✅ en prod |
| 3 odómetro | `logistics.route_odometer` + `v_route_operation_period` (RD.5) | ✅ en prod |
| 4 objetivo | — | ⛔ **no existe** |
| 5 comisión | motor RD.6 + RD.17–RD.20 | ✅ en prod / 🧪 lo nuevo sin correr |
| 6 recibo | — (el patrón sí: `AnexoVentaService` de Fase AX, Chromium propio) | ⛔ **no existe** |
| 7 cuadre | `v_rd_route_ledger` + `/comercial/inventario-ruta` (RD.9–RD.26) | ✅ en prod |

⭐ **Cinco de siete pasos ya tienen su objeto construido y en producción.** El cuello de botella
no es que falte plataforma: es que el ciclo **no está cosido de punta a punta**, así que la
persona sigue abriendo el archivo para el paso que falta y, estando ahí, hace todos los demás.

### 3.1 Los dos huecos reales

**(a) El bono por objetivo mensual.** `HOJA DE LLENADO` → tres criterios por ruta×periodo
(`NUM DE VISITAS > 959`, `DESARR DE MARCAS > 999.99`, `VOL DE COMPRAS > 999.99`), cada uno
`CUMPLIDO`/`NO CUMPLIDO`, con pesos **50% / 25% / 25%** → `% Bono`. Alimenta `OBJETIVO MENSUAL RD`,
que emite el recibo del **Jefe de Zona**. Nada de esto existe en la plataforma.

⚠️ Y los umbrales `959` / `999.99` están **en la fórmula**, no en una tabla: cambiarlos es editar
390 celdas.

**(b) El recibo imprimible y su padrón.** `FORMATO DE PAGO` trae RFC, CURP, NSS y fecha de inicio
de relación laboral de **los 13 choferes**; `OBJETIVO MENSUAL RD` lo mismo para **los 3 Jefes de
Zona**, con su deducción por zona: **PH $4,260.80 · Canindo $3,632.00 · Morelia $3,200.58**.

⭐ **Esto responde la pregunta que RD.19 dejó abierta**: la deducción del supervisor no era un
número único de $4,260 — son **tres, uno por zona**. Y `logistics.drivers` ya tiene `curp`, `rfc`,
`hire_date` y `base_salary_biweekly` desde J.11.1; le falta **NSS**.

⭐ Y un cabo que se cierra solo: la **ruta 505 sí tiene persona**. Su celda de nombre (`K4`) está
vacía —por eso el seed de RD.6 la dejó en `NULL` declarado y no inventado, que fue lo correcto—
pero `K6` trae su **RFC `AASJ-930923-3M8`** y `K9` su NSS. El nombre se recupera del padrón
fiscal, no se adivina.

⛔ **Pero los nombres NO concuerdan.** El libro nombra Jefes de Zona a `JOSE CRUZ CISNEROS MORENO`
(PH), `ENRIQUE TORRES LÓPEZ` (Canindo) y `EDUARDO LOPEZ SAINZ` (Morelia), mientras la escala
sembrada en prod tiene `ANGEL ALBERTO VAZQUEZ MEJIA`, `FRANCISCO DE JESUS MARTINEZ RAZO` y
`EDUARDO LOPEZ SAINZ`. **Uno de tres coincide.** Es el mismo defecto de §5.13 del plan original
(tres maestros de personas y ninguno concuerda) y acá cambia a quién se le paga.

---

## 4. El plan

Orden por **valor / esfuerzo**, no por número. Cada entrega cierra un paso del §2 y **retira
hojas del libro**, que es la única medida de avance que importa.

| # | Entrega | Qué retira | Depende de |
|---|---|---|---|
| **RD.27** | ✅ **Las 3 migraciones en prod (batches 777-779) + candado 13/0/0** | nada todavía | — |
| **RD.28** | ⭐ **El marcador en vivo** — avance de la quincena por ruta, proyección al cierre y distancia al siguiente escalón | — (es valor nuevo) | RD.27 |
| **RD.29** | Cerrar el ciclo de captura: odómetro y gasto desde la pantalla | CONTROL DE GASTOS · OPERACION | RD.27 |
| **RD.30** | El recibo imprimible + padrón de personas (RFC/CURP/NSS, deducción por zona) | FORMATO DE PAGO · FORMATO DE SUPERVISOR | RD.27 |
| **RD.31** | El bono por objetivo mensual (calendario de 28 días, 3 criterios en tabla) | HOJA DE LLENADO · OBJETIVO MENSUAL RD | RD.30 |
| **RD.32** | El cuadre del camión como pantalla, no como archivo | el archivo `CUADRE rdNN` | ya existe el ledger |
| **RD.33** | El chofer ve su propia quincena (en `apps/vendor`) | — (valor nuevo) | RD.28 |
| **RD.34** | `CONCENTRADO` como vista de contraste, para apagar el libro con evidencia | CONCENTRADO | RD.27 |
| **RD.35** | Retiro declarado del workbook | el archivo entero | RD.29–RD.34 |
| **RD.36** | Costo fijo por ruta en tabla con vigencia | COSTO RD PH / CANINDO | RD.29 |

### RD.27 — Correr lo que ya está escrito ⛔ ruta crítica

RD.17–RD.20 dejó tres migraciones, un candado, el motor reescrito, el cron y la pantalla. **El SQL
ya se validó leyendo prod el 2026-10-07** (las dos vistas corren: 7.7 s una quincena reciente,
13.7 s la que cruza el corte); falta **aplicar las migraciones**, que necesita credencial de
escritura — la del `.env` es de lectura.

**Prueba de aceptación**: `test-newdb-rd-commission-base.js` en verde contra prod.

#### ⛔ Dos hipótesis que la medición REFUTÓ, y una que apareció

Se registran para que nadie las reconstruya:

1. **"La venta se cuenta dos veces".** `v_route_sales_lines` une tres tramos sin guarda de fecha y
   el motor los sumaba. **Falso**: 3 días con dos capturas en 120, y **cero folios compartidos en
   200 días**. Son el corte de sistema — el push trae el folio de apertura de $5.68 y Wincaja la
   venta real. ⭐ Y el "arreglo" (arbitrar a favor del push) habría publicado **$5.68 donde hay
   $5,075.36** en la ruta 502. *Una corrección sin medir no es neutral: elige un lado.*
2. **"El costo parcial infla el markup".** Cierto como mecanismo, **inocuo en los datos**: 0 de 66
   ruta-periodo difieren más de 0.5 pp, porque la precedencia cae a `costo_wincaja` y cubre el día.
   El 368% que vi era artefacto de mi propia consulta de display, que ignoraba esa pierna.
3. ⭐⭐ **Lo que sí está roto: el bono del supervisor dejó de pagar.** La única fuente de costo del
   motor desplegado es la pierna Wincaja de `v_rd_route_daily`, y Canindo migró al push el 12-14 de
   agosto. Desde entonces `count(costo) = 0` → markup `NULL` → **bono $0**. Medido:

   | | Q12 | Q13 | Q14 | Q15 | Q16 | Q17 | Q18 | Q19 | Q20 |
   |---|---|---|---|---|---|---|---|---|---|
   | rutas con costo, motor actual | 11 | 11 | 5 | 5 | 5 | **0** | **0** | **0** | **0** |
   | bono que pagaría | $3,000 | $3,000 | $3,000 | $3,000 | $3,000 | **$0** | **$0** | **$0** | **$0** |
   | con el costo de RD.18 | $3,000 | $3,000 | $3,000 | $3,000 | $3,000 | $3,000 | $3,000 | $3,000 | $2,400 |

   **$15,000 contra $26,400 en Q12–Q20.** ⚠️ Es un defecto **latente, no una pérdida realizada**:
   el motor tiene **cero corridas** y se sigue pagando con el Excel. Pero el día que se encienda
   —que es el objetivo de esta fase— pagaría de menos y nadie lo notaría, porque un bono que no
   aparece se ve igual que un bono que no se ganó.

⚠️ **Y una lección de método**: la primera versión del universo perdía 4 rutas porque leí la
definición de `v_route_sales_lines` de una migración de **agosto**, y el 6-oct le agregaron un
**tercer `source`** (`kepler_vecinal`). *La definición vigente de una vista se lee de la migración
más reciente que la toca, o se le pregunta a la base.*

### RD.28 — El marcador en vivo ⭐ la entrega que justifica la fase

El tabulador es un **acantilado**: con $189,999.98 de venta la ruta cobra **cero**; con
$189,999.99 cobra 3.75% sobre el subtotal — del orden de **$7,000**. Y los bonos del chofer
saltan en $215,999.99 (+$200), $239,999.99 (+$800) y $259,999.99 (+$1,000).

Hoy el chofer, el supervisor y el jefe de zona **se enteran cuando la quincena cerró**, porque el
número vive en un archivo que se llena al final. El dato, en cambio, llega cada 15 minutos por
`route_push_lines`.

Entrega: por ruta, con la quincena corriendo —
- venta acumulada y **días que faltan**,
- **proyección al cierre** con el ritmo propio del periodo,
- **cuánto falta para el siguiente escalón** y cuánto vale llegar,
- y lo mismo para cada bono.

⚠️ Se publica **con su procedencia** (`data_as_of`) y marcado como proyección, nunca como cifra
pagable: una estimación que se lee como pago es peor que no tenerla. ⛔ **No se promete nada que
no se pueda sostener**: si la frescura del carril no alcanza, la fila dice que no sabe.

*Es la única parte del plan que hace algo que el Excel no puede hacer de ninguna manera, y la
única que puede cambiar el resultado en vez de sólo reportarlo.*

### RD.29 — Cerrar la captura (odómetro y gasto)

Las dos tablas existen y están pobladas; lo que falta es **la pantalla por la que se cargan**, en
el mismo lugar donde se mira la quincena. Mientras el único camino sea el libro, el libro sigue
abriéndose — y abierto, se usa para todo.

Incluye el freno que el Excel no tiene: el odómetro **no puede retroceder**, y un salto fuera de
banda se declara en vez de dividir entre él (hoy `#DIV/0!` y constantes tecleadas conviven con
lecturas reales).

### RD.30 — El recibo y el padrón

- `logistics.drivers` ya tiene RFC/CURP/`hire_date`; falta **NSS** y las **tres personas Jefe de
  Zona** como registros, no como texto en una celda.
- `commission_beneficiary_config` (creada vacía en RD.19) se carga con **las tres deducciones por
  zona** medidas arriba — ⛔ **después de arbitrar los nombres**, no antes.
- El PDF reusa el patrón de Fase AX (`AnexoVentaService`, Chromium propio en `libs/finance`):
  un recibo por persona y periodo, reproducible seis meses después porque la línea guarda la base
  con la que se calculó.

⚠️ **El recibo NO es un CFDI** y así se rotula, igual que el pagaré de AX.

### RD.31 — El bono por objetivo mensual

Lo único realmente nuevo como regla de negocio. Dos cosas que el Excel hace mal y acá no:
- el **calendario de 28 días** es propio y se declara como tal (no se fuerza a la quincena);
- los umbrales (`959`, `999.99`) y los pesos (`50/25/25`) van **en tabla con vigencia**, como el
  tabulador de RD.6 — hoy están dentro de 390 fórmulas.

⛔ **Bloqueado hasta saber de dónde salen los tres criterios.** "Número de visitas" y "desarrollo
de marca" no están decodificados: pueden venir de `trade.*` (auditoría de ejecución) o no existir
como dato. **Primero se investiga la fuente; si no hay, se declara y el bono se captura a mano
con su motivo** — no se inventa un derivado.

### RD.32 — El cuadre del camión, en pantalla

El archivo `CUADRE rdNN` se arma a mano por ruta y por corte. El ledger ya tiene las tres piernas
(carga `U-D-41`, venta del push, costo del embarque). Falta la cuarta: **lo que el chofer reporta
tener**, que hoy llega como un `.xlsx` exportado de Kepler.

Entrega: subir ese reporte (o leerlo del ERP), cruzarlo, y publicar el veredicto por SKU **con el
vocabulario que ya usa la persona** — incluido *"recibió carga en el tramo ciego"*, que es un
concepto real del negocio y no una categoría inventada.

### RD.33 — El chofer ve su quincena

`apps/vendor` ya existe y los choferes ya tienen app. Sin esto, RD.28 informa a quien decide pero
no a quien puede mover la aguja.

### RD.34 — `CONCENTRADO` como vista de contraste

Antes de apagar el libro, publicar la comparación día a día entre lo tecleado y lo derivado, por
ruta. ⭐ **El apagado se gana con evidencia, no con una fecha**: §2.3 del plan original ya midió
SUBTOTAL 98.0% y COSTO 14.1%, y esa diferencia tiene que estar explicada antes de que alguien deje
de teclear.

### RD.35 — Retiro declarado

El libro se marca retirado **con fecha y motivo**, y queda una sonda que avisa si alguien lo
vuelve a tocar — el patrón `veredictoRetirada` de `db-health`. *Retirar no es dejar de mirar: es
callarse salvo que te sorprendan.*

---

## 5. El valor agregado, nombrado

| | El Excel | La plataforma |
|---|---|---|
| **Cuándo se sabe** | al cerrar la quincena | con la quincena corriendo (RD.28) |
| **Quién lo ve** | quien tiene el archivo | el chofer, el supervisor y dirección (RD.33) |
| **Se puede hacer algo** | no, ya pasó | sí: faltan $X y 3 días para el siguiente escalón |
| **Reproducir un recibo viejo** | sólo si nadie tocó el archivo | la línea guarda su base y su procedencia |
| **Pagar sobre dato incompleto** | nada lo impide | la corrida nace `bloqueada` (RD.19) |
| **Una fórmula pisada** | invisible | no existen fórmulas que pisar |
| **Cuadrar un camión** | un archivo por ruta y corte | una pantalla (RD.32) |
| **Cambiar el tabulador** | editar celdas en 11 hojas | un `INSERT` con `valid_from` |

---

## 6. Lo que NO se va a hacer, y por qué

- ⛔ **Importar el workbook.** Ni ahora ni como respaldo. Lo que vale se deriva (regla #1) y lo
  que no se puede derivar se captura **en su pantalla**, no copiando un archivo.
- ⛔ **Reproducir `RESUMEN DE OPERACION DE RUTAS`.** 2,386 SUMIFS para una tabla dinámica. El
  equivalente es una consulta; la hoja no se migra, se reemplaza.
- ⛔ **Un botón "exportar a Excel" que reconstruya el libro.** Sería devolverle el problema su
  forma. Exportar el **resultado** (CSV, PDF del recibo) sí; recrear el instrumento no.
- ⛔ **Tocar la aritmética del tabulador.** Está verificada al centavo contra 163 celdas y no es
  lo que falla.

---

## 6bis. RD.22 — Se retiró el cron, y la corrida pasó a ser un valor congelado

> **Estado**: 🧪 EN CÓDIGO 2026-10-07. Decisión de Edgar, contra el diseño que RD.20/RD.21 ya
> tenía desplegado. Sin migraciones ni permisos nuevos.

### Por qué se tiró lo que estaba hecho

RD.20 puso un `@Cron` diario a las 08:30 para la quincena cerrada; RD.21 le sumó otro cada 30
min para la que todavía corría. Los dos se retiraron el mismo día que corrieron por primera vez.

**El argumento que los tumbó, de Edgar:** *una quincena pasada es un valor estático que no puede
cambiar*. Y de ahí sale todo lo demás:

- Un reloj que despierta **48 veces al día** para un hecho que ocurre **24 veces al año** está
  mal planteado de origen.
- El de 30 min **reescribía la corrida de la quincena abierta cada media hora**. Una cifra de
  nómina que se mueve sola es exactamente lo contrario de lo que esa cifra tiene que ser.
- ⚠️ Y la justificación que yo le había puesto al diario —*"el carril puede venir atrasado, por
  eso se reintenta"*— **nunca se midió**. Era una premisa escrita como ley física: la clase de
  afirmación que después nadie vuelve a revisar porque está en un comentario.

⛔ También quedó descartada la alternativa que yo había propuesto —la corrida como **vista**, que
se congela sólo al aprobar—: una vista recalcularía el pasado cada vez que alguien la mira, que
es justo lo que no debe pasar.

### El modelo que queda

| | Antes (RD.20/21) | Ahora (RD.22) |
|---|---|---|
| Quincena cerrada | la escribía el cron, y la reemplazaba | se escribe **una vez**, a propósito |
| Quincena en curso | corrida `en_curso` reescrita cada 30 min | **no se guarda**; se mira con la vista previa |
| Lo pagado | protegido por la red de abajo | **freno propio**, y no manda a reintentar |
| Quien escribe | dos crons + `/run-now` | **un solo camino**: `POST /commissions/recalculate-from` |
| El hueco | lo insinuaba el latido `rd_commission_runner` | lo declara el periodo: `estado_calculo` |

El trámite de escritura es **el mismo las dos veces que hace falta**: producir el número de una
quincena recién cerrada, y reconvertir desde el periodo en que aplica una escala nueva. Calcula
ésa y todas las cerradas que le siguen; **salta** las pagadas y las aprobadas con su motivo, y el
lote sigue (cada quincena se calcula sobre su propio rango, no acumula contra la anterior).

### Lo pagado no se edita

Decisión explícita de Edgar. Si la escala cambia con efecto sobre una quincena **ya pagada**, la
diferencia entra como **ajuste en la siguiente**; la fila pagada queda como está, porque es el
registro de un depósito que ocurrió. Reescribirla haría que el historial dejara de coincidir con
lo que de verdad se le depositó a la gente. Lo `aprobado` tampoco se pisa en silencio: lleva una
firma, se anula a mano primero, y ese acto queda registrado.

### El hueco cambió de lugar, no desapareció

Sin cron no hay latido que vigilar, así que `rd_commission_runner` salió de `CRON_JOBS` — dejarlo
pondría `db-health` en rojo para siempre por un carril que ya no existe. En su lugar, `board()`
publica **cuatro** estados por periodo: `calculada` · `sin_calcular` · `en_curso` · `futura`.

⭐ `sin_calcular` y `en_curso` llegan los dos sin cifra y **no son lo mismo**: al primero le falta
que alguien lo calcule, al segundo que termine el periodo. El rail los pintaba iguales ("sin
corrida", gris) y eso hacía que **una quincena olvidada se viera normal**. Ahora `sin_calcular`
sale en ámbar y es lo único del tablero que pide acción. *La ausencia se declara en la fila a la
que le falta, no en un sensor aparte que mira si un reloj despertó.*

### Dos bugs que sólo se vieron al correr de verdad

El motor llevaba un mes en prod con **cero corridas**, así que nada de esto era deuda latente:
era código que nunca se había ejecutado.

1. ⛔ **`pendientes()` leía del pool crudo sobre tablas con RLS FORZADO.** `app_runtime` no tiene
   `app.tenant_id` como default de rol (sí lo tienen `edgar`, `david`, `francisco`, `sistemas`),
   así que `current_tenant_id()` era NULL y la consulta devolvía **cero filas sin error**. Tres
   corridas seguidas reportaron `ok` sin hacer nada. ⚠️ Lo peor no fue el bug: fue que el
   `ceroEsOk` del latido declaraba *"no había quincena pendiente"* **sin comprobarlo**, y eso
   convirtió una falla total en verde. *Un cero declarado legítimo sin verificarlo es peor que
   un rojo.*
   ⚠️ Y el latido decía `host: 'api'` corriendo en el **worker** (el default de `latirCron` sin
   sobreescribir): mandó a leer los logs del pod equivocado y costó una vuelta entera.
2. ⛔ **`String(period.date_to).slice(0, 10)` devolvía `"Wed Oct 07"`.** pg entrega un `date`
   como objeto `Date` de JS, y `String(Date)` lo imprime en formato largo. Reventaba en la
   consulta de la escala con `invalid input syntax for type date`. Es el mismo defecto de
   `[LC.16]`, y por eso `board()` ya traía sus fechas con `to_char`.

Aprovechando el segundo, el **"hoy" pasó a salir de `current_date` de la DB** y no de
`new Date()` del proceso: `toISOString()` es UTC, así que entre las 18:00 y la medianoche de
México adelanta el día y una quincena que cierra HOY se habría dado por cerrada seis horas antes.
Es `[RD.1]` otra vez.

### El candado

`libs/commercial/.../commission-inmutable.spec.ts` — **10 aserciones, las 5 mutaciones en rojo**:
sin el freno de pagado · sin el de aprobado · sin el del periodo abierto · con `en_curso` otra vez
reemplazable · con el freno aplicándose también a la vista previa (que debe poder mirar el
periodo abierto).

⚠️ **La mutación encontró un defecto en mi propio candado.** Las dos primeras versiones pasaban
**por la razón equivocada**: al apagar el freno de `pagado`, la red de abajo
(`!['borrador','bloqueada'].includes(...)`) también rechazaba, y su mensaje contiene la palabra
*"pagado"* — con la que mi `toThrow(/pagad/i)` casaba igual. Se cambió a la frase que **sólo**
produce el freno explícito. *Un test verde no dice contra qué pasó.*

⚠️ El spec usa dobles de knex y **no ejecuta SQL** — comprueba flujo de control, que es donde
vive la regla. La parte que toca la base la cubre `test-newdb-rd-commission-base.js`
(**15 OK / 0 fallas / 0 no medidos** contra prod, 2026-10-07).

### Lo que falta

`git push` + redeploy de api y view. Sin migraciones ni permisos nuevos → **sin re-login**.
Abierto: **dónde vive el trámite de recalcular** (el endpoint existe; la pantalla de comisiones
sigue siendo sólo de lectura por pedido explícito, así que su UI es una decisión aparte — y va
junto con la de dónde vive aprobar).

---

## 6ter. RD.23 — El motor contra el libro: la regla es exacta, la fuente tiene huecos

> **Estado**: 🧪 EN CÓDIGO 2026-10-08 · migración **aplicada a prod** (batch 821, 0.1 s).
> Disparado por *"sigue sin calcularse nada a pesar de ya estar calculado"* + el workbook al día.

### El control primero: ¿la regla del motor reproduce lo que se pagó?

**Sí, al centavo.** El tramo lo elige `venta` (`gate_field`), la base es `subtotal`
(`base_field`), y el chofer cobra el 80% (el supervisor el 20%, `share_supervisor_pct`):

```
ruta 504, Q20:  179,189.91 × 4.25% × 80% = 6,092.46      el libro dice 6,092.46
```

Sobre las **125 ruta-periodo** de Q10–Q20 que el libro trae calculadas: **108 cuadran, con
desviación mediana de 0.11%**.

### Lo que no cuadra: 17 de 125 (13.6%), y casi siempre hacia abajo

**14 de esas 17 son días que le faltan a la fuente**, no cuentas mal:

| | días del motor | mediana de su plaza | desvío |
|---|---:|---:|---:|
| Q13 ruta 21 | 9 | 12 | −27.25% |
| Q14 ruta 26 | 9 | 12 | −23.82% |
| Q20 ruta 504 | **5** | 12 | **−49.85%** |

Las otras 3 tienen los 12 días y aun así difieren (Q15/28 +16.6%, Q16/504 −10.5%, Q17/501
−6.0%): **otra causa, sin medir todavía**, y la compuerta de abajo no las ve.

### ⭐ El error no es proporcional: es un acantilado

El tramo más bajo arranca en **$189,999.99 de venta**. Por debajo **no hay tramo y la comisión
es cero**, no "menos". La 504 en Q20:

```
libro   subtotal 179,189.91 · venta 197,512.50 → tramo 4.25% → a pagar  1,092.46
motor   subtotal  89,866.68 · venta  98,342.57 → SIN TRAMO   → a pagar      0.00
```

Publicar Q20 hoy le pagaría **$0 en vez de $1,092.46** al chofer de la 504.

### El rastreo de la 504, hasta el final

1. `analytics.route_push_lines` (plataforma) — último día **2026-10-01**.
2. `kepler_consolidado.mart.ventas`, `sucursal='ruta_504'` — también **2026-10-01**. 7,967 filas,
   ventana 12-ago → 1-oct. Cero filas el 2, 3, 5, 6 y 7 de octubre (la 503, al lado, tiene todos).
3. ⛔ **`ingest.route_push_heartbeat` de la 504 está VERDE**: `last_ok` de hoy 15:49,
   **5,348 filas**, desde `192.168.50.21`.

⭐⭐ **La camioneta sube todos los días y lo que sube no tiene fechas nuevas.** `merge_route_sales`
borra por fecha e inserta lo que llegó, así que re-escribe la misma ventana vieja una y otra vez
y reporta 5,348 filas de éxito. El problema está **en el Kepler de la camioneta**, no en el
carril — y nuestro latido no podía verlo porque **mide filas entregadas, no la fecha más nueva
entregada**. Con `max(fecha)` en el latido, esto se habría visto el 2 de octubre y no el 8.

⚠️ La 504 ya venía perdiendo días antes: 26 y 28 de septiembre también están en cero.

### Lo que se construyó

**Columnas congeladas en la línea** (mig `20261008120000`, batch 821): `dias_con_venta` y
`dias_esperados` —la mediana de las rutas hermanas de su **plaza** en **ese** periodo, no un
calendario inventado: los domingos y los puentes se caen solos porque le pasan a todas—. Se
congelan por el mismo motivo que `beneficiario_nombre` y `zona`: derivarlas después las contaría
contra la fuente de hoy, ya reparada, y un recibo viejo diría que todo estaba completo.

**Compuerta `cobertura_dias`**, y ⚠️ **avisa, no bloquea, por medición y no por prudencia**:

| sobre Q10–Q20 (125 ruta-periodo) | |
|---|---:|
| marca y descuadra | **14** |
| marca y NO descuadra | **8** |
| no marca y descuadra | 3 |
| limpias | 100 |

Las 8 falsas cuadran al **0.0%** contra el libro: el camión de verdad no salió (Q11/505 con 4
días, Q19/505 con 1). Bloquear la nómina con 36% de falsos positivos la frena por nada una de
cada tres veces, y una compuerta que grita en falso enseña a ignorar el tablero.

⛔ **No se puede afilar desde el motor**: no distingue *"no salió"* de *"se perdió el día"*,
porque la fuente es el único testigo de las dos. Lo que falta es **depurar el padrón** — 505
lleva 28 días sin dato, 322 lleva 99 y 321 lleva 128, y las tres siguen `comisiona = true`
(punto 3 de §7). Con el padrón limpio, "ruta que comisiona con la fuente muerta" bloquea sin un
solo falso positivo.

### Una compuerta que probé y tiré

La primera versión marcaba por **último día rezagado**. La tumbó su propio control: atrapaba 5 de
18 mientras 13 ruta-periodo sin marcar descuadraban hasta −23.8%. *Una bandera sin su grupo de
control se parece demasiado al azar como para notarlo.*

### Hallazgos sueltos

- **Una fila de Wincaja fechada 2026-12-06** (ruta 22, $230.49): una venta en el futuro. No
  afecta Q20, pero entraría sola en una quincena de diciembre.
- El trámite manual de recalcular **ya tiene casa**: aparece en el tablero sólo cuando hay una
  quincena cerrada sin número, y sólo para quien tiene `COMMERCIAL_COMMISSIONS_GESTIONAR`. No
  contradice el "sin botones": lo que no debe depender de que alguien apriete algo es **leer**.

### Candado

`commission-inmutable.spec.ts` — **15 aserciones**, y las **8 mutaciones en rojo** (5 de RD.22 +
3 de la compuerta nueva, incluida *"si alguien la sube a `bloquea`, esto cae"*).

### Lo que falta

`git push` + redeploy api/view. **No publicar Q20 hasta reparar la 504.** Y dos cosas que no son
de esta fase pero salen de ella: ponerle `max(fecha)` al latido de `route_push_heartbeat`, y
mirar el Kepler de la camioneta 504.

---

## 7. Lo que está abierto, y de quién es

| # | Qué | Dueño |
|---|---|---|
| 1 | ⛔ **Permiso de lectura a prod** — sin esto RD.27 no arranca y lo escrito sigue sin ejecutarse | Edgar |
| 2 | ⛔ **Los tres Jefes de Zona**: el libro y la escala sembrada coinciden en **uno de tres**. Cambia a quién se le paga | Edgar |
| 3 | **Las rutas 321/322** (sin fuente desde el 2-jun y el 1-jul) y **505** (desde el 10-sep): ¿siguen comisionando o se marcan inactivas? | Edgar |
| 4 | **Los tres criterios del objetivo mensual** (visitas, desarrollo de marca, volumen): ¿de dónde salen? | Edgar + investigación |
| 5 | **El calendario de 28 días** de HOJA DE LLENADO: ¿sigue vigente o quedó en 2021? | Edgar |
| 6 | Las constantes tecleadas en `OPERACION!J6:K12`: ¿cuál es el valor correcto del costo fijo por km? | Edgar |

---

## 8. Evidencia

Medición reproducible con `exceljs` sobre el workbook (lectura, no escritura):

- conteo manual/fórmula por hoja → tabla de §1;
- `FORMATO DE PAGO!C12` y siguientes → el router `$BQ$7` de §1.1;
- `HOJA DE LLENADO!E5:K5` → los tres criterios y sus pesos de §3.1(a);
- `OBJETIVO MENSUAL RD!A1:D3` → los tres Jefes de Zona y sus deducciones;
- `FORMATO DE PAGO!C4:N9` → el padrón de los 13 choferes con RFC/CURP/NSS;
- `OPERACION DE LAS RUTAS!J5:K12` → la fórmula de la fila 5 contra las constantes de 6 a 12;
- `CONCENTRADO!G5` (`=E5/D5-1`) → el `%` del libro es **markup sobre costo**, confirmado en la
  fuente y no inferido.
