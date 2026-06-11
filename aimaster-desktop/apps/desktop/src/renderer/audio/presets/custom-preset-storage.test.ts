import { describe, it, expect, beforeEach } from 'vitest';
import {
  exportPresetJson, parsePresetJson, importPresetJson, listCustomPresets,
  PRESET_FILE_FORMAT,
} from './custom-preset-storage.js';
import type { AllModulesParameterState } from '../parameters/parameter-state.js';

// Minimal stand-in state (the storage treats it as an opaque object).
const state = { eq: { airDb: 3 }, multiband: { bypass: false } } as unknown as AllModulesParameterState;

// jsdom provides localStorage; clear between tests.
beforeEach(() => { try { localStorage.clear(); } catch { /* ignore */ } });

describe('custom preset sharing (export/import)', () => {
  it('exportPresetJson emits a tagged, versioned, re-parseable file', () => {
    const json = exportPresetJson({ name: '  My KPOP  ', state });
    const obj = JSON.parse(json);
    expect(obj.format).toBe(PRESET_FILE_FORMAT);
    expect(obj.version).toBe(1);
    expect(obj.name).toBe('My KPOP'); // sanitised
    expect(obj.state).toEqual(state);
  });

  it('round-trips export → parse', () => {
    const parsed = parsePresetJson(exportPresetJson({ name: 'Round', state }));
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe('Round');
    expect(parsed!.state).toEqual(state);
  });

  it('parsePresetJson rejects foreign / malformed JSON', () => {
    expect(parsePresetJson('not json')).toBeNull();
    expect(parsePresetJson('{}')).toBeNull();
    expect(parsePresetJson(JSON.stringify({ format: 'other', version: 1, name: 'x', state }))).toBeNull();
    expect(parsePresetJson(JSON.stringify({ format: PRESET_FILE_FORMAT, version: 99, name: 'x', state }))).toBeNull();
    expect(parsePresetJson(JSON.stringify({ format: PRESET_FILE_FORMAT, version: 1, name: 'x' }))).toBeNull(); // no state
  });

  it('importPresetJson saves a fresh entry (new id) into storage', () => {
    expect(listCustomPresets()).toHaveLength(0);
    const saved = importPresetJson(exportPresetJson({ name: 'Imported', state }));
    expect(saved).not.toBeNull();
    expect(saved!.id).toMatch(/^user-/);
    expect(listCustomPresets().map((p) => p.name)).toContain('Imported');
  });

  it('importPresetJson returns null for an invalid file (nothing saved)', () => {
    expect(importPresetJson('garbage')).toBeNull();
    expect(listCustomPresets()).toHaveLength(0);
  });
});
