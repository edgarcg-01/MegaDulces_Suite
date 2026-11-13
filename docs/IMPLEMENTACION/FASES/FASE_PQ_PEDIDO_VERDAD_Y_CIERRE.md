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
| D21 | ¿La Suite deja de emitir OC y OE propias y sigue sólo las de Kepler? | **Sí — en código (PQ.16, `87e8adc93`).** «Generar orden de compra» y «Registrar recepción» apagados (409 en el backend, lectura en pantalla); la requisición se ordena con el folio de Kepler. Es ADR-040 aplicado a Compras. Pendiente: «de qué requisición» en la lista de Kepler |

**NO MEDIDO:** cuántas de las 136 OE propias tienen su X-A-40 gemela en Kepler (cruce por
proveedor + fecha + SKU, instrumento pendiente); y por qué sólo 2 de 136 aplicaron stock.

## 14. ¿Pasa el 100 % a Kepler? El simulacro (2026-10-27)

Pregunta del PM: «la inserción en Kepler ya está armada, ¿cómo validamos que el 100 % de las
requisiciones y traspasos van a pasar?». No con una promesa: con un **simulacro** que corre, sin
escribir, las mismas comprobaciones del adaptador (`kepler-requisition-sink.adapter.ts`) sobre
TODO el universo y cuenta por motivo. Instrumento: `database/scripts/pq-simulacro-escritura-kepler.js`
(sólo lectura; **control**: reproduce el rechazo real de RQ-2026-01391, «no conoce al proveedor
CA027» en la 04 — coincide).

| Prod, 2026-10-27 | |
|---|---:|
| universo: aprobadas sin folio + pendientes de aprobación | **853** (81 compras · 772 traspasos) · $20.98 M |
| pasan las comprobaciones de datos del adaptador | **819 (96.0 %)** · $20.28 M |
| rebotan | 34 · $0.70 M — **todos** por «Kepler (sucursal NN) no conoce al proveedor» |
| de esos 34, el proveedor SÍ está en el catálogo de proveedores de Kepler (`kdxd`) de esa sucursal | **34 de 34** |

**Lo que el número dice:** el único rebote de datos es una regla **nuestra** más estricta que
Kepler: el adaptador acepta un proveedor sólo si **ya tiene una X-A-30/X-A-35 en esa sucursal**, y
después del corte del 1-oct las sucursales compran a proveedores nacionales (Mondelez CM009, AJEMEX
CA027, CA010…) por primera vez. Kepler los conoce (`kdxd`); nosotros no. Con el catálogo como
testigo, **pasa el 100 % de los 853**.

**Lo que el simulacro NO puede medir desde la base, y es lo que de verdad decide (KR, runbook):**

| Bloqueo | Qué pasa si falta | Dueño |
|---|---|---|
| `KEPLER_PUSH_URL_NN` por servidor | rebota todo ese servidor («escritura apagada») | KR |
| **plantilla del TRASPASO por servidor** (sin default a propósito) | rebotan los **772 traspasos** | KR (elegir un `U-D-40` en AUTORIZADO) |
| tope diario `KEPLER_PUSH_MAX_DIA_NN` (default **1**) | el 00 tardaría **470 días** en vaciar su cola; 01, 198; 08, 107 | KR: subirlo con el canario en verde |
| la BAJA desde la UI de Kepler (criterio del canario) | no se enciende ningún servidor | KR |

**Riesgos que el adaptador NO detiene (se declaran, no se dibujan):** 21 documentos ($2.87 M, 39
renglones) con **cajas fraccionadas** (Kepler acepta numérico; el comprador en Kepler no captura 0.2
cj); SKU sin ficha en la sucursal: **0**.

| # | Decisión | Recomendación |
|---|---|---|
| D22 | ¿El testigo de «proveedor conocido» es el catálogo de Kepler (`kdxd` por sucursal) y no «ya le compró»? | **Sí — en código (`219e13736`)**: el adaptador lee `md.kdxd`. Simulacro: 0 rebotes de datos |
| D23 | ¿Cajas fraccionadas se redondean antes de escribir o se frenan? | **Se frenan — en código (`219e13736`)**: en la mesa (`planBloqueos`) y en el servidor (`createRequisitionBatch`), con el producto; nunca se redondea |

**Protocolo propuesto para «el 100 %»:** (1) D22 en el adaptador; (2) simulacro = 0 rebotes de datos;
(3) canario por servidor con la baja desde UI; (4) tope diario subido por servidor; (5) el simulacro
corre **antes de cada encendido** y queda en la bitácora con su cifra.

### 14.1 «Resolvamos todo lo que no nos deje» — qué quedó resuelto y qué es configuración (2026-10-27)

| Bloqueo | Resuelto | Cómo |
|---|---|---|
| D22 · proveedor «no conocido» (34 docs) | ✅ código `219e13736` | el adaptador consulta el catálogo `md.kdxd` (c2 código · c3 nombre), no una compra previa. **Simulacro re-corrido con la regla vigente (`131f21afd`): 853 de 853 pasan (100 %)**; el control exige que la regla anterior reproduzca el rechazo real y que la vigente lo deje pasar |
| D23 · cajas fraccionadas (42 renglones vivos en 24 docs) | ✅ código `7fc107f6c` | **No se corrigió ningún dato: los 42 son PIEZAS enteras** (0.4 cj × 10 = 4 pz; la mesa deja capturar en piezas). Regla única `piezasEnteras` (tolerancia 0.02): la mesa, el lote y el empuje dejan pasar cajas enteras o piezas enteras; el adaptador escribe las piezas en la **unidad base de Kepler** (`kdii.c11`, `c58=1`, costo por pieza) y frena sólo lo que no es ni lo uno ni lo otro (hoy: **0**). Redondear a caja inventaba compra ×2.5; a cero borraba lo pedido |
| plantilla del TRASPASO por servidor | ⬜ **configuración (KR)** | sólo cuatro servidores originan traspasos. Candidatos sanos medidos en el ODS (U-D-40 `AUTORIZADO`, `c43='N'`, `c27='SUCURSAL'`, responsables vacíos): **00 → `1/0001240`** (20-oct, 7 ren; o el `0000450` del runbook) · **06 → `1/0001479`** (20-oct, 11 ren) · **08 → `1/0000847`** (23-oct, 5 ren) · **01 → ninguno con `c27='SUCURSAL'`** (sus 12 sanos son `TELEMARK`; hay que elegir uno a mano o aceptar `TELEMARK`). El 04 no tiene ningún U-D-40 sano |
| tope diario `KEPLER_PUSH_MAX_DIA_NN` = 1 | ⬜ **configuración (KR)** | cola que pasa: 00 → 470 · 01 → 198 · 08 → 107 · 06 → 42. Propuesta para vaciar en ≤ 10 días hábiles tras el canario: `00=50 · 01=25 · 08=15 · 06=10 · 04=07=5` |
| `KEPLER_PUSH_URL_NN` y `pg_hba` | ⬜ configuración (KR, runbook §1–3) | — |
| baja desde la UI de Kepler | ⬜ humano (canario) | — |

Variables propuestas (el nombre exacto lo fija `kepler-servidores.ts`: `KEPLER_PED_TEMPLATE_FOLIO_NN`, `KEPLER_PUSH_MAX_DIA_NN`):

```bash
KEPLER_PED_TEMPLATE_FOLIO_00=0001240   KEPLER_PUSH_MAX_DIA_00=50
KEPLER_PED_TEMPLATE_FOLIO_06=0001479   KEPLER_PUSH_MAX_DIA_06=10
KEPLER_PED_TEMPLATE_FOLIO_08=0000847   KEPLER_PUSH_MAX_DIA_08=15
# 01: elegir a mano (ningún U-D-40 sano con c27='SUCURSAL')   KEPLER_PUSH_MAX_DIA_01=25
```

**Después de cada cambio de configuración:** `node database/scripts/pq-simulacro-escritura-kepler.js`
tiene que dar **0 rebotes de datos**; lo de configuración lo prueba el canario (runbook §9, P0–P5).

### 14.2 ¿Y los traspasos? (2026-10-27)

Medido en el ODS, con las comprobaciones que el adaptador hace **en el servidor de origen**:

| Comprobación | Resultado |
|---|---|
| `pv_suc_ip` (sucursal destino → `TI###`) existe en los 9 servidores | **sí**, mapa idéntico en los 9 (01→TI001 · 02→TI008 · 03→TI002 · 04→TI003 · 05→TI007 · 06→TI006 · 07→TI009 · 08→TI004) |
| 772 traspasos vivos, 20 pares origen→destino (00, 01, 06 y 08 originan) | **20 de 20** con el TI del destino en el servidor origen |
| líneas que irían en piezas (fracción de caja): 29 | **29 de 29** con unidad base en la ficha `kdii` del origen |
| simulacro (reglas vigentes) | 772 de 772 pasan los datos |

Lo único que falta para un traspaso es **la plantilla `U-D-40` por servidor origen** (sin default a
propósito): 00 `1/0001240`, 06 `1/0001479`, 08 `1/0000847` medidas en §14.1; **la 01 no tiene un
`U-D-40` sano con `c27='SUCURSAL'`** (sus 12 sanos son `TELEMARK`) — hay que elegirla a mano o
aceptar una `TELEMARK` (el adaptador limpia responsables y pone `c27='SUCURSAL'` igual). Y el canario
de traspaso (runbook §9) todavía no se ha corrido en ningún servidor.

### 14.3 Lo que ya existe para seguir un traspaso: `/almacen/movimientos` (2026-10-27, nivel A en local)

El PM señaló `/almacen/movimientos?dest=sucursal&doc=TrsfShip`. Recorrido con el usuario de prueba:

- **Diario:** los embarques `U-D-41` a sucursal por día (1,130 documentos, $32.91 M, 1.59 M pz de
  salida en el rango) y, al abrir un día, cada documento con su estado **En tránsito / Completado /
  Con diferencia**. El estado sale del servicio de movimientos (DM.3): parea el `TrsfShip`
  (`U-D-41`) con su `TrsfRcv` (`U-A-50`) por cantidad y fecha; sin recepción = en tránsito. El
  26-oct: 47 docs, 17 en tránsito, 31 completados (verificado contra el ODS: `U-D-41 0003354`
  Padre Hidalgo → Yurécuaro, 18 líneas, $11,683 — coincide). «Auditar» marca el documento.
- **Cuadre de traspasos:** mayor 515 (descuadre acumulado +$13.72 M), 224 pólizas sin rastro,
  Kepler→Wincaja +$6.15 M; hallazgos: 49 traspasos sin acuse ($730,889, el más viejo 20 días),
  233 cargas a ruta y 1,102 entregas a cliente separadas para no inflar el hueco.

**Qué significa para PQ:** el cierre del traspaso **ya existe de `U-D-41` a `U-A-50`**. Lo que falta
es el eslabón anterior: **requisición → `U-D-40` (pedido) → `U-D-41`**. El `U-D-40` y el `U-D-41`
**no comparten folio** (medido: `U-D-40 0003354` de la 01 es RUTA 27 y el `U-D-41 0003354` es
Yurécuaro `TI003`); la junta `40→41` hay que medirla en `kdm1`/`kdm2` (referencia) antes de
dibujarla. **PQ.3 se re-define**: no construir otro cierre, sino (1) `oc_folio` del `U-D-40` en la
requisición (RQ.15, ya exige sucursal + folio), (2) medir y usar la referencia `40→41` de Kepler,
(3) leer el estado del embarque desde el mismo servicio de movimientos (sin segunda implementación).

**Plantilla de la 01 (cierra §14.1):** `U-D-40 1/0003333` de Padre Hidalgo (`SUCURSAL` → 8
Esquinas `TI002`, 13 renglones). Está `EMBARCADO`, y eso no importa: el adaptador reescribe
`c11='AUTORIZADO'`, `c43='N'`, `c27='SUCURSAL'` y limpia `c100/c102/c103`
(`kepler-doctipo.ts`). Mi criterio de «sano» era más estricto que el adaptador.

```bash
KEPLER_PED_TEMPLATE_FOLIO_00=0001240
KEPLER_PED_TEMPLATE_FOLIO_01=0003333
KEPLER_PED_TEMPLATE_FOLIO_06=0001479
KEPLER_PED_TEMPLATE_FOLIO_08=0000847
```

Observado en esa pantalla y no tocado (no es de esta fase): folio y cantidad de salida en **rojo**
(un movimiento normal pintado como alarma), rótulo «Traspaso a sucursal» sobre un embarque, y
«Auditar» en color de acción en cada fila.

### 14.4 Cómo queda un traspaso en cada sucursal, y la unidad del renglón (2026-10-27)

Caso real trazado en el ODS: Padre Hidalgo → Yurécuaro, 26-oct.

| Paso | Dónde | Documento | Contraparte (`c10`) | Liga con el anterior |
|---|---|---|---|---|
| 1 Pedido | la que **manda** (01) | `U-D-40` serie 1, folio `0003466` | `TI003` «SUCURSAL YURECUARO» | — |
| 2 Embarque (sale inventario) | la que **manda** (01) | `U-D-41` serie 2, folio `0003354` | `TI003` | `c37/c38/c39 = 40/1/0003466` |
| 3 Recepción (entra inventario) | la que **recibe** (04) | `U-A-50` serie 1, folio `0000339`, al día siguiente | `TI001` «SUCURSAL PADRE HIDALGO» | `c37/c38/c39 = 41/2/0003354` |

Los tres: 18 renglones, 457 unidades, $11,683.42, idénticos renglón por renglón (mismo SKU,
cantidad, unidad y costo). Cada sucursal ve a la otra como su `TI###`, y los folios **no**
coinciden entre documentos: la liga es el back-pointer `c37/c38/c39`.

⛔ **Hallazgo — la unidad del renglón.** En los `U-D-40` de traspaso a sucursal de Kepler (60 días,
57,188 renglones) el renglón va en la **unidad base del producto** (`kdii.c11`) en el **99.2 %**:
PAQ 66.7 % · PZA 24.5 % · KG 7.7 %; `CJA` sólo **0.1 %** (82 renglones). La recepción `U-A-50`
copia la unidad (CJA en 134 de ~40 mil). El adaptador escribe las cajas enteras en `CJA` (KR.6) y
sólo las fracciones en unidad base (PQ.17): un traspaso escrito así viaja por el embarque y la
recepción **en una unidad que Kepler casi no usa**, y la sucursal que recibe lo vería distinto a
todos sus demás traspasos.

| # | Decisión | Recomendación |
|---|---|---|
| D24 | ¿El traspaso se escribe en la unidad base (`cajas × piezas_por_caja`, `kdii.c11`, costo por unidad base), como el 99.2 % de los de Kepler? | **Sí**, para traspasos. Ya existe el camino (PQ.17 lo usa para fracciones) y el factor es la ficha de Kepler (PQ.13). Sin factor → rechazo con el SKU. Antes de encender: canario de traspaso con una línea entera y una en piezas, y ver que el `U-D-41` y el `U-A-50` la copien igual. Para compras (`X-A-30`) queda como está hasta medirlo aparte |

### 14.5 D24 en código y qué falta para encender las pruebas (2026-10-27)

PM: «actívemoslo para hacer pruebas». **D24 en código (PQ.19):** todo renglón de traspaso se escribe
en la unidad base de la ficha del ORIGEN (`kdii.c11`, `c58=1`, cantidad = cajas × piezas por caja,
costo por unidad base). Freno nuevo: el factor que manda la Suite (`v_product_box_factor`) tiene que
coincidir con el de la ficha `kdii` del servidor origen (misma regla que `v_kepler_unit_ladder`,
`ficha-kepler.ts`); si no, se rechaza con el SKU y los dos factores. Compras sin cambio.

Simulacro re-corrido (sólo lectura, control RQ-2026-01391 ✓):

| | docs | pasan | rebotan |
|---|---:|---:|---:|
| compras | 85 | 85 | 0 |
| traspasos | 809 | 776 | 33 ($0.97 M, 218 renglones) |

Los 33 son **la ficha de Kepler**, no la Suite: la mayoría rotula la caja sin factor ni costo
(87234, 45007, 47901, 17062–17064, 17202–17204… ficha = sin factor, Suite = 1) y dos contradicen
(31024: Suite 12 / ficha 10 · 52020: Suite 6 / ficha 35). Se arreglan capturando el factor en la
ficha de Kepler del origen; nunca se adivina.

**Encender NO es código: es el secreto `kepler-push` en `md`**, con credenciales que la sesión no
toca (regla 7). Código en prod: KR.17 (`4442f907a`, `35006040a`), PQ.17 y PQ.18 sí; **PQ.19 no**
(commit local, va con el siguiente push). Orden para las pruebas (runbook KR §9.2 y §11):

1. Canario de **compra** en Yurécuaro (04), tope 1, sólo plantilla de compra. Criterio: la **baja
   desde la UI de Kepler** funciona.
2. Después de desplegar PQ.19: canario de **traspaso** desde 01, plantilla `U-D-40 1/0003333`,
   tope 1, con una línea entera y una en piezas. Criterio: el `U-D-41` y el `U-A-50` copian la
   unidad base.

### 14.6 La requisición entra pero no se puede convertir; y la OC automática (2026-10-28)

PM: *«la requisición ya se aceptó y se generó, pero para generar la orden de compra desde Kepler
no aparece… y aparte nosotros generar automáticamente la orden de compra en Kepler»*. Las cuatro
primeras requisiciones reales (oficinas `0003111`–`0003114`, RQ-01615/01601/01636/01626) se ven en
la consulta de Kepler pero no en la conversión a OC. Nivel B (`kepler_ods`, sólo lectura):

| Hallazgo | Medido | Arreglo |
|---|---|---|
| **`kdm1.c42` = saldo pendiente.** Abierto (`c43` N/A) ⇒ `c42 = c16`; convertido ⇒ 0. Escribíamos 0 → Kepler la daba por surtida y no la ofrecía | 38/38 X-A-30 abiertas con importe, 1,329/1,333 U-D-40 abiertos, 0 de 4,244 convertidas | **PQ.21**: `c42 = c16` al escribir (compra y traspaso) |
| **IVA/IEPS del renglón venían de la plantilla.** `kdm2.c17` = \|`kdii.c18`\| (IVA) y `c18` = \|`kdii.c19`\| (IEPS); copiábamos `-16`/`0` a todo renglón | ≥99 % de los X-A-30/35 desde agosto, nueve servidores | **PQ.21**: tasas de la ficha del servidor; sin ficha → rechazo con el SKU |
| **El encabezado no llevaba impuestos.** `c14` = Σ round(c13·c17/100,2), `c15` ídem con c18, `c16` = subtotal + c14 + c15 (− `c13` descuento) | 96–98 % de 2,700 documentos | **PQ.21**: se calculan; `c16` deja de ser el subtotal de la Suite |
| **Cómo convierte Kepler.** OC = copia del encabezado salvo `c4 c6 c31 c63` y la liga `c36 A · c37 30 · c38 serie · c39 folio`; renglón = copia salvo `c19..c23` y `c31 = c9`; la requisición queda `c43 F`, `c42 0`, `c24 0` | 1,142 pares, 1,893 renglones, nueve servidores; serie 1 y `XA3501-` en todos | **PQ.22**: la OC se escribe en la MISMA transacción; la requisición nace convertida |

⭐ **PQ.22 no pide permiso de UPDATE en Kepler**: los dos documentos entran juntos, la requisición
ya en su estado final. Tampoco queda una requisición pendiente que alguien pueda volver a convertir
a mano (OC duplicada). El interruptor es `kepler_push_switch.genera_orden` (mig `20261028135333`),
**apagado en las nueve**; se enciende en `/compras/kepler-escritura` → columna «Orden de compra».
En la Suite la requisición pasa a `ordered` con `oc_sucursal/oc_folio` de Kepler. La OC abierta
entra sola a «En camino» y a `/compras/oc-abiertas` (leen X-A-35 abiertas): no hay doble conteo,
porque «en camino» nunca contó requisiciones de la Suite.

⭐ **Actualización 2026-10-28 tarde:** con la clave de `postgres` del PM se dio `GRANT SELECT ON md.kdxd, md.kdii TO kepler_push` en **01, 06 y 07** (antes false/false, después true/true). El ensayo con ROLLBACK pasa ahí **compra** (tasas, impuestos, `c42`) y **compra + OC** (requisición convertida, OC ligada y abierta); cazó un error real de tipos (`c38` numeric) que se corrigió. 00, 02–05 y 08 siguen sin medir desde desarrollo.

~~NO MEDIDO contra Kepler.~~ El ensayo (`kepler-requisition-sink.ensayo.spec.ts`, ROLLBACK) no
corrió en ningún servidor desde la máquina de desarrollo: 00/02/03/04/05/08 no tienen `pg_hba` para
ella y **01, 06 y 07 siguen sin `GRANT SELECT ON md.kdxd`** (00 sí lo tiene: ahí entraron las
cuatro; 02–05 y 08 sin medir). Antes de encender la OC automática: el GRANT donde falte, desplegar, y un canario en oficinas con la baja
desde la UI de Kepler (OC y requisición). Las cuatro ya escritas se reparan a mano (runbook KR §13).

---

## 15. Revisión del 2026-11-04: la temporada, la sincronía con Autoabasto y lo que el motor no considera

PM, con captura de la mesa de 8 Esquinas: *«hay algo importante que no se está considerando y es la
estacionalidad de los productos. No voy a pedir lo que muestra la imagen si su venta es sólo en
octubre… necesito que pedido y /almacen/autoabasto funcionen en sincronía; antes de proponer nada
revisa los puntos anteriores»* y después *«documéntalo y revisa qué más no estamos considerando»*.

**Evidencia:** nivel B (prod en sólo lectura, `system_identifier 7688376744939610156`, API en
`7db184b1f`) + nivel C (código). **Nivel A no**: no hubo sesión en la pantalla. ⛔ **Esta sección
documenta hallazgos; no propone arreglos** — el PM pidió revisar antes de proponer.

### 15.1 La temporada: por qué la mesa pide calaveritas el 4 de noviembre

Caso: `39025 PAL CALAVERITAS 560G/40` en 8 Esquinas, mesa «Falta neta 2.8 · a pedir 3 CJA», venta
sólo en octubre. **Control:** 3.222 pz/día × factor 1.000 × 21 d ÷ 24 pz/caja = **2.82** = lo que
pinta la pantalla. El factor sale de `database/importers/kepler/import-replenishment-plan.js`
(`seasonCte` y `fpico`), y lo leen igual la mesa y `/compras/pedido`.

| # | Hueco | Dónde | Medido |
|---|---|---|---|
| 1 | **Los meses en cero no existen.** El índice normaliza cada mes contra el promedio de los meses CON venta (`sy … HAVING sum(rev) > 500`). Un producto que sólo vende en octubre tiene octubre = su promedio = 1.0: se lee **plano** | `seasonCte` | 39025: factor **1.000**, tomado de la categoría (`season_src='cat'`) |
| 2 | **Piso de 0.5.** `LEAST(2.0, GREATEST(0.5, …))`: aunque el índice diga «noviembre ≈ 0», se pide al menos la mitad de lo de octubre | `season` | 58 de 95 pares de Día de Muertos con sugerido están en el piso |
| 3 | **El freno de fin de pico (AB.17) excluye la temporada por diseño.** Pide venta regular (6 de 8 semanas) y existencia 6 de 7 días; lo de temporada no es regular y lo agotado se trata como venta negada | `fpico` | **0** de 95 frenados |
| 4 | **Un solo año de historia.** El índice lee `analytics.sales_daily` desde 2025-01-01; en `kepler_ods` hay 2026 en las nueve sucursales y 2025 en tres. 8 Esquinas y Yurécuaro venden desde enero de 2026: no tienen octubre anterior propio | `hist` | sin forma de comprobar repetición (AB §4 ya lo declaró) |

Además: banda muerta 0.85–1.15 → 1, y respaldo por categoría cuando el SKU no tiene el mes.

**Alcance, como cota inferior** (filtro por nombre: calavera, calaca, Halloween, catrín, bruja,
calabaza, muerto, fantasma, esqueleto, zombi — es un control, no una regla): **26 productos, 95
pares almacén × producto, ~450 cajas, ~$85 mil a costo** sugeridos hoy; y **32 productos en 76
pares con $78 mil de existencia** que quedaron de la temporada. ⛔ **El universo de todas las
temporadas está NO MEDIDO** (§15.5).

⭐ **Ya estaba diseñado y no se construyó:** FASE_AB §4 define la regla de temporalidad con
vigencia, el caso «fin de temporada con mercancía por recibir» y los estados `clasificada` ·
`ventana_incompleta` · `sin_historia`. Hoy: 0 items en el tracker, 0 tablas en prod.

⛔ **Dónde no va el arreglo:** el factor vive en un importer (regla 1) y **D17 de AB** (firmada el
26-oct) mueve el motor completo —mesa, «Mi pedido» y `/compras/pedido`— a vistas del ODS. El plan
sigue saliendo del importer (latido `fact_replenishment_plan_stock` en `ok` hoy). Extender
`seasonCte` contradice D17.

### 15.2 Pedido y Autoabasto: una fuente, tres fórmulas

Leen el mismo `analytics.replenishment_plan` (demanda, existencia, factor de temporada): **en la
temporada están sincronizadas en el error**. La falta se calcula distinto:

| | `/compras/pedido` (`workbook`) | Mesa de Autoabasto (`demandTarget`) |
|---|---|---|
| Cobertura | la que elige el comprador (30 d por omisión), igual para todo almacén | mapa fijo `COBERTURA_AUTOABASTO`: 21 d en 02–07, 30 d el resto |
| Cumplimiento del proveedor | infla hasta 1.30 (RA-DYN.U7) | no |
| Traspaso en camino en Kepler (`U-D-40`/`U-D-41`) | **no lo resta**: el tránsito del plan sólo lee OC `X-A-35` sin entrada | lo resta, dentro de su ventana |
| Traspaso aprobado en la Suite | no lo cuenta → lo vuelve a sugerir | lo muestra como «Compras lo planeó», no lo resta (D14) |

Y una tercera: `purchaseSuggestion` (cálculo lateral de Pedido) con cobertura por cadencia de
Kepler + lead y colchón por cuantiles. **PQ.UI.2 (26-oct) sigue vigente.** El script
`database/scripts/ab25-mesa-vs-pedido.js` corrió hoy, pero reproduce el texto del motor del 13-oct:
no se cita como medición actual.

### 15.3 Lo demás que el motor no considera

