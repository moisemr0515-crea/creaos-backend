const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

describe('configuración reproducible de Railway', () => {
  test.each(['railway.toml', 'railway.worker.toml'])('%s instala exactamente desde package-lock', (file) => {
    const config = read(file);
    expect(config).toContain('buildCommand = "npm ci --omit=dev"');
    expect(config).not.toMatch(/npm install/);
    expect(config).toContain('path = "/health"');
  });

  test('Nixpacks usa una versión mayor soportada y explícita de Node', () => {
    expect(read('.nvmrc').trim()).toBe('22');
  });
});
