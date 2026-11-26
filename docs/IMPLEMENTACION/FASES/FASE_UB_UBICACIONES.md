# Fase UB — Ubicación de mercancía (almacén y tienda)

> **Estado**: 🔨 PLANEADA 2026-10-08 — ADR-090 propuesto (enmienda ADR-087). Sin código.
> **Dueño de negocio**: Francisco. **Piloto**: PH.
> **Absorbe** de [`FASE_WMS`](FASE_WMS.md) §12: WMS.2 (tipos de zona), WMS.3 (censo y etiquetas), WMS.3b (asignación), WMS.4 (secuencia de recorrido) y WMS.7 (reposición). Alimenta a [`FASE_GP`](FASE_GP_GESTION_PEDIDOS_ALMACEN.md) (hoja de surtido por recorrido y reparto por pasillos, §5.1).

---

## 0. Qué es y qué no es

Kepler no gestiona ubicaciones: los 11,816 productos tienen `Z000`. La Suite se vuelve **dueña de la ubicación** y Kepler sigue siendo **dueño de la cantidad** (ADR-044, ADR-086). En la operación, el módulo responde a cinco preguntas:

1. **¿Dónde va este producto?** Su posición fija de surtido, su posición en tienda y sus reservas.
2. **¿Dónde quedó lo que no cupo?** El excedente en reserva, con cantidad y fecha de entrada.
3. **¿Qué bajo primero?** La rotación PEPS.
4. **¿Qué ubicaciones existen y en qué estado están?** El catálogo y su mantenimiento.
5. **¿Cómo lo cargo rápido?** La captura masiva.

**No es:** un segundo inventario. La existencia total la sigue diciendo Kepler, y la Suite **no escribe en Kepler** (ADR-086).

---

## 1. Decisiones de Francisco (2026-10-06 → 2026-10-08)

| # | Decisión | Fecha |
|---|---|---|
| D1 | Bodega y tienda son **zonas del mismo almacén**, no dos almacenes (Kepler lleva una sola existencia) | 2026-10-06 (ADR-087) |
| D2 | **Código de 5 caracteres**: zona `T`/`B` + pasillo (letra) + rack (2 dígitos) + nivel (1 dígito) | 2026-10-08 |
| D3 | El pasillo puede ser **cualquier letra**: hay sucursales con más de 4 pasillos | 2026-10-08 |
| D4 | El nivel va **de 1 a 6** | 2026-10-08 |
| D5 | **Cantidad por ubicación sólo en las reservas** (excedente). La posición de surtido no lleva cantidad | 2026-10-08 (enmienda ADR-087 §3) |
| D6 | **Rotación por fecha de entrada (PEPS)** | 2026-10-08 |
| D7 | Reparto de roles del §4 aprobado | 2026-10-08 |
| D8 | Carretas `C`, espacios de espera `E` y estibas: misma tabla, otra familia de código | 2026-10-06 |
| D9 | Piloto en PH | 2026-10-06 |
| D11 | **Sin Ñ en el pasillo.** El escáner del Andén y el código de barras del cartel (CODE128) sólo leen ASCII: una `BÑ053` se podía dar de alta pero nunca escanear. Si un almacén tiene pasillo Ñ, se le asigna otra letra | 2026-10-08 (revisión del PR UB.0–UB.1) |
| D10 | **La ubicación guarda producto + PRESENTACIÓN** (caja, paquete, pieza). El mismo Mazapán De la Rosa puede estar en caja en `BA053`, en paquete en `BA052`, en paquete en tienda `TA021` y en caja en el rack superior de tienda `TA024`. Cada presentación tiene su propio lugar fijo, su mínimo/máximo y su reserva | 2026-10-08 |

> ⚠️ **Interpretación de D6, por confirmar.** La regla es PEPS por fecha de entrada **para todos los productos**. Si una reserva más nueva caduca **antes** que la más vieja, el sistema **avisa**, pero no reordena. Si Francisco quiere que la caducidad mande en ese caso (FEFO), es un cambio de una línea en UB.6.

---

## 2. El código de ubicación

```
B  A  05  3
│  │  │   └─ nivel dentro del rack: 1–6
│  │  └───── rack: 01–99
│  └──────── pasillo: A–Z (sin Ñ, ver D11)
└─────────── zona general: T = tienda · B = bodega
```

- **Validación**: `^[TB][A-Z](0[1-9]|[1-9][0-9])[1-6]$`. Lo que no cumpla se rechaza **con su motivo**, en pantalla y en captura masiva.
- **Se guarda en partes**: `zona`, `pasillo`, `rack`, `nivel`, cada una en su columna. El código es la concatenación, nunca se teclea suelto contra la base. Así no hay `BA5 3` contra `BA053`.
- ⭐ **Un pasillo es un CORREDOR con dos frentes** (Edgar, 2026-11-25), y el frente **no se escribe en el código: se deduce del número de rack** — los nones de un lado y los pares del otro, como las calles. Los dos frentes son parejos, así que el rack `n` queda enfrente del `n + 1`. Por qué derivarlo: un dato que alguien captura se puede capturar mal y nadie lo nota; uno que sale del número, no. Y así el código sigue teniendo 5 caracteres, con el mismo CHECK, el mismo `normalizeBinCode` del escáner y el mismo ancho de CODE128 en la etiqueta. Se descartaron **el carácter de lado** (`BA05I3`: rompe el formato, el CHECK, el escáner y las etiquetas ya calibradas) y **dos letras por corredor** (obliga a declarar y mantener qué letras son el mismo pasillo, y el nombre del sistema deja de parecerse al letrero).
- **Orden de recorrido** (hoja de surtido): zona → pasillo → **el pasillo en serpentina** → nivel: se baja por el frente de los nones (01, 03, 05…) y se vuelve por el de los pares (…, 06, 04, 02). El orden lineal de antes obligaba a cruzar el corredor una vez por rack: 24 cruces en un pasillo de 25. Se puede corregir por ubicación (`pick_sequence`) cuando el recorrido físico no sigue el alfabeto.
- **Sin posición dentro del nivel**: varios productos comparten `BA053`. El producto se identifica por su etiqueta, y la ubicación dice dónde buscar.
- **Otras familias** (D8), con prefijo propio que no choca con `T`/`B`: carretas `C01`–`C99`, espacios de espera `E01`…, contenedores de plástico `K01`… y estibas por vehículo. Comparten tabla y estados, pero no siguen la regla de 5 caracteres.
- ⚠️ **Cambio obligado en el código actual**: `apps/view/.../almacen/shared/tipo-ubicacion.ts` deduce "tarima" de una `T` inicial. Con D2, la `T` es **tienda**. El tipo pasa a una **columna**, no se deduce del nombre.

### 2.1 Lo que trae Wincaja (propuesta de censo, no dato)

Wincaja `10` (PH) tenía ubicación en **1,119 de 2,966 productos (38 %)**, congelada desde el 2026-07-30: 893 con forma `BC110` y 226 con forma `A001`.

- Leída con D2, `BC110` da **nivel 0, que no existe**.
- `A001` no tiene 5 caracteres.

Ninguna se convierte sola. **UB.3 mide primero** cuántas encajan en la regla tal cual, cuántas encajan con una regla de conversión que Francisco valide, y cuántas no encajan. Las que no encajan salen en el censo como **"por revisar"**. La lectura es una vista sobre `wincaja.existencias`, nunca un importador.

---

## 3. Modelo de datos

Las tablas que ya existen se **extienden**. No se crea una tabla paralela de ubicaciones (regla "nunca copias de tablas").