| # | Qué | Medido hoy | Confianza |
|---|---|---|---|
| 1 | **Los días agotados cuentan como venta cero.** `import-demand-clean.js` divide entre los días de la ventana, también los días sin existencia; ni la demanda ni el plan lo corrigen. Dirección **contraria** a la temporada: pide **de menos** | Productos A con venta: **865 de 4,725 (18 %)** sin existencia en la foto 7 o más de 29 días; B: **1,514 de 6,104 (25 %)**. Venta no vista en 21 d, sólo con pares que tuvieron existencia 10 días o más: ~$2.0 M (A) + ~$0.8 M (B) a costo | **PLAUSIBLE**: `stock_snapshots` no guarda filas en cero (ausencia = cero o fuera de la foto) y la foto es de fin de día (agotarse a media tarde cuenta como día sin existencia). Sin control independiente |
| 2 | **El tiempo de entrega nadie lo captura** | 0 de 2,349 canales con lead capturado, 0 con cadencia manual (PQ.3 ⬜). El plan usa un lead derivado: 1–40 d, promedio 5 | B |
| 3 | **Se sugieren productos que nunca se compraron** | 191 productos en 311 pares sin `last_purchase` en ningún almacén, ~$0.78 M aprox. (incluye `17499`, que es una venta única, §17 C-3) | B; **no investigado** si son proveedores que surten directo en tienda o altas nuevas |
| 4 | **Los feriados móviles caen en otro mes.** El índice es mensual: Semana Santa fue 13–20 abr 2025, 29 mar–5 abr 2026 y será 21–28 mar 2027. Con un año de historia, la cuaresma se espera en el mes del año pasado | — | mecanismo, **no medido** |
| 5 | **Lo que sobró de la temporada no tiene salida** | $78 mil de Día de Muertos en existencia (§15.1); Sobrante se abría 5 veces en 30 d (23-oct) | B; uso de hoy **no medido** |
| 6 | **Los traspasos de la Suite son un plan paralelo** | 1,104 aprobados ($20.93 M), 0 con documento en Kepler, ~300 nuevos por semana con «escritura de traspaso apagada desde la Suite». El traspaso real va por `U-D-40`/`U-D-41` en Kepler y la mesa lo resta. **Repetidos** (mismo destino, origen y producto, vivos, 30 d): **640 grupos, 468 en días distintos, hasta 6 veces, $5.95 M** | B, re-medido por el destino del renglón |
| 7 | **Cancelar no pide motivo** | 107 canceladas en 14 d, 0 con motivo. `reject()` sólo lo exige si la pidió una sucursal (AB.32); PQ.9 ⬜ | B |
| 8 | ~~Promociones por `is_promo`~~ | 57 pares con sugerido, $19: la bandera casi no se usa y **no sirve** para separar promociones | descartado |

### 15.4 La auditoría de la mañana, revisada

- **Corregido:** «$20.9 M de traspasos parados». No es dinero detenido: es el plan paralelo de
  §15.3 #6. El costo es que la sucursal ve «Compras lo planeó» y eso no va a pasar, y Pedido no sabe
  qué parte del plan se ejecutó.
- **Se sostiene:** compras a Kepler 23 de 26 esta semana (46 de 91 la anterior); 85 compras
  aprobadas sin documento ($7.31 M, 27 d de promedio) sin revisar una por una.
- **Se sostiene:** `--warn-fg` como color de texto en ~8 reglas de `compras-pedido-real.component.ts`
  (incluido el verbo de la acción en `.pr-acc-haz`): **2.15:1** sobre blanco y **1.93:1** sobre el
  fondo ámbar (controles 21.00 y 4.48). `--warn-soft-fg` da 7.09.
- **Se sostiene:** Pedido sin `LoadState` (deuda declarada de `check:pantalla`), 68 `title=`, 0 `aria-live`.
- **Se sostiene:** PQ.31–PQ.40 están en commits pero no en el tracker ni en esta bitácora.
- **NO MEDIDO hoy:** la pantalla viva, la latencia de `workbook` y el uso por pestaña (lectura de
  logs de la API bloqueada). Las cifras de §1 son del 23-oct.

### 15.5 Instrumentos que fallaron hoy (y por qué no se citan)

| Instrumento | Qué dijo | Por qué se tiró |
|---|---|---|
| Universo de temporada: «el año pasado cayó >70 % el mes siguiente» o «80 % de su venta en 30 d, sin año anterior» | 186 productos, ~$1.09 M | mezclaba promociones y lanzamientos (Trident, Bimbo, Barcel) y un renglón de 13,929 «cajas» |
| Sugerido aproximado (demanda × factor × 21/30 d − existencia − tránsito) | sirve para el control de 39025 | sin cobertura por proveedor ni cumplimiento: sólo sirve como orden de magnitud. ⛔ **Corregido el mismo día:** aquí se escribió que `17499 BOLSA ROLLO NATURAL` era un error de unidad que Pedido retiene. **Falso las dos veces**: `workbook` convierte el veredicto vacío en `'sin_dato'` (pasa `RUNG_OK`), y la unidad es correcta ($44 por rollo contra $34.48 de costo). Es **una sola venta de 19,899 rollos por $875,556 el 16-oct** que el motor proyecta como diaria (§17 C-3) |
| Duplicados agrupando por la cabecera | 631 grupos | se repitió con el destino de cada renglón: 0 renglones con destino distinto a la cabecera; la cifra se sostuvo (640) |
| `ab25-mesa-vs-pedido.js` | tabla por almacén | reproduce el texto del motor del 13-oct |

---

## 16. Propuesta (2026-11-04) — temporada, una sola falta y días agotados

**Estado: D25–D28 ✅ firmadas por el PM el 2026-11-04** (las cuatro recomendaciones). No abre fase: el tablero marca **7 🔨 contra un cupo de 4**, así que
esto entra como items de PQ y se hace **junto con D17 de AB** (el motor sale del ODS), que es dueño
del mismo código. ⛔ Nada de esto se escribe en `import-replenishment-plan.js` ni en
`import-demand-clean.js` (regla 1 + D17): va en las vistas del ODS que D17 tiene que crear.

### 16.1 Por qué así

Los tres problemas viven en **las mismas dos entradas del motor** —la demanda diaria y el factor de
temporada— y las dos están por mudarse del importer al ODS. Arreglarlos antes de la mudanza es
hacerlo dos veces; mudarse sin arreglarlos es copiar el defecto a la vista nueva. Y ninguno tiene
todavía su **árbitro**: el de temporada es la venta real que siguió a cada temporada de 2025; el de
días agotados, la existencia de Kepler día por día; el de la falta única, la misma consulta corrida
contra las dos pantallas. **Primero se miden (C0), después se cambia el número (C1).**

### 16.2 Los items, en orden

| Orden | Item | Capa | Árbitro / criterio | Dinero · Esfuerzo · Prioridad |
|---|---|---|---|---|
| 1 | **PQ.41 — Backtest del factor de temporada contra lo que pasó en 2025.** Con la historia hasta el 4-nov-2025, ¿qué factor habría dado el índice de hoy para el mes siguiente, y qué se vendió de verdad? Por SKU, en las transiciones oct→nov y dic→ene (Día de Muertos y Navidad/Reyes). Sale el universo de temporada (el que §15.5 no pudo medir) y cuánto se habría pedido de más | C0 | venta real del mes siguiente en `sales_daily` 2025; control: 39025 debe salir como «sólo octubre» | NO MEDIDO (eso mide el item) · S · **2** (sube a 1 si Navidad pasa de $1 M) |
| 2 | **PQ.42 — ¿La ausencia en la foto de existencia es un agotado?** Para una muestra de pares sin foto, la existencia de Kepler (kardex) ese día. Si se confirma, la demanda de productos A/B se divide entre **días con existencia**, no entre días de la ventana | C0 | existencia diaria de Kepler; control: un par con existencia continua debe dar 0 días agotados | ~$2.8 M en 21 d, **PLAUSIBLE** · S · **1** si se confirma |
| 3 | **PQ.43 — Paridad mesa vs Pedido con la consulta real de hoy.** Rehacer `ab25` sobre el código vigente: por almacén × producto, cuántos renglones dan distinta falta y por cuánto, y qué columna de §15.2 explica cada diferencia | C0 | las dos consultas reales de los servicios, en sólo lectura | NO MEDIDO · S · **1** (es una cifra con la que se decide compra) |
| 4 | **PQ.44 — Una sola función de falta en `libs/`** (cobertura, cumplimiento, en camino, plan de Compras) que usan la mesa, «Mi pedido» y `/compras/pedido`, con antes/después por almacén. Depende de D25–D27 | C1 | PQ.43 da 0 diferencias no explicadas | según PQ.43 · M · — |
| 5 | **PQ.45 — Temporada y días agotados en la vista de demanda del ODS** (la de D17): meses en cero cuentan, el piso de 0.5 deja de aplicar al SKU con evidencia propia, estado «fin de temporada» y demanda sobre días con existencia. Commit propio con antes/después; optimizar va aparte | C1 | el backtest de PQ.41 mejora y PQ.42 confirmado | según PQ.41/42 · M–L · — |
| 6 | **PQ.46 — La pantalla dice por qué pide 0** en las dos pantallas: «Fin de temporada: vendió 4 cajas en octubre; el año pasado en noviembre, 0» y «Pedido sobre 18 días con existencia de 29». Se sigue pudiendo pedir a mano | C3 | skill `diseno` §0b, antes y después | — · S · — |

### 16.3 Decisiones a firmar

| # | Decisión | Opciones | Recomendación |
|---|---|---|---|
| D25 | Cobertura | (a) la que elija el comprador, igual para todo almacén (hoy Pedido) · (b) una por almacén (hoy la mesa: 21 d en 02–07, 30 el resto) | ✅ **Firmada (b), PM 2026-11-04.** Como base en las dos; Pedido puede cambiarla, y entonces lo dice: «calculado con 30 días; la sucursal ve 21» |
| D26 | Ajuste por cumplimiento del proveedor | (a) en las dos · (b) en ninguna · (c) sólo en lo que se pide al proveedor | ✅ **Firmada (c), PM 2026-11-04**: un traspaso de la matriz no depende de lo que surta el proveedor |
| D27 | Fin de temporada | (a) el motor sugiere 0 y se puede pedir a mano · (b) candado | ✅ **Firmada (a), PM 2026-11-04**: el comprador puede saber de una reposición o de una venta especial; el candado lo saca del sistema |
| D28 | Traspasos de la Suite (plan paralelo, 640 repetidos) | (a) encender la escritura de traspasos (PQ.19, canario desde 01) · (b) dejar de generarlos mientras esté apagada · (c) contarlos como «ya viene» | ✅ **Firmada (a), PM 2026-11-04**. Es lo único que cierra el lazo; (c) haría que el motor pida de menos si nadie ejecuta el plan. Encender es secreto en `md`: **lo decide y lo hace Edgar** |

### 16.4 Qué NO incluye

