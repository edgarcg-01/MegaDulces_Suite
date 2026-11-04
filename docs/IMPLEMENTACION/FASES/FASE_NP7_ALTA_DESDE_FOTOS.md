# Fase NP.7 — Catálogo digital: fichas de producto, levantamiento y altas desde fotos

> Plan detallado. Originalmente para entregar a otro dev; desde el 2026-11-01 **lo construye Francisco**. Redactado el 2026-10-28 a partir de una sesión con Francisco
> (Compras), con el SKU **95805** (bon o bon Fresa, caja de 8) como caso de prueba.
> Es la ampliación del item **`[NP.7]`** de [`FASE_NP_PRODUCTOS_NUEVOS.md`](FASE_NP_PRODUCTOS_NUEVOS.md)
> («Alta solicitada en la app (pestaña Solicitudes)»), **no una fase nueva**: la Fase 0 del
> [método](../../METODO_DE_TRABAJO.md) prohíbe abrir fases mientras dura la campaña de aterrizaje.
> ⭐ **2026-11-03: el primer corte está EN PROD.** Edgar fusionó el PR #481 (`fb3bcac09`) y aplicó las 3
> migraciones una por una; prod sirve un commit que lo contiene. Medido en sólo lectura esa noche: rutas, pantalla,
> tabla, permisos repartidos (184 personas levantan, 6 con la clave de revisar) y **0 fichas** (esa noche la primera captura de prueba dejó 4, ninguna con foto: ver la bitácora). El OK del PM (cupo,
> D1, D15) **no consta por escrito**: se pide en el Tablero. En §10b.5, 🚀 = aterrizado en prod sin cerrar
> (`METODO_DE_TRABAJO` paso 5); ✅ sólo con toda su columna «Prueba».
> ⛔ **Antes de pasar a 🔨 hace falta el OK del PM en el Tablero PM**: cupo (hoy 7 de 4: AB, LE, RH,
> PQ, FC, MX, DP), D1 y D15 de §8. (D16 ya no bloquea la fase: sólo NP.7.L.6. D6 ya no bloquea
> NP.7.L.2: la IA queda apagada hasta que se resuelva.)
> **Francisco, 2026-11-02: la construcción arranca en local, sobre `main` y sin push.** Edgar revisa
> cuando se envíe el PR, y ahí decide cupo, D1 y D15; nada llega a prod sin ese PR. La IA queda
> **apagada por defecto** (`NP7_AI_ENABLED=false`) mientras D6 no se resuelva.
> **Orden (Francisco, 2026-11-01):** tramo 1 = **levantamiento** (piloto Padre Hidalgo); tramo 2 =
> **altas**, que no arranca hasta cerrar el piloto (§10).

```
OBJETIVO: Que cada SKU tenga su ficha de producto hecha desde fotos, sin teclear. Primero
          (tramo 1) el personal de sucursal levanta la ficha de los SKUs que ya existen: la Suite lee
          el empaque y publica sola lo que pasa las compuertas (⛔ en el piloto de Padre Hidalgo no:
          todo va a «por revisar» hasta que NP.7.L.11b encienda cada campo, §10b.3 punto 4).
          Después (tramo 2) Compras da de alta
          un producto subiendo fotos al negociar: la Suite llena el catálogo ampliado sola y entrega
          una ficha para Kepler donde una persona sólo decide lo comercial.
MÉTRICA L (tramo 1): % de la venta de 90 d (en pesos) con unidad principal publicada
          (definición exacta en §10b.3, «Unidades de conteo») — Padre Hidalgo primero, luego las 9
          — HOY: 0 % (2026-11-01, por construcción: la ficha no existe) → META: la fija el PM, con
          fecha (D15). Si D15 lo hace fase propia, esta métrica se muda a esa fase.
MÉTRICA 1 (tramo 2): % de campos de la ficha de alta de Kepler que decide una persona
          — HOY: 100 % (no existe herramienta: todo se teclea a criterio, ver §1) → META: ≤ 20 % (provisional; confirmar Francisco — D18)
          para <fecha que fije el PM>
MÉTRICA 2 (tramo 2): SKU activo con valor de fábrica sin corregir = al menos uno de (lista cerrada):
          (a) clave SAT 01010101; (b) moneda USD con proveedor nacional; (c) unidad base
          `2 KILOGRAMO` en un producto por pieza. Conteos separados: base activa y altas de 90 días
          — HOY (Padre Hidalgo, 2026-11-02, §10a.2): productos físicos activos 10.1 %; altas físicas
          de 90 días 14.7 %. Las promociones no cuentan (Francisco, 2026-11-02). La red NO MEDIDO → META: 0 en altas nuevas
CAPA TOPE: C3
ÁREA:      Comercial (Compras · Catálogo)
DUEÑO:     Francisco Lopez — lo construye él con Claude (decisión 2026-11-01; ya no se pasa a otro dev)
ESTADO:    🔨 primer corte en prod desde 2026-11-03 (PR #481) · ⚠️ sin OK escrito del PM (cupo 7 de 4, D1, D15)
```

---

## 1. Qué problema resuelve

- **El alta de un producto ocurre sólo en Kepler, a mano, y a criterio de quien captura.** La Suite no
  tiene ningún flujo de alta: la pestaña `/compras/catalogo/solicitudes` es un marcador de posición
  ([`compras-catalogo-apartado.component.ts:35`](../../../apps/view/src/app/modules/compras/pages/compras-catalogo-apartado.component.ts)),
  `commercial-products.controller.ts` no tiene `POST`, y nada inserta en `kdii`.
- **La pantalla de alta de Kepler trae valores de fábrica peligrosos** (captura de Francisco,
  2026-10-28): *Moneda compra = Dólares americanos*, *CFDI Producto = 01010101 «No existe en el
  catálogo»*, *Unidad base = 2 KILOGRAMO*. Si el capturista no los cambia, el producto nace mal y nadie
  se entera. Cuántos productos ya están así **no está medido** → NP.7.0.3.
- **Lo que el empaque dice no llega a ningún lado.** Con 5 fotos del 95805 Claude leyó marca,
  fabricante, contenido (8 × 15 g = 120 g), EAN `7500443006889` (dígito verificador válido), sellos
  NOM-051, alérgenos, nutrición y caducidad. Nada de eso existe hoy en la Suite: el único texto de
  producto que usa la IA (Fase K, `embedding-sync.service.ts:127`) es marca + nombre del ERP.
- **Los ~6,500 SKUs que ya existen tampoco tienen ficha** (fotos, contenido, sellos, escalera
  comprobada contra el empaque). Es el tramo 1 (levantamiento, §10b), y va primero (§10).

---

## 2. Qué NO incluye

- ⛔ **Escribir en Kepler.** ADR-016 prohíbe escribir al ERP y la única excepción (Fase KR, requisición
  `X-A-30`) está **apagada**. El alta en Kepler **sigue siendo manual**: la Suite entrega la ficha y
  después **verifica** lo capturado (NP.7.2.5). Escribir a `kdii` sería otra fase, con su propio ADR.
- **Modificaciones de ficha en Kepler** (cambio de precio, de proveedor, baja). Sólo altas (tramo 2)
  y el levantamiento de la ficha ampliada de SKUs existentes (tramo 1, §10b), que **no** modifica
  Kepler: lo que contradiga a Kepler sale como hallazgo y se corrige allá a mano.
- **Precio de venta definitivo.** La Suite **sugiere** margen y PV (§5.4). La política de precios
  no cambia.
- **Mínimo / punto de reorden / máximo.** Se dejan en 0 y los calcula Reabastecimiento (Fase RA) con
  venta real; NP ya sigue al código 30/60/90 días.
- **Decisión fiscal.** IVA e IEPS se **sugieren** con regla y fuente. **Fiscal valida** (D3).
- **Reemplazar las fotos del portal/tienda** (112 jpg de CV) en el primer corte. Si la foto publicada
  llega al portal y al verificador, y qué pasa con las existentes, lo decide D19 (item NP.7.L.14).

---

## 3. El flujo

```
 NEGOCIACIÓN            ANÁLISIS                 REVISIÓN             KEPLER (manual)        CIERRE DEL LAZO
 Compras sube   ──►  IA lee las fotos   ──►  Compras confirma  ──►  Capturista copia  ──►  La Suite ve el EAN en kdii,
 fotos por           + reglas del            los campos C de     la ficha, campo        liga la clave y compara
 peldaño (5+3)       sistema llenan el       §4 (6–8) +          por campo, en el       ficha vs Kepler campo por
 + costo y           resto de los 31         lo dudoso; aprueba  orden de la pantalla   campo → hallazgos
 proveedor           campos (§4)
                                                                                          └► catálogo ampliado poblado
```

Estados de la solicitud (`status`, filas `origin = 'alta'`):
`presolicitud` (opcional: la abrió el levantamiento, §10b.3) → `borrador` → `analizada` → `aprobada` →
`tecleada_en_kepler` (el capturista marca que ya la pasó; antes se llamaba `capturada`, se renombró
porque en el levantamiento «capturar» quiere decir «tomar las fotos») → `ligada` (la Suite encontró el
código en `kdii`) → `conciliada` (ficha = Kepler) **o** `con_diferencias`.
Más `descartada` (se negoció y no se catalogó; **se conserva**: es historia de lo evaluado).

- **`presolicitud`**: la crea alguien con `CATALOGO_LEVANTAR` cuando escanea un código que Kepler no
  conoce (§10b.3 punto 1) o cuando el buscador no lo encuentra y la persona decide reportarlo
  (§10b.8b). Sólo lleva fotos, código, sucursal y autor. ⛔ **No llama a la IA** hasta que Compras la
  promueve (`POST /commercial/product-requests/:id/promote` con `COMPRAS_ALTA_SOLICITAR` → `borrador`,
  **la misma fila**) o la descarta (`descartada`). Un EAN con presolicitud abierta **suma sus fotos a
  la existente** (sin error; el capturista ve «ya lo reportó otra sucursal»). Si el EAN aparece en
  `kdii`, NP.7.2.5 la liga sola. Sólo suma al ranking si Compras la promueve. Una búsqueda sin
  resultado **no crea nada por sí sola**. Tope diario por persona: lo decide el PM.

**Fotos obligatorias (por peldaño, misma regla que el levantamiento, §10b.7 punto 2 y NP.7.3.2):**
**5** de la unidad principal (frente · reverso · lateral izquierdo · lateral derecho · base con el código
de barras) + **3** por cada otro peldaño que exista físicamente, p. ej. la **caja master/corrugado**
(frente + la cara con el código + la cara con la leyenda de contenido; da Unidad Dos/Tres, su factor y
su DUN-14; hoy no sale de ningún lado). Un producto con Base + corrugado = **8 fotos**. (❌ Antes decía
«6 fotos», con la caja master como una sola foto.) Opcional: cotización/lista del proveedor (da código
del proveedor y precio lista).

---

## 4. Campo por campo: la pantalla de alta de Kepler

Fuente: **F** = foto (IA) · **S** = sistema (regla determinista) · **H** = predicción por vecinos (§5.7) ·
**C** = Compras (decisión humana). Columna `kdii`: ✅ = verificada contra dato · 🏷️ = rótulo de
pantalla de `kpl-decode` (pista, **no verificada**) · ❓ = sin mapear → NP.7.0.1.

| Sección | Campo Kepler | Fuente | `kdii` | Ejemplo 95805 |
|---|---|---|---|---|
| General | Clave | S (regla por confirmar, D5) | `c1` ✅ | — |
| | Descripción | S: generador de nombre §5.5 | `c2` ✅ | `BON O BON FRESA ED ESP 8/15G` |
| | Línea | H | `c3` ✅ (catálogo `kdig`) | la de los otros bon o bon |
| | Tipo | H | `c4` ✅ (catálogo `kdie`) | |
| | Grupo | H | `c5` ✅ (catálogo `kdif`) | |
| | Naturaleza | H | ❓ | |
| | Imagen | S: foto del frente | `c70` ✅ (`Productos\<sku>.jpg`, 3 pantallas) | foto 5 |
| | Obsoleto? | S: `N` | `c99` 🏷️ | N |
| | Días de caducidad | H (o F si el lote trae fecha de fabricación) | `c101` 🏷️ | ⚠️ lote ilegible |
| | Comentarios | S: «Alta desde Suite, solicitud #id» | ❓ | |
| Unidades POS | Base: unidad / factor / código | **Base: C** con sugerencia de hermanos (§5.8 punto 1: si se vende suelto es decisión comercial); factor / código: F (foto base) | `c11` / 1 / `c7` (+ `c93`, `c102`) ✅ | PZA? / 1 / `7500443006889` |
| | Base: costo | **C** | `c77` ✅ | — |
| | Base: «%Margen» (⛔ es **markup** sobre costo) → PV | **C** (Compras + Dirección Comercial) con sugerencia del Motor de Margen, §5.8 | `c87` → `c90` ✅ | sugerido |
| | Unidad Dos: unidad / factor / código | F (foto caja master) | `c80` / `c81` / `c82` (+ `c95`, `c96`) ✅ | CJA / N / DUN-14 de fábrica o `C`+clave |
| | Unidad Dos: costo | S: costo × factor (ec. 1 de §2.1.1) | `c78` ✅ | |
| | Unidad Dos: markup → PV | **C** si existe el peldaño (sugerencia del motor, §5.8 punto 3); vacío → S | `c88` → `c91` ✅ | |
| | Unidad Tres: unidad / factor / código | F si hay 3er peldaño | `c83` / `c84` / `c85` ✅ (+ `c97`/`c98` sin verificar) | el 99 % de la Unidad Tres trae `C`+clave en `c85` (`C06001`; ERP_KEPLER §3.y.4) |
| | Unidad Tres: costo | S: costo × factor | `c79` ✅ | |
| | Unidad Tres: markup → PV | **C** si existe el peldaño; vacío → S | `c89` → `c92` (sin verificar) | |
| Control interno | IVA | H (confitería) — fiscal valida | `c18` ✅ (≤ 0 = incluido en el precio: comparar el valor absoluto) | 16 |
| | IEPS | S: regla kcal §5.6 — fiscal valida | `c19` ✅ (≤ 0 = incluido en el precio: comparar el valor absoluto) | 8 (564 kcal/100 g) |
| | Mín / Reorden / Máx | S: 0 (RA los calcula) | `c33`/`c34`/`c35` ✅ | 0 / 0 / 0 |
| | Ubicación general | Almacén (fuera de alcance) | ❓ | |
| Proveedores | Código del proveedor | Cotización, o **C** | ❓ | ¿`61200112285` de la base? |
| | Proveedor | **C** (sugerido de H) | `c8` ✅ en 3 pantallas (`CF006`, `CM017`, vacío) | Unidal / Arcor |
| | Precio lista proveedor | **C** | `c23` 🏷️ | — |
| | Moneda compra | S: **MXN explícito** si proveedor nacional | `kdii.c20` o `c31` («PESOS» = «Pesos mexicanos»; falta saber cuál de las dos) | la pantalla de alta vacía trae USD por defecto |
| | Unidad alterna compras / factor | F (caja master) | ❓ (`c95`/`c96` son códigos de la Unidad Dos, no esta unidad; ERP_KEPLER §3.y.4) | CJA / N |
| CFDI | Clave producto SAT | H | `kdfe33relprd.c2` ✅ (3 pantallas: `50161813`, `50161800`) | ⚠️ la pantalla de alta vacía trae `01010101` por defecto |
| | Unidad de medida SAT | H | `kdfe33relprd.c3` ✅ (unidad secundaria en `c5`) | H87 |
| | IVA exento / Objeto de impuesto | H | `kdfe33relprd.c4` / `c6` ✅ | N / 02 |

**Conteo (corregido 2026-11-01; antes decía «~30 campos, C decide 4 ≈ 13 %», que quedó viejo
cuando §5.8 hizo de la Base y del markup decisiones de Compras):** un campo = un renglón de esta
tabla. **M = 31, fijo** (10 de General · 9 de Unidades POS · 4 de Control interno · 5 de
Proveedores · 3 de CFDI); un peldaño que no existe cuenta como campo llenado por el sistema
(«vacío»). Campos **C**:

| Escalera | Campos C | % |
|---|---|---:|
| 1 peldaño | Base, costo, markup Base, proveedor, precio de lista, código del proveedor = 6 | 19.4 % |
| 1 peldaño, código del proveedor leído de la cotización | 5 | 16.1 % |
| 2 peldaños | + markup Dos = 7 | 22.6 % |
| 3 peldaños | + markup Tres = 8 | 25.8 % |

⚠️ Con 2 o 3 peldaños la META provisional de ≤ 20 % **no se cumple aunque todo lo demás salga
solo**. Lo resuelve D18 (el markup cuenta como decisión humana; falta confirmar si el markup de los
peldaños superiores cuenta aparte o si se confirma la escalera de markups del motor como una sola
decisión). Además se revisa **lo que la IA marque con confianza baja o lo que no cuadre** (§5.2),
que no es fijo por producto y no está en la tabla. La métrica se mide así, no se supone (NP.7.3.4:
«N de M campos», M = 31).

⛔ **La ficha nombra TODOS los campos, incluidos los que «ya vienen llenos»** en Kepler. El riesgo
está justo en los valores de fábrica.

---

## 5. Reglas del sistema (lo que quita el criterio personal)

> Todas viven en **lógica pura** en `libs/commercial/src/lib/product-requests/` (sin Nest, sin
> knex), con su `.spec.ts`. El contrato de la ficha vive en `libs/contracts` y lo usan **a la vez** el
> formulario, la API y el `input_schema` del lector de IA (NP.7.1.2): un solo esquema, nunca se desalinean.

### 5.1 EAN: lo lee el lector de códigos, no la IA

1. Leer el código de la foto de la base con `@zxing/library` (ya está en `package.json`, lo usan el
   verificador `tienda-verificador.component.ts` y `product-scan-field.component.ts`) **en el
   navegador, antes de subir**. El servidor sólo revalida el dígito verificador del código que recibe;
   leer el código de la imagen en el servidor sería trabajo nuevo y no entra en esta fase.
2. Validar dígito verificador (EAN-13/EAN-8/UPC-A; DUN-14 para la caja master) **sólo si el código
   tiene forma GS1**. El `C`+clave (p. ej. `C06001`, el código interno con el que Mega Dulces
   reetiqueta al ingresar) es válido **sin** verificador. En un alta, el `C`+clave **se propone a partir
   de la clave**, no se lee de la foto (la caja de fábrica todavía no lo trae).
   *Control conocido: `7500443006889` → suma 91 → verificador 9 ✓.*
3. Comparar con lo que leyó la IA. **Si difieren, gana el lector y se marca la discrepancia.**
4. **Buscar el EAN en las 9 casillas de código de `kdii`** (ERP_KEPLER §3.y.4): Base `c7`, `c93`,
   `c102`; Dos `c82`, `c95`, `c96`; Tres `c85` (+ `c97`/`c98`, sin verificar), con **coincidencia
   exacta, sin quitar ceros** (en `06001` la Base trae `006001` y el paquete `06001`), en las 9 ramas.
   Se reusa `unidadDelCodigo`/`resolverCodigo` de
   `libs/commercial/src/lib/commercial-picking/checado-codigo.ts` (se mueve a
   `libs/commercial/src/lib/shared/` si la usan dos módulos). ⚠️ **No copiar la lista de
   `kp.service.ts`: le falta `c102`**, y un código guardado sólo ahí saldría «no existe» y abriría un
   alta duplicada. **Si existe → NO es un alta**: la solicitud queda bloqueada como
   «ya existe como SKU X» (duplicado o recodificación; NP ya tiene esa señal por código de barras).

### 5.2 Cuadres (cada uno puede marcar un campo «revisar»)

| Cuadre | Regla | 95805 |
|---|---|---|
| Contenido | `\|piezas × g/pieza − neto\| ≤ max(1 g, piezas × ½ del último dígito impreso del g/pieza)` (el redondeo de la etiqueta crece con las piezas) | 8 × 15 = 120 ✓ · prueba: 50 × «3 g» con neto 137.5 g → tolerancia 25 g → ✓ |
| Nutrición | **por porción, no por pieza**: `kcal_porción ÷ g_porción × 100 ≈ kcal/100 g` (±10 %, el redondeo de etiqueta). Se lee en `nutricion_porcion { porcion_g, piezas_por_porcion, … }` (§7.2). Si la etiqueta no trae columna por porción → `no_aplica` (no se inventa con la pieza). El IEPS (§5.6) usa el valor **declarado** por 100 g, no el recalculado | 80 kcal / 15 g ×100 = 533 vs 564: 5.5 % ✓ · prueba: porción de 30 g = 2 piezas → se usa 30 g, no 15 g |
| NOM-051 | los sellos leídos coinciden con los que exige la tabla nutrimental | 3 sellos ✓ |
| Factor caja master | factor × contenido de la base = contenido del corrugado (si la etiqueta lo dice) | — |
| Confianza | todo campo de IA con `confianza ≠ alta` → «revisar» | lote ilegible → revisar |

### 5.3 Producto hermano

❌ **Reemplazada por §5.7 (2026-10-28).** La predicción por vecinos (kNN + reglas + prueba hacia
atrás) es la única forma de llenar los campos **H**. Lo que seguía vigente de aquí (Línea `c3`, Tipo
`c4`, Grupo `c5`, IVA `c18` e IEPS `c19` ya mapeados; lo demás «sin fuente» hasta NP.7.0.1) vive en
§5.7 y en la nota de C0.

### 5.4 Precio sugerido

Ver **§5.8 puntos 3 a 5**: el markup, la meta y las reglas de precio salen del **Motor de Margen**,
no de una lógica propia de esta fase.

### 5.5 Nombre para Kepler (determinista)

`MARCA + VARIANTE + [EDICIÓN] + PRESENTACIÓN/CONTENIDO`, mayúsculas, sin acentos, abreviaturas de una
tabla fija (`EDICION ESPECIAL → ED ESP`, `PIEZAS → PZ`…), recortado al largo de `kdii.c2`
(**medir el largo máximo**, NP.7.0.1). Antes de fijar la regla, **compararla contra los nombres
existentes** de la misma marca para seguir la convención que ya hay (NP.7.0.4).

### 5.6 IEPS (sugerencia, fiscal valida)

LIEPS art. 2-I-J: alimentos no básicos **de la lista del inciso J** con densidad calórica
**≥ 275 kcal por 100 g** → 8 %. Las calorías solas no bastan. Regla:
`categoría ∈ lista del inciso J (aprobada en catalog.fiscal_rules_approved) Y kcal_100g >= 275 → 8`,
con la fuente (foto 3, tabla nutrimental; se usa la kcal/100 g **declarada**, §5.2).
- Categoría fuera de la lista aprobada → la regla **no opina**: «revisar».
- Bebidas y sus polvos (inciso G) pagan **por litro**, no por kcal → siempre «revisar».
- kcal no leída con confianza alta → «revisar».
- ⛔ Nunca se marca como decidido sin la validación de fiscal (D3).

Pruebas (NP.7.1.6): polvo para bebida de 380 kcal → revisar; grupo sin aprobar con 400 kcal →
revisar; chocolate sin kcal legible → revisar; chocolate aprobado en 274/275/276 kcal → 0/8/8.

### 5.7 ⭐ Predicción que aprende: Tipo, Grupo, IVA, IEPS y CFDI

> Pedido de Francisco (2026-10-28): que estos campos los llene la IA y **cada alta la vuelva más
> certera**. Aplica a: Línea, Tipo, Grupo, Naturaleza, IVA, IEPS, CFDI Producto (`c_ClaveProdServ`),
> Uni Med (`c_ClaveUnidad`), IVA exento, Objeto de impuesto (`c_ObjetoImp`). Reemplaza el
> «producto hermano» de §5.3 (❌).
> ⛔ **Node/TS + SQL (pgvector).** Nada de Python, ni para entrenar.

**La idea:** los ~13,800 productos de `kdii` ya tienen esos campos capturados. Cada uno es un ejemplo
resuelto: **no hay que esperar altas nuevas para entrenar**.

**1. Modelo: vecinos más cercanos (kNN) con voto por conteo.** Para un producto nuevo se buscan los
**k = 5** productos más parecidos y se propone, por campo, el valor con más votos. **El nivel de
acuerdo = votos del ganador** (5/5, 4/5, 3/5). Pesos por distancia **sólo** si la prueba hacia atrás
(punto 3) demuestra que mejoran el acierto, y entonces con **cubetas de peso usadas igual en el
predictor y en la calibración** (un solo nivel de acuerdo, no dos). Señales del parecido:

| Señal | De dónde | Por qué |
|---|---|---|
| Nombre + marca (embedding) | `active_product_embeddings` (Fase K, ya existe). ⚠️ **Vive en la base vectorial (`KNEX_VECTOR_DB`), no en la principal, y sólo tiene los SKUs de `products_active`** (~6,489, no los ~13,800 de `kdii`): `embedding-sync.service.ts:298-337`, `ai-product-matcher.service.ts:143, 185-201` | parecido de significado |
| **Prefijo GS1 del EAN** (`750 0443…` = fabricante) | lector §5.1 | mismo fabricante → casi siempre misma clasificación. ⚠️ **Sólo cuenta con EAN-13 o UPC-A válidos, que no empiecen con `2` (uso interno) y que no sean la clave del SKU** (ni `C`+clave). El prefijo del fabricante es **el más largo (de 7 a 10 dígitos) que comparten ≥ 2 SKUs de la misma marca**; si no hay, la señal va en `null` |
| Proveedor | Compras | |
| Lo que leyó la foto: tipo de producto, kcal/100 g, sellos | lector NP.7.1.2 | el IEPS depende de las kcal; el SAT, de qué es |

**Cómo se arma (dos pasos, no un solo SQL):** (a) los vecinos salen de la base vectorial
(`KNEX_VECTOR_DB`); (b) sus etiquetas salen de la vista NP.7.0.6 en la base principal; se unen en TS.
Sin `VECTOR_DATABASE_URL` configurada, el resultado es «sin hermanos por significado»
(`measured: false`), **nunca «0 vecinos»**. En C0 se mide cuántos SKUs de `kdii` tienen embedding
(NP.7.0.6), y la prueba hacia atrás mide **sólo sobre ese universo** y lo declara; ampliarlo a todo
`kdii` es otro item.

Se eligió kNN porque **aprende sin reentrenar**: cada alta aprobada es un vecino más **en cuanto entra
a `products_active`** (y el sincronizador de embeddings la toma); antes no es vecino de nadie.
Además corre en Postgres con pgvector y es explicable («4 de 5 vecinos, estos»). Un modelo entrenado
(regresión logística, árboles) sólo se considera si la prueba hacia atrás (punto 3) demuestra que kNN
no alcanza el umbral, y tendría que ser en TS.

**2. Reglas duras: la predicción propone, la regla vigila.** Si la predicción choca con una regla, se
descarta y el campo queda «revisar».
- `c_ClaveProdServ`, `c_ClaveUnidad` y `c_ObjetoImp` deben **existir en el catálogo oficial del SAT**
  (ya replicado en `contpaqi_ods`; se lee con la vista de NP.7.0.7, sin tabla nueva).
  ⛔ `01010101` **nunca** es respuesta.
- IEPS > 0 ⇒ Objeto de impuesto `02`.
- **Exento (LIVA arts. 9/15/20) ≠ tasa 0 % (LIVA art. 2-A).** Exento = `S` ⇒ sin tasa de IVA; tasa 0
  ⇒ exento = `N`. Cómo lo guarda Kepler se descifra en NP.7.0.1 con dos fichas reales (una exenta,
  una a tasa 0); fiscal valida (D8). Pruebas: un producto a tasa 0 sale exento = `N`; un exento sale
  sin tasa.
- IEPS por kcal **sólo dentro de la lista del inciso J aprobada** (§5.6); fuera de ella, «revisar».
- ⚠️ En la prueba hacia atrás (punto 3) las reglas **no se aplican a la etiqueta de Kepler** (se
  compara la predicción contra lo que Kepler tiene, sin «corregirlo» primero).
- Combinación aprobada por fiscal (punto 4) **manda** sobre la predicción.

**3. Prueba hacia atrás antes de dejarla llenar sola (calibración).** Dos pruebas, y **manda el menor
de los dos aciertos**:
- **Esconder uno (*leave-one-out*)**, sobre la vista NP.7.0.6 (**una fila por SKU**, no por sucursal)
  y sólo sobre el universo con embedding (punto 1). Al esconder un SKU se esconden **también** los
  que comparten su EAN o están marcados `posible_recodificacion` (si no, el producto «se encuentra a
  sí mismo» y el acierto sale inflado).
- **Temporal**: predecir las altas de los últimos 180 días usando **sólo** lo que existía antes de
  cada una. Es lo que de verdad pasa con un alta.

Se publica, **por campo y por nivel de acuerdo** (5/5, 4/5, 3/5 votos): acierto, **línea base de
clase mayoritaria** (lo que sacaría quien siempre dice el valor más común), **matriz de confusión** y
**precisión por clase**. Un campo se llena solo si se cumplen **las tres**:
- (a) acierto > línea base + el margen que fije D7;
- (b) la precisión **de la clase predicha** ≥ el umbral (no basta el promedio: un 99 % global puede
  esconder que «exento» casi siempre sale mal);
- (c) la **cota inferior de Wilson al 95 %** ≥ el umbral, con **n mínimo**:

| Tipo de campo | Umbral (cota inferior 95 %) | n mínimo en ese nivel de acuerdo | Además |
|---|---|---|---|
| Operativo (Línea, Tipo, Grupo, Naturaleza, Uni Med) | ≥ 98 % | 150 | — |
| Fiscal (IVA, IEPS, Producto SAT, IVA exento, Objeto imp.) | ≥ 99.5 % | 600 | la combinación ya fue aprobada por fiscal (punto 4) |

Sin n suficiente, el campo se rotula **«sin base suficiente (n)»** y va a «revisar». **Control con
etiquetas barajadas**: el acierto debe caer a la tasa de la clase mayoritaria, y **ese número se
publica** junto al real. Los umbrales, el margen sobre la línea base y la revocación (punto 5) son la
propuesta inicial (**D7**). Por debajo del umbral, el campo **se sugiere** prellenado con «revisar»,
nunca se oculta.

**4. Cada alta enseña (el ciclo).**
```
 kNN predice ──► Compras/fiscal confirma o corrige ──► se captura en Kepler
      ▲                                                       │
      └──── conciliación (NP.7.2.5): predicción vs lo que quedó en kdii ◄┘
```
- La predicción queda en `ai_raw` y lo aprobado en `sheet`. **La diferencia en la misma fila es la
  corrección**: no hace falta tabla de correcciones.
- **La verdad final es `kdii`** (después de la conciliación), no lo que dijo la pantalla.
- Una combinación que fiscal aprueba (p. ej. *grupo Chocolates → IVA 16 · IEPS 8 · SAT X · H87 · 02*)
  se guarda en `catalog.fiscal_rules_approved` y desde ahí es **regla**, no predicción.

**5. Autonomía que se gana y se pierde.** Cada semana se repite la prueba hacia atrás, con las altas
nuevas incluidas, y se guarda el resultado con su fecha. Un campo **gana** el autollenado al pasar su
umbral y **lo pierde** si hay **k errores en las últimas *N* altas** (p. ej. entra una categoría que
el catálogo no conocía); *N* y *k* se fijan en D7. Nadie decide a ojo cuándo confiar en la IA: lo
decide el número.

**6. Claude sólo desempata.** Cuando los vecinos no coinciden (< 3 de 5), se le pasan a Claude los 5
vecinos, lo leído de la foto y el extracto del catálogo SAT. Elige con razón escrita; su respuesta
pasa por las mismas reglas (punto 2) y **nunca cuenta como autollenado**: siempre «revisar».

