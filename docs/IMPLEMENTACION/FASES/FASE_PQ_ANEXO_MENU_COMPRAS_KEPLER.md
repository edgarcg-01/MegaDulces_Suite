# Fase PQ · Anexo K — El menú de Compras de Kepler, completo

> Anexo de [`FASE_PQ_PEDIDO_VERDAD_Y_CIERRE.md`](FASE_PQ_PEDIDO_VERDAD_Y_CIERRE.md). **Completa y
> reemplaza su §20** (que cubría 7 de los 10 módulos). Agrega **PQ.122–PQ.125** y retoma
> PQ.110–PQ.114 y KR.7, que ya existían. Método: [`METODO_DE_TRABAJO.md`](../../METODO_DE_TRABAJO.md).
> Las decisiones de este anexo se numeran **DK1–DK3**, para no confundirlas con las D*n* del plan
> base ni con las DT*n* del anexo T.

```
OBJETIVO: que cada opción del menú Compras de Kepler tenga su destino decidido en la Suite:
          una acción en una pantalla que ya existe, una consulta, o «no se hace», con su porqué.
          Y que la Suite escriba en Kepler sólo lo que se decidió.
MÉTRICA:  HOY (2026-11-12, prod, 90 días):
          · opciones del menú: 10 módulos, 25 opciones (más los reportes, sin contar todavía);
          · opciones con destino firmado: 0 de 25 (el §20 propuso destino para 23; ninguno firmado);
          · la Suite escribe en Kepler 2 de las 25 (alta de requisición y alta de OC);
          · una recepción se captura 3 veces en Kepler (vale, orden de entrada, aplicación);
          · una de cada 8 OC se cancela (360 de 2,993) y la Suite no puede cancelar ninguna.
          MÉTRICA PRINCIPAL (el acto, no el papel): OC canceladas desde la Suite / OC canceladas
          en Kepler, 90 días, por sucursal. HOY: 0 de 360.
          → META: la mayoría de las cancelaciones de OC salen de la Suite (el porcentaje se fija
          al cerrar PQ.124, cuando se sepa cuántas son recaptura); 25 de 25 opciones con destino
          firmado; los reportes, inventariados.
CAPA TOPE: C3 (acciones en pantallas que ya existen; cero pantallas nuevas)
ÁREA:      Compras · Almacén (recepción) · Finanzas (cuentas por pagar)
ESTADO:    ⬜ plan — no abre fase (Fase 0, cupo lleno): todo entra como items de PQ
```

## 1. El pedido, literal

> «Hay que documentar un plan abarcando todos estos módulos, con sus respectivos submódulos.»
> — PM, 2026-11-12, sobre la captura del menú **Compras** de Kepler.

**Cómo cambió:** el §20 del plan base (2026-11-09) ya había resuelto los siete módulos de documentos.
La captura nueva agrega tres: **Reportes**, **Autorización de documentos** y **Consulta de
documentos**. Este anexo cubre los diez y corrige lo que el §20 suponía de «Saldar documento» (§3).

La regla del §20 sigue en pie: los siete documentos son **un solo flujo físico** (pedir → ordenar →
recibir → registrar la deuda → a veces devolver) que Kepler obliga a capturar por separado. La Suite
modela el **acto**, no el formulario de cada documento.

## 2. El árbol completo

| Módulo | Submódulos | Documento en Kepler (`kdmm`) | ¿Mueve inventario? |
|---|---|---|---|
| Requisición de compra | Alta · Baja · Consulta | `X-A-30` «Requisición de compra» | no |
| Órdenes de compra | Alta · **Modifica** · Baja · Consulta | `X-A-35` «Orden de compra» | no |
| Vale de entrada | Alta · Baja · Consulta | `X-A-37` «Vale de entrada» | no |
| Órdenes de entrada | Alta · Baja · Consulta | `X-A-40` «Orden de entrada» | **sí, entra** |
| Aplicación de orden de entrada | Alta · Baja · Consulta | `X-A-20` «Aplica Orden Entrada» (crea la cuenta por pagar y la póliza) | no |
| Devolución directa | Alta · Baja · Consulta | `X-D-40` «Devolución compra crédito» | **sí, sale** |
| Saldar documento | Alta · **Masivamente** · Baja · Consulta | `X-A-90` «Saldar documento CxP» | no |
| Reportes | ⚠️ **NO MEDIDO**: la captura llega plegada | — | — |
| Autorización de documentos | (sin submódulos) | cambia el estado `c43` de un documento | — |
| Consulta de documentos | (sin submódulos) | lee cualquier documento | — |

