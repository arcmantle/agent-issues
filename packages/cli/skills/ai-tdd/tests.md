# Good and Bad Tests

## Good tests

An integration-style test goes through a real interface. It does not mock internal parts.

```typescript
test("user can checkout with valid cart", async () => {
  const cart = createCart();
  cart.add(product);
  const result = await checkout(cart, paymentMethod);
  expect(result.status).toBe("confirmed");
});
```

Look for these traits:

- Tests behavior that users or callers care about.
- Uses the public API only.
- Survives an internal refactor.
- Describes what the code does, not how.
- Has one logical assertion per test.

## Bad tests

An implementation-detail test is tied to the internal structure.

```typescript
test("checkout calls paymentService.process", async () => {
  const mockPayment = jest.mock(paymentService);
  await checkout(cart, payment);
  expect(mockPayment.process).toHaveBeenCalledWith(cart.total);
});
```

Watch for these warning signs:

- Mocking internal collaborators.
- Testing private methods.
- Asserting on call counts or call order.
- Breaking on a refactor with no behavior change.
- Test names that describe how, not what.
- Checking through an external system instead of through the interface.

```typescript
test("createUser saves to database", async () => {
  await createUser({ name: "Alice" });
  const row = await db.query("SELECT * FROM users WHERE name = ?", ["Alice"]);
  expect(row).toBeDefined();
});

test("createUser makes user retrievable", async () => {
  const user = await createUser({ name: "Alice" });
  const retrieved = await getUser(user.id);
  expect(retrieved.name).toBe("Alice");
});
```