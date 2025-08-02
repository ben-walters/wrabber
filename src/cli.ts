#!/usr/bin/env node

import { execSync } from 'child_process';
import { existsSync, writeFileSync } from 'fs';
import path from 'path';

import { baseFile } from './helpers/base';

const args = process.argv.slice(2);
const command = args[0];

const generatorPath = path.resolve(__dirname, './cli/generator.js');

let filePath = path.resolve(process.cwd(), '.wrabber/events.yaml');
const main = async () => {
  switch (command) {
    case 'generate':
      try {
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
              console.error(
                '[WRABBER] - Error fetching the URL:',
                error.message
              );
              return;
            }
          }
        }
        // Quote the file path to handle spaces
        execSync(`node "${generatorPath}" --file="${filePath}"`, {
          stdio: 'inherit',
        });
      } catch (error) {
        console.error('[WRABBER] - Error running generator:', error.message);
        return;
      }
      break;
    case 'init':
      try {
        const exists = existsSync(filePath);
        if (!exists) {
          console.log(
            `[WRABBER] - Unable to find schema file at the default location. Creating: ${filePath}`
          );
          console.log(
            `See the docs at: https://www.npmjs.com/package/wrabber, or run "npx wrabber help"`
          );
          writeFileSync(filePath, baseFile, 'utf-8');
          console.log('Done!');
          return;
        } else {
          console.log(
            `[WRABBER] - Schema file already exists at: ${filePath}. No changes made.`
          );
        }
        execSync(`node "${generatorPath}" --file="${filePath}"`, {
          stdio: 'inherit',
        });
      } catch (error) {
        console.error('[WRABBER] - Error during init:', error.message);
      }
      break;
    case 'help':
    default:
      console.log('Thanks for using Wrabber!');
      console.log(
        'Usage: wrabber generate [--file=path/to/schema.yaml] or [--url=https://your-domain.com/schema.yaml]'
      );
      console.log('Commands:');
      console.log(
        '  generate   Generate TypeScript types from the YAML schema'
      );
      console.log('Options:');
      console.log(
        '  --file     Specify the path to the YAML schema file (default: .wrabber/events.yaml)'
      );
      console.log('  --url      Specify the url to the YAML schema file');
      console.log(
        'More info can be found here: https://www.npmjs.com/package/wrabber'
      );
  }
};

main();
