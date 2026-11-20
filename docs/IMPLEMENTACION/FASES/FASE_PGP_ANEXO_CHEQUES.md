# Fase PGP — Anexo CH: el cheque nace, se imprime y se sigue en la Suite

> Anexo de [`FASE_PGP_PAGO_A_PROVEEDOR.md`](FASE_PGP_PAGO_A_PROVEEDOR.md). El método: [`docs/METODO_DE_TRABAJO.md`](../../METODO_DE_TRABAJO.md).
> **No es una fase nueva:** detalla el frente 4 del [anexo C](FASE_PGP_ANEXO_CERO_CAPTURA.md) (`[PGP.133]`, D7 ya firmada
> por Edgar el 2026-11-17: «la Suite lleva la chequera por cuenta»). El tablero tiene 9 fases 🔨 contra un tope de 4
> (contado el 2026-11-19 con `tablero.js`).

```
OBJETIVO: que cada cheque —de la chequera que llega del banco a su cobro en el estado de cuenta— lo emita,
          imprima y siga la Suite. El importe se calcula UNA vez, al centavo, y ese mismo número va al papel
          (con número y con letra), a la liberación en el banco, al Calendario de pagos y a Kepler.
MÉTRICA:  cheques cobrados (descarga del banco) que la Suite conocía al centavo antes del cobro
          HOY (medido 2026-11-19, cobros del 1 al 19-nov, BAJÍO 4166 + SANTANDER 2169): 9 de 43 = 21 %
          META: 100 % en BAJÍO 4166 para 2026-12-15 (fecha propuesta; la fija el PM); 2169 según DCH3
MÉTRICA 2 (control de la chequera): folios sin paradero
          HOY: 17 de 74 (BAJÍO 4166, folios 5333–5406) → META: 0
CAPA TOPE: C3
ÁREA:      Finanzas (Tesorería)
DUEÑO:     <por asignar — lo firma Edgar>
ESTADO:    ⬜ plan; DCH1–DCH9 esperan firma (DCH2 contestada; DCH1 decidida en lo que toca al papel —la hoja se
           desprende— y espera las medidas y la copia de cada cheque para calibrar). El proceso lo describió
           Francisco (§0 fila 8). ⛔ `[PGP.173]` es prioridad 0: la liberación a la semana ya soltó un cheque.
           Absorbe `[PGP.133]`.
```

Medido en `pg-prod` (`system_identifier 7688376744939610156`, usuario `francisco`, `transaction_read_only = on`) sobre
`kepler_ods.kdm1` (`X-D-25`, cada documento en su servidor: `c1 = sucursal`; `c43 = 'C'` cancelado),
`finance.payment_allocations` (`payment_method = 'cheque'`, número en `reference_text`), `finance.bank_statement_lines`
(la descarga del banco) y `finance.bank_movements` (el libro). **El cruce es por número de cheque**, no por importe.
Control: los mismos números del Calendario desplazados +1000 y +5000 casan **0** contra la descarga (los reales, 12).

---

## 0. El pedido

| # | Lo que se pidió (Francisco, 2026-11-19) | Efecto |
|---|---|---|
| 1 | *«generar el control de cheques desde la suite, desde su impresión, hoy se llenan a mano»* | La Suite imprime el cheque (frente 3) |
| 2 | *«hay casos en que las cuentas se hacen en calculadora y el redondeo de centavos han generado que se devuelvan los cheques porque se liberan con esa diferencia»* | **Un solo importe**, calculado por el servidor en centavos enteros, para el papel, la letra y la liberación (frente 0) |
| 3 | *«desde liberar chequeras recibidas del banco»* | Chequeras: recibir el rango de folios y liberarla (frente 2) |
| 4 | *«que al momento de emitir el cheque se registren en el calendario de pagos»* | El cheque nace del pago del Calendario; el que no viene de un pago (nómina, gasto) se registra en el día como «fuera de programa» (frentes 3 y 7) |
| 5 | *«controlar el funnel de cheques emitidos y cuando son cobrados y se reflejan en el estado de cuenta del banco»* | El cobro se lee de la descarga **por número de cheque** y el embudo se ve en una pantalla (frentes 1 y 5) |
| 6 | Respuestas de Francisco a §9, mismo día: *«no tengo el dato, debe ser menos del 2 %»* · *«entregan chequera de libro, con 3 cheques por hoja»* · *«libera el banco la chequera y el dueño de la chequera libera cada cheque»* · *«lo firma Dirección General»* · las medidas y una copia de cada cheque, por llegar | Los devueltos quedan como **estimado, no medido** (§1). DCH2 queda contestada: son **dos liberaciones distintas**, una del banco y otra del titular. El flujo gana el paso **firmado** (§7 C1). La impresión tiene que respetar **3 posiciones por hoja** (DCH1) |
| 7 | Francisco, mismo día: *«se desprende la hoja y después el cheque, libera Caja General, Dirección firma, Tesorería programa, pide número de cheque, beneficiario e importe»* | **Se puede imprimir sobre la hoja** (DCH1-a). Tres personas, tres actos: **Tesorería programa · Dirección General firma · Caja General libera** (el «dueño de la chequera» de la fila 6 es Caja General). El portal pide **número, beneficiario e importe**: dos de los tres (importe y nombre) pueden diferir del papel si se teclean de otra fuente, y la Suite debe dar **la misma cadena** que imprimió (DCH8) |
| 8 | **El proceso, en palabras de Francisco** (mismo día): *«el proceso sigue igual, agregando a calendario de pago; el despliegue del cheque es al momento de seleccionar la forma de pago con cheque, ahí se llena la información del cheque, toma la fecha del calendario (nombre de la persona que firma la póliza de recibido), desglose en la póliza de la información de notas contempladas en el cheque, y procede a imprimir el cheque; lo que cambia con hoy, un funnel de cheques; en la impresión del programa del día señalando que hay que dejar los fondos y liberar en la página del banco; agregar el distintivo de confirmado (llamada que se pide por parte del proveedor previo depósito al banco para proceder con la liberación), y Caja General confirma al siguiente día en el workbook del banco el cobro; en caso de que por alguna razón no se cobre hay que arrastrar el saldo al siguiente día hasta que se cobre o cancele el cheque y se proceda a transferencia. ¿Qué nos está faltando?»* | Es el flujo de §7 C1. Cambia el orden que este plan traía: **el cheque se entrega antes de liberarse** y se libera **cuando el proveedor llama**. Se agregan: la **póliza** con desglose y recibí, el **programa del día** con «dejar fondos / liberar», el distintivo **confirmado**, el **arrastre** diario y el paso **cheque → transferencia**. Lo que falta, en §4a |
| 9 | Respuestas de Francisco a §9 (mismo día): *«1) cancelados; 2) la póliza hoy se llena con papel pasante, y se pone a mano el número de cheque en la póliza; 3) todos los cheques ya registrados en el calendario están entregados; la llamada la recibe Tesorería o en su ausencia Analista de egresos o Caja General»* | Los 6 cheques físicos que se pagaron por SPEI están **cancelados**. La póliza se imprime **aparte, con el número de cheque ya puesto** (una impresora láser no pasa a través del papel carbón). Los cheques fechados en diciembre **ya están en manos del proveedor**: sólo la liberación los detiene. «Confirmado» lo marcan Tesorería, Analista de Egresos o Caja General (DCH9); libera Caja General |
| 10 | Francisco, mismo día: *«se canceló el cheque 5399; sí, se acomodan en la impresora centrados: cheque, y 2 hojas de póliza en blanco para que reimprima el cheque, anexe los documentos pagados, el nombre de quien firma»*; el puesto de Analista de Egresos quedó **vacante** la semana pasada | Los 7 cheques pagados por SPEI están cancelados. **Se imprime cheque por cheque, centrado** (no la hoja de 3), seguido de **2 pólizas** en hoja blanca: cada una repite el cheque, lista los documentos pagados y lleva el nombre de **quien recibe el cheque** (aclarado por Francisco). Mientras el puesto esté vacante, la llamada la reciben Tesorería o Caja General |

