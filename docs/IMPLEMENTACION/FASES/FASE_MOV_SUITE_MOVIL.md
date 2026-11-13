# Fase MOV — La suite en el celular (iOS y Android)

> El método que la gobierna: [`docs/METODO_DE_TRABAJO.md`](../../METODO_DE_TRABAJO.md).
> **Propuesta, no abierta.** Hay 5 fases 🔨 contra un cupo de 4 (`node .claude/skills/pm/tablero.js`,
> 2026-11-13) y la Fase 0 (campaña de aterrizaje) sigue en curso. MOV no tiene fila en el roadmap de
> `CLAUDE.md` hasta que el PM la ratifique **y** haya cupo.

```
OBJETIVO: que quien trabaja de pie (surtido, piso de tienda, ruta, supervisión) haga su tarea
          desde el celular sin pelear con una pantalla de escritorio, en Android y en iPhone.
MÉTRICA:  pantallas de piso que pasan la compuerta de celular (390 px) —
          HOY: NO MEDIDO (la compuerta no existe: check:pantalla no fija viewport) → META: las N
          pantallas de MOV.0.2, todas en verde, para <fecha que fije el PM>.
          Métrica de contexto, medida: 32 de 147 usuarios activos (22 %) entraron por última vez
          desde un celular.
CAPA TOPE: C3
ÁREA:      Plataforma (consumidores: Almacén, Tiendas, Comercial)
DUEÑO:     <falta — lo nombra el PM>
ESTADO:    ⬜ propuesta
```

Con qué se midió: `pg-prod` (`system_identifier` 7688376744939610156), sólo lectura, rol `dev_ro`,
2026-11-13. `public.users.last_login_user_agent` y `last_login_at` (últimos 30 días);
`commercial.push_subscriptions.user_agent`.

---

## 1. Qué problema resuelve

**Una de cada cinco personas que usaron la suite el último mes entró desde el celular**, y la suite
está hecha para escritorio: de 459 componentes en `apps/view/src/app/modules`, sólo 41 archivos
tienen alguna regla de tamaño de pantalla.

| Hecho medido (2026-11-13) | Valor |
|---|---|
| Usuarios con login en los últimos 30 días | 147 |
| … cuyo último login fue desde Android | 26 |
| … cuyo último login fue desde iPhone/iPad | 6 |
| Suscripciones push registradas (todas las apps) | 5 (3 iOS, 1 Android, 1 otro) |
| App nativa | Sólo `apps/vendor`, **sólo Android** (`com.megadulces.vendedor`); falta `@capacitor/ios` |
| `capacitor.config.ts` versionado | **No** — sólo la copia generada en `android/app/src/main/assets/` |
| Compuerta de celular en `check:pantalla` | **No existe** (el script no fija viewport) |

**Quién entra desde el celular** (último login en 30 días, por `role_name`):

| Puesto | Desde celular | Activos |
|---|---:|---:|
| vendedor_ruta | 9 | 12 |
| surtidor | 7 | 9 |
| piso_tienda | 5 | 5 |
| supervisor_ventas | 3 | 4 |
| encargado_tienda | 3 | 9 |
| promotor_ruta | 1 | 4 |
| almacenista | 1 | 5 |
| repartidor | 1 | 1 |
| finanzas_operativo · superadmin | 1 c/u | 8 c/u |

El hallazgo que manda: **surtidor (7 de 9) y piso_tienda (5 de 5) no usan la app del vendedor, usan
la suite** — y la suite no está pensada para ellos en ese tamaño.

### Lo que esta medición NO dice (declarado)

- Es el **último** login por usuario, no cada sesión: quien alterna equipo cuenta sólo por el último.
- El user-agent no distingue **qué app** (suite, vendedor, portal) abrió la sesión: `login-core` es
  compartido. Para vendedor_ruta probablemente es `apps/vendor`; NO MEDIDO.
