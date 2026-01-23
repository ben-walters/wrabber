import amqp from 'amqplib';

import { EventDataMap } from './generated-types';
import { logger } from './helpers/logger';

interface DlqConfig {
  enabled: boolean;
  ttlMins?: number;
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
  messageTtlMins?: number | null;
  unhandledEventAction?: 'ack' | 'nack';
}

interface AmqpError extends Error {
  code: number;
}

export type EventData<T extends keyof EventDataMap> = EventDataMap[T];
type EventHandler<T extends keyof EventDataMap> = (
  data: EventData<T>
) => void | Promise<void>;

export class Wrabber {
  private connection!: amqp.ChannelModel;
  private channel!: amqp.Channel;

  private initialised = false;

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
  private readonly messageTtlMins: number | null;
  private readonly reconnectBackoffMs: number[];
  private readonly connectionName: string;
  private unhandledEventAction: 'ack' | 'nack' = 'ack';

  private readonly queueName: string;
  private readonly dlxName: string;
  private readonly dlqName: string;

  private handlers: Map<string, (data: any) => void>;
  private isConnecting = false;
  private isClosing = false;
  private consumerTag: string | null = null;

  private readyPromise!: Promise<void>;
  private resolveReady!: () => void;

  constructor(opts: EventsOpts) {
    const {
      debug = false,
      canListen = false,
      devMode = false,
      heartbeatSec = 30,
      prefetch = 10,
      durable = true,
      dlq = { enabled: false, ttlDays: 7, maxLength: 1000 },
      messageTtlMins = null,
      reconnectBackoffMs = [500, 1000, 2000, 5000, 10000, 15000, 30000],
      unhandledEventAction = 'ack',
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
    this.messageTtlMins =
      typeof messageTtlMins === 'number' ? messageTtlMins : null;
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
    this.unhandledEventAction = unhandledEventAction;

    // Initialize the ready promise when the instance is created
    this.resetReadyState();

    if (this.debug) {
      logger.debug({ queue: this.queueName }, '[Wrabber] Queue name set to');
    }
  }

  /**
   * Creates a new, unresolved promise for the connection state.
   * This acts as a gate for operations like emit().
   */
  private resetReadyState() {
    this.readyPromise = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
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

  private isPreconditionFailed(err: any): err is AmqpError {
    return !!(err && err.code === 406);
  }

  private async assertOrRecreateQueue() {
    const queueOptions: amqp.Options.AssertQueue = {
      durable: this.durable,
      exclusive: false,
      autoDelete: false,
    };

    if (this.dlq.enabled) {
      queueOptions.deadLetterExchange = this.dlxName;
    }
    if (this.messageTtlMins != null) {
      queueOptions.messageTtl = this.messageTtlMins * 60 * 1000;
    }

    try {
      await this.channel.assertQueue(this.queueName, queueOptions);
      await this.channel.bindQueue(this.queueName, this.namespace, '');
    } catch (e) {
      if (this.isPreconditionFailed(e)) {
        logger.warn(
          { queue: this.queueName, err: e.message },
          '[Wrabber] Queue configuration mismatch. Attempting to delete and recreate.'
        );
        let recoveryChannel: amqp.Channel | undefined;
        try {
          recoveryChannel = await this.connection.createChannel();
          await recoveryChannel.deleteQueue(this.queueName);
          logger.warn(
            { queue: this.queueName },
            '[Wrabber] Successfully deleted old queue. Reconnect will proceed.'
          );
        } catch (delErr) {
          logger.error(
            { queue: this.queueName, err: delErr },
            '[Wrabber] Failed to delete queue during recovery.'
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

      if (typeof this.dlq.ttlMins === 'number' && this.dlq.ttlMins > 0) {
        dlqOptions.messageTtl = this.dlq.ttlMins * 60 * 1000;
      }
      if (typeof this.dlq.maxLength === 'number' && this.dlq.maxLength > 0) {
        dlqOptions.maxLength = this.dlq.maxLength;
      }

      await this.channel.assertQueue(this.dlqName, dlqOptions);
      await this.channel.bindQueue(this.dlqName, this.dlxName, '');
    }

    await this.assertOrRecreateQueue();
  }

  async init(): Promise<void> {
    if (this.devMode) {
      logger.debug('[Wrabber] Running in devMode.');
      return;
    }
    if (this.isConnecting || this.connection) {
      // If connection is already happening or done, just wait for it to be ready
      return this.readyPromise;
    }
    this.isClosing = false;
    this.reconnectLoop(); // Start the connection loop in the background
    this.installSignalHandlers();
    logger.debug('[Wrabber] Initialization started, awaiting connection...');
    this.initialised = true;

    // Return the promise that will resolve when the connection is established
    return this.readyPromise;
  }

  /**
   * Main connection loop.
   */
  private async reconnectLoop() {
    if (this.isConnecting || this.isClosing || this.connection) return;
    this.isConnecting = true;
    let attempt = 0;

    while (!this.connection && !this.isClosing) {
      logger.info('[Wrabber] Attempting to connect to RabbitMQ...');
      attempt++;
      try {
        const url = this.withHeartbeat(this.url);
        logger.debug({ attempt }, '[Wrabber] Connecting to RabbitMQ');
        this.connection = await amqp.connect(url, {
          clientProperties: { connection_name: this.connectionName },
        });

        this.connection.on('error', (err) =>
          logger.warn({ err }, '[Wrabber] AMQP connection error')
        );
        this.connection.on('close', () => {
          logger.warn('[Wrabber] AMQP connection closed');
          this.connection = undefined as any;
          this.channel = undefined as any;
          this.consumerTag = null;
          // Reset the ready state for the next connection attempt
          this.resetReadyState();
          if (!this.isClosing) this.reconnectLoop();
        });

        this.channel = await this.connection.createChannel();
        this.channel.on('error', (err) => {
          if (this.isPreconditionFailed(err)) return; // Suppress expected error
          logger.warn(
            { err },
            '[Wrabber] An unexpected AMQP channel error occurred'
          );
        });

        this.channel.on('close', () =>
          logger.warn('[Wrabber] AMQP channel closed')
        );

        await this._setupTopology();

        if (this.canListen) {
          await this.listen();
        }

        this.isConnecting = false;
        logger.debug('[Wrabber] Connected and topology asserted');

        // Resolve the promise, signaling that the Wrabber is ready!
        this.resolveReady();

        return; // Exit the loop on successful connection
      } catch (err) {
        const backoff =
          this.reconnectBackoffMs[
            Math.min(attempt - 1, this.reconnectBackoffMs.length - 1)
          ];
        logger.warn(
          { err, backoff },
          '[Wrabber] Connection failed; backing off'
        );

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

  async emit<T extends keyof EventDataMap>(event: T, data: EventDataMap[T]) {
    if (this.devMode) {
      if (this.debug) {
        logger.debug({ event, data }, '[Wrabber] [DevMode] Would emit event');
      }
      return;
    }

    if (!this.initialised) {
      logger.error('[Wrabber] Emit called before init(); dropping emit.');
      return;
    }

    // Wait for the connection to be ready before proceeding.
    // This handles both initial connection and reconnections gracefully.
    await this.readyPromise;

    // This check is now mostly for type-safety, as readyPromise ensures it exists.
    if (!this.channel) {
      logger.error(
        '[Wrabber] Channel is unexpectedly not available after ready signal. Dropping emit.'
      );
      return;
    }

    if (this.debug) {
      logger.debug({ event, data }, '[Wrabber] Emitting event');
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
        logger.debug('[Wrabber] [DevMode] Skipping listening for events.');
      }
      return;
    }
    if (!this.channel) {
      logger.warn('[Wrabber] Events channel not initialized');
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
          logger.warn({ e }, '[Wrabber] Invalid JSON message; nack to DLQ');
          this.channel.nack(msg, false, false);
          return;
        }

        const { event, data } = parsed;

        if (msg.fields.redelivered) {
          logger.warn(
            { event },
            '[Wrabber] Processing a redelivered message. This may indicate a previous processing failure or crash.'
          );
        }

        if (this.debug) {
          logger.debug({ event }, '[Wrabber] Event received');
        }

        const handler = event ? this.handlers.get(event) : undefined;
        if (handler) {
          try {
            await handler(data);
            this.channel.ack(msg);
            if (this.debug) {
              logger.debug(`[Wrabber] Successfully handled event ${event}:`);
            }
          } catch (error) {
            logger.error(error, `[Wrabber] Error handling event ${event}:`);
            this.channel.nack(msg, false, false);
          }
        } else {
          logger.warn({ event }, '[Wrabber] No handler for event');
          if (this.unhandledEventAction === 'ack') {
            this.channel.ack(msg);
          } else {
            this.channel.nack(msg, false, false);
          }
        }
      },
      { noAck: false }
    );

    this.consumerTag = res.consumerTag;
    logger.debug(
      { queue: this.queueName, prefetch: this.prefetch },
      '[Wrabber] Worker listening on queue'
    );
  }

  async close() {
    this.isClosing = true;

    if (this.devMode) {
      if (this.debug) {
        logger.debug(
          '[Wrabber] [DevMode] Close called — nothing to clean up.',
          'close'
        );
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
      logger.warn({ e }, '[Wrabber] Error closing channel');
    }

    try {
      if (this.connection) {
        await this.connection.close();
      }
    } catch (e) {
      logger.warn({ e }, '[Wrabber] Error closing connection');
    }

    if (this.debug) {
      logger.debug(
        this.queueName,
        '[Wrabber] Closed connection to RabbitMQ queue'
      );
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
        logger.debug(e, '[Wrabber] Handler registered for event');
      }
    }
  }

  private installSignalHandlers() {
    const onSignal = async (sig: NodeJS.Signals) => {
      logger.debug({ sig }, '[Wrabber] Signal received; closing AMQP');
      await this.close();
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  }
}

export { EventDataMap, EventName, Events } from './generated-types';
export default Wrabber;
