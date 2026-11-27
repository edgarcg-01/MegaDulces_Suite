# Fase PGP — Anexo CR: los cargos que el banco aplica solo, sustentados por contrato y en el Calendario

> Anexo de [`FASE_PGP_PAGO_A_PROVEEDOR.md`](FASE_PGP_PAGO_A_PROVEEDOR.md). El método: [`docs/METODO_DE_TRABAJO.md`](../../METODO_DE_TRABAJO.md).
> **No es una fase nueva:** son items del Calendario de Pagos (`[PGP.209]`–`[PGP.219]`) en la fase PGP ya abierta.
> ⛔ Repo público: aquí van cifras redondeadas y códigos de Kepler; los números de contrato, de crédito y los RFC **no**.

## 0. El pedido

Francisco, 2026-11-25: *«ahora vamos a identificar los cargos que llegan a los estados de cuenta para integrarlos al
calendario de pagos»*. Es decir, lo que el banco cobra **por su cuenta** (domiciliaciones, créditos, seguros,
comisiones) y que hoy nadie programa: el día del Calendario no cuadra con el estado de cuenta.

Y el mismo día precisó para qué: *«lo que mides como riesgo es lo que busco que se cubra hoy a través del calendario
de pago, se contemple antes de hacer el programa para evitar moras e intereses o gastos de cobranza»*. **El fin no es sólo registrar el
cargo: es que el programa de pagos no se lleve el dinero que el banco va a cobrar** (DCR9, §3.0).

## 1. Lo medido (prod, sólo lectura, `system_identifier` de prod, 2026-11-25)

Fuentes: la descarga del banco (`sync_source='banco'`, del 31-oct al 25-nov) y los estados de cuenta subidos
(`'upload'`, de enero al 10-nov) para la historia. Cruce con el Calendario por `payment_allocations.paid_bank_movement_id`.

### 1.1 Lo que el banco cobra solo — noviembre (1 al 25), ninguno en el Calendario

| Tipo | Cargos | Importe | Cuenta · día | ¿Está en Kepler? |
|---|---:|---:|---|---|
| Arrendamiento domiciliado | 12 | ≈ $216 mil | Santander 2169 (días 12–14 y 24–27), BBVA 5712 (días 4–6) | **La arrendadora de Santander, no** (sólo en ContPAQi): 9 contratos con **el mismo importe desde junio** y 2 nuevos en noviembre. La de BBVA (`GS012`), como **un solo documento por todo el contrato** con vencimiento en 2028, mientras el banco cobra cada mes |
| Crédito: capital | 2 | ≈ $194 mil | Banorte 7744 · días 5–7 | No |
| Crédito: intereses e IVA | 12 | ≈ $135 mil | Banorte 7744 (bajan cada mes), BBVA 5712 (por disposición) | No. De BBVA, Kepler (`AB002`) tiene el capital, no el interés |
| Comisión de apertura | 2 | ≈ $115 mil | BBVA 5712 · 20-nov | Crédito nuevo: **sus intereses empiezan en diciembre (NO MEDIDO)** |
| Seguros domiciliados | 2 | ≈ $31 mil | Banorte 7744 (mensual), Santander 2169 (prima nueva) | El de Banorte, sí |
| FONACOT | 1 | ≈ $16 mil | cambia de cuenta cada mes · días 7–11 | Sí (`GF002`), y **lo sigue dando pendiente** aunque el banco lo cobró el 11-nov (§7). ⚠️ **Corregido con `[PGP.209]`:** no es un cargo automático; es un **pago referenciado (CIE)** que alguien de la empresa manda cada mes desde una cuenta distinta (§1.7) |
| Tarjeta de crédito domiciliada | 1 | ≈ $1.4 mil | — | — |
| **Total** | **32** | **≈ $708 mil** | | |

Contra Kepler (mismo importe ±$1, fecha o vencimiento ±7 días, placebo +$37): los cargos recurrentes de
arrendamiento, crédito y seguro casaron con **0** documentos.

### 1.2 Las cuotas fijas de comisión (para la D4)

Misma cuenta, mismo concepto y mismo importe en **3 meses o más** (junio–noviembre), sin la comisión variable de
terminal que ya lleva `[CB.62]`: renta de terminal, afiliación TPV, banca por internet, administración de cuenta y
penalizaciones, cada una con su IVA. Son **≈ 40 cargos al mes, $5–8 mil, en 8–10 cuentas** (jun $6.7 mil · jul $7.9 mil
· sep $5.4 mil · oct $5.8 mil). Poco dinero, pero ≈ 40 capturas a mano en Kepler cada mes. ⭐ `[CB.62]` las dejó
fuera a propósito («3 son cuotas fijas: fuera de alcance», §9.2 de CB): este anexo las toma.

### 1.3 La nómina (para la D3)

- Banco, noviembre: **77 pagos, ≈ $1.34 M**; **54 de 77 salen en viernes** (≈ $1.09 M). En el Calendario: 1 de 77.
- Kepler la registra como el acreedor **`GN001` «NÓMINA»**, pero no todas las semanas. En octubre, tres semanas
  quedaron sin documentos y otras dos con poco ($21 mil y $9 mil, contra $0.43–0.86 M en el banco). La semana del
  16-nov ya cubre un monto parecido: **$541 mil en Kepler contra $496 mil en el banco**.

### 1.4 El control: lo que sí está en el Calendario

IMSS y SAT, **11 de 11 (≈ $1.31 M)**. El Calendario sí puede llevar cargos que no son de proveedor; lo que les faltaba
era quién los programara.

