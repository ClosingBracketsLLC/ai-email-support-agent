import { inferMime } from './upload'

test.each([
  ['guide.pdf', 'application/pdf'],
  ['policy.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['notes.md', 'text/markdown'],
  ['readme.txt', 'text/plain'],
])('infers %s as %s when the declared MIME is empty', (name, expected) => {
  expect(inferMime(name, '')).toBe(expected)
})

test('an unrecognized extension keeps whatever was declared, even if empty', () => {
  expect(inferMime('archive.zip', '')).toBe('')
  expect(inferMime('archive.zip', 'application/zip')).toBe('application/zip')
})

test('a non-empty declared MIME always wins, regardless of extension', () => {
  expect(inferMime('guide.pdf', 'application/octet-stream')).toBe('application/octet-stream')
})

test('a name with no extension at all falls back to whatever was declared', () => {
  expect(inferMime('README', '')).toBe('')
  expect(inferMime('README', 'text/plain')).toBe('text/plain')
})
