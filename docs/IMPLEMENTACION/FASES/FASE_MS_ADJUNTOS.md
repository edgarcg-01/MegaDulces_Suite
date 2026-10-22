# Fase MS — Adjuntos: arrastrar archivos desde el escritorio + enlaces de Google (sprint `MS.ADJ`)

> Sprint de la fase **MS — Mesa de Servicio** ([`FASE_MS_MESA_DE_SERVICIO.md`](FASE_MS_MESA_DE_SERVICIO.md)); **no abre una fase nueva** (la fila `MS` ya es una de las 4 🔨). Hereda ADR-081.
> Método: [`docs/METODO_DE_TRABAJO.md`](../../METODO_DE_TRABAJO.md). Pantalla: <https://megadulcessuite.com/servicio/>.
> **Estado (2026-10-22): C0 y C1 empezadas EN LOCAL, sin commitear.** Redactado para Edgar (decide) y para quien lo implemente.

```
OBJETIVO: Quien reporta (o atiende) en la Mesa de Servicio arrastra imágenes y PDF desde el escritorio de Windows
          y los suelta sobre la solicitud (sin pasar por el selector), y puede pegar un ENLACE de Google
          (Docs, Hojas, Presentaciones, Formularios, Drive) para lo que no es imagen ni PDF.
MÉTRICA:  Solicitudes con al menos un adjunto o enlace ÷ solicitudes
          — HOY: 49 % con adjunto (24 de 49; 2026-10-03 → 2026-10-22, medido en prod, sólo lectura); enlaces: 0 (no existen)
          → META: la fija Edgar (propuesta ≥ 60 % a 30 días)
          Métrica de apoyo, NO MEDIDA hoy: veces que alguien intenta adjuntar un tipo que se rechaza (ADJ.0.2).
CAPA TOPE: C3
ÁREA:      Plataforma (Mesa de Servicio)
DUEÑO:     0Sistemas (dueño de MS en el tablero del PM)
ESTADO:    🔨  (sprint de MS)
```

---

## 0. Decisiones tomadas (Edgar, 2026-10-22)

| # | Decisión | Efecto |
|---|---|---|
| **D1** | **Sólo imágenes y PDF** como archivo. **No** se agregan Word, Excel, PowerPoint (`.doc/.xls/.ppt/.pptx` ni sus versiones nuevas), texto, comprimidos ni nada más. **Lo que no es imagen ni PDF se comparte por ENLACE de Google** | El validador por firma que ya existe (`validarAdjunto`) **no cambia**; **no hay migración que ensanche el `CHECK` de tipos**; la entrega `inline` sigue siendo segura (sólo imagen/PDF) |
| **D8** | La empresa **no usa Google Workspace**; el enlace queda **restringido por ahora** (lo que comparta cada persona con su propia cuenta) | El aviso del formulario **no** habla de «tu organización»: dice que debe compartirse con quien lo atiende o con «cualquier persona con el enlace». No se verifica el permiso (no se puede). Se revisa cuando haya Workspace |
| **D5** | Entra como sprint de `MS` (ya 🔨, dueño 0Sistemas): **no consume cupo** | — |

Quedan **sin objeto** las decisiones sobre ZIP/RAR, audio y video y subir el límite de tamaño por archivos grandes: al no aceptarse esos tipos, no hay nada que decidir. Siguen vigentes **D6** (RH), **D7** (pegar con Ctrl+V) y **D9** (tope de suma) — ver §4.

> Lo que se había construido en local para «cualquier archivo» (un validador por familias de Office/texto, con 24 pruebas y 203 archivos reales) **se descartó el mismo día**: no se va a usar y un primitivo que nadie llama es deuda (ADR-056).

---

## 1. Qué problema resuelve — y qué se midió

**El pedido:** arrastrar archivos desde el escritorio y adjuntarlos a la solicitud.

**Lo que hay hoy (leído del código y medido en prod, todo sólo lectura):**

