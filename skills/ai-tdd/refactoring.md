# Refactor Candidates

After a TDD cycle, look for:

- Duplication -> extract a function or class.
- Long methods -> break into private helpers while keeping tests on the public interface.
- Shallow modules -> combine or deepen them.
- Feature envy -> move logic to where the data lives.
- Primitive obsession -> introduce value objects.
- Existing code that the new work reveals as problematic.