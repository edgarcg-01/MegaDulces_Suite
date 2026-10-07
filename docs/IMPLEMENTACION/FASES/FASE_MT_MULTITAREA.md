# Fase MT — Multitarea en la Suite

> **Tesis (ADR-078, enmendada 2026-09-23): tres destinos, uno por modo — esta pantalla, el panel
> de al lado, u otra ventana.** La tesis original decía sólo *"la multitarea la da el navegador"* y
> se quedaba corta: **el usuario pidió partir la pantalla principal en dos y eso nunca se puso
> sobre la mesa**. Lo que se rechaza sigue siendo el *tab strip* estilo VS Code (estado desacoplado,
> `RouteReuseStrategy`); la pantalla partida es otra cosa y no necesita nada de eso. Ver `[MT.5]`.

**Alcance decidido por el usuario (2026-09-22): sólo `apps/view`.** `apps/portal`, `apps/vendor`
y `apps/tienda` quedan fuera, con su deuda declarada abajo.

---

## 1. Lo medido antes de decidir

Todo sobre `apps/view` (534 clases, 224 rutas lazy, 307 `path:`), el 2026-09-22.

### Lo que ya funciona — la Suite está bien parada para el camino nativo

| Hecho | Medición |
|---|---|
| Sesión compartida entre pestañas | token en `localStorage`, **0 usos de `sessionStorage`** |
| Angular **zoneless** | `provideZonelessChangeDetection()` — N cartera | documentos no comparten costo de detección |
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

### ⚠️ Enmienda 2026-09-23 — lo que este análisis midió de más

El usuario señaló que **el objetivo incluía partir la pantalla en dos y no se cumplió**. Al volver
a medir, dos de los tres argumentos de esta sección estaban sobredimensionados:

| Lo que decía | Lo que mide |
|---|---|
| «Los 3 servicios de estado compartido son justo los que querrías duplicar» | Afectan **47 de 225 rutas** (`dashboard` 28, `tienda` 19) y **sólo si los dos paneles son de la misma familia**. Los cruces que motivan la pantalla partida —cartera | documento\|documento, existencia | pedido\|pedido— tienen **cero** colisión |
| «Riesgos de DOM global» | **5 componentes de página** usan `getElementById`/`querySelector`. Acotado y nombrable |
| «Outlets con nombre son inmanejables con 224 rutas» | Se **espejan por código**: el árbol es un array de datos. ~40 líneas, no 225 duplicaciones |

Lo que sí se sostiene es el rechazo al *tab strip*. **Partir la pantalla no es eso.**

### Por qué NO pestañas dentro de la app (sigue vigente para el *tab strip*)

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
| **[MT.1]** | Los drill-downs de escritorio a `<a [routerLink]>` | 🧪 2026-09-22 |
| **[MT.2]** | Listener de `storage`: lo que pasa en una ventana llega a las otras | 🧪 2026-09-22 |
| **[MT.3]** | El botón del header: una acción y una preferencia, ambas opt-in | 🧪 2026-09-22 |
| **[MT.3.1]** | La cadena completa, renderizada: `href` real + la preferencia en los 11 | 🧪 2026-09-22 |
| **[MT.5]** | **Pantalla partida**: el detalle abre en el panel de al lado | 🧪 2026-09-23 |
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

### [MT.1] — los drill-downs son enlaces

⚠️ **Corrección al diagnóstico:** los «47 saltos de escritorio» eran el conteo de navegaciones
imperativas, **no** el de cosas que deberían ser un enlace. Al leer cada sitio: **16 de las 20 de
dashboard son rebotes por permiso** (`if (!puede) → /dashboard`), y hay redirecciones después de
guardar, tras un diálogo de confirmación y el logout. **Eso debe seguir siendo imperativo** — no
son destinos, son consecuencias. Lo convertible era bastante menos.

**16 convertidos** (11 destinos + 4 «Volver» + la campana):