### 1.5 Lo que ya existe y no se usa

- `payment_method = 'cargo_automatico'`: **0** pagos.
- `finance.financial_commitments` (TP.1, ADR-064): **0** filas. El Calendario ya lo lee como una de sus fuentes
  (`legCommitment` en `payment-calendar.service.ts`).
- `[PGP.121]` (el banco dispara el pago) casa **cualquier** pago `pending` de la misma cuenta, ±$1 y ±3 días, sin
  importar el método. Un cargo programado se cerraría solo al llegar el banco.

### 1.6 El saldo de cada cuenta y lo que ya nos costó (para la DCR9)

- **El saldo existe:** las 15 cuentas con descarga traen `running_balance` en el **100 %** de sus renglones de noviembre,
  con descarga hasta el 23–25-nov. El saldo al cierre de cada día ya lo reconstruye Bancos (`cierreDelDia` y
  `cuadresDeLaDescarga`, `[CB.73]`/`[CB.85]`): ese es el instrumento, no otro. ⚠️ Una cuenta hecha «a mano»
  (saldo anterior + entradas − salidas, ordenando por `id`) cuadra sólo 6 % de los renglones: el orden dentro del día
  no es el del banco. Por eso no se recalcula: se usa el cierre del día de Bancos.
- **Lo que el banco nos cobró por falta de saldo o por saldo bajo**, de enero a noviembre (descarga y estados
  subidos):
  - **una penalización por fondos insuficientes**, $1,044 con IVA, BanBajío 4166 (17-jul);
  - ≈ $5.3 mil en penalizaciones por **saldo promedio mínimo** (BBVA 2182, BanBajío 3660, 506 y 854) y por **baja
    facturación** de terminal (Banorte 7744).
  - Ningún concepto de «interés moratorio» ni «gastos de cobranza» como renglón propio del banco.
- **NO MEDIDO:** el recargo que un acreedor mete **dentro** de su cargo (arrendadora, FONACOT, IMSS). El banco sólo
  muestra el total: saberlo exige la tabla del contrato (DCR8).

### 1.7 Lo que propone el detector (`[PGP.209]`, medido el 2026-11-25)

La vista `finance.v_recurring_bank_charges` lee 12 meses de la descarga y de los estados subidos y propone **81
series**: **47 vigentes, ≈ $512 mil al mes, en 10 cuentas** (39 de importe fijo, ≈ $473 mil; 8 de importe variable,
≈ $39 mil: los intereses de Banorte con su IVA y dos seguros), y 34 que ya no cobran. Controles contra hechos que la
vista no usa: las domiciliaciones que traen el RFC del acreedor (13 de 13), los capitales y los intereses de Banorte
por su número de crédito (2 y 2), y las cuotas fijas de §1.2 medidas con otra normalización (129 de 129 cargos).
Placebo (el importe + $37): 0 de 39 series.

**Corrige §1.1:** la arrendadora de Santander 2169 tiene **10 importes que se repiten** (12 cargos al mes: dos
importes se cobran dos veces), no 9 contratos. En noviembre:

- **3 de los 4 cargos de los días 12–14 entraron el 17, 18 y 23.** El porqué es NO MEDIDO; `[PGP.218]` lo mide con
  el saldo de esos días.
- **2 importes de los días 23–27 (≈ $21.5 mil y ≈ $14.4 mil) no han entrado al 25-nov.** Su ventana llega al 27.
  Si no entran, Tesorería debe ver si el contrato terminó o si el banco no pudo cobrar.

De los 32 cargos de noviembre de §1.1 (≈ $708 mil), el detector propone **19, ≈ $420 mil (59 %)**. Lo que no ve:

| Lo que no ve | Cargos | Importe | Por qué | Quién lo cubre |
|---|---:|---:|---|---|
| Intereses de BBVA por disposición | 6 | ≈ $98 mil | Cada disposición vive menos de 3 meses | El contrato de la línea, con su interés calculado (DCR8, `[PGP.210]`/`[PGP.219]`) |
| Comisión de apertura | 2 | ≈ $115 mil | Un solo cargo | El contrato del crédito nuevo |
| Prima de seguro nueva | 1 | ≈ $26 mil | Un solo cargo | Su contrato |
| Dos contratos nuevos de la arrendadora | 2 | ≈ $28 mil | Todavía no llevan 3 meses | El detector los propone en enero; antes, su contrato |
| El seguro de Banorte | 1 | ≈ $4 mil | El concepto cambia de forma entre un estado y otro | Su contrato |
| FONACOT | 1 | ≈ $16 mil | No es cargo automático: es un pago referenciado (CIE) | Es un pago fuera de programa (`[PGP.97]`) |

## 2. Las decisiones (Francisco, 2026-11-25)

