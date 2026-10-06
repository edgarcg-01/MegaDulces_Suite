# Fase WMS — el Almacén como un solo producto

> **Estado:** 🧪 **[WMS.1] EN CÓDIGO 2026-08-31 (build view verde)** · el resto 🔨 **DISEÑADO (planeación)**.
>
> **[WMS.1] — una sección, tabs `liquid`.** Sidebar **19 items → 5** (*Entrada · Inventario · Conteo · Control* + **Movimientos intocable**; *Salida* entra en WMS.5-6). **Cero cambios de ruta, cero migraciones, cero backend.**
>
> **Revisión 2 (mismo día), tras feedback:** la primera pasada estaba mal en dos cosas concretas. (a) **Agrupaba por tema y no por trabajo**: un área "Caducidades" arrancaba *Por fechar* y *Ubicaciones* del flujo de recepción al que pertenecen — *Por fechar* es la cola que deja el cierre del vale y *Ubicaciones* es el último paso de recibir. (b) **Repetía etiquetas entre los dos menús** (área "Existencias" con tab "Existencias", área "Conteo físico" con tab "Conteo físico"), así que sidebar y barra se leían como el mismo menú duplicado. Además, poner la pantalla handheld *Contar* **dentro** de la barra hacía que al hacer clic la barra desapareciera — un tab que se autodestruye. Corregido: 4 áreas por trabajo, cero etiquetas repetidas, handheld en `focusEntries` (fuera de la barra, pero sigue siendo candidata a aterrizaje).
> - **Fuente única** `modules/almacen/almacen-tabs.ts`: `ALMACEN_AREAS` (área → prefijos de URL → tabs con permiso). Resolución de área por **prefijo más largo** — sin esa regla `/almacen/inventory` (Existencias) se tragaba todas las sub-rutas de Caducidades y Conteo, que viven bajo el mismo path.
> - **`AlmacenAreaShellComponent`**: padre de ruta con `path: ''` que pinta la barra **una sola vez** en vez de repetir `<app-page-tabs>` en los ~19 componentes. Las URLs de los hijos no cambian → deep-links y redirects viejos intactos.
> - **Excepción handheld respetada:** `/almacen/inventory/count` (con `countFocusGuard`) y `recepcion-sesiones/:id` cuelgan **fuera** del shell → sin barra de tabs. Van antes del shell porque el router matchea en orden.
> - **El sidebar deriva del mismo archivo** (getter, no campo): la ruta destino de cada área es **el primer tab que el rol alcanza**. Con ruta fija, un contador con solo `CONTAR` aterrizaba en Folios (`SUPERVISAR`) → 403, y un promotor con solo `EXPIRY_VER` perdía las hojas de anaquel. `NavItem.activePrefixes` nuevo: los tabs de un área **no comparten prefijo** (`/almacen/warehouses`, `/almacen/dead-stock`…), así que `routerLinkActive` solo dejaba el sidebar sin resaltado.
> - **Dos bugs de `PageTabsComponent` corregidos, encontrados por este cambio:** (1) `syncIndicator()` solo corría en `ngAfterViewInit` — funcionaba en Contabilidad porque ahí cada tab **recrea** el componente, pero en un shell la instancia persiste y **el blob se quedaba clavado** en el tab inicial → ahora re-sincroniza en `NavigationEnd`; (2) `visibleTabs` filtraba solo por el JSONB legacy, sin el shortcut `manage:all`, así que un superadmin sin la clave literal de un permiso **restrictivo nuevo** (`COMMERCIAL_INVENTORY_RECIBIR` nace sin seed) veía la barra vacía aunque el guard lo dejara entrar — el mismo trap que el sidebar y `permissionGuard` ya resolvían.
> - **Trampa de sintaxis vivida:** un comentario CSS con backticks dentro del template literal de `styles` corta la cadena → `FatalDiagnosticError 1010: Failed to resolve styles at position 1 to a string`. El error no nombra el archivo.
> **Revisión 3 — el doble menú (reportado con captura).** La causa raíz que las dos revisiones anteriores no vieron: **las páginas YA traían su propia barra de tabs.** `modules/comercial/inventory-tabs.ts` exportaba **tres** juegos (`INV_STOCK_TABS`, `INV_COUNT_TABS`, `INV_ANALYTICS_TABS`) pintados inline en **12 componentes**. El shell de área fue una **cuarta** capa encima → dos barras apiladas, con **destinos distintos** (por eso "al darle clic en un apartado se manda a otro lado": la barra vieja agrupaba en otros clusters y te sacaba del área).
> - **Lección:** antes de agregar navegación, buscar la que ya existe. `grep app-page-tabs` en las páginas del proyecto habría contestado en 5 segundos — la primera pasada solo miró el sidebar y las rutas.
> - **Arreglado:** removidas las 12 barras inline (tag, `imports:`, import del módulo y campo `inventoryTabs`/`tabs`) y **borrado `inventory-tabs.ts`** — si queda, alguien lo vuelve a importar y el doble menú regresa. Se fue también `showInvTabs` (el check "solo bajo /almacen" ahora lo resuelve el árbol de rutas, no una comparación de URL en el componente). Queda **una sola** barra, la del shell.
> - **Efecto colateral bueno:** las barras viejas gateaban *Stock muerto* y *Salud inv.* con `COMMERCIAL_ORDERS_VER`, que **no** es el permiso del guard de esas rutas (`DEADSTOCK_VER` / `INVHEALTH_VER`). `ALMACEN_AREAS` usa el permiso real → se acabó el tab visible que tiraba 403 y el invisible para quien sí podía entrar.
> - **Bug de jerarquía corregido:** `NavItem.activePrefixes` hacía prefijo ingenuo, así que `/almacen/inventory/sessions` marcaba **Inventario** *y* **Conteo** en el sidebar (dos items activos). Reemplazado por `activeAreaKey` + `resolveAlmacenArea` — **el mismo** resolvedor de la barra, así que sidebar y tabs no pueden discrepar y exactamente un item queda activo.
> - **Verificado:** `nx build view` verde (4 corridas, `--skip-nx-cache`) + **check de jerarquía 116/116** sobre el módulo **real** transpilado (`almacen-tabs.ts` → tsc → `require`), **no** una reimplementación en JS — esa es la lección de WMS-REC.4, donde un smoke que espejaba `computeVerdict` daba 17/17 con la ruta caída. Afirma: cada una de las 24 rutas vivas resuelve a **una** área y a la esperada; ningún tab repite el nombre de su área; **ningún tab te saca de su área ni aterriza en pantalla sin barra**; las de foco no están en la barra pero sí son candidatas a aterrizaje; y `Movimientos` no está en ningún área, match ni tab.
> **Revisión 4 — el cierre del vale ENCADENA a Caducidad** (pedido del equipo, 2026-08-31). Antes, cerrar un vale mostraba un toast y dejaba al operario parado: la mercancía ya estaba de alta en lote `NA` y él tenía que ir a buscar la pantalla de Caducidad y re-teclear almacén, proveedor, producto y cantidad de algo que la app ya sabía. **Eso es exactamente cómo entra mercancía sin trazabilidad.**
> - `doClose()` mira `progress.undeclared_units`: si hay piezas sin fechar, navega a `/almacen/inventory/recepcion?session=<id>`; si no hay, avisa "todo entró con lote y caducidad" y se queda. **El encadenado es conveniencia, no la única vía** — lo que no se feche ahí sigue cayendo en *Por fechar*.
> - El auditor lee `?session=`, carga el vale y muestra los **renglones por fechar** con su `faltan` **derivado** (`recibido − declarado − retenido`, igual que el detalle del vale: no se denormaliza). Elegir un renglón prellena almacén, proveedor, producto y cantidad, y liga la captura con `receiving_line_id` — **sin esa liga el cuadre del vale no se mueve y el renglón se queda en Por fechar para siempre**.
> - **El producto queda IMPUESTO por el renglón** (chip fijo, no buscador): el backend rechaza una captura ligada a un renglón de otro producto, así que dejarlo editable solo invita al 400. Mismo criterio que el `cajero_code` del arqueo: lo que el sistema ya sabe no es un campo de formulario.
> - Tras cada captura recarga el vale y **salta al siguiente pendiente solo**. El 🔴 **no** baja el pendiente (queda retenido, que es lo correcto: no entró a stock). Cuando se vacía, ofrece ir a *Por fechar*. Hay botón para soltar el vale y capturar suelto.
> - **Sin backend, sin migraciones:** `evaluate` ya aceptaba `receiving_line_id` y `source_ref`, y `detail(id)` ya devolvía `declared_qty`/`held_qty` por renglón.
> - **Falta validación visual en browser** (no automatizable desde CLI sin credenciales).
> **Origen:** arquitectura de WMS de referencia aportada por el equipo (2026-08-31), **fusionada contra el código verificado del repo** — no contra notas viejas.
> **Tesis:** no hay que construir un WMS. **7 de los 11 módulos** de la arquitectura de referencia ya están en producción. Lo que falta es (a) **cerrar la mitad de salida** y (b) **unificar la superficie**, que hoy son 19 items planos de sidebar.
> **Principio (ADR-016):** el motor decide, el operario confirma la realidad física, el OCR/LLM propone pero no autoriza.
> **Hereda:** ADR-044 (Kepler = SoR de la cantidad, la app dueña de lote/caducidad/ubicación/evidencia, **sin write-back**), ADR-021 (*ship-collector-before-learner*), ADR-016.

