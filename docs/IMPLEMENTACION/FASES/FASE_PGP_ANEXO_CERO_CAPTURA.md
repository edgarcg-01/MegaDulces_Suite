# Fase PGP — Anexo C: que ningún pago se capture a mano

> Anexo de [`FASE_PGP_PAGO_A_PROVEEDOR.md`](FASE_PGP_PAGO_A_PROVEEDOR.md). El método: [`docs/METODO_DE_TRABAJO.md`](../../METODO_DE_TRABAJO.md).
> No es una fase nueva: PGP ya está 🔨 y el tablero tiene 8 fases 🔨 contra un tope de 4 (contado el 2026-11-17).

```
OBJETIVO: que el pago a proveedor del Calendario quede registrado en Kepler (y después en ContPAQi) sin que
          nadie lo teclee: la persona decide (arma y autoriza) y paga en el banco; lo demás lo hace la Suite.
MÉTRICA:  documentos de pago a proveedores de mercancía (C…) en Kepler escritos por la Suite
          HOY (medido 2026-11-17, ventana 17-oct → 16-nov, 9 servidores): 3 de 477 = 0.6 %
          META: la de la fase — 60 % de los pagos a proveedor por transferencia, para 2026-12-15
CAPA TOPE: C3
ÁREA:      Finanzas (Tesorería)
DUEÑO:     <por asignar — lo firma Edgar>
ESTADO:    🔨 D1–D7 firmadas por Edgar el 2026-11-17; frente 1 (`[PGP.130]`) en curso
```

Medido en `pg-prod` (`system_identifier 7688376744939610156`, sólo lectura) sobre `kepler_ods.kdm1` (`X-D-25/26/60`,
cada documento en su servidor: `c1 = sucursal`, sin cancelados) y `finance.payment_allocations`.

---

## 0. El pedido

| # | Lo que se pidió | Efecto |
|---|---|---|
| 1 | Edgar, 2026-11-17: *«hagamos que nada se capture a mano. Necesito automatizar todo ese proceso»* (el ciclo del Calendario de pagos, recién explicado: armar → preparar → autorizar → pagar → probar → Kepler) | Este anexo. Armar y autorizar son **decisiones**, no captura: se quedan en manos de una persona (1–2 clics). Todo lo demás se automatiza |

---

## 1. El universo y el trabajo

**El universo** (30 días, 9 servidores): **2,483 documentos de pago a acreedores, $48.6 M**. La Suite escribió **3**
(CEDIS, 14-nov). Todo lo demás lo tecleó una persona.

| Acreedor | Medio (cuenta `c45` ⋈ `kdb1`) | CEDIS | 01–08 | ¿Entra? |
|---|---|---:|---:|---|
| **Mercancía `C…`** | transferencia, cuenta de banco | 100 · $20.0 M | 77 · $12.0 M | ✅ frentes 1 y 2 |
| | cheque (`X-D-25`) | 16 · $3.5 M | 8 · $1.0 M | ✅ frente 4 |
| | cuenta de **caja** (efectivo) | 59 · $2.8 M | 204 · $2.1 M | ✅ frente 5 (con LE) |
| | anticipo (`X-D-60`) | 4 · $0.7 M | 6 · $0.2 M | ✅ frente 6 |
| | cuenta puente | 1 · $0.0 M | 2 · $0.65 M | ✅ con el frente 2 |
| **Gasto `G…`** | todos | 349 · $2.6 M | 1,650 · $2.8 M | ⛔ fuera (§5) |
| Otros (`A…`, `T…`) | todos | | 7 · $0.3 M en total | ⛔ fuera |

⭐ **El dinero está en `C…` (88 %); el tecleo está en `G…` (80 % de los documentos).** Un solo acreedor de gasto, el
cargo de BBVA (`GB004`), son **1,067 capturas al mes por $0.12 M**: es el mayor volumen de tecleo y no es un pago del
Calendario.

**El trabajo de este anexo** son los 477 documentos `C…` ($42.9 M en 30 días). En el mismo periodo el Calendario tuvo
79 pagos marcados por el banco ($10.5 M), 95 pendientes ($16.3 M) y 122 cancelados o liberados.

---

## 2. Lo que creíamos y cayó

