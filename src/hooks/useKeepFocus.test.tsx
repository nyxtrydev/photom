import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { describe, expect, it } from 'vitest';
import { useKeepFocus } from './useKeepFocus';

function Swapper() {
  const [step, setStep] = useState<'a' | 'b'>('a');
  const box = useRef<HTMLDivElement>(null);
  useKeepFocus(box, step);
  return (
    <div>
      <div ref={box}>
        {step === 'a' ? (
          <button type="button" onClick={() => setStep('b')}>
            First
          </button>
        ) : (
          <button type="button">Second</button>
        )}
      </div>
      <button type="button">Elsewhere</button>
    </div>
  );
}

describe('useKeepFocus', () => {
  it('moves focus to the replacement button when the focused one is swapped out', async () => {
    render(<Swapper />);
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Second' })).toHaveFocus();
  });

  it('does not steal focus the user moved elsewhere on purpose', async () => {
    render(<Swapper />);
    await userEvent.tab();
    await userEvent.tab(); // now on "Elsewhere"
    expect(screen.getByRole('button', { name: 'Elsewhere' })).toHaveFocus();
    // The state changes later (here: via a click that is not inside).
    await userEvent.click(screen.getByRole('button', { name: 'First' }));
    await userEvent.click(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(screen.getByRole('button', { name: 'Elsewhere' })).toHaveFocus();
  });

  it('does nothing when focus was never inside', () => {
    render(<Swapper />);
    act(() => screen.getByRole('button', { name: 'First' }).click());
    expect(screen.getByRole('button', { name: 'Second' })).not.toHaveFocus();
  });
});
