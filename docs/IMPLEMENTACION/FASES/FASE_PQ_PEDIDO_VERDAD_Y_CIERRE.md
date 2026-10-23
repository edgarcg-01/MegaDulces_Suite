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

## 10. Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
| 2026-10-23 | Auditoría del flujo (nivel B+C), jerarquía, agenda medida, M1/M2 definidas, doc creado en ⬜. Consultas en el scratchpad de la sesión; cifras en §1 | sesión Claude + PM |
| 2026-10-23 | **PQ.1, PQ.5 y PQ.4 en 🧪** (commits `61cbe15`, `ea81144`, `da0b005`): la bandeja distingue «aprobada» de «escrita en Kepler»; Pedido avisa «hoy te toca pedirle a N proveedores»; el Ciclo abre por **agenda de proveedores** (237 filas, 227 ms, cruzada al centavo contra la vista por canal con el servicio real) y declara el tope de la lista por canal (639 activos, 500 mostrados). ⛔ **Bloqueo nuevo:** los items que ESCRIBEN (PQ.2, PQ.3, PQ.7, PQ.8, PQ.9, PQ.11) exigen prueba contra base real con el payload de la pantalla y **Docker Desktop no responde** en la máquina de trabajo: sin base de pruebas no se arrancan. Dueño: quien levante el stack `dev:up`. Otra sesión avanzó KR.12/KR.13 (encendido de Kepler servidor por servidor): revisar antes de PQ.2 | sesión Claude |
| 2026-10-23 | **Fase abierta 🔨**: el PM pasó **PO → ⏸️** (20 d sin commit, 0 items) y PQ ocupa su cupo. Fila en el roadmap. Dueño y fecha meta siguen sin nombrar. Arranca F1 (PQ.1) | PM |
| 2026-10-23 | PQ.M2 ✅ (rótulos revisados, nivel C). El PM firmó **D1 (c), D2 (b)+(c), D3 (c), D5 (b)**. Pendientes D4, D6 (espera M1) y D7. F1–F3 siguen sin cupo: 4/4 🔨 | PM |
| 2026-10-23 | «Hagámoslo»: M2 y M1 corridas contra prod con sus scripts y controles (§11). M2 🧪: el costo es el de Kepler (89–92 % vía `c58`), cambia la cantidad; M1 🧪 instrumento con control pero **28 renglones juzgables: NO MEDIDO a escala**. Dos defectos del instrumento tirados por el control (foto como árbitro de «llegó»; CEDIS sin foto leído como cero) | sesión Claude + PM |