| # | Lo que creíamos | Lo que midió prod |
|---|---|---|
| 1 | Con el banco como disparador (`[PGP.121]`) la Suite escribe los pagos | Tesorería captura el `X-D-26` **el mismo día** (61 de 65) y el estado de cuenta se sube días después (lo último cargado es del 10-nov). La Suite llega tarde y su compuerta, con razón, no duplica: de lo que no escribió, ~60 ya estaban capturados |
| 2 | El número de cheque se puede derivar del consecutivo de Kepler | No: en `X-D-25` desde el 1-sep, de 176 pares seguidos por cuenta sólo **4** son `n+1`, y el campo mezcla formatos (`CH-17183`, `CHEQUE 17197 NOM 44`, `5363`). La chequera la lleva hoy una persona fuera de Kepler |
| 4 | El comprobante ya llega a la Suite | Llega **por lotes** (5-ago, 3/4-oct, 6-nov), no el día del pago: **0 de 79** pagos del Calendario probados por el banco tienen su comprobante ligado (medido 2026-11-17). Hoy vive en una carpeta compartida. Sin D2 cumplido, `[PGP.130]` no dispara nada |
| 3 | «Gastos» son pocos | Son 1,999 de 2,483 documentos. Pero son cargos del banco, nómina, combustible, casetas, caja chica y viáticos: otros procesos, no el Calendario |

---

## 3. Decisiones (✅ firmadas por Edgar el 2026-11-17, todas como se recomendaban)

| # | Decisión | Opciones | Firmado |
|---|---|---|---|
| **D1** | ¿Qué dispara el registro **el mismo día**? | (a) el comprobante de la transferencia, validado · (b) seguir esperando el banco · (c) que la Suite arme el archivo de dispersión del banco | **(a) ahora, (c) después.** El comprobante existe el mismo día y ya se guarda (hoy en una carpeta compartida); casó con el banco 87 de 90, placebo 0 (medido 2026-11-09). El banco queda como **confirmación**: si a los N días no aparece la salida, la Suite avisa. (c) es lo correcto a largo plazo (la Suite ordena el pago y nadie teclea la CLABE en el portal), pero necesita el catálogo de cuentas destino, que tiene **cero** filas |
| **D2** | ¿Desde cuándo Tesorería deja de capturar? | por servidor, a medida que se enciende | **CEDIS en cuanto D1 esté en prod**; cada sucursal cuando tenga GRANT + plantilla + ensayo verde. Y el comprobante se guarda **en la Suite** (Comprobantes de pago), no en la carpeta: es el mismo esfuerzo y es el disparador |
| **D3** | Concepto (`c12`) fuera de CEDIS (era P10) | el de la factura · el de «compra» de la sucursal | **el de la factura** (P6 ya lo decidió así para CEDIS). Si Contabilidad prefiere el de «compra», es una regla por servidor y se cambia en un lugar |
| **D4** | Permisos en Kepler de 01–08 y del mes siguiente (`kdc22701`, enero) | — | Quien administra Kepler (`sa`) concede a `kepler_push` en 01–08 lo mismo que en 00. La lista exacta está en `[PGP.125]`. **Sin esto el frente 2 no arranca** |
| **D5** | El estado de cuenta | (a) Finanzas lo sube a diario · (b) conexión directa con el banco (H2H/API) | **(a) ya**, porque es la confirmación de D1. (b) es una decisión de Dirección (contrato y costo con cada banco); se mide antes cuántas cuentas mueven el 90 % del dinero |
| **D6** | Pago que sale del banco **sin autorizar** | registrarlo en silencio · registrarlo y marcarlo · no registrarlo | **Registrarlo y marcarlo** «pagado sin autorizar», con aviso a quien autoriza: el dinero ya salió, Kepler tiene que saberlo, y Dirección tiene que enterarse |
| **D7** | Número de cheque | (a) la Suite lleva la chequera por cuenta · (b) se teclea UNA vez al emitir | **(a)**: se carga el folio inicial de cada chequera y la Suite asigna el siguiente al autorizar un pago con cheque. Nadie teclea el número; la cuenta `BAJÍO 4166` queda bloqueada para cheques hasta revisarla |

Lo que firmar no destraba: **D4** pide que quien administra Kepler conceda los permisos (la firma decide pedirlo, no los concede) y **D5-a** pide que Finanzas suba el estado de cuenta a diario. D3 y D4 no frenan a CEDIS; D7 sólo a cheques.

---

## 4. El orden

