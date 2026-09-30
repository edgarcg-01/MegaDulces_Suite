# Auditoría del Catálogo de Documentos de Kepler (`kdmm`) — 9 servidores

> **Medido el 2026-09-29** contra `kepler_ods.kdmm` en prod (`md:5434`). Re-ejecutable con
> [`database/scripts/kdmm-doctype-diff.sql`](../../database/scripts/kdmm-doctype-diff.sql).
> Pantalla del ERP: *Sistemas › Configuración › Configuración de operación › Catálogo de documentos*.

---

## 0. Resumen

| | |
|---|---|
| Servidores comparados | **9** (`00`…`08`), los 9 Kepler de la red |
| Doctypes por servidor | **171** (176 en `08`) |
| Idénticos en los 9 | **161 de 171** comunes (94 %) |
| **Divergen** | **10 doctypes**, en **12 campos** |
| Exclusivos de un servidor | 5 (`U-D-10-6..10`, cajas 6–10 de Morelia Abastos) |

**El catálogo está sano en su mayoría.** Lo que diverge es poco, pero **tres de los diez casos
mueven dinero hoy** y dos explican problemas ya documentados en otras fases.

⛔ **La mayoría NO es la verdad.** En varios casos los 8 servidores que coinciden son los que
**nunca usan** ese documento (traen el valor de fábrica) y el que diverge es el único que lo
emite. Homologar "hacia lo que dicen los más" rompería contabilidad. Ver §4.

---

## 1. Fuente y decode

**Fuente:** `kepler_ods.kdmm` — vista viva del ODS, cero importers (regla principal del proyecto).
Verificado: los conteos del ODS coinciden **fila por fila** con las 9 réplicas `md.kdmm` de
`pgvector-md` (`:5433`), que son copia directa de cada servidor Kepler.

**Decode — probado, no adivinado.** El ancla es la fila `X-D-20-1` "Pago prov. Efectivo" de la
sucursal `01`, contrastada campo por campo con la pantalla del ERP:

| Col | Campo en la pantalla | Cómo se probó |
|---|---|---|
| `c1..c4` | Género · Naturaleza · Grupo · Tipo | PK, ya documentada en `ERP_KEPLER.md` §3 |
| `c5` | Descripción | ancla |
| **`c6`** | **Afectación BD → Contabilidad** | ⭐ **11 de 33** doctypes con `S` generaron póliza en ago-2026 (`md_03.kdc22608`); **0 de 138** con `N`. Separación perfecta |
| **`c7`** | **Afectación BD → CXC/CXP** | ⭐ contrastado contra la cartera `kdue`: ver §3.1 |
| `c8` | Afectación BD → Inventario | ya documentado en `ERP_KEPLER.md` |
| `c15`·`c16`·`c33` | Retención ISR% · IVA% · IVA Ret.% | dominios `{0,10}`, `{0,16,99}`, `{0,10.67}`; y existen doctypes hermanos "Pago prov. Efectivo **0%**" / "**8%**" que sólo se distinguen por `c16` |
| `c17` | Archivo de folio | ancla (`KFXD2001`) |
| `c18` | Tipo de póliza | ancla (`E`); dominio `{D,E,I}` |
| `c19`·`c20` | Cuenta cargo · Cuenta abono | ancla (`210` / `110-001`) |
| `c21`·`c22` | Cuenta IVA · Cuenta IEPS/Retención | ancla (vacías) |
| **`c25`·`c26`** | **Campo a añadir a la cuenta principal / secundaria** | ⭐ valen `45` y `47` = `kdm1.c45`/`c47` = banco origen/destino. Verificado: esos campos **sí traen el banco** (`6506`→`4166`…) |
| `c55` | Documento revisado y validado | dominio `{'', N}` |
| **`c56`…`c61`** | **Panel "Control": fecha/usuario/hora de última modificación** | **se EXCLUYEN del diff** — divergen en 170 de 171 doctypes por definición |

⚠️ Si no se excluyen `c56`–`c61`, el diff reporta **170 doctypes divergentes** y el resultado
real (10) queda enterrado.

---

## 2. Los 9 servidores

