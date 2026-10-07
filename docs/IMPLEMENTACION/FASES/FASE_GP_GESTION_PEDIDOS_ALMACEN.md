# Fase GP — Gestión de pedidos en almacén (surtido, checado y embarque sin papel)

> **Tesis (ADR-086 propuesto):** el pedido **sigue naciendo y viviendo en Kepler**. Lo que se
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
`UD4101-0002683` → pedido `UD4001-0002749`. Detalle en [`ERP_KEPLER.md` §3.y.3](../../ERP_KEPLER.md).

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
  escáner en handheld). **Hay wifi** en surtido, checado y espera: la pantalla trabaja en línea.
- **Las cajas de paquetería (`P`) las arma el checador** → se capturan en el checado (GP.4).

**Tamaño de los catálogos (por almacén):**

| Catálogo | Cuántos | Nombre hoy | Cómo se elige en pantalla |
|---|---|---|---|
| Carretas | 40–50 | Número | **Escaneo** del código pegado en la carreta (handheld) o **teclado numérico** (celular). Nunca una lista de 50 |
| Espacios de espera | ~10 | `A1`…`A4`, `B1`…`B3` | **Botones** con el nombre: con 10 opciones no hace falta buscar ni teclear |
| Estibas del camión | 10–30, según la unidad | Número | **Esquema del camión** por tipo de unidad, tocando la estiba |

**Decisión sobre los nombres:** se **conservan** `A1`, `B2`… Francisco ofreció pasarlos a sólo número
para buscar más rápido desde el celular, pero con ~10 espacios en botones no se busca nada, y la
letra dice en qué fila está, que le sirve a quien carga. El número sólo conviene en las carretas,
que son muchas.

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
| **GP.1** 🧪 | Tablero `/almacen/pedidos`: periodo (default mes en curso), filtro por estatus con conteos, origen, sucursal, texto; detalle por renglón y embarques. SQL directo sobre `kepler_ods`, **sin migración**. Código en `libs/commercial/src/lib/warehouse-orders/` + `apps/view/.../almacen-pedidos.component.ts` | GP.0 |
| **GP.2** | Origen Kepler para `commercial-picking`: el pool lee pedidos `U-D-40` `AUTORIZADO`. Agrupa por tamaño: 1–5 renglones en tandas, más de 5 pedido por pedido (§5.1) | GP.1 |
| **GP.3** | Pantalla del surtidor (móvil): lista por ubicación, marca por renglón (reemplaza el círculo de pluma), faltantes. **Reemplaza el ticket `Referencia SURTIDO`** | GP.2 + P3 |
| **GP.4** | Checado 3 · **unidad mayor**: escaneo de `C`+clave, conteo, espacio de espera. **Reemplaza el ticket `Referencia CHECADO`** | GP.3 |
| **GP.4b** | **Bultos de entrega** (§5c): abrir/cerrar `P1`, `P2`… al checar, contenido por bulto, etiqueta impresa, ubicación por bulto | GP.4 |
| **GP.5** | Embarque: se escanea **cada bulto** a su estiba; la Suite avisa los que faltan; liga a transporte y guía. **Reemplaza el ticket `Referencia EMBARCADO`** y el comentario escrito a mano | GP.4b |
| **GP.6** | Cuadre Suite ↔ Kepler: lo capturado en Kepler contra lo registrado en piso; y pedidos avanzados en Kepler **sin** paso por la Suite | GP.5 |
| **GP.7** | Indicadores: tiempo por etapa, productividad por persona, surtido completo (con unidad resuelta) | GP.6 |
| **GP.8** | Piloto: **PH, telemarketing** (decidido 2026-10-07, §5.1) | GP.3–GP.6 |

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
| ~~P10~~ | ✅ ~10 espacios, `A1`…`A4`, `B1`…`B3` (§2.7) | — |
| ~~P11~~ | ✅ El checador arma las cajas de paquetería | — |
| ~~P16~~ | ✅ 40–50 carretas por almacén | — |
| ~~P17~~ | ✅ 10–30 estibas según la unidad | — |
| ~~P18~~ | ✅ Hay wifi | — |
| ~~P4~~ | ✅ El checador es **siempre otra persona** que el surtidor (§5.1) | — |
| ~~P5~~ | ✅ **Por tamaño, no por origen**: 1–5 renglones en tandas; más de 5, pedido por pedido; un pedido grande de sucursal se reparte entre varios surtidores (§5.1) | — |
| ~~P6~~ | ✅ Sí: el tercer tipo "tienda" son las `TI00x` (§5.1) | — |
| ~~P7~~ | ✅ Si falta producto, **el pedido sale incompleto** (§5.1) | — |
| ~~P8~~ | ✅ Piloto: **PH, telemarketing** (§5.1) | — |
| ~~P9~~ | ✅ Sí: el pedido de sucursal se traspasa **a costo** (§5.1) | — |
| P19 | ¿Qué tipos de unidad hay y cuántas estibas tiene cada uno? (para dibujar el esquema). Francisco lo pasa | GP.5 |

