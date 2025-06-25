import fs from 'fs';
import yaml from 'js-yaml';
import path from 'path';

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

const args = process.argv.slice(2);
let filePath = path.resolve(process.cwd(), '.wrabber/events.yaml');

for (const arg of args) {
  if (arg.startsWith('--file=')) {
    filePath = path.resolve(process.cwd(), arg.split('=')[1]);
  }
}

const OUTPUT_FILE_TS = path.resolve(__dirname, '../generated-types.ts');
const OUTPUT_FILE_D_TS = path.resolve(__dirname, '../generated-types.d.ts');
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

export function generateTypes(schema: EventsSchema): string {
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
      return `${resolveFieldType(field.items)}[]`;
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

    fs.writeFileSync(OUTPUT_FILE_TS, types, 'utf8');

    fs.writeFileSync(OUTPUT_FILE_D_TS, types, 'utf8');

    console.log(`[WRABBER] - Generated types succesfully.`);
  } catch (error) {
    console.error(`[WRABBER] - Error: ${error.message}`);
    return;
  }
}

main();
