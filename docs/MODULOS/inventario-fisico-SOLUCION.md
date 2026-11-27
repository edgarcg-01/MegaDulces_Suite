# Inventario físico — plan de solución

> **Para quien lo va a arreglar.** Los hallazgos están en
> [`inventario-fisico.md` §9d](inventario-fisico.md) con su evidencia y cómo se midió cada uno.
> **Acá no se repiten: se agrupan por ARREGLO**, porque los defectos son en realidad
> **ocho frentes**, y dos de ellos explican todo lo demás.
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

⭐ **Dónde está esto hoy (2026-11-27).** De los **22** hallazgos, **18 están arreglados** y
commiteados; quedan F10 sin mecanismo, F19 sin confirmar, F15 en manos de otra sesión y F16
retirado por estar mal. **§1b los recorre uno por uno.**

⭐⭐ **F23, el que apareció al enganchar con `/almacen/ubicaciones`** (2026-11-27, pedido de
Edgar): la columna «Ubic.» mostraba `Z000` en **3,005 de 3,364** artículos porque
`public.products.location` **tiene un solo valor distinto en los 11,816 productos que la**
**traen**. Con el catálogo real de la fase UB son **39**. Una columna llena no se audita como
se audita una vacía: por eso sobrevivió a toda la auditoría de noviembre.

⛔⛔ **Nada de eso se desplegó ni se vio en pantalla viva**, y **la causa de fondo —el catálogo
duplicado, frente B— no se tocó**: mientras siga, el arreglo de A la esquiva pero no la quita.
Lo que falta está en §3.

---

## 0b. Por capas: ninguna está completa (2026-11-27)

> ⭐ Pedido de Edgar al preparar las pruebas del 28-nov. El método (`METODO_DE_TRABAJO.md`) dice
> que **una fase no sube de capa hasta que la de abajo está verificada**. Acá está cada una.

| Capa | Estado | Qué falta para cerrarla |
|---|---|---|
| **C0 · dato** | 🟡 **F24 cerrado el 27**; falta el catálogo duplicado | la unidad ya se nombra y se elige (código `is_primary` del SKU) · el catálogo duplicado (frente B) sigue intacto, y es de otra área |
| **C1 · dominio** | 🟡 revisada LEYENDO | ninguna escritura se ejerció contra base real con el payload de la pantalla (regla 13) |
| **C2 · API** | 🟡 permisos sí | `reconcile` y `kepler-export` **nunca corrieron**: 0 folios cerrados y 0 exportaciones en 9 meses |
| **C3 · interfaz** | ⛔ **no vista** | ninguna pantalla se abrió viva; las compuertas verifican PRESENCIA, no verdad |

⭐ **Lo que sí quedó verificado en C0:** el origen del teórico (F12, tres cruces), el costo con
que se valora la varianza (**99.9 %** de cobertura en `INV-2026-00010` contra
`v_erp_unit_cost`; 70.3 % en el folio viejo) y la ubicación, que desde F23 sale del catálogo real.

⭐ **F24 se cerró el 2026-11-27** con la vía que indicó Edgar: la unidad por defecto es la del
código que viene con el SKU y el contador puede cambiarla. Lo que destrabó el diseño fue medir
que los **7,109** códigos `is_primary` son todos `kepler_base` con factor 1 — o sea que ese
código **nombra la unidad nativa**. Dos intentos anteriores míos quedaron refutados y están
escritos como tales en `inventario-fisico.md`.

⛔ **El orden importa y lo dice el método:** lo verde de C1, C2 y C3 no significa que el módulo
esté bien si C0 no lo está. Los tres defectos más graves de toda la auditoría (un 403
pintado como ceros, un rótulo que nombraba una cosa y mostraba otra, y la ubicación constante)
**pasaron todas las compuertas en verde**.

---

## 1. Los ocho frentes, por orden de lo que destraba

| # | Frente | Qué arregla | Estado |
|---|---|---|---|
| **A** | **Identidad del producto al escanear** | **F1, F2** — los dos rojos de la causa raíz | ✅ **Arreglado 2026-11-26**, sin desplegar |
| **B** | **Catálogo duplicado** | la causa de fondo de A | 🔴 otro dueño (Catálogo) |
| **C** | **La pantalla ante un 403** | F11, F17, F18 (F19 no) | ✅ **Arreglado 2026-11-26**, sin ver la pantalla |
| **D** | **El tope de la lista del supervisor** | F5 (y F6, que era el mismo) | ✅ **Cerrado 2026-11-27**: lo declara y se busca en todo el folio |
| **E** | **Captura del contador** | F7, F8, F9, F14 (F10 no) | 🟡 **Arreglado 2026-11-26**; F10 sin mecanismo |
| **F** | **Rótulos y estados que no dicen la verdad** | F3, F12, F13, F22 · F16 estaba mal | ✅ **Arreglado 2026-11-26** |
| **G** | **`reconcile` con defensa de capa única** | F20 | ✅ **Arreglado 2026-11-26** |
| **H** | **La costura con `/almacen/ubicaciones`** | F23 — la «Ubic.» era una constante | ✅ **Arreglado 2026-11-27**, sin desplegar |

