/**
 * A NestJS CLI compiler plugin, in the same `before(options, program)` shape
 * as `@nestjs/swagger`'s own plugin (dist/plugin/compiler-plugin.js),
 * registered the same way via nest-cli.json's `compilerOptions.plugins`.
 *
 * Standard (TC39) decorators never get automatic constructor type-metadata
 * emission -- TypeScript's team has explicitly declined to add it
 * (microsoft/TypeScript#57533). NestJS's own `@Dependencies()` decorator
 * already exists precisely to set that metadata manually
 * (Reflect.defineMetadata('design:paramtypes', deps, target) --
 * @nestjs/common/decorators/core/dependencies.decorator.js). This plugin
 * generates that call automatically at build time by reading each
 * `@Injectable()`/`@Controller()` class's real constructor parameter types
 * off the type checker, so a project can move to standard decorators without
 * losing NestJS's "just declare a constructor param" DX.
 *
 * Because this only transforms the in-memory AST used for emit -- it never
 * rewrites the .ts source files on disk -- there is no staleness/idempotency
 * concern: every build re-derives `@Dependencies()` fresh from whatever the
 * constructor currently says.
 *
 * Reference-generation note: a synthetic ts.Identifier created via
 * `factory.createIdentifier(name)` carries no symbol/binding, so
 * TypeScript's CommonJS module transform doesn't know to qualify it (e.g.
 * `common_1.X`) and emits it as a bare, unbound name -- confirmed by
 * actually running the naive version of this and hitting exactly that
 * bug. The fix, matching Swagger's own proven technique
 * (utils/type-reference-to-identifier.util.js's `hoistTypeImport`), is to
 * give every cross-file reference its own dedicated namespace import
 * (`import * as __x from 'mod'`), which TypeScript emits as a plain
 * `const __x = require('mod')` needing no per-reference rewriting, then
 * reference `__x.Name` directly. A same-file declaration needs no import
 * and can be referenced by plain name.
 */
import * as ts from 'typescript';

const DI_DECORATOR_NAMES = new Set(['Injectable', 'Controller']);

export interface PluginOptions {
  /** Decorator names (beyond Injectable/Controller) that mark a DI target. */
  extraDecoratorNames?: string[];
}

export interface UnresolvedDiagnostic {
  file: string;
  className: string;
  message: string;
}

interface ResolvedDependency {
  name: string;
  declaration: ts.ClassDeclaration;
}

function hasDiDecorator(node: ts.Node, decoratorNames: Set<string>): node is ts.ClassDeclaration {
  if (!ts.isClassDeclaration(node) || !node.name) return false;
  const decorators = ts.canHaveDecorators(node) && ts.getDecorators(node);
  if (!decorators) return false;
  return decorators.some(
    (d) =>
      ts.isCallExpression(d.expression) &&
      ts.isIdentifier(d.expression.expression) &&
      decoratorNames.has(d.expression.expression.text),
  );
}

function findConstructor(node: ts.ClassDeclaration): ts.ConstructorDeclaration | undefined {
  return node.members.find(ts.isConstructorDeclaration) as ts.ConstructorDeclaration | undefined;
}

/**
 * Maps each locally-imported name in this file to the module specifier it
 * came from (named imports only -- covers the realistic case, since a
 * constructor param type must already be a real, in-scope value for
 * NestJS's *current* legacy-decorator DI to work at all).
 */
function buildLocalImportMap(sourceFile: ts.SourceFile): Map<string, string> {
  const map = new Map<string, string>();
  for (const stmt of sourceFile.statements) {
    if (
      ts.isImportDeclaration(stmt) &&
      ts.isStringLiteral(stmt.moduleSpecifier) &&
      stmt.importClause?.namedBindings &&
      ts.isNamedImports(stmt.importClause.namedBindings)
    ) {
      for (const el of stmt.importClause.namedBindings.elements) {
        map.set(el.name.text, stmt.moduleSpecifier.text);
      }
    }
  }
  return map;
}

/**
 * Resolves each constructor param to a real, runtime-representable class.
 * Interface- and generic-typed params have no runtime representation --
 * that's not a gap this plugin introduces, NestJS already requires explicit
 * `@Inject('TOKEN')` for those under the current legacy-decorator system too,
 * for the same type-erasure reason. This plugin's job is to detect that case
 * and report it, not to guess or silently skip it.
 */
function resolveParamTypes(
  checker: ts.TypeChecker,
  ctor: ts.ConstructorDeclaration,
): { resolved: ResolvedDependency[]; unresolved: string[] } {
  const resolved: ResolvedDependency[] = [];
  const unresolved: string[] = [];
  for (const param of ctor.parameters) {
    const type = checker.getTypeAtLocation(param);
    const symbol = type.getSymbol();
    if (symbol?.valueDeclaration && ts.isClassDeclaration(symbol.valueDeclaration)) {
      resolved.push({ name: symbol.name, declaration: symbol.valueDeclaration });
    } else {
      unresolved.push(param.name.getText());
    }
  }
  return { resolved, unresolved };
}

