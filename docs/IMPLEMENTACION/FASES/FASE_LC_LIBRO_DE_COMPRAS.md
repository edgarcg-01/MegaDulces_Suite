# Fase LC — Libro de Compras (el proceso se hace aquí, a ContPAQi solo va el TXT)

> **ADR-052 (propuesto).** El libro de compras deja de armarse a mano en Excel y se
> arma en la plataforma desde el **CFDI** (`fiscal.cfdis`, descarga masiva del SAT).
> Lo único que se entrega para el trámite en ContPAQi es el **TXT de la póliza + su
> respaldo**. Hereda ADR-040: ContPAQi sigue siendo el SoR contable y **nunca le
> escribimos directo** — el asiento lo sube la contadora, como hoy.

## Cómo funciona hoy (verificado 2026-09-01)

```
contador externo → CFDIs → contadora arma "LIBRO DE COMPRAS 2026-.xlsx" a mano
   → convierte a TXT → lo sube a ContPAQi → póliza de Diario folio 1 del mes
```

El workbook tiene una hoja por mes desde `ENE22`, más una hoja `XML` (15,415 CFDIs con
UUID) de la que las hojas jalan por `VLOOKUP`. La fila 891 de cada hoja cuadra **al
centavo** con el folio 1 de diario en ContPAQi los 6 meses de 2026.

**Reconstrucción probada:** las 3,318 patas de las 6 pólizas de 2026 se reconstruyen
al 100% desde el workbook (multiset `cuenta + C/A + importe`, cero residuo por ambos
lados). Las 1,555 patas de proveedor casan 1:1 con las 1,555 facturas.

### Lo que el proceso manual pierde

| Problema | Evidencia |
|---|---|
| **El mes se cae si nadie arma la hoja** | Jul y ago 2026 no tienen hoja → **no existe la póliza**. Balanza 501/502: jul $8.6M y ago $5.3M contra ~$35–40M normales. Los 283 CFDIs de julio ($33,914,548.16) ya están en la hoja `XML`, sin asignar |
| **El UUID se corta en el TXT** | 5,521 patas de compras con **0** asociación CFDI, contra 97% en el resto del diario. ContPAQi sí usa `AsocCFDIs` (948,795 registros) — el TXT simplemente no lo lleva |
| **IVA e IEPS entran como 1 renglón global cada uno** | Sin desglose por proveedor → el acreditamiento no es auditable por factura |
| **El subtotal 0% es un plug** | La hoja lo calcula por resta (`TOTAL − IVA − IEPS − base 16%`), no lo lee del CFDI |
| **Meses sin referencia** | ago-2025 (692 movtos) y dic-2025 (680) van **100% sin folio de factura** |
| **Captura duplicada** | abr-2025: 3 renglones idénticos (cuenta + importe + referencia) por $41,274.95 |

## Por qué el CFDI es mejor fuente que el Excel

`fiscal.cfdis.impuestos` (jsonb) trae el desglose **explícito por impuesto**: `002`=IVA,
`003`=IEPS, cada uno con `Base`, `Importe` y `TasaOCuota`. O sea, la base gravada de
IEPS viene del comprobante — no hay que derivarla al 8% ni dejarla dentro del plug del 0%.
Eso resuelve de raíz los 25 proveedores con tasa implícita menor a 8% y las 4 facturas
donde el IEPS no cabe al 8% (cuota de bebidas u otra tasa).

### La fuente es el ADD de ContPAQi, no la Descarga Masiva (pivot LC.1, 2026-09-01)

Arrancando LC.1 apareció una fuente mejor. En el mismo SQL Server de ContPAQi vive el
**ADD** (Administrador de Documentos Digitales): `document_12677b5d-…_metadata`,
**sincronizado hoy mismo**, con **141,517 CFDIs de ingreso recibidos** desde nov-2022 —
más `E` (26,778), `P` (26,862) y `T` (716). Ya viene normalizado, no hay que parsear XML,
y **no depende de la FIEL** (la de Mega Dulces vencía 2026-07-27).

Contra eso, `fiscal.cfdis` por descarga masiva tenía 1,016 filas del **1 al 17 de julio de
2026** y nada más.

Tablas y decode (verificado, no supuesto):

| Tabla | Aporta |
|---|---|
| `Comprobante` | UUID, emisor, serie/folio, fecha, subtotal, descuento, total, tipo |
| `ImpuestosTotalizados` | `ImporteTotalIVATraslado` y `ImporteTotalIEPSTraslado` por comprobante |
| `Conceptos ⋈ Impuesto_Traslado_Concepto` | **base gravable por impuesto y tasa** (join por `IdConcepto` = `GuidDocument-N`) |
| `Documento` | `IsAsoContabilidad`, `CancelStatus`, `ValidationStatus` |
| `DB_Directory.DatabaseDirectory` | qué ADD está vivo para el RFC (se resuelve en runtime, no se hardcodea) |

Detalle fiscal que el modelo respeta: **la base del IVA incluye al IEPS** (factura De la
Rosa: base IEPS $649,705.34 @8% → base IVA $701,681.77 @0%).

**Prueba de aceptación jun-2026 (238 facturas):**

| Concepto | Resultado |
|---|---|
| UUID presentes en el ADD | 238/238 |
| Total de la factura | 238/238 · $30,278,735.58 idéntico |
| IVA | 238/238 · $598,611.11 idéntico |
| IEPS | 237/238 — ver hallazgo abajo |
| Base 16% | 212/238 exactas; las otras 26 difieren en centavos ($0.65 el mes) porque el workbook la redondea y el ADD la suma del CFDI. **Manda el CFDI** |

### Hallazgo: IEPS por cuota que no se acreditó

**EURO CANDY, folio 335, jun-2026.** El CFDI trae IEPS de **$38,519.05 con
`TipoFactor = Cuota`** (0.141530 por unidad, típico de bebidas saborizadas). El libro
manual lo registró como **IEPS $0.00** y metió esos $38,519.05 dentro de la base del 16%.

Resultado: el asiento cargó $310,680.80 a `502` en vez de $272,161.75 a compras más
$38,519.05 a `1470110000` IEPS POR ACREDITAR. **Ese IEPS se fue al costo en lugar de
acreditarse.** Nadie lo vio porque el total del CFDI y el IVA sí cuadran, así que la
póliza cuadra y la balanza también.

En el ADD hay **47 facturas con IEPS por cuota entre 2025 y 2026, por $69,587.97**
(Hershey, Deiman, Gamahubin, Euro Candy) — la de Euro Candy sola es más de la mitad. Solo
verifiqué junio contra el libro; el resto hay que revisarlo. Esto también explica las 4
facturas que en el análisis previo "no cabían al 8%": son cuota, no tasa.

## Alcance

**Sí hace:** armar el libro de compras del mes desde CFDI, cuadrarlo, generar el TXT de
póliza (con IEPS/IVA separados por cuenta y el UUID por renglón), entregarlo con su
respaldo, y verificar después que lo que se subió a ContPAQi es exactamente lo entregado.

**No hace:** no escribe en ContPAQi (el trámite lo hace la contadora), no timbra, no
sustituye al contador externo, no toca Kepler.

## El layout del TXT (investigado y validado 2026-09-01)

Formato de longitud fija, dos tipos de registro, campos separados por espacio y rellenados
a su longitud exacta. Un renglón por movimiento.

**Encabezado `P`:**

