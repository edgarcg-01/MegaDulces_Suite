# Tablero («¿cómo vamos?», «¿qué sigue?») y comunicación

## 0. Dónde vive el control del PM

**GitHub Project privado «Tablero PM — Mega Dulces Suite»**
(`https://github.com/users/edgarcg-01/projects/2`, nº 2, dueño `edgarcg-01`), con una **issue por
fase** en el repo **privado** `edgarcg-01/MegaDulces_PM` (creado 2026-10-19 con 41 fases vivas).

- **Qué va ahí:** quién, cuándo y estado del PROYECTO. Campos: **Status** (el nativo de GitHub,
  con opciones Por hacer · En curso · Probado · En producción · Bloqueado · En pausa · Cerrado) · Dueño · Cierre
  comprometido · Área · Métrica (hoy → meta) · Prioridad (1–5, `criterios.md` §1) · Fase · Última
  revisión.
- **Qué NO va ahí:** las tareas técnicas. Siguen en `01_TRACKER_PROGRESO.md`. Una sola verdad por
  nivel.
- ⛔ **Nunca en el repo público** `MegaDulces_Suite`: sus issues son públicas.
- Leer: `gh project item-list 2 --owner edgarcg-01 --format json`. Editar un campo:
  `gh project item-edit --id <item> --project-id PVT_kwHOA7xW8s4BnyCF --field-id <campo> …`
  (ids con `gh project field-list 2 --owner edgarcg-01 --format json`).
- Regla del tablero: **«En curso» ≤ 4**. Dueño y cierre se llenan **en la ronda con cada persona**,
  nunca a ojo.
- **Más estructura (2026-10-20):**
  - **Etiquetas de tipo:** `fase` · `bug` · `ops` · `seguridad` · `urgente` · `auditoría`.
  - **Área** y **Prioridad** (1–5, `criterios.md` §1) en cada tarjeta.
  - **Semana** (campo de iteración, ciclos de 7 días desde el lunes 2026-10-19): toda tarjeta En curso
    lleva la semana actual; al planear la junta del lunes se mueve a la siguiente.
  - **Sub-tareas** (`POST repos/edgarcg-01/MegaDulces_PM/issues/<padre>/sub_issues` con el `id` numérico
    del hijo): para urgencias y bugs con pasos; la barra «Sub-issues progress» mide el avance. Las
    sub-tareas **no** se agregan al tablero: el tablero queda a nivel fase.
  - **Reporte de estado** semanal del proyecto (mutación `createProjectV2StatusUpdate`, status
    `ON_TRACK|AT_RISK|OFF_TRACK`, `startDate`/`targetDate` de la semana): avance con cifras, lo que
    está en riesgo con dueño, carga por persona. Es lo que lee Dirección.
  - El dueño de Edgar se escribe **"Edgar"** (él es también el PM); un dev sin invitación aceptada
    **no se puede asignar** (GitHub lo descarta en silencio): sólo se pone en el campo Dueño.
  - Las **vistas** (tablero, por dueño, por área, urgente) no se crean por API: se hacen en la web.
- Si el roadmap de `CLAUDE.md` y el Project discrepan en una fase, se dice cuál cambió y se alinean;
  no se elige uno en silencio.

## 1. Tablero

```bash
node .claude/skills/pm/tablero.js              # fases por estado + cupo
node .claude/skills/pm/tablero.js CGA VAC CSU  # + items y commits de esas fases
```

El script cuenta; la lectura la hace el PM:

- **Cupo**: si hay más de 4 🔨, la respuesta a «¿qué sigue?» empieza por **qué cerrar o pasar a ⏸️**,
  no por qué abrir. Proponer cuáles, con el criterio de `criterios.md` §1 (la que no sangra dinero
  y no tiene dueño/fecha cae primero).
- **Commits sin items** → trabajo no registrado: pedir que se asiente antes de seguir.
- **⚠️ sin dueño o sin causa** → «bloqueo anónimo»: o gana dueño, o se cierra.
- **🧪 viejos** → ¿qué le falta para 🚀? Si nadie lo sabe, ⏸️ o ❌.
- **Fase 🔨 sin dueño o sin fecha** → cae a ⏸️ (método §3).

Formato de respuesta: 1) el estado en 3 líneas con cifras, 2) lo que hay que decidir hoy, 3) la
propuesta ordenada. Nada de recap largo.

## 2. Notas de versión / CHANGELOG

- Fuente: `git log --since=<fecha> --pretty='%h %ad %s' --date=short main`, agrupado por código
  `[XX.N]` y cruzado con el tracker.
- Destino: `CHANGELOG.md` — una entrada por fecha, Added / Changed / Fixed / Internal.
- ⚠️ **En `main` no es en prod.** Empujar a `main` deja el commit sellado; producción la mueve
  `prod-release` (`ops/prod/soltar.sh`), y `CLAUDE.md` dice que el cron de `auto-deploy.sh` está
  comentado — confirmar el mecanismo vigente antes de prometer un despliegue. Decir «en
  prod» sólo si se comprobó (`curl http://192.168.0.222:30080/api/health` + imagen desplegada); si
  no, «en `main`».

## 3. Reporte para Dirección / negocio

Lector: quien decide con dinero, no lee código. Reglas:

- Sin códigos internos ni nombres de tablas. El puesto que lo usa y lo que cambia en su día.
- **Montos con unidad y periodo** («$213,940 de venta de 3 días que no llegó al libro»), y de dónde
  sale cada cifra en una línea.
- Separar **hecho medido** de **conclusión** y de **NO MEDIDO**.
- Qué **no** cambió todavía y qué decisión se necesita de ellos (con opciones y recomendación).
- Si va a otras personas, publicarlo (Artifact o Claude Docs) en vez de dejarlo en el chat.
