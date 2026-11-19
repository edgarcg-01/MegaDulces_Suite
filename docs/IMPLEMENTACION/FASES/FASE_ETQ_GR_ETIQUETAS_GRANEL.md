# RE.ETQ — Etiquetas de caja en la TSC TE200 (dentro de Recepción, fase RE)

```
OBJETIVO: que el almacén imprima desde la Suite la etiqueta de caja que hoy sale de Kepler
          (Operación › Compras › Órdenes de entrada › «Imprimir Etiquetas»), sin teclear nada,
          con un código que el handheld lea y con un registro de lo impreso.
MÉTRICA:  cajas recibidas por orden de entrada X-A-40 que quedan etiquetadas desde la Suite
          — HOY: 0 de 86,155 cajas/mes (2026-10-06 → 11-04, medido 2026-11-05; Suc 08: 16,257).
            Las 86,155 se etiquetan en Kepler con una barra que no se lee y sin registro.
          → META: Suc 08 etiqueta desde la Suite el 100 % de sus cajas durante 2 semanas, con
            0 etiquetas ilegibles reportadas, medido con la bitácora (RE.ETQ.2.3).
CAPA TOPE: C3
ÁREA:      Logística (almacén)
DUEÑO:     (por asignar)
ESTADO:    🚀 en prod desde el 2026-11-19 (PR #571; migraciones batch 1215–1217; permiso a 21 personas). Sin prueba física (3.5) ni medición del controlador (0.3)
```

Requerimientos para revisión: [`REQ_ETQ_GR_ETIQUETAS_CAJA.md`](REQ_ETQ_GR_ETIQUETAS_CAJA.md). Tarjeta
«ETQ-GR» en el Tablero PM. Los nombres de archivo conservan «ETQ_GR» (propuesta del 2026-11-05);
los items se llaman **`RE.ETQ.*`** desde D1.

---

## 1. Decisiones (respondidas el 2026-11-17)

| # | Pregunta | Respuesta | Consecuencia en el plan |
|---|---|---|---|
| D1 | ¿Fase propia o dentro de RE? | **Dentro de Recepción (RE)** | Items `RE.ETQ.*`; no suma una fase al cupo |
| D2 | ¿De dónde sale cuántas etiquetas? | **De la orden de entrada** (`X-A-40`) | Nada se teclea. La reimpresión también parte de la orden (RE.ETQ.3.3) |
| D3 | ¿Controlador de Windows o TSPL? | **Las dos** | Vía A navegador + controlador (la de GP.4) · vía B TSPL con contador de la impresora (RE.ETQ.1.6) |
| D4 | ¿Bitácora de impresiones? | **Sí** | Tabla propia; el endpoint escribe y exige prueba contra base real (regla 13) |
| D5 | ¿`70106` o `C70106`? | **`C` cuando sea caja** | Caja = `C`+clave siempre, aunque Kepler no lo tenga en `c85` (RE.ETQ.1.4) |
| D6 | ¿Fecha del vale o de la orden? | **Ninguna: el día en que se imprime la etiqueta**, porque el vale o la orden pueden quedar pendientes | La fecha deja de salir de Kepler (RE.ETQ.0.4) y la calcula el servidor al imprimir (RE.ETQ.2.3) |
| — | Medir el rollo y el controlador | **Se mide al implementar** | RE.ETQ.0.3 queda para el arranque de C3 |

**Cómo se aplica D6** (decisiones de diseño, 2026-11-17):
- **El día de la *primera* impresión** de esa etiqueta, en hora de la Ciudad de México y con el
  reloj del **servidor**, no el de la PC. Una etiqueta impresa a las 23:30 del 17-nov dice
  `320-26`, no `321-26`.
- **La reimpresión repite la fecha guardada.** Si la tomara del día en que se reimprime, la Suite
  repetiría el defecto 4 de Kepler: la etiqueta de reemplazo no coincidiría con sus hermanas.
- **La bitácora guarda también las fechas del vale y de la orden.** No se imprimen, pero miden el
  atraso entre la llegada y la etiqueta, que hoy nadie ve (§6).

