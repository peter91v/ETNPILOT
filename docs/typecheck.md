# Type-check status

`npm run typecheck` (part of `npm run check`) checks every file under `src/` except the page's browser scripts
in `src/ui/client/`, which run in one shared scope in the browser and are covered by `npm run test:ui`.
Every checked file starts with `// @ts-check`; a new file without it fails `test/package.test.js`'s companion
check below, so the list cannot quietly shrink again.

Where the inferred type was wrong or too narrow, the code says so with a cast (`/** @type {any} */`) rather than
a rewrite; those casts are the places to tighten when a file is next worked on. `@github/copilot-sdk` is an
optional dependency, so its two `import()` sites carry `@ts-ignore`.
