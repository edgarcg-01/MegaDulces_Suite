# Anexo AV — Del pago al proveedor: el PDF en su renglón, el aviso y el complemento de pago

> Fase **PGP** (Pago a proveedor de punta a punta). Items `[PGP.191]`–`[PGP.196]`. Abierto el 2026-11-21.

## 1. El pedido

Francisco (2026-11-21):

> *«En el calendario de pagos, en los pagos ya pasados, se puede encimar la transferencia sobre el renglón de pago
> para asociar ese PDF al pago; de esa manera Tesorería termina su comprobación subiendo o arrastrando los PDF a la
> orden de pagos del día, y para compartir con el proveedor el desglose de pago, ya sea vía correo o WhatsApp.
> Optimizamos el proceso que teníamos de subir al azar los PDF [en Comprobantes de pago]; ese módulo sólo quedaría
> para consulta. Y en las etapas falta la notificación a proveedor.»*

El caso que lo motivó: para que la cobranza de un proveedor generara su **complemento de pago (REP)**, Francisco
tuvo que armarle a mano un expediente en recortes —la factura, la nota de crédito aplicada y la transferencia— y le
tomó un buen rato.

## 2. Lo medido (prod, sólo lectura, 2026-11-21)

| Qué | Medido |
|---|---|
| Comprobantes de pago subidos | **por lotes**: agosto 1,202 en 3 días · octubre 148 en 3 días · noviembre 18 en 3 días |
| … por el Calendario (`[PGP.130]`, `doc_prefix = CAL`) | **0, nunca** |
| Pagos del Calendario de días pasados (1-oct → ayer) | 207 ejecutados, **0 con su PDF ligado desde el Calendario** · 50 siguen pendientes · 152 cancelados |
| Pagos a proveedor en Kepler desde el 15-oct | 584 transferencias, **107 ligadas a un pago del Calendario (18 %)** |
| Complementos de pago de proveedores | llegan con la descarga del SAT (`fiscal.cfdis` tipo P: 1,650 desde junio) y se ligan a su factura (`fiscal.cfdi_payment_links`) |
| Facturas PPD de proveedores con su REP | junio 92.7 % · julio 89.0 % · agosto 81.0 % · septiembre 61.8 % · octubre 32.4 % |
| Correo o teléfono de cobranza del proveedor | **ninguna columna** en `catalog.suppliers` ni en `finance.supplier_payment_accounts` |
| La factura de cada renglón, con su CFDI | ya viaja en el renglón (`[PGP.108]`: UUID y PUE/PPD; un solo candidato en 67.5 % de los renglones, lo demás se declara) |

Dos lecturas que deciden el plan:

- **La página de Comprobantes no se puede cerrar todavía**: 82 % de las transferencias de Kepler no pasan por el
  Calendario, y sólo ahí se suelta el PDF sobre un renglón.
- **El cuello no es leer el PDF, es dónde se suelta**: la lectura y el casado ya existen (`[PC.3]`, `[PGP.130]`), pero
  el PDF se sube lejos del pago y por lotes.

## 3. Las decisiones (Francisco, 2026-11-21)

Se le presentaron con recomendación; eligió las cuatro recomendadas.

| | Pregunta | Decisión |
|---|---|---|
| **DA1** | Se suelta el PDF sobre un pago de un día pasado que en la Suite sigue **sin pagar** (muchos ni preparados ni autorizados) | **Lo da por pagado y lo marca** «salió sin autorizar en la Suite», para que Dirección lo vea. A Kepler sólo si Kepler aún no lo tiene |
| **DA2** | ¿Qué queda de «Pagos a proveedor — comprobantes»? | **Consulta + «Adjuntar» por renglón sólo para pagos que no pasan por el Calendario.** Se quita la zona de soltar al azar |
| **DA3** | ¿Cómo le llega el desglose al proveedor? | **Una liga al PDF del aviso, por WhatsApp o correo** (como el estado de cuenta de clientes, `[CC.20.2]`): quien tenga la liga ve ese pago |
| **DA4** | ¿Cuándo termina un pago? | **Cuando llega su complemento**: Pagado → Por notificar → Esperando complemento → Cerrado. Una factura PUE no espera complemento |

### ⚠️ DA1 amplía una regla firmada — para Edgar

`[PGP.130]` (D1 de Edgar, 2026-11-17) dice que el comprobante dispara el pago, **pero sólo de un pago autorizado**: un
PDF lo sube una persona, y un pago sin autorizar espera al estado de cuenta (D6 del anexo «Cero captura»). DA1 deja
que el PDF dé por pagado un pago **sin autorizar** cuando una persona lo suelta sobre **su** renglón.

