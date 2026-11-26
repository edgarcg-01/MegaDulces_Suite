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

## 3d. La aplicación como validación de costo, medida (`[PQ.157]` C0, 2026-11-25)

Lo que Compras valida al aplicar, renglón por renglón, contra la OC. Base de datos:
**`commercial.v_application_line_cost`** (mig `20261125214023`, derivada del ODS): cada renglón de aplicación
viva encadenado a su OC por la orden de entrada y el vale, con el precio de la OC **llevado a la unidad de la
aplicación** y un estado: `igual` · `sube` · `baja` · `sin_oc` · `sin_precio` · `otra_escala_sin_factor` ·
`otra_escala_ambigua`. Scripts `m1`–`m8` en `C:\DEV\_tmp\pq157`; pg-prod en sólo lectura.

**1. La cadena y el universo (60 días, sin CL005).** El 100 % de los renglones de aplicación viene de una orden de
entrada, y ésta de un vale. **9,534 renglones ($85.2 M) llegan a una OC**; **2,374 ($22.2 M, 20 %) salen de un
vale sin OC**: para ésos no hay precio pedido, y su referencia será la lista del proveedor (`[PQ.155]`).

**2. El corte de «igual».** Entre un centavo y 0.5 % hay 67 renglones con $2,296 en 60 días; arriba empieza lo que
pesa (0.5–3 %: 225 renglones, $52 mil; 3–10 %: 745, $771 mil; 10 %–2×: 231, $469 mil). Igual = a 1 centavo o
menos, o a 0.5 % o menos.

**3. ⭐ La escala: el rótulo miente y el factor sale de la ficha.** 1,240 renglones (13 %) tienen el precio de la OC
y el de la aplicación fuera de 0.5–2× con el mismo rótulo: la OC en `CJA` aplicada por pieza (§3b.5). Compararlos
tal cual da $453 M de «diferencia» falsa. Con los factores de la ficha de esa sucursal (`kdii.c81`, `c84`,
`c84/c81`), **casan 1,236, ninguno ambiguo**. Testigo independiente: **en 1,074 (87 %) la cantidad también
cambió por ese mismo factor** (la cantidad no se usa para elegirlo; placebo con el doble del factor: 0.2 %). Ya
escalados: 755 iguales, **231 suben y 250 bajan (+$217 mil / −$168 mil)**. Redondear el cociente a un entero
habría dado casi lo mismo, pero el veredicto sería circular: el factor tiene que venir de la ficha.

**4. Lo que pasa hoy (60 días).** De 9,527 renglones comparables: **7,847 iguales · 1,029 suben (+$1.17 M) · 651
bajan (−$511 mil)**: el **17.6 %** se aplica a un costo distinto al de la OC. *Matiz a §3c:* el 13.1 % de ayer
dejaba fuera lo que está en otra escala; con el factor de la ficha también se ve.

**5. ⭐⭐ El cambio no se registra, y se vuelve a validar.**

| Pregunta | Medido | Control |
|---|---|---|
| Cuando la aplicación SUBE el costo, ¿la siguiente OC del mismo producto y proveedor trae el precio nuevo? (90–30 d) | **185 de 452 sí; 224 regresan al precio viejo**; 43 otro | sin diferencia: 86 % conserva el precio |
| De los 220 renglones cuya OC siguiente regresó al precio viejo, ¿la siguiente aplicación lo volvió a subir? | **135 (61 %)** | sin diferencia: la siguiente difiere en 4.7 % |
| De lo que la aplicación corrige (60 d), ¿el precio aplicado ya era el de la aplicación anterior? | **420 de 747 (56 %), $260 mil de $602 mil** | igual: 86.9 % |

Compras valida el mismo cambio de precio una y otra vez, porque no queda en ningún lado: la OC siguiente nace
con el precio viejo aunque la última entrada ya lo había corregido.

