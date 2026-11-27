# Fase RD · Cierre — que la quincena se pague desde la Suite

> El método que la gobierna: [`docs/METODO_DE_TRABAJO.md`](../../METODO_DE_TRABAJO.md).
> Nace del pedido de Edgar del **2026-11-27** (*«resolvámoslo… documentemos un plan en el que
> arreglemos los 3, empezando por nivel de estructura»*) sobre la auditoría
> [`FASE_RD_ANEXO_AUDITORIA_COMISIONES_2026-11-27`](FASE_RD_ANEXO_AUDITORIA_COMISIONES_2026-11-27.md).
>
> **Los tres frentes están acá, ordenados por capa, no por urgencia.** Una capa no sube hasta que
> la de abajo está verificada. El dato primero porque es la causa del 89 % de la diferencia; la
> pantalla al final porque simplificar lo que nadie firma no sirve de nada.
>
> Hermanas (anteriores, con el decode y el motor): [`FASE_RD_COMISIONES_MOTOR`](FASE_RD_COMISIONES_MOTOR.md)
> · [`FASE_RD_CICLO_QUINCENAL`](FASE_RD_CICLO_QUINCENAL.md) · [`FASE_RD_COMISIONES_REFUNDACION`](FASE_RD_COMISIONES_REFUNDACION.md).

```
OBJETIVO: que la comisión quincenal de Ruta Directa se calcule, se firme y se entregue
          desde la Suite, y que el Excel deje de ser el que paga.
MÉTRICA:  quincenas cerradas aprobadas y entregadas desde la Suite
          HOY: 0 de 23 (0 %), medido 2026-11-27 → META: 100 % desde Q1-2027 (cierra 13-ene-2027)
MÉTRICA 2: delta del motor contra el libro SIN clasificar
          HOY: $30,721.89 en 65 filas, medido 2026-11-27 → META: $0 sin clasificar
CAPA TOPE: C3
ÁREA:      Comercial
DUEÑO:     <por asignar — Edgar>
ESTADO:    🔨 desde el 2026-11-27
```

✅ **Abierta por Edgar el 2026-11-27** («ábrela»), **por encima del cupo**: es la **9ª fase 🔨
contra el cupo de 4** (§3 del método). Fila puesta en el roadmap de `CLAUDE.md` el mismo día.
⚠️ Sigue sin **dueño** asignado; el método pide una fase 🔨 por dev.

---

## 1. Qué problema resuelve

Medido contra prod el **2026-11-27** (sólo lectura, `system_identifier 7688376744939610156`):

- **0 corridas aprobadas en toda la historia del módulo.** `approved_at` nulo en las 23;
  `approve`/`pay`/`void`: **0 llamadas en 59 días**. Las 20 corridas en estado `pagado` tienen
  `origen = 'libro'` y se cargaron todas el 2026-10-08: son la copia del Excel, no cálculo propio.
- **El motor paga $74,980.66 menos que el libro** sobre $937,781.87 (**−8.0 %**), con **65 filas**
  que el propio sistema clasifica `sin_explicar` por −$30,721.89.
- **22 de 23 corridas con `total_neto` NULL**, por **4 deducciones de supervisor sin cargar**.
- **Cero exportación**: aprobar no produce nada que entregar a nómina.
- El trabajo se hace dos veces: el Excel `INDICADORES RD 2026.xlsx` tiene **14,331 celdas tecleadas
  (94.5 % manual)** sólo en la hoja CONCENTRADO (medido el 2026-10-07).

**Lo que no es el problema** (medido, para que nadie lo persiga): el permiso está repartido
(22 personas alcanzan VER, 14 APROBAR, por las tres vías), la pantalla no es lenta (todas las
lecturas < 25 ms) y el cálculo ya es automático (`CommissionAutoRunService` creó solas Q21, Q22 y
Q23 al cerrar cada periodo).

### 1.1 ⭐⭐ La causa del 89 %, ya localizada

