# Fase PQ · Anexo P — El proveedor empareja su factura con nuestra OC, y el vale llega hecho

> Anexo de [`FASE_PQ_PEDIDO_VERDAD_Y_CIERRE.md`](FASE_PQ_PEDIDO_VERDAD_Y_CIERRE.md). Se apoya en el
> [anexo R](FASE_PQ_ANEXO_RECEPCION_EN_KEPLER.md) (el vale escrito por la Suite, `[PQ.112]`) y en la
> conciliación de factura de Recepción (`[RE.53]`/`[RE.55]`, `commercial.supplier_item_aliases`).
> Agrega **PQ.148–PQ.156** y las decisiones **DP1–DP7**.

```
OBJETIVO: que el proveedor empareje SU factura con NUESTRA orden de compra antes de que llegue el
          camión, y que al llegar el almacén reciba por factura, en nuestros productos y unidades,
          con el vale de entrada ya armado. Lo que el proveedor confirma enseña a la Suite su
          catálogo (su código, su descripción, su unidad).
MÉTRICA:  HOY (2026-11-24, prod, sin CL005):
          · vales que nacen de una factura emparejada antes de llegar: 0 (no existe el acto);
          · vales ligados a su factura: 168 de 703 (24 %) llevan el folio en la referencia;
          · renglones de factura que emparejan solos con nuestro producto: 654 de 2,797 (23.4 %, 30 d),
            y sólo por descripción: por código del proveedor, 0 (la llave no existe).
          · OC capturadas a mano el mismo día que su vale, sin requisición («la factura pasada a OC»):
            1,306 de 1,618 (80.7 %, 90 d); vales cancelados y rehechos en ±1 día: 78 de 221 (§3.8).
          MÉTRICA PRINCIPAL: vales de la sucursal piloto nacidos de una cita del proveedor / vales de
          esa sucursal, 30 días. HOY: 0 %.
          → META (propuesta, a firmar con DP5): a 60 días de encender el piloto, ≥ 50 % de los vales de
          los proveedores del piloto.
CAPA TOPE: C3 — una pantalla para el proveedor (nueva, DP1) y el Andén que recibe por factura (existe)
ÁREA:      Compras · Almacén (recepción) · el proveedor
DUEÑO:     a firmar (lo pidió Francisco el 2026-11-24)
ESTADO:    ⬜ plan — no abre fase (PQ está 🔨; cupo excedido). El C0 (PQ.148, PQ.150) es de sólo
           lectura y puede empezar. Abrir la Suite a usuarios externos es de Edgar (DP1).
```

## 1. El pedido, literal

> «La intención es que el proceso del vale de entrada el proveedor lo corra desde nuestra Suite,
> porque hoy se pierde mucho tiempo cuando llega el producto en cotejar contra lo que se pidió: de una
> orden de 30 productos vienen 15 en una factura, 12 en otra, tres en otra y los otros no se surtieron.
> Que el proveedor acceda a la Suite, jale la orden de compra y la empareje con su factura; si ya
> tenemos el UUID del SAT, conecte y descuente de la orden lo que corresponde a esa factura; y cuando
> llegue su camión a nuestro almacén ya tenga el vale de entrada de las notas que trae, sin tener que
> emparejar contra la orden de compra.» — Francisco, 2026-11-24.

Y antes, el mismo día: emparejar nuestro catálogo con el de cada proveedor (su lista de precios y su
descripción en factura) para que al pedir no quede duda y la factura empareje fácil con la OC.

Y después, también el 2026-11-24, de lo que dicen los proveedores: «muchas empresas del sector ya
solicitan **la cita**: entran a su suite y generan la cita, que es cuando el proveedor tiene la tarea de
emparejar lo facturado contra lo que va a llegar, y su andén no sufre el proceso de tener una persona
cotejando». Y pidió validar dos cosas: que cuando hay muchas diferencias **Compras borra el vale y hace
uno nuevo** limpio con la factura, y que **OC grandes se hicieron chiquitas y enseguida salieron 4 o 5
OC nuevas** (§3.8).

## 2. En una pantalla

```
HOY                                              CON ESTE ANEXO
OC ──► camión llega ──► el almacén coteja ──►    OC ──► el proveedor sube su factura y la empareja
       papel contra OC, renglón por renglón,            con la OC (la Suite propone, él confirma)
       convierte cajas a piezas a mano,                 ──► la OC dice: pedido · en camino · por surtir
       captura vale ──► orden ──► aplicación     ──► camión llega ──► se escanea el QR de la factura
                                                        ──► el vale ya está, en nuestra unidad:
                                                            sólo se cuenta y se cierra
```

## 3. Lo medido (2026-11-24)

`pg-prod` (`system_identifier` 7688376744939610156), sólo lectura. Scripts de la sesión `m1`–`m7` (no
versionados; lo que dicen va aquí). **CL005 se mide aparte**: emite el 98 % de los renglones de
factura recibidos (facturas de miles de renglones con unidad `ACT`) y no se parece al resto.

**1. El proveedor ya nos manda su catálogo, en cada factura.** 30 días: 128,027 de 128,084 renglones
de CFDI de proveedores de compra traen `NoIdentificacion` (su código). Sin CL005: 2,797 renglones, 59
proveedores, 1,196 pares (proveedor, descripción) distintos. El código de barras sirve poco: de todos
los renglones (con CL005), sólo 176 traen un GTIN válido que exista en `catalog.product_barcodes`.