**⛔ Trampa a limpiar primero: etiquetas basura.** Productos con los valores de fábrica de la métrica 2
— (a) SAT `01010101`, (b) USD con proveedor nacional, (c) unidad base `2 KILOGRAMO` en producto por
pieza — **no son ejemplos válidos**. Si el modelo aprende de ellos, predice basura con mucha
seguridad. Se marcan como **etiqueta desconocida** y se excluyen del entrenamiento (NP.7.0.6). Su
conteo (a)(b)(c) es la métrica 2 de la cabecera. **Para entrenar, además se excluyen los campos
vacíos; los vacíos no cuentan para la métrica 2.**

### 5.8 ⭐ Escalera de unidades (pieza · caja · bulto) y márgenes por peldaño

> Pedido de Francisco (2026-10-28). Antes de tocar esto, leer [`ERP_KEPLER.md`](../../ERP_KEPLER.md)
> §2.1 y §2.1.1 y [`UNIDADES_DE_MEDIDA.md`](../../UNIDADES_DE_MEDIDA.md) §7 (reglas): **la unidad ya
> costó tres bugs en una sola sesión y un error de 32× en costos (CANON.0.1).**

**Lo que Kepler exige (pie de su propia pantalla):** las unidades se capturan **en orden ascendente
de factor**; **la facturación y el inventario son siempre en la unidad Base**. O sea: **la Base es la
unidad MÁS CHICA que Mega Dulces vende o cuenta**, no la que compra.

**1. Decidir la escalera (qué es Base, Dos y Tres).** Ejemplo 95805:

| Si Mega Dulces… | Base | Unidad Dos | Unidad Tres |
|---|---|---|---|
| vende sólo la caja de 8 (lo normal en una caja de regalo) | caja (rótulo `PZA`) · factor 1 · EAN de la caja | bulto/corrugado · factor N · DUN-14 | — |
| vende también el bombón suelto | bombón · factor 1 · (sin EAN propio) | caja · factor 8 · EAN de la caja | bulto · factor 8 × N · DUN-14 |

- **La foto NO decide la Base**: decide qué existe físicamente (la caja trae 8, el corrugado trae N).
  Si se vende suelto es una **decisión comercial** → se propone con la escalera de los hermanos (§5.7)
  y la confirma Compras. Es un campo **C** con sugerencia.
- **Factores:** salen de la **foto de la caja master** (etiqueta del corrugado: «contiene 24 cajas»,
  DUN-14) y de la **cotización**. ⛔ **El nombre del producto NO es fuente del factor** (hipótesis
  refutada en ERP_KEPLER §2.1.1: `RIFA DENNY /160` es factor 1). Lo impreso en el empaque se usa
  como *evidencia que la foto ve*, y siempre se confirma.
- **Rótulos** (`PZA`, `PAQ`, `CJA`, `BTO`, `KG`, `500`…): de una **lista cerrada** sacada de los
  rótulos que ya usa `kdii` (`c11`/`c80`/`c83`), nunca texto libre. UNIDADES_DE_MEDIDA §3: el
  vocabulario ya está sucio en las dos puntas; la Suite no debe ensuciarlo más.
- **Cuadre:** factor de cada peldaño entero, > 1 y **creciente** (Dos > Base, Tres > Dos). Si la
  escalera queda con un solo peldaño, Dos y Tres van **vacíos** y eso es dato válido (840 SKUs así).

**2. Costo: Compras lo da en la unidad en que NEGOCIÓ; el sistema baja a la Base.**
El proveedor cotiza por caja o por bulto, casi nunca por pieza. El formulario pide **«costo por
\<unidad que eligió\>»** y el sistema calcula el resto con la ecuación (1) de ERP_KEPLER §2.1.1, que
se cumple en 98.6 % del maestro:

```text
costo_base = costo_negociado / factor_de_esa_unidad
costo_N    = costo_base × factor_N          → c77, c78, c79
```

Así nadie divide a mano: evita justo el error de 32× (poner el costo de caja donde va el de pieza).
La ficha muestra los tres costos con la cuenta a la vista (`$X por bulto ÷ 24 = $Y por caja`).

**Redondeo (sin esto el cuadre falla por centavos):**
- El peldaño **negociado conserva su costo exacto** (el que dio Compras, sin recalcular).
- La Base se guarda con la **precisión de `c77`** (cuántos decimales guarda Kepler: se mide en
  NP.7.0.1, no se supone).
- Los demás peldaños = Base × factor.
- Tolerancia del cuadre: **media unidad de la precisión de `c77` × factor** del peldaño.
- *Control: SKU `00303`, CJA $553.97 con factor 50 → la CJA se queda en $553.97 y **no** sale «con
  diferencias».*

**3. ⭐⭐ El margen se decide DENTRO del Motor de Margen, no al lado.**

> **Quién lo fija: Compras y Dirección Comercial** (Francisco, 2026-10-28). La Suite propone, ellos
> deciden, y queda registrado quién autorizó.
> **Antes de tocar esto, leer** (en este orden): [`FASE_MR_DICCIONARIO_MARGEN.md`](FASE_MR_DICCIONARIO_MARGEN.md)
> (las definiciones; **sin firmar**) · [`FASE_MR_MOTOR_RENTABILIDAD.md`](FASE_MR_MOTOR_RENTABILIDAD.md)
> · [`FASE_PR_ESTRUCTURA_SENALES.md`](FASE_PR_ESTRUCTURA_SENALES.md) §9 (el triage) y §19 (la escalera)
> · [`PEDIDO_2026-10-01_MOTOR_DE_MARGEN.md`](PEDIDO_2026-10-01_MOTOR_DE_MARGEN.md) · ADR-051 ·
> `docs/VERDAD_ABSOLUTA.md` (por índice, sección de margen).

⛔ **La trampa de nombre: lo que Kepler rotula «%Margen» (`c87`/`c88`/`c89`) es MARKUP sobre el
costo, no margen sobre la venta.** Medido sobre 83,949 fichas: se comporta como markup en **99.11 %**
(mig `20260929200000`, `[PR.E0c]`). Toda la Fase MR y el motor hablan de **margen sobre venta**.
- La conversión vive en **un solo lugar**, la vista `analytics.v_kepler_margin_target`:
  `margen_venta = 100 × markup / (100 + markup)`, y al revés `markup = 100 × m / (100 − m)`.
- **Esta fase no la reimplementa.** Si la necesita en TS, se saca a `libs/commercial/src/lib/shared/`
  y la usan los dos (regla 16 / ADR-059 R6).
- La ficha muestra **los dos números con su nombre**: «markup en Kepler 26.40 % = margen sobre venta
  20.89 %». Nunca un «margen» a secas.

**Lo que el motor ya tiene y esta fase USA (no copia):**

| Pieza del motor | Dónde | Para qué en el alta |
|---|---|---|
| Meta de margen, cascada **producto > categoría > proveedor > default** | `commercial.margin_targets` + resolvedor único `resolveMarginTarget` en [`margin-target.ts`](../../../libs/commercial/src/lib/shared/margin-target.ts) | la meta del producto nuevo sale de su **categoría** y **proveedor** (aprobados en la ficha). Default hoy: **11.55 %** sobre venta, medido y validado contra el ~11.5 % que reporta el negocio (`[PR.E0d]`). ⚠️ **Hoy sólo existe la fila default**: no hay metas de categoría ni de proveedor (migs `20260929170000` l. 30-31, `20260929200100` l. 62, 114-117), así que todo cae al default. **El rótulo sale del ámbito y del `target_source` que devuelve el resolvedor**, nunca se supone «de la categoría»: hoy se lee «meta 11.55 % (default medido, nadie la firmó)». El 11.55 % es una meta de **margen de lista** ponderada por el peldaño vendido (`20260929200100_margin_target_default_kepler.js:16-30, 83-104`), no de realizado |
| Markup de Kepler por peldaño, con veredicto | `analytics.v_kepler_margin_target` (sobre `v_kepler_unit_ladder`) | el markup de los **hermanos por peldaño** (§5.7). Medido: mediana base **22.00 %**, Unidad Dos **13.79 %**: la caja va ~8 pp abajo **a propósito** (estructura de mayoreo) |
| Triage de precios: `corregir_escalera`, `revisar_costo`, `aterrizar_precio`… | `analytics.v_price_action` (⚠️ `analytics.price_action` **no existe**; la regla de escalera vive **en SQL**, en la vista de señales: `pv_caja/factor_caja <= pv1*1.0001`, migs `20260930230000_analytics_price_action.js:62,136`, `price_signals_v3.js:386-391`, `v4_arbitro.js:400-405`) + [`margin-engine.service.ts`](../../../libs/commercial/src/lib/commercial-pricing/margin-engine.service.ts) | **las mismas reglas** se corren sobre la ficha ANTES de aprobar (punto 4), llamando a la **función SQL** de NP.7.1.17, sin copia en TS |
| Simulador de precio | `MarginEngineService.simular` — ⚠️ **no sirve tal cual para un producto nuevo**: busca por sucursal y SKU y devuelve `null` si no existen (`margin-engine.service.ts:322-332`) | «¿qué margen queda si pongo este PV?» en la pantalla de revisión, con la **función pura** de NP.7.1.21 (la aritmética de `simular` extraída a `libs/commercial/src/lib/shared/`, que recibe costo y PV) |

**Cómo se propone el markup de cada peldaño:**
1. Markup de los hermanos **del mismo rótulo** (`CJA` con `CJA`, nunca la pieza de uno con la caja
   de otro), mediana y rango p10–p90.
2. Se convierte a margen sobre venta y se **compara contra la meta** del producto (cascada). La
   comparación usa el **margen de lista ponderado** por la mezcla de peldaños de los hermanos (ver
   el hueco de abajo y §5.9 «Cómo justifica el margen»), no el de un solo peldaño. Se muestra:
   «caja 13.8 % markup = 12.1 % · margen ponderado X % · meta 11.55 % (default medido, nadie la
   firmó)». El rótulo de la meta sale del `target_source` del resolvedor.
3. **Nunca se autollena**, aunque la prueba hacia atrás diga que acierta: el margen es decisión de
   Compras y Dirección Comercial.

⚠️ **Hueco con nombre: `commercial.margin_targets` NO tiene peldaño.** Su meta es una por ámbito
(el 11.55 % es un promedio ponderado por lo que se vende en cada peldaño), pero Kepler fija un markup
**por peldaño**. Comparar el markup de la pieza (22 %) contra una meta que es mayoritariamente de
mayoreo la haría ver «arriba de meta» siempre. Mientras no se decida (D11), la comparación contra
meta se hace **con el margen ponderado por la mezcla de peldaños de los hermanos**, y se declara así
en pantalla.

**4. Reglas de precio: las MISMAS del motor (bloquean la aprobación).**
- **Escalera** (`corregir_escalera` del motor): ningún peldaño puede salir más caro **por unidad
  Base** que uno más chico. Regla completa: **para todo par i < j con precio,
  `PV_j / factor_j ≤ PV_i / factor_i + $0.01`**. ⚠️ **Hoy el motor sólo revisa el peldaño más alto
  (caja) contra la Base** (`pv_caja/factor_caja <= pv1*1.0001`, en SQL): la Unidad Dos no se
  revisa en una escalera de 3. La regla vive en una función SQL (NP.7.1.17) que llaman la vista de
  señales y el alta. ⛔ **Defecto conocido del motor, sin corregir**
  (FASE_PR §19): la tolerancia es **relativa 0.01 %** y el redondeo al centavo la dispara (248 de 696
  casos son diferencias ≤ 1 centavo). La regla correcta es **brecha > $0.01 por pieza**. Corregirla
  **una vez en el motor** y que el alta use esa misma función; **no** escribir una segunda versión
  «arreglada» acá. Si la corrección del motor no se autoriza, el alta usa la del motor tal cual y lo
  declara.
- **Margen sobre venta ≥ 0** en todo peldaño.
- **Piso:** ✅ **ya existe, lo fijó Compras** (Francisco, 2026-11-01): **markup mínimo por papel de
  la unidad**, ver **§5.10**. Por debajo de cualquier piso → **autorización de Dirección Comercial**,
  con nombre, fecha y motivo. (❌ Antes decía «el alta no inventa un piso»: era cierto mientras no
  había política; `margin_targets.margen_minimo` del motor sigue NULL por D13 del motor y **no** se
  llena con estos pisos, que son de markup por peldaño y viven en la política de §5.10.)
- **Costo de Unidad Dos/Tres = base × factor** (lo calcula el sistema; editarlo a mano se rechaza),
  con el redondeo del punto 2: el peldaño negociado conserva su costo exacto y el cuadre tolera media
  unidad de precisión × factor. (❌ Antes decía «misma aritmética que `revisar_costo` del motor»: esa
  regla mide otra cosa.)
- **PV:** Kepler redondea (la ec. 2 cuadra al centavo sólo en 32.3 %), y el impuesto entra según el
  signo con que se capture (nota de la propia pantalla de Kepler). La ficha dice «PV aprox.» y la
  conciliación tolera el redondeo. ⚠️ **`v_kepler_margin_target` NO calcula el PV con impuesto**: la
  fórmula sólo está en un comentario de la migración `20260929200000`. Por eso:
  - En NP.7.0.1 se mide, con SKUs que tengan IVA 16 + IEPS 8, **qué factor reproduce `precio_ficha`**
    (los residuos frecuentes son 1.08 / 1.00 / 1.16, y `quote-pricing.service.ts` **suma** las dos
    tasas; ERP_KEPLER [E.25] dice IEPS sobre la base e IVA sobre base + IEPS).
  - Una sola función `pvConImpuesto` en `libs/commercial/src/lib/shared/`, probada contra `14030` y
    `96158`; la usan el alta y quien más la necesite.
  - Mientras no esté medido, la ficha muestra **«PV sin impuesto (factor fiscal no medido)»**, no un
    PV con impuesto supuesto.

**5. Lo autorizado en el alta se vuelve dato del motor.**
- **La autorización se guarda en la solicitud** (`margin_authorized_by/at/reason/pct`, §7.1); **no
  toca `commercial.margin_targets`**. Motivo: `margin_targets` pide el `product_id` de
  `catalog.products` (FK, mig `20260929170000` l. 67-105, 139-142) y al autorizar el producto todavía
  no existe; una fila con `product_id` NULL se volvería **la meta default de todo el catálogo**
  (`margin-target.ts:57-100`). Así, el caso común (bajo meta, sin meta propia) también queda
  registrado y NP.7.1.18 tiene de dónde leerlo.
- Si Dirección Comercial autoriza para el SKU una meta **propia** (distinta a la de su
  categoría/proveedor), la fila de producto en `margin_targets` la escribe **NP.7.2.5 al ligar**:
  resuelve `catalog.products.id` por el SKU y escribe `source = 'manual'`, `manual_lock = true`,
  `updated_by`, `evidencia = 'product_sheet:<id> · motivo'`. Si el producto aún no existe en
  `catalog.products`, queda **pendiente y se declara**. ⛔ Nunca con `product_id` NULL. Sin meta
  propia, **no se escribe nada**: el SKU hereda por la cascada (no se copia la meta de la categoría a
  cada producto). (❌ Antes decía que la fila se escribía al autorizar: reemplazado 2026-11-01.)
- Desde que el código existe en `kdii`, el SKU entra solo al triage del motor (`v_price_action`):
  **el motor lo vigila desde su primer día**, sin paso manual.
- **Plan contra real** (el sentido original de `[NP.7]`): el margen autorizado en el alta se compara
  a 30/60/90 días contra los tres márgenes que NP ya mide (`[NP.15]`: lista, real `c62`, sobre lo
  pagado). La pantalla de Productos nuevos muestra «planeado 12.1 % · real 9.4 %».

**6. Cierre del lazo para unidades (lo que la foto no garantiza).** Con la **primera entrada** del
proveedor (`X-A-40`, ver NP `llegada`), la Suite comprueba:
- **Factor:** `costo del peldaño de la entrada (X-A-40) / costo base` = factor capturado (98.3 % de
  concordancia medida en el maestro; ERP_KEPLER §2.1.1).
- **Costo:** lo pagado contra lo negociado en la solicitud, en la misma unidad, con la tolerancia del
  punto 2 (media unidad de precisión de `c77` × factor).

Si no cuadra, sale como hallazgo de la solicitud (`con_diferencias`) y en Incidencias del catálogo.
⛔ **Se corrige la ficha en Kepler**, no se compensa en una vista ni en la pantalla (ERP_KEPLER §2.1.1).

**Fuera de alcance aquí:** listas de precios por nivel de cliente (`a_1..a_3`, descuento de cliente
`kdud.c17`) y precio de la competencia. La ficha de alta sólo fija costo, margen y PV por peldaño.

### 5.9 ⭐⭐ Proyección de vida comercial: el número que JUSTIFICA el margen

> Pedido de Francisco (2026-10-28): *«que desde que se da de alta se visualice el % de valor que va a
> aprovechar la empresa en la vida comercial del producto, y con eso justificar el margen
> sugerido»*. Es **para qué** se conecta el alta con el motor: Compras y Dirección Comercial no
> aprueban un markup suelto, aprueban **cuánto le va a dejar el producto a la empresa**.

**Lo que muestra la ficha, antes de aprobar:**

```
 PROYECCIÓN DE VIDA COMERCIAL · 95805 BON O BON FRESA ED ESP 8/15G
 Basada en 14 lanzamientos parecidos (ver cuáles) · horizonte: temporada (≈ 75 días)

                        pesimista (p25)   esperado (mediana)   optimista (p75)
 Venta neta                  $ 38,200          $ 61,500            $ 92,800
 Margen de lista (ponderado)  12.1 %            12.1 %              12.1 %
 Fuga: descuento s/ lista     1.82 %            1.82 %              1.82 %
 = margen realizado           10.47 %           10.47 %             10.47 %
 Utilidad bruta              $  4,000          $  6,440            $  9,720
 Capital en inventario       $ 24,000          (compra inicial)
 Remanente al cerrar temporada   18 %   ← riesgo de liquidar abajo de costo
 Equilibrio: tendrías que perder más de X % del volumen para ganar menos que con el sugerido
 ──────────────────────────────────────────────────────────────────────────────
 [pi-check] Margen de lista 12.1 % ≥ meta 11.55 % (default medido, nadie la firmó) → no pide autorización
   Realizado esperado 10.47 % · realizado de su categoría: Y %   (sin meta de realizado)
 NO MEDIDO: costo logístico, costo de capital, apoyos del proveedor sin atribuir
```

*(Cifras ilustrativas: ninguna está medida. La forma es lo que se pide.)*

**La fuga NO se resta como puntos de margen.** Un descuento sobre lista baja la venta y no el costo:

```text
margen_realizado = 1 − (1 − margen_lista) / (1 − d)      d = descuento sobre lista (fracción)
utilidad         = venta_neta × margen_realizado
```

Con lista 12.1 % y d = 1.82 % → **10.47 %** (restar 1.8 pp daba 10.3 %, mal). La «Venta» del
cuadro es **neta** (después del descuento). Si la fuga se toma **ya medida en puntos de margen**
(NP `[NP.15]`: margen de lista contra real `c62`), **no** se le aplica la fórmula: se resta tal cual.
La proyección dice en pantalla **cuál de las dos fuentes usó** (descuento del motor `[PR.E0d]` o
diferencia lista→real de NP).

**De dónde sale cada renglón (todo del motor y de NP, nada nuevo inventado):**

| Renglón | Fuente | Estado hoy |
|---|---|---|
| **Lanzamientos parecidos** | `analytics.mv_new_products` (NP): por cada lanzamiento, `venta_dia` desde su primera actividad, `venta_unidades`, `margen_plaza`, `compra_base`, recompra. Se eligen con los mismos vecinos de §5.7 (marca, categoría, prefijo GS1, rótulo, **temporada**). **Regla de muestra:** entran sólo los que tienen `no_medible = false` y `posible_recodificacion = false`; los **descontinuados y los que no vendieron SÍ entran** (sacarlos inflaría la curva); las **promociones sólo sirven como parecidas de otra promoción**. ⚠️ `mv_new_products` sólo guarda **180 días** (mig `20261009085241_np_llegada_y_reparto.js:293, 300-301, 311, 541-550`) | 🟡 sólo lanzamientos de 180 días; no hay temporadas anteriores |
| **Curva de venta** (p25 / mediana / p75) | percentiles de la venta acumulada de esos lanzamientos, por día desde la primera actividad | ✅ derivable |
| **Horizonte** | regular: **90 días medidos** (lo que NP tiene) + extensión a 12 meses con la venta madura de los hermanos, **venta mensual derivada de `analytics.v_sellout_daily`** (la misma fuente de NP), acotada a los SKUs hermanos y a 12 meses, **con banda más ancha y rotulada «extrapolado»**. ⛔ No usar `analytics.product_sales_monthly`: la llena un importer (mig `20260701180000_analytics_product_sales_monthly.js:18`; regla 1). Un hermano sin 12 meses de historia sale «NO MEDIDO». De temporada (la foto lo detecta: «Edición especial», San Valentín, Navidad…): **la temporada**, medida con lanzamientos de temporadas anteriores mediante una **vista derive-no-copy sobre `mv_kepler_sales_daily` con ventana anual** (NP.7.1.19); mientras no exista, «NO MEDIDO: sin temporadas anteriores» | ⚠️ 90 d medidos; 12 meses y temporada se declaran |
| **Margen de lista** | el markup sugerido (§5.8), convertido a margen sobre venta con la conversión del motor, ponderado por la mezcla de peldaños de los hermanos | ✅ |
| **Fuga sobre lista** | lo que el motor ya mide: descuento sobre lista **1.82 %** global en 30 d (`[PR.E0d]`); por categoría/proveedor si alcanza la muestra. Y lo que NP ya mide en lanzamientos: margen de lista contra real `c62` (`[NP.15]`). El descuento entra con la fórmula de arriba; la diferencia de NP ya viene en puntos y se resta tal cual. Se dice cuál se usó | ✅ medido |
| **Descuentos y apoyos del proveedor** | cascada de Fase MR: `analytics.erp_purchase_adjustments`, `erp_supplier_payments.descuento` (✅ vivos); `erp_promotions` **sin atribución a SKU** | 🟡 parcial, se declara |
| **Capital en inventario** | compra inicial propuesta × costo; días para recuperarlo con la curva esperada | ✅ |
| **Remanente / caducidad** | lo que los lanzamientos parecidos tenían en existencia al cerrar su horizonte (NP: `llegada`, existencia por plaza) + `Días de caducidad`. **Crítico en temporada**: lo que sobra después del 14-feb se liquida | 🟡 derivable, medir |
| **Costo logístico** | `logistics.shipment_expenses` = **0 filas** (FASE_MR §1) | ❌ **NO MEDIDO**, se dice en pantalla |
| **Costo de capital** | E5 `no_existe` en el registro del motor | ❌ **NO MEDIDO**, se dice en pantalla |

**Cómo justifica el margen:**
1. Con el markup sugerido se calcula el **margen realizado esperado** (lista con la fuga de la
   fórmula de arriba ± cascada medida).
2. **El veredicto contra la meta usa el margen de LISTA ponderado** por la mezcla de peldaños de los
   hermanos (venta de 90 días por peldaño, **promediando márgenes y no markups**; sin venta en algún
   peldaño → NO MEDIDO). **Es el único que pide autorización.** La meta (`resolveMarginTarget`,
   §5.8) es de lista: comparar contra ella un realizado haría que un producto exactamente en la
   política de su categoría pidiera siempre autorización.
   - lista ≥ meta → «el margen de lista cumple la meta».
   - lista < meta → pide **autorización de Dirección Comercial** (NP.7.2.7), y la proyección queda
     adjunta como la evidencia que se firmó.
   - **El realizado esperado se muestra aparte**, contra el realizado de su categoría, **nunca contra
     `margin_targets`**. Hoy no existe una meta de realizado (D14).
   (❌ Antes comparaba el realizado contra la meta: reemplazado 2026-11-01.)
3. **Comparador de markup:** la ficha deja mover el markup y recalcula utilidad y margen realizado
   con la **función pura** de NP.7.1.21 (la aritmética de `MarginEngineService.simular` extraída a
   `libs/commercial/src/lib/shared/`, que recibe costo y PV: `simular` no sirve para un SKU que no
   existe).
   ⛔ **Con el volumen FIJO.** La elasticidad no está medida: el motor la intentó y el placebo la
   tumbó (FASE_PR §13). Subir el precio NO baja el volumen en la proyección, y la pantalla lo
   dice: *«el efecto del precio sobre el volumen no está medido»*. Inventarlo sería dibujar un
   número que justifica cualquier precio.
   ⚠️ **Con el volumen fijo, el comparador siempre premia subir el precio.** Por eso muestra también
   el **umbral de equilibrio** con `analytics.fn_umbral_equilibrio(pv_sugerido, costo, pv_nuevo)`
   (referencia: el PV sugerido): *«tendrías que perder más de X % del volumen para ganar menos»*.
   Si la función devuelve NULL: «no calculable».

**Reglas de honestidad (ADR-056, ley 0 del estándar de interfaces):**
- Siempre **rango**, nunca un número solo. Con **menos de 5 lanzamientos parecidos**, la proyección
  dice «sin base suficiente (N parecidos)» y **no se muestra la cifra**. No es un cero ni un
  promedio general.
- Cada renglón NO MEDIDO aparece **como renglón**, con su nombre. No se omite ni se suma como cero.
- Se dice qué parte es **medida** (90 d) y qué parte es **extrapolada**.
- Se muestra **cuáles** lanzamientos se usaron (clic → su ficha en Productos nuevos).

**La proyección también aprende (como §5.7):**
- Al aprobar, la proyección se **congela** en la solicitud (`projection` jsonb, con la lista de
  lanzamientos usados y las fuentes). Es un snapshot: permitido, porque es la promesa de ese día.
- A 30/60/90 días, **plan contra real** (§5.8 punto 5, `[NP.15]`): venta, margen realizado y
  remanente contra lo proyectado. Esto ya es el pedido original de `[NP.7]` («inversión y meta
  planeadas → plan contra real»).
- **Prueba hacia atrás del proyector:** con los lanzamientos ya cerrados de `mv_new_products` (de 90
  a 180 días: la vista no guarda más), se esconde cada uno, se proyecta con sus parecidos y se mide
  **cuántas veces la venta real cayó dentro del rango p25–p75**. ⚠️ Con pocos parecidos, el rango
  p25–p75 **no** cubre la mitad: la cobertura esperada depende de n (≈ **33 % con n = 5**, ≈ **43 %
  con n = 14**). Se compara contra **la esperada para su n**, y se publica **por tramo de n**. Si cae
  mucho menos que la esperada, el rango es demasiado angosto y se ensancha. Ese porcentaje **se
  publica junto a la proyección** («con N parecidos, nuestras proyecciones aciertan el rango N % de
  las veces; lo esperado es E %»).
- Se mide también el **error de la mediana** y la **pérdida por cuantiles** (*pinball loss*) de p25,
  mediana y p75.
- Control negativo: proyectar con lanzamientos **al azar** en vez de parecidos tiene que dar **peor
  error y peor pérdida** (no peor cobertura: el azar puede dar un rango ancho que cubra igual). Si no,
  los «parecidos» no aportan nada y hay que decirlo.
- Antes de construir, en C0 se **publica el n** de lanzamientos cerrados (de 90 a 180 días) y su
  rango de fechas (NP.7.0.10). Con n < 30: «muestra chica», y así se rotula la prueba.

---

### 5.10 ⭐⭐ Política de markup por papel de la unidad y precio al consumidor (Francisco, 2026-11-01)

> ⛔ **Los VALORES de esta política no están en el repo** (Francisco, 2026-11-03: el repo es público y
> los pisos de markup, los precios del canal y la evidencia de mercado son información del negocio).
> Aquí queda el MÉTODO con nombres simbólicos (`P_may`, `P_res`, `P_cons`; `E_may`, `E_res`).
> Los valores y el registro de evidencias viven en la skill local `precio-consumidor` (fuera del repo)
> y, al construir NP.7.1.23, en configuración privada de la base — **nunca** en una constante del código.

**1. Pisos de markup (sobre el costo de llegada), por PAPEL de la unidad, no por su número:**

| Unidades | Unidad | Papel | Piso NUEVOS (vigente) | EXISTENTES (traslado, Motor de Margen) |
|---|---|---|---|---|
| 2 | inferior | reseller | **`P_res`** | `E_res` |
| 2 | mayor | mayorista | **`P_may`** | `E_may` |
| 3 | inferior | consumidor final | **`P_cons`** | sin dato |
| 3 | media | reseller | **`P_res`** | `E_res` |
| 3 | mayor | mayorista | **`P_may`** | `E_may` |

- «Mayor» = la de **mayor factor**. Los tres pisos son **reglas duras** del alta (NP.7.1.23): por
  debajo → autorización de Dirección Comercial (NP.7.2.7).
- ⭐ **Los pisos son el mínimo, no la meta: la dirección es subir el markup.** Sugerido por peldaño =
  **máx(piso, mediana de los parecidos del mismo papel)**, y la pantalla dice cuál ganó y cuánto más
  dejaría en la vida comercial fijarlo arriba del piso (§5.9). Entre el piso y el sugerido, Compras
  escribe un motivo de una línea (se guarda en `sheet`): así se mide cuánto markup se deja en la mesa.
- Los productos **existentes** (parecidos) están en sus pisos de traslado o abajo: por eso la mediana de los
  parecidos **no** puede ser el sugerido sin el piso.
- ⚠️ **D11 se vuelve necesaria:** las dos políticas son **por peldaño** y `commercial.margin_targets`
  no guarda peldaño. Recomendación fuerte al dueño del motor.
- **Control conocido** (prueba de NP.7.1.23): un producto con los tres precios y el costo conocidos
  cuyo markup por papel cuadra con los pisos. Vive con los valores, fuera del repo.

**2. Precio sugerido al público en el catálogo ampliado, para TODOS los productos.** Aunque Kepler no
tenga la unidad consumidor (Mega Dulces muchas veces no la vende), es información para la fuerza de
ventas y para asesorar al cliente.
- **Unidad consumidor = la presentación tal como la compra el consumidor**, según la **ocasión**:
  regalo (el estuche entero), antojo/impulso (la pieza suelta), compartir/despensa (bolsa o granel).
  La IA propone la ocasión desde la foto (edición especial, etiqueta «Para / De»); Compras confirma.
- **Fuente, en orden:** precio **impreso** en el empaque > evidencia del registro de la skill para
  esa categoría y ocasión (multiplicador de canal) > **piso de consumidor calculado**. La ficha dice
  cuál usó; sin evidencia: «calculado con el piso, sin evidencia de mercado».
- **Precio del canal correcto:** en regalo, el del canal de regalo (el estuche en una tienda de
  regalo), **no** el precio combinado de la tienda de Mega Dulces, que es tienda de volumen.
- **Lo que gana el cliente** («lo compras a $X · se vende a $Y · ganas $Y − $X por pieza, en %») y el
  **precio por pieza entre presentaciones** del mismo producto (la pieza en estuche contra la suelta:
  la prima de regalo), ligando las presentaciones en la ficha.
- Siempre rotulado: **«Precio sugerido al público — referencia, no es precio de venta de Mega
  Dulces»**; nunca se mezcla con precios de Kepler. Lo ven vendedores, telemarketing, portal B2B,
  verificador y folletos.
- ⛔ **La Suite no captura hoy el precio al público en tiendas** (verificado 2026-11-01). El registro
  de evidencias es por ahora lo dicho por Compras; sus fuentes futuras están en la skill §7.

**Abiertas (D21–D22):** qué incluye el «precio como llega» (flete no medido; descuentos de factura) ·
traslado de la unidad consumidor en productos existentes · redondeo a precios de mostrador.

## 6. Las capas

> Estas tablas son las de las **altas (tramo 2)**, ordenadas por número sin renumerar. Las del
> **levantamiento (tramo 1)** están en una sola tabla por capa en §10b.5. Del tramo 2, el tramo 1
> sólo usa **NP.7.0.5** (la tabla con `origin`) y **NP.7.0.9** (almacén de fotos).

### C0 · Dato

