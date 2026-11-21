# Fase G · frente G1 — Anexo: promociones con proveedor, del pacto al cumplimiento (`[MKT.32]`–`[MKT.44]`)

> **Qué es:** el detalle del frente **G1 · Alta de promoción** del plan maestro
> [`FASE_G_GROWTH_CAMPANAS.md`](FASE_G_GROWTH_CAMPANAS.md) (issue #96 del PM). Continúa la fase MKT
> ([`FASE_MKT_RANKING_PROMOCIONES.md`](FASE_MKT_RANKING_PROMOCIONES.md)), aprobada por el PM como continuación el 2026-11-20. Termina `[MKT.1]` (tablas y endpoints que existen
> en prod desde el 2026-10-01 y nadie usa) y lo conecta con el Ranking que ya está en prod (`[MKT.28]`–`[MKT.31]`, #560).
> **Método:** [`METODO_DE_TRABAJO.md`](../../METODO_DE_TRABAJO.md) — capas C0 → C3, una capa no sube hasta que la de abajo está verificada.
> **Hereda:** ADR-056 (lo no medido se declara) · ADR-059 (la cifra se arbitra) · regla principal (cero importers: el pacto es dato propio, lo vendido sale de Kepler).

```
OBJETIVO: que cada promoción pactada con un proveedor quede en la Suite con su evidencia, y no se cierre
          hasta que el proveedor cumpla lo que prometió (nota de crédito, producto sin cargo, pago…).
MÉTRICA:  promociones con expediente en la Suite — HOY: 0 (prod, 2026-11-20) → META: toda promoción nueva
          con evidencia y folio · fecha: [la fija el PM]
          2ª: promociones terminadas «esperando al proveedor», con días — HOY: NO MEDIDO (no existe registro)
CAPA TOPE: C3
ÁREA:      Comercial / Mercadotecnia
DUEÑO:     dev responsable de MKT (ver Tablero PM)
ESTADO:    ⬜ — propuesto; espera la firma del PM a este plan
```

**Cómo se midió el HOY** (2026-11-20, sólo lectura, `pg-prod` verificada por `system_identifier`, transacción `READ ONLY`):
`commercial.promo_agreements` / `_codes` / `_channels` / `_files` = **0 filas** · migraciones de `[MKT.1]` aplicadas el
2026-10-01 · `analytics.ui_usage` 30 días: `GET /promo-agreements` **1** llamada (superadmin), el Ranking **105**
(Mercadotecnia sí entra a MKT, pero no a Acuerdos).

---

## 1. Qué problema resuelve

Mercadotecnia negocia promociones con los proveedores en papel (formato **MKTN001**). El proveedor manda su
aprobación por correo, WhatsApp o PDF y **promete algo a cambio**: una nota de crédito por lo regalado,
cajas sin cargo, promocionales o un pago. Hoy:

| Hecho | Medido / fuente |
|---|---|
| Lo pactado vive en papel; la Suite tiene 0 acuerdos | prod, 2026-11-20 |
| Nadie sigue si el proveedor **cumplió**: no hay registro de lo que se le debe a Mega Dulces | NO MEDIDO — es justo lo que falta |
| `[MKT.1]` construyó tablas, endpoints y permisos, pero **ninguna pantalla crea, autoriza ni cierra** | `mkt-acuerdos.component.ts` sólo lista; `crear`, `autorizar`, `cambiarEstado` no tienen consumidor |
| Cerrar un acuerdo **no pide ninguna evidencia** | `promo-agreements.service.ts:478` |
| La evidencia se sube **tecleando un enlace**, no un archivo | `subirEvidencia`, `promo-agreements.service.ts:506` |
| El folio sale del **mismo contador que los pedidos** (cada acuerdo se come un número de pedido) | `promo-agreements.service.ts:608` y `commercial-orders.service.ts:3665` |
| Un canal se modela como **almacén**: Mayoreo, Ruta diaria y Ruta vecinal no caben | `commercial.warehouses` en prod = sucursales 00–08 |
| Las tiendas consultan los acuerdos de su sucursal y les sale vacío | `ui_usage`: 33 llamadas a `/promo-agreements/sucursal/:code` en 17 días |

**Qué cambia para Mercadotecnia:** abre la Suite y ve sus promociones **activas con lo que llevan vendido**;
da de alta una promoción empezando por la evidencia del proveedor; ve qué proveedores **le deben** y desde
cuándo; y exporta un **PDF para el proveedor** con lo vendido, para cobrar la nota de crédito.

---

## 2. Cómo cambió el pedido (sesión de diseño, 2026-11-19/20)

| # | Lo que se pidió | Efecto en el plan |
|---|---|---|
| 1 | «Un expediente con lo que manda el proveedor, como evidencia» | `promo_agreement_files` con tipo *negociación*; se sube un archivo, no un enlace |
| 2 | «Un ciclo: cuando el proveedor cumpla, se adjunta la evidencia y se cierra» | Estado «esperando al proveedor» + regla: **no se cierra sin prueba de cumplimiento** |
| 3 | «Con el mensaje del proveedor basta como aprobación» (jefe de MKT) | **No se autoriza sin evidencia del proveedor**; la firma en papel deja de ser requisito |
| 4 | «El folio empieza de nuevo» | Folio `MKT-0001` con **contador propio**, continuo |
| 5 | «MDTask se olvida, todo queda en este módulo» | Las promociones salen de la fase MDT (cambia su D9b) |
| 6 | «La evidencia al principio de la alta» | La alta abre con la evidencia (paso 1) |
| 7 | «Al principio, las activas y lo que llevan vendido» | «Lo vendido» **entra a la v1** (antes era una entrega posterior) |
| 8 | «Los códigos los buscan libres en Kepler» | La alta **no** pide el código; se anota en el expediente. ⭐ Los códigos **se reutilizan**: se ligan siempre con la vigencia |
| 9 | «Exportar el PDF para el proveedor» + «historial por proveedor y producto» + «buscador» | `[MKT.43]`, `[MKT.44]` |

---

## 3. Qué NO incluye

- **Crear el código de promoción en Kepler:** se sigue haciendo en Kepler, como hoy. La Suite sólo anota cuál se usó. La Suite **no escribe en Kepler**.
- **Detectar sola la nota de crédito del proveedor.** Existe `analytics.v_supplier_credits` (`[PGP.17]`), pero ligar NC ↔ promoción por proveedor + monto + fecha ya falló en otro módulo (RE.62: 36 de 42 tomaban la nota equivocada). En la v1 una persona adjunta la prueba; Kepler podrá **sugerir** después.
- Migrar los folios en papel ni lo capturado en MDTask: el historial empieza en `MKT-0001`.
- Firma electrónica; la mecánica estructurada por renglón (sigue como texto, una línea por mecánica); incentivos y «pesos por caja» (van aparte en la fase MKT).
- Cambiar la evidencia de ejecución por plaza (fotos de la exhibición) que `[MKT.1]` ya tiene: se conserva.
- CORS, credenciales, variables de entorno: nada.

---

## 4. Decisiones

| # | Decisión | Opciones | Resolución |
|---|---|---|---|
| D1 | Folio | a) seguir el número del papel · b) `MKT-0001` con contador propio | ✅ **b**, continuo, sin reinicio anual (dev de MKT, 2026-11-20). El prefijo evita confundirlo con los folios en papel |
| D2 | Qué es un canal | a) almacén (hoy) · b) canal de venta + sucursal | ✅ **b**: las mismas 4 palabras del Ranking (`mostrador`, `preventa`, `ruta`, `mayoreo`). Ruta vecinal = `preventa`, Ruta diaria = `ruta` |
| D3 | Qué archivos se aceptan | a) PDF e imagen · b) casi todo | ✅ **b**, pero **nunca** ejecutables, HTML, SVG ni scripts (riesgo de ejecutar código al abrirlos); 15 MB por archivo. Lista propia del módulo: la de `platform-core` es compartida y no se amplía |
| D4 | Cupo de fases | continuación de MKT · esperar | ✅ **continuación de MKT** (PM, 2026-11-20) |
| D5 | Cuándo se anota el código de Kepler | en la alta · en el expediente | ✅ **en el expediente**, en cualquier momento antes de cerrar (pedido 8) |
| D6 | De dónde sale la lista de códigos | a) `mkt_ranking_promos` · b) los de Kepler que lee el Ranking (`catalog.products.is_promo`) | ✅ **b**: `mkt_ranking_promos` tiene 0 filas en prod; el Ranking ya lee de Kepler |
| D7 | Desglose LP/CAN/MOR de Mayoreo y Ruta diaria | — | LP = La Piedad Abastos · CAN = Canindo · **MOR = ⬜ ¿Morelia Madero, Morelia Abastos o las dos?** (pregunta a Mercadotecnia) |
| D8 | «Vendido» en qué unidad | paquetes (veces que se aplicó el código, como el Ranking) · piezas · cajas | ⬜ **pregunta a Mercadotecnia**; la maqueta usa paquetes |
| D9 | «Piezas regaladas» del reporte para la NC | calcular desde la mecánica · capturar | ⬜ **pregunta a Mercadotecnia**: Kepler no liga el código con el producto regalado y la mecánica es texto. Mientras, el PDF dice «por definir», nunca 0 |
| D10 | ¿Los códigos se reutilizan? | — | ⬜ confirmar con Mercadotecnia. El diseño ya lo supone (código + vigencia) |
| D11 | Dinero de preventa/ruta/mayoreo | mostrar marcado «sin contrastar» · contrastarlo antes | Recomiendo **contrastarlo en `[MKT.34]`** contra Kepler; hasta entonces se muestra con «*» y su explicación (ADR-056) |
| D12 | `/mkt/resultado` (`[MKT.6]`) y `v_promo_agreement_sellout` | conservar · absorber en el expediente | Recomiendo **absorber**: dos lugares que miden «lo vendido» del mismo acuerdo terminan diciendo cosas distintas (ADR-056). Decide el PM |

