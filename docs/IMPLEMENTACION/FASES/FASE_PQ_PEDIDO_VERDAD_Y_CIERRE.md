# Fase PQ — `/compras/pedido`: del sugerido al ERP sin inventar nada

> El método que la gobierna: [`docs/METODO_DE_TRABAJO.md`](../../METODO_DE_TRABAJO.md).
> El flujo que audita: [`docs/FLUJO_COMPRAS_PEDIDO.md`](../../FLUJO_COMPRAS_PEDIDO.md) y las nueve
> fichas de [`docs/PROCEDIMIENTOS/COMPRAS/`](../../PROCEDIMIENTOS/COMPRAS/README.md).

```
OBJETIVO: Que lo que la pantalla de Pedido propone, el comprador decide y la Suite aprueba
          (1) llegue al ERP sin recapturar, (2) sea idéntico a lo que Kepler registra, y
          (3) se pueda juzgar después: si la corrección humana mejoró, repitió o empeoró el sugerido.
MÉTRICA:  Requisiciones aprobadas que llegaron a un documento de Kepler — HOY (2026-10-23):
          1 de 1,301 con kepler_folio (y apunta a un documento borrado); 680 en `approved` sin salida
          por $19.05 M → META: 0 aprobadas sin documento del ERP a los 7 días, para <fecha a firmar>
          Métrica 2: veredicto comprador vs sugerido — HOY: NO MEDIDO (sólo se sabe que 2,726 de 7,111
          renglones subieron el sugerido en 30 d) → META: veredicto mejor/normal/peor en el 100 % de
          los renglones con venta posterior.
CAPA TOPE: C3 (la agenda y el Ciclo como entrada) — pero los frentes M1 y M2 se quedan en C0.
ÁREA:      Comercial (Compras)
DUEÑO:     <a firmar: el PM abrió la fase el 2026-10-23 sin nombrar dev; sin dueño y fecha cae a ⏸️ (método §3)>
ESTADO:    🔨 desde 2026-10-23 — el PM pasó PO a ⏸️ para hacerle lugar (PO: sin commit desde el 3-oct,
           0 items en el tracker). Fila en el roadmap de CLAUDE.md. M1 y M2 ya corrieron (§11).
```

**Con qué se midió:** `pg-prod` `192.168.0.222:5434`, `system_identifier 7688376744939610156`,
2026-10-23 09:06, `SET default_transaction_read_only = on`. Ventanas de 30 días salvo que se diga
otra. Nivel de evidencia **B + C**: ninguna cifra visual; la pantalla viva no se midió hoy.

---

## 0. El pedido literal, y cómo cambió

| # | Lo que se pidió (cita) | Efecto |
|---|---|---|
| 1 | *«aún hay cosas que mejorar en /compras/pedido … jerarquizar en nivel de importancia … primero busquemos el flujo y estructura antes de codificar»* | Auditoría del flujo, nivel B+C; jerarquía dinero × esfuerzo (§3) |
| 2 | *«agregar también una agenda de proveedores: ¿cada qué viene cada proveedor? ¿pedirle cobertura para 30 días?»* | Frente **F2** (§5). Se midió que la cadencia ya existe derivada y que el 75 % de los canales es irregular |
| 3 | *«algo más importante … cómo influyen los nuevos pedidos (mejor, normal o peor) vs sugerido, y si las requisiciones son idénticas en costos o información a las de Kepler, para que no haya información inventada de nuestro lado»* | Frentes **M1** y **M2**, van **primero**: son medición sin código y gobiernan todo lo demás |
| 4 | *«documentemos nuestros objetivos, hagámoslos entregables y fases»* | Este documento + sección `[PQ]` del tracker |

---

## 1. En una pantalla

`/compras/pedido` ya contesta bien **cuánto** pedir (motor con cobertura, tránsito, unidades,
costo y negociación) y la bandeja de aprobación ya se vacía (43 pendientes, 1 día de promedio;
el 6-oct eran 610 por $42.7 M). **El cuello se movió aguas abajo**: lo aprobado no sale a Kepler,
nadie captura la coordenada de la OC, y nadie mide si el comprador le gana al motor.

| Hecho (prod, 2026-10-23) | Valor |
|---|---:|
| Requisiciones totales | 1,301 |
| `approved` sin avanzar | **680 por $19.05 M** (602 traspasos $12.81 M · 78 compras $6.24 M), 7 d promedio, 25 d la más vieja |
| Con `kepler_error` = «KEPLER_PUSH_URL sin configurar» | **134** (66 compras · 68 traspasos) |
| Con `kepler_folio` | 1 (documento borrado en Kepler el 13-oct) |
| Con `oc_folio` (coordenada de la OC de Kepler) | **0** · 183 `ordered` sin folio = 183 OC internas en 30 d |
| Traspasos `branch` que alguna vez llegaron a `received` | **0** en toda la historia |
| Canceladas | 395 por $34.72 M; `notes` trae la descripción del motor, **ningún motivo** |
| Repetidas en 30 d (proveedor, almacén, producto) vivas | **84 grupos, 388 renglones, $3.30 M** |
| Renglones 30 d: subieron / bajaron / igual al sugerido | **2,726 / 273 / 4,112** de 7,111 |
| Aprobaciones 30 d | 863: **849 de una persona**, 484 (56 %) por quien creó, mediana 20 h |
| Uso de pestañas 30 d (hits al API) | Pedido `workbook` 3,734 · Ciclo `worklist` **7** · Flujo 5 · Sobrante 5 |
| `workbook` esta semana | 1.7–2.0 s promedio, pico 11.4 s · XLSX 10.9 s promedio, pico 121 s |
| Canales de compra con cadencia | 1,049 (301 proveedores), mediana 16 d, p90 54 d |
| Canales de compra **regulares** (≥4 entregas, gap máx ≤ 2× cadencia) | **221 de 886 (25 %)** |
| Cadencia manual / lead time capturado | **0 / 0** |
| Canales de compra vencidos / toca hoy / próximos 7 d | 637 / 24 / 89 |

---

## 2. El universo medido contra el trabajo

- **Universo:** 1,301 requisiciones, 2,313 canales (1,049 de compra), 301 proveedores.
- **Trabajo de PQ:** (a) las **680 aprobadas sin salida** y el mecanismo que las produce; (b) los
  **1,049 canales de compra** para la agenda, de los que sólo 221 se pueden derivar con confianza;
  (c) las dos mediciones sobre los **renglones de 30 días** (7,111) y sobre las requisiciones con
  documento en Kepler (universo a medir en M2; el 16-oct eran 121 compras y 0 traspasos cruzados).

---

## 3. Lo que creíamos y cayó

| # | Lo que decía | Lo que midió prod |
|---|---|---|
| 1 | «La bandeja no se vacía» (610 pendientes, 2026-10-06) | 43 pendientes, 1 día. **Resuelto por `[RQ]`**; el problema ya no es ahí |
| 2 | «Las canceladas tienen notas» (395 de 395 con `notes`) | `notes` es la descripción del motor («Demand-driven (venta × cobertura)»); **el motivo no existe** |
| 3 | «La cadencia derivada basta para una agenda» | 3 de 4 canales son irregulares (dispersión 27–79 d entre tramos); una agenda derivada diría una fecha equivocada la mayoría de las veces |
| 4 | «Cobertura 30 d es lo correcto» | Es el default y el override por proveedor existe; pero a un proveedor semanal (185 canales) son 3 semanas de sobrestock y a uno de >35 d (172 canales) se queda corto. El motor ya tiene base `cadence` = demanda × (cadencia + lead) y **lead está en 0 en los 1,049 canales** |
| 5 | «El Ciclo ordena el día del comprador» (RA-CICLO.1) | 7 hits en 30 d contra 3,734 de Pedido. **Nadie entra por ahí** |

---

## 3b. Los ocho hallazgos de la auditoría, jerarquizados, y a dónde fue cada uno

Dinero en juego × esfuerzo (método §3.1). Cada hallazgo tiene item; ninguno se queda en la prosa.

| # | Hallazgo | Medido hoy (2026-10-23) | Dinero | Esfuerzo | Prioridad | Item |
|---|---|---|---|---|---|---|
| 1 | **Lo aprobado no sale a ningún lado.** `approved` es terminal de hecho: el empuje a Kepler sigue apagado. Los traspasos no tienen camino manual: en toda la historia **0** de tipo `branch` llegó a `received` | 680 aprobadas por **$19.05 M** (602 traspasos $12.81 M · 78 compras $6.24 M); 134 con `kepler_error`; la más vieja 25 d | Alto | Bajo (runbook KR.9: variable + GRANT + pg_hba) | **1** | PQ.1 · PQ.2 · KR.9 |
| 2 | **El disparador del flujo no se usa.** La pestaña Ciclo era «a quién le toca hoy»; el comprador entra directo a Pedido | `worklist` **7 hits** en 30 d contra 3,734 de `workbook`; 1,372 de 2,313 canales vencidos (59 %), 23 d de atraso medio | Alto (el 8-oct colgaban $11.77 M de venta/30 d; hoy NO re-medido) | Medio | **2** | PQ.3 · PQ.4 · PQ.5 · PQ.6 |
| 3 | **Se pide lo mismo dos veces y se cancela sin motivo.** `LOTE_REPETIDO` sólo frena el lote idéntico; el duplicado entre días pasa. Las canceladas no tienen motivo: `notes` trae la descripción del motor | 84 combinaciones (proveedor, almacén, producto) repetidas en 30 d, 388 renglones, **$3.30 M** vivos · 395 canceladas por $34.72 M sin porqué | Medio-alto | Medio | **3** | PQ.8 · PQ.9 |
| 4 | **El lazo no se cierra.** `oc_folio` en 0 porque la OC interna rodea a `markOrdered`. Flujo y Sobrante casi no se abren | 183 `ordered` sin folio = 183 OC internas en 30 d · `purchase-flow` 5 hits · `sobrante` 5 hits | Medio (sin esto no hay lead time ni fill rate real) | Medio (decisión D3) | **4** | PQ.7 |
| 5 | **Lo construido no está en prod.** Prod corre `bc9031c72` (22-oct 12:09); RA-NEG.1–3 no llegaron; auto-deploy comentado; índice `ix_kdm2_compra_sku` no existe | 55 commits después del build de prod; 7 sin push | Bajo directo | **Muy bajo** | primero por costo | items existentes: deploy · `[RA-NEG.5]` |
| 6 | **Velocidad.** Regla dura: >500 ms no funciona | `workbook` 1.7–2.0 s promedio, pico 11.4 s · `transfer-suggestion` 3.0 s · XLSX 10.9 s, pico 121 s · `dead-stock` 16.5 s | Indirecto (3,734 cargas × ~5.5 s ≈ 5.7 h esperando en 30 d) | Alto (precalcular resumen por producto) | **5** | PQ.10 → `[RA-UX.11b]` |
| 7 | **La autorización es un segundo clic** | 863 aprobaciones en 30 d: **849 de una persona**, 484 (56 %) por quien creó, mediana 20 h | Control, no dinero | Medio | **6** | PQ.11 |
| 8 | **El motor se corrige siempre hacia arriba y nadie lo mide** | 7,111 renglones en 30 d: **2,726 subieron**, 273 bajaron, 4,112 igual | Desconocido (motor corto o sobrecompra) | Bajo (medir) | **7, pero medir ya** | PQ.M1 |

