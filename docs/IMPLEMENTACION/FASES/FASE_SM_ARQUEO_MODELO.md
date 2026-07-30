# Análisis profundo — Cómo debe ser un arqueo de caja (SM)

> Investigación 2026-07-30. Aterriza el modelo correcto de arqueo/cuadre de efectivo, con foco en los **retiros** como unidad de auditoría. Datos verificados contra `analytics.cash_cuts` (Kepler) y `wincaja.*` (POS itemizado). Insumo para la evolución del Supervisor de Movimientos (SM) y de `/tienda/arqueo`.

## TL;DR

1. Un arqueo **no es** "contado vs esperado al cierre". Es la reconciliación de una **identidad de caja** que incluye el fondo, las ventas en efectivo y **cada retiro** del turno.
2. Hoy el motor SM cuadra contra el **esperado agregado de Kepler** (`c15`), que **ya puede venir cuadrado** con un retiro-plug. Eso es medir contra un número contaminado.
3. El **contado de Kepler (`c25`) no es el conteo físico**: solo el 15% de los cortes lo iguala al arqueo por denominación. Es un número declarado (arqueo no ciego).
4. Existe un mecanismo explícito de cuadre: **retiros marcados `por_diferencia_corte` = $64.25M** en 4,947 eventos (avg $12,988, ~32% del valor de todos los retiros). Es el candidato #1 a enmascaramiento.
5. La data itemizada para hacerlo bien **ya está cargada** en `wincaja.*` (retiros, arqueos por denominación, pagos por hora). Falta conectarla al motor.

---

## 1. La identidad de caja (el modelo correcto)

Por **caja × turno** (no por día):

```
  Fondo inicial (dotación)                          [+]
+ Ventas cobradas en EFECTIVO                       [+]   pagos_dia forma=1 (Efectivo)
+ Otros ingresos en efectivo (cobranza CxC)         [+]
− Devoluciones / pagos en efectivo                  [−]   retiros/pagos (DEVO-*)
− Retiros / sangrías a bóveda                       [−]   wincaja.retiros (normales)
− Retiro de cierre (barrido del remanente)          [−]   wincaja.retiros (por_diferencia_corte)
= EFECTIVO TEÓRICO en el cajón                      [=]
vs EFECTIVO CONTADO (arqueo por denominación, ciego)      wincaja.arqueos
= DIFERENCIA  (faltante + / sobrante −)
```

El arqueo actual (SM.8/P1) solo modela la última línea (`contado ciego vs c15`). Le faltan el fondo, la separación de formas de pago y — sobre todo — **los retiros como términos explícitos de la ecuación**.

---

## 2. Por qué "cada retiro" es la unidad de auditoría

Un retiro es **efectivo que sale del cajón a media operación** — un evento discreto con hora, monto, cajero y motivo. No es un residuo del cierre; es donde se rompe el cuadre.

**Datos (Wincaja, `wincaja.retiros` = 51,323 eventos):**
- 45,307 retiros **normales** (sangrías) · 6,015 **`por_diferencia_corte`** · dotación inicial.
- Distribución por (caja, día): muchos cortes con **2–12+ retiros**. No es un evento por turno; es una secuencia.
- Cada retiro trae `monto`, `fecha` (con **hora**), `cajero`, `forma_de_pago`, `observacion` (motivo: `BILLETE`, `DEVO-####`, …).

**Consecuencia:** el descuadre del cierre es la SUMA de errores de toda la secuencia. Sin los retiros itemizados no puedes ubicar **en qué evento** se rompió (un retiro mal contado crea un faltante fantasma imputable a ESE retiro, no al turno). Un arqueo serio **cuenta cada retiro** (mini-arqueo) y sella hora+cajero+motivo.

---

## 3. El hallazgo crítico: `por_diferencia_corte` ($64.25M)

