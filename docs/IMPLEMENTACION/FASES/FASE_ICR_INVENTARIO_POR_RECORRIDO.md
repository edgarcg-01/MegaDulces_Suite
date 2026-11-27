# Fase ICR — Inventario por recorrido

```
OBJETIVO: que el conteo físico se organice por el RECORRIDO del almacén y no por una lista de
          SKUs, para que el trabajo se pueda repartir entre personas y el folio se pueda cerrar.
MÉTRICA:  Folios cerrados — HOY: 0 de 8 en 9 meses (medido 2026-11-27) → META: 1 cerrado de
          punta a punta en Padre Hidalgo.
CAPA TOPE: C3
ÁREA:      Comercial
DUEÑO:     <por definir — Edgar>
ESTADO:    🔨 (abierta por Edgar el 2026-11-27)
```

⭐ **Abierta por Edgar el 2026-11-27** (*«abrámoslo»*). Ese día había un tope de 4 fases 🔨 y
ésta era la 12ª, así que se abrió «por encima del cupo». ⛔ **Horas después, el mismo día, Edgar
retiró el tope** (`daf868d90`): no limitaba —en 90 días entraron 12 fases y salieron cero, con el
tope saltado ocho veces—. Lo que ahora sostiene a una fase 🔨 es otra cosa, y esta fase
**todavía no la tiene**: **dueño** y **fecha de cierre comprometida**, con su tarjeta en el
tablero del PM (`node .claude/skills/pm/caducidad.js`). Sin las dos, cae a ⏸️ sola. Las dos son
de Edgar.

⭐ **D1–D4 las tomó Claude al abrir** (son de diseño y de proceso, no de negocio): se adoptan las
recomendaciones de §4 tal como estaban escritas. **D5 queda partida**: el *mecanismo* —capturar la
ubicación mientras se cuenta— lo toma Claude; **quién** la captura y **cuándo** sigue siendo de Edgar,
y no bloquea nada de C0 ni de C1.

---

## 1. Qué problema resuelve

**El modelo del inventario físico es anterior a tres módulos que hoy existen y que resuelven sus
huecos más caros.** No es una fase de mejoras: es volver a apoyarlo sobre lo que ya hay.

Lo motivó una pregunta de Edgar el 2026-11-27 —*«¿se le asigna un rack a cada persona? ¿cuánta
gente necesitamos?»*— que **hoy no se puede contestar**, y la respuesta a por qué es estructural.

### Los cuatro huecos, medidos el 2026-11-27 contra prod

| Hueco | La cifra |
|---|---|
| **El trabajo no se puede repartir** | **0 de 22,211** artículos de los 8 folios saben en qué pasillo están. Se copia de `commercial.stock.aisle_id`, que tiene **0 de 5,547** filas con pasillo en Padre Hidalgo |
| **Dos catálogos de pasillo que no se hablan** | El que usa el conteo (`commercial.warehouse_aisles`) tiene **4** — «Pasillo 1» a «Pasillo 4» — y está vacío de uso; el real (`warehouse_bins.pasillo`) tiene **11** (A–K) con **471** ubicaciones |
| **Tres fuentes del teórico, que filtran distinto** | Los 8 folios se sembraron desde `inventory` (4), `erp` (2) y `commercial` (2). `inventory.warehouse_stock` tiene **0 filas** para PH. Y hoy en PH un folio `erp` daría **3,363** artículos y uno `commercial` **5,547**, con **2,171 en existencia cero** que alguien tendría que contar igual |
| **La unidad llega al 17 %** | **3,146 de 3,364** artículos (93 %) tienen factor de caja; sólo **556** (17 %) ofrecen elegir unidad, porque las opciones salen de qué códigos de barras existen |

### Y el resultado de todo eso, que es la métrica

**Cero folios cerrados en nueve meses.** Ocho abiertos, siete cancelados, uno vivo (el de la prueba
del 2026-11-27). Cero exportaciones al ERP. El proceso **nunca llegó al final**.

### Lo que ya existe y puede sostenerlo

| Módulo | Qué tiene, medido el 2026-11-27 | Qué le da al inventario |
|---|---|---|
| **UB · Ubicaciones** | 476 ubicaciones, **472 con orden de recorrido** (`pick_sequence`), 12 piezas, 17 caras, 11 pasillos | **El recorrido**: en qué orden se camina. ⛔ **Corregido el 2026-11-27 al construir C0: las 472 son de TIENDA** (`zona='T'`), 322 de piso y 150 de cabecera. **La bodega tiene CERO.** El formato del código ya la contempla (`^([TB])...`), nadie la capturó |
| **GP · Olas de surtido** | 9 tablas (`picking_waves`, `wave_lines`, `wave_sequences`, `wave_allocations`, `supervisor_tasks`…) | **El modelo de repartir trabajo** del almacén entre personas y seguir su avance — ya construido y en uso |
| **Códigos por unidad** | **9,066** códigos con su peldaño (`kepler_base` 7,109 · `kepler_u2` 405 · `kepler_u3` 7 · `wincaja` 1,545) | **La unidad** en que cuenta cada persona |
| **El ODS** | `analytics.v_erp_stock_on_hand`, derivada del ERP | **Un solo teórico** |

