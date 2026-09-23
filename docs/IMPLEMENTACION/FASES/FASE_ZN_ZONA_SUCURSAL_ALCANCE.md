# Fase ZN — Zona, sucursal y ruta: normalizar para que cada quien vea lo suyo

> **Estado:** 🔨 ZN.0 en código (2026-09-23) · resto planeado
> **Pedido del lead (2026-09-23):** *«hay que normalizar esto, para que se respete que el usuario
> solo vea lo de su zona o sus sucursales asignadas. Debemos eliminar todo lo que esté hardcodeado
> y separar por sucursal.»*
> **ADR:** propuesto — ver §9.

---

## 1. La tesis

**Zona, sucursal y ruta son tres niveles de un mismo árbol, y la actividad de la persona decide a
cuál se ancla.** Hoy los tres viven en la misma tabla (`trade.zones`, 9 filas) y toda persona apunta
ahí, sea de ruta, de sucursal o de oficina. De ese colapso salen el resto de los defectos: el
alcance no puede filtrar, los selectores ofrecen la red completa a todo el mundo, y el tablero de
dirección agrupa mal.

```
ZONA (3)   La Piedad · Zamora · Morelia          ← kepler_ods.kduk + warehouses.purchase_zone
  └── SUCURSAL (8 + CEDIS)  PH LPA 8ES YU │ DAMASO CAN │ MM MA
        └── RUTA (18)       21…28, 1V00x │ 501…505 │ 321, 322

PERSONA → su ACTIVIDAD (identity.departments) decide su ancla:
    tienda / cajas        → SUCURSAL      (la zona se deriva)
    ruta directa/vecinal  → RUTA          (sucursal y zona se derivan)
    oficina               → SEDE          (ninguna zona; no suma a la venta de ninguna plaza)
```

⭐ **Nada de esto se inventa.** Las 3 zonas ya están declaradas en dos fuentes vivas e
independientes, y coinciden:

| Fuente | Qué dice |
|---|---|
| `kepler_ods.kduk` (catálogo del ERP, replicado en las 9 sucursales) | `ZONA LA PIEDAD` · `ZONA MORELIA` · `ZONA ZAMORA` (dos numeraciones: `01/02/03` y `10000/20000/30000`), 13,836 clientes clasificados |
| `commercial.warehouses.purchase_zone` | La Piedad (01,02,03,04) · Zamora (05,06) · Morelia (07,08) · Corporativo (00) |

---

## 2. Lo que está roto, medido en prod (2026-09-23)

### 2.1 `trade.zones` mezcla cuatro niveles

| Nivel | Filas |
|---|---|
| zona real | `LA PIEDAD RD`, `ZAMORA` — y **falta MORELIA** |
| sucursal | `YURECUARO`, `CANINDO`, `MORELIA MADERO`, `MORELIA ABASTOS` |
| canal | `LA PIEDAD VECINAL`, `ZAMORA VECINAL` |
| actividad | `OFICINAS` |

### 2.2 La persona se ancla al catálogo equivocado

**26 personas de tres sucursales distintas comparten la misma etiqueta**, que además es la zona de
*ruta*:

| Zona declarada | Sucursal real | Personas |
|---|---|---|
| LA PIEDAD RD | 8ESQ | 10 |
| LA PIEDAD RD | Padre Hidalgo | 10 |
| LA PIEDAD RD | La Piedad Abastos | 6 |

Y el dato que **sí** le toca a cada actividad falta justo donde importa:

| Actividad | Personas | Con sucursal | Con ruta | Con zona |
|---|---|---|---|---|
| Tienda (tienda + cajas) | 42 | 38 | 1 | 41 |
| **Ruta** (RD + vecinal) | 34 | 2 | **17 (50 %)** | 34 |
| Oficina / otro | 46 | 5 | 0 | **31** ← una zona que no les aplica |

### 2.3 El tablero de dirección parte las zonas