- No dice **qué rutas** se abren desde el celular. Eso es MOV.0.1.
- 1,072 usuarios no tienen user-agent registrado (nunca entraron desde que existe la columna, o son
  cuentas viejas); quedan fuera del universo.

---

## 2. Qué NO incluye

- **Toda la suite en celular.** Contabilidad, compras, finanzas y los tableros densos se quedan en
  escritorio. Se adapta sólo lo que se usa de pie (lista de MOV.0.2).
- **Venta sin internet en ruta**: eso es la fase **VR** (⏸️). MOV no toca el flujo de venta del
  vendedor; sólo lo lleva a iOS tal como está.
- **Reescribir en nativo** (Swift/Kotlin, React Native, Flutter). Se queda Angular + Capacitor/PWA.
- **Por regla del repo**: certificados de Apple/Google, llaves de firma y de push **nunca** van al
  repo (es público) ni a un runner propio de Actions (prohibido). CORS y credenciales no se tocan
  (regla 7).
- **Ningún cron** para avisos: el aviso push sale de un evento.

---

## 3. Las capas

### C0 · Dato — qué pantallas y quién

| # | Item | Estado | Verificado contra |
|---|---|---|---|
| MOV.0.1 | Medir **qué rutas** se abren desde celular, por puesto, en 14 días. Fuente a decidir (D1). | ⬜ | Testigo independiente: el log de acceso del Caddy en `md` para la misma ventana (rutas `/api/*` por user-agent) |
| MOV.0.2 | Lista cerrada de **pantallas de piso** (ruta, puesto, frecuencia), salida de MOV.0.1. Esa lista es la N de la métrica. | ⬜ | Se revisa con un encargado de cada área antes de cerrarla |

⛔ Sin MOV.0.2 no se diseña ninguna pantalla: la lista no se adivina.

### C1 · Dominio — primitivos compartidos (ADR-056)

| # | Item | Estado | Prueba que lo ejerce |
|---|---|---|---|
| MOV.1.1 | Primitivo «tabla → lista de tarjetas» bajo 640 px (master-detail a pantalla completa), en `libs/`, no por pantalla | ⬜ | Spec + una pantalla consumidora |
| MOV.1.2 | Shell móvil: menú inferior en lugar del panel lateral, zonas táctiles ≥ 44 px, `inputmode` numérico en cantidad y dinero | ⬜ | Spec + `check:pantalla` a 390 px |
| MOV.1.3 | Escáner con cámara como servicio único (web: `BarcodeDetector`; nativo: ML Kit) con la pistola como respaldo | ⬜ | Prueba con códigos reales del catálogo, en Android **y** iPhone |

### C2 · API

| # | Item | Estado | ¿Escribe? | Prueba contra base real |
|---|---|---|---|---|
| MOV.2.1 | Avisos push por **evento** (tarea en «Mi trabajo», pedido listo para surtir, firma pendiente), reusando `commercial.push_subscriptions` | ⬜ | sí | ⛔ Obligatoria, con el payload real de suscripción de un iPhone y un Android |
| MOV.2.2 | (Si D3 = sí) entrada con huella/cara: el token local sólo reabre una sesión ya iniciada con contraseña | ⬜ | sí | ⛔ Obligatoria |

### C3 · UI

| # | Item | Estado | `check:pantalla` antes → después |
|---|---|---|---|
| MOV.3.0 | **Compuerta**: `check:pantalla` corre también a 390×844 y falla con scroll horizontal o zona táctil < 44 px. Con su `:self` (prueba negativa). | ⬜ | Rota a propósito una vez, rojo verificado |
| MOV.3.1…N | Una fila por pantalla de MOV.0.2, en orden de frecuencia | ⬜ | NO MEDIDO → verde a 390 px |
| MOV.3.V | Vendedor en iOS: `@capacitor/ios`, `capacitor.config.ts` versionado, compilación en la nube (D2) | ⬜ | Probado en un iPhone físico, no sólo simulador |

