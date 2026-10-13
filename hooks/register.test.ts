import { expect, test } from 'claude-code/testing'

import { adoApproved, contextColor, lastPrUrl, parseAdoPr } from './register'

test('context colour thresholds', () => {
  expect(contextColor(59)).toBe(null)
  expect(contextColor(60)).toBe('#ffb454')
  expect(contextColor(79)).toBe('#ffb454')
  expect(contextColor(80)).toBe('#f44336')
})

test('lastPrUrl picks the newest PR link', () => {
  const text = 'a https://github.com/o/r/pull/1 b https://github.com/o/r/pull/2 c'

  expect(lastPrUrl(text)).toBe('https://github.com/o/r/pull/2')
  expect(lastPrUrl('nothing')).toBe(null)
})

test('parseAdoPr reads org, project, repo, id', () => {
  expect(parseAdoPr('https://dev.azure.com/org/proj/_git/repo/pullrequest/42')).toEqual({
    org: 'org', project: 'proj', repo: 'repo', id: '42',
  })
})

test('adoApproved needs an approval and no rejection', () => {
  expect(adoApproved('active', [10, 0])).toBe(true)
  expect(adoApproved('active', [10, -5])).toBe(false)
  expect(adoApproved('active', [0])).toBe(false)
  expect(adoApproved('completed', [10])).toBe(false)
})
