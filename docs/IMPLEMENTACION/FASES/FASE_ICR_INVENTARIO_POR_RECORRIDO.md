# Fase ICR — Inventario por recorrido

```
OBJETIVO: que el conteo físico se organice por el RECORRIDO del almacén y no por una lista de
          SKUs, para que el trabajo se pueda repartir entre personas y el folio se pueda cerrar.
MÉTRICA:  Folios cerrados — HOY: 0 de 8 en 9 meses (medido 2026-11-27) → META: 1 cerrado de
          punta a punta en Padre Hidalgo.
CAPA TOPE: C3
ÁREA:      Comercial
DUEÑO:     <por definir — Edgar>
ESTADO:    ⬜
```

⛔ **No se abre todavía.** El cupo está en **11 fases 🔨 contra un tope de 4** (medido 2026-11-27
con `node .claude/skills/pm/tablero.js`). Abrirla exige que el PM cierre o pause otras siete, o que
la abra por encima del cupo a sabiendas. Ver §5.

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
| **UB · Ubicaciones** | 476 ubicaciones, **472 con orden de recorrido** (`pick_sequence`), 12 piezas, 17 caras, 11 pasillos | **El recorrido**: en qué orden se camina el almacén |
| **GP · Olas de surtido** | 9 tablas (`picking_waves`, `wave_lines`, `wave_sequences`, `wave_allocations`, `supervisor_tasks`…) | **El modelo de repartir trabajo** del almacén entre personas y seguir su avance — ya construido y en uso |
| **Códigos por unidad** | **9,066** códigos con su peldaño (`kepler_base` 7,109 · `kepler_u2` 405 · `kepler_u3` 7 · `wincaja` 1,545) | **La unidad** en que cuenta cada persona |
| **El ODS** | `analytics.v_erp_stock_on_hand`, derivada del ERP | **Un solo teórico** |

⭐ **La idea en una frase:** la unidad de trabajo del conteo deja de ser *un SKU de una lista* y pasa
a ser *una ubicación en el orden en que se camina*. Eso es lo que permite decir «este tramo es tuyo»
— y es exactamente lo que ya hace el surtido de pedidos.

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
| ICR.0.2 | **Cada artículo sabe dónde está**: su ubicación sale de `bin_assignments` + `warehouse_bins`, por almacén | ⬜ | Ya ejercido el 2026-11-27: 39 de 3,364 en PH. Debe dar lo mismo desde la API |
| ICR.0.3 | **Cada artículo sabe en qué tramo está**: `pick_sequence` de su ubicación, y un tramo = un rango contiguo de esa secuencia | ⬜ | 472 de 476 ubicaciones tienen `pick_sequence`; las 4 sin él se declaran |
| ICR.0.4 | **El artículo sin ubicación tiene su propio tramo**: «sin ubicar», que es trabajo real y hoy sería invisible | ⬜ | 3,325 de 3,364 hoy caerían ahí: la cifra tiene que verse, no esconderse |
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
| **D6** | **El cupo**: 11 fases 🔨 contra 4 | Cerrar o pausar antes de abrir ésta, o abrirla por encima a sabiendas | Edgar |

---

## 5. Riesgos y bloqueos

- ⛔⛔ **El cupo.** 11 fases 🔨 contra un tope de 4. Abrir ésta sin cerrar nada empeora el cuello que
  el método existe para controlar: *se abre más de lo que se cierra*.
- ⛔ **La cobertura de ubicaciones es del 1 %.** Con 5 ubicaciones ocupadas de 471, el reparto por
  tramos arrancaría casi vacío: casi todo caería en «sin ubicar». La fase **no falla** por eso —ese
  tramo es trabajo real y se ve— pero el beneficio llega cuando alguien capture (D5).
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
| 2026-11-27 | Plan escrito. Lo pidió Edgar al parar el trabajo de parcheo: *«el modelo es anterior a muchas cosas nuevas; hay que partir de ver qué nos aportan esos módulos»*. Las cifras de §1 se midieron ese día contra prod, y las de interfaz **en pantalla viva** recorriendo el proceso con el folio `INV-2026-00011`. Queda ⬜ por cupo. |
