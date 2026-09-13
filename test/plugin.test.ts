import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { before } from '../src/plugin';

const fixturesDir = path.join(__dirname, 'fixtures');

function compileFixtures(outDir: string) {
  const fileNames = fs.readdirSync(fixturesDir).map((f) => path.join(fixturesDir, f));
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    experimentalDecorators: false, // real standard (TC39) decorators, the whole point
    outDir,
    rootDir: fixturesDir,
    declaration: false,
  };

  const program = ts.createProgram(fileNames, compilerOptions);
  const transformer = before({}, program);
  const emitResult = program.emit(undefined, undefined, undefined, false, { before: [transformer] });

  return { emitResult, diagnostics: transformer.diagnostics };
}

describe('before() -- real compile against fixture files', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-di-bridge-test-'));
  const { emitResult, diagnostics } = compileFixtures(outDir);

  it('does not skip emit', () => {
    expect(emitResult.emitSkipped).toBe(false);
  });

  it('flags the interface-typed constructor param instead of guessing or silently passing', () => {
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].className).toBe('RepoConsumer');
    expect(diagnostics[0].message).toContain('[repo]');
    expect(diagnostics[0].message).toContain('no runtime-representable type');
    expect(diagnostics[0].file).toContain('repo-consumer.ts');
  });

  it('generates a correctly-qualified @Dependencies() call for the resolvable controller', () => {
    const emitted = fs.readFileSync(path.join(outDir, 'user.controller.js'), 'utf8');
    expect(emitted).toMatch(/\.Dependencies\(\s*\S+\.UserService\s*,\s*\S+\.Logger\s*\)/);
    // Regression guard for the exact bug this plugin's own README documents
    // hitting during development: an earlier version emitted `Dependencies`
    // and `UserService`/`Logger` as bare, unqualified identifiers because
    // synthetic ts.Identifier nodes carry no binding for the module
    // transform to rewrite -- that shape must never come back.
    expect(emitted).not.toMatch(/[^.\w]Dependencies\(UserService, Logger\)/);
  });

  it('does not touch RepoConsumer, which has no fully-resolvable dependency set', () => {
    const emitted = fs.readFileSync(path.join(outDir, 'repo-consumer.js'), 'utf8');
    expect(emitted).not.toContain('Dependencies(');
  });

  it('real end-to-end: the emitted, compiled code actually resolves correct DI metadata under Node', () => {
    // Spawns a real, separate Node process against the real compiled output
    // -- the same thing NestJS's own injector would load at runtime -- so
    // this proves the mechanism, not just that the AST looks plausible.
    const checkerScript = `
      require('reflect-metadata');
      const { UserController } = require('${path.join(outDir, 'user.controller.js').replace(/\\/g, '\\\\')}');
      const { UserService } = require('${path.join(outDir, 'user.service.js').replace(/\\/g, '\\\\')}');
      const { Logger } = require('${path.join(outDir, 'logger.js').replace(/\\/g, '\\\\')}');
      const paramtypes = Reflect.getMetadata('design:paramtypes', UserController);
      const instance = new UserController(new UserService(), new Logger());
      console.log(JSON.stringify({
        paramtypesMatch: paramtypes[0] === UserService && paramtypes[1] === Logger,
        paramtypesLength: paramtypes.length,
        isRealInstance: instance instanceof UserController,
      }));
    `;
    const scriptPath = path.join(outDir, '__checker.js');
    fs.writeFileSync(scriptPath, checkerScript);

    const nodeModulesLink = path.join(outDir, 'node_modules');
    if (!fs.existsSync(nodeModulesLink)) {
      fs.symlinkSync(path.join(__dirname, '..', 'node_modules'), nodeModulesLink, 'junction');
    }

    const output = execFileSync(process.execPath, [scriptPath], { encoding: 'utf8' });
    const result = JSON.parse(output);

    expect(result.paramtypesMatch).toBe(true);
    expect(result.paramtypesLength).toBe(2);
    expect(result.isRealInstance).toBe(true);
  });
});
