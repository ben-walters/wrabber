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

type EventData<T extends keyof EventDataMap> = EventDataMap[T];
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

  private isPreconditionFailed(err: any): boolean {
    // This is the specific AMQP error code for a parameter mismatch.
    return !!(err && err.code === 406);
  }

  private buildQueueArgs(): Record<string, any> | undefined {
    const args: Record<string, any> = {};
    const dlxName = `${this.namespace}.dlx`;
    if (this.dlq.enabled) {
      args['x-dead-letter-exchange'] = dlxName;
    }
    if (this.messageTtlMs != null) {
      args['x-message-ttl'] = this.messageTtlMs;
    }
    return Object.keys(args).length ? args : undefined;
  }

  /**
   * *** MODIFIED METHOD ***
   * This is the corrected implementation that handles the "Channel Closed" error.
   */
  private async assertOrRecreateQueue(queueName: string) {
    const args = this.buildQueueArgs();
    const queueOptions = {
      durable: this.durable,
      exclusive: false,
      autoDelete: false,
      arguments: args,
    };

    try {
      await this.channel.assertQueue(queueName, queueOptions);
      await this.channel.bindQueue(queueName, this.namespace, '');
    } catch (e) {
      if (this.isPreconditionFailed(e)) {
        // The original channel is now closed and unusable.
        logger.warn(
          { queue: queueName, err: (e as Error).message },
          'Queue configuration mismatch detected. The channel was closed by the server. Attempting to delete the old queue with a temporary channel.'
        );

        let recoveryChannel: amqp.Channel | undefined;
        try {
          // Create a NEW, temporary channel just for this cleanup operation.
          recoveryChannel = await this.connection.createChannel();
          await recoveryChannel.deleteQueue(queueName);
          logger.warn(
            { queue: queueName },
            'Successfully deleted the old queue. The connection will now be re-established.'
          );
        } catch (delErr) {
          // This might fail if another pod deleted it first, which is okay.
          logger.error(
            { queue: queueName, err: delErr },
            'Failed to delete queue during recovery. Manual intervention may be required.'
          );
        } finally {
          // Always try to close the temporary channel.
          if (recoveryChannel) {
            try {
              await recoveryChannel.close();
            } catch {
              /* ignore close errors on the temp channel */
            }
          }
        }

        // IMPORTANT: Re-throw the original error. This will cause the init()/reconnectLoop()
        // to fail this attempt and schedule a proper reconnect. The *next* attempt
        // will succeed because we have just deleted the problematic queue.
        throw e;
      } else {
        // It was some other error, let the main loop handle it.
        throw e;
      }
    }
  }

  /**
   * *** MODIFIED METHOD ***
   * Refactored to be a simple, non-async wrapper around the robust reconnectLoop.
   * This avoids code duplication and a potential race condition on init failure.
   */
  init() {
    if (this.devMode) {
      logger.debug(
        '[Wrabber] Running in devMode. No real RabbitMQ connection.'
      );
      return;
    }
    // Prevent multiple concurrent init calls
    if (this.isConnecting || this.connection) {
      return;
    }

    this.isClosing = false;
    this.reconnectLoop(); // This runs in the background
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
        logger.debug({ attempt }, 'Connecting to RabbitMQ');
        this.connection = await amqp.connect(url, {
          clientProperties: { connection_name: this.connectionName },
        });

        this.connection.on('error', (err) => {
          logger.warn({ err }, 'AMQP connection error');
        });
        this.connection.on('close', () => {
          logger.warn('AMQP connection closed');
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

        // Assert topology
        await this.channel.assertExchange(this.namespace, 'fanout', {
          durable: this.durable,
        });

        const dlxName = `${this.namespace}.dlx`;
        if (this.dlq.enabled) {
          await this.channel.assertExchange(dlxName, 'fanout', {
            durable: true,
          });
        }

        // This method now contains the full recovery logic
        await this.assertOrRecreateQueue(this.queueName);

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
        logger.debug('Connected and topology asserted');
        return; // Exit the while loop on success
      } catch (err) {
        // The assertOrRecreateQueue will throw on mismatch, landing us here.
        // This is the desired behavior for triggering a clean retry.
        const backoff =
          this.reconnectBackoffMs[
            Math.min(attempt - 1, this.reconnectBackoffMs.length - 1)
          ];
        logger.warn({ err, backoff }, 'Connection failed; backing off');

        // Clean up any failed connection attempts
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
      // In a real app, you might want to force exit after a timeout
      // setTimeout(() => process.exit(1), 5000).unref();
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  }
}

export { EventDataMap, EventName, Events } from './generated-types';
