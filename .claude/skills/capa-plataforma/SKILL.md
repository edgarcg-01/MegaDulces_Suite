---
name: capa-plataforma
description: Capa C4 (Plataforma) de la suite — todo lo que hace que el código corra en producción - CI y sus compuertas, ci-green, el despliegue en k3s del servidor md, migraciones en prod, feeds e ingesta del ODS, crons, secretos, variables de entorno y salud del sistema. OBLIGATORIO antes de tocar workflows de CI, Dockerfile, ops/, k3s, variables de entorno, crons, feeds, CORS o credenciales, y antes de afirmar que algo "ya está en prod". Enruta el carril de entrega a la skill `entrega`. Se invoca con infraestructura, infra, CI, pipeline, GitHub Actions, Docker, k3s, kubectl, servidor, prod, producción, deploy, health, cron, feed, ingesta, ODS caído, variable de entorno, .env, secreto, credencial, CORS, rendimiento del servidor, "se cayó", "no llega a prod".
---

# C4 · Plataforma — nada está hecho hasta que corre en prod

> C4 no secuencia como C0→C3: **atraviesa** a todas. Un cambio de cualquier capa termina aquí, y
> la DoD 7 del método lo dice sin rodeos: **está en prod, o está escrito por qué no y qué falta**.
> El carril commit → CI → `ci-green` → soltar → migraciones es de la skill
> [`entrega`](../entrega/SKILL.md) y se carga **antes** de tocarlo. Esta skill es el mapa de la
> plataforma y las preguntas que se hacen antes de cambiarla.

## El mapa (verifícalo, no lo recuerdes)

La fuente es «Datos del entorno» en [`CLAUDE.md`](../../../CLAUDE.md) y lo medido en
[`ops/README.md`](../../../ops/README.md). Lo esencial:

- **Prod es el servidor `md`, en k3s** (namespaces `prod` e `ingesta`). Railway es la prod
  **vieja y congelada**; cualquier herramienta que todavía apunte ahí mide el lugar equivocado.
- La prueba de que algo llegó es **`/api/health`** con el commit esperado. «Ya lo solté» no es
  evidencia: soltar no es desplegar (`entrega` §4).
- **El despliegue no es automático hoy**: el gatillo es `prod-release`. Confirma el mecanismo
  vigente antes de prometer un despliegue.
- La ingesta del ODS corre en `md`; qué corre dónde está en `ops/README.md`.

## Antes de cambiar algo de plataforma

1. **¿Es reversible?** Un cambio de CI, de variables de entorno, de crons o de k3s puede tumbar
   prod o dejar ciega la ingesta sin dar error. Si no es reversible en un paso, es decisión de
   Edgar (D*n* en la ficha de [`criterio`](../criterio/SKILL.md)).
2. **¿Toca algo prohibido?** CORS y credenciales: solo con autorización explícita (regla 7).
   Push, PR, ramas: regla 6 y 8. Escrituras pesadas en horario hábil: regla 9.
3. **¿El repo es público?** Sí. Nada de secretos, IPs nuevas ni cifras del negocio en un `.md`,
   en un commit o en un log. `gitleaks` es compuerta obligatoria de `main`.
4. **¿Quién más depende?** Un cambio en un feed o en un rol de base afecta a todos los
   consumidores: ver `GOTCHAS.md` §13–§18, §30, §35–§36 (feeds y CDC), §24–§25 (bases y roles).

## Reglas por tema

| Tema | Regla | Dónde está |
|---|---|---|
| **Migraciones en prod** | Una por una con `database/scripts/apply-one-migration-prod.js`, **antes** de soltar el código que las usa. Nunca `migrate:latest` | `entrega` §4–§5 |
| **Índices y `ALTER TABLE`** | Un `ALTER` que espera candado encola a todos detrás (y tumba el login); `CREATE INDEX CONCURRENTLY` fuera del aplicador | `GOTCHAS.md` §38, `entrega` §5 |
| **Compuertas** | Toda compuerta nueva tiene `--self-test` y **se rompió a propósito una vez** | Regla 12, DoD 4 |
| **Una compuerta que frena** | Se arregla el defecto o se arregla la compuerta (con prueba negativa). ⛔ Nunca `--no-verify` | `entrega` §3 |
| **Crons** | La zona horaria tiene trampa | `GOTCHAS.md` §7 |
| **Feeds** | «Proceso vivo» no es «feed vivo»; «tarea Running» no significa que corra. Se verifica con el dato que llega | `GOTCHAS.md` §13, §30, §35 |
| **Importer a mano** | Si existe su tarea programada, te lo matan a los 13 min | `GOTCHAS.md` §39 |
| **Variables de entorno** | Documentadas en `docs/VARIABLES_DE_ENTORNO.md`. `DATABASE_URL` y `DATABASE_URL_NEW` tienen que ser la misma base física | `GOTCHAS.md` §17, §25 |
| **Local** | ⛔ No levantar ni compilar el backend en local; el desarrollo usa el stack Docker con destino seguro | Regla 3 |

## Verificado cuando

- [ ] El CI de `main` está verde con el commit (`Build & typecheck (affected)` + `Secret scan`).
- [ ] `ci-green` se movió a ese commit.
- [ ] Las migraciones pendientes se aplicaron **una por una**, y se confirmaron por columnas
      (`pg_attribute`), no por el registro.
- [ ] `/api/health` responde con el commit esperado.
- [ ] Si tocaste un feed o un cron: el **dato** llegó (consulta con fecha), no solo el proceso.
- [ ] Nada sensible quedó en el repo público.

## Lo que se reporta

```text
C4  commit <sha> — CI ✓ · ci-green ✓ · migraciones: <lista> aplicadas una por una ✓
    prod: /api/health → <sha> (<hora>) | ⛔ no llegó: <por qué> · falta: <qué>
```
