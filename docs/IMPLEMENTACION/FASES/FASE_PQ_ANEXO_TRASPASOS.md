# Fase PQ · Anexo T — Una sola puerta para los traspasos

> Anexo de [`FASE_PQ_PEDIDO_VERDAD_Y_CIERRE.md`](FASE_PQ_PEDIDO_VERDAD_Y_CIERRE.md). Agrega **PQ.115–PQ.121**.
> Método: [`METODO_DE_TRABAJO.md`](../../METODO_DE_TRABAJO.md). Las decisiones de este anexo se
> numeran **DT1–DT4** para no confundirlas con las D*n* del plan base.

```
OBJETIVO: que un traspaso se vea y se trabaje en UN lugar, por su folio, de que se pide a que se
          recibe, y que la palabra «traspaso» lleve ahí.
MÉTRICA:  HOY (2026-11-09, prod, 30 días):
          · pantallas que muestran traspasos: ~16, en 5 módulos; la única cuyo menú dice
            «Traspasos» (reporte mensual de Logística) tuvo 0 visitas;
          · clics desde la portada: aprobar 6 (4 por «Mi trabajo»), recibir 5, ver lo que viene
            en camino: 4 lugares distintos con lo mismo;
          · un folio de traspaso NO se puede seguir de punta a punta en ninguna pantalla;
          · requisiciones de traspaso de la Suite ligadas a su pedido de Kepler: 0 de 1,228.
          → META: una pantalla; ver la etapa de cualquier folio y actuar sobre él a ≤ 2 clics desde
          la portada; «traspaso» en Ctrl+K desde cualquier pantalla la encuentra.
CAPA TOPE: C3
ÁREA:      Almacén (sucursales y CEDIS) · Compras · Dirección
ESTADO:    🔨 C0 (PQ.115) — pedido por Edgar el 2026-11-09 («sí, hagámoslo»)
```

## 1. El pedido, literal

> «Siento que es complicado el acceder a traspasos. Analiza toda la interfaz a profundidad.»
> — y, sobre la propuesta: «sí, hagámoslo».

## 2. Lo medido (2026-11-09, `pg-prod` `system_identifier` 7688376744939610156, sólo lectura)

### 2.1 Dónde vive hoy cada acto

| Acto | Pantalla | Nombre en el menú | Clics desde la portada |
|---|---|---|---|
| Pedir (sucursal) | `/almacen/autoabasto` | «Abasto» | 2 (4 para enviar) |
| Proponer (Compras) | `/compras/pedido`, al abrir un producto | «Pedido» | 3–4 |
| Aprobar | `/compras/requisiciones` | «Seguimiento de compra» › «Requisiciones (consulta)» | 6 (4 desde «Mi trabajo») |
| Surtir | `/almacen/surtir`, `/almacen/pedidos` | «Surtir», «Pedidos» (Origen «Sucursal») | 3 |
| Embarcar | `/logistica/shipments` | «Embarques» | 3 |
| Recibir | `/almacen/anden` | «Andén» (la palabra «traspaso» aparece al 4º clic) | 5 |
| Diferencias | Movimientos, Incidencias, Reclamos, Cuadre de Finanzas | cuatro nombres | 2–5 |
| Consultar | `/logistica/traspasos` | «Traspasos» — **el único** | 2 |

- **Lo mismo, varias veces.** Lo que viene en camino está en 4 lugares: Autoabasto «Lo que te va
  a llegar», Pendientes de sucursal, el grupo «Traspasos» del Andén y Llegadas. Lo que espera
  aprobación también está en 4: «Lo pedido», dos pestañas de Requisiciones y la tarea de «Mi
  trabajo».
- **Ctrl+K** sólo funciona en `/projects`. Si se escribe «traspaso», encuentra únicamente el
  reporte de Logística. El Andén no tiene módulo en `AUTHZ_TREE`, así que no se encuentra buscando.
- **«Llegadas al andén»** (`ALMACEN_LLEGADAS_VER`) no está repartida a ningún puesto.
- `/almacen/anden` está declarada **dos veces** en `app.routes.ts` (líneas 1722 y 1751).
- `NIVELACION_GESTIONAR` («Gestionar traspasos») está en el árbol de permisos, pero no tiene ruta
  ni pantalla.

Uso en 30 días (visitas con métrica de pantalla; cuentan de menos, pero sirven para comparar):
Pedido 416 · Surtir 158 · Movimientos 68 · Requisiciones 68 · Pedidos de almacén 39 · Pendientes
de sucursal 20 · Autoabasto 20 · Incidencias 16 · Andén 10 · Embarques 9 · Llegadas 1 ·
Logística › Traspasos **0**.

### 2.2 La cadena en Kepler: completa y sana

Versión propia de cada documento (`c1 = sucursal`), 30 días por `c68`, 9 sucursales:

| Documento | De qué sale (`c36-c37`) | Docs |
|---|---|---:|
| `U-D-40` pedido de traspaso | — | 3,257 (de ellos con `c27 = SUCURSAL`, versión vigente: 1,719) |
| `U-D-41` embarque | `D-40` (nombra al pedido: `c38` serie, `c39` folio) | 2,783 |
| `U-A-50` recepción en la sucursal destino | `D-41` (nombra al embarque) | 1,292 |
| `U-D-6` salida de traspaso de sucursal | — (**suelta, sin pedido**) | 249 |

Embudo de los 1,719 pedidos de sucursal:

- **1,499** con embarque, el mismo día en la mediana.
- De esos embarques, 1,221 tienen un destino que se traduce a sucursal
  (`analytics.v_erp_branch_catalog`). **1,155 (95 %) ya se recibieron**: 1 día en la mediana y 3
  en el percentil 90. Sólo **10** llevan más de 3 días sin recibirse.