| Orden | Frente | Item | Dinero (30 días) | Esfuerzo | Prioridad | Por qué ahí |
|---|---|---|---|---|---|---|
| 1 | **El comprobante dispara el registro** (D1, D2) · 🔨 C1+C2+C3 en código 2026-11-17 | `[PGP.130]` | Alto · $20.0 M CEDIS | M | **1** | Las piezas existen: lectura del comprobante (OCR), cruce, validación con 4 coincidencias, escritura del `X-D-26` con su compuerta. Falta unirlas al pago del Calendario |
| 2 | **Las 8 sucursales** (D3, D4) | `[PGP.131]` | Alto · $12.0 M | S de código; espera D4 | **1** | Plantilla por servidor (se elige leyendo un `X-D-26` de Tesorería en cada Kepler vivo, sólo lectura) y ensayo con ROLLBACK por servidor |
| 3 | **Ligar lo que Tesorería ya capturó** | `[PGP.132]` | — (métrica) | S | 2 | Mientras dure la transición, el pago capturado a mano se liga a su folio: sale de la fila del worker (hoy se revisa en cada pasada) y la métrica lo cuenta bien |
| 4 | **Cheques** (D7) | `[PGP.133]` | Alto · $4.5 M | M | **1** | `X-D-25` con el número de la chequera de la Suite; misma compuerta y ensayo que el `X-D-26` |
| 5 | **Pagado sin autorizar** (D6) | `[PGP.134]` | Bajo | S | 3 | Control, no captura; va con el frente 1 si D6 se firma |
| 6 | **Efectivo a proveedores** (cuenta de caja) | `[PGP.135]` | Alto · $4.9 M | L | 2 | Se escribe cuando la ventanilla de Caja General paga (fase LE, ADR-112: «pagar es registrar»). Se coordina con LE, no se duplica |
| 7 | **Anticipos** (`X-D-60`) | `[PGP.136]` | Medio · $0.9 M | M | 3 | El anticipo ya nace en la Suite (`[PGP.119]`); falta escribir su documento al pagarlo |
| 8 | **Póliza de ContPAQi** | `[PGP.112]` (ya existe) | Alto | L | 2 | La Suite arma el TXT; Contabilidad lo importa con un clic (ADR-040: la Suite no escribe directo en ContPAQi) |
| 9 | **Archivo de dispersión del banco** (D1-c) | `[PGP.137]` | Alto | L | 2 | Que la Suite arme el lote para el portal del banco. Requiere el catálogo de cuentas destino (O6/O7 de la fase) |
| 10 | **Aplicar el anticipo** (agregado 2026-11-17) | `[PGP.139]` 🧪 · `[PGP.140]` | Alto · $2.0 M aplicables hoy, $3.6 M de +90 días | S (aviso) · M (escritura) | **1** | El aviso en la fila del pago ya está en código; la escritura en Kepler (`kdxf` + saldos) espera leer una aplicación entera en el Kepler vivo |
| 11 | **El pago atrasado dice qué dice el banco** (agregado 2026-11-18) | `[PGP.146]` 🔨 | Medio · $3.0 M ya salidos que se veían «por preparar» | S | **1** | Sólo lectura de la descarga del banco; sin esto Contabilidad lee «atrasado» lo que ya se pagó. Ver §4a |
| 12 | **El pago lleva más de lo que la factura debe** (agregado 2026-11-18, caso Mondelez) | `[PGP.147]` 🔨 · `[PGP.148]` | Alto · $0.41 M hoy en 5 pagos pendientes; $122 mil ya pagados de más | S (aviso) · M (ajuste) | **1** | Una nota de crédito, una devolución o un pago parcial bajan el saldo después de programar y nada lo volvía a comparar. Ver §4b |
| 0 | ⛔ **La liberación a la semana soltó pagos que sí salieron del banco** (agregado 2026-11-18) | `[PGP.149]` 🔨 | **Crítico** · $1.89 M liberados por error el 17-nov; $1.8 M el 20-nov y $5.9 M al 24-nov con la regla vieja | S | **0** | Doble pago: las facturas de un pago que ya salió vuelven a ofrecerse. Va antes que todo. Ver §4c |

⭐ **Con los frentes 1 y 2, el 75 % del dinero `C…` deja de teclearse.** Con 4 y 6, el 96 %; con los anticipos, el 98 %.

### 4a. El pago atrasado que ya salió (2026-11-18)

