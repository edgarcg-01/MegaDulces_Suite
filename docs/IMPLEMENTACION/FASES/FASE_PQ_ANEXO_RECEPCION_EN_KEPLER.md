# Fase PQ · Anexo R — La recepción: vale, orden de entrada y aplicación desde la Suite

> Anexo de [`FASE_PQ_PEDIDO_VERDAD_Y_CIERRE.md`](FASE_PQ_PEDIDO_VERDAD_Y_CIERRE.md). Desarrolla
> **`[PQ.112]`** (vale + orden de entrada) y **`[PQ.114]`** (aplicación) del
> [anexo K](FASE_PQ_ANEXO_MENU_COMPRAS_KEPLER.md) §4, que ya les dio destino: el Andén y «Control de
> entradas», sin pantallas nuevas. Agrega los sub-items **PQ.112.1–PQ.112.6**. Sus decisiones se numeran
> **DR1–DR4**; D37 y D38 son las del plan base (§20.4) y siguen sin firma.

```
OBJETIVO: que una recepción se capture UNA vez, en la Suite y junto al camión, y que Kepler reciba
          sus documentos —vale X-A-37 y orden de entrada X-A-40— escritos como los escribe Kepler,
          sin que la Suite invente existencia ni costo.
MÉTRICA:  HOY (2026-11-14, prod, 30 días por fecha de captura, 9 sucursales):
          · 35.3 recepciones por día (1,058 órdenes de entrada vivas, $60.92 M);
          · cada una se captura 3 veces en Kepler (vale, orden de entrada, aplicación): 106.7 capturas por día;
          · documentos de recepción escritos por la Suite: 0 (medido: c67 = 'SUITE' sólo aparece en X-A-30 y X-A-35).
          MÉTRICA PRINCIPAL: vales vivos de la sucursal piloto con c67 = 'SUITE' / vales vivos de esa
          sucursal, 30 días. HOY: 0 %.
          → META (propuesta, a firmar con DR4): a 60 días de encender el escalón 1 en la piloto, ≥ 80 %.
CAPA TOPE: C3 en /almacen/anden, que ya existe (cero pantallas nuevas)
ÁREA:      Almacén (recepción) · Compras · Finanzas (cuentas por pagar, sólo como consumidor)
DUEÑO:     a firmar (lo pidió Francisco el 2026-11-14)
ESTADO:    🔨 C0 — no abre fase (PQ ya está 🔨; el tablero tiene 6 🔨 contra un cupo de 4).
           2026-11-24 (Francisco: «avanzamos a terminar el proceso desde la Suite»): PQ.112.2 ✅ y
           PQ.112.1 medido en el ODS para el vale y casi completo para la orden de entrada (§3b).
           Nacen DR5 (la unidad de la recepción) y DR6 (la OC de la Suite en unidad base, PQ.112.7).
           Código: espera DR1 y DR5 firmadas.
```

## 1. El pedido, literal

> «Trabajaremos en crear este módulo en la Suite. El proceso inicia en requisición de compra / orden de
> compra / vale de entrada / órdenes de entrada / aplicación de orden de entrada. Revisa la secuencia
> para analizar cómo vamos a llevar a la Suite estos siguientes módulos; ya tenemos el de requisición y
> orden de compra.» — Francisco, 2026-11-14, con la captura de la pantalla de Kepler **Orden de entrada**
> (`MD_OE.kpl`, alta, Sucursal Canindo, `XA4001-0000312`).

**Cómo cambia (propuesta de este anexo):** no se copia la pantalla de Kepler ni se hacen tres módulos.
Los tres documentos son **un solo acto** («llegó la mercancía», §3) y la Suite modela el acto, como ya
decidió el §20 del plan base para todo el menú de Compras.

## 2. En una pantalla

```
Requisición ─► Orden de compra ─► Vale de entrada ─► Orden de entrada ─► Aplicación ─► cuenta por pagar ─► pago
  X-A-30          X-A-35             X-A-37              X-A-40             X-A-20         kdxe              X-D-26
  la Suite        la Suite           comprobante         ENTRA EL           NACE LA
  ya escribe      ya escribe         (no mueve nada)     INVENTARIO         DEUDA + póliza
```

| Documento | Qué hace en Kepler | Kardex (`kdij`), 30 d | Riesgo si lo escribe la Suite | Item |
|---|---|---|---|---|
| Vale `X-A-37` | comprobante de lo que llegó, contra la OC | **ninguno** | bajo: igual que la OC, que ya escribimos | PQ.112.4 |
| Orden de entrada `X-A-40` | mete el inventario, cierra el vale | **6,187 renglones · 1,033 documentos** (entradas) | **alto**: existencia y costo de toda la Suite | PQ.112.6 (D37) |
| Aplicación `X-A-20` | crea la cuenta por pagar y la póliza | ninguno | alto y contable (ADR-040) | PQ.114 (D38) |

## 3. Lo medido (2026-11-14)

`pg-prod`, `system_identifier` 7688376744939610156, sólo lectura. Documentos vivos (`c43 <> 'C'`) con
captura (`kdm1.c68`) desde el 2026-10-15, filtro anti-réplica `btrim(c1) = sucursal`. Scripts de la
sesión (no versionados): `medir-cadena-recepcion.js` y `medir-estado-vale.js`; las consultas van
resumidas aquí.

**1. Volumen.**

| Documento | Vivos | Cancelados | $ M | Por día |
|---|---:|---:|---:|---:|
| Orden de compra `X-A-35` | 857 | 268 | 67.87 | 28.6 |
| Vale `X-A-37` | 1,078 | 80 | 62.94 | 35.9 |
| Orden de entrada `X-A-40` | 1,058 | 39 | 60.92 | 35.3 |
| Aplicación `X-A-20` | 1,065 | 51 | 61.06 | 35.5 |