`me-zona.ts` agrupa por `trade.zones`, así que muestra **6 agrupaciones donde el negocio tiene 3**:
Zamora partida en `ZAMORA` + `CANINDO`, Morelia en `MORELIA MADERO` + `MORELIA ABASTOS`. Venta de
ruta de 30 días, bien agrupada:

| Zona | Venta 30 d | Rutas |
|---|---|---|
| La Piedad | $4,737,256 | 21…28, 1V001-003, 1V004 |
| Zamora | $2,076,268 | 501…505 (cargan en CANINDO) |
| Morelia | $0 | 321, 322 sin venta en el período |

### 2.4 ⚠️ Corrección a un diagnóstico previo

Se reportó que las rutas `501…505` tenían «dos dueños en disputa». **No era una contradicción**: el
catálogo decía `ZAMORA` (la **zona**) y `v_route_zone` dice `CANINDO` (la **sucursal madre**), y
Canindo es sucursal *de* la zona Zamora. Las dos fuentes tenían razón; lo que no existía era el
nivel que las separa. El dinero no está mal asignado — está mal **agrupado**.

### 2.5 El hardcode que impide respetar el alcance

| Qué | Medido |
|---|---|
| Catálogo de sucursales **escrito a mano en el frontend** (`core/constants/store-branches.ts`) | importado por **14 componentes** → todos ofrecen las 9 sucursales a cualquiera |
| Patrón fail-open en el backend (`user?.warehouse_code \|\| query.warehouse_code`) | **88 ocurrencias** |
| Archivos que sí consultan `ScopeService` | **33** |
| Nombres de zona literales en código | 9 |
| Tiendas (`trade.stores`) sin zona | **717 de 1,603 (44.7 %)** |

⭐ El mecanismo de alcance **ya existe y está poblado** (`identity.role_scopes` 288 filas,
`identity.user_scopes` 46, y `GET /users/me/scope` ya devuelve las opciones que la persona puede
elegir). El problema no es que falte: es que **casi nadie lo consulta** y el catálogo que alimenta
los selectores está en el bundle del navegador.

---

## 3. ZN.0 — El cimiento declarativo ✅ en código

Aditivo, **no mueve ninguna pantalla**. Migración `20260923150000_zn0_zona_sucursal_normalizadas.js`:

- `trade.zones.kind` (`zona` | `sucursal` | `canal` | `oficina`) + `kind_motivo` — cada una de las 9
  filas queda clasificada **con su porqué escrito en la fila**.
- `trade.zones.code` — llave **estable** (`LP`/`ZAM`/`MOR`). Hoy la llave es el nombre, y el JWT
  viaja con el **nombre**: renombrar rompe (ya pasó con `rename_zone_nacional_to_oficinas`).
- Crea la zona **MORELIA**, la única de las tres que no existía.
- `analytics.v_branch_zone` — resolvedor único **sucursal → zona**, derivado de `purchase_zone`
  (vista, no tabla: regla principal del proyecto).
- **Gate**: exactamente 3 zonas por tenant, ninguna sucursal de la red sin zona, y el CEDIS
  declarado corporativo en vez de colgado de una plaza.

**No hace** (a propósito, porque mueven números en pantalla y necesitan su propio antes/después):
re-apuntar `warehouses.zone_id`, mover personas, borrar o renombrar filas.

Smoke: `database/tests/test-newdb-zn-zonas.js` — read-only (abre la sesión con
`default_transaction_read_only = on`, así que puede correr contra prod). Hoy: **4 ok / 0 fallos /
4 declarados** no medidos a la espera de la migración.

---

## 4. ZN.1 — La sucursal cuelga de su zona (mueve el tablero)

`commercial.warehouses.zone_id` hoy apunta a filas que son sucursales. Re-apuntarlo a la zona
canónica hace que el tablero de dirección pase de 6 agrupaciones a 3.

