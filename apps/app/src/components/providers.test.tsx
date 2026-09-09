import { focusManager } from '@tanstack/react-query'
import { render } from '@testing-library/react-native'
import type { ReactNode } from 'react'
import { AppState, Platform } from 'react-native'
import { Providers } from './providers'

jest.mock('@/lib/trpc', () => ({
  TRPCProvider: ({ children }: { children: ReactNode }) => children,
  createTrpcClient: () => ({}),
}))

const teardowns: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const teardown of teardowns.splice(0)) await teardown() })

test('native: AppState changes drive focusManager.setFocused, and unmounting removes the listener', async () => {
  const os = jest.replaceProperty(Platform, 'OS', 'ios')
  const setFocused = jest.spyOn(focusManager, 'setFocused').mockImplementation(() => {})
  const remove = jest.fn()
  const addEventListener = jest.spyOn(AppState, 'addEventListener').mockReturnValue({ remove } as unknown as ReturnType<typeof AppState.addEventListener>)
  try {
    const rendered = await render(<Providers><></></Providers>)
    teardowns.push(rendered.unmount)

    expect(addEventListener).toHaveBeenCalledWith('change', expect.any(Function))
    const handler = addEventListener.mock.calls[0]?.[1] as (status: string) => void

    handler('active')
    expect(setFocused).toHaveBeenCalledWith(true)
    handler('background')
    expect(setFocused).toHaveBeenCalledWith(false)

    await rendered.unmount()
    expect(remove).toHaveBeenCalledTimes(1)
  } finally {
    os.restore()
    setFocused.mockRestore()
    addEventListener.mockRestore()
  }
})

test('web: keeps TanStack Query\'s default focus tracking — never touches AppState or focusManager', async () => {
  const os = jest.replaceProperty(Platform, 'OS', 'web')
  const setFocused = jest.spyOn(focusManager, 'setFocused').mockImplementation(() => {})
  const addEventListener = jest.spyOn(AppState, 'addEventListener')
  try {
    const rendered = await render(<Providers><></></Providers>)
    teardowns.push(rendered.unmount)

    expect(addEventListener).not.toHaveBeenCalled()
    expect(setFocused).not.toHaveBeenCalled()
  } finally {
    os.restore()
    setFocused.mockRestore()
    addEventListener.mockRestore()
  }
})