---

## 1b. Los 23 hallazgos, uno por uno — ¿cuál quedó y cuál no?

> ⭐ **Esta tabla es la respuesta a «¿ya quedó completo?».** La de arriba ordena el TRABAJO por
> frentes; ésta recorre los HALLAZGOS, que es lo que se auditó. Si las dos se contradicen, gana
> ésta y se corrige la otra.
>
> ⚠️ **No hay F21.** La numeración salta del F20 al F22 — se verificó en el historial del
> repositorio: **nunca existió**, es un hueco al numerar, no un hallazgo perdido. Con **F23** y
> **F24**, agregados el 2026-11-27, son **23**.

| # | Sev. | En una línea | Estado | Dónde |
|---|:---:|---|---|---|
| **F1** | 🔴🔴 | El conteo creaba un artículo nuevo con teórico 0 en vez de llenar el que existe | ✅ arreglado | `66433ecc4` |
| **F2** | 🔴 | El total del folio crecía con cada escaneo (consecuencia de F1) | ✅ cae con F1 | `66433ecc4` |
| **F3** | 🔴 | «Resolver item» fijaba la cantidad final sin ninguna condición | ✅ acotado, 4 frenos | `9ebe6a01e` |
| **F4** | 🔴 | …y estaba disponible desde el minuto cero, mostrando el teórico | ✅ mismo arreglo | `9ebe6a01e` |
| **F5** | 🟠 | La lista del supervisor se topa en 2,000 y no lo decía | ✅ lo declara **y** se busca en todo el folio | `33e464c38` · `2c8f336e3` |
| **F6** | 🟠 | El artículo resuelto «desaparecía» de la lista | ✅ filtros «Resueltos» y «Contados» | `2c8f336e3` |
| **F7** | 🟠 | Tras un código no reconocido el foco saltaba a Cantidad | ✅ arreglado | `621b82055` |
| **F8** | 🟠 | Corregir la cantidad **concatenaba** (3 sobre 75 → 753) | ✅ arreglado | `621b82055` |
| **F9** | 🟠 | Las flechas cambiaban la cantidad contada | ✅ arreglado | `621b82055` |
| **F10** | 🟡 | Tope **mudo** de 6 dígitos | ⛔ **NO arreglado — sin mecanismo** | — |
| **F11** | 🔴 | Cuanto menos permiso, más habilitado se veía el botón de cerrar | ✅ fail-closed | `81d080e7b` |
| **F12** | 🟡 | El teórico saltó de 2,094 a 3,363 (+61 %) sin explicación | ✅ **medido** (3 cruces) | `df6eb36e8` |
| **F13** | 🟡 | Un código de categoría viajando como marca («00203 · 341») | ✅ ahora «PROMOCIONES» | `df6eb36e8` |
| **F14** | 🟡 | El mismo dato con dos formatos: `5.000` arriba y `999,999` abajo | ✅ un solo formato | `621b82055` |
| **F15** | 🟠 | La lista de contadores asignables no decía sucursal ni rol | 🟡 **otro dueño** — ver abajo | `[IC.27]` |
| **F16** | 🟡 | «El candado deja contar a cualquiera con la clave» | ⛔ **RETIRADO: el hallazgo estaba mal** | `9ebe6a01e` |
| **F17** | 🔴 | Un 403 se pintaba como «Sin items para este filtro» | ✅ tres mensajes distintos | `81d080e7b` |
| **F18** | 🔴🔴 | Un 403 se pintaba como **ceros**: un inventario impecable | ✅ `—` + no medido | `81d080e7b` |
| **F19** | ⚠️ | «Las acciones rechazadas fallan en silencio» | ⚠️ **NO CONFIRMADO** (degradado) | — |
| **F20** | 🟠 | `reconcile` trataba el no-contado como cero donde escribe | ✅ defensa en profundidad | `3e6320733` |
| **F22** | 🟡 | Al contador sin asignar: «pedile a tu supervisor que abra uno» | ✅ el texto ya no miente | `df6eb36e8` |
| **F23** | 🔴 | La columna «Ubic.» mostraba la constante `Z000`, no una ubicación | ✅ sale del catálogo de UB | `2c8f336e3` |
| **F24** | 🔴🔴 | El teórico está en PAQUETES y ninguna pantalla se lo dice a quien cuenta | ✅ la unidad sale del código del SKU, con selector | `20261127102512` |

**Cuentas:** **20 arreglados** · **1 de otro dueño** (F15) · **1 sin arreglar** (F10) ·
**1 sin confirmar** (F19) · **1 retirado por estar mal** (F16).

⛔⛔ **F24 no es uno más de la lista: es el único que puede escribir un ajuste de inventario**
**equivocado por un factor de hasta 1,000.** Y no lo cazó ninguna compuerta porque no hay nada
roto que mirar — el dato está bien estampado, simplemente nadie lo muestra. Ver §C0 abajo.

### F15 no estaba en ningún frente de este plan — y hay que decirlo

⛔ **Hueco de esta documentación, encontrado el 2026-11-26 al revisar si estaba completa.** Los
siete frentes de entonces cubrían 20 de los 21 hallazgos; **F15 no figuraba en ninguno**. No fue
se cayó al armar el plan.