Por sucursal (órdenes de entrada): **08** 321 · **00** 288 ($32.24 M, el 53 % del dinero) · **01** 139 ·
**06** 99 · 03 74 · 07 71 · 02 37 · 04 15 · 05 14. Las cuatro primeras son el **80 %**.

**2. Las ligas, con su control** (cabecera del hijo `c37`/`c38`/`c39` → padre; placebo = el folio
siguiente del mismo tipo).

| Liga | Cobertura | Mismo proveedor | Placebo: mismo proveedor | Mismo capturista | Mismo día |
|---|---:|---:|---:|---:|---:|
| Orden de entrada → vale | 1,058 / 1,058 | **99.8 %** | 24.7 % | 78.5 % | 86.9 % |
| Aplicación → orden de entrada | 1,065 / 1,065 | **99.7 %** | 24.2 % | 90.0 % | 89.4 % |
| Vale → OC | 867 / 1,078 (80.4 %) | — | — | 72.1 % | 65.1 % |

Las dos ligas de después del vale pasan su control: eso es el C0 que pedía `[PQ.123]` para esos dos
tramos (falta aplicación → pago y el placebo «otra sucursal»). **19.6 % de los vales no nace de una
OC**: el Andén tiene que poder recibir sin OC.

**3. La orden de entrada no es una copia del vale.** Renglón contra renglón (`kdm2.c20`–`c23` → renglón
del vale), 6,295 renglones, 100 % con su renglón de vale y mismo SKU y unidad:

| | Renglones | % |
|---|---:|---:|
| misma cantidad que el vale | 5,958 | 94.6 |
| **recibió más** que el vale | 332 | 5.3 |
| recibió menos | 5 | 0.1 |
| **precio distinto** al del vale | 628 | 10.0 |

El vale dice lo que trae el papel; la orden de entrada, lo que se contó y a qué precio. En la Suite
las dos cosas se capturan una vez y los dos documentos salen de ahí.

**4. Sólo la orden de entrada mueve inventario.** En el kardex de 30 días hay `X-A-40` (entrada) y
`X-D-40` (devolución, 108 renglones / 50 documentos). **Ni un renglón** de vale, aplicación u OC.

**5. La orden de entrada cierra el vale.** De los 1,058 vales con orden de entrada: **F 997 (94 %)**,
R 48, N 13. Sin orden de entrada quedan 20 (17 N, 3 A), sólo 2 con 3 días o más. ⇒ Escribir una orden
de entrada también es escribir el estado del vale (y probablemente el saldo de la OC: el anexo K §3c
vio que la recepción mueve `c42`). **Qué columnas exactas, NO MEDIDO.**

**6. La unidad.** Los renglones de orden de entrada vienen en **nueve rótulos**: PAQ 47.7 % · PZA
30.4 % · KG 10.6 % · CJA 10.0 % · y `500`, `250`, `400`, `SER`, `CUB` (76 renglones). El 74 % trae
factor de caja (`c58`) mayor que 1. ⛔ Y la existencia de Kepler (`kdil`) es la **suma cruda** del
kardex sin convertir rótulos ([`ERP_KEPLER.md`](../../ERP_KEPLER.md) §3.x): una orden de entrada escrita
en la unidad equivocada infla la existencia ×24 sin que nada truene. Es el caso de CANON.0.1 (32×).

**7. La aplicación es mecánica.** De 808 órdenes de entrada de 8 a 30 días, **9 (1.1 %)** no tienen
aplicación viva.

**8. Quién captura.** Seis claves hacen el 75 % de las órdenes de entrada: `9ACB` 198 (00) · `30BRC`
157 y `30JG` 155 (08) · `COMPRAS` 134 (01) · `9EMG` 76 (00) · `5004` 70 (06). Son las personas a
quienes se les pregunta antes de diseñar el C3 (y a quienes se les quita trabajo).

**9. El Andén de la Suite hoy.** `commercial.receiving_sessions`: **38 sesiones en su historia, la
última el 2026-10-07, 0 en 30 días.** Y su captura de lote **escribe existencia propia** de la Suite
(`receiving-auditor.service.ts` → `CommercialInventoryService`): la misma «segunda verdad de existencia»
que D21 retiró de la OC y la OE propias (plan base §13).

**10. Dónde escribe ya la Suite** (`c67 = 'SUITE'`, 30 días): requisiciones `X-A-30` 00 72 · 08 80 · 01
26 · 06 19 · 07 4 · 02 2; OC `X-A-35` 00 71 · 08 54 · 01 26 · 06 19 · 07 3 · 02 2. **Ningún** vale,
orden de entrada ni aplicación.

## 3b. El testigo, medido en el ODS (2026-11-24) — `[PQ.112.1]` y `[PQ.112.2]`

`pg-prod` (`system_identifier` 7688376744939610156) en sólo lectura. Documentos vivos con captura en 30
días (60 a 120 para los estados), filtro anti-réplica. Método del `[PQ.22]`: cada columna del hijo contra
la de su padre por la liga, y cada columna del kardex contra el renglón. Scripts de la sesión
(`q2`–`q13`, no versionados); lo que dicen va aquí.

**1. Cómo convierte Kepler cada documento en el siguiente.**

