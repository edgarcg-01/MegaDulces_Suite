# Fase GP — Gestión de pedidos en almacén (surtido, checado y embarque sin papel)

> **Tesis (ADR-084 propuesto):** el pedido **sigue naciendo y viviendo en Kepler**. Lo que se
> mueve a la Suite es el **trabajo de piso**: surtir, checar y embarcar, que hoy se hace sobre hojas
> impresas desde Kepler. La Suite registra quién hizo cada paso, cuándo y con qué cantidades, y el
> almacenista le captura a Kepler **una sola vez** el resultado. **La Suite no escribe en Kepler.**
>
> Origen: conversación con Francisco, 2026-10-06 (menú *Almacenes › Control de Pedidos* de Kepler).

Estado: **🔨 DISEÑADO (planeación) 2026-10-06. Sin código.** Decode del pedido `U-D-40` verificado
contra prod en solo lectura.

---

## 0. El problema, en palabras del usuario

1. Hay pedidos de **tres tipos** para surtir: **sucursales**, **clientes de telemarketing** y
   **tienda**.
2. En Kepler, las pantallas *Estatus Surtido*, *Estatus Checado* y *Estatus Embarque* **pierden la
   vista** del pedido en cuanto avanza: la historia sólo se recupera hasta *Salida por Embarque*.
3. Hoy el surtido y el checado se hacen **con papel impreso** desde Kepler.

**Objetivo:** que surtido, checado y embarque se lleven **físicamente en la Suite**, sin papel, y
con la historia completa de cada pedido.

---

## 1. Decisión (Francisco, 2026-10-06)

Se evaluaron tres caminos:

| | Cómo | Resultado |
|---|---|---|
| **A** ✅ | La Suite lleva el trabajo de piso; el almacenista captura a Kepler una vez el resultado | **Elegida** |
| B | La Suite escribe el estatus y las cantidades directamente en Kepler | Diferida: *"en algún futuro, cuando la Suite domine el 99% de las funciones consultivas, comenzaremos con las operativas; pero será historia de otro momento"* |
| C | Sólo control: la Suite mide, el papel sigue | Descartada: no cumple el objetivo |

---

## 2. Lo medido antes de planear (prod, solo lectura, 2026-10-06)

### 2.1 Un solo documento para los dos tipos

El pedido de telemarketing y el de sucursal son **la misma pantalla** (`pv_tk.kpl`), **el mismo
documento** (`U-D-40`, "Pedido", folio `PD-`/`PD26-`) y la misma tabla. Sólo los distingue el campo
**Origen** (`kdm1.c27`).

| Últimos 60 días | Telemarketing (`TELEMARK`) | Sucursal (`SUCURSAL`) |
|---|---|---|
| Pedidos | 2,164 | 1,823 |
| A quién se surte | Clientes reales (120 en PH, 101 en Canindo, 106 en 08) | **Clientes internos**: `TI001`–`TI005` (tiendas), `RD 50x` (reparto directo), `RUTA 21/22`, algunos `C…` |
| Pasa por `CREADO` | Sí (214 hoy) | **No**: nace `AUTORIZADO` |
| Dónde se originan | 01, 06, 08, 05 | Todas; sobre todo 01, 00, 06 |

⚠️ **"Sucursal" abastece tres destinos distintos** (tienda, ruta y reparto directo) aunque Kepler
los registre igual. Hay que confirmar si el "tercer tipo, tienda" del pedido original son las `TI00x`.

### 2.2 El decode, anclado a capturas de pantalla

Encabezado anclado al pedido `UD4001-0002781` (PH, `RUTA 21`, 05-oct) y embarque anclado a
`UD4101-0002683` → pedido `UD4001-0002749`. Detalle en [`ERP_KEPLER.md` §3.y.1](../../ERP_KEPLER.md).

| Pantalla | Columna (`U-D-40`) |
|---|---|
| Origen | `c27` |
| Estatus | `c11`: `CREADO → AUTORIZADO → SURTIDO → CHECADO → EMBARCADO` |
| Folio | `c6` |
| Cliente / vendedor | `c10` / `c12` |
| Responsable surtido / checado / embarque | `c100` / `c102` / `c103` |
| Transporte / chofer / dirección de envío / guía | `c83` / `c84` / `c85` / `c86` |
| Hora ticket | `c62` |
| IVA / IEPS / Importe | `c14` / `c15` / `c16` |
| **Renglón**: cant. pedida / surtida / checada / embarcada | `kdm2.c51` / `c52` / `c53` / `c54`, en la unidad de `c55` |

⛔ **La misma información vive en otra columna en el embarque**: en `U-D-41` los responsables son
`c80`/`c81`/`c82`. El decode es **por tipo de documento**.

**Cómo se confirmó el orden de las cantidades:** se llenan en el mismo orden en que avanza el
estatus (21 días, 29,551 renglones):

| Estatus | Renglones | Cantidades con valor |
|---|---|---|
| CREADO | 662 | sólo la pedida |
| AUTORIZADO | 505 | sólo la pedida |
| SURTIDO | 432 | pedida y surtida |
| CHECADO | 281 | + checada |
| EMBARCADO | 27,671 | las cuatro |

### 2.3 Tres trampas medidas

1. **El estatus del renglón (`kdm2.c28`) no se actualiza.** Sigue en `AUTORIZADO` con el encabezado
   en `EMBARCADO`. Manda el encabezado.
