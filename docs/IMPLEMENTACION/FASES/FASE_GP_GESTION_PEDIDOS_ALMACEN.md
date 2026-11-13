# Fase GP — Gestión de pedidos en almacén (plan reestructurado 2026-11-13)

> **Plan vigente.** Reestructurado con Edgar (PM) el 2026-11-13, proceso por proceso, siguiendo la
> vida del pedido en el almacén. Reemplaza al plan de octubre, que se escribió como diario y dejó
> de describir lo que pasa en el piso. **Nada se perdió:** el texto anterior íntegro (decode del
> `U-D-40`, mediciones de octubre, decisiones de Francisco, detalle de GP.1–GP.9) vive en
> [`FASE_GP_HISTORIA_HASTA_2026-11-12.md`](FASE_GP_HISTORIA_HASTA_2026-11-12.md). Toda cita
> «FASE_GP §N» anterior a hoy apunta a ese anexo. Si algo de allá contradice este plan, **gana éste**.

```
OBJETIVO: que el pedido de Kepler (telemarketing y sucursal) se surta, cheque y embarque en la Suite,
          con carreta, bulto, posición y estiba identificados, y que la Suite escriba cada estatus en Kepler.
MÉTRICA:  pedidos U-D-40 surtidos en la Suite / pedidos U-D-40 del periodo
          HOY: 0.5 % (17 de 3,284 en 30 días, medido 2026-11-13, prod sólo lectura)
          META: propuesta 90 % en Padre Hidalgo (piloto, D28) durante dos semanas; la fecha
          se fija al cerrar E4 (P-GP.8). Metas por etapa en FASE_GP_PLAN_IMPLEMENTACION.md
CAPA TOPE: C3
ÁREA:      Logística (almacén)
DUEÑO:     Edgar (PM). Dueño de piso por sucursal: por confirmar (P-GP.1)
ESTADO:    🔨 desde el 2026-11-13: E1 abierta POR ENCIMA DEL CUPO (7ª fase 🔨), aprobado por Edgar ese día.
           GP.10.0 y GP.10.1 en 🧪 · ADR-117 firmado · lo construido antes (GP.1–GP.9) sigue 🧪.
```

---

## 0. Por qué se reestructura (medido 2026-11-13, prod, sólo lectura)

| Hecho | Medición |
|---|---|
| Pedidos de Kepler surtidos en la Suite | **0.5 %** del universo `U-D-40` de 30 días. El surtidor no escribe desde el 02-nov |
| Checado en la Suite | **0 registros en toda la historia** (las cuatro tablas del checado) |
| Pedidos surtidos en la Suite que siguen `AUTORIZADO` en Kepler | 16: nadie los pasó a SURTIDO, así que el checado nunca abre (su candado espera SURTIDO en Kepler) |
| Preventa del vendedor | ~90 % se surte en la Suite y la revisión en caja sí se usa; guía, entrega y liquidación paradas desde el 17-oct |
| Sucursales sin ningún uso del módulo | CEDIS, Canindo y Yurécuaro (ni el tablero) |
| Pantallas del grupo «Pedidos» | 7 pestañas + 5 entradas de foco, agregadas por dos fases (GP y MCP); dos pantallas surten la misma preventa y ya divergieron |
| Ubicaciones cargadas (Fase UB) | Padre Hidalgo 0 · CEDIS 375 (todas del 08-oct) · resto 0. Producto→ubicación: no existe |
| Lotes acomodados en un rack | 1 en toda la historia (el Andén sí fecha ~1,200 lotes al mes) |

**Diagnóstico:** el plan de octubre describía un proceso (surtido, checado y embarque de pedidos
Kepler en la Suite) que no ocurre, y lo que sí ocurre (preventa y revisión en caja) casi no estaba
en él. Además dependía de que una persona capturara en Kepler lo hecho en la Suite, y esa captura
nunca sucedió — la misma lección que Francisco dio en octubre: *«si el operador apunta y la
capturista no registra, pronto los dos dejan de hacer su trabajo»*.

---

## 1. Tesis vigente

1. **El pedido sigue naciendo en Kepler** (o en la Suite y escrito a Kepler, para telemarketing:
   ADR-113).
2. **El trabajo de piso se hace en la Suite:** surtir, checar, armar bultos, posicionar y cargar.
   Quien hace el trabajo es quien lo registra, en el momento, con su nombre.
