# Ejemplo resuelto — el análisis ANTES de la interfaz: `/finanzas/calendario-pagos`

> **Para quién:** quien vaya a diseñar o rediseñar una pantalla de esta suite. Es el método de
> [`SKILL.md` §0a](SKILL.md) aplicado de punta a punta a una pantalla real, con datos medidos.
>
> **Por qué existe** (Edgar, 2026-11-04): *«el análisis debe venir desde cómo armar una pantalla,
> cuál es el propósito de la interfaz, qué debe ver el usuario; el usuario debe tener accesibilidad
> a cada información (desglose, información tras información); debemos hacer esas cuestiones antes
> de generar esa interfaz»*. Hasta hoy el análisis empezaba **por los defectos** de una pantalla ya
> hecha; esta pantalla tuvo **tres rondas de parches y un rediseño en 10 días** (`[PGP.48]`–`[PGP.53]`)
> porque cada ronda arreglaba lo que se veía mal, no lo que la pantalla tenía que lograr.
>
> **Evidencia:** nivel **B** (producción en sólo lectura, `system_identifier` verificado, medido el
> 2026-11-04) y nivel **C** (código). ⚠️ **Sin pantalla viva** (no hubo sesión): nada visual de acá
> está medido en px; la maqueta es una propuesta, no una captura.

---

## Paso 1 · El propósito: qué ACTO cierra esta pantalla

No «mostrar el calendario» ni «gestionar pagos». El acto:

> **Que el dinero salga el día que toca, a quien toca, por la cuenta que toca, autorizado por
> alguien distinto de quien lo armó, y que quede registrado.**

**La prueba de la frase** (la pregunta que contesta, en una oración sin «y»):

> **«¿Qué falta para que salgan los pagos de este día?»**

⭐ Fíjate que no es «¿qué debo?» (eso es el Estado de cuenta de acreedores) ni «¿qué conviene
pagar?» (eso es un insumo para armar). Si la pantalla contesta las tres al mismo nivel, es
**conflación** (estándar §4.0, enfermedad A) — y eso es lo que medía la captura del 2026-11-03:
cinco preguntas a la vez, ~70 controles, ~60 cifras.

## Paso 2 · Quién entra, y con qué pregunta

De [`MATRIZ_ACCESOS.md`](../../../docs/MATRIZ_ACCESOS.md) (8 roles operan, `auditor_externo` sólo ve) y
del uso real (`analytics.ui_usage`, 14 días al 2026-11-04):

| Persona | Paso del circuito | Su pregunta al entrar | Lo que hizo en 14 días |
|---|---|---|---|
| Finanzas · Dirección | **armar** el día | ¿qué entra hoy y cabe en el tope? | 154 pagos creados, 176 facturas agregadas |
| Tesorería | **preparar** (método · origen · destino) | ¿qué me falta para que cada pago pueda salir? | **7** preparaciones |
| Dirección | **autorizar** el día | ¿lo firmo? ¿cabe, está completo, lo armó otro? | **0** autorizaciones |
| Caja General | **ejecutar** | ¿qué dispersar, en qué orden, cuál ya salió? | **0** ejecuciones |
| Todos | buscar en la deuda | ¿dónde está la factura de X? | **1,182** búsquedas (lo más usado) |

⭐⭐ **La misma pantalla, cuatro preguntas según el paso.** No son cuatro pantallas (memoria «una
sola interfaz por flujo»): es UNA pantalla que **abre en el paso en que está el día** y le contesta
a quien le toca ese paso. Lo de los otros pasos queda a un clic, no encima.

## Paso 3 · El estado real, medido (no supuesto)

| Hecho (prod, 2026-11-04) | Medido | Qué le dice al diseño |
|---|---:|---|
| Pagos pendientes desde el 16-oct | **109** | hay trabajo real armado |
| …de ellos **sin preparar** | **104 de 109 (95 %)** | ⭐ **el cuello es PREPARAR**, no armar |
| Días (lotes) | **33, los 33 en borrador** · 0 autorizados | nada ha cruzado a autorizar |
| Catálogo de cuentas de proveedor | **0 filas** | preparar una transferencia = teclear 18 dígitos sin red |
| Reordenar (`POST …/orden`) | **68 de 178 fallaron (38 %)**, todos 4xx | retrabajo medido; causa abajo |
| Búsquedas en la deuda | 1,182 | el buscador es la herramienta principal para armar |