| Capa | Tabla | Estado hoy | Cambio |
|---|---|---|---|
| 1. Ubicación física | `commercial.warehouse_bins` (WMS-REC) | 1 fila | + `familia` (`ubicacion`/`carreta`/`espera`/`contenedor`/`estiba`), `zona` (`T`/`B`), `pasillo`, `rack`, `nivel`, `tipo_zona` (`surtido`/`reserva`/`tienda_piso`/`tienda_cabecera`/`recepcion`/`cuarentena`/`merma`), `pick_sequence`, `estado` (`activa`/`bloqueada`/`baja`), `motivo_estado`, audit. Único por (tenant, almacén, código) |
| 1. Pasillo | `commercial.warehouse_aisles` (Fase PA) | 4 filas (PH) | Se liga por letra de pasillo. El conteo por pasillo sigue usándolo |
| 2. Asignación | **`commercial.bin_assignments`** (nueva) | — | producto × **presentación** × almacén × ubicación × **papel** (`surtido_fijo` · `exhibicion_tienda` · `reserva_preferida`) + mínimo/máximo **en esa presentación**. Un solo `surtido_fijo` por producto × presentación × almacén × zona. **Sin cantidad** |
| 3. Cantidad | `commercial.stock_lot_locations` (WMS-REC) | 1 fila | **Sólo en ubicaciones de reserva** (D5). + **`presentacion`** + cantidad en esa presentación + **`entered_at`** (fecha en que entró a esa reserva, no se sobrescribe) |
| Bitácora | **`commercial.bin_history`** (nueva) | — | quién, cuándo, acción, valor anterior → nuevo, motivo, `batch_id` (captura masiva) |
| Tareas | **`commercial.location_tasks`** (nueva) | — | reposición / reacomodo: producto, de → a, orden PEPS, estado, quién la hizo. Es el primer uso de la cola WMS.8 |

Todas las tablas nuevas llevan `tenant_id` + audit + RLS forzado. Las migraciones se **generan** con `node scripts/nueva-migracion.js` y son idempotentes.

### 3.0 La presentación (D10)

**De dónde sale.** De la **escalera de unidades de Kepler de ESA sucursal** (`kepler_ods.kdii`). Peldaño 1 = base (`c11`, normalmente pieza), peldaño 2 = intermedio (`c80`, factor `c81`), peldaño 3 = mayor (`c83`, factor `c84`). Los factores están en unidades base. **No se teclea un factor a mano** y no se usa la moda entre sucursales: el factor de una plaza puede ser distinto al de otra, y el bueno es el de la fila de esa sucursal (lección VA.7 del verificador). Se guarda `presentacion` = peldaño (1/2/3) más una foto del rótulo (`CAJA`, `PAQ`, `PZA`) para que la etiqueta se lea aunque Kepler cambie el nombre.

**Cómo se usa.**
- **Asignación.** Cada presentación tiene su propio lugar fijo, con mínimo y máximo **en esa presentación**: "BA053 · Mazapán De la Rosa · **CAJA** · mín 4 · máx 12 cajas".
- **Etiqueta y pantalla.** Siempre dicen la presentación con letra grande. Dos renglones del mismo producto en una ubicación son dos cosas distintas.
- **Acomodo y censo.** El código de barras ya distingue la caja del paquete (Kepler guarda un código por peldaño, [GP.4.1]). Al escanear, el sistema sabe qué presentación es y la manda a **su** lugar. Si el código no la distingue, la pregunta en pantalla.
- **Surtido (GP).** Un renglón pedido en cajas se surte del lugar de cajas; uno pedido en paquetes, del lugar de paquetes.
- **Reposición con desempaque.** Si el lugar de paquetes está bajo y sólo hay reserva en cajas, la tarea dice "**abre 1 caja (= 12 paquetes)** y acomódalos en TA021". Abrir una caja no cambia la existencia de Kepler (en base es lo mismo), pero sí cambia la cantidad en la reserva: −1 caja.
- **Estimado §3.2.** Las cantidades de las reservas se convierten a base con el factor de la sucursal antes de restarlas a Kepler. **Si la presentación no tiene factor** (peldaño vacío o factor ≤ 1), el estimado se publica como **"no medido"** con su motivo, nunca como 0 (ADR-056 / ADR-057).

### 3.0.1 Lo medido al construir UB.3a (prod, PH, 2026-10-10)

- **La escalera por sucursal ya existía:** `analytics.v_kepler_unit_ladder` (grano sucursal × sku, factor capturado o derivado del costo, `peldano_caja`). Los **códigos de barras** por peldaño se leen de la ficha `kdii` de la misma sucursal (base `c7/c93/c102`, dos `c82/c95/c96`, tres `c85` + `C`+sku), igual que el checado de GP.4.
- **Rendimiento:** con sucursal y SKU como VALORES la escalera de un producto sale en **4–12 ms**; uniéndola desde `catalog.products` tardaba **~4 s** (el filtro no llegaba al índice). La lista de productos de PH (9,028 con ficha) sale en **20–56 ms** con o sin búsqueda.
- **Peldaños fantasma:** **2,661 de 9,656** fichas de PH traen un peldaño SIN factor que REPITE el rótulo de otro (p. ej. 70243: PAQ · PAQ · CJA ×20). No se ofrecen. Sólo **17** traen uno sin factor con rótulo PROPIO: se ofrecen, marcados «sin factor» (se asignan, pero no convierten cantidades).
- **El factor NO se copia** en `bin_assignments`: se guarda el número de peldaño y una foto del rótulo; el factor se lee vivo de Kepler.

### 3.1 Por qué `entered_at` va en la reserva y no en el lote

`commercial.stock_lots.received_at` **no sirve como fecha de entrada**: se pisa con `now()` en cada upsert (`commercial-inventory.service.ts` l.282-286 y l.402-406; `commercial-expiry-reviews.service.ts` l.606-610), y los lotes `NA` se funden en uno. Si PEPS se apoyara en eso, sería **falso sin dar error**. Cada acomodo en reserva crea su propia fila con su `entered_at`, y PEPS ordena esas filas. Arreglar `received_at` queda como deuda con nombre (**[UB.D1]**), porque lo usan otras pantallas.

### 3.2 Cuánto hay en la posición de surtido (sin contarla)

La posición de surtido no lleva cantidad (D5), pero la reposición necesita saber si está baja. Se **estima**:

> en surtido + tienda ≈ existencia Kepler − Σ reservas con cantidad

La cifra se publica como `estimado: true`, nunca como medida (ADR-056). Además dispara la tarea:
- el **escaneo del hueco** por el anaquelista (U3);
- un **faltante de FLT** en ese producto.

---

## 4. Dónde se instala y quién lo tiene

**Espacio** Almacenes y Logística › **proyecto** Almacén › **módulo nuevo "Ubicaciones"** en `authz-tree.ts`, con su propia pestaña (área) en `almacen-tabs.ts`. La pantalla actual `/almacen/inventory/ubicaciones` se mueve a este módulo y deja de colgar de `COMMERCIAL_INVENTORY_*`.

| Pantalla | Ruta | Permiso |
|---|---|---|
| Mapa / catálogo | `/almacen/ubicaciones` | VER |
| Asignación por producto | `/almacen/ubicaciones/asignacion` | GESTIONAR |
| Captura masiva | `/almacen/ubicaciones/captura` | GESTIONAR |
| Excedente (reservas con cantidad) | `/almacen/ubicaciones/excedente` | VER; acomodar = ACOMODAR |
| Rotación / tareas | `/almacen/ubicaciones/rotacion` | ACOMODAR |
| Mantenimiento | `/almacen/ubicaciones/mantenimiento` | GESTIONAR |
| Acomodo en celular (escaneo) | `/almacen/ubicaciones/acomodo` | ACOMODAR |

