# 🧪 QA / Pruebas — Trade Marketing en Campo

> **Responsabilidad:** Estrategia de pruebas, plan de testing, cobertura unitaria/e2e, regresión, carga y seguridad.

---

## 1. Estrategia de Pruebas — Pirámide

```
         /\           E2E Tests (Supertest / Playwright)
        /  \             Flujos completos de usuario
       /────\
      /      \        Integration Tests
     /        \          Módulo ↔ DB, Guards, Middleware
    /──────────\
   /            \     Unit Tests (Jest)
  /              \       Services, Validators, Helpers
 /________________\
```

| Tipo | Herramienta | % del Total | Velocidad |
|---|---|---|---|
| **Unit** | Jest | 60% | ⚡ Rápido |
| **Integration** | Jest + Supertest | 25% | 🔄 Medio |
| **E2E** | Supertest / Playwright | 15% | 🐢 Lento |

## 2. Cobertura Mínima por Módulo

| Módulo | Unit | Integration | E2E |
|---|---|---|---|
| `auth` | ≥ 90% | ≥ 80% | ≥ 70% |
| `users` | ≥ 85% | ≥ 75% | ≥ 65% |
| `captures` | ≥ 80% | ≥ 75% | ≥ 60% |
| `daily-captures` | ≥ 80% | ≥ 70% | ≥ 60% |
| `planograma` | ≥ 75% | ≥ 70% | ≥ 50% |
| `catalogs` | ≥ 75% | ≥ 70% | ≥ 50% |
| `scoring` | ≥ **95%** | ≥ 90% | ≥ 80% |
| `visits` | ≥ 80% | ≥ 75% | ≥ 60% |
| `reports` | ≥ 70% | ≥ 65% | ≥ 50% |

> ⚠️ **Scoring** tiene 95% mínimo porque es la lógica de negocio más crítica.

## 3. Casos de Prueba — Fase 1: Auth

### TP-001: Login exitoso

| Campo | Valor |
|---|---|
| **Precondición** | Usuario `admin` / `admin123` existe y está activo |
| **Input** | `POST /auth/login` con `{ username: "admin", password: "admin123" }` |
| **Expected** | Status 200, body contiene `access_token` (JWT válido) |
| **Validación Extra** | Token decodificado tiene `sub`, `username`, `zona`, `rol` |

### TP-002: Login con credenciales incorrectas

| Campo | Valor |
|---|---|
| **Input** | `POST /auth/login` con `{ username: "admin", password: "wrongpass" }` |
| **Expected** | Status 401, mensaje "Credenciales incorrectas" |

### TP-003: Login con usuario inexistente

| Campo | Valor |
|---|---|
| **Input** | `POST /auth/login` con `{ username: "noexiste", password: "any" }` |
| **Expected** | Status 401 (NO revelar si el usuario existe o no) |

### TP-004: Token expirado rechazado

| Campo | Valor |
|---|---|
| **Precondición** | Token generado con `expiresIn: '1ms'` (inmediatamente expirado) |
| **Input** | `GET /auth/profile` con Bearer token expirado |
| **Expected** | Status 401, "Token invalido o ha expirado" |

### TP-005: Usuario inactivo no puede hacer login

| Campo | Valor |
|---|---|
| **Precondición** | Usuario con `activo: false` |
| **Input** | `POST /auth/login` con credenciales correctas |
| **Expected** | Status 401 o 403, "Usuario desactivado" |

### TP-006: Request sin token rechazada

| Campo | Valor |
|---|---|
| **Input** | `GET /auth/profile` sin header Authorization |
| **Expected** | Status 401, "Token no provisto" |

## 4. Casos de Prueba — Fase 1: RBAC (Control de Acceso)

### TP-010: Ejecutivo NO accede a endpoints de superadmin

| Campo | Valor |
|---|---|
| **Precondición** | Login como `ejecutivo1` |
| **Input** | `GET /users` (solo superadmin) |
| **Expected** | Status 403 Forbidden |

### TP-011: Reportes NO puede capturar KPIs

| Campo | Valor |
|---|---|
| **Input** | `POST /captures` como usuario `reportes1` |
| **Expected** | Status 403 Forbidden |

### TP-012: Reportes SÍ puede ver capturas

| Campo | Valor |
|---|---|
| **Input** | `GET /captures` como usuario `reportes1` |
| **Expected** | Status 200, lista de capturas |

### TP-013: Superadmin accede a todo

| Campo | Valor |
|---|---|
| **Input** | Todos los endpoints como `admin` |
| **Expected** | Ninguno retorna 403 |

## 5. Casos de Prueba — Fase 1: Captures

### TP-020: Crear captura con folio único

| Campo | Valor |
|---|---|
| **Input** | `POST /captures` con KPIs válidos en JSONB |
| **Expected** | Status 201, `folio` formato `TM-YYYYMMDD-XXXX` |
| **Validación** | `captured_by_username` = username del JWT |

### TP-021: Folio no se repite

| Campo | Valor |
|---|---|
| **Input** | 2 capturas seguidas |
| **Expected** | Folios diferentes (`...-0001`, `...-0002`) |

### TP-022: Filtro por zona funciona

| Campo | Valor |
|---|---|
| **Precondición** | Capturas con zona "Norte" y "Sur" |
| **Input** | `GET /captures?zona=Norte` |
| **Expected** | Solo capturas de zona "Norte" |

### TP-023: Snapshot de username es inmutable

| Campo | Valor |
|---|---|
| **Proceso** | 1. Crear captura como user X. 2. Cambiar nombre de user X. 3. Consultar captura |
| **Expected** | `captured_by_username` conserva el nombre original |

## 6. Casos de Prueba — Fase 2: Scoring

