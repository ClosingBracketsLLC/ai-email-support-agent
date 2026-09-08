import { fireEvent, render, screen } from '@testing-library/react-native'
import { MemberRow } from './member-row'

const ann = { id: 'm1', userId: 'u1', role: 'owner' as const, name: 'Ann', email: 'ann@example.com' }
const bob = { id: 'm2', userId: 'u2', role: 'member' as const, name: 'Bob', email: 'bob@example.com' }

test('a manager sees role and remove actions for others, never for the owner or themselves', async () => {
  const onChangeRole = jest.fn(); const onRemove = jest.fn()
  await render(<MemberRow member={bob} meUserId="u1" canManage onChangeRole={onChangeRole} onRemove={onRemove} />)
  await fireEvent.press(screen.getByText('Make admin'))
  expect(onChangeRole).toHaveBeenCalledWith('m2', 'admin')
  await fireEvent.press(screen.getByText('Remove'))
  await fireEvent.press(screen.getByText('Confirm remove'))
  expect(onRemove).toHaveBeenCalledWith('m2')

  await render(<MemberRow member={ann} meUserId="u1" canManage onChangeRole={onChangeRole} onRemove={onRemove} />)
  expect(screen.queryByText('Remove')).toBeNull()
  expect(screen.getByText('Owner · you')).toBeTruthy()
})

test('a plain member sees no actions', async () => {
  await render(<MemberRow member={bob} meUserId="u3" canManage={false} onChangeRole={jest.fn()} onRemove={jest.fn()} />)
  expect(screen.queryByText('Make admin')).toBeNull()
  expect(screen.queryByText('Remove')).toBeNull()
})
