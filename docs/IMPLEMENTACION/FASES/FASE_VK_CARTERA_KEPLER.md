# Fase VK — La cartera del vendedor la gobierna Kepler

> **Estado:** 🔨 EN CÓDIGO (2026-09-28) — VK.1–VK.4 escritos, **sin probar en vivo** (no hay base de pruebas con escritura). Arrancado por decisión de Francisco; falta visto bueno de Edgar antes de desplegar.
>
> **Implementado:** migs `20260928210000` (ligas), `20260928210100` (vista), `20260928210200` (4 rutas) · `libs/commercial/src/lib/shared/vendor-cartera-erp.ts` (sincronización del ancla). **Decisión D2 ajustada:** el ancla nace al **abrir la ruta** (no al primer contacto): sin esto, "Mi ruta" y las 16 FKs no ven al cliente. No se agenda ni se re-corre — corre sobre la vista viva y refresca lo que es de Kepler en cada carga.
> **ADR:** ADR-079 (propuesto, se redacta al aprobar).
> **Autor:** Francisco López + Claude. **Mediciones:** contra prod on-prem (`192.168.0.222:5434/railway`), solo lectura, 2026-09-28.

---

## 1. El problema, en una frase

**La app de vendedor no conoce a los clientes que Kepler ya tiene asignados a cada ruta**, así que una ruta vecinal que vende todos los días aparece **vacía** en "Mi ruta".

### Cómo se descubrió

Al dar de alta al supervisor vecinal (Mauricio) para las rutas Padre Hidalgo 1 y 2, La Piedad Abastos y Yurécuaro, se buscaron sus clientes en la Suite y **no existe ninguno**. En Kepler sí existen, están asignados a esas rutas y compran a diario.

### Lo que se midió

**Kepler** ya tiene las 4 rutas como *vendedores* (`kepler_ods.kduv`), y cada cliente trae su vendedor en la ficha (`kepler_ods.kdud.c12`):

| Ruta | Código Kepler | Sucursal que la opera | Clientes en ficha | Compraron (60 d) | Documentos (60 d) | Última venta |
|---|---|---|---|---|---|---|
| Vecinal Padre Hidalgo 1 | `1V001` | 01 | 86 | 71 | 1,698 | 2026-09-28 |
| Vecinal Padre Hidalgo 2 | `1V002` | 01 | 115 | 88 | 1,298 | 2026-09-28 |
| Vecinal La Piedad Abastos | `1V003` | 02 | 158 | 119 | 1,604 | 2026-09-28 |
| Vecinal Yurécuaro | `1V004` | 04 | 143 | 90 | 1,009 | 2026-09-28 |

**La Suite** (`commercial.customers`, lo que lee "Mi ruta"): **440 clientes, todos dados de alta a mano desde la app** (códigos `V-…`). **Cero** vienen de Kepler. Ninguno de las 4 rutas.

### ¿Es confiable la ficha de Kepler como fuente de "quién es de qué ruta"?

Sí. Se contrastó el vendedor de la ficha (`kdud.c12`) contra un hecho independiente: **quién le vendió de verdad** en los últimos 60 días (`kdm1.c12` de sus documentos).

| Ruta | Compraron | Su ficha dice esa ruta | Compran pero la ficha dice otra |
|---|---|---|---|
| `1V001` | 71 | 71 | 0 |
| `1V002` | 88 | 86 | 2 |
| `1V003` | 119 | 111 | 8 |
| `1V004` | 90 | 83 | 7 |
| **Total** | **368** | **351 (95.4 %)** | **17 (4.6 %)** |

**Contraste con la pantalla del ERP** (2026-09-28): el negocio mandó capturas de *CxcVenAvtPag* (ventas por vendedor, sept-2026) de **La Piedad Abastos** (`1V003`, suc 02) y **Yurécuaro** (`1V004`, suc 04). Se tomaron los 11 clientes visibles de la captura de Yurécuaro (`10281`, `10167`, `10185`, `10165`, `10211`, `000029`, `10303`, `10680`, `10160`, `10679`, `10215`): los **11** existen en `kdud` suc 04 con el mismo nombre, los **11** traen `c12 = 1V004` en la ficha y los **11** tienen venta de `1V004` en septiembre. En el mes: **74 clientes / 488 documentos**. La vista propuesta lee el mismo universo que la pantalla de Kepler.

