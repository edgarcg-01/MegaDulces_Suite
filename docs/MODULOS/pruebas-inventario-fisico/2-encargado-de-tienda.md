# 2 · Encargado de tienda — el que arma el equipo

> Pruebas **de esta persona**. Lo común vive en
> [`../inventario-fisico-PRUEBAS.md`](../inventario-fisico-PRUEBAS.md).

## Quién es, medido en prod el 2026-11-25

**19 personas con rol `encargado_tienda`** son el grueso de `COMMERCIAL_INVENTORY_ASIGNAR` (38 en
total, el resto son los mismos de oficina del bloque 1).

| Aparato | Personas |
|---|---:|
| Windows | 16 |
| Android | 1 |
| iOS | 1 |
| nunca entró | 1 |

⭐⭐ **Lo que define a esta persona: está en la tienda y tiene el permiso más recortado de todos
los que tocan el módulo.** Puede armar el equipo y **nada más**:

| Puede | No puede |
|---|---|
| ver la lista de folios | ⛔ ver el teórico (`/counts/:id/items` → 403) |
| asignar contadores y supervisores | ⛔ abrir un folio |
| | ⛔ **cancelar un folio** — `encargado_tienda` **no** tiene `CANCELAR_CONTEO` |
| | ⛔ reconciliar |

⚠️ **Ese tercer renglón es el que duele.** Esta persona es la que está parada en la tienda cuando
el almacén lleva seis días congelado, es la que ve el aviso rojo en la lista… **y es la única de
las tres que no puede destrabarlo.** El almacenista sí puede cancelar; el encargado no.

---

## Su jornada

```
entrar → /almacen/inventory/sessions
       → (la fila NO la lleva al detalle: le abre el diálogo «Quién cuenta»)
       → elegir contadores entre 263 nombres · elegir supervisores
       → Guardar → salir
```

⭐ La pantalla está partida a propósito para esta persona: su clic en la fila **no** navega al
detalle (que le daría 403), le abre el diálogo. Eso es lo primero que hay que verificar.

---

## `ASG-J` · La jornada tiene que funcionar

| ID | Paso | Tiene que pasar | Niv |
|---|---|---|---|
| `ASG-J1` | Entrar a la lista | Ve los folios. **No ve el botón «Abrir folio»** | C |
| `ASG-J2` | Hacer clic en una fila | Se abre el diálogo «Quién cuenta», **no** navega al detalle | C |
| `ASG-J3` | Lo mismo con **Enter** sobre la fila | Hace exactamente lo mismo que el clic. Si divergieran, el teclado la mandaría a un 403 | 🔴 C |
| `ASG-J4` | El diálogo abre | Llega **con lo ya asignado cargado**, no en blanco | C |
| `ASG-J5` | La lista de personas | Los de **su** sucursal salen agrupados arriba, el resto abajo, y **nadie queda escondido** (las 90 promotoras activas no tienen sucursal y caen siempre en el segundo grupo) | B |
| `ASG-J6` | Guardar | Aviso con cuántos contadores y cuántos supervisores quedaron | B |

---

## `ASG-H` · Los errores que **sólo esta persona** comete

Son errores de **elegir personas**: nadie más en el módulo elige gente.

| ID | Qué se hace a propósito | Tiene que pasar | Sev | Niv |
|---|---|---|---|---|
| `ASG-H1` | Elegir **20 personas** y hacer **clic fuera del diálogo** | ⛔ Hoy se pierde todo sin preguntar (`dismissableMask`). Tiene que preguntar «¿Descartar cambios sin guardar?» | 🔴 | C |
| `ASG-H2` | Lo mismo con **Esc** | Igual | 🔴 | C |
| `ASG-H3` | Elegir entre **dos personas con el mismo nombre** | La etiqueta trae `Nombre — puesto · sucursal`. Con **263 nombres** y repetidos, sin eso se elige al azar | 🔴 | B |
| `ASG-H4` | Asignar a alguien **ya comprometido en otro folio vivo** | La etiqueta dice «· ya en INV-…». Verificar que se vea **al elegir**, no después. Si no, el problema aparece el día del inventario, cuando esa persona no llega | 🔴 | B |
| `ASG-H5` | Guardar con la lista **vacía** | ⚠️ `setAssignments` **reemplaza**: guardar vacío **borra el equipo**. Anotar si avisa o lo hace en silencio | 🔴 | B |
| `ASG-H6` | Buscar en el filtro por **puesto** y por **sucursal**, no sólo por nombre | Los tres filtran (el campo dice «Nombre, puesto o sucursal») | 🟠 | B |
| `ASG-H7` | Intentar asignar en un folio **cancelado** | 409 claro, y el botón no debería estar | 🟠 | C |
| `ASG-H8` | **Doble clic** en Guardar | Una sola escritura | 🟠 | C |