---

## 5. Las capas

Cada capa se trabaja con su skill y se verifica antes de subir (`diseno`, `auditoria-diseno` y `entrega` son del repo; `criterio`, `capa-*`, `cierre-por-capas`, `bitacora-de-fase` y `sin-inventar` son la disciplina local del dev). **Ningún item de C3 empieza hasta que C0–C2 estén verificados.**

| Capa | Skill de apoyo | Qué la verifica |
|---|---|---|
| Antes de cada item | `criterio` (ficha: capas, fuente, impacto, reglas, plan, verificación) | La ficha escrita antes de la primera línea |
| C0 · Dato | `capa-datos` + `sin-inventar` | Cifra arbitrada contra un testigo del mismo ERP y grano |
| C1 · Dominio | `capa-dominio` | Prueba unitaria que puede fallar |
| C2 · API | `capa-api` | Prueba contra base real con el payload de la pantalla (CI `pruebas-db`) |
| C3 · Interfaz | `capa-interfaz` + `diseno` + `auditoria-diseno` §9 | `check:pantalla` antes y después, sin fallas nuevas |
| C4 · Plataforma | `capa-plataforma` + `entrega` | Migración aplicada una por una; `/api/health` con el commit |
| Al cerrar | `cierre-por-capas` + `bitacora-de-fase` | Reporte VERIFICADO / NO MEDIDO / PENDIENTE; tracker y log al día |