**2. La historia enseña el emparejamiento, sin capturar nada.** 60 días: 1,335 facturas de acreedores;
522 se juntan 1 a 1 con su aplicación `X-A-20` (mismo proveedor, total ±$1, fecha ±20 días; 24
ambiguas); dentro, 3,427 de 4,429 renglones ↔ renglón de Kepler por importe neto (±0.5 %, único).

| Control | Real | Placebo (renglón al azar del mismo documento) |
|---|---:|---:|
| Equivalencias (proveedor, código) aprendidas | 1,198 | — |
| Códigos vistos 2+ veces que caen **siempre en el mismo SKU** | **722 de 733 (98.5 %)** | 27 de 733 (3.7 %) |
| Factor de unidad estable por código | 697 de 733 (95 %) | — |

**El factor importa**: en el 70 % de los renglones emparejados (2,405) Kepler registra la cantidad de
la factura × un entero (el proveedor factura cajas; nosotros recibimos paquetes o piezas); igual sólo
en 746 (21.8 %). Es la conversión a mano del [anexo R §3b.5](FASE_PQ_ANEXO_RECEPCION_EN_KEPLER.md).

**3. Lo que ya existe y se queda corto.** `commercial.supplier_item_aliases` (`[RE.53]`, se aprende al
dar por buena una factura en Recepción): 335 equivalencias de 43 proveedores desde el 2026-11-09, ya
con `unidad_proveedor` y `box_factor`, pero **la llave es la descripción normalizada**, no el código del
proveedor. Y la lista de costos por proveedor de Kepler (`kdpv_prov_prod`, 88,122 filas) cubre el 92 %
de los renglones comprados en 90 días, pero guarda **nuestra** descripción (96.6 %): no es el catálogo
del proveedor.

**4. El universo.** 90 días de órdenes de entrada: 3,863 pares (proveedor, producto), 268
proveedores, $172.4 M. Concentrado (por cabecera, 262 proveedores): los 10 primeros son el **52.9 %**
del dinero, 20 el 65.4 %, 40 el 79.1 %.

**5. La factura existe antes que el camión.** En 703 cadenas factura → aplicación → orden → vale, la
factura se timbró **antes** de capturar el vale en 690 (98.2 %): mediana **50.5 h antes**, p25 25 h,
p75 99 h. La Suite la recibe (`fiscal.cfdis`, `source = contpaqi_add`) con mediana de **24.8 h** después
del timbrado (p90 34.7 h): si esperamos nuestra descarga, el margen típico antes del camión es ~1 día y
en un cuarto de los casos no alcanza; si el proveedor sube su XML, es de ~2 días.

**6. Cómo llegan hoy las OC** (OC vivas de 30–120 días, sin CL005): 2,616; con un solo vale 2,454
(93.8 %), con 2 vales 72, con 3 o más 39, sin vale 51. En las que tienen vale, de 15,973 renglones:
13,311 surtidos completos, 173 parciales y **2,489 (15.6 %) no se surtieron**. En Kepler la cadena es
lineal: 1 vale → 1 orden de entrada (2,598 de 2,619) → 1 aplicación (2,561 de 2,602) → 1 renglón de
cuentas por pagar. ⚠️ Que una aplicación junte varias facturas **no se sostiene**: probar sumas de 2 o 3
facturas da lo mismo que el placebo (9 contra 24). Lo que el pedido describe (una OC en tres facturas)
hoy no queda registrado como tal: **se hace una OC por factura el día que llega** (§3.8c, medido después).

**7. El hueco de identidad.** 887 de 1,985 aplicaciones de 60 días son de un proveedor sin RFC en el
catálogo de acreedores (`kdxd.c10`) de esa sucursal: por RFC no se ligan a su factura. Por qué, **NO
MEDIDO** (el RFC del acreedor «no es de fiar», [`ERP_KEPLER.md`](../../ERP_KEPLER.md) §3.z.4).

**8. Lo que Francisco pidió validar** (scripts `m8`–`m11`, cada prueba con su control).

*a) «Compras borra el vale y hace uno nuevo» — **confirmado**.* 90 días: 3,312 vales, **221 cancelados
(6.7 %)**; cancelar borra los renglones (0 de 221 los conservan, igual que la OC en el anexo K §3c). En
**78 (35.3 %)** aparece un vale vivo nuevo del mismo proveedor —y de la misma OC cuando la tenía— dentro
de ±1 día; el placebo (un vale vivo con OC y otro vale vivo de la misma OC en ±1 día) da **5.9 %**.
Quién cancela (`c67`, como en la OC): `COMPRAS` 99 · `9EMG` 33 · `30BRC` 21 · `5004` 20 · `30APL` 15. Si
además se BORRAN vales sin cancelarlos no se puede ver: los huecos de folio no sirven (el control,
órdenes de entrada y aplicaciones, tiene los mismos huecos).

*b) «OC grandes se hicieron chiquitas» — **no editándolas**, al menos donde hay testigo.* La OC nacida de
una requisición se puede comparar contra ella (Kepler la copia renglón por renglón): de 858 en 120 días,
**855 siguen iguales** y 2 se achicaron. Ningún documento de compra tiene huecos en la numeración de
renglones (0 de 9,485). Para las OC sin requisición no hay testigo del tamaño original (sólo el respaldo
nocturno lo tendría): **NO MEDIDO**.