⭐ **La idea en una frase:** la unidad de trabajo del conteo deja de ser *un SKU de una lista* y pasa
a ser *una ubicación en el orden en que se camina*. Eso es lo que permite decir «este tramo es tuyo»
— y es exactamente lo que ya hace el surtido de pedidos.

### ⛔ Lo que apareció al construir C0, y cambia el orden del trabajo (2026-11-27)

**El catálogo de ubicaciones que existe es el del PISO DE VENTA, no el de la bodega.** Las 472
ubicaciones con recorrido de Padre Hidalgo son `zona='T'` (tienda): 322 de piso y 150 de cabecera,
más 3 carretas y 1 legado sin recorrido. De bodega (`zona='B'`) hay **cero**, en PH y en todas. Y
las 51 asignaciones vivas son las 51 de `papel='exhibicion_tienda'`.

Eso **no tumba la fase, le pone el orden**: el teórico del ERP es por sucursal y **no separa piso
de bodega**, así que un folio de PH cubre las dos mitades y sólo una tiene recorrido. El primer
folio que se puede organizar por tramos es **de piso de venta**; la bodega entra cuando alguien
capture sus ubicaciones (D5). ⚠️ Y **no se sabe qué fracción de la existencia está en cada mitad**:
el ODS no lo dice. Se declara NO MEDIDO; no se reparte a ojo.

⭐ **Y el mecanismo de repartir por pasillo ya está construido entero, apuntando al catálogo
equivocado.** `inventory-team.service.ts` reparte un folio sobre `commercial.warehouse_aisles` y
escribe `inventory_count_assignments.aisle_id`; `submitCount` ya acota al contador a sus pasillos.
Lo que falta no es construirlo: es **apuntarlo al catálogo real** y darle tramos que existan. Eso
abarata C1 y es lo que D2 ya recomendaba por otro motivo.

---

## 2. Qué NO incluye

- **No arregla el catálogo duplicado** (887 SKUs repetidos, 1,015 nombres con más de un producto).
  Es de Catálogo y le pega a más módulos que a éste.
- **No captura las asignaciones de ubicación que faltan.** Hoy hay **5 ubicaciones con producto de
  471**; llenar las otras es trabajo de la sucursal, no de esta fase. La fase hace que el dato
  **sirva** cuando exista, y que se **vea cuánto falta**.
- **No toca el conteo ciego ni la segregación de funciones.** Esos controles están bien y se
  conservan tal cual.
- **No reemplaza las pantallas enteras.** Se reapoyan sobre el modelo nuevo; lo que hoy funciona
  —el modo conteo, el foco, el avance— se conserva.
- **No incluye contar en pieza suelta** cuando la unidad nativa es el paquete: no existe el factor
  y no se inventa (ver D4).

---

## 3. Las capas

### C0 · Dato

| # | Item | Estado | Verificado contra |
|---|---|---|---|
| ICR.0.1 | **Un solo teórico**: el folio se siembra SÓLO desde el ODS (`v_erp_stock_on_hand`), con `qty > 0`. Se retiran las ramas `commercial` e `inventory` | ⬜ | Conteo de artículos del folio contra la vista, mismo almacén y misma fecha |
| ICR.0.2 | **Cada artículo sabe dónde está**: vista `commercial.v_product_bin_location` (`derive-no-copy`), una fila por asignación viva. El primitivo de **cuál gana** se muda a `warehouse-locations/ubicacion-del-producto.ts` y lo usan surtido y conteo | 🔨 2026-11-27 | Migración `20261127150434`, que se verifica a sí misma (filas de la vista = filas de su fuente, o falla). Candado de 11 pruebas con control y negativa, **ejercida**: al romper el filtro de bajas y el orden de papeles, 4 se ponen rojas |
| ICR.0.3 | **Cada artículo sabe en qué tramo está**: `tramo` = `zona-pasillo` (`T-A`), y el renglón publica además **cuántos** ocupa | 🔨 2026-11-27 | 472 de 476 ubicaciones tienen `pick_sequence`; las 4 sin él caen en `sin-recorrido` y **se declaran**. ⚠️ Falta ejercerlo contra la API: la vista todavía no está en prod |
| ICR.0.4 | **El artículo sin ubicación tiene su propio tramo**: `SIN_UBICAR`, que es trabajo real y hoy sería invisible | 🔨 2026-11-27 | **3,322 de 3,361** con existencia en Padre Hidalgo caerían ahí (1.2 % ubicado): la cifra ya sale por `located` en el tablero del folio. Falta la pantalla (C3) |
| ICR.0.5 | **Retirar el catálogo de 4 pasillos** (`warehouse_aisles`) del conteo, o declararlo muerto | ⬜ | Que ningún camino del módulo lo lea |