| # | Item | Estado | Verificado contra |
|---|---|---|---|
| NP.7.0.1 | **Mapear la pantalla de alta a `kdii`**: correr `node scripts/kepler/kpl-decode.mjs` sobre la forma de catálogo y fijar columna **sólo de lo que falta**: Naturaleza, Imagen, Moneda, Código proveedor, Unidad alterna de compras / factor, Clave SAT, Unidad SAT, Objeto de impuesto / IVA exento (campos CFDI; **cómo guarda Kepler exento vs tasa 0 %**, con dos fichas reales: una exenta y una a tasa 0, §5.7 punto 2), Ubicación, Comentarios. (Línea `c3`, Tipo `c4`, Grupo `c5`, IVA `c18` e IEPS `c19` **ya están mapeados**: `ficha-sucursales.sql.ts`, ERP_KEPLER [E.25]; las tasas se guardan ≤ 0 = incluidas en el precio.) Resolver el choque `c8` familia/proveedor. Medir el largo máximo de `c2`. Medir la **precisión (decimales) de `c77`** (§5.8 punto 2). Medir con SKUs IVA 16 + IEPS 8 **qué factor reproduce `precio_ficha`** (§5.8 punto 4, `pvConImpuesto`). **Definir y verificar cómo se traduce** la Línea/Grupo de Kepler a `catalog.categories.name` y el proveedor a `catalog.suppliers.code` (lo necesita `resolveMarginTarget` para encontrar una meta de categoría o proveedor, §5.8 punto 3). Escribir el resultado en `docs/ERP_KEPLER.md` (nueva sección) | ⬜ | **ficha real de 3 SKUs** abiertos en Kepler contra la fila de `kepler_ods.kdii`, valor por valor (mismo método que §2.1.1 con el 96158); **3 SKUs pasados por `resolveMarginTarget`** con su categoría y proveedor traducidos (hoy deben caer al default) |
| NP.7.0.2 | **Regla de la clave**: ¿consecutiva global, por rango, por línea? Medir sobre `kdii.c1` de las altas de los últimos 90 días | ⬜ | confirmación de Compras (D5) |
| NP.7.0.3 | **Métrica 2, HOY**, con **exactamente** la lista cerrada de la cabecera: SKU activo con al menos uno de (a) clave SAT `01010101` (en `kdii` **y también** en `catalog.products.sat_clave_prod_serv`), (b) moneda USD con proveedor nacional, (c) unidad base `2 KILOGRAMO` en producto por pieza. **Publica el desglose** (a)/(b)/(c) y los conteos separados de base activa y de altas de 90 días. Los vacíos no cuentan. Script de **sólo lectura** contra prod (`francisco` RO) | ⬜ **medido en Padre Hidalgo 2026-11-02 (§10a.2)**; faltan los 10 casos en Kepler y la red | conteo a mano de 10 casos en la pantalla de Kepler; el total coincide con la columna `cuenta_metrica_2` de NP.7.0.6 |
| NP.7.0.4 | **Convención de nombres**: tabla de abreviaturas sacada de `kdii.c2` existente (por marca) | ⬜ | Compras revisa 20 nombres generados |
| NP.7.0.5 | Migración `catalog.product_sheets` (§7) con `node scripts/nueva-migracion.js np7_product_sheets` | 🚀 **aplicada en prod 2026-11-03 (16:58Z)**: 36 columnas, 7 CHECK, 7 índices y RLS forzada idénticos a la migración (medido en sólo lectura); la suite ✅ en `pruebas-db` del CI del commit servido (otro tenant ve cero, `up()` idempotente, `down()` se niega con fichas). ⚠️ `down()` sobre tabla vacía NO MEDIDO; no hay índice para los apartados (se lee el JSON): medir antes de escalar — Antes: 🔨 2026-11-02: migración `20261102224652_np7_product_sheets.js` + suite `test-newdb-np7-product-sheets.js` (registrada en `run-all-tests`). ⚠️ `up()`/`down()` reales **NO MEDIDOS** en local (la conexión es prod en sólo lectura): los ejerce `pruebas-db` del CI. Estado nuevo `en_captura` (§7.1) | `up()` real sobre base vacía + `down()`; RLS probada intentando leer otro tenant; **una fila por origen y estado** (los 9 de alta y los 6 de levantamiento) entra, y un estado de levantamiento con `origin='alta'` (p. ej. `publicada`) da **rojo** por el CHECK; dos altas vivas con el mismo EAN → rojo; dos levantamientos vigentes del mismo SKU → rojo, pero uno `historica` con `superseded_at` + uno vigente → entra; autorizador de margen con motivo vacío → rojo |
| NP.7.0.6 | **Etiquetas limpias** (§5.7): **vista** `derive-no-copy` sobre `kepler_ods.kdii` con los campos de §5.7 por SKU y una marca `etiqueta_valida` por campo (falso para `01010101`, USD con proveedor nacional, unidad de fábrica, vacíos) y una columna **`cuenta_metrica_2`** (verdadero sólo por (a)(b)(c) de la cabecera; los vacíos **no** cuentan). Una fila por SKU: decidir y documentar qué sucursal manda si difieren. Marcar si el SKU **tiene embedding** en la base vectorial (§5.7 punto 1) y **medir cuántos SKUs de `kdii` lo tienen** (hoy ~6,489 activos): ese es el universo de la prueba hacia atrás. Con `security_invoker = true` y `tenant_id` explícito (RLS no aplica a vistas, §7.1) | ⬜ | conteo a mano de 20 SKUs en Kepler; % de etiquetas inválidas por campo publicado; **`COUNT(*) WHERE cuenta_metrica_2` da el mismo número que NP.7.0.3**; conteo de SKUs con embedding publicado; dos tenants: B no ve lo de A |
| NP.7.0.7 | **Catálogos SAT** `c_ClaveProdServ`, `c_ClaveUnidad`, `c_ObjetoImp`: **vista derive-no-copy sobre `contpaqi_ods`** (`sat_c_claveprodserv`, 52,844 filas, y los equivalentes de ClaveUnidad y ObjetoImp, confirmados con `\dt contpaqi_ods.sat_c_*`). **No se crea tabla** (sería importer y copia: reglas 1 y 2). Si falta un catálogo: **parar y decirlo**. Hasta que la sincronía de CP.9.2 esté agendada, la vista declara la fecha de su última réplica. Anotar quién llena hoy `catalog.products.sat_clave_prod_serv` / `sat_clave_unidad` (columnas que ya existen) | ⬜ | 5 claves conocidas existen; `01010101` sale como no válida para mercancía |
| NP.7.0.8 | `catalog.fiscal_rules_approved` (combinaciones aprobadas por fiscal: grupo → IVA/IEPS/SAT/unidad/objeto, con quién y cuándo) y `analytics.np7_field_accuracy` (snapshot semanal de **las dos** pruebas hacia atrás, la del kNN y la del proyector: fecha, `prueba` (`'campo'` \| `'proyeccion'`), `grupo_control` (real o barajado/al azar), campo, nivel de acuerdo, aciertos, total, `cota_inferior_95`, `n_minimo_aplicado`; **una sola tabla, sin tabla hermana**). Ambas con `tenant_id` + auditoría. **Se generan con `node scripts/nueva-migracion.js`**, igual que NP.7.0.7 | ⬜ | `up()` real; RLS; un `prueba` fuera de la lista → rojo por el CHECK |
| NP.7.0.9 | **Almacén de fotos.** (a) GB estimados: medir el peso real de 20 fotos tomadas con el flujo de captura y proyectar a ~6,500 SKUs × peldaños × caras + altas. (b) Bucket **separado de `comprobantes`**: el `imagenes` de Garage, o un prefijo con **ciclo de vida propio** (RUNBOOK-bucket-propio). (c) Cómo las sirven el verificador y el folleto: **no** con la URL firmada de 10 minutos de `ObjectStorageService` (sirve para revisar, no para publicar). (d) Retención (§10b.6 pregunta 8): se guardan la ficha vigente y la anterior; las rechazadas por calidad se borran a los 7 días; las que tienen persona, al detectarlas (§10b.3 punto 7); las de altas descartadas, D20. Tarea diaria de limpieza con latido en `CRON_JOBS` | ⬜ **El primer corte salió SIN este item (deuda con nombre, regla 16).** Medido 2026-11-03: la foto cae en el bucket que ya usa la app (`S3_BUCKET`; el runbook dice `comprobantes`, el valor real NO MEDIDO porque vive en el secreto) con la llave `levantamiento/<sucursal>/<sku>/<uuid>.jpg`, **sin tenant** (NP.7.2.1 pedía `catalog/${tenantId}/…`). El almacén sí escribe hoy (otras subidas de prod después del último arranque). Sin retención ni limpieza; GB libres NO MEDIDOS; **el peso de cada foto no se guarda** (`FotoFicha` trae ancho y alto, no bytes), así que «MB por ficha» no sale de la base | GB medidos con 20 fotos reales (no estimados de memoria); una foto rechazada de hace 8 días ya no está y una de 6 sí; el latido aparece |
| NP.7.0.10 | **n de la prueba del proyector** (§5.9): contar los lanzamientos cerrados de `mv_new_products` (de 90 a 180 días) que pasan la regla de muestra (`no_medible = false`, `posible_recodificacion = false`; descontinuados y sin venta sí cuentan) y publicar su rango de fechas. Sólo lectura | ⬜ **medido 2026-11-02: n = 416 (§10a.3)** | conteo cruzado contra `mv_new_products` con un `COUNT(*)` independiente; con n < 30 se rotula «muestra chica» |

⛔ NP.7.0.1 **bloquea** los campos CFDI/SAT y Naturaleza de §5.7 (NP.7.1.8–.1.11), y NP.7.2.5. Sin ella, esos campos salen «sin fuente». El kNN **puede arrancar** con las 5 etiquetas ya mapeadas (Línea `c3`, Tipo `c4`, Grupo `c5`, IVA `c18`, IEPS `c19`).

### C1 · Dominio

| # | Item | Estado | Prueba que lo ejerce |
|---|---|---|---|
| NP.7.1.1 | Contrato `ProductSheet` en `libs/contracts/src/http/product-request.contract.ts`: cada campo `{ valor, fuente: 'foto'|'sistema'|'hermano'|'compras', confianza, evidencia, revisar }` (forma en §7.2) | ⬜ | consumidores tipados (API, pantalla, lector) |
| NP.7.1.2 | Lector `extractProductSheet(fotos)` en [`llm-extractor.service.ts`](../../../libs/platform-core/src/lib/ai/llm-extractor.service.ts), mismo patrón que `extractExpiryLabel` (l. 403): `toolChoice` forzado a `extract_product_sheet`, `input_schema` generado del contrato. Prompt: «sólo lo que se ve; lo ilegible es `null` con razón; cada dato con la foto de donde salió» | ⬜ | **corpus**: 95805 + 19 productos más con ficha conocida (estilo `ai-product-matcher.corpus.spec.ts`). Medir % de campos correctos por modelo (D2) |
| NP.7.1.2b | **Decisión D2 registrada**: con el resultado del corpus de NP.7.1.2, Edgar elige el modelo del lector y queda su ADR (costo por ficha y % de campos correctos de cada modelo) | ⬜ | ADR escrito con los números del corpus; el lector usa el modelo elegido (una prueba lo lee de la configuración) |
| NP.7.1.3 | EAN: lector `@zxing` **en el navegador** + el servidor revalida el dígito verificador (sólo si tiene forma GS1; `C`+clave es válido sin verificador) + búsqueda exacta, sin quitar ceros, en las 9 casillas de `kdii` (Base `c7`/`c93`/`c102`, Dos `c82`/`c95`/`c96`, Tres `c85` + `c97`/`c98` sin verificar), reusando `unidadDelCodigo`/`resolverCodigo` de `checado-codigo.ts` (§5.1) | ⬜ | unit: `7500443006889` válido; 1 dígito cambiado → inválido; `C06001` válido sin verificador; EAN existente → bloquea; **código guardado sólo en `c102` → bloquea** (no «no existe»); `006001` ≠ `06001` |
| NP.7.1.4 | Cuadres §5.2 | ⬜ | unit por cuadre, cada uno roto a propósito una vez |
| NP.7.1.5 | ~~Producto hermano §5.3~~ ❌ **Absorbido por NP.7.1.8 + NP.7.1.9** (§5.3 reemplazada por §5.7). Su prueba de «< 3 de 5» pasa a NP.7.1.8 | ❌ | — |
| NP.7.1.6 | Nombre §5.5, IEPS §5.6 (lista del inciso J aprobada **y** kcal ≥ 275), moneda MXN por proveedor nacional | ⬜ | unit; chocolate aprobado en 274/275/276 kcal → 0/8/8; **polvo para bebida de 380 kcal → revisar**; **grupo sin aprobar con 400 kcal → revisar**; **chocolate sin kcal legible → revisar** |
| NP.7.1.7 | **Comparador ficha ↔ `kdii`** (para NP.7.2.5): por campo, `igual` / `distinto` / `formato_interno` / `sin_mapear`. Si Kepler tiene `C`+clave y la ficha un DUN-14 en el mismo peldaño → `formato_interno`, no `distinto`. IVA/IEPS se comparan por valor absoluto (Kepler los guarda ≤ 0) | ⬜ | unit + una fila real; `C06001` en Kepler vs DUN-14 en la ficha → `formato_interno`; IEPS `-8` vs `8` → `igual` |
| NP.7.1.8 | **Predictor kNN** (§5.7 punto 1), **en dos pasos unidos en TS** (no un solo SQL): (a) vecinos desde la base vectorial (`KNEX_VECTOR_DB`, `active_product_embeddings`) + prefijo GS1 + proveedor + atributos de foto; (b) etiquetas desde la vista NP.7.0.6 en la base principal → por campo `{ valor, acuerdo: 'votos de 5', vecinos[] }`. **k = 5, voto por conteo; acuerdo = votos del ganador** (pesos sólo si la prueba hacia atrás demuestra que mejoran, con las mismas cubetas en predictor y calibración). Sólo usa etiquetas válidas de NP.7.0.6. Sin `VECTOR_DATABASE_URL` → «sin hermanos por significado» (`measured: false`), nunca «0 vecinos» | ⬜ | unit con vecinos sintéticos (mayoría, empate, **< 3 de 5 → revisar**, etiqueta inválida excluida); sin `VECTOR_DATABASE_URL` → `measured: false`, no 0; prefijo GS1 (§5.7 punto 1): `96158` → sin señal; código que empieza con `2` → sin señal; `C`+clave → sin señal |
| NP.7.1.9 | **Reglas duras** (§5.7 punto 2) aplicadas después del predictor, incluida **exento ≠ tasa 0 %** (exento = S ⇒ sin tasa; tasa 0 ⇒ exento = N) e IEPS sólo dentro de la lista del inciso J. En la prueba hacia atrás **no** se aplican a la etiqueta de Kepler | ⬜ | unit por regla, cada una rota a propósito una vez; **un producto a tasa 0 sale exento = N; un exento sale sin tasa** |
| NP.7.1.10 | **Prueba hacia atrás** (§5.7 punto 3): *leave-one-out* sobre la vista NP.7.0.6 (una fila por SKU; al esconder un SKU se esconden los que comparten EAN o están marcados `posible_recodificacion`) **+ prueba temporal** (altas de 180 días predichas sólo con lo anterior); manda el menor acierto. Mide **sólo sobre el universo con embedding** y lo declara (ampliarlo es otro item). Publica por campo: acierto, línea base de clase mayoritaria, matriz de confusión, precisión por clase, cota inferior de Wilson 95 % y n. **Corre como tarea del API en prod** (patrón `AnalyticsRefreshService`, latido en `CRON_JOBS`), domingo de madrugada, y escribe en `analytics.np7_field_accuracy`. **La primera corrida —la MÉTRICA HOY de §5.7— también corre ahí, nunca desde la laptop** (`francisco` es de sólo lectura). Se publica cuánto tarda | ⬜ | control: con etiquetas barajadas el acierto cae a la **tasa de la clase mayoritaria**, y ese número se publica (si no cae, el instrumento está mal); un SKU con EAN repetido no se encuentra a sí mismo; el latido aparece; duración publicada |
| NP.7.1.11 | **Autonomía por campo** (§5.7 puntos 3 y 5): lee el último snapshot y autollena sólo si se cumplen las tres: (a) acierto > línea base + margen D7; (b) precisión de la **clase predicha** ≥ umbral; (c) cota inferior de Wilson 95 % ≥ 98 % / 99.5 % con n ≥ 150 / 600. Sin n suficiente → «sin base suficiente (n)». Revoca con **k errores en las últimas N** (N y k de D7); pasa `revisar: false` sólo si cumple | ⬜ | unit: snapshot que cumple las tres → autollenado; acierto alto pero precisión de la clase predicha bajo umbral → no; n = 100 en un campo operativo → «sin base suficiente (100)»; k errores en las últimas N → revoca |
| NP.7.1.12 | **Desempate con Claude** (§5.7 punto 6) en `llm-extractor.service.ts`, tool forzado, siempre `revisar: true` | ⬜ | corpus: medir cuántos empates resuelve bien; declararlo |
| NP.7.1.13 | **Escalera** (§5.8 punto 1): propuesta de Base/Dos/Tres desde foto de caja master + hermanos; rótulo de lista cerrada; factores enteros crecientes | ⬜ | unit: escalera de 1, 2 y 3 peldaños; factor decreciente → rechazo; rótulo fuera de lista → rechazo |
| NP.7.1.14 | **Costo desde la unidad negociada** (§5.8 punto 2): baja a Base y sube por factor; muestra la cuenta. El peldaño negociado conserva su costo exacto; la Base con la precisión de `c77` (medida en NP.7.0.1); tolerancia = ½ unidad de precisión × factor | ⬜ | unit: $X por bulto ÷ 24 → caja; caso escalera corrida (`91059`: 500/CJA/""); `00303` CJA $553.97 con factor 50 → se queda en $553.97 y no sale «con diferencias» |
| NP.7.1.15 | **Markup por peldaño** (§5.8 punto 3) desde `v_kepler_margin_target` de los hermanos (mismo rótulo) + conversión markup↔margen **del motor** + meta con `resolveMarginTarget` + **`pvConImpuesto`** única en `libs/commercial/src/lib/shared/` (§5.8 punto 4; el factor fiscal lo mide NP.7.0.1; sin medir → «PV sin impuesto (factor fiscal no medido)») | ⬜ | unit: `14030` markup 26.40 → margen 20.89; `70001` 19.7070 → 16.46 (control de CE); meta por cascada categoría/proveedor/default; `pvConImpuesto` reproduce `precio_ficha` de `14030` y `96158`; **sin fila de categoría, el resolvedor devuelve el default y así se rotula** («default medido, nadie la firmó», por `target_source`); **veredicto contra meta con el margen de LISTA ponderado**: lista ≥ meta y realizado < meta → **no** pide autorización; lista < meta (aunque el realizado salga ≥ meta) → **sí**; mezcla con un peldaño sin venta → NO MEDIDO; el promedio pondera márgenes, no markups |
| NP.7.1.16 | **Testigo de la primera entrada** (§5.8 punto 6): factor y costo contra la primera `X-A-40` | ⬜ | una entrada sintética que cuadra y una que no |
| NP.7.1.17 | **Reglas de precio del motor como función SQL compartida** (§5.8 punto 4): sacar `escalera_incoherente` (y la regla de costo) de las migraciones de señales a una función SQL **`analytics.fn_escalera_coherente(...)`**, con migración **generada** (`node scripts/nueva-migracion.js`) e idempotente. La vista de señales (`v_price_action` / `mv_price_signals`) y el alta la llaman; **no hay copia en TS** (❌ antes decía «extraer a `libs/` en TS»: habría sido una segunda copia, regla 16). **Commit 1:** sólo extraer, mismo resultado en las 696 celdas. **Commit 2** (si se aprueba D12): tolerancia de **$0.01** dentro de la función y regla completa de todo par i < j, con antes/después. Ambos **fuera de horario hábil** (por el REFRESH de `mv_price_signals`), una migración a la vez | ⬜ | commit 1: las 696 celdas dan el mismo veredicto antes y después; commit 2: brecha $0.0006 → no dispara, $0.02 → dispara, antes/después publicado (regla 15); escalera de 3 peldaños donde la Dos sale más cara por Base que la Base → **dispara**; el alta llama a la función SQL — si calcula por su cuenta, **rojo** |
| NP.7.1.18 | **Plan contra real** (§5.8 punto 5): margen autorizado en la solicitud vs `[NP.15]` a 30/60/90 | ⬜ | unit con una solicitud ligada y su serie de NP |
| NP.7.1.19 | **Proyector de vida comercial** (§5.9): lanzamientos parecidos de `mv_new_products` (regla de muestra de §5.9) → curva p25/mediana/p75, margen realizado esperado con `margen_realizado = 1 − (1 − margen_lista)/(1 − d)` y `utilidad = venta_neta × margen_realizado` (función con nombre; si la fuga viene en puntos de `[NP.15]` se resta tal cual y se dice cuál fuente), ± cascada MR medida, capital, remanente, **umbral de equilibrio** con `analytics.fn_umbral_equilibrio(pv_sugerido, costo, pv_nuevo)`; extensión a 12 meses con venta mensual derivada de `analytics.v_sellout_daily` (⛔ no `product_sales_monthly`); temporada con vista derive-no-copy sobre `mv_kepler_sales_daily` con ventana anual (mientras no exista: «NO MEDIDO: sin temporadas anteriores»); renglones NO MEDIDO explícitos; mínimo 5 parecidos | ⬜ | unit con lanzamientos sintéticos; < 5 parecidos → «sin base», nunca cifra; **(12.1 %, 1.82 %) → 10.47 %**; umbral de equilibrio con un caso conocido y NULL → «no calculable»; hermano sin 12 meses → «NO MEDIDO»; la suma mensual cuadra contra `v_sellout_daily` en un mes cerrado; un descontinuado entra a la muestra y una promoción no es parecida de un regular |
| NP.7.1.20 | **Prueba hacia atrás del proyector** (§5.9): sobre lanzamientos cerrados (n de NP.7.0.10): cobertura del rango p25–p75 **contra la esperada para su n**, publicada por tramo de n; error de la mediana y pérdida por cuantiles; control con parecidos al azar; resultado al snapshot semanal en `analytics.np7_field_accuracy` con `prueba = 'proyeccion'` (NP.7.0.8; corre en la misma tarea del API que NP.7.1.10) | ⬜ | **MÉTRICA HOY de la proyección**: su primera corrida. Unit: con n = 5 la cobertura esperada es **33 %**. Control: al azar debe salir **peor el error y la pérdida** (no la cobertura) |
| NP.7.1.23 | **Pisos de markup por papel de la unidad** (§5.10 punto 1): papel por número de peldaños (2 → reseller/mayorista; 3 → consumidor/reseller/mayorista), pisos de nuevos por papel (`P_may`, `P_res`, `P_cons`), sugerido = máx(piso, mediana de parecidos del mismo papel), motivo obligatorio entre piso y sugerido; la REGLA vive en `libs/commercial/src/lib/shared/` (una sola fuente) y los VALORES en configuración privada de la base, nunca en el código (el repo es público); los de existentes (`E_may`, `E_res`) los usa el Motor de Margen | ⬜ | unit: el control conocido cuadra con los pisos; un peldaño apenas bajo su piso → pide autorización; la pieza bajo su piso con 2 peldaños → pide autorización; «mayor» = mayor factor con escalera corrida (`14030`); sugerido nunca < piso |
| NP.7.1.24 | **Precio sugerido al público** (§5.10 punto 2): ocasión de consumo (IA propone, Compras confirma), unidad consumidor por ocasión, fuente impreso > registro de la skill `precio-consumidor` > piso calculado, ganancia del cliente y precio por pieza entre presentaciones ligadas; rótulo de referencia obligatorio | ⬜ | unit: el estuche de regalo usa el precio del canal de regalo, no el de la tienda MD; sin evidencia → «calculado con el piso»; el precio impreso gana sobre el calculado; la respuesta nunca lo pone en un campo de precio de Kepler |
| NP.7.1.21 | **Aritmética del simulador como función pura** (§5.8 punto 3, §5.9 punto 3): extraer de `MarginEngineService.simular` (margen nuevo, `fn_precio_aterriza`) una función pura en `libs/commercial/src/lib/shared/` que reciba costo y PV. `simular` la reusa; el alta la llama con el costo negociado; el umbral de equilibrio usa el PV sugerido como referencia. NP.7.3.6 depende de este item | ⬜ | mismo resultado que `simular` sobre **5 SKUs reales**; un SKU que no existe en el motor también da resultado (con costo y PV dados) |

### C2 · API

Controlador nuevo en `libs/commercial/src/lib/product-requests/`, prefijo `/commercial/product-requests`.

| # | Item | Estado | ¿Escribe? | Prueba contra base real |
|---|---|---|---|---|
| NP.7.2.1 | `POST /` crear solicitud (proveedor, costo, notas) · `POST /:id/photos` sube con [`ObjectStorageService.putBuffer`](../../../libs/platform-core/src/lib/storage/object-storage.service.ts) (bucket privado, **no Cloudinary**: es legado; bucket y retención de NP.7.0.9). **Al subir:** tipo validado por contenido con `detectarTipo` (JPEG, PNG, WebP o HEIC; otro → 415. `detectarTipo` también reconoce PDF y GIF: aquí se rechazan); `FileInterceptor` con tope de 10 MB por archivo y 8 archivos **por petición** (una escalera de 3 peldaños pide 5 + 3 + 3 = 11 fotos: el cliente las sube en más de una petición, una por peldaño); se **re-codifica a JPEG sin EXIF** (también convierte HEIC); carpeta `catalog/${tenantId}/product-sheets/${origin}/${sheet_id}`. Lo mismo vale para `POST /levantamiento/:id/photos` (NP.7.L.2) | ⬜ | sí | ⛔ obligatoria, con el payload de la pantalla; un PDF renombrado a `.jpg` → 415; 9 archivos en una petición → rechazo, y las 11 fotos de una escalera de 3 peldaños suben en dos peticiones; una foto con GPS se guarda **sin EXIF**; una HEIC llega a la IA como JPEG |
| NP.7.2.2 | `POST /:id/analyze` corre lector + EAN + cuadres + predictor NP.7.1.8 + reglas NP.7.1.9 (+ desempate NP.7.1.12); guarda `ai_raw` y `sheet`. Idempotente por hash de fotos (no re-cobra a la IA si no cambiaron) | ⬜ | sí | ⛔ obligatoria; IA simulada en CI, real una vez a mano y se declara |
| NP.7.2.3 | `PATCH /:id` revisión de Compras (sólo campos permitidos; cada cambio guarda `fuente: 'compras'`) · `POST /:id/approve` · `POST /:id/discard` | ⬜ | sí | ⛔ obligatoria, incluido intentar aprobar con campos «revisar» pendientes → 409; **aprobar con margen de lista ponderado bajo la meta y sin autorización vigente → 409** (maqueta D) |
| NP.7.2.4 | `GET /`, `GET /:id`, `GET /:id/kepler-sheet` (la ficha en el orden de §4) · `POST /:id/captured` (capturista marca «ya está en Kepler» → `tecleada_en_kepler`; guarda `kepler_captured_by/at`) · `POST /:id/promote` (presolicitud → `borrador`, misma fila, con `COMPRAS_ALTA_SOLICITAR`) | ⬜ | `captured` y `promote` sí | ⛔ la de `captured` y la de `promote` |
| NP.7.2.5 | **Cierre del lazo**: tarea programada (patrón `AnalyticsRefreshService` + latido en `CRON_JOBS`) que busca el EAN de las solicitudes `tecleada_en_kepler` **y `presolicitud`** en `kepler_ods.kdii` — ⛔ **sólo filas `origin='alta'`** (las del levantamiento nunca entran aquí) —, liga `sku`, corre el comparador NP.7.1.7 y pasa a `conciliada` / `con_diferencias`. **Si la solicitud trae meta propia autorizada** (§5.8 punto 5): al pasar a `ligada`/`conciliada` resuelve `catalog.products.id` por el SKU y escribe la fila de producto en `commercial.margin_targets` (`source='manual'`, `manual_lock=true`, `updated_by`, `evidencia='product_sheet:<id> · motivo'`). Si el producto no existe todavía en `catalog.products`, queda **pendiente y se declara**. ⛔ Nunca con `product_id` NULL. **Registro en NP:** al ligar, propone la clasificación «nuevo» en `catalog.new_product_reviews` con evidencia «alta Suite #id», **sin pisar una clasificación humana** que ya exista | ⬜ | sí | ⛔ con una fila de `kdii` sintética en la base de prueba; una fila `origin='levantamiento'` con el mismo EAN **no** se toca; una `presolicitud` cuyo EAN aparece en `kdii` se liga sola; **ligar con meta propia sí escribe la fila**; sin `catalog.products` → pendiente declarado, sin fila; escribir con `product_id` NULL **lanza error**; la fila default del tenant queda **idéntica** antes y después; **ligar propone «nuevo» en `catalog.new_product_reviews` con evidencia «alta Suite #id»; si ya había una clasificación humana, queda intacta** |
| NP.7.2.6 | Permisos nuevos en `libs/contracts/src/authz/permissions.ts` + `permission-meta.ts` + **`authz-tree.ts`** (sin él, `test-authz-route-coverage.js` falla) + **`role-presets.ts`**: `COMPRAS_ALTA_SOLICITAR` (crear/revisar), `COMPRAS_ALTA_APROBAR`, `COMPRAS_ALTA_CAPTURAR` (marcar `tecleada_en_kepler`) y la de margen **`COMMERCIAL_MARGIN_ENGINE_AUTORIZAR`** (Dirección Comercial: margen bajo meta o meta propia del SKU). Medido el 2026-11-01: el motor sólo tiene `COMMERCIAL_MARGIN_ENGINE_VER` (lectura), no hay clave que reusar; el prefijo es `COMMERCIAL_` (74–75 claves), no `COMERCIAL_` (0). (❌ Antes decía `COMERCIAL_MARGEN_AUTORIZAR`.) `COMPRAS_ALTA_APROBAR` y la de margen van **fuera** de todo `MODULE_GROUPS` (molde `FINANCE_PAYMENT_CALENDAR_AUTORIZAR`, MATRIZ_ACCESOS §5.1.1). **Reparto:** las 3 de Compras a sus roles; la de margen a Dirección Comercial, que hoy no tiene rol ni personas (§9). El costo viaja sólo con `COMPRAS_COSTO_ESTANDAR_VER`, quitado **en el servidor** de `negotiated_cost`, `sheet` y `projection` (§7.2, como NP decisión 9). **Excepción del capturista:** `GET /:id/kepler-sheet` entrega costo y precios de **esa** solicitud a quien tenga `COMPRAS_ALTA_CAPTURAR`, sólo si está `aprobada` o `tecleada_en_kepler`. ⛔ No se le da `COMPRAS_COSTO_ESTANDAR_VER` para esto: abre `/compras/costo-estandar` de toda la red | ⬜ | — | ⛔ regla 20: **repartirlas en prod** (las 3 a Compras, la de margen a personas designadas de Dirección Comercial), no sólo declararlas. **Costo:** un usuario sin `COMPRAS_COSTO_ESTANDAR_VER` llama `GET /`, `GET /:id`, `GET /:id/kepler-sheet`, `PATCH /:id` y `POST /:id/analyze`; ninguna respuesta trae costo, margen ni proyección; la prueba **recorre el JSON completo** y se rompe a propósito una vez (§7.2). **Capturista:** con sólo `COMPRAS_ALTA_CAPTURAR` ve el costo en `kepler-sheet` de una solicitud `aprobada`; **no** en una `borrador` ni en `GET /` |
| NP.7.2.7 | **Autorización de margen** (§5.8 puntos 4–5): `POST /:id/margin-approval` (Dirección Comercial) cuando el margen **de lista ponderado** queda bajo la meta o se pide una meta propia. **La autorización se guarda en la solicitud** (`margin_authorized_by/at/reason/pct`, §7.1); **no toca `commercial.margin_targets`** (el producto aún no existe; la fila de meta propia la escribe NP.7.2.5 al ligar). (❌ Antes escribía la fila al autorizar: reemplazado 2026-11-01) | ⬜ | sí | ⛔ obligatoria; **autorizar sin ligar no escribe nada** en `margin_targets`; motivo vacío → rechazo; **si autoriza quien solicitó o aprobó la ficha → 403**; una fila con `manual_lock` no la pisa el recalculador |

