# FASE CP.9 — Cobertura total de ContPAQi

> **Estado:** 🔨 EN CURSO · `CP.9.0` ✅ · `CP.9.2`: la carga inicial está en prod desde el 2026-10-30 y la sincronía
> está en código, sin agendar ([§8.9](#89-cp92-la-carga-inicial-hecha-2026-10-30-y-la-sincronía-en-código)) ·
> **ADR:** hereda ADR-040; la réplica, ADR-111
> **Pedido de Edgar:** *"generemos un plan a futuro de cubrir el 100% de ContPAQi"*.
> ⭐ **2026-10-29 — Edgar: *«hay que replicar todo para llevar el control o sincronía con ContPAQi»*.** El plan vigente es
> [§8, la réplica cruda continua](#8--ola-0--replicar-contpaqi-entero-la-réplica-cruda-continua-2026-10-29). Cambia la recomendación de §7
> por una razón medible: con un replicador genérico, cada tabla extra ya no cuesta un importador.
> **Antes:** [`FASE_CP_CONTPAQI.md`](FASE_CP_CONTPAQI.md) (decode) ·
> [`FASE_CP8_PUENTE_CONTPAQI.md`](FASE_CP8_PUENTE_CONTPAQI.md) (el puente).

---

## 0. El denominador — porque "100%" sin denominador es un número suelto

Medido en vivo contra `192.168.0.35\COMPAC` el 2026-10-09:

| | |
|---|--:|
| Bases en la instancia | **22** |
| `ctLUIS_FRANCISCO_LOPEZ_GUTIERREZ` (la contabilidad) | **5,406 MB** |
| — tablas | **119** |
| — **con datos** | **52** (67 vacías) |
| — **filas** | **4,706,885** |
| Repositorios de documentos del ADD | **4** (~30 GB) — leemos **1** |
| `ctLFLG` (**Nóminas**) | **2,308 MB** — leemos **cero** |

⭐ **Hallazgo de entrada: el ADD tiene CUATRO repositorios, no uno.** `CP.0` concluyó *"entidad
única, DB única"* mirando `ListaEmpresas` de Contabilidad, y es cierto **para Contabilidad**. El
ADD guarda documentos de 4 GUIDs distintos; nuestro importer lee sólo `12677b5d…` (el que
coincide con `Parametros.GuidDSL`). **Qué son los otros tres está sin medir.**

---

## 1. Qué cubrimos hoy — medido, no estimado

| Tabla | Filas | Quién la lee |
|---|--:|---|
| `MovimientosPoliza` | 1,158,537 | `import-contpaqi-polizas` + bank movements |
| `SaldosCuentas` | 187,578 | `import-contpaqi-ledger` (balanza) |
| `Polizas` | 110,719 | `import-contpaqi-polizas` |
| `Cuentas` | 8,811 | join en ledger |
| `Proveedores` | 3,426 | `import-contpaqi-suppliers` (× EFOS) |
| `AgrupadoresSAT` | 1,068 | join en ledger |
| **Total leído** | **≈ 1,470,139** | **31.2 % de las filas** |

Más los CFDIs de **1 de los 4** repositorios del ADD (`import-contpaqi-cfdis`, 167 mil).

---

## 2. ⛔ Por qué "100 % de las filas" es una métrica vanidosa

`Counters` (51 filas), `Folios` (55), `ModulosListados` (450), `DatosExtra` (75,028),
`Listados` (19) son **mecánica interna del producto**. Importarlas sube el porcentaje y **no
contesta ni una pregunta de negocio**.

⭐ **El denominador correcto no son filas: son PREGUNTAS que hoy no podemos contestar.** Este
plan se ordena por eso, y el porcentaje queda como lo que es — un número de contexto, no una
meta. Lo mismo que `[IC.8]` ya midió: un KPI que sube porque cambió el universo no es mejora.

---

## 3. Los tres ejes de cobertura

| Eje | Hoy | Techo real |
|---|---|---|
| **Lectura** | 6 tablas + 1 ADD | las ~20 tablas que responden preguntas |
| **Escritura** | pólizas (en código, sin probar) | pólizas + asociación de CFDI |
| **Decode** | P · M1 · AD | faltan `AM`, `AP`, `I`, `V`, `W2` |

---

## 4. El plan, por olas de valor

### 🌊 Ola 1 — ⭐⭐ El impuesto por movimiento *(la de más valor, y por mucho)*

| Tabla | Filas | Qué trae |
|---|--:|---|
| `MovimientosImpuestos` | **331,955** | `Impuesto`, `TasaOCuota`, `ImpBase`, `ImpImpuesto`, `IVANoAcred`, `UUID`, `IdPersona`, por **movimiento de póliza** |
| `DevolucionesIVA` | **201,036** | `ImpBase`, `ImpIVA`, `IVARetenido`, `ISRRetenido`, `IEPS`, `IdProveedor`, `UUID`, por póliza |

⭐⭐ **Esto es exactamente lo que la Fase LC reconstruye a mano desde los CFDIs del ADD** — base
gravable y tasa por impuesto. ContPAQi ya lo tiene calculado, por movimiento y **con el UUID**.

**Dos usos, y el segundo vale más que el primero:**
1. Simplificar LC: dejar de derivar lo que ya está derivado.
2. ⭐ **Cruzarlo como SEGUNDA implementación.** Tenemos el IVA por CFDI (ADD) y el IVA por
   movimiento (ContPAQi): dos caminos independientes al mismo número. Es literalmente la regla
   del proyecto — *verificar una vista contra sí misma pasa bugs en verde; lo que los encuentra
   es comparar dos implementaciones*. Hoy **nadie cruza nada** ahí.

**Preguntas que destraba:** ¿el IVA acreditable que declaramos coincide con el que ContPAQi
tiene asentado? ¿cuánto IVA quedó **no acreditable** y por qué? ¿el IEPS por cuota que `[LC.1]`
encontró ($69,587.97 en 47 facturas) está en los libros o se fue al costo?

### 🌊 Ola 2 — El CFDI dentro de ContPAQi

| Tabla | Filas |
|---|--:|
| `MovimientosAdministrativos` | **1,329,233** (la tabla más grande de la base) |
| `AsocCFDIs` | **979,977** |
| `AsocDoctosAdministrativos` | 130,053 |
| `DocumentosAdministrativos` | 116,526 |
| `AsocCFDINodosDePago` | 11,127 |

Trae `CveProdSAT` y `CodigoPersona` por renglón. **`AsocCFDIs` hoy se consulta a mano** (lo hice
toda esta sesión) pero **no se importa**: el puente lo necesita para medir su propia cobertura de
UUID sin abrir SQL Server.

**Preguntas:** ¿qué CFDI está contabilizado y cuál no, sin salir de la Suite? ¿los complementos
de pago cuadran contra las facturas? (hoy `AsocCFDINodosDePago` es invisible).

### 🌊 Ola 3 — Bancos y egresos del módulo propio

`DocumentosBancarios` (4,298) · `Egresos` (3,191) · `Cheques` (1,107) · `CuentasCheques` (7) ·
`SaldosCtasCheques` (42) · `Bancos` (97).

⚠️ **CP.2 midió que estos módulos cayeron en desuso (sólo 2018-19)** y por eso se saltaron. La
ola es **barata y de valor bajo**; va acá para que quede dicho, no porque urja.

### 🌊 Ola 4 — Personas

`Personas` (5,676) · `Clientes` (2,452) · `Domicilios` (1). Cierra el padrón fiscal: hoy sólo
traemos `Proveedores`.

### 🌊 Ola 5 — Los 3 repositorios del ADD que no leemos

⛔ **Primero MEDIR qué son.** ~20 GB de documentos de entidades que no identificamos. Puede ser
valor grande (otro RFC del grupo) o cero (bases viejas). **No se planea sobre lo que no se midió.**

### 🌊 Ola 6 — Nóminas (`ctLFLG`, 2.3 GB)

Cero cobertura. ⭐ **Conecta directo con la Fase RH** (migración de Mega Talento) y con `CH`
(checadores): ahí está el CFDI de nómina, IMSS y SUA. Es la ola de **mayor valor fuera de la
contabilidad**, y es un proyecto propio, no un importer.

### 🌊 Ola 7 — Escritura completa

Cerrar el puente (`FASE_CP8`): emitir renglones `AD`, confirmar si ContPAQi respeta el `guid`, y
el cuadre de vuelta en producción.

---

## 5. ⛔ Lo que NO se cubre, con motivo escrito

| | Por qué |
|---|---|
| `Counters`, `Folios`, `ModulosListados`, `Listados`, `DatosExtra` | mecánica interna del producto; no contestan nada |
| Las **67 tablas vacías** | no hay dato que traer. Si alguna se llena, aparece sola en el recuento |
| `PolizasIntuitivas` (4,191) | sin decodificar; **medir antes de decidir** |
| Escribir en cualquier tabla de ContPAQi | ADR-040, intacto: archivo o SDK, nunca `UPDATE` |

---

## 6. Definición de terminado — por pregunta, no por tabla

Una ola está cerrada cuando:

1. Su dato llega por **carril con latido de ENTREGA** y umbral en `CRON_JOBS` (ADR-053), no "el
   importer corrió".
2. Tiene **al menos un cruce contra una fuente independiente** y la diferencia está medida o
   declarada (ADR-059).
3. Lo que no se pudo medir **se declara** — nunca cero, nunca verde por omisión (ADR-056).
4. Hay una pregunta de negocio que antes no se podía contestar y ahora sí, **nombrada**.

⛔ **No cuenta:** "la tabla se importó", "subimos a 60 % de cobertura".

---

## 7. Mi recomendación

**No perseguir el 100 %.** El 31 % que tenemos ya cubre balanza, pólizas, bancos y proveedores
— lo que sostiene Maat, CB y CP. De lo que falta, **el valor está concentrado en dos olas**:

1. **Ola 1 (impuestos por movimiento)** — porque le da a LC una segunda fuente para cruzar, y
   eso es lo único que convierte una cifra reproducible en una cifra verificada.
2. **Ola 6 (Nóminas)** — porque es un dominio entero sin cubrir y ya tiene fase hermana (RH).

Las olas 3 y 4 son baratas y de valor bajo: se hacen cuando sobre tiempo. La **5 no se planea
hasta medirla**. Y la **2** conviene acotarla a `AsocCFDIs`, que es lo que el puente necesita
para auditarse solo.

⚠️ Y una advertencia sobre el orden: **ninguna de estas olas vale lo que vale cerrar el puente**
(`FASE_CP8`), que hoy está a **un clic** de probarse. Importar más lectura mientras la escritura
sigue sin verificar es ensanchar lo que ya funciona en vez de terminar lo que no.

---

## 8. ⭐ Ola 0 — Replicar ContPAQi entero: la réplica cruda continua (2026-10-29)

> Pedido de Edgar (2026-10-29): *«hay que replicar todo para llevar el control o sincronía con ContPAQi en
> contabilidad»*. Se escribe en esta fase porque CP.9 ya existe: no abre una nueva.

### 8.1 Por qué cambia la recomendación de §7

§7 decía «no perseguir el 100 %» porque **cada tabla costaba un importador propio**: transformarla, probarla y
mantenerla. Así se construyeron los seis de hoy. Con una **réplica cruda genérica** —un solo mecanismo que copia
cada tabla tal cual— ese costo desaparece:
- **Wincaja** ya se replica así (Fase WR, réplica cruda continua).
- **Kepler** llega igual a `kepler_ods` (ADR-046: «el crudo canónico»).

Con eso se cumple la regla principal del repo: **una tabla principal (la réplica) y todo lo demás vistas que derivan
sin copiar**.

⛔ Lo que §2 decía sigue en pie: **el 100 % de las filas no es la meta**. La meta son las preguntas que ahora se
contestan (§8.2). Lo que cambia es el precio: replicar las tablas que no contestan nada ya cuesta casi cero, y deja
de valer la pena excluirlas.

### 8.2 Qué es «control y sincronía»: lo que hoy NO se contesta desde la Suite

| Pregunta | Tabla de ContPAQi | Quién la necesita |
|---|---|---|
| ¿Qué periodos tiene cerrados contabilidad? | *por medir en CP.9.0* | el dictamen (`[CP.8.95]`): no entregar a un periodo cerrado (era la D11 de CP.8) |
| ¿Qué CFDI está asociado a qué póliza? | `AsocCFDIs` (979,977) | el puente (asociación de UUID) y LC; hoy se consulta a mano |
| ¿Qué IVA e IEPS hay asentados por movimiento? | `MovimientosImpuestos` (331,955) · `DevolucionesIVA` (201,036) | LC y el cierre: la segunda implementación del IVA (Ola 1) |
| ¿Cambió algo que ya se había cotejado? | `RowVersion` de cada fila | el cuadre del puente y el dictamen |
| ¿Qué movió contabilidad en documentos y personas? | `DocumentosAdministrativos`, `Personas`, `Clientes`… | conciliación y padrón (Olas 2 y 4) |

### 8.3 Cómo se hace

Decisión de diseño, con su porqué:

1. **Destino: schema `contpaqi_ods` en `pg-prod`.** Una tabla por cada tabla de la contabilidad, con las columnas 1:1
   más `_rv` (el `RowVersion` de origen) y `_replicado_en`. Mismo criterio que `kepler_ods`: es crudo canónico de
   una sola empresa, sin `tenant_id` propio. Esa excepción a la regla 18 se escribe en un ADR nuevo, igual que hizo
   ADR-046.
2. **Mecanismo: un replicador genérico** (`replicate-contpaqi.js`) en `feeds-cron` de `md`, donde ya corren los
   carriles de ContPAQi y que alcanza `.35`. Tabla por tabla:
   - **con llave primaria y `RowVersion`:** *firmas por bloque*. Se lee `COUNT` y `SUM(RowVersion)` por rangos de
     llave, se compara contra lo replicado y sólo se baja el bloque que cambió. Dentro del bloque se escribe lo
     nuevo o lo cambiado y se borra lo que ya no está. ⭐ Detecta **altas, cambios y bajas** sin releer la tabla.
     El `RowVersion` de ContPAQi no es monotónico, así que no sirve de marca de agua, pero sí de token de cambio
     (`import-contpaqi-polizas.js` lo usa igual).
   - **con llave y sin `RowVersion`:** lo mismo, con `CHECKSUM_AGG(BINARY_CHECKSUM(*))` por bloque.
   - **sin llave:** si es chica, copia completa por diferencia de conjuntos; si es grande, se declara NO MEDIDA y se decide.
   - **columnas pesadas** (los documentos del ADD): fuera de esta réplica. Los CFDI ya llegan por `contpaqi-cfdis`.
3. **Dos carriles, como WR.** Un incremental (firmas por bloque) y un reconciliador diario que compara la firma
   completa de cada tabla contra el origen. Cada carril lleva su latido de ENTREGA con umbral en `CRON_JOBS`
   (ADR-053), y hay un **árbitro** diario de conteo y firma por tabla que se prueba en rojo a propósito (como
   `arbitro-polizas-valor.js` hace con Kepler).
4. **Carga inicial: 4.7 M filas y 5.4 GB, por bloques y de noche** (regla 9), con pausa entre lotes para no frenar
   a contabilidad en `.35`. Se lee con `READ COMMITTED` normal, ⛔ sin `NOLOCK`: leer sucio de un sistema contable
   no es opción. Hoy la base de prod pesa 40 GB, y el espacio libre del disco de `md` está NO MEDIDO.
5. **Después, derivar en vez de copiar.** Las tablas de staging de hoy pasan a ser **vistas** sobre
   `contpaqi_ods`, una por una, con medición antes/después (regla 15), y se retira su importador:
   - `analytics.gl_polizas` y `gl_poliza_lines`;
   - `contpaqi_bank_movements`;
   - `contpaqi_ledger_monthly`;
   - `contpaqi_accounts`;
   - `contpaqi_suppliers`.

   Mientras dure la transición, réplica y staging conviven y se cruzan: son dos implementaciones del mismo dato.
   Ninguna tabla tiene dos dueños, porque viven en schemas distintos.

### 8.4 Etapas

| # | Capa | Entregable | Criterio de cierre |
|---|---|---|---|
| `CP.9.0` | C0 | **Inventario** de las 22 bases (`database/importers/contpaqi/02-inventario-replica.js`; sólo lee `sys.*` y no trae contraseña): filas, tamaño, llave, `RowVersion`, columnas pesadas | la salida pegada aquí, y la estrategia de cada tabla decidida con ella |
| `CP.9.1` | C0 | **El mecanismo en UNA tabla grande** (`MovimientosPoliza`, 1.16 M), contra una base de prueba: carga inicial, incremental por bloques y su costo en `.35` | tiempos medidos; prueba negativa: un renglón cambiado o borrado en la copia lo encuentra el reconciliador |
| `CP.9.2` | C2 | Migración de `contpaqi_ods` (generada, aplicada una por una), el replicador y sus dos carriles en `feeds-cron`, con latidos | las tablas con datos replicadas, con conteo y firma iguales al origen según el árbitro |
| `CP.9.3` | C1 | **Vistas de control:** periodos cerrados, asociación CFDI ↔ póliza, impuestos por movimiento | cada una cruzada contra una fuente independiente (§6) |
| `CP.9.4` | C1 | El dictamen y el cuadre del puente leen de la réplica; regla nueva `periodo_cerrado` (bloquea) | prueba negativa |
| `CP.9.5` | C1 | Staging → vistas, una por una, retirando su importador | antes/después medido de cada una |
| `CP.9.6` | — | ADD (los 3 repositorios sin leer: medir primero) y nóminas | según D13 |

### 8.5 Decisiones de Edgar

| # | Decisión | Recomendación |
|---|---|---|
| **D13** | ¿Qué bases entran? | **Primero la contabilidad completa y las Generales** (empresas, parámetros). El ADD, después de medirlo en CP.9.0. ⛔ **Nóminas, sólo con decisión expresa:** son salarios y datos personales, y es de la Fase RH |
| **D14** | La ventana de la carga inicial | Una noche entre semana, de 22:00 a 05:00, con pausas entre lotes y aviso a contabilidad |
| **D15** | La contraseña de SQL Server sigue embebida como valor por defecto en **7 archivos de un repo PÚBLICO** (deuda anotada en `ops/vl/crontab.feeds`) | Moverla al secreto de `md` (`/secrets/feeds.env`) y **rotarla**. Es una credencial y por la regla 7 la decides tú. El inventario y el replicador nuevos nacen sin ella |
| *(regla 1)* | Esto **es** un importador nuevo, un replicador | Tu pedido del 2026-10-29 lo autoriza y queda escrito aquí. Sustituye, no suma: los seis de staging se retiran en CP.9.5 |

### 8.6 Riesgos

| Riesgo | Mitigación |
|---|---|
| Carga sobre `.35` mientras contabilidad trabaja | Las firmas por bloque leen agregados, no renglones. El costo del incremental se mide en CP.9.1 antes de agendarlo al minuto |
| Espacio en `pg-prod` (+5.4 GB sobre 40 GB) | Medir el disco libre de `md` antes de CP.9.2 |
| Tipos sin equivalente directo (`datetime` sin zona, `money`, `uniqueidentifier`, `image`) | Mapeo explícito por tipo, escrito, y las columnas pesadas fuera (§8.3.2) |
| Tablas sin llave: sus bajas no se ven | Se declaran con nombre en el inventario, nunca se dan por replicadas |
| Un carril con dos dueños | Schema propio. Hasta CP.9.5 nadie más escribe `contpaqi_ods` y el replicador no escribe el staging |

### 8.7 Definición de terminado

Hereda §6, que mide por preguntas. Además:
1. Las tablas con datos replicadas, con conteo y firma iguales al origen según el árbitro diario, re-medido.
2. El latido de entrega de cada carril, probado en rojo.
3. `periodo_cerrado` funcionando en el dictamen, con su prueba negativa.
4. Al menos una tabla de staging convertida en vista, con su antes y después.

### 8.8 ✅ `[CP.9.0]` Medido: el inventario de las 22 bases (2026-10-29)

Lo corrió Edgar en `md`, dentro de `feeds-cron` (k3s, namespace `ingesta`), con
`02-inventario-replica.js`: sólo lee `sys.*` y pide la contraseña sin dejarla en el historial.

⛔ **Primer tropiezo, corregido:** la contabilidad, nóminas y tres repositorios del ADD corren en **compatibilidad
100–110**, donde `STRING_AGG` no existe. La primera versión del inventario marcó esas bases NO MEDIDAS («Incorrect
syntax near 'AS'»). La segunda agrega con `FOR XML PATH`, que funciona en cualquier nivel.

| Base | Compat | Tablas con datos | Filas | Tamaño | Llave primaria | Marca de cambio |
|---|---:|---:|---:|---:|---|---|
| **Contabilidad** (`ctLUIS_…`) | 100 | **52 de 119** | **4,847,902** | 4,745 MB | **52 de 52** (`Id`) | **52 de 52** (`RowVersion:int`) |
| Generales (`GeneralesSQL`) | 160 | 14 de 21 | 3,989 | 4 MB | 14 de 14 | 14 de 14 (`RowVersion`) |
| Catálogos del SAT (`ADD_Catalogos`) | 160 | 77 de 77 | 95,732 | 35 MB | 0 | 0 |
| Directorio del ADD (`DB_Directory`) | 160 | 21 de 43 | 2,525 | 5 MB | 2 | 1 |
| ADD principal, metadatos (`12677b5d`) | 110 | 30 de 51 | 13,492,824 | 4,061 MB | 16 | 1 (`Documento.TimeStamp`) |
| ADD principal, contenido (el XML) | 110 | 2 | 629,076 | 6,406 MB | 1 | 0 |
| ADD principal, «otros» (expedientes) | 110 | 7 + 2 | 2,523,706 | 5,320 MB | 4 | 2 |
| Los otros 3 repositorios del ADD | 100 | — | ~3.3 M en metadatos | ~9 GB (casi todo contenido) | parcial | `Documento.TimeStamp` |
| **Nóminas** (`ctLFLG`) | 100 | 59 de 76 | 5,731,321 | 1,685 MB | 52 de 59 | 41 (`timestamp:datetime`) |
| Generales de nóminas (`nomGenerales`) | 100 | 65 de 70 | 23,379 | 7 MB | 25 | 9 |
| `Predeterminada` | 100 | NO MEDIDO: el login de sólo lectura no tiene acceso | | | | |

**Lo que esto decide:**
- ⭐⭐ **La contabilidad entera se replica con el mecanismo más barato.** Las 52 tablas con datos tienen llave `Id` y
  `RowVersion`, así que las firmas por bloque cubren el 100 % sin un solo caso especial. Entre ellas viene todo lo de
  §8.2:
  - `AsocCFDIs` (999,724);
  - `MovimientosImpuestos` (334,469);
  - `DevolucionesIVA` (202,427);
  - `PeriodosCausacionIVA` (19,567);
  - `AsocCFDINodosDePago` (11,288).
- **El ADD no tiene `RowVersion`.** Se replica por documento: los que cambiaron según `Documento.TimeStamp` (la marca
  que ya usa `import-contpaqi-cfdis.js`), con sus tablas hijas completas. Va así porque **14 de esas hijas no tienen
  llave**: `Impuesto_Traslado_Concepto` (4.8 M), `CfdiRelacionados`, `Impuesto_Traslado`…
- **El contenido del ADD (los XML, ~18 GB entre los cuatro repositorios) NO se replica:** los XML de los CFDI ya están
  en `fiscal.cfdis`.
- ⭐ **Se contestó la Ola 5 (§4).** Los 4 repositorios del ADD **son de la misma empresa**: el directorio les da el
  mismo RFC (no se escribe aquí, el repo es público). No es otro RFC del grupo. Los tres que no leíamos son más
  chicos y casi todo es **nómina**: `Nomina` 103,064 y 92,014 documentos, contra unos 110 mil cada uno.
  - Sincronizaron por última vez el 2025-11-15, el 2025-12-12 y el 2026-06-29.
  - ⚠️ Que sean los repositorios de ContPAQi Nóminas es inferencia de su contenido: está por confirmar con contabilidad.
- **Nóminas trae datos personales** (`nom10001`, empleados, con `fotografia` y `expediente`). Eso queda en la D13.
- **Tamaño de la réplica en prod:**
  - contabilidad + Generales + catálogos + metadatos del ADD principal: **≈ 9 GB**;
  - con nóminas: ≈ 11 GB;
  - hoy prod pesa 40 GB, y el espacio libre del disco de `md` sigue NO MEDIDO.

**La D13, con los datos.** Etapa 1 (control contable):
- la contabilidad;
- GeneralesSQL, los catálogos del SAT y el directorio;
- después, los metadatos del ADD principal, por documento.

Etapa 2, **sólo con decisión expresa:** nóminas y los 3 repositorios del ADD (nómina). Fuera: el contenido de los XML.

### 8.9 `[CP.9.2]` La carga inicial, hecha (2026-10-30), y la sincronía, en código

**Lo que decidió Edgar** cierra la D13 y la D14: *«todo, hasta nóminas, hagámoslo ahora la carga inicial»*.
- **D13 → todo:** la contabilidad, Generales, los catálogos del SAT, el directorio, los metadatos de los 4
  repositorios del ADD y nóminas.
- **D14 → en horario hábil**, el viernes 30 desde las 09:04, con 50 ms de pausa entre trozos. La recomendación era
  de noche; Edgar decidió hacerlo ya. Si contabilidad la notaba lenta, se podía parar con `pkill -INT`: termina la
  tabla en curso y se detiene.

**Dónde corrió:** en el pod `feeds-cron` (namespace `ingesta`), con el entorno de `/secrets/feeds.env`. Se intentó
primero desde una estación de trabajo y el rol lo frenó: trae `default_transaction_read_only=on` **a propósito**, y
eso no se salta. La contraseña de SQL Server se escribe en la terminal de `md` y entra al pod por la entrada
estándar; no queda en el historial ni en el repo.

**El resultado:** de 09:04:18 a 09:45:46, **41 minutos**. «Descuadre» es que el `COUNT_BIG` del origen, contado al
terminar cada tabla, no coincida con las filas en Postgres.

| Fuente | Base de origen | Tablas | Filas | Descuadres | Minutos |
|---|---|---:|---:|---:|---:|
| Contabilidad | `ctLUIS_…` | 52 | 4,847,987 | 0 | 5.5 |
| Generales | `GeneralesSQL` | 14 | 3,989 | 0 | 0.0 |
| Catálogos del SAT | `ADD_Catalogos` | 77 | 95,732 | 0 | 0.2 |
| Directorio del ADD | `DB_Directory` | 20 | 1,868 | 0 | 0.0 |
| ADD principal, documentos | `document_12677b5d…` | 26 | 12,705,755 | 0 | 18.3 |
| ADD principal, «otros» | `other_12677b5d…` | 7 | 2,021,029 | 0 | 2.3 |
| ADD `1c7bf869`, documentos | `document_1c7bf869…` | 20 | 604,997 | 0 | 1.3 |
| ADD `1c7bf869`, «otros» | `other_1c7bf869…` | 8 | 1,271 | 0 | 0.0 |
| ADD `d112b0ed`, documentos | `document_d112b0ed…` | 20 | 549,753 | 0 | 1.0 |
| ADD `4d8ceea4`, «otros» | `other_4d8ceea4…` | 8 | 1,271 | 0 | 0.0 |
| ⚠️ ADD `4d8ceea4`, documentos | `document_4d8ceea4…` | **NO MEDIDO** | | | |
| ⚠️ ADD `d112b0ed`, «otros» | `other_d112b0ed…` | **NO MEDIDO** | | | |
| **`contpaqi_ods`** | | **252** | **20,833,652** | **0** | |
| **`contpaqi_nom`**: nóminas (`ctLFLG` 59, `nomGenerales` 65) y las `Nomina*` del ADD (12) | | **136** | **8,281,780** | **0** | |
| **Total**, según el cierre del log | | **388** | **29,115,432** | **0** | **41.5** |

- `contpaqi_ods` pesa **4.6 GB** y `contpaqi_nom` **1.9 GB**: menos que los ≈ 11 GB que estimaba §8.8, porque el
  tamaño de SQL Server incluye índices y espacio reservado. Prod pasó de 45 a **47 GB**.
- Las 252 tablas viven en 201 tablas físicas: los repositorios del ADD comparten tabla y se distinguen por `_repo`.
- **143 de las 252 se leyeron de una pasada** (sin llave legible: el SAT, el directorio y las hijas del ADD).
- El log del pod cierra con `CARGA: 388 tablas · 29,115,432 filas copiadas · 41.5 min`, **sin línea de conteo
  distinto ni de fallas**. Las de nóminas se toman de ahí: `contpaqi_nom` no se concede a ningún rol de lectura, y su
  `_sync_status` sólo lo lee `postgres`.
- Se omitieron a propósito tres tablas `Certificates` (llaves privadas): la del directorio y las de dos repositorios
  «otros».
- ⚠️ **Dos bases de metadatos del ADD no llegaron**, aunque `DB_Directory` lista las dos: `document_4d8ceea4…` y
  `other_d112b0ed…`. En el log **no aparecen ni como fuente**, así que no estaban `ONLINE` o no existen: no fue un
  error de permiso ni una base vacía, que sí se habrían impreso. El replicador filtraba `sys.databases` por `ONLINE`
  y las saltó **sin decir nada**. Ya no: ahora toda base esperada que falte sale como NO MEDIDO, con su estado, y pone
  en 1 el código de salida (`321110f68`).

**⛔ El incidente del primer ensayo (08:56–09:00).** El humo sobre `GeneralesSQL` copió a prod columnas de
credenciales durante unos cuatro minutos: las contraseñas de los usuarios de ContPAQi, que ContPAQi llama `Clave`, y
los tokens de sesión de `ListaEmpresas`. El filtro buscaba «password» y no las reconocía. Se corrigió (`ee3dd2809`,
`c22af9abd`) y la segunda corrida **borró esas columnas de prod**; el replicador las vuelve a borrar si alguna vez
reaparecen. Qué credenciales se rotan lo decide Edgar (regla 7).

**Lo que cambió del diseño de §8.3, con su porqué:**
1. **Columnas:** §8.3.1 hablaba de `_rv` y `_replicado_en`. Se dejó `rowversion` como una columna más, 1:1 con el
   origen, y se agregó `_synced_at`. Crudo quiere decir sin renombrar.
2. **`NOLOCK`:** §8.3.4 decía «sin `NOLOCK`». Las tablas con llave se leen por llave, en trozos y con `READ
   COMMITTED`. Las que **no tienen llave** se leen de una pasada con `NOLOCK`, porque una pasada larga con candados
   frenaría a contabilidad. Está declarado: la sincronía corrige en la vuelta siguiente lo que se haya leído a medias.
3. **`BINARY_CHECKSUM`:** §8.3.2 lo proponía para las tablas sin `RowVersion`. No se usó porque Postgres no lo puede
   reproducir, y entonces sólo serviría contra una huella guardada, no contra la réplica. Se usan sumas que dan lo
   mismo en los dos motores.
4. **El reconciliador diario de §8.3.3 no hace falta aparte.** La sincronía ya es el árbitro: en cada vuelta compara
   el origen contra la réplica. Lo que sigue faltando es su latido.
5. **`CP.9.1` (el mecanismo en una tabla, contra una base de prueba) quedó absorbido.** Edgar pidió la carga ya, y
   la sincronía en seco sólo lee: el costo en `.35` y la prueba negativa que pedía CP.9.1 se miden con ella en el pod.

**La sincronía (`--sync`) — ADR-111.** `RowVersion` resultó ser un entero **al azar** que ContPAQi regenera en cada
escritura: 111,182 valores distintos en 111,185 pólizas, de 977 a 2,147,468,696. No sirve de marca de agua, pero sí
de huella.
- La llave se parte en tramos de ~4,096 filas y en los dos lados se calcula, por tramo, las filas y la suma de cada
  columna que se suma exacta. Sólo el tramo que difiere se recopia, en una transacción.
- Si la llave no es entera, la tabla se compara entera hasta 100,000 filas. Arriba de eso queda **sin carril**,
  dicho en `_sync_status.note`.
- ⛔ **Los importes de ContPAQi son `float`**: 149 columnas en 14 tablas (`Importe`, `Cargos`, `Abonos`,
  `SaldoIni`, `Importes1..14`). La primera versión de la huella los dejaba fuera, porque la suma de un `float`
  depende del orden, y con eso un saldo movido sin cambiar `RowVersion` pasaba de largo. Ahora se suma su **patrón de
  bits** como entero, que es el mismo en SQL Server y en Postgres.

Medido del lado de Postgres, contra la réplica en prod, con el código real del replicador cargado sin su `main` y
cruzado contra una **segunda implementación** (sumas fila por fila en JS, los bits con `Buffer`):

| Tabla | Modo | Filas | Tramos | Sumas | Huella en Postgres | 2ª implementación | El comparador, roto a propósito |
|---|---|---:|---:|---:|---:|---|---|
| `ct_polizas` | tramos | 111,185 | 28 | 17 | 0.2 s | 3 de 3 tramos iguales | lo ve |
| `ct_movimientospoliza` | tramos | 1,163,368 | 285 | 15 | 1.7 s | 3 de 3 | lo ve |
| `ct_saldoscuentas` | tramos | 187,647 | 46 | 20 | 0.4 s | 3 de 3 | lo ve |
| `ct_asoccfdis` | tramos | 999,751 | 245 | 3 | 0.9 s | 3 de 3 | lo ve |
| `gen_municipios` | tramos | 2,457 | 1 | 2 | 0.0 s | 1 de 1 | lo ve |
| `sat_c_claveprodserv` | entera | 52,844 | 1 | 2 | 0.0 s | 1 de 1 | lo ve |
| `add_totalpagos` (repo principal) | entera | 46,303 | 1 | 11 | 0.0 s | 1 de 1 | lo ve |

**El lado de SQL Server, medido en el pod (2026-10-30).** Tres corridas seguidas, todas desde `feeds-cron`:

| Corrida | Alcance | Tablas | Tramos | Resultado | Tiempo |
|---|---|---:|---:|---|---:|
| 10:01, en seco + prueba negativa | contabilidad, Generales, SAT, directorio | 163 | 1,337 | 149 al día · **18 tramos difieren** | 29 s |
| 10:50, `--apply` | lo mismo | 163 | 1,337 | **10 tramos recopiados (20,771 filas)**, sin fallas | 26 s |
| 10:51, en seco + prueba negativa | **todo** | 413 | 2,702 | 391 al día · **1 tramo difiere** (`Doc_App`, del ADD) · 21 sin carril | 78 s |

- ⭐ **Los `float` cuadran por sus bits en los dos motores.** A la primera, 1,319 de 1,337 tramos salieron iguales,
  incluidos los de importes: 43 de 46 en `SaldosCuentas`. Si la conversión a bits difiriera, habrían salido todos
  distintos.
- **La réplica converge.** Lo que difería era lo que contabilidad capturó después de la carga (pólizas, movimientos,
  asociaciones de CFDI, saldos, IVA, contadores). Después de la escritura, la vuelta siguiente dio **la contabilidad
  entera al día**, y nóminas también.
- **La prueba negativa vio la fila movida en 366 tablas y no la vio en 0.** Entre ellas están las de nóminas, que no
  tienen `RowVersion`: también ahí la huella funciona sólo con las sumas. De las 26 «sin concluir», 25 eran tablas
  del ADD **vacías para ese repositorio** en los dos lados, sin fila que mover; ya no se les hace control
  (`14f62bd34`). La otra era `ParametrosInicialesMto`, cuya única fila trae `RowVersion` NULL; ahora la prueba borra
  la fila en vez de rendirse (`0f89b513b`).
- **Lo más lento:** `nom10007` (4 M filas, 20 s con la prueba negativa), `nom10034` 6.7 s y `MovimientosPoliza` 5.3 s.
  La contabilidad sola tarda menos de 30 s por vuelta.
- **Las 2 bases del ADD que faltaron «no existen en el servidor»:** el directorio las lista y nunca se crearon. La
  réplica está completa. Se informan sin poner el código de salida en 1: una alarma que suena siempre deja de oírse.
- **21 tablas sin carril**, todas del ADD, sin llave entera y con más de 100,000 filas: `Comprobante`, `Conceptos`
  (4.2 M), `Documento`, `Impuesto_Traslado`, `Impuesto_Traslado_Concepto` (4.8 M), `ImpuestosTotalizados`,
  `TimbreTemp`, `Pagos`, `Pagos_Doc_Rel`, `Expedientes` (1.1 M), `TempAsocToolAccountingPol` y las `Nomina*`, en sus
  repositorios. Valen la carga del 2026-10-30 hasta `CP.9.6`.
- ⚠️ **Una diferencia que desapareció sola.** Seis tablas que diferían a las 10:01
  (`DocumentosAdministrativos`, `MovimientosAdministrativos`, `AsocDoctosAdministrativos`, `TiposPolizas`,
  `SaldosSegmentoNegocio`, `PolizasIntuitivas`) estaban al día a las 10:50 sin que nadie las recopiara. Hay dos
  explicaciones: la huella, que lee con `NOLOCK`, vio una captura sin terminar que después se canceló, o se dio de alta
  algo y después se borró. Si ContPAQi deja abierta la transacción mientras se captura, la recopia, que sí lee con
  candado, la esperaría hasta 10 minutos. Por eso ahora espera 10 s como máximo, y ese tramo se reintenta en la vuelta
  siguiente (`14f62bd34`). ⚠️ **NO EJERCIDO** contra un candado real: sólo con la forma conocida del error (1222).

**Disco, medido el 2026-10-30** (el riesgo de §8.6): el disco de `md` tiene 492 GB y quedan 81 GB libres (83 % en
uso). Prod pesa 45 GB con la réplica adentro. Alcanza, pero el 83 % hay que vigilarlo.

**Lo que falta para cerrar `CP.9.2`:**
1. ~~Ejercer la sincronía en el pod~~ ✅ 2026-10-30, arriba.
2. **D15**, y con ella agendar la sincronía en `feeds-cron` con su latido de entrega y su umbral en `CRON_JOBS`
   (ADR-053), probado en rojo. Sin la D15 sólo se puede correr a mano. Cadencia propuesta, por lo medido:
   - la contabilidad y Generales, cada 5 minutos (menos de 30 s por vuelta);
   - nóminas, SAT y directorio, cada hora.
3. **La migración** `20261029180144_contpaqi_ods_schema.js` por el carril de entrega. En prod no cambia nada (el
   replicador ya creó lo mismo), pero tiene que quedar registrada.
4. **El ADD grande** (`Comprobante`, `Conceptos`, `Impuesto_Traslado_Concepto`) por `Documento.TimeStamp`: va en
   `CP.9.6`.

### 8.10 `[CP.9.3]` Primer hallazgo sobre la réplica: ContPAQi cierra ejercicios, no meses (2026-10-30)

La primera pregunta de §8.2 era *«¿qué periodos tiene cerrados contabilidad?»*. Medido sobre `contpaqi_ods`:
- **La única marca de cierre es por ejercicio:** `Ejercicios.IdPolCierre` guarda el `Id` de la póliza de cierre.
  2017 a 2024 la tienen; 2025 y 2026 tienen 0, o sea que siguen abiertos.
- **No hay bloqueo por mes.** Ninguna columna de la contabilidad ni de las Generales se llama `bloq*`, `cerr*` ni
  `lock*`, salvo las dos de `Ejercicios`. `Parametros.EjerActual`/`PerActual` es el periodo que tiene abierto la
  pantalla, no un candado.
- ⚠️ **El cierre no impide capturar.** Después de la póliza de cierre de 2024 entraron **24 pólizas más** de ese
  ejercicio (por `Id`, que crece con cada alta), y también pasó en 2018 (3), 2019 (1), 2020 (3) y 2021 (1).
  Contabilidad ajusta después de cerrar y vuelve a cerrar.

**Lo que esto le dice al dictamen (`CP.9.4`):** la regla `periodo_cerrado` mira el ejercicio, no el mes. Como
ContPAQi sí acepta la póliza, la severidad propuesta es **«revisar»**, con el motivo dicho: *el ejercicio ya tiene
póliza de cierre y entregarle algo obliga a rehacer el cierre*. Si «bloquea» o «revisar» lo decide Edgar (era la D11
de CP.8). El testigo ya está (§8.11): la póliza de cierre existe y es del periodo 14 en los 8 ejercicios cerrados, y
los abiertos no tienen ninguna en ese periodo.

### 8.11 `[CP.9.3]` Las vistas de control, en código y medidas (2026-10-30)

Migración `20261030114159_cp93_vistas_de_control_contpaqi.js`: dos vistas en `analytics` y diez índices por expresión
en la réplica, para buscar por UUID o por póliza. ⚠️ **No está aplicada**: entra a prod por el carril de entrega.

**`analytics.v_contpaqi_cfdi_poliza` — qué CFDI está en qué póliza.** ContPAQi guarda la asociación por tres caminos,
y el importador de pólizas sólo conocía uno, a medias:

| Camino | Apunta a | Asociaciones | CFDI |
|---|---|---:|---:|
| `AsocCFDIs` | un movimiento | 411,321 | 165,317 |
| `AsocCFDIs` | **la póliza entera** | 587,445 | 516,478 |
| documentos administrativos | la póliza entera | 135,822 | 118,871 |
| nodos de pago (REP) | un movimiento | 2,414 | 1,139 |
| nodos de pago (REP) | la póliza entera | 8,892 | 8,809 |
| **total** | | **1,145,894** | **519,781** |

1,020 asociaciones de `AsocCFDIs` apuntan a algo que ya no existe y quedan fuera.

Los cruces:
- **Contra la marca del ADD** (`fiscal.cfdis.aso_contabilidad`), que es otro sistema. Sobre 45,462 CFDI de ene–sep
  2026, **99.40 % de acuerdo**. El placebo (la marca del CFDI vecino) da 91.73 %, que es el azar cuando el 95 % está
  asociado: la vista se equivoca **14 veces menos** que el azar (272 desacuerdos contra 3,758; kappa 0.93).
- ⭐ **Un punto ciego del ADD:** los 271 CFDI que sólo la vista asocia pasan **todos** por documentos
  administrativos. La marca del ADD no ve ese módulo. En la otra dirección hay uno solo.
- **Contra el staging** (`analytics.gl_poliza_lines.cfdi_uuid`): la vista contiene el 99.98 % (49,011 de 49,023). Los
  12 que faltan son del staging, que se quedó rancio: contabilidad reasoció a nivel póliza (2026-07, egresos 116) o
  quitó la asociación (2026-10, egresos 5365), y el importador sólo refresca una póliza cuando cambia su
  `RowVersion`, cosa que reasociar no hace.
- ⛔ **Lo que esto le dice al dictamen:** el staging conoce **21,363 UUID** y la vista **137,116** desde 2025. El
  dictamen, que pregunta al staging si un CFDI ya está en una póliza de egresos, ve hoy **el 16 %**. Se corrige en
  `CP.9.4`.

**`analytics.v_contpaqi_ejercicio` — qué ejercicio está cerrado.** Dice si está cerrado, con qué póliza de cierre y
cuántas pólizas entraron después. Testigo: los 8 cerrados tienen su póliza de cierre en el periodo 14 (diario, folio
1000); 2025 y 2026 no tienen ninguna póliza en ese periodo.

**Cómo se probó:**
- `database/tests/test-newdb-contpaqi-vistas-control.js`, en la base local de desarrollo y dentro de una transacción
  que se deshace: **22 de 22**. Incluye tres pruebas negativas que hacen **abortar** la migración (un GUID repetido,
  un cierre del periodo 5 y un cierre de otro ejercicio), la idempotencia, el `down` y que la búsqueda por UUID usa
  los índices.
- **El `up()` real contra prod, en sólo lectura:** lo que escribe se saltó y cada vista se validó con `EXPLAIN` de su
  cuerpo. No aborta: 1,145,894 = 1,145,894 por los dos caminos, y 8 cerrados con testigo.
- ⚠️ **NO MEDIDO:** la latencia por UUID con los índices en prod. Se mide al aplicar la migración.

**Pendiente, `CP.9.3b`: los impuestos por movimiento** (`MovimientosImpuestos`, 334,491). Decodificado por su
distribución:
- `impuesto`: 2 = IVA, 3 = IEPS, 1 = ISR;
- `tipomovimiento`: 1 = traslado, 2 = retención;
- `tipofactor`: 1 = tasa, 2 = cuota, 3 = exento.

Faltan los códigos 4, 5 y 0 de `impuesto`. El 5 trae base 0 en todas sus filas. Necesitan un testigo antes de
publicarse en una vista.

### 8.12 `[CP.9.4]` El dictamen pregunta a la réplica (2026-10-30)

Commit `c00b75e72`, en `dictamen.ts` y `dictamen.contexto.ts`. Hoy nadie llama a `leerContextoDictamen`; antes de
cablearlo a un endpoint hay que aplicar la migración de `CP.9.3`.

- **«El CFDI ya está en otra póliza de egresos»** (`cfdi_ya_pagado`) sale ahora de
  `analytics.v_contpaqi_cfdi_poliza`, **unida** al staging: la réplica está completa hasta su última sincronía y el
  staging es fresco al minuto. Juntas no ven menos que antes. Medido en prod sobre los CFDI recibidos por la empresa:

  | Mes | CFDI recibidos | Antes (staging) | Después (réplica ∪ staging) | Lo que sólo aportaba el staging |
  |---|---:|---:|---:|---:|
  | ago-2026 | 1,280 | 573 (45 %) | **1,045 (82 %)** | 0 |
  | sep-2026 | 1,068 | 365 (34 %) | **742 (69 %)** | 0 |

- **`ejercicio_cerrado`** (perspectiva fecha, **revisar**): sale de `analytics.v_contpaqi_ejercicio`. No bloquea
  porque ContPAQi acepta la póliza (§8.10). Un ejercicio que no está en la réplica y uno que no se pudo leer también
  van a revisar. ⚠️ Si «bloquea» o «revisar», lo confirma Edgar (D11 de CP.8); cambiarlo es una línea.
- **`replica_rancia`** (duplicado, **revisar**): si las tablas de asociación de la réplica llevan más de un día sin
  sincronizarse, lo que contabilidad asoció después no se ve, y se dice. Mientras la sincronía corra a mano (D15),
  esto va a salir seguido, y es lo honesto.
- **Pruebas:** `dictamen.spec` 38 de 38. Las dos nuevas traen su control: un ejercicio cerrado distinto no toca a la
  póliza, la réplica de ayer no cuenta como rancia y sin CFDI la regla no aplica. **Prueba negativa:** con la resta
  de días al revés, la de la réplica rancia se pone roja.
- **Falta en `CP.9.4`:** que el cuadre del puente también lea de la réplica.
