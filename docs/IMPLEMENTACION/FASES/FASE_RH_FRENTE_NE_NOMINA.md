# Fase RH · frente NE — La nómina sale del Access

> **Frente de la fase RH**, no una fase nueva. El tablero tiene 9 fases 🔨 contra un cupo de 4
> (medido 2026-11-23 con `node .claude/skills/pm/tablero.js`), y la nómina **es** RH: comparte el
> padrón, el reloj y el schema `hr.*` con [`FASE_RH_PLAN_DE_TRABAJO.md`](FASE_RH_PLAN_DE_TRABAJO.md).
> Por eso cuelga de RH y **no agrega fila al roadmap**.
>
> ⛔⛔ **Este repositorio es PÚBLICO.** La línea es clara: **nunca** importes de dinero, sueldos,
> nombres de personas, cuentas bancarias ni rutas de servidores. Conteos de cobertura y porcentajes
> sí, porque son los que hacen auditable el avance. El levantamiento completo, con las cifras de
> dinero y el mapa de las fuentes, vive en el **anexo privado** (`ANEXO_NE_LEVANTAMIENTO`, fuera del
> repo).

```
OBJETIVO: que la nómina deje de calcularse y entregarse en un Access de un servidor
          compartido, sin perder lo que ese sistema sí hace bien.
MÉTRICA:  personas de la nómina semanal identificables en la Suite (usuario + ficha de reloj)
          HOY (2026-11-23, medido): 69.9 % — piso, por empate de nombre exacto
          META: 100 % con llave propia (no por nombre) para el cierre de C0
CAPA TOPE: C0 (no se sube de capa hasta que el padrón tenga llave)
ÁREA:      RH
DUEÑO:     <por asignar — PM>
ESTADO:    ⬜
```

---

## 1. Qué problema resuelve

**El sistema de nómina ya existe y lleva 15 años funcionando.** No hay que construirlo: hay que
mudarlo. Medido el 2026-11-20 y el 2026-11-23 (detalle y cifras en el anexo privado):

1. **La nómina se calcula en un `.mdb` de Access de 285 MB** en un recurso compartido, que tres áreas
   abren a la vez. Serie continua desde 2011. Es el único módulo de esa base que sigue vivo: gastos,
   compras y ventas diarias dejaron de escribirse entre febrero y julio de 2026.
2. ⛔ **Las dos mitades del pago no comparten número.** El Access guarda un importe de banco **fijo
   por persona** (columna del catálogo, no se recalcula por semana) y entrega en efectivo «lo que
   falta»; lo que el banco dispersa de verdad es otra cifra, que varía cada semana. Se verificó con
   dos sucursales: **la cantidad de personas coincide exactamente, el importe no**. La diferencia
   entre ambas es dinero que sale —o deja de salir— en efectivo y **hoy nadie la cuadra**.
3. **La dispersión bancaria es un archivo de texto de ancho fijo**, uno por sucursal, armado cada
   semana y dejado en la raíz de una unidad compartida con nombres, cuentas e importes en claro.
4. **Nadie registra que la persona recibió su dinero.** El sobre se arma hasta el billete y cuadra,
   pero no hay acuse en ningún sistema. En el libro de efectivo de la Suite, la firma está llena en
   **1 de 76** renglones.
5. **La asistencia no alimenta el cálculo.** Los días y las horas se teclean recibo por recibo
   (~250 por semana), mientras la Suite ya guarda **246,664 checadas** y resuelve la persona en
   **99.8 %** de ellas. Es el empate que convierte ~250 capturas semanales en cero.
6. **Una sola cuenta de usuario cierra todas las nóminas** desde septiembre de 2026.
7. **El respaldo es manual**: 36 copias desde 2016, pero la última dentro de la carpeta de respaldos
   es de **marzo de 2025**. No hay tarea programada. El riesgo no es que falte respaldo: es que la
   periodicidad depende de que alguien se acuerde.

**El cuello, medido:** el padrón de la nómina y el padrón de la Suite **no comparten llave**. La
Suite identifica a la persona por `(sitio, código del reloj)`; el Access, por un número propio de 4
dígitos. Hoy sólo empatan **por nombre escrito igual**, y así empata el **69.9 %**. `hr.employees`
está **en 0 filas**, y ninguna tabla de `hr.*` ni de `identity.*` guarda RFC, CURP ni NSS: ese dato
sólo existe fuera de la Suite.

