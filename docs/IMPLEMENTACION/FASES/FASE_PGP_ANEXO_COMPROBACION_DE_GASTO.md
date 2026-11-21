<!-- INDICE-AUTO:INICIO -->

> **Índice navegable** — 79 KB, 906 líneas, 16 secciones.
> ⛔ **No intentes leer este archivo entero: no cabe en una ventana de contexto.**
> Buscá tu tema acá y leé sólo ese tramo: `sed -n 'DESDE,HASTAp' docs/IMPLEMENTACION/FASES/FASE_PGP_ANEXO_COMPROBACION_DE_GASTO.md`.
> Lo genera `npm run docs:indices` — no lo edites a mano.

| Desde | Hasta | KB | Sección |
|---:|---:|---:|---|
| 28 | 64 | 3 | Fase PGP · Anexo G — La comprobación del gasto (X-A-10) se escribe desde la Suite |
| 65 | 74 | 1 | 1. El pedido, literal |
| 75 | 114 | 3 | 2. Qué es comprobar hoy (medido) |
| 115 | 275 | 11 | 3. Qué escribe un X-A-10 dentro de Kepler (las 9 escrituras) |
| 276 | 292 | 1 | 4. Lo que Kepler no cuida y la Suite sí |
| 293 | 390 | 6 | 5. El diseño |
| 391 | 410 | 1 | 6. Alcance v1 y lo que no entra |
| 411 | 417 | 1 | 7. El orden de construcción, de abajo hacia arriba |
| 418 | 437 | 2 | 8. Plan por capas (`[PGP.123]`) |
| 438 | 450 | 1 | 9. Pruebas (cada compuerta con su prueba negativa) |
| 451 | 475 | 5 | 10. Decisiones |
| 476 | 498 | 1 | 11. Riesgos y NO MEDIDO |
| 499 | 511 | 1 | 12. Hallazgos fuera de alcance, con su dueño |
| 512 | 552 | 10 | 13. Construcción — lo que ya está y lo que es de Edgar |
| 553 | 901 | 31 | 14. La interfaz de la comprobación — prueba visual (2026-11-15) |
| 902 | 934 | 3 | 15. El primer gasto escrito por la Suite (2026-11-20) |

<!-- INDICE-AUTO:FIN -->
# Fase PGP · Anexo G — La comprobación del gasto (X-A-10) se escribe desde la Suite

> Anexo de [`FASE_PGP_PAGO_A_PROVEEDOR.md`](FASE_PGP_PAGO_A_PROVEEDOR.md). Es la pieza que el
> [Anexo S](FASE_PGP_ANEXO_SOLICITUD_DE_GASTO.md) dejó para después en su §8: «el escritor del X-A-10, que
> es el cuello real». Item **`[PGP.123]`** con sub-items `G.1`–`G.12` (§8). Decisiones **DG1–DG10** (§10).
> Lo pidió Francisco el 2026-11-15. Las cifras son de prod en sólo lectura del 2026-11-15. Las midieron cinco
> frentes independientes (el gasto, la póliza, el CFDI, la Suite y el proceso); la numeración de la póliza
> (§3.6) la re-midió Claude. Donde dos frentes discrepan, se dice.

```
OBJETIVO: que un gasto autorizado se compruebe en Kepler SIN volver a teclearlo: la Suite escribe su
          X-A-10 («Alta gasto CFDI») con la póliza, la cuenta por pagar y los acumulados que deja hoy
          una persona, y la persona sólo valida.
MÉTRICA:  HOY (oct–nov 2026):
          · X-A-10 escritos por la Suite: 0 de 2,054 (todos se teclean en Kepler);
          · 2,010 de 2,054 (97.9 %) son COPIA EXACTA de su X-A-15: se teclea dos veces lo mismo;
          · firma del vale → X-A-10: mediana 14.2 h, p90 46 h (Anexo S §3.2); de los vales firmados del 7
            al 11-nov, sólo el 59.6 % tenía su X-A-10 a las 24 h;
          · cola real: 128 X-A-15 autorizadas (A) con el vale firmado y sin X-A-10, por $1.26 M. Con la
            regla de G.5, el 15-nov: 106 vales listos para comprobarse solos ($1.21 M) — 14 en
            02/04/05/07 y 92 en los cinco servidores de dos secuencias (00: 44), que esperan a DG7.
          MÉTRICA PRINCIPAL: X-A-10 de vales en etapa «autorizado» que escribió la Suite / X-A-10 de esos
          vales, 30 días, por sucursal piloto. HOY: 0 %. → META (a firmar, DG10): ≥ 80 % a 30 días.
          MÉTRICA DE TIEMPO: autorizado → ejercido (GX.39). HOY: p50 14.2 h. → META: minutos.
PRINCIPIO: la Suite LLENA y la persona VALIDA (Francisco, 2026-11-14). Kepler ya decidió casi todo en
          la X-A-15: comprobar no pide capturar, pide confirmar el comprobante y la fecha.
CAPA TOPE: C3 en las pantallas que ya existen (Mis gastos, Aprobación, el expediente); cero rutas nuevas.
ÁREA:      Finanzas (Tesorería, quien hoy teclea) · Contabilidad (fecha y cuentas de la póliza)
DUEÑO:     a firmar (DG10)
ESTADO:    🔨 — no abre fase: es parte de PGP (O9, «que un gasto se capture UNA vez»). La sombra
           (G.2) y el armador (G.3–G.5) no escriben en Kepler y se pueden empezar sin decidir nada.
           🧪 2026-11-15: sombra, armador y primitivas contables (§13): póliza idéntica a la de Kepler en
           1,731 de 1,731 gastos copiados.
           Encomienda de Edgar a Francisco (2026-11-14): se construye hasta escribir en Kepler, y Edgar
           hace la configuración final de cada servidor (§13).
```

## 1. El pedido, literal

> «una vez terminado el pr y la bandeja de factura sat, empiezas a trabajar en la comprobación de gastos
> imagen 1, la imagen 2 es la consulta de un gasto comprobado, este movimiento deja póliza contable, para
> que tengas en cuenta estos detalles, seguimos con la automatización para mudar este módulo a la suite,
> siguiendo el esquema de trabajo que llevamos avanzado» — Francisco, 2026-11-15.

La imagen 1 es la pantalla de Kepler «Alta gasto CFDI» (el X-A-10, con una cuadrícula Clave UUID /
RutaXml / Monto). La imagen 2 es la consulta de un gasto ya comprobado, con su póliza.

## 2. Qué es comprobar hoy (medido)

**Comprobar en Kepler es, en lo contable, volver a teclear la solicitud.** Desde el corte (1-oct al
14-nov), 2,010 de 2,054 X-A-10 vivos (97.9 %) son copia exacta de su X-A-15: mismo acreedor, total
(±$1), IVA, retención y renglones. La persona sólo cambia tres cosas:

| Lo que cambia | Cuántas veces | Qué decide |
|---|---:|---|
| la fecha `c9` | 49 % | ⭐ el MES de la póliza y de los acumulados |
| la forma de pago `c90` | 65 % | casi siempre al `01` que Kepler pone solo (96 % de las que venían vacías) |
| la fecha de pago `c18` | 5 % | el vencimiento de la cuenta por pagar, que lee el Calendario |

- **Quién:** la misma persona que capturó la solicitud, en el 91.1 % (placebo: 32.0 %). En 00, un solo
  usuario captura el 48.9 % de los X-A-10, y el 25.7 % se hace en rachas de 10 o más seguidos.
- **Cuándo:** de la X-A-15 a su X-A-10, mediana 22 h y p90 75 h.
- **Cobertura:** de 2,173 X-A-15 vivas desde el corte, 1,911 (87.9 %) ya tienen X-A-10. Faltan 262
  ($1.76 M): **128 en A con el vale firmado ($1.26 M)**, que son la cola real (99 firmadas hace 3 días o
  menos), y 103 sin vale ($437 k; 70 de más de 30 días), que son abandono y van aparte.
- **No hay comprobaciones parciales:** ninguna de 10,944 solicitudes tiene varios gastos que sumen su
  total. Sí hay lo que Kepler deja pasar (§4): 4 duplicados, 21 gastos por más que su solicitud, 46 por
  menos y 42 gastos vivos sobre una solicitud cancelada ($159,749.54).

**Factura contra ticket** (frente proceso, oct–nov). Por comprobante: 512 X-A-10 casan uno a uno con una
factura del SAT (24.9 %, $1.95 M; el placebo casa 25), 773 no llevan factura por su naturaleza (37.6 %), 536
son de acreedores cuyo RFC no casa con el SAT (26.1 %, tickets probables) y 233 tienen RFC y su factura no
apareció (11.3 %). De las casadas, el total cuadra al centavo en el 95.1 % y la factura ya estaba en la Suite
al comprobar en el 91.2 %. Por lo que tendría que hacer la persona:

| Nivel | Qué es | Parte | Qué hace la persona con la Suite |
|---|---|---:|---|
| A | la factura casa y cuadra al centavo | 24.6 % | nada: la firma del vale ya validó |
| B | no lleva factura: comisiones bancarias, nómina, préstamos, no fiscales, tarjetas | 36.7 % | nada (y casi todo queda fuera del alcance v1 del Anexo S) |
| C | sin factura que case: ticket, o la factura no ha llegado | 36.6 % | el ticket del vale basta; si la factura llega después, se liga en la Suite (G.9) |
| D | retenciones y gastos distintos de su solicitud | 2.1 % | se quedan en Kepler en v1 |

⭐ **La Suite ya tiene el vocabulario** (`ejercicio.contract.ts`, GX.39/GX.43): la etapa de un vale después
de la firma es `por_ejercer → autorizado → ejercido`, y «ejercido» es justamente «Kepler ya tiene el
X-A-10». Comprobar desde la Suite = **pasar de `autorizado` a `ejercido` escribiendo el X-A-10**. No hace
falta otra máquina de estados (ADR-056).

## 3. Qué escribe un X-A-10 dentro de Kepler (las 9 escrituras)

Universo de los frentes «gasto» y «póliza»: 1,970 X-A-10 con fecha desde el 1-oct (1,922 vivos en `N`, 48
cancelados en `C`). El 100 % apunta a una solicitud A-15-1 (`c36`/`c37`/`c38`, folio en `c39`).

| # | Tabla | Qué | Cobertura medida |
|---|---|---|---|
| 1 | `kdm1` INSERT | el gasto, en `N` | 1,922 de 1,922 |
| 2 | `kdm6` INSERT × n | los renglones de la solicitud, copiados | 4,563 de 4,566 renglones idénticos |
| 3 | `kdm1` UPDATE de su X-A-15 | `c42 −= total` y `c43 → F` | `c42` 1,808 de 1,808 · `F` 1,775 de 1,808 |
| 4 | `sqliov` UPDATE | el contador `KFXA1001.NN` | = MAX(folio)+1 en 9 de 9 servidores |
| 5 | `kdxe` INSERT | la cuenta por pagar `A` que después salda el X-D-26 | 1,922 de 1,922 |
| 6 | `kdc2AAMM` INSERT | la póliza **D** en la tabla del mes de `c9` | 1,918 de 1,922 |
| 7 | `kdc126` UPDATE | cargos y abonos del mes por cuenta y su mayor, dos juegos | 465 de 465 cuentas |
| 8 | `kdcn26` UPSERT | el ejercido por centro de costo (concepto × depto × proyecto × mes) | 1,421 de 1,421 celdas |
| 9 | `kdxg` UPDATE | los cargos del mes del acreedor | 249 de 249 (oct) |

No toca `kdm2`, `kdm5` ni `kdxf` (las aplicaciones las escribe el pago). Además hay una tabla que el ODS no
deja ver: dónde guarda la cuadrícula del UUID (§3.10).

### 3.1 `kdm1`: 23 columnas varían, 15 se copian de la solicitud

De 200 columnas sólo varían 23. Constantes con valor: `c2=X c3=A c4=10 c5=1 c7=PESOS c31=Gas c36=A c37=15
c38=1 c40=1 c43=N c63=XA1001-`; `c41` vale `2000-01-01` (en la solicitud, `1800-01-01`); las otras 164,
vacías.

