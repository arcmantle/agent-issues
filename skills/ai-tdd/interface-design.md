# Interface Design for Testability

Good interfaces make testing natural:

1. Accept dependencies instead of creating them.

   ```typescript
   function processOrder(order, paymentGateway) {}
   ```

2. Return results instead of producing side effects.

   ```typescript
   function calculateDiscount(cart): Discount {}
   ```

3. Keep the surface area small.

- Fewer methods mean fewer tests.
- Fewer parameters mean simpler test setup.