Y lo que se sumó después de la jerarquía, por pedido del PM: la **agenda de proveedores** (F2, misma
casa que el hallazgo 2) y el **cuadre contra Kepler** (PQ.M2, que va antes que todo).

---

## 4. Decisiones a firmar

| # | Decisión | Opciones | Recomendación |
|---|---|---|---|
| D1 | Qué pasa con lo aprobado | (a) encender KR.9 en prod · (b) cierre manual del traspaso en la Suite · (c) las dos | **(c)**: KR.9 es el camino, pero mientras esté apagado la pantalla debe decir «aprobada, SIN documento en Kepler» y dar salida manual. Hoy `approved` es terminal y nadie lo ve. ✅ **Firmada (c) por el PM, 2026-10-23** |
| D2 | Cómo entra el comprador | (a) Ciclo como pestaña inicial · (b) aviso «hoy te toca: N proveedores» arriba de Pedido · (c) agenda por proveedor como entrada | **(b) + (c)**: el aviso cuesta poco y mide si el Ciclo sirve; la agenda es la vista que el comprador pidió. ✅ **Firmada (b)+(c) por el PM, 2026-10-23** |
| D3 | Camino oficial de la OC | (a) Kepler: `markOrdered` con `oc_sucursal`+`oc_folio` · (b) OC interna · (c) interna que **exige** la coordenada de Kepler al cerrarse | **(c)**: conserva el flujo que la gente usa y deja de dejar `oc_folio` en cero por diseño. ✅ **Firmada (c) por el PM, 2026-10-23** |
| D4 | Duplicado entre días y motivo de cancelación | (a) candado del servidor · (b) aviso con confirmación · (c) sólo registrar | **(b)** para el duplicado (hay casos legítimos: el comprador junta pedidos) y **motivo obligatorio** al cancelar/rechazar (ACT-APR ligero de P-COM-00) |
| D5 | Fuente de la agenda | (a) cadencia derivada · (b) capturada por el comprador con la derivada como sugerencia | **(b)**: la columna `cadence_source='manual'` ya existe y nadie la usa; la derivada acierta en 1 de 4. ✅ **Firmada (b) por el PM, 2026-10-23** |
| D6 | Cobertura por proveedor | (a) 30 d fijo · (b) cadencia + lead (base `cadence`) con 30 d de respaldo | **(b)**, pero **cambia el número que se le pide al proveedor**: va con antes/después y **después de M1**, no antes |
| D7 | Quién mide M1 y M2 y con qué árbitro | ver §5 | Otra sesión, sólo lectura, con control placebo; sin código hasta tener el veredicto |

---

## 5. El orden (dinero en juego × esfuerzo)

| Orden | Frente | Por qué va ahí |
|---|---|---|
| 0 | **Lo ya hecho que no está en prod**: deploy de RA-NEG.1–3 (prod corre `bc9031c72`, 22-oct 12:09; el cron de auto-deploy está comentado) e índice `ix_kdm2_compra_sku` (RA-NEG.5, ventana nocturna) | Costo casi cero, ya tiene items |
| 1 | **M2 — ¿lo nuestro es idéntico a Kepler?** | Sin código. Decide si hay dato inventado antes de construir nada encima |
| 2 | **M1 — ¿el comprador mejora o empeora el sugerido?** | Sin código. Decide si D6 y cualquier cambio al motor tienen sentido |
| 3 | **F1 — Lo aprobado llega al ERP** (D1) | $19.05 M parados; esfuerzo bajo (runbook KR.9 + pantalla que lo declara) |
| 4 | **F2 — Agenda de proveedores y el Ciclo como entrada** (D2, D5, D6) | El disparador del flujo no se usa; la agenda tiene el dato a medias |
| 5 | **F3 — Lazo cerrado y sin repetidos** (D3, D4) | $3.30 M repetidos vivos; `oc_folio` en 0 impide lead time y fill rate reales |
| 6 | **F4 — Velocidad y control** (hallazgos 6 y 7) | PQ.10 ejecuta la deuda `[RA-UX.11b]`; esfuerzo alto. PQ.11 es control, no dinero |

---

## 6. Los frentes, con sus entregables

### M2 · La requisición contra el documento de Kepler, campo por campo *(C0, medición)*

**Entregable:** un script de sólo lectura en `database/scripts/` que publique, para cada
requisición con documento en Kepler, el cuadre columna por columna, y una tabla en este doc.

- Universo: **todas** las `ordered`/`received` (compras contra `X-A-30`/`X-A-35`, **traspasos
  contra `U-D-40`**), no 6 pares. Ventana `[f, f+15 d]` y **placebo `[f−30, f−15 d]`**.
- Columnas: proveedor · sucursal (por nombre) · SKU · cantidad **en la misma unidad** (`c58`) ·
  costo **en la misma unidad** · importe del renglón · total · fecha.
- Cada diferencia con causa nombrada: unidad · costo movido desde la captura · el comprador cambió
  la cantidad · **dato nuestro sin origen en Kepler**.
- Lo que la Suite publica y Kepler no tiene (fill rate, colchón, clase ABC, «pendiente», IAD) se
  lista como **derivado nuestro** y se verifica que la pantalla no lo presente como dato del ERP.
- Punto de partida medido el 16-oct (6 pares, 37 renglones): proveedor/fecha/total/SKUs 6 de 6;
  importe 37 de 37 al centavo; cantidad y costo 0 de 37 por unidad, reconciliados con `kdm2.c58`.
- ⛔ Lo que no cruza se declara (`sin documento`, `sin réplica` para el almacén `08`), nunca cuenta
  como «no cuadra».

### M1 · El comprador contra el motor: mejor, normal o peor *(C0, medición)*

**Entregable:** un script de sólo lectura y una tabla por comprador y por proveedor con el
veredicto por renglón.

- Universo: renglones con `final_qty ≠ suggested_qty` de los últimos 90 días (30 d: 2,999 de 7,111).
- Árbitro: lo que pasó con ese SKU × sucursal **después** del pedido, leído del ODS (venta real,
  agotamiento, existencia al final de la ventana). Ventana = cadencia + lead del canal.
- Veredicto: `mejor` (la corrección evitó agotado o sobrestock) · `normal` · `peor` (causó agotado
  o inmovilizó dinero) · `sin medir` (sin venta posterior con qué juzgar).
- ⛔ Trampa: no juzgar con la demanda que usó el motor. Sólo venta **posterior**.
- ⛔ El 38 % que sube el sugerido puede ser motor corto **o** sobrecompra: el veredicto lo dice, la
  cifra sola no.

### F1 · Lo aprobado llega al ERP *(C2 + C3; depende de D1)*

| # | Entregable | Capa |
|---|---|---|
| PQ.1 | La pantalla distingue `aprobada` de `aprobada y escrita en Kepler`; las 680 sin documento se ven como tales, con su edad y su `kepler_error` | C3 |
| PQ.2 | El traspaso aprobado tiene salida aunque KR esté apagado: cierre manual con la coordenada del `U-D-40`/`U-D-41` capturada, o cancelación con motivo | C2+C3 |
| KR.9 | Encendido en prod (runbook `KEPLER_PUSH_DESPLIEGUE.md`): `KEPLER_PUSH_URL` + `GRANT INSERT` + `pg_hba`. Dueño: Edgar. Va **después** de M2 | infra |

### F2 · Agenda de proveedores y el Ciclo como entrada *(C1 → C3; depende de D2, D5, D6)*

| # | Entregable | Capa |
|---|---|---|
| PQ.3 | Captura por el comprador de **día de visita / cadencia** y **lead time** por proveedor (y por sucursal cuando difiera), sobre `replenishment_channel.cadence_source='manual'` y `lead_time_days`; la derivada se muestra como sugerencia con su regularidad (221 de 886) | C2+C3 |
| PQ.4 | **Agenda por proveedor**: una fila por proveedor (no por canal), con cadencia, próxima fecha, sucursales que le tocan, atraso y sugerido total; desde ahí se arma el pedido con proveedor y sucursales puestos | C3 |
| PQ.5 | Aviso en Pedido: «hoy te toca: N proveedores, M vencidos» que lleva a la agenda. Mide si el Ciclo se usa cuando está enfrente | C3 |
| PQ.6 | Cobertura por proveedor = cadencia + lead (base `cadence`), 30 d sólo de respaldo. **Cambia el número**: antes/después con la misma consulta, y sólo tras el veredicto de M1 | C1 |

