# Fase PGP — Anexo CL: el cuadre de los libros del pago (Calendario, Kepler, banco y SAT)

> Anexo de [`FASE_PGP_PAGO_A_PROVEEDOR.md`](FASE_PGP_PAGO_A_PROVEEDOR.md). El método: [`docs/METODO_DE_TRABAJO.md`](../../METODO_DE_TRABAJO.md).
> **No es una fase nueva:** son los items `[PGP.197]`–`[PGP.201]` de la fase PGP ya abierta. La trampa, resumida, está en
> [`GOTCHAS.md` §95](../../GOTCHAS.md).
> ⛔ El repo es público: aquí van conteos, códigos de acreedor y folios; **sin importes en pesos ni nombres de personas**.
> Las cifras con pesos están en el chat del 2026-11-23 y se vuelven a sacar corriendo las consultas de §5.

## 0. Por qué existe este documento

Edgar, 2026-11-23, después de un mes de arreglos al Calendario de Pagos:

> *«Estás causando mucha desinformación en el calendario de pagos por no terminar nada. Vuelve a hacer un análisis:
> pagos dobles, facturas vencidas, pagos sin escribir.»*
> *«¿Por qué no se solucionaron o se analizaron estos problemas desde raíz? Si ya están estos problemas, ¿qué otros aún
> no descubrimos?»* · *«Necesito que hagamos un análisis aún más profundo.»* · *«Documentemos estos hallazgos para la
> próxima hacer un mejor trabajo.»*

Entre el 2026-10-26 y el 2026-11-22 entraron más de veinte items al Calendario (`[PGP.94]`, `[PGP.117]`, `[PGP.132]`,
`[PGP.147]`, `[PGP.148]`, `[PGP.149]`, `[PGP.184]`, `[PGP.190]`…). Cada uno arregló bien **su** caso. Ninguno preguntó si
los libros del pago cuadran entre sí, y por el hueco pasó **un pago doble con dinero** (CD031, factura `20-1-0009890` de
CEDIS: Tesorería la pagó el 9-nov fuera del Calendario y el Calendario la volvió a pagar el 13-nov; las dos
transferencias, al mismo beneficiario, están en la descarga del banco). Buscando después **por regla y no por caso**,
en una mañana aparecieron cinco clases de problema que nadie había visto.

## 1. El método: cómo se analiza el ciclo del pago (para la próxima)

1. **Empezar por las reglas, no por el caso.** El reporte («se pagó doble», «hay vencidas que ya pagamos») es un
   síntoma. Antes de arreglarlo se corren las reglas de §2 sobre **todo** el universo; el caso reportado es una fila más.
2. **Uno a uno, no por conteo.** «Hay una salida del banco por ese importe» no basta: una salida no puede explicar dos
   pagos. Se empareja por cuenta (Kepler `kdxe.c22` ↔ `bank_accounts.account_label`) y por rango (`row_number` por
   cuenta + importe, ordenado por fecha), y se cuenta lo que sobra de cada lado.
3. **Cada cruce por importe lleva su control negativo** (el mismo cruce con +$100 o con la fecha corrida). El
   2026-11-23: 16 pagos cancelados con salida por su importe exacto contra **1 de 177** en el control: eso sí es señal.
4. **Medir primero la calidad de cada testigo.** Ninguna fuente es la verdad sin medirla (§4). El 2026-11-23 se sospechó
   del libro del banco (el Excel de Finanzas) porque traía «pares repetidos»; medido contra la descarga resultó **copia
   fiel** del banco, y los pares eran **SPEI devueltos** (la salida y su devolución el mismo día). La descarga empieza en
   noviembre y casi nunca trae al beneficiario; Kepler tiene facturas capturadas dos veces y pagos de efectivo marcados
   como «transferencia». La sospecha también se mide antes de afirmarla.
5. **Recorrer todos los caminos al mismo hecho.** La factura derivada de Kepler y la obligación capturada son la misma
   deuda por dos caminos; transferencia, cheque y efectivo son el mismo pago por tres; la Suite y Tesorería escriben en
   el mismo Kepler. Una regla que se aplica a un camino y no al otro **es el hueco** (así entró el pago doble de CD031).
6. **Recorrer también los caminos de vuelta.** Cancelar, reprogramar, liberar por vencimiento, partir en transferencias,
   cancelar en Kepler. Cada uno puede dejar la factura «por pagar» con el dinero ya fuera.
