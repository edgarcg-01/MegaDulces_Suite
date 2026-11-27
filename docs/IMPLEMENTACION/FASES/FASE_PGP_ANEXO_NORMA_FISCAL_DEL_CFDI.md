# Fase PGP — Anexo NF: la norma fiscal del CFDI (qué factura sirve para pagar, comprar, gastar o vender)

> Anexo de [`FASE_PGP_PAGO_A_PROVEEDOR.md`](FASE_PGP_PAGO_A_PROVEEDOR.md). El método: [`docs/METODO_DE_TRABAJO.md`](../../METODO_DE_TRABAJO.md).
> **No es una fase nueva:** son items `[PGP.222]`–`[PGP.230]` dentro de PGP, que ya está abierta. Toca también Gastos
> (anexos S y G), Compras (expediente RE, libro de compras LC) y Ventas; el freno que más pesa es el del pago.

## 0. El pedido

Francisco, 2026-11-26: *«analiza la trazabilidad de los UUID —las facturas timbradas por el SAT que nos da ContPAQi— que
hoy ya tenemos vigentes y disponibles para cargarlas a las compras, a los gastos y a las ventas emitidas por nosotros.
Ayúdame a generar algunos frenos: cuando la factura está timbrada en **PUE** con un mes anterior, que no pueda pasar a
pago a menos de que esté dentro del mes en curso; las facturas **sin efectos fiscales** que pasen un filtro de
**autorización de Administración y Contabilidad** para determinar si se pueden pagar o no; en el **régimen fiscal**
tiene que ser persona física con actividad empresarial. Detecta todos los documentos que están fuera de esa norma. Hay
algunos que se usan de manera informativa, pero que no puedan usarse para registrar un pago, una compra o una venta.»*

Tres reglas, y una idea que las une: **un CFDI fuera de norma se puede VER, pero no se puede USAR para registrar.**

## 1. De dónde viene cada UUID y dónde se usa

**La fuente es una sola tabla, `fiscal.cfdis`** (regla 1: nada se copia). Medido en prod, sólo lectura, 2026-11-26:

| Origen | Recibidas | Emitidas | Al día |
|---|---:|---:|---|
| ContPAQi ADD (`source = 'contpaqi_add'`) | 170,943 | 265,425 | hasta el 25-nov |
| Descarga masiva del SAT (`source = 'descarga_masiva'`, desde ene-2026) | 3,426 | 20,248 | hasta el 26-nov |

- La empresa es **persona física con actividad empresarial: régimen 612** (lo dice el propio SAT: 36,305 de 36,950
  recibidas 2025–2026 traen `RegimenFiscalReceptor = 612`; 97,559 de 97,675 emitidas traen el emisor en 612; y
  `fiscal.issuer_config.regimen_fiscal = '612'`).
- **El estatus en el SAT** (`estatus_sat`) lo llena el escáner nocturno (`estatus-scanner.service.ts`, 01:30, 2,500 por
  noche, primero las recibidas). ⛔ La columna nace en `'desconocido'`, así que todo filtro `<> 'cancelado'` deja pasar lo
  no verificado. Recibidas 2026: verificadas todas menos **92** de ingreso y egreso (las recién llegadas de noviembre). **Emitidas 2026: 1,889
  verificadas de 59,621 (3 %)** — de una venta casi nunca se sabe si sigue vigente.

**Dónde se usa un UUID para registrar algo** (barrido del código, 2026-11-26; 16 puntos):

