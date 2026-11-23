# Frente NE · Los patrones a no repetir, y el plan por etapas

> **Qué es esto.** El sistema de nómina que vamos a reemplazar lleva 15 años funcionando y **hace
> bien lo difícil**: entrega el dinero correcto, cuadra al billete y coincide con el ERP al 2 %.
> Lo que hace mal no son errores sueltos: son **catorce decisiones de diseño** que se pueden nombrar,
> y que cualquier sistema nuevo repetiría por default si nadie las nombra. Este documento las nombra,
> dice qué se hace en su lugar, y ordena el trabajo en etapas.
>
> El plan, los items y las decisiones abiertas viven en
> [`FASE_RH_FRENTE_NE_NOMINA.md`](FASE_RH_FRENTE_NE_NOMINA.md). La evidencia medida de cada afirmación
> está en **[`VERDAD_ABSOLUTA.md` §40](../../VERDAD_ABSOLUTA.md)**.
>
> ⛔⛔ Repo **PÚBLICO**: acá no hay importes de dinero, sueldos, nombres, cuentas ni rutas de
> servidores. Las cifras de dinero están en §40; el detalle por persona, en el anexo privado.

---

## 1. Lo que el sistema actual hace BIEN (y que no se toca)

Nombrarlo importa: un reemplazo que pierda esto es un retroceso, por moderno que sea.

| Lo que hace bien | La evidencia |
|---|---|
| **Entrega el número correcto** | la aritmética del recibo cierra en **252 de 254** |
| **Cuadra con el ERP** | la provisión de Kepler contra la nómina: razón **0.979** en el año |
| **Llega hasta el billete** | el sobre se arma por denominación y cuadra contra lo exigible |
| **Nunca deja a nadie sin pagar** | 46 semanas de 2026 sin una sola interrupción |
| **Separa banco y efectivo por persona** | cada recibo dice cuánto va por cada vía |
| **Guarda el motivo de los ajustes** | cada cantidad de más o de menos tiene su campo de motivo |

⭐ **Regla del frente:** cada una de estas seis se convierte en una **prueba de no-regresión**. El
sistema nuevo no sale a producción sin pasarlas contra el mismo periodo.

---

## 2. Los catorce patrones a no repetir

Cada uno: qué es, qué lo demuestra, y **qué se hace en su lugar**.

### Grupo A — La identidad

**A1. El estado se DECLARA en vez de derivarse.**
*Qué pasó:* el padrón marca 2,587 personas activas y sólo 16 con salida, pero 1,300 no cobran desde
hace más de cinco años y 210 nunca cobraron.
→ **En su lugar:** el estado de una persona **se deriva del hecho** (su último pago). Si además se
declara a mano, el sistema **muestra la contradicción** en vez de elegir callado. Un campo declarado
que nadie contrasta se degrada solo.

**A2. Dos padrones sin llave común.**
*Qué pasó:* la nómina identifica por un número propio, la Suite por `(sitio, código del reloj)` y el
sistema fiscal por su propio código. Sólo se pueden unir **por el nombre escrito**, y así se liga el
73.7 %.
→ **En su lugar:** **una identidad de persona con llave propia y estable**, y todos los demás códigos
como **alias con su fuente**. ⛔ Unir personas por nombre es una medición, nunca un mecanismo de
producción.

**A3. Una columna que mezcla dos conceptos.**
*Qué pasó:* el «centro» mezcla dónde trabaja alguien con a qué área pertenece. De 34 centros, 17 son
lugares y 17 son áreas.
→ **En su lugar:** **un campo, un concepto.** Sitio y área por separado, cada uno con su catálogo.

**A4. El catálogo sin control de escritura.**
*Qué pasó:* el mismo centro escrito de seis formas distintas, y gente sin centro.
→ **En su lugar:** catálogo cerrado con llave; el texto libre no crea entidades.

### Grupo B — El tiempo y la trazabilidad

**B1. La llave de periodo escrita a mano, en texto libre.**
*Qué pasó:* la semana vive en una glosa del ERP con **555 escrituras distintas**; reconciliar por
ella falla (razón de 0.006 a 1.414) y hay semanas enteras sin etiqueta.
→ **En su lugar:** el periodo es un **dato estructurado** (año, número, fecha de inicio y fin), parte
de la llave. La glosa es para que la lea una persona, **nunca para unir**.

