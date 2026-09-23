# Fase COT — Cotizaciones de la Suite (`/cotizaciones`)

> **Ruta a seguir, no implementación.** Escrita el 2026-09-22 a pedido de Dirección, sobre el
> cimiento ya construido en `[E.12.0]` y el decode del CRM de Kepler de `[CRM.0]`.
> Estado: **📋 RUTA CON DECISIONES FIJADAS** (§5, Dirección 2026-09-22) — nada de COT.1 en adelante
> está construido. Arranque acordado: **COT.0 → COT.1**.

---

## 1. El pedido, en las palabras de quien lo pidió

> *"Que nuestros representantes puedan atender prospectos de clientes, o clientes que cotizan todas
> sus necesidades con varios proveedores y por subasta caen las órdenes, lo que ya se convierte en
> un pedido de telemarketing. Un dato importante: el input de la información del cliente llega de
> distintas maneras — quien envía un WhatsApp con una serie de requerimientos, quien manda un Excel,
> un Word o un TXT, quien llega a la sucursal y escoge mercancía en un carrito y pide que le coticen
> esa mercancía, o un asesor comercial en una mesa de negociación con un comprador profesional. El
> módulo debe apoyarse de IA para facilitar el trabajo de los vendedores y no tenerlos sentados
> haciendo capturas."*

Tres cosas que ese párrafo pide y el módulo de hoy **no** tiene:

1. **El que pide precio no siempre es cliente.** Puede ser un prospecto — y el prospecto ahora tiene
   catálogo propio, decodificado en `[CRM.0]`.
2. **Competimos.** El cliente pide lo mismo a varios proveedores y reparte por precio. **Perder una
   cotización es un dato**, y hoy no se guarda en ningún lado.
3. **El insumo llega crudo y en cinco formatos.** Hoy alguien lo transcribe. Ese alguien es el costo
   que la fase viene a borrar.

---

## 2. Lo que YA existe (medido, no supuesto)

**Esta fase no arranca en cero.** Medido el 2026-09-22:

| Pieza | Estado | Dónde |
|---|---|---|
| `commercial.quotes` + `quote_lines` + folio `COT-YYYY-NNNNN` | ✅ construido, 22/22 en smoke | `[E.12.0]`, mig `20260921190000` |
| Mesa de cotizaciones + permisos propios + HTTP con rol mínimo (25/25) | ✅ | `/telemarketing/cotizaciones` |
| **Match AI de producto** (Voyage + KNN + rerank Haiku, umbral 0.40) | ✅ en prod | Fase K · `AiProductMatcherService` |
| **Extracción de imagen/PDF → renglones + match** | ✅ en prod | `TicketExtractorService`, `LlmExtractorService` |
| Lectura de XLSX (`exceljs`) | ✅ en 6 módulos | exports de CB, replenishment, BI… |
| PDF propio con Chromium | ✅ | `AnexoVentaService` (Fase AX) |
| Pedido con folio, máquina de estados y reserva de stock | ✅ | `commercial.orders` (Fase B.2) |
| Prospecto del ERP: `kdudp` + catálogos + embudo `kdvavance` | ✅ **ya en `kepler_ods`** | `[CRM.0]` · `ERP_KEPLER.md` §3.c |
| Cotización del ERP: doctype `U-D-35-1` | ✅ en `kepler_ods` | `[CRM.0]` |

### 2.1 ⭐ El proceso ya existe y deja rastro — hay baseline, no hace falta inventarlo

Medido contra la réplica cruda de Wincaja (`192.168.0.222:5433/wincaja`, 8 schemas):

```
                cotizaciones   vendidas           periodo
h00 (histórico)      70,425     23,635
h70                  24,321     22,672
h30                  14,206      6,946
h50                  10,497      7,872
h10                   9,467      6,852
w00  CEDIS  ⭐        6,607      3,574 (54.1%)   2026-01-02 → 2026-09-21
w30  Mor. Abastos     2,453      1,329           2026-07-26 → 2026-09-17
w32  Mor. Madero        633        167           2026-07-01 → 2026-09-07
─────────────────────────────────────────────
TOTAL               138,609     73,047  =  52.7% de conversión
```