Lo está arreglando **otra sesión**, fuera de esta auditoría, bajo `[IC.27]`: `assignableUsers`
**ya está commiteado** devolviendo `warehouse_code`, `puede_contar` y `folio_vivo` —y de paso
corrigió algo más grande, que el filtro miraba sólo `u.role_name` y **dejaba fuera a 7 de 31**
personas que sí pueden contar—. La parte de pantalla estaba **sin commitear** al cerrar esto.

⚠️ Por eso `comercial.service.ts` no se tocó en los commits de arriba **hasta el 2026-11-27**:
tenía ese trabajo vivo encima, y commitearlo entero se lo habría llevado puesto. Ese día sí hubo
que tocarlo (el parámetro `search` de F5 y el campo `located` de F23), y el commit `2c8f336e3`
se armó **fuera del árbol** —`git show HEAD:<ruta>` + sólo mi cambio + `commit-tree`— para que
lleve lo mío y nada de lo ajeno. Se verificó línea por línea: **ninguna línea borrada del lote**
**es de otra sesión**.

⛔ **Y ese trabajo no tiene dueño identificado** (2026-11-27): `trade-marketing-70` confirmó que
no es suyo. Mientras no aparezca quién lo escribe, **cualquiera puede arrastrarlo en un pathspec**
**sin el título que lo explica**.

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
- **F19** ⚠️ **NO CONFIRMADO, degradado el 2026-11-26** — se publicó como 🔴🔴 («las tres acciones
  rechazadas fallan en silencio») sobre **no haber visto un mensaje en una captura**. Al ir a
  arreglarlo se midió el código: los tres caminos **sí llaman al toast**, el componente provee
  `MessageService` y el `<p-toast>` está **al inicio del template, sin condición**. Lo más probable
  es que la captura cayera fuera de los segundos que dura el aviso. **No se arregla a ciegas**:
  hace falta reproducirlo mirando la pantalla en el momento del clic.

### ✅ Estado: F18, F17 y F11 arreglados el 2026-11-26

**No se inventó ninguna pieza.** `MetricStripItem` ya tenía `state: 'no_medido'` (del ADR-056) y
esta pantalla no lo usaba.

| | Antes | Ahora |
|---|---|---|
| **F18** | `?? 0` → cinco ceros ante un 403 | `—` con estado **no medido** y el motivo **visible** |
| **F17** | «Sin items para este filtro» para los tres casos | tres mensajes: vacío · sin permiso · error |
| **F11** | `progress` nulo → `undefined` → botón **habilitado** | **fail-closed**: sin avance legible no se cierra |

⭐ En **F11** se respetó la decisión de `[CNT.1]` —un deploy viejo que no manda `bloqueos` sigue sin
bloquear— y se cerró sólo el caso que no se distinguía: **no haber podido leer el avance no es «no
hay bloqueos», es «no sé nada»**.

⚠️ **El motivo va visible, no en un tooltip**: sin mouse un `title` no existe, y es justo el dato
que distingue «el folio está vacío» de «no tienes permiso».

⛔ **Falta la prueba en pantalla viva**, y hasta que alguien la haga esto es NO MEDIDO: entrar con
una cuenta de sólo `VER` y verificar que **ningún indicador muestre un número**, que la tabla diga
**por qué** está vacía, y que «Reconciliar» salga **deshabilitado**.

Compuertas al cerrar: `check:templates` ✅ 599 componentes · `check:pantalla -- comercial` ✅
**0 fallas NUEVAS**, y el componente **tipa con 0 errores semánticos**.

---

## D · El tope de la lista del supervisor

- **F5** 🟠 — `GET /counts/:id/items` devuelve **2,000 exactos** en un **array pelado**, sin `total`
  ni `has_more`: el front no podría avisar del tope ni queriendo. Con 3,363 artículos, **el
  supervisor no ve 1,363**. Como la lista va ordenada por nombre, el corte cae en la letra **O**.
- **F6** 🟠 — el artículo **resuelto desaparece** de la lista (trae los 2,000 *pendientes*), así que
  **no hay forma de revisar ni corregir lo ya resuelto**.

### ✅ Estado: declarado el 2026-11-26 — y **F6 no era un defecto aparte**

⚠️ **Corrección de la auditoría.** Al leer `listItems` se midió que **la consulta NO excluye los
resueltos**: ordena `discrepancy → pending → el resto` y después por nombre, así que lo resuelto se
va al final y **el tope de 2,000 lo corta**. Con menos de 2,000 artículos se vería. **F5 y F6 son el
mismo defecto.**

**Lo hecho:** la lista **declara su tope** junto al filtro, y **no hizo falta tocar el contrato** —
el total ya viene en `progress`. El aviso sale sólo cuando el recorte se puede **probar** (la lista
llegó llena al tope **y** el folio declara más); sin `progress` no se inventa nada, que es F18.

⛔ **El texto dice la verdad completa, no un consejo que no funciona.** La primera versión decía
«acota con los filtros para alcanzar el resto» y **es falso**: con 3,362 pendientes, filtrar por
Pendientes vuelve a topar en 2,000. La segunda decía «no se pueden alcanzar desde ahí», que era
cierto ese día y **dejó de serlo el 27** — ver abajo.