*c) «Salieron 4 o 5 OC nuevas» — **sí, y es la regla, no la excepción: la OC se captura al llegar, a la
medida de la factura**.* OC vivas de 7 a 90 días capturadas a mano sin requisición:

| OC del mismo proveedor y sucursal capturadas ese día | OC | Con vale | Vale **el mismo día** que la OC | Un solo vale con el **mismo total** |
|---|---:|---:|---:|---:|
| 1 | 1,109 | 1,073 | 796 (74 %) | 842 |
| 2 | 241 | 238 | 226 (95 %) | 225 |
| 3 | 87 | 84 | 82 (98 %) | 82 |
| 4 o más | 228 | 223 | 202 (91 %) | 216 |
| **Total** | **1,665** | **1,618** | **1,306 (80.7 %)** | **1,365 (84.4 %)** |

⛔ **Control** (que `c68` de la OC no se reescriba al recibir, lo que fabricaría el «mismo día»): de 179 OC
escritas por la Suite con vale, en 157 el vale llegó días después, y **155 conservan la fecha en que la
Suite las escribió** (152 siguen diciendo `SUITE`, según `commercial.purchase_requisitions.kepler_pushed_at`).
El «mismo día» es real. Y las OC de la Suite sí se comportan como pedido previo: 88 % reciben días después.

⇒ **Para 4 de cada 5 OC capturadas a mano, la OC de Kepler no es lo que se pidió: es la factura, pasada a
OC el día que llega.** Cuando un pedido llega en varias facturas se hacen varias OC (556 OC en días con 2
o más del mismo proveedor), porque cada vale cuelga de una OC y lleva una factura. Lo que se pidió de
verdad vive en otro lado: en la OC de la Suite, cuando existe, o fuera del sistema. Para este anexo
significa que **el aviso se empareja contra el pedido real (la OC que escribió la Suite) y no hace falta
crear una OC por factura ni rehacer vales**: en 90 días, 1,306 OC hechas a la medida y 78 vales rehechos
que desaparecerían.

**9. A qué hora se recibe** (la cita; Kepler no guarda la llegada, `c69` del vale es el proxy). 60 días:
los vales se capturan de 6–9 h a 17–21 h según la sucursal; la 08 (621 vales) tiene su pico a las 14 h
(16 %), la 00 (584) a las 9 h (18 %), la 07 por la tarde (19 h, 19 %). De lunes a sábado (domingo: 14).

**10. La factura ligada a su aplicación (`[PQ.150]`, medido el 2026-11-25).** Aplicaciones `X-A-20` vivas
de 60 días (hasta hace 3, sin CL005): 1,938, $114.5 M. **El RFC del acreedor falta en Kepler para 1,147
(59.2 %)**, y `kdm1.c22` no lo suple: es su copia (vacío en las 939 sin RFC). Lo que sí está: el folio
del proveedor en la referencia (`kdm1.c11`), en 1,759 (90.8 %), el mismo que usa Recepción (`[RE.43]`).

| Llave (en orden, cada una uno a uno sobre lo que quedó libre) | Ligadas | Testigo por renglón* | Placebo* |
|---|---:|---:|---:|
| RFC + folio de la referencia (factura entre 0.5× y 2× la aplicación) | 571 | 78 % | 2.0 % |
| Folio + total ±$1 (el acreedor sin RFC) | 295 | 75 % | 4.1 % |
| RFC + total ±$1 + ±20 días (la regla de antes, sobre lo que quedó) | 96 | 93 % | 8.8 % |
| **Total** | **962 (49.6 %, $88.6 M = 77 %)** | | |
| *Antes: sólo RFC + total* | *553 (28.5 %, $47.4 M = 41 %)* | | |

\* Pares con la mitad o más de sus renglones casados por importe (±0.5 %, uno a uno); el placebo es la
misma factura contra otra aplicación del mismo acreedor.

- ⭐ **Las llaves no se contradicen.** El folio no mira el importe y el importe no mira el folio: donde
  cada una sola encuentra factura única, eligen la misma en **458 de 458**.
- **La banda del total** sale de lo medido: sin ella, 3 aplicaciones caían en facturas de $0 y $6.48 que
  repetían el número de folio.
- ⭐ **76 ligas por folio tienen el total distinto, y no es ruido**: 72 son de **dos proveedores**, con la
  aplicación sistemáticamente abajo de su factura (3.3–4.9 % en 46 aplicaciones, 9.0 % en 23), unos
  **$548 mil en 60 días**. Es el caso que valida `[PQ.157]`: ¿hay nota de crédito por esa diferencia?
  NO MEDIDO aquí.
- **Lo que no se liga** (976): 765 aplicaciones ($9.1 M) son de acreedores sin ninguna factura en
  ContPAQi (remisión, personas físicas, `[RE.35.2]`). El nombre del acreedor contra el del emisor
  (`parecidoNombre`, `[RE.59]`) sumaría 35: no entra (sería replicar en SQL otra pieza de Recepción).