### C3 · UI

| # | Item | Estado | `check:pantalla` antes → después |
|---|---|---|---|
| NP.7.3.1 | `/compras/catalogo/solicitudes`: reemplaza el marcador de posición. Lista de solicitudes por estado, con filtro y conteo honesto (si se pagina, decir «N de M») | ⬜ | `check:pantalla -- compras` medido antes; el conteo por estado cuadra con un `COUNT(*)` de `product_sheets` (`origin='alta'`) |
| NP.7.3.2 | **Captura guiada**: el número de caras sale del peldaño (§10b.7 punto 2: 5 / 3 / 2 / 1), silueta por cara, sirve en el **navegador del celular, sin instalar** y en escritorio; muestra el EAN leído en vivo. (❌ Antes decía «6 fotos» y «Capacitor») | ⬜ | un corrugado pide 3 caras; granel pide 1 |
| NP.7.3.3 | **Revisión**: arriba sólo lo que pide a Compras (campos **C** + «revisar» + cuadres rotos); el resto plegado «N campos llenados — ver». Cada campo enseña su fuente y el recorte de la foto | ⬜ | antes → después; con 2 peldaños «Te toca» muestra exactamente los 7 campos C + los «revisar» (maqueta D); bajo meta sin autorización, «Aprobar» deshabilitado con el motivo |
| NP.7.3.4 | **Ficha para Kepler**: secciones y orden idénticos a la pantalla de Kepler, botón copiar por campo, imprimible. Muestra **la métrica por solicitud**: «Compras decidió N de M campos», con **M fijo según §4** (31) | ⬜ | antes → después; las secciones salen en el orden de §4 (comparado contra la captura de la pantalla de Kepler); «N de M» coincide con `fields_by_human/fields_total` de la fila |
| NP.7.3.5 | **Conciliación**: tras `ligada`, diferencias ficha vs Kepler campo por campo, en rojo lo distinto. Va también a la pestaña **Incidencias** del catálogo | ⬜ | antes → después; una solicitud `con_diferencias` sintética muestra sólo sus campos distintos y aparece en Incidencias; `formato_interno` no sale en rojo |
| NP.7.3.6 | **Panel «Proyección de vida comercial»** en la revisión (§5.9): rango de 3 escenarios, cascada de lista a realizado, renglones NO MEDIDO, lanzamientos usados con clic, comparador de markup con volumen fijo y su aviso + umbral de equilibrio, veredicto contra meta (margen de lista ponderado) y realizado esperado aparte. **Depende de NP.7.1.21** | ⬜ | antes → después; con < 5 parecidos el panel dice «sin base suficiente (N parecidos)» sin cifra; los renglones NO MEDIDO se ven como renglones; sin `COMPRAS_COSTO_ESTANDAR_VER` el panel no aparece |

⛔ Cargar la skill `diseno` **antes** de tocar el primer archivo. Correr `npm run check:pantalla -- compras`
antes y después. Entrada de sidebar ya existe (pestaña del Catálogo).

---

## 7. Modelo de datos

### 7.1 `catalog.product_sheets` (dato propio: fotos, lectura de IA, decisión de Compras) — `origin`: `alta` | `levantamiento` (§10b)

No copia nada de Kepler (regla 2): el maestro sigue en `kdii`. Una sola tabla: la misma fila es la
solicitud y, una vez `ligada`, el **catálogo ampliado** del SKU. **No crear una segunda tabla de
«perfil visual»**.

| Columna | Tipo | Nota |
|---|---|---|
| `id` | uuid PK | |
| `tenant_id` | uuid NOT NULL | RLS forzado (patrón `new_product_reviews`, mig `20261007360100`) |
| `origin` | text NOT NULL | `CHECK (origin IN ('alta','levantamiento'))` |
| `status` | text NOT NULL | CHECK **por origen** (abajo). Alta: §3. Levantamiento: §10b.1 |
| `ean` | text NULL | el **código base** leído por el lector, validado. Los códigos de Unidad Dos y Tres van en `sheet`, por peldaño. En granel puede ser NULL |
| `sku` | text NULL | alta: se llena al ligar. Levantamiento: se llena al escanear (el SKU ya existe) |
| `branch_code` | text NULL | sucursal donde se levantó o se reportó la presolicitud. La pone el **servidor** desde el alcance del usuario, no el cliente. En pantalla, siempre por nombre |
| `supplier_code` / `supplier_name` | text | decisión de Compras |
| `negotiated_cost` | numeric(14,4) | sólo con permiso de costo |
| `photos` | jsonb | `[{ peldaño: 'base'\|'dos'\|'tres'\|null, nivel_fisico, nivel_por: 'ia'\|'catalogo', codigo_confirmado: boolean, cara, storage_key, sha256, captured_by, saltada_motivo: null\|'no_tiene_esa_cara'\|'no_se_puede_girar'\|'otro' }]` (forma completa en §10b.7 punto 7). Una cara **saltada** se guarda como fila con `storage_key` null y su `saltada_motivo`. `captured_by` = quién tomó **esa** foto |
| `ai_raw` | jsonb | salida del lector **sin tocar** + `model` + `schema_version` + fecha |
| `sheet` | jsonb | ficha vigente (forma §7.2). Dentro, **por peldaño**: estado de publicación, los **dos testigos de la unidad (código e IA) + la confirmación de la persona**, códigos de ese peldaño y el apartado de 30 min (`sheet.peldaños.<x>.apartado = {by, until}`, el mismo nombre que §10b.3 punto 5 y NP.7.L.2; ❌ antes `reserved_by` / `reserved_until`). Se aparta con **UPDATE condicional** (sólo si no hay apartado vivo de otra persona) y cada persona tiene **máximo 3 apartados vivos**; reglas completas en §10b.3 punto 5. El apartado es por peldaño porque la ficha la completan varias personas (§10b.7 punto 2): apartar la fila entera bloquearía a recepción mientras el anaquelista fotografía la caja de 8 |
| `kepler_diff` | jsonb NULL | resultado del comparador |
| `projection` | jsonb NULL | proyección de vida comercial **congelada al aprobar** (§5.9): escenarios, fuentes, lanzamientos usados, renglones NO MEDIDO |
| `fields_total` / `fields_by_human` | int | **la métrica**, calculada al aprobar |
| `margin_authorized_by` / `margin_authorized_at` / `margin_authorization_reason` / `margin_authorized_pct` | uuid / timestamptz / text / numeric | **autorización de margen** (§5.8 punto 5). Se guarda **en la solicitud**, no en `commercial.margin_targets`: al autorizar, el producto todavía no existe en `catalog.products`. `CHECK (margin_authorized_by IS NULL OR length(trim(margin_authorization_reason)) > 0)`: si hay autorizador, el motivo no va vacío |
| `approved_by` / `approved_at`, `kepler_captured_by` / `kepler_captured_at`, `linked_at` | | `kepler_captured_*` = quién marcó «ya está en Kepler» (antes `captured_by/at`; se renombró para no chocar con `photos[].captured_by`) |
| `superseded_by` / `superseded_at` | uuid NULL / timestamptz NULL | **versión de empaque** (§10b.6 pregunta 7): la ficha anterior no se pisa; queda `historica` con `superseded_by` apuntando a la nueva |
| audit completos (`created_at/by`, `updated_at/by`, `deleted_at`) | | soft-delete |

**CHECK de `status` por origen:**
- `origin='alta'`: `presolicitud, borrador, analizada, aprobada, tecleada_en_kepler, ligada, conciliada, con_diferencias, descartada`.
- `origin='levantamiento'`: `fotos_tomadas, analizada, publicada, por_revisar, recapturar, historica`.
  ➕ **`en_captura`** (2026-11-02, primer corte): al escanear se APARTA el producto antes de tener fotos y ningún estado decía «apartado, sin fotos». Va antes de `fotos_tomadas`.

**Índices:**
- `(tenant_id, status)`.
- Altas: único `(tenant_id, ean)` donde `origin='alta' AND deleted_at IS NULL AND status <> 'descartada'`.
- Levantamiento: único `(tenant_id, sku)` donde `origin='levantamiento' AND superseded_at IS NULL AND deleted_at IS NULL`.

**Cuándo un SKU «tiene ficha»** (una sola regla, la usan la vista de sugeridos NP.7.L.1, el escaneo de
NP.7.L.2 y la métrica de cobertura): existe una fila **no borrada** con ese `sku` y
`status IN ('publicada','conciliada','con_diferencias')`. Así una alta ya conciliada cuenta como
ficha (es la más completa del catálogo) y el escaneo responde «ya está», en vez de intentar crear
una segunda fila.

**Lo que ve cada quien:** los endpoints de `/levantamiento` responden un **DTO propio en
`libs/contracts`, con lista blanca**; ⛔ nunca devuelven la fila ni `sheet`. Una alta `ligada` es la
misma fila que lee el levantamiento, y lleva costo en varios lugares (`negotiated_cost`,
`sheet.campos.costo_base`, costo / markup / PV por peldaño, `projection`). Esos campos se quitan **en
el servidor** a quien no tenga `COMPRAS_COSTO_ESTANDAR_VER` (§7.2).

**Relación con lo que ya existe:**
- Después de `ligada`, los campos que son de Kepler (descripción, línea, tipo, grupo, IVA, IEPS,
  escalera, códigos) se leen de **`kepler_ods.kdii`**, nunca de `sheet`. Lo propio de la ficha es sólo
  `sheet.ampliado` + `photos`. `sheet` conserva lo que se mandó a Kepler como evidencia del alta y de
  la conciliación, no como fuente.
- **Imagen:** `inventory.products` ya tiene `image_url`, `image_source` (`'cloudinary' | 'erp' |
  'manual'`), `image_storage_key` e `image_updated_at` (mig `20260604150000`), y de ahí leen el portal
  y el buscador del catálogo (`commercial-catalog-search.service.ts`). Si la foto publicada se escribe
  ahí con `image_source='levantamiento'` o si esas columnas se reemplazan, y qué pasa con las imágenes
  que ya existen, es la **decisión D19** (§8). Mientras no se decida, la foto de la ficha **no** llega
  al portal ni al verificador. Item NP.7.L.14.

**Vistas que cruzan `kepler_ods` con las fichas** (NP.7.0.6, NP.7.L.1, cobertura): `security_invoker
= true` y filtro de `tenant_id` explícito (ERP_KEPLER, gotchas del ODS punto 4: «RLS no aplica a
vistas/MVs», hay que reinyectar `tenant_id`; una vista sin `security_invoker` corre con los permisos
de su dueño y **se salta la RLS**). ⚠️ Con `security_invoker` la vista lee con el rol de quien
consulta: probarla **con el rol del pod**, no con el de la máquina de trabajo (GOTCHAS, `[CG.129]`:
la misma vista dio 182 filas en la laptop y 0 en el pod). Prueba con dos tenants: B no ve las fichas
de A.

⚠️ La precisión de la IA se mide comparando `ai_raw` con `sheet` en la misma fila: **no hace falta
tabla de correcciones**.

### 7.2 Forma de la ficha (`sheet`), con el 95805

```json
{
  "schema_version": 1,
  "campos": {
    "descripcion": { "valor": "BON O BON FRESA ED ESP 8/15G", "fuente": "sistema", "confianza": "alta", "evidencia": "regla nombre v1", "revisar": false },
    "ean_base":    { "valor": "7500443006889", "fuente": "foto", "confianza": "alta", "evidencia": "base · zxing · DV ok", "revisar": false },
    "ieps":        { "valor": 8, "fuente": "sistema", "confianza": "media", "evidencia": "564 kcal/100 g (lateral 2)", "revisar": true },
    "costo_base":  { "valor": null, "fuente": "compras", "confianza": null, "evidencia": null, "revisar": true },
    "linea":       { "valor": null, "fuente": "hermano", "confianza": null, "evidencia": "sin_fuente: NP.7.0.1", "revisar": true }
  },
  "ampliado": {
    "marca": "bon o bon", "fabricante": "Arcor / Mundo Dulce S.A. de C.V.", "variante": "Fresa",
    "edicion": "Edición Especial", "piezas": 8, "gramos_por_pieza": 15, "contenido_neto_g": 120,
    "sellos_nom051": ["EXCESO CALORÍAS", "EXCESO AZÚCARES", "EXCESO GRASAS SATURADAS"],
    "alergenos": ["leche", "trigo", "soya"], "puede_contener": ["cacahuate"],
    "nutricion_100g": { "kcal": 564 },
    "nutricion_porcion": { "porcion_g": 15, "piezas_por_porcion": 1, "kcal": 80, "grasa_g": 5, "grasa_sat_g": 2.5, "azucares_g": 7 },
    "empaque": { "tipo": "caja de cartón tipo casita", "material": "PAP 21", "colores": ["rojo", "rosa", "blanco"] },
    "temporada_inferida": "Día del Amor y la Amistad"
  }
}
```

⛔ **Dinero dentro de `sheet` y `projection`.** El costo no vive sólo en `negotiated_cost`: también en
`sheet.campos.costo_base`, en costo, markup y PV de cada peldaño, y en toda `projection`. Sin
`COMPRAS_COSTO_ESTANDAR_VER`, el servidor **quita esas claves** antes de responder (no la pantalla).
Pruebas:
- En NP.7.2.6: un usuario sin ese permiso llama `GET /`, `GET /:id`, `GET /:id/kepler-sheet`,
  `PATCH /:id` y `POST /:id/analyze`; ninguna respuesta trae costo, margen ni proyección. La prueba
  **recorre el JSON completo** (no busca un solo campo) y se rompe a propósito una vez (regla 12).
- En NP.7.L.2: una ficha `ligada` con costo, consultada por un usuario que sólo tiene
  `CATALOGO_LEVANTAR`, no expone esas claves.
- En NP.7.L.10: el buscador responde con lista blanca y falla ante `piece_price`, `box_price` o
  `revenue` (la búsqueda de cotizaciones que se reusa devuelve las tres).

**Única excepción:** el capturista de Kepler necesita el costo para teclearlo. `GET /:id/kepler-sheet`
se lo entrega con `COMPRAS_ALTA_CAPTURAR`, sólo de **esa** solicitud y sólo en `aprobada` o
`tecleada_en_kepler` (NP.7.2.6). No se le da `COMPRAS_COSTO_ESTANDAR_VER`.

---

## 8. Decisiones

| # | Decisión | Recomendación | Quién | ADR |
|---|---|---|---|---|
| D1 | ¿Ampliación de `[NP.7]` o fase nueva? | NP.7 (respeta Fase 0) | Edgar | — |
| D2 | Modelo del lector: Haiku 4.5 (el del extractor) vs uno más capaz | decidir con **los dos corpus**: el de 20 altas (NP.7.1.2) y el del levantamiento (NP.7.L.11b: 40 SKUs, 4 niveles físicos, peldaño equivocado): el que logre ≥ 95 % de campos de foto correctos y el mejor acierto de nivel físico, al menor costo por ficha | Edgar | sí |
| D3 | ¿Quién aprueba: Compras o Catálogo? ¿Fiscal valida IVA/IEPS/SAT antes de aprobar? | Compras aprueba; fiscal valida sólo la primera vez por categoría. **El margen no se decide aquí**: lo fija D9 (Compras + Dirección Comercial) y lo bajo meta lo resuelve D14 | Francisco + fiscal | — |
| D4 | ¿Foto de caja master obligatoria? | Sí: sin ella no hay Unidad Dos ni factor de compra | Francisco | — |
| D5 | Regla de la clave nueva | la que mida NP.7.0.2 | Compras | — |
| D6 | ¿Se manda contenido a un proveedor externo (Anthropic)? (❌ Antes decía «las fotos son de empaque, sin datos de personas: no aplica la regla 33»; reemplazado el 2026-11-01: en el levantamiento se usan teléfonos personales dentro de la tienda y una persona puede salir en la foto) | **En el levantamiento sí aplica la regla 33** de ONBOARDING §8.0b. El PR dice qué sale (foto de producto **recortada** a la silueta), a quién (Anthropic) y qué se excluye (fotos con `persona_visible`, §10b.3 punto 7). **Bloquea encender la IA** (NP.7.L.11d, `NP7_AI_ENABLED`); ❌ antes «bloquea NP.7.L.2»: el levantamiento se construyó con la IA apagada | Edgar (y legal) | — |
| D7 | Umbrales de autollenado (§5.7 puntos 3 y 5): cota inferior de Wilson 95 % ≥ 98 % (operativos, n ≥ 150) y ≥ 99.5 % (fiscales, n ≥ 600) + combinación aprobada por fiscal; **margen sobre la línea base** de clase mayoritaria; **N y k de la revocación** | aceptar como arranque y revisar tras el primer snapshot | Edgar + fiscal | sí |
| D8 | ¿Quién aprueba combinaciones fiscales y con qué evidencia? | fiscal, una vez por combinación, con el criterio escrito | fiscal | — |
| D9 | ~~¿Quién fija el margen?~~ ✅ **Resuelta 2026-10-28: Compras y Dirección Comercial** (Francisco). Por confirmar: ¿quién firma cuando queda bajo la meta: sólo Dirección Comercial? | Dirección Comercial firma lo que queda bajo meta | Francisco | — |
| D10 | Lista cerrada de rótulos de unidad | la que salga de medir `c11`/`c80`/`c83` en `kdii` (NP.7.L.0, §10b.7 punto 7), depurada por Compras | Compras | — |
| D11 | `commercial.margin_targets` **no tiene peldaño** y Kepler fija markup por peldaño (pieza 22 % vs caja 13.79 %). ¿Se le agrega peldaño a la meta (columna aditiva, decisión del motor) o la comparación se hace siempre ponderada por mezcla? | ponderada por mezcla mientras tanto; agregar peldaño es decisión del dueño del motor | Edgar + Dirección Comercial | sí |
| D12 | ¿Se autoriza corregir en el motor la tolerancia de `corregir_escalera` (0.01 % relativa → $0.01 absoluto por pieza)? Cambia lo que publica el motor (FASE_PR §19) | sí, como commit propio con antes/después | Edgar | — |
| D13 | Horizonte de «vida comercial»: ¿90 días medidos, 12 meses extrapolados, o la temporada para productos de temporada? | 90 d medidos siempre visibles; 12 meses rotulado «extrapolado»; temporada para ediciones especiales | Francisco + Dirección Comercial | — |
| D14 | ¿El margen **de lista ponderado** bajo meta **bloquea** o sólo pide autorización? (La meta de `margin_targets` es de lista; el realizado esperado se muestra aparte, contra el realizado de su categoría.) ¿Debe existir una **meta de realizado**? **No existe hoy; la decide el dueño del motor** | pide autorización de Dirección Comercial, con la proyección adjunta; sin meta de realizado hasta que el dueño del motor la fije | Dirección Comercial (+ dueño del motor para la meta de realizado) | — |
| D15 | El **levantamiento** de SKUs existentes (§10b): ¿fase propia o parte de NP.7? Es alcance nuevo y Fase 0 no deja abrir fases | ✅ **Orden respondido por Francisco el 2026-11-01: el levantamiento va primero** (tramo 1). Para Edgar queda sólo: ¿tramo de NP.7 o fase propia?, su cupo, y la META de la métrica L con su fecha | Edgar | — |
| D16 | Rol para los puestos de **Recepción de Mercancía** (hoy «sin definir» en MATRIZ_ACCESOS) | **Bloquea sólo NP.7.L.6** (el botón vive en la recepción). ❌ Antes bloqueaba también NP.7.L.7b: desde el 2026-11-02 `CATALOGO_LEVANTAR` es universal (Francisco) y no espera rol de recepción | Edgar + RH | — |
| D17 | Proveedor para la **foto de estudio** (edición de imagen: recorte, color). Claude no edita imágenes. Regla fija: editar la foto real, nunca generar el empaque (§10b.9) | decidir cuando arranque NP.7.D.1 | Edgar | sí |
| D18 | ¿El markup por peldaño cuenta como campo decidido por personas? | Sí → la META de la métrica 1 es ≤ 20 % (provisional). Confirmar. Falta decir si el markup de Dos y Tres cuenta aparte (con 2–3 peldaños da 22.6–25.8 %, §4) o si confirmar la escalera de markups del motor es una sola decisión | Francisco | — |
| D19 | **La foto publicada y la imagen que ya existe.** `inventory.products` ya tiene `image_url` / `image_source` / `image_storage_key` / `image_updated_at` (mig `20260604150000`, pensadas para Cloudinary) y de ahí leen el portal y el buscador del catálogo. ¿La foto publicada se escribe ahí con `image_source='levantamiento'` (extender el dominio de `image_source`), o esas columnas se reemplazan por una lectura de `catalog.product_sheets`? ¿Qué pasa con las imágenes que ya existen: se conservan hasta que haya ficha publicada, o se sustituyen al publicar? | extender: escribir con `image_source='levantamiento'` al publicar el peldaño principal; la imagen existente se conserva hasta entonces y no se pisa una `manual`. Una sola columna que lee todo el que ya lee | Francisco + Edgar | sí |
| D20 | Retención de las fotos de **altas descartadas** (§10b.6 pregunta 8) | conservar 1 año (es historia de lo evaluado, §3) y después borrar sólo las fotos, no la fila | Francisco | — |
| D21 | ¿Qué incluye el **«precio como llega»** (costo sobre el que se aplican los pisos de §5.10)? Precio del proveedor, descuentos de factura, flete. El flete no está medido (`logistics.shipment_expenses` vacía) | si entra el flete, Compras lo captura en la solicitud hasta que exista la fuente | Francisco | — |
| D22 | Traslado de la **unidad consumidor** en productos existentes (nuevos: `P_cons`) · redondeo a precios de mostrador del precio sugerido al público | — | Francisco | — |
| D23 | **Caja exterior sin código propio**: sólo 12.6 % de las Unidad Dos y 1.8 % de las Unidad Tres que existen tienen código escaneable (§10a.1). ¿Cómo se levanta? | escanear el código de la pieza o el empaque, confirmar y fotografiar la caja; la IA clasifica el nivel; **siempre a revisión**. Alternativa: caja exterior fuera del tramo 1 | ✅ **Francisco, 2026-11-02: la caja exterior NO entra al piloto.** El piloto levanta la unidad principal | — |
| D24 | **Obsoletos**: `kdii.c99` viene vacío en las 9 sucursales (§10a.1). ¿Con qué se excluyen? | universo = venta en 90 d o existencia, sin no-físicos; obsoleto = ni venta en 365 d ni existencia | ✅ Francisco, 2026-11-02: aceptada la recomendación | — |
| D25 | **¿Dónde levanta quien no tiene sucursal en su perfil?** Medido 2026-11-02: 88 de 184 personas activas (promotores y vendedores de ruta, oficinas). | ✅ aplicado (Claude, a confirmar por Francisco): la de su perfil si la tiene; si no, **la elige** en pantalla y la ficha guarda `sucursal_por: elegida`; quien SÍ tiene sucursal y pide otra, sólo con su alcance de escritura. Es dato de catálogo (fotos), no de dinero | Francisco | — |

---

## 9. Riesgos y bloqueos

| Bloqueo | Dueño | Causa | Qué lo destraba |
|---|---|---|---|
| Columnas de `kdii` sin mapear | Francisco | §4 marca ❓ en 10 campos (Línea, Tipo, Grupo, IVA e IEPS ya están mapeados) | NP.7.0.1 con 3 fichas reales abiertas en Kepler (pedir a Compras captura de pantalla de cada una) |
| Capturista no copia bien | Compras | el alta en Kepler sigue manual | NP.7.2.5 lo detecta; no lo evita |
| El EAN no está en `kdii` aunque se capturó | Francisco | el ODS refresca con `OdsLiveLoop`; el código se pudo capturar sin EAN | la solicitud `tecleada_en_kepler` sin ligar > 48 h → aviso «captúrame el código o ligala a mano» |
| Costo de IA (altas) | Francisco | 5 fotos de la unidad principal + 3 por cada otro peldaño por análisis (típico Base + corrugado = 8; §3) | idempotencia por hash (NP.7.2.2); medir costo por solicitud y declararlo |
| Costo de IA del **levantamiento** sin tope | Francisco | ~6,500 SKUs × peldaños × caras; el extractor (`llm-extractor.service.ts`) lo comparten unos 10 servicios en prod, y un 429 los frena a todos | worker con `NP7_AI_CONCURRENCY`, tope diario `NP7_AI_DAILY_CAP` e interruptor `NP7_AI_ENABLED`; una llamada por foto; idempotencia por `sha256`; costo por ficha medido con las primeras 100 fichas y proyectado a 6,500, presentado a Edgar **antes de abrir otra sucursal** (NP.7.L.11d) |
| **Dirección Comercial sin rol ni personas** | Edgar + Francisco | MATRIZ_ACCESOS: el puesto «Dirección Comercial y Marketing» tiene rol «sin definir» y 0 personas. Nadie podría firmar NP.7.2.7: un alta bajo meta se quedaría en «pide autorización» para siempre (precedente: `COMPRAS_REQUISICIONES_AUTORIZAR` quedó repartida a nadie) | designar personas **antes de NP.7.2.7** y darles `COMMERCIAL_MARGIN_ENGINE_AUTORIZAR` por `identity.user_permissions`, o crear el rol |
| **Capturistas del piloto sin cuenta** | Francisco + encargado de Padre Hidalgo + RH | MATRIZ_ACCESOS: anaquelista 1 persona (con rol `repartidor`), empaque y vendedora de piso 0, recepción 0 y sin rol; cajeros 14 con rol `cajero`, que también comparten Caja General y Cajero Vecinal. Repartir a roles vacíos cumple la regla 20 en el papel y deja el piloto sin quién capture; repartir por rol abre el levantamiento en las 9 sucursales | NP.7.L.11 (cuentas) + NP.7.L.7b (a todo rol con personas; ❌ L.7a por persona, reemplazado el 2026-11-02) |
| Seguir confiando en la IA para el EAN | Francisco | la IA puede leer mal un dígito | §5.1: siempre manda el lector |

---

## 10. Cómo arrancar (orden sugerido)

> ❌ **Reemplazado el 2026-11-01** el orden anterior («C0 primero: NP.7.0.1 → .0.3 → .0.2 → .0.4 →
> .0.5; corpus; C1 → C2 → C3»): arrancaba por las altas, omitía NP.7.0.6–.0.8 y todo el
> levantamiento, y contradecía la respuesta de Francisco (§10b.6: el levantamiento va primero).

0. **Tracker:** crear en `01_TRACKER_PROGRESO.md` una fila por item NP.7.x.y, en orden C0 → C3, y
   reescribir el texto de `[NP.7]` con el título de esta fase. Los NP.7.L.\* sólo si D15 los deja en
   esta fase (si va como fase propia, sus filas van allá).
1. **Leer:** este plan · [`FASE_NP_PRODUCTOS_NUEVOS.md`](FASE_NP_PRODUCTOS_NUEVOS.md) · [`ERP_KEPLER.md`](../../ERP_KEPLER.md) §2.1.1, §3.y.4 y la sección del decodificador · [`METODO_DE_TRABAJO.md`](../../METODO_DE_TRABAJO.md) · `docs/GOTCHAS.md` (índice: RLS, migraciones, permisos).
2. ⛔ **Hasta que Edgar resuelva D15 y el cupo (hoy 7 de 4), nada pasa a 🔨**: sólo diseño y la C0
   de sólo lectura (NP.7.L.0, NP.7.0.3, NP.7.0.10). Tampoco sin la META de la métrica L y su fecha.
3. **Tramo 1 — levantamiento (piloto en Padre Hidalgo).** Orden por capa, cada una verificada antes
   de subir:
   C0 NP.7.L.0 → NP.7.0.5 (tabla con `origin`) + NP.7.0.9 (almacén de fotos) → NP.7.L.1 (vista
   `derive-no-copy`) → NP.7.L.11b (corpus) / NP.7.L.11c (ranking) → C1 NP.7.L.9a → NP.7.L.9b /
   NP.7.L.9c → NP.7.L.3a → C2 NP.7.L.11 + NP.7.L.7b → NP.7.L.2 (con la IA apagada hasta D6) + NP.7.L.11d →
   NP.7.L.15 → NP.7.L.3b / NP.7.L.3c → NP.7.L.10 / NP.7.L.12 / NP.7.L.13 → C3 NP.7.L.4a / NP.7.L.8a →
   NP.7.L.4b / NP.7.L.8b → NP.7.L.5 → NP.7.L.6 (⚠️ L.6 espera a D16: el botón vive en la recepción,
   cuyos puestos aún no tienen rol; el piloto no lo necesita). NP.7.L.14 espera a D19. Antes de L.4a:
   NP.7.L.11 (cuentas) y NP.7.L.7b (`CATALOGO_LEVANTAR` a todo rol con personas; ❌ L.7a por persona,
   reemplazado el 2026-11-02). Antes de L.3b: NP.7.L.15 (clave para revisar). Antes de abrir otra sucursal:
   NP.7.L.11d (costo de IA medido, presentado a Edgar).
   **Primer corte** (lo que se construye primero dentro del tramo 1; sujeto a D15 y al cupo):

   | Capa | Qué entra |
   |---|---|
   | C0 | NP.7.L.0: códigos por casilla (las 9) en la sucursal 01, resolución real de las cámaras y % de `C`+clave · NP.7.L.1: sugeridos sobre `v_erp_stock_on_hand` + venta de 90 días en pesos · NP.7.0.5: migración de `catalog.product_sheets` con `origin` · NP.7.0.9: almacén de fotos (bucket, retención y GB medidos; sin él `putBuffer` no tiene dónde escribir) |
   | C1 | NP.7.L.9a: resolver código → peldaño reusando `checado-codigo.ts` (sin crear otra) |
   | C2 | NP.7.L.2: `POST /levantamiento/scan` y `/photos` (con `putBuffer` y validación de archivo), probados contra base real · NP.7.L.11 + NP.7.L.7b: cuentas de los capturistas y `CATALOGO_LEVANTAR` a todo rol con personas · NP.7.L.11d: worker de IA con topes (sin publicación automática) · NP.7.L.15 + NP.7.L.3b: clave y bandeja «por revisar» (sin ella, lo que va a revisión no tiene dónde aceptarse y la métrica de salida no se puede medir) |
   | C3 | NP.7.L.4a + NP.7.L.8a: pantallas A, B0, B y C en línea, con `camera-shot` y `@zxing`. Se revisa **nitidez, movimiento, lente sucio y encuadre** (NP.7.L.8a/L.8b), no la resolución. Buscador de respaldo (NP.7.L.10). La IA lee en lote y **todo va a «por revisar»** (sin publicación automática) |

   **Fuera del primer corte:** publicación automática (L.3a), ranking, Cobertura E (L.5), cola sin
   señal (L.4b), granel (L.9c), botón de recepción (L.6), **la caja exterior (D23)**,
   presolicitud como flujo (L.13: sólo se anota el hallazgo) y todo el camino de altas (kNN, margen,
   proyección).
   **Métrica de salida del primer corte:** SKUs con las caras de su unidad principal aceptadas en la
   bandeja (NP.7.L.3b) y el % de la venta de 90
   días (en pesos) que cubren · % de fotos rechazadas en revisión · costo de IA y MB por ficha.
4. **Tramo 2 — altas.** ⛔ No arranca hasta cerrar el piloto del tramo 1. NP.7.0.1 → .0.3 (métrica 2
   HOY) → .0.2 → .0.4 → .0.6 → .0.7 → .0.8 (y .0.9/.0.10 si no se hicieron) → corpus de 20 productos
   (Francisco tiene las 5 fotos del 95805; pedir 19 más **con su ficha de Kepler** como respuesta
   conocida) → C1 → C2 → C3, cada capa verificada antes de subir.
