# Fase E — Remote Manager (Televenta)

**Duración estimada:** 4 semanas
**Objetivo:** módulo de televenta para call center. Operador busca cliente, ve carrito persistente, sugerencias de canasta estratégica.

> ⚠️ **Stub — completar al cierre de Fase D**.

---

## Pre-requisitos

- ✅ Fase D cerrada (catálogo + carrito + pedidos operando).

## Resumen

- Nuevo rol `tele_operator` en CASL.
- Vista admin en `apps/view` con buscador de cliente, vista de su carrito, botones para confirmar pedido.
- Métricas de productividad por operador: llamadas/hora, conversión, ticket promedio.
- Integración con telefonía (opcional fase 2): Twilio Voice, callbar embebido.

## Sprints

| Sprint | Tema | Semanas |
|---|---|---|
| E.0 | Rol + vista buscar cliente | 1 |
| E.1 | Vista carrito persistente + checkout en nombre del cliente | 1.5 |
| E.2 | Métricas + dashboard productividad | 1 |
| E.3 | Checkpoint | 0.5 |

## Entregables

- Sub-módulo en `apps/view/modules/dashboard/remote-manager`.
- Tabla `tele_sessions` con tracking de llamadas.
- Dashboard de KPIs del call center.

## Dependencias

- Pedidos (Fase D).
- Cuando Fase F esté online, el bot WhatsApp puede derivar a un operador → handoff.

## Referencias

`PLAN_PLATAFORMA_B2B.md` sección 8.5.5 — Fase 2.5.
