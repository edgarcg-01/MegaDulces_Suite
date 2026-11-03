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
| DP.0.1 | `platform.business_definitions` (la pregunta, con dueño y estado) y `platform.business_definition_answers` (las respuestas, con vigencia y motivo; registro sin UPDATE ni DELETE). RLS forzado, `tenant_id` + auditoría, FKs compuestas · migración `20261103153257` | 🔨 | `test-newdb-business-definitions.js`: 5 bloques, cada invariante rota con su control. **NO MEDIDO local** (el `.env` apunta a prod y no hay Docker); corre en `pruebas-db` cuando esté registrada |
| DP.0.2 | Las 17 preguntas de Comisiones RD, sembradas sin dueño y con lo que Lupita ya dijo como **propuesta** (no como respuesta) | 🔨 | Conteo: 17 filas `pendiente` en el tenant |

### C1 · Dominio
| # | Item | Estado | Prueba que lo ejerce |
|---|---|---|---|
| DP.1.1 | Contrato `libs/contracts/src/work/business-definition.contract.ts`: tipos, `validarRespuesta()` (el valor tiene que corresponder al tipo) y `resolverDefinicion()` (la respuesta vigente a una fecha, o «sin definir» declarado) | 🔨 | `business-definition.contract.spec.ts` |
| DP.1.2 | La tabla entra al contrato de tarea (`FUENTES_TAREA` + `ADAPTADORES`): sin eso `test-newdb-task-contract.js` falla por una fuente sin declarar | 🔨 | `test-newdb-task-contract.js` (bloques 1–3) |

### C2 · API
| # | Item | Estado | ¿Escribe? | Prueba contra base real |
|---|---|---|---|---|
| DP.2.1 | `GET /definitions?consumer=` · `GET /definitions/mine` | ⬜ | no | — |
| DP.2.2 | `POST /definitions/:id/answers` (valor + vigencia + motivo) · `PATCH /definitions/:id` (asignar dueño, plazo, descartar) | ⬜ | **sí** | ⛔ obligatoria, con el payload de la pantalla |
| DP.2.3 | Fuente visible en `me-tasks.ts` («Preguntas de negocio a tu nombre») | ⬜ | no | `test-newdb-me-context.js` |

### C3 · UI
| # | Item | Estado | `check:pantalla` antes → después |
|---|---|---|---|
| DP.3.1 | Contestar una pregunta desde «Mi trabajo» (el control lo decide el tipo) | ⬜ | |
| DP.3.2 | En `/comercial/comisiones`, cada ajuste que depende de una pregunta muestra «sin definir · lo define <dueño>» | ⬜ | |

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
| D1 | **Primitivo compartido, no de comisiones.** Schema `platform`, porque la pregunta no es de ningún dominio. Sus consumidores la leen por `key` | pendiente de ADR | 2026-11-03 |
| D2 | **Lo que alguien dijo fuera del sistema entra como PROPUESTA, no como respuesta.** «3 últimos periodos» de Lupita queda en `suggested_value` con su fuente: una respuesta tiene autor con usuario, fecha y motivo, y un chat no da ninguno | pendiente de ADR | 2026-11-03 |
| D3 | **Contestar no pisa: versiona.** Cada respuesta es una fila con `valid_from`; la vigente a una fecha es la de mayor `valid_from` ≤ fecha. Así una quincena vieja se recalcula con la regla que regía entonces, igual que el tabulador | pendiente de ADR | 2026-11-03 |
| D4 | **Una pregunta sin dueño no aparece en ninguna bandeja.** Las 17 nacen sin dueño a propósito: quién contesta cada una lo decide Edgar (`[RD.103]`–`[RD.106]`), y la pantalla lo declara | — | 2026-11-03 |

---

## 5. Riesgos y bloqueos

| Bloqueo | Dueño | Causa | Qué lo destraba |
|---|---|---|---|
| Quién contesta cada pregunta | Edgar | Lupita las planteó; su puesto no está medido y algunas son de RH (asistencia) o de Dirección (chofer vs ruta) | Asignar dueño desde la pantalla (DP.2.2) |
| Registrar la prueba en `database/run-all-tests.js` | Edgar | El archivo tiene un cambio ajeno en el índice; commitearlo con pathspec arrastraría ese cambio | Que su autor lo commitee, o permiso para hacerlo juntos |
| Cupo | Edgar | 7 fases 🔨 contra 4 | Cerrar o pasar a ⏸️ tres |

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

## 7. Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
| 2026-11-03 | Fase abierta. C0 (tablas + 17 preguntas) y C1 (contrato + adaptador de tarea) en código | Edgar (abre) · Claude |
