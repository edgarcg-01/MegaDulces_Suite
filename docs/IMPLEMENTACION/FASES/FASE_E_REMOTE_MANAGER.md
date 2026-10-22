# Fase E — Remote Manager (Televenta)

**Duración estimada MVP:** 3-4 días (1 dev).
**Objetivo:** dar a operadores de call center un workflow para llamar a clientes priorizados, ver su contexto comercial completo, tomar pedidos en su nombre y registrar resultado de cada llamada.

> **Decisión de scope 2026-05-27 (Edgar)**: MVP delgado.
> - **Solo workflow** (sin telefonía Twilio/Vonage). El operador usa su teléfono físico.
> - **Pool compartido autoservicio**: el operador entra, ve cola priorizada, toma un lead, lo trabaja, lo cierra. Sin asignación automática ni cartera fija.
> - **MVP no incluye dashboard de métricas** (E.2 del stub original). Las stats se construyen sobre `call_logs` cuando se necesite.
> - **Cartera scoped**: el operador ve solo SUS reservas activas + el pool sin reservar.

---

## Pre-requisitos

- ✅ Fase B cerrada (orders + customers operativos).
- ✅ Fase D.4 cerrada (`commercial.recommended_baskets` con categoría `inactive` que usaremos para priorizar).
- ✅ Socket.IO `/alerts` namespace funcionando (para notifs realtime opcionales).

---

## Decisiones técnicas

### Schema

Schema `commercial.*` extendido con 2 tablas nuevas:

#### `commercial.lead_reservations`
Quien tomó qué cliente del pool y por cuánto tiempo (TTL).
- `(tenant_id, id)` composite FK.
- `customer_id` UUID FK a `commercial.customers(tenant_id, id)`.
- `reserved_by_user_id` UUID FK a `public.users(tenant_id, id)`.
- `reserved_at` TIMESTAMPTZ NOT NULL DEFAULT NOW().
- `expires_at` TIMESTAMPTZ NOT NULL (default `NOW() + interval '30 minutes'`).
- `released_at` TIMESTAMPTZ NULL (NULL = activa).
- `released_reason` TEXT NULL (`completed`/`released_manual`/`expired`).
- Constraint: UNIQUE PARTIAL `(tenant_id, customer_id) WHERE released_at IS NULL` — solo una reserva activa por cliente.
- RLS forzado.

#### `commercial.call_logs`
Registro de cada llamada (resultado).
- `(tenant_id, id)` composite FK.
- `customer_id`, `user_id` (operador), `called_at`, `outcome` enum, `notes` TEXT.
- `outcome` valores: `sale`, `no_sale`, `callback_scheduled`, `no_answer`, `wrong_contact`, `other`.
- `next_action_at` TIMESTAMPTZ NULL (cuando outcome=`callback_scheduled`).
- `order_id` UUID NULL FK a `commercial.orders(tenant_id, id)` — link al pedido si outcome=`sale`.
- `duration_minutes` SMALLINT NULL.
- RLS forzado.

### Cola priorizada (algoritmo simple)

`GET /commercial/televenta/queue` devuelve customers ordenados por:
1. Status `inactive_critical` (sin pedido en >60 días).
2. VIP sin pedido en >30 días (top 20% por revenue 6m).
3. Customers en `recommended_baskets.category_counts.inactive > 0`.
4. Customers nuevos sin orders aún.
5. El resto, ordenados por `last_contact_at DESC NULLS FIRST`.

Excluye los que ya tienen reserva activa de OTRO operador.

### Permisos + rol nuevo

- `COMMERCIAL_TELEVENTA_OPERATE` — operar la cola (reserve/release/log).
- `COMMERCIAL_TELEVENTA_VER` — solo lectura (supervisor).
- Rol `tele_operator` agregado a `role_permissions` con permisos:
  - `COMMERCIAL_TELEVENTA_OPERATE`
  - `COMMERCIAL_ORDERS_CREAR` (puede tomar pedidos)
  - `COMMERCIAL_CUSTOMERS_VER`
  - `COMMERCIAL_PRICING_VER`
  - `COMMERCIAL_INVENTORY_VER`
  - `COMMERCIAL_RECOMMENDATIONS_VER`

### Frontend

