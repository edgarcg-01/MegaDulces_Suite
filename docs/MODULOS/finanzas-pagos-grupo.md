# Finanzas › Pagos — qué hace cada una de las cuatro pantallas

> Las cuatro entradas del grupo **PAGOS** del menú lateral: *Pagos a proveedor*, *Pronto pago*,
> *Calendario de pagos* y *Programa de pagos*. Se parecen de nombre y **no hacen lo mismo**: dos
> miran hacia atrás (lo que ya salió del banco), una mira hacia adelante (lo que se va a pagar) y
> una mira el reloj (lo que se puede ganar si se paga antes).
>
> Las cuatro se abren con el mismo permiso de lectura: `FINANCE_PAYMENTS_VER`.
> Las cifras de estado están **medidas contra producción el 2026-10-16**, con la cuenta de sólo
> lectura (`PROD_DB_URL`). Lo que no se midió, se dice.

---

## El ciclo de un pago, y dónde entra cada pantalla

```
     ¿a quién le debemos y cuándo vence?        ¿conviene pagarlo antes?
     Compras › Obligaciones ──────────────┐     PRONTO PAGO
     Presupuestos (capacidad del día)     │     (sólo avisa: no asigna ni paga)
     Compromisos financieros              │
                                          ▼
                              CALENDARIO DE PAGOS   ← lo único que PLANEA
                              (día · orden · método · cuenta origen/destino)
                                          │  Tesorería prepara → Gerencia autoriza
                                          ▼  → Caja General dispersa
                              ═══ el dinero sale del banco ═══
                                          │
                   ┌──────────────────────┴──────────────────────┐
                   ▼                                             ▼
         PAGOS A PROVEEDOR                              PROGRAMA DE PAGOS
         (el pago en Kepler + su                        (el Excel de Tesorería:
          comprobante escaneado)                         qué se pagó, de qué banco,
                                                         y si ya está en Kepler)
```

Dicho en una línea cada una:

| Pantalla | La pregunta que contesta | Mira |
|---|---|---|
| **Pagos a proveedor** | ¿Dónde está el comprobante de este pago, y cuadra con Kepler? | atrás |
| **Pronto pago** | ¿Qué factura pendiente todavía me da descuento, y hasta qué día? | adelante |
| **Calendario de pagos** | ¿Qué se paga el martes, con qué dinero, y quién lo autorizó? | adelante |
| **Programa de pagos** | ¿Qué pagó Tesorería este mes y qué todavía no está asentado en Kepler? | atrás |

---

## 1. Pagos a proveedor

**Ruta:** `/finanzas/pagos-comprobantes` · **Permiso:** `FINANCE_PAYMENTS_VER` para ver y adjuntar;
`FINANCE_PAYMENTS_GESTIONAR` para validar o rechazar · **Fase:** CC (extensión) + PC + AT.1

### Qué hace

Es el **expediente de evidencia** de los pagos que ya salieron. Lista cada pago a proveedor que
existe en Kepler y le cuelga su comprobante (PDF o foto del banco):

- **El listado** son los pagos de Kepler: transferencia (`XD2601`), cheque (`XD2501`) y anticipo
  (`XD6001`), filtrados a proveedor de compra. Se filtra por estado del comprobante, año, mes,
  **origen** del dinero (caja o banco), **método** (el documento de Kepler) y búsqueda libre.
  Los dos filtros existen por separado a propósito: «Transferencia» sobre un pago hecho en
  efectivo fue la mentira más cara que tuvo esta pantalla.
- **Dos formas de cargar el comprobante.** Soltando varios PDF a la vez en la zona de carga —el
  OCR lee el documento, el sistema propone a qué pago corresponde y la persona confirma— o desde
  el renglón del pago, con las fotos del gasto adjuntas.
- **El cuadre lo calcula el sistema**: compara el monto leído por OCR contra el monto del pago en
  Kepler y marca si coincide. El estado va de `recibido` → `validado` / `rechazado`.
- **Se valida solo cuando no hay duda.** Un carril automático (`[AT.1]`, cada 20 minutos) relee los
  comprobantes guardados y valida los que coinciden en **banco, fecha, monto y proveedor**; el
  botón «Ponerse al día» sólo adelanta esa pasada. Lo que no cuadra exactamente queda para que una
  persona decida. El carril **no rechaza nada** ni toca lo que alguien ya decidió.
- **Alertas de control**: marca los pagos cuya cuenta de origen es **ajena** a la empresa o cuya
  clave de rastreo está **repetida**. El botón «Solo alertas» deja únicamente esos.