**Lo que deliberadamente NO se hizo, y por qué:** subir el `limit` del backend. Es un paliativo —el
almacén más grande tiene 3,666 artículos— y **no se midió el costo**: la respuesta de 2,000 ya pesa
**197 KB**.

### ✅ Cerrado el 2026-11-27 — con buscador, no con paginador

**Se eligió buscar, no paginar.** Las dos alcanzan los 1,364 que no caben; la diferencia es que
una lista de 3,364 renglones no es una cola de trabajo, es una **superficie de consulta**, y en
una superficie de consulta la pregunta real es *«¿qué pasó con el 00135?»*, no *«mostrame la
página 24 de 34»*. Paginar alcanza por fuerza bruta lo que buscar alcanza por intención, y
cuesta cuatro veces más código (tabla `lazy`, `totalRecords`, `onLazyLoad`).

La búsqueda pega contra el **servidor** y corre **antes** del corte de 2,000 — un filtro sobre
las filas ya bajadas no alcanzaría nada, y es el error que se parece a esto. Usa
`applySmartSearch` (ADR-056, fase BU: **un solo buscador para toda la suite**) en vez de un
`ILIKE` propio: multi-token en cualquier orden, sin acentos, tolerante a typos. Busca por
nombre, SKU, código de barras y ubicación.

⛔ **Y el aviso de tope dejó de mentir.** Decía «no se pueden alcanzar desde aquí», que con el
buscador ya es falso. Ahora dice cuántos no caben y que se llega a ellos buscando.

**F6 cerrado aparte, y resultó más grave de lo escrito.** Medido en prod el 2026-11-27: los
únicos estados vivos son `pending` (22,197), `counted` (9) y `resolved` (3) — **`discrepancy` es
CERO**, porque nadie llegó nunca a calcular. El filtro ofrecía «Discrepancias» y «Pendientes»:
una que no existe y la más grande, **y ninguna de las dos formas de ver trabajo YA HECHO**. Como
la consulta ordena `discrepancy → pending → el resto`, lo contado y lo resuelto caían siempre
después del corte. Con los filtros **«Resueltos»** y **«Contados»** el servidor devuelve 3 filas.

⭐ Eso es lo que vuelve alcanzable el botón **«Corregir»** de F3: resolver un artículo lo mandaba
a un lugar al que nadie podía ir.

Compuertas: `templates` · `tokens` · `estilos` ✅ · `check:pantalla -- comercial` **0 NUEVAS**,
componente con **0 errores semánticos**.

---

## E · Captura del contador — ✅ CUATRO DE CINCO, 2026-11-26

| | Qué pasaba | Estado |
|---|---|---|
| **F8** 🟠 | Enfocar la cantidad **no selecciona**: corregir **concatena** (3 sobre 75 → **753**) | ✅ |
| **F9** 🟠 | Las **flechas** cambian la cantidad (5 → ArrowDown → 4) | ✅ |
| **F7** 🟠 | Tras un código no reconocido el **foco salta a Cantidad**: con pistola, el siguiente disparo entra como cantidad (`00203` → **203**) | ✅ |
| **F14** 🟡 | El teórico se lee `5.000` (punto) y la captura escribe `999,999` (coma) | ✅ |
| **F10** 🟡 | Tope **mudo** de 6 dígitos | ⚠️ **no se arregló** — ver abajo |

### F8 y F9 — una directiva, porque el arreglo no cabía en el componente

⭐ **Las dos tienen la misma causa y ninguna se arregla desde la pantalla**, y eso sólo se vio al
leer PrimeNG 22.1.4:

- **F9** — `onInputKeyDown` manda `ArrowUp`/`ArrowDown` a `spin()` y **emite su `onKeyDown` al
  final, después**. O sea que un `preventDefault()` escrito en el componente —el arreglo que este
  mismo plan proponía— **llega tarde: el número ya cambió**. El único lugar que corre antes es la
  fase de **captura sobre un ancestro**.
- **F8** — no alcanza con seleccionar al enfocar: `onInputClick()` llama a `initCursor()`, que
  **deshace la selección en cada clic**. Hay que volver a seleccionar después de él.

⭐⭐ **Y ya estaba resuelto en otra parte de la suite.** `ConteoCajonComponent` (`[LE.6.11]`, el
conteo de efectivo) escucha en captura por exactamente este motivo, escrito ahí con estas palabras:
*«con las manos en el efectivo, una flecha que cambia el número en vez de moverse es un error que
nadie ve»*. Con las manos en la tarima es lo mismo. Siguiendo el **ADR-056** —un primitivo inventado
dos veces deja de ser de una fase— el mecanismo ahora tiene nombre y vive en
[`shared/directives/cantidad-fisica.directive.ts`](../../apps/view/src/app/shared/directives/cantidad-fisica.directive.ts),
aplicado a **los dos** campos de cantidad del módulo: el del contador y el de «Resolver item».