| | Vale ← OC | Orden de entrada ← vale | Aplicación ← orden |
|---|---|---|---|
| Pares (renglones) | 851 (5,076) | 1,014 (5,900) | 1,007 (5,862) |
| Cabecera igual al padre en ≥ 99 % | 169 de 200 columnas | 178 | 177 |
| Cambia siempre | `c4` 37 · `c6` folio · `c31` `Val` · `c63` `XA3701-` · liga `c36` A · `c37` 35 · `c38` serie · `c39` folio de la OC | `c4` 40 · `c31` `Ord` · `c63` `XA4001-` · liga al vale | `c4` 20 · `c31` `Apl` · `c63` `XA2001-` · liga a la orden |
| Es del acto | `c9` fecha (61 % la de la OC) · `c67`–`c69` quién y cuándo · `c11` referencia (63 % la de la OC; el resto, la remisión) · `c14`–`c16` por lo recibido | `c67` (77 % la clave del vale) · `c69` | `c16` puede corregir el total |
| Renglón | copia salvo liga `c19` A · `c20` 35 · `c21` serie · `c22` folio · `c23` renglón; `c9`, `c12`, `c13`, `c56`–`c58` por lo recibido | copia salvo liga; **`c26` = `c13`** (lo llena la orden) | copia; precio `c12` distinto en 26 % e importe en 14 % (la factura) |

`kdm1.c12` (`C-010`, `011`…) es el **concepto de cuentas por pagar**: llega a `kdxe.c18` y a `kdij.c16`.

**2. Con qué estado nace cada uno y qué le hace a su padre** (60 días).

| Documento | Nace | Su padre queda |
|---|---|---|
| Vale | `c43` N, `c42` = `c16` (17 de 17 sin orden), renglón `c24` = `c9` (74 de 74), `c31` = `c9`, `c26` = 0 | OC recibida toda: `c43` F, `c42` 0 (1,232 de 1,232), renglón `c24` 0. Parcial: R, renglón `c24` = `c9` − Σ recibido, **sin piso y sin convertir** (en los renglones CJA queda negativo: 1,611 de 1,611) |
| Orden de entrada | `c43` N, `c42` = `c16`, `c24` = `c9`, `c31` = `c9`, `c26` = `c13` (66 de 66 renglones) | vale: F, `c42` 0, `c24` 0 (1,914 vales; 11,784 de 11,862 renglones) |
| Aplicación | `c43` N, **`c42` = `c16` = la deuda** (1,991 de 1,991), `c24` = `c9` | orden: F, `c42` 0, `c24` 0 (1,988) |

59 OC siguen en N con un vale vivo y el pendiente intacto: por qué, **NO MEDIDO**.

**3. El kardex que deja la orden de entrada.** 5,897 de 5,900 renglones tienen exactamente un `kdij`, y
sus 42 columnas salen del renglón y su cabecera salvo tres:

- `c11` cantidad = `kdm2.c9` y `c12` unidad = `kdm2.c11` en el 100 %: **sin convertir con `c58`** (4,384
  renglones con `c58 > 1`, ninguno convertido). `c13`=`c14` importe (`kdm2.c13`) · `c21`=`c22` importe a
  costo (`kdm2.c26`) · `c15` proveedor · `c16` concepto · `c19` referencia del renglón (`kdm2.c28`) ·
  `c20` moneda · `c10` fecha · `c37`–`c41` liga al vale.
- **`c17` = la existencia ANTES del movimiento** (la calcula el cliente: 103 − 1 = 102 = `kdil`, SKU
  07004 en la 08) · `c29` = primer dígito del renglón (5,798 de 5,798) · `c30` = `E`.

**4. Existencia y costo** (lo que D37 tendría que reproducir).

- `kdil.c8` (entradas acumuladas) es la **suma cruda** de `kdij.c11`: 869 de 1,279 SKUs con entradas en
  un peldaño mayor cuadran crudo y 4 convertido. El resto no cuadra con ninguna por los cortes de
  periodo de `kdil` (el control, con todo en base, cuadra 75.6 %).
- `kdik` en el caso 07004/08: `c8` = valor de las entradas (3,134 × 19), `c9` = valor de las salidas
  (3,032 × 19), `c6` = la **cantidad de salidas** y `c16` = 19. ⚠️ Contradice «`c6` = existencia» de
  [`ERP_KEPLER.md`](../../ERP_KEPLER.md) §2; es un caso, **sin generalizar**.
- **El costo es promedio móvil.** En 5,669 entradas con una salida antes y otra después (08, 00, 01, 06):
  donde las dos reglas se distinguen, promedio móvil 552 contra última entrada 3; 4,675 no distinguen
  (entró al mismo costo). **439 (7.7 %) no cuadran con ninguna**, entre ellas entradas con existencia
  previa negativa en las que el costo no cambió. Por qué, **NO MEDIDO**. ⛔ Mientras ese 7.7 % no tenga
  regla, la Suite no puede escribir la orden de entrada «igual que Kepler».

**5. La unidad — `[PQ.112.2]` ✅.** Kepler no convierte en ningún paso: el vale copia la unidad de la OC,
la orden la del vale y el kardex suma la cantidad tal cual. El 80 % de los renglones de orden de entrada
viene en la unidad base de la ficha (`kdii.c11`) y el 19.1 % (1,128) en un peldaño mayor. De dónde:

| Origen de la cadena | Renglones de orden de entrada (30 d) | En CJA, siendo la base otra |
|---|---:|---:|
| OC capturada a mano | 3,709 | 19 (0.5 %) |
| **OC escrita por la Suite** | 1,278 | **1,109 (86.8 %)** |
| Sin OC | 913 | 0 |