| Uso | Punto | Cómo se liga el UUID | Qué revisa hoy | ¿Escribe? |
|---|---|---|---|---|
| **Pago** | Calendario `[PGP.108]` (`cfdi-factura.sql.ts`, `cfdi-factura.contract.ts`) | Se infiere: documento de Kepler (`kdxe`) → RFC → total ±$1, fecha ±45 días, uno a uno | tipo I, no cancelada; **avisos** de PUE fuera de mes, 69-B, cancelada (`avisosFiscales`, `[PGP.158][PGP.163]`) | ⛔ `autorizar`, `ejecutar` y `crear` **no leen el CFDI**: los avisos sólo se pintan |
| Pago | Póliza de egreso ContPAQi (`contpaqi-armado.service.ts`, `dictamen.ts`) | `kdxf`→`kdxe`→CFDI, o la persona confirma | El dictamen **bloquea** cancelada y otro receptor; nada de uso, método ni régimen | Sí (TXT de pólizas) |
| **Gasto** | Bandeja del SAT S.13 (`facturas-sat.service.ts`, `fueraDeLaBandeja`) | RFC de acreedores G* | tipo I, no cancelada; saca G01, I01–I08, moneda, retenciones. **Deja entrar S01 y cualquier régimen** | Sólo descartes |
| Gasto | Crear solicitud (`solicitud-gasto.service.ts` `crear`) | La persona elige el UUID | tipo I, no cancelada, total ±$1, RFC del acreedor, no repetido | **Sí** (vale + X-A-15 en Kepler) |
| Gasto | Comprobación X-A-10 (`comprobacion-gasto.service.ts`) | El UUID del vale | ⛔ **Sólo `rol = 'recibidas'`**: ni estatus ni tipo | **Sí** (X-A-10 + póliza en Kepler) |
| Gasto | Caja (`caja-autofill.service.ts` → `cash_ledger.origen_uuid`) | El último CFDI del RFC | Nada | Sí |
| **Compra** | Expediente de la entrada RE.35 (`expediente-verdict.ts`, F1–F12) | Asignación confirmada > UUID leído > llaves | F2 régimen del receptor = `issuer_config`, F3 uso G01, F5 método/forma, F8 cancelada, F9 69-B | Sólo muerde en un camino de `validateBulk`; `validate` y «cuadra al peso» lo saltan |
| Compra | Factura compartida RE.86, materialidad (`cfdi_assignments`) | La persona / RFC + total + fecha | tipo I y no cancelada; **`confirm()` no revisa nada** | Sí |
| Compra | Libro de compras (`purchase-book.service.ts`) | Todo el mes | tipo I; **sólo `vigente`** (el único candado de estatus de la Suite) | Sí (TXT) |
| **Venta** | Emisión de la Suite (`emision.service.ts`) | El PAC devuelve el UUID | Datos del cliente; el PAC rechaza | Sí. Hoy **0 pedidos** facturados así |
| Venta | Nota de crédito / REP (`emision.service.ts`) | El UUID original | Rechaza original cancelado | Sí |
| Venta | Ajuste de abono (`ajuste-abono.service.ts:77-88`) | Serie+folio del REP | ⛔ Compara contra `'Cancelado'` con mayúscula: **nunca excluye nada** | Sí |

⛔ **Ninguno de los 16 puntos aplica las tres reglas del pedido.** S01 sólo se frena de rebote en Compras (F3 exige G01).
El régimen 612 no está escrito en ningún lugar (F2 compara contra la configuración, y sólo en el expediente).

## 2. Lo medido (prod, sólo lectura, 2026-11-26)

| Regla | Documentos 2026 | Monto | Lo que hay detrás |
|---|---:|---:|---|
| **PUE de un mes anterior, abierta en Kepler, forma 02/03** (espera NUESTRO pago) | **16** | **$411,112.84** | 9 gastos (G03) y 7 de mercancía (G01). Son las que el freno detendría hoy |
| PUE de un mes anterior, abierta en Kepler, forma 04/28/01 (tarjeta o efectivo) | 139 | $713,984.22 | **No se frenan**: se pagaron al momento. Kepler las tiene abiertas porque nadie aplicó el pago (hallazgo aparte, §7) |
| PUE pagadas en el Calendario fuera de su mes (desde el 19-oct) | 2 de 21 PUE ligadas | $58,551.92 | Pendientes hoy en el Calendario: **0** |
| **Uso S01 «sin efectos fiscales»** (I y E, vigentes) | **166** | **$1,732,946.49** | 110 son de **BBVA** (comisiones que el banco cobra solo, ver anexo CR); 22 de una gasolinera; 3 de una aseguradora |
| **Régimen del receptor ≠ 612** (I y E, vigentes) | **80** | **$3,447,931.03** | ⚠️ **27 son del IMSS ($2.97 M) timbradas con 606**; agua, CFE y seguros también. No las va a re-timbrar nadie |
| Régimen del emisor ≠ 612 en las **emitidas** | 116 | $977,740.00 | 27 facturas de **renta** (606) a un cliente + 89 REP. Son ingreso de la persona, **no venta** de la distribuidora |
| Recibidas **canceladas** en el SAT (I y E) | 246 | $9,023,191.07 | De las 195 de ingreso, sólo 2 traen REP |
| Recibidas con estatus **sin verificar** | 92 | $3,066,550.37 | Las de noviembre que el escáner no ha visto |