3. ⭐ **La Suite escribe en Kepler cada cambio de estatus** — Surtido, Checado y Embarcado — en
   automático al terminar cada paso (D13, D17). Nadie recaptura. **Esto enmienda ADR-086**
   («la Suite no escribe en Kepler») para este flujo y requiere su ADR antes de construir.
4. **Todo lo físico tiene identificador escaneable:** ubicación, carreta o carrito, bulto, posición
   de embarque y estiba del camión. El pedido viaja con su carreta y se encuentra escaneándola.

---

## 2. El recorrido completo

```
 1 Bodega organizada ──▶ 2 Cada producto en su lugar fijo                    (Fase UB)
                               │
 3 CONSOLA MAESTRA: todos los pedidos (Kepler + preventa), su estado y la priorización
                               │
 4 SURTIR: escanea carreta/carrito ──▶ 4b la Suite escribe SURTIDO en Kepler
                                          (pedido vs surtido por renglón + motivo)
                               │
 5 CHECAR: cola de Surtido, escanea la carreta, todo renglón por renglón, arma bultos
                               │ ──▶ la Suite escribe CHECADO
 6 POSICIÓN DE EMBARQUE: lo checado a una posición con identificador
                               │
 7 TRANSPORTE asignado ──▶ CARGA: cada bulto a su estiba del camión ──▶ se libera la carreta
                               │ ──▶ la Suite escribe EMBARCADO · se factura (se captura el chofer)
 8 SALIDA POR EMBARQUE + guía  ──▶  9 SALDAR EMBARQUE
```

### 2.1 Correspondencia con Kepler (menú *Almacenes › Control de Pedidos*)

| Kepler | Paso | Quién lo registra |
|---|---|---|
| Estatus Surtido | 4 · 4b | El surtidor en la Suite; la Suite escribe a Kepler |
| Estatus Checado | 5 | El checador en la Suite; la Suite escribe a Kepler |
| Estatus Embarque | 6 · 7 | Quien carga, en la Suite; la Suite escribe a Kepler |
| Asignación de Transporte | 7 | Por definir (antes de cargar, D19) |
| Salida por Embarque · Guía de Embarque | 8 | **No se sabe aún quién** (P-GP.4) |
| Saldar Embarque | 9 | ⏸️ Diferido (P-GP.5) |

---

## 3. Paso por paso

### Paso 1 — Organizar la bodega (`/almacen/ubicaciones`, pestaña Mapa) · Fase UB

- **Hoy:** Kepler no sabe ubicaciones (todo `Z000`). Wincaja tenía ubicación para ~1/3 de los
  productos de Padre Hidalgo, congelada desde jul-2026. La Suite ya tiene el mapa (código `BA053`:
  zona B/T · pasillo · rack · nivel, captura masiva, carteles) pero casi sin datos (§0).
- **Proceso:** dar de alta pasillos, racks y niveles de la bodega; imprimir y pegar los carteles.
  Mismo catálogo para carretas (`C`), posiciones de espera/embarque (`E`) y estibas (FASE_UB D8).
- **El cuello es el censo** (trabajo de piso), no el software.
- **Construcción:** [`FASE_UB_UBICACIONES.md`](FASE_UB_UBICACIONES.md) (UB.0–UB.2 🧪; UB.8 piloto).
- **Pendientes:** qué bodega primero; si `BA053` describe la bodega física; quién censa y con qué
  croquis (UB.P4).

### Paso 2 — Asignar cada producto a su lugar (`/almacen/inventory/ubicaciones`, pestaña Contenido) · Fase UB

- **Hoy:** la pantalla muestra el **contenido por lote** de cada rack (Andén → «Por acomodar» →
  rack). El acomodo no se usa (1 lote). El **lugar fijo** de cada producto no existe (UB.3 ⬜).
- **Dos conceptos distintos:** *lugar fijo* (dónde se surte, por presentación, sin cantidad, cambia
  casi nunca) ≠ *contenido* (lote, cantidad y caducidad; sólo en la reserva). Para surtir ordenado
  basta el lugar fijo.
- **Proceso:** escanear el rack → producto + presentación (caja, paquete, pieza) → tipo (surtido ·
  exhibición en tienda · reserva) → mín/máx opcional. Wincaja sirve de propuesta que se confirma en
  el piso, nunca de dato.
- **Métrica:** productos con venta que tienen lugar de surtido / productos con venta.
- **Pendientes:** confirmar que vive en la misma pantalla Contenido (recomendado: una sola
  interfaz por flujo); quién asigna.

