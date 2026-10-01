# La verdad absoluta — qué la arbitra, cuánto se sostiene, y qué se declara

> **Fuente principal de razón del sistema.** Pedido de Edgar (2026-09-08): *"necesitamos verdad
> absoluta de existencia, ventas y unidades"* · *"solo hay que enfocarnos en kepler"* ·
> *"documentemos la verdad absoluta hasta ahora, será nuestra fuente principal de razón"*.
>
> **Medido contra PROD** (Railway, tenant `mega_dulces`) el **2026-09-09 16:05 UTC**, salvo lo que
> se atribuye explícitamente a otra medición. ADR-059.
>
> ⭐ **§13 — auditoría del origen (Kepler crudo), 2026-09-11/12.** Decode y forma del ERP, arbitrados
> contra POS vivos. **§13.3 es la más importante del documento para quien vaya a medir algo**: la
> primera versión de esa auditoría reportó un incidente de producción que **no existía**, porque midió
> la réplica de desarrollo creyéndola prod. Está conservada como caso testigo.

---

## 0. Qué es este documento, y qué NO es

Este repo ya tiene [`REGISTRO_CANONICO_COMPLETO.md`](REGISTRO_CANONICO_COMPLETO.md), que contesta
**"¿de dónde sale este dato?"**. Éste contesta la otra pregunta, que no estaba escrita en ningún
lado:

> **¿Con qué se comprueba que el dato está bien, y cuánto de él aguanta esa comprobación?**

Son preguntas distintas y hacen falta las dos. Una fuente única que nadie contrasta sigue siendo
una fuente única equivocada. Este documento no repite el linaje: **enlaza** al registro y agrega el
**árbitro**, el **veredicto** y el **hueco declarado**.

⛔ **No es un reporte.** Cada cifra de acá tiene un candado que la vuelve a medir. Si una cifra y su
candado divergen, **gana el candado** y este documento está viejo.

---

## 1. Las siete reglas

Todas salieron de errores que ya se pagaron. No son estilo.

### R1 — Cada ERP se juzga con SU propia evidencia

Kepler contra Kepler, Wincaja contra Wincaja. Juzgar el costo de Wincaja contra
`v_supplier_cost_ladder` (que deriva de `kepler_ods.kdpv_prov_prod`) produjo una medición que hubo
que descartar entera. Un ERP no es el árbitro de otro.

### R2 — El DINERO arbitra la CANTIDAD, y el costo arbitra mejor que el precio

Una cantidad sola no se puede auditar: no se sabe en qué unidad está. Préstale un precio y el
dinero delata el peldaño. Y entre los dos precios posibles, **el costo gana por razón estructural**:
el precio tiene niveles, descuentos y promociones; el costo no. Medido: el precio contradice **9×
más** renglones que el costo (59,612 contra 9,102), y ese exceso es descuento, no unidad. Por eso el
precio **se conserva pero no vota**.

### R3 — El costo tiene que venir del MISMO ERP y del MISMO ALMACÉN que la cantidad

Un costo por PRODUCTO no puede valuar una cantidad por ALMACÉN sin declarar en qué unidad está.
Es la regla que destapó los $5.59M de sobrevaluación del inventario (§3.1). Corolario: la unidad de
una columna **no se hereda de su fuente** — se prueba en la tabla que el consumidor lee (ADR-055).

### R4 — Lo que no se puede medir se DECLARA; nunca se dibuja como cero ni como relleno

`sin_testigo` viaja con **NULL**, jamás con `0` — un `0` se lee "no cuesta nada". Y las **ausencias
distintas llevan etiquetas distintas**: que falte el testigo del ERP no es lo mismo que falte el
costo del catálogo. Una fila ausente en un `LEFT JOIN` llega NULL y se lee como sana (ADR-056).

### R5 — Un árbitro que nunca contradice es un espejo

Todo veredicto tiene que poder salir en contra, y hay que **probarlo** contra un conjunto que otro
testigo ya juzgó mal. Es la regla que mató un testigo propio antes de shipearlo (§6.1).

### R6 — El patrón se busca en lo INCORRECTO, nunca en lo correcto ⭐

Pedido de Edgar el 2026-09-09, y la regla que produjo §3.3, §3.4 y §9.6–9.8. Medir lo que aguanta
sólo confirma lo que ya se creía; **la estructura del error es la que nombra la causa**. Tres
corolarios, cada uno pagado:

- **Un residuo definido de modo que excluya el error no es un residuo.** «SIN EXPLICAR = 0» era
  cierto porque la consulta filtraba `entradas − salidas >= 0`, o sea sacaba de la cuenta a los
  1,818 negativos, el único residuo que había (§3.1b).
- **Contar filas ordena distinto que contar pesos.** La sucursal con **peor** tasa de error (36.02%)
  aporta $114,670; la de **mejor** tasa (20.47%) aporta $2,981,753. Y **100 filas de 18,967 cargan
  el 47%** de la brecha: un promedio sobre esa población no significa nada.
- **La causa se busca donde el error está concentrado, y se prueba contra un resolvedor, no contra
  los nombres.** «Es granel» y «es el factor de caja» venían de leer los nombres de las filas más
  caras; contra `v_unit_truth` las dos se cayeron (§9.6, §9.7) y la causa real apareció en otro lado.
- ⚠️ **Y el matiz que esta regla se cobró a sí misma el mismo día: el testigo tiene que ser el MÁS
  FUERTE disponible.** Refuté la etiqueta "réplica" con las entradas acumuladas de `kdil` — un
  **acumulado recalculable**, que no dice nada sobre el origen de los datos. La identidad de folios
  estaba a mano y daba **100.00%**. Buscar en el error no exime de elegir bien con qué medirlo
  (§9.9).

---

### R7 — Un árbitro sin PARIDAD REGISTRADA no protege nada ⭐⭐

Edgar, 2026-09-11, señalando una celda: *"tu verdad absoluta fallo"*. Tenía razón, y la regla
sale de medir por qué.

`96504 RUFFLES QUESO 27G` publicaba **UxC 1** cuando son **58**. No falló el dato ni el
resolvedor: `v_product_box_factor` decía 58 desde siempre, y tres testigos independientes lo
confirmaban. Falló **este documento como mecanismo**:

- §5 declara QUÉ LEER para cada número.
- §7 lista los huecos **del dato**.
- Cada candado verifica que **un resolvedor concuerde con su testigo**.
- ⛔ **Ninguno verificaba que lo PUBLICADO concordara con el resolvedor.**

La distancia entre lo arbitrado y lo publicado no estaba en ninguna lista. Medido ese día sobre
publicadores (código, sin comentarios): **factor de caja 19% de adopción · costo 15% · y dos
resolvedores con CERO lectores** (`v_erp_sales_line_units`, `v_erp_stock_truth`).

**La regla:** todo resolvedor de §5 lleva una **paridad registrada** — una consulta que compara
lo que se publica contra lo que el árbitro dice, con umbral **calibrado** y baseline medido — o
un motivo escrito de por qué no puede tenerla. La compuerta vive en
`database/tests/test-newdb-truth-parity.js` y **lee la tabla de §5 de este archivo**: agregar un
resolvedor acá sin registrar su paridad pone el candado en rojo solo.

Lo medido al estrenarla:

```text
factor de caja  catalog.products.factor_sale  vs v_product_box_factor .....   208 · $4,971,906
costo           catalog.products.cost_base    vs v_erp_unit_cost .........    583 · $21,842,988
existencia      commercial.stock.quantity     vs v_erp_stock_on_hand .....    140 (dato vivo)
clase ABC       commercial.abc_classification vs v_abc_class ............. 1,846
```

⚠️ **Tres trampas, las tres ya cobradas al construir esto:**

1. **Un umbral sin calibrar no es una medición.** La paridad de costo con "difiere > $0.01" daba
   **5,916**: ruido. Medida la distribución (mediana 0.9731, p90 1.0000, p10 0.81), la señal son
   las **583 por debajo de 0.5x**.
2. **Una copia a mano de una declaración se despega de la declaración.** La primera compuerta
   traía los resolvedores en una lista propia con 7 entradas mientras §5 declara **13** — pasaba
   en verde con 6 sin paridad. Por eso ahora lee el documento.
3. **Un baseline sobre dato vivo necesita margen declarado.** La existencia dio 196 y 140 con
   minutos de diferencia; un trinquete clavado en el valor exacto parpadea en rojo sin que nadie
   rompa nada, y una alarma que grita en falso enseña a ignorar el tablero.

⛔ **Lo que esta regla NO alcanza, dicho antes de que alguien lo suponga:** sólo ve valores
**almacenados**. El `uxc` de Sell-Out se calcula al vuelo y no vive en ninguna tabla — para ésos
hay que golpear el endpoint y comparar la respuesta contra el árbitro, y **eso no está hecho**.
Tampoco prueba que quien lee el resolvedor lo use bien: Sell-Out lo leía para las cajas desde U.7
y aun así publicaba el UxC desde otra columna.

## 2. El estado, en una tabla

| dimensión | qué la arbitra | resultado | ¿verdad absoluta? |
|---|---|---|---|
| **Existencia · cantidad** | identidad `entradas − salidas = qty`, del propio `kdil` | 92.84% directo · **1,818 negativos (−68,504 u) recortados, no explicados** · el descarte por almacén **ya no es hueco**: es réplica probada (§9.9) | ⚠️ **sí, con UN hueco declarado** (§3.1b) |
| **Existencia · valor** | `kdik.c16` — costo **promedio ponderado histórico** de Kepler por sucursal × SKU | 74.5% confirmado · brecha enumerada por causa (§3.3) | ✅ **sí, con residuo enumerado** |
| **Ventas · dinero** | `c62 = u1_cost × c58` + paridad contra el renglón crudo | cobertura **98.20%** del dinero de Kepler | ✅ **sí** |
| **Unidades · ticket** | el renglón declara y el costo confirma | **95.75%** confirmado | ✅ **sí** |
| **Unidades · `U-D-8`** | — | **no arbitrable** (límite de la fuente) | ⛔ **declarada, no arbitrada** |
| **Venta de ruta de una sucursal que cambió de ERP** | la **frontera medida** entre los dos POS (último día del viejo + 1), no el máximo entre ellos | Canindo: +$728,711 en 2026 · agosto **+$808,409** que el `GREATEST` tapaba (§4.6) | ✅ **sí, con las 3 líneas de $6 del arranque declaradas** |
| **Costo con el que se PUSO EL PRECIO** | la propia ficha de Kepler: `PV = c77 × (1+margen) × (1+impuesto)` | cuadra **99.24%** de lo evaluado; el tercer factor vale **81.6 pp** (prueba negativa) | ✅ **sí** — §16.1/16.2 |
| **La META de margen** | `kdii.c87/c88/c89` ponderado por el **peldaño vendido**, contra el margen que el negocio reporta | **11.55%** · el testigo independiente dice **~11.5%** | ✅ **sí** — §16.8 |
| **COGS de Kepler (documento vs kardex)** | el precio de la **entrada real** (`X-A-40`), testigo de transacción | **empate: 57.55% vs 40.39%**, errores medianos 2.66% y 2.48% | ⛔ **declarada, NO arbitrada** — §16.4 |
| **Los 1,205 renglones con razón 10.000** | el **mecanismo**, no la estadística: el kardex multiplica el costo del peldaño alto por la cantidad base | **$613,646** sobre $99,394 de venta | ✅ **sí, el kardex está mal** — §16.3 |
| **Destino de un traspaso** | `dest_label` — la etiqueta que Kepler escribe en el ENVÍO, independiente del pareo **y** del mapa | **1,561 de 1,562** pares de 180 d coinciden con el almacén que recibió ($66.86M) · el único que contradice es una ruta, y **no** se publica como OK | ✅ **sí, desde 2026-09-30** — `[DM.15]`, candado de 7 bloques |
| **Wincaja (operación viva)** | — | ⭐⭐ **ya no hay**: la venta de Wincaja es **0.0%** de los últimos 30 d ($230 contra $44.5M). Migró entera a Kepler | ✅ **hueco CERRADO** — §8 |
| **Wincaja (histórico)** | tiene árbitro propio, sin cablear | sigue sin cablear, y es el único acceso al pasado de cada plaza antes de su corte | ⬜ **no empezado** — §8 |

---

## 3. Existencia

### 3.1 La cantidad ya era verdad — y dos sospechas mías eran falsas

`analytics.v_erp_stock_on_hand` es la fuente. **Acierta 100.0% contra el POS en vivo** sobre 22,090
SKUs, mientras la tabla `commercial.stock` acierta 91.0% (15,324 unidades de error) — *medido en la
migración `20260902170000`, no en esta sesión*. Por eso **la vista manda y el fact sólo enriquece**;
`commercial.stock` no se joinea ni para el apartado.

La identidad interna cierra:

```
25,084 filas · identidad directa 92.84% · negativos recortados 1,798 · SIN EXPLICAR 0
```

⚠️ **Corregido el 2026-09-09 (revisión KX).** Este bloque decía *"cierra **sin residuo**"* y ese
`SIN EXPLICAR 0` **no era un hallazgo: era la definición.** La consulta calcula `sin_explicar` con
`AND entradas − salidas >= 0`, o sea **excluye por construcción** los negativos, que son el único
residuo que existe. Buscamos el patrón en lo correcto y encontramos, previsiblemente, que lo
correcto estaba correcto.

- **La sucursal `00` de Kepler sí está excluida** (deriva 122,096,465 unidades fantasma; el filtro
  `w.kepler_code <> '00'` la deja fuera). Es **OFICINAS**; el CEDIS real es `BPIRAPUATO`, de Wincaja.
- ⛔ **Pero `kdil.c4 = 0 en el 100%` NO significa que el baseline sea cero.** Significa que **esa
  columna no se usa**. La prueba: **748 SKUs venden sin tener UNA sola entrada** (−14,640 u). Un
  saldo inicial que no existe no es un saldo inicial de cero, y la diferencia se paga en el residuo.

### 3.1b ⭐ Los negativos: recortar no es explicar

Se recortan a cero con `GREATEST(..., 0)` para no publicar existencia imposible —eso está bien—
pero se **contaban al costado y nadie los asertaba**: podían triplicarse en silencio. Medidos:

```
1,818 de 25,132 filas (7.23%) = −68,504 unidades que Kepler dice que salieron sin haber entrado
   sin NINGUNA entrada ....... 748 SKUs   (−14,640 u)
   entradas insuficientes .... 1,070 SKUs (−53,890 u)
```

Y su **firma quedó medida, no supuesta**: ⛔ **no es error de unidad.** Sólo 2 de 1,796 tienen la
firma de caja (`salidas/bf == entradas`), ninguna coincide con `units_per_box`, y la mediana de
`salidas/entradas` es **1.090** — no 12 ni 24. Vendieron ~9% más de lo que registraron entrar. Eso
apunta a captura/faltante, no a un peldaño mal leído. El candado vigila esa mediana: **si algún día
se pega a ~12 o ~24, entonces sí es unidad**, y se pone rojo para forzar la re-investigación.

### 3.2 El valor NO era verdad: $5.59M de sobrevaluación, en dos causas separables ⭐

Se valuaba con `COALESCE(cost_with_tax, cost_base)` de `catalog.products` — un costo por PRODUCTO,
global, en la unidad que el catálogo tenga. Kepler trae **su** costo unitario por **sucursal × SKU**
(`kdik.c16`), al mismo grano que la cantidad, y nadie lo usaba para esto.

```
mediana  cost_base     / kdik.c16 = 1.0000    pega ±2% en 72.46%
mediana  cost_with_tax / kdik.c16 = 1.0800    pega ±2% en 19.71%
```

O sea **`cost_base` ES el costo de Kepler**, y la pantalla publicaba **con impuesto**. Y con la
mediana en 1.0000 exacto el agregado difería 13%: la discrepancia está **concentrada**, no repartida.

| veredicto | filas | publicado | arbitrado | brecha |
|---|---|---|---|---|
| **confirmado** | 11,882 | $30,762,104 | $28,011,539 | **$2,750,565** ← el impuesto (×1.098) |
| `precio_movido` | 4,230 | $8,707,755 | $7,909,300 | $798,455 |
| **`contradicho_por_factor`** | **273** | $2,668,541 | $648,018 | **$2,020,523** ← el factor de caja |
| `sin_testigo` | 26 | $16,316 | **NULL** | — |
| **TOTAL** | **16,411** | **$42,154,716** | **$36,568,857** | **$5,585,859 (13.25%)** |

Las razones de esas 273 filas son **16.2 · 21.6 · 20.0 · 14.0 · 32.0 · 31.4 · 10.8 · 3.3** —
factores de caja, no diferencias de precio. Y los nombres cierran el caso: `ROLLO GUAYABA CHICO
GRANEL` · `CHOC HERSHEY BARRA GRANEL 14KG` · `TURIN CONF SEMIAMARGO 16KG` · `ALTEÑO CAR SURTIDO
GRANEL / 5KG`. **`cost_base` viene por bulto; `c16` por pieza o kilo.** Es ADR-051 y ADR-055
medidos, por primera vez, sobre la valuación del inventario y con el propio costo de Kepler como
árbitro.

### 3.3 ⭐⭐ El mapa del error, por causa nombrada (revisión KX, 2026-09-09)

Edgar: *"no busquemos patrones en lo correcto, busquemos patrones en lo incorrecto."* Al mirar sólo
las filas que **no** aguantan, el relato de §3.2 se afinó y en parte se cayó.

| causa | filas | \|brecha\| |
|---|---:|---:|
| 1. impuesto en el costo publicado | 15,090 | **$4,024,239** |
| 2. sin impuesto: diferencia real de costo | 3,555 | $87,361 |
| 3. contradicho por factor (resto) | 234 | **$2,314,520** |
| 4. catálogo con las DOS columnas en unidades distintas | 101 | $354,067 |
| 5. sin testigo de Kepler | 28 | $0 |

**Dos cosas que sólo se ven mirando el error:**

- ⭐ **La tasa de error no predice el dinero.** La suc **04** tiene la peor tasa de filas objetadas
  (**36.02%**) y sólo **$114,670** de brecha; la suc **06** tiene la mejor (**20.47%**) y
  **$2,981,753**. Contar filas malas ordena al revés que contar pesos.
- ⭐ **Está concentrado, no repartido.** **10 filas de 18,967 cargan el 24%** de la brecha, **100
  cargan el 47%**, 1,000 cargan el 75%. Un promedio sobre esta población no dice nada.

**Lo que resultó ser la causa, con su prueba:**

1. **El recargo no es UNO: `cost_with_tax / cost_base` toma cuatro valores discretos** — ×1.000
   (2,223 SKUs) · **×1.080** (4,428) · ×1.160 (2,129) · **×1.240** (283, que es **IVA 16% + IEPS
   8%**: `NESTLE CARLOS V`, `KINDER`, `TAKIS`, `CANELS`). Como concepto fiscal es coherente; el
   error es **valuar inventario con el costo con impuestos**, que es lo que KE.2 corrigió.
2. ⭐⭐ **En 62 SKUs las dos columnas del catálogo están en unidades distintas — y al revés de lo
   que dicen sus nombres.** `cost_with_tax < cost_base`, que ningún impuesto puede producir. En las
   101 filas con existencia, contra Kepler: **`cost_with_tax / c16` pega en 60 con mediana 1.000**
   y `cost_base / c16` pega en 21 con mediana **10.872**. O sea **`cost_with_tax` es el costo
   unitario y `cost_base` es el bulto.** Ejemplos: `TURIN CONF BLANCO 16KG` $5,002.56 vs $152.11
   (1/32.9) · `ROLLO GUAYABA CHICO GRANEL` $891.00 vs $55.00 (1/16.2).
   Son **los mismos nombres** que §3.2 atribuía al "factor de caja" — y la causa no era el factor:
   era que las dos columnas del mismo producto miden cosas distintas.
   ⚠️ **Bomba latente, no daño de hoy**: las 101 filas tienen costo de Kepler, así que ninguna cae
   al fallback `cost_base` del service. Si Kepler dejara de traer `c16` para una, se valuaría
   **~10.9× arriba**. El candado lo vigila (`al_fallback === 0`).

