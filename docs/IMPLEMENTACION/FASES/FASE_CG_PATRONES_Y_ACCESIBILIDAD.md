# Investigación — Los patrones del efectivo, y qué le falta a la pantalla que lo captura

> **Escrito para:** Edgar, quien tome el backend de Caja General, y `27` (frontend de
> `/finanzas/caja-general`).
>
> **Estado:** investigación y **contrato acordado**, sin código. Medido contra **producción en
> lectura** el 2026-10-14 (`system_identifier 7688376744939610156`).
>
> **Fuente principal: el ODS de Kepler** (`analytics.kepler_bank_movements` donde
> `account_label='CG'`, derivada de `kepler_ods.kdm1 ⋈ kdb1`). Es **otra fuente y otro grano** que
> el de [`FASE_CG_CIRCUITO_DEL_EFECTIVO`](FASE_CG_CIRCUITO_DEL_EFECTIVO.md), que midió contra el
> espejo del Access. Los dos coinciden donde se tocan (§4.1) y este documento contesta la pregunta
> que aquél dejó abierta en su §13: *«nadie está atando los dos mundos»*.
>
> **Qué lo disparó:** *«necesito que `/finanzas/caja-general` muestre los movimientos correctos que
> salen de caja general… audita si nuestra forma de trabajar actual es la correcta»*, y después
> *«encontremos esos patrones de lo que se paga y de lo que se ingresa… estructurarlo por capas»*.

---

## 1. Las respuestas en una línea

1. **La forma de trabajar es correcta y la fuente verdadera existe.** Lo que está mal es qué
   publica la pantalla: su libro es **el 5.2 % de los movimientos y el 7.8 % del dinero**, y el
   encabezado suma ese porcentaje sin declarar su denominador.
2. **Lo que se paga tiene dos poblaciones**, no una: el **dinero** está en 160 proveedores
   (79.6 %) y el **trabajo** está en 24 conceptos (62 % de los pagos).
3. **Lo que se ingresa es una sola cosa**: la venta de ruta, y es efectivo en el **99.7 %**.
4. **Casar un depósito contra una venta por su importe es imposible por construcción**, y eso —no
   el gusto— es lo que obliga a que la liga se declare eligiendo de una lista.

---

## 2. Lo que la pantalla publica hoy

`/finanzas/caja-general` («Caja (captura)») publica `finance.cash_ledger`: lo que una persona
tecleó. Los KPIs del encabezado se calculan **sólo** sobre eso
([`cash-ledger.service.ts:2238`](../../../libs/finance/src/lib/caja/cash-ledger.service.ts)).

| ventana | capturados | por confirmar | cobertura |
|---|---|---|---|
| mes en curso (01–14 oct) | 69 | 507 | **12.0 %** |
| 30 días fijos | 71 | 1,243 | 5.4 % |
| ventana de la cola (45 d) | 71 | 1,916 | 3.6 % |
| un solo día (08-oct) | 1 | 33 | 2.9 % |

⭐ **Un porcentaje de cobertura no se publica nunca sin su ventana al lado.** El numerador casi no
se mueve (69 → 71) y la cobertura va de **12.0 % a 2.9 %**. Una ventana fija no se equivoca un
poco: se equivoca cuatro veces, y en silencio.

⛔ **`finance.v_caja_cobertura` NO sirve de denominador.** Sus tres columnas
(`movimientos`/`anclados`/`capturados`) son **las tres sobre el libro propio**: mide anclaje de lo
capturado, no capturado ÷ universo. Pintarla como «cobertura» es el numerador midiéndose contra sí
mismo.

⚠️ Y el defecto es más sutil de lo que parece: **la pantalla SÍ declara el rezago, pero en la
COLA** (*«Quedan 13,185 movimientos anteriores a esta ventana, por $161,428,479»*), no en el KPI.
Las dos afirmaciones conviven y **ninguna contradice a la otra en voz alta** — por eso nadie la vio.
El rótulo del encabezado («El libro, del X al Y») **no miente**; lo que falta es que el agregado
declare su denominador.

