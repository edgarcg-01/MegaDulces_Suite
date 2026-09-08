# Verificador de precios de mostrador — por sucursal, híbrido en vivo + respaldo

Kiosco/pistola de código de barras en mostrador que responde "¿cuánto cuesta
este producto?". Lee de `kepler_ods.*` en `postgres_platform` vía los
endpoints públicos (`@Public()`, sin sesión) absorbidos a `apps/api`:

- `GET /api/kp/precio?q=<código>` — un producto.
- `GET /api/kp/precios-todos?sucursal=NN` — catálogo completo de esa plaza
  (fuente del respaldo offline).
- `GET /api/sucursales` — lista de plazas vigentes + frescura del CDC.

## Cómo funciona `Verificador_Precios_OFFLINE.html`

Un solo archivo HTML autocontenido, pensado para abrirse en el navegador de
un kiosco/PC de mostrador (pantalla completa, mantiene el foco en el input
para que un lector de código de barras USB "teclee y Enter" funcione solo).

Es **híbrido**, no uno u otro:

1. Si el archivo tiene servidor configurado (engrane ⚙, guarda la URL en
   `localStorage`), **cada búsqueda intenta primero el servidor en vivo**
   (`/api/kp/precio`) — precio al segundo, con timeout de 2.5s.
2. Si el archivo además trae datos incrustados (`window.MDPRECIOS`, los
   inyecta el generador de abajo), **cuando el servidor no responde a tiempo
   o no hay red, cae automáticamente a esos datos** — el mostrador sigue
   dando precios aunque el wifi de la sucursal falle. La tarjeta de producto
   avisa "⚠ Sin conexión — precio de respaldo" para que quien cobra sepa que
   puede no ser el más reciente.
3. Si el servidor responde y dice "no encontrado", esa respuesta es
   autoritativa — no se reintenta con datos locales viejos (evitaría mostrar
   un producto descontinuado como si existiera).
4. Sin servidor configurado y sin datos incrustados, no hay nada que mostrar
   (fuerza la configuración al abrir).

## Generar el respaldo offline: `Actualizar_Verificador.ps1`

Genera **un archivo por sucursal** (`generados/verificador-NN.html`) porque
hay códigos que cuestan distinto según la plaza — un archivo único mostraría
el precio de una sucursal cualquiera (ver comentario de `getPreciosTodos` en
`apps/api/src/modules/kp/kp.service.ts`).

Ya apunta a la URL real de producción (confirmado por el equipo, 2026-09-08:
"todo es por Railway") — la misma que usa `apps/vendor` para llegar al
backend desde un WebView nativo sin nginx de por medio
(`https://trademarketing-production-5084.up.railway.app`, ver
`apps/vendor/src/environments/environment.ts`).

Si algo falla (API caída, JSON corto, sucursal sin datos), el script **no
toca el archivo bueno anterior** — un respaldo con los precios de ayer sirve
para llegar a la próxima corrida; uno roto o vacío deja sin precios al
mostrador. Guardas de encoding (UTF-8 sin BOM) y de estructura (`<script>`
balanceados) heredadas del script hermano en el repo standalone
`verificador-precios`.

```powershell
cd tools\verificador-precios
.\Actualizar_Verificador.ps1
```

## Modelo elegido: centralizado, con opción local por sucursal

Decisión del equipo (2026-09-08): **por default, centralizado** — un solo
equipo con internet corre el script una vez al día y distribuye el archivo;
**cada sucursal puede optar por lo local** cuando la distribución centralizada
no le llegue (sin recurso de red configurado, PC aislado, etc.). Como el
backend vive en Railway (público, no LAN), ambas formas solo necesitan
internet normal — ninguna depende de una red interna entre sucursales.

**Centralizado (default):** correr el script una vez al día en un solo
equipo con internet. `$destinos` (al inicio del script) mapea sucursal → ruta
de red del PC de mostrador (`\\PC-MOSTRADOR-NN\...`); para las sucursales ahí
configuradas, el script copia automáticamente `verificador-NN.html` recién
generado a esa ruta después de generarlo. Un fallo de copia (recurso de red
caído) no cuenta como fallo de la generación — el archivo bueno queda de
todas formas en `generados/`. **Hoy `$destinos` está vacío** (no se inventaron
rutas de red reales) — llenarlo sucursal por sucursal según se vayan
definiendo los recursos compartidos.

**Local (opción por sucursal):** correr el mismo script directamente en el PC
de mostrador, sin tocar nada más — misma URL pública, salida a su propia
carpeta `generados/` local que el HTML abre. Es la opción natural para
cualquier sucursal sin entrada en `$destinos`.

En ambos casos, agregar una tarea programada de Windows (Task Scheduler) que
corra `Actualizar_Verificador.ps1` a diario — mismo patrón ya documentado
para `.163` ("MegaDulces - Actualizar verificador de precios").

## Configurar el servidor en un kiosco ya desplegado

Tocar el engrane ⚙ (abajo a la derecha) y capturar la URL base de `apps/api`
(sin `/api` al final, ej. `https://<servicio>.up.railway.app`). Queda
guardada en `localStorage` de ese navegador — hay que repetirlo si se
reinstala el navegador o se usa modo incógnito.

## Pendiente

- Llenar `$destinos` con las rutas de red reales, sucursal por sucursal.
- `/api/salud` no existe todavía en `apps/api` (se perdió al absorber
  `catalogo-kp`) — sin eso, la frescura del CDC sólo se puede ver vía
  `GET /api/sucursales` (`datos_al` por plaza), no un endpoint de salud
  dedicado.
