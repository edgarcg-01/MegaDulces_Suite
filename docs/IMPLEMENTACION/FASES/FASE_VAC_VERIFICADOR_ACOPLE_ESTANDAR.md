# Fase VAC — Acoplar el verificador de precios al estándar de la Suite

> **Estado: 🟢 ACEPTADA 2026-11-19 por 0Sistemas**, sin la validación visual en el mostrador, que queda ⏸️ con nombre (`[VAC.VISUAL]`); D2 firmada, D3 resuelta midiendo y H1 medido y en manos de Precios/Comercial — ver §14. *Antes:* **🔨 EN CURSO 2026-10-14.** **D1 y D4 firmadas por 0Sistemas el 2026-10-14:** tipografía única del estándar y fondo/tema del estándar (sin tema fijo claro). **Hecho:** `[VAC.U11/U12]` (commit `638ecb5c9`, local) — Sniglet/Impact fuera, colores por tokens, sin fondo propio, sin patrón ni franja, `::ng-deep` 3 → 0, hex 69 → 2, `font-size` en px 13 → 0; excepción de `DESIGN.md §O.3` retirada. **Pendiente:** todo lo demás de §5-§6 (la cifra gigante y la animación de entrada siguen declaradas como restos; validación visual NO MEDIDA). Antes: 📋 plan sin código de producto. Este documento es el plan y el registro de cambios por venir; nada de lo que dice "se hará" está hecho. Trabajo **local**: sin push, sin migraciones a prod, sin deploy (decisión del usuario, 2026-10-14).
> **Pantalla:** `/tienda/verificador` (`TiendaVerificadorComponent`) · **API:** `GET /api/kp/precio`, `GET /api/kp/precios-todos`, `GET /api/sucursales` (`apps/api/src/modules/kp/`).
> **Antecedentes:** [`FASE_CV24_VERIFICADOR_CHECKPOINT`](FASE_CV24_VERIFICADOR_CHECKPOINT.md) (CV.24–CV.28) · [`FASE_CV`](FASE_CV_CATALOGO_TIENDA_MAYOREO.md) · [`FASE_ETQ_CAMBIOS_ESTADO_AVISOS`](FASE_ETQ_CAMBIOS_ESTADO_AVISOS.md) (la etiquetera, que ya se acopló a una sola fuente).

---

## 0. En una pantalla

El verificador **funciona y es correcto en lo que muestra** (CV.28 cerró el bug del `LPAD`). Lo que no hace es **vivir bajo las reglas que el resto de la Suite ya se dio**. Se midió, por capa:

| Capa | Hallazgo | Evidencia |
|---|---|---|
| **Datos** | El precio unitario sale **vivo** de `kepler_ods.kdii` (~1-2 min) pero el mayoreo y el gramaje salen de la **tabla batch** `commercial.product_label_prices` (hasta 32 min). **Es el defecto exacto que `[ETQ-ODS.1]` cerró en la etiquetera** — que ya lee `analytics.v_label_prices`. | `kp.service.ts:306,394` · migración `20260919140000_v_label_prices.js` · `commercial-labels.service.ts:552` |
| **Datos** | El **override manual** (`source='manual'`) sólo existe en la tabla vieja. Con plaza, la etiquetera **ya no lo imprime** (su origen es "el ERP vivo por construcción") y el verificador **sigue aplicándolo** y le dice a la clienta *"es el mismo que sale en la etiqueta del anaquel"*. Hoy es **latente**: `[TDA.2]` midió **cero filas `manual` en prod** (~2026-09-09, **a re-medir**: es una cifra de hace cinco semanas). | `kp.service.ts:409,541` vs `commercial-labels.service.ts:748-750` · `verificador-procedencia.spec.ts:21-24` |
| **Datos** | La frescura por sucursal (`datos_al`) lee `analytics.cron_runs.job_key='cdc_wal_NN'`; nadie confirmó que alguien lo escriba. La pantalla ya declara "sin medir". | `sucursales.service.ts:33` · `FASE_CV` "Pendiente / abierto" |
| **Lógica** | Reglas **copiadas** de la etiquetera (`tiersDeFila`, `unidadDelCodigo`, `armarUnidades`) en vez de consumidas. Dos copias = dos verdades el día que una cambie. | `kp.service.ts:59,124,181` |
| **Lógica** | Endpoints **públicos** que devuelven `e.message` al cliente cuando fallan (puede ser texto de SQL). | `kp.service.ts:590,676` |
| **Lógica** | Respuesta **sin contrato**: `http.get<any>` y `ok:false` con HTTP 200; sin envelope de procedencia/frescura (ADR-056). | `verificador.service.ts:220` |
| **Lógica** | El módulo backend `kp` **no tiene ningún `.spec.ts` propio** y la clase `KpService` no se ejecuta en ninguna prueba de unidad. La cobertura es **indirecta**: `verificador-procedencia.spec.ts` (33 bloques que **leen el código fuente como texto**) y el smoke de datos `test-newdb-verificador-precio-correcto.js` `[CV.26]`, que compara la tabla/ODS contra `computeLabels` del importer (no llama al servicio). El bug de CV.28 se cazó en uso real. | `ls apps/api/src/modules/kp` · `verificador-procedencia.spec.ts:29-33` |
| **Interfaz** | 1,228 líneas en un solo componente · **69 hex crudos (36 distintos)** · 13 `font-size` en px · 3 `::ng-deep` · 0 `@layer` · 1 `@media` · **0** `forced-colors`/`prefers-color-scheme` · tema fijo claro · 3.ª tipografía (Sniglet). | medido 2026-10-14, ver §9 |
| **Interfaz** | Botones de 32 px (piso táctil: 44) · `confirm()` nativo · `v1.0` escrito a mano en el pie · `onerror` y `style=` inline en el `<img>` · `money()` propio habiendo `shared/util/money.util.ts`. | `tienda-verificador.component.ts:116,135,309,999,1197` |
| **Interfaz** | La ayuda contextual (regla P) no cubre mayoreo, "acaba de cambiar", código ambiguo ni "el precio varía entre plazas" — los términos que TDA.4–TDA.9 agregaron. | `context-help.dictionary.ts:1115-1140` |

**Lo que se pide y lo que choca.** "Acoplar al estándar" **choca con una excepción firmada**: `DESIGN.md §O.3` (decisión 0Sistemas, 2026-09-12) dice que esta pantalla **no** sigue los tokens de Operations (Sniglet, paleta cruda, fondo de dulces, tema fijo claro). El checklist pre-vuelo manda *exponer el conflicto y que decida Edgar*, no resolverlo en silencio. Por eso §1 abre con las decisiones, y **la piel (D1) es una puerta**: ninguna otra capa depende de ella.

---

## 1. Decisiones que hay que firmar antes de tocar la interfaz