7. **Un motivo de rechazo no es una clasificación.** «Kepler ya la tiene saldada» (motivo del escritor del `X-D-26`)
   resultó ser tres cosas distintas: el mismo pago capturado por Tesorería, un pago doble y una nota de crédito no
   descontada. Sólo el banco las separa.
8. **Declarar el universo y lo NO MEDIDO.** Qué fechas, qué cuentas, qué quedó fuera; lo que no se pudo medir se escribe
   así, no se dibuja como cero.

## 2. Las reglas del cuadre (lo que debe ser cierto siempre)

| # | Regla | Estado medido el 2026-11-23 |
|---|---|---|
| R1 | Cada salida del banco a un proveedor tiene su pago en Kepler, y cada pago de Kepler con dinero tiene su salida | ⚠️ 98 % de los pagos de Kepler en cuentas bancarias tienen su salida; 66 sin salida y salidas a proveedor sin pago en Kepler (§3.B) |
| R2 | Ninguna factura recibe más dinero que su importe | ⚠️ Hay facturas pagadas dos veces en Kepler (§3.A3, §3.C) |
| R3 | Ninguna factura del proveedor está dos veces en Kepler | ❌ Hay duplicadas, también entre sucursales (§3.C) |
| R4 | Ningún pago vivo del Calendario cubre lo que ya se pagó ni más de lo que se debe | ❌ Pagos en borrador sobre facturas ya pagadas (§3.A4) |
| R5 | Una salida del banco que se devolvió no cuenta como pago | ⚠️ 13 SPEI devueltos desde septiembre; el testigo «salió del banco» (`[PGP.149]`) compara sólo `amount_out` (§3.B) |
| R5b | Un pago que sale en varias transferencias se reconoce como pagado | ❌ Effem: pagado el 18-nov en dos SPEI y sigue «pendiente» (§3.A4) |
| R6 | Ningún pago se cancela, reprograma o libera con el dinero ya fuera | ❌ 16 cancelados con salida del banco (§3.A1) |
| R7 | Cada pago del Calendario que salió del banco está escrito en Kepler o tiene un motivo que lo explica | ⚠️ 15 sin escribir, reclasificados con el banco (§3.A2) |
| R8 | Cada cheque cobrado deja el pago pagado y su `X-D-25` en Kepler | ❌ 3 cheques cobrados siguen «pendientes» (§3.A5) |
| R9 | Cada factura de Kepler tiene su CFDI vigente, y cada CFDI recibido de un acreedor tiene su factura en Kepler | ❌ En compras casa el 70 % de las facturas; RFC faltantes o contradichos; CFDI cancelados pagados sin sustituta (§3.D) |
| R10 | Lo que el Calendario ofrece pagar es deuda viva en Kepler, una sola vez | ✅ desde `[PGP.197]` para las capturadas; ❌ mientras haya duplicadas (R3) |

`[PGP.198]` las vuelve un cuadre permanente: se recalculan con cada carga del banco y cada aviso de Kepler (sin reloj),
cada una con su conteo y su lista, y cada caso le llega a quien lo resuelve.

## 3. Lo encontrado el 2026-11-23

### 3.A El Calendario contra la realidad

1. **Cancelar con el dinero ya fuera (R6) — la raíz del pago doble de CD031.** El Calendario deja cancelar o reprogramar
   un pago aunque su dinero ya haya salido; sus facturas vuelven a «por pagar». **16 pagos cancelados** tienen una salida
   del banco por su importe exacto dentro de los 30 días siguientes, que ningún otro pago explica (control: 1 de 177).
   En la mayoría Tesorería ya capturó el pago en Kepler y la factura no se vuelve a ofrecer (sólo queda historia falsa en
   el Calendario); en CD031 la factura era una obligación **capturada** que no se medía contra Kepler, y se pagó otra
   vez. Por confirmar con el estado de cuenta: CR002 (dos salidas iguales el mismo día desde dos cuentas) y GE002
   (facturas del pago cancelado del 5-nov que se pagan otra vez el 12-nov). → `[PGP.199]`.
2. **Pagos que salieron del banco y no están en Kepler (R7): 15.** Separados con el banco: 6 ya los había capturado
   Tesorería (mismo importe y día: falta ligarlos); 3 son pagos de más (el doble de CD031 y dos pagos a CD015 por el total
   sin descontar notas de crédito ya aplicadas); 5 son acreedores de gasto sin pago anterior; 1 es un anticipo.
