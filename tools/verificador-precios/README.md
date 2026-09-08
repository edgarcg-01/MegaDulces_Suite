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

**Antes de usarlo**: editar `$base`/`$urlSucs` al inicio del script con la
URL real donde vive `apps/api` (no se dejó una URL de producción adivinada —
confirmarla con el equipo: Railway público o la IP LAN si corre on-prem).

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

## Dos formas de llevarlo a cada sucursal

**A. Generación centralizada + distribución del archivo** (el modelo que ya
corría en producción, vía Task Scheduler en `.163`): correr el script UNA vez
al día en un servidor con acceso a `apps/api`, y copiar/sincronizar
`generados/verificador-NN.html` al PC de mostrador de la sucursal `NN`
correspondiente (recurso compartido de red, script de copia, o USB si la
sucursal no tiene red confiable ni siquiera para eso). Ventaja: un solo lugar
que puede fallar y avisar; el kiosco de la tienda no necesita saber nada de
la API.

**B. Generación local en cada sucursal**: correr el mismo script directamente
en el PC de mostrador, apuntado al `apps/api` central, con salida a una
carpeta local que el propio HTML abre. Requiere que esa PC alcance `apps/api`
al menos una vez al día (para refrescar el respaldo) — el modo híbrido de la
plantilla ya cubre las horas en que el wifi de esa sucursal falla *entre*
corridas.

En ambos casos, agregar una tarea programada de Windows (Task Scheduler) que
corra `Actualizar_Verificador.ps1` a diario — mismo patrón ya documentado
para `.163` ("MegaDulces - Actualizar verificador de precios").

## Configurar el servidor en un kiosco ya desplegado

Tocar el engrane ⚙ (abajo a la derecha) y capturar la URL base de `apps/api`
(sin `/api` al final, ej. `https://<servicio>.up.railway.app`). Queda
guardada en `localStorage` de ese navegador — hay que repetirlo si se
reinstala el navegador o se usa modo incógnito.

## Pendiente

- Confirmar la URL real de `apps/api` en producción y fijarla en el script
  (hoy es un placeholder `localhost:3334` a propósito).
- Decidir modelo A o B por sucursal según su conectividad real.
- `/api/salud` no existe todavía en `apps/api` (se perdió al absorber
  `catalogo-kp`) — sin eso, la frescura del CDC sólo se puede ver vía
  `GET /api/sucursales` (`datos_al` por plaza), no un endpoint de salud
  dedicado.