**Lo que este anexo cambia de D7** (anexo C): D7 decía que la Suite «asigna el número al autorizar» y que «la `BAJÍO
4166` queda bloqueada para cheques hasta revisarla». Se proponen DCH4 (el folio se confirma al imprimir) y DCH6
(4166 es la chequera de proveedores: desbloquearla). Las dos las firma Edgar.

---

## 1. En una pantalla

**Hoy** Tesorería arma el pago en el Calendario (desde noviembre, 28 cheques de 4166 llevan su número tecleado en
«referencia»), calcula el importe y llena a mano el cheque de la chequera de libro (3 por hoja); Dirección General lo firma, Caja
General lo libera en el portal del banco (número, beneficiario e importe) y se entrega. El banco lo
cobra días después (mediana **3 días** desde que se programó, hasta 12) y Tesorería lo captura en Kepler **cuando ya
se cobró y con la fecha del cobro**. Entre el papel y el cobro, el cheque sólo existe en el talón.

| Hecho | Cifra | Cómo se midió |
|---|---|---|
| Cheques en Kepler, 90 días (21-ago → 19-nov), vivos | **BAJÍO 4166: 77, $15,357,145.82**, todos a proveedor de compra (`C…`), servidores 00/01/06/08 · **SANTANDER 2169: 145, $1,638,193.20**, todos gasto (`G…`): 133 de nómina | `kdm1` `X-D-25` por `c45` |
| Cheques al mes en 2026 | 44–122 documentos; $4.7–8.7 M vivos por mes (ene–oct) | idem, por mes |
| **El mismo cheque, dos importes** | Calendario vs cobro (4166, nov): **3 de 14** difieren $0.01 (5349, 5377, 5384) · Kepler vs cobro (2169, oct–nov): **2 de 21** ($0.31 y $0.18) · Kepler vs cobro (4166, may–nov): 3 de 19 ($0.01, $0.01, $0.21) · Calendario vs Kepler: 5352 ($0.17) | cruce por número |
| Kepler conoce el cheque **hasta que se cobra** | fecha del documento = día del cobro en **7 de 7** (4166, nov) y **21 de 21** (2169); capturado 0–4 días después | `c9`/`c68` vs descarga |
| Cobrados que Kepler todavía no tiene | **9 de 16** (4166, nov): **$1,854,710.76**; el más viejo (5372) se cobró el 5-nov | descarga vs `kdm1` |
| El Calendario no sabe en qué va el cheque | **6 «pendientes» ya cobrados ($1,523,929.36)** · 6 «pagados» sin número ($540,993.11) | `payment_allocations` vs descarga |
| **El cheque que se volvió transferencia no deja rastro** | **7 de 28** pagos del Calendario con número de cheque (5352, 5362, 5368, 5371, 5373, 5376, 5399: **$1,304,085.11**) salieron por **SPEI** el mismo día o al siguiente, 6 desde otras cuentas; el Calendario sigue diciendo «cheque 5362». **Los 7 están cancelados en papel** (Francisco); el Calendario sigue teniendo el 5399 ($37,674.38, SPEI de 2169 el 13-nov) «pendiente» como cheque. Y Kepler registró **5352 como cheque de 4166 por $316,608.40** cuando el dinero salió por SPEI de 2169 por $316,608.23: 4166 tiene en Kepler una salida que el banco nunca hizo | importe ±$1 en descarga y libro |
| **La liberación a la semana ya soltó un cheque** | **5383 ($242,869.77)**, cobrado el 11-nov, fue liberado el 17-nov por `[PGP.117]` y sus facturas volvieron a ofrecerse; lo regresó `[PGP.149]` el 19-nov. **Ensayo en seco con sus consultas reales** (copiadas de `pagos-vencidos.sql.ts`, sólo lectura) para el 20 y 27-nov, el 2, 14 y 21-dic: hoy **no suelta ninguno**, porque los cobrados casan con su salida y para los demás la descarga todavía no cubre esos días. **En cuanto la descarga se suba al día** (la meta de D5-a del anexo C), un cheque entregado que el proveedor tarde más de 7 días en depositar se suelta. Hoy no pasa porque Tesorería «mueve» el pago cada día | bitácora + ensayo |
| Cheques fechados a futuro, **ya entregados** | 5 entre el 7 y el 14-dic: **$586,079.27** (5386, 5387, 5388, 5394, 5401). Todos los cheques del Calendario están entregados (Francisco) | día del pago vs hoy |
| El «arrastre» de hoy es reprogramar | 10 de los 11 pagos con cheque cancelados en el Calendario son copias «[reprogramado a …]»: mover un cheque al día siguiente lo cancela y lo vuelve a crear | `notes` |
| Teléfono del proveedor para validar la llamada | **la Suite no guarda ninguno** (ninguna tabla de proveedores tiene teléfono); en Kepler (`kdxd`) no está descifrado | `information_schema` |
| Folios sin paradero | **17 de 74** (4166, 5333–5406) no están en el Calendario, ni cobrados, ni en Kepler; 29 se usaron fuera del Calendario | serie de folios |
| Cancelados en Kepler | **153 en 2026** (16 % de 962 documentos); el mismo folio cancelado y vuelto a capturar (5340, 5348, 5360; 5363: *«ES EL MISMO CHEQUE 0828»*); en 90 días, 18 cancelados en 7 cuentas que no tienen chequera | `c43 = 'C'` |
| Devuelto visible en el banco | 1 en 2026: 4166, 17-jul, *«Intento de Sobregiro; Cheque Devuelto (Cámara de Compensación)»*, comisión $1,044 con IVA | libro 2026 |
| Devueltos por diferencia en la liberación | **NO MEDIDO.** Francisco estima **menos de 2 %** (con ~74 cheques al mes, hasta 1–2 al mes). Que el Calendario y el papel difieran en 3 de 14 y casi ninguno se devuelva indica que el titular libera casi siempre con el importe del papel; **el rechazo aparece cuando la liberación se hace con otro número** (el del Calendario o el de la calculadora) | testimonio, 2026-11-19 |
| Nombre del beneficiario dañado en Kepler | 2 de 81 acreedores pagados con cheque: `CANEL?S`, `CONSERVAS LA COSTE?A` | `c32` |

