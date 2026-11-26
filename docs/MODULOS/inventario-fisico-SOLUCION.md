# Inventario físico — plan de solución

> **Para quien lo va a arreglar.** Los hallazgos están en
> [`inventario-fisico.md` §9d](inventario-fisico.md) con su evidencia y cómo se midió cada uno.
> **Acá no se repiten: se agrupan por ARREGLO**, porque veintidós defectos son en realidad
> **siete frentes**, y dos de ellos explican todo lo demás.
>
> Todo se midió **ejerciendo el módulo en producción** los días 2026-11-25 y 26, con el folio
> `INV-2026-00010` (Padre Hidalgo, 3,363 artículos, **sin congelar**), entrando con cuentas reales
> de `almacenista`, `encargado_tienda`, `prevencion_auxiliar` y `superadmin`. El folio quedó
> **cancelado** y no hay folios vivos en prod.

---

## 0. La foto, en tres frases

1. **El módulo nunca cerró un folio.** Seis en toda la historia, los seis cancelados, cero
   reconciliados, cero exportaciones a Kepler.
2. **No es que no se use: es que no se puede terminar.** Un escaneo creaba un renglón nuevo en vez
   de llenar el que existía, así que el folio **nunca llegaba al 100 %**.
3. **El servidor protege bien y la pantalla miente.** Los 403 son correctos en los tres perfiles
   medidos; lo que falla es que la interfaz los pinta como **ceros y listas vacías**.

⛔ **El tablero dice que IC está 🚀 en prod.** No lo está: en nueve meses no produjo un inventario.
Eso es una decisión de PM, no técnica.

---

## 1. Los siete frentes, por orden de lo que destraba

| # | Frente | Qué arregla | Estado |
|---|---|---|---|
| **A** | **Identidad del producto al escanear** | **F1, F2** — los dos rojos de la causa raíz | ✅ **Arreglado 2026-11-26**, sin desplegar |
| **B** | **Catálogo duplicado** | la causa de fondo de A | 🔴 otro dueño (Catálogo) |
| **C** | **La pantalla ante un 403** | F11, F17, F18, F19 | 🔴 un solo arreglo, cuatro defectos |
| **D** | **El tope de la lista del supervisor** | F5, F6 | 🔴 |
| **E** | **Captura del contador** | F7, F8, F9, F10, F14 | 🔴 |
| **F** | **Rótulos y estados que no dicen la verdad** | F3, F12, F13, F16, F22 | 🟠 |
| **G** | **`reconcile` con defensa de capa única** | F20 | 🟠 una línea |

---

## A · Identidad del producto al escanear — ✅ ARREGLADO

**El defecto.** `registerCount` resolvía el código **directo en `public.products`**, se quedaba con
una fila duplicada del mismo producto (la que no tiene SKU), su `product_id` no coincidía con el que
el folio sembró, y daba de alta **un renglón nuevo con `expected_qty: 0`**.

En cadena: el artículo original quedaba `pending` para siempre → **el folio no podía cerrarse
jamás**; el total crecía con cada escaneo → **el 100 % se alejaba**; y lo contado entraba como
**sobrante puro** contra un teórico cero.

**El arreglo.** Buscar **primero en los artículos del folio** (por `barcode` o `sku`), y sólo caer al
catálogo global si de verdad no está — que es el caso legítimo del sobrante.

⭐ **El testigo ya existía**: el camino **sin conexión** nunca tuvo el defecto, porque resuelve
contra la caché de `/counts/:id/catalog`, que son los productos **del folio**. El arreglo hace lo
mismo del lado del servidor.

| | online (antes) | sin conexión (siempre bien) |
|---|---|---|
| SKU resuelto | *(vacío)* | `00182` |
| teórico | **0** | **19** |
| efecto | **renglón nuevo** | llena el correcto |

- **Código:** `libs/commercial/src/lib/commercial-inventory/inventory-count.service.ts`,
  rama `if (!productId && dto.barcode)` de `registerCount`.