---

## `ASG-C` · Causalidad — la tienda tiene peor red que la oficina

| ID | Qué se provoca | Tiene que pasar | Sev | Niv |
|---|---|---|---|---|
| `ASG-C1` | **500 al leer** lo ya asignado | El diálogo **se cierra** con aviso, en vez de dejar un Guardar que borraría al equipo. *(Resuelto en código: verificar que de verdad ocurra)* | 🔴 | C |
| `ASG-C2` | ⭐ **Falla sólo la segunda de las dos llamadas** (contadores sí, supervisores no) | ⛔ Hoy las dos van en paralelo y **no son atómicas**: los contadores **quedan guardados** y el aviso dice «No se guardó». Esta persona va a reintentar creyendo que no pasó nada | 🔴 | C |
| `ASG-C3` | Cortar la red al guardar | Mensaje accionable y **lo elegido sigue en pantalla** para reintentar | 🟠 | C |
| `ASG-C4` | Caerse la red con el diálogo abierto y 20 elegidos | Anotar si se pierde la selección | 🟠 | C |

---

## `ASG-N` · Sus negativas

| ID | Qué intenta | Tiene que pasar | Niv |
|---|---|---|---|
| `ASG-N1` | Entrar al **detalle** del folio por URL directa | 403, y **no debería haber visto el enlace** | B |
| `ASG-N2` | Pedir `/counts/:id/items` (el teórico) | 403 | B |
| `ASG-N3` | Abrir un folio (`POST /open`) | 403, y no ve el botón | B |
| `ASG-N4` | ⭐ **Cancelar** el folio congelado de su propia tienda | **403.** Es lo que la deja atrapada: ve el problema y no tiene el remedio. **Anotar a quién tiene que llamar** | B |
| `ASG-N5` | Reconciliar | 403 | B |
| `ASG-N6` | Asignar en el folio **de otra sucursal** | ⚠️ Hoy **no hay alcance por sucursal**: el aislamiento es sólo por tenant. Anotar si puede tocar el folio de otra plaza | 🔴 B |

---

## `ASG-D` · Lo que la pantalla le debe

| ID | Qué se mira | Hoy | Sev | Niv |
|---|---|---|---|---|
| `ASG-D1` | Que **no vea botones que le dan 403** | Resuelto: la pantalla oculta «Abrir folio» y el enlace al detalle. Verificar que se cumple **también con el teclado** | 🔴 | C |
| `ASG-D2` | El vacío de la lista, leído por ella | Dice «No hay folios abiertos. Cuando se abra uno, acá asignas quién cuenta» — distinto del que ve el supervisor. Verificar | 🟠 | C |
| `ASG-D3` | **Forzar un 500 en la lista** | Mismo defecto que para todos: se lee como «no hay folios» | 🔴 | C |
| `ASG-D4` | El diálogo en una pantalla de tienda (resolución chica) | Anotar si la lista de 263 nombres es usable: `scrollHeight="45vh"` | 🟠 | C |
| `ASG-D5` | Elegir 20 personas **sin mouse** | La tarea completa con teclado | 🟠 | C |

---

## Lo que esta persona enseña del módulo

Si al correr estas pruebas aparece que puede asignar el folio de otra sucursal (`ASG-N6`), o que
no puede destrabar su propia tienda (`ASG-N4`), **eso no es un defecto de pantalla: es el reparto
de permisos**. Se arregla en [`MATRIZ_ACCESOS.md`](../../MATRIZ_ACCESOS.md), no en el componente, y
se anota igual.
