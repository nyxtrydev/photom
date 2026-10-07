import { describe, expect, it } from 'vitest';
import { formatBytes, formatEta, formatSpeed } from './format';

describe('format', () => {
  it('formats sizes in decimal units', () => {
    expect(formatBytes(0)).toBe('0 MB');
    expect(formatBytes(500)).toBe('1 KB');
    expect(formatBytes(65_000_000)).toBe('65 MB');
    expect(formatBytes(6_200_000)).toBe('6.2 MB');
    expect(formatBytes(1_500_000_000)).toBe('1.5 GB');
    expect(formatSpeed(6_200_000)).toBe('6.2 MB/s');
  });
  it('formats durations', () => {
    expect(formatEta(0.2)).toBe('1 s');
    expect(formatEta(16)).toBe('16 s');
    expect(formatEta(300)).toBe('5 min');
    expect(formatEta(7200)).toBe('2 h');
  });
});
