# Fase GP — Anexo EA: autorizar los pedidos de telemarketing en la Suite

> Anexo de [`FASE_GP_PLAN_IMPLEMENTACION.md`](FASE_GP_PLAN_IMPLEMENTACION.md).
>
> **El pedido, literal.** Edgar, 2026-11-19: *«a este plan le agreguemos el apartado de autorizar pedidos
> de tlmk, audítalo a profundidad»*, con una captura de Kepler › Finanzas › Crédito y cobranza › Operación
> CFDI › **Autorización de Pedidos**. Después, el mismo día: *«que si está dentro de su límite se autorice
> automáticamente (siempre avisando a Crédito y cobranza); darle valor de información a Crédito y cobranza
> en base a un análisis de pagos, históricos y todo valor que podamos obtener, para darle información a
> Crédito y cobranza de si subir el crédito y autorizar esa compra»*.
>
> **Cómo cambió.** El primer pedido era mover la autorización de Kepler a la Suite. El segundo la vuelve
> **automática dentro del límite** (D-A3, decidida por Edgar) y agrega una **ficha de crédito** para que
> Crédito y cobranza decida lo que la regla no puede: autorizar excedidos y subir límites.
>
> **Todas las cifras se midieron el 2026-11-19** en `pg-prod` (sid `7688376744939610156`, rol `edgar`,
> `transaction_read_only = on`), sobre `kepler_ods` y la cartera de la Fase CXC
> (`analytics.customer_receivables_current`), salvo que se diga otra cosa. Los pedidos cancelados
> (`c43 = 'C'`) quedan fuera. Lo que no se pudo medir dice **NO MEDIDO**.

---

## 0. En una pantalla

- **Qué es autorizar.** Es el paso `CREADO → AUTORIZADO` del pedido `U-D-40` (`kdm1.c11`). Los pedidos de
  telemarketing (`c27 = 'TELEMARK'`) nacen `CREADO`; los de sucursal nacen ya `AUTORIZADO`. Mientras un
  pedido no se autoriza, **GP no lo surte**: el pool de surtido (GP.2) lee sólo `AUTORIZADO`.
- **En Kepler, autorizar sólo escribe `kdm1.c11`** (ADR-117). Es la escritura más chica de la cadena.
- **Kepler no guarda quién autorizó ni a qué hora.**
- **Hoy casi todo se autoriza por encima del límite.** De los pedidos TELEMARK de 60 días (Padre
  Hidalgo, Canindo y Morelia Abastos), **70 % del importe ($24.7 M de $35.5 M)** salió con el saldo del
  cliente más el pedido arriba de su límite de Kepler. Con los límites de hoy, la regla automática
  autorizaría sola **1 de cada 5 pedidos**.
- **Por eso el valor está en la ficha de crédito**, no sólo en el automático: **37 clientes que pagan
  bien** concentran 374 de los pedidos excedidos ($5.66 M). Si Crédito y cobranza les ajusta el límite,
  el automático sube de 20 % a cerca de 33 % de los pedidos.
- **La captura de Kepler era Zamora Centro, no telemarketing:** 782 pedidos de la ruta vecinal que
  nunca se autorizaron (§2.2).

| | HOY (2026-11-19) | META propuesta |
|---|---|---|
| Pedidos TELEMARK que se autorizarían solos con los límites de hoy | **19.8 %** (545 de 2,746 en 60 días, simulado) | **≥ 33 %** después de que Crédito y cobranza revise los límites de los 37 buenos pagadores |
| Autorizaciones con quién, cuándo y con qué saldo | **0 %**: Kepler no lo guarda | **100 %**, automáticas y manuales |
| Tiempo de `CREADO` a `AUTORIZADO` | **NO MEDIDO**: Kepler no guarda la hora | automáticas en segundos; manuales con mediana bajo 30 min en horario hábil |
| Pedidos TELEMARK `CREADO` de más de 7 días (sin Zamora Centro) | 17 | 0 de más de 1 día hábil |
| Pedidos muertos de Zamora Centro en la lista | 782 ($1.37 M) | 0 (D-A4, lo hace una persona en Kepler) |

**Esfuerzo: L** (era M; el automático y la ficha lo suben). **Dinero en juego: $3.1 M de cartera
vencida a más de 45 días** en las tres sucursales de telemarketing (§4).

---

## 1. La pantalla de Kepler, columna por columna

Anclado a la captura de Edgar (Zamora Centro, `05`) contra el ODS:

| En la pantalla | De dónde sale | Verificado |
|---|---|---|
| Pedido | `kdm1.c6` del `U-D-40` con `c11 = 'CREADO'` | ✅ los folios `0000047`, `0000066`, `0000086` y `0000173` de la 05 son `TELEMARK` `CREADO`, mismos clientes e importes |
| Cliente · Nombre | `kdm1.c10` · `kdm1.c32` | ✅ `00031` JORGE RODRIGUEZ RAMOS |
| Monto Pedido | `kdm1.c16` | ✅ 6,563.14 · 5,507.43 · 4,381.30 |
| Monto Crédito | **`kdud.c15`** (límite del cliente en esa sucursal); el plazo es `kdud.c16`. Ya lo expone `analytics.v_cliente_credito` | ✅ 10,000.00 para el `00031` |
| Monto por Cobrar | **Σ cargos del cliente en `kdue` SIN los tickets de contado (tipo 10) − Σ todos sus abonos**, crudo (GP.A.0b, 2026-11-20) | ✅ **9 de 9 al centavo**, incluido el `00007` en −7,610.28 |
| Crédito Disponible | Monto Crédito − Monto por Cobrar | ✅ |

**Decodificado el 2026-11-20 (GP.A.0b).** Por tipo de cargo, el `00031` es `56,133.70` (tipo 5) + `1,189.74`
(tipo 8) − `621.17` de abonos = `56,702.27`, lo que dice la pantalla; los otros 8 cuadran igual. Lo que lo
aleja de lo que el cliente debe son las **facturas de ticket** (`U-D-5` «Fac», serie `UD0501`): cada una apunta
a su ticket `U-D-10` por `c37/c38/c39`, con el mismo importe, y el ticket ya está cerrado (`c43 = 'F'`). Kepler
deja fuera el ticket y cuenta la factura, y como a la factura nadie le aplicó el abono, la sigue contando por
cobrar. La cartera de la Suite no cuenta el tipo 5, por eso da `568.57`. En la red hay facturas de ticket sin
abono en 4 sucursales (La Piedad Abastos, 8 Esquinas, Yurécuaro y Zamora Centro), unos $2.2 M.

**En telemarketing la diferencia casi no pesa:** en 60 días (2,975 pedidos TELEMARK, 445 clientes) sólo 22
clientes tienen los dos números distintos (18 por facturas de ticket), y la condición del límite da **el mismo
veredicto en los 2,975** con la fórmula de Kepler que con el saldo de la Suite. La diferencia grande es de la ruta
vecinal de Zamora Centro.

**Por eso la regla usa la fórmula de Kepler** (misma fórmula, mismos resultados): Crédito y cobranza ve en la
Suite el mismo número que ve en Kepler, y la ficha le explica qué parte son facturas de ticket sin abono. Lo
único que la Suite agrega encima son los otros pedidos abiertos del cliente, rotulado como suyo.

Lo que se creía antes del decode (se conserva como historia): para los 9 clientes de la captura,

| Cliente | Kepler dice | Saldo real (cartera CXC) | Σ`kdue` sin aplicar FIFO | Pedidos `CREADO` del cliente |
|---|---:|---:|---:|---:|
| `00031` | 56,702.27 | 568.57 | 111,626.73 | 59,922.47 |
| `00029` | 39,366.89 | 909.01 | 79,075.52 | 41,182.67 |
| `00032` | 39,038.47 | 3,560.27 | 74,516.65 | 45,652.34 |
| `00038` | 32,581.41 | −2,801.52 | 64,841.58 | 35,182.18 |