- **4,947 retiros de efectivo** marcados `por_diferencia_corte` — total **$64,253,149**, promedio **$12,988**.
- Un "retiro por diferencia de corte" es el POS **anotando un movimiento para que el corte cuadre**. Dos lecturas:
  - **Legítima:** barrido final del cajón a bóveda (se retira exactamente el remanente sobre el fondo).
  - **Enmascaramiento:** si el corte NO cuadra, se anota un "retiro por diferencia" del tamaño del hueco → el corte cuadra en papel y el faltante **desaparece disfrazado de retiro**.
- Es el mecanismo más probable detrás del **73% que cuadra exacto al centavo**. El arqueo ciego lo destapa porque cuenta el físico **antes** de que se anote el retiro-plug.
- **Concentración** (efvo, top sucursales Wincaja): `10` $13.2M · `50` $7.3M · `32` $4.4M · `503` $3.8M. → auditoría dirigida.

Regla nueva evidente: **retiro `por_diferencia_corte` cuyo monto ≈ el descuadre del turno = bandera de enmascaramiento.**

---

## 4. Qué está mal en el modelo actual (SM / analytics.cash_cuts)

| Problema | Detalle | Evidencia |
|---|---|---|
| Cuadra contra un esperado contaminado | `c15` puede venir ya cuadrado vía retiro-plug | $64M en `por_diferencia_corte` |
| `c25` no es conteo físico | "Contado" declarado, no arqueo por denominación | solo 15% (337/2178) cumple `c25 = Σ arqueo` |
| Retiro solo como TOTAL | Kepler `c48` es un agregado; se pierde la secuencia, hora y motivo | 51,323 retiros itemizados viven solo en Wincaja |
| Sin fondo ni formas separadas | La ecuación no arranca del fondo ni aísla el efectivo | — |
| Match arqueo↔corte por fecha | Ignora hora/turno; ~4.5% de caja-días tienen 2+ cortes | (medido en la sesión) |

---

## 5. Cómo debe ser el arqueo (propuesta)

**Fuente de verdad:** reconstruir la identidad desde **Wincaja itemizado** (pagos_dia + retiros + fondo + arqueos por denominación) por caja×turno. Kepler `cash_cuts` queda como capa agregada de contraste, no como verdad.

**Arqueo ciego por EVENTO (no solo al cierre):**
1. **Apertura:** contar el fondo (dotación) a ciegas.
2. **Cada retiro/sangría:** contar lo que se saca (mini-arqueo), sellar hora+cajero+motivo. El monto contado debe igualar el registrado.
3. **Cierre:** contar el remanente por denominación, a ciegas.
4. **Cuadre:** `fondo + ventas_efvo − Σ retiros_contados = remanente_teórico` vs `remanente_contado`; la diferencia se **imputa al evento**, no al turno.

**Reglas de descuadre nuevas (motor SM):**
- `retiro_plug` — retiro `por_diferencia_corte` con monto ≈ descuadre → enmascaramiento (crítico).
- `retiro_sin_conteo` — retiro grande sin arqueo asociado.
- `retiros_fragmentados` — N retiros/turno > umbral (fragmentación para diluir).
- `diferencia_por_evento` — descuadre imputado a un retiro/venta específicos.
- `fondo_inconsistente` — dotación de apertura ≠ remanente sellado del cierre anterior.

**Autolineado por retiro (extiende SM.9):** cada retiro capturado que no cuadre → descuadre inmediato + WS, igual que hoy hace el cierre.

---

## 6. Prerrequisitos / trampas de datos

1. **`forma_pago` NO es estable entre sucursales.** Solo `1 = Efectivo` es constante; `3/4/5` significan tarjeta/crédito/vale **distinto por tienda** → hay que resolver contra el catálogo por sucursal `wincaja.formas_pago`, nunca agregar por código crudo. (Verificado: suc 00 `3=Tarjeta` vs suc 10 `3=Crédito`, `5=Tarjeta`.)
2. **Mapear sucursales Wincaja ↔ Kepler.** Wincaja usa `10,40,44,54,50x,32,…`; Kepler `00–05`. Padre Hidalgo = Kepler `01` = Wincaja `10`; 8 Esquinas `03`↔`40`; Yurécuaro `04`↔`44`; Zamora `05`↔`54`. Confirmar el resto.
3. **Conectar `wincaja.*` al motor SM.** La data ya está cargada (Fase W). Falta un feed/vista que exponga la identidad por caja×turno + los retiros itemizados al plano Caja del motor.
4. **`arqueos` por denominación** tiene outliers ($1.3M en un folio con 5 denominaciones) → validar unidades/consolidaciones antes de usarlos como conteo.