Los submódulos de los siete primeros salen de la captura desplegada del 2026-11-09 (§20). Los de
**Reportes** no se han visto: es lo primero que pide PQ.122.

## 3. Lo medido (2026-11-12)

`pg-prod`, `system_identifier` 7688376744939610156, sólo lectura. 90 días por fecha de captura
(`kdm1.c68`), las 9 sucursales. El estado sale de `c43`: **N** nueva · **A** autorizada · **R**
parcial · **F** terminada · **C** cancelada.

| Documento | Capturados | Cancelados (uso de «Baja») | Autorizados (A) |
|---|---:|---:|---:|
| Requisición `X-A-30` | 600 | 23 (4 %) | 20 |
| Orden de compra `X-A-35` | 2,993 | **360 (12 %)** | 10 |
| Vale de entrada `X-A-37` | 3,456 | 192 (6 %) | 7 |
| Orden de entrada `X-A-40` | 3,340 | 109 (3 %) | 36 |
| Aplicación `X-A-20` | 3,344 | 168 (5 %) | 0 |
| Devolución directa `X-D-40` | 125 | 14 (11 %) | 0 |
| Saldar `X-A-90` | 0 (1 en toda la historia) | — | — |

Lo que eso dice:

- ⭐ **«Baja» se usa todos los días.** Son 866 cancelaciones en 90 días entre los seis documentos, y la
  más frecuente es la de la OC: unas 4 por día. Por qué se cancelan (¿error de captura que se vuelve a
  capturar, o pedido que el proveedor no surtió?) **no está medido**, y cambia el diseño de PQ.110.
- ⭐ **«Autorización de documentos» no es una compuerta en Compras.** Sólo 10 de 2,993 OC están
  autorizadas, y **154 OC que siguen en N ya tienen su vale de entrada**: Kepler recibe contra una OC sin
  autorizar. La liga OC → vale (`c37='35'`, `c39` = folio de la OC, misma sucursal) casa con 2,311 de las
  2,311 OC parciales o terminadas. ⚠️ **Ese es sólo el control positivo, y es casi circular**: Kepler
  marca la OC como R o F justamente porque recibió un vale. Falta el control negativo (folio desplazado
  ±1 y sucursal equivocada deben dar ~0; las 360 canceladas, 0 —el 2026-11-09 PQ.110 midió «ninguna OC
  con vale cancelada», que va en esa dirección pero no descarta que la liga case de más). Hasta
  cerrarlo (PQ.124), **154** es una cifra provisional. La OC que escribe la Suite también nace en N
  (`kepler-requisition-sink.adapter.ts`), igual que las que se capturan a mano.
- **Las 312 OC en N se reparten así:** 154 con vale + 158 sin vale. El §7 habla de **145**: son las de
  esas 154 cuyo vale tiene de 31 a 90 días (subconjunto, no otra cifra).
- **Las OC parciales (R) viejas no están medidas.** Son la necesidad real de «saldar»: una OC que
  recibió una parte y el resto nunca va a llegar se queda abierta para siempre, porque en 90 días nadie
  usó `X-A-90`. PQ.125 las cuenta antes de construir nada.
- **Hay 166 OC sin ningún vale** (158 en N y 8 en A); 39 de ellas tienen más de 30 días. Son las
  candidatas a cancelar o saldar.
- ⛔ **Corrección al §20:** `kdmm` llama a `X-A-90` «Saldar documento **CxP**». Es un documento de
  **cuentas por pagar**, no el cierre de una OC. El §20.5 infería que «saldar» cierra la OC (`c43`→F,
  `c42`→0). Puede que el menú haga las dos cosas, pero no se sabe hasta ver un saldado real en el Kepler
  vivo. PQ.111 empieza por ese testigo.
- Sin uso en toda la historia: la devolución en dos pasos (`X-D-30`/`X-D-35`), la compra directa
  (`X-A-5`/`X-A-6`) y `X-A-60` (§20.1).

## 4. Opción por opción: a dónde va cada una