Nuevo proyecto `/televenta` (no en `/dashboard` ni `/comercial`) listado en `/projects` cuando el user tiene `COMMERCIAL_TELEVENTA_OPERATE`.

Páginas:
- `/televenta` — cola priorizada + reservas activas del operador + botón "Tomar siguiente".
- `/televenta/lead/:customer_id` — snapshot del cliente: perfil + últimos 5 pedidos + recomendaciones + historial de llamadas + 2 botones: "Tomar pedido" y "Registrar resultado de la llamada".
- `/televenta/lead/:customer_id/take-order` — flujo de toma de pedido (reusa lógica de vendor-take-order si fuera posible).

---

## Sprints

### Sprint E.0 — Schema + permisos + rol ⬜

| ID | Item | Estado |
|---|---|---|
| E.0.1 | Migración `commercial_televenta_schema`: tablas `lead_reservations` + `call_logs` con composite FK, RLS, grants `app_runtime`, índices, partial unique constraint en reservations activas. | ⬜ |
| E.0.2 | Permisos `COMMERCIAL_TELEVENTA_OPERATE` + `COMMERCIAL_TELEVENTA_VER` en `permissions.ts` (back+front). | ⬜ |
| E.0.3 | Seed `commercial_roles_televenta`: agregar rol `tele_operator` en `role_permissions` con permisos definidos. | ⬜ |
| E.0.4 | Smoke RLS: 2 tenants, reserva de uno no visible para el otro. | ⬜ |

### Sprint E.1 — Backend `commercial-televenta` ⬜

| ID | Item | Estado |
|---|---|---|
| E.1.1 | `CommercialTeleventaService` con: `getQueue()` (algoritmo priorizado, excluye reservas ajenas), `reserveLead(customer_id, user_id, ttl=30m)`, `releaseLead(reservation_id, reason)`, `getCustomerSnapshot(customer_id)`, `logCall(payload)`, `getMyReservations(user_id)`, `getCustomerCallHistory(customer_id)`. | ⬜ |
| E.1.2 | `CommercialTeleventaController` endpoints: `GET /queue`, `GET /my-reservations`, `POST /leads/:customer_id/reserve`, `POST /leads/:reservation_id/release`, `GET /customers/:id/snapshot`, `GET /customers/:id/calls`, `POST /calls`. Guards: `RequireAuthGuard + RolesGuard + RequirePermissions`. | ⬜ |
| E.1.3 | `TeleventaCronService` con `@Cron('*/5 * * * *')`: libera reservas con `expires_at < NOW() AND released_at IS NULL` (sets released_reason='expired'). | ⬜ |
| E.1.4 | Wirear `CommercialTeleventaModule` en AppModule dentro del toggle `ENABLE_MULTITENANT`. | ⬜ |
| E.1.5 | HTTP smoke `database/http-televenta-test.js`: login tele_operator → queue → reserve → snapshot → log call (sale + order) → release → verify state. | ⬜ |

### Sprint E.2 — Frontend `/televenta` ⬜

| ID | Item | Estado |
|---|---|---|
| E.2.1 | Permission enum frontend sync (COMMERCIAL_TELEVENTA_*). Card "Televenta" en `/projects` landing visible cuando perms. | ⬜ |
| E.2.2 | `TeleventaShellComponent` standalone con header + nav (Cola, Mis activos, Logout). | ⬜ |
| E.2.3 | `TeleventaQueueComponent` (`/televenta`): tabla cola priorizada + tag de razón (inactivo/VIP/nuevo) + botón "Tomar". Sección "Mis reservas activas" con TTL restante. | ⬜ |
| E.2.4 | `TeleventaLeadDetailComponent` (`/televenta/lead/:id`): snapshot del cliente (info contacto + últimos pedidos + recomendaciones + llamadas previas). Botones "Tomar pedido" y "Registrar llamada" (modal con outcome + notes + next_action). | ⬜ |
| E.2.5 | `TeleventaTakeOrderComponent` (`/televenta/lead/:id/take-order`): reusa lógica del vendor-take-order con catalog del customer. Al confirmar order, opcionalmente registra call_log con outcome=sale + order_id linkeado. | ⬜ |
| E.2.6 | `televentaGuard` enforce rol con permiso `COMMERCIAL_TELEVENTA_OPERATE`. Lazy-loaded en `app.routes.ts`. | ⬜ |
| E.2.7 | `nx build view` OK. | ⬜ |