---

## 3. El caso que lo disparó, de punta a punta

Tres cosas en la mano y nada que las una:

| | |
|---|---|
| Papel | Kepler «Venta Diario», Morelia Madero, caja 4, apertura 29, 08-oct, **$41,333.04** |
| Caja fuerte | CAOS `external_id 1595`, 13-oct 17:45, **$36,440.00**, ref `RV24416\RV321-16531` |
| Lápiz | dos ventas vecinales: **$16,530.83** y **$24,418.16** |

El papel **sí está en la base** (`analytics.cash_cuts`, cuadra al centavo). El reparto a mano
también: `384.05 + 16,530.83 + 24,418.16 = 41,333.04`.

| lo que se buscaba | lo que hay |
|---|---|
| fiscal $384.05 | ✅ `U-A-5` folio 56, suc 07, 10-oct — pero a **BBVA 4176**, no a caja |
| $16,530.**83** | ⚠️ `U-A-5` folio 57 por **$16,530.38** — Δ $0.45 |
| $24,418.16 | ⛔ **no existe**, buscado en todo `kdm1`, 1–20 oct, todas las sucursales, ±$20 |

Residual del corte sin documento: **$24,418.61**.

⛔ **Y acá hay que ser preciso, porque la primera versión de este documento dijo «faltan».** El
depósito ($36,440) no cuadra contra la venta no fiscal ($40,948.99) por **$4,508.99**, pero
**un depósito NUNCA puede igualar a una venta**: CAOS no recibe monedas. Lo señaló
`trade-marketing-e136` y se midió el tamaño con una fuente que ninguna de las dos sesiones estaba
usando — **el arqueo del POS, que sí separa billetes de monedas**:

| `analytics.cash_cuts`, desde 2026-09-01 | |
|---|---|
| arqueo_billetes | $10,205,798.09 |
| arqueo_monedas | $806,511.66 |
| **monedas = % del efectivo contado** | **7.32 %** |

El caso es 11.0 % sobre la venta. ⇒ **~$2,989 (7.3 %) son morralla al ritmo medido; ~$1,520 no
tienen explicación.** La redacción correcta no es «faltan $4,508.99» ni «no falta nada».

⚠️ `finance.cash_ledger.morralla` **no sirve** para esto todavía: 72 movimientos, 0.04 %, con un
único outlier de 33.96 %.

### 3.1 ⭐ El hallazgo de fondo: Morelia captura distinto

Cobros de efectivo a CAJA GENERAL, octubre:

| sucursal | cobros | **por ruta y fecha** | como bulto del día |
|---|---|---|---|
| 00 Oficinas | 34 | **31** | 0 |
| 01 Padre Hidalgo | 10 | **8** | 0 |
| **07 Morelia Madero** | 13 | **0** | **13** |
| **08 Morelia Abastos** | 3 | **0** | **3** |

Padre Hidalgo registra *«VENTA RV CANDY SALGADO 25-09-2026»* — ruta y día. Morelia registra
*«DEPOSITO EFECTIVO CAJA GENERAL M.M. 08/10/2026»* — un bulto. **Por eso Candy y Rafa son
rastreables y Joscah y Guillermo no.** No es el sistema: es la práctica de captura de esa plaza.

---

## 4. Por qué no concilia: tres granos y ninguna llave

1. **CAOS no recibe monedas.** Medido: **749 de 749** depósitos sin centavos, los 749 múltiplos de
   10. Una venta con centavos **no puede** igualar a un depósito sin centavos. **Casar por monto es
   imposible por construcción.**
2. **La única declaración humana es texto libre.** **708 referencias distintas en 749 depósitos**,
   cero en formato parseable. La misma ruta 21: `ruta 21 09 26`, `rd 21 04/07`, `ruta 21 13 10 26`.