### Paso 3 — Consola maestra (`/almacen/pedidos`) · GP.10

- **Hoy:** el Tablero lee Kepler y es la pantalla más consultada (refleja la realidad aunque nadie
  use la Suite). Le falta el estado de piso, preventa vive en otra pestaña, no distingue lo atorado,
  y tiene defectos visuales (el volumen se encima sobre el chip de estatus; unidades sin explicar
  como «6 500 · 3 400»; la columna Guía siempre vacía).
- **Proceso:** una fila por pedido, de cualquier origen, con su recorrido:
  `Creado → Autorizado (Kepler) → En cola → Surtiendo → Surtido → Checando → Checado (Suite) →
  En posición → Cargado/Embarcado`. Cada etapa dice de dónde viene el dato (Kepler o piso) y quién
  lo tiene, con qué carreta y desde cuándo. Si el piso va adelante de Kepler, se marca.
- **Decisiones:** D1 preventa entra aquí · D2 la «Consola de surtido» se fusiona aquí (priorizar,
  hora de salida, armar; acciones sólo con permiso de coordinar) · D3 regla de «atorado» diferida ·
  D4 el importe del traspaso a sucursal sí se muestra · D5 «Análisis BI» fuera de este plan.

### Paso 4 — Surtir con carreta o carrito (`/almacen/surtir`) · GP.11

- **Hoy:** Surtir no pide carreta en ningún modo; hay 0 carretas dadas de alta; el campo de carreta
  de Kepler (`kdm2.c59`) no se usa de verdad (Padre Hidalgo 0 %, Canindo lo rellena con `1`).
- **Proceso:**
  1. Catálogo por almacén con dos tipos (D6): **carreta** (madera con ruedas, para cajas) y
     **carrito** (tipo súper, para piezas y paquetes). Cada uno con número y QR/CODE128.
  2. El surtidor toma su pedido y **escanea la carreta antes del primer renglón** — paso obligatorio
     de la pantalla, no una columna; teclado numérico de respaldo en celular.
  3. Los renglones heredan la carreta; excepción «agregar otra carreta» si no cabe.
  4. **Un pedido por carreta** (D7). Una carreta ocupada no se toma: la pantalla dice de qué pedido
     es y quién lo surte.
  5. Al terminar, la carreta queda esperando el checado con su pedido.
- **Decisiones:** D6, D7, D9 (aplica también a preventa, pero el proceso de preventa no se toca en
  esta etapa), D22 (la carreta se libera al **cargar el camión**).
- **Pendiente:** análisis de si conviene más de un pedido por carreta (tandas), y si 40–50 carretas
  por almacén alcanzan con la carreta ocupada hasta la carga (P-GP.6).

### Paso 4b — La Suite escribe SURTIDO en Kepler · GP.12

- **Hoy:** con papel alguien lo captura en Kepler (no se sabe quién); lo surtido en la Suite no lo
  pasa nadie. La pantalla «Por capturar en Kepler» (`/almacen/pedidos-por-capturar`) sólo lista.
- **Proceso:** al **finalizar el surtido** (ya se conoce el total), la Suite escribe en Kepler el
  cambio a SURTIDO y, por renglón, **lo pedido contra lo surtido con el motivo de la diferencia**
  (falta de existencia, etc.) (D13, D14). Luego el pedido queda en la cola abierta del checado (D15).
- **«Por capturar en Kepler»** deja de ser la lista de Facturación: propuesta, se convierte en la
  **bandeja de lo que la Suite no pudo escribir** (o se retira). La sustituye también al viejo
  GP.6 (cuadre Suite↔Kepler).
- ⛔ **Antes de construir:** ADR que enmienda ADR-086 · carril de escritura existente (el de
  ADR-113 / PGP O3; Kepler vivo sólo acepta escrituras desde `md`) · prueba contra base real con el
  payload de la pantalla (regla 13).

### Paso 5 — Checado (`/almacen/checar`) · GP.13

- **Hoy:** en el piso con el ticket impreso «Referencia CHECADO». La pantalla de la Suite existe
  (rastrillar, cajas P, etiquetas TSC, quien surtió no checa) y nunca se ha usado.