Las 65 filas `sin_explicar` **no son 65 investigaciones**. Descompuesto el delta pieza por pieza,
64 de 65 tienen **la base distinta**: el motor ve menos venta, no calcula distinto. Y la base cuadra
**al centavo** en 136 de 233 filas (Q1, Q3, Q8 y Q9: ratio 1.0000 exacto), lo que prueba que la
fórmula del motor es correcta.

| Grupo | Filas | Delta | Causa real, medida |
|---|---:|---:|---|
| **Q4** | 11 | **−$23,431.91 (76 %)** | el **lunes 23-feb-2026**: Wincaja cargó **7 de 17 sucursales** (6,269 líneas, 1,137 tickets). En la venta por ruta quedaron **2 rutas de 13** y **$2,263** contra los ~$240,000 de un lunes normal |
| **Q7** | 3 | −$3,863.66 (13 %) | **3 y 4 de abril**: Wincaja cargó **6 y 9 de 17** sucursales |
| **Q16** | 8 | −$2,594.08 (8 %) | días completos (14–16 rutas los 12 días). **Sin diagnosticar**, ~$324 por ruta |
| resto (9 quincenas) | 43 | −$832.24 (3 %) | ruido de ±$100 por quincena |

Barrido del año completo (279 días con dato, mediana de 15 rutas por día hábil): **sólo 4 días
sospechosos**, y tres de ellos son feriados legítimos (3 y 4 de abril, 16 de septiembre). **El único
hueco de ingesta real es el 23 de febrero.**

### 1.2 ⛔⛔ El defecto de instrumento que lo escondió nueve meses

`analytics.v_rd_commission_contrast` clasifica la causa así:

```sql
WHEN mot.dias_con_venta < mot.dias_esperados THEN 'faltan_dias_en_la_fuente'
ELSE 'sin_explicar'
```

…y **`dias_esperados` se deriva de la misma fuente que `dias_con_venta`**. Si la ingesta trae 11
días, el motor espera 11 y declara cobertura completa. **Un denominador sacado del numerador no
puede ver nunca un día que la fuente perdió.** Por eso el 23-feb salió como `sin_explicar` en vez de
`faltan_dias_en_la_fuente`, y por eso el hueco sobrevivió a dos auditorías.

⭐ **El instrumento correcto ya existe en la misma casa**: el gate `cobertura_dias` compara cada
ruta contra **sus hermanas de plaza** (*«505 3 de 11»*). Hay dos criterios para la misma pregunta y
el contraste usa el malo.

> *Memoria que lo nombra:* «un denominador derivado del numerador infla la cobertura» ·
> «los defectos viven en la frontera entre piezas».

---

## 2. Qué NO incluye

- ⛔ **No recalcula Q4 ni Q7.** Decisión de Edgar del 2026-11-27: esas quincenas se **declaran**, el
  pago del libro queda como definitivo y nadie cobra de menos. No se intenta re-ingestar febrero ni
  abril desde los carriles de Wincaja de `.249`.
- ⛔ **No toca el cálculo de la comisión.** La fórmula cuadra al centavo cuando la fuente está
  completa (136 de 233 filas). Cambiarla sería arreglar lo que no está roto.
- ⛔ **No reescribe el motor ni el auto-run.** Funcionan: las tres últimas corridas se crearon solas.
- No incluye que el chofer vea lo suyo (pantalla propia, otro permiso, otra fase).
- No incluye el bono por objetivo mensual más allá de devolverle su vista.
- No incluye retirar el Excel como **fórmula**: sigue siendo el testigo contra el que se arbitra.

---

## 3. Las capas

### C0 · Dato — *que el número diga por qué difiere*