### C0 · Dato

| # | Item | Estado | Verificado contra |
|---|---|---|---|
| MKT.32 | **El acuerdo guarda canal + sucursal, su propio folio, el proveedor del catálogo y la prueba de cumplimiento** — migración generada (`node scripts/nueva-migracion.js`), idempotente: secuencia propia del folio; `promo_agreement_channels` con `canal` (CHECK de las 4 palabras) y `warehouse_id` opcional, nueva llave única canal + sucursal; `supplier_id` con FK a `catalog.suppliers`; tipo de archivo `cumplimiento`; `promo_agreement_codes` con su vigencia | ⬜ | Prueba de migración en el CI. Regla 14: recorrer **todos** los caminos que insertan (`promo-agreements.service.ts`, 2 semillas, 2 pruebas de base). Prod tiene 0 filas: sin conversión de datos |
| MKT.33 | **Lo vendido de una promoción, de su primer día a hoy, por canal y sucursal** — lectura de `analytics.v_kepler_sales_lines` por **código + vigencia** (los códigos se reutilizan), sin copiar nada | ⬜ | **Dos implementaciones:** para una semana completa debe cuadrar con el Ranking de esa semana · placebo: un código fuera de su vigencia da 0 renglones de este acuerdo · tiempo medido con la promoción más larga (NO MEDIDO hoy; la semana del Ranking tarda ~2.6 s) |
| MKT.34 | **El dinero de preventa, ruta y mayoreo queda contrastado** — `DINERO_CONTRASTADO` pasa a `true` sólo canal por canal, después del arbitraje | ⬜ | Contra el importe de Kepler (`kdm1.c16`) del mismo documento; si no cuadra, se queda en `false` y se dice |

