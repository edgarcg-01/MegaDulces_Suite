# Fase H — Fintech (Wallet del tendero)

**Duración estimada:** 12-16 semanas
**Objetivo:** wallet del tendero — saldos, cupones, recompensas, depósitos directos a cuenta. Equivalente a YomWallet.

> ⚠️ **Stub — completar al cierre de Fase G**. Es la fase más arriesgada (regulación + partner financiero).

---

## Pre-requisitos

- ✅ Fase D cerrada.
- ✅ Fase G operando (cupones y campañas como input para recompensas).
- ✅ Partner financiero firmado (trámite iniciado en Fase D — 3-6 meses).
- ✅ Asesoría legal contratada (regulación financiera en MX).
- ✅ Decisión de figura legal: ¿registro como SOFOM? ¿operar via PayFac de un partner?

## Resumen de sprints

| Sprint | Tema | Semanas |
|---|---|---|
| H.0 | Modelo de wallet + tablas | 2 |
| H.1 | Sistema de cupones | 3 |
| H.2 | Programa de recompensas | 3 |
| H.3 | Línea de crédito gestionada (input de Fase I) | 4 |
| H.4 | Integración bancaria para depósitos | 4 |
| H.5 | Reportes regulatorios (CFDI, retenciones) | 2 |
| H.6 | Checkpoint | — |

## Decisiones críticas pendientes

- **ADR-008**: partner financiero (Conekta, MP Business, BBVA, etc.).
- **H.4**: ¿depósitos a cuenta del tendero o solo saldo interno?
- **H.5**: ¿quién emite el CFDI? ¿Mega Dulces directo o vía partner?

## Riesgos altos

| Riesgo | Severidad | Mitigación |
|---|---|---|
| Compliance regulatorio incompleto | 🔴 Crítico | Asesoría legal obligatoria desde el inicio |
| Partner financiero falla / cambia condiciones | 🔴 Alto | Firmar contrato con SLAs claros |
| Fraude / abuso del sistema de wallet | 🔴 Alto | Límites por transacción + monitoreo |
| KYC del tendero | 🟡 Medio | Validación de RFC + datos en Kepler |

## Entregables clave

- Tablas: `customer_wallets`, `wallet_transactions`, `coupons`, `coupon_redemptions`, `rewards`, `credit_lines`, `credit_movements`.
- Integración con partner financiero (API).
- UI en portal B2B: ver saldo, redimir cupones, ver historial.
- UI admin: monitorear wallets, ajustes manuales con auditoría.
- Generación de CFDI vía PAC (provider autorizado).
- Reportes regulatorios mensuales.

## Dependencias

- Pedidos (Fase D) → ganar puntos / cashback.
- Campañas (Fase G) → emitir cupones.
- ML credit risk (Fase I, sub-componente) → autorizar línea de crédito.

## Referencias

`PLAN_PLATAFORMA_B2B.md` sección 8.5.5 — Fase 5.