⭐ **El CEDIS cotiza HOY** (`w00`, última cotización **ayer**): 6,607 en 2026 con **54.1 %** de
conversión. Y `FaltantesDeCotizaciones` registra lo que el cliente pidió y no había — **w00 1,272 ·
w30 6,134**, y 150,445 en el histórico `h70`.

**Tres consecuencias para la ruta:**

1. **El módulo nuevo tiene contra qué medirse.** Una cotización de la Suite que convierta por debajo
   de ~54 % es un retroceso, no un estreno. *Un módulo que nace sin baseline siempre "mejora".*
2. **El "faltante de cotización" no es un concepto nuevo**: el POS lo lleva desde hace años, y
   `commercial.floor_stockouts` (Fase FLT) captura el mismo hecho en el mostrador. Es **demanda que
   rechazamos**, y tiene que terminar en **una** bandeja, no en tres.
3. ⚠️ **`w30` y `w32` se congelan por migración a Kepler, no por abandono** (sus POS migraron el
   18-sep y el 08-sep). Leer esa caída como "dejaron de cotizar" sería un error de lectura.

### 2.2 ⭐⭐ Qué significa ese 52.7 % — la lectura del negocio corrige la del dato

Dirección, sobre el mismo histórico (2026-09-22):

> *"Las cotizaciones tienen muy poca efectividad, sobre 50 %, lo cual termina la mayoría de veces
> haciendo una nueva captura por cambios de precio y vigencia de las mismas. Sólo es un protocolo
> que siguen muchos mayoristas que cotizan, como práctica."*

**Eso reordena la fase.** Un 52.7 % no es una tasa mala que haya que subir a fuerza de perseguir:
es **el rendimiento normal de un protocolo de compra** — el mayorista pide precio a varios, por
costumbre, y la mitad no termina en nada. Perseguir esa mitad es empujar contra el proceso del
cliente.

⭐ **El desperdicio no está en la cotización perdida: está en la GANADA que hay que capturar dos
veces.** Cuando el cliente vuelve —días después, con el precio ya movido o la vigencia vencida— hoy
se captura **de nuevo, desde cero**. Ése es el trabajo que se puede borrar entero, y no depende de
convencer a nadie.

**Consecuencias, que cambian el orden de la ruta:**

| | |
|---|---|
| **La métrica principal NO es la conversión** | Es **cuántas cotizaciones se re-capturaron a mano**. La conversión se publica igual (contra el 52.7 % de §2.1), pero como contexto, no como meta |
| **Re-precio ≻ persecución** | Volver a precificar una cotización existente en un clic pasa de adorno a **núcleo** (COT.5). Recotizar no es copiar: es **la misma cotización, versión nueva**, conservando el linaje |
| **La vigencia deja de ser un adorno legal** | Es el disparador: vencida ⇒ *"recotizar"*, no *"capturar otra"* |
| **Y da el corpus de entrenamiento gratis** | Cada re-cotización es el mismo cliente pidiendo lo mismo. Es el mejor dato posible para el bot de COT.8 — pares pedido→cotización ya validados por un humano |

---

## 3. La ruta

Ordenada **por dependencia**, no por vistosidad. Cada tramo entrega algo usable por sí solo.

### COT.0 — Darle casa al que pide precio sin ser cliente ⬜

Hoy `quotes` acepta `customer_id` **o** un nombre suelto. Con `[CRM.0]` el prospecto es una entidad
real, con clave, sector, zona, tamaño y el medio por el que llegó.

- Vista **`derive-no-copy`** `commercial.v_erp_prospects` sobre `kepler_ods.kdudp` ⋈ `kduj` (sector)
  ⋈ `kduk` (zona) ⋈ `kdvmedios` ⋈ `kdvtamano`. **Sin importer** — la regla ⭐ del proyecto se cumple
  sola, porque `kdudp` ya está replicada con sus 110 columnas.
- `quotes.prospect_branch` + `prospect_key` — la llave es **`(sucursal, clave)`**: `kdudp` está
  propagado idéntico en 7 ramas y agrupar por clave sola multiplica por 7 (§3.c). El CHECK pasa a
  **una de tres**: cliente · prospecto · contacto suelto.
- `origin` gana los canales que faltan: `whatsapp`, `email`, `file`, `negotiation` (mesa).
- ⛔ **Bloqueo a resolver antes de codificar:** `kdvcontactos` (el contacto del prospecto, con correo
  y teléfono) **no está en el ODS** y hoy ya tiene dato. Es una línea en la replicación.