Para el contexto: llegan ~500 PUE recibidas por mes (86 % gastos G03, ~$4 M/mes). La mercancía es 90 % PPD
(5,721 PPD contra 633 PUE en 2026).

⛔ **Lo que no se sabe y se declara:** de los 3,116 documentos de deuda abierta de 2026, sólo 871 casan con UN CFDI
(188 con varios, el resto sin CFDI o sin RFC). En el Calendario, **83 de 196 renglones pendientes (42 %) no tienen CFDI
ligado**: sobre ellos ningún freno puede decidir. Las cifras de PUE de arriba son un **piso**.

**La lista completa** (UUID por UUID, con emisor, motivos y qué puede hacerse) **no va al repo, que es público**: se
generó en `C:\DEV\_reportes\cfdi_fuera_de_norma_2026-11-26.xlsx` (5 hojas: resumen, recibidas, PUE abiertas, emitidas, cómo
se midió) para Administración y Contabilidad.

## 3. La norma: una regla, en un solo lugar

**`normaFiscalDelCfdi(cfdi, uso, fecha)`**, pura, en `libs/contracts` (ADR-056: el primitivo vive en `libs/`, no en cada
módulo). Recibe el CFDI tal como está en `fiscal.cfdis`, el **uso** (`pago` · `compra` · `gasto` · `venta`) y la fecha de
la operación; devuelve un veredicto y sus motivos:

| Veredicto | Qué significa |
|---|---|
| `apta` | Se puede usar para registrar |
| `requiere_autorizacion` | No se usa hasta que Administración y Contabilidad decidan (y queda quién y cuándo) |
| `solo_informativa` | Se ve, se consulta, se descarga; **no** registra un pago, una compra, un gasto ni una venta |
| `sin_medir` | No se sabe (estatus sin verificar, CFDI sin ligar): se **dice**, nunca se pinta como apta |

| Regla | Condición | Pagar | Comprar / gasto | Vender | Cómo sale de ahí |
|---|---|---|---|---|---|
| **N0** cancelada | `estatus_sat = 'cancelado'` | informativa | informativa | informativa | La que la sustituye |
| **N1** PUE de mes anterior | `metodo_pago = 'PUE'`, forma **02/03**, y el mes del CFDI es anterior al mes **en que sale el dinero** | **no se paga** | se registra (el freno es al pago) | — | El proveedor la cancela y la sustituye por PPD (y emite su REP al cobrar) |
| **N2** sin efectos fiscales | `receptor_uso_cfdi = 'S01'`, salvo un traslado (tipo T: el SAT exige S01) | requiere autorización; **la comisión que el banco cobra solo pasa por regla** (D-NF4: BBVA, Banorte y Santander) | requiere autorización; el banco pasa | — (en ventas, S01 es lo normal: la factura global) | Autorización «se usa» / «no se usa» |
| **rol** | recibida usada como venta, o emitida usada como pago/compra/gasto | informativa | informativa | informativa | — |
| **N3** régimen | recibida: `receptor_regimen ≠ '612'` · emitida: `emisor_regimen ≠ '612'` | requiere autorización (D-NF3); **el IMSS, excepción por regla**, y **la comisión S01 del banco** (D-NF4) | requiere autorización; el IMSS y la comisión del banco pasan | **no es venta** | Autorización, o el emisor la re-timbra con 612 |
| **N4** sin verificar | `estatus_sat` no es `vigente` ni `cancelado` | **sin medir: no se paga** (D-NF5) | aviso | aviso (sólo 3 % de las emitidas está verificado: un candado borraría la venta, D-NF7) | El escáner la verifica |