3. **Kepler con el mismo pago capturado dos veces y una sola salida:** CP012 `20-0008304` (CEDIS, `26-0024041` y
   `26-0024049`). Error de captura, no dinero; lo cancela Tesorería.
4. **Pagos en borrador que pagan doble si alguien los autoriza (R4, R5b):** uno del 26-oct cuyas facturas, salvo una,
   se pagaron ese mismo día; uno del 23-dic que lleva una factura pagada el 8-oct; uno del 3-nov con una factura duplicada
   en Kepler ya pagada; y ⛔ **el de Effem (CE012) del 18-nov, que YA SE PAGÓ ese día** en dos SPEI desde BBVA 4176 con la
   misma referencia (`018112610087`, que lleva el folio de la factura `0010087`): sumados dan la factura completa, sin
   descontar las notas de crédito que Kepler ya le había aplicado, y Kepler todavía no tiene el pago. El carril del banco
   busca **una** salida por el importe del pago y no la encuentra. Ninguno de los cuatro está autorizado. El cierre de
   `[PGP.132]` no los toca porque no **todas** sus facturas están saldadas, y el ajuste de `[PGP.148]` sólo corre sobre
   días por venir.
5. **Cheques cobrados que siguen pendientes (R8):** 3 cheques (5377, 5381, 5384) cobrados por Cámara de Compensación el
   18 y 19-nov; el Calendario los sigue mostrando por pagar y en Kepler sus facturas siguen abiertas (nadie capturó el
   `X-D-25`). El Calendario no reconoce el cobro de un cheque. → `[PGP.200]`.
6. **Lo que sí cuadra:** 0 pagos ejecutados por el banco con importe distinto al del pago; 0 facturas programadas dos
   veces por encima de su importe; 1 liga a un pago que Kepler canceló después (GR001, Canindo).

### 3.B Banco contra Kepler

Universo: pagos de Kepler 25/26/45/60 vigentes del 1-oct al 17-nov (sin `TI*`), emparejados uno a uno por cuenta
(`kdxe.c22` ↔ `account_label`), importe ±$1 y fecha; del lado del banco, el libro más las líneas de la descarga que el
libro no tiene, sin las salidas devueltas.

1. **El libro (Excel de Finanzas) es copia fiel del banco.** Noviembre, contra la descarga en 14 cuentas: 799 de 807
   salidas del Excel están en la descarga (las que sobran caen en días que la descarga no trae, o son dos comisiones; las
   que faltan son del día en que se subió el Excel); 1,496 de 1,572 renglones traen el **saldo** exacto del banco
   (control: 0). Octubre, donde sólo hay Excel: 5,407 de 5,414 renglones encadenan con el saldo anterior. Lo que esta
   prueba no detecta: un saldo editado a mano para que cuadre.
2. **Los «pares repetidos» eran SPEI devueltos** (salida y devolución el mismo día; el saldo lo prueba): 13 desde
   septiembre, 12 con su devolución. ⚠️ El testigo «salió del banco» de `[PGP.149]` compara sólo `amount_out`: una
   salida devuelta cuenta como pago.
3. **Kepler contra banco, uno a uno:** de los pagos de Kepler en cuentas bancarias, **98 %** tienen su salida; quedan 66
   sin salida (8 grandes). Control: con +$100 o con la fecha corrida 20 días, **0 de los 504 pagos de $10 mil o más**
   empatan; por debajo de $10 mil el emparejamiento tiene ruido (hasta ~30 %). Los pagos tipo 60 con cuenta bancaria son
   anticipos y no estaban en los cruces anteriores. De las salidas del banco sin pago en Kepler, casi todas son traspasos
   entre cuentas propias, comisiones, tarjeta, créditos y cámara de compensación; **10 salidas a proveedor con nombre y
   26 sin nombre** no tienen pago en Kepler.
