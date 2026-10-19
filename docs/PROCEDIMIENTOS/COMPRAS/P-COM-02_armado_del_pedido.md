# P-COM-02 — Armado del pedido: el comprador decide la cantidad

> Paso 2 de 9 · pantalla `/compras/pedido`, pestaña **Pedido** · [índice](README.md)

## 1. Para qué existe este paso

El motor **propone**; acá una persona **decide**. Es el único punto del flujo donde la cantidad se
puede cambiar con criterio humano, y es el que ADR-030 llama HITL: *el motor decide los umbrales, el
humano aprueba, el LLM fuera del camino*.

## 2. Quién lo ejecuta

| | |
|---|---|
| Permiso | `COMPRAS_PEDIDO_VER` (leer) · `COMPRAS_PEDIDO_GESTIONAR` (el asistente) |
| Roles con `GESTIONAR` (prod, 2026-10-16) | `auxiliar_compras`, `compras`, `compras_operaciones`, `encargado_tienda`, `finanzas`, `gerente_compras`, `marketing`, `superadmin`, `tesoreria` |

## 3. Disparador y entradas

- **Disparador:** un canal del paso [P-COM-01](P-COM-01_ciclo_que_toca_hoy.md), o una búsqueda
  directa por SKU (por ejemplo desde `/compras/existencia`, que navega acá con el SKU puesto).
- **Entradas por renglón:** venta de 30 días, existencia, en tránsito, costo de caja de **esa
  sucursal**, fill rate, clase ABC y la política de reorden.

## 4. Qué se hace

1. Marcar los chips que se quieren ver: **Comprar**, **Traspaso**, **Sobrestock**.
2. Ajustar la **Cobertura** (14/30/45 d) — mueve lo que el motor propone, no lo que ya editaste.
3. Abrir el renglón del producto → **desglose por sucursal**: cada sucursal trae su sugerido ya
   redondeado y topado, en cajas (o en piezas si no llega a media caja).
4. Escribir la cantidad definitiva donde haga falta.
5. Marcar los productos que van en esta vuelta.

⚠️ **Consolidar.** Si la compra se entrega en el CEDIS y baja por traspaso a la sucursal, la
pantalla lo avisa **antes** de armar: *«al armar se generan N traspasos CEDIS → sucursal»*. Son
documentos adicionales, no una nota.

## 5. Qué queda registrado

⛔ **Nada en el servidor.** Las cantidades editadas viven en el navegador hasta que se arma la
requisición ([P-COM-03](P-COM-03_armar_requisicion.md)).

- Hay guarda de cambios sin guardar: salir con trabajo editado avisa.
- ⚠️ Un F5 pierde las marcas, y **restaurarlas desde caché armaría un pedido más chico que el que
  la persona escribió** — por eso no se restauran: es preferible perderlo a armar de menos en
  silencio.

## 6. Controles

| control | qué hace | por qué existe |
|---|---|---|
| **Tope de cobertura (45 d)** | recorta el sugerido y **dice por qué** (`MotivoTope`) | sin tope, un artículo lumpy pide un año de inventario |
| **`sin_medir` no es cero** | si no hay con qué medir cobertura, se declara | recortar con un número inventado es peor que no recortar |
| **Peldaño de unidad contradicho (U.2)** | el renglón **no se puede pedir**: la cantidad queda en 0 y se dice | antes la tabla retenía el número y la requisición lo mandaba igual |
| **Aviso de duplicado** | *«ya se pidió lo mismo más de una vez»* al detectar documentos previos | ver §7 |
| **Tránsito** | el sugerido descuenta lo que ya viene en camino | sumar `c9` crudo del ERP ya infló el tránsito a $1,931M contra $54M de inventario real |

## 7. Evidencia medida

- **El aviso de duplicado no sobra:** tres pares de requisiciones con el mismo proveedor, el mismo
  importe y los mismos SKUs llegaron hasta la bandeja — `RQ-2026-00461`/`00468` ($245,670.00),
  `RQ-2026-00792`/`00802` ($30,350.00) y `RQ-2026-00760`/`00774` ($100,571.91) *(prod, 2026-10-16)*.
- La tabla de arriba y el desglose usan **el mismo número** desde `RA-PRO.47`; antes cada uno
  calculaba el suyo y el knob de Cobertura movía uno y no el otro.

## 8. Cuando falla

| síntoma | qué significa | qué hacer |
|---|---|---|
| Un renglón no deja escribir cantidad | peldaño de unidad sin verificar (U.2) | resolver la unidad del producto; **no** forzar el pedido por otra vía |
| «Maximum call stack» al abrir un desglose | recursión del índice por producto (`pedido-recursion.ts`) | reportar con el SKU: hay testigo dedicado |
| El sugerido se ve enorme | la base del objetivo no es `cadence` | volver a base cadencia en el paso 01 |
| Se perdió lo editado | F5 o sesión nueva | rehacerlo; **es a propósito** (§5) |

---

**Documento oficial de este paso:** ninguno hoy, y es el hueco más caro del flujo —
la decisión humana (subir, bajar o ignorar el sugerido) **no deja rastro**. Propuesta en
[P-COM-00](P-COM-00_ACTAS_POR_PASO.md) §2.