### 3.4 ⭐⭐ Qué es realmente el árbitro: un promedio histórico, no el costo de hoy

`kdik.c16 = c8/c5`, y **`c5` resultó ser las ENTRADAS ACUMULADAS**: idéntico a `SUM(kdil.c8)` en
**25,143 de 25,143 pares = 100.00%**. O sea el árbitro divide el **valor acumulado de toda la
historia de compras** entre las **unidades acumuladas** de esa historia.

Es un **costo promedio ponderado**, y valuar inventario así es contablemente legítimo. Pero hay que
declararlo, porque cambia lo que la cifra significa:

```
mediana c16 / c18 (último costo) = 0.9805      -> el árbitro valúa ~2% BARATO, sistemáticamente
c18 falta en el 56.06% de los pares            -> el último costo ni siquiera está casi siempre
```

⛔ **Publicar un promedio ponderado histórico como si fuera costo de reposición no es lo mismo.** El
inventario arbitrado está a costo promedio; la diferencia contra el último costo conocido es −1.95%
mediano y en 1,578 pares supera el 10%.

**Efecto en la cifra publicada** (consulta real del service, prod):
`kepler_ods` **$39,980,353 → $35,510,326** (−11.2%) · `wincaja` sin cambio ·
**TOTAL $66,625,522 → $62,155,495 (−6.71%)**.

---

### 3.5 ⭐ Lo que se APLICÓ (KX, 2026-09-09)

Edgar: *"apliquémoslo y tengamos una verdad absoluta"*. Los hallazgos de §3.3–§3.4 no se quedaron
en el documento:

| qué | dónde | efecto en la cifra publicada |
|---|---|---|
| **El fallback del catálogo va blindado con `LEAST`** | `existencia.service.ts` | **cero hoy** (las 101 filas tienen costo del ERP). Prueba forzada: sobre esas filas el fallback viejo da **$3,574,981** y el blindado **$563,102**, contra **$246,243** del ERP — de ×31.4 a ×1.00 en los peores. Y en los **9,070** SKUs sanos el `LEAST` sigue eligiendo `cost_base` el **100.00%** de las veces |
| **La pantalla declara CON QUÉ se valuó** | `almacen-existencia.component.ts` | dos banners nuevos: el método (**costo promedio del ERP, no de reposición**) y `celdas_sin_costo_erp`, que el backend devolvía desde el 2026-09-08 y **nadie veía**. Cierra la falla de VP.0.1 una capa arriba |
| **`metodo_valuacion` + `celdas_costo_invertido`** en la respuesta | `existencia.service.ts` | el consumidor deja de tener que suponer el método |
| **Los negativos tienen techo** | `test-newdb-stock-truth.js` | se contaban y no se asertaban; ahora si crecen, rojo |
| **El filtro de almacén asegura su RAZÓN** | idem | ≥ 99% de folios idénticos, no `replica > 0` |

**Candado: 21 → 37**, con **7 pruebas negativas** verificadas en rojo antes de darlas por buenas.

⚠️ **Y lo que el blindaje NO hace, dicho:** el fallback sigue **~2.3× arriba** del costo del ERP
($563,102 contra $246,243), porque `cost_with_tax` trae impuesto. Reduce el error de ~14.5× a
~2.3×; **no lo elimina**. Es un fallback, no un árbitro — el arreglo de fondo es el dato maestro.

---

## 4. Ventas y unidades

### 4.1 Kepler nunca pierde la unidad — el renglón la declara

Ésta es la observación de la que sale todo lo demás: **Kepler no *resuelve* la unidad, nunca la
*pierde*.** Cada renglón de `kepler_ods.kdm2` carga su escalera completa:

| columna | qué es |
|---|---|
| `c11` / `c9` / `c12` | la unidad **base**, cuántas, y su precio |
| `c55` / `c56` / `c57` / `c58` | la unidad que el cliente **compró** (siempre la mayor), cuántas, su precio, y **el factor** |
| `c62` / `c63` | el **costo** del renglón |

Y el renglón cuadra consigo mismo: **`c9 = c56 × c58` en 709,805 de 709,864 = 99.99%**. Estábamos
leyendo la mitad del renglón. ⚠️ El repo **ya había decodificado** `c55/c56/c57/c58` para COMPRAS
(RA-PRO.43) y nunca lo llevó a ventas — el patrón que ADR-056 describe: un primitivo bien hecho para
un dominio, jamás generalizado.

### 4.2 El árbitro: `c62 = u1_cost × c58`

El costo del renglón es lo que Kepler pagó por **una** unidad base, por el factor que el renglón
declara. Se sostiene en **98.39%** de 691,746 renglones, con **mediana exactamente 1.0000**, y
parejo entre sucursales (98.23%–99.00%).

| certeza | renglones | % | importe |
|---|---|---|---|
| **confirmado** | 679,744 | **95.75%** | $45,564,138 |
| `sin_costo` | 21,109 | 2.97% | $15,314,120 |
| **`contradicho`** | 9,011 | 1.27% | $2,167,414 |
| `sin_factor` | 60 | 0.01% | $262,427 |

### 4.3 El precio se conserva pero NO vota

Un diseño anterior puso los tres testigos a votar y fabricó **$19.5M de conflicto falso**. Medido:
el precio contradice en **59,612** renglones contra **9,102** del costo, y en `U-D-8` era "certero"
en apenas 0.6%. Un testigo que se equivoca en más de la mitad de un doctype entero no es testigo:
es ruido con voto.

### 4.4 El universo de venta: `U-D` 8 / 10 / 12

| doctype | qué es (catálogo `kdmm`) | entra |
|---|---|---|
| `U-D-10` | Ticket Contado Caja | ✅ |
| `U-D-8` | **Factura Telemarketing** (= mayoreo) | ✅ |
| `U-D-12` | Factura Cont No Fiscal | ✅ |
| `U-D-6` | Factura global | ⛔ **re-factura los tickets en 93.1%** de los pares (SKU, día) |
| `U-D-13` | Factura Cred No Fiscal | ⛔ es el **traspaso** al CEDIS |
| `U-D-40` / `U-D-41` | Pedido / Embarque | ⛔ no son venta |

⚠️ **El corte tiene que ser el MISMO en el fact y en el sell-out** (`mart.ventas` y
`analytics.mv_kepler_sales_daily`). Cuando divergieron, las dos superficies se contradecían entre sí
por **$16,071,965 / 90 d**.

### 4.5 Paridad: cobertura **98.20%** del dinero que Kepler entrega

```
universo completo (8/10/12)      cantidad 98.01%   importe 99.74%   cobertura 98.20%
mostrador (tienda vs 10+CONTADO) cantidad 98.06%   importe 99.75%   delta $680,308
mayoreo nuestro vs U-D-8 de Kepler                                  99.19%
```

⚠️ **El total puede cuadrar con el dinero en el canal equivocado.** Fue el riesgo concreto: el 100%
de `U-D-8` caía en `credito` (la rama `TI%`→mayoreo **nunca se dispara**), lo que habría inflado el
crédito publicado de $6.5M a $20.8M — **3.2×**. Un total correcto pagado con otro número falso no es
paridad. Por eso `mart.ventas` lleva `doctype` y el canal lo usa.

### 4.6 ⭐ La venta de una ruta cuando la sucursal cambió de ERP: la serie se COMPONE, no se maximiza

Canindo (almacén `06`, rutas 501-505) cobró en **Wincaja** hasta agosto; desde entonces cada
camioneta corre **su propio Kepler local** y lo empuja al runner `.249`. Tres universos escribían la
MISMA llave `(06, WIN-50N, mes)` de `analytics.sales_by_route_monthly`, resueltos con un `GREATEST`
por métrica:

| universo | qué ve | veredicto |
|---|---|---|
| **Wincaja** (`wincaja.v_sales_lines`, `branches.parent_branch='50'`) | ene-01 → 11/12-ago | ✅ **arbitra su era** |
| **PUSH** — la base de la propia camioneta (`md_06-0NN` → `.249 mart.ventas`, `ruta_50N`) | 11/13-ago → hoy | ✅ **arbitra su era** |
| réplica de sucursal (`kepler_md_06`, `kdm1.c67 ~ '500N'`) | 3 de 5 rutas, en ventanas sueltas | ⛔ **subconjunto degradado — no arbitra nada** |

La réplica se refuta con su propia cobertura: `5001` sólo tiene **18–24 ago**, `5003` sólo **15–21
ago**, `5004` y `5005` **nada**. La venta se captura en la laptop de la van y a la sucursal sólo
llega lo que se sincroniza. Un universo que ve una semana de tres rutas no puede arbitrarle a uno
que ve el mes de las cinco — y el `GREATEST` se lo permitía.

**Dos cosas rotas, las dos por el máximo ciego:**

1. **El mes de transición publicaba el MÁXIMO de dos mitades disjuntas en vez de su suma.** Agosto
   de las 5 rutas: faltaban **$808,409**, la mitad Wincaja del mes (1→11/12-ago). La pantalla
   mostraba agosto $1.36M contra julio $2.20M — una caída del **38% que no ocurrió**.
2. **Enero–julio quedó congelado el 18-ago, o sea PRE arreglo RD.1** (`20260907280000`, la fecha de
   negocio de Wincaja venía corrida un día). `import-wincaja-routes-monthly` excluye
   `parent_branch='50'`, así que Canindo fue **la única ruta Wincaja que no se re-escribió** tras el
   arreglo. Síntoma visible: la ruta **505 publicaba $10,882 en MAYO** y su primer día real fue el
   1-jun.

**La prueba de (2), porque "el número cambió" no es un diagnóstico:** re-agregando el MISMO silver de
hoy con la atribución vieja (`business_date − 1`, que es exactamente lo que daba `fecha_mx_date`
sobre una medianoche UTC) se reproduce el gold congelado en **31 de 31 llaves, al peso y al ticket**.
Las 14 llaves que BAJAN son la corrección, no una degradación.

**La regla que queda: la frontera se MIDE, no se hardcodea.** `cutover(ruta) = último día que cobró
Wincaja + 1` — 501 y 503 el 13-ago, 502/504/505 el 12-ago. Wincaja aporta `< cutover` y el push
`>= cutover`: ventanas disjuntas, ni hueco ni doble conteo. Lo único que la frontera deja fuera son
las **3 líneas de $6** con que arrancó el Kepler local de 502/503/505 el mismo día en que Wincaja
todavía cobraba ($18, declarados). Y `business_date <= CURRENT_DATE` en las dos partes: **una sola
fecha corrupta a futuro correría la frontera meses adelante y taparía el push entero**.

Publicado: **$15,815,691 → $16,544,403 (+$728,711)**; agosto pasa de $1,358,965 a **$2,167,374**,
plano contra julio, que es lo que de verdad pasó. Dueño único de la llave:
`import-canindo-routes-monthly.js`, con overwrite y una salvaguarda que **no baja el gold sin
`--allow-lower`**. La réplica se sigue leyendo, pero **sólo como testigo**, en
`reconcile-route-provenance.js`, que ahora declara `composite` en vez de nombrar ganador a un
universo que no es el dueño.

⚠️ **Esto se repite en CADA migración de ERP de una sucursal.** Morelia Madero (Wincaja `32` →
Kepler `07`, 08-sep) es el caso vivo: hoy no tiene rutas, pero el día que las tenga la trampa es la
misma — y su handoff también hay que componerlo, no maximizarlo.

---

## 5. Los resolvedores canónicos — qué leer para qué

⛔ **No re-derivar ninguno.** Un primitivo con dos implementaciones es un primitivo que va a
divergir.

| necesitás | leé | nunca |
|---|---|---|
| ⭐⭐ **la unidad que KEPLER usó** (su escalera `PZA→PAQ→CJA` — ⚠️ la unidad mayor NO siempre es `CJA`: en granel es `BTO` y en cubeta `CUB`, 170 SKUs sin caja, medido 2026-09-30) | `analytics.mv_kepler_unit_ladder` | deducirla de `c84`, de la etiquetera o del override: Kepler la **declara** por renglón y calcula con ella (`c9 = c56 × c58`, 99.99%). ADR-063 · §14 |
| existencia por almacén × producto | `analytics.v_erp_stock_on_hand` | `commercial.stock` (acierta 91%) |
| ⭐ **clase ABC que fija el nivel de servicio** | `analytics.v_abc_class` | `commercial.abc_classification` desde el reabasto (llega tarde) · recalcular el Pareto (§12.4) |
| ⭐ **costo unitario para VALUAR** (los dos ERPs) | `analytics.v_erp_unit_cost` | `catalog.products.cost_base` / `cost_with_tax` (§12) |
| **costo unitario de Kepler** | `analytics.v_kepler_unit_cost` | `kdik` a mano (se pierde el filtro de almacén). ⚠️ Es **promedio ponderado histórico**, no costo de reposición (§3.4) |
| veredicto del valor del inventario | `analytics.v_erp_stock_truth` | — |
| unidad/peldaño del renglón de venta | `analytics.v_erp_sales_line_units` | inferirlo del rótulo |
| factor de caja por producto | `analytics.v_product_box_factor` | `kdii.c84` crudo |
| factor de caja por almacén × producto | `analytics.v_warehouse_box_factor` | un factor por producto |
| la unidad resuelta, con testigo | `analytics.v_unit_truth` (+ `_coverage`) | — |
| sell-out Kepler a grano día | `analytics.mv_kepler_sales_daily` | `analytics.sales_daily` para sell-out |
| ⭐ **el CANAL de una fila de sell-out** (de negocio, no el crudo del ERP) | `analytics.sellout_channel_map` (+ `v_sellout_channel_coverage`) | enumerar canales a mano en el service o en el front: el universo publica SEIS crudos y las listas literales tenían CUATRO — `mayoreo` (U-D-8 telemarketing, $21.4M/90 d) y `contado_nf` quedaban sin rótulo, sin filtro y **sin hoja en el árbol**, que es lo que los tiraba. ⚠️ `wincaja:credito` (caja 70 «Mayoreo a credito») y `kepler:mayoreo` son EL MISMO canal a los dos lados del cutover. VSO.1 · §15 |
| ⭐ **desde cuándo manda Kepler en una sucursal** (y hasta cuándo Wincaja) | `analytics.v_branch_erp_cutover` | escribir la fecha como literal en una vista (se copió 3 veces y divergió — SB.1), o **inferirla** de `last_movement_date`: es una DECISIÓN, y en La Piedad las dos piernas se traslapan 9 meses. La fecha correcta es el **traspaso real** del POS, no un fin de mes. VSO.3 · §15 |
| ⭐⭐ **el costo con el que se PUSO EL PRECIO** (el de la ficha de Kepler) | `analytics.v_kepler_standard_cost` | cualquiera de los otros cuatro costos: ninguno fija el precio. §16 |
| costo pagado al proveedor | `analytics.v_supplier_cost_ladder` | un peldaño fijo de la escalera. ⛔ **Y NO sirve de árbitro del costo de la ficha: es un ESPEJO** — idéntico al centésimo en el 86.06% (§16.4) |
| venta mensual por ruta | `analytics.sales_by_route_monthly` filtrando `route_code LIKE 'WIN-%'` | las series `c63` `UD100N` que hay en la misma tabla — son **cajas de mostrador**, no rutas |
| quién escribió cada llave de venta-ruta | `analytics.v_route_monthly_provenance` | suponer que el gold es el universo más fresco |

Y para **de dónde sale** cada dato: [`REGISTRO_CANONICO_COMPLETO.md`](REGISTRO_CANONICO_COMPLETO.md).

---

## 5bis. ⭐⭐ AUDITORÍA DE ADOPCIÓN — quién debería leer el resolvedor, quién lo lee, quién no (2026-09-12)

Edgar: *"realiza una auditoría de quién debería estar tomando esta información, quién la está
tomando, quién no la está tomando"*. Medido contra prod, tres ejes: **código** (grep de runtime,
sin migraciones ni pruebas), **base de datos** (`pg_depend`) y **dinero** (venta 90 d del producto
afectado).

### 5bis.1 El hallazgo de fondo: el resolvedor más nuevo es el que menos se usa

| resolvedor | dependientes en la DB | consumidores en código |
|---|---:|---|
| `v_product_box_factor` (el viejo, sin veredicto) | **7** | compras · entradas · anexo de venta · salidas · importers |
| `v_product_unit_ladder` | 4 | tienda live · route-promo · pricing |
| `v_warehouse_box_factor` (ADR-055) | 4 | existencia · compras · existencia-crítica |
| `v_supplier_cost_ladder` | 3 | reabasto |
| `v_unit_truth` (ADR-057, **con testigo y método**) | 1 | sell-out · análisis |
| `v_product_box_factor_consensus` (**con veredicto**) | **0** | **sell-out, y nadie más** |
| `mv_kepler_unit_ladder` (**la medida de Kepler**, ADR-063) | **0** | **NADIE** |

⛔ **La escalera de Kepler se construyó el 2026-09-12 y no la lee ningún consumidor.** El
resolvedor de consenso tampoco tiene dependientes en la base. Ésta es la forma que toma acá el
patrón de ADR-056: *el primitivo se construye bien, se aplica a UN dominio y no se generaliza* —
sólo que en este eje ya van **siete** resolvedores y la adopción va al revés del orden de calidad.

### 5bis.2 Quién NO lo lee, y qué publica en su lugar

| superficie | qué lee hoy | medido en prod |
|---|---|---|
| ⭐ **Verificador de precios de mostrador** (`/tienda/verificador`, `kp.service.ts`) | **`kdii.c84` CRUDO** | **29 SKUs difieren** del consenso ($862,663 / 90 d) · **565 productos ($21.9M)** donde `c84` afirma un factor que el resolvedor se NIEGA a publicar (sin testigo o las plazas discrepan) · 8,740 con `c84` vacío ($60.8M) donde simplemente no dice caja |
| **Catálogo interno** (`catalogo-interno.service.ts`, 3 consultas) | `i.c84 AS pzas_bulto` | mismo defecto, **no estaba declarado en ningún lado** |
| ⭐ **Bot / conversación comercial** (`commerce-conversation.binding.module.ts:183`) | `GREATEST(COALESCE(p.factor_sale,1),1)` | le dice al **cliente** "2 paquetes (80 pzas)". El `COALESCE(...,1)` es el default silencioso que ADR-056 prohíbe: donde nadie sabe, **afirma 1** |
| **Andén / recepción** (`almacen/anden/cantidad.util.ts`) | `catalog.product_barcodes.factor` — una **octava** fuente | sólo **383 de 12,503 códigos** (378 productos) traen factor > 1; 7,469 vienen ≤ 1 y 4,651 NULL → el conteo por cajas está muerto en **97%** de los códigos y el input de cajas se deshabilita solo |
| **Caducidades** (`commercial-expiry-reviews`, `expiry-voice`) | `p.factor_sale` para "PAQ x 24" | tras VA.3 el número coincide, pero **viaja sin veredicto**: no distingue "1 porque es 1" de "1 porque nadie sabe" |
| **Catálogo de productos** (`commercial-products.service.ts`) | `p.factor_sale` | ídem |
| **Salidas** (`salidasReport` + su Excel) | cascada `v_product_box_factor` → `box_size` → `factor_sale` | usa el canónico **viejo** y cae a dos fuentes sin testigo; el consenso no participa |

### 5bis.3 Quién SÍ lo lee

`/comercial/sell-out` (UxC por `v_product_box_factor_consensus`, cajas por `v_unit_truth`) ·
`/comercial/análisis` · `/compras/existencia` · `/compras/pedido` · `/compras/existencia-crítica` ·
`/almacen/inventory/existencia` (los cuatro por `v_warehouse_box_factor`) · `/compras/entradas` ·
`/comercial/documentos` (anexo) · tienda live y promos de ruta (por `v_product_unit_ladder`).

### 5bis.4 Los ESCRITORES de `catalog.products.factor_sale` — medido, no supuesto