⭐ **El árbitro existe y trae la llave exacta.** El renglón del banco dice el número del cheque: en 4166, *«Doc. Pagado
por Camara de Compensacion por (…) numero de cheque | 5383»*; en 2169, la referencia es el número (*«PAGO CHEQUE
EFECTIVO»*, `000017212`). Un cheque, un renglón: mismo grano, testigo independiente (ADR-059). No hay que adivinar
por importe y fecha.

---

## 2. El universo y el trabajo

**El universo:** dos chequeras vivas, **222 cheques y $16,995,339.02 en 90 días** (~74 al mes, ~$5.7 M al mes).
**El trabajo de este anexo**, en este orden: **BAJÍO 4166** (77 cheques, 90 % del dinero, todos a proveedor y ya en
el Calendario) y después **SANTANDER 2169** (145 cheques, $1.6 M, 9 de cada 10 de nómina; DCH3).

Fuera del universo: los cheques que **recibimos** de clientes (arqueo de Caja General, `[CGS.59]`; libro de
efectivo, E-22), y las cuentas sin chequera.

---

## 3. Lo que creíamos y cayó

| # | Lo que creíamos | Lo que midió prod |
|---|---|---|
| 1 | `[CB.30]` dice qué cheques están en tránsito | Kepler registra el cheque al cobrarse y con la fecha del cobro (28 de 28): **por construcción, CB.30 nunca encuentra uno en tránsito**. El tránsito no vive en ningún sistema |
| 2 | El redondeo es un problema de la calculadora | También del sistema: el Calendario y el papel difieren en 3 de 14 cheques cobrados. Cada uno calcula por su lado; ninguno es «el» importe |
| 3 | El número de cheque se deduce del consecutivo (ya cayó en el anexo C) | Confirmado y peor: 17 de 74 folios sin paradero, y el mismo folio capturado dos veces |
| 4 | D7: «4166 bloqueada para cheques hasta revisarla» | 4166 **es** la chequera de proveedores: 77 de 77 cheques a compra en 90 días. Bloquearla es no hacer este anexo. El motivo del bloqueo no está escrito en el repo |
| 5 | Ya hay un «importe con letra» que reusar (`anexo-venta.service.ts`) | Existe, pero escribe **«Sesenta y uno mil cuatrocientos setenta y uno pesos»** por $61,471 (debe ser «sesenta y **un** mil … setenta y **un** pesos»), «Veintiuno mil», «Ciento uno mil» y «Un millón pesos» (falta «de»). $61,471.99 es el importe de un cheque real de mayo (5167). En un cheque, eso es un rechazo. Hallazgo también para el anexo de venta (AX) |
| 6 | El cheque cancelado guarda su importe en Kepler | No: queda en $0 (153 de 153). Para saber de cuánto era hay que leer sus aplicaciones (`kdxf`), como en `[ECA.7]` |
| 7 | (primera versión de este plan) «6 pagados sin cobro = cheques en tránsito» | Falso: los 6 salieron por SPEI (§1), y los cheques están cancelados. Es el camino «se cancela el cheque y se procede a transferencia» sin registro. Un séptimo (5399), también cancelado, sigue «pendiente» en el Calendario |
| 9 | (versión anterior de este plan) «6 de 22 cheques numerados salieron por SPEI» | Son **7 de 28**: el universo eran los 28 pagos con número no cancelados, y faltaba el 5399 |
| 10 | (versión anterior) «mañana la liberación suelta el 5399» | No: lo conserva porque el banco tiene una salida por su importe… que es su pago por SPEI. La regla acertó por casualidad |
| 8 | (primera versión de este plan) «No se entrega un cheque sin liberar» | Al revés: se entrega, el proveedor llama antes de depositar y **entonces** Caja General libera (§0 fila 8) |