### TP-030: Score correcto — exhibidor en caja, ejecución alta

| Campo | Valor |
|---|---|
| **Input** | `posicion: 'caja'`, `tipo: 'exhibidor'`, `nivel: 'alto'`, `hasPhoto: true` |
| **Expected** | `score = 100 × 2.0 × 1.0 = 200` |

### TP-031: Score correcto — tira en anaquel, ejecución media

| Campo | Valor |
|---|---|
| **Input** | `posicion: 'anaquel'`, `tipo: 'tira'`, `nivel: 'medio'`, `hasPhoto: true` |
| **Expected** | `score = 25 × 1.0 × 0.7 = 17.5` |

### TP-032: Score = 0 sin evidencia fotográfica

| Campo | Valor |
|---|---|
| **Input** | Cualquier posición/tipo/nivel con `hasPhoto: false` |
| **Expected** | `score = 0` |

### TP-033: Score con config custom

| Campo | Valor |
|---|---|
| **Precondición** | Modificar `scoring_config` → `caja: 150` |
| **Input** | `posicion: 'caja'`, `tipo: 'tira'`, `nivel: 'alto'` |
| **Expected** | `score = 150 × 1.0 × 1.0 = 150` (no 100) |

### TP-034: Todas las combinaciones de posición × tipo × nivel

| Campo | Valor |
|---|---|
| **Método** | Test parametrizado (7 posiciones × 4 tipos × 3 niveles = 84 combinaciones) |
| **Expected** | Todas las combinaciones calculan correctamente |

## 7. Casos de Prueba — Fase 4: Visitas/GPS

### TP-040: Check-in requiere GPS

| Campo | Valor |
|---|---|
| **Input** | `POST /visits/checkin` sin lat/lng |
| **Expected** | Status 400, "GPS requerido" |

### TP-041: Check-in registra coordenadas

| Campo | Valor |
|---|---|
| **Input** | `POST /visits/checkin` con `lat: 20.6597, lng: -103.3496` |
| **Expected** | Visit creada con coordenadas almacenadas |

### TP-042: Exhibición sin foto → score 0

| Campo | Valor |
|---|---|
| **Input** | `POST /exhibitions` sin foto adjunta |
| **Expected** | Score = 0, sin error (la exhibición se registra pero sin puntaje) |

### TP-043: Check-out calcula total_score

| Campo | Valor |
|---|---|
| **Precondición** | Visit con 3 exhibiciones (scores: 200, 17.5, 0) |
| **Input** | `PUT /visits/:id/checkout` |
| **Expected** | `total_score = 217.5` |

## 8. Checklist de Regresión

Antes de cada merge a `main`, verificar que todos los tests de fases anteriores siguen pasando:

- [ ] Auth: login, perfil, token expirado
- [ ] RBAC: todos los roles vs todos los endpoints
- [ ] Users: CRUD completo
- [ ] Captures: crear, listar, filtrar, folio único
- [ ] Daily Captures: crear, listar
- [ ] Scoring: todas las combinaciones, sin foto = 0
- [ ] Planograma: CRUD marcas + productos
- [ ] Catálogos: CRUD + auto-sync

## 9. Entregables por Fase

### Fase 1 — Backend Core 🔧

| # | Entregable | Criterio de Aceptación |
|---|---|---|
| QA1.1 | Plan de pruebas Fase 1 | ≥ 20 test cases documentados |
| QA1.2 | Tests: Auth (login OK, fail, expirado, inactivo) | 100% happy + sad paths |
| QA1.3 | Tests: RBAC (3 roles × endpoints críticos) | Todos los roles probados |
| QA1.4 | Tests: Captures (crear, listar, filtrar, folio) | ≥ 10 test cases |
| QA1.5 | Reporte de cobertura | ≥ 70% statements |

### Fase 2 — Módulos de Negocio 📋

| # | Entregable | Criterio de Aceptación |
|---|---|---|
| QA2.1 | Tests: Planograma CRUD | Create, read, delete |
| QA2.2 | Tests: Scoring engine (84 combinaciones) | 100% correcto |
| QA2.3 | Tests: Reports (agregaciones) | Datos correctos |
| QA2.4 | Regresión Fase 1 | Todo sigue verde |

### Fase 3 — Frontend Web 📋

| # | Entregable | Criterio de Aceptación |
|---|---|---|
| QA3.1 | E2E con Playwright: Login → Dashboard → Captura → Reports | Flujo completo |
| QA3.2 | Test de accesibilidad (a11y) | Score ≥ 85 axe-core |
| QA3.3 | Test Lighthouse | Performance ≥ 85 |

### Fase 4 — App Móvil 📋

| # | Entregable | Criterio de Aceptación |
|---|---|---|
| QA4.1 | Tests en condiciones de campo | Conexión inestable, GPS lento |
| QA4.2 | Tests de sync offline | Crear sin conexión → sync exitoso |
| QA4.3 | Tests de geolocalización | Validación de coordenadas |

### Fase 5 — Infra 📋

| # | Entregable | Criterio de Aceptación |
|---|---|---|
| QA5.1 | Tests de carga (Artillery/k6) | ≥ 100 req/s sin errores |
| QA5.2 | Tests de seguridad (OWASP basics) | Top 10 cubierto |
| QA5.3 | CI pipeline | Build + test + lint en cada PR, verde |

## 10. Comandos de Testing

```bash
# Unit tests
npm run test

# Watch mode
npm run test:watch

# Cobertura
npm run test:cov

# E2E tests
npm run test:e2e

# Test específico
npx jest --testPathPattern=auth
```

---

*Contacto: Coordinar con Dev Backend para setup de test DB y con Frontend para E2E.*