- **Lista → detalle (6).** Órdenes de compra · requisiciones · existencia | pedidos · sesiones de inventario ·
  embarques · revisiones de caducidad. Un `<tr>` **no se puede envolver en `<a>`**, así que se
  conserva el clic de fila y la **celda que identifica** (el folio) pasa a ser enlace de verdad,
  con `stopPropagation` para que la fila no navegue además.
- **Entre módulos (5)** — los de cotejar: cartera | documento → documento · costo neto → descuentos · pagos →
  descuentos · solicitudes → gasto · auditoría de ruta → historial.
- **«Volver» (4)**, con clic central abren la lista al lado sin perder el detalle.
- **La campana (1)**, que es donde más se nota: ves una alerta y la abrís *junto a* lo que estabas
  haciendo, no encima.

⭐ Dos hallazgos de paso: **`comercial-inventory-sessions` tenía `[routerLink]` sobre el `<tr>`** —
navega, pero **no** es un ancla, así que nunca dio Ctrl+clic; parecía resuelto y no lo estaba. Y
**`finanzas-solicitudes` tenía un `<button class="so-link">`**: ya se llamaba «link» y se pintaba
como link, sin serlo.

**La clase es compartida.** Había **14 clases `*-link` distintas** por módulo (`tw-dlink`,
`rr-link`, `cap-link`, `rp-link`…) para el mismo trabajo — otro primitivo re-inventado. Se agregó
`.surf-cell-link` a la familia `surf-*` de `styles.css`: en reposo se ve como el texto de la celda
(DESIGN.md pide chrome casi monocromático; una columna azul subrayada grita), y el color aparece
en hover/focus, que es cuando la afordancia hace falta.

**Cobertura, en dos mitades.** `drilldown-links.spec.ts` (17, con la negativa: revertir un ancla a
`<button>` lo pone rojo) cuida la **forma**; el **compilador de plantillas** de `nx build view`
cuida que la URL resuelva y que `RouterLink` esté importado — un standalone con `routerLink` sin
importarlo no compila. Ninguna de las dos sola alcanza, y por eso se dice.

**Queda sin convertir, con motivo:** los rebotes por permiso, las redirecciones post-guardado, el
logout, `finanzas-maat-chat` (intercepta enlaces dentro del markdown que genera) y
`comercial-egresos → goToDetalle` (lo llaman dos métodos, no un clic directo; se puede, es más
invasivo).

---

### [MT.2] + [MT.3] — el botón del header, y que no mienta

**Pedido del usuario (2026-09-22):** *«esto debe ser opcional, debe existir un botón en el header,
y debe ser casi imperceptible en rendimiento»*. Eligió **las dos** formas —acción y preferencia— y
confirmó que lo de `[MT.0]`/`[MT.1]` se queda siempre activo.

**Son dos cosas y van separadas en el menú**, porque fallan distinto:

1. **La acción** — «Abrir esta pantalla en otra ventana». No cambia el estado de nada: si no la
   tocás, la app se comporta igual que siempre. Es opt-in por construcción.
2. **La preferencia** — «Abrir siempre los detalles aparte». Mientras está prendida, los 11
   enlaces de drill-down llevan `target="_blank"`.

⭐ **La preferencia es un atributo, no lógica nuestra.** `RouterLink` **ya** deja pasar la
navegación nativa cuando el `target` es un string distinto de `_self` (verificado en el fuente del
router, no asumido). Así que toda la preferencia es un `[target]` atado a un signal: **cero
interceptores de clic, cero `window.open` propio, cero trabajo por render**. Eso es lo que la hace
imperceptible.

**Medido, que es lo que el existencia | pedido exige:**

| | Antes | Después |
|---|---|---|
| Transferencia inicial | 267.39 kB | **267.94 kB** (+550 bytes) |
| Trabajo en reposo | — | **2 listeners de `storage`** (uno global, uno del servicio) y 11 lecturas de signal en detección de cambios |

No hay timers, ni sondeos, ni listeners por enlace.