---

## 2. Análisis (medido 2026-11-17 contra `pg-prod`, `system_identifier` 7688376744939610156)

### 2.1 Cómo se trabaja hoy

```
Llega el camión → VALE DE ENTRADA X-A-37 (cotejo en Kepler)
               → ORDEN DE ENTRADA X-A-40 (88 % el mismo día del vale; 12 % uno o más días después)
               → «Imprimir Etiquetas»: TODAS las cajas de TODOS los renglones, de una vez, en la TSC
               → se pegan en las cajas → el código no se lee: nadie puede escanear la caja
               → si una etiqueta se daña: Consulta → reimprimir la orden ENTERA, con datos falsos
               → no queda registro de qué se imprimió
```

| Medición | Valor | Cómo |
|---|---|---|
| Cajas por orden de entrada, 30 días | 86,155 en 6,353 renglones | `kdm2` `X-A-40`, `c55` ∈ CJA/BTO, `c9/c58` |
| Cajas por día (promedio · máximo) | Suc 00: 1,897 · **4,417** — Suc 08: 675 · 1,801 — Suc 01: 405 · 1,188 | por `c32`, 2026-10-06 → 11-04 |
| Órdenes por día | Suc 00: 9.5 · Suc 08: 6.9 · Suc 01: 4.8 | ídem |
| Orden capturada después del vale | **200 de 1,663 (12 %)**; 121 al día siguiente, 79 a 2+ días, máximo 20 | `kdm1.c68` de `X-A-40` contra el de su vale (`c39`), oct–nov |
| Frescura del ODS | la última orden de Suc 01, capturada a las 18:23, ya estaba en el ODS a las 18:26 | `max(c68+c69)` leído a las 18:26 del 2026-11-17 |
| Andén de Entrada de la Suite (`/almacen/anden`) | **38 sesiones en total, la última el 2026-10-07, 0 en 30 días** | `commercial.receiving_sessions` |

⭐ **La recepción hoy ocurre sólo en Kepler.** El Andén existe pero no se adoptó. Por eso este
módulo **no se cuelga del Andén**: se para solo, sobre la orden de entrada que el almacén ya
captura. Si el Andén se adopta después, consume la misma pieza de impresión (RE.ETQ.1.1).

### 2.2 Qué hace mal Kepler (lo que la Suite no repite)

| # | Defecto | Evidencia | La Suite |
|---|---|---|---|
| 1 | La barra no se lee | Code 39 de 90 módulos (`*70106*` = 360 px) metido en ~2 cm: ~1.7 puntos de 203 dpi por barra delgada | Code 128, 2 puntos por módulo, ancho calculado (RE.ETQ.1.2) |
| 2 | La barra no dice que es caja | lleva `70106`: el lector de la Suite lo toma como 1 pieza | `C70106` en caja (D5) |
| 3 | Reimprimir da UXC 1 | `Producto()` hace `setX(1,…,"fac")` y la consulta no lo recalcula | la reimpresión sale de la bitácora: mismos datos congelados (RE.ETQ.2.3) |
| 4 | Reimprimir cambia la fecha | toma `k_fecha` = fecha del documento (306) y no la de captura (308) | ídem |
| 5 | Todo o nada | `rep_etiq` recorre todos los renglones; para una etiqueta dañada se reimprime la orden entera | elegir renglón y consecutivos (RE.ETQ.3.3) |
| 6 | La caja incompleta no lleva etiqueta | el ciclo `n<=qx` con 0.5 cajas imprime 0; 7 renglones así en 30 días | la última etiqueta dice las piezas sueltas (RE.ETQ.1.5) |
| 7 | Nombre cortado a 24 caracteres | 2,823 de 3,400 productos recibidos en caja se cortan; **226 quedan iguales a otro producto** (p. ej. `CAJETA ENVINADA TOPPER 1` = 1 KG y 1/2 KG) | nombre completo en dos renglones (RE.ETQ.1.2) |
| 8 | Pie cortado en la 2.ª y 3.ª etiqueta de la fila | espécimen del 70106 | las tres etiquetas iguales |
| 9 | La fecha sale de un documento que puede quedar pendiente | 12 % de las órdenes se capturan 1 a 20 días después del vale; espécimen: vale 4-nov, etiqueta 5-nov | D6: el día de la primera impresión, guardado en la bitácora |
| 10 | No hay registro | ninguna tabla guarda impresiones | bitácora (D4) |
| 11 | La calibración es a mano | comentarios en `MD_OE`: «si me paso de 9.6 … me quitó la licencia» | página fija y medida (RE.ETQ.0.3) |
| 12 | Tres formas distintas para lo mismo | Órdenes de entrada, Granel y Generales: formatos, fecha y código distintos | una pieza, una plantilla |

