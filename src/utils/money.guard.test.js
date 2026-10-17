// GUARDIA: nadie escribe una moneda a mano en el backend. Criterio único: toda cantidad de dinero está en la moneda del
// NEGOCIO (Business.currency) y se escribe con utils/money.js#formatearImporte. Esta prueba recorre src/ y falla ante:
//   - "$${" (símbolo "$" pegado a un importe en una plantilla de texto)
//   - un código de moneda entre comillas ('USD', 'MXN', 'PEN', 'COP', 'ARS'), incluido "|| 'USD'"
// salvo en la lista corta de excepciones justificadas de abajo. Los comentarios se ignoran.
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');

// Excepciones: archivo (o carpeta, si termina en "/") relativo a src/ → motivo.
const EXCEPCIONES = {
  'config/aiPricing.js': 'tarifas de OpenAI en USD (costo interno, no dinero del negocio)',
  'modules/admin/dashboard.service.js': 'MRR y costo de OpenAI en USD (panel interno de CREA OS)',
  'modules/subscriptions/': 'planes y cobro de la suscripción de CREA OS (no es dinero del negocio)',
  'database/seeds/plans.seed.js': 'precios de los planes de CREA OS',
  'modules/businesses/currencyByCountry.js': 'tabla país → moneda por defecto (única definición permitida)',
};

const PATRONES = [
  { nombre: '"$${" (símbolo pegado a un importe)', re: /\$\$\{/ },
  { nombre: 'código de moneda escrito a mano', re: /['"`](USD|MXN|PEN|COP|ARS)['"`]/ },
];

const sinComentarios = (texto) => texto.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

const archivosJs = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const ruta = path.join(dir, e.name);
  if (e.isDirectory()) return archivosJs(ruta);
  return e.name.endsWith('.js') && !e.name.endsWith('.test.js') ? [ruta] : [];
});

const esExcepcion = (rel) => Object.keys(EXCEPCIONES).some((e) => (e.endsWith('/') ? rel.startsWith(e) : rel === e));

const buscarInfracciones = (archivos = archivosJs(SRC)) => archivos.flatMap((ruta) => {
  const rel = path.relative(SRC, ruta).split(path.sep).join('/');
  if (esExcepcion(rel)) return [];
  return sinComentarios(fs.readFileSync(ruta, 'utf-8')).split('\n').flatMap((linea, i) => (
    PATRONES.filter((p) => p.re.test(linea)).map((p) => `${rel}:${i + 1} ${p.nombre}: ${linea.trim().slice(0, 100)}`)
  ));
});

describe('guardia de moneda (backend)', () => {
  test('no hay monedas escritas a mano fuera de las excepciones justificadas', () => {
    expect(buscarInfracciones()).toEqual([]);
  });

  test('el detector SÍ detecta una moneda a mano (control interno de la guardia)', () => {
    const tmp = path.join(SRC, `__guardia_tmp_${process.pid}.js`);
    try {
      fs.writeFileSync(tmp, "const x = lead.currency || 'USD';\nconst y = `$${valor} ${m}`;\n");
      const infracciones = buscarInfracciones([tmp]);
      expect(infracciones).toHaveLength(2);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  test('cada excepción existe de verdad (la lista no se queda con rutas muertas)', () => {
    Object.keys(EXCEPCIONES).forEach((e) => expect(fs.existsSync(path.join(SRC, e))).toBe(true));
  });
});
