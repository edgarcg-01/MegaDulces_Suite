# Fase MSP — Mesa de Servicio: Presupuestos y Requerimientos

> Frente de la fase **MS** (Mesa de Servicio, ADR-081: «sumar un área es una fila»). Lo que esta área pide y la Mesa
> todavía NO sabía hacer —restringir quién levanta, exigir la descripción, el dictamen de la coordinación y la orden de
> servicio ligada— se construye **genérico, por cola**, para que la próxima área que lo necesite sea configuración.
> El método que la gobierna: [`docs/METODO_DE_TRABAJO.md`](../../METODO_DE_TRABAJO.md).

```
OBJETIVO: que las sucursales pidan gasto operativo o compra de activos por la Mesa, con evidencia, y que la
          coordinación de Presupuestos dé un dictamen formal y, si autoriza, mande la orden de servicio a
          Mantenimiento o Sistemas sin perder el hilo.
MÉTRICA:  solicitudes de presupuesto con dictamen registrado en la Suite —
          HOY: 0 (la cola no existe; medido en prod el 2026-11-18) → META: 100 % de las resueltas con dictamen
          (lo hace cumplir el servidor: sin dictamen no se resuelve).
CAPA TOPE: C3
ÁREA:      Finanzas (Presupuestos y Compras Corporativas) + Plataforma (Mesa de Servicio)
DUEÑO:     Sistemas (construcción) · Ernesto Zárate (coordinación del área)
ESTADO:    🔨  (C0–C3 ✅ en prod desde el 2026-11-19 · cola ENCENDIDA el 2026-11-24 · alta con evidencia medida en prod; su copia en la orden y la validación visual NO MEDIDAS · falta la orden de prueba de MSP.4.3 · §9: reposición desde TI y Mantenimiento, falta `[MSP.5.0]` para el piloto)
```

⚠️ **Cupo:** MS está ⏸️ en el roadmap y la campaña de aterrizaje sigue (Fase 0). Este frente lo pidió el usuario el
2026-11-18; **la ratificación del cupo es del PM** (como RP y MSH). Mientras tanto se construye sin encender nada en
prod: la cola nace **APAGADA**.

---

## 1. Qué problema resuelve

Medido en prod (sólo lectura, `system_identifier` verificado, 2026-11-18):

