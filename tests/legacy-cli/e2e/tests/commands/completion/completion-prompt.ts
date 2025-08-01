import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { env } from 'node:process';
import { getGlobalVariable } from '../../../utils/env';
import { mockHome } from '../../../utils/utils';
import assert from 'node:assert/strict';

import {
  execAndCaptureError,
  execAndWaitForOutputToMatch,
  execWithEnv,
  silentNpm,
} from '../../../utils/process';

const AUTOCOMPLETION_PROMPT = /Would you like to enable autocompletion\?/;
const DEFAULT_ENV = Object.freeze({
  ...env,
  // Shell should be mocked for each test that cares about it.
  SHELL: '/bin/bash',
  // Even if the actual test process is run on CI, we're testing user flows which aren't on CI.
  CI: undefined,
  // Tests run on CI technically don't have a TTY, but the autocompletion prompt requires it, so we
  // force a TTY by default.
  NG_FORCE_TTY: '1',
  // Analytics wants to prompt for a first command as well, but we don't care about that here.
  NG_CLI_ANALYTICS: 'false',
});

const testRegistry = getGlobalVariable('package-registry');

export default async function () {
  // Windows Cmd and Powershell do not support autocompletion. Run a different set of tests to
  // confirm autocompletion skips the prompt appropriately.
  if (process.platform === 'win32') {
    await windowsTests();
    return;
  }

  // Sets up autocompletion after user accepts a prompt from any command.
  await mockHome(async (home) => {
    const bashrc = path.join(home, '.bashrc');
    await fs.writeFile(bashrc, `# Other content...`);

    const { stdout } = await execWithEnv(
      'ng',
      ['config'],
      {
        ...DEFAULT_ENV,
        SHELL: '/bin/bash',
        HOME: home,
      },
      'y\n' /* stdin: accept prompt */,
    );

    assert.match(
      stdout,
      AUTOCOMPLETION_PROMPT,
      'CLI execution did not prompt for autocompletion setup when it should have.',
    );

    const bashrcContents = await fs.readFile(bashrc, 'utf-8');
    assert.match(
      bashrcContents,
      /source <\(ng completion script\)/,
      'Autocompletion was *not* added to `~/.bashrc` after accepting the setup prompt.',
    );

    assert.match(
      stdout,
      /Appended `source <\(ng completion script\)`/,
      'CLI did not print that it successfully set up autocompletion.',
    );
  });

  // Does nothing if the user rejects the autocompletion prompt.
  await mockHome(async (home) => {
    const bashrc = path.join(home, '.bashrc');
    await fs.writeFile(bashrc, `# Other content...`);

    const { stdout } = await execWithEnv(
      'ng',
      ['config'],
      {
        ...DEFAULT_ENV,
        SHELL: '/bin/bash',
        HOME: home,
      },
      'n\n' /* stdin: reject prompt */,
    );

    assert.match(
      stdout,
      AUTOCOMPLETION_PROMPT,
      'CLI execution did not prompt for autocompletion setup when it should have.',
    );

    const bashrcContents = await fs.readFile(bashrc, 'utf-8');
    assert.doesNotMatch(
      bashrcContents,
      /ng completion/,
      'Autocompletion was incorrectly added to `~/.bashrc` after refusing the setup prompt.',
    );

    assert.doesNotMatch(
      stdout,
      /Appended `source <\(ng completion script\)`/,
      "CLI printed that it successfully set up autocompletion when it actually didn't.",
    );

    assert.match(
      stdout,
      /Ok, you won't be prompted again\./,
      'CLI did not inform the user they will not be prompted again.',
    );
  });

  // Does *not* prompt if the user already accepted (even if they delete the completion config).
  await mockHome(async (home) => {
    const bashrc = path.join(home, '.bashrc');
    await fs.writeFile(bashrc, '# Other commands...');

    const { stdout: stdout1 } = await execWithEnv(
      'ng',
      ['config'],
      {
        ...DEFAULT_ENV,
        SHELL: '/bin/bash',
        HOME: home,
      },
      'y\n' /* stdin: accept prompt */,
    );

    assert.match(
      stdout1,
      AUTOCOMPLETION_PROMPT,
      'First execution did not prompt for autocompletion setup.',
    );

    const bashrcContents1 = await fs.readFile(bashrc, 'utf-8');
    assert.match(
      bashrcContents1,
      /source <\(ng completion script\)/,
      '`~/.bashrc` file was not updated after the user accepted the autocompletion' +
        ` prompt. Contents:\n${bashrcContents1}`,
    );

    // User modifies their configuration and removes `ng completion`.
    await fs.writeFile(bashrc, '# Some new commands...');

    const { stdout: stdout2 } = await execWithEnv('ng', ['config'], {
      ...DEFAULT_ENV,
      SHELL: '/bin/bash',
      HOME: home,
    });

    assert.doesNotMatch(
      stdout2,
      AUTOCOMPLETION_PROMPT,
      'Subsequent execution after rejecting autocompletion setup prompted again' +
        ' when it should not have.',
    );

    const bashrcContents2 = await fs.readFile(bashrc, 'utf-8');
    assert.strictEqual(
      bashrcContents2,
      '# Some new commands...',
      '`~/.bashrc` file was incorrectly modified when using a modified `~/.bashrc`' +
        ` after previously accepting the autocompletion prompt. Contents:\n${bashrcContents2}`,
    );
  });

  // Does *not* prompt if the user already rejected.
  await mockHome(async (home) => {
    const bashrc = path.join(home, '.bashrc');
    await fs.writeFile(bashrc, '# Other commands...');

    const { stdout: stdout1 } = await execWithEnv(
      'ng',
      ['config'],
      {
        ...DEFAULT_ENV,
        SHELL: '/bin/bash',
        HOME: home,
      },
      'n\n' /* stdin: reject prompt */,
    );

    assert.match(
      stdout1,
      AUTOCOMPLETION_PROMPT,
      'First execution did not prompt for autocompletion setup.',
    );

    const { stdout: stdout2 } = await execWithEnv('ng', ['config'], {
      ...DEFAULT_ENV,
      SHELL: '/bin/bash',
      HOME: home,
    });

    assert.doesNotMatch(
      stdout2,
      AUTOCOMPLETION_PROMPT,
      'Subsequent execution after rejecting autocompletion setup prompted again' +
        ' when it should not have.',
    );

    const bashrcContents = await fs.readFile(bashrc, 'utf-8');
    assert.strictEqual(
      bashrcContents,
      '# Other commands...',
      '`~/.bashrc` file was incorrectly modified when the user never accepted the' +
        ` autocompletion prompt. Contents:\n${bashrcContents}`,
    );
  });

  // Prompts user again on subsequent execution after accepting prompt but failing to setup.
  await mockHome(async (home) => {
    const bashrc = path.join(home, '.bashrc');
    await fs.writeFile(bashrc, '# Other commands...');

    // Make `~/.bashrc` readonly. This is enough for the CLI to verify that the file exists and
    // `ng completion` is not in it, but will fail when actually trying to modify the file.
    await fs.chmod(bashrc, 0o444);

    const err = await execAndCaptureError(
      'ng',
      ['config'],
      {
        ...DEFAULT_ENV,
        SHELL: '/bin/bash',
        HOME: home,
      },
      'y\n' /* stdin: accept prompt */,
    );

    assert.match(
      err.message,
      /Failed to append autocompletion setup/,
      `Failed first execution did not print the expected error message. Actual:\n${err.message}`,
    );

    // User corrects file permissions between executions.
    await fs.chmod(bashrc, 0o777);

    const { stdout: stdout2 } = await execWithEnv(
      'ng',
      ['config'],
      {
        ...DEFAULT_ENV,
        SHELL: '/bin/bash',
        HOME: home,
      },
      'y\n' /* stdin: accept prompt */,
    );

    assert.match(
      stdout2,
      AUTOCOMPLETION_PROMPT,
      'Subsequent execution after failed autocompletion setup did not prompt again when it should' +
        ' have.',
    );

    const bashrcContents = await fs.readFile(bashrc, 'utf-8');
    assert.match(
      bashrcContents,
      /ng completion script/,
      '`~/.bashrc` file does not include `ng completion` after the user never accepted the' +
        ` autocompletion prompt a second time. Contents:\n${bashrcContents}`,
    );
  });

  // Does *not* prompt for `ng update` commands.
  await mockHome(async (home) => {
    // Use `ng update --help` so it's actually a no-op and we don't need to setup a project.
    const { stdout } = await execWithEnv('ng', ['update', '--help'], {
      ...DEFAULT_ENV,
      HOME: home,
    });

    assert.doesNotMatch(
      stdout,
      AUTOCOMPLETION_PROMPT,
      '`ng update` command incorrectly prompted for autocompletion setup.',
    );
  });

  // Does *not* prompt for `ng completion` commands.
  await mockHome(async (home) => {
    const { stdout } = await execWithEnv('ng', ['completion'], {
      ...DEFAULT_ENV,
      HOME: home,
    });

    assert.doesNotMatch(
      stdout,
      AUTOCOMPLETION_PROMPT,
      '`ng completion` command incorrectly prompted for autocompletion setup.',
    );
  });

  // Does *not* prompt user for CI executions.
  {
    const { stdout } = await execWithEnv('ng', ['config'], {
      ...DEFAULT_ENV,
      CI: 'true',
      NG_FORCE_TTY: undefined,
    });

    assert.doesNotMatch(
      stdout,
      AUTOCOMPLETION_PROMPT,
      'CI execution prompted for autocompletion setup but should not have.',
    );
  }

  // Does *not* prompt user for non-TTY executions.
  {
    const { stdout } = await execWithEnv('ng', ['config'], {
      ...DEFAULT_ENV,
      NG_FORCE_TTY: 'false',
    });

    assert.doesNotMatch(
      stdout,
      AUTOCOMPLETION_PROMPT,
      'Non-TTY execution prompted for autocompletion setup but should not have.',
    );
  }

  // Does *not* prompt user for executions without a `$HOME`.
  {
    const { stdout } = await execWithEnv('ng', ['config'], {
      ...DEFAULT_ENV,
      HOME: undefined,
    });

    assert.doesNotMatch(
      stdout,
      AUTOCOMPLETION_PROMPT,
      'Execution without a `$HOME` value prompted for autocompletion setup but' +
        ' should not have.',
    );
  }

  // Does *not* prompt user for executions without a `$SHELL`.
  {
    const { stdout } = await execWithEnv('ng', ['config'], {
      ...DEFAULT_ENV,
      SHELL: undefined,
    });

    assert.doesNotMatch(
      stdout,
      AUTOCOMPLETION_PROMPT,
      'Execution without a `$SHELL` value prompted for autocompletion setup but' +
        ' should not have.',
    );
  }

  // Does *not* prompt user for executions from unknown shells.
  {
    const { stdout } = await execWithEnv('ng', ['config'], {
      ...DEFAULT_ENV,
      SHELL: '/usr/bin/unknown',
    });

    assert.doesNotMatch(
      stdout,
      AUTOCOMPLETION_PROMPT,
      'Execution with an unknown `$SHELL` value prompted for autocompletion setup' +
        ' but should not have.',
    );
  }

  // Does *not* prompt user when an RC file already uses `ng completion`.
  await mockHome(async (home) => {
    await fs.writeFile(
      path.join(home, '.bashrc'),
      `
# Some stuff...

source <(ng completion script)

# Some other stuff...
    `.trim(),
    );

    const { stdout } = await execWithEnv('ng', ['config'], {
      ...DEFAULT_ENV,
      SHELL: '/bin/bash',
      HOME: home,
    });

    assert.doesNotMatch(
      stdout,
      AUTOCOMPLETION_PROMPT,
      "Execution with an existing `ng completion` line in the user's RC file" +
        ' prompted for autocompletion setup but should not have.',
    );
  });

  // Prompts when a global CLI install is present on the system.
  await mockHome(async (home) => {
    const bashrc = path.join(home, '.bashrc');
    await fs.writeFile(bashrc, `# Other content...`);

    await execAndWaitForOutputToMatch('ng', ['config'], AUTOCOMPLETION_PROMPT, {
      ...DEFAULT_ENV,
      SHELL: '/bin/bash',
      HOME: home,
    });
  });

  // Does *not* prompt when a global CLI install is missing from the system.
  await mockHome(async (home) => {
    try {
      // Temporarily uninstall the global CLI binary from the system.
      await silentNpm(['uninstall', '--global', '@angular/cli', `--registry=${testRegistry}`]);

      // Setup a fake project directory with a local install of the CLI.
      const projectDir = path.join(home, 'project');
      await fs.mkdir(projectDir);
      await silentNpm(['init', '-y', `--registry=${testRegistry}`], { cwd: projectDir });
      await silentNpm(['install', '@angular/cli', `--registry=${testRegistry}`], {
        cwd: projectDir,
      });

      const bashrc = path.join(home, '.bashrc');
      await fs.writeFile(bashrc, `# Other content...`);

      const localCliDir = path.join(projectDir, 'node_modules', '.bin');
      const localCliBinary = path.join(localCliDir, 'ng');
      const pathDirs = process.env['PATH']!.split(':');
      const pathEnvVar = [...pathDirs, localCliDir].join(':');
      const { stdout } = await execWithEnv(localCliBinary, ['config'], {
        ...DEFAULT_ENV,
        SHELL: '/bin/bash',
        HOME: home,
        PATH: pathEnvVar,
      });

      assert.doesNotMatch(
        stdout,
        AUTOCOMPLETION_PROMPT,
        'Execution without a global CLI install prompted for autocompletion setup but should' +
          ' not have.',
      );
    } finally {
      // Reinstall global CLI for remainder of the tests.
      await silentNpm(['install', '--global', '@angular/cli', `--registry=${testRegistry}`]);
    }
  });
}

async function windowsTests(): Promise<void> {
  // Should *not* prompt on Windows, autocompletion isn't supported.
  await mockHome(async (home) => {
    const bashrc = path.join(home, '.bashrc');
    await fs.writeFile(bashrc, `# Other content...`);

    const { stdout } = await execWithEnv('ng', ['config'], { ...env });

    assert.doesNotMatch(
      stdout,
      AUTOCOMPLETION_PROMPT,
      'Execution prompted to set up autocompletion on Windows despite not actually being' +
        ' supported.',
    );
  });
}