---

## 2. Qué NO incluye

- **No calcula impuestos ni timbra.** ContPAQi Nóminas es el sistema de registro fiscal (ADR-040,
  integrar y no construir). Este frente **no** lo reemplaza ni lo duplica.
- **No cambia cómo se le paga a nadie.** Qué parte va por banco y qué parte en efectivo es una
  decisión de Dirección; acá sólo se registra, se cuadra y se acusa lo que ya se decidió.
- **No migra el resto del Access.** Gastos, compras y ventas diarias ya están muertos ahí; se
  apagarán con la base, sin trabajo de migración.
- **No es un importer** (regla 1). El padrón no se copia: se le pone llave y se deriva.
- **No abre pantalla** hasta que C0 esté verificado.

---

## 3. Las capas

### C0 · Dato — la llave de la persona

⛔ **Nada de este frente sube de capa hasta que C0 cierre.** Sin llave, cualquier cálculo de nómina
estaría uniendo personas por su nombre escrito.

| # | Item | Estado | Verificado contra |
|---|---|---|---|
| NE.0.1 | **Medir el padrón de la nómina**: universo, cobertura de RFC/CURP/NSS, y cuántos ya tienen ficha de reloj en la Suite | ✅ 2026-11-23 | Access ↔ `hr.device_enrollments` ↔ `identity.users`; cifras en el anexo privado |
| NE.0.2 | **Acceso de sólo lectura a ContPAQi Nóminas** (`contpaqi_nom`), acotado a las columnas no sensibles | ⬜ ⚠️ bloqueado | — |
| NE.0.3 | **De dónde sale el importe que se dispersa por banco**: cerrar la hipótesis de que es el neto oficial del periodo, persona por persona, una semana real | ⬜ | el archivo de dispersión de esa semana contra el neto de ContPAQi |
| NE.0.4 | **Llave de persona**: `hr.employees` poblada con `employee_code` propio + RFC/CURP/NSS, y ligada a `identity.users` y a la ficha del reloj | ⬜ | el empate por nombre (69.9 %) como piso; se cierra cuando no queda nadie sin llave |
| NE.0.5 | **El 30 % sin ficha de reloj**: decidir uno por uno si es alta pendiente, persona que no checa, o registro muerto | ⬜ | RH, con la lista del anexo |
| NE.0.6 | **Sanear el catálogo de centros**: hoy el mismo centro está escrito de varias formas y un bloque queda sin centro | ⬜ | contra los centros del ERP y los sitios del reloj |
| NE.0.7 | Vista `derive-no-copy` del histórico de la nómina del Access, **sólo lectura**, para no perder la serie desde 2011 al apagar la base | ⬜ | totales por semana contra el Access vivo |

### C1 · Dominio

| # | Item | Estado | Prueba que lo ejerce |
|---|---|---|---|
| NE.1.1 | La aritmética del recibo como regla en `libs/`: lo que recibe la persona = lo que va por banco + lo que va en efectivo, con sus ajustes y su motivo | ⬜ | contra una semana real del Access, recibo por recibo, 0 diferencias |
| NE.1.2 | **El cuadre que hoy no existe**: lo que el Access supone que va por banco contra lo que el banco dispersó, por persona y semana; la diferencia se nombra, no se absorbe | ⬜ | una semana real; toda diferencia declarada, ninguna redondeada |
| NE.1.3 | El sobre al billete (denominaciones) como regla, con su cuadre contra lo exigible | ⬜ | contra las semanas ya armadas en el Access |
| NE.1.4 | Días y horas **derivados de la asistencia**, no tecleados; lo que no se puede derivar se declara | ⬜ | contra lo capturado a mano en el Access, semana a semana |

### C2 · API

| # | Item | Estado | ¿Escribe? | Prueba contra base real |
|---|---|---|---|---|
| NE.2.1 | Consultar la nómina de una semana y su cuadre | ⬜ | no | |
| NE.2.2 | **Acuse de recibo**: registrar que la persona recibió su efectivo | ⬜ | **sí** | ⛔ obligatoria, con el payload de la pantalla |
| NE.2.3 | Generar el archivo de dispersión bancaria desde la Suite | ⬜ | no (produce archivo) | el archivo generado contra el de esa semana, byte a byte |