| Módulo | Opción | Hoy en la Suite | Destino | Item |
|---|---|---|---|---|
| Requisición | Alta | `/compras/pedido` → `/compras/requisiciones`; aprobar escribe `X-A-30` | ya está | — |
| | Baja | sólo se puede rechazar antes de aprobar | botón «Cancelar en Kepler» en `/compras/requisiciones/:id` | `[KR.7]` |
| | Consulta | ficha de la requisición y «Lo pedido» (PQ.108/109) | ya está | — |
| Orden de compra | Alta | sale con la requisición aprobada (PQ.22) | ya está; el 80 % sigue naciendo a mano en Kepler, sin requisición (§20.1), y cerrar esa brecha es el trabajo de PQ, no de este anexo | — |
| | Modifica | no existe | **no se hace**: se cancela y se reemite, que deja rastro (D39) | — |
| | Baja | la pantalla dice «ciérrala en Kepler a mano» | acción de fila en `/compras/oc-abiertas` | `[PQ.110]` |
| | Consulta | `/compras/oc-abiertas` y `/compras/ordenes/:id` (sólo lectura) | ya está | — |
| Vale de entrada | Alta | el Andén coteja lo que ya se capturó en Kepler | que **cerrar la recepción** en `/almacen/anden` lo escriba | `[PQ.112]` (D37) |
| | Baja | no existe | la baja de la recepción, desde el Andén, **antes** que la alta | `[PQ.112]` |
| | Consulta | Control de entradas | ya está | — |
| Orden de entrada | Alta / Baja | igual que el vale: se capturan juntos el mismo día | van en el mismo acto que el vale | `[PQ.112]` (D37) |
| | Consulta | `/compras/entradas/control/ordenes` (PQ.81) | ya está | — |
| Aplicación | Alta / Baja | `/compras/entradas` valida la factura | **no por ahora**: crea la cuenta por pagar y la póliza; ContPAQi sigue siendo el sistema contable (ADR-040) | `[PQ.114]` (D38) |
| | Consulta | Control de entradas | ya está | — |
| Devolución directa | Alta / Baja | sólo se ve en `/compras/descuentos` | que el reclamo resuelto como «devolver al proveedor» la genere, en `/compras/reclamos` | `[PQ.113]` (D37) |
| | Consulta | `/compras/descuentos` | ya está | — |
| Saldar documento | Alta / Masivamente | no existe | **condicionado a PQ.125**: si hay OC parciales o sin vale que nunca se van a completar, se cierran en `oc-abiertas` (una por fila y en lote); si no, se declara «no se hace». Antes, ver qué escribe de verdad (§3) | `[PQ.125]` → `[PQ.111]` |
| | Baja / Consulta | — | **no se hace**: deshacer un saldado no tiene caso de uso (las cuatro opciones de «Saldar» tienen el mismo uso, 1 en la historia; lo que justifica Alta es la necesidad que mida PQ.125, no el uso del menú) | — |
| Reportes | (sin inventariar) | — | cada reporte va a una pantalla que ya lo contesta, o se declara sin uso; **ninguno se copia tal cual** | `[PQ.122]` (DK3) |
| Autorización de documentos | — | la aprobación de `/compras/requisiciones` | **no se replica**: la aprobación de la Suite ya es la autorización, con dueño, firma y bitácora | — (DK1) |
| Consulta de documentos | — | cada documento se ve en una pantalla distinta; ninguna muestra la cadena completa | **una ficha por folio** con la cadena: requisición → OC → vale → orden de entrada → aplicación → pago, que se abre desde el buscador | `[PQ.123]` (DK2) |

**Resultado:** cero pantallas nuevas. Las 25 opciones caben en ocho pantallas que ya existen, más la
ficha de la cadena (PQ.123), que reutiliza la pieza del anexo T y no inventa otra (ADR-056).

## 5. El orden: dinero en juego × esfuerzo

Cada item sube de capa sólo cuando la de abajo está verificada (C0 dato → C1 dominio → C2 API → C3
pantalla).

0. **`[PQ.124]` + `[PQ.125]` (C0, sólo lectura, sin código).** Antes de escribir nada en Kepler:
   probar la liga con su control negativo, clasificar las 360 cancelaciones y contar las OC parciales
   viejas. Sus resultados deciden el diseño de PQ.110 y si PQ.111 existe.
