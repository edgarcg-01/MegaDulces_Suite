# 📖 Documentación — Trade Marketing en Campo

> **Responsabilidad:** API Reference (Swagger), guías de usuario, onboarding de desarrolladores, changelogs, manuales y ADRs.

---

## 1. Inventario de Documentos

### 1.1 Documentos Existentes

| Archivo | Ubicación | Estado |
|---|---|---|
| `ARCHITECTURE.md` | `/docs/` | ✅ Creado — Filosofía de Bounded Contexts |
| `README.md` (docs) | `/docs/` | ✅ Creado — Índice de documentación |
| `README.md` (root) | `/` | ⚠️ Default NestJS — **Requiere actualización** |
| `ESPECIFICACIONES_TECNICAS.md` | `/docs/` | ✅ Creado — Documento maestro |

### 1.2 Documentos por Crear

| Archivo | Ubicación | Descripción | Fase |
|---|---|---|---|
| `API_REFERENCE.md` | `/docs/` | Generado desde Swagger | Fase 1 |
| `DATABASE_SCHEMA.md` | `/docs/` | ERD + DDL oficial | Fase 1 |
| `SETUP_GUIDE.md` | `/docs/` | Guía de setup para nuevos devs | Fase 1 |
| `CHANGELOG.md` | `/` | Registro de cambios por versión | Fase 1+ |
| `SCORING_RULES.md` | `/docs/` | Reglas de scoring con ejemplos | Fase 2 |
| `USER_MANUAL.md` | `/docs/` | Manual de usuario final | Fase 3 |
| `DEPLOYMENT.md` | `/docs/` | Guía de deployment y CI/CD | Fase 5 |
| `RUNBOOK.md` | `/docs/` | Procedimientos operativos | Fase 5 |

## 2. README.md Actualizado (Template)

```markdown
# 🏗️ Trade Marketing en Campo — Backend API

> Sistema de Control y Evaluación para Trade Marketing en campo.
> NestJS + PostgreSQL + Knex.js

## 📋 Requisitos

- Node.js ≥ 20 LTS
- PostgreSQL ≥ 15
- npm ≥ 9

## 🚀 Setup Rápido

### 1. Clonar e instalar dependencias

\`\`\`bash
git clone <repo-url>
cd trade_marketing_backend
npm install
\`\`\`

### 2. Configurar variables de entorno

\`\`\`bash
cp .env.example .env
# Editar .env con tus credenciales de DB
\`\`\`

### 3. Crear la base de datos

\`\`\`bash
createdb trade_marketing
\`\`\`

### 4. Ejecutar migraciones y seeds

\`\`\`bash
npx knex migrate:latest --knexfile knexfile.ts
npx knex seed:run --knexfile knexfile.ts
\`\`\`

### 5. Iniciar el servidor

\`\`\`bash
npm run start:dev
\`\`\`

El servidor arranca en `http://localhost:3000`

## 📚 Documentación

- [Arquitectura](./docs/ARCHITECTURE.md)
- [API Reference](./docs/API_REFERENCE.md)
- [Esquema de BD](./docs/DATABASE_SCHEMA.md)
- [Especificaciones Técnicas](./docs/ESPECIFICACIONES_TECNICAS.md)
- [Documentos por Área](./docs/areas/)

## 🧪 Testing

\`\`\`bash
npm run test          # Unit tests
npm run test:cov      # Cobertura
npm run test:e2e      # End-to-end
\`\`\`

## 👥 Usuarios de Prueba

| Rol | Usuario | Contraseña |
|---|---|---|
| 👑 Super Admin | admin | admin123 |
| 📋 Ejecutivo | ejecutivo1 | campo123 |
| 📊 Reportes | reportes1 | reportes123 |
```

## 3. Swagger / OpenAPI

### 3.1 Setup en NestJS

```typescript
// main.ts
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';

const config = new DocumentBuilder()
  .setTitle('Trade Marketing API')
  .setDescription('API para el sistema de Trade Marketing en Campo')
  .setVersion('1.0')
  .addBearerAuth()
  .addTag('auth', 'Autenticación y JWT')
  .addTag('users', 'Gestión de usuarios')
  .addTag('captures', 'Capturas KPI periódicas')
  .addTag('daily-captures', 'Capturas diarias de campo')
  .addTag('visits', 'Check-in/out y exhibiciones')
  .addTag('planograma', 'Gestión de planograma')
  .addTag('catalogs', 'Catálogos configurables')
  .addTag('scoring', 'Motor de scoring')
  .addTag('reports', 'Reportes y analytics')
  .build();

const document = SwaggerModule.createDocument(app, config);
SwaggerModule.setup('api/docs', app, document);
```

### 3.2 Decoradores en DTOs