| Hecho | Valor | Dónde se comprobó |
|---|---|---|
| Cómo se adjunta | Dos botones: **Cámara** y **Adjuntar** (`<input type="file" accept="image/*,application/pdf">`). **No hay arrastrar y soltar** en la Mesa | `servicio-solicitudes.component.ts` ~L234-236; `sd-request-detail.component.ts` ~L311-313 |
| Qué acepta | **Sólo** JPG, PNG, WEBP, GIF, HEIC y PDF, por **firma** (bytes), no por extensión | `libs/platform-core/.../attachment-signature.ts` |
| Tamaño | `max_attachment_mb` = **8** (rango 1–15), máx. **5** archivos por envío | prod `servicedesk.settings`; `MAX_ADJUNTOS_POR_ENVIO` |
| Cómo viajan | **base64 dentro del JSON**; el cuerpo del API para `/api/service-desk` permite **32 MB** | `apps/api/src/main.ts` L313 |
| Uso real (prod, 2026-10-03 → 22) | **49** solicitudes, **24 (49 %)** con adjunto; **26** adjuntos: **14 PNG, 10 JPEG, 2 PDF**; el más grande **1.95 MB** | `servicedesk.requests` / `request_attachments` |
| Rechazos del servidor | **0** errores 4xx y **0** 5xx en `POST /requests` (48 hits) y `POST /requests/:id/messages` (30 hits) | `analytics.ui_usage` |
| Bucket local | **No había**: el compose de desarrollo no trae S3 y `S3_*` no está definida → **no se podía probar un adjunto en local** | `docker-compose.dev.yml`; `.env` |

**Lo que NO se puede inferir (y por qué no se dibuja como cero):** que **nadie haya querido** adjuntar un Word o un Excel. El filtro del front rechaza **antes** de enviar: el servidor nunca ve el intento y los 0 errores 4xx no dicen nada → ADJ.0.2.

**⚠️ Dos defectos vigentes que existen hoy, con «sólo fotos y PDF»:**
1. **El tope no cuadra con el cuerpo.** 5 archivos × 8 MB = 40 MB crudos ≈ **53 MB en base64**, y el servidor corta en 32 MB. Hoy no pasa porque la gente sube capturas de < 2 MB, pero cuatro PDF escaneados de 7 MB **sí** darían un 413 *después* de esperar la subida.
2. **El front duplica las reglas del servidor** (`TIPOS_OK`, `MAX_ARCHIVOS = 5` y el `accept`, escritos a mano en dos componentes) y **no conoce `max_attachment_mb`**: no puede avisar «pesa 11 MB, el máximo es 8» antes de subir.

*(Un tercer defecto —entregar todo `inline`— se evaluó y **no aplica**: con sólo imagen y PDF, `inline` es seguro.)*

---

## 2. Qué NO incluye

- **Ningún tipo de archivo nuevo** (D1). Un `.docx` soltado sobre la solicitud se **rechaza con un mensaje que sugiere el enlace de Google**; no se sube.
- **Antivirus, video, audio, archivos grandes:** no entran (y no hacen falta al mantener imagen + PDF).
- **Verificar que el enlace se pueda abrir:** no se puede sin consultar a Google (sería un SSRF y exigiría una cuenta de servicio). Se avisa en pantalla.
- **Soltar sobre la página para abrir «Nueva solicitud»:** sólo se suelta **dentro** del formulario o del hilo de una solicitud.
- **Arrastrar desde Outlook o un visor de ZIP** (archivos «virtuales»): depende del navegador; se prueba y se declara qué pasa.
- **Las otras seis pantallas con su propio «arrastrar»** (ver C3): deuda con nombre, no se migran aquí.
- **Reclutamiento:** su validador no se toca.

---

## 3. Las capas

> Cada capa se **prueba en local antes de subir a la siguiente** (§6). Si una no pasa, no se escribe la de arriba.

