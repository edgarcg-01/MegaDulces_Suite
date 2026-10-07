# ⚙️ Dev Backend — Trade Marketing en Campo

> **Responsabilidad:** APIs RESTful NestJS, lógica de negocio, autenticación JWT, guards, servicios, DTOs y tests unitarios.

---

## 1. Estado Actual del Backend

### Archivos existentes

| Archivo | Estado | Descripción |
|---|---|---|
| `src/app.module.ts` | ✅ | Importa `AuthModule` |
| `src/modules/auth/auth.module.ts` | ✅ | `JwtModule.register()` global, 8h, secret |
| `src/modules/auth/auth.controller.ts` | ⚠️ **Vacío** | Solo `@Controller('auth')` — sin endpoints |
| `src/modules/auth/auth.service.ts` | ⚠️ **Vacío** | Solo `@Injectable()` — sin lógica |
| `src/shared/guards/require-auth.guard.ts` | ✅ | Extrae Bearer, verifica JWT, inyecta `request.user` |
| `src/shared/decorators/req-user.decorator.ts` | ✅ | `@ReqUser()` extrae `request.user` |
| `knexfile.ts` | ✅ | Dev (localhost:5432) + Prod (con SSL) |

### Configuración JWT actual

```typescript
JwtModule.register({
  global: true,
  secret: process.env.JWT_SECRET || 'super_secret_dev_key_change_in_prod',
  signOptions: { expiresIn: '8h' },
})
```

### JWT Payload estándar

```typescript
interface JwtPayload {
  sub:      string;   // user_id (UUID)
  username: string;   // snapshot inmutable
  zona:     string;   // zona asignada
  rol:      string;   // 'superadmin' | 'ejecutivo' | 'reportes'
  iat:      number;
  exp:      number;
}
```

## 2. Módulos a Implementar

### 2.1 Estructura objetivo

```
src/modules/
├── auth/              # BC 1: Login, JWT signing
│   ├── auth.module.ts
│   ├── auth.controller.ts     → POST /auth/login, GET /auth/profile
│   ├── auth.service.ts        → Login logic, bcrypt compare
│   └── dto/
│       └── login.dto.ts
├── users/             # BC 1 sub: Gestión de usuarios
│   ├── users.module.ts
│   ├── users.controller.ts    → CRUD /users
│   ├── users.service.ts       → Knex queries a tabla users
│   └── dto/
│       ├── create-user.dto.ts
│       └── update-user.dto.ts
├── captures/          # BC 2: Capturas KPI periódicas
│   ├── captures.module.ts
│   ├── captures.controller.ts → GET/POST /captures
│   ├── captures.service.ts
│   └── dto/
│       └── create-capture.dto.ts
├── daily-captures/    # BC 2: Capturas diarias de campo
│   ├── daily-captures.module.ts
│   ├── daily-captures.controller.ts
│   ├── daily-captures.service.ts
│   └── dto/
│       └── create-daily-capture.dto.ts
├── visits/            # BC 6: Check-in/out + Exhibiciones
│   ├── visits.module.ts
│   ├── visits.controller.ts   → POST /visits/checkin, PUT checkout
│   ├── visits.service.ts
│   ├── exhibitions.controller.ts
│   ├── exhibitions.service.ts
│   └── dto/
│       ├── checkin.dto.ts
│       └── create-exhibition.dto.ts
├── planograma/        # BC 3
│   ├── planograma.module.ts
│   ├── planograma.controller.ts
│   └── planograma.service.ts
├── catalogs/          # BC 4
│   ├── catalogs.module.ts
│   ├── catalogs.controller.ts
│   └── catalogs.service.ts
├── scoring/           # Motor de scoring
│   ├── scoring.module.ts
│   ├── scoring.service.ts     → Fórmula: peso × tipo × nivel
│   └── scoring.controller.ts  → GET/PUT config
└── reports/           # BC 5
    ├── reports.module.ts
    ├── reports.controller.ts
    └── reports.service.ts
```

## 3. API RESTful — Endpoints Completos

### Auth (`/api/auth`)

| Método | Endpoint | Body/Params | Response | Guard |
|---|---|---|---|---|
| `POST` | `/auth/login` | `{ username, password }` | `{ access_token, user }` | Ninguno |
| `GET` | `/auth/profile` | — | `JwtPayload` | `RequireAuthGuard` |
| `PUT` | `/auth/change-password` | `{ oldPassword, newPassword }` | `{ message }` | `RequireAuthGuard` |

### Users (`/api/users`)

| Método | Endpoint | Body/Params | Response | Guard |
|---|---|---|---|---|
| `GET` | `/users` | `?zona=&activo=` | `User[]` | Auth + Roles(superadmin) |
| `POST` | `/users` | `CreateUserDto` | `User` | Auth + Roles(superadmin) |
| `GET` | `/users/:id` | — | `User` | Auth + Roles(superadmin) |
| `PUT` | `/users/:id` | `UpdateUserDto` | `User` | Auth + Roles(superadmin) |
| `DELETE` | `/users/:id` | — | `{ message }` (soft delete) | Auth + Roles(superadmin) |