| Hecho | Valor |
|---|---|
| Colas de la Mesa | `ti`, `mantenimiento`, `compras` (RH espera el PR #539). **No hay cola de Presupuestos.** |
| Coordinador | `ernesto_zarate` — ERNESTO ZARATE PEREZ, puesto `presupuestos_compras_corp` («Presupuestos y Compras Corporativas»), departamento `finanzas`, activo. **No es miembro de ninguna cola.** |
| Quién puede levantar (D1) | `encargado_sucursal` **9** · `auxiliar_encargado` («Auxiliar de Encargado») **6** · `jefe_zona` («Gerencia de Zona») **3** = **18 personas activas** |
| Destinos de la orden de servicio | `mantenimiento` (al medir la coordinaba `jorge_rubio`; ese mismo día `[MS.8.4]` sumó a `ubaldo_barajas`, responsable por omisión) y `ti` (14 coordinadores) |

Hoy un gasto operativo o una compra de activo de una sucursal se pide fuera de la Suite: no queda registro de quién lo
pidió, con qué evidencia, si se autorizó ni qué orden de trabajo lo atendió. La Mesa ya tiene el ticket, el hilo, los
adjuntos, los campos por área y el traslado; le faltan cuatro piezas.

## 2. Qué NO incluye

- **Monto** (D4, decidido 2026-11-18: «no por ahora»). No hay campo de importe ni monto autorizado.
- **SLA**: la cola nace **sin plazos** (`sla_enabled = false`, se declara «—»). Nadie ha fijado el tiempo de respuesta
  de Presupuestos y un plazo inventado es un cero dibujado. Se enciende desde Configuración cuando Ernesto/Edgar lo fije.
- **Prioridad**: la cola no la usa (`uses_priority = false`): las preguntas de impacto/«me impide trabajar» no aplican a
  una solicitud de presupuesto.
- **Ligar con Kepler o ContPAQi** (orden de compra, póliza): fuera. La Suite no escribe en Kepler.
- **Editar desde la pantalla de Configuración** quién levanta, si exige descripción/dictamen o a qué áreas manda
  órdenes: se siembra por migración. Queda como deuda con nombre (`[MSP.D1]`).
- **Reabrir la solicitud de Presupuestos cuando se reabre su orden**: se avisa en el hilo, no se reabre sola
  (`[MSP.D2]`).

## 3. Las capas

### C0 · Dato

| # | Item | Estado | Verificado contra |
|---|---|---|---|
| MSP.0.1 | Migración de esquema `servicedesk_presupuestos_esquema`: en `queues` → `requester_positions text[]` (NULL = cualquiera), `requires_description`, `requires_decision`, `work_order_queue_codes text[]`; en `requests` → `decision`, `decision_note`, `decided_by`, `decided_at`, `parent_request_id`; motivo de espera `orden_servicio`. Con CHECK de coherencia (el dictamen va completo o no va; una hija no es su propio padre; el padre es del mismo tenant) | ✅ | `test-newdb-presupuestos.js` (Postgres local :5442, transacciones revertidas): negativas por cada CHECK/FK, cada una exige el NOMBRE de la restricción en el error |
| MSP.0.2 | Siembra `servicedesk_seed_presupuestos`: cola `presupuestos` **APAGADA**, departamento `finanzas`, sin prioridad ni SLA, 3 categorías (gastos operativos, compra de activos, otros), campos obligatorios `observaciones` (texto) y `evidencia` (foto/PDF), quién levanta = los 3 puestos de D1, exige descripción y dictamen, órdenes a `mantenimiento` y `ti`; `ernesto_zarate` coordinador con `SERVICIO_ATENDER` + `SERVICIO_COORDINAR` individuales | ✅ | el mismo `test-newdb-presupuestos.js`: propiedades, idempotencia, no pisa ajustes, `down` conserva lo que tiene tickets |

⛔ Sin importer: todo es configuración de la Mesa (datos propios), no un dato de Kepler.

### C1 · Dominio (puro, `libs/service-desk/src/lib/domain/presupuesto.ts`)

| # | Item | Estado | Prueba que lo ejerce |
|---|---|---|---|
| MSP.1.1 | `puedeLevantarEnCola(puesto, cola)` — `NULL` = cualquiera; si hay lista, el puesto del TITULAR debe estar | ✅ | `presupuesto.spec.ts` |
| MSP.1.2 | `validarDescripcion` — una cola que la exige rechaza vacío/blancos | ✅ | idem |
| MSP.1.3 | `validarDictamen` — sólo la coordinación de esa cola, sólo si la cola lo exige, motivo obligatorio, no en resuelto/cerrado/cancelado, no se cambia si ya hay órdenes | ✅ | idem |
| MSP.1.4 | `exigeDictamenParaResolver` — resolver sin dictamen en una cola que lo exige → 409 | ✅ | idem |
| MSP.1.5 | `validarOrdenDeServicio` — dictamen **autorizado**, destino en la lista de la cola, destino no confidencial y con quien atienda, categoría del destino, padre vivo | ✅ | idem |
| MSP.1.6 | `resolverPadrePorOrdenes` — el padre se resuelve solo cuando ninguna orden sigue abierta y al menos una se resolvió | ✅ | idem |

### C2 · API

| # | Item | Estado | ¿Escribe? | Prueba contra base real |
|---|---|---|---|---|
| MSP.2.1 | `GET /service-desk/catalog` — la cola sólo aparece a quien puede levantar en ella (o la atiende) y declara `requires_description` | ✅ | no | `http-service-desk-presupuestos-test.js` contra la API local (62/62, §7) |
| MSP.2.2 | `POST /service-desk/requests` — 403 a un puesto fuera de la lista (también a nombre de otro) **antes de tocar el bucket**, 400 sin descripción, 400 sin observaciones, 400 sin evidencia | ✅ | **sí** | idem, con el payload del formulario; ⚠️ el alta CON evidencia NO MEDIDA (sin bucket local) |
| MSP.2.3 | `POST /service-desk/requests/:id/decision` `{ decision, note }` | ✅ | **sí** | idem |
| MSP.2.4 | `POST /service-desk/requests/:id/work-orders` — crea la solicitud HIJA en Mantenimiento/TI a nombre de quien pidió el presupuesto, copia la evidencia, deja al padre en espera (`orden_servicio`); todo en una transacción | ✅ | **sí** | idem; ⚠️ la copia de la evidencia NO MEDIDA (sin bucket local) |
| MSP.2.5 | Resolver (`POST …/status`) exige dictamen; resolver la última orden abierta resuelve al padre; cancelar una orden lo anota en el padre | ✅ | **sí** | idem |
| MSP.2.6 | `GET /service-desk/requests/:id` — trae el dictamen, el padre (folio, área) y las órdenes (folio, área, estado) | ✅ | no | idem |

### C3 · UI (`apps/view/src/app/modules/servicio/`)

| # | Item | Estado | `check:pantalla` antes → después |
|---|---|---|---|
| MSP.3.1 | Formulario «Nueva solicitud»: el área aparece sólo a quien puede; la descripción se marca obligatoria cuando el área la exige | ✅ | ver §8 |
| MSP.3.2 | Detalle: bloque «Dictamen de Presupuestos» (Autorizado / No autorizado + motivo) para la coordinación; el solicitante lo ve | ✅ | idem |
| MSP.3.3 | Detalle: «Generar orden de servicio» (área destino, categoría, instrucciones, riesgo si el destino lo pide) y la lista de órdenes ligadas con su estado | ✅ | idem |
| MSP.3.4 | Detalle de la orden: «Viene de SRV-… (Presupuestos y Requerimientos)» | ✅ | idem |

### Encender (después del merge)

| # | Item | Estado |
|---|---|---|
| MSP.4.1 | Aplicar las 2 migraciones en prod **una por una**, después del merge y antes de soltar (el envoltorio sólo aplica archivos que ya están en `origin/main`; este plan decía «antes del merge» y estaba mal). Sólo agregan columnas con default y filas; la cola queda apagada | ✅ 2026-11-19 19:35 UTC (batch 1213 y 1214) |
| MSP.4.2 | Desplegar; `ernesto_zarate` cierra sesión y vuelve a entrar (los permisos viajan en el token) | 🔨 desplegado (prod sirve `f43a7340e`, que contiene el squash `3e3bf4caf`; medido el 2026-11-21); el re-login de Ernesto no se puede verificar desde la base |
| MSP.4.3 | Encender la cola desde Configuración y levantar una solicitud de prueba (marcarla «de prueba») con un encargado, **con evidencia adjunta** y una orden de servicio a Mantenimiento: es la primera vez que la evidencia corre de punta a punta (el bucket no existe en local) | 🔨 medido en prod el 2026-11-24 (sólo lectura): cola **encendida** a las 17:21:54 UTC por `felipe_galvan`; 2 solicitudes con su adjunto (1 real, asignada y sin dictamen; 1 marcada de prueba, «no autorizada») → **el alta con evidencia funciona en prod**. Falta: una orden de servicio (0 hasta hoy), que es la que mide la copia de la evidencia |

## 4. Decisiones (→ ADR-124)

| # | Decisión | Quién | Fecha |
|---|---|---|---|
| D1 | Levantan **sólo** `encargado_sucursal`, `auxiliar_encargado` y `jefe_zona` (18 personas). Se valida el puesto del **titular** de la solicitud, también cuando alguien que atiende la levanta a su nombre. | Usuario | 2026-11-18 |
| D2 | La respuesta obligatoria es un **dictamen formal**: Autorizado / No autorizado, con motivo escrito. Sólo la coordinación del área lo da; sin dictamen la solicitud no se resuelve; una «No autorizada» no genera orden de servicio. El dictamen **no cambia el estado**: resolver sigue siendo un paso explícito con su nota. Se puede corregir mientras no haya órdenes emitidas ni esté resuelta; cada dictamen queda en el hilo. | Usuario (regla) · Sistemas (mecánica) | 2026-11-18 |
| D3 | La orden de servicio es una **solicitud hija ligada** (`parent_request_id`), con su propio folio, en Mantenimiento o TI. La de Presupuestos queda **en espera** (motivo `orden_servicio`, que la respuesta del solicitante no reanuda) y **se resuelve sola** cuando ya no hay órdenes abiertas y al menos una se resolvió. La hija va **a nombre de quien pidió el presupuesto** (es quien recibe el servicio y confirma), la abre la coordinación, hereda la sucursal y **referencia** la evidencia del padre (mismo objeto del bucket, fila nueva en la hija). | Usuario (regla) · Sistemas (mecánica) | 2026-11-18 |
| D4 | Sin monto por ahora. | Usuario | 2026-11-18 |
| D5 | Todo es **por cola y por valor** (columnas de `queues`), no por el nombre «presupuestos»: la siguiente área que necesite restringir solicitantes, exigir dictamen u órdenes ligadas es configuración. | Sistemas | 2026-11-18 |
| D6 | La cola nace **apagada**, sin SLA ni prioridad, y sus categorías **exigen sucursal**: una solicitud de presupuesto es de una ubicación (`requires_branch = true`). | Sistemas | 2026-11-18 |
| D7 | El dictamen y la orden de servicio los da la coordinación **por membresía real** de la cola: el god-mode (administrador) no autoriza gasto ni manda órdenes, aunque pueda reasignar o trasladar. | Sistemas | 2026-11-18 |
| D8 | Trasladar un ticket **hacia** Presupuestos no exige el puesto del titular (es un acto de la coordinación de otra área, no un alta). Se deja así a propósito; el catálogo ya no le ofrece el área a quien no la atiende. | Sistemas | 2026-11-18 |

## 5. Riesgos y bloqueos

| Bloqueo | Dueño | Causa | Qué lo destraba |
|---|---|---|---|
| Validación visual (MSP.3.x) | Usuario | El frontend no lo levanta Claude (regla 3) | Levantar `view` y revisar con Ernesto |
| Evidencia de punta a punta: la copia en la orden (el alta con adjunto ya se midió en prod el 2026-11-24) | Usuario / PM | El bucket no está configurado en local (`S3_*`) | La primera orden de servicio de `[MSP.4.3]` en prod |
| Cupo de fases | PM (Edgar) | Fase 0 en curso, MS ⏸️ | Ratificar el frente |
| Tiempo de respuesta de Presupuestos | Ernesto / Edgar | No está definido | Fijarlo y encender el SLA de la cola |

## 6. Definición de Terminado

- [ ] 1. Métrica remedida en prod (solicitudes con dictamen / resueltas) tras el encendido
- [x] 2. Cada capa verificada **o declarada NO MEDIDA** (2026-11-19; §7)
- [ ] 3. Los 4 endpoints que escriben ejercidos contra base real con el payload de la pantalla — ejercidos los 4 (2026-11-19), **falta la evidencia**: sin bucket local, el alta con adjunto y su copia en la orden esperan a `[MSP.4.3]`
- [x] 4. Toda compuerta nueva rota a propósito una vez (mutantes del §7: C0 4/4, C1 6/6, C2 3 rondas, C3 3/3)
- [ ] 5. Primitivos genéricos: son columnas de `queues` + `domain/presupuesto.ts` en `libs/service-desk` (no hay primitivo local)
- [x] 6. Tracker + log + roadmap al día (2026-11-19, checkpoint del PR #567; 2026-11-21, en prod)
- [x] 7. En prod (2026-11-19, squash `3e3bf4caf`, migraciones batch 1213 y 1214; la cola sigue apagada hasta `[MSP.4.3]`)

## 7. Pruebas y mutantes (medido el 2026-11-18; C0 y C2 el 2026-11-19)

| Prueba | Resultado |
|---|---|
| `libs/service-desk/src/lib/domain/presupuesto.spec.ts` | **31/31** |
| Librería `service-desk` completa (vitest) | **357/357** (incluye `request-state.spec` con el sistema resolviendo al padre y `notice.spec` con el aviso `dictamen`) |
| Mutantes del dominio | **6/6 en rojo**: cualquiera levanta (3 rojas) · orden sin dictamen autorizado · padre resuelto con una orden abierta · resolver sin dictamen · dictamen cambia con orden en marcha · orden a un área confidencial |
| `tsc --noEmit -p libs/service-desk/tsconfig.json` | 0 errores en `service-desk` y `contracts` (los 7 que reporta son previos, de `platform-core`) |
| `apps/view/.../sd-request-detail-presupuesto.spec.ts` | **10/10** |
| Módulo `servicio` del frontend completo | **327/327** (36 archivos); **330/330** el 2026-11-19 con el `sd-queue-members` que trajo `main` (#562) |
| Mutantes de la pantalla | **3/3 en rojo** (U3 sobrevivió la primera vez: la prueba buscaba «No autorizar» y con dictamen dado el botón dice «Cambiar a no autorizado»; se endureció) |
| `check:pantalla -- servicio` | **28 → 28** fallas (8 componentes; 15 en deuda, 13 que ya traía `main`): ninguna nueva |
| `check-template-types` | `view`, `portal`, `vendor` sin errores; `api`: 1 previo y ajeno (`src/instrument.ts`, `mcp`) |
| Compuertas de diseño | `templates`, `estilos`, `reactividad`, `tokens CSS`, `sin emojis`, `motion`, `track`, `teclado`, `búsqueda`, `cifra recorrible` en verde. Rojas **ajenas**: `primeng` (24 > 21, en Compras), `sd-confid` (`config-admin.service.ts`, no tocado), `tablas densas` (Comercial) |
| `test-newdb-presupuestos.js` (C0, Postgres local :5442, 2026-11-19) | **47/47** |
| Mutantes de C0 | **4/4 en rojo**: la cola nace encendida (3 rojas) · se cuela un puesto no permitido (`cajera`) · un dictamen incompleto pasa el CHECK · una cola se manda órdenes a sí misma. Restauradas: 47/47 |
| `http-service-desk-presupuestos-test.js` (C2, API local levantada desde este código, 2026-11-19) | **62/62**. La primera corrida dio 58/4 y encontró un defecto real (abajo) |
| ⭐ Defecto que encontró la matriz | La cajera que mandaba la foto recibía **400 «Almacenamiento no configurado»** en vez de **403**: el alta subía los adjuntos al bucket ANTES de revisar el puesto (en prod: subir y descartar). Ahora una lectura previa del puesto responde el 403 antes de tocar el bucket, como ya hacía `[MS.3.11]` con «a nombre de otra persona»; la transacción lo vuelve a verificar y es la que manda (`rechazoPorPuesto`, un solo lugar) |
| ⭐ Negativas que pasaban por otro motivo | Tres negativas aceptaban «cualquier 400» y salían verdes con el 400 del bucket. Ahora **cada negativa exige su mensaje** (descripción, «Observaciones», «Evidencia», ubicación, motivo del dictamen, destino, riesgo, instrucciones) y las que llevan foto usan el cuerpo que pasa la evidencia según haya bucket o no |
| Mutantes de C2 (API viva, recompilada en cada ronda) | **3 rondas en rojo**: A) sin la lectura previa del puesto y sin el filtro del catálogo → 3 rojas (la cajera vuelve al 400 del bucket; el catálogo le ofrece el área) · B) resolver sin dictamen permitido → 11 rojas (la ⭐ «resolver SIN dictamen → 409» y la cascada) · C) el padre no se resuelve con su orden → 2 rojas (queda `en_espera`, sin la nota). Restaurado: 62/62 y sin residuo en la base local |
| ⚠️ NO MEDIDO en la matriz | El alta CON evidencia y la evidencia heredada por la orden: el bucket no está configurado en local (`S3_*`). Lo dice la propia prueba; la negativa «sin evidencia → 400» sí se midió |
| Librería `service-desk` tras el arreglo | **357/357**; `tsc` sin errores propios (los 7 de `platform-core`, previos) |
| Lo que la prueba aprendió de su entorno | El login admite **5 intentos por minuto** y la matriz usa 5: una corrida por minuto. Sin token ahora aborta y lo dice (antes seguía en 401 en cascada); cada usuario se anota al insertarlo, para que un login fallido no deje residuo |
| Validación visual | ⚠️ **NO MEDIDA** |