2. **Pedida y surtida pueden estar en unidades distintas** (1 pedido contra 21.18 kg surtidos; o la
   pedida vacía). "Embarcado ÷ pedido" da **102–103%**, que es imposible: es mezcla de unidad. **El
   porcentaje de surtido completo NO se publica** hasta resolver la unidad por renglón.
3. **Kepler no guarda la hora de cada etapa.** Sólo `c62` (hora del ticket) y `c69` (otra hora, sin
   decodificar). **Los tiempos por etapa sólo existen si la Suite los registra**, así que no hay línea
   base histórica: se empieza a medir desde el piloto.

### 2.4 Lo que ya existe y se reusa

| Pieza | Dónde | Cómo se usa aquí |
|---|---|---|
| Motor de surtido por olas | `libs/commercial/src/lib/commercial-picking` (Fase SU, ADR-067) | Pool, olas, levantado, reparto de lo escaso, verificación. **Hoy lee `commercial.orders`**: le falta un origen Kepler |
| Embarque y viaje | `analytics.erp_shipment_headers` / `erp_shipment_trips` (Fase RD) | La guía es el viaje; el embarque es la parada |
| Ubicaciones | `commercial.warehouse_bins` + `stock_lot_locations` (WMS-REC) | Ordenar la lista de surtido por ubicación |
| Unidades | `analytics.v_unit_truth` (ADR-057) | Resolver la trampa 2 |

---

## 3. Flujo propuesto (opción A)

```
Kepler: pedido AUTORIZADO (U-D-40)
   │  la Suite lo lee del ODS (vista, sin importer)
   ▼
Suite: pool → surtido (celular/handheld, por ubicación) → checado (otra persona) → embarque (bultos)
   │  cada paso queda como evento propio: quién, cuándo, cantidad por renglón
   ▼
Almacenista: captura UNA vez el resultado en Kepler (cantidades + responsables), sin imprimir
   │
   ▼
Suite: compara su registro contra lo que aparece en kepler_ods → diferencias de captura a una bandeja
```

**Datos propios de la Suite** (tabla real, permitida por la regla principal porque es dato HITL que
no existe en ningún ERP): los eventos de piso. **El pedido, sus renglones y su estatus Kepler** son
vista derivada sobre `kepler_ods`, nunca copia.

---

## 4. Sprints

| Sprint | Qué | Depende de |
|---|---|---|
| **GP.0** | Decode del pedido `U-D-40` + medición | ✅ parcial (§2). Falta: catálogos de responsables (no están en el ODS), unidad de `c51` vs `c52`, qué es `c69` |
| **GP.1** | Vista `analytics.erp_sales_orders` (+renglones) sobre `kepler_ods` + tablero `/almacen/pedidos`: por origen, estatus y antigüedad; pedidos atorados | GP.0 |
| **GP.2** | Origen Kepler para `commercial-picking`: el pool lee pedidos `U-D-40` `AUTORIZADO` | GP.1 |
| **GP.3** | Pantalla del surtidor (móvil): lista por ubicación, captura de cantidad, faltantes. **Reemplaza la hoja impresa** | GP.2 + formato de papel actual |
| **GP.4** | Checado: otra persona, diferencias, regreso al surtidor | GP.3 |
| **GP.5** | Embarque: bultos (el `CJ 16 P 10 UB 6` de los comentarios) calculados, no escritos a mano; liga a transporte y guía | GP.4 |
| **GP.6** | Cuadre Suite ↔ Kepler: lo capturado en Kepler contra lo registrado en piso; y pedidos avanzados en Kepler **sin** paso por la Suite | GP.5 |
| **GP.7** | Indicadores: tiempo por etapa, productividad por persona, surtido completo (con unidad resuelta) | GP.6 |
| **GP.8** | Piloto: un origen, una sucursal (propuesta: **sucursal en PH**) | GP.3–GP.6 |

---

## 5. Preguntas abiertas

| # | Pregunta | Bloquea |
|---|---|---|
| P1 | ¿Qué papel se imprime hoy? Foto de cada formato (hoja de surtido, de checado, etiquetas) | GP.3 |
| P2 | ¿Qué significa `CJ 16 P 10 UB 6` en los comentarios del embarque? | GP.5 |
| P3 | ¿Con qué trabajan en piso (celular, handheld con lector)? ¿Hay wifi en todo el almacén? | GP.3 |
| P4 | ¿El checador es siempre otra persona? En el embarque 2683 los tres responsables son `01` | GP.4 |
| P5 | ¿Se surte pedido por pedido o se juntan en olas (sobre todo telemarketing)? | GP.2 |
| P6 | ¿Qué es el "tercer tipo, tienda"? ¿Las `TI00x` de §2.1? | GP.1 |
| P7 | Si falta un producto: ¿se manda incompleto, se espera, se sustituye? ¿Depende del origen? | GP.3 |
| P8 | ¿Con qué origen y sucursal arranca el piloto? | GP.8 |
| P9 | ¿El pedido de sucursal tiene precio de traspaso? El 2781 marca $395,127.54 de subtotal y $372,742.68 de descuento | Ninguno (dato) |

---

## 6. Riesgos

| Riesgo | Mitigación |
|---|---|
| El almacenista avanza el pedido en Kepler **sin** pasar por la Suite y el piloto queda vacío | GP.6 detecta esos pedidos y los declara |
| Diferencias de captura al teclear en Kepler | Mismo cuadre de GP.6 |
| Se publica un % de surtido con unidades mezcladas | Prohibido hasta resolver la unidad (§2.3) |
| Querer escribir en Kepler "para ahorrar un paso" | Fuera de alcance por ADR-084; es la opción B y tiene su propio momento |