| Columnas | Regla | Medido (de 1,922) |
|---|---|---|
| `c1 c10 c15 c17 c25 c26 c32` | se copian | 100 % |
| `c22 c30 c48` | se copian | 1,921 |
| `c24` · `c11` · `c14` · `c16` · `c18` | se copian | 99.7 % · 99.6 % · 98.5 % · 98.4 % · 96.6 % |
| `c90` | se copia si la solicitud la trae (83.2 %); si viene vacía, Kepler pone `01` (96.0 %) | 90.4 % con la regla combinada |
| `c6` folio · `c39` folio de la solicitud | propias | — |
| `c42` saldo | = `c16`, y **no baja con el pago** (el saldo vivo está en `kdxe.c20`) | 1,922 de 1,922 |
| `c9` fecha | el día de captura (68.4 %) o la fecha de la solicitud (48.5 %); una de las dos en 96.6 % | DG1 |
| `c67 c68 c69` | quién y cuándo | — |

- **Retenciones:** viven en `c15`. Un solo caso en 11,356 X-A-10 (ISR RESICO de $39.75, a la `122-003`). De
  IVA retenido, ninguno. `c81`/`c82`/`c84` están vacías: son del pago.
- **Identidad:** `c16 = Σ kdm6.c11 + c14 − c15` en 1,909 de 1,922; las 13 que fallan son gastos sin
  renglones en el ODS o con renglones incompletos.
- ⚠️ **Marcas heredadas:** el X-A-10 copia `c26` (100 %) y `c67` (90.8 %) de su solicitud. Un X-A-10
  capturado a mano sobre una solicitud de la Suite dirá `SUITE SG-…` y `SUITE`. Toda lectura de «lo escribió
  la Suite» filtra por tipo (`c4=10`), y la idempotencia va por `(c4=10, c39)`, no por la marca.

### 3.2 `kdm6`: copia de la solicitud

1,902 de 1,922 gastos traen el mismo número de renglones; de los 4,566 emparejados por `c7`, 4,563 son
idénticos en concepto, cuenta, proyecto, departamento e importe. `c10='C'`, `c14`/`c15` vacías, `c17`/`c18`
en 0. Diez gastos no traen renglones en el ODS (sí su póliza): el testigo del lazo es la póliza, no `kdm6`.

### 3.3 La X-A-15 al crearse el gasto (no al pagarlo)

Su saldo `c42` baja por el importe del gasto (10,900 de 10,944 en todo el ODS) y pasa a `F` (98.0 %). Entre
32 y 35 (según el frente) quedaron en `A` con saldo 0 sin que nadie de la Suite las tocara (NO MEDIDO por qué). Una solicitud sin
gasto tiene `c42 = c16` (136 de 139 en `A`).

### 3.4 `kdxe`: la cuenta por pagar

`c3='A' c4=10 c5=1`; `c7 = c9`, `c9 = c17` (plazo), `c10 = c18` (vencimiento), `c11 = c17 = total`, `c13`
IVA, `c14` retención, `c16` referencia, `c8 PESOS`, `c28 'X'`, `c29 'A'`. Saldo `c20 = c11 − Σ pagos vivos`
en 1,922 de 1,922. Lo saldan el X-D-26 (3,693 aplicaciones a 1,641 gastos), el X-D-25 (68) y el X-D-55 (4).

### 3.5 La póliza D: renglones y cuentas

La X-A-15 no deja póliza (0 renglones en las 12 tablas de 2026). El X-A-10 deja **una póliza de Diario**
en la tabla del mes de `c9`, con esa misma fecha (los 42 gastos capturados al mes siguiente fueron a la
tabla del mes de `c9`). El tipo y las cuentas salen del catálogo de documentos `kdmm` (`c18` tipo, `c20`
acreedor, `c21` IVA, `c22` retención), comprobado en 158 de 158 combinaciones servidor × documento:

1. **abono** a `kdmm.c20` por el total: `203` en 00 (725 de 725) y `201` en 01–08 (1,193 de 1,193);
2. **cargo** a `122-001` IVA acreditable por `c14`, si hay (547 de 547). No existe IVA pendiente: el pago
   no mueve el IVA;
3. **abono** a `122-003` por la retención (un caso en 2026; las `209` de retenciones existen y no se usan);
4. un **cargo por renglón** de `kdm6`: `c3` = cuenta, `c6` = texto, `c13` = departamento, `c20` =
   concepto, `c21` = proyecto (4,550 de 4,552).

En todos los renglones: `c7 = kdm1.c11` (7,033 de 7,033), `c23 = primera letra de c7` (7,189 de 7,189;
⚠️ en el pago es `'0'`: no se clona un renglón de X-D-26), `c9 = c5`, `c14` = sucursal, `c15`–`c19` el
documento, `c31 = 1800-01-01`. En los renglones 1–3, `c6 = left(kdm1.c32, 40)`.

**Cuadra en 1,909 de 1,918.** Las 9 descuadradas ($4,023.96) traen un concepto sin cuenta y Kepler omite ese
cargo (`VAL_POL_DES=N`): la Suite rechaza en vez de copiar el defecto.

### 3.6 ⭐ El número de la póliza D: dos secuencias, y una no se ve (re-medido por Claude)

Los frentes «póliza» y «Suite» discreparon (uno midió «MAX+1 del mes»; el otro, «no es MAX+1 por mes»). Se
re-midió en `kdc22609`–`kdc22611`:

| Servidores | Cómo numera Kepler la D |
|---|---|
| **02, 04, 05, 07** | **una secuencia por mes**: de 1 a N, sin huecos, en septiembre, octubre y noviembre |
| **00, 01, 03, 06, 08** | **dos**: los primeros días del mes empieza en 1; en **un solo instante** (00: 5-nov 16:00; 01: 5-nov 07:44, por la hora de captura del X-A-10) salta a una secuencia **corrida** que continúa la del mes anterior. Desde ahí numera también lo retro-fechado al mes anterior (la 00 saltó a 31,089, menor que el máximo de octubre, 31,091) |

Ejemplo, 00 en noviembre: 692 pólizas D con números del 1 al 31,561. La secuencia corrida implica un
**contador** que el ODS no trae. No depende del tipo de documento (los 18 que usan la D aparecen en las dos)
ni del usuario.

**Consecuencia:** «MAX+1 de la tabla del mes» reproduce a Kepler en 02/04/05/07. En 00/01/03/06/08 coincide
casi siempre, pero el contador escondido podría repetir un número que la Suite ya usó (por ejemplo, con un
documento retro-fechado). **El escritor no se enciende en esos cinco servidores hasta que G.1 encuentre el
contador** (DG7). El canario en 05 no lo prueba: su secuencia es la simple.

> ✅ **Re-medido el 2026-11-20 (G.1): no hay contador.** Las 9 bases numeran la póliza D como **MAX+1 de la tabla del
> mes**. En orden de captura (`kdm1.c68`/`c69`), en 00, 01, 03, 06 y 08 y en octubre y noviembre, el 98 % de las pólizas
> D es exactamente «el máximo del mes + 1»; las que no, tienen el hueco ocupado por pólizas sin hora de captura. La
> «segunda secuencia» la abre **siempre un X-D-55**, que deja su póliza en el mes nuevo con el número del mes anterior
> (00: X-D-55-0001491 el 5-nov 15:58 con 31,088; 01: X-D-55-0000127 el 4-nov con 4,146; 08: X-D-55-0000092 el 4-nov con
> 2,504, en las tablas de octubre y de noviembre); desde ahí MAX+1 sigue esa serie. La medición pasiva lo confirmó en
> vivo: once pólizas D seguidas en 01, cada una el máximo + 1, sin ninguna tabla que se moviera una vez por póliza
> fuera del folio del documento. **DG7 se retira**: el escritor escribe en las 9.

### 3.7 Los acumulados

- **`kdc126`** (por cuenta): cargos del mes en `c(26+m)` y `c(50+m)`, abonos en `c(62+m)` y `c(74+m)`. Primer
  juego = Σ de los renglones del mes, 465 de 465. Segundo juego: **excluye sólo X-D-55 y pólizas manuales
  con `c23` vacío** (426 de 429 en octubre, 333 de 333 en noviembre). ⚠️ La regla escrita en PGP §4 y en el
  comentario de `kepler-contable.ts` («excluye todo `c23` vacío») acierta 259 de 429: aplicada al pie de la
  letra dejaría fuera 1,162 de 7,189 renglones de X-A-10 (los de referencia vacía). El X-A-10 va a los dos
  juegos (117 de 117 cuentas). El mayor = Σ de sus subcuentas (280 de 293; fallan la 102 y la 114). Si la
  cuenta no existe, Kepler la crea («Cta creada en …», 18 filas): **la Suite rechaza**.
- **`kdcn26`** (ejercido por centro de costo): llave (`c1` concepto, `c2` departamento, `c3` proyecto, `c4`
  `AAMM`), `c7 = Σ(cargo − abono)`, con sumas `'*'` y los **departamentos padre que existen en `kdc3`** (194
  de 194; 0 de 3,238 cuando el padre no existe). El abono y el IVA, sin segmentos, van a las 4 celdas `('',
  ''|'*', ''|'*')` con el mismo importe (medido en 00, 05 y 07). Un frente sin los padres cuadró 83–85 %; con
  ellos, **la sombra (G.2) lo confirmó con todas las pólizas del mes: 2,824 de 2,824 celdas en octubre y 1,718
  de 1,718 en noviembre**. 296 celdas de Kepler no salen de pólizas (conceptos de 2 dígitos, las filas del año;
  NO MEDIDO de dónde) y ninguna derivada falta. `c5` está vacío y `c8` en 0 en los 9 servidores; `c6` sólo trae
  algo en 14 filas de 00: una celda nueva nace con `c5=''`, `c6=0`, `c8=0`.
  Hoy **ningún escritor de la Suite toca `kdcn26`**: si el gasto se escribe sin él, el presupuesto de Kepler
  deja de ver ese gasto.
- **`kdxg`** (por acreedor, llave `PESOS`, sucursal, acreedor): cargos del mes en `c(46+m)` = Σ `kdxe.c11` del
  mes (249 de 249 en octubre); `c4` = último movimiento, `c6` = último cargo. `c5` no se deriva (igual que en
  PGP.106): no se toca. La 02 acumula también documentos de la 03 (14 combinaciones; NO MEDIDO por qué).

### 3.8 El folio

`sqliov` `KFXA1001.NN` = folio más alto + 1 en 9 de 9 servidores, sin un hueco en 11,356 folios. Se usa
`reservarFolioKepler({X, A, 10, 1})` de `kepler-folio.ts`, ya probado en PGP.122.

### 3.9 La cancelación (sólo el resultado)

47 de 48 canceladas conservan su póliza con `c5 = c9 = 0`, `c19` vacío y `c6 = 'BAJA - XA10001-<folio>'`;
`kdxe` queda en 0; `kdm6` conserva los importes; la solicitud recupera su saldo. NO MEDIDO: qué revierte en
`kdc126`, `kdxg` y `kdcn26`. **v1 no cancela desde la Suite**; el lazo se entera de la `C` (§5.4).

### 3.10 El CFDI dentro de Kepler: hoy en ninguna tabla

- La cuadrícula Clave UUID / RutaXml / Monto sólo cabe, por estructura, en `md.kdfecfdcom` (misma llave que
  `kdm6` + UUID, monto, RFC, fecha y rutas); su pareja contable sería `md.kdcecfdpol` (UUID por póliza).
  **Ninguna ha tenido una fila en las 9 sucursales**: el espejo del ODS crea la tabla con su primera fila y
  no existe. «Forza XML de Compras» está apagado en 9 de 9.
- En la práctica, la gente teclea la cola del UUID o el folio en `c11`: el 41.1 % de los X-A-10 casados con
  su factura (placebo 0.3 %), que bajó a 21.7 % tras el corte.
- La liga UUID ↔ póliza vive en **ContPAQi**: ya asocia el 96.5 % de esas facturas (ADR-040).
- Sólo el 26.3 % de los X-A-10 de ene–oct tiene su factura en `fiscal.cfdis` (techo ~31 %): el 61 % (76 % del
  importe) es de acreedores sin RFC en Kepler (nómina, bancos, gastos generales).

**Entonces la Suite es el registro del CFDI del gasto** (`expense_proofs.cfdi_uuid`, PGP.122): el X-A-10 no
espera a Kepler para tener comprobante. Qué escribe Kepler cuando sí se carga un XML lo dice G.1.

## 4. Lo que Kepler no cuida y la Suite sí

Kepler no valida al grabar (`MODO_AUT=0`, `LIM_PRVC=0`, `VAL_POL_DES=N`) y no tiene disparadores en `md`:

| Kepler hoy deja | Medido | Candado de la Suite (fail-closed) |
|---|---|---|
| dos gastos sobre la misma solicitud | 4 (+$4,444.25) | un X-A-10 vivo por X-A-15, re-leído en el Kepler vivo dentro de la transacción, por `(c4=10, c39)` |
| un gasto por más que la solicitud | 21 (+$17,446.51) | total del gasto = `c42` de la solicitud, al centavo |
| un gasto vivo sobre una solicitud cancelada | 42 ($159,749.54) | la solicitud tiene que estar en `A`, con `c42 = c16` |
| una póliza descuadrada | 9 ($4,023.96) | concepto sin cuenta en `kdco` (leído en vivo) → no se escribe; la póliza cuadra al centavo antes del COMMIT |
| crear una cuenta que no existe | 18 filas | cuenta ausente en `kdc126` → no se escribe |
| retenciones mal asentadas | 3 de 4 CFDI RESICO sin `c15`; 2 pagados por el bruto (+$142.49) | v1 rechaza CFDI con retención (DS18) |
| una póliza en un mes ya revisado | 42 gastos de noviembre con fecha de octubre | DG1 |

Y los de la Suite: un vale rechazado no se comprueba (hoy 9 vales rechazados tienen X-A-10 vivo); una
solicitud cancelada no se comprueba (40 validados la tienen en `C`); cada UPDATE exige `rowCount = 1`.

## 5. El diseño

### 5.1 Cuándo se escribe (DG8, DG9)

Al validar el vale y no después. La regla es pura (`comprobacion.contract.ts`, G.5) y devuelve «listo» o el
primer motivo. Se escribe cuando se cumple todo esto:

1. el vale está **`validada`**: el expediente de la Suite se cerró y la pelota está del lado de Kepler (GX.39).
   Al firmar, un vale con evidencia se cierra directo en `validada`; uno sin evidencia o marcado «provisional»
   se queda en `aprobada` hasta que llegue el comprobante (GX.56). En Kepler, la misma persona que capturó la
   solicitud captura el gasto en el 91.1 %;
2. su X-A-15 está **viva en `A`**, con `c42 = c16` y sin X-A-10 vivo, re-leída en el Kepler vivo;
3. el **total del vale = `c16` de la X-A-15**, al centavo (si difieren, la persona comprobó otra cosa: nivel
   D, se queda en Kepler);
4. el **comprobante** es el que la Suite ya aceptó al validar (CFDI, ticket, o lo que pida su clasificación;
   el nivel B no lleva factura). Si el vale trae un CFDI ligado (`cfdi_uuid` en `fiscal.cfdis`), su total casa
   con la solicitud al centavo y su RFC con el del acreedor (`rfcCompatible`, la regla de PGP.122);
5. sin retención (`c15 = 0` y el CFDI sin retenidos);
6. **la fecha** cae en un mes permitido (DG1) y el servidor tiene permiso sobre su tabla `kdc2AAMM`;
7. el **interruptor** de la sucursal está encendido y el tope del día no se pasó.

⭐ **DG9 — también los vales que no nacieron en la Suite.** El vale de hoy ya está ligado a su X-A-15 por
`folio_solicitud`, así que la cola real (128 en `A` con el vale firmado, $1.26 M) se puede comprobar sin
esperar a que se encienda PGP.122. El X-A-10 es un clon de la X-A-15 viva: el vale sólo aporta el disparo y
el comprobante.

### 5.2 El armador (C1, funciones puras)

**Clona la X-A-15 viva**, no una plantilla: 15 de las 23 columnas ya traen lo correcto en ≥ 96.6 %. Pisa
sólo esto:

- las constantes: `c4=10`, `c31='Gas'`, `c36='A'`, `c37=15`, `c38=1`, `c41='2000-01-01'`, `c43='N'`, `c63='XA1001-'`;
- lo propio: `c6` (el contador), `c39` (folio de la solicitud), `c42 = c16`, `c9` (DG1), `c67='SUITE'`, `c68`/`c69` en hora de México;
- `c90` (DG3).

Además arma:

- `kdm6`: los renglones de la solicitud con `c4=10` y el folio nuevo;
- `kdxe` (§3.4);
- la póliza (§3.5), con las cuentas de `kdmm` del servidor;
- los deltas de `kdc126`, `kdcn26` y `kdxg` (§3.7);
- el UPDATE de la X-A-15.

**Un solo armador de gasto (ADR-056).** `comisiones-kepler.armador.ts` (CB.62) ya arma un X-A-10 con su
póliza D, pero con constantes de comisiones (611-003, concepto 199, acreedor `GB…`), sin `c23`, `c14` ni
`c15`–`c19` en la póliza y sin los acumulados. Se extrae a `gasto-kepler.armador.ts` y CB.62 lo consume
(deuda con nombre mientras no).

`kepler-contable.ts` gana `polizaDeGasto()`, `columnaCargoKdxg(mes) = c(46+mes)` y los deltas de `kdcn26`
con padres de `kdc3`. Además se corrige su comentario del segundo juego de `kdc126` (§3.7).

### 5.3 El escritor (C2)

Es el esqueleto de PGP.122 (`kepler-solicitud-gasto-sink.adapter.ts`: candados, plantilla por servidor sin
default, marca, «en duda», ensayo con ROLLBACK, interruptor y bitácora) con las piezas contables de PGP.106
(`kepler-pago-sink.adapter.ts`: tabla del mes, número revisado antes del COMMIT, `kdc126`/`kdxg` con
`rowCount = 1`). En UNA transacción:

1. **re-leer** la X-A-15 (`FOR UPDATE`), sus renglones, `kdmm`, `kdco`, `kdc126` y `kdc3`;
2. **reservar** el folio (`sqliov`, con candado de fila) y el número de póliza (DG7);
3. **insertar** `kdm1`, `kdm6`, `kdxe` y la póliza;
4. **actualizar** la X-A-15, `kdc126`, `kdcn26` y `kdxg`;
5. **revisar** antes del COMMIT, como `kepler-pago-sink.revision.ts`: folio, número, cuadre, `rowCount` y
   la X-A-15 en `F` con saldo 0.

Hasta que G.1 lo confirme, **ninguna tabla fuera de esta lista** (§3).

### 5.4 Estados, bitácora y lazo cerrado

- **En el vale**, como en PGP.122: `kepler_expense_status` (`pending → written | rejected | in_doubt`), `_at`,
  `_note`, el folio del X-A-10 y el número de su póliza.
- La bitácora `expense_request_kepler_attempts` gana el **tipo de documento** (15 / 10): no se hace otra
  tabla (ADR-056).
- **Lazo:** el X-A-10 aparece en el ODS por `(sucursal, c4=10, c39)`; si no llega en 2 h, va a `in_doubt`.
  Si Kepler lo cancela (`c43 = C`), el vale vuelve a `autorizado` y lo dice. Antes de reintentar se busca
  primero en el Kepler vivo (`ya_estaba`).
- **El interruptor:** `commercial.kepler_push_switch` con el tipo `comprobacion_gasto`, apagado, con tope 1
  por sucursal.

### 5.5 Lo que ve la persona (C3)

No hay pantalla nueva de «comprobar»: repetiría la captura, y **la cola ya existe**: es la bandeja «Esperan a
Kepler» de Aprobación de gastos (GX.96). La prueba visual del 2026-11-15 (§14) la recorrió con los vales
reales. G.9 extiende esa cola, el panel del vale y el Expediente, con las observaciones G.UI.1–G.UI.10. Las
cinco preguntas ([`ESTANDAR_DE_INTERFACES`](../../ESTANDAR_DE_INTERFACES.md)):

1. **Qué ve y en qué orden:** en Mis gastos y en Aprobación, la cadena del vale sigue en la fila (firmado →
   X-A-15 → **X-A-10 con su póliza** → pago). Lo nuevo es el eslabón X-A-10: folio, fecha, número de póliza
   y quién lo escribió (la Suite o una persona).
2. **Qué no ve:** las 9 escrituras. Se abren en el expediente, nivel 2.
3. **Accesibilidad:** «por comprobar» con su motivo en una línea («la factura todavía no llega», «el total
   del vale y el de la solicitud difieren por $X», «la solicitud se canceló en Kepler»). Cada motivo lleva a
   su arreglo con el filtro puesto (Q.4).
4. **Ligas:** el expediente toma su eslabón 4 del X-A-10 y de la factura, ya no de
   `expense_comprobaciones` (GX.8, muerta: 1 fila desde agosto, G.12).
5. **¿Le toca a esta pantalla?** Sí: es el mismo vale. El nivel C (la factura que llega después de firmar)
   se liga desde la bandeja de S.13 con «Comprobar este vale» en vez de «Registrar» (G.9).

## 6. Alcance v1 y lo que no entra

**Entra:**

- vales firmados o validados con su X-A-15 viva en `A`, total igual al centavo, sin retención, comprobante
  CFDI o ticket;
- en 02, 04, 05 y 07, mientras G.1 no resuelva la numeración de la póliza (DG7).

**No entra, con su dueño:**

| Qué | Dueño |
|---|---|
| retenciones | Contabilidad (`122-003` contra `209-003`) |
| gasto distinto de su solicitud (21 por más, 46 por menos) | la sucursal, en Kepler (§14.9: la comprobación es suya) |
| una solicitud con varias facturas (~170 en 10 meses) | v2 |
| escribir la cuadrícula del UUID en Kepler | DG4 |
| cancelar desde la Suite | v2, con canario |
| 00/01/03/06/08 | DG7 |
| la `203` de 00 | Contabilidad (§12) |

## 7. El orden de construcción, de abajo hacia arriba

C0 (G.2 sombra) → C1 (G.3–G.5) → C2 (G.6–G.8) → C3 (G.9). **Ninguna capa sube sin la de abajo verificada**
(`METODO_DE_TRABAJO.md`). La sombra es el C0: el armador corre sobre los 1,918 X-A-10 reales con póliza de
oct–nov y se compara renglón por renglón. Se espera 1,909 idénticos y 9 rechazados (concepto sin cuenta).
Corre fuera del repo, porque los datos son reales; al anexo sólo llegan conteos.

## 8. Plan por capas (`[PGP.123]`)

| Item | Capa | Qué | Quién |
|---|---|---|---|
| G.1 | C0 | **Captura de prueba**: una «Alta gasto CFDI» real en 05 y otra en un servidor de dos secuencias (00 o 01), con 2 XML en la cuadrícula. Foto de contadores de **todos los esquemas** (no sólo `md`) con placebo (5 min sin capturar), búsqueda por `xmin`, y otra X-A-10 sin XML de control. Cierra la lista de tablas, el contador de la póliza D, dónde va la cuadrícula y qué deshace la cancelación. **Sin G.1 no se enciende.** Gasto real, capturado por la persona, fuera de horario | Edgar |
| G.2 | C0 | Sombra del armador contra los 1,918 X-A-10 reales | Claude |
| G.3 | C1 | `gasto-kepler.armador.ts` + spec (CB.62 lo consume: deuda con nombre) | Claude |
| G.4 | C1 | `kepler-contable.ts`: `polizaDeGasto`, `columnaCargoKdxg`, `kdcn26` con padres; corregir el comentario del juego 2 | Claude |
| G.5 | C1 | Contrato `comprobacion.contract.ts`: la regla de §5.1 y los motivos | Claude |
| G.6 | C2 | Migración generada: estado del X-A-10 en el vale, tipo de documento en la bitácora, interruptor `comprobacion_gasto` apagado | Claude |
| G.7 | C2 | `kepler-gasto-sink.adapter.ts` + revisión + ensayo + `ops/prod/kepler-grants/pgp123_comprobacion_gasto.sql` | Claude |
| G.8 | C2 | Servicio: disparo al validar o firmar, cron de reintentos y lazo con el ODS; probado contra Postgres real con el payload de la pantalla (regla 13) | Claude |
| G.9 | C3 | El eslabón X-A-10 en Mis gastos, Aprobación y el expediente; «Comprobar este vale» en la bandeja S.13 | Claude |
| G.10 | — | GRANT, ensayo con ROLLBACK en los 9 servidores, canario en 05 (escribe, paga con PGP.106 y cancela), encender | Edgar |
| G.11 | — | Piloto 07 y 08 → 02, 04 → 00, 01, 03, 06 (con DG7) | Edgar |
| G.12 | — | Retirar GX.8 (`expense_comprobaciones`, su API y su cliente): borrar tabla pide autorización (regla 5) | Edgar |

**Veda:** nada se enciende entre el 15-dic y el 15-ene (los acumulados son del año), y antes de enero hace
falta permiso sobre `kdc22701`.

## 9. Pruebas (cada compuerta con su prueba negativa)