1. **`[PQ.110]` + `[PQ.111]` cancelar y saldar la OC desde `oc-abiertas`.** Es la «Baja» más usada
   (unas 4 por día) y el esfuerzo es bajo. Su C0 restante: ver en el Kepler vivo qué cambia en una
   cancelación y un saldado reales (§20.6). Si PQ.124 dice que la mayoría son recapturas, PQ.110 se
   diseña como **«reemplazar OC»** (cancela y abre la nueva con las líneas copiadas), no como un botón
   de borrar.
2. **`[KR.7]` la baja de la requisición.** La Suite ya las crea; un documento que no se puede cancelar es
   peor que uno que no se puede crear.
3. **`[PQ.123]` la ficha de la cadena de compra.** Sólo lee, no escribe en Kepler, y contesta todos los
   días «¿dónde va mi compra?». Riesgo bajo.
4. **`[PQ.122]` el inventario de Reportes.** Barato, pero espera la captura desplegada.
5. **`[PQ.112]` la recepción desde el Andén.** El mayor ahorro (dos de tres capturas por recepción) y lo
   más delicado: **la orden de entrada mete inventario**. Espera D37.
6. **`[PQ.113]` la devolución desde Reclamos.** Poco volumen; también saca inventario. Espera D37.
7. **`[PQ.114]` la aplicación.** Al final, o nunca (D38).

## 6. Decisiones (sin firma)

- **DK1 — «Autorización de documentos» no se replica en la Suite.** En Compras no frena nada: 10 OC
  autorizadas en 90 días y 154 recibidas sin autorizar (cifra provisional hasta PQ.124). ⚠️ Antes de
  firmar: ver si las pocas autorizadas (10 OC, 20 requisiciones, 36 órdenes de entrada) se concentran en
  una sucursal o un usuario; si sí, esa sucursal sí usa la autorización y hay que preguntarle por qué
  (va en PQ.124). La autorización que sí importa es la aprobación
  de la requisición en la Suite. **Recomendación: sí.** Si alguna sucursal resulta usar una regla (por
  ejemplo, de monto), se pone en la aprobación de la Suite, no en Kepler.
- **DK2 — «Consulta de documentos» es una ficha por folio con la cadena completa**, la misma pieza que el
  anexo T construye para los traspasos. **Recomendación: sí.** Dos fichas distintas para dos cadenas
  serían el primitivo duplicado que prohíbe ADR-056.
- **DK3 — Ningún reporte de Kepler se copia tal cual.** Cada uno se lleva a la pantalla que ya contesta
  su pregunta, o se declara sin uso. **Recomendación: sí.** Un reporte sin una decisión detrás es carga,
  no información.
- Siguen sin firma, del plan base: **D37** (¿la Suite escribe documentos que mueven inventario?),
  **D38** (¿escribe la aplicación?), **D39** (Modifica = cancelar y reemitir) y **D40** (¿se le da
  `DELETE` en `kdm2` al rol de escritura, o la Suite sólo salda?).

## 7. Lo que NO se sabe todavía

- **Los submódulos de Reportes**: la captura llega plegada. Pide la captura desplegada (PQ.122).
- **Qué escribe «Saldar»**: `X-A-90` es un documento de cuentas por pagar; que además cierre la OC es
  una inferencia (§3).
- **Por qué se cancela una de cada 8 OC.** Si casi todas son errores de captura que se vuelven a
  capturar, el arreglo está antes de la cancelación. Se mide en PQ.124.
- **Por qué 145 OC (de las 154 en N con vale) tienen un vale de hace 31 a 90 días.** Una hipótesis: las
  captura oficinas y las recibe la sucursal en su propio Kepler (la doble captura de `ERP_KEPLER.md`).
  Sin medir; depende de que la liga pase su control negativo (PQ.124).
- **Las ligas de la cadena después del vale** (vale → orden de entrada → aplicación → pago): sólo
  OC → vale está medida. PQ.123 mide cada una antes de prometer la ficha.
- **En cuántas sucursales escribe hoy la Suite en Kepler.** El sink sólo escribe donde el servidor
  está encendido por variable de entorno (`servidoresEncendidos`); el «2 de 25» vale por opción, no por
  sucursal. Se mide en PQ.124.
- **Cuánto se usa cada opción del menú.** Kepler registra conexiones por clave de opción
  (`kepler_ods.orglogtbl_26`, tabla `sysConnect_26`). Si esa clave corresponde a las opciones del menú,
  se puede contar el uso real de cada una. Sin verificar.
