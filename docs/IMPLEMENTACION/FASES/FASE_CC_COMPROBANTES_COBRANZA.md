# Fase CC — Comprobantes de Cobranza (depósito + OCR)

> Adjuntar el comprobante de **depósito** (imagen/PDF) a un **cobro de Kepler**, con **OCR**, ligado por `(sucursal, folio)`. Digitalización de archivos = evidencia **read-only** sobre el ERP (no crea ni escribe cobros). Captura en oficina (`/finanzas`).

## Tesis

Un cliente a crédito paga con transferencia/depósito y manda la ficha. Hoy esa ficha vive en WhatsApp/papel, sin ligarse al cobro. CC digitaliza ese adjunto: el capturista **elige el cobro** (de la lista de Kepler), **sube la ficha**, corre **OCR** (Claude vision), el sistema **compara el monto** OCR vs el del cobro (chip de cuadre) y guarda la evidencia. Validación/rechazo HITL. Hereda ADR-016 (motor/humano decide, LLM fuera del dinero) y el patrón de `finance.expense_proofs` (GX.7).

## Dónde vive el cobro en Kepler (decode)

- Documento **`Collect1`** (taxonomía `md.doctype`), folio serie **`UA0501`**.
- En `md.kdmm` = **`U-A-5-1` "Cobro PUE"**, clave `KFUA0501`, asiento **C 102 Bancos / A 115 Clientes**.
- Filtro exacto en `md.kdm1`: `c2='U' AND c3='A' AND c4=5` (NO todos los abonos nat A — grupos 20/21/25/26/30/35 = devoluciones/notas de crédito → cuenta 403, no son cobros). Hermano fiscal `U-A-7-1` "Cobro CFDI" (0 filas en CEDIS).
- Cols header: `c1`=suc · `c6`=folio (**único**, 23771/23771) · `c9`=fecha · `c10`=cliente_code · `c24`=concepto · `c16`=monto · `c32`=beneficiario.
- Fuente = **CEDIS `md_00`** (centraliza la cobranza; sumar sucursales duplica). Total UA0501 = $369.5M. Con ficha (depósito/transferencia/tarjeta) = **5,227** de 23,771.

## Arquitectura

| Capa | Qué |
|---|---|
| `analytics.erp_collections` | Espejo read-only de los cobros de Kepler (PK `(tenant, suc, folio)`, sin RLS, filtro tenant explícito). Lo puebla el importer. |
| `finance.collection_deposits` | Nuestro registro: adjunto `files` jsonb + campos OCR + `monto_match` + estado `recibido→validado\|rechazado`. RLS forzado (calca `expense_proofs`). |
| `import-collections.js` | CEDIS `md_00`, filtro U-A-5, deriva forma_pago + tipo_cuenta, UPSERT aditiva sin churn. |
| `LlmExtractorService.extractDepositSlip()` | Claude Haiku vision, imagen **y PDF nativo** (bloque `document`); campos ficha MX (monto/fecha/banco/cuenta_dest/referencia SPEI/ordenante/metodo). Degrada sin `ANTHROPIC_API_KEY`. |
| `libs/finance/.../collection-deposits` | Backend: `listCobros` ⋈ evidencia + KPIs, `uploadFile` (Cloudinary), `runOcr` (preview), `attach` (calcula cuadre, tolerancia $1), `validate`/`reject`. Endpoints `/finance/collections`. |
| `/finanzas/cobranza` | Frontend Operations: tabla densa de cobros + chip de cuadre + panel adjuntar (subir → OCR → editar → guardar) + validar/rechazar. |
| Permisos | `FINANCE_COLLECTIONS_VER` (capturista adjunta) / `FINANCE_COLLECTIONS_GESTIONAR` (revisor valida). Independencia por módulo. |

## Estado

| Slice | Estado | Verificación |
|---|---|---|
| CC.0 Fundación (mig + importer + OCR) | ✅ commit `6fccdffb` | importer 23,771 cobros / $369.5M / 5,227 con ficha; build api |
| CC.1 Backend (módulo + permisos + wire) | ✅ commit `9577b1ca` | smoke `test-newdb-collection-deposits` 18/18; build api |
| CC.2 Frontend (`/finanzas/cobranza`) | ✅ commit `9a83bbd9` | build view OK; validación visual manual pendiente |
| PROD migraciones | ✅ 2026-08-03 | Railway batch 154 (5 migs); tablas + RLS + 21 roles con VER verificados |

## Decisiones fijadas

- Ancla = cobro Kepler `UA0501` (grupo 5), read-only. Captura = oficina. Fuente = CEDIS `md_00`. Match de monto = sugerencia, valida humano (tolerancia $1).
- `RolesGuard` chequea clave exacta; ability.factory solo para god-mode admin (NO requiere mapear FINANCE_*).

## Pendiente prod (feature vivo)

1. **Redeploy código** api+view a Railway (git push → rebuild) — commits locales sin push.
2. **Correr `import-collections.js`** desde máquina LAN con `DATABASE_URL_NEW=<prod>` para poblar `analytics.erp_collections` (Railway no alcanza CEDIS `md_00`).
3. **Re-login** (permisos en el JWT).
4. Rotar la credencial prod de Railway (expuesta en sesión).

## Diferido

- Cron del importer (agendar como los otros feeds).
- Conciliación automática cobro↔ingreso bancario (CB `finance.bank_movements`) y cobro↔abono Kepler.
- Captura desde campo (vendedor `apps/vendor`) / cliente (WhatsApp/portal).
- Grupo 7 "Cobro CFDI" (0 filas en CEDIS hoy) + complemento de pago CFDI `kdfe33pagm2`.