---

## 7. Números de referencia (verificados 2026-07-30)

- Kepler `analytics.cash_cuts`: 2,178 cortes · 69% con retiro · Σ retiros (c48) $39.4M.
- Wincaja: `retiros` 51,323 · `arqueos` (denominación) 17,233 · `pagos_dia` 687,553 · `cortes` 5,706.
- Retiros efvo `por_diferencia_corte`: $64.25M / 4,947 / avg $12,988.
- `pagos_dia` efectivo (forma 1): ~$195M / 645k tickets.
- `c25 = Σ arqueo denominación`: solo 15% de los cortes.

---

## 8. Fork de implementación (pendiente de decisión)

- **A — Reglas sobre lo que ya hay:** añadir al motor SM las reglas `retiro_plug` / `retiros_fragmentados` leyendo `wincaja.retiros` (sin cambiar el arqueo ciego). Valor rápido, destapa el $64M. Sin cambios de captura.
- **B — Arqueo por evento (completo):** re-modelar la captura (fondo + mini-arqueo por retiro + cierre) y reconstruir la identidad desde Wincaja. Más grande; es el modelo "correcto" de este documento.
- **C — Solo desambiguar match por hora/turno** (lo mínimo de la pregunta original), sin tocar retiros.

Recomendado: **A primero** (destapa el enmascaramiento con la data ya cargada, cero fricción de captura), luego **B** por rebanadas.

---

## 9. Ejecución — Slice A.1 ✅ (2026-07-30)

Regla `barrido_diferencia_multiple` en el motor SM (`movement-reconcile.service`), lee **`wincaja.retiros`** directo (RLS forzado, `app_runtime` con SELECT, filtro `tenant_id` explícito):

- **Señal:** >1 retiro de EFECTIVO (`forma_de_pago='1'`) marcado `por_diferencia_corte`, mismo **cajero×caja×día**. El barrido de cierre legítimo es 1/turno; varios = plugs a media operación → el corte cuadra por construcción. Agrupar por **cajero** (no solo caja) quita el falso positivo de 2 turnos.
- **Etiqueta:** join a `wincaja.branches` (crosswalk ya existente: `source_branch`→`branch_name`/`warehouse_code`/`is_route`).
- **Params:** `min_barridos=2`, `critico_barridos=3`, `min_monto=3000`. `causa_probable='barrido_diferencia'`.
- Fluye a la bandeja de Descuadres (render genérico, plano Caja) sin cambios de frontend. Notifier nocturno empuja solo los críticos.
- **Smoke (data real, d01c):** **184 hallazgos**, **$3.9M** en efvo barrido, 2 críticos (≥3 barridos). Concentra en `live_on_wincaja` (CANINDO, MORELIA MADERO) y rutas venta-a-bordo. Builds api+view OK.

**Cobertura de datos (verificada):** arqueo por denominación (`wincaja.arqueos`) solo en sucursales **30/32/50** → la reconstrucción total de la identidad con conteo físico (Slice B) es parcial hoy. Los joins `pagos_dia`/`arqueos`↔`cortes` NO son por rango de folio limpio (folios alfanuméricos) → Slice B necesita descifrar esas llaves.

**Siguiente (B, por rebanadas):** reconstruir la identidad `fondo+ventas_efvo−Σretiros vs arqueo` donde haya `wincaja.arqueos` (30/32/50), y el crosswalk Wincaja↔Kepler a nivel caja/cajero para ligar el barrido al descuadre real del corte.