- **Conciliación con el banco**: se puede confirmar que un cargo del estado de cuenta corresponde
  al pago (se guarda en `bank_recon_matches`).

### Lo que NO hace

⛔ **No escribe en Kepler.** No crea, no modifica ni cancela un pago: el ERP sigue siendo el dueño
del movimiento. Esta pantalla sólo le agrega evidencia y un veredicto encima.

### Estado real hoy (2026-10-16)

| | |
|---|---:|
| Comprobantes validados | 678 |
| Esperando revisión (`recibido`) | 671 |
| Rechazados | 1 |
| Comprobantes cargados en octubre | 148 |

Cobertura por mes de pago (pagos de Kepler con comprobante adjunto):

| Mes del pago | Pagos | Con comprobante |
|---|---:|---:|
| 2026-06 | 534 | 156 |
| 2026-07 | 583 | 177 |
| 2026-08 | 533 | 38 |
| 2026-09 | 342 | 121 |
| 2026-10 | 110 | 0 |

⚠️ El módulo **está vivo** (148 comprobantes cargados este mes), pero la evidencia entra con
semanas de retraso respecto del pago: los 110 pagos de octubre todavía no tienen ninguno. Eso es
cómo funciona hoy el proceso —primero se paga, después se archiva—, no una falla de la pantalla.

---

## 2. Pronto pago

**Ruta:** `/finanzas/pronto-pago` · **Permiso:** `FINANCE_PAYMENTS_VER` · **Sólo lectura** ·
**Fase:** PP.1 / PP.2 (pedido de Edgar, 2026-10-10)

### Qué hace

Contesta una sola pregunta: **de lo que debemos hoy, ¿qué todavía nos da descuento si lo pagamos
pronto, y hasta cuándo?** El privilegio del pronto pago se pierde por fecha y en silencio: nadie
emite un aviso, la factura se paga igual, más cara.

- Arriba va la frase que decide el día («hoy hay $X que todavía se pueden ganar; de eso, $Y vence
  en 5 días o menos»), no la tabla.
- La lista sale ordenada **por urgencia y después por dinero** — ordenarla por importe escondería
  los $200 que vencen mañana debajo de los $2 M que vencen en tres semanas.
- Cada factura cae en uno de cuatro estados: **capturable**, **por vencer** (≤ 5 días),
  **fuera de ventana** y **sin medir**.
- Aparte, muestra lo ya perdido: los hallazgos de **descuento no capturado** que detectó Finanzas.

### Las dos advertencias que la pantalla dice en voz alta

⛔ **La fecha límite es ESTIMADA, no pactada.** El acuerdo con el proveedor no existe como dato en
ninguna parte: las 147 políticas de descuento registradas son **todas observadas** y ninguna tiene
plazo declarado. Lo que se publica es la **ventana observada** — «cuando le pagamos a este
proveedor y nos dieron descuento, fue a los N días», con un mínimo de 3 casos—. Es una guía
defendible, no una promesa del proveedor.

⛔ **«Fuera de ventana» no quiere decir «perdido».** Quiere decir que se pasó la mediana de lo que
históricamente funcionó; todavía se puede intentar cobrar. Llamarlo perdido haría que Tesorería
dejara de intentarlo, que es el daño opuesto al que la pantalla viene a evitar.

⛔ **«Sin medir» no es «no da descuento».** Son proveedores sin observaciones suficientes: no
sabemos. La pantalla además separa el motivo (nunca dio · lo dio una o dos veces · el plazo no
explica el descuento · la factura no trae fecha).

### Estado real hoy (2026-10-16)

| | |
|---|---:|
| Políticas de descuento registradas | 147 (100 % observadas) |
| Hallazgos de descuento no capturado | 98, por $5,363,294 |
| De esos, revisados por alguien | **0** (todos en `nuevo`) |
| Último hallazgo producido | 2026-08-29 |

⚠️ El detector de descuento no capturado **dejó de producir el 29-ago**: no tiene latido, así que
su silencio es invisible. Los $5.36 M de hallazgos son reales y **nadie ha triado uno solo**.

*(Las cifras de oportunidad vigente —$93.4 M pendientes, $2.33 M capturables, $370 k por vencer—
son las que se midieron al diseñar la fase el 2026-10-10 y están documentadas en el código; no se
volvieron a medir para este documento.)*

---

## 3. Calendario de pagos