~~Lo que Kepler muestra queda cerca de la suma de los pedidos sin autorizar; hipótesis: Kepler cuenta los
pedidos abiertos como «por cobrar».~~ **Refutada por el decode:** Kepler no suma pedidos; la cercanía era
casualidad de que esos clientes tienen tantas facturas de ticket como pedidos muertos.

Lo que la lista de Kepler **no** muestra: lo vencido, la antigüedad del pedido, quién lo capturó, cómo
paga el cliente, ni si está bloqueado. El bloqueo vive en el **nombre** («NO TOCAR …» en `kdud.c3`):
15 de los 125 clientes de la lista de la 05.

---

## 2. Lo medido

### 2.1 Telemarketing, 60 días (20-sep a 19-nov)

| Sucursal | Pedidos | Importe | Embarcados | `CREADO` hoy | `CREADO` de más de 7 días |
|---|---:|---:|---:|---:|---:|
| Padre Hidalgo (`01`) | 1,082 | $12.08 M | 1,066 | 8 | 4 |
| Canindo (`06`) | 905 | $10.58 M | 847 | 9 | 6 |
| Morelia Abastos (`08`) | 755 | $12.77 M | 707 | 7 | 4 |
| La Piedad Abastos (`02`) · 8 Esquinas (`03`) | — | — | — | 3 (de abril y junio) | 3 |

- Unos **46 pedidos por día calendario** pasan por la autorización.
- **Pedidos que manda la Suite** (COT.7), 30 días: 20; 11 autorizados y 9 esperando.

### 2.2 Zamora Centro (`05`): la lista de la captura

- **782 pedidos `CREADO`, $1,370,979**, del 25-mar al 30-oct, todos de más de 7 días. **603** los capturó
  la **Ruta Vecinal Zamora Centro** (vendedor `3V001`). 125 clientes.
- **Ninguno se facturó** por el camino de telemarketing: 0 de 782 tienen factura `U-D-8` al mismo cliente
  en ±3 días con el mismo importe (control con importe desplazado: también 0).
- Los clientes cambiaron de clave el 22-may (`00007` «NO TOCAR ANTONIO VILLA», límite 10,000 → `30007`
  «ANTONIO VILLA», límite 0). Desde el 1-oct la venta de la 05 se registra como `U-A-5` (277 documentos,
  $2.02 M) y el último pedido `CREADO` es del 30-oct.
- **NO MEDIDO** si la mercancía salió con esos pedidos (68 embarques `U-D-41` en el periodo, $353 mil) ni
  cómo se cobró. Es una pregunta para Finanzas, no una conclusión.

### 2.3 La regla automática, simulada sobre los 2,746 pedidos TELEMARK de 60 días

Regla: el cliente tiene límite, y **su saldo al día anterior al pedido + el pedido** no pasa el límite.
El saldo «al día anterior» se calculó con la cartera CXC (Σ de cargos y abonos con fecha anterior al
pedido), no con el saldo de hoy.

| Sucursal | Pedidos | Sin límite en Kepler | Dentro | Excedido | % dentro | Importe dentro |
|---|---:|---:|---:|---:|---:|---:|
| Padre Hidalgo | 1,085 | 342 | 341 | 402 | 31.4 % | $3.95 M |
| Canindo | 906 | 112 | 121 | 673 | 13.4 % | $0.95 M |
| Morelia Abastos | 755 | 270 | 83 | 402 | 11.0 % | $0.71 M |
| **Total** | **2,746** | **724** | **545** | **1,477** | **19.8 %** | **$5.61 M de $35.51 M** |

**Control:** con el límite a la mitad, «dentro» baja de 545 a 185. La regla responde al límite.

⚠️ La simulación **no** suma los otros pedidos abiertos del cliente (la regla real sí, GP.A.1), así que
el 19.8 % es un **techo**. Tampoco revisa lo vencido a la fecha del pedido: eso sólo se puede ver con la
cartera de hoy.

**Los 1,477 excedidos, por qué:**

| Grupo | Pedidos | Importe | Qué significa |
|---|---:|---:|---|
| Clientes con algo vencido de más de 45 días (hoy) | 721 | $10.91 M | Riesgo: se les sigue vendiendo con deuda vieja |
| **Buenos pagadores**: 5 o más facturas pagadas, mediana de pago hasta el plazo + 10 días, nada vencido de más de 45 días | **374** (37 clientes) | **$5.66 M** | Candidatos a subir el límite |
| Sin historial suficiente (menos de 5 facturas pagadas) | 306 | NO MEDIDO | La ficha lo dice; decide Crédito y cobranza |
| Resto | 76 | — | — |

Además, **218 pedidos** son de clientes **sin límite** en Kepler que pagan en 25 días o menos: son
candidatos a que se les **asigne** un límite.

⚠️ «Vencido» depende del plazo de Kepler (`kdud.c16`), y **71 clientes con pedido tienen plazo 0** (31 en Padre Hidalgo, 16 en Canindo, 24 en Morelia Abastos): con
plazo 0, una factura vence el día que se emite. Por eso «vencido» se mide con **gracia** (§3.1), no al día.

### 2.4 Cómo pagan los clientes de telemarketing (cartera CXC)

| Sucursal | Clientes con pedido | Con historial de pago | Facturas pagadas por cliente (mediana) | Días que tardan en pagar (mediana) | Pagan a tiempo en 9 de cada 10 facturas |
|---|---:|---:|---:|---:|---:|
| Padre Hidalgo | 136 | 117 | 7 | 19 | 15 |
| Canindo | 102 | 95 | 6 | 23 | 9 |
| Morelia Abastos | 134 | 101 | 3 | 20 | 17 |

- El plazo pactado más común es **15 días**; la gente paga en **19 a 23**. «A tiempo» = hasta el plazo + 3.
- ⚠️ **El historial es corto**: la cartera de Kepler empieza cuando cada sucursal pasó a Kepler propio
  (Padre Hidalgo 27-jun, Canindo 15-ago, Morelia Abastos 14-sep). Lo anterior vive en Wincaja con otras
  claves de cliente y **no se liga hoy** (NO MEDIDO).

### 2.5 Lo que la Suite ya tiene (no se reinventa, ADR-056)

| Pieza | Dónde | Sirve para |
|---|---|---|
| El pedido TELEMARK escrito en Kepler en `CREADO` | `kepler-pedido-tlmk-sink.adapter.ts` (COT.7, ADR-092) | El origen |
| Tope diario del carril | `kepler_push_switch.tope_dia` | El freno del automático |
| Límite y plazo | `analytics.v_cliente_credito` (`kdud.c15`/`c16`) | La regla |
| Saldo, vencido, días de pago por factura | `analytics.customer_receivables_current` (`saldo_ajustado`, `dias_pago`, `vencimiento`) + cartera por evento (CXC.45, en prod desde el 18-nov) | La regla y la ficha |
| Fotos diarias de la cartera | `analytics.customer_receivable_snapshots` | La tendencia en la ficha |
| Depósitos y comprobantes del cliente | Fase CC y depósitos del cliente (en prod desde el 18-nov) | La ficha: «último pago, cuándo y cuánto» |
| El seguimiento de la cotización | `quote-tracking` (GP.9.1, GP.10.1b) | Avisar al telemarketer |
| La consola maestra | E1 (el Tablero) | La bandeja «Por autorizar» como vista, no otra pantalla |
| El crédito firmado en el alta | Fase ALC (rol `credito_cobranza`; la Suite **no escribe** `kdud`, D1-b) | Quién decide el crédito; el límite se cambia en Kepler |
| La campana de avisos | `notifications-bell` | El aviso a Crédito y cobranza |
| La escritura en sitio de un `U-D-40` | ADR-117 + PQ.110 (`kepler-oc-cancelacion.ts`) | El patrón de escritura |