**Construida (`[PGP.223]`, 2026-11-26):** `libs/contracts/src/finance/norma-fiscal-cfdi.contract.ts`. La decisión
es **por UUID y por regla** (`[PGP.224]`: un renglón vivo por regla, y basta una firma, de Administración o de
Contabilidad, D-NF2): la S01 y el régimen de la misma factura se deciden aparte, y si aparece otra regla después (p. ej.
la cancelan), esa no está cubierta y vuelve a detener. El motivo dice quién decidió. La excepción del IMSS es **sólo** del régimen: un IMSS cancelado
sigue sin servir. Con la regla se agregó **rol**, que ya hacía falta: la caja guarda un `origen_uuid` sin revisar (§1).

Tres cuidados que deciden el diseño:

1. **N1 se mide contra la fecha en que sale el dinero, no la de programar.** Un pago programado el 28-nov para una PUE de
   noviembre que sale el 2-dic ya cae en el freno. Por eso se revisa al programar y **otra vez al autorizar**, contra el
   día del pago y nunca antes de hoy. ⛔ **No al marcar pagado** (corregido al construir `[PGP.225]`): `execute()` exige
   que el banco ya muestre la salida; negarse ahí dejaría como pendiente un pago que ya salió. Lo que salió fuera de su
   mes lo dice el aviso `pue_pagada_fuera` de `[PGP.158]`. Sólo forma 02/03, como el aviso de hoy (`FORMAS_PUE_POR_PAGAR`): con tarjeta o efectivo la PUE ya se pagó.
   La fecha del CFDI es la de emisión (`Fecha`, la misma del aviso `[PGP.158]`); con la de timbrado cambian de mes 35 de
   5,764 PUE de 2026 (D-NF9). ⛔ **Y se lee según su descarga** (`shared/dia-del-cfdi.sql.ts`, corregido el 2026-11-26
   antes del merge): ContPAQi guarda la hora LOCAL del XML como si fuera UTC (2,232 de 2,232 medidas), la descarga
   masiva guarda el instante real. El Calendario leía todo en hora de México y pasaba al mes anterior **21 PUE 02/03 de
   2026** timbradas el día 1 de madrugada: el freno las habría detenido por error, y el aviso de `[PGP.158]` las marcaba
   igual. Deuda con nombre: las ventanas de `[PGP.178]` (pagadas canceladas) todavía leen en hora de México.
2. **La autorización es dato propio, no una copia del CFDI:** tabla HITL `finance.cfdi_norm_authorizations` (tenant,
   UUID, regla, decisión, motivo, quién y cuándo; revocar en vez de borrar), **construida en `[PGP.224]`**. Sin columna
   de área: con una sola firma (D-NF2), el área la dice el puesto de quien decidió. Su clave de permiso se **reparte en
   prod** con la pantalla (`[PGP.229]`, regla 20). ⚠️ Los UUID de `fiscal.cfdis` están en **mayúsculas** (los 174,384
   recibidos, medido el 26-nov); la tabla los guarda en minúsculas y el lector compara en minúsculas.
3. **El SQL sólo trae candidatos; la regla decide en TS.** Si un consumidor necesita filtrar en SQL, filtra un
   superconjunto (`cancelado` o `S01` o régimen ≠ 612 o PUE) y una prueba demuestra que el SQL no pierde nada que la regla
   frena. Nada de reescribir la regla en una vista.

## 4. Dónde entra cada freno

| Punto | Cambio | Reglas |
|---|---|---|
| Calendario: crear, sumar factura, reprogramar · autorizar el pago y el día | **Construido (`[PGP.225]`)**: el servidor rechaza (409, factura por factura con su motivo) **antes de escribir**. Al programar detiene cancelada y PUE de mes anterior; al autorizar, además, lo que el SAT no ha verificado. Con `[PGP.224]`, una decisión «no se usa» ya detiene y una «se usa» quita el aviso. Con `[PGP.229]`, S01 y régimen **sin decisión** se programan pero **no se autorizan**, y el 409 dice dónde decidir. Lo que no liga un CFDI único pasa (D-NF6) | N0, N1, N2, N3, N4 |
| Póliza de egreso ContPAQi (dictamen) | Suma N1–N3 a lo que ya bloquea | N1, N2, N3 |
| Bandeja del SAT y crear solicitud | Lo informativo no se puede elegir; S01 espera su autorización | N0, N2, N3, N4 |
| Comprobación X-A-10 | Revisar estatus y tipo, que hoy no revisa | N0, N3 |
| Caja (`origen_uuid`) | Validar el UUID que se guarda | N0, N3 |
| Expediente RE, factura compartida, materialidad `confirm()`, libro de compras | La misma norma en todos los caminos (hoy `validate` individual salta F1–F12) | N0, N2, N3 |
| Ventas (cruce de ingreso, emisión, ajuste de abono) | Emitida con régimen ≠ 612 no cuenta como venta; arreglar `'Cancelado'` | N0, N3 |
| Bandeja nueva «Facturas fuera de norma» | Lista lo detenido y es donde Administración y Contabilidad autorizan | N2 (y N3 si D-NF3) |

