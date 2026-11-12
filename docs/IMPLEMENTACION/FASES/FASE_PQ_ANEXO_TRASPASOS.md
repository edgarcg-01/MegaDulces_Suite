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