---

## 4. Decisiones a firmar

| # | Decisión | Opciones | Recomendación |
|---|---|---|---|
| **DCH1** | El papel. **Chequera de libro, 3 cheques por hoja; la hoja se desprende del libro y después el cheque de la hoja** (Francisco, 2026-11-19); medidas y copia de cada cheque por llegar | (a) imprimir sobre la hoja desprendida · (b) llenar a mano copiando una **hoja de llenado** que imprime la Suite · (c) pedir al banco chequera para impresora | **(a), con (b) mientras se calibra.** ✅ **Cómo se imprime** (Francisco, 2026-11-19): **el cheque suelto, centrado en la impresora, y detrás 2 hojas blancas de póliza.** La plantilla es el cheque de cada banco, centrado; la póliza, hoja carta. ⚠️ **Al desprender un cheque, los otros de su hoja quedan sueltos y en blanco**: la Suite lleva qué folios están desprendidos y sin usar («5408 y 5409 sueltos») y propone usarlos primero. La hoja de llenado (b) sigue sirviendo si la impresora falla. La calibración, con las medidas y la copia |
| **DCH2** | Qué es «liberar». ✅ **Contestada** (Francisco, 2026-11-19): **el banco libera la chequera; Caja General libera cada cheque en el portal con número, beneficiario e importe** | — | Dos pasos con quién y cuándo: «chequera liberada por el banco» al recibirla, y «cheque liberado» por Caja General. La Suite **no entra al portal** (credenciales del banco: regla del repo). Le da a Caja General la lista **«por liberar»** —sólo cheques firmados, entregados y **confirmados** por la llamada del proveedor— con **número, beneficiario e importe exactamente como se imprimieron**, cada uno con su botón de copiar, para no recalcular ni reescribir el nombre; Caja General marca «liberado» con un clic. Si el portal acepta archivo, se agrega después (no se preguntó) |
| **DCH3** | Cuentas | (a) sólo 4166 · (b) 4166 y 2169 a la vez · (c) chequeras y embudo para las dos; impresión y Calendario primero en 4166; 2169 con **cheque suelto** | **(c).** El folio es papel del banco, se pague a quien se pague: el control no puede ser de media chequera. El contenido de la nómina (a quién, cuánto) sigue siendo de RH; el cheque suelto pide beneficiario, concepto, importe y motivo, y aparece en el día del Calendario como «fuera de programa» (ya existe) |
| **DCH4** | Cuándo se amarra el folio (cambia D7) | (a) al autorizar (D7) · (b) al imprimir, confirmando contra el papel en la mano | **(b).** El número ya viene impreso por el banco (con su banda magnética): la Suite no lo asigna, lo **predice** (el siguiente de la chequera activa) y la persona confirma *«el cheque en la impresora es el 5407»*. Un pago autorizado que se cancela no quema folio; un atasco sí, y se anula con motivo |
| **DCH5** | Cuándo se entera Kepler | (a) al emitir, con la fecha del cheque · (b) al cobro, como hoy, pero escrito por la Suite cuando la descarga muestra el número | **(b).** Conserva la práctica de Contabilidad (fecha del cobro; además es la que pesa en lo fiscal para un pago con cheque — lo confirma Contabilidad), cierra los 9 cobrados sin capturar ($1.85 M) y el disparador es exacto. El Calendario sí cambia: «emitido» al imprimir (sus facturas ya no se ofrecen a otro pago) y «cobrado» al aparecer en la descarga. (a) haría que Kepler y el banco difieran todos los días por el tránsito: si se quiere, la decide Contabilidad aparte |
| **DCH6** | 4166 bloqueada (D7) | mantener · desbloquear | **Desbloquear para cheques.** Si el bloqueo era por otra razón (la línea LEM, factoraje), que se escriba aquí |
| **DCH7** | El cheque que no se cobra: arrastre, límite y paso a transferencia | — | **Arrastre sin reprogramar:** el cheque se queda en su día (la fecha está impresa) y aparece cada día siguiente como «en tránsito, N días», sumando a los fondos de su cuenta, hasta cobrarse o cancelarse; **`[PGP.117]` no lo libera nunca** (`[PGP.173]`). Aviso a Tesorería a los **10 días** sin cobro (más del triple de la mediana) y a quien autoriza a los **15** (plazo de presentación en la misma plaza, LGTOC art. 181). **Cancelar** pide motivo y la foto del cheque cancelado (o «no se imprimió»); si ya estaba liberado, la marca de que se canceló la liberación en el portal. **Pasar a transferencia** es una acción sobre el mismo pago: anula el folio, conserva las facturas y el importe, cambia el método (`[PGP.175]`) |
| **DCH9** | La llamada de «confirmado». **Quién la recibe, contestado** (Francisco, 2026-11-19): **Tesorería; en su ausencia, Analista de Egresos o Caja General** | contra qué se valida | Quien la recibe marca quién llamó, a qué hora y desde qué teléfono; **libera Caja General**. El permiso de confirmar va **a la persona, no al puesto**: Analista de Egresos está **vacante** (2026-11-19) y en `MATRIZ_ACCESOS` figura «sin definir»; mientras tanto confirman Tesorería o Caja General. **Se valida contra un contacto registrado del proveedor, no contra el número que da quien llama**: un cheque robado más una llamada es una liberación. Hoy la Suite no guarda ningún teléfono de proveedor: se registra el contacto de los acreedores que se pagan con cheque (9 con hábito «cheque»; 81 acreedores con algún cheque en 2026, incluido gasto). Mientras no exista, el «confirmado» lleva la nota «sin contacto registrado» |
| **DCH8** | Leyenda y nombre | — | **«PARA ABONO EN CUENTA DEL BENEFICIARIO»** en todo cheque a proveedor (los 16 cobros con número de 4166 en nov fueron por Cámara de compensación: depositados); nómina sin leyenda (2169 se cobra en ventanilla). **El nombre sale de la factura del SAT** (emisor del CFDI), no de Kepler (2 de 81 con la Ñ perdida); si no hay CFDI, lo confirma una persona. **El nombre impreso y el que Caja General libera son la misma cadena**: el portal lo pide, y un nombre reescrito es otra forma de que no coincidan |

