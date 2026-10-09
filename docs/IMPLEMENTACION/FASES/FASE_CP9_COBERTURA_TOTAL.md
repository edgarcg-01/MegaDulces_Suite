# FASE CP.9 — Cobertura total de ContPAQi

> **Estado:** 🔍 PLAN MEDIDO 2026-10-09 · sin código · **ADR:** hereda ADR-040
> **Pedido de Edgar:** *"generemos un plan a futuro de cubrir el 100% de ContPAQi"*.
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