### C1 · Dominio

| # | Item | Estado | Prueba que lo ejerce |
|---|---|---|---|
| MKT.35 | **El ciclo de la promoción es una regla pura**: borrador → autorizada → activa / esperando al proveedor (**derivadas de la vigencia**, sin botón) → cerrada · cancelada con motivo. **No se autoriza sin evidencia del proveedor; no se cierra sin prueba de cumplimiento** | ⬜ | Unitarias con los cinco caminos (feliz, sin evidencia, vigencia «hasta agotar», cancelada, cerrada que intenta reabrirse) |
| MKT.36 | **Lo vendido por promoción reutiliza la lógica del Ranking** (`mkt-venta.logic.ts`) con un rango de fechas en vez de una semana — un solo cálculo para Ranking y expediente (ADR-056) | ⬜ | Unitarias + la misma semana da la misma cifra por los dos caminos |

### C2 · API

| # | Item | Estado | ¿Escribe? | Prueba contra base real |
|---|---|---|---|---|
| MKT.37 | **Alta, autorización y cierre aplican el ciclo**: crear/editar borrador, autorizar (**409** sin evidencia), cerrar (**409** sin cumplimiento), agregar código de Kepler con su vigencia. Permisos existentes, ya repartidos: `MKT_AGREEMENTS_GESTIONAR` / `_VER` | ⬜ | sí | ⛔ Obligatoria, con el payload de la pantalla: alta → archivo → autorizar → cerrar; y los dos 409 |
| MKT.38 | **Se sube el archivo, no un enlace** — multipart (un archivo por envío, 15 MB) con `ObjectStorageService`; lista blanca de tipos (D3) validada por contenido; se sirve con URL firmada. No se toca el límite global del cuerpo JSON en `main.ts` | ⬜ | sí | ⛔ Obligatoria: un PDF entra; un `.exe` renombrado a `.pdf` **se rechaza** (prueba negativa) |
| MKT.39 | **Historial por proveedor y por producto, con buscador** — usa `applySmartSearch` (`libs/platform-core/src/lib/search/smart-search.ts`), no un buscador nuevo | ⬜ | no | Contra base real con datos de prueba ficticios |

### C3 · Interfaz

⛔ Antes del primer item: sección «Observaciones de diseño UI — revisión del plan» al final de este doc (`auditoria-diseno` §9). Sus 🔴 se vuelven items aquí. Maqueta validada con el usuario: <https://claude.ai/artifact/67jLkUDTPbN3bXKjzewMQD> (privada: el dev la comparte con el PM).

| # | Item | Estado | `check:pantalla` antes → después |
|---|---|---|---|
| MKT.40 | **La bandeja abre en las promociones activas con lo que llevan vendido** — pestañas Activas · Esperando al proveedor · Borradores · Cerradas; cifras sin texto de relleno; el dinero sin contrastar marcado con «*» y su ayuda | ⬜ | medir antes |
| MKT.41 | **La alta empieza por la evidencia del proveedor** — 5 pasos: evidencia · proveedor y vigencia · mecánica · qué prometió · canales. «Autorizar» deshabilitado hasta tener evidencia | ⬜ | medir antes |
| MKT.42 | **El expediente lleva el ciclo hasta cerrar con la prueba** — pasos del ciclo, lo pactado, lo vendido por canal, archivos con el visor que ya existe (`app-doc-viewer`), historial de movimientos, «agregar código» | ⬜ | medir antes |
| MKT.43 | **PDF para el proveedor** desde el expediente y el historial — reutiliza `compras-pdf-comun.ts` como lo hace `mkt-venta-pdf.ts`. El importe cobrado va **apagado** por defecto (dato interno); **nunca** salen notas internas, quién autorizó, adjuntos ni otros proveedores | ⬜ | medir antes |
| MKT.44 | **Historial de promociones con buscador** — por promoción y por producto; filtros proveedor, periodo, canal | ⬜ | medir antes |