⛔ **COT.7 decidió lo contrario** ([`FASE_COT7`](FASE_COT7_PEDIDO_TLMK_A_KEPLER.md), D1): *«la autorización
(crédito) sigue siendo de Kepler»*. Este anexo la revierte (D-A1).

---

## 3. Diseño

### 3.1 La regla automática (D-A3, decidida por Edgar el 2026-11-19)

Un pedido TELEMARK se autoriza **solo** si se cumplen **todas**:

1. El cliente **tiene límite** (`kdud.c15 > 0`). Sin límite no hay automático: va a la bandeja.
2. **Monto por Cobrar con la fórmula de Kepler** (GP.A.0b; negativo cuenta a favor, como en Kepler) **+ otros
   pedidos abiertos** del cliente sin facturar (agregado de la Suite) **+ este pedido ≤ límite**.
3. **Nada vencido** de más de **plazo + gracia** días. La gracia es un parámetro que fija Crédito y cobranza
   (propuesta: 15 días; ver D-A6). **Los restos de centavos no cuentan**: una factura que ya tuvo cobro y
   debe hasta $1 cuenta como pagada (`esRestoDeFactura` de `libs/contracts`, ya hecha y probada en
   `[GP.R.1]`; [anexo RC](FASE_GP_ANEXO_RESTOS_DE_COBRO.md)). Medido el 2026-11-20: **17 clientes tienen vencido
   SÓLO por centavos**; sin esta excepción, la regla los mandaría a la bandeja sin deber nada.
4. El cliente **no está bloqueado**: su nombre en el `kdud` **de la sucursal del pedido** no empieza con
   «NO TOCAR» (GP.A.0c, medido: Kepler no tiene campo de bloqueo; 145 de los 235 marcados conservan límite).
5. **Los datos están frescos**: la cartera y el pedido se leyeron hace menos de N minutos. Si la lectura
   está atrasada **no se autoriza solo**: va a la bandeja con «no pude verificar el saldo» (ADR-056: lo
   que no se pudo medir no se da por bueno).
6. El **interruptor de la sucursal** está prendido y no se pasó el **tope del día** (`kepler_push_switch`).
7. **El pedido no es viejo.** Edgar, 2026-11-19: *«evitarlos si ya tienen mucho tiempo»*. Un pedido con
   más de N días sin movimiento (parámetro; propuesta 30) **no se autoriza ni solo ni en la bandeja del
   día**: se lista aparte, con su cifra, para que alguien decida si sigue vivo. Así quedan fuera los 782 de
   Zamora Centro sin que la Suite cancele nada.

8. **No es de la ruta vecinal** (D-A13, Edgar, 2026-11-20): un pedido capturado por un vendedor `3V…` (`kdm1.c12`) va
   aparte aunque diga TELEMARK.

**CONTADO** (D-A12, Edgar, 2026-11-20): a la cuenta de venta de contado no le aplican las condiciones de crédito (1, 2 y
3); las demás sí. No pasa por Crédito y cobranza.

Medido el 2026-11-20 con las dos decisiones: **la bandeja baja de 64 pedidos a 8**; aparte, 789 (605 de la ruta
vecinal); de contado, 6.

**Quién decide lo que no pasa la regla** (D-A2, Edgar, 2026-11-19): **Crédito y cobranza** (rol
`credito_cobranza`). Lo que Crédito y cobranza **no autoriza sube a Dirección General** (rol `direccion`),
con el motivo de Crédito y cobranza y la misma ficha. Crédito y cobranza **puede regresar un pedido
autorizado solo** mientras siga `AUTORIZADO` (D-A7).

**Siempre se avisa a Crédito y cobranza** (pedido de Edgar): cada autorización automática aparece en su
bandeja como «autorizado solo», con los números que vio la regla. **Edgar, 2026-11-20: una notificación por
cada pedido autorizado solo** (no agrupada, como proponía este anexo): cliente, importe, sucursal y la liga al
pedido, para que Crédito y cobranza lo pueda regresar mientras no se surta (D-A7). Con los límites de hoy son
unos 9 al día (simulado sobre 60 días).

**Qué pasaría solo hoy** (simulación del 2026-11-20 con la regla real, el interruptor encendido en todas las
sucursales y datos frescos): **6 pedidos, los 6 de CONTADO**; ningún cliente con crédito. Los 9 que esperan son de
clientes sin límite o pasados del límite con vencido viejo: lo que sigue en CREADO es lo que nadie autorizó, el
residuo difícil. **Al soltar lo construido no se autoriza nada**: falta GP.A.2 (escribir), GP.A.3 (el disparo), el
permiso en Kepler y encender el interruptor.

Lo que **no** cumple la regla va a la bandeja, con la condición que falló dicha en una frase: «excede
$4,200 su límite», «tiene $12,300 vencidos desde hace 62 días», «sin límite en Kepler».

### 3.2 La ficha de crédito (el valor para Crédito y cobranza)

Se abre desde cada pedido de la bandeja. Contesta dos preguntas: **¿autorizo esta compra?** y **¿le subo el
crédito?** Cada cifra lleva su fuente y su fecha; lo que no existe se dice.

| Bloque | Qué muestra | Fuente | Disponible hoy |
|---|---|---|---|
| **Este pedido** | importe, cuánto excede, quién lo capturó, desde cuándo espera | `kdm1` | ✅ |
| **Límite y plazo** | límite, plazo, desde cuándo (si ALC lo registró) | `v_cliente_credito`, ALC | ✅ (la fecha del límite sólo para altas de ALC) |
| **Lo que debe** | saldo vivo, vencido por antigüedad (al día, 1–30, 31–60, 61–90, más de 90), factura más vieja | cartera CXC | ✅ |
| **Pedidos abiertos** | pedidos sin facturar y su importe; los de más de 30 días sin movimiento, aparte | `kdm1` | ✅ |
| **Cómo paga** | facturas pagadas, mediana de días de pago contra su plazo, peor atraso, cuántas pagó a tiempo, último pago (fecha y monto) | cartera CXC (`dias_pago`), depósitos del cliente | ✅ desde el cambio de cada sucursal a Kepler (§2.4) |
| **Cómo compra** | compra por mes (6 meses), ticket promedio, frecuencia, tendencia | facturas `U-D-8` y pedidos | ✅ |
| **Devoluciones y notas de crédito** | % de lo facturado que regresó | cartera CXC (`Nota Créd/Dev`) | ✅ por medir su cobertura (GP.A.6) |
| **Cuántas veces excedió** | pedidos que pasaron el límite en 90 días y cómo terminaron (pagados o no) | `kdm1` + cartera | ✅ |
| **Antes de Kepler** | historia en Wincaja | `wincaja.*` | ❌ **NO MEDIDO**: las claves no ligan |
| **Sugerencia de límite** | ver §3.3 | — | ✅ cálculo nuevo, propuesta |

### 3.3 La sugerencia de límite

La Suite **sugiere**; Crédito y cobranza **decide**, y el cambio **se hace en Kepler** (la Suite no escribe
`kdud`, Fase ALC D1-b). Se registra si se aceptó, para medir después si la sugerencia sirve.

**Candidato a subir** (propuesta para validar con Crédito y cobranza, no una fórmula impuesta):
- 5 o más facturas pagadas;
- mediana de pago hasta el plazo + 10 días;
- nada vencido de más de 45 días;
- excedió su límite 3 o más veces en 90 días.

**Límite sugerido:** el saldo más alto que tuvo el cliente en 90 días (saldo + pedido), redondeado hacia
arriba a miles. Se muestra junto con lo que pasó en esos 90 días, para que se vea de dónde salió.

**Hoy cumplen la condición 37 clientes** (374 pedidos excedidos, $5.66 M). Los 218 pedidos de clientes sin
límite que pagan en 25 días o menos son candidatos a que se les **asigne** límite.

