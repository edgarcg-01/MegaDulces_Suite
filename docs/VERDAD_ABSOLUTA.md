# La verdad absoluta — qué la arbitra, cuánto se sostiene, y qué se declara

> **Fuente principal de razón del sistema.** Pedido de Edgar (2026-09-08): *"necesitamos verdad
> absoluta de existencia, ventas y unidades"* · *"solo hay que enfocarnos en kepler"* ·
> *"documentemos la verdad absoluta hasta ahora, será nuestra fuente principal de razón"*.
>
> **Medido contra PROD** (Railway, tenant `mega_dulces`) el **2026-09-09 16:05 UTC**, salvo lo que
> se atribuye explícitamente a otra medición. ADR-059.

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

## 1. Las seis reglas

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

## 2. El estado, en una tabla

| dimensión | qué la arbitra | resultado | ¿verdad absoluta? |
|---|---|---|---|
| **Existencia · cantidad** | identidad `entradas − salidas = qty`, del propio `kdil` | 92.84% directo · **1,818 negativos (−68,504 u) recortados, no explicados** · el descarte por almacén **ya no es hueco**: es réplica probada (§9.9) | ⚠️ **sí, con UN hueco declarado** (§3.1b) |
| **Existencia · valor** | `kdik.c16` — costo **promedio ponderado histórico** de Kepler por sucursal × SKU | 74.5% confirmado · brecha enumerada por causa (§3.3) | ✅ **sí, con residuo enumerado** |
| **Ventas · dinero** | `c62 = u1_cost × c58` + paridad contra el renglón crudo | cobertura **98.20%** del dinero de Kepler | ✅ **sí** |
| **Unidades · ticket** | el renglón declara y el costo confirma | **95.75%** confirmado | ✅ **sí** |
| **Unidades · `U-D-8`** | — | **no arbitrable** (límite de la fuente) | ⛔ **declarada, no arbitrada** |
| **Venta de ruta de una sucursal que cambió de ERP** | la **frontera medida** entre los dos POS (último día del viejo + 1), no el máximo entre ellos | Canindo: +$728,711 en 2026 · agosto **+$808,409** que el `GREATEST` tapaba (§4.6) | ✅ **sí, con las 3 líneas de $6 del arranque declaradas** |
| **Wincaja (las tres)** | tiene árbitro propio, sin cablear | fuera de alcance por decisión | ⬜ **no empezado** |

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
| costo pagado al proveedor | `analytics.v_supplier_cost_ladder` | un peldaño fijo de la escalera |
| venta mensual por ruta | `analytics.sales_by_route_monthly` filtrando `route_code LIKE 'WIN-%'` | las series `c63` `UD100N` que hay en la misma tabla — son **cajas de mostrador**, no rutas |
| quién escribió cada llave de venta-ruta | `analytics.v_route_monthly_provenance` | suponer que el gold es el universo más fresco |

Y para **de dónde sale** cada dato: [`REGISTRO_CANONICO_COMPLETO.md`](REGISTRO_CANONICO_COMPLETO.md).

---

## 6. Las trampas que ya cobraron

Todas vividas. El número entre paréntesis es lo que costaron.

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
| **`U-D-8` sin árbitro** | **$15.3M / 90 d** (`sin_costo`) | Kepler **no escribe** `c62` ni `c63` ahí: vacíos en el **98.81%** de sus renglones, contra 99.99% en el ticket. **No es hueco nuestro** — sus 1,965 SKUs sí tienen escalera pagada |
| **`contradicho`** en ventas | 9,011 renglones / $2.17M | el costo contradice el factor declarado. Conjunto finito, enumerado |
| **`contradicho_por_factor`** en existencia | 273 filas / $2.02M | `cost_base` por bulto contra `c16` por pieza |
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
| **Wincaja** | **37.6%** de la venta de los últimos 30 d | fuera de alcance por decisión (§8) |

---

## 8. Wincaja: tiene árbitro propio, y está sin cablear

Fuera de alcance por decisión explícita de Edgar. Lo que **sí** quedó medido, para cuando se abra:

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

Todos registrados en `database/run-all-tests.js`. **Se corren contra `FLEET_DB_URL`**, no contra el
`DATABASE_URL_NEW` del `.env`.

---

## 11. Lo que este documento no cubre

- **Wincaja** (§8) — 37.6% de la venta de los últimos 30 días.
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