- **Costo.** La vista entera: 5,243 pares de toda la historia en 8.3 s. Filtrarla por un proveedor no
  es más barato (el uno a uno se decide contra todos los candidatos; con el filtro el plan se fue a
  92 s): por eso se lee de una matvista que se refresca cada hora.

**Lo que gana la historia de `[PQ.148]`** (mismo método: aprende de lo anterior al 26-oct y se prueba
contra los 30 días siguientes; placebo = el código del renglón vecino):

| | Antes | Con estas ligas, **sólo pares con el total igual** |
|---|---:|---:|
| Equivalencias (estables) | 1,494 (1,396), 60 proveedores | **2,514 (2,348), 133 proveedores** |
| Vistas en 2+ facturas, siempre el mismo SKU | 89.7 % | 89.0 % |
| Acierta con datos que no vio | 99.6 % (placebo 0 %) | 99.5 % (placebo 0.1 %) |
| Renglones con propuesta, proveedores con RFC en Kepler | 60.0 % | 60.8 % |
| … sumando los acreedores sin RFC en Kepler | 39.2 % | **57.3 %** |

⛔ **La historia NO puede aprender de todas las ligas.** Con las 76 de total distinto, sus renglones casan
por accidente, ensucian códigos estables y la cobertura de los proveedores que ya cubría **baja de
60.0 % a 49.3 %**. La vista de PQ.150 publica todas (PQ.157 necesita justo esas); la historia filtra
`diferencia` < $1. Y la última fila sólo se cobra si Recepción busca por el RFC de la factura cuando
Kepler no lo tiene: hoy busca alias e historia **sólo** por el RFC de Kepler.

## 4. Cómo se lleva a la Suite

**Un concepto nuevo, de la Suite: la cita.** Es lo que el sector ya le pide al proveedor (§1): una
fecha y una ventana en el andén de una sucursal, con **sus facturas** adentro —cada una un **aviso de
entrega**: la factura validada, con cada renglón emparejado a un renglón pendiente de sus OC—. Vive en
la Suite (dato propio, como un reclamo); **no escribe en Kepler** hasta que el almacén cuenta y cierra.
Sacar la cita ES emparejar: no hay cita sin facturas emparejadas.

1. **La OC se ve en el idioma del proveedor.** Con la equivalencia, cada renglón dice también su código,
   su descripción y su unidad («24 CJA = 576 PAQ»). Es lo que pidió Francisco: que al pedir no quede duda.
2. **El proveedor sube su factura** (el XML, o el UUID si la Suite ya la bajó del SAT). La Suite valida
   antes de mostrar nada: emisor = el proveedor de la OC, receptor = Mega Dulces, no cancelada, UUID no
   usado en otro aviso.
3. **La Suite propone, el proveedor confirma.** Cada renglón de la factura se empareja contra los
   pendientes de **sus** OC abiertas de esa sucursal: primero por su código (equivalencia), luego por
   descripción y cantidad × factor. Lo que no cuadra lo resuelve él; lo que la OC no tiene se marca
   (DP2). Una factura puede cubrir varias OC (DP3).
4. **Confirmar compromete la OC en la Suite.** La OC pasa a decir, por renglón: pedido · **en camino**
   (con qué factura) · por surtir. Compras ve **antes del camión** lo que no va a llegar (hoy el 15.6 %
   de los renglones) y decide (cancelar el saldo es `[PQ.110]`, ya existe).
4b. **El proveedor elige fecha y ventana** entre las que abre el almacén de esa sucursal (DP7). El
   almacén ve su día: quién viene, a qué hora y con qué facturas.
5. **Llega el camión → `/almacen/anden` recibe por cita.** Se escanea el QR de la factura (trae el UUID)
   o se abre la cita del proveedor; los renglones ya están en nuestros productos y en nuestra unidad. Se
   cuenta, y las diferencias van a reclamo (WMS-REC.8) en vez de borrar y rehacer el vale (§3.8a).
6. **El vale ES la cita** (Francisco, 2026-11-24; anexo R §3c y DR7): al confirmarla se escribe el vale
   `X-A-37`, **uno por factura** (DP6), con su referencia, y eso descuenta la OC en Kepler antes del
   camión. Si el camión no llega en su ventana, el vale se da de baja. Al llegar, el almacén **rastrilla
   en vivo** (código de barras, caducidad, cantidad) y eso es la orden de entrada (`[PQ.112.6]`, D37).
   Hasta que la Suite escriba en Kepler (`[PQ.112.4]`), la cita sirve igual para contar y el vale se
   captura en Kepler.
6b. **La aplicación valida el costo** (`[PQ.157]`, anexo R): con la equivalencia de este anexo, cada
   renglón de la factura se compara contra el precio de la OC; hoy 13.1 % llega a otro costo.
7. **Lo confirmado enseña.** Cada renglón confirmado por el proveedor y luego por el conteo refuerza la
   equivalencia (proveedor, código) → producto con su factor: el catálogo del proveedor se construye
   solo, con dos testigos independientes.

**Qué NO incluye:** la aplicación ni la cuenta por pagar (`[PQ.114]`, ⏸️); la lista de precios del
proveedor (DP4, después); pagos y estado de cuenta en el portal (eso es PGP); devoluciones `X-D-40`.

## 5. Decisiones a firmar