- **Armador:** la sombra (G.2) y un spec con un caso por renglón de §3: IVA, sin IVA, retención (rechazo),
  concepto sin cuenta (rechazo), `c23` de referencia vacía, departamento con y sin padre en `kdc3`. Mutantes
  que deben ponerse rojos: `c23` = `'0'`, el segundo juego excluyendo `c23` vacío, `kdcn26` sin padres, `c42`
  restado dos veces.
- **Contrato:** cada condición de §5.1 tiene su caso que dice el motivo, y el caso feliz.
- **Escritor:** contra un `md` con las 200 columnas reales (como `test-newdb-kepler-solicitud-gasto.js`).
  Casos: solicitud en `C`, en `F`, con X-A-10 vivo (escrito a mano entre la lectura y el COMMIT), total
  distinto, número de póliza ocupado, cuenta ausente en `kdc126`, `rowCount ≠ 1` en `kdxg`, sin permiso
  (debe ser `apagado`, no `rechazado`), tope, interruptor apagado.
- **Servicio:** punta a punta con el payload de la pantalla, como `app_runtime` con RLS.

## 10. Decisiones

> ✅ **Firmadas por Edgar el 2026-11-20:** DG1–DG11 como se recomiendan abajo (ya estaban así en el código).
> **DG12 = no**: el vale cuya lectura del comprobante dice otro monto no se comprueba solo (G.13, §15).
> **DG10:** dueño **Francisco**; meta, que la Suite escriba ≥ 80 % de los X-A-10 de vales autorizados, a 30 días.

| # | Decisión | Dueño | Recomendación |
|---|---|---|---|
| **DG1** | ⭐ La fecha del X-A-10 (`c9`), que decide el mes de la póliza y de los acumulados | Contabilidad / Edgar | **La fecha de la solicitud si cae en el mes en curso; si cae en un mes anterior, no se escribe sola** (queda «por comprobar: fecha de otro mes», para Contabilidad, como la manda G.5) hasta que Contabilidad diga hasta qué día se puede asentar el mes anterior. Hoy el 8.5 % se fecha en el mes anterior |
| **DG2** | El IVA del gasto | Finanzas | **El X-A-10 copia el IVA de su solicitud**, como Kepler (98.5 %). Desglosarlo del XML se decide al registrar (S.13 ya lo llena), no al comprobar. Hoy sólo el 29 % de las facturas casadas lo desglosa: cambiarlo cambia números (regla 15) |
| **DG3** | La forma de pago (`c90`) | Finanzas | La de la solicitud; si viene vacía, **la del vale** (sólo códigos decodificados: 01, 02, 03, 04, 99); si tampoco, `01` como Kepler. Hoy Kepler dice `01` en 771 casos donde el vale dice otra cosa |
| **DG4** | ¿Escribir la cuadrícula del UUID en Kepler? | Edgar / Finanzas | **No en v1**: hoy nadie la llena y ContPAQi ya asocia el 96.5 %. La Suite guarda el UUID. Se revisa con G.1 |
| **DG5** | La cuenta del acreedor | Contabilidad | **La de `kdmm` del servidor, leída en vivo**, como Kepler. Que la `203` de 00 no tenga cargos es de Contabilidad (§12) |
| **DG6** | Retenciones | Contabilidad | Fuera de v1 (como DS18) |
| **DG7** | ⭐ El número de la póliza D | Edgar | **MAX+1 del mes, re-medido antes del COMMIT, sólo en 02/04/05/07.** En 00/01/03/06/08 el escritor queda apagado hasta que G.1 encuentre el contador de la secuencia corrida (§3.6). Ojo con el orden: el 15-nov, 92 de los 106 vales listos estaban en esos cinco servidores (44 en 00): la captura de prueba de la 00 es la que más destraba |
| **DG8** | El disparo | Edgar | **Automático al firmar o validar el vale**, con interruptor por sucursal y tope. La persona valida al firmar; no hay segundo botón |
| **DG9** | Vales que no nacieron en la Suite | Edgar | **Sí**: la cola real (128, $1.26 M) es de vales de hoy ligados por `folio_solicitud` |
| **DG10** | Dueño y meta | Edgar | — |
| **DG11** | Vocabulario: en la Suite, «Comprobado» es el vale con la evidencia revisada (GX.58, «Dar por comprobado»); en Kepler, comprobar es dar de alta el gasto (X-A-10). Hoy conviven: un vale «Comprobado» puede seguir sin gasto en Kepler | Edgar / Francisco | Que la Suite llame al eslabón de Kepler **«Gasto en Kepler»** y deje «Comprobado» como está (lo menos disruptivo; así lo usa este anexo desde §14). La otra opción, renombrar el estado a «Validado», cambia la palabra que hoy usan todos los que capturan |
| **DG12** | ⭐ ¿Un vale con aviso de la lectura del comprobante («el comprobante dice $X y la solicitud $Y») se comprueba solo? | Edgar / Finanzas | **No: que se quede en Kepler hasta que una persona compare el comprobante con la solicitud** (motivo «La lectura del comprobante dice $X: compruébalo en Kepler», a Finanzas). La lectura nunca decide el estado del vale (GX.33) y quien revisó vio el aviso; pero escribir el gasto por el monto de la solicitud cuando la Suite misma leyó otro sería asentar algo que nadie comparó. La otra opción: confiar en la revisión de la Suite y escribirlo. Medido en la copia local el 2026-11-16: **10 de los 106 listos ($8,432.13)** traen ese aviso; en toda la base, 560 de 1,998 vales validados. Hoy G.5 no lo mira: el monto leído vive sólo en el texto de `revision_nota`, así que implementarlo pide guardarlo como dato (§14.5) |
| **DG13** | ¿La cola muestra también los vales validados cuya solicitud Kepler canceló **sin** haber generado su gasto? | Edgar / Francisco | ✅ **Decidido por Francisco el 2026-11-16: una lista propia, «Canceladas en Kepler»** (G.UI.1c, §14.7), con las dos clases de cancelada; «Esperan a Kepler» deja de traerlas. (La recomendación era plegarlas en la cola.) Hoy la cola sólo marca las canceladas con gasto (GX.96, decisión del 2026-11-06) y éstas no aparecen en ninguna lista. Puede ser una solicitud que se recapturó con otro folio (el vale apunta a una solicitud muerta) o un gasto que nunca llegó a Kepler; en los dos casos alguien tiene que mirarlo. Medido en la copia local el 2026-11-16: **13 vales, $266,457.05 capturados**. Desde G.UI.1b el Expediente ya los dice («Solicitud cancelada en Kepler») |

Cierre: un ADR nuevo, «la Suite escribe la póliza del gasto en Kepler; ContPAQi sigue siendo el registro
contable (ADR-040)», junto con el que el Anexo S debe a ADR-092.

## 11. Riesgos y NO MEDIDO

- **Escribir el X-A-10 es escribir contabilidad.** Un error en `kdcn26` descuadra el reporte por centro de
  costo de Kepler sin que la póliza lo muestre. Un X-A-10 duplicado duplica la cuenta por pagar que después
  salda el X-D-26 (hoy hay 293 vencidos con saldo, $1.85 M). Por eso: re-lectura en vivo, revisión antes
  del COMMIT, sombra y canario.
- **Dos puertas:** la sucursal sigue tecleando el X-A-10 mientras se enciende (es suya: §14.9). El candado de §4
  (re-leer dentro de la transacción) es lo que evita el duplicado.
- **Concentración:** en 00 una persona captura el 48.9 % de los X-A-10. Si la Suite automatiza, esa persona
  pasa a validar: hay que decirle qué valida (DG8).
- **04 y 05 cancelan el 20–23 % de sus X-A-10** (aprendizaje tras el corte): el lazo tiene que enterarse.
- **NO MEDIDO:**
  - la lista cerrada de tablas en el Kepler vivo y si hay una décima;
  - dónde guarda Kepler la cuadrícula del UUID;
  - el contador de la secuencia corrida de la D (§3.6);
  - qué revierte la cancelación en los acumulados;
  - por qué 4 gastos vivos no tienen póliza y 32–35 solicitudes quedaron en `A` con saldo 0;
  - si Kepler valida algo al grabar el gasto;
  - el significado de `c90 = 07` (aparece sólo con CFDI de forma 28, tarjeta de débito: 95 de 95);
  - las llaves únicas de `kdc2AAMM`, `kdc126` y `kdcn26` en el Kepler vivo;
  - si el motor de documentos de Kepler (`kdmx`) puede dar de alta un X-A-10 desde fuera (pregunta al
    proveedor, la misma de PGP).

## 12. Hallazgos fuera de alcance, con su dueño

| Hallazgo | Medido | Dueño |
|---|---|---|
| En 00 el gasto abona a la `203` (`kdmm` cambiado el 2026-05-26) y su pago carga la `201` | la `203` de 00 suma $42.79 M de abonos y $0 de cargos en 2026 | Contabilidad |
| Retenciones RESICO mal asentadas | 3 de 4 CFDI casados sin `c15`; 2 pagados por el bruto (+$142.49) | Contabilidad / Tesorería |
| Gastos vivos sobre solicitudes canceladas | 42, $159,749.54 | Finanzas |
| Gastos duplicados sobre la misma solicitud | 4, +$4,444.25 | Finanzas |
| Pólizas descuadradas por concepto sin cuenta | 9, $4,023.96 | Contabilidad (`kdco`) |
| La regla del segundo juego de `kdc126` está mal escrita en PGP §4 y en `kepler-contable.ts` | acierta 259 de 429 | este anexo (G.4) |
| `analytics.expense_requests.aplicada` | 10 falsos | este anexo (G.8) |
| `expense_comprobaciones` (GX.8) | 1 fila desde agosto; ningún vale marcado | G.12, con autorización |

## 13. Construcción — lo que ya está y lo que es de Edgar

