# Fase nueva, anexo de alcance o plan de implementación

Plantilla base: `docs/IMPLEMENTACION/FASES/_PLANTILLA_FASE.md`. Método: `docs/METODO_DE_TRABAJO.md`.
Modelos buenos que copiar en forma: `FASE_CG_ALCANCE_2026-10-16.md` (alcance medido),
`FASE_CGA_PLAN_IMPLEMENTACION.md` (orden de frentes), `FASE_VAC_VERIFICADOR_ACOPLE_ESTANDAR.md`
(decisiones D1–D5 + hallazgos por capa).

## 0. ¿Fase nueva, item o anexo?

| Situación | Qué se crea |
|---|---|
| El tema ya tiene doc en `FASES/` o fila en el roadmap | **Item** en esa fase, o **anexo** si cambia el alcance |
| No existe, hay cupo (`tablero.js`) y hay métrica medible hoy | **Fase nueva** |
| No existe y no hay cupo | Doc con cabecera y estado ⬜/⏸️ — **no se abre**; se dice qué habría que cerrar para hacerle lugar |
| No hay forma de medir el «HOY» | Fase ⬜ cuyo primer item es medirlo |

Buscar antes: `ls docs/IMPLEMENTACION/FASES | grep -i <tema>` y
`grep -n '| \*\*<XX>\*\*' docs/IMPLEMENTACION/00_ROADMAP_FASES_DETALLE.md`.

## 1. Orden del documento

1. **Cabecera** del método: OBJETIVO · MÉTRICA (HOY medido con fecha → META con fecha) · CAPA TOPE ·
   ÁREA · DUEÑO · ESTADO. Debajo: con qué se midió (`system_identifier`, ventana, sólo lectura).
2. **«En una pantalla»**: qué es el módulo/problema en 5–10 líneas y una tabla de evidencia.
3. **Cómo cambió el pedido** (si cambió): tabla `# | lo que se pidió (cita) | efecto`, y qué deroga.
4. **El universo medido** vs **el trabajo**: dos números distintos, dichos como distintos.
5. **Lo que creíamos y cayó**: `# | lo que decía | lo que midió prod`.
6. **Decisiones a firmar**: `# | decisión | opciones | recomendación (con porqué)`. Marcar ✅ firmada,
   quién y cuándo.
7. **Qué NO incluye**, y lo que queda fuera por regla del repo (CORS, credenciales…).
8. **El orden**: frentes o capas, `orden | frente | por qué va ahí` usando los criterios de
   priorización (`criterios.md` §1).
9. **Las capas C0→C3** con sus items (formato en `items.md`). Una capa no se planea en detalle
   hasta que la de abajo tiene árbitro.
10. **Riesgos y bloqueos**: `bloqueo | dueño | causa | qué lo destraba`. Sin dueño no es bloqueo.
11. **DoD** (las 7) como casillas, y **bitácora**.

## 2. Al terminar el doc

- Fila en el roadmap de `CLAUDE.md` (sin fila no existe) — sólo si pasa a 🔨 con cupo.
- Items en `01_TRACKER_PROGRESO.md` bajo una sección de la fase, con enlace al plan.
- Si se tomó una decisión técnica: ADR en `02_DECISIONES_ARQUITECTURA.md`.
- Decirle al PM: qué firma necesita, qué se midió, qué quedó NO MEDIDO y qué se propone pasar a ⏸️.

## 3. Lo que hace un plan malo (rechazarlo)

- «HOY» estimado o copiado de un doc viejo sin re-medir (VAC: «cifra de hace cinco semanas, a re-medir»).
- C3 detallado con C0 sin árbitro.
- Una sola cifra grande sin separar universo de trabajo.
- Decisiones de negocio resueltas en silencio dentro del código.
- Ningún «qué NO incluye».
- Una fase más cuando hay 15 🔨: el plan correcto es cuál cerrar.
