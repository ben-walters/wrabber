import fs from 'fs';
import yaml from 'js-yaml';
import path from 'path';

interface EventField {
  type?: string;
  required?: boolean;
  fields?: Record<string, EventField>;
  items?: EventField;
  values?: string[];
}

interface EventsSchema {
  version: string;
  namespace: boolean;
  events: Record<
    string,
    Record<string, Record<string, EventField> | EventField>
  >;
}

export function validateVersion(version: string): void {
  const SUPPORTED_VERSIONS = [1];
  if (!SUPPORTED_VERSIONS.includes(parseInt(version, 10))) {
    throw new Error(`Unsupported schema version: ${version}.`);
  }
}

const args = process.argv.slice(2);
let filePath = path.resolve(process.cwd(), '.wrabber/events.yaml');

for (const arg of args) {
  if (arg.startsWith('--file=')) {
    const fileArg = arg.split('=')[1];
    filePath = path.resolve(process.cwd(), fileArg.replace(/^"|"$/g, ''));
  }
}

const OUTPUT_FILE_TS = path.resolve(__dirname, '../generated-types.ts');
const OUTPUT_FILE_JS = path.resolve(__dirname, '../generated-types.js');
const OUTPUT_FILE_D_TS = path.resolve(__dirname, '../generated-types.d.ts');

const VALID_TYPES = [
  'string',
  'number',
  'boolean',
  'date',
  'enum',
  'array',
  'object',
  'string | null',
  'any',
];

function resolveFieldType(field: EventField, path: string): string {
  if (!field.type) {
    throw new Error(`Missing "type" at path: ${path}`);
  }

  if (!VALID_TYPES.includes(field.type)) {
    throw new Error(`Invalid type "${field.type}" at path: ${path}`);
  }

  if (field.type === 'date') {
    return 'Date';
  } else if (field.type === 'object' && field.fields) {
    const nestedFields = Object.entries(field.fields)
      .map(([nestedFieldName, nestedField]) => {
        const nestedOptional = nestedField.required ? '' : '?';
        return `        ${nestedFieldName}${nestedOptional}: ${resolveFieldType(
          nestedField,
          `${path}.fields.${nestedFieldName}`
        )};`;
      })
      .join('\n');
    return `{\n${nestedFields}\n      }`;
  } else if (field.type === 'enum' && field.values) {
    return field.values.map((v) => `"${v}"`).join(' | ');
  } else if (field.type === 'array' && field.items) {
    const itemType = resolveFieldType(field.items, `${path}.items`);
    if (field.items.type === 'enum') {
      return `(${itemType})[]`;
    }
    return `${itemType}[]`;
  } else {
    return field.type;
  }
}

