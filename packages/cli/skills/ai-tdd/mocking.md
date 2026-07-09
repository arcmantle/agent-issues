# When to Mock

Mock at system boundaries only:

- External APIs
- Databases when a test database is not practical
- Time and randomness
- File system access when needed

Do not mock:

- Your own classes or modules
- Internal collaborators
- Anything you control

## Designing for Mockability

At system boundaries, design interfaces that are easy to mock.

1. Use dependency injection.
2. Prefer SDK-style interfaces over generic fetchers.

The SDK approach means:

- Each mock returns one specific shape.
- No conditional logic in test setup.
- Easier to see which endpoints a test exercises.
- Better type safety per endpoint.