**Ruta:** `/finanzas/calendario-pagos` · **Permisos:** `FINANCE_PAYMENTS_VER` ver ·
`FINANCE_PAYMENTS_GESTIONAR` armar y preparar · **`FINANCE_PAYMENT_CALENDAR_AUTORIZAR`
liberar el día** · **Fase:** TP (ADR-064 / ADR-065)

### Qué hace

Es la **única pantalla del grupo que planea**. Se ve la semana completa (lunes a domingo) con el
presupuesto, lo comprometido y lo disponible de cada día; se elige un día, se le agregan
obligaciones desde la izquierda y se ordena y prepara a la derecha.

**La tesis del módulo: el calendario es un consumidor, no un originador.** No autoriza gasto nuevo.
Cada obligación nace ya autorizada en su módulo de origen y aquí sólo se le asigna una fecha,
dentro de la capacidad que Presupuestos fija para ese día. Los tres orígenes:

| Origen | Módulo | Qué aporta |
|---|---|---|
| `supplier_payable` | Compras › Obligaciones | facturas de mercancía recibidas |
| `budget_expense` | Presupuestos | gastos autorizados |
| `financial_commitment` | Finanzas | factoraje, intereses, amortizaciones |

**Lo que se puede hacer con un pago del día:**

- **Agrupar y parcializar**: un pago puede cubrir varias facturas, y una factura puede partirse en
  varias fechas. El mismo saldo **nunca se reserva dos veces** (disponible = original − reservado −
  pagado, sumado sobre todas las fechas).
- **Un pago no mezcla clasificaciones** (proveedor / gasto / compromiso), ni beneficiarios, ni
  sucursales: un pago es una transferencia a una cuenta, y entra al centro de costo de su almacén.
- **Ordenar**: el sistema propone el orden (compromisos financieros → críticos → resto) y Tesorería
  lo ajusta. El orden es dónde «cortar» si falta dinero. Proveedor crítico es una **marca manual
  con motivo**, nunca inferida del importe.
- **Preparar**: método, cuenta de **origen** y cuenta de **destino** — exactamente lo que pide el
  layout del banco. Valida el dígito de control de la CLABE.
- **Reprogramar** a otro día, **con motivo obligatorio** de una lista cerrada (cuenta errónea ·
  falla del banco · pago devuelto · presupuesto recortado · otro).
- **Ejecutar / marcar fallo**: un pago fallido **no liquida** la obligación, su saldo vuelve a
  quedar disponible.

**Las dos firmas (control interno, TP.6):** Tesorería **prepara**, Gerencia o Dirección
**autoriza** y libera el lote del día, Caja General **dispersa**. Son permisos distintos a
propósito: `FINANCE_PAYMENT_CALENDAR_AUTORIZAR` está fuera de todo paquete de permisos y sólo lo
tienen Gerencia de Finanzas, Dirección y superadmin. Liberar el día exige capacidad definida,
consumo ≤ autorizado y orden de pago completo. El **folio se genera sólo al autorizar**
(`YYMMDD-01` el lote, `-NN` cada pago), y recién ahí se puede imprimir la instrucción para Caja
General. Antes de autorizar sólo existe el documento **preliminar**.

### Estado real hoy (2026-10-16)

| | |
|---|---:|
| Pagos en el calendario | 8 pendientes ($1,576,022) + 2 cancelados |
| Lotes (días) | 5, **todos en `draft`** |
| Días autorizados alguna vez | **0** |
| Obligaciones de proveedor esperando fecha | 26 pendientes + 11 parciales |

⚠️ **El módulo está en uso pero nadie ha cerrado el ciclo todavía**: hay pagos armados y ningún día
autorizado, así que ningún folio se ha generado y ninguna instrucción de ejecución se ha emitido.
Mientras no se libere un día, el calendario es una lista de intención, no una orden de pago.

---

## 4. Programa de pagos

**Ruta:** `/finanzas/programa-pagos` · **Permiso:** `FINANCE_PAYMENTS_VER` · **Sólo lectura** ·
**Fase:** PP.2 / PP.3

### Qué hace

Es el **espejo del Excel de Tesorería** («PROGRAMA PAGOS 2026»): el libro donde Tesorería anota
cada pago que ejecuta. Una fila por pago, con fecha, sucursal, tipo, proveedor, folios de factura
cubiertos, banco, método, monto y la columna **KEPLER**.

Su valor está en esa última columna: **qué ya se pagó pero todavía no está asentado en el ERP**.
Para eso es útil sobre todo el **mes en curso**; lo ya posteado se ve mejor en *Pagos a proveedor*.