| Suc | Nombre en Kepler (`pv_suc_ip`) | Host |
|---|---|---|
| `00` | Cedis Oficinas | `mddlacedis.ddns.net` |
| `01` | Sucursal Hidalgo (Padre Hidalgo) | `mddlaph.ddns.net` — `192.168.10.10:1977` |
| `02` | Sucursal La Piedad Abastos | `mdabastos.ddns.net` |
| `03` | Sucursal 8 Esquinas | `md8esquinas.ddns.net` |
| `04` | Sucursal Yurécuaro | `mdyurecuaro.ddns.net` |
| `05` | Sucursal Zamora Centro | `mdzamora.ddns.net` |
| `06` | Sucursal Canindo | `mdcanindo.ddns.net` |
| `07` | Sucursal Morelia Madero | `mdmoreliamadero.ddns.net` |
| `08` | Sucursal Morelia Abastos | `mdmoreliaabastos.ddns.net` |

---

## 3. Las divergencias, por impacto medido

### 3.1 ⛔ `U-D-12-1` "Factura Cont No Fiscal" — **275 facturas / $176,127.80 fuera de la cartera**

| | 00 | 01 | 02 | 03 | 04 | 05 | 06 | 07 | 08 |
|---|---|---|---|---|---|---|---|---|---|
| `c7` afecta CXC/CXP | S | **N** | **N** | S | S | S | S | S | S |

Consecuencia **medida** (12 meses, documentos sin fila en `kdue`, con `NOT EXISTS`):

| Suc | `c7` | Docs 12m | **Sin cartera** | Importe |
|---|---|---|---|---|
| 00 | S | 161 | 1 | $0.00 |
| **01** | **N** | 1,776 | **187** | **$159,718.60** |
| **02** | **N** | 760 | **88** | **$16,409.20** |
| 03–08 | S | 2,105 | **0** | — |

Las 7 sucursales con `c7='S'` tienen **cero** documentos fuera de la cartera. Las dos con `N`
pierden ~11 % de sus facturas. **Dirección de homologación: `01` y `02` → `S`.** Es el único
caso donde la mayoría y la evidencia apuntan al mismo lado.

> ⚠️ El nombre engaña: "Contado" haría pensar que no debe generar cuenta por cobrar. La
> medición dice lo contrario — en las 7 sucursales con `S` el documento entra a `kdue` y se
> liquida ahí mismo. Con `N` simplemente **no queda registro**.
>
> ⚠️ Al medirlo con `LEFT JOIN` el conteo se infla (`kdue` tiene varias filas por folio en `03`:
> 878 → 1,584). La cifra de arriba está medida con `NOT EXISTS`, que no se abre.

### 3.2 ⛔ `X-A-10-1` "Gastos" — el mismo gasto en dos pasivos distintos

| | 00 | 01–08 |
|---|---|---|
| `c20` cuenta abono | **`203` PROVEEDORES DE SERVICIOS** | `201` PASIVO A PROVEEDORES |

`c6='S'` en las 9 → **sí genera póliza**. Volumen 12m: **8,885 gastos en `00`** contra 459 en
`01`/`02`/`03` y **0** en las otras cinco. Es decir: el 95 % de los gastos de la empresa abona a
`203` y el 5 % a `201`, por configuración, no por naturaleza del gasto.

⛔ **No homologar "hacia la mayoría" sin contabilidad.** Las 8 sucursales casi no emiten este
documento; su `201` es el valor sin ejercer. **La decisión es contable**: o todo a `201`, o todo
a `203`, y el histórico ya está partido. Ambas cuentas existen y se usan (`201`: 44,965 asientos;
`203`: 4,799).

### 3.3 ⛔ `X-D-55-1` "Nota crédito" (a proveedor) — el IVA no se separa en el CEDIS

| | 00 | 01–08 |
|---|---|---|
| `c16` IVA% | **`0`** | `16` |
| `c21` cuenta IVA | `122-001` (configurada en las 9) | `122-001` |

`c6='S'` en las 9. Volumen 12m: **1,339 notas en `00`**, 35 en el resto. Con la tasa en 0 % el
importe entra completo a `513` DESCUENTO SOBRE COMPRAS y **nunca toca `122-001` IVA acreditable**,
aunque la cuenta está configurada.

⭐ **Esto coincide con un descuadre ya documentado.** `KEPLER_CONTABILIDAD_MODELO.md` registra:
*"partida doble descuadra −$981k desde ene-2026 (bug **XD5501**: abono huérfano a `122-001` IVA)"*.
`XD5501` **es** `X-D-55-1`, y es el único doctype cuya tasa de IVA diverge, justo en la sucursal
que emite el 97 % de ellas. **Hipótesis con evidencia, no causa probada** — falta que contabilidad
confirme si esas notas llevan IVA.