- Feriados móviles (§15.3 #4): con un año de historia no hay con qué medirlos; queda como deuda con
  nombre hasta tener dos cuaresmas.
- Tiempo de entrega capturado (PQ.3) y productos nunca comprados (§15.3 #3): siguen en sus items.
- Lo que sobró de la temporada (§15.3 #5): va a Sobrante, no al motor.
- La regla de temporalidad de AB §4 (clasificación ±50 % con vigencia): se retoma después de
  PQ.41, que dice si hace falta además del factor.

### 16.5 PQ.42 — resultado: el día sin foto SÍ es un agotado (2026-11-04)

**Cómo se toma la foto** (`stock-snapshot.service.ts`, AB.0b): a las **23:50**, guarda todo renglón
con existencia distinta de cero —también los negativos— y la cobertura por almacén aparte. La
ausencia de un par en un almacén cubierto es **cero exacto** al cierre del día.

**Árbitro: la venta del día siguiente.** Pares A/B que vendieron en los últimos 30 días y tuvieron
existencia al menos una noche; cada día se clasifica por la foto de la noche anterior:

| Clase | Noche anterior | Días-par | Días con venta |
|---|---|---:|---:|
| A | con existencia | 113,663 | **65.5 %** |
| A | sin existencia | 13,102 | **16.3 %** |
| B | con existencia | 141,277 | **38.1 %** |
| B | sin existencia | 22,127 | **6.9 %** |

Un día que arranca sin existencia vende **4 veces menos** (A) y **5 veces menos** (B): la foto en
cero es un agotado real. El 16 % que sí vende se explica por mercancía que entra durante el día.
⚠️ Ese primer corte, sin restringir a pares que venden, daba 1.1 % contra 61 %: inflaba la diferencia
con pares que nunca venden. Se tiró.

**La venta que el motor no ve.** Sólo pares con 7 o más días sin existencia y 10 o más con
existencia (cota conservadora: deja fuera los agotados crónicos). Venta diaria real = venta en días
con existencia ÷ esos días; la del motor = venta total ÷ días de la ventana:

| Clase | Pares con venta | Pares afectados | Venta no vista en 21 d (a precio) | Venta que el motor ve en 21 d |
|---|---:|---:|---:|---:|
| A | 4,726 | 603 | **$1.62 M** | $32.97 M |
| B | 6,094 | 997 | **$0.76 M** | $6.70 M |

**Veredicto: CONFIRMADO** que el motor subestima la demanda de lo que se agota (~$2.38 M de venta
en 21 días, ~6 % de lo que ve). Tres cosas que esta cifra **no** es:

1. **No es venta perdida.** Parte del cliente compra otro producto; la sustitución está NO MEDIDA.
2. **Probablemente se queda corta.** La foto lee `commercial.stock`, la copia que ADR-055 retiró del
   motor: hoy tiene existencia en **3,458 pares en que `v_erp_stock_on_hand` dice cero** (y lo
   contrario en 205). Días sin existencia que la copia ve con existencia no entran en esta cuenta.
3. **No es independiente del todo.** Venta y existencia salen de Kepler; es la mejor evidencia
   disponible, no un testigo externo.

⭐ **Hallazgo aparte para AB:** la foto diaria (el reloj de AB.0b) y el motor leen **dos
existencias distintas**. Cuando D17 mude el motor al ODS, la foto tiene que leer la misma vista.

---

## 17. Plan de correcciones — todo lo encontrado el 2026-11-04, con su item

PM: *«documentemos todos los hallazgos o errores y hagámoslos en el plan como correcciones»*. Cada
hallazgo de §15 y §16 tiene aquí **una corrección con item, capa, árbitro y prioridad** (dinero ×
esfuerzo, `pm/criterios.md` §1). Las que ya tenían item lo reusan; ninguna se queda en la prosa.
⛔ Las correcciones al motor van en las vistas del ODS de **D17**, nunca en los importers; cada una
que cambie un número lleva su commit con antes/después.

### 17.1 Hallazgo nuevo: la venta extraordinaria única (C-3)

`17499 BOLSA ROLLO NATURAL`, Padre Hidalgo: **una sola venta de 19,899 rollos por $875,556 el
16-oct** ($44 el rollo, costo $34.48). Es su única venta en 30 días; el motor la promedia como
663 rollos diarios, Pedido sugeriría ~19,900 rollos (~$0.69 M con 30 d) y la política quedó en
mínimo 34,002 / máximo 47,933 rollos. Ni la temporada ni el fin de pico la frenan: el freno exige
venta regular. **Medido en toda la red** (pares cuyo mejor día es 50 % o más de su venta de 30 d,
con 3+ días de venta y $5 mil o más ese día): **76 pares, 74 productos, $1.05 M en un solo día**;
su sugerido aproximado a 30 d baja de ~$327 mil a ~$55 mil sin ese día. Aproximado: sin cobertura
por proveedor ni cumplimiento.

### 17.2 Las correcciones

**A · Dato y motor común (Pedido + Autoabasto)**

| C | Hallazgo | Corrección | Item | Capa | Árbitro / criterio | Dinero · Esf. · Prio. |
|---|---|---|---|---|---|---|
| C-1 | Temporada: meses en cero fuera del índice, piso 0.5, fin de pico que excluye la temporada, un año de historia (§15.1) | Backtest contra 2025; después, en la vista de demanda del ODS: los meses en cero cuentan, sin piso para el SKU con evidencia propia, estado «fin de temporada» que sugiere 0 (D27) | PQ.41 → PQ.45 | C0 → C1 | venta real del mes siguiente en 2025; 39025 sale «sólo octubre» | NO MEDIDO · S+M · **2** |
| C-2 | Días agotados cuentan como venta cero (§16.5, confirmado) | La demanda se mide sobre días con existencia en la foto | ✅ PQ.42 → PQ.45 | C1 | la venta del día siguiente (65.5 % contra 16.3 % en A) | ~$2.38 M de venta en 21 d · M · **1** |
| C-3 | Venta extraordinaria única proyectada como diaria (§17.1) | Medir con el documento de Kepler de cada día atípico (cliente, folio) qué es mayoreo o pedido especial; después la vista de demanda lo separa de la venta recurrente y la pantalla lo dice: «Incluye una venta única de 19,899 el 16-oct; no se repite en el pedido» | **PQ.47** | C0 → C1 | el documento de venta de Kepler; control: 17499 sale como venta única | ~$0.96 M sugeridos de más · S+M · **2** |
| C-4 | Pedido y la mesa: una fuente, tres fórmulas (§15.2) | Paridad con las consultas vigentes; una sola función de falta en `libs/` con D25 (cobertura por almacén) y D26 (cumplimiento sólo al proveedor) | PQ.43 → PQ.44 | C0 → C1 | 0 diferencias sin explicar por almacén × producto | NO MEDIDO, decide compra · S+M · **1** |
| C-5 | La foto diaria lee la copia `commercial.stock` (3,458 pares con existencia fantasma) y el motor `v_erp_stock_on_hand` (§16.5) | La foto lee la misma vista que el motor, con antes/después de AB.0b. Los otros 39 archivos de `libs/` que nombran `commercial.stock` quedan **fuera**: proyecto aparte, como catálogo en D17 | **PQ.48** (con AB/D17) | C0 | cobertura y conteo de agotados antes/después | Medio, NO MEDIDO · M · **3** |
| C-6 | Se sugieren 191 productos sin compra registrada en ningún almacén (§15.3 #3) | Clasificarlos: proveedor que surte directo en tienda, alta nueva, venta única (17499) u otro; cada clase con su trato | **PQ.49** | C0 | `kdm1` de compras por proveedor; control: 17499 cae en «venta única» | ~$0.1 M sin 17499 · S · **3** |
| C-7 | El tiempo de entrega nadie lo captura (0 de 2,349 canales) | Ya tiene item | PQ.3 | C2+C3 | — | — |
| C-8 | Feriados móviles en el mes equivocado (§15.3 #4) | **Deuda con nombre**: no se corrige con un año de historia; se retoma con dos cuaresmas | PQ.D1 | — | — | — |
| C-9 | El plan del motor sigue saliendo de un importer | Depende de D17 de AB; A-1 a A-5 se construyen sobre esas vistas | AB/D17 | C0/C1 | — | — |

**B · Flujo: lo aprobado, lo repetido, lo cancelado**

| C | Hallazgo | Corrección | Item | Capa | Árbitro / criterio | Dinero · Esf. · Prio. |
|---|---|---|---|---|---|---|
| C-10 | Traspasos de la Suite: plan paralelo, 1,104 aprobados ($20.93 M), 0 en Kepler (§15.3 #6) | **D28**: encender la escritura de traspasos con canario desde 01 | PQ.19 (lo hace **Edgar**: secreto en `md`) | — | el primer traspaso con folio de Kepler y su recepción | Alto · S · **1** |
| C-11 | Los aprobados viejos que nadie ejecutó siguen «vivos» | Cerrar con motivo «no se ejecutó» los aprobados de más de `VENTANA_YA_PEDIDO_DIAS` sin documento (la mesa ya no los muestra pasado ese plazo). **Escribe en prod: lo autoriza Edgar** (D29) | **PQ.50** | C2 | prueba contra base real; conteo antes/después | Medio · S · **2** |
| C-12 | Traspasos repetidos: 640 grupos, 468 en días distintos, $5.95 M | Se cierra con C-10 + C-4 (la falta resta lo que ya viene) y el aviso de PQ.8 | PQ.8 · PQ.44 | — | re-medir con la consulta de §15.3 #6 | — |
| C-13 | 85 compras aprobadas sin documento en Kepler ($7.31 M, 27 d de promedio) | Revisarlas una por una: reenviar, ligar a una OC que ya exista en Kepler, o cancelar con motivo | **PQ.51** | C0 | cada una contra `kdm1` de su sucursal | Alto · S · **1** |
| C-14 | Cancelar no pide motivo (107 en 14 d, 0 con motivo) | Ya tiene item | PQ.9 | C2+C3 | — | — |

**C · La pantalla `/compras/pedido`** (skill `diseno` obligatoria)

| C | Hallazgo | Corrección | Item | Capa | Criterio | Prio. |
|---|---|---|---|---|---|---|
| C-15 | `--warn-fg` como texto en ~8 reglas (2.15:1 sobre blanco, 1.93:1 sobre ámbar) | Texto a `--warn-soft-fg` (7.09:1); `--warn-fg` sólo en bordes, iconos y rellenos | **PQ.52** | C3 | contraste recalculado con sus controles | **3** |
| C-16 | Sin `LoadState`; 0 `aria-live` | Matriz de estados (cargando · vacío · error de red) con `LoadState`, y una región viva que anuncie sólo el resultado de generar | **PQ.53** | C3 | `check:pantalla -- compras` sin la deuda §2 | **4** |
| C-17 | 68 definiciones dentro de `title=` | Las fijas al diccionario de ayuda (regla P) | **PQ.54** | C3 | `check:pantalla` sin el aviso TBL | **4** |
| C-18 | Una pantalla con cinco vistas en 6,128 líneas; el uso por pestaña es del 23-oct | Re-medir el uso de Ciclo, Sobrante, Stock muerto y Flujo; si sigue bajo, proponer el corte (Sobrante dentro de la fila, PQ.UI.11) | **PQ.55** | C0 | uso por endpoint en 30 d | **3** |
| C-19 | Nada de hoy se vio en la pantalla viva; las 🔴 PQ.UI.1–5 sin revisar | Auditoría nivel A con sesión de prueba | **PQ.56** | C3 | skill `auditoria-diseno` §5 completo | **3** |
| C-20 | `workbook` de 1.7 a 2 s el 23-oct (no re-medido) | Ya tiene item | PQ.10 | C0+C2 | — | — |

**D · Registro e instrumentos**

| C | Hallazgo | Corrección | Item | Prio. |
|---|---|---|---|---|
| C-21 | PQ.31–PQ.40 en commits sin renglón en el tracker ni en esta bitácora | Registrarlos con su commit y estado | **PQ.57** | **3** |
| C-22 | `ab25-mesa-vs-pedido.js` reproduce el motor del 13-oct | Se reemplaza dentro de PQ.43 | PQ.43 | — |
| C-23 | `is_promo` casi vacío (57 pares, $19): no separa promociones | Registrar como hallazgo; no hay corrección mientras no exista dueño del dato | — | — |
| C-24 | Errores de esta sesión, ya corregidos: «$20.9 M parados» (§15.4) y «17499 es un error de unidad que Pedido retiene» (§15.5) | Corregidos en el texto, con la razón | — | — |

### 17.3 Decisión nueva

| # | Decisión | Opciones | Recomendación |
|---|---|---|---|
| D29 | Los traspasos aprobados que nadie ejecutó (C-11) | (a) cerrarlos con motivo «no se ejecutó» pasado el plazo · (b) dejarlos como están · (c) esperar a que D28 esté encendida | ✅ **Firmada (a), PM 2026-11-04**, una vez y después de forma automática: la mesa ya no los muestra pasado el plazo y en Pedido sólo estorban. Escribe en prod: antes de correr, prueba contra base real con el mismo camino (regla 13) y fuera de horario hábil |

### 17.4 El orden

1. **Prioridad 1:** C-10 (Edgar enciende el canario) · C-13 (PQ.51) · C-4 C0 (PQ.43) · C-2 se
   construye en cuanto exista la vista de D17.
2. **Prioridad 2:** C-3 C0 (PQ.47) · C-1 C0 (PQ.41) · C-11 (PQ.50, con D29).
3. **Prioridad 3–4:** pantalla (PQ.52–PQ.56), C-5, C-6, registro (PQ.57).

Las C0 (PQ.41, PQ.43, PQ.47, PQ.49, PQ.51, PQ.55) son de sólo lectura y no esperan a nadie.

### 17.5 Avance del 2026-11-04 (orden invertido)

| Item | Estado | Qué quedó |
|---|---|---|
| PQ.52 | 🧪 `1fc415adf` | 12 reglas de texto ámbar a `--warn-soft-fg` (7.09:1). Eran 12, no ~8: el grep de la auditoría no veía `var(--warn-fg, var(--text-muted))` |
| PQ.53 | 🧪 `d41173e6e` | Los 4 errores de carga son `LoadState` (`role="alert"` + Reintentar, también en «órdenes en camino», que no lo tenía). Deuda §2 quitada, con prueba negativa. Tipos de plantilla con control (`check-template-types.js`: `metodoQueNoExiste` → TS2339; limpio, verde). 112/112 vitest. ⛔ **Corrección:** la pantalla ya tenía 9 `role="status"` y 4 `role="alert"`; el «0 aria-live» contaba sólo el atributo. ⚠️ `npx ngc --noEmit` a secas **no** tipa plantillas: el control pasó en verde y se descartó |
| PQ.54 | ⚠️ | `context-help.dictionary.ts` tiene cambios de otra sesión; un commit se los llevaría. Espera a que esa sesión haga commit |
| PQ.57 | ✅ | PQ.31–PQ.40 en el tracker: los diez commits están en el build de prod `7db184b1f`, y `mv_kepler_bought_rung` (PQ.40) existe con 5,954 filas |
| PQ.49 | 🧪 C0 | Tabla de abajo. ⛔ **Corrección:** `last_purchase` sale de `analytics.purchase_velocity`, ventana de **90 días** (6-ago a 3-nov): son «sin compra en 90 d», no «nunca comprados» |
| PQ.48 | C0 hecho, C1 en espera | Diferencia medida hoy: 3,458 pares con existencia en la copia y cero en la vista, 205 al revés. Cambiar la fuente de la foto es un cron que **escribe** y es de AB: va con su dueño, con prueba contra base real, junto con D17 |
| PQ.55 · PQ.56 | ⚠️ | Esperan la lectura de logs de la API (bloqueada a la sesión) y una sesión de prueba en la pantalla |

**PQ.49 — los 191 productos sugeridos sin compra en 90 días** (cada uno en la primera clase que cumple):

| Clase | Productos | Pares | Sugerido aprox. |
|---|---:|---:|---:|
| Venta única: un día es 50 % o más de su venta del mes (C-3, PQ.47) | 28 | 31 | ~$528 mil |
| Alta nueva: primera venta hace menos de 120 días | 13 | 20 | ~$26 mil |
| Su proveedor no tiene ninguna compra en 90 días | 11 | 21 | ~$10 mil |
| Su proveedor sí compra, este producto no (vende de existencia de más de 90 días) | 139 | 239 | ~$220 mil |

Lectura: lo que cuesta es la venta única, y ya tiene su corrección (PQ.47). Las 139 no son un
error por sí mismas: pedir lo que se vende es correcto aunque no se haya comprado en 90 días. Si
el proveedor lo dejó de surtir es otro hecho, **NO MEDIDO** (necesita el catálogo del proveedor).

### 17.6 PQ.47 y PQ.41 — resultados (2026-11-04, prioridad 2)

**PQ.47 — la venta única, contra el documento de Kepler.** Para cada par cuyo mejor día de los
últimos 30 es 50 % o más de su venta del mes ($5 mil o más ese día): el cliente que más compró ese
día (`kdm2` → `kdm1.c10` → `kdud`, ventas `U-D-8` y `U-D-10`) y en cuántos meses previos le había
comprado ese mismo producto. **Control:** 17499 → cliente BOLSAS DE LOS ALTOS (que también es
proveedor), facturas `U-D-8` 0001734 y 0001735, 0 meses previos ✓.

| Quién compró el día dominante | Pares | Venta de ese día | Venta de 30 d |
|---|---:|---:|---:|
| Un cliente que no le había comprado ese producto en los meses previos | 49 | $1.62 M | $1.89 M |
| Mostrador «CONTADO» (sin cliente) | 18 | $0.23 M | $0.33 M |
| Un cliente que se lo compró 1–2 meses antes | 12 | $0.11 M | $0.16 M |
| Un cliente recurrente (3 meses o más) | 4 | $0.05 M | $0.07 M |

⚠️ La historia de ventas de Kepler en el ODS arranca en enero de 2026 en casi todas las
sucursales: «no le había comprado» no distingue una venta única de una compra anual (varios son
navideños comprados en octubre). ⚠️ Las consultas por par se corren de una en una; juntas pasan de
60 s (índices parciales de `kdm2`).

**PQ.41 — el factor de temporada contra lo que se vendió.** El texto **real** de `seasonCte`, con
la fecha movida. Grano: producto en la red, venta en pesos de 30 días, productos con $1,000 o más
en la ventana anterior. **Control:** el pronóstico ingenuo (factor 1 = «el mes que viene igual al
pasado»).

| Fecha de la prueba | Error del motor | Error ingenuo | Año pasado tal cual | Motor contra ingenuo |
|---|---:|---:|---:|---:|
| 2025-11-04 (sin año anterior) | $22.03 M | $21.80 M | — | 1 % **peor** |
| 2026-08-05 | $15.55 M | $15.65 M | $21.55 M | 0.6 % mejor |
| 2026-10-05 | $20.45 M | $21.67 M | $27.86 M | 5.6 % mejor |

1. **El factor actual casi no le gana a no tener factor** (de −1 % a +6 %). En los productos que
   se desplomaron al mes siguiente (508 a 682 por fecha), el motor pronosticó de más entre $2.8 M y
   $3.5 M de venta; en los que subieron, se quedó corto entre $6.8 M y $13.9 M.
2. **Copiar el año pasado es peor** (+38 % de error): con un año, a nivel producto, es ruido. No es
   el arreglo.
3. **Regla dirigida:** el año pasado sólo donde ese año el producto se desplomó (siguiente < 30 %
   del anterior). En esos productos (96 en agosto, 153 en octubre), **lo pronosticado de más baja
   ~95 %** ($163 mil → $12 mil; $659 mil → $10 mil). A cambio, el error total sube 2–3 %: parte
   de ellos este año sí se vendió y se quedan cortos.

**Lo que esto no es:** venta a precio, no cajas pedidas; grano de red, no de sucursal; dos fechas
con un año de historia.

### 17.7 Decisiones nuevas (de PQ.41 y PQ.47)

| # | Decisión | Opciones | Recomendación |
|---|---|---|---|
| D30 | En producto de temporada, ¿qué error cuesta más? | (a) pedir de más: queda mercancía parada hasta el año siguiente · (b) pedir de menos: se pierde venta · (c) igual | ✅ **Firmada (a), PM 2026-11-04**: aplicar la regla dirigida (§17.6 punto 3) sólo donde el año pasado se desplomó, con el aviso «Fin de temporada: el año pasado en noviembre vendió X» y la cantidad editable (D27) |
| D31 | La venta de un cliente que no compraba ese producto | (a) sale del promedio y la pantalla la nombra («Incluye una venta única a BOLSAS DE LOS ALTOS el 16-oct») · (b) se queda · (c) sólo se avisa | ✅ **Firmada, PM 2026-11-04: (a)** cuando sea 50 % o más del mes; **(c)** para mostrador «CONTADO», que no tiene cliente con quién comprobarlo |

### 17.8 PQ.51 — las 85 compras aprobadas sin documento, una por una (2026-11-04, prioridad 1)

Cada una contra Kepler: requisición `X-A-30` u OC `X-A-35` del **mismo proveedor** (clave, o
nombre exacto en `kdxd`), en la **misma sucursal**, capturada entre 2 días antes y 30 días después,
y cuántos de sus productos coinciden. Detalle por folio en el scratchpad de la sesión
(`pq51_detalle.json`).

| Lo que hay en Kepler | Requisiciones | Monto |
|---|---:|---:|
| Ya lo tiene: un documento del proveedor con 80 % o más de sus productos | 38 | $4.08 M |
| Uno parecido: algunos productos coinciden | 5 | $2.30 M |
| Del proveedor, pero con otros productos | 3 | $0.02 M |
| Ningún documento de ese proveedor en 30 días | 39 | $0.91 M |

**Control:** las 39 «ninguno», buscadas **sin exigir proveedor** (y con entradas `X-A-40`): 4
aparecen con otro proveedor, 35 no tienen nada. El cruce de proveedores funciona.

**Por qué nadie las ligó:** PQ.25 liga sólo requisiciones que **la Suite** escribió en Kepler (las
que traen `kepler_folio`). Éstas son anteriores al envío automático (PQ.26/PQ.27) y se capturaron a
mano en Kepler, así que nada las une. Por revisar a mano, las 8 con coincidencia parcial; dos son
grandes: RQ-2026-00488 (CEDIS, $1.76 M, 19 de 35 productos en la OC 0007136) y RQ-2026-01881.

⛔ **Hallazgo vivo: RQ-2026-01881** (8 Esquinas, 3-nov, $389,926, DISTRIBUIDORA DE LA ROSA, 64
productos) no llegó a Kepler: «permiso denegado a la tabla kdxd». **Desde el 29-oct llegaron 63
compras y falló sólo ésta.** El servidor de 8 Esquinas no tiene `GRANT SELECT ON md.kdxd TO
kepler_push`; 02, 04 y 05 **no han intentado ningún envío** desde el 29-oct, así que su permiso está
NO MEDIDO (§14.6 lo dejó sin medir). Es un permiso en el servidor de Kepler: **lo da Edgar** (regla 7).

| # | Decisión | Opciones | Recomendación |
|---|---|---|---|
| D32 | Las 85 compras aprobadas sin documento | (a) una sola limpieza: ligar las 38 a su documento de Kepler, cancelar las 35 sin nada con motivo «no se hizo en Kepler», y dejar las 12 restantes a Compras · (b) dejarlas · (c) cancelar todas | ✅ **Firmada (a), PM 2026-11-04**, con un ajuste que pidió el dato (§17.11): se ligan **23**, no 38 (el 80 % de productos no identificaba el documento), y se cancela sólo lo que ya cumplió 30 días |

Items nuevos (renumerados el mismo día, §17.10): **PQ.67** (Edgar) — el `GRANT` en 8 Esquinas y
medir 02, 04 y 05, antes de que compren ahí · **PQ.68** — la limpieza de D32 · **PQ.69** — que una
requisición escrita a mano en Kepler también se ligue sola (mismo proveedor, sucursal y productos),
para que no vuelva a pasar.

### 17.9 PQ.43 — la mesa contra Pedido, con el código desplegado (2026-11-04, prioridad 1)

**Instrumento:** los dos servicios **de la versión de prod** (`git archive 7db184b1f`, armados con
esbuild), llamados igual que la pantalla —`workbook` de Pedido con la cobertura que declara la mesa
de cada sucursal, y `AutoabastoPedidoService.pedido` de la mesa— contra prod en sólo lectura
(`default_transaction_read_only`, `system_identifier` verificado). Sin backend levantado. Reemplaza
a `ab25-mesa-vs-pedido.js`, que copiaba el texto del motor del 13-oct.

⛔ **Corrección de §15.2:** la mesa no usa 21 días en todas: **30 en Padre Hidalgo, Canindo y
Morelia Abastos**, 21 en las otras cinco.

| | Renglones | Cajas | Monto aprox. |
|---|---:|---:|---:|
| Productos con falta en alguna de las dos (8 sucursales) | 6,014 | | |
| Dan lo mismo (±0.5 caja) | **4,462 (74 %)** | | |
| **Pedido lo pide y la mesa no lo lista** | 670 | 5,351 | $2.97 M |
| Pedido infla por cumplimiento del proveedor (la mesa no) | 603 | 1,943 | $1.26 M |
| La mesa resta un traspaso o pedido en camino; Pedido no | 162 | 617 | $0.25 M |
| Sin explicar | 117 | 2,695 | $0.25 M |

**La diferencia grande es CUÁNDO se pide, no cuánto.** La mesa parte de `criticalStock`: sólo
lista lo que está **en o bajo su punto de reorden**. Pedido pide **todo lo que falte para el
objetivo** (venta × cobertura), aunque esté arriba del reorden. Caso: `70001 LA ROSA MAZAPAN /30`
en Padre Hidalgo, 1,392 piezas contra reorden 800 y objetivo 56 × 30 = 1,682 → Pedido pide 14.5
cajas, la mesa nada. ⚠️ Se descartó primero que fueran productos sin política: 717 de 718 sí la
tienen.

**Se confirma C-3 en las dos pantallas:** `17499 BOLSA ROLLO NATURAL` sale hoy con **19,899 rollos
en Pedido y en la mesa** de Padre Hidalgo (la venta única a BOLSAS DE LOS ALTOS).

| # | Decisión | Opciones | Recomendación |
|---|---|---|---|
| D33 | ¿Cuándo se pide un producto? | (a) al llegar al punto de reorden, hasta el objetivo (la mesa hoy) · (b) siempre que falte para el objetivo (Pedido hoy) · (c) (a) para traspasos y (b) sólo el día que toca el proveedor | ✅ **Firmada (a), PM 2026-11-04** (aplicada en PQ.44, §17.12). En las dos, mientras la agenda de proveedores no tenga fechas confiables (PQ.3; 25 % de canales regulares). Pedir arriba del reorden son pedidos chicos y frecuentes de lo que todavía alcanza; (c) se retoma con la agenda capturada |

Con D25, D26 y D33 firmadas, PQ.44 (una sola función de falta) tiene sus tres reglas; lo «sin
explicar» se revisa con esa función ya escrita.

⭐ **Decisión del PM (2026-11-04): el orden se invierte** — *«empecemos de prioridad 3 y 4 a
prioridad 1»*. Se trabaja PQ.52 → PQ.53 → PQ.54 → PQ.57 → PQ.49 → PQ.48 → PQ.55/PQ.56 (éstas dos
esperan logs y una sesión de prueba) y después las de prioridad 2 y 1. Queda escrito porque va en
contra de la regla dinero × esfuerzo (`pm/criterios.md` §1: la decisión del PM manda y se registra).

### 17.10 PQ.50 — el traspaso aprobado que no salió se cierra solo (2026-11-04, D29)

**Medido en prod (sólo lectura):** 1,152 traspasos aprobados sin documento en Kepler; **867 con
más de 7 días ($17.3 M)**, el más viejo del 29-sep. **Ninguno lo pidió una sucursal.**

**Qué hace** (`traspaso-no-ejecutado.ts`, `b37cea6e4`): cada lectura de la bandeja de Compras
cierra a lo más 200 (los más viejos primero) que estén `approved`, sin `kepler_folio` ni
`oc_folio` y aprobados hace más de `VENTANA_YA_PEDIDO_DIAS`. Quedan `cancelled` con motivo
«No salió a Kepler: Compras lo aprobó el DD-MM-YYYY y en 7 días no salió desde la Suite…» y sin
persona (`rejected_by` NULL). Va en su propia transacción: si falla, no deshace lo que PQ.25/PQ.26
acaban de ligar. Los 867 de hoy se van en 5 lecturas.

- ⛔ **No toca lo que pidió una sucursal**: la mesa le muestra sus canceladas como «RECHAZADA», y
  una que Compras aprobó no fue rechazada. Hoy son 0; si aparecen, se decide aparte.
- ⚠️ **El motivo no dice que el traspaso no ocurrió**, sólo que no salió desde la Suite. Si se hizo
  a mano en Kepler (`U-D-40`), ese documento es el que la mesa resta; ligarlo es PQ.69. Cuántos
  se hicieron a mano: **NO MEDIDO**.
- ⚠️ **Las cuentas de canceladas** (PQ.9: «107 en 14 días, 0 con motivo») suben con estos 867. Se
  separan por `rejected_by IS NULL` y el motivo que empieza con «No salió a Kepler».
- ⚠️ **Cuándo corre:** el primer cierre ocurre con la primera lectura de la bandeja después de
  soltar. D29 pide hacerlo fuera de horario hábil: **soltar después de las 19 h**. Son
  escrituras chicas (200 renglones, 25 ms medidos como SELECT), no un `REFRESH`.

**Prueba de base real** (`test-newdb-traspaso-no-ejecutado.js`, en `run-all-tests.js`):

- (1) **sólo lectura, corrida contra prod**: el módulo cuenta 867 y el testigo, escrito aparte,
  también 867. Placebos: con el reloj diez años atrás da 0; con el reloj un año adelante, 1,152 ≥ 867.
  - **Prueba negativa:** con la ventana cambiada a 1 día da 1,069 contra 867 y la prueba se pone roja.
- (2) **casos que escriben, con ROLLBACK, sólo en una base local (el CI)**: el tope cierra
  primero los más viejos; el motivo lleva la fecha; el cierre queda sin persona y cumple el CHECK
  de motivo.
  - **Negativas:** no cierra el de 6 días, el que tiene folio, el ordenado, el capturado a mano, el
    pedido por una sucursal, una compra ni uno por aprobar.
  - **Desde esta máquina: NO MEDIDO.** No hay base local (Docker apagado); corre en el job
    `pruebas-db` del CI.
- El `UPDATE` no se pudo planear contra prod: el rol de lectura no tiene permiso ni para
  `EXPLAIN UPDATE`. Se corrió su mismo `WHERE` y su motivo como `SELECT`: 200 filas, 25 ms.
- Vitest del motor: 316/316, con una prueba nueva que se puso roja al quitar la llamada. `tsc`:
  0 errores en los archivos tocados (el error de control sí se detectó).

⛔ **Choque de códigos (renumerado):** la §18 (commit `fb95bcc85`, otra sesión) numeró
**PQ.58–PQ.66** antes de que §17.8 usara PQ.58–PQ.60 y el freno saliera como «PQ.61». Ganan los
de §18. Lo de esta sesión pasa a:

| Antes | Ahora | Qué es |
|---|---|---|
| PQ.58 | **PQ.67** | El `GRANT` de `kdxd` en 8 Esquinas (dado) y medir 02, 04 y 05 |
| PQ.59 | **PQ.68** | La limpieza de D32 |
| PQ.60 | **PQ.69** | Ligar sola la requisición escrita a mano en Kepler |
| PQ.61 | **PQ.70** | El freno contra el duplicado en el primer envío |

PQ.70 = los commits `84de4bcf2` y `2c603da2a`, que dicen «PQ.61»; el código ya dice `[PQ.70]`.

### 17.11 D32 — ligar por importe y cerrar lo que no se hizo (2026-11-04, PQ.69 + PQ.68)

**Lo que cambió al re-medir:** §17.8 decía que 38 «ya estaban» en Kepler: un documento del
proveedor con 80 % o más de los productos. **El placebo lo tumbó.** Buscando lo mismo entre 30 y
90 días antes, 21 de esas 38 también tenían un documento así, y 18 tenían más de uno en la ventana.
Esos proveedores surten lo mismo una y otra vez: el 80 % de productos no dice CUÁL documento es.

**El árbitro que sí identifica es el importe de cada renglón** (`kdm2.c13`). La cantidad va en
otra unidad, pero el importe es el mismo: cuadró al centavo 37 de 37 el 2026-10-16.
- Con todos los renglones dentro de ±0.5 %, **25 casan con un solo documento**.
- En el placebo casan 2, ambas de un solo renglón: un pedido idéntico que se repite.
- La regla pide un solo documento que case en toda la ventana de 90 días y una OC no compartida.
  Con ella **quedan 23 ($2.98 M)**.
- 00749 y 00750 comparten la OC 0007112 (Compras juntó dos requisiciones en una): eso lo resuelve
  una persona.

**Qué hace** (`compra-sin-documento.ts`, `833934781`), fuera de la petición, a lo más cada 30 min:

| Regla | Item | Hoy | Alcance |
|---|---|---:|---|
| Ligar a su OC (`ordered` + `oc_folio`; PQ.26 la marca recibida cuando Kepler cierra la OC) | PQ.69 | 23 | **Permanente**: también las que se capturen a mano después |
| Cerrar con motivo «No se hizo en Kepler…», sin persona | PQ.68 | 16 ($0.35 M) | **Sólo el universo de D32**: aprobadas antes del 27-oct, sin error de envío, 30 días cumplidos y nada en Kepler (ni del proveedor, ni de nadie con sus productos) |

- Unas 20 más, de principios de octubre, **se cerrarán solas** al cumplir sus 30 días si nada
  aparece en Kepler.
- **Quedan a Compras:**
  - las 15 de las 38 que no se pudieron identificar (entre ellas RQ-2026-00488, CEDIS, $1.76 M);
  - las 8 parciales;
  - las que tienen documentos de otro proveedor;
  - las aprobadas después del 27-oct.
- ⛔ **RQ-2026-01391** (Yurécuaro, $245,571, aprobada el 24-oct) falló con «Kepler no conoce al
  proveedor», y **el reintento automático no la toma** (sólo reintenta desde el 27-oct). Le toca a
  **Compras**.

**Rendimiento:** de 1.8 s + 6.4 s a **256 ms + 149 ms**. El nombre del proveedor se resolvía en
`kdxd` por cada renglón de `kdm1` (4.2 s), y la búsqueda por producto entraba por fecha (242 mil
renglones) en vez de por el índice de SKU.

**Prueba de base** (`test-newdb-compra-sin-documento.js`):

- (1) **Sólo lectura, contra prod.**
  - 23/23 ligas verificadas aparte, renglón por renglón. La tolerancia está fija en la prueba, no
    importada del módulo: importada, sería un espejo.
  - 16/16 cancelables sin renglones de Kepler con sus productos.
  - Placebo: con el reloj diez años atrás, 0.
  - **Negativa:** sin exigir todos los renglones salen 13 ligas, 1 falla y la prueba se pone roja.
  - **Mutante vivo, declarado:** con 30 % de tolerancia, la regla de ambigüedad deja 22 ligas y
    ninguna mala. Ése lo caza la mitad sintética.
- (2) **Casos que escriben, con ROLLBACK, en el CI** (sucursal sintética `96`): liga y cancela, con
  ocho negativas. **Desde aquí: NO MEDIDO.**
- Vitest 318/318, con una prueba nueva que se puso roja al quitar la llamada. `tsc` limpio, con el
  control detectado.

### 17.12 PQ.44, primer paso — Pedido pide al llegar al reorden, como la mesa (2026-11-04, D33)

Las dos pantallas leen la misma existencia (`replenishment_plan.stock_pz`) y el mismo reorden
(`reorder_policy.reorder_point`). La regla «en o bajo el reorden» ahora vive una vez, en
`faltante.ts` (`0aeec91fc`):
- la mesa la usa en `criticalStock`;
- Pedido la usa en `workbook` y en su detalle por producto.

Arriba del reorden, la celda de Pedido sale en 0 aunque falte para el objetivo. Sin política de
reorden, Pedido no frena: no hay contra qué comparar.

**Antes y después**, con los dos servicios del árbol armados con esbuild (sin backend), contra prod
en sólo lectura y con la cobertura de la mesa en cada sucursal:

| | Antes | Después |
|---|---:|---:|
| «Pedido lo pide y la mesa no» | 681 renglones ($2.9 M) | **2** ($2 mil) |
| Cumplimiento del proveedor (D26) | 606 | 606 |
| La mesa resta lo que viene en camino | 153 | 153 |
| La mesa pide y Pedido no | 47 | 47 |
| Sin explicar | 72 | 72 |
| Pedido, 8 sucursales | 106,277 cajas · $24.4 M | **100,722 cajas · $21.4 M** |

Las otras causas no se movieron un renglón: el cambio tocó sólo lo que debía. Los 2 que quedan no se
revisaron uno por uno (**NO MEDIDO**); lo esperado son productos sin política.

**Pruebas:**
- `faltante.spec.ts` comprueba que las dos pantallas usan el primitivo. Al quitárselo a Pedido, se
  pone roja.
- Vitest 323/323. `tsc` limpio, con el control detectado.
- La latencia de `workbook` no cambió: ~1.9 s, ya arriba de 500 ms antes de esto (deuda aparte).

### 17.13 PQ.44, segundo y tercer paso — D26 y D25 (2026-11-04)

**D26 — el inflado por cumplimiento, sólo en lo que se compra al proveedor** (`95f1b7d3c`).
- El canal sale de `commercial.replenishment_channel`: cómo llegó de verdad la mercancía de ese
  proveedor a ese almacén. Lo escribe un importer que ya existía y que el motor ya consumía; no es
  uno nuevo.
- **Contrastado contra Kepler:** de 1,356 pares «traspaso», 40 (3 %) tienen entradas de compra
  `X-A-40` de ese proveedor en 90 días. «Compra» se confirma menos (425 de 993), en parte porque
  CEDIS y Morelia Madero compran por Wincaja, que no está en `kdm1`. Por eso la regla se apoya en la
  etiqueta confiable: **en traspaso no se infla**. Sin canal, se infla como antes.
- La celda dice si llegó por traspaso (`trf`). La explicación del inflado ya no afirma «va
  multiplicado» donde no se aplicó.
- **Resultado:** «Pedido infla por cumplimiento» pasó de 606 a 280 renglones, y Pedido en 8
  sucursales de $21.4 M a $20.8 M. «Sin explicar» subió de 72 a 81 y «en camino» de 153 a 169: sin
  el inflado, algunas diferencias cambiaron de clase.

**D25 — la cobertura de cada sucursal como base** (`d9660bdd4`).
- **Medido antes:** con 30 días fijos, las cinco sucursales de 21 días sugerían **$1.97 M de más**.
- `workbook` y su Excel aceptan `coverage_mode=sucursal`, con la misma expresión de `libs/contracts`
  que usa la mesa. La demanda se multiplica por la cobertura de cada almacén **antes** de sumar, así
  la columna de toda la red también cuadra.
- **Control:** en las 8 sucursales, el modo «cada sucursal» da exactamente lo mismo que fijar a mano
  la cobertura de la mesa: **0 diferencias en 25,296 renglones**. El modo fijo tampoco cambió: 0
  diferencias corrido inmediatamente después de la versión anterior. Las 259 de una corrida previa
  eran el dato moviéndose entre corridas.
- **En la red:** $20.71 M con la cobertura de cada sucursal, contra $22.68 M con 30 días fijos.
- **Pantalla.** Las cinco preguntas, contestadas antes de tocarla:

  | # | Pregunta | Respuesta |
  |---|---|---|
  | 1 | Qué ve primero | La cobertura con la que sale el pedido; al abrir, «Cada sucursal» |
  | 2 | Qué no | La lista de días por sucursal: sólo una línea corta en la barra |
  | 3 | Accesibilidad | El control segmentado con teclado; la nota es texto visible, no un `title` |
  | 4 | Liga con otro proceso | La mesa usa la misma cobertura; con un número fijo, la barra lo dice |
  | 5 | ¿Le toca a esta pantalla? | Sí: aquí se decide cuánto pedir |

  Dicen la cobertura real: la tarjeta «Cobertura», el resumen de cada renglón, el PDF de
  requisición, las notas de la requisición y la exportación. Un filtro guardado con otra cobertura
  la conserva fija. Una prueba encontró un recargo de más al salir del campo vacío; se corrigió.
- **Pruebas:**
  - Compras: 730/730.
  - Motor: `faltante.spec` 7/7, con negativas en rojo para D25 y D26.
  - `ngc`: con el error de control **dentro de la plantilla**, sólo marca ése.
  - `check-template-types` estricto: verde en las 4 apps.
  - `check:pantalla`: 0 fallas. Sigue el aviso de una definición dentro de un `title`, que ya
    existía y va con PQ.54.
  - **Sin validación visual.**

**Lo que no cambió, a propósito:** la sugerencia de compra y la de traspaso que la pantalla usa como
cruce lateral siguen con la cobertura numérica (30 por default), y la hoja «Traspasos» del Excel
también. La grilla, que es lo que se pide, ya es por sucursal.

**La pantalla dice por qué una sucursal sale en 0** (`3ea70328e`).
- **Primer intento descartado:** comparar en la pantalla existencia contra reorden. Habría puesto la
  insignia en **12,579 de 25,241 celdas** (la mitad de la grilla), y a casi todas ya no les faltaba
  nada. Ruido.
- **Lo que quedó:** el motor marca la celda (`sr`) sólo cuando el reorden frenó una cantidad que sí
  faltaba. Usa `frenadoPorReorden`, con la **misma** cantidad que decide el pedido (`PED_CRUDO`), así
  que la marca y el pedido no pueden contradecirse.
- **Medido:** la marca sale en 1,075 de 25,564 celdas (4 %). Ninguna celda marcada tiene pedido. El
  pedido no cambió: 0 diferencias contra la versión anterior, en corridas seguidas. En 55 celdas, en
  cajas redondeadas a décimas, la existencia no se ve arriba del reorden; el motor compara en unidad
  nativa.
- **Las cinco preguntas:**
  1. Se ve por qué esa sucursal sale en 0, junto a su nombre y en el mismo lugar que «sin existencia».
  2. Ninguna cifra extra.
  3. Texto visible, no un `title`.
  4. Es la misma regla que la mesa.
  5. Le toca: aquí se decide si se pide de todos modos.
- El encabezado «Pedir» ya no dice que siempre arranca en el sugerido.
- **Pruebas:** compras 733/733, motor 328/328, con negativas en rojo de los dos lados; `ngc` 0
  errores; `check-template-types` estricto verde en las 4 apps; `check:pantalla` 0 fallas. **Sin
  validación visual.**

**PQ.44 queda 🧪:** las tres reglas (D33, D25, D26) viven en `faltante.ts` y las usan la mesa y
Pedido. Sube a ✅ cuando esté en prod y se vea en la pantalla viva.

**Deuda nombrada:** `workbook` tarda 1.9–2.2 s por sucursal y 3–6 s la primera página de toda la
  red, antes y después de estos cambios. Una consulta de más de 500 ms no funciona.

### 17.14 PQ.10, primer paso — lo que sólo se muestra, fuera de la consulta (2026-11-04)

**Dónde se iba el tiempo** (EXPLAIN ANALYZE en prod, sólo lectura, la página que pide la pantalla al
abrir: toda la red, cobertura de cada sucursal, sólo con pedido, 20 renglones; 2.67 s):

| Pieza | Tiempo | ¿Decide algo? |
|---|---:|---|
| escalera de Kepler (`lad`, rótulos y factores de unidad) | ~650 ms | no: sólo se muestra |
| factor de caja (`vbf`): el CTE copiaba 245,080 filas para cruzar 25,619 | ~400 ms | sí (rótulo nativo de la celda), pero la fuente es una tabla con índice único |
| etiquetera (`lp`, caja y paquete) | ~370 ms | no: sólo se muestra |
| armar las celdas (`jsonb_object_agg` sobre 3,208 productos) | ~400 ms | sí |
| `base` (plan × productos × políticas) | ~800 ms | sí |

**Hecho** (código, sin cambio de negocio): la escalera y la etiquetera se leen en una consulta
aparte, con `= ANY(…)`, sólo para los renglones devueltos (`rotulosDePagina`); con la copia
materializada, `vbf` se une directo a la tabla.
⛔ **Primer intento descartado:** unirlas a la página en SQL. Con proveedor, el planificador volvió a
calcular la etiquetera una vez por renglón (185 × 110 ms = **19 s**, contra 1.5 s antes). En consulta
aparte no hay plan que elegir.

**Medido** con las dos versiones en el mismo proceso, contra prod (sólo lectura), 10 escenarios:
**respuesta idéntica en los 10** (la única diferencia que apareció era deriva del dato: corriendo
antes-después-antes salió igual). Tiempos, antes → después:

| Escenario | Antes | Después |
|---|---:|---:|
| red, página 1 | 2.67 s | 2.20 s |
| red, sin «sólo con pedido» | 2.68 s | 2.02 s |
| un proveedor (185 renglones) | 1.55 s | 0.99 s |
| una sucursal | 1.37 s | 0.79 s |
| agotados | 4.88 s | 3.55 s |
| página de 1,000 | 3.86 s | 2.71 s |
| exportación | 2.85 s | 2.49 s |

Prueba: `rotulos-pagina.spec.ts` (5), con mutante muerto (caja ← paquete: rojo).

**PQ.10 sigue 🔨: ninguna de estas llega a 500 ms.** Lo que queda (~2 s en la red) es lo que sí
decide el pedido: `base` y el armado de celdas sobre todo el catálogo, que la pantalla necesita para
los totales y el orden. Bajarlo de verdad es mantener el resultado por evento (como PQ.61 con la
venta diaria), no reescribir la consulta: es diseño, va con su propia medición.

### 17.15 PQ.55 — cuánto se abre cada vista de Pedido (2026-11-05)

**La fuente no son los logs** (que seguían bloqueados), sino `analytics.ui_usage` y
`analytics.ui_usage_users`. Las llena el interceptor de uso (`usage-metrics.interceptor.ts`) con el
patrón de cada ruta, por día, rol y usuario, desde el 30-sep. Lectura de sólo lectura contra prod
(sysid verificado), 30 días al 5-nov. **Control:** el 23-oct se publicó `workbook` con 3,734 hits.
La tabla da 3,901 entre el 30-sep y el 23-oct. La diferencia cabe en el resto del día 23 y en que
la ventana del 23-oct era más corta.

⛔ **Trampa en el conteo crudo:** `worklist` da 630 hits y 22 personas, pero desde PQ.5 (23-oct)
Pedido lo llama **cada vez que se abre**, con `pageSize: 1`, para el aviso «hoy te toca». La
señal limpia del Ciclo es `worklist/proveedores`, que sólo carga la agenda de esa pestaña. Las
otras tres también pueden cargar solas al restaurar la última vista guardada, así que sus cifras
son un **techo**.

| Vista | Llamadas en 30 d | De roles de Compras | Personas sin contar superadmin | Desde |
|---|---:|---:|---:|---|
| Pedido (`workbook`) | 5,994 | 4,996 | 23 | — |
| Ciclo (agenda, `worklist/proveedores`) | 26 | 22 | 3 | 23-oct (nació con PQ.4) |
| Stock muerto (`dead-stock`) | 20 | 13 | 4 | — |
| Sobrante (`sobrante`) | 8 | 3 | 4 | — |
| Flujo (`purchase-flow`) | 4 | 1 | 1 | último uso 22-oct |

**Lectura.** Por cada vez que alguien de Compras abre Sobrante, abre Pedido más de mil veces. El
Ciclo es distinto: su agenda existe desde hace 13 días, la abrieron tres compradores en seis días, y
el aviso de Pedido es lo que lleva a ella. Se deja y se vuelve a medir el 5-dic.

**D34 (propuesta, sin firma).** Quitar de Pedido las pestañas Stock muerto, Sobrante y Flujo:
- **Sobrante** entra a la fila con PQ.UI.11: la celda ya trae `surplus_network` y `transfer_in`.
- **Stock muerto** tiene su pantalla en `/almacen/dead-stock`. Antes de quitarlo hay que comparar
  las dos fuentes (`replenishment/dead-stock` contra `analytics/dead-stock`), porque no son el mismo
  endpoint.
- **Flujo** se queda en su ruta propia.

El corte lo hace **PQ.71**, una vez que la auditoría en pantalla (PQ.56) confirme que nada que
importe vive sólo ahí. Lo que se gana: cinco vistas pasan a dos, y ~210 líneas de plantilla salen
del componente (Sobrante 166, Stock muerto 38, Flujo 3; la lógica que las carga, NO MEDIDA). La
ganancia es de comprensión (dos pestañas menos que nadie abre), no de tamaño.

**De paso, la línea base real de PQ.10.** Es lo que ve la gente, antes del primer paso (que todavía
no está desplegado):
- `workbook` promedia 1.6–1.8 s por día de trabajo, del 26-oct al 5-nov.
- Su máximo diario va de 4 a 10 s.
- En los 30 días hubo una llamada de 192 s.

Cuando PQ.10 llegue a prod, ésta es la cifra contra la que se compara, con la misma tabla.

### 17.16 PQ.56 — auditoría nivel A de Pedido (2026-11-05)

**Evidencia: nivel A.** La pantalla corrió en prod (build `381ef5860`) con Chromium a 1366×768, en
claro, oscuro y `forced-colors`.
- **Sesión:** `superadmin`, no un usuario de Compras. Lo que depende del rol queda NO MEDIDO.
- **Blindaje:** service worker bloqueado y toda petición que no fuera GET abortada, salvo el login.
  Control: un `POST` lanzado desde la página salió `ABORTADO`. En las cuatro corridas sólo se
  abortó la telemetría.
- **Trampa evitada:** la primera `tbody tr` de la página es la bandeja «Lo pedido», con botones
  Aprobar/Rechazar en un panel cerrado. El recorrido se apunta a `.pr-wb-tbl`, nunca a «la primera
  fila».
- **Contraste:** calculado de los estilos reales con un instrumento que acierta sus dos controles
  (21.00 y 4.48).

**Las cinco preguntas (diseno §0b), contestadas con la pantalla viva:**
1. *Qué ve al entrar.* Siete cifras del mismo tamaño, el aviso del Ciclo, los filtros y el aviso
   de «sin valuar». **Ni un producto:** el primero empieza a 850 px, en una ventana de 768.
2. *Qué no debería ver.* El aviso rojo de 249 canales vencidos (PQ.UI.5 sigue vigente), la
   pastilla «UNIFICADO» y la cobertura dos veces.
3. *Accesibilidad.* El contraste pasa salvo en una cifra. Teclado, objetivos de 44 px y lector de
   pantalla: NO MEDIDOS.
4. *Liga a otro proceso.* «ya requisado 580 cj · 3 veces» sí liga. «Entrega: capturarlo en otra
   pestaña» manda fuera.
5. *¿Le toca?* Sí. Sobre las tres pestañas de D34 no se juzga aquí (§17.15).

**Hallazgos, del más caro al más barato:**

| # | Capa | Hallazgo | Item |
|---|---|---|---|
| 1 | Veracidad | **La primera fila de Pedido es la bolsa 17499: 19,899 kg, $686,118 a comprar.** Sale de una sola venta (PQ.47). La fila no lo dice, y «Agregar a la requisición · $686,118» queda a un clic | PQ.47, espera **D31** |
| 2 | Veracidad | **El rótulo dice cajas y la celda no lo es.** La columna se llama «Σ Ped. cajas» y muestra kg o bto. En el desglose de 17499, el total dice «19,899 cj» de un producto que se pide en kg | **PQ.72** |
| 3 | Comprensión | **La primera pantalla es puro marco.** Las 7 cifras miden 24.8 px (aplanamiento, §Q.5). La cobertura se elige dos veces: una caja de texto truncada («cada su…») y un segmentado. El aviso del Ciclo va en rojo | **PQ.74** |
| 4 | Accesibilidad | **«Sobrestock $9,579,351» en ámbar sobre claro: 1.95:1** (texto grande, pide 3:1). Se le escapó a PQ.52 | **PQ.73** |
| 5 | Carga | **El color de acción se usa como decoración.** «$ Pedido» va en `--action` en todas las filas. ⛔ **Corrección:** al leer el código resultó que no es el rojo de error, sino el sunset de la marca, que en pantalla se ve rojo. El sistema lo reserva para botón, activo y foco: en cada fila gasta el color que marca «Generar requisición». «A comprar» lleva el tono `brand` del componente de cifras y se deja, porque es la cifra primaria | **PQ.73** |
| 6 | Visual | El proveedor se parte en seis renglones cuando la fila trae cuatro pastillas (17083), y la fila triplica su alto | **PQ.74** |
| 7 | Comprensión | En el panel de negociación, «Pedido típico $686 mil de $241 mil» no se entiende. «Entrega: capturarlo en otra pestaña» saca de la pantalla | **PQ.75** |
| 8 | Respeto | **11 s hasta que Pedido termina de cargar.** `workbook` tardó 5.4 s en frío, y cada apertura pide además `purchase-suggestion`, `transfer-suggestion` y `overstock` con `pageSize=1000`, unas 4,490 veces al mes cada una | PQ.10 |

**PQ.UI.1–5, revisadas en pantalla:**
- **PQ.UI.3 resuelta en la celda:** la unidad dice su contenido («6 paq por cj», «15 kg / 3 paq × 5»).
- **PQ.UI.2 parcial:** la cobertura sale «como en su mesa» (D25). Que la celda reste lo que ya
  viene no se vio en la fila.
- **PQ.UI.5 vigente.**
- **PQ.UI.1 es de dato** y no se ve en pantalla.
- **PQ.UI.4 (filtrar al CEDIS): NO MEDIDA.** No se eligió esa sucursal.

**Lo que esta auditoría no cubre:** la vista de un usuario de Compras, el recorrido con teclado, los
objetivos táctiles, el lector de pantalla y las pestañas Ciclo, Sobrante, Stock muerto y Flujo.

### 17.17 PQ.76 — las tres listas de Pedido se topaban en 500 y se sumaban como total (2026-11-05)

**Cómo salió.** Lo encontré revisando por qué cada apertura de Pedido pide además
`purchase-suggestion`, `transfer-suggestion` y `overstock` (hallazgo #8 de §17.16).
- La pantalla las pedía con `pageSize=1000`, pero el servidor las topa en 500.
- Ni la pantalla ni el servidor decían que la lista venía cortada (Cruce 1 de `auditoria-diseno`).
- Con esos 500 renglones se armaban las cifras de arriba, las pastillas y los traspasos.

**El daño, medido contra prod** (servicio real empaquetado, sólo lectura):

| | Renglones que llegaban | Lo que publicaba la pantalla | Total del servidor (`total_valor`) |
|---|---:|---:|---:|
| A traspasar | 500 de 4,457 | $3,429,912 | $4,859,350 |
| Sobrestock | 500 de 4,622 | $9,530,616 | $12,977,426 |
| Compra (pastillas ABC y «comprar») | 500 de 752 | — | — |

Además, en un producto que quedaba fuera de esos 500 renglones:
- la columna Traspaso del desglose decía «—» aunque sí hubiera traspaso;
- ese traspaso no entraba a la requisición;
- le faltaba su pastilla ABC.

**El arreglo** (C2 + C3):
- **Servidor.** `product_ids` en las tres rutas (`aProductos`).
  - El filtro se aplica por fuera de la consulta, así que los totales siguen siendo de todo el filtro.
  - Siempre viaja un renglón testigo con los totales, que `filasDeProductos` descarta.
  - Sin `product_ids`, el SQL es el mismo de antes.
- **Pantalla.** Pide las tres listas para los productos de la página, más lo marcado.
  - Al paginar pide sólo lo que falta y lo **agrega**. Si lo reconstruyera, se borrarían las
    cantidades de traspaso que el comprador ya editó.
  - «A traspasar» y «Sobrestock» leen `total_valor` del servidor. Muestran «cargando» o «no se pudo
    medir», nunca un 0 inventado.
  - La barra «En esta página» suma sólo la página, como dice su rótulo.

**Pruebas.**
- **Contra prod, en sólo lectura:**
  - Sin `product_ids`, las tres respuestas son idénticas a la versión anterior.
  - Con los productos de la página 1 más 5 que estaban fuera del tope, vienen sólo esos productos,
    con los totales iguales y las filas iguales a las de la lista completa.
  - **Control negativo:** con un id que no existe vienen 0 filas y los totales de la red. Ese control
    encontró que el primer diseño devolvía total 0, y por eso existe el renglón testigo.
- **Unitarias:**
  - `pq76-productos.spec.ts` (6) y 5 más en el spec de Pedido.
  - Tres mutantes, los tres muertos: la cifra suma lo que viajó; la barra no filtra por página;
    paginar reconstruye.
  - `libs/commercial` 339/339 y Pedido 130/130.

**Lo que no cambió y queda declarado:**
- Las tres listas siguen calculándose sobre toda la red en cada apertura, porque los totales lo
  necesitan. Ganar velocidad aquí es PQ.10, aparte.
- El traspaso sigue con cobertura de 30 días fijos mientras la tabla usa la de cada sucursal
  (PQ.UI.2).
- Nest: sólo se agregaron parámetros `@Query` a tres métodos. El constructor no cambió, pero el
  arranque NO está verificado.

### 17.18 PQ.74 — el primer producto se ve al entrar (2026-11-05)

**Las cinco preguntas (diseno §0b), antes de tocar la plantilla:**
1. *Qué debe ver, y en qué orden.* Cuánto hay que comprar (la cifra primaria), y enseguida los
   productos, del de más dinero al de menos. Hoy el primero empieza en y=850 de una ventana de 768, y
   la barra fija de abajo tapa desde y=701.
2. *Qué no debe ver:*
   - la pastilla «UNIFICADO», que no decide nada;
   - la cifra «Cobertura», que repite el selector de cobertura con su nota;
   - «SKUs», que repite el paginador;
   - la caja de días mientras rige «cada sucursal», que repite el segmentado;
   - el rojo del aviso del Ciclo: sus fechas son estimadas (PQ.UI.5) y no deben gritar.
3. *Accesibilidad.* Nada se esconde tras un clic nuevo. Lo que sale repetía algo que sigue a la
   vista. El aviso «sin valuar» conserva su «por qué».
4. *Liga a otro proceso.* «Ver el ciclo» y «Lo pedido» se quedan donde están.
5. *¿Le toca?* Sí. Lo que se quita es repetición, no información.

**Medición previa, simulada en la página viva** (sólo en el navegador de la prueba, sin escribir):
- Con estos cambios más el aire entre bloques (gap de 16 → 8 px y sin márgenes sumados), el primer
  producto pasa de y=850 a y=583.
- Antes de la barra se ven dos productos completos.
- Sin reducir el aire quedaba en y=687, todavía debajo de la barra: la mitad de la ganancia es aire.

**Lo hecho:**
- Sin la pastilla. La frescura pasa al encabezado.
- Las cifras quedan en una fila (seis): salen «SKUs» y «Cobertura». El objetivo («objetivo 21 o
  30 d») queda en la bajada de «Días de existencia», para conservar el par «tengo N, quiero M» de
  RA-PRO.49.
- El aviso del Ciclo en una línea, sin caja y sin rojo.
- La caja de días sólo aparece cuando la cobertura no es «cada sucursal».
- «Sin valuar» en una línea, sin caja.
- 8 px entre bloques y sin márgenes sumados.
- El proveedor ya no se parte: las pastillas bajan de línea.

**Pruebas:**
- Pedido 136/136, y compras + componente de cifras 763/763.
- Plantillas tipadas. `check:pantalla` sin fallas.
- La prueba de PQ.5 que exigía el rojo de urgencia se cambió a propósito, con su motivo.
- Mutante: devolver «SKUs» → rojo.

⛔ **Corrección de esta misma sesión.** Creí que el «—» de PQ.76 sin `format: 'text'` se pintaba
como 0, porque así lo decía un comentario del archivo. El mutante sobrevivió. Al leer el componente
de cifras resultó que `isText()` ya pinta como texto todo valor que no es número: el comentario
estaba desactualizado y PQ.76 nunca tuvo ese defecto. Se dejó el `format` explícito y se anotó el
comentario viejo.

**Sin validación visual del código real.** La medición fue una simulación en el navegador. Al
soltar, se repite la medida de y=850 con el mismo script (`a56e.js`).

### 17.19 PQ.75 — el panel de negociación, y por qué la entrega no se captura todavía ahí (2026-11-05)

**Hecho: el pedido típico en dos cifras.** Antes se leía «$686 mil de $241 mil». Ahora va el típico
en grande («$241 mil») y debajo «llevas $686 mil». Es la misma cuenta (`evaluarPedidoTipico`),
sólo se separa. Prueba en el spec del panel, con mutante muerto (volver a «X de Y» → rojo).

**No hecho, a propósito: capturar la entrega en el panel.** «Una sola interfaz por flujo» pide
quitar el «capturarlo en otra pestaña». Antes de exponer esa escritura en Pedido se midió en prod
(sólo lectura):
- `catalog.suppliers.lead_time_days`: **0 de 1,347 proveedores** capturados.
- `POST suppliers/:id/lead-time`: **0 llamadas** desde que hay registro de uso (30-sep).
- Ninguna prueba en `database/tests` ejerce ese endpoint contra una base real.
- Pide `COMPRAS_PROVEEDORES_GESTIONAR`, que no se verificó en el puesto de comprador.

Cero filas por defecto no se distingue de cero por desuso (regla 13). Por eso nace **PQ.77**:
1. La prueba contra base real del endpoint, con el payload de la pantalla.
2. Verificar el permiso en los puestos de Compras.
3. Después, la captura en el panel.

Pesa más de lo que parece: el lead time en 0 es la mitad de por qué las fechas del Ciclo no se
sostienen (PQ.UI.5).

### 17.20 PQ.78 y PQ.79 — dos papeles que traen los compradores (2026-11-05)

**PQ.78: el precio de la sucursal que recibe, leído del ODS en vivo.** Un comprador corrigió a mano
la requisición de Tuby Ice (proveedor CF010): CHILE y SUPER salían a $297.83 y $397.10 la caja, y el
proveedor cotizó $282.15 y $376.20 ($18.81 por paquete). Medido:

- el PDF imprimía lo que Kepler tenía: 9 de 9 sucursales en $297.83, aún a las 13:46. El precio
  nuevo no estaba guardado en Kepler. La corrección del precio se hace en Kepler (*Costos por
  Proveedor por Productos*), no en la suite;
- pero la suite tenía dos defectos propios. El fact `replenishment_plan.caja_cost` trae la
  **mediana de las 9 sucursales** (`v_supplier_cost_ladder`) y se rehace cada 15 min, así que un
  precio corregido en una sola sucursal no se veía nunca, y uno corregido en todas tardaba hasta
  15 min. Además, el papel no decía de dónde salía el precio ni de qué hora era.

Lo hecho: `workbook` lee `kepler_ods.kdpv_prov_prod` con la llave exacta del índice (sucursal,
código de proveedor y SKU). Resultados:

- casan 33,444 de 34,023 renglones de sucursal, sin duplicados;
- donde no casa queda el valor del fact: rutas, Wincaja y 479 renglones cuyo proveedor en la suite
  no es el de Kepler;
- **antes/después** (sólo lectura contra prod): cambian 37 precios; el pedido sugerido de la red baja
  $106 ($21,081,318.97 → $21,081,212.84) y la existencia valuada $114. Ejemplo: en 97150, Yurécuaro y
  Morelia Madero pasan a $346 (su Kepler) y las demás siguen en $370;
- control: Tuby en Morelia Abastos se queda en $297.83, porque Kepler no ha cambiado;
- costo: unos 100 ms en frío sobre el catálogo entero y +26 ms con caché caliente.

El PDF (las dos formas) dice ahora: «Precio = costo de caja del proveedor, sin impuestos, en Kepler
(Costos por Proveedor por Productos) de la sucursal que recibe, al <hora>. Si el proveedor cotizó
otro precio, corríjalo en Kepler y vuelva a generar esta hoja». La prueba se probó con un mutante.

⚠️ **Deuda con nombre:** Autoabasto, Existencia y las listas de traspaso o sobrestock siguen leyendo
la mediana del fact. Hoy difieren en 37 renglones. Se alinean cuando el motor se mude a vistas del
ODS (D17); no se tocó el importer.

**PQ.79: lo que ninguna sucursal pudo calcular se pinta «—», no 0.** El caso fue 59059 NARANJA BOLI
CHICO: el renglón decía «0 cj · $0 · Exist. red 0», y el Total del desglose «0 / 0», con 939
paquetes en la red.

La causa está en Kepler:

| | Folio | Cantidad | Costo unitario | Importe |
|---|---|---|---|---|
| Entrada normal | 0001065 | 40 PAQ | $9.32 | $372.96 |
| Entrada del 2-oct en 8 Esquinas | X-A-40 0001062 | 800 PAQ | $0.5067 | $405.36 |

El 0001062 vale lo de 40 paquetes: se capturaron las piezas (40 × 20) en la unidad de paquete. 8
Esquinas trae unos **760 paquetes que no existen**. Consecuencias:

1. Lo pagado se promedia en toda la red, así que esa sola entrada pone el veredicto `x1_inflada` en
   las 5 sucursales.
2. El motor ve sobrante en 8 Esquinas y propone traspasar mercancía inexistente.

Lo hecho en la suite: `sinCalcular(r)` pinta «—», con la razón en el título, en Σ Ped., $ Pedido,
Exist. red y el renglón Total. Si faltan sólo algunas sucursales, la suma parcial lleva su
triángulo también en el Total. Dos pruebas, una de render con el renglón real; mutante muerto.

**Fuera de la suite (Edgar):** corregir en Kepler la entrada 0001062 de 8 Esquinas, o ajustar su
existencia. Dos hallazgos quedan registrados sin item: el árbitro de peldaño promedia lo pagado en
toda la red, de modo que una captura mala en una sucursal bloquea a todas; y el motor puede proponer
traspasos de existencia fantasma.

**PQ.80: con ⚠ no hay sugerido, pero se puede pedir a mano.** Edgar: *«si necesito pedir el boli naranja no me deja»*. Con el peldaño en contra, el renglón de la sucursal era «—» entero y `qtyOf` devolvía 0 aunque se escribiera. Ahora quedan «—» la existencia en cajas, los días y el traspaso (no se midieron), pero el campo para pedir está abierto: lo capturado cuenta y viaja a la requisición y al PDF, sin un sugerido inventado. El renglón dice «sin sugerido · pide a mano». Σ Ped. y $ Pedido sólo son «—» si además nadie capturó nada. El servidor no revisa el peldaño al registrar la requisición. Probado: la prueba de render falla contra la versión anterior, y un mutante de `qtyOf` muerto.

**PQ.81 (registrado): la búsqueda por folio de Control de entradas sólo encuentra la factura.** Edgar buscó «1062» en `/compras/entradas` y vio la **X-A-20 0001062**, que es la factura (remisión 40-3586, $1,710.57) y viene de la orden X-A-40 **0001065**. Ahí el BOLI NARANJA dice 40 paq, y por eso lo tomó por corregido. La entrada mala es la **X-A-40 0001062**, la orden de entrada (remisión 40-3588, $470.22, abierta), que sigue en 800. La vista `analytics.erp_goods_receipt_lines` filtra `c4 = '20'`, y en Kepler el folio se repite entre tipos de documento (`ERP_KEPLER.md` lo advierte). Arreglo propuesto: que la búsqueda por folio diga el tipo de documento y ofrezca también la orden de entrada (X-A-40) con ese número, con su remisión, para que no se confundan. **Hecho (2026-11-06, 🧪):**
- El detalle dice «Orden de entrada 0001065 · remisión 40-3586» (la remisión es lo que trae el papel), el título es «Qué trae esta entrada» y el subtítulo «Entrada 03/0001062».
- La fila y las sugerencias dicen «orden NNNN» cuando es otro número.
- La búsqueda por 4 dígitos encuentra también por el folio de la orden de entrada: «1065» → 03/0001062.
- Medido: en 3,198 de 3,391 aplicaciones de 90 días el folio de la aplicación no es el de su orden.
- La búsqueda por la orden va en dos pasos (las llaves en `kdm1`, luego la lista): como `OR` correlacionado llevaba la búsqueda de 0.1 s a 1.5 s; en dos pasos queda en 50–110 ms más la lista igual.
- Verificado contra prod en sólo lectura con el servicio real (detalle y llaves) y el fragmento SQL. ⚠️ La lista de punta a punta NO MEDIDA: abre su transacción en escritura (tabla temporal) y el candado de sólo lectura la rechaza. Sin prueba de pantalla y sin validación visual.

**Lo que destapó, y corrige lo dicho el 2026-11-05:** la X-A-40 0001062 (remisión 40-3588) y la 0001063 (40-3587) sí se aplicaron, con las X-A-20 0001059 y 0001060, pero esas aplicaciones están **canceladas**. La mercancía se volvió a capturar bien el mismo día (X-A-40 0001069 y 0001067). En Kepler hay que **cancelar** las órdenes 0001062 y 0001063, no corregir su cantidad: corregirla duplicaría lo que ya entró bien.

**PQ.82: el PDF de la OC para el proveedor decía «cajas» donde Kepler pide piezas.** Edgar, 2026-11-06, OC 07/0000092 (Morelia Madero): la pantalla decía «5 PZA» y el PDF «5 cj» con «$115.50 / pza» en el mismo renglón. Causa: en esos renglones Kepler declara la caja de la línea como la misma unidad (PZA o PAQ con 1 por caja, `c55`/`c58`), y `cajasDeRenglon` lo daba por caja porque el costo cuadraba trivialmente (115.50 = 115.50 × 1). Medido en 90 días: **4,345 de 16,807 renglones de OC, en 1,312 de 2,685 OC (49 %)**. Arreglo: un factor de 1 no es caja, así que se muestra la cantidad en su unidad («5 pza»). Prueba del caso real con control (la caja de 20 sigue diciendo cajas) y mutante muerto. Los PDF ya enviados quedan como estaban: hay que avisar a los compradores.

**PQ.83: el freno de duplicados (PQ.70) decía «hecha fuera de la Suite» de lo que mandó la propia Suite.** Edgar, 2026-11-06: RQ-2026-02269 (CEDIS, EFFEM, $983,607) se detuvo contra la requisición 00/0003143 de Kepler «hecha fuera de la Suite». Medido: la 0003143 la capturó el usuario `SUITE` con referencia RQ-2026-02055, y coincide en los 33 productos. De ella salió la OC 0007296, que está **cancelada**, y la 0003143 sigue abierta ($1.03 M). La RQ-2026-02269 es otra compra: 48 productos, 32 en común, 16 nuevos y cantidades distintas (SKWINKLES CHAMOY 10 contra 250). Todo indica que la rehicieron después de cancelar la OC. El aviso le decía al comprador «si es ésta, no hay que hacer nada más», que aquí era falso.

**Arreglo:** cada documento dice quién lo hizo, «(la mandó la Suite con la RQ-…)» o «(capturada en Kepler)», a partir de `c67`/`c11`. Las instrucciones son: «Si es la misma compra, no hay que hacer nada más. Si ésta la reemplaza, cancela aquélla en Kepler y reintenta». Ejecutado en prod en sólo lectura sobre la RQ-2026-02269: «requisición 0003143 del 04-11 (la mandó la Suite con la RQ-2026-02055)». El freno sigue deteniendo con un solo producto en común; afinarlo es decisión de Compras y queda abierto.

**PQ.84: filtros que encuentran UNA orden en `/compras/oc-abiertas`** (pedido de Edgar: «agreguemos aquí filtros necesarios»). Un buscador por folio de la OC, por la requisición de la que salió (la RQ de la Suite o la requisición de Kepler, por sus últimos dígitos) y por proveedor sin acentos. Además, un filtro de origen (Suite, Kepler o sin requisición) con su cuenta. Todo va en la URL, y «Quitar los filtros» también los limpia. Filtra lo que la tabla trajo (hasta 500; hoy 178) y lo declara si la tabla está truncada. Pruebas: 6 de la regla, con un control de lo que no debe coincidir, y 4 de la pantalla montada (mutante muerto); compras 767/767; `check:pantalla` 0 nuevas. Sin validación visual.

**PQ.87: la caja la dice la ficha de Kepler de la sucursal, también cuando sus peldaños repiten la base** (una OC de prueba de Morelia Abastos, 2026-11-06: el ROLLO MINI de Lico salió a $0.76 el paquete contra $30.45 en Kepler, ÷40; los rollos grandes ÷25). Kepler tiene esos productos sin caja: Base PAQ, Unidad Dos PAQ ×1, Unidad Tres PAQ ×1, todos al mismo costo. `v_kepler_unit_ladder` lo leía como «rótulo sin factor ni costo» (factor NULL), `v_warehouse_box_factor` caía al `factor_sale` del catálogo (40, ya marcado sospechoso), y el costo del proveedor de Kepler, que es por paquete, se dividía entre 40 al escribir piezas. Hubo además dos factores distintos en el mismo camino: la mesa convierte con el factor del ALMACÉN y el envío (y la validación del lote) con el del PRODUCTO (`v_product_box_factor`).
- **Vista** (mig `20261106173448`): si ningún peldaño tiene factor efectivo y cada peldaño superior está vacío o repite la base (mismo rótulo, factor ≤ 1, costo vacío o igual ±1 %), es `unidad_unica`, factor 1. Otro rótulo con factor 1 (PAQ / CJA ×1) sigue siendo ignorancia. Medido en prod, sólo lectura: control EXCEPT 0/0 con el cuerpo vigente; 86,144 filas antes y después; cambian 2,503 filas (279 SKU); en el factor por almacén, 523 celdas de 60 productos pasan de >1 a 1 (342 `factor_sale`, 180 `override`, 1 peldaño vendido). Testigo: el costo pagado marca 142 de esas celdas `x2_deflactada` con divisor esperado mediana 1.00; ninguna `ok` con la caja vieja.
- **Gemela TS** `factorFichaKepler`: la misma regla, con dos negativas.
- **Envío y lote**: `piezas_por_caja` sale de `mv_warehouse_box_factor` del almacén de la requisición, el mismo que usó la mesa.
- **Freno del adaptador** (compra): si la ficha de la sucursal dice sin caja y la Suite trae caja > 1, se rechaza nombrando los SKU; con caja 1 en los dos lados, el renglón va en la unidad base de la ficha y no en `CJA`.
- **Pendiente / NO MEDIDO:** el freno no se ensayó contra un Kepler real (el ensayo sólo corre desde la máquina con los secretos). La caja de la mesa cambia hasta que se refresquen `mv_warehouse_box_factor` y el plan. Desde el 1-oct, 13 requisiciones ya enviadas tienen productos de este grupo: no se re-envían; la ficha y la OC se revisan en Kepler.

**PQ.91: PQ.87 arregló la caja de la existencia y del costo, y dejó la de la DEMANDA en 40** (prueba final del 2026-11-07, ya con PQ.87 en prod). El plan guarda dos cajas: `display_bf` (la del almacén, divisor de la existencia) y `bf` (la del producto, `v_product_box_factor`, divisor de la venta diaria y del tránsito). En una sucursal Kepler las dos cuentan unidades base de Kepler; PQ.87 movió la primera a 1 y la segunda siguió en el `factor_sale` de 40. La venta del 15151 está en paquetes (precio unitario $37.53, el del PAQ), así que la mesa comparaba 20 paquetes en existencia contra 0.55 «cajas de 40» de demanda y **no pedía**. Antes de PQ.87 las dos decían 40: la cantidad salía bien y el costo mal; después, al revés.
- **Plan** (`import-replenishment-plan`, `BF_ROW`): donde la ficha de la sucursal dice que no hay caja (`kepler_unidad_unica`), `bf` = 1, y el tránsito (que el CTE `tr` da en cajas del producto) y el costo de respaldo se pasan a esa caja. Medido en prod con el SQL del árbol en una transacción de sólo lectura (38 s): 43,113 filas, las mismas; 0 celdas `kepler_unidad_unica` con `bf` ≠ `display_bf` (282 antes); 0 filas de otra fuente con `bf` distinto. Mutante (sin el CASE): 282, rojo. Tránsito de esas celdas: $858 → $22,277 (se contaba en cajas de 40). Simulación de la mesa (cobertura 21 d, sin cumplimiento ni reorden): de 42 a 117 celdas que piden, $358 → $73,690; control: las 38,741 celdas Kepler con `bf` = `display_bf` no se mueven. El 15151 en Morelia Madero pide 2.2 PAQ (vendió 8 en 30 d, tiene 1).
- **Fuera de cálculo** (servicio, `rpSrc`): la misma regla para los productos agotados que se piden a mano.
- **Compra consolidada** (revisión adversarial): el envío y el lote leían el factor del CEDIS del encabezado; ahora el del renglón (`COALESCE(destination_warehouse_id, warehouse_id)`), que es en cuyas cajas se capturó. Ejercido en prod sobre RQ-2026-02303 (37 renglones, todos con factor). Prueba nueva con mutante.
- **Adaptador**: el freno sale a `frenoFichaSinCaja` (pura, 4 pruebas). Sin factor de la Suite cuenta como 1, como en la mesa: antes ese renglón salía en `CJA`, una unidad que la ficha no tiene (mutante rojo).
- ⚠️ **Lo que NO se tocó, a propósito:** 120 celdas `kepler_ficha` donde la ficha dice una caja > 1 y el producto otra. Es un desacuerdo anterior a PQ.87 y el único testigo de costo le da la razón al PRODUCTO; igualar ahí bajaría la sugerencia de $301 k a $5 k. Va aparte, con su árbitro.
- ⚠️ **Deuda con nombre `[PQ.92]`:** el renglón de la requisición no guarda la caja con que se capturó, y el envío la relee. Una requisición generada con la caja vieja y enviada después pasa sin freno si son cajas ENTERAS (las fracciones ya las rechaza PQ.17). Hoy hay UNA así: RQ-2026-02324 (Morelia Madero, 15170, 2 cajas a $21, aprobada el 6-nov sin enviar). El arreglo es guardar la caja en el renglón (migración expand + los dos caminos que insertan).

**Proveedores con «?» en el nombre:** 6 de 804 claves de Kepler (CF010, CC021, CG005, CB009, CC002…). El ODS guarda bien la Ñ de otros 29 proveedores, escritos con Ñ. Entonces el «?» **está guardado así en el catálogo de Kepler** (`kdxd.c3`) y se corrige
allá; el importer de proveedores lo traerá corregido. Parcharlo en la suite lo pisaría la siguiente
corrida. Además CF010 aparece dos veces en `catalog.suppliers`: «853», bien escrito y sin
productos, y «CF010», con «?» y con los 3 productos.

---

## 18. Unidades de medida al 100 %: verificado o con dueño (2026-11-04)

Pedido del PM: *«aún existen productos con un símbolo de advertencia»* → *«investiguemos si
podemos tener un 100 % de unidades de medida correctas»* → *«¿e históricos?»* → **aprobó el plan
y la tabla de historia de fichas.**

### 18.1 ⛔ Choque de código: PQ.58 es el commit que dice «PQ.41»

El árbitro del peldaño por unidad asentada se escribió como **PQ.41** sin ver que §16.2 ya usaba
ese código para el backtest de temporada. Ya está en prod (`7b438a6c1`, archivo
`20261104094527_pq41_arbitro_peldano_por_unidad_asentada.js`): el archivo **no se renombra** (lo
nombra el ledger). **En el tracker y en este documento vale PQ.58**; PQ.41 sigue siendo la temporada.

### 18.2 Lo medido (prod, sólo lectura)

**Kepler no verifica unidades, las registra.** Cada movimiento copia el factor de la ficha al
capturarse; la existencia (`kdil`) es la suma cruda del kardex sin convertir rótulos (§ERP_KEPLER
3.x); el precio por caja es su propio número en la ficha. Lo que corrige el error es una persona
contando: el 97392 entró como 708 «CJA» y un `N-A-30` del 30-sep sumó 16,992 PAQ
(708 + 16,992 = 708 × 25; la ficha dice 10). Pedido cruza lo que Kepler nunca cruza, y por eso se
le ven las contradicciones.

**Estado por almacén × producto con existencia** (kardex desde el último conteo + compras X-A-40
asentadas en la base por precio, 365 d):

| Estado | Productos | Valor |
|---|---:|---:|
| A · verificado: existencia en una unidad y caja confirmada por compra | 4,202 | $62.0 M |
| B · coherente, la caja no se prueba con la compra | 1,254 | $4.6 M |
| C · existencia MEZCLADA desde el último conteo (ZUKO 48xxx) | 315 | $1.6 M |
| D · caja contradicha (compra en un tamaño que la ficha no tiene: 99891 ficha 6, compra 9) | 5 | $0.1 M |

El triángulo de hoy no es este estado: marca 92 celdas de A y ninguna de D.

**Testigos que se descartaron, con su medida:** el CFDI del proveedor liga 18 % de los renglones
de entrada (placebo +$1: 286 contra 4,411) y casi siempre factura en «caja», la unidad capturada:
confirma la caja y su precio, no cuántas piezas trae. Recepción 360 tiene 38 sesiones. Los
conteos de `inventory_count_items` no guardan unidad.

**Historia:** venta `U-D` asentada en una unidad que la ficha de HOY ya no tiene: ~12 % del
importe en nov–dic 2025, 8 % ene–mar, 3.5 % abr–jun, 1.2 % jul–sep, 0.4 % oct. El importe está
bien; la cantidad de esos renglones no se puede convertir con la ficha de hoy, y
`mv_kepler_sales_daily` multiplica lo asentado en CJA por la caja **actual** (retroactivo: PQ.40
cambió hacia atrás las cajas de sus 41 productos). Kepler no guarda historia de la ficha.

### 18.3 Los items

| Item | Capa | Qué | Árbitro |
|---|---|---|---|
| PQ.58 | C0 ✅ | Árbitro del peldaño por unidad asentada (archivo `pq41`): 428 → 316 celdas, ninguna nueva | aplicado 2026-11-04, `[PQ.41] celdas sin valuar: 428 -> 316` |
| PQ.59 | C0 ✅ | (aplicada 2026-11-04: 86,076 fichas iniciales, 0 errores, 3 triggers) Historia de fichas: `analytics.kepler_ficha_history` mantenida por trigger sobre `kepler_ods.kdii` (sólo cuando cambian unidades, factores o costos) | prueba contra Postgres real en el CI; en prod, una fila inicial por ficha |
| PQ.60 | C0 ✅ | (aplicada 2026-11-04: `analytics.kardex_unit_state` por trigger sobre `kdij`, 40,202 llaves, 1,356 mezcladas, 0 errores; la clasificación A/B/C/D y el reemplazo del triángulo van en PQ.65) Estado de unidades por almacén × producto (A/B/C/D) en una vista; reemplaza al triángulo como veredicto | controles: 97392 → B, 48067 → C, 99891 → D |
| PQ.61 | C0 🧪 | Venta histórica convertida por renglón (factor que confirma el precio, ficha del día); lo no convertible se declara. Tabla por evento (§18.5); el sugerido NO estaba afectado (§18.4) | historia completa: monto idéntico, 61 suben / 4 bajan, precio÷costo 1.02–1.30 |
| PQ.62 | C1 | B → pregunta a Compras («¿cuántas trae la caja?») con Definiciones de negocio, por valor | contestar = configurar |
| PQ.63 | C1 | C → cola de conteo de Inventario Continuo | sólo un `N-A-30` arregla la existencia |
| PQ.64 | C0 | Aviso por evento: movimiento de kardex en una unidad que no es la base | por trigger, no nocturno |
| PQ.65 | C3 | Pedido muestra el estado (con su acción) en vez del triángulo y valúa todo con la fórmula de Kepler | `diseno` + `check:pantalla` |
| PQ.66 | deuda | `mv_kepler_bought_rung` (PQ.40) se refresca de noche: contra la regla de «nada nocturno» | pasar a evento |

### 18.4 PQ.61 medido: la venta se asienta en la base, salvo el paquete (2026-11-04)

Prod, sólo lectura, venta `U-D-8/10/12` de 90 días, cada renglón arbitrado por precio: `kdm2.c12`
(precio por unidad asentada) ÷ `kdii.c77` tiene que caer en banda de margen (0.85–2.5) contra 1, `f2`
o `f3`. **Control:** los renglones cuyo rótulo es la base de la ficha dan mediana 1.29 (p10 1.16,
p90 1.42), un margen con impuestos; el árbitro distingue.

| Rótulo asentado (`c11`) | Renglones | Lo que dice el precio |
|---|---:|---|
| = base de la ficha | 1,118,768 (99.4 %) | base |
| = escalón intermedio (`u2`) | 791 | **intermedio** (razón ÷ `f2` = 1.14) |
| = caja (`u3`) | 102 | **base**: rótulo de caja con precio de pieza |
| fuera de la ficha (250/400/500/PAQ/PZA) | 4,738 | base en su mayoría |

Efecto en `mv_kepler_sales_daily.units` por producto: **5,334 de 5,365 iguales**; **21 subcontados**
(cuenta el paquete como pieza: $540 k de venta, 36.5 k → 46.5 k unidades; 65109 20,581 → 25,351;
14039 1,134 → 2,739); 2 sobrecontados (multiplica por la caja un «CJA» con precio de pieza: 44350
48 → 4). El efecto «retroactivo» de la caja de hoy es marginal: sólo 17 productos se venden con
base caja y 2 con caja intermedia.

⭐ **El sugerido de compra NO está afectado:** su demanda sale de `analytics.sales_daily`, que ya
convierte cada renglón por precio (`toCanonicalPriced`): 65109 con factores 1 y 10, 14039 con 1 y
16, y su razón unidades/peso coincide con la arbitrada. Lo subcontado vive en el sell-out, productos
nuevos, respuesta al precio y la ficha del catálogo.

⛔ **Lo que cuesta arreglarlo:** no existe `CREATE OR REPLACE MATERIALIZED VIEW`. Cambiar la fórmula
exige tirar y rehacer **19 dependientes en 5 niveles, ~3 GB de matvistas** (`mv_sales_blended`
1.7 GB, `mv_sellout_monthly` 525 MB, `mv_price_signals` 221 MB…), con el sell-out sin servir
mientras dura. Es la misma reconstrucción que espera la deuda declarada en
`20260911240200_sellout_daily_lee_label_consolidado.js` (6 SKUs, $868 k/90 d). Recomendación: **una
sola reconstrucción para las dos**, con una herramienta que rehaga la cadena desde las definiciones
vivas (no una 8ª copia a mano), en una ventana firmada fuera de horario.

### 18.5 PQ.61 — la venta diaria pasa a TABLA mantenida por evento (2026-11-04, PM: «hazlo»)

El PM pidió «sólo update a los que cambian». Una matvista no acepta `UPDATE`, así que la conversión
se paga **una vez** y desde ahí cada corrección toca sólo lo que cambia.

**Diseño** (migración `20261104152847`, regla en `analytics.kepler_sales_daily_recalcular`):
- `analytics.mv_kepler_sales_daily` queda como **tabla con el mismo nombre y columnas** (las 11
  lecturas del código y los 19 dependientes no cambian) + `units_unverified` (lo que el precio no
  confirmó, DECLARADO) y `computed_at`.
- ⭐ **Sólo días cerrados**, como la matvista. Medido con un agente sobre todos los consumidores:
  ninguno doble-cuenta (todos cortan con `max(business_date)` exclusivo), pero tres cambiarían de
  sentido con el día parcial (ventana de experimentos de precio, conciliación vecinal, venta del
  mes en la ficha). Hoy sigue llegando por los caminos en vivo que ya existen.
- **Por evento, sin nocturno:** los triggers de `kdm1`/`kdm2` sólo ANOTAN (sucursal, día) en
  `kepler_sales_daily_pending` (la ingesta: ~15 sentencias/min de ~2 ms; recalcular adentro la
  frenaría ×300); cada sentencia recalcula a lo más UN día cerrado quieto 20 s (1–2 s). El día se
  cierra en la primera sentencia después de medianoche. Catálogo (producto, marca, almacén,
  etiqueta) se corrige EN SU LUGAR; vendedor, cambio de SKU, baja y alta re-encolan sus días.
- **La ficha del día** sale de `kepler_ficha_history` (PQ.59) por renglón, con índice: un cambio
  de ficha de hoy no toca un día cerrado.
- **Árbitro que alarma:** `kepler_sales_daily_arbitro()` lo llama el lugar del refresco nocturno
  (commit `925833664`, desplegado ANTES que la migración): si no está sana, su latido lo dice y
  lo que depende no se refresca.
- **La cadena** se captura viva (definición, opciones, dueño, permisos, índices, comentarios) y se
  rehace; las matvistas nacen vacías y se pueblan después en el orden que imprime la migración. La
  captura ABORTA si encuentra algo que no sabe rehacer (reglas, triggers, funciones que usen el
  tipo de fila).

**Medido (prod, sólo lectura, historia completa ene-2025 → ayer):** 110 s para todo. Filas y
monto **idénticos** a la matvista (1,096,639 filas). Unidades: 6,259 productos iguales, 51 con
cambio < 5 %, **61 suben** (331.6 k → 470.8 k unidades; el paquete contado como pieza) y **4 bajan**
(un «CJA» con precio de pieza multiplicado por la caja; 94200: 11,473 → 5,986). Árbitro
independiente — precio promedio ÷ costo base: con las unidades viejas daba 2.1–5.2 (o 0.25), con
las nuevas **1.02–1.30**, un margen. 79.9 k unidades quedan declaradas sin arbitrar.

**Rendimiento, con su error:** la primera versión cruzaba renglones contra llaves de ficha en un
bucle anidado (≈4 M comparaciones por día, cuadrático): un mes no terminaba en 10 min y la historia
pasaba de 20 min. Con la búsqueda por renglón (índice `ix_kfh_llave`): un día 1–1.8 s, un mes 25 s.

**Pruebas:** `test-newdb-pq61-venta-diaria.js` 32/32 contra Postgres 18 local; mutantes muertos:
paquete a pieza, drenar hoy, monto inflado (el control aborta), sin red de errores, ficha de hoy
hacia atrás, vendedor que no re-encola, permisos sin vestir. Spec del servicio 10/10 (mutante: 2
rojos).

**Pendiente:** soltar `925833664` (el clasificador lo frenó: lo suelta el PM), aplicar la migración
fuera de horario y poblar las matvistas de la cadena. ⚠️ Deuda con nombre: los caminos EN VIVO de
hoy (`VENTA_VIVO_SQL`, `fn_new_products_movimientos`) siguen con la regla vieja de unidades: el día
de hoy de esos 65 productos se cuenta distinto que su historia hasta que se cierre.

---

## 19. Freno de demanda con etiqueta de temporada — historia y medición de Muertos/Halloween (2026-11-09)

Francisco: *«hagamos la historia del freno de demanda para que Compras esté enterado de dónde aplica
la regla; analicemos los productos de Día de Muertos y Halloween, que están frescos, y cómo lo
informamos; el freno puede tener la etiqueta de qué temporalidad está teniendo»*.

**Evidencia:** nivel B (prod en sólo lectura como `francisco`, `system_identifier
7688376744939610156`; plan del motor calculado el 9-nov 21:50; venta hasta el 9-nov). Nivel A no.
Consultas fuera del repo: `C:\DEV\_tmp\temporada\` (`cls.sql`, `s9.sql`–`s11.sql`).

### 19.1 Qué frena hoy y qué no

| Freno | Dónde | Qué hace | ¿Lo ve el comprador? |
|---|---|---|---|
| **Fin de pico** (AB.17) | `fpico` en el motor común | Tras un pico real (más de 2× lo normal) que ya pasó, pide con la venta normal. **Exige venta regular** (6 de 8 semanas) y existencia 6 de 7 días | **No** (PQ.UI.10, AB.UI.7) |
| **Factor de temporada** | `seasonCte` | Índice mensual de un año; piso 0.5; los meses en cero no cuentan (§15.1) | No |
| Fin de temporada (D27, D30) | — | **No existe**: PQ.45 ⬜, espera la vista de D17 | — |

### 19.2 Muertos/Halloween, medido a una semana del cierre

**Universo (cota, no regla):** productos con 60 % o más de su venta de 2026 entre el 1-sep y el
2-nov y $5 mil o más en esa ventana, más los que tienen nombre de la temporada (calavera, calaca,
Halloween, catrín, bruja, calabaza, muerte, fantasma, vampiro, tumba, Boo…). **277 productos.**
Se comparó el ritmo diario del 3 al 8 de noviembre contra el del 20-oct al 2-nov:

| Clase | Productos |
|---|---:|
| Siguen vendiendo (piñata, lanzamientos, venta que sigue) | 154 |
| Navidad por nombre (empieza) | 15 |
| **Cayeron** (ritmo después del 2-nov < 25 % del de antes) | 108 |

De los 108, 87 vendieron en alguna sucursal en esas dos semanas. Se separaron con la foto de
existencia (`stock_snapshots`, noches del 2 al 7-nov), por el peso de la venta de cada sucursal:

| Grupo | Productos | Confirmada en 2025* | Venta 20-oct–2-nov | Venta 3–8 nov | Existencia a costo | El motor aún pide (pares · cajas · costo) |
|---|---:|---:|---:|---:|---:|---|
| **A** · nombre de Muertos/Halloween, con mercancía | 13 | 9 | $77 mil | $1 mil | $47 mil | 27 · 58 · ~$26 mil |
| **A'** · nombre de Muertos/Halloween, **agotado** donde más vendía | 26 | 18 | $199 mil | $1 mil | $41 mil | 87 · 497 · ~$139 mil |
| **B** · sin nombre, cayó **con** mercancía | 30 | 4 | $473 mil | $32 mil | $953 mil† | 44 · 330 · ~$151 mil |
| **C** · sin nombre, cayó **sin** mercancía | 18 | 1 | $256 mil | $11 mil | $59 mil | 39 · 532 · ~$197 mil |

«Con mercancía»: las sucursales con 70 % o más de la venta de esas dos semanas tuvieron existencia
5 de las 6 noches. Si no, cuenta como agotado.

\* El año pasado vendió del 15-oct al 2-nov y en noviembre cayó a menos de una cuarta parte del ritmo.
Las demás no tienen historia de 2025 en el ODS (§15.1 #4).
† Incluye ~$319 mil de `97392 CHOC BON-BON GRANEL` en el CEDIS 00 (998 cajas): **unidad SIN
VERIFICAR**, no se cita como existencia parada hasta arbitrarla.

**«El motor aún pide»** es el pedido **crudo a 21 días** con la fórmula de la pantalla
(`demanda × factor × 21 ÷ caja − existencia − tránsito`), **antes** de la regla del reorden (D33):
es una cota superior, no lo que sale en Pedido. Las cifras están en pesos a costo y a nivel de par.

**Lo que dice:**

1. **Los 39 productos con nombre de Muertos/Halloween siguen pidiéndose: 114 pares, ~555 cajas,
   ~$165 mil a costo. El freno de fin de pico frena 0.** No es un defecto de AB.17: por diseño excluye
   lo que no se vende parejo.
2. **El patrón de venta solo no basta.** «Cayó después del 2-nov» junta tres cosas distintas:
   la temporada que terminó, la promoción o el pico que pasó (B) y **el agotado** (C). Ejemplo de C:
   `95775 PELAFRUT MANGO` vendía todo el año ($520 mil de enero a agosto) y cayó por falta de
   mercancía. Frenarlo pediría menos justo cuando falta (lo mismo que AB.17 ya evita).
3. **En temporada, agotarse al cierre es lo que se busca, no venta negada.** 26 de los 39 se
   agotaron donde más vendían, y en 18 de ellos el año pasado también se desplomó en noviembre (en el
   grupo C, sólo 1 de 18). Para AB.17 «sin mercancía» quiere decir «no frenes»; para un producto de
   temporada que ya cerró quiere decir «salió bien, no lo repongas». **Lo que distingue un caso del
   otro es saber en qué temporada está el producto**, y eso lo dice un calendario, no la venta.

### 19.3 La historia

> **Como** comprador (Compras en `/compras/pedido`, la sucursal en `/almacen/autoabasto`),
> **quiero** ver en cada renglón qué freno de demanda le aplicó el sistema y de qué temporada viene,
> **para** saber por qué el sugerido bajó (o por qué no bajó) y decidir sin adivinar.

**Las etiquetas** (una por renglón, la que manda; en llano y con su evidencia):

| Etiqueta | Cuándo | Qué hace con el sugerido | Evidencia que se muestra |
|---|---|---|---|
| **Fin de temporada · Día de Muertos** | la temporada del calendario terminó y el producto pertenece a ella | sugiere 0, se puede pedir a mano (D27, D30) | «Vendió 25 cajas del 20-oct al 2-nov; desde el 3-nov, 0.1 al día. Noviembre 2025: 0» o «sin año anterior» |
| **Temporada en curso · Navidad** | estamos dentro de la ventana | no frena; avisa | «Lo vendido sube desde el …» |
| **Fin de pico** | AB.17 (ya existe) | pide con la venta normal | «La semana pasada vendió menos del 40 % de su semana más alta» |
| **Venta única** | PQ.47 / D31 | saca esa venta del promedio | «Incluye una venta única a <cliente> el 16-oct» |
| **Agotado N días** | PQ.42 / PQ.45 | **sube**: demanda sobre días con existencia | «Pedido sobre 18 días con existencia de 29» |

**Criterios de aceptación** (verificables):

1. La misma etiqueta y el mismo número en Pedido y en la mesa de Autoabasto (motor común).
2. Un renglón sin freno no lleva etiqueta: la etiqueta no decora.
3. La cantidad sigue editable (D27). Al subirla sobre un freno, el motivo es obligatorio y se
   registra contra la etiqueta, para medir cuándo el comprador corrige al sistema.
4. Un filtro «Con freno» con el conteo por etiqueta: **dónde aplica la regla**, en una vista.
5. Lo que no se puede afirmar se declara: «Temporada sin confirmar (sin año anterior)».
6. **Controles:** `39025 PAL CALAVERITAS` → «Fin de temporada · Día de Muertos»;
   `95775 PELAFRUT MANGO` → **sin** fin de temporada (agotado); `17050 ALTOS NAVIDEÑA` → «Temporada en
   curso · Navidad»; el bombón 70012 de AB.17 → «Fin de pico».

### 19.4 Cómo se construye (en orden, sin abrir fase)

| Item | Capa | Qué | Depende de |
|---|---|---|---|
| **PQ.93** | C0 | Esta medición y el informe a Compras (§19.5) | — |
| **PQ.94** | C0 → C1 | **Calendario de temporadas** como definición de negocio (fase DP: se pregunta y contestarla es configurarla; dueño: Compras): nombre, ventana, si la fecha es móvil. **Vista `derive-no-copy`** producto × almacén → temporada, estado (en curso · terminó · fuera), evidencia 2025. El patrón de venta **propone** candidatos; Compras confirma | D35 |
| **PQ.95** | C3 | La etiqueta en las dos pantallas y el filtro «Con freno». Absorbe PQ.UI.10, AB.UI.7 y la parte visible de PQ.46. Puede salir **antes** de PQ.45 como aviso (fin de pico ya tiene su `season_src`) | PQ.94 |
| PQ.45 | C1 | La etiqueta «Fin de temporada» **frena** (sugiere 0) en la vista de demanda de D17 | PQ.94 · D17 |

⛔ Nada de esto va a `import-replenishment-plan.js` (regla 1, D17).

### 19.5 Cómo se le informa hoy a Compras (antes del código)

La lista de los 87 productos, con su grupo, la venta antes y después del 2-nov, la del año pasado,
la existencia y lo que el motor pide por sucursal, está en
`C:\DEV\_reportes\temporada-muertos-halloween-2026-11-09.csv` (**fuera del repo: el repo es
público**). Se le entrega a Compras con tres instrucciones:

- **A y A' (39):** no reponer. Lo que sobró (A, $47 mil) va a Sobrante.
- **B (30):** revisar uno por uno: ¿era promoción o pico? Bon-Bon 97392: verificar la unidad del
  CEDIS antes de decidir.
- **C (18):** **no** es fin de temporada: se agotó. Reponer si sigue en catálogo.

### 19.6 Decisión nueva

| # | Decisión | Opciones | Recomendación |
|---|---|---|---|
| D35 | ¿Quién dice que un producto es de temporada? | (a) un calendario con dueño + el patrón de venta propone y los dueños confirman · (b) sólo el patrón de venta · (c) sólo el nombre | ✅ **Contestada por Francisco el 2026-11-10: (a), y los dueños son Compras, Mercadotecnia, Dirección Comercial y Dirección General.** (b) frena los agotados (grupo C, $197 mil) y (c) es un filtro de control: deja fuera productos sin la palabra (`12517 PAL PARCA`, `03010 PAL ATAUD`). Falta que el PM la ratifique |

### 19.7 La regla de negocio: compra única y remate (Francisco, 2026-11-10)

*«Es compra única, es un remate.»* Cambia lo que hace el freno:

| | Antes (D27, D30) | Con la regla |
|---|---|---|
| Durante la temporada | el motor repone como cualquier producto | **no repone**: el producto de temporada se compra **una vez**, como decisión de Compras, no por sugerido. Etiqueta: **«Compra única · Día de Muertos»** |
| Al terminar | sugiere 0, se puede pedir a mano | sugiere 0 **y lo que queda pasa a remate**. Etiqueta: **«Remate · Día de Muertos»** |
| Lo que sobra | Sobrante (§15.3 #5) | **Remate**: lista por sucursal para Mercadotecnia y Dirección Comercial, no traspaso |

⚠️ **Supuesto por confirmar:** que «compra única» quiere decir **ninguna reposición dentro de la
temporada** (ni siquiera si se agota el 25-oct). Si se permite una reposición, el motor sólo la
sugiere hasta una fecha de corte que fija el calendario.

**Remate de Muertos/Halloween, medido el 2026-11-10** (existencia del plan a costo): **43 productos,
~254 cajas, ~$102 mil** (39 por nombre, ~$88 mil, más 4 confirmados por 2025, ~$14 mil). Por
sucursal: Canindo $37 mil · Padre Hidalgo $28 mil · Morelia Abastos $10 mil · La Piedad Abastos
$9 mil · Zamora Centro $7 mil · 8 Esquinas $5 mil · Morelia Madero $3 mil · Yurécuaro $2 mil.
⛔ **Se sacó `20000 CANELS EL PIÑATERO`** ($131 mil): también cayó en noviembre de 2025, pero es
de posadas, no de Muertos. Es justo el caso por el que el patrón propone y los dueños confirman.
Lista: `C:\DEV\_reportes\remate-muertos-halloween-2026-11-10.csv` (fuera del repo).

**PQ.94** agrega al calendario la fecha de compra y la de remate; **PQ.95** usa las etiquetas
«Compra única» y «Remate»; y hay que sumar una vista de remate por sucursal (**PQ.96**, C1→C3).

### 19.8 El módulo: Compras › Temporadas (propuesta, 2026-11-10)

Francisco: *«hay productos que son de temporada y se resurten con cadencia anual; ¿cómo propones el
módulo de consulta y en qué parte de la Suite viviría? El informe ejecutivo, que lo genere asistido
con IA; y un informe preliminar para prevenir stock estancado o remate forzado por término de
temporada.»* Maqueta (fuera del repo): `C:\DEV\_reportes\maqueta-temporadas.html`.

**Dos atributos por producto, no uno** (corrige el supuesto de §19.7):

| Atributo | Valores | Qué cambia |
|---|---|---|
| **Recurrencia** | anual (vuelve cada año) · sólo este año | la anual se planea con lo que se vendió el año anterior y **lo que sobró** |
| **Reposición dentro de la temporada** | compra única · se puede reponer hasta una fecha de corte | si se puede reponer, el motor sugiere hasta esa fecha y después sugiere 0 |

**Los doce pasos (skill `diseno` §0a), en una línea cada uno:**

1. **Propósito:** ¿qué producto de temporada va a terminar con sobrante, y qué hago antes de que pase?
2. **Quién entra:** Compras opera (confirma el calendario, planea la compra); Mercadotecnia, Dirección
   Comercial y Dirección General leen y reciben el informe. Uso medido: **NO MEDIDO** (`pm/uso.js`
   no autentica en esta máquina).
3. **El estado real:** Muertos cerró con ~$102 mil para remate (§19.7). En Navidad, el preliminar del
   10-nov da **18 productos con historia de 2025 y ~$1.25 M a costo de sobrante esperado** (Piñata pack
   Tinajita, Colación Dulandy, Galletas animalitos). **Instrumento sin validar**: curva de 2025 por la
   venta de 2026 hasta hoy, con 2025 en 5 sucursales (corregido por §19.9; aquí decía 3). ⛔ **§19.9 lo
   tumbó**: no le gana al control ingenuo; no se cita.
4. **Nivel 0:** la temporada en curso, los días que faltan y cuánto puede sobrar, en una frase.
5. **No ve:** las temporadas lejanas (quedan en Calendario); los productos sin riesgo (a un clic, con
   su conteo).
6. **Desglose:** sobrante esperado → producto → sucursal (side-peek, con la curva de 2025 contra 2026)
   → Existencia y Pedido con el filtro puesto.
7. **Accesibilidad:** por nombre de producto y de sucursal (nunca por código); orden por sobrante
   esperado; buscable.
8. **Ligas:** Pedido y la mesa de Autoabasto muestran la etiqueta (PQ.95); el remate va a la lista
   por sucursal (PQ.96); el traspaso sugerido a la mesa de Autoabasto.
9. **¿Le toca?** Consulta y decisión, sí. El precio del remate lo pone Mercadotecnia en su proceso:
   la pantalla lo pide, no lo captura.
10. **Maqueta:** el archivo de arriba. Cuatro vistas: **Calendario · En curso · Cierre y remate ·
    Informes**.
11. **Criterios:** los de §19.3 más los del informe (abajo).
12. **Lo que la interfaz no resuelve:** la historia de 2025 en 6 de 9 sucursales (C0); quién confirma
    el calendario (D35, falta ratificar); el proveedor de IA (ADR-007 sigue abierto; la Suite ya usa
    Claude en NP.7, apagado por D6).

**Dónde vive:** grupo **Compra** del menú de Compras, renglón **Temporadas**, entre Alertas de abasto
y Pedido (se mira antes de pedir, como Existencia). Permiso nuevo `COMPRAS_TEMPORADAS_VER` (lectura,
repartido también a Mercadotecnia y Dirección) y `COMPRAS_TEMPORADAS_GESTIONAR` (confirmar el
calendario y los productos). Regla 20: no está entregado hasta que el permiso esté repartido.

**Los dos informes:**

| | Preliminar | De cierre |
|---|---|---|
| Cuándo | 3 semanas y 1 semana antes del fin de cada temporada | el día siguiente al cierre |
| Qué contesta | qué puede sobrar y qué hacer ya: no reponer, mover a otra sucursal, adelantar la promoción | qué quedó para remate, dónde, y cómo cerró contra el año anterior |
| Para | Compras, Mercadotecnia, Dirección Comercial y General | los mismos |

**Asistido con IA, con el contrato §X de `DESIGN.md`:** el motor (SQL) calcula todas las cifras; la
IA sólo **redacta** alrededor de ellas. Cada cifra del texto es un dato del sistema, se ve marcada y
se verifica contra la tabla antes de enviar (si el texto trae un número que no está en la tabla, no
se envía). El informe dice «Redactado con IA a partir de las cifras del sistema», se puede editar y
lo envía una persona. Sin proveedor de IA encendido, sale la versión con plantilla.

**La etiqueta se carga en el Catálogo (Francisco, 2026-11-10).** *«En el catálogo ampliado o digital,
¿podemos manejar la etiqueta de temporada, para cargarla a cada producto?»* Sí, con un matiz medido:
el Catálogo digital (`catalog.product_sheets`) tiene hoy **12 fichas (7 publicadas) y 0 con `ampliado`**,
contra 43 productos sólo en el remate de Muertos. Si la temporada viviera dentro de la ficha, casi
ningún producto de temporada la tendría. Por eso:

- **Dónde se guarda:** una tabla propia de la Suite, producto × temporada (temporada, recurrencia,
  reposición, fecha de corte, quién confirmó y cuándo), con `tenant_id` y auditoría. Es dato propio
  (regla 1 lo permite), no copia de Kepler. Va con el calendario de PQ.94.
- ~~Dónde se carga y se ve (dos puertas, un dato)~~ — **corregido el mismo día, abajo: una sola puerta
  de escritura.**
- ⛔ No en `catalog.products`: es la copia del catálogo que D17 deja fuera del motor y que discrepa del
  ERP (`UNIDADES_DE_MEDIDA.md`).
- ✅ **D36, contestada por Francisco el 2026-11-10:** *«en el catálogo de la Suite y no en la copia del
  catálogo de Kepler»*. La temporada es un dato propio de la Suite, en su tabla, ligado al producto por
  su clave; nunca una columna en la copia de Kepler.

**Arquitectura: ¿lista desde Temporadas o etiqueta en el catálogo? (revisado 2026-11-10, a pedido de
Francisco)** — las dos son la misma tabla vista desde dos lados; lo que se decide es **dónde se escribe**.

| | Etiqueta en el producto (columna) | **Lista por temporada (tabla producto × temporada)** ✅ |
|---|---|---|
| Lo que puede guardar | una temporada por producto, sin fechas ni reglas propias | varias temporadas por producto (piñata: posadas y Día del Niño; chocolate: San Valentín y Madres), cada una con su recurrencia, reposición y fecha de corte, y quién la confirmó |
| Cómo se trabaja | producto por producto: hay que saber cuáles abrir | por temporada y por lote: el sistema propone 50–150 candidatos y se confirman juntos antes de la fecha de compra |
| Evidencia de adopción | la captura producto por producto del Catálogo digital lleva **12 fichas** (NP.7) | — |
| Lectura (medido 2026-11-10) | igual: unión por producto | plan de 43,445 renglones en ~19 ms; unirle 600 productos de temporada, **+~18 ms** (`EXPLAIN ANALYZE`, sólo lectura). Muy por debajo de los 500 ms |

**Decisión técnica (ADR al construir):**
1. **Datos:** en el esquema `catalog` de la Suite (D36), tres tablas pequeñas con `tenant_id` y
   auditoría: `catalog.seasons` (nombre, fecha fija o móvil) · `catalog.season_dates` (temporada × año:
   venta, compra, corte, remate) · `catalog.season_products` (temporada × producto: recurrencia,
   reposición, fecha de corte propia si difiere, confirmado por y cuándo; único por temporada y producto,
   índices por las dos llaves).
2. **Una sola puerta de escritura: Temporadas.** Un endpoint con su validación y su permiso
   (`COMPRAS_TEMPORADAS_GESTIONAR`). Dos formularios que escriben lo mismo son dos caminos que se
   desincronizan (el caso de `POST /cortes/:id/contar`, CLAUDE.md regla 13). El catálogo **muestra** la
   etiqueta y su botón «Agregar a una temporada» abre el mismo flujo; no tiene formulario propio.
3. **Una vista derivada** `v_product_season_status` (producto → temporada vigente y estado hoy: antes de
   compra · en venta · pasado el corte · en remate), fresca sin mantenimiento. La leen el motor (PQ.45),
   Pedido, la mesa de Autoabasto, el Catálogo y el portal. Nadie copia el dato.
4. **La etiqueta viaja en la misma respuesta** de Pedido y del catálogo, calculada en SQL. ⛔ Nunca una
   llamada por producto desde la pantalla (N+1).

**Prueba visual de la maqueta (2026-11-10, nivel A sobre la maqueta, no sobre la Suite)** — Chromium
a 1366×768 y 390×844, claro, oscuro y `forced-colors`; capturas en `C:\DEV\_tmp\temporada\ux\`.
Son criterios de aceptación de PQ.99, ids `PQ.UI.T1–T8`:

| # | Sev | Lo que vería el usuario (medido) | Criterio |
|---|---|---|---|
| T1 | 🔴 | La respuesta de arriba publica «~$1.25 M» como cifra firme, sin el error medido (§19.9: a 3 semanas el error por producto es del orden del monto). El informe dice «con el ritmo actual» y el método era la curva de 2025; «las 7 cifras coinciden con la tabla» y esa tabla no se ve | el preliminar publica **rango y error medido** («entre $X y $Y; a 3 semanas el error es ±N %»); el informe nombra el método real; la tabla contra la que se verifica se abre desde el aviso |
| T2 | 🔴 | «Qué hacer», la acción, sale **cortada** en escritorio (tabla de 847 px en 761) y en celular quedan fuera sobrante y acción; la página se desborda 8 px a lo ancho | la acción cabe sin desplazar a 1366 px; en celular la fila se apila (producto · sobrante · acción); 0 px de desborde |
| T3 | 🟠 | La franja mezcla universos: «$4.14 M existencia» y «$6.11 M venta proyectada» son 84 productos y «18 con sobrante» es otro corte: se lee como contradicción. El detalle mezcla costo y precio en la misma lista | cada cifra dice su universo; costo y precio no comparten lista |
| T4 | 🟠 | El proceso no termina: Calendario pide «confirmar productos» (52 de Navidad, cuya compra era el 1-oct) y no hay control para confirmar; Cierre dice «cada sucursal abre su lista» y tiene 0 controles; «—» no distingue cero de «sin dato» | botón «Confirmar productos» por temporada, con fecha límite = fecha de compra; la fila de sucursal se abre; «sin confirmar» en palabras |
| T5 | 🟠 | Marco contra trabajo: la primera fila de trabajo está en y = 523 de 768 (68 % de la primera pantalla es aviso, encabezado, respuesta y franja). «18 productos» se repite 3 veces y «$1.25 M» 2 | la franja se funde con la respuesta; la primera fila arriba de 400 px |
| T6 | 🟠 | El color de acción cumple 4 papeles (cifras de la respuesta, pestaña activa, etiqueta «Compra única», botón principal); la letra mono se usa también en palabras («preliminar de Navidad») | acción sólo en botón principal y selección; cifras en el color del texto; mono sólo en números |
| T7 | 🟠 | Etiquetas en acción sobre su fondo suave: **4.42:1** (< 4.5) a 10–11.5 px. Pestañas de 32 px (< 44 en táctil). Con `forced-colors` la fila elegida pierde el resaltado: no se sabe qué producto está en el detalle | ≥ 4.5:1 (controles 21.00 y 4.48 en el script); 44 px en `pointer: coarse`; selección con borde, no sólo fondo |
| T8 | 🟡 | El calendario va de enero a diciembre: Muertos (en remate) queda al final y lo próximo no va primero | orden: en curso → próxima → en remate → el resto |

Pasa: respuesta primero en las 4 vistas; sucursales por nombre; oscuro sin fallas de contraste (todas ≥ 4.56:1);
la IA se ve como IA y se edita antes de enviar; los estados llevan palabra, no sólo color. **NO MEDIDO:**
recorrido completo con teclado, lector de pantalla, zoom al 200 %, rendimiento, y listas con volumen real
(la maqueta tiene 8 renglones).

**Items:** PQ.97 (preliminar, C0 → C1: el instrumento con su backtest) · PQ.98 (informes asistidos
con IA, C2 → C3) · PQ.99 (la pantalla Temporadas, C3). Orden: PQ.94 → PQ.97 → PQ.96 → PQ.99 → PQ.98.

**Lo que esto no es:** grano de par en pesos a costo y pedido crudo de 21 días; la temporada 2025 se
mide sólo donde el ODS tiene ese año; el grupo B mezcla promociones y lanzamientos sin separar.

### 19.9 PQ.97 — backtest del preliminar (2026-11-10)

**Pregunta:** ¿el preliminar de §19.8 (curva del año anterior escalada por cómo va este año; si no hay
año anterior, ritmo de 2 semanas) acierta quién termina la temporada con sobrante, y le gana a no
tener método? **Evidencia nivel B** (prod en sólo lectura como `francisco`, `system_identifier`
`7688376744939610156`; capa C0). Scripts fuera del repo: `C:\DEV\_tmp\temporada\pq97\bt.js`
(`node bt.js muertos 2026-10-12 --csv`); listas con nombres y montos por producto en
`C:\DEV\_reportes\pq97-backtest-*.csv` (el repo es público).

**Cómo se midió**

- **Se corrió como si fuera el 12-oct (3 semanas antes del 2-nov) y el 26-oct (1 semana), sólo
  con datos hasta esa fecha**: venta en `analytics.sales_daily`, existencia de esa noche en
  `analytics.stock_snapshots`. **Árbitro:** la existencia real en la foto del 3-nov. «Quedó con
  sobrante» = $2,000 o más a costo; «en riesgo» = la regla del preliminar (existencia > 1.2 × venta
  proyectada y > $2,000), **sin tránsito** (no hay histórico del tránsito al corte: NO MEDIDO).
- **Grano: producto × sucursal, 8 sucursales (Padre Hidalgo a Morelia Abastos), sumado a red.**
  ⛔ **CEDIS excluido:** su foto antes del 7-nov está incompleta (235 productos con $4.0 M aparecen
  recién el 7-nov; antes había ~200 filas contra ~3,000 por sucursal). `MD-32` (foto congelada,
  2,823 filas siempre) excluido.
- **Unidad y costo, declarados:** todo en **unidades × costo por pieza del plan**
  (`caja_cost ÷ display_bf`), misma base para venta y existencia. **Control** `39025 PAL
  CALAVERITAS` en Padre Hidalgo: plan 14 pz = foto 14 unidades; costo 46.86 (plan, sin IVA) contra
  50.61 (`stock_snapshots.valor`, con IVA) y 51.74 (`sales_daily.cost`): tres bases distintas, se
  eligió la del plan porque es la que usa el motor. `44227` en CEDIS: 7,000 = 7,000. **`97392
  CHOC BON-BON GRANEL` excluido** (unidad sin verificar: la foto lo valúa a $338.75 la unidad en
  CEDIS y a $31.97 en sucursales). 228 productos sin costo en el plan quedaron fuera.
- **Universo U0 = el del preliminar:** 60 % o más de la venta de 2025 entre el 1-sep y el 2-nov y
  $5 mil o más, **o** nombre de Muertos/Halloween con venta en 2026. **141 productos; 46 quedaron
  con sobrante ($290 mil en las 8 sucursales).**
- **Controles:** (i) **trivial**: «en riesgo = tiene existencia > $2 mil; sobrante = la existencia
  de hoy»; (ii) **ingenuo** (obligatorio): existencia − ritmo de 2 semanas × días que faltan.
  ⚠️ El ingenuo **es** el método de respaldo del preliminar: la prueba real es la curva contra él.

**Resultados — Muertos/Halloween 2026, universo U0** (sobrante real al cierre: $290 mil)

| Corte | Método | En riesgo | Aciertos | Precisión | Recall | Sobrante predicho | Error medio (MAE) | Venta proyectada vs real |
|---|---|---:|---:|---:|---:|---:|---:|---|
| 12-oct (21 d) | trivial «tiene existencia» | 64 | 41 | 64 % | 89 % | $540 mil | $327 mil | — |
| 12-oct | **ingenuo** (ritmo 2 sem) | 49 | 35 | 71 % | 76 % | $315 mil | $217 mil | $433 mil vs **$487 mil** (MAE $333 mil) |
| 12-oct | **preliminar** (curva 2025 × razón 2026/2025) | 41 | 30 | 73 % | **65 %** | $279 mil | $250 mil | **$1.07 M** vs $487 mil (MAE **$1.0 M**) |
| 12-oct | curva 2025 por sucursal | 41 | 29 | 71 % | 63 % | $292 mil | $250 mil | $982 mil (MAE $908 mil) |
| 12-oct | **curva agregada 2025 × ritmo 2 sem** | 53 | 38 | 72 % | **83 %** | $351 mil | $223 mil | $354 mil (MAE $326 mil) |
| 26-oct (7 d) | trivial | 58 | 45 | 78 % | 98 % | $395 mil | $145 mil | — |
| 26-oct | **ingenuo** | 47 | 41 | 87 % | 89 % | $271 mil | $101 mil | $181 mil vs **$137 mil** (MAE $103 mil) |
| 26-oct | **preliminar** | 46 | 40 | 87 % | 87 % | $284 mil | $123 mil | **$362 mil** vs $137 mil (MAE $329 mil) |
| 26-oct | curva agregada × ritmo | 47 | 41 | 87 % | 89 % | $274 mil | $100 mil | $173 mil (MAE $98 mil) |

Sólo en los 117 productos **con historia 2025** (donde la curva aplica), a 21 días: ingenuo recall
76 % · MAE $122 mil; preliminar recall 62 % · MAE $154 mil; venta proyectada $936 mil contra $336
mil reales.

**Por qué la curva falla:** la forma cambió. En 2025 lo vendido del 13-oct al 2-nov fue **0.42×** lo
de 1-sep–12-oct; en 2026 fue **0.74×**. La razón 2026/2025 por producto (tope 3) amplifica el
ruido: proyecta **2.2× la venta real** a 21 días y 2.6× a 7. Es el mismo resultado de PQ.41 (§17.6):
copiar el año pasado a nivel producto es peor. **Lo que ningún método ve:** la reposición después
del corte. A 21 días, de los $335 mil que quedaron, **$246 mil entraron después del 12-oct**
(compras y traspasos del CEDIS a sucursal); a 7 días, $34 mil. Por eso a 1 semana todo acierta
(87–89 %) y a 3 semanas nada pasa de ~75 %.

**El universo (medido el 12-oct; verdad ex-post: «cayó» = ritmo del 3 al 8-nov < 25 % del de las
2 semanas previas)**

| Criterio | Productos | Con venta al cierre | Cayeron | No cayeron (falsos) | Existencia de los falsos |
|---|---:|---:|---:|---:|---:|
| **U0** el del preliminar | 141 | 93 | 59 | 34 | $143 mil |
| U1 concentración 2026 al corte (≥ 60 % y $5 mil) | 140 | 131 | 48 | **83** | **$2.73 M** |
| U1 ∨ nombre | 162 | 150 | 62 | 88 | $2.75 M |
| **U4 = U0 ∧ (nombre ∨ desplome en nov-2025)** | 94 | 70 | **53** | **17** | $84 mil |
| sólo nombre (control) | 58 | 49 | 43 | 6 | $25 mil |

- **La concentración de venta de este año sola NO sirve:** sus 83 falsos son botas navideñas
  (`28116`, `62137`, `70107`, `70108`), `44227 GALL ANIMALITOS` ($158 mil) y `14027 FLOPS`: dice
  «es de temporada», no **de cuál**. Eso lo dice el calendario (D35).
- **U4 saca la mitad de los falsos (34 → 17) y conserva 53 de los 59 verdaderos.** El «desplome en
  nov-2025» (vendió $5 mil o más en la ventana y el mes siguiente cayó a menos del 25 % del ritmo) es
  verificable sólo con datos del corte. Con U4 el ingenuo da precisión 68 % · recall 74 % a 21 días
  y 83 % · 88 % a 7.
- **El nombre como control:** 6 con nombre no cayeron: `33241` y `18094` (semilla de **calabaza**,
  de todo el año), `32109 PAL MALVABISCO DIA DE MUERTOS` (siguió al 117 %), `97536` y `97057` (zombie,
  26–32 %: al borde), `03007 GLOBO LA CATRINA`. Y 17 sin nombre sí cayeron (`12517 PAL PARCA` tipo):
  el patrón propone, los dueños confirman.

**Navidad 2025 (cortes 3-dic y 17-dic, fin 24-dic) — sólo la venta: el sobrante es NO MEDIDO**
(`stock_snapshots` arranca el 24-sep-2026) **y la curva del año anterior es NO MEDIDA** (no hay
2024). 2025 existe en **5 sucursales** (Padre Hidalgo, La Piedad Abastos, Canindo, Morelia Madero,
Morelia Abastos) y las rutas; no en 8 Esquinas, Yurécuaro ni Zamora Centro. Universo = nombre
navideño (79 y 88 productos).

| Corte | Método | Venta proyectada | Venta real | MAE |
|---|---|---:|---:|---:|
| 3-dic (21 d) | ingenuo (ritmo 2 sem) | $1.55 M | **$1.83 M** (−15 %) | $1.21 M |
| 3-dic | ritmo 4 sem | $1.12 M | $1.83 M | $1.14 M |
| 17-dic (7 d) | ingenuo | $577 mil | **$755 mil** (−24 %) | $513 mil |

**La dirección del error depende de la temporada:** Muertos **desacelera** hacia el cierre (lo
vendido en los últimos 21 días fue 1.23× las 2 semanas previas; lineal sería 1.5; a 7 días 0.48
contra 0.5) y Navidad **acelera** (1.78 contra 1.5; 0.65 contra 0.5): el ingenuo sobra en Muertos y
se queda corto en Navidad. El **factor agregado de la temporada anterior** (venta que faltaba ÷
venta de las 2 semanas previas, sumado sobre los productos de temporada con historia) corrige justo
eso sin pedirle a cada producto su propia curva.

**Veredicto**

1. **El preliminar tal cual NO le gana al ingenuo:** igual o peor en quién queda con sobrante
   (recall 65 % contra 76 % a 3 semanas; empate a 1) y **3× peor en la venta que falta** ($1.0 M de
   error contra $333 mil). ⛔ La cifra de §19.8 (18 productos, ~$1.25 M) **no se cita**.
2. **El ingenuo sí aporta** sobre «tiene existencia»: MAE −34 % a 21 días y −30 % a 7; precisión
   71 % → 87 % y recall 76 % → 89 % de 3 a 1 semana.
3. **Método recomendado:** `sobrante = existencia + tránsito − ritmo de 2 semanas × días que faltan ×
   factor agregado de la temporada anterior`; sin temporada anterior, ingenuo a secas y declarado.
   Empata o mejora al ingenuo (recall 83 % contra 76 % a 21 días; MAE $100 mil contra $101 mil a 7) y
   corrige el sesgo de dirección. **Universo U4** (criterio actual ∧ nombre o desplome del año
   anterior) como **propuesta** que los dueños confirman (D35), nunca como regla.
4. **Error que hay que mostrar:** a 3 semanas, de cada 10 marcados ~7 quedan con sobrante y se ve ~3
   de cada 4; **la cifra por producto tiene un error del orden del monto** (MAE $217 mil sobre $290 mil
   reales); el total agregado sí queda cerca ($315 mil predicho contra $290 mil). A 1 semana el
   error por producto baja a ~35 %. El preliminar sirve para **la lista de quién** y para **frenar la
   reposición** (lo que entra después del corte es la mitad del sobrante), no para la cifra fina.
5. **Lectura de hoy con el método recomendado, Navidad 2026 (NO validada; se da con su error):**
   universo original sin `97392`: 201 productos; curva (el preliminar) 52 en riesgo · $2.13 M;
   ingenuo 69 · $3.15 M. Con **U4** (141 productos): curva 40 · $1.57 M; ingenuo 57 · $2.44 M; **curva
   agregada 47 · $1.42 M** (factor 2025 = 5.86 contra 3.2 lineal: la Navidad vende en diciembre).
   Salen con U4, para que Compras confirme: `21013 COLACION DULANDY` ($312 mil hoy; en ene-2026 siguió
   al 35 % del ritmo), `27028`/`27029 CIMARRON BOLI ICEE`, `62051 WAFER TINAJITA`, `94156`/`94157
   CHAROLAS LEVI`, `54009 PAQUETE PIÑATERO AURUS` (posadas; cayó al 32 %, el umbral de 25 % lo deja fuera).

**NO MEDIDO:** el CEDIS (foto incompleta antes del 7-nov); el tránsito al corte (sin histórico); el
sobrante de Navidad 2025 (sin foto) y su curva (sin 2024); las 3 sucursales sin 2025; los 228
productos sin costo en el plan; `97392`; el costo se tomó del plan de hoy (constante); nivel A (ningún
comprador confirmó la lista); la verdad «cayó» mezcla fin de temporada con agotado (grupo C de §19.2).

### 19.10 PQ.94 C0 — el calendario y los productos de cada temporada, en código (2026-11-10)

Migración `20261110010537_pq94_temporadas_calendario_y_productos` (⛔ **sin aplicar en prod**: la
aplica Edgar, una por una y fuera de horario). Tres tablas en `catalog` (D36) y dos vistas que derivan:

| Pieza | Qué es |
|---|---|
| `catalog.seasons` · `catalog.season_dates` · `catalog.season_products` | temporada · temporada × año (venta, compra, corte, remate; `propuesta`/`confirmada` con quién y cuándo) · temporada × producto por **clave de Kepler** (decisión, recurrencia, reposición, motivo si se descarta). RLS forzada, auditoría, sin DELETE para la app |
| `catalog.v_season_candidates` | lo que la venta **propone** por temporada-año |
| `catalog.v_product_season_status` | dónde está **hoy** cada producto **confirmado**: `por_iniciar` · `en_venta` · `pasado_el_corte` · `en_remate`, y si se puede reponer |

**La fuente de venta se corrigió al medir (regla 10).** El prototipo leía `analytics.sales_daily`;
VERDAD_ABSOLUTA lo registra como **doble linaje** (importer, lo retira la fase SD). La venta del ODS de
Kepler (`mv_kepler_sales_daily`) tiene **2025 en una sola sucursal**: no ve la temporada pasada. La vista
lee **`analytics.mv_sellout_monthly`, el sell-out canónico** (Wincaja ∪ Kepler, 2025 completo, 16–21
almacenes por mes; control oct-2025: $54.26 M contra $55.05 M de `sales_daily`). Grano mensual: alcanza
para **proponer**; decide la gente.

**Medido en prod (sólo lectura), con el texto de la vista:** Día de Muertos 2025 → **65 candidatos en
689 ms**. Salen los esperados (22008 PAL CALAVERAS MEXICANAS, 12517 PAL PARCA, calaveras de azúcar
Evany, 96902 CHAROLA TUMBA) y también falsos (Ferrero Navidad, Trident, un renglón «Actividades de
ventas y promoción»): por eso son candidatos. ⚠️ **689 ms > 500 ms**: la API (C2) guarda el resultado por
temporada-año, porque una temporada pasada no cambia. ⛔ Una segunda materialización de la venta no
(regla 2).

**La siembra es propuesta (ADR-056):** ~~8 temporadas con las ventanas de la maqueta~~ — **corregida el
mismo día por §19.11**: las 7 temporadas del Plan Anual de Mercadotecnia 2026 y 14 temporada-año con la
ventana de venta **del mayorista**, `status = 'propuesta'`, **sin fecha de compra ni de corte** (nadie
las definió). La vista de estado sólo lee lo **confirmado**: lo propuesto no frena ni etiqueta nada.

**Pruebas:** `database/tests/test-newdb-pq94-temporadas.js` **45/45** (era 37/37 antes de §19.11) contra Postgres 18 local
(transacción revertida). Cubre cada CHECK con su código exacto, la unicidad, la llave compuesta contra
otro tenant, el estado de hoy (pasado el corte y compra única no se reponen; por iniciar «hasta el
corte» sí), que lo propuesto, lo descartado y el «sólo un año» de otro año **no aparecen**, que el plan
de candidatos filtra la temporada-año antes de agregar la venta, la RLS con `app_runtime` en tablas y
vistas, DELETE 42501, y que `down()` se niega con decisiones. **Pruebas negativas:** sin el filtro
«confirmada», rojo justo en ADR-056 (la fecha propuesta publicaba «en venta, se repone»); sin el motivo
al descartar, rojo. Ciclo real `up → down → up` en limpio: crea, quita y vuelve a crear las 5 piezas.
`check:migrations` y `check:mig-colisiones` (contra el ledger de prod) en verde.
**NO MEDIDO:** el resultado de candidatos en la base local (`mv_sellout_monthly` sin poblar ahí; medido
en prod con el prototipo).

**Sigue (C2):** el endpoint que escribe —una sola puerta— y la pregunta en DP (`config_ref` a
Temporadas, con dueño y fecha límite = fecha de compra), con su prueba contra base real y el payload de
la pantalla (regla 13).

### 19.11 La base de partida: propuesta de temporadas × productos desde la historia (2026-11-10)

Francisco: *«leer el histórico para construir nuestra base; a futuro sólo Kepler (cuando toda la
operación esté ahí); hoy, Wincaja del año pasado más el avance de Kepler conforme se migraron las
sucursales, para no partir de estimados sin fundamento»*. Y entregó el **Plan Anual de Mercadotecnia
2026 de Mega Dulces** (Dirección General, 15-ene-2026, dirigido a Distribuidora De la Rosa).

**La fuente ya hace lo que pide.** El sell-out canónico (`v_sellout_daily` / `mv_sellout_monthly`) une
Wincaja hasta el cambio de cada sucursal y Kepler desde entonces (`v_branch_erp_cutover`: La Piedad
oct-2025; Padre Hidalgo jun-2026; Canindo ago-2026; las dos de Morelia y el CEDIS sep-2026; 8 Esquinas,
Yurécuaro y Zamora nacieron en Kepler). Conforme Wincaja se apague, el módulo queda en Kepler sin
cambiar nada. Peso de Kepler en la venta de cada temporada: 2025 entre 0 y 5 %; primer semestre de 2026
~15–18 %; Patrias 2026 65 %; Muertos 2026 91 %. Historia útil: **2025 y 2026** (lo anterior son
renglones sueltos): Navidad tiene **un solo año**.

**La lista de temporadas sale del plan anual, no de la maqueta.** «Eventos de temporalidad»: San
Valentín, Día del Niño, Día de las Madres y del Padre, Fiestas Patrias, Día de Muertos, Navidad. Reyes
(la Cabalgata) y la Candelaria son eventos: **la Candelaria es la cola de Navidad** («última venta de
temporada navideña, levantamientos»; la oferta TOP de la Bota Mediana De la Rosa del plan dice
«vigencia al 2 de febrero»). Tianguis de Semana Santa (temporada de calor), Regreso a Clases y el
Aniversario (5–23 oct, 3 % general, encima del pico de Muertos) son eventos comerciales, no temporadas
de compra única.

**⭐ La temporada del mayorista va adelantada a la del consumidor** (curva semanal de los productos con
nombre de cada temporada, 2025 y 2026; las dos dibujan lo mismo):

| Temporada | Ventana de venta medida | Señal |
|---|---|---|
| San Valentín | 5-ene → 14-feb | ~3× lo normal desde la primera semana de enero |
| Fiestas Patrias | 15-ago → 16-sep | ~1.5×, débil |
| Día de Muertos | 1-sep → 2-nov | de 3 % de su nivel a >$100 mil/semana desde fin de sep; la semana del 3-nov cae a 3 % |
| Navidad y posadas | 20-oct → 24-dic (remate y levantamientos hasta el 2-feb) | fuerte del 24-nov al 21-dic; las piñatas pegan en diciembre |
| Niño, Madres, Padre | estimadas (~4 semanas antes) | la curva por nombre no se ve (estuchería, chocolate): NO MEDIDO |
| Reyes | — | **sin señal de producto** (no se vende rosca) |

Con la ventana del consumidor (10-oct a 2-nov), `22008 PAL CALAVERAS MEXICANAS` tenía 31 % de su año en
la temporada y no se detectaba. **Control de que la ventana es la correcta — la repetición entre
años** (de lo detectado en 2025 que siguió vendiendo en la ventana de 2026, cuánto se vuelve a detectar):
Muertos **1 de 16 → 26 de 58 (45 %)**; San Valentín **2 de 8 → 17 de 36 (47 %)**; Niño, Padre y Patrias
**0 %** (señal débil: lo que sale son sobre todo productos que sólo aparecen en 2026). De los 29 de
Muertos 2025 que «no volvieron», 21 sí vendieron en 2026 fuera de temporada (el sobrante del año
anterior, sin recompra) y 8 no vendieron: las claves son las mismas, no es un cambio de clave
Wincaja → Kepler.

**El entregable:** `C:\DEV\_reportes\propuesta-temporadas-productos-2026-11-10.csv` (fuera del repo):
**495 propuestas**, grano diario, con confianza **alta** (se detectó los dos años: 17 San Valentín, 26
Muertos), **media** (un año, con nombre o desplome; toda Navidad, por tener un solo año) o **baja**
(primera venta poco antes de la temporada: puede ser lanzamiento); recurrencia sugerida; venta, % de su
año y desplome en 2025 y 2026; % de la venta en Kepler; primera venta; existencia de hoy. Cobertura por
temporada-año en `propuesta-temporadas-cobertura-2026-11-10.csv`. Hallazgo: `44227 GALL ANIMALITOS 5KG`
vendió **95 % de su año** en la ventana de Navidad 2025: es producto de aguinaldo, no «de todo el año».

**Lo que cambió en PQ.94 por esto:** siembra con la lista del plan anual y las ventanas del mayorista;
la vista de candidatos usa la regla de **la mitad del mes** (`fn_season_window_months`), que contra el
análisis diario recupera **93 %** (Muertos 2025), **94 %** (San Valentín 2026) y **75 %** (Navidad 2025:
la preventa de fin de octubre no llena medio mes) en ~0.9 s. El diario (~12 s por temporada-año) queda
como referencia del análisis, no de la pantalla.

**NO MEDIDO / no se afirma:** las «exactitudes» de 80 % y 99 % son expectativas, no mediciones; lo
medido es la repetición (45–47 % en las temporadas fuertes) y la recuperación mensual contra diaria.
Reposición (compra única o hasta el corte): no se deriva de la venta, la confirman las áreas.

### 19.12 PQ.94 C2 — la API de Temporadas y sus permisos (2026-11-10)

**Endpoints** (`libs/commercial/src/lib/temporadas/`, contrato `libs/contracts/src/http/temporadas.contract.ts`):

| Método | Ruta | Permiso | Qué hace |
|---|---|---|---|
| GET | `compras/temporadas` | `COMPRAS_TEMPORADAS_VER` | calendario: temporadas, fechas por año (propuesta o confirmada, quién y cuándo), momento de hoy, productos confirmados/descartados; orden en venta → por iniciar → terminadas (T8) |
| GET | `compras/temporadas/fechas/:id/candidatos` | `COMPRAS_TEMPORADAS_VER` | lo que propone la venta para una temporada-año, con la decisión vigente; lo decidido fuera de la propuesta, aparte |
| POST | `compras/temporadas/:id/decisiones` | `COMPRAS_TEMPORADAS_GESTIONAR` | confirmar o descartar por lote; respuesta **parcial** (guardadas + fallidas con motivo) |
| POST | `compras/temporadas/fechas/:id/confirmar` | `COMPRAS_TEMPORADAS_GESTIONAR` | confirmar (y ajustar) las fechas de una temporada-año |

- **Una sola puerta de escritura**: estos dos POST son los únicos que escriben la temporada.
- **El SQL vive en `temporadas.repo.ts`** (funciones que reciben la transacción): la prueba contra base real
  ejerce el mismo código que la API, no una copia.
- **Caché sólo de lo caro** (~0.9 s por temporada-año): 6 h si la ventana y su mes siguiente cerraron, 10 min
  si no. Las decisiones se leen frescas en cada consulta; confirmar fechas borra lo guardado de esa temporada-año.
- **La misma regla en la pantalla y en la API**: `validarDecisionTemporada` y `validarFechasTemporada` del
  contrato replican los CHECK de las tablas, con el motivo en llano.
- **Una clave manual tiene que existir en el catálogo**; la prueba negativa lo mostró: sin esa verificación,
  una clave inexistente se habría guardado.

**Permisos** (migración `20261110015552_pq94_temporadas_permisos`, regla 20; sin aplicar en prod, va
**después** de la de las tablas): VER a `compras`, `gerente_compras`, `auxiliar_compras`,
`compras_operaciones`, `marketing`, `jefe_marketing`, `direccion`; GESTIONAR a `compras`, `gerente_compras`,
`marketing`, `jefe_marketing`, `direccion`. ⚠️ Dirección Comercial no tiene rol propio (MATRIZ_ACCESOS: «sin
definir»); queda en `direccion`. superadmin pasa por el modo dios del guard. Sólo agrega donde la clave falta;
control: un `false` puesto a mano no se pisa; `down` quita sólo lo que puso.

**Pruebas:**
- `database/tests/test-newdb-pq94-temporadas-api.js` **26/26** contra Postgres 18 local, como `app_runtime`
  con el tenant puesto (RLS y GRANT reales) y el payload de la pantalla. **Pruebas negativas:** sin la
  validación previa y sin verificar la clave en el catálogo, rojo.
- `temporadas.spec.ts` (vitest) **7/7**: momento, orden del calendario, vigencia de la caché, las dos validaciones.
- `typecheck:fast`: mis archivos sin errores, con control (un error metido a propósito en el servicio
  apareció). ⚠️ Queda 1 error **ajeno** en `apps/api/src/instrument.ts:38` (no tocado; también rompe
  `nx build api` local) → para este cambio, NO MEDIDO por esa compuerta.
- `lint:boundary` verde. `design:paramtypes` del servicio y del controlador presentes en el bundle, con la
  misma forma que el control `RevisionService`. **Arranque de la API: no verificado** (lo levanta Francisco).
- **NO MEDIDO:** `calcularCandidatos` contra venta poblada (en local `mv_sellout_monthly` está vacía; su SQL
  se midió en prod con el prototipo, §19.11).

### 19.13 Revisión independiente antes del PR (2026-11-10)

Un revisor que no escribió el código recorrió el diff completo. **Nada de severidad alta** (sin fuga entre
tenants, inyección ni mensajes de Postgres expuestos). Lo confirmado se corrigió antes de enviar:

| # | Hallazgo | Arreglo | Prueba negativa |
|---|---|---|---|
| 1 | La caché de candidatos vive por proceso y **prod corre 2 réplicas**: corregir fechas en una dejaba la otra sirviendo la ventana vieja hasta 6 h | la cabecera se lee fresca y la **llave lleva las fechas** de la ventana (`llaveCandidatos`) | sin fechas en la llave → rojo (vitest) |
| 2 | Lo confirmado «sólo 2025» se pintaba «Confirmado» en 2026 (el estado de hoy no lo publica) | `decisionAplica`: sólo cuenta en su año; descartar y «anual» valen todos | «toda decisión aplica» → rojo (2 checks) |
| 3 | El «% de su año» de las temporadas de 2025 sale inflado (no hay 2024): San Valentín 2025 propone **274** contra **65** en 2026 | la vista expone `base_months` (12 preguntas por índice; con un conteo por producto la consulta subía de ~1 s a 2–3 s) y la pantalla lo declara | — (dato expuesto, medido en prod: 2025 → 4–10 meses, 2026 → 12) |
| 4 | Fechas confirmadas sin forma de corregirse; la API no ataba la venta al año | la venta tiene que **empezar en el año** de la temporada-año; la pantalla ofrece «Corregir fechas» | venta de otro año → 400 |
| 6–11 | cifras en cero mientras carga; decisiones manuales escondidas sin candidatos; guardar sin calendario cargado; un texto de permiso que afirmaba lo que todavía no pasa; `2026-02-30` daba 500; errores en inglés | pantalla y contrato (ver PR) | 30-feb → 400 |
| 12 | `toISOString()` sobre un `date` daba el día anterior en zonas UTC+ | las fechas salen de SQL como texto (`to_char`) | — |
| 13 | una clave repetida en el lote | no se guarda en ninguna de sus apariciones | repetida → ninguna entra |
| 15 | `en_remate` desde el cierre aunque el remate empiece después (Navidad: 25 contra 26-dic) | entre cierre y remate: `pasado_el_corte` | sin la fecha de remate → rojo |
| 17 | montos de venta mensual en el comentario de la migración (repo público) | quitados | — |
| duda | la función marcada IMMUTABLE usa `date_trunc` (depende de la zona) | STABLE | — |

**Deuda con nombre y fecha (hallazgo 5): crear el año siguiente.** Ni la API ni la pantalla insertan en
`season_dates`; la siembra trae 2025 y 2026. ⛔ **Antes del 1-dic-2026**: San Valentín 2027 se vende desde el 5-ene
y se compra en diciembre. Propuesta: una acción «Proponer {año+1}» que copie las fechas del año anterior (fecha fija:
+1 año; móvil: +364 días, que conserva el día de la semana) como propuesta.

**Declarado, no corregido:** `origin` y `evidence` los afirma el cliente (se guardan como su declaración, no se
cotejan); la vista de candidatos depende de `analytics.mv_sellout_monthly` (una reconstrucción con `DROP … CASCADE`
la borraría y la API daría 500: quien reconstruya esa cadena tiene que recrearla).

**Tiempo de candidatos, re-medido en prod con la base de meses:** ~0.4–1.6 s por temporada-año (2026 trae más
renglones por mes que 2025). Más de 500 ms: queda en caché.
## 20. El menú de Compras de Kepler dentro de la Suite (2026-11-09)

> ⭐ **Completado y reemplazado por el [anexo K](FASE_PQ_ANEXO_MENU_COMPRAS_KEPLER.md)
> (2026-11-12)**: cubre los 10 módulos (agrega Reportes, Autorización y Consulta de documentos) y
> corrige «Saldar»: `kdmm` lo llama «Saldar documento **CxP**», no el cierre de una OC. Esta sección
> queda como historia.

**Pedido literal (PM, 2026-11-09):** *«agreguemos todos estos módulos, pero bien optimizados:
analicemos si de verdad es necesario tener una interfaz completa o agregarlo en una pantalla»*,
sobre la captura del menú Compras de Kepler: Requisición, Órdenes de compra (con «Modifica»), Vale
de entrada, Órdenes de entrada, Aplicación de orden de entrada, Devolución directa y Saldar
documento (con «masivamente»), cada uno con alta, baja y consulta.

**Cómo cambió:** no son siete módulos, son **un solo flujo físico** (pedir → ordenar → recibir →
registrar la compra → a veces devolver) que Kepler obliga a capturar como documentos separados. La
Suite modela el **acto**, no el formulario de cada documento. Resultado: **cero pantallas nuevas**,
siete acciones en pantallas que ya existen.

### 20.1 Lo medido (prod, sólo lectura, `system_identifier` verificado, 90 días por fecha de captura `c68`, 9 sucursales)

| Documento Kepler | Menú | Vigentes 90 d | De qué nace (`c37`) | Mismo día que su origen |
|---|---|---:|---|---:|
| `X-A-30` | Requisición | 543 | — | — |
| `X-A-35` | Orden de compra | 2,633 | 20 % de una requisición, 80 % sin origen | — |
| `X-A-37` | Vale de entrada | 3,324 | 82 % de una OC, 18 % sin OC | 76 % (OC → vale) |
| `X-A-40` | Orden de entrada | 3,281 | 100 % de un vale | 92 % |
| `X-A-20` | Aplicación de orden de entrada | 3,221 | 100 % de una orden de entrada | 95 % |
| `X-D-40` | Devolución directa | 114 | 93 % sin documento de origen | — |
| `X-A-90` | Saldar documento | **1 en toda la historia** (2026-01-07) | — | — |

- ⭐ **La recepción se captura tres veces.** Vale, orden de entrada y aplicación van casi 1:1:1 y el
  mismo día: ~115 capturas diarias para un solo acto, «llegó la mercancía».
- **La OC se hace cuando la mercancía ya llegó**: 3 de cada 4 se capturan el mismo día que su vale.
- **«Saldar» no se usa como documento.** La necesidad real son las OC que se quedan abiertas: 48 de
  2,224 (2 %) de 15 a 90 días sin ningún vale.
- `X-D-30`/`X-D-35` (devolución en dos pasos), `X-A-5`/`X-A-6` (compra directa) y `X-A-60`: **cero**
  documentos en toda la historia.
- **Lo que la Suite escribe hoy en Kepler:** `X-A-30`, `U-D-40` y `X-A-35` (PQ.22), sólo al
  **crear**. Nada da de baja, salda, recibe ni devuelve en Kepler. Desde el 2026-10-13, 132
  requisiciones escritas; las 723 con `kepler_error` son interruptores apagados por sucursal, no fallas.

### 20.2 Módulo por módulo

| Kepler | Hoy en la Suite | Lo que falta | Dónde va | Item |
|---|---|---|---|---|
| Requisición — alta / consulta | `/compras/pedido`, `/compras/requisiciones`, `/almacen/autoabasto` | — | — | — |
| Requisición — baja | rechazar sólo antes de aprobar | cancelarla en Kepler («documento referenciado») | botón en `/compras/requisiciones/:id` | `[KR.7]` (ya existe) |
| OC — alta / consulta | `/compras/oc-abiertas`; alta con la requisición | — | — | — |
| OC — baja | la pantalla dice «ciérrala en Kepler a mano» | cancelarla en Kepler | acción de fila en `oc-abiertas` | `[PQ.110]` |
| OC — modifica | no existe | **no se hace** (D39): cancelar y reemitir deja rastro | — | — |
| Saldar (uno y masivo) | no existe en Kepler | cerrar la OC abierta en Kepler | acción de fila + barra en `oc-abiertas` | `[PQ.111]` |
| Vale + orden de entrada | el Andén coteja lo que ya se capturó en Kepler | que **cerrar la recepción** en el Andén los escriba | `/almacen/anden` | `[PQ.112]` ⚠️ D37 |
| Aplicación | `/compras/entradas` valida la factura | escribirla al validar | Captura de facturas | `[PQ.114]` ⚠️ D38 |
| Devolución directa | sólo se ve en `/compras/descuentos` | que el reclamo resuelto «devolver al proveedor» la genere | `/compras/reclamos` | `[PQ.113]` ⚠️ D37 |

### 20.3 El orden (dinero en juego × esfuerzo)

1. **`[PQ.110]` + `[PQ.111]` cancelar y saldar la OC desde `oc-abiertas`.** Esfuerzo bajo: un
   `UPDATE` de la cabecera, con el precedente de la autorización de gasto (`kdm1.c43` N→A, GRANT
   por columna ya dado en las 9). Quita el «ciérrala en Kepler a mano» del aviso de la pantalla.
2. **`[KR.7]` la baja de la requisición.** La Suite ya las crea; un documento que no se puede
   cancelar es peor que uno que no se puede crear (FASE_KR §6).
3. **`[PQ.112]` la recepción desde el Andén.** El mayor ahorro (dos de tres capturas por recepción),
   y el más delicado: **la orden de entrada mete inventario**.
4. **`[PQ.113]` la devolución desde Reclamos.** Poco volumen; también saca inventario.
5. **`[PQ.114]` la aplicación.** Crea la **cuenta por pagar y la póliza**: el mayor riesgo, al final
   o nunca.

### 20.4 Decisiones (sin firma)

- **D37 — ¿La Suite escribe en Kepler documentos que MUEVEN inventario (`X-A-40`, `X-D-40`)?** Hasta
  hoy sólo escribe documentos con `c8=N`. **Recomendación: sí, sólo la recepción del Andén**, después
  de PQ.110/111 y KR.7, con prueba contra base real (regla 13) y la baja resuelta antes que la alta.
- **D38 — ¿La aplicación (`X-A-20`, cuenta por pagar) la escribe la Suite?** **Recomendación: no por
  ahora.** Es mecánica y del mismo día; se revisa cuando PQ.112 funcione. ContPAQi sigue siendo el
  sistema de registro contable (ADR-040).
- **D39 — «Modifica orden de compra» se reemplaza por cancelar y reemitir.** **Recomendación: sí.**

### 20.5 Lo que NO se sabe todavía

- ⛔ **Qué escribe «saldar» en Kepler es INFERIDO**: cabecera `c43='F'` y pendiente `c42=0`, como ya
  hace la Suite al convertir su requisición (PQ.22). Antes de programar PQ.111 se mira un saldado
  hecho en Kepler por una persona y se lee qué cambió (`PQ.111` arranca por ahí, regla 10).
- **Qué escribe la baja de una OC con vale** (¿Kepler la deja cancelar?) — NO MEDIDO.

### 20.6 PQ.110/PQ.111, primer paso: la huella en el ODS (2026-11-09, sólo lectura)

`X-A-35` de 180 días por estado `c43` (N nueva · A autorizada · R parcial · F terminada · C cancelada)
y por si tienen vale vigente. `c24` de `kdm2` es el **pendiente del renglón** (negativo = llegó de
más): en la OC 0007127 de oficinas, 280 pendientes de 500 en el renglón que llegó incompleto.

| Estado | Con vale | OC | Cabecera | Renglones |
|---|---|---:|---|---|
| C | no | 449 | `c13`–`c16` y `c42` en **0** (las 449) | no están en el ODS, salvo 14 OC viejas de La Piedad Abastos y 8 Esquinas que los conservan con cantidad e importe y pendiente 0 |
| C | sí | **0** | — | — |
| F | recibió menos de lo pedido | 68 | `c42`=0, importe intacto | pendiente en 0 en 66 de 68 |
| F | sin ningún vale | 3 | `c42`=0, importe intacto | pendiente en 0 en las 3 |
| R | sí | 454 | `c42` = lo que falta | pendiente > 0 en 365 |

**Lo que sugiere (hipótesis, sin testigo del Kepler vivo):**
- **Saldar** = `c43`→`F`, `c42`→0 y `c24`→0 en cada renglón; no toca el importe.
- **Cancelar** = `c43`→`C`, `c13`–`c16` y `c42`→0, y los renglones **se borran** (o el ODS deja de
  verlos). **Ninguna OC con vale está cancelada**: Kepler probablemente lo impide, como con la
  requisición («documento referenciado»).

⛔ **Falta el testigo**, igual que en la autorización de gasto: leer en el Kepler vivo, por `xmin`, qué
tablas toca una cancelación y un saldado reales. Así se ve si la cancelación devuelve la requisición,
si borra renglones y si hay más tablas. Desde `md` con `kepler_push`, sólo lectura: **espera la
autorización del PM** (el clasificador lo frena). Candidata para la cancelación observada: la OC de
prueba 0000346 (Lico), que de todos modos hay que cancelar.

**Lo que tocará `kepler_push` (los GRANT los corre el PM, después del testigo):** hoy sólo tiene
`UPDATE (c43)` en `md.kdm1`. Saldar pide además `UPDATE (c42)` en `kdm1` y `UPDATE (c24)` en `kdm2`.
Cancelar pide `c13`–`c16` y, si de verdad borra renglones, un `DELETE` en `kdm2`, que el rol **no
tiene a propósito** (KR). Ahí D40 tendría que decidir si se le da o si la Suite sólo salda.
- Cada pantalla que se toque pasa antes por las cinco preguntas de `diseno` §0b.
- No se abre fase nueva (Fase 0, cupo lleno): todo entra como items de PQ.

---

## 10. Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
| 2026-11-12 | **Anexo K**: el menú Compras de Kepler completo, 10 módulos y 25 opciones, cada una con su destino (cero pantallas nuevas). Medido: una de cada 8 OC se cancela; la autorización no frena nada; «Saldar» es un documento de cuentas por pagar (corrige §20). Nacen **PQ.122–PQ.123** y **DK1–DK3**, sin firma | Claude |
| 2026-11-10 | **§19.11 base de partida**: propuesta de temporadas × productos desde la historia (Wincaja + Kepler, sell-out canónico diario): 495 propuestas en CSV fuera del repo. La lista de temporadas sale del Plan Anual de Mercadotecnia 2026; la ventana es la del MAYORISTA (Muertos 1-sep → 2-nov), y con ella la repetición 2025→2026 sube de 1/16 a 26/58. PQ.94 corregida: siembra, regla de la mitad del mes, 45/45 | sesión Claude + Francisco |
| 2026-11-10 | **PQ.94 🧪 C0** (§19.10): migración de Temporadas (3 tablas en `catalog`, 2 vistas) sin aplicar en prod; la venta sale del sell-out canónico `mv_sellout_monthly` (no de `sales_daily`, importer); 37/37 contra Postgres real con dos pruebas negativas. Lista de Navidad «no reponer» para Compras: 47 productos, 4 con ~$197 mil en tránsito (fuera del repo). D36: la temporada en el catálogo de la Suite; una sola puerta de escritura | sesión Claude + Francisco |
| 2026-11-10 | **D35 contestada por Francisco** (dueños: Compras, Mercadotecnia, Dirección Comercial y General; falta que el PM la ratifique) y regla **«compra única, lo que sobra es remate»** (§19.7). Remate de Muertos/Halloween: 43 productos, ~$102 mil a costo; Canels Piñatero se sacó a mano (es de posadas). PQ.96 ⬜ | sesión Claude + Francisco |
| 2026-11-09 | **§19, PQ.93 ✅ C0:** historia del freno de demanda con etiqueta de temporada. Muertos/Halloween a una semana del cierre: los 39 productos con nombre de la temporada siguen pidiéndose (114 pares, ~$165 mil a costo, pedido crudo) y fin de pico frena 0; el patrón de venta solo confunde temporada, pico y agotado. PQ.94–PQ.95 ⬜; D35 sin firmar. Lista para Compras fuera del repo | sesión Claude + Francisco |
| 2026-11-09 | **§20, el menú de Compras de Kepler**: los siete módulos son un solo flujo y caben en pantallas que ya existen (cero nuevas). Medido: la recepción se captura tres veces el mismo día (vale, orden de entrada, aplicación) y «saldar» se usó una vez en la historia. Nacen **PQ.110–PQ.114** y **D37–D39** (sin firma) | Claude |
| 2026-11-07 | **PQ.91 🧪** (§17.20): la prueba final de PQ.87 en prod encontró la demanda todavía en cajas de 40 donde Kepler dice que no hay caja; el plan usa la caja del almacén ahí (282 celdas), la compra consolidada lee el factor del renglón y el adaptador trata «sin factor» como 1. Queda `[PQ.92]` (guardar la caja del renglón) | Claude |
| 2026-11-06 | **PQ.87 🧪** (§17.20): la caja de los productos que Kepler compra sueltos (ficha con peldaños que repiten la base) pasa a 1; el envío a Kepler y la validación del lote usan el factor del almacén, el mismo de la mesa; el adaptador frena si la ficha dice sin caja y la Suite trae caja | Claude |
| 2026-11-06 | **PQ.83 🧪 · PQ.84 🧪** (§17.20): el freno de duplicados ya no llama «hecha fuera de la Suite» a lo que mandó la Suite (RQ-2026-02269 contra su propia RQ-2026-02055); OC abiertas con buscador por folio, requisición y proveedor, y filtro de origen | Claude |
| 2026-11-06 | **PQ.81 🧪** (§17.20): Control de entradas dice de qué orden de entrada viene cada entrada y busca también por ese folio (en el 94 % de las aplicaciones es otro número). De paso: las órdenes 0001062/0001063 de 8 Esquinas tenían su aplicación cancelada y una recaptura buena; en Kepler se cancelan, no se corrigen | Claude |
| 2026-11-06 | **PQ.82 🧪** (§17.20): el PDF de la OC para el proveedor rotulaba «cj» renglones de 1 por caja (piezas o paquetes): 4,345 renglones en la mitad de las OC de 90 días. Ahora dice la unidad real | Claude |
| 2026-11-05 | **PQ.80 🧪** (§17.20): con ⚠ de peldaño ya se puede pedir a mano (antes la sucursal quedaba cerrada, y una mala entrada en una sucursal bloqueaba el producto en todas). Sin sugerido inventado | Claude |
| 2026-11-05 | **PQ.78 🧪 · PQ.79 🧪** (§17.20): el precio del pedido es el de Kepler en la sucursal que recibe, leído en vivo (antes, la mediana de la red con 15 min de atraso); el papel dice de dónde sale y de qué hora es. Lo que ninguna sucursal pudo calcular se pinta «—», no 0. Causas en Kepler, para Edgar: el precio nuevo de Tuby no estaba guardado, una entrada de 8 Esquinas metió 800 paquetes donde eran 40, y 6 proveedores tienen «?» en el nombre | Claude |
| 2026-11-05 | **PQ.75 🧪** (§17.19): el pedido típico en dos cifras («$241 mil · llevas $686 mil»). La captura de la entrega en el panel pasa a **PQ.77**: 0 de 1,347 proveedores la tienen, su endpoint nunca se ha llamado y no tiene prueba contra base real; primero va la prueba | Claude |
| 2026-11-05 | **PQ.74 🧪** (§17.18): el primer producto se ve al entrar. Simulado en la página viva, pasa de y=850 (debajo de la barra) a y=583, y se ven dos productos completos. Salen la pastilla, dos cifras repetidas, la caja de días duplicada y el rojo del Ciclo; la mitad de lo ganado era aire. Sin validación visual del código real | Claude |
| 2026-11-05 | **PQ.76 🧪** (§17.17): las tres listas de Pedido se topaban en 500 renglones y la pantalla los sumaba como total. «A traspasar» $3.4 M → $4.9 M y «Sobrestock» $9.5 M → $13.0 M, con el mismo dato. Los productos que quedaban fuera perdían su traspaso en el desglose y en la requisición. Ahora se piden por producto de la página y los totales vienen del servidor. Probado contra prod en sólo lectura, con control negativo; tres mutantes muertos | Claude |
| 2026-11-05 | **PQ.56 ✅** (§17.16): nivel A en prod, en sólo lectura y con blindaje probado. Lo más caro: la primera fila es 17499 ($686 mil por una sola venta; espera D31). Le siguen un rótulo de cajas que muestra kg, una primera pantalla sin ningún producto, «Sobrestock» a 1.95:1 y el rojo como decoración. Nacen **PQ.72–PQ.75** | Claude |
| 2026-11-05 | **PQ.55 ✅** (§17.15), medido desde `analytics.ui_usage` (no hacían falta los logs). En 30 días, Compras abrió Pedido 4,996 veces, Stock muerto 13, Sobrante 3 y Flujo 1. La agenda del Ciclo, que nació el 23-oct, la abrieron 3 compradores: se deja y se re-mide. El conteo crudo de `worklist` engaña porque el aviso de PQ.5 lo llama al abrir Pedido. Nace **D34** (sin firma: quitar las tres pestañas) con **PQ.71**, que espera a PQ.56. **PQ.49** pasa a ✅ (la medición ya estaba en §17.5). Línea base real de PQ.10: `workbook` promedia 1.6–1.8 s en uso | Claude |
| 2026-11-04 | **PQ.10 primer paso** (§17.14): escalera y etiquetera se leen sólo para los renglones devueltos, y el factor de caja se une directo a su tabla. Respuesta idéntica en 10 escenarios; la red 2.67 → 2.20 s, un proveedor 1.55 → 0.99 s, una sucursal 1.37 → 0.79 s. El primer intento (unirlas en SQL) subía el caso con proveedor a 19 s y se descartó. Sigue 🔨: lo que queda decide el pedido. Mismo día: PQ.44/50/68/69/70 y 28 renglones más de PQ verificados en prod y pasados a ✅ en el tracker. | Claude |
| 2026-11-04 | **PQ.44 🧪** (`3ea70328e`, §17.13): la sucursal que sale en 0 porque el reorden frenó algo que sí faltaba dice «arriba del reorden», y sólo ahí. El motor la marca con la misma cantidad que decide el pedido: 1,075 de 25,564 celdas. El primer intento (comparar en pantalla) la habría puesto en la mitad de la grilla | PM + sesión Claude |
| 2026-11-04 | **PQ.44 D26 y D25** (§17.13). D26 (`95f1b7d3c`): lo que llega por traspaso no se infla por cumplimiento; 606 → 280 renglones de diferencia, Pedido $21.4 M → $20.8 M. D25 (`d9660bdd4`): Pedido abre con la cobertura de cada sucursal; en la red $22.68 M → $20.71 M frente a 30 días fijos; control 0 diferencias en 25,296 renglones. Falta explicar en pantalla la celda en 0 | PM + sesión Claude |
| 2026-11-04 | PM firmó **D33**. **PQ.44, primer paso** (`0aeec91fc`, §17.12): Pedido pide al llegar al reorden con la misma regla que la mesa (`faltante.ts`). «Pedido lo pide y la mesa no» 681 → 2; Pedido en 8 sucursales $24.4 M → $21.4 M; las otras diferencias no se movieron. Falta D25, D26 y explicarlo en pantalla | PM + sesión Claude |
| 2026-11-04 | PM firmó **D32**. Al re-medir, el placebo tumbó la liga por productos (21 de 38 también casaban 30–90 días antes) → árbitro **por importe de renglón**: **PQ.69** liga 23 ($2.98 M) y **PQ.68** cierra 16 ($0.35 M); unas 20 más se cierran solas al cumplir 30 días (`833934781`, §17.11). ⛔ RQ-2026-01391 ($245,571) falló y el reintento no la toma: Compras | PM + sesión Claude |
| 2026-11-04 | **PQ.50 🧪** (`b37cea6e4`, D29, §17.10): el traspaso aprobado que en 7 días no salió a Kepler se cierra con motivo al leer la bandeja. Son 867 de 1,152 ($17.3 M), 200 por lectura. La mitad de sólo lectura de la prueba da 867 = 867 contra prod; la mitad que escribe corre en el CI. **Choque de códigos:** §18 ya usaba PQ.58–PQ.66, así que lo de esta sesión se renumera: GRANT → PQ.67, D32 → PQ.68, ligar → PQ.69, freno → **PQ.70** (sus commits dicen PQ.61) | PM + sesión Claude |
| 2026-11-04 | «Aún existen productos con advertencia» → «¿100 %?» → «¿e históricos?» → **§18**: PQ.58 ✅ en prod (el commit dice PQ.41: choque de código, §18.1), estado A/B/C/D medido (91 % del valor verificado), plan PQ.59–PQ.66; el PM aprobó la tabla de historia de fichas | Claude |
| 2026-11-04 | **PQ.61 🧪** (`84de4bcf2`): el freno contra el duplicado vale también para el **primer** envío (no tenía ninguno) y mira productos y saldo abierto. Medido con el SQL real: de 76 compras escritas por la Suite desde el 27-oct, 2 repetían una requisición abierta hecha a mano (RQ-2026-01760/-01762, $9,450). ⛔ **Corrección a la fila de abajo:** las 4 OC del 1-nov de 8 Esquinas están **recibidas** (`c43='F'`, saldo 0): RQ-2026-01881 no duplica una orden abierta, vuelve a pedir 22 productos que acaban de llegar. Que eso sea intencional lo confirma Compras; el freno nuevo no la detiene | PM + sesión Claude |
| 2026-11-04 | Edgar dio el `GRANT` de `kdxd` en 8 Esquinas (PQ.58). ⛔ **Riesgo de duplicado al reintentar RQ-2026-01881:** el reintento automático (PQ.26) se dispara al abrir la bandeja, y su freno sólo mira documentos de Kepler **desde la aprobación** (3-nov). El 1-nov se capturaron a mano 4 OC de DISTRIBUIDORA DE LA ROSA en 8 Esquinas (0001110–0001113, $141,231) que ya traen **22 de sus 64 productos ($161,421)**. Nace **PQ.61**: el freno compara productos, no sólo proveedor, y mira desde unos días antes de crear la requisición | PM + sesión Claude |
| 2026-11-04 | **PQ.43 🧪 C0** (§17.9), con los dos servicios de la versión de prod en sólo lectura: 74 % de los 6,014 productos con falta dan lo mismo. La diferencia grande es **cuándo** se pide: la mesa sólo lista lo que está en o bajo reorden, Pedido todo lo que falta para el objetivo (670 renglones, $2.97 M). La bolsa 17499 sale con 19,899 rollos en las dos. Nace **D33** | PM + sesión Claude |
| 2026-11-04 | PM firmó **D29, D30, D31**. **PQ.51 🧪 C0** (§17.8): de las 85 compras aprobadas sin documento, 38 ($4.08 M) ya están en Kepler hechas a mano, 35 no existen, 12 por revisar; nadie las liga porque PQ.25 sólo liga lo que la Suite escribió. **Hallazgo vivo:** RQ-2026-01881 (8 Esquinas, $389,926) falló por falta de `GRANT` en `kdxd`; desde el 29-oct es la única de 64. Nacen **D32**, PQ.58–PQ.60 | PM + sesión Claude |
| 2026-11-04 | Prioridad 2 (§17.6): **PQ.47 🧪 C0**: de 83 ventas únicas, 49 son de clientes que no compraban ese producto ($1.62 M en un día); 17499 = venta a BOLSAS DE LOS ALTOS, que es proveedor. **PQ.41 🧪 C0**: el factor de temporada sólo mejora 0–6 % al pronóstico ingenuo; copiar el año pasado es 38 % peor; la regla dirigida quita ~95 % de lo pronosticado de más en lo que se desplomó. Nacen **D30** (¿qué error cuesta más?) y **D31** (venta única fuera del promedio) | PM + sesión Claude |
| 2026-11-04 | «Documentemos todos los hallazgos y hagámoslos correcciones» → **§17**: 24 correcciones (C-1…C-24) en cuatro frentes, cada una con item, capa, árbitro y prioridad; items nuevos PQ.47–PQ.57 y D29 sin firma. Hallazgo nuevo: **venta extraordinaria única** proyectada como diaria (17499: una venta de 19,899 rollos; en la red 76 pares, $1.05 M en un día). Corregido en §15.5 lo dicho de 17499 | PM + sesión Claude |
| 2026-11-04 | PM firmó **D25–D28**. **PQ.42 🧪** (§16.5): el día sin foto es agotado (A vende 65.5 % de los días con existencia contra 16.3 % sin ella); el motor no ve ~$2.38 M de venta en 21 d. La foto lee la copia `commercial.stock` y el motor la vista del ODS | PM + sesión Claude |
| 2026-11-04 | «Pasa a proponer» → **§16, sin firma**: tres mediciones primero (PQ.41 backtest de temporada contra 2025 · PQ.42 ¿la foto sin fila es agotado? · PQ.43 paridad mesa vs Pedido), después una sola falta en `libs/` y temporada + días agotados en la vista del ODS de D17 (nunca en el importer). Decisiones D25–D28. No abre fase (7 🔨 contra 4) | PM + sesión Claude |
| 2026-11-04 | «No se está considerando la estacionalidad… Pedido y Autoabasto en sincronía; antes de proponer, revisa» → **§15**, sólo hallazgos. El factor de temporada tiene cuatro huecos (meses en cero fuera del índice, piso de 0.5, fin de pico que excluye la temporada, un solo año de historia); 39025 sale con factor 1.000 (control 2.82 = pantalla). Pedido y la mesa comparten la fuente y difieren en cobertura, cumplimiento y traspasos en camino. Otros: días agotados cuentan como venta cero (PLAUSIBLE), feriados móviles, traspasos de la Suite como plan paralelo con 640 repetidos. Corregido el «$20.9 M parados» de la auditoría de la mañana. Nivel B + C; nivel A no | PM + sesión Claude |
| 2026-10-28 | «La requisición no aparece para generar la OC en Kepler; y generemos la OC automáticamente» → **PQ.21 🔨** (`c42` saldo pendiente + IVA/IEPS de la ficha) y **PQ.22 🔨** (OC X-A-35 ligada, misma transacción, interruptor por sucursal apagado). Reglas medidas en `kepler_ods`; ensayo contra Kepler NO MEDIDO (sin `pg_hba` o sin GRANT `kdxd` desde desarrollo; 01/06/07 sin GRANT) (§14.6) | PM + sesión PQ |
| 2026-10-27 | «Actívemoslo para hacer pruebas» → **PQ.19 🧪**: D24 en código (traspaso en unidad base + factor contrastado con la ficha del origen). Simulacro: compras 85/85, traspasos 776/809; los 33 son fichas de Kepler sin factor. Encender = secreto en `md` (no lo toca la sesión): canario de compra en 04 primero, traspaso desde 01 después del push (§14.5) | PM + sesión PQ |
| 2026-10-27 | «¿Cómo sale el traspaso en cada sucursal?» (§14.4): pedido `U-D-40` + embarque `U-D-41` en la que manda, recepción `U-A-50` en la que recibe, idénticos al centavo, ligados por `c37/c38/c39`. Hallazgo: Kepler escribe el traspaso en unidad base (99.2 %), nosotros en CJA → **D24** | PM + sesión PQ |
| 2026-10-27 | «Generar el apartado para ver los pedidos de sucursal» → **PQ.18 🧪** (`ffea99b38`): tercera pestaña en Requisiciones con lo que mandan las sucursales (compras y traspasos), quién pidió y qué, aprobar/rechazar con motivo, contador de pendientes. En prod hay 0 todavía (la función nació el 26-oct) | PM + sesión PQ |
| 2026-10-27 | El PM señaló `/almacen/movimientos` (§14.3): el cierre `U-D-41 → U-A-50` ya existe (DM.3, con estado por documento y cuadre contable); falta el eslabón requisición → `U-D-40` → `U-D-41` (los folios no coinciden entre 40 y 41). PQ.3 se re-define para reusar ese servicio. Plantilla de la 01: `U-D-40 1/0003333` (el adaptador reescribe estado y limpia responsables) | PM + sesión PQ |
| 2026-10-27 | «Tú corrígelo» (los 21 con fracción) → **no se corrigió ningún dato**: los 42 renglones son piezas enteras. Regla «cajas enteras o piezas enteras» en la mesa, el lote, el empuje y el adaptador (escribe en unidad base) (`7fc107f6c`). Simulacro con las reglas vigentes: **853/853 (100 %)**, 0 riesgos (`131f21afd`). 22/22 lib · 102/102 pedido | PM + sesión PQ |
| 2026-10-27 | «Resolvamos todo lo que no nos deje» → D22 y D23 en código (`219e13736`): proveedor contra `kdxd` (0 rebotes de datos en 853) y fracción frenada al generar. Lo demás es configuración por servidor: plantillas de traspaso medidas (00/06/08; la 01 sin candidato SUCURSAL; el 04 sin U-D-40 sano) y topes propuestos (§14.1) | PM + sesión PQ |
| 2026-10-27 | «¿Cómo validamos que el 100 % pasa a Kepler?» → **PQ.17 🧪** (`71db08ae5`): simulacro con control; 853 documentos, **96.0 % pasan**; los 34 que rebotan son proveedores que Kepler SÍ tiene en `kdxd` → la regla nuestra es más estricta que Kepler (**D22**). Lo que decide está en configuración (plantilla de traspaso, tope diario 1 = 470 días para el 00) (§14) | PM + sesión PQ |
| 2026-10-26 | «Resolvámoslo» (D21) → **PQ.16 🧪** (`87e8adc93`): from-requisition y receipts responden 409; el detalle de requisición captura el folio de Kepler (RQ.15) en vez de generar OC propia; OC interna en solo lectura; la lista interna se rotula histórico y las pestañas suben «Órdenes de compra (Kepler)». 43/43 vitest. Falta: «de qué requisición» en la lista de Kepler por `oc_folio` y congelar 235/136 en VERDAD_ABSOLUTA | PM + sesión PQ |
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