**Entrega:** cotizarle a un prospecto que todavía no es cliente, sin inventarle un registro.

---

### COT.1 — El motor de precio ⬜ ⛔ RUTA CRÍTICA

Es `[E.12.1]`, y **nada de lo demás sirve sin esto**: un módulo que no sabe poner precio obliga al
vendedor a hacer justo lo que la fase viene a evitar.

#### ⛔ El contrato: sólo se cotiza con lo que el ERP autoriza — son CINCO mecanismos, y no hay un sexto

Decidido por Dirección el 2026-09-22, y es un **candado, no una guía**:

| # | Mecanismo | Fuente | Estado en el ODS |
|---|---|---|---|
| 1 | **Descuento del cliente** | `kdud.c17` (y `c18` el segundo) | ✅ replicada · ⚠️ **es por sucursal**: 57 clientes lo tienen distinto entre plazas (§3.1 de `FASE_E12`) |
| 2 | **Descuento por volumen / por piezas** | `kdpv_descuxq` | ✅ 13 cols · **396 reglas vigentes de 56,995** |
| 3 | **Descuento por monto por artículo** | `kdpv_descuxm` | ✅ 13 cols · **0 vigentes hoy** |
| 4 | **Producto gratis por piezas** | `kdpv_gratisxq` | ✅ 16 cols · **0 vigentes hoy** |
| 5 | **Producto gratis por monto** | `kdpv_gratisxm` | ✅ 16 cols · **0 vigentes hoy** |

**El vendedor no puede inventar un descuento.** El precio de una cotización es siempre la derivación
de esos cinco, y lo que quede fuera **la pantalla lo rechaza** — no lo "avisa". Eso simplifica la
fase: el descuento deja de ser una facultad discrecional y pasa a ser un cálculo auditable.

⚠️ **Que tres de los cinco estén hoy en cero se DECLARA, no se interpreta** (ADR-056): no significa
que no se usen, significa que hoy no hay ninguna regla activa. El motor los lee igual, porque el día
que alguien cargue una promoción tiene que aplicarse sola.

⭐ **Y no se arranca de cero:** `analytics.erp_promotions` **ya es una VISTA** sobre los cuatro
`kdpv_*` (tipo · umbral · beneficio · producto gratis · vigencia · almacén), y
`analytics.v_label_promotions` ya resolvió el caso difícil —vigencia, tienda y **presentación**— con
su `pct` **verificado contra ventas (113 vs 2)**. El motor **extiende ese resolvedor**; no escribe
uno nuevo. ⛔ Y se deriva por vista: nada de importer que materialice precios (regla ⭐ del proyecto).

- Las **cuatro trampas ya medidas** en `FASE_E12` §3.2 siguen en pie: sólo 0.7 % de las reglas
  vigente · el descuento es **por unidad**, no por producto · los centinelas de fecha
  (`1800-01-01` / `2106-02-28`) · y reglas triplicadas que un JOIN sin deduplicar multiplica.
- Cada renglón declara **`price_source`**: de dónde salió ese precio. Un precio bajo tiene que ser
  *explicable*, no *sospechoso*.
- ⭐ **Y muestra el margen con el costo arbitrado** (ADR-059/051), no con `cost_base`. Es la defensa
  contra el incidente que fundó la Fase OBS: un SKU publicado **54 % abajo de costo** seis días.
  Cotizar bajo costo debe ser posible —a veces se hace a propósito— pero **nunca sin que la pantalla
  lo diga**.
- Lo que no se puede precificar va **NULL con motivo**, jamás `$0` (ADR-056).

**Entrega:** una cotización completa, con precio defendible y margen a la vista.

---

### COT.2 — La bandeja de entrada: un solo buzón para los cinco caminos ⬜

**El corazón del pedido.** Tabla nueva `commercial.quote_intakes`: guarda **el insumo crudo tal como
llegó** (texto pegado, archivo, foto), su canal, quién lo mandó y en qué estado va
(`recibido → interpretado → en revisión → cotizado`).

