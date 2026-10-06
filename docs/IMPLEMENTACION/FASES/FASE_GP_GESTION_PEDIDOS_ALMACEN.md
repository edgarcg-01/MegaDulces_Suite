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

1. **`kdm2.c28` es la etapa en que se AGREGÓ el renglón, no su estatus.** ~3.2% de los renglones
   embarcados nacieron en surtido, checado o embarque (productos agregados sobre la marcha) y no
   tienen cantidad original. El estatus lo manda el encabezado.
2. **Pedida y surtida pueden estar en unidades distintas** (1 pedido contra 21.18 kg surtidos; o la
   pedida vacía). "Embarcado ÷ pedido" da **102–103%**, que es imposible: es mezcla de unidad. **El
   porcentaje de surtido completo NO se publica** hasta resolver la unidad por renglón.
3. **Kepler no guarda la hora de cada etapa.** Sólo `c62` (hora del ticket) y `c69` (otra hora, sin
   decodificar). **Los tiempos por etapa sólo existen si la Suite los registra**, así que no hay línea
   base histórica: se empieza a medir desde el piloto.

### 2.4 El papel de hoy (fotos de Francisco, 2026-10-06)

**Se imprime UN ticket por etapa**, del mismo pedido, en impresora de tickets. El encabezado dice
`Referencia SURTIDO`, `Referencia CHECADO` o `Referencia EMBARCADO`: el mismo pedido sale **tres
veces** en papel. Ejemplos: `UD4001-0000367` (suc 08, sucursal → `TI009` Morelia Madero, impreso
como SURTIDO y otra vez como CHECADO) y `UD4001-0000327` (suc 08, telemarketing → Dulcería Meli,
impreso como EMBARCADO).

| Lo que trae el ticket | Para qué lo usa el piso | Qué hace la Suite |
|---|---|---|
| Cantidad + unidad + clave + descripción | Lista de surtido | Igual, **ordenada por ubicación** (el ticket va en el orden de captura) |
| `Exis` (existencia al imprimir) | Referencia de si hay | Existencia viva. ⚠️ Cambia entre impresiones (407 → 402 del SURTIDO al CHECADO): es una foto, no un dato |
| El surtidor **encierra en círculo** cada cantidad | Marca de "ya lo levanté" | Captura por renglón, con hora |
| Total por unidad (`CJA 16`; `PAQ 37 / PZA 25`) | Contar lo que sale | Calculado |
| Importe y total con letra | Nada en piso | No se muestra al surtidor |
| Firma (`Yuli`) y claves de responsable **escritas a mano** | Quién lo hizo | El usuario que inició sesión |

**Confirmado contra prod:** el 367 está en `CHECADO` con `c102 = 30001`, la clave escrita a mano en
el ticket de checado. Las claves de responsable son números de 5 dígitos (`30001`, `30002`…).

**Medido (embarcados, 30 días):** Kepler tiene los tres responsables capturados en **~87–90%** de
los pedidos de PH y Canindo, pero sólo en **~60%** de Morelia Abastos (184 de 308 con surtidor).
La Suite los registraría siempre.

**Hipótesis sin verificar:** `c69` parece la hora del **último** cambio de estatus (el 367 dice
`09:41` estando en CHECADO). Sería sólo la última etapa y sin fecha propia, así que no reemplaza
el registro por etapa.

### 2.5 Los bultos del embarque (`CJ 16 P 10 UB 6`)

Escrito a mano en los comentarios del embarque. Significa:

| Clave | Qué es | Cómo lo obtiene la Suite |
|---|---|---|
| `CJ 16` | 16 bultos de unidad cerrada: cajas, bultos o cubetas | **Calculado** de los renglones en unidad cerrada (`CJA`/`BTO`/`CUB`) |
| `P 10` | 10 cajas armadas con todo lo de **paquetería** (paquetes y piezas sueltas) | **Lo captura el checador**: depende de cómo se acomodó, no se calcula |
| `UB 6` | Ubicación donde queda el pedido **esperando carga** | **Lo captura quien lo deja**; lo lee quien carga |

### 2.6 La ubicación por etapa: el proceso la pide, nadie la llena

Explicado por Francisco (2026-10-06): el proceso está diseñado para que **cada renglón lleve la
ubicación de cada paso**. Se surte en una **carreta** del área de surtido (MAZAPÁN y CH CUBIN en la
carreta 52, POPULAR CAM en la 53); ya checado pasa a embarques, y la ubicación de embarque es **en
qué estiba o posición del camión va**. Kepler lo guarda en `kdm2.c59` / `c60` / `c61`.

**No se usa porque la interfaz lo esconde:** las columnas quedan a la derecha de la tabla y hay que
desplazarla para llenarlas, así que los operadores se saltan el paso.

**Medido (renglones embarcados, 21 días):**

| Sucursal | Renglones | Ubic. surtido | Ubic. checado | Ubic. embarque |
|---|---|---|---|---|
| PH (01) | 12,021 | 0% | 0% | 33% |
| Canindo (06) | 8,936 | 66%, **99% relleno** (`1`/`A1`) | 70%, **99% relleno** (`2`/`A2`) | 65%, **99% relleno** (`3`/`A3`) |
| Morelia Abastos (08) | 4,291 | 0% | 0% | 0% |
| CEDIS (00) | 2,398 | 2% relleno | 1% relleno | 1% relleno |

**Conclusión: hoy no existe trazabilidad de dónde está un pedido dentro del almacén.** Es el hueco
que más valor tiene para la Suite, y la lección es de diseño, no de disciplina:

1. **La ubicación se pide en el momento del paso, no en una columna.** No puede estar fuera de la
   vista ni ser opcional.