⛔ Sin importer: todo deriva. Lo que no se pudo verificar **se declara**, nunca se dibuja como 0.

### C1 · Dominio

| # | Item | Estado | Prueba que lo ejerce |
|---|---|---|---|
| ICR.1.1 | **Partir un folio en tramos** y asignar cada tramo a una persona | ⬜ | |
| ICR.1.2 | **El avance se mide por tramo**, no sólo por artículo | ⬜ | |
| ICR.1.3 | **La unidad de conteo**: nombre de la nativa desde el código primario, conversión con el factor del **ERP** (no el del código: discrepa 96 %) | ⬜ | |
| ICR.1.4 | **Cuánta gente hace falta**: el folio dice cuántos tramos tiene y cuánto trabajo hay en cada uno | ⬜ | |

### C2 · API

| # | Item | Estado | ¿Escribe? | Prueba contra base real |
|---|---|---|---|---|
| ICR.2.1 | Abrir folio sembrando desde el ODS con su tramo | ⬜ | sí | ⛔ obligatoria |
| ICR.2.2 | Asignar tramos a personas | ⬜ | sí | ⛔ obligatoria |
| ICR.2.3 | Contar declarando unidad (amplía lo de `[IC.F24]` al 93 %) | ⬜ | sí | ⛔ obligatoria |
| ICR.2.4 | Avance por tramo | ⬜ | no | |

### C3 · UI

| # | Item | Estado | `check:pantalla` antes → después |
|---|---|---|---|
| ICR.3.1 | El contador ve **su tramo**, no el folio entero | ⬜ | 0 NUEVAS |
| ICR.3.2 | El selector de unidad llega al 93 % | ⬜ | 0 NUEVAS |
| ICR.3.3 | El supervisor reparte tramos y ve el avance de cada uno | ⬜ | 0 NUEVAS |
| ICR.3.4 | El marco de la pantalla del contador baja del 48 % del alto | ⬜ | 0 NUEVAS |

⛔ Cargar la skill `diseno` **antes** de tocar el primer archivo. El análisis de interfaz, con lo
medido en pantalla viva el 2026-11-27, ya está escrito: ver el documento *«Inventario físico — qué
ve cada usuario y cómo lo ve»*.

---

## 4. Decisiones (→ ADR)

| # | Decisión | Recomendación | Quién firma |
|---|---|---|---|
| **D1** | ¿La unidad de trabajo del conteo pasa a ser **la ubicación en orden de recorrido** en vez del SKU? | **Sí.** Es lo que permite repartir el trabajo y es como se cuenta en la realidad | Edgar |
| **D2** | ¿Se **reutiliza** el modelo de olas de surtido o el inventario tiene el suyo? | **Reutilizar**, aunque cueste más al principio: dos modelos de repartir trabajo en el mismo almacén se separan y uno queda viejo (ADR-056) | Edgar |
| **D3** | ¿El teórico sale **sólo del ODS** y se retiran las otras dos fuentes? | **Sí.** Es la regla principal del proyecto, y hoy una de las tres tiene cero filas | Edgar |
| **D4** | ¿Se puede contar en **pieza suelta** cuando la unidad nativa es el paquete? | **Hoy no**: no existe el factor paquete→pieza y el del código de barras discrepa 96 %. O se consigue el dato, o se declara que no se cuenta así | Edgar |
| **D5** | ¿Quién captura las **3,325 asignaciones de ubicación** que faltan, y cuándo? | El inventario es el único momento en que alguien recorre el almacén entero: **capturar la ubicación mientras se cuenta** | Edgar |
| **D6** | **El cupo**: era de 4 y había 11 🔨 | ✅ **Resuelta y luego disuelta, 2026-11-27**: Edgar abrió la fase por encima del cupo y después **retiró el tope entero**. Lo que la reemplaza: dueño + fecha de cierre comprometida, que esta fase **no tiene** | Edgar |
| **D7** | ⭐ **¿El renglón de conteo es por PRODUCTO o por (ubicación × producto)?** Apareció al construir C0: un producto puede estar en varios tramos —hoy **8 de 40** asignados están en dos o tres—, y entonces «este tramo es tuyo» no alcanza: alguien tiene que contar la otra punta | **Por (ubicación × producto)**, como un renglón hijo del artículo y no cambiando el grano del actual: el teórico del ERP es **por producto** y la diferencia se sigue calculando ahí. ⚠️ Mientras no se firme, C0 **no lo resuelve en silencio**: el renglón publica `tramos > 1` para que se vea | Edgar |

