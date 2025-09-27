import amqp from 'amqplib';

import { EventDataMap } from './generated-types';
import { logger } from './helpers/logger';

// --- Improved Interfaces ---

// Added maxLength as a safety valve for the DLQ
interface DlqConfig {
  enabled: boolean;
  ttlDays?: number;
  maxLength?: number;
}

interface EventsOpts {
  url: string;
  serviceName: string;
  namespace: string;
  debug?: boolean;
  canListen?: boolean;
  devMode?: boolean;

  heartbeatSec?: number;
  prefetch?: number;
  connectionName?: string;
  reconnectBackoffMs?: number[];
  durable?: boolean;
  dlq?: DlqConfig;
  messageTtlMs?: number | null;
}

// A simple interface for type safety on AMQP errors
interface AmqpError extends Error {
  code: number;
}

export type EventData<T extends keyof EventDataMap> = EventDataMap[T];
type EventHandler<T extends keyof EventDataMap> = (
  data: EventData<T>
) => void | Promise<void>;

export class Wrabber {
  // --- Class Properties ---

  // Correctly typed as amqp.Connection
  private connection!: amqp.ChannelModel;
  private channel!: amqp.Channel;

  // Options (now readonly for safety)
  private readonly url: string;
  private readonly serviceName: string;
  private readonly namespace: string;
  private readonly debug: boolean;
  private readonly canListen: boolean;
  private readonly devMode: boolean;
  private readonly heartbeatSec: number;
  private readonly prefetch: number;
  private readonly durable: boolean;
  private readonly dlq: DlqConfig;
  private readonly messageTtlMs: number | null;
  private readonly reconnectBackoffMs: number[];
  private readonly connectionName: string;

  // Derived names are now readonly properties
  private readonly queueName: string;
  private readonly dlxName: string;
  private readonly dlqName: string;

  // State
  private handlers: Map<string, (data: any) => void>;
  private isConnecting = false;
  private isClosing = false;
  private consumerTag: string | null = null;

  /**
   * Refactored constructor using destructuring for clarity.
   */
  constructor(opts: EventsOpts) {
    const {
      debug = false,
      canListen = false,
      devMode = false,
      heartbeatSec = 30,
      prefetch = 50,
      durable = true,
      dlq = { enabled: false, ttlDays: 7, maxLength: 1000 },
      messageTtlMs = null,
      reconnectBackoffMs = [500, 1000, 2000, 5000, 10000, 15000, 30000],
    } = opts;

    this.url = opts.url;
    this.serviceName = opts.serviceName;
    this.namespace = opts.namespace;

    this.debug = debug;
    this.canListen = canListen;
    this.devMode = devMode;
    this.heartbeatSec = heartbeatSec;
    this.prefetch = prefetch;
    this.durable = durable;
    this.dlq = dlq;
    this.messageTtlMs = typeof messageTtlMs === 'number' ? messageTtlMs : null;
    this.reconnectBackoffMs = reconnectBackoffMs;

    this.handlers = new Map();
    const pod = process.env.POD_NAME || 'pod';
    this.connectionName =
      opts.connectionName ??
      `${this.namespace}:${this.serviceName}:${pod}:${process.pid}`;

    // Initialize derived names
    this.queueName = `${this.namespace}.${this.serviceName}`;
    this.dlxName = `${this.namespace}.dlx`;
    this.dlqName = `${this.namespace}.${this.serviceName}.dlq`;

    if (this.debug) {
      logger.debug({ queue: this.queueName }, 'Queue name set to');
    }
  }

  // --- Private Methods ---

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

  private isPreconditionFailed(err: any): err is AmqpError {
    return !!(err && err.code === 406);
  }

  /**
   * Asserts the main service queue.
   * Now uses high-level amqplib shortcuts instead of buildQueueArgs.
   */
  private async assertOrRecreateQueue() {
    const queueOptions: amqp.Options.AssertQueue = {
      durable: this.durable,
      exclusive: false,
      autoDelete: false,
    };

    if (this.dlq.enabled) {
      queueOptions.deadLetterExchange = this.dlxName;
    }
    if (this.messageTtlMs != null) {
      queueOptions.messageTtl = this.messageTtlMs;
    }

    try {
      await this.channel.assertQueue(this.queueName, queueOptions);
      await this.channel.bindQueue(this.queueName, this.namespace, '');
    } catch (e) {
      if (this.isPreconditionFailed(e)) {
        logger.warn(
          { queue: this.queueName, err: e.message },
          'Queue configuration mismatch. Attempting to delete and recreate.'
        );
        let recoveryChannel: amqp.Channel | undefined;
        try {
          recoveryChannel = await this.connection.createChannel();
          await recoveryChannel.deleteQueue(this.queueName);
          logger.warn(
            { queue: this.queueName },
            'Successfully deleted old queue. Reconnect will proceed.'
          );
        } catch (delErr) {
          logger.error(
            { queue: this.queueName, err: delErr },
            'Failed to delete queue during recovery.'
          );
        } finally {
          if (recoveryChannel) {
            try {
              await recoveryChannel.close();
            } catch {
              /* ignore */
            }
          }
        }
        throw e; // Re-throw to trigger reconnect loop
      } else {
        throw e; // Throw other errors
      }
    }
  }

