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
| 1 | **El comprobante dispara el registro** (D1, D2) · 🔨 C1+C2 en código 2026-11-17 | `[PGP.130]` | Alto · $20.0 M CEDIS | M | **1** | Las piezas existen: lectura del comprobante (OCR), cruce, validación con 4 coincidencias, escritura del `X-D-26` con su compuerta. Falta unirlas al pago del Calendario |
| 2 | **Las 8 sucursales** (D3, D4) | `[PGP.131]` | Alto · $12.0 M | S de código; espera D4 | **1** | Plantilla por servidor (se elige leyendo un `X-D-26` de Tesorería en cada Kepler vivo, sólo lectura) y ensayo con ROLLBACK por servidor |
| 3 | **Ligar lo que Tesorería ya capturó** | `[PGP.132]` | — (métrica) | S | 2 | Mientras dure la transición, el pago capturado a mano se liga a su folio: sale de la fila del worker (hoy se revisa en cada pasada) y la métrica lo cuenta bien |
| 4 | **Cheques** (D7) | `[PGP.133]` | Alto · $4.5 M | M | **1** | `X-D-25` con el número de la chequera de la Suite; misma compuerta y ensayo que el `X-D-26` |
| 5 | **Pagado sin autorizar** (D6) | `[PGP.134]` | Bajo | S | 3 | Control, no captura; va con el frente 1 si D6 se firma |
| 6 | **Efectivo a proveedores** (cuenta de caja) | `[PGP.135]` | Alto · $4.9 M | L | 2 | Se escribe cuando la ventanilla de Caja General paga (fase LE, ADR-112: «pagar es registrar»). Se coordina con LE, no se duplica |
| 7 | **Anticipos** (`X-D-60`) | `[PGP.136]` | Medio · $0.9 M | M | 3 | El anticipo ya nace en la Suite (`[PGP.119]`); falta escribir su documento al pagarlo |
| 8 | **Póliza de ContPAQi** | `[PGP.112]` (ya existe) | Alto | L | 2 | La Suite arma el TXT; Contabilidad lo importa con un clic (ADR-040: la Suite no escribe directo en ContPAQi) |
| 9 | **Archivo de dispersión del banco** (D1-c) | `[PGP.137]` | Alto | L | 2 | Que la Suite arme el lote para el portal del banco. Requiere el catálogo de cuentas destino (O6/O7 de la fase) |
| 10 | **Aplicar el anticipo** (agregado 2026-11-17) | `[PGP.139]` 🧪 · `[PGP.140]` | Alto · $2.0 M aplicables hoy, $3.6 M de +90 días | S (aviso) · M (escritura) | **1** | El aviso en la fila del pago ya está en código; la escritura en Kepler (`kdxf` + saldos) espera leer una aplicación entera en el Kepler vivo |

⭐ **Con los frentes 1 y 2, el 75 % del dinero `C…` deja de teclearse.** Con 4 y 6, el 96 %; con los anticipos, el 98 %.

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
- **2026-11-17** — Frente 10, aplicar el anticipo: en 90 días salieron $1.6 M en efectivo que un anticipo sin aplicar ya cubría. `[PGP.139]` lo avisa en la fila del pago; `[PGP.140]` (la escritura en Kepler) queda con su C0 medido.
- **2026-11-17** — `[PGP.130]` C0 medido: el comprobante casa **solo** con su pago del Calendario (misma cuenta, ±$1,
  ±5 días) en 46 de 47 comprobantes medibles de noviembre, **ninguno con un pago equivocado**; placebo (fechas −35, −60
  y +35 días) **0 de 99**. C1+C2 en código: la regla pura, el endpoint que recibe el PDF, el worker que lo da por pagado
  y lo escribe en Kepler. Falta C3 (subir los comprobantes del día desde el Calendario) y `[PGP.130b]` (el banco
  confirma; aviso si la salida no aparece).