- **278** embarques tienen un destino que no se traduce a sucursal: NO MEDIDO a dónde van (PQ.121).
- **74** pedidos dicen `EMBARCADO` pero no se les encontró embarque `U-D-41` vivo: NO MEDIDO por qué (PQ.121).
- De las 249 `U-D-6` sueltas, la recepción que les corresponde **no se encontró** en el ODS
  (`N-A-6` no aparece): NO MEDIDO (PQ.121).

⛔ **La recepción se liga con el ORIGEN, no sólo con el folio.** En 90 días, 62 folios de
embarque se repiten entre sucursales de origen. `U-A-50` nombra al origen en `c10`, con su código
`TI…`. Buscar la recepción sólo por serie y folio da por recibido un embarque que sigue en camino,
porque otro origen recibió el suyo con el mismo folio. Hoy le pasa a «Lo que te va a llegar» de
Autoabasto (`VIENE_DOCS_SQL`, AB.45); en la ventana de 90 días son 3 pedidos. Es el mismo choque
que MX.2.7 resolvió para Movimientos.

⭐ **La lectura:** el traspaso real se pide, se surte, se embarca y se recibe en Kepler, y la
cadena se puede seguir por folio. La dificultad no está en el dato: está en que la Suite lo
reparte en 16 pantallas con otros nombres.

### 2.3 La Suite no llega a Kepler en traspasos

Requisiciones `source_type = 'branch'` de los últimos 30 días: **1,228**, y **ninguna** tiene
`kepler_folio` ni `oc_folio`.

| Estado | Requisiciones | Con error de Kepler |
|---|---:|---:|
| `cancelled` | 813 | 192 |
| `approved` | 359 (todas de la semana del 2-nov) | 355 |
| `ordered` | 55 | 49 |
| `pending_approval` | 2 | 0 |

Los errores dicen dos cosas: «La escritura a Kepler de la sucursal 00 / 01 / 08 (traspaso) está
apagada desde la Suite» y, en las de octubre, «KEPLER_PUSH_URL sin configurar».

O sea: **se aprueba en la Suite y el traspaso se vuelve a capturar a mano en Kepler**, y nada liga
el uno con el otro. Es doble trabajo, y es la decisión **DT3**.

**¿Se capturaron a mano? Medido el 2026-11-09, renglón por renglón.** Un renglón de la Suite cuenta
como «hecho» si aparece en un `U-D-40` de la misma pareja origen→destino, el mismo SKU y **la misma
cantidad**, entre 1 día antes y 7 después de la requisición. **Control (placebo):** la misma pareja y
el mismo SKU, pero en una ventana de 9 días **anterior** a la requisición, cuando todavía no existía.
Por SKU solo no hay señal: la Suite y Kepler piden los mismos productos de siempre, y el placebo
iguala al real (18 % contra 20 % en las aprobadas). Con la cantidad, sí la hay:

| Requisiciones | Renglones que casan con cantidad | Placebo | Requisición entera hecha |
|---|---:|---:|---:|
| `approved` del 2 y 3 de noviembre | 24 % | 4 % | — |
| `approved` del 4 al 9 de noviembre | ~1 % | ~5 % | — |
| `approved`, total | 9 % | 5 % | 16 de 371 (326 sin ningún renglón) |
| `cancelled` (auto-canceladas a los 7 días por «no salió a Kepler») | 16 % | 5 % | 63 de 831 |

Lectura:
- **Desde el 4 de noviembre, lo aprobado en la Suite no se ejecuta.** Kepler siguió armando traspasos
  todos los días en CEDIS, Padre Hidalgo, Canindo y Morelia Abastos (el ODS trae hasta hoy), pero sin la cantidad de la Suite.
- **Hasta el 3 de noviembre sí se recapturaba una parte**: en algunos días de octubre, entre 40 % y
  65 % de los renglones.
- **La auto-cancelación de 7 días afirma algo falso** en una parte de los casos: dice «no salió a
  Kepler» de requisiciones que sí se capturaron a mano. Esto lo resuelve PQ.120, ligando por la
  cantidad.

NO MEDIDO: la cantidad se compara en la unidad del renglón de Kepler (`c51`). En los cruces por SKU, el
cociente más frecuente es exactamente 1 (811 cruces), pero quedan múltiplos ×2, ×10 y ×12 que pueden ser cajas
contra piezas, así que «hecho» puede estar subcontado.

## 3. Decisiones

| | Decisión | Estado |
|---|---|---|
| **DT1** | Dónde entra el trabajo: **anexo de PQ**, no se reabre AB (pausada por cupo el 2026-11-06). PQ ya es el carril de «del pedido al ERP» y un traspaso es un pedido con origen sucursal | Decidida por Claude, firmada por Edgar el 2026-11-09 |
| **DT2** | La lista incluye **los traspasos capturados directo en Kepler**, no sólo los que nacen en la Suite. Se sigue el traspaso real | Edgar, 2026-11-09: sí |
| **DT3** | Mientras la escritura de traspasos a Kepler esté apagada (00, 01, 08), ¿se sigue pidiendo aprobar en la Suite algo que luego se captura a mano? **Recomendación:** que la fila lo diga («aprobada en la Suite · sin pedido en Kepler») y que se decida aparte, por sucursal, si se enciende la escritura. Encenderla escribe en Kepler: es de Edgar | ⚠️ Abierta, de Edgar |
| **DT4** | La pantalla nueva **reemplaza** a «Abasto» de Almacén (se llama «Traspasos») y absorbe los cuatro lugares de «lo que viene» y «Llegadas al andén». No se suma una pantalla: se quitan cuatro duplicados y una muerta | Decidida por Claude (regla «una sola interfaz por flujo») |