> **Respondidas por Francisco (Compras) el 2026-11-24; falta que Edgar las ratifique:**
> **DP2** (a) se acepta marcado y Compras aprueba · **DP3** sí, renglón por renglón · **DP5** la 08 ·
> **DP6** un vale por factura · **DP7** las ventanas las abre el encargado de almacén de cada sucursal;
> sin cita se recibe, en la fila. **DP4 cambia la recomendación**: «ya que vamos a abrir la Suite a los
> proveedores, el estado de su lista de precios es parte de su responsabilidad; que viva en la Suite y
> que cada cambio lleve autorización hace una doble responsabilidad entre el vendedor y el comprador»
> (`[PQ.155]`). **DP1** sigue siendo de Edgar; la posición de Compras es abrir.

| # | Decisión | Opciones | Recomendación |
|---|---|---|---|
| **DP1** | ¿Quién empareja la factura, y el proveedor entra a la Suite? | (a) cuenta por proveedor (rol `proveedor`, sólo sus OC y citas) · (b) liga firmada por OC, sin cuenta · (c) nadie de fuera: Compras o Almacén empareja la factura al bajarla del SAT | **(a) es el destino; (c) es el respaldo que no espera la firma.** Los proveedores ya sacan citas en las suites de otras empresas del sector (§1): el hábito existe, así que el piloto puede ir directo a (a) con pocos proveedores si Edgar firma abrir la Suite a externos (superficie expuesta, alta y baja de cuentas, qué ve cada uno). Mientras, (c) con la misma pantalla: Compras empareja la factura al bajarla del SAT (~1 día antes del camión, §3.5). (b) se descarta: una liga reenviada enseña precios a quien sea |
| **DP7** | La cita: ¿quién abre las ventanas y qué pasa con quien llega sin cita? | ventanas por sucursal que define el almacén · sin ventanas (sólo fecha) — sin cita: se recibe con fila · no se recibe | **Ventanas por sucursal, las abre el encargado de almacén** (hoy se recibe de 6–9 h a 17–21 h según la sucursal, con picos distintos: la 08 a las 14 h, la 00 a las 9 h, §3.9). **Sin cita se recibe** en el piloto, después de quien la trae; no recibir es una regla comercial que se decide cuando la cita ya funcione. **2026-11-24, Francisco (Compras):** «si la gente llega sin cita también se le recibe, pero va a la fila de recepción» — la regla de negocio coincide; falta que Edgar la ratifique |
| **DP2** | Lo que la factura trae y la OC no (otro producto, más cantidad) | (a) se acepta marcado y Compras lo aprueba · (b) el portal no lo deja pasar | **(a).** La sustitución existe; bloquearla manda al proveedor de regreso al papel. El Andén cuenta lo que llegó; Compras decide si se queda |
| **DP3** | ¿Una factura puede cubrir varias OC? | sí, renglón por renglón (mismo proveedor y sucursal) · no | **Sí.** El proveedor factura por embarque, no por nuestra OC |
| **DP4** | La lista de precios del proveedor | subirla ahora · después, sobre las mismas equivalencias | **Después.** Es un dato nuevo (su Excel/PDF), no está en Kepler; con la equivalencia por código, cruzarla es directo. Primero lo que ya llega solo (la factura). **2026-11-24:** gana peso — validar el costo al aplicar (`[PQ.157]`) pregunta «¿se anunció el cambio?», y la respuesta es su lista vigente. **Francisco decidió otra cosa, mejor:** la lista **vive en la Suite y la mantiene el proveedor**; cada cambio (precio, vigencia, promoción) es una **solicitud que autoriza el comprador**. Doble responsabilidad: el vendedor responde por lo que publica, el comprador por lo que autoriza. Va con la cuenta del proveedor (DP1). Propuesta para arrancar: la Suite le precarga su lista con lo que ya sabemos (su código, su descripción, su unidad y el último costo aplicado) y él la confirma; cada diferencia es su primera solicitud. Si el cambio autorizado se escribe también en Kepler (`kdpv_prov_prod`): **no decidido** (es escribir en Kepler, de Edgar) |
| **DP5** | Piloto | proveedores × sucursal | **La sucursal del anexo R (DR4, 08) y sus proveedores de más renglones**; los 10 primeros de la empresa son el 52.9 % del dinero |
| **DP6** | ¿Un vale por factura? | sí · uno por OC | **Sí.** Es la forma de Kepler hoy (1 vale → 1 orden → 1 aplicación → 1 renglón de cuentas por pagar) y deja la factura ligada al vale por construcción (hoy, 24 %). Y sin crear una OC por factura (§3.8c): el vale de cada factura cuelga de la OC real; si una factura cubre renglones de varias OC, cada renglón del vale lleva la liga de su renglón de OC (`c19`–`c23`). Que Kepler acepte un vale con renglones de dos OC: **NO MEDIDO** (ensayo de `[PQ.112.4]`) |

## 6. El orden

**Dinero en juego:** alto y doble — el tiempo de recepción (NO MEDIDO, `[PQ.112.3]`) y la verdad de la
compra: lo que no se surte se sabe antes (15.6 % de los renglones), y la factura queda ligada a lo
recibido (hoy 24 %). **Esfuerzo:** C0 S; equivalencias M; aviso + pantalla M–L; portal externo L.