| # | Decisión |
|---|---|
| **DCR1** | **El sistema propone los cargos y Tesorería confirma.** |
| **DCR2** | **La Suite lleva los contratos.** Todo cargo tiene que estar sustentado por un contrato. |
| **DCR3** | **La nómina se provisiona.** Cuando RH y Contabilidad pasan el gasto, la provisión desaparece, cada viernes. |
| **DCR4** | **Comisiones recurrentes iguales:** se establece el mecanismo de cobro para que todo quede cargado con su póliza de gasto y abono al proveedor correspondiente. Cuando la Suite identifica el cargo, escribe en Kepler el gasto y el pago. |
| **DCR5** | **El cargo automático confirmado entra al Calendario cada mes programado y sin firma.** La firma es la del contrato. |
| **DCR6** | **La escritura en Kepler sigue después con arrendamiento, seguros e intereses, con Contabilidad**: alta de la arrendadora y de los créditos como acreedores en Kepler, y sus cuentas contables. |
| **DCR7** | **La provisión de nómina se estima con lo pagado por el banco los últimos 4 viernes, por cuenta.** |
| **DCR8** | **Crédito: tabla de amortización del contrato + interés.** Si la tasa es variable, **el interés se calcula un día antes** del cargo. |
| **DCR9** | **El cargo se contempla ANTES de hacer el programa**, para evitar moras, intereses y gastos de cobranza: el programa no puede llevarse el dinero que el banco va a cobrar. |
| **DCR11** | **El PDF del contrato es obligatorio para confirmar arrendamiento, crédito, seguro y FONACOT** (Francisco, 2026-11-26). Opcional para cuotas de comisión (su contrato es el de la cuenta), servicio y nómina. |
| **DCR10** | **La tasa variable la fija el contrato** (referencia + puntos). Mientras no se verifique una fuente contra lo que cobra el banco, el valor del día es **la tasa implícita del último cargo** (interés ÷ saldo ÷ días), rotulada «estimada». Una fuente externa (Banxico) es un feed nuevo y se decide aparte. |

## 3. Cómo queda

### 3.0 Antes del programa: que el dinero del cargo esté en su cuenta (DCR9) — lo primero

Al armar y al autorizar el programa de pagos, el Calendario dice **por cada cuenta de origen**:

- el saldo al cierre de su último día descargado (el de Bancos, §1.6);
- menos lo ya programado desde esa cuenta;
- menos **los cargos automáticos de los próximos 7 días** en esa cuenta;
- menos su saldo mínimo, si el contrato de la cuenta lo pide (las penalizaciones de §1.6).

Si no alcanza, sale el aviso **«esta cuenta no cubre el cargo de &lt;acreedor&gt; del &lt;día&gt;: faltan $X»**,
antes de autorizar. El aviso no bloquea: Tesorería decide si fondea la cuenta o mueve un pago.

- **Qué cargos entran:** los de contrato confirmado y, **mientras el contrato no existe**, la propuesta del detector
  (`[PGP.209]`) rotulada **«esperado por historia, sin contrato»**. Así el riesgo se cubre desde que existe el
  detector, sin esperar la pantalla de contratos. Esto no programa nada (DCR1 intacta): sólo aparta el dinero en
  el cálculo.
- **Lo que no se sabe se dice:** si la última descarga de la cuenta tiene más de 2 días, el aviso dice **«saldo de
  hace N días»**. Sin saldo, dice **«no medido»**, no «alcanza». Los depósitos por venir no se suman: el cálculo es
  del lado seguro, y así se rotula.

**Medido con `[PGP.218]` (C1 y C2, 2026-11-25, prod en sólo lectura).** El saldo es el de Bancos: `saldoConocido` de
Estados de cuenta pasó a ser un primitivo compartido (`saldosConocidos`), y la versión por lote da el mismo saldo
que la anterior en 608 de 608 casos (cuenta × fecha de todo el año). Dos días reconstruidos con la historia hasta
ese día:

- **Santander 2169, cierre del 12-nov: $31,144.45.** Esperaba para el 14 los 4 cargos de la arrendadora ($79,876).
  **Aun sin ningún pago programado faltaban $48,731.55.** El banco los cobró el 13, 17, 18 y 23: el aviso habría
  salido dos días antes.
- **BanBajío 4166, cierre del 16-jul: $729,576.86.** El 17 salieron $738,682.31: faltaban $9,105.45. Ese día el banco
  cobró la penalización por intento de sobregiro.
- **Hoy (25-nov):** Santander 2169 cerró el 24 con $5,183.91 y le faltan los dos cargos de la arrendadora del 24
  (≈ $21.5 mil y ≈ $14.4 mil): **faltan $16,306.09**. Es probable que por eso el banco todavía no los cobre.

**Lo que cambia el diseño:** de los pagos pendientes, la mayoría **no tiene cuenta de origen** hasta que se
prepara (hoy 66 pagos, ≈ $13.3 M en la ventana; 94 en total). El aviso por cuenta cubre los cargos y lo ya
preparado. Lo que no tiene cuenta se dice aparte, y el aviso que lo alcanza es el de «Preparar pago»: si con ese
pago la cuenta deja sin cubrir un cargo.

**La pantalla (C3), pensada antes de escribirla (skill `diseno` §0a/§0b).**

1. **Propósito:** que quien arma el programa sepa, ANTES de comprometer el dinero, qué cuenta no va a cubrir lo que
   el banco cobra solo. Prueba de la frase: «¿qué cuenta se queda corta en los próximos 7 días?».
2. **Quién y con qué** (`ui_usage`, 30 días): el acto dominante es **armar** (540 altas de pago, 622 de facturas,
   3,220 lecturas de la semana); preparar se usó 42 veces y autorizar 3. **El aviso va donde se arma**, no sólo al
   preparar.
3. **Estado real:** hoy Santander 2169 no cubre los dos cargos de la arrendadora del 24 (faltan $16,306.09) y la
   mayoría de lo programado todavía no tiene cuenta de origen.