### 3.4 ⛔ `N-A-26-1` "Transferencia bancaria" — por qué Kepler colapsa todo en la cuenta `102`

| | 00 | 01–08 |
|---|---|---|
| `c25` campo → cuenta principal | **`0`** | `45` |
| `c26` campo → cuenta secundaria | **`0`** | `47` |

Cargo y abono son `102` en las 9. Los campos `45`/`47` son `kdm1.c45`/`c47`, que **sí traen el
banco** — verificado en los documentos de agosto de `00`: `6506`→`4166`, `5854`→`4166`,
`3041`→`7744`… Con `c25/c26 = 0` el ERP **no los concatena**, así que la póliza queda en `102`
genérica: medido en `md_00.kdc22608`, **221 cargos y 221 abonos, todos a `102`**, ninguno a
`102-XXXX`.

`N-A-26-1` es **el único doctype de los 171, en los 9 servidores, que usa este mecanismo** — y está
apagado exactamente en la sucursal que concentra **1,065 de las 1,066** transferencias.

Alcance del colapso en todo el mayor Kepler (`analytics.gl_poliza_lines`, `source='kepler'`):

| Forma de la cuenta | Líneas | Importe |
|---|---|---|
| `102` genérica (sin banco) | **48,217** | **$1,268,612,698.21** |
| `102-XXXX` (banco resuelto) | 1,384 | $1,285,860.65 |

⭐ **Esto explica un hallazgo abierto de la Fase CB** (conciliación bancaria), que documenta
*"el workbook = detalle por banco que Kepler colapsa en `102` único"*. La causa es de
configuración, no del ERP. **Encender `c25`/`c26` en `00` (a `45`/`47`) haría que Kepler emita el
banco en la póliza** — con el impacto contable que eso implica, a validar antes de tocarlo.

### 3.5 ⚠️ `U-D-41-1` "Embarque Telemarketing" — Yurécuaro contabiliza distinto

| Campo | 00–03, 05–08 | **04 Yurécuaro** |
|---|---|---|
| `c6` afecta Contabilidad | `N` | **`S`** ← genera póliza que nadie más genera |
| `c19` cuenta cargo | `115` (clientes) | **`116`** (traspasos de mercancía) |
| `c20` cuenta abono | `410-142-005` | **`420`** (traspaso a sucursales) |
| `c21` cuenta IVA | `207-001` | **(vacía)** |
| `c22` cuenta IEPS | `207-002` | **(vacía)** |

En `04` el embarque de telemarketing se contabiliza como **traspaso interno de mercancía**, no
como venta, y sin IVA. Volumen: **2 documentos en 12 meses en `04`** contra 5,096 en el resto
(2,106 en `02`, 1,344 en `01`). Impacto hoy casi nulo, **pero es un descuadre esperando volumen**:
si Yurécuaro empieza a facturar telemarketing, sus ventas entran a traspasos.

**Dirección clara: alinear `04` a las otras 8.** Acá la mayoría sí es la verdad (las 8 lo usan,
`04` no).

### 3.6 ⚠️ `X-A-45-1` "Nota Cargo a Proveedor" y `X-A-50-1` "Documento por Pagar"

| Campo | 00 | 01–08 |
|---|---|---|
| `c6` Contabilidad | **`S`** | `N` |
| `c16` IVA% (sólo `X-A-45-1`) | **`0`** | `16` |
| `c19` cargo | **`102`** | `616-002` / `214-002` |
| `c20` abono | **`210-001`** | `210` |
| `c21` IVA | (vacía) | `123-001` |
| `c41` extra | (vacía) | `124-001` |

Volumen 12m: **275** notas de cargo en `00`, 1 en `02`, 0 en el resto. `X-A-50-1`: **0 en todas**.

En las 8 sucursales `c6='N'` → **nunca generan póliza**, así que sus cuentas (`616-002`,
`214-002`, `123-001`, `124-001`) son decorativas: **0 asientos en 15 meses en las 9 sucursales**
(jul-2025→sep-2026). La configuración ejercida es la de `00`.

**Dirección: la de `00`** — pero conviene decidir antes si las 8 deben poder emitir el documento.

### 3.7 🟡 Bajo impacto — revisar, no urgente

