import amqp from 'amqplib';

import { EventDataMap } from './generated-types';
import { logger } from './helpers/logger';

interface DlqConfig {
  enabled: boolean;
}

interface EventsOpts {
  url: string;
  serviceName: string;
  namespace: string;
  debug?: boolean;
  canListen?: boolean;
  fanout?: boolean; // kept for backward compat; not used for durable queues
  devMode?: boolean;

  heartbeatSec?: number; // default 30
  prefetch?: number; // default 50
  connectionName?: string; // deterministic default if not provided
  reconnectBackoffMs?: number[]; // default sequence
  durable?: boolean; // default true
  dlq?: DlqConfig; // default { enabled: true }
  messageTtlMs?: number | null; // default null (no TTL)
}

export type EventData<T extends keyof EventDataMap> = EventDataMap[T];
type EventHandler<T extends keyof EventDataMap> = (
  data: EventData<T>
) => void | Promise<void>;

export class Wrabber {
  private connection!: amqp.ChannelModel;
  private channel!: amqp.Channel;

  private debug: boolean;
  private url: string;
  private queueName: string;
  private namespace: string;
  private serviceName: string;
  private handlers: Map<string, (data: any) => void>;
  private canListen: boolean;
  private fanout: boolean;
  private devMode: boolean;

  private heartbeatSec: number;
  private prefetch: number;
  private durable: boolean;
  private dlq: DlqConfig;
  private messageTtlMs: number | null;
  private reconnectBackoffMs: number[];
  private connectionName: string;

  private isConnecting = false;
  private isClosing = false;
  private consumerTag: string | null = null;

  constructor(opts: EventsOpts) {
    this.debug = opts?.debug || false;
    this.serviceName = opts.serviceName;
    this.url = opts.url;
    this.handlers = new Map();
    this.canListen = opts.canListen || false;
    this.namespace = opts.namespace;
    this.fanout = opts.fanout || false; // preserved but we now always use durable named queue
    this.devMode = opts.devMode || false;

    // Defaults per requirements
    this.heartbeatSec = opts.heartbeatSec ?? 30;
    this.prefetch = opts.prefetch ?? 50;
    this.durable = opts.durable ?? true;
    this.dlq = opts.dlq ?? { enabled: true };
    this.messageTtlMs =
      typeof opts.messageTtlMs === 'number' ? opts.messageTtlMs : null;
    this.reconnectBackoffMs = opts.reconnectBackoffMs ?? [
      500, 1000, 2000, 5000, 10000, 15000, 30000,
    ];

    const pod = process.env.POD_NAME || 'pod';
    this.connectionName =
      opts.connectionName ??
      `${this.namespace}:${this.serviceName}:${pod}:${process.pid}`;

    // Always durable per-service queue: ${namespace}.${serviceName}
    this.queueName = `${this.namespace}.${this.serviceName}`;

    if (this.debug) {
      logger.debug({ queue: this.queueName }, 'Queue name set to');
    }
  }

  private withHeartbeat(u: string): string {
    try {
      const url = new URL(u);
      if (!url.searchParams.has('heartbeat')) {
        url.searchParams.set('heartbeat', String(this.heartbeatSec));
        return url.toString();
      }
      return u;
    } catch {
      if (!/[?&]heartbeat=/.test(u)) {
        const sep = u.includes('?') ? '&' : '?';
        return `${u}${sep}heartbeat=${this.heartbeatSec}`;
      }
      return u;
    }
  }

