import pino, { Logger } from 'pino';

const logger: Logger = pino({
  base: {
    name: 'WRABBER',
  },
  level: process.env.LOG_LEVEL || 'info',
});

export { logger };