### 5.1 Respuestas de Francisco (2026-10-07) y qué cambian

| # | Respuesta | Qué cambia en el diseño |
|---|---|---|
| P5 | Los pedidos **chicos (1–5 renglones) se surten en tandas**; los **más grandes, uno por uno**; y **en sucursal un pedido grande lo surten varias personas** según su tamaño | **GP.2:** el pool agrupa por **número de renglones**, no por origen (umbral 5, configurable). ⚠️ **Hueco del motor:** en `commercial-picking` una ola tiene **un solo** `assigned_to` → hoy no puede repartir **un** pedido entre varios surtidores. GP.2/GP.3 tienen que partir el pedido en tramos, cada uno con su surtidor. **Cómo se hace hoy (Francisco, 2026-10-07):** el sistema anterior **imprimía la hoja ordenada por pasillo** (A, B, C…), y quien organiza el surtido **rompe la hoja en un cambio de pasillo**: uno surte de la **A a la L** y otro de la **M en adelante**. La Suite copia eso: el pedido se ordena por pasillo y se parte en **rangos de pasillos** (normalmente 2), con el corte **siempre entre pasillos, nunca a mitad de uno**. Lo decide quien organiza; la Suite le propone el corte que deja las dos mitades con un número de renglones parecido. El código de ubicación vuelve a ser **pasillo-rack-nivel** como en Wincaja (`BC110` = pasillo B, rack C, nivel 1, posición 10; `FASE_WMS` §12.5). ⚠️ **Depende de que cada producto tenga ubicación** (capa 2 de ubicaciones, ADR-087 / `FASE_WMS` §12, piloto PH). Hoy **ningún** producto la tiene en la Suite; Wincaja la tenía para el **38%** de los productos de PH con existencia y sirve de propuesta para el censo: un producto sin pasillo va en un bloque aparte, **"sin pasillo"**, a la vista, nunca escondido en alguna de las dos mitades |
| P7 | Si falta producto, **se manda incompleto** | **GP.3:** el surtidor marca el faltante con su cantidad y el pedido sigue a checado. No hay estado "en espera" ni sustitución. El faltante queda registrado para el cuadre con Kepler (GP.6) |
| P4 | El checador es **siempre otra persona** | **GP.4:** la Suite **impide** que quien surtió un renglón lo cheque. Si en Kepler los tres responsables salen iguales (embarque 2683, todos `01`), es dato de captura, no de piso |
| P8 | Piloto en **PH, telemarketing** | **GP.8** deja de proponer "sucursal en PH". Telemarketing tiene mediana de 7 renglones: el piloto ejercita las tandas (1–5) y el pedido por pedido, pero **no** el reparto entre varios surtidores, que se prueba después con sucursal |
| P6 | El "tercer tipo, tienda" son las `TI00x` | El tablero separa el destino de un pedido de sucursal en **tienda (`TI00x`)**, **ruta (`RUTA 21/22`)** y **reparto directo (`RD 50x`)** |
| P9 | El pedido de sucursal se traspasa **a costo** | El descuento lleva el precio de lista al costo. **Un pedido de sucursal no es venta**: el tablero no debe sumar su importe junto con el de telemarketing |