| Orden | Item | Capa | Por qué ahí |
|---|---|---|---|
| 1 | **PQ.148** las equivalencias por código, aprendidas de la historia | C0→C1 | Es lo que hace que todo lo demás proponga bien; ya medido el control (98.5 % contra 3.7 %) |
| 2 | **PQ.150** la factura ligada a su aplicación | C0 | 39 % hoy; sin esto la historia enseña la mitad de lo que podría |
| 3 | **PQ.149** el aviso de entrega (dominio y API) | C1–C2 | El concepto nuevo; no escribe en Kepler |
| 4 | **PQ.151** emparejar la factura con la OC (escalón A, interno) | C3 | La misma pantalla que después usará el proveedor |
| 5 | **PQ.152** la OC dice pedido · en camino · por surtir | C2–C3 | Compras ve lo que no llegará antes del camión |
| 6 | **PQ.153** el Andén recibe por factura | C3 | Une con `[PQ.112.5]` |
| 6b | **PQ.156** la cita: fecha y ventana | C1–C3 | El almacén ve su día; necesita DP7 |
| 7 | **PQ.154** el proveedor entra a la Suite (escalón B) | C2–C3 | Sólo con DP1 firmada |
| 8 | **PQ.155** la lista de precios vive en la Suite, la mantiene el proveedor y la autoriza el comprador | C1–C3 | Va con la cuenta del proveedor (PQ.154, DP1); es la referencia de PQ.157 |

## 7. Items

- **`[PQ.148]`** ⬜ **C0→C1 — Las equivalencias del proveedor, por su código.** Extender
  `commercial.supplier_item_aliases` (no otra tabla, ADR-056) con el código del proveedor
  (`NoIdentificacion`) como llave primera, la descripción como segunda, la unidad y el factor; cargar
  las aprendidas de la historia (§3.2) marcadas por origen y confianza, sin pisar las confirmadas.
  Las que cambian de producto (11 de 733) o de factor (36) no se aprenden solas: van a revisión.
  Cierre: renglones de factura (30 d, sin CL005) que emparejan solos, antes/después (HOY 654 de 2,797,
  23.4 %), con el placebo de §3.2 repetido.
- **`[PQ.149]`** ⬜ **C1–C2 — El aviso de entrega.** Tabla propia (`tenant_id`, auditoría): la factura
  validada (UUID, emisor, receptor, estado SAT) y sus renglones, cada uno ligado a un renglón de OC con
  cantidad en la unidad del proveedor y en la nuestra. Compromete cantidades en la Suite; no toca
  Kepler. Contrato en `libs/contracts`. Prueba contra base real con el payload de la pantalla (regla 13).
- **`[PQ.150]`** 🧪 **C0 — La factura ligada a su aplicación** (§3.10). **Primer tramo (2026-11-25):**
  `commercial.v_supplier_invoice_application` (derivada, `security_invoker`) con tres llaves —RFC + folio
  de la referencia, folio + total, RFC + total— y su copia por costo `analytics.mv_supplier_invoice_application`
  (cada hora, `AnalyticsRefreshService`); mig `20261125090951`. `kdm1.c22` se descartó medido (copia de
  `kdxd.c10`). Cierre medido: **553 → 962 de 1,938 aplicaciones (28.5 % → 49.6 %; dinero 41 % → 77 %)**,
  las llaves concuerdan 458 de 458, testigo por renglón contra placebo. **Segundo tramo** 🧪 (2026-11-27, `[PQ.150.2]`, mig
  `20261126232411`): la historia de `[PQ.148]` lee la matvista y aprende sólo de pares con el total igual, y
  Recepción busca alias e historia con el RFC de la factura primero y el de Kepler después (Kepler no tiene RFC
  en 947 pares y tiene otro en 814), y aprende bajo el de la factura. Cierre medido con el SQL real:
  equivalencias 1,547 → 2,539 con el mismo acierto (99.7 %, placebo 0 %); renglones con propuesta **39.4 % → 57.1 %**.
- **`[PQ.151]`** ⬜ **C3 — Emparejar la factura con la OC (escalón A: Compras).** La pantalla propone por
  código, descripción y cantidad × factor; la persona confirma. Las cinco preguntas de `diseno` §0b por
  escrito. Cierre: avisos del piloto en 30 días y renglones propuestos que se aceptaron sin cambio.
- **`[PQ.152]`** ⬜ **C2–C3 — La OC dice pedido · en camino · por surtir** en `/compras/oc-abiertas`, con
  la factura de cada parte. Cierre: lo «por surtir» del piloto visto antes del camión.
- **`[PQ.153]`** ⬜ **C3 — El Andén recibe por factura** (QR del CFDI → el aviso), en nuestra unidad; se
  une con `[PQ.112.5]` y, con `[PQ.112.4]`, cerrar escribe un vale por factura (DP6).
- **`[PQ.154]`** ⚠️ DP1 — **C2–C3 — El proveedor entra a la Suite (escalón B).** Rol `proveedor`, alcance
  por RFC, sólo sus OC y avisos; alta y baja de cuentas con dueño. ADR al firmar DP1.
