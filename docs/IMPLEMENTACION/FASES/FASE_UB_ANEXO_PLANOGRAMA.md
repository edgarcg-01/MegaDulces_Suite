# UB · Anexo — El croquis de la sucursal se configura (UB.PL)

> **OBJETIVO** — Que el catálogo de ubicaciones pueda describir **la tienda que existe**, no una
> rejilla: anaqueles, cabeceras, islas y cajas, cada uno con su forma y su lugar, configurables por
> sucursal. Hoy la captura sólo sabe generar paralelepípedos y todo lo que no es un pasillo tiene
> que robarse una letra de pasillo.
>
> **MÉTRICA** — Piezas que hoy mienten sobre lo que son: **60 de 315 ubicaciones de Padre Hidalgo
> (19 %)** están dadas de alta como «pasillos D a H» y son **cabeceras**. Almacenes con croquis:
> **0 de 9** — el dato no existe en ninguna parte. → **META:** 0 piezas obligadas a robar una letra,
> y Padre Hidalgo con su croquis configurado, antes de replicar a las otras ocho.
>
> **CAPA TOPE** C3 · **ÁREA** Almacén / Tienda · **DUEÑO** Edgar (PM) · **ESTADO** 🔨
>
> **Con qué se midió:** `pg-prod` en sólo lectura, `system_identifier` **7688376744939610156**,
> el 2026-11-26. Anexo de [`FASE_UB_UBICACIONES.md`](FASE_UB_UBICACIONES.md); **no es fase nueva**:
> el tablero marca **10 fases 🔨 contra un cupo de 4**, así que no se abre nada.

---

## 1. En una pantalla

La captura masiva genera el **producto cartesiano** `pasillos × racks × niveles`
(`expandLocationRange`). Eso alcanza para una bodega de anaqueles paralelos y para nada más. Cuando
Padre Hidalgo quiso registrar sus **cabeceras** —las puntas de anaquel donde va la exhibición—, la
única forma de expresarlas fue **inventarles letras de pasillo**: D, E, F, G y H, con 2 racks cada
una. El mapa las dibuja como cinco pasillos más, porque los datos dicen que lo son.

El problema no es el dibujo: **es que el dato no puede decir la verdad.**

| Lo medido hoy (2026-11-26) | |
|---|---:|
| Ubicaciones con formato en Padre Hidalgo | **315** |
| …de ellas, anaqueles de pasillo (A, B, C · 17 racks × 5 niveles) | 255 |
| …de ellas, **cabeceras disfrazadas de pasillo** (D–H · 2 racks × 6 niveles) | **60** |
| Asignaciones vivas que cuelgan de esas ubicaciones | **51** en 40 productos |
| Almacenes con catálogo con formato | 1 de 9 (CEDIS quedó en 1 tras deshacer su lote) |
| Almacenes con croquis | **0** — no existe la tabla, ni la columna, ni el concepto |

## 2. Cómo cambió el pedido

| # | Lo que se pidió (cita) | Efecto |
|---|---|---|
| 1 | *«agregué cabeceras a Padre Hidalgo, sin embargo el esquema visual no lo amerita como tal»* | El mapa dibuja D–H como pasillos. Primer diagnóstico: era de presentación |
| 2 | *«necesito que el esquema visual acompañe el diseño de la sucursal»* | Se plantearon 4 opciones de dibujo; Edgar eligió **planta editable arrastrando** |
| 3 | *«los 2 racks de cada cabecera son dos cabeceras distintas»* | Una «cabecera» de hoy son **dos piezas**, no una con dos caras |
| 4 | ⭐ *«necesito arreglemos esto de raíz, desde que se genera la captura masiva»* | **Deroga tratarlo como un arreglo de dibujo.** El trabajo es el modelo y la captura |
| 5 | ⭐ *«hagamos que todo sea configurable, para poder moldear correctamente el croquis o planograma de la sucursal»* | El croquis es **dato configurable por sucursal**, no una convención escrita en el código |

## 3. El universo y el trabajo — son dos números

- **Universo:** 9 almacenes. Ninguno tiene croquis.
- **Trabajo de este anexo:** **Padre Hidalgo**, 315 ubicaciones y 8 piezas (3 anaqueles + 5
  cabeceras). Es el único con catálogo real y el piloto de la fase UB.