## 5. Items

Orden por dinero × esfuerzo (la regla de Edgar): primero donde sale el dinero.

| Item | Capa | Qué | Hecho cuando |
|---|---|---|---|
| `[PGP.222]` | C0 | Medición y lista de lo que está fuera de norma (este anexo + el reporte) | Cifras de §2 en prod, reporte entregado a Administración y Contabilidad |
| `[PGP.223]` | C1 | `normaFiscalDelCfdi` en `libs/contracts` | Pruebas de cada regla con su negativa: frontera de mes (31-oct pagada 1-nov), zona horaria de México, forma 04/28 sin freno, S01 autorizada y negada, régimen, sin verificar; mutantes en rojo |
| `[PGP.224]` | C0+C1 | Tabla de autorizaciones (migración generada con `nueva-migracion.js`) y su único lector, ya leído por el freno del Calendario | `tenant_id` + audit; probada contra Postgres real — **🧪 2026-11-26**: 13/13, `up()` real dos veces, cada restricción con su negativa |
| `[PGP.225]` | C2 | **Freno en Pagos**: crear, sumar, reprogramar y autorizar (pago y día) consultan la norma en el servidor; marcar pagado no (el dinero ya salió) | Prueba con base real y el payload de la pantalla: una PUE 02/03 de mes anterior da 409; la misma con tarjeta pasa; lo sin ligar se declara |
| `[PGP.226]` | C2 | Freno en Gastos: bandeja del SAT, crear solicitud, X-A-10, caja | Ídem, por cada punto que escribe |
| `[PGP.227]` | C2 | Freno en Compras: los caminos del expediente, materialidad, libro de compras, dictamen ContPAQi | Ídem |
| `[PGP.228]` | C2 | Ventas: emitidas con régimen ≠ 612 fuera de la venta; ajuste de abono (`'Cancelado'`) | Antes/después del número de venta medido (regla 15) |
| `[PGP.229]` | C2+C3 | Bandeja «Facturas fuera de norma» + decidir y revocar (el endpoint que escribe la tabla de `[PGP.224]`) + encender el freno de S01 y régimen sin decisión | Skill `diseno` (§0b), `check:pantalla`, prueba visual 3 perfiles, endpoint probado contra Postgres real con el payload de la pantalla, permiso repartido en prod a los puestos de D-NF2 — **🧪 2026-11-26** (diseño en §8; falta la prueba visual y repartir en prod) |
| `[PGP.230]` | — | El candado tiene prueba negativa | Romper la regla a propósito pone rojo el `check` |

## 6. Decisiones