### 4.1 Permisos nuevos

| Clave | Qué deja hacer |
|---|---|
| `ALMACEN_UBICACIONES_VER` | Consultar dónde está cada producto |
| `ALMACEN_UBICACIONES_ACOMODAR` | Escanear al acomodar, mover entre ubicaciones, registrar excedente, cumplir tareas |
| `ALMACEN_UBICACIONES_GESTIONAR` | Catálogo, captura masiva, asignación fija, mantenimiento, bajas |

**Por qué no reusar `COMMERCIAL_INVENTORY_ASIGNAR`**: esa clave arma los equipos de conteo. Si se reusa, quien arma equipos también recodifica ubicaciones.

### 4.2 Reparto desde el origen (D7)

Va en la **misma entrega** que crea las claves. Lección [LC.6.2]: un módulo no está entregado hasta que su permiso está **repartido en prod**.

| Rol | Personas (MATRIZ_ACCESOS 2026-10-06) | VER | ACOMODAR | GESTIONAR | Alcance |
|---|---|:-:|:-:|:-:|---|
| `encargado_tienda` | 7 | ✅ | ✅ | ✅ | **su sucursal** (`ScopeService`, `warehouse:own`) |
| `encargado_bodega` | 1 | ✅ | ✅ | ✅ | su almacén |
| `supervisor` (inventarios) | 1 | ✅ | ✅ | ✅ | todas |
| `almacenista` | 6 | ✅ | ✅ | — | su almacén |
| `auxiliar_tienda` | 5 | ✅ | ✅ | — | su sucursal |
| `piso_tienda` | 0 | ✅ | ✅ | — | su sucursal |
| `compras`, `gerente_compras`, `telemarketing`, `facturacion`, coordinación de embarques, `prevencion`, `direccion` | — | ✅ | — | — | todas |

- Los nombres exactos de rol de facturación y coordinación de embarques se **verifican contra prod** en UB.0, antes de escribir la migración.
- `marketing`, que hoy tiene permisos amplios en Almacén, **no** recibe Ubicaciones.
- La migración deriva del estado vivo y usa `jsonb_set`. **No** usa `-> 'KEY' IS NULL`, que es no-op cuando la clave ya viene en `false` (residuo de `/admin/roles`).

### 4.3 Huecos de puesto (no de código)

- **[UB.P1]** La única persona con puesto de anaquelista tiene rol `repartidor`, así que no vería el módulo.
- **[UB.P2]** Los puestos de almacén del CEDIS están "sin definir" y con 0 personas.
- **[UB.P3]** Las sucursales 04 y 08 no tienen encargado de tienda (mismo hueco que [IC.23]).

---

## 5. Captura masiva

Tres caminos. Los tres pasan por **vista previa → confirmar**, escriben en la bitácora con un `batch_id` y se pueden deshacer por lote.

1. **Generar por rango.** Se elige zona, pasillos, racks y niveles; por ejemplo, `B`, `A–D`, `01–15`, `1–3` crea 180 ubicaciones. La vista previa muestra cuántas son nuevas, cuántas ya existían (se dejan como están) y cuántas están dadas de baja (se ofrecen para reactivar).
2. **Archivo Excel/CSV.** En `[UB.2]` da de alta **ubicaciones** (columnas Código, Tipo, Nombre; plantilla descargable). La versión **producto → presentación → ubicación → papel** llega con `[UB.3]`, porque necesita la tabla de asignación. Cada renglón se valida (código bien formado, ubicación activa, producto existente, presentación que exista en la escalera de Kepler de esa sucursal, un solo `surtido_fijo` por presentación). Se ve bueno, duplicado y con error, y **lo guardado sale de la lista** (patrón de captura por lote PC.8 / RE.35.7). Es dato que captura nuestra gente (HITL), no un importador de otro sistema.
3. **Censo en celular por recorrido.** Se escanea la ubicación y después cada producto. La propuesta de Wincaja viene precargada para confirmar o corregir (§2.1).

**Etiquetas**: la impresión por lote sale de la misma pantalla (código grande + código de barras/QR). La etiqueta de tienda se distingue de la de bodega por la letra **y** por el color (U10).

---

## 6. Excedente y rotación PEPS

**Acomodo del excedente.**
1. Llega mercancía.
2. Se acomoda en la posición de surtido hasta su **máximo**.
3. Lo que sobra se escanea **producto → ubicación de reserva**, con cantidad.
4. El sistema sugiere primero la `reserva_preferida` del producto y, si no hay, la reserva **activa** más cercana en el recorrido.
5. Cada acomodo es una fila con su `entered_at`.

**Rotación.**
1. Cuando la posición de surtido está baja (§3.2), se crea una tarea: *"repón 12345 en BA053: baja de BC021 (entró 2026-09-14) antes que BD072 (entró 2026-10-01)"*.
2. Al cumplirla, quien la hace escanea origen y destino.
3. La cantidad de la reserva baja; si llega a 0, la fila se cierra y la reserva queda libre.

**Aviso de caducidad** (D6): si la reserva más nueva caduca antes que la más vieja, la tarea lo marca ⚠️ y no cambia el orden.

**Lo que se declara**: un producto sin `surtido_fijo` no genera tareas y aparece en un bloque **"sin ubicación"**, igual que en la hoja de surtido de GP (§5.1). No se esconde.

---

## 7. Mantenimiento

| Acción | Regla |
|---|---|
| **Bloquear** (dañada, reparación, limpieza, inventario) | Exige motivo. Mientras está bloqueada no se sugiere para acomodo ni surtido. Lo que tenga sigue visible |
| **Dar de baja** | Sólo si **no tiene** asignación ni cantidad: primero se reubica. Nunca se borra (`estado = baja`, con historial) |
| **Reactivar** | Desde baja o bloqueo, con motivo |
| **Renombrar / recodificar** | Valida el formato y que el código nuevo esté libre. Las asignaciones y cantidades se mueven con ella |
| **Mover contenido** | Todo el contenido de una ubicación a otra, en una sola operación con bitácora |
| **Fusionar** | Dos ubicaciones en una: mover contenido + baja de la vacía |
| **Reimprimir etiqueta** | Individual o por lote |

Toda acción queda en `bin_history` con valor anterior → nuevo y motivo. Las bajas y recodificaciones exigen GESTIONAR.

---

## 8. Sprints

| Sprint | Entrega | Depende de |
|---|---|---|
| **UB.0** | ADR-090 + claves de permiso en enum/`authz-tree` + **migración de reparto** + roles verificados contra prod | — |
| **UB.1** | Catálogo: columnas de capa 1, validación de código, estados, `pick_sequence`, `tipo-ubicacion` por columna, pantalla Mapa | UB.0 |
| **UB.2** | Captura masiva: generar por rango + Excel/CSV + etiquetas + deshacer por lote | UB.1 |
| **UB.3a** | `bin_assignments` por presentación + pantalla de asignación + Excel producto → presentación → ubicación | UB.1 |
| **UB.3b** | Medición de Wincaja (§2.1) + censo en celular | UB.3a |
| **UB.4** | Mantenimiento + `bin_history` | UB.1 |
| **UB.5** | Cantidad sólo en reservas + `entered_at` + acomodo en celular + pantalla Excedente | UB.3 |
| **UB.6** | `location_tasks` + estimado §3.2 + tareas de rotación PEPS + aviso de caducidad | UB.5 |
| **UB.7** | GP: hoja de surtido por recorrido + reparto de pedido grande por rango de pasillos | UB.3 |
| **UB.8** | Piloto PH: censo completo, etiquetado, dos semanas de uso. Mide cobertura (productos con `surtido_fijo` / productos con venta) y tareas cumplidas | UB.2–UB.6 |