### C0 · Medición y entorno *(no hay dato de ERP: es la base de pruebas)*

| # | Item | Estado | Verificado contra |
|---|---|---|---|
| ADJ.0.1 | Medir el «HOY» (49 %, tipos, tamaños, 0 rechazos del servidor) | ✅ 2026-10-22 | Consultas de sólo lectura a prod (cuenta `sistemas`) |
| ADJ.0.2 | **Medir el rechazo en el cliente:** contar los intentos de soltar un tipo no permitido, **por extensión** (nunca el nombre). Primero buscar si ya existe un canal de eventos de UI | ⬜ | La misma consulta a los 14 días |
| ADJ.0.3 | **Bucket S3 local** (Garage, como prod) en `docker-compose.dev.yml` bajo el perfil `s3` (`npm run dev:up` no cambia), con `docker/garage/garage.toml` y un script de inicio que crea bucket y llave e imprime las `S3_*` para el `.env` | ✅ 2026-10-22 | Subir un objeto con `ObjectStorageService` y bajarlo con la URL prefirmada, idéntico |
| ADJ.0.4 | **Archivos de prueba** (§5): imagen y PDF reales y los disfrazados | ⬜ | Cada uno aceptado o rechazado como se espera |

### C1 · Dominio — `libs/service-desk`, `libs/platform-core`, `libs/contracts`

| # | Item | Estado | Prueba que lo ejerce |
|---|---|---|---|
| ADJ.1.1 | **La extensión de la clave del bucket sale del TIPO detectado**, no del nombre: hoy `putBuffer` la saca de lo que mandó el cliente (`/\.([a-z0-9]{1,8})$/`); `foto.exe` con bytes de JPEG quedaría con clave `.exe` | 🧪 | Spec: la clave termina en `.jpg` aunque el nombre diga `.exe` |
| ADJ.1.2 | **Nombre seguro:** `sanitizarNombre` quita controles `\u0000-\u001f` pero **no** los caracteres de dirección Unicode (`U+202E`: `reporte‮fdp.exe` se ve `reporteexe.pdf`), y deja una extensión que no es la del tipo (`factura.pdf.exe`). Quitar los primeros y **dejar la extensión del tipo detectado**. ⚠️ `sanitizarNombre` es compartido con Reclutamiento: el cambio es inocuo para ellos (sólo quita caracteres invisibles) pero se declara | 🧪 | Spec con el RLO y con `factura.pdf.exe`; las pruebas de Reclutamiento siguen verdes |
| ADJ.1.3 | **Tope de suma por envío** (propuesta: **22 MB** crudos ≈ 29 MB en base64, bajo los 32 MB) — arregla el defecto 1 | 🧪 | Spec: 3 de 8 MB → rechazo con el motivo; 5 de 4 MB → pasa |
| ADJ.1.4 | **Una sola fuente de la política:** `SdCatalogResponse` gana `attachments: { max_files, max_file_mb, max_total_mb, accept[], max_links }` desde las **mismas constantes** del servidor; el front deja de tener `TIPOS_OK`, `MAX_ARCHIVOS` y `accept` a mano — arregla el defecto 2. ⛔ Cambia un tipo de `libs/contracts`: recorrer **todos** sus consumidores, plantillas incluidas | ⬜ | `git grep` de consumidores en el PR; `check:templates-types` en verde |
| ADJ.1.5 | 🧪 **Enlaces de Google** (`normalizarEnlaceGoogle`, `libs/service-desk/src/lib/domain/enlaces.ts`): sólo `docs.google.com` (`document/spreadsheets/presentation/forms`) y `drive.google.com` (`file/d`, `drive/folders`, `open?id`); host **exacto**, https, sin usuario, puerto, espacios ni caracteres de dirección Unicode; guarda `origen + ruta` (y `resourcekey` si hace falta) y descarta `usp`, `authuser` y el `#fragmento`; tope de **3 enlaces por envío**; el servidor **nunca** consulta la URL | 🧪 | **En local, sin commitear:** 25 pruebas; las mutaciones de https, usuario y puerto se ponen en rojo; la de «host por sufijo» sólo en la combinada, porque hay **dos capas** de defensa |