**El resguardo (`[PGP.192]`)**: un pago sin autorizar que pagó un comprobante **no se escribe en Kepler hasta que el
estado de cuenta confirme la salida** (`[PGP.130b]` liga la salida) **o Kepler ya lo tenga capturado** (`[PGP.132]` lo
liga). El PDF solo no basta para escribir en el ERP; sí basta para que el Calendario deje de decir «no se pagó».
«Salió sin autorizar» **se deriva** (pagado y sin autorización del pago ni del día), no se guarda en una columna.

## 4. Los items

| Item | Capa | Qué |
|---|---|---|
| `[PGP.191]` | C2+C3 | **Soltar el PDF sobre el renglón del pago** (cualquier día, también los pasados) |
| `[PGP.192]` | C1 | **Lo que pagó un comprobante sin autorización**: marcado en el renglón y retenido por el escritor de Kepler |
| `[PGP.193]` | C0 | **El contacto de cobranza del proveedor** (correo y WhatsApp): una tabla propia, se captura al avisar y se recuerda |
| `[PGP.194]` | C1+C2+C3 | **El aviso de pago**: el documento, su liga, WhatsApp/correo y quién avisó cuándo |
| `[PGP.195]` | C1+C3 | **Las etapas «Por notificar» y «Esperando complemento»** |
| `[PGP.196]` | C3 | **Comprobantes de pago sin zona de soltar**; «Adjuntar» sólo para pagos fuera del Calendario |

Orden de entrega: `[PGP.191]`+`[PGP.192]` (un PR) → `[PGP.193]`+`[PGP.194]` → `[PGP.195]` → `[PGP.196]`.
`[PGP.196]` va al final a propósito: la zona de soltar no se quita hasta que la de los renglones esté en prod.

## 5. `[PGP.191]` Soltar el PDF sobre el renglón

**Las cinco preguntas** (skill `diseno` §0b):

1. **Qué ve y en qué orden.** El renglón del pago, como hoy. Al arrastrar un PDF sobre él, ese renglón se resalta
   con «Suelta para ligarlo a este pago». Al soltar, el mismo renglón dice «Leyendo el comprobante…» y luego el
   resultado: «Comprobante ligado» o la razón por la que no (con los dos importes si no cuadran).
2. **Qué no ve.** Ninguna bandeja nueva ni confirmación si todo cuadra: la persona ya eligió el pago al soltarlo
   ahí. La bandeja de la barra del día (`[PGP.72]`/`[PGP.130]`) se queda para soltar varios a la vez.
3. **Accesibilidad.** El mismo flujo con teclado: botón «Comprobante» en el desglose del renglón, que abre el
   selector de archivos. El resultado se dice con texto (`role="status"`), no sólo con color.
4. **Ligas.** El comprobante queda en el «PDF» del renglón (`[PGP.96]`) y en Comprobantes de pago, apuntando al
   `X-D-26` cuando exista (`moverComprobanteAKepler`).
5. **¿Le toca a esta pantalla?** Sí: Tesorería ya trabaja el día en el Calendario; es la «orden de pagos del día».

**El servidor** (`POST finance/supplier-payments/calendario/:allocationId`, permiso `FINANCE_PAYMENTS_GESTIONAR`,
el mismo que marcar pagado). Lee el PDF (la lectura es del servidor) y lo compara contra **ese** pago:

| El pago | Qué hace |
|---|---|
| Ya pagado en Kepler (su cierre trae el `X-D-26`) | liga el PDF a **ese documento de Kepler**, con las mismas cuatro coincidencias de `[PC.6]` |
| Pendiente o ejecutado en la Suite, sin documento de Kepler | guarda el comprobante `CAL` del pago; el worker lo da por pagado o sólo lo liga (`[PGP.130]`) |
| Cancelado o rebotado | no: «este pago está cancelado / rebotó» |
| Efectivo o cheque | no: el PDF de transferencia no prueba un pago en efectivo ni un cheque |
| Ya tiene comprobante | no: «este pago ya tiene su comprobante» |

Y en todos los casos que liga:

- **Importe ±$1** contra el pago: si no cuadra no liga, y dice los dos importes.
- **Clave de rastreo** que no esté ya en otro comprobante vivo.
- **Cuenta de origen**: si el pago estaba preparado con otra cuenta, no liga. Si no estaba preparado, la cuenta que
  leyó el PDF queda como su origen, que es la que necesita el `X-D-26`.

⛔ Nada se escribe en Kepler desde aquí: lo hace el escritor de siempre, con su compuerta (`motivosParaNoEscribir`).

## 6. `[PGP.194]` El aviso de pago — lo que lleva