- **Proceso:**
  1. El checador, al terminar uno, ve la **cola de pedidos en Surtido** y toma el siguiente (D10).
  2. **Escanea la carreta** y se le abre el pedido.
  3. Revisa **todo, renglón por renglón**, sin muestreo (D11); las diferencias se marcan ahí.
  4. **Arma los bultos** en el checado (D12): cajas cerradas `CJ` y de paquetería `P1`, `P2`…,
     cada una con etiqueta.
  5. La Suite escribe CHECADO en Kepler (D17).
- **Cambio sobre lo construido:** el candado deja de esperar a que *alguien* pase el pedido en
  Kepler; lo pasa la Suite al terminar el surtido (paso 4b).

### Paso 6 — Posición de embarque · GP.14

- **Hoy:** no existe. Kepler guarda una «ubicación de checado» (`c60`) que nadie llena de verdad.
- **Proceso:** lo checado se deja en una **posición de embarque con identificador propio** (familia
  `E` del catálogo de ubicaciones); la posición dice qué pedido o pedidos contiene (D16). La consola
  maestra muestra el pedido «En posición».

### Paso 7 — Transporte y carga con estiba · GP.15

- **Hoy:** todo en Kepler (Asignación de Transporte, `U-D-41`). La estiba (`kdm2.c61`): Padre
  Hidalgo ~1/3, Canindo relleno, resto 0. Medido en FASE_EMB (2026-11-09): el transporte capturado
  en Kepler **no prueba qué camión salió** (~1 de cada 3 días el camión no se movió según GPS).
- **Proceso:**
  1. El transporte se **asigna antes de cargar** (D19).
  2. **Catálogo de unidades con cuántas estibas le entran a cada una — lo generamos nosotros**
     (D24). La estiba se elige sobre el esquema de ese camión (D18).
  3. Quien carga escanea cada bulto y su estiba; la Suite avisa los bultos que faltan.
  4. Al subir el último bulto: la Suite escribe EMBARCADO (D17) y **se libera la carreta** (D22).
  5. **Se factura al embarcar** (D23, a confirmar con almacén); el **chofer se captura al facturar**
     (D21).
- ⭐ El escaneo de estiba es la primera evidencia real de qué camión llevó qué pedido.

### Paso 8 — Salida por embarque y guía · por documentar

- Kepler arma la guía (`c86`) al dar la salida. La **guía de reparto del chofer es de Logística**
  (`[EMB.56]`, [`FASE_EMB_PAGO_POR_VIAJE.md`](FASE_EMB_PAGO_POR_VIAJE.md) §8): toma de aquí bultos,
  posición y estiba.
- **Pendiente:** quién da la salida (D20 / P-GP.4).

### Paso 9 — Saldar embarque · ⏸️ diferido

- **Diferido por Edgar (2026-11-13):** queda fuera de esta etapa. Qué hace y quién lo hace se
  documenta cuando se retome (P-GP.5).

### Caso: pedido cancelado a medio camino · GP.16

- **Decisión:** se hace la **devolución** (D25). Absorbe el pendiente GP.4.3 del anexo (§9.6.5):
  regresar la mercancía a su lugar, retirar las etiquetas de los bultos y liberar la carreta, con
  firma de quien lo regresó. Mientras no exista, la consola maestra muestra el grupo «Por regresar».

---

## 4. Las pantallas: antes y después

| Hoy (grupo «Pedidos») | Después |
|---|---|
| Tablero | **Consola maestra** (absorbe Preventa y Consola de surtido) |
| Preventa | Dentro de la consola maestra, como origen (D1) |
| Consola de surtido | Dentro de la consola maestra, acciones con permiso de coordinar (D2) |
| Por capturar en Kepler | Bandeja de lo que la Suite no pudo escribir, o se retira (paso 4b) |
| Guías de carga · Revisión de pedidos | Preventa: **no se tocan en esta etapa** (D9) |
| Análisis BI | Fuera de este plan (D5) |
| Foco: Surtir · Checar | Se quedan; Surtir pide carreta, Checar escanea la carreta |
| Foco: Preventa por surtir · Clientes nuevos | Preventa: no se tocan en esta etapa. ⚠️ Deuda con nombre: `/almacen/surtir-preventa` duplica el modo Sucursal de `/almacen/surtir` y ya divergieron (sustitutos sólo en uno, «otra unidad» sólo en el otro) |

---

## 5. Decisiones (Edgar, 2026-11-13)

