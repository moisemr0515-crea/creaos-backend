const { aWhatsApp } = require('./whatsappFormat');

describe('aWhatsApp', () => {
  test.each([
    ['enlace Markdown', 'Mira [nuestra web](https://creaosapp.com) hoy', 'Mira nuestra web: https://creaosapp.com hoy'],
    ['enlace cuyo texto es la URL', '[https://a.test/x](https://a.test/x)', 'https://a.test/x'],
    ['imagen Markdown', '![logo](https://a.test/l.png)', 'https://a.test/l.png'],
    ['varios enlaces', '[A](https://a.test) y [B](https://b.test/p?q=1)', 'A: https://a.test y B: https://b.test/p?q=1'],
    ['negrita **', 'la **oferta** de hoy', 'la *oferta* de hoy'],
    ['negrita __', 'la __oferta__ de hoy', 'la *oferta* de hoy'],
    ['encabezado', '## Precios\nTodo', '*Precios*\nTodo'],
    ['viñeta con asterisco', '* uno\n* dos', '- uno\n- dos'],
    ['viñeta con guion (ya válida)', '- uno\n- dos', '- uno\n- dos'],
    ['negrita de WhatsApp (ya válida)', 'Es *muy* bueno', 'Es *muy* bueno'],
    ['cursiva de WhatsApp (ya válida)', 'Es _muy_ bueno', 'Es _muy_ bueno'],
    ['URL suelta', 'Entra a https://creaosapp.com', 'Entra a https://creaosapp.com'],
    ['paréntesis normales', 'Cuesta S/ 10 (incluye IGV)', 'Cuesta S/ 10 (incluye IGV)'],
    ['corchetes sin enlace', 'Código [A1] listo', 'Código [A1] listo'],
    ['asterisco de multiplicación', '2 * 3 = 6', '2 * 3 = 6'],
    ['texto sin formato', 'Hola, ¿en qué te ayudo?', 'Hola, ¿en qué te ayudo?'],
  ])('%s', (_n, entrada, salida) => expect(aWhatsApp(entrada)).toBe(salida));

  test('no destruye valores no string', () => {
    expect(aWhatsApp(null)).toBeNull();
    expect(aWhatsApp(undefined)).toBeUndefined();
    expect(aWhatsApp('')).toBe('');
  });

  test('es idempotente', () => {
    const una = aWhatsApp('**Hola** [web](https://a.test)\n* x');
    expect(aWhatsApp(una)).toBe(una);
  });
});
