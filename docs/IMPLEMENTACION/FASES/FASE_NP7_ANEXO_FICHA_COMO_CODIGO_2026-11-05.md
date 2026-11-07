# NP.7 · Anexo: la ficha como código (visión de Francisco, 2026-11-05)

> Anexo de [`FASE_NP7_ALTA_DESDE_FOTOS.md`](FASE_NP7_ALTA_DESDE_FOTOS.md) (§10c lo resume y apunta aquí). Las referencias «l. NNN» son líneas del plan principal al 2026-11-05 y pueden correrse.

> Diseño de sólo lectura del 2026-11-05, corregido el mismo día por una revisión escéptica. **No abre fase ni pasa nada a 🔨 por sí mismo.** Rige §10 punto 2 (l. 978): hasta que Edgar resuelva D15 y el cupo (hoy 7 de 4), sólo diseño y la C0 de sólo lectura. D1 («dentro de NP.7») la contestó Francisco; falta que Edgar la asiente en el Tablero PM (l. 925).
> Esta sección **propone** items **NP.7.F.n** («F» = ficha como código), las decisiones **D26–D34**, la revisión de D19 y una aclaración de D17. Cada item es alcance que Edgar acepta o rechaza.
> - Las afirmaciones del código llevan `archivo:línea`, verificadas en el árbol local el 2026-11-05. Sin git: **no se verificó el estado de commit**.
> - Las de fuera llevan URL y fecha. Las marcadas **(re-verificada)** las leyó la revisión el 2026-11-05; el resto viene de la investigación y **no se re-verificó**.

### 1. La visión, textual

> «La intención de las fotos con partes de personas no hay problemas, con rostros y rasgos faciales sí. La intención pura y llana de las fotos es que la IA elabore la foto de estudio y extraer su información JSON para que la IA comience a hacer disrupción, que la información genere fichas técnicas amplias, en la página web se incluya la descripción como herramienta de búsqueda, que se nutra la información desde el concepto que facilita la lectura, es llevar la imagen a código y respuestas rápidas desde asistencia IA, análisis, comparaciones, auditoría, colocarnos en las primeras filas de búsqueda de la IA porque vamos en su lenguaje y todo lo bonito por fuera pero el código para que entre como espada afilada y genere disrupción en el mercado por esta ardua extracción de datos.»
> — Francisco, 2026-11-05. Sólo se corrigió la ortografía.

### 2. Qué significa técnicamente: una fuente, tres salidas y cuándo llega cada una

**La fuente es una sola**, en tres partes:
1. La lectura de cada foto: el JSON del contrato [`lectura-foto.contract.ts`](../../../libs/commercial/src/lib/product-sheets/ia/lectura-foto.contract.ts), guardado en `ai_raw`. Cada dato trae el texto del empaque que lo respalda.
2. Lo que **una persona acepta** en `catalog.product_sheets.sheet->'ampliado'`.
3. Lo que es de Kepler: descripción, escalera y códigos. Se lee de `kepler_ods.kdii`, nunca de `sheet` (§7.1, l. 856-858).

Todo lo demás se **deriva**: cero importers y ninguna tabla copiada. Lo único que podría agregarse son columnas aditivas a bitácoras que ya existen, si D31 pide registrar el costo.

**«El concepto que facilita la lectura»** es el diccionario NP.7.L.16. Cada marca, denominación, sabor, empaque y país recibe una clave normalizada (`normalizarClave`, `diccionario.ts:22`), que sirve de llave a las facetas, a los sinónimos y al texto del documento.

| Salida | Qué es | Quién la usa | Cuándo puede llegar, con las reglas vigentes |
|---|---|---|---|
| **1. Foto de estudio** («lo bonito por fuera») | La foto real **editada**: recorte, fondo, enderezado y color. Se acepta IA que **edita** y nunca IA que **redibuja** la etiqueta (D17, §10b.9). Toda imagen guarda la foto real que la originó | portal, verificador, folletos y página pública | **Al final.** NP.7.D.1 es «fase siguiente» y espera a D17, el proveedor de edición: Claude no edita imágenes. Lo que avanza hoy es que la captura salga apta (NP.7.L.8a, §10b.9). **Lo primero de la visión es lo último que llega** |
| **2. Ficha técnica** («la imagen a código») | Documento por SKU: contenido, sellos y leyendas NOM-051, alérgenos (declara / puede contener / sin leer), ingredientes, tabla nutrimental con su base, país, conservación y empaque. Cada dato lleva su procedencia: cara, evidencia y fecha. La descripción se arma con plantilla determinista, sin LLM | portal B2B con sesión; afuera, sólo si D26 lo aprueba | Con la IA apagada, Catálogo transcribe a mano (F.6), con un costo en horas-persona **NO MEDIDO**. A escala, sólo después de D6 (encender la IA) y D2 (modelo) |
| **3. Búsqueda y asistentes** («respuestas rápidas, análisis, comparaciones, auditoría») | Adentro: texto y facetas desde el documento, el vector con la ficha y herramientas para Thot y WhatsApp. Afuera: HTML sin JavaScript, sitemap y robots | clientes del portal, vendedores, Compras y rastreadores | Lo interno, cuando haya fichas aceptadas. Lo externo es «fase siguiente» |