**Requisito:** medir el antes/después y avisar a Dirección. Es un cambio correcto y **visible**.
Orden obligatorio: ZN.0 aplicado → medición → ZN.1.

---

## 5. ZN.2 — El selector de sucursales sale del servidor, con el alcance aplicado

🔨 **En código (2026-09-23): el apartado Tienda.** El resto, pendiente.

### 5.1 Se midió antes de encender, y el riesgo que se temía no existe

Simulando la resolución real del alcance sobre las 122 personas activas:

| Qué vería si el selector respetara el alcance | Personas |
|---|---|
| 1 sucursal | 58 |
| 3 sucursales | 11 |
| 2 sucursales | 2 |
| Toda la red | 47 |
| **Nada** | **4** — 3 `externo` (portal B2B) + 1 `sistemas` con `none` explícito, o sea correctamente |

Ninguna persona de tienda, cajas, ruta o almacén se queda sin sucursal. **Se puede encender.**

### 5.2 ⛔ Pero apareció un dato roto que el fail-open venía tapando

`options` se intersecta con el universo vigente, y ahí saltaron **4 personas de ruta de Morelia
Madero** (`humberto_placencia`, `rdmad322`, `rvmad01`, `rvmad02`) con alcance `'32'` — la llave
**Wincaja** de Madero, que dejó de existir cuando migró su POS a Kepler como `'07'` y su almacén
`MD-32` quedó soft-deleted. Para ellas `me/scope` devuelve `options: []`.

Hoy no se nota **porque el front ignora el alcance**. El día que obedezca, se quedan sin su
sucursal. `store-branches.ts` ya había declarado el caso y lo dejó pendiente; la migración
`20260923160000` lo cierra por el lado del dato: **agrega `'07'` sin quitar `'32'`** (las dos llaves
son la misma sucursal en dos eras, y los feeds viejos siguen emitiendo la vieja), derivando la
reparación de las equivalencias de cutover en vez de una lista de nombres.

### 5.3 Lo hecho

- `tienda-state.service.ts`: `branchList` deja de ser el array del bundle y pasa a ser
  **alcance ∩ monitor** — el alcance dice *qué le toca*, `LIVE_MONITOR_BRANCHES` dice *qué puede
  mostrar esta pantalla* (el CEDIS no vende al público). Mientras `me/scope` no contesta la lista va
  **vacía**, no completa: rellenar «por las dudas» es el fail-open que esto cierra.
- Los 3 selectores del apartado (`live`, `branches`, `pace`) pasan a `computed`.
- Candado en el smoke: **ninguna persona activa con alcance que no resuelva**.

⚠️ **Orden de despliegue: la migración `20260923160000` va ANTES que este front.** Al revés, esas 4
personas ven el selector vacío.

### 5.4 Los 4 que faltaban ✅ (2026-09-23)

`NETWORK_BRANCHES` ya no alimenta ningún selector. De paso salió el primitivo que faltaba:

**`DataScopeService.misSucursales()`** — las sucursales del alcance como **signal**, con el tercer
estado. Existe porque cada pantalla se estaba escribiendo su propio `subscribe` + `signal` (el
apartado Tienda tenía el suyo, compras rellenaba con el bundle), y un primitivo copiado a mano en
cuatro lugares se desincroniza (ADR-056). `null` = todavía no contestó · `[]` = no te toca ninguna.

| Archivo | Qué cambió |
|---|---|
| `compras-entradas` · `-pendientes` · `-revision` | con alcance acotado manda el reporte; con `all` —o mientras carga— sale de `me/scope`, no del bundle. Antes `null` significaba **dos cosas** («ves todo» y «no cargó») con el mismo resultado en pantalla |
| `admin-users.component.ts` | **se retira el fallback**: en un ALTA no se filtra lo que uno ve, se decide dónde queda asignada otra persona, y una lista vieja no deja el diálogo «usable» — deja asignar una sucursal equivocada. Vacío es la respuesta honesta |
| `tienda-state.service.ts` | pasa a usar el primitivo compartido en vez de su `subscribe` propio |