## 8. Observaciones de diseño UI — revisión del plan (las cinco preguntas, `diseno` §0b)

1. **Qué debe ver el usuario y en qué orden.**
   - *Encargado/auxiliar/jefe de zona* (formulario): área → categoría → sucursal → título → descripción (obligatoria) →
     observaciones (obligatoria) → evidencia (obligatoria). En su detalle: estado, **el dictamen** (Autorizado / No
     autorizado y por qué) arriba del hilo, y las órdenes de servicio con su estado.
   - *Ernesto* (detalle): lo pedido y la evidencia → **dar dictamen** → si autorizó, **generar orden** → seguir la orden.
2. **Qué no.** El formulario no pregunta impacto, «me impide trabajar» ni riesgo (la cola no usa prioridad). Quien no
   puede levantar **no ve el área** (no un botón deshabilitado sin explicación). Mantenimiento/TI no ven el hilo de
   Presupuestos: sólo el folio de origen.
3. **Accesibilidad.** El dictamen se dice con texto e icono (no sólo color): `p-tag` «Autorizado» / «No autorizado».
   Los obligatorios se marcan con texto, no sólo con asterisco rojo.
4. **¿Ligada a otro proceso?** Sí: la orden vive en Mantenimiento/TI con su SLA y su coordinación. El padre muestra su
   estado vivo (lo lee del servidor en cada apertura; no se copia).