  async init() {
    if (this.devMode) {
      logger.debug(
        '[Wrabber] Running in devMode. No real RabbitMQ connection.',
        'init'
      );
      return;
    }
    if (this.isConnecting || this.connection) {
      return;
    }
    this.isConnecting = true;
    this.isClosing = false;

    const connectOnce = async () => {
      const url = this.withHeartbeat(this.url);
      try {
        this.connection = await amqp.connect(url, {
          clientProperties: { connection_name: this.connectionName },
        });
        this.connection.on('error', (err) => {
          logger.warn({ err }, 'AMQP connection error');
        });
        this.connection.on('close', () => {
          logger.warn('AMQP connection closed');
          // trigger reconnect
          this.connection = undefined as any;
          this.channel = undefined as any;
          this.consumerTag = null;
          if (!this.isClosing) this.reconnectLoop();
        });

        this.channel = await this.connection.createChannel();
        this.channel.on('error', (err) => {
          logger.warn({ err }, 'AMQP channel error');
        });
        this.channel.on('close', () => {
          logger.warn('AMQP channel closed');
        });

        await this.channel.prefetch(this.prefetch);

        await this.channel.assertExchange(this.namespace, 'fanout', {
          durable: this.durable,
        });

        const dlxName = `${this.namespace}.dlx`;
        if (this.dlq.enabled) {
          await this.channel.assertExchange(dlxName, 'fanout', {
            durable: true,
          });
        }

        const args: Record<string, any> = {};
        if (this.dlq.enabled) {
          args['x-dead-letter-exchange'] = dlxName;
        }
        if (this.messageTtlMs != null) {
          args['x-message-ttl'] = this.messageTtlMs;
        }

        await this.channel.assertQueue(this.queueName, {
          durable: this.durable,
          exclusive: false,
          autoDelete: false,
          arguments: Object.keys(args).length ? args : undefined,
        });

        await this.channel.bindQueue(this.queueName, this.namespace, '');

        if (this.dlq.enabled) {
          const dlqName = `${this.namespace}.${this.serviceName}.dlq`;
          await this.channel.assertQueue(dlqName, {
            durable: true,
            exclusive: false,
            autoDelete: false,
          });
          await this.channel.bindQueue(dlqName, dlxName, '');
        }

        if (this.canListen) {
          await this.listen();
        }

        this.isConnecting = false;
        if (this.debug) logger.debug('AMQP connected and topology ready');
      } catch (error) {
        logger.error(error, 'Error initializing Wrabber:');
        this.isConnecting = false;
        logger.debug('init error: Retrying in 5 seconds...');
        setTimeout(() => this.init(), 5000);
      }
    };

    await connectOnce();
    this.installSignalHandlers();
  }

  private async reconnectLoop() {
    if (this.isConnecting || this.isClosing || this.connection) return;
    this.isConnecting = true;
    let attempt = 0;

    while (!this.connection && !this.isClosing) {
      attempt++;
      try {
        const url = this.withHeartbeat(this.url);
        logger.debug({ attempt }, 'Reconnecting to RabbitMQ');
        this.connection = await amqp.connect(url, {
          clientProperties: { connection_name: this.connectionName },
        });

        this.connection.on('error', (err) => {
          logger.warn({ err }, 'AMQP connection error (reconnect)');
        });
        this.connection.on('close', () => {
          logger.warn('AMQP connection closed (reconnect)');
          this.connection = undefined as any;
          this.channel = undefined as any;
          this.consumerTag = null;
          if (!this.isClosing) this.reconnectLoop();
        });

        this.channel = await this.connection.createChannel();
        this.channel.on('error', (err) => {
          logger.warn({ err }, 'AMQP channel error (reconnect)');
        });
        this.channel.on('close', () => {
          logger.warn('AMQP channel closed (reconnect)');
        });

        await this.channel.prefetch(this.prefetch);

        // Re-assert topology
        await this.channel.assertExchange(this.namespace, 'fanout', {
          durable: this.durable,
        });

        const dlxName = `${this.namespace}.dlx`;
        if (this.dlq.enabled) {
          await this.channel.assertExchange(dlxName, 'fanout', {
            durable: true,
          });
        }

        const args: Record<string, any> = {};
        if (this.dlq.enabled) args['x-dead-letter-exchange'] = dlxName;
        if (this.messageTtlMs != null)
          args['x-message-ttl'] = this.messageTtlMs;

        await this.channel.assertQueue(this.queueName, {
          durable: this.durable,
          exclusive: false,
          autoDelete: false,
          arguments: Object.keys(args).length ? args : undefined,
        });

        await this.channel.bindQueue(this.queueName, this.namespace, '');

        if (this.dlq.enabled) {
          const dlqName = `${this.namespace}.${this.serviceName}.dlq`;
          await this.channel.assertQueue(dlqName, {
            durable: true,
            exclusive: false,
            autoDelete: false,
          });
          await this.channel.bindQueue(dlqName, dlxName, '');
        }

        if (this.canListen) {
          await this.listen();
        }

        this.isConnecting = false;
        logger.debug('Reconnected and topology reasserted');
        return;
      } catch (err) {
        const backoff =
          this.reconnectBackoffMs[
            Math.min(attempt - 1, this.reconnectBackoffMs.length - 1)
          ];
        logger.warn({ err, backoff }, 'Reconnect failed; backing off');
        await new Promise((r) => setTimeout(r, backoff));
      }
    }

    this.isConnecting = false;
  }