Leyenda: ✅ **existe y opera** · 🟡 **parcial** · ⬜ **no existe** · ❌ **descartado, con razón** · ❓ **decisión abierta**

---

## 1. Decisión de navegación (IA)

**El problema:** `/almacen` tiene **19 items de sidebar** en 3 grupos. Tres de ellos —*Caducidades*, *Recepción*, *Vales de entrada*— no son tres áreas: son **tres estados del mismo trabajo**. Un vale pasa por los tres, y el menú obliga al bodeguero a saber en qué pantalla vive cada paso.

**La decisión:** un área = **un item de sidebar**; los subtemas son **tabs**, nunca items nuevos. Esa regla aplica a lo que existe y a todo lo que se construya en esta fase.

**El control:** `app-page-tabs` con **`variant="liquid"`** (segmentado estilo iOS con blob deslizante, `styles.css` §*Liquid Tabs*). Elegido explícitamente sobre las otras dos opciones del repo:

| Control | Por qué no |
|---|---|
| `variant="underline"` (default) | Es el default de Operations, pero no es el formato pedido. |
| `.fb-viewseg` (Finanzas) | Es el que se ve en Bancos/Caja, pero es **state-based** (`signal` + `goView()`): fusionaría 15 componentes en uno, mata deep-links y lazy-loading. Su CSS es privado de Finanzas. |
| **`variant="liquid"`** ✅ | **Route-based** (cada tab es `routerLink` a ruta hermana), filtra por permiso solo, se esconde con 1 tab visible, y ya está probado en 12 páginas de `/contabilidad/*`. |

