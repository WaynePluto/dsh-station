/** 测试契约：此处说明本测试锁定的行为和回归边界。 */

import { describe, expect, it } from 'vitest'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import { installedRoute } from '../src/installed.js'
import { ensureRuntimeModel, modelMap } from '../src/runtime-catalog.js'
import { canAddModels, planRevert, planRoute } from '../src/planning.js'
import type { ModelEntry, RouteFacts } from '../src/planning.js'
import type { SourceProvider } from '../src/models-dev.js'

/** 模型目录契约：此处说明 provider、协议、目录覆盖和用户条目保留。 */
function facts(overrides: Partial<RouteFacts> = {}): RouteFacts {
  return {
    route: 'anthropic',
    displayName: 'Anthropic',
    hasConfiguredApi: false,
    shipped: true,
    hasModelsList: false,
    configuredEntries: [],
    ownedIds: [],
    ownedModels: [],
    managed: false,
    installedModels: [
      { id: 'old-1', api: 'anthropic-messages' },
      { id: 'old-2', api: 'anthropic-messages' },
    ],
    installedIds: ['old-1', 'old-2'],
    installedApis: ['anthropic-messages'],
    ...overrides,
  }
}

/** 模型目录契约：此处说明 provider、协议、目录覆盖和用户条目保留。 */
function source(ids: readonly string[] = ['new-1']): SourceProvider {
  return {
    id: 'anthropic',
    models: ids.map(id => ({ id, name: `Name ${id}`, contextWindow: 1000, maxTokens: 100 })),
  }
}

/** 实现说明：此处记录相关接口、边界和生命周期约束。 */
function written(next: readonly ModelEntry[] | null | undefined): readonly string[] | 'removed' | 'untouched' {
  if (next === null) return 'removed'
  if (next === undefined) return 'untouched'
  return next.map(entry => entry.id)
}