⛔ **La conclusión que cambia todo:** el 95 % de lo armado está detenido en un paso que la pantalla
de hoy pone en **el tercer lugar** (después de la semana, el veredicto, el pronto pago y el
buscador), y que además **no puede completarse** mientras el catálogo de cuentas esté vacío. Un
rediseño que pule la vista de armar no mueve un peso. **Antes de la UI hay un hueco de dato (C0)**
y la UI lo tiene que **nombrar**, no esconder (ADR-056).

### Hallazgo que sale de medir: reordenar falla 4 de cada 10 veces

Causa (nivel C, coincide con el nivel B): las flechas ↑↓ intercambian dos pagos con **dos `POST`
en paralelo** (`moverPago`, `Promise.all`). El backend (`setPriorityRank`) rechaza un orden que
otro pago del día ya tiene — y en el instante del intercambio **cada uno tiene el número del
otro**: *«El orden N ya lo tiene otro pago de este día»*. La persona ve el error, vuelve a
intentar, o se rinde. **Arreglo:** un endpoint que intercambie los dos en **una** transacción.
⛔ Es un endpoint que escribe: no está probado hasta ejercerlo contra base real (regla 13).

## Paso 4 · Qué debe ver, y en qué ORDEN (nivel 0: sin un clic)

Lo que define el estado del día se ve **siempre, completo, con su valor final** (estándar §2.5):

1. **El día y su veredicto en una frase, con UN botón** — el del paso en que está el día:
   - armando: *«31 pagos por $4.2 M, caben en el tope ($1.1 M libres)»* → **[Guardar el día]**
   - preparando: *«29 de 31 sin preparar: falta método y cuenta destino»* → **[Preparar los 29]**
   - autorizando: *«31 pagos listos por $4.2 M · los armó \<usuario\>»* → **[Autorizar el día]**
   - ejecutando: *«12 de 31 ya salieron»* → **[Marcar los 19 pagados]**
2. **Lo que bloquea, por nombre** y con su salida: *«Sin cuenta destino: Proveedor A, B y 26
   más — el catálogo de cuentas está vacío»* → **[Capturar cuentas]**.
3. **El tope del día** en una línea: autorizado · comprometido · libre (o «excede $X»).
4. **Los pagos del día**, un renglón por pago (nivel 1).
5. **Para agregar**: primero el pronto pago (decisión de Edgar, `[PGP.53]`: *es la prioridad, se
   recomienda firme y se dice por qué*), después el buscador.

La semana es navegación: una tira compacta arriba, con lo libre de cada día y su estado en palabra.

## Paso 5 · Qué NO debe ver (o no al nivel 0)

| Hoy en la vista de entrada | Decisión | Por qué |
|---|---|---|
| La lista de 1,000 facturas | sólo al buscar o con «Ver todas (N)» | ya resuelto en `[PGP.52]`; se conserva |
| «Libres de $X esta semana» en el encabezado **y** lo libre de cada día **y** el tope del día | **una vez**: lo libre va en cada día de la tira; el total de la semana se deriva al pasar el cursor o se quita | el mismo hecho tres veces (§3c, dato repetido) |
| El pronto pago con su explicación larga abierta | la línea *«Paga primero el pronto pago: 7 acreedores, ganas $X en los próximos 7 días»* + abrir | el porqué es nivel 2, no 0 |
| «Preliminar», «Instrucción de ejecución», «Entregas de Compras» | en la barra de la sección, como acciones secundarias | no deciden el día |
| Avisos de contexto (separación de funciones, Kepler a mano) | sólo en el paso donde aplican (ya es así) | se conserva |

## Paso 6 · El mapa de desglose — información tras información

⭐⭐ **Cada número abre lo que lo forma, sin salir de la pantalla, y siempre se puede volver.** Se
diseña ANTES de la maqueta, como tabla. Una cifra sin fila en esta tabla es una cifra que no se
puede recorrer (estándar §1.2 y §2.5).

