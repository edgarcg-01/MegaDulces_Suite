# Recursos Humanos › Reclutamiento

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