Contabilidad se queja de pagos «atrasados». Medido ese día: **71 pendientes de días pasados ($10.9 M)**. El estado de
cuenta del Calendario (`finance.bank_movements`) se quedó en el 10-nov porque **ninguna cuenta «usa el banco»** —el
Excel de Tesorería dejó de subirse y el interruptor de `/finanzas/bancos` no se ha encendido—, así que las cinco
lecturas del Calendario que dependen de él (pagar por el banco, validación, vencidos, salidas del banco) no ven nada
desde entonces. La **descarga** del propio banco sí se sube a diario. Leída con la regla de `[PGP.121]`: **23 de los 71
ya salieron ($2,964,539)**; placebo (los mismos pagos 20 días después) 0 de 79. `[PGP.146]` lo dice en cada pago, sin
escribir nada. Lo que lo vuelve permanente es **encender «Usar el banco»** en las cuentas que cuadran (14 de 18).

### 4b. El pago se programa una vez y el saldo de la factura cambia (caso Mondelez, 2026-11-18)

**El caso.** Mondelez (`CM009`), factura `20-1-0010007` de CEDIS por **$469,071.93**, programada el **26-oct** para
pagarse el **13-nov**. El **12-nov** se capturaron en Kepler dos notas de crédito aplicadas a esa misma factura
(`55-0001512` por **$120,000**, referencia DMKT, y `55-0001513` por $2,142.69): su saldo bajó a **$346,929.24**. El
pago del Calendario siguió en $469,071.93 y **así salió del banco el 13-nov** (BBVA 4176, SPEI a Citi). **Se le pagaron
$122,142.69 de más.** En Kepler todavía no hay `X-D-26` de ese pago.

**Por qué pasa.** El importe de cada factura se fija al armar el pago y **nada lo vuelve a comparar con lo que la
factura debe**. `createAllocation` revisa el saldo al armar; después, una nota de crédito, una devolución, un anticipo
aplicado o un pago parcial capturado en Kepler bajan el saldo y el pago no se entera. `[PGP.35]` sólo avisa cuando la
factura queda **saldada por completo**; `[PGP.141]` avisa de notas **sin aplicar** — ésta ya estaba aplicada. Quien
paga en el portal del banco teclea el importe del Calendario.

**Qué tan seguido** (medido 2026-11-18 con el código de `[PGP.147]`, sólo lectura): **5 pagos pendientes llevan
$414,800.53 más de lo que sus facturas deben hoy**. Dos por notas de crédito (Mondelez, ya pagado; `CE012` del 17-nov,
$44,569.87, todavía sin salir) y tres porque Kepler ya registró una transferencia que el Calendario no ligó (uno
programado para el **28-dic** por $117,161.87 cuya factura debe $6,125: se pagaría dos veces). Entre los ya pagados del
Calendario hay 4 con $161,744 sobre la deuda, pero **lo que salió de verdad por ellos NO está MEDIDO** (pudo pagarlos
Tesorería por el neto).

**La solución, por capas.**
1. `[PGP.147]` C1+C2 (en código): cada pago pendiente trae `debe_menos` — por factura, lo programado, lo que debe hoy
   y **los documentos de Kepler que lo bajaron** (nota, devolución, pago). El saldo llega en la misma consulta de la
   etiqueta (cero viajes nuevos); los abonos, una consulta de 91 ms sólo si hay alguna. C3: decirlo en la fila, en
   rojo, antes de «Por pagar», y en la orden que se imprime.
2. `[PGP.148]` **Ajustar el pago al saldo de Kepler** (un clic, con bitácora y el folio de la nota) — y, si se firma
   D19, **solo, por evento**: cuando el ODS ve un abono aplicado a una factura que está en un pago pendiente, el pago
   baja a lo que se debe y queda escrito por qué. Nunca sube solo.

**D19 · ¿El pago se ajusta solo cuando Kepler baja el saldo de su factura?** (a) sólo avisar · (b) ajustar solo los
pagos **sin autorizar** y avisar en los autorizados · (c) ajustar siempre. **Recomiendo (b)**: el importe correcto es un
hecho (el saldo de Kepler), y en un pago sin autorizar nadie ha comprometido nada; en uno autorizado puede que
Tesorería ya cargó la transferencia en el portal, y ahí cambiarlo en silencio haría que la Suite y el banco digan cosas
distintas. **✅ Firmada (b) por Edgar el 2026-11-18** («si»).

### 4c. ⛔ La liberación a la semana soltó pagos que sí salieron del banco (2026-11-18)

