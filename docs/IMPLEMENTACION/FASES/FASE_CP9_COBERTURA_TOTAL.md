# FASE CP.9 — Cobertura total de ContPAQi

> **Estado:** 🔍 PLAN MEDIDO 2026-10-09 · sin código · **ADR:** hereda ADR-040
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