⭐ **Hallazgo.** La Suite escribe la OC en `CJA` cuando son cajas enteras (`[KR.6]`,
`kepler-requisition-sink.adapter.ts`) y Kepler arrastra el rótulo hasta el kardex. **Quien recibe
corrige a mano la cantidad, pero no el rótulo**: en 954 de 1,143 renglones CJA de OC de la Suite, la
orden de entrada dice cantidad = cajas × factor de la ficha (`kdii.c81`/`c84`) y, en 875, precio =
precio ÷ factor, con el rótulo «CJA». En 22 no convirtió (la existencia de Kepler cuenta esas cajas
como paquetes); 167 son otra cosa (parciales, **NO MEDIDO**). La cadena escrita por la Suite le cuesta a
quien recibe **una conversión a mano por renglón (1,143 en 30 días)** y deja en el kardex renglones que
dicen «CJA» y son paquetes. Lo que §3.3 leyó como «recibió más que el vale» (332 renglones) es, en buena
parte, esta conversión. Es también la prueba que le faltó a `[KR.6]` («el factor no se pudo fijar»): el
factor de la ficha es el que usa la gente en el 83.5 %.

Rótulos raros: `500`, `250`, `400`, `CUB` y `SER` son la **unidad base** de su producto (gramaje,
cubeta, servicio): 66 renglones legítimos. Los **49 fuera de la escalera** son casi todos `CJA` de un
producto cuya ficha no tiene caja (KG con BTO): ahí no hay factor y el servidor debe rechazar.

**6. La aplicación** deja un renglón de cuentas por pagar en `kdxe` (`c3` A): 311 de 311 en la 08 (30
días), con `c4`–`c6` el documento, `c9` el plazo, `c10` el vencimiento (fecha + plazo), `c11`=`c15`=`c17`
el importe, `c20` el saldo, `c16` la referencia y `c18` el concepto. Si además mueve los acumulados del
acreedor (`kdxg`) y la póliza (`kdc2AAMM`) como el pago (`ERP_KEPLER` §3.z.5): **NO MEDIDO**.

## 3c. Tres documentos, tres momentos, tres personas (Francisco, 2026-11-24)

Cómo trabaja Compras cada documento, dicho por Francisco, y lo que el ODS confirma (script `m12`):

| Documento | El momento (Francisco) | Quién | Lo medido (60–150 días, sin CL005) |
|---|---|---|---|
| **Vale** `X-A-37` | **La cita de recepción**: donde el proveedor empareja lo facturado contra lo que va a llegar. Quien llega sin cita también se recibe, en la fila | el proveedor ([anexo P](FASE_PQ_ANEXO_PROVEEDOR_AVISO_DE_ENTREGA.md)) | hoy lo hace Compras al llegar: 80.7 % de las OC a mano se capturan el mismo día que su vale (anexo P §3.8c) |
| **Orden de entrada** `X-A-40` | **Rastrillar las entradas**: el almacén revisa en vivo código de barras, caducidad y cantidad | el almacén | **hoy no es en vivo**: en la 08 se teclea justo después del vale (mediana **1 min**; 79.5 % en ≤ 2 min, es decir, desde el papel); en la 00 se captura en **lotes** (47 % de las órdenes en tandas de 4+ de la misma persona en la misma hora), mediana 90 min después del vale y con pico a las 15 h. Francisco: «se recibe contra la factura, anotando sobre ella, descuidando código de barras y caducidades por atender el papel» |
| **Aplicación** `X-A-20` | **Validar el costo**: que lo que llega cueste lo pedido; notas de crédito para que coincida; revisar si el cambio se anunció o hay promoción; que el costo se justifique con el precio de venta. Si no, ahí se cambia el costo del producto o la lista de precios | Compras | **1,239 de 9,466 renglones (13.1 %)** se aplican a un costo distinto al de la OC (±0.5 % a 2×): **$979 mil arriba y $344 mil abajo** sobre $85.6 M aplicados. La aplicación corrige el precio de la orden de entrada en 925 renglones (7.8 %). Otros 1,177 «cambios» eran la conversión caja → pieza con el rótulo «CJA» (§3b.5), no costo |

**La deuda de Kepler que explica la OC nueva** (Francisco): al extraer una OC en varios vales, en algún
momento Kepler la cierra y no deja extraer más aunque le queden productos; por eso se hace una OC nueva.
Lo que el ODS deja ver: de 3,443 OC cerradas (F) con vale, **31 cerraron con 168 renglones todavía por
extraer, y las 31 con el saldo en pesos (`c42`) en cero o menos**; de 406 parciales (R), **104 tienen el
saldo ≤ 0 con productos pendientes**, y 152 traen renglones con pendiente **negativo** (cajas recibidas en
piezas, §3b.5). Hipótesis: Kepler bloquea la OC por el saldo en pesos, no por los renglones. Que ese
saldo sea lo que impide extraer, **NO MEDIDO** (ensayo en el Kepler vivo). ⚠️ La OC nueva **después** de
un cierre así no se ve más que al azar (11 de 31 contra 60.3 % del placebo): lo que domina es la OC hecha
el día que llega la factura (anexo P §3.8c).

**Lo que falta del testigo, y qué lo mide.** (1) El folio de vale y orden de entrada: si el contador que
usa `reservarFolioKepler` tiene llave para `X-A-37`/`X-A-40` → ensayo contra el Kepler vivo de la piloto.
(1b) Qué bloquea extraer de una OC (¿el saldo `c42` ≤ 0?) → el mismo ensayo.
(2) Cómo cambian `kdil` y `kdik` en una entrada → respaldo nocturno contra prod, como el anexo K §3c
(sólo para D37). (3) La `c42` de la OC parcial (sólo 30 de 214 = total − vales). (4) Las 59 OC en N con
vale vivo.

## 4. Lo que creíamos y se matiza