**B2. El mismo hecho registrado N veces sin decir cuál manda.**
*Qué pasó:* la nómina vive en cuatro tipos de documento del ERP, dos de ellos espejos; sumarlos da
**tres veces** el dinero real.
→ **En su lugar:** cada hecho tiene **un registro autoritativo declarado**. Toda vista derivada dice
de cuál sale. Ninguna consulta suma dos familias sin decirlo.

**B3. Sin bitácora de cambios.**
*Qué pasó:* nada registra quién cambió un sueldo, ni cuándo, ni qué decía antes.
→ **En su lugar:** todo cambio de dato sensible deja **quién, cuándo y el valor anterior**. Sin
excepción para administradores.

**B4. El dato que no se mide se degrada en silencio.**
*Qué pasó:* campos que existen y nadie llena — días, horas, préstamos, vacaciones, puestos—, algunos
vacíos desde hace años, pero presentes en la pantalla como si significaran algo.
→ **En su lugar:** **un campo que nadie llena no se migra.** Y lo que se migra lleva una medición de
cobertura que se revisa; si cae a cero, el sistema lo dice.

### Grupo C — El dinero

**C1. Dos números para el mismo concepto, que nunca se comparan.**
*Qué pasó:* la nómina guarda un importe de banco **fijo por persona** y entrega en efectivo «lo que
falta», mientras el banco dispersa **otra cifra** que varía cada semana. Nadie cuadra la diferencia.
→ **En su lugar:** **lo planeado y lo ocurrido se guardan por separado y se cuadran siempre.** La
diferencia tiene nombre, dueño y una pantalla donde se ve. ⛔ Un sistema que no puede mostrar la
diferencia entre lo que mandó pagar y lo que se pagó, no está terminado.

**C2. Dinero entregado sin concepto.**
*Qué pasó:* dos recibos entregan efectivo de más sin nada que lo explique.
→ **En su lugar:** **cada peso lleva su concepto**, como regla de dominio —no como validación de
pantalla, que se saltea—. Un renglón sin concepto no se puede guardar.

**C3. Un concepto «variable» que en los hechos es fijo.**
*Qué pasó:* el bono de asistencia lo cobran 154 de 155 personas, y vale exactamente lo mismo que el
de puntualidad en los 254 recibos. En la práctica es sueldo, no incentivo.
→ **En su lugar:** si un concepto **dice** depender de algo, está **ligado** a ese algo y su
condición se evalúa. Si no se evalúa nunca, se declara fijo y se deja de llamar incentivo.

**C4. La forma de pago como adjetivo en una glosa.**
*Qué pasó:* 4 de cada 10 pesos pagados en efectivo no llevan la palabra «efectivo».
→ **En su lugar:** la forma de pago es un **campo con dominio cerrado**, obligatorio, no una palabra
dentro de una frase.

### Grupo D — El control y la operación

**D1. Un solo operador cierra todo.**
*Qué pasó:* una única cuenta cerró **todas** las nóminas desde septiembre.
→ **En su lugar:** **quien arma ≠ quien autoriza ≠ quien entrega**, con permisos distintos. Es la
misma regla de ventanilla del libro de efectivo (ADR-112).

**D2. El acto físico no deja rastro.**
*Qué pasó:* el sobre se arma al billete, pero **nadie registra que la persona lo recibió**.
→ **En su lugar:** **el acto se registra donde y cuando ocurre**, con la identidad de quien recibe.
Un acuse capturado al día siguiente desde una oficina no es un acuse.

**D3. El archivo como interfaz.**
*Qué pasó:* la dispersión bancaria es un archivo de texto en la raíz de una unidad compartida, con
nombres, cuentas e importes en claro, visible para cualquiera con acceso al disco.
→ **En su lugar:** el archivo **se genera, se registra y se entrega**; no vive en una carpeta. Los
datos sensibles no viajan en claro, y quien lo generó y cuándo queda registrado.

**D4. La continuidad depende de que alguien se acuerde.**
*Qué pasó:* 36 respaldos desde 2016 sin periodicidad, el último de la carpeta de hace 20 meses, sobre
un archivo compartido que tres áreas abren a la vez.
→ **En su lugar:** respaldo automático **verificado por restauración**, no por existencia del archivo.