### F3 · Lazo cerrado y sin repetidos *(C1 → C3; depende de D3, D4)*

| # | Entregable | Capa |
|---|---|---|
| PQ.7 | Un solo camino a `ordered`: la OC interna exige la coordenada de Kepler al cerrarse; `oc_folio` deja de ser 0 por diseño | C1+C2 |
| PQ.8 | Duplicado **entre días** (mismo proveedor, almacén y producto vivo): aviso con confirmación al armar, con los folios que ya lo piden. Hoy: 84 grupos, $3.30 M | C1+C3 |
| PQ.9 | Motivo obligatorio al cancelar o rechazar, visible en la bandeja. Hoy 395 canceladas por $34.72 M sin porqué | C2+C3 |

### F4 · Velocidad y control *(hallazgos 6 y 7)*

| # | Entregable | Capa |
|---|---|---|
| PQ.10 | `workbook`, `transfer-suggestion` y el XLSX bajo 500 ms o con su hueco declarado. Ejecuta la deuda `[RA-UX.11b]` / `[RA-PERF.9]` (resumen por producto precalculado desde la primaria, §19): antes/después con la misma consulta, commit aparte de cualquier cambio de negocio | C0+C2 |
| PQ.11 | La autorización deja de ser un segundo clic: quien creó la requisición no la aprueba (salvo god-mode, que se ve), y la aprobación guarda lo que la persona vio (sugerido, final, vigencia del costo). Es el ACT-APR ligero de P-COM-00; si nace el primitivo de actas, vive en `libs/` o queda como deuda con nombre | C1+C2+C3 |

---

## 7. Qué NO incluye

- **Cambiar la fórmula del motor** (cobertura, colchón, redondeo, tope de 45 d) antes del veredicto
  de M1. PQ.6 es el único que toca un número, y va condicionado.
- **Las actas completas** de P-COM-00 (ACT-KEP, ACT-CIE): acá sólo el motivo de cancelación (PQ.9) y
  la constancia de aprobación (PQ.11). El primitivo compartido de actas va aparte (ADR-056).
- **Autoabasto** (`/almacen/autoabasto`, Fase AB): mismo motor, otra decisión, otra audiencia.
- **Auditoría visual** de la pantalla: nivel A pendiente; RA-UX.10 la hizo el 21-oct y está en prod.
- Por regla del repo: sin importers, sin copias de tabla, sin levantar backend local, sin push ni PR
  sin pedir, CORS y credenciales fuera.

---

## 8. Riesgos y bloqueos

| Bloqueo | Dueño | Causa | Qué lo destraba |
|---|---|---|---|
| KR.9 apagado | Edgar | `KEPLER_PUSH_URL`, `GRANT INSERT`, `pg_hba` sin poner | D1 firmada + runbook, fuera de horario hábil |
| **El CEDIS no tiene existencia medida** (127 SKUs contados el 30-sep; 1,264 embarcados en 30 d) | Operación / Almacén CEDIS (a nombrar por el PM) | corte a Kepler sin saldos iniciales (§12) | inventario físico completo capturado como `N-A-30`, o carga de saldos iniciales. Sin eso PQ.12 no puede calcular la compra del CEDIS |
| Cupo 4/4 🔨 y Fase 0 en curso | PM | Método §3 y §7 | M1 y M2 **no ocupan cupo** (medición, sin código); F1–F3 esperan cupo o una fase que cierre |
| Traspasos sin réplica para medir (`08`) | — | no hay `kepler_md_08` | Se declara, no se cuenta |
| Auto-deploy comentado | Edgar | decisión 2026-10 | Deploy manual de lo ya empujado |
| Una sola persona autoriza (849 de 863) | Compras | permiso por persona | No lo resuelve PQ; se declara |

---

## 9. Definición de Terminado

- [ ] 1. Métrica de la cabecera **remedida**, antes/después publicado
- [ ] 2. Cada capa verificada **o declarada NO MEDIDA** (ADR-056)
- [ ] 3. Todo endpoint que escribe **ejercido contra base real** con el payload de la pantalla
- [ ] 4. Toda compuerta nueva **rota a propósito una vez**, rojo verificado
- [ ] 5. Todo primitivo genérico en `libs/` compartido **o** deuda con nombre en el tracker
- [ ] 6. Tracker + `03_LOG_REVISIONES.md` + roadmap de `CLAUDE.md` al día
- [ ] 7. **En prod**, o escrito por qué no y qué falta

---

## 11. Resultados de M2 y M1 — medidos el 2026-10-23

> `pg-prod`, `system_identifier 7688376744939610156`, sólo lectura. Scripts:
> [`pq-m2-cuadre-requisicion-kepler.js`](../../../database/scripts/pq-m2-cuadre-requisicion-kepler.js) ·
> [`pq-m1-comprador-vs-sugerido.js`](../../../database/scripts/pq-m1-comprador-vs-sugerido.js).
> Los dos arrancan con un control cuya respuesta se conocía: M2 reencuentra los pares del 16-oct
> (`RQ-2026-00760/00774 → 00/XA3501/0007134`, `00792/00802 → 0007137`); M1 da «llegó» en el
> **85.1 %** de los renglones de requisiciones `received` (la primera versión daba 9 % y se tiró).

### 11.1 M2 — ¿nuestra requisición es idéntica a la de Kepler?

Universo: 863 requisiciones `approved/ordered/received` de 120 días (202 compras · 661 traspasos).
Ventana real `[f, f+15]`, placebo `[f−30, f−15]`.

| prueba | compra real | compra placebo | traspaso real | traspaso placebo |
|---|---:|---:|---:|---:|
| hay documento del mismo proveedor/destino y sucursal | 125 (61.9 %) | 79 (39.1 %) | 658 (99.5 %) | 609 (92.1 %) |
| …con al menos un SKU de la requisición | 124 (61.4 %) | 77 (38.1 %) | 296 (44.8 %) | 242 (36.6 %) |
| …y el **total cuadra** (±0.5 %) | **16 (7.9 %)** | **0** | 3 (0.5 %) | 0 |

**Columna por columna** (compra: 124 pares, 1,191 renglones comunes por $12.44 M · traspaso: 296
pares, 1,020 renglones por $4.65 M):

| columna | compra | traspaso |
|---|---:|---:|
| proveedor / destino · sucursal | 100 % (por construcción) | 100 % |
| fecha = mismo día (≤3 d) | 103/124 (118) | 25/296 (107) |
| total del documento | 16/124 | 3/296 |
| mismo conjunto de SKUs | 84/124 | 17/296 |
| importe del renglón | 631/1,191 (53.0 %) | 628/1,020 (61.6 %) |
| cantidad cruda (cajas = unidad Kepler) | 20 (1.7 %) | 11 (1.1 %) |
| **cantidad vía `c58`** (cajas × unidades por caja) | 655 (55.0 %) | 672 (65.9 %) |
| costo crudo | 29 (2.4 %) | 10 (1.0 %) |
| **costo vía `c58`** (costo caja ÷ unidades por caja) | **1,062 (89.2 %)** | **939 (92.1 %)** |

| causa por renglón común | compra | traspaso |
|---|---:|---:|
| cuadra vía `c58` (cantidad, costo e importe) | 49.2 % | 61.4 % |
| **cantidad cambiada** (costo cuadra, cantidad no) | **38.3 %** | **30.5 %** |
| costo movido (cantidad cuadra, costo no) | 4.1 % | 4.3 % |
| ambos difieren | 4.9 % | 3.6 % |
| sin factor `c58` | 1.9 % | 0 % |

**Lo que contesta, en una línea:** *no hay dato inventado en el costo.* El costo que la Suite
escribe en el renglón es el de Kepler en el **89–92 %** de los renglones comunes, reconciliado por
la escalera de unidades (`c58`), y el importe cuadra al centavo cuando cuadra la cantidad. **Lo que
cambia es la cantidad** (38 % en compra, 31 % en traspaso): el comprador escribe otra en Kepler.
Y lo que la Suite pidió y Kepler **no trae**: 137 renglones de compra ($1.11 M) y 830 de traspaso
($5.78 M). Eso no es «inventado»: es **no ejecutado**, y coincide con las 680 aprobadas sin salida.

⚠️ **Traspasos: el 54.8 % (362) no tiene ningún `U-D-40` con sus SKUs en 15 días.** Es la misma
cifra vista desde el ERP: lo aprobado en la Suite no se vuelve documento. Un `U-D-41` directo sin
`U-D-40` no se buscó (medido el 16-oct: 92.8 % de los embarques sí nacen de un `U-D-40`).

### 11.2 M1 — ¿el comprador mejora, repite o empeora el sugerido?

Instrumento: ventana = cadencia del canal (7–30 d; 14 d sin canal); «llegó» por documento del ERP
(`X-A-40` compra, `U-A-50` traspaso) en `analytics.stock_movements`; desenlace por la foto de
existencia al cierre de la ventana (`stock_snapshots`); sobrestock = más de 45 días de cobertura.

| motivo por el que un renglón queda **sin medir** | renglones |
|---|---:|
| ventana todavía incompleta (fotos desde el 24-sep, 28 días) | 3,855 (76.6 %) |
| almacén sin foto de existencia: **el CEDIS tiene 196 SKUs fotografiados** | 1,132 (22.5 %) |
| no llegó mercancía en la ventana | 43 |

| grupo | renglones | agotado al pedir (con foto) | **llegó** (documento ERP) |
|---|---:|---:|---:|
| igual (control: el comprador no tocó el sugerido) | 1,679 | 37.7 % | **25.8 %** |
| subió | 981 | 25.8 % | 46.0 % |
| bajó | 38 | 20.0 % | 52.6 % |

Desenlace sobre 1,566 renglones medidos: en el control, **75.3 % no llegó**; de lo que llegó,
sobrestock 9.5 % · sano 11.5 % · agotado al cierre 0.5 %. En «subió» (66): no llegó 63.6 %,
agotado al cierre 7.6 %, sobrestock 4.5 %, sano 24.2 %.

