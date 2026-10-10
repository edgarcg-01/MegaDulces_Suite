# Fase GP — Gestión de pedidos en almacén (surtido, checado y embarque sin papel)

> **Tesis (ADR-086 propuesto):** el pedido **sigue naciendo y viviendo en Kepler**. Lo que se
> mueve a la Suite es el **trabajo de piso**: surtir, checar y embarcar, que hoy se hace sobre hojas
> impresas desde Kepler. La Suite registra quién hizo cada paso, cuándo y con qué cantidades, y el
> almacenista le captura a Kepler **una sola vez** el resultado. **La Suite no escribe en Kepler.**
>
> Origen: conversación con Francisco, 2026-10-06 (menú *Almacenes › Control de Pedidos* de Kepler).

Estado: **🔨 EN CURSO.** GP.1 (tablero) en `main` (#271). **GP.2 🧪 en código 2026-10-07** (§7): el
pedido de Kepler entra al motor de surtido. Decode del pedido `U-D-40` verificado contra prod en
solo lectura.

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

## 7. GP.2 — El pedido de Kepler entra al motor de surtido (🧪 en código, 2026-10-07)

**Qué hace.** El motor de surtido de la Fase SU (`libs/commercial/src/lib/commercial-picking/`, ADR-067)
sólo sabía leer `commercial.orders`. Ahora también lee el pedido Kepler `U-D-40`, **sin copiarlo**:
la ola guarda la llave `(sucursal, serie, folio)` y el pedido y sus renglones se leen del ODS cada vez.

| Pieza | Dónde |
|---|---|
| Migración: `wave_orders.source` (`suite`/`kepler`) + `kepler_sucursal/serie/folio` + 3 CHECK | `database/migrations-newdb/20261007260100_wave_orders_origen_kepler.js` |
| Identidad del pedido, plan de tandas, consultas al ODS | `commercial-picking/kepler-origen.ts` (+ `.spec.ts`) |
| `GET /reparto/surtido/pool-kepler?warehouse_id&origen&days` | pool: `AUTORIZADO`, fuera de cualquier ola, con `tamano` y `sin_catalogo` |
| `POST /reparto/surtido/waves/auto-kepler` | arma la **tanda** (1–5 renglones) y **una ola por pedido** mayor |
| `POST /reparto/surtido/waves` acepta `kepler_orders: [{ sucursal, serie, folio }]` | junto o en lugar de `order_ids` |
| Contrato | `libs/contracts/src/http/warehouse-picking-kepler.contract.ts` |

**Decisiones de diseño:**

1. **`order_id` determinista.** Un pedido Kepler no tiene UUID; se deriva de la llave:
   `md5('kepler/UD40/' || sucursal || '/' || serie || '/' || folio)::uuid`. Así no se toca el índice
   "un pedido en una sola ola viva" ni `wave_allocations`. Un CHECK obliga a que el id salga de la
   llave, y una prueba compara el cálculo en TypeScript contra el que hace Postgres.
2. **Sale del pool si está en CUALQUIER ola**, no sólo en una viva: en Kepler sigue `AUTORIZADO`
   hasta que se captura el resultado (ADR-086), y sin esto un pedido ya surtido volvería al pool.
3. **Ventana de 7 días** (0–60): medido, quedan pedidos `AUTORIZADO` de julio. No se esconden: se
   cuentan en `atorados` (PH: 7, desde el 15-jul).
4. **Dos cantidades por renglón.** Se suma y reparte la **unidad base** (`c9`/`c11`, p. ej. 75 KG);
   la **presentación** de la hoja (`c56`/`c55`, 3 BTO) viaja aparte para mostrarse (GP.3).
5. **El reparto ya no trunca decimales.** `allocation.ts` trataba la fracción como dato sucio
   (`7.9 → 7`); con KG eso pierde mercancía. Ahora cuenta en milésimas (la precisión de la base).
   Cambia también el reparto de pedidos de la Suite: un pedido de 7.9 recibe 7.9, no 7.
6. **Un renglón con clave fuera del catálogo frena el pedido**, con su clave. No se arma la ola sin
   él: sería mandarlo incompleto sin que nadie lo decidiera (medido: 1 de 2,884 claves de PH).
7. **Mismo producto en dos renglones del pedido**: se suman antes de repartir (`wave_allocations`
   tiene UNIQUE por pedido y producto).
8. **El mismo producto en dos unidades frena la ola** (lo encontró la revisión independiente):
   medido, **248 pares sucursal×clave** traen más de una unidad en `kdm2.c11` (p. ej. `02135` en PAQ
   y PZA). Sumarlas daría un número que no se puede surtir. Se revisa al crear la ola (en la misma
   transacción, así no queda a medias) y al arrancarla. Si una tanda no se puede armar por eso,
   `auto-kepler` reintenta cada pedido solo para que uno no frene a los demás.
9. **Si el pedido cambia en Kepler después de arrancar, el cierre se frena** (también de la
   revisión): Kepler deja editar el pedido `AUTORIZADO` mientras se surte, y el reparto lee el
   pedido en vivo. Al cerrar se compara contra lo congelado en `wave_lines`; si difiere, se nombran
   las claves y se pide cancelar y volver a armar. Pendiente para GP.3: congelar el desglose por
   pedido al arrancar, para no tener que frenar.

**Declarado, sin cambiar:** en una ola que mezcle pedidos de la Suite y de Kepler (sólo posible
armándola a mano con `POST waves`; `auto-kepler` nunca mezcla), los de Kepler pierden el desempate del
reparto porque no tienen fecha de entrega comprometida. `atorados` cuenta también pedidos que ya
están en una ola esperando que se capturen en Kepler.

**Medido contra prod (solo lectura, 2026-10-07):** pool de PH en 168 ms con 4 pedidos (3 de
telemarketing de 1, 6 y 11 renglones; 1 de sucursal **sin renglones**, que cae en `vacios`); 7
atorados; 7 renglones con producto resuelto y el UUID derivado igual al de Postgres.

**No incluye (siguiente):**
- **Pantalla.** El motor de surtido no tiene ninguna todavía; la del surtidor es GP.3.
- **Repartir un pedido grande entre varios surtidores por rango de pasillos** (§5.1): necesita la
  ubicación de cada producto (`FASE_WMS` §12.5), que hoy no existe. Además el índice "un pedido en
  una sola ola viva" lo impide tal como está; GP.3 tendrá que partir el pedido en tramos.
- **`faltantes` y `avisos`** siguen leyendo sólo pedidos de la Suite.
- **Alcance por sucursal** (`ScopeService`) en el pool: el pool de la Suite tampoco lo tiene.

## 8. GP.3 — La pantalla del surtidor: "tomar el siguiente" (🔨 en curso, 2026-10-08)

**Decisión de Francisco (2026-10-07):** el sistema anterior tenía una consola central que asignaba
pedidos a surtidores y checadores y les entregaba la hoja. En la Suite **el surtidor jala el trabajo
desde el celular**: aprieta "Tomar siguiente" y el sistema le da lo que más urge. No elige cuál (nadie
se queda con los fáciles). **La consola queda para lo que pide criterio**: partir un pedido grande por
pasillos, urgentes y reasignar. El checador tendrá su propia cola (GP.4) y el sistema nunca le dará lo
que él surtió (P4).

Se entrega en dos partes: **GP.3a** el motor (backend) y **GP.3b** la pantalla.

### 8.1 GP.3a — el motor (🧪 en código)

| Pieza | Qué hace |
|---|---|
| `POST /reparto/surtido/waves/next` `{ warehouse_id, origen? }` | Devuelve la ola que el surtidor ya trae (abierta o en surtido) o le asigna la **libre más vieja** de su almacén con `FOR UPDATE SKIP LOCKED`. Si no hay libres, **las arma desde el pool de Kepler** (regla de tandas) y vuelve a intentar. La **arranca** al asignarla. |
| `GET /reparto/surtido/waves/mine` | Las olas que trae quien consulta, con sus renglones. Va declarada antes de `waves/:id`. |
| Mig `20261008003045` | `commercial.wave_order_lines` (lo que pidió cada pedido, **congelado al arrancar**, RLS forzado) + `wave_lines.qty_presentacion/unidad_presentacion` + `picking_waves.origen/armada_por` + índice parcial `ix_pw_libres`. |
| `congelar.ts` (+ spec) | Funciones puras: agrupa por (pedido, producto) y suma la presentación sólo si es la misma unidad. |

**Decisiones:**
1. **Una ola a la vez por surtidor**; cerrar la app no le hace perder su trabajo (`waves/next` le
   devuelve la misma).
2. **El reparto usa lo congelado al arrancar**, no el pedido en vivo. Con eso, **un cambio en Kepler a
   medio surtido ya no frena el cierre** (GP.2 lo frenaba): se devuelve en `cambios_en_kepler` para que
   el checador y el cuadre (GP.6) lo vean. Sólo una ola sin congelado (anterior a GP.3) sigue frenando.
3. **El surtidor ve la presentación de la hoja** (3 BTO) cuando todos los pedidos la piden igual; si no,
   la unidad base. El reparto sigue en unidad base.
4. **Si una ola ya no se puede arrancar al tomarla** (el pedido o el catálogo cambiaron desde que se
   armó), se cancela con su motivo y se toma la siguiente. Sin eso, el surtidor quedaría atorado.

**Defecto encontrado y corregido (venía de SU.6):** `String(fecha).slice(0,10)` sobre un `date` de pg
da `"Thu Oct 08"`, no `2026-10-08` (pg devuelve un objeto Date; el proyecto no configura el parser).
El reparto ordenaba la prioridad de entrega **por día de la semana** (`Fri < Mon < Thu`). Ahora la fecha
sale de `to_char` en el SQL, igual que en LC.16.

**Verificado:** 65 pruebas (11 nuevas de `congelar`, con 2 mutaciones en rojo); `tsgo` y
`lint:boundary` en verde; migración real contra Postgres local (up, up repetido, RLS forzado, down que
aborta con datos, todo en transacción deshecha); **dos conexiones tomando a la vez se llevan olas
distintas sin esperar**.

**No verificado:** los endpoints por HTTP (no se levanta la API en sesión; lo compila el CI).

**Despliegue:** la migración `20261008003045` va **antes** del código.

### 8.2 GP.3b — la pantalla (🧪 en código)

`/almacen/surtir` (`almacen-surtir.component.ts`), pantalla de **foco** (sin barra de pestañas, molde
`almacen-rutas-contar`), permiso `COMMERCIAL_PICKING_GESTIONAR` (lo tienen los 6 almacenistas desde
[VEC.0]). Entra en el menú por el área **Pedidos** como entrada de foco: el almacenista no tiene
`ALMACEN_PEDIDOS_VER`, y sin esa entrada el área no se le pintaría.

- Elige almacén (se recuerda en el dispositivo; por omisión el de su ficha) y origen (Todos /
  Telemarketing / Sucursal), y aprieta **Tomar siguiente**.
- Renglones en dos grupos, **Por surtir** y **Ya surtidos**, con la cantidad en la presentación de la
  hoja (3 BTO) y la base debajo. Botones grandes **Completo** / **Faltante**; el faltante se captura en
  la unidad que ve y se convierte a la base. **No había (0)** y **corregir**.
- Cada toque se guarda en el servidor al momento; no hay borrador local. Buscador por nombre o código.
- **Terminé de surtir** apagado mientras haya renglones sin tocar. Al cerrar, resumen y, si el pedido
  cambió en Kepler, el aviso para el checador.

### 8.2.1 Correcciones de la revisión independiente (antes del commit)

| Hallazgo | Corrección |
|---|---|
| **Una ola asignada pero sin arrancar se podía cerrar como "surtida" sin surtir nada** (sin renglones = 0 pendientes) | `finishPicking` exige `en_surtido` y al menos un renglón; la pantalla retoma la ola con `waves/next`, que la arranca |
| **El mismo surtidor podía quedarse con DOS olas** (dos pestañas o un reintento: "¿ya trae una?" y "reclama una libre" iban en transacciones separadas) | Las dos en UNA transacción con `pg_advisory_xact_lock` por persona. Probado con dos conexiones: la segunda espera y recibe la misma ola |
| **El filtro de origen se ignoraba al tomar** (sólo se usaba al armar) | `picking_waves.origen` (el de sus pedidos si todos coinciden) y el reclamo filtra por él |
| **"Tomar siguiente" cancelaba olas armadas a mano** por la consola si no arrancaban | `picking_waves.armada_por` (`auto`/`consola`): sólo las `auto` se cancelan; las de la consola se **liberan** con el motivo en sus notas y se avisan en `atoradas` |
| El total del renglón podía diferir en ±0.001 de la suma congelada por pedido (KG de más de 3 decimales) | `wave_lines.qty_requested` = suma de lo congelado |
| Pantalla: doble Enter mandaba dos veces; un 409 (ola cancelada) la dejaba sin salida; un error viejo quedaba a la vista; presentación en 0 | Corregidos |

### 8.2.2 Prueba de la pantalla y revisión de usabilidad (2026-10-08)

**Prueba nueva** `almacen-surtir.component.spec.ts` (36 casos): monta la pantalla real con el servidor
simulado y recorre lo que hace el surtidor (retomar, tomar, Completo, Faltante, No había, Corregir,
buscar/escanear, cerrar, sin trabajo, errores). **Encontró dos defectos que `tsc` y `ngc` no ven:**

1. **El buscador no encontraba nada al escanear un código**: los argumentos de `coincideBusqueda` iban al
   revés (la consulta va primero).
2. **Si al retomar un surtido fallaba la red, la pantalla se quedaba en "Cargando…" para siempre.**

Las dos con prueba de mutación (se quita el arreglo y la prueba se pone en rojo).

**Revisión de usabilidad contra `DESIGN.md`** (independiente), corregido:

| Antes | Ahora |
|---|---|
| Al marcar, el renglón se iba a otra sección y el siguiente subía **bajo el pulgar** (un segundo toque marcaba el equivocado) | La lista no se mueve: el renglón marcado **se encoge en su lugar** a una línea con "Corregir" (deshacer). 85 renglones caben en una lista corta. "Ocultar los ya surtidos" |
| La cantidad casi del mismo tamaño que el nombre | Cantidad en `--fs-display` (número) y la unidad un escalón abajo |
| El escáner: sin código de barras, Enter no hacía nada | Busca por **código de barras**, código y nombre; Enter con un solo resultado lleva el foco a su "Completo" (no lo marca solo) |
| Escanear algo ajeno decía "Ya pasaste por todos los renglones" | "Ningún renglón de este surtido coincide con «…»" |
| "No había (0)" chico y pegado a Guardar | "No había nada" separado, a lo ancho y con borde de peligro |
| Botones de texto y "Terminé de surtir" por debajo de 44 px | Todos con `--tap-min`; "Terminé de surtir" del tamaño de "Tomar siguiente" |
| Guardar se apagaba sin decir por qué | "Entre 0 y 3 BTO" / "No puede ser más de 3 BTO"; teclado entero para cajas, decimal sólo por peso |
| Sin aviso de conexión; errores sólo en un aviso de 4 s | Banda "Sin conexión"; los errores quedan en pantalla con "Reintentar" |
| El foco se perdía al marcar; la barra de avance sin nombre | El foco pasa al siguiente "Completo"; región `aria-live` con lo que pasó; progressbar con `aria-valuetext` |
| Radios, duraciones y anillos de foco con valores sueltos | Tokens `--r-*`, `--dur-*`, `--focus-ring`; `:active` y `prefers-reduced-motion` |
| "pedido(s)", "consola", "Levantaste 2 BTO" | Plurales correctos, "tu supervisor", "Faltaron 1 de 3 BTO" |
| "Salir" iba al tablero, que el almacenista no puede abrir | Va a `/almacen` |

**Declarado, no hecho:** el foco NO se pone solo en el buscador al entrar (en un celular abriría el
teclado encima de la lista); el skeleton de carga (la pantalla hermana usa el mismo spinner).

**Declarado, sin cambiar:** el factor de conversión de un faltante capturado en bultos es el **promedio**
del renglón (75 KG / 3 BTO); con bultos de peso variable entre pedidos no es el peso de cada bulto.

### 8.3 GP.3c — quién decide la fila (Francisco, 2026-10-08)

Pregunta de Francisco al ver la pantalla en prod: *¿quién prioriza la fila, quién decide las tandas o
partir un pedido? Es delicado por los cuellos de botella. Y la tarjeta debería traer existencia y
ubicación: da certeza y orden.*

**Decisiones (Francisco, 2026-10-08):**
- **Manejan la consola de surtido:** coordinador de embarques, encargado de tienda, supervisor y
  gerente de zona. Permiso propio (no `COMMERCIAL_PICKING_GESTIONAR`, que tiene el surtidor: el que
  surte no se prioriza a sí mismo).
- **La hora de salida la captura el coordinador** cada día, por destino; la fila se ordena por ella
  (urgentes primero, luego la salida más próxima, luego lo más viejo).
- **El sistema propone, el coordinador decide**: el umbral de la tanda se ajusta por almacén y partir
  un pedido grande por pasillos es decisión del coordinador (cuando haya ubicaciones, Fase UB).

#### 8.3.1 GP.3c.1 — existencia y ubicación en la tarjeta (🧪 en código)

La tarjeta del surtidor dice **"Hay 618 PAQ en el sistema"** (ámbar si alcanza para menos de lo pedido,
rojo si no hay) y la **ubicación** ("Sin ubicación dada de alta" hasta la Fase UB), y arriba **de cuándo
es la existencia** ("de hace 42 min").

- Fuente: `analytics.v_erp_stock_on_hand` (la de `/almacen/inventory/existencia`) filtrada por almacén
  y productos — 314 ms medidos con 25 productos de Morelia Abastos; sin filtro tarda más de un minuto.
- **Unidad verificada, no supuesta**: en 42,957 renglones `U-D-40` de 30 días la unidad del pedido
  (`kdm2.c11`) es la base del producto (`kdii.c11`) en el **99.65%**. En el 0.35% que difiere
  (PAQ pedido / KG en existencia) la pantalla la muestra **sin comparar**.
- **Sin dato no es cero**: `existencia: null` dice "sin dato en el sistema", nunca "sin existencia".
- El botón principal apagado se ve **gris** (el naranja al 55% se leía como "listo para tocar").

#### 8.3.2 GP.3c.2 — la consola del coordinador (🧪 en código)

Pantalla `/almacen/surtido-consola` (tab **Consola de surtido** del área Pedidos), permiso propio
`ALMACEN_SURTIDO_COORDINAR`. API `/reparto/surtido/consola`.

- **La fila en el mismo orden en que "Tomar siguiente" la da**: urgente → la salida más próxima de sus
  destinos (hoy, hora de México) → lo más viejo. La regla está escrita arriba de la tabla; no hay otra
  escondida. Cada surtido dice quién lo trae ("Libre" si nadie), avance (renglones tocados / total) y
  desde hace cuánto.
- **Urgente** (exige motivo, se guarda quién y cuándo), **Liberar** (sólo si alguien lo trae; vuelve a
  la fila con lo ya marcado) y **Cancelar** (exige motivo; sus pedidos vuelven a quedar por armar). Se
  confirman en la misma fila, no en un diálogo, para ver qué surtido se está tocando.
- **Salidas de hoy**: un renglón por destino con pedidos (Kepler `kdm1.c10`/`c32`), con cuántos
  faltan por armar y cuántos van en surtido; el coordinador escribe la hora y guarda. El destino se
  guarda en `wave_orders.destino_code` al armar la ola, para que "tomar" no relea Kepler.
- **Por armar**: cuántos pedidos autorizados no tienen surtido (en tanda / solos), los bloqueados por
  claves fuera del catálogo y los atorados; botón **Armar surtidos ahora** (por origen).
- **Tanda**: el umbral (antes fijo en 5) se ajusta por almacén, de 1 a 50 renglones; aplica a lo que
  se arme desde entonces.
- **Alcance**: el encargado sólo ve y maneja su sucursal (`ScopeService`, fail-closed); un almacén
  fuera de su alcance responde igual que uno que no existe. Con varios almacenes, un selector.
- La fila se relee sola cada 30 s, salvo a media acción o con una hora sin guardar.

**Migración `20261008021159_gp3c_consola_surtido`** (va ANTES del código; crea esquema):
`picking_waves.prioridad/_motivo/_por/_at`, `wave_orders.destino_code/_nombre`,
`commercial.picking_departures` (hora por almacén, día y destino; RLS) y
`commercial.picking_settings` (umbral por almacén; RLS). Reparte `ALMACEN_SURTIDO_COORDINAR` a
`coordinador_embarques` (1 persona), `encargado_tienda` (7) y `supervisor` (1). "Gerente de zona":
las 3 personas del puesto ya son `superadmin`; su rol por omisión, `supervisor_ventas`, es de ventas
y no se le da. **Los 9 deben volver a entrar** (el permiso viaja en el JWT).

Probado: la migración con `up`/`down` reales en Postgres local (el orden de la fila, los dos CHECK,
el `down` que aborta si ya hay horas capturadas); la consulta de almacenes contra prod (sólo
lectura); 14 pruebas de la pantalla montada y 4 de la pestaña.

#### 8.3.3 Correcciones de las revisiones independientes (código y usabilidad, antes del PR)

- **"Tomar siguiente" le habría dado a otro una ola que alguien está caminando.** Para retomar lo
  liberado, la toma aceptaba `en_surtido` sin dueño, pero la pantalla de Reparto arranca olas así.
  Ahora liberar deja una marca (`liberada_at/_de/_por`) y sólo se retoma lo marcado. Probado en
  Postgres: la ola de Reparto no se le da a nadie (prueba negativa).
- **A quien le quitan la ola ya no la puede marcar ni cerrar** (409 "te lo quitaron desde la
  consola"). Sólo frena a esa persona; la pantalla de Reparto sigue igual.
- **Liberar y urgente sólo escriben si la ola sigue como la vio la consola** (dueño y estado). Si
  entre medio se cerró o la tomó otro, responde 409 en vez de borrar quién la surtió.
- **Las acciones piden alcance de ESCRITURA** de la sucursal (`assertCanWrite`), no sólo de lectura.
- Destino: se guarda recortado, y la validación de la hora ya no rechaza códigos válidos (medido en
  prod: hasta 13 caracteres, ninguno raro). FK de `warehouse_id` en las dos tablas nuevas. El
  `down` cuenta sin RLS para no borrar horas capturadas.
- Pantalla:
  - el turno es el real de "Tomar siguiente" (lo tomado no tiene turno);
  - "Lo trae hace 5 min" en lugar de la hora en que se armó;
  - quitar urgente también se confirma;
  - botones con verbo ("Marcar urgente", "Cancelar surtido", "Volver");
  - cancelar avisa si ya se levantó mercancía;
  - el refresco no pisa el umbral tecleado, no corre con la pestaña oculta, no reordena bajo el dedo
    y descarta respuestas de otro almacén;
  - "Reintentar" sólo aparece cuando falló leer la fila;
  - plurales corregidos;
  - botones de 44 px;
  - en teléfono la fila se apila (`dt-stack`).
- Tarjeta del surtidor: "(otra unidad, no se compara)" y "Kepler marca existencia negativa".
- **No había cómo llegar a Surtir desde el Tablero** (lo encontró Francisco en prod). `/almacen/surtir`
  es pantalla de foco: su entrada en `almacen-tabs` sólo decide a dónde cae quien abre el área y no
  pinta ningún botón. A quien también ve el Tablero lo llevaba al Tablero, sin salida a Surtir. Ahora
  el Tablero trae el botón **Surtir** para quien tiene `COMMERCIAL_PICKING_GESTIONAR` (3 pruebas, con
  mutación).
- **El surtidor real no podía ni empezar:** la pantalla leía los almacenes de `/commercial/warehouses`,
  que pide `COMMERCIAL_WAREHOUSES_VER`. Medido en prod: `almacenista` es el ÚNICO perfil que surte y
  no tiene esa clave, así que veía "No se pudo leer la lista de almacenes". Ahora la lista sale de
  `GET /reparto/surtido/almacenes` con el permiso de surtir y el alcance de la persona.

**Perfil `surtidor` (`[GP.3c.5]`, mig `20261008035511`).** Para que el surtidor entre directo a "Tomar
siguiente" (como el contador a "Contar camión"), su perfil debe surtir y NO ver el Tablero: el área
aterriza en el primer tab que alcanza. Francisco creó el rol en prod desde `/admin/roles` con sus 4
claves, pero esa pantalla no da alcance y el alcance es fail-closed: con 0 reglas el rol no veía
ninguna sucursal. La migración lo deja reproducible: 4 claves (se suman, no se pisan) + su sucursal y
su zona. Sólo toca datos: se aplica a mano ANTES de mergear. Al cambiar de perfil base, el anterior
queda como complemento ([ID.13], a propósito): a quien venía de `almacenista` hay que quitárselo en
Personas › Acceso › Complementos.

**Deuda declarada (no se toca en esta fase).** `POST /reparto/surtido/waves/:id/assign` y
`/cancel` (pantalla vieja de Reparto) piden sólo `COMMERCIAL_PICKING_GESTIONAR`, que tiene el
surtidor, y no aplican alcance por sucursal: quien conozca el id de una ola puede asignarla o
cancelarla. Para cerrarlo hay que mover esas acciones a la consola o ponerles alcance (`[GP.3c.4]`).

### 8.5 GP.3d — La entrega del surtido a Facturación (🧪 en código, 2026-10-08)

Lo que se surtió en la Suite se cierra en Kepler. **Decisiones de Francisco (2026-10-08):**

| Pregunta | Decisión |
|---|---|
| ¿Quién lo cierra en Kepler? | **Facturación**: corrige en el pedido lo que no se encontró |
| ¿En qué estatus lo deja? | **SURTIDO**: así aparece en la mesa de checado |
| ¿Y si salió completo? | Igual lo avanza a SURTIDO (sólo el cambio de estatus) |
| ¿Cómo sabe la Suite que ya lo hizo? | **Lo detecta sola** leyendo Kepler; no hay botón "ya lo capturé" |
| ¿El checado espera? | **Sí**: el checador sólo recibe pedidos que Kepler ya trae en SURTIDO (GP.4) |

**Medido antes (prod, 30 días, 40,792 renglones embarcados):** Kepler marca "surtido menor a lo
pedido" en sólo **68 renglones (0.17%)** y "surtido en cero" **nunca**. O sea: lo que no se encuentra
se resuelve **corrigiendo el pedido** (se baja la cantidad o se quita el renglón), no capturando un
surtido menor. Por eso la bandeja dice qué dejar en cada renglón, no qué capturar como surtido.

**Pantalla** `/almacen/pedidos-por-capturar` (pestaña **Por capturar en Kepler** del área Pedidos):
- Cuatro tarjetas que filtran: **Corregir y pasar a SURTIDO** · **Sólo pasar a SURTIDO** · **En
  SURTIDO pero no cuadran** · **Capturados hoy**. La lista va de lo que hay que hacer a lo que ya quedó.
- Por pedido: folio de Kepler, destino, cuándo y quién lo surtió, estatus que Kepler trae hoy y
  qué hacer. **"Ver qué tocar"** abre los renglones con lo pedido, lo surtido y **lo que hay que dejar
  en Kepler, en la unidad en que se teclea** (3 BTO); con surtido 0 dice "quitar el renglón". Si lo
  surtido no da una presentación entera, se muestra también en la base para no redondear a ciegas.
- **Detección:** con Kepler en SURTIDO, CHECADO o EMBARCADO compara renglón por renglón en la
  unidad base (`kdm2.c9` sumado por clave contra `wave_allocations.qty_allocated`). Si cuadra,
  sale sola de la lista; si no, queda en "no cuadran" con lo que Kepler trae. Un renglón que Kepler
  trae y la Suite no surtió también cuenta como diferencia.
- Se relee cada 60 s con la pestaña a la vista y dice de cuándo es Kepler (`kdm1`, minutos).

**Permisos, aprendido del surtidor:** es de **sólo lectura**, así que va con `ALMACEN_PEDIDOS_VER`, la
clave del Tablero que Facturación **ya tiene**. No hay permiso nuevo ni migración que frene el
despliegue. El endpoint (`GET /reparto/surtido/por-capturar`) no depende de ninguna otra clave.

**Configuración pendiente (prod, medido 2026-10-08):** de las 3 personas en puestos de Facturación,
`monse_frausto` y `maria_garcia` (puesto *Facturación*, perfil `telemarketing`) **no tienen sucursal**
en su ficha. Su perfil ve "su sucursal" (fail-closed), así que la bandeja les sale vacía con el
aviso "Tu ficha no tiene una sucursal asignada". Hay que asignársela en Personas › Datos.

**Probado:** pruebas de la lógica y de la pantalla (ver §8.5.1); la consulta de la Suite en Postgres local (con prueba
negativa de sucursal); las consultas a Kepler contra prod, sólo lectura: las consultas exactas del código,
**42 ms** (cabeceras) y **404 ms** (renglones) con los 2,510 pedidos de 30 días.

#### 8.5.1 Correcciones de la revisión independiente (antes del PR)

| Defecto | Corrección |
|---|---|
| ⚠️ En AUTORIZADO no se leía Kepler: si el cliente agregaba o subía algo en Kepler durante el surtido, la bandeja decía "sólo pásalo a SURTIDO" (falso) | Kepler se lee **siempre**. En AUTORIZADO se lista todo renglón donde Kepler ≠ lo surtido, incluidos los que la Suite no surtió ("quitar el renglón"); "sólo pasar a SURTIDO" únicamente si Kepler ya trae exactamente lo surtido |
| ⚠️ Productos por peso (KG/BTO) podían quedar para siempre en "no cuadran": Kepler recalcula la base con su factor | Se compara en la **presentación** de Kepler cuando lo surtido da una cantidad entera y Kepler trae esa sola presentación; si no, en la base con **0.5% de holgura** |
| Los renglones que se agregan EN el checado o el embarque (`kdm2.c28`) hacían reaparecer un pedido ya capturado como "no cuadra" | Se excluyen de la comparación: son trabajo de esas etapas |
| "Capturados hoy" prometía la hora de la captura, que Kepler no guarda | "Surtidos hoy, ya en Kepler" |
| Lo de más de la ventana desaparecía sin rastro | Ventana de **30 días**, declarada en el pie de la lista |
| Una columna mezclaba unidades (BTO contra KG) y la cifra en negritas podía ser "2.4 BTO" | Todo el renglón va en una sola unidad: la presentación si da entera, si no la base |
| Una clave en varios renglones de Kepler se veía como una (medido: **656** claves en 30 días) | "Viene en N renglones: el total debe quedar así" |
| La lectura de Kepler no usaba el índice | Escrita contra `ix_kdm1_venta_doc` / `ix_kdm2_venta_doc`: los 2,510 pedidos de 30 días (peor caso) en **42 ms** y **404 ms** |
| Un refresco fallido no se notaba | "No se pudo actualizar desde las HH:MM" |
| La frescura de Kepler se leía como de la sucursal | "Kepler (todas las sucursales) leído hace N min": es global, se dice así |

Pantalla: tarjeta "En otro estatus en Kepler" cuando hay; texto vacío por filtro; "Ver detalle" en lo
ya capturado; no se relee con un detalle abierto (no reordena bajo el dedo); el foco vuelve al título
si el pedido abierto sale de la lista; botón de actualizar de 44 px; nombre de sucursal. Pruebas: 21
de la lógica (mutación: "sólo avanzar" sin mirar Kepler la rompen 2) y 13 de la pantalla.

### 8.4 Pendiente de GP.3

- **GP.3c.3, partir un pedido grande** por rango de pasillos: necesita ubicaciones (`FASE_WMS` §12.5,
  Fase UB).
- **El orden de la hoja por ubicación** espera el censo de ubicaciones de PH (WMS.3). Hoy: por nombre.

## 9. GP.4 — El checado: rastrillar, armar las cajas y etiquetar (🧪 en código, 2026-10-08)

Junta lo que el plan tenía en GP.4 (checado) y GP.4b (bultos), porque así lo trabaja el piso.

### 9.1 Decisiones de Francisco (2026-10-08)

| Pregunta | Decisión |
|---|---|
| ¿Cómo recibe trabajo? | **"Tomar siguiente"**, igual que el surtidor: un pedido ya surtido, **nunca uno en el que él surtió algún renglón** (P4) |
| ¿Cómo revisa? | **Rastrilla: escanea todo.** Las cajas de unidad mayor validan el surtido; la paquetería se escanea **dentro de la caja P abierta**. El valor es la trazabilidad: *saber exactamente en qué caja se empacó todo lo que no va en unidad mayor* |
| ¿Ve lo que contó el surtidor? | No: ve lo que pidió el cliente y lo que lleva escaneado (conteo ciego en la práctica) |
| Si no cuadra | **Manda el checador.** Si falta, sale incompleto (P7); la diferencia queda registrada contra el surtidor |
| Etiquetas | **Etiquetera térmica TSC TE200**, rollo de **3 por fila**: 100 mm de ancho, cada etiqueta **32 × 48 mm**, 2 mm entre etiquetas y entre filas. La de cada caja **P sale al cerrarla y por triplicado** (la fila entera: dos lados de la caja + la hoja del pedido); las de unidad mayor (**1/7, 2/7…**) al terminar, en filas de 3 |
| ¿Cuándo se puede checar? | Sólo cuando **Facturación ya lo pasó a SURTIDO en Kepler** y cuadra con lo surtido (GP.3d): se checa contra el pedido ya corregido |
| Puesto | **Nuevo, "Checador de Pedidos"** (`checador_pedidos`). El puesto "Checador" ya lo usa la terminal del verificador de precios (`checador.05`, perfil `verificador_precios`): darle el perfil de almacén a ese puesto le habría dado permisos de almacén a una terminal pública |

### 9.2 Lo aprendido con el surtidor, resuelto desde el principio

| Lo que pasó en GP.3 | Cómo nace el checado |
|---|---|
| La pantalla pedía la lista de almacenes con un permiso de otro módulo que `almacenista` no tenía | **Todo** endpoint que usa la pantalla pide la clave del checado; nada prestado |
| El rol `surtidor` se creó a mano y sin alcance (fail-closed: no veía ninguna sucursal) | El rol `checador` nace **por migración**, con claves **y** alcance a su sucursal |
| El puesto proponía otro perfil | `checador_pedidos` (y `checador_cedis`) nacen proponiendo `checador` |
| La migración de sólo datos frena la compuerta del despliegue | Rol y puesto van **en la misma migración que crea las tablas**: la compuerta la clasifica como esquema |
| No había botón para llegar a la pantalla de foco | Entrada directa para quien sólo checa + botón **Checar** en el Tablero para quien ve los dos |
| El perfil base anterior queda como complemento (`[ID.13]`, a propósito) | Va en los pasos de configuración: quitarlo en Personas › Acceso |

### 9.3 Cómo funciona

1. **Tomar siguiente** (`/almacen/checar`): el pedido más urgente cuyo surtido ya terminó (mismo orden
   que la fila del surtidor: urgente → salida más próxima → lo más viejo), sin checador, y en el que
   quien pide **no surtió ningún renglón**. Candado por persona + `FOR UPDATE SKIP LOCKED`.
2. **Rastrillar.** Cada escaneo se resuelve contra `kepler_ods.kdii` **de la sucursal** a producto +
   unidad + factor (las tres unidades de Kepler y el `C`+clave de las cajas, `ERP_KEPLER` §3.y.4):
   - **Unidad mayor** del renglón → cuenta una caja (`CJ`). Caja sin etiqueta: escanear la pieza y
     teclear cuántas cajas.
   - **Unidad menor** → entra a la **caja P abierta** (si no hay, se abre P1 sola).
   - Producto que no va en el pedido → alerta "no va en este pedido", no se suma.
   - Más de lo pedido → alerta en el renglón.
   - Producto por kilo → pide el peso de la báscula.
   - Deshacer el último escaneo.
3. **Cerrar la caja P** → se imprime su etiqueta (`P1 · pedido · cliente` + contenido) y se abre la
   siguiente cuando se escanee más paquetería. El total "de N" queda en el manifiesto del pedido.
4. **Terminar** → lista **sólo lo que no cuadra** (faltantes, sobrantes); lo checado es lo que sale.
   Se imprimen las etiquetas de unidad mayor `1/7…7/7`. Espacio de espera: opcional hasta que
   existan en Ubicaciones (hoy el catálogo tiene **0** carretas y **0** espacios de espera).

### 9.4 Datos (tablas propias, ADR-086: no se escribe en Kepler)

- `commercial.order_checks`: el checado de un pedido (almacén, ola, pedido, quién, estado, espera).
- `commercial.order_check_lines`: por producto, lo pedido, lo que el surtidor repartió
  (`wave_allocations.qty_allocated`), lo checado, quién surtió y la diferencia.
- `commercial.check_packages`: las cajas P (número, estado, etiqueta impresa).
- `commercial.check_scans`: cada escaneo (código, unidad, factor, cantidad base, peso, caja P).

### 9.5 Pantallas y permisos

- `/almacen/checar` (foco, celular/handheld), clave **`ALMACEN_CHECADO_GESTIONAR`**. Rol `checador`:
  esa clave + `ALMACEN_UBICACIONES_VER` + `SERVICIO_REPORTAR`, alcance su sucursal. También a
  `almacenista` (la misma persona puede surtir un día y checar otro: P4 lo cuida el sistema por
  pedido, no el perfil).
- Etiquetas por navegador (`printIsolated` + JsBarcode, igual que el cartel del andén), con
  `@page` del tamaño de la etiqueta. **Pendiente: medida de la etiqueta** (se deja configurable).

### 9.6 Lo que quedó construido

- **Migración `20261008143820_gp4_checado`** (crea esquema: la compuerta no frena): las 4 tablas con RLS
  forzado; candado de **un checado vivo por pedido** (índice único parcial) y de **una sola caja P
  abierta** por checado; un escaneo de paquetería **no puede quedar sin caja P** (CHECK). Rol
  `checador` (3 claves + alcance a su sucursal y zona), `ALMACEN_CHECADO_GESTIONAR` también a
  `almacenista`, puesto **Checador de Pedidos** que propone `checador`, y `checador_cedis` pasa a
  proponerlo (0 personas).
- **Servidor** `/reparto/checado` (`checado.service.ts`), todo con `ALMACEN_CHECADO_GESTIONAR`:
  - `siguiente`: candado por persona; candidatos en el orden de la fila del surtidor; **excluye
    los pedidos que quien pide surtió** (el picker de la ola o de cualquier renglón del pedido, P4);
    pide a `PickingCapturaService.estadosDe` que Kepler esté en **SURTIDO y cuadre**; el
    `INSERT … ON CONFLICT` contra el índice parcial resuelve a dos checadores a la vez. Sin trabajo,
    dice **cuántos pedidos esperan a Facturación**.
  - `escanear`: resuelve el código contra `kdii` **de la sucursal** (`checado-codigo.ts`, sólo
    coincidencia exacta: en `06001` la pieza es `006001` y el paquete `06001`). Caja (factor de
    la unidad mayor) = una caja; lo demás entra a la caja P abierta (se abre sola). Ajeno, ambiguo
    o desconocido se avisan y no suman; por kilo suelto pide el peso; sobrante se avisa.
  - `deshacer` (no si su caja P ya se cerró y etiquetó), `cerrar-caja` (devuelve la etiqueta),
    `terminar` (cierra la caja P abierta si lleva algo, lista sólo lo que no cuadra, etiquetas 1/N).
- **Pantalla** `/almacen/checar` (foco, celular y handheld): el campo de código conserva el foco
  para el escáner; cantidad para cajas sin etiqueta; aviso por color; último escaneo con
  "Deshacer"; caja P abierta con "Cerrar caja P… e imprimir etiqueta"; lista con lo pendiente
  primero; confirmación al terminar que dice si sale incompleto; espacio de espera opcional.
  Entrada directa para quien sólo checa y botón **Checar** en el Tablero.
- **Etiquetas** (`checado-etiquetas.ts`): `printIsolated` con papel `100mm × 48mm` (una fila de 3
  por hoja); código de barras CODE128 corto (`0002781P3`, `0002781C5`) para que quepa en 29 mm.

#### 9.6.1 Correcciones de las revisiones independientes (código y usabilidad, antes del PR)

| Defecto | Corrección |
|---|---|
| ⚠️ Abrir caja P, deshacer y terminar daba error 500 y el pedido quedaba **atorado para siempre** (no había forma de soltarlo) | Terminar descarta la caja P vacía (antes borra sus escaneos deshechos); **"Soltar este pedido"** lo regresa a la fila |
| ⚠️ "Tomar siguiente" podía decir "no hay pedidos" habiendo listos: los que Kepler ya checó por fuera ocupaban el lote | El estatus de Kepler se lee EN la consulta y se filtra antes de recortar; los checados por fuera **se cuentan y se dicen** |
| P4 con olas soltadas y retomadas | Se excluye también a quien terminó la ola y a quien se la quitaron (`liberada_de`) |
| "Cajas sin etiqueta" contaba piezas | Casilla **"Son cajas cerradas"**: la pieza + cantidad cuenta N cajas (`factor_mayor`) |
| "Unidad mayor" = factor más grande: un paquete sin caja salía con etiqueta n/N y un producto que se vende por caja entraba a la caja P | Se decide por el **nombre**: CJA, BTO, CUB (medido: los únicos de Kepler; `FASE_GP` §2.5) |
| Lo que sobraba se registraba | **No se registra**: "esto sobra, regrésalo a su lugar (no se contó)" |
| Sin índices para `line_id`/`package_id` (cada escaneo) | Índices parciales en la migración |
| El puesto nuevo podía tumbar la migración en un tenant sin "almacen"/"embarques" | `AND EXISTS` de los dos (prod: 1 tenant, ambos existen) |
| El checador y el surtidor entraban al Mapa de Ubicaciones | Candidatos explícitos en la entrada de Almacén (medido: sólo cambia `surtidor`, 2 personas) |
| El segundo escaneo rápido se perdía (campo bloqueado) | **Cola de escaneos**: el campo nunca se bloquea; prueba negativa + mutación |
| Etiquetas: código de 29 mm sin margen, fila de 48 mm (hoja en blanco), "100/120" cortado | Código de 12 dígitos (CODE128-C, 25 mm, ~2 mm de margen), fila de 47.6 mm, tamaño según caracteres |

Pantalla: cantidades grandes, "Pedido / Llevas / Faltan" en una sola unidad (o "1 CJA + 5 PZA"),
diferencias a la vista ANTES de terminar, etiquetas de cajas que salen solas al terminar y
reimpresión (por caja P y del último pedido, aunque se recargue), aviso de sin conexión, foco del
escáner en todos los caminos, peso con el nombre del producto, `inputmode="none"` con botón
"Teclado". Además, Postgres real encontró dos errores que ninguna prueba pura veía: `org_labels` es
`text[]` (no JSON) y el `down` debía soltar los puestos antes de borrar el perfil.

**Probado:**
- **De punta a punta en Postgres real, con el código REAL del servicio** (transpilado) y rollback:
  **31/31** — P4, un checador un pedido, caja por `C`+clave, paquete a la caja P, ajeno,
  desconocido, lo que sobra no se registra, "son cajas", cerrar caja P y su etiqueta, no se deshace
  lo ya etiquetado, terminar con etiquetas 1/N, reimpresión, terminado no acepta escaneos, el caso
  del pedido atorado, soltar, Kepler CHECADO por fuera y AUTORIZADO; y la bandeja de Facturación
  sigue clasificando igual tras el refactor.
- Migración en Postgres real: **11/11** (dos veces, RLS, rol, alcance, puesto, 3 candados, `down`).
- Lector de códigos con filas reales (13), reglas (13), pantalla montada (14, mutación de la cola),
  entrada directa (3 + 3). Lecturas de `kdii` contra prod: ~40 ms por código.
- **Pendiente:** la impresión en la TSC real (imprimir una fila de prueba y leer el código con el
  handheld). Liberar un checado desde la consola del coordinador (hoy sólo lo suelta el checador).

#### 9.6.2 Prueba visual con datos de prueba (2026-10-10) y lo que se corrigió

Recorrido en el navegador, contra una base Docker con datos sembrados (sucursal 07, 4 usuarios,
3 pedidos): consola → surtidor → Facturación → checador. La cadena funcionó de punta a punta y se
encontraron 8 detalles, todos corregidos:

| Lo que se vio | Corrección |
|---|---|
| La paleta pedida en **BOL** se mostraba "40 PZA" | ⭐ **Se respeta la unidad PEDIDA** (decisión de Francisco): "Pedido 2 BOL · Llevas 1 BOL · Faltan 1 BOL"; lo que no completa una bolsa sale en la base ("2 BOL + 5 PZA"). `order_check_lines` guarda `unidad_pedida`/`factor_pedida` (la presentación congelada al arrancar el surtido); los textos los arma **el servidor** (`cantidadEnUnidad`, `textosRenglon`) para que la lista, el aviso de lo que sobra y las diferencias al terminar digan lo mismo. Si se pidió en caja cerrada distingue cajas de sueltas ("1 CJA + 600 PZA"), porque de eso salen las etiquetas 1/N |
| Se ofrecía **"Deshacer"** para un escaneo que ya iba en una caja P cerrada (el servidor lo rechazaba) | `ultimo_escaneo.deshacible`; sin botón y con "Ya va en una caja P cerrada". Prueba negativa con mutación |
| Lo que sobra decía "Ya van completas: **1200 PZA**" con el renglón en "2 CJA" | El mensaje usa la unidad pedida |
| Al pesar 2.5 kg el "Último" decía **"1 KG"** | Si se pesó, el último escaneo trae los kilos |
| Un producto **ajeno** aparecía como "Último" (con la clave en vez del nombre) y con "Deshacer" | "Último" es el último que **cuenta**; lo ajeno ya se avisó en rojo con su nombre |
| El peso arrancaba con un **0** escrito: teclear 2.5 dejaba "02.5" | Campo vacío con ejemplo; "Agregar" apagado hasta que haya peso |
| La confirmación de **Terminar** aparecía hasta abajo, medio tapada (el foco regresaba al escáner, arriba); botón chico; el aviso rojo viejo seguía visible | Se lleva la vista a la confirmación y el foco a "Sí, terminar"; botones grandes; se borra el aviso viejo (igual en "Soltar") |
| Los botones **− / +** se veían como un punto | `--tap-min` vale **0 con mouse** (44 px sólo en táctil) y el botón lo usaba de ancho y alto: medida mínima propia |
| La consola decía **"0 de 0" renglones** en un surtido sin arrancar | Antes de arrancar se cuentan del pedido en Kepler (productos distintos, como los cuenta la ola) |

Columnas nuevas en la MISMA migración (`20261008143820`, sin aplicar en prod): van en el `CREATE` y
con `ADD COLUMN IF NOT EXISTS` para las bases donde la tabla ya existía.

Vistos y **no corregidos aquí** (no son de GP.4): la migaja dice "Pedidos" en Surtir y Checar y los
íconos de la barra de abajo salen como círculos (navegación general); `printIsolated` pide
`styles.css` con ruta relativa que dentro del iframe resuelve a `/almacen/styles.css` (ruido en
consola en TODAS las impresiones; la etiqueta sale bien porque los estilos van dentro); y un login
frenado por demasiados intentos (429) se muestra como "sesión expirada".

### 9.7 Fuera de esta entrega

Contenedor de plástico compartido (§5c), mover cajas entre ubicaciones, la carga al camión (GP.5) y
el cuadre con Kepler (GP.6).