**6. OC de la Suite contra OC de Kepler.** En bruto, 38.1 % de los renglones de OC de la Suite se aplica a otro
costo, contra 14.4 % de Kepler. **Proveedor por proveedor no es general**: en los 89 que tienen las dos, la Suite
sale peor en 26 y Kepler en 28. Ajustado por proveedor (cada uno con su tasa de Kepler) se esperaban 341 ± 21 y
hubo 491, y la mitad del exceso es **un solo proveedor** (43 % en las OC de la Suite contra 8.5 % en las suyas de
Kepler). La causa —la Suite pone el precio con `analytics.v_erp_unit_cost` y no con lo último aplicado a ese
proveedor— es **hipótesis, NO MEDIDA**.

**7. La factura y la nota de crédito** (por aplicación, con la liga de `[PQ.150]`; 90–30 días para dar tiempo a la
nota). De 262 aplicaciones con algún renglón distinto de la OC, 185 tienen su factura ligada: **149 (80 %)
cuadran con la factura** —el proveedor facturó otro precio y se aceptó sin dejar rastro— y **35 quedaron abajo de
la factura**, donde se espera una nota. En todas las ligas: 109 aplicaciones abajo de su factura (6 proveedores,
$743 mil); **81 (74 %) ya tienen una nota del SAT que relaciona esa factura** (`CfdiRelacionado` del XML), contra
24 % de las que cuadran (placebo); la nota llega a los 20 días (p10 5, p90 35). En los dos proveedores grandes la
nota ligada cubre la mitad de la diferencia; si el resto llegó en notas ligadas a otras facturas (los dos emiten
muchas), **NO MEDIDO**. En Kepler la nota `X-D-55` se aplica a la aplicación (`kdxf`, cargo 55 → abono 20); dos
cargas masivas (2,240 el 30-sep y 622 el 9-oct) se excluyen de esa cuenta.

**Lo que esto pide de C1–C3.** (a) La decisión es **por renglón** y se registra: aceptar (y que la OC siguiente
nazca con ese precio: la lista de `[PQ.155]`), reclamar (nota esperada, que se sigue hasta que llega) o
promoción/cambio anunciado. (b) La pantalla dice cuando el precio ya se había aceptado antes —56 % de los casos—
para que no se vuelva a pelear. (c) La nota esperada vive a nivel aplicación y espera a `[PQ.150]`.
**NO MEDIDO todavía:** promociones y cambios anunciados (no hay fuente en el ODS); el margen contra el precio
de venta (C1); «ya se sabía» lo calcula la API (C2) con una segunda consulta: una ventana en la vista impediría
filtrar por fecha.

## 3e. El flujo objetivo, paso por paso (Francisco, 2026-11-26)

Cómo tiene que quedar el proceso en la Suite, dicho por Francisco, contra lo que ya existe y lo medido hoy
(pg-prod en sólo lectura; prueba visual del 2026-11-25 en tres perfiles; scripts `b1`–`b2` en
`C:\DEV\_tmp\pq157-visual`).