| Cómo llega | Con qué se resuelve | Estado |
|---|---|---|
| Pega el texto del WhatsApp o del correo | textarea → COT.3 | ✅ se puede hoy |
| Excel / CSV | `exceljs`, ya usado en 6 módulos | ✅ se puede hoy |
| PDF o foto de la lista | `LlmExtractorService` (Haiku vision, lee PDF nativo) | ✅ se puede hoy |
| TXT | trivial | ✅ |
| Word (`.docx`) | falta una librería (`mammoth`) | ⬜ 1 dependencia |
| **WhatsApp automático** | **BSP sin decidir (ADR-006), Fase F ⏸️** | ⛔ **bloqueado** |

⚠️ **WhatsApp: cascarón ahora, cimiento para el bot** (decidido el 2026-09-22). El canal se registra
como tal (`channel='whatsapp'`, el remitente, el texto crudo) pero **entra a mano** —reenviado o
pegado— hasta que haya BSP. La tabla y el flujo **no cambian** cuando el bot llegue: lo único que
cambia es quién deposita el mensaje. Prometer el bot antes de tener proveedor es la forma de que la
fase se lea como incompleta cuando en realidad entregó lo que importaba.

**Entrega:** el insumo del cliente entra al sistema sin que nadie lo transcriba, y **queda guardado
el original** — para poder auditar después qué se pidió de verdad, y para entrenar (COT.8).

---

### COT.3 — El intérprete: de texto crudo a renglones cotizables ⬜

El tramo de IA, con el patrón de la casa: **el motor propone, la persona aprueba** (ADR-016/020).

1. **Haiku** convierte el texto o el archivo en renglones estructurados (cantidad · unidad · lo que
   el cliente escribió, textual).
2. **`AiProductMatcherService`** (Fase K, ya en prod) casa cada renglón contra el catálogo.
3. Tres destinos, no dos: **alta confianza** pre-llenado · **baja confianza** a revisión con sus
   alternativas · **sin match** → `requested_text` + `availability`, que es *demanda que estamos
   rechazando* y va a la misma bandeja que los faltantes (§2.1).

⚠️ **El gate se mide antes de prometer.** Precedente propio: `[HV.0]` **no pasó** su gate con 24–29 %
de recall leyendo fotos de anaquel de dulcería a granel. Una lista escrita debería ir bastante mejor
que una foto, **pero eso se mide con listas reales de clientes antes de publicar un número**. La
métrica es *% de renglones que el operador no tuvo que tocar*.

⚠️ **La unidad es el campo minado del proyecto** (ADR-055/057). "10 cajas de mazapán" y "10 mazapanes"
no son lo mismo, y el cliente escribe las dos igual. El intérprete **declara la unidad que entendió**
y la deja editable; si no la entiende, la pregunta — no la asume.

**Entrega:** el vendedor deja de capturar y pasa a **revisar**.

---

### COT.4 — El mostrador: el carrito que pide cotización ⬜

El caso *"llega a la sucursal, escoge mercancía y pide que se la coticen"*. **Ya sucede** (§2.1: w00
lo hace hoy, en Wincaja). Lo que falta es que termine en la Suite.

- Reusa lo que ya está en el mostrador: `/tienda/verificador` (con su snapshot offline por sucursal)
  y el kiosco `/tienda/faltantes`.
- `origin='counter'` ya existe en el esquema.

**Entrega:** la cotización de mostrador deja de morir en el POS.

---

### COT.5 — Entregarla, y sobre todo **RE-COTIZARLA** ⬜ ⭐ el ahorro más grande

`[E.12.3]` + `[E.12.5]`. El PDF reusa el Chromium de `AnexoVentaService`. Vigencia real: hoy una
cotización vencida **sigue diciendo `sent`** — la mesa lo declara, pero nadie la cierra sola.

⭐ **Y acá vive el ahorro que §2.2 identificó.** Una cotización vencida o con el precio movido **no
se captura de nuevo: se re-precifica**.

- **Versión, no copia.** `quotes.version` + `superseded_by`: misma cotización, precio nuevo, linaje
  completo. Lo que el cliente pidió no se vuelve a teclear **nunca**.
- **Re-precio en un clic**: se vuelven a correr los cinco mecanismos de COT.1 sobre los mismos
  renglones, y la pantalla muestra **qué se movió** (este SKU subió 4 %, éste perdió la promoción,
  éste ya no lo manejamos).
- **Un renglón puede morir entre versiones** — se descontinuó, o la promo venció. Eso se muestra,
  no se borra en silencio.