- **`[PQ.155]`** ⚠️ DP1 — **C1–C3 — La lista de precios del proveedor vive en la Suite** (DP4, Francisco
  2026-11-24): la mantiene el proveedor por su código (equivalencia de `[PQ.148]`), con vigencia; cada
  cambio es una solicitud que autoriza el comprador, con quién y cuándo. Arranca precargada con lo que ya
  sabemos (último costo aplicado) para que él la confirme. Es la referencia de `[PQ.157]`: costo de
  factura fuera de la lista autorizada = cambio no anunciado. Cierre: proveedores del piloto con lista
  confirmada, y renglones aplicados fuera de lista antes/después. **Dónde vive:** Compras › Proveedores ›
  «Listas de precios» (DC32 del anexo C, 2026-11-24), no en Catálogo, donde hoy sólo hay un marcador vacío.
- **`[PQ.156]`** ⚠️ DP7 — **C1–C3 — La cita.** Ventanas por sucursal que abre el almacén; el proveedor (o
  Compras, en el respaldo de DP1) elige fecha y ventana al confirmar sus facturas; el Andén ve su día
  por hora. Cierre: citas del piloto cumplidas en su ventana, y OC «a la medida de la factura» y vales
  rehechos de esos proveedores, antes/después (HOY en 90 días: 1,306 y 78 en toda la empresa, §3.8).

## 8. Riesgos y bloqueos

| Bloqueo | Dueño | Causa | Qué lo destraba |
|---|---|---|---|
| DP1–DP6 sin firma | Edgar | abrir la Suite a externos; reglas del aviso | este anexo |
| El vale escrito por la Suite | Edgar | DR1 y DR5 del anexo R | anexo R |
| La factura llega a la Suite ~1 día después del timbrado | — | el carril `contpaqi_add` | escalón B (el proveedor sube su XML) |
| 59 % de aplicaciones sin RFC del acreedor en `kdxd` (medido el 2026-11-25; `kdm1.c22` es su copia) | Compras (captura del acreedor en Kepler) | el alta del acreedor no lo exige | `[PQ.150]` liga por el folio sin RFC; Recepción busca alias e historia con el RFC de la factura (`[PQ.150.2]` 🧪). Medido el 2026-11-27: en los pares de total igual, 947 sin RFC en Kepler y 814 con OTRO; 42.1 % de las entradas de 30 días llegan sin RFC al espejo |
| CL005 no sigue la forma del resto | — | facturas de miles de renglones | se trata aparte; no entra al piloto |

## 9. Definición de terminado (método §5)

- [ ] C0 con árbitro: equivalencias (con su placebo) y liga factura ↔ aplicación, publicados aquí.
- [ ] DP1–DP6 firmadas, con quién y cuándo.
- [ ] El aviso probado contra base real con el payload de la pantalla (regla 13).
- [ ] Permiso repartido en prod (regla 20) y matriz de accesos regenerada; en el escalón B, el rol
      `proveedor` con su alcance probado con un proveedor que **no** debe ver otro.
- [ ] Métrica principal medida antes y después en el piloto.
- [ ] Tracker, log y ADR (DP1).