### C3 · UI

| # | Item | Estado | `check:pantalla` antes → después |
|---|---|---|---|
| NE.3.1 | Armado y entrega de la nómina en efectivo, con acuse | ⬜ | |
| NE.3.2 | El cuadre de la semana: banco, efectivo y la diferencia con nombre | ⬜ | |

⛔ Cargar la skill `diseno` **antes** de tocar el primer archivo. Permiso propio + entrada de sidebar. <500 ms.
⛔ **Antes del primer item C3:** sección «Observaciones de diseño UI — revisión del plan».
⛔ Esta pantalla muestra sueldos: su permiso se reparte **nominalmente**, no por puesto, y el cuadre
no se publica en ninguna pantalla general.

---

## 4. Decisiones (→ ADR)

| # | Decisión | ADR | Fecha |
|---|---|---|---|
| D1 | **Acceso a ContPAQi Nóminas**: qué rol y qué columnas. Sin esto, NE.0.3 no se puede medir y todo C1 queda sobre una hipótesis | — | ⬜ PM |
| D2 | **Cuál es la llave de la persona** en la Suite: `employee_code` propio, el código de ContPAQi, o el número del Access | — | ⬜ |
| D3 | **Calcular o sólo entregar.** Si la Suite calcula la nómina, hereda 15 años de reglas; si sólo entrega y acusa, el cálculo se queda donde está y el alcance baja mucho. **Recomendación: empezar por entregar y acusar** | — | ⬜ PM |
| D4 | **Qué es un acuse** aceptable para Dirección: firma en pantalla, huella del mismo reloj, o testigo | — | ⬜ PM |
| D5 | **Qué pasa con el archivo de dispersión** expuesto en la unidad compartida (decisión de hoy, independiente del proyecto) | — | ⬜ |
| D6 | **Qué es ContPAQi Nóminas respecto del Access**: quién manda cuando no coinciden | — | ⬜ |

---

## 5. Riesgos y bloqueos

| Bloqueo | Dueño | Causa | Qué lo destraba |
|---|---|---|---|
| ⚠️ **C0 entero** | PM | `contpaqi_nom` cerrado por permisos | D1: un GRANT de sólo lectura acotado |
| ⚠️ Sin llave de persona | RH | Dos padrones sin campo común | NE.0.4 + D2 |
| Padrón sucio | RH | Registros activos de gente que ya salió; centros escritos de varias formas | NE.0.5, NE.0.6 |
| `hr.employees` en 0 filas | RH (fase RH) | La carga de personas quedó 🧪 | Depende de la fase RH, **no de este frente** |
| El `.mdb` se corrompe antes de migrar | Sistemas | Base compartida, respaldo sin periodicidad | Respaldo programado mientras dure la migración |

---

## 6. Definición de Terminado

- [ ] 1. Métrica de la cabecera **remedida**, antes/después publicado
- [ ] 2. Cada capa verificada **o declarada NO MEDIDA** (ADR-056)
- [ ] 3. Todo endpoint que escribe **ejercido contra base real** con el payload de la pantalla
- [ ] 4. Toda compuerta nueva **rota a propósito una vez**, rojo verificado
- [ ] 5. Todo primitivo genérico en `libs/` compartido **o** deuda con nombre en el tracker
- [ ] 6. Tracker + `03_LOG_REVISIONES.md` + roadmap de `CLAUDE.md` al día
- [ ] 7. **En prod**, o escrito por qué no y qué falta
- [ ] 8. **El Access de nómina apagado**, su histórico legible desde la Suite y su respaldo final guardado

---

## 7. Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
| 2026-11-20 | Levantamiento: se encontró que el sistema ya existe en Access y que las dos mitades del pago no comparten número. Documento **sacado del repo** por ser público | Claude |
| 2026-11-23 | Medido el padrón: universo de la nómina semanal, cobertura de RFC/CURP/NSS y **69.9 %** ya identificable en la Suite. Confirmado que los dos padrones **no comparten llave**. Frente abierto como parte de RH (cupo: 9 🔨 contra 4) | Claude |