⛔ Cargar la skill `diseno` **antes** de tocar el primer archivo. Las cinco preguntas por escrito por
pantalla. <500 ms por consulta.
⛔ **Antes del primer item C3:** sección «Observaciones de diseño UI — revisión del plan» al final de
este doc ([`auditoria-diseno` §9](../../../.claude/skills/auditoria-diseno/SKILL.md)).

---

### MOV.0.1 — primera lectura (2026-11-13)

`analytics.ui_usage` no guarda el dispositivo, pero sí el **puesto**. Para los puestos que entran
casi siempre desde el celular (piso de tienda 5 de 5, surtidor 7 de 9), lo que consumen en 30 días
es, en la práctica, lo que se usa en el celular. Rutas de API → pantalla:

| Puesto | Lo que más usa (días con uso de 30) | Pantalla |
|---|---|---|
| surtidor | `warehouse/presale-picking` (16 d), `reparto/surtido/waves/mine` (20 d), `users/me/work` (21 d) | `/almacen/surtir`, `/almacen/surtir-preventa`, `/almacen/surtir/ruta/:id`, «Mi trabajo» |
| piso_tienda | `store/live/snapshot`, `store/live/rhythm`, `users/me/work` (5 d: puesto nuevo) | Monitor en vivo, Ritmo del día, «Mi trabajo» |
| encargado_tienda | `store/arqueo/turnos` (31 d), `finance/expenses/proofs/mine` (31 d) | `/tienda/arqueo`, comprobantes de gasto |
| supervisor_ventas | `catalogs`, `commercial/orders`, `daily-captures` (22 d) | captura diaria (y la app del vendedor) |

⚠️ Universo: **por puesto, no por persona ni por dispositivo**; un encargado que usa el arqueo en
escritorio cuenta igual. Contraste pendiente contra el log del Caddy (D1) antes de cerrar MOV.0.2.

⛔ **Corrección del mismo día: los HITS no son visitas.** `store/labels/notices` lo llama la
**campana de notificaciones** por poll (`notifications-bell.component.ts`), no la pantalla de
Etiquetas: «piso y encargado usan Etiquetas» **no está medido**. `store/arqueo/turnos` también es
un poll (cada 45 s), pero sólo corre con el Arqueo abierto, así que sus **días con uso** sí son uso.
Regla para leer `ui_usage`: **días con uso, no hits**, y antes de atribuir una ruta a una
pantalla, `grep` de quién la llama.

⛔⛔ **Segunda corrección del mismo día: `ui_usage` NO sirve para la barra del celular.** El primer
reordenamiento (commit `ee0413ca3`) puso el **Arqueo** primero en Tienda por sus 31 de 31 días en
`ui_usage`, y la barra sólo existe en el celular. Medido después por dispositivo: el Arqueo se
abre **9 persona-días en celular contra 685 en computadora**; «Ritmo del día», que entró 3º, **1**.
Lo que el mismo universo usa en el celular es el Verificador y el Monitor en vivo (22 cada uno).

**El instrumento correcto ya existía:** `commercial.portal_telemetry_events` (la escribe
`UsoService` de `apps/view`) guarda **ruta + user agent + usuario** en cada muestra de
`web_vital` y en cada `abrio_puerta`. Es la fuente de D1, sin tabla ni log nuevo. Script:
`node .claude/skills/pm/uso-movil.js '^/tienda/'` (sólo lectura, verifica `system_identifier`; en Git Bash con `MSYS_NO_PATHCONV=1`).
⚠️ Lo que no mide: `web_vital` se manda al cargar la página y al ocultarla, así que cuenta la
pantalla donde se **entró o se dejó** la app, no cada navegación interna; `abrio_puerta` lleva la
ruta de la landing (`/projects`), no la del destino. Es una cota inferior del uso, no un conteo.