## 10. Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
| 2026-11-24 | **`[PQ.148]` 🧪** (segundo tramo, en local): lo aprendido de la historia es una **vista**, no una copia (regla 1): `commercial.v_supplier_item_code_history` (mig `20261124231441`, `security_invoker`), con el método de §3.2 —factura ↔ aplicación `X-A-20` uno a uno en los dos sentidos, renglón ↔ renglón por importe ±0.5 % uno a uno— y las guardas del primer tramo. Hoy: 1,494 equivalencias de 60 proveedores (desde 2025-10-27), 1,396 estables; de las vistas en 2+ facturas, 851 de 949 siempre en el mismo SKU (en un año cambia más que en 60 días: las demás no proponen solas, van a revisión). El motor la usa **al último**: lo confirmado (código, descripción) y el código de barras van antes, y su producto tiene que venir en la entrada; la pantalla lo rotula «Historial», sin negrita, y al dar por buena la factura pasa a confirmado. **Cierre medido** (prod, sólo lectura, aprende de lo anterior al 25-oct y prueba los 30 días siguientes): acierta 1,054 de 1,058 (99.6 %) contra 0 de 1,025 del placebo; renglones de factura con propuesta (366 facturas, sin CL005) **654 → 1,899 de 2,797 (23.4 % → 67.9 %)**, 74.5 % con la vista de hoy. Costo: la vista entera 4 s y un proveedor 0.4–1 s; tardaba 16 s hasta que la condición de fecha dejó de llevar `AT TIME ZONE` (con RLS, una función no *leakproof* no entra al índice). Pruebas: motor 44/44 con 5 mutantes en rojo; `test-newdb-pq148-code-history` 27/0/0 (casos armados con `VALUES`, 6 mutantes de la vista en rojo, el control contra Kepler en prod); la migración sube, se repite, baja y vuelve a subir contra Postgres real | Claude |
| 2026-11-24 | **`[PQ.148]` 🧪** (primer tramo, en local): `commercial.supplier_item_aliases` gana `codigo_proveedor` (mig `20261124210829`, columna + índice único por proveedor y código); el motor de Recepción empareja primero por código y cae a la descripción si ese producto no vino; se aprende con código salvo los de 1–2 caracteres (número de renglón) y los repetidos en la factura (medido: 98 % de los pares proveedor-código tienen una sola descripción). Probado: 39/39 del motor con 4 mutantes en rojo y 6/6 contra Postgres real como `app_runtime` con 3 negativas en rojo. De paso apareció `AUD-CI.1`: la prueba de RE.53 contra base real nunca corrió en el CI. Falta lo aprendido de la historia (como vista, regla 1) | Claude |
| 2026-11-25 | **`[PQ.150]` 🧪** (primer tramo, en local): la factura ligada a su aplicación es la vista `commercial.v_supplier_invoice_application` y su matvista por costo (mig `20261125090951`, refresco cada hora). Tres llaves, uno a uno: RFC + folio de la referencia, folio + total (el acreedor sin RFC: 59 % de las aplicaciones), RFC + total. **553 → 962 de 1,938 aplicaciones de 60 días (dinero 41 % → 77 %)**; las llaves concuerdan 458 de 458; testigo por renglón 75–93 % contra 2–9 % del placebo (§3.10). Control con respuesta conocida: la vista y una medición que usa las funciones TS de Recepción dan las mismas 962 ligas, par por par. Hallazgos: dos proveedores con la aplicación 3–9 % abajo de su factura en 69 aplicaciones (va a `[PQ.157]`); la historia de PQ.148 **no** puede aprender de las ligas de total distinto (la cobertura bajaría de 60.0 % a 49.3 %), así que filtra; Recepción busca alias e historia sólo por el RFC de Kepler. Pruebas: `test-newdb-pq150-invoice-application` 34/0/1 contra prod en sólo lectura y 29/0/1 en Postgres local (TS ≡ SQL en 33 mil valores reales, 18 casos armados, 7 mutantes en rojo); la migración sube, se repite, refresca con `CONCURRENTLY`, baja y vuelve a subir contra Postgres real, y su compuerta se niega con 5,000 aplicaciones y cero pares | Claude |
| 2026-11-27 | **`[PQ.150.2]` 🧪** (segundo tramo, en local): la historia de PQ.148 toma sus pares de la liga de PQ.150 (matvista, sólo total igual; mig `20261126232411`) y Recepción busca alias e historia con el RFC de la factura primero y el de Kepler después, y aprende bajo el de la factura. El plan decía «cuando Kepler no lo tiene»; medido antes de escribir, Kepler trae OTRO RFC en 814 de 4,235 pares (y ninguno en 947), así que se busca con los dos. Cierre medido con el SQL real contra el de PQ.148 (aprende antes de hace 30 días, prueba los 30 siguientes): **1,547 → 2,539 equivalencias**, 61 → 133 proveedores, acierto 99.7 % → 99.7 % (placebo 0 de 1,592), un proveedor 525–1,030 ms → 137–398 ms, renglones con propuesta **39.4 % → 57.1 %**. Pruebas: la cadena liga → historia sobre VALUES 32/0/0 con 7 mutantes en rojo y el control de PQ.148; la cañería de Recepción de punta a punta; los dos RFC contra Postgres real como `app_runtime`; 8 mutantes de Recepción en rojo; la migración up/up/down/up y su compuerta en rojo con la matvista vacía | Claude |
| 2026-11-24 | Francisco responde las decisiones de Compras: DP2 (a), DP3 sí, DP5 la 08, DP6 sí, DP7 ventanas del encargado de almacén y sin cita a la fila; **DP4: la lista de precios vive en la Suite, la mantiene el proveedor y cada cambio lo autoriza el comprador** (`[PQ.155]` reescrito). Falta que Edgar las ratifique y decida DP1 | Claude |
| 2026-11-24 | Francisco: el vale ES la cita; la orden de entrada es rastrillar en vivo; la aplicación valida el costo (anexo R §3c, DR7, `[PQ.157]`). Sin cita se recibe, en la fila (DP7, falta ratificar). El paso 6 pasa a «el vale se escribe al confirmar la cita» | Claude |
| 2026-11-24 | Francisco trae lo que dicen los proveedores: el sector ya pide **la cita** (el proveedor empareja al sacarla). Se valida lo que pidió (§3.8): **vales borrados y rehechos, confirmado** (78 de 221 cancelados tienen vale nuevo de la misma OC en ±1 día; placebo 5.9 %; Compras cancela el 45 %); **OC achicadas editándolas, no** (855 de 858 OC iguales a su requisición); **OC nuevas por factura, sí y es la regla**: 1,306 de 1,618 OC sin requisición se capturan el mismo día que su vale (control: Kepler no reescribe la fecha al recibir, 155 de 157). Nacen la cita (PQ.156), DP7, y DP1 pasa a recomendar la cuenta del proveedor como destino | Claude |
| 2026-11-24 | Anexo P a pedido de Francisco: el proveedor empareja su factura con nuestra OC y el vale llega hecho; el catálogo del proveedor se aprende de sus facturas. Medido: el código del proveedor viene en casi todos los renglones; 1,198 equivalencias aprendibles de 60 días, estables 98.5 % contra 3.7 % del placebo, factor estable 95 %; la factura se timbra mediana 50.5 h antes del vale y la Suite la tiene 24.8 h después del timbrado; 15.6 % de los renglones de OC no se surten; sólo 24 % de los vales lleva el folio de su factura; una aplicación no junta varias facturas (igual al placebo). Nacen PQ.148–PQ.155 y DP1–DP6, sin firma | Claude |
