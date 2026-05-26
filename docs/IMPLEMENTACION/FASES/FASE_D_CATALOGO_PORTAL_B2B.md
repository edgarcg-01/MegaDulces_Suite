# Fase D — Catálogo Comercial + Pedidos + Portal B2B

**Duración estimada:** 16-20 semanas
**Objetivo:** transformar la app de auditoría a plataforma comercial. Vendedores toman pedidos, clientes B2B compran desde portal web.

> ⚠️ **Stub — completar antes de iniciar**. Fase mayor, requiere planificación detallada al cierre de Fase B.

---

## Pre-requisitos

- ✅ Fase A cerrada.
- ✅ Fase B cerrada (Kepler sync funcionando).
- ✅ ADR-003 (multi-tenancy) decidido.
- ✅ ADR-005 (stack mobile) decidido.
- ✅ Iniciar trámite con partner financiero (Fintech Fase H requiere 3-6 meses).

## Resumen de sprints

| Sprint | Tema | Semanas |
|---|---|---|
| D.0 | Dominio comercial (productos, precios, customers) | 4 |
| D.1 | Carrito + estados de orden | 4 |
| D.2 | App vendedor con modo pedido | 4 |
| D.3 | Portal web B2B (`apps/b2b-portal`) | 4 |
| D.4 | Canasta estratégica v1 (heurísticas) | 2 |
| D.5 | Checkpoint | — |

## Decisiones técnicas pendientes

- **D.2.1**: Ionic actual vs RN nuevo. Ver ADR-005.
- **D.0.1**: ¿qué columnas extras necesita `products_commercial` que no estén en Kepler? (imagen Cloudinary, descripción rica, tags de marketing, etc.)
- **D.1.3**: estrategia de stock — ¿reserva en cart o en checkout? ¿time-out de reserva?

## Entregables clave

- Schema `commercial.*` con orders, carts, customers extendidos.
- Endpoints REST para carrito + orden + estados.
- App vendedor con toma de pedidos offline-first.
- `apps/b2b-portal` deployado (Angular standalone).
- Tabla `recommended_basket` con categorías focus/exploración/innovación/base.

## Dependencias

- `apps/b2b-portal` = nueva app del monorepo.
- Si ADR-005 decide RN: nueva app `apps/mobile-sales`.
- Sync de Kepler (Fase B) alimenta el catálogo.
- Cola BullMQ (Fase A) para jobs nocturnos de canasta estratégica.

## Referencias

`PLAN_PLATAFORMA_B2B.md` sección 3 — Fase 2.