3. **El cobro de Kepler es un agregado del día por cuenta de tesorería**, no por corte ni por ruta.
4. **El motor que debía unirlos está vacío**: `finance.caos_ingreso_atribucion` tiene **0 filas,
   nunca calculó**, contra 749 depósitos / **$18,360,140** desde el 27-may. Los únicos enlaces son
   **7**, hechos a mano el 12 y 13 de octubre.

⇒ **La liga la declara la persona en el momento, eligiendo de una lista.** No se puede reconstruir
después. Es el requisito duro del que cuelga todo el diseño.

### 4.1 Dónde se tocan las dos fuentes

De junio a septiembre el espejo del Access y el ODS de Kepler son **el mismo dinero día a día**: en
septiembre **24 de 25 días difieren menos de $5**. Lo que Kepler no trae, declarado: la clase
«Abono a Deuda / Nómina-Pagarés», **$40,794 en 40 días**. Y **enero–mayo sí difieren de verdad**
(enero Δ $1.78M, en ambas direcciones).

---

## 5. Lo que se PAGA, por capas — 90 días, $21.57 M en 3,127 pagos

### Capa 0 · el documento

`X-D-26` concentra el **96 % del dinero**. El resto: `X-D-60` anticipo ($837 k), `N-A-26` traspaso
($59 k). ⇒ **el patrón no está en el tipo de documento.**

### Capa 1 · a quién se le paga — el campo está SOBRECARGADO

| | nombres | pagos | monto | % dinero | % pagos |
|---|---|---|---|---|---|
| proveedor o persona | 160 | 1,193 | $17,165,328 | **79.6 %** | 38 % |
| concepto disfrazado de beneficiario | 24 | 1,934 | $4,402,780 | 20.4 % | **62 %** |

⭐ **El dinero está en los proveedores; el trabajo está en los conceptos.** Dos poblaciones, dos
tratamientos, hoy en el mismo campo de texto libre.

### Capa 2 · el concepto — 5 familias × un destino

Los 24 son **caja chica** (13 variantes, una por plaza), **nómina**, **comisiones**, **viáticos**,
**gastos generales**. Es **el mismo defecto del catálogo de 122 cuentas del Access** —concepto y
plaza fundidos en una sola cadena— reproducido en texto libre.

⛔ Y la prueba de que es texto libre y no catálogo: **«CAJA CHIICA» mal escrito parte el concepto
en dos.** 7 grafías correctas (758 pagos, $655,508) contra 6 mal escritas (234 pagos, $269,340).
Un concepto, 13 cadenas, **$924,847**.

### Capa 3 · recurrencia

Los recurrentes vuelven cada **2.4 a 6.9 días**. El coeficiente de variación del importe los parte:

- **cv > 1** (caja chica, nómina, comisiones, gastos generales) → importe variable: **no se puede
  proponer monto**.
- **cv < 0.5** (Capitán de Marca 0.39, Fernando Gutiérrez 0.38, Botanas Pau 0.41, Cueritos Premium
  0.50) → importe estable: **sí**.

---

## 6. Lo que se INGRESA — 90 días, $19.78 M en 1,108 cobros

| patrón | cobros | monto | plazas |
|---|---|---|---|
| venta de ruta (RD/RV) | 975 | $17,260,811 | **2** |
| otro | 117 | $2,312,999 | 3 |
| depósito agregado del día | 16 | $206,524 | 2 |

**El ingreso es una sola cosa.** Mucho más simple que el egreso — pero sólo 2 plazas lo declaran
así: es el `0 de 16` de Morelia (§3.1) visto desde el otro lado.

---

## 7. La regla del efectivo, medida

### 7.1 ⛔ `c31` no discrimina efectivo de banco