---

## 4b. Carga de operación medida (pedidos `U-D-40` embarcados, 08-sep → 05-oct-2026, prod solo lectura)

37,207 renglones en 1,982 pedidos. "Unidad mayor" = la más grande que el producto tiene en `kdii`
de su sucursal (unidad tres; si no hay, la dos; si no, la base). Todo producto tuvo ficha.

**Por origen:**

| | Sucursal | Telemarketing |
|---|---|---|
| Pedidos/día (todas las sucursales) | 33.1 | 40.5 |
| Renglones/día | 905 | 457 |
| Renglones por pedido: promedio · mediana · p90 · máx | 27.3 · 11 · 85 · 148 | 11.3 · 7 · 27 · 160 |
| Renglones en **unidad mayor** (checado 3) | **34%** | **56%** |
| Renglones en **unidad menor** (checado 3b) | **66%** | **44%** |
| Cajas (unidad mayor) por pedido: promedio · p90 | 75 · 159 | 15.5 · 40 |
| Pedidos sólo de paquetería | 6.1% | 15.7% |
| **Pedidos muy chicos** (sin cajas, ≤5 renglones: candidatos a contenedor compartido) | 3.9% | **12.4%** |
| Importe promedio | $30,386 | $9,919 |

Unidades menores: `PAQ` 19,687 · `KG` 1,487 · `PZA` 578 · `BTO` 66 · `500` 42 · `250` 21.

**Por sucursal (las que tienen ≥10 pedidos):**

| Sucursal · origen | Pedidos/día | Renglones/día | Renglones/pedido (p90) | Cajas/pedido | Renglones menores/pedido | Muy chicos |
|---|---|---|---|---|---|---|
| 00 · sucursal | 10.4 | 130 | 12.5 (33) | 187.7 | 0.8 | 3.8% |
| **01 PH · sucursal** | 12.7 | **476** | 37.6 (94) | 32.1 | **27.1** | 0.9% |
| **01 PH · telemarketing** | **22.6** | 216 | 9.6 (26) | 12.1 | 4.8 | **24.9%** |
| 06 Canindo · sucursal | 6.8 | 332 | 48.8 (104) | 34.8 | 41.0 | 0.6% |
| 06 Canindo · telemarketing | 15.3 | 154 | 10.1 (22) | 17.3 | 3.5 | 2.6% |
| 08 Morelia Abastos · sucursal | 7.9 | 59 | 7.5 (16) | 33.3 | 1.4 | 4.2% |
| 08 Morelia Abastos · telemarketing | 13.1 | 232 | 17.7 (37) | 20.1 | 8.2 | 1.5% |

**PH, el piloto:** 30.9 pedidos y 650 renglones al día en promedio (máximo 50 pedidos y 1,078
renglones), ~627 cajas al día (máximo 1,332). Lunes a jueves cargan más (32–44 pedidos, 670–900
renglones); sábado ~13 pedidos; domingo casi nada. **Los pedidos se crean sobre todo de 14:00 a
19:00** (pico de renglones a las 16:00, ~139 renglones/hora); el telemarketing se concentra de
10:00 a 17:00 y los pedidos de sucursal se alargan hasta las 19:00.

**Lo que esto decide:**
1. **El checado de paquetería (3b) es el trabajo pesado en los pedidos de sucursal** (27–41
   renglones de paquetería por pedido en PH y Canindo). El de unidad mayor (3) es corto.
2. **El contenedor compartido importa en PH telemarketing:** 1 de cada 4 pedidos es muy chico,
   ~5–6 al día. En Canindo y Morelia casi no.
3. **El CEDIS (00) despacha casi sólo cajas cerradas** (188 por pedido, <1 renglón de paquetería).
   ⚠️ Esta ventana es casi toda anterior al corte del 1-oct, cuando el `00` era concentrador
   (Fase PO): **no proyectar el 00 hacia adelante** sin re-medir.
