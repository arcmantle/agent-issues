# Refactor Candidates

After a TDD cycle, look for:

- Duplication: extract a function or a class.
- Long methods: break them into private helpers. Keep the tests on the public interface.
- Shallow modules: combine them or add depth.
- Feature envy: move the logic to where the data lives.
- Primitive obsession: introduce value objects.
- Existing code that the new work shows is a problem.