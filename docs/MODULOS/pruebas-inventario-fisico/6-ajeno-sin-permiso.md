# 6 · El ajeno — quien no tiene ningún permiso del módulo

> Pruebas **de esta persona**. Lo común vive en
> [`../inventario-fisico-PRUEBAS.md`](../inventario-fisico-PRUEBAS.md).

## Quién es

Todo el que **no** aparece en los bloques 1 a 5: vendedores de ruta, repartidores, telemarketing,
tesorería, crédito y cobranza, piso de tienda, auxiliares, promotoras. Medido el 2026-11-25, los
roles con **`false` en los seis permisos del módulo** son 15 de los 26 activos.

⭐⭐ **Es el bloque que siempre se salta y el único que prueba que los candados existen.** Una
pantalla que funciona para quien tiene permiso no dice nada sobre quien no lo tiene.

⛔⛔ **Y no se prueba con un admin.** Los roles de plataforma pasan por god-mode: un permiso que
nadie repartió **sale verde igual**. Hay que crear un usuario efímero sin ninguna de las seis
claves y recorrer con él.

---

## `AJE-1` · La puerta: las rutas del navegador

| ID | Qué intenta | Tiene que pasar | Niv |
|---|---|---|---|
| `AJE-1a` | Entrar a `/almacen/inventory/sessions` por URL directa | Rebota al inicio o a «sin acceso». **Nunca** una pantalla a medias | B |
| `AJE-1b` | Entrar a `/almacen/inventory/sessions/:id` | Rebota | B |
| `AJE-1c` | Entrar a `/almacen/inventory/sessions/:id/teams` | Rebota | B |
| `AJE-1d` | Entrar a `/almacen/inventory/count` | Rebota | B |
| `AJE-1e` | Entrar a `/almacen/inventory/diferencias`, `/abc`, `/ira`, `/aisles` | Rebotan las cuatro | B |
| `AJE-1f` | ⭐ Mirar **su barra lateral** | Ninguna entrada del módulo aparece. Una entrada que lleva a un rebote es peor que no tenerla | B |

---

## `AJE-2` · El fondo: los 29 endpoints del controlador

⛔ **Ésta es la única prueba que demuestra que ningún endpoint quedó sin guard.** No alcanza con
probar los que la pantalla usa: un endpoint sin candado se alcanza con `curl`.

| ID | Qué se hace | Tiene que pasar | Niv |
|---|---|---|---|
| `AJE-2a` | Llamar **los 29** endpoints de `inventory-count.controller.ts` con el token del ajeno | **403 en todos.** Se recorre el controlador y se arma la lista: no se escriben de memoria | 🔴 B |
| `AJE-2b` | Llamar los endpoints **sin token** | 401 en todos | 🔴 B |
| `AJE-2c` | Llamar con un token **caducado** | 401, no 500 | 🟠 B |
| `AJE-2d` | Llamar con un token **de otro tenant** | 404 (no se confirma que el folio exista) | 🔴 B |

⭐ **Las ocho rutas del contador son el caso especial.** No llevan `@RequirePermissions`: llevan
un guard que deja pasar a quien **trae la clave** *o* a quien **está asignado al folio vivo**
(`mine`, `resolve`, `:id/count`, `count-progress`, `catalog`, `session/start`, `session/finish`,
`interruption`). Hay que probar las tres situaciones:

| ID | Quién | Tiene que pasar | Niv |
|---|---|---|---|
| `AJE-2e` | ajeno **sin clave y sin asignación** | 403 en las ocho | 🔴 B |
| `AJE-2f` | ajeno **asignado al folio** aunque su puesto no cuente inventarios | **Pasa** — es el diseño: el equipo se arma con promotoras y gente de oficina | 🔴 B |
| `AJE-2g` | el mismo, **después de que el folio cerró** | Vuelve a 403: el permiso se apaga solo, no quedan residuos | 🔴 B |

---

## `AJE-3` · Lo que no debe filtrarse por el borde

| ID | Qué se mira | Tiene que pasar | Sev | Niv |
|---|---|---|---|---|
| `AJE-3a` | El mensaje de un 403 | No nombra folios, almacenes ni personas que el ajeno no debería conocer | 🟠 | B |
| `AJE-3b` | Un folio **de otro tenant** | **404, no 403**: un 403 confirma que existe | 🔴 | B |
| `AJE-3c` | El bundle del front | Anotar si el código de las pantallas de inventario se descarga para quien no tiene acceso *(es carga diferida por ruta: debería no bajar)* | 🟡 | C |

---

## Cómo se arma este bloque

1. Crear **un usuario efímero** con un rol que tenga `false` en los seis permisos (por ejemplo
   `vendedor_ruta` o `telemarketing`), y **verificar primero** que de verdad no los tiene —
   consultando `identity.role_permissions`, no suponiéndolo.
2. ⭐ **Romper la prueba a propósito una vez**: darle `COMMERCIAL_INVENTORY_VER` y comprobar que
   `AJE-1a` **se pone verde**. Si no cambia, la prueba no estaba midiendo el permiso.
3. Quitárselo y volver a correr.

> Una compuerta que nunca se vio en rojo es una intención, no una compuerta.

---

## Lo que este bloque enseña del módulo

Si `AJE-2a` encuentra **un solo endpoint sin candado**, ese hallazgo vale más que todo el resto
del plan: significa que cualquiera con una sesión válida puede leer el teórico de un inventario o
mover existencia. Es la prueba más barata de correr —son 29 llamadas— y la que más cobra si falta.