## 4. Las cinco preguntas, antes de dibujar (`diseno` §0b)

1. **¿Qué ve al entrar, y en qué orden?** Los traspasos de su alcance que **esperan algo de él**,
   los más atorados primero (más días en su etapa). Después, los que van en camino. Cada fila:
   origen → destino (por nombre), etapa, días en la etapa y el folio de cada documento.
2. **¿Qué NO ve?** Los renglones por producto quedan a un clic, en el panel de la fila. El reporte
   mensual de Logística queda como botón en la barra. Fuera los KPIs de marco: el conteo por etapa
   va en el filtro, no en tarjetas.
3. **¿Qué accesibilidad necesita?** Que cualquier folio (requisición, pedido, embarque o recepción)
   encuentre su fila. Sucursal por nombre, nunca «01». Etapa como filtro con su conteo. Ctrl+K
   «traspaso» desde toda la Suite. Teclado: flechas por fila y Enter abre el panel.
4. **¿Está ligada a otro proceso?** Sí, a todos: requisición de la Suite → `U-D-40` → `U-D-41` →
   `U-A-50` → incidencia o reclamo si hubo diferencia. Cada folio se ve en la fila y se abre.
   Surtir sigue en `/almacen/surtir` y recibir en el Andén: **la fila lleva al acto con el folio ya
   puesto**, no lo duplica.
5. **¿A quién le toca?** A la sucursal destino (lo que le llega y recibir), al origen o CEDIS (lo
   que tiene que surtir y embarcar), a Compras (aprobar) y a Dirección (todo). Es la misma lista
   recortada por alcance, y el botón del siguiente paso sólo aparece para quien le toca.

## 5. Items

| Item | Capa | Qué | Árbitro / prueba |
|---|---|---|---|
| **PQ.115** | C0 | Vista `derive-no-copy` de la cadena: una fila por pedido `U-D-40` (`c27 = SUCURSAL`, versión vigente) con su embarque `U-D-41` y su recepción `U-A-50`, más las `U-D-6` sueltas como su propio tipo. **Se extrae de `VIENE_DOCS_SQL` (AB.23/AB.45), no se escribe otra** (ADR-056); Autoabasto pasa a leer la vista | Conteos contra los documentos de Kepler del mismo periodo (§2.2). Control: la recepción contada = `U-A-50` con `c37 = 41`. Debajo de 500 ms por sucursal |
| **PQ.116** | C1–C2 | `GET /commercial/traspasos`: alcance por sucursal, búsqueda por cualquier folio, filtro por etapa con conteo, sin tope silencioso (`has_more`) | Prueba contra base real; un folio de otra sucursal da vacío |
| **PQ.117** | C3 | La pantalla «Traspasos» reemplaza a «Abasto» en Almacén (§4). La fila lleva al acto (surtir, recibir, aprobar) con el folio puesto | `check:pantalla` antes y después; las cinco preguntas re-contestadas con la pantalla terminada |
| **PQ.118** | C3 | Ctrl+K en toda la Suite (no sólo en `/projects`), y «traspaso» como sinónimo de la pantalla | Prueba: «traspaso» desde `/compras/pedido` abre la pantalla |
| **PQ.119** | C3 | Retirar los duplicados cuando PQ.117 esté verificado: Llegadas, «Lo que te va a llegar», el grupo de traspasos del Andén y las colas de Pendientes (que pasan a ligar a la pantalla). Quitar la ruta doble de `/almacen/anden` | Medir los roles que abrían cada una antes de quitarla |
| **PQ.120** | C0–C2 | Liga requisición de la Suite ↔ `U-D-40` (hoy 0 de 1,228). Depende de DT3 | — |
| **PQ.121** | C0 | Lo NO MEDIDO de §2.2: los 278 embarques sin destino traducible, los 74 «EMBARCADO» sin `U-D-41` vivo y la recepción de las `U-D-6` | Cada uno con su explicación o declarado en la pantalla |

## 6. Bitácora

