# AGENTS.md - opencode-voice

Guidelines for AI agents working in this repository. Keep this file concise -
only document constraints and rules an agent would get wrong without being told.

## Architecture

Single TUI plugin exported from `index.js` with logic split into `lib/`.

## Key invariants

- Single default export: `{ id, tui }`. No server-side plugin.
- LLM calls use the OpenAI chat completions API, not the Anthropic messages API.
- Configuration uses `options` (static) and `api.kv` (runtime). No dotfile I/O.
- No build step. Plain ESM JavaScript, shipped as-is.

## Scripts

```bash
npm run test         # node --test
npm run check        # lint + fmt
npm run lint         # oxlint .
npm run fmt          # oxfmt --check .
npm run fmt:fix      # oxfmt --write .
```

Verify changes: `npm run check` with zero errors.

CI runs on every PR and push to main (lint, test, build). See
RELEASE_PROCESS.md for release steps.

## Code style

- **ESM only** - `import`/`export`, `"type": "module"` in package.json
- **No build step** - no TypeScript, no bundler
- **Formatting** - enforced by oxfmt
- **Linting** - enforced by oxlint

<!-- SPECKIT START -->

For additional context about technologies to be used, project structure,
shell commands, and other important information, read the current plan:
`specs/001-enterprise-gateway-stt/plan.md`

The plan for the follow-on feature is `specs/002-continuous-wake-phrase/plan.md`.
It depends on 001 and must not be started before 001 Phase B is complete.
<!-- SPECKIT END -->