| Campo | Long. | Alin. | Valor real en la póliza de compras |
|---|---:|---|---|
| Tipo de registro | 2 | Izq | `P` |
| Fecha `yyyyMMdd` | 8 | Der | `20260131` … `20260630` (último día del mes) |
| Tipo de póliza | 4 | Der | `3` (1=Ingresos, 2=Egresos, **3=Diario**, 4=Orden) |
| Folio | 9 | Der | `1` |
| Clase | 1 | Der | `1` |
| Id de diario | 10 | Izq | `0` |
| Concepto | 100 | Izq | "REGISTRO DE COMPRAS DEL MES" (19–38 chars usados) |
| Sistema de origen | 2 | Der | `11` |
| Impresa | 1 | Der | `0` |
| Ajuste | 1 | Der | `0` |

**Movimiento `M`:**

| Campo | Long. | Alin. | Valor real |
|---|---:|---|---|
| Tipo de registro | 2 | Izq | `M` |
| Cuenta (sin guiones) | 30 | Izq | `2120000017`, `5010000108` — 10 dígitos |
| Referencia | 10 | Izq | folio de factura (`21988`); **el más largo del año usa 5 chars, cabe de sobra** |
| Tipo de movimiento | 1 | Der | **0 = cargo · 1 = abono** |
| Importe | 20 | Izq | 1 o 2 decimales |
| Id de diario | 10 | Izq | `0` |
| Importe en ME | 20 | Izq | `0.0` |
| Concepto | 100 | Izq | **vacío en las 5,521 patas de compras** |
| Segmento de negocio | 10 | Izq | vacío |

**Validación cruzada:** los diez campos del encabezado y los nueve del movimiento coinciden
uno a uno con lo que tiene la póliza en la base (`Polizas`: Clase=1, IdDiario=0, SistOrig=11,
Impresa/Ajuste=false; `MovimientosPoliza`: TipoMovto bit, ImporteME=0, IdSegNeg=0, Concepto
vacío). No queda campo sin explicar.

Además, **109,305 de 109,378 pólizas tienen `SistOrig = 11`** — solo 73 se capturaron a
mano. Toda la contabilidad de la empresa entra por importación de TXT, no nada más el
asiento de compras.

### El UUID: por qué se pierde y dónde cabe

**El layout no tiene campo de UUID.** Eso explica de raíz las 5,521 patas sin CFDI asociado:
no es descuido de la contadora, el formato no lo transporta. Dos rutas:

1. **`Concepto` del movimiento** — 100 caracteres, hoy **vacío en el 100% de las patas de
   compras**. El UUID son 36. Cabe sin pelear con nada. Es la ruta barata, pero es texto
   libre: no crea la asociación formal de ContPAQi.
2. **Asociador de CFDI de ContPAQi** — es como se llenan las 948,795 filas de `AsocCFDIs`
   (`AppType='Contabilidad'`). Es la asociación real. Le entregaríamos a la contadora el
   listado `movimiento ↔ UUID` para que no quede ambigüedad al asociar.

Recomendación: hacer las dos. El Concepto deja rastro inmediato; el asociador deja el
vínculo formal.

### Lo que falta de LC.0 (ya no es bloqueante)

- Un **TXT real** de una póliza ya subida, para confirmar el separador exacto y que no haya
  variante propia de esta empresa.
- El **esquema de datos** de la empresa vive en `<Compac\Empresas\Esquemas\Contpaq>` del
  servidor `192.168.0.35`. No lo pude leer — SMB responde *Acceso denegado* con las
  credenciales actuales. Si el layout tuviera una variante, sale de ahí.

## Sprints

| # | Entregable | Depende de |
|---|---|---|
| **LC.0** | ✅ Layout investigado y validado campo por campo. Falta: 1 TXT real para confirmar separador, y decidir póliza mensual vs quincenal | — |
| **LC.1** | ✅ **2026-09-01** — `import-contpaqi-cfdis.js`: ADD → `fiscal.cfdis`. **167,135 CFDIs recibidos (140,546 `I` + 26,589 `E`) de 2018 a hoy, en prod.** Falta agendarlo | — |
| **LC.2** | ✅ **2026-09-02** — el criterio no había que predecirlo: es `IsAsoContabilidad` del ADD **+** no estar ya posteada. Ver "Movimientos no asociados" | LC.1 |
| **LC.3** | ✅ **2026-09-01** — `finance.gl_supplier_accounts` con **929 proveedores**, sembrada de la hoja `DATOS` y validada contra el catálogo de cuentas de ContPAQi. **Acierto 1,555/1,555 (100%)** | — |
| **LC.4** | Motor: `finance.purchase_book_lines` (por CFDI: base 0%, base IVA, base IEPS, IVA, IEPS, total, UUID, folio, proveedor, cuenta). Cuadre obligatorio contra el total del CFDI | LC.3 |
| **LC.5** | ✅ **2026-09-01** — `generate-poliza-compras-txt.js`. Junio: 494 renglones, cuadra en $30,278,735.58, UUID en 491 de 493 movimientos | LC.0, LC.3 |
| **LC.6** | ✅ **2026-09-01** — el trámite en pantalla: `finance.purchase_book_runs` + `/contabilidad/libro-de-compras` (master-detail, answer-first, inclusión optimista, estados borrador→generado→entregado→aplicado) | LC.5 |
| **LC.6.1** | ✅ **2026-09-02** — sub-módulo **Movimientos no asociados**: `aso_contabilidad` en el feed, criterio de dos condiciones, `tipo` de corrida, `/contabilidad/movimientos-no-asociados` | LC.6 |
| **LC.7** | ✅ **2026-09-03** — cuadre post-trámite contra `finance.findings`. Reescrito: **parsea el archivo entregado**, no re-deriva; filtra por `tipo`; guarda de frescura contra el latido `feed_contpaqi`; 3 reglas + cron 03:45 MX | LC.9 |
| **LC.8** | 3-way match contra la entrada de mercancía de Kepler (`XA2001`) — se empalma con Fase RE | LC.4 |
| **LC.9** | ✅ **2026-09-03** — **el archivo es importable**: layout a `poliza-txt.ts` (sin Nest, probable sin DI), `parsearTxt()` inverso, y el freno de existencia de cuenta que se había perdido | — |
| **LC.10** | ✅ **2026-09-03** — carátula editable (folio/concepto) con guarda de folio ocupado + anti-duplicado en los DOS modos + el modo `libro` deja de generar. **Es lo que desbloquea ago-2026** | LC.9 |
| **LC.11** | ✅ **2026-09-03** — respaldo en Excel derivado del TXT entregado (2 hojas). A ContPAQi va el archivo **y su respaldo** | LC.9 |
| **LC.12** | ✅ **2026-09-03** — CFDI cancelado fuera del TXT + la ignorancia sobre los 167,053 `desconocido` se **declara** con su monto de IVA+IEPS en riesgo | — |
| **LC.13** | ⬜ pantalla de `gl_supplier_accounts`. **Gate corrido 2026-09-03: no urge** — ningún proveedor de jul/ago necesita una cuenta 501/502 que no exista. Sí hay 207 facturas de ago (~$2.0M) cuyo RFC no está en el catálogo | — |
| **LC.14** | ✅ **2026-09-03** — **tercera puerta, exacta por UUID** hasta jul-2026: `finance.purchase_book_history` + 2 vistas + sembrador con auto-chequeos. Bloqueo duro para la certeza, blando y auditado para la sospecha | LC.9 |
| **LC.15** | ✅ **2026-09-03** — `analytics.gl_poliza_lines.concepto`: leer de vuelta el UUID que nosotros ponemos → **cuarta puerta**, desde ContPAQi mismo. Más el CSV para su Asociador de CFDI | LC.7, LC.14 |

