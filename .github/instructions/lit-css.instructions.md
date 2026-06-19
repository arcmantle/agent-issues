---
applyTo: "**/*.ts"
description: "Use when writing or editing css styles in the project. Covers formatting, property ordering, and conventions for writing maintainable CSS."
---

There should be no more than one declaration per line:
```css
/* ✅ Correct */
.selector {
  color: red;
  background: blue;
}
/* ❌ Wrong */
.selector {
  color: red; background: blue;
}
```

There should be no empty newlines between declarations:
```css
/* ✅ Correct */
.selector1 {
  color: red;
  background: blue;
}
.selector2 {
  color: green;
  background: yellow;
}
/* ❌ Wrong */
.selector1 {
  color: red;
  background: blue;
}

.selector2 {
  color: green;
  background: yellow;
}
```

Never use the `!important` flag. If you find yourself needing to use `!important`, it's a sign that your CSS structure needs to be refactored for better specificity and maintainability.

Never put a declaration on a single line. Each declaration should be on its own line for better readability and maintainability.
```css
/* ✅ Correct */
.selector {
  color: red;
}
/* ❌ Wrong */
.selector { color: red; }
```

## CSS Formatting

CSS templates should use a newline after the opening backtick and before the closing backtick.
Root-level elements align with the `return` statement, not pushed to column 0:
```ts
class MyComponent extends LitElement {
  static styles = css`
  .selector {
    color: red;
  }
  `;
  }
```
NOT over-indented:
```ts
class MyComponent extends LitElement {
  static styles = css`
    .selector {
      color: red;
    }
  `;
}
```