**`[MT.2]` no es opcional para que esto funcione.** Una preferencia de multitarea que no llega a
las otras ventanas es una preferencia que **miente**: la prendés en una, mirás la otra y se
comporta al revés. El primitivo (`core/utils/cross-tab.ts`) es el que faltaba desde el
diagnóstico: **cero listeners de `storage` en 534 clases**.

Con el mismo mecanismo se cierra el defecto de fondo: **cerrar sesión en una ventana cierra
todas**. Antes, te ibas en una y la otra seguía pintando una pantalla viva con token muerto hasta
su próxima petición — y hasta ahí, quien se levantó de la computadora la dejó con la sesión de
otro a la vista. ⛔ **Sólo el borrado se propaga**: si llega un token *nuevo* (otro usuario entró
en otra ventana) no se toca nada, porque recargar bajo las manos de alguien que está capturando es
peor que la incoherencia, y el 401 con su `returnUrl` (`[SN.31]`) ya lo resuelve.

**Dónde NO aparece el botón:** kiosco (`isRestricted()`) y móvil. En una caja de tienda o en el
teléfono no hay ventanas que administrar, y un botón que no sirve ahí es ruido en la barra más
cara de la app.

⚠️ **Trampa que costó un build:** el input `target` de `RouterLink` está tipado
`string | undefined`. Con `null` **`tsc --noEmit` pasa limpio** y revienta el compilador de
plantillas de Angular. Otra confirmación de que las dos mitades de cobertura son necesarias.

**La prueba negativa** es el filtro de clave: el evento `storage` llega por **todas** las claves
del origen, así que un listener sin filtro haría que cambiar el tema, un filtro guardado o el
contador del verificador le moviera la multitarea a todo el mundo. Ejercida: se quitó el filtro y
cayó esa prueba, sólo esa.

---

### [MT.3.1] — cerrar el hueco que yo mismo declaré

`[MT.1]` dejó dicho que su compuerta mira la **forma** y no el comportamiento. Faltaba lo único
que al usuario le importa: **que el ancla renderizada tenga un `href` de verdad** y que la
preferencia le mueva el `target`. Ni la compuerta de fuente, ni el compilador, ni el spec del
servicio aislado lo cubrían.

Se monta **de verdad** `compras-requisiciones` (la más barata: 123 líneas, una sola dependencia
que doblar) y se comprueba sobre el DOM: `href="/compras/requisiciones/{id}"`, sin `target` con la
preferencia apagada, `target="_blank"` con ella prendida, y que el `href` **no cambia** —la
preferencia elige *dónde* abre, no *a dónde* va—. La cadena es la misma en las 11.

⭐ **El `href` es el punto.** Un `[routerLink]` sobre un elemento que no es `<a>` navega igual y no
da Ctrl+clic, ni clic central, ni preview de la URL. Ese defecto estaba **vivo** en
`comercial-inventory-sessions` y se veía idéntico en pantalla.

**Dos negativas, ejercidas:**

- **`stopPropagation`**: se quitó del fuente real y cayó esa prueba, sólo esa. Sin el freno, un
  clic en el folio dispara además el manejador de la fila; con la preferencia prendida es peor,
  porque la fila navega en *esta* ventana mientras el ancla abre otra — terminás con la pantalla
  cambiada abajo del mouse y una ventana nueva encima. La contraprueba también está: un clic en
  **otra** celda sí navega, o sea que no se rompió lo que ya andaba.
- **Consistencia de la preferencia**: los 11 anclas deben llevar `[target]`. Si un drill-down
  nuevo se agrega sin él, la preferencia se aplica a unos sí y a otros no — y eso es **peor que no
  tenerla**: el usuario la prende, ve que a veces pasa y a veces no, y deja de confiar en el
  interruptor. Es invisible en pantalla y no lo atrapa ni el compilador ni la prueba renderizada,
  que monta una sola.

---

### [MT.5] — la pantalla partida

