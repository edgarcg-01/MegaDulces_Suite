# Anexo LE · Rediseño de `/finanzas/caja-general/cuadre` — los 12 pasos antes de la interfaz

> Anexo de la fase **LE** (Libro de efectivo, 🔨, absorbió a CGA el 2026-10-27). No abre fase
> nueva ni ocupa cupo. Pedido de Edgar (2026-11-04): *«necesito que rediseñemos
> /caja-general/cuadre con lo que ahora sabemos»*. Lo que «ahora sabemos» está medido en
> [`VERDAD_ABSOLUTA.md` §36](../../VERDAD_ABSOLUTA.md) y es la base de cada paso.
>
> Skill `diseno` §0a (los 12 pasos, por escrito) y §0b (las cinco preguntas). **Nivel C: sin
> validación visual**, es una propuesta.

---

## Paso 1 · El propósito: qué ACTO cierra esta pantalla

**Hoy** la pantalla contesta *«¿el libro cuadra con la Caja General de Kepler, día por día?»*.
§36 midió que esa pregunta es **demasiado chica**: el libro puede cuadrar con Kepler y aun así
faltar dinero, porque ninguno de los dos ve lo que no se capturó en ninguno (§36.8, §36.9). Y un día
«no cuadra» mezcla siete causas distintas, con siete responsables distintos.

**El acto que cierra:** que **cada peso de Caja General tenga una explicación**, y que lo que no la
tiene **llegue a quien lo resuelve**.

**La prueba de la frase** (una pregunta, sin «y»):
> *¿Qué efectivo de Caja General no tiene explicación todavía, y a quién le toca?*

⚠️ Lleva «y», pero no son dos preguntas: el «a quién le toca» es el **atributo** de cada hueco
(su dueño), no otra vista. Si fueran dos, una lista de huecos sin dueño también contestaría la
primera, y no la contesta: un hueco sin dueño no se cierra (memoria «La bandeja se filtra por
responsabilidad, no por permiso»).

## Paso 2 · Quién entra, y con qué pregunta

Gate de la ruta: `FINANCE_CAJA_VER` **o** `FINANCE_BANK_VER` (`app.routes.ts`, `[CGA-A.67]`).
**Uso medido** (`analytics.ui_usage`, 2026-10-05 → 11-04):

| endpoint | hits | días con uso | roles |
|---|---:|---:|---|
| `GET /finance/caja/conciliacion-workbook` (la pantalla) | **146** | 20 | finanzas, finanzas_operativo, supervisor, tesorería, superadmin |
| `GET /finance/caja/conciliacion-dia` (abrir un día) | **129** | 18 | los mismos menos tesorería |

⭐ **129 de 146 visitas abren un día.** La gente no viene por el resumen del mes: viene a **ver qué
falta de un día**. El nivel 0 tiene que contestar eso sin abrir nada.

| quién | con qué pregunta llega | qué hace después |
|---|---|---|
| **operación de caja** (finanzas_operativo) | ¿qué me falta capturar o corregir? | Captura / corrige en el libro |
| **finanzas / tesorería** | ¿cuánto efectivo falta explicar y por qué? | pide a sucursal, Canindo, Kepler o Dirección |
| **supervisor** | ¿el día está cerrado? | firma o devuelve |

## Paso 3 · El estado real, medido (no supuesto)

Ventana **12-oct → 3-nov**, prod en sólo lectura, el 2026-11-04 (§36):

- **24 días:** 6 cuadran libro-contra-Kepler, 2 sin Kepler y 16 con diferencias. Las diferencias de
  los 16 quedan explicadas por movimientos con nombre (**residuo $0.00**).
- ⛔ **Lo que la pantalla de hoy no ve, y §36 encontró:**

