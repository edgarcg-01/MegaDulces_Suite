# Índice maestro de documentación

> Mapa completo de toda la documentación del proyecto Trade Marketing. Vivido en `docs/`. Trabajo se hace via Claude desde chat — los `.md` son la memoria entre sesiones.
>
> **Última actualización:** 2026-05-26

---

## 🟢 Docs vivas — actualizar continuamente

### Punto de entrada (siempre auto-cargado)
| Archivo | Función | Frecuencia update |
|---|---|---|
| [`/CLAUDE.md`](../../CLAUDE.md) | Contexto + reglas + estado actual. Auto-cargado por Claude. | Al cambiar sprint/decisión |

### Sistema de tracking (núcleo del proyecto)
| Archivo | Función | Frecuencia update |
|---|---|---|
| [`00_ROADMAP_GENERAL.md`](00_ROADMAP_GENERAL.md) | Vista pájaro 9 fases. | Raro |
| [`01_TRACKER_PROGRESO.md`](01_TRACKER_PROGRESO.md) | **Kanban en vivo**. Estados ⬜🔨🧪🚀✅⚠️❌ por item. | CADA cierre de item |
| [`02_DECISIONES_ARQUITECTURA.md`](02_DECISIONES_ARQUITECTURA.md) | ADRs (10 hasta hoy). | Al tomar decisión |
| [`03_LOG_REVISIONES.md`](03_LOG_REVISIONES.md) | Historial de checkpoints + lessons learned. | Al cerrar sprint |
| [`04_FLUJO_END_TO_END_REVIEW.md`](04_FLUJO_END_TO_END_REVIEW.md) | **Revisión flow Trade→Comercial→Logística + 10 GAPS + plan sprints J.6/J.7 (2026-05-27)** | Al cerrar items J.6/J.7 |
| [`AUDITORIA_BASE_INICIAL.md`](AUDITORIA_BASE_INICIAL.md) | 60 findings del código actual. Severidad + plan correctivo. | Al descubrir finding nuevo |

### Plan macro
| Archivo | Función |
|---|---|
| [`/docs/PLAN_PLATAFORMA_B2B.md`](../PLAN_PLATAFORMA_B2B.md) | Visión B2B completa: 4 pilares + 9 fases + alineamiento yom.ai (29KB). |

### Detalle por fase
| Archivo | Estado del plan | Duración |
|---|---|---|
| [`FASES/FASE_A_FUNDACIONES.md`](FASES/FASE_A_FUNDACIONES.md) | ✅ Plan completo | 6-8 sem |
| [`FASES/FASE_A0_MULTITENANT_NEW_DB.md`](FASES/FASE_A0_MULTITENANT_NEW_DB.md) | ✅ **Sprint en curso** | 3-4 sem |
| [`FASES/FASE_B_INTEGRACION_KEPLER.md`](FASES/FASE_B_INTEGRACION_KEPLER.md) | ✅ Plan completo (Postgres-to-Postgres) | 3-5 sem |
| [`FASES/FASE_C_SALES_INTELLIGENCE.md`](FASES/FASE_C_SALES_INTELLIGENCE.md) | 📝 Stub — completar antes de iniciar | 6-8 sem |
| [`FASES/FASE_D_CATALOGO_PORTAL_B2B.md`](FASES/FASE_D_CATALOGO_PORTAL_B2B.md) | 📝 Stub | 16-20 sem |
| [`FASES/FASE_E_REMOTE_MANAGER.md`](FASES/FASE_E_REMOTE_MANAGER.md) | 📝 Stub | 4 sem |
| [`FASES/FASE_F_WHATSAPP_BOT.md`](FASES/FASE_F_WHATSAPP_BOT.md) | 📝 Stub | 12-16 sem |
| [`FASES/FASE_G_GROWTH_CAMPANAS.md`](FASES/FASE_G_GROWTH_CAMPANAS.md) | 📝 Stub | 10-12 sem |
| [`FASES/FASE_H_FINTECH.md`](FASES/FASE_H_FINTECH.md) | 📝 Stub | 12-16 sem |
| [`FASES/FASE_I_ML_ESCALADO.md`](FASES/FASE_I_ML_ESCALADO.md) | 📝 Stub | 8-12 sem |
| [`FASES/FASE_J_LOGISTICA.md`](FASES/FASE_J_LOGISTICA.md) | 🟡 En progreso (60%) | 3-4 sem |
| [`FASES/FASE_K_AI_PRODUCT_MATCH.md`](FASES/FASE_K_AI_PRODUCT_MATCH.md) | 🟡 **Plan listo 2026-05-27** | 1-2 sesiones |
| [`FASES/FASE_M_MOTOR_INTELIGENCIA.md`](FASES/FASE_M_MOTOR_INTELIGENCIA.md) | 📝 **Plan listo 2026-06-10** (rebanada vertical) | 2-3 sprints V1 |
| [`FASES/FASE_KV_EXPLOTACION_KEPLER.md`](FASES/FASE_KV_EXPLOTACION_KEPLER.md) | 📝 **Plan listo 2026-06-30** (ventas/márgenes/demanda/clientes Kepler) | 9 sprints |
| [`FASES/FASE_MAAT_FINANZAS_AI.md`](FASES/FASE_MAAT_FINANZAS_AI.md) | 📝 **Plan listo 2026-07-06** (ADR-028: AI de Finanzas — conocimiento + chat tool-use + motor de patrones + aprendizaje) | 7 sprints |