| Doctype | Campo | Divergencia | Volumen 12m |
|---|---|---|---|
| `X-D-50-1` Ajuste Abono General | `c20` | `513` en 02–05 · `515-003` en 00,01,06,07,08 | **2 docs**. `c6='N'` → **no genera póliza**, la diferencia es inerte hoy. `515-003` tiene **0 asientos** en 15 meses; `513` tiene 1,338 |
| `U-D-60-1` Documento por Cobrar | `c19` | `121` en 00 · `115` en el resto | 3 docs |
| `U-D-41-1` | `c5` | Zamora (`05`) sin el punto final: `"Embarque Telemarketing"` | cosmético |
| 4 doctypes | `c55` | "Documento revisado y validado" marcado en distintas sucursales | sin efecto funcional |
| `U-D-10-6..10` | — | Sólo existen en `08` (cajas 6–10) | legítimo: más cajas |

---

## 4. Cuál es la verdad absoluta (ADR-059)

⛔ **No es un servidor.** Ni el que manda, ni el que tiene mayoría, ni el que emite. Por ADR-059
la verdad se **arbitra** contra un testigo **independiente del catálogo que se está juzgando**, y
lo que no tiene árbitro **se declara**. Un catálogo no puede probarse contra otra copia de sí mismo.

### 4.1 La línea base homologada YA existe, y tiene fecha y autor

`c57`/`c58`/`c60` (el panel *Control* del ERP) lo dicen sin ambigüedad: las 8 sucursales fueron
configuradas en **cargas masivas, idénticas al milisegundo**:

| Doctype | Línea base en las 8 | Quién divergió |
|---|---|---|
| `X-D-55-1` Nota crédito | **2025-11-16 23:23:41.5 · `MD`** | `00` el **2026-07-14** por `40` |
| `X-A-10-1` Gastos | **2025-11-26 14:49:25.5 · `MD`** | `00` el **2026-05-26** por `61` |
| `N-A-26-1` Transf. bancaria | **2026-04-14 10:55:11.6 · `GRJ`** | `00` el **2026-07-08** por `0MCRV` |
| `U-D-12-1` Factura Cont NF | **2025-11-18 13:09:13.4 · `MD`** | `02` el 2026-04-20 · `01` el **2026-09-24**, ambas por `61` |

⭐ **Ninguna divergencia es "criterio de la sucursal": las 10 son ediciones manuales posteriores
sobre una base que ya estaba homologada.** Eso cambia la pregunta: no es *"¿cuál copiamos?"* sino
***"¿por qué se editó, y el árbitro le da la razón?"*** — y ahora se sabe a quién preguntarle.

⚠️ **`c57` guarda SÓLO la última modificación, no un historial.** En la `01` el daño empieza en
**agosto** y la última edición es del **24-sep** → hubo al menos **una edición intermedia que se
perdió**. El catálogo de documentos no tiene bitácora: es el hueco `VP.3` (historia de datos
maestros) aplicado al ERP.

### 4.2 El árbitro de cada campo

| Campo | Árbitro (independiente de `kdmm`) | Veredicto | Estado |
|---|---|---|---|
| **`c16` IVA%** | el **CFDI recibido** (`fiscal.cfdis`) | **88.0 %** de los CFDIs de egreso (2,347 de 2,667 · **$2,753,967.90** de IVA/12m) traen IVA trasladado → **la verdad es 16 %** | ✅ **medido** |
| **`c7` CXC/CXP** | la **cartera** `kdue` | las 7 con `S` → **0** documentos huérfanos; las 2 con `N` → **275 / $176,127.80** → **la verdad es `S`** | ✅ **medido** |
| **`c6` Contabilidad** | las **pólizas** `kdc22YYMM` | **11/33** con `S` postean · **0/138** con `N`. Separación perfecta: el campo hace lo que dice | ✅ **medido** |
| **`c25`/`c26` banco** | **`kdm1.c45`/`c47`** del propio documento + el estado de cuenta (Fase CB) | el banco **sí viaja en el documento** (`6506`→`4166`…) y `00` no lo usa → **la verdad es `45`/`47`** | ✅ **medido** |
| **`c19`/`c20` cuentas** | *(se buscó ContPAQi, el SoR contable de ADR-040)* | ⛔ **NO SIRVE**: son **dos planes de cuentas distintos**. ContPAQi no tiene `201`, `203` ni `513` — su pasivo a proveedor es **`212`** (11,493 filas) y sus compras **`501`/`502`/`505`-`508`** | ⛔ **SIN ÁRBITRO** |

