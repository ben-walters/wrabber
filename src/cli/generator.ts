import fs from 'fs';
import yaml from 'js-yaml';
import path from 'path';

// ... (interfaces and validateVersion function remain the same) ...
interface EventField {
  type: string;
  required: boolean;
  fields?: Record<string, EventField>;
  items?: EventField;
  values?: string[];
}

interface EventsSchema {
  version: string;
  namespace: boolean;
  events: Record<string, Record<string, Record<string, EventField>>>;
}

export function validateVersion(version: string): void {
  const SUPPORTED_VERSIONS = [1];
  if (!SUPPORTED_VERSIONS.includes(parseInt(version, 10))) {
    throw new Error(
      `Unsupported schema version: ${version}. Supported versions are ${SUPPORTED_VERSIONS.join(
        ', '
      )}.`
    );
  }
}

// --- ARGUMENT AND PATH PARSING ---
const args = process.argv.slice(2);
let filePath = path.resolve(process.cwd(), '.wrabber/events.yaml');

for (const arg of args) {
  if (arg.startsWith('--file=')) {
    // The input file path is still resolved relative to the user's current directory
    filePath = path.resolve(process.cwd(), arg.split('=')[1]);
  }
}

// --- CORRECTED OUTPUT PATHS ---
// Define output paths relative to this script's location inside the `dist` folder.
// Assuming this script is in `dist/cli/`, `../` will correctly place the files in `dist/`.
const OUTPUT_FILE_TS = path.resolve(__dirname, '../generated-types.ts');
const OUTPUT_FILE_D_TS = path.resolve(__dirname, '../generated-types.d.ts');

// The generateTypes function is correct and remains unchanged.
export function generateTypes(schema: EventsSchema): string {
  // ... (your existing, correct generateTypes function) ...
  const { namespace, events } = schema;
  const lines: string[] = [];

  lines.push('// AUTO-GENERATED FILE. DO NOT EDIT.');
  lines.push(`// Schema version: ${schema.version}`);
  lines.push('');

  function resolveFieldType(field: EventField): string {
    if (field.type === 'object' && field.fields) {
      const nestedFields = Object.entries(field.fields)
        .map(([nestedFieldName, nestedField]) => {
          const nestedOptional = nestedField.required ? '' : '?';
          return `        ${nestedFieldName}${nestedOptional}: ${resolveFieldType(
            nestedField
          )};`;
        })
        .join('\n');
      return `{\n${nestedFields}\n      }`;
    } else if (field.type === 'enum' && field.values) {
      return field.values.map((v) => `"${v}"`).join(' | ');
    } else if (field.type === 'array' && field.items) {
      const itemType = resolveFieldType(field.items);
      if (field.items.type === 'enum') {
        return `(${itemType})[]`;
      }
      return `${itemType}[]`;
    } else {
      return field.type;
    }
  }

  if (namespace) {
    lines.push('export namespace EventTypes {');
    for (const [namespaceName, eventGroup] of Object.entries(events)) {
      lines.push(`  export namespace ${namespaceName} {`);
      for (const [eventName, fields] of Object.entries(eventGroup)) {
        lines.push(`    export interface ${eventName} {`);
        for (const [fieldName, field] of Object.entries(fields)) {
          const optional = field.required ? '' : '?';
          lines.push(
            `      ${fieldName}${optional}: ${resolveFieldType(field)};`
          );
        }
        lines.push('    }');
      }
      lines.push('  }');
    }
    lines.push('}');
  } else {
    lines.push('export namespace EventTypes {');
    for (const [namespaceName, eventGroup] of Object.entries(events)) {
      for (const [eventName, fields] of Object.entries(eventGroup)) {
        const flatEventName = `${namespaceName}${eventName}`;
        lines.push(`  export interface ${flatEventName} {`);
        for (const [fieldName, field] of Object.entries(fields)) {
          const optional = field.required ? '' : '?';
          lines.push(
            `    ${fieldName}${optional}: ${resolveFieldType(field)};`
          );
        }
        lines.push('  }');
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
  lines.push('// --- RUNTIME VALUE for event names ---');
  lines.push('export const Events = {');

  for (const [namespaceName, eventGroup] of Object.entries(events)) {
    lines.push(`  ${namespaceName}: {`);
    for (const eventName of Object.keys(eventGroup)) {
      const flatEventName = `${namespaceName}.${eventName}`;
      lines.push(`    ${eventName}: "${flatEventName}",`);
    }
    lines.push(`  },`);
  }

  lines.push('} as const;');
  lines.push('');
  lines.push('// A union type of all event names');
  lines.push('export type EventName = keyof EventDataMap;');

  return lines.join('\n');
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

    const implementationContent = generateTypes(schema);

    fs.writeFileSync(OUTPUT_FILE_TS, implementationContent, 'utf8');

    // The path in the re-export must be relative to the file's location.
    const declarationContent = `export * from './generated-types';\n`;

    fs.writeFileSync(OUTPUT_FILE_D_TS, declarationContent, 'utf8');

    console.log(`[WRABBER] - Generated types succesfully.`);
  } catch (error) {
    console.error(`\n[WRABBER] - FATAL ERROR: ${error.message}\n`);
    process.exit(1);
  }
}

main();