| # | Lo que decía | Lo que midió prod hoy |
|---|---|---|
| 1 | «La misma persona captura vale, orden de entrada y aplica en el 92–95 %» (`FLUJO_COMPRA_A_PAGO` §4.4, jul–oct, Oficinas/sucursales) | 30 días: **78.5 %** vale → orden de entrada y **90.0 %** orden → aplicación. Sigue siendo un acto en la mayoría, pero **1 de cada 5 órdenes de entrada la captura otra clave** que el vale. Quién, NO MEDIDO |
| 2 | «~115 capturas diarias» (§20.1, 90 días) | **106.7** por día (30 días) |
| 3 | «Se captura tres veces» se leía como «tres copias» | La orden de entrada **corrige** al vale en 5.3 % de los renglones (cantidad) y 10 % (precio). **Matiz del 2026-11-24 (§3b.5):** buena parte de esa «corrección» es la conversión a mano de cajas a paquetes en las OC que escribe la Suite, no mercancía de más |

## 5. Cómo se lleva a la Suite: el acto, no tres pantallas

1. **Llega el camión → `/almacen/anden`.** Se entra por la **OC de Kepler** (folio del papel, escaneado
   o tecleado) o, sin OC (19.6 %), por proveedor. Sucursal y almacén salen de la OC y no se re-preguntan.
2. **Se cuenta** con la barra única del Andén. La cantidad se captura en la **unidad de la OC**; la
   conversión pieza ↔ unidad de compra la calcula el servidor una vez, con el factor del renglón
   (PQ.112.2). Precio: el de la factura cuando difiere. Caducidad por renglón, faltante → reclamo
   (WMS-REC.8, ya existe).
3. **Cerrar la recepción = escribir en Kepler**, en una transacción por servidor, con la liga que usa
   Kepler (`c36`–`c39` en cabecera, `c19`–`c23` en renglón) y `c67 = 'SUITE'`:
   - **Escalón 1 (DR1):** sólo el **vale**. La orden de entrada y la aplicación se hacen en Kepler desde
     ese vale («Docto previo»), que ya trae la cantidad contada: el 94.6 % de los renglones hoy no
     cambia de vale a orden. Mismo riesgo que la OC que ya escribimos (no mueve inventario).
   - **Escalón 2 (D37):** el vale **y** la orden de entrada. Quita una captura más, y mete inventario.
4. **La aplicación** sigue en Kepler (D38, «no por ahora»).
5. **La cantidad es de Kepler** (DR3): el Andén deja de escribir existencia propia; se queda con lo que
   Kepler no tiene: lote, caducidad, ubicación, foto e incidencia.

**Los campos de la pantalla de Kepler, uno por uno** (la captura del pedido):

| Campo en Kepler | De dónde sale en la Suite |
|---|---|
| Sucursal · Almacén · Grupo/Tipo docto · Fecha | de la OC y del acto; no se preguntan |
| Proveedor · RFC · Agente · Moneda · Paridad | copia de la OC (cuántas no son PESOS: NO MEDIDO) |
| Docto previo | la OC (para el vale) y el vale (para la orden) |
| Referencia | la remisión o factura del papel (columna exacta: NO MEDIDO, va en PQ.112.1) |
| Escaneo por código de barras «se sumarizará en la unidad de la compra» | la barra única del Andén; la conversión, en el servidor |
| Artículo · Cantidad recibida · Cantidad vale · Unidad · P.U. · Importe · Descripción | el conteo; cantidad vale = la de la OC |
| Subtotal · Descuento · Flete · IEPS · IVA · Importe | ¿los calcula el cliente de Kepler o se guardan? NO MEDIDO (PQ.112.1); IEPS/IVA deben salir del producto, no teclearse |
| Plazo · Condiciones · Método de pago | del plazo del proveedor en la Suite (RE.30). Hoy el 61.8 % dice «Pago de contado», que es «nadie capturó el plazo» (`FLUJO_COMPRA_A_PAGO` §4.5): si llega a la aplicación, los vencimientos mejoran. Si se propaga de la orden a la aplicación: NO MEDIDO |
| Fecha y hora de entrega | la hora real del cierre (Kepler hoy no guarda la llegada física) |
| Monto maniobra · Ticket de maniobras | uso NO MEDIDO; ¿lo paga Caja? se pregunta antes de C3 |
| Fecha de caducidad | por renglón en el Andén (más fino que una por documento) |
| Compra no fiscal · Comentarios | uso NO MEDIDO · nota de la recepción |
| Imprimir etiquetas | fuera de este anexo |

## 6. Decisiones a firmar

> **Respondidas por Francisco (Compras) el 2026-11-24; falta que Edgar las ratifique:** **DR4** la 08 ·
> **DR5** unidad base, mostrando también la caja del proveedor · **DR6** la vista de Compras es que sí
> (cambia `[KR.6]`, así que la firma Edgar) · **DR7** el vale se escribe al confirmar la cita. De Edgar
> sin respuesta todavía: **DR1**, **DR3**, **D37**, **D38** (con `[PQ.157]` aparte).