⚠️ **El de efectivo NO se migró y queda como deuda con nombre**: ahí la flecha **mueve entre
campos** (hay catorce denominaciones), acá no hay a dónde moverse. Son la misma captura y distinto
gesto; fundirlos es un cambio en Finanzas y no se hace de paso.

No se tocaron los botones `+` y `−`: **un toque es deliberado, una flecha al lado del Enter no**.

### F7 — el foco vuelve al código, con dos condiciones y una excepción

El gesto manda el foco a Cantidad apenas se escanea porque eso es lo que sigue casi siempre. Cuando
el código no existe **no sigue nada**, y el siguiente disparo de la pistola entra como cantidad.

Sólo se devuelve el foco si la cantidad **sigue vacía** y si **lo tiene el campo de cantidad** —no
se le arrebata a nadie—. ⛔ Y **sólo con red**: sin conexión «no reconocido» significa «todavía no
lo sé», el conteo por código de barras es válido y se identifica al subir, así que ahí el foco se
queda donde está.

### F14 — era toda la tabla, no sólo el diálogo

La causa: Postgres manda el numérico **como texto con sus tres decimales** y la pantalla lo pintaba
crudo. **`5.000` en México se lee CINCO MIL.** Y no estaba sólo en «Resolver item»: estaba en el
teórico, los tres conteos, el final, la varianza y el feed en vivo — **toda la columna de cantidades
del supervisor**. Ahora las siete pasan por el mismo formato y conservan el decimal cuando de verdad
lo hay.

### ⚠️ F10 — NO se arregló, y la razón importa

El hallazgo dice: *«a partir de `999,999` deja de aceptar teclas sin decir nada»*, medido tecleando
nueve dígitos. **Al ir a arreglarlo, el mecanismo no apareció.** En las dos pantallas el campo no
tiene `max` ni `maxlength`, y en PrimeNG 22.1.4 **todo lo que recorta depende de uno de esos dos**
(`validateValue` mira `max()`; `onInputKeyPress`, `insert`, `onPaste` y `spin` miran `maxlength()`).
Sin ellos no hay nada en la librería que corte en seis dígitos.

⛔ **Entonces la observación queda y el mecanismo no**, y no se arregla a ciegas: poner un tope de
seis dígitos «para declararlo» sería **declarar un límite que no se estableció**, que es justo el
defecto que este módulo tiene por todos lados. Es la misma corrección que ya se hizo con **F19**.

Lo que falta es una medición a mano en Chrome, **tecleando** (no pegando ni con `fill`): PrimeNG
cancela el `keypress` e inserta el carácter por su cuenta, y un instrumento que escriba el valor de
golpe recorre otro camino.

### Lo que está NO MEDIDO

⛔ **Nada de esto se vio en pantalla viva.** Su prueba
([`cantidad-fisica.directive.spec.ts`](../../apps/view/src/app/shared/directives/cantidad-fisica.directive.spec.ts))
afirma lo que jsdom puede afirmar: que la flecha **nunca llega** al escucha de PrimeNG, que el Enter
sí, y que el clic de PrimeNG no gana. **No** afirma que el número no cambie en Chrome — `ArrowDown`
sobre un `input` con 34 deja **34 en jsdom** y **33 en Chrome**—. El doble suplente imita la pieza
que importa (un `click` que deshace la selección); sin ella, F8 saldría verde sin estar arreglado.

El guion de la verificación, cuando haya navegador y un folio abierto:

1. Contar 75 en un artículo, volver al campo, teclear `3` → tiene que quedar **3**, no 753.
2. Con 5 en el campo, `ArrowDown` → tiene que seguir en **5**. El botón `−` sí lo baja a 4.
3. Escanear un código que no exista y disparar el siguiente → el segundo tiene que caer en
   **Código**, no en Cantidad.
4. Teclear nueve dígitos → anotar **dónde se detiene** (eso cierra o entierra F10).
5. Mirar la tabla del supervisor: el teórico de un artículo con 5 piezas tiene que decir **5**.

Compuertas al cerrar: `check:templates` ✅ · `check:tokens` ✅ · `check:estilos` ✅ ·
`check:templates-types` (`ngc --noEmit` con `strictTemplates`) ✅ **0 errores** en las 4 apps ·
`check:pantalla -- comercial` ✅ **0 fallas NUEVAS** · **491** pruebas de `comercial` y de la
directiva en verde, con la prueba negativa ejercida **dos veces**: mutando la directiva (captura →
burbuja, y sin el `click`) y mutando el componente (sin la llamada ni el atributo) — **5 rojos**.

---

## F · Rótulos y estados que no dicen la verdad — ✅ CERRADO, 2026-11-26

| | Qué pasaba | Estado |
|---|---|---|
| **F13** 🟡 | La pantalla del contador pinta «00203 · **341**»: un código de categoría viajando en `brand_name` | ✅ ahora dice **PROMOCIONES** |
| **F22** 🟡 | Al contador sin asignar: «no hay ningún folio abierto… pedile a tu supervisor que abra uno», con el folio vivo | ✅ el texto ya no afirma lo que no sabe |
| **F12** 🟡 | El teórico del almacén pasó de 2,094 a 3,363 (+61 %): *«puede ser crecimiento real o cambio de fuente, no está medido»* | ✅ **medido** — ver abajo |
| **F3** 🔴 | «Resolver item» anula el conteo ciego: sin ninguna condición, desde el minuto cero | ✅ acotado con 4 frenos |
| **F16** 🟡 | El candado deja contar a cualquiera con la clave, esté o no asignado | ⛔ **el hallazgo estaba MAL**: ya estaba cerrado |

