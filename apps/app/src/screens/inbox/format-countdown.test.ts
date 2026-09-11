import { formatCountdown } from './format-countdown'

test('under a minute it stays in bare seconds — the 15-second undo window', () => {
  expect(formatCountdown(15)).toBe('15s')
  expect(formatCountdown(12)).toBe('12s')
  expect(formatCountdown(0)).toBe('0s')
})

test('from a minute up it is m:ss, zero-padded — the 2/5/15-minute hold windows', () => {
  expect(formatCountdown(59)).toBe('59s')
  expect(formatCountdown(60)).toBe('1:00')
  expect(formatCountdown(61)).toBe('1:01')
  expect(formatCountdown(119)).toBe('1:59')
  expect(formatCountdown(899)).toBe('14:59')
  expect(formatCountdown(900)).toBe('15:00')
})

test('a negative or fractional value never prints a broken clock', () => {
  expect(formatCountdown(-5)).toBe('0s')
  expect(formatCountdown(90.7)).toBe('1:30')
})