**Veredicto de la corrección: 28 renglones juzgables** (24 subieron: mejor 45.8 % · normal 41.7 %
· peor 12.5 %, Δ $54,976; 4 bajaron: normal 100 %). ⛔ **Es muestra chica y se declara: NO MEDIDO
a escala.** El instrumento funciona (control 85 %); el universo no alcanza porque las fotos tienen
28 días, el CEDIS no está fotografiado y 3 de 4 pedidos del control nunca llegaron.

**Lo que sí quedó medido y pesa más que el veredicto:** el hallazgo 1 visto desde el inventario.
**Tres de cada cuatro renglones aprobados sin corrección no tuvieron entrada en el ERP dentro de su
ventana**, y los corregidos hacia arriba llegaron el doble (46 % contra 26 %): el comprador sube la
cantidad en lo que después sí ejecuta. Mientras lo aprobado no salga (F1), M1 no puede separar
«decidió mal» de «nunca se pidió».

**Qué falta para cerrar M1:** (a) fotos de existencia del CEDIS (hoy 196 SKUs: hueco de `[IC]`,
no de esta fase); (b) 60–90 días más de fotos; (c) re-correr con `--detalle` por comprador y
proveedor cuando haya ≥20 renglones juzgados por fila.

---

## 12. El CEDIS no recomienda comprar nada — y por qué no puede todavía (2026-10-24)

> Disparador: el PM abrió `/compras/pedido` filtrado al CEDIS y vio «A comprar $0 · SKUs 0 · Sin
> datos en los puntos de compra», con «A traspasar $2.89 M desde CEDIS» al lado. Y trajo el
> **reporte de existencia por productos de Kepler** para el CEDIS (`KRep_md_invrepexsrep.kpl.pdf`,
> 2026-10-24 11:55, 123 páginas, 8,992 productos). Todo lo de abajo es sólo lectura contra prod.

| hecho | medido |
|---|---:|
| Pares del CEDIS en el plan | 1,755 · **0 con venta propia** (el CEDIS no vende, sólo traspasa) · 1,636 con demanda de red (`eff_daily`, **33,855 pz/día**) |
| Sugerido de compra del motor | `venta propia × cobertura − existencia` → **0 en todos** → con «Solo con pedido» la lista queda vacía |
| Existencia del CEDIS en el ODS | **296 SKUs, 372,335 pz** |
| Existencia del CEDIS según **Kepler** (el PDF) | **352 SKUs, 370,338 pz** · 199 de 228 comunes iguales (el resto, desfase del parser sobre renglones sin descripción) |
| SKUs que el CEDIS **embarcó** en 30 d (`U-D-41`) | **1,264** (1.18 M pz) · con existencia en Kepler: **207** · en el ODS: 236 |
| Saldo inicial del kardex `00` (`kdil.c4`) | **0 en el 100 %** |
| Único inventario físico del CEDIS (`N-A-30`) | **2026-09-30, folio 0000001: 127 SKUs, 340,077 pz** |
| Flujo del `00` en 30 d | entradas `X-A-40` 1.06 M pz · embarques `U-D-41` 1.18 M pz |

**Lo que contesta:** nuestra existencia del CEDIS **es la de Kepler**, no un defecto del feed. Y
la de Kepler es un artefacto del corte del 30-sep: se contaron **127 SKUs** y el resto arrancó en
cero sin saldo inicial; desde entonces entra casi lo mismo que sale, así que ~900 de los 1,264
SKUs que el CEDIS embarca viven en **cero o negativo** en su kardex. El CEDIS opera con mercancía
que su propio sistema dice que no tiene.

**Por eso el motor no puede darle número al CEDIS, ni con la demanda de red:** con `eff_daily` y
30 d saldría **$20.22 M a comprar**, pero el 84 % es de SKUs cuya existencia está en cero por falta
de conteo, no por falta de mercancía. Sería una cifra dibujada (ADR-056). Lo honesto hoy en
pantalla es **«existencia no medida para N SKUs»**, no «A comprar $0 · sin demanda».

**Lo que destraba, y no es código:** un **inventario físico completo del CEDIS capturado en Kepler**
(`N-A-30`) o la carga de saldos iniciales. Con eso, la vía para el CEDIS es sencilla porque no vende:
su demanda es `eff_daily` (ya calculada) y su compra es `eff_daily × cobertura − existencia`.
Registrado como **PQ.12** (dependiente de ese conteo) y como bloqueo con dueño en §8.

### 12.1 Paridad con el reporte de Kepler, SKU por SKU (misma tarde)

Regla del PM: *«nada inventado ni importado; la misma fórmula de Kepler y los mismos resultados»*.
Medido con [`pq-paridad-existencia-reporte-kepler.js`](../../../database/scripts/pq-paridad-existencia-reporte-kepler.js)
(control a ojo 11/11; `pdftotext -layout` corría los renglones un SKU y se tiró): **289 de 303
positivos idénticos**; 2 distintos y 11 «sólo nuestros» son movimientos de hoy después de las 11:55;
**45 negativos** que Kepler publica y nuestra vista recorta a 0 (`kdil c4+c8−c9` crudo los
reproduce 45/45); **11 «sólo Kepler»** con último movimiento antes del corte que nuestro filtro de
actividad excluye; 1 SKU fuera del catálogo. Detalle en `VERDAD_ABSOLUTA` §17.4b.

**Decisiones nuevas, a firmar:**

| # | Decisión | Recomendación |
|---|---|---|
| D8 | ¿Publicamos los negativos como Kepler? | **Sí**, con rótulo «negativo en Kepler»: hoy 45 SKUs se ven como 0 y un cero y un faltante no son lo mismo (ADR-056). Quita el `GREATEST(…,0)` de la vista; cambia número → antes/después |
| D9 | ¿Qué hacemos con los 11 SKUs sin actividad desde el corte que Kepler sí lista? | Investigar la regla exacta del ERP antes de tocar el filtro: ese filtro es lo que hoy nos deja a 296 contra 303 y no a 3,836. **NO MEDIDO** por qué Kepler incluye esos 11 |

⚠️ Sigue sin resolverse por qué `kdil` crudo trae 3,836 SKUs positivos (8.36 M pz) que ni Kepler ni
nosotros publicamos: el filtro de actividad **replica** el resultado de Kepler sin que sepamos su regla.
El join a `kdil` por SKU es por `c3` (no `c2`), ya corregido en el instrumento.

### 12.2 El factor de caja del catálogo venía de un importer y se corrigió a mano (2026-10-26)

El PM avisó que la base que medíamos **fue editada**: la unidad de los productos venía de un importer y
eso producía **desfases al insertar en Kepler**. Medido en prod (sólo lectura, `system_identifier`
verificado):

| Hecho | Cifra |
|---|---|
| `catalog.products` editados el 2026-10-26 09:00 UTC, `updated_by` NULL (lote, no pantalla) | **9,241** |
| de esos, `factor_sale` = `c84` de la escalera de Kepler (`kdii`, sucursal 00) | **8,519 / 9,149** (93 %) |
| sin escalera en Kepler (no comparables) | 434 |
| los 2,179 que NO tocó el lote: `factor_sale` = Kepler | 63 (2,086 sin escalera) |
| `source` del catálogo: `kepler` 9,038 · `manual` 1,144 · `wincaja` 1,141 | el importer que se retira |
| requisiciones aprobadas en 14 d / con folio de Kepler / con error de Kepler | 386 / **1** / 162 |

**Qué toca y qué no, de lo ya medido en esta fase:**

- **M2 (§11.1) hay que releerla.** El adaptador manda la línea a Kepler como `CJA`, `por_caja: 1`,
  `cantidad: cajas` (`kepler-requisition-sink.adapter.ts`); nuestra `final_qty` sale de cajas × **nuestro**
  factor. Si el factor difería del de Kepler, «cantidad cambiada» (38.3 % / 30.5 %) mezcla dos cosas:
  corrección del comprador **y** desfase de unidad. Las requisiciones medidas son anteriores al lote de hoy
  → **M2 se vuelve a correr sólo sobre requisiciones creadas después del 2026-10-26 09:00 UTC**, y la
  cifra de §11.1 queda rotulada «pre-corrección de unidades».
- **M1 (§11.2)** convierte cajas→piezas con `v_warehouse_box_factor`; en el 00, 977 SKUs resuelven por
  `factor_sale` (fuente que cambió hoy). Ya estaba NO MEDIDO a escala: se repite con la fuente corregida.
- **Agenda (PQ.4), aviso (PQ.5), bandeja (PQ.1):** cuentan canales, proveedores y documentos, no unidades
  → no cambian.
- **Paridad de existencia (§12.1):** `kdil` está en piezas de Kepler, sin factor nuestro → no cambia.

⛔ **Lo que sigue sin cumplir la regla «misma fórmula de Kepler»:** el resolvedor canónico
`v_product_box_factor` prefiere la **etiquetera** (5,244 SKUs en el 00) sobre el `c84` de Kepler
(2,544), y `factor_sale` del catálogo es apenas su cuarta entrada. La corrección de hoy alinea el
catálogo con Kepler, pero el número que usa el pedido sigue saliendo de otra fuente en 2 de cada 3 SKUs.

| # | Decisión | Recomendación |
|---|---|---|
| D20 | ¿Para almacenes de Kepler, el factor de caja del pedido es el `c84` de Kepler y nada más? | **Sí**: la etiquetera y el catálogo quedan como rótulo «difiere de Kepler», no como fuente. Cambia número → antes/después, y se mide contra OCs reales de Kepler (`c58`) antes de publicar. ⚠️ No en esta fase sin cupo: va a `libs/` (ADR-056) y lo comparte con AB |