| Fecha | Qué |
|---|---|
| 2026-11-09 | Análisis de la interfaz de traspasos (16 superficies, uso, cadena de Kepler, liga con la Suite). Anexo creado; PQ.115 a 🔨 |
| 2026-11-09 | **PQ.115 en código**: migración `20261109140626_pq115_v_traspasos_ciclo.js` (`analytics.v_traspasos_ciclo`) y prueba `test-newdb-pq115-traspasos-ciclo.js` (escenario sintético con ROLLBACK, control negativo sin origen en la llave). El SQL exacto de la migración, como vista temporal en prod: 3,767 filas = 3,767 pedidos de Kepler, 0 duplicados, 0 sin tenant, 140–240 ms. Dos lecciones: (1) con `LEFT JOIN` el planificador estimaba ~1 fila por pieza y tardaba 6.2 s (> 2 min sin `MATERIALIZED`; esa consulta se canceló en prod); apilar y agrupar por llave es lineal. (2) La recepción se liga por origen (`c10`). **NO MEDIDO:** la prueba no corrió en local (sin Docker); corre en `pruebas-db` del CI. **Falta:** aplicar la migración (lo hace el carril de despliegue) y, ya aplicada, que Autoabasto lea la vista (corrige AB.45) |
| 2026-11-22 | **Edgar: «el bloqueo funcional es que el informe no tiene a dónde llegar»**. Decisiones D1–D4 y **ADR-127** (deroga las decisiones 1 y 2 de ADR-100): el pedido de sucursal lo decide la sucursal y la Suite lo escribe como `U-D-40` en el Kepler del origen; el de proveedor sigue como requisición. Medición de la operación real (4,213 pedidos a mano en 90 días, red, cadencia, ventana horaria) y de las piezas: el sink de traspaso **ya existe y está en prod**, apagado en 9 de 9. Items **PQ.134–PQ.142** en §7.4. ⚠️ D1 (`CREADO`) queda abierta otra vez: 0 de 5,621 pedidos de sucursal de 365 días nacieron así, y donde el estado existe se pudre (§7.2) |
| 2026-11-22 | **PQ.135, PQ.136 y PQ.137 en código.** PQ.136/137: «Lo que te va a llegar» dejaba de pintar un pedido **cancelado** —de 170 documentos a 61 en las 9 sucursales, 109 eran cancelados; Morelia Madero 111 → 29— y `CREADO` entra en la lista de abiertos; la regla vive en `libs/contracts` y las tres consultas la comparten (ADR-056). PQ.135: el renglón del traspaso se escribe completo (`c51`, `c28`) y el estado inicial pasa a ser un parámetro validado (`[DT5]`). De paso, el ensayo contra el Kepler vivo estaba roto desde PQ.19 (mandaba las líneas sin factor de caja) y se saltaba en silencio por falta de plantilla. Nueve mutantes muertos |
| 2026-11-22 | **D1 cerrada por Edgar: `AUTORIZADO`** — *«seguimos el modelo de Kepler»*. El documento nace donde caen los 4,182 capturados a mano y la revisión del origen se muda al **borrador de la Suite**. En el código: `estadosIniciales` pasa de dos opciones a **una puerta** (`CREADO` entre los rechazados, 5 mutantes muertos); `WAREHOUSE_ORDER_ABIERTOS` conserva `CREADO` pero **por tolerancia de lectura**, declarado en cero; caen la condición de PQ.136 (nombrar quién autoriza) y el «cierra D1» de PQ.140. Los dos hallazgos de §8.4 quedan **anotados, no abiertos** (§8.7) — y el del sugerido trae su razón: *«nunca se hizo la configuración del sugerido, y es donde nace la necesidad del módulo de Autoabasto»* |
| 2026-11-22 | **El PM recorrió el carril entero a mano**, con un faltante deliberado, y lo cerró con un `U-D-90`. **§8**. Confirma `c10`, `c24` y `limpiar`; **corrige** dos cifras propias (`c28` **no** sigue al encabezado: guarda el estado de nacimiento, 81,482 renglones lo prueban; `c51` está en la **presentación**, no en unidad base) y **cierra D1** con evidencia: 0 de 4,182 pedidos de sucursal nacen `CREADO`, el estado es del carril de telemarketing y el menú del pedido de sucursal no tiene paso de autorización. Destapa dos cosas nuevas: el faltante **en tránsito** no lo ve nadie (35 embarques de 90 días llevan más de 11 días sin recepción) y Kepler **ya tiene una columna «Cant. Sug»** vacía donde cabría el sugerido de Autoabasto |

---

## 7. Anexo T.2 — El pedido de Autoabasto sale como pedido de sucursal (2026-11-22)

```
OBJETIVO: que el pedido sugerido de /almacen/autoabasto deje de no tener a dónde llegar y salga
          escrito en Kepler como pedido de sucursal (U-D-40) en la base del almacén que surte,
          dejando el pedido a proveedor como el otro proceso (requisición → X-A-30).
MÉTRICA:  HOY (2026-11-22, pg-prod, sólo lectura):
          · requisiciones de traspaso con folio de Kepler: 0 de 2,314 (toda la historia);
          · requisiciones creadas por un almacenista o encargado: 0 de 3,211;
          · eventos `enviar` en commercial.autoabasto_huella: 0 — el camino NUNCA corrió;
          · eventos `ajustar` de un usuario real: 0 (los 6 que hay son de la cuenta de prueba);
          · interruptor 'traspaso' de kepler_push_switch: apagado en 9 de 9;
          · pedidos U-D-40 c27='SUCURSAL' capturados a mano: 4,213 en 90 días.
          → META (pareja 08→07): que ≥1 pedido por día hábil de Morelia Madero nazca en la Suite y
          exista en Kepler con su folio, y que el renglón enviado deje de proponerse al día
          siguiente. Antes/después del volumen capturado a mano en esa pareja.
CAPA TOPE: C3
ÁREA:      Almacén (sucursales) · Compras (ve, ya no decide el traspaso) · Sistemas (plantilla)
ESTADO:    🔨 C0 — decisiones D1–D4 de Edgar del 2026-11-22; ADR-127 escrito
```

### 7.1 Lo que decidió el PM (2026-11-22)

| | Decisión | Estado |
|---|---|---|
| **D1** | El documento nace en **`CREADO`** | ⚠️ **Abierta otra vez**: la medición posterior no la respalda, ver §7.2 |
| **D2** | La Suite sugiere el almacén principal y el usuario **puede cambiar el origen** | Firme — ADR-127 §3 |
| **D3** | Piloto en **Morelia Abastos (08) → Morelia Madero (07)** | Firme |
| **D4** | Se **deroga ADR-100**: la sucursal vuelve a decidir su pedido | Firme — ADR-127, ADR-100 marcada |

### 7.2 ⚠️ Lo que la medición le discute a D1

`CREADO` **no existe en este carril**: 0 de 5,621 pedidos `U-D-40` con `c27='SUCURSAL'` de 365 días
está en ese estado — ni vigentes, ni cancelados, ni en versiones viejas (0 de 4,213 filas de 90
días, contra 303 de 4,073 en `TELEMARK`). Y donde sí existe, se pudre: **290 documentos `CREADO` de
TELEMARK en 90 días, el 100 % con más de 3 días**; la curva por antigüedad va de 0 % a 1–2 días a
**10.9 % a 31–60 días**. Dos de los que escribió la propia Suite llevan 5 y 11 días sin moverse.

