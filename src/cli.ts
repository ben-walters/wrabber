#!/usr/bin/env node

import { execSync } from 'child_process';
import path from 'path';

const args = process.argv.slice(2); // Get command-line arguments
const command = args[0]; // The first argument is the command (e.g., "generate")

// Default file path for the user's event definition file
let filePath = path.resolve(process.cwd(), '.wrabber/events.yaml');

for (const arg of args) {
  if (arg.startsWith('--file=')) {
    filePath = path.resolve(process.cwd(), arg.split('=')[1]);
  }
}

if (command === 'generate') {
  const generatorPath = path.resolve(__dirname, './cli/generator.js'); // Path to the generator script
  try {
    execSync(`node ${generatorPath} --file=${filePath}`, { stdio: 'inherit' });
  } catch (error) {
    console.error('Error running generator:', error.message);
    process.exit(1); // Exit with error code
  }
} else {
  console.log('Usage: wrabber generate [--file=path/to/schema.yaml]');
  console.log('Commands:');
  console.log('  generate   Generate TypeScript types from the YAML schema');
  console.log('Options:');
  console.log(
    '  --file     Specify the path to the YAML schema file (default: .wrabber/events.yaml)'
  );
}