| # | Item | Estado | Verificado contra |
|---|---|---|---|
| RD.C0.1 | 🚀 **EN PROD el 2026-11-27** (mig `20261127095946`, batch 1282, 0.2 s). `dias_esperados` del contraste deja de derivarse de la propia fila: pasa a ser la **mediana de los días que tuvieron las rutas hermanas de la misma plaza en ese periodo**, que es el criterio que el gate `cobertura_dias` ya usa. Vista `derive-no-copy`, sin tabla nueva | ⬜ | las 14 filas de Q4 y Q7 tienen que **cambiar** de `sin_explicar` a `faltan_dias_en_la_fuente`; las 136 que cuadran al centavo **no se mueven** (control negativo) |
| RD.C0.2 | 🚀 **EN PROD** (misma migración, más `20261127103604` batch 1283). Causa nueva **`carga_truncada`**: el día existe, pero las rutas que aparecen traen **una fracción de los tickets que traen siempre**. Distinta de `faltan_dias_en_la_fuente` (no llegó el día) y de un feriado (operaron pocas rutas, pero las que salieron operaron normal) — las tres se arreglan distinto | 🔨 | **instrumento validado el 2026-11-27**, ver §3.0b |
| RD.C0.3 | Q4 y Q7 quedan **declaradas no recalculables**, con el motivo escrito en la fila, no en un `.md`: *«la fuente perdió N sucursales el DD-MMM; el pago del libro es definitivo»* | ⬜ | `recalculate-from` sobre esos periodos tiene que **negarse** y decir por qué (prueba negativa) |
| RD.C0.4 | Compuerta `check:ingesta-dia-flaco`: un día hábil con menos de la mitad de las sucursales de Wincaja **se ve el mismo día**, no nueve meses después | ⬜ | ⛔ rota a propósito una vez: inyectar un día flaco simulado y verificar el rojo |
| RD.C0.5 | ~~Diagnosticar las 8 filas de **Q16**~~ — **hecho el 2026-11-27**, ver §3.0 abajo. Queda su consecuencia: **declarar** que una diferencia de base con días completos **no es diagnosticable** contra lo que la Suite guarda | 🧪 | el libro no tiene grano diario en la Suite: para cerrar esas filas haría falta el workbook |
| RD.C0.6 | El contraste publica **cuándo se calculó**. Hoy está congelado del 2026-11-04 y se lee como si fuera de hoy | ⬜ | `computed_at` visible; si tiene más de una quincena, se declara añejo |

⛔ Sin importer: todo sale de `kepler_ods` / `wincaja` por vista. Lo que no se pueda verificar se
declara, nunca se dibuja como 0.

#### 3.0 · Q16, cerrada el 2026-11-27 (RD.C0.5)

De las 8 filas, **una pesa el 77 %**: la ruta **504**, con **12 de 12 días completos**, trae una base
$20,186.17 menor que el libro y por eso **no alcanza el primer escalón** — `motor_pct` queda nulo y
cobra **$0** contra los $1,994.24 del libro. La 505 (−$1,663.83) **ya estaba bien clasificada**:
tiene 11 de 12 días, así que cae en `faltan_dias_en_la_fuente`, no en `sin_explicar`. Las 6
restantes suman ±$250 y van en los dos sentidos (tres rutas con base **mayor** que el libro).

⛔ **Y acá hay un límite que se declara, no se resuelve:** el libro cargado en la Suite guarda **el
total de la quincena, no el día**. Una diferencia de base con los días completos **no es
diagnosticable contra lo que la Suite tiene** — haría falta el workbook `INDICADORES RD 2026.xlsx`
renglón por renglón. Decir «sin explicar» ahí es honesto; lo que no se vale es dejar que se lea como
si fuera lo mismo que el hueco del 23-feb, que sí está explicado.

#### 3.0b · El instrumento de RD.C0.2, validado el 2026-11-27

⛔⛔ **La primera versión se tiró, y el caso vale contarlo.** Definí «día flaco» como *menos del
60 % de las sucursales que Wincaja carga en la mediana del año*. Pasó su control puntual (23-feb: 7
contra 17) y **devolvió 74 días**. No eran huecos: **Wincaja se fue apagando** —17 sucursales hasta
junio, 8 en julio, 2 en agosto, **1 en septiembre**— porque las rutas migraron a otra fuente. Una
mediana anual sobre una fuente que cambió de forma **mide la migración, no el hueco**. El
instrumento se tira, no la medición (`auditoria-diseno` §4).

