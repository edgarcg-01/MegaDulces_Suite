# P-COM-00 — Qué documento oficial debe emitir cada paso

> **Estado: PROPUESTA DE DISEÑO.** Nada de lo que está acá está construido. Lo que hoy existe se
> marca ✅; lo que no, se marca ⬜ y se dice qué costaría. · [índice](README.md)
>
> Sale de haber escrito los nueve procedimientos: al preguntarle a cada paso *«¿qué queda
> registrado?»*, **siete de nueve contestan "nada" o "sólo un estado"**.

---

## 1. El principio, y de dónde sale

⭐ **En Kepler cada eslabón del flujo ES un documento**: `X-A-30` → `X-A-35` → `X-A-37` → `X-A-40`
→ `X-A-20`. Cada uno con folio, fecha, responsable y renglones; cada uno enlazado al padre por
`c36`–`c39`. Esa es la razón por la que, 200 días después, se puede reconstruir qué pasó.

En la Suite hoy:

| paso | documento hoy | ¿se puede reconstruir después? |
|---|---|---|
| 01 Ciclo | ⬜ nada | no |
| 02 Armado | ⬜ nada | no |
| 03 Armar requisición | ✅ `RQ-YYYY-NNNNN` | **sí** |
| 04 Vigencia del costo | ⬜ sólo `recalculated_at/by` | parcial |
| 05 **Autorización** | ⬜ sólo `approved_by/at` | parcial |
| 06 Salida a Kepler | ⬜ sólo la coordenada o el error | parcial |
| 07 Orden de compra | ✅ `OC-YYYY-NNNNN` (interna) · coordenada del `X-A-35` | parcial |
| 08 Recepción | ✅ `OE-YYYY-NNNNN` + XA2001 del ERP | **sí** |
| 09 Cierre del lazo | ⬜ nada | no |

## 2. El criterio para decidir si un paso merece documento

⛔ **No se hace un acta por paso porque quede simétrico.** Un documento oficial cuesta: hay que
emitirlo, guardarlo, mostrarlo y explicarlo. Un paso lo merece si cumple **al menos dos** de estas
tres:

1. **Alguien responde por él.** Hay una decisión humana que se puede cuestionar después.
2. **Hay que poder reconstruirlo.** El estado final no alcanza para saber qué se decidió.
3. **Alguien de afuera lo mira.** Proveedor, auditoría, contabilidad o dirección.

Aplicando el criterio:

| paso | (1) responde | (2) reconstruir | (3) externo | veredicto |
|---|:--:|:--:|:--:|---|
| 01 Ciclo | ✔ | ✔ | — | **acta ligera** |
| 02 Armado | ✔ | ✔ | — | **se resuelve dentro del `RQ`**, no con acta aparte |
| 03 Armar | ✔ | ✔ | ✔ | ✅ ya existe |
| 04 Vigencia | — | ✔ | — | **nota dentro del `RQ`** |
| 05 **Autorización** | ✔ | ✔ | ✔ | ⭐ **acta propia — la más importante** |
| 06 Salida al ERP | — | ✔ | ✔ | **constancia técnica** |
| 07 Orden | ✔ | ✔ | ✔ | ✅ existe, **pero los dos caminos no convergen** |
| 08 Recepción | ✔ | ✔ | ✔ | ✅ ya existe |
| 09 Cierre | ✔ | ✔ | — | **acta de periodo** |

## 3. ⛔ Y un candado de arquitectura antes de escribir una línea de código

**ADR-056: un primitivo inventado en una fase no cierra la fase.** Si cada paso inventa su propia
tabla de actas, su propio folio y su propio PDF, en seis semanas hay siete mecanismos distintos
para la misma idea — que es exactamente lo que ya pasó con las bandejas de hallazgos (ocho fases
inventaron la suya).

➡️ **Un solo primitivo**, en `libs/`, usado por los cinco pasos: `acta(tipo, sujeto, autor,
contenido)` con folio por tipo, sello de tiempo, actor, y **contenido inmutable**. Si no se puede
construir compartido, se declara como deuda **con nombre** en el tracker.

---

## 4. Las cinco actas propuestas

### ⭐ ACT-APR — Autorización *(prioridad 1)*

**Por qué primero:** es el acto de control del flujo —una sola persona concentra el **97 %** de las
autorizaciones (505 de 519)— y hoy **no produce constancia**: la firma son dos columnas.