export type NestDiTransformerFactory = ts.TransformerFactory<ts.SourceFile> & {
  diagnostics: UnresolvedDiagnostic[];
};

/**
 * nest-cli.json's `compilerOptions.plugins` loader expects a module that
 * exports `before` directly and calls it as `before(pluginOptions, program)`
 * -- this must stay a plain function with that exact signature, not a
 * factory you call first, to stay loadable the same way.
 */
export function before(options: PluginOptions = {}, program: ts.Program): NestDiTransformerFactory {
  const checker = program.getTypeChecker();
  const decoratorNames = new Set([...DI_DECORATOR_NAMES, ...(options.extraDecoratorNames ?? [])]);
  const diagnostics: UnresolvedDiagnostic[] = [];

  const transformerFactory: ts.TransformerFactory<ts.SourceFile> = (ctx) => (sourceFile) => {
    const localImportMap = buildLocalImportMap(sourceFile);
    const neededNamespaceImports = new Map<string, string>();
    let commonAlias: string | null = null;

    const aliasFor = (moduleSpecifier: string): string => {
      let alias = neededNamespaceImports.get(moduleSpecifier);
      if (!alias) {
        alias = `__nest_di_${neededNamespaceImports.size + 1}`;
        neededNamespaceImports.set(moduleSpecifier, alias);
      }
      return alias;
    };

    const referenceFor = (dep: ResolvedDependency): ts.Expression | null => {
      const declFile = dep.declaration.getSourceFile();
      if (declFile.fileName === sourceFile.fileName) {
        return ctx.factory.createIdentifier(dep.name);
      }
      const moduleSpecifier = localImportMap.get(dep.name);
      if (!moduleSpecifier) {
        diagnostics.push({
          file: sourceFile.fileName,
          className: dep.name,
          message: 'resolved to a class but no importable module path found in this file -- skipping',
        });
        return null;
      }
      const alias = aliasFor(moduleSpecifier);
      return ctx.factory.createPropertyAccessExpression(ctx.factory.createIdentifier(alias), dep.name);
    };

    const visitClass = (node: ts.Node): ts.Node => {
      if (hasDiDecorator(node, decoratorNames)) {
        const ctor = findConstructor(node);
        if (ctor && ctor.parameters.length > 0) {
          const { resolved, unresolved } = resolveParamTypes(checker, ctor);
          if (unresolved.length > 0) {
            diagnostics.push({
              file: sourceFile.fileName,
              className: node.name!.text,
              message: `param(s) [${unresolved.join(', ')}] have no runtime-representable type -- needs manual @Inject()`,
            });
          } else {
            const depExprs = resolved.map(referenceFor);
            if (depExprs.every((e): e is ts.Expression => e !== null)) {
              if (!commonAlias) commonAlias = aliasFor('@nestjs/common');
              const existingDecorators = ts.getDecorators(node) ?? [];
              const otherModifiers = ts.getModifiers(node) ?? [];
              const dependenciesDecorator = ctx.factory.createDecorator(
                ctx.factory.createCallExpression(
                  ctx.factory.createPropertyAccessExpression(
                    ctx.factory.createIdentifier(commonAlias),
                    'Dependencies',
                  ),
                  undefined,
                  depExprs,
                ),
              );
              return ctx.factory.updateClassDeclaration(
                node,
                [...existingDecorators, dependenciesDecorator, ...otherModifiers],
                node.name,
                node.typeParameters,
                node.heritageClauses,
                node.members,
              );
            }
          }
        }
      }
      return ts.visitEachChild(node, visitClass, ctx);
    };

    let updatedSourceFile = ts.visitNode(sourceFile, visitClass) as ts.SourceFile;

    if (neededNamespaceImports.size > 0) {
      const newImports = [...neededNamespaceImports.entries()].map(([moduleSpecifier, alias]) =>
        ctx.factory.createImportDeclaration(
          undefined,
          ctx.factory.createImportClause(
            false,
            undefined,
            ctx.factory.createNamespaceImport(ctx.factory.createIdentifier(alias)),
          ),
          ctx.factory.createStringLiteral(moduleSpecifier),
        ),
      );
      updatedSourceFile = ctx.factory.updateSourceFile(updatedSourceFile, [
        ...newImports,
        ...updatedSourceFile.statements,
      ]);
    }

    return updatedSourceFile;
  };

  return Object.assign(transformerFactory, { diagnostics });
}