4. **Qué ve, en orden (nivel 0):** UNA línea en la barra de la semana, junto a la de «pagos en días que ya pasaron»
   y con su mismo patrón, sólo si alguna cuenta se queda corta: «Santander 2169 no cubre el cargo del banco del 24:
   faltan $16.3 mil». Si nada falta, nada se dibuja. Si no se pudo leer o los cargos no se midieron, una línea
   quieta lo dice (nunca un silencio que se lea como «alcanza»).
5. **Qué NO ve:** las cuentas que alcanzan, el detalle de cada cargo y lo que no tiene cuenta. Están a un clic, en
   el desglose. No se agrega panel ni tarjeta a la pantalla del día (el rediseño `[PGP.52]`: un paso a la vez).
6. **Desglose:** la línea abre un panel lateral: por cuenta, el saldo (de qué día y de dónde: descarga o libro),
   lo preparado, los cargos del banco y lo que falta; debajo, cada cargo con su día, su importe y si está
   atrasado, es estimado o es el que no se cubre; al pie, lo programado sin cuenta. Todo viene de un solo
   `GET …/suficiencia`.
7. **Accesibilidad:** un clic desde la semana; cuenta por banco y nombre, nunca sólo el número; sin color como
   único portador (el estado va en palabra); con teclado.
8. **Ligas:** el saldo es de Bancos (enlace a Estados de cuenta). Los cargos son de la historia del banco
   (`[PGP.209]`) y, cuando exista, del contrato (`[PGP.210]`). Lo preparado es del propio Calendario.
9. **¿Le toca?** Sí: DCR9 pide contemplar el cargo al hacer el programa, y el programa se hace aquí. Confirmar el
   contrato vive en `[PGP.214]`. Fondear la cuenta es un traspaso en el banco, fuera de la Suite.
10. **En «Preparar pago» y «Autorizar»:** bajo la cuenta de origen, una línea con lo que pasa **con este pago**
    (`conUnPagoMas`, la misma regla del servidor): el cargo que deja sin cubrir y cuánto falta, o, en voz baja,
    lo que queda. No bloquea.
11. **Aceptación:** el aviso nombra la cuenta, el día y lo que falta; sin saldo dice «no medido»; el saldo viejo
    dice «de hace N días»; nada nuevo en `check:pantalla`; la vista compila (`ngc`).
12. **Lo que la pantalla NO resuelve:** lo programado sin cuenta de origen no se puede atribuir a ninguna cuenta.
    El saldo mínimo de cada cuenta no está registrado (se dice). Los cargos que el detector no ve (§1.7) llegan con
    el contrato.

**Lo que el Excel ya hacía:** el programa de pagos en Excel (enero–agosto, `finance.payment_program`) llevaba los
cargos automáticos con método **«auto»** (arrendadora, factoraje de BanBajío, crédito de Banorte, seguros, revolvencia).
La Suite los perdió al sustituirlo: `[PGP.218]` los devuelve, ahora por su historia y después por contrato.

### 3.1 El contrato (DCR2)

Es dato propio, capturado y confirmado por una persona, así que **sí va en tabla** (regla principal: esto no es un
importer). Cada contrato lleva:

- acreedor y tipo: arrendamiento, crédito, seguro, FONACOT, cuota de comisión, servicio o nómina;
- la cuenta de cargo y la ventana de días;
- la regla del importe: fijo, tabla del contrato o estimado del mes anterior;
- vigencia (inicio y fin), el PDF del contrato y el acreedor de Kepler (opcional);
- estado: `propuesto`, `confirmado`, `terminado` o `cancelado`;
- la evidencia de la propuesta: los cargos del banco que la originaron.

Si un contrato cobra varios conceptos (capital + interés + IVA), cada concepto es un renglón.

**En código (`[PGP.210]`, 2026-11-26):** `finance.charge_contracts`, `finance.charge_contract_lines` y
`finance.charge_contract_schedule` (la tabla de amortización, con el saldo insoluto para el interés de DCR8). Un
contrato «por clasificar» sólo puede ser propuesta: para confirmarlo hay que decir qué es. La tasa variable vive en
el renglón del interés: referencia, puntos y base de días (DCR10). Nada se borra: un contrato se termina o se
rechaza, con motivo.

### 3.2 Propuesta y confirmación (DCR1)

El detector lee el banco en sólo lectura y propone un contrato cuando ve:

- la misma cuenta, el mismo concepto y el mismo importe (±$1) en **3 meses o más**;
- o la serie que baja de un crédito (interés decreciente con capital fijo);
- o, para la nómina, el patrón del viernes.

Tesorería confirma una vez, adjunta el contrato y corrige lo que haga falta. **Nada entra al Calendario sin
confirmar.**

**La API (`[PGP.213]`, 2026-11-26), `finance/charge-contracts`.** Ver con `FINANCE_PAYMENTS_VER`. Todo lo que escribe
—proponer, dar de alta, corregir una propuesta, confirmar, terminar, rechazar y subir el PDF— pide una clave propia,
`FINANCE_CHARGE_CONTRACTS_GESTIONAR`. Se reparte a **tesoreria, finanzas_operativo y finanzas** (Francisco, 2026-11-26).
La clave de Pagos no sirve: la tienen 10 roles, entre ellos Marketing, Compras, Crédito y Contabilidad.

- **Qué se corrige:** sólo una propuesta. Un contrato confirmado ya programa sus cargos con la firma de Tesorería; si
  cambió el contrato real, se termina y se da de alta el nuevo.
- **Cómo se rechaza un cuerpo mal formado:** con un 400 que dice qué corregir, con las mismas reglas que los CHECK de la
  base (`problemasDeEncabezado`, `problemasDeRenglon`).