> **Nota de diseño:** Finanzas **retiró** el gloss iOS por quiet-luxury (ver comentario en `finanzas-shared.styles.ts`), y Contabilidad lo usa. Son dos direcciones vivas. Esta fase adopta `liquid` por decisión explícita del equipo → **requiere addendum a `DESIGN.md`** para que no quede como desviación silenciosa.

**El corte es por TRABAJO, no por tema.** El primer intento agrupó por tema
(un área "Caducidades") y partió un mismo flujo en dos: *Por fechar* es la cola
que deja el **cierre del vale** (el cierre da de alta en lote `NA` y alguien le
pone la fecha después) y *Ubicaciones* es el **último paso de recibir**. Las dos
volvieron a **Entrada**. Un área = lo que una persona hace en un turno.

**Regla anti-duplicado:** ninguna etiqueta de tab repite el nombre de su área.
Si la repite, el usuario lee el mismo texto en el sidebar y en la barra, y los
dos menús se leen como el mismo menú. Por eso el área es *Inventario* (no
"Existencias", que es uno de sus tabs) y el tab handheld es *Contar* (no
"Conteo físico", que es el área).

**Estructura resultante — de 19 items de sidebar a 5:**

| Sidebar | Tabs (rutas que ya existen, salvo marcadas) |
|---|---|
| **Entrada** | Vales · Caducidad · Por fechar · Ubicaciones · *(WMS.9)* Citas · *(dif.)* Devoluciones |
| **Inventario** | Existencias · Por vencer · Hojas de anaquel · Stock muerto · Salud inv. · Almacenes |
| **Conteo** | Folios · Cíclico (ABC) · Pasillos · Exactitud (IRA) — *(+ `Contar`, pantalla de foco)* |
| **Control** | Cuadre · Prevención · Monitoreo · Riesgo |
| **Movimientos** ⛔ | **ninguno — intocable.** Ver regla 5 |
| **Salida** *(nueva, WMS.5-6)* | Órdenes · Surtido · Checado · Embarque |

**Reglas duras de esta reestructura:**

1. **Las rutas no cambian.** `app-page-tabs` es aditivo. Donde haya que mover algo, va con `redirectTo` — el patrón que ya se usó para `/comercial/inventory/**` → `/almacen/inventory/**`. Los smokes son HTTP contra la API: no los toca.
2. **Las pantallas handheld NO llevan barra de tabs Y NO SON TABS.** `/almacen/inventory/count` (con `countFocusGuard`) y `recepcion-sesiones/:id` son estación en la rampa. Poner tabs ahí invita al operario a irse a otra pantalla a media tarima. **Y tampoco pueden figurar EN la barra:** un tab que al hacer clic hace desaparecer la barra se lee como una pantalla rota. Van en `focusEntries`, se llega a ellas desde la pantalla que las precede, y siguen contando como **candidatas a aterrizaje** para que un contador con solo `CONTAR` no pierda su entrada.
3. **El landing `/almacen` conserva `almacenHomeGuard`** (primera superficie accesible del rol → `UrlTree`).
4. **Sin fusionar componentes.** Los tabs unifican navegación, no código. Fusionar es otra decisión, más cara y reversible después. **Esto es explícito: WMS.1 reorganiza el acceso, no reduce pantallas** — la reducción real llega cuando dos pantallas resultan ser una y se fusionan con datos de uso, no por corazonada.
5. **⛔ `Movimientos` es intocable** (decisión del equipo, 2026-08-31). El Diario de Movimientos queda exactamente como estaba: item propio de sidebar, ruta **fuera** del shell, **sin** barra de tabs. Está declarado aparte en `layout.component.ts` (`almacenMovimientosItem`) y comentado en `app.routes.ts` para que un refactor futuro de áreas no se lo lleve por delante.

---

## 2. Checklist de cobertura contra la arquitectura de referencia

### A. WMS operativo

| # | Capacidad | Estado | Evidencia / brecha |
|---|---|---|---|
| A.1 | Almacenes, zonas, ubicaciones | ✅ | `commercial.warehouses`, `warehouse_aisles` (editor 2D, Fase PA), `warehouse_bins`, `stock_lot_locations` (mig `20260817140000`) |
| A.2 | Lotes y caducidades a nivel lote (no SKU) | ✅ | `commercial.stock_lots` + `stock_lot_movements`; invariante `SUM(lotes)=stock` por trigger |
| A.3 | FEFO por default, vencido al último | ✅ | Triggers `20260618210000` / `20260618220000`; política vencidos = WARN al vender |
| A.4 | Movimientos internos / trazabilidad | ✅ | `warehouse_stock_movements` append-only + Diario de Movimientos |
| A.5 | Putaway | ✅ | `BinLocationService.putAway` por `bin_id`/`bin_code` escaneado |
| A.6 | Reubicación entre bins | ⬜ | Diferido explícito de WMS-REC Pieza 3 |
| A.7 | Reabasto de posición de picking | ⬜ | Ver §4 |
| A.8 | Estados de inventario (disponible / reservado / **bloqueado** / **cuarentena**) | 🟡 | Disponible y reservado sí (`commercial.stock_reservations` + `_lines`, mig `20260727140000`). **Bloqueado y cuarentena no existen.** Ver §4 |
| A.9 | Reglas de putaway (por rotación, volumen, caducidad, zona) | ⬜ | Hoy el put-away es manual: el operario elige el bin |
| A.10 | Control de tiempos por actividad | ⬜ | Depende del motor de tareas (§3) |