Los 17 restantes **no se esconden**: se muestran como "compra en tu ruta pero su ficha es de otro vendedor" para que alguien corrija la ficha en Kepler (ver §4.4).

---

## 2. La tesis: Kepler gobierna, la Suite anota

**Quién es cliente de qué ruta lo decide Kepler.** Cuando alguien cambia la ruta de un cliente en Kepler, la app lo ve sola, sin que nadie corra nada. Es la regla principal del proyecto aplicada a la cartera: **vista `derive-no-copy` sobre `kepler_ods`, cero importers**.

Lo que Kepler **no** tiene y la Suite **sí** genera (dato propio, HITL) se sigue guardando en la Suite:

| Dato | Lo gobierna | Por qué |
|---|---|---|
| Nombre, dirección, ciudad, RFC | **Kepler** (`kdud`) | Es la ficha del cliente |
| Ruta / vendedor asignado | **Kepler** (`kdud.c12`) | Es la asignación comercial |
| Límite de crédito, plazo | **Kepler** (`kdud.c15/c16`) | Condición comercial por sucursal |
| Zona, grupo | **Kepler** (`kdud.c14/c13`) | Catálogo del ERP |
| Coordenadas GPS | **Suite** | Kepler no las tiene; las captura el vendedor en campo |
| Orden de visita, días de visita | **Suite** | Planeación de la ruta |
| WhatsApp verificado | **Suite** | Canal propio |
| Visitas, pedidos, pagos, señales | **Suite** | Transacciones propias |

### Por qué NO se puede "reemplazar" `commercial.customers`

**16 tablas** tienen FK a `commercial.customers`: `orders`, `vendor_visits`, `payments`, `quotes`, `call_logs`, `lead_reservations`, `stock_reservations`, `recommended_baskets`, `customer_360`, `commerce_signals`, `logistics.guide_recipients`, `logistics.vehicle_stops` y otras. Tirarla rompe todo el negocio de pedidos.

Por eso la propuesta es de **ancla**: `commercial.customers` sigue siendo el `id` del que cuelgan las transacciones, pero una fila ligada a Kepler **no copia** la ficha: la **lee en vivo** de la vista.

---

## 3. Diseño

### 3.1 Liga ruta Suite ↔ vendedor Kepler

Hoy una ruta de la Suite es una fila de `trade.catalogs` (`catalog_id = 'rutas'`, por ejemplo `value = 'RUTA 28'`) y no sabe nada de Kepler. Se le agrega **de qué vendedor Kepler es**:

```
trade.catalogs (rutas)  +  erp_source_branch  text   -- '02'
                        +  erp_vendor_code    text   -- '1V003'
UNIQUE (tenant_id, erp_source_branch, erp_vendor_code) WHERE deleted_at IS NULL
```

⚠️ **La llave es `(sucursal, código)`, nunca el código solo.** Medido en `v_customer_master` y `vendor_identity`: Kepler reusa códigos entre sucursales para **personas distintas**, y el catálogo de clientes también se repite por plaza (la clave `00002` es cuatro clientes distintos según la sucursal).

**Alternativa a evaluar:** en vez de columnas, una tabla de liga `commercial.route_erp_vendor` (una ruta Suite podría agrupar varios vendedores Kepler). Para las 4 rutas vecinales es 1:1, así que se recomienda empezar con columnas y promover a tabla si aparece un caso N:1.

### 3.2 La cartera, derivada

Vista nueva `analytics.v_route_cartera_erp`, sobre `analytics.v_customer_master` (que ya existe, `[TDA.A4]`):

```
ruta Suite (catalogs)  ──(erp_source_branch, erp_vendor_code)──►  v_customer_master
                                                                   (fuente_sucursal, vendedor_code)
```