**Estado al 2026-11-27:** D1, D2, D3 y D4 **tomadas por Claude** con la recomendación de esta tabla
(decisiones de diseño y de proceso). D5 **a medias**: el mecanismo se adopta, el reparto del trabajo
de captura espera a Edgar. D6 **firmada**. Cada una que se ejerza en código deja su ADR.

---

## 5. Riesgos y bloqueos

- ⛔⛔ **Lo que sostiene a esta fase todavía no existe.** El tope de 4 que se saltó al abrirla se
  retiró el mismo día, y lo que ocupó su lugar es más exigente: **dueño con nombre y fecha de
  cierre comprometida**, o la fase cae a ⏸️ sola. Medido el 2026-11-27: **0 de 12** fases 🔨 las
  tienen, ésta incluida, y además le falta la tarjeta en el tablero del PM. El riesgo de fondo no
  cambió —*se abre más de lo que se cierra*, +12 en 90 días—, así que esta fase se trabaja **de
  abajo hacia arriba y por capas**: C0 entero antes de tocar C1, y lo que no alcance a cerrar se
  **declara con nombre**, no se deja a medias en silencio.
- ⛔ **La cobertura de ubicaciones es del 1 %, y además es de la mitad equivocada.** Con 5
  ubicaciones ocupadas de 471 el reparto por tramos arrancaría casi vacío —casi todo caería en
  «sin ubicar»—, y las 472 ubicaciones con recorrido son **del piso de venta**: de bodega hay
  cero. La fase **no falla** por eso —ese tramo es trabajo real y se ve— pero el beneficio llega
  cuando alguien capture (D5), y el primer piloto tiene que ser **de piso**, no de almacén.
- ⚠️ **Tocar el sembrado del folio cambia un número** que la gente va a comparar. Todo cambio ahí
  va con su medición antes/después (regla 15).
- ⚠️ **El catálogo duplicado sigue vivo** y es de otra área. El conteo lo esquiva; no lo quita.

---

## 6. Definición de Terminado

1. Un folio abierto en Padre Hidalgo se siembra **sólo desde el ODS**, con su ubicación y su tramo.
2. El supervisor **reparte tramos** entre personas y ve el avance de cada uno.
3. Un contador ve **sólo su tramo**, cuenta declarando unidad, y el 93 % de los artículos le deja
   elegir entre su unidad nativa y la caja.
4. Lo que no tiene ubicación **se ve** como un tramo propio, con su cifra.
5. El folio **se cierra**: diferencias calculadas, resueltas, saldo ajustado y archivo para el ERP.
6. Todo lo que escribe tiene una prueba contra base real con el payload de la pantalla.
7. Tracker y log al día; ADR por cada decisión de §4 que se firme.

---

## 7. Bitácora

| Fecha | Qué pasó |
|---|---|
| 2026-11-27 | **C0 construido** (ICR.0.2–0.4): la vista `commercial.v_product_bin_location`, el primitivo compartido con surtido, y el tramo en el renglón del folio. ⛔ Lo que apareció al medir: **el catálogo de ubicaciones es del piso de venta, no de la bodega** (0 ubicaciones `zona='B'` en toda la empresa), y **el mecanismo de repartir por pasillo ya estaba construido entero**, apuntando al catálogo muerto de 4 filas. Nace **D7**. Falta aplicar la migración en prod y ejercerlo desde la API. |
| 2026-11-27 | **Abierta por Edgar**, por encima del cupo (12 🔨 contra 4): *«abrámoslo»*. D6 firmada; D1–D4 las toma Claude con la recomendación escrita; D5 partida (el mecanismo sí, el reparto del trabajo no). Arranca por **C0**, que es derivable hoy y no cambia ninguna pantalla. |
| 2026-11-27 | Plan escrito. Lo pidió Edgar al parar el trabajo de parcheo: *«el modelo es anterior a muchas cosas nuevas; hay que partir de ver qué nos aportan esos módulos»*. Las cifras de §1 se midieron ese día contra prod, y las de interfaz **en pantalla viva** recorriendo el proceso con el folio `INV-2026-00011`. Queda ⬜ por cupo. |
