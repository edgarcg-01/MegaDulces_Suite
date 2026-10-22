# P-COM-01 — Ciclo: qué toca comprar hoy

> Paso 1 de 9 · pantalla `/compras/pedido`, pestaña **Ciclo** · [índice](README.md)

## 1. Para qué existe este paso

Contesta **«¿a quién le toca pedirle hoy?»**. Es el único paso que no sale de que alguien se
acuerde: la cadencia de cada proveedor por sucursal vence sola y la pantalla lo lista.

⭐ **Es lo que Kepler no tiene.** En el ERP la orden de compra se captura **cuando llega la
mercancía** (81.0 % de las OCs del CEDIS cierran el mismo día, p50 = 0 días; medido 2026-08-29), así
que no hay dónde aparezca un aviso de *«toca pedir»*. Sin este paso, el ciclo lo dispara el hueco en
el anaquel.

## 2. Quién lo ejecuta

| | |
|---|---|
| Permiso | `COMPRAS_PEDIDO_VER` |
| Roles que lo tienen (prod, 2026-10-16) | `auxiliar_compras`, `compras`, `compras_operaciones`, `direccion`, `encargado_tienda`, `finanzas`, `gerente_compras`, `marketing`, `superadmin`, `tesoreria` |
| En la práctica | el comprador de la categoría |

⚠️ El **almacenista** no entra acá: `COMPRAS_PEDIDO_VER` le está negado en explícito. Su mesa
equivalente es `/almacen/autoabasto` (`AUTOABASTO_VER`), que lee el mismo motor para otra decisión
—*qué pedir y a quién*— no para decidir la compra.

## 3. Disparador y entradas

- **Disparador:** la fecha. Un canal *(sucursal × proveedor)* entra a la lista cuando su cadencia
  vence; la pantalla los agrupa en **vencidos**, **toca hoy** y **próximos 7 días**.
- **Entrada de dato:** `analytics.replenishment_plan`, que refresca
  `database/importers/kepler/import-replenishment-plan.js` desde el ODS de Kepler (venta,
  existencia, costo de caja, política de reorden, OC en tránsito).
- ⛔ **La existencia sale del fact, no de la copia `commercial.stock`.** Medido contra prod el
  2026-10-15 sobre los 36,048 pares con política: la copia erraba **316,169 piezas (−6.7 %)** y
  producía **otra lista de compra** (21,781 bajo reorden contra 21,729).

## 4. Qué se hace

1. Abrir `/compras/pedido` → pestaña **Ciclo**.
2. Elegir el canal (**Compra** o **Traspaso**) en el selector de vía.
3. Leer los cuatro indicadores: *Vencidos · Toca hoy · Próximos 7 días · Canales activos*.
4. Entrar al canal que toca → la pantalla pasa al paso [P-COM-02](P-COM-02_armado_del_pedido.md)
   con ese proveedor y esa sucursal ya filtrados.

## 5. Qué queda registrado

**Nada.** Es un paso de lectura. ⚠️ Eso significa que **no existe constancia de que alguien miró el
ciclo y decidió no pedir**: *"lo revisé y está cubierto"* se ve exactamente igual que *"nunca lo
miré"*. Es el hueco que [P-COM-00](P-COM-00_ACTAS_POR_PASO.md) §2 propone cerrar.

## 6. Controles

| control | qué hace | por qué existe |
|---|---|---|
| Frescura del dato | píldora de frescura con el `data_as_of` del fact | un pedido sobre dato viejo no se distingue de uno sobre dato fresco |
| Estado `unknown` | si el servidor no manda frescura se declara **sin medir**, no «al día» | ADR-056: «no sé» no es «al día» |
| Base del objetivo | la cadencia manda el *cuándo*; la base (`cadence`/máximo/reorden/mínimo) manda el *cuánto* | llenar al máximo en artículos lumpy da ~1 año de cobertura e infla el pedido 5–10× |

## 7. Evidencia medida

- Cadencia y objetivo comparten helper con Existencia Crítica (`cadenceTarget()`), así que la
  columna «Costo est.» del ciclo y el detalle **siempre coinciden**.
- La pestaña Ciclo y la grilla de al lado contaban **existencias distintas** hasta el 2026-10-15
  (`[RA.VA.2]`); hoy las dos leen el fact.

## 8. Cuando falla

| síntoma | qué significa | qué hacer |
|---|---|---|
| La píldora de frescura dice `unknown` o `stale` | el importer del fact no corrió o no dejó latido | revisar `cron_runs` / `ods.ctl` antes de pedir — ver [`ERP_KEPLER.md` §4](../../ERP_KEPLER.md) |
| Un proveedor no aparece nunca | no tiene cadencia configurada | `/compras/proveedores` — los parámetros son los mismos que usa este motor |
| La lista sale vacía con filtros puestos | alcance por almacén | el servidor recorta la lista a los almacenes de la persona |

---

**Documento oficial de este paso:** ninguno hoy. Propuesta: *acta de revisión de ciclo* —
ver [P-COM-00](P-COM-00_ACTAS_POR_PASO.md).