Cada fila: `route_id`, `erp_source_branch`, `erp_customer_code`, nombre, dirección, crédito, `es_interno`, y **`bought_60d`** (compró en esta ruta en 60 días, desde `mv_kepler_sales_daily` o `kdm1`).

- **Se excluyen** los `es_interno` (pisos de venta, cuentas de la propia tienda), igual que en `v_customer_master`.
- **Se excluyen** los nombres `NO USAR` / `NO TOCAR`, que son el personal defendiéndose de la colisión de claves.

### 3.3 El ancla en `commercial.customers`

```
commercial.customers  +  erp_source_branch   text NULL
                      +  erp_customer_code   text NULL
UNIQUE (tenant_id, erp_source_branch, erp_customer_code) WHERE deleted_at IS NULL
CHECK ((erp_source_branch IS NULL) = (erp_customer_code IS NULL))
```

- Una fila con liga Kepler guarda **solo lo propio**: id, GPS, orden y días de visita, WhatsApp. Nombre y demás salen de la vista.
- Las altas manuales (`V-…`) siguen funcionando igual: su liga queda en `NULL`.

**Cuándo nace el ancla** (decisión abierta D2, §6):
- **(a) Perezosa** — la fila se crea la primera vez que el vendedor toca al cliente (visita, pedido o GPS). Mientras no se toca, el cliente vive solo en la vista. **Recomendada**: no hay nada que mantener ni que re-correr.
- **(b) Anticipada** — se crea una fila por cada cliente de la vista. Se descarta: es exactamente el importer que la regla prohíbe.

### 3.4 "Mi ruta" lee la unión

La regla de "la ruta de hoy" (`vendorTodayRouteExistsSql`, ya reescrita en `[VR.SUP.1]`) pasa a devolver la **unión** de:

1. los clientes de la vista Kepler de las rutas de hoy (con o sin ancla), y
2. las altas manuales cuya `sales_route` coincide (comportamiento actual).

Cada fila declara su origen (`source: 'kepler' | 'manual'`), para que la pantalla sepa si puede editar nombre y dirección (**manual sí, Kepler no**: se corrigen en Kepler).

### 3.5 Pedidos

Tomar pedido requiere un `customer_id`, así que **tomar pedido a un cliente Kepler crea su ancla** (D2-a) en la misma transacción del borrador. Es el mismo patrón idempotente que `createCustomer`, pero sin inventar nombre ni código: se crea con la liga y se lee de la vista.

**Precio:** hoy el vendedor cotiza con `price_lists` de la Suite. El precio "que manda" para un cliente de Kepler es el de su sucursal y condiciones en Kepler. **Queda fuera del MVP** (D4): el MVP usa la lista default de la sucursal de la ruta, igual que hoy.

---

## 4. Plan por sprints

**Piloto:** solo las **4 rutas vecinales** (`1V001`–`1V004`). Es el caso limpio: **no hay ningún cliente manual duplicado** en esas rutas, así que no hay conciliación que hacer.

| Sprint | Qué | Entregable verificable |
|---|---|---|
| **VK.0** | Diccionario y verificación | `kdud.c12` = vendedor ya verificado (95.4 %). Confirmar con el negocio que las 4 rutas son 1:1 con esas 4 personas. Confirmar la sucursal de cada una (medido: 01/01/02/04). |
| **VK.1** | Liga ruta ↔ vendedor Kepler | Migración (columnas en `trade.catalogs`) + campo en el alta de rutas del admin. Las 4 rutas vecinales creadas y ligadas. |
| **VK.2** | Vista de cartera | `analytics.v_route_cartera_erp` con `security_invoker` + `GRANT`. Smoke: por ruta, conteo de la vista == conteo de ficha medido en §1. |
| **VK.3** | Ancla | Migración (columnas en `commercial.customers` + UNIQUE parcial + CHECK). Función `ensureErpAnchor(branch, code)` idempotente. |
| **VK.4** | "Mi ruta" lee la unión | `myHome`, `myCoverageToday`, `nearby`, `checkIn`, `finishVisit` y el asistente Thot aceptan clientes Kepler y crean ancla al tocar. Badge de origen en la app. |
| **VK.5** | Pedido a cliente Kepler | Borrador → confirmar con ancla creada en la misma trx. Smoke HTTP: pedido completo a un cliente `1V003` sin fila previa. |
| **VK.6** | Declarar el hueco | Pestaña "Compran en tu ruta, ficha de otro vendedor" (los 17), sin esconderlos y con el vendedor que dice la ficha. |
| **VK.7** | Extender más allá del piloto | Rutas de campo no vecinales. **Aquí sí hay conciliación**: 440 altas manuales, parte de ellas ya existen en Kepler. Se diseña aparte. |

