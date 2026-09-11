import { bindWindowDropGuard, type DropGuardTarget } from './drop-guard'

class FakeTarget implements DropGuardTarget {
  private listeners = new Map<string, Set<EventListener>>()
  addEventListener(type: string, listener: EventListener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(listener)
  }
  removeEventListener(type: string, listener: EventListener) { this.listeners.get(type)?.delete(listener) }
  countFor(type: string): number { return this.listeners.get(type)?.size ?? 0 }
  dispatch(type: string, event: unknown) { for (const l of this.listeners.get(type) ?? []) l(event as Event) }
}

test('binds dragover and drop, and prevents the default on both', () => {
  const target = new FakeTarget()
  bindWindowDropGuard(target)
  expect(target.countFor('dragover')).toBe(1)
  expect(target.countFor('drop')).toBe(1)

  for (const type of ['dragover', 'drop']) {
    const event = { preventDefault: jest.fn() }
    target.dispatch(type, event)
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
  }
})

test('the returned unbind removes both listeners', () => {
  const target = new FakeTarget()
  bindWindowDropGuard(target)()
  expect(target.countFor('dragover')).toBe(0)
  expect(target.countFor('drop')).toBe(0)
})