- ⛔ **No** se replica a las otras ocho hasta que PH esté configurado y alguien lo haya usado en
  piso. Un croquis equivocado replicado nueve veces cuesta nueve veces.

## 4. Lo que creíamos y cayó

| # | Lo que se creía | Lo que midió prod |
|---|---|---|
| 1 | El problema era el dibujo del mapa | El dibujo es correcto **para los datos que hay**: D–H están guardados como pasillos |
| 2 | Las cabeceras tienen dos caras | Son **dos cabeceras distintas** (Edgar, 2026-11-26) |
| 3 | CEDIS tenía 375 ubicaciones | Quedó en **1**: su lote del 8-oct se deshizo. El andamio generado nunca fue un censo |
| 4 | Rehacer el catálogo se lleva las asignaciones | Sobrevivieron: **51 vivas en 40 productos** tras rehacer PH hoy |

## 5. Decisiones a firmar

| # | Decisión | Opciones | Recomendación |
|---|---|---|---|
| **D1** | ¿El **código** de ubicación cambia? | (a) sigue en 5 caracteres `[TB][A-Z][01-99][1-6]`; (b) se le agrega la pieza | **(a)**. Cambiarlo rompe el CHECK de la base, `normalizeBinCode` del escáner y el ancho de CODE128 ya calibrado. Hoy mismo costó dos `main` rotas tocar cosas de las que algo depende. **Lo que no cabe en el código se guarda al lado** — igual que el frente par/non de `[UB.RF.18]`, que se deriva |
| **D2** | ¿Se renombran las cabeceras D–H? | (a) se conservan; (b) se renombran al pasillo que encabezan | **(a)**. Ya tienen asignaciones colgadas y pudo haber etiquetas impresas (**NO MEDIDO**). Lo que cambia es **qué dice el sistema que son**, no cómo se llaman |
| **D3** | ¿Dónde vive la pieza y su lugar? | (a) columnas nuevas en `warehouse_bins`; (b) **tabla de piezas** con las ubicaciones colgando | **(b)**. La posición es **del mueble**, no de cada nivel: con (a) habría que repetir x/y en las 6 filas de una cabecera y mantenerlas iguales a mano |
| **D4** | ¿Quién configura el croquis? | (a) `ALMACEN_UBICACIONES_GESTIONAR` (ya existe y está repartido a 3 roles); (b) clave nueva | **(a)**. Es el mismo acto que dar de alta ubicaciones. Clave nueva = un permiso más que repartir (regla 20) |
| **D5** | ¿El croquis es por almacén o por almacén y zona? | (a) por almacén; (b) **por almacén y zona** | **(b)**. Bodega y tienda son plantas distintas del mismo almacén; el mapa ya se mira por zona |
| **D6** | ¿Qué pasa con lo capturado hoy? | (a) se conserva y se le deriva la pieza; (b) se rehace desde el editor | **(a)**. Las 8 piezas de PH se derivan solas de lo que ya hay (pasillo + tipo); nadie recaptura y las 51 asignaciones no se tocan |

## 6. Qué NO incluye

- **No cambia el código de ubicación** ni las etiquetas impresas (D1).
- **No replica a las otras 8 sucursales**: sólo Padre Hidalgo (§3).
- **No es un editor de layout con medidas reales** (metros, escala, puertas, refrigeradores): el
  croquis es **topológico** — qué pieza está dónde respecto de las otras, no cuántos metros mide.
- **No toca el recorrido de surtido** más allá de lo que ya hace `defaultPickSequence`: ordenar por
  el croquis es un frente posterior, cuando el croquis exista y alguien lo haya validado en piso.
- No toca CORS ni credenciales (regla del repo).

## 7. El orden de los frentes

| Orden | Frente | Por qué va ahí |
|---:|---|---|
| 1 | **C0 · La pieza existe en la base** | Sin dónde guardar «qué es» y «dónde está», todo lo demás es dibujo. Es el árbitro de las capas de arriba |
| 2 | **C1 · Las reglas de la pieza, puras** | Qué tipos hay, qué forma tiene cada uno, qué códigos genera, cuándo dos piezas chocan. Se prueba sin base ni pantalla |
| 3 | **C2 · La API del croquis** | Leer y escribir el croquis; crear una pieza en vez de un rango |
| 4 | **C3 · El editor y el mapa** | Arrastrar las piezas y que el mapa dibuje el croquis. **No se detalla hasta que C0 y C1 tengan árbitro** (método §1) |