5. Al cerrar cada item: `01_TRACKER_PROGRESO.md` + `03_LOG_REVISIONES.md`; un ADR por cada
   decisión de §8 con «ADR: sí» al resolverse (D2 vía NP.7.1.2b, D7, D11, D17, D19).

---

## 10a. ⭐ Mediciones C0 de sólo lectura (2026-11-02)

> Las tres que §10 punto 2 permite antes del OK del PM: **NP.7.L.0**, **NP.7.0.3** y **NP.7.0.10**.
> Contra prod (`pg-prod`, `system_identifier` 7688376744939610156, usuario `francisco` con
> `transaction_read_only = on`), a las 22:15 (fuera de horario hábil). Cada conteo lleva un control
> independiente. ⛔ Sin cifras en pesos (el repo es público): sólo conteos y %.
> **Universo de Padre Hidalgo (01):** 9,713 fichas en `kdii`; **4,054 SKUs con venta en 90 días**
> (`mv_kepler_sales_daily`, `monto > 0`); 3,318 con existencia en el almacén `01`
> (`v_erp_stock_on_hand`; ⚠️ no verificado que `01` sea el almacén de **piso**); 2,974 con las dos.
> ⚠️ El plan decía «~6,500 SKUs»: en Padre Hidalgo el universo con venta es **4,054**.

### 10a.1 NP.7.L.0 — códigos de barras por casilla (Padre Hidalgo)

| Casilla | Con valor | Qué traen |
|---|---:|---|
| Base `c7` | 9,534 | **3,848 son la propia clave del SKU** (5 dígitos, `c7 = c1`): no es código impreso. EAN-13 3,337 · UPC-12 1,828 · EAN-8 49 |
| Base `c93` / `c102` | 8,046 / 5,049 | segunda y tercera casilla (el 95805 trae su EAN en `c93`, no en `c7`) |
| Dos `c82` | 6,463 | **5,467 `C`+clave (85 %)**; EAN/UPC/DUN sólo 228 |
| Dos `c95` / `c96` | 4,708 / 4,441 | — |
| Tres `c85` | 3,082 | **3,065 `C`+clave (99 %)** |
| Tres `c97` / `c98` | 153 / 98 | claves internas `CB23`+SKU / `CB33`+SKU (p. ej. `00052`: `CB2300052`, `CB3300052`): **no son códigos impresos**. Falta confirmarlo con la ficha abierta en Kepler (SKUs `00052`, `01055`, `02020`) |

Control: `c7` 9,534, `c85` 3,082 y sus `C`+clave 3,065, repetidos con un conteo distinto
(`length(trim())` en vez de `nullif`): cuadran.
Las 9 sucursales traen casi las mismas cifras (las fichas de Kepler se replican).

**Lo que decide el diseño — unidad principal escaneable** (SKUs con venta en 90 días, unidad
principal = factor de `mv_kepler_sold_rung.rung_modal` cruzado con los factores de `kdii`; ⚠️ el
primer intento leyó `rung_modal` como número de peldaño y el control lo cazó: es un **factor**):

| Unidad principal | SKUs | % de la venta | % de esa venta con código escaneable (EAN-8/UPC/EAN-13/DUN) |
|---|---:|---:|---:|
| Base | 3,865 | 91.3 % | 86.9 % |
| Unidad Dos | 162 | 8.2 % | 82.9 % |
| Unidad Tres | 18 | 0.4 % | 36.7 % |
| factor sin peldaño | 9 | 0.0 % | — |
| **Total** | **4,054** | **100 %** | **86.3 %** |

→ **13.7 % de la venta tiene una unidad principal que no se puede escanear** (su código es la clave
interna). Ésas sólo entran por el **buscador** (NP.7.L.10), que hoy está **fuera del primer corte**.

**Caja exterior (los peldaños mayores que existen, factor > 1):**

| Peldaño | Existe | Con código escaneable | Sólo `C`+clave |
|---|---:|---:|---:|
| Unidad Dos | 1,847 | **233 (12.6 %)** | 1,560 |
| Unidad Tres | 2,178 | **40 (1.8 %)** | 2,131 |

→ ⛔ **El corrugado casi nunca se identifica escaneándolo.** La compuerta (a) de §10b.3 («el código
está en la casilla de **ese** peldaño») no se puede cumplir para ~9 de cada 10 cajas exteriores:
irían **todas** a revisión, o hay que cambiar el camino (escanear el código de la pieza o el
empaque y fotografiar la caja; la IA clasifica el nivel). **Decisión nueva: D23.**

Además: 3,887 SKUs con rótulo en la Unidad Dos pero sólo 1,847 con factor > 1 (el «factor no
capturado» de §10b.7 punto 3) · mismo código en dos peldaños del mismo SKU: Base-Dos 21, Base-Tres
8, Dos-Tres 3 · **código compartido entre SKUs: 18 códigos, 36 SKUs** (sin `C`+clave).

**Rótulos (SKUs con venta en 90 días, insumo de D10):**

| Rótulo | Base | Dos | Tres |
|---|---:|---:|---:|
| PAQ | 2,764 | 1,701 | 16 |
| CJA | 11 | 1,561 | 2,069 |
| PZA | 1,033 | 425 | 86 |
| KG | 181 | 154 | 30 |
| BTO | 1 | 23 | 113 |
| 500 / 250 / 400 / 2KG | 59 | 19 | 1 |
| CUB / SER | 5 | 4 | 3 |

**241 SKUs con escalera de peso** (rótulo numérico, KG o GR en algún peldaño).

**⛔ `c99` (obsoleto) viene vacío en las 87,398 filas de las 9 sucursales.** No sirve para excluir
obsoletos (§10b.3 punto 1, NP.7.L.12, el universo): hace falta otro criterio (sin venta y sin
existencia, por ejemplo). **Decisión nueva: D24.**

**⛔ Hay SKUs que no son producto físico** (promociones «X = GRATIS Y», «TIEMPO AIRE», descuentos):
**133 de los 4,054 activos** por nombre (`is_promo` marca sólo 94). No se fotografían y no deben
entrar al universo de la métrica L. El filtro por nombre es aproximado («2X1 EN ESTUCHES» se cuela).

**NO MEDIDO de L.0:** resolución de las cámaras de 5 teléfonos de Padre Hidalgo (necesita los
teléfonos) y `c97`/`c98` contra la ficha abierta en Kepler.

### 10a.2 NP.7.0.3 — métrica 2 HOY (Padre Hidalgo)

**Fuente encontrada (corrige §4):** la clave SAT **no está en `kdii`**: vive en
**`kepler_ods.kdfe33relprd`** (`c1` SKU · `c2` clave SAT · `c3` unidad SAT · `c4` `N` · `c6` objeto de
impuesto), una fila por sucursal. Testigos: el 95805 trae `50161800` / `H87` / `N` / `02` en todas las
sucursales, y el catálogo SAT de Kepler (`kdfe33satprd`, `kdfe33satum`) dice `50161800` =
«Productos de confitería», `01010101` = «No existe en el catálogo», `H87` = Pieza, `KGM` = Kilogramo.
La moneda está en `kdii.c20` y `c31` («PESOS» en 87,082 filas, vacía en 316; **ninguna en dólares**;
falta saber cuál es la de compra) y la imagen en `kdii.c70` (`Productos\95805.jpg`). ⚠️ El
`01010101` y el USD de la captura del 95805 eran **los valores por defecto de la pantalla de alta
vacía**, no los del 95805. Todo esto lo confirma NP.7.0.1 con la pantalla abierta.

| | Universo | (a) clave SAT `01010101` | (b) USD | (c) unidad SAT `KGM` en producto por pieza | **Métrica 2** |
|---|---:|---:|---:|---:|---:|
| Activos (venta 90 d) | 4,054 | 494 | 0 | 5 | **498 (12.3 %)** |
| — sólo productos físicos | 3,921 | | | | **397 (10.1 %)** |
| Altas de 90 días (`mv_new_products`) | 592 | 126 | 0 | 3 | **129 (21.8 %)** |
| — sólo productos físicos | 532 | | | | **78 (14.7 %)** |

Control: 1,570 SKUs con `01010101` en `kdfe33relprd` de la 01 por conteo directo contra 1,489 por
el cruce con `kdii` (81 SKUs de `relprd` no tienen ficha en `kdii`). **La red: NO MEDIDO** (la
consulta de las 9 sucursales pasó los 60 s; se reescribe por sucursal).
`catalog.products.sat_clave_prod_serv` está **vacía en los 11,350 productos**: es «sin dato», no
«0 con valor de fábrica».
Además, fuera de la lista cerrada: 101 SKUs con rótulo de peso tienen unidad SAT `H87` (Pieza).
⚠️ **(c) se midió con la unidad SAT** (`KGM` en un SKU cuyo rótulo no es de peso). La lista cerrada habla de la
**unidad Base de Kepler** («2 KILOGRAMO» es el valor por defecto de esa lista en la pantalla de alta): con
esa lectura, los candidatos son los 181 SKUs activos con Base `KG`, y falta un criterio para «producto
que en realidad es por pieza». Se corrige al construir NP.7.0.6.
**Falta el criterio de cierre:** 10 casos revisados a mano en Kepler (lista en el reporte de
Francisco: `00402`, `00154`, `62097`, `90304`, `94078`, `00022`, `00030`, `00041`, `00106`, `00107`).

### 10a.3 NP.7.0.10 — n de la prueba del proyector

**416 lanzamientos** cerrados (de 90 a 180 días) pasan la regla de muestra (`no_medible` y
`posible_recodificacion` no verdaderos), de 594 en esa ventana; lanzados del **6-may al 4-ago-2026**.
Control: `COUNT(*)` independiente con `IS NOT TRUE` da 416. **No es muestra chica** en total; ⚠️ por
categoría o marca puede serlo: el proyector rotula «muestra chica» cuando los parecidos sean < 30.
`mv_new_products` arranca el 5-may (1,203 lanzamientos, corte 1-nov).

### 10a.4 Lo que cambia en el plan (decisiones para Francisco, y para Edgar donde se indica)

**Resuelto por Francisco el 2026-11-02:** D23 → la caja exterior **no** entra al piloto · el
buscador (NP.7.L.10) **entra al primer corte** · D24 aceptada · la métrica 2 **excluye las
promociones** (los 10 casos revisados lo eran) · la resolución de cámara **no se exige**: se revisa
que la foto no esté borrosa, movida, con el lente sucio o con la mano temblorosa (NP.7.L.8b al primer
corte) · `c97`/`c98` y los campos CFDI **verificados con 3 pantallas de Kepler** (abajo, en §4).
⚠️ El `01055` mostró en pantalla un costo Base de 148.80 contra 36.21 en el ODS de las 9 sucursales
(última sincronización de `kdii`: 22:12): o eran cambios sin guardar o entraron después. Revisar.

Lo propuesto antes de la respuesta:

- **D23 · Caja exterior sin código propio (~9 de cada 10).** Propuesta: la persona escanea el código
  de la pieza o del empaque que trae la caja, confirma, y fotografía la caja; la IA clasifica «caja
  exterior» y lee la leyenda («24 × 8»). Esa foto **siempre** va a revisión (falta el testigo del
  código de ese peldaño) y Catálogo la liga. Alternativa: dejar la caja exterior fuera del tramo 1.
- **D24 · Obsoletos sin `c99`.** Propuesta: universo = SKUs con venta en 90 días **o** existencia,
  sin los no-físicos; obsoleto = ni venta en 365 días ni existencia.
- **Buscador al primer corte.** El 13.7 % de la venta no se puede escanear: sin NP.7.L.10 esa parte
  del catálogo no se puede levantar en el piloto. Propuesta: subir NP.7.L.10 al primer corte.
- **No-físicos fuera del universo** de la métrica L y de los sugeridos (NP.7.L.1).
- **§4 corregido en la fuente** de Clave SAT, Unidad SAT, IVA exento / Objeto de impuesto, Moneda e
  Imagen: candidatos medidos arriba, los confirma NP.7.0.1 con la pantalla abierta.

---

## 10b. ⭐ El módulo: nombre, lugar, pantallas y LEVANTAMIENTO masivo

> Pedido de Francisco (2026-11-01): dónde vive, cómo se llama, la maqueta de primera vista, y un
> **levantamiento** para que recepción, anaquelistas y cajeros ayuden a capturar artículos en masa.
> ⚠️ **El levantamiento es alcance NUEVO**: no es un alta, es completar la ficha de los ~6,500 SKUs
> que ya existen. Es más grande que `[NP.7]`. Si va como fase propia o como parte de ésta, lo decide
> el PM (D15).

### 10b.1 Nombre y lugar

**Módulo: «Catálogo digital»** (Francisco, 2026-11-02: «todo esto entra como catálogo digital»). Es un sustantivo, como pide la skill `diseno` §9, y vive en el Centro de catálogo de Compras (`/compras/catalogo`) como **una pestaña nueva con tres secciones: Cobertura · Por revisar · Altas**. Su unidad es la **ficha de producto**: la ficha es la
ficha ampliada de un SKU (fotos, atributos, nutrición, sellos y lo que se manda a Kepler), y llega
por uno de dos caminos:

| Camino | Quién | Dónde vive | Por qué ahí |
|---|---|---|---|
| **Alta** (producto que no existe en Kepler) | Compras + Dirección Comercial | `/compras/catalogo/solicitudes`. La pestaña existente «Solicitudes» pasa a ser la sección **«Altas»** del Catálogo digital (misma ruta, no se rompen enlaces) | ya es su lugar; la pestaña está vacía esperando esto |
| **Levantamiento** (SKU que ya existe y no tiene ficha) | ⭐ **TODA persona** (Francisco, 2026-11-02: «es universal, todos participan en la construcción del catálogo digital»); antes decía «recepción, anaquelistas, cajeros, almacenistas» | **`/levantamiento`**, ruta propia, **pensada para celular**, con permiso propio `CATALOGO_LEVANTAR` repartido a todo rol con personas; ⚠️ **sin destino en «Mi trabajo»** (como `servicio-reportar`: un destino más les quitaría a cajeras y almacenistas su entrada directa) — se entra con el botón **«Levantar productos»** del header. En `authz-tree.ts` es el módulo `compras-levantamiento` sin ruta. (❌ Antes: «entrada en «Mi trabajo» (`/projects`) y en `suite-map.ts`».) Surface: Operations · `apps/view` · **solo herramienta, mobile-first**, igual que `/captura/:token` y `/empleo` (no §O.3). ⚠️ **Pendiente: agregar `/levantamiento` a la tabla de Surfaces de `DESIGN.md`** (hoy no está, junto a las filas de `/captura/:token` y `/empleo`). **Se agrega a propósito en el mismo commit que construye NP.7.L.4a, no antes**: este plan no toca `DESIGN.md`, y una fila de una pantalla que no existe sería una afirmación falsa | ⛔ no puede vivir bajo `/compras`: esos puestos no tienen ni deben tener el permiso de Compras (ven costo) |
| **Cobertura** (avance del levantamiento) | Compras / Catálogo y el **encargado de sucursal** (`encargado_tienda`, el que motiva, §10b.8) | pestaña nueva **«Catálogo digital»** en `/compras/catalogo` (secciones **Cobertura** y **Por revisar**; la tercera, **Altas**, es la de arriba), con clave propia **`CATALOGO_LEVANTAR_COBERTURA_VER`**. ⛔ No con `COMMERCIAL_PRODUCTS_VER`: el encargado no la tiene, y telemarketing y cobranza sí (verían nombres de personas de toda la red). El desglose por persona se filtra **por alcance en el servidor** (el encargado ve su sucursal) | supervisa; no captura |

**Una sola tabla:** `catalog.product_sheets`, con `origin = 'alta' | 'levantamiento'` (§7.1, renombrada
el 2026-11-01). ⛔ No se crea una segunda tabla para el levantamiento (regla 2): la ficha es la
misma venga de donde venga.

**Máquinas de estado** (el CHECK de `status` es por origen, §7.1):
- `alta`: §3, incluida la **`presolicitud`** que abre el levantamiento cuando el código no existe en
  Kepler.
- `levantamiento`: `fotos_tomadas` → `analizada` → `publicada` (pasa sola las compuertas de 10b.3)
  **o** `por_revisar` (va a Catálogo) → `publicada` / `recapturar`. Cuando cambia el empaque y se
  vuelve a levantar, la ficha anterior pasa a `historica` (`superseded_by` apunta a la nueva).
  (Antes este estado inicial se llamaba `capturada`; se renombró para no confundirlo con «ya está en
  Kepler» de las altas.)
- **Cuándo un SKU «tiene ficha»:** existe una fila no borrada con ese `sku` y
  `status IN ('publicada','conciliada','con_diferencias')` (§7.1). La usan la vista de sugeridos
  (L.1), el escaneo (L.2) y la métrica de cobertura: una alta ya conciliada **cuenta** como ficha.

### 10b.2 Las cinco preguntas (skill `diseno` §0b), por pantalla

| Pantalla | 1 · Qué ve primero y en qué orden | 2 · Qué NO ve | 3 · Accesibilidad | 4 · Ligada a | 5 · ¿Le toca? |
|---|---|---|---|---|---|
| **Levantamiento** (celular: A → **B0** confirmar código → B caras → C) | el botón **«Escanear código»**; debajo, el **buscador de respaldo** «¿No pasa el código? Búscalo» (§10b.8b); luego cuántos faltan en *su* sucursal y lo que lleva esta semana; después, los siguientes sugeridos, **los que más se venden primero**. En **B0**, el código leído, el nombre y el rótulo de Kepler tal cual, y «Sí, tomar fotos» | costo, precio, margen, proveedor, lo que leyó la IA, la ficha de Kepler | una mano, objetivos ≥ 44 px, **sin teclear en el camino normal**; el buscador de respaldo **sí teclea**: campo ≥ 44 px y resultados visibles **arriba del teclado**; safe-area en las acciones de abajo; sucursal por **nombre**, nunca «07»; foto con silueta guía; funciona con mala señal (cola local) | **Recepción** (el momento de la caja master), **Productos nuevos** (los recién llegados primero), **Altas** (código que no existe → presolicitud) | sólo captura; **no aprueba ni corrige** datos |
| **Altas · revisión** (escritorio) | *answer-first* (Q.1): «**{pendientes} te esperan** (los campos C de §4 + «revisar») · margen de lista 12.1 % vs meta 11.55 % (default) · realizado esperado 10.47 % aparte»; luego la proyección (§5.9); luego lo plegado | los {31 − pendientes} campos ya resueltos (M = 31, §4; plegados con su conteo, a un clic) | cada campo con su fuente y el recorte de foto; teclado completo; la ficha para Kepler se puede copiar | Motor de Margen (meta, triage), NP (plan contra real), Kepler (conciliación) | Compras y Dirección Comercial; el capturista de Kepler sólo ve la ficha |
| **Levantamiento · cobertura** (Compras) | «**Unidad principal publicada en N % de la venta**» (ponderada por venta en pesos, no por SKUs; unidades de conteo de §10b.3), por sucursal; después, el **ranking por persona** (peldaños publicados y hallazgos confirmados, §10b.8) | la foto suelta de cada quien (va en el detalle, no en el tablero). (❌ Antes decía «quién capturó cada foto», que chocaba con el ranking por persona) | por sucursal y por categoría; clic → lo que falta, con el filtro puesto (Q.4) | Incidencias del catálogo (lo que la IA encontró contra Kepler) | Compras / Catálogo y el encargado (sólo su sucursal), con `CATALOGO_LEVANTAR_COBERTURA_VER` |
| **Por revisar** (Catálogo, escritorio; maqueta F, NP.7.L.3b) | arriba, el **conteo por motivo** (código en peldaño equivocado · factor distinto · IA duda · entró por búsqueda · caras saltadas · `sha256` repetido · muestreo); luego, ficha por ficha, **la foto contra el dato de `kdii`** de la sucursal donde se capturó; **una decisión por clic** (publicar · recapturar · confirmar hallazgo · descartar) | costo, precio, margen; el ranking; las fichas ya publicadas (salvo las del muestreo) | teclado completo (atajos para las cuatro decisiones); la foto ampliable sin salir de la fila; motivo en texto, no sólo color | Levantamiento (de ahí llegan), Incidencias (el hallazgo confirmado va ahí), ranking (publicar suma; rechazar en muestreo resta) | quien tenga `CATALOGO_FICHAS_REVISAR` (NP.7.L.15; dueño del catálogo, §10b.6 pregunta 3) |
| **Ficha para Kepler** (capturista de Kepler) | la ficha **en el orden de la pantalla de alta de Kepler** (§4), campo por campo, cada uno con su botón de copiar; arriba, el estado de la solicitud (`aprobada`) | la proyección, el razonamiento de la IA, los hermanos, las fotos (salvo la del código); costo y precios sólo con la excepción de NP.7.2.6 | copiar con un clic o con teclado; valores en fuente monoespaciada; nada editable | Altas (de ahí sale), conciliación NP.7.2.5 (lo que teclee se compara después) | el capturista con `COMPRAS_ALTA_CAPTURAR` |
| **Conciliación** (Compras) | **las diferencias primero**: campo · lo que decía la ficha · lo que quedó en Kepler, sólo las que no cuadran; luego el conteo de las que sí cuadraron (plegado) | los campos que cuadraron (a un clic); el detalle de la proyección | por solicitud y por campo; clic → la solicitud con el campo marcado | Kepler (`kdii`, NP.7.2.5), Altas, Incidencias | Compras (`COMPRAS_ALTA_APROBAR`) |

### 10b.3 Cómo funciona el levantamiento (que nadie teclee y que salga bien)

1. **Escanear primero.** El lector (`@zxing`, en el navegador, §5.1) busca el código en las 9
   casillas de `kdii` (§10b.7 punto 1):
   - **existe y no tiene ficha** → captura guiada;
   - **ese peldaño ya está publicado** (regla de §10b.1: `publicada`, `conciliada` o
     `con_diferencias`, también si vino de una alta) → «ya está, gracias», y el siguiente. Si el SKU
     tiene ficha pero **ese peldaño** no, se captura ese peldaño (punto 5);
   - **no existe en Kepler** → se abre una **presolicitud de alta** (`origin='alta'`,
     `status='presolicitud'`, §3) con esas fotos. Es un hallazgo valioso: mercancía en anaquel con un
     código que Kepler no conoce. **No llama a la IA** hasta que Compras la promueve. Si ese código ya
     tiene una presolicitud abierta, las fotos se suman a ella y la persona ve «ya lo reportó otra
     sucursal».
   - **varios SKUs con el mismo código** → no se captura; va a Incidencias (Fase CV ya mide los
     códigos repetidos en `/compras/catalogo/codigos`). ⚠️ Los **obsoletos** (`c99`) se excluyen de
     esta búsqueda: en una recodificación el ODS no borra la fila vieja, y sin excluirlos el código
     quedaría «repetido» para siempre (NP.7.L.12).
2. **Fotos guiadas:** frente, reverso, dos laterales y base, con la silueta de la cara que toca.
   - La **caja master** sólo la pide **recepción**, que es quien la tiene en la mano. Se ofrece desde
     la pantalla de recepción (RE/GP) para los SKUs de esa entrada que no tengan ficha.
   - **Revisión en el teléfono antes de subir** (resolución y encuadre en el tramo 1, NP.7.L.8a;
     nitidez y luz cuando estén calibradas, NP.7.L.8b): una foto mala se repite en el momento, no
     tres días después.
   - El número de caras depende del peldaño (§10b.7 punto 2: 5 / 3 / 2 / 1); las 5 de arriba son las
     de la unidad principal.
3. **El capturista no corrige nada.** La IA lee en segundo plano y la persona ve «listo, siguiente».
4. **Compuertas de publicación automática: la lista ÚNICA** (reescrita el 2026-11-01; §10b.7,
   §10b.8b y la maqueta B remiten aquí, y la implementa NP.7.L.3a). Se evalúan **por peldaño**, no
   por SKU. Un peldaño se publica solo si cumple **todo** esto:
   - **(a)** entró **por escaneo**, la persona confirmó el código (B0) y el código está en la casilla
     de **ese** peldaño (§10b.7 punto 1);
   - **(b)** el nivel físico que ve la IA es **compatible** con ese peldaño (§10b.7 punto 5);
   - **(c)** cada campo de la foto supera **su umbral medido** con el corpus del levantamiento
     (NP.7.L.11b), **no** la «confianza» que declara el propio modelo;
   - **(d)** cuadran §5.2 y el factor. ⚠️ El factor se compara contra el **factor resuelto** de
     `analytics.v_product_box_factor` (o `v_unit_truth`) con su veredicto, **nunca contra `kdii.c84`
     crudo**: un `c84` en 0/1 quiere decir «Kepler no lo capturó» (7,247 SKUs, y 6,135 sí tienen
     escalera). Ese caso es hallazgo **«factor no capturado»** con la foto como evidencia y **no frena
     la publicación** (§10b.7 punto 3);
   - **(e)** **no contradice a Kepler** (por ejemplo, la foto dice 8 piezas y la escalera dice 12 →
     no se publica). Se compara contra la **fila de `kdii` de la sucursal donde se capturó**
     (reusando la resolución de fila del verificador, `kp.service.ts:502-520`); si otra sucursal
     discrepa, es un hallazgo y **no bloquea** (§10b.6 pregunta 6);
   - **(f)** no se saltó **ninguna cara obligatoria** de ese peldaño (maqueta B).

   **Nunca se publica solo** si: entró por búsqueda o sin código (§10b.8b, §10b.7 punto 5); la IA
   duda del nivel o de un campo; el código está en el peldaño equivocado; se saltaron caras; o la foto
   repite un `sha256` (§10b.8). Si la cara saltada es **la del código o la de la leyenda de
   contenido**, el peldaño queda **«incompleto»**: no suma al ranking y vuelve a sugeridos.
   Testigos: **dos testigos (código e IA) + la confirmación de la persona** (§10b.7).

   ⛔ **En el piloto no hay publicación automática:** todo va a «por revisar». La compuerta (c) se
   enciende **campo por campo** cuando el corpus NP.7.L.11b da un acierto ≥ al umbral, y lo publicado
   solo se revisa por **muestreo de 1 de cada 20** (§10b.6 pregunta 4, §10b.8).

   Si no pasa, el peldaño va a **por revisar** en Catálogo. La contradicción con Kepler es además un
   **hallazgo de catálogo**, y es de lo más valioso que va a dar el levantamiento. Una ficha publicada
   **no queda congelada**: si Kepler cambia después, NP.7.L.12 la vuelve a comparar.
5. **Sin capturas duplicadas, por peldaño:** el escaneo resuelve el peldaño (§10b.7 punto 1) y
   contesta «ya está» **sólo si ese peldaño** está publicado (la Base publicada no cierra el
   corrugado). Al escanear se aparta el par **`(sku, peldaño)`** por 30 min, guardado en
   `sheet.peldaños.<x>.apartado = {by, until}` con un **UPDATE condicional** (sólo si no hay apartado
   vivo de otra persona). Cada persona tiene **máximo 3 apartados vivos**; uno nuevo libera el más
   viejo que no tenga fotos. Una segunda captura sólo se pide cuando la primera queda «por revisar»
   por calidad de foto. (❌ Antes el apartado era por SKU: chocaban la Base del anaquel y el corrugado
   de recepción.)
6. **Orden sugerido:** los SKUs con **existencia > 0 en el almacén de piso de esa sucursal**, leída
   de **`analytics.v_erp_stock_on_hand`**, ordenados por venta de 90 días. ⛔ No se recalcula desde
   `kdil` crudo (ahí `c1` es el almacén y la existencia es `c4 + c8 − c9`; ERP_KEPLER l. 108). Lo que
   no está en el anaquel no se sugiere: un SKU que sólo tiene existencia en bodega **no** aparece.
   La cobertura cuenta la ficha (que es una por SKU) en **todas** las sucursales donde el SKU tiene
   existencia.
7. **Personas en la foto** (regla 33 de ONBOARDING §8.0b, D6). ❌ Reemplazado el 2026-11-01 el texto
   «si la IA detecta una persona, la foto se rechaza y no se manda a leer»: no se puede construir,
   porque para que la IA vea a la persona la foto ya viajó a Anthropic, y en el repo no hay detector
   local.
   - **Opción A (recomendada para el piloto):** el servidor **recorta la foto a la silueta** antes de
     enviarla. La misma lectura devuelve `persona_visible`; si es `true`, la foto **se borra ese mismo
     día**, no se publica ni se usa para estudio, y se pide recaptura. Se **declara** en el PR que la
     foto sí llegó a Anthropic. Prueba negativa: apagar el recorte y el borrado, y ver el rojo.
   - **Opción B:** un detector local medido, como item propio (no existe hoy).
   - Sin una de las dos, no se puede prometer que una foto con persona «no se manda a leer».

**Métrica del levantamiento (MÉTRICA L de la cabecera):** % de la venta de 90 días, en pesos, cuyo
SKU tiene su **unidad principal publicada** (regla de §10b.1: `publicada`, `conciliada` o
`con_diferencias`; una alta conciliada cuenta).
**HOY: 0 %** (2026-11-01), porque la ficha todavía no existe. **META:** la fija el PM, con fecha (D15).
⛔ **NP.7.L.\* no pasan a 🔨 sin la META y su fecha.**

**Unidades de conteo** (todas las pantallas cuentan lo mismo; antes A decía «fichas», E «SKUs», el
ranking «peldaños» y A «hoy llevas»):
- **SKU cubierto** = su **unidad principal** está publicada con todas sus caras obligatorias (5; 1 si
  es granel, §10b.7 punto 2).
- **Faltan** = SKUs con existencia en la sucursal y **sin unidad principal publicada**.
- **% de venta** = venta de 90 días **en pesos** de los SKUs cubiertos ÷ venta de 90 días en pesos
  del universo (⛔ no en unidades: están infladas ~3.9×). La vista de venta se nombra en NP.7.L.1.
  **Universo** = SKUs activos con existencia, sin obsoletos. Los SKUs de **código compartido** (185
  códigos, 293 SKUs) se reportan **aparte** y no entran al denominador:
  el plan prohíbe capturarlos, y con ellos el 100 % sería imposible.
- **Aporte y ranking** = peldaños publicados, por fecha de publicación, en semana de lunes a
  domingo, hora de México.
- **En revisión** = se muestra aparte y **nunca suma**.
- Serie: NP.7.L.5 guarda un snapshot semanal con los números crudos (fecha, sucursal, numerador,
  denominador), para tener antes y después.
Secundarias:
- % que se publica sola (sin revisión). En el piloto es **0 % por diseño** (todo va a «por
  revisar» hasta que el corpus NP.7.L.11b encienda cada campo); no se promete un % antes de L.0 y
  L.11b;
- hallazgos contra Kepler encontrados;
- costo de IA por ficha. **NO MEDIDO**: se mide con el corpus del levantamiento (NP.7.L.11b) y, en el piloto, con las
  primeras 100 fichas (NP.7.L.11d), antes de abrir otra sucursal.

### 10b.4 Maquetas (sin validación visual: son la forma, no el diseño final)

**A · Levantamiento, inicio (celular)**
```
┌──────────────────────────────────┐
│ Levantamiento · Padre Hidalgo     │
│ Ana López  ·  No soy yo          │  ← teléfono compartido (NP.7.L.4a)
│  ┌────────────────────────────┐  │
│  │   [cámara]  Escanear código │  │  ← primaria, lo único en --action
│  └────────────────────────────┘  │
│  ¿No pasa el código? Búscalo     │  ← buscador de respaldo (§10b.8b)
│                                  │
│  Faltan 1,240 sin unidad principal│  ← primario (§10b.3, unidades)
│  Esta semana: 12 publicadas ·    │  ← secundario
│  5 en revisión · vas 3.º         │
│  ver top 5 ›                     │  ← ranking de la sucursal (§10b.8)
│                                  │
│  Siguientes (los que más venden) │
│  ─────────────────────────────── │
│  Pulparindo 20 pz                │  ← nombre, no código
│  Duvalín bi-sabor 18 pz          │
│  Bon o bon leche 30 pz           │
│  ver todos (1,240) ›             │
└──────────────────────────────────┘
```
*Sin columna «Pasillo»: no hay fuente. Sólo se agrega si NP.7.0.1 mapea la ubicación de Kepler.
Sucursal siempre por nombre («Padre Hidalgo»), nunca «01».*