Lo que firmar no destraba: DCH1 espera **las medidas y la copia de cada cheque**. Ninguna decisión frena `[PGP.173]`
ni los frentes 0 y 1.

### 4a. Lo que le falta al proceso (la respuesta a «¿qué nos está faltando?»)

| # | Falta | Por qué importa (medido) | Item |
|---|---|---|---|
| 1 | ⛔ **Que la liberación a la semana no suelte un cheque emitido** | Ya soltó el 5383 ($242,869.77). Hoy no suelta otro sólo porque la descarga va atrasada y porque Tesorería «mueve» el pago cada día (ensayo en seco, §1). Con la descarga al día, un cheque entregado y sin depositar a los 7 días se liberaría, sus facturas volverían a ofrecerse y, si después el proveedor llama y se libera, **se paga dos veces** | `[PGP.173]` |
| 2 | **Que «cheque → transferencia» deje registro** | 7 de 28 cheques numerados ($1,304,085.11) salieron por SPEI sin cambiar nada en el Calendario. Los 7 se cancelaron en papel, pero eso sólo lo sabe quien los canceló: el Calendario sigue diciendo «cheque», y el 5399, «pendiente». Kepler registró uno (5352) como cheque de 4166 que el banco nunca pagó | `[PGP.175]` |
| 3 | **El arrastre como fondos, no como reprogramación** | Hoy se «mueve» el pago (10 copias canceladas). La cifra que hace falta es **cuánto dejar en cada cuenta**: cheques del día + los que siguen sin cobrar, contra el saldo de la descarga. El único devuelto de 2026 fue por fondos (17-jul) | `[PGP.174]` |
| 4 | **Validar la llamada contra un teléfono registrado** | La llamada es el control que decide liberar; hoy no deja rastro y la Suite no tiene a qué teléfono compararla | DCH9, `[PGP.169]` |
| 5 | **Que la fecha no se tome como protección** | Hay 5 cheques fechados del 7 al 14-dic ($586,079.27), **ya entregados**. El cheque es pagadero a la vista aunque traiga fecha futura (LGTOC art. 178): sólo la liberación lo detiene. Ninguno se libera antes de su día sin una autorización con nombre | `[PGP.169]` |
| 6 | **La póliza firmada de vuelta en la Suite** | Es la prueba de entrega (quién recibió, cuándo) y el desglose explica al proveedor por qué el cheque es menor que la factura (notas de crédito, descuentos: el caso Mondelez del anexo C §4b). Hoy se queda en papel | `[PGP.168]` |
| 7 | **Que la confirmación del día siguiente la haga la Suite** | Caja General revisa hoy el estado de cuenta a mano; la descarga ya trae el número de cheque. Caja General se queda sólo con lo que no casó | `[PGP.166]` |
| 8 | **Que Kepler reciba el documento correcto** | Al cobro, `X-D-25`; si se pasó a transferencia, `X-D-26`, nunca los dos | `[PGP.171]`, `[PGP.175]` |

---

## 5. Qué NO incluye

- **Operar el portal del banco** (activar chequera, proteger, revocar): lo hace una persona; la Suite da el dato y
  registra que se hizo. Regla del repo: credenciales.
- **Los cheques que recibimos** de clientes y rutas (Caja General y libro de efectivo).
- **El contenido de la nómina** (RH). Sólo el cheque.
- **Firmar el cheque**: ni firma autógrafa ni firma escaneada impresa.
- **Escribir en ContPAQi** (ADR-040): la póliza sigue saliendo del `X-D-25` como hoy.
- **La banda magnética y el folio impreso**: los pone el banco en el papel.
- **Corregir los 153 cancelados de 2026** ni los `X-D-25` viejos.

---

## 6. El orden