**Ruta crítica**: UB.0 → UB.1 → UB.3 → UB.8. El censo es trabajo de piso, no de software (igual que SU.0 en ADR-067): sin el croquis o la lista de pasillos de PH ([GP.P4]), UB.8 no arranca.

---

### 8.1 Censo con lector y carteles (2026-11-17, pedido de Edgar) 🧪

Lo pidió Edgar al recorrer la captura con él: *«que se pueda leer con el código de barras»* y *«a la
hora de capturar la ubicación, también asignar ya el producto que está ahí»*, y *«que se puedan
imprimir una o muchas hojas con el código»*. Es el camino 3 de §5, primero en escritorio con lector.

- **Asignación › Escanear** (`?vista=escanear`). Hay un solo campo, y lo que tiene forma de ubicación
  cambia la ubicación de trabajo. Lo demás se busca como producto, por código de barras, clave o
  nombre.
  - La **presentación** sale del código de barras de la ficha de Kepler de la sucursal (D10). Si no
    se puede saber, se pregunta con un botón por presentación.
  - El **papel** sale de la ubicación: bodega de surtido → lugar fijo; bodega de reserva → reserva
    preferida; tienda → exhibición. Recepción, cuarentena y merma no reciben productos.
  - Una ubicación que no existe **se da de alta en el acto**: bodega como surtido, tienda como piso.
  - Si el producto ya tiene lugar fijo o reserva en otra ubicación, se ofrece **moverlo**; no se crea
    un segundo.
  - Las lecturas rápidas esperan en fila.
- **El buscador de Asignación** abre solo un resultado único. Si lo buscado fue el código de barras
  de una presentación, abre su asignación con el campo de ubicación listo.
- **Carteles** (Mapa › «Imprimir carteles»): por zona o pasillo, y desde cada rack para sus niveles o
  uno solo. Es el cartel que ya existía (`anden-cartel`): dos por hoja carta. Cubre la parte de
  «reimprimir etiqueta» de UB.4.
- **No usa endpoints nuevos.** Sólo los que ya existían: lista de ubicaciones, búsqueda (que encuentra
  por código de barras desde [BU.4.2]), detalle, asignar, mover, quitar y dar de alta.
- **Pendiente de UB.3b:** el censo **en celular con la cámara** (hoy es con lector o teclado) y la
  medición de la propuesta de Wincaja (§2.1).

### 8.2 Asignación, rehecha desde cero (UB.RF.11, 2026-11-19) — maqueta para aprobar

**Lo que la motivó.** El 2026-11-19 una persona de Padre Hidalgo preguntó por WhatsApp por qué un
producto seguía «sin lugar fijo» si ya le había dado ubicación. Edgar: *«eso es señal de mejorar la
interfaz; generémosla desde 0, práctica y lo más accesible para el usuario»*. Medido en prod (sólo
lectura) ese día:

- Lo que asignó **sí se guardó**: 8 productos con «Exhibición en tienda» en TA011, de 15:30 a 15:37.
  Pero la pantalla llama «lugar fijo» **sólo** al lugar de surtido en bodega, y lo dice con «0 % ya
  ubicado»: afirma que nada tiene lugar cuando 8 lo tienen en tienda (ley 0 del estándar).
- **En Padre Hidalgo no se podía dar ningún lugar fijo**: sus 8 ubicaciones (creadas ese día) son
  todas de tienda (TA011–TA024). El camino a mano manda «dala de alta primero» a otra pestaña; sólo el
  modo Escanear la crea en el acto, y vive escondido como «otra vista».
- En el formulario, el aviso rojo sale **antes de escribir** y el ejemplo «BA053» del campo parece un
  valor ya capturado (lo que se ve en la captura de WhatsApp).
- Ese día hubo 17 intentos de asignar y **6 rechazados**, todos del supervisor. **El motivo NO se
  registra en ningún lado** (como Surtir antes de GP.RF.23): NO MEDIDO.
- Se usa sobre todo en celular (8 persona-días contra 4 en computadora, 30 días). La única medición
  de estabilidad de Asignación dio CLS 0.603 (malo); el Mapa, 0.242 en el 75 % de las cargas.
- **Universo que importa:** 4,058 productos se vendieron en PH en 90 días (de 9,028 con ficha). Los
  500 más vendidos son el **71.5 %** de la venta. Hoy la lista va por nombre.

**Las cinco preguntas (`diseno` §0b), por escrito:**

| # | Pregunta | Respuesta |
|---|---|---|
| 1 | ¿Qué ve al entrar y en qué orden? | Un solo campo arriba, **«Escanea o escribe un producto o una ubicación»** (lector, cámara o teclado). Debajo, la cola **«Por ubicar»: lo que más se vende primero**. Cada tarjeta dice **dónde está, en palabras y por presentación**: «PAQ · Tienda TA011 · Bodega: falta» |
| 2 | ¿Qué NO ve? | Las tres cifras de arriba (las reemplaza una línea con rótulos verdaderos: «0 con lugar para surtir · 8 en tienda · de 4,058 que se venden»). El selector de **papel** (sale de la ubicación: B de surtido → lugar fijo, T → tienda, como Escanear). Mín./máx. de entrada (queda a un toque, D5). Excel (pasa a «Más»). El «Productos en Kepler 9,028», que no decide nada |
| 3 | ¿Qué accesibilidad necesita? | Una mano y un pulgar: objetivos de 44 px o más, tarjeta completa como botón. Rótulo visible en el campo (no sólo el ejemplo). El error **después** de intentar, en palabras y con la salida («BA053 no existe en Padre Hidalgo · **Crear y asignar**»). Cada guardado se confirma en la fila y con `aria-live`, con **Deshacer**. Nada sólo por color. «Atrás» del celular regresa a la lista (como Surtir, GP.RF.38). Sin brincos al cargar |
| 4 | ¿Está ligada a otro proceso? | Sí. El lugar fijo es lo que Surtir enseña en cada renglón («Ubicación BC110») y el orden del recorrido. La ubicación nace aquí si no existe (alta de UB.1/UB.2) y su cartel se imprime en el Mapa (UB.RF.10): desde la confirmación, «Imprimir su cartel» |
| 5 | ¿Le toca a esta pantalla? | Sí: «dónde vive cada producto». **Escanear deja de ser otra vista**: es el campo de arriba. El alta en bloque (por rango, Excel) sigue en el Mapa; aquí sólo se crea la ubicación que se está asignando |

**La maqueta (celular, 390 px):**

