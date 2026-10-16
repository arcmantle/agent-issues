# Harness Design Exploration

This folder contains one current Harness prototype. It includes the workspace, Planning,
Settings, agent overlays, and simulated Merge sessions. Activity is simulated;
there are no live agent processes, provider calls, or Git writes.

Install the workspace dependencies with `pnpm install` first. From the repository
root, run:

```console
pnpm --filter @agent-issues/site exec vite --config ../../design-explorations/harness/vite.config.ts
```

Open the URL printed by Vite. It starts on port 5328 or the next available port.
Use the server rather than opening the HTML file directly.

The Vite development server uses the site's installed Vite, Lit, and Lucide
dependencies. It serves the TypeScript entry directly on the same origin and
caches optimized dependencies in the site's node_modules folder. Component
changes reload the page automatically. A reload resets the simulated state.

Check the components without starting the server:

```console
pnpm exec tsc -p design-explorations/harness/tsconfig.json
pnpm --filter @agent-issues/site exec vitest run --config ../../design-explorations/harness/vite.config.ts
```

`LightElement` returns `this` from `createRenderRoot()`. All application views use
real Lit templates in light DOM:

- Application navigation, workspace tabs, repository sidebar and header.
- Initiative selector, tracked records, usage meter, run header and controls.
- Initiative route, route sections, issue lists and cards, status badges.
- PRD context and PRD links.
- Terminal selection, terminal grid and terminal panels.
- Merge file list, requirements, checks and activity timeline.
- Planning launch, conversation, Plan entries, and Pioneer graph.
- Settings, Review checkpoint, Merge workspace, library-backed diffs, and dialogs.

Keyed lists retain issue and terminal nodes during partial updates. Components
receive typed view models. TypeScript controllers own the simulated state.
Native events connect the views to those controllers. xterm owns its unmanaged
terminal mounts and retains each terminal and input draft across navigation.
jsdiff computes the line differences. There are no iframes, injected scripts,
global-function replacements, mutation-based mounts, or HTML-string renderers.

## Files

- [index.html](index.html) is the only application entry page.
- [app.ts](app.ts) loads the [application.ts](application.ts) Lit application.
- [application-state.ts](application-state.ts) owns page state, events, and controller coordination.
- [app.css](app.css) contains the current C styles.
- [planning.ts](planning.ts), [simulation.ts](simulation.ts), [merge.ts](merge.ts),
  and [settings.ts](settings.ts) own the simulated workflows.
- [terminals.ts](terminals.ts) retains and updates xterm sessions.
- [components/](components/) contains the light-DOM Lit components.
- [vite.config.ts](vite.config.ts) configures Vite and Vitest.
- [prototype-api.ts](prototype-api.ts) provides guarded, read-only folder and
  Git-root inspection. It does not write files or run agents.

The old A/B layouts and design switcher are removed. The saved C reference remains
unchanged in the separate agent-issues-harness-prototype source worktree. This
folder contains the current prototype only.

The initiative example contains 42 issues, a 30-issue main chain, and three later
parallel fork/join stages. Serial sections expand to show their issues. Final
approval stays separate from the chain.

Initiative, Review, and Merge remain visible as separate tabs. Review and Merge
show pending counts and empty states when no work is available. The initial
example has one completed worker checkpoint ready for Review and no Merge work.
Review approval adds that checkpoint to the Merge queue without running the
Merge agent. Merge approval, resolution approval, and passing checks remain
separate requirements. Paused work stays visible, but its actions are blocked.

The layout supports desktop and tablet screens, with a 768px minimum width.
Fonts and the pinned CDN libraries require internet access. State is held in
memory and resets on reload. The server is disabled in production mode.
