# FASE AB — Autoabasto y Nivelación de Inventarios

> **Estado:** 🔨 DISEÑADO (planeación) · 2026-09-19 · **ADR-075 propuesto**
> **Superficie:** `/almacen/autoabasto` y `/almacen/nivelacion` — dos submódulos nuevos del proyecto Almacén.
> **Dueño operativo:** almacenista y encargado de sucursal. **El comprador NO opera este módulo**: recibe la solicitud.

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
