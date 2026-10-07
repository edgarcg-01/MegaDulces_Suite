# Fase A — Fundaciones (fix de limitaciones)

**Duración estimada:** 6-8 semanas (1 dev fullstack)
**Objetivo:** dejar la base técnica lista para soportar el crecimiento de los próximos pilares. Sin features nuevas para el usuario final.

---

## Pre-requisitos

- [x] Repo accesible
- [x] Acceso admin a Railway
- [ ] Cuenta GitHub con permisos para crear branches protegidas
- [ ] Tarjeta de crédito disponible para servicios SaaS (Sentry, Mapbox, Resend, eventualmente WhatsApp BSP)

---

## Sprints

### Sprint A.0 — Limpieza inmediata + trámites externos (3-5 días)

> **Objetivo:** sacar deuda técnica visible y arrancar el reloj de los trámites con tiempos calendario largos.

#### A.0.1 — Borrar archivos `.js` duplicados
**Contexto:** en `apps/api/src/**` hay archivos `.js` compilados al lado de los `.ts` checkeados en git. Confunden y pueden divergir.

**Acción:**
```bash
# Listar candidatos
find apps/api/src -name "*.js" -not -path "*/node_modules/*"

# Borrar (cuidado, verificar primero):
find apps/api/src -name "*.js" -not -path "*/node_modules/*" -delete
```

**Validación:** `nx build api --prod` sigue funcionando.

---

#### A.0.2 — Actualizar `.gitignore`
Agregar al `.gitignore` raíz:
```gitignore
# Build artifacts dentro del source
apps/api/src/**/*.js
apps/api/src/**/*.js.map
apps/api/src/**/*.d.ts

# Excepción: archivos JS legítimos (configs, scripts)
!apps/api/src/main.js
```

**Validación:** `git status` no muestra archivos `.js` no rastreados después de un build.

---

#### A.0.3 — README con setup del proyecto
Documentar en `README.md`:
- Versión de Node requerida (asumir Node 20 LTS, que es lo que usa el Dockerfile)
- Versión de npm
- Versión de Nx
- Comandos para `dev`, `build`, `test`
- Variables de entorno requeridas (sin valores reales)
- Cómo levantar la DB local (Postgres + knex migrate)

---

#### A.0.4 — Iniciar trámite WhatsApp Business
**Acción:** ya que toma 6-12 semanas calendario, arrancar HOY aunque no se use hasta Fase F.

1. Comparar BSPs: 360dialog, Wati, Gupshup, Twilio. Documentar comparación en ADR-006.
2. Decidir BSP. Crear cuenta business.
3. Iniciar verificación con Meta (documentos legales de Mega Dulces).
4. Cuando esté aprobado, guardar credenciales para Fase F.

**Validación:** ADR-006 actualizado con BSP elegido + cuenta creada.

---

### Sprint A.1 — Observabilidad (5-7 días)

> **Objetivo:** que cualquier crash o error deje pista clara. Hoy estamos a ciegas.

#### A.1.1 — Sentry account + DSN
1. Crear cuenta en sentry.io (free tier soporta 5K events/mes).
2. Crear proyecto "trade-marketing-api" (Node).
3. Crear proyecto "trade-marketing-view" (Angular).
4. Guardar los 2 DSN.

#### A.1.2 — Sentry SDK NestJS
```bash
npm install --workspace=apps/api @sentry/nestjs @sentry/profiling-node
```

En `apps/api/src/main.ts` (antes de NestFactory.create):
```ts
import * as Sentry from '@sentry/nestjs';
import { nodeProfilingIntegration } from '@sentry/profiling-node';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
  integrations: [nodeProfilingIntegration()],
  tracesSampleRate: 0.1,
  profilesSampleRate: 0.1,
});
```

#### A.1.3 — Sentry SDK Angular
```bash
npm install --workspace=apps/view @sentry/angular
```

En `apps/view/src/main.ts`:
```ts
import * as Sentry from '@sentry/angular';

Sentry.init({
  dsn: 'TU_DSN',
  environment: 'production',
  tracesSampleRate: 0.1,
});
```

#### A.1.4 — Validar end-to-end
Agregar endpoint temporal en API:
```ts
@Get('debug/throw')
debugThrow() {
  throw new Error('Sentry test from API');
}
```

Botón temporal en Angular:
```ts
testSentry() { throw new Error('Sentry test from Angular'); }
```

Llamar a ambos, validar que aparecen en el dashboard de Sentry. Quitar ambos cuando confirme.

#### A.1.5 — Pino logger
```bash
npm install --workspace=apps/api pino nestjs-pino pino-http
```