| Orden | Frente | Item | Dinero | Esfuerzo | Prioridad | Por qué ahí |
|---|---|---|---|---|---|---|
| ⛔ 0 | **El cheque emitido no se libera a la semana ni se «mueve»**: se arrastra hasta cobrarse o cancelarse | `[PGP.173]` | **Crítico** · un doble pago por cheque; $586,079.27 entregados con fecha del 7 al 14-dic | S | **0** | Mismo tipo de falla que `[PGP.149]`; ya pasó con el 5383. Funciona con los cheques de hoy (método «cheque» + folio en referencia). Tiene que estar antes de que la descarga se suba al día |
| 0 | **Un solo importe**: centavos enteros, letra correcta, hoja de llenado | `[PGP.165]` | Alto · ~$5.7 M/mes en cheques | S | **1** | Quita la calculadora desde el día 1 con la chequera de hoy (DCH1-b). No espera firma salvo DCH8 |
| 1 | **El cobro por número**: la descarga cierra el cheque | `[PGP.166]` | Alto · $1.52 M «pendientes» ya cobrados; $1.85 M cobrados sin Kepler | S–M | **1** | El árbitro ya existe; arregla el estado del Calendario de los cheques de hoy aunque se sigan llenando a mano |
| 2 | **Chequeras**: recibir, liberar, existencia de folios | `[PGP.167]` | Alto (control: 17 folios sin paradero) | M | **1** | Sin chequera no hay folio que confirmar al imprimir |
| 3 | **Emitir e imprimir** al elegir «cheque» en el pago del Calendario: cheque + póliza con desglose y recibí | `[PGP.168]` | Alto · $15.4 M en 90 días | M | **1** | Depende de DCH1, DCH4 y del frente 2; se calibra con papel real |
| 4 | **Firmar, entregar, confirmar y liberar** con el dato exacto | `[PGP.169]` | Alto | S–M | **1** | DCH2 ✅, DCH9. Es donde nace el rechazo por centavos y donde se decide pagar |
| 4b | **Fondos a dejar** por cuenta (cheques del día + arrastre) en el programa del día impreso | `[PGP.174]` | Alto · ~$5.7 M/mes pasan por esos fondos | S–M | **1** | Lo pidió Francisco en la impresión del programa; el único devuelto medido fue por fondos |
| 4c | **Cheque → transferencia** con registro | `[PGP.175]` | Alto · $1,304,085.11 en noviembre sin rastro | S–M | **1** | DCH7 |
| 5 | **El embudo** y sus avisos | `[PGP.170]` | Medio | M | 3 | Sobre los estados de 1–4 |
| 6 | **`X-D-25` en Kepler al cobro** (era `[PGP.133]`) | `[PGP.171]` | Alto · ~74 capturas al mes | M | **1** | Misma compuerta y ensayo que el `X-D-26` de `[PGP.130]`; depende de DCH5 y, fuera de 00, de D4 del anexo C |
| 7 | **Cheque suelto** (2169: nómina y gasto) | `[PGP.172]` | Medio · $1.6 M en 90 días | M | 3 | DCH3 |

**Esfuerzo del anexo: L** (2–4 semanas). **Primero `[PGP.173]` (S, evita el doble pago), después los frentes 0 y 1
(S + S–M)**, que se llevan la mayor parte del valor: el importe único y el estado verdadero de cada cheque, sin
esperar al papel ni a ninguna firma.

---

## 7. Las capas

### C0 — el dato (✅ medido 2026-11-19)

- **Árbitro:** la descarga del banco por número de cheque (§1). Control placebo 0. Cobertura de la descarga:
  4166 desde el 1-nov, 2169 desde el 9-nov (antes, el libro).
- **Fuente del importe:** lo aplicado a cada factura en el pago del Calendario (`payment_allocation_items`) menos sus
  descuentos (`descuento-al-pagar.ts`), **en centavos enteros**. Nunca un importe tecleado.
- **Fuente del nombre:** emisor del CFDI de la factura (`fiscal.cfdis`); de respaldo, el catálogo, confirmado (DCH8).
- **NO MEDIDO:** §9.

### C1 — el dominio

- **`importeConLetra(centavos)`** en `libs/` (ADR-056: es un primitivo, no una copia). Se **sube** el de
  `anexo-venta.service.ts` y se corrige («un» delante de mil y millones, «de pesos» en millones exactos, entrada en
  centavos enteros). El anexo de venta pasa a consumirlo. Prueba con los casos de §3 fila 5 y con los 222 importes
  reales de 90 días.
- **Motor del cheque** (puro): importe = Σ aplicado − Σ descuentos en centavos; el folio siguiente de la chequera
  activa; la máquina de estados:
  ```
  programado (Tesorería, Calendario) ─ al elegir «cheque»: folio, fecha = día del Calendario, beneficiario, importe
    → impreso (cheque + póliza con desglose)  → firmado (Dirección General)
    → entregado (póliza de recibido firmada)  → confirmado (llamada del proveedor, Caja General)
    → liberado (Caja General, en el portal)   → cobrado (descarga, por número) → en Kepler (X-D-25)
  sin cobro al día siguiente → en tránsito: se arrastra cada día (fondos) hasta cobrado o cancelado
  cancelado → anulado el folio (motivo + foto) → el mismo pago sigue por transferencia (X-D-26)
  devuelto por el banco → motivo (sin liberar / fondos / otro) → reponer o transferir
  ```
  Cada transición con quién y cuándo. ⛔ No se libera sin firma ni sin «confirmado», ni antes del día del cheque
  sin una autorización con nombre (la fecha no protege: LGTOC art. 178). ⛔ `[PGP.117]` no libera ni «mueve» un
  pago cuyo cheque ya se imprimió.
- **Los cheques sueltos:** la chequera guarda el folio con el que abre su primera hoja (3 por hoja); al desprender un
  cheque, sus compañeros de hoja quedan «sueltos en blanco» y la Suite los propone primero. Un folio no se reimprime.
- **Tablas** (datos propios, no copia; `tenant_id` + auditoría; migración generada e idempotente):
  `finance.checkbooks` (cuenta, folio desde/hasta, recibida y liberada por/cuándo, estado, desplazamiento de
  impresión) · `finance.issued_checks` (chequera, folio, pago del Calendario o nulo si es suelto, beneficiario,
  importe en centavos, fecha, leyenda, estado, renglón de la descarga que lo cobró, documento de Kepler; `UNIQUE`
  cuenta + folio; quién recibió y la foto de la póliza firmada; la confirmación: quién llamó, cuándo, desde qué
  teléfono) · `finance.issued_check_events` (bitácora, sólo se agrega) · el **contacto del proveedor para confirmar
  cheques** (dato propio: hoy no existe en ninguna tabla; DCH9).