### Captures (`/api/captures`)

| Método | Endpoint | Body/Params | Response | Guard |
|---|---|---|---|---|
| `POST` | `/captures` | `CreateCaptureDto` | `{ folio, id }` | Auth + Roles(ejecutivo, superadmin) |
| `GET` | `/captures` | `?zona=&periodo=&fecha_inicio=&fecha_fin=&ejecutivo=` | `Capture[]` | Auth + Roles(superadmin, reportes) |
| `GET` | `/captures/:id` | — | `Capture` | Auth |
| `DELETE` | `/captures/:id` | — | `{ message }` | Auth + Roles(superadmin) |

### Daily Captures (`/api/daily-captures`)

| Método | Endpoint | Body/Params | Response | Guard |
|---|---|---|---|---|
| `POST` | `/daily-captures` | `CreateDailyCaptureDto` | `{ id }` | Auth + Roles(ejecutivo, superadmin) |
| `GET` | `/daily-captures` | `?fecha=&zona=&ejecutivo=` | `DailyCapture[]` | Auth |
| `GET` | `/daily-captures/:id` | — | `DailyCapture` | Auth |

### Visits (`/api/visits`)

| Método | Endpoint | Body/Params | Response | Guard |
|---|---|---|---|---|
| `POST` | `/visits/checkin` | `{ store_id, lat, lng }` | `{ visit_id }` | Auth + Roles(ejecutivo) |
| `PUT` | `/visits/:id/checkout` | — | `{ total_score }` | Auth |
| `GET` | `/visits` | `?fecha=&zona=&ejecutivo=` | `Visit[]` | Auth |
| `GET` | `/visits/:id` | — | `Visit` (con exhibitions) | Auth |

### Exhibitions (`/api/exhibitions`)

| Método | Endpoint | Body/Params | Response | Guard |
|---|---|---|---|---|
| `POST` | `/exhibitions` | `{ visit_id, posicion, tipo, nivel, foto }` | `{ id, score }` | Auth |
| `GET` | `/exhibitions?visit_id=` | — | `Exhibition[]` | Auth |
| `POST` | `/exhibitions/:id/photos` | `multipart/form-data` | `{ photo_url }` | Auth |

### Scoring (`/api/scoring`)

| Método | Endpoint | Body/Params | Response | Guard |
|---|---|---|---|---|
| `GET` | `/scoring/config` | — | `ScoringConfig` | Auth + Roles(superadmin) |
| `PUT` | `/scoring/config` | `{ pesos_posicion, factores_tipo, niveles }` | `ScoringConfig` | Auth + Roles(superadmin) |

### Planograma (`/api/planograma`)

| Método | Endpoint | Body/Params | Response | Guard |
|---|---|---|---|---|
| `GET` | `/planograma/brands` | — | `Brand[]` (con productos) | Auth |
| `POST` | `/planograma/brands` | `{ nombre }` | `Brand` | Auth + Roles(superadmin) |
| `POST` | `/planograma/brands/:id/products` | `{ nombre }` | `Product` | Auth + Roles(superadmin) |
| `DELETE` | `/planograma/brands/:id` | — | `{ message }` | Auth + Roles(superadmin) |
| `DELETE` | `/planograma/products/:id` | — | `{ message }` | Auth + Roles(superadmin) |

### Catálogos (`/api/catalogs`)

| Método | Endpoint | Body/Params | Response | Guard |
|---|---|---|---|---|
| `GET` | `/catalogs/:type` | — | `CatalogItem[]` | Auth |
| `POST` | `/catalogs/:type` | `{ value }` | `CatalogItem` | Auth + Roles(superadmin) |
| `DELETE` | `/catalogs/:type/:id` | — | `{ message }` | Auth + Roles(superadmin) |

### Reports (`/api/reports`)

| Método | Endpoint | Body/Params | Response | Guard |
|---|---|---|---|---|
| `GET` | `/reports/summary` | `?periodo=&fecha_inicio=&fecha_fin=` | `Summary` | Auth + Roles(superadmin, reportes) |
| `GET` | `/reports/by-zone` | `?periodo=` | `ZoneReport[]` | Auth + Roles(superadmin, reportes) |
| `GET` | `/reports/by-executive` | `?periodo=` | `ExecutiveRanking[]` | Auth + Roles(superadmin, reportes) |
| `GET` | `/reports/export/csv` | `?tipo=&filtros=` | CSV file download | Auth + Roles(superadmin, reportes) |

## 4. Guards a Implementar

### RequireAuthGuard *(ya existe)*
Verifica Bearer JWT y lo inyecta en `request.user`.

### RolesGuard *(pendiente)*

