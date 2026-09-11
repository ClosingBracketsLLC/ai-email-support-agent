import { bindDropZone, type DropZoneNode } from './drop-zone.web'

const DRAG_EVENTS = ['dragenter', 'dragover', 'dragleave', 'drop'] as const

/** A fake DOM node — no jsdom, no react-native-web — that records listeners the way a real
 * `EventTarget` would, and lets a test dispatch a fabricated event straight to them. */
class FakeNode implements DropZoneNode {
  private listeners = new Map<string, Set<EventListener>>()
  addEventListener(type: string, listener: EventListener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(listener)
  }
  removeEventListener(type: string, listener: EventListener) {
    this.listeners.get(type)?.delete(listener)
  }
  countFor(type: string): number {
    return this.listeners.get(type)?.size ?? 0
  }
  dispatch(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(event as Event)
  }
}

function fakeDragEvent(dataTransfer?: { files: File[] }) {
  return { preventDefault: jest.fn(), dataTransfer }
}

test('binds all four drag events', () => {
  const node = new FakeNode()
  bindDropZone(node, { onFiles: jest.fn() })
  for (const type of DRAG_EVENTS) expect(node.countFor(type)).toBe(1)
})

test('preventDefault is called on every one of the four events', () => {
  const node = new FakeNode()
  bindDropZone(node, { onFiles: jest.fn() })
  for (const type of DRAG_EVENTS) {
    const event = fakeDragEvent()
    node.dispatch(type, event)
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
  }
})

test('drop hands the dropped files to onFiles', () => {
  const node = new FakeNode()
  const onFiles = jest.fn()
  bindDropZone(node, { onFiles })
  const file = { name: 'notes.pdf', type: 'application/pdf', size: 42 } as unknown as File
  node.dispatch('drop', fakeDragEvent({ files: [file] }))
  expect(onFiles).toHaveBeenCalledTimes(1)
  expect(onFiles).toHaveBeenCalledWith([file])
})

test('a drop with no dataTransfer files calls onFiles with an empty array', () => {
  const node = new FakeNode()
  const onFiles = jest.fn()
  bindDropZone(node, { onFiles })
  node.dispatch('drop', fakeDragEvent(undefined))
  expect(onFiles).toHaveBeenCalledWith([])
})

test('onDragState toggles true on dragenter and false on drop', () => {
  const node = new FakeNode()
  const onDragState = jest.fn()
  bindDropZone(node, { onFiles: jest.fn(), onDragState })
  node.dispatch('dragenter', fakeDragEvent())
  expect(onDragState).toHaveBeenLastCalledWith(true)
  node.dispatch('drop', fakeDragEvent({ files: [] }))
  expect(onDragState).toHaveBeenLastCalledWith(false)
})

test('the returned unbind removes all four listeners', () => {
  const node = new FakeNode()
  const unbind = bindDropZone(node, { onFiles: jest.fn() })
  unbind()
  for (const type of DRAG_EVENTS) expect(node.countFor(type)).toBe(0)
})
