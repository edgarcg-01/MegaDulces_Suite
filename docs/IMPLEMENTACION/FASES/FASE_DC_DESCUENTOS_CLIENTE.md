# Fase DC — Descuentos de cliente: dónde viven, quién los aplica y quién no

> Estado: **🔍 INVESTIGACIÓN CERRADA, sin código** · 2026-09-28
> Disparador: *"los clientes tienen descuentos (encuéntralos)… necesito que analices si estos
> descuentos ya se aplican y cómo se aplican. necesito que busques el flujo de estos descuentos."*
> Caso de trabajo pedido por el usuario: **SUPER TOMY**.

Todas las cifras de este documento están **medidas contra producción** (lecturas selectivas,
2026-09-28). Ninguna es una suposición. El decode de la fuente quedó en su lugar canónico:
[`docs/ERP_KEPLER.md` §2.6](../../ERP_KEPLER.md).

---

## 1. La respuesta corta

| pregunta | respuesta |
|---|---|
| ¿Dónde está el descuento del cliente? | En el **maestro de Kepler**, `kdud.c17`, como **porcentaje** |
| ¿Cómo se aplica? | Kepler lo copia a cada documento (`kdm1.c19` = %, `kdm1.c13` = monto) y lo descuenta **del total del documento**, no del renglón |
| ¿Ya se aplica? | **En el ERP sí.** En **nuestra plataforma, en 1 de 5 flujos**: sólo Cotizaciones de Telemarketing |
| ¿Y en los otros 4? | **No.** Preventa/vendedor, Portal B2B, pedido propio y venta en ruta construyen el pedido con **descuento 0 clavado** |
| ¿Cuánto cliente toca? | **993 filas (cliente × rama)** con descuento: 2% (708), 3% (274), 2.5% (9), 5% (2) |

---

## 2. El flujo, de punta a punta

```
   ┌──────────────────────────────────────────────────────────────────┐
   │  kdud.c17  ·  el % negociado, en el MAESTRO DE CLIENTES          │
   │  (por (sucursal, clave) — el mismo cliente puede tener           │
   │   distinto % en cada plaza, y de hecho lo tiene)                 │
   └───────────────────────────────┬──────────────────────────────────┘
                                   │  Kepler lo copia al vender
                                   ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │  kdm1.c19 = el %      kdm1.c13 = el monto (SIN impuesto)         │
   │  descuento real aplicado = Σ importe de renglones − total        │
   │  ⛔ c13 ≠ descuento real: c13 va sin impuesto, el total con      │
   └───────────────────────────────┬──────────────────────────────────┘
                                   │
          ┌────────────────────────┴───────────────────────┐
          ▼                                                ▼
   NUESTRA LECTURA                                  NUESTRA ESCRITURA
   (¿lo mostramos?)                                 (¿lo aplicamos al vender?)
   · /comercial/tickets  → sí, como monto           · Cotización telemarketing → SÍ
   · anexo de venta (AX) → sí                       · Preventa / vendedor      → NO (0 clavado)
   · v_erp_wholesale_…   → sí, pero 86% del padrón  · Portal B2B               → NO
                                                    · Pedido propio PD-        → NO
                                                    · Venta en ruta            → NO
```

---

## 3. SUPER TOMY — el caso trabajado

"SUPER TOMY" no es un cliente: son **cinco claves** en Morelia (sucursales `07` y `08`).

| clave | nombre | `kdud.c17` |
|---|---|---|
| `20361` | SUPER TOMY | **3** |
| `20362` | SUPER TOMY 2 | **3** |
| `20358` | SUPER TOMY 3 | **3** |
| `20357` | SUPER TOMY 4 | **3** |
| `20188` | ABARROTES TOMY | *(vacío)* |

⚠️ **El descuento NO está igual en las nueve ramas.** `SUPER TOMY 3` y `SUPER TOMY 4` traen
`c17='3'` en las sucursales `00`, `02` y `03` pero **vacío en la `01`**. El maestro se replica a
todas las plazas y **diverge**; por eso la llave del descuento es `(sucursal, clave)` y nunca la
clave sola.

### Un documento, al centavo

`07 · U-D-10 · serie 4 · folio 0000513` (cliente `20361`, 51 renglones):

| concepto | valor |
|---|---|
| Σ importe de los renglones | `$4,914.44` |
| total de la cabecera (`c16`) | `$4,767.01` |
| **descuento realmente aplicado** | **`$147.43` = 3.0000% exacto** |
| `kdm1.c19` (el % declarado) | `3` |
| `kdm1.c13` (el monto declarado) | `$135.26` ⛔ **no es lo que se descontó** |
| renglones con `c66 ≠ c12` | 9 de 51 — hay **además** descuento de renglón, independiente |