**NO MEDIDO:** el valor de `factor_sale` *antes* del lote (no hay historial de la columna), así que no
se puede cuantificar cuántas requisiciones ya enviadas llevaron el desfase; sólo se sabe que 162 de 386
aprobadas en 14 d tienen error de Kepler y 1 tiene folio.

### 12.3 D20 medida contra las OCs reales de Kepler: el resolvedor YA da el número de Kepler (2026-10-26)

«Resolvámoslo» → antes de tocar la vista se midió el árbitro: el `c58` (unidades por caja) de las
**órdenes de compra reales** de Kepler (`XA3501`, 90 días, 19,367 líneas, 7,198 pares sucursal×SKU),
contra el resolvedor que lee el pedido (`mv_warehouse_box_factor`) y contra la escalera de Kepler
(`v_kepler_unit_ladder`). Instrumento: `d20-medir3.js` (scratchpad; los joins en Node porque el plan
SQL con las tres vistas no termina en 10 min).

| Líneas de OC | n | resolvedor actual = `c58` | escalera Kepler (`c84`) = `c58` |
|---|---:|---:|---:|
| todas con `c58` | 7,119 | 6,226 (87.5 %) | 5,965 (83.8 %) |
| **capturadas en caja (`c58` > 1)** | **5,635** | **5,594 (99.3 %)** | 5,561 (98.7 %) |
| por fuente, en caja: etiquetera / `kepler_c84` / override / `factor_sale` | 2,615 / 2,635 / 327 / 30 | 2,610 / 2,609 / 321 / 30 | — |
| `c58` que no está en ningún peldaño de la ficha de Kepler (`kdii`) | 78 (1.4 %) | | |

**Lo que el número dice:**

- **D20 tal como se propuso queda refutada.** Reemplazar el resolvedor por el `c84` de Kepler
  daría 33 aciertos **menos**, no más: el resolvedor ya es «la fórmula de Kepler» en 99.3 % de las
  líneas en caja, y la etiquetera coincide con el `c84` en 2,609 de 2,615. No hay vista que cambiar
  → no hay commit que mueva un número.
- **`c58` no es el factor del producto: es el factor del peldaño en que se capturó esa línea
  (`c55`).** 770 líneas se capturaron en unidad base (`c58` = 1 con producto que sí tiene caja): ahí
  ningún factor «acierta» porque no se usó. Los 856 «ninguno» de la primera pasada son eso, no un
  error de unidad.
- **Dónde sí estaba el desfase al insertar en Kepler:** el adaptador escribe `c11 = c55 = 'CJA'`,
  `c58 = '1'` desde el 2026-10-14 (`kepler-requisition-sink.adapter.ts`), mientras Kepler expresa
  la línea en la unidad del producto (PAQ 64 %, PZA 28 %) y declara la caja aparte en `c55`/`c58`.
  La corrección de hoy al catálogo (`factor_sale` = `c84`) alinea el testigo de la Suite con la
  ficha del ERP; el renglón que se escribe sigue siendo otra decisión, y es de **KR** (escritura
  apagada).
- **Lo que se declara, no se arregla:** 41 líneas en caja (0.7 %) donde el resolvedor ≠ `c58`
  (muestra: 14004 etiqueta 32 vs OC 35; 38033 `c84` 108 vs OC 12 — compras en empaque distinto al
  de la ficha) y 78 líneas cuyo `c58` no existe en la ficha de Kepler. Van como rótulo «empaque de
  la OC ≠ ficha», no como cambio de fórmula.

| # | Decisión | Resultado |
|---|---|---|
| D20 | ¿Factor de caja del pedido = `c84` de Kepler y nada más? | **No procede: medido, el resolvedor ya entrega el `c58` de Kepler (99.3 % en caja) y el `c84` solo daría 98.7 %.** Queda: (a) rótulo «empaque de la OC ≠ ficha» para los 41 + 78; (b) la unidad del renglón que se ESCRIBE en Kepler (`c11`/`c55`/`c58`) se decide en KR con esta misma medición como testigo |

### 12.4 «Necesito un 100 %»: contra qué, y cómo se alcanza (misma tarde)

Se bajó a las **268 líneas** (1.39 %) que no cuadraban con la ficha de Kepler por etiqueta + factor:

| Qué son | Líneas | Veredicto |
|---|---:|---|
| factor de la ficha, otra etiqueta (la ficha renombró la unidad base `PAQ`→`PZA` después de la OC; `c58` = 1 en los dos lados) | 162 | cuadran **por factor** |
| unidad que la ficha NO tiene: el comprador capturó `PZA` a 96/caja donde la ficha dice `PAQ` 12/caja (SKUs 480xx, 30540, 89137…); el costo de la línea cuadra con su propio `c58` en las 106 | 106 | elección humana en Kepler; **ninguna ficha las reproduce** |

Por eso el 100 % tiene dos árbitros distintos y hay que nombrar cuál:

1. **Contra la ficha de Kepler (lo que Kepler usaría para una línea nueva): 100 % por construcción**,
   leyendo la ficha de esa sucursal y nada más. Es **PQ.13** (migración
   `20261026125709_pq_factor_caja_ficha_kepler.js`): 867 celdas cambian (0.51 %), 568 de ellas a 1
   porque la ficha dice `unidad_unica`. Cuerpo ejercido en prod sólo lectura; migración sin aplicar.
2. **Contra las líneas históricas de OC: 99.45 % es el techo de cualquier catálogo**, también del de
   Kepler. El 0.55 % restante se lee de la línea misma (`c57 ÷ c12`), que es lo que M2 ya hace.

| # | Decisión | Resultado |
|---|---|---|
| D20 (final) | ¿Factor de caja en almacenes Kepler = ficha de Kepler? | **Sí (PQ.13)**: manda la ficha de esa sucursal cuando trae factor; donde calla, la fuente previa con su nombre. El PM firma al aplicar la migración, que es el antes/después |

## 13. Auditoría del flujo generar → aprobar (2026-10-26) — nivel C + B; nivel A bloqueado

Pedido del PM: recorrer con Playwright desde que se genera el pedido hasta la bandeja, contar la
interacción humana y juzgar el diseño. **Nivel A no se pudo**: los dos navegadores MCP (Playwright y
Chrome DevTools) estaban tomados por otra sesión y no hay login de prueba. Lo que sigue es código
(C) y prod (B); nada visual está medido (ADR-056).

**Interacción humana mínima para un pedido de un proveedor (nivel C):** ~7 clics + 1 texto para
generar (proveedor, cantidades o «agregar todos», «Generar», diálogo, «Generar los N»), 2 clics por
menú para llegar a la bandeja, 3–4 para aprobar, y la recaptura completa en Kepler fuera de la Suite
(no medida). «Marcar como ordenada»: 1 clic + 2 campos + 1 clic.

