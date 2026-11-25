# 1 · Supervisor de oficina — el que abre el folio

> Pruebas **de esta persona**, no del módulo. Lo común a todas vive en
> [`../inventario-fisico-PRUEBAS.md`](../inventario-fisico-PRUEBAS.md).

## Quién es, medido en prod el 2026-11-25

**21 personas** con `COMMERCIAL_INVENTORY_SUPERVISAR`, repartidas así:

| Rol | Personas | Aparato con el que entra |
|---|---:|---|
| `superadmin` | 10 | Windows |
| `marketing` | 5 | Windows |
| `compras` | 4 | Windows |
| `gerente_compras` | 4 | Windows |
| `supervisor` | 3 | Windows |

⭐⭐ **Lo que define a esta persona: no está en la sucursal que manda a contar.** Ni un solo
`almacenista` ni un solo `encargado_tienda` tiene este permiso. Quien abre el folio —y por lo
tanto quien **congela un almacén**— es alguien de oficina, en una computadora, que no ve el
pasillo, no sabe si hay gente ese día y no sufre la consecuencia de congelar.

⚠️ **Y cinco de los veintiuno son `marketing`**, que puede abrir y congelar pero **no puede
cerrar** (no tiene `RECONCILIAR`). Ese corte es real y se prueba abajo.

**Todos entran desde Windows.** Ninguna prueba de esta persona necesita táctil.

---

## Su jornada, de principio a fin

Es corta y ése es el problema: **entra, abre un folio, y se va.** La consecuencia la vive otro.

```
entrar → /almacen/inventory/sessions → leer la lista → «Abrir folio»
       → elegir almacén · tipo · congelar · doble ciego · umbral
       → (si es cíclico) elegir clase ABC y tope
       → Abrir → leer el aviso → salir
```

El guion de Playwright de esta persona tiene que recorrer **ese camino entero sin pausas**, porque
así es como ocurre: nadie se queda mirando la pantalla después de abrir.

---

## `SUP-J` · La jornada tiene que funcionar

| ID | Paso | Tiene que pasar | Niv |
|---|---|---|---|
| `SUP-J1` | Entrar y leer la lista | Dice cuántos folios hay, cuántos en curso y **cuántos congelando un almacén** | C |
| `SUP-J2` | Abrir folio **total** de una sucursal | El aviso nombra **cuántos SKUs** y que el alcance es «total del almacén» | B |
| `SUP-J3` | Abrir folio **cíclico** clase A, tope 100 | El folio trae **100 renglones**, no el almacén entero. El aviso dice «cíclico clase A» | B |
| `SUP-J4` | Abrir cíclico en almacén **sin ABC** | Avisa que no se puede acotar y **ofrece la salida**; el botón Abrir queda apagado | C |
| `SUP-J5` | Asignar el equipo desde el mismo diálogo de apertura | Si falla la asignación, el aviso dice **«folio abierto, pero falló la asignación»**, no «no se abrió» | B |

---

## `SUP-H` · Los errores que **sólo esta persona** comete

Son errores de **distancia**: los comete porque no está ahí.

