import amqp from 'amqplib';

import { EventDataMap } from './generated-types';
import { logger } from './helpers/logger';
import { shortRandomId } from './helpers/shortId';

interface EventsOpts {
  url: string;
  serviceName: string;
  namespace: string;
  debug?: boolean;
  canListen?: boolean;
  fanout?: boolean;
  devMode?: boolean;
}

export type EventData<T extends keyof EventDataMap> = EventDataMap[T];
type EventHandler<T extends keyof EventDataMap> = (data: EventData<T>) => void;

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

  constructor(opts: EventsOpts) {
    this.debug = opts?.debug || false;
    this.serviceName = opts.serviceName;
    this.url = opts.url;
    this.handlers = new Map();
    this.canListen = opts.canListen || false;
    this.namespace = opts.namespace;
    this.fanout = opts.fanout || false;
    this.devMode = opts.devMode || false;

    if (this.fanout) {
      this.queueName = `${this.namespace}.${this.serviceName}.${shortRandomId(
        8
      )}`;
    } else {
      this.queueName = `${this.namespace}.${this.serviceName}`;
    }
    if (this.debug) {
      logger.debug(this.queueName, 'Queue name set to');
    }
  }

  async init() {
    if (this.devMode) {
      logger.debug(
        '[EventsEngine] Running in devMode. No real RabbitMQ connection.',
        'init'
      );
      return;
    }
    try {
      this.connection = await amqp.connect(this.url);
      this.channel = await this.connection.createChannel();

      await this.channel.assertExchange(this.namespace, 'fanout', {
        durable: true,
      });

      if (this.canListen) {
        const queueOptions: amqp.Options.AssertQueue = this.fanout
          ? { exclusive: true, autoDelete: true, durable: false }
          : { durable: true, exclusive: false, autoDelete: false };

        await this.channel.assertQueue(this.queueName, queueOptions);
        await this.channel.bindQueue(this.queueName, this.namespace, '');
        logger.debug({ queue: this.queueName }, 'Worker listening on queue');

        this.listen();
      }
    } catch (error) {
      logger.error(error, 'Error initializing events engine:');
      logger.debug('init error: Retrying in 5 seconds...');

      setTimeout(() => this.init(), 5000);
    }
  }

  async emit<T extends keyof EventDataMap>(event: T, data: EventDataMap[T]) {
    if (this.devMode) {
      if (this.debug) {
        logger.debug({ event, data }, '[DevMode] Would emit event');
      }
      return;
    }

    if (!this.channel) {
      logger.warn('Events channel not initialized');
      return;
    }

    this.channel.publish(
      this.namespace,
      '',
      Buffer.from(JSON.stringify({ event, data })),
      { persistent: true }
    );

    if (this.debug) {
      logger.debug({ event, data }, 'Event emitted');
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

    await this.channel.consume(
      this.queueName,
      async (msg) => {
        if (!msg) return;

        const { event, data } = JSON.parse(msg.content.toString());

        if (this.debug) {
          logger.debug(data, `Event received: ${event}`);
        }

        if (this.handlers.has(event)) {
          try {
            this.handlers.get(event)?.(data);
          } catch (error) {
            logger.error(error, `Error handling event ${event}:`);
          }
        }

        this.channel.ack(msg);
      },
      { noAck: false }
    );
  }

  async close() {
    if (this.devMode) {
      if (this.debug) {
        logger.debug('[DevMode] Close called — nothing to clean up.', 'close');
      }
      return;
    }
    await this.channel.close();
    await this.connection.close();

    if (this.debug) {
      logger.debug(this.queueName, 'Closed connection to RabbitMQ queue');
    }
  }

  setDebug(debug: boolean) {
    this.debug = debug;
  }

  on<T extends keyof EventDataMap>(events: T | T[], handler: EventHandler<T>) {
    const eventList = Array.isArray(events) ? events : [events]; // Normalize to an array

    for (const e of eventList) {
      this.handlers.set(e, handler as (data: any) => void);
      if (this.debug) {
        logger.debug(e, 'Handler registered for event');
      }
    }
  }
}

export { EventDataMap, EventName, Events } from './generated-types';