### Sprint E.3 — Verificación + cierre ⬜

| ID | Item | Estado |
|---|---|---|
| E.3.1 | Agregar `http-televenta-test.js` a `database/run-all-tests.js`. | ⬜ |
| E.3.2 | Validación visual manual (Edgar): login `tele_operator` → cola → tomar lead → snapshot → tomar pedido → registrar resultado. | ⬜ |
| E.3.3 | Entry de cierre en `03_LOG_REVISIONES.md` con métricas y aprendizajes. | ⬜ |

---

## Deferred post-MVP

- **E.4 — Métricas + dashboard productividad**: calls/día por operador, conversion rate, AOV, ticket promedio. Reusa data en `call_logs`.
- **E.5 — Telefonía integrada (Twilio Voice)**: click-to-call + grabación + callbar. Requiere ADR-013 nuevo + cuenta Twilio.
- **E.6 — Asignación inteligente**: round-robin automática o ML-driven (best-fit operador↔cliente).
- **E.7 — Handoff WhatsApp**: cuando Fase F esté online, botón "enviar promo por WhatsApp" desde el snapshot del cliente.
- **E.8 — Recordatorios callback**: cron diario que notifica al operador (via Socket.IO `/alerts`) sus callbacks programados del día.

---

## Riesgos

| Riesgo | Mitigación |
|---|---|
| Reservas zombie (operador cierra browser sin release) | Cron @5min limpia expired. TTL 30 min suficiente para una llamada normal. |
| Dos operadores compiten por mismo lead | UNIQUE PARTIAL constraint en DB previene race; backend retorna 409 en el segundo. |
| Operador genera pedido pero no registra call_log | `take-order` confirm puede auto-loguear con outcome=sale + order_id. Aceptable que algunos calls queden sin log si el operador descarta. |
| Cola vacía (raro) | UI muestra empty state "Todos los clientes están al día — chequeá callbacks programados". |
| Cliente bloqueado por crédito intenta pedido | OrdersService ya valida `credit_limit` y rebota — el operador ve el error y registra llamada con outcome=no_sale + notes. |

## E.9 — el tablero ve la facturación del canal, y el módulo se llama Telemarketing (2026-09-07)

Disparador: *"hay que cambiar /televenta/dashboard para que ahí también se vean las facturas, y ordenemos este módulo para telemarketing"*.

### Lo que la auditoría encontró antes de tocar nada

Medido en prod:

- **`commercial.call_logs` está VACÍA: 0 llamadas.** Todo el tablero (llamadas, minutos, conversión, top operadores, outcomes 7d) publicaba **ceros**. El módulo nunca se usó.
- **La cola de leads apunta al universo equivocado:** sale de `commercial.customers`, que son 412 clientes con código `V-…` captados por vendedores en campo. **0 de 412 empatan** con los clientes que telemarketing factura de verdad (206 códigos del ERP).
- **La operación real existe y sólo vive en el ERP:** 4 operadores (30003 Daniel Francisco Franco, 10002 Sergio Mendoza, 10001 Cinthia del Valle, 30004 José Ramón Rodríguez), **732 facturas y $8,243,050 en 30 días**, con **$2,340,863 vencidos por cobrar**.
- **No hay puente operador↔usuario:** `identity.users` no tiene `vendedor_code` (sólo `route_id`), así que la factura se atribuye por el vendedor del ERP y **no** se puede cruzar con quien registre la llamada.
- **El rol en prod ya se llama `telemarketing`** (no `televenta`) y los 3 roles con acceso al módulo (direccion, superadmin, telemarketing) **ya tienen `COMMERCIAL_SALES_DOCS_VER`**: el enlace a facturación funciona sin repartir permisos nuevos.

### Qué se hizo