```typescript
// dto/login.dto.ts
import { ApiProperty } from '@nestjs/swagger';

export class LoginDto {
  @ApiProperty({ example: 'admin', description: 'Nombre de usuario' })
  username: string;

  @ApiProperty({ example: 'admin123', description: 'Contraseña' })
  password: string;
}
```

### 3.3 Decoradores en Controllers

```typescript
@ApiTags('auth')
@Controller('auth')
export class AuthController {

  @Post('login')
  @ApiOperation({ summary: 'Login de usuario' })
  @ApiResponse({ status: 200, description: 'JWT token generado' })
  @ApiResponse({ status: 401, description: 'Credenciales incorrectas' })
  async login(@Body() dto: LoginDto) { ... }
}
```

## 4. Changelog (Template)

```markdown
# Changelog

## [0.1.0] - 2026-03-30 (Fase 0)

### Added
- Proyecto NestJS inicializado con TypeScript
- Configuración de Knex.js + PostgreSQL
- Migraciones: `users`, `role_permissions`, `captures`
- `RequireAuthGuard` (JWT verification)
- `@ReqUser()` decorator
- `AuthModule` con `JwtModule.register()` global
- Documentación de arquitectura (ARCHITECTURE.md)

## [0.2.0] - TBD (Fase 1)

### Added
- POST /auth/login con bcrypt + JWT
- GET /auth/profile
- RolesGuard + @Roles() decorator
- CRUD /users (superadmin only)
- POST/GET /captures con folio automático
- POST/GET /daily-captures
- Swagger UI en /api/docs
- Seeds: roles, usuarios, defaults
```

## 5. ADR Template (Architecture Decision Records)

```markdown
# ADR-XXX: [Título de la decisión]

## Estado
Propuesto | Aceptado | Deprecado | Reemplazado por ADR-YYY

## Contexto
[Qué problema estamos resolviendo]

## Decisión
[Qué decidimos hacer]

## Consecuencias
### Positivas
- ...

### Negativas
- ...

### Riesgos
- ...

## Notas
[Referencias, links, discusiones]
```

## 6. `.env.example` (Template)

```bash
# === Base de Datos ===
DB_HOST=localhost
DB_PORT=5432
DB_NAME=trade_marketing
DB_USER=postgres
DB_PASSWORD=tu_password_aqui

# === JWT ===
JWT_SECRET=cambiar_este_secreto_en_produccion
JWT_EXPIRATION=8h

# === App ===
NODE_ENV=development
PORT=3000
API_PREFIX=api
```

## 7. Entregables por Fase

### Fase 1 — Backend Core 🔧

| # | Entregable | Criterio de Aceptación |
|---|---|---|
| DOC1.1 | Swagger completado | Decoradores `@ApiProperty`, `@ApiResponse` en todos los DTOs |
| DOC1.2 | README actualizado | Dev nuevo arranca en < 15 min |
| DOC1.3 | DATABASE_SCHEMA.md | ERD + DDL de todas las tablas Fase 1 |
| DOC1.4 | `.env.example` | Todas las variables documentadas |
| DOC1.5 | CHANGELOG v0.2 | Todos los cambios de Fase 1 |

### Fase 2 — Módulos de Negocio 📋

| # | Entregable | Criterio de Aceptación |
|---|---|---|
| DOC2.1 | API_REFERENCE.md actualizado | Nuevos endpoints documentados |
| DOC2.2 | SCORING_RULES.md | Tablas de pesos con ejemplos |
| DOC2.3 | CHANGELOG v0.3 | Cambios de Fase 2 |

### Fase 3 — Frontend Web 📋

| # | Entregable | Criterio de Aceptación |
|---|---|---|
| DOC3.1 | Storybook (opcional) | Componentes documentados visualmente |
| DOC3.2 | Guía de contribución frontend | Convenciones, estructura, PR template |

### Fase 5 — Infra 📋

| # | Entregable | Criterio de Aceptación |
|---|---|---|
| DOC5.1 | RUNBOOK.md | Procedimientos: deploy, rollback, backup, restore |
| DOC5.2 | DEPLOYMENT.md | CI/CD, Docker, variables de environment |
| DOC5.3 | USER_MANUAL.md | Manual con screenshots para usuarios finales |

## 8. Guía de Estilo para Documentación

### Idioma
- Código: **Inglés**
- Comentarios en código: **Español**
- Documentación externa: **Español**
- Variables de entorno: **Inglés**

### Formato
- Markdown (.md) para todo
- Diagramas en Mermaid (renderizable en GitHub)
- Ejemplos de código con syntax highlighting
- Tablas para comparativas y matrices

### Estructura de Cada Documento
1. Título con emoji identificador
2. Descripción breve (1 línea)
3. Tabla de contenidos (si > 3 secciones)
4. Contenido organizado jerárquicamente
5. Pie con última fecha de revisión

---

*Contacto: Coordinar con Dev Backend para Swagger decorators y con todos los equipos para updates de docs.*
