# Procedimientos — Compra (`/compras/pedido` → requisición → ERP)

> **Qué es esto:** un procedimiento oficial **por cada paso** del flujo de compra. Nueve pasos,
> nueve documentos. Lo que describe el flujo completo de un vistazo es
> [`FLUJO_COMPRAS_PEDIDO.md`](../../FLUJO_COMPRAS_PEDIDO.md); acá cada paso se trata solo.
>
> **Fecha de corte: 2026-10-16.** Todo lo que dice «medido» se leyó ese día contra prod
> (`pg-prod`, `system_identifier 7688376744939610156`) y contra las réplicas Kepler
> `kepler_md_00..07`. Lo que no se midió, se declara.

---

## Los nueve pasos

| # | Procedimiento | Quién lo ejecuta | Qué deja al terminar |
|---|---|---|---|
| 01 | [Ciclo: qué toca hoy](P-COM-01_ciclo_que_toca_hoy.md) | Comprador | nada — es lectura |
| 02 | [Armado del pedido](P-COM-02_armado_del_pedido.md) | Comprador | nada persistente ⚠️ |
| 03 | [Armar la requisición](P-COM-03_armar_requisicion.md) | Comprador | **`RQ-YYYY-NNNNN`** + lote |
| 04 | [Bandeja y vigencia del costo](P-COM-04_bandeja_y_vigencia.md) | Comprador | `recalculated_at` |
| 05 | [Autorización](P-COM-05_autorizacion.md) | **Una sola persona** | estado `approved` |
| 06 | [Salida a Kepler](P-COM-06_salida_a_kepler.md) | Automático al autorizar | `X-A-30` / `U-D-40` ⛔ apagado |
| 07 | [Orden de compra](P-COM-07_orden_de_compra.md) | Comprador | `X-A-35` (Kepler) u `OC-YYYY-NNNNN` |
| 08 | [Recepción](P-COM-08_recepcion.md) | Almacén / compras | `OE-YYYY-NNNNN` · `X-A-40`→XA2001 |
| 09 | [Cierre del lazo](P-COM-09_cierre_del_lazo.md) | Comprador | nada — es verificación |

➡️ **El diseño de qué documento oficial debería emitir cada paso (y cuáles hoy no emiten nada)
está en [`P-COM-00_ACTAS_POR_PASO.md`](P-COM-00_ACTAS_POR_PASO.md).**

---

## Cómo está escrito cada procedimiento

Las nueve fichas tienen las mismas ocho secciones, siempre en el mismo orden:

1. **Para qué existe este paso** — la decisión que resuelve. Si no resuelve una, sobra.
2. **Quién lo ejecuta** — permiso exacto y quién lo tiene **medido en prod**, no el organigrama.
3. **Disparador y entradas** — qué lo arranca y de qué dato depende.
4. **Qué se hace** — la secuencia en pantalla.
5. **Qué queda registrado** — documento, estado y columnas. Si no queda nada, lo dice.
6. **Controles** — qué frena, por qué, y con qué salida.
7. **Evidencia medida** — cifras con fecha.
8. **Cuando falla** — qué hacer, y a quién le toca.

⛔ **Regla de escritura de estas fichas:** ninguna afirma un responsable, un control o una cifra
que no se haya verificado contra prod o contra el código. Lo que no se pudo medir aparece como
**NO MEDIDO**, nunca como cero ni como verde (ADR-056).

---

## Dos cosas que hay que saber antes de leer cualquiera

### 1. El permiso de autorizar se reparte POR PERSONA, no por rol

`COMPRAS_REQUISICIONES_AUTORIZAR` **no existe en ninguno de los 57 roles** de
`identity.role_permissions`. Vive en `identity.user_permissions`, el override por persona —y ahí
está bien puesto:

| persona | rol | desde | otorgado por |
|---|---|---|---|
| `arizbeth_gonzalez` | `gerente_compras` | 2026-10-08 | migración `20261008115334` |
| `superuser` | `direccion` | 2026-10-15 | `superoot` |

⚠️ **Y esto hace que `docs/MATRIZ_ACCESOS.md` diga «nadie» para esa llave.** La matriz se genera
desde los **roles**, así que **los 318 overrides por persona (239 llaves distintas) le son
invisibles**. Leer la matriz y concluir *"nadie puede autorizar"* es el error que esta nota existe
para evitar — y es fácil de cometer: lo cometió quien escribió estas fichas, antes de ir al dato.

### 2. El estado `ordered` no lo pone quien captura la orden de compra

`markOrdered` exige la coordenada de la OC de Kepler (sucursal + folio) desde `[RQ.15]`. Pero el
camino que se usa de verdad es la **OC interna** (`createPOFromRequisition`), que mueve la
requisición a `ordered` sin pedir nada del ERP. Medido: **121 requisiciones `ordered`/`received`
sin `oc_folio`** y **121 OC internas** ligadas a requisición. Calzan exacto. Ver
[P-COM-07](P-COM-07_orden_de_compra.md) §6.

---

## Estado del flujo, medido el 2026-10-16

| | |
|---|---:|
| Requisiciones en prod | **901** |
| `approved` · `cancelled` · `ordered` · `received` · `pending_approval` | 398 · 368 · 103 · 18 · 14 |
| Aprobadas históricas (incluye las que ya avanzaron) | **519**, de ellas **505 por `arizbeth_gonzalez`** |
| Lotes armados desde Pedido | 53 lotes / 221 documentos (promedio 4.2, el peor 18) |
| Con el costo recalculado antes de autorizar | **1 de 901** |
| Con documento escrito en Kepler (`kepler_folio`) | **1** (y apunta a un documento borrado) |
| Con la coordenada de la OC de Kepler (`oc_folio`) | **0** |
| Recepciones internas (`commercial.goods_receipts`) | 65 |

---

## Relacionados

- [`FLUJO_COMPRAS_PEDIDO.md`](../../FLUJO_COMPRAS_PEDIDO.md) — el flujo completo y la comparación
  contra la cadena de Kepler, con el cuadre medido (§6-bis).
- [`FASE_RA`](../../IMPLEMENTACION/FASES/FASE_RA_REABASTECIMIENTO.md) — el motor del sugerido.
- [`FASE_KR`](../../IMPLEMENTACION/FASES/FASE_KR_REQUISICION_A_KEPLER.md) + el
  [runbook de encendido](../../IMPLEMENTACION/RUNBOOKS/KEPLER_PUSH_DESPLIEGUE.md).
- [`ERP_KEPLER.md`](../../ERP_KEPLER.md) §3 — el modelo de documentos del ERP.
