# Pedido del 2026-10-01 — Motor de Margen: variables, pantalla, ISCAM y competencia

> **Qué es este documento.** El registro de **todo** lo que Edgar pidió el 2026-10-01, en orden,
> con mi lectura de cada pedido, qué quedó entregado y qué falta. El detalle técnico vive en
> [`FASE_PR_ESTRUCTURA_SENALES.md`](FASE_PR_ESTRUCTURA_SENALES.md) §12–§28; esto es el **pedido**,
> para que la próxima sesión no tenga que reconstruirlo del historial.
>
> ⚠️ Las citas son textuales, con sus erratas. Se dejan así a propósito: reescribirlas es
> interpretarlas dos veces.
>
> El día empieza a las **09:25** (`4bc1e3480`) y cierra a las **19:44**. ⛔ `763baf71d`, que yo
> había listado como «de esta sesión», es del **2026-09-30**.

---

## Índice

| bloque | horario | tema |
|---|---|---|
| [A](#a--las-variables-que-faltaban) | 09:00–10:00 | Las variables que faltaban — y tres hipótesis refutadas |
| [B](#b--la-pantalla) | 10:00–13:00 | La pantalla: el rediseño, el vocabulario y seis defectos |
| [C](#c--iscam-entra-al-motor) | 13:00–15:10 | ISCAM entra al motor |
| [D](#d--la-competencia) | 15:10–16:40 | La competencia: quién, cuánto, y 31 meses nuestros |
| [E](#e--el-precio-de-la-competencia) | 19:00–19:45 | El precio de la competencia |
| [F](#f--lo-que-publiqué-mal-y-corregí-hoy) | — | ⛔ Lo que publiqué mal y corregí |
| [G](#g--lo-que-falta-y-de-quién-depende) | — | Lo que falta, y de quién depende |
| [H](#h--las-decisiones-abiertas-que-son-tuyas) | — | Las decisiones abiertas que son tuyas |

---

## A · Las variables que faltaban

### A.1 · «precios de la competencia» → «no existen mas fueentes?» → «solo consideremos externas» → «si, hagamoslo» → «entonces omitamos esto»

**Lo que entendí:** antes de dar por buena la señal `F1 · Precio de competencia`, agotar las
fuentes externas.

**Entregado — refutada con medición, no con opinión:**

| fuente | por qué no sirve |
|---|---|
| **PROFECO QQP** | sin código de barras · de nuestras plazas sólo cubre Morelia · su universo «dulce» son **63 productos a nivel nacional** (gelatina, cajeta, miel, papas) · se mide en **supermercados**, no en mayoreo · donde las marcas coinciden, **las presentaciones nunca** |
| **Mercado Libre** | **403** en la API y en las páginas públicas |

`F1` queda **`refutada`** en el registro. ⚠️ Ver [H.5](#h--las-decisiones-abiertas-que-son-tuyas):
el bloque E encontró un precio *relativo* derivable, que **no cambia** este veredicto sobre un
precio de lista, pero sí obliga a revisar el motivo escrito de `F1`.

---

### A.2 · «que otras variables no estramos abarnacnod?» → «apliquemoslo entonces» → «si» → «entonces sigue»

**Lo que entendí:** buscar qué le falta al motor, aplicarlo, y medir si de verdad explica algo.

⭐ **Las dos candidatas se aplicaron y las dos quedaron refutadas — cada una por un tipo distinto
de control.** Eso *es* el hallazgo, no un fracaso.

#### H1 · Margen por canal — refutada por **control negativo** (batch 648)

En los 3 canales de Kepler, **el 100.0 %** de las celdas donde el precio difiere más de 5 % entre
almacenes tiene una dispersión de margen **menor a 0.01 pp**. En `wincaja_ruta` —que trae
`ValorCosto` real— es **0.0 %**.

⛔ El margen está congelado porque `sales_daily.cost` del lado Kepler es `revenue/(1+markup_pct)`:
**álgebra ciega al precio**. Los **$846,040** que parecían oportunidad eran el método de costeo.
Los canales Kepler son el **84.8 %** de la venta.

#### H2 · Prima por plazo de cobro — refutada por **control de confusión** (batch 652)

Los clientes a crédito *parecían* pagar **−4.80 %** menos (el placebo centrado en +0.06 %). Pero
su cantidad mediana por renglón es **12.00 contra 2.00**: dentro de bandas de cantidad comparable
el efecto se desploma a **−0.14 %**. El precio está bien para el plazo pactado.

⭐ **Lo que sí quedó en pie es un hallazgo de COBRANZA, no de precio:** plazo pactado **5.1 días**
contra **21.2 reales**; las facturas marcadas «0 contado» se cobran a **14.3 días**. Medido sobre
el 14.9 % que tiene `dias_pago` poblado.

#### E5 · Tasa de costo de capital

Registrada como **`no_existe`**: el motor valúa inventario sin saber cuánto cuesta el dinero.

---

## B · La pantalla

### B.1 · [captura] «al dar clicc esto es lo que hace. es un diseño pesmo, generame un artefacto con el nuevo diseño»

**Lo que entendí:** la cola de `/comercial/motor-margen` no se puede operar; querías ver el
rediseño antes de que lo escribiera en el código.

**Entregado:** artefacto de diseño, aprobado, y después el código.

---

### B.2 · «necesito que control de magen y experimentos vivan juntos. en al misma etiqueta del side-bar … o vivan junsots separados por un selector tipo ios»

**Entregado** (`f874c4512`, [PR.V2]): una sola entrada **«Control de margen»** con
`PageTabsComponent variant="liquid"` —el segmented iOS de la casa—, rutas planas
`precios/motor` y `precios/experimentos`, y `preciosHomeGuard`.

⚠️ Las rutas anidadas rompían `landing-guards.spec.ts`, cuyo parser sólo lee hijos a 8 espacios de
indentación. Por eso quedaron planas.

---

### B.3 · «ahora si armemos el artefacto (el nuevo front)»

**Entregado** (`addbdae54`, [PR.V3]): el resumen partido en tres bloques —flujo, capital como
**saldo** con borde punteado y sin barra, y la tira de «sin decisión posible»—, la tabla con
acción y certeza **separadas**, columnas de costo y margen contra meta, filas agrupadas.

⭐ `agrupar-cola.ts` salió a su propio archivo **para poder probarse** (8 pruebas): agrupa sólo
cuando coinciden acción **y** precio, y el monto es **NULL cuando ninguna fila lo tiene, nunca
cero**.

---

### B.4 · «a que te refiers con "corregir escalera"?» → «necesito que seas ,iu especifico con ests terminos … ser o tecnico, o usar palabras sencillas» → «mencionamos "corregir escalera" pero no mencionamos a uq enos referimos con eso»

**Lo que entendí:** la pantalla usa jerga que nadie definió, y mezcla registros.

**Entregado** (`428d2caaf` + `458d6cc8c`, [PR.V4] y [PR.V5]): `precios-vocabulario.ts` como
**fuente única** de las etiquetas y glosas, el About en el diccionario `CONTEXT_HELP` —nunca en la
plantilla—, y el término explicado **donde se usa**, no detrás de un botón.

⭐⭐ **Y escribir el About destapó un defecto real:** la regla de «corregir la escalera» tiene una
tolerancia de **0.01 %**, así que el redondeo al centavo la dispara. Medido: **248 de 696 celdas
difieren en ≤1 centavo** (mínimo $0.0006) y arrastran **$76,610** de la cola; las **349 rotas de
verdad** —hasta $341.86 por pieza— arrastran **$2,138**.

⛔ **No se corrigió**: no estaba autorizado. El About dice lo que la regla hace **hoy**.

---

### B.5 · Seis defectos que señalaste mirando la pantalla

| tu palabra | qué era |
|---|---|
| «aqui que hago? no existe informaicon o algo que pueda clickear» | la pestaña de Experimentos no tenía nada accionable → botón «Diseñar experimento» + diálogo, gateado por `PRICE_EXPERIMENT_GESTIONAR` |
| [log 500 pegado] `cannot execute INSERT in a read-only transaction` | el alta de experimento escribía contra una conexión de sólo lectura |
| «revisa tus problemas de diseño, mira ese boton» | ⛔ **los botones salían SIN TEXTO.** La compuerta `check-primeng-api.js` estaba **auto-silenciada**: un `continue` que creía filtrar `p-button` también casaba `class="p-button-sm"`. Reportaba **2** donde había **32** |
| «esto que es?» | el diálogo decía el mismo número de dos maneras: «pide 291» contra «necesita 582». `nPorRama` es **por rama** |
| «mencionas "subir precio" un porcentaje pr no dices si subir ese margen o aumentar ese margen» | `.mx-tab` **no tenía ni una regla de estilo** → «MARGEN REAL QUE HACER» corrido y `11.08%subir_precio`. Encabezados renombrados a «Margen que se cobró» / «Qué propone el motor» |
| «estas sando emojis "regla de nunca usar emojis" que te estas saltando» | **10 emojis** en texto de interfaz. Reemplazados por PrimeIcons **y construida la compuerta que faltaba**: `scripts/check-no-emoji-ui.js` |

⭐⭐ **La lección de método, que vale más que los seis arreglos:** dos de estos defectos existían
porque yo había corrido **una sub-compuerta en vez de `node scripts/check-all.js`**, y porque
**filtré la salida de una compuerta por lo que esperaba encontrar**.

---

## C · ISCAM entra al motor

### C.1 · «C:\ISCAMPRECIOS … ANALIZALA PARA VER QUE ENCUENTRAS INTERESNTE Y NUTRITIVO PARA ESTE MODULO» → «RASCALE MAS» → «SI ES UNA MEDICION QUE NOS ENTREGAN MES A MES, Y NOS AYUDA A ESTE DESARROLLO PARA MEJORA DEL MARGEN O MARCKUP»

Más tu aclaración, que es la que cambió todo: **«A ISCAM SE LE TRASLADA TODOS LSO MOVIMIENTOS DE
SALIDA (ERROR DE DEUDA TECNICA DE WINCAJA), LO QUE CONTEMPLA LOS TRASPASOS ENTRE SUCURSALES …
ASI COMO EL SHARE VS MERCADO Y MAS CATEGORIAS»**.

**Entregado** (`c6e7250f5`, batches 660 y 661): `analytics.iscam_market` + `iscam_taxonomy` +
`v_iscam_share`, con la advertencia **en una columna**, no en un correo. `C1` dejó de decir «no
existe segmento formal» y nacen `H3` (participación) y `H4` (terreno ganado o perdido).

⛔⛔ **Y aquí está el error más caro del día, mío:** mi primer lector se quedó con **9,772 de
1,500,880 registros — el 0.65 %**, porque descartaba el registro entero al ver un `<m/>`. Publiqué
un share de **5.79 %** donde el real es **3.80 %**.

⭐ **Lo único que lo delató fue contar los registros leídos contra el `recordCount` declarado.**
El subconjunto sobreviviente daba cifras perfectamente plausibles. Ese conteo es ahora un candado
que **aborta la carga**.

⭐ El grano, que son **dos cifras ciertas**: **5.36 %** en Mayoreo Puro (nuestro canal) y
**3.80 %** en el mayoreo total. La diferencia son **$426.8M de mercado en subcanales donde no
vendemos nada**.

⛔ `PcioDisp` **no se importó**: su fórmula es `Val/Vol/24`, divisor fijo para todo el catálogo.
⚠️ De ahí saqué una conclusión equivocada — ver [bloque E](#e--el-precio-de-la-competencia).

---

## D · La competencia

### D.1 · «necesito que vayas mas allana, necesito que consigas informacion de competidores principales, ver cual es la comptenecia y ganar observabilidad bajo eso»

**Lo que entendí:** no alcanza con el total del mercado. Hace falta saber **quién** nos gana y
**cuánto**, y poder verlo.

⭐ Lo primero que salió al medir: **la competencia son DOS cosas distintas, de dos fuentes que no
se pueden empatar.**

| | qué responde | fuente |
|---|---|---|
| **cuánto vende** la competencia, por marca | ISCAM, agregado | `v_iscam_competencia` |
| **quién es** y dónde está | INEGI DENUE, con nombre | `v_competidores` |

⛔ **El hueco, declarado y no rellenado:** ISCAM **anonimiza** a los 116 participantes de su panel;
DENUE no dice cuánto vende nadie. **No hay llave entre las dos y no se inventó una.**

**Entregado** (`a299ee66a`):

- ISCAM baja al grano de **fabricante × submarca** — 406,799 filas contra 13,483. El archivo ya
  traía esas dos dimensiones; la carga anterior las agregaba y las tiraba.
  ⭐ El cambio es **lossless**, medido: el fino suma exacto al grueso, **0 claves fuera,
  diferencia 0.0000**.
- **1,156 competidores mayoristas con nombre**, domicilio y rango de personal
  (SCIAN **431180** dulces al por mayor + 431110 abarrotes + 431199). ⭐ Las tres clases que el
  módulo de prospección ya usaba son de **menudeo**: eso son clientes, no competencia.
- `prospect_stores.rol` (`prospecto` · `competidor` · `propio`), **que es requisito de corrección,
  no adorno**: `dedup()` purga lo que cae fuera de la geocerca de 100 km y corre en cron nocturno,
  así que sin el filtro la primera pasada se llevaba a los rivales de Guadalajara y León.

**La foto, julio-2026 · Región III · Mayoreo Puro · DULCES:**

| veredicto | marcas | competencia |
|---|--:|--:|
| perdiendo terreno | 440 | $539.35M |
| ganando | 360 | $277.60M |
| **ausentes** (vendemos cero) | **868** | **$77.07M** |

⭐ Dónde más creció la competencia: **EFFEM LUCAS** +$11.05M · **NESTLÉ** +$7.54M ·
**DE LA ROSA** +$5.68M · **BARCEL −2.87 pp** · **SABRITAS −2.01 pp**. Barcel, Sabritas y Totis son
**Frituras** — la categoría que `H4` ya marcaba cayendo. Ahora se sabe **quién** se lo llevó.

---

### D.2 · «necesito que esto qie caza iscam, lo casemos nostros. toda data es muy valisoa»

**Lo que entendí:** lo que ISCAM mide de nosotros, medirlo nosotros — y dejar de tirar lo que la
entrega trae.

⛔ Tenías razón en las dos mitades: yo había descartado **1,094,081 registros** del SURF (RY y YTD)
y **no había cargado los dos Cubos**, que describí como «nuestro dato devuelto».

**Son 445,310 registros · 31 meses (ene-2024 → jul-2026) · 11 sucursales · 8,207 presentaciones**,
con `Vol` y `Val` por celda, taxonomía de siete niveles, gramaje y el empaque en el nombre.

⭐⭐ **$1,281.30M — el 68 % del Cubo — es venta NUESTRA que `analytics.sales_daily` no tiene.**

| | monto |
|---|--:|
| comparable (ISCAM y libros, misma celda) | $604.14M |
| sólo en ISCAM, sucursal mapeable | **$489.23M** |
| 2024 y ene-2025, plaza agregada sin almacén mapeable | $792.07M |

De los $489.23M, **$368.84M son Morelia Abastos entera**.

---

### D.3 · «apliquemoslo de una vez»

**Lo que entendí:** aplicar a prod ahora, pese a que advertí que eran las 16:14 de un jueves y la
regla del proyecto prohíbe escrituras pesadas en horario hábil. Lo tomé como tu decisión.

⭐ **Dos cosas se cazaron solas durante la aplicación:**

1. El cargador **se negó a correr** porque renombré la carpeta al copiarla y el periodo sale de su
   nombre. **No escribió nada** en vez de inventar un mes.
2. La migración reportó «**1** señal corregida» cuando había **dos**: un reemplazo por texto
   literal arregla lo que encuentra y **calla lo que no**. La corrección de seguimiento
   (batch 668) **no busca una frase: afirma el resultado** y falla si alguna señal sigue
   publicando la causa refutada.

---

## E · El precio de la competencia

### E.1 · «no me muestra nada e precios de productos de comptenecia»

**Lo que entendí:** el reclamo es correcto y el hueco era de **criterio mío**.

Descarté `PcioDisp` porque su fórmula es `Val/Vol/24` — divisor **fijo**. Eso sigue siendo cierto.
Pero de ahí concluí *«ISCAM no trae precio»*, y lo que no trae es un precio **absoluto**. El
relativo sí se deriva, **y el divisor fijo se cancela en la razón**:

```
precio nuestro      = valor_nuestro / volumen_nuestro
precio competencia  = (valor_mercado − valor_nuestro) / (volumen_mercado − volumen_nuestro)
```

La resta es lo que lo vuelve *competencia* y no *mercado*: saca nuestra venta del denominador.

**Medido, julio-2026 · Región III · Mayoreo Puro · DULCES:**

| | submarcas | venta nuestra |
|---|--:|--:|
| **arriba del precio de la competencia** | **202** | **$10.23M** |
| al mercado (±10 %) | 695 | $38.92M |
| **abajo** | **131** | **$5.01M** |

Con confianza alta: **CANEL'S CELOFÁN +80.5 %** · **HALLS +35.3 %** · **KINDER BUENO +30.1 %** · y
del otro lado **VUALA −59.0 %** · **TOTIS DONITAS −41.2 %** · **HERSHEY'S KISSES −18.5 %**.

⭐ **El control que lo valida:** la razón **tiene dispersión** (mediana 1.0005, desviación 0.4747,
de 0.107 a 12.172). Si diera 1.000 en todas partes estaría midiendo una tautología algebraica.

⚠️ La confianza sale de **nuestro** share en volumen, que es donde está el ruido: con share ≥10 %
la desviación es 0.17 (608 celdas) y por debajo sube a 0.71 (420).

### E.2 · La pantalla

`/comercial/precios/competencia` — tercera pestaña de **Control de margen**, entre el motor y los
experimentos, porque responde la pregunta que alguien se hace **entre** ver qué mover y decidir
medirlo.

⭐ **Answer-first:** abre con el dinero —lo que cobramos por encima y por debajo del mercado—, no
con el tamaño de la tabla. Después vienen tres bloques: el precio contra la competencia (dos
tablas, cara y barata), dónde más creció la competencia, y las marcas que el canal compra y
nosotros no vendemos.

⚠️ **El selector de subcanal está en pantalla a propósito.** Cambia la cifra y las dos son
ciertas; cuál se publica sigue abierto ([H.1](#h--las-decisiones-abiertas-que-son-tuyas)), así que
la pantalla **expone la decisión en vez de tomarla por su cuenta**.

⛔ **La certeza del precio se dice con palabras, no con un color**: «medida» o «poca venta nuestra
(3.2 %)». Un color hay que saber interpretarlo; la frase no.

⛔ **NULL se escribe como guion, nunca como $0** — un cero se lee como «la competencia no vendió
nada».

Y cierra con **«Lo que estas cifras NO son»**, que trae las cuatro declaraciones del dato y las
cuatro del precio, al mismo peso que las tablas.

**Tres correcciones durante el armado:**

1. Metí `p-selectButton` y **ya existía `shared/components/segmented`**, el control de la casa —
   que además trae el teclado resuelto (flechas, Home/End, un solo stop de tabulador). Cambiado.
2. ⛔ **Inventé 23 nombres de token** (`--text-1`, `--space-2`, `--border-1`…). Los reales son
   `--fg-*`, `--sp-*`, `--border-color`, `--fw-medium`. Una declaración con un token inexistente
   **se cae en silencio**: la compuerta `check-css-tokens` existe por eso y los cazó todos.
3. El vocabulario fue al diccionario `CONTEXT_HELP`, **nunca a la plantilla**.

⚠️ `nx build view` está **rojo para todos ahora mismo**, y no por esto: 6 errores en
`finanzas-ingresos`, `finanzas-bancos` y `dashboard/captures`, de trabajo en vuelo de otra sesión.
Mi componente compila limpio. **Mientras el build esté rojo, `ci-green` no bendice nada y el
auto-deploy está frenado.**

---

## F · Lo que publiqué MAL y corregí hoy

Va aquí, y entero, porque es lo que más caro sale si la próxima sesión lo reconstruye del
historial.

| # | qué publiqué | qué es |
|---|---|---|
| 1 | share de ISCAM **5.79 %** | **3.80 %**. Mi lector leyó **0.65 %** de los registros y las cifras sobrevivientes eran plausibles |
| 2 | «el numerador viene inflado por **traspasos**, brecha $19.5–21.6M/mes» | la brecha existe, la causa no. Sobre **las mismas sucursales** la razón es **1.105–1.371**, no 1.54: `sales_daily` **no tenía esas sucursales** |
| 3 | «**4,674** filas sin respaldo, $9.51M» | son **285**. El resto era polvo de coma flotante contra una columna `numeric(18,4)`. La bandera pasó a **generada por la base** |
| 4 | `competencia` recortada a cero con `GREATEST` | rompía `nuestro + competencia = mercado` en **21 de 40** categorías y decía «la competencia no vendió nada» sobre $0.84M. Ahora es **NULL** |
| 5 | veredicto de precio con `ELSE 'al_mercado'` | **11,709 celdas** traen sólo volumen: caían por ese ELSE con el precio en NULL. **Un ELSE que absorbe lo no medido lo pinta de verde** |
| 6 | «ISCAM no trae precio» | no trae precio **absoluto**; el relativo se deriva (bloque E) |
| 7 | «prod-api está caído» | **falso**: prod corre en **K3s**, no en Compose. El contenedor `prod-api` es un residuo |
| 8 | el conteo del candado de señales decía **46** | la base tenía **49**: agregué H1, H2 y E5 en tres commits **y no volví a correrlo**. Y H1/H2 violaban la regla de que una señal no cableada no apunta a una columna |

**Y tres defectos de proceso, no de dato:**

- ⚠️ **El acento grave dentro de un comentario rompió un literal de plantilla tres veces hoy**
  (ocurrencias 10, 11 y 12 del proyecto). `node --check` lo caza en un segundo.
- ⛔ **Corrí una sub-compuerta en vez de `check-all.js`**, y **filtré la salida de otra por lo que
  esperaba encontrar**. De ahí salieron los botones sin texto.
- ⛔⛔ **Volqué credenciales vivas al transcript** al diferenciar el entorno de Nx
  (`ANTHROPIC_API_KEY`, `DATABASE_URL` de prod, `CLOUDINARY_API_KEY`, `GROQ_API_KEY`,
  `FLEET_DB_URL`, `FEEDS_INGEST_KEY`, `DENUE_TOKEN`, `JWT_SECRET`). Borré los volcados en disco.
  **Hay que ROTARLAS** — ver [G](#g--lo-que-falta-y-de-quién-depende).

---

## G · Lo que falta, y de quién depende

| # | qué | de quién |
|---|---|---|
| 1 | ⛔⛔ **Rotar las credenciales** que volqué al transcript | **tuyo**, y es lo más urgente de esta lista |
| 2 | **Aplicar la vista de precios a prod** (`20261001250000`). El intento quedó bloqueado por el clasificador de permisos al escribir en el host remoto | **tuyo**: autorizar `kubectl cp` + `exec` en un pod `api-*` del namespace `prod`, o aplicarla vos |
| 3 | **`git push`** — nunca autorizado | **tuyo** |
| 4 | **Redeploy** para que respondan `/margin-engine/competencia` y `/prospects/competidores` | sale solo con el push (auto-deploy cada 5 min) |
| 5 | **Validación visual** del rediseño, el expediente, el selector, el About y el diálogo | **tuya**: es lo único que yo no puedo hacer |
| ~~6~~ | ~~**La pantalla de competencia y precios**~~ ✅ **hecha**: `/comercial/precios/competencia`, tercera pestaña del selector segmentado. Ver [E.2](#e2--la-pantalla) | — |
| 7 | Cosechar DENUE por el endpoint, en vez del script de carga inicial | mío |

**Compuertas en rojo que NO son de este trabajo** (medidas y atribuidas): `styleClass p-table`
297/289 · `p-select` 267/263 · `check-dense-tables` en `guide-cost-panel` · `check-css-tokens` en
`compras-costo-estandar` · `check-signal-reactivity` en `comercial-inventory-variance:725` ·
`etiqueta-hoja.spec.ts` · `no-explicit-any` en `libs/contracts/**/ports` · `run-all-tests.js:122`
(de `4891380d7`, CB.49) · colisión de timestamp `20261001160000` con un archivo sin seguir de otra
sesión.

---

## H · Las decisiones abiertas que son TUYAS

1. ⛔ **Qué share se publica.** `5.36 %` en Mayoreo Puro (nuestro canal) o `3.80 %` en el mayoreo
   total. **Las dos son ciertas.** Cablear `H3`/`H4` obliga a elegir una, y a abrir el cero de
   `disponible` que el candado de la capa 2 exige.
2. ⛔ **La tolerancia de «corregir la escalera».** Hoy dispara con el redondeo al centavo: **248 de
   696 celdas** con $76,610 contra **349 rotas de verdad** con $2,138. La propuesta —exigir más de
   un centavo por pieza— está escrita y **sin autorizar**.
3. ⚠️ **Los 11 «prospectos» con SCIAN de mayoreo.** Entre ellos `DULCERIA RIOS` —competidora
   directa— y ~10 tiendas de cadena, **tres con score 69–72, o sea arriba de la lista de
   oportunidades**. Si un abarrotero mayorista es cliente o rival es criterio comercial.
4. ⚠️ **El residuo de ~10 %** entre ISCAM y nuestros libros sobre sucursales comunes. Sin explicar.
5. ⚠️ **El motivo de `F1 · Precio de competencia`**, que hoy dice `refutada` por falta de fuente
   externa. Sigue siendo cierto para un **precio de lista**; ya no describe el estado del
   conocimiento, porque existe `v_iscam_precio_competencia`.
6. ⚠️ **`commercial.warehouses` tiene `latitude`/`longitude` NULL en las 22 filas.** Por eso la
   cercanía de un competidor se mide contra **clientes**, no sucursales, y es un **piso**.
7. ⚠️ **El hallazgo de cobranza de H2**: plazo pactado 5.1 días contra 21.2 reales. No es precio y
   no tiene dueño asignado.

---

## I · Lo que NO se hizo, con su motivo

- ⛔ **No se inventó una llave entre ISCAM y DENUE.** No existe.
- ⛔ **No se usó el empaque `[32 D/100 P]`** como factor de caja, aunque parsea en el **100 %** de
  las 8,207 presentaciones y sería un tercer testigo. Que `D` y `P` signifiquen *display* y *pieza*
  es **lo que parece, no lo verificado**: el candado exige que ninguna vista lo consuma hasta
  probarlo contra el dinero.
- ⛔ **No se importó `PcioDisp`.** Su divisor es fijo; el precio relativo se deriva sin él.
- ⛔ **No se corrigió la escalera** ni se reclasificó ningún prospecto. Ver [H](#h--las-decisiones-abiertas-que-son-tuyas).
- ⛔ **No se dibujó una curva de elasticidad.** La medida es una región de **[−1.415, −0.045]** —un
  factor de **31×** de ancho— y por SKU el error estándar es **0.94**, que es ruido.

---

## J · Estado en PROD al cierre

| batch | qué |
|---|---|
| 648 | `H1` margen por canal, refutada con control negativo |
| 652 | `H2` prima por plazo (refutada) + `E5` tasa de costo de capital |
| 660 | `iscam_market` + `iscam_taxonomy` + `v_iscam_share` |
| 661 | `C1` con motivo corregido + `H3`/`H4` |
| 664 | `iscam_market` a grano **fabricante × submarca** |
| 665 | `prospect_stores.rol` + `v_competidores` |
| 666 | `iscam_sales` + `v_iscam_vs_libros` + **la advertencia corregida** |
| 668 | `H4` repetía la causa refutada con otras palabras |

| dato | filas |
|---|--:|
| mercado × marca | **406,799** |
| nuestra venta, 31 meses | **444,615** |
| puente código de barras | 3,895 |
| competidores DENUE | **1,156** |
| prospectos (sin contaminar) | 1,646 |
| señales en el registro | **51** (29 cableadas · 18 no_existe · 4 refutadas) |

**Candados contra prod:** `iscam-mercado` 31/0 · `iscam-cubo` 13/0 · `denue-competidores` 13/0 ·
`iscam-precio-competencia` 12/0 (este último **sólo en laboratorio**, porque su migración no está
aplicada).

---

## K · Commits del día

| hora | commit | qué |
|---|---|---|
| 09:25 | `4bc1e3480` | [PR.S3] H1 margen por canal — el control negativo es el hallazgo |
| 09:44 | `12de75847` | [PR.S4] H2 prima por plazo, refutada por confusión; y E5 |
| 10:22 | `f874c4512` | [PR.V2] el motor y los experimentos en una entrada con selector segmentado |
| 10:44 | `addbdae54` | [PR.V3] el rediseño de la cola — el saldo deja de fingir que es flujo |
| 11:36 | `428d2caaf` | [PR.V4] el About — y el defecto que apareció al escribirlo |
| 11:52 | `458d6cc8c` | [PR.V5] el término se explica DONDE se usa |
| — | [PR.V6–V9] | diálogo de experimentos · botones sin texto · el diálogo que decía dos números · emojis y la tabla sin estilo *(entraron squashados en `6bb8e4f30`, PR #206)* |
| 15:07 | `c6e7250f5` | [PR.M1]+[PR.M2] ISCAM entra al motor de margen |
| 15:51 | `a299ee66a` | [PR.M3]+[PR.M4] la competencia deja de ser un total — ISCAM a marca + DENUE |
| 16:14 | `b4df66e0a` | [PR.M5] el Cubo: 31 meses de nuestra venta + la corrección de la advertencia |
| 16:37 | `cc04eb63b` | aplicado a PROD: batches 664-666 y 668 |
| 19:32 | `f015f88c0` | [PR.M6] el precio de la competencia |
| 19:44 | `8642c9db2` | este documento |