### 2.3 Lo que estaba mal en nuestro propio plan (versión del 2026-11-05)

| # | El plan decía | La medición dice | Corrección |
|---|---|---|---|
| 1 | UXC = `kdii.c84` | **1,672 de 4,278 renglones en caja (39 %) tienen `c84` = 0** en el catálogo; 42 más traen otro factor (p. ej. ZUKO 8S: renglón 96, catálogo 12) | UXC = **`kdm2.c58` del renglón**, el factor con que entró esa caja |
| 2 | Barra = `kdii.c85` | **896 de 2,062 productos recibidos en caja (43 %) tienen `c85` vacío** | `C`+clave construido de `c1` (D5). El resolver de la Suite ya lo acepta (`kdii-lectura.ts`, `'C' \|\| c1`) |
| 3 | «Sin `c85` no se imprime barra» (RF-08) | contradecía D5 y dejaba sin barra al 43 % | se imprime `C`+clave; la pantalla avisa que **Kepler** no lo reconoce si su `c85` está vacío |
| 4 | Nombre a 24, como Kepler | 226 productos indistinguibles | nombre completo |
| 5 | Modo manual tecleado | D2: todo sale de la orden; teclear deja entrar errores | reimpresión desde la orden y la bitácora |
| 6 | Un solo trabajo de impresión del navegador | Suc 00 llega a 4,417 cajas en un día = 1,473 páginas con una barra SVG cada etiqueta | lotes por orden en la vía A; volumen grande por la vía B (TSPL con contador) |
| 7 | Prueba «2026-11-04 → 308» y «31-dic bisiesto → 366» | la cuenta de Kepler empieza en 0: 308 = **5-nov**; 31-dic bisiesto = **365** | pruebas corregidas (RE.ETQ.1.3) |

### 2.4 Valor agregado y automatización

**Automatizar bien = que el sistema prepare y controle, y la persona apriete un botón.** No se
imprime solo: la impresora puede estar sin rollo y las cajas pueden no estar ahí.

1. **Cola automática.** Cada orden de entrada aparece sola en la pantalla en minutos (el ODS ya
   las trae, §2.1) con su estado: *por etiquetar · impresa · reimpresa*. Cero tecleo.
2. **Un clic por orden.** Cajas, UXC, fecha y código ya calculados.
3. **Datos congelados.** La primera impresión guarda lo que se imprimió, fecha incluida (D6); toda
   reimpresión sale igual (mata los defectos 3 y 4).
4. **Control.** Aviso de órdenes con más de N horas sin etiquetar, y la métrica diaria «cajas
   etiquetadas / cajas recibidas» por sucursal. Hoy no se sabe si se etiquetó lo recibido.
5. **La barra se vuelve útil.** `C`+clave legible permite escanear la caja en el checado (GP),
   en los conteos (IC) y en el surtido. Hoy la etiqueta es decorativa.
6. **Calidad del catálogo como subproducto.** La pantalla lista para Compras los productos
   recibidos en caja con **factor 0 en Kepler** (1,672 renglones) y con **`c85` vacío** (896
   productos), que sus pantallas no reconocen. La Suite no escribe en Kepler: se arregla allá.
7. **Volumen.** La vía B (TSPL) manda una plantilla por renglón y deja que la impresora numere
   (`1:20 … 20:20`), en lugar de 20 etiquetas dibujadas: es la que aguanta los 4,417 de un día de
   Suc 00.

