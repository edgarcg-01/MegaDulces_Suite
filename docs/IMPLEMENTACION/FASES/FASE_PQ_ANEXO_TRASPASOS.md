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
| 2026-11-22 | **Edgar: «el bloqueo funcional es que el informe no tiene a dónde llegar»**. Decisiones D1–D4 y **ADR-126** (deroga las decisiones 1 y 2 de ADR-100): el pedido de sucursal lo decide la sucursal y la Suite lo escribe como `U-D-40` en el Kepler del origen; el de proveedor sigue como requisición. Medición de la operación real (4,213 pedidos a mano en 90 días, red, cadencia, ventana horaria) y de las piezas: el sink de traspaso **ya existe y está en prod**, apagado en 9 de 9. Items **PQ.134–PQ.142** en §7.4. ⚠️ D1 (`CREADO`) queda abierta otra vez: 0 de 5,621 pedidos de sucursal de 365 días nacieron así, y donde el estado existe se pudre (§7.2) |

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
ESTADO:    🔨 C0 — decisiones D1–D4 de Edgar del 2026-11-22; ADR-126 escrito
```

### 7.1 Lo que decidió el PM (2026-11-22)

| | Decisión | Estado |
|---|---|---|
| **D1** | El documento nace en **`CREADO`** | ⚠️ **Abierta otra vez**: la medición posterior no la respalda, ver §7.2 |
| **D2** | La Suite sugiere el almacén principal y el usuario **puede cambiar el origen** | Firme — ADR-126 §3 |
| **D3** | Piloto en **Morelia Abastos (08) → Morelia Madero (07)** | Firme |
| **D4** | Se **deroga ADR-100**: la sucursal vuelve a decidir su pedido | Firme — ADR-126, ADR-100 marcada |

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

**Recomendación:** (b) **con las tres condiciones**, y el piloto decide: si en la primera semana la
mediana de `CREADO → AUTORIZADO` pasa de **1 día hábil**, se cambia a (a) sin volver a discutirlo.

### 7.3 Decisiones nuevas de este anexo

| | Decisión | Estado |
|---|---|---|
| **DT5** | El **estado inicial** del documento se escribe explícito en el sink de Autoabasto, no se hereda de la constante compartida `DOCTIPOS.traspaso` (hoy `AUTORIZADO` fijo, `kepler-doctipo.ts:81`), para que (a) y (b) sean un parámetro y no un `sed` | Decidida por Claude |
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
| **PQ.139** | C2–C3 | **Elegir el origen** (D2): `origen_clave` en `AutoabastoEnviarRequest` y en el diálogo de envío, default = almacén principal, validado en el servidor contra la lista blanca (activo, `kind <> 'truck'`, con `kepler_code`, distinto del destino). El interruptor y el servidor de escritura se resuelven por el **origen elegido** (ya resuelto en `commercial-replenishment.service.ts:5952`). La existencia del origen se muestra como dato, nunca como compuerta (ADR-126 §4) | Prueba negativa: origen `truck` o igual al destino → 400; origen con push apagado → mensaje claro, no silencio. *Respaldo: segundo origen real en las 8 sucursales, 27.7 %–58.6 % de los pedidos* |
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