| # | Decisión | Opciones | Recomendación |
|---|---|---|---|
| **DR1** | ¿Se parte la escritura en dos escalones? | (a) primero sólo el vale, después la orden de entrada · (b) los dos juntos desde el inicio | **(a).** El vale no toca kardex (§3.4), así que su riesgo es el de la OC, que ya escribimos en 6 sucursales. Con la cantidad contada en el vale, la orden de entrada en Kepler queda en confirmar. Se lleva casi todo el ahorro con el riesgo más bajo |
| **D37** (plan base) | ¿La Suite escribe la orden de entrada (mueve inventario)? | sí · no | **Sí, como escalón 2**, sólo con PQ.112.1 y .2 cerrados, el escalón 1 verificado en la piloto, la baja antes que la alta, interruptor por sucursal apagado con tope y ensayo contra el Kepler vivo sin escribir. ⛔ Kepler **no tiene triggers**: la Suite tendría que escribir lo mismo que el cliente de Kepler (kardex, existencia, valuación). Si el testigo muestra algo que no podemos reproducir igual (p. ej. un costo promedio), el escalón 2 **no se hace** y se dice. **2026-11-24 (§3b.3–4):** el kardex sí se puede reproducir (42 de 42 columnas con regla); el costo es promedio móvil pero **7.7 % de las entradas no sigue ninguna regla medida**, y `kdil`/`kdik` antes/después siguen sin testigo. Hoy el escalón 2 no se puede prometer igual que Kepler |
| **D38** (plan base) | ¿La Suite escribe la aplicación? | sí · no por ahora | **No por ahora.** Es mecánica (98.9 % aplicada en 8 días, §3.7) y crea la cuenta por pagar y la póliza; ContPAQi es el sistema contable (ADR-040). **2026-11-24:** Francisco la pide junto con vale y orden. `[PQ.114]` está ⏸️ por el PM desde el 2026-11-18: reabrirla es de Edgar. Medido (§3b.6): deja un renglón en `kdxe` (311 de 311); el pago `X-D-26` ya escribe `kdxe`, `kdxg` y póliza desde la Suite (PGP O3), así que el oficio existe. Su C0 sería medir sus escrituras con el método de `ERP_KEPLER` §3.z.5 |
| **D38 se parte** (2026-11-24, §3c) | La aplicación tiene dos cosas: **validar el costo** (el trabajo de Compras) y **escribir** el documento | — | **Validar el costo en la Suite no espera a D38** (`[PQ.157]`): OC contra factura (renglón por renglón, con la equivalencia del anexo P), nota de crédito esperada, cambio anunciado o promoción, y margen contra el precio de venta; Compras decide y lo registra. Escribir `X-A-20` en Kepler sigue en D38 (⏸️) |
| **DR7** | ¿Cuándo se escribe el vale? | (a) **al confirmar la cita** (antes del camión) · (b) al llegar el camión | **(a)**, porque el vale ES la cita (§3c): descuenta la OC en Kepler por factura —lo que pidió Francisco— y no mueve inventario (§3.4). Exige la baja primero: si el camión no llega en su ventana, el vale se da de baja (hoy ya se cancela el 6.7 %). La orden de entrada se queda para el rastrillo en vivo (D37) |
| **DR5** | ¿En qué unidad escribe la recepción? | (a) la de la OC, como Kepler (quien recibe sigue convirtiendo a mano) · (b) **en la unidad base de la ficha**, convertida en el servidor con el factor de la ficha de ESA sucursal, y rechazo si la unidad de la OC no está en la escalera | **(b).** Es lo que hace la persona en 954 de 1,143 renglones y la forma del 80 % de las entradas de Kepler; el kardex queda con el rótulo verdadero. El Andén muestra cajas y piezas, y se confirma lo contado en piezas. El pendiente de la OC (`c24`) se escribe en la unidad de la OC (Kepler lo resta sin convertir y queda negativo): se declara la diferencia |
| **DR6** | ¿La OC que escribe la Suite nace en unidad base? | sí, como el traspaso (D24) · no, sigue en `CJA` (`[KR.6]`) | **Sí** (`[PQ.112.7]`). Quita las 1,143 conversiones a mano de cada mes **sin esperar al Andén**, y lo que faltaba en KR.6 ya está medido: el factor de la ficha es el que usa la gente (83.5 %). Con el contraste ficha ↔ Suite que ya tiene el traspaso, y rechazo si no coinciden. Toca una decisión del PM (KR.6/PQ.17): la firma Edgar |
| **DR3** | ¿De quién es la cantidad recibida? | Kepler · la Suite también | **Kepler.** El Andén deja de escribir existencia propia y conserva lote, caducidad, ubicación e incidencia. Es D21 aplicado al Andén. ⚠️ Antes de apagarlo: medir quién lee esa existencia (alertas, caducidades, ubicaciones de UB) |
| **DR4** | Sucursal piloto | 08 · 00 · una chica (04/05) | **08**: la de más órdenes de entrada (321 en 30 días, 3 capturistas) y la segunda con más OC escritas por la Suite (54; la 00 tiene 71, §3.10), así que la cadena Suite → Kepler se prueba completa sin arrancar en la sucursal que mueve el 53 % del dinero. La 00 va después |

## 7. Qué NO incluye

- **No replica la pantalla de Kepler** ni crea pantallas «Vale», «Orden de entrada» y «Aplicación».
- **No crea documentos propios** de la Suite (ni OE ni existencia): D21.
- **No escribe la aplicación**, la cuenta por pagar ni la póliza (D38, ADR-040).
- **No toca la recaptura de Oficinas**: cada recepción de sucursal se vuelve a capturar en la 00 como
  asiento (1,008 aplicaciones gemelas, $23.13 M en 2026, `FLUJO_COMPRA_A_PAGO` §4.4). Se declara; no se
  arregla aquí.
- **No incluye** la devolución `X-D-40` (`[PQ.113]`) ni la recepción de traspasos `U-A-50` (anexo T).
- **Sí incluye la baja** de lo que la Suite escriba, y va antes que la alta: 112 recepciones anuladas
  enteras en 90 días (anexo K §3b).
- Los permisos nuevos de `kepler_push` en Kepler los firma Edgar y los corre el PM (como D40). No se
  tocan credenciales.

## 8. El orden

**Dinero en juego: Alto por riesgo** (por aquí pasan $60.92 M en 30 días, y la orden de entrada fija la
existencia y el costo que leen margen, pedido y precios). **El beneficio es tiempo**: hasta ~70 capturas
diarias menos (dos de tres por recepción), en horas **NO MEDIDO**. **Esfuerzo:** escalón 1 **M**,
escalón 2 **L**. Dentro de PQ, el anexo K pone PQ.112 detrás de PQ.110/111, KR.7 y PQ.123; el C0 de
sólo lectura no compite con ellos.

