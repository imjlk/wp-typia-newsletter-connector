# wp-typia Doctor Notes

This workspace tracks the published `wp-typia@0.28.0` toolchain, but the CLI
binary is not installed as a direct project dependency. Use the pinned doctor
wrapper instead of `pnpm exec wp-typia`:

```bash
pnpm run doctor:wp-typia
```

The wrapper runs:

```bash
pnpm dlx wp-typia@0.28.0 doctor --format json
```

## Toolchain Matrix

`@wp-typia/block-runtime@0.10.1` enforces a supported toolchain matrix via
`assertTypiaWebpackCompatibility`, checked on every `pnpm run build`:

- `typia` 13.x
- `ttsc` 0.26.x
- `typescript` 7.x
- `@ttsc/lint` 0.26.2
- `@ttsc/unplugin` 0.26.x
- `@wp-typia/ttsc-lint-plugin-wp` 0.2.x
- `@wordpress/scripts` 30.x with webpack 5.x

A mismatch in any of these raises before webpack runs. The matrix is satisfied
by the pinned `package.json` devDependencies; do not silently downgrade any of
them.

## Combined Code-Quality Gate

`pnpm run check` is the canonical local and CI entry point:

- `check:code` runs generated-artifact drift detection followed by
  `ttsc check --noEmit`. It covers TypeScript, TSX, JavaScript, and JSX with the
  compiled WordPress Scripts recommended preset and WordPress-native rules.
- `check:style` keeps `wp-scripts lint-style` for CSS and SCSS.

There are intentionally no `lint`, `lint:js`, `lint:css`, or `typecheck`
aliases. This avoids implying that the code gate is lint-only when it also
enforces TypeScript diagnostics and generated-artifact consistency. The
project-owned `format` script remains independent from these read-only checks.

`postinstall` applies the version-pinned `@ttsc/lint@0.26.2` compatibility
repair shipped by the wp-typia adoption layer. The script fails closed on any
unexpected package version or source shape so an upstream upgrade cannot
silently retain an obsolete patch.

## Expected Local Result

On a machine without Bun available to `wp-typia`, upstream doctor returns exit
code `1` because the environment readiness check reports:

```text
Bun: Not available
```

That is expected for this repository as long as the Node fallback runtime runs
and all workspace diagnostics pass. The wrapper treats this exact Bun-only
readiness failure as documented and exits successfully.

The following checks must still pass:

- package metadata
- workspace inventory
- REST resource bootstrap
- all configured REST resource references
- Node, git, current directory, and temp directory readiness

Any non-Bun failure remains a real failure. Install Bun 1.3.11+ if you need the
full Bunli/OpenTUI runtime or Bun-only wp-typia commands such as `skills`,
`completions`, or `mcp`.