| hueco | monto | dueño | ¿lo ve hoy la pantalla? |
|---|---:|---|---|
| cobros a `0011` sin captura en el libro | $335,165.25 | caja | parcial: como «no cuadra» o «falta capturar», sin decir qué es |
| en el libro pero sin su documento ligado (la cola los pide recapturar) | $289,398.21 | caja | ⛔ los pinta como faltantes |
| errores de captura (ruta 23 en $34; un depósito dos veces) | $30,360 + $21,101 | caja | ⛔ no |
| cobros de Kepler a una cuenta que no es caja ni banco (`0001`) | $163,882.36 + $20,345 | sucursal / contabilidad | ⛔ no |
| venta de Canindo sin cobro (12–31 oct / 1–4 nov) | $148,287.45 / $226,702.25 | Canindo | ⛔ no |
| cortes de las cajas que alimentan Caja General, sin cobro | $289,200.09 | sucursales 07 y 08 | ⛔ no |
| salidas que sólo registra Control (con bóveda como testigo: $192,558.50) | $648,434.50 | Dirección / caja | ⛔ no |
| bulto del cajón tecleado como «morralla», sin contar | $188,560 | conteo | ⛔ no |
| documentos de Kepler sin dirección (`signo` nulo) | 2 × $10,900 | Desarrollo | ⚠️ lo muestra contradictorio (§36.2) |

⭐ **El cuello es éste:** la pantalla contesta una pregunta (libro contra Kepler) que deja fuera más
de la mitad del dinero sin explicar, y cuando sí lo ve, no dice de quién es.

## Paso 4 · Qué ve, y en qué ORDEN (nivel 0: sin un clic)

1. **El veredicto del periodo, en una frase.** *«Falta explicar $X en N huecos: caja $A · Kepler y
   sucursales $B · Canindo $C · sin contar $D.»* Cada monto filtra la lista de abajo.
2. **La línea del efectivo físico.** *«Contado (cajón + bóveda) contra el libro: −$48,047.70 ·
   $188,560 declarados sin contar.»* Es el único testigo que no depende de nadie, y va arriba.
3. **La lista de huecos**, la tarea. Una fila por hueco, **lo más nuevo primero**, agrupable por
   dueño. Cada fila dice qué testigos lo vieron y cuáles no (cadena venta → corte → cobro → bóveda →
   libro → Control), cuánto es, qué falta y **el botón de lo que se hace**.
4. **Los días** quedan como **segundo modo** del mismo listado (segmentado «Huecos | Días»). El día
   sigue siendo la unidad de cierre (`[RD.106]`) y 129 de 146 visitas lo abren.

Jerarquía declarada: **primario** = el monto sin explicar · **secundario** = su reparto por dueño y
la línea física · **terciario** = la cadena de testigos de cada fila.

## Paso 5 · Qué NO ve (o no al nivel 0)

| pieza de hoy | decisión | por qué |
|---|---|---|
| tabla «Total del mes» (Caja / Kepler / Diferencia, 2 renglones) | **sale**; la deriva el veredicto | un total que no dice de quién es no decide nada (`Q.2`) |
| tolerancia «10 centavos por movimiento» en el subtítulo | al `context-help` | explica el método, no el estado |
| el párrafo de método del diálogo (Control por importe, libro por llave, ruta por identidad) | al `context-help` | 6 renglones antes de la primera fila |
| tira de 12 conteos del día (`tw-drill-kpis`) | se reduce a **3**: explicado, por explicar y cuántos por importe | cuando todo pesa igual, nada es primario (§3b) |
| «~» de casamiento ambiguo | se queda, con texto accesible | es la verdad del método |
| pares que casan **sólo por importe** con más de un candidato | se marcan «por confirmar», **no** «casado» | ⛔ §36.7: el importe no distingue del placebo |
| el día como diálogo modal | pasa a **side-peek** | se pierde la lista al abrirlo (129 aperturas) |

## Paso 6 · El mapa de desglose — información tras información

| cifra | nivel 1 (en la fila) | nivel 2 (side-peek) | nivel 3 (otra pantalla) | endpoint |
|---|---|---|---|---|
| monto sin explicar del periodo | filtra la lista | — | — | `GET /finance/caja/cuadre/huecos` (nuevo) |
| monto por dueño | filtra por dueño | — | — | idem |
| línea física (contado − libro) | — | el balance: inicial, entradas, salidas, contado, bulto | Arqueos (el corte) · Caja Fuerte (la bóveda) | `GET /finance/caja/cuadre/balance` (nuevo) |
| un hueco | testigos, monto, qué falta, acción | **la cadena**: cada eslabón con su documento (venta del día, corte `U-D-23`, cobro `U-A-5` y cuenta, depósito o dispensado CAOS con hora, folio del libro, folio de Control) | Captura (con el documento puesto) · Caja Fuerte · Cortes/Sucursales · Kepler (`/movement`) | `huecos` + `GET /finance/caja/movement` (existe) |
| un día | explicado / por explicar | los movimientos del día con su par (lo de hoy) | — | `conciliacion-dia` (existe) |