---

## 3. Lo que la Suite ya tiene (no se reinventa — ADR-056)

| Pieza | Dónde | Estado |
|---|---|---|
| Impresión a la TSC TE200 por el controlador de Windows (hoja = 1 fila de 3, 100 × 48 mm), `printIsolated` + JsBarcode CODE128 | `apps/view/src/app/modules/almacen/checado-etiquetas.ts` (GP.4) | 🧪 — nunca probada en la TSC real (FASE_GP §9.6.1) |
| Resolver un código escaneado, incluido `C`+clave sin `c85` | `libs/commercial/src/lib/shared/kdii-lectura.ts` (`kdiiPorCodigo`) | en prod |
| Renglones de orden de entrada | `kepler_ods.kdm2` `X-A-40`: `c8` SKU, `c9` pzas, `c55` unidad, `c58` pzas por empaque | ODS vivo |
| Fecha y hora de captura de la orden | `kepler_ods.kdm1.c68` + `c69` | ODS vivo |
| Andén de Entrada | `/almacen/anden` (WMS-REC.7) | en prod, sin uso desde el 2026-10-07 |

---

## 4. Especificación de la etiqueta (forma vigente `MD_OE` + mejoras)

| Campo | Ejemplo (70106, Suc 08) | Fuente en la Suite |
|---|---|---|
| Logo | Mega Dulces de los Altos | fijo |
| Clave | 70106 | `kdii.c1` |
| Código de barras | `C70106` en Code 128 | caja: `'C' \|\| c1`; otra unidad: el código de esa unidad (ver RE.ETQ.1.4) |
| Consecutivo | 1:20 … 20:20 | cajas del renglón; la caja incompleta lleva sus piezas |
| UXC | 18 | `kdm2.c58` del renglón |
| Fecha | 308-26 | días desde el 1-ene **contando el 1-ene como 0**, sin ceros a la izquierda, año a 2 dígitos (como Kepler). Fuente (D6): **el día de la primera impresión**, hora de la Ciudad de México; la reimpresión repite la guardada |
| Nombre | LA ROSA BOTA GRANDE 418GR | `kdii.c2` completo, en dos renglones |
| Pie | Suc 08 Sucursal Morelia Abastos | clave + nombre de la sucursal |
| ~~Encabezado de licencia~~ | ~~LUIS FRANCISCO LOPEZ GUTIERREZ · www.ERPkepler.com~~ | no se imprime: lo agrega el motor de Kepler |

Rollo: 3 etiquetas de 30 × 49 mm a lo ancho (Kepler: `size=11,4.8cm` apaisado, 3 mm de separación),
térmica directa a 203 dpi, texto girado 90°, numeración a lo ancho. Se confirma al implementar
(RE.ETQ.0.3).

---

## 5. Las capas