**MVP = LC.0 → LC.6.1**, y ahí está el valor: LC.6.1 es el propósito del módulo (sacar lo no
asociado en TXT). LC.7 lo vuelve confiable.

## Criterio de aceptación

Regenerar **ene–jun 2026 desde CFDI** y que los seis meses den el mismo TXT que la póliza
que ya está en ContPAQi: 1,555 facturas, 3,318 patas, totales al centavo
(ene $30,033,013.71 · feb $36,471,924.85 · mar $45,187,137.83 · abr $35,034,209.66 ·
may $33,489,993.56 · jun $30,278,735.58). Si no reproduce el pasado, no se usa para el futuro.

## Qué decide que una factura entre al libro (LC.2 — **cerrada 2026-09-02**)

> **La respuesta no estaba en el CFDI: la tiene ContPAQi.** Todo lo de abajo (el clasificador
> al 42.9%, los discriminantes descartados uno por uno) sigue siendo cierto y por eso se
> conserva — pero la pregunta estaba mal planteada. No hay que **predecir** qué entra al
> libro; hay que **preguntarle a ContPAQi qué no está asociado**. Ver
> [Movimientos no asociados](#movimientos-no-asociados-lc6--cerrado-2026-09-02).
>
> Y la sospecha de abajo se confirmó: el libro **está incompleto**. Son 4,166 CFDIs sin
> asociar, y en 2026 solo, 1,772 por **$61.5M**.

### La medición original (2026-09-01) — por qué el clasificador no alcanzaba

Medido el 2026-09-01 contra las 54 hojas del workbook (14,838 facturas desde 2022) y los
CFDIs de ene–jun 2026 ya en `fiscal.cfdis`:

| Hallazgo | Número |
|---|---|
| Las 1,555 facturas del libro son de proveedores del catálogo `DATOS` | **1,555/1,555 · cobertura 100%** |
| Pero hay más CFDIs de **esos mismos proveedores** que nunca aparecen en ninguna hoja | **2,068 · $58,120,916.23** |
| Precisión del clasificador "RFC en el catálogo" | 42.9% |

Estar en el catálogo de proveedores es **necesario pero no suficiente**. Y el criterio que
falta **no está en el comprobante** — lo descarté midiendo:

- **No es el proveedor.** De la Rosa, jun-2026: 40 CFDIs, 18 entran y 22 no.
- **No es el día.** Del 15 de junio entran 6 y quedan fuera 3. Igual el 24 y el 29.
- **No es un campo fiscal.** Los dos grupos son idénticos en serie (`F`), método (`PPD`),
  uso (`G01`) y forma de pago (`99`).
- **No es sustitución.** Cero CFDIs relacionados, en los dos grupos.
- **No es desfase de captura.** Cada CFDI cae exactamente en la hoja de su propio mes
  (2026-03 → `MAR26`, sin excepción).
- **La recepción de mercancía da señal pero no explica**: de las que entran, 13.0% cruzan
  contra `analytics.erp_goods_receipts` (RFC + monto exacto); de las que no entran, 3.5%.
  Cuatro veces más, pero el 87% de las que sí entran tampoco cruza. Además el cruce es
  débil por construcción: el total de la factura no vive en la recepción — es justo el
  hueco que la Fase RE resolvió con OCR.

La sospecha que quedó de esa medición —**que el libro esté incompleto**— era la correcta.
Eran $58.1M en seis meses de facturas de proveedores de mercancía nunca contabilizadas por
esta vía, y el orden de magnitud coincidía con lo que Maat ya había detectado por su cuenta
(631 facturas por $52.2M sin recepción): el mismo fenómeno visto desde dos lados.

## Movimientos no asociados (LC.6 — cerrado 2026-09-02)

**El propósito del módulo, dicho por Edgar:** *sacar los movimientos no asociados en un TXT
como lo rige ContPAQi, pasarlo a ContPAQi y hacer el debido proceso.*

Eso reencuadra la fase. Lo que estaba construido era "la póliza completa del mes"; lo que se
necesita es "lo que falta por asociar" — un conjunto mucho más chico y accionable, y que
además **trae su propio criterio**, el que LC.2 buscaba sin encontrar.

### La señal: cuál sirve y cuál no

| Señal | Qué es | Sirve |
|---|---|---|
| `Documento.IsAsoContabilidad` (ADD) | el flag: ContPAQi la tiene atada a una póliza | **sí** |
| `AsocCFDIs.UUID` (empresa contabilidad) | la evidencia: en qué póliza está | sí, es el SoR |
| `analytics.gl_poliza_lines.cfdi_uuid` | nuestro espejo de la evidencia | **NO** |

Verificado el 2026-09-02 con las tres a la vez. El flag y la evidencia **coinciden dentro
del 1%**: jun-2026 175 vs 181, jul 441 vs 448, ago 724 vs 722. Nuestro espejo, en cambio,
tiene **18,979 de los 504,365 UUID asociados (3.8%)** — usarlo habría reportado miles de
"no asociados" falsos. Por eso el flag se persiste en `fiscal.cfdis.aso_contabilidad`
(el importer ya lo leía y lo tiraba) en vez de derivarse del espejo.

`NULL` significa "no se sabe", no "no asociado": es lo que se cargó antes de LC.6.

### La trampa: sin marca ≠ sin contabilizar

**271 CFDIs de 2026 por $32.6M no tienen marca de asociación pero su importe YA está en la
póliza del mes.** La causa es nuestra: el TXT no lleva UUID, así que ContPAQi contabiliza la
factura y nadie la asocia. Con el criterio ingenuo (`IsAsoContabilidad = 0` a secas) se
habrían vuelto a mandar y se habrían **duplicado $32.6 millones**.

Así que el criterio tiene **dos condiciones**, no una:

1. `aso_contabilidad IS NOT TRUE` — ContPAQi no la tiene atada, y
2. su importe **no** aparece ya como abono a proveedor (`212*`, cargo/abono `A`) en la
   póliza de compras del mes (Diario, folio 1).

La segunda es **heurística por importe**, no prueba: dos facturas del mismo monto en el mes
casan igual. Por eso se marca y se **excluye por default**, se muestra en la tabla con su
razón a la vista, y el generador **bloquea** (no avisa) si alguna quedó incluida. Se puede
forzar a mano, con advertencia — quien lleva el libro es quien sabe.

> **Esto es una razón más para poner el UUID en el TXT desde el primer envío.** Sin eso,
> cada archivo que generemos vuelve a ensuciar la marca y el detector se degrada solo.

### La hoja `XML` del workbook: el criterio validado al 96.9% (2026-09-03)

**El workbook tiene 58 hojas, no 54.** El análisis original cubrió las 54 mensuales y
`DATOS`, pero se había dejado sin abrir la más grande — y era la que importaba:

| Hoja | Filas | Qué es |
|---|---:|---|
| 54 mensuales (`ENE22` → `jun26`) | 891 c/u | el libro por mes, ~14,838 facturas |
| `DATOS` | 1,020 | catálogo de proveedores → `gl_supplier_accounts` |
| **`XML`** | **15,417** | **el libro completo CON UUID por renglón** |
| `BASE ANT` / `BASE NUEVA` | 891 | plantillas, misma forma que las mensuales |
| `FEB22` | 0 | vacía. **No es un hueco de póliza**: feb-2022 sí tiene $40,557,533 de compras en la balanza |

La hoja `XML` tiene columna **UUID** y su llave `# COMPRA` es `ENE22.1`, `ENE22.2`… — el
**mismo `mes.N`** con el que se parsean las hojas mensuales. O sea: la contadora **sí tiene**
el mapeo UUID ↔ renglón del libro. El UUID no se pierde por falta de dato, se pierde porque
**el layout del TXT no tiene dónde ponerlo**.

Son **15,120 UUID distintos, de 2022-01 a 2026-07, por $2,015,523,051** — la prueba
histórica más fuerte disponible, y con ella se valida el criterio de verdad:

**1. ¿Existen esos CFDIs?** 14,971 de 15,120 están en `fiscal.cfdis` (98.6%). Los 149 que
faltan son renglones del libro cuyo CFDI no está en el ADD — pendiente de explicar (¿RFC
receptor distinto, cancelados, anteriores al ADD?).

**2. La prueba del criterio.** De los 14,971 que **provablemente entraron al libro**,
ContPAQi marca:

| | CFDIs | Monto |
|---|---:|---:|
| `IsAsoContabilidad` = asociado | **14,506 (96.9%)** | $1,941,281,675 |
| sin marca | 465 (3.1%) | $54,642,612 |

**96.9% de acierto**, contra el 42.9% del clasificador que se había intentado. El criterio
es bueno. Y los 465 sin marca son exactamente el fenómeno ya identificado: están en el libro
pero sin asociar porque el TXT no llevó UUID.

**3. Corrobora el anti-duplicado, mes por mes y sin heurística.** Cuántos de los "no
asociados" ya estaban en el libro según la propia hoja de la contadora:

| Mes | No asociados | Ya en la hoja `XML` | Lo que detecta el heurístico por importe |
|---|---:|---:|---:|
| ene–jun 2026 | 785 | 117 | 121–136 |
| jul-2026 | 440 | 153 | 171 |
| **ago-2026** | 722 | **0** | 34 |
| sep-2026 | 93 | 0 | 0 |

Las dos vías coinciden dentro del margen esperable, y **agosto confirma que no está en el
libro** (la hoja se detiene en jul-2026). El heurístico detecta algunos más porque también
mira la puerta 501/502 de las pólizas de pago, que la hoja no registra.

> **Mejora directa disponible (no implementada):** esta hoja es una lista **exacta** por UUID
> de lo que está en el libro hasta jul-2026. Cargarla como feed reemplazaría el cruce por
> importe con un `IN` por UUID para todo el histórico, y dejaría el heurístico sólo para los
> meses que la hoja no cubre. Sería el cierre definitivo del riesgo de doble registro.

### Aceptación contra el archivo de trabajo de la contadora (2026-09-03)

`01-09-2026.xlsx` es el armado manual de **JUL26**, y sirve como verdad hecha a mano para
validar el módulo de punta a punta. Cuatro hojas, que son las etapas del trámite:

| Hoja | Qué es |
|---|---|
| `Hoja1` | la captura cruda, formato de hoja mensual (891 filas) |
| `Hoja2` | **las 279 facturas del asiento**, ya con cuentas `212`/`501`/`502` resueltas |
| `Hoja3` | armado intermedio: 839 movimientos (279 × 3 patas, antes de podar las de cero) |
| `Hoja4` | **la póliza final: 597 movimientos** |

**`Hoja4` ES la póliza que está en ContPAQi.** Prod, `tipo_pol=3 folio=1 anio_mes=2026-07`:
597 renglones, cargos $33,804,766.23, abonos $33,804,766.23. La hoja: 597 movimientos,
abonos `212` $33,804,766.23. Idéntico.

Y la cadena cierra al centavo hasta la balanza: el IVA de `Hoja2` es **$614,102.17** y los
cargos de julio a `1470040000 IVA POR ACREDITAR` en `contpaqi_ledger_monthly` son
**$614,102.17**; el IEPS de `Hoja2` es **$2,035,353.01** y la pata `1470110000` de la póliza
es **$2,035,353.01**. Hoja de trabajo → póliza → balanza, sin fuga.

**Desglose de su julio:** 0% $27,317,172.96 · 16% $3,838,138.09 · IEPS $2,035,353.01 ·
IVA $614,102.17 · total $33,804,766.23, en 279 facturas.

**El dato de LC.2, ahora medido:** el libro toma **279 de los 1,316** CFDIs de ingreso
recibidos en julio — el **21%**. Confirma que el libro es un subconjunto chico y que la
pregunta "¿qué entra?" nunca iba a salir del comprobante.

**La prueba que importa — cero doble registro:**

| | |
|---|---:|
| CFDIs de julio que el módulo considera (sin asociar + con cuenta) | 347 |
| Los que el filtro deja pasar al TXT | **179** |
| De esos 179, cuántos están en la `Hoja2` (o sea, ya en la póliza) | **0** |

Ninguna de las 179 está en el asiento de la contadora. El filtro anti-duplicado queda
validado contra una fuente humana e independiente, no contra su propio heurístico. (Del
lado contrario: de las 347 que se consideran, 148 por $17,690,482.66 sí están en `Hoja2` —
y el filtro las atrapa todas.)

Las 279 facturas de `Hoja2` están **todas** en `fiscal.cfdis` de julio (0 sin CFDI), así que
el feed del ADD cubre el universo del libro.

### Lo que falta, medido en prod (2026-09-02)

| Mes | Sin asociar | Ya posteadas (no van) | **Falta de verdad** | Monto |
|---|---:|---:|---:|---:|
| ene-2026 | 80 | 4 | 76 | $1,426,032 |
| feb-2026 | 75 | 6 | 69 | $602,355 |
| mar-2026 | 114 | 28 | 86 | $1,725,117 |
| abr-2026 | 181 | 28 | 153 | $1,584,775 |
| may-2026 | 160 | 24 | 136 | $777,829 |
| jun-2026 | 175 | 31 | 144 | $1,099,136 |
| **jul-2026** | 441 | **150** | 291 | $2,539,526 |
| **ago-2026** | 724 | 0 | **724** | **$48,203,284** |
| sep-2026 | 93 | 0 | 93 | $3,530,966 |

Hasta junio es goteo. Julio y agosto son el hueco real, y cuadra con el diagnóstico
original: julio se subió parcial y agosto no tiene póliza de compras en absoluto.

**El complemento cuadra al centavo** en los dos meses grandes (validado DB-direct, Δ 0.00):

- jul-2026: 441 sin asociar → 150 ya posteadas → 92 fuera del catálogo → **199 entran**, $1,265,797.22
- ago-2026: 724 sin asociar → 0 posteadas → 209 fuera del catálogo → **515 entran**, $46,133,945.25

### Cómo quedó armado

Un sub-módulo, no otro módulo: mismo motor, mismos permisos
(`FISCAL_PURCHASE_BOOK_VER`/`_GESTIONAR`), otro alcance.

- `TipoCorrida = 'libro' | 'complemento'` en `PurchaseBookService`. `libro` = el mes
  completo (para un mes que nunca se subió); `complemento` = solo lo no asociado.
- `finance.purchase_book_runs.tipo` (mig `20260902130000`) — el UNIQUE
  `(tenant_id, anio_mes, folio_poliza)` ya permitía dos corridas por mes; faltaba poder
  decir cuál es cuál.
- **Folio 2** para el complemento, y no es arbitrario: en el Diario el folio 1 es siempre el
  registro de compras y el 2 está libre en **todos** los meses medidos (jul-2026 salta de 1
  a 3; ago-2026 arranca en 3). Editable — el folio definitivo lo decide quien sube.
- Endpoints `/finance/purchase-book/no-asociados[/:mes[/generar|archivo|inclusion|estado]]`.
  Declarados **antes** de `@Get(':mes')` o Nest se come `/no-asociados` como si fuera un mes.
- Pantalla `/contabilidad/movimientos-no-asociados`, primera en el tab bar (el libro
  completo es el caso excepcional). Master-detail + answer-first, igual que su hermana.
- Índices: `fiscal.cfdis_no_asociados_idx` y `analytics.gl_poliza_lines (tenant_id,
  upper(cfdi_uuid))` (mig `20260902120000`). El tablero pasó de **4,335 ms → 376 ms** al
  pre-agregar las patas por `(mes, importe)` y acotar el rango a los meses que muestra.

## El mapa proveedor → cuenta (LC.3, cerrado 2026-09-01)

Cada proveedor tiene tres cuentas con el **mismo sufijo de 7 dígitos**: `212<sufijo>`
pasivo, `501<sufijo>` compras al 0%, `502<sufijo>` compras c/IVA.

**La fuente es la hoja `DATOS` del workbook** (1,009 proveedores con clave, nombre, RFC y
cuenta). Empata con las 177 cuentas `212` que el asiento realmente usa: **177 de 177**, y
el nombre coincide en 175 — las otras dos difieren solo en puntuación (`CANEL'S` vs
`CANELS`, `S. DE R.L.` vs `S DE RL`).

**No sale de `analytics.contpaqi_suppliers`, y por poco se cuela.** Su `codigo` empata
numéricamente con el sufijo en 142 de 177 casos, pero es espurio: el código `2` es "MARIA
SILVIA ANDRADE BARRA" mientras la cuenta `2120000002` es "ACEITES GRASAS Y DERIVADOS".
ContPAQi numera Proveedores y Cuentas por separado. Se cayó al contrastar los **nombres** —
el número solo daba un 80% de falso acierto.

Sembrado en `finance.gl_supplier_accounts`: **929 proveedores**, cada uno validado contra
el catálogo `Cuentas` de ContPAQi porque **el TXT no puede citar una cuenta inexistente**:

| | |
|---|---|
| Cuenta de pasivo existe | 926 / 929 |
| Compra exenta existe | 926 / 929 |
| Compra c/IVA existe | 915 / 929 (los 14 restantes nunca han facturado con IVA) |
| Sin RFC en el catálogo | 24 |
| Cuenta de pasivo **inexistente** | 3 — `2120005109`, `2120005405`, `2120005406` |

**Prueba de aceptación:** resolver por RFC la cuenta de las 1,555 facturas de ene–jun 2026
y compararla contra la que el libro les asignó a mano → **1,555 de 1,555, 100%**. Cero RFC
sin mapa, cero cuentas distintas.

Consecuencia: **dado un CFDI ya sabemos exactamente a qué cuentas postearlo.** Lo único que
falta para generar el TXT es saber *cuáles* CFDIs entran, que es LC.2.

## El generador del TXT (LC.5, cerrado 2026-09-01)

`database/scripts/generate-poliza-compras-txt.js`. Recibe el mes y una lista de UUIDs,
resuelve las cuentas por el mapa de LC.3 y escribe el archivo con el layout de LC.0.

**Junio 2026, 238 facturas:** 494 renglones, cargos = abonos = **$30,278,735.58**, neto 0.
Los campos caen exactos en sus posiciones y el UUID va en 491 de los 493 movimientos — los
dos sin UUID son los renglones globales de impuesto, que no pertenecen a ninguna factura.

**Contra la póliza real en ContPAQi:** casan 451 de 493. Las diferencias son 42 contra 56
renglones, y **suman exactamente lo mismo de los dos lados: $5,556,176.03**. No hay dinero
de más ni de menos: es la misma plata repartida distinto entre `501` (compras al 0%) y
`502` (compras c/IVA), en las mismas 28 cuentas. Nuestro reparto es el correcto, por dos
razones que se encontraron construyendo esto:

1. **La base fiscal del IVA incluye al IEPS.** Cargar esa base a la cuenta de compras
   cuenta el IEPS dos veces. Se detectó porque la póliza descuadraba por $38,519.05, que es
   exactamente el IEPS por cuota de EURO CANDY. Lo que va a la cuenta `502` es el subtotal
   de los conceptos gravados, no la base fiscal.
2. **El subtotal va neto de descuento.** En junio, 103 de 238 facturas traen descuento, y
   sin restarlo la base exenta salía negativa en 11 de ellas (−$68,560.54). La identidad que
   manda, verificada en las 238: `subtotal − descuento + IVA + IEPS = total`.

De paso, en la póliza real aparecen renglones de $0.04 y $0.02 sueltos — la firma de un
cuadre hecho a mano por diferencia.

**Dos opciones que el Excel no puede dar:**

- `--impuestos por-cuenta`: postea IVA e IEPS por proveedor en vez de un renglón global al
  mes. Cuesta ~90 renglones más y hace auditable el acreditamiento.
- `--uuid`: mete el folio fiscal en el `Concepto` del movimiento (campo libre de 100 chars,
  hoy vacío en el 100% de las patas).

**Lo que todavía no puede hacer solo:** la lista de facturas se le pasa a mano, porque LC.2
sigue abierto. Hoy sale del libro que la contadora ya armó.

## Nota: replicación real vs watermark (decidido 2026-09-01)

Se evaluó quitar el polling por completo. Lo que hay:

| Opción | Viable |
|---|---|
| Replicación transaccional | ❌ Express solo puede ser suscriptor, nunca publicador |
| CDC (Change Data Capture) | ❌ Necesita SQL Server Agent, que Express no trae |
| **Change Tracking** | ✅ Funciona en todas las ediciones, sin Agent |

La instancia es **SQL Server 2022 Express Edition** — la edición gratuita, la más limitada.
`CHANGETABLE(CHANGES …, @version)` devuelve solo las llaves que cambiaron, sin tocar la
tabla base: es lo que pedía el planteamiento. Requiere `ALTER DATABASE … SET
CHANGE_TRACKING = ON` más `ALTER TABLE` por tabla, y **`platform_ro` no tiene ningún rol
de servidor** (verificado: la lista sale vacía), así que lo tendría que habilitar un
administrador. Su retención por defecto son 2 días, así que **el carril full de respaldo no
desaparece** ni con Change Tracking.

Medición del costo real de lo que hay hoy: **no existe índice sobre `Documento.TimeStamp`**,
así que cada pasada recorre las 615,511 filas de `Documento` aunque devuelva 0 — 119 ms.
Un índice sobre esa columna lo volvería un seek, y es un cambio mucho menor que Change
Tracking. Diferido por ahora: 119 ms cada 5 minutos es 0.04% del tiempo.

## Riesgos

1. **El SAT solo tiene lo timbrado.** Si la contadora incluye algo sin CFDI, no lo vamos a
   generar — sale como excepción, que es lo correcto, pero hay que acordarlo antes.
2. **Corte de mes por captura, no por fecha de CFDI.** Abril: hoja $35,034,209.66 contra
   $34,393,426.36 de CFDIs fechados en abril. Hay que fijar la regla de corte explícita.
3. **Proveedor nuevo = cuenta contable nueva.** Alta manual en LC.3; el TXT no puede
   inventar cuentas.
4. **`catalog.suppliers` no tiene RFC.** El puente RFC ↔ cuenta vive en
   `analytics.contpaqi_suppliers`; hay que verificar que su `codigo` sea el sufijo de la
   cuenta `212xxxxxxx` antes de confiar en el mapeo automático.

## Decisiones abiertas

1. ¿Se mantiene **una póliza mensual** o se parte en quincenal/semanal? Una mensual es lo
   que hace que un mes sin armar se caiga completo (jul y ago 2026).
2. ¿IEPS e IVA **separados por cuenta de proveedor** o global como hoy? Separados cuestan
   +82 a +95 renglones al mes y hacen auditable el acreditamiento.
3. ~~¿Dónde va el UUID?~~ Resuelto: `Referencia` (10 chars) ya la ocupa el folio de factura;
   el `Concepto` del movimiento (100 chars) está vacío y ahí cabe. Falta decidir si además
   entregamos el listado `movimiento ↔ UUID` para el asociador de CFDI.
4. ¿Quién queda como dueño del proceso: la contadora sigue subiendo el TXT (recomendado,
   no cambia el trámite) o se evalúa la API de ContPAQi?

## Relacionado

- [`FASE_CP_CONTPAQI.md`](FASE_CP_CONTPAQI.md) — el conector al SoR contable (ADR-040).
- [`FASE_PV_VALIDACION_POLIZAS.md`](FASE_PV_VALIDACION_POLIZAS.md) — `analytics.gl_polizas`
  y los detectores de cuadre; la atribución por pata sale de ahí.
- [`FASE_RE_RECEPCION_MERCANCIA.md`](FASE_RE_RECEPCION_MERCANCIA.md) — el 3-way match de LC.8.
- [`FASE_CB_CONCILIACION_BANCARIA.md`](FASE_CB_CONCILIACION_BANCARIA.md) — mismo patrón:
  un workbook manual reemplazado por interfaz.

## Pendientes (al 2026-09-02)

### Bloquean la fase

| # | Qué | De quién depende |
|---|---|---|
| 2 | **Un TXT real ya importado**, para confirmar el separador exacto y descartar una variante propia de la empresa | La contadora |
| 3 | **Decidir el formato de entrega**: ¿IVA e IEPS por cuenta o global? ¿el UUID va en el Concepto? ¿una póliza mensual o quincenal? | Edgar + contabilidad |
| 3b | **Confirmar el folio del complemento.** Se usa el 2 porque está libre en todos los meses medidos, pero no sabemos si ContPAQi lo respeta o renumera al importar | La contadora (con el primer TXT) |

*(el punto 1 —LC.2, el criterio del libro— se cerró el 2026-09-02: no había que predecirlo.)*

### Se pueden hacer sin desbloquear nada

| # | Qué | Nota |
|---|---|---|
| 5 | **LC.7 — cuadre post-trámite** | Comparar lo que se subió contra lo que entregamos |
| 6 | **Arrancar el carril PM2** del feed del ADD | `ecosystem.contpaqi.config.js` listo; hay que levantarlo en una máquina de la LAN con `DATABASE_URL_NEW`. Ahora importa más: de ese carril sale la marca de asociación |
| 7 | **Los 3 proveedores con cuenta de pasivo inexistente** en ContPAQi (`2120005109`, `2120005405`, `2120005406`) | Si alguno factura, el TXT se detiene — a propósito |
| 8 | **Los 24 proveedores sin RFC** en el catálogo | Sin RFC no se puede casar el CFDI con su cuenta |
| 8b | **Poner el UUID en el TXT desde el primer envío** | Es la causa raíz de las 271 facturas por $32.6M que quedan "sin marca pero ya posteadas". Sin UUID, cada archivo que generemos vuelve a ensuciar la señal |
| 8c | **Los 209 CFDIs de ago-2026 fuera del catálogo de compras** ($2.1M) | No son compras (gasto/servicio) y por eso no entran al complemento; hay que confirmar que se contabilizan por su propia póliza de egresos |

### Riesgos abiertos, con dueño por definir

| # | Qué | Tamaño |
|---|---|---|
| 9 | **Nadie valida cancelaciones contra el SAT.** 167,053 CFDIs con `estatus_sat = 'desconocido'` | Acreditar IVA/IEPS de comprobantes cancelados |
| 10 | **El libro está incompleto y ya está medido.** 4,166 CFDIs sin asociar; en 2026, **1,772 por $61.5M**, de los cuales ago-2026 solo son 724 por **$48.2M** (ese mes no tiene póliza de compras) | Es el trabajo que el sub-módulo pone en la mesa: ya se puede generar y entregar |
| 11 | **IEPS por cuota mal capturado.** 47 facturas 2025–26 por $69,587.97; solo se verificó junio | El de EURO CANDY, $38,519.05, se fue al costo en vez de acreditarse |
| 12 | **Change Tracking** para quitar el polling del feed | Necesita un admin de la instancia SQL Server; `platform_ro` no tiene rol de servidor |
| 13 | **Índice sobre `Documento.TimeStamp`** | Alternativa barata al punto 12: convierte el scan de 615,511 filas en un seek |

## LC.9 → LC.15 — el archivo era rechazable, y el cuadre miraba lo que no era (2026-09-03)

Siete sprints en un solo bloque. El disparador fue una pregunta simple —"¿ya está listo el
TXT?"— y la respuesta honesta era **no**: estaba escrito, pero con tres formas de fallar en
silencio.

### Los bugs que se encontraron leyendo el código (ninguno estaba en el tracker)

1. ⛔ **El freno de existencia de cuenta se perdió al pasar de script a servicio.** `getMes`
   sólo traía `proveedor_existe`; nunca `compra_exenta_existe` ni `compra_iva_existe`. El
   freno preguntaba por `cuenta_compra_iva`, que es el string **precalculado** `502<sufijo>`
   y está poblado para todo el que tenga sufijo — o sea no frenaba nada. Los 14 proveedores
   sin cuenta `502` pasaban derecho, y `padR(null, 30)` mete **30 espacios**: el renglón no
   se ve mal en ninguna pantalla y ContPAQi rechaza el archivo entero. El script viejo sí
   frenaba (`generate-poliza-compras-txt.js:151`).
2. ⛔ **`gl_poliza_lines` no guardaba el `Concepto` del movimiento.** El importer traía
   `p.Concepto` (el de la póliza) y nunca `m.Concepto`. Metíamos el UUID ahí y **no lo
   podíamos leer de vuelta** — la señal se emitía a ciegas.
3. **`setInclusion` limpiaba `archivo_hash` pero dejaba `archivo_contenido`**, y
   `obtenerArchivo` sólo miraba que el contenido existiera → servía el TXT viejo con la
   firma vacía. Y bloqueaba en `aplicado` pero no en `entregado`.
4. **El cuadre (LC.7) comparaba los datos de HOY**: re-derivaba con `getMes()` en vez de
   parsear `archivo_contenido`, y no filtraba por `tipo`. Un CFDI nuevo daba descuadre falso.
5. **El bloqueo anti-duplicado sólo corría en modo `complemento`** — dejando sin freno al
   modo que abarca el mes entero, que es el de más riesgo.
6. **La puerta (b) tiene un falso negativo estructural**: compara UNA pata contra el neto
   completo, pero nuestro asiento parte el neto en DOS. Una factura de base mixta no casa.

### Lo que se midió y cambió el rumbo

| Pregunta | Lo que se creía | Lo que se midió |
|---|---|---|
| ¿Los 149 UUID ausentes son anteriores al ADD? | sí | **no**: el ADD arranca en 2018-01 y **148 son de un solo mes, abr-2023**, donde el workbook tiene el UUID corrido un carácter. 136 se recuperan por prefijo único; quedan 13 |
| ¿Cuántos UUID repite el libro? | ~297 | **1** (`DA573CB9-…` en JUL23.152 y SEP23.194, $133,073.28): doble registro histórico real |
| ¿Abrir un mes es rápido? | 376 ms | **11,795 ms** para agosto: `to_char(fecha)` anulaba el índice (seq scan de 167k) + dos EXISTS correlacionados. Corregido a **372 ms** con los conteos idénticos |
| ¿Urge la pantalla de cuentas de proveedor? | tal vez | **no**: ningún proveedor de jul/ago necesita una 501/502 inexistente. Pero 207 facturas de ago (~$2.0M) tienen un RFC fuera del catálogo |

### Las cuatro puertas del anti-duplicado

| # | Prueba | Fuerza | Estado |
|---|---|---|---|
| a | abono a `212` por el total, Diario folio 1 | por importe | ✅ ya estaba |
| b | cargo a `501/502` por el neto, cualquier póliza | por importe | ✅ ya estaba (con el falso negativo de arriba) |
| c | **UUID en el libro histórico** (hoja `XML`) | **exacta** | ✅ LC.14 — cubre hasta jul-2026 |
| d | **UUID en el `Concepto` de la pata real** | **exacta** | ✅ LC.15 — cubre lo que entreguemos de aquí en adelante |

La certeza **bloquea sin override** y apaga el checkbox: es el mismo folio fiscal, no hay
nada que juzgar. La sospecha por importe admite override **con motivo**, que se guarda —
el cruce tiene falsos positivos por diseño y quitarle la salida al humano convierte una
molestia en trabajo perdido (271 CFDIs / $32.6M en limbo).

**La cobertura va siempre en pantalla.** Sin el histórico sembrado la puerta (c) es un
no-op, y un no-op se lee igual que "no hay duplicados" — es lo que dejó
`analytics.customer_receivables` vacía en producción durante meses.

### Aplicado a producción (2026-09-03)

Las 3 migraciones + el sembrado, verificados con los smokes **37/37 y 66/66 contra prod**.

**Cómo se aplicaron, y por qué así:** una por una con `migrate.up()` y `lock_timeout = 15s`,
**no** con `migrate.latest()`. Knex mete todo el batch en una sola transacción, y había 6
migraciones de otras sesiones intercaladas — varias construyen matviews. El índice sobre
`analytics.gl_poliza_lines` (**480,863 filas / 291 MB**) toma `ACCESS EXCLUSIVE`, así que en
un solo batch ese lock quedaba tomado mientras se construían las matviews de después,
bloqueando el feed de pólizas que escribe **cada minuto**. Una por una, el lock dura lo que
dura su propia migración (4.5 s). Las 6 ajenas se leyeron antes: todas aditivas, cero
`DROP TABLE` / `DROP COLUMN` / `DELETE`.

**Lo que la puerta exacta agregó, medido con datos reales** (2×2 por mes, UUID × importe):

| mes | ambas | **solo UUID** | solo importe | ninguna |
|---|---:|---:|---:|---:|
| 2026-03 | 28 | 0 | 3 | 83 |
| 2026-06 | 31 | 0 | 5 | 139 |
| **2026-07** | 149 | **4 ($109,782)** | 22 | 265 |
| 2026-08 | 0 | 0 | 34 | 688 |

Las **4 de julio** son facturas que el cruce por importe **no atrapaba**: se habrían
re-entregado y duplicado. Y `solo_importe` aparece en todos los meses, o sea **las puertas
suman y ninguna es superconjunto** — como predecía el análisis. Agosto sale 0 por UUID
porque el histórico llega hasta jul-2026; ese mes queda cubierto sólo por importe, que es
exactamente lo que el renglón de cobertura declara en pantalla.

⚠️ **`concepto` llena hacia adelante, no retroactivo.** El importer sólo reescribe el delta
por `RowVersion`, así que las 480k patas existentes se quedan en `NULL`. No hace falta
backfill: las patas de compras históricas tienen el concepto **vacío en el 100%**, que es la
razón por la que esta columna existe.

**Falta:** redeploy de api + view, y que los roles de contabilidad vuelvan a entrar.

### Lo que sigue sin estar probado

⚠️ **El separador del TXT.** Los 19 campos se validaron uno a uno contra `Polizas` /
`MovimientosPoliza`, pero eso prueba qué **significa** cada campo, no cómo se serializa. Si
`SEP` está mal, ContPAQi rechaza el archivo entero. El bloque 4 de
`test-newdb-libro-compras-txt.js` skipea limpio y **se pone verde solo** en cuanto haya un
TXT que ContPAQi ya haya aceptado en `database/tests/fixtures/`. Es lo más barato que queda
por hacer, y es una dependencia humana: pedirle a la contadora el TXT de jul-2026 (ese mes
cuadra al centavo, así que hay con qué compararlo).

---

## LC.16 — la pantalla se lee (2026-09-03)

Disparado por una revisión visual poniéndose del lado de la contadora: *¿dónde está cada
cosa? ¿tengo que scrollear? ¿me abruma el color?* Se midió antes de opinar, contra prod.

### Lo que medía la pantalla

```text
sept-2026   157 filas ·  75 rojas (48%) · 52% de las celdas de impuesto en $0.00
ago-2026    725 filas · 214 rojas (30%) · 51% ceros
jul-2026    446 filas · 258 rojas (58%) · 55% ceros
```

La primera factura aparecía **al 63% del alto de la primera pantalla**: nueve bloques
apilados antes del dato. Tres barras de scroll (página, rail, tabla).

### El hallazgo caro: el rojo significaba cuatro cosas

| Tag rojo | Qué le pedía | jul-2026 |
|---|---|---:|
| `Ya en el libro` | **nada — está resuelto** | **159 (36%)** |
| `RFC sin cuenta` | configurar el proveedor | 93 |
| `Cuenta inexistente` | avisar a contabilidad | 6 |
| `Cancelada en el SAT` | sacarla | 0 |

En julio **58% de la tabla estaba en rojo y el 62% de esos rojos querían decir "listo, no
lo toques"**. Si más de la mitad grita, nada grita.

### LC.16.7 — la fecha salía con el día equivocado *(no era cosmético)*

`String(r['fecha']).slice(0, 10)` sobre un `date` de pg daba **`"Mon Aug 31"` para una
factura del `2026-09-01`**: pg devuelve la columna como `Date` en UTC-midnight y `String()`
la renderiza en hora de México (−06:00), o sea **el día anterior**. Verificado contra prod.

Salía por cuatro lados, todos hacia la contadora: la tabla, el **respaldo XLSX** (columna
declarada `type: 'date'` recibiendo el texto `"Mon Aug 31"`), el **CSV del Asociador**, y el
**orden de los renglones del TXT entregado** — porque `construirMovimientos` ordena por
`a.fecha < b.fecha` y eso ordenaba alfabéticamente por día de la semana
(`Fri < Mon < Sat < Tue < Wed`).

Arreglado en el origen con `to_char(f.fecha, 'YYYY-MM-DD')` en los tres SELECT. En la lista
de selección `to_char` es gratis: lo que anula el índice es envolver la columna **en el
WHERE**, no ahí.

Además el breadcrumb decía **"Contabilidad / Página Actual"** — placeholder en prod. Las
páginas que viven en pestañas no son items de nav, así que caían al genérico; ahora se
deriva del último segmento del slug, con guarda para no titular "Abc 123".

### Los cambios

| # | Qué | Efecto medido |
|---|---|---|
| **16.1** | El rojo sólo para lo que **impide generar**. `Ya en el libro` pasa a texto apagado con check; el filo de la fila de `--bad-fg` a `--ok-fg`; fuera el verde del KPI de IEPS (era `ieps > 0 ? ok : default`); el estado del mes de pastilla llena a punto + texto | jul: de 258 rojos a 99 |
| **16.2** | Chips de filtro + buscador. Cuatro grupos excluyentes, default "Entran al TXT" | ago: esconde 240 filas intocables · jul: 262 |
| **16.3** | La tira de 5 mosaicos baja al **pie de la tabla**, alineada bajo su columna. Suma lo filtrado y rotula cuál filtro | 4 de 5 mosaicos eran totales de columnas; el 5º repetía el veredicto |
| **16.4** | `$0.00` → guion tenue. `Estado` se parte en `Cuenta` + `Estado` | recupera ~la mitad de la tinta numérica |
| **16.5** | Rail agrupado por año, el más reciente abierto, con el pendiente en el encabezado | 24 tarjetas → ~9 + 2 encabezados |
| **16.6** | Cobertura + contexto + avisos en un renglón que se abre. **Los bloqueantes quedan fuera, siempre visibles** | ~30% del alto recuperado |

**Verificación de 16.2 — los cuatro grupos particionan la tabla, y `entran` coincide exacto
con lo que el rail ya mostraba en cada tarjeta:**

```text
mes      filas | entran  sin_cta  revisar  ya_libro | suma
2026-09    157 |     82       75        0         0 |  157  ✓
2026-08    722 |    482      206       34         0 |  722  ✓
2026-07    440 |    178       87       22       153 |  440  ✓
2026-06    175 |    108       31        5        31 |  175  ✓
```

### Dos cosas del plan que NO se hicieron, con motivo

- **Fundir `Exento` y `Gravado 16%` en una columna `Base`.** Son las dos cuentas del asiento
  (`501` al 0% y `502` gravado) y fundirlas escondía la distinción sobre la que está armado
  el TXT. El ruido eran **los ceros**, no las columnas.
- **Quitar el scroll interno de la tabla.** Con el preámbulo colapsado la página ya casi no
  scrollea, así que deja de ser un scroll anidado en la práctica — y ese contenedor es lo
  que mantiene clavados el encabezado y el nuevo pie de totales, que es justo lo que hace
  falta en el renglón 400 de agosto.

### Lección

**El color se gana con significado.** Cuatro estados semánticamente opuestos compartiendo
`severity="danger"` —incluido el camino feliz— convierten la columna en ruido. Y el verde
del IEPS estaba puesto por `> 0`: color por ser distinto de cero.

**Y un `slice(0,10)` sobre un `Date` no es un formateador.** Se veía bien en el código, el
build pasaba, el smoke pasaba, y el daño aparecía en el archivo que sube la contadora.
Hermano de [`feedback_brake_checks_precomputed_not_existence`].

⚠️ **Cuarta vez que un acento grave dentro de un comentario rompe el build** en este módulo
(dos en el `template:` del componente, una en el SQL, una en el CSS). Los tres literales de
este módulo son template literals: **sin acentos graves en los comentarios**.

### Pendiente de 16.x

Sigue abierta la pregunta anterior: **ver los renglones contables** con su cuenta
(`212` / `501` / `502`) y filtrarlos por familia. Hoy los movimientos sólo existen en la
hoja *Movimientos* del respaldo XLSX; en pantalla no hay ninguna vista de asiento. Es una
vista nueva, no un filtro de ésta. (Y ojo: en la contabilidad 2026 **`201` y `202` no
existen** — sólo `212`, `501`, `502` y `147x`.)

---

## Estado

🔨 **EN CURSO 2026-09-03.** LC.0 → LC.12, LC.14, LC.15 y LC.16 cerrados. El módulo ya hace
lo que existe para hacer: dice cuánto falta por asociar, mes por mes, y lo baja en TXT.

- **LC.1 ✅ en prod**: 167,418 CFDIs recibidos de 2018 a hoy en `fiscal.cfdis`
  (`source='contpaqi_add'`), con bases gravables por impuesto y tasa **y** la marca de
  asociación contable.
- **LC.2 ✅**: el criterio no era un clasificador — es la marca del ADD más el filtro
  anti-duplicado. Se cerró sin necesitar a la contadora.
- **LC.6 + LC.6.1 ✅**: el trámite en pantalla, con el sub-módulo de no asociados como
  entrada principal.

**En prod:** migraciones `20260902120000` (batch 247), `20260902130000` (batch 248) y
`20260902140000` (batch 250) aplicadas; el flag backfilleado con el rango completo.
**Falta desplegar el código** (api + view) **y que los roles de contabilidad vuelvan a
entrar** — el grant de permisos viaja en el JWT.

### El módulo estaba en prod y nadie podía abrirlo (LC.6.2, 2026-09-02)

El par `FISCAL_PURCHASE_BOOK_VER` / `_GESTIONAR` nació con LC.6 pero **nunca lo repartió
nadie**: sólo existía en el enum de `permissions.ts`, sin seed ni migración. Medido en prod,
la única fila de `role_permissions` con esas claves era `almacenista`… **en `false`** —
residuo de guardar el mapa completo desde `/admin/roles`, que escribe todo el JSONB y deja
las claves nuevas del enum en `false`. O sea **cero roles con acceso**; sólo
`superadmin`/`admin` entraban por `ALL_PERMS`, y quien copiara la URL recibía 403.

`20260902140000` lo reparte calcando el hermano del mismo proyecto (`FISCAL_CONTAB_*`, que
gatea Pólizas y Contabilidad electrónica): quien ya **ve** pólizas ve el libro, quien las
**gestiona** genera el TXT. El criterio se lee del estado vivo de prod, no se inventa. Los
`retirado_*` se excluyen a propósito.

| | Roles |
|---|---|
| `_VER` (8) | auditor_externo, contabilidad, credito_cobranza, direccion, finanzas, gerente_compras, marketing, superadmin |
| `_GESTIONAR` (6) | contabilidad, credito_cobranza, finanzas, gerente_compras, marketing, superadmin |

`auditor_externo` y `direccion` quedan sólo de lectura. El `false` explícito de
`almacenista` **no se pisa** (guarda `permissions -> 'KEY' IS NULL`).

> **Corrección (2026-09-02):** un aviso previo decía que prod tenía "91 migraciones
> pendientes". **Era falso** — ese `migrate:list` corrió con `DATABASE_URL_NEW` vacío
> (`$FLEET_DB_URL` no existe en el shell, vive dentro de `.env`) y midió
> `localhost:5433`, no Railway. Prod tenía **2** pendientes; se aplicaron en el batch 249 y
> quedó en **0 de 541**. La lección real es la del footgun de la variable, no la del
> backlog: ver la nota en `reference_prod_db_connection_topology`.

**Pendientes operativos de LC.1:**

1. **Agendar el importer** (corre desde la LAN, el ADD no es alcanzable desde Railway).
   Es incremental por UPSERT sobre `(tenant_id, uuid)`, así que se puede correr seguido.
2. **Nadie valida el estatus de los CFDIs contra el SAT.** De los 167,135, quedaron
   **167,053 en `desconocido`** — el ADD trae `CancelStatus` vacío. Solo 262 tienen
   estatus consultado y 3 salieron cancelados. Riesgo real: acreditar IVA/IEPS de un CFDI
   que el emisor canceló después. Amerita su propio sprint.
3. Un CFDI tipo `T` y los `P` (pagos) siguen viniendo de la descarga masiva vieja
   (194 filas de julio). Se pueden traer del ADD con `--tipos P,T` cuando haga falta.