A favor de `CREADO`: **6 de los 8 `U-D-40` que la Suite escribió nacieron `CREADO` y hoy están
`AUTORIZADO`**, movidos por personas dentro de Kepler. El mecanismo existe; lo que no existe es un
dueño nombrado para el pedido de sucursal.

⛔ Y dentro de la Suite, hoy `CREADO` es invisible para el propio módulo: cuatro lecturas filtran
`estado IN ('AUTORIZADO','SURTIDO','CHECADO')` — `ya-pedido-sucursal.ts:91-92` (lo que se **resta**
del sugerido: sin esto, **la sucursal volvería a pedir lo mismo al día siguiente**),
`autoabasto-pedido.service.ts:98` («Lo que te va a llegar»), `kepler-origen.ts:231` (pool de
surtido) y `picking.service.ts:1650` (que lo rechaza con 409).

**Las dos salidas, y lo que cuesta cada una:**

| | Qué implica | Costo |
|---|---|---|
| **(a) Nace `AUTORIZADO`** | Igual que los 4,213 reales; el circuito cierra solo y no hay nada que esperar | Ya es lo que escribe `kepler-doctipo.ts:81`. **Pierde** el paso de revisión del origen |
| **(b) Nace `CREADO`** (D1) | El origen revisa antes de surtir | Exige: nombrar quién autoriza en Morelia Abastos, agregar `CREADO` a las cuatro lecturas (PQ.136), fijar el estado explícitamente en el sink, y una alarma con plazo — sin eso el bloqueo se **muda** de la requisición al `CREADO` |

**✅ RESUELTA el 2026-11-22 — (a): nace `AUTORIZADO`.** El recorrido del carril a mano (§8) mostró
que el paso de revisión **no existe en este carril de Kepler**: el almacenista da de alta y el
documento nace `AUTORIZADO` sin preguntar; el menú va de «Alta de pedido» a «Estatus Surtido».
Edgar: *«AUTORIZADO, seguimos el modelo de Kepler»*. La revisión del origen que (b) buscaba vive en
el **borrador de la Suite** — «Enviar» es el acto que lo convierte en documento. ⛔ Cae con ella la
condición de PQ.136 sobre nombrar a quien autoriza, y PQ.140 deja de tener que cerrar D1.

### 7.3 Decisiones nuevas de este anexo

| | Decisión | Estado |
|---|---|---|
| **DT5** | El **estado inicial** del documento viaja en la entrada del sink, no en la constante compartida. Nació para que (a) y (b) fueran un parámetro y no un `sed`; cerrada D1 en `AUTORIZADO`, **se queda como puerta**: el sink rechaza, antes de abrir la conexión, cualquier estado que el tipo no declare — hoy sólo `AUTORIZADO`, y `CREADO` entre los rechazados. *Un `c11` inventado no falla al escribir: deja el documento fuera de todos los filtros* | Decidida por Claude · alcance ajustado por D1 (2026-11-22) |
| **DT6** | El trabajo vive en **este anexo** (DT1, firmada por Edgar el 2026-11-09), aunque `FASE_PQ §7` diga que Autoabasto queda fuera: gana la firma más nueva. Se corrige esa línea de PQ al cerrar PQ.134 | Decidida por Claude |
| **DT7** | La **plantilla** del traspaso se valida **antes de cada escritura** (viva, sin `c43='C'`, con ≥1 renglón), no una vez al configurarla. *Cifra: las dos candidatas que el repo arrastra para la 08 —`1/0000847` y `0000028`— están canceladas y con 0 renglones* | Decidida por Claude |
| **DT8** | El pedido se envía **parcial y varias veces al día**, como se opera hoy. ⛔ No se vuelca el sugerido entero: para Morelia Madero serían **1,244 renglones / $1.41 M** contra una mediana real de **7 renglones / $18,423** | Decidida por Claude |

### 7.4 Items

