# Fase RH · frente NE — ANEXO DE ESTRUCTURA (2026-11-24)

> **OBJETIVO** · Que la Suite **arme y entregue el recibo de nómina**, y que el Access se pueda
> apagar sin perder nada.
> **MÉTRICA — HOY (2026-11-24):** la Suite arma **0 recibos**. Tiene **6 primitivos** de nómina y
> **0 llamadores**; **0 servicios, 0 controladores, 0 rutas, 0 claves de permiso**; y **3 de sus
> tablas en 0 filas** (`hr.payroll_periods`, `hr.person_aliases`, `hr.employees`).
> **META:** la fija cada item al abrirse — acá no se inventa ninguna.
> **CAPA TOPE: C2.** No se planea C3 hasta que C2 tenga árbitro (método §4).
> **ÁREA** RH · **DUEÑO** Edgar (PM) · **ESTADO** 🔨 como frente dentro de RH.
>
> ⛔ **No se abre fase nueva**: el tablero marca **10 🔨 contra un cupo de 4**. Esto son items de un
> frente que ya existe.
>
> Medido con `pg-prod` en **sólo lectura**, `system_identifier` **7688376744939610156** verificado,
> el 2026-11-24. El código, sobre el árbol de trabajo del mismo día.

---

## 1. En una pantalla: el frente tiene cerebro y no tiene cuerpo

Seis piezas de lógica pura resuelven lo difícil —la aritmética del recibo, el sobre al billete, el
periodo como llave, el centro partido en sitio y área, la entrega, el puente entre padrones— y
**ninguna la llama nadie**. Debajo, las tablas que necesitan están vacías. Encima, no hay API.

| capa | qué hay | medido hoy |
|---|---|---|
| **C0 · dato** | 25 tablas en `hr.*` | las 3 del frente en **0 filas**; `hr.attendance_closures` en **0 desde siempre**; `hr.employees` **vestigial** (`[NE.0.13]`) |
| **C1 · dominio** | `centro` · `periodo` · `recibo` · `sobre` · `entrega` · `puente-padrones` | **6 primitivos, 0 llamadores** (exportados por el barril, importados por nadie) |
| **C2 · API** | — | **0** servicios, **0** controladores, **0** rutas, **0** claves de permiso |
| **C3 · UI** | — | **0** |

⭐ **Entonces «estructurar» no es diseñar de nuevo: es construir el cuerpo que falta, de abajo hacia
arriba.** Lo que está hecho está bien y no se toca.

---

## 2. Cómo cambió el pedido

| # | lo que se pidió (cita) | efecto |
|---|---|---|
| 1 | «estructuremos todo, luego descargamos el histórico» | **invierte el orden**: la estructura va antes que el dato histórico. Deroga el plan implícito de empezar por la serie de 2011 |
| 2 | «primero armemos todo lo nuestro» | el alcance inmediato es **sólo lo construible sin el Access**: ContPAQi (ya está dentro de la base) y lo que la Suite ya calcula |
| 3 | «un importer que mate Access y no estar viviendo de un import» | contesta **D7**: sí hay importer, pero **de una sola pasada y con fecha de muerte** (§4) |

⭐⭐ **La consecuencia que el pedido no dice en voz alta, y hay que decirla:** si el Access muere, la
mitad de la nómina que hoy sólo vive ahí —**el efectivo y el sobre**— se queda sin productor. O la
Suite pasa a **producirla**, o al apagar el Access se apaga también esa mitad. Es **D8**, y es de
Edgar.

---

## 3. El universo y el trabajo, que no son el mismo número

| | |
|---|---:|
| **universo**: personas que cobran una semana | **248–259** (248 pagadas por ContPAQi en 90 días · 259 marcadas en el padrón del `.mdb`) |
| **trabajo inmediato**: las que el puente liga hoy | **200** por ContPAQi · **201** por el `.mdb` |
| lo que queda para una persona, declarado | **48 / 58** — ambiguos, juicios, bajas y sin candidato (`[NE.0.5]`) |
| histórico, aparte y congelado | **159,068** recibos en 819 semanas (`[NE.0.7]`) |

---

## 4. D7, contestada: qué separa **la mudanza** de un importer prohibido

La regla 1 prohíbe importers porque crean **tuberías que hay que mantener** y materializan datos que
el ODS ya da. Lo que Edgar pidió es lo contrario: **una mudanza**, que corre una vez y **apaga la
casa vieja**. Para que no se convierta en lo prohibido, se escribe con sus tres condiciones:

| # | condición | cómo se prueba |
|---|---|---|
| 1 | **Corre una sola vez.** La tabla destino queda marcada como congelada y la segunda corrida **se niega** | prueba negativa: correrla dos veces y ver el rojo (regla 12) |
| 2 | **El origen muere.** El item no cierra hasta que el Access queda **de sólo lectura** y nadie escribe en él | se verifica contra el archivo, con fecha |
| 3 | **No queda tubería.** Ni cron, ni job, ni `database/importers/**` nuevo que alguien tenga que cuidar | el gate que ya vigila los importers |

⛔ Mientras esas tres no estén escritas en el item, **la mudanza no se arranca**: un importer sin
fecha de muerte es exactamente el que la regla prohíbe.

---

## 5. Lo que creíamos y cayó (sólo de esta semana)

| lo que decía | lo que midió prod |
|---|---|
| «la tabla de alias quedó lista» (`[NE.0.4]`) | nació sin poder recibir **ni una fila**, y hoy sigue **sin quien la escriba** |
| «`horas_extra` carga dos conceptos» (`[NE.0.13]`) | **falso**: es «**Uso** de horas extra», se gasta saldo del banco (`[NE.0.14]`) |
| «el empate liga 73.7 %» | con la población viva correcta, **77.6 %** (`.mdb`) y **80.6 %** (ContPAQi). Filtrar por `activo` lo hundía a **39 %** |
| «el padrón de nómina tiene una fila por persona» | tiene a alguien **dado de alta dos veces**, con la misma CURP/RFC/NSS |

---

## 6. Decisiones

| # | decisión | estado |
|---|---|---|
| **D6** | ¿ContPAQi o el `.mdb`? | ✅ **ambos** — Edgar, 2026-11-24 |
| **D7** | ¿Cómo entra el histórico? | ✅ **una mudanza de una pasada que mata el Access**, con las 3 condiciones de §4 — Edgar, 2026-11-24 |
| **D8** | Al morir el Access, ¿la Suite **produce** la mitad en efectivo (el sobre), o sólo la guarda? | ⬜ **Edgar**. Recomendación: **producirla** — el primitivo `sobre.ts` ya existe y sin eso el apagado deja un hueco de dinero |
| **D9** | ¿El recibo vive en una **tabla propia** o se deriva al vuelo? | ⬜ **Edgar**. Recomendación: **tabla propia** (`hr.payroll_receipts`): es dato propio, el histórico la necesita igual (§9.7) y derivar 159 mil recibos al vuelo no se sostiene |
| **D1–D5** | puntualidad, asistencia, el cierre, la semana, el permiso | ⬜ siguen abiertas — **RH / Dirección** |

---

## 7. Qué NO incluye

Timbrado y CFDI (**ContPAQi es el sistema de registro**, ADR-040) · la dispersión bancaria · cambiar
**cómo** se paga o cuánto · tocar CORS o credenciales (regla 7) · el resto de las 43 tablas del
`.mdb` que no son nómina (`[NE.0.7]` §9.9).

---

## 8. El orden, y por qué

| orden | frente | por qué va ahí |
|---|---|---|
| 1 | **C0 · dónde vive el recibo** | sin tabla no hay dónde escribir, y el histórico necesita la misma (D9) |
| 2 | **C2 · el servicio del puente** | es lo único que puede escribir (`app_runtime`), y desbloquea la tabla de alias que lleva dos días vacía |
| 3 | **C2 · el recibo de la semana viva** | con ContPAQi adentro, se puede armar **sin el Access** |
| 4 | **C3 · la pantalla** | recién cuando C2 tenga árbitro |
| 5 | **La mudanza** (`[NE.0.7]`) | al final, con la estructura ya probada por la semana viva: **el histórico cae en una forma que ya funciona**, no al revés |

⭐ Ese orden es lo que pidió Edgar, y además es el que menos cuesta: si la mudanza fuera primero,
159 mil recibos aterrizarían en una estructura que nadie ejerció todavía.

---

## 9. Las capas, con sus items

### C0 · dato

- ⬜ `[NE.2.1]` **La tabla del recibo** (`hr.payroll_receipts` + su hermana de suma de control),
  con la forma ya diseñada en `[NE.0.7]` §9.7: llave del sistema de origen, semana, persona, centro
  crudo **y** sitio/área resueltos aparte, **dinero en centavos enteros**, el sobre denominación por
  denominación, y **el renglón original como `jsonb`**. `tenant_id` + audit fields, RLS forzada,
  `GRANT` a `app_runtime`. **Depende de D9.**