| Item | Estado | Qué hay | Prueba |
|---|---|---|---|
| G.1 | ⬜ Edgar | — | — |
| G.2 sombra | 🧪 2026-11-15 | El armador corrido sobre los 1,922 X-A-10 vivos de oct–nov, desde su solicitud, comparado columna por columna con lo que escribió Kepler. Corre fuera del repo (datos reales); aquí sólo los conteos | ver abajo |
| G.3 armador | 🧪 | `libs/finance/src/lib/shared/gasto-kepler.armador.ts`: clona la X-A-15 y arma `kdm1`, `kdm6`, `kdxe`, la póliza, el UPDATE de la solicitud y los acumulados, o dice por qué no | spec 20 ✓ · 4 mutantes → rojos. ⚠️ CB.62 aún no lo consume (deuda con nombre, ADR-056) |
| G.4 `kepler-contable.ts` | 🧪 | `columnaCargoKdxg`, `filasKdc126` (cuenta + mayor), `movimientosKdc126`, `periodoKdcn26`, `padresDelDepartamento`, `movimientosKdcn26`; corregido el comentario del segundo juego de `kdc126` | spec 11 ✓ (6 nuevos) · 2 mutantes → rojos |
| G.5 contrato | 🧪 | `libs/contracts/src/finance/comprobacion-gasto.contract.ts`: «listo con su fecha» o el primer motivo y a quién le toca | spec 9 ✓ · 3 mutantes → rojos. Medido en prod el 15-nov sobre 2,027 vales desde el 1-oct: **106 listos ($1.21 M)**; 1,810 ya comprobados, 39 con la solicitud cancelada, 22 rechazados, 20 de otro mes (DG1), 18 sin autorizar, 8 sin validar, 3 sin medir, 1 con saldo usado |
| G.UI.1–G.UI.2 | 🧪 2026-11-15 | Los dos 🔴 de §14 en pantallas que ya existen. Servicio `esperanKepler` (+ `importe_capturado`, `importe_fuente`); Aprobación (`importeEnCola`, `notaImporteKepler`, el total con la misma regla); Expediente («Falta el gasto en Kepler»); panel del vale (frase acotada a la Suite) | Aprobación + Expediente 163 ✓ (4 casos nuevos) · panel 45 ✓ · servicio 3 ✓ · 3 mutantes → rojos · verificado en vivo con los vales reales |
| G.6 migración | 🧪 2026-11-15 | `20261115124001_pgp123_comprobacion_gasto_x_a_10.js`: el estado del gasto en el vale (`kepler_expense_*`, con un CHECK que exige el folio de 7 dígitos a lo escrito), la bitácora con `document_type` (DEFAULT 15: el camino de PGP.122 inserta igual, regla 14) y el disparo `validacion`, el interruptor `comprobacion_gasto` apagado con tope 1 | `up()` real dos veces y `down()` en local: 16 ✓ (la negativa cazó un CHECK que con el folio NULL no fallaba). **Sin aplicar en prod** |
| G.7 escritor | 🧪 2026-11-15 | `comprobacion-kepler/kepler-gasto-sink.adapter.ts` (+ revisión y ensayo): las 9 escrituras en una transacción. `kdm1`/`kdm6` se clonan de la X-A-15; `kdxe` y la póliza se insertan completas (medido: en los 1,922 reales las columnas que el armador no pone van vacías: 13 de `kdxe`, 29 de la póliza). Lo que Kepler crearía (cuenta sin fila en `kdc126`, acreedor sin fila única en `kdxg`) se rechaza. Sin permiso → `apagado`. DG7 en código. `ops/prod/kepler-grants/pgp123_comprobacion_gasto.sql` | contra Postgres real con las estructuras de Kepler y el archivo de permisos real: 41 ✓ · 5 mutantes → rojos · spec 8 ✓. El ensayo contra el Kepler vivo: **NO MEDIDO** (sólo desde `md`) |
| G.8 servicio | 🧪 2026-11-15 | `comprobacion-kepler/comprobacion-gasto.service.ts`: al validar (o firmar si cierra en `validada`) decide con G.5, reclama, escribe y anota; cron cada 5 min con reintentos, huérfanos y el lazo (escrito → visto → cancelado). El gasto que capturó una persona se reconoce con su folio. El lazo liga el gasto por folio **y** solicitud (`c39`) | de punta a punta como `app_runtime` con el payload de la pantalla: 20 ✓ (dos corridas, sin tocar filas ajenas) · 4 mutantes → rojos · arranque de Nest 14 ✓ con su negativa |
| G.9 interfaz | 🧪 2026-11-16 | **G.9a** (servidor): la cola trae, por vale autorizado sin gasto, la regla G.5 (listo o el motivo y a quién le toca), cómo va su X-A-10 y si la base escribe (`enLaCola`, en lote y por índice: ~42 ms en prod); `POST /finance/expenses/proofs/:id/reintentar-gasto` (COMPROBAR). **G.9b** (pantalla): «Esperan a Kepler» como cola de comprobación (`esperan-kepler.ayudas.ts`), el folio abre el panel sin tocar la cola, el eslabón «Gasto en Kepler (X-A-10)» en el panel con «Escribir el gasto ahora / Reintentar el gasto», los nombres del padrón, el Expediente con «N de M». Detalle en §14.5 | reglas de la cola 14 ✓ · Aprobación 116 ✓ (8 nuevos) · panel 50 ✓ (5) · Expediente 54 ✓ · contrato 21 ✓ (3) · G.5 9 ✓ · armador 20 ✓ · contra Postgres real 31 ✓ (G.UI.8 nuevo) · 6 mutantes de pantalla y 1 de la consulta → rojos · prueba visual A con los 176 vales de la copia local, `POST` de punta a punta con el payload de la pantalla |
| G.UI.1b | 🧪 2026-11-16 | El Expediente dejaba «Falta el gasto en Kepler» en vales con la solicitud **cancelada** y los mostraba en $0.00. Ahora la frase sale de la regla de la cola (`faltaEnKepler`, contrato) y el monto de la cancelada es lo capturado (`importeDelVale`, que también usa la cola). Detalle en §14.6 | contrato 45 ✓ · Expediente 57 ✓ · contra Postgres 35 ✓ (sección I, control independiente) · 4 mutantes → rojos · antes/después medido en vivo |
| G.UI.1c | 🧪 2026-11-16 | «Canceladas en Kepler», una lista propia en Aprobación (decisión de Francisco, DG13): con su gasto ya generado («¿salió dinero?») y sin gasto («¿se volvió a capturar con otro folio?»). La cola ya no descarta la cancelada sin gasto (`solicitudCanceladaEnKepler`, contrato). Detalle en §14.7 | Aprobación 120 ✓ · reglas de la cola 15 ✓ · contrato 46 ✓ · contra Postgres 36 ✓ (control independiente) · 3 mutantes → rojos · prueba visual (escritorio, celular, panel, Esc) |
| G.UI.1d–1e | 🧪 2026-11-16 | La **pista** de cada cancelada (pagos en Kepler, forma de pago del vale y recaptura; `pista-cancelada.ts`, `lecturaDeLaCancelada`) y el **cierre del caso**: «Ligar a XA1501-…» (sólo a la recaptura de la pista), «Rechazar por repetido» (el rechazo de siempre) y «Ya lo revisé» con nota (migración `20261117005015`). Detalle en §14.8 | contrato 52 ✓ · diálogo 6 ✓ · Aprobación 123 ✓ · biblioteca 369 ✓ · contra Postgres 52 ✓ (J: la pista contra control independiente; K: el cierre con el payload de la pantalla) · migración real 7 ✓ · 7 mutantes → rojos · de punta a punta en la pantalla viva |
| G.UI.1f | 🧪 2026-11-17 | **La comprobación le toca a la sucursal, no a Finanzas** (Francisco, con el proceso entero): `QuienResuelve` parte `kepler` en `sucursal` (lo que se comprueba a mano en Kepler y lo listo en una base que todavía no escribe) y `finanzas` (autorizar, la cancelada y lo que la Suite intentó). Detalle en §14.9 | contrato 62 ✓ · pantalla 194 ✓ · contra Postgres 52 ✓ · 4 mutantes → rojos |
| Revisión | 🧪 2026-11-17 | **La revisión independiente del PR**: 12 hallazgos, todos confirmados en el código y corregidos (factura ilegible, la solicitud viva contra lo aprobado, «en duda» que no se resolvía, «cancelado» sin salida, ligar, rechazar, el CHECK de la nota…). Detalle en §14.10 | contrato 87 ✓ · finanzas 402 ✓ · pantallas de gastos 447 ✓ · escritor 10 ✓ y contra Postgres 46 ✓ · de punta a punta contra Postgres 68 ✓ · migración real 9 ✓ (con la versión anterior, 1 ✗) · 16 mutantes en 10 grupos → rojos · ngc 0 errores |
| G.10 | 🔨 2026-11-20 | Permisos de `pgp123` en las 9 bases. Ensayo con ROLLBACK (`ops/prod/ensayo-comprobacion-gasto/`) **verde en 02, 04, 05 y 07**. Bandera `KEPLER_GASTO_COMPROBACION=encendida` en el secreto. **Canario en 05: el X-A-10 0000090** ($1,100, póliza D 369), verificado en el Kepler vivo y visto por el ODS. 05 se volvió a apagar hasta que DG12 llegue a prod. Detalle en §15 | ensayo 4/4 (0 fallas, permisos completos, control intacto) · canario verificado columna por columna |
| G.1 | 🧪 2026-11-20 | **Pasiva, sin documento de prueba.** Medición de sólo lectura en md (00, 01, 05, 07, 08 hasta el 2026-11-23 16:00), cada 20 s, de `pg_stat_user_tables` contra cada X-A-10 y cada póliza D nuevos, más la reconstrucción en el ODS del orden de captura de cada póliza D. **No hay contador** (§3.6): DG7 se retira y el escritor escribe en las 9. Ensayo con ROLLBACK verde también en 00, 01, 03, 06 y 08 | 98 % de las D = MAX del mes + 1 en 5 bases y 2 meses · el salto, siempre un X-D-55 · 11 pólizas en vivo en 01 · ensayo 5/5 · la prueba de los candados con las 9 y su mutante en rojo. NO MEDIDO: la lista de tablas de un X-A-10 de una persona (la medición sigue) |
| G.11–G.12 | ⬜ Edgar | — | — |
| G.13 DG12 | 🧪 2026-11-20 | La regla G.5 deja en la cola, para la sucursal, el vale cuya lectura del comprobante dice otro monto (`lectura_distinta`, tolerancia del lector: $1 o 1 %). El monto leído se guarda como dato (`monto_ocr`) al escribir el aviso; para los vales anteriores se toma del aviso en `revision_nota` | contrato 14 ✓ (2 nuevos) · 4 mutantes → rojos · expense-proofs 401 ✓ |

**Lo que dio la sombra (G.2), 2026-11-15:**

- De 1,922 gastos vivos, el armador arma **1,825** y rechaza 97 por sus candados: 30 con fecha anterior a su
  solicitud, 22 con fecha futura, 35 sin departamento o proyecto, 15 cuya solicitud no cuadra, 12 con un concepto
  sin cuenta, 6 sin renglones, 3 sin total y 1 con retención. La Suite nunca elige una fecha así (DG1); el
  resto se queda en Kepler, como dice §6.
- ⭐ **Copias puras** (la persona no cambió montos, renglones, referencia ni fecha de pago): **1,731**. En ellas,
  **la póliza es idéntica en 1,731 de 1,731 y `kdxe` en 1,731 de 1,731**. `kdm1` es idéntico salvo `c67`
  (`SUITE`, a propósito) y `c90` (DG3: en 174 la persona cambió el `01` por otra forma).
- La póliza armada cuadra en 1,825 de 1,825.
- **Acumulados**, derivados de TODAS las pólizas del mes (no sólo de los gastos): `kdcn26` 2,824 de 2,824 celdas
  (oct) y 1,718 de 1,718 (nov); `kdc126`, cuenta y mayor, 552 de 552 y 437 de 437 filas; `kdxg`, el cargo del mes =
  Σ de los X-A-10 vivos del acreedor, en 390 de 399 (los 9 restantes traen otros cargos).
- Lo que la sombra corrigió del diseño: (1) si el renglón no trae texto, Kepler pone el nombre del acreedor en el
  cargo (1 caso); (2) en 9 de los 35 gastos sin departamento o proyecto la persona los completó al comprobar, así
  que copiarlos vacíos sería decidir por ella: se rechazan con el motivo «complétalo en la solicitud».

## 14. La interfaz de la comprobación — prueba visual (2026-11-15)

> **Nivel de evidencia A:** pantalla viva en local (vista :4201, API :3336) sobre los **2,027 vales reales desde
> el 1-oct**, copiados de prod en sólo lectura a la base de Docker, y la consulta de la cola medida también en
> prod. **NO MEDIDO:** las fotos de los comprobantes (el S3 local no las tiene), «Mis gastos» (pide un usuario
> con vales propios y los usuarios locales no son los de prod), celular, alto contraste y la cola completa con
> teclado. «51 de 52 personas no están ligadas a un usuario del padrón», en el Expediente, es efecto de la base
> local, no un hallazgo.

### 14.1 La cola de comprobación ya existe

En «Aprobación de gastos», la bandeja **«Esperan a Kepler»** (GX.96) lista los vales validados que no tienen
gasto en Kepler y por qué esperan. Es la cola de comprobación. Las 176 tarjetas cuadran con su encabezado ✓:

| Lo que dice cada tarjeta | Tarjetas | Quién lo mueve |
|---|---:|---|
| Autorizada: falta generar el gasto en Kepler | **126** | quien comprueba: es lo que automatiza PGP.123 |
| Se canceló en Kepler con su gasto ya generado: ¿salió dinero? | 29 | Tesorería, que confirma |
| Falta que la autoricen en Kepler | 18 | quien autoriza |
| Kepler dice aplicada, pero el gasto no aparece | 2 | revisión |
| No se pudo leer su estado en Kepler | 1 | nadie: está declarado como sin medir ✓ |

En prod, la misma consulta devuelve 190 vales: 187 sin gasto (129 con la X-A-15 en `A`, 18 en `N`, 40 en `C`).
Tarda 606 ms en frío y 247 ms en caliente.

**Decisión de diseño (Claude):** G.9 extiende esta cola, el panel del vale y el Expediente; no se hace pantalla
nueva (`diseno` §0b, pregunta 5; ADR-056).

- **La prueba de la frase:** «¿Qué le falta a cada gasto autorizado para quedar comprobado en Kepler?»
- **La jerarquía:**
  - primario, «N por comprobar · $X»;
  - secundario, el renglón (folio, sucursal, acreedor, días, importe, motivo y quién lo mueve);
  - terciario, quién capturó y quién revisó.

### 14.2 Observaciones

Severidad: 🔴 afirma algo falso (bloquea pasar C3 a 🚀) · 🟠 se resuelve en la fase · 🟡 deuda menor.

