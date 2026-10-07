# Roadmap General — Plataforma B2B (single dev)

> Documento maestro del plan de implementación. Asume **1 dev fullstack** trabajando ~40h/sem. ERP de Mega Dulces: **Kepler** (SQL Server backend).

---

## Filosofía del plan

1. **Limitaciones primero, features después**. Antes de agregar pilares nuevos, arreglar las bases que hoy hacen frágil al sistema (observabilidad, queues, CI, staging, etc.).
2. **Calendar-bound trámites en paralelo**. WhatsApp Business verification y partner fintech se inician en fases tempranas porque tienen tiempos externos largos.
3. **Realtime/WS scaling y ML al final**. El usuario lo pidió explícitamente. Mientras la app tenga 1 replica, Socket.IO single-instance sirve. ML requiere data histórica que aún no existe.
4. **Cada fase debe ser deployable en prod** sin romper lo anterior. Sin big-bang releases.
5. **Docs siempre actualizados**. Cada PR debe actualizar el tracker correspondiente.

---

## Orden de fases

| Fase | Nombre | Semanas (estimadas) | Tipo |
|---|---|---|---|
| **A** | Fundaciones (fix limitaciones) | 6-8 | Infra / mantenimiento |
| **B** | Integración Kepler (ERP) | 4-6 | Backend / data |
| **C** | Sales Intelligence ampliado | 6-8 | Feature (extiende existente) |
| **D** | Catálogo + Pedidos + Portal B2B | 16-20 | Feature mayor (nuevo dominio) |
| **E** | Remote Manager (televenta) | 4 | Feature menor |
| **F** | Comercio Conversacional (WhatsApp + LLM) | 12-16 | Feature mayor + integración externa |
| **G** | Growth (campañas + promociones) | 10-12 | Feature |
| **H** | Fintech (YomWallet equivalent) | 12-16 | Feature mayor + partner externo |
| **I** | ML credit risk + WebSocket scaling | 8-12 | Optimización + ML |
| **TOTAL** | | **78-102 sem** | ~18-24 meses calendario |

> **Realidad**: con bugs en prod, deploys, vacaciones, días de meeting/discovery: estimar **24-30 meses calendario** para 1 dev.

---

## Trámites en paralelo (calendar-bound)

Estos trámites tienen tiempos externos que NO controlas. Empezalos temprano:

| Trámite | Empezar en Fase | Tiempo calendario |
|---|---|---|
| WhatsApp Business verification + BSP onboarding | A (Fase 0) | 6-12 sem |
| Partner financiero (Conekta/Mercado Pago/banco) | D (cuando exista catálogo comercial) | 3-6 meses |
| Acceso DB Kepler (read-only) | A | 1-4 sem según burocracia interna |
| Cuenta Anthropic Claude / OpenAI | E o F | 1 día |
| Sentry, Resend, Mapbox | A | 1 día c/u |

---

## Dependencias entre fases

```
A (Fundaciones)
  ↓
  ├─→ B (Kepler) ─→ D (Catálogo + Portal)
  │                  ↓
  │                  ├─→ E (Remote Manager)
  │                  ├─→ F (WhatsApp Bot)
  │                  ├─→ G (Growth)
  │                  └─→ H (Fintech)
  │                       ↓
  │                       I (ML Credit Risk + WS scaling)
  ↓
  C (Sales Intelligence) ─────────────────┘
        (extiende lo existente,
         independiente de B/D)
```

Notar:
- **C puede ejecutarse en paralelo con B** si las prioridades lo justifican (no comparten código).
- **D bloquea E, F, G, H, I** — todos necesitan catálogo + pedidos.
- **I requiere mínimo 6 meses de data histórica de pedidos** post-D. Por eso queda al final.

---

## Checkpoints de revisión

Cada fase termina con un **checkpoint** documentado en `03_LOG_REVISIONES.md`:

- ✅ Todos los entregables de la fase completos.
- ✅ Tests pasan en CI.
- ✅ Deploy en staging validado.
- ✅ Deploy en prod sin incidentes mayores.
- ✅ Docs actualizados.
- ✅ Decisiones arquitectónicas registradas en `02_DECISIONES_ARQUITECTURA.md`.

Sin checkpoint cerrado, no se inicia la siguiente fase.

---

## Métricas globales

Métricas que se trackean **a lo largo de todo el proyecto** (sección `01_TRACKER_PROGRESO.md`):

- % de fases completadas.
- Líneas de código + cobertura de tests.
- Tiempo medio de boot del container (debería bajar de 25s actual).
- Crashes/semana en prod (objetivo: <1).
- Latencia p95 de endpoints críticos.
- Bundle size de cada frontend.

---

## Cómo usar este sistema de tracking

1. **Al iniciar una fase**: leer `FASES/FASE_X_*.md`, identificar el primer sprint, mover items a "En progreso" en `01_TRACKER_PROGRESO.md`.
2. **Al cerrar un item**: marcar como completo en el tracker + commit con referencia (`[A.1.2] descripcion`).
3. **Al tomar una decisión técnica importante**: agregar ADR a `02_DECISIONES_ARQUITECTURA.md`.
4. **Al completar una revisión**: registrar en `03_LOG_REVISIONES.md`.
5. **Al cerrar una fase**: marcar checkpoint cumplido + crear nota de retrospectiva.

---

## Archivos del sistema de tracking

| Archivo | Propósito |
|---|---|
| `00_ROADMAP_GENERAL.md` | Este archivo — vista de pájaro |
| `01_TRACKER_PROGRESO.md` | Kanban: TODO / En progreso / Revisión / Hecho |
| `02_DECISIONES_ARQUITECTURA.md` | ADRs — decisiones técnicas registradas |
| `03_LOG_REVISIONES.md` | Audit log de revisiones por fase |
| `FASES/FASE_A_FUNDACIONES.md` | Plan detallado Fase A (fix limitaciones) |
| `FASES/FASE_B_INTEGRACION_KEPLER.md` | Plan Fase B (ERP) |
| `FASES/FASE_C_SALES_INTELLIGENCE.md` | Plan Fase C (mix de productos) |
| `FASES/FASE_D_CATALOGO_PORTAL_B2B.md` | Plan Fase D (comercio) |
| `FASES/FASE_E_REMOTE_MANAGER.md` | Plan Fase E (televenta) |
| `FASES/FASE_F_WHATSAPP_BOT.md` | Plan Fase F (conversacional) |
| `FASES/FASE_G_GROWTH_CAMPANAS.md` | Plan Fase G (campañas + promociones) |
| `FASES/FASE_H_FINTECH.md` | Plan Fase H (wallet) |
| `FASES/FASE_I_ML_ESCALADO.md` | Plan Fase I (ML + WS scaling) |