Se temía que el feed nocturno deshiciera lo que VA.3 escribió. **No pasa:** ningún carril agendado
escribe `factor_sale`. Los cuatro escritores que existen (`import-catalog-bulk`,
`import-wincaja-missing-products`, `mega_dulces_sync`, `backfill-factor-from-wincaja`) están
**fuera de todo carril** — `import-catalog-bulk` fue retirado explícitamente en CANON.0.2. Por eso
la foto de hoy es sana:

```text
catalog.products.factor_sale  vs  v_product_box_factor_consensus
  coinciden .................................. 8,527 productos   $131,589,436 / 90 d
  el resolvedor NO publica (sin testigo o difiere) 2,685          $ 26,376,427
  DIFIEREN ...................................       5           $    620,915
  catálogo NULL y el resolvedor sí tiene .....      22           $      5,416
```

⚠️ Los 22 NULL son **productos nuevos**: `repoint-catalog-presence` los inserta y no escribe
`factor_sale`. La ausencia entra sola.

### 5bis.5 Etiquetera

```text
commercial.product_label_prices.box_size  vs  consenso
  coinciden ....................... 7,397 productos   $113,773,092 / 90 d
  la etiquetera no tiene box_size . 3,367             $ 25,403,911
  tiene, el resolvedor NO publica .   475             $ 19,415,191
  DIFIEREN ........................     0
```

Cero contradicciones: la etiquetera **no es el problema**. Lo que aporta es cobertura donde el
resolvedor calla, y eso es una decisión a tomar, no un defecto a corregir.

---

## 6. Las trampas que ya cobraron

Todas vividas. El número entre paréntesis es lo que costaron.

0. ⛔⛔ **Que un resolvedor sea CANÓNICO no lo hace CONMENSURABLE con la cantidad que lo
   multiplica** (≈$17.1M de sugerido inflado, atajado antes de entregarlo — VA.4, 2026-09-11).

   Se estaba cableando `commercial-replenishment` al árbitro del costo (`v_erp_unit_cost`) en vez
   del catálogo. Todo el diagnóstico era correcto: el catálogo da UN costo por producto cuando el
   **86%** tiene más de uno, y prefería el BRUTO — sobre la existencia valuaba **$5,270,072
   (7.72%)** de más. Y el cambio igual estaba mal.

   El antes/después del **sugerido de compra** dio **+36.79% ($17,092,646)** en vez del −8%
   esperado. Las razones lo dijeron todo:

   ```text
   70031 CHOC EST SUIZO /16      5.40 ->    86.35   x15.99   wincaja_costo_promedio
   18022 CAJETA ENVINADA 25KG   41.34 ->  2066.93   x50.00   wincaja_costo_promedio
   70043 GOMA A GRANEL 12KG     54.37 ->   652.46   x12.00   wincaja_costo_promedio
   ```

   **Las razones SON los factores de caja, y todas las filas son de Wincaja.** El costo del árbitro
   está en la unidad NATIVA del almacén (en Wincaja, el paquete — ADR-055) y
   `commercial.reorder_policy.max_stock` está en **piezas**. Ninguno de los dos está mal: cada uno
   es correcto en su marco. **El pecado es multiplicarlos.**

   ⚠️ KE.1/KE.3 no lo sufren con el MISMO árbitro porque valúan contra
   `v_erp_stock_on_hand.qty_stock_units`, que está en esa misma unidad nativa. El reabasto
   normaliza a piezas, y ahí el árbitro deja de servir tal cual.

   ⭐ VA.3 (el factor de caja) sí se pudo cortar de un saque porque un factor es **adimensional**.
   Un costo no. Antes de apuntar un consumidor a un resolvedor, **probar la unidad en la tabla que
   ese consumidor lee** — la regla ya estaba escrita y no se aplicó: se asumió que apuntar al
   árbitro alcanzaba. Declarado en `analytics.declared_gaps`
   (`costo_arbitro_no_conmensurable_reabasto`).

1. ⛔ **`?` dentro de un `knex.raw`** → knex lo toma como binding. El repo tenía anotado que da
   `42P18`; **la variante peor no falla**: guardó `'^-$1[0-9]+(\.[0-9]+)$2…'`, no matcheó nada, y la
   vista devolvió `sin_testigo` en **16,453 filas** — que se lee igual que *"Kepler no tiene costo"*.
2. ⛔ **ANTI-RÉPLICA.** `kdm2` arrastra renglones de otras sucursales (la 03 trae 112,377 de la 02,
   $7.5M) y **`kdik` también: 3,667 de 31,084 filas** traen el costo de OTRA sucursal (**$864,270**
   de deriva en el valor arbitrado). Filtro: `sucursal = btrim(c1)`. ⚠️ Pero en `kdm2` el filtro
   plano tira los **sub-almacenes de ruta** (`01-00N`): usar `= sucursal OR LIKE sucursal||'-%'`.
3. ⛔ **Comparar dos poblaciones.** Al abrir el corte de doctypes, el candado seguía midiendo contra
   `U-D-10` solo → miles de celdas "que publicamos y Kepler no tiene", que Kepler sí tiene en otro
   doctype. **Si un lado cambia de universo, el otro también.**
4. ⛔ **Afirmar sobre el TEXTO del SQL.** Un candado exigía que la definición mencionara
   `kepler_ods.kdik`; al extraer el primitivo la vista dejó de nombrarlo y el candado se puso rojo
   solo. Preguntar al **grafo de dependencias** (`pg_rewrite` + `pg_depend`), que sobrevive a que
   alguien meta otra vista en medio.
5. ⛔ **Fijar una cifra VIVA al entero.** `confirmado === 11917` falló con 11,918: no era el código
   —con las dos definiciones lado a lado hay **cero filas con veredicto distinto**— era el shipper
   del ODS refrescando. Los pisos de datos vivos van con **banda**.
6. ⛔ **`source = 'kepler_ods'`, no `'kepler'`** (eso es `unit_source`). Filtrar por el valor
   equivocado devuelve **cero filas en silencio**.
7. ⛔ **Un candado que re-deriva por bloque se va a `statement timeout`.** Materializar **una vez**
   a temporal: 22,426 filas en 0.8 s contra seis derivaciones que no terminaban.
8. ⛔ **Correr un importer A MANO con su tarea programada viva** = te lo matan a los **13 min**
   (`kill-stale-feeds.ps1`), y el síntoma es un `FATAL 57P01` que parece de Railway. Backfill en
   **escalera** (30 → 90 → 180 → 260 d). Detalle en [`GOTCHAS.md` §38](GOTCHAS.md).
9. ⛔ **Backticks en un comentario SQL** dentro de un template literal rompen el build sin decir
   dónde. **Cinco veces** en este proyecto.
10. ⚠️ **`.env` no apunta a prod.** `DATABASE_URL_NEW` es `platform_test`; **prod es `FLEET_DB_URL`**
    (Railway). Una medición contra el destino equivocado no es una medición.
11. ⛔ **Un `GREATEST` entre fuentes que cubren VENTANAS DISTINTAS** publica el máximo donde iba la
    suma: **$808,409** del mes en que Canindo cambió de ERP (§4.6). El máximo sólo sirve entre dos
    fuentes que cubren **lo mismo**; entre eras hay que pegar por una frontera medida. Y de paso
    tapa el swap de universo: nadie ve que la fila cambió de dueño.

---

## 7. Los huecos declarados, con nombre y monto

Ninguno está escondido, y cada uno tiene un candado que se pone rojo si se vuelve un cero silencioso.

| hueco | tamaño | por qué |
|---|---|---|
| ⛔ **`U-D-8` sin árbitro de COSTO** — `irresoluble_con_la_fuente` | **$16.05M / 90 d** (16,845 renglones `sin_costo`) | Kepler **no escribe** `c62` ni `c63` ahí (~98.85% vacíos), y ése es el único testigo independiente del **costo**. ⚠️ **Corregido 2026-09-12 (ADR-063): esto vale para el COSTO, NO para la UNIDAD.** La unidad de `U-D-8` está declarada por Kepler al **99.96%** (`c9 = c56 × c58`) — se buscaba un testigo externo para un factor con el que el ERP ya calcula. Ver §14. ⚠️ La Fase R además intentó cerrar el costo con `c58 × costo_del_almacén` y es un **espejo** (§9.10); su recheck medía las **piezas** (99.87%) y no el veredicto (**1.14%**), corregido en la mig `20260911200000` |
| **`contradicho`** en ventas | 9,011 renglones / $2.17M | el costo contradice el factor declarado. Conjunto finito, enumerado |
| **`contradicho_por_factor`** en existencia | 273 filas / $2.02M | `cost_base` por bulto contra `c16` por pieza |
| ⛔ **la unidad base se contradice entre COMPRA y VENTA dentro del mismo Kepler** | ~$2.54M de inventario en disputa | `96087`: la ficha dice base = `PZA` a $10.28, la venta registra 120 `PZA` a $12.43 y la **compra** registra 180 `PAQ` a $102.764. `kdik` sigue al lado de compra y el documento de venta sigue a la ficha, así que `kdik.c16` no siempre vive en el peldaño base (**3.50% no cae en ninguno**). Sobre el inventario publicado: **71 celdas valúan $1,776,847 donde su costo estándar dice $161,625** (mediana 10.53×) + 4 en unidad tres ($32,601) + 498 sin resolver ($888,718). **No se elige un lado: se declara.** Necesita que operaciones diga cuál es la unidad real de esos SKUs. §16.5 |
| ⛔ **para el COGS de Kepler no hay ganador medido** | ~2.5% entre los dos costos | Documento y kardex se contradicen en el **40.4%** de los renglones ($983,862 / 4.00 pp). Contra un testigo de transacción quedan en **57.55% vs 40.39%**, errores medianos 2.66% y 2.48%: **ninguno es "el costo real"**. Lo único arbitrado por mecanismo son los **1,205 renglones** donde el kardex multiplica el costo del peldaño alto por la cantidad base. §16.3 · §16.4 |
| ~~la sucursal 07 no está cableada al mart~~ | **CERRADO 2026-09-10** | ✅ `md_07` (`127.0.0.1:5432/kepler_md_07`) registrado en `dim.sucursales`; el mart la consolidó y el fact la tomó **solo**. La venta publicada de Kepler sube **+2,076 celdas / +$344,505 (90 d)** y el gate quedó verde: cero celdas faltantes de la 07. ⚠️ Su historia arranca el **2026-09-08**: es lo que hay en su Kepler, no un recorte nuestro |
| celdas que Kepler tiene y el fact no (K.4 residual) | **352 celdas / $60,731** | diagnosticado 2026-09-10: de los $1,558,529 que el candado reportaba, **$917,065 era el cutover de PH** y **$248,317 la suc 00** — dos exclusiones que el importer aplica **bien** y que el candado le cobraba. Comparar universos distintos no es medir una diferencia |
| `units` que todavía transformamos | 5,835 celdas / **$1,851,531** | 3,948 ÷2 (500 g→kg) · 1,135 ×12 · 747 ×2 (**K.5**) |
| `sin_testigo` en existencia | 26 filas / $16,316 | Kepler no da costo; `valor_arbitrado` va **NULL** |
| ⭐ **existencia negativa recortada** | **1,818 filas / −68,504 u** | Kepler dice que salió sin haber entrado. Se recorta a 0 para no publicar lo imposible, pero **recortar no es explicar**. 748 SKUs sin NINGUNA entrada. Firma medida: **no es unidad** (mediana `salidas/entradas` = 1.090) — §3.1b |
| ~~el almacén `02` de la sucursal 03~~ | **CERRADO — no era hueco** | ✅ Es **réplica**, probado por identidad documental: **37,020 de 37,020** folios (`folio` + `doctype`) de suc03/alm02 existen idénticos en la sucursal 02, y está **congelada el 2026-01-07** (la 02 real llega a hoy). Publicarla sería **doble conteo de 78,633 u** en 1,771 de 2,594 celdas. El filtro está correcto — ver §9.9 |
| ⚠️ **el árbitro es promedio histórico** | −1.95% mediano vs `c18` | `c16 = c8/c5` con `c5` = entradas acumuladas. Valuamos a **costo promedio ponderado**, no de reposición (§3.4) |
| ⚠️ **62 SKUs con las columnas al revés** | 101 filas / $354,067 | `cost_with_tax < cost_base`; el fallback `cost_base` los valuaría ~10.9× arriba **si** Kepler dejara de dar `c16` (hoy ninguna cae ahí) |
| ✅ **factor de caja contradicho por el ERP** | **41 → 8 pares** ($1,395,458 → **$370,806**) | ⭐⭐ **CERRADO POR CONSTRUCCIÓN, no a mano** (Edgar: *"nada de corregir desde ui"*): un override de **1** ya no puede tapar un factor del ERP > 1, porque un `1` escrito a mano no es una afirmación — significa lo mismo que el `default`. **13 overrides tumbados, los 13 recuperaron el factor del ERP**; los 265 que valen > 1 no se tocan. De `override`: **35 → 2**. La presentación de cajas de esas celdas cae de 18,005 a **2,089** (8.6× de sobredeclaración). Mig 20260910120000, prod batch 360 |
| ✅ **lo que queda: 6 contradicciones, TODAS ambiguas** | **$189,376 · inequívocas = 0** | ⭐⭐⭐ **KX.5 cerró lo inequívoco: cero.** Se materializó el peldaño cobrado (`analytics.mv_kepler_sold_rung`, 20,560 pares, ventana 365 d, mig 20260910130000 / batch 364) y `v_warehouse_box_factor` lo usa como **piso sólo cuando el factor publicado es 1** — aplicó a **2 filas**, las 2 declaradas. Recorrido: **41 → 8 → 6** contradicciones, $1,395,458 → **$189,376**. ⛔ Las 6 que quedan son **ambiguas por naturaleza**: un peldaño mayor que la caja no prueba que la caja esté mal (una caja de 6 y un paquete de 12 conviven), así que **se declaran** — afirmar `bf = c58` ahí sería inventar |
| ⚠️ **el peldano de Wincaja es un NULL mudo** | **353,595 celdas / $86,189,728** | `sales_daily.rung_factor` NULL en el 100% de Wincaja (legitimo: no declara peldano) pero `units_unresolved` marca **64**. El 55% del ingreso de 90 d sin nada que diga "aca no se midio" |
| ✅ **el costo sólo se arbitraba en UNA pantalla** | **$71.74M → $69.49M** (−$2,251,111) | ⭐⭐ **CERRADO (KE.3, 2026-09-10)**: `analytics.v_erp_unit_cost` resuelve el costo por almacén × producto con el testigo del MISMO ERP para los DOS (Kepler `kdik.c16` 98.70% · Wincaja `costo_promedio` **100.00%**). Cinco consumidores cableados, incluido el costo que se **congela** al reconciliar un conteo (salía de `public.products`, la base legacy). Compras queda fuera **a propósito**: valoriza compra, no valuación (§12.3) |
| ✅ **la clase ABC era un objeto nulo** | **2 A / 56,002 C @ $0 → 5,178 A / 7,367 B** | ⭐⭐ **CERRADO (KE.4)**: la demanda salía de `commercial.orders` (**2 órdenes fulfilled en toda su historia**) contra $154.7M de venta real, y **clase B = 0 en todo el sistema** era el delator. Ahora sale de `inventory_health`, **la misma demanda que usa el punto de reorden**, y la clase es una **vista** porque como tabla **llegaba 26 minutos tarde todos los días**. La pantalla de compra mostraba otra clase que el motor (coincidían **64.0%**); ahora lee la misma. Frenos: medir la fuente antes de borrar + abortar si A o B salen en cero (§12.4) |
| ⏳ **el colchón que falta comprar** | **7,089 políticas / $1,197,206** | Políticas A/B todavía servidas a 0.90. No es código: se corrige cuando `import-computed-reorder` corra con la vista (nightly). El candado lo reporta `NO MEDIDO`, no verde |
| ✅ ~~**Wincaja — 37.6% de la venta**~~ | **CERRADO 2026-10-01 · hoy 0.0%** | ⭐⭐ **El hueco más grande de este documento, y no se cerró por arquitectura: la operación migró entera a Kepler.** Medido almacén por almacén (no por prefijo): Kepler $44,552,822 (**100.0%**) · Wincaja **$230 (0.0%)**; los 14 almacenes con venta tienen `kepler_code` o son rutas. Últimas migraciones: `32 → 07` (08-sep), `30 → 08` (19-sep), **CEDIS** (30-sep). ⛔ **No significa que Wincaja se pueda retirar**: es el único acceso al pasado anterior a cada corte. ⚠️ Ni cierra *«el peldaño de Wincaja es un NULL mudo»*, que vale para todo lo ya cargado — §8 |
| ⛔ **el destino de un traspaso al CEDIS no es verificable por recepción** | **15 envíos / $123,454** (180 d) | `TI000 "CENTRO DE DISTRIBUCIÓN (CEDIS)" → 00`: el almacén **existe y opera**, pero registra sus entradas como **orden de entrada** (`X-A-20`), no como recepción de traspaso (`U-A-50`) — **0 `TrsfRcv` en toda su historia**. El vínculo es plausible y **no comprobable por esa vía**. Se declara en cada corrida del candado `[DM.15]`, con su monto. **No es un dato que falte: es que el CEDIS no recibe por traspaso** |
| ⛔ **el CEDIS arrastra saldo de origen no establecido** | **5,019 SKUs / 12.18M u** · **421 días de cobertura** | Ajeno a la carga inicial del 30-sep (medido: los 127 SKUs cargados estaban **todos en cero** antes). El almacén **sí opera** —despacha 2.60M u/90 d y las 8 sucursales declaran recibir 3.22M, dos testigos del mismo orden— pero recibe **23.45M u/90 d** por la cadena de compra, que son **pasos del mismo documento** (`X-A-30→35→37→40→20`) y no se pueden sumar. **La cantidad no es absurda; el VALOR no se puede publicar**: valuarlo con `kdik.c16` da $306.9M (5× el inventario de toda la red) y esa columna ya tiene problema de peldaño documentado (§16.5). Por eso `stockMap({ cedis: true })` sigue **apagado** — `[IC.CEDIS.1]` · `[IC.CEDIS.2]` |
| ⛔ **DEUDA ERP: `ods_repl` no lee las tablas NUEVAS** | toda tabla que Kepler cree nace invisible para la replicación | ⭐ **decisión de Edgar 2026-09-12: NO se cruza la frontera del ERP para arreglarlo.** El `ALTER DEFAULT PRIVILEGES FOR ROLE sa … TO ods_repl` cerraría el goteo de raíz, pero exige `sa`/superusuario en cada POS y se optó por mantener el ERP con acceso de solo-lectura. **Consecuencia aceptada:** cada `kdc2YYMM` nueva (1 de cada mes) no replica hasta que alguien corra un `GRANT` a mano; **vuelve el 2026-10-01** con `kdc22610`. **Mitigado, no resuelto:** los importers leen el POS directo con `platform_ro` (no dependen de la replicación para esto), así que el daño se limita a `kepler_ods.kdc2*`, que **ningún objeto de `analytics.*` consume** (sólo vistas-shim `md.kdc2*`). El candado `test-ods-enrolamiento.js` lo mantiene en rojo. Causa raíz medida en `ERP_KEPLER.md` §4.2b. ✅ **Formalizada como deuda ACEPTADA 2026-09-14:** el impacto es sólo DATO — la tabla vacía SÍ se pre-crea (no hay crash; separado de la bomba de calendario, ya cerrada), sólo no fluye el dato del período nuevo hasta el GRANT. Runbook del fix listo (`ALTER DEFAULT PRIVILEGES FOR ROLE sa … TO ods_repl` por POS) para cuando se autorice tocar el ERP. Reaparece cada 1° de mes; próxima `kdc22610` el 2026-10-01 |
| ✅ **Canindo (06) sin contabilidad de septiembre** | **0 → 1,353 renglones** (CERRADO 2026-09-12) | era el único daño real del hueco anterior. Se restauró la contraseña de `platform_ro` en su POS (reset de credencial, sin otorgar permisos) y el importer pasó a leer el POS en vez de la réplica vacía. Backfill idempotente aplicado a prod |
| ⚠️ **el carril del ODS pierde filas sobre su baseline** | **536 huecos / 3 d** contra un baseline de 48–167 (umbral 50) · **14,599 sobrantes** | ⭐ medido en PROD 2026-09-12 (§13.2): `cdc_reconcile` los detecta y **los repone todos**, pero la causa del goteo no está diagnosticada. **Sobrantes caracterizados 2026-09-12** (read-only, réplicas .222:5433 vs Railway): **100% ausentes del origen** (0% falso positivo de ventana), **94% `kdpord`** (cola de surtido CREADO→AUTORIZADO→CHECADO→SURTIDO, purgada al completarse → infla la vista `analytics.erp_shipments` **22–40%** en 01/06) + **6% `kdm2` en `U-D-40` "Pedido"** (docs re-editados, hasta 58 líneas vs 8 en origen). ✅ **La venta NO se afecta**: `mv_kepler_sales_daily` filtra `U-D ∈ {8,10,12}`, excluye `U-D-40` y cancelados. Root = CDC apagado (no propaga DELETE). ✅ **Backlog kdpord LIMPIADO 2026-09-12 (OBS.11): 24,705 fantasma borrados** con `reconcile-ods-window --full --delete-sobrantes` vigilado (canario 04→completo; 07 protegida por réplica vacía; freno 60% ok), re-check final = 0 en las 8 ramas, `erp_shipments` de-inflada al origen (01: 66,059→51,317). ✅ **Durable 2026-09-14 (OBS.11, deployado):** servicio `ods-reconcile-full` (diario 03:00 MX, `--full`, **latido propio `cdc_reconcile_full`** + healthcheck + umbral 25h/30h en db-health) mantiene kdpord limpio solo — el carril continuo NO puede (su ventana 3d es ~61% fantasma → el freno la abortaría). Churn medido ~415/día. Residual chico sin automatizar: kdm2/kdij (6%, money-safe, `U-D-40` fuera de la venta). ⚠️ Anomalía: rama 00 perdió 1,023 filas del ODS por un actor EXTERNO (no la ingesta) entre medición y limpieza |
| ✅ ~~el motor de salud lleva 6 semanas apagado~~ **FALSO (corregido 2026-09-12)** | `db_health_scan`/`analytics_refresh` corren: `last_finish` hace min, `status=ok` | ⛔ Lo deduje de `last_start`, columna congelada por el bug OBS.8. **Nunca estuvieron apagados.** La pista estaba en mi propia frase: escribí *"el health_watchdog los reporta vivos"* — y el watchdog lee `last_finish`, así que tenía razón. Lo abierto de verdad es sólo el canal de salida (fila de abajo) |
| ⛔ **la alarma de salud no sale del edificio** | `health_watchdog`: *"canal externo: NINGUNO"* · `MAILER_PORT` sin SMTP (OBS.0.2) | sin `WATCHDOG_WEBHOOK_URL` ni `SMTP_*`, la única salida es la campana del tablero — inútil si lo caído es el API que muestra el tablero. Necesita config que sólo el dueño puede dar |
| ~~el ORIGEN llega tarde~~ · ~~la `07` no está en el ODS~~ · ~~`06` al 61%~~ | **RETIRADOS 2026-09-12 — eran FALSOS** | ⛔ medidos contra `platform_test` (la réplica **dev**) creyéndola prod. En prod la paridad es **Δ = 0** y la `07` está completa. Caso testigo en **§13.3** — se conserva porque el modo de falla es más instructivo que el hallazgo |
| ⚠️ **existencia fantasma en Kepler** | **132 filas** · **cota ~$3.08M (no cifra)** | `kdik` con SKU que no está en `kdii` (la `03` aporta 86 de 132). Medido 2026-09-14: `(c4+c8−c9)×c16` da una **cota de ~$3.08M**, pero `c16` es `double precision` y la unidad de existencia no está confirmada (R2) → **es cota, se declara, NO se publica como cifra**. Es una inconsistencia catálogo-vs-existencia **de Kepler**, no del ODS — §9.11 |
| ✅ **cobertura del ODS clasificada (censo 100%)** | **236 de 371** replicadas · **138 fuera clasificadas** | ⭐ **CERRADO 2026-09-14:** las 138 fuera del ODS NO son hueco de datos — **76 vacías** (0 filas en las 8 ramas: features Kepler sin usar — CRM `kdcrm*`, cotizaciones `kdv*`, promos, variantes `kdm3/4/7/9`, `kdpord2/3/4/8`, `webuser`) + **55 módulos no consumidos** (43 fiscal-CFDI `kdfe*` · 8 RH `kdrh*` · 4 POS `pos95*`) + **7 de período**. El ODS espeja las 236 que cargan dato comercial/inventario/movimientos. ⚠️ **Caducó en parte (medido 2026-09-22): la rama 01 estrenó el CRM** — `kdudp` (prospectos), el doctype `U-D-35` (cotización) y sus catálogos `kdv*` **ya tienen dato**, y `kdvcontactos` sigue **fuera** del ODS. Decode en `ERP_KEPLER.md` §3.c. *«0 filas» es una medición con fecha, no una propiedad de la tabla* |
| ✅ **bomba de calendario — margen verificado** | **~3 meses** de holgura | ⭐ **CERRADO 2026-09-14:** `kdc22610/2611/2612` ya están **pre-creadas** en los suscriptores (medido md_02/06). `ensure-monthly-tables` (vía `cdc_reconcile`) pre-crea con ~3 meses de margen, NO just-in-time → el apply-worker no se cae; `kdc22701` (2027-01) se pre-creará ~oct. Defusada mientras `cdc_reconcile` corra — `ERP_KEPLER.md` §4.2 |
| ✅ **auditoría de las bases PROPIAS — estructuralmente sana** | 617 tablas · 0 `_bak` vivos · 0 bloat | ⭐ **CERRADA 2026-09-14 (Fase BD):** censo read-only de prod `railway`. Los 6 `_bak` de F1 **ya dropeados** (purga SD, batches 394-410); `master_data_history`/`cron_run_log`/`period_close` **vivos en prod** (202,750 filas, 202,748 en 7 d — NO "solo `platform_test`"); **0 migs aplicadas-sin-archivo** (0 riesgo directory-corrupt); dedup+resolve de `db_health_alerts` **funcionan**; 0 tablas con bloat. Deuda = **operativa**, no integridad. Detalle y ruteo en [`FASE_BD`](IMPLEMENTACION/FASES/FASE_BD_AUDITORIA_BASES_PROPIAS.md) |
| ⛔ **doble linaje del hecho de venta** | `sales_daily` (3.76 GB, importer) vs `mv_kepler_sales_daily` (ODS) · ~30% de la DB en 16 objetos | el mismo hecho por dos caminos; desync ~17% (Ago tabla $21.30M vs mv $25.74M). Confirmado **vivo** 2026-09-14 (ambos con dato reciente). Lo arbitra y retira la **Fase SD** — no se re-deriva acá para no producir un número apples-to-oranges por definición de canal |
| ⛔ **respaldo de prod sin correr 2.8 d** | último `backup_prod` hace **66.8h** (critH 50h) | medido 2026-09-14: el `pg_dump` diario (host `.249`) lleva ~3 días sin correr — mismo síntoma que Wincaja (`.249` se reinicia por Windows Update). El monitor lo tiene **crítico y abierto**, pero sin canal externo nadie se entera (fila "la alarma no sale del edificio"). Ruteo **VL/OBS** |
| ✅ ~~`db_health_alerts` tiene 648 abiertas y el resolve está roto~~ **FALSO (2026-09-14)** | 648 filas, **sólo 10 abiertas** | ⛔ lo medí por `status IN ('critical','warn')` como si fuera el flag de abierto. El scanner marca resuelto con **`resolved_at`**, NO con `status` (`db-health-scanner.ts:96,149`). Correcto (`resolved_at IS NULL`): **10 abiertas, 1 por fuente, 0 fantasmas** — dedup y resolve **funcionan**. 4º rojo falso que la disciplina cazó (2 de la auditoría Kepler + éste, míos). Testigo: leer qué SIGNIFICA la columna antes de contarla |