- **La póliza** sale del mismo pago: cada factura con lo aplicado, cada nota de crédito y descuento que la bajó
  (las lecturas de `[PGP.147]` y `descuento-al-pagar.ts`), y el total = el cheque, al centavo. Hoy se llena con
  papel carbón debajo del cheque y el número se pone a mano; con la Suite se imprimen **2 pólizas en hoja blanca**
  detrás del cheque: cada una **repite el cheque** (folio, fecha, beneficiario, importe con número y letra), **anexa
  los documentos pagados** y lleva **el nombre de quien recibe el cheque** (Francisco, 2026-11-19). Ese nombre sale
  del **contacto registrado del proveedor** —el mismo contra el que se valida la llamada (DCH9)—; si no hay, va la
  línea en blanco. Al marcar «entregado» se anota quién lo recibió de verdad y se sube la foto de la póliza firmada.
- El número de cheque deja de teclearse: `reference_text` del pago lo llena la Suite (el Preliminar y la orden
  impresa siguen leyendo de ahí).

### C2 — la API

- Chequeras: recibir (rango) y liberar. Rechaza un rango que se encime con otro de la misma cuenta.
- Emitir: del pago **autorizado** con método cheque → confirma el folio → devuelve el PDF (cheque u hoja de
  llenado). El importe lo pone el servidor; la pantalla no lo manda.
- Liberado · entregado · anulado · devuelto.
- **Cobro:** dentro de la pasada que ya lee la descarga (`[PGP.121]`/`[PGP.146]`), **no un cron nuevo**: por número
  de cheque y cuenta → «cobrado»; si el importe del banco no es el emitido, hallazgo en rojo con los dos importes.
- `X-D-25`: el armador de `[PGP.130]` con `c4 = 25`, `c31 = 'Che'`, `c11 = 'CH-<folio>'` (ERP_KEPLER §3.z.5), la
  misma compuerta (lee Kepler en vivo antes de escribir) y el ensayo con ROLLBACK.
- Permisos propios (ADR-054), uno por acto, **repartidos** en prod antes de dar el frente por entregado (regla 20):
  emitir e imprimir (`tesoreria`), marcar firmado (`direccion`), liberar (Caja General). ⛔ Liberar **no** se da por
  el rol `cajero`: ese rol lo tienen 29 usuarios, también los cajeros de sucursal (`MATRIZ_ACCESOS`); va a la
  persona de Caja General.
- Cada endpoint que escribe: prueba contra base real en el CI con el payload de la pantalla (regla 13).

### C3 — la pantalla (se detalla al abrir el frente 3, con las cinco preguntas de `diseno` §0b)

- **Al elegir «cheque» como forma de pago** (en «Preparar»): se despliega el cheque —folio que toca, fecha del día
  del Calendario, beneficiario, importe (no editable) y la póliza con su desglose— y el botón de imprimir.
- **En la fila del pago con cheque del Calendario:** su estado en palabras: *«Cheque 5407 · BAJÍO 4166 ·
  $107,446.93 · entregado, falta que confirme el proveedor»* … *«cobrado el vie 13»* … *«en tránsito, 4 días»*.
- **El programa del día impreso** (el Preliminar): en cada cheque, «dejar fondos» y «liberar en la página del banco
  cuando el proveedor confirme»; por cuenta, **los fondos a dejar** (cheques del día + los arrastrados).
- **«Por firmar»** para Dirección General: los cheques impresos del día (folio, beneficiario, importe, a qué facturas
  paga), para firmar el papel y marcarlos.
- **«Por confirmar y liberar»** para Caja General: los entregados; al llamar el proveedor, «confirmado» (quién,
  cuándo, teléfono contra el registrado) y la fila pasa a liberar, con número, beneficiario e importe tal como se
  imprimieron y un botón de copiar en cada uno. Al día siguiente, sólo lo que el banco no casó. Va donde Caja General ya trabaja (la Ventanilla de la fase LE): se
  decide en C3 con `diseno`, sin duplicar pantallas.
- **Bancos › Chequeras:** recibir (con la fecha en que el banco la liberó), cuántos folios quedan, usados y anulados.
- **El embudo:** cuántos y cuánto en cada etapa, días en ella, y los que pasan del aviso.
- **Calibración:** una hoja de prueba en papel blanco para empalmar contra un cheque real.

---

## 8. Riesgos y bloqueos

| Bloqueo | Dueño | Causa | Qué lo destraba |
|---|---|---|---|
| Sin medidas no hay calibración | Francisco / Tesorería | las medidas y la copia de cada cheque están por llegar | con ellas, la plantilla del cheque centrado, por banco; mientras tanto, la hoja de llenado |
| Cheques en blanco sueltos | quien imprime | al desprender uno, sus compañeros de hoja quedan fuera del libro | la Suite los lleva como «sueltos en blanco» y los propone primero |
| Cada impresora mueve la hoja distinto | Tesorería | calibración | desplazamiento guardado por chequera e impresora; hoja de prueba |
| Doble registro en Kepler en la transición | dueño del frente 6 | Tesorería sigue capturando al cobro | la compuerta lee Kepler en vivo; el capturado a mano se liga por folio |
| Días sin descarga | Tesorería | la descarga se sube a mano | D5-a del anexo C; el cheque se queda «sin medir», no «sin cobrar» |
| `X-D-25` fuera de 00 | quien administra Kepler | permisos de `kepler_push` | D4 del anexo C |
| El papel en blanco | Tesorería | chequeras sin control | la chequera se recibe en la Suite con su rango; un folio fuera de rango o repetido se rechaza; el anulado lleva foto |