`nx build view` OK (1.28 MB) · `vitest` de view **756 pasan**.

### 5.5 Deuda declarada: `branchName`

Los **13 archivos restantes** que importan `store-branches` usan sólo `branchName` (código →
nombre). No es un agujero de alcance —una etiqueta equivocada es cosmética— pero **ese mapa también
se desincroniza**: ya pasó con los cutovers de POS y con la forma de escribir «8 Esquinas» / `8ESQ`.
Queda con nombre: **ZN.2.5**, servir la etiqueta desde el mismo `me/scope` que ya trae `label`.

---

## 6. ZN.3 — Los 88 fail-open pasan por `ScopeService`

`const effective = user?.warehouse_code || query.warehouse_code` significa **quien no tiene
sucursal asignada ve la red completa**. Se migran por módulo, empezando por venta y compras, con un
smoke por módulo que ejerza el caso negativo (una persona con alcance acotado **no** ve lo ajeno).

⛔ Sin ZN.2 esto es invisible para el usuario; sin ZN.3, ZN.2 es cosmético. Van juntos, módulo por
módulo.

---

## 7. ZN.4 — El alta se adapta a la actividad

Hoy el formulario pide **Sucursal, Ruta y Zona a todo el mundo**
(`persona-detalle.component.ts`). Pasa a pedir lo que corresponde:

| Actividad | Pide | Deriva |
|---|---|---|
| tienda / cajas | sucursal | zona |
| ruta | ruta | sucursal y zona |
| oficina | sede | — |

Y la zona **deja de capturarse**: se deriva. Es lo que impide que vuelvan a aparecer 26 personas de
tres sucursales con la misma etiqueta.

---

## 8. ZN.5 — Cobertura

- Las **717 tiendas sin zona** se derivan de su ruta (resoluble una vez que existe ZN.0/ZN.1).
- Crosswalk cliente → zona para los dos catálogos del ERP (`01/02/03` y `10000/20000/30000`), con
  los **1,098 clientes sin zona** y las 13,197 filas de cartera en NULL **declarados**, no
  inventados.

---

## 9. Decisiones abiertas (bloquean ZN.4, no ZN.0–ZN.3)

1. **Las vecinales** — `LA PIEDAD VECINAL` / `ZAMORA VECINAL`: ¿son **canal** dentro de la zona (la
   vecinal de La Piedad es zona La Piedad, canal vecinal) o una unidad aparte con jefe y números
   propios? `[JZ.6]` ya observó que **no tienen ni un almacén** y que las rutas vecinales cuelgan
   de la sucursal madre, lo que apunta a *canal*. Falta confirmarlo con el negocio.
2. **Las sedes de oficina** — decidido que la gente de oficina registra **la sede donde se sienta**
   (lead, 2026-09-23), y que **no suma a la venta de ninguna zona**. Falta el catálogo: ¿cuántas
   sedes hay y cómo se llaman? Hoy 19 personas están en `OFICINAS` y 27 más repartidas.

---

## 10. Riesgos y orden

| Riesgo | Mitigación |
|---|---|
| ZN.1 cambia lo que ve Dirección (6 → 3 agrupaciones) | medir antes/después y avisar; es el objetivo, no un efecto colateral |
| ZN.3 puede **quitarle** datos a alguien que hoy ve de más | migrar por módulo, con prueba negativa y control positivo; el fail-open actual es el defecto, pero apagarlo de golpe en 88 lugares es un apagón |
| El JWT viaja con el **nombre** de la zona | `code` (ZN.0) es la condición para dejar de depender del nombre |
| `trade.zones` tiene filas que dejan de usarse | **no se borran**: se marcan con `kind` y se retiran de los selectores. Borrar exige autorización explícita |

**Orden:** ZN.0 → (medición) → ZN.1 → ZN.2 + ZN.3 por módulo → ZN.4 → ZN.5.