describe('adding models', () => {
  it('spells out the installed catalog before appending, so the list does not narrow the route', () => {
    const plan = planRoute(facts(), source())
    expect(written(plan.next)).toEqual(['old-1', 'old-2', 'new-1'])
    expect(plan.nextOwnedIds).toEqual(['new-1'])
    expect(plan.preview.additions.map(model => model.id)).toEqual(['new-1'])
  })

  it('writes the source facts only on the model it adds; catalog models stay bare', () => {
    const entries = planRoute(facts(), source()).next
    expect(entries?.map(entry => Object.keys(entry).toSorted())).toEqual([
      ['id'],
      ['id'],
      ['contextWindow', 'id', 'maxTokens', 'name'],
    ])
  })

  it('offers nothing for a model the installed catalog already ships', () => {
    const plan = planRoute(facts(), source(['old-1']))
    expect(plan.preview.additions).toEqual([])
    expect(written(plan.next)).toBe('untouched')
  })

  it('uses the naming fallback for a mixed native route', () => {
    const route = facts({
      route: 'github-copilot',
      installedModels: [
        { id: 'known-chat', api: 'openai-completions' },
        { id: 'known-response', api: 'openai-responses' },
        { id: 'known-claude', api: 'anthropic-messages' },
      ],
      installedIds: ['known-chat', 'known-response', 'known-claude'],
      installedApis: ['openai-completions', 'openai-responses', 'anthropic-messages'],
    })
    const offered: SourceProvider = {
      id: 'github-copilot',
      models: [
        { id: 'gpt-new', name: 'GPT New' },
        { id: 'claude-new', name: 'Claude New' },
        { id: 'gemini-new', name: 'Gemini New' },
      ],
    }
    expect(canAddModels(route)).toBe(true)
    const plan = planRoute(route, offered)
    expect(plan.preview.blocked).toBeUndefined()
    expect(plan.nextOwnedModels.map(model => [model.id, model.api])).toEqual([
      ['gpt-new', 'openai-responses'],
      ['claude-new', 'anthropic-messages'],
      ['gemini-new', 'openai-completions'],
    ])
  })

  it('makes gpt-6.1-sol visible to the mixed Copilot catalog before writing its settings list', () => {
    const installed = installedRoute('github-copilot')
    expect(installed.apis.length).toBeGreaterThan(1)
    expect(installed.ids).not.toContain('gpt-6.1-sol')
    const route = facts({
      route: 'github-copilot',
      installedModels: installed.models,
      installedIds: installed.ids,
      installedApis: installed.apis,
    })
    const plan = planRoute(route, { id: 'github-copilot', models: [{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol',
      reasoningUnavailable: true, effortValues: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] }] })
    const spec = plan.nextOwnedModels[0]
    expect(spec).toMatchObject({ route: 'github-copilot', id: 'gpt-6.1-sol', api: 'openai-responses' })
    // pi-ai 0.87 起 gpt-6 家族的 minimal 档位不再映射 low，档位表只保留实际 wire 值。
    expect(plan.next?.at(-1)).toMatchObject({ id: 'gpt-6.1-sol', reasoningEfforts: {
      low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max',
    } })
    expect(plan.preview.additions[0]?.reasoningUnavailable).toBe(false)
    if (spec === undefined) throw new Error('missing runtime model spec')
    try {
      expect(ensureRuntimeModel(spec)).toBe(true)
      expect(getBuiltinModels('github-copilot').find(model => model.id === spec.id)?.api).toBe(spec.api)
      expect(installedRoute('github-copilot').ids).not.toContain(spec.id)
    } finally {
      delete modelMap('github-copilot')?.[spec.id]
    }
  })

  it('uses the nearest Copilot family for new Grok, Claude and Luna models', () => {
    const installed = installedRoute('github-copilot')
    const route = facts({ route: 'github-copilot', installedModels: installed.models,
      installedIds: installed.ids, installedApis: installed.apis })
    const plan = planRoute(route, { id: 'github-copilot', models: [
      { id: 'grok-4.8', name: 'Grok 4.8', reasoningUnavailable: true, effortValues: ['low', 'medium', 'high', 'xhigh'] },
      { id: 'claude-opus-5.6', name: 'Claude Opus 5.6', reasoningUnavailable: true, effortValues: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { id: 'gpt-6.1-luna', name: 'GPT-6.1 Luna', reasoningUnavailable: true, effortValues: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] },
    ] })
    expect(plan.nextOwnedModels.map(spec => [spec.id, spec.api])).toEqual([
      ['grok-4.8', 'openai-responses'], ['claude-opus-5.6', 'anthropic-messages'], ['gpt-6.1-luna', 'openai-responses'],
    ])
    expect(plan.next?.find(entry => entry.id === 'grok-4.8')?.['reasoningEfforts']).toEqual({
      low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh',
    })
    expect(plan.next?.find(entry => entry.id === 'claude-opus-5.6')?.['reasoningEfforts']).toEqual({
      low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max',
    })
  })

  it('never borrows another provider’s thinking map or invents levels without source effort evidence', () => {
    const route = facts({ route: 'github-copilot', installedModels: installedRoute('github-copilot').models,
      installedIds: installedRoute('github-copilot').ids, installedApis: installedRoute('github-copilot').apis })
    const plan = planRoute(route, { id: 'github-copilot', models: [
      { id: 'gpt-6-unknown', name: 'GPT Unknown', reasoningUnavailable: true, effortValues: ['low'] },
      { id: 'gpt-6.1-sol', name: 'GPT Sol', reasoningUnavailable: true },
    ] })
    expect(plan.preview.additions.every(model => model.reasoningUnavailable)).toBe(true)
    expect(plan.next?.filter(entry => entry.id.startsWith('gpt-6-')).every(entry => entry['reasoningEfforts'] === undefined)).toBe(true)
  })

  it('explicitly upgrades a prior owned entry without discarding user fields or overrides', () => {
    const installed = installedRoute('github-copilot')
    const route = facts({ route: 'github-copilot', installedModels: installed.models, installedIds: installed.ids,
      installedApis: installed.apis, hasModelsList: true, managed: true, ownedIds: ['grok-4.8', 'gpt-6.1-sol'],
      ownedModels: [
        { id: 'grok-4.8', name: 'Grok 4.8', api: 'openai-completions', route: 'github-copilot' },
        { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', api: 'openai-responses', route: 'github-copilot' },
      ],
      configuredEntries: [
        { id: 'grok-4.8', custom: 'mine' },
        { id: 'user-only', custom: 'must stay between owned entries' },
        { id: 'gpt-6.1-sol', reasoningEfforts: { high: 'custom-wire' }, custom: true },
      ],
    })
    const sourceModels: SourceProvider = { id: 'github-copilot', models: [
      { id: 'grok-4.8', name: 'Grok 4.8', reasoningUnavailable: true, effortValues: ['low', 'medium', 'high', 'xhigh'] },
      { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', reasoningUnavailable: true, effortValues: ['low', 'medium', 'high'] },
    ] }
    expect(planRoute(route, undefined).next).toBeUndefined()
    const plan = planRoute(route, sourceModels)
    expect(plan.preview.upgradableIds).toEqual(['grok-4.8'])
    expect(plan.nextOwnedModels.map(model => [model.id, model.api])).toEqual([
      ['grok-4.8', 'openai-responses'], ['gpt-6.1-sol', 'openai-responses'],
    ])
    expect(plan.next?.map(entry => entry.id)).toEqual(['grok-4.8', 'user-only', 'gpt-6.1-sol'])
    expect(plan.next?.find(entry => entry.id === 'grok-4.8')).toEqual({
      id: 'grok-4.8', custom: 'mine', reasoningEfforts: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' },
    })
    expect(plan.next?.find(entry => entry.id === 'gpt-6.1-sol')).toEqual({
      id: 'gpt-6.1-sol', reasoningEfforts: { high: 'custom-wire' }, custom: true,
    })
  })

  it('allows a multi-protocol route that names its own api', () => {
    const route = facts({ installedApis: ['a', 'b'], hasConfiguredApi: true })
    expect(canAddModels(route)).toBe(true)
    expect(planRoute(route, source()).preview.blocked).toBeUndefined()
  })

  it('appends to a foreign list without rewriting its existing entries', () => {
    const route = facts({ hasModelsList: true, configuredEntries: [{ id: 'old-1', custom: true }], managed: false })
    const plan = planRoute(route, source())
    expect(plan.preview.blocked).toBeUndefined()
    expect(plan.next).toEqual([
      { id: 'old-1', custom: true },
      { id: 'new-1', name: 'Name new-1', contextWindow: 1000, maxTokens: 100 },
    ])
    expect(plan.nextOwnedIds).toEqual(['new-1'])
  })

  it('reports a route the source does not describe', () => {
    expect(planRoute(facts(), undefined).preview.blocked).toBe('no-source')
  })
})

describe('handing models back to dsh', () => {
  /** 模型目录契约：此处说明 provider、协议、目录覆盖和用户条目保留。 */
  function managed(installedIds: readonly string[]): RouteFacts {
    return facts({
      hasModelsList: true,
      managed: true,
      ownedIds: ['new-1', 'new-2'],
      configuredEntries: [
        { id: 'old-1' },
        { id: 'old-2' },
        { id: 'new-1', name: 'guessed', contextWindow: 1000 },
        { id: 'new-2', name: 'guessed', contextWindow: 1000 },
      ],
      installedIds,
    })
  }

  it('strips our fields from a model dsh now ships, and stops owning it', () => {
    const plan = planRoute(managed(['old-1', 'old-2', 'new-1']), undefined)
    expect(plan.preview.reclaimed).toEqual(['new-1'])
    expect(plan.nextOwnedIds).toEqual(['new-2'])
    expect(plan.next?.find(entry => entry.id === 'new-1')).toEqual({ id: 'new-1' })
    expect(plan.next?.find(entry => entry.id === 'new-2')).toMatchObject({ name: 'guessed' })
  })

  it('removes the whole list once dsh ships everything we had added', () => {
    const plan = planRoute(managed(['old-1', 'old-2', 'new-1', 'new-2']), undefined)
    expect(plan.preview.reclaimed).toEqual(['new-1', 'new-2'])
    expect(written(plan.next)).toBe('removed')
    expect(plan.nextOwnedIds).toEqual([])
  })

  it('does not resurrect a model a person deleted from our list', () => {
    const route = managed(['old-1', 'old-2'])
    const trimmed: RouteFacts = {
      ...route,
      configuredEntries: route.configuredEntries.filter(entry => entry.id !== 'new-2'),
    }
    const plan = planRoute(trimmed, source(['new-2']))
    expect(plan.preview.ownedIds).toEqual(['new-1'])
    expect(plan.preview.additions.map(model => model.id)).toEqual(['new-2'])
  })

  it('keeps a hand-declared route serving something, since removing its list would leave none', () => {
    const route = facts({
      installedIds: [],
      installedApis: [],
      hasConfiguredApi: true,
      hasModelsList: true,
      managed: true,
      ownedIds: ['new-1'],
      configuredEntries: [{ id: 'new-1' }],
    })
    expect(written(planRevert(route).next)).toEqual([])
    expect(written(planRoute(route, undefined).next)).toBe('untouched')
  })
})

describe('reverting', () => {
  it('removes the key when the rest of the list is exactly the installed catalog', () => {
    const route = facts({
      hasModelsList: true,
      managed: true,
      ownedIds: ['new-1'],
      configuredEntries: [{ id: 'old-1' }, { id: 'old-2' }, { id: 'new-1' }],
    })
    expect(written(planRevert(route).next)).toBe('removed')
  })

  it('keeps a narrowed list a person had left behind, minus our own rows', () => {
    const route = facts({
      hasModelsList: true,
      managed: true,
      ownedIds: ['new-1'],
      configuredEntries: [{ id: 'old-1' }, { id: 'new-1' }],
    })
    expect(written(planRevert(route).next)).toEqual(['old-1'])
  })

  it('does nothing on a route this plugin never wrote', () => {
    expect(written(planRevert(facts()).next)).toBe('untouched')
  })
})