5. **¿Este proceso la debe ver?** El solicitante ve dictamen y órdenes (es su solicitud). Mantenimiento/TI ven sólo la
   referencia al padre: no son miembros de Presupuestos y la API les devuelve 404 si la abren.

## 9. Reposición de equipo desde TI y Mantenimiento (`[MSP.5]`, pedido del 2026-11-24)

**Lo que se pidió (cita):** «vincular las órdenes de servicio que impliquen revisión de mantenimiento y sistemas con el
módulo de presupuestos para que al registrar por ejemplo que la impresora ya no funcione pase esa orden como solicitud de
compra para el área de presupuestos». Y después: «aplica lo que sea más simple de implementar con opción a mejorar o
implementar el nuevo flujo».

**Cómo cambió:** el flujo cabe en dos acciones que están en prod (**Trasladar**, `[MS.7.11]`, y **Orden de
servicio**, `[MSP.2.4]`), **salvo una pieza**: hoy Presupuestos **no aparece** en «Transferir a otra área» para la
coordinación de TI ni la de Mantenimiento (§9.3). Lo más simple es ese cambio mínimo (`[MSP.5.0]`) y probar con casos
reales. El atajo «Requiere compra» queda escrito abajo y en espera (`[MSP.5.2]`): se construye si el piloto lo pide.

