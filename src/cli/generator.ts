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

const OUTPUT_FILE_TS_ESM = path.resolve(
  __dirname,
  '../../esm/generated-types.ts'
);
const OUTPUT_FILE_TS_CJS = path.resolve(__dirname, '../generated-types.ts');
const OUTPUT_FILE_JS_ESM = path.resolve(
  __dirname,
  '../../esm/generated-types.js'
);
const OUTPUT_FILE_JS_CJS = path.resolve(__dirname, '../generated-types.js');
const OUTPUT_FILE_D_TS_ESM = path.resolve(
  __dirname,
  '../../esm/generated-types.d.ts'
);
const OUTPUT_FILE_D_TS_CJS = path.resolve(__dirname, '../generated-types.d.ts');

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

function resolveFieldType(field: EventField, pathStr: string): string {
  if (!field.type) {
    throw new Error(`Missing "type" at path: ${pathStr}`);
  }

  if (!VALID_TYPES.includes(field.type)) {
    throw new Error(`Invalid type "${field.type}" at path: ${pathStr}`);
  }

  if (field.type === 'date') {
    return 'Date';
  } else if (field.type === 'object' && field.fields) {
    const nestedFields = Object.entries(field.fields)
      .map(([nestedFieldName, nestedField]) => {
        const nestedOptional = nestedField.required ? '' : '?';
        return `        ${nestedFieldName}${nestedOptional}: ${resolveFieldType(
          nestedField,
          `${pathStr}.fields.${nestedFieldName}`
        )};`;
      })
      .join('\n');
    return `{\n${nestedFields}\n      }`;
  } else if (field.type === 'enum' && field.values) {
    return field.values.map((v) => `"${v}"`).join(' | ');
  } else if (field.type === 'array' && field.items) {
    const itemType = resolveFieldType(field.items, `${pathStr}.items`);
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
  jsEsm: string;
  jsCjs: string;
} {
  const { namespace, events } = schema;

  const tsLines: string[] = [];
  const jsEsmLines: string[] = [];
  const jsCjsLines: string[] = [];

  // Header for TS
  tsLines.push('// AUTO-GENERATED FILE. DO NOT EDIT.');
  tsLines.push(`// Schema version: ${schema.version}`);
  tsLines.push('');

  // Types namespace
  if (namespace) {
    tsLines.push('export namespace EventTypes {');
    for (const [namespaceName, eventGroup] of Object.entries(events)) {
      tsLines.push(`  export namespace ${namespaceName} {`);
      for (const [eventName, eventDefinition] of Object.entries(eventGroup)) {
        if (typeof eventDefinition === 'object' && eventDefinition.type) {
          const optional =
            eventDefinition.type === 'any' || eventDefinition.required
              ? ''
              : '?';
          tsLines.push(
            `    export type ${eventName} = ${resolveFieldType(
              eventDefinition,
              `events.${namespaceName}.${eventName}`
            )}${optional};`
          );
        } else {
          tsLines.push(`    export interface ${eventName} {`);
          for (const [fieldName, field] of Object.entries(
            eventDefinition as Record<string, EventField>
          )) {
            const optional = field.required ? '' : '?';
            tsLines.push(
              `      ${fieldName}${optional}: ${resolveFieldType(
                field,
                `events.${namespaceName}.${eventName}.${fieldName}`
              )};`
            );
          }
          tsLines.push('    }');
        }
      }
      tsLines.push('  }');
    }
    tsLines.push('}');
  } else {
    tsLines.push('export namespace EventTypes {');
    for (const [namespaceName, eventGroup] of Object.entries(events)) {
      for (const [eventName, eventDefinition] of Object.entries(eventGroup)) {
        const flatEventName = `${namespaceName}${eventName}`;
        if (typeof eventDefinition === 'object' && eventDefinition.type) {
          const optional =
            eventDefinition.type === 'any' || eventDefinition.required
              ? ''
              : '?';
          tsLines.push(
            `  export type ${flatEventName} = ${resolveFieldType(
              eventDefinition,
              `events.${namespaceName}.${eventName}`
            )}${optional};`
          );
        } else {
          tsLines.push(`  export interface ${flatEventName} {`);
          for (const [fieldName, field] of Object.entries(
            eventDefinition as Record<string, EventField>
          )) {
            const optional = field.required ? '' : '?';
            tsLines.push(
              `    ${fieldName}${optional}: ${resolveFieldType(
                field,
                `events.${namespaceName}.${eventName}.${fieldName}`
              )};`
            );
          }
          tsLines.push('  }');
        }
      }
    }
    tsLines.push('}');
  }

  // EventDataMap
  tsLines.push('');
  tsLines.push('export interface EventDataMap {');
  for (const [namespaceName, eventGroup] of Object.entries(events)) {
    for (const eventName of Object.keys(eventGroup)) {
      if (namespace) {
        tsLines.push(
          `  "${namespaceName}.${eventName}": EventTypes.${namespaceName}.${eventName};`
        );
      } else {
        const flatEventName = `${namespaceName}${eventName}`;
        tsLines.push(
          `  "${namespaceName}.${eventName}": EventTypes.${flatEventName};`
        );
      }
    }
  }
  tsLines.push('}');
  tsLines.push('');

  // Runtime Events object
  tsLines.push('export const Events = {');
  jsEsmLines.push('export const Events = {');
  jsCjsLines.push('const Events = {');

  for (const [namespaceName, eventGroup] of Object.entries(events)) {
    tsLines.push(`  ${namespaceName}: {`);
    jsEsmLines.push(`  ${namespaceName}: {`);
    jsCjsLines.push(`  ${namespaceName}: {`);
    for (const eventName of Object.keys(eventGroup)) {
      const flatEventName = `${namespaceName}.${eventName}`;
      tsLines.push(`    ${eventName}: "${flatEventName}",`);
      jsEsmLines.push(`    ${eventName}: "${flatEventName}",`);
      jsCjsLines.push(`    ${eventName}: "${flatEventName}",`);
    }
    tsLines.push('  },');
    jsEsmLines.push('  },');
    jsCjsLines.push('  },');
  }

  tsLines.push('} as const;');
  jsEsmLines.push('}');
  jsCjsLines.push('}');
  jsCjsLines.push('');
  jsCjsLines.push('module.exports = { Events };');

  tsLines.push('');
  tsLines.push('export type EventName = keyof EventDataMap;');

  return {
    ts: tsLines.join('\n'),
    jsEsm: jsEsmLines.join('\n'),
    jsCjs: jsCjsLines.join('\n'),
  };
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

    const { ts, jsEsm, jsCjs } = generateTypes(schema);

    // Write TS to both esm/ and cjs/ (identical TS is fine)
    fs.writeFileSync(OUTPUT_FILE_TS_ESM, ts, 'utf8');
    fs.writeFileSync(OUTPUT_FILE_TS_CJS, ts, 'utf8');

    // Write ESM and CJS JS variants
    fs.writeFileSync(OUTPUT_FILE_JS_ESM, jsEsm, 'utf8');
    fs.writeFileSync(OUTPUT_FILE_JS_CJS, jsCjs, 'utf8');

    // Typings re-export
    const declarationContent = `export * from './generated-types';\n`;
    fs.writeFileSync(OUTPUT_FILE_D_TS_CJS, declarationContent, 'utf8');
    fs.writeFileSync(OUTPUT_FILE_D_TS_ESM, declarationContent, 'utf8');

    console.log(`[WRABBER] - Generated types successfully.`);
  } catch (error: any) {
    console.error(`\n[WRABBER] - FATAL ERROR: ${error.message}\n`);
    process.exit(1);
  }
}

main();
