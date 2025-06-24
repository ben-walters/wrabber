import pino, { Logger } from 'pino';

let logger: Logger;

const isLocal = process.env.IS_LOCAL === 'true';

const base = {
  name: 'events-engine',
};

if (isLocal) {
  logger = pino({
    base,
    level: process.env.LOG_LEVEL || 'info',
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
      },
    },
  });
} else {
  logger = pino({
    base,
    level: process.env.LOG_LEVEL || 'info',
  });
}

export { logger };