⛔ **`c19`/`c20` se DECLARA, no se resuelve.** No existe hoy un testigo externo que diga si el
gasto va a `201` o a `203`. Lo único disponible es interno y débil (que la partida doble cuadre).
**Es una decisión contable con dueño humano**, y esta auditoría no la puede tomar.

### 4.3 Dos divergencias no son históricas: están corriendo HOY

**(a) El CEDIS dejó de acreditar el IVA de sus notas de crédito de proveedor.** `122-001` (IVA
acreditable) por mes en `md_00`, doctype `XD5501`:

| Mes | IVA a `122-001` | Base a `513` | Razón |
|---|---|---|---|
| 2026-01 | $292,632.89 | $1,922,564.91 | 15.2 % |
| 2026-02 | $221,556.56 | $1,486,351.18 | 14.9 % |
| 2026-03 | $1,475,562.49 | $9,533,113.04 | 15.5 % |
| 2026-04 | $224,195.18 | $1,500,473.23 | 14.9 % |
| 2026-05 | $222,428.40 | $1,748,406.98 | 12.7 % |
| 2026-06 | $60,267.03 | $1,091,513.30 | 5.5 % |
| **2026-07** ← *config a 0 % el día 14* | $12,259.88 | $1,676,868.62 | 0.7 % |
| **2026-08** | **$0.00** | $948,684.78 | **0 %** |
| **2026-09** | **$0.00** | $594,151.60 | **0 %** |

Ago + sep: **$1,542,836.38** de notas de crédito registradas con **cero** IVA separado, contra un
88 % de CFDIs que sí lo traen. A la razón histórica (12.7 %–15.5 %) son **~$196 k a ~$239 k de IVA
que no se está acreditando** — *estimación por proporción, no medición: el monto exacto exige
cruzar cada nota con su CFDI*. Es el mismo doctype del descuadre de **−$981 k** ya registrado.

**(b) `U-D-12-1` en Hidalgo y La Piedad Abastos: el problema es nuevo y CRECE.**

| Mes | `01` docs / sin cartera | `02` docs / sin cartera |
|---|---|---|
| 2025-10 … 2026-04 | — | 672 / **0** |
| 2026-06 | 26 / **0** | — |
| 2026-07 | 388 / **0** | 22 / **22** |
| 2026-08 | 726 / **58** | 36 / **36** |
| **2026-09** | 636 / **129** | 29 / **29** |

La `02` pasó a **100 % fuera de cartera** desde julio; la `01` arrancó en agosto y va en aumento.
**No es deuda vieja: se está generando este mes.**

### 4.4 Entonces, qué homologar

1. **`c7` de `01` y `02` → `S`.** El árbitro ya falló, el daño es de este mes. **Sin decisión
   pendiente.**
2. **`c16` de `X-D-55-1` en `00` → `16`.** El CFDI manda; hay fecha (14-jul), autor (`40`) e
   importe. **Preguntar por qué se cambió antes de revertir** — pudo haber un motivo que también
   hay que atender.
3. **`c25`/`c26` de `N-A-26-1` en `00` → `45`/`47`.** El dato del banco ya está en el documento.
   ⚠️ Cambia la granularidad de la póliza (de `102` a `102-XXXX`): **validar con contabilidad**.
4. **`U-D-41-1` en `04` → la línea base.** Contabiliza venta como traspaso interno; 2 documentos,
   corregir antes de que tenga volumen.
5. **`c19`/`c20` (gasto `201` vs `203`) → NO homologar todavía.** Sin árbitro. Va a contabilidad
   con nombre y monto: 8,885 documentos, el 95 % del gasto.

---

## 5. Cómo re-verificar

```bash
ssh superoot@192.168.0.222 \
  'docker exec -i pg-prod psql -U postgres -d railway -P pager=off -f -' \
  < database/scripts/kdmm-doctype-diff.sql
```

El script imprime las tres tablas (ausencias · diferencias campo a campo · volumen real).
**Después de cada cambio en el ERP hay que volver a correrlo**: la configuración de documentos no
tiene control de versiones y hoy sólo se sabe que cambió mirando `c56`–`c58`
(fecha/usuario de última modificación), que es justo lo que este diff excluye.
