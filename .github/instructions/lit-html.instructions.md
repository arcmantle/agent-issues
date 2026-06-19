---
applyTo: "**/*.ts"
description: "Use when writing or editing Lit components, LitElement classes, lit-html templates, or render() methods. Covers template formatting, directive usage (when, choose, map, repeat), and multi-attribute element conventions."
---

# Lit Template Conventions

## Directives
Always use lit directives (`when`, `choose`, `map`, `repeat`) to optimize rendering performance.

**Never use ternary operators (`? :`) or `&&` short-circuits** inside lit-html templates for conditional rendering. Always use `when()`:
```ts
// ✅ Correct
${ when(this.value,
  () => html`<span>${ this.value }</span>`,
  () => html`<span>fallback</span>`) }

// ❌ Wrong — do not use ternaries in templates
${ this.value
  ? html`<span>${ this.value }</span>`
  : html`<span>fallback</span>` }
```

## Template Formatting

Templates should use a newline after the opening backtick and before the closing backtick.
Root-level elements align with the `return` statement, not pushed to column 0:
```ts
  override render() {
    return html`
    <div>
      <p>Content here</p>
    </div>
    `;
  }
```
NOT over-indented:
```ts
  override render() {
    return html`
      <div>
        <p>Content here</p>
      </div>
    `;
  }
```

## Multi-Attribute Elements

When an element has **more than one attribute**, each attribute goes on its own line.
The closing `>` goes on its own line. Content is on its own line. The closing tag is on its own line:
```ts
<button
	class=${ classMap({ chip: true, selected: !!this.value }) }
	@click=${ () => { this._open = !this._open; } }
>
${ when(
	this.value,
	() => html`<span>${ this.value }</span>`,
	() => html`<span>fallback</span>`,
) }
</button>
```
NOT all on one line:
```ts
<button class=${ classMap({ chip: true }) } @click=${ handler }>
	${ when(this.value, () => html`...`, () => html`...`) }
</button>
```

# Class ordering
Within a LitElement class, order members as follows:
1. Static fields
2. Static methods
3. Constructor
4. Instance fields
5. Instance methods
6. `render()` method (always at the end of the class)
7. Style methods (e.g. `static styles`) should be placed immediately after the `render()` method.

# Global declaration
Always create a global declaration for the custom element, even if it is not strictly necessary. This ensures that the element can be used in any TypeScript file without type errors. This should be placed at the end of the file, after the class definition.
Include custom events in the global declaration if applicable:
```ts
declare global {
  interface HTMLElementTagNameMap {
    'dashboard-app': DashboardApp;
  }
  interface HTMLElementEventMap {
    'dashboard-app-event': CustomEvent<{ detail: string }>;
  }
}
```

# Events
All event bindings should use class methods as handlers, not inline functions. This ensures that the same function reference is used across renders, which is important for performance and correctness:

```ts
`<button @click=${ this.handleClick }>Click me</button>`
```

Additionally, event handler methods should use input values from the event object rather than relying on closure variables, to ensure they work correctly across renders:
```ts
handleInput(e: Event) {
  const input = e.target as HTMLInputElement;
  this.value = input.value;
}
```

# Size
A component file should ideally be under 800 lines. If it exceeds this, consider breaking it into smaller components or extracting logic into separate modules to maintain readability and manageability.