```
LISTA                                   PRODUCTO (al tocar o escanear uno)
┌──────────────────────────────────┐    ┌──────────────────────────────────┐
│ Ubicar productos  Padre Hidalgo ▾│    │ ← Por ubicar                     │
│ Producto o ubicación              │    │ BUBBALOO TUTI-FRUTI 239.7GR/47   │
│ ┌──────────────────────────────┐ │    │ 02009 · 1 CJA = 32 PAQ           │
│ │ ▣ Escanea o escribe…         │ │    │                                  │
│ └──────────────────────────────┘ │    │ PAQ                              │
│ ⚠ Padre Hidalgo no tiene         │    │  Tienda   TA011         Quitar   │
│   ubicaciones de bodega. Escanea │    │  Bodega   falta                  │
│   o escribe una (B…) y se crea   │    │ ┌──────────────────────────────┐ │
│   al asignarla.                  │    │ │ ▣ Ubicación de bodega del PAQ│ │
│                                  │    │ └──────────────────────────────┘ │
│ Por ubicar · lo más vendido      │    │ CJA (32 PAQ)                     │
│ 0 para surtir · 8 en tienda ·    │    │  Bodega   falta   [Poner lugar]  │
│ de 4,058 que se venden           │    │                                  │
│ ┌──────────────────────────────┐ │    │ Mínimo y máximo (opcional)  ›    │
│ │ BUBBALOO TUTI-FRUTI 239.7GR ›│ │    ├──────────────────────────────────┤
│ │ 02009 · PAQ                  │ │    │ SI LA UBICACIÓN NO EXISTE        │
│ │ Tienda TA011 · Bodega: falta │ │    │ BA053 no existe en Padre Hidalgo │
│ └──────────────────────────────┘ │    │ [ Crear BA053 y asignar ] Cancelar│
│ ┌──────────────────────────────┐ │    ├──────────────────────────────────┤
│ │ MAZAPAN DE LA ROSA 30PZ     ›│ │    │ AL GUARDAR                       │
│ │ 02146 · CJA = 30 PZA         │ │    │ ✓ PAQ en bodega BA053            │
│ │ Tienda: falta · Bodega: falta│ │    │   Deshacer · Imprimir su cartel  │
│ └──────────────────────────────┘ │    └──────────────────────────────────┘
│ Más ▾ (Excel · Mapa)             │
└──────────────────────────────────┘
```

- **Escanear una ubicación primero** (el censo de §8.1) sigue igual con el mismo campo. Fija «Aquí:
  BA053 · bodega» y cada producto que se lea queda asignado ahí.
- **Lo que cambia contra hoy:** un campo en vez de tres caminos (lista, Escanear, Excel); el papel ya
  no se elige; la ubicación que falta se crea en el acto; las cifras dicen lo que cuentan; la cola
  va por venta. Cada rechazo deja su motivo en el canal de incidentes (como GP.RF.23).
- **Lo que se conserva:** las presentaciones de la escalera de Kepler de la sucursal (D10) y el
  motivo cuando no hay presentación; «mover» en vez de duplicar un lugar único; Cambiar, Quitar con
  confirmación, Excel por lote; el almacén compartido con Mapa y Contenido (UB.RF.7).
- **Lo que pide del servidor (C2):** que la lista se ordene por venta de 90 días de la sucursal
  (`analytics.sales_daily`), bajo 500 ms, y que diga cuántas ubicaciones de bodega hay. Lo demás
  usa los endpoints de hoy.
- **Lo que la interfaz NO resuelve:** el censo es trabajo de piso (§8). Con una mano no se recorre
  Padre Hidalgo entero: los 500 más vendidos son la meta razonable del primer recorrido.
- **Criterios de aceptación:**
  - de «escaneo el producto» a «asignado», 2 lecturas y ningún clic si la ubicación existe, y un
    toque más si no existe;
  - 0 rótulos que digan algo distinto de lo que cuentan;
  - objetivos de 44 px o más;
  - CLS < 0.1 en el celular;
  - la lista abre en < 500 ms;
  - el rechazo, con su motivo registrado.

**Construido el 2026-11-19 (🧪)**, con la maqueta aprobada por Edgar (*«toda la información que no
sea de valor hay que almacenarla»*: lo que no decide no se muestra, pero tampoco se tira; queda a
un toque):
- **Servidor (C2):** la lista acepta `orden=venta`.
  - Ordena con `analytics.product_demand`, la venta de 30 días de la sucursal sin mayoreo, ya
    derivada de `sales_daily`. Medido en prod como `app_runtime`: de 160 a 237 ms en cinco
    sucursales.
  - Se descartó sumar `sales_daily` de 90 días: tardaba de 450 a 470 ms en PH y 1.4 s en frío.
    Sus 500 primeros coinciden en 418 con los de 90 días de todos los canales.
  - Una sola consulta da la página y las cifras: con lugar para surtir, en tienda, con venta
    (`null` si la sucursal no tiene venta, nunca 0) y las ubicaciones de bodega.
  - Cada fila trae sus lugares vivos. La consulta que arma knex corrió en prod en 56–95 ms.
  - Prueba de integración contra Postgres real, con su control negativo (una venta en 0 no es
    venta; la de otra sucursal no se mezcla): la corre el CI.
- **Pantalla (C3):** «Ubicar productos» en la misma ruta.
  - El censo con lector (§8.1) es ahora el campo de arriba, ya no otra vista; su componente se
    borró y sus pruebas pasaron a la pantalla.
  - 16 pruebas de pantalla y 6 de la lógica nueva, con negativas. Con el arreglo roto a propósito,
    6 en rojo.
  - Cada rechazo va al canal de incidentes como `ubicar_rechazado`.
  - `check:pantalla`: las 10 reglas.
- **NO MEDIDO:**
  - la pantalla en el navegador (sin validación visual: no hubo sesión de prod);
  - el CLS en el celular, que se lee de la telemetría después de soltar;
  - la cámara del celular como lector (UB.3b).
  - Además, las guías de web moderna no se pudieron consultar: el clasificador de permisos bloqueó
    el comando.

### 8.3 Etiquetas chicas para la tienda (UB.RF.12, 2026-11-19) 🧪

**Lo que lo motivó.** Edgar: *«el problema es para tienda: no podemos poner letreros grandes porque
le quitan visibilidad al producto»*. Pidió etiquetas con código de barras para leerlas al asignar.

**Las cinco preguntas, en corto:**
1. **Qué ve:** la etiqueta con el código grande arriba y su código de barras debajo.
2. **Qué no ve:** el tipo y la fecha que lleva el cartel grande; en la etiqueta no caben ni deciden.
3. **Accesibilidad:** la pistola lee un módulo de 0.36 mm, y la persona lee el código a un paso.
4. **Ligada a:** «Ubicar productos». Leerla ahí es elegir la ubicación (§8.2).
5. **¿Le toca al Mapa?** Sí: es el mismo «Imprimir» de UB.RF.10, con otro tamaño.

**Construido:**
- **Dónde:** en Mapa › Imprimir se elige el tamaño. En **tienda** sale por omisión la **etiqueta
  chica**; en **bodega**, el cartel de media carta de siempre.
- **La etiqueta:** 6.7 × 2.5 cm, 30 por hoja carta de etiquetas adhesivas (3 × 10, tipo 5160), en
  orden de pasillo, rack y nivel, para el canto del anaquel o el poste de la góndola.
  - El código va en letra de 9 mm y el CODE128 a 40 mm de ancho: unos 0.36 mm por módulo, más de
    los 0.25 mm que lee una pistola de mano.
  - En papel normal, la misma hoja sirve de **hoja de códigos** para leer desde una tabla, sin pegar
    nada.
- **Una sola pieza:** es el mismo componente del cartel, con un formato más, y el mismo dibujo de
  CODE128; no hay otro módulo de impresión.

**Medido** (PDF en un navegador sin ventana, con el `@page` y el CSS que el componente imprime,
sacados del fuente):
- 30 etiquetas = 1 hoja; 31 = 2 hojas;
- cada etiqueta 66.67 × 25.40 mm, en su lugar de la plantilla con 0.000 mm de desviación;
- las 31 con su código de barras.

Pruebas: 5 nuevas, que con el arreglo roto dan 2 en rojo.