**La versión que queda** compara cada día contra **su propia vecindad** (±5 días hábiles) y cuenta
**rutas**, no sucursales:

```
dia atipico  ⇔  rutas con venta < 60 % de la mediana de rutas de los ±5 días hábiles vecinos
```

Da **4 días en todo 2026** y pasa sus cuatro controles: 23-feb presente ✅ · 24-feb ausente ✅ ·
15-ago ausente ✅ · 1-sep ausente ✅ (los dos últimos son la migración de la fuente, no un hueco).

| Día | | Rutas | Tickets | Mediana local | % | **Tickets por ruta** |
|---|---|---:|---:|---:|---:|---:|
| 2026-02-23 | lun | 2 | 2 | 13 | 15 % | **1.0** |
| 2026-04-03 | vie | 6 | 141 | 13 | 46 % | 23.5 |
| 2026-04-04 | sáb | 6 | 141 | 13 | 46 % | 23.5 |
| 2026-09-16 | mié | 5 | 120 | 17 | 29 % | 24.0 |

⭐⭐ **Y la última columna es la que separa las dos cosas, sin adivinar.** El 3 y 4 de abril y el 16
de septiembre son feriados: operaron pocas rutas, pero **las que salieron operaron normal** (~24
tickets cada una). El 23 de febrero las dos rutas que aparecen traen **un ticket cada una**: eso no
es un camión que no salió, es **una carga que se cortó a la mitad**.

> ⛔ Por eso la causa se llama `carga_truncada` y **no** «la fuente perdió el día»: lo que se puede
> medir es que el día vino truncado. Que el camión saliera o no, el motor no lo sabe — y el gate
> `cobertura_dias` ya lo dice con todas las letras. **Es el único día así en 2026.**

⭐ **El patrón que las 4 filas grandes comparten** (Q4: 321 y 22; Q16: 504 y 505): la diferencia de
base no las hace cobrar *un poco menos* — las hace cobrar **cero**, porque el tabulador es un
acantilado. Un 10 % de base perdida cuesta el **100 %** del pago de esa ruta. Por eso un hueco de
ingesta en este módulo no es un error de redondeo.

**Qué desbloquea C0:** que el contraste deje de decir «no sé» sobre $30,721.89 y pase a decir «la
fuente perdió el 23 de febrero». Sin eso, nadie puede firmar el número del motor.

### C1 · Dominio — *que el neto exista y tenga dueño*