- **Candado:** `inventory-count.resolver-folio.spec.ts` — **6 pruebas**, con control de que el
  bloque no esté vacío y **prueba negativa ejercida**: al reintroducir el defecto en el archivo real
  quedan **3 en rojo** (archivo restaurado y verificado por hash).
- **Typecheck:** `libs/commercial` tiene 102 errores `TS1272` **preexistentes y ajenos**; **cero**
  en los archivos tocados.

### ⚠️ Cómo verificarlo cuando se despliegue (10 minutos)

No se da por bueno hasta ejercerlo. El guion está probado:

1. Abrir un folio en Padre Hidalgo **con «Congelar movimientos» APAGADO** (si es horario hábil).
2. Anotar `items_total`.
3. Entrar a `/almacen/inventory/count`, escanear **un SKU que esté en el folio** y registrar.
4. **Lo que tiene que pasar:** `items_total` **NO cambia**, el artículo del folio queda con
   `count_1` lleno y su `expected_qty` es el real (no 0).
5. Cancelar el folio.

```sql
-- El testigo correcto: el TOTAL antes y después del escaneo, y el artículo tocado.
SELECT count(*) AS total,
       count(*) FILTER (WHERE count_1 IS NOT NULL) AS contados
FROM commercial.inventory_count_items WHERE count_id = '<folio>';

-- Y el artículo que se escaneó: su teórico tiene que ser el REAL, no 0.
SELECT i.expected_qty, i.count_1, i.status, p.sku
FROM commercial.inventory_count_items i JOIN public.products p ON p.id = i.product_id
WHERE i.count_id = '<folio>' AND i.count_1 IS NOT NULL;
```

⛔ **El defecto volvió si `total` CRECIÓ** tras escanear, o si el artículo escaneado quedó con
`expected_qty = 0` y `sku` vacío.

> ⚠️ **NO sirve como testigo «cuántos artículos tienen `expected_qty = 0`» a secas** —era el
> criterio de la primera versión de este documento y **da falso positivo**—. Medido el 2026-11-26:
> los folios de La Piedad tienen **233 artículos con teórico cero y sólo 0 o 1 conteos**, así que
> no pueden venir de un escaneo: son **productos sembrados en la apertura con existencia 0**, que
> son legítimos. Lo que delata al defecto es que el **total crezca**, no que haya ceros.

---

## B · Catálogo duplicado — la causa de fondo

**Medido en prod el 2026-11-26** sobre `public.products` (14,986 filas):

| | |
|---|---:|
| Filas **sin SKU** | **1,162** |
| **SKUs que aparecen en más de una fila** | **887** |
| Nombres con más de un `product_id` | 1,017 |

El frente **A** hace que el conteo deje de romperse por esto, **pero no lo resuelve**: mientras un
producto tenga dos identidades, cualquier cruce por producto sigue expuesto. **Es de Catálogo, no de
Almacén**, y conviene medir a quién más le pega antes de abrirlo (ventas por producto, costeo,
reabasto).

---

## C · La pantalla ante un 403 — un arreglo, cuatro defectos

**El servidor acierta; la interfaz no sabe qué hacer con el «no».** Los cuatro salen de lo mismo:

- **F18** 🔴🔴 — el 403 se pinta como **ceros**: «COBERTURA 0.0 % · CONTADOS 0/0 · SIN CONTAR 0 ·
  DISCREPANCIAS 0 · VALOR EN RIESGO $0» sobre un folio con 3,363 sin contar. Se lee como
  *inventario cuadrado*. Le toca a **prevención**, cuyo oficio ES el descuadre.
- **F17** 🔴 — la tabla pinta «Sin items para este filtro» cuando la causa es el 403, mientras el
  encabezado dice «SIN CONTAR 3,363». Dos afirmaciones contradictorias a la vez.
- **F11** 🔴 — **cuanto menos permiso, más habilitado se ve el botón**: «Reconciliar» se deshabilita
  por los **bloqueos del folio**, y quien no tiene permiso no recibe los datos para calcularlos, así
  que se le habilita. Una cuenta con sólo `VER` lo apretó y mandó el `POST`.