⚠️ **El reverso también va:** un cliente con algo vencido de más de 45 días y que sigue comprando (721
pedidos, $10.91 M en 60 días) aparece como **«revisar»**, aunque no pida aumento.

### 3.4 El aviso para renovar o subir el crédito

Edgar, 2026-11-19: *«se avisa a Crédito y cobranza para renovar su crédito o sugerir un aumento en base a
nuestro análisis»*.

- **Cuándo se avisa: por evento, no por calendario** (sin cron): cuando entra un pedido del cliente y se
  cumple una de estas:
  - **Candidato a subir** (§3.3): «Le sugerimos subir el límite de $10,000 a $18,000» con los números que lo
    justifican.
  - **Crédito por renovar**: su última revisión tiene más de M meses (parámetro; propuesta 12) **o nunca se
    revisó en la Suite**. ⚠️ Kepler no guarda desde cuándo tiene el cliente su límite; la fecha sólo existe
    para las altas de ALC. Para los demás, la primera revisión en la Suite es la que empieza a contar.
  - **Revisar a la baja**: vencido de más de 45 días y sigue comprando.
- **Un aviso por cliente** hasta que Crédito y cobranza lo atiende (aceptar, descartar con motivo o
  posponer), no uno por pedido.
- Atenderlo **queda registrado como la revisión del crédito** (quién, cuándo, qué decidió y con qué
  números). Si se acepta un cambio, la Suite recuerda hacerlo en Kepler y, al leer el `kdud.c15` nuevo,
  lo marca como aplicado.

### 3.5 El análisis externo («si es posible un análisis foráneo»)

Medido el 2026-11-19 sobre los **366 clientes** con pedido TELEMARK en 60 días:

| Fuente externa | Qué daría | Medido | Veredicto |
|---|---|---|---|
| **Listas del SAT** (EFOS 69-B y artículo 69), **ya en la Suite** en `fiscal.sat_list_rfcs` (al día: 19-nov), hoy sólo se cruzan contra proveedores | Si el cliente es una empresa fantasma o tiene créditos fiscales firmes o no localizado | **Sólo 73 de 366 clientes (20 %) tienen RFC propio**; 287 tienen el genérico `XAXX010101000`. **0 de los 73 aparecen en las listas** | ✅ **Se hace** (gratis, ya existe). ⚠️ Excluir el RFC genérico: el SAT lo publica en la lista 69 como «FIRMES», y un cruce sin excluirlo marca a los 287 |
| **Constancia de situación fiscal** | RFC, régimen y domicilio fiscal verificados | La captura ya existe para altas nuevas (Fase ALC) | ✅ Para clientes nuevos; para los viejos sólo si se pide la constancia al renovar |
| **Buró de Crédito / Círculo de Crédito** | Historial de pago con otros proveedores y bancos, score | **NO MEDIDO**: necesita contrato con el proveedor, costo por consulta y **autorización firmada del cliente** (la ley la exige). Para personas físicas sin RFC se consulta con nombre, domicilio y CURP | ⬜ **Decisión de Edgar (D-A8)**: es dinero y un contrato. Si sí, la firma de autorización se pide en el alta (ALC) y en la renovación |

⭐ **Lo que más ayudaría es lo de casa:** el 78 % de los clientes no tiene RFC propio, así que ninguna
fuente externa por RFC los ve. Pedir RFC y constancia al renovar el crédito (§3.4) mejora a la vez el
análisis externo, la facturación y el alta en ALC.

#### ¿Ya tenemos los RFC? (Edgar, 2026-11-19: *«ya tenemos los RFC, sólo es asignarlos; ya tenemos las pólizas de ContPAQi»*)

Medido sobre los 287 clientes de telemarketing con RFC genérico o vacío en Kepler:

| Fuente | Qué se encontró | Cuántos de los 287 |
|---|---|---:|
| **CFDI emitidos** (`analytics.v_cfdi_emitido_match`, que liga cada CFDI a su documento y cliente de Kepler) | 282 sí tienen facturas timbradas, **pero a `XAXX010101000` (público en general)**: el CFDI no trae su RFC | **2** con RFC propio |
| **Pólizas de ContPAQi** (impuestos por póliza) | Llevan el RFC del CFDI, así que repiten lo mismo | 0 nuevos |
| **Catálogo de personas de ContPAQi** (`contpaqi_ods.ct_personas`, 5,774 con RFC) por nombre exacto | Mismo nombre y un solo RFC; las iniciales del RFC coinciden con los apellidos y el nombre en la muestra (p. ej. «BLANCA ANDREA CAMPOS RAMIREZ» → `CARB…`) | **30** candidatos |
| Sin RFC en ninguna fuente | — | **~255** |

**Control:** los 73 clientes que ya tienen RFC propio en Kepler coinciden con el de sus CFDI en **71 de 71**
cruzables, así que la liga CFDI ↔ cliente es buena; lo que falta es el dato.

**Conclusión:** con lo que ya tenemos se llega de 73 a **unos 105 de 366 clientes (29 %)**. Los demás
compran como «público en general» y su RFC **no existe en ningún sistema nuestro**: hay que pedirlo.

⚠️ **Asignar un RFC no es sólo llenar un campo:**
- Los 30 de ContPAQi son **candidatos por nombre**: puede ser un homónimo. Se confirman con el cliente
  (constancia de situación fiscal) antes de usarlos.
- **La Suite no escribe en el catálogo de clientes de Kepler** (Fase ALC, D1-b). El RFC lo captura una
  persona en Kepler, o Edgar decide abrir esa escritura (D-A11).
- **Cambia la facturación:** con RFC en Kepler, la siguiente factura se timbra a su nombre y CFDI 4.0 exige
  además régimen fiscal y código postal que coincidan con los del SAT; si no coinciden, el timbrado falla.
  Por eso va con la constancia, no sólo con el RFC.

### 3.6 La pantalla — aprobada por Edgar el 2026-11-20

Edgar: *«muéstrame cómo quedaría la interfaz»* → *«lo más sencilla posible, sólo información de valor, sin
saturar»* → *«listo, podemos empezar a trabajar mediante eso»*. Maqueta (privada, en claude.ai):
`https://claude.ai/artifact/4AGFP93K29dqDe3mwkPZUF`, artboards 1–3 (la 3 es la vista de PC a 1440 × 900).

**Dónde vive: en Cartera (`/finanzas/cartera`), como segundo segmento «Por autorizar», no en el Tablero de
almacén.** Medido en `analytics.ui_usage` (30 días): el rol `credito_cobranza` abre la cartera en 24 de 30 días
y el detalle del cliente cientos de veces; el Tablero, **nunca**. La pantalla va donde se toma la decisión.
Esto corrige lo que decía GP.A.4.

**Las cinco preguntas** (`diseno` §0b):
1. **Qué ve y en qué orden:** «N pedidos esperan tu decisión»; debajo, como enlaces, «X se autorizaron solos
   hoy» y «Y viejos van aparte». La lista: cliente y sucursal · por qué no pasó solo (etiqueta + una frase; una
   segunda línea **sólo** si hay un dato que cambia la decisión) · importe · espera. La más vieja primero. Toda
   la fila abre el panel. Primario: el conteo; secundario: el motivo de cada fila; terciario: importe y espera.
2. **Qué no ve:** pestañas para los autorizados solos o los viejos (son otra pregunta: enlaces); conteos por
   motivo arriba (repetían las etiquetas); folio, clave y límite en la fila (el folio va al panel y el límite ya
   está en la frase); botones por fila.
3. **Accesibilidad:** una fila = un objetivo, operable con teclado; la etiqueta lleva palabra, no sólo color;
   contraste calculado: todo texto ≥ 5.00:1.
