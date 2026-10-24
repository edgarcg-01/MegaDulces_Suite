# FASE AB — Autoabasto y Nivelación de Inventarios

> **Estado:** 🔨 ABIERTA 2026-10-23 (toma el cupo de MS) · diseñada 2026-09-19 · **ADR-075 propuesto** · **ADR-100** (Compras decide el traspaso) · ver §16
> **Superficie:** `/almacen/autoabasto` y `/almacen/nivelacion` — dos submódulos nuevos del proyecto Almacén.
> **Dueño operativo:** almacenista y encargado de sucursal. ⛔ **Desde ADR-100 (2026-10-23) el pedido de traspaso lo decide Compras**: la sucursal ve su mesa y lo que le llega, y marca excepciones. Lo que abajo dice «el comprador NO opera este módulo: recibe la solicitud» quedó derogado (§16).

---

## 0. Lo que reformula el pedido

El pedido pide once cosas. **Tres mediciones cambian el diseño antes de escribir una línea**, y las tres
apuntan al mismo lugar: la regla de temporalidad del §4 no se puede usar tal como está escrita, no porque
esté mal pensada, sino porque **el dato con el que se alimentaría todavía no existe**.

**Hallazgo 1 — no hay 12 meses de historia en ningún almacén.** `analytics.sales_daily` arranca el
**2025-10-03** y llega al **2026-08-26**: 11 meses, y el mejor almacén (`02`) tiene 11. **Cero de 12
almacenes llegan a 12 meses.** La regla exige un "promedio mensual anual" de 12 meses completos, así que
hoy devolvería *información insuficiente* para el **100%** de los productos — que es justo lo que el propio
pedido manda hacer en ese caso. Un módulo cuya pantalla principal dice "información insuficiente" en todos
los renglones no se puede entregar.

**Hallazgo 2 — la regla, corrida contra los datos reales, marca 6 de cada 10 productos.** Simulada tal cual
sobre el último mes completo (2026-07): **61.5%** de los SKUs quedan clasificados como temporalidad
(48.3% al alza, 13.2% a la baja). Una bandeja que marca la mayoría del catálogo no es una señal.

**Hallazgo 3 — y lo que la regla está midiendo NO es temporalidad, es el ramp de la ingesta.** Restringir a
los SKUs con venta en los 10 meses completos —el control que debería *limpiar* el ruido— lo **empeora a
75%**. El motivo aparece al contar los almacenes que alimentan el fact mes a mes:

| mes | unidades (mismos 1,223 SKUs) | almacenes que reportan |
|---|---:|---:|
| 2025-10 | 2,948,925 | **1** |
| 2025-12 | 4,614,286 | 1 |
| 2026-03 | 17,084,941 | 4 |
| 2026-06 | 20,442,983 | 8 |
| 2026-07 | **82,616,348** | **11** |

Los mismos productos, 28× más unidades, porque durante la ventana se conectaron **de 1 a 11 almacenes**
(réplica Wincaja WR el 2026-08-18, carriles CDC, sucursales entrando al ODS). El "promedio mensual anual"
está arrastrado hacia abajo por meses en los que el pipeline capturaba una fracción del negocio. **Todo
producto parece temporalidad al alza porque el que creció fue el medidor, no la demanda.**

> Esto es exactamente ADR-056: *lo que no se pudo medir se DECLARA, nunca se dibuja*. La variación existe y
> es correcta aritméticamente; lo que no existe es el derecho a llamarla temporalidad.

**Hallazgo 4 — la unidad física que la regla exige está vacía.** El pedido insiste, con razón, en "unidades
físicas, no importe de ventas". `analytics.sales_daily.units_base` —la columna que ADR-057 creó para eso—
es **NULL en las 641,199 filas**. Hoy sólo está `units`, que mezcla peldaños de la escalera de unidades.
Sumar `units` de doce meses y dividir entre doce produce un promedio en una unidad que no existe.

---

## 1. Lo medido, con su número

| Qué | Medido | Dónde |
|---|---|---|
| Historia de venta | 2025-10-03 → 2026-08-26, **11 meses** | `analytics.sales_daily` |
| Almacenes con ≥12 meses | **0 de 12** | idem |
| La regla ±50%, corrida | **61.5%** de 4,076 SKUs marcados | simulación sobre 2026-07 |
| Control cobertura continua | **75.0%** de 1,223 SKUs (empeora) | idem |
| SKUs con 12 meses de venta | **0 (100% insuficiente)** | idem |
| `units_base` poblada | **0 de 641,199 filas** | idem |
| Solicitudes de compra | **10 filas** | `commercial.purchase_requisitions` |
| Entidad de solicitud de **traspaso** | **NO EXISTE** — sólo lecturas ERP (`analytics.transfers_monthly`, `transfer_dest_map`, `commercial.erp_transfer_origin`) | — |
| `stock_movements` con tipo traspaso | **no hay** (in / adjust / reserve / sale) | `commercial.stock_movements` |
| Usuarios reales del módulo | **2** almacenista + **9** encargado_tienda | `identity.users` |
| `COMPRAS_VER` repartido | **0 de 37 roles** | `identity.role_permissions` |

⚠️ **Todo medido en `platform_test`**, que no es prod. La Fase RA sí está desplegada a Railway, así que el
reparto de `COMPRAS_*` y la profundidad de historia **pueden diferir en prod y hay que re-medirlos ahí
antes de cerrar AB.0**. Se declara en vez de asumirlo.

---

## 2. Lo que YA existe — y no se reconstruye

La Fase RA construyó el motor de reabastecimiento completo, pero **para el comprador**. Ocho de las once
secciones del pedido ya tienen pieza viva. El módulo nuevo es **una audiencia y un trámite**, no un segundo
motor de reorden.

| § del pedido | Ya existe | Dónde |
|---|---|---|
| §3 mín/reorden/máx | `commercial.reorder_policy` (min/reorder/max, `service_level`, `abc_class`, `xyz_class`, `policy_method`) | RA.0 |
| §3 orígenes y red | `warehouses.source_warehouse_id` + DRP multi-echelon + `/compras/red` | RA-PRO.6 |
| §3 múltiplos de empaque | `suppliers.min_order_boxes` + `v_warehouse_box_factor` | RA.13a · ADR-055 |
| §4 temporalidad | **`replenishment_plan.season_ratio` / `season_src`** — jerárquico SKU→cat→global, shrinkage, índices normalizados por año, banda muerta, cap, **con backtest** (bias enero +39.6% → −4.7%, WMAPE 0.72 → 0.47) | RA-PRO.41 |
| §5 caídas abruptas | **`analytics.demand_acceleration`** — Welch-Z 30v30 + estacional YoY, bandas accel/desacel, escala −2..+2 | RA-PRO.36 |
| §6 colchón | safety stock por nivel de servicio `ceil(Z(sl)×σ×√lead)` + `safety_pct_q` por cuantiles | RA-PRO.1 · RA-PRO.41 |
| §7 tránsito | `analytics.purchase_in_transit` (OCs `X-A-35` sin `X-A-40`) | RA.5 |
| §8A solicitud al comprador | `commercial.purchase_requisitions` + `_lines`, folio `RQ-YYYY-NNNNN`, aprobar/rechazar | RA.12 |
| §9 nivelación | **`transferPlan()` y `overstockList()`** ya calculan excedente y traspaso sugerido, en cajas | RA · ADR-055 |
| §10 bandeja | `commercial.replenishment_findings` + scanner nocturno + `/compras/hallazgos` | RA.8 |

> ⛔ **La regla del ADR-056 aplica de lleno:** *un primitivo inventado en una fase NO cierra la fase*. Ocho
> fases ya inventaron su propia bandeja de hallazgos. **AB no inventa la novena.** Si un cálculo de acá no
> existe en `libs/`, se sube a `libs/`; no se copia.

---

## 3. Lo que es genuinamente nuevo

Descontado lo anterior, quedan **cuatro cosas**, y son las que justifican la fase:

1. **La audiencia.** Hoy todo esto vive en `/compras`, gateado por `COMPRAS_*`, que **ningún rol tiene**
   (0 de 37). El almacenista y el encargado ven `/almacen/inventory/existencia` —mismo componente que
   `/compras/existencia`— pero no tienen ni bandeja, ni trámite, ni facultad.
2. **El trámite de solicitud de traspaso.** `transferPlan()` *sugiere*; no hay entidad que **solicite,
   confirme y autorice** un traspaso, ni tipo `transfer` en `stock_movements`. Esto es tabla nueva.
