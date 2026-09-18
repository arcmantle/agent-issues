# Refactor Candidates

After a TDD cycle, look for:

- Duplication: extract a function or a class.
- Long methods: break them into private helpers. Keep the tests on the public interface.
- Shallow modules: combine them or add depth.
- Feature envy: move the logic to where the data lives.
- Primitive obsession: introduce value objects.
- Existing code that the new work shows is a problem.

After the code refactor, look for test-contract surplus:

- Two tests that cannot fail independently.
- Near-duplicate tests that pin the same public API with a small fixture change.
- Driving tests that remain after a keeper already covers the behavior.
- Table cases that belong in one test instead of many tests.

If test A cannot fail unless test B also fails, delete test A. Do not keep a driving test as history. Git already keeps that history.