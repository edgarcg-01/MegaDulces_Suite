# P-COM-06 — Salida de la requisición hacia Kepler

> Paso 6 de 9 · automático al autorizar · `POST /requisitions/:id/push-kepler` para reintentar ·
> [índice](README.md)

## 1. Para qué existe este paso

Para **quitar la segunda captura**. Hoy la misma requisición se teclea dos veces: en la Suite y a
mano en Kepler. Este paso escribe el documento directo en el ERP.

⛔ **Es la primera escritura de la plataforma a un ERP.** ADR-016 lo prohibía; ADR-092 lo autoriza
como **excepción explícita para UN documento desde UN lugar** (decisión de Edgar, 2026-10-13). No es
permiso general para escribir en Kepler.

## 2. Quién lo ejecuta

| | |
|---|---|
| Automático | cuelga de **aprobar** ([P-COM-05](P-COM-05_autorizacion.md)) |
| Reintento manual | `COMPRAS_REQUISICIONES_GESTIONAR` |

⭐ **Por qué al aprobar y no al armar:** empujado al armar, Kepler se llenaría de borradores que
todavía pueden rechazarse — y **no los podemos borrar**, sólo darlos de baja a mano (el rol de
escritura no tiene `DELETE`, a propósito).

## 3. Estado hoy: APAGADO

Tres candados independientes, **y el de la base manda**:

| candado | estado (2026-10-16) |
|---|---|
| Binding del puerto `KEPLER_REQUISITION_SINK_PORT` | ✅ ligado |
| `KEPLER_PUSH_URL` en el entorno de prod | ⛔ **falta** |
| `GRANT INSERT` sobre `md.kdm1`/`kdm2` + línea de `pg_hba` desde `192.168.0.222` | ⛔ **falta** |

**Medido:** **51 requisiciones** tienen `kepler_error = "KEPLER_PUSH_URL sin configurar"`. La gente
aprueba, el empuje se intenta y falla por configuración. Encenderlo: el
[runbook](../../IMPLEMENTACION/RUNBOOKS/KEPLER_PUSH_DESPLIEGUE.md), **en orden**.

## 4. Qué se hace (cuando está encendido)

1. Se lee la requisición y **se cierra la transacción** antes de hablarle al ERP.
2. Se comprueba `kepler_folio`: si ya salió, **no se vuelve a escribir**.
3. Frenos (§6).
4. Se **clona** un documento plantilla del propio Kepler y se pisan sólo los campos de negocio.
5. Se inserta cabecera + renglones en **una sola transacción contra el ERP**.
6. Se anota de nuestro lado: `kepler_sucursal`, `kepler_folio`, `kepler_pushed_at/by` — o
   `kepler_error`.

**Qué documento se escribe, según el tipo:**

| | compra | traspaso |
|---|---|---|
| doctype | `X-A-30` Requisición | `U-D-40` Pedido |
| `c10` | código del proveedor | pseudo-cliente **`TI###`** (de `md.pv_suc_ip`) |
| `c11` | la **referencia** → folio de la Suite | el **ESTADO** (`AUTORIZADO`); la marca va a `c24` |
| se crea en | el almacén que recibe | la sucursal **ORIGEN** |

⛔ **`c11` no significa lo mismo en los dos.** Escribir `RQ-2026-00807` en el `c11` de un `U-D-40`
dejaría el pedido en un estado inexistente.

## 5. Qué queda registrado

- En Kepler: el documento, con el folio de la Suite como **marca** (`c11` o `c24`). Sin esa marca,
  un documento nuestro sólo se reconoce por su folio de Kepler — que vive de nuestro lado.
- De nuestro lado: la coordenada (`kepler_sucursal` + `kepler_folio`) **o** el motivo
  (`kepler_error`).

⭐ **Dos ausencias distintas, dos columnas distintas:** «no salió» se resuelve reintentando;
«salió mal» lo resuelve una persona. Con una sola columna en NULL se leen igual.

## 6. Controles

| control | qué hace |
|---|---|
| **Idempotencia** | la pone `pushToKepler` mirando `kepler_folio`, **no el sink**: un sink entrega lo que le dan |
| Proveedor conocido por Kepler | se verifica contra `md.kdm1`; un código válido acá pero desconocido allá produce un documento que apunta a nada |
| `TI###` del destino | sale de `md.pv_suc_ip`, **no se infiere del número** (`02`→`TI008`, `03`→`TI002`) |
| Fail-closed | si un renglón no se puede resolver, **no se escribe nada** |
| Limpiar columnas de proceso | en `U-D-40` se vacían `c100`/`c102`/`c103` | un pedido no nace diciendo que ya lo surtieron |
| Nunca tumba la aprobación | el empuje **no lanza** hacia arriba | la aprobación ya está commiteada; un ERP caído no debe frenar las compras |

## 7. Evidencia medida

- ⛔ **El sink no es idempotente por sí mismo, y costó:** el 2026-10-13 `RQ-2026-00807` se empujó
  dos veces con segundos de diferencia y dejó los folios `0003114` y `0003115` vivos a la vez —
  **$175,608.84 de requisiciones para una necesidad de $87,804.42**, a un proveedor real.
- ⛔ **La única coordenada que tenemos hoy apunta a un documento que ya no existe:**
  `RQ-2026-00807` → `00/X-A-30/0003114`, pero el folio máximo vivo de `X-A-30` en la sucursal `00`
  es **`0003110`** *(medido 2026-10-16)*. Se borró al terminar la prueba y **la liga quedó
  colgando**: desde la Suite se ve igual que una entregada.
- **Cero documentos marcados `RQ-`** en las 8 ramas replicadas *(2026-10-16)*.
- Antes de construir se verificó que Kepler **copia** el renglón entre documentos: de 22
  requisiciones históricas con unidad `CJA`, **las 22** llegaron a entrada de inventario con razón
  **1.0000**.

## 8. Cuando falla

| estado devuelto | qué significa | qué hacer |
|---|---|---|
| `apagado` | no hay binding del puerto | nada que hacer desde la pantalla |
| `no_salio` | el ERP rechazó o no respondió; el motivo está en `kepler_error` | leerlo y reintentar con `push-kepler` |
| `en_lote` | se aprobó en lote: no se empuja | reintentar una por una |
| `ya_estaba` | la requisición ya tenía folio | **correcto**: es la idempotencia funcionando |
| rechazo por SKU sin resolver | el ERP no conoce ese artículo | el rechazo **dice cuáles**; darlos de alta en Kepler |

---

**Documento oficial de este paso:** el `X-A-30` / `U-D-40` **es** el documento… pero vive en el ERP
y de nuestro lado sólo queda una coordenada. Propuesta **ACT-KEP** (constancia de salida, con el
diff de lo enviado) en [P-COM-00](P-COM-00_ACTAS_POR_PASO.md) §6.