- **F19** 🔴🔴 — **las tres acciones rechazadas fallan en silencio** (reconciliar, cancelar,
  calcular discrepancias): ni error, ni aviso. Encadenado con F18, la persona **puede creer que
  reconcilió bien**.

**El arreglo es uno solo:** que un 403 **se declare** —`status: 'sin_permiso'`, no `0`— y que la
interfaz distinga **tres estados** que hoy confunde: *sin datos*, *sin permiso* y *error*. Es la
**regla 11 del proyecto** (ADR-056), incumplida de frente.

⛔ **Prueba negativa obligatoria:** entrar con una cuenta de sólo `VER` y verificar que **ningún**
indicador muestre un número, que la tabla diga por qué está vacía, y que los botones que el servidor
va a rechazar **no se ofrezcan**.

---

## D · El tope de la lista del supervisor

- **F5** 🟠 — `GET /counts/:id/items` devuelve **2,000 exactos** en un **array pelado**, sin `total`
  ni `has_more`: el front no podría avisar del tope ni queriendo. Con 3,363 artículos, **el
  supervisor no ve 1,363**. Como la lista va ordenada por nombre, el corte cae en la letra **O**.
- **F6** 🟠 — el artículo **resuelto desaparece** de la lista (trae los 2,000 *pendientes*), así que
  **no hay forma de revisar ni corregir lo ya resuelto**.

**Arreglo:** declarar el tope en el contrato (`total` + `has_more`) y paginar o filtrar; y permitir
ver los resueltos. ⚠️ Es el **Cruce 1** del protocolo de auditoría: *si el encabezado dice N, la
lista tiene que poder llegar a N*.

---

## E · Captura del contador

Los cinco son de la misma pantalla y se arreglan juntos:

| | Qué pasa | Arreglo |
|---|---|---|
| **F8** 🟠 | Enfocar la cantidad **no selecciona**: corregir **concatena** (3 sobre 75 → **753**) | seleccionar todo al enfocar |
| **F9** 🟠 | Las **flechas** cambian la cantidad (5 → ArrowDown → 4) | `preventDefault` |
| **F7** 🟠 | Tras un código no reconocido el **foco salta a Cantidad**: con pistola, el siguiente disparo entra como cantidad (`00203` → **203**) | devolver el foco al código |
| **F10** 🟡 | Tope **mudo** de 6 dígitos | declararlo |
| **F14** 🟡 | El teórico se lee `5.000` (punto) y la captura escribe `999,999` (coma) | un solo formato |

⭐ **Hay que probarlo con navegador real, no jsdom**: `ArrowDown` sobre un `input` con 34 da **34 en
jsdom** y **33 en Chrome**; una prueba en jsdom pasa exista o no el `preventDefault`.

---

## F · Rótulos y estados que no dicen la verdad

- **F3** 🔴 — **«Resolver item» fija el `final_qty` pero no cuenta como conteo**: la cobertura siguió
  en 0 %. Cerrar exige las dos cosas. Además **está disponible desde el minuto cero y muestra el
  teórico** en un folio con doble conteo ciego — **21 personas** pueden hacerlo y sólo **17** pueden
  reconciliar: *hay más gente capaz de anular el control que de cerrar el inventario*.
- **F22** 🟡 — el contador sin asignación recibe «**Pedile a tu supervisor que abra uno**» cuando el
  folio ya existe. ⭐ El mensaje correcto **ya está escrito** en `ContarOAsignadoGuard`; la pantalla
  no lo usa.
- **F16** 🟡 — asignar **restringe lo que se VE, no lo que se PUEDE**: el guard deja pasar a
  cualquiera con `CONTAR` aunque no esté asignado. Con doble conteo ciego, **quién hizo C1 y quién
  C2 no está garantizado por el candado**, sólo por la navegación.
