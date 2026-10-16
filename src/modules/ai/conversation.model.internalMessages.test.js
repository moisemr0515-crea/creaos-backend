// FASE 3 / ETAPA B / P2 — la API no entrega mensajes internos del agente (resultado de herramientas y turnos vacíos
// que solo piden herramientas). Un solo punto: el toJSON del modelo. El historial guardado no cambia.
const mongoose = require('mongoose');
const Conversation = require('./conversation.model');
const { esMensajeInterno } = Conversation;

const tool = { role: 'tool', content: '{"success":true}', toolCallId: 'c1', name: 'search_products' };
const pideTool = { role: 'assistant', content: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' } }] };
const respuesta = { role: 'assistant', content: 'Hola, ¿en qué te ayudo?' };
const conMedia = { role: 'assistant', content: '[Imagen]', mediaUrl: 'https://x.test/a.png', mediaType: 'image', toolCalls: [] };
const pideToolConTexto = { role: 'assistant', content: 'Déjame revisar.', toolCalls: pideTool.toolCalls };

describe('esMensajeInterno', () => {
  test.each([
    ['resultado de herramienta', tool, true],
    ['turno del asistente que solo pide herramientas', pideTool, true],
    ['turno que pide herramientas pero trae texto', pideToolConTexto, false],
    ['respuesta normal', respuesta, false],
    ['adjunto de la IA', conMedia, false],
    ['mensaje del lead', { role: 'user', content: 'hola' }, false],
    ['mensaje de sistema', { role: 'system', content: 'Escalada' }, false],
    ['asistente vacío sin herramientas', { role: 'assistant', content: '' }, false],
  ])('%s', (_n, m, esperado) => expect(esMensajeInterno(m)).toBe(esperado));
});

describe('Conversation#toJSON', () => {
  const crear = (messages) => new Conversation({ business: new mongoose.Types.ObjectId(), lead: new mongoose.Types.ObjectId(), messages });

  test('serializa solo lo que un humano debe ver, en orden, y no toca el documento', () => {
    const conv = crear([{ role: 'user', content: 'hola' }, pideTool, tool, respuesta]);
    const json = JSON.parse(JSON.stringify(conv));
    expect(json.messages.map((m) => m.content)).toEqual(['hola', 'Hola, ¿en qué te ayudo?']);
    expect(conv.messages).toHaveLength(4); // el modelo conserva su historial completo
  });

  test('sin messages (select -messages) no falla', () => {
    const conv = crear([]);
    conv.messages = undefined;
    expect(() => JSON.parse(JSON.stringify(conv))).not.toThrow();
  });
});
