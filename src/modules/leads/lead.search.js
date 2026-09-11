// Extraído de lead.service.js (backlog "buscador + paginación real del
// Kanban", PR B/5) — módulo propio, sin requerir lead.service.js ni
// pipeline.service.js, a propósito: pipeline.service.js necesita reusar
// aplicarFiltroDeBusqueda() para el buscador del tablero de Pipeline, pero
// lead.service.js YA requiere pipeline.service.js (obtenerPipelineEfectivo/
// validarStageEnPipeline). Si aplicarFiltroDeBusqueda() se quedaba dentro
// de lead.service.js y pipeline.service.js la importaba de ahí, se cierra
// un ciclo real (lead.service → pipeline.service → lead.service) —
// confirmado en vivo con un require de prueba: cuando pipeline.service.js
// se carga primero, lead.service.js recibe `obtenerPipelineEfectivo`/
// `validarStageEnPipeline` como `undefined` (Node.js devuelve el
// module.exports parcial del módulo que todavía se está cargando), y
// crearLead() rompería en producción con "validarStageEnPipeline is not a
// function" — dependiendo del orden real en que Express carga las rutas,
// no algo determinístico ni fácil de notar en tests. Este archivo no
// depende de ningún service, solo del modelo — rompe el ciclo de raíz.
const mongoose = require('mongoose');
const Lead = require('./lead.model');
const { escapeRegex } = require('../../utils/regex');

/**
 * Resuelve `search` contra 2 criterios distintos y une los resultados —
 * mutando `query` para que quede filtrando por `_id: {$in:...}`. Usada por
 * lead.service.js#listarLeads() (GET /leads) y pipeline.service.js#
 * obtenerTablero() (GET /pipeline/:id/board) — mismo criterio de búsqueda
 * en los dos lugares, sin duplicar la lógica.
 *
 * IMPORTANTE — por qué son 2 queries separadas y no un solo `$or`: MongoDB
 * NO permite combinar `$text` con `$or`/`$nor` junto a otros operadores en
 * la misma query. Probado en vivo contra Mongo: `{$or:[{$text:...},
 * {phone:{$regex:...}}]}` tira `planner returned error :: caused by ::
 * No query solutions` — el índice de texto no se puede anidar dentro de un
 * `$or`. No es una limitación de este código ni una decisión de diseño
 * "simplificable" — si en algún momento alguien intenta unificar esto en
 * un solo `find()`, va a chocar con el mismo error del motor.
 *
 * `name`/`email`/`company` siguen resolviéndose por `$text` (tokenizado
 * por palabras completas — funciona bien para texto real). `phone` NO
 * puede usar `$text` (un teléfono es un solo token largo, sin espacios
 * que tokenizar: buscar "922" nunca matchea "+51922800127" por $text) —
 * se resuelve aparte, por `$regex` de substring, ver buscarPorTelefono().
 */
const aplicarFiltroDeBusqueda = async (query, search) => {
  const [porTexto, porTelefono] = await Promise.all([
    Lead.distinct('_id', { ...query, $text: { $search: search } }),
    buscarPorTelefono(query, search),
  ]);

  // ObjectId real, no string — Lead.find()/countDocuments() castean un
  // string automáticamente (por eso pasaba inadvertido con el uso
  // original, solo desde listarLeads()), pero Lead.aggregate() NO castea
  // el $match (Mongoose no aplica el casting del schema dentro de
  // pipelines de aggregate) — un `_id:{$in:["<string>"]}` ahí nunca
  // matchea nada. Encontrado al escribir el test de search de
  // obtenerTablero() (pipeline.service.js, que sí usa aggregate).
  const idsUnicos = new Set([...porTexto, ...porTelefono].map((id) => id.toString()));
  query._id = { $in: [...idsUnicos].map((id) => new mongoose.Types.ObjectId(id)) };
};

/**
 * `phone` se guarda siempre normalizado a E.164 sin separadores
 * (normalizeToE164(), utils/phone.js — ej. "+51922800127"), así que el
 * término de búsqueda se limpia de todo lo que no sea dígito con el mismo
 * criterio antes de buscarlo como substring: si no, buscar "922 800 127"
 * (con espacios, como lo escribiría alguien de forma natural) nunca
 * matchearía el dato guardado sin espacios.
 *
 * escapeRegex() es defensa en profundidad, no estrictamente necesaria hoy
 * (un string ya reducido a solo dígitos no tiene nada que escapar) — pero
 * blinda igual contra caracteres especiales de regex (rompen la query) o
 * un patrón costoso tipo ReDoS si esta función alguna vez deja de limpiar
 * antes de escapar, o el criterio de limpieza cambia.
 *
 * Sin anclar (no `^.../`): busca el substring en cualquier posición del
 * teléfono — a propósito, es justo lo que $text no podía hacer. Límite
 * conocido: un $regex sin anclar no puede resolverse con el índice de
 * `phone` (ningún índice B-tree puede indexar substrings en posición
 * arbitraria) — Mongo sí usa el índice {business:1, isDeleted:1} ya
 * existente para acotar el scan al negocio antes de aplicar el regex, así
 * que hoy es barato (cientos de leads por negocio, como mucho). Si algún
 * negocio real escala a varios miles de leads activos, esto empieza a
 * pesar — no es un problema hoy, pero no autoresolverlo con un índice
 * nuevo: no existe un índice que resuelva substrings en posición
 * arbitraria sin una solución aparte (ej. Atlas Search).
 */
const buscarPorTelefono = (query, search) => {
  const soloDigitos = search.replace(/\D/g, '');
  if (!soloDigitos) return Promise.resolve([]);

  const regex = new RegExp(escapeRegex(soloDigitos));
  return Lead.distinct('_id', { ...query, phone: regex });
};

module.exports = { aplicarFiltroDeBusqueda, buscarPorTelefono };