| Nivel | Lo que se ve | Se abre en | Qué contiene | Fuente (ya existe) |
|---|---|---|---|---|
| 0 | «29 sin preparar» | la tabla, **filtrada** a esos 29 | los pagos sin método/destino | `days/:date/allocations` |
| 0 | «excede $X» | la tabla con **la línea de corte** marcada | qué pagos quedan arriba y abajo del tope | `days/:date/summary` |
| 0 | «$X ya no se deben» | la tabla filtrada | los pagos con facturas que Kepler ya no debe | `kepler_saldadas` |
| 0 | «N siguen en días que ya pasaron» | ese día | los pagos atrasados | `pendientes-atrasados` |
| 0 | «ganas $X en los próximos 7 días» | la lista por **día en que cierra** | acreedor · importe · gana · % | `que-pagar` |
| 1 | un pago (renglón) | su **desglose en la fila** | por qué se paga hoy · cómo sale · cada factura con lo aplicado | `allocation.items` |
| 1 | «Cómo sale: falta destino» | el diálogo de preparar **con el destino propuesto** | cuenta favorita, CLABE, solicitud | `accounts/by-supplier` |
| 2 | una factura | **su archivo** (PDF o foto del comprobante) en otra pestaña, y **su folio de Kepler y su referencia** a la vista | el papel que se paga y con qué se ubica | `evidencia` · `evidencia/archivo/:id` |
| 2 | el folio de Kepler | la **ficha** del documento (side-peek) | Kepler, CFDI, vencimiento, pagos previos | `entity-inspector` |
| 2 | «$X a favor sin aplicar» | el side-peek de **descuentos** | notas de crédito aplicadas y pendientes | `creditos-a-favor/:proveedor` |
| 3 | el proveedor | su **estado de cuenta** (ECA) | toda su deuda, no sólo la de este día | `/finanzas/estado-cuenta-acreedores` |
| 3 | el día autorizado | el **testigo del ERP** | lo que Kepler registró ese día (otro universo, se dice) | `day.libro` |

**Reglas del mapa:**

- El desglose de nivel 1 vive **en la misma fila**; el de nivel 2, en un **side-peek** que no tapa
  la tabla; el nivel 3 **cambia de pantalla** y es el único que lo hace.
- Ningún nivel repite el de arriba: el desglose agrega, no copia.
- Todo lo que se abre con el mouse se abre con el teclado, y `Esc` vuelve al nivel anterior.

### ⭐⭐ El documento fuente: ¿puedo VER la factura y UBICARLA? (Edgar, 2026-11-04)

*«¿Puedo ver la factura en PDF o imagen? ¿El folio interno para ubicar la factura? Necesito que
tengamos este nivel de accesibilidad a la información.»* Es la pregunta que este análisis no se
había hecho, y es la que importa antes de pagar: **nadie paga ni autoriza un papel que no puede ver.**

Medido el 2026-11-04 (nivel B) sobre las facturas vivas de los 109 pagos pendientes:

| De 182 facturas vivas | | Qué se puede hacer |
|---|---:|---|
| con archivo (PDF o foto del comprobante de recepción) | **121 (66 %)** | abrirlo |
| sólo con el UUID del CFDI timbrado | **44 (24 %)** | ubicarlo en el SAT/ContPAQi por UUID |
| sin ningún papel | **18 (10 %)** | se dice el motivo |
| con la referencia del proveedor (`kdxe.c16`) | 178 | buscarla en el archivo del proveedor |

⛔ **Y desde el pago no se podía abrir NINGUNA.** El botón «Ver la factura» existía sólo en la
lista de deuda (para armar); el desglose del pago (donde se revisa antes de pagar o autorizar)
decía sucursal, folio e importe. Los datos estaban: `detalleExpediente()` ya trae folio interno,
folio externo impreso, OC y evidencia… **pero sólo los imprimía en el PDF «Preliminar»**. Dos
vistas del mismo pago con distinto nivel de detalle (Cruce 5).