  async emit<T extends keyof EventDataMap>(event: T, data: EventDataMap[T]) {
    if (this.devMode) {
      if (this.debug) {
        logger.debug({ event, data }, '[DevMode] Would emit event');
      }
      return;
    }

    if (!this.channel) {
      logger.warn('Events channel not initialized; dropping emit');
      return;
    }

    const payload = Buffer.from(JSON.stringify({ event, data }), 'utf8');
    const ok = this.channel.publish(this.namespace, '', payload, {
      persistent: true,
      contentType: 'application/json',
    });
    if (!ok) {
      await new Promise<void>((resolve) => this.channel.once('drain', resolve));
    }

    if (this.debug) {
      logger.debug({ event, size: payload.length }, 'Event emitted');
    }
  }

  async listen() {
    if (this.devMode) {
      if (this.debug) {
        logger.debug('[DevMode] Skipping listening for events.');
      }
      return;
    }
    if (!this.channel) {
      logger.warn('Events channel not initialized');
      return;
    }

    if (this.consumerTag) {
      try {
        await this.channel.cancel(this.consumerTag);
      } catch {
        // IGNORE
      }
      this.consumerTag = null;
    }

    const res = await this.channel.consume(
      this.queueName,
      async (msg) => {
        if (!msg) return;

        let parsed: any;
        try {
          parsed = JSON.parse(msg.content.toString());
        } catch (e) {
          logger.warn({ e }, 'Invalid JSON message; nack to DLQ');
          this.channel.nack(msg, false, false);
          return;
        }

        const event = parsed?.event;
        const data = parsed?.data;

        if (this.debug) {
          logger.debug({ event }, `Event received`);
        }

        const handler = event ? this.handlers.get(event) : undefined;

        if (handler) {
          try {
            await handler(data);
            this.channel.ack(msg);
          } catch (error) {
            logger.error(error, `Error handling event ${event}:`);
            this.channel.nack(msg, false, false);
          }
        } else {
          if (this.dlq.enabled) {
            logger.warn({ event }, 'No handler; nacking to DLQ');
            this.channel.nack(msg, false, false);
          } else {
            logger.warn({ event }, 'No handler; DLQ disabled; acking');
            this.channel.ack(msg);
          }
        }
      },
      { noAck: false }
    );

    this.consumerTag = res.consumerTag;
    logger.debug(
      { queue: this.queueName, prefetch: this.prefetch },
      'Worker listening on queue'
    );
  }

  async close() {
    this.isClosing = true;

    if (this.devMode) {
      if (this.debug) {
        logger.debug('[DevMode] Close called — nothing to clean up.', 'close');
      }
      return;
    }

    try {
      if (this.channel) {
        if (this.consumerTag) {
          try {
            await this.channel.cancel(this.consumerTag);
          } catch {
            /* ignore */
          }
          this.consumerTag = null;
        }
        await this.channel.close();
      }
    } catch (e) {
      logger.warn({ e }, 'Error closing channel');
    }

    try {
      if (this.connection) {
        await this.connection.close();
      }
    } catch (e) {
      logger.warn({ e }, 'Error closing connection');
    }

    if (this.debug) {
      logger.debug(this.queueName, 'Closed connection to RabbitMQ queue');
    }

    this.isConnecting = false;
  }

  setDebug(debug: boolean) {
    this.debug = debug;
  }

  on<T extends keyof EventDataMap>(events: T | T[], handler: EventHandler<T>) {
    const eventList = Array.isArray(events) ? events : [events];
    for (const e of eventList) {
      this.handlers.set(e as string, handler as (data: any) => void);
      if (this.debug) {
        logger.debug(e, 'Handler registered for event');
      }
    }
  }

  private installSignalHandlers() {
    const onSignal = async (sig: NodeJS.Signals) => {
      logger.debug({ sig }, 'Signal received; closing AMQP');
      try {
        await this.close();
      } catch {
        /* ignore */
      }
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  }
}

export { EventDataMap, EventName, Events } from './generated-types';