| | pagos | método (`c31`) |
|---|---|---|
| `X-D-26` desde **caja general** | 3,127 | `Tra` en el **100 %** |
| `X-D-26` desde **bancos** | 5,552 | `Tra` en el **100 %** |

Lo que declara el efectivo es la **cuenta de tesorería** (`c45 = 0011 CAJA GENERAL / EFECTIVO`).
⇒ **Elegir la cuenta ES declarar el efectivo**; no hace falta un campo nuevo ni una casilla.

### 7.2 ✅ «Todos los ingresos de ruta son en efectivo»: confirmado, 99.7 %

| | docs | monto | % |
|---|---|---|---|
| **caja general** | **975** | **$17,260,811** | **99.7** |
| bancos (Bajío, Santander, Banorte) | 11 | $43,870 | 0.3 |
| devoluciones | 1 | $965 | 0.0 |

Y el contraste lo vuelve útil: de **toda** la cobranza sólo el **16.7 %** es efectivo; de la de
**ruta**, el 99.7 %. ⇒ *«ruta ⇒ efectivo»* es regla confiable; *«cobranza ⇒ efectivo»* no lo es.
**La cuenta se deriva, no se pregunta**, con 12 excepciones declaradas.

### 7.3 ✅ «Ciertos proveedores que sabemos que se pagan en efectivo»: se deriva de la historia

| | beneficiarios | pagos | monto |
|---|---|---|---|
| sólo efectivo | 158 | 2,158 | $18,472,946 |
| sólo banco | 243 | 4,894 | $112,402,232 |
| mixto | 26 | 1,627 | $9,061,576 |

**La regla: soporte ≥ 5 pagos y cuota de efectivo ≥ 90 %.**

| veredicto | beneficiarios | pagos | monto | % del efectivo |
|---|---|---|---|---|
| **propone EFECTIVO** | 71 | 2,412 | $15,275,831 | **70.8 %** |
| sin soporte (poca historia) | 299 | 188 | $3,913,033 | 18.1 % |
| empate: lo decide la persona | 12 | 505 | $2,347,495 | 10.9 % |
| propone BANCO | 45 | 22 | $31,749 | 0.1 % |

⭐ **Por qué proporción y no binaria.** La regla binaria («cualquier pago por banco lo vuelve
ambiguo») resuelve 1,987 pagos; la de proporción, **2,412 — 425 más**. El caso que lo explica:
`GASTOS GENERALES CAJA CHICA MORELIA ABASTOS` tiene **412 pagos en efectivo contra 1 por banco**;
la binaria lo mandaría a decisión manual **las 412 veces** por un outlier de $400.

⚠️ El umbral (5 pagos, 90 %) es **un parámetro con estado**, no una constante: se registra, se mide
su tasa de corrección y se ajusta.

---

## 8. Accesibilidad: lo que pidió Edgar, medido

> *«los que vayan saliendo por websocket… que se cargue del 5 de octubre para acá… sólo los que
> normalmente se pagan en efectivo… un buscador tipo Elasticsearch… cero procesos manuales».*

### 8.1 La ventana del 5-oct

| | filas | monto |
|---|---|---|
| ventana real 05-oct → hoy | **383** | $2,615,380 |
| ⛔ **fechas futuras (mal fechados)** | **7** | $50,796 |

Cortar en el 5-oct saca **12,929 filas de rezago** de las 13,319 de la cola. ⚠️ Pero la ventana
**necesita tope superior**: sin él entran los mal fechados de diciembre. Van **contados aparte, no
escondidos** — alguien tiene que corregirlos en Kepler (patrón `[CG.28]`).

⭐ Y una precisión: dentro de esa ventana el rezago de captura es de **1.1 días de promedio, máximo
5**. El desfase grande **no es de captura: es el backlog.**

### 8.2 Con la regla de efectivo aplicada

| | filas |
|---|---|
| ingresos de ruta (siempre efectivo) | 60 |
| gastos que caen en la regla | 262 |
| **se muestran** | **322** |
| gastos fuera de la regla | 68 |