### B. Inbound

| # | Capacidad | Estado | Evidencia / brecha |
|---|---|---|---|
| B.1 | Requerimientos + Órdenes de compra | ✅ | `commercial.purchase_requisitions` + `_lines` (folio `RQ-YYYY-NNNNN`, HITL), `purchase_orders` |
| B.2 | Recepción contra lo esperado, parcial, con escaneo | ✅ | `receiving_sessions` (Vale vivo, folio `VE-YYYY-NNNNN`) + `receiving_lines`; discrepancia determinista `ok/faltante/sobrante/dañado/producto_incorrecto` |
| B.3 | Captura de lote + caducidad **por renglón** | ✅ | `receiving_lot_captures.receiving_line_id` (mig `20260825120000`); un SKU se desglosa en N lotes |
| B.4 | Control de calidad / dictamen con bloqueo | ✅ | Auditor de caducidad: veredicto 🟢🟡🔴 determinista **por lote**; aceptación parcial; `close()` da 409 con retenidos |
| B.5 | OCR de remisión y de la fecha impresa | ✅ | `LlmExtractorService.extractRemision()` / `.extractExpiryLabel()` (Claude Haiku vision, imagen y PDF) |
| B.6 | Cuadre 3-vías (OC vs entrada vs factura) | ✅ | `discrepancy_kind` persistido (mig `20260805160000`) + `purchase-adjustments` |
| B.7 | Putaway sugerido | ⬜ | El put-away existe; la **sugerencia** no (depende de A.9) |
| B.8 | **Citas de recepción, muelles/andenes, ASN** | ⬜ | **Nuevo.** Ver WMS.9 |
| B.9 | Devoluciones a proveedor | 🟡 | Kepler las tiene (`X-D-40`, `X-D-55`); la app no tiene el flujo físico de retorno |

> **Corrección de una suposición heredada:** ni la arquitectura de referencia ni el plan original de WMS-REC aciertan acá — la tabla `receiving_nonconformities` **nunca se creó**. La No Conformidad es una **fila con `verdict='red'`** en `receiving_lot_captures`. Cualquier diseño que asuma esa tabla está mal.

### C. Outbound — **el hueco central de esta fase**

| # | Capacidad | Estado |
|---|---|---|
| C.1 | Órdenes de salida (tienda / sucursal / mayorista) | 🟡 `commercial.orders` cubre mayorista y portal; **traspaso a sucursal no está modelado como salida de almacén** |
| C.2 | Reserva de inventario | ✅ `stock_reservations` |
| C.3 | Asignación de lote por FEFO | ✅ en el ledger, ⬜ en el piso |
| C.4 | **Tarea de picking dirigida al bin** | ⬜ existe `GET /pick-suggestion` (FEFO físico: bins ordenados por caducidad) y **ninguna pantalla que lo obedezca** |
| C.5 | **Decremento real de `stock_lot_locations` al surtir** | ⬜ diferido explícito de WMS-REC Pieza 3 |
| C.6 | **Checado / verificación** | ⬜ nuevo |
| C.7 | **Empaque, bultos, etiquetado de bulto** | ⬜ nuevo |
| C.8 | Staging / consolidación | ⬜ nuevo (requiere tipo de bin, A.8) |
| C.9 | Embarque, transportista, guía, POD, GPS | ✅ `logistics.*` completo (guías, POD, GPS vivo, ETA, checklists, fotos, costos) |
| C.10 | Olas de picking (waves) | ⬜ **diferido**: optimización, no capacidad |

### D. Inventarios y prevención — **maduro, no tocar**

| # | Capacidad | Estado |
|---|---|---|
| D.1 | Conteo ciego + doble conteo por contadores distintos | ✅ `blind_double_count` default, `count_1/count_2`, `count_3` de desempate |
| D.2 | Segregación de funciones (quien cuenta no reconcilia) | ✅ verificado en servicio, no solo por permiso |
| D.3 | Coverage guard + freeze de ubicaciones | ✅ reconcile rechaza no-contado; freeze cross-module en order flow |
| D.4 | Reason codes de varianza | ✅ `inventory_variance_reason_codes` |
| D.5 | Conteo cíclico ABC + agenda | ✅ ruta `/almacen/inventory/abc` |
| D.6 | IRA + tolerancia / count-back | ✅ `/counts/ira`, `recount_threshold_pct` |
| D.7 | Ledger de ajustes inmutable | ✅ append-only |
| D.8 | Investigación de causa raíz + timeline SKU | ✅ Fase PREV.1 |
| D.9 | Monitoreo intensivo + ventanas de pérdida | ✅ PREV.2 — **más de lo que pide la arquitectura de referencia** |
| D.10 | Índice de riesgo de inventario | ✅ PREV.3 |
| D.11 | Conteo aleatorio / por caducidad próxima | 🟡 el plan de conteo existe; faltan esos dos criterios de selección |

### E. Compras y abastecimiento — **ya en producción, no reconstruir**

Fase RA cerrada y desplegada: `reorder_policy` (producto × almacén), safety stock por **nivel de servicio** (`ceil(Z(servicio)×σ×√lead)`), segmentación **ABC-XYZ**, DRP multi-echelon con risk pooling, requisiciones HITL con folio, tránsito descontado del sugerido, bandeja de hallazgos. La arquitectura de referencia lo propone como módulo a construir; acá es un **consumidor** del WMS, no parte de él.

### F. Configuración y reglas

