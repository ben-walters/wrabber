import fs from 'fs';
import yaml from 'js-yaml';
import path from 'path';

interface EventField {
  type: string; // The type of the field (e.g., string, number, enum, object, array)
  required: boolean; // Whether the field is required
  fields?: Record<string, EventField>; // For nested objects
  items?: EventField; // For arrays
  values?: string[]; // For enums (list of allowed values)
}

interface EventsSchema {
  version: string;
  namespace: boolean;
  events: Record<string, Record<string, Record<string, EventField>>>;
}

// Parse command-line arguments
const args = process.argv.slice(2);
let filePath = path.resolve(process.cwd(), '.wrabber/events.yaml'); // Default file path

for (const arg of args) {
  if (arg.startsWith('--file=')) {
    filePath = path.resolve(process.cwd(), arg.split('=')[1]);
  }
}

// Output file path for the generated types in the installed module
const OUTPUT_FILE_TS = path.resolve(__dirname, '../generated-types.ts');
const OUTPUT_FILE_D_TS = path.resolve(__dirname, '../generated-types.d.ts');

function validateVersion(version: string): void {
  const SUPPORTED_VERSIONS = [1];
  if (!SUPPORTED_VERSIONS.includes(parseInt(version, 10))) {
    throw new Error(
      `Unsupported schema version: ${version}. Supported versions are ${SUPPORTED_VERSIONS.join(
        ', '
      )}.`
    );
  }
}

function generateTypes(schema: EventsSchema): string {
  const { namespace, events } = schema;
  const lines: string[] = [];

  lines.push('// AUTO-GENERATED FILE. DO NOT EDIT.');
  lines.push(`// Schema version: ${schema.version}`);
  lines.push('');

  function resolveFieldType(field: EventField): string {
    if (field.type === 'object' && field.fields) {
      // Handle nested objects
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
      // Handle enums as a union of string literals
      return field.values.map((v) => `"${v}"`).join(' | ');
    } else if (field.type === 'array' && field.items) {
      // Handle arrays
      return `${resolveFieldType(field.items)}[]`;
    } else {
      // Handle primitive types (string, number, etc.)
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
    lines.push('');
    lines.push('export interface EventDataMap {');
    for (const [namespaceName, eventGroup] of Object.entries(events)) {
      for (const eventName of Object.keys(eventGroup)) {
        lines.push(
          `  "${namespaceName}.${eventName}": EventTypes.${namespaceName}.${eventName};`
        );
      }
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
    lines.push('');
    lines.push('export interface EventDataMap {');
    for (const [namespaceName, eventGroup] of Object.entries(events)) {
      for (const eventName of Object.keys(eventGroup)) {
        const flatEventName = `${namespaceName}${eventName}`;
        lines.push(
          `  "${namespaceName}.${eventName}": EventTypes.${flatEventName};`
        );
      }
    }
    lines.push('}');
  }

  return lines.join('\n');
}

async function main() {
  try {
    const fileContent = fs.readFileSync(filePath, 'utf8');
    const schema = yaml.load(fileContent) as EventsSchema;

    validateVersion(schema.version);

    const types = generateTypes(schema);

    // Write the generated .ts file
    fs.writeFileSync(OUTPUT_FILE_TS, types, 'utf8');

    // Copy the .ts file to the dist directory as .d.ts
    fs.writeFileSync(OUTPUT_FILE_D_TS, types, 'utf8');

    console.log(`Generated types at ${OUTPUT_FILE_TS}`);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

main();
