# Fase ETQ-AVISOS — Avisar a las sucursales que cambió un precio, y dejar que Compras comparta la lista

> **Estado:** 🧪 **EN CÓDIGO 2026-10-09 (fases 1–3), probado con dobles; NADA aplicado a prod ni empujado.** La fase 0 (mediciones) **NO se corrió**: necesita lectura de prod y esta sesión no la alcanzó. Ver §8. Pedido de Edgar: *«mandar una notificación a los usuarios de sucursal de que hay cambios de precios, y a los de Compras darles la opción de compartir la lista de cambios de precios»*.
> **Continúa:** `ETQ-CAMBIOS.1–8` (pantalla `/tienda/etiquetas/cambios`, ver [`FASE_ETIQUETAS_ANAQUEL`](FASE_ETIQUETAS_ANAQUEL.md)). **Hereda:** ADR-053 (el aviso mide ENTREGA), ADR-056 (lo que no se pudo medir se declara), ADR-054 (permiso = clave exacta), ADR-080 (el worker no emite por WebSocket).

---

## 1. Por qué existe

Hoy la encargada se entera de que un precio cambió **sólo si abre «Cambios de precio»** (el día por defecto es ayer). Si no la abre, la etiqueta del anaquel queda vieja hasta que un cliente reclama en la caja. Caso real del 2026-10-08 en Padre Hidalgo: el 91059 tenía en el anaquel `$5,602.87` por 500 g y Kepler ya decía `$203.85`.

Compras es quien mueve los precios y hoy no tiene cómo pasarle la lista a nadie: ve las plazas una por una y no puede compartir lo que ve.

## 2. ¿Hay estructura? Sí para casi todo; no para este caso

Medido leyendo el código el 2026-10-09:

| Pieza | Existe | Dónde | Para qué sirve acá |
|---|---|---|---|
| La fuente de «qué cambió» | ✅ | `analytics.v_label_price_changes` (bitácora de Kepler, por plaza y día) + `SQL_CAMBIOS` en `commercial-labels.service.ts` | Es la ÚNICA fuente con el precio anterior. Ya filtra ruido (sub-centavo y exactamente $0.01) |
| Aviso dirigido con memoria | ✅ | `[VEC.4]` `commercial.order_notifications` + `AlertsService.emitTo` (room `u:<tenant>:<username>`) | Es el molde: la fila es la memoria, el `emitTo` es la inmediatez. Resuelve destinatarios con `ScopeService` |
| La campana | ✅ | `notifications-bell.component.ts` (WS `/alerts` + poll de Mesa de Servicio) | Ya muestra avisos; falta una sección de precios |
| Cron con latido | ✅ | worker + `analytics.cron_runs` + umbral en `CRON_JOBS` | Sin umbral registrado el tablero da verde incondicional (lección de la Fase VP) |
| Correo | ⚠️ | `MAILER_PORT` | `SMTP_*` estaba sin configurar en prod (OBS.0.2). **Verificar antes de prometerlo** |
| WhatsApp | ❌ | `libs/whatsapp` | BSP pendiente (ADR-006) y plantilla Meta sin aprobar. **Fuera de alcance** |
| Tabla de avisos de precio, generador, «compartir» | ❌ | — | Es lo que construye esta fase |

**Dos restricciones que condicionan el diseño:**
1. **El worker no tiene WebSocket** (ADR-080) y es donde corren los crons. Por eso el aviso **siempre deja su fila** y la campana lo recoge por poll; el empuje en vivo es un extra que sólo existe si lo emite la API.
2. **El aviso por WebSocket de `label_prices_changed` (TDA.1) NO sirve para esto**: es por tenant (no por plaza), sale de cada recálculo del ERP y arrastra el mismo ruido (41.9 % de la semana son movimientos de un centavo; 116 SKUs oscilan ~36 veces cada uno). Sirve para marcar filas en la etiquetera, no para avisar a una persona.

## 3. Decisiones (cerradas por Edgar el 2026-10-09)

> **D1** resumen diario a las **07:30** y un segundo a las **14:00** · **D2** enviar aviso a sucursales **y** descargar la lista · **D3** permiso propio `STORE_LABELS_COMPARTIR` · **D4** mínimo **1** producto después de filtros · **D5** plaza sin usuario con tienda asignada: el aviso **se ve igual** para quien tenga alcance y **se declara**. Lo de abajo es el razonamiento original.