| Orden | Item | Capa | Por qué va ahí |
|---|---|---|---|
| 1 | **PQ.112.1** testigo de una recepción real | C0 | Sin saber qué escribe Kepler no hay código (regla 10). Sólo lectura. **Vale: medido (§3b); orden de entrada: falta `kdil`/`kdik` antes/después** |
| 2 | **PQ.112.2** la unidad, probada | C0 | El error más caro posible (§3.6). **✅ 2026-11-24 (§3b.5)** |
| 2b | **PQ.112.7** la OC de la Suite nace en unidad base (DR6) | C1–C2 | El ahorro más barato: 1,143 conversiones a mano por mes, en un escritor que ya existe |
| 3 | **PQ.112.3** preguntas a los capturistas | C0 | Por qué el Andén no se usa; maniobras; quién captura la orden cuando no es quien hizo el vale |
| 4 | **PQ.112.4** escribir y dar de baja el vale | C1–C2 | Escalón 1: adaptador hermano del de la OC, mismo patrón (plantilla, folio dentro del `UPDATE`, sin `LOCK TABLE`) |
| 5 | **PQ.112.5** el Andén entra por la OC y cerrar escribe el vale | C3 | Las cinco preguntas de `diseno` §0b por escrito, con los seis capturistas |
| 6 | **PQ.112.6** la orden de entrada (escalón 2) | C1–C3 | Sólo con D37 firmada y 1–5 verificados en la piloto |

## 9. Items

- **`[PQ.112.1]`** 🔨 (2026-11-24: vale medido; orden de entrada sin `kdil`/`kdik` antes/después, §3b)
  **C0 — El testigo: qué escribe Kepler en una recepción real.** Método del anexo K
  §3c (respaldo nocturno de `md` contra prod, columna por columna) y, si hace falta, `xmin` en el Kepler
  vivo de la piloto con `kepler_push`, sólo lectura. Tablas: `kdm1`, `kdm2`, `kdij`, `kdil`, `kdik`,
  `kdii`, el vale y la OC de origen (`c42`, `c43`, `c24`), el folio, y **cualquier otra que cambie**
  (barrer todas las del esquema, no sólo las sospechosas). Cierre: tabla por tabla para tres
  recepciones —una en PAQ, una en KG y una con orden distinta del vale— más una anulada si ocurre en la
  ventana; qué hace con el **costo** (¿última entrada o promedio?) contra el precio del renglón.
- **`[PQ.112.2]`** ✅ 2026-11-24 **C0 — La unidad, probada.** En los renglones de orden de entrada de 30 días: ¿el
  kardex (`kdij.c11`/`c12`) guarda la cantidad en la unidad del renglón (`kdm2.c11`) o convertida con
  `c58`? Control: la existencia (`kdil`) como suma cruda. Cierre: la regla escrita en
  [`UNIDADES_DE_MEDIDA.md`](../../UNIDADES_DE_MEDIDA.md) con su cobertura, y los rótulos raros (`500`,
  `250`, `SER`, `CUB`) clasificados. **Resultado (§3b.5):** la unidad del renglón, sin convertir (5,897
  de 5,897); `kdil` suma crudo (869 contra 4); los rótulos raros son unidad base; la regla vive en
  `UNIDADES_DE_MEDIDA.md` §8decies. Hallazgo: 1,109 de los 1,128 renglones en CJA vienen de OC de la
  Suite (→ DR5, DR6).
- **`[PQ.112.7]`** ⬜ DR6 — **C1–C2 — La OC que escribe la Suite nace en unidad base.** En
  `kepler-requisition-sink.adapter.ts`, las cajas enteras de compra pasan al camino de piezas que ya
  usa el traspaso (D24): cantidad × factor, costo ÷ factor, unidad `kdii.c11`, factor de la Suite
  contrastado con la ficha de esa sucursal y rechazo si no coinciden o la ficha no tiene caja.
  Cierre: medición antes/después de «renglones de orden de entrada en CJA nacidos de OC de la Suite»
  (HOY 1,109 en 30 días) y de la conversión a mano (954); prueba contra base real; las OC en `CJA` que
  sigan vivas se declaran, no se reescriben.
- **`[PQ.112.3]`** ⬜ **C0 — Preguntar a quien recibe** (como parámetro o por el canal del PM, no de
  memoria): a las seis claves de §3.8, por qué el Andén no se usa desde el 07-oct, quién captura la
  orden de entrada cuando no es quien hizo el vale (21.5 %), y qué es la maniobra.
- **`[PQ.112.4]`** ⬜ **C1–C2 — Escribir y dar de baja el vale `X-A-37`** desde una OC con las cantidades
  contadas, y sin OC por proveedor. Interruptor por sucursal **apagado** con tope diario, ensayo contra
  el Kepler vivo sin escribir, prueba contra base real (regla 13), permisos de `kepler_push` firmados.
  Depende de PQ.112.1 y DR1.
- **`[PQ.112.5]`** ⬜ **C3 — El Andén entra por la OC y cerrar la recepción escribe el vale** (DR3: deja de
  escribir existencia propia). Skill `diseno`. Cierre: medición antes/después de la métrica principal en
  la piloto (DR4).
- **`[PQ.112.6]`** ⚠️ D37 — **Escalón 2: la orden de entrada `X-A-40` y su baja**, en la misma transacción
  que el vale. Sólo si PQ.112.1 muestra que se puede escribir igual que Kepler. **2026-11-24 (§3c):** es
  el rastrillo en vivo del almacén; ya no va «en la misma transacción que el vale» (el vale nace en la
  cita, DR7), sino al cerrar el conteo en el Andén.
