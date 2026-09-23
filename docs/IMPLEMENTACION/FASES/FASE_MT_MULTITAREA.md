# Fase MT — Multitarea en la Suite

> **Tesis (ADR-078): la multitarea la da el navegador; la Suite la está bloqueando a medias.**
> No se construye un workspace de pestañas dentro de la app. Se quitan los tres estorbos que
> impiden usar el gestor de ventanas que el sistema operativo ya trae, y se paga el costo que
> varias ventanas imponen al API.

**Alcance decidido por el usuario (2026-09-22): sólo `apps/view`.** `apps/portal`, `apps/vendor`
y `apps/tienda` quedan fuera, con su deuda declarada abajo.

---

## 1. Lo medido antes de decidir

Todo sobre `apps/view` (534 clases, 224 rutas lazy, 307 `path:`), el 2026-09-22.

### Lo que ya funciona — la Suite está bien parada para el camino nativo

| Hecho | Medición |
|---|---|
| Sesión compartida entre pestañas | token en `localStorage`, **0 usos de `sessionStorage`** |
| Angular **zoneless** | `provideZonelessChangeDetection()` — N documentos no comparten costo de detección |
| El estado de pantalla vive en el componente | de **123** servicios `providedIn:'root'`, **21** tienen estado y sólo **3** son estado de pantalla |
| Precedente de coordinación entre pestañas | `offline-sync.service.ts` ya usa **Web Locks** |
| Ctrl+clic en el menú y en `/projects` | sidebar y Mi trabajo ya usan `<a [routerLink]>` |
| No hay Capacitor | `apps/view` no tiene `capacitor.config` — es web pura |

### Lo que estorba

1. **La mitad de la navegación bloquea la pestaña nueva.** **129** `router.navigate()` imperativos
   en **71** componentes contra **138** `routerLink`. De los que apuntan a una ruta absoluta
   (**68**), hay **20 drill-downs a detalle con id** y **37 a ruta fija**. Un `(click)` sobre un
   `<div>` no tiene Ctrl+clic, ni clic central, ni «Abrir en pestaña nueva», ni preview de la URL.
   Los **27** `navigate([])` de sólo-queryParams **no cuentan** y no se tocan.
2. **Cero sincronía entre pestañas.** `addEventListener('storage')`: **0 ocurrencias**.
3. **El polling se multiplica.** **14** componentes con `setInterval` y sólo **2** miraban si la
   pestaña se ve. Más **11 gateways** WebSocket sin tope de conexiones por usuario.

### Por qué NO pestañas dentro de la app

- **No hay `RouteReuseStrategy`** (0 ocurrencias). Con 224 rutas lazy, outlets con nombre
  (`(a:…//b:…)`) y guards por outlet es inmanejable.
- **Los 3 servicios de estado de pantalla son justo los que querrías duplicar.**
  `FiltersStateService` se documenta a sí mismo como *«compartido entre Dashboard y Reportes»*;
  `TiendaStateService` como *«una sola conexión WS para las 3 páginas»*; más `analisis-state`.
  Dos pestañas internas de Reportes se pisarían los filtros.
- **Riesgos de DOM global con dos instancias vivas**: 6 componentes usan `getElementById` /
  `querySelector`, 7 montan Chart.js, 1 Leaflet, y hay `id=` duros duplicados.
- **No compra nada que el navegador no dé gratis.** Con pestañas nativas cada una ya conserva su
  estado vivo sin re-consultar y cambiar entre ellas ya es instantáneo.

---

## 2. Sprints

| Item | Qué | Estado |
|---|---|---|
| **[SN.31]** | El destino sobrevive al login (precursor: salió de este análisis) | 🧪 2026-09-22 |
| **[MT.0]** | Poléa sólo mientras la pestaña se ve — el primitivo + sus 9 consumidores | 🧪 2026-09-22 |
| **[MT.1]** | Los 47 saltos imperativos de escritorio a `<a [routerLink]>` | ⬜ |
| **[MT.2]** | Listener de `storage`: logout y cambio de permisos se propagan | ⬜ |
| **[MT.3]** | Afordancia «abrir en otra ventana» en los drill-downs donde comparar es el trabajo | ⬜ |
| **[MT.4]** | Medir en vivo el costo real por pestaña (hoy sólo hay la medición determinista) | ⬜ |