4. **Pagos dobles con dinero (además de CD031):**
   - **CH001, factura `20-0000616` de Hidalgo:** se pagó el 30-oct desde BBVA 4176 (no está en Kepler; la Suite creó un
     pago el 2-nov y lo canceló) y otra vez el 12-nov desde BBVA 5712 (Kepler `26-0000570`, con referencia que nombra las
     facturas 616 y 683). Sin reembolso al 23-nov.
   - **CF005, 6-nov:** el mismo importe salió de BBVA 6586 (Kepler `26-0024252`) y de Santander 2169 (el saldo lo
     prueba). En la Suite el pago original se canceló «[reprogramado a 2026-11-06]» y aun así salió.
   Los dos son el patrón R6: el pago se cancela o reprograma con el dinero ya fuera.
5. **Salidas a proveedor sin pago en Kepler:** Effem (ver §3.A4), dos transferencias de CD015 del 5-nov y la de CD031 del
   13-nov (ejecutadas en la Suite, sin escribir), CB005 del 6-nov (Banorte 7133), Barcel del 30-oct (Santander 1604) y un
   SPEI del 10-nov desde Santander 2169 que no está ni en Kepler ni en la Suite.
6. **Pagos en Kepler sin dinero (registros dobles):** las copias pagadas de facturas espejo (CB005 Zamora Centro
   `26-0000227`, CH001 CEDIS `26-0023042`), CP012 capturado dos veces, CA043 (dos SPEI devueltos y uno bueno; Kepler
   tiene dos pagos, uno fechado hacia atrás), y **dos pagos del 28-oct por BBVA 6721 sin ninguna salida en ninguna
   cuenta** hasta el 23-nov (Distribuciones Ayari `26-0023952` en CEDIS y Cabadas `26-0000375` en Hidalgo): Kepler los
   da por pagados y el dinero no salió.
7. **Pagos con la cuenta equivocada en Kepler** (hay dinero, la cuenta está mal): dos registrados en «0001 DEVOLUCIONES»
   (Ferrero en Canindo, BYDSA en Morelia Abastos) que salieron de Santander 2169, y uno de CP006 registrado como cheque
   de Bajío 4166 que salió por SPEI de Santander 2169.
8. **Caja General (`0011`):** de 832 pagos de $1,000 o más, 19 encuentran una salida bancaria sin explicar contra 13 del
   control: no hay señal de pagos de banco registrados como efectivo.

**NO MEDIDO:** Caja General (su libro termina el 10-oct); factoraje (sin estado de cuenta); Bajío 3660 en octubre; los
huecos de la descarga de Santander 1604; el destinatario de los renglones de octubre (el Excel no trae CLABE);
devoluciones después del 23-nov; cheques emitidos a fin de mes con cobro a más de 60 días; pagos de Kepler después del
17-nov.

### 3.C La deuda en Kepler y la verdad de lo vencido

Universo: cargos (`kdxe` `c3 = 'A'`) de 2026 y lo vencido de `analytics.v_supplier_payables` sin `TI*` al 2026-11-23.

1. **Más de una cuarta parte de lo «vencido» no es deuda con proveedores.** La vista toma todo cargo de `kdxe`,
   incluidos los de acreedores financieros (tipo 45: créditos bancarios, préstamos, factoraje, tarjetas `TC*`); la Suite
   sólo quita los `TI*`. Son 47 documentos, el **27 %** del vencido. Los 5 documentos «de más de un año» son dos
   préstamos registrados el 1-ene-2025 en CEDIS sin referencia (parecen saldos iniciales) y tres residuos. Aparte, 45
   anticipos solicitados a proveedores (A-45) nunca se pagaron y cuentan como vencidos. → cerrar: separar la deuda
   financiera de la de proveedores en la vista (prefijos `A*`, `TC*`, factoraje, tipo 45).
2. **El «espejo» CEDIS ↔ sucursal: la misma factura capturada en dos servidores.** Antes del corte, CEDIS recapturaba la
   factura de la sucursal y ponía como referencia el código y folio de la otra copia (`10-…` es Hidalgo, `40-…` es
   8 Esquinas): 504 grupos en 2026. El SAT lo confirma (205 copias contra 103 CFDI; control +$100: 0). Control del
   cruce: pares del mismo acreedor, importe y día, 1,337 contra unos 270 por día de desfase; con +$100, 2. Lo normal (399
   grupos) es que CEDIS pague y la sucursal anule su copia con una nota de crédito. **Lo anómalo:**
   - **Una copia pagada y la otra abierta: 52 grupos** — deuda fantasma que el Calendario ofrece para pagar (casi toda
     de CB005).
   - **Las dos abiertas: 1 grupo** — deuda contada dos veces.
   - **Las dos «pagadas» en Kepler: 52 grupos**, pero el banco casi nunca lo confirma: 47 se pagaron las dos veces desde
     Caja General el mismo día (un pago registrado en dos servidores) y sólo 1 grupo muestra dos salidas. CH001 (cuatro
     facturas del 28-ago, pagadas el 9-oct en CEDIS y en Hidalgo) tiene una sola salida.