export function generateTypes(schema: EventsSchema): {
  ts: string;
  js: string;
} {
  const { namespace, events } = schema;
  const lines: string[] = [];
  const jslines: string[] = [];

  lines.push('// AUTO-GENERATED FILE. DO NOT EDIT.');
  lines.push(`// Schema version: ${schema.version}`);
  lines.push('');

  if (namespace) {
    lines.push('export namespace EventTypes {');
    for (const [namespaceName, eventGroup] of Object.entries(events)) {
      lines.push(`  export namespace ${namespaceName} {`);
      for (const [eventName, eventDefinition] of Object.entries(eventGroup)) {
        if (typeof eventDefinition === 'object' && eventDefinition.type) {
          const optional =
            eventDefinition.type === 'any' || eventDefinition.required
              ? ''
              : '?';
          lines.push(
            `    export type ${eventName} = ${resolveFieldType(
              eventDefinition,
              `events.${namespaceName}.${eventName}`
            )}${optional};`
          );
        } else {
          lines.push(`    export interface ${eventName} {`);
          for (const [fieldName, field] of Object.entries(
            eventDefinition as Record<string, EventField>
          )) {
            const optional = field.required ? '' : '?';
            lines.push(
              `      ${fieldName}${optional}: ${resolveFieldType(
                field,
                `events.${namespaceName}.${eventName}.${fieldName}`
              )};`
            );
          }
          lines.push('    }');
        }
      }
      lines.push('  }');
    }
    lines.push('}');
  } else {
    lines.push('export namespace EventTypes {');
    for (const [namespaceName, eventGroup] of Object.entries(events)) {
      for (const [eventName, eventDefinition] of Object.entries(eventGroup)) {
        const flatEventName = `${namespaceName}${eventName}`;
        if (typeof eventDefinition === 'object' && eventDefinition.type) {
          const optional =
            eventDefinition.type === 'any' || eventDefinition.required
              ? ''
              : '?';
          lines.push(
            `  export type ${flatEventName} = ${resolveFieldType(
              eventDefinition,
              `events.${namespaceName}.${eventName}`
            )}${optional};`
          );
        } else {
          lines.push(`  export interface ${flatEventName} {`);
          for (const [fieldName, field] of Object.entries(
            eventDefinition as Record<string, EventField>
          )) {
            const optional = field.required ? '' : '?';
            lines.push(
              `    ${fieldName}${optional}: ${resolveFieldType(
                field,
                `events.${namespaceName}.${eventName}.${fieldName}`
              )};`
            );
          }
          lines.push('  }');
        }
      }
    }
    lines.push('}');
  }

  lines.push('');
  lines.push('export interface EventDataMap {');
  for (const [namespaceName, eventGroup] of Object.entries(events)) {
    for (const eventName of Object.keys(eventGroup)) {
      if (namespace) {
        lines.push(
          `  "${namespaceName}.${eventName}": EventTypes.${namespaceName}.${eventName};`
        );
      } else {
        const flatEventName = `${namespaceName}${eventName}`;
        lines.push(
          `  "${namespaceName}.${eventName}": EventTypes.${flatEventName};`
        );
      }
    }
  }
  lines.push('}');
  lines.push('');

  lines.push('export const Events = {');
  jslines.push('export const Events = {');

  for (const [namespaceName, eventGroup] of Object.entries(events)) {
    jslines.push(`  ${namespaceName}: {`);
    lines.push(`  ${namespaceName}: {`);
    for (const eventName of Object.keys(eventGroup)) {
      const flatEventName = `${namespaceName}.${eventName}`;
      lines.push(`    ${eventName}: "${flatEventName}",`);
      jslines.push(`    ${eventName}: "${flatEventName}",`);
    }
    lines.push(`  },`);
    jslines.push(`  },`);
  }

  lines.push('} as const;');
  jslines.push('}');
  lines.push('');
  lines.push('export type EventName = keyof EventDataMap;');

  return { ts: lines.join('\n'), js: jslines.join('\n') };
}

async function main() {
  try {
    if (!fs.existsSync(filePath)) {
      throw new Error(
        `Schema file not found at the specified path: ${filePath}`
      );
    }

    const fileContent = fs.readFileSync(filePath, 'utf8');

    const schema = yaml.load(fileContent) as EventsSchema;

    if (!schema || !schema.events || Object.keys(schema.events).length === 0) {
      throw new Error(
        'The YAML file was parsed, but it appears to be empty or missing the top-level "events" key.'
      );
    }

    validateVersion(schema.version);

    const { ts, js } = generateTypes(schema);

    fs.writeFileSync(OUTPUT_FILE_TS, ts, 'utf8');
    fs.writeFileSync(OUTPUT_FILE_JS, js, 'utf8');

    const declarationContent = `export * from './generated-types';\n`;

    fs.writeFileSync(OUTPUT_FILE_D_TS, declarationContent, 'utf8');

    console.log(`[WRABBER] - Generated types successfully.`);
  } catch (error) {
    console.error(`\n[WRABBER] - FATAL ERROR: ${error.message}\n`);
    process.exit(1);
  }
}

main();