### Referencia Kepler (ERP)

| Archivo | Contiene |
|---|---|
| [`KEPLER_TABLAS_COMPLETO.md`](KEPLER_TABLAS_COMPLETO.md) | **Inventario COMPLETO de las 329 tablas** del schema `md` (todas, con filas exactas, columnas clave y relevancia) |
| [`KEPLER_CATALOGO_TABLAS.md`](KEPLER_CATALOGO_TABLAS.md) | **Análisis tabla por tabla** del schema `md` (versión curada) — qué integrar, relevancia por dominio |
| [`WINCAJA_TABLAS.md`](WINCAJA_TABLAS.md) | **Catálogo de las 70 tablas del POS Wincaja** (Access 97) — función de cada tabla, columnas clave, mapeo a `wincaja.*` (Fase W / ADR-031) |
| [`ERP_KEPLER_SCHEMA.md`](ERP_KEPLER_SCHEMA.md) | Esquema descifrado de inventario + write-back físico Fase I → Kepler |
| [`KEPLER_CONTABILIDAD_MODELO.md`](KEPLER_CONTABILIDAD_MODELO.md) | **Modelo contable descifrado** (pólizas `kdc2` + catálogo `kdco`): 7 familias de cuenta, ciclos venta/compra/inventario, corte presupuesto→factura, reglas para feeds de egresos/ventas/margen |
| [`RUNBOOKS/KEPLER_CONSOLIDADO_PROD.md`](RUNBOOKS/KEPLER_CONSOLIDADO_PROD.md) | Runbook de despliegue de la consolidación viva a prod |

---

## 🟡 Docs pre-existentes (anteriores al audit)

Validar antes de confiar — pueden estar desactualizadas o contradecir el audit.

| Archivo | Contiene | Confiabilidad |
|---|---|---|
| [`/README.md`](../../README.md) | README raíz del proyecto. | ⚠️ Validar |
| [`/DEPLOY_CHECKLIST.md`](../../DEPLOY_CHECKLIST.md) | Checklist de deploy. | ⚠️ Validar |
| [`/docs/README.md`](../README.md) | README de docs. | ⚠️ Validar |
| [`/docs/ARCHITECTURE.md`](../ARCHITECTURE.md) | Arquitectura inicial. | ⚠️ Pre-audit |
| [`/docs/ESPECIFICACIONES_TECNICAS.md`](../ESPECIFICACIONES_TECNICAS.md) | Specs técnicos (40KB). | ⚠️ Pre-audit |
| [`/docs/OFFLINE_FIRST_IMPLEMENTATION.md`](../OFFLINE_FIRST_IMPLEMENTATION.md) | Patrón offline-first actual. | ✅ Útil |
| [`/docs/PASOS_MIGRACION_PRODUCTOS.md`](../PASOS_MIGRACION_PRODUCTOS.md) | Migración productos histórica. | 📖 Histórico |
| `/docs/areas/00-09_*.md` (10 archivos) | Roles de equipo del plan original. | ⚠️ No aplica (single dev) |
| [`/apps/view/README.md`](../../apps/view/README.md) | README frontend. | ⚠️ Validar |