### C2 · API — `libs/service-desk` + base

| # | Item | Estado | ¿Escribe? | Prueba contra base real |
|---|---|---|---|---|
| ADJ.2.1 | **Migración** `servicedesk.request_links` (`tenant_id` + audit + RLS forzado; `url`, `tipo`, `request_id`/`message_id` como los adjuntos; `CHECK` de que la URL sea de Google). Generada con `node scripts/nueva-migracion.js`; ⛔ **va ANTES del código**, una por una | 🧪 | sí (DDL) | Aplicada en `:5442`; una prueba que **intenta violarla** (insertar `https://evil.com/x`) y espera `23514` |
| ADJ.2.2 | `AttachmentsService.preparar` aplica ADJ.1.1–1.3 y se agregan los **enlaces** (validar + tope + guardar) en **los dos caminos** que adjuntan: crear (`requests.service` ~L231) y responder/nota (~L744). ⚠️ Regla 14 de `CLAUDE.md`: recorrer **todos** los caminos que insertan | 🧪 | sí | Bloque nuevo de `database/tests/http-service-desk-test.js` con el **payload que manda la pantalla** (§6) |
| ADJ.2.3 | `SdAttachmentDto`/detalle devuelven `links[]` | 🧪 | no | El mismo bloque lee lo guardado |

### C3 · UI — `apps/view` (skill `diseno` **antes** de tocar nada)

| # | Item | Estado | `check:pantalla -- servicio` |
|---|---|---|---|
| ADJ.3.1 | **Directiva compartida `appArchivoDrop`** en `shared/directives/` (+ funciones puras): contador `dragenter/leave` (sin parpadeo), **sólo reacciona a arrastres con `Files`** (no a texto seleccionado), rechaza **carpetas** (`webkitGetAsEntry().isDirectory`) y archivos de 0 bytes (p. ej. uno de OneDrive aún en la nube), anuncia el resultado en una región `aria-live`, respeta `prefers-reduced-motion` | 🧪 | medir antes (línea base: 22 fallas en 6 pantallas el 2026-10-16) |
| ADJ.3.2 | **Guardia contra salirse de la página:** soltar un archivo **fuera** de la zona hace que el navegador **abra el archivo y se pierda lo escrito**. Con el diálogo abierto, `dragover`/`drop` de la ventana se cancelan (sólo arrastres de archivos) | 🧪 | — |
| ADJ.3.3 | **Formulario «Nueva solicitud»:** todo el cuerpo del diálogo es zona de soltar («Suelta para adjuntar»); **Cámara y Adjuntar se quedan** (teclado y móvil, DESIGN D.7); `accept` y filtros salen del catálogo (ADJ.1.4); pendientes con ícono, tamaño y contador «3/5 · 4.2 de 22 MB»; errores **por archivo** (`aria-live`); un tipo no permitido (p. ej. `.docx`) se rechaza con *«Sólo imágenes y PDF. Para un documento de Word o Excel, pega el enlace de Google más abajo.»* | 🧪 | no más de 22 fallas |
| ADJ.3.4 | **Hilo de la solicitud** (responder y nota interna): la misma directiva sobre el redactor | 🧪 | — |
| ADJ.3.5 | **Campo «Enlace de Google»** bajo los adjuntos (formulario y hilo): «Agregar enlace», lista con su etiqueta («Hoja de cálculo de Google») y el aviso fijo *«Comparte el documento con quien lo atenderá (o con "cualquier persona con el enlace"); si está restringido, no podrá abrirlo.»* Valida al escribir con la **misma** función | 🧪 | — |
| ADJ.3.6 | **Detalle:** los enlaces como chips (ícono de Google, etiqueta, abre en pestaña nueva con `rel="noopener noreferrer"`) | 🧪 | — |
| ADJ.3.7 | *(opcional, D7)* **Pegar con Ctrl+V** una captura de pantalla — el formulario ya dice «una captura ayuda mucho» y es el mismo `File[]` | ⬜ | — |