| # | Sev | Qué está mal y cuánto cuesta (medido) | Ley | Criterio de aceptación |
|---|---|---|---|---|
| G.UI.1 | 🔴 | **Da por terminado lo que falta.** El vale 0010124 (00, $518.00, «Autorizada: falta generar el gasto») dice «**Protocolo completo**», en pastilla verde, en el Expediente, y «**Comprobado**» en Aprobación (panel y búsqueda). El gasto que falta aparece como «sin gasto aplicado», en letra chica gris. Aplica a hasta 126 vales (129 en prod) | STD §1.1: el rótulo dice lo que muestra (Cruce 2) | ✅ **Hecho el 2026-11-15** (verificado en vivo con 0010124). El Expediente escribe «Falta el gasto en Kepler» con el mismo peso que la pastilla cuando el protocolo de la Suite está completo; la regla de GX.65.2 se respeta. El panel del vale acota su frase: «En la Suite ya se resolvió». «Comprobado» se queda, porque en la Suite significa «evidencia revisada» (GX.58); si debe reservarse para el X-A-10 es **DG11** ⚠️ **Corregido el 2026-11-16 (G.UI.1b, §14.6):** la frase también salía en 38 vales cuya solicitud Kepler ya había cancelado; ahora sale de la regla de la cola |
| G.UI.2 | 🔴 | **«¿Salió dinero?» con «$0.00».** Las canceladas muestran el saldo de Kepler (0 al cancelar): el servicio toma `importe` de `finance.v_expense_proofs`, que antepone ese saldo a lo capturado. Los vales eran de $712.43, $1,500 y $4,600. La vista ya trae `importe_capturado` e `importe_fuente` | STD §1.3: lo no medido no es cero (ADR-056) | ✅ **Hecho el 2026-11-15** (verificado en vivo). El servicio trae `importe_capturado` e `importe_fuente`; la cancelada muestra lo capturado con «en Kepler quedó en $0.00», y el total de la pestaña suma lo mismo que las filas: $1,353,067.09 contra $1,286,274.61 de antes (escondía $66,792.48) **Extendido al Expediente el 2026-11-16 (G.UI.1b, §14.6):** ahí salían en $0.00 las 38 canceladas ($332,537.10) |
| G.UI.3 | 🟠 | **Cuatro esperas en una sola lista por días.** El encabezado suma todo (176 · $1,286,274.61), y quien comprueba busca sus 126 entre 18 por autorizar y 29 canceladas, que van primero | STD §4.0 (conflación) y §3.1 (primero la respuesta) | ✅ **Hecho el 2026-11-16** (§14.5). ⛔ «La Suite las escribe» cuenta sólo lo que la Suite va a escribir: lo listo en una base cerrada (hoy, todas) va «con motivo». Secciones por quién lo mueve, la de comprobar primero y las demás plegadas con su conteo. Encabezado «126 por comprobar · $X». Con el escritor: «la Suite las escribe (N)» y «con motivo (N)», cada motivo con su dueño (contrato G.5) |
| G.UI.4 | 🟠 | **Abrir un folio reemplaza la cola por una búsqueda.** Al cerrar, la persona queda en «Vales 1» con el vale «Comprobado». Dos `Esc` no la regresan, aunque la pantalla promete «Esc volver a la caja»; con la × vuelve, pero arriba de la lista. Con 126 vales son ~2 acciones extra por vale y la posición perdida | STD §5.2: lo que se abre no empuja lo que se usa (retrabajo, `auditoria-diseno` §3c) | ✅ **Hecho el 2026-11-16** (§14.5): Enter abre, Esc regresa el foco al mismo folio; la pestaña y el buscador no se tocan. El folio abre el panel sin tocar la cola, y al cerrarlo el foco vuelve a la fila |
| G.UI.5 | 🟠 | **El panel corta la cadena en la solicitud** («XA1501-0010124 · Kepler: autorizada») y remata «Este vale ya se resolvió: no hay nada que decidir». El paso pendiente, el gasto, no aparece | STD §2.1: lo que define el estado, a la vista (`diseno` §0b, pregunta 4) | ✅ **Hecho el 2026-11-16** (§14.5). Un eslabón «Gasto en Kepler (X-A-10)» que dice si falta (con el motivo de G.5 y a quién le toca), si lo escribió la Suite (folio, fecha, póliza D) o si se capturó a mano |
| G.UI.6 | 🟠 | **La diferencia de montos no tiene consecuencia.** El panel avisa en ámbar «El comprobante dice $347.59 y la solicitud $518.00 (difieren $170.41)», pero ese vale no se puede comprobar solo (G.5: total distinto) y la cola no lo dice | STD §4.7: la excepción, por nombre | ✅ **Hecho el 2026-11-16** (§14.5), con la premisa corregida: los $170.41 los dijo la **lectura del comprobante** (GX.33), que nunca decide, y G.5 no la mira; 0010124 espera por DG1 (es de octubre). Si un aviso así debe frenar la escritura es **DG12**. El renglón de la cola trae el motivo: «El comprobante y la solicitud difieren por $170.41: se comprueba en Kepler» |
| G.UI.7 | 🟠 | **Rojo y color de acción de más.** Las 29 canceladas llevan el renglón completo en rojo y negritas, y el folio de cada una de las 176 tarjetas va subrayado en el color de acción | STD §3.10: rojo sólo para lo que está mal y pide acción; el color de acción, un solo papel | ✅ **Hecho el 2026-11-16** (§14.5). Marcador rojo con texto neutro; el folio como enlace neutro |
| G.UI.8 | 🟡 | Personas por su clave de usuario («capturó» y una clave de 6 caracteres), un código del tracker en pantalla («revisó cierre GX.82 (aprobado con cotización)») y trato de usted («Revíselo») | STD §3.8 · tuteo | ✅ **Hecho el 2026-11-16** (§14.5): nombres del padrón, «el cierre automático», sin «(DG1)»/«(DG6)» en los motivos y tuteo en los avisos nuevos (los ya guardados conservan su texto). El nombre de la persona, el motivo en llano y tuteo |
| G.UI.9 | 🟡 | El Expediente dice «Se llegó al tope de filas: hay más vales de los que se muestran», sin decir cuántos | VALORES §1: la cifra se puede recorrer | ✅ **Hecho el 2026-11-16**: «Se muestran 2,000 de 2,029 vales, los más recientes», en vivo y contrastado con un conteo independiente. «200 de 2,027» |
| G.UI.10 | 🟡 | La consulta de la cola tarda 606 ms en frío en prod. En local, con estadísticas viejas, se colgó más de 2 min hasta que la cancelé: depende de cómo la planee la base | VALORES §15: menos de 500 ms al cargar | ✅ **Medido con G.9a**: la cola en prod 282–322 ms en frío y la comprobación en lote ~42 ms, < 500 ms. Menos de 500 ms en frío, medido con `EXPLAIN (ANALYZE, BUFFERS)` |

### 14.3 La cola, como queda (nivel 0)

```
Aprobación de gastos › Esperan a Kepler
 N por comprobar · $X               la Suite las escribe: N · con motivo: N
 ─ Con motivo (por quién lo mueve) ──────────────────────────────────────────────
  0010124 · 00 CEDIS · Caja chica La Piedad · 40 días · $518.00
     El comprobante y la solicitud difieren por $170.41: se comprueba en Kepler · Finanzas
 ─ La Suite las escribe (DG7: hoy 02, 04, 05 y 07) ──────────────────────────────
  … · se escribe al validar · o, ya escrito: X-A-10 0000123 · póliza D 418 · hace 3 min
 ▸ Falta que las autoricen (N)   ▸ Canceladas con gasto: ¿salió dinero? (N)   ▸ Sin medir (N)

Panel del vale:  firma → Solicitud XA1501-… (autorizada) → Gasto: FALTA, motivo y quién → Pago
```

### 14.4 Lo que la interfaz no puede resolver

- **Sin el escritor (G.6–G.8)** la cola no tiene nada que escribir: G.9 va después (`METODO_DE_TRABAJO`: la
  capa de abajo, verificada primero). Las 🔴 G.UI.1 y G.UI.2 sí se pueden corregir ya, porque son de pantallas
  que existen.
- **DG7 y DG1** deciden qué se escribe solo: la pantalla sólo puede decirlo, no decidirlo.
- **«¿Salió dinero?»** se contesta con el pago (X-D-26) y lo resuelve Tesorería. La cola sólo puede mostrarlo
  sin mentir (G.UI.2).

### 14.5 G.9 construida — la prueba visual (2026-11-16)

**Nivel A**, con la pantalla viva (`localhost`) contra la copia local de la base (Docker), con los 176 vales que
espera Kepler y el ODS de esa copia. Sin escrituras a ningún Kepler.

**La cola, como quedó:**

| Lo que dice | Vales | Importe |
|---|---:|---:|
| **126 por comprobar** (encabezado primario: 18 px, negritas) | 126 | $1,252,990.78 |
| · la Suite las escribe | 0 | — |
| · con motivo: «Las decide Contabilidad» (todas por DG1: solicitudes de septiembre y octubre) | 20 | $41,058.06 |
| · con motivo: «Se comprobarían solas, pero en su base la Suite todavía no escribe: mientras, en Kepler» | 106 | $1,211,932.72 |
| ▸ Falta que las autoricen en Kepler (plegado) | 18 | $28,563.13 |
| ▸ Canceladas en Kepler con su gasto ya generado: ¿salió dinero? (plegado, punto rojo) | 29 | $69,476.21 |
| ▸ Kepler dice aplicada, pero el gasto no aparece (plegado) | 2 | $27.97 |
| ▸ No se pudo leer su estado en Kepler (plegado) | 1 | $2,009.00 |
| **Suma = la pestaña** | **176** | **$1,353,067.09** ✓ |

Los 106 «se comprobarían solas» y los 20 de Contabilidad son los mismos 106 listos y 20 de otro mes que G.5 midió
en prod el 2026-11-15 (§13).

**Decisiones de diseño (Claude), con su porqué:**

- ⛔ **«La Suite las escribe» cuenta sólo lo que la Suite va a escribir sin que nadie haga nada**: lo ya escrito, lo
  que se está escribiendo y lo listo en una base abierta. Lo listo en una base cerrada (hoy, las nueve: el
  interruptor nace apagado y DG7 deja fuera cinco) va «con motivo», porque lo sigue capturando una persona; contarlo
  como de la Suite haría que nadie lo comprobara.
- ⛔ **«En duda» fuera de una base abierta** va con «La Suite las intentó y necesitan a una persona», con la frase
  «puede que ya esté en Kepler; búscalo antes de capturarlo»: capturarlo a ciegas lo duplicaría.
- **El orden:** primero lo que pide una decisión (lo que la Suite intentó y no quedó, Finanzas, Contabilidad, la
  Suite), después lo rutinario (lo que se comprobaría solo) y al final lo que hace la Suite. Lo que espera otra cosa,
  plegado con su conteo y su importe.
- **El renglón**: dos líneas (70 px; con «capturó · revisó» en su propia línea eran 94). El motivo es el texto de G.5,
  sin «(DG1)» ni «(DG6)»; quién lo mueve lo dice el título de la sección (el panel lo repite junto al motivo).
- **G.UI.4**: el folio abre el vale con la misma búsqueda del servidor, sin pasar por el buscador de la pantalla
  (`verEnBuscador` se retiró: nadie lo llamaba). Un doble clic no abre dos veces.
- En angosto, el acreedor baja a su propia línea (en 390 px se cortaba a tres letras).

**Medido en la pantalla viva:**

| Qué | Resultado |
|---|---|
| G.UI.4 con teclado | Tab al folio, Enter abre el panel, Esc lo cierra y **el foco vuelve al mismo folio**; la pestaña sigue en «Esperan a Kepler», el buscador vacío y las 176 filas en su lugar ✓ |
| G.UI.5 | El panel dice «Solicitud en Kepler» → **«Gasto en Kepler (X-A-10)»**: «Se comprobaría sola, pero la escritura de gastos a Kepler todavía está apagada en esta base · Le toca a Finanzas, en Kepler» ✓ |
| «Escribir el gasto ahora», de punta a punta | Con la respuesta de la cola forzada a «base abierta» para un vale (ninguna base local escribe), el botón aparece; el clic manda `POST …/reintentar-gasto` con `{}`, la API real contesta 201 `pending` con su motivo, el aviso lo dice y la cola se vuelve a pedir ✓. El vale y la bitácora locales se dejaron como estaban |
| G.UI.9 | «Se muestran 2,000 de 2,029 vales, los más recientes»; 2,029 = conteo independiente de `finance.v_expense_proofs` ✓ |
| Contraste (WCAG, controles 21.00 y 4.48) | «capturó · revisó» 5.28 (claro) / 5.25 (oscuro); conteos 7.03; línea del gasto ok/warn/bad 7.13 / 7.09 / 8.31 (claro) y 12.62 / 12.29 / 9.33 (oscuro); marcador rojo 4.83 (pide 3). El aviso ámbar del panel pasó de 2.15 a 7.09 ✓ |
| Celular, 390 px táctil | sin desborde horizontal; folio y plegados de 44 px; el acreedor completo ✓ |
| Oscuro | marcador y punto rojos visibles, texto neutro ✓ |

