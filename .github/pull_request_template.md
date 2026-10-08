<!--
  Plantilla de PR. Borrá lo que no aplique, pero NO borres el checklist:
  esas casillas son las reglas que ya nos costaron caro (ver ONBOARDING.md §6).
-->

## Qué hace este PR

<!-- 1-3 líneas. Qué cambia y por qué. -->

## Cambios de comportamiento y lo que NO incluye

<!-- Qué cambia para quien YA usa esta función, quién y qué se rompe (API, permisos, orden de migraciones). Y lo que este PR deja fuera a propósito. "Ninguno" también es una respuesta. -->

## Item del tracker

<!-- Código entre brackets, ej: [RA.11]. Debe coincidir con 01_TRACKER_PROGRESO.md -->
- Item: `[ ]`

## Cómo se probó

<!-- Comandos corridos + resultado. Ej: "npm run regression → 19/19 verde" -->

---

## Antes de pedir revisión (protocolo — `ONBOARDING.md` §8.0b)

- [ ] **Este PR apunta a `main`** (no a otra rama de feature; no hay PR apilados). Si dependía de otro, esperé a que se fusionara.
- [ ] **Fusioné/rebasé `origin/main` hoy** y **volví a correr** build + tests de lo afectado después (0 commits de atraso).
- [ ] Si agrega o toca migraciones: `npm run check:mig-colisiones` en verde contra el `main` actual; la marca es la **hora real de creación**; **no renombré ni borré ninguna ya aplicada**.
- [ ] Si una migración aditiva la lee el código nuevo, el PR dice que se aplica **ANTES** del código (y su orden respecto a las demás).
- [ ] Declaré arriba los **cambios de comportamiento** y lo que **no** incluye.

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
