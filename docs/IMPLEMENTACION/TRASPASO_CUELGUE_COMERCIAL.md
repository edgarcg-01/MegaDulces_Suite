# Traspaso — "se cuelga /comercial" (2026-08-20/21)

Documento para quien retome el problema. **No está resuelto.** Lo que sigue es lo medido,
lo descartado con evidencia, lo que cambié y lo que quedó abierto. La razón de escribirlo
es concreta: yo quemé cuatro hipótesis equivocadas por medir del lado que no era, y
repetirlas cuesta un deploy y una espera del usuario cada vez.

---

## Síntoma reportado

Edgar: al entrar al proyecto **Ventas** (`/comercial` → landing `/comercial/command-center`)
la pantalla "se queda colgada". Dato clave que aportó: **`/comercial/sell-out` NO falla**.
Misma ruta padre, mismo layout, mismos guards, mismos sockets.

**Nunca lo pude reproducir.** Todas las capturas —las mías con Playwright y las del propio
usuario con la grabadora— muestran la pantalla cargando bien.

---

## Lo que está MEDIDO (no supuesto)

### El servidor responde

- `pg_stat_activity` durante el cuelgue (lo corrió Edgar en prod): **una sola consulta
  activa**, la del propio diagnóstico, duración ~0. La base nunca fue el cuello.
- `/api/health` desde mi máquina: 25/25 en ~0.3 s. 30 peticiones concurrentes: máx 0.40 s.
- Logs HTTP de Railway: 343 peticiones en 8 minutos. Sin martilleo. Los 5xx del periodo
  estaban todos dentro de la ventana de 8 s de un reinicio de contenedor.

### La pantalla carga

Reproducción con Playwright contra prod (login real, navegador limpio, sin service worker):

```
t+2s   h1 "Centro de control" visible · 5 esqueletos
t+5s   quedan 2 pendientes: network/overview y network/top-products
t+6s   0 esqueletos · tablero completo
t+40s  estable, sin errores, WebSocket conectado
```

La grabadora en el navegador de Edgar dice lo mismo: `NAV /comercial/command-center 473 ms
end`, 11 peticiones en 200, **0 navegaciones sin terminar, 0 peticiones sin responder**,
334 ms de bloqueo de hilo en total.

### Lo que sí está mal

**El tablero tarda lo que tarda su peor panel.** `loadAll()` usa `forkJoin` con 11
peticiones y el template esconde TODO detrás de un único `loading()`
(`@if (loading()) {esqueleto}` / `@if (!loading()) {contenido}`). 9 de 11 llamadas
terminaron en ≤1.8 s y quedaron invisibles hasta que la más lenta cerró a los 4.4 s.

Medición en prod, antes y después de mi cambio:

| Endpoint | Antes | Después |
|---|---|---|
| `analytics/network/overview` | 4,403 ms | **2,502 ms** |
| `analytics/network/top-products` | 4,064 ms | 3,057 ms |
| `analytics/network/sales-by-brand` | 1,817 ms | 1,389 ms |
| los otros 8 | ≤1,660 ms | ≤1,296 ms |

---

## Hipótesis DESCARTADAS (con la evidencia que las mató)

Cuatro. Las tres últimas eran defectos reales y los arreglos valen, pero **ninguna era la
causa del síntoma reportado**.

1. **Vistas lentas de `analytics` (`erp_customers`, `erp_shipments`).** Descartada por
   volumen: `kepler_ods.kdud` 8,102 filas, `customer_product_sales` 43,873,
   `kepler_ods.kdpord` 70,055. Y `erp-customers` mide 0.30 s. Un `DISTINCT ON` sobre 8 mil
   filas no cuelga nada.
2. **Fuga de sockets.** Era real (`if (this.socket?.connected) return` creaba sockets
   huérfanos en 9 servicios) y está arreglada. Pero es un factor de 2, no de 500. El
   "rate limit of 500 logs/sec" de Railway resultó ser **NestJS registrando sus rutas al
   bootear**: aparece 11 s después del arranque y nunca más.
3. **`Connection: upgrade` hardcodeado en nginx.** Defecto real, arreglado y desplegado
   (`8b206428`). El síntoma **persistió** después.
4. **Service worker + preloader del router.** El SW prefetcheaba 255 chunks / 17 MB en
   cada deploy (arreglado, 255→5 archivos) y `SelectivePreloadStrategy` disparaba 170
   `import()` concurrentes en cada `NavigationEnd` para administradores (arreglado,
   ahora opt-in). Ambos reales. El síntoma **persistió**.

### Pista falsa que costó tres vueltas

`command-center:1 Failed to load resource: 504 (Gateway Timeout)` en la consola, **sin
ningún 504 en los logs del servidor**. `ngsw-worker.js` **fabrica** respuestas
`504 Gateway Timeout` propias en 5 sitios cuando un fetch falla con el driver degradado.
No lo emitió el servidor. Cualquier 504 que no aparezca en los logs de Railway hay que
sospecharlo del service worker antes que del backend.

---

## Cambios que quedaron en `main`

Todos desplegados y verificados en prod salvo donde se indique.

