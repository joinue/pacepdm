import { vi } from "vitest";

/**
 * Chainable mock for Supabase query builder.
 * Each method returns `this` so calls like .from().select().eq().single() work.
 * Set `mockData` / `mockError` before the test to control what queries return.
 */
export function createMockQueryBuilder(overrides?: {
  data?: unknown;
  error?: unknown;
}) {
  const result = { data: overrides?.data ?? null, error: overrides?.error ?? null };

  const builder: Record<string, unknown> = {};
  const chainMethods = [
    "from", "select", "insert", "update", "delete",
    "eq", "in", "neq", "is", "order", "limit", "single",
    "upsert", "match",
  ];

  for (const method of chainMethods) {
    builder[method] = vi.fn().mockReturnValue(builder);
  }

  // Terminal methods that resolve the query
  builder.single = vi.fn().mockResolvedValue(result);
  // Make the builder itself thenable so `await db.from(...).select(...).eq(...)` works
  builder.then = (resolve: (v: unknown) => void) => resolve(result);

  // Override `from` to return the builder (entry point)
  builder.from = vi.fn().mockReturnValue(builder);

  return builder;
}

// Default mock for getServiceClient
export const mockDb = createMockQueryBuilder();

export const getServiceClient = vi.fn().mockReturnValue(mockDb);