**NO MEDIDO:**
- que la hoja impresa cuadre con la marca de etiquetas que compren: cada marca varía décimas de
  milímetro, y la nota de la pantalla pide imprimir una de prueba en papel normal y empalmarla;
- que el lector de la tienda la lea, que se prueba con esa misma hoja.

### 8.4 Un producto va en paquete O en caja (UB.RF.13, 2026-11-20) 🧪

**El pedido** (Edgar, 2026-11-20): «en `/almacen/ubicaciones/asignacion` deducimos que debe ser
paquete y caja, y la realidad es que puede ser paquete o caja».

**El defecto** era de la pantalla, no del dato. El servidor ya contaba por producto: «con lugar para
surtir» y «con lugar en tienda» valen si cualquiera de sus presentaciones lo tiene. Pero la ficha del
producto (UB.RF.11) cometía dos errores:
- **Pedía lugares por presentación.** Dibujaba un bloque por presentación, con tienda y bodega cada
  uno. Un producto con PAQ y CJA pedía cuatro lugares, y con su PAQ ya en tienda seguía diciendo
  «Tienda: falta» en el bloque de la CJA.
- **Elegía la presentación por su cuenta.** Al escanear una ubicación sin haber leído el código de
  barras, se iba a «la presentación que todavía no tiene ese lugar». Con el PAQ ya en bodega, una
  segunda ubicación de bodega se asignaba sola a la CJA, aunque la persona quisiera mover el PAQ.

**Medido en prod ese día:** 26 lugares vivos, de 18 productos, todos de tienda y todos en PAQ,
capturados el 19-nov en Padre Hidalgo. Ninguno es de bodega.

**Lo que cambia:**
- La ficha tiene un solo bloque: **Tienda** y **Bodega** del producto, y **Reserva** si tiene.
  - Cada lugar dice en qué presentación está («TA011 PAQ»).
  - «Falta» sale sólo si ninguna presentación tiene ese lugar.
  - Arriba, «Va en PAQ o CJA · 1 CJA = 20 PAQ».
- **«Poner lugar» señala tienda o bodega, ya no una presentación.** Después de escanear la ubicación:
  - si el producto se abrió con el código de barras de una presentación, va a esa;
  - si el producto tiene una sola presentación, va a esa;
  - si no, la pantalla pregunta «¿va en PAQ o CJA?», con un botón por presentación.
- **Sin cambio:**
  - el servidor y su regla de un lugar fijo por presentación: escoger la presentación que ya tiene
    lugar fijo ofrece «Moverlo a…»;
  - la tarjeta de la lista, que ya hablaba por producto.

**Pruebas:**
- 3 nuevas en la pantalla y 3 reescritas en la lógica; almacén queda en 889/889.
- Dos mutantes las ponen en rojo:
  - volver a deducir la CJA tumba 4 pruebas;
  - contar sólo los lugares de la CJA tumba 1.

**NO MEDIDO:** cómo se ve en el celular de piso. Falta una sesión de prod con permiso de gestionar.

### 8.5 Las etiquetas de tienda salen en la TSC TE200, rollo amarillo (UB.RF.14, 2026-11-20) 🧪

**El pedido** (Edgar, 2026-11-20): «las etiquetas deben salir con la TSC 200, etiqueta amarilla».

**Geometría del rollo.** Según Edgar, el rollo amarillo es igual al blanco de checado: 3 etiquetas por
fila, de 32 × 48 mm cada una, 2 mm entre ellas y 100 mm de ancho total. Esas medidas las tomó
Francisco el 2026-10-08 para GP.4. La hoja carta tipo 5160 de §8.3 se retira: nunca se imprimió en piso.

**Cómo se arma.** No hay impresora ni módulo nuevo. La etiqueta usa la etiquetera compartida
(`@megadulces/ui-web`, ADR-056), la misma que ya imprimen el checado y la etiqueta de caja:
- el navegador manda cada fila de 3 como una hoja de 100 × 48 mm con el controlador de Windows;
- la plantilla vive en `apps/view/.../almacen/anden/etiqueta-ubicacion.ts`;
- cada etiqueta lleva arriba el almacén y el rótulo («01 · Tienda · nivel 1»), luego el código grande
  y su CODE128;
- las barras van a 2 puntos por módulo, o sea 0.25 mm a 203 dpi. Con otro ancho, la impresora
  redondea cada barra distinto;
- las barras quedan paralelas al avance del rollo, que es como una térmica directa las imprime más
  nítidas.

**Medido** en PDF, con el `@page` y el CSS reales empaquetados del fuente (esbuild, sin copiarlos):
- 3 etiquetas salen en 1 hoja, 7 en 3 y 31 en 11: una hoja por fila;
- cada hoja mide 99.82 × 48.01 mm, que es la misma hoja del checado;
- cada etiqueta mide 32.00 × 47.60 mm y empieza en 0, 34 y 68 mm de la fila;
- la barra de `TA011` mide 22.50 × 14.00 mm, con zona quieta de 3.25 mm a cada lado dentro del margen
  (4.75 mm al borde de la etiqueta), más de los 2.5 mm que pide el estándar;
- el código más ancho mide 26.99 mm de los 29 mm útiles. A 8 mm medía 28.84 mm y no le quedaba aire,
  así que se bajó a 7.5 mm.

**Pruebas:** 5 en la etiqueta y 3 en el cartel; almacén queda en 894/894. Dos mutantes las ponen en
rojo: quitar el ancho fijo de las barras tumba 1 prueba y volver a la hoja carta tumba 2.

**NO MEDIDO:**
- que el rollo amarillo tenga de verdad la geometría del blanco. Lo dijo Edgar; no se midió;
- la impresión real en la TSC y que la pistola de la tienda la lea;
- si una etiqueta de 48 mm de alto cabe en el canto del anaquel o sobresale.

### 8.6 El mapa dice lo que varía, y lo que no se midió se declara (UB.RF.17, 2026-11-25) 🧪

**De dónde sale:** una auditoría de diseño de `/almacen/ubicaciones` pedida por Edgar. Nivel de
evidencia **B** (prod en sólo lectura) + **C** (fuente); **nivel A, NO MEDIDO**: no hubo pantalla
viva, así que nada de píxeles reales, recorrido con teclado, `forced-colors` ni lector de pantalla.

**Lo que la medición encontró** (prod, 2026-11-25; 535 ubicaciones en 4 almacenes):

| # | Lo que estaba mal | Cuánto costaba |
|---|---|---|
| 1 | El cuadro del mapa pintaba **cuántos niveles** tiene el rack | Es constante dentro de un almacén: los **75 racks de CEDIS tenían los mismos 5 niveles** y los **39 de Padre Hidalgo los mismos 4**. El mapa dibujaba 75 y 39 cuadros idénticos. Lo que sí variaba —**2 de esos 39 racks ya tenían producto asignado**, 29 asignaciones vivas en 21 productos— no se veía por ningún lado |
| 2 | Los 4 KPI contaban **todas** las familias y **ambas** zonas; el mapa recorre una familia y una zona | **Zamora Centro publicaba «3 activas · de 3 dadas de alta» con el mapa vacío**: sus 3 son carretas, y sólo existen detrás de `?vista=carretas` |
| 3 | «Con mercancía · acomodada con escaneo» publicaba **0** | `commercial.stock_lot_locations` tenía **una sola fila en todo prod** (5-oct, 8 Esquinas): el cero era del instrumento, no de la operación. Cero por defecto es indistinguible de cero por desuso |
| 4 | Dos textos mandaban a **«Mantenimiento»** | Esa pantalla es **UB.4**: no tiene ruta, ni tab, ni endpoint. Bloquear, dar de baja, reactivar y recodificar **no se pueden hacer en ninguna parte de la suite** (0 ubicaciones no-activas en prod) |
| 5 | El anillo de foco usaba `--action-ring` | **1.56:1** en claro, **1.52:1** en oscuro, **1.07:1** sobre una celda pintada. `tokens.css:257` dice que ése es el halo de un `box-shadow`; el anillo sólido es `--focus-ring` (5.00 / 5.23). Y el mapa se recorre con flechas: ese anillo es el único indicador de dónde está la persona |
| 6 | «de N dadas de alta» incluía las **dadas de baja** | Latente: hoy no hay ninguna |
| 7 | El dato principal del mapa iba a **10 px** (`--fs-nano`) | El piso del repo es 11 px (`[GP.RF.12]`), citado tres líneas más arriba en el mismo archivo |
| 8 | «Dada de baja» y «sin dar de alta» se distinguían con **1.10:1** y **1.27:1** contra la tarjeta | Por debajo del 3:1 de un objeto que porta información |