| # | Pregunta | Recomendación | Por qué |
|---|---|---|---|
| **D1** | ¿Cuándo avisar? | **Un resumen diario ~07:30 (hora MX) con los cambios de AYER**, no en vivo | Es el día que la encargada revisa al abrir; en vivo avisaría cada oscilación. Un aviso que suena sin motivo se aprende a ignorar (lección VEC.4) |
| **D2** | ¿Qué significa «compartir» para Compras? | **Dos cosas**: (a) **Enviar aviso a sucursales** (Compras elige plazas y agrega una nota → llega a la campana de esas plazas) y (b) **Descargar la lista** (Excel/CSV) | (a) cumple «mandar la lista»; (b) cubre quien la quiere fuera de la Suite. **WhatsApp y correo quedan fuera** hasta que existan canales reales |
| **D3** | ¿Permiso para compartir? | **Permiso nuevo `STORE_LABELS_COMPARTIR`**, repartido por migración a los roles de Compras | Reusar `COMPRAS_VER` acopla un botón de Tienda al módulo de Compras. Cuidado: un permiso nuevo **no está entregado hasta que está repartido en prod** (lección LC.6.2) |
| **D4** | ¿Cuántos productos mínimo para avisar? | **≥ 1 después de filtros** (el mismo criterio de la pantalla). Un día sin cambios no genera aviso | Que aviso y pantalla no puedan discrepar |
| **D5** | Plazas sin ningún usuario con tienda asignada | **El aviso se ve igual** para quien tenga alcance sobre esa plaza (patrón `ScopeService` de VEC.4) y se **declara** qué plazas no tienen a nadie | En VEC.4 sólo 1 de 6 almacenistas tenía `warehouse_id`; filtrar por esa columna dejaba el aviso «entregado» sirviendo a nadie |

## 4. Fases

Cada fase es entregable por sí sola y no deja nada a medias. **Migraciones aditivas primero, código después** (regla del protocolo de PR).

### ETQ-AVISOS.0 — Medir y cerrar decisiones (sólo lectura, sin código)
Contra **prod** (rol `dev_ro`), no contra la base local:
- **Destinatarios por plaza:** cuántos usuarios activos con `STORE_LABELS_VER` tiene cada una de las 8 plazas, y por qué columna se les alcanza (`warehouse_code` vs `warehouse_id`). Hay 13 de 33 con el permiso sin tienda (Compras, Dirección, Supervisión, superadmin). **Salida: lista de plazas sin destinatario** (esperable 04 y 08, como pasó con inventario).
- **Volumen real:** productos con cambio por plaza y día en los últimos 90 días (después de filtros y de resumir por unidad), para fijar si D4 basta. Antecedente: el peor día-plaza tuvo 115 productos.
- **A qué hora llega la bitácora al ODS** (`fuente_al` contra la hora): fija la hora del cron. Un aviso antes de que llegue el día diría «no hubo cambios» siendo falso.
- **Correo:** ¿`SMTP_*` está configurado hoy? Define si D2 puede incluir un tercer canal.
- **Compras:** qué roles y cuántas personas recibirían `STORE_LABELS_COMPARTIR`.

**Cierra cuando:** D1–D5 tienen respuesta y las cinco mediciones están escritas aquí.

### ETQ-AVISOS.1 — Memoria del aviso (migración + generador, sin pantalla)
- **Migración** (marca = hora real de creación; se genera con `node scripts/nueva-migracion.js`; idempotente; `tenant_id` + audit + RLS forzado): `commercial.price_change_notices` con `plaza`, `fecha`, `productos`, `suben`, `bajan`, `sin_precio`, `origen` (`auto` | `compras`), `nota`, `created_by`, `created_at`. **`UNIQUE (tenant_id, plaza, fecha, origen)`** = idempotencia (reintentar no duplica). Se guardan **conteos, no la lista**: la lista se DERIVA al abrir la pantalla; guardarla crearía una segunda verdad que envejece (mismo argumento de VEC.4).
- **Un solo cálculo.** Se extrae la consulta de `priceChanges()` a una función compartida y la usan la pantalla **y** el generador. «Dos campos del mismo hecho salen del mismo cálculo»: si el aviso dijera 12 y la pantalla 14 nadie volvería a creerle a ninguno.
- **Generador** en el worker (`@Cron`, ~07:30 MX): por cada plaza con cambios de ayer, escribe su fila. **Declara en vez de callar:** si `fuente_al` < ayer, **no genera** y registra «bitácora sin llegar» (`NO MEDIDO`), no «0 cambios».
- **Latido** a `analytics.cron_runs` + **umbral registrado en `CRON_JOBS`**. `status` `error` cuando falla la mayoría, no sólo cuando falla todo.
- **Candado** (DB-direct, con prueba negativa): idempotencia · el conteo coincide con la pantalla para la misma plaza y día · día sin bitácora no genera · cambios que terminan en el mismo precio no cuentan.

**Cierra cuando:** el generador corre en prod una noche y las filas coinciden con lo que muestra la pantalla.