  /**
   * Encapsulates all exchange/queue/binding setup in one place.
   */
  private async _setupTopology() {
    await this.channel.prefetch(this.prefetch);

    await this.channel.assertExchange(this.namespace, 'fanout', {
      durable: this.durable,
    });

    if (this.dlq.enabled) {
      await this.channel.assertExchange(this.dlxName, 'fanout', {
        durable: true,
      });

      const dlqOptions: amqp.Options.AssertQueue = {
        durable: true,
        exclusive: false,
        autoDelete: false,
      };

      if (typeof this.dlq.ttlDays === 'number' && this.dlq.ttlDays > 0) {
        dlqOptions.messageTtl = this.dlq.ttlDays * 24 * 60 * 60 * 1000;
      }
      if (typeof this.dlq.maxLength === 'number' && this.dlq.maxLength > 0) {
        dlqOptions.maxLength = this.dlq.maxLength;
      }

      await this.channel.assertQueue(this.dlqName, dlqOptions);
      await this.channel.bindQueue(this.dlqName, this.dlxName, '');
    }

    await this.assertOrRecreateQueue();
  }

  init() {
    if (this.devMode) {
      logger.debug('[Wrabber] Running in devMode.');
      return;
    }
    if (this.isConnecting || this.connection) {
      return;
    }
    this.isClosing = false;
    this.reconnectLoop();
    this.installSignalHandlers();
  }

  /**
   * Main connection loop. Now focuses on connection/channel state
   * and delegates topology setup.
   */
  private async reconnectLoop() {
    if (this.isConnecting || this.isClosing || this.connection) return;
    this.isConnecting = true;
    let attempt = 0;

    while (!this.connection && !this.isClosing) {
      attempt++;
      try {
        const url = this.withHeartbeat(this.url);
        logger.debug({ attempt }, 'Connecting to RabbitMQ');
        this.connection = await amqp.connect(url, {
          clientProperties: { connection_name: this.connectionName },
        });

        this.connection.on('error', (err) =>
          logger.warn({ err }, 'AMQP connection error')
        );
        this.connection.on('close', () => {
          logger.warn('AMQP connection closed');
          this.connection = undefined as any;
          this.channel = undefined as any;
          this.consumerTag = null;
          if (!this.isClosing) this.reconnectLoop();
        });

        this.channel = await this.connection.createChannel();
        this.channel.on('error', (err) => {
          if (this.isPreconditionFailed(err)) return; // Suppress expected error
          logger.warn({ err }, 'An unexpected AMQP channel error occurred');
        });
        this.channel.on('close', () => logger.warn('AMQP channel closed'));

        await this._setupTopology();

        if (this.canListen) {
          await this.listen();
        }

        this.isConnecting = false;
        logger.debug('Connected and topology asserted');
        return;
      } catch (err) {
        const backoff =
          this.reconnectBackoffMs[
            Math.min(attempt - 1, this.reconnectBackoffMs.length - 1)
          ];
        logger.warn({ err, backoff }, 'Connection failed; backing off');

        if (this.connection) {
          try {
            await this.connection.close();
          } catch {}
          this.connection = undefined as any;
        }

        await new Promise((r) => setTimeout(r, backoff));
      }
    }
    this.isConnecting = false;
  }

  // --- Public API Methods ---

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
    this.channel.publish(this.namespace, '', payload, {
      persistent: true,
      contentType: 'application/json',
    });
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

        let parsed: { event?: string; data?: unknown };
        try {
          parsed = JSON.parse(msg.content.toString());
        } catch (e) {
          logger.warn({ e }, 'Invalid JSON message; nack to DLQ');
          this.channel.nack(msg, false, false);
          return;
        }

        const { event, data } = parsed;

        // Log if the message is a retry, which can indicate consumer crashes
        if (msg.fields.redelivered) {
          logger.warn(
            { event },
            'Processing a redelivered message. This may indicate a previous processing failure or crash.'
          );
        }

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
          logger.warn({ event }, 'No handler for event; nacking to DLQ');
          this.channel.nack(msg, false, false);
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
    (this as any).debug = debug;
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
      await this.close();
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  }
}

export { EventDataMap, EventName, Events } from './generated-types';