| # | Capacidad | Estado |
|---|---|---|
| F.1 | Maestros de artículos, categorías, ABC | ✅ `catalog.products` + feed Kepler + 1,278 embeddings |
| F.2 | Motor de reglas de caducidad | ✅ `commercial.expiry_receiving_policy` — cascada **producto / departamento / proveedor**. ⚠️ El eje es `products.department` (Kepler `kdie`), leído de `catalog.products`: `products.category` **no existe** y `public.products` es un `SELECT *` congelado que no expone columnas agregadas después (bug `42703` de WMS-REC.4) |
| F.3 | **Días mínimos de caducidad por canal** | ⬜ **Nuevo y de alto valor.** Ver §4 |
| F.4 | Unidades de medida y conversiones | 🟡 existe para etiqueta y venta (`product_label_unit_base`, `product_unit_overrides`, `wholesale_pack_min_qty`); **falta el eje transaccional cajas/piezas** en recepción y surtido |
| F.5 | Prioridades por canal, reglas de muelle, de putaway, de reabasto | ⬜ |

---

## 3. Lo genuinamente nuevo

Resumido, la fase construye **cuatro** cosas y nada más:

1. **La estación de salida** (surtido dirigido + checado + empaque) — el espejo de la máquina de entrada.
2. **Estados de inventario** con bloqueo y cuarentena físicos.
3. **El motor de tareas** — y acá hay una ventaja: el patrón ya existe **dos veces** en el repo (`horus_supervisor_tasks`, `finance_recon_tasks`). Es un **port**, no un invento.
4. **Citas de recepción y muelles** — el único bloque inbound que falta.

---

## 4. Las tres piezas de mejor relación valor/esfuerzo

**4.1 — `pick_sequence` en la ubicación.**
Verificado: `commercial.warehouse_bins` tiene `code`, `label`, `aisle_id`, `active` — **no tiene secuencia de recorrido**. Sin ella, "FEFO dirige al bin" entrega un bin pero no una ruta: el surtidor cruza el almacén tres veces. Es **una columna aditiva** y mueve la productividad del surtido más que cualquier pantalla.

**4.2 — Días mínimos de caducidad por canal.** ⭐
`expiry_receiving_policy` ya gobierna **la entrada**. Agregarle el eje canal cierra **la salida**: no despachar a un mayorista algo con menos de N días de vida útil, aunque para tienda propia sí sirva. Reusa el motor de reglas ya escrito y convierte el semáforo en una política de **dos puertas** en vez de una. Es la mejor idea que aportó la arquitectura de referencia.

**4.3 — Estados de inventario + cuarentena como tipo de bin.**
Hoy el veredicto 🔴 **retiene la mercancía en la base de datos y no dice dónde está la tarima**: el semáforo es contable pero no físico. `warehouse_bins` no tiene columna `kind`. Con tipos de bin (`recepcion`, `reserva`, `picking`, `staging`, `cuarentena`, `devoluciones`, `merma`) el flujo cierra: 🔴 → bin de cuarentena → el supervisor autoriza (pasa a bin normal) o rechaza (sale a devolución a proveedor).

---

## 5. Descartes justificados

| Propuesta de la arquitectura de referencia | Por qué NO |
|---|---|
| Módulo de compras, OC, proveedores, facturación, validación de crédito, SAT | **Kepler es SoR y el proyecto lo trata read-only en todas las fases (ADR-044).** Reconstruirlo no es completar el WMS, es reemplazar el ERP. Y RA ya opera el reabastecimiento en prod. |
| Message broker / bus de eventos de dominio | Ya hay gateways WS, sinks de hallazgos y crons. **BullMQ está diferido con gate explícito.** Infraestructura sin demanda. |
| Capa de "orchestrators" separada de los services | Son la misma cosa con otro nombre. Renombrar no agrega capacidad. |
| "No mezcles inventario financiero con operativo" | **Ya está resuelto por construcción**: Kepler = financiero, `commercial.*` = operativo. Es exactamente ADR-044. |
| Modular monolith / API interna por dominios | **Ya lo es**: Nx + `libs/` por dominio. |
| Maestros de artículos, unidades, categorías | Ya existen con feed del ERP. No duplicar. |
| Olas de picking (waves) | Optimización, no capacidad. Diferido hasta que haya surtido dirigido corriendo con volumen. |
| Mapa / heatmap de bins | Hace el WMS legible para un gerente; no ahorra dinero. Premio, no motor. |
| RFID, EDI, básculas, WMS externos | Sin demanda declarada. Las básculas **pueden volverse obligatorias** según §6.1. |

---

## 6. Decisiones abiertas

**6.1 — ¿El granel se maneja por pieza o por peso?** ⛔ **RUTA CRÍTICA**
La arquitectura de referencia insiste con **silos** (que en WMS son granel: grano, líquido, azúcar). El repo menciona repetidamente *"dulcería a granel"* — fue lo que tumbó el gate de HV.0 a nivel SKU.

Si existe producto que se cuenta y se vende **por kilo**, entonces `quantity` en piezas es incorrecto para esos SKUs, y **no es un detalle de UI**: cambia el conteo, el surtido, la merma, la caducidad del lote abierto, y mete básculas al flujo. Es lo único del documento de referencia capaz de forzar un rediseño de fondo. **No arrancar WMS.5 sin esta respuesta.**

