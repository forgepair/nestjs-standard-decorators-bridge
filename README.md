# nestjs-standard-decorators-bridge

A NestJS CLI compiler plugin that generates the constructor-injection
metadata TypeScript's standard (TC39) decorators will never emit
automatically, so a NestJS project can drop `experimentalDecorators`
without losing automatic dependency injection.

## Why I built this

NestJS's whole "just declare a constructor param and it's wired up" DX
(`constructor(private service: UserService)` resolving `UserService`
automatically) depends on TypeScript automatically emitting type metadata
for `@Injectable()`/`@Controller()` classes. TypeScript only ever did
that for its *legacy* decorator syntax (`experimentalDecorators` +
`emitDecoratorMetadata`). The new standard decorator syntax -- which
TypeScript itself, esbuild, Babel, bun, and deno have all supported since
2022-2023 -- will never get that automatic emission either: TypeScript's
team has explicitly, repeatedly declined to add it, citing a
"no type-directed emit" design principle
(`microsoft/TypeScript#57533`, open ~2 years, 29 comments, framework
maintainers directly asking for a resolution and getting none).

That leaves NestJS stuck: adopt the modern decorator syntax and lose
automatic DI (manually `@Inject('TOKEN')` every dependency, permanently
-- `valid-lab/wyrly`'s answer), or stay on legacy decorators indefinitely.
This plugin closes that gap without requiring TypeScript to change its
stance and without changing NestJS's developer experience at all.

## How it works

NestJS's own `@Dependencies()` decorator already exists precisely to set
this metadata manually -- it's not a new mechanism this tool invents:

```js
// @nestjs/common/decorators/core/dependencies.decorator.js
export const Dependencies = (...dependencies) => (target) => {
  Reflect.defineMetadata(PARAMTYPES_METADATA /* 'design:paramtypes' */, dependencies, target);
};
```

This plugin generates that call automatically at build time. It's
registered exactly like `@nestjs/swagger`'s own official CLI plugin
(`before(options, program)` returning a `ts.TransformerFactory`,
via `nest-cli.json`'s `compilerOptions.plugins`) -- reusing a real,
already-proven NestJS extension point rather than inventing new build
infrastructure. For each `@Injectable()`/`@Controller()` class, it reads
the real constructor parameter types off the TypeScript type checker
(the same `ts.Program` NestJS's own plugin loader already gives it) and
inserts `@Dependencies(...)` with the resolved classes.

Because this only transforms the in-memory AST used for emit -- it never
rewrites the `.ts` source files on disk -- there's no staleness or
idempotency concern: every build re-derives `@Dependencies()` fresh from
whatever the constructor currently says.

### Why not the TypeScript programmatic Compiler API

TypeScript 7 (Go rewrite) dropped the classic programmatic Compiler API
entirely (`createProgram`, `getParsedCommandLineOfConfigFile`) -- its own
replacement, `typescript/unstable/sync`, is real and has actually shipped
in TypeScript's stable channel since 7.0.2 (2026-07), not only in
`typescript@next` as sometimes reported. Regardless: this doesn't affect
this plugin. `@nestjs/cli`'s own build pipeline (v12.0.0, current)
still bundles `typescript: ~6.0.2` internally, and NestJS's lead
maintainer has said on the record he'd rather wait for the new
programmatic API to stabilize than redesign around spawning a separate
`tsc` process (`nestjs/nest-cli#3479`). This plugin follows that same
direction -- a `ts.Program`-based transformer, the same shape
`@nestjs/swagger`'s plugin already uses in production -- so it carries no
more TS7 risk than Swagger's own official plugin does today, and the
community has already documented a working TS6/TS7 side-by-side
compatibility layer for exactly this class of plugin.

## The one confirmed, permanent limitation (not new, pre-existing)

Interface-typed and generic-typed constructor parameters have no runtime
representation -- TypeScript's type erasure is fundamental, not an
artifact of this plugin. NestJS already requires explicit
`@Inject('TOKEN')` for interface-typed dependencies under the *current*
legacy-decorator system too, for the exact same reason. This plugin
detects that case and reports it (see `UnresolvedDiagnostic`) instead of
guessing or silently doing nothing.

## Install

```
npm install --save-dev nestjs-standard-decorators-bridge
```

`nest-cli.json`:

```json
{
  "compilerOptions": {
    "plugins": ["nestjs-standard-decorators-bridge"]
  }
}
```

## Verification

`test/plugin.test.ts` builds a real `ts.Program` over real fixture files
(no mocking), runs the plugin through `program.emit()`, and:

- confirms the interface-typed case (`RepoConsumer`) gets flagged, not
  silently skipped or guessed at;
- confirms the resolvable case (`UserController`) gets a correctly
  **qualified** `@Dependencies()` call -- this is a real regression guard:
  an earlier version of this plugin generated the call using bare
  synthetic identifiers, which compiled without error but were silently
  unbound at runtime, because TypeScript's CommonJS module transform only
  qualifies references it can trace back to the original parse tree.
  Confirmed by actually running the output and hitting a broken reference
  before fixing it with dedicated namespace imports (the same technique
  `@nestjs/swagger`'s own plugin uses for cross-file type references);
- spawns a **real, separate Node process** against the actual compiled
  output and confirms `Reflect.getMetadata('design:paramtypes',
  UserController)` resolves to the real `UserService`/`Logger` classes,
  and that a real instance constructs correctly -- proving the mechanism
  end-to-end, not just that the generated AST looks plausible.

## Known open items

- Not yet tested: same-file class declarations, default exports, or
  coexistence with another compiler plugin registered in the same
  `nest-cli.json`.
- Not yet wired into an actual `nest-cli.json`/`nest build` run against a
  real starter app -- verified via a direct `ts.Program` + `program.emit`
  driver that reproduces the same API surface nest-cli's plugin loader
  uses, not via nest-cli itself.
- A resolvable file whose targeted module is already imported elsewhere
  in the same file gets its own separate namespace import rather than
  reusing the existing one -- correct, but slightly wasteful output
  (an extra `require()` of an already-imported module under a second
  alias).
- Tool shape decided (persistent build-time compiler plugin, not a
  one-time codemod -- see "How it works" above) but not yet checked
  against NestJS's community channels for prior informal attempts at
  this exact approach.
- Not yet published to npm.

## License

MIT