| # | Item | Estado | Prueba que lo ejerce |
|---|---|---|---|
| RD.C1.0 | ⛔⛔ **Primero: qué es `commission_route_config.nomina_banco`.** Medido el 2026-11-27: **todos los choferes de una plaza tienen exactamente el mismo valor** — $3,484.96 los seis de La Piedad, $5,000.00 los cinco de Zamora, y coincide con el supervisor de esa plaza. O es el sueldo base por puesto (y está bien), o es **la nómina del supervisor puesta en la fila del chofer**, y entonces el motor le resta $5,000 a la persona equivocada en cada línea | ⬜ | contra un testigo independiente del sueldo de **un** chofer (padrón de `hr`, o el workbook). ⛔ Hasta resolverlo, **lo demás de C1 no se toca**: estaríamos afinando el neto encima de una resta mal atribuida |
| RD.C1.1 | ⚠️ **Replanteado el 2026-11-27.** Los 4 supervisores **sí tienen monto** en `commission_route_config` (3,484.96 · 5,000.00 · 4,413.08 · 3,903.20): **no falta un dato de nómina**. Lo que falta es `commission_beneficiary_config` — la deducción **por persona**, agregada sobre sus rutas — que lleva **0 filas desde siempre**. Las 39 líneas de supervisor salen con `nomina_banco = 0.00` y `deduccion_status = 'sin_configurar'` | ⬜ | `total_neto` deja de ser NULL en Q22 y Q23. ⭐ El camino para escribirla **ya existe** (`POST /commissions/supervisors`) y **nunca se usó**: es configuración que nadie cargó, no código que falte |
| RD.C1.2 | El beneficiario deja de ser texto: poblar `chofer_user_id` y `supervisor_user_id` del padrón — hoy **16 de 16 rutas los tienen nulos** y `commission_beneficiary_config` lleva **0 filas desde siempre** | ⬜ | las 24 líneas en borrador sin `beneficiario_nombre` bajan a 0; cada comisión liga con una persona del sistema |
| RD.C1.3 | Regla explícita: **una corrida sin neto medido no se puede aprobar**. Hoy el gate sólo «advierte» y el neto NULL llegaría a la firma | ⬜ | ⛔ prueba negativa: corrida con deducción faltante → `approve` rechaza con el motivo |
| RD.C1.4 | Las 41 líneas con el costo sin resolver (**32 `sin_costo` + 9 nulas**) declaran su efecto: de ahí cuelga el markup y del markup el bono del supervisor | ⬜ | ninguna línea publica bono sobre un costo que no existe |

### C2 · API — *que aprobar sirva de algo*

| # | Item | Estado | ¿Escribe? | Prueba contra base real |
|---|---|---|---|---|
| RD.C2.1 | `GET /commissions/runs/:id/entregable` — la corrida **aprobada** produce el archivo que hoy produce el Excel (el formato que Finanzas/RH recibe hoy; **hay que medir cuál es antes de inventarlo**) | ⬜ | no | contra una corrida real, cuadrando contra el total aprobado |
| RD.C2.2 | Ejercer `approve` y `pay` contra base real con el payload de la pantalla — **nunca se han ejercido** | ⬜ | **sí** | ⛔ obligatoria (regla 13). En CI o entorno de pruebas, **jamás la laptop apuntando a prod** |
| RD.C2.3 | `recalculate-from` se niega sobre un periodo declarado no recalculable (RD.C0.3) | ⬜ | sí | ⛔ prueba negativa |

### C3 · UI — *que se entienda en un vistazo*

⛔ Cargar la skill [`diseno`](../../../.claude/skills/diseno/SKILL.md) antes de tocar el primer
archivo. Las observaciones de abajo salen de §6.3 del anexo de auditoría y de §4 de esta sección.

| # | Item | Estado | `check:pantalla` antes → después |
|---|---|---|---|
| RD.C3.1 | **El corte**: `/comercial/comisiones` se queda con la quincena. Padrón, bonos y tabulador se van a `/comercial/comisiones/reglas` (mismo permiso `GESTIONAR`); el bono por objetivo recupera su vista. ⚠️ Depende de **D2** | ⬜ | medir antes y después |
| RD.C3.2 | 🔴 El monto de las 27 quincenas sale del `[title]` y se lee como texto: hoy **sin mouse ese dato no existe** | ⬜ | |
| RD.C3.3 | 🔴 El contraste publica su `computed_at` con píldora de frescura (consume RD.C0.6) | ⬜ | |
| RD.C3.4 | 🟠 La tira de **6 KPIs (≈12 cifras) baja a 3**: Bruto · Tras nómina · **Neto** (el que decide, el más grande). Subtotal y comisión se abren en el desglose | ⬜ | |
| RD.C3.5 | 🟠 `.cm-corta` deja `--warn-fg` (**2.15:1**, falla AA) por `--warn-soft-fg` | ⬜ | verificado con el script de contraste y su control |
| RD.C3.6 | 🟠 Las 9 peticiones al abrir bajan a 5: padrón, bonos, tabulador y universo se piden al entrar a su vista | ⬜ | |
| RD.C3.7 | 🟠 Tres niveles tipográficos declarados — hoy **85 % del texto está en 13 px u 11 px** y hay **una sola** declaración `--fs-h2` | ⬜ | |
| RD.C3.8 | 🟠 Los 8 términos del oficio (markup, escalón, acantilado, traslape, multifuente, headroom, arbitrado, libro vs motor) con `app-context-help`, **no con un `title`** | ⬜ | |
| RD.C3.9 | 🟡 `--action` cumple 5 papeles: queda para el botón principal y la selección | ⬜ | |
| RD.C3.10 | 🟡 El neto se dice **una** vez, en grande, con su resta al lado (hoy aparece 3 veces en la primera pantalla) | ⬜ | |

