# EventsEngine

## Overview

`EventsEngine` is a lightweight event-driven messaging system built on top of RabbitMQ. It enables easy message publishing and subscription through a single queue, making it ideal for microservices communication and event-driven architectures.

## Features

- Connects to RabbitMQ
- Supports event emission and listening
- Allows dynamic registration of event handlers
- Provides built-in debugging for easier monitoring
- Ensures durable message delivery

## Installation

Ensure that you have Node.js installed, then install dependencies:

```sh
npm install amqplib
```

## Usage

### Installing

Ensure you are authenticated against the `registry.awesomeshinythings.co.uk` private npm repo. Then, simply include an `.npmrc` file in your project root with the following content, being sure to set the local env var for `$CASTA_NPM_TOKEN`

```
@casta:registry=https://registry.awesomeshinythings.co.uk
//registry.awesomeshinythings.co.uk/:_authToken=${CASTA_NPM_TOKEN}
```

From there, simply run `npm i -s @casta/events-lib`

### Initializing the Events Engine

```ts
import { EventsEngine } from './EventsEngine';

const events = new EventsEngine({
  url: 'amqp://localhost',
  queue: 'my-events',
  canListen: true, // Enable listening mode
  debug: true, // Enable debug logs
});

await events.init();
```

### Emitting Events

To emit an event, use the `emit` method with the event type and payload:

```ts
import { EventTypes } from './types';

events.emit(EventTypes.Auth.UserCreated, {
  userId: '123',
  firstName: 'John',
  lastName: 'Doe',
  email: 'john.doe@example.com',
  passwordToken: 'abcd1234',
  imageUrl: 'https://example.com/avatar.png',
});
```

### Listening to Events

To register an event listener, use the `on` method:

```ts
events.on(EventTypes.Auth.UserCreated, (data) => {
  console.log('User created:', data);
});
```

### Closing the Connection

Ensure the connection is properly closed when shutting down your application:

```ts
await events.close();
```

## Defining New Message Types

### Step 1: Add a New Event Type

Define the new event type in `EventTypes`:

```ts
export enum MyNewEvents {
  OrderPlaced = 'order-placed',
  OrderShipped = 'order-shipped',
}
```

### Step 2: Extend `EventDataMap`

Add the corresponding data structure for the new event in `EventDataMap`:

```ts
export interface EventDataMap {
  [MyNewEvents.OrderPlaced]: {
    orderId: string;
    userId: string;
    amount: number;
  };
  [MyNewEvents.OrderShipped]: {
    orderId: string;
    shippingDate: string;
  };
}
```

### Step 3: Use the New Event Type

Now, you can emit and listen for the new event:

```ts
events.emit(MyNewEvents.OrderPlaced, {
  orderId: 'abc123',
  userId: 'user456',
  amount: 99.99,
});
```

```ts
events.on(MyNewEvents.OrderPlaced, (data) => {
  console.log('Order placed:', data);
});
```

## Debugging

To enable debugging, pass `debug: true` when initializing `EventsEngine`. This logs event emissions and received messages to the console:

```ts
const events = new EventsEngine({
  url: 'amqp://localhost',
  queue: 'debug-events',
  canListen: true,
  debug: true,
});
```

## Error Handling

- If RabbitMQ is unreachable, an error will be thrown during initialization.
- If an event is emitted before the engine is initialized, a warning is displayed.
- Errors within event handlers are caught and logged.

## License

This project is licensed under the MIT License.