| Commit | Qué |
|---|---|
| `60f4300d` | Timeout de 20 s por panel en `loadAll()`. Antes, `forkJoin` sin timeout: un endpoint que no respondiera colgaba el tablero para siempre. `catchError` no alcanzaba — atrapa errores, no silencio. |
| `27479dfd` | Fuga de sockets: guarda por existencia en 9 servicios + refcount en `AlertsSocketService` (lo comparten campana, toast y command-center; el primero en destruirse dejaba mudos a los otros). |
| `8b206428` | nginx: `Connection` se pasa de la petición en vez de forzarse a `upgrade`. |
| `76c30cb6` | `ngsw-config.json`: separar shell de chunks. Prefetch 255→5 archivos, 17 MB→1.22 MB. |
| `800aa217` | `SelectivePreloadStrategy` opt-in + demora. Y `app.component` deja de hacer `activateUpdate()+reload()` en la navegación que el usuario acaba de pedir. |
| `5abd284d` | `networkOverview`: una sola pasada por `sales_daily` en vez de dos. Resultado verificado idéntico en los 8 campos. |
| `1c42da92`, `0bc0b1ac` | Instrumentación (abajo). |

---

## Instrumentación disponible

### `/diagnostico` (en la app)

Cualquier usuario autenticado. Botón **Copiar diagnóstico**. La grabadora
(`DiagnosticsRecorderService`) arranca con la app y persiste en `localStorage`, así que
**sobrevive a la navegación y a la recarga** — el primer intento medía al abrir la
pantalla y perdía justo la evidencia del cuelgue.

Reporta, en este orden de importancia:

- **navegaciones sin terminar** (`ms: null`) — el router arrancó y nunca llegó;
- **peticiones sin responder** (`ms: null`);
- **segundos con la UI trabada** — cuadros por segundo vía `requestAnimationFrame`. Es lo
  único que detecta un bucle de render: miles de tareas de 5 ms que no califican como
  "tarea larga" y dejan la interfaz muerta. Registra en qué ruta pasó;
- versión que **ejecuta** la pestaña vs la que **sirve** el servidor (este desfase confundió
  dos veces: se probaba código que ya no existía);
- estado del service worker, bloqueo de hilo, ping a la API desde la pestaña.

### `scripts/probe-command-center.js`

Sonda con Playwright contra prod, con login real. Segundo a segundo: peticiones abiertas,
esqueletos restantes, título visible. Al final, todas las llamadas de API ordenadas por
duración y la consola.

```sh
npx playwright install chromium
MSYS_NO_PATHCONV=1 PW_USER=<u> PW_PASS=<p> \
  node scripts/probe-command-center.js "/comercial/command-center" 40
```

En Git Bash, sin `MSYS_NO_PATHCONV=1` la ruta se convierte en un path de Windows.

---

## Lo que queda abierto

**La pregunta sin responder:** ¿"colgado" significa esperar ~6 s con esqueletos, o algo que
nunca termina? Nunca lo aclaramos, y las dos lecturas llevan a lugares distintos. Ninguna
captura mostró jamás la falla, así que o el síntoma es la espera, o es intermitente y
depende de un estado del navegador de Edgar que no reprodujo el mío.

**Si es la espera** (lo más probable con lo medido), lo que falta es:

1. ~~Partir el `loading()` único del template.~~ **HECHO 2026-08-21.** Una bandera por panel
   (`ovLoading`, `dsLoading`, `tpLoading`, `sbbLoading`, `custLoading`, `lsLoading`,
   `icLoading`, `convLoading`) + `heroLoading`/`productsLoading`/`opsLoading`/`anyLoading`
   derivadas. `loadAll()` dejó de usar `forkJoin`: cada llamada se escribe en cuanto llega, y
   el reveal escalonado arranca con el PRIMER panel, no con el último.
2. ~~La segunda pasada de `networkTopProducts`.~~ **HECHO 2026-08-21.** Memo en proceso
   (`netRevenue30d`, TTL 60 s) que llena `networkOverview` con la suma de sus canales — mismo
   WHERE, mismo número, sin filtro de promo — y lee `networkTopProducts`. Sin memo fresco,
   `share_pct` viene `null` en vez de costar otra pasada; `?share=true` lo fuerza. Ningún
   consumidor lo lee: el Centro de control calcula su share sobre el top-N y Ventas Generales
   sólo usa revenue/margen/unidades.
3. `analytics.sales_daily` son 400 MB / ~900k filas con índice `(tenant_id, sale_date)`. Una
   pasada de 30 días cuesta ~1.3 s en prod. Si hace falta bajar más, el camino es una vista
   materializada (el proyecto ya tiene `analytics.mv_*` de la Fase C.1, refrescadas cada
   15 min) — pero cambia la frescura y eso es decisión de negocio.

**Si nunca termina**, el próximo `/diagnostico` lo va a delatar con una fila de
"navegación sin terminar" o "segundos con la UI trabada". Sin eso, cualquier cosa que se
proponga es otra hipótesis.

---

## Pendientes de seguridad de este incidente

Dos credenciales de producción quedaron expuestas en texto plano durante la investigación:

- la contraseña de la base de Railway (`postgres@trolley.proxy.rlwy.net`);
- el usuario `superoot` con contraseña `superoot`, que además tiene permisos de plataforma.

**Las dos hay que rotarlas.** La segunda, además, no debería ser esa contraseña.
