const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

describe('configuración reproducible de Railway', () => {
  // "npm ci --omit=dev" (reproducibilidad exacta del lockfile) se revirtió
  // el 16/sep/2026: rompía el build en Railway con EBUSY al hacer rmdir de
  // /app/node_modules/.cache (cache mount de Nixpacks que choca con la
  // limpieza que hace npm ci) — bloqueó 3 deploys seguidos por más de 24h.
  // Pendiente como mejora técnica (ver comentario en railway.toml):
  // recuperarlo vía nixpacks.toml [phases.install] en vez de buildCommand.
  test.each(['railway.toml', 'railway.worker.toml'])('%s usa un build command válido y healthcheck configurado', (file) => {
    const config = read(file);
    expect(config).toContain('buildCommand = "npm install --production=false"');
    expect(config).toContain('path = "/health"');
  });

  test('Nixpacks usa una versión mayor soportada y explícita de Node', () => {
    expect(read('.nvmrc').trim()).toBe('22');
  });
});