### 8.3 ⛔ Elasticsearch: medido, y no aporta

Búsqueda multi-campo en Postgres, **sin índice y con `ILIKE '%texto%'` puro**:

| universo | tiempo |
|---|---|
| ventana de trabajo (390 filas) | **1.4 – 9.5 ms** |
| cola completa (13,319 filas) | **7.6 – 26.4 ms** |

⭐ Y hay algo más rápido que cualquier servidor: **322 filas caben en el navegador**. Un índice en
memoria busca en **0 ms y sin red** — es el patrón que ya usa el verificador de precios con su
snapshot en IndexedDB. Para ir más atrás, cae al servidor: 26 ms.

⇒ Elasticsearch resuelve sub-100 ms sobre millones de documentos. Acá hay 13 mil. **Sería
infraestructura sin un problema que la justifique.**

### 8.4 El WebSocket ya está construido

[`caja.gateway.ts`](../../../libs/finance/src/lib/caja/caja.gateway.ts): namespace `/caja`, JWT en
el handshake, salas por tenant, rechazo de token inválido. **Hoy sólo lleva el flujo de firma
remota (`firma:*`).** No hay que construir el canal — hay que emitir el evento. Y el disparador
existe: `analytics.mv_caja_movimientos` se refresca cada ~1 min (medido: 13 s). **El navegador no
pregunta nunca.**

---

## 9. El contrato `CajaCobertura` — acordado con `27` el 2026-10-14

Negociado y **firmado por las dos sesiones** (datos y frontend). Vive en `libs/contracts`.

```ts
import type { Freshness } from '@megadulces/contracts';

export type CajaCoberturaEstado = 'medida' | 'no_corresponde' | 'sin_medir';

export interface CajaCobertura {
  estado: CajaCoberturaEstado;
  /** Las DOS cifras pertenecen a esta ventana. Nunca se publica una sin ella. */
  ventana: { from: string; to: string };
  capturado: { movimientos: number; monto: number };
  /** null salvo con estado 'medida'. NUNCA 0 para decir "no sé": el universo por
   *  confirmar no tiene dueño, y un 0 publicaría 100 % de cobertura falsa. */
  por_confirmar: { movimientos: number; monto: number } | null;
  /** De cuándo es el DENOMINADOR. Peor de: carril ODS + refresh del matview. */
  frescura: Freshness;
  motivo:
    | { tipo: 'filtro'; filtros: Array<'cuenta' | 'search' | 'mios'>; texto: string }
    | { tipo: 'fallo'; texto: string }
    | null;
}
```

| estado | `por_confirmar` | `motivo` |
|---|---|---|
| `medida` | `{…}` | `null` |
| `no_corresponde` | `null` | `{tipo:'filtro', filtros:[todos los activos], texto}` |
| `sin_medir` | `null` | `{tipo:'fallo', texto}` |

**Reglas que el contrato hace cumplir:**

- **Tres ausencias, tres etiquetas.** `no_corresponde` (la persona filtró y no hay con qué
  comparar) ≠ `sin_medir` (el cálculo falló o el carril viene atrasado). Con dos valores, el día
  que el cálculo falle el servidor lo disfraza — es el defecto de `[CG.181]`, el 429 publicado como
  «0 corte(s)».
- **Filtros compatibles**: `from`/`to`, `tipo` (igualdad), `sucursal` (**normalizada**).
  **Incompatibles**: `cuenta`, `search`, `mios` → `no_corresponde`. `filtros` en orden fijo
  (cuenta → search → mios) y lista **todos** los activos.
- ⛔ **`sucursal` se normaliza con `split_part(sucursal,'-',1)` en LOS DOS lados.** La cola trae
  códigos compuestos (`01-001`…`01-005`, nacidos del corte del 1-oct) que el libro no tiene:
  filtrar por igualdad en Padre Hidalgo publica **29 movimientos y $527,631.59 menos de rezago del
  que hay — el 40.5 %**, y el renglón se ve sano.