**Entrega:** el cliente recibe un documento; y cuando vuelve tres semanas después, nadie vuelve a
capturar su lista.

---

### COT.6 — ⭐ La subasta: por qué se ganó y por qué se perdió ⬜

**Lo que hace inteligente al módulo, y hoy no existe en ningún sistema de la casa.** El cliente pide
lo mismo a varios proveedores y reparte por precio; si sólo se guarda `rejected`, se tira la única
información que valía la pena.

- Desenlace **por renglón, no sólo por cotización**: casi nunca se pierde todo — se pierden tres SKUs.
- Motivo tipificado (precio · plazo de entrega · crédito · no lo manejamos · no contestó) y, cuando
  es precio, **contra qué precio** se perdió.
- ⛔ **Ese precio lo dice el vendedor, no lo medimos**: entra con `source='vendor_reported'` y **nunca
  se mezcla** con el precio realizado (ADR-059: cada número declara con qué se calculó). Sirve para
  orientar, no para cuadrar.
- Anti-fatiga: se pregunta al cerrar la cotización, en un clic, no en un formulario.

**Entrega:** el primer dato de precio de competencia que la empresa haya tenido, y una tasa de
conversión comparable contra el 52.7 % histórico.

---

### COT.7 — Convertirla en pedido ⬜

`[E.12.4]`. **El único punto de toda la fase que toca inventario.** Crea un `commercial.orders`
normal y lo apunta (`quotes.order_id`, con el CHECK que ya impide convertir lo que no está
`accepted`). De ahí en adelante el pedido sigue el camino que ya existe — telemarketing, surtido,
logística.

---

### COT.8 — El bot que cotiza, y el vendedor que valida ⬜

**El destino declarado por Dirección** (2026-09-22): *"que posteriormente un bot con machine learning
haga esa actividad completa; el vendedor sólo validaría y asistiría en el machine learning"*.

⭐ **Por eso el colector se construye ANTES que el aprendiz** (ADR-021, `ship-collector-before-learner`
— la lección de Horus.L). El bot de mañana **no se puede entrenar con datos que hoy no se guardan**,
y ningún backfill los inventa. Desde COT.3, cada cotización deja escrito:

| Se guarda desde el día 1 | Para qué sirve después |
|---|---|
| El **texto crudo** del cliente (COT.2) | La entrada del modelo |
| Lo que la IA **propuso**: SKU, cantidad, unidad, confianza | La predicción |
| Lo que el humano **dejó, cambió o descartó** | ⭐ **La etiqueta** — la corrección es el dato de oro |
| El **desenlace** (COT.6) y la **re-cotización** (COT.5) | Si la propuesta además vendió |

Sin esa tabla de correcciones, dentro de un año hay que empezar de cero. Con ella, el bot se entrena
con el trabajo que los vendedores ya hicieron igual.

Y mientras el bot no existe, el mismo colector ya paga solo:

- **Lo que le falta al carrito**: la canasta recomendada de Thot (`[D.4]`) ya calcula base / foco /
  exploración / innovación por cliente.
- **Aviso de margen** antes de enviar (con el costo arbitrado, no el del catálogo).
- **Redactar la respuesta** al cliente en su canal, para que el vendedor edite y mande.

Cada una con aprobación humana. Ninguna decide sola — y esa aprobación **es** el dato de entrenamiento.

---

### COT.9 — Medir ⬜

Conversión · ciclo (de que llega la lista a que sale el precio) · **% de renglones que la IA dejó
listos sin tocar** · demanda rechazada por SKU. Todo **por canal** y contra el baseline de §2.1.

---

## 4. La decisión de superficie: `/cotizaciones`, no `/telemarketing/cotizaciones`

Hoy vive colgada de Telemarketing. Pero el insumo llega de **mostrador, ruta, portal, telemarketing y
mesa de negociación** — es transversal, y dejarla adentro obliga a quien atiende el mostrador a
entrar por una puerta que dice "televenta" y que además exige `COMMERCIAL_TELEVENTA_OPERATE`.

**Recomendación:** proyecto propio `/cotizaciones` dentro de «Mi trabajo» (ADR-061 · Fase SN), con
sus permisos `COMMERCIAL_QUOTES_*` que **ya existen y ya están repartidos**, y Telemarketing
enlazando a él. ⚠️ Mover la ruta arrastra el `televentaGuard` que hoy la tapa — que es justamente el
pendiente declarado en `FASE_E12` §5 (`direccion` tiene `_VER` y no puede entrar).