**Resuelto el 2026-11-04 (`[PGP.58]`, sin validación visual):** cada factura del desglose del pago
trae **Folio Kepler** (abre la ficha) · **Referencia** · **Factura** (*Ver la factura* / *sin
archivo; hay UUID* / *sin factura: motivo*). El backend agrega `entity_ref` y `doc_ref` a cada
factura del pago (la misma llave que ya usan la ficha y la evidencia); la pantalla reusa el lote
de `/evidencia` y `abrirFactura()`. **Pendiente:** el folio externo impreso del CFDI (`serie-folio`)
en la fila — hoy sólo en el PDF —, y abrir el XML/PDF del CFDI cuando sólo hay UUID.

## Paso 7 · Accesibilidad de la información (no sólo WCAG)

| Pregunta | Respuesta para Pagos |
|---|---|
| ¿A cuántos clics está cada dato? | estado del día: 0 · un pago: 0 · sus facturas con folio y referencia: 1 · **el archivo de la factura: 2** · su ficha: 2 · el proveedor: 3 |
| ¿Puedo ver el papel y ubicarlo? | archivo (PDF o foto) donde existe; si no, el UUID o el motivo — **nunca un silencio**; folio de Kepler + referencia del proveedor en la fila |
| ¿Por nombre o por código? | proveedor y sucursal **por nombre**; el folio de Kepler junto al documento |
| ¿Buscable? | `/` enfoca el buscador; busca por proveedor, folio, referencia o código (ya existe) |
| ¿En qué orden llega? | los pagos del día **por el orden de dispersión**; la deuda por cercanía (default de `[PGP.50]`) |
| ¿Sin mouse? | todo; el foco **se ve** (arreglado el 2026-11-04: 11 anillos estaban a 1.56:1) |
| ¿Se distingue sin color? | cada estado con palabra + ícono: *falta destino*, *listo*, *rebotó*, *pagado* |
| ¿Cuánto tiene el dato? | el día y la deuda llevan su edad (hoy falta: deuda `§9` de `check:pantalla`) |

## Paso 8 · Con qué otros procesos se liga (de dónde viene, a dónde va)

```
Compras: entrega aceptada ─┐
Presupuestos: tope del día ─┼─► PAGOS: armar → preparar → autorizar → ejecutar ─┬─► Kepler X-D-26 (hoy a mano)
Kepler: documentos C*  ────┘                                                   ├─► Caja General (dispersión)
Catálogo de cuentas de proveedor ──(0 filas)──► preparar                        └─► Conciliación bancaria
```

En el renglón se ve **el folio de origen** (documento de Kepler) y, al ejecutar, **el de destino**
(el folio del pago). El catálogo vacío es una liga rota: la pantalla lo **dice** y lleva a
capturarlo; **no** reimplementa el catálogo.

## Paso 9 · ¿Le toca a esta pantalla?

| Cosa | ¿Aquí? | Dónde vive |
|---|---|---|
| Armar, preparar, autorizar, ejecutar el día | sí | aquí |
| Ver toda la deuda de un proveedor | no — se abre | Estado de cuenta de acreedores |
| Dar de alta la cuenta de un proveedor | no — se pide | catálogo de cuentas (solicitud con firma, TP.7) |
| Fijar el tope del día | no | Presupuestos |
| Capturar el pago en Kepler | todavía sí, a mano (se dice) | O3 de PGP |

## Paso 10 · La maqueta (propuesta, nivel C: sin validación visual)