- **`[PQ.157]`** ⬜ **C0–C3 — Validar el costo al aplicar** (la mitad de D38 que no escribe en Kepler,
  §3c): por renglón, precio de la OC contra el de la factura (equivalencia del anexo P), nota de crédito
  esperada, cambio anunciado o promoción, y margen contra el precio de venta; Compras acepta, reclama o
  cambia el costo, y queda registrado quién y por qué. Base: la conciliación de Recepción (`[RE.53]`, que
  ya marca «difiere precio» entre la factura y lo capturado en Kepler) llevada a comparar contra la OC. Cierre: renglones
  aplicados a un costo distinto al de la OC con su decisión registrada, antes/después (HOY 1,239 de 9,466
  en 60 días, sin decisión registrada en ningún lado).

## 10. Riesgos y bloqueos

| Bloqueo | Dueño | Causa | Qué lo destraba |
|---|---|---|---|
| D37 y DR1–DR4 sin firma | Edgar | escribir en Kepler lo que mueve inventario | este anexo + PQ.112.1/.2 |
| Permisos de `kepler_push` para el vale (y, en escalón 2, `kdij`/`kdil`/`kdik`) | Edgar firma; el PM los corre | el rol no los tiene | un archivo en `ops/prod/kepler-grants/` después del testigo, como D40 |
| PQ sin dueño nombrado | Edgar | cabecera del plan base | nombrarlo (método §3) |
| El Andén no se usa | quien recibe (las seis claves) | NO MEDIDO | PQ.112.3 |
| Kepler sin triggers: la Suite reproduce la lógica de su cliente | — | estructura del ERP | PQ.112.1; si no se puede igualar, el escalón 2 no se hace |
| DR5 y DR6 sin firma | Edgar | la unidad de lo que escribe la Suite (DR6 cambia una decisión de KR.6/PQ.17) | §3b.5 |
| 7.7 % de entradas sin regla de costo | — | NO MEDIDO (¿existencia previa negativa?) | respaldo nocturno contra prod antes de D37 |

## 11. Definición de terminado (método §5)

- [ ] C0 con árbitro: testigo (PQ.112.1) y unidad (PQ.112.2) publicados aquí. *(2026-11-24: unidad ✅;
  testigo del vale ✅, de la orden de entrada falta `kdil`/`kdik` — §3b)*
- [ ] Decisiones DR1–DR4 y D37 firmadas, con quién y cuándo.
- [ ] Escritura probada contra base real con el payload de la pantalla (regla 13), baja incluida.
- [ ] Ensayo contra el Kepler vivo de la piloto, sin escribir, en verde.
- [ ] Permiso de la pantalla repartido en prod (regla 20) y matriz de accesos regenerada.
- [ ] Métrica principal medida antes y después en la piloto.
- [ ] Tracker, log y ADR (si DR3 se firma: la cantidad recibida es de Kepler).

## 12. Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
| 2026-11-24 | Francisco explica los tres documentos como tres momentos (§3c): **vale = la cita** (el proveedor), **orden de entrada = rastrillar en vivo** (el almacén), **aplicación = validar el costo** (Compras), y la deuda de Kepler que cierra la OC antes de tiempo. Medido: la orden de entrada no es en vivo (08: 1 min después del vale desde el papel; 00: 47 % en lotes, 90 min después); 13.1 % de los renglones se aplica a un costo distinto al de la OC (+$979 mil / −$344 mil en 60 días); 31 OC cerradas y 104 parciales con saldo ≤ 0 y productos por extraer. Nacen DR7 (el vale se escribe al confirmar la cita) y `[PQ.157]` (validar el costo sin esperar a D38) | Claude |
| 2026-11-24 | El vale se alimenta desde antes del camión: el [anexo P](FASE_PQ_ANEXO_PROVEEDOR_AVISO_DE_ENTREGA.md) (pedido de Francisco) hace que el proveedor empareje su factura con la OC; el Andén recibe por factura (`[PQ.153]`) y se escribe un vale por factura (DP6). Medido allí: 1 vale → 1 orden → 1 aplicación en Kepler, y sólo 24 % de los vales lleva el folio de su factura | Claude |
| 2026-11-24 | Francisco: «avanzamos a terminar el proceso desde la Suite: vale, orden de entrada y aplicación». **§3b, el testigo en el ODS:** cómo convierte Kepler OC → vale → orden → aplicación columna por columna, con qué estado nace cada uno y qué le hace a su padre; las 42 columnas del kardex salen del renglón salvo `c17` (existencia previa), `c29` y `c30`; el costo es promedio móvil (552 contra 3) con un 7.7 % sin regla; la aplicación deja `kdxe` (311 de 311). **PQ.112.2 ✅:** Kepler no convierte unidad en ningún paso, y 1,109 de los 1,128 renglones de entrada en CJA nacen de OC escritas por la Suite: quien recibe convierte a mano (954) y el kardex se queda con «CJA». Nacen DR5, DR6 y PQ.112.7; D38 anota que PQ.114 está ⏸️ por el PM | Claude |
| 2026-11-14 | Anexo R: análisis de la secuencia requisición → OC → vale → orden de entrada → aplicación a pedido de Francisco (captura de `MD_OE.kpl`). Medido en 30 días: 35.3 recepciones por día y 3 capturas por recepción; las ligas vale → orden y orden → aplicación pasan su placebo (99.8 % y 99.7 % contra 24.7 % y 24.2 %); sólo la orden de entrada mueve kardex; la orden corrige al vale en 5.3 % de los renglones (cantidad) y 10 % (precio); nueve rótulos de unidad; el Andén lleva 0 sesiones en 30 días y escribe existencia propia. Propuesta: el acto en el Andén, en dos escalones (vale, luego orden de entrada); la aplicación sigue en Kepler. Nacen PQ.112.1–PQ.112.6 y DR1–DR4, sin firma | Claude |