4. **Ligas:** viene del pedido TELEMARK de Kepler (`U-D-40`), va a Surtido (E1/E3); el folio está en el panel.
5. **¿Le toca a esta pantalla?** Sí: es el trabajo diario de Crédito y cobranza. Lo autorizado solo se ve
   aquí y también en el seguimiento de la cotización (GP.A.7).

**El panel del pedido** (a la derecha de la lista, sin salir de ella; en código, `app-side-peek`):
- arriba, el **veredicto** en una línea («Excede su límite por $6,181.40») y **3 números con la fórmula de
  Kepler**: límite · por cobrar en Kepler · este pedido;
- **«lo que Kepler no dice»**, sólo cuando aplica: las facturas de ticket sin abono (GP.A.0b);
- **«Para decidir»**: los 2 o 3 hechos que pesan en ESE caso (ver abajo); las 7 condiciones, plegadas;
- la decisión: **motivo obligatorio** (queda registrado), Autorizar, Rechazar, «Pasar a Dirección General»;
  a un cliente NO TOCAR no se le puede autorizar;
- la sugerencia de límite en **una línea**, sólo si aplica;
- plegado, «Más del cliente» (lo que debe por antigüedad, cómo compra, última decisión, listas del SAT);
- «Siguiente pedido», para no volver a la lista.

Carga medida en la maqueta (nivel C, sin validación visual): la bandeja pasó de ~22 controles y ~68 cifras a
~12 y ~28; el panel, de ~70 cifras visibles a ~14.

**Qué revisa Crédito y cobranza al autorizar a mano** (lo que el panel pone en «Para decidir», según el caso):

| Siempre | Excede | Sin límite | Vencido | NO TOCAR | Viejo (aparte) |
|---|---|---|---|---|---|
| cuánto se pasa y en proporción a su límite · cómo paga (días contra su plazo, a tiempo, peor atraso) · si tiene vencido y su último pago o promesa · qué pasó las veces que se pasó · si el pedido es normal para él · sus otros pedidos sin facturar · si el «por cobrar» de Kepler está inflado por facturas de ticket | si se pasa seguido y paga, **subirle el límite en Kepler** en vez de autorizar a mano cada vez | facturas pagadas y a cuántos días · lo más que ha debido · RFC y listas del SAT; si paga bien, **capturarle límite en Kepler**; sin historial: contado o límite chico | cuánto, desde cuándo, último pago, promesa registrada; autorizar con vencido viejo es prestar sobre lo que ya debe | no se autoriza; si la marca ya no aplica, se quita en Kepler | confirmar con telemarketing que sigue vivo |

---

## 4. Dinero en juego

- **Cartera vencida a más de 45 días** en Padre Hidalgo, Canindo y Morelia Abastos: **$3.1 M hoy**. Es lo
  que una autorización con información protege. Universo: cartera CXC de esas tres sucursales; el plazo
  de Kepler con 0 días lo infla (§2.3).
- **Se autorizó por encima del límite** el 70 % del importe de telemarketing en 60 días ($24.7 M), y **$10.9 M
  a clientes que hoy tienen algo vencido de más de 45 días**. ⚠️ Lo vencido se mide **hoy**, no a la fecha
  de cada pedido: es un límite superior.
- **Zamora Centro: $1.37 M** en pedidos que nunca se cerraron. No es pérdida mientras no se demuestre que la
  mercancía salió sin cobrarse.

Con la regla del PM, **alto dinero × esfuerzo L = prioridad 2**. EA sube por encima de E2 (sin métrica) y
de E4.

---

## 5. Los bloques

