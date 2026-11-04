# Fase DP — Definiciones de negocio: la pregunta vive en el sistema

> El método que la gobierna: [`docs/METODO_DE_TRABAJO.md`](../../METODO_DE_TRABAJO.md).
> Abierta por Edgar el 2026-11-03 (*«hay que abrir la fase y comenzar»*), **por encima del cupo**:
> con ésta son 7 fases 🔨 contra un tope de 4. Queda escrito para que el tablero lo refleje.

```
OBJETIVO: que una regla de negocio que falta para construir algo se PREGUNTE dentro de la suite
          —con dueño, tipo de respuesta y vigencia— y que contestarla sea configurarla, en vez de
          mandarla por WhatsApp y codificar a mano lo que alguien contestó.
MÉTRICA:  preguntas de negocio de Comisiones RD que viven en el sistema con su dueño
          — HOY: 0 de 17 (2026-11-03; las 17 están en un chat: pedido de Lupita Sánchez)
          → META: 17 de 17 registradas y visibles en «Mi trabajo › A tu nombre» de su dueño
            para el 2026-11-21
CAPA TOPE: C3
ÁREA:      Plataforma (primer consumidor: Comercial · Comisiones RD)
DUEÑO:     Edgar
ESTADO:    🔨
```

⚠️ La fecha de cierre es una **propuesta**: la fija o la corrige Edgar en el tablero.

---

## 1. Qué problema resuelve

El 2026-11-03 Lupita Sánchez pidió cuatro cosas para las comisiones de Ruta Directa (bono de
asistencia, promedio por ausencia justificada, cobro de faltante, rutas vecinal y TLMK). Ninguna se
puede construir sin reglas que sólo el negocio conoce. La respuesta de la sesión fue un mensaje de
WhatsApp con 17 preguntas, y Edgar la corrigió: *«hoy las preguntas hay que hacerlas en un sistema
configurable»*. El detalle medido de los cuatro pedidos está en
[`FASE_RD_COMISIONES_MOTOR.md` §9.4b](FASE_RD_COMISIONES_MOTOR.md).

Lo que cuesta hoy, medido:

- **La venta más grande sin comisión espera una respuesta, no código:** las rutas vecinales venden
  **$2.2M en 30 días** sin configurar (`VERDAD_ABSOLUTA.md` §32.5); 321 + 322 llevan
  **$846,189.75 desde el 2026-09-08**.
- **La respuesta de un chat no queda en ningún lado:** no tiene autor, fecha ni vigencia. Lo que
  contestan se vuelve a codificar a mano, y el motor no puede declarar «sin definir» porque no sabe
  que la pregunta existe.
- **Es la segunda vez que hace falta lo mismo:** «Mi trabajo» publica, escrito fijo en el texto,
  *«Indicadores con meta: pendientes de definición (P-01 · P-11)»*. ADR-056: un primitivo
  inventado dos veces va a `libs/`.

---

## 2. Qué NO incluye

- **Que el motor de comisiones lea las respuestas.** Eso son `[RD.103]`–`[RD.106]` en la fase RD:
  esta fase deja la pregunta en el sistema y la respuesta legible; el uso es de cada consumidor.
- **Un tabulador escalonado como respuesta.** Una escala ya tiene su pantalla versionada
  (Tabulador de `/comercial/comisiones`). Esa pregunta es de tipo `config_ref`: se contesta
  configurando ahí, y la definición sólo apunta a dónde.
- **Migrar los P-01 · P-11 de Mi trabajo.** Quedan como segundo consumidor declarado (`[DP.4]`).
- **Notificaciones** por correo o WhatsApp. La pregunta aparece en la bandeja del dueño.

---

## 3. Las capas

### C0 · Dato

Datos **propios** (respuestas de personas): tabla real, no vista. Sin importer.

| # | Item | Estado | Verificado contra |
|---|---|---|---|
| DP.0.1 | `platform.business_definitions` (la pregunta, con dueño y estado) y `platform.business_definition_answers` (las respuestas, con vigencia y motivo; registro sin UPDATE ni DELETE). RLS forzado, `tenant_id` + auditoría, FKs compuestas · migración `20261103153257` | 🚀 prod (batch 1092, 2026-11-03) | `test-newdb-business-definitions.js`: 5 bloques, cada invariante rota con su control. **NO MEDIDO local** (el `.env` apunta a prod y no hay Docker); corre en `pruebas-db` cuando esté registrada |
| DP.0.2 | Las 17 preguntas de Comisiones RD, sembradas sin dueño y con lo que Lupita ya dijo como **propuesta** (no como respuesta) | 🚀 prod (misma migración) | Conteo: 17 filas `pendiente` en el tenant. ⚠️ **NO MEDIDO en prod**: `dev_ro` no tiene `USAGE` sobre el schema `platform` (nació después de `ops/prod/dev-ro.sql`, que enumera los schemas a mano) y `edgar` no puede `SET ROLE app_runtime`. Arreglo: `platform` agregado a la lista de `dev-ro.sql`; falta correrlo en prod |