### C0 · Dato
| # | Item | Estado | Verificado contra |
|---|---|---|---|
| RE.ETQ.0.1 | Formas vigentes de Kepler leídas: Órdenes de entrada (`MD_OE` + `Md_etiq_OE_fto`, la del espécimen), vale (`MD_oc`, no imprime), Granel y Generales | ✅ 2026-11-05 | `MD_OE.rep_etiq` reproduce el 70106 campo por campo |
| RE.ETQ.0.2 | Vista `derive-no-copy` **`analytics.v_box_label_lines`**: una fila por renglón de `X-A-40` con sucursal, folio, renglón, fecha y hora de captura (`c68`+`c69`), fecha y vale de origen (`c39`; no se imprimen, D6: van a la cola y a la bitácora), SKU, nombre completo, unidad (`c55`), **UXC = `c58`**, cajas completas, piezas sueltas, código de caja `'C'\|\|c1`, y dos banderas: `kepler_sin_c85` y `catalogo_factor_0` | ✅ 2026-11-19 (#571): en prod (batch 1215) | Σ cajas de 30 días por sucursal = la medición de §2.1; el 70106 de la orden `0000474` da 20 cajas, UXC 18 |
| RE.ETQ.0.3 | Medir el rollo y el controlador TSC de la PC de Suc 08; averiguar si la TE200 tiene red o sólo USB (decide el transporte de la vía B) | ⬜ rollo ✅ 2026-11-19 (abajo); falta el controlador y red/USB | rollo: la configuración de Kepler contra la hoja del módulo y la medida de Francisco · falta: foto con regla + captura de la configuración del controlador |
| RE.ETQ.0.4 | Fecha de la etiqueta: cuenta de Kepler (1-ene = 0) sobre **el día de la primera impresión** (D6), no sobre una fecha de Kepler | ✅ 2026-11-05 (cuenta) · ✅ 2026-11-17 (fuente, D6) | espécimen: 308 = 5-nov (captura de la orden 0000474); prueba de la cuenta en RE.ETQ.1.3 |

⛔ Sin importer. Nada se trunca en el dato.

**Rollos que configura Kepler** (pantalla «Cambios de Precios», captura de Sistemas del 2026-11-19): **Colores 3 al paso 100 × 48 mm** (la de uso normal) · Blanca chica 104 × 24 mm (poco) · Amarilla 60 × 30 mm (casi no se usa) · Blanca grande 117 × 78 mm · Blanca mediana sin medida (0 × 0). La de 3 al paso es la hoja que ya manda el módulo (`PAGINA_TSC_3X` = `size: 100mm 48mm`; TSPL `SIZE 100 mm,48 mm`) y cuadra con lo que midió Francisco el 2026-10-08 (3 etiquetas de 32 mm + 2 separaciones de 2 mm = 100 mm): **no hace falta cambiar código**. Es la configuración de Kepler, no una medida con regla: la prueba física (3.5) la confirma. Este módulo no usa las otras medidas.

### C1 · Dominio
| # | Item | Estado | Prueba que lo ejerce |
|---|---|---|---|
| RE.ETQ.1.1 | **Pieza de etiquetera en `libs/`**: sacar de `checado-etiquetas.ts` las filas de 3, la página y las barras; plantillas `checado` (GP.4) y `caja`. GP.4 la consume sin cambiar su salida | ✅ 2026-11-19 (#571, en prod; candado partido en marco + barras en #574) | spec: el HTML de GP.4 idéntico antes y después |
| RE.ETQ.1.2 | Plantilla `caja`: logo, clave, Code 128 a 2 puntos por módulo con ancho calculado, `n:total`, UXC, fecha, nombre completo en dos renglones (letra que se achica, nunca se corta), pie con la sucursal por nombre; las tres etiquetas de la fila iguales | ✅ 2026-11-19 (#571, en prod; lectura física en 3.5) | spec con el 70106: 20 etiquetas, 7 filas, textos exactos; spec con `CAJETA ENVINADA TOPPER 1KG` y `1/2 KG`: nombres distintos |
| RE.ETQ.1.3 | Fecha (D6): el instante de la primera impresión, con la cuenta de Kepler y TZ `America/Mexico_City` (`mx-date.ts`); la reimpresión recibe la fecha guardada y no la recalcula | ✅ 2026-11-19 (#571, en prod; lectura física en 3.5) | spec: 2026-11-05 → `308-26`; 2026-01-01 → `0-26`; 31-dic de 2028 (bisiesto) → `365-28`; **17-nov 23:30 CDMX (05:30 UTC del 18) → `320-26`**; reimpresión del 20-nov de una etiqueta del 17 → `320-26` |
| RE.ETQ.1.4 | Código por unidad: si la unidad del renglón es la tercera del producto (`c55` = `kdii.c83`) → `C`+clave; si es otra → el código de esa unidad (`c7` base, `c82` paquete) o la clave. Producto con `c85` vacío: se imprime `C`+clave y se marca «Kepler no lo reconoce» | ✅ 2026-11-19 (#571, en prod; lectura física en 3.5): `C`+clave en CJA/BTO/CUB + aviso | spec con el 70106 (`C70106`) y con un producto real de Suc 00 sin `c85` |
| RE.ETQ.1.5 | Caja incompleta: `c9` no múltiplo de `c58` → una etiqueta más, que dice sus piezas (`21:21 · 6 PZA`) | ✅ 2026-11-19 (#571, en prod; lectura física en 3.5) | spec con la orden `0000685` de Suc 01 (4 renglones de media caja) |
| RE.ETQ.1.6 | **Vía B — TSPL**: la misma plantilla escrita en TSPL, una por renglón, con `SET COUNTER` para que la impresora numere; el transporte (red, WebUSB o agente local) se elige con RE.ETQ.0.3 | 🧪 2026-11-19 (#571; en prod sin ofrecerse): sin medir la impresora | spec: el TSPL del 70106 contra un archivo de referencia; prueba física en C3 |

### C2 · API
| # | Item | Estado | ¿Escribe? | Prueba contra base real |
|---|---|---|---|---|
| RE.ETQ.2.1 | `GET commercial/receiving/box-labels/orders?date_from&date_to` — órdenes de la sucursal del usuario con renglones, cajas y **estado de etiquetado** (por etiquetar · impresa · reimpresa, desde la bitácora) | ✅ 2026-11-19 (#571, en prod) | no | `pruebas-db` con fixtures de `kdm1`/`kdm2`/`kdii` |
| RE.ETQ.2.2 | `GET commercial/receiving/box-labels/catalog-defects` — productos recibidos en caja con factor 0 o sin `c85`, para Compras | ✅ 2026-11-19 (#571, en prod) | no | ídem |
| RE.ETQ.2.3 | `POST commercial/receiving/box-labels/prints` — **bitácora (D4)**: sucursal, orden, renglón, SKU, consecutivos desde-hasta, total, UXC, **fecha impresa (D6: la pone el servidor en la primera impresión)**, fechas del vale y de la orden (no se imprimen: miden el atraso), código, vía (A/B), motivo (primera · reimpresión), usuario. Tabla `commercial.box_label_prints` con `tenant_id` + audit; la primera impresión **congela** los datos de la etiqueta | ✅ 2026-11-19 (#571): probado contra base real y en prod; la bitácora arrancó en 0 filas | **sí** | ⛔ obligatoria (regla 13), con el payload de la pantalla |
| RE.ETQ.2.4 | Permiso **`ALMACEN_ETIQUETAS_CAJA`** (clave, ADR-054) **repartido** en prod al puesto de recepción/almacén (regla 20); `MATRIZ_ACCESOS.md` regenerada | ✅ 2026-11-19 (#571): repartido en prod (batch 1217) a 4 roles, 21 personas medidas; por rol, los nuevos lo heredan; `MATRIZ_ACCESOS.md` regenerada (#574) | sí (migración) | migración generada, aplicada una por una |

### C3 · UI
| # | Item | Estado | `check:pantalla` antes → después |
|---|---|---|---|
| RE.ETQ.3.1 | `/almacen/etiquetas`: **cola de órdenes de entrada** de la sucursal con su estado; «Imprimir» por orden o por renglón; aviso de órdenes sin etiquetar con más de N horas | ✅ 2026-11-19 (#571): recorrida en local con capturas; en prod, sin validación visual en prod | pantalla nueva |
| RE.ETQ.3.2 | Vista previa a tamaño real; avisos por renglón: «Kepler no reconoce este código», «factor de caja en 0 en Kepler», «caja incompleta» | ✅ 2026-11-19 (#571): recorrida en local con capturas; en prod, sin validación visual en prod | |
| RE.ETQ.3.3 | Reimpresión: elegir renglón y consecutivos (p. ej. sólo la 7:20); sale con los datos congelados y queda en la bitácora como reimpresión | ✅ 2026-11-19 (#571): recorrida en local con capturas; en prod, sin validación visual en prod | |
| RE.ETQ.3.4 | Selector de vía A (navegador) / B (TSPL) por PC, recordado en el navegador | ⬜ la vía B no se ofrece hasta medir la impresora (0.3) | |
| RE.ETQ.3.5 | **Prueba física (nivel A):** imprimir el 70106 × 20 en la TSC de Suc 08 por las dos vías y **leer las 20 con el handheld**; destraba también el pendiente de GP.4 | ⬜ | foto + 20/20 lecturas por vía |

⛔ Cargar la skill `diseno` **antes** del primer archivo, con las 5 preguntas de §0b por escrito.
⛔ **Antes del primer item C3:** «Observaciones de diseño UI — revisión del plan» (`auditoria-diseno` §9).

---

## 6. Riesgos

| Riesgo | Efecto | Mitigación |
|---|---|---|
| La impresión de GP.4 nunca se probó en la TSC real | barras ilegibles | RE.ETQ.3.5 prueba las dos vías antes de soltar |
| La TE200 sólo tiene USB y el controlador de Windows la ocupa | la vía B necesita agente o cambiar el controlador | RE.ETQ.0.3 lo mide; la vía A sigue disponible |
| Etiquetas ya pegadas que se reimprimieron en Kepler | cajas con UXC 1 y fecha del documento | avisar al almacén; no se corrige lo ya pegado |
| Productos con `c85` vacío (43 %) | el `C`+clave de la Suite no lo leen las pantallas de **Kepler** | aviso en pantalla + lista para Compras (RE.ETQ.2.2) |
| La cola depende del ODS | si la ingesta se atrasa, la orden tarda en aparecer | la pantalla dice la hora del último dato (frescura, ADR-056) |
| La etiqueta dice cuándo se etiquetó, no cuándo llegó (D6) | en el 12 % de las órdenes la llegada fue de 1 a 20 días antes; rotar por antigüedad con la etiqueta subestima la edad | la bitácora guarda la fecha del vale: la Suite puede mostrarla al escanear `C`+clave |
| La orden queda pendiente | sin orden no hay etiqueta (D2): la caja espera sin etiqueta, como hoy | la bitácora mide el atraso vale → etiqueta; si sale grande, se decide etiquetar desde el vale (decisión nueva) |

---

## 7. Definición de Terminado

- [ ] 1. Métrica remedida con la bitácora: % de cajas de Suc 08 etiquetadas desde la Suite, 2 semanas
- [ ] 2. Cada capa verificada **o declarada NO MEDIDA** (ADR-056)
- [ ] 3. RE.ETQ.2.3 ejercido contra base real con el payload de la pantalla
- [ ] 4. Compuerta nueva (si la hay) rota a propósito una vez
- [ ] 5. Pieza de etiquetera en `libs/`, consumida por GP.4 y por ésta
- [ ] 6. Tracker + `03_LOG_REVISIONES.md` al día
- [ ] 7. En prod, con el permiso repartido

---

## Implementación (2026-11-19)

C0–C3 en el PR #571 (2026-11-19), probados en local y recorridos en el navegador con capturas (ver la bitácora).

| Pieza | Dónde |
|---|---|
| Vista | `analytics.v_box_label_lines` (mig `20261119100324`); verificación en prod: `database/scripts/re-etq-v-box-label-lines-prod.js` |
| Reglas de la etiqueta | `libs/contracts/src/http/box-labels.contract.ts` |
| Etiquetera (GP.4 + caja + TSPL) | `libs/ui-web/src/etiquetera/` |
| API | `libs/commercial/src/lib/commercial-receiving/box-labels.*` → `commercial/receiving/box-labels/{orders, catalog-defects, prints}` |
| Bitácora | `commercial.box_label_prints` (mig `20261119101651`) |
| Permiso | `ALMACEN_ETIQUETAS_CAJA` + reparto propuesto (mig `20261119101652`) |
| Pantallas | `/almacen/etiquetas` y `/almacen/etiquetas/catalogo` (área «Etiquetas de caja») |
| Datos sintéticos (sólo local) | `database/scripts/re-etq-datos-sinteticos-local.js [--borrar]` |

**Medido en prod con el `SELECT` exacto de la vista** (ventana 2026-10-06 → 11-04): el espécimen 0000474 cuadra campo por campo; 4,820 renglones = 4,820 en `kdm2` (sin abanico); Σ `c56` = Σ `c9/c58` = 87,070.5 cajas; 7 renglones con caja incompleta; la cola de Suc 08 tarda 18 ms y la búsqueda por folio 1.6 ms. Prueba negativa del script: roja.

**En qué se apartó del plan, y por qué:**
- La vista vive en `analytics.*` (convención de las 84 vistas recientes) y con nombre en inglés; los endpoints van bajo `commercial/receiving/box-labels` (dentro de Recepción, D1).
- `RE.ETQ.1.4`: `C`+clave en **toda** unidad de empaque (CJA/BTO/CUB), con aviso cuando la caja de Kepler es otra unidad o no existe: `kdii.c83` está vacía en 1,501 renglones en CJA de 30 días; la regla «código de la otra unidad» del plan habría dejado sin código a esos.
- `RE.ETQ.1.6`: el TSPL escribe cada fila explícita en lugar de `SET COUNTER`: el consecutivo `n:total` es texto compuesto y la última fila puede ir incompleta.
- La bitácora registra «enviada», no «impresa»: el navegador no distingue imprimir de cancelar. La pantalla lo dice.

**Pruebas:** contrato 22 (mutación: 5 rojos) · etiquetera 15 · GP.4 idéntica por huella (mutación: rojo) · API 11 unitarias + 11 contra Postgres real (primera, reimpresión congelada aunque Kepler cambie, dos clics = una primera, 403/404/400, la base rechaza una segunda primera) · `design:paramtypes` 4 (negativa: 3 rojos) · pantalla 16 + 71 en `view` · `check:pantalla` de las dos pantallas: 0 fallas.

**En prod el 2026-11-19:** las 3 migraciones una por una (batches 1215 → 1216 → 1217), prod sirve `04285b22b` (rutas 401 sin sesión, menú en el bundle publicado), permiso a 4 roles / 21 personas y `MATRIZ_ACCESOS.md` regenerada (#574). **Pendiente para cerrar:** `RE.ETQ.0.3` el controlador TSC de la PC de Suc 08 y si la TE200 tiene red o sólo USB (el rollo ya está) · `RE.ETQ.3.5` prueba física por la vía A · `RE.ETQ.3.4` la vía B, cuando 0.3 diga el transporte.

## 8. Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
| 2026-11-19 | En prod: migraciones una por una (batches 1215–1217), permiso a 21 personas, rutas y menú publicados; la bitácora arrancó en 0 filas. El candado de GP.4 dependía de la versión de jsbarcode y dejó «Lint & test» rojo en `main`: se partió en marco + barras (#574). Sistemas compartió las medidas de los rollos de Kepler: el de uso normal (Colores 3 al paso, 100 × 48 mm) es la hoja del módulo, sin cambio de código | Sistemas + Claude |
| 2026-11-19 | Prueba en local con capturas: cola, detalle con avisos, imprimir (la hoja que iba a la impresora, interceptada), reimprimir el 2:3, consecutivo fuera de rango y catálogo de Kepler. Se corrigieron la vista previa (cortaba la 3.ª etiqueta) y la nota de fecha repetida; revisión previa al PR (retornos tipados con el contrato, sucursal de prueba propia). PR #571 | Sistemas + Claude |
| 2026-11-19 | C0–C3 construidos y probados en local (4 commits sin push): vista verificada contra prod, etiquetera en libs/ (GP.4 idéntica), API con bitácora probada contra base real, pantallas /almacen/etiquetas. Falta validación visual, prueba física y prod | Sistemas + Claude |
| 2026-11-17 | D6 respondida: la fecha es el día en que se imprime, porque el vale o la orden pueden quedar pendientes. Se aplica como el día de la primera impresión, con hora del servidor en CDMX, y la reimpresión repite la guardada | Sistemas + Claude |
| 2026-11-17 | D1–D5 respondidas (dentro de RE, desde la orden, las dos vías, con bitácora, `C` en caja). Análisis medido: cómo se trabaja hoy, 12 defectos de Kepler, 7 correcciones al plan propio; D6 abierta | Sistemas + Claude |
| 2026-11-05 | Decode del espécimen 70106 y de las formas vigentes de Kepler; requerimientos para revisión | Sistemas + Claude |