### F13 — era una categoría disfrazada de marca, y el nombre existe

`resolveProduct` mandaba `brand_name: inv.categoria`. Medido en prod el 2026-11-26: de **10,266**
productos de `inventory.products`, **9,321** traen categoría y los **9,321 son numéricos** (492
códigos distintos). **Nunca fue un nombre de marca, en ninguna fila.**

⭐ Y el nombre sí existe: el **97.1 %** de esos códigos casa con `catalog.categories.code`, donde
`341` es **«PROMOCIONES»** — que es exactamente lo que era el producto del hallazgo
(`$330 NESTLE = GRATIS 1 LONCHERA`). Así que el arreglo no fue borrar el dato sino **mandar el
nombre, en un campo que dice qué trae** (`category_name`). Cuando el código no casa (2.9 %) no se
manda nada: un «341» suelto no le dice nada a quien cuenta.

⛔ **`product_id: null` sigue igual y es a propósito** (*«el conteo por sku es parte del rework
pendiente»*): eso no se tocó.

### F22 — el mensaje dice lo que la pantalla sabe, que es menos de lo que decía

La pantalla **no puede distinguir** «no hay folio abierto» de «lo hay y no te asignaron»: la lista
de folios propios vuelve vacía en los dos casos. Antes elegía la primera y mandaba a pedir algo que
ya existía — el supervisor que recibía el reclamo veía el folio vivo y no entendía nada.

Ahora: **«No tienes folios para contar · Si ya abrieron uno, pídele a quien arma el equipo que te
agregue como contador»**. Es la misma salida que ya daba `ContarOAsignadoGuard`, y no afirma una
causa que nadie midió.

🟡 **Deuda con nombre:** para decir *cuál* de las dos causas es, el servidor tendría que contar los
folios abiertos a los que esa persona **no** está asignada. Es un cambio de contrato y no se hizo de
paso.

### F12 — medido: NO es un cambio de fuente, y el folio no se está dejando nada

Tres mediciones en prod, y **la segunda refuta a la primera** — por eso van las tres:

1. **La fuente sí cambió.** Los folios de junio se sembraron de `commercial.stock` (`stock_source`
   = `commercial`, 2,093 y 2,094 artículos); el de noviembre, del ERP derivado del ODS
   (`stock_source` = `erp`, 3,364). Leído así, el caso parecía cerrado.
2. ⛔ **Pero hoy las dos fuentes coinciden**: para ese mismo almacén, `commercial.stock` da **3,376**
   SKUs con existencia y la vista del ERP **3,377**. O sea que **el cambio de fuente NO explica el
   +61 %** — la fuente vieja daría hoy el mismo número. *Quedarse en la medición 1 habría publicado
   una causa falsa.*
3. **Y el folio de noviembre no se está dejando nada.** Los dos folios comparten sólo **1,164**
   productos: **924** de junio no están hoy… y de esos 924, **sólo 11** siguen teniendo existencia.
   Los otros 912 se fueron a cero de verdad. Un folio siembra lo que tiene existencia **el día que
   se abre**, así que eso es rotación, no un hueco.

**La conclusión que queda, y lo que todavía no se puede afirmar:** el almacén pasó de ~2,094 a
~3,376 SKUs vivos en cinco meses, con rotación fuerte en los dos sentidos (2,200 productos de hoy no
estaban en junio). Que eso sea rotación normal de una distribuidora de dulces es **plausible y no
está probado**: para probarlo hace falta un testigo del movimiento, no un conteo de SKUs.

⭐ **Lo que sí queda establecido, y es lo que importaba:** **comparar el inventario de junio con el
de noviembre como si midieran lo mismo es incorrecto** — comparten **un tercio** de los artículos de
hoy. Cualquier serie de exactitud que cruce los dos folios tiene que decirlo. Toca **D-EX8**.

### F3 — acotado, por decisión de Edgar (2026-11-26)

**El defecto.** `resolveItem()` no tenía **ninguna** condición: aceptaba cualquier artículo, en
cualquier estado, en cualquier momento — incluso en un folio **ya reconciliado**, después de haber
movido la existencia. Y el diálogo que lo abre imprime el teórico justo encima del campo.

**Las cuatro condiciones, en el servicio** (que es el único camino por el que pasan todos los
clientes; esconder el botón no es un control — eso es **F11**, y ahí quedó demostrado que una
cuenta sin permiso igual mandaba el `POST`):

1. el folio **no** puede estar `reconciled` ni `cancelled`;
2. el artículo tiene que tener **C1** — *un no-contado NO se trata como cero, y tampoco se le pone
   un número a mano para esquivarlo*;
3. si el folio es de **conteo ciego**, tiene que tener **C2**;
4. tiene que estar **en discrepancia** — o ya resuelto, para poder **corregir** una resolución
   equivocada, que es algo que hoy no se podía hacer.