**El objetivo que faltaba.** Hacés clic en un folio y el detalle abre **en el panel derecho**, con
la lista intacta a la izquierda. El modo se elige en el botón del header: *reemplazar esta
pantalla* (default) · *abrirlo al lado* · *abrirlo en otra ventana*.

**El obstáculo estructural, medido antes de diseñar:** no hay un `LayoutComponent` con 225 hijos,
hay **12 — uno por área**. Un `<router-outlet name="panel">` dentro del layout sólo puede hospedar
hijos de SU área, y **4 de los 11 drill-downs cruzan de área** (cartera | documento→documento,
pagos→descuentos, auditoría→dashboard, sesiones→almacén), que son justo los de cotejar.

**La solución: el espejo aplanado** (`core/panel/panel-routes.ts`). Cada hijo de área se reescribe
con el prefijo de su área y se cuelga del outlet `panel` de las 12. Es una copia superficial, así
que **`canActivate` viaja con ella** — un espejo mal hecho no es un bug de layout, **es un guard
evadido**, y en pantalla se ve perfecto. Los `loadComponent` se comparten por referencia: mismo
chunk, otra instancia, **cero bytes de bundle**. Va como `loadChildren`, así que mientras nadie
parta la pantalla **no se recorre ni el árbol**.

Se deja afuera, con motivo: los `redirectTo` (al aplanar, un redirect relativo apunta a otro lado)
y el comodín `**` (se tragaría cualquier segmento y el panel mostraría el 404 en vez de no abrir —
que no abra es la respuesta honesta).

**Los 47 se declaran, no se bloquean.** Cuando los dos lados caen en la misma familia, el
encabezado del panel dice *«comparten filtros»*. Comparar dos reportes es un caso legítimo; lo que
no se puede es que el usuario no sepa qué está viendo.

**Dos defectos que sólo la prueba renderizada encontró:**

1. ⛔ **Las barras salían escapadas.** Dentro de un objeto de outlets, un comando de texto es **un
   solo segmento**: `'/compras/requisiciones'` producía `panel:%2Fcompras%2Frequisiciones`, que no
   matchea nada — el panel no abría. El candado sobre el fuente jamás lo habría visto, porque en el
   fuente el enlace se ve perfecto.
2. **El único enlace relativo** (`[r.id]` en revisiones de caducidad) no resuelve contra el espejo
   aplanado; pasó a absoluto (`/almacen/inventory/caducidades/:id`).

Y dos más del mismo tipo que `[MT.1]`, en `comercial-inventory-sessions`: `[routerLink]` sobre el
`<tr>` y sobre un `<button>` — navegan, pero no son anclas.

**Cobertura.** `panel-routes.spec` **12/12** (incluye: los 4 destinos que cruzan de área
**resuelven** con un router real, no "figuran en una lista"; y que ninguna ruta real perdió su
guard). La prueba renderizada sube a **7**: el enlace lleva el outlet `panel`, y **sin el layout
montado cae a la navegación de siempre** en vez de romperse — *un enlace que no navega es peor que
uno que navega distinto*.

⚠️ Dos veces la prueba se equivocó antes que el código, y las dos quedaron anotadas en el spec:
indexar por camino daba falsos positivos (`almacen` tiene **dos** hijos con `path: 'anden'` y dos
con `path: ''`, legal: el router matchea el primero que calza), y buscar
`almacen/inventory/sessions/:id` como entrada plana fallaba porque cuelga del shell del área, cuyos
`children` el espejo copia por referencia.

---

## 3. Deuda declarada

- **`apps/vendor` tiene copiados los dos defectos**: las salidas al login sin destino
  (`auth.guard`, `permission.guard` ×2, `rider.guard`, `vendor.guard`) y el polling sin pausa.
  Fuera por el recorte «sólo en suite».
- **Los 11 gateways WebSocket no tienen tope de conexiones por usuario.** Con N ventanas son N
  sockets. No medido en prod.
- **El costo real por pestaña** sigue sin medirse en vivo → [MT.4].