### 9.1 Medido en prod (sólo lectura, `system_identifier` 7688376744939610156, 2026-11-24)

| Hecho | Valor |
|---|---|
| Solicitudes reales de TI | **126** desde el 2026-10-03 (30 sin sucursal) |
| Solicitudes reales de Mantenimiento | **5** desde el 2026-11-14 |
| De TI, las que mencionan comprar o reemplazar (expresión regular sobre título, descripción, resolución e hilo) | **11**; leídas a mano, **2** son de equipo dañado y **ninguna** termina en una compra. Mantenimiento: 0 |
| Solicitudes ligadas entre áreas (`parent_request_id`) | **0** |
| Traslados entre áreas, en toda la historia de la Mesa (mensajes `kind = 'transfer'`) | **0**: el piloto es la primera vez |
| Quién puede trasladar | la coordinación de la cola: TI **14** coordinadores, Mantenimiento **2** (todos sus miembros activos lo son) |
| La categoría de impresoras de TI exige sucursal | sí (`Equipo de cómputo e impresoras`, `requires_branch`), así que la orden de instalación la hereda |

**El universo no es el trabajo.** El universo son las 131 solicitudes de TI y Mantenimiento; el trabajo son las que
terminan en «no tiene reparación». Hoy **no se pueden contar** porque no hay dónde registrarlo: contarlas es lo primero
que da el piloto.