---

## 8. Wincaja: ⭐⭐ ya sólo existe para HISTÓRICOS (2026-10-01)

> **El hueco más grande de este documento se cerró, y no por arquitectura: la operación migró
> entera a Kepler.** Declarado por Edgar el 2026-10-01 — *"wincaja ya sólo existe para
> históricos; el `.9.95` ya tiene Kepler y toda la información de Kepler CEDIS ya es la
> oficial"* — y **medido** el mismo día, almacén por almacén (no por prefijo del código, para
> no clasificar mal):
>
> | fuente | venta 30 d | % |
> |---|---|---|
> | Kepler | $44,552,822 | **100.0%** |
> | Wincaja | $230 | **0.0%** |
>
> Los **14 almacenes con venta** tienen `kepler_code` o son rutas de Kepler. Las dos últimas
> migraciones de tienda fueron `32 → 07 Morelia Madero` (2026-09-08) y `30 → 08 Morelia
> Abastos` (2026-09-19); el **CEDIS** cerró el 2026-09-30 (`[IC.CEDIS.1]`).
>
> ⛔ **Lo que esto NO significa:** que Wincaja se pueda retirar. **Sigue siendo el único acceso
> al pasado** de cada plaza antes de su corte — por eso `analytics.v_branch_erp_cutover`
> conserva `wincaja_source_branch`, que es el puente al histórico. Borrar esas filas no
> retiraría una fuente vieja: **borraría la historia**.
>
> ⚠️ Y **no cierra el hueco de la unidad**: *«el peldaño de Wincaja es un NULL mudo»* (§7) vale
> para todo lo ya cargado, que sigue siendo la mitad del histórico.

Lo que **sí** quedó medido de su lado, y ahora aplica al histórico:

- ✅ **Su identidad de existencia cuadra al 100.00% en las 21 sucursales**, error mediano 0.0000
  (`existencia_inicial + entrada − salida = existencia`).
- ✅ **Su renglón de venta trae costo**: `valor_costo` poblado en **99.98%** de 827,906 renglones.
- ✅ **Su unidad es consistente por artículo**: el costo unitario implícito es estable (max/min ≤
  1.02) en **10,780 de 14,209** pares (75.87%), mediana del spread **1.0001**, y sólo **6 pares**
  muestran la firma de mezcla de peldaño.
- ⛔ **NO declara el peldaño por renglón**: `cantidad_auxiliar` sirve en **3 filas de 9,962,920**.
  Su unidad vive en `articulos.unidad_venta` / `factor_venta`, por ARTÍCULO. ⚠️ Y
  `detalles.unidad_venta` es un **flag 0/1**, no una unidad (~17× de error si se usa como tal).
- ⛔ **`costo_promedio` NO sirve de árbitro histórico**: es el costo de HOY y Wincaja re-expresa el
  costo de ventas pasadas. Medido: valuando con él da **4.6× el árbitro**; el catálogo da **97.1%**.
  El árbitro correcto es el **costo unitario implícito en sus propias ventas**.

⚠️ Y su cantidad **no cuadra con la nuestra** en 4,044 de 30,202 filas (13.4%): 736,811 unidades
nuestras contra 895,329 suyas. Sin diagnosticar.

---

## 12. ⭐⭐ El segundo eje: el COSTO se había arbitrado en UNA sola pantalla (KE.3, 2026-09-10)

Edgar preguntó: *"ya aplicamos esto en sell-out, pedido, existencias. ¿en todas las tablas que
necesitan de la misma verdad?"*. La respuesta medida fue **no**, y el corte es limpio: **la verdad
se había aplicado en el eje de la UNIDAD y no en el del COSTO.**

Unidad (ADR-055/057): 12 consumidores leen `v_warehouse_box_factor` / `v_unit_truth`.
Costo: KE.1 arbitró la existencia y **nadie más**. El mismo inventario de 18,969 filas de Kepler:

```text
árbitro del ERP ......................... $39,456,434
cost_base    (Rentabilidad/ABC/Conteo) ... $44,943,938   +$5,487,504  (13.91%)
cost_with_tax (Compras/scanner) .......... $45,841,085   +$6,384,651  (16.18%)
```

⭐ Y la prueba de que no era teórico: `v_erp_stock_truth.valor_publicado_hoy` da **$45,841,211**,
o sea **coincide con `cost_with_tax` dentro de $126**. Las otras pantallas publicaban exactamente
el número pre-KE que la existencia ya había dejado de publicar.

### 12.1 El resolvedor único: `analytics.v_erp_unit_cost`

Grano **almacén × producto** — los mismos **191,012 pares** que `v_unit_truth`. Enumera los pares
COMPLETOS a propósito: una fila ausente llega NULL a un `LEFT JOIN` y **se lee como sana**.

| lado | testigo | cobertura |
|---|---|---|
| Kepler | `kdik.c16` vía `v_kepler_unit_cost` | 18,954 de 19,203 (**98.70%**) |
| Wincaja | `existencias.costo_promedio` vía `wincaja.v_stock` | 6,370 de 6,370 (**100.00%**) |
| sin testigo | catálogo **CEGADO** (`cost_with_tax` si es menor que `cost_base` = columnas invertidas) | declarado en `costo_source` |
| sin nada | **NULL**, jamás 0 | `sin_costo` |

⭐ **El testigo de Wincaja nadie lo había buscado**, y se midió antes de usarlo (R1 + regla de no
adivinar una fuente): la identidad interna `costo_existencia / existencia == costo_promedio` pega
en **33,974 de 34,123 (99.56%)**, y la mediana `cost_base / costo_promedio` = **0.9994** — o sea
está en la **misma unidad** que el catálogo, igual que del lado de Kepler.

### 12.2 ⛔ La trampa: el COALESCE que cruza ERPs (R1, medida en negativo)

**3,164 filas de Kepler empatan también contra un testigo de Wincaja** (mismo SKU, otra plaza). Por
eso la elección es un `CASE` sobre `erp`, **no** un `COALESCE(kepler, wincaja, catálogo)`.

Y el candado no se conforma con "cruces = 0": **ejecuta la versión ingenua y mide qué habría
contaminado** — 944,173 pares, de los cuales **5,147 con existencia = $2,016,789 valuados con el
costo del ERP equivocado**. Sin esa prueba negativa, el cero no distingue "el guard funciona" de
"el riesgo no existe" (ADR-056).

### 12.3 Lo que se cableó, y lo que NO

Cableados a `v_erp_unit_cost`: **capital parado** (sell-out) · **clase ABC** · **inventario**
(lista + caducidad) · **rentabilidad** (inventario/GMROI) · **conteo cíclico** — incluido ⭐ **el
costo que se CONGELA al reconciliar**, que era el que más importaba porque *queda escrito*, y que
salía de `public.products` (la base **legacy**).

⛔ **Compras NO se cableó, y es correcto.** `commercial-replenishment` y `replenishment-scanner`
valorizan **el sugerido de compra** — lo que se va a PAGAR — y ahí el costo correcto es
`cost_with_tax`, confirmado midiendo en U.0 (`cost_with_tax = u1_cost × (1+impuesto)`, razones
1.0000/1.0800/1.1600/1.2400 exactas sobre 6,626 SKUs). El árbitro de acá es el promedio ponderado
**histórico y neto de impuesto**: usarlo para una orden de compra respondería otra pregunta y la
subdeclararía 8–24%. El candado **asegura que sigan sin usarlo**, para que nadie lo "unifique" por
prolijidad.

Efecto: el capital publicado pasa de **$71,738,838 a $69,487,727** (**−$2,251,111**), con **99.03%**
de las filas valuadas por el testigo de su propio ERP. Migs `20260910170000` (batch 366) y
`20260910180000` (batch 367). Candado `test-newdb-unit-cost-truth.js`, 24/24.

### 12.4 ⭐⭐ La clase ABC era un objeto nulo — y llegaba tarde (KE.4, CERRADO)

Al probar el recálculo del ABC contra prod (en una transacción con rollback) apareció algo que
**no** causa este cambio y que es más grande que él:

```text
commercial.abc_classification .......... 2 filas clase A · 56,002 clase C con annual_value = $0
su fuente de venta, commercial.orders .. 34 órdenes en total · 2 fulfilled EN LA HISTORIA
la venta real, analytics.sales_daily ... 707,022 celdas / $154,674,474 en 90 días
```

O sea el ABC se calcula sobre la tabla de pedidos **de la plataforma**, que está prácticamente
vacía, mientras la venta real vive en el fact. Y **esa clase fija el nivel de servicio de RA-PRO**
(A=0.98 · B=0.95 · C/sin clase=0.90, `import-computed-reorder.js:88`), o sea el colchón de
seguridad de toda la red.

Hay **dos** ABC en el sistema y sólo uno está vivo:

| tabla | estado | quién la consume |
|---|---|---|
| `commercial.abc_classification` | **degenerada** (2 A / 56,002 C @ $0) | reabasto, scanner, pasillos, **los dos importers de reorden** |
| `analytics.product_sales_stats.abc_class` | viva y plausible (1,118 A · 1,630 B · 5,989 C) | analytics, rentabilidad, Thot |

⚠️ Y `commercial.reorder_policy` carga un snapshot **viejo e internamente inconsistente**: 6,357
políticas clase A, y **9,445 marcadas clase C con `service_level = 0.980`** — clase y nivel vienen
de corridas distintas.

#### Y un segundo defecto que sólo se ve mirando los relojes

```text
inventory_health ....  09:04:09   <- la demanda
reorder_policy ......  09:04:28   <- la CONSUME 19 segundos despues
abc_classification ..  09:30:00   <- y la clase se recalcula 26 MINUTOS mas tarde
```

O sea, **aunque la clase hubiera estado bien, el reabasto usaba la del día anterior**. Y no se
arregla moviendo un cron: el ABC necesita `inventory_health` (3:04) y el reorden necesita el ABC, y
los dos importers corren con 19 segundos de diferencia dentro de la misma cadena. *Ordenar no es
depender.*

#### Y un tercero: la pantalla mostraba OTRA clase que la que usó el motor

`commercial-replenishment` recalculaba el Pareto **al vuelo**, sobre la venta $ del **mes** y a
grano **producto**, mientras el motor usaba demanda anual × costo a grano **almacén × producto**.
Medido: coincidían en **19,053 de 29,751 = 64.0%**. El comprador veía una clase distinta a la que
dimensionó el colchón en **10,698 filas** — incluidas **261 que la pantalla llamaba C y el motor
trata como A**.

#### Lo que se aplicó

**`analytics.v_abc_class`** (mig `20260910190000` + `20260910200000`, batches 369/370) — el Pareto
**derivado**, no materializado:

- la demanda sale de **`analytics.inventory_health.avg_daily_units`**, que es **la misma que usa el
  punto de reorden**. No es una fuente mejor: es la misma. Si la clase y la σ/ADU vinieran de
  ventanas distintas, la política sería incoherente consigo misma;
- el costo sale de `v_erp_unit_cost` (§12.1), y **las dos puntas están en piezas** — eso es lo que
  hace válida la multiplicación (ADR-055);
- **es vista, y por eso no puede llegar tarde**: se calcula cuando se lee. Y además es **más
  rápida** que la tabla (582 ms contra 1,239);
- `import-computed-reorder.js` y la pantalla de compra la **leen directo**;
  `commercial.abc_classification` se puebla `SELECT * FROM` ella, así que hay **una sola
  definición**.

⭐ **`clase_motivo`** distingue las **tres** maneras de terminar en C, que antes se veían iguales:
`pareto` (42,611) · `sin_demanda` (12,690) · `sin_costo`. Importa porque la clase también fija la
cadencia del conteo cíclico (A=30 d · B=90 d · C=365 d): un CEDIS marcado C **por no vender** se
contaría una vez al año, y es el almacén con más capital de la red.