2. **Se asigna una vez por grupo, no por renglón.** Al empezar a surtir se escanea o elige la
   carreta, y todos los renglones la heredan; sólo se cambia por excepción (un pedido que no cabe
   en una carreta). Teclear la misma carreta en 102 renglones es justo lo que hoy nadie hace.
3. **La posición en el camión se elige sobre un esquema del camión**, no escribiendo un número.
4. **Un valor que no puede ser real se rechaza.** Si existe catálogo de carretas y posiciones, el
   `1`/`2`/`3` de relleno no pasa.
5. ⭐ **Quien hace el trabajo es quien lo registra.** Francisco (2026-10-06), sobre por qué PH lo
   omite y Canindo lo acaba de implementar: *"si el operador apunta y la capturista no registra,
   pronto los dos dejan de hacer su trabajo"*. Hoy el operador anota en papel y otra persona lo
   teclea; cuando el registro no aparece, el operador deja de anotar. En la Suite **no hay
   intermediario**: el surtidor marca desde su celular o handheld y el registro existe en ese
   momento, con su nombre.

### 2.7 El recorrido físico del pedido (Francisco, 2026-10-06)

```
Área de surtido ──(carreta numerada)──▶ reja ──▶ checado ──▶ espacio de espera ──▶ camión
     c59 = carreta                            c60 = lugar de espera     c61 = estiba
```

- **Las carretas están numeradas** y se les puede pegar código. Se surte en un área; una **reja**
  separa surtido de checado y la carreta cruza de un lado al otro.
- **La "ubicación de checado" no es una mesa**: es el **espacio donde el pedido espera la unidad**
  para cargar, ya del otro lado de la reja. Es el mismo `UB` del comentario `CJ 16 P 10 UB 6`.
- **La ubicación de embarque es la estiba** del camión.
- **Equipo en piso: celulares y handhelds.** La pantalla se diseña para los dos (pulgar en celular,
  escáner en handheld).

⚠️ **El riesgo de la opción A está justo aquí.** Con la opción A, alguien todavía teclea el
resultado en Kepler: es el mismo relevo "operador → capturista" que hoy se degrada. Mitigaciones:
(1) la Suite le da a quien captura un resumen corto, no la tabla de 100 renglones; (2) GP.6 mide
cada día qué pedidos ya terminaron en la Suite y siguen sin avanzar en Kepler, con nombre de quien
debía capturarlos; (3) si el cuadre muestra que la captura se cae, ese dato es el argumento para
adelantar la opción B.

### 2.8 Lo que ya existe y se reusa

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
| **GP.3** | Pantalla del surtidor (móvil): lista por ubicación, marca por renglón (reemplaza el círculo de pluma), faltantes. **Reemplaza el ticket `Referencia SURTIDO`** | GP.2 + P3 |
| **GP.4** | Checado: otra persona, diferencias, regreso al surtidor; captura `P` (cajas de paquetería). **Reemplaza el ticket `Referencia CHECADO`** | GP.3 |
| **GP.5** | Embarque: `CJ` calculado, `P` y `UB` capturados (§2.5); liga a transporte y guía. **Reemplaza el ticket `Referencia EMBARCADO`** y el comentario escrito a mano | GP.4 |
| **GP.6** | Cuadre Suite ↔ Kepler: lo capturado en Kepler contra lo registrado en piso; y pedidos avanzados en Kepler **sin** paso por la Suite | GP.5 |
| **GP.7** | Indicadores: tiempo por etapa, productividad por persona, surtido completo (con unidad resuelta) | GP.6 |
| **GP.8** | Piloto: un origen, una sucursal (propuesta: **sucursal en PH**) | GP.3–GP.6 |

---

## 5. Preguntas abiertas

| # | Pregunta | Bloquea |
|---|---|---|
| ~~P1~~ | ✅ Un ticket por etapa (§2.4) | — |
| ~~P2~~ | ✅ `CJ` bultos cerrados · `P` cajas de paquetería · `UB` ubicación de espera (§2.5) | — |
| ~~P3~~ | ✅ Celulares y handhelds (§2.7) | — |
| ~~P12~~ | ✅ Carretas numeradas, se les puede pegar código (§2.7) | — |
| ~~P13~~ | ✅ Ubicación de checado = espacio de espera de unidad, pasando la reja (§2.7) | — |
| ~~P14~~ | ✅ Posición en el camión = estiba (§2.7) | — |
| ~~P15~~ | ✅ PH lo omite; Canindo recién implementado; se cae cuando el operador anota y nadie registra (§2.6) | — |
| P10 | ¿Cuántos espacios de espera hay por almacén y cómo se llaman? | GP.5 |
| P11 | ¿Quién arma las cajas de paquetería: el surtidor o el checador? | GP.4 |
| P16 | ¿Cuántas carretas hay por almacén? (para el catálogo y sus códigos) | GP.3 |
| P17 | ¿Cuántas estibas tiene cada tipo de camión y cómo se numeran? | GP.5 |
| P18 | ¿Hay wifi en toda el área de surtido, checado y espera? | GP.3 (define si la pantalla debe trabajar sin red) |
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
| **La captura en Kepler se degrada igual que hoy** (relevo operador → capturista, §2.6 punto 5) | Resumen corto para capturar + GP.6 diario con nombre del responsable; si se cae, es el argumento para la opción B |
| Se publica un % de surtido con unidades mezcladas | Prohibido hasta resolver la unidad (§2.3) |
| Querer escribir en Kepler "para ahorrar un paso" | Fuera de alcance por ADR-084; es la opción B y tiene su propio momento |