### 9.2 Decisiones (usuario, 2026-11-24)

| # | Decisión | Quién |
|---|---|---|
| D9 | Quien decide que el equipo ya no tiene reparación, y lo manda a Presupuestos, es la **coordinación** de Mantenimiento y de Sistemas (TI). Nunca es automático al levantar el reporte: la mayoría se reparan. | Usuario |
| D10 | Presupuestos manda la orden de instalación **cuando el equipo ya llegó**, no al autorizar, para que la bandeja de TI y de Mantenimiento sólo tenga trabajo que se puede hacer. Mientras llega, la solicitud queda en espera con el motivo «proveedor», que ya existe. | Usuario (regla) · Sistemas (el motivo) |
| D11 | La cotización es **opcional** y va como adjunto. No hay campo de monto (respeta D4). | Usuario |
| D12 | Primero lo más simple: Trasladar + Orden de servicio, con el único cambio que hace falta para que Presupuestos aparezca al trasladar (`[MSP.5.0]`). El atajo `[MSP.5.2]` queda escrito para cuando el piloto lo pida. | Usuario («aplica lo que sea más simple de implementar») · Sistemas (que hace falta `[MSP.5.0]`, §9.3) |

### 9.3 La pieza que falta (`[MSP.5.0]`) y el flujo del piloto (`[MSP.5.1]`)