**B · Captura guiada (paso N de M)** — M depende del peldaño (§10b.7 punto 2): **5** unidad
principal · **3** otro peldaño · **2** pieza exhibida · **1** granel. Flujo: **A → B0 → B → C**.
Aquí, unidad principal, paso 2 de 5:
```
┌──────────────────────────────────┐
│ ‹  Bon o bon fresa 8 pz   2 de 5 │  ← el SKU ya identificado por el código; «de M»
│  [pi-circle-fill]×2 [pi-circle]×3│  ← avance (íconos, no ●○)
│  ┌────────────────────────────┐  │
│  │                            │  │
│  │    [ silueta: REVERSO ]    │  │
│  │                            │  │
│  └────────────────────────────┘  │
│  Gira la caja: la cara de atrás  │
│     ( [pi-camera] Tomar foto )   │  ← ≥ 44 px, al alcance del pulgar
│  Saltar esta cara                │  ← terciario: pide el motivo con un toque
└──────────────────────────────────┘    (se guarda en `photos.saltada_motivo`)
  Foto con baja resolución o fuera de la silueta → «repítela» antes de avanzar (NP.7.L.8a)
  Saltar la cara del código o la de la leyenda → el peldaño queda «incompleto» (§10b.3 punto 4)
```

**C · Listo** (tres variantes; ⛔ sin «la revisamos en unos minutos»: no hay quién lo cumpla)
```
┌──────────────────────────────────┐
│ [pi-check] Bon o bon fresa 8 pz  │
│  Enviada · 5 de 5                │  ← variante 1: todo subió
│                                  │
│  [ Escanear el siguiente ]       │
└──────────────────────────────────┘
┌──────────────────────────────────┐
│ [pi-cloud-upload] Bon o bon fresa│
│  Guardada en este teléfono ·     │  ← variante 2: sin señal (cola, NP.7.L.4b)
│  se enviará al tener señal       │
│  (3 pendientes)                  │
│  [ Escanear el siguiente ]       │
└──────────────────────────────────┘
┌──────────────────────────────────┐
│ [pi-exclamation-triangle]        │
│  4 de 5 subieron                 │  ← variante 3: falla a media subida
│  [ Reintentar ]                  │  ← primaria en este estado
│  Escanear el siguiente           │
└──────────────────────────────────┘
```
En la pantalla A, si hay capturas en cola: «N capturas sin enviar», con el componente existente
`app-offline-status` (NP.7.L.4b). En tramo 1 (NP.7.L.4a, en línea) C sólo tiene las variantes 1 y 3;
la variante 2 y este aviso llegan con la cola.

**D · Altas, revisión (escritorio, Compras)** — ❌ reemplazada el 2026-11-02: la anterior daba
«margen de lista 12.1 % ≥ meta 11.55 % ✓» con un markup de **13.8 % en el empaque, bajo su piso de
reseller** (§5.10: con 2 unidades, la inferior la compra el reseller), daba el veredicto con el bulto
todavía en blanco, y decía «{pendientes} te esperan» con 7 renglones. Versión dibujada:
`C:\DEV\_reportes\maquetas_fichas_de_producto.html` (fuera del repo).
```
┌───────────────────────────────────────────────────────────────────────────────────┐
│ Altas › solicitud 1042 · Bon o bon fresa ed. esp. 8/15 g      Leída por la IA · hace 4 min│
│                                                                                   │
│ 5 decisiones te esperan · el empaque de 8 queda bajo su piso                      │  ← Q.1
│ Empaque de 8 (reseller): markup 13.8 %, piso P_res → necesita autorización.       │
│ La caja exterior todavía no tiene markup.                                         │
│                                                                                   │
│ Unidad          Quién la compra  Costo llegada  Markup  Piso  Margen  Precio MD  Público (ref.)│
│ Empaque de 8    reseller         $48.33         13.8 %  P_res 12.1 %  $55.00     canal regalo  │ ← bajo el piso
│ Caja ext. de 24 mayorista        $1,159.92      te toca P_may —       —          no se vende   │
│ Pieza suelta    consumidor       —              —       P_cons —      —          si se vende suelta│
│ Para subir el empaque al piso: precio MD $__.__. Meta del motor 11.55 % (se cumple; el piso manda).│
│                                                                                   │
│ ┌ Te toca · 5 de 7 pendientes ─────────────┐ ┌ Proyección · 90 días ──────────────┐│
│ │ ¿Se vende la pieza suelta?  [Sí|No]      │ │         Bajo     Medio    Alto     ││
│ │   (3 de 5 parecidos sí)                  │ │ Venta   $38,000  $61,000  $93,000  ││
│ │ Markup caja exterior  P_may (sugerido)   │ │ Utilidad $3,979  $6,387   $9,737   ││
│ │ Proveedor  Unidal ▾ (4 de 5 parecidos)   │ │ margen esperado 10.47 %            ││
│ │ Precio de lista del proveedor  [$____]   │ │ = lista 12.1 % − descuento 1.82 %  ││
│ │ Código del proveedor           [______]  │ │ NO MEDIDO: logística, capital      ││
│ │ Costo del empaque   $48.33  (ya)         │ │ 14 lanzamientos de Productos nuevos›││
│ │ Markup del empaque  13.8 %  bajo el piso │ └────────────────────────────────────┘│
│ └──────────────────────────────────────────┘                                      │
│ ▸ 24 campos llenados solos (foto 11 · sistema 8 · parecidos 5)                    │
│ [ Pedir autorización ]  [ Aprobar ] (deshabilitado: bajo el piso)      Descartar  │
└───────────────────────────────────────────────────────────────────────────────────┘
```
*«Te toca» lleva exactamente los campos **C** de §4 para esta escalera (2 unidades → 7) más lo
marcado «revisar»; el veredicto cuenta **los pendientes** (5) y lo plegado es 31 − 7 = 24 (M = 31,
§4). Cada campo dice de dónde salió. Las unidades se nombran **pieza · empaque interior · caja
exterior · granel** en toda pantalla salvo la Ficha para Kepler (ahí, Base / Dos / Tres).*
*Veredicto: primero el **piso por unidad** (§5.10, sobre el costo de llegada); la meta del Motor de
Margen va como dato secundario. Mientras falte un markup, el veredicto lo dice («todavía no tiene
markup») y no declara «cumple».*
*La proyección se muestra por escenario (bajo · medio · alto), en pesos, con la utilidad =
venta × margen esperado; nunca «38k · 61k · 93k» sin unidad ni rótulo.*

**D, variantes:**
- **Todo arriba de su piso:** «Todo listo · cada unidad arriba de su piso», «Aprobar» primaria,
  «Pedir autorización» no aparece.
- **Bajo el piso o bajo la meta sin autorización vigente:** «**Pedir autorización**» es la acción
  **primaria** y «Aprobar» queda **deshabilitado con el motivo a la vista**. El servidor lo respalda:
  NP.7.2.3 responde **409** si se intenta aprobar así.
- Cualquier botón que escribe se **deshabilita al primer clic** (sin dobles envíos).
- **Leyendo las fotos… (N s)** mientras la IA lee; **«La lectura falló · [Reintentar]»** si falla;
  **«Faltan N fotos de {unidad}»** cuando la solicitud no trae todas las fotos que pide su escalera.

**E · Cobertura (Compras › Catálogo › Catálogo digital › Cobertura)** — ❌ corregida el 2026-11-02:
decía «34 % de la venta · 2,210 de 6,489 SKUs» de toda la red con una sola sucursal levantada (no
cuadraba con «faltan 1,240»), «por revisar 31» contra 47 en F, sin meta, y el ranking ponía a Ana
1.ª con 41 mientras la maqueta A la ponía 3.ª con 12.
```
 Padre Hidalgo: 48 % de su venta ya tiene fotos
 1,340 de 2,580 productos con existencia · faltan 1,240 › · meta: sin fijar (la fija Edgar, con fecha) · hace 2 min
 ┌──────────────────────┬──────────────┬─────────┬─────────────┬───────────────────────────┐
 │ Sucursal              │ % de la venta│ faltan  │ por revisar │ contra Kepler             │
 │ Padre Hidalgo (piloto)│     48 %     │ 1,240 › │    47 ›     │ 9 hallazgos › (4 confirm.)│
 │ Otras 7 sucursales    │ sin levantar │    —    │     —       │      —                    │
 └──────────────────────┴──────────────┴─────────┴─────────────┴───────────────────────────┘
 Fuera del conteo: N productos de código compartido › (van a Incidencias)

 Ranking · esta semana (lunes a domingo)                     [Semana | Acumulado]
 ┌──────────────┬───────────────┬─────────────────────┬──────────────────┬─────────────┐
 │ Persona       │ Sucursal       │ unidades publicadas │ hallazgos conf.  │ en revisión │
 │ Luis Ramírez  │ Padre Hidalgo  │         41          │        3         │      2      │
 │ Marta Núñez   │ Padre Hidalgo  │         33          │        1         │      4      │
 │ Ana López     │ Padre Hidalgo  │         12          │        0         │      5      │
 └──────────────┴───────────────┴─────────────────────┴──────────────────┴─────────────┘
 Unidad publicada = pieza, empaque o caja que pasó revisión con todas sus fotos.
 En revisión no suma · el encargado sólo ve su sucursal (NP.7.L.11c)
```
*Cada número lleva a su lista con el filtro puesto (Q.4). Las sucursales sin levantar se declaran,
no se pintan como 0 %. El veredicto es de la sucursal en curso mientras sólo haya piloto; el de la
red aparece cuando haya más de una sucursal levantada.*

**F · Por revisar (Compras › Catálogo › Catálogo digital › Por revisar; NP.7.L.3b)**
```
 Por revisar · 47 fichas · Padre Hidalgo ▾
 Código en peldaño equivocado 9 · Factor distinto 6 · IA duda 18 · Entró por búsqueda 7 ·
 Caras saltadas 4 · Foto repetida 1 · Muestreo 2                     ← conteo por motivo, primero
 ┌───────────────────────────────────────────────────────────────────────────┐
 │ Bon o bon fresa 8 pz · corrugado · Ana López · hace 2 h                    │
 │ Motivo: código en peldaño equivocado                                       │
 │ ┌ Foto ───────────────┐   Kepler (Padre Hidalgo)                           │
 │ │ [leyenda «24 × 8»]  │   código 7500443006889 en c7 (Base)                │
 │ │                     │   rótulo CJA · factor resuelto 24 (v_product_box_factor)│
 │ └─────────────────────┘   la IA ve: caja exterior                          │
 │ [ Confirmar hallazgo ]   Publicar   Recapturar   Descartar                 │  ← una decisión por clic
 └───────────────────────────────────────────────────────────────────────────┘
```
*Sin validación visual. Costo, precio y margen no aparecen. Se deshabilita la decisión al primer clic.*

### 10b.5 Items

> **Una sola tabla de items del levantamiento, por capa C0 → C3** (reordenada el 2026-11-01). El
> resto de §10b es diseño y apunta aquí. Los items grandes se partieron (L.3, L.4, L.8, L.9) sin
> renumerar: cada parte lleva letra. Lo que entra al **primer corte** (piloto de Padre Hidalgo, §10)
> va marcado **[T1]**. Tablas que el tramo 1 usa de §6: NP.7.0.5 (tabla con `origin`) y NP.7.0.9
> (almacén de fotos).

**C0 · Dato**

| # | Item | Estado | Prueba |
|---|---|---|---|
| NP.7.L.0 | **[T1]** En Padre Hidalgo (sucursal 01) y en todo el catálogo: % de SKUs activos con código en **cada una de las 9 casillas** (`c7`, `c93`, `c102`, `c82`, `c95`, `c96`, `c85`, `c97`, `c98`); % con forma `^C\d+$` (`C`+clave) en `c82` y en `c85`; cuántos tienen el **mismo** código en dos peldaños; y **verificar `c97`/`c98`** con una ficha real abierta en Kepler (las demás ya están descifradas, ERP_KEPLER §3.y.4). Además: **resolución real de las cámaras** de los teléfonos del piloto, medida con `getSettings()` del track de video (`camera-shot.component.ts:148, 182`) en **5 teléfonos de Padre Hidalgo**; y cuántas fichas irían a revisión porque el peldaño no tiene código propio (§10b.7 punto 4); y la **lista de rótulos** de `c11`/`c80`/`c83` con su frecuencia y cuántos SKUs tienen escalera de peso (§10b.7 punto 7, insumo de D10). Script de sólo lectura (diseño en §10b.7 punto 4) | ✅ 2026-11-02 (§10a.1). `c97`/`c98` verificados con 3 pantallas de Kepler (`00052`, `01055`, `02020`). La resolución de cámaras se retiró (Francisco: nos adaptamos al teléfono; ver L.8a/L.8b) | conteos cruzados con un `COUNT(*)` independiente por casilla; `c97`/`c98` contra la ficha abierta en Kepler; la resolución de cada teléfono anotada con su modelo |
| NP.7.L.1 | **[T1]** Vista **sugeridos por sucursal**: SKUs con existencia > 0 en el **almacén de piso** de la sucursal (`analytics.v_erp_stock_on_hand`, no `kdil` crudo: ahí `c1` es el almacén y la existencia es `c4 + c8 − c9`) y **sin unidad principal publicada** (regla de §10b.1: cuenta también una alta `conciliada` / `con_diferencias`), ordenados por **venta de 90 d en pesos** (`analytics.mv_kepler_sales_daily.monto`); universo y exclusiones de §10b.3 «Unidades de conteo» (derive-no-copy, `security_invoker = true` + `tenant_id` explícito, §7.1) | 🚀 2026-11-03 en prod. Remedido en prod (sólo lectura, el mismo SQL): universo de Padre Hidalgo **4,228** y **3,257** sugeridos con existencia, ~0.5 s (se movió la ventana de 90 d; control con sucursal inexistente = 0). Pendiente: dos tenants, «sólo bodega no se sugiere», alta conciliada no sugerida, 3 sucursales contra conteo a mano — Antes: 🔨 2026-11-02: `product-sheets/levantamiento.sql.ts` (SQL derivado en vivo, compartido por A, sugeridos y cobertura — módulo y no VISTA por ahora). Medido contra prod en sólo lectura (Padre Hidalgo): universo **4,235** = 4,397 (venta 90 d ∪ existencia) − 162 promociones; 3,239 sugeridos con existencia; ~0.5 s con `enable_nestloop = off` local a la transacción (sin eso, 34 s). ⚠️ Falta: prueba de dos tenants y «sólo bodega no se sugiere» (el almacén `01` no está verificado como piso) | 3 sucursales contra conteo a mano; **un SKU que sólo tiene existencia en bodega no se sugiere**; una alta `conciliada` **no** aparece como sugerida; un SKU de código compartido no aparece y se cuenta aparte; dos tenants: B no ve las fichas de A (probado con el rol del pod) |
| NP.7.L.11b | **Corpus del levantamiento** (la «confianza» la declara el propio modelo y nadie la ha medido; el corpus de NP.7.1.2 son 20 altas, sin corrugados, sin granel, sin empaques interiores): **40 SKUs de Padre Hidalgo**, 10 por nivel físico (pieza, empaque interior, caja exterior, granel), **≥ 5 con el código en el peldaño equivocado**. Se mide, por modelo, el acierto del **nivel físico** y de **cada campo**, y el **costo por ficha**. Control con etiquetas barajadas. De aquí salen los umbrales de la compuerta (c) de §10b.3 punto 4; D2 elige el modelo con **los dos** corpus (este y NP.7.1.2) | ⬜ **NO MEDIDO** | el control con etiquetas barajadas cae a la tasa de clase mayoritaria (y se publica ese número); el acierto por campo y por nivel queda publicado con su n; los 5 casos de peldaño equivocado se detectan o se declara cuántos no |
| NP.7.L.11c | **Ranking** (§10b.8): vista derive-no-copy de **peldaños publicados** por `captured_by` + hallazgos confirmados contra Kepler, por semana (lunes a domingo, hora de México) y acumulado. Sólo cuentan las fichas que no fueron rechazadas en el muestreo (§10b.8). Se lee con `CATALOGO_LEVANTAR_COBERTURA_VER`, filtrado por alcance en el servidor. La vista lleva `security_invoker = true` + `tenant_id` explícito (§7.1) | ⬜ | dos tenants: B no ve lo de A, probado con el rol del pod; lo que está en revisión **no suma**; una ficha rechazada en el muestreo deja de contar; dos fotos con el mismo `sha256` no suman dos veces; el encargado de Padre Hidalgo no ve personas de otra sucursal |

**C1 · Dominio**

| # | Item | Estado | Prueba |
|---|---|---|---|
| NP.7.L.9a | **[T1]** Confirmación del código (maqueta B0): resolver código → peldaño **reusando `resolverCodigo` de `checado-codigo.ts`** (sin crear otra), sin IA (§10b.7 punto 5) | 🚀 2026-11-03 en prod (0 escaneos todavía). Pendiente: registrar el hallazgo de «No es éste» ×2 (va con NP.7.L.3c) — Antes: 🧪 2026-11-02: `peldanoDelCodigo`/`resolverEscaneo` en `shared/kdii-codigo.ts` (movido desde `commercial-picking`, el checado sin cambio de comportamiento: 151 pruebas verdes), lectura compartida en `shared/kdii-lectura.ts` con `c97`/`c98`. Pruebas con fichas REALES (00052, 02020, 95805). «No es éste» ×2 → la pantalla lo dice; ⚠️ el hallazgo todavía no se REGISTRA (va con NP.7.L.3c) | unit: código de Base → Base; `C`+clave de la Dos → Dos; código en `c102` → Base, no «no existe»; «No es éste» ×2 → hallazgo |
| NP.7.L.9b | Clasificación del **nivel físico por la IA** y cruce con el peldaño del código (§10b.7 punto 5), calibrada con el corpus **NP.7.L.11b** | ⬜ | corpus NP.7.L.11b con nivel conocido (acierto publicado); IA compatible con el peldaño → liga; corrugado con código de Base → hallazgo; SKU con `c84=1` y escalera real → **no** da «factor distinto» (da «factor no capturado» y publica) |
| NP.7.L.9c | Flujo **sin código y de granel** (§10b.7 punto 6) | ⬜ | sin código → nunca se publica sola; `91059` 32 × 500 g = 16 kg ✓ |
| NP.7.L.3a | **Compuertas de publicación automática** (§10b.3 punto 4, la lista única (a)–(f)), lógica pura, **por peldaño**. En el piloto todas devuelven «por revisar»; la (c) se enciende campo por campo con NP.7.L.11b | ⬜ | cada compuerta rota a propósito una vez, con el rojo verificado (regla 12); **un corrugado con el código de la Base no se publica solo**; **una ficha que entró por búsqueda no se publica sola**; saltar la cara del código deja el peldaño «incompleto» y no suma |

**C2 · API**

| # | Item | Estado | Prueba |
|---|---|---|---|
| NP.7.L.2 | **[T1]** `POST /levantamiento/scan` (identifica por EAN, **resuelve el peldaño** y aparta el par `(sku, peldaño)` 30 min con UPDATE condicional en `sheet.peldaños.<x>.apartado`, máximo 3 apartados vivos por persona; §10b.3 punto 5) y `POST /levantamiento/:id/photos` (`putBuffer` y validación de archivo, NP.7.2.1) | 🚀 2026-11-03 en prod: las 10 rutas están en el swagger servido y las GET responden 401 sin sesión (registradas, con guarda, la inyección resolvió); el CI del commit servido corre `levantamiento.it.spec.ts` 26/26. **0 escaneos en prod.** Pendiente: la capa HTTP en el CI (multer, guarda); **escritura al bucket real** (la prueba usa almacenamiento falso) y la lectura real de `mv_kepler_sold_rung` (también simulada; en prod existe, poblada, con SELECT para `app_runtime`); casos sin prueba: `client_uuid` repetido, alta conciliada → «ya está», ficha ligada sin costo para quien sólo levanta, sucursal sin alcance → 403 — Antes: 🧪 2026-11-03: endpoints (`/catalog/levantamiento`: context, branches, suggested, scan, photos, skip, release). Regla 13 **MEDIDA**: `levantamiento.it.spec.ts` ejerce el SERVICIO REAL contra Postgres (docker local; `system_identifier` ≠ prod) con el payload de la pantalla: **26/26**. ⛔ La primera corrida dio **16 de 18 en rojo**: un `? IS NULL` sin tipo (42P18) tumbaba TODO escaneo con 500, y dos casos usaban un código que no estaba sembrado — la prueba se había escrito y nunca corrido. Casos agregados tras la revisión del PR: carrera por el índice único (23505 → «apartado por otro», la transacción sigue viva), apartado vencido retomado por otra persona, otra sucursal reinicia la captura, captura soltada vuelve a los sugeridos, sin apartado no se sube ni se salta, cara repetida borra la anterior del bucket, foto guardada SIN EXIF, crédito a quien terminó, nadie publica lo propio. Prueba negativa: 5 arreglos revertidos uno por uno → cada uno pone en rojo su caso. Migración `up`/`down` reales en la misma base (idempotente, RLS forzada, CHECK, índice único, `down` se niega con fichas). No cubre la capa HTTP (multer, guard, `design:paramtypes`). IA apagada (D6) | ⛔ escribe: base real + payload de la pantalla; dos personas escanean **el mismo peldaño** → la segunda ve «lo está levantando alguien más»; **la Base y el corrugado del mismo SKU → no chocan**; **dos escaneos simultáneos del mismo peldaño → gana uno**; **apartado vencido → se puede retomar**; un cuarto apartado libera el más viejo sin fotos; escanear un peldaño no publicado de un SKU con otro peldaño publicado → captura, no «ya está»; **un `client_uuid` repetido deja una sola captura**; escanear una alta `conciliada` responde «ya está» (no 500 por el índice único); una ficha `ligada` con costo, consultada por un usuario que sólo tiene `CATALOGO_LEVANTAR`, no expone costo, margen ni proyección (DTO de lista blanca, §7.1). **Sucursal (D25):** la del perfil; quien NO tiene sucursal en el perfil elige una que exista (queda `sucursal_por: elegida`); con sucursal en el perfil, pedir otra exige alcance de escritura (`ScopeService`). Fotos y saltos sólo con el apartado propio: sin él hay que volver a escanear (el escaneo valida la sucursal). Retomar desde otra sucursal empieza de cero. La IA queda apagada hasta D6 (regla 33) |
| NP.7.L.11 | **[T1]** **Cuentas para el levantamiento** (antes de L.4a): conteo de las personas que van a capturar en Padre Hidalgo (lista del encargado) contra usuarios activos; quién crea la cuenta que falte y cómo se da de baja cuando la persona sale (con RH). Cada persona con **su** usuario; ⛔ nunca una cuenta de dispositivo para el teléfono compartido de la sucursal (§10b.6) | ⬜ | la lista del encargado y los usuarios activos cuadran 1 a 1; una baja de RH deja la cuenta inactiva |
| NP.7.L.7a | ❌ **Reemplazado el 2026-11-02 (Francisco: el módulo es universal).** Ya no es por persona en Padre Hidalgo: lo reparte NP.7.L.7b a todo rol con personas. Texto anterior: permiso `CATALOGO_LEVANTAR` repartido por persona a la lista del encargado | ❌ reemplazado por L.7b | ⛔ regla 20: repartido a personas **con cuenta activa** (NP.7.L.11). Un `cajero` de otra sucursal recibe **403** en `POST /levantamiento/scan` |
| NP.7.L.7b | **`CATALOGO_LEVANTAR` a TODO rol con personas** (Francisco, 2026-11-02), mismo molde y exclusiones que `SERVICIO_REPORTAR`: sin `retirado_*`, `customer_b2b`, `servicio` ni cuentas compartidas de dispositivo. Migración `20261102235243_np7_catalogo_levantar_a_todos.js` (sólo UPDATE: NO_MEDIDO en la compuerta, se aplica a mano con `apply-one-migration-prod.js`). Simulada en prod en sólo lectura: 38 filas de `role_permissions`, **184 personas activas** en 33 roles | 🚀 **aplicada en prod 2026-11-03 (16:58Z)**: 38 roles, **184 personas activas** (igual que la simulación); `MATRIZ_ACCESOS` regenerada el mismo día. ⚠️ La clave quedó también en `sin_acceso` (0 personas hoy; `SERVICIO_REPORTAR` sí lo excluye): quitarla con una migración antes de ✅ — Antes: 🔨 2026-11-02: migración escrita y verificada contra prod en sólo lectura; ⛔ regla 20: **sin aplicar** (la aplica Edgar) | ⛔ regla 20; MATRIZ regenerada antes y después. (❌ El antiguo NP.7.L.7 «repartido a cajeros, anaquelistas, almacenistas y recepción» se partió en L.7a/L.7b el 2026-11-01: recepción tiene 0 personas y sin rol, y repartir por rol abría las 9 sucursales) |
| NP.7.L.11d | **[T1]** **Worker de IA con topes** (§9): el análisis lo hace un worker con `NP7_AI_CONCURRENCY`, tope diario `NP7_AI_DAILY_CAP` (al llegar, las fichas quedan sin analizar y Cobertura lo dice) e interruptor `NP7_AI_ENABLED`. **Una sola llamada por foto** (extracción + nivel físico + `persona_visible`); idempotencia por `sha256`; se guardan modelo, tokens y costo por llamada; ante un 429, reintento con espera. **Compuerta del piloto:** costo por ficha medido con las primeras 100 fichas, proyectado × 6,500 y presentado a Edgar **antes de abrir otra sucursal** | ⬜ **El primer corte salió sin el worker** (IA apagada hasta D6). En `product-sheets/` no hay ningún cliente de IA: hoy `NP7_AI_ENABLED` sólo esconde el aviso «lo revisa Catálogo». ⛔ No definirla en prod hasta que exista el worker: con `true`, la pantalla mentiría. Su valor en prod: NO MEDIDO (vive en el secreto) | una ráfaga de 500 fotos respeta la concurrencia y el tope diario; con `NP7_AI_ENABLED=false` no sale ninguna llamada; la misma foto dos veces → una sola llamada; el costo de las 100 fichas sale de lo guardado por llamada, no estimado |
| NP.7.L.15 | **[T1]** Clave **`CATALOGO_FICHAS_REVISAR`**: publicar, mandar a `recapturar`, confirmar o descartar hallazgos en la bandeja «por revisar». Repartida a `compras` + `gerente_compras` (§10b.6 pregunta 3, ✅ Francisco 2026-11-03). ⛔ **No reusar `CATALOGO_GESTIONAR`**: esa clave abre `/dashboard/admin/catalogs`. **Bloqueante de NP.7.L.3b** | 🚀 **aplicada en prod 2026-11-03 (16:59Z)** a `compras` + `gerente_compras`: 4 personas por rol principal, **6 con la clave** (2 más por rol complementario) y **16 pueden publicar** (más 10 por el acceso total de superadmin). Pendiente: el 403 de publicar con sólo `CATALOGO_LEVANTAR`, medido en el CI — Antes: 🔨 2026-11-03: `CATALOGO_FICHAS_REVISAR` declarada (enum, etiqueta, árbol, ruta, pestaña) y su reparto escrito: **`compras` + `gerente_compras`** (Francisco, 2026-11-03), migración `20261103010036_np7_catalogo_fichas_revisar_compras.js`, simulada en prod en sólo lectura (2 roles sin la clave, 4 personas). ⛔ Regla 20: **sin aplicar** (sólo UPDATE: la aplica Edgar con `apply-one-migration-prod.js`) | ⛔ regla 20; quien sólo tiene `CATALOGO_LEVANTAR` recibe **403** al publicar |
| NP.7.L.3b | **[T1]** **Bandeja «por revisar»** en Catálogo (API + pantalla, maqueta F de §10b.4 y fila «Por revisar» de §10b.2), con `CATALOGO_FICHAS_REVISAR` (NP.7.L.15, bloqueante): arriba el conteo por motivo; la foto contra el dato de `kdii`; una decisión por clic | 🚀 2026-11-03 en prod: `GET /catalog/fichas/revision` responde 401 sin sesión, `POST …/decision` está en el swagger y la pestaña `/compras/catalogo/digital` con su guarda en el bundle servido. **0 fichas.** Pendiente: «en revisión nunca suma a la cobertura» (depende de NP.7.L.5) y prueba visual con datos reales (la hecha usó API simulada) — Antes: 🔨 2026-11-03: `GET /catalog/fichas/revision` (conteo por motivo de TODA la bandeja + página con fotos firmadas 15 min y el dato de Kepler de la sucursal) y `POST /catalog/fichas/:id/decision` (publicar · recapturar con nota · descartar con nota = borrado lógico; candado de fila; historial en `sheet.revisiones`). Pestaña **Catálogo digital** en `/compras/catalogo` (lista + ficha, atajos P/R/D y flechas). Prueba visual en navegador con API simulada; `check:pantalla` 0 fallas. Regla 13: casos en `levantamiento.it.spec.ts`, **medidos** contra Postgres real local el 2026-11-03 (verdes; ver NP.7.L.2). ⚠️ «Confirmar hallazgo» (L.3c) y el muestreo todavía no; la bandeja no filtra por sucursal (Catálogo revisa la red) | ⛔ escribe: aceptar y mandar a `recapturar` contra base real; «en revisión» nunca suma a la cobertura; el conteo por motivo cuadra con las filas de la bandeja; `check:pantalla` antes → después |
| NP.7.L.12 | **Re-conciliación de fichas vigentes**: tarea programada (patrón `AnalyticsRefreshService` + latido en `CRON_JOBS`) que compara cada ficha `publicada`/`conciliada` contra `kdii` (códigos por peldaño, factor resuelto, obsoleto `c99`). (a) **cierra sola** el hallazgo cuando Kepler ya coincide con la foto; (b) **baja la ficha a `por_revisar`** si Kepler cambió (Compras corrigió un factor, cambió un código, la marcó obsoleta); (c) **propone religar** si el EAN aparece en otra clave activa (recodificación: el ODS no borra la fila vieja). Los obsoletos se excluyen de la búsqueda de «varios SKUs con el mismo código» (§10b.3 punto 1) | ⬜ | ⛔ escribe: base real. Cambiar el factor de una fila **sintética** de `kdii` → la ficha baja a `por_revisar`; corregir en `kdii` lo que el hallazgo decía → el hallazgo se cierra solo; el EAN en otra clave activa → propuesta de religar, sin religar solo; el latido aparece en `CRON_JOBS` |
| NP.7.L.3c | **Hallazgos contra Kepler** a la pestaña Incidencias del catálogo | ⬜ | una contradicción sintética (foto 8 piezas, escalera 12) aparece en Incidencias y la ficha no se publica |
| NP.7.L.10 | **[T1]** (Francisco, 2026-11-02: entra desde el piloto; el 13.7 % de la venta no se puede escanear, §10a.1) Extraer la búsqueda de cotizaciones a `libs/commercial/src/lib/shared/` + `GET /levantamiento/buscar` sin precio, con `CATALOGO_LEVANTAR` (diseño en §10b.8b) . Responde **lista blanca**: `sku, name, content, barcode, unit_base, pack_size, box_size, sold_by_kg` + estado de los peldaños. La sucursal sale de `ScopeService` (`warehouse=own`); sólo quien tiene alcance de varias sucursales puede mandar `branch`. El orden se da como **posición**, no como venta | 🚀 2026-11-03 en prod (`GET /catalog/levantamiento/search` → 401 sin sesión). Pendiente: las guardas HTTP (sin `COMMERCIAL_QUOTES_VER` busca aquí y no en cotizaciones; sucursal fuera de alcance → 403) — Antes: 🧪 2026-11-03: la consulta interna se movió a `shared/catalogo-buscador.ts` y cotizaciones la llama — **mismo SQL y bindings que `HEAD`** en 4 casos, comparado con un instrumento con control (términos distintos → bindings distintos); `catalog-search.spec` y `quote-scope.spec` verdes. `GET /catalog/levantamiento/search` con lista blanca (`filaBusqueda`: prueba que recorre el JSON y su negativa con `box_price`). Contra prod en sólo lectura: 110–190 ms con palabras, 715 ms sin término. Pantalla A2 con espera de 250 ms. ⚠️ La fuente es `v_label_prices`: un producto sin precio publicado en la sucursal no aparece. ⚠️ Las suites HTTP de cotizaciones (`http-quote-*`) no corren en CI: NO MEDIDO | pruebas de cotizaciones verdes sin cambios (antes/después) · la respuesta **falla si trae** `piece_price`, `box_price` o `revenue` (recorre el JSON; prueba negativa agregando `box_price`) · un usuario sin `COMMERCIAL_QUOTES_VER` puede buscar en levantamiento y **no** en cotizaciones · pedir una sucursal fuera del alcance → **403** |
| NP.7.L.13 | **Presolicitud de alta** (§3): crear con `CATALOGO_LEVANTAR` (fotos, código, sucursal, autor; sin IA); sumar fotos a una presolicitud abierta del mismo EAN; `POST /commercial/product-requests/:id/promote` (→ `borrador`, misma fila) con `COMPRAS_ALTA_SOLICITAR`; NP.7.2.5 la liga sola si el EAN aparece en `kdii`. En el tramo 1 **sólo se anota el hallazgo** | ⬜ | ⛔ escribe: base real. Presolicitud + alta con el mismo EAN = **una sola fila**; crearla **no** genera llamada a la IA (contador del extractor en 0); dos sucursales reportan el mismo EAN → una fila con las fotos de las dos; promover sin `COMPRAS_ALTA_SOLICITAR` → 403 |
| NP.7.L.14 | **La foto publicada llega al portal y al verificador** (§7.1 «Relación con lo que ya existe»), según lo que se decida en D19 | ⬜ depende de D19 | 3 SKUs con ficha publicada muestran la foto en el portal y en `/tienda/verificador`; una imagen `manual` existente no se pisa |