### C1 · Dominio
| # | Item | Estado | Prueba que lo ejerce |
|---|---|---|---|
| DP.1.1 | Contrato `libs/contracts/src/work/business-definition.contract.ts`: tipos, `validarRespuesta()` (el valor tiene que corresponder al tipo) y `resolverDefinicion()` (la respuesta vigente a una fecha, o «sin definir» declarado) | 🔨 | `business-definition.contract.spec.ts` |
| DP.1.2 | La tabla entra al contrato de tarea (`FUENTES_TAREA` + `ADAPTADORES`): sin eso `test-newdb-task-contract.js` falla por una fuente sin declarar | 🔨 | `test-newdb-task-contract.js` (bloques 1–3) |

### C2 · API
| # | Item | Estado | ¿Escribe? | Prueba contra base real |
|---|---|---|---|---|
| DP.2.1 | `GET /definitions?consumer=` (DEFINICIONES_VER) · `GET /definitions/mine` (sin llave: la bandeja propia). Módulo en `libs/platform-core/src/lib/definitions/`; llaves repartidas a `direccion` y `superadmin` | 🚀 prod (`7db184b1f`) | no | Arranque: `business-definitions.metadata.spec.ts` (paramtypes + llaves por método; rojo al quitar el provider). ⚠️ El reparto se escribió dentro de una migración **ya aplicada** y no corrió: lo rehízo `[DP.2.1]` `20261104082230` (batch 1096). **Medido en prod 2026-11-04**: VER 2 roles · GESTIONAR 2 · CONTESTAR 38 |
| DP.2.2 | `POST /definitions/:id/answers` (`{ value, valid_from, note }`; **sólo su dueño**, sin llave) · `PATCH /definitions/:id` (DEFINICIONES_GESTIONAR: asignar dueño, plazo, descartar sólo una pendiente) | 🚀 prod sin probar contra base | **sí** | `test-newdb-business-definitions-service.js`: el servicio REAL como `app_runtime`, con ese body. **NO MEDIDO**: no corrió (el `.env` apunta a prod, sin Docker) y la capa HTTP no la ejerce |
| DP.2.3 | Fuente visible en `me-tasks.ts` («Preguntas de negocio a tu nombre» → `/admin/definiciones`, sólo las `pendiente`). Se mide aislada: si la tabla todavía no existe, esa fila sale «no medida» y Mi trabajo no se cae | 🔨 | no | `test-newdb-me-context.js` (ahora cuenta 6 fuentes; candado de ruta/guard simulado en verde). NO MEDIDO contra base |

### C3 · UI
| # | Item | Estado | `check:pantalla` antes → después |
|---|---|---|---|
| DP.3.1 | `/admin/definiciones`: «A tu nombre» y «Todas» (sin dueño arriba), panel para contestar (el control lo decide el tipo; misma `validarRespuesta()`), repartir y descartar. Llave nueva `DEFINICIONES_CONTESTAR` (38 roles en prod, como `SERVICIO_REPORTAR`) para que el dueño tenga enlace | 🚀 prod (`7db184b1f`) | nueva → **0 fallas** (10 reglas). `ngc` sin errores propios (cazó 2 `TS4104` que `check:pantalla` no vio). Vista viva con las 17 interceptadas y escrituras bloqueadas: lista, orden y panel de quien reparte ✔. ⛔ **Sin validación visual**: el formulario del dueño (el backend local empezó a dar 500), oscuro, `forced-colors`, teléfono |
| DP.3.2 | En `/comercial/comisiones`, cada vista dice qué regla le falta: **Quién cobra** (a quién sigue la comisión, vecinales, TLMK), **Bonos** (asistencia y puntualidad), **Nómina quincenal** (ausencias, faltante). Línea por tema: «3 de 3 sin definir · lo define Lupita Sánchez · 1 sin dueño». ⛔ Una contestada dice «el cálculo todavía no la usa», no «definida»: ninguna la lee el motor hasta `[RD.103]`–`[RD.106]`. Endpoint propio `GET /commercial/commissions/definitions` con COMISIONES_VER (las de Dirección no le sirven a quien mira la nómina). Enlace a `/admin/definiciones` sólo a quien esa pantalla le muestra algo | 🧪 | sigue en **0 fallas** (10 reglas). `ngc` 0 errores, con control (método inexistente → `TS2339`). `comisiones-definiciones.util.spec.ts` 5 casos, mutante (contar la descartada) muere. Arranque: `commercial-commissions.metadata.spec.ts` +1 caso, rojo al quitar el import del módulo. ⛔ **Sin validación visual**: no hay sesión en el navegador local |