---

## 9. NO MEDIDO — preguntas para Tesorería

1. ~~Cuántos cheques se devolvieron por diferencia~~ — **sin dato; Francisco estima menos de 2 %** (2026-11-19). Para
   medirlo de aquí en adelante, la Suite registra el estado `devuelto` con su motivo.
2. ~~El formato del papel~~ — **libro, 3 cheques por hoja; la hoja se desprende y después el cheque** (2026-11-19).
   **Falta:** las medidas y una copia de cada cheque (BAJÍO 4166 y SANTANDER 2169) para calibrar.
3. ~~Qué es «liberar»~~ — **el banco libera la chequera; Caja General libera cada cheque con número, beneficiario e
   importe** (2026-11-19).
4. ~~Quién firma~~ — **Dirección General**; **Tesorería programa**; **Caja General libera** (2026-11-19).
5. **Por qué D7 bloqueó 4166.**
6. Los 17 folios sin paradero de 4166: ¿anulados, en tránsito fuera del Calendario o sin usar? (5404 y 5405 pueden
   seguir en la chequera.) Los folios de 2169 no se midieron: su descarga empieza el 9-nov.
7. ~~Dónde están los cheques 5352, 5362, 5368, 5371, 5373 y 5376~~ — **cancelados** (2026-11-19). **Falta:** corregir
   en Kepler el `X-D-25` del 5352 (cheque de 4166 por $316,608.40 que salió por SPEI de 2169 por $316,608.23): persona.
8. ~~La póliza~~ — hoy, **papel carbón y el número a mano** (2026-11-19).
9. ~~Los cheques fechados a futuro~~ — **todos los del Calendario están entregados** (2026-11-19).
10. ~~Quién recibe la llamada~~ — **Tesorería; en su ausencia, Analista de Egresos (vacante) o Caja General**
    (2026-11-19). **Falta:** un teléfono registrado por proveedor.
11. ~~El cheque 5399~~ — **cancelado** (2026-11-19). Falta reflejarlo en el Calendario (hoy no hay cómo: `[PGP.175]`).
12. ~~Cómo se imprime~~ — **el cheque centrado y 2 hojas de póliza**; el nombre de la póliza es **el de quien recibe
    el cheque** (2026-11-19).

---

## 10. DoD

- [ ] 1. Métrica remedida con la misma consulta: cobrados que la Suite conocía al centavo, antes (9 de 43) / después; folios sin paradero, antes (17 de 74) / después
- [ ] 2. Cada capa verificada o declarada NO MEDIDA
- [ ] 3. Cada escritura (chequera, emitir, anular, `X-D-25`) ejercida contra base real; el `X-D-25`, ensayado contra el Kepler vivo con ROLLBACK
- [ ] 4. Compuertas rotas a propósito una vez: folio repetido, importe tecleado distinto al del servidor, cobro por importe distinto al emitido, **`[PGP.117]` frente a un cheque impreso y sin cobrar (debe conservarlo)**, liberar sin «confirmado»
- [ ] 5. Sin primitivo nuevo: `importeConLetra` en `libs/`, el cobro dentro de la pasada de `[PGP.121]`, el `X-D-25` con el armador de `[PGP.130]`
- [ ] 6. Tracker + `03_LOG_REVISIONES.md`
- [ ] 7. En prod con el permiso repartido, y el primer cheque real impreso, liberado y cobrado sin diferencia

## 11. Bitácora

- **2026-11-19** — Plan (pedido de Francisco). Universo y árbitro medidos en prod, sólo lectura. DCH1–DCH8 para
  Edgar; §9 para Tesorería.
- **2026-11-19** — Francisco contesta §9: devueltos sin dato, se estiman en menos de 2 %; chequera de libro, 3 por hoja;
  el banco libera la chequera y el titular libera cada cheque; firma Dirección General. DCH2 queda contestada; el flujo
  gana «firmado» y la lista «por firmar y liberar»; DCH1 espera las medidas y la copia de cada cheque.
- **2026-11-19** — Segunda respuesta: la hoja se desprende del libro (se imprime sobre la hoja: DCH1-a, con control de
  la hoja abierta); libera **Caja General**, firma Dirección, programa Tesorería; el portal pide número, beneficiario
  e importe. Las listas se separan («por firmar» y «por liberar») y cada acto lleva su permiso.
- **2026-11-19** — Francisco describe el proceso completo y pregunta qué falta (§0 fila 8, §4a). Medido al revisarlo:
  los 6 «pagados sin cobro» salieron por SPEI ($1,266,410.73; corrige la primera versión), la liberación a la semana
  soltó el cheque 5383 el 17-nov, hay 5 cheques fechados del 7 al 14-dic y la Suite no guarda teléfonos de
  proveedor. Nuevos: `[PGP.173]` (prioridad 0), `[PGP.174]`, `[PGP.175]`, DCH9.
- **2026-11-19** — Respuestas: los 6 cheques que se pagaron por SPEI están cancelados; la póliza va con papel carbón
  y el número a mano; todos los cheques del Calendario están entregados; la llamada la recibe Tesorería (o Analista
  de Egresos o Caja General). Ensayo en seco de la liberación a la semana con sus consultas reales: hoy no suelta
  ninguno, con la descarga al día sí. Aparece un séptimo cheque pagado por SPEI (5399, $37,674.38), «pendiente»
  en el Calendario: 7 de 28, $1,304,085.11 (corrige «6 de 22»).
- **2026-11-19** — El 5399 también está cancelado. Se imprime cheque por cheque, centrado, más 2 pólizas que repiten
  el cheque, anexan lo pagado y llevan el nombre de quien recibe el cheque (DCH1 deja la plantilla de 3 posiciones). Analista
  de Egresos, vacante.