> ✅ **Contestada (Francisco, 2026-10-06): en el almacén NO hay granel suelto.** Todo lo que llega a
> granel **se empaca** en presentaciones fijas (1 kg, 500 g, 250 g…): son las unidades `KG`, `500`,
> `250` de Kepler. **El surtidor siempre cuenta paquetes**, nunca pesa. Hay productos que, aunque
> van en paquete, **se venden por kilo** (p. ej. bolsas en rollo); esos **se pesan sólo en la báscula
> de las cajas** (punto de venta), no en el almacén. **No hace falta rediseñar `quantity` ni meter
> básculas al surtido ni al conteo.**
> Medido en PH (pedidos embarcados, 21 días): 969 renglones (~8%, ~$760k) se venden en `KG`; 290
> se piden en bulto y 39 en caja (se cuenta el empaque, el peso sale del factor) y 640 en `KG`, de
> los cuales **160 traen peso con decimales** (p. ej. "ALTOS ROLLO VERDE 25X35 1KG", 6.14 kg en
> pedido, surtido y embarque). ⚠️ **Pendiente:** si la báscula está sólo en cajas, ¿de dónde sale el
> peso de esos 160 renglones de pedido? (¿se pesa al tomar el pedido, o el pedido se corrige al
> facturar?). No cambia el surtido —se cuentan paquetes— pero define si el checado debe capturar
> un peso.

**6.2 — Autoridad del inventario en la salida.**
ADR-044 reparte limpio en entrada porque Kepler **no codifica caducidad**: el dato es net-new, sin conflicto. En salida se rompe la simetría, porque surtir **decrementa**. Dos caminos: (a) la app queda como capa sombra que reconcilia contra las salidas de Kepler —y el operario puede surtir algo que Kepler ya vendió—, o (b) la app pasa a ser SoR de la capa física y Kepler del comercial/fiscal. Define si el picking es **sugerencia o autoridad**. → ADR nuevo (§9).

**6.3 — ¿De dónde viene la demanda de salida?**
Cuatro fuentes: `commercial.orders` (portal + vendedor), venta en ruta (VR, diseñada), última milla (LM, diseñada) y **traspasos CEDIS→sucursal** (género N en Kepler, **no** en `commercial.orders`). Hipótesis: el volumen físico real del CEDIS es traspaso y carga de camión, no pedidos de portal. Si es así, una pantalla de surtido alimentada solo por `commercial.orders` **surtiría casi nada** — el mismo error de cobertura que ya se vivió en RE.0 con el feed `md_00`-only. → se contesta en WMS.0.

**6.4 — ¿Un solo item de sidebar o seis áreas?**
`/almacen` ya es **una** entrada a nivel proyecto. Adentro, la propuesta de §1 son 6 áreas con tabs. Forzar literalmente **un** item obligaría a un segundo nivel de tabs anidados, que se lee mal. Confirmar.

---

## 7. WMS.0 — Medición previa (gate)

Dos consultas contra tablas que ya existen. **No es planeación: es lo que dimensiona todo lo demás.**

- **(a) Merma evitable por FEFO.** Lotes que llegaron a su caducidad **con existencia > 0** mientras hubo venta del SKU en la ventana. Sale de `stock_lots` + `stock_lot_movements` + ventas. Es exactamente lo que el surtido dirigido evita. **Si el número es chico, el bin-level no se paga y hay que decirlo.**
- **(b) Canales de salida.** Líneas/día por canal (portal, ruta, traspaso a sucursal) desde el ODS → contesta §6.3.

---

## 8. Sprints propuestos

| Sprint | Alcance | Depende de |
|---|---|---|
| **WMS.0** | Medición: merma evitable por FEFO + canales de salida | — |
| **WMS.1** ✅ | **Una sección, tabs `liquid`**: sidebar 19→5 áreas, excepción handheld, sin cambios de ruta. Sin backend, sin migraciones. **En código 2026-08-31, build verde; falta validación visual + addendum `DESIGN.md`** | — |
| **WMS.2** | Estados de inventario: `warehouse_bins.kind` + bloqueado/cuarentena + el 🔴 aterriza en un bin físico | — |
| **WMS.3** ⚠️ | Etiquetas de bin (generar + imprimir, reusa la impresión de `/tienda/etiquetas`) + **censo de bins reales** | ⛔ **BLOCKED: esperando el croquis de cómo está acomodada la bodega** (2026-08-31). Sin la topología física real no hay `code` de bin que signifique algo, y `pick_sequence` (WMS.4) no tiene de dónde salir. Es dependencia de piso, no de código. |
| **WMS.4** | `pick_sequence` + días mínimos de caducidad **por canal** | WMS.3 (para que la secuencia signifique algo) |
| **WMS.5** ⭐ | **Vale de Salida**: `picking_sessions`/`_lines` espejo del Vale de entrada, folio `VS-YYYY-NNNNN`, escaneo bin+lote+cantidad, decremento real, **eje cajas/piezas** (factor `kdii.c84`, ya decodificado en Fase AX), y **desviación de FEFO instrumentada** | WMS.0, §6.1, §6.2, §6.3 |
| **WMS.6** | Checado y empaque: sesión de checado, bultos, evidencia, **segregación (quien surte no checa)** | WMS.5 |
| **WMS.7** | Reabasto de posición de picking (misma matemática de RA, lead time en minutos) | WMS.5 |
| **WMS.8** | Cola de tareas unificada (port del patrón `horus_supervisor_tasks`) | WMS.5, WMS.7 |
| **WMS.9** | Citas de recepción, muelles, ASN | — |

**MVP = WMS.0 → WMS.5.** Diferidos: olas, mapa/heatmap, devoluciones (necesita decisión de proceso: quién dispone), reglas de putaway automático, granel/silos (§6.1).