**MVP = VK.0–VK.5.**

---

## 5. Riesgos y trampas conocidas

- ⚠️ **Clave de cliente por sucursal.** La vista nunca colapsa por código; la llave es `(fuente_sucursal, cliente_code)`. Documentado en `20260920130000_v_customer_master.js`.
- ⚠️ **Catálogos por plaza.** `kduv`/`kduj`/`kduk` se leen de la **misma** sucursal que la ficha. Casi-acierto documentado: Zona contra `kduv` da un nombre parecido y equivocado.
- ⚠️ **Frescura.** La vista es tan fresca como el CDC del ODS. Si el carril se cae (Fase OBS), la cartera se congela **sin error**. La pantalla debe declarar `datos_al`.
- ⚠️ **RLS.** Las vistas sobre `kepler_ods` no llevan `tenant_id` nativo: filtrar tenant explícito, como `erp_customers`.
- ⚠️ **Desfase de despliegue.** Si el código llega antes que la migración, la cartera entera falla (ya pasó con `client_uuid`). Migración primero.
- ⚠️ **Editar datos de Kepler desde la app.** Prohibido por diseño (ADR-040 aplicado a Kepler: la plataforma no escribe al SoR). La app muestra "se corrige en Kepler".

---

## 6. Decisiones abiertas (para Edgar)

| # | Decisión | Recomendación |
|---|---|---|
| **D1** | ¿La liga ruta↔Kepler es columna en `catalogs` o tabla aparte? | Columna para el piloto; tabla si aparece un N:1. |
| **D2** | ¿Cuándo nace el ancla del cliente? | **Perezosa** (al primer contacto). La anticipada es un importer. |
| **D3** | ¿El nombre se guarda en el ancla? | **No**, se lee de la vista. Si algún consumidor viejo lo necesita, se llena al crear el ancla y se marca como *snapshot*, nunca como fuente. |
| **D4** | ¿Precio desde Kepler? | Fuera del MVP. Fase aparte (precio por sucursal/condición). |
| **D5** | ¿Los 17 "compran pero su ficha es de otro" entran a la cartera? | Se **muestran aparte** y no se mezclan: la cartera es la ficha. |
| **D6** | ¿Quién crea las 4 rutas y a Mauricio? | Admin desde `/admin/users` + catálogo de rutas, con la liga de VK.1. |

---

## 7. Relación con otras fases

- **`[VR.SUP.1]`** (esta misma rama): el supervisor escoge qué ruta de su equipo trabaja hoy. VK hace que esa ruta **tenga clientes**. Son independientes: VR.SUP.1 funciona hoy con las rutas manuales.
- **E.12.1 (Cotizaciones):** ya resolvió "cliente que vive en Kepler y no en la Suite" con `erp_customer_code` + `source_branch` y la vista `v_erp_wholesale_customers`. VK sigue el mismo patrón para la app de vendedor.
- **`[TDA.A4]` `v_customer_master`:** es la base de la vista de VK. No se duplica.
- **`analytics.vendor_identity`:** liga código Kepler → persona (para analítica). VK liga código Kepler → **ruta de la Suite** (para operar). Se reusa el mapeo PH vecinal (`01:1V001` → Candy Salgado, `01:1V002` → Rafael Villalobos) para validar VK.0.
