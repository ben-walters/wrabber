#!/usr/bin/env node

import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import path from 'path';

const args = process.argv.slice(2);
const command = args[0];

let filePath = path.resolve(process.cwd(), '.wrabber/events.yaml');
const main = async () => {
  for (const arg of args) {
    if (arg.startsWith('--file=')) {
      filePath = path.resolve(process.cwd(), arg.split('=')[1]);
    }
    if (arg.startsWith('--url=')) {
      try {
        const data = await fetch(arg.split('=')[1]);
        if (!data.ok) {
          throw new Error(`Failed to fetch URL: ${data.statusText}`);
        }
        const text = await data.text();
        filePath = `${__dirname}/temp-events.yaml`;
        writeFileSync(filePath, text, 'utf-8');
      } catch (error) {
        console.error('Error fetching the URL:', error.message);
        process.exit(1); // Exit with error code
      }
    }
  }

  if (command === 'generate') {
    const generatorPath = path.resolve(__dirname, './cli/generator.js'); // Path to the generator script
    try {
      execSync(`node ${generatorPath} --file=${filePath}`, {
        stdio: 'inherit',
      });
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
};

main();