⚠️ **Deuda declarada (ADR-056):** seis componentes ya implementan su propio arrastrar a mano — `compras-captura-lote`, `compras-entradas-pendientes`, `compras-entradas`, `finanzas-pagos-comprobantes`, `finanzas-capturar-gasto` y `pagos-captura-lote`. La directiva nueva es el primitivo; **migrarlos es un sprint aparte**.

⚠️ `check:pantalla` cuenta un **widget** como pantalla y le exige métricas (`[AUD.W]`): una directiva no es página; se compara contra la **línea base de `servicio`**, no contra cero.

---

## 4. Decisiones que siguen abiertas

| # | Decisión | Recomendación | Efecto |
|---|---|---|---|
| **D6** | RH (cola confidencial): ¿mismas reglas (imagen/PDF + enlaces)? | **Sí**, con PRV.4: los adjuntos de un caso de RH se retienen y borran con el caso. Un **enlace** a un documento personal no copia nada a nuestro bucket (ventaja), pero el enlace queda en la base | Un PDF con datos personales en un bucket sin política de borrado es un riesgo nuevo |
| **D7** | ¿Pegar con Ctrl+V (ADJ.3.7)? | **Sí**, es casi gratis | — |
| **D9** | **Tope de suma:** ¿22 MB por envío (ADJ.1.3)? | Sí; no subir `max_attachment_mb` | Con 4 PDF de 7 MB, hoy se da un 413 tras esperar la subida |

---

## 5. Archivos de prueba (ADJ.0.4)

| Archivo | Debe… | Qué prueba |
|---|---|---|
| `captura.png`, `foto.jpg`, `doc.pdf` | pasar | lo de hoy no se rompe |
| `programa.exe` renombrado `factura.pdf` | **rechazar** | firma `MZ` ≠ PDF |
| `pagina.html` renombrado `captura.png` | **rechazar** | contenido ≠ imagen |
| `logo.svg` | **rechazar** | no es una imagen permitida |
| `reporte.docx` (Word real) | **rechazar** con el mensaje del enlace | D1 |
| `comprimido.zip` renombrado `.pdf` | **rechazar** | firma `PK` ≠ PDF |
| `foto.exe` con bytes de JPEG | pasar, **guardado como `.jpg`** | ADJ.1.1 / 1.2 |
| `reporte‮fdp.exe` (con RLO) | nombre limpio | ADJ.1.2 |
| `vacio.pdf` (0 bytes) | **rechazar** | vacío |
| `pesado.pdf` (9 MB) | **rechazar** | > `max_attachment_mb` |
| 3 archivos de 8 MB | **rechazar la suma** | ADJ.1.3 |
| Enlaces: `docs.google.com/document/d/<id>/edit?usp=sharing`; `evil.com`; `docs.google.com.evil.com`; `http://`; un 4.º enlace | primero pasa y normaliza; los demás **rechazar** | ADJ.1.5 |

---

## 6. Cómo se prueba en local, capa por capa

⛔ No se compila ni se levanta el backend desde la sesión: lo levanta **quien prueba** (`npm run api`, `nx serve view`). El `.env` local ya apunta a `:5442`. **Docker Desktop está encendido** (2026-10-22) y `ms-postgres` corre en `:5442`; el bucket local se enciende **aparte**, con el perfil `s3`, y no toca esa base.

