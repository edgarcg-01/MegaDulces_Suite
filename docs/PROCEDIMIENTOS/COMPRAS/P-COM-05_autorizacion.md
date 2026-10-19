# P-COM-05 — Autorización de la requisición

> Paso 5 de 9 · `/compras/requisiciones` → **Aprobar** / **Rechazar** · [índice](README.md)

## 1. Para qué existe este paso

Es **el control de la compra**: el momento en que la necesidad se vuelve una orden que alguien
respalda con su nombre. Y es el paso que **Kepler no tiene** — en el ERP ningún documento de la
cadena lleva aprobación.

## 2. Quién lo ejecuta

⛔ **Una sola persona, por decisión explícita** (Edgar, 2026-10-08: *«toda requisición aprobada por
arizbeth_gonzalez… es la única que puede autorizar»*).

| | |
|---|---|
| Permiso | `COMPRAS_REQUISICIONES_AUTORIZAR` (`approve`, `reject`, `bulk`) |
| **Roles que lo tienen** | **ninguno de los 57** — a propósito |
| **Personas que lo tienen** | `arizbeth_gonzalez` (`gerente_compras`, desde 2026-10-08, por migración `20261008115334`) · `superuser` (`direccion`, desde 2026-10-15, otorgado por `superoot`) |

⚠️ **Por qué por persona y no por rol:** hay **dos** `gerente_compras` en prod y el pedido decía *la
única*. Darle la llave al rol se la daría también a quien nadie nombró.

⚠️ **El god-mode sigue pasando** (ADR-054): los superadmins activos y la cuenta de servicio
`superoot` pueden autorizar sin tener la llave. **Es la salida de emergencia** para cuando ella no
esté; cerrarla es una decisión aparte y se hace en el guard.

⚠️ **`COMPRAS_REQUISICIONES_GESTIONAR` no se recortó**: armar, recalcular, ordenar y recibir
siguen con quien los operaba. Sólo aprobar, rechazar y el lote cambiaron de llave.

## 3. Disparador y entradas

- **Disparador:** una requisición en `pending_approval`.
- **Entrada:** su costo capturado contra el costo de hoy (`analytics.replenishment_plan`).

## 4. Qué se hace

1. Abrir la requisición (o seleccionar varias).
2. **Aprobar** → pasa a `approved`, sella `approved_by` + `approved_at`, y **cuelga el envío a
   Kepler** ([P-COM-06](P-COM-06_salida_a_kepler.md)).
3. **Rechazar** → pasa a `cancelled`.
4. **En lote**: hasta **200** por llamada.

## 5. Qué queda registrado

- `estado = approved` · `approved_by` · `approved_at`.
- El resultado del envío a Kepler, en uno de cinco estados: `entregada`, `ya_estaba`, `apagado`,
  `en_lote`, `no_salio`.

⛔ **No se emite ningún documento de autorización.** La firma es una fila: dos columnas en la
requisición. No hay acta, ni folio, ni PDF, ni motivo del rechazo.

## 6. Controles

| control | qué hace | por qué |
|---|---|---|
| **Freno de vigencia** | si el costo capturado ya no es el de hoy, **rebota** con el monto de los dos lados | aprobar eso es ordenar a un precio que no existe y valuar la compra con él |
| Salida del freno | el mensaje nombra **Recalcular**, de un clic | un freno sin salida empeora el embudo que esta fase vino a cerrar |
| **No frena lo que no pudo medir** | si ningún renglón es comparable, pasa | castigar la ausencia de medición es dibujar un veredicto que nadie emitió (ADR-056) |
| **El lote NO empuja a Kepler** | aprueba y deja `kepler_folio` NULL | 200 escrituras al ERP en una petición HTTP tardarían minutos y un timeout a mitad dejaría la duda de cuáles salieron |
| Cada una en su transacción | el lote informa **por folio** qué pasó | una sola transacción haría que un renglón con costo movido tirara las otras 49 |

## 7. Evidencia medida *(prod, 2026-10-16)*

| | |
|---|---:|
| Requisiciones con `approved_at` | **519** |
| …por `arizbeth_gonzalez` | **505** (última: 2026-10-16 14:50) |
| …por `aide_piceno` (`compras_operaciones`) | 10 — todas **anteriores** al 2026-10-08 |
| …por `superuser` (`direccion`) y `superoot` (`superadmin`) | 2 y 2 |
| Aprobaciones en la semana del 2026-10-12 | 298, **todas** de `arizbeth_gonzalez` |

⭐ **El embudo es real y es visible:** una persona concentra el 97 % de las autorizaciones. Era el
objetivo del cambio, no un efecto secundario — pero significa que **su ausencia detiene la compra**,
y la única salida es el god-mode.

## 8. Cuando falla

| síntoma | qué significa | qué hacer |
|---|---|---|
| «N de M renglones ya no tienen el costo de hoy» | freno de vigencia | **Recalcular** y volver a aprobar |
| 403 al aprobar | la persona no tiene la llave | no se presta la cuenta: se otorga el override por persona, o lo hace quien la tiene |
| Aprobó pero el ERP no la tiene | el empuje falló después del commit | el motivo queda en `kepler_error`; reintentar desde [P-COM-06](P-COM-06_salida_a_kepler.md) |
| Se aprobó algo que no debía | no hay «desaprobar» | darla de baja y, si ya salió al ERP, darla de baja **también allá** (no hay `DELETE`) |

---

**Documento oficial de este paso:** ⛔ **ninguno, y es el que más falta hace**: es el acto de
control del flujo y hoy no produce constancia. Propuesta **ACT-APR** en
[P-COM-00](P-COM-00_ACTAS_POR_PASO.md) §5.
