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
| D10 | **La ubicación guarda producto + PRESENTACIÓN** (caja, paquete, pieza). El mismo Mazapán De la Rosa puede estar en caja en `BA053`, en paquete en `BA052`, en paquete en tienda `TA021` y en caja en el rack superior de tienda `TA024`. Cada presentación tiene su propio lugar fijo, su mínimo/máximo y su reserva | 2026-10-08 |

> ⚠️ **Interpretación de D6, por confirmar.** La regla es PEPS por fecha de entrada **para todos los productos**. Si una reserva más nueva caduca **antes** que la más vieja, el sistema **avisa**, pero no reordena. Si Francisco quiere que la caducidad mande en ese caso (FEFO), es un cambio de una línea en UB.6.

---

## 2. El código de ubicación

```
B  A  05  3
│  │  │   └─ nivel dentro del rack: 1–6
│  │  └───── rack: 01–99
│  └──────── pasillo: A–Z (con Ñ, ordenada después de la N)
└─────────── zona general: T = tienda · B = bodega
```

- **Validación**: `^[TB][A-ZÑ](0[1-9]|[1-9][0-9])[1-6]$`. Lo que no cumpla se rechaza **con su motivo**, en pantalla y en captura masiva.
- **Se guarda en partes**: `zona`, `pasillo`, `rack`, `nivel`, cada una en su columna. El código es la concatenación, nunca se teclea suelto contra la base. Así no hay `BA5 3` contra `BA053`.
- **Orden de recorrido** (hoja de surtido): zona → pasillo (N < Ñ < O) → rack → nivel. Se puede corregir por ubicación (`pick_sequence`) cuando el recorrido físico no sigue el alfabeto.
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
2. **Archivo Excel/CSV de producto → presentación → ubicación → papel.** Cada renglón se valida (código bien formado, ubicación activa, producto existente, presentación que exista en la escalera de Kepler de esa sucursal, un solo `surtido_fijo` por presentación). Se ve bueno, duplicado y con error, y **lo guardado sale de la lista** (patrón de captura por lote PC.8 / RE.35.7). Es dato que captura nuestra gente (HITL), no un importador de otro sistema.
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
| **UB.3** | `bin_assignments` + pantalla de asignación + medición de Wincaja (§2.1) + censo en celular | UB.1 |
| **UB.4** | Mantenimiento + `bin_history` | UB.1 |
| **UB.5** | Cantidad sólo en reservas + `entered_at` + acomodo en celular + pantalla Excedente | UB.3 |
| **UB.6** | `location_tasks` + estimado §3.2 + tareas de rotación PEPS + aviso de caducidad | UB.5 |
| **UB.7** | GP: hoja de surtido por recorrido + reparto de pedido grande por rango de pasillos | UB.3 |
| **UB.8** | Piloto PH: censo completo, etiquetado, dos semanas de uso. Mide cobertura (productos con `surtido_fijo` / productos con venta) y tareas cumplidas | UB.2–UB.6 |

**Ruta crítica**: UB.0 → UB.1 → UB.3 → UB.8. El censo es trabajo de piso, no de software (igual que SU.0 en ADR-067): sin el croquis o la lista de pasillos de PH ([GP.P4]), UB.8 no arranca.

---

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