| # | Decisión | Paso | ADR |
|---|---|---|---|
| D1 | Preventa entra a la consola maestra (deja de tener pestaña propia) | 3 | — |
| D2 | La «Consola de surtido» se fusiona en la consola maestra | 3 | — |
| D3 | La regla de «atorado» por etapa se difiere | 3 | — |
| D4 | El importe del traspaso a sucursal sí se muestra, **separado de la venta** en el total. *Interpretación decidida por encargo del PM (2026-11-13): el traspaso no se factura (CEDIS: 615 embarques, 0 facturas), así que sumarlo como venta la inflaría* | 3 | — |
| D5 | «Análisis BI» queda fuera de este plan | 3 | — |
| D6 | Dos tipos en un catálogo: carreta (cajas) y carrito (piezas y paquetes) | 4 | — |
| D7 | Un pedido por carreta; se analiza después si conviene más de uno | 4 | — |
| D8 | La carreta se libera al pasar a Embarcado → precisada por D22 | 4 | — |
| D9 | Carreta aplica también a preventa, pero el proceso de preventa no se toca en esta etapa | 4 | — |
| D10 | El checado toma de la cola de pedidos en Surtido e identifica el pedido escaneando la carreta | 5 | — |
| D11 | Se checa todo, renglón por renglón (sin muestreo) | 5 | — |
| D12 | Los bultos se arman en el checado | 5 | — |
| D13 | La Suite escribe SURTIDO en Kepler en automático al finalizar el surtido | 4b | **ADR-117** (propuesto; enmienda ADR-086) |
| D14 | Se escribe lo pedido vs lo surtido por renglón, con el motivo de la diferencia | 4b | idem |
| D15 | Tras escribir, el pedido queda en la cola abierta para cualquier checador, salvo quien lo surtió. *Interpretación decidida por encargo del PM (2026-11-13); es reversible: si el piloto pide asignar checador, se agrega sin cambiar el resto* | 4b | — |
| D16 | Lo checado va a una posición de embarque con identificador; la posición dice qué pedido(s) tiene | 6 | — |
| D17 | Todo cambio de estatus en Kepler (Surtido, Checado, Embarcado) lo escribe la Suite | 4b–7 | **ADR-117** (propuesto; enmienda ADR-086) |
| D18 | Al cargar, cada bulto recibe su posición de estiba en el camión | 7 | — |
| D19 | El transporte se asigna antes de cargar | 7 | — |
| D20 | Quién da la Salida por Embarque: no se sabe aún | 8 | — |
| D21 | El chofer se captura al facturar, no en la salida. *Medido (2026-11-13): se cumple en Telemarketing de Padre Hidalgo y Morelia Abastos (chofer en el 0–5 % de los embarcados), no en Canindo (92 %)* | 7 | — |
| D22 | La carreta se libera cuando se carga el camión | 4 · 7 | — |
| D23 | Se factura al embarcar. *Medido (2026-11-13): 1,308 de 1,318 embarques con factura se facturaron con la misma fecha* | 7 | — |
| D24 | El catálogo de unidades con su número de estibas lo genera la Suite | 7 | — |
| D25 | Un pedido cancelado a medio camino se resuelve con devolución | 9 | — |
| D26 | La Suite escribe el **estatus** EMBARCADO; la *Salida por Embarque* (`U-D-41`, saca inventario, lleva la guía y de ahí sale la factura) **sigue en Kepler**. *Decidida por encargo del PM (2026-11-13): son capturas separadas (CEDIS tiene 67 embarcados sin `U-D-41`), y escribir un documento que mueve inventario es otra escala de riesgo* | 6–8 | entra en la enmienda a ADR-086 |
| D27 | La escritura de SURTIDO va **en dos tiempos**: primero los pedidos surtidos completos; los que tienen diferencia, cuando la foto haya visto al menos 3 casos de cada transición con borrado y renumeración de renglones. *Decidida por encargo del PM (2026-11-13): bajar una cantidad hace que Kepler recalcule el importe, borre el renglón en cero y renumere el resto. El importe ya está verificado (GP.12.0d: 509 de 509 al centavo); el borrado y la renumeración tienen 2 casos* | 4b | ADR-117 |
| D29 | En la Suite se puede **agregar un producto** al pedido sólo en el **checado**, con motivo y con el nombre de quien lo agregó; nunca en el embarque (resuelve P-GP.10). *Edgar, 2026-11-13* | 5 | ADR-117 |
| D28 | Sucursal piloto: **Padre Hidalgo**. *Decidida por encargo del PM (2026-11-13): es el piloto de UB (misma bodega, mismo censo) y la de más pedidos (955 en 30 días)* | Piloto | — |

