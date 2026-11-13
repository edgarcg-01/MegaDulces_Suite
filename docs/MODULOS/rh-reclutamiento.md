# Recursos Humanos › Reclutamiento

## RH.13.6 · Reclutamiento que se lee de un vistazo (2026-11-13)

### Problema

Las cuatro pestañas tenían los datos, pero costaba leerlos:

- **Candidatos:** cada fila juntaba datos sueltos sin orden, todas las ciudades revueltas, y para elegir lista y etapa
  había 12 botones parecidos en dos renglones.
- **Resumen:** abría con una franja de 5 cifras en dos renglones, con rótulos de 11 px en mayúsculas, y ninguna llevaba
  a la lista. La tabla tenía 34 números subrayados en columnas regadas a todo lo ancho, y el subtítulo era el de
  Candidatos.
- **Revisiones:** mezclaba dos preguntas, qué registros hay que corregir y cuánto tarda cada etapa. Los duplicados eran
  un renglón corrido y el nombre en naranja sobre fondo rojo no alcanzaba el contraste mínimo (4.09 contra 4.5).
- **Vacantes:** publicadas y cerradas iban revueltas, cada renglón repetía «Publicada» y el formulario tenía 11 campos
  seguidos.

### Solución

Cada pestaña contesta **una** pregunta y abre con la respuesta:

- **Candidatos — ¿a quién atiendo?** Cada fila se lee de corrido: quién es, qué busca y dónde, cuánto lleva esperando
  (con «Atrasado» si pasó la meta), su teléfono en grupos de 3-3-4 que se copia entero, y cuándo se postuló. La fila
  entera abre la ficha. La lista va **por zona** (la ciudad, como en Mega Talento). Un menú «Ver» separa lo de trabajar
  del archivo y explica cada opción; las etapas son un embudo con su cifra, numeradas y con el desenlace aparte.
- **Resumen — ¿dónde se atora el proceso?** Una frase con el veredicto, el embudo con el reparto de cada paso (dentro
  de la meta, fuera de meta, sin moverse en más de 30 días), la tabla de ciudad por paso con más tono donde se junta
  más gente, y cuánto tarda cada paso contra su meta.
- **Revisiones — ¿qué hay que corregir?** Cuántos hay arriba; quien regresó estando marcado como no recontratable, en
  una tarjeta con el motivo; y los registros duplicados en una tabla por teléfono, con etapa, origen, fecha y CV.
- **Vacantes — ¿qué se publica y dónde?** Las publicadas primero y las cerradas aparte; el formulario en cuatro
  bloques: lo que se publica, dónde se contrata, detalle y publicación.

### Cómo se implementó

- Casi todo es pantalla. Lo único del servidor es un campo: la **zona** de cada candidato (`ciudad`), calculada con la
  misma regla que ya usaban el Resumen y el filtro de ciudad. Si el servidor no la manda, la lista va plana: la
  pantalla no tiene una segunda regla que algún día cuente distinto.
- El tiempo por paso se mudó de Revisiones al Resumen.
- En teléfono, la tabla por ciudad se desliza de lado con la ciudad fija. La regla global de tablas para móvil
  escondía de la 6ª columna en adelante y dejaba «Total» junto a «Filtro»; se deshace sólo para esta tabla.
- Pruebas: la vista de RH y el módulo de candidatos, sobre `main`, con sus pruebas negativas (lista plana sin zona,
  reparto que no da negativos, y que nunca diga «nada por revisar» si una lista no se pudo leer).

### Por qué así

Una pantalla que contesta dos preguntas no contesta bien ninguna. El embudo del Resumen es el mismo de Candidatos para
que se lea igual en las dos. El color nunca va solo: junto a la barra y a la tabla siempre están las cifras.

### Pendiente

- «Por atender»: la lista de lo que toca hoy necesita que el servidor cuente sobre todos los candidatos, no sólo los
  cargados.
- Cuántos se postularon a cada vacante: hoy el candidato guarda el puesto como texto libre, sin liga a la vacante.
- Cerrar el formulario de una vacante sin guardar pierde lo escrito (como antes).

## RH.13.3 · Buscar candidatos por ciudad y teléfono dentro de la frase (2026-11-12)

### Problema

El buscador de Candidatos pedía que cada palabra estuviera en algún dato, pero sólo miraba el **nombre** y el **puesto**.
El teléfono sólo se buscaba si TODA la consulta era un número, y la ciudad nunca. «ana 351» o «almacenista morelia»
daban cero resultados aunque las personas estuvieran en la lista, y una lista vacía se lee como «no hay nadie».

### Solución

Cada palabra se busca también en la **ciudad** y en el **teléfono**: «juan 443», «almacenista morelia» o «zamora» encuentran
a la persona. El texto del buscador ahora lo dice: «Nombre, puesto, ciudad o teléfono».

### Cómo se implementó

La búsqueda es la del servidor (`applySmartSearch`, el motor común de la Suite): sin acentos ni mayúsculas, cada palabra
filtra más. Se agregaron `city_branch` y `phone_key` (los últimos 10 dígitos del teléfono) a las columnas que mira. La vía
numérica se queda para un teléfono escrito con guiones. La prueba contra la base cubre nombre+teléfono, ciudad,
nombre+ciudad, una combinación que no existe (debe dar 0) y el teléfono con espacios y con guiones. Con las columnas de
antes, nombre+teléfono da 0: así se comprobó que la prueba detecta el defecto.

### Por qué así

En el servidor, no en la pantalla: la lista llega paginada, así que filtrar en la pantalla buscaría sólo en la página que
se ve y daría cuentas falsas.