---

## 4. Decisiones

| # | Decisión | Recomendación | Dueño | Estado |
|---|---|---|---|---|
| **D1** | La fase abre **por encima del cupo** (8 fases 🔨 contra 4), o espera | — | Edgar | ✅ **Abierta el 2026-11-27** («ábrela»). Queda 9ª 🔨 |
| **D2** | ¿Se parte la pantalla en «quincena» + «reglas»? Revierte en parte `[AUD-A6]`, que las fusionó por pedido suyo | Partirla: operar la quincena (24 veces al año) y configurar reglas son dos trabajos con distinta gente y distinta frecuencia. **La fusión resolvió un problema real** y por eso la decisión es suya, no de la auditoría | Edgar | ⬜ |
| **D3** | ¿Cuál es el entregable que Finanzas/RH recibe hoy del Excel? | **Medirlo antes de construirlo** (RD.C2.1). Inventar el formato es la forma segura de que nadie lo use | Comercial + Finanzas | ⬜ |
| **D4** | Q4 y Q7: declarar, no recalcular | ✅ **Decidido por Edgar el 2026-11-27** | Edgar | ✅ |
| **D5** | ¿ADR para «el denominador de una cobertura nunca sale de la misma fuente que el numerador»? | Sí: el defecto ya apareció en más de un módulo | Claude | ⬜ |

---

## 5. Riesgos y bloqueos

| Bloqueo | Dueño | Causa | Qué lo destraba |
|---|---|---|---|
| Las 4 deducciones de supervisor | Edgar / RH | el dato de nómina no está en la Suite | primero intentar derivarlo de `contpaqi_nom` por `md5(CURP)`; si no se puede, pedirlo (RD.C1.1) |
| El formato del entregable | Comercial / Finanzas | nadie midió qué recibe hoy RH | D3 |
| El cupo de fases | Edgar | 8 🔨 contra 4 | D1 |
| Q16 sin diagnosticar | Claude | no son días faltantes; falta mirar fila por fila | RD.C0.5 |
| ⚠️ La frontera móvil de la fuente | Claude | `v_rd_route_daily_rapido` une la matvista (**11-may a 06-dic**, medido hoy) con la vista viva para todo lo anterior, y **esa frontera se corre cada día**. Una corrida vieja pudo calcularse con una fuente y contrastarse hoy con otra | medirlo antes de confiar en un contraste de 2026; hoy **NO MEDIDO** |
| ⚠️ La matvista llega al **2026-12-06** | Claude | tiene filas con fecha futura (hoy es 27-nov) | el motor ya tiene el veredicto `dato_imposible`; verificar que no entre a ninguna corrida |

---

## 6. Definición de Terminado

- [ ] 1. Las dos métricas **remedidas**, antes/después publicado
- [ ] 2. Cada capa verificada **o declarada NO MEDIDA** (ADR-056) — incluido el nivel A de la pantalla, que la auditoría del 27-nov **no pudo medir**
- [ ] 3. `approve` y `pay` **ejercidos contra base real** con el payload de la pantalla
- [ ] 4. Las compuertas nuevas (RD.C0.4, RD.C1.3, RD.C2.3) **rotas a propósito**, rojo verificado
- [ ] 5. Todo primitivo genérico en `libs/` **o** deuda con nombre
- [ ] 6. Tracker + `03_LOG_REVISIONES.md` + **fila en el roadmap de `CLAUDE.md`** al día
- [ ] 7. **En prod**, o escrito por qué no y qué falta
- [ ] 8. *(propio de esta fase)* **Una quincena real aprobada y entregada desde la Suite**, con su entregable en manos de quien hoy recibe el del Excel. Sin eso la fase no cerró, por verde que esté todo lo demás