| # | Resultado | Capa | Depende | ¿Escribe? |
|---|---|---|---|---|
| **GP.A.0a** 🧪 | Se confirma con **3 pedidos reales** que Autorizar en Kepler sólo cambia `kdm1.c11`, y que no toca `kdm2`, `kdue` ni existencias. Foto antes/después en la réplica (protocolo de GP.12.0a), nunca una prueba en el Kepler vivo. **Medido (2026-11-19/20):** · la foto del 19-nov juntó **8** pedidos CREADO→AUTORIZADO: cabecera, **sólo `c11`**; renglones, **nada** (plan §2.2) · **no aparta existencia**: ninguna columna numérica de `kdik` iguala lo pedido en AUTORIZADO por producto (Morelia Abastos, 291 productos: la mejor coincide en 4, el mismo ruido que lo sólo CREADO, 5 de 96), ni en unidad base ni de venta, ni sumando todos los estatus abiertos; `kdil` igual. **Control positivo:** el mismo instrumento sí encuentra la existencia (`kdik.c60` = `kdil c4+c8−c9` en 2,977 de 3,378) · **no crea cartera**: `kdue` no tiene cargos de tipo 40; sus 7 renglones tipo 40 son abonos (`c29 = 'A'`, el Anticipo `U-A-40`). **NO MEDIDO:** otras tablas fuera de `kdm1`/`kdm2`/`kdik`/`kdil`/`kdue` | C0 | — | no |
| **GP.A.0b** 🧪 | Se decodifica el «Monto por Cobrar» de Kepler. **Hecho el 2026-11-20 (§1):** Σ cargos de `kdue` sin el tipo 10 − Σ abonos, **9 de 9 al centavo** contra la captura. La hipótesis de los pedidos abiertos quedó refutada. La diferencia con la cartera de la Suite son las facturas de ticket (`U-D-5`) sin abono. En telemarketing (60 días) la condición del límite da el mismo veredicto con las dos fórmulas en 2,975 de 2,975 pedidos, así que **la regla adopta la de Kepler** (`POR_COBRAR_KEPLER_SQL`). **NO MEDIDO:** si esas facturas de ticket sin abono se cobraron (lo que haría falso el número de Kepler), y la paridad en otras sucursales (la captura es de una sola) | C0 | — | no |
| **GP.A.0c** 🧪 | Fuente del bloqueo del cliente: se busca un campo en `kdud`; si no existe, la regla se declara (hoy «NO TOCAR» en el nombre). **Medido (2026-11-20, 23,406 filas cliente × sucursal):** **no hay campo de bloqueo**: ninguna de las columnas de pocos valores (`c14`, `c17`, `c18`, `c26`, `c28`, `c29`) separa a los marcados del resto. **La marca es el nombre que EMPIEZA con «NO TOCAR»** (235 filas, 158 claves, siempre al inicio). Las otras palabras buscadas (bloqueado, suspendido, no vender, no surtir, jurídico, cancelado, moroso, demanda) dan **0**; «BAJA» da 10 y **todas son falso positivo** («trabajadores»), por eso la regla es `^NO TOCAR`, no «contiene». **Es por sucursal:** 101 clientes la tienen en todas sus sucursales y 57 sólo en algunas, así que se lee la fila de `kdud` de la sucursal del pedido. **145 de las 235 filas siguen con límite** (`c15 > 0`): sin esta condición, la regla 1 las dejaría pasar. Pedidos TELEMARK de 60 días a clientes marcados: **0** | C0 | — | no |
| **GP.A.0d** | Permiso `UPDATE (c11)` en `md.kdm1` para `kepler_push`, en el mismo archivo que GP.12.0e (lo corre el PM) | C0 | GP.12.0e | sí (permiso) |
| **GP.A.1** 🧪 | **Hecha el 2026-11-20:** `decidirAutorizacion` en `libs/commercial/src/lib/commercial-quotes/autorizacion-pedido.reglas.ts` — evalúa las 7 condiciones (todas, no se corta en la primera) y devuelve `autorizar` / `bandeja` / `aparte`, cada motivo en una frase («excede $500.00 su límite», «tiene $12,300.00 vencidos desde hace 62 días») y los números que vio. Lo desconocido (saldo, cartera, nombre, frescura, tope) va a la bandeja con «no pude verificar…», nunca se autoriza. Los centavos con `esRestoDeFactura`; el bloqueo con `^NO TOCAR`. Los parámetros se reciben (`PARAMETROS_PROPUESTOS` es la propuesta sin firmar de D-A6/D-A10). 18 pruebas; 3 mutantes rojos (sin la excepción de centavos, «NO TOCAR» en cualquier lado, saldo desconocido como cero). Definición: **Regla de autorización** en `libs/commercial` (función pura, con pruebas y su prueba negativa): las 6 condiciones de §3.1, cada una con el número que la decide. Sin límite = `sin límite`, nunca `0` (ADR-056). La gracia y N minutos son **parámetros** (los fija Crédito y cobranza, no el código) | C1 | GP.A.0c | — |
| **GP.A.2** 🔨 | **Hecho el 2026-11-20:** la regla y la sentencia (`autorizacion-kepler.ts`: sólo `c11`, con el estatus leído en el `WHERE`, idempotente), el adaptador `KeplerAutorizacionPedidoAdapter` (apagado de inicio, `FOR UPDATE`, 1 fila o ROLLBACK, nunca lanza; 13 pruebas, 2 mutantes rojos) y el ensayo con ROLLBACK (`ops/prod/ensayo-autorizacion-kepler`). **Y la decisión (2026-11-20):** migración `20261120145451` (bitácora `finance.order_authorizations` con RLS, una escritura en curso por pedido, motivo obligatorio; tipo `autorizacion` apagado y sin tope, D-A14; llave `FINANCE_PEDIDOS_AUTORIZAR` a `credito_cobranza`), `AutorizacionDecisionService` + `POST /api/finance/autorizacion-pedidos/:sucursal/:serie/:folio` ({ accion, motivo }: autorizar, regresar, rechazar, escalar), 21 pruebas (2 mutantes rojos), la prueba contra Postgres real (19 de 19) y la **simulación contra prod con ROLLBACK** (`ops/prod/simulacion-bitacora-autorizacion`: 19 de 19, prod igual). **Falta:** aplicar la migración (después de empujar), el permiso GP.A.0d (PM), correr el ensayo y encender los botones del panel (GP.A.4). Definición: | **Escribir la autorización**: `c11 = 'AUTORIZADO'` con `WHERE c11 = 'CREADO'`, desde `md`, interruptor por sucursal apagado al nacer, tope diario, idempotente. Guarda en una tabla propia (con `tenant_id` y auditoría) **quién o qué la autorizó**, cuándo, la regla y los números que vio, y el motivo si se autorizó excedida. Rechazar **no cancela en Kepler**: deja el pedido `CREADO` con el motivo en la Suite | C2 | GP.A.1 · GP.A.0d | ⛔ sí: prueba contra un Kepler de pruebas y contra base real con el payload de la pantalla |
| **GP.A.3** | **Automático**, por evento y sin cron, con **dos disparos**: (1) al ver un pedido TELEMARK `CREADO` nuevo y (2) **cuando cambia la cartera del cliente** (un cobro, una nota, un ajuste: el evento de la cartera por evento, `receivables_dirty_accounts`), que re-evalúa sus pedidos que esperan. Sin el segundo, un pedido detenido por deuda no pasaría nunca aunque el cliente pague (Edgar, 2026-11-20: «cuando se deposite… el pedido pasará a automático»). Corre la regla y, si pasa, autoriza con GP.A.2. **Una notificación a Crédito y cobranza por cada pedido autorizado solo** (Edgar, 2026-11-20), con la liga para regresarlo. **Antes de cada empuje que toque la autorización**, la lista de los que pasarían solos se le manda a Crédito y cobranza: `ops/prod/reporte-autorizacion-automatica` (mismas consultas y misma regla que la bandeja, sólo lectura) | C2 | GP.A.2 | ⛔ sí |
| **GP.A.4** 🔨 | **Servidor hecho el 2026-11-20** (`GET /api/finance/receivables/autorizacion-pedidos`, sólo lectura, ~200 ms medidos en prod: la consulta principal tardaba 245 s hasta materializar el «por cobrar» y dejar fuera CONTADO). **Pantalla hecha el 2026-11-20, sólo lectura** (`/finanzas/cartera/por-autorizar`, tercer segmento de Cartera; Autorizar y Rechazar apagados y dicen dónde se hace hoy; sin validación visual). **Bandeja «Por autorizar» en Cartera** (`/finanzas/cartera`, segundo segmento), **no en el Tablero** (§3.6, aprobada por Edgar el 2026-11-20): «N pedidos esperan tu decisión», enlaces a los autorizados solos y a los viejos; por fila, cliente y sucursal · por qué no pasó solo (etiqueta + frase; segunda línea sólo si cambia la decisión) · importe · espera; la fila abre el panel. Los bloqueados no se autorizan. Pide la llave nueva de `credito_cobranza`, repartida en la misma migración (regla 20) | C3 | GP.A.2 | — |
| **GP.A.5** | **Panel del pedido** (`app-side-peek`, §3.6): veredicto en una línea, los 3 números con la fórmula de Kepler, «lo que Kepler no dice» si aplica, «Para decidir» con los 2–3 hechos del caso, motivo obligatorio y la decisión, la sugerencia en una línea, el resto plegado. Lee del ODS y de la cartera, cada cifra con su fecha; no copia tablas | C2/C3 | GP.A.4 | — |
| **GP.A.6** | **Sugerencia de límite** (§3.3) y lista «revisar» (clientes con vencido viejo que siguen comprando). Crédito y cobranza la acepta o la descarta; aceptarla le recuerda cambiarla en Kepler y queda registrado. Se mide la cobertura de notas de crédito por cliente antes de mostrarlas | C1/C3 | GP.A.5 | sí (aceptar/descartar) |
| **GP.A.6b** | **Escalamiento a Dirección General**: lo que Crédito y cobranza no autoriza sube a la bandeja de `direccion` con su motivo y la ficha; Dirección General autoriza o rechaza. **Regresar** un autorizado solo (D-A7): `c11 = 'CREADO'` con `WHERE c11 = 'AUTORIZADO'`, sólo `credito_cobranza`. Llaves nuevas repartidas en la misma migración (regla 20) | C2/C3 | GP.A.4 | ⛔ sí |
| **GP.A.6c** | **Aviso de renovar o subir** (§3.4), por evento al entrar un pedido; un aviso por cliente; atenderlo registra la revisión del crédito; la Suite detecta en `kdud.c15` cuándo se aplicó en Kepler | C1/C2/C3 | GP.A.6 | sí (registro de la revisión) |
| **GP.A.6d** | **Listas del SAT en la ficha** (§3.5): reusar `fiscal.sat_list_rfcs` con el RFC de `kdud.c10`, **excluyendo los RFC genéricos** (prueba negativa: un cliente con `XAXX010101000` no debe salir «en lista»). Sin RFC propio, la ficha dice «sin RFC: no se puede revisar», no «limpio» | C1/C3 | GP.A.5 | — |
| **GP.A.7** | El seguimiento de la cotización dice «Autorizado solo», «Esperando a Crédito y cobranza desde las 12:31» o «Rechazado: motivo» | C3 | GP.A.2 | — |
| **GP.A.8** | Dos semanas de piloto: % automático, motivos de los excedidos, sugerencias aceptadas, y cuántos autorizados solos terminaron con vencido de más de 45 días (control de la regla) | C0 | GP.A.3 en prod | no |

**Fuera de este anexo:** cancelar pedidos en Kepler desde la Suite, escribir el límite en Kepler (ALC D1-b),
y limpiar la 05 (D-A4).

**Restos de centavos:** la condición de vencido de GP.A.1 usa la regla del resto tolerado, y cerrar esos
restos en Kepler (Ajuste Abono `U-A-30`) vive en el [anexo RC](FASE_GP_ANEXO_RESTOS_DE_COBRO.md): 17 clientes
se ven morosos sólo por centavos.

---

## 6. Por qué va antes de E3