**C3 · UI**

| # | Item | Estado | Prueba |
|---|---|---|---|
| NP.7.L.4a | **[T1]** Pantalla `/levantamiento` **en línea** (A, B0, B, C), con `camera-shot` y `@zxing`. **Teléfono compartido:** la pantalla muestra el nombre de quien entró con «No soy yo»; si la sesión venció a media captura, pide entrar de nuevo antes de subir. **Safe-area:** acciones inferiores y cámara con `env(safe-area-inset-*)` y `viewport-fit=cover`. En tramo 1, C muestra **sólo dos variantes**: «Enviada · 5 de 5» y «4 de 5 subieron [Reintentar]» (la reintentada sale de la memoria de la pantalla, sin cola). La variante «Guardada en este teléfono · se enviará al tener señal», el «N capturas sin enviar» de A (`app-offline-status`) y el aviso de fotos sin subir al cerrar sesión **dependen de la cola y van en NP.7.L.4b** (fuera del primer corte, §10). ⚠️ Pendiente: agregar `/levantamiento` a la tabla de Surfaces de `DESIGN.md` (Operations · `apps/view` · solo herramienta, mobile-first), **en el mismo commit de este item** (hoy no se agrega a propósito) | 🚀 2026-11-03 en prod: la ruta `/levantamiento` (guarda `CATALOGO_LEVANTAR`), sus textos y el botón «Levantar productos» del header están en el bundle servido; las 184 personas lo ven al recargar (el acceso se relee al cargar la app). ⚠️ **Sin validación en dispositivo**: barra de gestos, dos personas en un teléfono, corte de red con «4 de 5 [Reintentar]» — Antes: 🔨 2026-11-02: `/levantamiento` (A, B0, B con foto que no sirve y salir a medias, C con reintentar), reusando `app-product-scan-field` y `app-camera-shot` sin copiarlos. `check:pantalla` 0 fallas; `ngc` 0 errores (con control). Fila en Surfaces de `DESIGN.md`. ⚠️ **Sin validación en dispositivo**. ⚠️ Deuda con nombre (regla 16): cámara y lector viven en `finanzas/` y `comercial/`, no en `shared/` | la fila `/levantamiento` existe en la tabla de Surfaces de `DESIGN.md`, junto a `/captura/:token` y `/empleo`; `check:pantalla` antes → después; prueba en un celular real, o declarar «sin validación en dispositivo»; **en un teléfono con barra de gestos, el botón de foto y las acciones de abajo no quedan tapados** (o declarado sin validación en dispositivo); dos personas en el mismo teléfono: la captura de la segunda se atribuye a la segunda; corte de red a media subida → C muestra «4 de 5 subieron [Reintentar]» y al reintentar suben las que faltan (con señal de vuelta). (❌ La prueba «sesión vencida con 3 fotos en cola» se movió a NP.7.L.4b: sin cola no hay fotos en cola) |
| NP.7.L.8a | **[T1]** ❌ **Resolución retirada (Francisco, 2026-11-02): nos adaptamos a la cámara que haya;** la foto se guarda con su tamaño real y `apta_estudio` se decide después. Queda la revisión de **encuadre**. Texto anterior: revisión en el teléfono de **resolución y encuadre** (umbrales de §10b.9). 1,500 px es **provisional** hasta que NP.7.L.0 mida las cámaras: si el teléfono no llega, la foto **se acepta** como `apta_estudio:false` y la captura **no se bloquea** | ⬜ No construido y **el primer corte salió sin él** (la silueta es sólo guía visual). Decidir si sale del primer corte | un teléfono capaz que manda la cara < 1,500 px → «acércate, repítela»; un teléfono que no llega a 1,500 px → la foto entra con `apta_estudio:false` y la captura sigue; producto fuera de la silueta → «repítela» |
| NP.7.L.4b | **Cola sin señal**: las fotos esperan en el teléfono y suben al volver la señal. Es la **versión 8** de la base Dexie que ya existe (`OfflineDatabaseService`, §10b.6 pregunta 9), con `client_uuid` por captura como `RoutePing`; no una base nueva. Incluye medir cuántas fotos caben. Trae de L.4a lo que depende de la cola: la variante de C «Guardada en este teléfono · se enviará al tener señal», «N capturas sin enviar» en A (`app-offline-status`) y el aviso de fotos sin subir al cerrar sesión | ⬜ | **sesión vencida con 3 fotos en cola → piden entrar y las 3 suben**; **modo avión con 3 capturas**: quedan en cola y suben al volver la señal, sin duplicar; **corte de red a media subida** → C muestra «4 de 5 subieron [Reintentar]» y al reintentar no se duplica ninguna; la migración de Dexie de 7 a 8 conserva lo que había en `photos` e `inventoryScans` |
| NP.7.L.8b | **[T1]** (Francisco, 2026-11-02: lo que importa es que la foto **no esté borrosa, movida, con el lente sucio o tomada con la mano temblorosa**; movida y temblorosa = poca nitidez, lente sucio = poco contraste) Revisión en el teléfono de **nitidez y luz** (la nitidez vive sólo aquí, ya no en L.4), con la **varianza del laplaciano**, calibrada con **50 fotos buenas y 50 movidas** reales | 🚀 2026-11-03 en prod (el medidor y sus mensajes están en el bundle servido). Umbrales **provisionales** hasta calibrar con 50 fotos buenas y 50 movidas del piloto (cada foto guarda su medición y la versión del medidor) — Antes: 🔨 2026-11-02: `libs/ui-web/src/foto/calidad-foto.ts` (varianza del laplaciano a 640 px + contraste; prueba negativa con umbral 0). ⚠️ Umbrales **PROVISIONALES** (nitidez 100, contraste 18), sin las 100 fotos reales: cada foto guarda su medición y la versión del medidor para recalibrar | umbral sacado de las 100 fotos, no supuesto; una foto movida a propósito → «Se ve movida, repítela»; **prueba negativa:** bajar el umbral a 0 y ver que la foto movida pasa (la prueba se pone roja) |
| NP.7.L.5 | Pestaña Cobertura (E) + **snapshot semanal** con los números crudos (fecha, sucursal, numerador, denominador). Clave **`CATALOGO_LEVANTAR_COBERTURA_VER`** (en `permissions.ts`, `permission-meta.ts`, `authz-tree.ts`, `role-presets.ts`), repartida a Compras y a `encargado_tienda`; incluye el bloque Ranking (NP.7.L.11c). La vista de cobertura lleva `security_invoker = true` + `tenant_id` explícito (§7.1) | ⬜ | dos tenants: B no ve lo de A, probado con el rol del pod; % ponderado por venta en pesos contra un cálculo a mano; **«faltan» da el mismo número en A y en E**; ⛔ regla 20 (repartida en prod); un usuario con `COMMERCIAL_PRODUCTS_VER` y sin la clave nueva (telemarketing) → 403; el encargado sólo ve su sucursal |
| NP.7.L.6 | Botón «Levantar ficha» en recepción (RE/GP) para los SKUs de la entrada sin ficha | ⬜ depende de D16 | un SKU de la entrada sin ficha muestra el botón y uno con ficha no; `check:pantalla` antes → después |
| NP.7.D.1 | **(fase siguiente)** Herramienta de Diseño: foto de estudio por edición + ficha técnica, publicada al verificador (`/tienda/verificador`) y exportable a folletos (diseño en §10b.9) | ⬜ depende de D17 | toda imagen editada guarda la foto real que la originó; comparación lado a lado de 5 SKUs: el texto de la etiqueta, los sellos y el contenido no cambian |

~~NP.7.L.3~~, ~~NP.7.L.4~~, ~~NP.7.L.8~~, ~~NP.7.L.9~~ ❌ **Partidos el 2026-11-01** en las partes con letra de arriba (eran demasiado grandes y no tenían capa).

### 10b.6 Respuestas de Francisco (2026-11-01) y lo que sigue abierto

**Contestadas:**

| Pregunta | Respuesta | Qué cambia en el plan |
|---|---|---|
| ¿Fase propia? | **El levantamiento es lo INICIAL**: va antes que las altas | Orden de arranque (§10): C0 de unidades (§10b.7) → levantamiento → altas. Sigue pendiente que el PM le dé lugar (D15) |
| ¿Reconocimiento? | **Sí: ranking de fichas publicadas.** El **encargado de sucursal** motiva e incentiva | Ranking en la pantalla A y en Cobertura (10b.8) |
| ¿Qué teléfono? | **El de la persona o el de la sucursal** | Funciona en navegador sin instalar nada; las fotos **no se guardan en la galería** (cámara dentro de la página, no la app de cámara); peso de cada foto acotado por los datos móviles de la persona. **Teléfono de la sucursal:** cada persona entra con **su** usuario, la pantalla muestra su nombre con «No soy yo», nunca una cuenta de dispositivo; sesión vencida → pide entrar de nuevo antes de subir (NP.7.L.4a); con la cola, no se pierde nada y al cerrar sesión avisa de fotos sin subir (NP.7.L.4b); cuentas en NP.7.L.11 |
| ¿Sucursal piloto? | **Padre Hidalgo** (código `01` en Kepler; en pantalla siempre por nombre) | Vista de sugeridos y pruebas arrancan ahí |
| ¿Para qué primero? | **1)** catálogo digital levantado · **2)** herramienta de IA para **Diseño**: foto de estudio y ficha técnica de cada producto, que después vive en el **verificador** y en los **folletos** · **3)** IA predictiva y sugestiva (§5.7, §5.9) | La captura debe dar fotos **aptas para estudio** desde el día uno (10b.9). Recapturar 6,500 productos después sería pagar el levantamiento dos veces |

**Siguen abiertas:**
1. Meta de cobertura y fecha (PM).
2. ¿**Cuándo** captura cada puesto? Cajero en horas flojas, recepción al recibir, anaquelista ¿en qué
   turno? Recomendado: lo organiza el encargado, que ya es quien motiva.
3. ¿Quién es **dueño del catálogo ampliado** cuando el levantamiento contradiga a Kepler: Compras o
   un responsable de Catálogo? La respuesta dice a qué rol se reparte `CATALOGO_FICHAS_REVISAR`
   (NP.7.L.15), que bloquea la bandeja L.3b. ✅ **Francisco, 2026-11-03: Compras y su gerencia**
   (`compras` + `gerente_compras`); nadie publica lo que él mismo levantó.
4. ¿Las fichas que se publican solas se revisan por muestreo? Recomendado: **1 de cada 20 por
   persona y por semana**; si se rechaza, esa ficha deja de contar en el ranking. ⛔ **Sin muestreo no
   hay premio** (§10b.8). ✅ **Técnicamente cerrada (2026-11-01):** en el piloto no hay publicación
   automática (todo va a «por revisar»); cada campo se enciende cuando el corpus NP.7.L.11b da un
   acierto ≥ al umbral, y desde ese momento corre el muestreo de 1 de 20 (§10b.3 punto 4). Queda
   para el PM sólo si el muestreo pesa en el premio.
5. ¿El ranking tiene **premio**, y quién lo paga? Si hay dinero, RH debe saberlo, y **mostrar nombres
   en el celular lo aprueba RH** si hay premio.

**De datos y técnica (las resuelve Francisco, pero deben quedar escritas):**
6. ¿Una ficha por SKU, o por SKU y sucursal? Recomendado: **por SKU**. El empaque no cambia por
   sucursal; Kepler sí repite el SKU en cada sucursal. ✅ **Cómo se compara entonces:** las
   compuertas comparan contra la **fila de `kdii` de la sucursal donde se capturó** (reusando la
   resolución de fila del verificador, `kp.service.ts:502-520`); si otra sucursal discrepa, es un
   **hallazgo y no bloquea**. La cobertura cuenta la ficha en **todas** las sucursales donde el SKU
   tiene existencia (§10b.3 puntos 4 y 6).
7. ¿Qué pasa cuando cambia el empaque (otra edición, otra temporada)? Recomendado: se puede volver a
    levantar con un **intervalo mínimo**, y la ficha anterior queda en historia, no se pisa.
    ✅ En el modelo: la anterior pasa a `historica` con `superseded_by`/`superseded_at` (§7.1).
    ⚠️ Y si lo que cambia es **Kepler** (Compras corrige un factor, cambia un código, marca el SKU
    obsoleto o lo recodifica), la ficha publicada no se queda rancia: la vuelve a comparar
    **NP.7.L.12** (re-conciliación de fichas vigentes).
8. ~~¿Retención de fotos y costo de almacenamiento: cuántas versiones se guardan?~~ ✅ **Cerrada en
    NP.7.0.9:** se guardan las fotos de la ficha vigente y de la anterior; las rechazadas por calidad
    se borran a los 7 días; las que tienen persona, al detectarlas (§10b.3 punto 7); las de altas
    descartadas las decide Francisco (D20). Tarea diaria con latido. El costo de almacenamiento se
    **mide** con 20 fotos reales en NP.7.0.9, no se estima.
9. ~~¿Funciona sin señal? La app de vendedor ya usa Dexie; `apps/view` está **por confirmar**.~~
   ✅ **Resuelta (2026-11-01):** `apps/view` **ya tiene** service worker (`app.config.ts:74`) y
   `OfflineDatabaseService` (Dexie, versiones 1–7, con tablas `photos` e `inventoryScans`;
   `offline-database.service.ts:18-22, 111, 141, 171-264`). La cola del levantamiento es **la
   versión 8 de esa misma base**, no una base nueva, con `client_uuid` por captura como hace
   `RoutePing` (un `client_uuid` repetido deja **una sola** captura en el servidor). Queda por
   **medir cuántas fotos caben** en el teléfono antes de llenar la cuota del navegador (NP.7.L.4b).

### 10b.7 ⭐⭐ ¿Qué unidad se fotografía: pieza, paquete o caja?

**Respuesta corta: cada unidad física que exista y se pueda tener en la mano, y el código de barras
decide cuál es.** La ficha es **una por SKU**, pero dentro lleva **una sección por peldaño** de la
escalera de Kepler (Base · Unidad Dos · Unidad Tres, ERP_KEPLER §2.1.1).

**1. El código escaneado dice qué unidad tiene la persona en la mano.** Kepler guarda un código por
peldaño:

| Código escaneado coincide con | Peldaño | Ejemplo bon o bon |
|---|---|---|
| `kdii.c7` / `c93` / `c102` ✅ | Base | la caja de 8 (si la Base es la caja) |
| `kdii.c82` / `c95` / `c96` ✅ | Unidad Dos | el corrugado |
| `kdii.c85` ✅ | Unidad Tres (el 99 % trae `C`+clave, p. ej. `C06001`) | — |
| `kdii.c97` / `c98` | ❓ **sin verificar** (casillas 2 y 3 de la Unidad Tres; el código ya las consulta, pero venían vacías en las capturas de ERP_KEPLER §3.y.4) | se trata como «código del SKU, peldaño desconocido» |

Decode de las casillas: ERP_KEPLER §3.y.4 (capturas de `78158` y `06001`) y `checado-codigo.ts`.
Coincidencia **exacta**, sin quitar ceros (§5.1 punto 4). ⚠️ La lista de `kp.service.ts` no trae
`c102`: no se copia.

Así **nadie tiene que saber qué es la «unidad Base»**. Escanea lo que tiene y el sistema sabe qué es:
**la persona sólo confirma el código; la IA propone el nivel físico y, si duda, decide Catálogo en
la revisión** (punto 5).

**2. Qué fotos se piden por peldaño.**

| Peldaño | Fotos | Por qué | Quién lo tiene a mano |
|---|---|---|---|
| **Unidad principal**: el peldaño **más vendido** de ese SKU, de `analytics.mv_kepler_sold_rung.rung_modal` (sucursal × SKU, 365 días, `kdm2.c58`, ADR-057), validado contra la escalera de `v_unit_truth`; no la decide la persona. Sin fila → **«unidad principal desconocida»**; ⛔ nunca se toma `box_factor` como unidad principal, ni `sales_daily.rung_factor` (deduce el peldaño por precio). (❌ Antes decía «la decide `v_unit_truth`»: esa vista no tiene ese dato) | **las 5 caras**, aptas para estudio (10b.9) | es la que va al catálogo, al verificador y al folleto | anaquelista / cajero |
| Cada **otro peldaño** que exista físicamente | **3 caras: frente + la cara con el código + la cara con la leyenda de contenido** («24 cajas de 8») | basta para identificarlo y para comprobar su factor; 5 caras de un corrugado no sirven para vender | recepción (corrugado), anaquel (paquete) |
| **Pieza suelta dentro de un paquete** | **no se abre mercancía.** Sólo si ya está exhibida suelta: **2 caras**, frente + código | abrir producto para fotografiarlo es merma | anaquelista |
| **Granel** (punto 6) | **1** foto del producto suelto (más la etiqueta del contenedor si la hay) | ver punto 6 | anaquelista / recepción |

Por eso la maqueta B dice «Paso N de **M**» con **M = 5** (unidad principal) / **3** (otro peldaño) /
**2** (pieza exhibida) / **1** (granel). Flujo: **A → B0 → B (M caras) → C**.

La ficha se **completa entre varias personas**: el anaquelista levanta la caja de 8 en el piso y
recepción levanta el corrugado al recibirlo. **Cada peldaño se publica por su lado**, y el ranking
cuenta peldaños publicados.

**3. Lo que el levantamiento comprueba contra Kepler, por peldaño (y por qué es oro).**
`UNIDADES_DE_MEDIDA.md` §2 mide que el catálogo y el ERP **discrepan en 73.6 %**, y la unidad ya
costó un error de 32× en costos. El levantamiento es **el primer testigo físico** de la escalera:

| Comprobación | Si no cuadra |
|---|---|
| El código escaneado está en la columna del peldaño que la foto muestra (se fotografía un corrugado, pero su código está en `c7`, el de la Base) | hallazgo «código en el peldaño equivocado» |
| La leyenda de contenido leída en la foto («24 × 8») contra el **factor resuelto** de `analytics.v_product_box_factor` (o `v_unit_truth`) con su veredicto, **nunca contra `c84` crudo** (ERP_KEPLER: `c84` en 0/1 = «Kepler no lo capturó», no «no tiene caja»; 7,247 SKUs así y 6,135 sí tienen escalera) | si `c84` está en 0/1: hallazgo **«factor no capturado»** con la foto como evidencia, que **no bloquea la publicación**. Si el factor resuelto no cuadra: hallazgo «factor distinto»: **no se corrige solo**; va a Compras con la foto como evidencia y se corrige **en Kepler** (ERP_KEPLER §2.1.1: el impreso es evidencia, la ficha del ERP es la fuente) |
| Un código que la persona escanea y **no está en ningún peldaño**, pero la IA reconoce el producto | hallazgo «código no registrado». ⛔ **No se liga solo**: se liga a mano en revisión |
| El mismo código en dos peldaños o dos SKUs | ya lo detecta `/compras/catalogo/codigos` (CV); no se captura |

**4. Lo que hay que MEDIR antes (C0), porque decide cuánto funciona el punto 1:**

Item: **NP.7.L.0** (C0), en la tabla única de §10b.5 (movido el 2026-11-01).

Si pocos peldaños mayores tienen código propio, **más fichas irán a revisión de Catálogo** (la
persona ya no elige la unidad: sólo confirma el código). Hay que **medir cuántas (L.0) antes de
prometer un % de publicación automática**. (❌ Antes decía «la persona elegirá la unidad con un toque
más»: era del selector retirado.)

**5. ⭐⭐ Identificar qué unidad se fotografía: pieza, empaque interior, caja exterior o granel** (Francisco, 2026-11-01)

> *«Los productos tienen unidad: pieza, paquete, caja, 500 gramos, kilogramo. Al momento de la
> captura hay que identificar qué unidad se está fotografiando: si es la caja exterior, el empaque
> interior o la pieza.»*

⭐ **Decisión de Francisco (2026-11-01): la persona SÓLO confirma el código que escaneó, nada más
para validar.** No elige la unidad. La unidad la identifican **el código** (en qué columna de `kdii`
está) y **la IA** (qué empaque ve en la foto); la persona aporta lo único que sólo ella puede
asegurar: *«sí, el producto que tengo enfrente es éste»*. Menos decisiones para quien captura
(Hick), y la unidad no depende de que el capturista sepa qué es un «empaque interior».

**La pantalla del paso (maqueta B0, después de escanear):**
```
┌──────────────────────────────────┐
│ ‹  Confirma el código            │
│                                  │
│   7500443006889                  │  ← lo que leyó el lector, completo
│   Bon o bon fresa ed. esp. 8 pz  │  ← nombre de Kepler para ese código
│   Kepler: CJA · factor 1 (Base)  │  ← rótulo y factor TAL COMO están en Kepler (informativo)
│                                  │
│   ¿Es el producto que tienes?    │
│   [ Sí, tomar fotos ]            │  ← primaria
│   No es éste                     │  ← secundaria → «escanea otra vez»; 2 veces → hallazgo
└──────────────────────────────────┘
```
- La persona **no edita** nada: confirma o rechaza.
- El renglón de Kepler muestra el **rótulo y el factor tal como están** (nunca «caja de regalo»:
  Kepler no tiene ese dato; el nivel físico lo clasifica la IA). Si el código cae en una casilla sin
  descifrar (`c97`/`c98`): «la identifica el sistema con la foto».
- «No es éste» dos veces seguidas con el mismo código → hallazgo **«el código no corresponde al
  producto»** (código cruzado en Kepler, o etiqueta pegada encima). Es un error de catálogo real.
- **Sin código** (granel, o un empaque que no tiene código propio): la persona escanea **lo que sí
  tenga código** (el bulto, la etiqueta del anaquel) o, si no hay nada, busca el producto **por
  nombre** y confirma igual. Esas fichas **nunca se publican solas**: van a revisión, porque falta
  el testigo del código.

Si la IA y el código no coinciden sobre la unidad, quien decide es **Catálogo en la revisión**, nunca
el capturista.

**El sistema clasifica el nivel físico (la persona no lo ve):**

| Nivel físico | Ejemplos de rótulo en Kepler (`c11`/`c80`/`c83`) |
|---|---|
| **Pieza**: la unidad individual que se consume | `PZA` |
| **Empaque interior**: paquete, display, bolsa, caja chica que viene dentro de otra | `PAQ`, `DSP`, `BOL`, a veces `CJA` |
| **Caja exterior**: corrugado, master, bulto, costal; lo que llega en la tarima | `CJA`, `BTO`, `CUB` |
| **A granel**: suelto, se vende **por peso** | `500`, `250`, `KG`, `2KG` |

⛔ **El rótulo de Kepler NO dice el nivel físico.** `CJA` puede ser una caja de regalo de 8 piezas
(empaque interior) o un corrugado de 24 cajas (caja exterior). Por eso la **IA** clasifica el nivel
físico de cada foto, el sistema lo **liga al peldaño** de Kepler por la columna del código, y los dos
se guardan por separado.

**Dos testigos de la unidad, más la confirmación de la persona:**

| Testigo | Qué dice |
|---|---|
| El **código** escaneado (confirmado por la persona) | qué producto es, y en cuál de las 9 casillas de `kdii` está (Base `c7`/`c93`/`c102` · Dos `c82`/`c95`/`c96` · Tres `c85`; `c97`/`c98` sin verificar, punto 1) → qué peldaño |
| La **IA** sobre la foto | qué nivel físico ve (corrugado con leyenda de contenido, empaque de venta, pieza, producto suelto) y qué contenido declara («24 × 8») |

- El nivel físico que ve la IA es compatible con el peldaño del código, y el contenido cuadra con el
  factor → la foto queda ligada a ese peldaño y puede publicarse sola **si pasa la lista única de
  compuertas de §10b.3 punto 4** (aquí no se repiten).
- La IA ve un corrugado pero el código está en la columna de la Base → **hallazgo «código en el
  peldaño equivocado»**, con la foto como evidencia. Es justo el tipo de error de unidades que ya
  costó (UNIDADES_DE_MEDIDA). No se publica sola; **Catálogo** decide.
- La IA ve un empaque que **no está en la escalera** (p. ej. el display de exhibición del proveedor)
  → hallazgo «empaque sin unidad en Kepler»; la foto se guarda sin peldaño.
- La IA no está segura del nivel → «revisar». **Nunca se le pregunta al capturista.**
- El ranking cuenta la ficha **cuando se publica**, así que lo que va a revisión suma después, no
  se pierde.

**6. A granel (500 g, kilo): lo que se puede fotografiar.** «500 g» no es un objeto: es una cantidad
que se pesa. Para un SKU con rótulo de peso:

| Qué se fotografía | Fotos | Para qué |
|---|---|---|
| **El contenedor en que llega** (bulto, costal, caja) | frente + **etiqueta con el peso** («16 KG») + código si tiene | comprobar el factor **por peso**: `91059 TURIN 16KG` = 32 × 500 g = 16 kg (ERP_KEPLER §2.1) |
| **El producto exhibido a granel** (en la vitrina o el contenedor de la tienda) | 1 foto del producto suelto, de cerca | la imagen del catálogo y del verificador |
| **Si la sucursal empaca porciones** (bolsa de 500 g hecha en tienda) | 1 foto, marcada **«empacado en tienda»** | no es empaque del fabricante: no se le leen sellos ni EAN |

Cuadre de granel: el peso de la etiqueta del contenedor ÷ el peso del rótulo base = el factor de
Kepler. Si no cuadra → hallazgo de factor, con la foto de la etiqueta como evidencia.

**7. Medir antes (se suma a NP.7.L.0):** la lista de rótulos que existen en `c11`/`c80`/`c83`, con su
frecuencia, y cuántos SKUs tienen escalera de peso. De ahí sale el mapa rótulo → nivel físico
**propuesto** (D10), que **Compras valida**, porque `CJA` no siempre es lo mismo.

**Forma de `photos`** (ya aplicada en la tabla de §7.1):
`[{ peldaño: 'base'|'dos'|'tres'|null, nivel_fisico: 'pieza'|'empaque_interior'|'caja_exterior'|'granel'|'empacado_en_tienda'|'otro', nivel_por: 'ia'|'catalogo', codigo_confirmado: boolean, cara, storage_key, sha256, captured_by, saltada_motivo: null|'no_tiene_esa_cara'|'no_se_puede_girar'|'otro' }]`.
Una cara saltada se guarda como renglón con `storage_key` nulo y su `saltada_motivo` (maqueta B).
`peldaño` es `null` cuando es «otro». El estado de publicación se guarda **por peldaño** dentro de
`sheet`, junto con los **dos testigos de la unidad (código e IA) + la confirmación de la persona** y
el apartado de 30 min de ese peldaño (`sheet.peldaños.<x>.apartado = {by, until}`, §10b.3 punto 5).

### 10b.8 Ranking (decisión de Francisco, 2026-11-01)

- **Cuenta peldaños PUBLICADOS, no fotos tomadas.** Una foto borrosa o un levantamiento rechazado no
  suma. Si contara capturas, el ranking premiaría la prisa y llenaría la bandeja de revisión.
- **Columna aparte: hallazgos confirmados contra Kepler** (código o factor equivocado que Compras
  confirmó). Vale más que una ficha y debe verse.
- **Dónde se ve:**
  - en la pantalla A (celular): «Vas 3.º en Padre Hidalgo esta semana», con el top 5 de la sucursal;
  - en Cobertura: por sucursal y por persona, para que el **encargado** lo use al motivar.
- **Periodo:** semanal y acumulado. El semanal deja que alguien nuevo alcance a los primeros.
- ⛔ **El ranking muestra nombres de personas.** Lo pidió Francisco; el premio, si lo hay, va a RH
  (10b.6, pregunta 5), y si hay premio, mostrar nombres en el celular lo aprueba RH.
- **Quién lo ve:** con `CATALOGO_LEVANTAR_COBERTURA_VER` (Compras y `encargado_tienda`), filtrado por
  alcance **en el servidor**; el encargado ve sólo su sucursal (NP.7.L.5). En la pantalla A, el top 5
  de la propia sucursal.
- **Trampas que se cierran** (un ranking con premio invita a inflarlo):
  - una foto con `sha256` repetido (la misma foto subida otra vez, o en otro SKU) → **por revisar**,
    no se publica sola y no suma;
  - **muestreo de 1 de cada 20** fichas publicadas solas, por persona y por semana; si se rechaza, esa
    ficha deja de contar. ⛔ **Sin muestreo no hay premio.**
- Item: **NP.7.L.11c** (vista del ranking), en la tabla única de §10b.5.

### 10b.8b Buscador de respaldo cuando el código de barras no alcanza (Francisco, 2026-11-01)

Si el escaneo no avanza (producto sin código, código dañado, código que no está en `kdii`, granel,
cámara que no enfoca), la persona **busca el producto** con el mismo buscador de **Cotización nueva**
de televenta (`apps/view/src/app/modules/televenta/pages/televenta-quote-new.component.ts`, l. 409):

- un solo campo que acepta **código de barras, SKU o nombre**, con palabras en cualquier orden;
- sin teclear nada, ↓ muestra **lo más vendido en la sucursal**, y el servidor ordena los aciertos
  exactos primero;
- ↑↓ y Enter eligen sin mouse; en el celular, toque;
- lo que no aparece **no se pierde**: allá se anota como «no manejado»; acá se convierte en
  **presolicitud de alta** con sus fotos.

⛔ **Se reusa la LÓGICA, no el endpoint.** `GET /commercial/quotes/catalog`
(`commercial-quotes.controller.ts:86`) exige `COMMERCIAL_QUOTES_VER` y devuelve **precio**
(`piece_price`, de `analytics.v_label_prices`). Darle a un cajero el permiso de cotizar para que
pueda buscar sería abrirle un módulo que no le toca. Entonces:
1. La búsqueda sale del servicio de cotizaciones a una función compartida en
   `libs/commercial/src/lib/shared/` (regla 16: un primitivo con dos usos vive en un solo lugar),
   y cotizaciones la sigue usando **sin cambio de comportamiento** (sus pruebas deben seguir verdes).