**Lo que se abre desde celular** (persona-días en 30 días, al 2026-11-13; 64 personas, 354
persona-días en celular contra 2,169 en computadora):

| Pantalla | Celular | Personas | Computadora | Puestos en celular |
|---|---:|---:|---:|---|
| `/finanzas/gastos` (captura) | 106 | 14 | 244 | 10 puestos: encargados, cajero, vendedor, promotor, supervisor, finanzas… |
| `/finanzas/mis-gastos` | 72 | 16 | 282 | los mismos |
| `/almacen/surtir` | 45 | 11 | 40 | surtidor (8 personas) |
| `/finanzas/egresos` | 25 | 7 | 68 | dirección, finanzas |
| `/tienda/verificador` | 22 | 8 | 87 | piso, encargado, cajero |
| `/tienda/live` | 22 | 13 | 71 | dirección, encargado, piso |
| `/tienda/arqueo` | 9 | 7 | **685** | — es trabajo de computadora |

**Barra aplicada (medida en celular):**
- **Tienda:** Verificador · Monitor en vivo · Arqueo · Lista de faltantes. Faltantes empata a 4
  con Sucursales, Caducidades y Etiquetas; gana por ser la captura de piso, y es de las pocas que
  se usan más en celular que en computadora. Caja (práctica) y Ritmo del día, 1 cada una, a «Más».
- **Finanzas:** Gastos · Libros contables · Caja · Pagos. Gastos era el **8º** del menú: quien
  firma o revisa lo tenía detrás de «Más».
- **Almacén:** sin cambio (las áreas que ve el surtidor caben).

⭐ **El hallazgo que no resuelve la barra:** Gastos es la pantalla nº 1 en celular de **diez
puestos**, y la barra es **por área**. Un encargado parado en Tienda no la tiene a la mano: tiene
que volver a `/projects` y entrar a Finanzas. Es el argumento medido para D7 (destinos por puesto,
no por área): «capturar un gasto» debería estar en la barra de quien lo hace, en el área que sea.

### MOV.3.B — Barra inferior: las cinco preguntas (propuesta, sin código)

> ⛔ **La premisa de esta propuesta cayó el mismo día (2026-11-13).** Decía «hoy, en celular, la
> suite sólo tiene el menú hamburguesa». **Falso:** el layout tiene barra inferior desde mayo de
> 2026 (`useBottomNav` / `bottomNavItems` en `layout.component.ts`): en celular muestra los
> **primeros 4 ítems del menú del área** + «Más» (abre el cajón entero), con `safe-bottom` y
> objetivos de 56 px. Se encontró al ir a construirla; el error fue diagnosticar contando
> menciones en el código en vez de leer el layout.
>
> **Lo que queda del trabajo:** no es construir la barra, es **elegir sus 4 lugares por uso** y no
> por el orden del menú. Falta medir qué ve hoy cada puesto en esos 4 lugares (depende de su
> permiso y del área; en Almacén los ítems salen de las áreas WMS que alcanza). Ya se corrigió una
> cosa: la etiqueta bajaba a 10 px (`--fs-nano`, «último recurso») y subió a 12 px (`--fs-xs`).
> Las cinco preguntas de abajo siguen valiendo para esa reordenación.

| # | Pregunta | Respuesta |
|---|---|---|
| 1 | ¿Qué ve al entrar y en qué orden? | Cuatro destinos fijos abajo: **Mi trabajo · [pantalla 1 del puesto] · [pantalla 2 del puesto] · Menú**. El activo resaltado con `--action` |
| 2 | ¿Qué NO ve? | Ni búsqueda (la suite no tiene buscador global: inventarla aquí sería un primitivo de fase, ADR-056), ni contadores que no sean trabajo pendiente, ni la barra en escritorio |
| 3 | ¿Qué accesibilidad necesita? | A **un** toque la pantalla diaria del puesto. Objetivos de 48 px, nombre visible bajo el icono (no sólo el icono), `nav` con `aria-label`, `aria-current="page"` en el activo, `env(safe-area-inset-bottom)` |
| 4 | ¿Está ligada a otro proceso? | Sí: «Mi trabajo» ya es la bandeja por responsabilidad; su conteo pendiente va en la barra. Los destinos salen de la **misma** definición del menú lateral filtrada por permiso: un destino sin permiso no aparece |
| 5 | ¿Este proceso la debe ver? | Sólo en celular (`isMobile()` del layout, que ya existe) y sólo en el marco de la app; las pantallas fuera del marco (`/captura/:token`, `/levantamiento`) no la llevan |