1. **Es el primer uso del carril de escritura de E3, con lo mínimo:** una columna, sin cantidades, sin
   borrar renglones, sin recálculo. Si el permiso, el interruptor o la idempotencia fallan, se ve aquí.
2. **Comparte sólo un bloqueo con E3 (GP.12.0e).** No necesita al dueño de piso ni las carretas.
3. **Destraba lo que E3 surte:** sin autorizar no hay surtido.
4. **Tiene dinero medido** ($3.1 M vencido a más de 45 días); E2 no tiene métrica.

⛔ **Cupo:** hay **8 fases 🔨 contra un tope de 4**. EA es una etapa de GP, no una fase nueva, pero
construirla pasa GP a 🔨. Si se abre, **reemplaza a E2 como siguiente etapa**.

---

## 7. Decisiones

| | Pregunta | Recomendación | Estado |
|---|---|---|---|
| **D-A1** | ¿La autorización pasa de Kepler a la Suite? (revierte COT.7 D1; amplía ADR-117 a `AUTORIZADO`) | Sí | ✅ **Firmada por Edgar el 2026-11-20** como enmienda de ADR-117 (`02_DECISIONES_ARQUITECTURA.md`): la Suite escribe CREADO→AUTORIZADO y Crédito y cobranza puede regresarlo (AUTORIZADO→CREADO). Falta el permiso GP.A.0d, que corre el PM |
| **D-A2** | ¿Quién autoriza lo que no pasa la regla? | Crédito y cobranza, por sucursal | ✅ **Edgar, 2026-11-19:** Crédito y cobranza; **si no, Dirección General** (rol `direccion`) |
| **D-A3** | ¿Lo que está dentro del límite se autoriza solo? | — | ✅ **Edgar, 2026-11-19:** sí, siempre avisando a Crédito y cobranza |
| **D-A4** | ¿Qué pasa con los pedidos viejos (los 782 de la 05)? | — | ✅ **Edgar, 2026-11-19:** *«evitarlos si ya tienen mucho tiempo»*: no se autorizan ni entran a la bandeja del día; se listan aparte (§3.1, condición 7). Sigue abierta para Finanzas la pregunta de si esa mercancía salió (§2.2) |
| **D-A5** | Los clientes sin límite (724 pedidos): ¿contado o límite sin capturar? | Pregunta para Crédito y cobranza; mientras tanto, sin límite = bandeja | ⬜ Crédito y cobranza |
| **D-A6** | Los parámetros de la regla: la gracia sobre el plazo (propuesta 15 días), el umbral de «vencido viejo» (propuesta 45 días) y la condición de candidato a subir | Que los fije Crédito y cobranza como parámetros configurables en la Suite, no en el código | ⬜ Crédito y cobranza |
| **D-A7** | ¿Crédito y cobranza puede regresar un pedido autorizado solo, mientras siga `AUTORIZADO` (antes de surtirse)? | Sí, con motivo | ✅ **Edgar, 2026-11-19:** sí, Crédito y cobranza tiene esa autoridad |
| **D-A8** | ¿Se contrata Buró de Crédito o Círculo de Crédito? | Primero lo gratis y de casa (listas del SAT y pedir RFC al renovar); el buró sólo si después de 2 semanas de piloto Crédito y cobranza dice que le falta información para los excedidos sin historial (306 pedidos en 60 días) | ⬜ Edgar (costo y contrato) |
| **D-A9** | «Si no, Dirección General»: ¿sube sólo lo que Crédito y cobranza **rechaza**, o también lo que **no atiende** en cierto tiempo? | Las dos: lo rechazado sube de inmediato, y lo que lleve más de un día hábil sin atender también, para que el pedido no se quede detenido | ⬜ Edgar |
| **D-A11** | ¿Cómo se asignan los RFC que ya tenemos (2 de CFDI + 30 candidatos de ContPAQi)? | La ficha los muestra como «RFC probable (ContPAQi)»; Crédito y cobranza los confirma con la constancia al renovar el crédito y los captura en Kepler. Que la Suite escriba `kdud` sería abrir lo que ALC D1-b cerró | ⬜ Edgar |
| **D-A12** | Los pedidos TELEMARK a **CONTADO** (la cuenta de venta de contado; 20 en CREADO, 4 de ellos de este mes fuera de Zamora Centro): ¿necesitan autorización de crédito? | No: un pedido de contado no usa crédito. Que se autoricen solos o no pasen por esta bandeja | ✅ **Edgar, 2026-11-20** («apliquémoslos»): a CONTADO no le aplican las condiciones 1–3; sale de la bandeja a su propia lista. Hoy: 6 |
| **D-A13** | Los pedidos de la **ruta vecinal** (vendedor `3V…`) capturados como TELEMARK: hoy son **49 de los 64** que vería la bandeja, todos de Zamora Centro y nunca facturados | Mandarlos a «aparte» con la etiqueta «ruta vecinal», no a la bandeja del día | ✅ **Edgar, 2026-11-20** («apliquémoslos»): condición 8 de la regla; ni automático ni bandeja. Hoy: 605 de los 789 de aparte |
| **D-A14** | ¿Un interruptor para autorizar a mano y otro para el automático, o el mismo? | El mismo renglón `autorizacion` de `kepler_push_switch` por sucursal: **encendido = la Suite puede autorizar a mano**; el automático necesita además un **tope del día** (sin tope, la regla no deja pasar nada solo, condición 6). Nace apagado y sin tope: el piloto a mano no enciende el automático por accidente. No es tope 0: prod exige vacío o mayor que 0 (`kepler_push_switch_tope_ck`) | ✅ Claude, 2026-11-20 (decisión de diseño; la simulación contra prod la corrigió de 0 a vacío) |
| **D-A10** | Parámetros nuevos: «pedido viejo» y «crédito por renovar» (propuesta 12 meses sin revisión) | «Pedido viejo» = **más de 2 días en CREADO** (antes 30, sin medir). Medido el 2026-11-20 en prod: de los TELEMARK capturados hace 0–1 días quedan en CREADO 0 de 115; desde el 2º día, un 1 % que ya no baja (2 de 121 a los 2–3 días; 18 de 1,387 a los 31–60): todo lo que se autoriza se autoriza el mismo día o al siguiente. La ventana de «otros pedidos abiertos» que cuentan contra el crédito se separa (`abiertosHorizonteDias`, 30): un AUTORIZADO sin surtir de una semana sí compromete crédito. ⚠️ Un pedido del viernes que nadie vea hasta el lunes llega con 3 días: si Crédito y cobranza no trabaja sábado, que lo suba a 3 | 🟡 **Crédito y cobranza, 2026-11-20** (vía Edgar): los 6 de contado del reporte «eran viejos y no debían pasar» → 2 días medido; falta que lo fijen como parámetro suyo (junto con D-A6). Crédito por renovar: ⬜ |

---