### La desviación de FEFO como señal, no como bloqueo

Detalle de WMS.5 que merece su propio párrafo. Cuando el motor dirige al bin X (lote más viejo) y el operario toma del bin Y, eso es un **evento**, no una falta a reprimir. Registrando cada desviación sale:

- qué bins se saltan siempre → **auditoría gratis del layout** (inalcanzable, bloqueado, mal etiquetado)
- qué SKUs se desvían más → el acomodo está mal
- qué operarios → señal de capacitación

Nace un KPI nuevo, **% de cumplimiento FEFO**, hermano del IRA. Y le da a Prevención lo que hoy le falta: eventos **bin-level**. El monitoreo intensivo acota ventanas de pérdida con conteos 2×/día; con surtido instrumentado la ventana pasa de doce horas a **un movimiento con nombre y hora**. Encaja con ADR-021: la pantalla nace siendo colector y el aprendizaje viene después, con data real.

---

## 9. ADRs a crear

- **ADR nuevo — Autoridad del inventario en la salida.** Extiende ADR-044 al outbound: ¿el picking es sugerencia o autoridad? ¿la app reconcilia contra Kepler o pasa a ser SoR de la capa física? **Propuesto, sin decidir** (§6.2). Recomendación: decidirlo **con los números de WMS.0**, no antes.
- **Addendum a `DESIGN.md`** — el segmentado `liquid` es el control de navegación de subtemas del proyecto Almacén (§1), y por qué se aparta de lo que hizo Finanzas.
- **Addendum a ADR-044** — política de caducidad de **dos puertas**: gate en la entrada (ya existe) + gate por canal en la salida (§4.2).

---

## 10. Permisos a crear

Restrictivos, **sin seed** (se asignan en `/admin/roles` + re-login), siguiendo la receta de `COMMERCIAL_INVENTORY_RECIBIR`:

- `COMMERCIAL_INVENTORY_SURTIR` — la estación de salida.
- `COMMERCIAL_INVENTORY_CHECAR` — checado. **Separado de SURTIR a propósito**: quien surte no checa, misma tesis de segregación que ya se aplica en conteo (D.2), donde está verificada en el servicio y no solo por permiso.
- Autorizar la salida de cuarentena reusa `COMMERCIAL_INVENTORY_SUPERVISAR` / rol `prevencion_auditoria`.

---

## 11. Relación con otras fases

[`FASE_WMS_ESTACION_RECEPCION`](FASE_WMS_ESTACION_RECEPCION.md) (WMS-REC.1-5, inbound ✅) · [`PROYECTO_WMS_INVENTARIO_TRAZABLE`](PROYECTO_WMS_INVENTARIO_TRAZABLE.md) (el mapa de brechas original) · `FASE_I_INVENTARIO` (conteo ✅) · [`FASE_PREVENCION_INVENTARIOS`](FASE_PREVENCION_INVENTARIOS.md) (PREV ✅) · `FASE_FEFO_CADUCIDAD` (P2 ✅) · `FASE_PASILLOS_EQUIPOS` (PA ✅) · `FASE_ABC_CYCLE_COUNT` (✅) · [`FASE_RA_REABASTECIMIENTO`](FASE_RA_REABASTECIMIENTO.md) (compras ✅, consumidor) · `FASE_J*` (logística: embarque ✅) · [`FASE_VR`](FASE_VR_VENTA_EN_RUTA.md) / [`FASE_LM`](FASE_LM_ULTIMA_MILLA.md) (canales de salida diseñados, sin código) · [`FASE_AX`](FASE_AX_ANEXO_VENTA.md) (factor de cajas `kdii.c84`).

---

## 12. Addendum 2026-10-06 — Ubicaciones de bodega Y piso de venta (ADR-085) y relación con la Fase GP

**Origen:** conversación con Francisco al diseñar la Fase GP ([`FASE_GP`](FASE_GP_GESTION_PEDIDOS_ALMACEN.md)).
Kepler **no resuelve ubicaciones**; se gestionan desde la Suite. Hay ubicaciones en **bodega** y en
**piso de venta**, y un mismo producto convive en las dos.

### 12.1 Lo medido

- **Las tablas de §2 A.1 existen pero están vacías en prod:** `warehouse_aisles` 4 filas,
  `warehouse_bins` **1**, `stock_lot_locations` **1**. No hay datos que migrar ni que cuidar.
- **Kepler lleva UNA existencia por sucursal** ("ALMACÉN PH") y la Suite un `commercial.warehouses`
  por sucursal (más uno por camión de ruta). Bodega y piso de venta están **en el mismo edificio**
  (confirmado por Francisco) y Kepler no los distingue.
- **La ubicación por etapa del pedido existe en Kepler y nadie la llena** (`kdm2.c59/c60/c61`:
  PH 0%/0%/33%; Canindo 99% relleno). Detalle en `FASE_GP` §2.6.

### 12.2 Decisiones (ADR-085)

1. **Bodega y piso de venta son ZONAS del mismo almacén, no dos almacenes.** Separarlos obligaría a
   registrar un traspaso cada vez que el anaquelista sube producto, traspaso que Kepler nunca ve, y
   la existencia dejaría de cuadrar con el ERP.