3. **Duplicados fuera del espejo:** 40 grupos confirmados por el SAT (31 ya anulados con nota) y 49 probables entre
   sucursales con la misma referencia: 2 con las dos abiertas y 9 con una pagada y otra abierta. CB005 `54-1003828`
   (CEDIS y Zamora Centro, pagadas las dos el 6-nov) tiene una sola salida en el libro; la descarga del banco no cubre
   ese día.
4. **Facturas pagadas de más:** Kepler casi no lo permite: 8 cargos en 2026; 5 son facturas a las que se les puso
   importe 0 **después** de pagarse, y 2 tienen el mismo dinero aplicado dos veces (CP012 `0008304` y GFS001 `0006287`).
   Más 2 notas de crédito aplicadas a facturas ya pagadas con dinero (saldo a favor perdido).
5. **Saldo a favor con proveedores: 229 abonos vigentes sin aplicar desde 2024.** La mayor parte son pagos tipo 60
   («otro») con referencia «ANTICIPO» o la clave del proveedor: **anticipos pagados que nunca se aplicaron a su factura**
   (en `kdxf` no existe ningún tipo 45 aplicado). El resto, devoluciones. En varios acreedores el saldo a favor convive
   con facturas «vencidas» del mismo acreedor (CS001: la misma cifra a favor y vencida). En 52 abonos el «por aplicar»
   que guarda Kepler (`c20`) no coincide con la suma de sus aplicaciones.

**Las capas del vencido** (cada documento cuenta una vez, en este orden; porcentaje del vencido de la vista):

| Capa | Documentos | % del vencido |
|---|---:|---:|
| Préstamos de más de un año | 5 | 12.8 % |
| Otra deuda financiera (créditos, factoraje, préstamos, tarjetas) | 42 | 13.7 % |
| Anticipos solicitados y nunca pagados | 45 | 0.6 % |
| Residuos menores a $1 | 205 | ~0 % |
| Cancelada en el SAT o en Kepler | 6 | ~0 % |
| Duplicados (la copia abierta) | 46 | 0.9 % |
| Pagado o acreditado sin aplicar del mismo acreedor (65 acreedores) | 241 | 2.9 % |
| Anterior al 1-oct sin explicación | 1,443 | 30.8 % |
| **Vencido real desde el corte** | **866** | **38.2 %** |

El vencido real se concentra en CEDIS (más de la mitad) y, por acreedor, en CB005 y CD015 (juntos, cerca de un tercio de
lo anterior al corte más lo real). **NO MEDIDO:** duplicados anteriores a 2026; el 60 % de las facturas vencidas no casa con
un CFDI por total (319 acreedores sin RFC), así que de ellas no se sabe si están canceladas o duplicadas; los 47 pagos
dobles desde Caja General no se cruzaron contra Control (Access); el estado `R` de `kdm1.c43` (4 facturas) no se sabe qué
significa; los créditos bancarios pueden pagarse con cargo directo sin registrarse en Kepler; la capa «pagado sin aplicar»
supone que cada anticipo cubre lo más viejo del acreedor y puede ser mercancía todavía sin facturar.

### 3.D El SAT contra Kepler

Universo: facturas de Kepler de 2026 (sin `TI*` y sin un acreedor cuyo RFC es el mismo que el receptor de la descarga)
contra los CFDI recibidos vigentes de acreedores del 1-ene al 8-oct. Emparejamiento uno a uno (mejor pareja mutua) en
cuatro pasadas: importe ±$1 y fecha ±45 días (control +$100: 433 contra 8,303); folio del CFDI en la referencia de Kepler
(control folio+1: 115 contra 1,298); y dos pasadas débiles (tardía y cercana, control de 26–32 %) que se declaran aparte.
En compras casa el **70 % de las facturas y el 86 % del dinero**.