| Item | Capa | Qué | Árbitro / prueba |
|---|---|---|---|
| **PQ.134** | C0 | **Plantilla viva de la 08.** Elegir a mano un `U-D-40` sano del servidor 08 (candidata medida: `1/0001574`), fijarlo en `KEPLER_PED_TEMPLATE_FOLIO_08` / `_SERIE_08`, y agregar al sink la comprobación de que el molde está vivo y con renglones antes de clonar | Prueba negativa: con el folio cancelado `1/0000847` la escritura se **rechaza con motivo**, no clona en vacío |
| **PQ.135** | C1 | **El sink de Autoabasto escribe el renglón completo**: `c51` (= `c56`) y `c28` siguiendo al encabezado, como ya lo hace el sink de telemarketing. Hoy el de requisición no los toca y el renglón los **hereda del molde** — con D1 eso dejaría el encabezado en `CREADO` y el renglón en `AUTORIZADO` | Ensayo con `ROLLBACK` contra el Kepler vivo de 08: `c51 = c56` y `c28` = estado del encabezado en el 100 % de los renglones. *Medido: en los pedidos reales de 08, `c51` lleno en 145 de 145 y `c51 = c56` en 145 de 145; `c28='CREADO'` en 1,405 de 1,405 renglones de encabezados `CREADO`* |
| **PQ.136** | C1 | **`CREADO` deja de ser invisible** (sólo si D1 queda en (b)): las cuatro lecturas lo aceptan y la pantalla lo muestra como «pedido, esperando autorización» — se resta del sugerido y aparece en «Lo que te va a llegar» | Prueba negativa: un pedido `CREADO` sembrado se resta del sugerido; sin el cambio, el renglón se vuelve a proponer |
| **PQ.137** | C0–C1 | **Un cancelado de Kepler no se pinta como vivo.** `VIENE_DOCS_SQL` usa `ESTATUS_VIGENTE_SQL` (`kepler-origen.ts`) en el tramo del pedido, no sólo en el del embarque. *Cifra: de 111 documentos que «Lo que te va a llegar» pintaría hoy para Morelia Madero, **82 están cancelados** (74 %)* | Conteo antes/después contra `kdm1` con `c43='C'` del mismo periodo |
| **PQ.138** | C1–C2 | **`enviar()` escribe en Kepler** cuando el grupo es de origen sucursal: migración que agrega `kepler_sucursal / kepler_serie / kepler_folio / kepler_error / kepler_pushed_at / kepler_pushed_by` a `commercial.autoabasto_pedidos`, cierre del borrador (`estado='enviado'`, el CHECK ya lo admite) y huella `enviar`. ⛔ La idempotencia lee **la fila propia**, no el ODS: el último empuje de `kdm1` medido llevaba **288 min** de atraso | Prueba contra base real con el payload de la pantalla (regla del repo); enviar dos veces el mismo renglón escribe **un** documento |
| **PQ.139** | C2–C3 | **Elegir el origen** (D2): `origen_clave` en `AutoabastoEnviarRequest` y en el diálogo de envío, default = almacén principal, validado en el servidor contra la lista blanca (activo, `kind <> 'truck'`, con `kepler_code`, distinto del destino). El interruptor y el servidor de escritura se resuelven por el **origen elegido** (ya resuelto en `commercial-replenishment.service.ts:5952`). La existencia del origen se muestra como dato, nunca como compuerta (ADR-127 §4) | Prueba negativa: origen `truck` o igual al destino → 400; origen con push apagado → mensaje claro, no silencio. *Respaldo: segundo origen real en las 8 sucursales, 27.7 %–58.6 % de los pedidos* |
| **PQ.140** | C0 | **Encender el piloto 08→07**: interruptor `traspaso` de la 08 (con su `tope_dia`; ⚠️ el contador del tope es **compartido con las requisiciones de compra** de esa sucursal, `kepler-requisition-sink.adapter.ts:341-345`) y medir una semana: documentos escritos, mediana `CREADO→AUTORIZADO`, renglones recapturados a mano | Antes/después contra los 129 pedidos/mes de la pareja. **Cierra D1** |
| **PQ.141** | C0 | **Quién opera el piloto.** Medido: en 07 y 08 hay **cero almacenistas con almacén asignado**; en 07 el único con permiso y alcance propio es 1 encargado de tienda. Asignar `warehouse_id` o declarar por escrito que el piloto lo opera el encargado | `identity.users` de 07 y 08 con su alcance, antes de encender |
| **PQ.142** | C1 | **Cancelar lo que la Suite escribió**: hoy no hay camino en la Suite para cancelar un `U-D-40` y el interruptor `cancela_requisicion` está apagado en 9 de 9. Declarar el camino (cancelar en Kepler) y que la pantalla lo refleje. *Contexto: la pareja piloto cancela 1 de cada 3 pedidos, y 90 de 124 se cancelan **ya surtidas**, por la misma gente del origen que las capturó: no es arrepentimiento de quien pide* | La pantalla muestra `CANCELADO` dentro del día siguiente a una cancelación hecha a mano |

### 7.5 Lo NO medido

- Quién es cada capturista de Kepler (`0LMM`, `30AP`, `40LAHC`…): el ODS no trae el catálogo de
  usuarios del ERP, así que **no está probado** que quien captura el pedido sea del destino. Lo que
  sí se midió: 4 capturistas trabajan en varias sucursales a la vez (uno en 00, 01, 03 y 06, con 304
  documentos en 90 días), consistente con que la sucursal que pide se conecte a la que surte.
- Si Kepler **prohíbe** `CREADO` para un pedido de sucursal o simplemente nadie lo usa: el ODS es
  espejo, no reglamento.
- El tamaño exacto del sugerido: los 1,244 renglones de Morelia Madero salen de
  `analytics.replenishment_plan`, no de la fórmula completa del motor.
- Si `c16` del `U-D-40` es costo o precio de venta: no se usó esa cifra para ninguna conclusión.

---

## 8. Anexo T.3 — El carril completo, recorrido a mano (2026-11-22)

El PM capturó de punta a punta un pedido real de **Morelia Abastos → Morelia Madero**, con dos
renglones y **un faltante deliberado de 1 PAQ**, y lo cerró. Es el documento más valioso de este
anexo: no es una hipótesis sobre cómo opera el carril, es el carril ocurriendo. Todo lo de abajo se
contrastó después contra el ODS en sólo lectura — el documento ya estaba replicado el mismo día.

### 8.1 Los seis documentos, y quién escribe cada uno