4. **Las listas son largas:** p90 de 85–104 renglones en sucursal. La pantalla del surtidor agrupa
   por pasillo y la del checado sólo muestra lo pendiente.

**No medido:** peso y volumen físico de la carga (m³, kg por camión). Kepler no se usó para eso y
no se verificó si `kdii` tiene dimensiones; se declara, no se estima.

## 5a. El checado es por escaneo (Francisco, 2026-10-06)

**Se divide en dos pantallas por la unidad del renglón** (Francisco, 2026-10-06):
- **Checado 3 · unidad mayor**: los renglones pedidos en la unidad más grande del producto (caja,
  bulto). Se escanea la etiqueta `C`+clave, se cuentan y se mandan a su espacio de espera. Cada
  caja es un bulto `CJ`.
- **Checado 3b · unidades menores**: paquetes, piezas, `KG`, `500`, `250`, cubetas… todo lo que
  esté en una unidad inferior a la mayor. Se arma en cajas `P` del pedido o en contenedores
  compartidos (§5c), y aquí se pesa lo que se vende por kilo.

**El checador "rastrilla"**: escanea cada artículo y la Suite lo registra contra el pedido. El
código dice **qué producto y en qué unidad** (pieza, paquete o caja; decode completo en
[`ERP_KEPLER.md` §3.y.4](../../ERP_KEPLER.md)), así que un escaneo del paquete cuenta un paquete y
uno de la caja cuenta una caja.

**Lo que la pantalla hace con cada escaneo:**
- Suma en la unidad del código y lo convierte a la unidad del pedido con el factor de `kdii`.
- **Producto que no va en el pedido** → alerta inmediata ("no va en este pedido").
- **Más de lo pedido** → alerta en ese renglón.
- Al terminar, lista **sólo lo que no cuadra**: faltantes, sobrantes y productos ajenos.

**Las cajas SÍ se escanean.** Medido en PH: el 94% de lo que se pide en pieza y el 51% de lo que se
pide en paquete tiene EAN, y sólo el 1% de lo que se pide en caja; el resto trae el código interno
`C`+clave (`C06001`). **Pero ese código sí está impreso: todo se reetiqueta al ingresar con
`C`+clave** (Francisco, 2026-10-06). Así que la casilla `c85` se lee y el escaneo de cajas cubre
casi todo. Respaldo para la caja que llegue sin etiqueta: escanear la pieza y teclear cuántas cajas.

**Productos que se venden por kilo:** el checado tiene báscula y **ahí se cobra el peso exacto**
(Francisco, 2026-10-06). Es lo que explica los 160 renglones con peso decimal de PH (p. ej. 6.14 kg).
El checador escanea el producto y **captura el peso** de la báscula; la pantalla lo pide sólo en
los productos cuya unidad de venta es `KG`.

## 5c. Los bultos de entrega (P1, P2…): cada uno con contenido y ubicación (Francisco, 2026-10-06)

Al checar, la paquetería suelta se empaca en **cajas de entrega**: `P1`, `P2`… (el `P 10` del
comentario `CJ 16 P 10 UB 6`). Lo que pide el piso: **que quede claro qué mercancía va en cada P y
dónde está cada P** (en qué carreta o espacio de espera, o en qué posición de embarque).

Es lo que los WMS líderes llaman **bulto con identidad** (LPN / handling unit). El diseño:

1. **El checador arma el bulto escaneando.** Abre `P1` (la Suite imprime su etiqueta), escanea lo
   que mete, lo cierra y escoge dónde lo deja; luego abre `P2`. Cada escaneo cae en **el bulto
   abierto**. Mover un producto de un bulto a otro es un escaneo, no una corrección a mano.
2. **La etiqueta del bulto** lleva folio + número + total (`PD 0002781 · P3 de 10`), cliente,
   destino y un código propio. Se escanea para moverlo, cargarlo y entregarlo.
3. **Cada bulto tiene ubicación propia**, igual que una carreta: `C52` → `E02` → estiba del camión.
   Mover el bulto = escanear su etiqueta y la ubicación nueva.
