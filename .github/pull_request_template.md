<!--
  Plantilla de PR. Borrá lo que no aplique, pero NO borres el checklist:
  esas casillas son las reglas que ya nos costaron caro (ver ONBOARDING.md §6).
-->

## Qué hace este PR

<!-- 1-3 líneas. Qué cambia y por qué. -->

## Item del tracker

<!-- Código entre brackets, ej: [RA.11]. Debe coincidir con 01_TRACKER_PROGRESO.md -->
- Item: `[ ]`

## Cómo se probó

<!-- Comandos corridos + resultado. Ej: "npm run regression → 19/19 verde" -->

---

## Checklist (obligatorio)

- [ ] El build de las 4 apps pasa (`nx run-many -t build -p api view portal vendor --configuration=production`).
- [ ] Lint + test de lo afectado pasan (`nx affected -t lint`, `nx affected -t test`).
- [ ] **No borré** tablas, columnas ni migraciones aplicadas.
- [ ] Migraciones nuevas son **idempotentes** (`hasColumn`/`hasTable` antes de crear).
- [ ] Tablas nuevas tienen `tenant_id` + audit fields + RLS forzado.
- [ ] **No hay secretos** en el diff (revisá que gitleaks pase).
- [ ] Usé `Logger` de NestJS, no `console.log`, en código nuevo.
- [ ] Actualicé `01_TRACKER_PROGRESO.md` (y `03_LOG_REVISIONES.md` si cerré un sprint).
- [ ] Si tomé una decisión técnica relevante, agregué un ADR en `02_DECISIONES_ARQUITECTURA.md`.
- [ ] Si toqué UI, respeté `DESIGN.md` (y verifiqué dark mode).