⛔ **Hallado al revisar la pantalla (2026-11-24):** el diálogo «Transferir a otra área»
(`sd-request-detail.component.ts`, `areasDestino`) arma su lista con el **catálogo de «Nueva solicitud»**
(`GET /service-desk/catalog`). Desde `[MSP.2.1]`, ese catálogo esconde un área con lista de puestos a quien no está en
ella ni es miembro. La coordinación de TI y la de Mantenimiento no cumplen ninguna de las dos, así que **Presupuestos no
les aparece** para trasladar. El servidor sí lo aceptaría (D8: trasladar no exige el puesto), pero no hay botón que lo
pida. Es la «puerta pintada» al revés: un camino que existe y la pantalla no muestra.

**`[MSP.5.0]` el cambio mínimo** (C2 + C3, sin migración):
- `GET /service-desk/transfer-targets`, con `SERVICIO_COORDINAR` (el mismo permiso que trasladar): todas las áreas
  encendidas que tienen categorías, con sus categorías, **sin** el filtro de puestos. No devuelve la lista de puestos.
- El diálogo de traslado usa esa lista. «Nueva solicitud» **no cambia**: a quien no está en los 3 puestos, Presupuestos
  le sigue sin aparecer para levantar.
- Pruebas: la del servicio y la de la pantalla, cada una con su negativa (el catálogo le sigue escondiendo Presupuestos a
  una cajera; la lista de traslado se la muestra a la coordinación de TI); y el traslado de TI a Presupuestos ejercido
  contra una base real (regla 13): el camino D8 nunca se probó por HTTP (`http-service-desk-presupuestos-test.js` no
  tiene ningún traslado).
- Alternativa descartada: hacer a las 16 personas de la coordinación de TI y Mantenimiento miembros de Presupuestos.
  No necesita código, pero les abriría la bandeja de Presupuestos con todas las solicitudes de todas las sucursales.

**El flujo del piloto, ya con `[MSP.5.0]`:**

1. La sucursal reporta en TI o en Mantenimiento, como siempre.
2. Si se repara, se resuelve como siempre.
3. Si **no tiene reparación**, la coordinación deja en el hilo el diagnóstico (qué equipo, por qué no se repara y la
   foto). Si tiene cotización, la adjunta como **nota interna**: la ve Presupuestos, no la sucursal, y no viaja a la
   orden de instalación, porque la orden sólo hereda la evidencia pública. Luego **traslada** la solicitud a
   «Presupuestos y Requerimientos», categoría «Compra de activos», con un motivo que la sucursal entienda (el motivo del
   traslado es público).
4. Presupuestos la toma y da el dictamen.
5. **Autorizado:** mientras llega el equipo, la pone en espera con el motivo «proveedor». Cuando llega, «Generar orden de
   servicio» al área de origen («instalar …»). La orden hereda la sucursal, a quien reportó y la evidencia pública.
6. El área instala y resuelve su orden, y **la solicitud original se resuelve sola** (`[MSP.1.6]`); la sucursal recibe
   el aviso. Sigue un solo folio de principio a fin.
7. **No autorizado:** Presupuestos la resuelve con su motivo, que la sucursal lee. Si hay otra salida (reparar, prestar
   un equipo), la traslada de regreso al área de origen.

**Verificado leyendo el código de `main` (no ejercido):** en el servidor, el traslado lo puede hacer la coordinación
de la cola de origen y no pide el puesto de quien reportó (D8); Presupuestos no mide SLA, así que el traslado no exige política; la
orden exige el dictamen autorizado y la solicitud tomada, y acepta una solicitud en espera («proveedor») sin reanudarla,
porque cambia el motivo a `orden_servicio`; resolver la última orden resuelve al padre cuando su cola exige dictamen y
está autorizado. ⚠️ **NO MEDIDO:** esa cadena completa nunca corrió sobre una base real. Cada pieza tiene su prueba
(`[MS.7.11]`; `http-service-desk-presupuestos-test.js` 62/62), pero no juntas. **El primer caso real es la prueba.**

### 9.4 Lo que el piloto no resuelve (→ `[MSP.5.2]`)

- Mientras Presupuestos decide, la solicitud sale de la bandeja de TI o de Mantenimiento, y la instalación le regresa con
  otro folio. El reporte del área deja de contarla.
- Si no se autoriza, el área de origen no se entera, salvo que Presupuestos se la regrese.
- Al trasladar, nada obliga a poner el diagnóstico ni la foto: el traslado sólo pide un motivo.

### 9.5 `[MSP.5.2]` El atajo «Requiere compra», escrito para después