4. **Las cajas cerradas (`CJ`)** ya traen la etiqueta `C`+clave; cuentan como bultos (cada caja es
   uno) y también registran dónde quedan.
5. **Al cargar** se escanean los bultos, no los productos. La Suite cuadra contra lo checado:
   **"faltan P7 y P9"** antes de que salga el camión.
6. **Al entregar** (Logística, POD), el cliente recibe y firma por bultos (`10 P + 16 CJ`); si
   reclama, se sabe qué había en cada uno.

Resultado: el manifiesto del pedido deja de ser un comentario escrito a mano (`CJ 16 P 10 UB 6`) y
pasa a ser una lista de bultos con contenido y ubicación.

**Tres tipos de bulto** (Francisco, 2026-10-06):

| Tipo | Qué es | Contiene | Identificación | Vida |
|---|---|---|---|---|
| **CJ** | Caja cerrada del producto | Un producto | `C`+clave, impresa al ingresar | Sale con el cliente |
| **P** | Caja de cartón de paquetería | **Un pedido** | Etiqueta impresa al cerrar (`PD 0002781 · P3 de 10`) | Sale con el cliente |
| **Contenedor de plástico** | Caja de plástico | **Pedidos muy chicos de VARIOS clientes** (no se embolsan) | **Número o QR fijo**, pegado una vez | **Regresa** al almacén |

Lo que cambia por el contenedor de plástico:
- **El contenido se registra por pedido dentro del contenedor**: al escanear, cada artículo queda
  ligado al contenedor **y** a su pedido. El repartidor ve qué le toca a cada cliente.
- **Se reutiliza**: su número es permanente, no se imprime por pedido. Se libera cuando se entrega
  todo su contenido, y la Suite puede saber **qué contenedores no han regresado**.
- Un pedido puede estar repartido entre una `P` propia y un contenedor compartido; el manifiesto del
  pedido lista los dos.

**Productos por peso:** se identifican igual por su código (ej. `17083` ALTOS CAM CHICA COLOR 1KG,
base kilogramo, bulto de 20 kg = `C17083`); el peso exacto se captura en la báscula del checado.

**Dato propio de la Suite** (tabla real, permitido: no existe en Kepler): bulto (pedido, número,
tipo P/CJ, ubicación, estado) + contenido (bulto, producto, unidad, cantidad).

## 5b. Relación con la Fase WMS (descubierta 2026-10-06)

[`FASE_WMS`](FASE_WMS.md) ya planeaba la salida del almacén (WMS.5 surtido, WMS.6 checado) y las
ubicaciones (WMS.2–WMS.4). **GP no la duplica: es su implementación para los pedidos de Kepler.**
- GP.3 / GP.4 = WMS.5 / WMS.6 sobre el pedido `U-D-40`.
- La lista del surtidor se ordena por la **secuencia de recorrido** de WMS.4.
- Carretas, espacios de espera y estibas son ubicaciones de tipo `contenedor`/`espera` del catálogo
  de ubicaciones (ADR-087, `FASE_WMS` §12).
- ADR-086 contesta la decisión abierta WMS §6.2 y la medición de §2.1 contesta §6.3.

## 6. Riesgos

| Riesgo | Mitigación |
|---|---|
| El almacenista avanza el pedido en Kepler **sin** pasar por la Suite y el piloto queda vacío | GP.6 detecta esos pedidos y los declara |
| Diferencias de captura al teclear en Kepler | Mismo cuadre de GP.6 |
| **La captura en Kepler se degrada igual que hoy** (relevo operador → capturista, §2.6 punto 5) | Resumen corto para capturar + GP.6 diario con nombre del responsable; si se cae, es el argumento para la opción B |
| Se publica un % de surtido con unidades mezcladas | Prohibido hasta resolver la unidad (§2.3) |
| Querer escribir en Kepler "para ahorrar un paso" | Fuera de alcance por ADR-086; es la opción B y tiene su propio momento |