3. **La propuesta de cambio de parámetro con vigencia.** `reorder_policy` guarda el valor vigente y su
   `source`, pero **no guarda historia, ni propuesta, ni quién autorizó, ni fecha de fin de temporada**.
   Es el hueco que VP.3 ya tiene declarado para datos maestros ("hoy **cero** historia para precio, costo,
   reorden…, y `updated_by` miente").
4. **La separación de las dos decisiones del §6** (unidades por demanda vs días por logística), que hoy no
   está representada en ningún lado.

---

## 4. La regla de temporalidad: qué se acepta y qué se corrige

**Se acepta el criterio de negocio.** La fórmula del pedido es clara, auditable por un humano y es la que
el encargado va a poder defender frente a su jefe. Se implementa **tal cual**, con el 50% como política
editable con permiso y trazabilidad, y con la separación que el pedido pide entre *variación observada*,
*posible temporalidad*, *temporalidad respaldada por repetición* y *excepción conocida*.

**Se corrigen cuatro cosas, cada una por una medición:**

**(a) El grano es (producto × almacén), y la ventana es del ALMACÉN, no del producto.** El pedido dispara
"información insuficiente" cuando el *producto* tiene menos de 12 meses. Medido: eso no alcanza — el
problema es que el *almacén* entró al pipeline hace 3 meses. Un producto con 5 años de vida vendido en un
almacén conectado en junio tiene 3 meses de serie. **La cobertura del almacén es la que manda.**

**(b) Mientras no haya 12 meses, la regla NO publica temporalidad: publica variación.** Se muestra la
variación observada con su periodo real ("promedio de 8 meses, del 2026-01 al 2026-08"), rotulada
`ventana_incompleta`, y **no se clasifica**. La clasificación se enciende sola, por almacén, cuando su
serie llega a 12 meses completos. Es un `status` de tres estados, no un booleano: `clasificada` ·
`ventana_incompleta` · `sin_historia`.

**(c) El mes en curso no se compara contra meses completos.** El pedido ya lo exige. Se implementa
comparando **mes completo contra mes completo**, y para el mes en curso se ofrece aparte una proyección
rotulada como tal.

**(d) La regla clasifica; `season_ratio` pronostica. No compiten — y no se suman.** La variación ±50% es el
**rótulo para el humano**; `season_ratio` (backtesteado) es el **multiplicador que entra al sugerido**. Se
muestran juntos y se declara cuando se contradicen, que es información útil por sí sola. ⛔ **El sugerido
NO se multiplica dos veces**: si `season_ratio` ya movió la demanda, la regla ±50% no vuelve a moverla —
es exactamente el doble incremento que el §6 del pedido prohíbe.

**Sobre la repetición histórica (§4, varios años):** **no es construible hoy y no se simula.** No hay un
segundo año en ningún almacén. La columna existe en el modelo, se llena cuando haya dos temporadas
comparables, y hasta entonces la pantalla dice *"sin base para comprobar recurrencia"*. No se rellena con
el promedio ni se dibuja como cero.

### 4.1 El §6 y el colchón por nivel de servicio — se reconcilian, no se eligen

El pedido expresa mínimos / reorden / máximos **en días**. RA-PRO.1 los subió a **unidades por nivel de
servicio** (`ceil(Z(sl)×σ×√lead)`), reemplazando explícitamente los días de cobertura. **No es una
contradicción si se lee bien el §6**, que ya separa las dos decisiones:

- **(A) cambian las unidades porque cambió la demanda** → lo hace el motor: `eff_daily` × `season_ratio`.
- **(B) cambian los días porque cambió el lead time, la frecuencia o el riesgo** → eso es exactamente lo
  que la fórmula de nivel de servicio modela con `lead_days` y σ.

**Resolución:** el parámetro **de registro sigue en unidades** (es lo que `reorder_policy` guarda y lo que
Kepler opera). **Los días son una presentación derivada** (`unidades / demanda diaria`), y la pantalla deja
editar **cualquiera de los dos**, escribiendo siempre unidades y mostrando el otro en vivo. El ejemplo del
pedido —mínimo de 5 días, demanda de 10→15, mínimo 50→75 sin tocar los 5 días— **es el caso de prueba**.

---

## 5. Modelo de datos

> ⚠️ **Corregido el 2026-09-21 — `supply_policy` queda CANCELADA como tabla nueva.**
> Lo que proponía modelar ya existe en `commercial.replenishment_channel` (RA-PRO.8, mig
> `20260720120000`). El alcance real es **extenderla** con prioridad, orígenes alternos y excepción
> por producto. Ver §14.6.

Cuatro tablas nuevas en `commercial.*`, todas con `tenant_id` + audit completo + RLS forzado.

```
commercial.supply_policy              -- §3: política por (sucursal × marca/línea), excepción por producto
  origen_preferente, origenes_alternos[], calendario, lead_time_dias,
  dias_min / dias_reorden / dias_max, multiplo_empaque, vida_util_min_dias

commercial.seasonality_signal         -- §4: la regla, por (producto × almacén × mes)
  unidades_mes, promedio_mensual, variacion_pct, periodo_desde, periodo_hasta,
  meses_en_ventana, status, clase, recurrencia_status, excepcion_tipo,
  season_ratio_motor, contradice_motor

commercial.parameter_proposal         -- §6: la propuesta con vigencia y autoría
  actual_unidades / actual_dias, propuesto_unidades / propuesto_dias,
  motivo, evidencia, vigencia_desde / vigencia_hasta, impacto_estimado,
  propuesto_por, autorizado_por, estado

commercial.transfer_requests(+_lines) -- §8B: el trámite que NO existe
  folio TR-YYYY-NNNNN, origen_warehouse_id, destino_warehouse_id,
  crossdock_warehouse_id,               -- CEDIS es ESCALA, no dueño de la mercancía
  urgencia, fecha_requerida,
  estado: borrador → solicitado → confirmado → en_transito → recibido / rechazado

commercial.stock_snapshots            -- §11 del PM: la foto por cierre que hoy no existe
  cadencia: diario | semanal | mensual | trimestral | anual,
  fecha_corte, warehouse_id, product_id, unidades, costo_unitario, valor
```

**Decisiones de modelo, con su motivo:**

- `seasonality_signal` es **tabla**, no vista: es un **snapshot mensual** con el que se compara el año que
  viene. Es el único caso de la fase que la regla ⭐ del proyecto permite materializar (histórico), y se
  declara como tal.
- `supply_policy` **NO duplica** `reorder_policy`: aquélla guarda el número vigente por
  (producto × almacén); ésta guarda **la política y el origen** por (sucursal × marca). Se cruzan, no se
  copian.
- Una necesidad se cubre desde varios orígenes: `transfer_request_lines` y `requisition_lines` apuntan a un
  `need_id` común, y la cobertura se **recalcula siempre** desde las líneas vivas — nunca `+=`. Es el
  patrón que TP ya probó para no reservar dos veces el mismo saldo.
- **CEDIS no es origen de traspaso, es escala** (decisión del PM: *"sucursal-sucursal, CEDIS sólo hace
  crossdocking"*). Por eso `crossdock_warehouse_id` es una columna del traspaso y **no** un segundo
  renglón origen→CEDIS + CEDIS→destino: partirlo en dos haría que la mercancía figure como existencia del
  CEDIS a mitad de camino, y el CEDIS terminaría apareciendo como excedente propio en la nivelación.
- ⭐ **Corrección al construir (2026-09-19): `analytics.period_close` YA EXISTE.** Este plan decía, citando
  el CLAUDE.md, que *"un grep de `period_close` en 578 migraciones da cero"*. **Ya no**: VP.4.1 congeló la
  cifra oficial por periodo y VP.4.3 le puso el comparador de deriva (`PeriodCloseCheckService`, cron 07:10
  MX, distingue `difiere_fuente` de `difiere_definicion`). Es **genérica**: `superficie` + `periodo` +
  `cifra` jsonb. Hoy tiene 0 filas en `platform_test`.

  Eso parte la foto en dos piezas, y **sólo una es nueva**:
  · **la serie por renglón** (producto × almacén × fecha) → `analytics.stock_snapshots`, que no existe en
    ningún lado y no se puede reconstruir → **se construye** (AB.0b);
  · **la cifra oficial del cierre** → se registra en `analytics.period_close` con
    `superficie = 'inventario'`, y hereda gratis el comparador de deriva de VP.4.3. **No se inventa un
    segundo lugar para "la cifra oficial del mes"** — ADR-056: el primitivo que ya existe se consume.

---

## 6. Permisos y facultades

Permisos **propios**, no reusados de `COMPRAS_*` (el comprador no opera este módulo, y `COMPRAS_VER` hoy no
lo tiene nadie):

| Clave | Quién | Qué habilita |
|---|---|---|
| `AUTOABASTO_VER` | almacenista, encargado, compras, dirección | ver la mesa de trabajo y las propuestas |
| `AUTOABASTO_SOLICITAR` | almacenista | preparar solicitudes y **proponer** cambios de parámetro |
| `AUTOABASTO_AUTORIZAR` | encargado de sucursal | **autorizar** dentro del tope de inventario |
| `AUTOABASTO_EXCEDER_TOPE` | dirección comercial y dirección general | **lo único** que autoriza pasar el tope |
| `NIVELACION_VER` / `NIVELACION_GESTIONAR` | encargado, almacén de origen | excedentes y confirmación de traspaso |
| `AUTOABASTO_POLITICA` | dirección general y comercial | mover el umbral del 50% y los calendarios |

**Separadas a propósito**, como pide el §2: `SOLICITAR` ≠ `AUTORIZAR`, y **autorizar una necesidad no es
autorizar un gasto** — el gasto sigue siendo del comprador, en Compras.

### 6.1 La escalera de facultades (decisión del PM, 2026-09-19)

Tres bandas, y **la banda la decide el número, no el cargo**:

| Banda | Condición | Quién resuelve |
|---|---|---|
| **Avanza** | La cantidad cae **dentro de los parámetros** (mín / reorden / máx) vigentes | Nadie: la política ya lo autorizó |
| **Pasa al comprador** | **Excede los parámetros**, sin pasar el tope de inventario | Comprador, en Compras |
| **Excepción** | **Excede el tope de inventario** | ⛔ **Sólo** dirección comercial o general (`AUTOABASTO_EXCEDER_TOPE`) |

⚠️ **El tope va en VALOR (pesos), no en unidades** — decisión #17 del PM, ver §10.2(a). La propuesta
original de este documento era `reorder_policy.max_stock` (unidades); **queda corregida**: mientras convivan
dos orígenes con unidades distintas, un techo en unidades significa cosas distintas según de qué base venga
el renglón, y el de pesos no. Los parámetros mín/reorden/máx **siguen en unidades** (son del motor); lo que
pasa a pesos es **la facultad**.

> ⚠️ El parámetro es la pre-autorización. Eso vuelve al **cambio de parámetro** la decisión sensible del
> módulo — subir el máximo mueve la banda de todo lo que venga después. Por eso `parameter_proposal`
> (AB.6) lleva autoría, vigencia y fecha de fin, y no es un `UPDATE` suelto sobre `reorder_policy`.

⛔ **El permiso se reparte en la misma migración que lo crea.** Es la lección LC.6.2, y esta fase la tiene
medida de nuevo enfrente: `COMPRAS_VER` está declarado en el enum y en **0 de 37 roles**. Un módulo no está
entregado hasta que su permiso está **repartido**, con la cobertura verificada por un gate que falla.

---

## 7. Sprints

| # | Sprint | Qué cierra | Depende de |
|---|---|---|---|
| **AB.0** | ⛔ **Ruta crítica: re-medir en prod** | Historia por almacén, `units_base`, reparto `COMPRAS_*`, **y la profundidad real de la réplica Wincaja** (`:5433/wincaja`, `w30`/`w32`/`w00`). **Se corre después del 30-sep-2026**, cuando cierre la migración | — |
| **AB.0b** | ⏱️ **La foto de inventario — arranca YA** | `stock_snapshots` en `libs/` + el corte diario. **Es un reloj: cada mes sin fotografiar es historia que no se recupera** | — |
| **AB.1** | Unidad física | Poblar `units_base` (ADR-057) o declarar por qué no se puede. **Sin esto la regla suma peras y cajas** | AB.0 |
| **AB.2** | `supply_policy` + origen sugerido | §3 completo, con la explicación del origen elegido | AB.0 |
| **AB.3** | Mesa de trabajo `/almacen/autoabasto` | §10: agotados, cobertura, riesgo de agotamiento antes de la siguiente recepción | AB.1, AB.2 |
| **AB.4** | `seasonality_signal` | §4 con sus 3 estados + contraste contra `season_ratio` | AB.1 |
| **AB.5** | Caída abrupta | §5 **consumiendo `demand_acceleration`**, + los 6 descartes previos (agotado, cierre, promo…) | AB.4 |
| **AB.6** | `parameter_proposal` | §6 con las dos decisiones separadas, vigencia y autoría | AB.4 |
| **AB.7** | Bandeja A — al comprador | §8A sobre `purchase_requisitions` (no se crea entidad nueva) | AB.3 |
| **AB.8** | Bandeja B + `/almacen/nivelacion` | §8B y §9: `transfer_requests` nuevo, sobre `transferPlan()` / `overstockList()` | AB.3 |
| **AB.9** | Candado | Suite de regresión + **prueba negativa por gate** | todos |

**MVP = AB.0 + AB.0b → AB.3 + AB.7.** Con eso el almacenista ya solicita con justificación. §4 / §5 / §6
entran después porque **dependen de una historia que hoy no existe**, y entregar una clasificación de
temporalidad sobre 8 meses de un pipeline que creció 28× sería publicar un número falso con cara de verde.

### 7.1 ⭐ El piloto no tiene que esperar a la unificación de Wincaja

El PM eligió **`02` — La Piedad Abastos**, y resulta ser **el almacén con más historia de los 12**: serie
desde el **2025-10-03**, hoy 11 meses. Los otros once van de 1 a 8 meses.

Eso cambia el calendario del §4. La decisión del PM fue *"dejo existir el módulo y lo corrijo cuando se
unifique toda la historia de Wincaja"* — pero **para el piloto no hace falta esperar a eso**:

| Hito | Cuándo |
|---|---|
| `02` acumula 12 meses completos (2025-11 → 2026-10) | **primeros días de noviembre de 2026** |
| Si se acepta 2025-10 como completo (le faltan los días 1 y 2) | **primeros días de octubre de 2026** |

Es decir: **entre 2 y 6 semanas**, no "cuando se unifique el histórico". La clasificación se enciende sola
por almacén al llegar a 12 meses (§4b), así que `02` va a ser el primero en encenderse **sin tocar código**.

La unificación de Wincaja sigue siendo necesaria para **los otros once almacenes** y para la recurrencia
multi-año, que es lo que de verdad convierte *posible temporalidad* en *temporalidad respaldada*.

---

## 8. Casos numéricos de aceptación

Los cinco que pide el §11, con el resultado que el módulo debe dar:

1. **Alza real.** Promedio 100 u/mes con 12 meses completos, mes 160 → `+60%`, `clase=alza_potencial`,
   `status=clasificada`. Con `season_ratio=1.4` coincidente → se propone subir **unidades**, no días.
2. **Baja real.** Promedio 100, mes 40 → `−60%`, `baja_potencial`. **Antes de proponer reducción** se
   revisan los 6 descartes del §5; si hubo agotado 14 de 30 días → `excepcion=agotamiento` y **no se
   propone reducir**.
3. **Caída por agotamiento.** Días con existencia 16/30 → la venta cae 47% y la regla **no** la clasifica
   como baja. Es el caso que el pedido marca explícitamente y el que más dinero cuesta si falla.
4. **Producto nuevo.** 3 meses de vida → `status=sin_historia`, política provisional, revisión del
   encargado. **No se le inventa promedio.**
5. **Fin de temporada con mercancía por recibir.** Propuesta de baja con `vigencia_hasta`, anticipada por
   `lead_days` para que no aterricen pedidos altos después del cierre; el tránsito confirmado
   (`purchase_in_transit`) se descuenta y el no confirmado se muestra aparte.

**Y un sexto, que sale de la medición y no estaba en el pedido:**

6. **Almacén recién conectado.** Almacén `06`, 1 mes de serie, producto con 5 años de vida →
   `status=ventana_incompleta`, se publica la variación con su periodo real y **no se clasifica**. Sin este
   caso, los 11 almacenes que hoy no llegan a 12 meses publicarían temporalidad inventada.

---

## 9. Decisiones

### 9.1 Se acepta

- La fórmula del §4 **tal cual**, con el 50% como política editable con permiso y trazabilidad.
- La separación del §6 entre unidades (demanda) y días (logística), con **unidades como registro**.
- Permisos propios, y `SOLICITAR` ≠ `AUTORIZAR`.
- Solicitud de compra, **nunca** orden de compra desde este módulo.

### 9.2 Se rechaza, con motivo

- ⛔ **Un segundo motor de reorden.** RA ya lo tiene, backtesteado. AB **consume** `replenishment_plan`.
- ⛔ **Clasificar temporalidad con la historia de hoy.** Medido: 61.5–75% de marcados, causados por el ramp
  de 1→11 almacenes. Se publica variación, no clasificación, hasta tener la ventana.
- ⛔ **Reemplazar `season_ratio` por la regla ±50%.** La regla es el rótulo del humano; el pronóstico sigue
  siendo el que tiene backtest. Y **no se aplican los dos al mismo sugerido**.
- ⛔ **Una bandeja de hallazgos propia.** Sería la novena; se reusa `replenishment_findings` o se sube a
  `libs/`.
- ⛔ **Simular la recurrencia multi-año.** No hay segundo año. Se declara.

---

## 10. Decisiones del PM — resueltas 2026-09-19

| # | Pregunta | Decisión |
|---|---|---|
| 1 | ¿Superficie o motor nuevo? | **Se usa lo que ya existe.** AB consume el motor de RA |
| 2 | Límite de facultad | **Tope de inventario.** Pasarlo: sólo dirección comercial o general |
| 3 | Contrato con Compras | Dentro de los parámetros **avanza**; si los excede, **por fuerza pasa al comprador** |
| 4 | Piloto | **`02` La Piedad Abastos** |
| 5 | Orígenes | **Sucursal → sucursal.** CEDIS **sólo crossdocking** |
| 6 | ¿El origen puede negarse? | Sólo si **queda por debajo de su punto de reorden**. Por encima, **está obligado a traspasar** |
| 7 | Hasta dónde cede el origen | **Hasta su punto de reorden** |
| 8 | Ventana incompleta | **Se acepta**: el módulo existe y se corrige al unificar la historia de Wincaja *(ver §7.1: el piloto no tiene que esperar)* |
| 9 | Temporadas | Confirmadas las del pedido |
| 10 | Promociones | Mercadotecnia **apenas empieza** en la suite. Ligar picos ↔ promoción es **trabajo por venir**: AB deja el gancho, no la función |
| 11 | Foto de inventario | **Se desarrolla**: diario, semanal, mensual, trimestral y anual, por cierre → **AB.0b** |
| 12 | Dueño del umbral | Deciden **dirección general y comercial**; proponen **gerencia de zona, encargado y almacenista** |
| 13 | Firma de aceptación | **Frank** |

### 10.1 Segunda ronda — 2026-09-19

| # | Tema | Decisión |
|---|---|---|
| 14 | Migración | **Termina el 30-sep-2026** (faltan días). Después: normalizar para que el histórico se lea desde la suite |
| 15 | Unidades 2→3 | Antes pza y caja; la **tercera unidad vivía como OTRO CÓDIGO** (bulto → kg → 500 g) con ajuste de entrada y salida. **Mismo producto, códigos distintos.** Es **otra tarea**, no AB |
| 16 | Status de la OC | Catálogo tipado de por qué no cuadra: **corte por pedido mínimo · factura pendiente (financiero) · múltiplos de promoción que afectan costo · fuerza mayor** (bloqueo carretero, robo, asalto) |
| 17 | **El lenguaje** | Conviven **2 orígenes con unidades distintas por ~12 meses** → **el valor es el lenguaje** por ahora |

### 10.2 El lenguaje: valor o unidades — tres preguntas, tres respuestas

La decisión #17 es la más cargada de la fase, y **no tiene una sola respuesta**, porque "valor o unidades"
son tres preguntas distintas disfrazadas de una.

**(a) El tope de facultad → VALOR. Confirmado, y ya es doctrina.** Es un control financiero, es lo que
dirección mira, y es **inmune a la unidad del numerador**. ADR-059 regla 2 lo dice con todas las letras:
*el dinero arbitra la cantidad*. El tope pasa a expresarse en **pesos**, no en `max_stock` como proponía
el §6.1 — **la propuesta anterior queda corregida por esta decisión.**

**(b) El árbitro de la unidad → VALOR. Confirmado, y ya está construido.** La frase del PM —*"si sostienes
los importes llegas a la verdad absoluta que luego se transforma al convertirse en unidades"*— es
literalmente `analytics.v_unit_truth` con `metodo_cajas = 'dinero'`. Las seis vistas árbitro existen
(`v_unit_truth`, `_coverage`, `v_product_box_factor`, `v_warehouse_box_factor`, `v_supplier_cost_ladder`,
`v_product_unit_ladder`). **No hay que construirlo: hay que consumirlo.**

Medido, por pares producto×almacén: `divisor` 66,582 · `unidad_es_caja` 20,169 · **`sin_metodo` 8,271** ·
`dinero` 3,708 · `peso` 2,043. ⚠️ Ese 3,708 es **conteo de pares**, no participación en la venta — el 87.8%
que cita ADR-057 está ponderado por importe. Son denominadores distintos y no se deben mezclar.

**(c) La demanda y la temporalidad → UNIDADES. Acá el valor NO sirve, y hay número.** El precio implícito
(`revenue / units`) de los **mismos 1,223 SKUs** con cobertura continua se movió así:

| mes | precio implícito | vs. inicio |
|---|---:|---:|
| 2025-10 | 20.0833 | — |
| 2025-12 | 23.6796 | +17.9% |
| 2026-04 | 23.8735 | +18.9% |
| 2026-07 | **24.7462** | **+23.2%** |

Si el valor fuera el lenguaje de la **demanda**, cada producto cargaría **+23.2% de crecimiento fantasma**
en 10 meses — encima del ramp de ingesta de 1→11 almacenes que ya infla 28×. **Los dos sesgos se suman y
apuntan al mismo lado**, y la regla del §4 quedaría marcando alza en prácticamente todo el catálogo. Por eso
el propio pedido dice *"usar unidades físicas, no importe de ventas"*: tenía razón.

> **Resolución:** el valor es el **lenguaje del control** y el **árbitro de la unidad**; las unidades siguen
> siendo la **métrica de la demanda**, *reconstruidas a través del valor*. No se elige entre los dos: se les
> da a cada uno la pregunta que sí saben contestar. Es exactamente lo que `v_unit_truth` ya hace.

**El §6 y el §7 se combinan en una sola fórmula, que es la que va al código:**

```
excedente_cedible(origen) = max(0, stock_origen − reorder_point_origen)
```

Por encima del punto de reorden el traspaso es **obligatorio**, no negociable; por debajo, el origen queda
protegido y la solicitud se redirige. Es determinista: **no hace falta un árbitro para la negativa.**

---

## 11. Lo que se declara abierto

1. ✅ **RESUELTO (#18).** El remanente no surtido **vive como backorder** —queda abierto, no se cierra
   solo— y **se da de baja la orden de compra restante cuando el proveedor cancela el backorder**. Esa
   cancelación es el **único** evento que lo cierra: los otros motivos del #16 (factura pendiente,
   múltiplos de promoción, fuerza mayor) **dejan la necesidad viva** con su motivo a la vista. Es la
   diferencia entre *"no llegó todavía"* y *"no va a llegar"*, y la bandeja tiene que distinguirlas.
2. ✅ **RESUELTO (#19).** Gana el destino con **menos días de cobertura**; empate → mayor rotación. Regla,
   no semáforo humano.

**Y una dependencia nueva, que NO es de esta fase (decisión #15) — ver §12:**

3. ⛔ **La normalización del histórico de unidades es una fase aparte, y es más grande de lo que parece.**
   La tercera unidad vivía como **otro código de producto**, así que la historia del mismo producto físico
   está **partida entre varios SKUs con unidades distintas**. Medido, el mecanismo para expresarlo existe a
   medias:
   - `catalog.product_barcodes` — **12,405 filas, y SÍ lleva `unit` + `factor`.** Es el hogar correcto.
   - `commercial.product_aliases` — **0 filas, y NO lleva factor.** Sólo mapea
     `alias_product_id → canonical_product_id`. ⚠️ **Usarla tal cual para este caso fusionaría los códigos
     perdiendo la conversión** — sumaría bultos con kilos en la misma columna, en silencio. Si la
     normalización se apoya acá, primero necesita factor y unidad.

   Mientras esa fase no exista, AB **no** consolida historia entre códigos: trata cada código como su propia
   serie y lo declara. Inventar la equivalencia sin factor verificado es justo lo que ADR-059 prohíbe.

**Y las mediciones que faltan:**

- **AB.0 contra prod está sin correr.** Todo el §1 es `platform_test`.
- **La profundidad real de la réplica Wincaja está SIN MEDIR.** En `platform_test` el schema `wincaja` es
  una muestra de **un solo día** (`business_date = 2026-08-25`) y casi todas sus tablas están vacías — no
  es ahí donde vive el histórico. La réplica real (Fase WR: `:5433/wincaja`, `w30`/`w32`/`w00`, ~807k
  filas) **no es alcanzable desde este entorno**: no hay credencial. Es la primera tarea de AB.0, y de su
  resultado depende si la unificación del §8 son semanas o meses.
- **`units_base` vacía** bloquea la unidad física del §4. Puede ser un hueco de `platform_test` o real.
- **Umbrales del §5** (ventanas y sensibilidad) salen como recomendación pendiente de aprobación.
- **Costo de traslado** del §9: no hay fuente medida de costo por traspaso; hasta tenerla, la propuesta de
  nivelación muestra distancia y origen, y **declara que el costo no está incorporado**.
- **El tope de inventario = `max_stock`** es propuesta mía, no decisión del PM. Si el tope se quiere en
  **valor** (pesos) y no en unidades, cambia el modelo y hay que decirlo antes de AB.2.

---

## 12. ⛔ Dependencia bloqueante con nombre — Fase NH, Normalización del Histórico Wincaja

> **Declarada el 2026-09-19. Ventana pedida: SEMANAS, no meses.** ADR-056: *un mecanismo que una fase
> necesita y no construye, queda declarado como deuda con nombre* — éste lo tiene.

**Qué es.** Dejar la información ya cerrada de Wincaja normalizada y legible desde la suite, como **verdad
histórica entendida**, no como un volcado crudo. Arranca cuando cierre la migración, el **30-sep-2026**.

**Por qué es urgente y no puede esperar a "después del MVP":**

- **11 de los 12 almacenes no tienen 12 meses.** Sólo el piloto `02` llega solo (§7.1). Los demás **dependen
  de esta fase** para que el §4 se les encienda alguna vez.
- **La recurrencia multi-año no existe sin ella.** Es lo que convierte *posible temporalidad* en
  *temporalidad respaldada*, que es el corazón del pedido original.
- **Es un reloj compartido con AB.0b**: la foto de inventario se puede empezar a tomar hoy hacia adelante,
  pero **la historia cerrada de Wincaja no se puede volver a tomar**. O se normaliza, o se pierde.

**La trampa técnica, medida — y es la razón por la que esto NO es un import más:**

La tercera unidad de medida **no era una unidad: era otro código de producto** (pza y caja eran las dos;
el bulto→kg→500 g vivía como SKU aparte, con ajuste de entrada y salida). Así que la historia de un mismo
producto físico está **partida entre varios códigos con unidades distintas**.

| Pieza | Estado medido | Veredicto |
|---|---|---|
| `catalog.product_barcodes` | 12,405 filas, **con `unit` y `factor`** | ✅ hogar correcto |
| `commercial.product_aliases` | **0 filas, SIN factor** (sólo `alias_product_id → canonical_product_id`) | ⚠️ **no sirve tal cual** |

⛔ **Fusionar los códigos con `product_aliases` como está hoy sumaría bultos con kilos en la misma columna,
en silencio** — un número que se ve perfectamente sano y está mal. Antes de mapear, la tabla necesita
**unidad y factor**, y el factor necesita **testigo** (`v_supplier_cost_ladder` = lo que se le pagó al
proveedor, ADR-057).

**Lo que se pide al PM:** dueño y ventana. Sin eso, AB entrega el piloto y **los otros once almacenes quedan
en `ventana_incompleta` por tiempo indefinido** — que es un resultado honesto, pero no es el que se pidió.

---

## 13. Entrega en 5 PRs

| PR | Alcance | Estado |
|---|---|---|
| **1** | **AB.0b — La foto de inventario.** El reloj | 🧪 **EN CÓDIGO 2026-09-19** |
| **2** | AB.2 + AB.3 — Mesa de trabajo `/almacen/autoabasto` + permisos + navegación | 🔨 **EN CÓDIGO 2026-09-19** |
| **3** | AB.7 — Bandeja al comprador: escalera de facultades, backorder, status tipado | ⬜ |
| **4** | AB.8 — `/almacen/nivelacion`: traspasos, crossdock, excedente cedible | ⬜ |
| **5** | AB.4 + AB.5 + AB.6 — Temporalidad, caída abrupta y propuestas de parámetro | ⬜ |

PR1 va primero porque **es el único que pierde valor cada día que no se entrega**. Los otros cuatro
construyen sobre datos que ya existen; éste crea datos que, si no se toman hoy, no se pueden tomar después.

### 🧪 PR 1 — AB.0b, la foto de inventario (2026-09-19)

**Qué entrega.** `analytics.stock_snapshots` (la serie por renglón) + `analytics.stock_snapshot_coverage`
(qué almacén se fotografió qué día) + `StockSnapshotService` con cron 23:50 MX + disparo manual
(`POST /commercial/inventory/stock-snapshot/run`, idempotente por fecha) + lectura de cobertura +
umbral de latido en `CRON_JOBS`.

**Las tres decisiones que no son obvias:**

1. **Sólo se guardan los pares con saldo ≠ 0.** Medido: 27,269 de 57,805 → 10.0 M filas/año en vez de
   21.1 M. **Pero eso vuelve ambigua la ausencia**, y por eso existe `coverage`: ausencia DENTRO de un
   almacén cubierto = cero real; ausencia del almacén = **no medido**. Sin esa segunda tabla, un `LEFT
   JOIN` leería las dos igual — la trampa exacta de ADR-056.
2. **Una captura al día; semana/mes/trimestre/año son banderas, no capturas.** El cierre de mes **es** la
   foto del día 31. Capturarlos por separado permitiría que las dos cifras del mismo hecho no coincidan.
3. **Sin costo → `valor` NULL, nunca 0.** El scanner de reabasto usa `COALESCE(..., 0)`, que sirve para
   ordenar una lista pero acá sumaría inventario valuado en cero al total del cierre. Y si **algún** par
   del almacén no se pudo costear, `valor_total` del almacén queda NULL con `pares_sin_costo` a la vista:
   un total parcial presentado como total es una cifra falsa.

**Verificación:** `database/tests/test-newdb-stock-snapshots.js`, **21/21**, en la suite de regresión.
Ejercita el **servicio real** vía `ts-node` —no una copia de su SQL, que se comprobaría a sí misma— y
**cinco de las aserciones son negativas**: el cero no deja fila, sin costo no se dibuja 0, el total parcial
no se publica, re-correr corrige sin duplicar, y un día cualquiera no lleva bandera de cierre.
`nx build api` verde.

**Nivelación queda FUERA de este PR, y eso fue un hallazgo del propio gate.** El WIP heredado ya
declaraba `/almacen/nivelacion` en `authz-tree` y la migración ya repartía `NIVELACION_*`. El spec
`landing-guards.spec.ts` (SN.4) lo acusó: **3 candidatos de aterrizaje nuevos que rebotan** — dos
apuntando a una ruta que no existe en `app.routes.ts`, y `AUTOABASTO_SOLICITAR` cayendo en una puerta
que sólo aceptaba `AUTOABASTO_VER`. Los tres se corrigieron en vez de declararse como deuda:

| Qué acusaba SN.4 | Qué se hizo |
|---|---|
| `AUTOABASTO_SOLICITAR→/almacen/autoabasto` rebota | la ruta pasa a `anyPermissionGuard(VER, SOLICITAR)`: quien prepara tiene que poder abrir la mesa |
| `NIVELACION_VER→/almacen/nivelacion` no existe | el nodo sale de `authz-tree`; vuelve en el PR 4 **con su pantalla** |
| `NIVELACION_GESTIONAR→/almacen/nivelacion` no existe | ídem, y el prefijo sale también de `ALMACEN_AREAS` |

Y por lo mismo **la migración ya no reparte `NIVELACION_*`**: repartir una llave que no abre nada es
un permiso muerto (ADR-054). El anclaje ya está elegido y escrito en el encabezado de la migración,
para que el PR 4 no lo vuelva a decidir.

Antes del arreglo el área `almacen` tenía **5** candidatos que rebotan; después, **2** — y esos dos
(`CATALOGO_INTERNO_*`, Fase CV) son deuda previa. Este PR no suma ninguno.

**Declarado, no verificado:** el endpoint HTTP **no se probó contra la API viva** — la que corre en `:3334`
es un build anterior y reiniciarla no me corresponde. El servicio sí se ejercitó de verdad, con su Knex,
desde el test. **Falta:** aplicar la migración en prod, redeploy, y la primera corrida real del cron.

**Retención:** declarada, no implementada. Diario > 400 días se purga salvo bandera de cierre. Con 0 filas
sería código muerto; se escribe cuando la tabla lo pida.

---

### 🔨 PR 2 — AB.2 + AB.3, la mesa de trabajo (2026-09-19)

**Qué entrega.** `/almacen/autoabasto` de punta a punta en LECTURA: `AutoabastoController`
(`/commercial/autoabasto/{mesa,mesa/resumen,filtros}`), las 7 llaves nuevas en el enum + `permission-meta`
+ `authz-tree`, la **migración que las reparte** (`20260919160000`), el área *Abasto* en el sidebar del
almacén, la ruta bajo el shell de área y la pantalla.

**Las decisiones que no son obvias:**

1. **El controlador no calcula.** Delega en `CommercialReplenishmentService`, el mismo motor de
   `/compras/existencia`. Dos audiencias, un solo número: un segundo motor de reorden sería la forma más
   cara de que el almacén y el comprador discutan cifras distintas del mismo hecho (ADR-056). Por eso las
   firmas del boundary se **derivan** del motor (`Awaited<ReturnType<...>>`) en vez de declarar una
   interfaz nueva — declararla a mano sería una segunda definición del mismo hecho.
2. **Llaves propias, no `COMPRAS_*` reusadas.** Medido: `COMPRAS_PEDIDO_VER` está en **`false` explícito**
   para `almacenista` y en `true` para `encargado_tienda`. La persona que hace el trabajo es justo la que
   no alcanza Existencia Crítica. Ese `false` es una decisión manual guardada desde `/admin/roles` y **no
   se pisa**: se abre con llave propia, que al ser clave nueva está en NULL en los 38 roles vivos.
3. **El reparto se deriva del estado vivo, y la separación §2 se sostiene sola.** `AUTOABASTO_SOLICITAR`
   se ancla en `COMMERCIAL_INVENTORY_AJUSTAR` (7 roles — incluye `almacenista`) y `_AUTORIZAR` en
   `COMPRAS_PEDIDO_GESTIONAR` (9) + `FINANCE_PAYMENT_CALENDAR_AUTORIZAR` (2, para que entre `direccion`,
   que tiene la otra en NULL). `almacenista` tiene `COMPRAS_PEDIDO_GESTIONAR` en `false` explícito, así
   que **queda fuera de AUTORIZAR por su propio estado**: quien prepara no firma, sin lista a mano.
   `_EXCEDER_TOPE` y `_POLITICA` calcan `FINANCE_PAYMENT_CALENDAR_AUTORIZAR` (direccion, superadmin) —
   el precedente vivo de permiso restringido (TP.6) — y quedan fuera de todo MODULE_GROUP: no se otorgan
   de paquete.
4. **⚠️ `customer_b2b` se excluye a mano, y es lo único que no sale de una derivación.** Tiene
   `COMMERCIAL_INVENTORY_VER = true` **y es el portal EXTERNO** (`PORTAL_B2B_ACCESS`, 3 usuarios vivos).
   Sin ese `<> ALL`, derivar de `COMMERCIAL_INVENTORY_VER` le habría entregado la mesa interna de
   reabasto a tres cuentas de cliente. Medido antes de escribir la migración, no supuesto.

**Verificación:** `nx build api` verde · `nx build view` verde · `npm run check:templates` verde (321
componentes) · `npm run lint:boundary` verde **en lo nuevo de este PR** · `nx test contracts` 76/76 ·
`nx test view` 463 pasan y **7 fallan, los mismos que en `main`** — deuda previa de
`landing-guards.spec.ts`. Lo que sí cambió: el área `almacen` pasó de **5 candidatos que rebotan a 2**,
porque este PR corrigió los 3 que el WIP heredado había introducido (ver abajo).

**Simulación del reparto, contra la base viva, sólo con `SELECT`** (la migración NO se aplicó):

| Llave | Roles que la recibirían |
|---|---|
| `AUTOABASTO_VER` | 14 |
| `AUTOABASTO_SOLICITAR` | 7 — incluye `almacenista` |
| `AUTOABASTO_AUTORIZAR` | 10 — **sin** `almacenista` |
| `AUTOABASTO_EXCEDER_TOPE` · `_POLITICA` | 2 (direccion, superadmin) |
| `NIVELACION_*` | **no se reparten acá** — ver abajo |

**Declarado, no verificado:**
- **La pantalla no se abrió en el navegador.** El build en verde no dice nada sobre lo que se renderiza —
  es exactamente la lección de [`docs/GOTCHAS.md` §59](../../GOTCHAS.md), que salió de `/finanzas/caja-general`.
- **La migración no se aplicó.** La base está aplicada a medias (122 migraciones sin registrar), así que
  un `migrate:latest` a ciegas choca. Se corre cuando se decida cómo reconciliar ese estado.
- **Scope por sucursal: NO existe.** `warehouse_id` es del llamador, no del token. Un almacenista con la
  clave ve la red completa si no filtra. Está **dicho en pantalla**, no disimulado con un filtro de front
  que daría sensación de alcance sin serlo.
- **`accion` se filtra en el cliente.** El endpoint todavía no la acepta como parámetro; se recorta sobre
  la página cargada y el total refleja eso, en vez de mandar un parámetro que el backend ignoraría en
  silencio. Pasa al backend cuando entre la escritura.

**Dos hallazgos que no son de este PR y no se escondieron:**

1. **PR #125 (AB.0b) tiene 3 violaciones del boundary gate** — `stock-snapshot.controller.ts` (2) y
   `stock-snapshot.service.ts` (1), todas *"Missing return type"*. Entraron con `7af95329`. El PR se
   reportó verde porque se corrió `nx build api` y los tests, **no** `npm run lint:boundary`; y CI está
   `disabled_manually`, así que nadie más lo miró.
2. **`npm run check:provenance` falla en `main`** — `StoreRhythm` (`apps/view/.../store-socket.service.ts`)
   declara `generated_at` sin procedencia. Entró con `f40234a9` (TDA.P), que está en `main`. El gate
   compara contra un `BASELINE = 0` hardcodeado: ese commit subió la deuda a 1 sin corregirla ni mover la
   línea. **No se bajó la línea acá a propósito** — mover el BASELINE es justo lo que el gate existe para
   impedir.

#### 🧪 Validación visual de PR 2 — hecha 2026-09-19, y encontró algo

El PR se entregó declarando *"la pantalla no se abrió en el navegador"*. Se abrió, con el API local
levantado y sesión real (`superuser`, SUPERADMIN).

**Lo que quedó comprobado:**

| Qué | Resultado |
|---|---|
| Ruta `/almacen/autoabasto` resuelve | ✅ |
| Área **Abasto** en la migaja (`Almacenes y Logística › Almacén › Abasto`) | ✅ |
| Barra de tabs del área: *Autoabasto* + *Análisis BI* | ✅ (el tab que cruza áreas de WMS-BI.6 aparece acá solo) |
| Encabezado, filtros (almacén / proveedor / acción / posición / búsqueda) | ✅ pintan |
| El aviso de alcance —*"estás viendo la **red completa**; el recorte por tu sucursal todavía no lo aplica el servidor"*— | ✅ en pantalla, no escondido |
| El pie declara que la pantalla **sólo lee** | ✅ |

**Lo que NO quedó comprobado, y por qué no es de este PR:** la tabla no cargó —
`GET /commercial/autoabasto/mesa` devuelve **500**. La causa está medida:

```
no existe la relación «analytics.v_erp_unit_cost»
falta una entrada para la tabla «euc» en la cláusula FROM     (errorMissingRTE)
```

⭐ **El endpoint ORIGINAL de Compras falla idéntico**: `GET /commercial/replenishment/critical-stock`
también devuelve 500 contra esta misma base. Como PR 2 **no toca** `CommercialReplenishmentService`
—sólo agrega un controlador que delega— el fallo es de la **base local**, que está aplicada a medias
(122 migraciones sin registrar; falta esa vista, y también `identity.position_responsibilities`).

Esa comparación es la que convierte "la pantalla falla" en "el entorno falla": sin correr el hermano
de Compras, el 500 se habría leído como un bug de esta rama.

**Vale la pena por sí solo:** la pantalla **degrada con honestidad**. No crashea, no pinta ceros ni una
tabla vacía que se leería como *"no falta nada"* — muestra el error con su motivo y un botón de
reintento. Es la conducta que ADR-056 pide y que un build verde no puede comprobar.

**Sigue sin verificar:** el reparto de las 7 llaves nuevas. La migración no se aplicó, y `superuser`
entra por `ALL_PERMS`, así que esta sesión **no probó ninguna compuerta**. Se mantiene declarado.

---

## 14. Reconciliación con el plan del 2026-09-21 (12 etapas · 10 PRs)

El plan nuevo reordena el mismo pedido en **12 etapas** y propone **10 PRs**. No cambia la tesis de la
fase. Agrega tres cosas que este documento no tenía, **corrige una que sí tenía**, y —esto es lo primero
que hay que decir— **empieza la secuencia en algo que ya está escrito**.

### 14.1 Dónde está cada etapa, medido el 2026-09-21

| # | Etapa del plan | Estado real | Dónde |
|---|---|---|---|
| 1 | Responsabilidades y autorizaciones | 🧪 **escrito, sin mergear ni aplicar** | 7 llaves (§6) + mig `20260919160000` de reparto |
| 2 | Validar la información disponible | 🟡 **parcial** — las fuentes están identificadas; **falta la "fecha de actualización visible"** | §1 · ver 14.5(3) |
| 3 | Rutas de abastecimiento | ⚠️ **ya existe** — ver 14.6 | `commercial.replenishment_channel` (RA-PRO.8, mig `20260720120000`) |
| 4 | Mínimos, reorden y máximos | ✅ motor · ⬜ la **propuesta con vigencia** | `commercial.reorder_policy` (RA) + §4.1 |
| 5 | Demanda y temporalidad | ⛔ **bloqueado por la historia**, no por el código | §0 · §12 (Fase NH) |
| 6 | Motor de sugerencias | ✅ existe **y ya parte el origen** en `transfer_in` + `buy_qty` | `criticalStock()` |
| 7 | Mesa del almacenista | 🧪 **escrita, sin mergear** | rama `feat/ab-mesa-trabajo` |
| 8 | Revisión del encargado | ⬜ | AB.6 |
| 9 | Solicitudes y seguimiento | ⬜ | AB.7 (compra) · AB.8 (traspaso) |
| 10 | Supervisión de zona | ⬜ **NUEVO — no estaba en este plan** | → AB.10 |
| 11 | Piloto | ✅ decidido: almacén `02` | §7.1 |
| 12 | Desplegar y medir | ⬜ **NUEVO** | → AB.11 |

### 14.2 Los 10 PRs contra lo que ya está escrito

| PR del plan | Estado real | Nota |
|---|---|---|
| **1** ruta `/almacen/autoabasto` + permisos | ✅ **escrito** | rama `feat/ab-mesa-trabajo`, **sin pushear** |
| **2** acceso en la navegación | ✅ **escrito, en el mismo PR** | se entregan juntos a propósito: **una ruta sin puerta no se puede probar**, y el reparto de permisos sólo se comprueba viendo quién ve el item |
| **3** rutas, calendarios y parámetros | ↩️ **cambia de alcance** | no es tabla nueva: es **pantalla de administración sobre `replenishment_channel`** + prioridad, orígenes alternos y excepción por producto |
| **4** consulta y validación de datos | ⬜ | acá entra la **fecha de actualización** de la etapa 2 |
| **5** motor en simulación | ✅ **ya se cumple** | el motor de RA calcula y **no emite documentos**; la mesa es de sólo lectura |
| **6** mesa y preparación de solicitudes | 🧪 la mesa sí; **preparar la solicitud no** | la parte de preparar es AB.7 |
| **7** autorizaciones y cambio de parámetros | ⬜ | AB.6 |
| **8** solicitudes a Compras | ⬜ | AB.7, sobre `purchase_requisitions` (no se crea entidad) |
| **9** traspaso habitual | ⬜ | AB.8, `transfer_requests` — **lo único del modelo que sigue siendo tabla nueva** |
| **10** seguimiento, alertas y zona | ⬜ | AB.8 + AB.10 |

> **Cuatro de los diez PRs ya están resueltos o cambian de alcance.** Arrancar en el 1 sería volver a
> escribir lo que está en la rama.

### 14.3 El contrato de los siete porqués — se acepta, y se vuelve criterio de aceptación

Es el aporte más valioso del plan nuevo: convierte la pantalla en algo **falsable**. Medido contra el
código de hoy, renglón por renglón:

| Pregunta | Qué la contesta | Estado |
|---|---|---|
| ¿Por qué debo pedir? | `bucket` (agotado / bajo mín / bajo reorden) | 🟡 **es una etiqueta, no una frase** |
| ¿Por qué esa cantidad? | `suggested_qty = objetivo − existencia − tránsito`, ajustado por caja | 🟡 el número sí; **la resta no se muestra** |
| ¿Por qué a ese origen? | `replenish_via` · `source_warehouse_code` · `supplier_name` | ⛔ **el motor los devuelve y la pantalla NO los pinta** |
| ¿Por qué debo pedir hoy? | `next_due_date` · `cadence_days` · `lead_time_days` | ⛔ **idem** |
| ¿Por qué mover el parámetro? | — | ⬜ AB.6 |
| **¿Por qué NO propone pedir?** | — | ⛔ **no hay renglón**: la mesa sólo lista lo que falta |
| ¿Por qué requiere revisión? | `rung_veredicto` declara la unidad | 🟡 falta pedido mínimo, caducidad y excepción |

⭐ **El sexto es el más caro y el más importante.** Hoy un producto cubierto **no aparece en la mesa**, así
que *"lo revisé y está cubierto"* y *"nunca lo miré"* se leen exactamente igual. Es la trampa de ADR-056
en su forma más pura —la ausencia significando dos cosas— y obliga a que la mesa tenga un modo que hoy no
tiene. **No se resuelve pintando un renglón vacío: hay que decir con qué existencia o con qué entrega
confirmada está cubierta.**

**Medido:** `autoabasto.service.ts` tipa y la tabla pinta `suggested_qty`, `transfer_in`, `buy_qty` y
`bucket`. **No** tipa `replenish_via`, `source_warehouse_code`, `next_due_date` ni `lead_time_days` —
aunque `criticalStock()` los selecciona y los está devolviendo. El hueco de "a quién" y "para cuándo" es
**de pantalla, no de motor**.

### 14.4 ⛔ El primer compromiso verificable — por qué hoy no se puede demostrar

El plan lo fija bien: *"para un producto y una sucursal, explicar correctamente cuánto pedir, a quién y
para cuándo"*. Medido contra `platform_test` el 2026-09-21:

| Pieza | Estado | Número |
|---|---|---|
| **cuánto** | ✅ el motor lo calcula y lo parte en compra vs traspaso | — |
| **a quién** | 🟡 el campo existe; **la tabla está vacía** | `commercial.replenishment_channel` = **0 filas** |
| **para cuándo** | 🟡 idem — `next_due_date` y `lead_time_days` viven en esa misma tabla | **0 filas** |
| base de parámetros | ⚠️ apenas semilla de pruebas | `commercial.reorder_policy` = **35 filas · 4 almacenes · 0 con `policy_method`** |

**No falta código: falta el dato en este entorno.** `platform_test` no tiene corrido
`import-replenishment-cadence.js` ni los importers de política. En prod la Fase RA **sí** está desplegada,
pero **desde esta máquina no hay credencial de prod** — el `.env` sólo trae `platform_test`. Es la misma
medición que AB.0 ya declaraba pendiente, ahora con el número que le faltaba.

**Lo que desbloquea la demostración, en este orden:**
1. correr AB.0 **contra prod** (cuántas filas de canal y de política hay de verdad, y en qué almacenes);
2. llevar `replenish_via` / `source_warehouse_code` / `next_due_date` / `lead_time_days` **a la pantalla**
   (es tipado y columnas, no motor);
3. poblar el canal del almacén del piloto si prod tampoco lo tiene.

⚠️ **Hasta que (1) esté corrido, cualquier fecha comprometida sería inventada.** El plan tiene razón en no
fijarlas todavía.

### 14.5 Lo que el plan nuevo agrega y este documento no tenía

1. **Etapa 10 — supervisión de zona.** Sprint nuevo **AB.10**: comparativo entre sucursales, agotados
   recurrentes, solicitudes detenidas y entregas atrasadas, **con responsable y fecha compromiso**. Es la
   primera pieza de la fase con audiencia de *gerente de zona*, que hasta ahora no existía en el diseño.
2. **Etapa 12 — desplegar y medir.** Sprint **AB.11**: incorporación por sucursal y marca + indicadores.
   Sin esto la fase no tiene forma de saber si sirvió.
3. **Etapa 2 — "con fecha de actualización visible".** ⭐ No se inventa: es exactamente ADR-056 / Fase VP.
   Se consume `libs/contracts/http/provenance.contract.ts` (VP.2.1) y se declara `unknown` cuando no se
   pudo medir — **nunca un "actualizado hace 2 min" leído del reloj del navegador**, que es el error que
   VP.0 ya encontró en 21 de 24 píldoras.
4. **El renglón "por qué NO propone pedir"** (14.3), que cambia la forma de la mesa.

### 14.6 ⚠️ Lo que se corrige de este documento

**`commercial.supply_policy` queda cancelada como tabla nueva.** El §5 la proponía para la etapa 3. Medido:
`commercial.replenishment_channel` (RA-PRO.8, mig `20260720120000`) **ya modela lo mismo** — `via`
(`purchase` / `transfer`), `source_warehouse_id`, `cadence_days`, `next_due_date`, `last_delivery_date`,
`lead_time_days`, `health_band`, y un `cadence_source='manual'` que **protege el override humano de que el
job lo pise**. Crear `supply_policy` sería una segunda materialización del mismo hecho: exactamente lo que
la regla ⭐ del proyecto prohíbe.

**Lo que sí falta, y por lo tanto es el alcance real del PR 3:**

| Del pedido | En `replenishment_channel` |
|---|---|
| origen preferente | ✅ `via` + `source_warehouse_id` |
| calendario | ✅ `cadence_days` + `next_due_date` |
| tiempo de entrega | ✅ `lead_time_days` |
| **prioridad** | ❌ |
| **orígenes alternos** | ❌ |
| **excepción por producto** | ❌ — el grano es (almacén × **proveedor**) |

⚠️ **Y una medición pendiente antes de tocar el grano:** el pedido pide (sucursal × **marca/línea**), la
tabla es (almacén × **proveedor**). Si en este catálogo proveedor ≈ marca, no hay nada que agregar; si no,
agregar grano a una tabla que un job reescribe cada noche necesita decidir antes quién gana. **Se mide, no
se asume.**

### 14.7 Sprints que se agregan

| # | Sprint | Qué cierra |
|---|---|---|
| **AB.3b** | Los porqués en la mesa | 14.3: origen y fecha a la pantalla, la resta a la vista, el renglón de "cubierto", y la procedencia del dato |
| **AB.10** | Supervisión de zona | Etapa 10: comparativo, recurrentes, detenidas, atrasadas — con responsable y fecha compromiso |
| **AB.11** | Despliegue y medición | Etapa 12: incorporación progresiva + indicadores de disponibilidad vs inventario |

---

## 15. Pedido de la semana y regla de redondeo — decidido 2026-10-07

> Decisiones de Francisco (2026-10-07). Esto es el alcance de **AB.7 + AB.8** del lado del almacenista:
> cómo **arma** su pedido. La bandeja del comprador y la confirmación del origen siguen como estaban.

### 15.1 La interfaz: el sistema prepara, el almacenista revisa

- **Dos revisiones fijas por semana por sucursal** (p. ej. lunes y jueves, configurables). Ese día el
  sistema deja un **borrador** armado desde la mesa y lo publica como tarea en «Mi trabajo»
  (contrato de tarea, ADR-061/081). El almacenista no arma el pedido desde cero.
- **Agrupado por a quién se le pide**: un grupo por sucursal de origen (→ `transfer_requests`, AB.8) y uno
  por proveedor (→ `purchase_requisitions`, AB.7). Cada grupo se envía como un pedido aparte.
- Por renglón: existencia · falta · **ya pedido** · **sugerido (redondeado)** · **a pedir** (editable,
  prellenado) · banda (§6.1, recalculada al teclear). Cambiar el sugerido pide **motivo** de lista cerrada.
- Por grupo: subtotal en cajas y en pesos + **mínimo de pedido** del proveedor (`min_order_boxes`) con aviso
  si no se alcanza. Encabezado: consumo del **tope en pesos**.
- Se puede **agregar** un producto que el sistema no sugirió (con motivo).

⛔ **«Ya pedido» es lo que hace posible revisar dos veces por semana.** Hoy el motor resta sólo las OC de
Kepler (`X-A-35` sin `X-A-40`). Lo solicitado en la Suite que todavía no es OC **no se resta**: el jueves
volvería a sugerir lo que se pidió el lunes. El sugerido tiene que quedar neto de las solicitudes abiertas.

⛔ **Prerrequisito: repartir el sobrante de la red.** La mesa le ofrece el sobrante completo a **cada**
sucursal que lo necesita. Medido en prod el 2026-10-07: **1,819 de 4,157** productos con traspaso están
prometidos de más — **600,689 unidades prometidas contra 443,869 que existen** (+35%). En lectura era un KPI
inflado; con solicitudes reales serían dos sucursales pidiéndole al mismo origen las mismas cajas. El
reparto respeta la decisión #7 (el origen cede **hasta su punto de reorden**).

### 15.2 La regla de redondeo

Sobre la cantidad que falta, expresada en la **unidad mayor** (la caja):

| Falta (en unidad mayor) | Se pide |
|---|---|
| **menos de 0.5** | en la **unidad inmediata menor** (0.3 caja de 12 → 3.6 → **4 pz**) |
| **0.5 o más** | **sólo unidades mayores completas**, redondeando: fracción ≥ .5 sube, < .5 baja |

Ejemplos (caja de 12): 0.3 → **4 pz** · 0.5 → **1 caja** · 0.8 → **1 caja** · 3.3 → **3 cajas** ·
3.5 → **4 cajas** · 5.7 → **6 cajas**. **Nunca se mezclan** cajas y piezas en un mismo renglón.

- El redondeo se calcula **en el servidor, en un solo lugar**: el borrador, la requisición y lo que ve el
  comprador traen la misma cantidad. La pantalla muestra el faltante sin redondear al lado, para que la resta
  se pueda auditar.
- En la unidad menor se redondea al entero más cercano (.5 sube); si da 0, el renglón no se pide.
  ✅ Confirmado 2026-10-07.
- **Granel: kilos completos** (✅ 2026-10-07). Misma regla: 7.4 kg → 7 · 7.5 kg → 8.

### 15.3 La unidad inmediata menor — de dónde sale, medido 2026-10-07

La escalera está en `analytics.v_product_unit_ladder` (Kepler `kdii`: base `c11` · peldaño 2 `c80`/`c81` ·
peldaño 3 `c83`/`c84`, factores contra la base). Sobre los **6,344 SKUs activos con política**:

| Escalera | SKUs | Unidad inmediata menor | Regla |
|---|---:|---|---|
| dos peldaños (base + caja) | 5,061 | la base | aplica |
| tres peldaños | 373 | el peldaño del medio | aplica |
| sólo base | 585 | — (ya es la menor) | **no aplica**: se pide en la base |
| sin escalera | 325 | — | **se declara**, no se redondea |

La unidad menor resultante: **PAQ 4,426 · PZA 1,239 · KG 277** · gramajes capturados como número (`500`
38, `250` 9, `400` 2) · CJA 16 · CUB 5 · BTO 4 · SER/IND 3 · vacío 17. O sea **la «pieza» de la mayoría
del catálogo es el paquete**.

**Abierto:**
1. ✅ **Granel: kilos completos** (2026-10-07). Sigue abierto el caso de la decisión #15: la tercera unidad del granel **vivía como otro código** (bulto → kg → 500 g) — si la
   unidad menor es otro SKU, el renglón cambia de producto, no sólo de unidad.
2. **Los 16 con `CJA` como unidad menor** (la mayor es más grande: bulto, pallet) y los 17 vacíos: revisar
   a mano antes de prender la regla.
3. **Wincaja**: la escalera es de Kepler. Los almacenes que siguen en Wincaja guardan en su unidad de venta
   (ADR-055); tras el corte del 30-sep la mayoría ya es Kepler, pero se verifica por almacén.

### 15.4 ✅ [AB.12] El reparto del sobrante — EN CÓDIGO 2026-10-07

Prerrequisito de §15.1 resuelto. `transfer_in` deja de ser el sobrante de red entero y pasa a ser la parte **proporcional** de cada sucursal (`networkSurplus()` + `transferIn()`, el mismo reparto que `transferPlan()`). Medido con el método real contra prod: Σ traspaso de la red = **445,017** = lo que existe (antes 600,838). Candado `database/tests/test-newdb-autoabasto-reparto.js` (6 ✔, con negativo sintético y negativo real). De paso se arregló `summary()`, roto desde [VA.4]. Siguen abiertos de la revisión: el buscador del resumen filtra por **proveedor**, «Hay que comprar» suma renglones que la mesa no lista (1,062), y `excedente_cedible` todavía es sobre el **máximo**, no sobre el punto de reorden (decisión #7) — cambio de alcance, va en commit aparte.

### 15.5 🧪 [AB.13] El reporte PDF y el alcance por almacén — EN CÓDIGO 2026-10-07

⚠️ **El frontend de AB.13 se perdió el 8-oct** (`fcf85959c`, `[SUC.1]`, hecho sobre una copia anterior a #314) y se restauró en `[AB.14]`.

`GET /commercial/autoabasto/reporte` + botón «Descargar PDF». Sello de fecha y hora del **servidor** (hora de México) y usuario; un solo almacén por reporte; sólo lo que falta, agrupado por origen; «sin venta medida» aparte. El alcance de la mesa se resuelve en el área **Almacén** (ZN.8), y la mig `20261007200100` da `AUTOABASTO_VER` al almacenista + la regla `warehouse · almacen · own`. Simulado como almacenista con el código real (ver log 2026-10-07). **Abierto:** 5 de 6 almacenistas sin almacén en su ficha; el reporte de Padre Hidalgo son 96 páginas — la regla de redondeo (§15.2) y limpiar códigos `* DESC…`/servicios de las políticas lo achican.

### 15.6 🧪 [AB.14] Arreglos menores tras la revisión del módulo — EN CÓDIGO 2026-10-12

Revisión del módulo con Francisco (2026-10-12). Cuatro arreglos, sin migración ni permisos:

1. **Se restaura el frontend de AB.13.** `fcf85959c` (`[SUC.1]`, 8-oct) se hizo sobre una copia de la
   pantalla anterior a #314 y borró el botón «Descargar PDF», los avisos de alcance y la fijación del
   almacén único. El endpoint `/reporte` seguía vivo y nadie lo llamaba. Se conservan los nombres de
   sucursal que SUC.1 sí quería poner.
2. **El tránsito.** Desde `[RA.TR]` (9-oct, `transito.ts`) la política es `ignorar`: el sugerido NO resta
   lo que está en camino. El subtítulo, el «por qué» de *Falta* y las notas del PDF decían lo contrario.
   `criticalStock()` publica ahora `politica_transito` + `aviso_transito` y los tres textos la siguen.
3. **Filtro «Acción» en el servidor.** Se recortaba la página cargada (total ≤ 50). Una sola expresión
   (`accionExpr()`) pinta la columna y filtra. `sobrante` y `ok` quedan fuera del recorte crítico por
   defecto (existencia ≤ reorden), que los volvía imposibles de encontrar. Con el filtro puesto el
   conteo suma sólo `rpl` + el reparto `sbp` (y el canal con base por cadencia), no el ranking ni
   las tablas de decorado. Medido en prod (un almacén, página de 50): contar sobre la consulta
   completa llevaba la página de 3.0–4.8 s a **6.4–9.8 s**; con el conteo ligero, **3.3–5.3 s**, y
   los totales salen idénticos en los dos (01: 376 traspaso / 1,576 sobrante · 02: 321 / 1,399 ·
   red: 10,973 sobrante = KPI «Sobrestock»). ⚠️ La página sin filtro **ya tardaba 3–5 s** antes de
   este cambio; es deuda aparte del listado (13 relaciones + ranking).

**Validación en pantalla (2026-10-12, API local contra prod en solo lectura):** aviso de tránsito ✓ ·
alcance «20 almacenes» ✓ · nombres de sucursal ✓ · La Piedad + Traspaso → 321 renglones en varias
páginas ✓ · PDF habilitado con un almacén, generado en 6 s con la nota «NO se descuenta» y sólo
traspasos ✓ · tooltip de *Falta* sin «− en camino» ✓. Visto de paso: el tooltip muestra
«0.3 − 0.1 = 0.3» por el redondeo a un decimal en cajas (preexistente; lo resuelve §15.2).
4. **El resumen busca por producto** (`product_search`). En `summary()` `search` sigue siendo por
   proveedor, que es como lo usa Compras.

### 15.7 Revisión de la lógica de negocio — medido en prod (solo lectura) 2026-10-12

**Red de abasto, configurada como la describe el negocio** (`replenishment_channel`): 02, 03 y 04 se
surten de la 01; la 05 de la 06; la 07 de la 08; 01, 06 y 08 del 00. Matrices: **00, 01, 06, 08**.

**El mín/máx dinámico vigente es el motor de `/compras/pedido`, y SÍ está corriendo — pero Autoabasto
no lo usa.** (Corregido el mismo 2026-10-12: primero se buscó como `reorder_policy.source='dynamic'`,
que es el contrato de `FASE_RA_PEDIDO_PERSPECTIVA` Etapa 5, y ahí hay 0 filas; Francisco señaló que el
dinámico es el de `/compras/pedido`.) `workbook()` NO lee `reorder_policy` para decidir: calcula el
objetivo al vuelo como **venta limpia de 30 días** (`analytics.product_demand`, ventana anclada por
almacén) **× temporalidad** (`replenishment_plan.season_ratio` = índice de los próximos 30 d ÷ últimos
30 d) **× días de cobertura** (30 por default), con demanda dependiente en las matrices. El fact se
recalcula cada noche (`fact_replenishment_plan_nightly`, ok 2026-10-12 03:36 MX) y durante el día al
cambiar la existencia (`fact_replenishment_plan_stock`, ok). Es diario, no semanal.

**Autoabasto usa otro número**: `reorder_policy.max_stock` de `import-computed-reorder.js` (venta de
**90 días**, colchón por nivel de servicio, ciclo de 14 d). Comparado contra el objetivo de
`/compras/pedido` (aproximado: cobertura 30 d, sin factor de surtido), por sucursal:

| | 01 | 02 | 03 | 04 | 05 | 06 | 07 | 08 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| mediana máx Autoabasto ÷ objetivo Pedido | 1.52 | 1.12 | 0.97 | 1.25 | 1.24 | 1.43 | 0.99 | 1.29 |
| % que difieren más de 25% | 79.5 | 69.1 | 70.4 | 69.2 | 73.5 | 76.5 | 70.2 | 72.8 |
| Autoabasto pide y Pedido no (sin venta 30 d) | 1,383 | 1,515 | 1,564 | 1,056 | 1,261 | 905 | 406 | 301 |

O sea: **el almacenista y el comprador ven objetivos distintos para el mismo producto**, lo que la propia
mesa promete evitar («dos audiencias, un solo número»). Además `reorder_policy` arrastra dos huecos:
no recalcula las 1,485 políticas `kepler` de 02–05 (fijas desde julio/agosto) ni retira las de productos
que dejaron de vender. **Siguiente paso:** que Autoabasto tome el objetivo del motor de `/compras/pedido`
(venta 30 d × temporalidad), que es justo lo que pide el negocio.

**⛔ El CEDIS 00 no tiene existencia desde el 29-sep**: 196 renglones en `commercial.stock` contra 5,046
en `kepler_ods.kdil`. `import-branch-stock-live.js` lo excluye porque «viene de Wincaja», y Wincaja dejó
de alimentarlo con el corte del 30-sep. Sale agotado en 5,754 de 5,930 productos y no aporta a la
nivelación. Coordinar con la sesión de `IC.CEDIS`.

**Parámetros:** fuera del 00, sólo el 9.5% de los productos está entre reorden y máximo; 36% arriba del
máximo y 33% agotado.

**Decisiones de Francisco (2026-10-12)**, para la vista de matrices (Nivelación):
- **Cuánto cede la matriz:** lo que pasa del **máximo** se propone siempre; lo que está entre **reorden y
  máximo** sólo si hay una sucursal **agotada**. (Afina la decisión #7.)
- **Alcance en dos capas:** capa 1 = la matriz con **sus** sucursales; capa 2 = **toda la red**.
- **Mín/reorden/máx:** lo define el módulo del PM; acá sólo se verifica que esté vigente (ver arriba).

**Siguiente:** vista «Mi pedido» para sucursales que no surten a otras (por origen, venta 30d, negados
de la Fase DN, ya pedido, cubiertos, redondeo §15.2) → Nivelación de matrices → guardar el pedido
semanal (AB.7/AB.8) → aprendizaje.

### 15.8 🧪 [AB.15] «Cuánto pedir» igual que /compras/pedido — EN CÓDIGO 2026-10-12

**Decisión de Francisco (2026-10-12):** Falta se calcula igual que la cantidad a pedir de Compras;
cobertura de **30 días fijos**; el mín/reorden/máx dinámico sigue decidiendo el semáforo y el sobrante.

- **Base nueva `'demanda'` en el motor** (`demandTarget()`): `daily_pieces × season_ratio × 30 ÷
  (SUF × BF) × DBF`, con los COALESCE de `workbook()` copiados tal cual, en la unidad nativa del
  almacén. Es el default de los tres endpoints de Autoabasto; Compras sigue en `'max'`.
- **Lo que `workbook()` aplica y esto no:** el factor de cumplimiento del proveedor (FILLF) —es una
  corrección del comprador— y retener el renglón cuando el peldaño está contradicho (acá se retiene
  sólo el $, como en el resto de la mesa).
- **La existencia también es la de Compras** (`onHand('plan')` = `replenishment_plan.stock_pz`, que
  deriva de `v_erp_stock_on_hand`). El CEDIS cambió de base el 30-sep (Wincaja → Kepler) y la vista lo
  toma de Kepler sólo desde ese corte; la copia `commercial.stock` que leía Autoabasto se quedó con la
  foto de Wincaja del 29-sep (196 renglones). Cruce contra `workbook()`: **CEDIS 208/208 y La Piedad
  2,777/2,777 iguales** (ej. bombón 70014: CEDIS 80, La Piedad 9). Compras (`/compras/existencia`) no
  cambia: su base sigue leyendo la copia.
- ⚠️ **Lo que el CEDIS tiene mal es de Kepler, no de la Suite** (compuerta `check-cedis-cutover.js`,
  2026-10-12): 10 productos en negativo desde el corte (−20,722 u; el agua 59108 en −13,410: recibió
  11,070 y sacó 24,480 sin inventario inicial), 71 productos de Wincaja que no entraron bien ($568,567,
  6.9%) y 7 donde la carga se sumó a un saldo previo. Se corrige en Kepler (IC.CEDIS / operación).
- **Columna «Venta 30 d»** (misma cuenta que «V30d» de Compras) y el «por qué» de *Falta* dice que el
  objetivo es la venta de 30 días × temporalidad. Nota equivalente en el PDF.
- **Vista por defecto = sólo lo que tiene algo que pedir.** Con el objetivo de Compras, el recorte
  crítico (existencia ≤ reorden, de la tabla de reorden) dejaba pasar renglones con Falta 0: en La
  Piedad 1,155 de 2,003, 1,142 de ellos sin venta en 30 días. Siguen visibles con «En política».

**Cruce contra `workbook()` (prod, solo lectura, La Piedad, 1,163 productos en las dos pantallas):**
venta 30 d igual en **1,163/1,163**; existencia igual en 1,158; Falta = pedido de Compras sin el
factor de cumplimiento en **1,142 (98.2%)**. Las diferencias: existencia en vivo contra la foto del
fact, y renglones que Compras deja en blanco por peldaño contradicho.

**Tiempos** (página de 50): vista por defecto 4.0–4.8 s por almacén, red 6.4 s; «En política» hasta
7.2 s (sin el recorte crítico recorre todas las políticas del almacén).

**Pendiente de esta línea:** los días de cobertura de «Entrega» siguen usando la venta diaria de 90
días (`inventory_health`), no la de 30; y el máximo de la tabla de reorden puede quedar corto contra
la demanda (ej. Japonés granel 20 kg en Morelia Abastos: máx 125 cajas, objetivo 175.4).

### 15.9 🧪 [AB.16] «Mi pedido» — EN CÓDIGO 2026-10-12

Primera entrega de §15.1, **sólo lectura y sin tablas nuevas**: pestaña `/almacen/autoabasto/pedido`
+ `GET /commercial/autoabasto/pedido?warehouse_id=` (`AutoabastoPedidoService`). No calcula el
reabasto: toma los renglones de la mesa (base `'demanda'`, AB.15) y les agrega lo que la mesa no sabe.

**Decisiones de Francisco (2026-10-12):**
- **«Ya pedido» = pedidos abiertos a la matriz de 7 días o menos**; se restan. Los más viejos son
  **atorados**: se marcan para reclamarlos o cancelarlos y **no** se restan (medido: 29 de 77
  abiertos tenían más de 7 días).
- **Lo negado se muestra y se marca**, sin cambiar el sugerido.

**De dónde sale (derivado del ODS, cero importers):** el pedido de una sucursal a su matriz vive en
Kepler como `U-D-40` de la MATRIZ al cliente `TI…` de la sucursal (`c27='SUCURSAL'`; código TI de
`analytics.v_erp_branch_catalog`). Versión vigente por `DISTINCT ON … c9 DESC`, renglones anclados a
`c1` (mismo criterio que `warehouse-orders.service.ts`). Ya pedido = `kdm2.c9` (unidad base) de los
abiertos; negado = `(c51 − c54) × c9 / c56` de los EMBARCADOS del periodo. ⚠️ Que `c51` sea siempre lo
pedido originalmente sigue siendo la hipótesis sin arbitrar de FASE_DN. ⚠️ Kepler no decodifica
«cancelado» en `c11`: un pedido abierto sin renglones no suma (los 2 abiertos de la 01 a la 02 estaban
vacíos).

**Redondeo §15.2** como función pura `redondearPedido()` en `libs/contracts` (14 pruebas con los
ejemplos del documento): menos de media caja → unidad inmediata menor (el peldaño del medio si hay
tres); media caja o más → cajas completas (.5 sube); granel → kilos completos; sólo base → entera;
**sin escalera → se declara sin redondear**. Escalera = `analytics.v_product_unit_ladder`.

**Agrupado por origen** (`replenishment_channel`: matriz por traspaso, o proveedor), con total en cajas
—**sin sumar como cajas lo que no tiene caja**: el primer cálculo daba «2,837 cajas» a 3 churros que se
venden por pieza—, valor a costo (sólo renglones valuables) y aviso de pedido mínimo del proveedor. ~~Descarga en Excel por
grupo~~ — **retirada en AB.18** (§15.11): el pedido se ajusta y se guarda dentro de la Suite.

**Medido contra prod (solo lectura):** Morelia Madero 814 renglones a pedir en 55 orígenes, $932 mil;
121 con pedido abierto, 27 atorados, 7 negados. La consulta de pedidos tarda 56–137 ms; el endpoint
completo 3.7 s (lo que cuesta es la mesa). Ej.: charola 94156 — falta 84.7, ya pedido 50 → **35 CJA**.

**Abierto:**
- ~~El granel con caja se pide en kilos~~ — **resuelto en AB.19** (§15.11): con unidad mayor sigue la
  misma regla que lo demás.
- Lo embarcado y no recibido todavía no cuenta como «ya pedido» (pareo `U-D-41` ↔ recepción).
- La mesa sigue rotulando «cajas» a productos que sólo tienen pieza (factor 1): es anterior a AB.16.
- Guardar el pedido en la Suite, el borrador de dos veces por semana y el aprendizaje (AB.7/AB.8).

### 15.11 🧪 [AB.18]–[AB.20] «Mi pedido» se ajusta en la Suite, sin Excel — EN CÓDIGO 2026-10-12

**Decisión de Francisco (2026-10-12):** nada de Excel ni papel. El sistema arma el pedido, el
almacenista corrige **excepciones** (meta: no más de 20% de los renglones) apoyado por el sistema, y
cada decisión deja **huella** para estudiar el comportamiento y alimentar el aprendizaje. **Por
etapas:** (1) ajustar y guardar en la Suite ← esta entrega · (2) enviar a la matriz —que lo captura en
Kepler **asistida**, la Suite liga por folio— y a Compras como requisición · (3) seguimiento contra
Kepler · (4) aprendizaje.

**[AB.18] Ajustar y guardar.**
- **− / +** en la unidad de captura del renglón (`pasoAjuste`); el factor sale del redondeo
  (`RedondeoPedido.factor`), la pantalla no lo adivina.
- Si el ajuste se aleja **más de 20%** del sugerido (o se pide algo que el sistema no sugirió, o se baja
  a 0), pide **motivo con un clic** de una lista cerrada (`MOTIVOS_AJUSTE`: espacio en bodega, viene
  promoción, cliente apartó, producto lento, caducidad, exhibición, otro). Un texto libre no se aprende.
- Guardado automático al dejar de mover (700 ms); «volver» al sugerido; «Aceptar grupo» reemplaza al
  Excel. Valor y totales en vivo con `costo_base`.
- **Tablas** (mig `20261012215125`, RLS forzado): `commercial.autoabasto_pedidos` (UN borrador vivo
  por almacén, índice único parcial; `motor` = con qué se calculó) · `autoabasto_pedido_lineas` (SÓLO
  los renglones tocados: lo no tocado es el sugerido del motor) · `autoabasto_huella` (cada evento con
  sugerido visto, antes, después, motivo y ms en el renglón; **sólo se inserta**).
- ⛔ **El privilegio por omisión del schema `commercial` le da a `app_runtime` UPDATE/DELETE en toda
  tabla nueva** (`{app_runtime=arwd/postgres}`): con sólo `GRANT SELECT, INSERT` la huella se podía
  reescribir. Lo encontró el smoke; la migración hace `REVOKE UPDATE, DELETE, TRUNCATE` explícito.
- **Permiso:** `almacenista` (7 personas) tenía `AUTOABASTO_VER` pero no `AUTOABASTO_SOLICITAR`; la
  migración se lo da donde la clave está vacía (un `false` explícito no se pisa).
- Sin las tablas (la migración no ha llegado) el pedido se sirve igual y lo **declara**
  (`guardado_disponible: false`); las escrituras responden **503** con mensaje, no 500. Se pregunta con
  `to_regclass` porque un SELECT fallido abortaría la transacción.

**[AB.19] Hasta dónde pide y en qué lista se surte.**
- **Granel con unidad mayor** (caja, bulto) sigue la misma regla: media unidad mayor o más → mayores
  completas; menos → kilos. Sin unidad mayor, kilos completos. Medido: **212 de 308** productos a granel
  tienen unidad mayor.
- **«¿Hasta dónde pides?»**: casillas Agotado · Bajo mínimo · Bajo reorden (default las tres) y
  «Sobre reorden, con venta» (apagada: lo que el motor de demanda pide aunque la existencia ya esté
  sobre el reorden). La selección **se guarda en el borrador** (`posiciones text[]`, con CHECK) y deja
  huella `posiciones` con antes/después: elegir sólo lo agotado es una decisión, no un filtro.
- **Cada origen se parte en listas de surtido** (`RedondeoPedido.clase`): **unidad mayor** (una orden
  de cajas/bultos) · **unidad menor** (otra de piezas/paquetes/kilos) · **una sola unidad** · sin
  unidad en Kepler. Así surtía la matriz: una orden de cajas y otra de piezas.

**[AB.20] Mínimo de $200 en unidad menor.** Un renglón en unidad menor de un producto que SÍ tiene
caja y vale menos de **$200** no se pide (`aplicarMinimoMenor`); queda en su unidad menor para que el
**+** lo pida si hace falta. **Excepción: un agotado se pide siempre.** Sin costo confiable el mínimo
no se puede revisar: el renglón se queda y se marca «Mínimo sin revisar» (no se supone). Cajas
completas y productos de una sola unidad no se tocan.

**Simulación contra prod (solo lectura, API local, 2026-10-12): 32,174 revisiones, 0 fallas**, 9
almacenes, ~7,400 renglones, 3.5–4.9 s por sucursal. Por sucursal, renglones en menor que el mínimo
quitó / agotados de poco valor que se piden igual: 01 113/133 · 08 54/109 · 07 86/116 · 03 78/86 ·
02 132/153 · 04 110/116 · 06 98/134 · 05 62/111. El almacenista sólo ve su almacén y no abre uno ajeno.
Docker (`app_runtime`, RLS): 13/13 (un solo borrador, el 2º ajuste reemplaza, huella no se reescribe,
motivo/cantidad/posición inválidos rechazados, otro tenant no ve nada).

**Hallazgo de datos:** **5 de 6 almacenistas activos NO tienen almacén asignado** en su ficha (sólo
`luis_espino` → 01): la pantalla les dice «No tienes almacén asignado». Se asigna desde Personas.

**Abierto:** etapa 2 (envío a la matriz con captura asistida + requisición a Compras), 3 y 4; el
mínimo de $200 no aplica a mayor ni a «una sola unidad» (decisión, se puede extender).

### 15.12 🧪 [AB.21] PDF de «Mi pedido» para la captura manual — EN CÓDIGO 2026-10-13

**Pedido de Francisco (2026-10-13), con AB.18–AB.20 ya en prod:** mientras llega la etapa 2, el
almacenista necesita el papel para capturar el pedido en Kepler en la sucursal que lo surte, o para
mandarlo como requisición de compra al proveedor.

- Botón **PDF** en cada origen y **«PDF de todo el pedido»** arriba (cada origen en su hoja).
- Título según el origen: **«Pedido de traspaso entre sucursales»** (matriz) o **«Requisición de
  compra a proveedor»**; caja con quién pide, a quién, fecha/hora del cálculo (del servidor) y quién
  elaboró.
- **Una tabla por lista de surtido** (orden de unidad mayor / unidad menor / una sola unidad), en el
  **orden de captura** (Francisco, 2026-10-13): SKU · **Pedir** · **Unidad** · Producto · existencia y
  venta 30 d en cajas · valor · **Aviso**. Es hoja de transcripción y análisis: la columna en blanco
  «Surtido/Recibido» se retiró por no aportar, y «Aviso» lleva la nota del renglón (ajustado con el
  sugerido y el motivo, agotado de poco valor, atorado, negado).
- «A LA SUCURSAL» / «AL PROVEEDOR» va **del mismo tamaño que «PIDE»** en la caja del encabezado
  (`cajaTitulo2`, opcional en `compras-pdf-comun`; los demás PDF no cambian).
- Imprime **exactamente** lo que lleva el pedido en pantalla: posiciones marcadas, ajustes guardados o
  en curso y el mínimo de $200. Sin costo → «sin medir», nunca $0. Aviso del mínimo del proveedor.
- Firmas: matriz → Elaboró / Surtió (sucursal que abastece) / Recibió; proveedor → Elaboró / Autorizó
  (Compras) / Recibió. Pura vista: **sin migración ni permiso nuevo**; el PDF se arma en el navegador.
- `mi-pedido-pdf.ts` reusa `compras-pdf-comun` (encabezado, recuadros, notas, pies). Candado
  `mi-pedido-pdf.spec.ts` (5) corre el dibujo **real** de jsPDF y lee lo escrito; visto en rojo al
  cambiar «sin medir» por $0. Suite `almacen` 440/440.

**Abierto:** la huella no registra que se imprimió (el CHECK de `autoabasto_huella.evento` no tiene
`imprimir`; necesita migración); con la etapa 2 el PDF deja de ser el camino principal.

### 15.13 🧪 [AB.22] Cobertura por almacén: 21 días sucursales, 2.5 días rutas — EN CÓDIGO 2026-10-13

**Decisión de Francisco (2026-10-13):** el objetivo por demanda (`venta diaria × temporalidad ×
cobertura`) deja los 30 días fijos de AB.15 y toma la cobertura **por almacén**:
- **21 días**: 02 La Piedad Abastos · 03 8 Esquinas · 04 Yurécuaro · 05 Zamora Centro · 07 Morelia Madero;
- **2.5 días**: rutas `RUTA-21/22/23/26/27/28` y `RUTA-501…505` (códigos medidos en prod);
- **30 días** (sin cambio, = Compras): CEDIS 00 y matrices 01, 06, 08; RUTA-321/322 (sin plan).

Un solo mapa en `libs/contracts` (`COBERTURA_AUTOABASTO`, `coberturaAutoabasto()`) y su forma SQL
(`coberturaAutoabastoSql('w.code')`) que usa el motor: la pantalla, el PDF y el SQL no pueden
divergir. Afecta la mesa, el resumen, el reporte y «Mi pedido» (base `'demanda'`); `/compras/pedido`
no cambia. El «por qué» del renglón dice los días de su almacén.

**Medido en prod (solo lectura), renglones con falta / cajas, 30 d → cobertura nueva:** 02 1,123 →
927 / 3,695 → 2,072 · 03 1,378 → 1,170 / 9,245 → 5,682 · 04 728 → 586 / 1,219 → 753 · 05 694 → 579
/ 2,626 → 1,549 · 07 1,254 → 1,051 / 9,673 → 6,103. Matrices sin cambio.

⛔ **Las rutas no cambian porque hoy no piden nada**: en `analytics.replenishment_plan` las 11 rutas
tienen venta diaria 0 y existencia 0 en el 100% de sus renglones, y **ninguna** tiene
`commercial.reorder_policy` (de donde salen los renglones de la mesa). La cobertura de 2.5 d queda
configurada y aplica sola cuando el plan traiga la venta y la carga de cada ruta — **deuda con
nombre: demanda y existencia por ruta en el plan de reabasto** (no se resuelve con un importer).

### 15.14 🧪 [AB.23]–[AB.24] «Mi pedido» resta lo que ya viene y muestra lo que planeó Compras — EN CÓDIGO 2026-10-22

**El pedido del PM:** «el objetivo de esta interfaz es que los encargados sepan qué mercancía les va a
llegar para que no hagan pedido». No hacía falta una pantalla nueva: la decisión de pedir se toma en
«Mi pedido», y ahí faltaban dos cosas.

**[AB.23] Lo embarcado sin recibir se resta.** Al pasar a `EMBARCADO` el pedido `U-D-40` dejaba de
contar como «ya pedido», y la existencia no sube hasta la recepción `U-A-50`. Medido el 2026-10-22: 1,169
embarques en 30 días, 1,081 recibidos (del embarque a la recepción: mediana 1 día, p90 4, máximo 11) y
**88 en camino por $1.54 M** (Canindo 21 · $624,765; Padre Hidalgo 14 · $281,573). Regla: se resta lo
de 7 días o menos (la misma ventana que «ya pedido»); lo más viejo se muestra para reclamarlo.
Emparejamiento embarque → recepción: el mismo del Andén (`c37=41`, `c38`/`c39`).

**Unidades.** Lo pedido se asumía en unidad base (`kdm2.c9`): 44 renglones de pedidos en 30 días (y 44
de embarques en 15) venían en CAJAS, y restaban 1 paquete por caja. Ahora cada renglón se convierte con
la escalera (`factorBaseDe`). El testigo cazó un segundo caso: la base con rótulo de gramaje (`500`)
llega a `v_product_unit_ladder` con `unit_base` vacío; se probó con el precio (02972 OREO GRANEL, $47.79
por «500» = costo base) y cuenta como base. Una unidad que la escalera no conoce no se adivina: se cuenta.

**[AB.24] Lo que planeó Compras.** Decisión del PM (opción A, 2026-10-22): **manda el pedido general**.
Hoy sus traspasos no llegan a Kepler (0 de 788; error `KEPLER_PUSH_URL sin configurar`) y sólo el 11.8 %
de sus renglones aparece después como pedido en Kepler (placebo a −60 días: 8.1 %). Se MUESTRA en «Mi
pedido» lo planeado de 7 días o menos y **no se resta**: sin el `U-D-40` la matriz no surte. Al encender
la Fase KR se vuelve «ya pedido» y se resta solo.

**Antes/después (servicio real, solo lectura, 8 sucursales):** valor a pedir $17,279,163 → $16,866,725
(−$412,438). ⚠️ La base se tomó ~2 h antes: parte de la diferencia es movimiento del día (La Piedad bajó
$12.5 mil con 0.2 cajas en camino).

**Abierto:** encender KR (runbook `RUNBOOKS/KEPLER_PUSH_DESPLIEGUE.md`: prueba de baja en Kepler,
`pg_hba`, variables) · decidir qué hacer con los **306 traspasos aprobados de más de 7 días** antes de
encenderlo · la prueba negativa (sucursal sin nada en camino) quedó NO MEDIDA: hoy todas tienen algo.

### 15.10 🧪 [AB.17] Freno de fin de pico en el motor común — EN CÓDIGO 2026-10-12

**Disparador (Francisco, 2026-10-12):** el bombón La Rosa 70012 en La Piedad salía primero en «Mi
pedido» con 46 cajas. Es producto de pico de temporada: vendía 2–10 piezas al día, subió del 19-sep al
4-oct (43, 81, 105, **144**, 87…) y desde el 5-oct volvió a 2–8. El año pasado igual: sep-2025 1,221
piezas en La Piedad, oct 206. **El historial sí lo sabe; falló la ponderación**, por tres razones:
1. la demanda es el promedio de 30 días (13-sep → 12-oct) y sigue cargando el pico: 31.6 al día;
2. la temporalidad es de RED: en la red septiembre sube ~40%, en La Piedad 10×; mezclado da 0.848;
3. la temporalidad tiene piso de 0.5: aun bien calculada no podría bajar más de la mitad.

**Medido:** 222 productos-sucursal (unos 251 pares con la regla final) estaban así, ~$250 mil de pedido
de más a costo (01: 69 · 06: 49 · 08: 45 · 02: 15 …).

**Decisión de Francisco:** corregirlo en el **motor común** (`import-replenishment-plan.js`), así lo
ven igual Compras y Autoabasto; la temporalidad por sucursal y sin piso queda para después, con prueba
contra el historial (RA-PRO.41 está backtesteada).

**Criterio de negocio (Francisco, 2026-10-12), sobre una primera versión que frenaba cualquier caída:**
el freno aplica **sólo después de un pico real** —cualquier cosa que altere el ritmo semanal: una
promoción (Canels 20021 con 5+1, no más de dos veces al año), una oferta extraordinaria, la temporada,
una venta grande y única— y **nunca cuando la venta cayó porque la existencia llegó a 0 o casi 0**: eso
no es fin de pico, es **venta negada** (fase DN), y frenarlo pediría menos justo cuando falta (agua 59108
por suministro de empaque, 17085 y 20606 por agotado de origen). Umbrales decididos por él: pico de más
de 2×, «ya pasó» por debajo del 40% del pico, y «casi 0» = existencia para menos de 3 días.

**La regla** (CTEs `fp_d` … `fpico`, todos MATERIALIZED), en **pesos** (inmune a la unidad del almacén)
y semanas completas hasta ayer:
1. **venta regular:** vendió en 6 o más de las 8 semanas previas (semanas 5–12 hacia atrás) — deja fuera
   lo que se compra salteado (rollos Altos);
2. **hubo pico:** alguna de las últimas 4 semanas vendió **más de 2×** su nivel normal (nivel normal =
   **mediana** semanal de las semanas 5–12: no se deja arrastrar por un pico viejo);
3. **el pico infló el promedio:** la venta de 30 días quedó 1.5× o más arriba del normal;
4. **el pico ya pasó:** la última semana vende menos del **40% de la semana pico** (contra el pico y no
   contra el normal: después del pico el bombón en La Piedad todavía vende el doble de lo normal);
5. **no faltó mercancía:** en 6 o más de los últimos 7 días tuvo existencia para **3 días de su venta
   normal** según `analytics.stock_snapshots` (AB.0b), con la foto cubriendo el almacén 6+ días.

Entonces la demanda baja a **lo mayor entre la última semana y el nivel normal**:
`razón = GREATEST(r7, normal) / r30`, `season_ratio = LEAST(season_ratio, razón)`, `season_src = 'fin_pico'`.
La venta de 30 días que se muestra no cambia; sólo baja el objetivo. Las rutas se miden con su sucursal
madre (`rmap`). Se suelta solo.

**Verificación:** el SQL completo del motor pasa `EXPLAIN` contra prod en solo lectura, y la lista se sacó
con el SQL del propio motor (copia que sólo lee): **725 pares frenados** (pedido de esos productos $718
mil → $162 mil), **276 con pico pero sin mercancía** (no se frenan: entrada para venta negada), ~3.7 s.
Casos: bombón 70012 — La Piedad 45.6 → 3.2 cajas, Padre Hidalgo 81.9 → 0, 8 Esquinas 67.3 → 35.4 (aún
vende 30% del pico); Canels 20021 en Canindo 32.8 → 6.5; agua 59108 no se frena (en la 01 no hubo pico,
en la 06 mercancía suficiente sólo 2 de 7 días). ⚠️ El 17085 en La Piedad **sí** se frena (pico 2.4× y
ahí sí tuvo mercancía: mínimo 107 u contra 9/día); su agotado de origen afecta a otras sucursales.
Listas en `C:\DEV\entregables\freno-fin-de-pico-final-2026-10-12.xlsx` (fuera del repo).

**Cuándo surte efecto:** en la siguiente corrida del plan (carril `stock`, varias veces por hora, o el
nocturno) **después de actualizar la imagen de los feeds en `md`**: el motor corre en los contenedores
de ingesta, no en la API.

**Abierto:** temporalidad por sucursal y sin piso de 0.5 (el ANTES del pico: pedir más cuando se acerca
septiembre), con prueba contra el historial.

---

## 16. Anexo — Compras decide, la sucursal ve su mesa: la mesa y «Mi pedido» dicen lo mismo (2026-10-23)

```text
OBJETIVO:  que cada sucursal vea, en SU mesa y en «Mi pedido», la MISMA cuenta de lo que le falta y de
           lo que ya le viene, salida de una sola función en el servidor; y que el pedido de traspaso
           lo decida Compras, no cada tienda.
MÉTRICA:   renglones que la mesa lista y en los que la mesa y «Mi pedido» no pueden coincidir —
           HOY (AB.25, 2026-10-23): 393 que ya vienen y la mesa vuelve a pedir + 3,264 cuya «Acción»
           contradice a quién se le pide, de 8,534 listados → META: 0 por construcción al cerrar AB.27.
           (Universo de lo que ya viene: hasta 777 renglones en documentos por $1,533,966.)
CAPA TOPE: C3
ÁREA:      Comercial (Almacén)
DUEÑO:     Edgar (2026-10-23) · cierre comprometido: sin fecha todavía
ESTADO:    🔨 ABIERTA 2026-10-23 por decisión de Edgar. Toma el cupo de MS, que pasa a ⏸️.
```

Medido en `pg-prod` (`system_identifier` 7688376744939610156), transacción `READ ONLY`, 2026-10-23,
con la misma ventana de 7 días que usa «Mi pedido».

### 16.1 En una pantalla

Las dos pestañas parten del mismo motor (`criticalStock`, base `'demanda'`) y después cada una sigue
su camino. El controlador promete «dos audiencias, un solo número»; eso se cumple **sólo hasta el motor**.

| | Mesa (hoy) | «Mi pedido» (hoy) |
|---|---|---|
| Cuánto falta | objetivo − existencia | eso − **ya pedido** (`U-D-40` abiertos ≤ 7 d) − **en camino** (`U-D-41` sin `U-A-50`, ≤ 7 d) |
| A quién | **Acción** según el sobrante de TODA la red (traspaso / parcial / comprar) | el **canal** configurado (`replenishment_channel`): su matriz o el proveedor |
| Qué entra | todo lo que está fuera de política | las posiciones elegidas (default agotado · bajo mínimo · bajo reorden), menos lo de unidad menor < $200 |
| Cantidad | cajas con decimal | redondeada a como se captura en Kepler, o el ajuste guardado |
| Almacenes | varios a la vez | uno |

Consecuencia: para el mismo producto la mesa puede decir «Comprar 12 cajas» mientras «Mi pedido» dice
«ya viene, no pidas».

Y por encima de las dos pantallas, **el pedido de una sucursal se decide hoy en tres lugares**: Compras lo planea en `/compras/pedido`, «Mi pedido» lo sugiere (nadie de tienda lo usa,
§16.3) y lo que se ejecuta es lo que se captura en Kepler (`U-D-40` en la base de la matriz que surte).
⚠️ *Corregido el 2026-10-23 (§16.12): el pedido de la Suite SÍ se pasa a Kepler, a mano; lo que falta es
que la Suite sepa qué se pasó.*

### 16.2 El pedido y cómo cambió

| # | Lo que se pidió | Efecto |
|---|---|---|
| 1 | «analiza /almacen/autoabasto y dime cuál es su función» | — |
| 2 | «¿ya considera el producto que se le va a traspasar?» | La mesa no resta lo que ya viene; «Mi pedido» sí |
| 3 | «si en Mi pedido ya se hace un pedido para cada sucursal, ¿por qué seguir haciendo un pedido de cada tienda?» | El pedido de una sucursal se decide en tres lugares → D1 |
| 4 | «hay que reestructurar Autoabasto para que funcione en sincronía con Mi pedido» | Primera versión de este anexo (mesa de varios almacenes) |
| 5 | «compras decide · no, cada sucursal ve sólo su mesa · d3 no entendí · ¿cuáles rutas? · hagámoslo cupo y documentemos el plan» | D1 = Compras, D2 = mesa por sucursal, D3 explicada otra vez, D4 con la lista de rutas, AB entra a 🔨 y MS pasa a ⏸️. **Deroga** la mesa de varios almacenes de la versión 4 |
| 6 | «rd se surte ellos por ahora pero dejémoslo documentado. lo demás sí lo autorizo» | D3, D4 y D6 firmados; las camionetas RD quedan fuera y se surten solas por ahora (§16.6) |
| 7 | «y en caso de que la sucursal necesite generar un pedido, en base al motor de Mi pedido vs lo que se le va a traspasar y existencia… por si es necesario poder generar una requisición, no está de más que vean una mini pantalla tipo Mi pedido» | D7: la «excepción» de AB.29 pasa a ser **«Generar requisición»**, una mini «Mi pedido» que Compras aprueba |

### 16.3 Lo medido hoy

**Lo que ya viene a cada sucursal y la mesa no resta** (documentos de Kepler, 7 días):

| Sucursal | Pedidos abiertos | SKUs | Importe | Embarques sin recibir | SKUs | Importe |
|---|---:|---:|---:|---:|---:|---:|
| 00 | — | — | — | 6 | 12 | $31,072 |
| 01 | 3 | 26 | $58,142 | 6 | 14 | $89,598 |
| 02 | 11 | 193 | $151,174 | 4 | 5 | $3,244 |
| 03 | 8 | 52 | $82,472 | 6 | 25 | $17,711 |
| 04 | 5 | 109 | $53,291 | 3 | 9 | $3,852 |
| 05 | 3 | 19 | $26,323 | 10 | 63 | $129,531 |
| 06 | 7 | 67 | $156,999 | 16 | 79 | $474,430 |
| 07 | 10 | 87 | $124,565 | 2 | 2 | $866 |
| 08 | 5 | 2 | $81,364 | 8 | 12 | $48,778 |
| **Total** | **52** (+1 sin sucursal, $554) | **555** | **$734,330** | **61** | **221** | **$799,082** |

⚠️ El importe es `c16` del documento, **sin arbitrar si lleva IVA**. Los SKUs se cuentan por sucursal y
tipo; un mismo SKU puede estar en un pedido y en un embarque, por eso 777 es un tope, no una suma exacta.

**Uso de las pantallas:**
- «Mi pedido»: **23 eventos de huella en total; 22 son de UNA persona con rol `direccion`** y 1 es de un
  almacenista (una apertura, 14-oct). Último evento: 15-oct. **Ninguna tienda pide desde ahí.**
- La mesa: uso **NO MEDIDO** (no deja huella).
- En Kepler se capturan pedidos de traspaso casi a diario, **en la base de la matriz que surte** (no en
  la tienda): en 30 días, 01←00 143 pedidos en 24 días, 07←08 169 en 28, 02←01 95 en 17 (§16.12).
- Compras: **675 traspasos planeados** vivos en 30 días (aprobados, ordenados o por aprobar), **0 con
  folio de Kepler registrado**. ⚠️ Eso NO quiere decir que no se pasaron: se pasan a mano y la Suite no
  guarda el folio (§16.12). Buscándolos por destino y producto, aparece el **12.0 %** de los renglones
  en 0–3 días, contra **7.8 %** de un placebo (AB.24 había medido 11.8 % contra 8.1 %).

### 16.4 Universo y trabajo — y cuánto dinero hay de verdad

- **Universo:** hasta 777 renglones sucursal × producto con documentos por **$1.53 M** que ya los cubren.
- **Trabajo:** los de ésos que la mesa además lista con Falta > 0 — **NO MEDIDO** (hay que correr el
  motor; es el item AB.25).
- **Dinero en juego:** lo que se pierde HOY por la diferencia entre pantallas es **NO MEDIDO y
  probablemente bajo**, porque las tiendas no piden desde ellas. Tarjeta: **Medio (estimado) × L →
  prioridad 3, abierta por decisión de Edgar (2026-10-23)**. El dinero grande no está en la mesa: está
  en que la Suite no sabe qué de su pedido ya se pasó a Kepler (§16.12, AB.30).

### 16.5 Lo que creíamos y cayó

| # | Lo que decía | Lo que midió prod / el código |
|---|---|---|
| 1 | «Dos audiencias, un solo número» (`autoabasto.controller.ts`) | Se cumple hasta el motor; después divergen en cuánto, a quién, qué entra y redondeo |
| 2 | `/mesa`: «sugerido ya neto de tránsito» (`@ApiOperation`) | No resta nada: la política es `'ignorar'`, y el tránsito que lee son OC a proveedor, no traspasos |
| 3 | Ruta: «Hoy sólo LEE; solicitar y autorizar entran en el PR siguiente» | «Mi pedido» ya escribe (AB.18); solicitar y autorizar no existen |
| 4 | «Mi pedido» en uso | 22 de 23 eventos son de Dirección |
| 6 | §15.7: el motor de `/compras/pedido` trabaja «con demanda dependiente en las matrices» | **No en el código:** cada almacén se calcula con su propia venta; `eff_daily` sólo lo usa la lista de sobrestock (§16.13 A) |
| 5 | El plan de Compras es lo que la sucursal necesita | Cubre el 4.5 % de las cajas que el motor marca como falta (AB.25); sin el folio de Kepler no se sabe cuánto se pasó (§16.12) |

### 16.6 Decisiones

| # | Decisión | Resultado | Firma |
|---|---|---|---|
| **D1** | ¿Quién decide el pedido de traspaso de una sucursal? | **Compras**, en el pedido general. La sucursal ve lo que le llega y marca excepciones; ya no arma pedido. Deroga el modelo del 12-oct («el sistema arma el pedido de la sucursal y el almacenista corrige») | ✅ Edgar, 2026-10-23 · ⚠️ **falta comunicárselo a Francisco**, que firmó el modelo anterior. ADR-100 |
| **D2** | ¿Qué ve cada quién en la mesa? | **Cada sucursal ve sólo su mesa** (un almacén). Quien alcanza varios elige uno, como en «Mi pedido». Se descarta la mesa de varios almacenes a la vez | ✅ Edgar, 2026-10-23 |
| **D3** | La columna «Acción» (ver abajo) | **Sale de la mesa**; en su lugar **«Surte»** = la matriz o el proveedor que tiene configurado. El sobrante de la red se queda del lado de Compras | ✅ Edgar, 2026-10-23 |
| **D4** | Las rutas (ver abajo) | **Fuera de Autoabasto.** Las camionetas RD se surten ellas mismas por ahora (documentado abajo) | ✅ Edgar, 2026-10-23 |
| **D5** | Cupo | **AB entra a 🔨; MS pasa a ⏸️** con su doc intacto | ✅ Edgar, 2026-10-23 |
| **D6** | Nombre de la pestaña «Mi pedido» | **«Lo que te llega»**, porque con D1 la sucursal ya no arma pedido | ✅ Edgar, 2026-10-23 |
| **D7** | ¿La sucursal puede pedir algo por su cuenta? | **Sí, como requisición que Compras aprueba**, desde una mini pantalla tipo «Mi pedido» prellenada con el mismo motor (lo que falta, menos lo que ya viene y lo que Compras ya planeó). No es un pedido directo a Kepler | ✅ Edgar, 2026-10-23 (AB.29) |
| ~~**D8**~~ | ~~¿Cuándo se apaga el pedido de la tienda en Kepler?~~ | **Retirada (Edgar, 2026-10-23):** las requisiciones y los traspasos se hacen en Kepler y el pedido de la Suite se pasa a Kepler. No hay un «pedido de la tienda» que apagar: Kepler es donde se ejecuta todo | ❌ retirada |
| **D9** | ¿Cómo sabe la Suite qué de su pedido ya se pasó a Kepler? | (a) quien captura en Kepler registra el folio en la Suite (para compras ya existe `oc_folio`, con 0 usos en 273 requisiciones) · (b) emparejar por destino + producto + fecha (medido: 12.0 % contra 7.8 % de placebo, no sirve de regla) · (c) el envío automático (Fase KR). Recomendación: **(a) ahora, (c) después** — sin la liga, el plan de Compras y su copia en Kepler se cuentan como dos cosas (§16.12). Item AB.30 | ⬜ falta firma |

**D3 en palabras simples.** Hoy cada renglón de la mesa tiene una columna «Acción» que dice *Traspaso*,
*Traspaso parcial* o *Comprar*. La mesa la decide mirando si **cualquier** almacén de la empresa tiene de
más ese producto. Ejemplo de cómo funciona (ilustrativo, sin cifras): 02 se surte de 01; si a 02 le falta
un producto y a 07 le sobra, la mesa le dice a 02 «Traspaso», aunque 02 nunca le pide a 07 y no existe
forma de pedírselo. «Mi pedido», en cambio, le dice «pídeselo a 01», porque ése es su canal. Con D1
(Compras decide) la sucursal tampoco elige de dónde sale la mercancía, así que la columna sobra. Se
cambia por **«Surte»** (su matriz o el proveedor, igual que «Mi pedido»), y el sobrante de la red se queda
del lado de Compras, que es quien puede moverlo: `/compras/existencia` usa el mismo cálculo. Los KPI
«Se cubre con la red / Hay que comprar» pasan a **«Lo surte la matriz / Lo surte el proveedor»**.

**D4 — cuáles rutas.** Son **las camionetas de venta en ruta**, registradas como almacenes en
`commercial.warehouses`:

| Grupo | Almacenes | Carga de | Pedidos `U-D-40` en 30 días |
|---|---|---|---|
| Camionetas de 01 | `RUTA-21`, `-22`, `-23`, `-26`, `-27`, `-28` | 01 | 23–28 cada una, 1,286–2,411 renglones |
| Camionetas de 06 | `RUTA-501` a `-505` | 06 | 5–30 cada una, 257–2,460 renglones |
| Otras dos | `RUTA-321`, `RUTA-322` | — | ninguno en 30 días |
| Duplicados con tipo `central` | `01-002` a `01-006` («Ruta 22 (PH)»…) | — | — |

Las 18 tienen **0 políticas de reorden y ningún canal configurado**, así que hoy su mesa sale vacía o en
cero (ya declarado en AB.22). Su abasto es la **carga diaria de la camioneta**, otro proceso. Además, el
catálogo de destinos de Kepler no las mapea (llegan como `RUTA 21` / `RD 501`), así que lo que se les
pidió no se puede restar.

**Firmado (Edgar, 2026-10-23):** las rutas quedan **fuera de Autoabasto** — no aparecen en el selector de
la mesa ni de «Lo que te llega». ⭐ **Las camionetas RD (`RUTA-501` a `-505`, cargan de 06) se surten
ellas mismas por ahora**: piden su carga por su cuenta, sin pasar por Compras ni por esta mesa. Queda
documentado para cuando se decida meterlas al modelo de ADR-100; entonces harán falta (1) su política de
reorden y su canal, que hoy no tienen, y (2) mapear `RD 50x` en el catálogo de destinos para que lo pedido
se reste.

### 16.7 Qué NO incluye

- No cambia el motor (`criticalStock`) ni el cálculo de `/compras/pedido`.
- **No enciende el envío a Kepler (Fase KR).** Kepler sigue siendo donde se capturan requisiciones y
  traspasos: la Suite decide y arma el pedido, Kepler lo ejecuta.
- No toca los traspasos aprobados viejos de Compras.
- No crea un flujo de solicitar / autorizar traspasos entre plazas.
- No asigna almacén a los almacenistas (12-oct: 5 de 6 sin almacén, **sin re-medir**), pero sin eso
  ninguna de las dos pantallas les sirve.
- No borra tablas: las de AB.18 (`autoabasto_pedidos`, `_lineas`, `_huella`) se reusan para el
  borrador de la requisición de la sucursal (AB.29).
- Ningún importer ni tabla nueva: todo sale de `kepler_ods`, del plan de Compras
  (`purchase_requisitions`) y de las tablas que ya existen.

### 16.8 El modelo y las capas

**El flujo con D1:** Compras decide el traspaso de cada sucursal → el plan llega a Kepler (KR) → la
matriz surte → la sucursal recibe. La sucursal **no arma el pedido de rutina**: ve su mesa y lo que le
llega. Si de verdad necesita algo que nadie planeó, **genera una requisición** desde una mini pantalla
tipo «Mi pedido» (D7), y **Compras la aprueba o la rechaza**: Compras sigue siendo quien decide.

**Cómo se cuenta «ya viene» en las dos pantallas** (una sola regla):

| Documento | ¿Se resta de la falta? |
|---|---|
| Pedido de traspaso abierto en Kepler, ≤ 7 días | Sí (como hoy en «Mi pedido») |
| Embarque sin recibir, ≤ 7 días | Sí (como hoy en «Mi pedido») |
| Plan de Compras que **ya está** en Kepler | Sí: es un pedido abierto más |
| Plan de Compras que **todavía no está** en Kepler | **No**: se muestra «Compras lo planeó · aún no está en Kepler». Restarlo diría «cubierto» de algo que todavía nadie capturó. ⚠️ Hoy la Suite no puede distinguir «ya está» de «todavía no está» porque no guarda el folio (D9 / AB.30); hasta entonces, todo lo planeado cae en esta fila |
| Pedido abierto de más de 7 días | No: se muestra como atorado, para reclamarlo |

**Estado de cada renglón** (mesa y «Lo que te llega» usan los mismos): *Ya viene* · *Compras lo planeó* ·
*Nadie lo ha pedido* · *En política*. *Nadie lo ha pedido* es justo el porqué que AB.3b dejó abierto
(«¿por qué NO propone pedir?»), ahora contestado.

**C0 — AB.25 Medir antes de construir.** En sólo lectura (SQL del motor, como AB.17; nunca un backend
en la laptop), por sucursal:
1. Renglones donde la mesa y «Mi pedido» difieren en cantidad, y donde la Acción contradice el canal.
2. ⭐ **Cuánto de la falta neta de cada sucursal cubre el plan de Compras.** Con D1, si Compras no planea
   lo que la sucursal necesita, la sucursal se queda sin mercancía. Es el árbitro de D1.
3. Tiempo de la cuenta por almacén.
Lo que no se pueda correr se declara NO MEDIDO.

**C1 — AB.26 Una sola cuenta del renglón, por almacén.** 🧪 *En código 2026-10-23: `armarRenglon` / `estadoRenglon` / `surteDe` en `libs/contracts`, 20 pruebas con su negativa vista en rojo; antes/después en prod NO MEDIDO hasta desplegar.* Sacar de `AutoabastoPedidoService.pedido()`
la función que arma la línea: falta · ya pedido · en camino · planeado por Compras · falta neta · surte ·
estado · excepción guardada. El tipo vive en `libs/contracts`. La mesa y «Lo que te llega» la consumen.
- «Mi pedido» devuelve lo mismo que antes en los 9 almacenes (antes/después en sólo lectura), salvo lo
  que cambia a propósito (el plan de Compras ya en Kepler pasa a restarse).
- Prueba negativa: un renglón con embarque sin recibir sale con falta neta menor; quitando la resta, rojo.
- Un almacén sin cliente de traspaso declara «sin medir», nunca 0.

**C2 — AB.27 La mesa sirve esas líneas.** 🧪 *En código 2026-10-23, como endpoint NUEVO
`GET /commercial/autoabasto/renglones` (un almacén, sólo lectura) que convive con `/mesa` hasta que la
pantalla cambie en AB.28: así ningún despliegue intermedio rompe la mesa actual. Sale del mismo
`armarAlmacen()` que «Mi pedido» (misma cuenta por construcción); filtros por estado, posición, «surte» y
búsqueda, orden de lectura, resumen del almacén entero con la regla de los grupos. Tiempo: el mismo de
«Mi pedido» (3.7 s, sin re-medir) — NO MEDIDO contra la meta de 500 ms; bajarlo va en commit aparte.* `GET /mesa`, `/mesa/resumen` y `/reporte` exigen **un**
almacén dentro del alcance (D2) y salen de la función de C1.
- Para el mismo almacén, la falta neta de la mesa = la de «Lo que te llega», renglón por renglón.
- `/mesa` responde en < 500 ms. «Mi pedido» tarda **3.7 s** (medido el 2026-10-12 en AB.16, **sin
  re-medir**). Si no se alcanza, se declara.

**C1–C3 — AB.29 «Generar requisición»: la mini «Mi pedido» de la sucursal (D7).** Reemplaza a la
«excepción» de la versión anterior. Nada se construye de cero:

| Pieza | Ya existe | Lo nuevo |
|---|---|---|
| Qué se le sugiere pedir | la cuenta de AB.26 | sólo los renglones *Nadie lo ha pedido*, prellenados con su falta neta |
| Ajustar con − / + y motivo | AB.18 (pasos por unidad de captura, motivo al pasar ±20 %, huella) | se mudan de «Mi pedido» a esta pantalla |
| Redondeo y mínimo de $200 | AB.19 / AB.20 (`libs/contracts`) | — |
| Agrupar por a quién se le pide | grupos de «Mi pedido» (matriz / proveedor) | una requisición por grupo |
| La requisición | `insertRequisition()` → `purchase_requisitions` en `pending_approval`, folio `RQ-` | un endpoint de Autoabasto con `AUTOABASTO_SOLICITAR` que llama a **esa misma función** |
| Que la apruebe Compras | su bandeja y su autorización actuales | — |
| Tope y facultades | claves `AUTOABASTO_AUTORIZAR` / `_EXCEDER_TOPE` (escalera §6.1, repartidas desde la migración `20260919160000`) | el tope en pesos de la requisición |
| PDF para capturar en Kepler | AB.21 | lo imprime la requisición aprobada mientras KR esté apagado |

Reglas:

- **Al prellenar se resta también lo que Compras ya planeó**, aunque todavía no esté en Kepler. En la
  mesa no se resta (diría «cubierto» de algo que no llega); en la requisición sí, porque pedirlo otra
  vez sería duplicar una decisión que Compras ya tomó. Si la sucursal cree que el plan no le va a llegar,
  lo pide igual **con motivo**.
- **El servidor recalcula los renglones**: el navegador manda producto, cantidad y motivo; existencia,
  sugerido, costo y origen los pone el servidor con la cuenta de AB.26. Nada de la pantalla se toma por
  bueno.
- **Contra duplicados**, dos redes que ya existen: (1) lo que Compras ya planeó se resta al prellenar
  (regla de arriba); (2) el doble clic lo frena `lote-repetido.ts` (409 con lo encontrado y «generar de
  todos modos»). ⚠️ Esa red hoy **sólo mira renglones de COMPRA** de la misma persona en minutos: para
  las requisiciones de traspaso de la sucursal hay que extenderla, aditiva, con su prueba.
- El almacén tiene que estar en el alcance de la persona (la misma comprobación de `almacenEnAlcance`).
- Hoy **0** requisiciones las crea alguien de sucursal: en 30 días, las 1,013 las crearon roles de
  Compras y Dirección (medido 2026-10-23, sólo lectura). Si Compras necesita filtrar «las que pidió una
  sucursal», sale de `created_by`; una columna de origen sólo si eso no alcanza (migración aditiva).
- Prueba contra base real con el payload de la pantalla (regla del endpoint que escribe), incluida la
  negativa: un almacén fuera del alcance → 403; un renglón con cantidad que el servidor no reconoce → 400.

**C3 — AB.28 Las pantallas.** Partido en dos (decisión 2026-10-23): **AB.28a** la mesa nueva, sin
dependencias; **AB.28b** renombrar «Mi pedido» y quitarle los − / +, que espera a AB.29 (sin «Generar
requisición», quitar los − / + dejaría a la sucursal sin forma de decir lo que necesita).

🧪 *AB.28a en código 2026-10-23:* la mesa lee `/renglones` (un almacén; con varios, pide elegir y no
adivina); columnas Producto · Posición · Existencia · Mín · Reorden · Máx · Falta · Ya viene · Falta neta ·
Surte · Estado · Entrega; KPI primario «Nadie lo ha pedido», después lo que se pide a la matriz y al
proveedor; filtros por estado (con su conteo dentro del control), posición, «surte» y búsqueda en el
servidor; ayuda en el diccionario (`almacen-autoabasto`); la sucursal por nombre en la celda «Surte» y en
el PDF. El PDF sale de la misma respuesta (`todos=1`). `check:pantalla`: la mesa pasa de 3 fallas a 1
(queda §9 frescura, deuda declarada: la respuesta trae la hora del cálculo, no la edad del dato). La
prueba cazó una **doble carga** (cada una ~3.7 s) que ya tenía la pantalla vieja. ⚠️ **Sin validación
visual** (no se levanta la app local): lo más probable de ajustar es el ancho de columnas, el control de
estado en pantallas angostas y la posición de los tooltips. `/mesa`, `/mesa/resumen` y `/reporte` quedan
sin uso en la pantalla: se retiran cuando AB.28a esté en prod.
- **Mesa:** un almacén; columnas Posición · Venta 30 d · Existencia · Mín / Reorden / Máx · Falta ·
  Ya viene · Falta neta · Surte · Estado. Salen Acción, De la red y A comprar (D3). Un renglón abre «Lo
  que te llega» en ese producto. El PDF imprime lo mismo.
- **«Lo que te llega»** (D6, firmada): lo que viene por documento (plan de Compras, pedidos, embarques) y por
  producto; salen los − / + y «Aceptar grupo» de la vista principal, y entra el botón **«Generar
  requisición»**, que abre la mini pantalla de AB.29.
- Se corrigen los textos rancios (§16.5 #2 y #3, y el pie «Solicitar y autorizar llegan en la siguiente
  entrega»).
- Skill `diseno` y `npm run check:pantalla -- almacen` antes y después.

**C2/C3 — AB.30 La liga del folio: la Suite sabe qué de su pedido ya está en Kepler (D9).** Quien captura
en Kepler el pedido de la Suite (requisición de compra → `X-A-30`/OC, traspaso → `U-D-40`) registra el
folio en la Suite. Para compras la columna ya existe (`oc_folio`, `oc_capturada_at`, `oc_capturada_por`)
y tiene **0 usos en 273 requisiciones**: hay que averiguar por qué no se usa antes de construir otra
pantalla. Para traspasos se agrega lo equivalente (migración aditiva). Con el folio:
- la cuenta de AB.26 deja de contar el plan y su copia en Kepler como dos cosas;
- AB.25 se vuelve a medir y separa «Compras planea poco» de «se pasó y no se ligó».
- Prueba contra base real con el payload de la pantalla; negativa: un folio que no existe en Kepler para
  ese destino se rechaza.

**Orden:** ~~AB.25~~ ✅ → AB.26 → AB.30 → AB.27 → AB.29 → AB.28. AB.30 entra antes que la mesa porque sin el
folio la cuenta única no puede saber qué del plan ya está en Kepler (§16.12).

### 16.9 Riesgos y bloqueos

| Bloqueo | Dueño | Causa | Qué lo destraba |
|---|---|---|---|
| ⛔ **La Suite no sabe qué de su pedido ya se pasó a Kepler** | Edgar | Se pasa a mano y nadie guarda el folio: 0 de 273 compras con `oc_folio`, 0 traspasos con folio | D9 / AB.30. Después, encender KR (`RUNBOOKS/KEPLER_PUSH_DESPLIEGUE.md`) |
| ⛔ **El plan de Compras cubre poco de lo que el motor marca** | Edgar (PM) | 4.5 % de las cajas (AB.25) | Primero AB.30 (sin folio no se separa «planea poco» de «no se ligó»); después preguntarle a Compras por qué, con la cifra re-medida |
| D1 cambia el modelo que firmó el dueño | Edgar | Francisco firmó el 12-oct que la sucursal arma el pedido | Comunicárselo antes de AB.28 |
| Almacenistas sin almacén asignado | **sin dueño — pregunta** (¿quién administra Personas?) | 5 de 6 sin asignar (12-oct) | Asignarlos |
| AB sin fecha de cierre comprometida | Edgar (dueño desde 2026-10-23) | Abierta hoy | Ponerla; sin ella la fase cae a ⏸️ (método §3) |
| La requisición de sucursal se vuelve la vía de rutina (y regresan los tres lugares) | Edgar (PM) | Pedir es fácil; cada tienda hoy pide casi a diario | Medir cada semana: requisiciones de sucursal por almacén y cuántas rechaza Compras. Si una sucursal pide casi a diario, el plan de Compras no la está cubriendo: se corrige el plan, no se aprueba en automático |
| Requisición aprobada + su captura en Kepler = contada dos veces | Edgar | Sin folio, la Suite ve el plan y el `U-D-40` capturado como dos cosas | La requisición aprobada se imprime (AB.21), se captura UNA vez y se registra su folio (AB.30); entonces deja de contarse como plan |

### 16.11 ✅ [AB.25] Lo que midió el C0 — 2026-10-23

Script versionado y repetible: `node database/scripts/ab25-mesa-vs-pedido.js [--ventana=7|30]`
(`pg-prod`, `system_identifier` 7688376744939610156, transacción `READ ONLY`, 7.1–9.3 s para toda la
red). Reproduce con el **texto** de las expresiones del motor (`demandTarget`, `onHand('plan')`,
`networkSurplus`, `transferIn`, `accionExpr`, `cajaFactor`) y el agrupado de «Mi pedido». **No corre el
servicio**, así que el cruce contra la API queda **NO MEDIDO**.

**El instrumento se probó contra un control antes de publicar.** La primera corrida dio que el plan de
Compras cubría 36,104 de 36,786 cajas en 01 con sólo 101 renglones planeados: imposible. Causa:
`LEAST(plan, falta)` en Postgres **ignora el NULL** y devolvía la falta entera donde no había plan. Se
corrigió con `COALESCE(plan, 0)`. Control de consistencia que sí pasa: los renglones «ya viene» por
sucursal quedan siempre por debajo de los SKUs en documentos medidos en §16.3 (p. ej. 02: 104 ≤ 198).

**Por almacén (plan de Compras de 7 días, como «Mi pedido»):**

| Almacén | La mesa lista | Ya viene y la mesa lo pide | «Traspaso» pero surte otro | «Comprar» pero surte su matriz | Nadie lo ha pedido | …de ésos, Compras lo planeó | Falta (cajas) | Cubierto por el plan (cajas) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 01 | 1,630 | 34 | 367 | 210 | 1,596 | 101 | 36,786 | 1,089 |
| 02 | 880 | 104 | 36 | 164 | 776 | 87 | 1,730 | 168 |
| 03 | 1,035 | 51 | 33 | 153 | 984 | 147 | 3,919 | 400 |
| 04 | 554 | 58 | 3 | 107 | 496 | 53 | 403 | 87 |
| 05 | 481 | 38 | 7 | 114 | 443 | 44 | 1,096 | 191 |
| 06 | 1,245 | 59 | 481 | 112 | 1,186 | 92 | 16,792 | 539 |
| 07 | 983 | 39 | 45 | 184 | 944 | 104 | 5,898 | 173 |
| 08 | 1,726 | 10 | 1,236 | 12 | 1,716 | 211 | 29,719 | 1,645 |
| **Total** | **8,534** | **393 (4.6 %)** | **2,208** | **1,056** | **8,141** | **839 (10.3 %)** | **96,343** | **4,292 (4.5 %)** |

(00 no lista nada: su objetivo sale en 0. Compras le planeó 25 renglones, todos sin falta.)

**Lo que dice:**

1. **La sincronía es un problema real y mayormente de «a quién», no de «cuánto».** 393 renglones
   (4.6 %) se piden de nuevo aunque ya vienen; pero **3,264 (38.2 %)** tienen una «Acción» que contradice
   a quién se le pide en «Mi pedido»: 2,208 dicen «Traspaso» cuando su canal es un proveedor (1,236 sólo
   en 08) y 1,056 dicen «Comprar» cuando su canal es su matriz. D3 corrige más de un tercio de la mesa.
2. ⛔ **El plan de Compras cubre muy poco de lo que el motor dice que falta.** De los 8,141 renglones que
   nadie ha pedido, Compras planeó **839 (10.3 %)**, y en cajas cubre **4.5 %** (sucursales 02–07:
   **7.8 %**; matrices 01, 06, 08: 3.9 %). Con la ventana de 30 días e incluyendo `ordered`: **22.7 %** de
   los renglones y **13.6 %** de las cajas (sucursales 12.2 %). **No depende de la ventana.**
3. **Y lo que planea no siempre hace falta:** de 1,329 renglones planeados en 7 días, **394 (29.6 %)**
   son de productos con falta 0 según el mismo motor.

**Lo que esto NO prueba (y no se adivina):**

- **Por qué** Compras planea tan poco: puede ser que planee por ciclo de proveedor, que corrija el
  objetivo a la baja, o que el objetivo (21–30 días de cobertura) esté alto para cómo se surte hoy una
  sucursal (pide casi a diario). **NO MEDIDO**: es la pregunta para Compras.
- En las **matrices** (01, 06, 08) parte de su falta se cubre con OC a proveedor que ninguna de las dos
  pantallas resta (política de tránsito `'ignorar'`), así que su cobertura está subestimada.
- El tiempo **por almacén** del servicio: NO MEDIDO (sólo el SQL de la red entera: 7–9 s).

**Consecuencia para ADR-100** (corregida el mismo día, §16.12): el plan de Compras cubre poco de lo que
el motor marca como falta. D1 sigue firmada y el orden queda así:

- AB.26 / AB.27 (una sola cuenta, mesa sincronizada) **siguen igual**: valen con cualquier modelo.
- AB.29 («Generar requisición»): lo que pide la sucursal entra a la Suite, Compras lo aprueba y **se pasa
  a Kepler igual que el pedido de Compras**.
- **AB.30 (nuevo): la liga del folio.** Sin ella no se puede medir de verdad la cobertura del plan (lo
  ya capturado se ve como «ya viene», lo planeado como plan, y la Suite no sabe que son lo mismo).

### 16.12 ⚠️ Corrección — en Kepler se ejecuta todo; el pedido de la Suite se pasa a mano (2026-10-23)

**Lo que dijo Edgar:** *«las requisiciones y traspasos se hacen en Kepler hoy; el pedido de Suite se
pasa a Kepler»*. Dos afirmaciones de este anexo estaban mal planteadas:

| # | Lo que decía este anexo | Lo correcto, medido (`pg-prod`, sólo lectura, 30 días) |
|---|---|---|
| 1 | «Compras planeó 675 traspasos y **0** llegaron a Kepler» | El 0 es sólo el **envío automático** (`kepler_folio`, Fase KR apagada). El pedido de la Suite se captura **a mano** en Kepler y **nadie registra el folio**: 0 de 273 requisiciones de compra tienen `oc_folio` aunque la columna existe. La Suite no sabe qué se pasó |
| 2 | «La tienda pide en Kepler por su cuenta, casi a diario» | Los pedidos de traspaso `U-D-40` viven **en la base de la matriz que surte** y los captura gente de ahí: 00 → 571 (481 un mismo usuario), 01 → 437, 08 → 345, 06 → 180. Las **requisiciones de compra** `X-A-30` sí las hacen las sucursales: 07 → 40, 02 → 39, 03 → 27 |
| 3 | D8: «apagar el pedido de la tienda en Kepler» | No hay nada que apagar: Kepler es donde se ejecuta. D8 se retira |

**Lo que se midió para contrastarlo:** si el pedido de la Suite se pasa a Kepler, sus renglones de
traspaso deberían aparecer en un `U-D-40` al mismo destino y del mismo producto poco después.

| Estado en la Suite | Renglones (30 d) | En un `U-D-40` 0–3 días después | Placebo (57–60 días antes) |
|---|---:|---:|---:|
| approved | 2,718 | 327 (12.0 %) | 213 (7.8 %) |
| ordered | 456 | 38 (8.3 %) | 18 (3.9 %) |
| cancelled | 126 | 37 (29.4 %) | 4 (3.2 %) |
| pending_approval | 99 | 6 | 5 |

**Lo que eso dice y lo que no:** el emparejamiento por destino + producto + fecha encuentra poco por
encima del placebo. Puede ser que se capture más tarde, en otro documento, con otra clave de producto, o
que una parte no se capture. **NO MEDIDO cuál.** Sólo con el folio se puede saber, y por eso D9 / AB.30.
(Los cancelados que sí aparecen en Kepler, 29.4 %, sugieren que a veces se cancela en la Suite lo que ya se
capturó por otro lado; sin verificar.)

**Qué cambia en el plan:**

- **D1 no cambia:** Compras decide; la Suite arma el pedido; Kepler lo ejecuta.
- **D8 se retira**; entra **D9** (cómo sabe la Suite qué ya se pasó) y el item **AB.30** (registrar el
  folio de Kepler al pasar el pedido).
- **AB.25 sigue válido en lo que mide** (la mesa contra «Mi pedido», y cuánto del faltante tiene un
  documento o un plan), pero la lectura «el plan de Compras no llega» se cambia por **«la Suite no
  sabe si llegó»**.
- **AB.26 tiene una regla nueva:** mientras no haya folio, lo planeado por Compras y su copia capturada
  en Kepler pueden ser lo mismo. La cuenta no puede restar los dos.

### 16.13 El flujo de la requisición de sucursal, de punta a punta (2026-10-23)

**El pedido de Edgar:** *«al generar su requisición, ¿de dónde obtendrá la mercancía? ¿cómo afectará
al pedido? ¿lo afectará en algo? No dejemos nada a la duda: resolvamos o tengamos un flujo adecuado de
comunicación.»*

Se revisó el código del motor y del ciclo de las requisiciones, y se midió en `pg-prod` (sólo lectura,
30 días). Primero **cómo está hoy**, después **cómo debe quedar**.

#### A. Cómo está hoy (medido y leído en el código)

**La red, configurada en prod:** 02, 03 y 04 se surten de 01; 05 de 06; 07 de 08; y 01, 06 y 08 de 00.
Centros de compra: 00, 01, 06, 08. Cada sucursal tiene **los dos canales según el proveedor**: unos
productos le llegan por traspaso de su matriz y otros los compra directo (`replenishment_channel`).

| Pregunta | Respuesta hoy | Evidencia |
|---|---|---|
| ¿De dónde sale la mercancía? | Del **canal** de ese producto en esa sucursal: su matriz (traspaso) o el proveedor (compra). El servidor ya obliga a **una requisición por origen**: no mezcla traspaso y compra, ni dos proveedores | `insertRequisition()` (`commercial-replenishment.service.ts:3799-3818`) |
| ¿La matriz aparta lo que le pidió su sucursal? | ⛔ **No.** La existencia de la matriz se ve completa hasta que sale el embarque (`U-D-41`). Ni los pedidos de traspaso abiertos (`U-D-40`) ni las requisiciones aprobadas la comprometen | `transferPlan` toma la existencia ENTERA del origen (`:3093`); el plan no lee `U-D-40` |
| ¿El pedido de Compras para la matriz incluye lo que necesitan sus sucursales? | ⛔ **No.** Cada almacén se calcula con **su propia venta**. La «demanda dependiente en las matrices» que afirmaba §15.7 **no existe en el código**: `eff_daily` sólo lo usa la lista de sobrestock | `workbook` usa `daily_pieces` por almacén (`:2024, 2105`); `eff_daily` sólo en `overstockList` (`:3219-3259`) |
| ¿Qué pasa si la matriz no tiene? | El traspaso se reparte en proporción entre las sucursales y lo que no alcanza queda como faltante; **no protege la venta de la propia matriz** (sin regla de punto de reorden). La «bajada» (comprar a la matriz y bajarlo) sólo pasa si el comprador consolida a mano | `transferPlan` (`:3125-3150`); `compras-pedido-real.component.ts:3104-3137` |
| ¿La matriz surte lo que le piden? | Casi siempre. Renglones embarcados con faltante, 30 días: **00: 0.3 %** · **01: 6.5 %** · **06: 11.4 %** · **08: 5.2 %** (en cantidad: 0.1 / 4.9 / 10.0 / 4.6 %). ⚠️ Que `c51` sea lo pedido originalmente es la hipótesis de FASE_DN, sin arbitrar | `kepler_ods`, `U-D-40` embarcados |
| ¿Quién aprueba? | `gerente_compras`: 648 de 649 traspasos y 192 de 205 compras en 30 días | `approved_by` |
| ¿Cuánto tarda? | Aprobar un traspaso: mediana **46 h**. **590 traspasos aprobados llevan una semana sin pasar a «ordenado»** (no hay dónde registrar su folio). Compras aprobadas sin ordenar: 78, con 17 días de mediana | `purchase_requisitions` |
| ¿Quién se entera de cada paso? | ⛔ **Nadie.** Crear, aprobar o rechazar no avisa a nadie: no hay tarea en «Mi trabajo», ni evento, ni correo. Compras tiene que entrar a `/compras/requisiciones` a ver | Sin `emit`, sin bandeja, sin fuente de tarea (`me-work.ts`, `task.contract.ts:117-124`) |
| ¿Se sabe quién la creó? | En la lista, **no** (no se selecciona `created_by`); en el detalle sale el id sin nombre | `listRequisitions` (`:4097-4119`), `getRequisition` (`:4265`) |
| ¿Se sabe quién la rechazó? | ⛔ **No.** Rechazar sólo cambia el estado; no guarda quién, cuándo ni por qué | `setEstado` (`:4387-4403`) |
| ¿Se puede cancelar una aprobada? | **No** | — |

**Defectos que salieron de paso (verificados en el código):**
1. **«Capturar OC»** (lista de requisiciones, pestaña Proveedor) se habilita con `COMPRAS_REQUISICIONES_AUTORIZAR`,
   pero el servidor exige `…_GESTIONAR` (`compras-requisiciones.component.ts:260, 520` contra el controlador `:519`).
2. **Aprobar / Rechazar** (detalle) se muestran con `…_GESTIONAR`, pero el servidor exige `…_AUTORIZAR`
   (`compras-requisicion-detalle.component.ts:57-66, 232` contra `:489, 508`). Un botón que parece funcionar y da 403.
3. **Los traspasos no tienen dónde registrar su folio de Kepler** (sólo la pestaña Proveedor tiene «Capturar OC»).

#### B. Cómo debe quedar: el flujo, paso por paso

| # | Paso | Quién | Qué pasa con el pedido | Quién se entera y cómo |
|---|---|---|---|---|
| 1 | La sucursal ve que le falta algo que **nadie ha pedido** (estado de AB.26) y pulsa «Generar requisición» | Almacenista | Nada todavía | — |
| 2 | Se arma: cada renglón ya trae a quién se le pide («Surte»); **sale una requisición por origen** (su matriz / cada proveedor), en `pending_approval`, marcada como **pedida por sucursal** | Almacenista | En la sucursal, esos renglones pasan a **«Pedido a Compras · por aprobar»** y no se vuelven a sugerir. En la matriz, si es traspaso, **queda comprometido** (D10) | **Compras: tarea en «Mi trabajo»** «Requisiciones de sucursal por aprobar» (D12) |
| 3 | Compras revisa: si es traspaso, ve **cuánto tiene la matriz después de lo comprometido**; si no alcanza, decide comprar a la matriz (bajada) o al proveedor | Comprador | Si se agrega compra a la matriz, entra al pedido general de esa matriz | — |
| 4a | **Aprueba** (todo o con cantidades ajustadas) | Comprador | La requisición queda aprobada; sigue comprometida en la matriz | **Sucursal: aviso en «Mi trabajo»** «Aprobada: se pasa a Kepler» |
| 4b | **Rechaza** con motivo obligatorio | Comprador | Se libera lo comprometido; los renglones vuelven a «Nadie lo ha pedido» | **Sucursal: aviso con el motivo**; se guarda quién y cuándo (hoy no) |
| 5 | **Se pasa a Kepler** (`U-D-40` en la matriz si es traspaso; `X-A-30`/OC si es compra) y **se registra el folio** (AB.30) | Quien captura (matriz o Compras) | Pasa a «ordenado»; el renglón deja de contarse como plan y cuenta como **«ya viene»** (sin doble conteo) | La sucursal lo ve en «Lo que te llega» con su folio |
| 6 | La matriz embarca (`U-D-41`) | Matriz | **«En camino»**; se libera lo comprometido (ya salió) | «Lo que te llega» |
| 7 | La sucursal recibe (`U-A-50`) | Almacenista | Sube la existencia | — |
| 8 | Si la matriz no surtió todo (**negado**) | — | El faltante vuelve a aparecer como falta en la sucursal | Sucursal y Compras ven el negado (ya existe en «Mi pedido») |

**Respuesta directa a «¿afecta al pedido?»:** sí, en tres lugares, y hoy ninguno está resuelto:

1. **A la sucursal:** lo que pidió no se debe volver a sugerir. Hoy su propia requisición de **compra** ni
   siquiera aparece en «Mi pedido» (`PLANEADO_COMPRAS_SQL` sólo lee traspasos).
2. **A la matriz:** lo que le piden sus sucursales tiene que restarse de lo que tiene disponible (D10).
   Si no, el mismo inventario se cuenta para la venta de la matriz y para el traspaso, y se le promete
   a dos sucursales lo mismo.
3. **Al pedido general de Compras:** cuando la matriz no alcanza, el faltante tiene que convertirse en
   compra para la matriz. Hoy sólo pasa si el comprador consolida a mano (D11).

#### C. Decisiones a firmar

| # | Decisión | Recomendación | Por qué |
|---|---|---|---|
| **D10** | ¿Lo que una sucursal pide a su matriz se aparta de la existencia de la matriz? | **Sí:** los pedidos de traspaso abiertos y las requisiciones de traspaso aprobadas (no las pendientes) se restan de lo disponible de la matriz en el plan de traspasos y en el sobrante de la red | Sin esto la matriz se compromete dos veces. ⚠️ Cambia cifras de `/compras/pedido`: va en commit aparte con su antes/después |
| **D11** | Cuando la matriz no alcanza, ¿el faltante se vuelve compra para la matriz sola? | **Sí, como sugerencia en el pedido de Compras** («la matriz necesita X para surtir a sus sucursales»), no como compra automática | Hoy depende de que el comprador lo note y consolide a mano |
| **D12** | ¿Quién se entera de cada paso? | **Compras:** tarea en «Mi trabajo» por cada requisición de sucursal por aprobar. **Sucursal:** aviso al aprobarse o rechazarse, con el motivo. Con el contrato de tarea que ya existe (ADR-061/081), sin canal nuevo | Hoy nadie se entera de nada; 590 traspasos aprobados llevan una semana parados sin que nadie lo vea |
| **D13** | ¿Quién aprueba la requisición de sucursal? | **El comprador** (`gerente_compras`, que ya aprueba 648 de 649) con `AUTOABASTO_AUTORIZAR`; si pasa el tope de inventario en pesos, **Dirección** con `AUTOABASTO_EXCEDER_TOPE` (escalera §6.1). La banda «se aprueba sola» queda para después, con volumen medido | Las llaves ya están repartidas y ningún endpoint las usa |

#### D. Items nuevos

- **AB.31 — Lo comprometido en la matriz** (D10). C1, motor; cambia cifras de Compras → antes/después.
- **AB.32 — Avisos del flujo** (D12): tarea de Compras por aprobar y aviso a la sucursal; rechazo con
  motivo, quién y cuándo.
- **AB.33 — Arreglos del flujo de requisiciones que ya existe**: los dos botones con permiso cruzado,
  registrar el folio también en traspasos (va con AB.30), mostrar quién creó la requisición, y que la
  requisición de compra de la sucursal aparezca en «Mi pedido».
- AB.29 se amplía: la requisición queda **marcada como pedida por sucursal** (columna de origen,
  migración aditiva) y sus renglones dejan de sugerirse mientras esté viva.

**Lo que NO se pudo determinar:** si hay algo fuera de estos archivos que aparte existencia en la
matriz; y el estado vivo del envío automático (el último dato, 22-oct, decía apagado).

#### E. Lo que ya cubre la fase PQ — no se duplica

El mismo 2026-10-23 otra sesión abrió **PQ** (`FASE_PQ_PEDIDO_VERDAD_Y_CIERRE.md`, «del sugerido al
ERP sin inventar nada»), que pasó PO a ⏸️. Ataca el mismo hueco desde el lado de Compras, y su medición
(M2) es más fina que la de §16.12: **el 54.8 % de los traspasos aprobados no tiene ningún `U-D-40` con
sus SKUs en 15 días**, y de lo que sí llega, el comprador cambia la cantidad en Kepler en el 31 %. O sea
que hoy el pedido de la Suite se pasa a Kepler **sólo en parte**.

| Lo que AB necesita | Lo construye | Item |
|---|---|---|
| Registrar el folio del traspaso pasado a mano | PQ | PQ.2 (cierre manual con la coordenada del `U-D-40`/`U-D-41`) |
| Registrar el folio de la compra | PQ | PQ.7 (la OC exige la coordenada de Kepler) |
| Envío automático a Kepler | KR | KR.9 / KR.11 (cada sucursal escribe en su servidor) |
| Rechazo y cancelación con motivo | PQ | PQ.9 |
| Quién aprobó y qué vio | PQ | PQ.11 |
| Duplicado entre días | PQ | PQ.8 |
| Permisos cruzados de los botones y quién creó la requisición | **se entregan a PQ** (su pantalla, que está editando) | AB.33 (1)–(3) |
| La cuenta única de la sucursal, la mesa, «Lo que te llega» | AB | AB.26–AB.28 |
| La requisición nacida en la sucursal y sus avisos | AB | AB.29, AB.32 |
| Lo comprometido en la matriz | AB, **acordado con PQ** (toca el número de `/compras/pedido`, que PQ dice que sólo mueve PQ.6) | AB.31 |

**Orden:** AB.26 ✅ → AB.27 (la mesa sobre la cuenta única) → AB.28 (pantallas) → AB.29 + AB.32 juntos,
**cuando PQ.2 y PQ.9 estén** (la requisición de sucursal no sale sin folio, sin motivo de rechazo ni
avisos) → AB.31 (con PQ). AB.30 se cierra solo cuando PQ.2/PQ.7 escriban el folio.

### 16.14 El pedido de una sucursal (no matriz), de punta a punta — ejemplo y lo que falta (2026-10-24)

El PM pidió un ejercicio desde cero para ver cómo se **informa** y cómo se **genera** el pedido de una
sucursal que no es matriz. Le gustó el plan; queda escrito así. **Números ilustrativos**: muestran la
mecánica, no son datos de prod.

**Escenario:** La Piedad Abastos, que se surte de su matriz Padre Hidalgo. Lunes 8 am, cajas.

| Producto | Surte | Objetivo | Existencia | Falta | Ya viene | Falta neta |
|---|---|---:|---:|---:|---|---:|
| Mazapán | Padre Hidalgo (traspaso) | 42 | 10 | 32 | pedido abierto 12 + embarque 8 = 20 | **12** |
| Chicle | Padre Hidalgo (traspaso) | 30 | 5 | 25 | nada en Kepler; Compras planeó 25 en la Suite (no se resta) | **25** |
| Paleta | Padre Hidalgo (traspaso) | 20 | 6 | 14 | embarque 14 | **0** |
| Agua | Proveedor X (compra) | 50 | 20 | 30 | nada | **30** |
| Cacahuate | Proveedor Y (compra) | 25 | 40 | 0 | — | no aparece |

| Paso | Qué pasa | Quién se entera | Existe hoy |
|---|---|---|---|
| **1. Se informa** | La mesa: falta por pedir 2 (Mazapán, Agua) · Compras lo planeó 1 (Chicle) · ya viene 1 (Paleta). «Lo que te llega» lista el pedido 0450, el embarque 0391 y el plan RQ-2026-00123 «aún no en Kepler» | La sucursal, sin llamar a nadie | ✅ en código (AB.26–AB.28a) |
| **2. Se genera** | «Generar requisición» prellenada sólo con la falta por pedir: Mazapán 12 (traspaso) · Agua 30 → la sucursal deja 24 con motivo «espacio en bodega». El Chicle no se prellena (ya lo planeó Compras). Salen **RQ-201** (traspaso) y **RQ-202** (compra), pendientes, marcadas «pedida por sucursal»; en la mesa pasan a «Pedido a Compras · por aprobar» | — | ⬜ AB.29 |
| **3. Compras se entera** | Tarea en «Mi trabajo»: «2 requisiciones de La Piedad Abastos». En `/compras/pedido`, celda La Piedad × Mazapán: falta 32 − ya viene 20 = **12** (hoy diría 32: planearía 20 de más) y el aviso «la sucursal pidió 12 (RQ-201, por aprobar)», que no se resta | Compras | ⬜ AB.32 + D14/D15 |
| **4. Compras decide** | Aprueba RQ-201: en Padre Hidalgo quedan apartados 12 (si tenía 100, quedan 76 disponibles, D10). RQ-202: aprueba, cambia o rechaza **con motivo** | La sucursal recibe aviso con el motivo | ⬜ AB.31 + PQ.9 |
| **5. Se pasa a Kepler** | Padre Hidalgo captura el pedido de traspaso y registra el folio en la Suite; Compras captura la OC del agua y registra su folio. Desde ahí cuenta como «ya viene», una sola vez | La sucursal lo ve con su folio | ⬜ PQ.2 / PQ.7 |
| **6. Embarque y recepción** | «En camino» y se libera lo apartado; al recibir sube la existencia. Si la matriz manda 10 de 12, los 2 vuelven como falta y el faltante de surtido se ve | Sucursal y Compras | ✅ el faltante de surtido ya existe en «Mi pedido» |

#### D14 y D15 — con los ajustes que pidió la sesión de PQ (2026-10-23)

| # | Decisión | Forma acordada entre AB y PQ | Firma |
|---|---|---|---|
| **D14** | ¿Lo que pidió la sucursal cambia el sugerido de Compras? | **Resta** en la celda de la sucursal sólo lo que es mercancía en movimiento: pedido de traspaso abierto de 7 días o menos y embarque sin recibir, **contados desde el documento de Kepler**, nunca desde la requisición aprobada en la Suite (PQ M2: el 55 % de esas no tiene ningún `U-D-40`). Las requisiciones de la sucursal **se muestran y no se restan**. Al aprobarse, la requisición se liga a su origen | ⬜ el PM aprobó el plan; falta la firma explícita |
| **D15** | ¿Dónde atiende Compras lo que pide la sucursal? | **No es bandeja nueva:** `/compras/requisiciones` con el filtro «pedida por sucursal», más la tarea en «Mi trabajo» (AB.32). La liga origen → atención ya existe desde `[RQ.8]` | ⬜ ídem |

**Los cuatro ajustes de PQ, aceptados:**
1. **Una sola regla de «ya viene».** La cuenta de traspasos abiertos y embarques sin recibir sale de UNA función compartida en `libs/` (al lado de `transito.ts`), con las ventanas de 7 días, la conversión de unidades de AB.23 y una consulta para toda la red. «Mi pedido», la mesa y `/compras/pedido` la consumen; nadie la reescribe (ADR-056).
2. **La matriz con su venta propia + lo comprometido**, nunca con la suma de la venta de sus sucursales (`eff_daily`): sería contar dos veces junto con D10.
3. **D15 sin bandeja nueva** (arriba).
4. **El número de `/compras/pedido` cambia en UN commit con antes/después, y no espera a M1:** restar lo que ya viene es un hecho, no una calibración.

**Dos condiciones de AB:**
- La medición antes/después que corre el código del servicio desde una laptop contra prod sólo es aceptable con conexión de sólo lectura (`default_transaction_read_only = on`) y `system_identifier` impreso, y así se escribe en el commit. Si no, roza la regla de no levantar el backend local.
- Extraer la cuenta (AB.34) no puede cambiar lo que devuelve «Mi pedido»: se prueba contra prod en sólo lectura antes de que PQ la use.

**El reparto:**

| Quién | Qué |
|---|---|
| **AB.34** | La función compartida «lo que la sucursal ya pidió»: traspaso abierto ≤ 7 d + embarque sin recibir, en unidad base, para toda la red, con su prueba contra prod |
| **PQ** | Consumirla en `workbook` y `transferPlan` como descuento por celda, mostrar «la sucursal ya pidió» y hacer **el commit del número** con su antes/después. ⚠️ **Número de item por asignar:** PQ propuso «PQ.12», pero ese número ya lo usa PQ para «la matriz pide lo que sus sucursales le van a sacar» (CEDIS) |
| **AB.31 / D10–D11** | Lo comprometido en la matriz, coordinado con PQ. ⚠️ Se cruza con ese PQ.12 del CEDIS: es la misma pregunta («cuánto le van a sacar a la matriz») vista desde 00. Hay que decidir quién la responde antes de que los dos la construyan |

#### Un error que el ejercicio destapó — AB.35

En el Mazapán, la mesa (AB.28a) dice **«Nadie lo ha pedido»** aunque ya vienen 20 de 32: el rótulo
afirma algo falso cuando la cobertura es parcial (ley 0 del estándar de interfaces). `estadoRenglon`
devuelve `sin_pedir` siempre que quede falta neta, venga algo o no. Arreglo: el estado se llama
**«Falta por pedir»** y su explicación dice cuánto falta y cuánto ya viene. Es texto del contrato y de
la pantalla, con su prueba (un renglón con cobertura parcial no puede decir «nadie»).

### 16.10 Definición de Terminado

- [ ] Métrica re-medida con la misma consulta, antes/después publicado.
- [ ] C0–C3 verificadas o declaradas NO MEDIDO.
- [ ] «Generar requisición» (AB.29) ejercida contra base real con el payload de la pantalla, con sus negativas (fuera de alcance → 403).
- [ ] La prueba negativa de AB.26 vista en rojo.
- [ ] La línea del renglón vive en `libs/contracts` (sin segundo cálculo en el front).
- [ ] Tracker, `03_LOG_REVISIONES.md`, fila de AB en el roadmap y ADR-100 al día.
- [ ] En prod, o escrito por qué no.