⭐ **Y el freno que faltaba.** El recompute es `DELETE` + `INSERT`. Eso está bien **salvo que la
fuente se vacíe**: ahí borra lo bueno y publica "todo es C" — que es exactamente cómo se fabricó
este objeto nulo y por qué nadie lo vio en dos meses. Ahora **se mide la fuente antes de borrar** y
se aborta, y se aborta también si la clasificación sale degenerada (**A o B en cero**). El cero de
B era el delator: un Pareto siempre produce B.

| | antes | después |
|---|---:|---:|
| clase A | 2 filas / $473 | **5,178 / $371,867,053** |
| clase B | **0** | **7,367 / $69,675,257** |
| clase C con `annual_value` = $0 | 56,002 | 12,690, **declaradas `sin_demanda`** |
| clase que ve el comprador vs la que usó el motor | 64.0% | **la misma** |

✅ **APLICADO EN PROD (2026-09-11).** El nocturno corrió con la vista y el efecto se midió:

```text
clase B ...........  0 -> 4,726 politicas   (no existia ninguna en todo el sistema)
clase A ....... 6,357 -> 9,561
politicas A/B servidas a 0.90 ... 19,127 -> 8   ($1,197,206 -> $271)
colchon publicado ............... 644,484 pz / $20,938,829
```

Las **8 que quedan ($271)** son deriva de frontera —la clase es una **vista**, así que unas pocas
filas cruzan el 80%/95% entre que el importer escribe y que uno mira— y el candado las reporta
`NO MEDIDO`, no verde.

⛔ **Y un segundo hueco que sólo se vio midiendo prod: `import-network-reorder` deshacía la
corrección.** Corre DESPUÉS en la misma cadena y sobrescribe los **hubs** leyendo todavía la tabla
degenerada: **4,589 políticas de 01 / MD-30 / 06 volvían a clase C**. La firma lo delató —
`abc_class = C` con `service_level = 0.980`, combinación que ninguna sucursal produce (el 0.98 es la
constante del hub). Descartado que fuera deriva (share 0.0147→0.9500) o falta de demanda (4,571 de
4,571 con demanda > 0). Ese importer también lee la vista ahora, y `sin_demanda` **no** se trata
como C: para el CEDIS —que no vende— se conserva el default `A` documentado en vez de publicar una C
engañosa que mandaría su conteo cíclico a una vez al año. Corrido con `--apply`: **hubs en C
degenerada = 0**, y la coincidencia política↔vista queda en **28,290 de 28,447 = 99.45%** (excluido
el CEDIS, que por diseño no se clasifica por venta).

✅ **Y la foto al día (2026-09-11, autorizado).** `commercial.abc_classification` se repobló con el
**mismo SQL del servicio desplegado** —extraído del archivo, no reescrito, para no crear una segunda
implementación— replicando sus dos frenos (medir la fuente antes de borrar, abortar si A o B salen
en cero):

```text
antes ....  2 A / 56,060 C con valor 0 y clase_motivo NULL
despues ..  5,514 A ($379,944,386) · 7,833 B ($71,224,733) · 31,974 C pareto
            + 10,075 C sin_demanda (el CEDIS) · tabla == vista 100.00%
```

⭐ **El argumento en contra —"rellenarla borra la prueba de que el deploy llegó"— era incompleto, y
la corrección importa:** no la borra, la **invierte**. En vez de *"¿se corrigió mañana?"* pasa a ser
*"¿siguió correcta?"*, y un revert es más ruidoso que una ausencia. Para que no dependa de que
alguien mire, el bloque **8bis** del candado lo vuelve compuerta: si el nocturno volviera a correr
código viejo, la tabla perdería la clase B y `clase_motivo`, y el candado se pone **rojo**.

⚠️ **Dos almacenes dan 0 A / 0 B y los dos tienen causa nombrada**: el **CEDIS `00`** no vende
(distribuye por traspaso; lo planea `import-network-reorder.js` con demanda dependiente y servicio
0.98 fijo), y la sucursal **`07`** está rezagada en `inventory_health` aunque su venta ya existe —
la cadena produce hoy 1,337 SKUs con demanda y se corrige sola. Y aun así **arranca con 3 días de
historia sobre un divisor de 90**: su ADU va subdeclarada hasta que la ventana se llene, y eso no se
corrige con código.

⚠️ **Quedan otros dos Pareto en el repo, y son legítimos**: `product_sales_stats.abc_class` (grano
producto, alimenta analytics/rentabilidad/Thot) y el `sabc` de `import-replenishment-plan.js` (elige
el **percentil** del colchón, no el nivel de servicio). El candado verifica que no se los confunda
con éste.

---

## 13. ⭐⭐ El origen: auditoría del Kepler crudo (2026-09-11)

Pedido de Edgar: *"una auditoría de la base de datos de Kepler cruda, como la usa Kepler, desde
cero"*. Censo estructural de las **8 réplicas** (`kepler_md_00..07`, schema `md`) **arbitrado contra
dos POS vivos** (`md_02`, `md_03`, sólo catálogo). El decode está en
[`ERP_KEPLER.md`](ERP_KEPLER.md) §2.4/§2.5/§3/§4; acá va lo que **arbitra** y lo que **se declara**.

> **Por qué hacía falta.** Este documento arbitra, con mucho cuidado, **lo que publicamos**. Nadie
> había arbitrado **lo que leemos**. Y ahí estaba el problema más caro: no un número mal calculado,
> sino números bien calculados **sobre un insumo viejo**.

### 13.1 Lo que Kepler garantiza, y lo que no

| | medido | qué implica para arbitrar |
|---|---|---|
| PK | **100%** de las tablas, naturales compuestas | La identidad de fila **sí** es confiable. Los joins del decode son sólidos |
| FK · UNIQUE · CHECK · triggers | **CERO**, en réplicas **y** en los dos POS | ⛔ El motor no garantiza NADA. Toda integridad es de la aplicación, y por lo tanto **hay que medirla, no suponerla** |
| `NOT NULL` | **100% de las columnas** | ⭐⭐ **Kepler no puede decir "no sé".** Usa centinelas (`''`, `0`, `1800-01-01`). **R4 al revés: la fuente disfraza el hueco por diseño** — si nosotros no lo declaramos, nadie lo hace |
| columnas muertas | `kdm1` 126/200 · `kdm2` 23/70 | Una columna 100% en cero **se lee igual que un cero legítimo**. Y **8 de `kdm1` + 4 de `kdm2` están muertas en una rama y vivas en otra**: descartar mirando una sucursal es un error medido |
| tipo del dinero | `numeric(15,2)`×464 **pero `double precision`×190** | ⚠️ **`kdik.c16`, nuestro costo de existencia canónico (§3.2, §12.1), es flotante.** No invalida el árbitro —su veredicto es por mediana de razón— pero **una suma de `c16` no es reproducible bit a bit** |

**Integridad de hecho, medida sin una sola FK** — y es buena noticia para el decode:

| relación | huérfanos | veredicto |
|---|---|---|
| `kdm2` → `kdm1` | **0 de 924,835** | ✅ la convención se cumple |
| `kdm1` → `kdmm` (doctype, 4 ejes) | **2 de 627,577** (8 ramas) | ✅ el decode de §3 es sólido |
| `kdik` → `kdii` | **132 de 33,921** | ⚠️ hueco declarado, **valor sin medir** (§7, §9.11) |

⭐ **El "0 de 924,835" es lo que valida el join, no lo que valida el dato.** Cuando probé `kdik → kdii`
por la columna equivocada, dio **100% de fallo**. Un árbitro que falla al 100% no está denunciando el
dato: está denunciando **tu hipótesis de llave**. Es R5 en su forma útil — *el espejo también se
detecta por el lado contrario: si contradice TODO, sos vos.*

### 13.2 La ruta al ODS, medida contra PRODUCCIÓN (2026-09-12)

⚠️ **Esta sección se reescribió entera.** Su primera versión afirmaba un incidente de producción
—ODS 2–7 días de atraso, fact de 16 días, sucursal 07 ausente, cinco jobs muertos— que **era falso**.
Ver §13.3.

**Estado real de prod** (`trolley.proxy.rlwy.net/railway`), medido contra las 8 réplicas:

| | medido |
|---|---|
| Paridad `kepler_ods.kdm1` vs réplicas | **Δ = 0** en 6 de 8 ramas; **−6** (suc 03) y **−3** (suc 07): filas en vuelo, lag de segundos |
| Frescura `kepler_ods` | `max(c68)` = **hoy** en las 8 ramas |
| Sucursal 07 Morelia Madero | **presente**: 9,551 productos, 2,704 existencias, 1,916 de 1,919 encabezados |
| `mv_kepler_sales_daily` | **719,644 filas**, las 7 ramas con venta al día de hoy o ayer, **la 07 incluida** |
| `analytics.cron_runs` | **35 jobs**; `ods_live_hot` y `ods_live_mirror` latiendo con 151 y 114 filas |

**La ruta al ODS está sana.** No hay incidente.

**Lo que SÍ está abierto en prod, verificado:**

| hallazgo | evidencia | por qué importa |
|---|---|---|
| ⚠️ **el carril pierde filas por encima de su baseline** | `cdc_reconcile` en **`error`**: *"ventana 3d · huecos **536** · repuestas 536 · sobrantes 14,599 · errores 0"*, umbral 50 | ⭐ **El sistema funcionó**: detectó, repuso las 536 y lo declaró. Pero el baseline conocido es **48–167 huecos/3 d** y 536 es ~3×. El reconciliador tapa el síntoma; la causa del goteo **no está diagnosticada** |
| ⚠️ **14,599 "sobrantes"** | misma nota | filas en el ODS que ya no están en el origen = **DELETE no propagado** (el ODS es UPSERT-only). Consistente con el CDC apagado |
| ✅ ~~`db_health_scan`/`analytics_refresh` muertos desde 2026-07-31~~ **FALSO — otra vez `last_start`** | `last_finish` de ambos = **hace 2 min**, `status=ok` (medido 2026-09-12 17:17) | ⛔ Lo afirmé leyendo `last_start`, la columna que el bug OBS.8 dejó congelada en 31-jul. **Los dos jobs CORREN.** El `health_watchdog` (que lee `last_finish`) siempre dijo *"scanner vivo"* — tenía razón, yo no. Es la MISMA trampa de §13.3, dentro de esta misma tabla: la columna miente, no el job |
| ⛔⛔ **el aviso no sale del edificio** | `health_watchdog`: *"canal externo: **NINGUNO**"* | Éste sí es real y sigue abierto: sin `WATCHDOG_WEBHOOK_URL` la única salida es `analytics.db_health_alerts` (la campana del tablero) — que no sirve si lo que se cayó es el propio API que muestra el tablero. Necesita una URL de webhook (Slack/Discord/Teams) que sólo el dueño puede dar |

### 13.3 ⛔⛔⛔ El caso testigo: esta auditoría midió la base equivocada

**Se conserva a propósito.** Es el ejemplo más limpio que tiene este documento de su propia tesis, y
lo produjo el proceso de auditar, no el sistema auditado.

La primera versión de §13 reportó un incidente de producción grave: ODS con 2–7 días de atraso, el
fact de ventas con **16 días**, la sucursal 07 invisible, la 06 al 61%, y **cinco jobs muertos
incluido `db_health_scan`**. Estaba escrito con cifras exactas, tablas y conteos reales.

**Todo falso.** Las mediciones salieron de `DATABASE_URL_NEW` del `.env`, que apunta a
**`192.168.0.245:5432/platform_test`** — la réplica de **desarrollo**. Producción es Railway. Lo que
se midió como "incidente" era el estado normal de una copia vieja.

**Cómo se coló, que es lo que hay que aprender:**

1. **Confié en el nombre de la variable.** `DATABASE_URL_NEW` suena a "la DB nueva" — y lo es, la de
   dev. La palabra **`platform_test` estaba en la cadena de conexión** todo el tiempo.
2. ⭐⭐ **El enmascaramiento borró la evidencia.** Para no filtrar la credencial, la inspección del
   `.env` usó `grep -oE '@[0-9.]+:[0-9]+'` — que **recorta el nombre de la base**. Se vio
   `@192.168.0.245:5432` y nunca la palabra `test`. *Ocultar el secreto ocultó también el sujeto.*
   Al enmascarar, recortá **la credencial**, nunca el destino: `sed 's#://[^@]*@#://***@#'` conserva
   host **y** base.
3. **La memoria correcta estaba a la vista y no se abrió.** `reference_prod_db_connection_topology`
   dice en su propia descripción: *"PROD newdb = trolley.proxy.rlwy.net; `.env` `DATABASE_URL_NEW`
   apunta a copia LOCAL stale"*. Se leyó el título del índice, no el archivo.
4. **La huella estaba en los números.** Esa misma memoria registró `kepler_ods.kdm1` con **595k**
   filas el 08-sep; la auditoría midió **595,433** el 11-sep. Una tabla de producción que no se mueve
   en tres días **es la firma de una copia**, y se leyó como "el carril está muerto".

> **La regla (R8):** *antes de publicar una medición, el reporte declara CONTRA QUÉ INSTANCIA se
> midió — host y nombre de base, no el nombre de la variable de entorno.* Una cifra sin esa línea no
> es verificable: es irreproducible por construcción. Y el corolario, que es el que duele:
> **un hallazgo alarmante obliga a verificar el instrumento ANTES de verificar el hallazgo.**
> Cinco carriles muertos el mismo día no era una coincidencia sospechosa del sistema —
> era el sistema diciendo *"no estás mirando donde crees"*.

⚠️ **Qué de la auditoría sí se sostiene:** todo §13.1 y el decode de `ERP_KEPLER.md` §2.4/§2.5/§3 —
porque eso se midió contra las **réplicas `:5433`** y se **arbitró contra dos POS vivos**, que sí son
la fuente correcta para preguntas de *estructura*. El error fue de instancia, no de método, y sólo
contaminó las preguntas de *estado*.

---

---

## 16. ⭐⭐ El COSTO ESTÁNDAR — cuál de los CINCO costos contesta cada pregunta (CE, 2026-09-29)

Edgar mandó la pantalla de utilidad de Kepler (`70001`, PH: *Monto sin IVA 86.00 · Costo de venta
68.21 · Ganancia 17.79*) y pidió el costo estándar *"en una interfaz aparte… podemos denotar
errores"*. Lo que destapó es que **Kepler tiene cinco costos y la pregunta decide cuál es la
verdad**. Todo medido contra PROD.

### 16.1 Los cinco, y qué contesta cada uno

| pregunta | el costo | dónde | verificado |
|---|---|---|---|
| **¿con qué costo se PUSO EL PRECIO?** | **costo de la ficha** | `kdii.c77` (base) · `c78`/`c79` | `PV = c77 × (1+margen) × (1+impuesto)` cuadra **99.24%** |
| ¿cuánto cuesta REPONER? | promedio ponderado por sucursal | `kdik.c16` | `= c8/c5` en **61.06%**, mediana **1.0000** (§3.4) |
| ¿cuál fue la última compra? | último costo | `kdik.c18` | coincide con la última entrada en 21.50% |
| ¿qué COGS registró el ERP? | costo del kardex, **extendido** | `kdij.c13` (= `c21`) | es lo que muestra la pantalla de utilidad |
| ¿cuánto le PAGUÉ al proveedor? | escalera del proveedor | `v_supplier_cost_ladder` | §5 |

⚠️ **"Costo estándar" es un nombre NUESTRO.** Kepler lo rotula simplemente *Costo* en la ficha
(*Estructura de Unidades para POS*). Se le puso así porque se comporta como tal —predeterminado,
escalón, base del precio, y su diferencia contra el real es una variación— pero **no es una
etiqueta del ERP**.

### 16.2 Qué es exactamente `c77`, medido

- **Peldaño base.** `c78`/`c79` son el mismo costo × factor (98.6% / 98.5%).
- **NETO de impuesto.** Contra la escalera del proveedor la mediana es **1.0000**, y se sostiene
  por separado en los de IEPS 8 y en los de IVA 16. Entre los SKUs con impuesto medido, **1 de
  1,883** cae en ×1.08 y **0 de 896** en ×1.16.
- **Por sucursal.** 9,641 SKUs; **1,004 (10.4%) lo tienen distinto entre plazas**.
- **Es el que el POS congela** en el renglón de venta (`kdm2.c62`).
- ⭐ **Es una función ESCALÓN, no un dato diario.** Cambia en el **1.88%** de los días
  (6,494 cambios en 344,839 observaciones día×SKU, 90 d). Entre los 10,801 pares que se venden
  seguido: **60.41% NUNCA cambió en 90 días**, 19.97% una vez, 13.33% dos o tres, 6.29% cuatro o
  más. El del kardex, en cambio, cambia el **10.11%** de los días — **5.4× más seguido**.

⭐ **De ahí sale el daño: la brecha se abre sola.** Un lado congelado y el otro subiendo con cada
compra. No es que alguien se equivoque: es que nadie vuelve a tocar la ficha.

### 16.3 ⛔ Los dos costos de venta NO coinciden, y el que publica Kepler es el otro

Sobre 336,805 renglones de ticket (`U-D-10`, 1–28 sep), cruzando por
(sucursal, almacén, SKU, folio, línea, fecha):

```text
COGS con el costo del DOCUMENTO (kdm2.c62 × c56) .... $19,155,921
COGS con el costo del KARDEX    (kdij.c13) .......... $20,139,783
brecha .............................................. $983,862 · 5.14% · 4.00 pp de margen
renglones en desacuerdo ............................. 136,161 = 40.4%
```

Y **la brecha tiene dos causas que NO se suman**:

| clase | renglones | brecha | venta | razón mediana |
|---|---|---|---|---|
| idénticos | 260,471 (77.8%) | $3,781 | $18,925,263 | 1.000 |
| deriva real | 65,808 (19.7%) | $101,761 | $4,852,720 | 1.038 |
| ⛔ **unidad: el kardex un peldaño arriba** | **1,205 (0.36%)** | **$613,646** | **$99,394** | **10.000 exacta** |
| sin explicar | 6,690 (2.0%) | $481,568 | $486,093 | 1.334 |

**Lo del 10.000 es arbitrable por MECANISMO, no por estadística.** `96087`, suc 01, folio 0014045:
vende 120 PZA = 12 PAQ a $12.43/PZA. El documento cuesta `102.76 × 12 = $1,233.12` (correcto,
$10.28/pieza); el kardex cuesta **$12,331.68 = 102.764 × 120** — *tomó el costo del PAQUETE y lo
multiplicó por la cantidad en PIEZAS*. Ahí el kardex está mal, y no hace falta un testigo.

### 16.4 ⛔⛔ Para el resto NO hay ganador — y el testigo obvio era un ESPEJO (R5 en vivo)

Primera medición: se arbitró documento contra kardex usando `v_supplier_cost_ladder.u1_cost`
(lo pactado con el proveedor). Dio **documento 90.39%** con error mediano **0.0000**. Parecía
zanjado.

**Era un espejo.** `u1_cost` y `c77` son **idénticos al centésimo en el 86.06%** de los pares: el
catálogo se captura desde la misma lista de precios del proveedor. La prueba comparaba `c77`
consigo mismo.

Rehecho con un testigo de **transacción** —el precio de la entrada real (`X-A-40`, `kdm2.c12`),
acotado a las entradas cuya unidad base coincide con la de la ficha— sobre los 921 pares en
disputa que representan 41,298 renglones:

```text
gana el DOCUMENTO .... 530 = 57.55%     error mediano 2.66%
gana el KARDEX ....... 372 = 40.39%     error mediano 2.48%
empate ................ 19 =  2.06%
```

**Empate técnico.** Ninguno de los dos es "el costo real"; los dos orbitan lo pagado con ~2.5% de
error, en direcciones distintas. ⭐ Y el árbitro **contradice a los dos** (57/40), o sea esta vez
no es espejo: R5 satisfecha.

**Qué se declara, entonces:** para el COGS de Kepler **no hay un ganador medido**. Lo que sí está
establecido es (a) que el del documento es el **costo con el que se puso el precio**, así que es el
correcto para medir *contra qué se fijó el margen*; y (b) que el del kardex está **demostrablemente
mal en 1,205 renglones** por el bug de peldaño. Elegir uno "porque sí" para publicar margen sería
inventar el 2.5% que separa a los dos.