**Hallazgo (DG12):** el vale 0010124 de G.UI.6 no espera por los $170.41: espera por ser de octubre (DG1). Esos $170.41
los dijo la lectura del comprobante (GX.33), que por diseño sólo avisa, y G.5 no la mira. De los 106 listos, **10
($8,432.13) traen ese aviso**: si se enciende la escritura, se escribirían por el monto de la solicitud. Es de Edgar
(§10, DG12); mientras, la pantalla no lo esconde: el aviso sigue en el panel del vale.

**NO MEDIDO:** el botón contra una base que de verdad escribe (ninguna base local escribe; el ensayo es G.10) · el
texto llano del aviso de «apagado» en la pantalla viva (la API corría el build anterior a ese ajuste; lo verificó la
prueba contra Postgres) · `forced-colors` y lector de pantalla · la cola contra prod con el código nuevo (se mide al
desplegar). Las capturas tienen nombres de personas: viven sólo en `.playwright-mcp/`, fuera del repo.

### 14.6 G.UI.1b — lo que encontró el recorrido con Francisco (2026-11-16)

En un recorrido guiado por la comprobación, el vale **06 · 0000119** decía dos cosas distintas según la pantalla:

| Pantalla | Lo que decía | Monto |
|---|---|---:|
| Esperan a Kepler | «Se canceló en Kepler con su gasto ya generado: ¿salió dinero?» | $3,215.00 · en Kepler quedó en $0.00 |
| Expediente (antes) | «Falta el gasto en Kepler» | **$0.00** |

La frase del Expediente era mía (G.UI.1): se ponía a todo vale validado sin gasto ligado, sin mirar si Kepler había
cancelado la solicitud. En una cancelada ese gasto nunca va a llegar.

**Medido en la copia local**, sobre los 2,000 vales del Expediente (180 validados sin gasto ligado):

| Estado de la solicitud en Kepler | Vales | Antes: el Expediente decía | Monto antes | Monto ahora |
|---|---:|---|---:|---:|
| Autorizada, sin gasto | 126 | «Falta el gasto en Kepler» ✓ | $1,252,990.78 | igual |
| Cancelada con su gasto ya generado | 25 | «Falta el gasto en Kepler» ✗ | $0.00 | $66,080.05 |
| Cancelada sin gasto | 13 | «Falta el gasto en Kepler» ✗ | $0.00 | $266,457.05 |
| Sin autorizar | 13 | «Falta el gasto en Kepler» (le falta antes la autorización) | $27,792.06 | igual |
| Aplicada, sin el gasto ligado | 2 | «Falta el gasto en Kepler» ✗ | $27.97 | igual (NO MEDIDO cuál es el bueno: Kepler dice $27.97 y lo capturado $3,564.97) |
| Sin leer en Kepler | 1 | «Falta el gasto en Kepler» | $2,009.00 | igual |

**La corrección:** la frase y el monto salen del contrato, con las reglas de «Esperan a Kepler»
(`faltaEnKepler`, `importeDelVale`): una sola regla para las dos pantallas (ADR-056). La cola usa las mismas dos
funciones. Sin la vista de Kepler, el Expediente no afirma nada («sin gasto aplicado»).

**Antes / después, en vivo:** el total del Expediente pasó de **$11,036,349.99 a $11,368,887.09** (+$332,537.10, lo
capturado en las 38 canceladas, exactamente lo que predijo la medición); los vales en $0.00, de 39 a 1. La fila de
0000119 dice ahora «● Se canceló en Kepler con su gasto ya generado: ¿salió dinero?», con $3,215.00 y «en Kepler quedó
en $0.00».

**Pruebas:** contrato 45 ✓ (6 nuevos), Expediente 57 ✓ (3 nuevos), y la sección I de la prueba contra Postgres
(35 ✓), que compara el Expediente con un control independiente leído como superusuario: 38 canceladas (25 con
gasto), ninguna mal dicha, todas con lo capturado, y el total igual a la suma de sus vales. 4 mutantes → rojos
(dos del contrato, uno de la pantalla y uno del servidor).

**Para decidir (DG13):** las 13 canceladas sin gasto ($266,457.05) no aparecen en la cola: GX.96 sólo marca las
canceladas con gasto. Ver §10.

### 14.7 G.UI.1c — «Canceladas en Kepler», su propia lista (2026-11-16)

**El pedido** (Francisco, al ver DG13): «agregar una pestaña con los documentos cancelados». Mejor que la recomendación
(plegarlas en la cola): una cancelada no espera nada de Kepler, y mezclarla con lo que sí espera junta dos preguntas.

**Medido antes de construir:**

| | Con su gasto ya generado | Sin gasto | Total |
|---|---:|---:|---:|
| **Prod** (sólo lectura, `system_identifier` verificado) | 29 · $69,476.21 | **14 · $267,457.05** | 43 · $336,933.26 |
| Copia local | 29 · $69,476.21 | 13 · $266,457.05 | 42 · $335,933.26 |
| Dónde estaban | plegadas en «Esperan a Kepler» | **en ninguna lista**: el servidor las descartaba | |

**Las cinco preguntas** (`diseno` §0b), por escrito antes de la plantilla:

1. **Qué ve y en qué orden:** «N canceladas en Kepler · $X», cuántas con gasto y cuántas sin él; primero las que
   tenían gasto («¿salió dinero?»), después las que no («¿se volvió a capturar con otro folio?»).
2. **Qué no ve:** lo que espera a Kepler (tiene su lista); las canceladas salen de «Esperan a Kepler».
3. **Accesibilidad:** el folio abre el vale en el panel sin perder la lista (Esc regresa al folio); el monto es lo
   capturado y lo que dejó Kepler va al lado; quién capturó y quién revisó, por su nombre.
4. **Ligas:** el vale y su solicitud cancelada (el panel dice «Kepler: cancelada»). El pago que contestaría
   «¿salió dinero?» (X-D-26) hoy no se mide aquí: es la propuesta de abajo.
5. **¿Le toca a esta pantalla?** Sí: Aprobación es donde se revisan los vales ya firmados; el Expediente ya los marca
   uno por uno (G.UI.1b).

**Cómo quedó** (copia local): en el selector, «Esperan a Kepler» pasó de **176 · $1,353,067.09 a 147 · $1,283,590.88**
y apareció «Canceladas en Kepler» con **42 · $335,933.26** (las 29 que se movieron y las 13 que no salían); 147 + 29 = 176
y las sumas cuadran al centavo. Dentro: «42 canceladas en Kepler · $335,933.26 — con su gasto ya generado: 29 · sin
gasto: 13», dos secciones con su conteo y monto, y el renglón sin repetir el título de su sección (antes, la misma
frase 29 veces): «en Kepler quedó en $0.00 · capturó … · revisó …». La lista lo dice: **todavía no hay cómo darlas
por revisadas**. Celular sin desborde; el panel de una cancelada sin gasto dice «Comprobado · Kepler: cancelada».

**Lo que la lista no podía resolver (la salida):** una cancelada se quedaba aquí para siempre; nada la cerraba. ✅ **Resuelto en §14.8**
(Francisco aprobó la propuesta el 2026-11-16: «sí me late, avanza»). La propuesta era:

- **Con gasto («¿salió dinero?»):** la Suite puede contestarlo sola si encuentra el pago (X-D-26) de ese gasto, como el
  Expediente ya lee las transferencias de un gasto (GX.75); entonces el renglón dice «Sí: XD2601-… pagó $X el …» o
  «No hay pago registrado», y una persona confirma.
- **Sin gasto:** si la solicitud se volvió a capturar con otro folio, ligar el vale al folio nuevo; si no, rechazarlo
  o anotar por qué se queda.

**Pruebas:** Aprobación 120 ✓ (4 nuevos: la sin gasto se ve, ningún vale en dos listas, sin leer Kepler no afirma
nada, vacía lo dice), reglas de la cola 15 ✓, contrato 46 ✓, y contra Postgres 36 ✓: la cola trae las 39 canceladas
sin gasto ligado del control independiente, también las 13 que no tenían gasto. 3 mutantes → rojos (la regla de la
cola, el conteo de la pantalla y el servidor).

**NO MEDIDO:** la lista contra prod con el código nuevo (se mide al desplegar) · `forced-colors` y lector de pantalla.

### 14.8 G.UI.1d–1e — la Suite lo contesta sola y una persona cierra el caso (2026-11-16)

**El pedido** (Francisco, sobre la propuesta de §14.7): «sí me late, avanza».

**Medido antes de construir** (prod, sólo lectura, `system_identifier` verificado):

| | Lo que encontró | Lo que puede decir la Suite |
|---|---|---|
| Con gasto (29) | forma de pago del vale: 14 efectivo · 7 transferencia · 4 tarjeta · 4 otro; 38 X-A-10 (35 cancelados); **sólo 1 con pago aplicado** (X-D-26; ningún X-D-25) | efectivo: «salió de caja»; con pago: «Kepler lo pagó: XD2601-…»; el resto: «sin pago en Kepler: búscalo» (en el banco o el estado de cuenta) |
| Con gasto: recaptura | 0 libres; **2 cuya recaptura ya tiene su propio vale** | «éste puede estar repetido» → rechazar |
| Sin gasto (14) | **2 con una recaptura clara** (sin autorizar, fechas cercanas), 1 con 6 iguales (un gasto que se repite), 11 ninguna | «Posible recaptura: XA1501-…» → ligar; con varias, no se adivina |

⚠️ «Sin pago en Kepler» **no** es «no salió dinero»: por eso el texto dice dónde buscarlo según la forma de pago, y el
efectivo se dice como salido de caja.

**Cómo quedó:**

- **La pista** (`pista-cancelada.ts`, en lote, en su propio punto de guardado; `lecturaDeLaCancelada` en el contrato):
  cada renglón de «Canceladas en Kepler» dice el dinero y la recaptura. En la copia local: 42 con pista, 2 para ligar
  (las mismas 2 de prod: 0010188 → 0010181 y 0010420 → 0010418), 2 «repetido».
- **El cierre**, con un diálogo que muestra la pista y no se cierra solo si hay algo escrito:
  - **«Ligar a XA1501-…»**: sólo a la recaptura que propone la pista (una sola, libre); el servidor la vuelve a calcular
    antes de escribir. Es un UPDATE del folio del mismo vale, como el casamiento de GX.9, con la auditoría en
    `capture_meta.religado` (de qué folio, a cuál, quién, cuándo). El vale sigue su camino con su solicitud nueva.
  - **«Rechazar por repetido»** (sólo si la recaptura ya tiene su vale): el rechazo de siempre, con el motivo escrito.
  - **«Ya lo revisé»**: con lo que se hizo o por qué se queda así (3 a 500 letras); va plegado en «Revisadas», con quién y
    cuándo. Guarda en tres columnas nuevas del vale (`kepler_cancel_reviewed_at`, `_by`, `kepler_cancel_note`;
    migración **`20261117005015_pgp123_canceladas_revisadas`**, nulas y con CHECK). Sin la migración, la pantalla no
    ofrece cerrar y lo dice.
  - Quien capturó el vale no cierra su propio caso (la guarda de GX.65.4a).
- La lista cuenta lo **pendiente** («N canceladas por revisar»); lo revisado va plegado con su conteo.

**De punta a punta en la pantalla viva** (copia local, restaurada después al centavo): «Ya lo revisé» mandó
`POST …/cancelada/revisar` con `{ nota }` y la lista pasó a 41 por revisar con «Revisó … el 17/11/26: …»; «Ligar» mandó
`POST …/cancelada/ligar` con `{ folio: "0010181" }` (201, «ligada»), el vale salió de la lista y apareció en «Esperan a
Kepler» como «Falta que la autoricen».

**Pruebas:** contrato 52 ✓ (la pista, la nota), diálogo 6 ✓, reglas de la cola 15 ✓, Aprobación 123 ✓, biblioteca de
finanzas 369 ✓ (dos guardas de fuente respetadas: el importe se lee de la vista y los usos nuevos de la identidad se
declaran), contra Postgres 52 ✓ (J: la pista contra un control independiente; K: ligar y revisar con el payload de la
pantalla, con sus rechazos: otro folio, folio mal formado, el dueño, sin nota, dos veces, un vale que no es cancelada),
la migración con su `up()` real 7 ✓ (con la prueba negativa del CHECK). 7 mutantes → rojos; uno destapó que la prueba
de «ligar a otro folio» pasaba por el índice único y no por la regla: se corrigió con un folio vivo, sin vale y de otro
total.