**Los destinos por puesto** salen de la tabla de arriba, no de una opinión:

| Puesto | 2º | 3º |
|---|---|---|
| surtidor | Surtir | Revisión de pedidos |
| piso_tienda | Verificador | Lista de faltantes |
| encargado_tienda | Gastos | Verificador |
| cualquier otro | las dos entradas del menú que más abrió (si no hay dato: sólo Mi trabajo y Menú) | |

```
┌──────────────────────────────────────┐
│  (pantalla)                          │
│                                      │
├──────────────────────────────────────┤
│   ▣ 3       ⇣         ▤         ☰    │
│ Mi trabajo Surtir   Preventa   Menú  │
└──────────────────────────────────────┘
      └── safe-area del iPhone ──┘
```

**Se conserva:** el cajón lateral entero detrás de «Menú» (nada se pierde). **Cambia:** en celular,
la hamburguesa de arriba desaparece; su lugar es «Menú» abajo.

## 4. Decisiones a firmar

| # | Decisión | Opciones | Recomendación |
|---|---|---|---|
| D1 | De dónde sale MOV.0.1 | a) log del Caddy en `md` · b) una tabla de telemetría nueva en la suite · c) ambas | **a)** No crea tabla ni escritura nueva y ya existe; se contrasta con `last_login_user_agent`. Sólo si el log no trae user-agent, se pasa a b). ⭐ **2026-11-13: la b) ya existía** — `commercial.portal_telemetry_events` guarda ruta + user agent + usuario (ver MOV.0.1); el log del Caddy queda como testigo independiente |
| D2 | Cómo se compila iOS | a) Xcode Cloud · b) Codemagic · c) una Mac física de la empresa | **b) Codemagic**: compila Android e iOS desde el mismo lugar, los certificados viven en su bóveda (no en el repo público) y no exige runner propio. Costo a confirmar. |
| D3 | Huella/cara para entrar | sí / no / después | **Después**: primero que las pantallas sirvan; es comodidad, no bloquea a nadie. |
| D4 | ¿La suite se vuelve app nativa o sigue PWA? | a) PWA · b) Capacitor como el vendedor | **a) PWA** mientras los avisos y el escáner funcionen en ambos sistemas desde el navegador; se reabre sólo si iOS los bloquea (iOS sólo da push web a una PWA instalada en la pantalla de inicio). |
| D5 | Cuenta Apple Developer (99 USD/año) y a nombre de quién | — | **Es del PM**: dinero y titularidad de la empresa. Sin ella no hay vendedor en iOS. Alternativa sin costo: vendedor como PWA instalada en iPhone; se pierde el GPS en segundo plano |
| D6 | Barra inferior en celular (MOV.3.B) — **ya existe**; la decisión es cómo se eligen sus 4 lugares | a) por uso medido del puesto · b) como hoy (orden del menú) | **a)**, tomada por Claude el 2026-11-13 (decisión de diseño); falta medir qué ve cada puesto hoy antes de tocar el orden |
| D7 | Destinos fijos por puesto o elegidos por la persona | a) fijos (tabla de arriba) · b) que cada quien fije los suyos | **a) fijos** para empezar: la persona de piso no va a configurar nada; se reabre si piden cambiar |

---

## 5. Riesgos y bloqueos