### 16.5 La raíz: la unidad base se contradice DENTRO del mismo Kepler

`96087 KINDER DELICE CARAMELO 10P`:

- la **ficha** dice base = `PZA`, `c77` = 10.28, `f2` = 10 (PAQ), `f3` = 60 (CJA)
- la **venta** registra 120 `PZA` a $12.43 — coherente con la ficha
- la **compra** (`X-A-40`) registra **180 `PAQ` a $102.764** — o sea `c11 = PAQ`

Compra y venta no declaran la misma unidad base para el mismo SKU. `kdik` sigue al lado de compra;
el documento de venta sigue a la ficha. **No se elige un lado: se declara.** Y es lo que hace que
`kdik.c16` no siempre viva en el peldaño base — base 95.83% · unidad dos 0.60% · unidad tres 0.07%
· **no cae en ninguno 3.50%** (36,640 pares).

Sobre el inventario publicado eso son **71 celdas que valúan $1,776,847 donde su costo estándar
dice $161,625** (razón mediana 10.53×), +4 en unidad tres ($32,601) +498 sin resolver ($888,718) =
**~$2.54M en disputa de $55.8M**.

### 16.6 ⚠️ Y «Monto sin IVA» de la pantalla de Kepler trae el impuesto

Verificado contra el total del encabezado (`kdm1.c16`), 23,506 tickets: la suma de renglones cuadra
**en bruto 89.64%** y **en neto 8.66%**. En el mes, **$26,764,462 rotulados "sin IVA" contienen
$2,237,689 de impuesto** (82.74% de los renglones lo llevan). Pasa con IVA y con IEPS.

**El efecto compuesto, en un solo producto y un solo día** (`70001`, 29-sep):

| cálculo | margen |
|---|---|
| lo que publica Kepler `(86.00 − 68.21)/86.00` | **20.69%** |
| venta neta con el costo de la ficha | 16.46% |
| venta neta con el costo del kardex | 14.34% |
| **venta neta con lo que se pagó el 26-sep ($69.98/PAQ)** | **12.12%** |

**Sobredeclara 8.6 pp.**

### 16.7 Por qué `v_kepler_standard_cost` lee `kdik` directo y NO `v_erp_unit_cost`

Parece una violación de *no re-derivar un primitivo* (§5) y no lo es — el motivo es **R1 + alcance**,
y conviene dejarlo escrito para que nadie lo "unifique" por prolijidad, como advierte §12.3 para
Compras:

- el objeto auditado es **la ficha de Kepler** (`kdii`), que en Wincaja no existe. Meter el testigo
  de Wincaja para juzgar una ficha de Kepler es exactamente el `COALESCE` que §12.2 prohíbe.
- `v_erp_unit_cost` (y `v_kepler_unit_cost`) hacen `JOIN` contra `commercial.warehouses` y
  `catalog.products`, o sea están acotados a **NUESTRO** catálogo. Consumirlos dejaba **57,782 de
  86,638 filas (66.69%) sin testigo** — dos tercios del catálogo del ERP sin contraste, que es
  justamente lo que la pantalla existe para auditar.

⭐ **Y para que no puedan divergir, el candado lo cruza:** donde las dos tienen fila, el costo tiene
que coincidir. Medido contra prod: **28,443 filas comunes, 0 difieren, mediana 1.000000** contra
`v_erp_unit_cost.costo_erp`.

*Reusar un primitivo no exime de medir su ALCANCE.*

### 16.8 ⭐⭐ La META de margen: el negocio ya la tiene escrita, y no es la que publicábamos

*(PR.E0c/E0d, 2026-09-29. Disparado por Edgar: «Kepler ya maneja un margen. Ese es el margen que
tomamos como base».)*

Tenía razón, y el dato **ya estaba publicado**: `analytics.v_kepler_unit_ladder` expone
`margen1/2/3` desde `kdii.c87/c88/c89`. No hizo falta construir una fuente — hizo falta
**convertirla** y **ponderarla**, y las dos cosas tenían trampa.

**Trampa 1 — la escala.** `c87` es **markup sobre el COSTO**, no margen sobre la venta. Probado
sobre 83,949 fichas **sin usar la tasa fiscal**: el residuo `(PV/costo)/(1+m/100)` tiene que caer
en un factor fiscal conocido, y cae — **99.11%** se comporta como markup contra **5.10%** como
margen, con los residuos concentrados en **1.0800** (IEPS), **1.0000** (exento) y **1.1600** (IVA).
La conversión `margen = 100m/(100+m)` vive **sólo** en `analytics.v_kepler_margin_target`.
Control: el `70001` tiene markup 19.7070 → **16.4627**, y §16.1 ya publicaba 16.46 por otra vía.

**Trampa 2 — el peldaño, que vale 8 pp.** El margen **no es uno por SKU**: 58,027 filas donde la
base y la Unidad Dos difieren. Y la venta **no ocurre en el peldaño base**:

| peldaño | venta 90 d | meta de Kepler |
|---|---|---|
| 1 · pieza | $4,537,689 | 16.82% |
| 2 · mayoreo | $29,622,251 | 11.34% |
| 3 · mayoreo | $51,888,006 | 11.21% |

**El 94.5% de la venta es mayoreo.** Ponderar el peldaño base da **19.56%**; ponderar el peldaño
**vendido** (pareando `factor_sale` contra el `factor` de la escalera, cobertura **99.74%**) da
**11.55%**.

> ### ⭐ El árbitro: un testigo que no se toca con Kepler
> El negocio reporta un margen de **~11.5%**. La ficha de precios del ERP por un lado y el
> resultado que reporta la empresa por el otro **dan el mismo número**. Eso no valida un cálculo:
> valida una afirmación de negocio — **los precios se están fijando como la política manda**, y la
> brecha que hay que atacar no está en la meta sino en la **fuga** (1.82% de descuento sobre lista,
> 30 d, §`[PR.W1]`) y en el costo real.

⛔ **Lo que publicábamos era 15%**, y no salía de ningún lado: era la constante clavada en tres
archivos del código. Con ese número el catálogo entero se veía **bajo meta estando en meta**.

⚠️ **El veredicto de la vista responde UNA pregunta.** El primer intento mezclaba *«¿hay meta
capturada?»* con *«¿hay costo?»* y declaraba «sin meta» a **1,012 filas que sí la tienen** — les
falta el costo, que hace falta para reconstruir el **precio**, no para saber cuál es la **meta**.
Es la trampa de ADR-057, otra vez.

⚠️ **Y el gate estricto volvió a cobrar el redondeo**: comparar `margen >= markup` declaraba rotas
**72 filas** donde el empate es legítimo (con `round(...,4)`, un markup de 0.0001 da margen
0.0001). Mismo error que `[PR.W1.1]` el mismo día — *comparar dos números redondeados en órdenes
distintos*. Acá la holgura **no es tolerancia**: es reconocer que el empate existe, y se **cuenta**
en vez de tolerarse.

⭐ **El número no se clavó en un test: el test lo RE-MIDE** contra Kepler y se pone rojo si se
desvía más de 1.5 pp. Una medición con fecha es código que caduca — la Fase CDRP ya pagó una que
vivía en un `COMMENT ON TABLE` y envejeció en tres días sin que nada avisara.

## 9. Hipótesis refutadas — no las reconstruyas

Cada una se probó y **se cayó**. Están acá para que nadie pague el mismo camino.

### 9.1 ⛔ `c12` (precio base) contra `kdik.c16` como testigo de `U-D-8`

Sobre `U-D-8` se veía **perfecto**: 99.85% con testigo, mediana 1.1945, **98.90%** dentro de una
banda de margen 1.0–3.0, **cero** renglones con la firma del peldaño equivocado. Y no vale nada.
Calibrado contra el único conjunto con veredicto independiente (7 d, prod):

```
U-D-10  confirmado    n=60,107   mediana 1.3001   en banda 99.32%   firmas 0 (0.00%)
U-D-10  contradicho   n=    94   mediana 1.2114   en banda 97.87%   firmas 0 (0.00%)
```

En los 94 renglones donde el costo dice que el factor **está contradicho**, el test dice "todo bien"
con la misma fuerza que en los 60,107 confirmados. **No discrimina — es un espejo** (R5). Si se
repropone: la prueba va sobre el `contradicho` de `U-D-10` y tiene que salir **distinta** del
`confirmado`.

### 9.10 ⛔⛔ `c58 × costo_del_almacén` como sustituto del `c62` que falta en `U-D-8`

**Lo propuse yo en el plan de la Fase R, y es la misma hipótesis de §9.1 con otro traje.** §9.1 ya
había refutado un testigo de precio para `U-D-8` y había dejado escrita la receta de calibración;
el plan volvió a proponer un testigo — esta vez de costo — sin aplicarla.

El árbitro de la unidad compara dos cosas, y la segunda tiene que ser **independiente** de la
primera:

```text
factor_resuelto  = c58                     <- lo que se AFIRMA
factor_por_costo = round(c62 / u1_cost)    <- el TESTIGO
```

Sustituir el `c62` ausente por `c58 × v_erp_unit_cost.costo_unitario` deja
`round(c58 × ku / u1_cost)`: `c58` multiplicado y dividido por dos constantes. Y son **la misma
constante** — medido 2026-09-11 contra prod, sobre 24,532 pares:

```text
costo_del_almacen / costo_pagado_al_proveedor, por unidad base
  mediana 1.0000      p10 0.9999      p90 1.1016
  dentro de la banda +-15% que usa factor_por_costo:  22,868 = 93.22%
```

Con la razón pegada a 1 **dentro de la banda de tolerancia del propio árbitro**,
`round(c58 × ku / u1) = c58` por construcción. Habría marcado `confirmado` los 16,845 renglones
de `U-D-8` sin comprobar nada, y encima habría tapado las contradicciones reales donde las hubiera.

⭐ **ADR-059 queda como está**: *"`U-D-8` no es arbitrable y el límite es de la fuente"* es
correcto. Lo que estaba mal era el plan.

⚠️ Y el defecto de segundo orden, que es el que la Fase R vino a cazar: el `recheck_sql` que
sembré para este hueco preguntaba *"¿hay peldaño y hay costo?"* y respondía **99.87%**. Eso son las
**piezas**, no el **veredicto**. Un recheck que mide el insumo se lee igual que una medición y no
lo es — es el mismo defecto que un hueco que no caduca, en la dirección contraria. Corregido en la
migración `20260911200000`: el recheck mide la cobertura de `c62`, el único testigo independiente,
y el hueco pasa a `irresoluble_con_la_fuente`.

### 9.2 ⛔ `caja_sin_capturar` en Wincaja (1,286 SKUs)

Construida sobre `unidad_compra` (94.53% constante `CJA`) y `factor_compra` (1 en 15,535 de 15,535
= 100%) — campos que Wincaja **no mantiene**. Y el dinero la refutó: esos artículos se cobran como
CAJA en 95.1% (mediana 1.132), idéntico al grupo etiquetado `CJA`. **Se le creyó a una ETIQUETA por
encima del DINERO.** Retractada.

### 9.3 ⛔ `precios.margen_utilidad` como auditor interno de Wincaja

Es un **porcentaje sobre costo** (el primer test comparó una fracción contra un porcentaje — el
mismo error de unidad que la fase persigue) y **no discrimina**: 41.8% en los sanos contra 51.9% en
los defectuosos, invertido.

### 9.4 ⛔ `kdik.c5` como existencia de Kepler — **y qué ES** (cerrado 2026-09-09)

`c8/c5 = c16` cuadra aritméticamente, pero `c5` **no es el stock actual**. Dos pruebas
independientes: si lo fuera, el inventario valdría **$160,507,138** contra los $40.1M arbitrados; y
la relación de orden es perfecta (`c5 ≥` nuestra existencia en **22,094 casos y 0 al revés**), lo
que ninguna medición ruidosa produce.

⭐ **La respuesta:** `c5` son las **ENTRADAS ACUMULADAS** — idéntico a `SUM(kdil.c8)` en **25,143 de
25,143 pares (100.00%)**. Por eso `c16 = c8/c5` es un **costo promedio ponderado histórico** y no el
costo de hoy (§3.4). Dejar una refutación sin la respuesta es lo que hizo que el árbitro se leyera
mal durante una fase entera.

### 9.6 ⛔ "lo contradicho es granel / producto por peso"

NO. **279 de las 306 filas contradichas son `is_weight = false`** y cargan $2,289,685 de los
$2,680,453. El granel son **27 filas / $390,768**. Los nombres con `GRANEL` que aparecen arriba en
la lista por dinero hicieron parecer que el peso era la causa; por conteo no lo es.

### 9.7 ⛔ "la razón del error es el factor de caja declarado"

NO, y se probó contra el resolvedor canónico (`analytics.v_unit_truth`, ADR-057):

```
razón == box_factor (±5%) .......  28 de 306      mediana razón  4.18  vs  box_factor 40.0
razón == 1/box_factor ...........   1
razón == units_per_box PAGADO ...   0   <- el testigo de dinero tampoco
razón == f3 de la escalera ......   0
razón == f2 de la escalera ......  15
```

Y sólo el **15.03%** de las razones contradichas es casi-entera (`|razón − round(razón)| ≤ 0.02`).
Si fuera un factor de unidad, casi todas lo serían. **El catálogo está multiplicado por algo, pero
no por el factor de caja que el sistema declara** — y la parte que sí se explicó resultó ser otra
cosa (§3.3.2: las dos columnas en unidades distintas).

### 9.8 ⛔ "un `cost_base` compartido entre varios SKUs es la causa"

Va **al revés**: los costos **únicos** se contradicen más (2.25%) que los compartidos por >20 SKUs
(0.37%). Sí existe un caso puntual y caro —`cost_base = 60.1962` en 5 SKUs de GAMESA, **26 de 26
filas contradichas, $516,819**— pero es un caso, no una regla, y usarlo como regla habría marcado
9,656 filas sanas.

### 9.5 ⛔ "`kdik.c16` viene sucio"

Está limpio: en el ODS es `double precision` y las 31,084 filas son numéricas. Lo que parecía basura
(`4.1667e-06`) es notación científica válida — el `[^0-9.-]` con el que se midió le quitaba la `e`.
El guard correcto es de **valor** (`c16 = c16` descarta NaN, las cotas los infinitos), no de texto.

---

### 9.9 ⛔⛔ "el almacén 02 de la sucursal 03 NO es réplica" — **refuté mal, y me retracto**

En el primer pase de KX escribí que la etiqueta "réplica" del filtro `sucursal = c1` estaba
refutada, porque contra suc02/alm02 sólo el **3.66%** de las entradas acumuladas coincidía y
**1,049 SKUs iban por delante del original**. **Era falso, y el error fue de TESTIGO**: `kdil` es un
**acumulado recalculable**, así que su divergencia no dice nada sobre el origen de los datos.

El testigo fuerte estaba disponible y no lo usé — la **identidad documental**:

```text
docs de suc03 con almacén 02 ............ 37,020
el mismo (folio, doctype) en la suc 02 .. 37,020  = 100.00%   -> ES RÉPLICA
la réplica llega a 2026-01-07; la sucursal 02 real llega a hoy -> CONGELADA
```

Y publicarla costaría caro: de 2,594 celdas con existencia, **1,771 (78,633 u) tienen el SKU ya
publicado desde la sucursal 02** — doble conteo. **El filtro está correcto**, el hueco de 90,630 u
**no existe**, y el candado ahora asegura la RAZÓN (≥ 99% de folios idénticos) en vez de la etiqueta.

⚠️ **La lección va a R6:** buscar el patrón en el error es correcto, pero **el testigo tiene que ser
el más fuerte disponible**. Una identidad de folios le gana a un acumulado, y no había excusa para
no mirarla primero.

---

### 9.11 ⛔ `kdik.c8` como "valor de la existencia" — y los $83,016 que NO publiqué

Al medir la existencia fantasma (§7) tenía el conteo (**132 filas**) y quise ponerle monto. `kdik.c8`
parece valor: en la primera fila que miré, `c5`=24 × `c16`=15.89 = **381.36 = c8** exacto. Tentador.

Contra las 4,137 filas con existencia y costo: **`c8 = c5 × c16` en sólo 43.4%**, y `c8 = c6 × c16`
en 16.8%. En la segunda fila de la muestra, `c8`/`c16` da **83.1 unidades** cuando `c5`=76 y `c6`=64
— ni una ni otra. **`c8` es un valor, pero no de esa cantidad ni de ese costo.**

Iba a publicar **$83,016.43 de inventario fantasma**. El monto queda **NO MEDIDO** y el conteo se
publica solo. *Una coincidencia exacta en la primera fila es la forma más barata de comprar una
hipótesis falsa* — R2 exige la prueba de unidad sobre la población, no sobre el ejemplo.

### 9.12 ⛔ "`kdik.c1` es el producto" — el árbitro que falla al 100% te está señalando a vos

Asumí `kdik.c1 = SKU` y el anti-join contra `kdii` dio **4,213 huérfanos de 4,213 = 100%**. La
lectura ingenua era "la existencia de Kepler está rota". La correcta: **una tasa de fallo del 100%
no es un hallazgo sobre el dato, es un hallazgo sobre la hipótesis.** `kdik.c1` es el **ALMACÉN** y
el SKU es `c2` — que casa al **99.7%**.

⚠️ **Y esta confusión es invisible en 7 de las 8 ramas**, porque tienen un solo almacén cuyo código
es igual al de la sucursal. La única que la delata es la **`03`** (almacenes `01`, `02` y `03`). Un
error que sólo aparece en una sucursal se atribuye durante meses a "datos sucios de esa tienda".
`ERP_KEPLER.md` §5 regla 7 omitía `kdik` de la lista; corregido.

### 9.13 ⛔ "la publicación por lista fija pierde las tablas nuevas en silencio"

Al ver `pg_publication.puballtables = false` concluí que la publicación era una lista fija de 336
tablas y que una tabla nueva se perdería sin ruido. **Falso, y el error de método importa más que la
conclusión:** `pg_publication_tables` **expande igual** una publicación por esquema, así que los dos
casos se ven idénticos desde ahí. El desempate está en `pg_publication_namespace` — que tiene fila
para el schema `md`: es **`FOR TABLES IN SCHEMA`**, las tablas nuevas **sí** entran.

La falla real es otra y es peor: el suscriptor que no tenga la tabla mata su apply worker en ciclo
de reinicio de 5 s, **congelando la réplica entera** con la suscripción en `enabled`. Ver
`ERP_KEPLER.md` §4.2 y la fecha: **2027-01-01**.

### 9.14 ⛔⛔ "la sucursal 07 no existe para la plataforma" — y el documento tenía razón dos veces

Medí **0 filas** de la `07` en `kepler_ods` y estuve por escribir que Morelia Madero era invisible.
§7 ya tenía una fila diciendo lo contrario (*"CERRADO 2026-09-10, el gate quedó verde"*).

Primero supuse que la diferencia era de **ruta** (el mart sí, el ODS no). También era falso: en
**producción** la `07` está en `kepler_ods` con **9,551 productos y 2,704 existencias**, y en
`mv_kepler_sales_daily`. El 0 que medí era de `platform_test`, la réplica **dev** (§13.3).

⭐⭐ **La lección se cobró dos veces en el mismo hallazgo:** cuando una medición contradice una fila
ya arbitrada de este documento, la hipótesis por defecto **no** es que el documento envejeció — es
que estás midiendo otra cosa. La primera vez creí que era otra ruta. La segunda resultó ser otra
**base**. *El documento fue mejor árbitro que mi consulta, dos veces seguidas.*

### 9.15 ⛔⛔ "`RUTA-*` se cuenta dos veces en el sell-out" — y la 'corrección' habría borrado $6.46M

Una auditoría paralela (20 agentes, 2026-09-12) reportó con evidencia que `mv_sales_blended`
duplicaba **$800,821.51** de venta de ruta en dos períodos **cerrados**, y propuso el arreglo:
*"excluir los sub-almacenes de ruta de la pierna branch"*. Era la afirmación de mayor apuesta de
todo el paquete — una cifra ya publicada.