**Qué se hizo.**

- **El número del cuadro es ahora «productos con lugar aquí»** (`productosDeRack`), que es el dato que
  varía; los niveles siguen en el detalle del rack, que ya los listaba. Un nivel dado de baja no suma:
  un lugar en una ubicación retirada no es un lugar.
- **Los KPI se cuentan sobre lo que la pantalla muestra**, no sobre el almacén entero: el mapa de la zona
  más la lista de código libre. Si se contaran sólo sobre el mapa, 8 Esquinas diría «0 con mercancía» con
  su única ubicación —de código libre— diciendo «1 con mercancía» tres dedos más abajo.
- **Lo que el mapa no recorre se declara** con su salida al lado: «Este almacén tiene 3 carretas fuera del
  mapa» + «Ver carretas».
- **«Con mercancía» dice «sin medir»** (`state: 'no_medido'`, ADR-056) mientras el acomodo con escaneo no
  haya escrito nada en ese almacén. El testigo nuevo es `renglones_totales`, que cuenta los renglones
  **sin mirar la cantidad**: un renglón en cero sí es medición (el acomodo pasó y la ubicación se vació).
- **La leyenda es viva**: sólo los estados que esa zona tiene. Antes listaba los cinco siempre, y dos de
  ellos no los puede producir nadie todavía. Se le quitó el `aria-hidden`.
- **El número lleva a su lugar de arreglo** (`Q.4`): desde el detalle del rack se abre Asignación con
  `?rack=TA01` —el filtro que el backend ya aceptaba por `[UB.RF.15]`— y la lista filtrada **lo dice**,
  con «Ver todo el almacén» al lado. «Ver los que faltan por ubicar» suelta el rack: con rack puesto y
  filtro «por ubicar» la lista salía siempre vacía y se leería como «ya está todo ubicado».
- **Se quitaron las dos promesas de «Mantenimiento»**, en la pantalla y en el mensaje de la API.
- **Accesibilidad:** `--focus-ring` en el anillo del mapa, 11 px en el número, «baja» con borde sólido y
  guion y «vacío» con borde punteado (7.73:1 los dos, y ya no se distinguen sólo por color).

**Medición antes/después de los KPI** (las dos fórmulas corridas sobre las filas reales de prod):

| Almacén | Antes | Ahora |
|---|---|---|
| CEDIS | 375 activas · 0 con mercancía | 375 en tienda · 0 con producto · **sin medir** |
| Padre Hidalgo | 156 activas · 0 con mercancía | 156 en tienda · **3 con producto** · **sin medir** |
| Zamora Centro | **3 activas** con el mapa vacío | 0 en bodega · **3 carretas fuera del mapa**, con su enlace |
| 8 Esquinas | 1 activa · 1 con mercancía | 0 en bodega · 1 con mercancía · 1 de código libre |

**Compuertas:** `commercial` 21/21 · `view` 36/36 (2 archivos) · `check:templates` verde ·
`check:cifra` 0 nuevas · `check:estilos`: los outlines con `--action-ring` bajan de 37 a **36** (el tope
sigue en 39) · `ngc --noEmit` limpio, **con control negativo**: un `{{ controlNegativoQueNoExiste() }}`
metido a propósito salió como `TS2339` y después se retiró.

**NO MEDIDO:**
- la pantalla viva: píxeles, recorrido real con flechas, `forced-colors`, lector de pantalla, 390 px;
- si el 42 % de rechazos del alta individual (**5 de 12** llamadas en 30 días) es validación o permiso:
  `analytics.ui_usage` no separa el código de 4xx;
- **UB.4 sigue sin existir**: no se puede bloquear, dar de baja, reactivar ni recodificar una ubicación.
  La pantalla ahora lo dice en vez de mandar a una pantalla inexistente, pero el hueco es el mismo.

### 8.7 Un pasillo es un corredor con dos frentes (UB.RF.18, 2026-11-25) 🧪

**El problema, de Edgar:** *«cada pasillo tiene dos frentes que se contraponen, y hoy no se considera
como tal»*. El código `[T|B][pasillo][rack][nivel]` asume una sola cara, y `defaultPickSequence`
ordenaba zona → pasillo → rack → nivel: un recorrido de ida, en una fila.

**Por qué se resuelve HOY** (medido en prod el mismo día): las 531 ubicaciones con formato son tres
rectángulos perfectos (A/B/C × 01–25 en CEDIS, A/B/C × 01–13 en Padre Hidalgo), **sin un solo hueco**:
es un andamio generado por rango, no un censo del almacén. Las 29 asignaciones vivas están en **A01 y
A02**, y no hay mercancía en ninguna. Dentro de un mes, cambiar la convención sería recoger etiquetas
de piso.

**La decisión (Edgar, 2026-11-25): par/non, y los dos frentes son parejos.**

| | Qué cambia | Por qué no |
|---|---|---|
| **Par/non** ✔ | **nada** del código, el CHECK, el escáner ni el CODE128. El lado **se deriva** del número | — |
| Dos letras por corredor | tampoco toca el código, pero hay que declarar y mantener qué letras son el mismo corredor | un dato más que cuidar, y el nombre del sistema deja de parecerse al letrero |
| Un carácter de lado (`BA05I3`) | rompe el formato de 5, el CHECK, `normalizeBinCode` y el ancho del CODE128 ya calibrado | lo paga todo el sistema por un dato derivable |

**Qué se hizo.**

- `rackFace(rack)` y `rackOpuesto(rack)` en `contracts`: el frente y el rack de enfrente salen del
  número. `describeLocationCode` lo dice: «Bodega · pasillo A · **frente de nones** · rack 05 · nivel 3».
- **`defaultPickSequence` pasa a serpentina**: se baja por los nones (01, 03, 05…) y se vuelve por los
  pares (…, 06, 04, 02). El orden lineal obligaba a cruzar el corredor **una vez por rack** — 24 cruces
  en un pasillo de 25. La vuelta por los pares no se mete en el pasillo siguiente (hay prueba negativa).
- **El mapa dibuja el corredor**: un bloque por pasillo, el frente de nones arriba, el de pares abajo y
  la línea del corredor en medio. **Cada frente lleva su propia regleta de números** pegada a su fila
  (arriba en los nones, abajo en los pares), para que nadie tenga que deducir cuál rack es cuál.
- **Cada pasillo usa sólo sus columnas**: uno de 6 racks ya no arrastra las 25 del más largo.
- **Las flechas cruzan el corredor**: arriba y abajo pasan de un frente al otro y al pasillo siguiente;
  el tope de columnas se lee del frente al que se va, así que la flecha ya no deja el foco en una celda
  que no existe.