2. **Tres capas separadas**, como los WMS líderes (Manhattan, Blue Yonder, SAP EWM, Oracle):
   - **Ubicación física** (`warehouse_bins`): sucursal → zona → pasillo → rack/góndola → nivel →
     posición, con **tipo de zona**, **secuencia de recorrido** (= §4.1), **dígito verificador**
     en la etiqueta, unidad que admite y si es móvil.
   - **Asignación (slotting)** — ⬜ **nuevo, no estaba en este plan**: producto × sucursal ×
     ubicación × papel (`surtido_fijo` · `exhibicion_tienda` · `reserva_preferida`) + mínimo/máximo.
     Dice dónde **debe** estar el producto sin llevar cantidad.
   - **Cantidad por ubicación** (`stock_lot_locations`): **se difiere**. Exige escanear cada
     movimiento; sin eso se desvía de Kepler en semanas (es el "el operador anota y nadie registra"
     de `FASE_GP` §2.6). ⚠️ **Esto cambia WMS.5**, que planeaba el decremento real de
     `stock_lot_locations` al surtir: queda condicionado a que las capas 1 y 2 se usen.
3. **Tipos de zona** (amplía WMS.2): `recepcion` · `reserva` · `surtido` (frente) ·
   **`tienda_piso`** · **`tienda_cabecera`** · `espera` · `anden` · `cuarentena` · `merma` ·
   **`contenedor`** (carretas, tarimas y estibas de camión: **las ubicaciones móviles de GP entran
   en este mismo catálogo**) · zonas especiales (p. ej. fresco), que **sí existen** según Francisco.
4. **Formato de código: el que ya usa el piso** (Francisco, 2026-10-06). La propuesta inicial
   (`B03-05-2` pasillo-rack-nivel) **se descarta**: la numeración física ya existe y es más simple.
   - **Bodega `B01`…`B99`** y **tienda `T01`…`T99`**, consecutivos. Cada código es una
     **sección**; no hay nivel ni posición dentro del código.
   - **El pasillo se deduce del número**, en bloques de 15: pasillo 1 = `B01`–`B15`, pasillo 2 =
     `B16`–`B30`, **pasillo superior 1** = `B31`–`B45`, y así consecutivamente.
   - **El orden de surtido es el orden numérico** (`B01` → `B99`): la secuencia de recorrido de
     §4.1 es el propio número, no un dato aparte que haya que capturar. Se guarda igual como columna
     (`pick_sequence`) para poder corregirla si algún tramo se recorre distinto.
   - Se conservan `A1`…`B3` para los espacios de espera. ⚠️ **`B1`–`B3` de espera choca de
     vista con `B01`–`B03` de bodega**: en pantalla siempre van con su tipo ("Espera B1" /
     "Bodega B01"), y conviene confirmar si la espera puede renombrarse (`E1`…).
   - Carretas `C52`, estibas por unidad.
5. **Reposición de anaquel = tarea del anaquelista** (amplía WMS.7 al piso de venta): bodega →
   anaquel cuando la exhibición baja del mínimo. Se liga a la lista de faltantes de piso (Fase FLT)
   y a los planogramas de Trade (`trade.planogram_skus`): la ubicación de exhibición se toma del
   planograma donde exista, no se captura dos veces.
6. **Piloto: PH**, igual que GP.

### 12.3 Lo que esto contesta de §6 y §8

- **§6.2 (autoridad en la salida):** resuelta por **ADR-084**: el pedido sigue en Kepler; la Suite
  lleva el trabajo de piso y **no escribe en Kepler**; se le captura una vez el resultado.
- **§6.3 (de dónde viene la demanda de salida):** del **pedido Kepler `U-D-40`**, que cubre
  sucursal (incluye tiendas, rutas y reparto directo) y telemarketing: 1,823 + 2,164 pedidos en 60
  días. No de `commercial.orders`.
- **WMS.5 / WMS.6 se implementan como GP.3 / GP.4** sobre ese origen. No se construyen dos veces.
- **WMS.3 se destraba en parte:** la numeración física existe; falta recibir el croquis o la lista
  de PH para levantar el censo.
- **§6.1 (granel por peso): contestada.** Todo se empaca; el surtidor cuenta paquetes; los productos
  que se venden por kilo se pesan sólo en la báscula de cajas.

### 12.4 Preguntas abiertas

| # | Pregunta | Bloquea |
|---|---|---|
| ~~U1~~ | ✅ `B01`–`B99` bodega, `T01`–`T99` tienda; pasillos de 15 secciones; hay pasillos superiores | — |
| ~~U2~~ | ✅ Por el momento no hay zonas especiales | — |
| U4 | Después de "pasillo superior 1" (`B31`–`B45`), ¿`B46`–`B60` es pasillo 3 de planta baja o superior 2? ¿Cuántos pasillos hay arriba y abajo en PH? | Censo (WMS.3) |
| U5 | ¿La tienda también va en bloques de 15 por pasillo (`T01`–`T15`…)? ¿Cuántas secciones `T` tiene PH? | Censo (WMS.3) |
| ~~U6~~ | ✅ Sí se renombran: espacios de espera de checado y embarque = `E01`, `E02`… | — |
| U7 | PH tiene 4 pasillos en planta baja y 4 en planta alta, pero "superior 1 = `B31`–`B45`" y 8 × 15 = 120 > 99 no cuadran: falta la tabla de rangos por pasillo (bodega y tienda) | Censo (WMS.3) |
| U8 | Los 160 renglones de pedido con peso decimal: ¿dónde se pesan si la báscula está sólo en cajas? | Checado (GP.4) |
| U3 | ¿Cómo sabe hoy el anaquelista qué subir? (recorrido, lista, a ojo) | Reposición (WMS.7) |