**Es falsa, y el mecanismo que lo impide está escrito:**

| pieza | medido |
|---|---|
| `mv_kepler_sales_daily` filtra `btrim(h.c1) = btrim(h.sucursal)` | los sub-almacenes quedan **fuera** de la pierna Kepler **por construcción** |
| la suc 01 vende desde `01` (41,956 docs) **y** `01-001…01-006` (1,270 docs) | los 6 sub-almacenes existen y **son 6, igual que las 6 rutas** |
| `import-sales-fact.js:53` | `ROUTE_MAP = { '01-001':'RUTA-21', … '01-006':'RUTA-28' }` |

O sea: la pierna 1 **excluye** los sub-almacenes, el importer los mapea a `RUTA-2N`, y la pierna 2
los **repone**. No hay solape posible: es un reparto deliberado, no una duplicación.

⛔ **Si alguien ejecuta el arreglo propuesto, borra $6,464,239.77 de venta real** (jul+ago 2026) de
la cifra publicada. *Una recomendación de "deduplicar" sobre un solape que no existe no deja el
número igual: lo rompe.*

⭐ **Lo que enseña sobre cómo leer una auditoría:** el hallazgo venía con conteos exactos, ruta de
archivo y línea de migración — todo verdadero por separado. Lo que faltaba era **una sola condición
del `WHERE`**. Un paquete de evidencia correcta puede sostener una conclusión falsa; por eso el
criterio no es "¿la evidencia existe?" sino **"¿probé el mecanismo que la volvería falsa?"**.

⚠️ Queda abierto, declarado y **sin medir**: si los 1,270 documentos de los sub-almacenes se
corresponden 1:1 con las filas `RUTA-2*` de `sales_daily`, o si hay un tercer feed de ruta
(`ingest.route_sales_stg` / `mart.ventas` trae `ruta_21…ruta_28` aparte). Que no haya doble conteo
**no prueba que no haya hueco**.

---

### 9.16 ⛔⛔ "Morelia Abastos se cayó del árbitro en su cutover" — cuatro hipótesis mías, las cuatro falsas

El síntoma era limpio y mentía: tres meses cuadrando al centavo ($0.00 en jun/jul/ago) y el cuarto
partido en $3,398,289.86, justo en el corte del 19-sep de esa plaza. Todo lo que se me ocurrió para
explicarlo se cayó, cada uno con una medición:

| hipótesis | por qué era razonable | cómo se cayó |
|---|---|---|
| el feed la tira por su filtro `c14` (la plaza migrada ya timbra con SU sucursal) | el filtro existe y es exactamente `c14 IN (NULL,'','00')` | **`c14` es `'00'` en los cuatro meses.** No hay una sola fila de sucursal 30 |
| la tira el filtro `BAJA/CANCELAD` de `classify()` (una migración genera bajas) | el filtro existe y el hueco nace en la migración | **tira CERO filas** en los cuatro meses |
| los asientos pasaron a vivir en otra sucursal física (`md_30`) y el feed sólo lee `md_00` | es el patrón de `[VSO.18]`, ya cobrado antes | la columna `sucursal` del ODS dice **`00` en las 38 filas** |
| es rezago global del feed nocturno | el delta es una rampa que crece hacia hoy (0 → 0 → $77k → $3.6M) | **el 94% está en UNA plaza.** Un rezago se reparte entre todas, proporcional a lo que postea cada una |

⭐ Lo que lo resolvió no fue otra hipótesis: fue **ir a la fuente y contar filas**. `md_00` tiene los
diez asientos del 19→28-sep; el ODS también; sólo faltaban en la foto de las 03:36 del árbitro.

⭐⭐ Y la lección de método: **eran dos hechos apilados bajo una etiqueta.** El TLMKT de esa plaza sí
dejó de postear el 17-sep (real, las dos fuentes coinciden) y su mostrador sólo estaba desfasado.
Sumados bajo «Morelia Abastos» producían un tercer fenómeno que no existe. Ver
[[feedback_declare_the_universe_not_just_the_number]].

⚠️ El daño real estaba en el mes que yo daba por sano: **agosto, $77,131.36** (§15.2). Un delta de
$77k al lado de uno de $3.4M se lee como redondeo — y era el único de los dos que era un defecto.

### 9.17 ⛔⛔ "el ODS no propaga los DELETE" — cierto en general, FALSO para este caso

Lo afirmé con una medición buena y una inferencia mala. La medición: agosto tenía 4 filas en el ODS
que `md_00` no tenía, `pendiente 0`, importe congelado en $77,131.36 durante cuatro días. La
inferencia: *«no se renumeraron ni se corrigieron → se borraron»*. Y encajaba con un defecto ya
documentado (el CDC muerto sin propagación de DELETE), que es justo lo que la hace peligrosa: **una
hipótesis que explica el síntoma Y coincide con un defecto conocido se siente confirmada dos veces.**

Lo que la tiró fue correr el reconciliador con la llave por día: **`kdc22608` dio 0 sobrantes.** Si
las filas hubieran sido borradas en Kepler, ahí tenían que aparecer. Mirando las 4 filas:

```
folio 25097  2026-08-27 06:00  $25,755.15  'R.V. MORELIA MADERO 01'
folio 25097  2026-08-27 00:00  $0.00       'BAJA - UD13001-0006923'
```

**No falta nada: sobra.** La fila sigue viva en Kepler, cancelada y en $0.00. El ODS conserva
además la versión previa porque `c2` está en la PK y hay **dos renderizados del mismo instante**
(+6 h hasta el 2026-09-23, `00:00` desde entonces) → un **UPDATE entra como INSERT**.

⭐ Por qué importa la distinción, y no es semántica: los dos defectos **se arreglan con herramientas
distintas y una no toca a la otra**. `--delete-sobrantes` recorre este caso y no ve nada, porque por
llave de día la fila SÍ está en el origen. Si me hubiera quedado con la primera lectura, habría
encendido el propagador de DELETE, habría visto `0 borrados`, y habría concluido que ya estaba
resuelto.

⚠️ Y el tamaño real sólo apareció después de entender la causa: no eran 4 filas sino **1,737 grupos
duplicados por $22,796,303.99** en nueve meses contables (§15.5). Buscar "borrados" no los
encontraba; buscar "duplicados por identidad de PK" sí.

### 9.18 ⛔⛔ `v_supplier_cost_ladder.u1_cost` como árbitro entre el costo del documento y el del kardex

**Refutada el 2026-09-29 (CE), después de haberla dado por buena.** La pregunta era cuál de los dos
costos de venta de Kepler —el del documento (`kdm2.c62`) o el del kardex (`kdij.c13`)— se parece a
lo que de verdad se pagó. Se usó `u1_cost` (lo pactado con el proveedor) y dio un veredicto
rotundo: **documento 90.39%, con error mediano 0.0000**.

**Es un espejo.** `u1_cost` y el costo de la ficha `c77` son **idénticos al centésimo en 8,179 de
9,504 pares = 86.06%**: el catálogo se captura desde la misma lista de precios del proveedor. La
prueba estaba comparando `c77` **consigo mismo**, y por eso el error mediano daba exactamente cero
— la firma clásica de R5.

El testigo válido es de **transacción**: el precio de la entrada real (`X-A-40`, `kdm2.c12`),
acotado a las entradas cuya unidad base coincide con la de la ficha. Con él el resultado se da
vuelta y queda en **empate técnico: documento 57.55% · kardex 40.39% · empate 2.06%**, con errores
medianos de 2.66% y 2.48%. Detalle en §16.4.

⭐ **La lección operativa:** un error mediano de **0.0000** no es una victoria del árbitro, es una
alarma. Cuando el testigo acierta perfecto, lo primero que hay que medir es si comparte insumo con
el lado que está ganando.

## 10. Cómo se verifica

| candado | qué protege | estado |
|---|---|---|
| `test-newdb-stock-truth.js` | existencia: identidad, testigo, veredicto, anti-réplica | **21/21** |
| `test-newdb-sales-line-units.js` | el renglón: invariantes, árbitro, "el precio no vota" | **38/38** |
| `test-newdb-kepler-parity.js` | lo que entregamos == lo que entrega Kepler | **8/8** |
| `test-newdb-fact-vs-kepler.js` | existencia y venta por sucursal, medianas por SKU | **21/21** |
| `test-newdb-existencia.js` | la pantalla: orden, fuente, totales | **23/23** |
| `test-newdb-unit-truth.js` | el resolvedor de unidad y su cobertura | **40/40** |
| `verify-no-transfer-leak.js` | que el traspaso no se cuele a la venta | verde |
| `test-newdb-transfer-dest-evidence.js` | el DESTINO de un traspaso: que no se le acredite a quien no es, que el almacén exista y reciba, y la identidad del pareo contra la etiqueta del ERP | **6/6 · 2 NO MEDIDOS** (`[DM.15]`) |
| `test-newdb-branch-cutover.js` | el corte Wincaja→Kepler, y que **la venta viva siga siendo 100% Kepler** — vigila la afirmación de §8 para que no caduque en silencio como caducó el 37.6% | **25/25 · 1 NO MEDIDO** (`[SB.2]`) |

Todos registrados en `database/run-all-tests.js`. **Se corren contra `FLEET_DB_URL`**, no contra el
`DATABASE_URL_NEW` del `.env`.

---

## 11. Lo que este documento no cubre

- **Wincaja HISTÓRICO** (§8). ⚠️ Su operación viva ya **no** es un hueco: desde el 2026-10-01 la
  venta de Wincaja es **0.0%** de los últimos 30 días y lo vigila `test-newdb-branch-cutover.js`
  `[SB.2]`. Lo que sigue sin cablear es su **pasado**, que es la mitad del histórico y el único
  acceso a cada plaza antes de su corte.
- **El margen.** `analytics.sales_daily.cost` tiene dos escritores y en la mitad Kepler es
  `revenue/(1+markup)`, álgebra ciega al precio. Ver ADR-051 y
  [`FASE_MR_COSTO_Y_UNIDAD`](IMPLEMENTACION/FASES/FASE_MR_COSTO_Y_UNIDAD.md).
- **La frescura.** Que un número sea correcto no dice que sea de hoy. Ver ADR-056 y
  [`FASE_VP`](IMPLEMENTACION/FASES/FASE_VP_VERDAD_Y_PROCEDENCIA.md).
- **`celdas_sin_costo_erp` todavía no se MUESTRA** en la pantalla de existencia. El backend la
  devuelve; declararla en el response **no** es declararla al usuario.

---

### Lecturas obligadas antes de multiplicar dos columnas

[`UNIDADES_DE_MEDIDA.md`](UNIDADES_DE_MEDIDA.md) · [`ERP_KEPLER.md`](ERP_KEPLER.md) ·
[`GOTCHAS.md`](GOTCHAS.md) · [`REGISTRO_CANONICO_COMPLETO.md`](REGISTRO_CANONICO_COMPLETO.md)

---

## 14. ⭐⭐ REPRODUCIR en vez de ARBITRAR — la medida que Kepler hace (VK.1, 2026-09-12 · ADR-063)

Este documento entero está construido sobre **arbitrar**: cada número tiene testigos, se ordenan,
gana uno, y lo que no se puede decidir se declara. Eso responde *"¿cuál de mis fuentes miente
menos?"*.

Edgar, 2026-09-12, tras encontrar `96504 RUFFLES QUESO 27G` con **UxC 1** cuando son **58**:

> *"El punto no es ir conciliando o parchando, es copiar su fórmula para encontrar la medida que
> ellos hacen; una vez con la medida, trabajar con todas las unidades de medida."*

Y tenía razón: **para la UNIDAD en Kepler, arbitrar era la pregunta equivocada.**

### 14.1 Kepler declara su conversión y calcula con ella

```text
c9 (cantidad BASE) = c56 (cantidad VENDIDA) x c58 (factor)     c11 = unidad base · c55 = vendida

              renglones completos    c9 = c56 x c58        %
  U-D-10           694,769             694,693         99.9891
  U-D-8             17,039              17,033         99.9648
  U-D-12             8,237               8,233         99.9514
```

⭐ **Incluye `U-D-8`.** §7 lo declaraba "no arbitrable" porque `c62` está vacío — y **la unidad
nunca dependió de `c62`**. Se buscaba un testigo EXTERNO para confirmar un factor con el que el ERP
ya calcula. El hueco de `U-D-8` es de **costo**, y sigue abierto; el de **unidad** nunca existió.

### 14.2 La medida es una ESCALERA, no un escalar

`c58` convierte la unidad **vendida** a la **base** de ese renglón — `PZA → PAQ → CJA`. El 91.9% de
los renglones vende en la base (`c58 = 1`) y el 8.1% en una unidad mayor. Leerlo como *"el factor de
caja del producto"* fue el error de fondo de §8 y siguientes.

`analytics.mv_kepler_unit_ladder`: **7,741 peldaños sobre 5,384 SKUs**, 1,962 con factor > 1, 235
ambiguos. Es **lo que Kepler hizo**, no lo que debería hacer: sin default, sin respaldo, sin
herencia. Donde nunca vendió en esa unidad **no hay fila**, y esa ausencia es información.

⚠️ **La identidad es la compuerta**: la migración aborta si baja del 99%. Sin ella no sería
reproducción sino invención.

### 14.3 El veredicto sobre lo que ya se publicaba

```text
  SKUs con piezas-por-caja en Kepler ....... 356
  coincide con lo publicado ................ 344   (96.63%)
  publicamos 1 y Kepler dice mas ...........   0
```

⭐ El resolvedor **arbitrado ya reproducía bien** la medida. Lo que fallaba era un **consumidor
leyendo otra columna** (`catalog.products.factor_sale` — corregido en VA.3).

### 14.4 ⚠⚠ Y la advertencia que se pagó tres veces la misma tarde

Tres mediciones propias, mal construidas, sobre este mismo tema:

1. *"el resolvedor difiere en 92%"* — se comparó un **escalar contra una escalera**.
2. *"14 SKUs difieren"* — se comparó contra un `mode()` que mezclaba `CJA→PZA` con `CJA→PAQ`.
3. La correcta da **96.63%**.

⭐ **Antes de publicar una discrepancia, verificar que los dos lados respondan la MISMA pregunta.**
Una discrepancia mal medida cuesta más que no medir: manda a arreglar lo que no está roto.

### 14.5 Hasta dónde llega

⛔ **Sólo Kepler.** Wincaja queda fuera por decisión de Edgar (2026-09-12). ⛔ **No compone la
escalera para publicar**: de 8 SKUs con el peldaño directo y el compuesto, 6 coinciden y **2 no**.
⛔ **Y no reemplaza todavía a `c84`** en la cascada de `v_product_box_factor` — esa es la decisión
de fondo que queda abierta (impacto medido: 12 SKUs).

Detalle en [`UNIDADES_DE_MEDIDA.md`](UNIDADES_DE_MEDIDA.md) §8octies · candado
`database/tests/test-newdb-kepler-unit-ladder.js`.


---

## 15. ⭐⭐ El ingreso contable: el árbitro tenía razón y el publicado iba alto (IG, 2026-09-29)

### 15.1 Qué arbitra a qué

`/finanzas/ingresos` publica `analytics.income_entries_src(from,to)`, que deriva la cuenta 401 de
`kepler_ods.kdc2YYMM`. Su árbitro es `analytics.sales_by_channel_monthly`, que llena
`import-sales-by-channel.js` leyendo **el Kepler vivo del CEDIS (`md_00`) por LAN**.

⛔ El candado decía que el árbitro leía «las réplicas por sucursal», y es **falso** desde que el
importer se acotó a CEDIS (su `MAP` es una sola entrada; leer las 6 duplicaba ~$62M). Importa
porque esa frase era la justificación escrita de que el árbitro no es un espejo (R5). La
independencia real nunca fue la sucursal: es **no pasar por el CDC**. Es la misma contabilidad por
otro camino, y por eso un desacuerdo localiza el defecto en vez de sólo anunciarlo.

### 15.2 ⭐ Un delta tiene DOS mecánicas, y son opuestas en qué hacer

En el total se ven idénticas. Sólo el diff **fila por fila** las separa:

| | qué es | quién está mal | qué hacer |
|---|---|---|---|
| **fantasma** | el ODS conserva filas que el ERP **ya no tiene** | el número **publicado**, va ALTO | propagar el DELETE |
| **pendiente** | el ERP las tiene y el ODS aún no | nadie | esperar un minuto |

Medido 2026-09-29 (clave `fecha‖cuenta‖naturaleza‖importe‖concepto‖folio`):

```
2026-06   ODS  750 · ERP  750 · fantasma  0 ($0.00)         · pendiente  0 ($0.00)
2026-07   ODS 1227 · ERP 1227 · fantasma  0 ($0.00)         · pendiente  0 ($0.00)
2026-08   ODS 1345 · ERP 1341 · fantasma  4 ($77,131.36)    · pendiente  0 ($0.00)   ⛔
2026-09   ODS 1464 · ERP 1482 · fantasma 13 ($333,478.28)   · pendiente 31 ($1,174,184.04)
```

⛔ **Agosto-2026: 4 pólizas (25097, 25285, 25310, 25333, todas `401-002`) por $77,131.36 que el ERP
ya no reconoce y el ODS sí.** El ingreso publicado de agosto va **$77,131.36 alto**, y el árbitro
tiene razón.

⛔⛔ **La causa NO es un DELETE sin propagar — es la PK.** Lo dije así primero y está refutado
(§9.17). `c2` está en la PK de `kdc2YYMM` y el ODS trae **dos renderizados del mismo instante**: el
poll escribía `+6 h` hasta el 2026-09-23 y `00:00` desde entonces. El UPSERT no reconoce la fila
como la misma, así que un **UPDATE de Kepler aterriza como INSERT** y conviven las dos versiones:

```
folio 25097  2026-08-27 06:00  $25,755.15  'R.V. MORELIA MADERO 01'   <- version VIEJA, la que sobra
folio 25097  2026-08-27 00:00  $0.00       'BAJA - UD13001-0006923'   <- lo que Kepler dice HOY
```

Kepler canceló esas pólizas y el ODS sigue sumando el importe anterior.

⭐ La confirmación que lo separa de un desfase: la migración `20260925150000` ya declaraba
`ago +$77,131.36` el **2026-09-25**. Cuatro días después es **el mismo importe al centavo**. Un
desfase se cierra solo; éste no se movió.

### 15.3 ⭐ Por qué el candado no lo veía, y qué cambió

`mesesCerrados()` salta **el mes en curso y el anterior** — con razón: en esos dos, el delta del
total mezcla desfase con defecto y afirmar sería inventar. Pero esa misma prudencia dejaba un
hueco nacido en septiembre invisible hasta el **1 de noviembre**, y los defectos nacen justo ahí.

El diff fila por fila rompe el empate: como distingue fantasma de pendiente, **sí puede afirmar
sobre el mes anterior**. El bloque 6 del candado cubre ahora `mesesCerrados(2) + mes anterior +
mes vivo`, afirma `fantasma = 0` en todos menos el vivo, y **nombra los folios**. Con eso agosto
salta hoy en vez del 1 de octubre.

⚠️ Y el mes vivo ya no se compara contra una foto de edad desconocida: el bloque 3 imprime la
antigüedad del árbitro (`2026-09-29 03:36 — 12.2 h`). Sin eso, un Δ de millones se lee igual que
uno de pesos.

⚠️ El diff necesita LAN a `md_00`: desde una máquina de dev **no se puede** y entonces reporta
`NO MEDIDO`, nunca ✔ por vacuidad. Corre completo desde `prod-api` en `md`.

### 15.4 Lo que NO es

⛔ **Morelia Abastos no perdió venta ni se cayó del feed.** Se veía como un corte limpio en su
cutover del 19-sep ($3.4M, 94% del hueco de septiembre) y es **desfase de una corrida**: los diez
asientos de «P.V. Morelia Abastos» del 19→28-sep están en las **dos** fuentes y sólo faltaban en
la foto de las 03:36. Aparte, su TLMKT sí dejó de postear el 17-sep — eso es real y las dos
fuentes coinciden. **Eran dos cosas apiladas; medirlas juntas producía un diagnóstico falso.**