---

## 7. Observaciones de diseño UI — revisión del plan (2026-11-27)

Nivel **C** por definición (`auditoria-diseno` §9): se leyó el plan y la fuente, no la pantalla
viva. Las de C3 arriba ya traen su severidad. Lo que falta decir del plan, no de la pantalla:

| # | Sev | Observación y costo | Ley | Criterio de aceptación |
|---|---|---|---|---|
| RD.UI.11 | 🔴 | **La prueba de la frase no pasa hoy**: la pantalla contesta cinco preguntas. El plan la corta en dos (RD.C3.1), pero si D2 sale «no se parte», las 9 observaciones restantes **sólo maquillan la conflación** | estándar §4.0b | la pantalla contesta *«¿cuánto se le paga a cada chofer esta quincena, y puedo firmarlo?»* sin la palabra «y» para dos temas distintos |
| RD.UI.12 | 🔴 | El plan agrega una causa nueva (`fuente_incompleta_ese_dia`) y una declaración de «no recalculable». **Si la pantalla los pinta como un estado más**, el usuario los leerá como ruido: son justo lo que explica por qué el motor difiere | ADR-056 · Cruce 2 | cada uno con su texto en palabras de quien paga, no con el nombre de la columna — como ya hace `etiquetaProblema()` |
| RD.UI.13 | 🟠 | El entregable de RD.C2.1 es **el único artefacto que sale de la pantalla hacia otra persona**. Un botón genérico de «Exportar» no dice qué se va a entregar ni a quién | Poka-yoke | el botón nombra el entregable y a quién va; antes de bajarlo, se ve qué contiene |
| RD.UI.14 | 🟠 | Los 95 renglones con `motivo_no_pago` (27.7 % de las líneas) son **la pregunta que más va a recibir el que firma**: *¿por qué este no cobró?* Hoy están en la tabla como un motivo suelto | Jerarquía del dato | los 5 motivos (`bajo_umbral` 66, `fuera_no_es_camion` 18, `config_inactiva` 6, `tipo_sin_declarar` 3, `bajo_piso` 2) se agrupan y se cuentan antes de la tabla |
| RD.UI.15 | 🟡 | El plan no dice qué pasa con `/comercial/comisiones/objetivo` ni con `/comercial/rutas/comisiones`, que **hoy cargan el mismo componente** | — | las rutas viejas siguen funcionando y llegan a la vista correcta (como ya hizo `[AUD-A6]`) |

---

## 8. Bitácora

| Fecha | Qué pasó |
|---|---|
| 2026-11-27 | Auditoría de la pantalla y del proceso (anexo). Localizada la causa del 89 % de la diferencia: el 23-feb Wincaja cargó 7 de 17 sucursales, y `dias_esperados` derivado de la propia fuente lo volvió invisible. Edgar decide **declarar Q4 y Q7, no recalcular**, y pide este plan por capas. |
| 2026-11-27 | **Q16 cerrada** (RD.C0.5): una ruta pesa el 77 % y el límite del grano diario del libro queda declarado. **RD.C1.1 replanteado**: no falta el dato de nómina, falta la fila por persona. Aparece **RD.C1.0**: todos los choferes de una plaza tienen la misma `nomina_banco`, que coincide con la de su supervisor — hay que contrastar qué significa esa columna antes de tocar el neto. |
| 2026-11-27 | **Edgar abre la fase** por encima del cupo. Arranca C0 por `RD.C0.1`. |