**Decisiones de octubre que quedan sin efecto:** la tesis «la Suite no escribe en Kepler» y «el
almacenista captura a Kepler una vez» (sustituidas por D13/D17); el checado que espera a que
Facturación pase el pedido (sustituido por el paso 4b); GP.4b como etapa aparte (los bultos se
arman en el checado, D12); GP.6 como cuadre (lo sustituye la bandeja de fallas de escritura).

---

## 6. Pendientes con nombre

| # | Pendiente | Bloquea | Quién lo resuelve |
|---|---|---|---|
| P-GP.1 | Dueño de piso de cada almacén (¿sigue Francisco para Kepler y David para preventa?) | Piloto | Edgar |
| P-GP.2 | Quién captura hoy el SURTIDO en Kepler con papel | Nada (contexto para el piloto) | Almacén piloto |
| ~~P-GP.3~~ | ~~Confirmar D4, D15 y D23~~ — **resuelto 2026-11-13**: D23 medido, D4 y D15 decididas por encargo del PM | — | — |
| P-GP.4 | Quién da la Salida por Embarque (D20) | Paso 8 | Almacén / Logística |
| P-GP.5 | Qué hace «Saldar Embarque» y quién — **⏸️ diferido por Edgar (2026-11-13)** | Paso 9 | Almacén / Logística, cuando se retome |
| P-GP.6 | ¿Más de un pedido por carreta? ¿Alcanzan las carretas con la ocupación hasta la carga? | GP.11 (umbral) | Medición + Edgar |
| P-GP.7 | Regla de «atorado» por etapa (D3) | Consola maestra, segunda vuelta | Edgar |
| P-GP.8 | ~~Sucursal piloto~~ (Padre Hidalgo, D28) y la **fecha** de su META, que se fija al cerrar E4 | Métrica de la cabecera | Edgar |
| P-GP.9 | ¿La Asignación de Transporte se hace en la Suite (y se escribe a Kepler) o sigue en Kepler? | E4 (GP.15.2) | Edgar |
| ~~P-GP.10~~ | **Resuelto: D29 (Edgar, 2026-11-13).** ¿Se puede **agregar un producto** al pedido en piso (surtido, checado o embarque), como hoy deja Kepler? El 3.2 % de los renglones nace después del pedido (medido en 21 días; ERP_KEPLER §3.y.3), y en un embarque real entraron 2 productos. Cambia lo que se vende, así que no es sólo proceso. **Recomendación:** sí, sólo en el checado, con motivo y con el nombre de quien lo agregó; nunca en el embarque | GP.12 (2º tiempo), GP.13 | Edgar |
| UB.P4 | Croquis de pasillos y racks de la bodega piloto | Pasos 1–2 | Almacén piloto |

---

## 7. Orden de construcción propuesto

> ⭐ **El plan de implementación completo** — etapas E0–E5, items por capa, objetivo y meta medida
> de cada etapa — está en [`FASE_GP_PLAN_IMPLEMENTACION.md`](FASE_GP_PLAN_IMPLEMENTACION.md). La
> tabla de abajo es el resumen por bloque.

El orden **físico** del proceso (pasos 1→9) no es el orden de **construcción**. Propuesta, por
capas (C0 dato → C1 dominio → C2 API → C3 UI, [`METODO_DE_TRABAJO.md`](../../METODO_DE_TRABAJO.md)):

| # | Bloque | Capas | Depende de | Nota |
|---|---|---|---|---|
| GP.10 | Consola maestra: Kepler + preventa + estado de piso; fusión de Tablero, Preventa y Consola de surtido | C2 · C3 | — | Sólo lectura + acciones del coordinador que ya existen. No necesita a Kepler escrito |
| GP.11 | Carretas y carritos: catálogo con tipo y QR, escaneo obligatorio al surtir, ocupación | C0 → C3 | Catálogo UB (existe) | |
| GP.12 | Escritura de estatus en Kepler (Surtido con pedido vs surtido; después Checado y Embarcado) + bandeja de fallas | C1 · C2 | **ADR enmienda 086** | ⛔ prueba contra base real |
| GP.13 | Checado: cola de Surtido, escaneo de carreta, sin candado de Facturación | C1 → C3 | GP.11, GP.12 | La pantalla existe |
| GP.14 | Posiciones de embarque | C0 → C3 | GP.13 | Familia `E` del catálogo |
| GP.15 | Catálogo de unidades con estibas + carga con escaneo + libera carreta | C0 → C3 | GP.14 | Coordinar con Logística (EMB) y Flotilla (FC, ⏸️) |
| GP.16 | Devolución de pedido cancelado | C1 → C3 | GP.11 | Absorbe GP.4.3 |
| — | Lugar fijo por producto y censo | — | — | Fase UB (UB.3, UB.8): en paralelo, es trabajo de piso |

