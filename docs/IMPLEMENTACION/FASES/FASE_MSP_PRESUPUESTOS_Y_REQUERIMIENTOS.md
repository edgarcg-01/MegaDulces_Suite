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
ESTADO:    🔨  (C0–C3 🧪 con mutantes · evidencia de punta a punta y validación visual NO MEDIDAS · nada en prod)
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
| MSP.0.1 | Migración de esquema `servicedesk_presupuestos_esquema`: en `queues` → `requester_positions text[]` (NULL = cualquiera), `requires_description`, `requires_decision`, `work_order_queue_codes text[]`; en `requests` → `decision`, `decision_note`, `decided_by`, `decided_at`, `parent_request_id`; motivo de espera `orden_servicio`. Con CHECK de coherencia (el dictamen va completo o no va; una hija no es su propio padre; el padre es del mismo tenant) | 🧪 | `test-newdb-presupuestos.js` (Postgres local :5442, transacciones revertidas): negativas por cada CHECK/FK, cada una exige el NOMBRE de la restricción en el error |
| MSP.0.2 | Siembra `servicedesk_seed_presupuestos`: cola `presupuestos` **APAGADA**, departamento `finanzas`, sin prioridad ni SLA, 3 categorías (gastos operativos, compra de activos, otros), campos obligatorios `observaciones` (texto) y `evidencia` (foto/PDF), quién levanta = los 3 puestos de D1, exige descripción y dictamen, órdenes a `mantenimiento` y `ti`; `ernesto_zarate` coordinador con `SERVICIO_ATENDER` + `SERVICIO_COORDINAR` individuales | 🧪 | el mismo `test-newdb-presupuestos.js`: propiedades, idempotencia, no pisa ajustes, `down` conserva lo que tiene tickets |

⛔ Sin importer: todo es configuración de la Mesa (datos propios), no un dato de Kepler.

### C1 · Dominio (puro, `libs/service-desk/src/lib/domain/presupuesto.ts`)

| # | Item | Estado | Prueba que lo ejerce |
|---|---|---|---|
| MSP.1.1 | `puedeLevantarEnCola(puesto, cola)` — `NULL` = cualquiera; si hay lista, el puesto del TITULAR debe estar | 🧪 | `presupuesto.spec.ts` |
| MSP.1.2 | `validarDescripcion` — una cola que la exige rechaza vacío/blancos | 🧪 | idem |
| MSP.1.3 | `validarDictamen` — sólo la coordinación de esa cola, sólo si la cola lo exige, motivo obligatorio, no en resuelto/cerrado/cancelado, no se cambia si ya hay órdenes | 🧪 | idem |
| MSP.1.4 | `exigeDictamenParaResolver` — resolver sin dictamen en una cola que lo exige → 409 | 🧪 | idem |
| MSP.1.5 | `validarOrdenDeServicio` — dictamen **autorizado**, destino en la lista de la cola, destino no confidencial y con quien atienda, categoría del destino, padre vivo | 🧪 | idem |
| MSP.1.6 | `resolverPadrePorOrdenes` — el padre se resuelve solo cuando ninguna orden sigue abierta y al menos una se resolvió | 🧪 | idem |

### C2 · API

| # | Item | Estado | ¿Escribe? | Prueba contra base real |
|---|---|---|---|---|
| MSP.2.1 | `GET /service-desk/catalog` — la cola sólo aparece a quien puede levantar en ella (o la atiende) y declara `requires_description` | 🧪 | no | `http-service-desk-presupuestos-test.js` contra la API local (62/62, §7) |
| MSP.2.2 | `POST /service-desk/requests` — 403 a un puesto fuera de la lista (también a nombre de otro) **antes de tocar el bucket**, 400 sin descripción, 400 sin observaciones, 400 sin evidencia | 🧪 | **sí** | idem, con el payload del formulario; ⚠️ el alta CON evidencia NO MEDIDA (sin bucket local) |
| MSP.2.3 | `POST /service-desk/requests/:id/decision` `{ decision, note }` | 🧪 | **sí** | idem |
| MSP.2.4 | `POST /service-desk/requests/:id/work-orders` — crea la solicitud HIJA en Mantenimiento/TI a nombre de quien pidió el presupuesto, copia la evidencia, deja al padre en espera (`orden_servicio`); todo en una transacción | 🧪 | **sí** | idem; ⚠️ la copia de la evidencia NO MEDIDA (sin bucket local) |
| MSP.2.5 | Resolver (`POST …/status`) exige dictamen; resolver la última orden abierta resuelve al padre; cancelar una orden lo anota en el padre | 🧪 | **sí** | idem |
| MSP.2.6 | `GET /service-desk/requests/:id` — trae el dictamen, el padre (folio, área) y las órdenes (folio, área, estado) | 🧪 | no | idem |