---

## 3. Las tres reglas que gobiernan el reemplazo

Salen de los catorce patrones y mandan sobre cualquier decisión de implementación:

1. ⭐⭐ **Nada se apaga hasta que su reemplazo corrió en paralelo y coincidió.** Una migración de
   nómina que falla significa que alguien no cobra. Cada etapa corre **en espejo** contra el sistema
   actual durante al menos cuatro semanas, y el criterio de corte es numérico, no una opinión.
2. ⭐⭐ **No se migra lo que no se usa.** El universo es **el recibo**, no la bandera: se migran ~272
   personas, no 2,587, y ningún campo vacío.
3. ⭐⭐ **No se reproduce el cálculo: se reproduce el registro.** El sistema actual casi no calcula
   —82.7 % de los recibos son el catálogo tal cual— y el cálculo fiscal ya vive en ContPAQi
   (ADR-040). Lo que falta no es un motor de nómina: es **trazabilidad, identidad y acuse**.

---

## 4. El plan, por etapas

Cada etapa: **qué entrega**, **cómo se prueba**, **qué la cierra**. Ninguna empieza sin la anterior
cerrada. Las capas C0→C3 son las de [`METODO_DE_TRABAJO.md`](../../METODO_DE_TRABAJO.md).

### Etapa 0 · La identidad y el periodo *(C0 — cimientos)*

**Sin esto, todo lo demás une personas por su nombre.** Es la única etapa que no entrega pantalla.

| Paso | Qué | Cierra cuando |
|---|---|---|
| 0.1 | Acceso de lectura mínima al sistema fiscal, sin abrir el schema | las dos vistas responden y la prueba negativa sigue en rojo |
| 0.2 | **Identidad de persona**: llave propia + alias por sistema (nómina, reloj, fiscal) | **0 personas del universo sin llave**; el empate por nombre deja de usarse |
| 0.3 | Resolver a mano los que no ligan y los que ligan con usuario inactivo | RH firma la lista, cada caso con un desenlace |
| 0.4 | **Periodo estructurado**: año, número, inicio y fin, como llave | toda semana de 2026 se nombra sin ambigüedad |
| 0.5 | Partir el centro en sitio + área, con catálogo cerrado | ninguna persona del universo sin sitio y sin área |
| 0.6 | Archivar a los que no cobran, con su última fecha de recibo como baja presunta | el padrón vivo baja de ~2,587 a ~272, y RH valida la lista |

⛔ **Gate de etapa:** una consulta que una las tres fuentes por llave —no por nombre— y devuelva el
universo completo. Con su prueba negativa: si falta una llave, se pone roja.

### Etapa 1 · El espejo *(C1 — registrar sin cambiar nada)*

La Suite registra la nómina **en paralelo**, sin que nadie cambie cómo trabaja. Sirve para una sola
cosa: demostrar que el reemplazo da el mismo número.

| Paso | Qué | Cierra cuando |
|---|---|---|
| 1.1 | La aritmética del recibo como regla en `libs/` | reproduce el periodo medido, **recibo por recibo, 0 diferencias** |
| 1.2 | El sobre por denominación como regla | el sobre calculado coincide con el armado |
| 1.3 | Lectura del sistema actual, sólo lectura, sin tocarlo | 4 semanas seguidas en espejo sin una diferencia sin explicar |

⛔ **Gate:** cuatro semanas consecutivas con diferencia cero, o con cada diferencia **nombrada**. Una
diferencia sin explicación **no se redondea**: detiene la etapa.

### Etapa 2 · El acuse *(C2 + C3 — el primer valor real)*

El hueco más grande y el más barato de cerrar. **No cambia ningún monto**: sólo registra que el
dinero llegó a su destinatario.

| Paso | Qué | Cierra cuando |
|---|---|---|
| 2.1 | Endpoint de entrega y acuse | ⛔ probado contra base real con el payload de la pantalla |
| 2.2 | Pantalla de entrega, en el lugar donde se entrega | se usa en una sucursal piloto, una semana completa |
| 2.3 | Separación de funciones: arma / autoriza / entrega | tres permisos distintos, repartidos en prod |
| 2.4 | Qué pasa cuando la persona no está | el caso tiene desenlace registrado, no un hueco |