1. **Kepler no registra el total del CFDI en algunos proveedores.** La pasada por folio casó más de mil facturas que el
   importe no veía: CD015, CC002 y CD024 se capturan en Kepler como el total del CFDI **dividido entre un factor fijo**
   (distinto por proveedor). Lo que la Suite paga sale de Kepler, no del CFDI.
2. **El RFC del acreedor está mal o falta.** Contradicho por sus propios CFDI: GFS001, CF005, CB007, CP008. Sin RFC en
   Kepler aunque facturan: CE012 (Effem), CN003, CI004, GAR001 (factura con otra razón social) y GS008 (factura como
   IMSS). Sin RFC no hay cruce fiscal posible: 9,932 facturas de 2026 quedan fuera (NO MEDIDO).
3. **CFDI sin factura en Kepler (deuda que no está registrada):** en firme, 83 PPD (52 ya con complemento de pago: el
   proveedor dice que se le pagó) y 494 PUE sin ninguna factura sin casar del mismo acreedor cerca. Otros 2,522 son
   ambiguos (el proveedor tiene facturas cerca con otro importe o agrupadas distinto). CB005 concentra la mayor parte de
   los PPD con complemento.
4. **Facturas de Kepler sin CFDI:** 2,395 de compras (431 abiertas, las que el Calendario ofrece) y 1,515 de gastos (351
   abiertas). En compras: 343 son la gemela de una factura capturada dos veces; 841 son de acreedores cuyo RFC no emite
   ningún CFDI (proveedor que no factura o RFC mal tomado); 963 ambiguas; 248 limpias (88 abiertas). CB005 tiene en
   Kepler más del doble de lo que tiene en CFDI, con meses enteros sin CFDI.
5. **Un CFDI explica dos facturas de Kepler: 390** (control +$100: 2), 322 en otra sucursal que su gemela — es el
   «espejo» de §3.C visto desde el SAT. Se cerraron con nota de crédito o con transferencia; **32 se pagaron dos veces con
   dinero** en Kepler y **28 siguen abiertas con su gemela ya saldada** (riesgo de pagar otra vez). Y al revés, 380 CFDI
   que caen dos en una factura (control: 75; señal media): 14 con la misma serie y folio (el proveedor volvió a timbrar).
6. **CFDI cancelado con factura en Kepler: 34** en 2026; 28 pagadas con dinero; **12 sin sustituta**. Una con sustituta
   por otro importe (CCP Productos). La fecha de cancelación en el SAT no se guarda: no se sabe si se pagó antes o
   después (NO MEDIDO).
7. **PPD pagadas sin complemento de pago: 193**; de enero a octubre la cobertura es de 93–99 % cada mes. El «octubre al
   32 %» que se había medido se explica porque más de la mitad de los PPD de octubre todavía no se pagan en Kepler;
   pagadas sin complemento son el 9.9 %. Aparte: 7 % de los PPD de julio y agosto tienen complemento de pago y **ningún
   pago con dinero en Kepler** (pagados sin registrar, o un complemento que no corresponde).

**NO MEDIDO:** las facturas de Kepler sin RFC; la fecha de cancelación en el SAT; un CFDI repartido en varias entradas
de Kepler (o al revés), que explica parte de lo ambiguo; compras facturadas a otro RFC receptor; las notas de crédito del
SAT (tipo E) contra las de Kepler.

## 4. Las fuentes y sus límites (léase antes de afirmar nada)

| Fuente | Qué es | Límite medido el 2026-11-23 |
|---|---|---|
| `finance.bank_movements` («libro») | Sobre todo el Excel que sube Finanzas (`sync_source = 'upload'`); desde noviembre también la carga del banco | Cubre septiembre a noviembre; medido contra la descarga es **copia fiel** (saldos incluidos); trae los **SPEI devueltos** como salida + entrada (no restarlos los cuenta como pago); no trae CLABE ni beneficiario fiable (el nombre es la etiqueta que pone Finanzas); la caja (`CAJA CG`) llega sólo al 10-oct |
| `finance.bank_statement_lines` («descarga») | Lo que baja el banco | Empieza el 1–3 de noviembre; el beneficiario (`counterparty_name`) casi siempre vacío salvo Santander; una cuenta de Santander no tiene ninguna descarga y otra se quedó en el 10-nov |
| `kepler_ods.kdxe` / `kdxf` / `kdm1` | Documentos de CxP, aplicaciones y encabezados | Facturas capturadas dos veces (también entre sucursales, a veces con la referencia de una apuntando al folio de la otra); pagos en efectivo de Caja General (`c22 = '0011'`) con tipo 26 «transferencia»; `c16` es texto libre, no llave |
| `commercial.supplier_payment_obligations` | Obligaciones capturadas a mano | 38 de 42 traen la llave de su factura en Kepler; hasta `[PGP.197]` no se medían contra Kepler |
| `fiscal.cfdis` | CFDI del SAT | Recibidas de 2026 completas desde el 21-nov; RFC de algunos acreedores en Kepler contradicho por sus CFDI |