- **Facturación real en el tablero** (`billing` en `GET /commercial/televenta/dashboard`): hoy / mes / 30 días, cobrado, **vencido por cobrar**, desglose **por operador** del ERP y las **últimas 8 facturas** con su estado de cobro. Sale de `analytics.erp_sales_invoices` — la misma vista en vivo que consume `/comercial/documentos`, sin copiar nada.
- **Va primero en la pantalla**, antes de la actividad: es lo que existe todos los días.
- **La actividad se declara**: si `call_logs` no tiene registros, el tablero dice *"no hay llamadas capturadas en este módulo"* en vez de pintar 0% de conversión como si fuera un resultado (ADR-056). La facturación no depende de esa captura y se dice.
- **Nombre unificado a Telemarketing** en lo visible: encabezado, marca del shell, nav ("Dashboard" → "Resumen", + "Facturación"), labels de los dos permisos y su categoría, nodo de `authz-tree`, preset de rol, selector de proyectos. Los nombres de clase/archivo siguen diciendo `televenta`: renombrarlos es churn sin nada visible.
- El enlace a Facturación va **gateado por `COMMERCIAL_SALES_DOCS_VER`**: un enlace que lleva a un rechazo del guard es peor que no mostrarlo.
- ⚠️ Cada consulta del bloque va con su selección **materializada antes de ordenar/recortar**: sobre esta vista un `ORDER BY … LIMIT` directo dispara el nested loop de AX.9 (23,856 ms vs 970 ms).

Smoke `test-newdb-telemarketing-billing.js` **9/9 contra prod** (incluye que la facturación cuadre al peso con `/comercial/documentos` y la prueba negativa del puente inexistente). Builds api y view verdes. El bloque responde en **1,096 ms**.

### E.9.1 — la ruta también (2026-09-07)

Disparador: *"cambiemos la ruta a telemarketing"* — se revierte la decisión de dejar `/televenta` como URL.

- **La ruta canónica es `/telemarketing/*`.** `/televenta/*` queda como **redirect** (sin componente: dos componentes montados en dos URLs serían dos copias de la misma pantalla, no un redirect). El `**` reconstruye los segmentos, así que un marcador de `/televenta/lead/123/take-order` aterriza en `/telemarketing/lead/123/take-order`.
- Se actualizaron las 8 navegaciones internas del módulo (shell + 4 páginas), el nodo de `authz-tree` y el selector de proyectos. Los IDs (`id: 'televenta'`), la clave del área en `role-presets`, los nombres de clase/archivo y **las claves de permiso** siguen igual: las últimas dos viven en `role_permissions` / `area_role_presets` de la DB y renombrarlas silenciaría accesos.
- **El endpoint de la API sigue siendo `/api/commercial/televenta/*`** — no lo ve nadie y renombrarlo abre una ventana de 404 entre el deploy de api y el de view. Si se quiere, se hace con alias (`@Controller(['commercial/telemarketing','commercial/televenta'])`) y sin prisa.

**Gate `apps/view/src/app/telemarketing-route.spec.ts` (11/11).** Prueba el patrón con el Router real (los segmentos profundos, la raíz sin barra colgando, los query params) **más su prueba negativa** (sin el bloque legacy la URL vieja no resuelve), y ata el espejo a la config real leyendo `app.routes.ts`.

Dos cosas que el gate encontró y que no se veían a ojo:

1. **Un `redirectTo` funcional que devuelve string TIRA los query params** — el estático sí los conserva. Asimetría no documentada; el redirect devuelve `UrlTree` armado con `createUrlTree({ queryParams, fragment })`.
2. **El entorno de jest de `apps/view` nunca se inicializaba.** `test-setup.ts` hacía `import 'jest-preset-angular/setup-env/zone'`, pero ese módulo **exporta** `setupZoneTestEnv` en vez de ejecutarlo: cualquier spec con TestBed moría en *"Need to call TestBed.initTestEnvironment() first"*. Nadie lo notó porque ningún spec de la app usaba TestBed (el único con esa forma son 3 `it.todo` que declaran deuda). Arreglado en 2 líneas; la suite completa de view queda **6 suites / 66 tests verde**.

### Lo que sigue abierto (decisión de Edgar, 2026-09-07)