**El hallazgo** (al construir la pantalla de §4a). `[PGP.117]` libera, a la semana, el pago que «nadie pagó»: lo pasa a
`cancelled` y sus facturas vuelven a ofrecerse para programar. Su testigo del banco leía **sólo el libro**
(`bank_movements`), que se quedó en el 10-nov (§4a), y tomaba «no está en el libro» como «no salió». **El 17-nov liberó
así 7 pagos del 10-nov que la descarga del banco muestra salidos el 10 y 11-nov: $1,893,556.02** (placebo +$100: 0 de
16 liberados). Kepler todavía debía esas facturas ($1,894,520.07): estaban otra vez a un clic de pagarse dos veces.
Ninguna se había vuelto a programar al medirlo. Con la regla vieja, el **20-nov** se liberaban 30 más ($1.8 M) y al
**24-nov** 54 ($5.9 M).

**El arreglo** (`[PGP.149]`):
1. **El testigo del banco son dos: el libro o la descarga.** Y «no salió» sólo se afirma si la descarga cubre esos días
   (la cuenta preparada, o todas las de banco activas si nadie la preparó); si no, el pago se conserva como
   `banco_sin_medir`. Es la regla que `[PGP.117]` ya declaraba («ante la duda, se queda»), que el libro parado rompía.
2. **Lo que soltó por error vuelve, solo.** En la misma pasada diaria, cada liberado con una salida por su importe
   (±$1, desde 3 días antes de su día hasta el día en que se liberó) regresa a `pending`, con su nota y una fila
   `reabierto_salio_del_banco` en la bitácora; `[PGP.146]` lo pone en «Por registrar en Kepler». Si sus facturas ya
   están en otro pago vivo, no se toca y el log lo nombra para que una persona lo revise.

**Medido con el código real contra prod (ensayo en seco, sólo lectura):** regresan **los 7**; con la regla nueva el
20-nov y el 24-nov se liberan **0** (el 24: 26 se conservan porque salieron, 29 porque falta descarga). La consecuencia
se declara: **mientras alguna cuenta activa no tenga descarga de esos días, un pago sin preparar no se libera**
(`STDR 5565` nunca se ha subido; `STDR 1621` y `STDR 2169` llegan al 10 y 11-nov). Para que la liberación vuelva a
soltar lo que de verdad no se pagó, hay que subir esas descargas o dar de baja la cuenta que no se usa.

**Acción para personas, hoy:** que nadie vuelva a programar las facturas de esos 7 pagos hasta que el arreglo esté en
prod; y, para cortar la liberación de inmediato, apagarla en el worker (`DISABLE_PAGOS_VENCIDOS=true`) hasta desplegar.

**Acción para personas (no es código):** los $122,142.69 de Mondelez. Recomendado: al capturar en Kepler el `X-D-26`
del 13-nov, aplicar $346,929.24 a la `0010007` y el resto a las facturas del pago del **19-nov** (`0010025` y
`0010027`, $191,580.99), y bajar ese pago a **$69,438.30**. Alternativa: pedir el reembolso a Mondelez.

---

## 5. Qué NO incluye

- **Pagos a acreedores de gasto (`G…`), 1,999 documentos.** Son otros procesos y tienen dueño: cargos del banco
  (`GB004`, BBVA: 1,067 al mes) → conciliación bancaria (CB); nómina → RH; combustible y casetas → flotilla (FC);
  caja chica y viáticos → gastos (GX) y la solicitud de gasto (`[PGP.122]`). ⭐ El cargo de BBVA es el mayor volumen
  de tecleo del universo y sale entero del estado de cuenta: se recomienda como item aparte en CB.
- **Armar y autorizar.** Son decisiones. La Suite propone; una persona decide.
- **Escribir directo en ContPAQi** (ADR-040).
- **Credenciales del banco o del portal**: no se automatiza un inicio de sesión al banco (regla del repo).

---

## 6. Riesgos y bloqueos

| Bloqueo | Dueño | Causa | Qué lo destraba |
|---|---|---|---|
| Sin GRANT en 01–08, el frente 2 no arranca | quien administra Kepler | `kepler_push` sólo tiene permisos de pago en `00` | D4 |
| Un comprobante de una transferencia que después rebota | dueño del frente 1 | el comprobante dice que el banco aceptó la orden, no que liquidó | el banco confirma; si a los N días no aparece la salida, aviso y cancelación del `X-D-26` (Kepler lo marca `c43 = 'C'`). **NO MEDIDO**: cuántos rebotes hay al mes |
| El comprobante se sigue guardando en la carpeta y no en la Suite | Tesorería | costumbre | D2; mientras tanto, el banco sigue siendo el disparador de respaldo |
| Enero sin permiso de `kdc22701` | quien administra Kepler | el permiso es tabla por tabla, una por mes | D4, antes del 31-dic |
| Doble registro durante la transición | dueño del frente 1 | Tesorería y la Suite a la vez | la compuerta del ensayo ya lo impide (lee Kepler en vivo antes de escribir) |