Además trae:

- Filtros por mes, banco, método, tipo y búsqueda; desglose por banco y por método.
- Una vista de **conciliación por mes** a tres vías: programa vs. Kepler (cuenta 201) vs. bancos
  (conciliación bancaria). Son **universos distintos**, así que es informativo: la señal confiable
  es el flag KEPLER que pone Tesorería.
- Una **píldora de frescura** que dice de cuándo son los datos, y un aviso que **enumera los meses
  que faltan** en el libro. Un mes ausente y un mes sin pagos llegan los dos como cero: por eso se
  nombran.

### El problema estructural de esta pantalla

⛔ **El libro se carga a mano y hoy está congelado.** `import-payment-program.js` lee un `.xlsx`
desde una carpeta local, corriendo a mano, **sin agenda y sin latido**. Su estado normal es
«viejo», y por eso la pantalla aprendió a declararlo.

Medido hoy:

| | |
|---|---:|
| Pagos cargados | 2,716 ($375,117,550) |
| Meses cubiertos | 2026-01 … **2026-08** |
| Última escritura del importer | **2026-08-08** |
| Meses faltantes | septiembre y octubre |

O sea: **el libro lleva más de dos meses sin actualizarse**. La pantalla lo dice en pantalla (no
dibuja verde sobre un hueco), pero el dato no está. Cerrar esto es el sprint **PP.8**, hoy abierto
y marcado ruta crítica — el libro es **el único lugar de la plataforma** donde existen la forma de
pago real y los folios de factura que cubre cada pago.

### Dos confusiones caras que hay que evitar

⛔ **`finance.payment_program` NO incluye la nómina.** Hereda el filtro de pago a proveedor de
compra; la nómina va por otro camino en Kepler. Medido (ene–jul 2026): 85.70 % es compra de
mercancía, 7.33 % financiamiento, 6.59 % gasto.

⛔ **Su `tipo='gasto'` no sirve como gasto operativo.** Cruzarlo contra el presupuesto de OPEX
reporta una sobre-presupuestación que no existe (la prueba que lo cierra: sueldos solos son
~$3.46 M/mes y *todo* el bucket `gasto` del programa son $3.34 M/mes — la nómina no cabe adentro).
El denominador correcto del gasto operativo es `analytics.expense_entries`, nunca este libro.

⛔ **`kepler_flag` viene NULL en el 84.18 %** de las filas: no sirve para medir cobertura de
captura, sólo para leer las que sí están marcadas.

---

## Referencia técnica

| Pantalla | Ruta front | API | Tabla principal | Escribe |
|---|---|---|---|---|
| Pagos a proveedor | `/finanzas/pagos-comprobantes` | `/finance/supplier-payments` | `analytics.erp_supplier_payments` ⋈ `finance.supplier_payment_proofs` | sí (evidencia, nunca Kepler) |
| Pronto pago | `/finanzas/pronto-pago` | `/finance/pronto-pago` | `analytics.v_supplier_payables` + `commercial.supplier_discount_policy` + `finance.findings` | no |
| Calendario de pagos | `/finanzas/calendario-pagos` | `/finance/payment-calendar` | `finance.payment_calendar_lots` · `payment_allocations` · `payment_allocation_items` | sí |
| Programa de pagos | `/finanzas/programa-pagos` | `/finance/payment-program` | `finance.payment_program` | no (importer manual) |

**Código:** los cuatro componentes en `apps/view/src/app/modules/finanzas/pages/`; el backend en
`libs/finance/src/lib/` (`supplier-payment-proofs` · `pronto-pago` · `payment-calendar` ·
`payment-program`).

**Planes de fase:** [`FASE_TP_CALENDARIO_PAGOS.md`](../IMPLEMENTACION/FASES/FASE_TP_CALENDARIO_PAGOS.md) ·
[`FASE_PP_PROGRAMA_PAGOS.md`](../IMPLEMENTACION/FASES/FASE_PP_PROGRAMA_PAGOS.md) ·
[`FASE_CC_COMPROBANTES_COBRANZA.md`](../IMPLEMENTACION/FASES/FASE_CC_COMPROBANTES_COBRANZA.md)
(la extensión de pagos a proveedor nació ahí).

**ADRs:** ADR-064 (el calendario es consumidor, no originador) · ADR-065 (control interno: preparar
≠ autorizar) · ADR-056 (lo que no se midió se declara, nunca se dibuja en cero).