En la pantalla, el botón aparece ahora **donde el servidor lo va a aceptar**, y en lo ya resuelto
dice «Corregir».

#### ⛔ La otra mitad de lo aprobado NO se implementó, y hay que decir por qué

La opción decía *«y que resolver cuente para la cobertura»*. **Al leer el código, eso habría
empeorado la pantalla**, así que no se hizo:

- `coverage_pct` significa **cuánto se contó físicamente**. Si resolver lo subiera, un supervisor
  podría dejar **COBERTURA 100 %** sin que nadie hubiera contado nada. Es exactamente la enfermedad
  de **F18** —un número que se lee «todo bien» sin que nadie lo haya medido— y la contradicción
  directa de **F20**.
- El síntoma que motivaba la petición **desaparece solo con la condición 4**: ahora sólo se puede
  resolver una **discrepancia**, y resolverla **baja «DISCREPANCIAS»** en el tablero y achica la
  lista de «Falta para poder cerrar este folio». Antes se resolvía un artículo sin contar y no se
  movía nada, que era lo que se veía como «dos verdades paralelas».
- Y si algún día se quiere el número aparte, **ya viaja**: `supervisorProgress` devuelve `resolved`
  desde antes de esta auditoría. Es un renglón de pantalla, no un cambio de significado.

### ✅ F16 — ya estaba cerrado, y mi hallazgo estaba MAL

⛔ **Corrección.** El renglón decía que el candado *«deja pasar a cualquiera con la clave `CONTAR`
aunque no esté asignado»*. Lo leí en `ContarOAsignadoGuard` — y ese archivo **nunca se commiteó**:
existe suelto en el árbol compartido desde el 2026-11-24 y **no está en producción**. En el
controlador que sí está desplegado, `POST :id/count` sólo lleva `@RequirePermissions(CONTAR)`.

Pero el control **sí existe, y está donde tiene que estar**: en `submitCount()`, commiteado desde
antes de la auditoría —

```ts
// Opt-in (Fase I.4): si el folio tiene contadores asignados, solo ellos cuentan.
if (counters.length && !counters.some((a) => a.user_id === uid))
  throw new ForbiddenException('No estás asignado como contador de este folio.');
```

— que es **exactamente** la regla que se aprobó el 2026-11-26 («exigir asignación si el folio tiene
equipo; si no tiene, abierto»), y encima trae un nivel más: si al contador se le asignaron pasillos,
sólo cuenta los suyos.

**Entonces no se cambió nada de código.** Lo que queda es la lección: *leí un archivo del árbol y lo
di por desplegado*. Un archivo sin commitear compila en todas las sesiones y no existe en prod.

Compuertas al cerrar: `check:templates` ✅ · `check:tokens` ✅ · `check:estilos` ✅ ·
`check:pantalla -- comercial` ✅ **0 fallas NUEVAS**, los dos componentes con **0 errores
semánticos** · 494 pruebas de `comercial` en el front y **102** de `commercial-inventory` en el
back, en verde · prueba negativa del candado de F13 ejercida contra el fuente real (**2 rojos**).

⚠️ **Y una que casi se va:** el comentario de F22 nació con comillas invertidas adentro del
`template` y **partió el literal** — la trampa del §8, que ya lleva ocho. La cazó
`npm run check:templates`, no una revisión.

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

## H · La costura con `/almacen/ubicaciones` — ✅ ARREGLADO 2026-11-27

> ⭐ **Este frente no salió de la auditoría: salió de cruzar los dos módulos**, a pedido de
> Edgar («complementémoslo con `/almacen/ubicaciones`»). Y el hallazgo que apareció es más
> grande que varios de los auditados.

- **F23** 🔴 — la columna «Ubic.» del supervisor, el renglón que confirma el contador y el
  catálogo que se lleva offline mostraban `public.products.location`. **No es una ubicación:**
  **es una constante.**

### La medición (prod, 2026-11-27, sólo lectura)

| Qué | Cuánto |
|---|---:|
| Productos con `location` | **11,816** de 14,986 |
| Valores **distintos** de `location` | **1** — la cadena `Z000` |
| Artículos de `INV-2026-00010` que la traían | **3,005** de 3,364 |
| Ubicaciones reales en `commercial.warehouse_bins` | **476** (471 de Padre Hidalgo) |
| Asignaciones producto↔ubicación vivas | **51**, todas de PH |
| De ésas, cuántas coincidían con `p.location` | **0** (50 discrepaban, 1 sin valor) |
| Artículos del folio con ubicación **real** | **39** de 3,364 |

⭐⭐ **Por qué sobrevivió a toda la auditoría de noviembre: la columna se veía LLENA.** Un hueco
se cuestiona; un relleno uniforme se lee como dato y nadie lo audita. Es la misma familia que
el cero redondo, con el disfraz al revés.

### Lo hecho