---

## 5. ✅ Las cinco decisiones — RESUELTAS por Dirección (2026-09-22)

| # | Decisión | Qué se decidió | Consecuencia directa |
|---|---|---|---|
| 1 | Superficie | **`/cotizaciones`**, como lo nombró Dirección | Proyecto propio (§4); Telemarketing enlaza. ⚠️ arrastra el `televentaGuard` que hoy lo tapa |
| 2 | ¿También en Kepler? | **NO. La captura vive en la Suite.** *"El módulo de cotizaciones del ERP está en modo fábrica, no se ha tocado; hay deuda técnica de adaptación, que sería lo mismo que trabajarlo desde aquí"* | Cierra el riesgo de doble captura, y **la Suite es la única fuente de la cotización**. El `U-D-35` de Kepler queda como lo que es: un módulo de fábrica sin configurar |
| 3 | Alta de prospectos | **En el ERP** — *"la tabla ya existe"* | La Suite **lee** `kdudp` por vista (COT.0) y **no** crea un segundo padrón. Nada de tabla propia de prospectos |
| 4 | WhatsApp | **Cascarón ahora, cimiento para el bot** | COT.2 se entrega ya, sin esperar el BSP; el canal queda modelado y la tabla no cambia cuando llegue (§COT.2) |
| 5 | Descuentos | **Sólo los 5 mecanismos que autoriza el ERP** — cliente · volumen/piezas · monto por artículo · gratis por piezas · gratis por monto | **No hace falta umbral de margen ni flujo de aprobación**: el vendedor no puede inventar un descuento. Lo que no deriva de los cinco, la pantalla lo **rechaza** (§COT.1) |

⭐ **La decisión 5 es la que más simplifica la fase.** Se había planteado como *"¿quién autoriza
cotizar bajo margen?"* — con umbral, bandeja y aprobación, calcando `[TP.6]`. **No se necesita nada
de eso**: el descuento no es una facultad discrecional, es una derivación de reglas que ya viven en
el ERP. Se cambia un flujo de aprobación completo por **un candado y un cálculo auditable**.

⚠️ Lo que la decisión 2 **no** elimina: si alguna vez alguien captura una cotización en el Kepler de
fábrica, va a existir en un lugar que la Suite no mira. Eso se resuelve con un acuerdo de operación
—nadie cotiza en el ERP—, no con código.

---

## 6. Lo que esta ruta declara que NO sabe

- **Cuánto acierta la IA sobre listas reales de clientes.** No hay corpus medido. El gate de COT.3 se
  corre con listas de verdad **antes** de publicar un número. Precedente: `[HV.0]`.
- **Si `kdvcontactos` alcanza** para el contacto del prospecto — hoy tiene **1 fila** en la rama 01.
- **Los importes del `U-D-35` de Kepler** siguen sin decodificar: las 3 cotizaciones que existen en
  el ERP están en ceros (`ERP_KEPLER.md` §3.c). ✅ **Dejó de importar** con la decisión 2 de §5 — la
  captura vive en la Suite. El decode queda anotado por si algún día se lee ese módulo de fábrica.
- **Cuántas cotizaciones se re-capturan hoy a mano** (§2.2): Dirección lo reporta como *"la mayoría
  de las veces"*, pero **no está medido**. `MaestroCotizaciones` no tiene un campo de "esta es la
  segunda vuelta de aquélla" — habría que inferirlo por (cliente + canasta parecida + ventana de
  días), y eso es un cruce por parecido, con su piso de ruido. **Es la línea base del ahorro que
  COT.5 promete**, así que conviene medirla antes de construirlo, no después.
- **La etapa comercial del prospecto ("Lead")** no resuelve a ningún catálogo, y `kdvavance` —que sí
  es el embudo, con probabilidad de cierre— **no existe en la rama 01**.
- **El contenido de `wincaja.cotizaciones` en prod** (19,621 filas según `ESQUEMA_BD_PROD.md`): en
  `platform_test` la tabla está **vacía**, así que el baseline de §2.1 se midió contra la **réplica
  cruda**, no contra el ODS de prod. Son universos distintos y hay que cuadrarlos antes de publicar
  la conversión como cifra oficial.