- **F13** 🟡 — `GET /counts/resolve` devuelve `product_id: null` **a propósito** (*«el conteo por sku
  es parte del rework pendiente»*) y manda `categoria` en el campo `brand_name`; la pantalla pinta
  ese valor —un «341»— junto al SKU como si fuera un dato del producto.
- **F12** 🟡 — el teórico del mismo almacén pasó de **2,094 (junio) a 3,363 (hoy)**, +61 %. Puede ser
  crecimiento real o cambio de fuente: **no está medido**. Toca **D-EX8**.

---

## G · `reconcile` — defensa de capa única

**F20** 🟠. En el bucle que aplica los ajustes: `const finalQty = Number(it.final_qty)`, y
`Number(null)` es **0** → un artículo sin contar daría `delta = −expected` y **dejaría la existencia
en cero**. Hoy no ocurre porque `bloqueosParaReconciliar` frena antes (bien hecho), **pero es una
sola capa**.

**Arreglo: una línea** dentro del bucle.

```js
if (it.final_qty == null) continue;   // defensa en profundidad: el no-contado NUNCA es cero
```

---

## 2. Lo que SÍ funciona, y no hay que tocar

Vale escribirlo para que nadie lo «arregle»:

- ⭐⭐ **El conteo ciego es real, y se sostiene en el SERVIDOR.** Ni `/counts/resolve` ni
  `/counts/:id/catalog` devuelven el teórico, y `GET :id/items` da **403** a almacenista, encargado
  y prevención. No hay camino desde esas cuentas hasta el teórico.
- ⭐⭐ **El camino sin conexión funciona mejor que el normal.** Banner claro, reconoce el producto
  sin red por la precarga del catálogo, encola, **sube solo al reconectar** y aplica al artículo
  correcto. El backend deduplica por `scan_uuid` con `onConflict` sobre
  `commercial.inventory_count_scan_log`.
- **La capa de permisos del servidor acierta en los tres perfiles medidos.**
- **Asignar contadores funciona** y la lista del contador acota bien a los asignados.
- **Reconciliar pide confirmación** y advierte «No se puede deshacer»; con permiso el botón se
  **deshabilita** correctamente cuando faltan conteos.
- **Un código inexistente se rechaza** con mensaje claro, y tras registrar se limpian los campos y
  vuelve el foco al escáner.
- ⭐ **El aviso de cierre dice la regla de la casa**: «un no-contado **NO** se trata como cero».

---

## 3. Lo que quedó SIN MEDIR

⛔ No se declara como funcionando:

- El **409 real** de `reconcile` (la interfaz lo previene bien: el botón sale deshabilitado) y el
  **camino feliz** completo, que exige un folio contado al 100 % — imposible hasta desplegar **A**.
- Los perfiles **`supervisor`** y **`marketing`** en vivo.
- **Doble envío** (doble clic en los botones que escriben) y **equipos por pasillo**.
- Si **F3** (que «Resolver item» aparezca) depende de `SUPERVISAR`: no se pudo ver con encargado ni
  con prevención porque a los dos la tabla les llega vacía por el 403.

---

## 4. Fuera de este módulo, y más urgente que todo esto

- ⛔⛔ **Seguridad de plataforma:** al probar permisos se confirmó que al menos una cuenta sin
  estrenar entra con una contraseña por defecto trivial, sobre un dominio público. **Mientras eso
  exista, arreglar los permisos del conteo no protege nada.** El detalle no se escribe acá —el repo
  es público—; se trató verbalmente con Edgar el 2026-11-25.
- ⚠️ **`customer_b2b` tiene `COMMERCIAL_INVENTORY_VER`** y lista por API todos los folios de la
  empresa. **No es nuevo**: el roadmap de IC lo marca «medido y NO arreglado» desde el
  **2026-10-06**. Siete semanas.
- ⚠️ Una cuenta de `identity` acumula **35 roles** a la vez y figura como almacenista, encargado,
  prevención y supervisor. Para esa cuenta cualquier matriz de permisos es decorativa.