---

## 🗺️ Flujos de navegación según caso de uso

### "Empiezo a trabajar — ¿qué hago?"
1. [`/CLAUDE.md`](../../CLAUDE.md) auto-cargado → veo sprint en curso.
2. [`01_TRACKER_PROGRESO.md`](01_TRACKER_PROGRESO.md) → siguiente item ⬜.
3. Marco como 🔨 al empezar.
4. Implemento + tests.
5. Marco como 🧪 cuando tests pasan local.
6. Marco como 🚀 cuando deploya a staging.
7. Marco como ✅ tras 24h en prod sin issues.

### "¿Por qué se decidió X?"
- ADRs en [`02_DECISIONES_ARQUITECTURA.md`](02_DECISIONES_ARQUITECTURA.md).
- Historia en [`03_LOG_REVISIONES.md`](03_LOG_REVISIONES.md).

### "¿Cuánto falta para feature Y?"
- [`00_ROADMAP_GENERAL.md`](00_ROADMAP_GENERAL.md) → fase.
- Archivo específico de la fase en `FASES/`.
- Cruzar con [`01_TRACKER_PROGRESO.md`](01_TRACKER_PROGRESO.md) para % real.

### "Encontré un bug / cosa rara"
1. Verificar si ya está en [`AUDITORIA_BASE_INICIAL.md`](AUDITORIA_BASE_INICIAL.md).
2. Si no, agregar con código nuevo (próxima categoría disponible).
3. Si es bloqueante, escalar al sprint actual del tracker.

### "Necesito tomar decisión técnica"
1. Crear ADR nuevo en [`02_DECISIONES_ARQUITECTURA.md`](02_DECISIONES_ARQUITECTURA.md) (siguiente número correlativo).
2. Si supersede una decisión previa: marcar la vieja como "Superseded by ADR-XXX".

### "Tengo que hacer una migración nueva"
- Convención: tabla con `tenant_id` UUID NOT NULL + audit fields completos + RLS.
- Idempotente: `hasColumn` antes de `addColumn`.
- Ver ejemplos en `database/migrations/20260523*_add_audit_fields_*.js`.

---

## Convenciones de mantenimiento

- **Al cerrar un item del tracker**: marcar `[x]` + cambiar símbolo + agregar fecha. Convención commit: `feat([A.X.Y]): descripción`.
- **Al cerrar un sprint**: entry en [`03_LOG_REVISIONES.md`](03_LOG_REVISIONES.md) con resumen + métricas + lessons learned.
- **Al tomar una decisión técnica**: ADR nuevo. Si reemplaza una existente, marcar la vieja como superseded.
- **Al descubrir un finding nuevo**: agregar a `AUDITORIA_BASE_INICIAL.md` con código (ej: nueva categoría `5.x` si no encaja en 1-4).
- **Documentación obsoleta (Categoría 🟡)**: validar al toparse con ella; si está mal, marcar deprecated en encabezado.

---

## Tamaños actuales (context budget)

| Archivo | Tamaño |
|---|---|
| `CLAUDE.md` | ~6 KB |
| `INDEX.md` (este) | ~5 KB |
| `00_ROADMAP_GENERAL.md` | ~6 KB |
| `01_TRACKER_PROGRESO.md` | ~15 KB |
| `02_DECISIONES_ARQUITECTURA.md` | ~13 KB |
| `03_LOG_REVISIONES.md` | ~3 KB |
| `AUDITORIA_BASE_INICIAL.md` | ~18 KB |
| `PLAN_PLATAFORMA_B2B.md` | ~29 KB |
| Cada `FASE_X_*.md` | 4-15 KB |

**Total docs vivas: ~130 KB** ≈ 32K tokens. Manageable para context window.