| # | Decisión | Opciones | Recomendación |
|---|---|---|---|
| **D1** ✅ | **La piel.** ¿Qué queda de la excepción §O.3? **FIRMADA 2026-10-14 (0Sistemas): piel del estándar, sin excepción** (más allá que la opción B recomendada). | **A)** Operations pleno (Hanken/Geist, zinc, sin patrón): pierde la identidad que 0Sistemas pidió. **B)** *Dos zonas*: la **tarjeta de la clienta** (precio, nombre, mayoreo) conserva su identidad pero **tokenizada**; la **zona del operador** (franja de control, banners, respaldo, pie, botón de faltante) pasa a Operations puro. **C)** Reclasificar como superficie "escaparate" (tercer régimen, fuera de Storefront y Operations). | **B.** La pantalla tiene dos públicos con necesidades distintas: la clienta lee de lejos y no opera; el operador sí opera y es quien lleva la deuda de diseño. B cierra la deuda donde duele sin reabrir la decisión de identidad. |
| **D2** ✅ | **El override manual.** **FIRMADA 2026-11-19 (0Sistemas): (a), se retira** — del verificador y del checador de la app del vendedor, que lee el mismo endpoint (`[VAC.D3]`, §14). | **(a)** Retirarlo del verificador: una sola verdad = ERP vivo, igual que la etiquetera. **(b)** Devolverlo a la etiquetera para que ambas coincidan. | **(a)**, **condicionado a re-medir**: `[TDA.2]` registró **0 filas manuales en prod**, o sea que hoy es código muerto con una nota que puede mentir. Si el recuento sigue en 0 el cambio es limpieza; si alguien empezó a usarlo, es una decisión de negocio de quién fija el precio. |
| **D3** ✅ | **Fuente de la frescura por sucursal.** **RESUELTA 2026-11-19 midiendo:** `analytics.ods_branch_checks` del carril `ods_live_hot`; `cdc_wal_NN` tenía 0 filas (`[VAC.D4]`, §14). | `cdc_wal_NN` (hoy) · `ods_live_hot`/`ods_live_mirror` (latido OBS.1) · `_synced_at` de `kdii` de esa plaza. | **No se elige a ojo** (regla #0). Se mide contra prod; si ninguna alcanza, la pantalla sigue diciendo "sin medir". |
| **D4** ✅ | **Tema fijo claro.** **FIRMADA 2026-10-14: se retira; la pantalla sigue el tema.** | Conservarlo (monitor físico de mostrador, no cambia con el modo oscuro de quien lo configuró) o seguir el tema. | **Conservarlo y declararlo** como excepción vigente, pero implementado con `color-scheme: light` + tokens, no con hex. |
| **D5** | **Primitiva de cámara.** | Extraer `camera-scanner` compartida o dejarlo como está. | **Extraer.** El propio comentario del componente (l.1077) fija el umbral en "un cuarto consumidor": hoy hay **cuatro** (`scan-field`, `product-scan-field`, `comercial-inventory-count`, el verificador). ADR-056: un primitivo repetido vive en `libs/` o `shared/`. |

> ⛔ **Fuera de alcance por regla del repo:** CORS y credenciales (`[A.0bis.1-3]` bloqueados). Si el análisis de la superficie pública pide tocarlos, se **declara** y se escala; no entra a esta fase.

---

## 2. El estándar aplicable (qué manda y dónde)

| Regla | Fuente | Aplica al verificador como |
|---|---|---|
| Surface y sector | `DESIGN.md` pre-vuelo 1 · §Surfaces · **§O.3 Mostrador/POS** | Operations, sector Mostrador: foco permanente, el precio domina, **sin paginación** en el feed (aquí no hay feed por privacidad, CV.27). |
| Cero hex crudo · dark siempre | pre-vuelo 2 y 12b | Tokens. La excepción de tema fijo (D4) se **declara**, no se hereda. |
| PrimeNG-first / plataforma antes que JS | pre-vuelo 3 · §T | `confirm()` → diálogo; overlay de cámara → `<dialog>` nativo (focus trap gratis). |
| Tipografía por rol · `tabular-nums` | pre-vuelo 4 | Cifras en Geist Mono en la zona del operador; el precio gigante es la excepción de D1. |
| Matriz de estados completa | pre-vuelo 6 · Ing. UI §2 | `loading` hoy es un spinner suelto; falta skeleton de la tarjeta y la fila de `overflow` (nombres largos, 10×). |
| Teclado / buscador | pre-vuelo 7c · D.7 | El campo de captura ya es el primitivo correcto (foco permanente). No se rediseña. |
| Responsividad por capas | pre-vuelo 9 · §R | `@container` en la tarjeta (se embebe en kiosco, ventana y celular), `clamp()` sólo con tope 2.5×, breakpoints en `rem`. |
| Dominio | pre-vuelo 10 | Moneda/fecha por el helper compartido (`money.util.ts`), no por `toLocaleString` propio. |
| a11y AA · targets ≥ 44 px | pre-vuelo 11 | Botones de 32 px suben a 44 en `pointer: coarse`. |
| Alto Contraste · papel | pre-vuelo 12c · `libs/ui-web/src/forced-colors.css` | La base ya existe; falta que **ningún estado dependa sólo del color** (tags ok/warn, banner). |
| Interacción resiliente | pre-vuelo 13 | `confirm()` bloqueante fuera; el contador se reinicia con confirmación propia. |
| Ayuda contextual (regla P) | §P | Entradas nuevas en el diccionario versionado, no texto suelto. |
| Procedencia y frescura | ADR-056 · `libs/contracts/http/provenance.contract.ts` | Envelope en `/kp/precio`; lo no medido se declara. |
| Fuente única | **REGLA PRINCIPAL** (cero importers) · `VERDAD_ABSOLUTA.md` | Una vista derivada del ODS; nada de tabla batch intermedia. |

---

## 3. Capa de DATOS

**Objetivo:** que el precio, el mayoreo, la unidad y el gramaje del mostrador salgan **de la misma fuente y con la misma frescura** que la etiqueta del anaquel.

### VAC.D1 — Pasar a `analytics.v_label_prices` (fuente única)
- Reemplazar las lecturas a `commercial.product_label_prices` / `v_product_label_prices` (`kp.service.ts:306,394`) por `analytics.v_label_prices` con plaza.
- ⚠️ La vista fue creada con `CREATE OR REPLACE`: **re-aplicar `security_invoker` y el `GRANT`** si se toca (ADR-057). No se modifica en esta fase; sólo se consume.
- `SET LOCAL app.tenant_id` se conserva **sólo** si la vista lo necesita (la vista ya fue verificada para el rol de runtime en la etiquetera: copiar su patrón, no reinventarlo).

### VAC.D2 — Los códigos como vista, no como `OR` de ocho columnas
- Hoy `getPrecio` busca con `OR` sobre `c1` (con `LPAD`), `c7`, `c82`, `c93`, `c95`, `c96`, `c85` y `TRIM()` en cada una. Esos `TRIM()` pueden anular el índice (el mismo patrón que GOTCHAS 28 documenta para `kdpv_prod_util`).
- Propuesta: **vista derivada** `analytics.v_codigos_venta` (sku, plaza, código, slot, unidad) — *derive-no-copy*, sin importer — que normaliza las casillas con su unidad (el decode de TDA.3 ya vive en `barcode-compute.js`).
- **Se decide con medición, no con intuición:** `EXPLAIN (ANALYZE, BUFFERS)` de la consulta actual contra prod (**NO MEDIDO**). Si el plan ya es aceptable, la vista se queda en "ordenar el código" y **no** se agrega índice.
- Si hiciera falta un índice sobre `kdii`, se crea `CONCURRENTLY`, **fuera de horario**, con la precedencia de `ix_kdm1_*` (migración aparte, nunca mezclada con la de la vista).

### VAC.D3 — Override manual (decisión D2)
- Re-medir en prod: `SELECT count(*) FROM commercial.product_label_prices WHERE source='manual'` (**NO MEDIDO hoy**; la última cifra, 0, es de `[TDA.2]`, ~2026-09-09).
- Según D2: (a) se retira la rama `origen_precio='override_manual'` y el texto de la nota; (b) se abre un item aparte para que la etiquetera lo respete. Cualquiera de las dos obliga a actualizar los candados de `verificador-procedencia.spec.ts` que hoy **exigen** que el override exista (leen el código como texto).

### VAC.D4 — Frescura por sucursal (decisión D3)
- Medir qué `job_key` existe y late en prod (`SELECT job_key, last_finish FROM analytics.cron_runs WHERE job_key LIKE 'cdc_wal_%' OR job_key LIKE 'ods_live_%'`) y si `kdii` trae marca propia.
- Resultado esperado: o bien una fuente verificada que alimente `datos_al`, o bien la decisión explícita de mantener "sin medir". **No se escribe un latido nuevo** para que la pantalla tenga qué mostrar.

### VAC.D5 — Snapshot offline
- `getPreciosTodos` pasa a leer la misma vista por plaza. Lleva el `as_of` de la fuente y la versión del contrato (`v`) para que un respaldo viejo se degrade declarando "formato anterior", no en silencio.
- Medir tamaño y tiempo de la descarga antes/después (hoy ~1.8 MB / 1.13 s, medido en `ops/prod/README.md §3.4` sobre 9,532 productos).

### VAC.D6 — Candado de paridad: **reapuntar el que ya existe**, no escribir otro
- Ya existe `database/tests/test-newdb-verificador-precio-correcto.js` `[CV.26]`: compara lo que el verificador publica (precio, mayoreo, códigos) contra **`computeLabels`/`computeBarcodes` del importer** y distingue tres veredictos (`⬜ LÍNEA BASE` / `✔` / `✘`). Su esperado es **la copia vieja de la regla** (el importer que se está retirando).
- Cambio: que su esperado pase a ser **`analytics.v_label_prices`** (la fuente canónica) y que compare **lo que contesta el servicio**, no sólo la tabla. Debe dar **0 diferencias por (sku, plaza)** o enumerarlas con su causa. Se conserva su disciplina de **importar la regla en vez de re-derivarla** (el primer intento reportó 675 "divergencias" falsas por re-escribirla).
- **Prueba negativa obligatoria:** forzar un precio distinto en una fila de prueba y verificar que el candado **sale rojo**.
- Requiere acceso de lectura a prod: **hoy no disponible desde esta máquina** (SSH a `md` denegado, sin credencial `dev_ro`). Hasta entonces se corre contra el stack Docker local **declarando NO MEDIDO contra prod**.

---

## 4. Capa de LÓGICA

### Backend (`apps/api/src/modules/kp/`)

| # | Cambio | Por qué |
|---|---|---|
| **VAC.L1** | **Contrato tipado** en `libs/contracts` (`VerificadorPrecioResponse`, `VerificadorSnapshot`, `SucursalVerificador`): el backend los emite, el frontend los consume. | Hoy `UnidadPrecio` y el tier existen **dos veces** (backend y `verificador.service.ts`) y la respuesta se lee como `any` (también lo frena `lint-boundary-gate`). |
| **VAC.L2** | **Resolver único.** `tiersDeFila`, `unidadDelCodigo`, `armarUnidades` pasan a leer lo que ya resuelve `v_label_prices` (peldaño, unidades, barcode, gramaje) o a una función compartida de `libs/`. | Dos copias de la regla = el defecto que TDA.3 y TDA.4 ya describieron. ADR-056: el primitivo vive en `libs/`. |
| **VAC.L3** | **Errores sin fuga.** `catch` devuelve un código estable (`error_interno`) y registra el detalle con `Logger`; nunca `e.message`. El no-encontrado deja de ser `200 {ok:false}` **sólo si** se acuerda con el frontend (cambio de contrato: ver riesgos). | Endpoints `@Public()`: un mensaje de Postgres hacia un kiosco anónimo es información interna. |
| **VAC.L4** | **Envelope de procedencia** (`as_of`, `status: fresh\|stale\|unknown`, fuente) usando `provenance.contract.ts`. | ADR-056: el número declara con qué se calculó. Hoy `/kp/precio` no lo dice; el snapshot sólo trae `generado`. |
| **VAC.L5** | **Unidad dudosa se DECLARA.** Marcar `unidad_dudosa` cuando el precio de la plaza contradice su propio `c84`, o el SKU es `is_master_suspect` (pallet/granel). **No se sustituye el factor** (VA.7 lo refutó con 20 a 1). | `FASE_CV` §Pendiente: 3,570 filas y 102 SKUs hoy se publican sin aviso. |
| **VAC.L6** | **Validación de entrada.** `q` y `sucursal` con DTO/Zod en vez de saneo manual; longitud máxima del código. | Frontera pública: se valida donde entra el dato. |
| **VAC.L7** | **Specs de comportamiento del módulo** (`kp.service.spec.ts`, instanciando `KpService` con un Knex simulado): regresión del `LPAD` (CV.28: `7506306248861` no debe resolver a `75063`), `unidadDelCodigo`, código ambiguo (TDA.9), tiers (las 4 guardas), plaza sin dato. **Y migrar los candados que leen el código como texto** (`verificador-procedencia.spec.ts`, 33 bloques): se ponen rojos al mover código, por diseño; cada uno se traslada a una aserción de comportamiento o se retira con su razón. | Hoy el comportamiento no se ejecuta en ninguna prueba de unidad. Cada spec con **prueba negativa** (romper la guarda y ver rojo). |
| **VAC.L8** | **Throttle y tamaño** de `precios-todos` (1.8 MB) revisados contra el tier vigente; **sin tocar CORS ni credenciales**. | Sólo se verifica y se declara; el cambio, si hace falta, es decisión aparte. |

### Frontend (`verificador.service.ts`)

| # | Cambio |
|---|---|
| **VAC.L9** | `buscar()` tipado con el contrato de VAC.L1 (fuera `http.get<any>`); `mapear()` puro y testeable. |
| **VAC.L10** | Decisión explícita de **cuándo cae al respaldo**: hoy cae por timeout (2.5 s) **y** por error de red; un `5xx` del servidor se trata como "sin conexión". Separar "el servidor falló" de "no hay red" (pre-vuelo 6: error ≠ empty). |
| **VAC.L11** | El snapshot declara su **versión de formato**; uno anterior al contrato nuevo se muestra como "respaldo de formato anterior", no se interpreta con campos ausentes. |
| **VAC.L12** | Reemplazar `money()`/`moneySinSigno()` por `shared/util/money.util.ts`. |

---

## 5. Capa de INTERFAZ

> Todo lo de esta sección que toque la **piel** espera la firma de **D1**. Lo que no es piel (estructura, estados, a11y, teclado) puede ir ya.

### 5.1 Estructura (no depende de D1)
- **VAC.U1 — Descomponer el componente de 1,228 líneas** en piezas de `apps/view/src/app/modules/tienda/components/`: `verificador-tarjeta` (resultado), `verificador-mayoreo`, `verificador-franja` (control del operador), `camera-scanner` (D5), `kiosco-shell`. El componente de página queda con el estado y la orquestación.
- **VAC.U2 — Cámara como primitiva compartida** (D5): migrar los **cuatro** consumidores. Es un cambio con riesgo de regresión sobre el Andén y el conteo comercial: se hace **al final** y con sus specs existentes en verde.
- **VAC.U3 — Overlay de cámara con `<dialog>` nativo** (`showModal()`, `closedby`): focus trap y retorno de foco sin JS propio (§T). `Escape` y el `@HostListener` global de kiosco se reducen a un solo manejador.
- **VAC.U4 — Sin plomería inline:** quitar el `onerror`/`style=` del `<img>` (fallback con estado de Angular), `confirm()` → diálogo de PrimeNG (poka-yoke, no bloquea el hilo).
- **VAC.U5 — Pie:** `v1.0` escrito a mano → versión de build real (el `/api/health` ya devuelve `commit`) o fuera.

### 5.2 Estados y a11y (no depende de D1)
- **VAC.U6 — Matriz de estados completa:** `loading` con skeleton **dimensionado** de la tarjeta (CLS 0, no sólo spinner junto al input) · `overflow` con nombre de 10× de largo y mayoreo de 4 escalones · `empty` (idle) se queda **vacío a propósito** (O.3) y se declara · `error` ya cubre `no_encontrado` ≠ `sin_datos` ✓ (se conserva).
- **VAC.U7 — Targets ≥ 44 px** en `pointer: coarse` (`.vf-icon-btn` 32, `.vf-counter-reset` ~16).
- **VAC.U8 — Anillo de foco en todos los controles** (`.vf-icon-btn`, `.vf-counter-reset`, `.vf-scanbar` con contraste 3:1 sobre naranja — **verificar**, el anillo actual es `--vf-oscuro`).
- **VAC.U9 — Alto Contraste y color-no-único:** los `tag`/banner `ok`/`warn` ya llevan icono + texto ✓; comprobar bajo `forced-colors: active`. Sin `box-shadow` como único indicador.
- **VAC.U10 — Responsividad por capas:** `@container` en la tarjeta (hoy sólo `clamp()` + 1 `@media`); breakpoints en `rem`.

### 5.3 Piel (espera D1; la recomendación es B)
- **VAC.U11 — Tokenizar:** los 36 hex distintos se mapean a roles **de `tokens.css`** (leer sus nombres reales antes de mapear; este plan no los asume): naranja → el rol de acción/marca, verde/rojo → los semánticos ok/bad, grises → neutrales zinc. Los que **no** tengan rol (amarillo del mayoreo, rosa/azul del patrón de dulces) se **agregan a `tokens.css`** como roles con nombre, nunca como literal.
- **VAC.U12 — Zona del operador a Operations puro** (franja, banners, pie, botones de respaldo): Hanken Grotesk + Geist Mono, `p-tag`/`p-button` por `severity`, 13 `font-size` a `--fs-*`.
- **VAC.U12.1 ✅ (2026-10-14, a pedido de 0Sistemas) — seguimientos de la piel:** (a) **centavos y punto más chicos** en TODO precio (principal, mayoreo, otras unidades, "Antes decía") con `partesPrecio()`: el entero manda y el cliente no confunde `85.49` con `8549`; (b) **ancho fluido**: la tarjeta ocupa el ancho disponible (tope 1600 px) y se reacomoda por el ancho del **contenedor** (`@container vf`), no de la ventana: apilada en angosto, **dos columnas** (precio | mayoreo) desde 56 rem; (c) **kiosco sin información interna**: fuera el botón de cámara, el renglón código + "Precio en línea/respaldo" y el aviso "acaba de cambiar" (no sirven al cliente y quitan espacio); (d) **mayoreo como protagonista**: caja enmarcada con `--action`, título "Precio por mayoreo", condición y precio grandes, ahorro en pastilla. ⚠️ **Se declara:** en kiosco un cambio de precio reciente ya no se avisa (ADR-056); el respaldo SÍ sigue declarado por el banner superior. Siguen visibles en kiosco la franja de frescura/sucursal, la nota de IVA y el contador del pie (no se pidió quitarlos). Verificado con render estático de las plantillas, claro/oscuro, 1920 px y 420 px — **no es la app corriendo**: falta validar en el monitor real de mostrador (lector, cámara, pantalla completa y datos reales).
- **VAC.H2–H4 ✅ (2026-10-14) — auditoría de diseño del verificador, aplicada por partes.** Decisión de 0Sistemas: **el mayoreo conserva la prioridad** (la auditoría proponía una sola cifra héroe con el mayoreo en segundo nivel; no se adoptó). **H2:** la pastilla del ahorro publica el ahorro **por unidad** como cifra principal («Ahorras $5.59 por unidad (6.5% menos)») y el total del mínimo de apoyo; `ahorro_por_unidad` ya viajaba por el contrato y el codec offline y no se pintaba. **H3:** cada umbral es su bloque (separado por una línea) y el de paquete dice «Equivale a 144 piezas»; la equivalencia la calcula el servidor una vez (`equivale_a`, campo aditivo y opcional del contrato; clave `eq` en el snapshot compacto; un respaldo viejo se lee sin ella, no se inventa). El orden sigue la regla de 0Sistemas (manda la unidad escaneada), no la de «el más accesible primero» de la auditoría; coinciden cuando se escanea la pieza. **H4:** el rótulo de unidad de la cifra grande sube de `--fs-h3` atenuado a `--fs-h1` en `--text-main` (legible a 1–2 m), y el «c/u»/«por paquete» del mayoreo gana tamaño y contraste. - **VAC.4a (bloque pequeño) ✅ (2026-10-14):** **U4** logo con estado de Angular (`(error)` + signal `logoFalla`, fuera `onerror`/`style=`) y `confirm()` nativo → `ConfirmationService` (el diálogo global de la app, no bloquea el hilo); **U5** fuera el `v1.0` escrito a mano; **U6** esqueleto dimensionado (`vista()` = `buscando` sólo si no hay tarjeta vigente, así no parpadea entre escaneos; entra con retardo de 200 ms, sin animación en bucle) y `overflow-wrap` en el nombre; **U7** controles a 44 px con `pointer: coarse`; **U8** verificado, no cambió: el anillo de foco ya es `--focus-ring` y mide 3.25:1 (claro) / 5.6:1 (oscuro) sobre el fondo; **U9** bloque `forced-colors` (bordes de sistema en lo que se distinguía sólo por relleno). Candados nuevos probados por mutación (se ponen rojos). `check:pantalla`: las mismas 2 fallas que `main` (Q.1 y §2 LoadState) y una advertencia menos (#9). ⚠️ **Declarado, no resuelto:** el texto blanco sobre `--action` (botón de cámara) mide 3.39:1 — pasa como texto grande, pero es un tema del token en toda la Suite, no de esta pantalla; los `p-button-sm` de PrimeNG (respaldo) no llegan a 44 px porque son de la librería. - **VAC.L3 + L7 ✅ (2026-10-14) — el servicio deja de filtrar y de mentir, y por fin se ejecuta en pruebas.** **L3:** el `catch` de `getPrecio` y `getPreciosTodos` devolvía `200 { ok:false, error: e.message }`. Eran **dos defectos, no uno**: (1) fuga del mensaje de Postgres hacia un endpoint `@Public()`; (2) **el frontend lo leía como «el catálogo contestó que no está» y pintaba PRODUCTO NO ENCONTRADO sin consultar el respaldo local**, que sí tenía el precio (y en `precios-todos` el kiosco lo leía como «el catálogo llegó vacío»). Ahora lanza `503 { ok:false, codigo_error:'error_interno' }` y el detalle va sólo al log del servidor; el 5xx lo trata el frontend como «el servidor falló» y cae al respaldo (nueva prueba en `verificador.service.spec`). «No encontrado» sigue siendo `200 { ok:false }`: ésa sí es una respuesta. **L7:** `kp.service.spec.ts`, 28 pruebas de comportamiento con un doble de Knex: errores sin fuga, unidad del código escaneado, código ambiguo, precio ambiguo entre plazas, plaza sin dato, las guardas del mayoreo, override manual, fórmula de respaldo y forma del snapshot. **Probado por mutación:** revertir L3, romper la guarda «desde 1», romper «más barato que el unitario» y quitar la guarda de longitud del `LPAD` ponen rojo su prueba cada uno. ⚠️ **Límite declarado:** el doble NO ejecuta el SQL; la regresión del `LPAD` (CV.28) sólo se vigila aquí como texto del SQL enviado, y su correctitud real sigue siendo del smoke contra la base (`[CV.26]`). ⚠️ **Falta de L7:** trasladar a comportamiento (o retirar con su razón) los 33 candados que leen el código como texto en `verificador-procedencia.spec.ts`; no se tocó. Sin cambio de CORS ni credenciales. **Pendiente:** el frontend aún no muestra un mensaje distinto cuando cae al respaldo por un 5xx frente a un corte de red (L10).
- **VAC.L6 + L1 + L9 ✅ (2026-10-14).** **L6 (validación en la frontera):** `VerificadorPrecioQuery` y `VerificadorPreciosTodosQuery` (Zod, en `libs/contracts`) con el `ZodValidationPipe` que ya usa el resto de la API: `q` hasta 64 caracteres (antes sin tope) y `sucursal` de dos dígitos o ausente (`''` cuenta como ausente). **Cambio de comportamiento declarado:** una plaza mal formada era *ignorada en silencio* (la respuesta caía en la plaza determinista y el error de quien llama no se veía); ahora es un **400**. El frontend ya sólo manda plazas de dos dígitos y el campo del kiosco lleva `maxlength=64`. Probado por mutación (sin tope, sin regex y sin pipe ponen rojo su candado; `kp.controller.spec.ts`, 10 pruebas). **L1 (contrato tipado):** `VerificadorPrecioResponse` (unión `ok:true | ok:false`), `VerificadorSnapshot`/`Item`, `UnidadPrecioVerificador`, `CandidatoVerificador` y `SucursalVerificador` viven una sola vez en `store.contract.ts`; el backend los **emite** (firmas `Promise<…>` en servicio y controlador) y el frontend los **consume** (`UnidadPrecio`, `SnapshotItem/Payload` y `SucursalVerificador` pasan a ser alias del contrato). **L9:** `buscar()` y `descargarSnapshot()` sin `get<any>`. ⚠️ **Sin verificar:** los tipos del backend (no se compila en local; lo comprueba `Build & typecheck` del CI). El chequeo de tipos de la pantalla (`check:pantalla`) da 0 errores semánticos. ⚠️ **No hecho de L9:** extraer `mapear()` como función pura; **L12** (`money()` → `money.util`) tampoco. **L5** (declarar unidades dudosas) sigue pendiente: necesita medir contra prod qué filas contradicen su propio `c84`.
- **VAC.U15 + L10 + L11 ✅ (2026-10-14).** **U15:** el tema `verificador` del diccionario gana tres grupos —*Mayoreo y ahorro*, *Avisos que hay que leer antes de cobrar* (precio cambiado, código en N productos, precios distintos entre plazas, plaza sin dato, unidad escaneada) y *Modo kiosco y cámara*— con definiciones ancladas al comportamiento real; spec del diccionario nuevo. **L10 (la causa de la caída al respaldo):** el servicio clasifica el fallo (`clasificarFallo`: `sin_red` / `lento` / `servidor` / `peticion`) y lo viaja en el resultado (`motivoRespaldo`); la pantalla lo dice en los tres lugares donde habla del respaldo (precio, «no encontrado» y «sin datos») con una sola tabla (`causaRespaldo`). Hasta hoy **todo se llamaba «Sin conexión»**, incluso cuando la red estaba bien y quien fallaba era el servidor, y mandaba a revisar un cable que no tenía nada. `sin_red` reproduce exacto el texto anterior (no hay cambio para quien de verdad no tiene red). **L11 (formato del snapshot):** `/kp/precios-todos` declara `v` (`VERIFICADOR_SNAPSHOT_FORMATO = 2`, en el contrato); un respaldo sin `v` o con una versión menor se **declara** («formato anterior» en el pie) y **se re-descarga en cuanto hay red**, sin esperar las 12 h del TTL (le faltan campos que la pantalla ya sabe mostrar: unidad escaneada, mayoreo). Probado por mutación (5xx como sin_red, respaldo de formato anterior esperando el TTL, `esFormatoAnterior` siempre falso y banner con texto fijo ponen rojo su prueba; +15 pruebas en el frontend y 1 en el backend). ⚠️ **Sin verificar:** los tipos del backend (`kp.service.ts`) —los comprueba el CI—; el chequeo de tipos de la pantalla da 0 errores. ⚠️ **Subir `VERIFICADOR_SNAPSHOT_FORMATO` al cambiar la FORMA del snapshot, no en cada release.** Pendiente de la fase: L2/L4/L5/L8, U1/U2/U3/U14, el frente de datos (VAC.1) y D2/D3/D5.
⛔ **H1 — MEDIDO el 2026-11-19 (§14): 166 SKUs (114 con la presentación ≥ 2 % más cara, 80 ≥ 5 %, 12 ≥ 10 %; mediana 4.6 %); la decisión sigue abierta para Edgar con Precios/Comercial.** Texto original: la escalera de precios no es monótona (a partir de 3 piezas, comprar suelto a mayoreo sale más barato que el paquete o la caja); decide Precios/Comercial, y antes conviene **medir** cuántos SKUs la tienen rota con una consulta de sólo lectura contra prod (no medido). Los precios del ejemplo salen del mockup: verificar contra el SKU real antes de llevarlo a Precios.
- **VAC.U13 — Tarjeta de la clienta:** conserva Sniglet/Impact/patrón **declarados como excepción vigente**, pero sobre tokens y con `color-scheme: light` (D4). Se retiran los 3 `::ng-deep` con `styleClass` + token de PrimeNG.
- **VAC.U14 — Cascada en capas:** el CSS nuevo entra en su `@layer` (`!important` sigue en 0 ✓).
- **VAC.U15 — Ayuda contextual:** ampliar `verificador` en `context-help.dictionary.ts` con *mayoreo*, *"acaba de cambiar"*, *código en más de un producto*, *precio distinto entre plazas*, *unidad escaneada*, *modo kiosco/cámara*. Textos del diccionario versionado, no del template.

---

## 6. Plan por sprints (orden y dependencias)

```
VAC.0  Línea base + decisiones ─┬─► VAC.1 Datos ─► VAC.2 Lógica backend ─► VAC.3 Lógica frontend ─┐
(mide, firma D1-D5)             │                                                                    ├─► VAC.5 Cierre y documentación
                                └─► VAC.4a Interfaz: estructura+estados+a11y (independiente) ─► VAC.4b Piel (espera D1)
```

| Sprint | Contenido | Criterio de aceptación | Se puede hacer ya |
|---|---|---|---|
| **VAC.0** | Medir (§9), firmar D1-D5. | Cada cifra con su comando y fecha; D1-D5 con respuesta escrita. | ✅ (menos lo que pide prod) |
| **VAC.1** | VAC.D1-D6. | Candado de paridad escrito **con prueba negativa**; contra prod = `NO MEDIDO` hasta tener acceso. | ✅ escribir · ⛔ medir en prod |
| **VAC.2** | VAC.L1-L8. | Specs del módulo verdes y mutadas a rojo; sin `e.message` hacia el cliente; contrato en `libs/contracts` consumido por los dos lados. | ✅ |
| **VAC.3** | VAC.L9-L12. | `verificador.service.spec` + `verificador-procedencia.spec` (519 líneas hoy) siguen verdes; cero `any` nuevo en `lint-boundary-gate`. | ✅ |
| **VAC.4a** | VAC.U1, U3-U10 (U2 al final). | `check:templates` · `check:estilos` · `check:motion` · `check:tokens` · `check:teclado` verdes; cobertura de estados con spec. | ✅ |
| **VAC.4b** | VAC.U11-U15. | Hex crudo del componente: **69 → 0** (salvo el patrón SVG declarado); `font-size` literal: 13 → 0; `::ng-deep`: 3 → 0. | ⏳ espera D1 |
| **VAC.5** | §8 (documentación). | Las 6 superficies documentales de §8 actualizadas; la fila de excepción de `DESIGN.md §O.3` reescrita con lo que **queda** de ella. | tras todo |

**Por qué este orden.** Datos antes que lógica antes que interfaz: si la fuente cambia (VAC.D1), `tiersDeFila` deja de tener sentido y el contrato se redefine; hacer la interfaz primero obligaría a rehacerla. La estructura y los estados de la interfaz **no** dependen de la fuente ni de D1, por eso corren en paralelo.

---

## 7. Qué NO se hace, y por qué

- **No se sustituye el factor de caja `c84`** por `v_product_box_factor`: refutado con medición (VA.7, 2026-09-12). Se **declara** (VAC.L5), no se reemplaza.
- **No se agrega importer ni tabla.** Todo es vista derivada o lectura de lo que ya hay (REGLA PRINCIPAL). La tabla `product_label_prices` **no se borra** en esta fase: queda hasta que el candado de paridad explique cada diferencia (la misma cautela de `[ETQ-ODS.1]`).
- **No se toca CORS ni credenciales** (`[A.0bis.1-3]`).
- **No se agrega el feed de "últimas consultas"** (CV.27: privacidad en mostrador público).
- **No se inventa un latido** para que `datos_al` tenga algo que mostrar.
- **No se publica la cifra de prod que no se midió.** Todo lo que pide prod aparece como `NO MEDIDO`.

---

## 8. Registro de documentación (lo que cambia con la fase)

| Superficie | Cambio | Cuándo |
|---|---|---|
| [`DESIGN.md`](../../../DESIGN.md) §O.3 | Reescribir la **excepción de 2026-09-12** con lo que sigue valiendo (tarjeta de la clienta, tema fijo) y lo que se retira (zona del operador). Actualizar la fila de Surfaces y la tabla de tipografías (Sniglet). | VAC.5, tras D1 |
| [`DESIGN.md`](../../../DESIGN.md) *Estado de cumplimiento* | Re-medir y fechar las cifras de §9 con su comando. | VAC.5 |
| `context-help.dictionary.ts` | Entradas de VAC.U15. | VAC.4b |
| [`FASE_CV24_VERIFICADOR_CHECKPOINT`](FASE_CV24_VERIFICADOR_CHECKPOINT.md) | Sección nueva "§10 — Acople al estándar (VAC)" con enlace a este documento; cerrar los "Pendiente" que se resuelvan. | VAC.5 |
| [`FASE_CV`](FASE_CV_CATALOGO_TIENDA_MAYOREO.md) | Mover a "resuelto" la frescura (si D3 lo permite) y el `sku OR barcode`. | VAC.5 |
| `01_TRACKER_PROGRESO.md` · `03_LOG_REVISIONES.md` · `CHANGELOG.md` | Una entrada `[VAC.n]` por sprint cerrado. | cada sprint |
| `docs/ERP_KEPLER.md` · `VERDAD_ABSOLUTA.md` | Sólo si VAC.D2/D4 producen un hallazgo nuevo (override manual, frescura). | si aplica |
| `libs/contracts/src/authz/permission-meta.ts` | **Sin cambio**: `STORE_PRICE_CHECK_VER` ya describe la pantalla; no hay permiso nuevo. | — |

**Convención de commits:** `feat([VAC.n]): …`, un commit por sprint, **medición antes/después en el mensaje** cuando cambie un número. Optimizar y cambiar alcance de negocio van en commits **separados**.

---

## 9. Mediciones (para que cualquiera pueda contradecirlas)

Medido el **2026-10-14** sobre `origin/main` (`c34ea0892`):

```bash
F=apps/view/src/app/modules/tienda/pages/tienda-verificador.component.ts
wc -l $F apps/view/src/app/modules/tienda/verificador.service.ts apps/api/src/modules/kp/kp.service.ts   # 1228 / 474 / 683
grep -oiE '#[0-9a-f]{3,8}\b' $F | wc -l                                                                  # 69 hex (36 distintos)
grep -oE 'font-size: *[0-9.]+px' $F | wc -l                                                              # 13
grep -c '::ng-deep' $F ; grep -c '!important' $F ; grep -c '@media' $F                                   # 3 · 0 · 1
grep -c 'prefers-color-scheme\|forced-colors' $F                                                         # 0
grep -rl "BrowserMultiFormatReader" apps/view/src --include=*.ts | grep -v spec                          # 4 consumidores
ls apps/api/src/modules/kp | grep -c spec                                                                # 0 specs propios del módulo
grep -rln "KpService\|kp.service" apps libs --include=*.spec.ts                                          # 2: ambos del frontend (leen/citan el backend)
```

**Por medir cuando haya acceso de lectura a prod** (hoy: SSH a `md` denegado y sin credencial `dev_ro` en esta máquina — ver `ops/prod/README.md §2.2`):

| Qué | Para qué decisión |
|---|---|
| Filas con `source='manual'` en `commercial.product_label_prices` (última cifra: 0, `[TDA.2]`, ~2026-09-09) | D2 |
| `job_key` que existe y late (`cdc_wal_%`, `ods_live_%`) y si `kdii` trae marca propia | D3 |
| `EXPLAIN (ANALYZE, BUFFERS)` de `getPrecio` y de `getPreciosTodos` por plaza | VAC.D2, D5 |
| Paridad verificador ↔ `v_label_prices` sobre los ~78,531 pares (sku, plaza) | VAC.D6 |
| Tamaño y tiempo del snapshot antes/después | VAC.D5 |

---

## 10. Cómo se verifica, trabajando local

**Permitido** (reglas del repo): `git worktree` aislado; specs de unidad (`vitest`/`jest` del proyecto tocado); `npm run check:templates · check:estilos · check:motion · check:tokens · check:teclado · check:busqueda`; pruebas DB-directas contra el stack Docker de desarrollo (`npm run dev:up`), **no** contra prod.

**Prohibido** durante la sesión (CLAUDE.md, 2026-10-02): `nx serve api|view`, `node dist/apps/api/main.js` y `nx build` "para verificar". Que compile lo decide **el CI** al empujar — y empujar necesita autorización explícita. Consecuencia declarada: **la validación visual de la interfaz y la corrida contra datos reales de prod quedan `NO MEDIDAS` hasta que haya un entorno que las permita**; este plan no las da por hechas.

⚠️ Trampas ya vividas en este archivo, para no repetirlas: un **acento grave** dentro de un comentario del `template:`/`styles:` cierra el literal (`check:templates` lo caza) · un `--warn-*` con la barra pegada cierra un comentario CSS y la regla desaparece del bundle sin romper el build (ya pasó con `.vf-cambio`) · en SQL dentro de `knex.raw`, **cada `?` es un placeholder** (usar `{0,1}` o `pgRaw()`).

---

## 11. Riesgos y preguntas abiertas

| Riesgo | Mitigación |
|---|---|
| Cambiar el contrato de "no encontrado" (`200 ok:false` → otro código) rompe a los kioscos con respaldo viejo. | Mantener la forma actual **y** agregar el campo nuevo; retirar la vieja en una fase posterior, con el snapshot versionado (VAC.L11). |
| Migrar la cámara (VAC.U2) toca el Andén y el conteo comercial. | Va **al final**, con sus specs existentes en verde y sin mezclar con la piel. |
| Consumir `v_label_prices` cambia el precio visible en 2 SKUs × 9 plazas (los que la tabla tenía viejos, `[ETQ-ODS.1]`). | Es la **corrección buscada**: el mostrador pasa a decir lo que dice el ERP. Se anuncia en el commit con el antes/después. |
| La zona del operador a Operations cambia cómo se ve el kiosco que ya está en piso. | D1 firmada antes; validación **visual** con 0Sistemas en un mostrador real (hoy `NO MEDIDA`). |
| Sin acceso a prod, el candado de paridad no se puede cerrar. | Se escribe con prueba negativa y se declara pendiente; no se publica "0 diferencias" sin haberlo medido. |

**Preguntas que sólo puede contestar una persona:** ¿quién firma D1 — Edgar, 0Sistemas o ambos? · ¿el precio corregido a mano es una práctica viva en las tiendas (D2)? · ¿hay un mostrador de pruebas donde validar la piel?


---

## 12. Estado tras el merge (2026-10-16)

**#414 se fusionó el 2026-10-15 (`1cb1f8dd2`) y tiró el arranque de la API en producción** (parámetro decorado tipado con el nombre del esquema Zod; ver [`GOTCHAS.md` §84](../../GOTCHAS.md)). Lo arregló `[VAC.FIX]` (`e5fa64ec8`); prod responde `200` y sirve `11d37aa77`, que lo incluye. Post-mortem en [`03_LOG_REVISIONES.md`](../03_LOG_REVISIONES.md) (2026-10-16). Esto corrige dos afirmaciones de §10 y de las notas L1/L7 de arriba: «los tipos del backend los comprueba el CI» era cierto —y **insuficiente**: el CI no levanta la API—, y la prueba del pipe en `kp.controller.spec.ts` era un regex sobre el texto fuente (su «mutación» sólo quitaba ese texto) y **ciega al defecto de arranque**.

**Contra la Definición de Terminado de [`METODO_DE_TRABAJO`](../../METODO_DE_TRABAJO.md) §5:**

| # | Punto | Estado |
|---|---|---|
| 1 | Métrica de §2 medida otra vez | ⚠️ **El plan se escribió antes del método y no define una métrica de §2.** Las cifras que sí hay (hex 69 → 2, `::ng-deep` 3 → 0, pruebas 298 → 325, `KpService` 0 → 28) son de implementación, no de resultado. Se declara. |
| 2 | Capas verificadas o NO MEDIDAS | C3 (interfaz): verificada con renders estáticos y pruebas, **sin ver la app real**. C2 (API): tipos ✅ en CI; **arranque NO verificado por nadie antes del merge** (de ahí el incidente). C0 (datos): **NO MEDIDO** (sin lectura de prod). |
| 3 | Endpoints que escriben, ejercidos | N/A: la fase sólo lee. |
| 4 | Compuertas nuevas rotas a propósito | No se creó ninguna compuerta; se agregaron candados (probados por mutación, salvo el matiz de arriba). |
| 5 | Primitivos en `libs/` | ✅ El contrato tipado y los esquemas de consulta viven en `libs/contracts`. Deuda con nombre: `mapear()` puro (L9) y `money.util` (L12). |
| 6 | Tracker, log y roadmap reflejan el estado real | ✅ con este cierre (tracker, log, changelog, CV.24, GOTCHAS §84, ONBOARDING puntos 30–31). |
| 7 | En prod | ✅ **Desde el 2026-10-15** (commit `11d37aa77` verificado hoy). |

**Conclusión: no se marca ✅** hasta tener (a) la **validación visual en el monitor real** (lector, cámara, pantalla completa y datos reales) y (b) H1 llevado a Precios/Comercial con cifras de prod. Mientras tanto la fase queda **🧪** y **no libera cupo** (método §3).

**Pendientes reclasificados a ⏸️ (diferido, con nombre y razón):**

| Item | Por qué ⏸️ y no ⬜ | Qué lo destraba |
|---|---|---|
| **D1–D6** (leer de `v_label_prices`, códigos como vista, override manual, frescura, snapshot, candado `[CV.26]`) | Todo necesita lectura de prod, hoy sin acceso; y D2/D3/D5 están sin firmar | Acceso de lectura a prod + firma de D2/D3/D5 |
| **L5** (declarar unidades dudosas) | Hay que medir contra prod qué filas contradicen su propio `c84` | Misma lectura de prod |
| **L2, L4, L8** (resolver único, envelope de procedencia, throttle) | Tocan el backend, y la lección del incidente es que **ahí no hay red de seguridad**: el CI no levanta la API (VP.5). No se abre más superficie de arranque sin un job de arranque | VP.5 (job que levante la API) o una prueba de arranque equivalente |
| **U1, U2, U3, U14** (descomponer el componente, cámara compartida, `<dialog>`, `@layer`) | Refactor sin valor visible que **pide validar en el dispositivo real**, que aún no se hizo (U2 toca Andén y conteo) | La validación visual del punto (a) |
| **L10 (mensaje por 5xx), L12, mapear()** | Menores; ya hay deuda con nombre | — |

⛔ **Cómo se verificó el arranque en este ciclo:** nunca. Es lo que enseña el incidente. Hasta que el CI levante la API (VP.5), todo cambio que toque decoradores, constructores o providers de Nest se acompaña de una prueba de `design:paramtypes` o declara «arranque no verificado» en el PR (`ONBOARDING.md` §8.0b, puntos 30–31).

---

## Observaciones de diseño UI — revisión del plan (2026-10-26)

> **Con qué se miró: el plan, no la pantalla** (nivel C). Nada visual se da por medido; lo que
> sólo se comprueba con la pantalla viva va como criterio a verificar. La ley es
> [`ESTANDAR_DE_INTERFACES.md`](../../ESTANDAR_DE_INTERFACES.md) (§ = sus secciones) y su
> implementación [`DESIGN.md`](../../../DESIGN.md). Severidad: 🔴 la pantalla afirmaría algo falso,
> escondería lo que importa o perdería trabajo — **bloquea pasar C3 a 🚀** · 🟠 se resuelve dentro
> de la fase · 🟡 mejora; si no entra, queda como deuda con nombre. La pantalla existe (en prod desde
> el 2026-10-15): cada observación es un criterio a verificar en ella, no un defecto medido.
>
> **La misma pantalla tiene dos planes.** `/tienda/verificador` nació en la Fase CV (CV.24) y se acopló
> aquí. Las observaciones que nacen de decisiones de CV.24 que esta fase no revisó —sucursal en la
> franja, edad del respaldo, ayuda en hover, contador, borrado a los 20 s— están en la sección
> equivalente de [`FASE_CV`](FASE_CV_CATALOGO_TIENDA_MAYOREO.md), para no duplicarlas.

**La pregunta que contesta (prueba de la frase, §4.0b):** *«¿Cuánto cuesta esto aquí, hoy, y cuánto
si llevo más?»* — dos preguntas en una tarjeta, por decisión firmada (el mayoreo es protagonista,
DESIGN §O.3). No es un defecto a partir, pero obliga a dos cosas: que cada cifra lleve pegada su unidad
y su umbral, y que el ahorro compare precios de la **misma** fuente y la misma edad (VAC.UI.1).

**Jerarquía propuesta (§3.7 · DESIGN §Q.5):** primario = **precio de la unidad escaneada y el bloque de
mayoreo** (decisión de 0Sistemas) · secundario = el umbral de cada escalón en la unidad escaneada y su
equivalencia · terciario = franja de sucursal, frescura, respaldo y nota de IVA.

| # | Sev | Observación (desde la silla de quien la usa) y costo | Ley | Criterio de aceptación |
|---|---|---|---|---|
| VAC.UI.1 | 🔴 | **La tarjeta junta dos edades del dato, y el ahorro —la cifra protagonista— puede salir de las dos.** El precio unitario sale vivo de `kepler_ods.kdii` (~1–2 min) y el mayoreo y el gramaje de la tabla batch `product_label_prices` (hasta 32 min) (§0). D1, el paso a una sola fuente, quedó ⏸️. En esa ventana, tras un cambio de precio en Kepler, «Ahorras $X por unidad (N % menos)» compara un precio nuevo con uno viejo: puede inflarse, encogerse o salir negativo, dentro de la caja enmarcada con `--action` que se decidió que mande. | §1.6 · §3.6 · §1.5 | Mientras D1 no esté, el ahorro sólo se publica si los dos precios vienen de la misma lectura; si no, el bloque dice «Mayoreo actualizado hace N min» y no calcula ahorro. D1 (leer de `analytics.v_label_prices`) es condición para ✅. |
| VAC.UI.2 | 🔴 | **Precios con unidad dudosa se publican como firmes.** L5 sigue ⏸️ y el plan cita **3,570 filas y 102 SKUs** que hoy salen sin aviso, donde el precio de la plaza contradice su propio `c84` o el SKU es pallet o granel. H3 agregó «Equivale a 144 piezas», que el servidor calcula con ese mismo factor: en esas filas la equivalencia afirma un conteo falso, en letra grande y a 1–2 m. | §1.3 · §1.1 · §4.5 | Con `unidad_dudosa`, la tarjeta no publica «Equivale a N piezas» y dice, sin datos internos: «Confirma en caja el contenido de esta presentación». L5 se mide contra prod antes de ✅. |
| VAC.UI.3 | 🔴 | **El bloque protagonista puede promover la presentación más cara.** H1 sigue abierto: en el ejemplo de la auditoría (precios del mockup, sin verificar contra el SKU real), desde 3 piezas comprar suelto a mayoreo sale **$114.80 más barato que la caja** y $51.20 más que el paquete, y los chips de paquete y caja se presentan como mayoreo. Nadie ha medido cuántos SKUs lo tienen. La auditoría lo dejó a Precios; mientras tanto, la pantalla no tiene por qué afirmarlo: el sistema puede hacer la cuenta. | §1.1 · §4.0c · conflicto a decidir por Edgar con Precios/Comercial | El servidor compara el precio por pieza de cada presentación contra el mayoreo de umbral menor; si la presentación sale más cara, el chip lo dice («Por pieza sale más caro que llevar 3 o más sueltas») o deja de presentarse como oferta. H1 se mide en prod (sólo lectura) antes de ✅. |
| VAC.UI.4 | 🟠 | **En kiosco la tarjeta ya no avisa que un precio acaba de cambiar, y la nota «es el mismo que sale en la etiqueta del anaquel» puede no serlo.** U12.1(c) quitó del kiosco el aviso de precio cambiado y DESIGN §O.3 lo declara como compromiso. Justo en kiosco la clienta compara contra la etiqueta: si el precio cambió hoy, pantalla y etiqueta discrepan y la discusión llega a la caja. Y con override manual (D2 sin firmar; última medición: 0 filas, ~9-sep, a re-medir) el verificador aplica un precio que la etiquetera ya no imprime, con esa nota encima. | §1.3 · ADR-056 · conflicto con una decisión firmada | **Para Edgar:** en kiosco, una línea neutra sin datos internos —«Precio actualizado hoy: puede no coincidir con la etiqueta»— conserva la declaración sin el detalle. La nota «es el mismo que sale en la etiqueta» sólo aparece cuando el origen es el ERP vivo. D2 se re-mide antes de ✅. |
| VAC.UI.5 | 🟠 | **«Frescura sin medir» lleva siete semanas encendida y ya no informa.** `datos_al` es nulo desde el 8-sep (D3 sin firmar, VAC.D4 ⏸️). Un aviso que nunca se apaga se aprende a ignorar, y comparte la franja con el aviso de respaldo, que sí cambia y sí importa: el operador deja de leer los dos. | §3.6 · §2.1 | D3 se resuelve midiendo en prod qué latido existe. Mientras tanto, «sin medir» va en tono neutro y nivel terciario, y el respaldo conserva el tono de aviso: que se distingan sin leerlos. |
| VAC.UI.6 | 🟠 | **Lo que el operador toca cuando falla la red no llega a 44 px, y el botón de cámara no llega al contraste.** El plan lo declara sin resolver: los `p-button-sm` del respaldo «no llegan a 44 px» y el texto blanco sobre `--action` mide 3.39:1. El mostrador se opera con el dedo cuando no hay pistola. | DESIGN §3d Fitts (en `coarse` gana el objetivo de 44 px) · §2.3 | Con `pointer: coarse`, los controles del respaldo miden 44 px o más (sin `p-button-sm`). El contraste del botón de cámara se resuelve en el token o el texto pasa a tamaño grande; si es del token, se escala como tema de toda la Suite. |
| VAC.UI.7 | 🟠 | **El roadmap dice 🟢 y el propio plan dice que no puede marcarse ✅.** §12 concluye «no se marca ✅ hasta tener la validación visual en el monitor real» y que la fase «queda 🧪»; el encabezado sigue en «🔨 EN CURSO». La piel nueva sólo se vio en renders estáticos («no es la app corriendo») y está en prod desde el 15-oct: la cifra a 1–2 m, el lector, la cámara, la pantalla completa y Alto Contraste no los ha visto nadie en el mostrador. | método §4–§5 · §2.3 | La fila del roadmap vuelve a 🧪 y el encabezado se alinea con §12. Revisión en nivel A con `auditoria-diseno` en el mostrador real (claro, oscuro, `forced-colors`, `pointer: coarse`, lectura a 1–2 m) antes de ✅. |

**Lo que esta revisión no cubre:** contraste y tamaño reales en el monitor de mostrador (nivel A); la
cámara compartida (U2) y la descomposición del componente (U1), que no cambian lo que la pantalla
afirma; y las decisiones de CV.24 que siguen vivas, en la sección de la Fase CV.

---

## 13. Ajustes del 2026-11-07 (0Sistemas)

**Visual (`1a0e41ccc`, local):** logo 50 % más grande (96 → 144 px; kiosco 64 → 96) · pie (productos
escaneados y respaldo) al 80 % de opacidad · la frescura **no se pinta en kiosco** (lo que ve la
clienta); fuera de kiosco sigue declarada. Se eligió «sólo en kiosco» sobre quitarla siempre para no
romper la regla 11 ni sellar deuda nueva de `§9`. Validación visual: **NO MEDIDA**.

**`[VAC.P1]` Escaneo más rápido.** Medido en prod (sólo lectura): un escaneo por
`megadulcessuite.com` tarda ~280 ms; ~200 son red/túnel (fuera del código) y **~63 ms la consulta**,
que barría las 86,132 filas de `kdii` (7 `OR` sobre columnas con `TRIM`, ningún índice aplicable).
La consulta pasa a un arreglo con `@>` y la migración `20261107115424_kdii_indice_codigos_verificador`
crea dos índices (`GIN` sobre las 7 columnas + `lpad` de la clave corta), `CONCURRENTLY`.
- Mismas filas: 428 códigos, 3,815 filas, 0 diferencias contra la WHERE vieja; la prueba negativa
  (quitar `c85`) sí difiere.
- Plan con los índices (base local): <1 ms con EAN y con clave corta.
- ✅ **Cerrado el 2026-11-11 (medido en prod, sólo lectura).** #507 fusionado el 2026-11-08; la
  migración se aplicó el 2026-11-08 06:18 UTC y los dos índices están válidos; `/api/health`
  (`dd13a0261`) contiene el merge. Mismo instrumento que el antes: la consulta pasó de **62–66 ms a
  0.7 ms** (Bitmap Index Scan, 19 buffers) y `/api/kp/precio` en la LAN de **~75 a 15–24 ms**. No
  re-medido por `megadulcessuite.com`.
- **Visual (`[VAC.U16]`):** en prod; **falta verla en el monitor real del mostrador** (logo de 144 px
  contra el precio, pie al 80 % en oscuro, kiosco sin frescura, lector y cámara). Es lo que queda
  para `[VAC.ATERRIZAJE]`.

**Protocolo:** las observaciones del PM de este ciclo entraron a `ONBOARDING.md` §8.0b, puntos 82–85; y al cerrarlo, 101–102.

---

## 14. Decisiones del 2026-11-19 (0Sistemas)

Respuesta de 0Sistemas al resumen de pendientes: «D2 sí · H1 mídelo · acepta la revisión y que quede con su nombre · D3 compruébalo». Todo lo medido, en prod y sólo lectura (`system_identifier` 7688376744939610156).

**D2 → `[VAC.D3]` · se retira la corrección manual del precio.** Medido antes de tocar: **0 de 80,036** filas de `commercial.product_label_prices` son `source='manual'` (todas `kepler`, la tabla se actualizó ese día; el total distinto de cero es el control de que el cero dice algo). Hecho: `KpService` ya no lee `source` ni pisa el precio de Kepler; el contrato deja `origen_precio: 'kepler'` (el campo se conserva: lo leen kioscos y la app del vendedor ya instalados); fuera la nota «Precio corregido a mano» del verificador **y del checador de la app del vendedor**, que lee el mismo endpoint (protocolo §8.0b punto 68: una decisión de producto se aplica a todas las superficies). Pruebas: `kp.service.spec` 2 nuevas, `verificador-procedencia.spec` invertido (ahora exige que NO exista), checador del vendedor; negativas: reintroducir la rama pone rojas las dos del servicio y el candado de la pantalla.

**D3 → `[VAC.D4]` · la frescura por sucursal sale de la última revisión del carril caliente.** Lo medido:
- El latido que leía la pantalla, `analytics.cron_runs` con `job_key = 'cdc_wal_NN'`: **0 filas**. Por eso decía «Frescura del ERP sin medir» desde septiembre (VAC.UI.5).
- Los latidos vivos (`ods_live_hot`, `ods_live_mirror`, `ods_live_caja`) terminaron hace menos de un minuto, pero son **globales**, no por sucursal; y `kdii` no tiene columna de sincronización propia.
- `analytics.ods_branch_checks` (carril `ods_live_hot`): **9 de 9 sucursales** con revisión de hace menos de 1 minuto y sin error. Lo escribe el shipper (`database/importers/kepler/replicate-ods-live.js`) al cerrar la pasada de CADA sucursal, haya o no cambios, y si falla conserva la última buena; el carril lleva `kdii` (`KP_ODS_TABLES` y `ODS_HASH_TABLES` en `ops/k3s/20-ods-live-hot.deployment.yaml`). Significa «revisada contra el ERP», no «le llegó algo»: una tienda que no cambió precios en días sigue al día.
- Ya la usan la existencia del vendedor (MCP.3.16) y Cortes. Hecho: `SucursalesService` lee por el mismo lector, `lecturaDeSucursales` (exportado de `@megadulces/commercial` en vez de escribir otra copia, ADR-056). ⚠️ **Efecto colateral declarado:** `/tienda/caja` (Caja de mostrador) lee el mismo `datos_al` y también deja de decir «sin medir». 5 pruebas nuevas (`sucursales.service.spec`); con el servicio anterior, 3 se ponen rojas.

**H1 · medido.** Instrumento: el respaldo del propio kiosco (`/api/kp/precios-todos?sucursal=NN`, tiendas 01–08), o sea los mismos números que pinta la pantalla; contrastado al centavo contra `/api/kp/precio` en un caso. Regla: hay un mayoreo de la unidad base «desde N» con N ≤ las unidades de una presentación, y llevarlas sueltas a mayoreo cuesta **≥ 0.5 %** menos que la presentación (debajo es redondeo). Controles de unidad antes de juzgar (regla 10): presentación con precio por unidad fuera de 0.5–1.5× el suelto (**21 SKUs**, no se juzgan) y mayoreo fuera de 70–100 % del precio mostrado (**46 SKUs**, no se juzgan). Resultado sobre 51,768 pares presentación × mayoreo:

| | SKUs | ≥ 2 % | ≥ 5 % | ≥ 10 % | mediana |
|---|---:|---:|---:|---:|---:|
| **Escalera rota, dato limpio** | **166** | 114 | 80 | 12 | 4.6 % |
| Dudosa por unidad («paquete» sobre base pieza sin paquete registrado, la duda que `kp.service.ts` ya declara) | 199 | 173 | 116 | 42 | 6.4 % |

Hallazgos aparte: **14 SKUs** con la presentación más cara por unidad que la unidad suelta al menudeo; **2 SKUs** cuyo ahorro de mayoreo se calcula sobre un precio de la tabla de etiquetas que no es el que muestra la pantalla (las dos fuentes de VAC.UI.1 / D1; p. ej. un precio de $1.10 en la tabla contra $22.64 en Kepler). La lista por SKU (con precios) se entregó **fuera del repo** a Precios/Comercial, porque el repo es público. **Lo que decide Edgar con Precios/Comercial:** corregir esos precios en Kepler, o que la pantalla avise (el criterio de VAC.UI.3). `[VAC.H1]` ⚠️.

**Aterrizaje · aceptado.** La fase se acepta **sin** la validación visual en el monitor real; esa revisión queda ⏸️ **con su nombre**, `[VAC.VISUAL]`: lector, cámara, pantalla completa, logo de 144 px frente al precio, pie al 80 % en modo oscuro y kiosco sin frescura.

**Protocolo:** las observaciones del PM de este ciclo entraron a `ONBOARDING.md` §8.0b, puntos 109–113.

**NO MEDIDO:** el arranque de la API con el import nuevo de `@megadulces/commercial` (no cambia ningún constructor ni decorador; `tsc --noEmit` de la API sin errores nuevos); la pantalla viva con estos cambios; D5 sigue ⏸️ hasta `[VAC.VISUAL]`.

---

## 15. `[VAC.PAQ.1]` Un «paquete» que el producto no tiene (2026-11-25)

**Reporte del mostrador:** el `18016` (Cajeta envinada 1 kg) mostraba «desde 3 paquetes, $136.12 c/u», y en Kepler sólo tiene pieza ($142.87) y caja de 12 ($1,522.48).

**Causa, medida** (prod, sólo lectura): la ficha (`kdii`) no tiene `PAQ`, pero `kdpv_prod_util` trae tres escalones con `c2 = 'PAQ'` (3–5 $136.12 · 6–9 $125.89 · 10+ $123.51, iguales en las 9 plazas). `tiersDeFila` los publicaba como escalón de «paquete» comparado contra la pieza: es la clase que el propio código ya declaraba dudosa («base pieza SIN paquete registrado»). En 600 renglones de venta del 18016 (desde junio) Kepler cobró la lista, su escalón de pieza ($128.01 desde 3) o la caja prorrateada; nunca $136.12 ni $125.89 (los $123.50 de junio–septiembre son la caja de entonces, no el escalón de $123.51).

**Alcance:** Medido el 2026-11-25 (prod, sólo lectura): **859 productos** tienen esos escalones huérfanos; **620** los mostraban en el verificador (tiendas 01–08, 4,905 pares producto × tienda); en **606** Kepler nunca cobró ese precio en 60 días (351,086 renglones de venta revisados) y en **14** lo cobra pero a la PIEZA, con una regla que no se pudo derivar del ODS. Hipótesis probada y **refutada**: «Kepler aplica el escalón PAQ a la pieza cuando la pieza no tiene escalón propio» (21 de los 23 donde se cobró sí lo tienen). El precio de esos escalones es del tamaño de una pieza (mediana 0.89 del precio suelto), no de un paquete.

**Arreglo:** sin `PAQ` en las presentaciones de Kepler y con base no agrupada, el escalón «paquete» que se compara contra la base no se publica (en vivo y en el respaldo del kiosco). Se decide con `kdii` y no con la fila de etiqueta: ésta deja sin paquete al `PAQ` de factor 1, y el `95684` (canela, PAQ real a $393.60) habría perdido un mayoreo verdadero — era el único caso de regresión de la regla ingenua. En los 14 donde Kepler sí cobra ese precio a la pieza, sale de pantalla hasta saber la regla: mostrar nada es mejor que mostrar una presentación falsa.

**Pruebas:** 5 nuevas en `kp.service.spec.ts` (sin PAQ se quita; PAQ de factor 1 se queda; base PAQ y base CJA se quedan; el respaldo filtra igual). Tres mutaciones, cada una en rojo: sin el filtro, ignorando el PAQ de Kepler y sin la guarda de base agrupada.

**Pendiente:** `[VAC.PAQ.2]` limpiar en Kepler los escalones huérfanos (Compras/Precios). **NO MEDIDO:** el después en prod (se mide al desplegar: 0 productos con «paquete» sin PAQ); el checador del vendedor en pantalla (lee el mismo endpoint); un respaldo de kiosco ya descargado sigue con el escalón hasta su re-descarga (12 h o al pulsar «Actualizar respaldo»).

---

## 16. `[VAC.D1]` El mayoreo, directo del ODS (2026-11-25)

**Pedido (0Sistemas):** «confirma que la fuente de información sea la ODS para que al momento de actualizar Compras no tengamos problemas».

**Lo que se encontró, por dato:** precios y presentaciones salían del ODS en vivo (`kdii`, carril caliente, segundos); el mayoreo salía de `commercial.product_label_prices`, una tabla que recalcula `import-label-data.js` a partir del ODS (`kdpv_prod_util` viaja en el carril espejo, ~5 min). Medido el 2026-11-25 (prod, sólo lectura): la tabla `commercial.product_label_prices` la recalcula `database/importers/kepler/import-label-data.js` **sin latido** en `analytics.cron_runs`; ese día iba al día (70,398 de 70,440 pares producto × tienda iguales a la vista viva) y reflejó la limpieza del 18016 que hizo Compras, pero sólo porque el importer corrió. **Testigo vivo:** Compras limpió ese día los escalones `PAQ` del 18016 en Kepler; el ODS ya no los tenía, la tabla se recalculó a las 14:23 y el verificador en prod mostró sólo «pieza desde 3, $128.01» sin desplegar nada.

**Cambio (`VAC.D1` del §3):** `datosDeEtiqueta` y `mayoreoDeTodos` leen `analytics.v_label_prices`. La ficha del catálogo va con LEFT JOIN (da la llave del aviso y el proveedor, pero un producto sin ficha también tiene su mayoreo). La búsqueda usa la clave tal cual y sin ceros (36 claves de `kdii` no miden 5) y gana la exacta; en el lote, ante claves que sólo difieren en ceros, se queda la de 5 dígitos, que es la que busca el respaldo.

**Medido contra prod con el SQL exacto del cambio** (extraído del archivo, sólo lectura): un producto 9–26 ms; respaldo de la tienda 01 ~1 s (la tabla daba 18 ms; el endpoint completo pasa de ~0.7 s a ~1.3 s, una vez cada 12 h por kiosco); **8,903 → 9,345** productos con fila y **8,556 → 9,013** con mayoreo. `app_runtime` tiene SELECT sobre la vista (dueño `postgres`, sin `security_invoker`).

**Pruebas:** 3 nuevas en `kp.service.spec` (las dos lecturas van a la vista y no a la tabla, con la plaza y las dos formas de la clave; un producto sin ficha conserva su mayoreo); volver a la tabla las pone rojas. El candado de `verificador-procedencia.spec` que cuenta las columnas del paquete ahora exige las TRES lecturas; quitar una lo pone rojo.

**Error mío en el camino:** al cerrar `[VAC.PAQ.1]` corrí sólo las pruebas del backend, y un candado de la pantalla que lee `kp.service.ts` como texto (`et.mayoreo.map(compactarTier)`) quedó rojo en el commit local. Se corrigió aquí (§8.0b 133).

**Protocolo:** observaciones del PM al protocolo previo al PR, `ONBOARDING.md` §8.0b 131–135 (134–135 salieron del cierre de #627: el PR seguía abierto cuando se dio por fusionado, y quedó `DIRTY` dos veces antes de fusionarse).

**Pendiente:** `[VAC.D1.1]` (los demás lectores de la tabla y el importer sin latido; la clave de 6 dígitos). **NO MEDIDO:** el arranque de la API (sin cambios de constructor ni decoradores); el endpoint desplegado.