- Un botón en TI y Mantenimiento, sólo para su coordinación (D9), que crea una solicitud **hija** en Presupuestos con
  el diagnóstico y la foto obligatorios y la cotización opcional (D11).
- La solicitud de origen queda **en espera** con el motivo `aprobacion` (ya existe en el CHECK), con su reloj pausado.
- Cuando Presupuestos resuelve la hija, la de origen **se reanuda** (no se resuelve) y lleva el dictamen. Es la regla de
  `[MSP.1.6]` al revés: hace falta una regla nueva en el dominio puro, que distinga «la hija resuelve al padre» de «la
  hija le devuelve el control».
- La hija no es un alta: no se le aplica la lista de puestos de D1 (como D8).
- Un solo nivel: si la solicitud de origen ya es una orden de Presupuestos, no genera otra compra.
- Capas: C1 (dominio), C2 (endpoint), C3 (botón y estado en la ficha). Si C0 necesita migración: NO MEDIDO hasta
  diseñarlo (en principio reusa `parent_request_id` y `aprobacion`). Necesita cupo: hoy hay 8 fases 🔨 contra 4, y lo
  ratifica el PM.

### 9.6 Métrica del frente

**Reposiciones que llegan a Presupuestos desde TI o Mantenimiento con su folio original.** HOY: **0** (no hay traslados
ni ligas; medido el 2026-11-24). Desde que `[MSP.5.0]` llegue a prod, se cuenta con los mensajes `kind = 'transfer'` cuyo `meta.to_queue_id` es
Presupuestos, y se miden dos tiempos: del traslado al dictamen, y del dictamen a la orden resuelta. Con eso se decide si
`[MSP.5.2]` vale el cupo.

## 10. Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
| 2026-11-18 | Pedido del usuario: área de Presupuestos y Requerimientos (coordina Ernesto Zárate), D1–D4 contestadas. Medido prod. Plan escrito. | Sistemas + Claude |
| 2026-11-18 | C0–C3 escritos. C1 y C3 🧪 (con mutantes); C0 y la matriz HTTP de C2 NO MEDIDAS (sin Postgres local ni API). Ver §7. | Claude |
| 2026-11-19 | Con Postgres local y la API levantada desde la copia: C0 47/47 (4 mutantes en rojo), C2 62/62 (3 rondas de mutantes en rojo). La matriz encontró el 403 que llegaba después del bucket; arreglado. Evidencia de punta a punta NO MEDIDA (sin bucket local) → `[MSP.4.3]`. | Usuario + Claude |
| 2026-11-19 | **PR #567** abierto. CI obligatorio en verde; `Lint & test` rojo ajeno (`primeng` 24 > 21 ya en la base). `main` tomó ADR-122 (`[VER]`): la decisión de esta fase pasa a **ADR-124** en una fusión. Las observaciones del ciclo, al protocolo previo al PR (`ONBOARDING.md` §8.0b, puntos 114–119; 109–113 son de #569). | Claude |
| 2026-11-21 | **En prod, con la cola apagada** (re-medido, sólo lectura): #567 fusionado el 2026-11-19 (squash `3e3bf4caf`, 18:28 UTC); las 2 migraciones aplicadas a las 19:35 UTC (batch 1213 y 1214), después del merge; prod sirve `f43a7340e`, que contiene el squash; cola `presupuestos` apagada, 3 categorías, 0 solicitudes; Ernesto coordinador con sus 2 permisos. C0–C3 y MSP.4.1 a ✅. Falta MSP.4.2 (re-login) y MSP.4.3 (encender + prueba con evidencia), con el cupo ratificado por el PM. | Claude |
| 2026-11-24 | Re-medido en prod (sólo lectura): la cola se **encendió** a las 17:21:54 UTC (`felipe_galvan`); 2 solicitudes con su adjunto (1 real, 1 de prueba «no autorizada»), 0 órdenes. **Pedido nuevo del usuario:** que la reposición de equipo de TI y Mantenimiento llegue a Presupuestos como solicitud de compra. D9–D12 contestadas por el usuario: lo más simple con Trasladar + Orden de servicio (§9), y el atajo `[MSP.5.2]` escrito y en espera. Al revisar la pantalla: Presupuestos no aparece en «Transferir a otra área» para TI ni Mantenimiento (la lista sale del catálogo de «Nueva solicitud»), así que el piloto necesita el cambio mínimo `[MSP.5.0]`. | Usuario + Claude |
