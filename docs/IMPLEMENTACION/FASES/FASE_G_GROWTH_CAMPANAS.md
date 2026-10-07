# Fase G — Growth (Campañas + Promociones)

**Duración estimada:** 10-12 semanas
**Objetivo:** motor de campañas hiper-segmentadas + promociones complejas (combos escalonados, precios dinámicos).

> ⚠️ **Stub — completar al cierre de Fase D**.

---

## Pre-requisitos

- ✅ Fase D cerrada (data de pedidos fluyendo).
- ✅ Fase F operando (canal WhatsApp disponible para delivery de campañas).
- ✅ Email provider configurado (Resend o SendGrid).

## Resumen de sprints

| Sprint | Tema | Semanas |
|---|---|---|
| G.0 | Motor de segmentación | 4 |
| G.1 | Motor de campañas + delivery omnicanal | 4 |
| G.2 | Motor de promociones complejas | 4 |
| G.3 | Checkpoint | — |

## Entregables clave

- Tabla `customer_segments` con reglas JSON.
- UI admin para definir segmentos y campañas.
- Canales delivery: WhatsApp (Fase F), push web (`apps/b2b-portal`), email.
- A/B testing automatizado con medición de uplift.
- Motor de promociones: combos escalonados, precios dinámicos, descuentos por volumen, cupones.
- Integración en checkout de portal B2B y app vendedor.

## Dependencias

- Pedidos (Fase D) → para medir uplift.
- WhatsApp (Fase F) → canal principal de delivery.
- Email provider → segundo canal.
- Push notifications (browser API + service worker en portal B2B).

## Métricas

- Uplift en ticket promedio por segmento campaña-activo vs control.
- Redemption rate de cupones.
- Conversion rate por canal.

## Referencias

`PLAN_PLATAFORMA_B2B.md` sección 3 — Fase 4 sub-pilares 3.1 y 3.2.