## 5. Las consultas (para repetir el análisis)

Todas de **sólo lectura** contra `pg-prod`: `BEGIN TRANSACTION READ ONLY;` + `SELECT system_identifier FROM
pg_control_system();` (prod) + `ROLLBACK;`. Sin tablas temporales: CTEs `AS MATERIALIZED`. Tenant `mega_dulces`.

**Pago de Kepler vigente (importe = suma de sus aplicaciones), sin los cancelados:**
```sql
SELECT x.sucursal, x.c1, x.c2, x.c4, x.c5, x.c6, min(x.c3)::date AS fecha, sum(x.c10) AS importe
  FROM kepler_ods.kdxf x
 WHERE btrim(x.c1) = x.sucursal AND x.c4 IN (25, 26, 45)
   AND NOT EXISTS (SELECT 1 FROM kepler_ods.kdm1 m
                    WHERE m.c3 = 'D' AND m.c43 = 'C' AND btrim(m.c1) = m.sucursal AND m.sucursal = x.sucursal
                      AND m.c1 = x.c1 AND m.c10 = x.c2 AND m.c4 = x.c4 AND m.c5 = x.c5 AND m.c6 = x.c6)
 GROUP BY x.sucursal, x.c1, x.c2, x.c4, x.c5, x.c6;
-- su cuenta de tesorería: kdxe (c3 = 'D', misma llave).c22; '0011' = CAJA GENERAL (efectivo), '2103' = FACTORAJE
```

**R6 — pagos cancelados cuyo dinero salió** (con su control +$100):
```sql
SELECT count(*) FILTER (WHERE salidas > otros_pagos), count(*) FILTER (WHERE control > 0), count(*)
  FROM (SELECT a.id, a.amount_assigned AS monto, l.lot_date,
               (SELECT count(*) FROM finance.bank_movements b WHERE b.deleted_at IS NULL
                   AND abs(b.amount_out - a.amount_assigned) < 1 AND b.movement_date BETWEEN l.lot_date - 3 AND l.lot_date + 30) AS salidas,
               (SELECT count(*) FROM finance.payment_allocations a2 JOIN finance.payment_calendar_lots l2 ON l2.id = a2.lot_id
                 WHERE a2.status = 'executed' AND a2.id <> a.id AND abs(coalesce(a2.paid_bank_amount, a2.amount_assigned) - a.amount_assigned) < 1
                   AND l2.lot_date BETWEEN l.lot_date - 10 AND l.lot_date + 30) AS otros_pagos,
               (SELECT count(*) FROM finance.bank_movements b WHERE b.deleted_at IS NULL
                   AND abs(b.amount_out - (a.amount_assigned + 100)) < 1 AND b.movement_date BETWEEN l.lot_date - 3 AND l.lot_date + 30) AS control
          FROM finance.payment_allocations a JOIN finance.payment_calendar_lots l ON l.id = a.lot_id
         WHERE a.status = 'cancelled' AND a.amount_assigned >= 1000) z;
```

**R3 — la misma factura dos veces en Kepler** (mismo acreedor, importe y fecha; la referencia ayuda pero no es llave):
```sql
SELECT btrim(e.c2) AS acreedor, e.c11 AS importe, e.c7::date AS fecha, count(*),
       string_agg(e.sucursal || ':' || e.c4 || '-' || btrim(e.c6) || ' ref ' || coalesce(btrim(e.c16), '-'), ' | ')
  FROM kepler_ods.kdxe e
 WHERE btrim(e.c1) = e.sucursal AND e.c3 = 'A' AND e.c4 IN (10, 20) AND e.c7 >= '2026-01-01' AND btrim(e.c2) NOT LIKE 'TI%'
 GROUP BY 1, 2, 3 HAVING count(*) > 1;
```