### ETQ-AVISOS.2 — Entrega: el aviso llega a la campana de la sucursal
- **Endpoint** `GET /store/labels/notices` (gate `STORE_LABELS_VER`, recortado con `ScopeService`: quien no tiene plaza declarada ve todas). **Sin `POST seen`**: el acuse es por persona y vive en la campana (como el resto de sus avisos); no hay tabla de lecturas que mantener.
- **Campana:** sección «Cambios de precio» con *«Padre Hidalgo: 47 productos cambiaron de precio ayer»* → clic lleva a `/tienda/etiquetas/cambios?plaza=01&fecha=…`. **La pantalla de cambios hoy no lee parámetros de URL**: se agrega (con validación del mismo formato que el backend).
- **Empuje en vivo opcional** (sólo si lo emite la API): `AlertsService.emitTo` a quien tiene esa plaza. No es la entrega; es la inmediatez.
- Se **declara** en el log qué plazas quedaron sin destinatario (D5).
- **Prueba de entrega, no de intención** (ADR-053): una persona de la plaza ve el aviso, uno de otra plaza **no**, y quien no tiene plaza lo ve en la bandeja.

**Cierra cuando:** un usuario real de una sucursal ve el aviso en la campana al día siguiente y llega a la lista con un clic.

### ETQ-AVISOS.3 — Compras comparte la lista
- **Permiso `STORE_LABELS_COMPARTIR`**: enum + `authz-tree` + **migración de reparto** derivada del estado vivo + prueba de entrega de permisos. Sin esto el botón no se vería para nadie.
- **Botón «Compartir»** en la pantalla de cambios, sólo con el permiso:
  - **Enviar aviso a sucursales:** elige una o varias plazas y escribe una nota opcional → escribe filas `origen = 'compras'`; llegan por el mismo camino de la fase 2. Declara cuántas plazas **no tienen a nadie** que lo reciba.
  - **Descargar lista:** Excel/CSV del día y la plaza vista (una fila por producto, columnas por presentación, mismas reglas de resumen que la pantalla).
- El selector de plaza de Compras ya existe (`priceChangeBranches`); se reutiliza.

**Cierra cuando:** una persona de Compras envía la lista a una plaza, esa plaza la ve en la campana, y el archivo descargado cuadra con la pantalla.

### ETQ-AVISOS.4 — Afinar con lo que se mida (diferida, sólo si hace falta)
Preferencia de silenciar · segundo canal (correo, **sólo si** 0 lo confirma) · avisos intradía sobre la señal en vivo, **sólo** si 1–3 muestran que el resumen diario llega tarde · tasa de lectura por plaza (¿alguien abre el aviso?).

## 5. Qué NO incluye esta fase (a propósito)

- **WhatsApp:** sin BSP ni plantilla aprobada, un binding falso sería un aviso fingido.
- **Avisar en vivo cada cambio:** produciría ruido y enseñaría a ignorar el tablero.
- **Escribir en Kepler / cambiar precios:** la Suite no escribe en el ERP (ADR-040).
- **Guardar la lista de productos en el aviso:** se deriva.
- **Imprimir automático:** el aviso lleva a la pantalla; la persona decide qué reimprimir y qué precio lleva.

## 6. Riesgos

| Riesgo | Cómo se ataca |
|---|---|
| El aviso dice «0 cambios» porque la bitácora aún no llegó | Fase 1: si `fuente_al` < ayer, **no se genera** y se declara `NO MEDIDO` |
| Aviso y pantalla discrepan | Misma función de cálculo para ambos + candado que los compara |
| Plazas sin destinatario → «entregado» sirviendo a nadie | Fase 0 lo mide; fase 2 lo declara; la bandeja recorta con `ScopeService` |
| Permiso nuevo sin repartir | Fase 3: migración de reparto + prueba de entrega de permisos |
| Aviso se vuelve ruido | Un resumen por plaza y día; nunca por cambio; nota de Compras identificada (`origen`) |
| Migración tomada por otro PR | `npm run check:mig-colisiones` al abrir y antes del merge |

## 7. Orden y dependencias

`0` (sin código) → `1` (migración **antes** que el código) → `2` → `3`. `4` sólo con evidencia. Las fases 1 y 2 son la parte que pidió Edgar para sucursales; la 3, la de Compras. **La 3 depende de la 2** (comparte el camino de entrega), pero se puede planear en paralelo con la 1.

---

## 8. Lo construido (2026-10-09) y lo que falta

