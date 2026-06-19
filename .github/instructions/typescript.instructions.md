---
applyTo: "**/*.ts"
description: "Use when writing or editing typescript files. Covers general TypeScript code style, including naming conventions, formatting, and best practices."
---

# Classes
Use `PascalCase` for class names:
```ts
class MyClass {
  // ...
}
```
# Field types
Never use private fields, only use protected or public fields.
```ts
class MyClass {
  protected myField: string;
  public myOtherField: number;
}
```
# Constructors
Never use constructor parameter properties. Always declare and assign class fields separately from the constructor parameters:
Always place the constructor at the top of the class, before any other non static methods or properties:
```ts
class MyClass {
  constructor(myField: string, myOtherField: number) {
    this.myField = myField;
    this.myOtherField = myOtherField;
  }

  protected myField: string;
  public myOtherField: number;
}
```
# Static members
Static members should be placed at the top of the class, immediately before the constructor.

# Class Ordering
Within a class, order members as follows:
1. Static fields
2. Static methods
3. Constructor
4. Instance fields
5. Instance methods