| # | Hallazgo | Medido | Costo | Regla | Estado |
|---|---|---|---|---|---|
| 1 | Un apagado sistémico (KR) se pintaba en rojo fila por fila como falla del documento | B: 172/173 `kepler_error` en 30 d = «escritura apagada» | 784 aprobadas leídas como error | §10.10 fallos parciales | ✅ **PQ.14** (`ffe073b74`) |
| 2 | `ordered` sin folio de OC: no se puede seguir a la entrada | B: 203 en 30 d, 0 con folio legible | $24.6 M sin hilo | Cruce 2 | ⬜ previos a RQ.15; el camino nuevo ya exige folio |
| 3 | Traspasos aprobados sin camino de cierre | B: 703 aprobados, 0 recibidos | $13.7 M | Tesler | ⬜ PQ.3 |
| 4 | El lazo se corta al generar: toast sin folio ni enlace | C | la persona navega por menú y busca | Doherty/Jakob | ✅ **PQ.14**: aviso persistente con lote y «Ver en Requisiciones» (`?q=<lote>`) |
| 5 | 9 acciones planas en el detalle | C | sin curaduría | Hick | ⬜ necesita nivel A |
| 6 | Pedido: 4 modos + lentes + ~20 columnas, botón «Generar» duplicado | C | carga cognitiva | Cruce 4 | ⬜ NO MEDIDO qué se ve al abrir |
| 7 | `check:pantalla`: sin `LoadState` (§2) en las dos; requisiciones sin frescura (§9) ni `@container` (#9) | estático | deuda declarada previa; **0 fallas nuevas** por PQ.1/PQ.4/PQ.14 | contrato de producto | ⬜ deuda con nombre |

**Para cerrar el nivel A:** que la otra sesión suelte el navegador de Playwright, o un usuario de
prueba con acceso a Compras. Con eso se recorre el flujo completo (una requisición de prueba que se
cancela con motivo al terminar) y se miden pliegue, jerarquía, contraste y foco.

### 13.1 Nivel A — pantalla viva, medida (2026-10-26, tarde)

Chromium propio (Playwright, perfil limpio) contra `https://megadulcessuite.com` con el usuario de
prueba que dio el PM; 1366×768 y 1920×1080. Instrumento `scratchpad/pw/driver.js` (comandos por
archivo); **control**: el `h1` existe y está arriba del pliegue (Pedido: «Pedido», y=121, 30 px ✓;
Bandeja: «Requisiciones y Traspasos», y=105, 30 px ✓). ⛔ **La requisición de prueba NO se creó**:
el clasificador de auto mode bloqueó la escritura en prod («Modify Shared Resources»); el flujo se
recorrió hasta el diálogo de confirmación y se canceló.

**Pedido (`/compras/pedido`), 1366×768:**

| Medida | Valor |
|---|---:|
| carga hasta red quieta · llamadas API | 3.0 s · 12 (la más lenta `purchase-suggestion` 1,884 ms; el workbook de un proveedor 1,612 ms) |
| dónde empieza la tabla · filas en el pliegue | y=594 · **2 de 20** (1920×1080: 7) |
| con el aviso de «Instalar Mega Dulces» abierto | **0 filas** y la barra de «Generar» tapada |
| interactivos arriba del pliegue | 52 (de 118) |
| encabezados de columna · celdas · `body` | **16 px semibold** · 14 px · 16 px |
| textos en color de acción arriba del pliegue | 7, uno de ellos la cifra **«A comprar $23,722,982»** |
| casillas por sucursal al abrir una fila | 8 inputs de 64×26 px (por debajo de 44 px en `coarse`) |

**Bandeja (`/compras/requisiciones`), 1366×768:** carga 1.2 s; `requisitions` y `batches` se piden
**dos veces** cada una al abrir (Cruce 6). Vista «por documento» con el drill de Kepler: la tabla
empieza en **y=545** (cinta de KPI + cinta del filtro + Por lote/documento + pestañas + filtros = 5
capas) y entran **3 de 50 filas**; el folio se parte en **3 renglones**; cada fila mide ~85 px por las
dos etiquetas apiladas (PQ.1). Etiquetas en pantalla: 47 «sin empujar» (ámbar) · 3 «no salió» (rojo).

| # | Hallazgo nuevo (nivel A) | Costo | Regla |
|---|---|---|---|
| A1 | **Las dos vistas del mismo dato no traen el mismo universo**: la agenda del Ciclo dice SABOR Y ALEGRIA «1 de 1 bajo reorden · $263»; «Armar» abre el workbook **vacío** («Sin datos en los puntos de compra»), con o sin filtro de sucursal y de alcance. TOSTADAS GUADALUPE: agenda $12,825, workbook 4 productos $4,175 | el botón «Armar» (PQ.4, mío) promete algo que la pantalla destino no tiene | Cruce 5 |
| A2 | **La cinta de KPI no sigue al filtro cuando el resultado es vacío**: con SABOR Y ALEGRIA elegido muestra «A comprar $23,399,972» (la red entera) | una cifra de red leída como del proveedor | Cruce 2 / veracidad |
| A3 | Bandeja: «Esperando aprobación **1** · $39,459» mientras la lista «por lote» muestra **4 lotes pendientes, 27 documentos, $876,066** (la casilla cuenta sólo la pestaña Compra) | el encabezado no se puede recorrer en su lista | Cruce 1 |
| A4 | Sucursales **por código** en la lista de lotes («6 sucursales: 01, 02, 03, 04, 06, 07») y en el detalle («entrega en 04 (Yurécuaro)») | regla dura: sucursal por nombre | GOTCHAS / memoria |
| A5 | «FERNANDO ZERME?O MU?OZ»: la Ñ llega como «?» desde el ODS a la pantalla | nombre de proveedor mal escrito en el documento | veracidad |
| A6 | Requisición aprobada con **1 línea · 0 unidades · $38** (RQ-2026-01390) a la vista en la bandeja | un documento vacío aprobado | poka-yoke |
| A7 | «Limpiar» en los filtros no toca la requisición en armado: cancelé un plan de 14 documentos, limpié, y los 11 productos siguieron marcados (el siguiente plan salió de **16 documentos**) | duplicado a un clic | §10.8 estado sucio |
| A8 | «Ver» ambiguo: «Ver el ciclo» y «Ver» (carrito) a la vez; en la barra el «Ver» no es botón | la automatización y el teclado lo confunden | Jakob |
| A9 | Detalle: 3 cintas apiladas antes de las cifras; «Sugerido 1 · Pedir 176» en 4 renglones sin señal del cambio ×176 (M1) | la corrección más grande de la requisición no se ve | Von Restorff |
| A10 | Pedido: 2 filas visibles en el pliegue y el aviso PWA tapa «Generar» | el trabajo empieza en el 77 % de la altura | §5 estructura |
| A11 | Carrito: «0 de 71 cajas de su pedido típico» para 0.2 cj; «Generar los 1» | redondeo que dice cero y plural forzado | veracidad / texto |

Lo que **sí** se confirmó en vivo: PQ.5 (aviso «Hoy te toca pedirle a 196 proveedores…»), PQ.4
(agenda con «Armar») y PQ.1 (dos etiquetas por fila) ya están en prod y se ven como se diseñaron.
PQ.14 todavía no está en prod (el toast sigue sin enlace).

### 13.2 Después de aprobar: `/compras/ordenes` (2026-10-26, nivel A en `localhost:4200` + B en prod)

El PM aprobó una requisición en su entorno local y pidió revisar cómo debe interactuar esa pantalla.
Recorrido con el mismo Chromium (login con el usuario de prueba; ⚠️ en ese entorno
`/api/users/me/context` responde **500** y un `F5` tira la sesión — se navegó dentro de la app).

**Lo que hay hoy (medido):** la requisición aprobada (RQ-2026-01465, FERNANDO ZERMEÑO, $39,459)
aparece como **OC-2026-00231 «Abierta»** porque alguien pulsó «Generar orden de compra» en su
detalle (`POST purchase-orders/from-requisition/:id`). Es una OC **propia de la Suite**
(`commercial.purchase_orders`), con folio propio, sin folio de Kepler. En su detalle, «Registrar
recepción» abre un diálogo con cantidad y costo real por línea, default = pendiente, y al confirmar
crea una **orden de entrada propia** (`commercial.goods_receipts`, folio OE) y **mueve
`commercial.stock`**. La pestaña «Abiertas en Kepler» es otro universo: 305 OC del ERP (266
«Pendiente», «Falta orden de entrada»).

| Prod, sólo lectura | |
|---|---:|
| OC propias desde el 28-sep (todas nacidas de una requisición) | 235 · $26.6 M (160 abiertas, 49 parciales, 26 recibidas) |
| recepciones propias (OE) | 136 · 13,179 u · $163,522 · **con stock aplicado: 2** |
| requisiciones con folio de OC **de Kepler** (RQ.15) | **0** |
| quién lee `commercial.stock` | alertas, Thot, catálogo, caducidades, ubicaciones — **no el Pedido** (lee `v_erp_stock_on_hand`, Kepler) |

**El veredicto, bajo la regla «nada inventado; la fórmula de Kepler»:**

1. 🔴 **La recepción propia inventa existencia.** «Al confirmar suma a existencia del almacén
   destino» — pero esa existencia vive en `commercial.stock`, el Pedido no la ve y Kepler no la
   tiene. La entrada real es la **orden de entrada `X-A-40` de Kepler** (RE: Recepción 360 ya la lee).
   Dos verdades de existencia es exactamente lo que la regla prohíbe.
2. 🔴 **Dos OC por el mismo pedido.** La Suite emite OC-2026-NNNNN y Kepler emite su X-A-35 cuando
   el comprador la recaptura; nada las junta (0 requisiciones con `oc_folio`). El seguimiento de
   «Falta / Avance» se hace sobre la copia, no sobre el documento que el proveedor y Contabilidad ven.
3. 🟠 «Abiertas en Kepler» —el universo real— es la tercera pestaña; la copia propia es la segunda y
   abre por default.

**Cómo debe interactuar (propuesta, a firmar):**

- Al aprobar, la requisición **no genera una OC propia**: sale a Kepler como X-A-30 (KR) y la
  pantalla de órdenes muestra **la X-A-35 de Kepler** que nace de ella, enlazada por `oc_folio`
  (RQ.15 ya exige sucursal + folio). Mientras KR esté apagada: «Marcar como ordenada» con el folio
  de Kepler, y la fila dice «sin OC en Kepler» hasta entonces.
- **«Registrar recepción» desaparece** de la Suite: la recepción es la `X-A-40` de Kepler y la
  pantalla la **lee** (fill rate = recibido/pedido en Kepler, que `mv_supplier_fill_rate` ya calcula).
  Lo que la Suite agrega es lo que Kepler no tiene: la foto/firma/incidencia (RE), nunca la cantidad.
- `/compras/ordenes` queda con **una sola lista**, la de Kepler, con tres estados que ya existen:
  pedida (X-A-35 sin X-A-40) · parcial · recibida; y la columna «de qué requisición» por `oc_folio`.
- Las 235 OC propias y 136 OE se **congelan** (solo lectura, rotuladas «documento interno, no está
  en Kepler») y se declaran en VERDAD_ABSOLUTA como universo paralelo hasta migrar.

| # | Decisión | Recomendación |
|---|---|---|
| D21 | ¿La Suite deja de emitir OC y OE propias y sigue sólo las de Kepler? | **Sí.** Apagar «Generar orden de compra» y «Registrar recepción» (quedan como lectura), y leer X-A-35/X-A-40. Es ADR-040 aplicado a Compras |

**NO MEDIDO:** cuántas de las 136 OE propias tienen su X-A-40 gemela en Kepler (cruce por
proveedor + fecha + SKU, instrumento pendiente); y por qué sólo 2 de 136 aplicaron stock.

---

## 10. Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
| 2026-10-26 | `/compras/ordenes` tras aprobar (§13.2): la Suite emite OC y OE **propias** (235 OC $26.6 M, 136 OE) y la recepción mueve `commercial.stock`, que el Pedido no lee y Kepler no tiene; 0 requisiciones con `oc_folio` de Kepler. Nace **D21**: la Suite deja de emitir OC/OE y sigue sólo las de Kepler (X-A-35/X-A-40) | PM + sesión PQ |
| 2026-10-26 | «Que se pueda aceptar todo un lote de golpe» → **PQ.15 🧪** (`bbd691066`): en «Por lote», «Aprobar lote (N)» con confirmación en dos clics; manda al bulk ya probado sólo los pendientes del lote (tope 200) y declara que el lote no empuja a Kepler. 34/34 vitest, sin endpoint nuevo. Sin validación visual del botón | PM + sesión PQ |
| 2026-10-26 | **Nivel A hecho** (§13.1) con Chromium propio y el usuario de prueba del PM: 11 hallazgos nuevos medidos en pantalla (A1 «Armar» abre vacío · A2 KPI de red con filtro · A3 casilla 1 vs lista 27 · sucursal por código · Ñ como «?» · aprobada con 0 unidades · «Limpiar» no vacía el carrito…). La requisición de prueba no se creó: el clasificador bloqueó la escritura en prod | PM + sesión PQ |
| 2026-10-26 | Auditoría del flujo generar → aprobar (§13): nivel A bloqueado (navegadores tomados, sin login); nivel C+B con 7 hallazgos. **PQ.14 🧪** (`ffe073b74`): apagado de Kepler como estado de la bandeja, no falla por fila; lo generado queda a la vista con su lote y enlace a la bandeja. 130/130 vitest | PM + sesión PQ |
| 2026-10-26 | «Necesito un 100 %»: las 268 líneas fuera de la ficha son 162 por etiqueta (cuadran por factor) + 106 unidades elegidas a mano en Kepler. **PQ.13 🧪**: migración que hace mandar la ficha de Kepler en sus almacenes (867 celdas, 568 a 1 por `unidad_unica`); cuerpo ejercido en prod sólo lectura, **sin aplicar** (§12.4) | PM + sesión PQ |
| 2026-10-26 | «Resolvámoslo» (D20): medido contra 19,367 líneas de OC reales de Kepler (90 d). **El resolvedor ya da el `c58` de Kepler en 99.3 % de las líneas en caja; el `c84` solo daría 98.7 %** → D20 refutada, sin vista que cambiar. `c58` es el factor del peldaño capturado (`c55`), no del producto. El desfase al escribir está en el adaptador (escribe `CJA`/`c58=1`); va a KR (§12.3) | PM + sesión PQ |
| 2026-10-26 | El PM avisó que la base fue editada: la unidad del catálogo venía de un importer y desfasaba lo insertado en Kepler. Medido (§12.2): 9,241 productos en lote, 93 % ahora = `c84` de Kepler. **M2 se relee** (cantidad cambiada mezcla comprador + unidad) y se repite sobre requisiciones posteriores al lote; M1 se repite; PQ.1/4/5 y la paridad no cambian. Nace **D20** (factor = `c84` de Kepler para almacenes Kepler) | PM + sesión PQ |
| 2026-10-23 | Auditoría del flujo (nivel B+C), jerarquía, agenda medida, M1/M2 definidas, doc creado en ⬜. Consultas en el scratchpad de la sesión; cifras en §1 | sesión Claude + PM |
| 2026-10-24 | «El CEDIS no recomienda comprar nada»: medido y cruzado con el reporte de existencia de Kepler (§12). Nuestra existencia = la de Kepler; la de Kepler = 127 SKUs contados el 30-sep y el resto en cero. **PQ.12** (demanda de red + D14 + compra del CEDIS) queda ⬜ dependiente del inventario físico del CEDIS. La sesión AB propuso D14/D15; PQ los acepta con cuatro ajustes (una sola regla de tránsito en `libs/`, D10 sin `eff_daily` en hubs mixtos, D15 sobre la bandeja existente, el número en un commit con antes/después) | PM + sesión PQ |
| 2026-10-23 | **PQ.1, PQ.5 y PQ.4 en 🧪** (commits `61cbe15`, `ea81144`, `da0b005`): la bandeja distingue «aprobada» de «escrita en Kepler»; Pedido avisa «hoy te toca pedirle a N proveedores»; el Ciclo abre por **agenda de proveedores** (237 filas, 227 ms, cruzada al centavo contra la vista por canal con el servicio real) y declara el tope de la lista por canal (639 activos, 500 mostrados). ⛔ **Bloqueo nuevo:** los items que ESCRIBEN (PQ.2, PQ.3, PQ.7, PQ.8, PQ.9, PQ.11) exigen prueba contra base real con el payload de la pantalla y **Docker Desktop no responde** en la máquina de trabajo: sin base de pruebas no se arrancan. Dueño: quien levante el stack `dev:up`. Otra sesión avanzó KR.12/KR.13 (encendido de Kepler servidor por servidor): revisar antes de PQ.2 | sesión Claude |
| 2026-10-23 | **Fase abierta 🔨**: el PM pasó **PO → ⏸️** (20 d sin commit, 0 items) y PQ ocupa su cupo. Fila en el roadmap. Dueño y fecha meta siguen sin nombrar. Arranca F1 (PQ.1) | PM |
| 2026-10-23 | PQ.M2 ✅ (rótulos revisados, nivel C). El PM firmó **D1 (c), D2 (b)+(c), D3 (c), D5 (b)**. Pendientes D4, D6 (espera M1) y D7. F1–F3 siguen sin cupo: 4/4 🔨 | PM |
| 2026-10-23 | «Hagámoslo»: M2 y M1 corridas contra prod con sus scripts y controles (§11). M2 🧪: el costo es el de Kepler (89–92 % vía `c58`), cambia la cantidad; M1 🧪 instrumento con control pero **28 renglones juzgables: NO MEDIDO a escala**. Dos defectos del instrumento tirados por el control (foto como árbitro de «llegó»; CEDIS sin foto leído como cero) | sesión Claude + PM |

---

## Observaciones de diseño UI — revisión del plan (2026-10-26)

> **Con qué se miró: el plan, no la pantalla** (nivel C). Nada visual se da por medido; lo que
> sólo se comprueba con la pantalla viva va como criterio a verificar. La ley es
> [`ESTANDAR_DE_INTERFACES.md`](../../ESTANDAR_DE_INTERFACES.md) (§ = sus secciones) y su
> implementación [`DESIGN.md`](../../../DESIGN.md). Severidad: 🔴 la pantalla afirmaría algo falso,
> escondería lo que importa o perdería trabajo — **bloquea pasar C3 a 🚀** · 🟠 se resuelve dentro
> de la fase · 🟡 mejora; si no entra, queda como deuda con nombre.
> `/compras/pedido` y `/compras/requisiciones` ya existen (PQ.1, PQ.4 y PQ.5 en 🧪): ahí cada
> observación es un criterio a verificar en la pantalla, no un defecto medido. En PQ.2, PQ.3 y
> PQ.7–PQ.11 es requisito de diseño. Las cifras son las del plan (y las de la Fase AB donde se
> dice), con su fecha.

**La pregunta que contesta (prueba de la frase, §4.0b):**

- **Pedido** (`/compras/pedido`): *«¿Cuánto le pido hoy a este proveedor para cada sucursal?»* — una
  pregunta. Bien partida; lo que falla es la verdad de sus cifras (PQ.UI.1–PQ.UI.4).
- **Agenda** (pestaña Ciclo, PQ.4): *«¿A qué proveedores me toca pedirles hoy?»* — una pregunta,
  contestada hoy con una fecha que el dato no sostiene (PQ.UI.5).
- **Requisiciones** (`/compras/requisiciones`, PQ.1 / PQ.2 / PQ.9): *«¿Qué de lo aprobado todavía no
  está en Kepler?»* — una pregunta.

**Jerarquía propuesta (§3.7 · DESIGN §Q.5):**

- Pedido: primario = lo que hay que pedirle a este proveedor (valor y cajas), con la cobertura con
  que se calculó · secundario = la celda por sucursal con su porqué (lo que ya viene, el freno, la
  venta) · terciario = colchón, clase ABC, costo vigente y su fecha.
- Agenda: primario = proveedores que tocan hoy **con fecha confiable** · secundario = vencidos y
  estimados, con su regularidad · terciario = historial de entregas.
- Requisiciones: primario = aprobadas sin documento en Kepler (cuántas, cuánto, la más vieja) ·
  secundario = la lista con su edad y su salida · terciario = folio, renglones y error técnico.

| # | Sev | Observación (desde la silla de quien la usa) y costo | Ley | Criterio de aceptación |
|---|---|---|---|---|
| PQ.UI.1 | 🔴 | **V30d y el «a pedir» salen de `analytics.sales_daily`, que AB midió mal en dos sentidos** (FASE_AB §16.17.1, 26-oct; este plan no lo menciona): las camionetas de Padre Hidalgo entran **dos veces** (~$2.75 M de más en 30 d, ~16 % de su demanda) y los productos con base de gramaje quedan **a la mitad** (500 g: 180 de 226 pares) o a la cuarta parte (250 g), ~$552 K en 30 d. El comprador pide de más para Padre Hidalgo y de menos en granel, con una cifra que la pantalla presenta como venta. Y Productos (PF) y Productos nuevos (NP) publican **otra** venta del mismo producto (ODS, sin las camionetas de Canindo): tres pestañas de Compras, dos ventas. | §1.3 · §1.5 · §1.6 | Item con número en §6 (hoy no hay). Mientras el cambio de fuente de AB (D17, C2) no se publique, V30d marca los renglones afectados con `p-tag` y su porqué: «Incluye dos veces la venta de las camionetas de Padre Hidalgo (~16 % de más)» · «Venta en kilos contra existencia en la base de Kepler: sale a la mitad». La cabecera dice de qué venta habla: «Venta de 30 días: tiendas y camionetas». Mismas marcas que la mesa de AB (AB.UI.2). |
| PQ.UI.2 | 🔴 | **La celda de una sucursal en Pedido y la mesa de esa sucursal en Autoabasto publican dos faltas del mismo producto.** Pedido calcula con 30 días, aplica el factor de cumplimiento y **no** resta lo que ya viene; la mesa usa 21 días en las cinco sucursales que no son matriz (AB.22) y sí lo resta. Sólo por la cobertura, en La Piedad Abastos Compras ve ~3,695 cajas donde la sucursal ve 2,072 (AB.22, 13-oct). Hay $1.53 M en documentos que ya vienen (hasta 777 renglones, AB §16.3, 23-oct) que una cuenta sin «ya viene» vuelve a pedir. D14 se aceptó el 24-oct, pero **el item que la consume no tiene número en este plan** («PQ.12» ya es el CEDIS). | §1.5 · §1.6 · §3.2 | Item con número en §6 para restar lo que ya viene (la función de AB.34), con su commit de antes/después. En la celda: «Falta 32 · ya vienen 20 (pedido 0450, embarque 0391) → 12». El subtítulo dice con cuántos días se calculó y, si la sucursal ve otra cobertura, la suya. **Conflicto (decide Edgar):** una cobertura para las dos pantallas o dos, declaradas (AB.UI.3). |
| PQ.UI.3 | 🔴 | **La «caja» del pedido no es la de Kepler en 2 de cada 3 SKUs del CEDIS** (`v_product_box_factor` prefiere la etiquetera, 5,244, sobre el `c84`, 2,544; §12.2, 26-oct) y el adaptador escribe en Kepler `CJA` con `por_caja: 1`. La pantalla dice «cajas» sin decir de cuántas, y la «cantidad cambiada» de M2 (38.3 % / 30.5 %) mezcla la corrección del comprador con el desfase de unidad. Productos nuevos (NP.16) y el redondeo de Autoabasto ya cuentan con la escalera de Kepler: el mismo producto sale en dos cajas según la pestaña. | §1.1 · §1.5 · §4.5 | Toda cantidad en cajas dice su contenido: «12 CJA de 24 PAQ». Donde la caja de la pantalla ≠ `c84`, `p-tag` «Caja distinta a Kepler» en la celda y en la requisición. La cifra de M2 se cita como «previa a la corrección de unidades» hasta re-correrla. **Conflicto (decide Edgar):** D20 sin firma — un solo resolvedor en `libs/`, compartido con AB (AB.UI.4). |
| PQ.UI.4 | 🔴 | **Filtrado al CEDIS, Pedido dice «A comprar $0 · SKUs 0 · Sin datos en los puntos de compra»** junto a «A traspasar $2.89 M desde CEDIS». No es cero: el CEDIS no vende (la fórmula da 0 por construcción) y su existencia es un artefacto del corte (127 SKUs contados el 30-sep; ~900 de los 1,264 que embarca viven en cero o negativo). §12 escribe lo honesto («existencia no medida para N SKUs») pero **ningún item cambia el texto**: PQ.12 espera un inventario físico sin fecha. Y 45 negativos que Kepler publica se ven como 0 (D8 sin firma). | §1.3 · §3.2 | Item C3 que no espere a PQ.12. Con el CEDIS elegido: «El CEDIS no vende: su compra no se puede calcular hasta que tenga existencia contada. Sin contar: N de los 1,264 productos que embarcó en 30 días». Nunca «$0». Negativo con `p-tag` «Negativo en Kepler» (D8). |
| PQ.UI.5 | 🔴 | **La agenda (PQ.4) y el aviso «hoy te toca pedirle a N proveedores» (PQ.5), los dos en 🧪, publican fechas que el dato no sostiene:** sólo 221 de 886 canales de compra son regulares (25 %), el lead time está en 0 en los 1,049 y la captura (PQ.3) está bloqueada sin base de pruebas. Resultado: **637 de 1,049 canales «vencidos»** (61 %). Una lista donde 6 de cada 10 están vencidos no es señal, y el aviso que iba a medir «si el Ciclo sirve cuando está enfrente» medirá una fecha equivocada. | §1.3 · §1.1 · §4.0 B · DESIGN §X.4 | Cada fila dice de dónde sale su fecha y cuánto aguanta: «Capturada» o «Estimada: entregas cada 27 a 79 días, poco confiable». El aviso separa: «Hoy te toca: 3 con fecha confiable · 21 estimadas». «Vencido» sólo con fecha capturada o canal regular. Lead time 0 se muestra «sin capturar», nunca «0 días». |
| PQ.UI.6 | 🟠 | **PQ.1 distingue «aprobada» de «escrita en Kepler», y el plan pide mostrarlas «con su edad y su `kepler_error`»:** 134 requisiciones dicen «KEPLER_PUSH_URL sin configurar», una variable de entorno, no algo que el comprador pueda resolver. Y la misma requisición aprobada sin documento sale en Autoabasto como «Compras lo planeó», dentro de «Lo que te llega» (AB.UI.1): dos rótulos para el mismo estado, y uno de ellos dice que llega. Son 680 por $19.05 M. | §3.9 · §1.5 · §3.4 | El estado en el idioma de quien lo lee: «Aprobada · sin documento en Kepler · hace 12 días», con su salida al lado (registrar el folio, PQ.2 / PQ.7). El error técnico va al detalle, no a la fila. «Aprobada» sin documento nunca lleva el color de éxito. Mismo rótulo y misma edad en la pantalla de la sucursal. |
| PQ.UI.7 | 🟠 | **PQ.2 y PQ.7 piden capturar la coordenada de Kepler al cerrar, y M2 ya dice lo que va a encontrar quien la capture:** en traspasos el total cuadra en **3 de 296** pares y la cantidad cambia en el 30.5 % de los renglones (38.3 % en compras). Si el formulario sólo valida que el folio exista, se ligan documentos que no corresponden; si exige que cuadre, nadie cierra los 602 traspasos ($12.81 M). | §4.5 · §3.2 · §3.3 | Al salir del campo del folio, la pantalla trae el documento de Kepler y lo pone junto a la requisición, renglón por renglón: «pediste 12 · Kepler registró 10». Un folio de otro destino o de otra sucursal se rechaza antes de guardar. Se cierra con las diferencias a la vista, ni ocultas ni bloqueantes. Prueba contra base real con el payload de la pantalla. |
| PQ.UI.8 | 🟠 | **El duplicado entre días (PQ.8) se le va a avisar a quien está armando el pedido, con prisa:** 84 grupos vivos, 388 renglones, $3.30 M. D4 recomienda aviso con confirmación (juntar pedidos es legítimo) y sigue sin firma. Un aviso genérico («ya existe una requisición») se acepta por reflejo. | §4.4 · §3.2 | El aviso nombra lo que ya lo pide: «RQ-2026-00760 · 18-oct · 24 CJA · aprobada sin documento». «Pedir de todos modos» no usa el color de acción, va separado de «Quitar del pedido» y pide motivo de la lista de PQ.UI.9. Los repetidos vivos se re-miden después. |
| PQ.UI.9 | 🟠 | **El motivo obligatorio (PQ.9) y el rechazo con motivo que AB ya construyó (§16.16 de AB, con `CHECK`) van a compartir columnas.** Si uno es texto libre y el otro lista, las 395 canceladas por $34.72 M se seguirán sin poder agrupar por porqué: AB ya aprendió que «un texto libre no se aprende» (AB.18). | §4.5 · §5.4 | Una lista cerrada en `libs/contracts` (con «Otro» + texto), la misma para cancelar y rechazar en Compras y en Autoabasto. El motivo se ve en la bandeja y en la pantalla de la sucursal, con quién y cuándo. |
| PQ.UI.10 | 🟠 | **El freno de fin de pico (motor común, AB.17) baja el sugerido y la pantalla no lo dice:** «la venta de 30 días que se muestra no cambia; sólo baja el objetivo». Son 725 pares (pedido de $718 mil → $162 mil). El comprador ve V30d alta y sugerido bajo, y lo sube: ya sube el sugerido en 2,726 de 7,111 renglones en 30 d. | §3.2 · DESIGN §X.3 | `season_src = 'fin_pico'` llega a la celda: `p-tag` «Fin de pico» y «Se pide para la venta normal: la semana pasada vendió menos del 40 % de su semana más alta». Igual que la mesa de AB (AB.UI.7). |
| PQ.UI.11 | 🟠 | **Con D3 de AB, el sobrante de la red quedó del lado de Compras, y Compras abre Sobrante 5 veces en 30 días** (Flujo, otras 5; Pedido, 3,734). La decisión de traspasar en vez de comprar vive en una pestaña que nadie abre. | §3.4 · §4.0c · §2.1 | Donde hay falta y otra sucursal tiene de más, la celda de Pedido dice la comparación: «Padre Hidalgo tiene 40 cajas sobre su máximo: traspásalo antes de comprar», con enlace a Sobrante filtrado a ese producto. Se mide si el uso sube. |
| PQ.UI.12 | 🟠 | **La aprobación es un segundo clic: 849 de 863 aprobaciones son de una persona, 484 (56 %) sobre lo que ella misma creó, mediana 20 h.** PQ.11 quiere guardar «lo que la persona vio»; eso sólo es verdad si la pantalla se lo muestra antes del clic. | DESIGN §X.1 · §4.0c | Antes de aprobar, el resumen en llano: «Sugerido 120 · final 180 (+50 %) · costo vigente al 21-oct · 3 renglones subieron más del 20 %». Si quien aprueba la creó: «La creaste tú», visible; con god-mode, que se vea. Lo mostrado es lo que se guarda. |
| PQ.UI.13 | 🟠 | **`/compras/pedido` decía el 22-oct «consolida en 01», «todo a 00» y «entrega en 01, 08»** (skill `diseno` §4). La agenda (PQ.4, «sucursales que le tocan») y el cierre manual (PQ.2, la sucursal de la coordenada) suman dos lugares nuevos para un código crudo. | regla PM 2026-10-22 · DESIGN skill §4 | Ninguna cadena visible —celda, opción, título, `aria-label`, nota que se guarda, PDF— lleva «00» u «01»: pipe `\| sucursal` en plantilla, `warehouseName()` en código. La sucursal de la coordenada se elige por nombre. |

**Lo que esta revisión no cubre:** contraste, densidad de la tabla de Pedido y teclado reales (exigen
nivel A); la velocidad (PQ.10: `workbook` con pico de 11.4 s, XLSX con pico de 121 s), salvo que la
pantalla conserve lo último mientras recalcula y que un segundo clic en el XLSX no relance la
consulta; M1 y M2, que se quedan en C0 sin pantalla; y PQ.12 contra AB.31 («cuánto le van a sacar a
la matriz»): dos construcciones de la misma pregunta que hay que asignar antes de que alguna llegue a
pantalla.
