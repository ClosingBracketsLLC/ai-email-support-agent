export const DEFAULT_CATEGORIES = [
  { key: 'order_status', label: 'Order status' },
  { key: 'shipping_delivery', label: 'Shipping & delivery' },
  { key: 'returns_refunds', label: 'Returns & refunds' },
  { key: 'product_question', label: 'Product question' },
  { key: 'billing_payment', label: 'Billing & payment' },
  { key: 'account_access', label: 'Account & access' },
  { key: 'complaint', label: 'Complaint' },
  { key: 'other', label: 'Other' },
] as const

export type CategoryKey = (typeof DEFAULT_CATEGORIES)[number]['key']

export const CATEGORY_KEYS: readonly CategoryKey[] = DEFAULT_CATEGORIES.map((c) => c.key)