Hablado **en los documentos del proveedor**, no en los de Kepler (su cobranza busca por su folio y su UUID):

- quién paga, a quién, cuándo, cuánto, desde qué banco (últimos 4 dígitos) y la **clave de rastreo**;
- cada factura: folio, **UUID**, total, nota de crédito o descuento aplicado (con su folio), lo pagado y el saldo;
- el PDF de la transferencia, anexo;
- lo que no se pudo ligar (una factura sin CFDI) **se dice**, no se omite.

La liga se arma como la de `[CC.20.2]`: token personal, PDF a un clic, límite de peticiones propio. WhatsApp abre
`wa.me` con el mensaje listo y la liga; el correo abre `mailto:` con asunto y cuerpo. **No se usa el correo del
servidor** (requiere credenciales; DA3).

**Las cinco preguntas del diálogo «Avisar al proveedor»** (skill `diseno` §0b):

1. **Qué ve y en qué orden.** A quién y cuánto (proveedor, fecha, importe, clave de rastreo, cuentas enmascaradas),
   luego las facturas con lo pagado y sus notas, después a quién se le manda —el contacto recordado ya viene escrito—
   con los botones, y al final quién ya avisó y cuándo.
2. **Qué no ve.** Los campos del REP (saldo anterior, insoluto): son del proveedor y de sus reglas fiscales; el aviso da
   los hechos con los que los calcula.
3. **Accesibilidad.** A un clic desde el renglón («Avisar», sólo en pagos pagados, en la celda de acciones que estaba
   vacía); el PDF a un clic; todo con teclado; los errores con texto (`role="alert"`); en táctil, botones de 44 px.
4. **Ligas.** El PDF lleva anexo el comprobante que se soltó en el renglón (`[PGP.191]`); cada aviso queda registrado,
   que es lo que `[PGP.195]` leerá para «Por notificar».
5. **¿Le toca a esta pantalla?** Sí: Tesorería y Finanzas ya trabajan el pago en el Calendario.

**Medido en prod (sólo lectura, 2026-11-22)** con las consultas del aviso, importadas del código:

- El pago del caso del pedido sale como lo armó Francisco a mano: su factura (con la referencia que se capturó en
  Kepler), la nota de crédito que se le aplicó **con la referencia del proveedor** y lo pagado. Le falta el PDF de la
  transferencia: la Suite no lo tiene (eso lo resuelve `[PGP.191]`).
- 5 pagos ejecutados recientes: 350–450 ms por aviso sin el CFDI (la lectura de RFC del acreedor es la más lenta,
  ~150 ms); ninguno trae todavía su comprobante.

## 7. Lo que NO incluye

- Mandar el aviso solo, sin que una persona presione el botón.
- Un WhatsApp de la empresa (el BSP sigue sin decidir, ADR-006).
- Cerrar la página de Comprobantes: queda para consulta y para los pagos fuera del Calendario (DA2).
- Corregir los pagos ya ejecutados sin comprobante: se van ligando conforme Tesorería suelte sus PDF.

## 8. Bitácora

- **2026-11-21** — Pedido, medición y DA1–DA4 de Francisco. Anexo escrito.
- **2026-11-21** — `[PGP.191]` y `[PGP.192]` en código (🧪): contrato 26/26, base real 18/18, 6 mutaciones en rojo,
  escritor 43/43. **Hallazgo al construir `[PGP.192]`:** los 207 pagos ejecutados del Calendario desde octubre salieron
  **todos** sin autorización en la Suite (192 ligados a su `X-D-26`, 15 sin ligar). Por eso «salió sin autorizar» no se
  pinta en todo lo ejecutado —sería ruido— sino sólo donde explica algo: lo pagó su PDF y Kepler espera al banco.
  Que nadie autorice en la Suite es un dato para Edgar, no un defecto de esta pantalla.
- **2026-11-22** — `[PGP.193]` y `[PGP.194]` en código (🧪): migración `20261122001437` (dos tablas con RLS), el aviso
  (contrato, consultas, documento, servicio, dos controladores, diálogo). Base real 16/16, 4 mutaciones rojas, diálogo
  6/6, arranque 5/5. **Corrección de una lectura mía:** al revisar las imágenes del pedido dije que Kepler registraba
  una transferencia distinta a la del banco; eran **dos pagos distintos** (otra factura, otro día). No hay diferencia.
- **2026-11-22** — De paso, en `[PGP.191]`: la pantalla aceptaba PNG/JPG, pero el comprobante sólo se guarda en PDF
  (`putPdf`) y la foto habría fallado al subirse. Ahora se rechaza antes de leerla, en la pantalla y en el servidor.