- **Medido en prod (2026-11-26):** 0 contratos (nadie ha propuesto todavía). Sin contrato del 1 al 25 de noviembre: 59
  cargos, $781,570.77. Es M1.

**Cómo clasifica la propuesta (`[PGP.210]`, reglas explícitas, no adivinadas):** «pago de capital», «pago de
intereses», «intereses no reales» y «pago de IVA» son crédito, y los del mismo número de crédito en la misma cuenta
van en UN contrato. Las comisiones y su IVA (por la categoría de Bancos o por la cabeza del concepto) son cuotas de
comisión. Lo demás queda **por clasificar**: el concepto del banco no dice si una domiciliación es de una arrendadora
o de un seguro. Medido el 2026-11-26: de las 47 series vigentes salen 41 propuestas (2 créditos de 4 renglones, 25
cuotas de comisión y 14 por clasificar). Una propuesta rechazada no se vuelve a proponer.

### 3.3 Cada mes, el cargo programado

Cada contrato confirmado genera el cargo de su periodo **en `finance.financial_commitments`**: la fuente que el
Calendario ya lee, no una nueva.

- Lleva `contract_id` y `period`, únicos, así que generar dos veces no duplica.
- Queda programado como **`cargo_automatico`** en su cuenta y su día, **sin firma mensual** (DCR5).
- Cuando el banco cobra, `[PGP.121]` lo marca pagado.

**El crédito (DCR8):** el capital sale de la **tabla de amortización** del contrato. Si la tasa es fija, el interés
también sale de la tabla. Si es variable, el día anterior al cargo la Suite recalcula el interés con la regla del
contrato (saldo insoluto × tasa vigente × días del periodo, con la base que diga el contrato). Hasta ese día, el
cargo se ve como **«interés estimado»** (`[PGP.219]`).

Si el contrato tiene acreedor en Kepler (FONACOT, el arrendamiento de BBVA, el seguro de Banorte), el cargo **se liga
al documento de Kepler** y el Calendario muestra uno, no dos.

**En código (`[PGP.211]`, 2026-11-26):** migración `20261126011012` (columnas `contract_id`, `contract_line_id`,
`period` y `amount_basis` en `finance.financial_commitments`, únicas por renglón y periodo; los 10 subtipos) y
`charge-contracts/cargo-del-mes.sql.ts`, los únicos caminos que escriben el cargo de un contrato:

- **Generar** (`generarCargosDelMes`): por cada renglón de un contrato confirmado, el cargo de **este mes y el
  siguiente** (así el de diciembre de la arrendadora existe desde noviembre). El compromiso y su pago en el día
  esperado, `cargo_automatico` desde la cuenta del contrato, **ya autorizado: la firma es la del contrato**
  (`contrato:<id>`, DCR5). Reserva con la misma regla del Calendario (`recalcularObligacion`, sacada del servicio a
  su archivo para no copiarla). El importe: **fijo** × cargos del periodo (la arrendadora: 2 × $21,291); **tabla**
  = las filas de ese mes; **estimado** = lo último que cobró el banco por ese renglón (DCR8/DCR10, se rotula).
  No genera, y dice por qué: ya cobrado este mes, acreedor en Kepler (su documento ya está en el Calendario: **no
  se liga todavía, se omite**, y así no sale dos veces), semanal (es `[PGP.215]`), fuera de vigencia, estimado sin
  un cobro anterior, día ya autorizado completo. Generar dos veces = las mismas filas.
- **Cerrar** (`cerrarCargosCobrados`): ⚠️ **no con `[PGP.121]`**, que casa por importe ±$1 y ±3 días, uno a uno. En
  noviembre la arrendadora cobró hasta 9 días tarde y dos renglones del mismo importe el mismo día quedarían
  «disputados». Se cierra por la liga de `[PGP.212]`: las salidas «con contrato» de **ese renglón**, entre 10 días
  antes y 25 después del día esperado, tantas como cargos por periodo (con 1 de 2, espera). El estimado toma lo
  que cobró el banco. Una salida ya ligada a otro pago no se toma, y las salidas del grupo quedan en la bitácora:
  `[PGP.121]` las lee (`SQL_SALIDAS_LIGADAS` ahora incluye `pagado_por_contrato`) y ningún otro pago se queda con
  la segunda.
- **El aviso de `[PGP.218]` no lo cuenta dos veces:** la serie cuyo cargo ya está programado sale de «esperado por
  historia»; el cargo cuenta como pago pendiente de la cuenta.

Quién llama a generar y cerrar cada día es `[PGP.213]` (C2). El interés variable un día antes es `[PGP.219]`: hasta
entonces el interés va «estimado».

**En código (`[PGP.213]`, 2026-11-26): quién lo llama, sin reloj.** Edgar no quiere cron en el Calendario (`[PGP.117]`,
`[PGP.121]`), así que lo dispara la carga del banco: `CargosDelBancoService` escucha `bancos_movimientos` en el worker y,
por tenant, corre **proponer → recalcular el interés → programar el cargo del mes → cerrar lo cobrado**. Cada paso falla
solo y se dice; todo es idempotente. Se apaga con `DISABLE_CARGOS_DEL_BANCO=true`. Además:

