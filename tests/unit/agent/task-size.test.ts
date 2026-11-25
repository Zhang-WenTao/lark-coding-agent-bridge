import { describe, expect, it } from 'vitest';
import {
  commandSize,
  costToSize,
  isSubagentTool,
  preRunSize,
  SizeTracker,
  sizeOfWork,
} from '../../../src/agent/claude/task-size.js';

describe('the size a run starts on', () => {
  it('reads the rating’s estimate of the work first', () => {
    expect(preRunSize({ scale: { subagents: 6 } }).size).toBe('XL');
    expect(preRunSize({ scale: { subagents: 3, long: true } }).size).toBe('XL');
    expect(preRunSize({ scale: { subagents: 2 } }).size).toBe('L');
    expect(preRunSize({ scale: { background: true } }).size).toBe('L');
    expect(preRunSize({ scale: { long: true } }).size).toBe('L');
    expect(preRunSize({ scale: { subagents: 0 } }).size).toBe('S');
  });

  it('takes effort only as a weak prior: xhigh and max are M at most', () => {
    expect(preRunSize({ effort: 'max' })).toMatchObject({ size: 'M', why: ['effort:max'] });
    expect(preRunSize({ effort: 'xhigh' }).size).toBe('M');
    expect(preRunSize({ effort: 'high' }).size).toBe('S');
    expect(preRunSize({ effort: 'medium' })).toEqual({ size: 'S', why: [] });
    // A high run that fans out is big however hard it is to think about.
    expect(preRunSize({ effort: 'high', scale: { subagents: 6 } }).size).toBe('XL');
  });

  it('knows the commands that start big work, plugin names included', () => {
    expect(preRunSize({ text: '/jira-dev ANTELOPE-1' }).size).toBe('L');
    expect(preRunSize({ text: '看一下\n/antelope:pr-deep-review 5943' })).toMatchObject({
      size: 'XL',
      why: ['command:/antelope:pr-deep-review'],
    });
    expect(preRunSize({ text: 'see /jira-dev' }).size).toBe('S');
    expect(commandSize('/my-job run', { '/my-job': 'XL' })).toEqual({ name: '/my-job', size: 'XL' });
    expect(commandSize('/jira-dev x', { '/jira-dev': 'S' })?.size).toBe('S');
  });

  it('marks a short follow-up so the conversation’s last size counts', () => {
    expect(preRunSize({ continuation: true })).toEqual({ size: 'S', why: [], continuation: true });
  });
});

describe('sizes by work and cost', () => {
  it('reads the size off the work done', () => {
    const none = { tools: 0, subagents: 0, background: 0, ledger: false };
    expect(sizeOfWork(none)).toBe('S');
    expect(sizeOfWork({ ...none, tools: 10 })).toBe('M');
    expect(sizeOfWork({ ...none, tools: 50 })).toBe('L');
    expect(sizeOfWork({ ...none, tools: 150 })).toBe('XL');
    expect(sizeOfWork({ ...none, subagents: 1 })).toBe('L');
    expect(sizeOfWork({ ...none, subagents: 6 })).toBe('XL');
    expect(sizeOfWork({ ...none, background: 1 })).toBe('L');
    expect(sizeOfWork({ ...none, ledger: true })).toBe('L');
  });

  it('maps a cost to its size', () => {
    expect(costToSize(0.4)).toBe('S');
    expect(costToSize(1.5)).toBe('M');
    expect(costToSize(4)).toBe('L');
    expect(costToSize(19)).toBe('XL');
  });

  it('knows the subagent tools', () => {
    expect(isSubagentTool('Agent')).toBe(true);
    expect(isSubagentTool('Task')).toBe(true);
    expect(isSubagentTool('Bash')).toBe(false);
  });
});

describe('SizeTracker', () => {
  it('grows with tool calls and subagents, saying when', () => {
    const t = new SizeTracker('S');
    for (let i = 0; i < 9; i++) expect(t.onToolUse('Bash')).toBeUndefined();
    expect(t.onToolUse('Read')).toBe('M');
    expect(t.onToolUse('Agent')).toBe('L');
    for (let i = 0; i < 4; i++) t.onToolUse('Agent');
    expect(t.onToolUse('Task')).toBe('XL');
    expect(t.done).toMatchObject({ tools: 16, subagents: 6 });
  });

  it('never shrinks below where it started', () => {
    const t = new SizeTracker('L');
    expect(t.onToolUse('Bash')).toBeUndefined();
    expect(t.current).toBe('L');
  });

  it('counts background tasks and a task ledger, even split across deltas or deep in a reply', () => {
    expect(new SizeTracker('S').onBackground(1)).toBe('L');
    const split = new SizeTracker('S');
    expect(split.onText('好的，📒 任务')).toBeUndefined();
    expect(split.onText('台账：/Users/x/docs/progress/a.md')).toBe('L');
    const whole = new SizeTracker('S');
    expect(whole.onText(`📒 任务台账：/tmp/a.md\n${'正文'.repeat(200)}`)).toBe('L');
    // Talking about a ledger is not keeping one.
    expect(new SizeTracker('S').onText('任务台账在哪里？')).toBeUndefined();
  });

  it('moves up a size once the cost reaches 80% of the reserve, and tops an XL reserve up', () => {
    const t = new SizeTracker('S');
    expect(t.onCost(0.5)).toBeUndefined();
    expect(t.onCost(0.4)).toBe('M');
    expect(t.reserveUsd()).toBe(3);
    // One big turn can skip a size.
    expect(t.onCost(30)).toBe('XL');
    expect(t.reserveUsd()).toBe(43);
    t.onCost(20);
    expect(t.spent).toBeCloseTo(50.9);
    expect(t.reserveUsd()).toBeCloseTo(50.9 / 0.8);
  });

  it('uses the reserves it is given', () => {
    const t = new SizeTracker('S', (size) => ({ S: 2, M: 5, L: 10, XL: 50 })[size]);
    expect(t.onCost(1.5)).toBeUndefined();
    expect(t.onCost(0.1)).toBe('M');
  });
});
