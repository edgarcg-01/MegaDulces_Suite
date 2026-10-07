# 🗺️ Roadmap de Ejecución y Asignación de Roles

> **Propósito:** Definir el orden cronológico de ejecución del proyecto, detallando las fases, los bloqueos entre tareas y **qué rol (usuario/agente) es el encargado** de ejecutar cada paso. Esto funciona como un manual de instrucciones para el equipo de desarrollo.

---

## 👥 Roles de Ejecución (Usuarios Adecuados)

Para una correcta ejecución, cada instrucción o paso del roadmap debe ser tomado por el "usuario" (rol) pertinente. Cuando como equipo pasemos a una nueva tarea, debemos asegurarnos de que estamos usando la "gorra" correcta:

| Emoji | Rol (Usuario) | Responsabilidades para las Instrucciones | Archivo de Referencia |
|---|---|---|---|
| 🏗️ | **Arquitecto de Sistema** | Toma decisiones de base, aprueba integraciones, revisa que no haya JOINs entre Bounded Contexts y define diagramas. | `01_ARQUITECTO_SISTEMA.md` |
| 📊 | **Analista Funcional** | Define/Aclara reglas de negocio, prioriza el backlog, valida fórmulas (scoring) y define historias de usuario. | `02_ANALISTA_FUNCIONAL.md` |
| 🗄️ | **Dev Base de Datos** | Crea migraciones Knex, diseña tablas, índices, carga seeds, asegura integridad y performance. **(Suele ser el primero en codificar)** | `06_DEV_BASE_DATOS.md` |
| ⚙️ | **Dev Backend** | Crea Controladores, Servicios, Módulos, DTOs, Guards y la lógica de endpoints basándose en la BD y las reglas del Analista. | `04_DEV_BACKEND.md` |
| 🎨 | **Dev UI/UX** | Crea tokens de diseño, CSS/Tailwind, aprueba flujos visuales y componentes (botones, cards). | `03_DEV_UI_UX.md` |
| 🖥️ | **Dev Frontend** | Desarrolla la PWA/Mobile App: layouts, llamadas a la API (Axios/Zustand), rutas y gestión de estado. | `05_DEV_FRONTEND.md` |
| 🧪 | **QA / Pruebas** | Escribe tests (Unitarios con Jest, e2e con Supertest/Playwright), valida coberturas y aprueba PRs. | `07_QA_PRUEBAS.md` |
| 📖 | **Documentación** | Mantiene Swagger actualizado, llena CHANGELOG, documenta y actualiza READMEs. | `08_DOCUMENTACION.md` |

---

## 🛤️ Fases de Desarrollo Paso a Paso

### Fase 0 — Fundamentos *(✅ Completada)*
La infraestructura básica (NestJS + PostgreSQL + Knex + JWT config) ya está operativa.

---

### Fase 1 — Backend Core 🔧 *(✅ Completada)*
**Objetivo:** Autenticación funcional (flujo JWT) y persistencia del Bounded Context de Capturas.

✅ 1. 🏗️ **Arquitecto + 📊 Analista**: Review de User Stories de Login y DTOs requeridos.
✅ 2. 🗄️ **Dev Base de Datos**: Crear el Seed de `role_permissions` y `users` (con bcrypt). Validar migración de `daily_captures`.
✅ 3. ⚙️ **Dev Backend**: Implementar lógica en `AuthService` (bcrypt compare) y `AuthController` (`POST /auth/login`, `GET /auth/profile`).
✅ 4. ⚙️ **Dev Backend**: Implementar `RolesGuard` interactuando con metadatos y payload de JWT.
✅ 5. ⚙️ **Dev Backend**: Crear Bounded Contexts básicos (Endpoints CRUD) para `Users` y `Captures`.
✅ 6. 🧪 **QA**: Desarrollar specs de Jest (Unitarios para Auth) y asegurar coverage > 70% (Lógica terminada).
✅ 7. 📖 **Documentación**: Documentar endpoints con decoradores Swagger (`@ApiOperation`, `@ApiProperty`).

---

### Fase 2 — Módulos de Negocio y Scoring 📋 *(✅ Backend Completado)*
**Objetivo:** Desarrollar el motor de Scoring (formulas) y la lógica de Planogramas y Catálogos.