La entrada ya existe en el menú: «Promociones MKT» › pestaña «Acuerdos». Carga < 500 ms o se declara.

### C4 · Plataforma

| Paso | Cómo |
|---|---|
| Migración `[MKT.32]` en prod | Una por una con `apply-one-migration-prod.js`, **fuera de horario hábil**; lo decide el PM |
| Despliegue | Carril de la skill `entrega`; testigo único: `/api/health` con el commit |
| Almacenamiento de archivos | Ya funciona en prod (Mesa de Servicio guarda archivos; último el 2026-11-19). Sin cambios de configuración |

---

## 6. Entregas (PRs)

| Orden | PR | Contiene | Por qué en este orden |
|---|---|---|---|
| 1 | C0–C2 | `[MKT.32]`–`[MKT.39]` | La pantalla no se construye sobre un dato sin árbitro (método §1) |
| 2 | C3 | `[MKT.40]`–`[MKT.44]` | Sólo con C0–C2 verificados y la revisión de diseño hecha |

---

## 7. Riesgos y bloqueos

| Bloqueo / riesgo | Dueño | Causa | Qué lo destraba |
|---|---|---|---|
| D7 · MOR | Jefe de Mercadotecnia | Hay dos sucursales en Morelia | Su respuesta; no bloquea C0 |
| D8 · unidad de «vendido» | Jefe de Mercadotecnia | Paquetes ≠ piezas ≠ cajas | Su respuesta antes de `[MKT.40]` |
| D9 · piezas regaladas | Jefe de Mercadotecnia | Kepler no liga código ↔ producto regalado | Cómo lo calcula hoy; hasta entonces «por definir», nunca 0 |
| D10 · reutilización de códigos | Jefe de Mercadotecnia | Si no se reutilizan, el diseño sigue sirviendo; si sí, la vigencia es obligatoria | Confirmación |
| D12 · `/mkt/resultado` | PM | Dos medidas del mismo hecho | Decisión antes de `[MKT.42]` |
| Tiempo de «lo vendido» en promociones largas | dev de MKT | NO MEDIDO | Medirlo en `[MKT.33]`; si pasa de 500 ms, se carga aparte y no frena la bandeja |
| Archivos con cambios de otra sesión (`main.ts`) | dev de MKT | Árbol compartido | Subida por multipart: no se toca `main.ts` |

---

## 8. Definición de Terminado

- [ ] 1. Métrica remedida en prod: promociones con expediente (antes 0) y «esperando al proveedor» con días
- [ ] 2. Cada capa verificada **o declarada NO MEDIDA** (ADR-056)
- [ ] 3. `[MKT.37]` y `[MKT.38]` ejercidos contra base real con el payload de la pantalla
- [ ] 4. Las reglas nuevas rotas a propósito una vez: autorizar sin evidencia → 409 · cerrar sin prueba → 409 · `.exe` disfrazado → rechazado
- [ ] 5. Sin primitivos nuevos fuera de `libs/`: buscador, PDF, almacenamiento y visor son los que ya existen
- [ ] 6. Tracker, `03_LOG_REVISIONES.md` y la fila de MKT en el roadmap de `CLAUDE.md` al día
- [ ] 7. En prod, confirmado con `/api/health`

---

## 9. Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
| 2026-11-20 | Investigación en tres frentes (canales, cumplimiento del proveedor, expediente/folio); lectura de prod en sólo lectura; maqueta de 5 pantallas validada con el usuario; el PM aprueba abrirla como continuación de MKT | dev de MKT + Claude |