Configurar en `app.module.ts`:
```ts
import { LoggerModule } from 'nestjs-pino';

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL || 'info',
        formatters: { level: (label) => ({ level: label }) },
        // En dev: pretty print. En prod: JSON puro.
        transport: process.env.NODE_ENV !== 'production'
          ? { target: 'pino-pretty' }
          : undefined,
      },
    }),
    // ... resto
  ],
})
```

#### A.1.6 — Reemplazar `console.log`
Buscar y reemplazar:
```bash
grep -rn "console.log\|console.error" apps/api/src --include="*.ts"
```

Reemplazar cada uno por `this.logger.log(...)` o `this.logger.error(...)`.

**Validación:** logs en Railway aparecen en JSON estructurado parseable.

---

### Sprint A.2 — Staging environment + CI (5-7 días)

> **Objetivo:** todo cambio se valida antes de tocar prod.

#### A.2.1 — Branch `staging` en GitHub
```bash
git checkout main
git checkout -b staging
git push -u origin staging
```

#### A.2.2 — Servicio staging en Railway
1. En Railway: crear nuevo servicio "trade-marketing-staging".
2. Conectarlo a la branch `staging` del repo.
3. Variables de entorno copiadas de prod, pero apuntando a DB de staging (crear DB separada).
4. Mismas integraciones (Cloudinary, Sentry) con proyectos/folders separados.

#### A.2.3 — DB de staging
- Crear servicio Postgres separado en Railway (mismo proyecto).
- DATABASE_URL distinto para staging.
- Migraciones corren igual (vía `start.sh`).
- Seeds básicos.

#### A.2.4 — GitHub Actions CI
Crear `.github/workflows/ci.yml`:
```yaml
name: CI
on:
  pull_request:
    branches: [main, staging]
  push:
    branches: [staging]

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm' }
      - run: npm ci
      - run: npx nx affected -t lint --base=origin/main
      - run: npx nx affected -t test --base=origin/main
      - run: npx nx affected -t build --base=origin/main
```

#### A.2.5 — Branch protection rules
En GitHub → Settings → Branches:
- `main`: requiere PR + CI verde + review (en este caso review por el mismo dev pero al menos pause).
- `staging`: requiere CI verde.
- Disable force-push en ambas.

#### A.2.6 — Workflow staging → main
1. Trabajo de día a día en branches feature → PR → `staging`.
2. Railway deploya automáticamente a staging.
3. Tras smoke test manual, merge `staging → main` → deploy a prod.

**Validación:** un PR de prueba que falla CI bloquea el merge.

---

### Sprint A.3 — Tests base (5-7 días)

> **Objetivo:** infrastructure de testing lista para que cada feature nueva traiga tests.

#### A.3.1 — Verificar Jest en `apps/api`
Nx normalmente configura Jest. Validar:
```bash
nx test api
```

Si no funciona: configurar.

#### A.3.2 — Tests del `permissions-cache.service`
Archivo: `apps/api/src/shared/ability/permissions-cache.service.spec.ts`
- Test: cache hit (mismo role dentro del TTL → no consulta DB).
- Test: cache miss (después del TTL → consulta DB).
- Test: invalidación borra entry.
- Test: roleName vacío devuelve {}.

#### A.3.3 — Tests del `roles.guard`
- Test: usuario sin permiso → ForbiddenException.
- Test: usuario con `manage:all` → permitido sin importar requerimientos.
- Test: usuario con permiso específico → permitido.

#### A.3.4 — Tests de `scoring-v2.service`
- Test: cálculo de score con config conocida.
- Test: niveles desconocidos → fallback.

#### A.3.5 — Cypress smoke
Setup: `nx g @nx/cypress:configuration apps/view-e2e`
Test smoke: login → llegar al dashboard.

**Validación:** `nx test api` y `nx e2e view-e2e` pasan en CI.

---

### Sprint A.4 — Redis + BullMQ (5-7 días)

> **Objetivo:** tener queue funcional. Primer use case: envío de email (aunque no se mande nada real aún).

#### A.4.1 — Servicio Redis en Railway
1. En Railway: agregar plugin Redis.
2. Variable `REDIS_URL` disponible en el servicio API.

#### A.4.2 — BullMQ
```bash
npm install --workspace=apps/api @nestjs/bullmq bullmq
```

#### A.4.3 — Queue module
Crear `apps/api/src/shared/queue/queue.module.ts`:
```ts
import { BullModule } from '@nestjs/bullmq';

@Global()
@Module({
  imports: [
    BullModule.forRoot({
      connection: {
        host: new URL(process.env.REDIS_URL).hostname,
        port: parseInt(new URL(process.env.REDIS_URL).port),
        password: new URL(process.env.REDIS_URL).password,
      },
    }),
  ],
})
export class QueueModule {}
```

Registrar en `AppModule`.

