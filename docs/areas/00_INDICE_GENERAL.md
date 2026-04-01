# 📋 Trade Marketing en Campo — Índice General

> **Versión:** 1.0.0 · **Fecha:** 2026-03-30 · **Estado:** En Desarrollo Activo

---

## 🎯 Misión del Proyecto

> *"Digitalizar, centralizar y optimizar el ciclo completo de operaciones de Trade Marketing en campo — desde la captura diaria del ejecutivo hasta el reporte ejecutivo — eliminando el uso de localStorage / hojas de cálculo y habilitando una plataforma multi-usuario, trazable y escalable que en el futuro pueda funcionar como un ecosistema de microservicios independientes."*

### Visión Estratégica

| Horizonte | Meta | Indicador de Éxito |
|---|---|---|
| **Corto** (0-3 meses) | MVP Backend + Frontend web funcional | Login real + capturas persistidas en PostgreSQL |
| **Mediano** (3-9 meses) | App móvil campo + multi-tenant | Captura offline-first con sync, ≥ 2 empresas operando |
| **Largo** (9-18 meses) | Microservicios + BI avanzado | Auth extraído como SSO independiente, analytics en Metabase |

### Objetivo del PRD

Desarrollar una **app móvil y sistema web** para capturar, validar y cuantificar la ejecución de trade marketing en campo, generando métricas de valor para la toma de decisiones.

### Usuarios del Sistema

| Actor | Descripción | Acceso Principal |
|---|---|---|
| 👤 **Ejecutivo de campo / Auxiliar** | Captura visitas, fotos y evidencias en PDVs | App móvil |
| 👁️ **Supervisor** | Monitorea, valida y evalúa competencias | Web + App |
| 👑 **Dirección / Marketing** | Analiza KPIs, reportes ejecutivos y ROI | Web dashboard |

---

## 📁 Documentos por Área

| # | Archivo | Área | Descripción |
|---|---|---|---|
| 01 | [01_ARQUITECTO_SISTEMA.md](./01_ARQUITECTO_SISTEMA.md) | 🏗️ Arquitecto de Sistema | Bounded Contexts, ADRs, diagramas, stack, reglas arquitectónicas |
| 02 | [02_ANALISTA_FUNCIONAL.md](./02_ANALISTA_FUNCIONAL.md) | 📊 Analista Funcional | User Stories, reglas de negocio, scoring, KPIs, glosario |
| 03 | [03_DEV_UI_UX.md](./03_DEV_UI_UX.md) | 🎨 Dev UI/UX | Design System, flujo UX de campo, prototipos, restricciones |
| 04 | [04_DEV_BACKEND.md](./04_DEV_BACKEND.md) | ⚙️ Dev Backend | APIs, endpoints, guards, services, DTOs, módulos NestJS |
| 05 | [05_DEV_FRONTEND.md](./05_DEV_FRONTEND.md) | 🖥️ Dev Frontend | Pages, componentes, state management, integración API |
| 06 | [06_DEV_BASE_DATOS.md](./06_DEV_BASE_DATOS.md) | 🗄️ Dev Base de Datos | Esquema SQL, migraciones, seeds, índices, Knex.js |
| 07 | [07_QA_PRUEBAS.md](./07_QA_PRUEBAS.md) | 🧪 QA / Pruebas | Plan de tests, casos de prueba, cobertura, estrategia |
| 08 | [08_DOCUMENTACION.md](./08_DOCUMENTACION.md) | 📖 Documentación | Swagger, README, changelogs, manuales |
| 09 | [09_ROADMAP_EJECUCION.md](./09_ROADMAP_EJECUCION.md) | 🗺️ Ejecución | Asignación de fases por roles y usuarios |

---

## 🗺️ Roadmap General (Resumen)

| Fase | Nombre | Duración | Estado |
|---|---|---|---|
| **0** | Fundamentos | — | ✅ Completada |
| **1** | Backend Core | 3-4 semanas | 🔧 En Progreso |
| **2** | Módulos de Negocio | 2-3 semanas | 📋 Planificada |
| **3** | Frontend Web | 4-6 semanas | 📋 Planificada |
| **4** | App Móvil de Campo | 6-8 semanas | 📋 Planificada |
| **5** | Infraestructura y Observabilidad | 3-4 semanas | 📋 Planificada |
| **6** | BI, Analytics y Multi-tenant | 4-6 semanas | 📋 Futuro |

> Cada documento de área detalla los entregables específicos por fase para ese equipo.

---

## 📊 KPIs del Proyecto

### Técnicos

| Métrica | Fase 1 | Fase 3 | Fase 5 |
|---|---|---|---|
| Cobertura de tests | ≥ 70% | ≥ 80% | ≥ 85% |
| Tiempo respuesta API (p95) | < 300ms | < 200ms | < 150ms |
| Uptime | Dev only | ≥ 99% | ≥ 99.5% |

### Negocio

| Métrica | 3 meses | 6 meses | 12 meses |
|---|---|---|---|
| Ejecutivos activos | ≥ 5 | ≥ 15 | ≥ 30 |
| Adopción digital vs papel | ≥ 60% | ≥ 85% | ≥ 95% |
| Datos perdidos | 0 | 0 | 0 |

---

## 📝 Glosario del Negocio

| Término | Definición |
|---|---|
| **PDV** | Punto de Venta — establecimiento físico |
| **Ejecutivo de Campo** | Representante que visita PDVs |
| **Planograma** | Disposición estándar de productos en exhibidores |
| **Captura Diaria** | Registro por visita: material, planograma, venta |
| **Captura KPI** | Snapshot periódico del desempeño |
| **Folio** | ID único de captura (`TM-YYYYMMDD-XXXX`) |
| **Zona / Ruta** | División geográfica de un ejecutivo |
| **SKU Foco** | Producto priorizado para ventas |
| **Material POP** | Material publicitario en el PDV |
| **Score Integral** | Ponderación: KPIs + competencias |
| **Comp. Variable** | Compensación por cumplimiento de KPIs |
| **Check-in** | Llegada a PDV con validación GPS |
| **Exhibición** | Instalación de material en posición del PDV |
| **Score de Exhibición** | peso_posición × factor_tipo × nivel_ejecución |
| **Bounded Context** | Límite lógico de un dominio (DDD) |

---

## 🤝 Convenciones del Equipo

### Código
- **Idioma:** Código en inglés, comentarios y docs en español
- **Tablas:** `snake_case` plural (`daily_captures`)
- **Columnas:** `snake_case` (`captured_by_username`)
- **Endpoints:** `kebab-case` plural (`/daily-captures`)
- **DTOs:** `PascalCase` + `Dto` (`CreateCaptureDto`)
- **Sin JOIN entre Bounded Contexts**

### Git
- **Branches:** `feature/nombre`, `fix/bug`, `docs/tema`
- **Commits:** Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`)
- **PRs:** Requieren 1 review mínimo

### Migraciones
- **Nombre:** `YYYYMMDDHHMMSS_descripcion.ts`
- **Nunca** editar migración ya ejecutada en producción
- Siempre incluir `down()` para rollback

---

*Documento vivo. Última revisión: 2026-03-30*