- **Cuánto se usa «Modifica OC».** No deja un documento propio en el ODS, pero Kepler edita en su
  lugar y el cambio se puede fechar por `xmin` en la réplica (una OC con `xmin` posterior a su captura
  fue tocada). Sin medir; no es imposible.

## 8. Items nuevos

- **`[PQ.122]`** ⬜ **C0 — Inventario de «Reportes» de Compras de Kepler.** Con la captura desplegada:
  nombre de cada reporte, quién lo abre (si `orglogtbl` lo permite), qué decisión se toma con él y qué
  pantalla de la Suite ya la contesta. Sale una tabla con destino por reporte (DK3).
- **`[PQ.123]`** ⬜ **C0→C3 — La ficha de la cadena de compra por folio.** Requisición → OC → vale →
  orden de entrada → aplicación → pago, leída del ODS (sin importer, sin copiar tablas). Reutiliza la
  pieza de la ficha del anexo T (DK2). Se abre desde el buscador y desde cada pantalla que ya muestra
  un folio.
  - **C0 (antes de cualquier código): medir cada liga por separado** —vale → orden de entrada, orden
    de entrada → aplicación, aplicación → pago— con su columna, su cobertura (cuántos casan de cuántos)
    y su control negativo (folio desplazado y sucursal equivocada ≈ 0). Una liga que no pasa se dibuja
    como «sin liga medida», nunca como un eslabón vacío.
  - **Criterio de cierre:** una OC terminada con su cadena completa, una OC sin vale y una OC
    cancelada se ven bien en la ficha; cada eslabón dice de dónde salió.
- **`[PQ.124]`** ⬜ **C0 — Las cancelaciones de OC, medidas (sólo lectura en `pg-prod`).** Decide el diseño
  de PQ.110. Entrega una tabla en este anexo con:
  1. **Control negativo de la liga OC → vale:** folio desplazado ±1 y misma liga contra otra sucursal
     deben casar ≈ 0; las 360 canceladas, 0. Si no pasa, se corrige la liga y se re-miden 154, 166 y 145.
  2. **Clasificación de las 360 cancelaciones (90 días):** *recaptura* (misma sucursal y proveedor,
     otra OC capturada dentro de 48 h con importe ±5 %) · *no surtido* (sin OC de reemplazo) · *otro*.
     Con control: la misma regla aplicada a OC **no** canceladas da la tasa de coincidencia por azar.
  3. **Quién y dónde cancela:** por sucursal y por usuario, y cuántos días después de capturar.
  4. **Autorizaciones (DK1):** las 10 OC, 20 requisiciones y 36 órdenes de entrada en A, por sucursal y
     usuario.
  5. **Dónde escribe hoy la Suite:** sucursales con el servidor encendido para `X-A-30`/`X-A-35`, y
     cuántas OC escritas por la Suite hay en 90 días.
  - **Criterio de cierre:** la tabla publicada aquí, la META de cancelación fijada con número, y una
    línea de decisión para PQ.110: «botón cancelar» o «reemplazar OC».
- **`[PQ.125]`** ⬜ **C0 — La necesidad real de «saldar».** Contar las OC en **R** (parciales) sin vale
  nuevo en 30, 60 y 90 días, con su saldo pendiente en pesos, y las OC en N/A sin vale con más de 30
  días (hoy 39). Por sucursal.
  - **Criterio de cierre:** si el saldo pendiente viejo es material, PQ.111 sigue (primero el testigo
    de un saldado real en el Kepler vivo); si no, PQ.111 se cierra como ❌ «no se hace» con la cifra.

## 9. Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
| 2026-11-12 | Anexo K: los 10 módulos del menú Compras de Kepler con sus submódulos (25 opciones). Medido: una de cada 8 OC se cancela; la autorización no frena nada (154 OC recibidas sin autorizar); «Saldar» es un documento de cuentas por pagar (corrige el §20). Nacen PQ.122–PQ.123 y DK1–DK3, sin firma | Claude |
| 2026-11-13 | Revisión crítica, el anexo se vuelve implementable: la métrica principal pasa a ser el acto (OC canceladas desde la Suite, hoy 0 de 360); la liga OC → vale queda provisional hasta su control negativo; «saldar» se condiciona a medir la necesidad; PQ.123 mide cada liga antes de prometer la ficha. Nacen **PQ.124** (cancelaciones medidas) y **PQ.125** (necesidad de saldar), ambos C0 y primeros en el orden | PM + Claude |
