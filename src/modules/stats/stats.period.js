const { AppError } = require('../../middleware/error.middleware');
const { partesEnZona, inicioDelDiaEnZona } = require('../../utils/timezone');

const DIA_MS = 24 * 60 * 60 * 1000;
const MAX_DIAS_PERSONALIZADO = 366;
const FECHA = /^(\d{4})-(\d{2})-(\d{2})$/;

// "YYYY-MM-DD" → {anio, mes, dia}, o 400 si no es una fecha real (p. ej. 2026-02-31).
const leerFecha = (texto, nombre) => {
  const m = FECHA.exec(String(texto ?? ''));
  if (!m) throw new AppError(`"${nombre}" debe tener el formato AAAA-MM-DD`, 400);
  const [anio, mes, dia] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const comprobacion = new Date(Date.UTC(anio, mes - 1, dia));
  if (comprobacion.getUTCFullYear() !== anio || comprobacion.getUTCMonth() !== mes - 1 || comprobacion.getUTCDate() !== dia) {
    throw new AppError(`"${nombre}" no es una fecha real`, 400);
  }
  return { anio, mes, dia };
};

/**
 * Periodo de Estadísticas en la zona horaria del negocio. Devuelve el rango [desde, hasta) (hasta EXCLUIDO) y el periodo
 * anterior con el que se compara.
 *   this_month / last_month: meses de calendario de `zona` (el anterior de cada uno es el mes de calendario previo).
 *   custom: `from` y `to` (AAAA-MM-DD, ambos días incluidos, en `zona`); el anterior es el tramo de igual duración justo antes.
 */
const resolverPeriodo = ({ period = 'this_month', from, to } = {}, zona, ahora = new Date()) => {
  const hoy = partesEnZona(ahora, zona);
  const inicioDeMes = (desfaseMeses) => inicioDelDiaEnZona(hoy.year, hoy.month + desfaseMeses, 1, zona);

  if (period === 'this_month') {
    return { key: period, desde: inicioDeMes(0), hasta: inicioDeMes(1), anterior: { desde: inicioDeMes(-1), hasta: inicioDeMes(0) } };
  }
  if (period === 'last_month') {
    return { key: period, desde: inicioDeMes(-1), hasta: inicioDeMes(0), anterior: { desde: inicioDeMes(-2), hasta: inicioDeMes(-1) } };
  }
  if (period === 'custom') {
    const f = leerFecha(from, 'from');
    const t = leerFecha(to, 'to');
    const desde = inicioDelDiaEnZona(f.anio, f.mes, f.dia, zona);
    const hasta = inicioDelDiaEnZona(t.anio, t.mes, t.dia + 1, zona);
    if (hasta <= desde) throw new AppError('"from" no puede ser posterior a "to"', 400);
    if (hasta - desde > MAX_DIAS_PERSONALIZADO * DIA_MS) {
      throw new AppError(`El periodo personalizado no puede pasar de ${MAX_DIAS_PERSONALIZADO} días`, 400);
    }
    return { key: period, desde, hasta, anterior: { desde: new Date(desde.getTime() - (hasta - desde)), hasta: desde } };
  }
  throw new AppError('"period" debe ser this_month, last_month o custom', 400);
};

module.exports = { resolverPeriodo, MAX_DIAS_PERSONALIZADO };
