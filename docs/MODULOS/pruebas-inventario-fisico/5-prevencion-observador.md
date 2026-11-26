# 5 · Prevención y observadores — los que sólo miran

> Pruebas **de esta persona**. Lo común vive en
> [`../inventario-fisico-PRUEBAS.md`](../inventario-fisico-PRUEBAS.md).

## Quién es, medido en prod el 2026-11-25

**54 personas** tienen `COMMERCIAL_INVENTORY_VER` y nada más del módulo. Es el permiso más
repartido de los seis, y el más pobre:

| Rol | Personas | Nota |
|---|---:|---|
| `encargado_tienda` | 19 | además asigna (bloque 2) |
| `almacenista` | 11 | además cuenta (bloque 3) |
| `superadmin` | 10 | |
| `marketing` | 5 | |
| `customer_b2b` | 4 | ⚠️ **clientes del portal** |
| `direccion` | 4 | |
| `compras` / `gerente_compras` | 4 + 4 | |
| **`prevencion_auxiliar`** | **3** | sólo VER |
| `supervisor` | 3 | |
| **`prevencion`** | **2** | sólo VER |

⭐⭐ **Lo que define a este bloque es una pregunta de producto, no de software: ¿alcanza este
permiso para el oficio de quien lo tiene?**

**Prevención son cinco personas cuyo trabajo *es* el descuadre de inventario**, y en este módulo
pueden mirar la lista de folios y nada más: **no ven el teórico** (eso es `SUPERVISAR`), no abren,
no cuentan, no cierran, no cancelan. Un auditor que no ve contra qué se contó no puede auditar.

⚠️ Y `customer_b2b` —clientes del portal— tiene `VER`. Eso hay que mirarlo con cuidado: no por
esta pantalla, sino porque la clave se comparte con otros lectores del módulo.

---

## Su jornada

```
entrar → /almacen/inventory/sessions → mirar → (no hay más)
```

La prueba de esta persona es, literalmente, **medir hasta dónde llega**.

---

## `VER-J` · Lo que sí puede

| ID | Paso | Tiene que pasar | Niv |
|---|---|---|---|
| `VER-J1` | Entrar a la lista de folios | La ve | B |
| `VER-J2` | Mirar una fila | Ve folio, almacén, tipo, avance, estado, fechas | C |
| `VER-J3` | Buscar el botón «Abrir folio» | **No está** | C |
| `VER-J4` | Hacer clic en una fila | ⚠️ Anotar qué pasa: la pantalla decide entre navegar al detalle (`SUPERVISAR`) o abrir el diálogo de asignar (`ASIGNAR`). **Quien no tiene ninguno de los dos no debería quedar con una fila que parece un botón y no hace nada** | 🔴 C |

⭐ `VER-J4` es el hallazgo probable de este bloque: la fila lleva `role="button"` y `tabindex="0"`
sin condicionar, así que **anuncia una acción a quien no la tiene**. Con teclado es peor: es una
parada de tabulación que no lleva a ningún lado.

---

## `VER-N` · Sus negativas — todas

| ID | Qué intenta | Tiene que pasar | Niv |
|---|---|---|---|
| `VER-N1` | Abrir un folio (`POST /open`) | 403 | B |
| `VER-N2` | Ver el **teórico** (`/counts/:id/items`) | 403 | B |
| `VER-N3` | Entrar al **detalle** por URL directa | 403 | B |
| `VER-N4` | Asignar personas | 403 | B |
| `VER-N5` | Capturar un conteo | 403 | B |
| `VER-N6` | Reconciliar | 403 | B |
| `VER-N7` | Cancelar | 403 | B |
| `VER-N8` | Exportar a Kepler | 403 | B |

---

## `VER-P` · Las preguntas de producto que este bloque tiene que contestar

No se contestan con un `expect`: se contestan **anotando lo que se vio** y llevándolo a
[`MATRIZ_ACCESOS.md`](../../MATRIZ_ACCESOS.md).

| ID | Pregunta | Por qué importa |
|---|---|---|
| `VER-P1` | ⭐ Con sólo `VER`, **¿Prevención puede hacer su trabajo?** Recorrer la pantalla como ellos y anotar qué les falta para auditar un conteo | Son el área del descuadre y hoy tienen el acceso más pobre. Si la respuesta es no, el reparto está mal, no la pantalla |
| `VER-P2` | ¿Qué ve **Dirección** (4 personas) al entrar? | Hoy: seis folios cancelados de junio y nada más. Anotar si eso comunica algo útil |
| `VER-P3` | ¿Por qué **`customer_b2b`** tiene esta clave? | Revisar si por esta vía un cliente del portal alcanza algo del módulo |
| `VER-P4` | ⚠️ ¿Por qué **`marketing`** supervisa y **`prevencion`** no? | El reparto es herencia de cuando el permiso se agrupaba por módulo. Nadie lo decidió así |

---

## `VER-D` · Lo que la pantalla le debe

| ID | Qué se mira | Sev | Niv |
|---|---|---|---|
| `VER-D1` | La fila que **parece** accionable y no lo es (`VER-J4`) | 🔴 | C |
| `VER-D2` | El vacío: quien sólo mira lee *«No hay folios. Abre uno para empezar a contar»* — **un consejo que no puede seguir** | 🟠 | C |
| `VER-D3` | **Forzar un 500**: mismo defecto que para todos, se lee como «no hay folios» | 🔴 | C |
| `VER-D4` | Recorrer la pantalla **sólo con teclado**: ¿cuántas paradas no llevan a nada? | 🟠 | C |