⛔ Cargar la skill `diseno` **antes** del primer archivo. Antes del primer item C3, la sección
«Observaciones de diseño UI» ([`auditoria-diseno` §9](../../../.claude/skills/auditoria-diseno/SKILL.md)).

### Segundo consumidor
| # | Item | Estado |
|---|---|---|
| DP.4 | Los P-01 · P-11 de «Mi trabajo» pasan a ser definiciones | ⬜ |

---

## 4. Decisiones (→ ADR)

| # | Decisión | ADR | Fecha |
|---|---|---|---|
| D1 | **Primitivo compartido, no de comisiones.** Schema `platform`, porque la pregunta no es de ningún dominio. Sus consumidores la leen por `key` | ADR-114 | 2026-11-03 |
| D2 | **Lo que alguien dijo fuera del sistema entra como PROPUESTA, no como respuesta.** «3 últimos periodos» de Lupita queda en `suggested_value` con su fuente: una respuesta tiene autor con usuario, fecha y motivo, y un chat no da ninguno | ADR-114 | 2026-11-03 |
| D3 | **Contestar no pisa: versiona.** Cada respuesta es una fila con `valid_from`. La vigente a una fecha es, entre las que ya rigen, la **contestada más tarde**: una respuesta nueva reescribe la regla desde su vigencia, también hacia atrás. ⚠️ Nació como «la de mayor `valid_from`» y el primer caso real la rompió: «sigue al chofer» (contestada el 3-nov, rige desde el 8-sep) perdía contra «tipo de ruta» (20-oct) para toda fecha posterior al 20-oct. Prueba con mutante que muere | ADR-114 | 2026-11-03 |
| D4 | **Una pregunta sin dueño no aparece en ninguna bandeja.** Las 17 nacen sin dueño a propósito: quién contesta cada una lo decide Edgar (`[RD.103]`–`[RD.106]`), y la pantalla lo declara | — | 2026-11-03 |

---

## 5. Riesgos y bloqueos

| Bloqueo | Dueño | Causa | Qué lo destraba |
|---|---|---|---|
| Quién contesta cada pregunta | Edgar | Lupita las planteó; su puesto no está medido y algunas son de RH (asistencia) o de Dirección (chofer vs ruta) | Asignar dueño desde la pantalla (DP.2.2) |
| Registrar la prueba en `database/run-all-tests.js` | Edgar | El archivo tiene un cambio ajeno en el índice; commitearlo con pathspec arrastraría ese cambio | Que su autor lo commitee, o permiso para hacerlo juntos |
| Cupo | Edgar | 7 fases 🔨 contra 4 | **Decidido (2026-11-03): ninguna a ⏸️, se terminan todas** |
| El usuario de Edgar en el padrón | Edgar | Ningún `identity.users` es el suyo (`edgar_cortes` es cliente B2B, `edgar_luna` es Marketing): su decisión no se puede firmar a su nombre | Que diga con qué usuario entra; hasta entonces su respuesta es propuesta (D2) |

---

## 6. Definición de Terminado

- [ ] 1. Métrica de la cabecera **remedida**, antes/después publicado
- [ ] 2. Cada capa verificada **o declarada NO MEDIDA** (ADR-056)
- [ ] 3. Todo endpoint que escribe **ejercido contra base real** con el payload de la pantalla
- [ ] 4. Toda compuerta nueva **rota a propósito una vez**, rojo verificado
- [ ] 5. Todo primitivo genérico en `libs/` compartido **o** deuda con nombre en el tracker
- [ ] 6. Tracker + `03_LOG_REVISIONES.md` + roadmap de `CLAUDE.md` al día
- [ ] 7. **En prod**, o escrito por qué no y qué falta

---

## Observaciones de diseño UI — revisión del plan (2026-11-03)

> Nivel C (se lee el plan, no la pantalla): nada visual se afirma como medido. Severidad: 🔴 bloquea
> pasar C3 a 🚀 · 🟠 dentro de la fase · 🟡 mejora o deuda con nombre.

**Las cinco preguntas (`diseno` §0b):**
1. **Qué ve y en qué orden.** El dueño: sus pendientes, la de plazo más próximo arriba; cada una con
   la pregunta, qué decide y la propuesta si la hay. Dirección: todas, con las **sin dueño arriba**
   (lo que falta repartir), después las pendientes con dueño por plazo, al final las contestadas.