```typescript
// Uso con custom decorator:
@Roles('superadmin', 'ejecutivo')
@UseGuards(RequireAuthGuard, RolesGuard)
@Post()
async create(@ReqUser() user: JwtPayload) { ... }
```

### @Roles() Decorator *(pendiente)*

```typescript
export const ROLES_KEY = 'roles';
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
```

## 5. Scoring Engine

### Fórmula

```typescript
function calculateScore(
  posicion: string,    // 'caja' | 'adyacente' | ...
  tipo: string,        // 'exhibidor' | 'refrigerador' | ...
  nivel: string,       // 'alto' | 'medio' | 'bajo'
  hasPhoto: boolean,
  config: ScoringConfig
): number {
  if (!hasPhoto) return 0;
  
  const pesoPosicion = config.pesos_posicion[posicion] ?? 0;
  const factorTipo = config.factores_tipo[tipo] ?? 1.0;
  const nivelEjecucion = config.niveles_ejecucion[nivel] ?? 0.4;
  
  return pesoPosicion * factorTipo * nivelEjecucion;
}
```

## 6. Regla Arquitectónica CRÍTICA

> ⚠️ **NUNCA** importar un servicio/modelo de `auth/` dentro de `captures/`, `visits/`, etc.
>
> Para obtener info del usuario, **siempre** usar `@ReqUser()` que extrae los claims del JWT.
>
> ```typescript
> // ✅ CORRECTO
> @Post()
> async create(@ReqUser() user: JwtPayload, @Body() dto: CreateCaptureDto) {
>   return this.service.create(dto, user.sub, user.username, user.zona);
> }
>
> // ❌ PROHIBIDO
> async create(@Body() dto) {
>   const user = await this.usersService.findById(dto.userId); // CROSS-MODULE!
> }
> ```

## 7. Generación de Folios

```typescript
function generateFolio(sequenceNumber: number): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  const seq = String(sequenceNumber).padStart(4, '0');
  return `TM-${date}-${seq}`;
}
// Resultado: "TM-20260330-0001"
```

## 8. Entregables por Fase

### Fase 1 — Backend Core 🔧

| # | Entregable | Criterio de Aceptación |
|---|---|---|
| BE1.1 | `POST /auth/login` con bcrypt + JWT | Test e2e pasando; retorna JWT válido |
| BE1.2 | `GET /auth/profile` | Requiere Bearer; retorna payload |
| BE1.3 | `RolesGuard` + `@Roles()` decorator | Test con roles distintos |
| BE1.4 | CRUD `/users` | Solo superadmin; soft delete |
| BE1.5 | `POST /captures` con folio automático | Folio único; JSONB completo; snapshot username |
| BE1.6 | `GET /captures` con filtros | Query params; paginación |
| BE1.7 | `POST /daily-captures` | Validación de esquema JSONB |
| BE1.8 | Swagger UI en `/api/docs` | Todos los endpoints documentados |

### Fase 2 — Módulos de Negocio 📋

| # | Entregable | Criterio de Aceptación |
|---|---|---|
| BE2.1 | CRUD `/planograma/brands` + products | Seed con 13 marcas |
| BE2.2 | CRUD `/catalogs/:type` | 6 tipos operativos |
| BE2.3 | Scoring engine service | Fórmula correcta; configurable |
| BE2.4 | `PUT /scoring/config` | JSONB editable |
| BE2.5 | `/reports/summary` | Agregación por periodo |
| BE2.6 | `/reports/export/csv` | Descarga CSV |
| BE2.7 | Permisos dinámicos desde `role_permissions` | JSONB consultado en runtime |

### Fase 4 — App Móvil (Backend support) 📋

| # | Entregable | Criterio de Aceptación |
|---|---|---|
| BE4.1 | Upload de fotos endpoint | Multipart → storage |
| BE4.2 | `POST /visits/checkin` con GPS | Lat + Lng requeridos |
| BE4.3 | `PUT /visits/:id/checkout` con score | Score automático |
| BE4.4 | API de sync batch | POST array de capturas |

### Fase 5 — Infra 📋

| # | Entregable | Criterio de Aceptación |
|---|---|---|
| BE5.1 | Docker Compose | `docker compose up` funcional |
| BE5.2 | Health check `/health` | DB check + version |
| BE5.3 | Rate limiting | ≤ 100 req/min por IP |
| BE5.4 | Helmet + CORS | Headers de seguridad |
| BE5.5 | Logging Winston | JSON + correlation ID |

## 9. Variables de Entorno

```bash
# Base de Datos
DB_HOST=localhost
DB_PORT=5432
DB_NAME=trade_marketing
DB_USER=postgres
DB_PASSWORD=postgres

# JWT
JWT_SECRET=cambiar_en_produccion
JWT_EXPIRATION=8h

# App
NODE_ENV=development
PORT=3000
API_PREFIX=api
```

---

*Contacto: Coordinar con DBA para migraciones y con QA para tests e2e.*
