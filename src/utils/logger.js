const winston = require('winston');
const { NODE_ENV } = require('../config/env');

const { combine, timestamp, printf, colorize, errors, json } = winston.format;

// Formato legible para consola en desarrollo
const formatoConsola = printf(({ level, message, timestamp, stack, ...meta }) => {
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${timestamp} [${level}]: ${stack || message}${metaStr}`;
});

const transportes = [
  // Consola siempre activa
  new winston.transports.Console({
    format: combine(
      colorize({ all: true }),
      timestamp({ format: 'HH:mm:ss' }),
      errors({ stack: true }),
      formatoConsola
    ),
  }),
];

// En producción, guardar logs en archivos
if (NODE_ENV === 'production') {
  // Requiere: npm install winston-daily-rotate-file
  const DailyRotateFile = require('winston-daily-rotate-file');

  transportes.push(
    new DailyRotateFile({
      filename: 'logs/error-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      level: 'error',
      maxFiles: '30d',
      format: combine(timestamp(), errors({ stack: true }), json()),
    }),
    new DailyRotateFile({
      filename: 'logs/combined-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: '14d',
      format: combine(timestamp(), json()),
    })
  );
}

const logger = winston.createLogger({
  level: NODE_ENV === 'production' ? 'info' : 'debug',
  defaultMeta: { servicio: 'creaos-api' },
  transports: transportes,
  // No detener el proceso en excepciones no capturadas
  exitOnError: false,
});

module.exports = logger;
