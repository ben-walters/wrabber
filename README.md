# Wrabber

---

[![NPM Version](https://img.shields.io/npm/v/wrabber.svg)](https://www.npmjs.com/package/wrabber)
[![CI](https://github.com/ben-walters/wrabber/actions/workflows/release.yaml/badge.svg)](https://github.com/ben-walters/wrabber/actions)
[![codecov](https://codecov.io/gh/ben-walters/wrabber/graph/badge.svg)](https://codecov.io/gh/ben-walters/wrabber)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Wrabber** is a type-safe RabbitMQ wrapper that allows you to define your event types in a YAML file and generate TypeScript types automatically. It ensures type safety and improves developer experience when working with RabbitMQ.

---

## Features

- **Type-Safe Events**: Define your event types in a YAML file and generate TypeScript types for strict type checking.
- **Namespace Support**: Organize your events into namespaces for better structure.
- **Customizable**: Supports enums, nested objects, and arrays in event payloads.
- **Easy Integration**: Designed to work seamlessly with RabbitMQ.

---

## Installation

Install Wrabber via NPM:

```bash
npm install wrabber
```

---

## Getting Started

### 1. Create an Event Definition File

Create a YAML file (e.g., `.wrabber/events.yaml`) in your project directory. This file defines your event types and their payloads.

#### Example `.wrabber/events.yaml`

```yaml
version: 1
namespace: true
events:
  Auth:
    UserCreated:
      userId:
        type: string
        required: true
      firstName:
        type: string
        required: true
      lastName:
        type: string
        required: true
      email:
        type: string
        required: true
      passwordToken:
        type: string
        required: true
      imageUrl:
        type: string
        required: false
    UserAuthenticated:
      userId:
        type: string
        required: true
      mechanism:
        type: enum
        required: true
        values: ['password', 'passwordless']
      userAgent:
        type: string
        required: true
  CoreApi:
    ProjectCreated:
      projectId:
        type: string
        required: true
      projectName:
        type: string
        required: true
      userId:
        type: string
        required: true
```

---

### 2. Generate TypeScript Types

Run the following command to generate the TypeScript types based on your YAML file:

```bash
npx wrabber generate
```

This will generate your types for you.

---

### 3. Use the Generated Types

You can now use the generated types in your project to ensure type safety when emitting or handling events.

#### Important: Event Names Must Be String Literals

When calling `.emit()` or `.on()`, the event name will be a **string literal** (e.g., `"Auth.UserCreated"`, `"CoreApi.ProjectCreated"`). This ensures compatibility with the generated types.

---

#### Example Usage

```typescript
import { Wrabber } from 'wrabber';

const wrabber = new Wrabber({
  url: 'amqp://localhost',
  serviceName: 'my-service',
  namespace: 'my-namespace',
  debug: true,
  canListen: true,
});

// Emit an event
wrabber.emit('Auth.UserCreated', {
  // type-safe input!
  userId: '123',
  firstName: 'John',
  lastName: 'Doe',
  email: 'john.doe@example.com',
  passwordToken: 'abc123',
  imageUrl: 'https://example.com/image.jpg',
});

// Listen for an event
wrabber.on('Auth.UserCreated', (data) => {
  // type-safe data!
  console.log('User created:', data);
});
```

---

## CONFIG

The `Wrabber` class accepts a configuration object (`EventsOpts`) when instantiated. Below are the available configuration options:

### Configuration Options

| Option        | Type      | Default Value | Description                                                                    |
| ------------- | --------- | ------------- | ------------------------------------------------------------------------------ |
| `url`         | `string`  | **Required**  | The RabbitMQ connection URL (e.g., `amqp://localhost`).                        |
| `serviceName` | `string`  | **Required**  | The name of your service. Used to construct the queue name.                    |
| `namespace`   | `string`  | **Required**  | The namespace for your events. Used to construct the exchange name.            |
| `debug`       | `boolean` | `false`       | Enables debug logging for emitted and received events.                         |
| `canListen`   | `boolean` | `false`       | If `true`, the engine will listen for incoming events.                         |
| `fanout`      | `boolean` | `false`       | If `true`, the queue will be exclusive and auto-deleted (fanout mode).         |
| `devMode`     | `boolean` | `false`       | If `true`, the engine runs in development mode without connecting to RabbitMQ. |

---

### Detailed Explanation of Options

#### `url`

The RabbitMQ connection URL. This is required to establish a connection to RabbitMQ.

#### `serviceName`

The name of your service. This is used to construct the queue name. For example, if `serviceName` is `"my-service"` and `namespace` is `"my-namespace"`, the queue name will be `"my-namespace.my-service"`.

#### `namespace`

The namespace for your events. This is used to construct the exchange name in RabbitMQ.

#### `debug`

If `true`, debug logs will be printed for emitted and received events. This is useful for troubleshooting.

#### `canListen`

If `true`, the engine will listen for incoming events. This is required if your service needs to consume events from RabbitMQ.

#### `fanout`

If `true`, the queue will be exclusive and auto-deleted. This is useful for fanout exchanges where multiple consumers receive the same message.

#### `devMode`

If `true`, the engine runs in development mode without connecting to RabbitMQ. This is useful for testing and debugging locally.

---

## Generating Types

To generate a corresponding type file for your events, run:

```
npx wrabber generate
```

### Specifying files

#### Local files

You can specify a local file by passing `--file=/path/to/local/file.yaml` on the command line.

```
npx wrabber generate --file=/path/to/local/file.yaml
```

#### Remote files

You can specify a remote file which will be downloaded by passing `--url=https://cdn.example.com/my-file.yaml` on the command line.

```
npx wrabber generate --file=/path/to/local/file.yaml
```

---

## YAML Schema Format

The YAML file defines your event types and their payloads. Below is a breakdown of the schema format:

### Top-Level Fields

- **`version`**: The schema version (e.g., `1`).
- **`namespace`**: Whether to namespace events (e.g., `EventTypes.Auth.UserCreated`).
- **`events`**: A map of namespaces and their events.

### Event Definition

Each event is defined with its payload fields. Fields can be of the following types:

- **`string`**
- **`number`**
- **`boolean`**
- **`enum`**: A list of allowed values.
- **`object`**: A nested object with its own fields.
- **`array`**: An array of a specific type.

#### Example Event Definition

```yaml
Auth:
  UserCreated:
    userId:
      type: string
      required: true
    firstName:
      type: string
      required: true
    lastName:
      type: string
      required: true
    email:
      type: string
      required: true
    passwordToken:
      type: string
      required: true
    imageUrl:
      type: string
      required: false
```

---

## CLI Commands

Wrabber provides the following CLI commands:

### `npx wrabber generate`

Generates the TypeScript types based on the YAML file.

#### Options:

- `--file=<path>`: Specify the path to the YAML file (default: `.wrabber/events.yaml`).

---

## Example Workflow

1. **Install Wrabber**:

   ```bash
   npm install wrabber
   ```

2. **Create a YAML File**:
   Save the following as `.wrabber/events.yaml`:

   ```yaml
   version: 1
   namespace: true
   events:
     Auth:
       UserCreated:
         userId:
           type: string
           required: true
         firstName:
           type: string
           required: true
         lastName:
           type: string
           required: true
         email:
           type: string
           required: true
         passwordToken:
           type: string
           required: true
         imageUrl:
           type: string
           required: false
   ```

3. **Generate Types**:

   ```bash
   npx wrabber generate
   ```

4. **Use the Types**:

   ```typescript
   const wrabber = new Wrabber({
     // config
   });

   wrabber.emit('Auth.UserCreated', {
     userId: '123',
     firstName: 'John',
     lastName: 'Doe',
     email: 'john.doe@example.com',
     passwordToken: 'abc123',
     imageUrl: 'https://example.com/image.jpg',
   });
   ```

---

## Contributing

Contributions are welcome! If you find a bug or have a feature request, please open an issue or submit a pull request.

---

## License

Wrabber is licensed under the [MIT License](LICENSE).

---

## Support

If you have any questions or need help, feel free to open an issue on the [GitHub repository](https://github.com/ben-walters/wrabber).

---

Let me know if you need further adjustments or additional sections for the README! 🚀