- 🧪 `[NE.2.2]` **El periodo se puebla desde ContPAQi** — hecho y probado contra base real.
  ⭐⭐ **Y deroga una premisa de `[NE.0.4]`:** el rango de días **sí está registrado**. El rango modal
  de cada fecha de pago cubre el **98.2 %** de sus pagos en promedio (mínimo 90.4 %) y en **516 de
  517** fechas es de **7 días que terminan el día del pago** — la semana es **sábado→viernes**. Lo
  que no llega al consenso se escribe en NULL, declarado. ⚠️ **Aviso para `[NE.0.7]`:** el `CHECK`
  del viernes **va a rechazar el 2018-03-28** (miércoles de Semana Santa, la única excepción en diez
  años) cuando se cargue el histórico. ⛔ La nómina **extraordinaria** (junio/PTU y diciembre/
  aguinaldo) **no es un periodo semanal** y no entra.

### C1 · dominio — **ya está, y no se toca**

`centro` · `periodo` · `recibo` · `sobre` · `entrega` · `puente-padrones`. Lo único que falta es
**que alguien los llame**. ⚠️ Si al conectarlos aparece lógica nueva, va a `libs/`, no al servicio
(ADR-056).

### C2 · API

- ⬜ `[NE.2.3]` **El servicio del puente**: alimenta `tiendePuente` desde `contpaqi_ods` y escribe
  `hr.person_aliases` corriendo **como la aplicación**. Idempotente; los rechazos **se guardan como
  rechazos**, no se tiran. Clave de permiso propia y **repartida en prod** (regla 20).
- ⬜ `[NE.2.4]` **El recibo de la semana viva**: arma el recibo de un periodo con lo que ya hay
  dentro de la base (ContPAQi + asistencia + el banco de horas) y lo guarda. **Prueba contra base
  real con el payload de la pantalla** (regla 13).
- ⬜ `[NE.2.5]` **La cola de los que no ligaron** (`[NE.0.5]`): endpoint para resolver a mano los
  48–58, escribiendo `matched_by = 'manual'` **con firma**.

### C3 · UI — **no se planea todavía**

Cuando C2 tenga árbitro. Lo que ya se sabe que pide: la skill `diseno` es obligatoria y las **cinco
preguntas por escrito** antes de generar la interfaz.

### La mudanza, al final

- ⬜ `[NE.0.7]` ya tiene su diseño, su gate y su prueba negativa (§9.7–9.8). Se arranca **después**
  de que la semana viva funcione, y con las tres condiciones de §4 escritas en el item.

---

## 10. Riesgos y bloqueos

| bloqueo | dueño | causa | qué lo destraba |
|---|---|---|---|
| **El cierre de semana nunca se ejecutó** (`hr.attendance_closures` en 0) | RH | nadie lo ha hecho; **78 semanas-sitio se cierran hoy con un clic** | **D3** |
| Nada se escribe en prod sin desplegar | Edgar | sólo `app_runtime` escribe; el carril es el de siempre | soltar cuando C2 esté probada |
| El `.mdb` no tiene camino a la base | Edgar | ✅ **destrabado por D7**: la mudanza | que el item se escriba con las 3 condiciones |
| El efectivo se queda sin productor al apagar el Access | Edgar | hoy sólo lo produce el Access | **D8** |

---

## 11. Definición de Terminado (las 7)

- [ ] La métrica de cada item, **medida antes y después**
- [ ] Prueba negativa de cada gate, **vista en rojo**
- [ ] Lo que escribe, **ejercido contra base real con el payload de la pantalla**
- [ ] Permiso **repartido en prod**, no sólo declarado (regla 20)
- [ ] Lo no medido, **declarado** (`unknown` / `measured:false` / NO MEDIDO)
- [ ] Tracker y log al día; ADR si hubo decisión
- [ ] **El Access apagado** — sólo para la mudanza

## 12. Bitácora

- **2026-11-24** — Anexo escrito. Edgar contesta D6 (ambos) y D7 (mudanza de una pasada que mata el
  Access). Medido: 6 primitivos sin llamadores, 0 endpoints, 3 tablas del frente en 0 filas.
  Se abren D8 y D9.