---

## 7. NO MEDIDO

- Que Tesorería guarde el comprobante el mismo día del pago (se midió que captura en Kepler el mismo día, no la hora
  del archivo). Lo que sí se midió: hoy el comprobante entra a la Suite por lotes, días o semanas después (§2 fila 4).
- `[PGP.130]` contra base real: la prueba `test-newdb-pgp130-comprobante-dispara.js` corre en el CI (aquí no hay base
  local); que el lector del PDF lea bien la cuenta de origen se ve con el primer comprobante real subido por la pantalla.
- Cuántas transferencias rebotan al mes.
- Cuántas cuentas de banco mueven el 90 % del dinero (para D5-b).
- La plantilla de pago de cada servidor `01`–`08`.

---

## 8. DoD

- [ ] 1. Métrica remedida: documentos `C…` escritos por la Suite, antes (3 de 477) / después
- [ ] 2. Cada capa verificada o declarada NO MEDIDA
- [ ] 3. Cada escritura nueva (`X-D-26` por comprobante, `X-D-25`) ejercida contra base real y ensayada contra el Kepler vivo con ROLLBACK
- [ ] 4. La compuerta del ensayo rota a propósito una vez por frente, rojo verificado
- [ ] 5. Sin primitivo nuevo: el cruce comprobante↔pago reusa el de `[PGP.121]` (pago↔banco) o queda como deuda con nombre
- [ ] 6. Tracker + `03_LOG_REVISIONES.md`
- [ ] 7. En prod, con Tesorería sin capturar (D2) — o escrito por qué no

## 9. Bitácora

- **2026-11-17** — Plan. Universo medido; D1–D7 esperando a Edgar.
- **2026-11-17** — Edgar firma D1–D7 como se recomendaban («si, firmo»). Empieza `[PGP.130]`.
- **2026-11-17** — `[PGP.130]` C3: el botón «Comprobantes PDF» del Calendario casa primero con el pago de aquí; si no casa, sigue con Kepler con la misma lectura. Prueba con base real 13/13 en el CI.
- **2026-11-17** — Frente 10, aplicar el anticipo: en 90 días salieron $1.6 M en efectivo que un anticipo sin aplicar ya cubría. `[PGP.139]` lo avisa en la fila del pago; `[PGP.140]` (la escritura en Kepler) queda con su C0 medido.
- **2026-11-18** — Frente 11 (`[PGP.146]`): 23 de 71 pagos «atrasados» ya habían salido según la descarga del banco;
  el Calendario no lo veía porque ninguna cuenta usa el banco (§4a). C1+C2 en código.
- **2026-11-18** — Frente 12 (`[PGP.147]`), pedido de Edgar con el caso Mondelez: una nota de crédito de $120,000
  aplicada el 12-nov y el pago del 13 salió completo, $122,142.69 de más (§4b). 5 pagos pendientes llevan $414,800.53
  más de lo que deben. C1+C2 en código; D19 para Edgar.
- **2026-11-18** — Edgar firma D19 (b): el pago sin autorizar se ajusta solo al saldo de Kepler; en el autorizado sólo
  se avisa.
- **2026-11-18** — ⛔ Frente 0 (`[PGP.149]`): la liberación a la semana soltó el 17-nov 7 pagos que sí habían salido del
  banco ($1.89 M), porque su testigo leía sólo el libro parado. Ahora lee también la descarga, no afirma «no salió» sin
  cobertura y regresa sola lo que soltó por error (§4c). Prueba con base real escrita, corre en el CI.
- **2026-11-17** — `[PGP.130]` C0 medido: el comprobante casa **solo** con su pago del Calendario (misma cuenta, ±$1,
  ±5 días) en 46 de 47 comprobantes medibles de noviembre, **ninguno con un pago equivocado**; placebo (fechas −35, −60
  y +35 días) **0 de 99**. C1+C2 en código: la regla pura, el endpoint que recibe el PDF, el worker que lo da por pagado
  y lo escribe en Kepler. Falta C3 (subir los comprobantes del día desde el Calendario) y `[PGP.130b]` (el banco
  confirma; aviso si la salida no aparece).