⚠️ **Las cifras y los nombres de la maqueta son ILUSTRATIVOS**, para mostrar la forma de cada
renglón. Las cifras reales de este análisis son las del Paso 3. `[pi-…]` es el ícono de PrimeIcons
(en la interfaz nunca va un emoji).

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ ‹ 3–9 nov ›  Hoy   Lu 3 $0.8M libre·listos │ Ma 4 excede $0.2M·faltan 29 │ Mi 5 sin tope … │  ← la semana
├──────────────────────────────────────────────────────────────────────────────────────┤
│ Martes 4 · PREPARAR                                                                   │
│ 29 de 31 pagos sin preparar: falta método y cuenta destino.        [ Preparar los 29 ]│  ← nivel 0
│ ⓘ 26 proveedores sin cuenta destino: el catálogo está vacío.       [ Capturar cuentas ]│
│ Tope $4.0M · comprometido $4.2M · excede $0.2M  (corte después del pago 28)           │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ Pagos del día · 31                                    Preliminar  ·  Marcar pagados   │
│  #  A quién                    Por qué hoy        Cómo sale             Importe       │  ← nivel 1
│ ›1  Proveedor A · Morelia      vencida 12 días    falta destino   $412,300.00 [Preparar]│
│ ›2  Proveedor B · CEDIS        gana $3,100 (2%)   transf. BBVA→…4821 $155,000.00 [Cambiar]│
│ ⌄3  Proveedor C · Zamora       vence hoy          listo           $98,450.10 [Cambiar]│
│     │ Sucursal  Folio Kepler  Referencia  Factura                    Se aplica       │  ← nivel 2
│     │ Zamora    0004512       0-F-7482    [pi-file-pdf] Ver la factura  $40,000.00   │
│     │ Zamora    0004530       0-F-7490    sin archivo; hay UUID         $58,450.10   │
│ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  aquí se acaba el tope  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ Para agregar                                                                          │
│ [pi-bolt] Paga primero el pronto pago: 7 acreedores, ganas $18,240 en 7 días       › │
│ [pi-search] [ Proveedor, folio, referencia o código     / ]   Ver todas (2,941)       │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

Lo que cambia contra hoy, y lo que se conserva:

| | Hoy | Propuesta |
|---|---|---|
| Orden vertical | semana · veredicto · pronto pago · buscador · **pagos** | semana · veredicto · **bloqueos** · **pagos** · para agregar |
| Lo que bloquea | en la columna de cada renglón | **nombrado arriba**, con su salida |
| El tope | tira de métricas | una línea + **la línea de corte en la tabla** |
| «Por qué hoy» | sólo en el desglose | **columna** (decide el orden) |
| Reordenar | 2 `POST` en paralelo, 38 % falla | un intercambio atómico |
| Se conserva | una columna (`[PGP.52]`) · pronto pago primero al agregar (`[PGP.53]`) · el buscador con `/` · el desglose en la fila · los avisos por paso |

## Paso 11 · Criterios de aceptación (se miden en la pantalla viva)

De [`auditoria-diseno/VALORES.md`](../auditoria-diseno/VALORES.md), los que deciden esta pantalla:

1. **La prueba de la frase**: la vista de entrada contesta *«¿qué falta para que salgan los pagos
   de este día?»* y nada más al nivel 0.
2. **Clics para preparar un día de 31 pagos** con cuenta favorita: ≤ 3 (elegir método, origen,
   aplicar). Se cuentan, no se estiman.
3. **Reordenar**: 0 fallas en 20 movimientos seguidos.
4. **0 plegados al entrar** con algo que define el estado del día.
5. **Cada cifra del nivel 0 tiene fila en el mapa de desglose** (Paso 6) y se abre con teclado.
6. **El mismo dato una vez**: lo libre de la semana no se repite en tres lugares.
7. Foco visible ≥ 3:1, texto ≥ 4.5:1 (medidos el 2026-11-04: pasan), INP < 200 ms al filtrar.

## Paso 12 · Lo que la interfaz NO puede resolver (y por eso se dice primero)

- **El catálogo de cuentas de proveedor tiene 0 filas.** Mientras siga así, preparar una
  transferencia es teclear la CLABE a mano, y el 95 % de lo armado seguirá detenido. Es capa
  **C0**: por el método de trabajo, ninguna fase sube de capa con la de abajo sin verificar.
- **Autorizar exige que quien autoriza no sea quien armó**, y la Suite todavía no lo impide (la
  pantalla ya lo dice en el paso 3).
- **El pago en Kepler (`X-D-26`) se captura a mano** (O3 de PGP, bloqueado por permisos del ERP).

⭐ **El orden de trabajo que sale de este análisis** no es «rediseñar la pantalla»: es (1) sembrar o
capturar las cuentas de proveedor, (2) arreglar reordenar, (3) llevar «lo que falta para salir» al
nivel 0, (4) el resto de la maqueta. Las cuatro se miden con la cifra del Paso 3: **104 de 109 sin
preparar**.