- ⬜ **E.10 — re-apuntar la cola al ERP.** Hoy prioriza 412 clientes de campo que no son de telemarketing; debería trabajar los 206 reales, ordenados por su historial de facturación (última factura, saldo, días sin comprar). Es el trabajo que hace que el módulo sirva para operar, no sólo para mirar. Se pospuso a propósito para entregar la facturación primero.
- ⬜ **E.11 — puente operador↔usuario.** Sin un `vendedor_code` en `identity.users` no hay forma de medir a un operador de punta a punta (sus llamadas y sus facturas). Mientras no exista, el tablero muestra dos atribuciones distintas y lo dice.
- ✅ ~~Los bloques de actividad siguen en el tablero aunque publiquen ceros~~ → resuelto en **E.14** (abajo): sin captura ya no se pintan.

## E.14 — auditoría de `/telemarketing/dashboard`: cinco cosas que la pantalla afirmaba y no eran (2026-10-21)

Disparador: *"auditemos /telemarketing/dashboard"* → *"resolvamos estos hallazgos"*. Auditoría con la skill `auditoria-diseno`, nivel **B** (prod en sólo lectura, `system_identifier 7688376744939610156`) + **C** (fuente). ⛔ **Nivel A no**: la pantalla no se midió viva.

### Lo que se encontró, medido

| # | Qué afirmaba | Qué era | Cruce |
|---|---|---|---|
| 1 | «Cola **priorizada** · próximos a llamar» | consulta propia con `.limit(5)` **sin `ORDER BY`**: los 5 primeros en orden físico. Los 5 de ese día: **ninguno con teléfono ni pedidos**. La cola real (`getQueue`) sí ordena por motivo | 2 — rótulo |
| 2 | la cola como «los clientes del canal» | sale de `commercial.customers` (1,858 activos, 211 con teléfono). De los **317 clientes facturados en 30 días, 11 están en ella**; los otros 307 pares cliente/sucursal **no existen** en el padrón (ni inactivos). Llave `erp_customer_code + erp_source_branch`, verificada por nombre: **11 de 11 iguales** | 5 — universo |
| 3 | 8 indicadores de actividad + «0.0% conversión» | `commercial.call_logs` = **0 filas en toda la historia**. El aviso lo decía y debajo se dibujaban los ceros igual | ADR-056 |
| 4 | etiquetas de «Outcomes» | el mapa esperaba `pedido_tomado`, `no_contesto`…; el backend manda `sale`, `no_sale`… → una venta se habría pintado **«sale» en amarillo**. La ficha del cliente tenía el mapa bueno: dos copias que divergieron | 2 — rótulo |
| 5 | «Vencido por cobrar» **$3,725,351.90** | sólo facturas **emitidas** en 30 días. Faltaban **$2,827,229.04 de 696 facturas** más viejas: el número cubría el **57 %** de **$6,552,580.94** | 3 — contenedor |
| 6 | sin `LoadState` ni frescura | primer error = pantalla vacía con un toast; error al recargar = dato viejo sin aviso | §2 · §9 |

### Qué se hizo

- **La vista previa de la cola ES `getQueue(5)`**: mismo orden, misma exclusión de reservas, mismo «último pedido» (antes `confirmed_at` aquí y `created_at` allá).
- **La cola declara su universo**: *«de los 317 clientes facturados en 30 días, 11 están en ella»* (`billing.clientes_en_cola`, en vivo). El arreglo de fondo sigue siendo **E.10** (abajo), que no se hizo aquí.
- **Sin captura de llamadas no se pinta actividad**: sólo el aviso. Con captura, la conversión sin llamadas se declara `no_medido` («sin llamadas hoy»), no 0 %.
- **Un solo mapa de resultados** (`modules/televenta/call-outcomes.ts`), tipado como `Record<CallOutcome, …>`: si el backend suma un resultado, deja de compilar. Lo usan tablero y ficha.
- **«Vencido · toda la cartera»** ($6.55M, 1,245 facturas) con el de 30 días en el subtítulo. «Cobrado 30d» pasa a **«Ya cobrado»** *«N % de lo facturado en 30 días»*: era importe − saldo de lo emitido, no el dinero que entró en esos días. Cada cifra dice su ventana; la sección deja de decir «últimos 30 días» porque ya no es cierto para todas.
- `LoadState` (cargando / error con Reintentar), `FreshnessPill measures="fetch"`, sin emoji en «Cola al día 🎉» (que además era falso: vacía = todos reservados), «Reservas activas» deja de ir siempre en amarillo, rótulos en español, una sola forma de fecha, tokens canónicos (`--radius-md` era dialecto fantasma).