| Capa | Qué se corre | Pasa cuando |
|---|---|---|
| **C0** | `docker compose -f docker-compose.dev.yml --profile s3 up -d garage` + el script de inicio; subir y bajar un objeto | El objeto vuelve idéntico por la URL prefirmada |
| **C1** | `nx test service-desk`, `nx test platform-core`, `nx test contracts` | Todas las **negativas** de §5 y las mutaciones en rojo |
| **C2** | Migración en `:5442`; API arriba con `S3_*`; `node database/tests/http-service-desk-test.js` con el bloque nuevo | Los adjuntos y enlaces se guardan **en el bucket y en la tabla**; los rechazados dan 400 con el motivo; el `CHECK` rechaza una URL ajena (`23514`); **los dos caminos** probados |
| **C3** | `nx test view` (la directiva con `DragEvent` simulado) + recorrido manual + `npm run check:pantalla -- servicio` antes/después | Sin fallas nuevas y el recorrido completo en verde |

**Recorrido manual de C3 (Chrome/Edge de Windows):** arrastrar 1 archivo del Explorador · 3 a la vez · 6 (el sexto se rechaza con motivo) · una carpeta · un `.exe` · un `.docx` (mensaje del enlace) · un archivo > 8 MB · uno de 0 bytes · soltar **fuera** de la zona con el diálogo abierto (no debe salir de la página ni perder el texto) · arrastrar **texto seleccionado** (no debe encender la zona) · quitar un archivo de la lista · pegar un enlace válido y uno inválido · el mismo flujo **con el teclado** · tema oscuro · ancho de móvil.

**Despliegue (después de local verde):** (1) migración ADJ.2.1 **una por una**, antes que el código; (2) un PR contra `main` (nunca apilado) con `Build & typecheck` en verde; (3) probar con una imagen, un PDF y un enlace reales en prod; (4) medir de nuevo la métrica a los 14 y 30 días.

---

## 7. Riesgos y bloqueos

| Riesgo / bloqueo | Dueño | Causa | Qué lo destraba |
|---|---|---|---|
| **Durabilidad del bucket de prod.** No verifiqué a dónde apunta hoy `S3_ENDPOINT` para la Mesa (Tigris o Garage). `ops/k3s/62-garage` documenta Garage en **un solo NVMe, sin UPS** | Edgar / quien lleve VL | — | Confirmar el endpoint y el respaldo. Es menos grave: sigue siendo imagen + PDF de < 2 MB en la práctica |
| **El enlace llega sin poder abrirse** (queda restringido, D8) | 0Sistemas | No hay Workspace; el permiso lo pone cada persona | El aviso de ADJ.3.5; medir cuántos enlaces se usan antes de invertir más |
| **Archivos virtuales** (Outlook, OneDrive sin descargar) pueden llegar con 0 bytes o sin `File` | quien implemente | Dependen del navegador | ADJ.3.1 los rechaza con motivo; se prueba y se declara |
| **Pérdida de lo escrito** al soltar fuera de la zona | quien implemente | El navegador navega al archivo | ADJ.3.2 |
| **`sanitizarNombre` es compartido** con Reclutamiento | quien implemente | Un solo primitivo | ADJ.1.2 es inocuo para ellos; sus pruebas deben seguir verdes |

---

## 8. Definición de Terminado

- [ ] 1. Métrica de la cabecera **remedida** (49 % hoy), antes/después publicado
- [ ] 2. Cada capa verificada **o declarada NO MEDIDA** (ADR-056) — en particular ADJ.0.2
- [ ] 3. Los **dos** caminos que escriben (crear y responder) **ejercidos contra base real** con el payload de la pantalla
- [ ] 4. Toda regla o compuerta nueva **rota a propósito una vez**, rojo verificado
- [ ] 5. La directiva en `shared/`; las seis copias de «arrastrar» y las tres de «grabar» siguen como **deuda con nombre**
- [ ] 6. Tracker + `03_LOG_REVISIONES.md` al día (la fila `MS` ya existe)
- [ ] 7. **En prod**, o escrito por qué no y qué falta

---