- **Todo `monto` es `number` de verdad**: `::numeric` en SQL, `n()` + `r2()` en el map. ⛔ **No
  `::float8`**: es dinero, y el punto flotante en el borde del servidor es justo lo que esta fase
  existe para evitar. ⚠️ Hoy el tipo **miente**: el repo no fija `setTypeParser` (verificado, y ya
  documentado en tres archivos), así que `kpi.ingresos` llega como **string** y la pantalla
  sobrevive porque `money()` hace `Number(v||0)`.
- **La frescura viaja como `Freshness`**, el tipo canónico, no como un `as_of` suelto — un
  timestamp no puede decir «no sé». Se compone de **dos piernas y gana la peor**: el carril del ODS
  y el refresh del matview. Un matview fresco sobre un ODS parado es verde falso. Este archivo ya
  fue corregido por esto en `[CG.141.1]`.
- **Si la frescura es `stale`/`unknown` → `sin_medir`.** La regla vive en el servidor, no en una
  píldora de la pantalla.
- **El candado** prueba **las dos puntas**, se conecta con `SET ROLE app_runtime`, usa una fila de
  sucursal compuesta **de cada lado**, y tiene prueba negativa en los tres estados.

---

## 10. Lo que YA está construido y no hay que rehacer

| pieza | dónde | estado |
|---|---|---|
| Carril vivo del Access | `caja_general_ods.{doctos,cuenta,arqueo_movimientos}` | **117,641 filas, 2008 → 2026-10-10**; corrió hace 21 s |
| El espejo | `analytics.caja_general_*` | **son VISTAS** derive-no-copy (mig `20260918240000`) |
| Motor de autollenado | `caja-autofill.engine.ts` | puro, con `source` + `confidence` + `NoProposalReason` |
| Canal realtime | `caja.gateway.ts` | namespace `/caja`, JWT, salas por tenant |
| Cola de pendientes | `finance.v_caja_movimientos_pendientes` | 13,319 filas / $162.5 M |
| Cortes POS | `analytics.cash_cuts` + `GET /finance/cortes-sucursales` | **fuera** de la zona congelada |

⚠️ **El importer del Access NO existe desde el 2026-09-18** (`[CG.9h]`): `import-caja-general.js` y
`extract-mdb.ps1` **se borraron**. Lo que corre es el par
`replicate-caja-general-live.js` → `ship-caja-general.js`.

---

## 11. Refutaciones — lo que NO hay que hacer

1. ⛔ **No relajar el anti-réplica de `kepler_bank_movements`.** Los `c1` compuestos (`01-001`…)
   parecen filas perdidas ($118 k), pero el control de duplicados lo refuta: con
   `split_part(c1,'-',1)=sucursal` salen **52,548 filas para 52,542 llaves únicas**. Esos
   documentos **ya entran por la otra pierna** de la vista. Relajarlo **duplicaría** $118 k.
2. ⛔ **No usar `catalog.suppliers` como árbitro de «proveedor vs concepto».** El padrón contiene
   **24 filas que son conceptos** (NOMINA, BONOS AUTORIZADOS, CAPITÁN DE MARCA, MANIOBRAS Y
   DESCARGAS…). Pedirle que distinga lo que tiene adentro da 80.6 % de falso acierto. *Un árbitro
   que nunca contradice es un espejo.*
3. ⛔ **No fusionar el libro con la cola en una sola lista.** Rompe `[CG.59]`/`[CG.60]` (decisión de
   Edgar: *«el 90 % de la pantalla deben ser ESTOS DOS APARTADOS»*) y le mete **13,185 renglones de
   rezago** a quien lleva dos días con la herramienta. No es un problema de velocidad: el libro
   unificado cuesta **3.3–9.6 ms**.