| | Pregunta | De quién | Recomendación | Decidido |
|---|---|---|---|---|
| **D-NF1** | ⭐ **PUE de mes anterior: ¿aviso o candado?** El 2026-11-19 Edgar decidió **«aviso, no candado»** (`cfdi-factura.contract.ts`, `[PGP.158]`). El pedido de Francisco lo vuelve candado | **Edgar** (cambia su decisión) | Candado en `autorizar` y `ejecutar`, sólo forma 02/03 con CFDI ligado único. Tamaño: 16 abiertas ($411k), 2 pagadas fuera de mes desde el 19-oct | **Candado.** Francisco, 2026-11-26, **ratificado por Edgar** (lo comunicó Francisco: «cada mes se tienen detalles graves con contabilidad generando no deducciones por estas negligencias») |
| **D-NF2** | La autorización de S01: ¿una firma de cada área (Administración **y** Contabilidad) o una sola? ¿Quiénes (puestos)? | Francisco | Una de cada área, en cualquier orden; un «no se paga» de cualquiera la cierra | **Francisco, 2026-11-26: basta una firma** (de Administración o de Contabilidad), y la llave para decidir va a los perfiles **`contabilidad` y `direccion`** (en prod, 5 y 4 usuarios; autorizar el Calendario hoy lo tienen sólo `direccion` y `superadmin`). Se reparte con `[PGP.229]` |
| **D-NF3** | El IMSS (27 facturas, $2.97 M en 2026), CFE, agua y aseguradoras timbran con régimen ≠ 612 y no van a re-timbrar. Con la regla estricta el pago al IMSS quedaría «informativo» | Francisco + Contabilidad | Que N3 en **recibidas** pase por la misma autorización que S01, en vez de ser informativa sin salida | **Francisco, 2026-11-26: el IMSS es excepción por regla.** El resto (33 facturas, $469,835 en 2026: CFE, agua, aseguradoras, gobierno estatal) pasa por la autorización, como se recomendó |
| **D-NF4** | Las 110 S01 de BBVA son comisiones que el banco cobra solo (no se pagan desde el Calendario) | Francisco | Informativas sin autorización: ya las cubre el anexo CR | **Francisco, 2026-11-26: «el banco las cobra solo»** → excepción por regla de N2, como el IMSS en N3. Medido: **BBVA 110 y Banorte 21** (I y E) en 2026; Banorte confirmado por Francisco el mismo día. Un banco nuevo pide autorización hasta agregarse. Quedan **35 S01** que sí piden decisión. Y con la medición: los **116 traslados (tipo T, $0)** llevan S01 por regla del SAT y salen de N2. **Ampliada por Francisco el 2026-11-27** («santander sí y banorte también»): **Santander** (`BSM970519DU8`, 6 S01 de ene–feb 2025, $6,299) entra a la lista, y **la comisión S01 del banco tampoco pide decisión por régimen**. Medido desde 2025: Banorte y Santander timbran esa S01 con receptor **605**, y el 605 **sólo** aparece en esas S01 (sus G03 vienen con 612; BBVA, todo 612). La excepción es de la **comisión**, no del banco: una G03 del banco con otro régimen sigue pidiendo decisión |
| **D-NF5** | Una recibida sin verificar en el SAT: ¿se puede pagar? | Francisco | No hasta que el escáner la verifique (≤ 1 noche); registrar gasto o compra sí, con aviso | **Francisco, 2026-11-26: no se paga hasta que se verifique** |
| **D-NF6** | El 42 % de los renglones pendientes del Calendario no tiene CFDI ligado: ¿pasan con «sin revisar» o se detienen? | Edgar | v1 pasan con «sin revisar» visible; candado cuando la liga pase de 95 % | Abierta |
| **D-NF7** | Las emitidas casi no se verifican en el SAT (3 %). ¿Se extiende el escáner? Cuesta consultas al SAT | Edgar | Sí, sólo tipo I del año en curso | Abierta |
| **D-NF8** | Las 27 facturas de renta (606) emitidas: ¿fuera de la venta? | Francisco | Sí: son ingreso de la persona, no de la distribuidora | **Francisco, 2026-11-26: confirmado** (la regla ya la aplicaba; se cuenta en `[PGP.228]`) |
| **D-NF9** | El mes de la PUE: ¿fecha de emisión o de timbrado? | Francisco | Emisión (`Fecha`), como el aviso de hoy | Abierta; la regla usa la emisión (lo recomendado), como el aviso de hoy |

## 7. Hallazgos de paso (no son de este anexo; se anotan para no perderlos)

- **139 PUE pagadas con tarjeta siguen abiertas en Kepler ($713,984.22):** el pago con tarjeta no se aplicó y esa deuda
  infla lo que se ve por pagar.
- **`ajuste-abono.service.ts:77-88`** compara `estatus_sat <> 'Cancelado'` con mayúscula: el filtro nunca excluye nada.
- **La venta automática** (`commercial-orders.service.ts:2479-2480`) timbra PUE con forma `99` un pedido de contado no
  pagado en efectivo: lo mismo que F5 rechaza en las compras (y lo que el `VERDAD_ABSOLUTA` §41.11 contó en 521 emitidas de
  2026).
- **La comprobación X-A-10** no revisa si el CFDI se canceló después de la solicitud.

## 8. `[PGP.229]` La bandeja «Facturas fuera de norma» — el diseño antes de la plantilla (skill `diseno` §0a)