### Costo medido (regla 15)

El vencido de toda la cartera obliga a evaluar `analytics.erp_receivable_doc()` sobre la historia entera del canal (~5,200 facturas). Medido en prod, 3 corridas: consulta de totales **≈ 100 ms → ≈ 390 ms**. Para no pagarlo en serie, **cola, facturación y actividad corren en paralelo**, cada una en su transacción (sobre un solo `trx` se encolan y el tiempo es la suma: 670 ms medidos). La facturación pasa de ~380 ms en serie a ≈ 390 ms (la más lenta). ⛔ Se descartó prefiltrar por `c43` (estatus del ERP): **3,371 facturas pagadas siguen en `N`** y hay 6 en `F` con saldo — borraría deuda real.

### Verificación

- `test-newdb-telemarketing-billing.js` **14/14** dentro del pod `api`, como `app_runtime` con RLS (el cruce con el padrón da 11 también bajo RLS, no 0). Bloque nuevo: el vencido del canal cuadra al centavo con una consulta **independiente** sin el atajo del `OR`, y la llave del padrón se verifica por nombre.
- **Prueba negativa**: quitando la deuda vieja del barrido, el candado se pone rojo con exactamente el defecto original (`tablero=3725351.90/549 independiente=6552580.94/1245`).
- `ngc --noEmit` sobre `apps/view` con control (`{{ metodoQueNoExisteControl() }}` → TS2339, el **único** error de la app); `check:pantalla -- televenta` 0 nuevas y el tablero sale de la deuda §2/§9; `check:templates`, `check:estilos`, `check-css-tokens --todo`, `sin emojis`, `lint:boundary` verdes.
- ⛔ **No verificado**: el backend no se tipó localmente (lo tipa el CI) · **sin validación visual** (lo más probable de ajustar: el aviso de universo dentro de la tarjeta de la cola y el ancho de la tira de 4 cifras).

### Lo que sigue abierto

- ⬜ **E.10 — re-apuntar la cola al ERP**, re-medido el 2026-10-21: el padrón creció de 412 a 1,858 clientes (1,300 importados `K0…`) y **sigue sin cubrir el canal: 11 de 317**. Y la prioridad lee `commercial.orders` (52 pedidos), así que **1,786 de 1,858 salen «nunca pidió»** aunque compren por el ERP.
- ⬜ `ONLINE` (125 facturas en 30 días) cuenta como **un** cliente en «Clientes». No se tocó: no se midió qué es.

## E.15 — el descuento del canal, desglosado (y una segunda auditoría de diseño) (2026-10-21)

Disparador: *"desglosemos los descuentos y auditemos el diseño con /auditoria-diseno"*. Evidencia: nivel **B** (prod, sólo lectura) + **C**. ⛔ **Nivel A no**: el navegador no tenía sesión y el cambio no está desplegado.

### De dónde sale el descuento (no se adivinó)

Se usó la regla que ya existía —**Fase TK, `TK.13`**— y el decode de [`ERP_KEPLER.md` §2.6](../../ERP_KEPLER.md): son **dos** descuentos independientes, medidos como diferencias.

```
  precio de lista       Σ kdm2.c66 × cantidad   (c66 > 0; si no, lo cobrado)
− descuento de producto Σ (c66 − c12) × cantidad, nunca negativo
= subtotal              Σ kdm2.c13 (importe del renglón)
− descuento de cliente  subtotal − kdm1.c16     (el % negociado, kdud.c17 → kdm1.c19)
= facturado             kdm1.c16
```

⛔ **`kdm1.c13` no es el descuento** (viaja sin impuesto). Prueba negativa de este item: usarlo da **$228,903 contra $248,187** medidos (−7.8 %).

### Medido en prod (30 días, en vivo, 1,374 facturas al cerrar)

| | |
|---|---|
| precio de lista | $16,232,320.57 |
| − producto | $385,506.76 (2.37 % de la lista) |
| − cliente | $248,187.37 (1.57 % del subtotal) |
| = facturado | **$15,598,626.44**, igual al total de la vista de facturas |
| cobertura | 15,121 de 15,136 renglones con precio de lista; 0 servicios; **cierre 0.00** |
| % de cliente medido contra el declarado (`c19`) | igual al centavo, por grupo: 2 % → 2.000, 3 % → 3.000, 5 % → 5.000 |