- **Al confirmar**, el cargo del mes se programa en ese momento, no hasta la siguiente carga.
- **Al terminar**, lo programado **después del fin** sale del Calendario (`retirarCargosTrasElFin`, con su bitácora). Lo
  de antes se queda, porque el banco cobra hasta 9 días tarde y `cerrarCargosCobrados` lo cierra. Un día ya autorizado no
  se toca: se dice. Lo encontró la prueba con base real: un arrendamiento terminado seguía con su cargo de diciembre
  «esperando al banco».
- **Junto a `[PGP.121]`**, que escucha el mismo canal y cierra por importe (±$1, ±3 días): no se pisan. Lo que él cierra
  ya no está pendiente; lo que deja (cobro tarde, dos cargos iguales el mismo día) lo cierra el contrato. El orden entre
  los dos oyentes no está fijo.
- **`[PGP.117]` no libera los cargos de un contrato:** no son facturas de Kepler, su cierre queda «sin medir» y la regla
  los conserva.

**En código (`[PGP.219]`, 2026-11-26):** el interés de un crédito ya no es «lo último que cobró el banco» sino **saldo ×
tasa implícita del último cargo × días** (`interesDelPeriodo`, `@megadulces/contracts`), y sigue rotulado «estimado»
(DCR10). Lo medido en prod con los dos créditos de Banorte (enero–noviembre), y que fija la regla:

- **El periodo va del día del contrato de un mes al del siguiente**, no de cobro a cobro (el banco cobró el 6 de abril,
  el 6 de julio y el 7 de septiembre; con esas fechas el interés por día deja de ser una recta).
- El interés por día baja lo mismo cada mes (la tasa por el capital): de ahí salen **el saldo y la tasa sin el
  contrato** (el saldo, un múltiplo exacto del capital; la tasa, constante en cada crédito, base 360). Si la tasa cambió y no hay tres cobros
  seguidos con la misma, la regla lo dice y se queda lo último cobrado (regla 10: no se inventa).
- El banco parte el interés: **«pago de intereses»** (el real, con IVA del 16 %) e **«intereses no reales»** (saldo ×
  la inflación del mes, sin IVA; la misma en los dos créditos). La inflación del mes se publica después del cobro: el
  reparto y el IVA usan la del mes anterior.
- Predecir cada mes con los anteriores: el interés casa **±$0.02 en 14 de 14**; «lo último cobrado» erraba $307–$2,662.
  El cargo con IVA, por la inflación, yerra hasta $1,450 un mes (en 7 meses, $3.1–3.6 mil contra $8.3–12.9 mil).

`generarCargosDelMes` lo usa para los renglones de interés y de IVA de un crédito (con la historia de la **serie** de
cada renglón) y `recalcularInteresesDelCredito` lo vuelve a correr **un día antes** del cargo: si llegó un cobro con
otra tasa, corrige lo programado y deja el antes y el después en la bitácora. Con el capital por tabla no calcula (se
dice). Una fuente externa de la tasa o de la inflación es un feed nuevo y se decide aparte (DCR10).

### 3.4 El cargo sin contrato (DCR2)

Todo cargo automático del banco que no casa con un contrato confirmado queda **«sin contrato»**, con su porqué. Es
un hallazgo para Tesorería, no un gasto que se da por bueno. El indicador M1 (§5) mide cuánto falta.

**En código (`[PGP.212]`, 2026-11-26):** `finance.v_automatic_bank_charges`. Un cargo automático es un movimiento de
una serie de `[PGP.209]` o un retiro con concepto de cargo automático (domiciliación, cobranza domiciliada, prima,
crédito, disposición, apertura, tarjeta domiciliada, STM, seguros). Así entran también los de un solo mes. **No** entran
el «cargo por pago concentración» de Banorte ni el CIE de BBVA: son pagos referenciados que hace la empresa
(impuestos, luz, teléfono, FONACOT). El porqué: con contrato, importe distinto, fuera de vigencia, propuesta sin
confirmar, propuesta rechazada o sin contrato. Medido: **561 cargos en 12 meses (≈ $24.3 M); noviembre 1–25, 59 cargos
por $781,571**, todos sin contrato.

⚠️ **Corregido con `[PGP.219]`:** un renglón casaba con un cargo por su serie **o** por la misma cabeza del concepto en
la misma cuenta. Banorte tiene dos créditos en la misma cuenta con las mismas cabezas y distinto número: por la cabeza,
el cobro de uno quedaba ligado al contrato del otro (30 de 60 en la prueba). Ahora la cabeza sólo liga si al cargo o al
renglón le falta serie.

### 3.5 La nómina provisionada (DCR3)

Cada viernes nace una **provisión** de nómina en el Calendario, estimada con lo pagado por el banco los últimos 4 viernes,
por cuenta (DCR7). Cuando aparecen en Kepler los
documentos `GN001` de esa semana (RH y Contabilidad «pasan el gasto»):

- la provisión **desaparece**;
- quedan los documentos reales, que el Calendario ya lee como deuda de Kepler.

Si la semana no trae documentos, la provisión **se queda y se ve vencida**: nunca se borra sola.

### 3.6 Las cuotas fijas de comisión, escritas en Kepler (DCR4)

Con el contrato confirmado, cada cargo identificado arma el **gasto `X-A-10` + un pago `X-D-26` por cargo, con su
póliza** (cargo al gasto e IVA, abono al acreedor). Lo arma **el mismo armador de `[CB.62]`**
(`comisiones-kepler.armador.ts`) junto con `gasto-kepler.armador.ts` (anexo G, G.3). **No hay escritor propio**
(ADR-056). La diferencia con la comisión de terminal: no hay bloque de depósito ni día de venta, así que el día es el
del cargo y la sucursal sale del contrato.