2. Un endpoint nuevo `GET /levantamiento/buscar?search` con `CATALOGO_LEVANTAR`,
   **sin precio ni costo**, que agrega lo que el levantamiento necesita: si la **unidad principal** de ese
   SKU ya está publicada y el estado de cada peldaño de su escalera (el mismo criterio de NP.7.L.1:
   «sin unidad principal publicada»; el buscador no cuenta «ficha» de otra forma que A y E).
   - **Lista blanca** (DTO propio en `libs/contracts`): `sku, name, content, barcode, unit_base,
     pack_size, box_size, sold_by_kg` + estado de los peldaños. ⚠️ La búsqueda que se reusa devuelve
     `piece_price`, `box_price` y `revenue` (`commercial-quotes.service.ts:661-677`): la prueba falla
     si aparece cualquiera de las tres.
   - **La sucursal no la manda el cliente:** sale de `ScopeService` (`warehouse=own`). Sólo quien
     tiene alcance de varias sucursales puede mandar `branch`; fuera de su alcance → 403. (❌ Antes
     decía `?branch&search`.)
   - «Lo más vendido» se entrega como **posición**, no como venta en pesos.
3. En pantalla, el buscador aparece **debajo** del botón de escanear como «¿No pasa el código?
   Búscalo». No compite con el escaneo: el escaneo sigue siendo la primaria.

**Lo que cambia en la publicación:** una ficha que entró **por búsqueda** no tiene el testigo del
código, así que **nunca se publica sola**; va a revisión (compuerta (a) de la lista única, §10b.3
punto 4). Si la foto de la base muestra un
código que la IA y el lector leen, ese código se compara contra `kdii` en la revisión: si no está
registrado, es un hallazgo.

Item: **NP.7.L.10**, en la tabla única de §10b.5 (movido el 2026-11-01).

### 10b.9 Fotos aptas para estudio (para que Diseño no tenga que volver a fotografiar)

**Lo que la captura exige desde el día uno** (los revisa el teléfono antes de subir):
- Resolución mínima: la cara del producto **≥ 1,500 px** en su lado mayor. El peso se controla al
  subir, no bajando la calidad de la cara principal. ⚠️ **1,500 px es provisional (NO MEDIDO):** lo
  confirma NP.7.L.0 midiendo con `getSettings()` las cámaras de 5 teléfonos de Padre Hidalgo. Si el
  teléfono no llega, la foto **se acepta** marcada `apta_estudio:false` y **la captura no se
  bloquea** (NP.7.L.8a).
- El producto **completo dentro de la silueta**, de frente, sin perspectiva.
- **Sin dedos encima.** El producto se **apoya** sobre una superficie, no se sostiene con la mano.
- **Fondo liso.** Recomendado: una **cartulina blanca por sucursal** (costo casi cero, y sube mucho
  la calidad del recorte).
- Nitidez y luz suficientes; un reflejo fuerte sobre la etiqueta se repite. La nitidez se mide con
  la **varianza del laplaciano**, con un umbral **calibrado** con 50 fotos buenas y 50 movidas
  (NP.7.L.8b, con prueba negativa); hasta entonces no hay umbral de nitidez.

**La herramienta de Diseño (segunda prioridad) va en su propio item, después del levantamiento.**
Una advertencia que debe quedar escrita desde ahora:

⛔⛔ **La «foto de estudio» se obtiene EDITANDO la foto real, no GENERANDO una imagen nueva.** El
verificador y el folleto le dicen al cliente *«esto es lo que vas a comprar»*. Un modelo que genera
la imagen puede **cambiar el texto de la etiqueta, los sellos NOM-051 o el contenido**. Eso viola la
ley 0 del estándar de interfaces («nada afirma lo que no es») y, en un folleto, puede ser publicidad
engañosa.
- Sí: recortar el fondo, enderezar, corregir color y luz, sombra uniforme.
- No: redibujar el empaque, «mejorar» la etiqueta, inventar caras que no se fotografiaron.
- Toda imagen editada guarda **cuál foto real la originó** y se puede comparar con ella.
- **Proveedor por decidir**: Claude lee imágenes pero no las edita ni genera. Elegir proveedor es una
  decisión de Edgar (D17), igual que ADR-007.

**La ficha técnica** (contenido, nutrición, alérgenos, sellos, factor por peldaño) ya sale de
`sheet.ampliado` + la escalera de Kepler: no necesita otra IA.

Items: **NP.7.L.9a/.9b/.9c**, **NP.7.L.8a/.8b** y **NP.7.D.1**, en la tabla única de §10b.5 (movidos el 2026-11-01).

---

## 11. Definición de Terminado

> En dos bloques (2026-11-01): el anterior sólo cubría las altas y contaba «3 permisos» cuando las
> claves nuevas son más.

**Tramo 1 — Levantamiento**

- [ ] L1. Métrica L medida **antes y después** en Padre Hidalgo (unidades de conteo de §10b.3), con el snapshot semanal de NP.7.L.5 — ⏳ 2026-11-03: HOY 0 % por construcción (0 fichas publicadas en prod; las 4 de la primera captura de prueba no traen foto); sin META (D15) ni NP.7.L.5
- [ ] L2. NP.7.L.2, NP.7.L.3b, NP.7.L.10, NP.7.L.12 y NP.7.L.13 (los que escriben o exponen datos) ejercidos contra base real con el payload del celular, incluidos dos escaneos simultáneos del mismo peldaño (sku, peldaño; la Base y el corrugado de un SKU no chocan) y el DTO de lista blanca (sin costo, margen ni proyección para quien sólo tiene `CATALOGO_LEVANTAR`) — ⏳ 2026-11-03: L.2 y L.3b 26/26 contra Postgres real en el CI; falta la capa HTTP, el bucket real y el DTO de lista blanca; L.12 y L.13 sin construir
- [ ] L3. Cada compuerta de publicación (NP.7.L.3a) **rota a propósito una vez**, con el rojo verificado
- [ ] L4. Costo de IA por ficha medido con las primeras 100 fichas (NP.7.L.11d) y presentado a Edgar antes de abrir otra sucursal; tracker + log al día (como el punto 6)

**Tramo 2 — Altas**

- [ ] 1. Métrica remedida: % de campos decididos por persona sobre ≥ 10 altas reales (de `fields_by_human/fields_total`, M = 31 de §4), y métrica 2 antes/después
- [ ] 2. Cada capa verificada **o declarada NO MEDIDA** (ADR-056). Lo de las vistas con `security_invoker` está en el punto 8 (vale para los dos tramos)
- [ ] 3. Los endpoints de NP.7.2.1–.5 y NP.7.2.7 ejercidos contra base real con el payload de la pantalla
- [ ] 4. Toda compuerta **rota a propósito una vez**, rojo verificado: cuadres, EAN existente, reglas duras NP.7.1.9, autonomía NP.7.1.11, 409 al aprobar (también bajo meta sin autorización), autorizar sin ligar no escribe en `margin_targets` (NP.7.2.7) y `product_id` NULL lanza error (NP.7.2.5), costo quitado en el servidor
- [ ] 5. El lector de fichas y el comparador ficha↔Kepler en `libs/` compartido
- [ ] 6. Tracker + log + roadmap al día

**Los dos tramos**

- [ ] 7. Cada clave nueva **repartida y medida en prod** (`permissions -> 'CLAVE' IS NOT NULL` + `npm run docs:matriz-accesos` regenerada): — ⏳ 2026-11-03: `CATALOGO_LEVANTAR` (184 personas) y `CATALOGO_FICHAS_REVISAR` (6 con la clave) repartidas y medidas en prod, MATRIZ regenerada; faltan `CATALOGO_LEVANTAR_COBERTURA_VER` (L.5) y las del tramo 2
  - `COMPRAS_ALTA_SOLICITAR` / `_APROBAR` / `_CAPTURAR` → Compras;
  - `COMMERCIAL_MARGIN_ENGINE_AUTORIZAR` → personas designadas de Dirección Comercial (§9: hoy sin rol ni personas; sin ellas, ⚠️ no ✅);
  - `CATALOGO_LEVANTAR` → **repartido a personas con cuenta activa** (a todo rol con personas desde el piloto, NP.7.L.7b; ❌ por persona, L.7a, reemplazado el 2026-11-02);
  - `CATALOGO_LEVANTAR_COBERTURA_VER` → Compras y `encargado_tienda` (NP.7.L.5);
  - `CATALOGO_FICHAS_REVISAR` → el dueño del catálogo (§10b.6 pregunta 3, NP.7.L.15).
  - Si Recepción sigue sin rol (D16): ⚠️, no ✅.
- [ ] 8. Cada vista que cruza `kepler_ods` con las fichas —sugeridos (NP.7.L.1), cobertura (NP.7.L.5), ranking (NP.7.L.11c) y las del tramo 2 (NP.7.0.6)— tiene `security_invoker = true` + `tenant_id` explícito, probada con dos tenants (B no ve lo de A) y con el rol del pod (§7.1) — ⚠️ 2026-11-03: los sugeridos (L.1) no son vista sino SQL de módulo con `tenant_id` explícito (`security_invoker` no aplica); su prueba de dos tenants: NO MEDIDA. La de la tabla sí (CI, NP.7.0.5)

---

## 12. Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
| 2026-11-03 | **Primera captura en prod (Francisco, celular, sucursal 01): ninguna foto llegó — seis defectos, ninguno visible en local.** Medido contra prod en sólo lectura: 4 fichas, todas con `storage_key` vacío; la del agua (SKU 59000) llegó a `fotos_tomadas` con las **5 caras saltadas y cero fotos**. (1) **La foto no se podía leer**: `medir()` armaba el archivo con `fetch(dataUri)` y la CSP de prod (`connect-src 'self' …`, sin `data:`) lo bloquea — confirmado en Chrome con la CSP real (control `fetch('/api/health')` 200; `fetch(data:)` bloqueado; `base64ToBlob` OK, JPEG `ff d8`); arreglo: `base64ToBlob` de `core/http/visit-form-data.ts`, ahora con prueba y con un barrido de las apps web que se pone rojo si alguien vuelve a hacer `fetch` de un `data:`/`blob:`. (2) **La pantalla de inicio daba 500**: `contexto()` pedía `identity.users.full_name`, que no existe (42703; la columna es `nombre`); la prueba de integración nunca llamaba a `contexto()` — ahora sí, con una persona en `identity.users` para comprobar el nombre. (3) **«Algo falló en esta pantalla» al escanear**: con linterna, `@zxing/browser` 0.2 cierra con una promesa que se rechaza, y el mismo defecto estaba en los **cuatro** lectores (levantamiento/caducidades, andén, verificador, conteo) → una sola pieza, `shared/util/lector-camara.util.ts` (`detenerLector`), que además apaga la cámara si termina de abrir después de «Cancelar». (4) **Una ficha sin ninguna foto llegó a revisión** → **el frente ya no se salta** (`LEVANTAMIENTO_CARA_OBLIGATORIA`, decisión de esta sesión: es la foto principal del catálogo y la primera cara, así que toda ficha completa trae al menos una foto real; un salto viejo del frente no cuenta y se vuelve a pedir) y **Catálogo no puede publicar una ficha sin fotos** (409: se descarta o se pide otra). Una primera versión rechazaba el último salto; la revisión independiente encontró que dejaba la captura sin salida si esa cara no pasaba la medición. (5) **No había cómo entrar**: el botón de cámara vive sólo en el header de las áreas y «Mi trabajo» (`/projects`) no monta ese layout, igual que le pasó a la Mesa de Servicio (MS.3.1); ahora «Levantar productos» está también en la cabecera de «Mi trabajo», con texto, probado pintado con y sin el permiso. (6) **Sin cámara, el «Tomar foto» de respaldo se arrastraba** a «Enviado» y pegado al borde: la cámara vive dentro del pie de los dos pasos que toman foto. **Prueba visual** (celular 390×844, claro y oscuro) con la **CSP exacta de prod** y la API simulada por un arnés local (nada llegó al API real; el socket de alertas, que el proxy del 4200 manda al 3334, también se cortó; control: en esa página `fetch(data:)` queda bloqueado): la captura del Turín con 5 fotos reales llegó completa (5 JPEG `ffd8ff`, 163–319 KB); una imagen lisa sale rechazada y pasa a «repetir»; en el frente no se ofrece saltar. Las fotos del Turín pasan la medición del teléfono (nitidez 285–1,588 contra 100; contraste 51–62 contra 18; control: con 2 px de desenfoque sale rechazada). El bucket recibe archivos en prod (testigo: adjuntos de la Mesa de Servicio del mismo día). **Revisión independiente** (5 revisores + un verificador adversarial por revisor): 18 hallazgos confirmados, ninguno alto, todos corregidos o declarados. Declarado, fuera de este cambio: con el permiso de cámara negado aparecen dos «Tomar foto» (componente compartido `camera-shot`); la CSP de prod bloquea la vista previa de video de Desarrolladores (`media-src`); en local no se sirve la CSP de prod. ⚠️ La ficha vacía del agua sigue en «Por revisar»: la descarta Compras. | Francisco + Claude |
| 2026-11-03 | **En prod.** Edgar fusionó el PR #481 (16:50Z) y aplicó las 3 migraciones una por una (16:58–16:59Z); prod sirve un commit que lo contiene. Medido en sólo lectura (5 agentes + contraste + crítico): rutas registradas (GET → 401, POST en el swagger), pantalla, pestaña y botón en el bundle, tabla idéntica a la migración con RLS forzada, 184 personas con `CATALOGO_LEVANTAR` y 6 con `CATALOGO_FICHAS_REVISAR` (16 pueden publicar contando superadmin), **0 fichas** al medir (antes de la primera captura de prueba). Nada posterior tocó NP.7; sin migraciones pendientes. Hallazgos: el camino de escritura (HTTP + bucket real) nunca ha corrido; fotos al bucket de la app sin retención y sin tenant en la llave (NP.7.0.9 ⬜, deuda); no se guarda el peso de la foto; la clave quedó en `sin_acceso`; L.8a y L.11d fuera del corte. `MATRIZ_ACCESOS` regenerada. Estados de §10b.5 a 🚀 (aterrizado, sin cerrar). Siguiente: captura controlada de punta a punta en prod. | Francisco + Claude |
| 2026-11-03 | **Revisión independiente del PR antes de enviarlo** (5 revisores + un verificador adversarial por hallazgo): 26 hallazgos, 25 confirmados, todos corregidos o declarados. El grave: **todo escaneo daba 500** (`? IS NULL` sin tipo, 42P18) y la prueba de integración que lo habría cazado **nunca se había corrido** — se corrió contra Postgres real local: 16/18 rojos → 26/26 verdes. Además: capturas soltadas que desaparecían de los sugeridos, fotos huérfanas al repetir una cara, crédito de la semana a quien creó la fila (no a quien terminó), filtro por `tenant_id` explícito, EXIF fuera (cliente re-codifica siempre + el servidor quita los metadatos del JPEG, `quitarMetadatosJpeg` en `platform-core`), sin apartado no se sube, otra sucursal reinicia, nadie publica lo propio, pantalla «repetir» con salida, contadores que mentían al retomar o al fallar una subida, dobles toques, el teclado del celular al cerrar la cámara, «Todas» de la bandeja con filtro, `down()` con RLS. Francisco decidió que la política de pisos de markup **no se publica** (el repo es público): §5.10 queda con nombres simbólicos y la skill `precio-consumidor` fuera del repo. Una segunda revisión de los arreglos encontró 3 regresiones medias de la pantalla (se atoraba en la captura con una cara fallida, «Escanear el siguiente» durante un reintento, 403/409 tratados como falla de red) y detalles; corregidos. | Francisco + Claude |
| 2026-11-03 | **Prueba visual + bandeja «Por revisar».** Recorrido del levantamiento en navegador de celular con API simulada: 6 hallazgos corregidos (texto de la cámara de gastos, «5 de 5» con cara saltada, botón principal de escaneo, silueta, pregunta de motivos, «empaque») y el teclado que se abría solo; componentes compartidos con entradas nuevas que por defecto no cambian nada. Bandeja (NP.7.L.3b) con su clave propia (NP.7.L.15: `compras` + `gerente_compras`, decisión de Francisco; migración en el mismo PR, sin aplicar). | Francisco + Claude |
| 2026-11-02 | **Universal (Francisco):** todos participan. `CATALOGO_LEVANTAR` a todo rol con personas (L.7b reemplaza a L.7a); el módulo sale del mapa de «Mi trabajo» y entra por el botón «Levantar productos» del header (precedente `servicio-reportar`); **D25**: quien no tiene sucursal la elige. `01055` corregido en Kepler por Francisco (traía errores). | Francisco + Claude |
| 2026-11-02 | **Primer corte en código (local, sin push).** C0: migración `catalog.product_sheets` + su suite de BD; SQL del universo medido contra prod en sólo lectura. C1: código → peldaño (`shared/kdii-codigo.ts`, movido del checado), GS1, reglas del levantamiento (estado nuevo `en_captura`). C2: `/catalog/levantamiento` (contexto, sugeridos, escaneo con apartado, fotos, saltar, soltar). C3: `/levantamiento` (A/B0/B/C) + medidor de calidad en `libs/ui-web`. `CATALOGO_LEVANTAR` declarado y **sin repartir**. NO MEDIDO: `up()` real, regla 13 de los endpoints, validación en dispositivo, umbrales de calidad. Pendiente del corte: buscador (L.10), bandeja «por revisar» (L.3b, L.15), worker de IA con topes (L.11d). | Francisco + Claude |
| 2026-11-02 | **Decisiones de Francisco** (§10a.4): caja exterior fuera del piloto (D23), buscador al primer corte, D24 aceptada, métrica 2 sin promociones, calidad de foto en vez de resolución (L.8b al primer corte), **construcción en local con revisión de Edgar al PR** (cabecera). NP.7.L.0 ✅ con `c97`/`c98` verificados en 3 pantallas de Kepler; §4: Imagen, clave y unidad SAT, IVA exento, objeto de impuesto y proveedor con su columna verificada. | Francisco + Claude |
| 2026-11-02 | **§10a nueva: mediciones C0 de sólo lectura** (NP.7.L.0, NP.7.0.3, NP.7.0.10) contra prod con `francisco` RO, fuera de horario hábil, cada una con control. Unidad principal escaneable en 86.3 % de la venta de Padre Hidalgo (13.7 % sólo por buscador); caja exterior con código propio sólo 12.6 % (Dos) y 1.8 % (Tres) → **D23**; `c99` vacío en todas las sucursales → **D24**; 133 SKUs no-físicos en el universo; la clave SAT vive en `kdfe33relprd`, no en `kdii` (§4 por confirmar en NP.7.0.1); métrica 2 HOY en la cabecera; n del proyector = 416. Maqueta E: «otras 7 sucursales». | Francisco + Claude |
| 2026-11-02 | Revisión de las maquetas en el navegador (HTML en `C:\DEV\_reportes`, fuera del repo): **D reescrita** (el veredicto daba «cumple» con el empaque a 13.8 % bajo su piso de reseller de §5.10 y con el bulto en blanco; ahora tabla de escalera por unidad con costo de llegada, markup, piso, margen, precio MD y precio al público, «Pedir autorización» primaria y 5 de 7 pendientes); **E corregida** (veredicto de la sucursal en curso, meta declarada «sin fijar», conteos cuadrados con A y F, «unidades publicadas»). Vocabulario único de unidades: pieza · empaque interior · caja exterior · granel (Base/Dos/Tres sólo en la Ficha para Kepler). En el HTML además: captura con nombre de la unidad, pasos rotulados, «repítela» y salida con confirmación; buscador con «reportarlo con fotos»; Por revisar como lista + ficha con la frase del problema; Ficha para Kepler, Conciliación y la liga con Productos nuevos dibujadas. | Francisco + Claude |
| 2026-11-02 | Francisco: «todo esto entra como catálogo digital». El módulo se llama **«Catálogo digital»** y es **una pestaña nueva del Centro de catálogo** (`&compras&catalogo`) con tres secciones: **Cobertura · Por revisar · Altas** (la pestaña «Solicitudes» pasa a ser «Altas», misma ruta). `&levantamiento` (celular) sigue como ruta propia porque su personal no tiene el permiso de Compras. Título, §10b.1 y migas de las maquetas E&F actualizados. ⚠️ Pendiente al construir: agregar la pestaña a `CATALOGO_TABS` (`apps&view&src&app&modules&compras&catalogo-tabs.ts`) y declarar el permiso. | Francisco + Claude |
| 2026-11-01 | Revisión multi-ángulo (7 revisores + verificación adversarial: 114 hallazgos, 1 refutado, 74 tras deduplicar) aplicada: casillas de código de Kepler (9, con c102), Línea/Tipo/Grupo/IVA/IEPS ya mapeados, catálogos SAT desde contpaqi_ods, tabla product_sheets con origin, métrica de cobertura definida, meta 1 a ≤ 20 % provisional (D18), margen lista vs lista, meta propia al ligar, regla de escalera como función SQL, permisos por persona en el piloto, fotos con personas (D6), tope de costo de IA, §10 en dos tramos con el primer corte en Padre Hidalgo. | Francisco + Claude |
| 2026-11-01 | §5.10 nueva: **política de markup de Compras** por papel de la unidad (pisos de nuevos por papel —mayorista, reseller y consumidor con 3 unidades— y de existentes en traslado; los valores, fuera del repo desde el 2026-11-03), los pisos son el mínimo y el sugerido busca subir; **precio sugerido al público** para todos los productos con ocasión de consumo (regalo / antojo / compartir), canal correcto y ganancia del cliente. Nueva skill `precio-consumidor` con el registro de evidencias (local, fuera del repo desde el 2026-11-03). §5.8 «el alta no inventa un piso» ❌ reemplazado. Items NP.7.1.23–.24; D21–D22. | Francisco + Claude |
| 2026-11-01 | Revisión verificada, bloque del levantamiento: §10b.3 punto 4 reescrito como **lista única de compuertas por peldaño** (a)–(f) (§10b.7, §10b.8b y la maqueta B remiten ahí; «dos testigos + la confirmación de la persona»); **en el piloto no hay publicación automática**, se enciende campo por campo con el corpus nuevo **NP.7.L.11b** (40 SKUs de Padre Hidalgo; D2 decide con los dos corpus; pregunta 4 cerrada en lo técnico); escaneo y apartado **por `(sku, peldaño)`** con UPDATE condicional y máximo 3 apartados; unidad principal desde `mv_kepler_sold_rung.rung_modal` (❌ «la decide `v_unit_truth`»); existencia de `v_erp_stock_on_hand` en el almacén de piso (❌ `kdil` crudo); compuertas contra la fila de `kdii` de la sucursal de captura (pregunta 6); cola sin señal = **Dexie v8** de `OfflineDatabaseService` con `client_uuid` (pregunta 9 resuelta); maqueta B con «paso N de M» (5/3/2/1) y motivo al saltar cara; maqueta C con tres variantes (❌ «la revisamos en unos minutos»); maqueta D con «Pedir autorización» primaria bajo meta, 409 en NP.7.2.3 y estados de análisis; maqueta F «Por revisar» y filas nuevas en §10b.2 (Por revisar, Ficha para Kepler, Conciliación); B0 con el rótulo de Kepler tal cual (❌ «caja de regalo»); 1,500 px provisional con `apta_estudio:false` y nitidez por varianza del laplaciano; safe-area; sin columna «Pasillo»; símbolos como íconos `pi-*`; item nuevo **NP.7.L.12** (re-conciliación de fichas vigentes); NP.7.2.5 propone «nuevo» en `new_product_reviews`; NP.7.3.2 sin «6 fotos» ni Capacitor. | Francisco + Claude |
| 2026-11-01 | Revisión verificada, bloque de permisos y cuentas: NP.7.2.6 con la clave de margen `COMMERCIAL_MARGIN_ENGINE_AUTORIZAR` (❌ `COMERCIAL_MARGEN_AUTORIZAR`; el motor sólo tiene la de lectura), en `authz-tree.ts` y `role-presets.ts`, fuera de `MODULE_GROUPS`; prueba de costo que recorre el JSON y excepción del capturista en `kepler-sheet`; §9 con Dirección Comercial sin rol ni personas, capturistas sin cuenta y costo de IA del levantamiento; NP.7.L.7 partido en **L.7a** (por persona, piloto) y **L.7b** (por rol, tras D16; D16 ya sólo bloquea L.6 y L.7b); items nuevos **L.11** (cuentas), **L.11c** (ranking), **L.11d** (worker de IA con topes y compuerta de costo antes de otra sucursal), **L.15** (`CATALOGO_FICHAS_REVISAR`); clave `CATALOGO_LEVANTAR_COBERTURA_VER` para Cobertura y ranking; sucursal desde `ScopeService`, no del payload; buscador con lista blanca; D6 reescrita (en el levantamiento **sí** aplica la regla 33) y §10b.3 punto 7 con recorte + `persona_visible` + borrado; trampas del ranking (`sha256` repetido, muestreo 1 de 20); teléfono compartido («No soy yo», nunca cuenta de dispositivo); pendiente agregar `/levantamiento` a Surfaces de `DESIGN.md`. | Francisco + Claude |
| 2026-11-01 | Revisión verificada, bloque de estructura: título «Fichas de producto: levantamiento y altas desde fotos»; OBJETIVO empieza por el levantamiento; **MÉTRICA L** (tramo 1) en la cabecera; MÉTRICA 1 con META ≤ 20 % provisional (D18: el markup cuenta como decisión humana) y fecha del PM; §4 recontado (M = 31; C decide 6 con 1 peldaño, hasta 8 con 3); unidades de conteo de la cobertura en §10b.3 (maquetas A y E alineadas); **§10 reescrito: tramo 1 levantamiento (piloto Padre Hidalgo, con primer corte) y tramo 2 altas**, el orden anterior ❌ reemplazado; D15 respondida en el orden (queda a Edgar fase propia o tramo, y cupo); items del levantamiento en una sola tabla por capa (§10b.5) y partidos L.3a–c, L.4a–b, L.8a–b, L.9a–c; NP.7.1.2b nuevo; tablas de §6 ordenadas por número; DoD en dos bloques; referencias rotas y dueños «dev» corregidos; preguntas técnicas de §10b.6 renumeradas 6–9. | Francisco + Claude |
| 2026-11-01 | Revisión verificada, bloque de predicción y cuadres (§5.2, §5.3, §5.6, §5.7): §5.3 «producto hermano» ❌ reemplazada por §5.7 y NP.7.1.5 absorbido por NP.7.1.8 + .1.9; cuadre de contenido con tolerancia que escala con las piezas y de nutrición **por porción** (`nutricion_porcion`); IEPS 8 % sólo en la lista del inciso J aprobada (bebidas y polvos → revisar); **exento ≠ tasa 0 %**; kNN con k = 5 y voto por conteo; embeddings en la base vectorial y sólo de SKUs activos (dos pasos, `measured:false` sin base vectorial); prueba hacia atrás sin fuga por EAN/recodificación + prueba temporal, línea base, precisión por clase y cota de Wilson con n mínimo; corre como tarea del API en prod, no desde la laptop; `np7_field_accuracy` única con `prueba` y `grupo_control`; métrica 2 como lista cerrada (a)(b)(c) con `cuenta_metrica_2` en NP.7.0.6. | Francisco + Claude |
| 2026-11-01 | Revisión verificada, bloque de margen y proyección (§5.8, §5.9): el veredicto contra meta usa el **margen de lista ponderado** (la meta es de lista) y el realizado se muestra aparte; la fuga se aplica con `1 − (1 − lista)/(1 − d)` (ejemplo 10.3 % → 10.47 %); la autorización se guarda **en la solicitud** y la fila de meta propia la escribe NP.7.2.5 al ligar (nunca `product_id` NULL); escalera como función SQL `analytics.fn_escalera_coherente` (no `price_action`, no copia en TS) con la regla de todo par; rótulo de meta por `target_source` (hoy sólo default); 12 meses desde `v_sellout_daily` (no el importer); `mv_new_products` sólo 180 días; prueba del proyector contra la cobertura esperada para su n + error y pérdida por cuantiles; umbral de equilibrio. Items nuevos NP.7.0.10 y NP.7.1.21; D3 y D14 aclaradas. | Francisco + Claude |
| 2026-11-01 | Francisco: **lo construimos nosotros** (no se pasa a otro dev) · §10b.8b buscador de respaldo, reusando la lógica del buscador de Cotización nueva de televenta en `libs/` compartido, con endpoint propio sin precio. Item NP.7.L.10. | Francisco + Claude |
| 2026-11-01 | Decisión de Francisco: el capturista **sólo confirma el código** escaneado; la unidad la deciden el código (columna de `kdii`) y la IA, y lo dudoso Catálogo. Se quitó el selector «¿Qué tienes en la mano?». | Francisco + Claude |
| 2026-11-01 | §10b.7 puntos 5–7: la unidad se CONFIRMA en la captura («¿Qué tienes en la mano?»: pieza / empaque interior / caja exterior / granel), con tres testigos (código, persona, IA) (❌ el selector se retiró el mismo día, fila de arriba: quedan **dos testigos, código e IA, + la confirmación de la persona**); granel por peso con la etiqueta del contenedor; `nivel_fisico` separado del rótulo de Kepler. Item NP.7.L.9. | Francisco + Claude |
| 2026-11-01 | Respuestas de Francisco: levantamiento es lo inicial; ranking de publicadas con el encargado motivando; teléfono propio o de sucursal; piloto Padre Hidalgo; prioridades catálogo → Diseño (foto de estudio, verificador, folletos) → IA predictiva. Agregadas §10b.7 (unidad por peldaño, el código decide), §10b.8 (ranking), §10b.9 (fotos aptas para estudio; editar, no generar); items NP.7.L.0, L.8, D.1; D17. | Francisco + Claude |
| 2026-11-01 | Agregada §10b: módulo «Fichas de producto» (Altas en Compras, `/levantamiento` para el personal, Cobertura); cinco preguntas de `diseno` §0b; maquetas A–E; levantamiento masivo (escaneo primero, publicación automática con compuertas, hallazgos contra Kepler); items NP.7.L.1–.7; D15–D16; tabla renombrada a `catalog.product_sheets` con `origin`. | Francisco + Claude |
| 2026-10-28 | Agregada §5.9: proyección de vida comercial que justifica el margen (lanzamientos parecidos de `mv_new_products`, cascada de lista a realizado con la fuga del motor, NO MEDIDO explícito, volumen fijo por elasticidad no medida, congelada al aprobar y probada hacia atrás). Items NP.7.1.19–.1.20, NP.7.3.6; columna `projection`; D13–D14. | Francisco + Claude |
| 2026-10-28 | §5.8 reescrita para vivir dentro del **Motor de Margen**: «%Margen» de Kepler es markup (99.11 %, `[PR.E0c]`); meta por `resolveMarginTarget` (default 11.55 %); reglas de precio = las del motor (escalera con su defecto de tolerancia declarado); excepción autorizada → fila en `margin_targets`; plan contra real con `[NP.15]`. Items NP.7.1.15/.17/.18, NP.7.2.7; D9 resuelta (Compras + Dirección Comercial); D11–D12. | Francisco + Claude |
| 2026-10-28 | Agregada §5.8 (escalera pieza/caja/bulto, costo desde la unidad negociada, margen por peldaño, reglas de precio, testigo de la primera entrada) e items NP.7.1.13–.1.16, D9–D10. | Francisco + Claude |
| 2026-10-28 | Agregada §5.7 (predicción que aprende: kNN + reglas SAT + prueba hacia atrás + autonomía por campo) e items NP.7.0.6–.0.8 y NP.7.1.8–.1.12, D7–D8. Acierto por campo: NO MEDIDO (depende de NP.7.0.1). | Francisco + Claude |
| 2026-10-28 | Plan redactado. Caso 95805: JSON leído de 5 fotos; EAN `7500443006889` con DV válido; captura de la pantalla de alta de Kepler (valores de fábrica USD / `01010101` / `2 KILOGRAMO`). Nada construido, nada medido en prod. | Francisco + Claude |