## 8. Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
| 2026-11-19 | Nace el anexo. Auditoría en prod (sólo lectura): qué es autorizar, la pantalla de Kepler columna por columna, telemarketing de 60 días, los 782 pedidos de Zamora Centro, lo que la Suite ya tiene | Claude, a pedido de Edgar |
| 2026-11-19 | Edgar decide D-A3 (automático dentro del límite, siempre avisando) y pide la ficha de crédito. Medido: el «Monto por Cobrar» de Kepler sigue a los pedidos abiertos, no al saldo; la regla simulada autoriza 19.8 % (control: 185 con el límite a la mitad); 70 % del importe se autorizó excedido; 37 buenos pagadores concentran $5.66 M de excedidos; $3.1 M vencido a más de 45 días. Nuevos GP.A.3 a GP.A.8 y D-A6, D-A7 | Claude |
| 2026-11-19 | Edgar decide D-A2 (Crédito y cobranza; si no, Dirección General), D-A4 (evitar los pedidos viejos) y D-A7 (Crédito y cobranza puede regresar un autorizado solo), y pide el aviso de renovar o subir el crédito y un análisis externo. Medido: 73 de 366 clientes con RFC propio, 0 en listas del SAT; el RFC genérico aparece en la lista 69 (falso positivo controlado). Nuevos §3.4, §3.5, GP.A.6b a GP.A.6d y D-A8 a D-A10 | Claude |
| 2026-11-20 | **Crédito y cobranza: los 6 de contado del reporte «eran viejos y no debían pasar».** Tenían razón: el umbral de 30 días era una propuesta sin medir. Medido: un pedido TELEMARK se autoriza el mismo día o al siguiente; lo que sigue en CREADO después es un 1 % fijo, muerto. «Pedido viejo» pasa a 2 días (D-A10) y la ventana de pedidos abiertos que cuentan contra el crédito queda en 30, aparte. Reporte antes → después: al encender pasaban 6 → 0; a Crédito y cobranza 9 → 1; aparte 789 → 801 (corridas de las 14:17 y 16:02) | Claude |
| 2026-11-20 | **GP.A.2: la decisión, de punta a punta en el servidor.** Bitácora, interruptor y llave (migración `20261120145451`), servicio y endpoint. Edgar: «apliquemos una simulación con la BD de producción» → la migración real y las verificaciones corren en una transacción de pg-prod que se deshace. **La 1ª corrida falló en prod** (el tope 0 que sembraba lo prohíbe `kepler_push_switch_tope_ck`; la base desechable no tenía esa restricción): D-A14 pasa a «sin tope = sólo a mano». 2ª corrida: 19 de 19, control con otra conexión: prod idéntica | Claude |
| 2026-11-20 | Edgar: «cuando me digas que está todo listo, sólo es empujar, dame el reporte de los pedidos que pasarán en automático para avisar a Crédito y cobranza». Nace `ops/prod/reporte-autorizacion-automatica`: corre `leerBandeja` y `armarBandeja` contra prod en sólo lectura. Hoy: al empujar, **0** (interruptor apagado en todas las sucursales); al encender, **6** (los 6 de venta de contado, $62 mil); 9 a Crédito y cobranza; 789 aparte. Es lo mismo que la simulación hecha a mano esa mañana | Claude |
| 2026-11-20 | **GP.A.2 🔨**: regla, sentencia, adaptador y ensayo con ROLLBACK, sin conectar a ningún módulo todavía. Sigue la bitácora (migración), el servicio y el permiso GP.A.0d | Claude |
| 2026-11-20 | Edgar: «cuando se deposite y haya diferencia, ¿el sistema lo detectará, generará el abono y el pedido pasará a automático?». El circuito: depósito visto en el banco (en prod) → cobro capturado en Kepler (**manual**: la Suite no escribe cobros) → cartera por evento (en prod) → resto ≤ $1 tomado como pagado (hecho) y cerrado con Ajuste Abono (GP.R.4, por construir) → **re-evaluar los pedidos del cliente al cambiar su cartera**: disparo nuevo de GP.A.3, que faltaba en el diseño | Claude |
| 2026-11-20 | **Edgar firma la enmienda de ADR-117 (D-A1)**. Queda un solo bloqueo externo para escribir en Kepler: el permiso `UPDATE (c11)` de GP.A.0d, que pide la contraseña de superusuario | Claude |
| 2026-11-20 | Edgar: «dime qué pedidos pasarán automáticamente al soltar… y que les aparezca una notificación cada que se autoriza en auto un pedido». Al soltar, ninguno (no hay escritura ni disparo todavía). Simulado con la regla real: hoy pasarían solos 6, todos de CONTADO; 9 le tocan a Crédito y cobranza. El aviso pasa de agrupado a **uno por pedido**. Las facturas de ticket sin abono (2,794, $2.16 M) son todas de antes de junio: depuración de una vez con el Ajuste Abono, no un abono automático permanente | Claude |
| 2026-11-20 | **D-A12 y D-A13 aplicadas** (Edgar: «apliquémoslos»): CONTADO sin condiciones de crédito y fuera de la bandeja; ruta vecinal como condición 8, a «aparte». La bandeja de hoy baja de 64 a 8 pedidos | Claude |
| 2026-11-20 | **GP.A.4 pantalla (sólo lectura)**: `/finanzas/cartera/por-autorizar` como tercer segmento de Cartera, con la maqueta aprobada: `app-metric-strip` (esperan / viejos, aparte), una frase por pedido, panel con los 3 números de Kepler y «Para decidir». La compuerta Q.1 se resolvió con la pieza del sistema, no se selló. 9 pruebas; `ngc --noEmit` sin errores. Falta: verla con datos (nivel A), GP.A.2 para encender Autorizar, y D-A12/D-A13 | Claude |
| 2026-11-20 | **GP.A.4 servidor 🔨** y la regla mudada a `libs/contracts` (`libs/finance` no puede importar `libs/commercial`). Medido en prod: la bandeja de hoy tendría 64 pedidos, **49 de la ruta vecinal de Zamora Centro** y 6 de CONTADO; telemarketing de verdad, 11 → D-A12 y D-A13. La consulta principal tardaba 245 s (el planificador estimaba 1 pedido) y queda en 92 ms | Claude |
| 2026-11-20 | **La pantalla, aprobada** (Edgar: «listo, podemos empezar a trabajar mediante eso»). Vive en Cartera, no en el Tablero (`credito_cobranza` abre Cartera 24 de 30 días; el Tablero, nunca). Se simplificó a pedido de Edgar con `auditoria-diseno`: bandeja de ~22 controles y ~68 cifras a ~12 y ~28; panel de ~70 cifras a ~14. Nueva §3.6 con las cinco preguntas, el panel y **qué revisa Crédito y cobranza al autorizar a mano**. GP.A.4 y GP.A.5 reescritos | Claude |
| 2026-11-20 | **GP.A.0b 🧪: el «Monto por Cobrar» de Kepler, decodificado 9 de 9 al centavo** (Edgar: «cumpliendo los parámetros de Kepler, lo menos posible de interacción humana y la mayor información»). Σ cargos de `kdue` sin tickets de contado − Σ abonos; la hipótesis de los pedidos quedó refutada. La regla adopta la fórmula de Kepler (en telemarketing, 60 días, mismo veredicto en 2,975 de 2,975 pedidos); 20 pruebas, mutante «recortar el negativo» rojo. Lo que separa a Kepler de lo que el cliente debe son las facturas de ticket sin abono: información para la ficha | Claude |
| 2026-11-20 | **GP.A.1 🧪**: la regla como función pura (`decidirAutorizacion`), 18 pruebas y 3 mutantes rojos. Sigue GP.A.2 (escribir la autorización), que espera D-A1 escrita en ADR-117 y el permiso GP.A.0d | Claude |
| 2026-11-20 | **C0 de EA: GP.A.0a y GP.A.0c 🧪** (prod, sólo lectura). Autorizar = sólo `c11` (8 casos de la foto del 19-nov), no aparta existencia (`kdik`/`kdil`, con control positivo) ni crea cartera. El bloqueo del cliente no es un campo: es el nombre que empieza con «NO TOCAR», por sucursal (145 de 235 conservan límite). La condición 3 usa la regla de centavos ya hecha (`[GP.R.1]`). Queda GP.A.0b (no bloquea) y GP.A.0d (permiso, lo corre el PM). Lo siguiente: GP.A.1, la regla como función pura | Claude |
| 2026-11-19 | Edgar: «ya tenemos los RFC, sólo es asignarlos (pólizas de ContPAQi)». Medido: los CFDI de 282 de los 287 clientes genéricos están timbrados a público en general (2 con RFC propio); el catálogo de personas de ContPAQi da 30 candidatos por nombre. De 73 se llega a ~105 de 366; ~255 no tienen RFC en ningún sistema. Nuevo D-A11 | Claude |