2. **Qué NO.** La `key` técnica (sólo en el panel, chica), el consumidor como código (se traduce:
   «Comisiones de Ruta Directa»), el historial completo (su conteo; el detalle en el panel).
3. **Accesibilidad.** Un clic desde «Mi trabajo»; se contesta en un panel lateral sin perder la lista;
   el control lo decide el tipo; la propuesta se precarga con un clic; vigencia por defecto hoy;
   la fila se abre con Enter.
4. **Ligada a otro proceso.** Cada pregunta dice a qué pantalla afecta y la enlaza; una `config_ref`
   enlaza a la pantalla donde se configura.
5. **Le toca.** El dueño (`DEFINICIONES_CONTESTAR`) ve «A tu nombre»; Dirección (`VER`/`GESTIONAR`)
   ve «Todas» y reparte.

**La frase:** *¿qué reglas de negocio faltan por definir y quién las define?* — una sola pregunta,
vista desde dos sillas. **Jerarquía:** primario = la pregunta · secundario = la respuesta vigente y
el dueño · terciario = área, plazo, `key`.

| # | Sev | Observación y costo | Ley | Criterio de aceptación |
|---|---|---|---|---|
| DP.UI.1 | 🔴 | La propuesta (lo que se dijo por chat) **no se puede ver como respuesta**: 4 de las 17 traen una, y una celda «vigente: chofer» afirmaría una regla que nadie firmó en el sistema (D2) | Veracidad (ADR-056) | La columna de la respuesta dice «sin definir»; la propuesta va aparte, con su fuente: «Propuesta · Edgar (PM), 2026-11-03» |
| DP.UI.2 | 🔴 | **«Sin dueño» se declara**: las 17 nacen sin dueño y, sin decirlo, la lista se leería como «pendientes de alguien» | Veracidad | En «Todas», las sin dueño van arriba con «Sin dueño: nadie la va a contestar» |
| DP.UI.3 | 🟠 | Quien no es el dueño no debe ver un «Guardar» que el servidor rechaza con 403 | Poka-yoke | El control de respuesta sólo existe para el dueño; a Dirección le dice «La contesta {nombre}» y le ofrece «Asignármela» |
| DP.UI.4 | 🟠 | El motivo es obligatorio y el valor tiene tipo: dejar escribir y rechazar después es el error como primer recurso | Poka-yoke | «Guardar» deshabilitado hasta tener valor válido (misma `validarRespuesta()` del contrato) y motivo |
| DP.UI.5 | 🟠 | Una vigencia en el pasado reescribe la regla hacia atrás (D3): es justo lo que hizo «sigue al chofer» | Comprensión | Si la fecha es anterior a hoy: «Rige desde {fecha}: reescribe la regla también para lo ya calculado» |
| DP.UI.6 | 🟠 | Doble clic = dos respuestas (dos vigencias iguales) | Idempotencia visual | «Guardar» se deshabilita en el primer clic |
| DP.UI.7 | 🟡 | Descartar es destructivo | Von Restorff | En rojo, separado de lo diario, con confirmación y motivo |

## 7. Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
| 2026-11-03 | Fase abierta. C0 (tablas + 17 preguntas) y C1 (contrato + adaptador de tarea) en código | Edgar (abre) · Claude |
| 2026-11-03 | Primera respuesta: `rd.universo.sigue_a` = **chofer**, retroactivo al 2026-09-08. ⚠️ No estaba abierta: el 2026-10-20 Edgar había dicho «tipo de ruta», escrito sólo en la nota del padrón de 321/322. Se le mostró la contradicción y confirmó la reversa. Entra como propuesta (sin usuario suyo). Retroactivo medido: **$0** (2V001 bajo el primer escalón en Q18–Q21). D3 corregida | Edgar · Claude |
| 2026-11-03 | C2 y C3 (`/admin/definiciones`, bandeja en Mi trabajo) en código: `b3a00e9dc` | Claude |
| 2026-11-04 | **En prod**: `/api/health` en `7db184b1f`. Migraciones 1092 (tablas y 17 preguntas) y 1096 (`[DP.2.1]`: el reparto que no corrió por ir dentro de una migración ya aplicada; lo encontró otra sesión). Llaves medidas: VER 2 · GESTIONAR 2 · CONTESTAR 38 roles | Edgar (empuja) · Claude |
| 2026-11-04 | DP.3.2 en código: comisiones declara en cada vista la regla que le falta y quién la define. Hallazgo: `dev_ro` no lee el schema `platform` → la métrica no se puede remedir desde una cuenta de lectura hasta correr `ops/prod/dev-ro.sql` | Claude |