4. ⛔ **No montar Elasticsearch** (§8.3).
5. ⛔ **No poner el hueco de pesos en el bloque del arqueo.** Ahí vive *esperado vs contado*; los
   $4,508.99 son *vendido vs depositado*. Dos pares bajo un rótulo ya costó una vez (`[CG.112]`).
6. ⛔ **No casar depósito contra cobro por monto + fecha.** Medido por `trade-marketing-e136` sobre
   los **551 depósitos que SÍ declaran fecha**, escondiendo la respuesta y buscando por importe con
   tolerancia de $200: **195 aciertos · 28 ERRORES · 297 sin candidato**. Un pareo que se equivoca
   en 28 de 223 sobre dinero es inaceptable, y los 297 dicen que además no cubre. Es el control de
   placebo que convierte «es imposible por construcción» (§4.1) en una cifra.

---

## 12. Correcciones a lo que este mismo documento afirmó antes

- **«El importer manual es redundante»** → **falso: ya no existe**, se borró el 2026-09-18. Lo
  deduje del renglón comentado en el runner y de un `computed_at` quieto, y leí un componente
  retirado como vivo. El `computed_at` se quedó en el 10-oct porque **la fuente murió**, no porque
  el carril fallara.
- **«El 5.2 % / 7.8 % de cobertura»** → es de **30 días fijos**. En la ventana por default de la
  pantalla (mes en curso) es **12.0 % / 17.8 %**.
- **«80.6 % de los pagos son a proveedores del padrón»** → el padrón está contaminado (§11.2). La
  cifra buena (79.6 %) sale de clasificar por la forma del nombre y **es heurística**.

---

## 13. Huecos abiertos, con nombre

| hueco | monto / tamaño | dueño |
|---|---|---|
| El cobro de $24,418.61 del corte 07/4/29 nunca se capturó | $24,418.61 | operación |
| Δ entre el papel y Kepler en el folio 57 | $0.45 | operación |
| Vendido vs depositado (CAOS 1595), **neto de morralla** | **~$1,520** | operación |
| El depósito de caja fuerte casi nunca se captura | **18 de 749 (2.4 %)** | adopción |
| Morelia no declara ruta **por ningún lado**: ni el cobro ni el texto del depósito | 16 de 16 cobros | operación |
| El `.mdb` de Caja General no se escribe desde el 10-oct | la fuente del carril | decisión |
| `ods_publish_tienda` lleva 11 días en `error` | ajeno a esta fase | sistemas |
| 24 filas de `catalog.suppliers` son conceptos | catálogo compartido | datos |
| El backend de caja **no tiene dueño** | — | Edgar |

---

## 14. Cómo se midió (para que se pueda repetir)

Todo **read-only** contra `pg-prod` en `md`, verificando identidad por `system_identifier` y
**nunca** por el nombre de la base:

```bash
ssh superoot@192.168.0.222
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
POD=$(k3s kubectl -n prod get pods -l app=pg-prod --field-selector=status.phase=Running \
      -o jsonpath='{.items[0].metadata.name}')
k3s kubectl -n prod exec -i $POD -- psql -U postgres -d railway < consulta.sql
```

⚠️ Las vistas de `finance.*` filtran por `current_tenant_id()`: sin
`set_config('app.tenant_id', …)` devuelven **0 filas**, que se lee como «no hay nada».

⚠️ Para comprobar un permiso, conectarse **con el rol de producción**: `app_runtime` tiene `SELECT`
sobre `caja_general_ods.doctos` y **no** tiene `USAGE` sobre su schema, y desde `postgres`, `edgar`
o `dev_ro` el schema **se ve sano**. `to_regclass()` consulta el catálogo y no necesita `USAGE`, así
que la guarda de existencia da verde y la lectura revienta la línea siguiente (es el 500 de
`cortes/fondo-sugerido`). Mismo patrón que `[CP.8.44]`.