#### A.4.4 — Primera queue: `emails`
- Definir queue `emails` + processor.
- Endpoint admin `POST /admin/test-email` que solo encolar (no enviar realmente).
- Worker que recibe el job y solo logguea.

**Validación:** llamar al endpoint → ver en logs que el worker procesó el job.

#### A.4.5 — Health check Redis
Endpoint `GET /health-redis` que ping a Redis y devuelve `{ ok: true }`.

---

### Sprint A.5 — Tipos compartidos (3 días)

> **Objetivo:** dejar de duplicar interfaces entre `apps/api` y `apps/view`.

#### A.5.1 — Crear lib
```bash
nx g @nx/js:library shared-domain-types --directory=libs/shared-domain-types --buildable
```

#### A.5.2 — Mover interfaces clave
Identificar interfaces duplicadas en `apps/api` y `apps/view`:
- `User`, `Permission`, `Role`
- `Visit`, `Exhibition`
- `DailyCapture`
- `Store`, `Zone`, `Route`

Moverlas a `libs/shared-domain-types/src/lib/` agrupadas por dominio.

#### A.5.3 — Actualizar imports
Buscar usos viejos:
```bash
grep -rn "interface User\|interface Visit" apps/ --include="*.ts"
```

Reemplazar por `import { User } from '@trade-marketing/shared-domain-types'`.

#### A.5.4 — Validar
`nx build api --prod && nx build view --prod` pasan.

---

### Sprint A.6 — Decisión multi-tenancy (3 días)

#### A.6.1 — ADR-003 completo
Documentar la decisión en ADR-003. Discusión con stakeholders:
- ¿Mega Dulces planea licenciar el sistema a otras distribuidoras?
- Si SÍ → multi-tenant desde Fase B (`tenant_id` en cada nueva tabla).
- Si NO → single-tenant, decisión revisable en 12 meses.

#### A.6.2 — Si se decide multi-tenant
- Planear schema con `tenant_id` para tablas NUEVAS.
- NO migrar tablas existentes en esta fase (se hace al inicio de Fase B).
- Documentar la convención.

---

### Sprint A.7 — Checkpoint Fase A (3 días)

#### A.7.1 — Smoke test completo en staging
- Login admin → ver reports → cambiar permisos → logout.
- Login capturista → registrar visita con foto → ver en reports.
- Validar que Sentry capturó al menos 1 evento durante el smoke.

#### A.7.2 — Validar Sentry reporta errores reales
- Forzar un error en algún endpoint protegido.
- Confirmar en dashboard Sentry.

#### A.7.3 — Validar CI bloquea PR roto
- Hacer PR con test deliberadamente roto.
- CI rojo, no se puede mergear.

#### A.7.4 — README actualizado
- Incluir secciones: dev setup, env vars, comandos comunes, troubleshooting.

#### A.7.5 — Cerrar checkpoint
Agregar entrada en `03_LOG_REVISIONES.md` con resumen de la Fase A: qué se logró, qué quedó pendiente, lecciones aprendidas.

---

## Entregables al cierre de Fase A

- ✅ Sentry capturando errores en API y frontend.
- ✅ Pino logueando estructurado en JSON.
- ✅ Staging environment funcionando.
- ✅ CI bloqueando PRs rotos.
- ✅ Suite de tests inicial (al menos 10 tests pasando).
- ✅ Redis + BullMQ operando con primera queue.
- ✅ Lib `shared-domain-types` creada y poblada.
- ✅ Decisión de multi-tenancy documentada en ADR-003.
- ✅ Trámite WhatsApp Business arrancado.
- ✅ README con setup completo.
- ✅ 8 archivos `.js` duplicados borrados (o cuantos hayan).

---

## Métricas de éxito

- **Tiempo medio de boot del API**: medir antes y después (objetivo: no empeorar).
- **Errores capturados en Sentry primera semana**: validar que hay tracking.
- **Cobertura de tests**: al menos 20% en `apps/api` (objetivo bajo para arrancar).
- **Tiempo de CI**: < 5 min total.

---

## Riesgos

| Riesgo | Mitigación |
|---|---|
| Trámite WhatsApp tarda más de 12 sem | Empezar en Sprint A.0 (primera semana) → margen de 4 sem buffer |
| Setup de tests bloquea el sprint | Si Sprint A.3 se atasca, mover a backlog y avanzar con resto |
| Pino formatea logs raro en Railway | Validar en staging antes de prod |
| BullMQ tiene problemas con Redis de Railway | Plan B: usar in-memory para dev, Redis externo si Railway falla |

---

## Cuándo se considera cerrada

Cuando los 7 sprints (A.0 → A.7) tienen TODOS sus items en ✅ Hecho en el tracker, y se agrega la entrada de cierre en `03_LOG_REVISIONES.md`.

Entonces, y solo entonces, se abre Fase B.