La diferencia `147.43 − 135.26` es el impuesto: `c13` viaja **sin** IVA/IEPS y el total **con**.
Quien publique `c13` como "el descuento" subdeclara **8.3%** en este documento.

### Y sí, ABARROTES TOMY confirma el control

El mismo grupo comercial, la misma plaza, la misma semana: `20188` no tiene `c17` y **todos** sus
documentos salen con `c19='0'` y `c13='0.00'`. El descuento sigue al cliente, no al grupo.

---

## 4. La prueba de que `c17` es la fuente (a escala, no en un caso)

Ventas `U-D-8/10/12` de septiembre 2026 con cliente identificado, cruzando el maestro contra el
documento por `(sucursal, clave)`:

| `kdm1.c19` (documento) | `kdud.c17` (maestro) | documentos |
|---|---|---|
| `2` | `2` | 314 ✅ |
| `3` | `3` | 168 ✅ |
| `0` | `0` | 45 ✅ |
| `2.5` | `2.5` | 3 ✅ |
| `5` | `5` | 3 ✅ |
| **`0`** | **`2`** | **40 ⛔** |
| **`0`** | **`3`** | **3 ⛔** |
| **`2`** | **`3`** | **2 ⛔** |
| `2` | *(vacío)* | 65 ⚠️ |
| `3` | *(vacío)* | 5 ⚠️ |

**533 de 578 exacto (92.2%).** Las dos familias de discrepancia **no son ruido** y dicen cosas
distintas:

- ⛔ **45 documentos salieron SIN el descuento que el cliente tiene negociado.** Eso es dinero que
  el cliente debió ahorrar y no ahorró, o una excepción que nadie registró. **No se puede decidir
  cuál desde el dato** — hace falta preguntarle a quien factura. Se DECLARA.
- ⚠️ **70 documentos llevan % que su rama no tiene en el maestro.** Coherente con la divergencia
  entre plazas que se ve en SUPER TOMY: el maestro de esa rama está desactualizado, o el % se
  tecleó a mano sobre el documento.

---

## 5. Quién lo aplica hoy — y quién no

### ✅ Cotizaciones de Telemarketing (Fase E.12) — el único que sí

`libs/commercial/src/lib/commercial-quotes/commercial-quotes.service.ts` lee
`analytics.v_erp_wholesale_customers` y guarda `terms_discount_pct` como **snapshot de las
condiciones**. La pantalla lo aplica al dinero:

```ts
// televenta-quote-new.component.ts
descuentoClienteMonto = subtotalBandeja × pct / 100
totalBandeja          = subtotalBandeja − descuentoClienteMonto
```

Es **la misma forma que Kepler**: porcentaje sobre el subtotal del documento. ⭐ Y está bien
resuelto en dos detalles que costaron en otras fases: exige la sucursal antes de cotizar (*"las
condiciones DIFIEREN entre sucursales"*) y **`NULL` se queda `NULL`** — *"sin descuento
configurado" no es "0% de descuento"*.

### ⛔ Los otros cuatro flujos no lo aplican

| flujo | qué hace | evidencia |
|---|---|---|
| **Preventa / app vendedor** | escribe `discount_percent: 0` **clavado** | `apps/vendor/src/app/core/services/offline-order.service.ts:161` |
| **Portal B2B** | nunca lo manda; sólo lo lee de vuelta para mostrarlo | `apps/portal/…/portal.service.ts:126` |
| **Pedido propio (`PD-`)** | `const discount = dto.discount_percent ?? 0` — lo que mande quien llama | `commercial-orders.service.ts:583` |
| **Venta en ruta** | idem: nada consulta el maestro | — |

⛔ **`commercial.customers` no tiene columna de descuento.** Tiene `default_price_list_id`,
`credit_limit` y `payment_terms_days` — o sea que el importador de clientes trajo el límite y el
plazo, **y dejó el descuento afuera**. No hay dónde guardarlo aunque alguien quisiera leerlo.

⚠️ **`basket_discount_amount` de `commercial.orders` NO es esto**: es el descuento de
**promociones** (`basket_promo_code`), otro eje. Y `commercial-pricing` sólo resuelve descuentos
**por volumen** (`min_qty`). Ninguno de los dos mira al cliente.

### ⚠️ El resolvedor existente no alcanza

`analytics.v_erp_wholesale_customers` ya decodifica `c17` bien — pero filtra
`c2 ~ '^C[0-9]{4}$'`, el padrón de mayoreo:

| | filas de `kdud` | con descuento |
|---|---|---|
| entran a la vista (`C####`) | 3,027 | 857 |
| **quedan fuera** | 16,881 | **136 (13.7% de los que tienen descuento)** |

SUPER TOMY (`20361`) está entre los que quedan fuera. **La vista no está mal — está acotada a su
padrón a propósito.** Lo que falta es que el descuento del cliente sea un **resolvedor único**
(§19 / ADR-057: se resuelve una vez, con testigo), no una columna que cada fase vuelve a decodificar.

---

## 6. Lo que la pantalla de tickets muestra hoy

- El monto **sí** aparece: `/comercial/tickets` calcula `descuento_documento = Σ importe − total`,
  que es exactamente el `$147.43` real, no el `$135.26` declarado. ⭐ **La decisión de la Fase TK
  de medir el descuento en vez de creerle a `c13` queda confirmada por este caso.**
- El **porcentaje no aparece en tickets de mostrador**: `detalleMostrador()` pasa
  `descuento_pct_erp: null` clavado, así que la leyenda *"(3% en el ERP)"* sólo sale en facturas.
  Para SUPER TOMY —que compra en mostrador— la pantalla muestra el monto sin decir de qué % viene.

### ⛔ Corrección medida a `FASE_TK` §2.1

Esa sección afirma *"`kdm1.c13` en `U-D-10`: **0.00 en el 100%** de 30,549 documentos"*, y la vista
`analytics.erp_sale_tickets` lleva ese hallazgo al código: *"Siempre 0.00 en el mostrador (medido,
100%)"*. **Ya no es cierto.** Mostrador, septiembre 2026, contra prod:

| sucursal | tickets | con `c13 ≠ 0` | pesos |
|---|---|---|---|
| 01–05 | 59,318 | **0** | — |
| 06 | 7,228 | 1 | $3.74 |
| **07** | 7,321 | **14** | **$1,590.94** |
| **08** | 5,476 | **5** | $353.47 |

La medición no estaba mal cuando se hizo: **se hizo sin Morelia**. Las ramas `06`/`07`/`08`
entraron después y ahí el mostrador **sí** cobra el descuento del cliente. Es la trampa que este
repo ya tiene con nombre: *un filtro validado en UNA sucursal borra otra en silencio*.

---

## 7. El eje que NO se resolvió (declarado, no adivinado)

`kepler_ods.kdpv_descuxq` (descuento **por cantidad**, 80,575 filas, **355 vigentes**) y
`kdpv_descuxm` (por monto, 5,585) son un mecanismo aparte, por producto × rama. Están vivos sólo
en `05` (194), `08` (140) y `06` (15). **No decodifiqué sus columnas de monto** (`c9`/`c10` vienen
en `0.00` en las filas vigentes que muestreé, y en otras con valores centinela tipo `9999999`), así
que **no afirmo qué descuentan**. Requiere la misma verificación contra un hecho independiente que
se le hizo a `c17` antes de usarse en código.

⭐ `kdflujosdesc` **no es descuentos** — son flujos de documentos (`COT → PED → …`); "desc" es
*descripción*. Se nombra acá para que nadie la vuelva a abrir buscando dinero.

---

## 8. Qué falta decidir (Edgar)

1. ⛔ **¿La preventa y el portal deben aplicar el descuento del cliente?** Hoy no lo hacen. Si la
   respuesta es sí, es lo que dispara todo lo demás.
2. ⛔ **Los 45 documentos de septiembre que salieron sin el descuento negociado** — ¿excepción
   legítima o cobro de más? El dato no lo puede decir.
3. ⚠️ **¿Cuál rama manda cuando el maestro diverge?** SUPER TOMY 3 tiene 3% en tres plazas y nada
   en la `01`. Una regla escrita, o el descuento seguirá dependiendo de dónde se capture.
4. ⚠️ **¿Se corrige el maestro o se corrige el proceso?** La divergencia entre ramas y los 70
   documentos con % que su rama no tiene apuntan a captura manual, no a un bug de software.

## 9. Qué construir, si la respuesta a (1) es sí

- **DC.0** — resolvedor único `analytics.v_customer_discount` (tenant × sucursal × cliente) sobre
  `kdud`, **sin el filtro `C####`**, con `metodo` y `NULL` declarado cuando no hay dato. Vista
  `derive-no-copy`: cero importers. `v_erp_wholesale_customers` pasa a leerlo en vez de
  redecodificar `c17`.
- **DC.1** — `commercial.customers` lo **expone derivado**, no copiado (la regla ⭐ del proyecto).
- **DC.2** — los cuatro flujos de captura lo aplican **como documento**, no como renglón, que es la
  forma que usa Kepler. Con prueba negativa: un cliente sin descuento debe seguir en `NULL`, nunca
  en `0%` presumido.
- **DC.3** — `detalleMostrador()` deja de clavar `descuento_pct_erp: null` y pasa `kdm1.c19`.
- **DC.4** — hallazgo persistente *"cliente con descuento facturado sin él"* en la bandeja que ya
  existe, en vez de una consulta que alguien tenga que acordarse de correr.