### 15.5 ⭐⭐ El tamaño real: 1,737 grupos duplicados, $22,796,303.99

Medido el 2026-09-29 sobre las 24 tablas `kdc2YYMM` del ODS, agrupando por la PK con el día en vez
del instante:

```
kdc22601   171 grupos    $4,549,448.51        kdc22606    13 grupos      $104,298.00
kdc22602    98 grupos    $1,285,743.00        kdc22607    27 grupos      $196,865.14
kdc22603     3 grupos      $106,752.66        kdc22608 1,151 grupos   $14,089,354.83
kdc22604     7 grupos       $42,654.00        kdc22609   248 grupos    $2,331,340.85
kdc22605    19 grupos       $89,847.00
                                              TOTAL    1,737 grupos  $22,796,303.99
```

⚠️ Ese importe es el de la **copia vieja** de cada grupo, bruto y sobre todas las cuentas y ramas —
no es "inflación neta". La rodaja que toca al ingreso publicado (cuenta 401 · CEDIS · `UD1301`) son
los **$77,131.36** de agosto. El resto entra a la balanza, al P&L de Maat y a la comparación contra
ContPAQi, que leen las mismas `kdc2YYMM`.

**Qué se construyó** (`[OBS.12]`, en `reconcile-ods-window.js` — el carril que ya tiene latido,
frenos y agenda; no un script nuevo):

1. **La PK con fecha deja de estar vetada y pasa a estar VERIFICADA.** Antes se saltaba toda tabla
   con timestamp en la PK, lo que dejaba fuera justo a las contables. Ahora se mide en cada corrida
   que el origen guarda esa columna a medianoche (cero filas con hora) y que el corrimiento del ODS
   es positivo y menor a 12 h; si el supuesto no se cumple, el veto sigue. No es una constante: es
   una medición que se repite, porque *una medición con fecha es código que caduca*.
2. **`--dedupe-fecha`**, apagado por default igual que `--delete-sobrantes`. ⭐ **Cuál copia sobra lo
   decide el ORIGEN, no una regla**: se conserva aquella cuyo timestamp EXACTO está en el replica y
   se borran las otras. Si ninguna empareja, no se toca nada y se reporta (`dup_sin_original`) —
   medido: **cero** casos ambiguos. Mismo freno `ODS_DELETE_MAX_FRAC`.
3. ⛔ **El timestamp se manda como TEXTO al borrar.** El driver devuelve un `Date` de JS y
   reescribirlo aplicaría huso — que es exactamente el bug que se viene a limpiar.

Verificado en seco antes de tocar nada: el `DELETE` apunta a **una** fila (la copia de $25,755.15) y
deja viva la que Kepler reconoce ($0.00, `BAJA`). Y `faltan 0` en las dos tablas prueba que la llave
por día no produce el molino de *falta-y-sobra-la-misma-fila*.

⛔ **Lo que NO arregla:** el origen del corrimiento. Mientras `c2` esté en la PK y existan filas
históricas a `+6 h`, **cada edición futura de una fila anterior al 2026-09-23 crea un gemelo nuevo**.
El dedup es la limpieza; el arreglo de raíz es normalizar esos timestamps al mismo renderizado, y
eso es una escritura masiva que se decide aparte.

### 15.6 ⭐ Lo que se APLICÓ (2026-09-29, autorizado)

Limpieza corrida a mano sobre las 9 tablas contables con duplicados, todas las ramas:

```
                  ANTES        DESPUÉS
grupos duplicados  1,737            0
filas extra        1,737            0
ingreso ago      55,940,323.96   55,863,192.60   (el feed dice 55,863,192.60)
delta vs árbitro     77,131.36         0.00
```

El folio 25097 quedó con una sola fila, la que Kepler reconoce (`BAJA`, $0.00). Y el candado del
ingreso, contra prod, pasó de **20 ✓ / 1 ✗** a **21 ✓ / 0 ✗ / 2 ⊘**, con agosto leyendo
`ODS 1341 = ERP 1341 · fantasma 0`.

**Para que no vuelva** se agendó como carril propio (`[OBS.12]`): segunda línea en
[`ops/vl/crontab.reconcile-full`](../ops/vl/crontab.reconcile-full) a las **02:25 MX**, con latido
propio `cdc_dedupe_fecha` y su umbral en `CRON_JOBS`. ⚠️ Latido SEPARADO a propósito: dos carriles
escribiendo la misma fila de `cron_runs` ya fue un incidente acá (`ods-reconcile-chicas`,
2026-09-24) y el tablero mantenía fresco el renglón ajeno. Y el `resumen()` del script ahora suma
`dup_stale`/`dup_borrados`, porque un carril de limpieza que late "sobrantes 0" **se lee como sano
aunque el dedup nunca haya corrido**.

⚠️ **La agenda es código, todavía no corre**: el crontab se hornea en la imagen, así que entra con
el próximo deploy de `trade-ingest`. La limpieza de hoy fue manual.

⛔ **Sigue abierto el origen**: mientras `c2` esté en la PK y queden filas históricas a `+6 h`
(23,527 sólo en `kdc22608`), cada edición de una fila anterior al 2026-09-23 crea un gemelo nuevo.
El dedup lo limpia a la noche siguiente; normalizar esos timestamps a un solo renderizado es una
escritura masiva y una decisión aparte.

⛔ **Y septiembre todavía tiene 6 filas fantasma ($245,655.94)** que sí son sobrantes de verdad —
la fila ya no está en el origen. Ésas las resuelve `--delete-sobrantes`, que hoy sólo cubre
`kdpord`/`kdm2`/`kdij`. Es el mismo defecto que este documento describe en §15.2 como
`pendiente`/`fantasma`, y queda declarado.

---

## 17. ⭐⭐ La EXISTENCIA del CEDIS, y las DOS existencias de Kepler (IC.CEDIS, 2026-10-01)

Lo disparó un reporte de una línea: *"/compras/existencia no muestra las existencias en CEDIS"*.
Terminó en tres hallazgos, y el primero fue mío.

### 17.1 ⛔ La regresión: un almacén se volvió invisible al declarar su corte

`analytics.v_erp_stock_on_hand` tiene dos piernas y el almacén `00` se cayó de **las dos**:

| pierna | condición de entrada |
|---|---|
| Kepler | `w.kepler_code = k.sucursal` **`AND w.kepler_code <> '00'`** ← exclusión a mano |
| Wincaja | `w.wincaja_source_branch = v.source_branch` **`AND w.kepler_code IS NULL`** |

El `<> '00'` se escribió cuando se creía que la sucursal Kepler `00` era **OFICINAS**. Mientras el
CEDIS tenía `kepler_code` en NULL caía por Wincaja y se veía. La mig `20260930140000` le puso
`kepler_code='00'` para cerrar la compuerta de su feed — y con eso **lo sacó de una pierna sin
meterlo en la otra**. Estuvo un día entero en blanco el nodo que surte a la red, y lo encontró un
humano, no un test.

⭐ **La lección, que es general:** una condición de exclusión escrita como literal (`<> '00'`) es una
premisa **congelada**. Cuando la premisa caduca, el filtro no avisa — devuelve menos filas, que se
lee igual que "no hay". Las dos piernas de un `UNION ALL` tienen que **particionar**; acá se
solapaban en su silencio.

### 17.2 ⛔ Dos afirmaciones mías, refutadas con la medición

**(a) «El saldo del CEDIS está 35.82× inflado porque la carga se SUMÓ al saldo viejo».** Falso, y lo
sostuve tres veces. Mi consulta leía el SKU en `kdm2.c3`; el SKU es **`c8`** (`ERP_KEPLER.md`,
regla 2). Con la columna correcta, al grano SKU:

| | SKUs | `kdil` | contado | razón |
|---|---|---|---|---|
| contado **y** con saldo | **127** | 340,077 | 340,077 | **1.00×** |
| saldo **sin** conteo | 4,526 | 11,841,613 | — | — |
| contado **sin** saldo | 0 | — | — | — |

**La carga cuadra a la unidad. No hay nada que corregir en Kepler.** El 35.82× nunca fue inflación:
era **otra población** en la misma sucursal. (La compuerta `check-cedis-cutover.js` ya lo había
medido y dejado escrito, señalando que mi migración citó un diagnóstico refutado. Tenía razón.)

**(b) «La `00` de Kepler es OFICINAS y no mueve mercancía».** Falso. Medido sobre `kdm1`⋈`kdm2` de
`sucursal='00' AND c1='00'`:

| mes | docs de entrada | docs de salida | SKUs |
|---|---|---|---|
| 2026-04 | 2,371 | 713 | 2,718 |
| 2026-06 | 2,092 | 893 | 3,174 |
| 2026-08 | 2,189 | 1,568 | 2,873 |

Recibe y despacha **todos los meses desde al menos abril**. El CEDIS de Wincaja no «se mudó» a
Kepler: **se FUSIONÓ con un almacén que ya existía y ya operaba**. Excluirlo era la anomalía.

### 17.3 La decisión: publicarlo completo, no sólo lo contado

Se consideró publicar sólo los 127 SKUs con testigo físico y declarar el resto (ADR-056). **Se
descartó midiendo:** los **10 SKUs más grandes son el 9.0%** del total — está repartido entre miles,
no concentrado en basura. Un almacén que recibe 2,000 documentos al mes y cuyo volumen está
repartido es un almacén. Esconderlo deja al comprador decidiendo a ciegas sobre el nodo que surte a
la red, que es peor que publicarlo con el hueco declarado.

**Árbitro registrado:** el conteo físico del corte (`N-A-45` del 30-sep, 127 líneas) contra `kdil`,
SKU por SKU, en `database/tests/test-newdb-cedis-stock-truth.js` (**9 ✓ / 0 ✗ / 1 NO MEDIDO** contra
prod). ⚠️ **Y su límite va escrito:** desde el corte el conteo deja de ser independiente (la entrada
`N-A-30` posteó justamente lo contado). Arbitra **la identidad del corte**, no la existencia de hoy.
Decir que arbitra más sería un espejo (R5).

### 17.4 ⛔ HUECO DECLARADO: Kepler tiene DOS existencias y se contradicen en las OCHO sucursales

`kdil` (`c4+c8−c9`, **la que publicamos en todos lados**) contra `kdik.c6` (**que no consume nadie**),
mismo ERP, mismo grano (almacén × SKU), medido el 2026-10-01:

| suc | `kdil` | `kdik.c6` | razón | SKUs que difieren |
|---|---|---|---|---|
| 00 | 12,181,690 | 2,234,285 | **5.45×** | 4,990 / 5,022 |
| 01 | 717,316 | 2,524,696 | **0.28×** | 4,437 / 4,491 |
| 02 | 87,046 | 988,088 | **0.09×** | 4,220 / 4,291 |
| 03 | 226,567 | 1,936,259 | **0.12×** | 4,625 / 4,656 |
| 06 | 513,880 | 803,507 | **0.64×** | 3,547 / 3,615 |
| 08 | 618,776 | 306,972 | **2.02×** | 3,241 / 3,298 |

~99% de los SKUs difieren en **cada** rama, y la razón ni siquiera tiene un sentido consistente.
⭐ **Un testigo que contradice SIEMPRE no arbitra — es el reverso exacto de R5** («un árbitro que
nunca contradice es un espejo»). Así que `kdik.c6` **no se usa** para juzgar al CEDIS, y el candado
lo reporta **NO MEDIDO**, nunca ✔ ni ✖: no es una regresión de esta fase y no se puede cerrar sin
decidir primero **qué mide `kdik.c6`** (¿snapshot de cierre? ¿otro peldaño de unidad? ¿otro
almacén?). Está **sin verificar**, y eso es justo lo que la regla 0 de `ERP_KEPLER.md` §5 prohíbe
dar por supuesto.

⚠️ **Lo que esto implica y conviene decir en voz alta:** la existencia de las **nueve** sucursales se
publica desde `kdil` sin un segundo testigo que la respalde. No es un problema del CEDIS; es del
dato de existencia completo. Si `kdil` está mal, está mal para todas — y eso es una fase aparte, no
un motivo para dejar un almacén en blanco.

### 17.5 ⛔ La cobertura REAL del árbitro: 2.8% nominal, **0% independiente**

Medido el 2026-10-01 sobre `v_erp_stock_on_hand` del almacén `00`:

| | SKUs | unidades | valor |
|---|---|---|---|
| con testigo físico (conteo del corte) | 126 · **2.5%** | 340,067 · **2.8%** | $8,651,065 · **2.8%** |
| **sin testigo** | 4,881 · 97.5% | 11,840,389 · 97.2% | **$298,236,133** · 97.2% |

⚠️ Y ese 2.8% **tampoco es un árbitro: es un espejo**. El conteo dio **1.00× en 127 de 127** y no
podía dar otra cosa — la entrada `N-A-30` posteó exactamente lo contado. Prueba que *el documento se
capturó bien*, no que *lo contado sea lo que hay*. **La existencia del CEDIS verificada contra una
medición independiente es 0%.** (Y el ancla ya decae: 24 h después eran 126 SKUs / 340,067 u.)

**Por qué, y no es técnico:**

| sucursal | conteos físicos en toda su historia Kepler |
|---|---|
| **00 CEDIS** | **1** — el del corte, 2026-09-30 |
| 02 | 217 · 05 | 6 · 03 | 4 · 04 | 3 |
| 01 · 07 · 08 | 1 |

**El CEDIS nunca se contó.** Es el nodo menos contado de la red, el que surte a todos, y el que
publica $298M. En nuestro propio módulo de conteo tenía **cero folios**.

### 17.6 ⭐ Y estaba fuera del programa de conteo por la MISMA exclusión

La cadena es `v_erp_stock_on_hand` → `analytics.inventory_health` (nocturno 03:30) → `v_abc_class` →
`commercial.abc_classification` → `v_count_priority_score` → el plan de olas. Todo cuelga de la
vista. O sea que **nadie sacó al CEDIS del conteo a propósito**: lo sacó el mismo `<> '00'` de §17.1,
tres saltos más abajo. Arreglada la raíz, entra solo en la próxima corrida nocturna.

Se verificó eslabón por eslabón, en seco (09:27 de un jueves: ⛔ nada de escrituras pesadas a prod en
horario hábil):

1. `v_erp_stock_on_hand` → CEDIS con 5,007 SKUs, `qty > 0` ✅
2. `v_abc_class` **no filtra** por demanda: pasa todo con su `clase_motivo` ✅
3. `score_salvedad = 'sin_datos'` exige que las **tres** señales sean cero
   (`annual_value` **y** `avg_daily_units` **y** `on_hand`). El CEDIS tiene `on_hand > 0` → cae en
   **`sin_historia_de_conteo`**, y el plan filtra `IS DISTINCT FROM 'sin_datos'` → **es contable** ✅

⚠️ **Una hipótesis mía quedó refutada en el camino:** supuse que el CEDIS sería `sin_datos` porque no
vende (tiene **cero filas** en `sales_daily`, ni siquiera de traspaso — el importer excluye
`channel='mayoreo'` por ser traspaso interno, no demanda). Falso: la regla pide las tres en cero, no
una. El comentario de `20260929120000` ya describía este caso exacto —*"no hay con qué juzgarlo, y es
el único que NUNCA se contó"*— y por eso `sin_historia_de_conteo` existe como estado aparte.

⚠️ **Efecto colateral declarado:** la misma corrida nocturna le va a dar `reorder_policy` al CEDIS
(hoy tiene 0 filas), así que **el sugerido de compras va a cambiar**. Es el comportamiento que
RA-PRO.6 diseñó (demanda dependiente, `media_red = Σavg(suc) + propio`), pero nadie lo pidió hoy y se
anota para que el cambio no sorprenda.

El bloque 7 de `test-newdb-cedis-stock-truth.js` lo vigila, y **distingue dos cosas que se ven igual
y piden lo contrario**: si el nocturno aún no corrió desde el arreglo reporta **NO MEDIDO**; si corrió
**después** y el CEDIS igual no está, **FALLA**. Sin esa distinción el candado daría rojo el mismo día
del arreglo, que es como se enseña a ignorarlo.

### 17.7 ⛔⛔ EL REPORTE DEL PROPIO KEPLER TUMBA LA CIFRA — y no es un tema del CEDIS

**Lo trajo un humano, el mismo día.** Edgar sacó del ERP el *"Reporte de existencia por productos"*
(01/10/2026 09:38) con filtros `Sucursal = CEDIS`, `Almacén = ALMACÉN Cedis`, `Línea 036`. Las ~140
filas dan **0.00 en las tres unidades**. Contra lo que esta plataforma publicaba:

| SKU | descripción | publicado | Kepler |
|---|---|---|---|
| 65000 | PELON PELONAZO 4P | **3,288** | **0.00** |
| 65001 | PELON PELO RICO TAM EXH 10P | **24,192** | 0.00 |
| 65002 | PELON PELO RICO TAM BLS 12+2 | **21,600** | 0.00 |
| 95757 | HERSHEYS CHISPAS SEMI-AMARGO 2.5KG | 36 | 0.00 |

⛔ **No se puede echar la culpa al entorno.** Verificado uno por uno: la rama `00` replica
**192.168.9.95 / `md_00`** —la máquina que el CEDIS usa hoy—, la sucursal tiene **un solo almacén**
(`c1='00'`, 126,475 documentos) y la réplica está **fresca** (8 documentos de hoy).

⚠️ **Y la aritmética tampoco falla.** La reconstrucción desde documentos DA LA RAZÓN a la fórmula:
para el `65000`, `X-A-20` (aplica orden de entrada) suma **3,384** y `U-D-40` (embarque) **96** →
3,288 = exactamente `c4+c8−c9`. O sea que `c8`/`c9` son los acumulados que la doc describe. **Dos
fuentes del MISMO Kepler no coinciden, y no sabemos cuál publica el reporte.**

⭐⭐ **Lo que esto significa, y es más grande que el CEDIS:** `v_erp_stock_on_hand` usa esta misma
fórmula para las **nueve** sucursales. Si está mal, está mal en todas. Y encaja con §17.4: `kdik.c6`
—que discrepa de `kdil` en las nueve— vale **96** para el `65000`, que es exactamente `c9`. Hay al
menos **tres** lecturas posibles de la existencia en Kepler y nunca se arbitraron contra el ERP.

**Decisión: se RETIRA el CEDIS de la existencia publicada** (mig `20261001170000`, batch 653), el
mismo día que se publicó. Dos razones, las dos explícitas:

1. ⛔ **El argumento de ayer queda refutado.** Se publicó diciendo que el volumen «está repartido
   entre miles de SKUs, así que es un almacén y no un artefacto». **Estar repartido no lo hace
   real** — eso era una corazonada con forma de medición. El ERP dice cero.
2. Esa cifra ($298M) alimentaba esa misma noche `inventory_health` → ABC → `reorder_policy` → el
   **sugerido de compras**. ADR-056: lo que no se puede medir se DECLARA, no se dibuja.

⚠️ **Esto reabre el reporte original** (*"/compras/existencia no muestra el CEDIS"*) y se asume a
conciencia: **ausente y declarado le gana a presente y falso**, sobre todo alimentando compras.

⭐ **Lo que lo destraba, y es la pieza que a este documento le falta para las NUEVE ramas:** el mismo
reporte del ERP **sin el filtro de línea** y con *omitir productos en cero = Sí*. Eso contesta "qué
tiene de verdad el almacén" **según el propio Kepler**, que es el árbitro independiente de existencia
que nunca tuvimos. Corrido por sucursal, arbitra el dataset completo — no sólo el CEDIS.

⭐ **La lección de método, que ya había costado una vez en esta misma fase:** la medición que yo tenía
(*"está repartido, luego es real"*) no era un árbitro, era una **plausibilidad**. Un árbitro es una
fuente que puede decir que NO. El reporte del ERP dijo que no en la primera consulta.
