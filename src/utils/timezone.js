/**
 * Fechas "de calendario" en la zona horaria de un negocio, solo con Intl (el proyecto no usa librería de fechas).
 * Sirve para que "este mes" empiece a las 00:00 del día 1 EN LA ZONA DEL NEGOCIO y no en UTC: una venta del 30 de septiembre
 * a las 21:00 en Lima ya es 1 de octubre 02:00 UTC.
 *
 *   inicioDelDiaEnZona(2026, 10, 1, 'America/Lima')  → 2026-10-01T05:00:00.000Z
 */
const formateadores = new Map();

const formateador = (zona) => {
  let f = formateadores.get(zona);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zona, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    formateadores.set(zona, f);
  }
  return f;
};

/** true si `zona` es un identificador IANA que este Node entiende (p. ej. "America/Lima"). */
const esZonaValida = (zona) => {
  if (typeof zona !== 'string' || !zona.trim()) return false;
  try {
    formateador(zona);
    return true;
  } catch {
    return false;
  }
};

/** Año, mes (1-12), día, hora, minuto y segundo que marca el reloj de `zona` en el instante `fecha`. */
const partesEnZona = (fecha, zona) => Object.fromEntries(
  formateador(zona).formatToParts(fecha).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)])
);

// Diferencia (ms) entre la hora de pared de `zona` y UTC en ese instante.
const desfaseMs = (instante, zona) => {
  const p = partesEnZona(instante, zona);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(instante.getTime() / 1000) * 1000;
};

/**
 * Instante UTC en que empieza el día (00:00) `anio-mes-dia` en `zona`. `mes` y `dia` pueden desbordar (mes 13 = enero del año
 * siguiente, día 32 = día 1 del mes siguiente). Se afina dos veces por si el desfase cambia ese día (horario de verano).
 */
const inicioDelDiaEnZona = (anio, mes, dia, zona) => {
  const base = Date.UTC(anio, mes - 1, dia);
  let utc = base - desfaseMs(new Date(base), zona);
  utc = base - desfaseMs(new Date(utc), zona);
  return new Date(utc);
};

module.exports = { esZonaValida, partesEnZona, inicioDelDiaEnZona };