### Construido
| Pieza | Dónde |
|---|---|
| **La regla compartida** (agrupar por código, resumir por unidad, contar): una sola para la pantalla y el generador | `libs/contracts/src/http/price-change-notice.contract.ts` (+ spec, 9) |
| **Tabla** `commercial.price_change_notices` (RLS forzado, 8 CHECK con prueba negativa dentro de la migración, sin DELETE) | `20261009160146_etq_avisos_cambios_precio_tabla.js` |
| **Reparto** de `STORE_LABELS_COMPARTIR` (deriva de `STORE_LABELS_VER` y comprador; **imprime la lista** y falla si no hay ninguno) | `20261009160147_etq_avisos_reparto_compartir.js` |
| **Generador** (07:30 resume AYER, 14:00 resume HOY), latido a `cron_runs` + umbral en `CRON_JOBS` (`price_change_notices`, warn 20 h / crit 40 h) | `price-change-notices.service.ts` (+ spec, 20) |
| **API**: `GET notices`, `GET notices/recipients`, `POST notices/share`, `POST notices/generate` | `commercial-labels.controller.ts` |
| **Campana**: poll cada 5 min, sólo quien tiene `STORE_LABELS_VER` | `notifications-bell.component.ts` (+ spec, 5) y `aviso-precio.ts` (+ 7) |
| **Compartir** (diálogo: avisar a sucursales + descargar CSV), sólo con el permiso | `cambios-compartir.component.ts` (+ 9) y `cambios-csv.ts` (+ 9) |
| **Enlace directo** `?plaza=&fecha=` en la pantalla de cambios | `tienda-cambios-precio.component.ts` (+ 5) |

### Decisiones que se tomaron al construir (y que el plan no decía)
- **CSV, no XLSX.** El frontend no tiene exportador de Excel (`exceljs` sólo se usa para LEER). El CSV lleva BOM UTF-8 y neutraliza nombres que empiezan con `= + - @` (inyección de fórmulas desde nombres que vienen del ERP).
- **Los dos cortes se solapan y es a propósito:** el de las 14:00 (HOY) y el de las 07:30 del día siguiente (AYER) cuentan el mismo día. Cada uno es el estado «a esa hora»; no se intentó restar para no avisar dos veces lo mismo (frágil y de poco valor).
- **Ningún aviso vacío, por construcción:** `CHECK (productos >= 1)` en la tabla, no sólo un `if` en el servicio.
- **Sin dato no es cero:** si la bitácora de la plaza no llega al día, no se avisa y el latido lo dice (`SIN DATO: 01,04`). Si NINGUNA plaza tiene dato, el latido es **error** (la ingesta está caída y todo lo demás se vería «sin cambios»).
- **`POST notices/generate`** existe para probar sin esperar a las 07:30 / 14:00. La fecha la fija el corte, no el que llama, para que no se puedan fabricar avisos viejos.
- **El reenvío accidental** (misma persona, plaza y día en 10 min) se frena en el servicio, no en la tabla: Compras sí puede avisar dos veces con otra nota.

### ⚠️ Hallazgo: `COMPRAS_VER` no se podía usar
`permissions.ts` documenta que está repartido en **0 de 37 roles**. La alternativa «reusar `COMPRAS_VER`» habría dejado el botón sin nadie. Tampoco sirve «cualquier `COMPRAS_*`»: `COMPRAS_ENTRADAS_VALIDAR` la tienen ~25 personas y casi todas son de sucursal. Por eso la migración deriva de `STORE_LABELS_VER` y (`COMPRAS_PEDIDO_GESTIONAR` o `COMPRAS_REQUISICIONES_GESTIONAR`).

### Falta (en este orden)
1. **Fase 0 sin correr.** Contra prod con `dev_ro`: destinatarios por plaza (¿qué plazas quedan «sin nadie con tienda asignada»? esperable 04 y 08), volumen real de cambios por plaza y día, a qué hora llega la bitácora al ODS (**ajustar las 07:30 / 14:00 si llega más tarde**: un aviso antes de que llegue diría «sin dato»), y la lista de roles que recibiría la migración de reparto.
2. **Migraciones a prod, una por una** con `apply-one-migration-prod.js` (nunca `migrate:latest`), **ANTES** del código: la tabla primero; el reparto **antes de mergear** (sólo hace UPDATE: la compuerta del despliegue la clasifica NO_MEDIDO y frena al equipo hasta que alguien la aplique a mano). Revisar la lista de roles que imprime. Los afectados deben **re-loguear**.
3. **Las migraciones NO se ejecutaron contra ninguna base** (el Docker local estaba apagado). Revisadas por sintaxis y por lectura; sus compuertas internas (RLS + prueba negativa de los 7 CHECK) corren por primera vez al aplicarlas.
4. **Validación visual** del diálogo de compartir y de la campana (no se levantó la app: regla del proyecto).
5. **Choque con el PR #349** en una línea (`imports:` de la pantalla de cambios): trivial, pero quien entre segundo debe resolverla.
6. **Smoke contra prod** al desplegar: `POST /store/labels/notices/generate {corte:"manana"}` y mirar `analytics.cron_runs` (`price_change_notices`).