| | |
|---|---|
| Folio | `ACT-APR-YYYY-NNNNN` |
| Se emite al | aprobar o rechazar (también en lote: **una por documento**, no una por clic) |
| Contenido | requisición, lote, proveedor, almacén, total, **renglones con `suggested_qty` y `final_qty`**, veredicto de vigencia del costo al momento de aprobar, autor, sello de tiempo, y **motivo** si es rechazo |
| Lo que resuelve | que *"lo aprobó Arizbeth"* deje de ser una fila y pase a ser un documento con lo que ella vio |
| Lo que **no** resuelve | el god-mode: un superadmin que autoriza emite acta igual, pero la emite **como superadmin** y eso debe verse |

⚠️ **El motivo del rechazo hoy no se captura en ningún lado.** 368 requisiciones están
`cancelled` por **$34.27 M** y ninguna dice por qué.

### ⬜ ACT-REV — Revisión de ciclo *(prioridad 3)*

Cierra el hueco de [P-COM-01](P-COM-01_ciclo_que_toca_hoy.md) §5: hoy *«lo revisé y está cubierto»*
se ve **idéntico** a *«nunca lo miré»*.

Acta **ligera**: qué canales se revisaron, cuáles se dejaron pasar y con qué razón de una línea.
⛔ No debe volverse un trámite: si revisar el ciclo cuesta un formulario, nadie revisa el ciclo.

### ⬜ ACT-KEP — Constancia de salida al ERP *(prioridad 2, nace con el encendido)*

[P-COM-06](P-COM-06_salida_a_kepler.md) deja hoy una coordenada o un error. Falta la constancia de
**qué se escribió**: los renglones exactos, la unidad usada y el documento plantilla clonado.

⭐ **Por qué no es burocracia:** la única coordenada que existe hoy —`RQ-2026-00807` →
`00/X-A-30/0003114`— **apunta a un documento borrado**, y desde la Suite se ve igual que una
entregada. Con el contenido guardado, un documento ausente en el ERP se detecta comparando; sin él,
hay que ir a contarlos a Kepler.

Debería incluir el **cuadre de unidad**: cajas enviadas, unidad escrita y factor. Es la columna que
hoy sólo se puede reconstruir a mano (y que, medida, es **`c58` en 37 de 37**).

### ⬜ ACT-CIE — Conciliación del periodo *(prioridad 3)*

[P-COM-09](P-COM-09_cierre_del_lazo.md) no deja nada. El acta del periodo congela: cuántas
requisiciones, cuántas aterrizaron, cuántas quedaron `sin_oc` **y la razón declarada de cada una**.

⭐ Es lo que convertiría las **62 requisiciones sin documento del proveedor (51.2 %)** de pregunta
abierta en pendiente con dueño.

### ⬜ Nota de recálculo — dentro del `RQ`, no acta aparte *(prioridad 4)*

[P-COM-04](P-COM-04_bandeja_y_vigencia.md): guardar **qué cambió** (renglones tocados, monto antes y
después), no sólo *cuándo*. Es una nota en la requisición; no merece folio propio.

---

## 5. Lo que NO se propone, y por qué

| idea | por qué no |
|---|---|
| Acta del paso 02 (armado) | lo que hay que conservar —sugerido contra decidido— **ya viaja en los renglones del `RQ`**; un acta aparte duplicaría el dato |
| Acta de recepción propia | ya existe `OE-YYYY-NNNNN`, y el documento con valor legal es la **XA2001 que firma el proveedor** |
| Firma electrónica | no hay pedido de negocio que lo justifique; el actor + sello de tiempo alcanza para reconstruir |
| Un PDF por cada acta | el PDF es para lo que **sale de la empresa**. Un acta interna se consulta en pantalla; imprimirlo todo es costo sin lector |

---

## 6. Lo que falta decidir antes de construir

1. **¿Quién es el lector?** Si el acta es para auditoría interna, el contenido mínimo cambia
   respecto de si es para dirección.
2. **¿Cuánto se conserva?** No hay política de retención escrita para ninguna tabla de compras.
3. **¿El acta es inmutable?** La propuesta asume que sí. Si alguien tiene que poder corregirla,
   entonces hace falta versión — y eso es otro primitivo.
4. **¿Dónde vive el folio?** Por tipo de acta y por tenant, con el mismo patrón atómico que
   `requisition_sequences`.

⚠️ **Nada de esto entra sin la regla del método de trabajo:** no se abre fase sin métrica medida
hoy, y hay **fase 0 de aterrizaje en curso** — esto se agenda, no se empieza porque está escrito.

---

## 7. Resumen en una línea

**De los nueve pasos, tres ya emiten documento y seis no.** El que más falta es el **acta de
autorización**: es el único acto de control del flujo y hoy no deja más rastro que dos columnas en
una fila.