- **Cuándo escribe:** sólo cuando el escritor de CB.62 esté encendido, con sus tres candados (`[CB.62.4]`).
- **Contra duplicados:** el mismo candado de `cruzarConKepler`. Un cargo que Finanzas ya capturó no se escribe.

### 3.7 Lo que este anexo NO hace

- La comisión **variable** de terminal: es `[CB.62]` (Edgar).
- Las compras con tarjeta de débito (≈ 322 cargos, $0.46 M en noviembre): no tienen contrato. Son comprobación de
  gasto ([anexo G](FASE_PGP_ANEXO_COMPROBACION_DE_GASTO.md)).
- Traspasos entre cuentas y la mercancía pagada fuera de programa: son `[PGP.97]`.
- La categoría de cada movimiento: es el motor de Bancos (anexo BFU, Edgar). El detector **lee** las categorías y
  no toca `motor-de-categoria.ts` ni `clasificador.ts`.

## 4. Items

| Item | Capa | Qué | Criterio verificable |
|---|---|---|---|
| `[PGP.209]` | C0 | **Detector de cargos recurrentes**, de sólo lectura, sobre la descarga y los estados subidos (§3.2) | Control: propone los 9 contratos de la arrendadora, el de BBVA, los 2 capitales de Banorte y las cuotas fijas de §1.2. Placebo (importe +$37): 0. Mutante (quitar la regla de 3 meses) → rojo |
| `[PGP.210]` | C1 | **El contrato:** `finance.charge_contracts` y sus renglones, con `tenant_id`, audit y RLS. Migración generada (`node scripts/nueva-migracion.js`) e idempotente | `up()` real contra Postgres; cada camino de inserción probado |
| `[PGP.211]` | C1 | **El cargo de cada mes** en `finance.financial_commitments` (columnas `contract_id` y `period`, y subtipos nuevos además de factoraje, interés, amortización y otro), programado como `cargo_automatico` (§3.3) | Generar dos veces = mismas filas. FONACOT no sale dos veces. El cargo de diciembre de la arrendadora aparece antes del día 12 |
| `[PGP.212]` | C1 | **Cargo sin contrato** (§3.4) | Hoy ≈ $0.7 M sin contrato (M1). Prueba negativa: un contrato confirmado lo saca de la lista |
| `[PGP.213]` | C2 | **API de contratos:** proponer, confirmar (sólo Tesorería), editar y terminar. PDF con `ObjectStorageService` (platform-core). Contrato en `libs/contracts` | Probado contra Postgres real con el payload de la pantalla (regla 13). Permiso repartido en prod (regla 20) |
| `[PGP.214]` | C3 | **Pantalla de contratos:** propuestas por confirmar, vigentes y cargos sin contrato | `diseno` §0b por escrito. `check:pantalla` antes y después. Validación visual en los 3 perfiles |
| `[PGP.215]` | C0→C2 | **Nómina provisionada** (§3.5, DCR3). C0: qué documento `GN001` corresponde a qué viernes y si cubre todas las sucursales | Control: semana del 16-nov ($541 mil en Kepler contra $496 mil en el banco). Semanas de octubre sin documento → la provisión se queda |
| `[PGP.216]` | C0→C2 | **Cuotas fijas de comisión a Kepler** (§3.6, DCR4). C0: cómo las captura hoy Finanzas (acreedor `GB*`, grano, cuenta contable) | Sombra: lo armado = lo capturado por Finanzas, renglón por renglón. Candado: lo ya capturado no se escribe. **Depende de `[CB.62.4]`** |
| `[PGP.217]` | C0→C2 | **Escribir en Kepler también los demás cargos con contrato**: arrendamiento, seguros e intereses (DCR6). Con Contabilidad: alta de los acreedores que faltan y sus cuentas | Va después de `[PGP.216]` en prod. Misma sombra y mismo candado |
| `[PGP.218]` | C2→C3 | **Antes del programa, el dinero del cargo en su cuenta** (§3.0, DCR9): saldo al cierre (Bancos) − lo programado − los cargos automáticos de 7 días − el saldo mínimo, por cuenta, con aviso al armar y al autorizar | Control: repetir el 17-jul de BanBajío 4166 (penalización por fondos insuficientes); el aviso habría salido. Si los estados subidos no traen ese saldo, se declara. Prueba negativa: sin cargos esperados, no hay aviso. Saldo viejo → «hace N días» |
| `[PGP.219]` | C0→C1 | **Interés variable calculado un día antes** (§3.3, DCR8) | C0: recalcular el interés de Banorte de octubre y noviembre con saldo, tasa y días, y que case con lo cobrado ±$1. Sin la tasa del contrato: NO MEDIDO, y el cargo queda «estimado» |

**Orden de entrega (DCR9 manda):** `[PGP.209]` detector → `[PGP.218]` aviso antes del programa → `[PGP.210]`/`[PGP.211]`
contrato y cargo del mes (+ `[PGP.219]`) → `[PGP.213]`/`[PGP.214]` API y pantalla → `[PGP.212]` sin contrato →
`[PGP.215]` nómina → `[PGP.216]` cuotas a Kepler → `[PGP.217]` lo demás a Kepler.

## 5. Métricas (medidas hoy, 2026-11-25)