| # | Paso | Respuesta |
|---|---|---|
| 1 | **Propósito** | Decidir si una factura fuera de norma **se usa o no**. La pregunta, sin «y»: *¿qué facturas esperan mi decisión, empezando por la que sale primero a pago?* |
| 2 | **Quién entra** | Deciden `contabilidad` (5) y `direccion` (4), con `FINANCE_CFDI_NORMA_DECIDIR` (D-NF2). Ven quienes ven el Calendario (`FINANCE_PAYMENTS_VER`): el 409 los manda aquí. Medido en `ui_usage` (30 días): contabilidad y direccion crean, reprograman y autorizan en el Calendario a diario |
| 3 | **El estado real** | 2026: **60 recibidas tipo I** piden decisión (35 S01, el resto régimen); el Calendario tiene **114 pagos pendientes con 259 renglones**. Cuántas de esas 60 están en un pago: **NO MEDIDO** hasta que la bandeja corra en prod (lo dice ella misma, arriba) |
| 4 | **Nivel 0** | Titular: «N esperan decisión · M ya están en un pago · la más próxima sale el X». La lista: primero las que están en un pago (la que sale antes), luego la más nueva. Por fila: emisor (nombre y RFC), folio, fecha, total, **qué pide decisión** en llano, el pago (día y folio). Una acción: **Decidir** |
| 5 | **Qué no ve** | Las decididas (segmento aparte, con su conteo) · lo que la regla exceptúa (IMSS, la comisión que el banco cobra solo, traslados) y las canceladas: no piden nada, no aparecen |
| 6 | **Desglose** | Fila → side-peek: método y forma, uso, régimen; **todos** los motivos de la norma (también lo que no se autoriza, como la PUE de mes anterior); el XML (`app-cfdi-visor`, `/fiscal/cfdi/:uuid/xml`); los pagos que la llevan → el día en el Calendario (`?vista=dia&fecha=`); las decisiones vivas (quién, cuándo, motivo) con **Revocar** |
| 7 | **Accesibilidad** | Buscar por emisor, RFC, folio o UUID (también los 8 caracteres que dice el 409), sin acentos ni orden (`filtrarPorBusqueda`). La fila se abre con Enter. El XML a un clic. ⚠️ `tesoreria` y `finanzas_operativo` no tienen `FISCAL_CFDI_VER`: el visor les dice que no pueden verlo |
| 8 | **Ligas** | Viene del Calendario (el 409 nombra esta pantalla) · va al día del pago en el Calendario. Pendiente con nombre: el atajo «Decidir» en el renglón del Calendario (otra sesión tiene ese archivo abierto; `[PGP.229.2]`) |
| 9 | **¿Le toca?** | Sí, Finanzas › Egresos, junto a Pagos. Gastos y Compras (`[PGP.226]`/`[PGP.227]`) usarán la misma bandeja y la misma decisión |
| 10 | **Maqueta** | ver abajo |
| 11 | **Criterios** | `check:pantalla` sin falla nueva · `app-load-state` (cargando ≠ vacío ≠ error) · `app-freshness-pill` · cifras `tabular-nums` · 44 px al dedo · motivo obligatorio con el botón deshabilitado mientras no alcance 3 letras · el botón se deshabilita en el primer clic · tema oscuro sólo con tokens |
| 12 | **Lo que la pantalla no resuelve** | La factura sin CFDI ligado no aparece (D-NF6: el freno tampoco la detiene) · el XML para quien no tiene `FISCAL_CFDI_VER` · el atajo en el Calendario (paso 8) |

```
Facturas fuera de norma                                              hace 1 min  ↻
12 esperan decisión · 3 ya están en un pago · la más próxima sale el 28-nov
[ Por decidir 12 ] [ Decididas 41 ]                          [ emisor, RFC, folio o UUID ]

Emisor                          Folio     Fecha    Total        Pide decisión                 Pago
CFE SUMINISTRADOR …  CSS160…    A-1234   12-nov   $3,480.00    Régimen 606, no 612           28-nov · 261128-01-03  [Decidir]
GASOLINERA DEL VALLE …  GVZ…    B-55     03-nov   $1,250.00    Uso S01 (sin efectos)         —                      [Decidir]
```