## 9. Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
| 2026-10-22 | Plan. Medición de sólo lectura en prod: 49 solicitudes, 24 con adjunto (49 %), 26 adjuntos (14 PNG · 10 JPEG · 2 PDF), máx. 1.95 MB, `max_attachment_mb` = 8, 0 errores 4xx/5xx al crear y responder. Hallados: sin arrastrar y soltar; sin bucket local; tope de suma que no cuadra con los 32 MB del cuerpo; seis copias de «arrastrar» en otras pantallas | Claude (a pedido de Edgar) |
| 2026-10-22 (tarde) | Edgar: **D1 se queda** y se agrega el **enlace de Google**; D8: sin Workspace, enlace restringido por ahora; **trabajar primero en local**. Se construyó y se **descartó** un validador por familias de Office/texto (24 pruebas, 203 archivos reales) cuando Edgar confirmó que **sólo imágenes y PDF**. Queda en local `enlaces.ts` (25 pruebas). Docker activo | Claude |
| 2026-10-22 (noche) | **Local construido de punta a punta**, sin validación visual todavía. Servidor: `nombreDeAdjunto` (ADJ.1.1/1.2), tope de 22 MB por envío antes de decodificar (ADJ.1.3), migración `20261022135014_servicedesk_request_links` aplicada **sólo a la base local** (CHECKs probados con inserciones que se revierten: http, host por sufijo, `@`, espacio y `kind` fuera de lista), `links` en crear, responder y detalle con la misma visibilidad que los adjuntos (ADJ.2.x). Pantalla: directiva `appArchivoDrop` con guardián del documento, pieza compartida `app-sd-adjuntos` en el alta y en el hilo, enlaces en el detalle (ADJ.3.1–3.6). Pruebas: 306 de la lib y 57 del front (incluye las negativas de arrastre y enlaces), con mutaciones que se pusieron rojas (rango de `U+202E`, tope de 22 MB, cancelar el `drop` fuera de la zona). **NO MEDIDO:** el bloque 5-bis de `database/tests/http-service-desk-test.js` (necesita la API arriba: lo corre quien levanta `npm run api`); la mutación de la extensión peligrosa (la edición fue bloqueada); la vista en navegador. **Deuda con nombre:** ADJ.1.4 (la pantalla repite `MAX_ARCHIVOS`, tipos y tope de enlaces en `adjuntos.ts`) y ADJ.0.2. | 0Sistemas + Claude |
| 2026-10-22 (noche) | **Validación visual en local por 0Sistemas: «funciona bien»** (arrastrar desde el escritorio y enlace de Google, con el front y el API de ESTE árbol). Antes se había probado contra servidores de otra copia (la carpeta `etq-promo2` de `C:/tmp`) y no valía. **Sigue NO MEDIDO:** el bloque 5-bis del E2E contra el API de este árbol (la corrida previa fue contra el API equivocado) y la mutación de la extensión peligrosa. | 0Sistemas |
| 2026-10-22 (noche) | **E2E del servidor MEDIDO** contra el API de ESTE árbol y la base local: bloque 5-bis **13 de 13 ✅** (enlace de Hojas normalizado sin usp ni #gid; host ajeno, host por sufijo, http y 4.º enlace → 400; un envío con un enlace malo no deja el bueno guardado; PNG llamado foto.exe → foto.png; 3 PDF de 7.5 MB → 400 con el tope de 22 MB; el solicitante no ve el enlace de la nota interna y sí el del comentario público). Suite completa: **809 ✅ · 1 ❌** — el ❌ es PRV.2 («persona ya aceptó, se levanta a su nombre» → 404), en una cola confidencial, **sin relación con los adjuntos; NO verificado contra una base previa a este cambio**. Se corrigió la limpieza del test (borraba mensajes sin borrar antes request_links y dejaba basura) y la variable del puerto pasó a SD_API_BASE (el .env ya define API_BASE sin /api). Sigue NO MEDIDO: la mutación de la extensión peligrosa. | 0Sistemas + Claude |