✅ 1. 📊 **Analista Funcional**: Pasar reglas de Scoring (Pesos x Factor x Nivel) a requerimientos codificables.
✅ 2. 🗄️ **Dev Base de Datos**: Crear migraciones para `planograma_marcas`, `planograma_productos`, `catalogs` y `scoring_config`. Proveer Seeds.
✅ 3. ⚙️ **Dev Backend**: Crear módulo `Scoring` e implementar el "Scoring Engine" (la lógica/matemática aislada).
✅ 4. ⚙️ **Dev Backend**: Crear módulos CRUD resguardados con `RequireAuthGuard` para Planograma y Catálogos.
✅ 5. ⚙️ **Dev Backend**: Construir endpoints de Reportes (`GET /reports/summary`, etc.).
6. 🧪 **QA**: Pruebas paramétricas exhaustivas (el 100% de las 84 combinaciones posibles de exhibición) para el motor de scoring.

---

### Fase 3 — Frontend Web (Dashboard SPA) 📋
**Objetivo:** Reemplazar el prototipo HTML local por una PWA robusta conectada a la API real.

1. 🎨 **Dev UI/UX**: Convertir el Design System actual (HTML/CSS) en componentes Angular/Tokens y aprobar wireframes.
2. 🖥️ **Dev Frontend**: Configurar Angular CLI + Angular 18 + TypeScript + NgRx/Signals (estado local/auth) + RxJS.
3. 🖥️ **Dev Frontend**: Implementar página de Login y store de sesión con Interceptors Axios (Refresh/Logout).
4. 🖥️ **Dev Frontend**: Maquetar `DashboardPage` y conectarla a `GET /captures` y métricas.
5. 🖥️ **Dev Frontend**: Maquetar páginas de Catálogos y Planograma para perfiles SuperAdmin.
6. 🧪 **QA**: Pruebas E2E básicas sobre los flujos web usando Cypress o Playwright.

---

### Fase 4 — Modo Campo y App Móvil 📋 *(✅ Backend Completado / ⏳ Frontend Pendiente)*
**Objetivo:** Flujo in situ para los Ejecutivos. Captura Offline-first en tiendas.

✅ 1. 📊 **Analista + 🎨 UI/UX**: Especificar Flujo Móvil (checkin GPS, exhibición <- 3 taps máximo).
✅ 2. 🗄️ **Dev Base de Datos**: Migraciones de geolocalización `stores`, `visits`, `exhibitions` y `exhibition_photos`.
✅ 3. ⚙️ **Dev Backend**: Adaptar endpoints para checkin/checkout validando coords GPS (Lat/Lng) e integrar guardado de fotos procesadas.
4. 🖥️ **Dev Frontend (Mobile/PWA)**: Implementar la captura offline (Queueing de transacciones en SQLite/Ionic Storage) e intentar sincronización al reconectar.

---

### Fase 5 — Infraestructura y Observabilidad 🚀
**Objetivo:** Llevar a Producción de manera segura.

1. 🏗️ **Arquitecto**: Definir y dockerizar todo el ecosistema (Docker Compose / Dockerfiles PWA+API).
2. ⚙️ **Dev Backend**: Aplicar Helmet, CORS estricto, Throttling (Rate Limit) global. Configurar Logger (Winston) con Correlation IDs.
3. 🗄️ **Dev Base de Datos**: Trigger SQL de auditoría (`audit_log`) en tablas maestras.
4. 🧪 **QA + Arquitecto**: Load testing (Pruebas de estrés) y escaneo de vulnerabilidades del top OWASP.
5. 📖 **Documentación**: Escribir `RUNBOOK.md` o manual de operaciones en caso de caídas.

---

## 🔄 Cómo interactuar usando estos roles

Cuando vayas a solicitar el desarrollo de una funcionalidad, por favor **indica a qué fase pertenece y qué rol debe activarse**. Ejemplo de instrucción (Prompt del usuario hacia la IA):

> *"Estamos en la **Fase 1**. Actuando como **Dev Base de Datos**, por favor crea el archivo de Seed para cargar los usuarios iniciales con sus contraseñas encriptadas usando bcrypt, y luego, actuando como **Dev Backend**, implementa el AuthService para validarlas."*

De esta manera, nos mantendremos fieles a los límites de responsabilidad definidos en la arquitectura (los famosos Bounded Contexts y separación de preocupaciones).