**Reemplazos en el tracker:** GP.4b → GP.13 · GP.5 → GP.14 + GP.15 · GP.6 → GP.12 (bandeja) ·
GP.7 (indicadores) y GP.8 (piloto) siguen, después de GP.15.

---

## 8. Qué NO incluye

- **El proceso de preventa** (surtido de preventa, revisión en caja, guías de carga, entrega,
  liquidación): sigue en [`FASE_MCP_MESA_CONTROL_PREVENTA.md`](FASE_MCP_MESA_CONTROL_PREVENTA.md) y
  no se toca en esta etapa (D9). Sólo entra a la consola maestra como origen (D1).
- **La entrega y la guía de reparto del chofer:** Logística (`[EMB.56]`).
- **La factura:** sigue en Kepler; aquí sólo se registra el momento (D23) y el chofer (D21).
- **«Análisis BI»** (D5), la **regla de atorado** (D3) y **Saldar Embarque** (paso 9, diferido).

---

## 9. Riesgos

| Riesgo | Qué lo mitiga |
|---|---|
| Escribir en Kepler un estatus o una cantidad equivocada | ADR antes de construir; carril existente; prueba contra base real; bandeja de fallas visible en la consola |
| Que el piso siga con papel aunque la Suite funcione (como en octubre) | Piloto en una sola sucursal con su dueño de piso (P-GP.1, P-GP.8); la Suite no depende de una recaptura |
| El censo de ubicaciones no se hace | Pasos 1–2 son trabajo de piso con dueño; surtir con carreta (GP.11) no depende de ellos |
| No alcanzan las carretas con la ocupación hasta la carga | Medir antes de fijar la regla (P-GP.6) |
| El catálogo de unidades se duplica con Flotilla o Logística | Revisar el catálogo de vehículos existente antes de crear uno (regla 2) |

---

## 10. Definición de Terminado

- [ ] 1. Métrica de la cabecera **remedida** en la sucursal piloto, antes/después publicado
- [ ] 2. Cada capa verificada **o declarada NO MEDIDA** (ADR-056)
- [ ] 3. Todo endpoint que escribe (en la Suite y en Kepler) **ejercido contra base real** con el payload de la pantalla
- [ ] 4. Toda compuerta nueva **rota a propósito una vez**, rojo verificado
- [ ] 5. Todo primitivo genérico en `libs/` compartido **o** deuda con nombre en el tracker
- [ ] 6. Tracker + `03_LOG_REVISIONES.md` + roadmap de `CLAUDE.md` al día
- [ ] 7. **En prod**, o escrito por qué no y qué falta

---

## 11. Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
| 2026-10-06 → 11-12 | Plan original, GP.0–GP.9 (ver el anexo de historia) | Francisco, Edgar, Claude |
| 2026-11-13 | Medición de uso real (§0) y recorrido proceso por proceso: D1–D25, pendientes P-GP.1–8, orden GP.10–GP.16. El plan anterior pasa a anexo | Edgar, Claude |
| 2026-11-13 | E0 (sólo lectura): unidad de cantidades resuelta, Kepler recalcula el importe al bajar una cantidad, Salida por Embarque separada del estatus, D21 y D23 medidas. D4/D15 interpretadas, D26–D28 decididas por encargo del PM ([plan §2.1](FASE_GP_PLAN_IMPLEMENTACION.md)) | Claude |
| 2026-11-13 | GP.10.0 en código (los cancelados ya no se cuentan como vivos). GP.12.0d verificado. Borrador de ADR-117 para D13/D17. Nuevo pendiente P-GP.10 (agregar productos en piso) | Claude |
| 2026-11-13 | Edgar firma ADR-117, decide D29 (agregar productos sólo en el checado) y abre E1 por encima del cupo (GP pasa a 🔨, 7ª fase). El push espera. GP.10.1 en 🧪 | Edgar, Claude |