| Bloqueo | Dueño | Causa | Qué lo destraba |
|---|---|---|---|
| Sin cupo | Edgar (PM) | 5 fases 🔨 contra tope de 4 | Cerrar o pausar una; MOV.0.1 (sólo medir) puede ir antes sin abrir la fase |
| Cuenta de Apple | Edgar (PM) | D5 | Alta de la cuenta a nombre de la empresa |
| Revisión de Apple al GPS en segundo plano | Dueño de MOV.3.V | `@capacitor-community/background-geolocation` es lo que Apple más rechaza | Texto de uso claro en `Info.plist` y justificación de negocio en la ficha |
| Push web en iPhone | Dueño de MOV.2.1 | iOS sólo lo permite a una PWA instalada en la pantalla de inicio | Instrucción de instalación en el shell móvil; si no basta, D4 → b) |

---

## 6. Definición de Terminado

- [ ] 1. Métrica de la cabecera **remedida**, antes/después publicado
- [ ] 2. Cada capa verificada **o declarada NO MEDIDA** (ADR-056)
- [ ] 3. Todo endpoint que escribe **ejercido contra base real** con el payload de la pantalla
- [ ] 4. Toda compuerta nueva **rota a propósito una vez**, rojo verificado (MOV.3.0)
- [ ] 5. Todo primitivo genérico en `libs/` compartido **o** deuda con nombre en el tracker (MOV.1.x)
- [ ] 6. Tracker + `03_LOG_REVISIONES.md` + roadmap de `CLAUDE.md` al día
- [ ] 7. **En prod**, o escrito por qué no y qué falta

---

## 7. Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
| 2026-11-13 | Propuesta escrita. HOY medido en `pg-prod`: 32 de 147 usuarios activos con último login desde celular; surtido y piso de tienda son los que más lo usan. Queda ⬜ por cupo. | Claude, a pedido de Edgar |
| 2026-11-13 | Base global de celular, sin abrir la fase (CSS compartido, no pantallas), a pedido de Edgar: la suite **permite zoom**; campos a 16 px en táctil también para `.p-inputtext`; `overscroll-behavior: contain` en diálogos, cajones, listas y `side-peek`; todo `p-dialog` a todo el ancho bajo 40rem. Sección «Celular y toque» (M.1–M.8) en la skill `diseno`, tomada de las guías de Vercel **sin instalar su skill**. Se sacaron 6 pantallas vencidas de la deuda de `check:tables`. **Sin validación visual en celular** y presupuesto de bundle de `view` NO MEDIDO (lo dice el CI). Pendiente fuera de alcance: la tabla de `comercial-monitoreo-vecinal` (12 columnas, filas desplegables) para su dueño. | Claude, a pedido de Edgar |
| 2026-11-13 | Barra inferior por uso medido (`movil` en `NavItem`): en Tienda entra el Arqueo. **Surtidor revisado, sin cambio**: aterriza en Almacén (`/almacen/surtir`), no en Reparto, y con sus permisos sólo alcanza dos áreas —Ubicaciones y Pedidos (→ Surtir)—, las dos caben en la barra. Lo que usa en 30 días (`ui_usage`, por días): sus olas de surtido 20, surtido de preventa 16, existencia y ubicaciones 12. | Claude, a pedido de Edgar |
| 2026-11-13 | ⛔ **Corrección de la barra de Tienda empujada horas antes**: se había ordenado con `ui_usage`, que no distingue dispositivo; medida en celular con `commercial.portal_telemetry_events`, el Arqueo es trabajo de computadora (9 contra 685 persona-días). Tienda queda Verificador · Monitor en vivo · Arqueo · Faltantes; Finanzas, Gastos · Libros contables · Caja · Pagos (Gastos era el 8º y es la pantalla nº 1 en celular de diez puestos). D1 resuelta en los hechos: la telemetría con user agent ya existía. Spec 5/5. **Sin validación visual en celular.** | Claude, a pedido de Edgar |