Los **tres** caminos que publican ubicación la resuelven contra `bin_assignments` +
`warehouse_bins`, **por almacén** —una ubicación de Padre Hidalgo no vale para La Piedad— y
devuelven **todas** las del producto en orden de recorrido (`TA011 · TA012 · TA013`; medido: 5
productos en dos ubicaciones y 3 en tres). El folio deja de sembrar la constante al abrirse y
`GET /counts/resolve` manda vacío, porque **sin folio no hay almacén y sin almacén no hay**
**ubicación** — un relleno declarado antes que uno inventado.

⭐ **Que la cobertura BAJE de 3,005 a 39 es el resultado correcto** (regla 11). Lo que parecía
un almacén ubicado al 89 % es, medido, un almacén ubicado al **1.2 %**. La pantalla lo dice —
«39 de 3,364 artículos tienen ubicación asignada»— y liga a `/almacen/ubicaciones/asignacion`,
que es donde se arregla (Q.4: el número que denuncia, navega). El conteo va en el **servidor**
sobre el folio entero: contarlo en la pantalla daría una cobertura sobre las 2,000 filas
cargadas y la publicaría como si fuera del folio.

### ⭐ El mismo 1 %, medido por el otro lado

Lo cruzó `trade-marketing-a3` desde la fase UB y se verificó acá por separado: de las **471**
ubicaciones de Padre Hidalgo, **5 tienen producto asignado** (1.1 %), y las **51** asignaciones
vivas están **todas en el pasillo A** — diez de los once pasillos están vacíos. Dos mediciones
independientes, una por producto y otra por ubicación, dan **~1 %**.

⛔ **Y esa cifra no sube sola.** Dibujar mejor el croquis no asigna un producto: lo que mueve el
número es que **alguien capture asignaciones** en `/almacen/ubicaciones/asignacion`. Con el
croquis perfecto, la cobertura sigue en 1 %.

### Lo que este frente NO resolvió

- ⛔ **El conteo sigue sin capturar DÓNDE se contó.** El contador está físicamente en el lugar,
  con el escáner en la mano: es el mejor momento del proceso para levantar o verificar una
  ubicación, y hoy ese dato se tira. Con 3,325 artículos sin asignar, el inventario físico es el
  único evento que recorre el almacén entero. **Es una fase, no un parche** — necesita decisión
  de PM antes de abrirse.
- ⚠️ `GET /counts/resolve` no puede resolver ubicación porque no sabe de qué folio viene. Queda
  como deuda con nombre: pasarle el folio, o aceptar que ahí no hay ubicación.
- ⚠️ **NO MEDIDO:** nada de esto se vio en pantalla viva, y el `LATERAL` se ejerció contra prod
  en sólo lectura, no a través del endpoint.

Candado: `inventory-count.ubicacion-del-catalogo.spec.ts` — 7 pruebas, con **control** (el
instrumento encuentra los métodos y no se trae medio archivo) y **prueba negativa** (si alguien
reinstala `location: prod.location`, el candado se pone rojo).

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

- ⛔⛔ **NADA de los ocho frentes se vio en pantalla viva ni se desplegó.** Todo lo de arriba está
  probado por candados que leen el fuente y por pruebas de unidad; ninguno afirma «la pantalla hace
  esto». El guion de verificación de cada frente está en su sección, y el de **E** es el más largo
  porque es el único que necesita **Chrome de verdad** (`ArrowDown` sobre un `input` con 34 deja
  **34 en jsdom** y **33 en Chrome**).
- **F10** — el tope mudo de 6 dígitos: la observación está, el **mecanismo no**. Hay que re-medirlo
  **tecleando** (no pegando ni con `fill`). Ver el frente **E**.
- **F19** — el silencio de las acciones rechazadas: **NO CONFIRMADO**, hay que reproducirlo mirando
  la pantalla en el momento del clic.
- El **409 real** de `reconcile` (la interfaz lo previene bien: el botón sale deshabilitado) y el
  **camino feliz** completo, que exige un folio contado al 100 % — imposible hasta desplegar **A**.
- **Ningún endpoint que escribe se ejerció contra base real** con el payload de la pantalla: ni el
  conteo, ni `resolve` con sus cuatro frenos nuevos (**F3**), ni `reconcile`. Es la regla 13 del
  proyecto y acá está sin cumplir.
- Los perfiles **`supervisor`** y **`marketing`** en vivo.
- **Doble envío** (doble clic en los botones que escriben) y **equipos por pasillo**.
- **El costo de bajar el folio entero** (frente **D**): la respuesta de 2,000 ya pesa 197 KB y no
  se midió qué cuesta el resto. El tope sigue en pie **a propósito**; lo que se cerró el 27 es que
  ya no encierra, porque la búsqueda recorre el folio completo del lado del servidor.
- **Si alguien va a CAPTURAR las 3,325 ubicaciones que faltan** (frente **H**): el conteo físico es
  el único evento que recorre el almacén entero con un escáner en la mano, y hoy **no registra**
  **dónde se contó**. Juntar las dos cosas es una fase, no un parche, y la decide el PM.
- **Si el salto de 2,094 a 3,376 SKUs es rotación normal** (**F12**): se descartó que fuera la
  fuente y se descartó que al folio le falten artículos, pero probar la rotación pide un **testigo
  del movimiento**, no un conteo de SKUs.

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