**Negociado contra aplicado**, contra el maestro de clientes de **hoy** (`kdud.c17`, llave sucursal + cliente, 0 duplicados): **57 facturas con menos %** del negociado (≈ $7,081) y **39 con más %** del registrado (≈ $11,778). Se publica sin juicio: desde el dato no se puede saber si fue una excepción autorizada o un error (`FASE_DC` §4).

⚠️ **Hallado al medir:** una factura llegó con cabecera y **sin renglones** (la réplica trae la cabecera antes que el detalle): sumada, rompía el cierre por $6,289.71. La cascada se calcula sobre facturas con renglones y las otras se **declaran** aparte.

### Costo

La consulta por factura (`LATERAL` sobre `ix_kdm2_venta_doc`) cuesta **130–345 ms** y corre en paralelo con las otras tres de facturación. ⛔ El join en bloque contra `kdm2` tardó **46 s** y contra `analytics.erp_sales_invoice_lines` más de 110 s (además esa vista une `kdm2→kdm1` **sin la serie `c5`**, la trampa de VEC.7). ⚠️ **El endpoint abre hasta 6 conexiones a la vez** (pool de 10 por pod, 2 pods): dos tableros simultáneos en el mismo pod esperan turno.

### Qué se hizo

- **Tira:** «Descontado 30 días» con su % del precio de lista.
- **Tarjeta «Descuentos · 30 días»:** la cuenta de arriba, renglón por renglón, con la base de cada % dicha (*de la lista* / *del subtotal*) y una línea que explica cada descuento; al lado, negociado contra aplicado; abajo, lo que no se pudo medir (renglones sin lista, facturas sin renglones).
- **Columna «Descuento»** por vendedor, con su % de la lista. Sin renglones = «sin renglones», nunca $0.
- `armarDescuentos()` (función pura) con `armar-descuentos.spec.ts` 4/4 y prueba negativa; smoke `test-newdb-telemarketing-billing.js` **19/19** en el pod `api` como `app_runtime` con RLS, con prueba negativa (`c13` como descuento → 2 FAIL).

### Auditoría de diseño (skill `auditoria-diseno`)

| # | Hallazgo | Nivel | Estado |
|---|---|---|---|
| 1 | La tabla se titulaba **«Por operador»** y **7 de sus 17 filas no son operadores**: E-COMMERCE (126 facturas), «PV SUCURSAL PADRE HIDALGO» ($592,969), código `2` sin nombre ($439,956), sin vendedor (16 facturas, $220,735), «Otros Ingresos», rutas y una sucursal. Cruce 2 | B | ✅ → «Por vendedor del ERP», y la nota lo dice |
| 2 | Mi propio texto decía «$ que el cliente **no se ahorró**» / «descuento **extra**»: afirmaba que el maestro tiene razón, contra la nota de al lado. Cruce 2 | C | ✅ → «menos / más de descuento que el negociado / registrado» |
| 3 | «57 facturas con menos % del negociado» **no se puede recorrer**: no hay lista ni filtro en `/comercial/documentos` que las muestre. Q.4 (redirección desde el dato) y Cruce 1 | C | ✅ **E.16** |
| 4 | **Conflación**: la pantalla contesta cinco preguntas (cuánto factura · cuánto descuenta · cuánto le deben · qué hicieron los operadores · a quién llamar). Las tres primeras son del mismo dinero; **la cola es trabajo de otra persona** y ya tiene su pestaña. `ESTANDAR §4.0` | C | ✅ **E.16** |
| 5 | Sin nivel A: no se midió el ancho de la tabla de vendedores (ahora 6 columnas dentro de media pantalla), la tarjeta de la cuenta ni la tira de 5 cifras | — | ⬜ validación visual tras desplegar |

## E.16 — las facturas detrás del descuento se pueden abrir, y la cola sale del Resumen (2026-10-21)

Cierra los hallazgos 3 y 4 de E.15. Decisión del PM: *"sigamos"* sobre la propuesta de sacar la cola.