**«Ir en su lenguaje», sin prometer de más.** Lo documentado:
- **Rastreadores y JavaScript.**
  - Vercel (2024-12-17, re-verificada; https://vercel.com/blog/the-rise-of-the-ai-crawler): «none of the major AI crawlers currently render JavaScript». Nombra OAI-SearchBot, ChatGPT-User, GPTBot, ClaudeBot y PerplexityBot. Googlebot (y Gemini con él) y AppleBot sí renderizan.
  - Es **una medición de 2024, no re-medida**. No cubre Claude-SearchBot, y hay reportes de 2026, no verificados, de renderizado parcial.
  - Las páginas de bots de OpenAI y de Anthropic (re-verificadas) no dicen nada de JavaScript.
  - Conclusión: servir HTML desde el servidor es la opción segura, no una ley.
- **Funciones de IA de Google** (re-verificada; https://developers.google.com/search/docs/appearance/ai-features):
  - no hay requisitos adicionales;
  - no hacen falta «machine readable files, AI text files, or markup»;
  - no hace falta un schema.org especial;
  - los datos estructurados deben coincidir con el texto visible.
- **Resultados enriquecidos de producto** (re-verificadas):
  - El fragmento de producto exige `review`, `aggregateRating` u `offers` (https://developers.google.com/search/docs/appearance/structured-data/product-snippet).
  - La ficha de comerciante exige un `Offer` con precio mayor a cero en el que el comerciante es el vendedor, y recomienda el Product en el HTML inicial (https://developers.google.com/search/docs/appearance/structured-data/merchant-listing).
  - **Sin precio, el JSON-LD Product no da ningún resultado enriquecido.**
- **Efecto del JSON-LD en las citas de IA.** Ahrefs (2026-05-11, https://ahrefs.com/blog/schema-ai-citations/, no re-verificada) no encontró un efecto distinguible de cero. Es un proveedor de SEO y no separa páginas de producto.
- **llms.txt** es una propuesta (https://llmstxt.org/). Según una fuente secundaria, ~97 % de los archivos no recibe peticiones (https://ppc.land/llms-txt-adoption-rises-8-8x-but-97-of-files-get-zero-ai-requests/, 2026-07-02).

**Conclusión de diseño:**
- Lo que leen los sistemas es el **texto visible servido en HTML**. El JSON-LD repite ese texto y no es la palanca.
- ⚠️ El texto de la etiqueta es el mismo que puede publicar el fabricante o una cadena grande: **no hay evidencia de que publicarlo nos ponga por encima de ellos.**
- Lo que sólo Mega Dulces puede decir (presentaciones de venta, en qué sucursal se surte, mínimo de mayoreo) es lo que podría diferenciar, y hoy está detrás de la sesión (D26).
- La posición en las respuestas de IA es **NO MEDIDO** y no tiene un instrumento confiable. **No se promete.**

**Regla de privacidad** (§10b.3 punto 7), fijada por Francisco el 2026-11-05. **Falta que la confirmen Edgar y legal al firmar D6.**
- Las **partes** de una persona (mano, pierna, ropa) se aceptan. Un **rostro o rasgo facial** no se acepta. Un rostro **impreso en el empaque** es parte del producto y no cuenta.
- `rostro_visible` bloquea: la foto no se publica, no va a estudio, se borra el mismo día y se pide otra.
- ⚠️ **Con la opción A, la foto con rostro ya viajó a Anthropic antes de detectarse** (l. 1321-1325). Se declara en el PR, no se esconde.
- ⚠️ Con la IA apagada **nadie detecta un rostro**. La bandeja L.3b necesita la marca manual «tiene rostro», con el mismo efecto (F.3).
- Para legal, al firmar D6: los **tatuajes** u otras marcas que identifican a alguien no son faciales. El prompt actual sí los cuenta (`lector-foto.schema.ts:130`).
- Para estudio rige además §10b.9: una mano fuera de la silueta se va con el fondo; una mano encima del empaque deja la foto no apta.

### 3. Lo que hay hoy (medido en el código el 2026-11-05)

**La ficha**
- **Nadie escribe `sheet.ampliado`.** Al decidir sólo se escriben `sheet.publicada` y `sheet.revisiones` (`revision.service.ts:356-367`, `jsonb_set` en `:359-361`). `ampliado` sólo aparece en comentarios (`lectura-foto.contract.ts:6-7,198`; `fusion-lecturas.ts:3`).
- Conviven **dos formas incompatibles**: la plana de §7.2 (`nutricion_100g`) y `CampoPropuesto`/`PropuestaAmpliada` del contrato (`lectura-foto.contract.ts:189-204`).
- **Ya existe un armador de descripción:** `descripcionPropuesta` (`auditoria-kepler.ts:208`), en estilo Kepler, para la auditoría. Las conversiones viven en TypeScript: `aUnidadBase` (`fusion-lecturas.ts:50`) y `normalizarClave` (`diccionario.ts:22`).
- Las fichas publicadas hoy son «sólo fotos» (§10, punto 4 del siguiente bloque).
- `kdii` trae **una fila por plaza** (`apps/api/src/modules/kp/kp.controller.ts:57-58`). Todo documento «uno por SKU» tiene que elegir plaza.

**La IA y la regla de rostros**
- La IA está apagada: sólo la enciende `NP7_AI_ENABLED==='true'` (`lector.config.ts:94`). El modelo es provisional (`:42`).
- Lector, fusión, auditoría (L.17) y diccionario (L.16) están en código local según la bitácora (l. 1942-1943). Estado en git: **no verificado**.
- **El código todavía bloquea cualquier parte del cuerpo:** «cara, mano, dedos, brazo, tatuaje, uña… Ante la duda, true» (`lector-foto.schema.ts:130`).
- ✅ **Resuelto el 2026-11-05 (código local):** `rostro_visible` ya existe y bloquea; `persona_visible` queda informativo. Texto original del diagnóstico: `rostro_visible` no existe. Contrato, fusión y auditoría usan `persona_visible` (`lectura-foto.contract.ts:147,203,214`; `fusion-lecturas.ts:281`; `auditoria-kepler.ts:425`).
- **El borrado del mismo día no está construido:** «DEUDA (a), sin construir» (`lector-worker.service.ts, deuda (a) al inicio del archivo`).
  - Las fotos caen en el bucket de la app. El runbook lo nombra `comprobantes`, el que guarda evidencia fiscal. La separación de bucket y la limpieza siguen pendientes en NP.7.0.9 (b) y (d) (l. 739).
  - El CI **no tiene almacén de objetos**: buscar minio, garage o S3 en `.github/workflows` da 0.
- El recorte que viaja al lector es «generoso» y **no está validado con fotos reales** (`preparar-foto.ts:1-20`).

**Lo público**
- **No hay ninguna página pública de producto.**
  - Todo `/portal` pasa por `customerB2bGuard` (`apps/portal/src/app/app.routes.ts:16-18`).
  - El catálogo pide `COMMERCIAL_ORDERS_VER` (`commercial-catalog-search.controller.ts:33-34`).
  - `package.json` no tiene `@angular/ssr`, `platform-server` ni SDK de MCP (búsqueda: 0).
  - En `apps/` no hay `ld+json`, robots, sitemap ni llms.txt (búsqueda: 0).
  - Según la investigación (curl, 2026-11-05), `/robots.txt` y `/sitemap.xml` responden 200 `text/html`, que es el index del SPA, y `/portal/catalog` sólo trae `<app-root></app-root>`.
- **El apex también sirve rutas públicas que no son de producto:** `/empleo`, de RH (`apps/view/src/app/app.routes.ts:111,116`; FASE_RH l. 1095).
- **La foto del portal** sale de `inventory.products_active.image_url` (`commercial-catalog-search.service.ts:170-174,213`).
  - Esa tabla la reconstruye un **importer** con TRUNCATE+INSERT a partir de `inventory.products` (`database/importers/refresh-products-active.js:93,102-112`) todos los días a las 05:20 (`ops/vl/crontab.feeds:295`).
  - Al portal sólo llega una URL `/upload/` de Cloudinary con transformaciones; cualquier otra URL pasa intacta (`apps/portal/src/app/core/util/cloudinary.ts:15-19`).
- **Fotos de NP.7:** bucket privado, URL firmada de 600 s por defecto (`object-storage.service.ts:105`) y de 900 s en la revisión (`revision.service.ts:19`).
- **CSP:**
  - Portal y vendedor sólo admiten imágenes propias y de Cloudinary (`apps/portal/nginx.conf:119`, `apps/vendor/nginx.conf:111`). El apex admite además el dominio de archivos (`nginx.conf:167`).
  - Las tres apps pasan `/api/` al API en su mismo origen (`apps/portal/nginx.conf:127-136`, `apps/vendor/nginx.conf:119-128`, `nginx.conf:172-173`). Por eso una imagen servida bajo `/api/` cuenta como `'self'`.
- **El verificador no muestra fotos de producto hoy.** La única `<img>` es el logo (`tienda-verificador.component.ts:121`) y su contrato no trae imagen.
- **Lo único público con producto** son los endpoints JSON del verificador (`@Public`, `kp.controller.ts:61-75`).
  - `precios-todos` trae el precio de mostrador por plaza y el de mayoreo (`libs/contracts/src/http/store.contract.ts`).
  - Su tenant sale de una constante de entorno, porque un `@Public` no tiene contexto de tenant (`apps/api/src/modules/kp/kp.service.ts:41-46`).
- **El sitio de marca** es una tienda Wix, fuera de la Suite. Cubre una fracción del catálogo y se sincroniza a mano (FASE_CV l. 912-990).

**Búsqueda y asistentes**
- **Ningún buscador ni asistente lee la ficha.**
  - Se vectoriza «MARCA — NOMBRE» (`embedding-sync.service.ts:127-132`; `database/scripts/backfill-product-embeddings.js:6,49-58`).
  - El catálogo del portal busca con `whereILike` sobre nombre y marca (`commercial-catalog-search.service.ts:294-301`).
  - El asistente del portal busca con ILIKE sobre nombre y SKU, con límite de 12 (`portal-thot-tools.service.ts:172-173`).
  - **Ninguno de los dos usa `applySmartSearch`**: sus consumidores son clientes, cotizaciones, reclamos de recepción, ajustes de compra y documentos de venta.
- **El vector del portal no se refresca solo.**
  - `catalog.products.embedding_source_text` sólo lo escriben `planograms.service.ts:121-122` y el backfill manual (`backfill-product-embeddings.js:164-165`).
  - El cron de 15 min (`embedding-sync.service.ts:81`) escribe en la otra base vectorial.
- **Costo de los asistentes**
  - El costo del asistente del portal es el hallazgo H4: detalle sólo en el Tablero PM (privado: el repo es público).
  - La tabla de precios del lector no trae `claude-sonnet-5`, sólo `claude-sonnet-5-5` (`lector-costos.ts:35-38`, precios al `:13`).
- **Instrumento que ya existe:** `commercial.thot_chat_log` guarda pregunta, respuesta y herramientas de cada intercambio de Thot (mig `20260630200000_thot_chat_log.js:12-22`; escritura en `thot-chat.service.ts:147-165`). No guarda modelo ni tokens.
- **Las búsquedas del portal no se registran** (búsqueda de una bitácora de búsquedas: 0).

### 4. Reglas de diseño de esta sección

1. **Una sola salida, desde el dato.** La vista del documento (F.2) es la lista blanca a nivel de columnas: nunca expone `sheet` completo, que trae costo, markup y proyección (§7.2). La función de F.4 convierte esa fila. `doc_text` sale de las mismas columnas. Prueba centinela: un valor plantado en `sheet.campos.costo_base` no aparece en ninguna columna ni en ningún texto.
2. **Sólo sale lo que aceptó una persona.** `ai_raw.propuesta` sin revisar no llega a clientes ni a lo público (D32).
3. **Tres estados, nunca dos:**
   - «la etiqueta declara X»;
   - «la etiqueta no declara X (leída el AAAA-MM-DD)»;
   - «sin leer».

   Nunca se dice «libre de X» (D33). Lo no leído no cuenta como «no contiene» (regla 11).
4. **Cuando la ficha contradice a Kepler:**
   - El nombre que ven los clientes se arma con la etiqueta (marca, denominación, variante y contenido leído) y **nunca con `kdii.c2`**, que es una abreviatura de Kepler.
   - Un hallazgo abierto de L.17 (contenido, piezas o nivel físico distintos) **deja la ficha fuera de lo que ve el cliente** hasta que NP.7.L.3c lo resuelva. Es la misma regla de L.3c: «la ficha no se publica».
   - La Suite no corrige Kepler.
5. **Todo dato que ve un cliente dice cuándo se leyó** y tiene vigencia máxima (D34).
6. **Lo público se sirve sin JavaScript**, en HTML plano que publica el API, **con todo texto escapado** (HTML y JSON-LD). No se monta SSR de Angular: exigiría instalar `@angular/ssr` y adaptar el arranque del portal (PWA, push, outbox).
7. **Nunca son públicos** el precio de las listas B2B, el costo, el margen, el proveedor ni la existencia numérica. El precio público lo decide D27.
8. **Lo que no se puede medir se declara**, con el instrumento propuesto (§8).

### 5. Items, en cuatro grupos

Todos nacen **⬜**. El esfuerzo usa la escala del método: S ≤ 1 día · M ≤ 1 semana · L 2–4 semanas.

**A. Ahora: propuestos dentro de NP.7, sujetos a que Edgar acepte el alcance**

| # | Capa | Item | Depende de | Esf. | Prueba |
|---|---|---|---|---|---|
| NP.7.F.0 | C0 | **Línea base, en sólo lectura** (§10 punto 2 la permite):<br>(a) fichas vigentes con `ampliado` aceptado (0 por construcción);<br>(b) SKUs con `image_url`, por `image_source`;<br>(c) filas de `catalog.products` con `embedding` NULL o con texto viejo, y si el portal busca hoy en modo semántico o en el de respaldo;<br>(d) peticiones por semana de los bots de búsqueda, **separando el UA declarado del bot verificado** (rangos de IP publicados o DNS inverso), y declarando que lo que Cloudflare bloquea no llega al origen;<br>(e) la política de bots de IA de la zona (la lee Edgar en el panel);<br>(f) preguntas de clientes y vendedores en `commercial.thot_chat_log` en 90 días que piden un atributo de etiqueta, y cuántas terminaron sin dato (sólo agregados);<br>(g) búsquedas sin resultado del portal: **NO MEDIDO**, no hay registro | — | S | cada cifra con su consulta y un conteo cruzado independiente; en (d), una petición propia con UA conocido aparece como «UA declarado» y **no** como verificada; en (f), 10 preguntas etiquetadas a mano clasificadas igual |
| NP.7.F.3 | C1 | **El código aplica la regla de rostros** (prioridad 0, seguridad):<br>• `rostro_visible` bloquea y `persona_visible` queda informativo, en prompt, contrato, fusión, auditoría y worker;<br>• con la IA apagada, la bandeja L.3b tiene la marca manual «tiene rostro», con el mismo efecto;<br>• la foto con rostro se borra el mismo día, **sólo bajo el prefijo `levantamiento/`**, con latido en `CRON_JOBS` (cierra la deuda (a) de `lector-worker.service.ts, deuda (a) al inicio del archivo`);<br>• el PR declara que la foto ya viajó a Anthropic;<br>• es una de las cuatro condiciones para encender la IA (§10 punto 5, l. 1031) | NP.7.0.9 (b) y (d) (bucket propio y limpieza); D6 para encender, no para construir | M (L si se agrega un almacén de objetos al CI) | regla 12: una mano o un zapato no bloquean; un rostro bloquea; un personaje impreso no bloquea; con almacenamiento falso en el CI, la limpieza borra la foto con rostro y **nunca** una llave fuera de `levantamiento/` (prueba negativa con una llave de comprobante); apagar el borrado pone la prueba en rojo; en prod, un objeto borrado se verifica a mano (el CI no tiene almacén de objetos); el esquema sigue en ≤ 16 campos anulables |
| NP.7.F.1 | C0 | **Una sola forma de `sheet.ampliado`** (`schema_version: 2`): `CampoPropuesto` más `aceptado_por`/`aceptado_en`, `de_cara`, evidencia y `clave` (`normalizarClave` al aceptar); la nutrición lleva su `base` (100 g, 100 ml o porción). La forma plana de §7.2 queda como ejemplo histórico. El ADR fija también **dónde vive el armador del texto**: TypeScript al aceptar (recomendado, porque reusa `aUnidadBase` y `normalizarClave`) o SQL en la vista, nunca los dos | — | S | un validador puro rechaza la forma plana; un campo no visto es `null`, nunca `[]`; una lista vacía sólo vale con «leído»; las fichas publicadas sin `ampliado` salen como «sin leer» |
| NP.7.F.6 | C2 | **Aceptar la lectura → `sheet.ampliado`**, campo por campo, con quién y cuándo. Lo que dijo la IA se queda en `ai_raw`, así la precisión se mide en la misma fila (§7.1).<br>Al aceptar, **un solo armador** en TypeScript arma `doc_text` y `descripcion_publica` con `doc_version`, junto a `descripcionPropuesta` (`auditoria-kepler.ts:208`). Las dos descripciones se nombran por su propósito: estilo Kepler para la auditoría, legible para el cliente.<br>Con la IA apagada, Catálogo transcribe; eso mismo es respuesta conocida del corpus L.11b, insumo de D2 | F.1; NP.7.L.15 y NP.7.L.3b (en prod) | M | regla 13: contra Postgres real en el CI con el payload de la pantalla; con sólo `CATALOGO_LEVANTAR` da 403; un campo no visto queda `null`; el mismo SKU da el mismo `doc_text` dos veces; cambiar `doc_version` re-deriva; la respuesta, recorrida completa, no trae costo |
| NP.7.F.15 | C3 | **Bandeja de L.3b: aceptar, corregir o dejar «sin leer» campo por campo**, junto a la foto de su cara y su evidencia, más la marca «tiene rostro» (F.3). Skill `diseno` §0b | F.6, F.3 | M | `check:pantalla` antes y después; un campo corregido guarda el valor de la persona y conserva en `ai_raw` lo que dijo la IA |

**B. Hallazgos para Edgar: no son de NP.7, cada uno con su tarjeta**

| # | Hallazgo | Por qué no espera a la ficha | Prueba |
|---|---|---|---|
| H1 (antes F.8 a) | **El vector del portal no tiene cron.** Un tick por diferencia de `embedding_source_text` sobre `catalog.products.embedding`, con el patrón de `embedding-sync.service.ts:220-230`, latido en `CRON_JOBS` y pendientes a la vista, **sin cambiar el texto** | Es un defecto de hoy: un producto nuevo o renombrado queda sin vector o con uno viejo. Su tamaño lo mide F.0 (c) | un producto renombrado se re-embebe en el siguiente tick; la guarda contra el vaciado funciona |
| H2 (antes F.11a) | **robots.txt real** en portal, vendedor y apex (hoy el fallback del SPA responde HTML) | Es higiene del sitio, no del catálogo. **Coordinar con RH**: `Disallow: /` en el apex también bloquea `/empleo` | `curl` devuelve `text/plain` con las reglas; el control es el `text/html` de hoy |
| H3 | Hallazgo de seguridad: detalle sólo en el Tablero PM (privado: el repo es público) | — | Lo confirma Edgar |
| H4 | Costo del asistente del portal: detalle sólo en el Tablero PM (privado: el repo es público) | Costo abierto hoy, con o sin ficha | Lo mide F.0 (f) |

**C. Siguiente bloque: cuando F.6 tenga fichas aceptadas, y sólo si Edgar lo acepta dentro de NP.7**

| # | Capa | Item | Depende de | Esf. | Prueba |
|---|---|---|---|---|---|
| NP.7.F.2 | C0 | **Documento por SKU:** VISTA `security_invoker` con `tenant_id` explícito (§7.1) sobre la ficha vigente (`superseded_at IS NULL`, `ESTADOS_CON_FICHA`, `levantamiento.rules.ts:26`) más `kdii` **con una regla de plaza fija**, porque `kdii` trae una fila por plaza. Expone sólo las columnas de la lista blanca, el `doc_text` y la `descripcion_publica` de F.6, y nunca `sheet`. Excluye las fichas con hallazgo abierto de L.17. Migración generada e idempotente | F.1, F.6 | M | con dos tenants y el rol del pod, B no ve a A; una ficha `historica`, `por_revisar`, borrada o con hallazgo abierto nunca aparece; `COUNT(*)` coincide con un conteo independiente (sin duplicados por plaza); prueba centinela de costo; ninguna columna se llama `sheet` |
| NP.7.F.4 | C1 | **Lista blanca «ficha para clientes» y JSON-LD `Product`:** una función en `libs/commercial/.../product-sheets` (DTO en `libs/contracts`, coordinado con la sesión que lo tiene apartado) que, a partir de una fila de F.2, arma name (desde la etiqueta, regla 4), brand, manufacturer, gtin13, image, description, countryOfOrigin, weight/size y additionalProperty | F.2 | M | la prueba recorre **el JSON completo** y falla ante costo, markup, PV, proyección, proveedor, precio de lista o existencia numérica, y se rompe a propósito una vez; no hay `offers` sin D27; `gtin13` sólo del lector de códigos, con dígito verificador y sin prefijos 2/02/04; `nutrition` nunca dentro de `Product`; valida sin errores en el validador de schema.org; **sin `offers` se declara «no elegible a resultados enriquecidos»** |
| NP.7.F.8b | C2 | **Vector con la ficha:** donde hay ficha, el texto vectorizado pasa a ser el `doc_text` de F.2. Los corpus de la Fase K no se tocan | F.2, H1 | M | ranking antes y después con las consultas de control (regla 15); las negaciones («sin X») no se le piden al vector |
| NP.7.F.7 | C2 | **Búsqueda con la ficha, en dos commits.**<br>(a) Portal y `thot_catalog_search` pasan de ILIKE a `applySmartSearch` **sin `doc_text`**: cambia el resultado de toda búsqueda, así que lleva su propio antes y después.<br>(b) Entran `doc_text` y las facetas de tres estados, con la cobertura a la vista («N de M con etiqueta leída») | F.2, F.4, D32, D33 | L | (a) y (b) con el mismo juego de consultas de control (regla 15); un SKU sin ficha nunca entra a una faceta «no declara»; el tiempo de respuesta se mide sobre el catálogo entero (hoy NO MEDIDO) |
| NP.7.F.5 | C1 | **Herramientas de ficha** en un solo servicio:<br>• `ficha(sku)`;<br>• `filtrar(atributos)`, con tres grupos y la cobertura;<br>• `comparar(a,b,campo)`, por 100 g o 100 ml con `aUnidadBase` (`fusion-lecturas.ts:50`); si no se puede, responde «no comparable» y la resta la hace el código;<br>• `sustitutos(sku, restricciones)`, con kNN más filtros, y precio y existencia del motor;<br>• `auditoria(tipo)`, **sólo interna** | F.4 | L | un SKU que declara cacahuate nunca sale en «no declara cacahuate»; uno sin alérgenos leídos nunca cuenta como «no declara»; g contra ml da «no comparable»; 10 preguntas de control con respuesta conocida |
| NP.7.F.9a | C2 | **Asistentes internos:** F.5, incluida `auditoria`, en los perfiles compras y admin de Thot | F.5, NP.7.L.3c | M | preguntas de control respondidas con valor más evidencia; un SKU sin ficha da «sin dato»; `auditoria` devuelve los mismos hallazgos que Incidencias |
| NP.7.F.9b | C2 | **Asistentes de cara al cliente:** F.5 sin `auditoria`, en los perfiles vendor y portal y en el puerto de WhatsApp. Antes:<br>• cerrado el hallazgo H4 (Tablero PM);<br>• la tabla de precios de `lector-costos.ts` pasa a `libs/platform-core` (regla 16);<br>• modelo, tokens y costo por turno van en columnas aditivas de `commercial.thot_chat_log`. Si no se registra, se declara NO MEDIDO | F.5, D31 | L | lo que pida el cierre de H4; el perfil portal no ofrece `auditoria`; la respuesta, recorrida completa, no trae precios de otros clientes |
| NP.7.F.16 | C3 | **La ficha técnica en el portal B2B, con sesión:** contenido, sellos, alérgenos en tres estados, ingredientes, tabla nutrimental, país, procedencia y «leída el» | F.4 (F.7 sólo para las facetas; la foto, con L.14) | M | `check:pantalla` antes y después; un SKU sin ficha dice «sin ficha técnica todavía», no una tabla vacía; la respuesta, recorrida completa, no trae costo ni proveedor |

**D. Fase siguiente: alcance hacia afuera.** Sólo si Edgar la abre por encima del cupo, como MX (2026-10-28) y DP (2026-11-03), y queda escrito.

| # | Capa | Item | Depende de | Esf. | Prueba |
|---|---|---|---|---|---|
| NP.7.L.14 (reescrito; reemplaza a F.10) | C2+C3 | **Foto publicada estable.**<br>• `GET /api/catalogo/foto/<sha256>.webp`, `@Public`, con caché inmutable, sirve **sólo llaves del prefijo de estudio**; el bucket sigue privado.<br>• Portal y verificador leen una vista: la foto publicada gana sobre el `image_url` que ya existe, y una `manual` no se pisa. El respaldo sigue leyendo `products_active`, que llena el importer, y se declara.<br>• Incluye el contrato y la pantalla del verificador, que hoy no muestra fotos | NP.7.D.1 (D17), D19 revisada, NP.7.0.9, F.3 | L | una foto cruda, una con rostro, una no publicada o una llave de comprobante dan 404; 3 SKUs muestran su foto en portal y verificador sin error de CSP; una imagen `manual` no cambia |
| NP.7.F.12 | C2 | **Superficie pública, datos:** `/p/<slug>-<sku>.json` (salida de F.4), `sitemap.xml` (desde F.2) y, opcional, `llms.txt`, sin prometer efecto. El tenant y el host canónico salen de la configuración, como en `kp.service.ts:41-46` | D26, D28, F.4 | M | un SKU sin ficha publicada da 404; un host no configurado da 404; las URLs del sitemap coinciden con el conteo de la vista; el JSON, recorrido completo, no trae precio, costo ni proveedor |
| NP.7.F.11b | C2 | **robots.txt, etapa 2:** se abre la ruta pública para los rastreadores que permita D29, con `Sitemap:` | H2, D28, D29, F.12 | S | `curl` con cada UA: la ruta pública queda permitida y la app sigue bloqueada |
| NP.7.F.17 | C3 | **Página pública por producto, sin JavaScript:** HTML del API en `/p/<slug>-<sku>`, superficie Storefront (skill `diseno`), con la ficha como texto visible, «leída el» y el JSON-LD de F.4 en el HTML inicial; una `location /p/` en nginx | F.12, L.14, D26, D28, D29, D34 | L | `curl -A 'OAI-SearchBot'` sin JS trae nombre, sellos, ingredientes, tabla y JSON-LD; el control negativo es el portal de hoy (`<app-root>`); un campo con `</script><script>` sale inerte en el HTML y en el JSON-LD; el JSON-LD valida sin errores; sin D27 «con precio» se declara «no elegible a resultados enriquecidos» |
| NP.7.F.13 | C2 | **Feed de Google Merchant Center**, sólo si D27 sale «con precio»: VISTA sobre F.2 más el precio decidido, con **una regla de plaza**. `gtin` sólo del lector y nunca con prefijos 2/02/04; NOM-051 en `product_detail`. La cuenta la abre Edgar (acción hacia afuera) | D27, D28, F.12, **F.17** (la página de destino debe mostrar el precio) | L | las filas del feed coinciden con el conteo de la vista; un SKU con prefijo restringido sale sin `gtin`; el diagnóstico de Merchant Center no da errores en una muestra |
| NP.7.F.14 | C2 | **Servidor MCP** con los perfiles públicos de F.5, nunca `auditoria` ni precios, con control de acceso y límite de tasa como exige la especificación | D30, F.12, demanda medida en F.0 | L | una herramienta fuera de la lista da error; pasar el límite da 429; la respuesta, recorrida completa, no trae datos privados |

### 6. Decisiones nuevas (D26–D34), revisión de D19 y aclaración de D17

| # | Decisión | Recomendación | Quién | ADR |
|---|---|---|---|---|
| D26 | **¿Habrá ficha pública sin sesión, y qué lleva?** | Sí, sólo para SKUs con ficha publicada, sin hallazgo abierto de L.17 y con foto de estudio aprobada.<br>**Público:** datos de etiqueta, foto de estudio, descripción por plantilla, «leída el» y procedencia. A considerar, con efecto NO MEDIDO: los datos que sólo Mega Dulces puede decir (presentaciones de venta y en qué sucursal se surte, **sin números de existencia**).<br>**Con sesión:** precios de listas B2B, mínimos, existencias, promociones e historial.<br>**Nunca:** costo, markup, proyección ni proveedor.<br>Legal revisa el uso de marcas y fotos de empaque, y Dirección acepta que publicar el surtido lo deja a la vista de la competencia | Edgar + Dirección General (+ legal) | sí |
| D27 | **¿La ficha pública lleva precio?** | (a) **Sin precio** en el primer corte: indexación y citas, sin resultados enriquecidos ni feed.<br>(b) Precio de mostrador con fecha y **una regla de plaza**. Hoy ya es público en JSON por `/api/kp/precios-todos`, así que la decisión es hacerlo indexable, no revelarlo. Abre F.13.<br>(c) El precio mayorista de lista, **no**: es por cliente | Dirección Comercial + Edgar | — |
| D28 | **Dominio y ruta del catálogo público** | (b) un subdominio del dominio de marca apuntado al mismo API. Eso probablemente exige mover la zona DNS a Cloudflare (no verificado); es credencial y le toca a Edgar (regla 7).<br>(a) Si no, `/p/` en el apex de la Suite.<br>El código lee el host de la configuración.<br>(c) Alimentar la tienda Wix: ahora no | Edgar + Dirección (+ MKT) | sí |
| D29 | **Rastreadores: robots y política de bots de IA en Cloudflare** | En la app: `Disallow: /`, coordinado con RH por `/empleo`. En la ruta pública se permiten los de búsqueda y los que actúan a pedido del usuario. Los de entrenamiento (GPTBot, ClaudeBot y el token Google-Extended) se permiten sólo si Dirección acepta licenciar ese contenido; su beneficio es **NO MEDIDO**. Revisar antes la política de la zona y la señal de preferencia de entrenamiento que Anthropic menciona desde el 2026-10-30 (https://support.claude.com/en/articles/8896518, re-verificada; la señal no se leyó a fondo) | Edgar + Dirección | — |
| D30 | **¿Herramientas para asistentes externos (MCP)?** | **Ahora no**: no hay demanda medida. Se reconsidera con F.0 (d) y (f) | Edgar | — |
| D31 | **Tope y costo de los asistentes de cara al cliente** | Tope diario por cliente, como el de WhatsApp. Las preguntas de ficha corren en Haiku, con un cambio explícito al ruteo. El costo por turno va en columnas aditivas de `thot_chat_log`, con la tabla de precios en `libs/platform-core` | Edgar | — |
| D32 | **¿La búsqueda puede usar `ai_raw.propuesta` sin revisar?** | Sólo la búsqueda interna de Catálogo, rotulada «lectura IA sin revisar». Nunca el portal, lo público ni los asistentes de clientes | Edgar | — |
| D33 | **Redacción de alérgenos y edulcorantes, y cobertura mínima** | «La etiqueta declara / no declara X (leída el…)», nunca «libre de X», con la leyenda «verifique siempre la etiqueta del empaque». En público, la faceta sólo aparece si la cobertura llega al mínimo que se fije | Edgar + legal | — |
| D34 | **Dueño y vigencia del contenido para clientes** | **Dueño de la exactitud:** Catálogo (`gerente_compras`). **De la redacción:** legal. **De la fase:** Francisco. Vigencia máxima de una lectura (p. ej. 12 meses, a fijar): al vencer, la ficha sale del sitemap y la página dice «por verificar». Canal de corrección con plazo, y quién contesta un reclamo | Francisco + Edgar + legal | — |
| D19 (revisión) | **Dónde vive la foto publicada y QUÉ foto se publica** | **Cambia la recomendación.** Antes: escribir en `inventory.products.image_url`. Ahora: endpoint por hash más una vista que da prioridad a la foto publicada (L.14 reescrito). Razones:<br>• el portal lee `products_active`, que llena un importer diario;<br>• la URL firmada vence;<br>• la CSP del portal y del vendedor sólo admite fotos propias y de Cloudinary.<br>Una imagen `manual` no se pisa.<br>**Pregunta nueva:** ¿sólo la foto de estudio, lo que deja L.14 detrás de NP.7.D.1 (fase siguiente), o mientras tanto la foto `apta_estudio` recortada en el servidor, sin IA generativa, sólo en el portal con sesión? | Francisco + Edgar | sí |
| D17 (aclaración) | **«Que la IA elabore la foto de estudio»** | Se cumple con IA de **edición**: segmentar el fondo, enderezar, corregir el color. Un fondo o una sombra generados se aceptan con los metadatos IPTC que pide Google (https://support.google.com/merchants/answer/6324350, no re-verificada). **Nunca** se genera ni se redibuja la etiqueta. Se guarda siempre la original. El proveedor sigue por decidir: Claude no edita imágenes | Edgar | sí (ya marcado) |

### 7. Orden y lo que bloquea la Fase 0

**El dinero de cada item F es NO MEDIDO.** El método (§3.1) dice que el dinero sale de una medición, así que **ningún F recibe prioridad 1–4**: sólo F.3 tiene la 0 (seguridad). El orden sale de las dependencias y de lo que destraba una decisión abierta.

⭐ **Donde sí está el dinero ya está en el plan:** la auditoría contra Kepler (NP.7.L.17 → NP.7.L.3c, Incidencias), porque el contenido y el factor fijan precios. La bitácora del 2026-11-04 ya encontró un empaque cuyo contenido no coincide con el nombre de Kepler. **Va antes que cualquier F.** F.9a sólo le pone chat.

| Orden | Item | Por qué en este lugar | Esf. | Fase 0 |
|---|---|---|---|---|
| 1 | F.3 | 0 · seguridad y precondición para encender la IA (§10 punto 5) | M | dentro de NP.7, sujeto a Edgar |
| 2 | F.0 | C0 de sólo lectura; da la línea base | S | **no bloquea** (§10 punto 2) |
| 3 | F.1 → F.6 → F.15 | llenan `ampliado` y dan respuesta conocida al corpus L.11b → D2 | S, M, M | dentro de NP.7, sujeto a Edgar |
| 4 | H1–H4 | defectos de hoy, fuera de NP.7 | S–M | tarjetas propias de Edgar |
| 5 | F.2 → F.4 → F.8b · F.7 → F.5 → F.9a → F.9b → F.16 | sólo con fichas aceptadas | M, M, M, L, L, M, L, M | siguiente bloque, sujeto a Edgar |
| 6 | L.14 (reescrito) → F.12 → F.11b → F.17 → F.13 → F.14 | alcance hacia afuera, especulativo | L, M, S, L, L, L | **bloqueado:** fase siguiente y D17, D19, D26–D30, D34 |

**Qué bloquea la Fase 0, en cuatro grupos:**
- **Sin bloqueo:** F.0, y redactar D26–D34 para que se firmen.
- **Sujeto a Edgar (cupo hoy 7 de 4, y D1/D15 sin asentar):** F.3, F.1, F.6 y F.15. Por la decisión de Francisco del 2026-11-02 (cabecera del plan), se construyen **en local, sobre `main` y sin push**, y Edgar decide su alcance al revisar el PR. ⚠️ El método advierte el costo: lo construido y no aterrizado suma al 🧪 que la Fase 0 quiere vaciar; por eso cada uno se lleva hasta su PR antes de abrir el siguiente.
- **Hallazgos (H1–H4):** van a Edgar como tarjetas propias, fuera de NP.7.
- **Siguiente bloque y fase siguiente:** ⬜ con su doc. Lo público sólo se adelanta si Edgar lo abre por encima del cupo y queda escrito.

### 8. Cómo se medirá lo que hoy no se puede medir

- **Métrica principal (resultado, ponderada por dinero):** % de la venta de 90 días, en pesos, cuyo SKU tiene `ampliado` aceptado y vigente. **HOY 0, por construcción.** Mismo instrumento que la métrica L.
- **Demanda:** preguntas de clientes y vendedores en `commercial.thot_chat_log` que piden un atributo de etiqueta, y qué fracción terminó en «sin dato», antes y después. Ya es medible (F.0 f).
- **Búsquedas sin resultado:** **NO MEDIDO**, no hay registro. Medirlas exige registrar las búsquedas (tabla propia con `tenant_id` y campos de auditoría, o columnas en una bitácora existente). Es una decisión, no un supuesto.
- **Calidad interna:** aciertos del juego de consultas de control de búsqueda y asistentes, antes y después (regla 15).
- **Métrica de construcción** (no de resultado): % de SKUs con ficha publicada cuya página, pedida sin JavaScript con el UA de cada rastreador, trae el nombre, los datos de etiqueta y un JSON-LD válido. Control negativo: el portal de hoy.
- **Rastreo:** peticiones por semana de **bots verificados** a `/p/`, contra la línea base de F.0.
- **Indexación:** páginas indexadas en Search Console y Bing Webmaster. Abrir las cuentas es acción de Edgar.
- **Citas en IA:** un panel fijo de preguntas cada mes en 4 asistentes, anotando si citan una URL nuestra. Es ruidoso: se publica como tal y **nunca como «posición»**.
- **Visitas referidas:** referrer de chatgpt.com, perplexity.ai, claude.ai y gemini.google.com.
- **Con D27 «con precio»:** productos aprobados e impresiones en Merchant Center.
- ⛔ **«Primeras filas de búsqueda de la IA» no se promete.** Hoy es NO MEDIDO y no tiene un instrumento confiable.

### 9. NO MEDIDO / no verificado, y fuentes externas

**NO MEDIDO / no verificado:**
- El estado git del código del lector (la revisión no usó git).
- Las reglas de ingreso del túnel de Cloudflare, que no están en el repo; la política de bots de IA de la zona; si las peticiones de bots quedan en los logs y con qué IP de origen.
- Si mover el dominio de marca a Cloudflare es necesario o posible (D28).
- El HTML que Wix sirve a los rastreadores.
- Cuántos SKUs tienen `image_url` o embedding hoy, y si el portal busca en modo semántico (F.0).
- Si `VOYAGE_API_KEY` y la base vectorial están en el pod; el costo de re-embeber con Voyage.
- El rendimiento de `applySmartSearch` sobre `doc_text`.
- El costo en horas-persona de transcribir fichas a mano con la IA apagada.
- Los precios vigentes de Anthropic (la tabla del repo es del 2026-10-06).
- Que el vector resuelva mal las negaciones (es razonamiento, no medición).
- Si la leyenda NOM-051 de edulcorantes sirve como testigo (no se leyó la norma).
- Qué devuelve hoy `/api/kp/precios-todos` en prod.
- Si el tendero busca productos en una IA, y si publicar la etiqueta nos pone por encima del fabricante o de las cadenas.
- Si los rastreadores de búsqueda de IA ejecutan JavaScript en 2026.
- La parte final (~4.7 k caracteres) de la página de fichas de comerciante de Google.
- El esfuerzo de cada item, que es una estimación.

**Fuentes externas:**
- **Re-verificadas por la revisión el 2026-11-05:**
  - Vercel, «The rise of the AI crawler», 2024-12-17 — https://vercel.com/blog/the-rise-of-the-ai-crawler
  - Google, funciones de IA — https://developers.google.com/search/docs/appearance/ai-features
  - Google, fragmentos de producto — https://developers.google.com/search/docs/appearance/structured-data/product-snippet
  - Google, fichas de comerciante (leída hasta el carácter 100,000) — https://developers.google.com/search/docs/appearance/structured-data/merchant-listing
  - Bots de OpenAI — https://developers.openai.com/api/docs/bots
  - Bots de Anthropic — https://support.claude.com/en/articles/8896518
- **De la investigación, consultadas el 2026-11-05, no re-verificadas:**
  - Google, JavaScript SEO — https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics
  - schema.org Product — https://schema.org/Product
  - schema.org NutritionInformation — https://schema.org/NutritionInformation
  - Ahrefs, 2026-05-11 — https://ahrefs.com/blog/schema-ai-citations/
  - llms.txt — https://llmstxt.org/
  - Adopción de llms.txt, 2026-07-02 — https://ppc.land/llms-txt-adoption-rises-8-8x-but-97-of-files-get-zero-ai-requests/
  - Merchant Center, especificación — https://support.google.com/merchants/answer/7052112
  - Merchant Center, GTIN — https://support.google.com/merchants/answer/6324461
  - Merchant Center, imagen — https://support.google.com/merchants/answer/6324350
  - Merchant Center, países con fichas gratuitas — https://support.google.com/merchants/answer/13692890
  - OpenAI, comercios — https://chatgpt.com/merchants
  - Especificación MCP, 2025-06-18 — https://modelcontextprotocol.io/specification/2025-06-18/server/tools