### C3 · UI (`apps/view/src/app/modules/servicio/`)

| # | Item | Estado | `check:pantalla` antes → después |
|---|---|---|---|
| MSP.3.1 | Formulario «Nueva solicitud»: el área aparece sólo a quien puede; la descripción se marca obligatoria cuando el área la exige | 🧪 | ver §8 |
| MSP.3.2 | Detalle: bloque «Dictamen de Presupuestos» (Autorizado / No autorizado + motivo) para la coordinación; el solicitante lo ve | 🧪 | idem |
| MSP.3.3 | Detalle: «Generar orden de servicio» (área destino, categoría, instrucciones, riesgo si el destino lo pide) y la lista de órdenes ligadas con su estado | 🧪 | idem |
| MSP.3.4 | Detalle de la orden: «Viene de SRV-… (Presupuestos y Requerimientos)» | 🧪 | idem |

### Encender (después del merge)

| # | Item | Estado |
|---|---|---|
| MSP.4.1 | Aplicar las 2 migraciones en prod **una por una**, ANTES del merge (sólo agregan columnas con default y filas; el código viejo las ignora y la cola queda apagada) | ⬜ |
| MSP.4.2 | Desplegar; `ernesto_zarate` cierra sesión y vuelve a entrar (los permisos viajan en el token) | ⬜ |
| MSP.4.3 | Encender la cola desde Configuración y levantar una solicitud de prueba (marcarla «de prueba») con un encargado, **con evidencia adjunta** y una orden de servicio a Mantenimiento: es la primera vez que la evidencia corre de punta a punta (el bucket no existe en local) | ⬜ |

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
| Evidencia de punta a punta (alta con adjunto y su copia en la orden) | Usuario / PM | El bucket no está configurado en local (`S3_*`) | La solicitud de prueba de `[MSP.4.3]` en prod |
| Cupo de fases | PM (Edgar) | Fase 0 en curso, MS ⏸️ | Ratificar el frente |
| Tiempo de respuesta de Presupuestos | Ernesto / Edgar | No está definido | Fijarlo y encender el SLA de la cola |

## 6. Definición de Terminado

- [ ] 1. Métrica remedida en prod (solicitudes con dictamen / resueltas) tras el encendido
- [x] 2. Cada capa verificada **o declarada NO MEDIDA** (2026-11-19; §7)
- [ ] 3. Los 4 endpoints que escriben ejercidos contra base real con el payload de la pantalla — ejercidos los 4 (2026-11-19), **falta la evidencia**: sin bucket local, el alta con adjunto y su copia en la orden esperan a `[MSP.4.3]`
- [x] 4. Toda compuerta nueva rota a propósito una vez (mutantes del §7: C0 4/4, C1 6/6, C2 3 rondas, C3 3/3)
- [ ] 5. Primitivos genéricos: son columnas de `queues` + `domain/presupuesto.ts` en `libs/service-desk` (no hay primitivo local)
- [x] 6. Tracker + log + roadmap al día (2026-11-19, checkpoint del PR #567)
- [ ] 7. En prod

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

## 9. Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
| 2026-11-18 | Pedido del usuario: área de Presupuestos y Requerimientos (coordina Ernesto Zárate), D1–D4 contestadas. Medido prod. Plan escrito. | Sistemas + Claude |
| 2026-11-18 | C0–C3 escritos. C1 y C3 🧪 (con mutantes); C0 y la matriz HTTP de C2 NO MEDIDAS (sin Postgres local ni API). Ver §7. | Claude |
| 2026-11-19 | Con Postgres local y la API levantada desde la copia: C0 47/47 (4 mutantes en rojo), C2 62/62 (3 rondas de mutantes en rojo). La matriz encontró el 403 que llegaba después del bucket; arreglado. Evidencia de punta a punta NO MEDIDA (sin bucket local) → `[MSP.4.3]`. | Usuario + Claude |
| 2026-11-19 | **PR #567** abierto. CI obligatorio en verde; `Lint & test` rojo ajeno (`primeng` 24 > 21 ya en la base). `main` tomó ADR-122 (`[VER]`): la decisión de esta fase pasa a **ADR-124** en una fusión. Las observaciones del ciclo, al protocolo previo al PR (`ONBOARDING.md` §8.0b, puntos 114–119; 109–113 son de #569). | Claude |