### [MT.0] — el primitivo de encuesta

`apps/view/src/app/core/utils/poll-visible.ts` → `encuestarVisible(cadaMs, trabajo, opciones)`.

**No se inventó acá.** `tienda-arqueo` ya lo tenía **completo** (chequea `visibilityState` antes de
la consulta y vuelve a consultar al reaparecer, vía `@HostListener`), y `tienda-arqueo-historial`
tenía **la mitad** (chequea, pero se quedaba esperando al timer al volver). Esto es esa lógica
subida a un lugar — el patrón de ADR-056.

**Ponerse al día no es opcional.** Pausar sin re-consultar al reaparecer deja al usuario mirando
datos *más viejos* que antes del cambio: volvés a la pestaña y esperás hasta un ciclo entero. Con
la puesta al día, pausar ahorra peticiones **y** devuelve dato más fresco que el timer ciego.

**Los 9 consumidores:**

| Dónde | Cada | Por qué importa |
|---|---|---|
| `notifications-bell` | 60 s · **2 peticiones** | ⭐ vive en el header del layout → corre en **toda** pantalla de la Suite |
| `live-map` (respaldo de flota) | 30 s | sólo si el WS está caído |
| `live-map` (seguir una unidad) | 60 s | |
| `admin-db-health` | 60 s | conserva su interruptor de auto-refresco |
| `erp-trips-panel` | 60 s | |
| `logistica-live` | 30 s | |
| `logistica-rastreo` | 30 s | sólo si el WS está caído |
| `home-delivery-tracking` | 30 s + 15 s | sus **dos** consultas de red |
| `tienda-cajas` | 30 s | |
| `tienda-arqueo-historial` | 60 s | ya chequeaba; gana la puesta al día |

**Lo que NO se tocó, con motivo:**

- **Relojes de UI** (`thot-ai-input` 1 s, `comercial-route-promo`, `finanzas-maat-chat`, el tick de
  frescura de `home-delivery-tracking`, `map-live-layer`): no cuestan red y pausarlos congelaría
  la pantalla.
- **`comercial-inventory-count`**: no es una lectura, es el **vaciado de capturas pendientes** a la
  red. Pausarlo con la pestaña de fondo retrasaría el guardado del trabajo de alguien. Dato antes
  que peticiones.
- **`tienda-arqueo`**: ya tiene el mecanismo completo y correcto. Migrarlo sería tocar 1,858 líneas
  para no cambiar la conducta.
- **`geo-validation` / `route-ping`** (core): GPS bajo demanda, y `route-ping` ya maneja su propia
  visibilidad.

**La medición (determinista, en `poll-visible.spec.ts`).** Escenario de 10 minutos con la pestaña
abierta y **8 de ellos de fondo**, que es lo que le pasa a la ventana que dejás atrás:

| | Vueltas | Peticiones de la campana |
|---|---|---|
| Antes (`setInterval` pelado) | **10** | **20** |
| Después (`encuestarVisible`) | **3** (1 + puesta al día + 1) | **6** |

⚠️ **Es la medición del mecanismo, no del uso.** No sabemos cuántas pestañas tiene abiertas la
gente ni cuánto tiempo las deja de fondo: no hay telemetría de peticiones (`portal_telemetry_events`
registra clics, no HTTP). Eso es **[MT.4]** y hasta entonces se declara.

**La prueba negativa** (una compuerta sin ella es una intención): alternar rápido entre dos ventanas
**no** dispara consultas de más. Si la puesta al día corriera en cada `visibilitychange` sin mirar
cuánto pasó, trabajar con dos ventanas —el caso que la fase existe para habilitar— pediría *más*
que el timer ciego. Sin esa prueba el bloque de la medición se pone verde igual.

---

## 3. Deuda declarada

- **`apps/vendor` tiene copiados los dos defectos**: las salidas al login sin destino
  (`auth.guard`, `permission.guard` ×2, `rider.guard`, `vendor.guard`) y el polling sin pausa.
  Fuera por el recorte «sólo en suite».
- **Los 11 gateways WebSocket no tienen tope de conexiones por usuario.** Con N ventanas son N
  sockets. No medido en prod.
- **El costo real por pestaña** sigue sin medirse en vivo → [MT.4].
