# P-COM-07 — La orden de compra

> Paso 7 de 9 · `/compras/requisiciones` → **Marcar ordenada** · `/compras/ordenes` ·
> [índice](README.md)

## 1. Para qué existe este paso

Es donde la requisición **se le ordena al proveedor**. Y es el paso con **dos caminos que no hacen
lo mismo**, cosa que hay que tener clara antes de operarlo.

| camino | qué produce | mueve stock | dónde vive |
|---|---|---|---|
| **A. Marcar ordenada** | la **coordenada** de la OC que alguien capturó en Kepler | no | la OC vive en el ERP (`X-A-35`) |
| **B. OC interna** (RA.15 / ADR-031) | `OC-YYYY-NNNNN` propia | no (la mueve la OE) | `commercial.purchase_orders` |

## 2. Quién lo ejecuta

| | |
|---|---|
| Camino A (`POST /requisitions/:id/order`) | `COMPRAS_REQUISICIONES_GESTIONAR` |
| Camino B (`POST /purchase-orders/from-requisition/:id`) | `COMPRAS_ORDENES_GESTIONAR` — mismos 9 roles |
| Quién ordena de verdad | **`gerente_compras`, 79 requisiciones** *(prod, 2026-10-16)* — nadie más |

## 3. Disparador y entradas

- **Disparador:** la requisición está `approved` y el comprador ya emitió (o va a emitir) la orden.
- **Entrada del camino A:** **sucursal + folio** de la OC de Kepler. Los dos, o ninguno.

## 4. Qué se hace

**Camino A:** abrir la requisición aprobada → *Marcar ordenada* → capturar sucursal y folio de la
OC de Kepler → la requisición pasa a `ordered`.

**Camino B:** generar la OC desde la requisición → nace `open`, y la requisición pasa a `ordered`
sin pedir nada del ERP.

## 5. Qué queda registrado

- Camino A: `estado=ordered`, `ordered_by/at`, **`oc_sucursal` + `oc_folio`**, y aparte
  `oc_capturada_por` / `oc_capturada_at` — porque **quién capturó el folio es dato distinto de
  quién movió el estado**: con el tiempo el segundo se automatiza y el primero sigue siendo una
  persona mirando un papel.
- Camino B: `commercial.purchase_orders` + `_lines`, folio `OC-YYYY-NNNNN`, estado
  `open → partial → received`.

## 6. ⛔ El control existe y el camino real lo rodea

`markOrdered` **exige** el folio desde `[RQ.15]` (2026-10-09) y rebota sin él. Pero medido en prod
el 2026-10-16:

| | |
|---|---:|
| Requisiciones con `oc_folio` capturado | **0** de 901 |
| `ordered` / `received` **sin** `oc_folio` | **121** |
| …posteriores a la migración del 2026-10-09 | 78 |
| **OC internas ligadas a una requisición** | **121** |

⭐ **121 y 121 calzan exacto:** quien mueve a `ordered` es el **camino B**, que no pide la
coordenada. Mientras siga así, `oc_folio` va a quedar en cero **por diseño, no por descuido** — y
la liga requisición↔OC de Kepler nunca se podrá capturar, que es justo lo que
[P-COM-09](P-COM-09_cierre_del_lazo.md) tiene que **inferir**.

⚠️ **Y se lee como falta de disciplina.** Un campo obligatorio vacío invita a concluir *«no lo
capturan»*; lo medido dice que **el camino real lo rodea**. Descartar el defecto de flujo antes de
culpar a la gente.

## 7. Evidencia medida: ¿aterrizan nuestras requisiciones en Kepler?

121 requisiciones de compra contra 8,885 documentos `X-A-30`+`X-A-35` *(2026-10-16)*:

| prueba | real `[f, f+15d]` | **placebo** `[f−30, f−15d]` |
|---|---:|---:|
| hay algún documento del mismo proveedor + sucursal | 59 (48.8 %) | 43 (35.5 %) |
| …con el **mismo importe** (±0.5 %) | **6 (5.0 %)** | **0 (0.0 %)** |

| cobertura por SKU de la mejor OC | reqs | % |
|---|---:|---:|
| **100 %** de los SKUs | **47** | 38.8 % |
| 70–99 % | 5 | 4.1 % |
| menos | 7 | 5.8 % |
| **ningún documento de ese proveedor** | **62** | **51.2 %** |

⭐ **47 aterrizan completas en lista; 6 además en dinero.** La diferencia es el comprador cambiando
cantidades — lo normal: la OC trae **de 0.1× a 94×** lo pedido del mismo producto.

⭐⭐ **Y en los 6 pares que se pudieron cuadrar renglón por renglón (37 SKUs): el importe coincide
al centavo en 37/37, la cantidad en 0/37** — porque nosotros pedimos en **cajas** y Kepler escribe
la línea en la unidad del producto. El factor es **exactamente `kdm2.c58`**, sin una excepción:

```
cantidad_kepler = cajas x c58        costo_kepler = costo_caja / c58
importe = invariante  ->  por eso cuadra al centavo
```

## 8. Cuando falla

| síntoma | qué significa | qué hacer |
|---|---|---|
| «hay que decir de qué orden de compra se trata» | falta sucursal o folio | capturar **los dos**: un folio suelto se repite entre sucursales |
| La requisición ya está `ordered` sin que nadie capturara nada | se usó el camino B | si hace falta la liga al ERP, capturarla igual |
| La OC de Kepler trae otra cantidad | normal (§7) | no «corregir» la requisición: la OC es del comprador |
| No aparece documento del proveedor | 51.2 % de los casos | revisar en [P-COM-09](P-COM-09_cierre_del_lazo.md) si salió fuera de ventana o en otra sucursal |

---

**Documento oficial de este paso:** `X-A-35` (en el ERP) u `OC-YYYY-NNNNN` (interna). ⛔ **Lo que
falta no es un documento más: es que los dos caminos converjan** — ver
[P-COM-00](P-COM-00_ACTAS_POR_PASO.md) §7.