| # | Métrica | Hoy |
|---|---|---|
| M1 | $ de cargos automáticos del banco sustentados por un contrato confirmado | **0 %** de ≈ $0.69 M (noviembre, 1–25; sin FONACOT, §1.7). Con la definición de `[PGP.212]` (que suma las cuotas de comisión): **0 % de $781,571** (59 cargos) |
| M2 | Cargos automáticos que estaban en el Calendario **antes** de que el banco los cobrara | **0 de 31** |
| M3 | Viernes de nómina con provisión en el Calendario | **0 de 4** (noviembre). Pagos de nómina en el Calendario: 1 de 77 |
| M4 | Cuotas fijas de comisión que la Suite escribió en Kepler | **0 de ≈ 40** al mes |
| M5 | Penalizaciones del banco por fondos insuficientes o saldo bajo | **≈ $6.4 mil de enero a noviembre**: 1 por fondos insuficientes y el resto por saldo promedio o baja facturación (§1.6) |
| M6 | Programas autorizados que dejaron una cuenta sin el dinero de su cargo automático | **NO MEDIDO**: hoy nada lo calcula. Se mide desde `[PGP.218]` |

## 6. Lo que queda abierto

Nada: DCR10 la firmó Francisco el 2026-11-25 (§2).

## 7. Riesgo inmediato, sin esperar código

Kepler sigue dando **pendiente el FONACOT de noviembre** (`GF002`, ≈ $16 mil, vencimiento 11-nov), y el banco ya lo
cobró ese día por el importe exacto. Si alguien lo programa en el Calendario, **se paga dos veces**. Tesorería: no
programarlo y registrar el pago en Kepler. Es el mismo caso que `[PGP.197]` (CD031).

Corregido con `[PGP.209]` (§1.7): FONACOT no es un cargo automático, es un pago referenciado (CIE) que alguien
de la empresa manda fuera del programa. No es un contrato de este anexo. Lo cubre la conciliación de las salidas
del banco sin programa (`[PGP.97]`): ese pago tiene que ligarse al documento `GF002` para que Kepler deje de darlo
pendiente.

## 8. Lo NO MEDIDO

- Los intereses del crédito nuevo del 20-nov a partir de diciembre.
- El plazo restante de los créditos y de los arrendamientos: sale del contrato (DCR2).
- El recargo que un acreedor mete dentro de su cargo (§1.6).
- La tasa variable de cada crédito. Hasta tener el contrato, la implícita del último cargo, «estimada» (DCR10).
- Lo que el detector no ve (§1.7): una disposición de crédito con menos de 3 meses, un cargo cuyo concepto cambia de
  forma entre estados, y el cargo de un solo mes.
- Cómo captura Finanzas hoy las cuotas fijas en Kepler (`[PGP.216]` C0).
- La historia de antes del 31-oct sale de los estados **subidos**, no de la descarga: un mes que nadie subió no está
  (agosto sólo existe en el libro, que reescribe el concepto).

## 9. Primitivos (ADR-056)

| Necesidad | Se reusa | Nuevo |
|---|---|---|
| Dónde vive el cargo del mes | `finance.financial_commitments` (TP.1), que el Calendario ya lee | sólo `contract_id`, `period` y subtipos |
| Cerrar el cargo con el banco | la liga de `[PGP.212]` + la bitácora y `SQL_SALIDAS_LIGADAS` de `[PGP.121]` (§3.3: casar por importe falla con el cobro tarde) | `cerrarCargosCobrados` |
| Reservar y pagar la obligación | `recalcularObligacion` (el cuerpo de `recalcObligation` del Calendario, movido a su archivo) | — |
| Escribir en Kepler | armador de `[CB.62]` + `gasto-kepler.armador.ts` (G.3) | — |
| Guardar el PDF | `ObjectStorageService` | — |
| El saldo de cada cuenta | `cierreDelDia` / `cuadresDeLaDescarga` de Bancos (`[CB.73]`, `[CB.85]`) | — |
| El contrato | — | `finance.charge_contracts` (dato propio, HITL) |
| El interés de un crédito (`[PGP.219]`) | `fechaEsperadaDelPeriodo` (el día del contrato, de `[PGP.211]`); la historia de las series de `[PGP.209]` vía la vista de `[PGP.212]` | `interesDelPeriodo` en `@megadulces/contracts` (regla pura) |
| Corregir el importe de un estimado | — | `ajustarImporteEstimado`: uno para el cierre (lo que cobró el banco) y el recálculo de un día antes |

⚠️ **Deuda con nombre:** `[PR.3]` de Presupuestos también genera obligaciones mensuales, desde el plan (estado
`propuesta`). El generador mensual debe ser uno solo; se decide en `[PGP.211]` con Presupuestos. Si quedan dos, queda
anotado aquí.

**Decidido en `[PGP.211]` (2026-11-26): quedan dos, porque no generan lo mismo.** Medido (prod, sólo lectura):
`[PR.3]` tiene 312 obligaciones en `budget.expense_obligations`, todas `propuesta`, de 2027, por **rubro del plan**
(sueldos 24; operativo 288: papelería, tecnología, gastos administrativos, contables, de dirección…), ninguna en el
Calendario y **0 de 312** con concepto de arrendamiento, seguro, crédito, interés, comisión, FONACOT, domiciliación o
prima. `[PGP.211]` genera el **cargo de un contrato** del banco, ya autorizado. Si un rubro del plan llega a cubrir
cargos del banco, el sobre del plan y el cargo del contrato contarían dos veces: ese día, el rubro se descuenta del
cargo del contrato, con Presupuestos. Hoy no pasa (0 de 312).