⛔ **Gate:** una semana completa en una sucursal con **acuse en el 100 %** de las entregas, y la
prueba negativa de que sin acuse el corte no cierra.

### Etapa 3 · El cuadre que hoy no existe *(C1 + C3)*

Lo planeado contra lo ocurrido, por persona y semana. Es lo que hoy **nadie mira**.

| Paso | Qué | Cierra cuando |
|---|---|---|
| 3.1 | Guardar lo planeado y lo dispersado como **dos hechos distintos** | ambos existen por persona y semana |
| 3.2 | El cuadre, con la diferencia nombrada y con dueño | toda diferencia tiene causa o queda declarada |
| 3.3 | El cruce con el reloj, con su universo acotado | ⛔ quien no checa por su función queda **fuera del universo**, nunca «en falta» |

⛔ **Gate:** el cuadre corre sobre un periodo cerrado y **ninguna diferencia queda sin nombre**.

### Etapa 4 · La dispersión desde la Suite *(C2)*

| Paso | Qué | Cierra cuando |
|---|---|---|
| 4.1 | Generar el archivo de dispersión | **idéntico, byte a byte**, al del mismo periodo |
| 4.2 | Registrar quién lo generó, cuándo y con qué contenido | el archivo deja de vivir en una carpeta compartida |
| 4.3 | Retirar el archivo expuesto | ya no hay datos de cuentas en claro en la unidad compartida |

⛔ **Gate:** tres periodos seguidos donde el archivo generado es idéntico al que se usó.

### Etapa 5 · Apagar *(C0 + operación)*

| Paso | Qué | Cierra cuando |
|---|---|---|
| 5.1 | Respaldo automático del sistema actual, **verificado por restauración** | una restauración de prueba se abre y cuadra |
| 5.2 | El histórico desde 2011 legible desde la Suite | los totales por periodo coinciden con el original |
| 5.3 | Un periodo operado **sólo** en la Suite, con el sistema viejo de testigo | diferencia cero |
| 5.4 | Apagado, con respaldo final guardado y fechado | el sistema viejo queda en sólo lectura |

⛔ **Gate final:** el sistema viejo se apaga **sólo después** de que un periodo completo corrió sin
él y coincidió.

---

## 5. Cómo se mide que el plan va bien

Cuatro números, medidos en cada cierre de etapa. Todos tienen un valor de HOY, medido, en §40 y en el
doc del frente.

| Número | HOY | Meta |
|---|---|---|
| Personas del universo con llave propia (no por nombre) | 73.7 % ligables por nombre | 100 % por llave |
| Entregas de efectivo con acuse | ~1 % | 100 % |
| Periodos reconciliables entre nómina y ERP | el año sí, la semana no | toda semana |
| Pesos en efectivo identificables como tales | 59.3 % | 100 % |

⛔ Ninguna etapa cierra sin **remedir** su número y publicar el antes/después. Lo que no se pudo medir
se declara **NO MEDIDO** (ADR-056), nunca se dibuja como cero ni como verde.

---

## 6. Lo que este plan NO hace

- **No calcula impuestos ni timbra.** Eso es ContPAQi (ADR-040).
- **No cambia cuánto ni cómo se le paga a nadie.** Esa decisión es de Dirección; el sistema registra
  y cuadra lo que ya se decidió.
- **No migra el resto del sistema viejo.** Sus otros módulos ya están muertos: se apagan con él.
- **No copia tablas** (regla 1 y 2). El padrón se deriva y se le pone llave.

---

## 7. Las decisiones que faltan antes de construir

Viven en §4 del [doc del frente](FASE_RH_FRENTE_NE_NOMINA.md): acceso al sistema fiscal · cuál es la
llave de persona · **calcular o sólo entregar** (la medición empuja fuerte a *entregar y acusar*) ·
qué es un acuse válido · qué hacer con el archivo expuesto · quién manda cuando las dos fuentes no
coinciden.

⛔ **La Etapa 0 no arranca sin la primera.** Las demás se pueden decidir mientras la Etapa 0 corre.