- **El detalle del rack dice su frente y qué tiene enfrente**: «Frente de nones, enfrente del A06».
- **Migración `20261125131938`**: recalcula `pick_sequence` de las ubicaciones que ya existen, para que
  no convivan dos órdenes.

**Medición antes/después** (prod, sólo lectura): **531 de 531 ubicaciones tenían exactamente la fórmula
vieja — 0 editadas a mano**, así que recalcular no pisa el trabajo de nadie. El WHERE de la migración
alcanza **531 filas y deja fuera 4**: el código libre de 8 Esquinas y las 3 carretas de Zamora Centro,
que no tienen pasillo ni rack. Recorrido del pasillo A de Padre Hidalgo, nivel 1: antes
01→02→03→04→05→06 (cinco cruces del corredor), ahora **01→03→05→06→04→02** (uno solo, en el fondo).

**Compuertas:** `contracts` 54/54 · `view` 43/43 · `check:templates` verde ·
`check:mig-colisiones` sin colisiones · `ngc --noEmit` limpio.

**NO MEDIDO:**
- **el ensayo de la migración con escritura**: la credencial de prod es de sólo lectura (como debe ser),
  así que se verificó su SQL y su alcance con `SELECT`, no ejerciéndola. La corre el CI;
- **que los dos frentes de cada pasillo real sean parejos**: lo dijo Edgar, no se midió en piso. Si un
  frente tiene bastantes menos racks, el mapa los sigue dibujando bien pero «enfrente del 05 está el 06»
  deja de ser cierto en ese pasillo;
- **la pantalla viva**: el dibujo del corredor no se vio en el navegador;
- **el cartel de cabecera de pasillo** («PASILLO A · nones ← · pares →») todavía no se imprime: se
  imprimen las etiquetas de cada ubicación, no el letrero del corredor.

### 8.8 «Los productos no se están almacenando ni mostrando» (UB.RF.19, 2026-11-25) 🧪

**El reporte, de Edgar.** Sí se estaban almacenando. Lo que no había era dónde verlos.

**La traza, medida en prod el mismo día:**

| Hora (MX) | Qué pasó |
|---|---|
| 13:54:37 | asignación guardada en **TA011 · Padre Hidalgo** (exhibición en tienda, PZA), por `viviana_flores` |
| 13:55:40 | segunda asignación, misma ubicación |
| **13:56:39** | **intento de dar de alta `TA011`** → `409`: «Ya existe la ubicación TA011 en ese almacén» |

`POST /assignments` ese día: **2 hits, 0 errores**. 31 asignaciones vivas, en 3 ubicaciones de Padre
Hidalgo: TA011 con **16 productos**, TA012 con 12, TA021 con 3. Un minuto después de guardar dos
productos en TA011, alguien intentó crear TA011: es lo que hace quien no ve lo que acaba de hacer. Los
5 intentos de alta de ese día fallaron los 5, todos por lo mismo.

**Tres causas, las tres de presentación:**

1. **El mapa no mostraba productos** (pintaba niveles, que son constantes): TA011, con 16 productos, se
   veía idéntico a los otros 38 racks. Lo cierra `[UB.RF.17]`.
2. **En Asignación, el producto recién ubicado desaparecía en el acto**: `trasGuardar()` recarga la lista
   con el filtro de entrada —«Por ubicar»—, y el producto acaba de dejar de estarlo. El aviso de éxito
   dura un momento y después no queda rastro: **la señal de que se guardó y la de que no existe eran la
   misma**.
3. **El almacén por defecto es el primero por código**: quien no tiene almacén en su ficha abre en
   **CEDIS, con 375 ubicaciones y 0 productos**, y lee «no hay nada» sobre el almacén equivocado.
   `viviana_flores` es superadmin y su ficha no tiene almacén.

De fondo: **23 productos ubicados de 86,619 del catálogo de Kepler** (0.03 %). En una lista de «Por
ubicar» con decenas de miles de renglones, dos productos más o menos no se notan.

**Qué se hizo.**

- **Todo lo que se ubica entra a la bandeja**, no sólo lo que se ubicó estando parado en esa ubicación,
  y la bandeja **«Acabas de ubicar (N)»** se ve también en la lista, con el código donde quedó cada uno
  y su «Quitar». Antes `hechos` sólo se llenaba con `aqui()` puesto.
- **El alcance trae cuánto trabajo tiene cada almacén** (`ubicaciones` y `con_producto` por almacén, una
  consulta agregada de **8 ms**), y el mapa lo usa para decir: «CEDIS todavía no tiene productos
  ubicados. **Padre Hidalgo** tiene 23», con el botón para cambiarse. Un «no hay nada» sobre el almacén
  equivocado se lee como «se perdió lo que guardé».
- **El almacén va en el título**, no en gris chico al lado: `Ubicaciones · Padre Hidalgo`.

⛔ **Un error que cazó el control de la consulta, no una prueba.** La primera versión de la consulta
agregada usaba `count(*)` sobre un `LEFT JOIN` con las asignaciones, y el join **multiplica la ubicación
por cada producto que tiene**: Padre Hidalgo daba **185 ubicaciones en vez de 156** (sus 3 bins con
asignaciones contaban 32 veces). Salió porque el control exigía 156/23 de antemano. Va con
`count(DISTINCT b.id)`.

**Compuertas:** `view` 51/51 · `commercial` 21/21 · `contracts` 54/54 · `check:templates` verde ·
`ngc --noEmit` limpio · `check:pantalla` sin fallas nuevas. **Con control de mutante:** al devolver la
condición vieja (`if (this.aqui()?.code === u.code)`) se pone roja exactamente la prueba del arreglo, y
sólo ésa.

**NO MEDIDO:**
- **la consulta agregada no tiene prueba automática**: se verificó contra prod con sus dos controles
  (375/0 y 156/23) y su costo, no con un test. Las pruebas con Postgres real las corre el CI;
- **la pantalla viva**: la bandeja y el aviso de almacén no se vieron en el navegador;
- **si el 42 % de rechazos del alta individual** (5 de 12 llamadas en 30 días) es validación o permiso:
  `analytics.ui_usage` no separa el código de 4xx. Los 5 de hoy sí: los cinco fueron «ya existe».

## 9. Preguntas abiertas

| Clave | Pregunta | Bloquea |
|---|---|---|
| U3 | ¿Cómo decide hoy el anaquelista qué subir? Hoy se diseña con escaneo del hueco + FLT | UB.6 |
| U9 | ¿Qué son los códigos `A001` / `I009` / `T020` de Wincaja PH? | UB.3 (sólo la propuesta) |
| U12 | Regla para convertir `BC110` de Wincaja (nivel 0) al formato nuevo, o descartarlo | UB.3 (sólo la propuesta) |
| U13 | Confirmar la interpretación de D6 (PEPS siempre, caducidad sólo avisa) | UB.6 |
| U14 | ¿Las estibas de cada vehículo se codifican por vehículo (`placa-01`…) o por tipo de unidad? ([GP.P2]) | UB.7 / GP.5 |

## 10. Deuda con nombre

- **[UB.D1]** `stock_lots.received_at` se sobrescribe en cada upsert: no es fecha de entrada. UB lo esquiva con `entered_at`; arreglarlo en origen toca 3 servicios.
- **[UB.D2]** La cantidad en la posición de surtido es **estimada** (§3.2) hasta que se escanee también al surtir (capa 3 completa, ADR-087 §3).