## Paso 7 · Accesibilidad de la información

- **Por nombre, nunca por código:** «Canindo», «Morelia Madero», «ruta 505». Jamás «06» u «06-005»
  (`| sucursal`, `warehouseName()`).
- **Buscable por cualquier folio** que la persona tenga en la mano: libro (`CI-`/`CG-`), Kepler
  (`U-A-5 0000224`), depósito CAOS (`#1650`), Control (`A23702`).
- **El documento fuente:** el documento de Kepler se abre con `/movement`; el depósito CAOS, en Caja
  Fuerte; el renglón de Control se muestra con sus piezas. ⚠️ **Ninguno tiene archivo** (PDF/imagen):
  se dice así en el side-peek, no se deja el hueco.
- **Sin mouse:** la lista se recorre con flechas, `Enter` abre el side-peek y `Esc` lo cierra; la
  acción de la fila es alcanzable con `Tab`.
- **Sin color:** el estado y la certeza van en texto («falta», «por confirmar», «alta»); el color
  sólo lo acompaña.

## Paso 8 · Ligas con otros procesos

| de dónde viene | a dónde va |
|---|---|
| venta de la camioneta (`v_rd_route_daily`) · corte `U-D-23` · cobro `U-A-5` (`kdm5`, `route_collections`) · bóveda (`caos_cash_movements`, `caos_cash_counts`) · Control (`caja_general_ods.arqueo_movimientos`) · libro (`cash_ledger`, cortes) | **Captura** (capturar / ligar) · **Arqueos** (contar el bulto) · **Caja Fuerte** · **Cortes/Sucursales** (el corte sin cobro) · el día de ruta de `[RD.106]` (Canindo) |

⛔ **Liga rota, nombrada:** la cola de Captura no reconoce lo capturado desde CAOS sin
`declared_doc_ref` ($229,586.21, §36.2). Si el Cuadre manda a la cola esos renglones, fabrica
duplicados. **La acción es «ligar», no «capturar».**

## Paso 9 · ¿Le toca a esta pantalla?

| hecho | vive aquí | se abre en otra | se pide a otra área |
|---|---|---|---|
| captura, liga, error de captura | ✅ (acción en la fila) | Captura | — |
| bulto sin contar | ✅ (se declara) | Arqueos | operación |
| venta de Canindo sin cobro | ✅ (se ve, porque es efectivo que debía llegar) | día de ruta (`[RD.106]`) | Canindo |
| cobro a `0001`, corte sin cobro | ✅ | Cortes/Sucursales | sucursal / contabilidad |
| salidas sólo en Control | ✅ | — | Dirección |
| cortes que van a banco | ⛔ no: no es Caja General | Cortes/Sucursales | — |

## Paso 10 · La maqueta (nivel C: sin validación visual)

```
Cuadre de Caja General                                [?] Kepler hace 4 min · Oct 2026 ▾ ↻
─────────────────────────────────────────────────────────────────────────────────────────
Falta explicar $X en N huecos                                       ← primario
  Caja $A  ·  Kepler y sucursales $B  ·  Canindo $C  ·  Sin contar $188,560
Efectivo contado contra el libro: −$48,047.70 · $188,560 declarados sin contar  [ver balance]

[ Huecos | Días ]   Dueño: [Todos ▾]   Certeza: [Todas ▾]   [Buscar folio, ruta, monto…]

 Fecha   Qué es                               Testigos              Monto      Acción
 31-oct  Cobro de Morelia sin captura          Corte✓ Cobro✓ Libro✗   44,097.07  [Capturar]
         U-A-5 0000224 · Morelia Madero caja 4
 28-oct  Ruta 505: vendió y no cobró           Venta✓ Cobro✗          8,536.90  [Pedir a Canindo]
 26-oct  Salida sin documento (pago de tarjeta) Control✓ Bóveda✓ Libro✗ 119,726.00 [Ver]  alta
 19-oct  Ruta 23 capturada en $34              Cobro✓ Bóveda✓ Libro≠  30,360.00  [Corregir]
 13-oct  Cobro de ruta ya capturado sin liga   Cobro✓ Libro✓(sin liga) 18,132.00 [Ligar]
 ...
─────────────────────────────────────────────────────────────────────────────────────────
side-peek de un hueco:  la cadena, un eslabón por renglón, cada uno con su folio y su hora
  Venta    ruta 23 · 19-oct · $30,394.00         (Kepler de la camioneta)
  Corte    01-003 U-D-23 · 3 aperturas            $30,394.00
  Cobro    01-003 U-A-5 0000015 → Caja General    $30,394.00
  Bóveda   depósito #1650 · 16:11 · «r23 19 10 26» $30,360.00
  Libro    CI-2026-00111                          $34.00   ⚠ difiere $30,360
  Control  —
```