- **Cada conteo de «negociado contra aplicado» abre un panel lateral** (`app-side-peek`) con **todas** sus facturas, sin tope —el encabezado dice N y la lista llega a N; si algún día no, el subtítulo lo dice—, ordenadas por diferencia: folio, cliente, vendedor, % del maestro, % de la factura, subtotal y diferencia. **Cada folio abre el documento** en `/comercial/documentos?doc=<folio>` (deep-link que esa pantalla ya tenía; no se tocó).
- La consulta de descuentos pasa a devolver **una fila por factura** con las mismas columnas que antes devolvía agrupadas: `armarDescuentos()` suma igual y además arma el detalle. Medido en prod: 1,375 filas, **58 + 39** con diferencia, folios distintos, cierre 0.00.
- **La vista previa de la cola salió del Resumen**: queda una línea con el enlace a la cola y la declaración de su universo (*11 de 317*). El endpoint ya no llama a `getQueue` (una conexión menos: ahora abre hasta 5).
- Spec `armar-descuentos` 5/5 (caso nuevo: la lista llega a N y va de mayor a menor).

## E.17 — la auditoría de diseño que faltaba: componentes fuera de PrimeNG y una API muerta (2026-10-21)

Disparador: *"ni siquiera auditaste bien el diseño, existen muchos componentes que no son de primeng"*. ⛔ **Tenía razón**: las auditorías de E.14 y E.15 se saltaron el paso 1 del recorrido de la skill (el inventario de piezas) y miraron sólo veracidad. Peor: E.15 **agregó** piezas a mano (una `<table>` propia, botones crudos, un aviso `.aviso` casero).

### El inventario del módulo, medido (escáner con control: 1 crudo en la línea 2)

Controles crudos = sin la directiva de PrimeNG que les corresponde (`<button>` sin `pButton`, `<input>` sin `pInputText`, `<select>`, `<textarea>` sin `pTextarea`, `<table>` sin la base `surf-table--plain`).

| Pantalla | Crudos | Qué |
|---|---:|---|
| `televenta-quote-new` | **33** | 20 botones (píldoras de modo, filas de resultado, pasos ±, cantidades rápidas, quitar), 8 `<input>` (incluido `type="date"` donde va `p-datepicker`), **3 `<select>`** donde va `p-select`, 1 `<textarea>`, 1 `<table>` |
| `televenta-quote-detail` | **14** | 12 botones, 2 `<input>` |
| `televenta-quotes` | 2 | filtros-«chip» propios (donde va `app-segmented`) y el buscador |
| `televenta-take-order` | 1 | buscador |
| `televenta-dashboard` | 3 → **0** | ver abajo |
| `televenta-lead`, `televenta-queue` | 0 | — |

⛔ **Y una falla muda que ninguna auditoría vio:** en PrimeNG 22 **`styleClass` no existe en `p-table`** (tampoco en `p-message`, `p-select`), y como atributo estático queda **muerto** (`check-primeng-api.js`). Las 4 tablas del tablero declaraban `styleClass="p-datatable-sm …"`: ni la densidad ni `surf-table` se aplicaban. En el repo hay **303** usos así, bajo techo.

### Lo que se corrigió en el tablero

- Encabezado canónico `surf-page` + `surf-page-head` (191 pantallas lo usan; éste tenía uno propio).
- Las 4 `p-table` con la API de v22: `size="small" class="surf-table dt-stack"`, cifras con `comm-num` en celda y encabezado (40 clases), y **tabla estrecha** `dt-stack`: `.dt-scope` envolviendo y `data-label` + `role="cell"` en cada celda (23). Se fue la advertencia #9 de responsividad: `check:pantalla` **10 de 10 reglas**.
- La cuenta del descuento sobre la base oficial de tabla cruda `surf-table--plain` (no una `.cuenta` propia), con el total en `<tfoot>`.
- Avisos con `p-message` (no `.aviso` casero); los botones crudos de las cifras → `p-button [link]` «Ver facturas». **Sin `::ng-deep`** nuevo (`DESIGN.md` §S lo lleva como deuda: 481).
- `check-primeng-api` 651 → **647** heredadas.

### Lo que sigue abierto

- ⬜ **Las pantallas de cotizaciones (47 controles crudos)**: van con el pedido *"hagamos que cotizaciones se puedan editar"*, que toca justo esas dos.
- ⬜ Sin validación visual (nivel A).