| Paso | Lo que pide Francisco | Lo que ya existe | Lo medido hoy | Lo que falta |
|---|---|---|---|---|
| **OC** | La Suite la transmite **en el orden y las palabras de la factura del proveedor** (su código, su descripción, su unidad); por dentro quedan nuestras descripciones. Le llega «como su sistema», para que no haya discrepancias | Las equivalencias código del proveedor ↔ SKU, aprendidas de sus facturas (`[PQ.148]`, PR #624 sin fusionar). El papel de la OC (`[OC.3]`, `orden-proveedor-pdf.ts` y `-csv.ts`) imprime **nuestro** SKU y descripción | Con la historia de PQ.148: 1,899 de 2,797 códigos del proveedor con su SKU (67.9 %). Cuántos renglones de OC saldrían ya en sus palabras: **NO MEDIDO** | **`[PQ.158]`** |
| **Vale (la cita)** | Se lee el **UUID** de la factura; las remisiones, por OCR o visión de IA. El sistema empareja: **lo que coincide al 100 % pasa solo; lo demás, a revisión manual** | El aviso de entrega `[PQ.149]`, emparejar `[PQ.151]`, recibir por factura `[PQ.153]` y la cita `[PQ.156]` (anexo P). La lectura del PDF y la regla «pasa sola / por revisar» existen, pero sobre la aplicación y después del camión (`/compras/revision-facturas`) | Entradas desde el 2026-08-01: **739 pasan solas, 1,253 por revisar, 41 sin CFDI aún** (36 % solas). La prueba visual encontró dos «Por revisar» con cifras distintas en esa pantalla (1,253 en la bandeja, 979 en el resumen) | La regla del 100 %, como criterio de PQ.151 (abajo) y DR9 |
| **Orden de entrada** | Se **rastrilla**: se capturan caducidad y lote y se validan **piezas y peso** | El Andén (`[WMS-REC]`): recibe por vale, lee lote y caducidad con OCR, fecha por lote | **Casi sin uso:** 12 sesiones en octubre y **0 en noviembre**, contra 1,127 y 875 aplicaciones; 58 lotes capturados en total, 0 en noviembre. **El peso no existe en Kepler** (`kdii` no trae kilos por producto, [`ERP_KEPLER`](../../ERP_KEPLER.md) «Peso: No existe»); sólo el granel se compra en KG | **`[PQ.159]`** (peso) · PQ.112.3 (por qué no se usa) · DR8 |
| **Aplicación** | Aterriza el costo contra las diferencias de la factura: **descontar con nota de crédito, o ajustar costos y precios** | `[PQ.157]` C0 (§3d): cada renglón contra su OC, en la unidad correcta | 1,680 de 9,527 renglones a otro costo en 60 días; 74 % de las aplicaciones abajo de su factura ya tiene la nota del SAT. La prueba visual: **ninguna pantalla muestra el precio de la OC** (tres pantallas, tres perfiles), y el panel que valida se titula «Orden de entrada» pero muestra la aplicación (un folio de aplicación de una sucursal coincide con el de una orden de entrada de otro proveedor) | PQ.157 C1: la decisión por renglón. **Reclamar** = descontar con la nota; **aceptar** = el costo nuevo pasa a la lista (`[PQ.155]`) y avisa a precios si el margen cambia |

**La regla del 100 % (criterio de `[PQ.151]`, propuesta).** Un renglón de factura pasa solo cuando se cumplen
las cuatro: (1) la factura está vigente en el SAT, el emisor es el proveedor de la OC y el receptor somos
nosotros; (2) su código casa con un SKU por una equivalencia aprendida (`[PQ.148]`), no por la descripción;
(3) cantidad × factor igual a lo pendiente del renglón de la OC; (4) precio igual al de la OC, a un centavo o
0.5 % (el corte de §3d.2). La factura pasa sola si pasan todos sus renglones; si uno falla, va entera a
revisión con ese renglón señalado. Lo que no se puede emparejar nunca se marca «Cuadra» (el caso de AUD-DAT.34:
dos productos cruzados con el mismo número de cajas). **Hoy no se sabe cuántas facturas pasarían solas con
esta regla: es el C0 de PQ.151**, con la vista de PQ.150 y la equivalencia de PQ.148.

**Lo que la prueba visual del 2026-11-25 le pide a la pantalla de PQ.157** (nivel A, tres perfiles): el precio
de la OC y la diferencia van en cada renglón del detalle que ya se usa para validar (la lista se cargó 12,600
veces en 30 días); el panel se llama «Aplicación» y muestra el folio de su orden de entrada junto al de la OC y
el vale; un solo «Por revisar»; y en el celular el costo no se esconde (hoy se pierden Cantidad, Unidad y Costo
unitario). Deuda que se arregla de paso: la lista tarda 12.6 s (regla: 0.5 s) y en Fold 7 y celular no se ve
ninguna fila sin desplazarse.

**El orden, por dinero y esfuerzo:** (1) PQ.157 C1, la decisión por renglón: el dinero está medido y no espera
a nadie; (2) PQ.158, en cuanto se fusione #624, porque la equivalencia ya está hecha; (3) PQ.151 con la regla
del 100 %; (4) PQ.159, después de PQ.112.3 y DR8: pesar en un Andén que nadie usa no cambia nada.

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
>
> **Decididas por Francisco (Compras) el 2026-11-26, como se recomendaron:** **DR8 (a)** el peso estándar de
> cada presentación se aprende en el Andén (con (c), la lista del proveedor, como respaldo) · **DR9 (b)** la
> remisión leída por OCR o visión no pasa sola hasta medir su acierto contra facturas con UUID.

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
| **DR8** (2026-11-26, §3e) | ¿De dónde sale el peso que valida la orden de entrada? Kepler no lo tiene | (a) **se aprende en el Andén**: la primera recepción pesada de cada presentación fija su peso estándar (dato propio, con quién y cuándo), y las siguientes se comparan con él · (b) lo captura Compras en la ficha · (c) lo manda el proveedor con su lista (`[PQ.155]`) | **(a)**, con (c) como respaldo cuando llegue la lista: es el único que no pide capturar un catálogo entero antes de empezar, y se puede verificar (dos pesadas de la misma presentación tienen que coincidir). El granel ya viene en KG y no lo necesita. Decide Francisco (Compras) |
| **DR9** (2026-11-26, §3e) | ¿Una remisión leída por OCR o visión de IA puede pasar sola al 100 %? | (a) sí, con la misma regla que una factura · (b) **no, hasta medir la lectura**: va a revisión hasta que su acierto, medido contra facturas con UUID, alcance el umbral que se fije | **(b)**: la factura trae el dato firmado por el SAT y la remisión, lo que leyó una máquina. Lo que no se mide se declara (regla 11). Decide Francisco (Compras) |
| **DR10** (2026-11-26, `[PQ.157]` C2) | ¿Quién guarda la decisión de costo de un renglón? | (a) **clave nueva sólo para Compras** (gerente_compras, compras, compras_operaciones, auxiliar_compras: 10 personas) · (b) lo mismo sin auxiliares (5) · (c) reusar `COMPRAS_ENTRADAS_VALIDAR` (también encargados de tienda, Finanzas y Tesorería) | **(a), decidida por Francisco el 2026-11-26:** `COMPRAS_COSTO_DECIDIR`, repartida por la mig `20261126003314`. Ver la información la sigue viendo quien ve Revisión de facturas |
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
- **`[PQ.157]`** 🔨 (**C0 🧪 2026-11-25, §3d**: `commercial.v_application_line_cost`, mig `20261125214023`;
  **C1 🧪 2026-11-26**: `commercial.application_cost_decisions`, mig `20261126001925`; **C2 🧪 2026-11-26**: la API
  `compras/costo-aplicado` y la clave `COMPRAS_COSTO_DECIDIR`, mig `20261126003314`; **C3 🧪 2026-11-26**: «Costo contra la
  OC» en el panel de Revisión de facturas — ver abajo; falta enviar, soltar con sus 3 migraciones y medir en prod) **C0–C3 — Validar el costo al aplicar** (la mitad de D38 que no escribe en Kepler,
  §3c): por renglón, precio de la OC contra el de la factura (equivalencia del anexo P), nota de crédito
  esperada, cambio anunciado o promoción, y margen contra el precio de venta; Compras acepta, reclama o
  cambia el costo, y queda registrado quién y por qué. Base: la conciliación de Recepción (`[RE.53]`, que
  ya marca «difiere precio» entre la factura y lo capturado en Kepler) llevada a comparar contra la OC. Cierre: renglones
  aplicados a un costo distinto al de la OC con su decisión registrada, antes/después (HOY 1,680 de 9,527
  comparables en 60 días —con la escala de la ficha, §3d; la cifra de §3c era 1,239 de 9,466—, sin decisión
  registrada en ningún lado). Métrica secundaria: el cambio que se repite (HOY 61 % contra 4.7 % del placebo).
  **2026-11-26 (§3e):** reclamar = descontar con la nota; aceptar = el costo pasa a la lista y avisa a precios
  si el margen cambia. La pantalla vive en el detalle de `/compras/revision-facturas` con lo que pidió la
  prueba visual del 2026-11-25.
  **C1 🧪 2026-11-26:** la tabla `commercial.application_cost_decisions` (mig `20261126001925`, dato propio, RLS
  forzado, `app_runtime` sin DELETE) guarda **accept · claim · promotion** por renglón con la foto de lo que se vio
  (precio aplicado, precio de la OC en la misma unidad, cantidad, estado), quién y por qué (10 letras o más). Reclamar
  sólo lo que sube y nunca más que la diferencia (un centavo de holgura); promoción con fecha de fin; una decisión viva
  por renglón y cambiarla es reemplazarla, no borrarla. El dominio (`libs/commercial/src/lib/application-cost`) da los
  textos para la persona, la fecha de la promoción contra la de la aplicación y **«ya se aceptó antes»** (otra decisión
  viva del mismo proveedor, producto y unidad con el mismo costo, con el corte de «igual» de la vista). Prueba de base
  34/0/0 contra Postgres real como `app_runtime` y 8 mutantes en rojo; dominio 25/25. **C2:** la lista de renglones con
  su decisión y su antecedente, y guardar la decisión (regla 13: probada contra base real con el payload de la pantalla).
  **C2 🧪 2026-11-26:** `GET compras/costo-aplicado/aplicaciones/:sucursal/:folio` (ver entradas o decidir) da los
  renglones de una aplicación con su cadena —**el folio de su orden de entrada**, el vale y la OC—, el precio de la OC en la
  unidad de la aplicación y tal cual, lo más que se puede reclamar, la decisión viva y «ya se aceptó antes» (25 ms por
  aplicación en prod). `POST compras/costo-aplicado/decisiones` (sólo `COMPRAS_COSTO_DECIDIR`, DR10) guarda la decisión con
  la foto que lee de la vista, nunca la que mande la pantalla; reemplaza la viva en la misma transacción y, si dos personas
  deciden a la vez, la segunda recibe 409. Alcance por sucursal igual que Revisión de facturas. Pruebas: 9 contra Postgres
  real con el payload de la pantalla (`application-cost.servicio-real.spec.ts`, local: no está en el CI, como
  `box-labels`) y 5 mutantes del servicio en rojo; arranque por metadata (10) y `design:paramtypes` leído del build igual
  que el Calendario en prod. La clave se reparte con la mig `20261126003314` (sólo datos: a mano, después de la tabla) y
  esas 10 personas vuelven a entrar.
  **C3 — la pantalla, por escrito antes de dibujarla (`diseno` §0b, 2026-11-26).** La frase: *«¿esta aplicación se
  aplicó al costo de su OC?»*. Va como sección «Costo contra la OC» dentro del panel de Revisión de facturas (la
  lista se cargó 12,600 veces en 30 días), arriba de los renglones de Kepler, porque es lo que Compras decide.
  (1) **Qué ve primero:** el veredicto en una línea —«N de M renglones a otro costo que su OC», cuánto sube, cuánto
  baja y cuántos faltan por decidir— y debajo SÓLO los renglones que difieren, el que más pesos mueve primero; si
  todo está al costo de la OC, una línea y nada más. Jerarquía: primario el veredicto; secundario cada renglón con su
  diferencia y su decisión; terciario la cadena y el factor de caja. (2) **Qué no ve:** los renglones iguales (se
  cuentan, no se pintan: ya están en la tabla de Kepler); botones donde no hay nada que decidir; color sin palabra
  («Sube»/«Baja» con flecha). (3) **Accesibilidad:** cada renglón dice producto, cantidad, costo aplicado, costo de
  la OC en la misma unidad (y la OC tal cual si venía en caja), diferencia en % y en pesos, y la decisión con quién,
  cuándo y por qué, sin `title`. Decidir se hace en el mismo renglón (sin ventana encima), con teclado, y si hay
  antecedente «Aceptar igual que antes» deja el motivo escrito. (4) **Ligas:** la cadena OC → vale → orden de
  entrada → aplicación con sus folios (el de la orden de entrada faltaba, AUD-UI.3) y el panel se llama
  «Aplicación». (5) **¿Le toca?:** sí: aquí se valida la factura de esa misma aplicación. Ver lo ve quien ve la
  pantalla; decidir, sólo `COMPRAS_COSTO_DECIDIR`. Sin la clave, la decisión se lee pero no hay botón. Lo tecleado
  y no guardado frena el cierre del panel («¿Descartar…?», `sucio` del panel). De paso: la tarjeta «Por revisar» del
  resumen pasa a decir lo que cuenta, «No cuadra el importe» (AUD-DAT.35).
  **C3 🧪 2026-11-26:** `costo-aplicado.component.ts` (pieza en `compras/components/`, no pantalla) dentro del panel,
  antes de los productos; el panel se llama «Aplicación» y pregunta antes de cerrarse si hay una decisión tecleada. Las
  reglas puras (tope del reclamo, textos, «ya se aceptó antes») pasaron al contrato para que la pantalla y la API usen
  las mismas. **Prueba visual de nivel A, 73 de 73** (escritorio, Fold 7, celular y escritorio oscuro) contra la API y la
  vista locales sobre Docker con la aplicación real 01/0000872 copiada de prod (sólo lectura; control: la vista local da
  lo mismo que prod en los 4 renglones): veredicto «4 de 4 a otro costo · 1 sube +$210.87 · 3 bajan −$2,654.32»,
  orden por pesos, «Orden de entrada 0000894», la OC en caja dicha («$1,357.14 por 30»), contraste ≥ 4.5 con su control,
  44 px al dedo, apilado con rótulo en el celular, nada se sale; el proceso: reclamar con el tope prellenado, doble clic =
  un POST, la foto en la base, «¿Descartar…?», promoción con fecha, sobrevive a recargar y un 409 se dice y recarga.
  Encontró y se arregló: botones de 28 px al dedo (→ `comm-actions`) y la tabla sin `dt-scope` (no se apilaba).
  **NO MEDIDO:** la vista sin la clave (sólo lectura) en pantalla viva —lo cubre la regla `puedeDecidir` y el 403 de la
  API—, Alto Contraste de Windows y lector de pantalla.
  **Revisión independiente del PR (2026-11-26):** un agente revisó el código sin ver mis conclusiones. Se arreglaron (1)
  la decisión tecleada se tiraba sin preguntar por «Cerrar» del pie, «Siguiente», «Agregar otra remisión», lo que sigue a
  validar o devolver y al cambiar de renglón → todos preguntan, y los demás renglones no deciden mientras hay algo escrito;
  (2) «Los 0 renglones se aplicaron al costo» en verde cuando nada era comparable → «Ningún renglón se pudo comparar»;
  (3) «Aceptar igual» volvía permanente una promoción → «Promoción igual», con su misma fecha; (4) un motivo de emoji,
  una cantidad en cero o un reclamo de 0.004 daban 500 → las reglas cuentan como la base (letras por carácter, cantidad y
  precios como se guardan) y un CHECK rechazado es 400; (5) los textos de lo no comparable nombran su causa (sin OC o
  cadena rota, precio en cero, sin factor, dos factores). Prueba visual de nuevo: **79/79**, con la negativa del «Cerrar»
  (mutado, cierra sin preguntar y la prueba lo caza). Se declaran, sin cambio: el factor de la ficha puede tapar un
  cambio real cuando la cantidad no lo confirma (162 de 1,236 escalados sin ese testigo; candidato a un estado propio) y
  la lectura por sucursal y folio sin subtipo (la misma llave que el resto de la pantalla).
- **`[PQ.158]`** ⬜ **C0–C3 — La OC sale al proveedor en sus palabras** (§3e): el papel y el archivo de la OC
  (`[OC.3]`) llevan su código, su descripción de factura y su unidad, en el orden en que él factura; nuestra
  descripción se queda por dentro. Depende de `[PQ.148]` (#624). C0: cuántos renglones de OC tienen ya
  equivalencia (HOY **NO MEDIDO**; los códigos con SKU son 1,899 de 2,797). Cierre: renglones de OC enviados
  con el código del proveedor, y renglones de su factura que casan con la OC por código, antes y después.
- **`[PQ.159]`** ⬜ DR8 — **C0–C3 — La orden de entrada valida piezas y peso** (§3e): el Andén pesa la
  presentación y la compara con su peso estándar; lote y caducidad ya los captura. C0: Kepler no guarda peso
  por producto, así que primero la fuente (DR8) y por qué el Andén no se usa (PQ.112.3: 0 sesiones en
  noviembre contra 875 aplicaciones). Cierre: recepciones con piezas y peso validados, antes y después en la
  piloto (DR4).

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
| 2026-11-26 | **`[PQ.157]` C3 🧪:** «Costo contra la OC» en el panel de Revisión de facturas (que ahora se llama «Aplicación» y dice el folio de su orden de entrada); decidir en el renglón, con el tope del reclamo y «ya se aceptó antes». Prueba visual en 4 corridas y el proceso entero, 73/73, contra la aplicación real 01/0000872 en Docker. De paso, «No cuadra el importe» en vez del segundo «Por revisar» (AUD-DAT.35) | Claude |
| 2026-11-26 | **`[PQ.157]` C2 🧪:** la API `compras/costo-aplicado` lee una aplicación con su cadena (incluido el folio real de su orden de entrada) y guarda la decisión con la foto de la vista; la clave `COMPRAS_COSTO_DECIDIR` sólo para Compras (DR10, Francisco). 9 pruebas contra Postgres real con el payload de la pantalla, 5 mutantes en rojo, arranque verificado en el build | Claude |
| 2026-11-26 | **`[PQ.157]` C1 🧪:** la decisión por renglón ya tiene dónde guardarse: `commercial.application_cost_decisions` (mig `20261126001925`) con accept · claim · promotion, quién y por qué, una viva por renglón y nada se borra; el dominio dice «ya se aceptó antes». Prueba de base 34/0/0 como `app_runtime`, 8 mutantes en rojo; dominio 25/25 | Claude |
| 2026-11-26 | Francisco firma **DR8 (a)** (el peso se aprende en el Andén) y **DR9 (b)** (la remisión por OCR no pasa sola hasta medir su lectura) | Francisco |
| 2026-11-26 | Francisco fija el flujo objetivo (§3e): la OC sale en las palabras de la factura del proveedor; el vale empareja por UUID (remisiones por OCR o visión) y lo que coincide al 100 % pasa solo; la orden de entrada rastrilla lote, caducidad, piezas y peso; la aplicación descuenta con nota o ajusta costos y precios. Medido: el Andén ya captura lote y caducidad pero tuvo 0 sesiones en noviembre (contra 875 aplicaciones); el peso no existe en Kepler; hoy pasan solas 739 de 2,033 entradas en revisión. Prueba visual del 2026-11-25 (tres perfiles): ninguna pantalla muestra el precio de la OC, dos «Por revisar» con cifras distintas y un panel que dice «Orden de entrada» y muestra la aplicación. Nacen `[PQ.158]`, `[PQ.159]`, DR8 y DR9 | Claude |
| 2026-11-25 | **`[PQ.157]` C0 (§3d):** la vista `commercial.v_application_line_cost` (mig `20261125214023`) encadena cada renglón de aplicación con su OC y lleva el precio de la OC a la unidad de la aplicación con el factor de la ficha (1,236 de 1,240 renglones en otra escala casan; la cantidad confirma el factor en 87 % contra 0.2 % del placebo). 60 días: 17.6 % de los renglones comparables se aplica a otro costo (+$1.17 M / −$511 mil); el cambio no se registra y se repite (61 % contra 4.7 %); el 56 % de las correcciones ya estaba en la aplicación anterior; 74 % de las aplicaciones abajo de su factura ya tiene la nota del SAT ligada (placebo 24 %). La brecha OC de la Suite contra Kepler no es general proveedor por proveedor (26 contra 28). Prueba 32/0/0 en prod, 30/0/1 sin ODS, 9 mutantes en rojo | Claude |
| 2026-11-24 | Francisco explica los tres documentos como tres momentos (§3c): **vale = la cita** (el proveedor), **orden de entrada = rastrillar en vivo** (el almacén), **aplicación = validar el costo** (Compras), y la deuda de Kepler que cierra la OC antes de tiempo. Medido: la orden de entrada no es en vivo (08: 1 min después del vale desde el papel; 00: 47 % en lotes, 90 min después); 13.1 % de los renglones se aplica a un costo distinto al de la OC (+$979 mil / −$344 mil en 60 días); 31 OC cerradas y 104 parciales con saldo ≤ 0 y productos por extraer. Nacen DR7 (el vale se escribe al confirmar la cita) y `[PQ.157]` (validar el costo sin esperar a D38) | Claude |
| 2026-11-24 | El vale se alimenta desde antes del camión: el [anexo P](FASE_PQ_ANEXO_PROVEEDOR_AVISO_DE_ENTREGA.md) (pedido de Francisco) hace que el proveedor empareje su factura con la OC; el Andén recibe por factura (`[PQ.153]`) y se escribe un vale por factura (DP6). Medido allí: 1 vale → 1 orden → 1 aplicación en Kepler, y sólo 24 % de los vales lleva el folio de su factura | Claude |
| 2026-11-24 | Francisco: «avanzamos a terminar el proceso desde la Suite: vale, orden de entrada y aplicación». **§3b, el testigo en el ODS:** cómo convierte Kepler OC → vale → orden → aplicación columna por columna, con qué estado nace cada uno y qué le hace a su padre; las 42 columnas del kardex salen del renglón salvo `c17` (existencia previa), `c29` y `c30`; el costo es promedio móvil (552 contra 3) con un 7.7 % sin regla; la aplicación deja `kdxe` (311 de 311). **PQ.112.2 ✅:** Kepler no convierte unidad en ningún paso, y 1,109 de los 1,128 renglones de entrada en CJA nacen de OC escritas por la Suite: quien recibe convierte a mano (954) y el kardex se queda con «CJA». Nacen DR5, DR6 y PQ.112.7; D38 anota que PQ.114 está ⏸️ por el PM | Claude |
| 2026-11-14 | Anexo R: análisis de la secuencia requisición → OC → vale → orden de entrada → aplicación a pedido de Francisco (captura de `MD_OE.kpl`). Medido en 30 días: 35.3 recepciones por día y 3 capturas por recepción; las ligas vale → orden y orden → aplicación pasan su placebo (99.8 % y 99.7 % contra 24.7 % y 24.2 %); sólo la orden de entrada mueve kardex; la orden corrige al vale en 5.3 % de los renglones (cantidad) y 10 % (precio); nueve rótulos de unidad; el Andén lleva 0 sesiones en 30 días y escribe existencia propia. Propuesta: el acto en el Andén, en dos escalones (vale, luego orden de entrada); la aplicación sigue en Kepler. Nacen PQ.112.1–PQ.112.6 y DR1–DR4, sin firma | Claude |