| # | Acto (menú de Kepler) | Documento | Se captura en | Cómo liga al anterior |
|---|---|---|---|---|
| 1 | Control de Pedidos › Pedido de Sucursal › **Alta de pedido** | `U-D-40-1` | servidor del **origen** | `c10 = TI###` del **destino** · nace **`AUTORIZADO`** |
| 2 | **Estatus Surtido** | el mismo | origen | llena `c100` (responsable surtido) y las cantidades `c52` |
| 3 | **Estatus Checado** | el mismo | origen | llena `c102` y `c53` |
| 4 | **Estatus Embarque** | el mismo → `EMBARCADO` | origen | llena `c103` y `c54` |
| 5 | **Asignación de Transporte** | el mismo | origen | ruta, chofer y guía (`c83`, `c84`, `c86`) |
| 6 | **Salida por Embarque** | `U-D-41-2` | origen | `c36='D' c37=40 c38=1 c39=`folio del pedido |
| 7 | Traspaso de Sucursal › **Recepción Traspaso Suc** | `U-A-50-1` | ⭐ servidor del **destino** | `c36='D' c37=41 c38=2 c39=`folio del embarque · `c10 = TI###` del **origen** |
| 8 | **Saldar Embarque › Alta saldar documento** | `U-D-90-1` | origen | `c37=41 c38=2 c39=`folio del embarque · sólo la **diferencia** |

⭐ **La recepción vive en la base de la sucursal que recibe, no en la que surte.** Por eso el carril
no se puede auditar desde un solo servidor: hay que cruzar dos, y el ODS es el único lugar donde
ambos están juntos.

### 8.2 Lo que CONFIRMA del diseño ya construido

- **`c10 = TI###` del destino**, y el código es **el mismo en los dos sentidos**: la sucursal que
  surte aparece como «proveedor» en la recepción con su propio `TI###` del mismo catálogo
  (`analytics.v_erp_branch_catalog.dest_code`). No hay dos padrones que conciliar.
- **`c24` (Anotaciones) es la marca correcta** (`DOCTIPOS.traspaso.marca`): el texto que el PM
  escribió en el pedido **viajó solo** al embarque, a la pantalla de transporte («Observaciones
  Pedido»), a la recepción y al documento de saldo. Un pedido escrito por la Suite será reconocible
  en los cinco documentos siguientes sin tocar nada más.
- **`limpiar: ['c100','c102','c103']` es correcto**: los tres responsables se llenan en los pasos
  2, 3 y 4. Un documento recién nacido los tiene vacíos.
- **El renglón del pedido de sucursal** usa `c51` pedida · `c52` surtida · `c53` checada · `c54`
  embarcada, y `c59`/`c60`/`c61` para las ubicaciones de surtido, checado y embarque.

### 8.3 Lo que CORRIGE de lo que ya estaba escrito

| | Lo que decía | Lo medido el 2026-11-22 | Qué cambia |
|---|---|---|---|
| **`c28`** | «sigue al encabezado» | **NO lo sigue**: guarda el estado de **nacimiento** y ahí se queda — 81,482 renglones de documentos ya `EMBARCADO` siguen diciendo `AUTORIZADO`, y sólo 498 dicen `EMBARCADO` (de 85,436 renglones en 90 días) | La regla de PQ.135 **se refuerza**: no es que heredarlo del molde sea inocuo mientras los estados coincidan — es que **nadie lo corrige después**. La cifra vieja salía de mirar sólo documentos que no habían avanzado |
| **`c51`** | «vale lo mismo que `c56`» | Cierto, y ahora se sabe **por qué importa**: `c51` está en la **presentación capturada**, no en unidad base. Entre los renglones con factor de caja > 1, 35,533 de 38,372 tienen `c51 = c56` y **uno solo** `c51 = c9` | El sink ya escribe `c51 = c56` por construcción ✅. Queda **declarado** para que nadie lo «arregle» poniendo la unidad base |
| **D1** (nace `CREADO`) | «no tiene precedente en este carril» | **0 de 4,182** pedidos de sucursal de 90 días, y ninguno en toda la historia del ODS. `CREADO` vive **sólo** en el carril de telemarketing (818 documentos desde marzo de 2026) | Ver §8.6 |

### 8.4 Lo que DESTAPA — y no estaba en el plan

**a) El faltante no se ve en el pedido.** En esta prueba el pedido y el embarque dicen 2 PAQ; la
**recepción** dice 1. `c51 − c54` del pedido —lo que Autoabasto lee hoy como «negado»— da **cero**.
Son dos faltantes distintos y sólo uno está medido:

| Faltante | Dónde se ve | ¿Autoabasto lo lee? |
|---|---|---|
| El origen no surtió todo | en el propio pedido, `c51 ≠ c54` | **Sí** (1,023 documentos en 90 días) |
| Salió y no llegó | sólo cruzando el embarque con la recepción | **No** |

**b) Los embarques que nunca se reciben.** De 2,948 embarques de traspaso en 90 días, **35 llevan
más de 11 días sin su `U-A-50`** — y el desfase normal tiene mediana 1 día y p90 4. Casi todos son
de agosto y septiembre, concentrados en dos parejas de sucursales. En cambio, la diferencia **de
cantidad** entre lo embarcado y lo recibido es marginal: 94 recepciones por debajo, casi todas por
centavos. ⛔ **El agujero no es la merma, es la recepción que no se captura.**

**c) El documento que cierra la diferencia casi no se usa.** El `U-D-90` «Saldar documento» existe y
funciona —lo acaba de ejercer el PM—, pero en toda la historia del ODS hay **dos**, y uno es el de
esta prueba.

**d) ⭐⭐ Kepler ya tiene una columna para el SUGERIDO — y nunca se configuró.** La pantalla de
pedido de sucursal muestra **«Cant. Sug»** justo antes de «Cant. Ped», y está **vacía** en el
documento del PM. No es un descuido de esta captura: está vacía en los 85,436 renglones de 90 días.

⭐ **Esto explica por qué existe Autoabasto.** Edgar, el 2026-11-22: *«nunca se hizo la
configuración del sugerido, y es donde nace la necesidad del módulo de Autoabasto»*. El ERP previó
que alguien le dijera a la sucursal cuánto pedir, esa parte nunca se llenó, y el hueco se cubrió
durante años a criterio del almacenista. **Autoabasto no está inventando un concepto: está
ocupando un lugar que el ERP dejó vacío.** Por eso el módulo no tenía a dónde llegar — lo que le
faltaba no era el cálculo, era el documento.