**Para Edgar:** la migración `20261117005015` va con la de G.6 (`20261115124001`) antes de soltar PGP.123.

**NO MEDIDO:** el cierre contra prod (se mide al desplegar) · X-D-25 (cheques) no se busca: en prod no hubo ninguno en
estas 29 · `forced-colors` y lector de pantalla.

### 14.9 G.UI.1f — la comprobación es de la sucursal, no de Finanzas (2026-11-17)

**La pregunta** (abierta desde §14.5): la cola decía «Las comprueba Finanzas, en Kepler» y el panel «Le toca a Finanzas,
en Kepler». ¿Quién captura el «Alta gasto CFDI»?

**La respuesta de Francisco**, con el proceso entero:

| # | Paso | Quién | Dónde vive en la Suite |
|---|---|---|---|
| 1 | Levanta la solicitud de gasto (X-A-15) | la sucursal | «Registrar o pedir» (PGP.122) |
| 2 | La autoriza | Finanzas | Aprobación de gastos; al firmarla, la solicitud se escribe autorizada en Kepler (PGP.122) |
| 3 | **Hace la comprobación** (X-A-10, «Alta gasto CFDI») | **la sucursal, o quien pidió el gasto** | la evidencia se sube en «Mis gastos» y se revisa en Aprobación; el X-A-10 lo escribe la Suite (G.2–G.9, hoy apagado) o, mientras, la sucursal en Kepler |
| 4 | Programa el pago | Finanzas (Presupuesto) | Calendario de pagos, «Por preparar». El X-A-10 es lo que trae el gasto al calendario (categoría «gasto», PGP.18) |
| 5 | Aprueba el programa | Tesorería | Calendario de pagos, «Por autorizar» |
| 6 | Lo ejecuta | Caja General | Calendario de pagos, «Por pagar»; el X-D-26 se aplica al X-A-10 (LE.2.13) |
| 7 | Registra el pago y guarda su evidencia | analista de egresos | Calendario de pagos, «Por registrar en Kepler» → «Pagados» |

⭐ El paso 3 es el puente entre pedir y pagar: sin X-A-10 el gasto no llega al calendario y el X-D-26 no tiene a qué
aplicarse.

**Cómo quedó:** `QuienResuelve` ya no tiene `kepler` («Finanzas, en Kepler» para todo lo que se hace a mano allá). Se
partió en dos:

- `sucursal` — «la sucursal, en Kepler»: lo que se comprueba a mano (otro importe, saldo ya usado, factura que no casa,
  fecha futura) y lo que se comprobaría solo pero su base todavía no escribe (hoy, todo). En la cola, la sección «Las
  comprueba la sucursal, en Kepler» va primero.
- `finanzas` — «Finanzas, en Kepler»: autorizar la solicitud, la cancelada, y lo que la Suite intentó y no quedó
  (atorado, rechazado, cancelado o en duda), porque decide si se reintenta y el botón está en su panel.

Contabilidad (DG1, DG6) queda igual. `quien` se calcula en cada lectura y no se guarda: el cambio no toca datos.

**Pruebas:** contrato 62 ✓ (con la de quién), pantalla 194 ✓, contra Postgres 52 ✓ · 0 ✗ (D: el vale de otro importe le
toca a la sucursal). 4 mutantes → rojos: el otro importe de vuelta a Finanzas, «sin autorizar» a la sucursal, lo listo en
base cerrada a Finanzas y lo que la Suite intentó a la sucursal.

**Ya estaba medido** (§2): el X-A-10 lo captura la misma persona que capturó la solicitud en el **91.1 %** de los casos
(placebo: 32.0 %); en 00, una sola persona captura el 48.9 %. O sea: casi siempre, quien pidió el gasto.

**Lo que queda abierto:** «Mis gastos», la pantalla de quien pidió, pone el vale revisado sin gasto en la columna «Esperan
a Kepler» con «Autorizada: falta generar el gasto en Kepler», como si esperara a otro. Según el proceso le toca a quien
lo pidió. Moverlo a «Te toca» (salvo lo que la Suite va a escribir sola) es el siguiente paso, en otro PR: pide que «Mis
gastos» sepa lo mismo que la cola (la regla G.5 y si la base escribe).

### 14.10 La revisión independiente del PR (2026-11-17)

**Qué se hizo.** Antes de abrir el PR, un revisor sin las conclusiones de quien lo construyó leyó el código del commit
armado. Encontró 12 problemas. Todos se confirmaron leyendo el código, y lo que se podía medir se midió en prod (sólo
lectura). Ninguno producía dos X-A-10 ni cruzaba datos entre empresas, y el escritor nace apagado: nada de esto llegó a
escribir en Kepler. Pero encenderlo no cambia código, así que lo que el PR afirma tenía que ser cierto desde ya.

| # | Lo que encontró | Medido en prod | Cómo quedó | La prueba |
|---|---|---|---|---|
| 1 | Si la factura del vale no se podía leer (o no estaba en la Suite), la regla la tomaba como «sin factura» y podía dar el gasto por listo | 0 vales validados con factura ligada desde el 1-oct. `fiscal.cfdis` guarda los 455,907 UUID en mayúsculas; la bandeja del SAT, en minúsculas | `cfdi_declarado`: sin la factura leída, «sin medir». Se busca por igualdad (las dos formas) y con el tenant, para usar el índice único | contrato · D2 |
| 2 | El escritor no comparaba la X-A-15 viva con lo que aprobó la regla | — | `esperado` (total, acreedor, fecha) es obligatorio; `cambioContraLoAprobado` antes de armar; si cambió, rechazo reintentable | escritor (unidad y [10]) |
| 3 | Un vale «en duda» cuya escritura sí quedó no se resolvía nunca: el ciclo sólo tomaba solicitudes en A y la regla se aplicaba antes de buscar | — | «en duda» se averigua primero (el ODS, luego Kepler); el ciclo la toma fuera de A; el ODS resuelve las dudas en todas las sucursales; el latido cuenta las que quedan | M1–M4 |
| 4 | «Ligar» arrastraba el estado del gasto de la solicitud vieja, y se ofrecía aunque la cancelada tuviera su gasto vivo | de las 29 con gasto, ninguna tenía una recaptura libre | ligar limpia `kepler_expense_*` (queda en `religado.gasto_anterior`); la pista trae `gasto_vivo` y con él no se liga | contrato · K, K3 |
| 5 | «Cancelado» guardaba el folio: «Reintentar» no hacía nada, y la cola daba el vale por comprobado (`analytics.expense_documents` cuenta los X-A-10 cancelados) | 2 vales con la solicitud en A y su único gasto cancelado, que no salían en ninguna lista | el lazo suelta el folio y la póliza (quedan en la nota); la cola cuenta sólo gastos vivos | B · L |
| 6 | Rechazar un vale no miraba su X-A-10 | — | 409 mientras se escribe, o si la Suite lo escribió y sigue vivo; con candado de fila | N |
| 7 | En los vales casados por GX.9 la regla comparaba contra el total de Kepler, que siempre es igual | 0 validados con diferencia | `totalParaComprobar`: manda lo declarado si difiere | contrato |
| 8 | El CHECK de la revisión dejaba pasar una nota vacía (NULL) | — | `coalesce(…, false)`; el `up` rearma el CHECK | migración 9 ✓; con la versión anterior, ✗ |
| 9 | Una nota de dos emojis pasaba aquí y la base la rechazaba con un 500 | — | se cuentan caracteres, como `char_length` | contrato |
| 10 | Dos «Ligar» a la vez a la misma recaptura | — | candado `pg_advisory_xact_lock` por tenant, sucursal y folio | **NO MEDIDO**: sin prueba de concurrencia |
| 11 | «Ligar» no revisaba si el caso ya se había cerrado | — | 409 | K2 |
| 12 | El folio que viene de Kepler sin rellenar a 7 dígitos | 0 X-A-10 en prod con otro largo | `lpad` | sin prueba propia |

**Lo que no se cambió, y queda dicho.** El Expediente y `analytics.expense_requests.aplicada` (de GX) siguen contando
un X-A-10 cancelado como gasto; la cola de comprobación ya no. Cambiar esas vistas compartidas es otro trabajo, con su
medición antes y después (regla 15).

**Dos trampas que costaron una vuelta y valen para cualquiera:** dentro del SQL de un `knex.raw`, un `?` en un comentario
es un parámetro («¿salió dinero?» se volvió `$2`), y un acento grave en un comentario de SQL cierra la plantilla de JavaScript.

**Pruebas después de los arreglos:** contrato 87 ✓ · finanzas 402 ✓ · pantallas de gastos 447 ✓ · escritor 10 ✓ y contra Postgres 46 ✓ · de punta a punta contra Postgres 68 ✓ · migración real 9 ✓ (con la versión anterior, 1 ✗) · 16 mutantes en 10 grupos → rojos · ngc 0 errores. Cada mutante rompe un arreglo a la vez (o varios que no se tocan entre
sí) y su prueba sale en rojo; los archivos se restauran y se verifica que quedaron igual.

## 15. El primer gasto escrito por la Suite (2026-11-20)

Edgar firmó DG1–DG12 y pidió encender **sin esperar G.1**. Qué se hizo, en orden:

1. **Ensayo con ROLLBACK** del escritor real desde `md`, con una solicitud lista por base: 02 `0000371`, 04 `0000132`,
   05 `0000092`, 07 `0000185`. Las cuatro en verde: cero fallas, los diez permisos, el contador al día y el control
   (contador, solicitud, gastos, máximo de la póliza D, `kdxe`, `kdcn26`) igual antes y después.
2. **Bandera** `KEPLER_GASTO_COMPROBACION=encendida` con `kubectl patch` (52 → 53 llaves), anotada en el maestro; `api` y
   `worker` reiniciados.
3. **Canario: 05 encendida con tope 1.** El cron tomó el vale más antiguo (una solicitud de octubre: ya tenía su gasto
   tecleado en Kepler, el lazo lo reconoció) y después la solicitud `0000092`: **X-A-10 `0000090`**, $1,100.00,
   póliza `kdc22611` D 369. En el Kepler vivo: el gasto con `c67 = SUITE`, la solicitud en `F` con saldo 0, la
   cuenta por pagar por $1,100, la póliza cuadrada (abono 201, cargo 611-007 con su departamento), el contador en 91 y
   un solo gasto vivo de esa solicitud. El ODS ya lo veía en el siguiente ciclo.
4. **05 se volvió a apagar.** El siguiente en la cola lo frenó el tope, y los nueve siguientes de 05 (comisiones
   bancarias, acreedor GB004) traen el aviso «el comprobante dice …»: con DG12 = no, no se escriben solos, y DG12
   todavía no estaba en prod.

**Lo que DG12 cambia (G.13):** en la base, 628 de 2,254 vales validados en 60 días traen ese aviso (28 %). Validar desde
la revisión borra `revision_nota`: lo que se validó así antes de G.13 perdió su aviso y no se puede recuperar
(NO MEDIDO cuántos). Desde G.13 el monto queda en `monto_ocr`, y las pantallas que ya leían esa columna (el panel de la
evidencia, capturas sin folio) vuelven a decir «difiere».

**G.1, el mismo día (con el ejemplo de Edgar: 08, X-A-10 0000412 → póliza D 3,757):** no hay contador escondido (§3.6).
Ninguna tabla chica de Kepler guarda un valor cercano al máximo de la D (ni `sqliov`, ni el ODS, ni `kdfolio`, que
guarda `PD26-` = 740 y `PD-` = 98,335); en vivo, en 01, ninguna tabla se mueve una vez por póliza fuera del folio del
documento; y en el ODS el 98 % de las D de las cinco bases es «máximo del mes + 1». El salto a la «serie corrida» lo hace
siempre un X-D-55 con el número del mes anterior. **DG7 se retira** y el ensayo con ROLLBACK sale verde también en 00
(`0010967`, póliza 31,876), 01 (`0000216`, 5,471), 03 (`0000220`, 948), 06 (`0000354`, 3,158) y 08 (`0000454`, 3,766).

**Lo que sigue:** DG12 y el retiro de DG7 a prod → encender 05 y, si su primera semana sale limpia, las demás con su
tope (00 primero: es la mitad de la cola).