| ID | Qué se hace a propósito | Tiene que pasar | Sev | Niv |
|---|---|---|---|---|
| `SUP-H1` | Elegir **una camioneta de ruta** creyendo que es la sucursal | ⛔ El selector ofrece **28 almacenes y sólo 10 son contables**: 18 son bodegas de camioneta, **cinco rutas aparecen duplicadas** con dos códigos (`01-002`…`01-006` y `RUTA-22`…`RUTA-28`) y sigue vivo `MD-32`, que el código llama «un almacén borrado». Anotar si alguien de oficina puede distinguirlos sin saberlo de memoria | 🔴 | C |
| `SUP-H2` | **Congelar un almacén un viernes a las 6 pm** y no volver | A las 24 h la lista marca «Sin conteos»; a los 7 días en rojo. ⛔ Verificar que **el almacén siga congelado todo el fin de semana** y anotar quién puede destrabarlo: **no el encargado de esa tienda**, que no tiene `CANCELAR`. ⭐⭐ **Esto no es hipotético: ya pasó.** `INV-2026-00009` congeló **Padre Hidalgo 101 días** —del 19-jun al 28-sep de 2026— con 8 escaneos sobre 2,094 artículos. Se destrabó recién cuando se abrió `cancel` a `CANCELAR_CONTEO`; hasta entonces, de las 5 personas que entraban al Andén **sólo 1** podía hacerlo | 🔴 | B |
| `SUP-H3` | Abrir un folio **total** en la sucursal más grande sin saber que son 4,819 SKUs | Antes de abrir tiene que saber **cuántos SKUs va a mandar a contar**. Anotar si la pantalla lo dice antes o sólo después | 🔴 | C |
| `SUP-H4` | Abrir un **segundo folio** del mismo almacén | Rechazo que nombra **cuál** folio lo ocupa | 🔴 | B |
| `SUP-H5` | Abrir un folio con SKUs **ya incluidos en otro folio vivo** | Rechazo nombrando el otro folio. Un SKU en dos conteos: el segundo ajuste pisa al primero | 🔴 | B |
| `SUP-H6` | Dejar **«congelar» prendido en un cíclico** | La pantalla ya avisa que normalmente va apagado; verificar que el aviso se lea **antes** de apretar | 🟠 | C |
| `SUP-H7` | Dejar el **umbral de recuento en 0** | Anotar si se entiende la consecuencia antes de abrir | 🟡 | C |
| `SUP-H8` | **Doble clic** en Abrir | Un solo folio | 🔴 | C |

---

## `SUP-N` · Sus negativas — lo que **esta** persona no debe poder

| ID | Quién | Qué intenta | Tiene que pasar | Niv |
|---|---|---|---|---|
| `SUP-N1` | ⭐ un usuario con rol **`marketing`** | **Cerrar** un folio (`/reconcile`) | **403.** Puede abrir y congelar, pero cerrar es de `compras`, `gerente_compras`, `supervisor` y `superadmin`. Y **no debería ver el botón** | B |
| `SUP-N2` | supervisor que **contó** un renglón | Cerrar ese folio | 403 por segregación de funciones | B |
| `SUP-N3` | supervisor con rol **`marketing`** | **Cancelar** un folio | Marketing **sí** puede cancelar. Anotar que puede abandonar lo que no puede cerrar | B |
| `SUP-N4` | supervisor | Abrir folio en un almacén **de otro tenant** | 404 | B |

---

## `SUP-D` · Lo que la pantalla le debe a esta persona

Esta persona decide **a ciegas sobre un lugar que no ve**. Todo lo de abajo es información que
necesita y hoy no tiene.

| ID | Qué se mira | Hoy | Sev | Niv |
|---|---|---|---|---|
| `SUP-D1` | **Forzar un 500 en la carga de la lista** | ⛔ Se pinta *«No hay folios. Abre uno para empezar a contar.»* Un fallo se lee como «no hay nada» — y esta persona, que no está en la sucursal, **no tiene cómo enterarse de otro modo**. Deuda sellada `§2` desde el 2026-10-19 | 🔴 | C |
| `SUP-D2` | ¿**De cuándo** es lo que ve? | No lo dice. Deuda sellada `§9` | 🟠 | C |
| `SUP-D3` | Separar folios **vivos** de **cancelados** | Van mezclados; hoy la lista son seis muertos | 🟠 | C |
| `SUP-D4` | Filtrar por **sucursal** | No hay filtro, aunque el servidor lo acepta. Con 9 sucursales y un tope de 200 folios, esta persona va a buscar a mano | 🟠 | C |
| `SUP-D5` | Entender **qué significa «Congelado»** sin pasar el mouse | La definición vive **sólo en un tooltip** | 🟡 | C |
| `SUP-D6` | Leer la celda **«Sin snapshot»** | Jerga nuestra publicada como dato | 🟡 | C |
| `SUP-D7` | Ver **el avance real** de un folio con doble conteo ciego | ⛔ La barra mide **sólo el primer pase**: llega a 100 % con el segundo sin empezar. Para quien está lejos, eso es «ya terminaron» cuando van a la mitad | 🔴 | B |

---

## Lo que no se puede probar todavía

- Todo lo marcado `B` espera la decisión **D-PW1** (contra qué corre Playwright).
- `SUP-N1` —el corte de marketing— es de las primeras que hay que correr: es un permiso raro que
  nadie decidió a propósito y conviene saber si de verdad frena.
