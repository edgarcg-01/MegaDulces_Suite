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
| **LC.2** | ⚠️ **BLOQUEADO 2026-09-01** — el criterio no está en los datos. Ver "Qué decide que una factura entre al libro" | LC.1 |
| **LC.3** | `finance.gl_supplier_accounts` — mapa RFC → cuentas `501/502/212`. Se siembra de `analytics.contpaqi_suppliers` (3,411 con RFC) + las 134 cuentas que ya usa el asiento. Editable desde la UI, no por script | LC.2 |
| **LC.4** | Motor: `finance.purchase_book_lines` (por CFDI: base 0%, base IVA, base IEPS, IVA, IEPS, total, UUID, folio, proveedor, cuenta). Cuadre obligatorio contra el total del CFDI | LC.3 |
| **LC.5** | Generador de póliza + TXT: patas `501`/`502`/`212` por proveedor, IEPS e IVA **separados por cuenta** (+82 a +95 renglones/mes), UUID por renglón. Descarga del archivo | LC.0, LC.4 |
| **LC.6** | Pantalla `/finanzas/libro-de-compras`: selector de mes, tabla densa, semáforo de cuadre, botón *Generar TXT*, historial de entregas | LC.5 |
| **LC.7** | Cuadre post-trámite: comparar la póliza real en ContPAQi contra lo entregado. Diferencia = hallazgo en `finance.findings` | LC.5 |
| **LC.8** | 3-way match contra la entrada de mercancía de Kepler (`XA2001`) — se empalma con Fase RE | LC.4 |

**MVP = LC.0 → LC.5.** LC.6 lo vuelve autoservicio; LC.7 lo vuelve confiable.

## Criterio de aceptación

Regenerar **ene–jun 2026 desde CFDI** y que los seis meses den el mismo TXT que la póliza
que ya está en ContPAQi: 1,555 facturas, 3,318 patas, totales al centavo
(ene $30,033,013.71 · feb $36,471,924.85 · mar $45,187,137.83 · abr $35,034,209.66 ·
may $33,489,993.56 · jun $30,278,735.58). Si no reproduce el pasado, no se usa para el futuro.

## Qué decide que una factura entre al libro (LC.2 — pregunta abierta)

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

**La pregunta para la contadora, textual:** *¿qué hace que una factura de un proveedor de
mercancía entre al libro de compras, y otra del mismo proveedor y del mismo día no entre?*

**La posibilidad que hay que poner sobre la mesa:** que el libro esté **incompleto**. Son
$58.1M en seis meses de facturas de proveedores de mercancía que nunca se contabilizaron
por esta vía. El orden de magnitud coincide con lo que Maat ya había detectado por su
cuenta (631 facturas por $52.2M sin recepción), así que probablemente son el mismo
fenómeno visto desde dos lados.

Sin esa respuesta LC.2 no se puede cerrar: cualquier clasificador que escribamos estaría
adivinando el criterio, y de ahí cuelga todo lo demás.

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

## Estado

🔨 **EN CURSO 2026-09-01.** LC.0 desbloqueado (layout documentado y validado contra la
póliza real). **LC.1 ✅ en prod**: 167,135 CFDIs recibidos de 2018 a hoy en `fiscal.cfdis`
con `source='contpaqi_add'`, incluidas las bases gravables por impuesto y tasa. Sigue LC.2
(clasificar qué CFDI entra al libro de compras).

**Pendientes operativos de LC.1:**

1. **Agendar el importer** (corre desde la LAN, el ADD no es alcanzable desde Railway).
   Es incremental por UPSERT sobre `(tenant_id, uuid)`, así que se puede correr seguido.
2. **Nadie valida el estatus de los CFDIs contra el SAT.** De los 167,135, quedaron
   **167,053 en `desconocido`** — el ADD trae `CancelStatus` vacío. Solo 262 tienen
   estatus consultado y 3 salieron cancelados. Riesgo real: acreditar IVA/IEPS de un CFDI
   que el emisor canceló después. Amerita su propio sprint.
3. Un CFDI tipo `T` y los `P` (pagos) siguen viniendo de la descarga masiva vieja
   (194 filas de julio). Se pueden traer del ADD con `--tipos P,T` cuando haga falta.