Si algún día Autoabasto escribiera su sugerido en esa columna y en `c51` lo que la sucursal
confirmó, **el lazo se cerraría dentro del propio ERP**: cuánto de lo propuesto se vuelve pedido
quedaría medible sin ninguna tabla nuestra, y en la pantalla que el almacenista ya usa. ⚠️ **Qué
columna es, no está arbitrado** (§8.5), y el PM lo dejó **anotado, no abierto** (§8.7).

### 8.5 Lo NO medido de este recorrido

- **Qué columna de `kdm2` es «Cant. Sug».** La hipótesis natural es `c50` (el renglón usa `c51`–`c54`
  para las otras cuatro cantidades, en el mismo orden de la pantalla), y `c50` está **en cero en los
  85,436 renglones** de 90 días — consistente con la hipótesis y también con que sea otra columna.
  Se arbitra como se arbitró el resto: capturando un valor a mano en ese campo, en el servidor vivo,
  y viendo cuál cambia. **Hasta entonces no se escribe.**
- **Si los 35 embarques sin recepción son captura faltante o mercancía que no llegó.** El ODS no
  distingue las dos cosas; hace falta preguntarle a las dos sucursales involucradas.
- **Si el pedido de sucursal puede salir de `CREADO` dentro de Kepler.** El menú de «Pedido de
  Sucursal» va de «Alta de pedido» a «Estatus Surtido» sin un paso de autorización — eso es lo que
  la pantalla **ofrece**, no lo que la base **prohíbe**.
- **`c62` no es la hora de captura.** En este documento `c62 = 07:10` («Hora Ticket» en la pantalla)
  y la captura real fue a las 21:01 (`c69`). No se usó `c62` para ninguna conclusión.

### 8.6 Lo que esto le pide al PM — D1 otra vez

La intención de D1 es buena y está clara: **que el origen revise el pedido antes de surtirlo.** Lo
que el recorrido muestra es que **ese paso no existe en este carril de Kepler**: el almacenista da
de alta el pedido y el documento nace `AUTORIZADO` sin preguntar; el siguiente acto del menú es
surtirlo. `CREADO` es un estado del carril de **telemarketing**, que sí tiene autorización.

**✅ DECIDIDO el 2026-11-22 por Edgar: «AUTORIZADO, seguimos el modelo de Kepler».** La Suite
escribe el documento donde caen los 4,182, y **la revisión del origen vive en la Suite**, no en el
estado del ERP: el borrador de Autoabasto ya es ese lugar — el pedido se arma, el origen lo mira y
«Enviar» es el acto que lo convierte en documento. No se inventa un estado que ninguna pantalla
medida sabe mover, y no se pierde la revisión que D1 quería.

**Qué cambió en el código al cerrarla** (mismo día, sin cambio de comportamiento del default):

| | Antes | Ahora |
|---|---|---|
| `DOCTIPOS.traspaso.estadosIniciales` | `['CREADO','AUTORIZADO']` — dos opciones | `['AUTORIZADO']` — una **puerta**: todo lo demás se rechaza antes de abrir la conexión, `CREADO` incluido |
| `WAREHOUSE_ORDER_ABIERTOS` | incluye `CREADO` *porque el pedido nacería así* | lo sigue incluyendo, pero **por tolerancia de lectura**: hoy no hay ninguno (0 de 5,621) y está declarado. Escribir es estricto; leer, tolerante |
| PQ.136 | exigía nombrar quién autoriza en el origen | esa condición **cae** |
| PQ.140 | «cierra D1» | el piloto ya no decide nada de esto |

⭐ El mecanismo de `[DT5]` **no se tira**: deja de ser una opción y pasa a ser la compuerta que
impide escribir un `c11` que el carril no usa. Escribirlo no falla —por eso hacía falta la
puerta—, deja el documento fuera de todos los filtros del ERP y de la Suite. Probado con **5
mutantes muertos**: al devolver `CREADO` a la lista, cinco pruebas se ponen rojas.

### 8.7 Anotado, no abierto (decisión del PM, 2026-11-22)

Los dos hallazgos de §8.4 quedan **con nombre y con su medición**, sin item y sin ocupar cupo. No
son deuda olvidada: son trabajo que espera su turno, y acá está lo que haría falta para retomarlo.

| | Qué es | Qué costaría empezarlo | Por qué no ahora |
|---|---|---|---|
| **La recepción que no se captura** | 35 embarques de traspaso de 90 días llevan más de 11 días sin su `U-A-50`, con un desfase normal de 1 día y p90 de 4. El faltante **en tránsito** no lo ve ninguna pantalla: sólo se ve cruzando el embarque con la recepción, y el documento que lo cierra (`U-D-90`) tiene **dos** usos en toda la historia | Una medición por pareja de sucursales y preguntarle a las dos qué pasó con cada embarque: el ODS no distingue «no se capturó» de «no llegó» | Es un frente propio (toca almacén y contraloría, no Autoabasto) y PQ ya está en curso |
| **El sugerido dentro de Kepler** | La columna «Cant. Sug» del renglón, vacía en los 85,436 renglones de 90 días. **Nunca se configuró, y de ahí nace Autoabasto** (§8.4d) | Arbitrar qué columna de `kdm2` es, capturando un valor a mano en el servidor vivo y viendo cuál cambia. Hasta entonces **no se escribe** | El módulo primero tiene que llegar al documento (PQ.138); escribir el sugerido en el ERP es el paso siguiente, no el primero |