⚠️ `$X`, `$A`, `$B`, `$C` y `N` los publica el motor (`[LE.CU.2]`): no se escriben a mano. Los
reparte la regla de dueño de cada hueco, y un hueco con dos dueños posibles se cuenta una sola vez,
en el primero que puede cerrarlo. Las filas de ejemplo sí son movimientos reales de §36.

**Se conserva** (decisiones previas): el estado partido `[CGA-A.66]` (cuadra / falta capturar / no
cuadra) dentro del modo «Días»; las pestañas de Caja (`[CGA-A.67]`); la frescura de Kepler; la
exportación a Excel. **Cambia:** el nivel 0 pasa del día al hueco, y el veredicto pasa de «días que no
cuadran» a **dinero sin explicar con dueño**.

## Paso 11 · Criterios de aceptación (se miden en la pantalla viva)

1. **Control positivo:** con los datos del 12-oct al 3-nov, la pantalla publica los huecos de
   §36.6 **al peso**, y el residuo por día sigue en $0.00.
2. **Ninguna cifra sin desglose:** cada monto del nivel 0 filtra la lista o abre su side-peek.
3. **La certeza se declara:** todo par que casó sólo por importe sale «por confirmar», nunca
   «explicado».
4. **0 códigos de sucursal o almacén** en la pantalla (`check:pantalla` + `sin códigos`).
5. **La respuesta llega en < 1 s** (cada consulta < 500 ms, memoria «Una consulta de más de 500 ms
   NO funciona»), medido en prod con `EXPLAIN ANALYZE` de las consultas reales del servicio.
6. `check:pantalla -- finanzas` **sin fallas nuevas**, antes y después.
7. **Prueba negativa:** se esconde un cobro de la ventana y el hueco aparece; se cambia una cuenta
   `0011` por `0001` y el hueco cambia de dueño.

## Paso 12 · Lo que la interfaz NO puede resolver (por eso va primero)

| hueco | por qué la pantalla no lo cierra | quién |
|---|---|---|
| el bulto de $188,560 | nadie lo contó; la pantalla sólo puede declararlo | operación: conteo pieza por pieza |
| Canindo sin cobros desde el 1-nov | el carril llega (105 renglones en 24 h); los cobros no se capturaron | Canindo |
| cobros a `0001` y cortes sin cobro | se corrigen en Kepler | sucursal / contabilidad |
| salidas sólo en Control (tarjetas, entregas) | no tienen documento en ningún lado | Dirección |
| Control no marca la dirección | se deduce de la observación y la forma; se declara | — |
| los guiones de §36 viven fuera del repo | sin versionarlos, C0 no es reproducible | Desarrollo, **primer item** |

---

## El orden del trabajo (método C0 → C3)

| item | capa | qué | estado |
|---|---|---|---|
| `[LE.CU.1]` | C0 | versionar las mediciones de §36 como `scripts/verify-cuadre-*.js` (sólo lectura, `system_identifier` verificado) | ⬜ |
| `[LE.CU.2]` | C1 | motores puros con prueba: `caja-boveda-replay.engine` (replay validado 109/111), `caja-balance-fisico.engine`, `caja-huecos.engine` (clasifica cada hueco por testigos → dueño → certeza) | ⬜ |
| `[LE.CU.3]` | C2 | `GET /finance/caja/cuadre/huecos` y `/balance`; consultas < 500 ms medidas en prod | ⬜ |
| `[LE.CU.4]` | C3 | la pantalla de la maqueta; `check:pantalla` antes y después | ⬜ |
| `[LE.CU.5]` | C2 | arreglar los dos defectos de §36.2 (signo nulo y la cola que pide recapturar) | ⬜ |