## 8. Las capas

### C0 — La pieza existe (dato)

- **[UB.PL.1]** `commercial.warehouse_fixtures`: una fila por **pieza** (anaquel, cabecera, isla,
  caja, mostrador), con `tenant_id`, `warehouse_id`, `zona`, `tipo`, `pasillo` (la letra que ya usa),
  `racks`, `niveles`, `fila`, `columna`, `orden`, audit fields. `warehouse_bins` gana
  `fixture_id` NULL. Migración idempotente.
- **[UB.PL.2]** Las 8 piezas de Padre Hidalgo se **derivan** de lo que ya existe (pasillo + tipo) y
  cada ubicación queda apuntando a la suya: 0 recapturas, 0 asignaciones tocadas. Con su control:
  315 de 315 ubicaciones con pieza, y las 51 asignaciones intactas antes y después.

### C1 — Las reglas de la pieza (dominio, puro)

- **[UB.PL.3]** Catálogo de tipos de pieza con su forma: cuántos racks admite, cuántos niveles, si
  tiene dos frentes (anaquel de pasillo sí, cabecera no) y cómo se dibuja.
- **[UB.PL.4]** El generador de códigos **por pieza** reemplaza al rango cartesiano: una pieza sabe
  qué códigos produce. `expandLocationRange` queda como el caso particular «anaquel de pasillo».
- **[UB.PL.5]** Validación: dos piezas no pueden ocupar la misma celda del croquis ni la misma letra
  de pasillo en la misma zona, y una pieza no puede generar un código que ya existe.

### C2 — La API (no se detalla hasta que C0 y C1 tengan árbitro)

- **[UB.PL.6]** `GET/PUT` del croquis de un almacén y zona · `POST` de una pieza (crea sus
  ubicaciones) · mover una pieza sin tocar sus ubicaciones.

### C3 — El editor y el mapa (no se detalla todavía)

- **[UB.PL.7]** El mapa dibuja el croquis configurado. **[UB.PL.8]** El editor acomoda las piezas
  arrastrando, con el permiso de D4.

## 9. Riesgos y bloqueos

| Bloqueo / riesgo | Dueño | Causa | Qué lo destraba |
|---|---|---|---|
| El croquis de PH que se configure puede no ser el real | Edgar / encargado de PH | Nadie midió la planta; el sistema no la conoce | Que alguien de la tienda lo mire **en la tienda**, no en la oficina |
| Etiquetas ya impresas de D–H | **NO MEDIDO** | No hay registro de qué se imprimió | D2 lo evita: los códigos no cambian |
| El checkout compartido | Equipo | 95 archivos `.ts` sucios y piezas sin versionar de las que otras sesiones dependen | Hoy rompió `main` **tres veces, de dos sesiones**. Cada commit de este anexo se verifica **sobre el commit**, no sobre el árbol |

## 10. Definición de Terminado

- [ ] 1 · La métrica se volvió a medir al cerrar: 0 piezas robando una letra de pasillo.
- [ ] 2 · Cada capa tiene su árbitro antes de que se construya la de arriba.
- [ ] 3 · Las compuertas del repo en verde, con prueba negativa en cada regla nueva.
- [ ] 4 · Lo que no se pudo medir está declarado (ADR-056), empezando por la planta real de PH.
- [ ] 5 · Tracker y `03_LOG_REVISIONES.md` al día; ADR si D1 o D3 se deciden distinto.
- [ ] 6 · El permiso de D4 verificado **repartido en prod**, no sólo declarado (regla 20).
- [ ] 7 · Alguien de Padre Hidalgo usó el croquis en piso y dijo si se parece a su tienda.

## 11. Bitácora

| Fecha | Qué |
|---|---|
| 2026-11-26 | Anexo abierto. Medido: 60 de 315 ubicaciones de PH son cabeceras dadas de alta como pasillos; 0 de 9 almacenes con croquis; 51 asignaciones vivas. Tablero: 10 fases 🔨 contra cupo de 4 ⇒ **anexo, no fase nueva** |
