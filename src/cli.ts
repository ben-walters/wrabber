#!/usr/bin/env node

import { execSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

import { baseFile } from './helpers/base';

const ARGS = process.argv.slice(2);
const COMMAND = ARGS[0];

const generatorPath = path.resolve(__dirname, './cli/generator.js');
const wrabberDir = path.resolve(process.cwd(), '.wrabber');
const defaultConfigFilePath = path.resolve(wrabberDir, 'config.json');
const defaultEventsFilePath = path.resolve(wrabberDir, 'events.yaml');

const parseArgs = () => {
  const options = {
    file: undefined as string | undefined,
    url: undefined as string | undefined,
  };

  for (const arg of ARGS) {
    if (arg.startsWith('--file=')) {
      options.file = path.resolve(process.cwd(), arg.split('=')[1]);
    }
    if (arg.startsWith('--url=')) {
      options.url = arg.split('=')[1];
    }
  }
  return options;
};

const handleRemote = async (url: string): Promise<string> => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch URL: ${response.statusText}`);
  }
  const text = await response.text();
  const tempFilePath = path.join(
    os.tmpdir(),
    `wrabber-events-${Date.now()}.yaml`
  );
  writeFileSync(tempFilePath, text, 'utf-8');
  return tempFilePath;
};

const runGenerator = (filePath: string) => {
  if (!existsSync(filePath)) {
    console.error(`[WRABBER] - Schema file not found at: ${filePath}`);
    console.error(
      `[WRABBER] - Please run 'npx wrabber init' or provide a valid file.`
    );
    process.exit(1);
  }

  try {
    console.log(`[WRABBER] - Generating types from: ${filePath}`);
    execSync(`node "${generatorPath}" --file="${filePath}"`, {
      stdio: 'inherit',
    });
  } catch (error) {
    console.error('[WRABBER] - Error running generator:', error.message);
    process.exit(1);
  }
};

const main = async () => {
  switch (COMMAND) {
    case 'generate': {
      let filePath: string | undefined;
      const cliOptions = parseArgs();

      if (cliOptions.file) {
        filePath = cliOptions.file;
      } else if (cliOptions.url) {
        try {
          filePath = await handleRemote(cliOptions.url);
        } catch (error) {
          console.error('[WRABBER] - Error fetching the URL:', error.message);
          return;
        }
      }

      if (!filePath && existsSync(defaultConfigFilePath)) {
        try {
          const config = JSON.parse(
            readFileSync(defaultConfigFilePath, 'utf-8')
          );
          if (config.file) {
            filePath = path.resolve(process.cwd(), config.file);
          } else if (config.url) {
            filePath = await handleRemote(config.url);
          }
        } catch (error) {
          console.error(
            '[WRABBER] - Error reading config file:',
            error.message
          );
          return;
        }
      }

      filePath = filePath || defaultEventsFilePath;

      runGenerator(filePath);
      break;
    }

    case 'init': {
      try {
        if (!existsSync(wrabberDir)) {
          mkdirSync(wrabberDir, { recursive: true });
        }

        if (!existsSync(defaultEventsFilePath)) {
          console.log(
            `[WRABBER] - Creating default schema file: ${defaultEventsFilePath}`
          );
          console.log(
            `See the docs at: https://www.npmjs.com/package/wrabber, or run "npx wrabber help"`
          );
          writeFileSync(defaultEventsFilePath, baseFile, 'utf-8');
          console.log('[WRABBER] - Done!');
        } else {
          console.log(
            `[WRABBER] - Schema file already exists at: ${defaultEventsFilePath}. No changes made.`
          );
        }
      } catch (error) {
        console.error('[WRABBER] - Error during init:', error.message);
      }
      break;
    }

    case 'help':
    default:
      console.log('Thanks for using Wrabber!');
      console.log(
        'Usage: wrabber generate [--file=path/to/schema.yaml | --url=https://your-domain.com/schema.yaml]'
      );
      console.log('\nCommands:');
      console.log(
        "  init       Creates a default .wrabber/events.yaml file if one doesn't exist."
      );
      console.log(
        '  generate   Generates TypeScript types from the YAML schema.'
      );
      console.log('\nOptions for `generate`:');
      console.log(
        '  --file     Specify the path to the YAML schema file (default: .wrabber/events.yaml).'
      );
      console.log(
        '  --url      Specify a URL to fetch the YAML schema file from.'
      );
      console.log(
        '\nMore info can be found here: https://www.npmjs.com/package/wrabber'
      );
  }
};

main();