**R7 — el pago del Calendario que salió del banco y no está en Kepler, separado con el banco:** para cada pago
`executed` con `paid_bank_movement_id` y sin `kepler_payment_folio`, buscar en `kdxf` los pagos con dinero (25/26) que
tocan sus facturas (las capturadas, por su llave `kepler_*`) y compararlos con la salida del banco: mismo importe ±$1 y
fecha ±3 días = **el mismo pago capturado por Tesorería** (se liga); otro importe u otra fecha con su propia salida =
**pago doble**; sólo notas de crédito = **nota no descontada** (pago de más).

**Las consultas completas de los cuatro frentes** (Calendario, banco uno a uno, capas del vencido y SAT) están en
[`ops/prod/cuadre-de-libros/`](../../../ops/prod/cuadre-de-libros/README.md), con cómo se corren y qué regla mide cada una.
Las fechas están fijas a las del análisis.

## 6. Lecciones (lo que hicimos mal)

- **Se trabajó por síntoma.** Cada reporte produjo un arreglo correcto para su caso y nadie midió el cuadre. Más items
  no es más control: el pago doble pasó con veinte arreglos encima.
- **Una regla se aplicó a un camino y no a su gemelo.** Todo lo que medía contra Kepler (`[PGP.35]`, `[PGP.94]`,
  `[PGP.132]`, `[PGP.147]`) miraba la factura derivada y no la obligación capturada.
- **Nadie mide el resultado en producción.** Las pruebas verifican que el código haga lo que dice; ningún número dice
  cada día «pagos dobles: 0».
- **Se confió en testigos sin medirlos, y se sospechó de ellos sin medirlos.** El testigo «ya salió» (`[PGP.149]`)
  cuenta una salida devuelta como pago y no reconoce un pago partido en dos transferencias (Effem). Y en el sentido
  contrario: durante el análisis se afirmó que el Excel del banco «tenía renglones repetidos» y que un SPEI grande
  «no tenía explicación»; medido, el Excel era copia fiel (los pares eran devoluciones) y el SPEI era la mitad del pago
  de Effem, cuya referencia llevaba el folio de la factura. **Una afirmación sin su medición completa se corrige en voz
  alta en cuanto se mide.**
- **Se contó un motivo como si fuera un diagnóstico.** El 20-nov se reportaron «8 saldados por otro lado»; con el banco
  eran 6 capturados por Tesorería, 3 pagos de más y 1 anticipo.
- **Se abrió más de lo que se cerró.** En un solo día se abrieron siete items de pago mientras el Calendario seguía
  mostrando información falsa.

## 7. Lo que sigue

| Item | Qué cierra | Estado |
|---|---|---|
| `[PGP.197]` | La obligación capturada se mide contra Kepler (ofrecer, renglón, cierre) | ✅ en prod 2026-11-23 |
| `[PGP.198]` | El cuadre permanente con las reglas de §2 | ⬜ |
| `[PGP.199]` | No se cancela, reprograma ni libera un pago cuyo dinero ya salió | ✅ en prod 2026-11-23 |
| `[PGP.166]` (era `[PGP.200]`) | El cheque cobrado deja el pago pagado (el `X-D-25` en Kepler sigue en `[PGP.171]`) | ✅ en prod 2026-11-23 |
| `[PGP.201]` | El testigo del banco: una salida devuelta no es pago; un pago partido en varias transferencias (misma referencia) sí | ✅ en prod 2026-11-23 |
| ⛔ Tesorería, hoy | **No autorizar el pago de Effem del 18-nov: ya salió.** Darlo por pagado y registrar su `X-D-26` | urgente |
| Tesorería | Registrar en Kepler los pagos que salieron sin documento (Effem, CD015, CB005, Barcel, el SPEI del 10-nov); confirmar con CH001 y CF005 los pagos dobles; cancelar los pagos de Kepler sin dinero (copias espejo, CP012, CA043) y averiguar los dos del 28-oct sin salida; corregir la cuenta de los tres pagos mal registrados; decidir qué copia de cada factura espejo se cancela | pedido |
| Edgar | Qué hacer con lo pagado de más (CD031, CH001, CF005 dobles; CD015 y Effem sin descontar notas): descontarlo del siguiente pago o pedir reembolso | por decidir |
